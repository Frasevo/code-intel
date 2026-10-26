import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildApiCatalog, validateApiCatalog, findApiRoute } from '../src/api-registry.ts';
import { main } from '../src/cli.ts';

type Fixture = { parent: string; root: string; add: (path: string, content: string) => Promise<void> };
async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'frasevo-api03-'));
  const root = join(parent, 'next with spaces');
  await mkdir(root, { recursive: true });
  const add = async (path: string, content: string): Promise<void> => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  await add('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
  await add('src/lib/items.ts', 'export const check = () => true;\n');
  await add('src/app/api/items/[id]/route.ts', [
    "import { check } from '@/lib/items';",
    'export async function GET() { if (check()) requireAuth(); return Response.json({ ok: true }); }',
    'export const POST = async () => Response.json({ created: true });',
    'export type PATCH = { method: string };',
    'const hidden = () => 1;',
  ].join('\n'));
  await add('src/app/api/(internal)/orders/[...slug]/route.ts', 'export const DELETE = () => null;\n');
  await add('src/app/api/optional/[[...args]]/route.ts', 'export function OPTIONS() {}\n');
  await add('src/app/pages/not-api/route.ts', 'export function GET() {}\n');
  await add('src/app/api/items/[id]/fake.ts', 'export function PUT() {}\n');
  await add('src/app/api/private/token.ts', 'export const GET = () => process.env.KEY;\n');
  return { parent, root, add };
}

