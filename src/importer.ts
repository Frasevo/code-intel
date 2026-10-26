import { readFile } from 'node:fs/promises';
import { createSnapshot, parseFiles, validateSnapshot, type Snapshot } from './snapshot.ts';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export async function readJsonArtifact(path: string): Promise<unknown> {
  const { stat } = await import('node:fs/promises');
  const file = await stat(path);
  if (!file.isFile() || file.size > MAX_IMPORT_BYTES) throw new Error('Invalid or oversized JSON artifact');
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch { throw new Error('Invalid JSON artifact'); }
}

// Generic producer-neutral inventory. No source checkout means freshness is UNKNOWN.
// It cannot claim a complete source tree, a commit or a verified import.
export function importArtifact(input: unknown, repoId: string): Snapshot {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid inventory');
  const value = input as Record<string, unknown>;
  if (value.schemaVersion === 'code-snapshot/v1') {
    const snapshot = validateSnapshot(value);
    if (snapshot.repoId !== repoId) throw new Error('repoId mismatch');
    return createSnapshot({ repoId, files: snapshot.files, kind: 'generic-import', commitSha: null, dirty: null });
  }
  if (value.schemaVersion !== 'generic-file-inventory/v1') throw new Error('Unsupported import schemaVersion');
  const files = parseFiles(value.files);
  return createSnapshot({ repoId, files, kind: 'generic-import', commitSha: null, dirty: null });
}
