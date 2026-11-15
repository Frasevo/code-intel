import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { selectContext, type ContextIndexes } from './context.ts';
import { callMcpTool, isAuthorizedMcpTool, listMcpTools } from './mcp-tools.ts';

/**
 * Limited MCP 2026-07-28 stdio transport. The CLI opts into this protocol
 * explicitly; the legacy 2025 adapter remains unchanged. This is not the
 * official SDK v2, and real-client interoperability is still unverified.
 */
const PROTOCOL = '2026-07-28';
const SERVER = { name: 'frasevo-code-intel', version: '0.6.2' };
const SERVER_META = { 'io.modelcontextprotocol/serverInfo': SERVER };
const MAX_REQUEST_BYTES = 32_768;

type JsonRecord = Record<string, unknown>;
type RpcId = string | number | null;
const object = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: JsonRecord, key: string): boolean => Object.hasOwn(value, key);
const validId = (value: unknown): value is string | number =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));

function requestMetadata(params: JsonRecord): { version: string | null; valid: boolean } {
  if (!object(params._meta)) return { version: null, valid: false };
  const meta = params._meta;
  const version = meta['io.modelcontextprotocol/protocolVersion'];
  if (typeof version !== 'string' || version.length < 1 || version.length > 80 ||
      /[\x00-\x1f\x7f]/.test(version)) {
    return { version: null, valid: false };
  }
  const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
  if (!object(capabilities)) return { version, valid: false };
  const info = meta['io.modelcontextprotocol/clientInfo'];
  if (info !== undefined && (!object(info) || typeof info.name !== 'string' ||
      !info.name.trim() || typeof info.version !== 'string' || !info.version.trim())) {
    return { version, valid: false };
  }
  return { version, valid: true };
}

/**
 * Each modern request is independently validated and answered; no handshake
 * or cross-request client authority. The process owner alone chooses the
 * repository, indexes and whether evidence reads are permitted.
 */
export async function serveModernMcpStdio(
  root: string, indexes: ContextIndexes, allowEvidence: boolean,
  input: Readable = process.stdin, output: Writable = process.stdout,
): Promise<void> {
  // Validate all four coherent indexes before exposing any tools.
  selectContext(indexes, { keyword: 'frasevo' });
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const send = (payload: JsonRecord): void => { output.write(`${JSON.stringify(payload)}\n`); };
  const error = (id: RpcId, code: number, message: string, data?: JsonRecord): void => {
    send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
  };
  const complete = (id: string | number, data: JsonRecord): void => {
    send({ jsonrpc: '2.0', id, result: {
      resultType: 'complete', ...data, _meta: SERVER_META,
    } });
  };

  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) {
        error(null, -32600, 'Request too large');
        continue;
      }
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch { error(null, -32700, 'Parse error'); continue; }
      if (!object(raw) || raw.jsonrpc !== '2.0' || typeof raw.method !== 'string') {
        error(null, -32600, 'Invalid Request'); continue;
      }
      const hasId = own(raw, 'id');
      if (hasId && !validId(raw.id)) {
        error(null, -32600, 'Invalid Request'); continue;
      }
      // Modern notifications have no response or authority to invoke tools.
      if (!hasId) continue;
      const id = raw.id as string | number;
      if (!object(raw.params)) {
        error(id, -32602, 'Invalid request parameters'); continue;
      }
      const params = raw.params;
      const metadata = requestMetadata(params);
      if (!metadata.version) {
        error(id, -32602, 'Missing or invalid MCP request metadata'); continue;
      }
      if (metadata.version !== PROTOCOL) {
        error(id, -32022, 'Unsupported protocol version', {
          supported: [PROTOCOL], requested: metadata.version,
        });
        continue;
      }
      if (!metadata.valid) {
        error(id, -32602, 'Invalid MCP client capabilities or identity'); continue;
      }

      if (raw.method === 'server/discover') {
        if (Object.keys(params).some(key => key !== '_meta')) {
          error(id, -32602, 'Invalid discovery parameters'); continue;
        }
        complete(id, {
          supportedVersions: [PROTOCOL],
          capabilities: { tools: {} },
          instructions: 'Private read-only indexes; source excerpts require an operator opt-in. No runtime or security proof.',
        });
      } else if (raw.method === 'ping') {
        if (Object.keys(params).some(key => key !== '_meta')) {
          error(id, -32602, 'Invalid ping parameters'); continue;
        }
        complete(id, {});
      } else if (raw.method === 'tools/list') {
        if (Object.keys(params).some(key => key !== '_meta')) {
          error(id, -32602, 'Invalid tool list parameters'); continue;
        }
        complete(id, { tools: listMcpTools(allowEvidence) });
      } else if (raw.method === 'tools/call') {
        if (typeof params.name !== 'string' ||
            Object.keys(params).some(key => key !== '_meta' && key !== 'name' && key !== 'arguments')) {
          error(id, -32602, 'Invalid tool call'); continue;
        }
        if (!isAuthorizedMcpTool(params.name, allowEvidence)) {
          error(id, -32602, 'Unknown or unauthorized tool'); continue;
        }
        const result = await callMcpTool(root, indexes, allowEvidence, params.name, params.arguments);
        complete(id, result);
      } else {
        error(id, -32601, 'Method not found');
      }
    }
  } finally { lines.close(); }
}
