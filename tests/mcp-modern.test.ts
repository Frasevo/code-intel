import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { scanRepository } from '../src/scanner.ts';
import { buildGraph } from '../src/graph.ts';
import { buildApiCatalog } from '../src/api-registry.ts';
import { buildDocTrace } from '../src/docs.ts';
import { serveModernMcpStdio } from '../src/mcp-modern.ts';
import type { ContextIndexes } from '../src/context.ts';

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'synthetic-test', version: '1' },
};
const req = (id: number, method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }) + '\n';

type Reply = {
  id: number | string | null;
  error?: { code: number; message: string; data?: { supported?: string[]; requested?: string } };
  result?: Record<string, any>;
};

async function fixture(): Promise<{ base: string; root: string; indexes: ContextIndexes }> {
  const base = await mkdtemp(join(tmpdir(), 'frasevo-modern-'));
  const root = join(base, 'checkout');
  try {
    const files = {
      'src/items.ts': 'export const visibleItems = [1, 2, 3];\n',
      'README.md': '# Synthetic\nSee [items](src/items.ts).\n',
    };
    for (const [path, data] of Object.entries(files)) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data);
    }
    const [snapshot, graph, api, docs] = await Promise.all([
      scanRepository(root, 'modern-fixture'),
      buildGraph(root, 'modern-fixture'),
      buildApiCatalog(root, 'modern-fixture'),
      buildDocTrace(root, 'modern-fixture'),
    ]);
    return { base, root, indexes: { snapshot, graph, api, docs } };
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error;
  }
}

async function exchange(root: string, indexes: ContextIndexes, allowEvidence: boolean, messages: string): Promise<Reply[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let wire = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => { wire += chunk; });
  const server = serveModernMcpStdio(root, indexes, allowEvidence, stdin, stdout);
  stdin.end(messages);
  await server;
  return wire.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Reply);
}

test('CI-06B2B: modern requests work without initialize; discovery and tool results carry 2026 metadata', async () => {
  const f = await fixture();
  try {
    const output = await exchange(f.root, f.indexes, false,
      req(1, 'server/discover') + req(2, 'tools/list') +
      req(3, 'tools/call', { name: 'frasevo_context_select', arguments: { keyword: 'visibleItems' } }) +
      req(4, 'ping'));
    assert.deepEqual(output.map(item => item.id), [1, 2, 3, 4]);
    for (const item of output) {
      assert.equal(item.result!.resultType, 'complete');
      assert.equal(item.result!._meta['io.modelcontextprotocol/serverInfo'].name, 'frasevo-code-intel');
    }
    assert.deepEqual(output[0]!.result!.supportedVersions, ['2026-07-28']);
    assert.deepEqual(output[1]!.result!.tools.map((tool: any) => tool.name), ['frasevo_context_select']);
    const selected = JSON.parse(output[2]!.result!.content[0].text);
    assert.equal(selected.mode, 'selection');
    assert.equal(selected.sensitivity, 'private');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('CI-06B2B: invalid envelope, unsupported versions and forbidden tools fail closed', async () => {
  const f = await fixture();
  try {
    const unknown = { ...meta, 'io.modelcontextprotocol/protocolVersion': '2027-01-01' };
    const messages = req(1, 'tools/list', { _meta: unknown }) +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n' +
      req(3, 'tools/call', { name: 'frasevo_context_evidence', arguments: { keyword: 'visibleItems' } }) +
      req(4, 'tools/call', { name: 'frasevo_context_select', arguments: { keyword: 'visibleItems', root: '/secrets' } }) +
      req(5, 'resources/read', { uri: 'file:///secret' }) + '{not-json}\n';
    const output = await exchange(f.root, f.indexes, false, messages);
    assert.deepEqual(output.map(item => item.error!.code), [-32022, -32602, -32602, -32602, -32601, -32700]);
    assert.deepEqual(output[0]!.error!.data, { supported: ['2026-07-28'], requested: '2027-01-01' });
    assert.ok(!JSON.stringify(output).includes('/secrets'));
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('CI-06B2B: modern evidence still requires opt-in and checks the current source hash', async () => {
  const f = await fixture();
  try {
    const call = req(1, 'tools/call', {
      name: 'frasevo_context_evidence', arguments: { keyword: 'visibleItems', maxLines: 1 },
    });
    const output = await exchange(f.root, f.indexes, true, call);
    const pack = JSON.parse(output[0]!.result!.content[0].text).result;
    assert.ok(pack.records.some((record: any) => record.status === 'indexed' &&
      record.excerpt?.text.includes('visibleItems')));
    await writeFile(join(f.root, 'src/items.ts'), 'export const visibleItems = [9, 9, 9];\n');
    const after = await exchange(f.root, f.indexes, true, call);
    const stale = JSON.parse(after[0]!.result!.content[0].text).result;
    assert.ok(stale.records.some((record: any) => record.status === 'unknown'));
    assert.ok(!JSON.stringify(stale).includes('9, 9, 9'));
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
