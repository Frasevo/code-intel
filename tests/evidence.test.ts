import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildGraph } from '../src/graph.ts';
import { buildApiCatalog } from '../src/api-registry.ts';
import { buildDocTrace } from '../src/docs.ts';
import { scanRepository } from '../src/scanner.ts';
import { buildEvidencePack } from '../src/evidence.ts';
import type { ContextIndexes } from '../src/context.ts';

async function fixture(): Promise<{ parent: string; root: string; indexes: ContextIndexes }> {
  const parent = await mkdtemp(join(tmpdir(), 'frasevo-ci05b-'));
  const root = join(parent, 'source');
  try {
    for (const [path, content] of Object.entries({
      'src/items.ts': 'export function getItems() { return [1, 2]; }\n',
      'src/service.ts': "import { getItems } from './items.js';\nexport const useItems = () => getItems();\n",
      'src/long.ts': `${' '.repeat(600)}export const deepSymbol = 1;\n`,
      'src/app/api/items/route.ts': "import { useItems } from '../../../service.js';\nexport function GET() { return Response.json(useItems()); }\n",
      'README.md': '# Getting Started\n[items](src/items.ts)\n[API](/api/items)\n',
    })) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    const repoId = 'evidence-fixture';
    const [snapshot, graph, api, docs] = await Promise.all([
      scanRepository(root, repoId), buildGraph(root, repoId), buildApiCatalog(root, repoId), buildDocTrace(root, repoId),
    ]);
    return { parent, root, indexes: { snapshot, graph, api, docs } };
  } catch (error) { await rm(parent, { recursive: true, force: true }); throw error; }
}

test('CI-05B source excerpts are anchored, hash-verified, bounded and deterministic', async () => {
  const f = await fixture();
  try {
    const query = { path: 'src/items.ts', keyword: 'getItems' };
    const a = await buildEvidencePack(f.root, f.indexes, query);
    const b = await buildEvidencePack(f.root, f.indexes, query);
    assert.deepEqual(a, b);
    const symbol = a.records.find(r => r.hit.kind === 'symbol' && r.hit.label === 'getItems');
    assert.equal(symbol?.status, 'indexed');
    assert.equal(symbol.verification, 'sha256-verified');
    assert.equal(symbol.expectedSha256, f.indexes.snapshot.files.find(x => x.path === 'src/items.ts')?.sha256);
    assert.match(symbol.excerpt!.text, /export function getItems/);
    assert.equal(symbol.excerpt!.startLine, 1);
    assert.equal(symbol.excerpt!.startColumn, 1);
    assert.equal(a.records.find(r => r.hit.kind === 'file')?.status, 'not-checked');
    assert.equal(a.records.find(r => r.hit.kind === 'file')?.reason, 'no-location');
    assert.ok(!JSON.stringify(a).includes(f.root));
    assert.equal(a.sensitivity, 'private');

    const doc = await buildEvidencePack(f.root, f.indexes, { keyword: 'getting-started' });
    assert.equal(doc.records.find(r => r.hit.kind === 'heading')?.status, 'indexed');
    assert.match(doc.records.find(r => r.hit.kind === 'heading')?.excerpt?.text ?? '', /# Getting Started/);

    const long = await buildEvidencePack(f.root, f.indexes, { keyword: 'deepSymbol' }, { maxChars: 100 });
    const excerpt = long.records.find(r => r.hit.kind === 'symbol')?.excerpt;
    assert.ok(excerpt);
    assert.ok(excerpt.startColumn > 1);
    assert.match(excerpt.text, /deepSymbol/);
    assert.equal(excerpt.truncated, true);
    assert.ok(excerpt.text.length <= 100);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('CI-05B never returns source bytes for stale files or linked replacements', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'src/items.ts'), 'export function getItems() { return [999]; }\n');
    const stale = await buildEvidencePack(f.root, f.indexes, { keyword: 'getItems' });
    const hit = stale.records.find(r => r.hit.kind === 'symbol');
    assert.equal(hit?.status, 'unknown');
    assert.equal(hit?.verification, 'failed');
    assert.equal(hit?.reason, 'source-unavailable');
    assert.equal(hit?.excerpt, null);
    // Fingerprints can coincidentally contain these digits; check excerpt content only.
    assert.ok(stale.records.every(record => !record.excerpt?.text.includes('[999]')));

    const outside = join(f.parent, 'outside.ts');
    await writeFile(outside, 'export const getItems = "outside forbidden";\n');
    await rm(join(f.root, 'src/items.ts'));
    let created = false;
    try { await symlink(outside, join(f.root, 'src/items.ts')); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
    if (created) {
      const linked = await buildEvidencePack(f.root, f.indexes, { keyword: 'getItems' });
      assert.equal(linked.records.find(r => r.hit.kind === 'symbol')?.status, 'unknown');
      assert.ok(!JSON.stringify(linked).includes('outside forbidden'));
    }
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('CI-05B enforces independent source and output limits, without guessing absent evidence', async () => {
  const f = await fixture();
  try {
    const noMatch = await buildEvidencePack(f.root, f.indexes, { keyword: 'not-present-xyz' });
    assert.equal(noMatch.status, 'no-match');
    assert.deepEqual(noMatch.records, []);

    const noRead = await buildEvidencePack(f.root, f.indexes, { keyword: 'getItems' }, { maxSourceBytes: 1 });
    assert.equal(noRead.records.find(r => r.hit.kind === 'symbol')?.status, 'not-checked');
    assert.equal(noRead.records.find(r => r.hit.kind === 'symbol')?.reason, 'read-budget');

    const limited = await buildEvidencePack(f.root, f.indexes, { keyword: 'Items' }, { maxSourceFiles: 1 });
    assert.ok(limited.records.some(r => r.status === 'indexed'));
    assert.ok(limited.records.some(r => r.reason === 'read-budget'));

    const packed = await buildEvidencePack(f.root, f.indexes, { keyword: 'Items', depth: 0 }, { maxPackBytes: 2048 });
    assert.ok(Buffer.byteLength(JSON.stringify(packed), 'utf8') <= 2048);
    assert.equal(packed.truncated, true);

    await assert.rejects(buildEvidencePack(f.root, f.indexes, { keyword: 'getItems' }, { maxChars: 1 }), /Invalid evidence limit/);
    await assert.rejects(buildEvidencePack(f.root, f.indexes, { keyword: 'getItems' }, { maxPackBytes: 100000 }), /Invalid evidence limit/);
    const altered = structuredClone(f.indexes);
    altered.api.repoId = 'other-repo';
    await assert.rejects(buildEvidencePack(f.root, altered, { keyword: 'Items' }), /fingerprint|Incompatible/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});
