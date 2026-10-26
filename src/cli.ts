#!/usr/bin/env node
import { lstat, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './scanner.ts';
import { importArtifact, readJsonArtifact } from './importer.ts';
import { validateSnapshot, type Snapshot } from './snapshot.ts';

function usage(): never {
  throw new Error('Usage: scan <repo> --out <file> [--repo-id <id>] | import <input> --out <file> --repo-id <id> | validate <snapshot>');
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (index === args.length - 1 || args[index + 1]!.startsWith('--')) usage();
  return args[index + 1];
}

function checkArgs(args: string[], permitted: Set<string>): void {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (!args[i]!.startsWith('--') || !permitted.has(args[i]!) || seen.has(args[i]!) || i === args.length - 1 || args[i + 1]!.startsWith('--')) usage();
    seen.add(args[i]!);
    i++;
  }
}

function within(root: string, destination: string): boolean {
  const rel = relative(root, destination);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function outputSnapshot(snapshot: Snapshot, output: string, scanRoot?: string): Promise<void> {
  const target = resolve(output);
  const dir = await realpath(dirname(target));
  const destination = resolve(dir, basename(target));
  if (scanRoot && within(await realpath(scanRoot), destination)) {
    throw new Error('Output must be outside the repository being scanned');
  }
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error('Refusing to overwrite symlink output');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = resolve(dir, `.frasevo-snapshot-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temp, destination);
  } finally { await rm(temp, { force: true }); }
}

export async function main(args: string[]): Promise<void> {
  const [command, target, ...rest] = args;
  if (!target || target.startsWith('--')) usage();
  if (command === 'scan') {
    checkArgs(rest, new Set(['--out', '--repo-id']));
    const out = option(rest, '--out');
    if (!out) usage();
    const snapshot = await scanRepository(target, option(rest, '--repo-id'));
    await outputSnapshot(snapshot, out, target);
    console.log(`Wrote ${snapshot.stats.files} files to snapshot (${snapshot.artifactId})`);
  } else if (command === 'import') {
    checkArgs(rest, new Set(['--out', '--repo-id']));
    const out = option(rest, '--out');
    const repoId = option(rest, '--repo-id');
    if (!out || !repoId) usage();
    const snapshot = importArtifact(await readJsonArtifact(target), repoId);
    await outputSnapshot(snapshot, out);
    console.log(`Imported ${snapshot.stats.files} file records (${snapshot.provenance.verification})`);
  } else if (command === 'validate') {
    if (rest.length > 0) usage();
    const snapshot = validateSnapshot(await readJsonArtifact(target));
    console.log(`Valid ${snapshot.schemaVersion} (${snapshot.artifactId})`);
  } else usage();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Unexpected error');
    process.exitCode = 1;
  });
}
