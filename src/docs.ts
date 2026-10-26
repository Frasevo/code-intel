import { realpath } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { buildApiCatalog, type ApiCatalog } from './api-registry.ts';
import { buildGraph, verifiedRead, type Graph } from './graph.ts';
import { normalizedRelativePath, permittedPath } from './policy.ts';
import { scanRepository } from './scanner.ts';
import { isSha256, sha256, VERSION } from './snapshot.ts';

export const DOCS_SCHEMA = 'doc-trace/v1';
const MAX_DOCUMENTS = 20_000;
const MAX_REFERENCES = 200_000;
const MAX_HEADINGS = 100_000;
const DOC_FILE = /\.mdx?$/i;
const ID = /^sha256:[a-f0-9]{64}$/;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export type DocHeading = { slug: string; line: number };
export type DocReference = {
  from: string; line: number; column: number;
  syntax: 'inline-link' | 'reference-link';
  kind: 'file' | 'api' | 'external' | 'unknown';
  target: string | null; fragment: string | null;
  status: 'resolved' | 'unknown' | 'external';
};
export type DocTrace = {
  schemaVersion: 'doc-trace/v1'; producerVersion: string; artifactId: string;
  repoId: string; capturedAt: string; sensitivity: 'private';
  sources: { snapshotArtifactId: string; graphArtifactId: string; apiArtifactId: string;
    includedFilesHash: string; commitSha: string | null; dirty: boolean | null };
  coverage: { syntax: 'markdown-links-and-reference-links'; execution: 'not-performed';
    anchoring: 'markdown-headings-only'; source: 'included-files-only' };
  documents: Array<{ path: string; sha256: string; headings: DocHeading[] }>;
  references: DocReference[];
  stats: { documents: number; headings: number; references: number; resolved: number; unknown: number; external: number };
};

function slugify(heading: string): string {
  return heading.trim().toLowerCase().replace(/<[^>]*>/g, '')
    .replace(/&[a-z0-9#]+;/gi, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .replace(/\s+/g, '-').slice(0, 128);
}

// Strip inline code (including multi-backtick delimiters), retaining column offsets.
function maskInlineCode(line: string): string {
  let output = ''; let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') { output += line[i]; i++; continue; }
    let end = i; while (line[end] === '`') end++;
    const ticks = line.slice(i, end);
    const close = line.indexOf(ticks, end);
    if (close < 0) { output += line.slice(i, end); i = end; continue; }
    output += ' '.repeat(close + ticks.length - i); i = close + ticks.length;
  }
  return output;
}

function linesWithoutFences(source: string): string[] {
  let fence: { char: string; length: number } | null = null;
  return source.split(/\r?\n/).map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match) {
      const current = match[1]!;
      if (!fence) fence = { char: current[0]!, length: current.length };
      else if (fence.char === current[0] && current.length >= fence.length &&
        line.slice(match[0].length).trim() === '') fence = null;
      return '';
    }
    return fence ? '' : maskInlineCode(line);
  });
}

type Link = { href: string; syntax: DocReference['syntax']; line: number; column: number };
type ParsedDoc = { headings: DocHeading[]; links: Link[] };

