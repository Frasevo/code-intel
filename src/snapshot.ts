import { createHash } from 'node:crypto';
import { languageFor, permittedPath } from './policy.ts';

export const VERSION = '0.5.0';
export const SNAPSHOT_SCHEMA = 'code-snapshot/v1';
export type FileEntry = { path: string; sizeBytes: number; sha256: string; language: string };
export type Snapshot = {
  schemaVersion: 'code-snapshot/v1';
  producerVersion: string;
  repoId: string;
  artifactId: string;
  capturedAt: string;
  sensitivity: 'private';
  provenance: {
    kind: 'filesystem-scan' | 'generic-import';
    commitSha: string | null;
    dirty: boolean | null;
    verification: 'filesystem-verified' | 'unverified';
    coverage: 'included-files-only';
    sourceTreeHash: null;
    includedFilesHash: string;
  };
  files: FileEntry[];
  stats: { files: number; bytes: number };
};

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function createSnapshot(args: {
  repoId: string;
  files: FileEntry[];
  kind: Snapshot['provenance']['kind'];
  commitSha: string | null;
  dirty: boolean | null;
  capturedAt?: string;
}): Snapshot {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(args.repoId)) throw new Error('Invalid repoId');
  const files = [...args.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const includedFilesHash = sha256(JSON.stringify(files));
  const artifactId = `sha256:${sha256(`${SNAPSHOT_SCHEMA}\n${includedFilesHash}\n${args.repoId}`)}`;
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    producerVersion: VERSION,
    repoId: args.repoId,
    artifactId,
    capturedAt: args.capturedAt ?? new Date().toISOString(),
    sensitivity: 'private',
    provenance: {
      kind: args.kind,
      commitSha: args.commitSha,
      dirty: args.dirty,
      verification: args.kind === 'filesystem-scan' ? 'filesystem-verified' : 'unverified',
      coverage: 'included-files-only',
      sourceTreeHash: null,
      includedFilesHash,
    },
    files,
    stats: { files: files.length, bytes: files.reduce((total, file) => total + file.sizeBytes, 0) },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseFiles(value: unknown): FileEntry[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error('Invalid or oversized files list');
  const paths = new Set<string>();
  return value.map((row: unknown) => {
    if (!record(row) || typeof row.path !== 'string' || !permittedPath(row.path)) {
      throw new Error('Invalid or excluded file path in artifact');
    }
    if (paths.has(row.path)) throw new Error('Duplicate path in artifact');
    paths.add(row.path);
    if (!Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes as number) < 0 || !isSha256(row.sha256)) {
      throw new Error(`Invalid metadata for ${row.path}`);
    }
    if (row.language !== undefined && row.language !== languageFor(row.path)) {
      throw new Error(`Incorrect language for ${row.path}`);
    }
    return { path: row.path, sizeBytes: row.sizeBytes as number, sha256: row.sha256, language: languageFor(row.path) };
  });
}

export function validateSnapshot(value: unknown): Snapshot {
  if (!record(value) || value.schemaVersion !== SNAPSHOT_SCHEMA) {
    throw new Error('Unsupported snapshot schemaVersion');
  }
  if (typeof value.repoId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.repoId)) {
    throw new Error('Invalid repoId');
  }
  if (typeof value.producerVersion !== 'string' || value.producerVersion.length > 64 || !value.producerVersion) {
    throw new Error('Invalid producerVersion');
  }
  if (typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt)) || new Date(value.capturedAt).toISOString() !== value.capturedAt) {
    throw new Error('Invalid capturedAt');
  }
  if (value.sensitivity !== 'private' || !record(value.provenance)) throw new Error('Invalid provenance or sensitivity');
  const p = value.provenance;
  if (p.kind !== 'filesystem-scan' && p.kind !== 'generic-import') throw new Error('Invalid provenance kind');
  if (p.dirty !== null && typeof p.dirty !== 'boolean') throw new Error('Invalid dirty status');
  if (p.commitSha !== null && (typeof p.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(p.commitSha))) {
    throw new Error('Invalid commitSha');
  }
  if (p.coverage !== 'included-files-only' || p.sourceTreeHash !== null) throw new Error('Invalid coverage claim');
  if (p.verification !== (p.kind === 'filesystem-scan' ? 'filesystem-verified' : 'unverified')) {
    throw new Error('Invalid verification claim');
  }
  const files = parseFiles(value.files);
  const canonical = createSnapshot({
    repoId: value.repoId, files, kind: p.kind, commitSha: p.commitSha, dirty: p.dirty,
    capturedAt: value.capturedAt,
  });
  if (p.includedFilesHash !== canonical.provenance.includedFilesHash || value.artifactId !== canonical.artifactId) {
    throw new Error('Snapshot content fingerprint mismatch');
  }
  if (!record(value.stats) || value.stats.files !== canonical.stats.files || value.stats.bytes !== canonical.stats.bytes) {
    throw new Error('Snapshot statistics mismatch');
  }
  return canonical;
}
