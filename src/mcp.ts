import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { selectContext, type ContextIndexes, type ContextQuery } from './context.ts';
import { buildEvidencePack, type EvidenceLimits } from './evidence.ts';
import { createContextArtifact } from './context-artifact.ts';

/**
 * Small local MCP 2025-11-25 stdio adapter. All filesystem authority is fixed by the
 * launching user, never supplied by tool-call arguments. No network or code execution.
 * Does not implement the stateless 2026-07-28 protocol; use its legacy fallback.
 */
const PROTOCOL = '2025-11-25';
const VERSION = '0.6.2';
const MAX_REQUEST_BYTES = 32_768;
const QUERY_KEYS = ['path', 'keyword', 'depth', 'maxResults', 'maxBytes'] as const;
const LIMIT_KEYS = ['maxLines', 'maxChars', 'maxSourceFiles', 'maxSourceBytes', 'maxPackBytes'] as const;

type RpcId = string | number | null;
type JsonRecord = Record<string, unknown>;
const object = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: JsonRecord, key: string): boolean => Object.hasOwn(value, key);

function queryArguments(raw: unknown, evidence: boolean): { query: ContextQuery; limits: EvidenceLimits } {
  if (!object(raw)) throw new Error('Invalid tool arguments');
  const permitted = evidence ? [...QUERY_KEYS, ...LIMIT_KEYS] : [...QUERY_KEYS];
  if (Object.keys(raw).some(key => !permitted.includes(key as typeof permitted[number]))) {
    throw new Error('Unknown tool argument');
  }
  const query: ContextQuery = {};
  const limits: EvidenceLimits = {};
  for (const key of QUERY_KEYS) {
    if (own(raw, key)) (query as JsonRecord)[key] = raw[key];
  }
  for (const key of LIMIT_KEYS) {
    if (own(raw, key)) (limits as JsonRecord)[key] = raw[key];
  }
  return { query, limits };
}

const queryProperties = {
  path: { type: 'string', description: 'Repository-relative permitted file path, or /api/ path' },
  keyword: { type: 'string', minLength: 2, maxLength: 100 },
  depth: { type: 'integer', minimum: 0, maximum: 2 },
  maxResults: { type: 'integer', minimum: 1, maximum: 50 },
  maxBytes: { type: 'integer', minimum: 2048, maximum: 65536 },
};
const limitsProperties = {
  maxLines: { type: 'integer', minimum: 1, maximum: 12 },
  maxChars: { type: 'integer', minimum: 80, maximum: 2048 },
  maxSourceFiles: { type: 'integer', minimum: 1, maximum: 20 },
  maxSourceBytes: { type: 'integer', minimum: 1, maximum: 33554432 },
  maxPackBytes: { type: 'integer', minimum: 2048, maximum: 65536 },
};

function tools(allowEvidence: boolean): unknown[] {
  const result: unknown[] = [{
    name: 'frasevo_context_select',
    description: 'Read bounded, previously indexed metadata only. Results are private and may be stale.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: queryProperties,
      anyOf: [{ required: ['path'] }, { required: ['keyword'] }], additionalProperties: false },
  }];
  if (allowEvidence) result.push({
    name: 'frasevo_context_evidence',
    description: 'Read bounded, SHA-256-verified code excerpts from the explicitly allowed local repository. Private data.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: { ...queryProperties, ...limitsProperties },
      anyOf: [{ required: ['path'] }, { required: ['keyword'] }], additionalProperties: false },
  });
  return result;
}

/** Serve a single legacy MCP session over newline-delimited JSON-RPC 2.0. */
export async function serveMcpStdio(
  root: string, indexes: ContextIndexes, allowEvidence: boolean,
  input: Readable = process.stdin, output: Writable = process.stdout,
): Promise<void> {
  // Reject malformed/mismatched indexes before accepting any client message.
  selectContext(indexes, { keyword: 'frasevo' });
  let initialized = false;
  let acknowledged = false;
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const send = (msg: JsonRecord): void => { output.write(`${JSON.stringify(msg)}\n`); };
  const error = (id: RpcId, code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) {
        error(null, -32600, 'Request too large');
        continue;
      }
      let msg: unknown;
      try { msg = JSON.parse(line); }
      catch { error(null, -32700, 'Parse error'); continue; }
      if (!object(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        error(null, -32600, 'Invalid Request'); continue;
      }
      const hasId = own(msg, 'id');
      const id = msg.id;
      if (hasId && (id === null || (typeof id !== 'string' &&
          !(typeof id === 'number' && Number.isSafeInteger(id))))) {
        error(null, -32600, 'Invalid Request'); continue;
      }
      // Notifications never receive a response and have no tool execution authority.
      if (!hasId) {
        if (msg.method === 'notifications/initialized' && initialized) acknowledged = true;
        continue;
      }
      const requestId = id as string | number;
      if (msg.method === 'initialize') {
        if (initialized || !object(msg.params) || typeof msg.params.protocolVersion !== 'string' ||
            !object(msg.params.clientInfo) || !object(msg.params.capabilities)) {
          error(requestId, -32602, 'Invalid initialization'); continue;
        }
        initialized = true;
        send({ jsonrpc: '2.0', id: requestId, result: {
          protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'frasevo-code-intel', version: VERSION },
          instructions: 'Private, read-only, locally indexed context. A result does not prove runtime behavior or source freshness.',
        } });
        continue;
      }
      if (!initialized || !acknowledged) {
        error(requestId, -32000, 'MCP session not initialized'); continue;
      }
      if (msg.method === 'ping') {
        send({ jsonrpc: '2.0', id: requestId, result: {} });
      } else if (msg.method === 'tools/list') {
        if (msg.params !== undefined && (!object(msg.params) || Object.keys(msg.params).length)) {
          error(requestId, -32602, 'Invalid tool list parameters'); continue;
        }
        send({ jsonrpc: '2.0', id: requestId, result: { tools: tools(allowEvidence) } });
      } else if (msg.method === 'tools/call') {
        if (!object(msg.params) || typeof msg.params.name !== 'string' ||
            Object.keys(msg.params).some(k => k !== 'name' && k !== 'arguments')) {
          error(requestId, -32602, 'Invalid tool call'); continue;
        }
        const name = msg.params.name;
        if (name !== 'frasevo_context_select' && !(allowEvidence && name === 'frasevo_context_evidence')) {
          error(requestId, -32602, 'Unknown or unauthorized tool'); continue;
        }
        try {
          const evidence = name === 'frasevo_context_evidence';
          const { query, limits } = queryArguments(msg.params.arguments, evidence);
          const artifact = evidence
            ? createContextArtifact(indexes, 'evidence', await buildEvidencePack(root, indexes, query, limits))
            : createContextArtifact(indexes, 'selection', selectContext(indexes, query));
          send({ jsonrpc: '2.0', id: requestId, result: {
            content: [{ type: 'text', text: JSON.stringify(artifact) }], isError: false,
          } });
        } catch {
          // Tool failures must not disclose local absolute paths, file contents or artifact internals.
          send({ jsonrpc: '2.0', id: requestId, result: {
            content: [{ type: 'text', text: 'Invalid query, limits, or unavailable verified evidence' }], isError: true,
          } });
        }
      } else {
        error(requestId, -32601, 'Method not found');
      }
    }
  } finally { lines.close(); }
}
