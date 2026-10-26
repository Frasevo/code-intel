import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph, consumersOf, validateGraph } from '../src/graph.ts';
import { main } from '../src/cli.ts';

type Repo = { parent: string; root: string };
async function fixture(): Promise<Repo> {
  const parent = await mkdtemp(join(tmpdir(), 'ci02-graph-'));
  const root = join(parent, 'repo with spaces');
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  await mkdir(join(root, 'src', 'features'), { recursive: true });
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] }, moduleResolution: 'bundler', jsx: 'preserve' },
  }));
  await writeFile(join(root, 'src', 'components', 'widget.ts'), `export interface WidgetProps { text: string }\nexport function Widget() { return 'widget'; }\nexport const value = 1;\n`);
  await writeFile(join(root, 'src', 'features', 'barrel.ts'), `export { Widget, value } from '@/components/widget';\nexport type { WidgetProps } from '@/components/widget';\n`);
  await writeFile(join(root, 'src', 'page.tsx'), `import { Widget } from './features/barrel';\nimport type { WidgetProps } from '@/components/widget';\nimport { thing } from './missing';\nimport os from 'node:os';\nexport function Page(p: WidgetProps) { return Widget(); }\nconst lazy = () => import('./components/widget');\nconst unsure = (name: string) => import(name);\n`);
  await writeFile(join(root, 'src', 'external.js'), `const widget = require('./components/widget');\n`);
  await writeFile(join(root, 'secrets', 'credentials.ts'), 'export const token = "private";');
  return { root, parent };
}

