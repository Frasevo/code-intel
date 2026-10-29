import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(args: string[], expectedStatus = 0): string {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, expectedStatus,
    `CLI ${args[0]} exited ${result.status}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

test('CI-06V2 standalone CLI round-trip on an independent repository with spaces in its path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'frasevo-cli-e2e-'));
  const repo = join(base, 'independent project with spaces');
  const source = 'export function listItems() { return [1, 2, 3]; }\n';
  try {
    for (const [path, content] of Object.entries({
      'src/items.ts': source,
      'src/app/api/items/route.ts':
        "import { listItems } from '../../../items.js';\nexport function GET() { return Response.json(listItems()); }\n",
      'README.md': '# Items\n[implementation](src/items.ts)\n[endpoint](/api/items)\n',
    })) {
      const target = join(repo, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    const repoId = 'independent-cli-e2e';
    const indexes = ['snapshot', 'graph', 'api', 'docs'] as const;
    for (const [index, command] of [
      ['snapshot', 'scan'], ['graph', 'graph'], ['api', 'api'], ['docs', 'docs'],
    ] as const) {
      run([command, repo, '--repo-id', repoId, '--out', join(base, `${index}.json`)]);
    }
    const flags = indexes.flatMap(index => [`--${index}`, join(base, `${index}.json`)]);

    const references = JSON.parse(run(['docs-target', join(base, 'docs.json'),
      '--path', 'src/items.ts'])) as Array<{ from: string; status: string }>;
    assert.ok(references.some(ref => ref.from === 'README.md' && ref.status === 'resolved'));

    const selected = join(base, 'selection.json');
    const evidence = join(base, 'evidence.json');
    run(['context-select', repo, ...flags, '--keyword', 'listItems', '--out', selected]);
    run(['context-evidence', repo, ...flags, '--keyword', 'listItems', '--out', evidence]);
    run(['context-validate', selected]);
    run(['context-validate', evidence]);

    const selection = JSON.parse(await readFile(selected, 'utf8'));
    const pack = JSON.parse(await readFile(evidence, 'utf8'));
    assert.equal(selection.schemaVersion, 'context-query/v1');
    assert.equal(selection.mode, 'selection');
    assert.equal(selection.result.status, 'matched');
    assert.ok(selection.result.hits.some((hit: { path: string }) => hit.path === 'src/items.ts'));
    assert.equal(pack.schemaVersion, 'context-query/v1');
    assert.equal(pack.mode, 'evidence');
    assert.ok(pack.result.records.some((record: { status: string; excerpt?: { text: string } }) =>
      record.status === 'indexed' && record.excerpt?.text.includes('listItems')));
    assert.ok(!JSON.stringify(pack).includes(repo), 'Artifact must not reveal absolute source root');

    run(['context-select', repo, ...flags, '--keyword', 'listItems',
      '--out', join(repo, 'forbidden-output.json')], 1);
    await assert.rejects(readFile(join(repo, 'forbidden-output.json'), 'utf8'),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
    assert.equal(await readFile(join(repo, 'src/items.ts'), 'utf8'), source);
  } finally {
    await rm(base, { force: true, recursive: true });
  }
});
