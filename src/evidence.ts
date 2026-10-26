import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { selectContext, type ContextHit, type ContextIndexes, type ContextQuery, type ContextSelection } from './context.ts';
import { verifiedRead } from './graph.ts';
import { sha256 } from './snapshot.ts';

/** CI-05B: bounded, read-only source excerpts for already indexed hits. Not a public wire contract. */
export type EvidenceLimits = {
  maxLines?: number;
  maxChars?: number;
  maxSourceFiles?: number;
  maxSourceBytes?: number;
  maxPackBytes?: number;
};
export type EvidenceStatus = 'indexed' | 'unknown' | 'not-checked';
export type EvidenceReason = 'no-location' | 'missing-source' | 'read-budget' | 'source-unavailable' | 'invalid-location' | null;
export type EvidenceExcerpt = {
  sourcePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  text: string;
  truncated: boolean;
};
export type EvidenceRecord = {
  hit: ContextHit;
  status: EvidenceStatus;
  verification: 'sha256-verified' | 'failed' | 'not-checked';
  reason: EvidenceReason;
  expectedSha256: string | null;
  excerpt: EvidenceExcerpt | null;
};
export type EvidencePack = {
  sensitivity: 'private';
  coverage: 'included-indexes-only';
  status: ContextSelection['status'];
  query: ContextSelection['query'];
  sources: ContextSelection['sources'];
  records: EvidenceRecord[];
  truncated: boolean;
};

type CompleteLimits = Required<EvidenceLimits>;
const DEFAULTS: CompleteLimits = {
  maxLines: 5,
  maxChars: 640,
  maxSourceFiles: 8,
  maxSourceBytes: 16 * 1024 * 1024,
  maxPackBytes: 32_768,
};

function limitsFor(raw: EvidenceLimits): CompleteLimits {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid evidence limits');
  const limits = { ...DEFAULTS, ...raw };
  const ranges: Record<keyof EvidenceLimits, [number, number]> = {
    maxLines: [1, 12], maxChars: [80, 2048], maxSourceFiles: [1, 20],
    maxSourceBytes: [1, 32 * 1024 * 1024], maxPackBytes: [2048, 65_536],
  };
  for (const [key, [min, max]] of Object.entries(ranges) as [keyof EvidenceLimits, [number, number]][]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max) {
      throw new Error(`Invalid evidence limit: ${key}`);
    }
  }
  return limits;
}

/** Source coordinates are 1-based UTF-16 columns (as in the TypeScript AST). */
function excerptAt(source: string, path: string, line: number, column: number, limits: CompleteLimits): EvidenceExcerpt | null {
  const lines = source.split(/\r\n|\r|\n/);
  if (line < 1 || line > lines.length || column < 1 || column > lines[line - 1]!.length + 1) return null;
  const anchor = lines[line - 1]!;
  if (anchor.length > limits.maxChars) {
    // Keep the indexed position visible rather than blindly returning the first part of a long line.
    let start = Math.max(0, Math.min(column - 1 - Math.floor(limits.maxChars / 3), anchor.length - limits.maxChars));
    let end = start + limits.maxChars;
    if (start > 0 && /[\uDC00-\uDFFF]/.test(anchor[start]!)) start++;
    if (end < anchor.length && /[\uD800-\uDBFF]/.test(anchor[end - 1]!)) end--;
    return { sourcePath: path, startLine: line, endLine: line, startColumn: start + 1,
      text: anchor.slice(start, end), truncated: true };
  }
  let start = line - 1;
  let end = line - 1;
  let total = anchor.length;
  // Prefer the nearest previous and following lines, without dropping the cited line.
  while (end - start + 1 < limits.maxLines) {
    let added = false;
    if (start > 0 && total + 1 + lines[start - 1]!.length <= limits.maxChars) {
      total += 1 + lines[--start]!.length;
      added = true;
    }
    if (end - start + 1 < limits.maxLines && end + 1 < lines.length &&
      total + 1 + lines[end + 1]!.length <= limits.maxChars) {
      total += 1 + lines[++end]!.length;
      added = true;
    }
    if (!added) break;
  }
  return { sourcePath: path, startLine: start + 1, endLine: end + 1, startColumn: 1,
    text: lines.slice(start, end + 1).join('\n'), truncated: start > 0 || end < lines.length - 1 };
}

const byteSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Validates all four indexes before accessing source. Only the hit's indexed sourcePath is read,
 * using the CI-02 symlink-safe, SHA-256-checked reader. Failed reads never return source bytes.
 * No scripts, build tools, LLMs or network activity are invoked.
 */
export async function buildEvidencePack(
  rootArg: string, indexes: ContextIndexes, query: ContextQuery, rawLimits: EvidenceLimits = {},
): Promise<EvidencePack> {
  const limits = limitsFor(rawLimits);
  const selection = selectContext(indexes, query);
  const root = await realpath(resolve(rootArg));
  if (!(await stat(root)).isDirectory()) throw new Error('Source root is not a directory');
  const inventory = new Map(indexes.snapshot.files.map(f => [f.path, f]));
  const cache = new Map<string, string | null>();
  let bytesRead = 0;
  const pack: EvidencePack = {
    sensitivity: 'private', coverage: 'included-indexes-only', status: selection.status,
    query: selection.query, sources: selection.sources, records: [], truncated: selection.truncated,
  };
  if (byteSize(pack) > limits.maxPackBytes) throw new Error('Evidence byte limit too small for metadata');
  for (const hit of selection.hits) {
    const path = hit.evidence.sourcePath;
    const source = inventory.get(path);
    const record: EvidenceRecord = {
      hit, status: 'not-checked', verification: 'not-checked', reason: 'no-location',
      expectedSha256: source?.sha256 ?? null, excerpt: null,
    };
    if (hit.evidence.line === null || hit.evidence.column === null) {
      // File and route identities are indexed, but without coordinates no excerpt is justified.
    } else if (!source) {
      record.status = 'unknown'; record.reason = 'missing-source';
    } else if (!cache.has(path) && (cache.size >= limits.maxSourceFiles || bytesRead + source.sizeBytes > limits.maxSourceBytes)) {
      record.reason = 'read-budget';
    } else {
      if (!cache.has(path)) {
        bytesRead += source.sizeBytes;
        try {
          const contents = await verifiedRead(root, path, source.sha256, source.sizeBytes);
          // An invalid UTF-8 sequence would be replaced during decoding; never cite lossy text.
          cache.set(path, sha256(contents) === source.sha256 ? contents : null);
        } catch { cache.set(path, null); }
      }
      const content = cache.get(path);
      if (content === null || content === undefined) {
        record.status = 'unknown'; record.verification = 'failed'; record.reason = 'source-unavailable';
      } else {
        const excerpt = excerptAt(content, path, hit.evidence.line, hit.evidence.column, limits);
        record.verification = 'sha256-verified';
        if (excerpt) { record.status = 'indexed'; record.reason = null; record.excerpt = excerpt; }
        else { record.status = 'unknown'; record.reason = 'invalid-location'; }
      }
    }
    pack.records.push(record);
    if (byteSize(pack) > limits.maxPackBytes) {
      pack.records.pop();
      pack.truncated = true;
      break;
    }
  }
  return pack;
}
