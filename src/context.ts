import { permittedPath } from './policy.ts';
import { validateSnapshot, type Snapshot } from './snapshot.ts';
import { validateGraph, type Graph } from './graph.ts';
import { validateApiCatalog, type ApiCatalog } from './api-registry.ts';
import { validateDocTrace, type DocTrace } from './docs.ts';

/** CI-05A: deterministic selection over EXISTING indexes; never reads the source tree. */
export type ContextIndexes = { snapshot: Snapshot; graph: Graph; api: ApiCatalog; docs: DocTrace };
export type ContextQuery = { path?: string; keyword?: string; depth?: 0 | 1 | 2; maxResults?: number; maxBytes?: number };
export type ContextHit = {
  kind: 'file' | 'symbol' | 'route' | 'heading' | 'relation';
  path: string;
  label: string;
  match: 'exact-path' | 'path' | 'keyword' | 'relation';
  evidence: { schemaVersion: Snapshot['schemaVersion'] | Graph['schemaVersion'] | ApiCatalog['schemaVersion'] | DocTrace['schemaVersion'];
    artifactId: string; ref: string; sourcePath: string; line: number | null; column: number | null };
  relation?: { from: string; kind: string; depth: number };
};
export type ContextSelection = {
  status: 'matched' | 'no-match';
  query: Required<ContextQuery>;
  sources: { snapshot: string; graph: string; api: string; docs: string };
  hits: ContextHit[];
  truncated: boolean;
  // Bounded JSON output. This is a preview for CI-05B/C, not a versioned public artifact.
};

const MAX_CANDIDATES = 5_000;
const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const normalize = (s: string): string => s.normalize('NFKC').toLocaleLowerCase('en-US');
const score = (hit: ContextHit): number => ({ 'exact-path': 0, path: 1, keyword: 2, relation: 3 })[hit.match];
const hitSort = (a: ContextHit, b: ContextHit): number => score(a) - score(b) ||
  cmp(a.path, b.path) || cmp(a.kind, b.kind) || cmp(a.label, b.label) ||
  (a.evidence.line ?? 0) - (b.evidence.line ?? 0) || cmp(a.evidence.ref, b.evidence.ref);

function readQuery(input: ContextQuery): Required<ContextQuery> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid context query');
  const { path, keyword, depth = 0, maxResults = 20, maxBytes = 16_384 } = input;
  if (path === undefined && keyword === undefined) throw new Error('Specify path or keyword');
  const apiPath = typeof path === 'string' && path.startsWith('/api/') &&
    !/[\\?#%\x00-\x1f\x7f]/.test(path) && !path.includes('//') &&
    path.split('/').every(segment => segment !== '.' && segment !== '..');
  if (path !== undefined && (typeof path !== 'string' || path.length > 2048 ||
      !(permittedPath(path) || apiPath))) {
    throw new Error('Invalid or excluded query path');
  }
  if (keyword !== undefined && (typeof keyword !== 'string' || keyword.trim().length < 2 ||
      keyword.length > 100 || /[\x00-\x1f\x7f]/.test(keyword))) throw new Error('Invalid query keyword');
  if (!Number.isInteger(depth) || depth < 0 || depth > 2 ||
      !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50 ||
      !Number.isInteger(maxBytes) || maxBytes < 2_048 || maxBytes > 65_536) throw new Error('Invalid context limits');
  return { path: path ?? '', keyword: keyword?.trim() ?? '', depth, maxResults, maxBytes };
}

function validateIndexes(indexes: ContextIndexes): void {
  const { snapshot, graph, api, docs } = indexes;
  validateSnapshot(snapshot); validateGraph(graph); validateApiCatalog(api); validateDocTrace(docs);
  const fp = snapshot.provenance.includedFilesHash;
  if (new Set([snapshot.repoId, graph.repoId, api.repoId, docs.repoId]).size !== 1 ||
      graph.sourceSnapshot.artifactId !== snapshot.artifactId ||
      graph.sourceSnapshot.includedFilesHash !== fp ||
      api.sourceGraph.snapshotArtifactId !== snapshot.artifactId ||
      api.sourceGraph.artifactId !== graph.artifactId ||
      api.sourceGraph.includedFilesHash !== fp ||
      docs.sources.snapshotArtifactId !== snapshot.artifactId ||
      docs.sources.graphArtifactId !== graph.artifactId ||
      docs.sources.apiArtifactId !== api.artifactId ||
      docs.sources.includedFilesHash !== fp ||
      graph.sourceSnapshot.commitSha !== snapshot.provenance.commitSha ||
      graph.sourceSnapshot.dirty !== snapshot.provenance.dirty ||
      api.sourceGraph.commitSha !== snapshot.provenance.commitSha ||
      api.sourceGraph.dirty !== snapshot.provenance.dirty ||
      docs.sources.commitSha !== snapshot.provenance.commitSha ||
      docs.sources.dirty !== snapshot.provenance.dirty) throw new Error('Incompatible context indexes');
  const files = new Map(snapshot.files.map(f => [f.path, f.sha256]));
  for (const node of graph.nodes) if (node.kind === 'file' && files.get(node.path) !== node.sha256 || node.kind === 'symbol' && !files.has(node.path)) throw new Error('Graph path not in snapshot');
  for (const route of api.routes) if (files.get(route.source) !== route.sourceSha256) throw new Error('API path not in snapshot');
  for (const doc of docs.documents) if (files.get(doc.path) !== doc.sha256) throw new Error('Document path not in snapshot');
  const routePaths = new Set(api.routes.map(r => r.path));
  for (const ref of docs.references) {
    if (ref.status === 'resolved' && ref.kind === 'file' && !files.has(ref.target!)) throw new Error('Document target not in snapshot');
    if (ref.status === 'resolved' && ref.kind === 'api' && !routePaths.has(ref.target!)) throw new Error('Document route not in catalog');
  }
}

