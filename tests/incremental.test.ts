import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph, validateGraph, type GraphReuseStats } from '../src/graph.ts';
import { scanRepository } from '../src/scanner.ts';
import { main } from '../src/cli.ts';

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'ci06a-'));
  const root = join(parent, 'repo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }));
  await writeFile(join(root, 'src', 'a.ts'), "import { b } from './b';\nexport const a = b;\n");
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  await writeFile(join(root, 'src', 'c.ts'), 'export const c = 3;\n');
  return { parent, root };
}
const metrics = (): GraphReuseStats => ({ reusedFiles: 0, parsedFiles: 0, fallback: null });

test('CI-06A reuses unchanged AST records but has the same v1 graph as a full build', async () => {
  const { root, parent } = await fixture();
  try {
    const snapshot = await scanRepository(root, 'fixture');
    const graph = await buildGraph(root, 'fixture');
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2;\nexport function next() {}\n');
    const stats = metrics();
    const incremental = await buildGraph(root, 'fixture', { snapshot, graph, stats });
    const fresh = await buildGraph(root, 'fixture');
    assert.equal(stats.fallback, null);
    assert.equal(stats.reusedFiles, 2);
    assert.equal(stats.parsedFiles, 1);
    assert.equal(incremental.artifactId, fresh.artifactId);
    assert.deepEqual(incremental.nodes, fresh.nodes);
    assert.deepEqual(incremental.edges, fresh.edges);
    assert.deepEqual(incremental.issues, fresh.issues);
    assert.deepEqual(validateGraph(incremental), incremental);
    assert.ok(incremental.nodes.some(node => node.kind === 'symbol' && node.name === 'next'));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-06A falls back on config changes and source additions or removals', async () => {
  const { root, parent } = await fixture();
  try {
    let snapshot = await scanRepository(root, 'fixture');
    let graph = await buildGraph(root, 'fixture');
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'node' } }));
    let stats = metrics();
    let actual = await buildGraph(root, 'fixture', { snapshot, graph, stats });
    assert.equal(stats.fallback, 'json-configuration-changed');
    assert.equal(stats.reusedFiles, 0);
    assert.equal(actual.artifactId, (await buildGraph(root, 'fixture')).artifactId);

    snapshot = await scanRepository(root, 'fixture');
    graph = actual;
    await writeFile(join(root, 'src', 'd.ts'), "export { a } from './a';\n");
    stats = metrics();
    actual = await buildGraph(root, 'fixture', { snapshot, graph, stats });
    assert.equal(stats.fallback, 'source-paths-changed');
    assert.equal(actual.artifactId, (await buildGraph(root, 'fixture')).artifactId);
    await unlink(join(root, 'src', 'd.ts'));
    snapshot = await scanRepository(root, 'fixture');
    graph = await buildGraph(root, 'fixture');
    await unlink(join(root, 'src', 'a.ts'));
    stats = metrics();
    actual = await buildGraph(root, 'fixture', { snapshot, graph, stats });
    assert.equal(stats.fallback, 'source-paths-changed');
    assert.equal(actual.artifactId, (await buildGraph(root, 'fixture')).artifactId);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-06A rejects incompatible cached artifacts and CLI writes outside repo', async () => {
  const { root, parent } = await fixture();
  try {
    const snapshot = await scanRepository(root, 'fixture');
    const graph = await buildGraph(root, 'fixture');
    await assert.rejects(buildGraph(root, 'fixture2', { snapshot, graph }), /incompatible/);
    await assert.rejects(buildGraph(root, 'fixture', { snapshot: { ...snapshot, artifactId: 'sha256:' + '0'.repeat(64) }, graph }), /fingerprint/);
    const prevSnapshot = join(parent, 'previous-snapshot.json');
    const prevGraph = join(parent, 'previous-graph.json');
    const dest = join(parent, 'next-graph.json');
    await writeFile(prevSnapshot, JSON.stringify(snapshot));
    await writeFile(prevGraph, JSON.stringify(graph));
    await main(['graph-incremental', root, '--previous-snapshot', prevSnapshot, '--previous-graph', prevGraph, '--out', dest, '--repo-id', 'fixture']);
    const result = validateGraph(JSON.parse(await readFile(dest, 'utf8')));
    assert.equal(result.artifactId, graph.artifactId);
    await assert.rejects(main(['graph-incremental', root, '--previous-snapshot', prevSnapshot, '--previous-graph', prevGraph, '--out', join(root, 'output.json'), '--repo-id', 'fixture']), /outside/);
    await assert.rejects(main(['graph-incremental', root, '--previous-snapshot', prevSnapshot, '--previous-graph', prevGraph, '--out', dest, '--bogus', 'x']), /Usage/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-06A supports explicit single-file invalidation and rejects unsafe paths', async () => {
  const { root, parent } = await fixture();
  try {
    const snapshot = await scanRepository(root, 'fixture');
    const graph = await buildGraph(root, 'fixture');
    const stats = metrics();
    const updated = await buildGraph(root, 'fixture', { snapshot, graph, invalidatePaths: ['src/a.ts'], stats });
    assert.equal(stats.reusedFiles, 2);
    assert.equal(stats.parsedFiles, 1);
    assert.equal(updated.artifactId, graph.artifactId);
    await assert.rejects(buildGraph(root, 'fixture', { snapshot, graph, invalidatePaths: ['../private.ts'] }), /Invalid incremental/);
    const fallback = metrics();
    await buildGraph(root, 'fixture', { snapshot, graph, invalidatePaths: ['README.md'], stats: fallback });
    assert.equal(fallback.fallback, 'explicit-non-source-invalidation');
    assert.equal(fallback.parsedFiles, 3);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