function parseMarkdown(content: string): ParsedDoc {
  const lines = linesWithoutFences(content);
  const headings: DocHeading[] = [];
  const duplicates = new Map<string, number>();
  const definitions = new Map<string, string>();
  const definitionLines = new Set<number>();
  for (const [i, line] of lines.entries()) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const name = slugify(heading[1]!);
      if (name) {
        if (headings.length >= MAX_HEADINGS) throw new Error('Too many headings in document');
        const n = duplicates.get(name) ?? 0;
        duplicates.set(name, n + 1);
        headings.push({ slug: n ? `${name}-${n}` : name, line: i + 1 });
      }
    }
    const def = /^ {0,3}\[([^\]]{1,256})\]:\s*(?:<([^>]+)>|(\S+))/.exec(line);
    if (def) {
      const key = def[1]!.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!definitions.has(key)) definitions.set(key, def[2] ?? def[3]!);
      definitionLines.add(i);
    }
  }
  const links: Link[] = [];
  for (const [i, line] of lines.entries()) {
    if (definitionLines.has(i)) continue;
    // Image references are deliberately excluded. Definitions are metadata, not evidence of usage.
    const re = /(?<!!)\[([^\]\n]{1,256})\](?:\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+['"][^'"\n]*['"])?\s*\)|\[([^\]\n]{0,256})\])/g;
    for (const match of line.matchAll(re)) {
      const inline = match[2] !== undefined || match[3] !== undefined;
      const key = (match[4] || match[1]!).trim().replace(/\s+/g, ' ').toLowerCase();
      const href = inline ? match[2] ?? match[3]! : definitions.get(key);
      if (href !== undefined) links.push({ href, syntax: inline ? 'inline-link' : 'reference-link', line: i + 1, column: match.index! + 1 });
    }
  }
  return { headings, links };
}

function reference(from: string, link: Link, inventory: Set<string>, docs: Map<string, Set<string>>, api: Set<string>): DocReference {
  const base: DocReference = { from, line: link.line, column: link.column,
    syntax: link.syntax, kind: 'unknown', target: null, fragment: null, status: 'unknown' };
  // Do not persist external URLs, query strings, userinfo, or secrets embedded in links.
  const href = link.href.trim();
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return { ...base, kind: 'external', status: 'external' };
  const hashIndex = href.indexOf('#');
  const preFragment = hashIndex < 0 ? href : href.slice(0, hashIndex);
  const rawFragment = hashIndex < 0 ? null : href.slice(hashIndex + 1);
  const rawPath = preFragment.split('?')[0]!;
  if (rawPath.length > 2048 || (rawFragment !== null && rawFragment.length > 128) || /%(?:2f|5c)/i.test(rawPath)) return base;
  let path: string, fragment: string | null;
  try {
    path = decodeURIComponent(rawPath);
    fragment = rawFragment === null ? null : decodeURIComponent(rawFragment);
  } catch { return base; }
  if (fragment !== null && (!fragment || fragment.length > 128 || /[\x00-\x1f]/.test(fragment))) return base;
  if (path.startsWith('/api/')) {
    const target = path.replace(/\/$/, '');
    return { ...base, kind: 'api', target, fragment, status: api.has(target) && fragment === null ? 'resolved' : 'unknown' };
  }
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return base;
  const resolved = path === '' ? from : posix.normalize(posix.join(posix.dirname(from), path));
  if (!normalizedRelativePath(resolved) || !permittedPath(resolved)) return base;
  const candidates = [resolved];
  // Conventional links to a doc directory, kept within the scanned inventory only.
  if (path.endsWith('/')) candidates.push(`${resolved}/README.md`, `${resolved}/index.md`);
  const target = candidates.find(candidate => inventory.has(candidate)) ?? resolved;
  const known = inventory.has(target);
  const hasAnchor = fragment === null || (docs.get(target)?.has(fragment) ?? false);
  return { ...base, kind: 'file', target, fragment, status: known && hasAnchor ? 'resolved' : 'unknown' };
}