export function selectContext(indexes: ContextIndexes, rawQuery: ContextQuery): ContextSelection {
  const query = readQuery(rawQuery);
  validateIndexes(indexes);
  const { snapshot, graph, api, docs } = indexes;
  const sources = { snapshot: snapshot.artifactId, graph: graph.artifactId, api: api.artifactId, docs: docs.artifactId };
  const filePaths = new Set(snapshot.files.map(f => f.path));
  const candidates: ContextHit[] = [];
  const unique = new Set<string>();
  let truncated = false;
  const add = (hit: ContextHit): void => {
    const key = `${hit.kind}\0${hit.path}\0${hit.label}\0${hit.evidence.ref}\0${hit.evidence.line ?? ''}`;
    if (unique.has(key)) return;
    if (candidates.length === MAX_CANDIDATES) { truncated = true; return; }
    unique.add(key); candidates.push(hit);
  };
  const match = (value: string, isPath: boolean): ContextHit['match'] | null => {
    if (query.path && isPath && value === query.path) return 'exact-path';
    if (query.path && isPath && value.includes(query.path)) return 'path';
    if (query.keyword && normalize(value).includes(normalize(query.keyword))) return 'keyword';
    return null;
  };
  const evidence = (schemaVersion: ContextHit['evidence']['schemaVersion'], artifactId: string,
    ref: string, sourcePath: string, line: number | null = null, column: number | null = null): ContextHit['evidence'] =>
    ({ schemaVersion, artifactId, ref, sourcePath, line, column });

  for (const file of snapshot.files) {
    const m = match(file.path, true);
    if (m) add({ kind: 'file', path: file.path, label: file.path, match: m,
      evidence: evidence(snapshot.schemaVersion, snapshot.artifactId, file.path, file.path) });
  }
  for (const node of graph.nodes) if (node.kind === 'symbol') {
    const m = match(node.path, true) ?? match(node.name, false);
    if (m) add({ kind: 'symbol', path: node.path, label: node.name, match: m,
      evidence: evidence(graph.schemaVersion, graph.artifactId, node.id, node.path, node.line, node.column) });
  }
  for (const route of api.routes) {
    const m = match(route.path, true) ?? match(route.source, true);
    if (m) add({ kind: 'route', path: route.source, label: route.path, match: m,
      evidence: evidence(api.schemaVersion, api.artifactId, route.path, route.source) });
  }
  for (const doc of docs.documents) for (const heading of doc.headings) {
    const m = match(doc.path, true) ?? match(heading.slug, false);
    if (m) add({ kind: 'heading', path: doc.path, label: heading.slug, match: m,
      evidence: evidence(docs.schemaVersion, docs.artifactId, `${doc.path}#${heading.slug}`, doc.path, heading.line, 1) });
  }

  if (query.depth > 0 && query.path) {
    const route = api.routes.find(r => r.path === query.path);
    const seed = route?.source ?? query.path;
    if (filePaths.has(seed)) {
      const seen = new Set([seed]);
      let frontier = new Set([seed]);
      for (let step = 1; step <= query.depth && frontier.size; step++) {
        const next = new Set<string>();
        // Graph already includes explicit reverse-consumer edges. Only resolved file-to-file edges count.
        for (const edge of graph.edges) {
          if (!edge.from.startsWith('file:') || !frontier.has(edge.from.slice(5)) ||
              !edge.to?.startsWith('file:') || edge.resolution !== 'resolved') continue;
          const target = edge.to.slice(5);
          if (!filePaths.has(target) || seen.has(target)) continue;
          seen.add(target); next.add(target);
          add({ kind: 'relation', path: target, label: edge.relation, match: 'relation',
            evidence: evidence(graph.schemaVersion, graph.artifactId,
              `${edge.from}->${edge.to}:${edge.relation}`,
              edge.relation === 'consumer' ? edge.to.slice(5) : edge.from.slice(5), edge.line, edge.column),
            relation: { from: edge.from.slice(5), kind: edge.relation, depth: step } });
        }
        // Documentation links are a separate type of static relation, not executable dependencies.
        for (const ref of docs.references) {
          if (ref.kind !== 'file' || ref.status !== 'resolved' || !ref.target || !frontier.has(ref.from) || seen.has(ref.target)) continue;
          seen.add(ref.target); next.add(ref.target);
          add({ kind: 'relation', path: ref.target, label: 'documentation-link', match: 'relation',
            evidence: evidence(docs.schemaVersion, docs.artifactId,
              `${ref.from}:${ref.line}:${ref.column}`, ref.from, ref.line, ref.column),
            relation: { from: ref.from, kind: 'documentation-link', depth: step } });
        }
        frontier = next;
      }
    }
  }

  candidates.sort(hitSort);
  const output: ContextSelection = { status: 'no-match', query, sources, hits: [], truncated };
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > query.maxBytes) {
    throw new Error('Context byte limit too small for query metadata');
  }
  for (const item of candidates) {
    if (output.hits.length === query.maxResults) { output.truncated = true; break; }
    output.hits.push(item);
    output.status = 'matched';
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') > query.maxBytes) {
      output.hits.pop(); output.status = output.hits.length ? 'matched' : 'no-match'; output.truncated = true;
      break;
    }
  }
  return output;
}
