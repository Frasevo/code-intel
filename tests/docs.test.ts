import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildDocTrace, validateDocTrace, referencesFrom, referencesTo } from '../src/docs.ts';
import { main } from '../src/cli.ts';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'frasevo-docs04-'));
  const root = join(dir, 'sample project');
  await mkdir(root, { recursive: true });
  async function add(path: string, content: string) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await add('src/lib/items.ts', 'export const items = [1, 2];\n');
  await add('src/app/api/items/route.ts', 'export function GET() { return Response.json({ ok: true }); }\n');
  await add('README.md', [
    '# Getting Started',
    '## Usage',
    '## Usage',
    '[code](src/lib/items.ts) [api](/api/items) [guide](docs/guide.md#examples)',
    '[broken](docs/absent.md) [external](https://example.com/?secret=TOP_SECRET)',
    '[jump](#usage-1) [notheading](#missing-heading)',
    '[ref link][implementation]',
    '[implementation]: src/lib/items.ts',
    '![not a doc link](docs/absent.md)',
    '`[not a real link](docs/absent.md)`',
    '```md',
    '[not a link](docs/absent.md)',
    '```',
  ].join('\n'));
  await add('docs/guide.md', '# Examples\n[home](../README.md#getting-started)\n');
  return { dir, root, add };
}

test('CI-04 resolves code, docs, anchors, API routes and references, not external URLs', async () => {
  const f = await fixture();
  try {
    const trace = await buildDocTrace(f.root, 'fixture');
    assert.equal(trace.schemaVersion, 'doc-trace/v1');
    assert.equal(trace.stats.documents, 2);
    assert.deepEqual(trace.documents.find(d => d.path === 'README.md')?.headings.map(h => h.slug), ['getting-started', 'usage', 'usage-1']);
    const refs = referencesFrom(trace, 'README.md');
    assert.equal(refs.length, 8);
    assert.equal(refs.filter(r => r.status === 'resolved').length, 5);
    assert.equal(refs.filter(r => r.status === 'unknown').length, 2);
    assert.equal(refs.filter(r => r.status === 'external').length, 1);
    assert.equal(refs.find(r => r.kind === 'api')?.target, '/api/items');
    assert.equal(refs.find(r => r.target === 'docs/guide.md')?.status, 'resolved');
    assert.equal(refs.find(r => r.fragment === 'missing-heading')?.status, 'unknown');
    assert.equal(refs.find(r => r.syntax === 'reference-link')?.target, 'src/lib/items.ts');
    assert.equal(referencesTo(trace, 'src/lib/items.ts').length, 2);
    assert.equal(referencesTo(trace, '/api/items').length, 1);
    assert.ok(!JSON.stringify(trace).includes('TOP_SECRET'));
    assert.deepEqual(validateDocTrace(trace), trace);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('CI-04 unknown and unsafe targets are not invented or escalated to resolved', async () => {
  const f = await fixture();
  try {
    await f.add('docs/security.md', [
      '# Security',
      '[excluded](../src/secret/credentials.ts)',
      '[traversal](../../outside.md)',
      '[bad absolute](/etc/passwd)',
      '[dangerous](javascript:alert(1))',
      '[missing api](/api/does-not-exist)',
      '[encoded traversal](%2e%2e/%2e%2e/outside.md)',
      '[cross to code anchor](../src/lib/items.ts#somefunction)',
    ].join('\n'));
    const result = await buildDocTrace(f.root, 'fixture');
    const refs = referencesFrom(result, 'docs/security.md');
    assert.equal(refs.length, 7);
    assert.equal(refs.filter(r => r.status === 'resolved').length, 0);
    assert.equal(refs.filter(r => r.status === 'external').length, 1);
    assert.ok(refs.every(r => r.target === null || !r.target.includes('outside.md')));
    assert.equal(refs.find(r => r.target === 'src/lib/items.ts')?.status, 'unknown');
    assert.deepEqual(validateDocTrace(result), result);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('CI-04 versioned fingerprints are deterministic; tampering is rejected', async () => {
  const f = await fixture();
  try {
    const a = await buildDocTrace(f.root, 'fixture');
    const b = await buildDocTrace(f.root, 'fixture');
    assert.equal(a.artifactId, b.artifactId);
    assert.deepEqual(a.references, b.references);
    assert.throws(() => validateDocTrace({ ...a, schemaVersion: 'doc-trace/v2' }), /Unsupported/);
    assert.throws(() => validateDocTrace({ ...a, stats: { ...a.stats, resolved: 1234 } }), /statistics/);
    const altered = structuredClone(a);
    altered.references[0]!.status = 'external';
    assert.throws(() => validateDocTrace(altered), /Inconsistent|fingerprint/);
    await f.add('docs/guide.md', '# Changed\n');
    const c = await buildDocTrace(f.root, 'fixture');
    assert.notEqual(a.artifactId, c.artifactId);
    assert.notEqual(a.sources.includedFilesHash, c.sources.includedFilesHash);
    assert.equal(referencesFrom(c, 'README.md').find(r => r.target === 'docs/guide.md')?.status, 'unknown');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('CI-04 CLI writes outside scanned tree; standalone validation and indexed queries work', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => main(['docs', f.root, '--out', join(f.root, 'index.json'), '--repo-id', 'fixture']), /outside/);
    const out = join(f.dir, 'docs.json');
    await main(['docs', f.root, '--out', out, '--repo-id', 'fixture']);
    await main(['docs-validate', out]);
    await main(['docs-file', out, '--path', 'README.md']);
    await main(['docs-target', out, '--path', '/api/items']);
    assert.equal(validateDocTrace(JSON.parse(await readFile(out, 'utf8'))).stats.documents, 2);
    await assert.rejects(() => main(['docs', f.root, '--out', out, '--out', out]), /Usage/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

