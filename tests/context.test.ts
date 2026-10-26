import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildGraph } from '../src/graph.ts';
import { buildApiCatalog } from '../src/api-registry.ts';
import { buildDocTrace } from '../src/docs.ts';
import { scanRepository } from '../src/scanner.ts';
import { selectContext, type ContextIndexes } from '../src/context.ts';

async function fixture(): Promise<{ dir: string; root: string; indexes: ContextIndexes }> {
  const dir = await mkdtemp(join(tmpdir(), 'frasevo-ci05a-'));
  const root = join(dir, 'source');
  try {
    for (const [path, content] of Object.entries({
      'src/core/items.ts': 'export const getItems = () => [1, 2];\n',
      'src/core/service.ts': "import { getItems } from './items.js';\nexport const useItems = () => getItems();\n",
      'src/app/api/items/route.ts': "import { useItems } from '../../../core/service.js';\nexport function GET() { return Response.json(useItems()); }\n",
      'README.md': '# Getting Started\n[service](src/core/service.ts)\n[API](/api/items)\n',
      'docs/overview.md': '# Items API\n[items](../src/core/items.ts)\n',
    })) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const repoId = 'context-fixture';
    const [snapshot, graph, api, docs] = await Promise.all([
      scanRepository(root, repoId), buildGraph(root, repoId), buildApiCatalog(root, repoId), buildDocTrace(root, repoId),
    ]);
    return { dir, root, indexes: { snapshot, graph, api, docs } };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

test('CI-05A deterministic exact-path, symbols, routes and heading references', async () => {
  const f = await fixture();
  try {
    const q = { path: 'src/core/items.ts', keyword: 'getItems', depth: 0 as const };
    const a = selectContext(f.indexes, q);
    const b = selectContext(f.indexes, q);
    assert.deepEqual(a, b);
    assert.equal(a.status, 'matched');
    assert.equal(a.hits[0]?.kind, 'file');
    assert.ok(a.hits.some(x => x.kind === 'symbol' && x.label === 'getItems' && x.evidence.line === 1));
    assert.ok(a.hits.every(x => x.evidence.artifactId === Object.values(a.sources).find(id => id === x.evidence.artifactId)));
    assert.equal(selectContext(f.indexes, { path: '/api/items' }).hits[0]?.kind, 'route');
    assert.equal(selectContext(f.indexes, { path: '/api/items/[...slug]' }).status, 'no-match');
    assert.ok(selectContext(f.indexes, { keyword: 'getting-started' }).hits.some(x => x.kind === 'heading'));
    assert.deepEqual(selectContext(f.indexes, { keyword: 'unfindable-name-xy' }).hits, []);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('CI-05A bounded graph and documentation connections, never execute or fetch source', async () => {
  const f = await fixture();
  try {
    const a = selectContext(f.indexes, { path: 'src/app/api/items/route.ts', depth: 2 });
    assert.ok(a.hits.some(h => h.kind === 'relation' && h.path === 'src/core/service.ts'));
    assert.ok(a.hits.some(h => h.kind === 'relation' && h.path === 'src/core/items.ts'));
    assert.ok(a.hits.filter(h => h.kind === 'relation').every(h => h.evidence.line !== null && h.evidence.column !== null));
    assert.equal(selectContext(f.indexes, { path: 'src/app/api/items/route.ts', depth: 0 }).hits.some(h => h.kind === 'relation'), false);
    assert.ok(selectContext(f.indexes, { path: 'README.md', depth: 1 }).hits.some(h => h.kind === 'relation' && h.relation?.kind === 'documentation-link'));
    const small = selectContext(f.indexes, { path: 'src/app/api/items/route.ts', depth: 2, maxResults: 1 });
    assert.equal(small.hits.length, 1); assert.equal(small.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(selectContext(f.indexes, { keyword: 'src', maxBytes: 2048 }))) <= 2048);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('CI-05A rejects invalid paths, unbounded inputs and incompatible or tampered artifacts', async () => {
  const f = await fixture();
  try {
    for (const path of ['../outside.ts', 'src/secret/credentials.ts', '/etc/passwd', 'C:\\windows\\x.ts', 'src//core.ts', '/api/../things', '/api/%2e%2e/stuff']) {
      assert.throws(() => selectContext(f.indexes, { path }), /Invalid or excluded/);
    }
    assert.throws(() => selectContext(f.indexes, {}), /Specify/);
    assert.throws(() => selectContext(f.indexes, { keyword: '*' }), /keyword/);
    assert.throws(() => selectContext(f.indexes, { keyword: 'items', depth: 3 as 2 }), /limits/);
    assert.throws(() => selectContext(f.indexes, { keyword: 'items', maxResults: 100 }), /limits/);
    assert.throws(() => selectContext(f.indexes, { keyword: 'items', maxBytes: 1 }), /limits/);
    assert.throws(() => selectContext(f.indexes, { path: 'a'.repeat(2000) + '.ts', maxBytes: 2048 }), /byte limit/);
    const changed = structuredClone(f.indexes);
    changed.docs.sources.apiArtifactId = f.indexes.snapshot.artifactId;
    assert.throws(() => selectContext(changed, { keyword: 'items' }), /fingerprint|Incompatible/);
    const wrong = structuredClone(f.indexes);
    wrong.snapshot.files[0]!.sha256 = '0'.repeat(64);
    assert.throws(() => selectContext(wrong, { keyword: 'items' }), /fingerprint/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
