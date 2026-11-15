import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { selectContext, type ContextIndexes } from './context.ts';
import { callMcpTool, isAuthorizedMcpTool, listMcpTools } from './mcp-tools.ts';

/** Legacy MCP stdio adapter; protocol-independent tools live in mcp-tools.ts. */
const PROTOCOL = '2025-11-25';
const VERSION = '0.6.2';
const MAX_REQUEST_BYTES = 32_768;

type RpcId = string | number | null;
type JsonRecord = Record<string, unknown>;
const object = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: JsonRecord, key: string): boolean => Object.hasOwn(value, key);

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
        send({ jsonrpc: '2.0', id: requestId, result: { tools: listMcpTools(allowEvidence) } });
      } else if (msg.method === 'tools/call') {
        if (!object(msg.params) || typeof msg.params.name !== 'string' ||
            Object.keys(msg.params).some(k => k !== 'name' && k !== 'arguments')) {
          error(requestId, -32602, 'Invalid tool call'); continue;
        }
        const name = msg.params.name;
        if (!isAuthorizedMcpTool(name, allowEvidence)) {
          error(requestId, -32602, 'Unknown or unauthorized tool'); continue;
        }
        const result = await callMcpTool(root, indexes, allowEvidence, name, msg.params.arguments);
        send({ jsonrpc: '2.0', id: requestId, result });
      } else {
        error(requestId, -32601, 'Method not found');
      }
    }
  } finally { lines.close(); }
}
