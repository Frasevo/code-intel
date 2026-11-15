import { selectContext, type ContextIndexes, type ContextQuery } from './context.ts';
import { buildEvidencePack, type EvidenceLimits } from './evidence.ts';
import { createContextArtifact } from './context-artifact.ts';

/**
 * Transport-independent MCP tool definitions and execution.
 * Filesystem authority (root and coherent indexes) is fixed by the host process.
 * A future MCP SDK transport must use these helpers rather than reimplementing
 * evidence permissions or the fail-closed error boundary.
 */
const QUERY_KEYS = ['path', 'keyword', 'depth', 'maxResults', 'maxBytes'] as const;
const LIMIT_KEYS = ['maxLines', 'maxChars', 'maxSourceFiles', 'maxSourceBytes', 'maxPackBytes'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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

type ToolCallResponse = {
  content: [{ type: 'text'; text: string }];
  isError: boolean;
};

export function isAuthorizedMcpTool(name: string, allowEvidence: boolean): boolean {
  return name === 'frasevo_context_select' ||
    (allowEvidence && name === 'frasevo_context_evidence');
}

/** Only advertise the evidence tool when the operator opted in at process launch. */
export function listMcpTools(allowEvidence: boolean): unknown[] {
  const definitions: unknown[] = [{
    name: 'frasevo_context_select',
    description: 'Read bounded, previously indexed metadata only. Results are private and may be stale.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: queryProperties,
      anyOf: [{ required: ['path'] }, { required: ['keyword'] }], additionalProperties: false },
  }];
  if (allowEvidence) definitions.push({
    name: 'frasevo_context_evidence',
    description: 'Read bounded, SHA-256-verified code excerpts from the explicitly allowed local repository. Private data.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: { ...queryProperties, ...limitsProperties },
      anyOf: [{ required: ['path'] }, { required: ['keyword'] }], additionalProperties: false },
  });
  return definitions;
}

function parseToolArguments(raw: unknown, evidence: boolean): { query: ContextQuery; limits: EvidenceLimits } {
  if (!object(raw)) throw new Error('Invalid tool arguments');
  const permitted: readonly string[] = evidence ? [...QUERY_KEYS, ...LIMIT_KEYS] : QUERY_KEYS;
  if (Object.keys(raw).some(key => !permitted.includes(key))) {
    throw new Error('Unknown tool argument');
  }
  const query: ContextQuery = {};
  const limits: EvidenceLimits = {};
  for (const key of QUERY_KEYS) {
    if (Object.hasOwn(raw, key)) (query as Record<string, unknown>)[key] = raw[key];
  }
  for (const key of LIMIT_KEYS) {
    if (Object.hasOwn(raw, key)) (limits as Record<string, unknown>)[key] = raw[key];
  }
  return { query, limits };
}

/**
 * Never trust the caller's tool name or args. Authorization happens before the
 * guarded query boundary, so protocol adapters can reject unauthorized names
 * as JSON-RPC invalid-params instead of silently calling another tool.
 * Query failures are sanitized: no absolute paths or source content in errors.
 */
export async function callMcpTool(
  root: string, indexes: ContextIndexes, allowEvidence: boolean,
  name: string, rawArguments: unknown,
): Promise<ToolCallResponse> {
  if (!isAuthorizedMcpTool(name, allowEvidence)) throw new Error('Unknown or unauthorized tool');
  try {
    const evidence = name === 'frasevo_context_evidence';
    const { query, limits } = parseToolArguments(rawArguments, evidence);
    const artifact = evidence
      ? createContextArtifact(indexes, 'evidence', await buildEvidencePack(root, indexes, query, limits))
      : createContextArtifact(indexes, 'selection', selectContext(indexes, query));
    return { content: [{ type: 'text', text: JSON.stringify(artifact) }], isError: false };
  } catch {
    return {
      content: [{ type: 'text', text: 'Invalid query, limits, or unavailable verified evidence' }],
      isError: true,
    };
  }
}