function digest(value: Omit<DocTrace, 'artifactId' | 'capturedAt'>): string {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

export async function buildDocTrace(rootArg: string, repoId?: string): Promise<DocTrace> {
  const root = await realpath(resolve(rootArg));
  const graph: Graph = await buildGraph(root, repoId);
  const api: ApiCatalog = await buildApiCatalog(root, repoId);
  const snapshot = await scanRepository(root, repoId);
  if (graph.repoId !== snapshot.repoId || api.repoId !== snapshot.repoId ||
    graph.sourceSnapshot.artifactId !== snapshot.artifactId ||
    api.sourceGraph.snapshotArtifactId !== snapshot.artifactId ||
    graph.artifactId !== api.sourceGraph.artifactId ||
    graph.sourceSnapshot.includedFilesHash !== snapshot.provenance.includedFilesHash ||
    api.sourceGraph.includedFilesHash !== snapshot.provenance.includedFilesHash) {
    throw new Error('Source changed while generating documentation trace');
  }
  const selected = snapshot.files.filter(f => DOC_FILE.test(f.path));
  if (selected.length > MAX_DOCUMENTS) throw new Error('Too many documentation files');
  const parsed = new Map<string, ParsedDoc>();
  let count = 0;
  for (const file of selected) {
    const md = parseMarkdown(await verifiedRead(root, file.path, file.sha256, file.sizeBytes));
    count += md.headings.length;
    if (count > MAX_HEADINGS) throw new Error('Too many documentation headings');
    parsed.set(file.path, md);
  }
  const docs = new Map([...parsed].map(([path, doc]) => [path, new Set(doc.headings.map(h => h.slug))]));
  const inventory = new Set(snapshot.files.map(file => file.path));
  const apiPaths = new Set(api.routes.map(route => route.path));
  const documents = selected.map(f => ({ path: f.path, sha256: f.sha256, headings: parsed.get(f.path)!.headings }));
  const references: DocReference[] = [];
  for (const file of selected) {
    for (const link of parsed.get(file.path)!.links) {
      if (references.length >= MAX_REFERENCES) throw new Error('Too many documentation references');
      references.push(reference(file.path, link, inventory, docs, apiPaths));
    }
  }
  references.sort((a, b) => compare(a.from, b.from) || a.line - b.line || a.column - b.column);
  const base: Omit<DocTrace, 'artifactId' | 'capturedAt'> = {
    schemaVersion: DOCS_SCHEMA, producerVersion: VERSION, repoId: snapshot.repoId, sensitivity: 'private',
    sources: { snapshotArtifactId: snapshot.artifactId, graphArtifactId: graph.artifactId,
      apiArtifactId: api.artifactId, includedFilesHash: snapshot.provenance.includedFilesHash,
      commitSha: snapshot.provenance.commitSha, dirty: snapshot.provenance.dirty },
    coverage: { syntax: 'markdown-links-and-reference-links', execution: 'not-performed',
      anchoring: 'markdown-headings-only', source: 'included-files-only' },
    documents, references,
    stats: { documents: documents.length, headings: count, references: references.length,
      resolved: references.filter(r => r.status === 'resolved').length,
      unknown: references.filter(r => r.status === 'unknown').length,
      external: references.filter(r => r.status === 'external').length },
  };
  return { ...base, artifactId: digest(base), capturedAt: new Date().toISOString() };
}

export function validateDocTrace(value: unknown): DocTrace {
  if (!record(value) || value.schemaVersion !== DOCS_SCHEMA) throw new Error('Unsupported documentation schemaVersion');
  const d = value as DocTrace;
  if (typeof d.producerVersion !== 'string' || !d.producerVersion ||
    typeof d.repoId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(d.repoId) ||
    d.sensitivity !== 'private' || typeof d.capturedAt !== 'string' || !Number.isFinite(Date.parse(d.capturedAt)) ||
    !record(d.sources) || !ID.test(d.sources.snapshotArtifactId) || !ID.test(d.sources.graphArtifactId) ||
    !ID.test(d.sources.apiArtifactId) || !isSha256(d.sources.includedFilesHash) ||
    !(d.sources.commitSha === null || typeof d.sources.commitSha === 'string' && /^[a-f0-9]{40}$/.test(d.sources.commitSha)) ||
    !(d.sources.dirty === null || typeof d.sources.dirty === 'boolean') ||
    !record(d.coverage) || d.coverage.syntax !== 'markdown-links-and-reference-links' ||
    d.coverage.execution !== 'not-performed' || d.coverage.anchoring !== 'markdown-headings-only' ||
    d.coverage.source !== 'included-files-only') throw new Error('Invalid documentation metadata');
  if (!Array.isArray(d.documents) || d.documents.length > MAX_DOCUMENTS ||
    !Array.isArray(d.references) || d.references.length > MAX_REFERENCES) throw new Error('Invalid documentation size');
  const paths = new Set<string>(); const headings = new Map<string, Set<string>>();
  let headingCount = 0;
  for (const doc of d.documents) {
    if (!record(doc) || typeof doc.path !== 'string' || !permittedPath(doc.path) || !DOC_FILE.test(doc.path) ||
      !isSha256(doc.sha256) || paths.has(doc.path) || !Array.isArray(doc.headings)) throw new Error('Invalid document');
    paths.add(doc.path);
    const slugs = new Set<string>();
    for (const heading of doc.headings) {
      if (!record(heading) || typeof heading.slug !== 'string' || !heading.slug || heading.slug.length > 140 ||
        slugs.has(heading.slug) || !Number.isSafeInteger(heading.line) || heading.line < 1) throw new Error('Invalid heading');
      slugs.add(heading.slug); headingCount++;
      if (headingCount > MAX_HEADINGS) throw new Error('Too many headings');
    }
    headings.set(doc.path, slugs);
  }
  let resolved = 0, unknown = 0, external = 0;
  let previous = '';
  for (const r of d.references) {
    if (!record(r) || typeof r.from !== 'string' || !paths.has(r.from) ||
      !Number.isSafeInteger(r.line) || r.line < 1 || !Number.isSafeInteger(r.column) || r.column < 1 ||
      !['inline-link', 'reference-link'].includes(r.syntax) ||
      !['file', 'api', 'external', 'unknown'].includes(r.kind) ||
      !['resolved', 'unknown', 'external'].includes(r.status) ||
      !(r.target === null || typeof r.target === 'string' && r.target.length < 2049) ||
      !(r.fragment === null || typeof r.fragment === 'string' && r.fragment.length > 0 && r.fragment.length <= 128)) throw new Error('Invalid document reference');
    if (r.kind === 'external' && (r.status !== 'external' || r.target !== null || r.fragment !== null) ||
      r.kind === 'unknown' && (r.status !== 'unknown' || r.target !== null || r.fragment !== null) ||
      r.kind === 'file' && (r.target === null || !permittedPath(r.target) || r.status === 'external') ||
      r.kind === 'api' && (r.target === null || !r.target.startsWith('/api/') || r.status === 'external')) throw new Error('Inconsistent document reference');
    if (r.kind === 'file' && r.status === 'resolved' && r.fragment !== null && !headings.get(r.target!)?.has(r.fragment)) {
      throw new Error('Resolved document anchor is not indexed');
    }
    const current = `${r.from}\0${String(r.line).padStart(12, '0')}\0${String(r.column).padStart(12, '0')}`;
    if (previous && compare(current, previous) < 0) throw new Error('Unsorted documentation references');
    previous = current;
    if (r.status === 'resolved') resolved++;
    if (r.status === 'unknown') unknown++;
    if (r.status === 'external') external++;
  }
  if (!record(d.stats) || d.stats.documents !== paths.size || d.stats.headings !== headingCount ||
    d.stats.references !== d.references.length || d.stats.resolved !== resolved ||
    d.stats.unknown !== unknown || d.stats.external !== external) throw new Error('Invalid documentation statistics');
  const { artifactId, capturedAt, ...base } = d;
  if (artifactId !== digest(base)) throw new Error('Documentation fingerprint mismatch');
  return d;
}

export function referencesFrom(d: DocTrace, path: string): DocReference[] {
  if (!normalizedRelativePath(path) || !d.documents.some(doc => doc.path === path)) throw new Error('Document not indexed');
  return d.references.filter(r => r.from === path);
}
export function referencesTo(d: DocTrace, path: string): DocReference[] {
  if (!(permittedPath(path) || path.startsWith('/api/')) || path.length > 2048) throw new Error('Invalid target path');
  return d.references.filter(r => r.target === path);
}
