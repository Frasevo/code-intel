import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanRepository } from '../src/scanner.ts';
import { createSnapshot, sha256, validateSnapshot } from '../src/snapshot.ts';
import { importArtifact } from '../src/importer.ts';
import { normalizedRelativePath, permittedPath } from '../src/policy.ts';
import { main } from '../src/cli.ts';

async function fixture(): Promise<{ root: string; parent: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'ci-01-fixture-'));
  const root = join(parent, 'repository');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'node_modules'));
  await mkdir(join(root, 'secrets'));
  await writeFile(join(root, 'src', 'index.ts'), 'export const x: number = 1;\n');
  await writeFile(join(root, '.env.production'), 'SUPER_PRIVATE=token\n');
  await writeFile(join(root, 'secrets', 'client.json'), '{"password":"real"}');
  await writeFile(join(root, 'node_modules', 'dep.js'), 'export default 1;');
  await writeFile(join(root, 'src', 'config.json'), '{"enabled":true}');
  await writeFile(join(parent, 'outside.ts'), 'PRIVATE OUTSIDE');
  try { await symlink(join(parent, 'outside.ts'), join(root, 'src', 'linked.ts')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
  return { root, parent };
}

test('CI-01 deterministic included-files inventory with exclusions and no writes', async () => {
  const { root, parent } = await fixture();
  try {
    const a = await scanRepository(root, 'synthetic');
    const b = await scanRepository(root, 'synthetic');
    assert.deepEqual(a.files.map((f) => f.path), ['src/config.json', 'src/index.ts']);
    assert.deepEqual(a.files, b.files);
    assert.equal(a.provenance.includedFilesHash, b.provenance.includedFilesHash);
    assert.equal(a.artifactId, b.artifactId);
    assert.equal(a.provenance.sourceTreeHash, null);
    assert.equal(a.provenance.coverage, 'included-files-only');
    assert.equal(a.provenance.verification, 'filesystem-verified');
    assert.equal(a.sensitivity, 'private');
    assert.equal(a.stats.files, 2);
    assert.ok(!JSON.stringify(a).includes('SUPER_PRIVATE'));
    assert.ok(!JSON.stringify(a).includes('outside.ts'));
    assert.equal((await readFile(join(root, 'src/index.ts'), 'utf8')), 'export const x: number = 1;\n');
    assert.deepEqual(validateSnapshot(a), a);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-01 rejects invalid paths and tampered snapshots', () => {
  for (const path of ['../up.ts', '/tmp/file.ts', 'C:/file.ts', 'src\\file.ts', 'x//file.ts',
    'secrets/config.ts', 'src/.env.production', 'node_modules/a.ts', 'src/id_rsa', 'a/private-key.json']) {
    assert.equal(permittedPath(path), false, path);
  }
  assert.equal(normalizedRelativePath('a/../b.ts'), null);
  const snap = createSnapshot({ repoId: 'synthetic', files: [{ path: 'src/a.ts', sizeBytes: 1, sha256: sha256('a'), language: 'typescript' }], kind: 'filesystem-scan', commitSha: null, dirty: null });
  assert.deepEqual(validateSnapshot(snap), snap);
  assert.throws(() => validateSnapshot({ ...snap, files: [{ ...snap.files[0], sha256: sha256('wrong') }] }), /fingerprint/);
  assert.throws(() => validateSnapshot({ ...snap, schemaVersion: 'code-snapshot/v2' }), /Unsupported/);
});

test('CI-01 generic importer is explicitly unverified and rejects unsafe inputs', () => {
  const generic = { schemaVersion: 'generic-file-inventory/v1', files: [{ path: 'app/a.ts', sizeBytes: 5, sha256: sha256('hello') }] };
  const snap = importArtifact(generic, 'fixture');
  assert.equal(snap.provenance.kind, 'generic-import');
  assert.equal(snap.provenance.verification, 'unverified');
  assert.equal(snap.provenance.dirty, null);
  assert.deepEqual(validateSnapshot(snap), snap);
  assert.throws(() => importArtifact({ ...generic, files: [{ ...generic.files[0], path: '../token.ts' }] }, 'fixture'), /excluded/);
  assert.throws(() => importArtifact({ ...generic, files: [generic.files[0], generic.files[0]] }, 'fixture'), /Duplicate/);
  assert.throws(() => importArtifact({ ...generic, schemaVersion: 'future/v2' }, 'fixture'), /Unsupported/);
});

test('CI-01 CLI writes only outside scanned repo and supports validate', async () => {
  const { root, parent } = await fixture();
  try {
    const inside = join(root, 'snapshot.json');
    await assert.rejects(main(['scan', root, '--out', inside, '--repo-id', 'fixture']), /outside/);
    const out = join(parent, 'snapshot.json');
    await main(['scan', root, '--repo-id', 'fixture', '--out', out]);
    const obj = JSON.parse(await readFile(out, 'utf8')) as unknown;
    assert.equal(validateSnapshot(obj).stats.files, 2);
    await main(['validate', out]);
    await assert.rejects(main(['scan', root, '--out', out, '--out', out]), /Usage/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-01 filename with spaces and empty repository are supported', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ci-01-spaces-'));
  const root = join(parent, 'repo with spaces');
  try {
    await mkdir(root);
    assert.equal((await scanRepository(root, 'fixture')).stats.files, 0);
    await writeFile(join(root, 'with spaces.ts'), 'export {}');
    assert.deepEqual((await scanRepository(root, 'fixture')).files.map((f) => f.path), ['with spaces.ts']);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-01 imports code snapshots without trusting original filesystem verification', () => {
  const snapshot = createSnapshot({ repoId: 'fixture', files: [], kind: 'filesystem-scan', commitSha: 'f'.repeat(40), dirty: false });
  const imported = importArtifact(snapshot, 'fixture');
  assert.equal(imported.provenance.verification, 'unverified');
  assert.equal(imported.provenance.commitSha, null);
  assert.equal(imported.provenance.dirty, null);
  assert.deepEqual(validateSnapshot(imported), imported);
});

test('CI-01 never assigns a parent repository commit to a scanned subdirectory', async () => {
  const { execFileSync } = await import('node:child_process');
  const parent = await mkdtemp(join(tmpdir(), 'ci-01-parent-git-'));
  const child = join(parent, 'child');
  try {
    await mkdir(child);
    execFileSync('git', ['init', '-q', parent], { stdio: 'ignore' });
    const snapshot = await scanRepository(child, 'child');
    assert.equal(snapshot.provenance.commitSha, null);
    assert.equal(snapshot.provenance.dirty, null);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