test('CI-03 discovers Next routes, dynamic segments, HTTP exports, dependencies and auth hints', async () => {
  const f = await fixture();
  try {
    const catalog = await buildApiCatalog(f.root, 'fixture');
    assert.equal(catalog.schemaVersion, 'api-catalog/v1');
    assert.equal(catalog.stats.routes, 3);
    assert.equal(catalog.stats.methods, 4);
    const items = findApiRoute(catalog, '/api/items/[id]');
    assert.equal(items.length, 1);
    assert.deepEqual(items[0]!.methods.map(m => m.method), ['GET', 'POST']);
    assert.equal(items[0]!.dynamicSegments[0]!.name, 'id');
    assert.equal(items[0]!.dynamicSegments[0]!.kind, 'parameter');
    assert.ok(items[0]!.dependencies.some(d => d.specifier === '@/lib/items' && d.path === 'src/lib/items.ts' && d.status === 'resolved'));
    assert.equal(items[0]!.methods[0]!.authentication.status, 'unknown');
    assert.ok(items[0]!.methods[0]!.authentication.staticSignals.some(s => s.name === 'requireAuth'));
    assert.equal(items[0]!.methods[0]!.evidence.tested, 'not-checked');
    assert.equal(items[0]!.methods[0]!.evidence.observed, 'not-checked');
    assert.equal(items[0]!.methods[0]!.rateLimit, 'unknown');
    assert.deepEqual(findApiRoute(catalog, '/api/orders/[...slug]')[0]!.dynamicSegments, [{ name: 'slug', kind: 'catch-all' }]);
    assert.deepEqual(findApiRoute(catalog, '/api/optional/[[...args]]')[0]!.dynamicSegments, [{ name: 'args', kind: 'optional-catch-all' }]);
    assert.deepEqual(validateApiCatalog(catalog), catalog);
    assert.ok(!JSON.stringify(catalog).includes('process.env.KEY'));
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('CI-03 traces named, alias and wildcard reexports without executing modules', async () => {
  const f = await fixture();
  try {
    await f.add('src/lib/handlers.ts', 'export async function list() {}\nexport function DELETE() {}\nexport function PATCH() {}\n');
    await f.add('src/app/api/alpha/route.ts', "export { list as GET, DELETE } from '../../../lib/handlers';\n");
    await f.add('src/app/api/beta/route.ts', "import { list as handler } from '../../../lib/handlers';\nexport { handler as GET };\n");
    await f.add('src/app/api/gamma/route.ts', "export * from '../../../lib/handlers';\n");
    const c = await buildApiCatalog(f.root, 'fixture');
    for (const path of ['/api/alpha', '/api/beta']) {
      const method = findApiRoute(c, path)[0]!.methods.find(m => m.method === 'GET')!;
      assert.equal(method.handlerOrigin.status, 'resolved');
      assert.equal(method.handlerOrigin.location?.path, 'src/lib/handlers.ts');
    }
    assert.deepEqual(findApiRoute(c, '/api/alpha')[0]!.methods.map(m => m.method), ['GET', 'DELETE']);
    assert.deepEqual(findApiRoute(c, '/api/gamma')[0]!.methods.map(m => m.method), ['PATCH', 'DELETE']);
    assert.deepEqual(validateApiCatalog(c), c);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('CI-03 unresolved reexports are marked unknown, not fabricated, and cycles are bounded', async () => {
  const f = await fixture();
  try {
    await f.add('src/app/api/missing/route.ts', "export { get as GET } from './does-not-exist';\n");
    await f.add('src/app/api/cycle/route.ts', "export * from './a';\n");
    await f.add('src/app/api/cycle/a.ts', "export * from './b';\n");
    await f.add('src/app/api/cycle/b.ts', "export * from './a';\n");
    const c = await buildApiCatalog(f.root, 'fixture');
    const m = findApiRoute(c, '/api/missing')[0]!.methods[0]!;
    assert.equal(m.method, 'GET');
    assert.equal(m.handlerOrigin.status, 'unknown');
    assert.equal(m.handlerOrigin.location, null);
    assert.ok(c.issues.some(i => i.code === 'UNRESOLVED_HANDLER_REEXPORT'));
    assert.ok(c.issues.some(i => i.code === 'REEXPORT_CYCLE_OR_DEPTH'));
    assert.equal(c.stats.unresolvedMethods, 1);
    assert.equal(findApiRoute(c, '/api/cycle')[0]!.methods.length, 0);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('CI-03 finds route collisions and unsupported intercepting segment without guessing', async () => {
  const f = await fixture();
  try {
    await f.add('src/app/api/(group)/items/[id]/route.ts', 'export function GET() {}\n');
    await f.add('src/app/api/(.)intercept/route.ts', 'export function GET() {}\n');
    const c = await buildApiCatalog(f.root, 'fixture');
    assert.equal(findApiRoute(c, '/api/items/[id]').length, 2);
    assert.ok(c.issues.some(i => i.code === 'COLLIDING_ROUTE_PATH'));
    assert.ok(c.issues.some(i => i.code === 'UNSUPPORTED_ROUTE_SEGMENT'));
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('CI-03 deterministic content fingerprint; metadata changes never create false verification', async () => {
  const f = await fixture();
  try {
    const a = await buildApiCatalog(f.root, 'fixture');
    const b = await buildApiCatalog(f.root, 'fixture');
    assert.equal(a.artifactId, b.artifactId);
    assert.deepEqual(a.routes, b.routes);
    assert.throws(() => validateApiCatalog({ ...a, schemaVersion: 'api-catalog/v2' }), /Unsupported/);
    assert.throws(() => validateApiCatalog({ ...a, routes: [] }), /statistics|fingerprint/i);
    const altered = structuredClone(a);
    altered.routes[0]!.methods[0]!.evidence.observed = 'not-checked';
    altered.routes[0]!.methods[0]!.authentication.status = 'verified' as 'unknown';
    assert.throws(() => validateApiCatalog(altered), /evidence/i);
    await f.add('src/app/api/items/[id]/route.ts', 'export function PATCH() {}\n');
    const next = await buildApiCatalog(f.root, 'fixture');
    assert.notEqual(a.artifactId, next.artifactId);
    assert.notEqual(a.sourceGraph.includedFilesHash, next.sourceGraph.includedFilesHash);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('CI-03 CLI output stays outside the input repository and can be queried offline', async () => {
  const f = await fixture();
  try {
    const bad = join(f.root, 'api-catalog.json');
    await assert.rejects(() => main(['api', f.root, '--out', bad]), /outside/);
    const out = join(f.parent, 'catalog.json');
    await main(['api', f.root, '--out', out, '--repo-id', 'fixture']);
    await main(['api-validate', out]);
    await main(['api-route', out, '--path', '/api/items/[id]']);
    const parsed = validateApiCatalog(JSON.parse(await readFile(out, 'utf8')));
    assert.equal(parsed.stats.routes, 3);
    await assert.rejects(() => main(['api', f.root, '--out', out, '--out', out]), /Usage/);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('CI-03 refuses excluded and linked source content in API catalog', async () => {
  const f = await fixture();
  try {
    await f.add('src/app/api/deps/route.ts', "export { POST } from '../../../secret/credentials';\n");
    await f.add('src/secret/credentials.ts', 'export function POST() { return "sensitive"; }');
    await f.add('src/app/api/hidden/secrets/route.ts', 'export function POST() {}');
    const linked = join(f.root, 'src/app/api/linked');
    const external = join(f.parent, 'external');
    await mkdir(external);
    await writeFile(join(external, 'route.ts'), 'export function DELETE() { return "leak"; }');
    try { await symlink(external, linked, 'dir'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e; }
    const catalog = await buildApiCatalog(f.root, 'fixture');
    assert.ok(!JSON.stringify(catalog).includes('sensitive'));
    assert.ok(!JSON.stringify(catalog).includes('leak'));
    assert.ok(!catalog.routes.some(r => r.path.includes('hidden') || r.path.includes('linked')));
    assert.equal(findApiRoute(catalog, '/api/deps')[0]!.methods[0]!.handlerOrigin.status, 'unknown');
    assert.deepEqual(validateApiCatalog(catalog), catalog);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});

test('CI-03 reports malformed route source and ignores non-Next route.tsx convention', async () => {
  const f = await fixture();
  try {
    await f.add('src/app/api/broken/route.ts', 'export function GET( {\n');
    await f.add('src/app/api/not-next/route.tsx', 'export function POST() { return null; }');
    const c = await buildApiCatalog(f.root, 'fixture');
    const broken = findApiRoute(c, '/api/broken')[0]!;
    assert.deepEqual(broken.methods, []);
    assert.ok(c.issues.some(i => i.code === 'SOURCE_PARSE_ERROR' && i.path === 'src/app/api/broken/route.ts'));
    assert.deepEqual(findApiRoute(c, '/api/not-next'), []);
    assert.deepEqual(validateApiCatalog(c), c);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});
