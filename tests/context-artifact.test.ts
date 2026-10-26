import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanRepository } from '../src/scanner.ts';
import { buildGraph } from '../src/graph.ts';
import { buildApiCatalog } from '../src/api-registry.ts';
import { buildDocTrace } from '../src/docs.ts';
import { selectContext, type ContextIndexes } from '../src/context.ts';
import { buildEvidencePack } from '../src/evidence.ts';
import { createContextArtifact, validateContextArtifact } from '../src/context-artifact.ts';
import { main } from '../src/cli.ts';

async function fixture(): Promise<{ base: string; repo: string; indexes: ContextIndexes; flags: string[] }> {
  const base = await mkdtemp(join(tmpdir(), 'frasevo-ci05c-'));
  const repo = join(base, 'repo');
  try {
    for (const [path, contents] of Object.entries({
      'src/items.ts': 'export function listItems() { return [1,2,3]; }\n',
      'src/app/api/items/route.ts': "import { listItems } from '../../../items.js';\nexport function GET() { return Response.json(listItems()); }\n",
      'README.md': '# Items\n[items](src/items.ts)\n[API](/api/items)\n',
    })) {
      const file = join(repo, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    const repoId = 'ci05c-fixture';
    const [snapshot, graph, api, docs] = await Promise.all([
      scanRepository(repo, repoId), buildGraph(repo, repoId),
      buildApiCatalog(repo, repoId), buildDocTrace(repo, repoId),
    ]);
    const indexes = { snapshot, graph, api, docs };
    const flags: string[] = [];
    for (const [key, value] of Object.entries(indexes)) {
      const file = join(base, `${key}.json`);
      await writeFile(file, JSON.stringify(value));
      flags.push(`--${key}`, file);
    }
    return { base, repo, indexes, flags };
  } catch (error) { await rm(base, { force: true, recursive: true }); throw error; }
}

test('CI-05C selection and evidence contracts are deterministic and hash-validated', async () => {
  const f = await fixture();
  try {
    const selected = selectContext(f.indexes, { keyword: 'listItems' });
    const a = createContextArtifact(f.indexes, 'selection', selected);
    const b = createContextArtifact(f.indexes, 'selection', selectContext(f.indexes, { keyword: 'listItems' }));
    assert.deepEqual(a, b);
    assert.equal(a.schemaVersion, 'context-query/v1');
    assert.equal(a.sensitivity, 'private');
    assert.ok(a.artifactId.startsWith('sha256:'));
    assert.deepEqual(validateContextArtifact(JSON.parse(JSON.stringify(a))), a);
    const reordered = JSON.parse(JSON.stringify(a));
    reordered.result = { ...Object.fromEntries(Object.entries(reordered.result).reverse()) };
    assert.deepEqual(validateContextArtifact(reordered).result, reordered.result);

    const evid = createContextArtifact(f.indexes, 'evidence',
      await buildEvidencePack(f.repo, f.indexes, { keyword: 'listItems' }));
    assert.equal(validateContextArtifact(evid).mode, 'evidence');
    assert.ok(evid.result.records.some(r => r.status === 'indexed' && r.excerpt?.text.includes('listItems')));
    const tampered = structuredClone(evid);
    const record = tampered.result.records.find(r => r.status === 'indexed');
    assert.ok(record);
    record.excerpt!.text = 'FAKE VERIFIED CONTENT';
    assert.throws(() => validateContextArtifact(tampered), /fingerprint/);
    const malformed = structuredClone(a);
    malformed.result.hits[0]!.evidence.sourcePath = '../secret.ts';
    assert.throws(() => validateContextArtifact(malformed), /Invalid/);
  } finally { await rm(f.base, { force: true, recursive: true }); }
});

test('CI-05C CLI reads existing indexes, writes outside checkout, and validates both modes', async () => {
  const f = await fixture();
  try {
    const selectedPath = join(f.base, 'selection.json');
    const evidencePath = join(f.base, 'evidence.json');
    await main(['context-select', f.repo, ...f.flags, '--path','src/items.ts','--depth','1', '--out', selectedPath]);
    await main(['context-evidence', f.repo, ...f.flags, '--keyword','listItems', '--max-chars','100', '--out', evidencePath]);
    const selection = validateContextArtifact(JSON.parse(await readFile(selectedPath, 'utf8')));
    const evidence = validateContextArtifact(JSON.parse(await readFile(evidencePath, 'utf8')));
    assert.equal(selection.mode, 'selection');
    if (evidence.mode !== 'evidence') assert.fail('Expected evidence mode');
    assert.equal(selection.repoId, f.indexes.snapshot.repoId);
    assert.equal(evidence.repoId, f.indexes.snapshot.repoId);
    assert.ok(evidence.result.records.some(r => r.status === 'indexed'));
    await main(['context-validate', selectedPath]);
    await main(['context-validate', evidencePath]);
    assert.ok(!(await readFile(evidencePath, 'utf8')).includes(f.repo));
  } finally { await rm(f.base, { force: true, recursive: true }); }
});

test('CI-05C CLI rejects adversarial query/flags, incompatible indexes and unsafe destinations', async () => {
  const f = await fixture();
  try {
    const out = join(f.base, 'out.json');
    const common = ['context-select', f.repo, ...f.flags, '--out', out];
    await assert.rejects(main([...common, '--path', '../secret.ts']), /Invalid or excluded/);
    await assert.rejects(main([...common, '--keyword', 'a']), /keyword/);
    await assert.rejects(main([...common, '--keyword','items','--depth','3']), /limits/);
    await assert.rejects(main([...common, '--keyword','items','--max-results','9007199254740993']), /numeric/);
    await assert.rejects(main([...common, '--keyword','items','--depth','1e2']), /numeric/);
    await assert.rejects(main([...common, '--keyword','items','--keyword','again']), /Usage/);
    await assert.rejects(main([...common, '--keyword','items','--unknown','value']), /Usage/);
    await assert.rejects(main(['context-evidence', f.repo, ...f.flags, '--out',out,'--keyword','items','--max-lines','14']), /evidence limit/);
    await assert.rejects(main([...common.slice(0,-2), '--out', join(f.repo, 'leak.json'), '--keyword','items']), /outside/);

    const tamperedApi = structuredClone(f.indexes.api);
    tamperedApi.repoId = 'other';
    await writeFile(join(f.base, 'api.json'), JSON.stringify(tamperedApi));
    await assert.rejects(main([...common, '--keyword','items']), /Incompatible|fingerprint/);
    await writeFile(join(f.base, 'api.json'), JSON.stringify(f.indexes.api));
    await writeFile(out, '{}');
    const link = join(f.base, 'linked.json');
    let linked = false;
    try { await symlink(out, link); linked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
    if (linked) await assert.rejects(main(['context-evidence', f.repo, ...f.flags, '--out', link, '--keyword','items']), /symlink output/);
  } finally { await rm(f.base, { force: true, recursive: true }); }
});
