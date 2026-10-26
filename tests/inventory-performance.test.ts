import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm, stat, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepository } from '../src/scanner.ts';
import { sha256, validateSnapshot } from '../src/snapshot.ts';

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'ci06a2-'));
  const root = join(parent, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  return { parent, root };
}

test('CI-06A2 produces deterministic, complete inventory under bounded parallel hashing', async () => {
  const { parent, root } = await fixture();
  try {
    for (let i = 79; i >= 0; i--) {
      await writeFile(join(root, 'src', `file-${String(i).padStart(3, '0')}.ts`), `export const value = ${i};\n`);
    }
    const first = await scanRepository(root, 'ci06a2');
    const second = await scanRepository(root, 'ci06a2');
    assert.equal(first.stats.files, 80);
    assert.deepEqual(first.files, second.files);
    assert.equal(first.artifactId, second.artifactId);
    assert.deepEqual(validateSnapshot(second), second);
    assert.deepEqual(first.files.map(x => x.path), [...first.files.map(x => x.path)].sort());
    for (const file of first.files) {
      assert.equal(file.sha256, sha256(await readFile(join(root, file.path))));
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-06A2 detects additions, removals and equal-size rewrites with restored mtime', async () => {
  const { parent, root } = await fixture();
  try {
    const a = join(root, 'src', 'a.ts');
    const b = join(root, 'src', 'b.ts');
    await writeFile(a, 'export const a = 1;\n');
    await writeFile(b, 'export const b = 1;\n');
    let before = await scanRepository(root, 'ci06a2');
    const initialFile = before.files.find(x => x.path === 'src/a.ts')!;
    const dates = await stat(a);
    await writeFile(a, 'export const a = 2;\n');
    await utimes(a, dates.atime, dates.mtime);
    const rewrite = await scanRepository(root, 'ci06a2');
    assert.equal(rewrite.files.find(x => x.path === 'src/a.ts')!.sizeBytes, initialFile.sizeBytes);
    assert.notEqual(rewrite.files.find(x => x.path === 'src/a.ts')!.sha256, initialFile.sha256);
    assert.notEqual(rewrite.artifactId, before.artifactId);
    await unlink(b);
    await writeFile(join(root, 'src', 'c.ts'), 'export const c = 3;\n');
    before = await scanRepository(root, 'ci06a2');
    assert.deepEqual(before.files.map(x => x.path), ['src/a.ts', 'src/c.ts']);
    assert.notEqual(before.artifactId, rewrite.artifactId);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-06A2 ignores excluded and symlinked paths; enforces file size limit', async () => {
  const { parent, root } = await fixture();
  try {
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'secret.ts'), 'secret-content');
    await writeFile(join(root, 'src', '.env.production'), 'A=secret');
    await writeFile(join(parent, 'outside.ts'), 'do-not-index');
    try { await symlink(join(parent, 'outside.ts'), join(root, 'src', 'outside.ts')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
    const safe = await scanRepository(root, 'ci06a2');
    assert.equal(safe.stats.files, 0);
    await writeFile(join(root, 'src', 'oversize.ts'), Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(scanRepository(root, 'ci06a2'), /exceeds 8 MiB/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
