import { sha256, isSha256, VERSION } from './snapshot.ts';
import { permittedPath } from './policy.ts';
import type { ContextIndexes, ContextSelection } from './context.ts';
import type { EvidencePack } from './evidence.ts';

/** CI-05C stable wire envelope. A fingerprint detects changes, NOT forged source claims. */
export const CONTEXT_SCHEMA = 'context-query/v1';
type Envelope = {
  schemaVersion: typeof CONTEXT_SCHEMA;
  producerVersion: string;
  repoId: string;
  artifactId: string;
  sensitivity: 'private';
};
export type ContextArtifact = Envelope & (
  { mode: 'selection'; result: ContextSelection } |
  { mode: 'evidence'; result: EvidencePack }
);

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []): boolean =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const string = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length <= max;
const text = (v: unknown, max = 8192): v is string => string(v, max) && v.length > 0;
const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const location = (v: unknown): v is number | null => v === null || integer(v, 1, 100_000_000);
const file = (v: unknown): v is string => text(v, 2048) && permittedPath(v);
const enumOf = (v: unknown, choices: string[]): boolean => choices.includes(v as string);
const id = (v: unknown): boolean => string(v, 71) && /^sha256:[a-f0-9]{64}$/.test(v);
const sourceKinds = ['code-snapshot/v1', 'code-graph/v1', 'api-catalog/v1', 'doc-trace/v1'];
const validQueryPath = (path: string): boolean => !path || permittedPath(path) || (path.startsWith('/api/') &&
  !/[\\?#%\x00-\x1f\x7f]/.test(path) && !path.includes('//') &&
  path.split('/').every(segment => segment !== '.' && segment !== '..'));

function query(v: unknown): boolean {
  return object(v) && keys(v, ['path', 'keyword', 'depth', 'maxResults', 'maxBytes']) &&
    string(v.path, 2048) && validQueryPath(v.path) && string(v.keyword, 100) &&
    (!v.keyword || (v.keyword.trim().length >= 2 && !/[\x00-\x1f\x7f]/.test(v.keyword))) &&
    (v.path.length > 0 || v.keyword.length > 0) &&
    integer(v.depth, 0, 2) && integer(v.maxResults, 1, 50) && integer(v.maxBytes, 2048, 65536);
}
function sources(v: unknown): v is Record<'snapshot'|'graph'|'api'|'docs', string> {
  return object(v) && keys(v, ['snapshot','graph','api','docs']) && Object.values(v).every(id);
}
function hit(v: unknown, sourceIds: string[]): boolean {
  if (!object(v) || !keys(v, ['kind','path','label','match','evidence'], ['relation']) ||
      !enumOf(v.kind, ['file','symbol','route','heading','relation']) || !file(v.path) ||
      !text(v.label) || !enumOf(v.match, ['exact-path','path','keyword','relation']) || !object(v.evidence)) return false;
  const e = v.evidence;
  if (!keys(e, ['schemaVersion','artifactId','ref','sourcePath','line','column']) ||
      !enumOf(e.schemaVersion, sourceKinds) ||
      e.artifactId !== sourceIds[sourceKinds.indexOf(e.schemaVersion as string)] ||
      !text(e.ref) || !file(e.sourcePath) || !location(e.line) || !location(e.column)) return false;
  if (v.kind === 'relation') {
    return v.match === 'relation' && object(v.relation) && keys(v.relation, ['from','kind','depth']) &&
      file(v.relation.from) && text(v.relation.kind) && integer(v.relation.depth, 1, 2);
  }
  return !Object.hasOwn(v, 'relation');
}
function excerpt(v: unknown): boolean {
  if (!object(v) || !keys(v, ['sourcePath','startLine','endLine','startColumn','text','truncated'])) return false;
  return file(v.sourcePath) && integer(v.startLine, 1, 100_000_000) &&
    integer(v.endLine, v.startLine as number, 100_000_000) &&
    integer(v.startColumn, 1, 100_000_000) && string(v.text, 2048 + 12 * 2) &&
    typeof v.truncated === 'boolean';
}
function resultValid(result: unknown, mode: ContextArtifact['mode']): boolean {
  if (!object(result) || !keys(result,
    mode === 'selection' ? ['status','query','sources','hits','truncated'] :
      ['sensitivity','coverage','status','query','sources','records','truncated'])) return false;
  if (!enumOf(result.status, ['matched','no-match']) || !query(result.query) ||
      !sources(result.sources) || typeof result.truncated !== 'boolean') return false;
  if (mode === 'evidence' && (result.sensitivity !== 'private' || result.coverage !== 'included-indexes-only')) return false;
  const values = mode === 'selection' ? result.hits : result.records;
  if (!Array.isArray(values) || values.length > 50 ||
      (result.status === 'no-match' && values.length !== 0) ||
      (result.status === 'matched' && values.length === 0 && !result.truncated)) return false;
  const sourceIds = Object.values(result.sources);
  return values.every((item: unknown) => {
    if (mode === 'selection') return hit(item, sourceIds);
    if (!object(item) || !keys(item, ['hit','status','verification','reason','expectedSha256','excerpt']) ||
        !hit(item.hit, sourceIds) || !enumOf(item.status, ['indexed','unknown','not-checked']) ||
        !enumOf(item.verification, ['sha256-verified','failed','not-checked']) ||
        !(item.reason === null || enumOf(item.reason, ['no-location','missing-source','read-budget','source-unavailable','invalid-location'])) ||
        !(item.expectedSha256 === null || isSha256(item.expectedSha256)) ||
        !(item.excerpt === null || excerpt(item.excerpt))) return false;
    if (item.status === 'indexed') return item.verification === 'sha256-verified' &&
      item.reason === null && item.expectedSha256 !== null && object(item.excerpt) &&
      item.excerpt.sourcePath === ((item.hit as Record<string, unknown>).evidence as Record<string, unknown>).sourcePath;
    return item.excerpt === null && item.reason !== null;
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function checksum(body: Omit<ContextArtifact, 'artifactId'>): string {
  return `sha256:${sha256(JSON.stringify(canonical(body)))}`;
}

export function createContextArtifact(
  indexes: ContextIndexes, mode: 'selection', result: ContextSelection,
): ContextArtifact & { mode: 'selection' };
export function createContextArtifact(
  indexes: ContextIndexes, mode: 'evidence', result: EvidencePack,
): ContextArtifact & { mode: 'evidence' };
export function createContextArtifact(
  indexes: ContextIndexes, mode: ContextArtifact['mode'], result: ContextSelection | EvidencePack,
): ContextArtifact {
  const body = { schemaVersion: CONTEXT_SCHEMA as typeof CONTEXT_SCHEMA, producerVersion: VERSION,
    repoId: indexes.snapshot.repoId, sensitivity: 'private' as const, mode, result };
  return validateContextArtifact({ ...body, artifactId: checksum(body) });
}

/** Structural + deterministic integrity checks; cannot certify repository freshness. */
export function validateContextArtifact(value: unknown): ContextArtifact {
  if (!object(value) || !keys(value, ['schemaVersion','producerVersion','repoId','artifactId','sensitivity','mode','result']) ||
      value.schemaVersion !== CONTEXT_SCHEMA || !text(value.producerVersion, 64) ||
      !string(value.repoId, 128) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.repoId) ||
      value.sensitivity !== 'private' || !enumOf(value.mode, ['selection','evidence']) ||
      !id(value.artifactId) || !resultValid(value.result, value.mode as ContextArtifact['mode'])) {
    throw new Error('Invalid context-query/v1 artifact');
  }
  const body = { schemaVersion: value.schemaVersion, producerVersion: value.producerVersion,
    repoId: value.repoId, sensitivity: value.sensitivity, mode: value.mode, result: value.result };
  if (Buffer.byteLength(JSON.stringify(value.result), 'utf8') > 70_000 || value.artifactId !== checksum(body as Omit<ContextArtifact, 'artifactId'>)) {
    throw new Error('Context artifact fingerprint mismatch or oversized result');
  }
  return value as ContextArtifact;
}
