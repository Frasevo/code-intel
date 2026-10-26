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
import { serveMcpStdio } from '../src/mcp.ts';
import type { ContextIndexes } from '../src/context.ts';

async function fixture(): Promise<{ base: string; repo: string; indexes: ContextIndexes }> {
  const base = await mkdtemp(join(tmpdir(), 'frasevo-ci06b-'));
  const repo = join(base, 'repo');
  try {
    for (const [path, contents] of Object.entries({
      'src/data.ts': 'export function publicItems() { return [1, 2, 3]; }\n',
      'README.md': '# Test\nSee [items](src/data.ts).\n',
    })) {
      const file = join(repo, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    const [snapshot, graph, api, docs] = await Promise.all([
      scanRepository(repo, 'ci06b-fixture'), buildGraph(repo, 'ci06b-fixture'),
      buildApiCatalog(repo, 'ci06b-fixture'), buildDocTrace(repo, 'ci06b-fixture'),
    ]);
    return { base, repo, indexes: { snapshot, graph, api, docs } };
  } catch (e) { await rm(base, { recursive: true, force: true }); throw e; }
}

type Reply = { id?: number | string | null; result?: Record<string, any>; error?: { code: number; message: string } };
const request = (id: number, method: string, params?: unknown): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`;
const hello = request(1, 'initialize', {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
});
const acknowledged = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`;

async function exchange(repo: string, indexes: ContextIndexes, allowEvidence: boolean, messages: string): Promise<Reply[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let stdout = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => { stdout += chunk; });
  const server = serveMcpStdio(repo, indexes, allowEvidence, input, output);
  input.end(messages);
  await server;
  return stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Reply);
}

test('CI-06B legacy MCP handshake, read-only tools, explicit evidence permission', async () => {
  const f = await fixture();
  try {
    const messages = request(0, 'tools/list') + hello + acknowledged +
      request(2, 'tools/list') +
      request(3, 'tools/call', { name: 'frasevo_context_select', arguments: { keyword: 'publicItems' } }) +
      request(4, 'tools/call', { name: 'frasevo_context_evidence', arguments: { keyword: 'publicItems' } }) +
      request(5, 'ping');
    const replies = await exchange(f.repo, f.indexes, false, messages);
    assert.deepEqual(replies.map(r => r.id), [0, 1, 2, 3, 4, 5]);
    assert.equal(replies[0]!.error!.code, -32000);
    assert.equal(replies[1]!.result!.protocolVersion, '2025-11-25');
    assert.deepEqual(replies[2]!.result!.tools.map((t: any) => t.name), ['frasevo_context_select']);
    const selection = JSON.parse(replies[3]!.result!.content[0].text);
    assert.equal(selection.mode, 'selection');
    assert.equal(selection.schemaVersion, 'context-query/v1');
    assert.equal(selection.sensitivity, 'private');
    assert.equal(replies[4]!.error!.code, -32602);
    assert.deepEqual(replies[5]!.result, {});
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('CI-06B authorized excerpts are verified; modified source never returns indexed text', async () => {
  const f = await fixture();
  try {
    const params = { name: 'frasevo_context_evidence', arguments: { keyword: 'publicItems', maxLines: 1 } };
    const messages = hello + acknowledged + request(2, 'tools/list') + request(3, 'tools/call', params);
    const replies = await exchange(f.repo, f.indexes, true, messages);
    assert.deepEqual(replies[1]!.result!.tools.map((t: any) => t.name),
      ['frasevo_context_select', 'frasevo_context_evidence']);
    const pack = JSON.parse(replies[2]!.result!.content[0].text).result;
    assert.ok(pack.records.some((r: any) => r.status === 'indexed' && r.excerpt?.text.includes('publicItems')));
    await writeFile(join(f.repo, 'src/data.ts'), 'export function publicItems() { return [9, 9, 9]; }\n');
    const after = await exchange(f.repo, f.indexes, true, hello + acknowledged + request(3, 'tools/call', params));
    const stale = JSON.parse(after[1]!.result!.content[0].text).result;
    assert.ok(stale.records.some((r: any) => r.status === 'unknown' && r.reason === 'source-unavailable'));
    assert.ok(!JSON.stringify(stale.records).includes('9, 9, 9'));
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('CI-06B rejects arbitrary paths, unknown arguments, malformed messages and unsupported methods', async () => {
  const f = await fixture();
  try {
    const messages = '{invalid-json}\n' + hello + acknowledged +
      request(2, 'tools/call', { name: 'frasevo_context_select', arguments: { path: '../private.key' } }) +
      request(3, 'tools/call', { name: 'frasevo_context_select', arguments: { keyword: 'items', root: '/tmp' } }) +
      request(4, 'tools/call', { name: 'frasevo_context_evidence', arguments: { keyword: 'items', maxLines: 999 } }) +
      request(5, 'resources/read', { uri: 'file:///etc/passwd' }) +
      request(6, 'tools/call', { name: 'frasevo_context_select', arguments: { keyword: 'items' } });
    const replies = await exchange(f.repo, f.indexes, true, messages);
    assert.equal(replies[0]!.error!.code, -32700);
    for (const r of replies.slice(2, 5)) {
      assert.equal(r.result!.isError, true);
      assert.ok(!JSON.stringify(r).includes('/tmp'));
    }
    assert.equal(replies[5]!.error!.code, -32601);
    assert.equal(replies[6]!.result!.isError, false);
    const big = await exchange(f.repo, f.indexes, false, hello + acknowledged + (' '.repeat(33_000) + '\n'));
    assert.equal(big.at(-1)!.error!.code, -32600);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