test('CI-02 TypeScript AST resolves relative, aliases, reexports, type-only imports and consumers', async () => {
  const { parent, root } = await fixture();
  try {
    const graph = await buildGraph(root, 'synthetic');
    assert.equal(graph.schemaVersion, 'code-graph/v1');
    assert.equal(graph.coverage.tsconfig, 'loaded');
    assert.equal(graph.sensitivity, 'private');
    assert.equal(graph.coverage.analyzedFiles, 4);
    assert.ok(graph.nodes.some(n => n.kind === 'symbol' && n.name === 'Widget' && n.exported));
    assert.ok(graph.nodes.some(n => n.kind === 'symbol' && n.name === 'WidgetProps' && n.exported));
    assert.ok(graph.nodes.some(n => n.kind === 'symbol' && n.name === 'Page' && n.exported));
    const barrel = graph.edges.find(e => e.from === 'file:src/features/barrel.ts' && e.relation === 'reexport' && e.specifier === '@/components/widget');
    assert.equal(barrel?.to, 'file:src/components/widget.ts');
    assert.deepEqual(barrel?.symbols, ['Widget', 'value']);
    assert.ok(graph.edges.some(e => e.relation === 'import' && e.from === 'file:src/page.tsx' && e.to === 'file:src/features/barrel.ts'));
    assert.ok(graph.edges.some(e => e.relation === 'import' && e.typeOnly && e.to === 'file:src/components/widget.ts'));
    assert.ok(graph.edges.some(e => e.relation === 'export' && e.symbols.includes('Widget')));
    assert.ok(graph.edges.some(e => e.relation === 'dynamic-import' && e.to === 'file:src/components/widget.ts'));
    assert.ok(graph.edges.some(e => e.relation === 'dynamic-import' && e.to === null && e.resolution === 'unknown'));
    assert.ok(graph.edges.some(e => e.relation === 'require' && e.to === 'file:src/components/widget.ts'));
    assert.ok(graph.edges.some(e => e.specifier === './missing' && e.resolution === 'unknown'));
    assert.ok(graph.edges.some(e => e.specifier === 'node:os' && e.resolution === 'external'));
    assert.deepEqual(consumersOf(graph, 'src/features/barrel.ts'), ['src/page.tsx']);
    assert.deepEqual(consumersOf(graph, 'src/components/widget.ts'), ['src/external.js', 'src/features/barrel.ts', 'src/page.tsx']);
    assert.ok(!JSON.stringify(graph).includes('credentials.ts'));
    assert.deepEqual(validateGraph(graph), graph);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-02 deterministic graph fingerprint regardless of capture time', async () => {
  const { parent, root } = await fixture();
  try {
    const a = await buildGraph(root, 'fixture');
    const b = await buildGraph(root, 'fixture');
    assert.equal(a.artifactId, b.artifactId);
    assert.deepEqual(a.nodes, b.nodes);
    assert.deepEqual(a.edges, b.edges);
    assert.ok(a.nodes.every(node => /^[a-f0-9]{64}$/.test(node.sha256)));
    assert.equal(a.stats.files, 4);
    assert.equal(a.sourceSnapshot.artifactId, b.sourceSnapshot.artifactId);
    assert.throws(() => validateGraph({ ...a, nodes: a.nodes.slice(1) }), /node|edge|stats|fingerprint/i);
    assert.throws(() => validateGraph({ ...a, schemaVersion: 'code-graph/v2' }), /Unsupported/);
    assert.throws(() => consumersOf(a, '../src/page.tsx'), /Invalid/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-02 CLI graph and consumers are read-only and output stays outside repository', async () => {
  const { parent, root } = await fixture();
  try {
    await assert.rejects(() => main(['graph', root, '--out', join(root, 'bad.json')]), /outside/);
    const out = join(parent, 'graph.json');
    await main(['graph', root, '--out', out, '--repo-id', 'synthetic']);
    await main(['graph-validate', out]);
    await main(['consumers', out, '--path', 'src/features/barrel.ts']);
    const graph = validateGraph(JSON.parse(await readFile(out, 'utf8')));
    assert.equal(graph.stats.files, 4);
    assert.equal(await readFile(join(root, 'src', 'page.tsx'), 'utf8'), `import { Widget } from './features/barrel';\nimport type { WidgetProps } from '@/components/widget';\nimport { thing } from './missing';\nimport os from 'node:os';\nexport function Page(p: WidgetProps) { return Widget(); }\nconst lazy = () => import('./components/widget');\nconst unsure = (name: string) => import(name);\n`);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-02 tsconfig extends outside root is never loaded and coverage is partial', async () => {
  const { parent, root } = await fixture();
  try {
    await writeFile(join(parent, 'external-tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '/tmp/private' } }));
    await writeFile(join(root, 'tsconfig.json'), '{ "extends": "../external-tsconfig.json" }');
    const graph = await buildGraph(root, 'fixture');
    assert.equal(graph.coverage.tsconfig, 'partial');
    assert.ok(graph.issues.some(issue => issue.code === 'TSCONFIG_EXTENDS_UNAVAILABLE'));
    assert.ok(graph.edges.some(e => e.specifier === '@/components/widget' && e.resolution === 'external'));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-02 refuses symlinked sources and never indexes excluded files', async () => {
  const { parent, root } = await fixture();
  try {
    await writeFile(join(parent, 'outside.ts'), 'export const privateKey = "secret"');
    try { await symlink(join(parent, 'outside.ts'), join(root, 'src', 'linked.ts')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
    const graph = await buildGraph(root, 'fixture');
    assert.ok(!graph.nodes.some(n => n.path.endsWith('linked.ts')));
    assert.ok(!JSON.stringify(graph).includes('privateKey'));
    assert.deepEqual(validateGraph(graph), graph);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CI-02 reports malformed source syntax without inventing validity', async () => {
  const { parent, root } = await fixture();
  try {
    await writeFile(join(root, 'src', 'broken.ts'), 'export const bad = (\n');
    const graph = await buildGraph(root, 'fixture');
    assert.ok(graph.issues.some(issue => issue.path === 'src/broken.ts' && /^TS\d+$/.test(issue.code)));
    assert.equal(graph.coverage.analyzedFiles, 5);
    assert.deepEqual(validateGraph(graph), graph);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
