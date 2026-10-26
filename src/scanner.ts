import { constants, type Stats } from 'node:fs';
import { lstat, realpath, readdir, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { gitIdentity } from './git.ts';
import { permittedDirectory, permittedPath, languageFor } from './policy.ts';
import { createSnapshot, sha256, type FileEntry, type Snapshot } from './snapshot.ts';

const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
// Limit concurrent open file descriptors while overlapping independent hash I/O.
// This is not a change journal: every permitted file still gets SHA-256 hashed.
const HASH_CONCURRENCY = 4;

function inside(root: string, candidate: string): boolean {
  const subpath = relative(root, candidate);
  return subpath === '' || (!subpath.startsWith(`..${sep}`) && subpath !== '..' && !isAbsolute(subpath));
}

async function hashFile(path: string, expected: { size: number; mtimeMs: number; ino: number; dev: number }): Promise<string> {
  // O_NOFOLLOW prevents a symlink swap from redirecting the opened file on POSIX.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== expected.size || before.mtimeMs !== expected.mtimeMs ||
        before.ino !== expected.ino || before.dev !== expected.dev) {
      throw new Error('Source changed before hashing');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || offset !== before.size) {
      throw new Error('Source changed during hashing');
    }
    return hash.digest('hex');
  } finally { await file.close(); }
}

export async function scanRepository(rootArg: string, repoIdArg?: string): Promise<Snapshot> {
  const root = await realpath(resolve(rootArg));
  if (!(await stat(root)).isDirectory()) throw new Error('Repository root is not a directory');
  // Root's location is deliberately not exported. The caller may supply a stable opaque ID.
  const repoId = repoIdArg ?? `r-${sha256(root).slice(0, 32)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(repoId)) throw new Error('Invalid repoId');

  const results: FileEntry[] = [];
  let totalBytes = 0;
  let scheduledFiles = 0;
  const active = new Set<Promise<void>>();
  let hashError: unknown;

  async function queueHash(absolute: string, rel: string, metadata: Stats): Promise<void> {
    if (hashError !== undefined) throw hashError;
    // A failed hash is captured and rethrown after the running jobs settle.
    // No promise is left unobserved if walking the tree itself fails.
    const task = (async () => {
      const hash = await hashFile(absolute, metadata);
      const after = await lstat(absolute);
      if (!after.isFile() || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs ||
          after.ino !== metadata.ino || after.dev !== metadata.dev) {
        throw new Error(`File changed during scan: ${rel}`);
      }
      results.push({ path: rel, sizeBytes: metadata.size, sha256: hash, language: languageFor(rel) });
    })().catch(error => {
      if (hashError === undefined) hashError = error;
    }).finally(() => { active.delete(task); });
    active.add(task);
    if (active.size >= HASH_CONCURRENCY) {
      await Promise.race(active);
      if (hashError !== undefined) throw hashError;
    }
  }

  async function visit(folder: string): Promise<void> {
    const children = await readdir(folder, { withFileTypes: true });
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      if (hashError !== undefined) throw hashError;
      const absolute = resolve(folder, child.name);
      const rel = relative(root, absolute).split(sep).join('/');
      // Avoid opening or resolving directories excluded by the policy.
      // File types are checked again with lstat: Dirent alone is not a security boundary.
      if (child.isDirectory() && !permittedDirectory(rel)) continue;
      if (child.isFile() && !permittedPath(rel)) continue;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory() && !permittedDirectory(rel)) continue;
      if (metadata.isFile() && !permittedPath(rel)) continue;
      if (!metadata.isFile() && !metadata.isDirectory()) continue;
      const resolved = await realpath(absolute);
      if (!inside(root, resolved)) throw new Error('Path escapes repository root');
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (metadata.size > MAX_FILE_BYTES) throw new Error(`Source file exceeds 8 MiB: ${rel}`);
      totalBytes += metadata.size;
      if (totalBytes > MAX_TOTAL_BYTES || scheduledFiles >= MAX_FILES) {
        throw new Error('Repository exceeds scan safety limits');
      }
      scheduledFiles++;
      await queueHash(absolute, rel, metadata);
    }
  }
  try {
    await visit(root);
    await Promise.all(active);
    if (hashError !== undefined) throw hashError;
  } catch (error) {
    // Ensure all file handles are closed before surfacing a traversal/hash error.
    await Promise.all(active);
    throw error;
  }
  const git = gitIdentity(root);
  return createSnapshot({ repoId, files: results, kind: 'filesystem-scan', ...git });
}
