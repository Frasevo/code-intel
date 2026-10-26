import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { buildGraph, verifiedRead, type Graph, type GraphEdge } from './graph.ts';
import { permittedPath } from './policy.ts';
import { scanRepository } from './scanner.ts';
import { isSha256, sha256, VERSION } from './snapshot.ts';

export const API_SCHEMA = 'api-catalog/v1';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type Method = typeof METHODS[number];
const MAX_ROUTES = 10_000;
const MAX_MODULES = 10_000;
const MAX_REEXPORT_DEPTH = 32;
const MAX_ISSUES = 20_000;
const ROUTE_FILE = /^(?:src\/)?app\/api(?:\/.*)?\/route\.(?:ts|js)$/;
const AUTH_NAMES = new Set(['auth', 'getAuth', 'requireAuth', 'requireSession', 'getServerSession', 'currentUser', 'verifySession', 'authGuard']);
const allowedMethod = (value: string): value is Method => METHODS.some(method => method === value);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

type Location = { path: string; line: number; column: number };
type Origin = { status: 'resolved' | 'unknown'; location: Location | null };
type ExportRecord = { name: string; declaration: Location; origin: Origin; typeOnly: boolean };
type ApiIssue = Location & { code: string };
export type ApiMethod = {
  method: Method;
  declaredAt: Location;
  handlerOrigin: Origin;
  evidence: { declared: 'source-export'; tested: 'not-checked'; observed: 'not-checked' };
  authentication: { status: 'unknown'; staticSignals: Array<Location & { name: string }> };
  requestSchema: 'unknown'; responseSchema: 'unknown'; rateLimit: 'unknown';
};
export type ApiRoute = {
  path: string; source: string; sourceSha256: string;
  dynamicSegments: Array<{ name: string; kind: 'parameter' | 'catch-all' | 'optional-catch-all' }>;
  methods: ApiMethod[];
  dependencies: Array<{ specifier: string; path: string | null; status: 'resolved' | 'external' | 'unknown'; relation: 'import' | 'reexport'; typeOnly: boolean; line: number; column: number }>;
};
export type ApiCatalog = {
  schemaVersion: 'api-catalog/v1'; producerVersion: string; artifactId: string;
  repoId: string; capturedAt: string; sensitivity: 'private';
  sourceGraph: { artifactId: string; snapshotArtifactId: string; includedFilesHash: string; commitSha: string | null; dirty: boolean | null };
  coverage: { scope: 'app-api-routes-only'; execution: 'not-performed'; routeFiles: number; unresolvedMethods: number };
  routes: ApiRoute[]; issues: ApiIssue[];
  stats: { routes: number; methods: number; unresolvedMethods: number };
};

const position = (sf: ts.SourceFile, node: ts.Node): Location => {
  const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { path: sf.fileName, line: pos.line + 1, column: pos.character + 1 };
};
const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === kind);
const isTypeOnlyStatement = (statement: ts.Statement): boolean => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
const isSourceFile = (path: string): boolean => /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(path);
const sourceKind = (path: string): ts.ScriptKind => /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs|jsx)$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
const canonical = (value: Omit<ApiCatalog, 'artifactId' | 'capturedAt'>): string => `sha256:${sha256(JSON.stringify(value))}`;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function routePath(filePath: string): Pick<ApiRoute, 'path' | 'dynamicSegments'> | null {
  if (!ROUTE_FILE.test(filePath)) return null;
  const segments = filePath.replace(/^(?:src\/)?app\//, '').replace(/\/route\.[^.]+$/, '').split('/');
  const visible: string[] = [];
  const dynamicSegments: ApiRoute['dynamicSegments'] = [];
  for (const segment of segments) {
    if (/^\(.*\)$/.test(segment)) continue; // route group, not part of public URL
    if (segment.startsWith('@') || segment.startsWith('(') || segment.startsWith(')')) return null; // unsupported slot/interception syntax
    const optional = /^\[\[\.\.\.([^/\]]+)\]\]$/.exec(segment);
    const catchAll = /^\[\.\.\.([^/\]]+)\]$/.exec(segment);
    const dynamic = /^\[([^/\]]+)\]$/.exec(segment);
    if (optional) dynamicSegments.push({ name: optional[1]!, kind: 'optional-catch-all' });
    else if (catchAll) dynamicSegments.push({ name: catchAll[1]!, kind: 'catch-all' });
    else if (dynamic) dynamicSegments.push({ name: dynamic[1]!, kind: 'parameter' });
    else if (segment.includes('[') || segment.includes(']')) return null;
    visible.push(segment);
  }
  return { path: `/${visible.join('/')}`, dynamicSegments };
}

type ModuleData = { source: ts.SourceFile; exports: Array<ExportRecord & { indirect?: { specifier: string; imported: string; via: Location } }>;
  wildcard: Array<{ specifier: string; via: Location }>; imports: Map<string, { specifier: string; imported: string; via: Location }> };

function parseModule(path: string, source: string): ModuleData {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, sourceKind(path));
  const declarations = new Map<string, { declaration: Location; typeOnly: boolean }>();
  const imports = new Map<string, { specifier: string; imported: string; via: Location }>();
  const exports: ModuleData['exports'] = [];
  const wildcard: ModuleData['wildcard'] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      if (stmt.name) declarations.set(stmt.name.text, { declaration: position(sf, stmt), typeOnly: isTypeOnlyStatement(stmt) });
    } else if (ts.isVariableStatement(stmt)) {
      for (const item of stmt.declarationList.declarations) if (ts.isIdentifier(item.name)) {
        declarations.set(item.name.text, { declaration: position(sf, item), typeOnly: false });
      }
    } else if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) && stmt.importClause) {
      const specifier = stmt.moduleSpecifier.text;
      const via = position(sf, stmt);
      if (stmt.importClause.name) imports.set(stmt.importClause.name.text, { specifier, imported: 'default', via });
      const bindings = stmt.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) {
        if (!el.isTypeOnly && !stmt.importClause.isTypeOnly) imports.set(el.name.text, { specifier, imported: (el.propertyName ?? el.name).text, via });
      }
    }
  }
  const add = (name: string, declared: Location, typeOnly: boolean, indirect?: ModuleData['exports'][number]['indirect']): void => {
    exports.push({ name, declaration: declared, typeOnly, origin: { status: indirect ? 'unknown' : 'resolved', location: indirect ? null : declared }, ...(indirect ? { indirect } : {}) });
  };
  for (const stmt of sf.statements) {
    if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(stmt)) {
        for (const item of stmt.declarationList.declarations) {
          if (ts.isIdentifier(item.name)) add(item.name.text, position(sf, item), false);
        }
      } else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
        if (stmt.name) add(stmt.name.text, position(sf, stmt), isTypeOnlyStatement(stmt));
      }
    }
    if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
      const specifier = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) for (const element of stmt.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const name = element.name.text;
        const imported = (element.propertyName ?? element.name).text;
        const via = position(sf, stmt);
        const local = declarations.get(imported);
        const importedBinding = imports.get(imported);
        if (specifier) add(name, via, false, { specifier, imported, via });
        else if (local) add(name, via, local.typeOnly, undefined), exports[exports.length - 1]!.origin = { status: 'resolved', location: local.declaration };
        else if (importedBinding) add(name, via, false, importedBinding);
        else add(name, via, false, { specifier: '', imported, via });
      } else if (specifier && !stmt.exportClause) wildcard.push({ specifier, via: position(sf, stmt) });
    }
  }
  return { source: sf, exports, wildcard, imports };
}

function matchingGraphEdge(graph: Graph, path: string, via: Location, specifier: string): GraphEdge | undefined {
  return graph.edges.find(e => e.from === `file:${path}` && e.specifier === specifier && e.line === via.line && e.column === via.column &&
    (e.relation === 'import' || e.relation === 'reexport'));
}

function authSignals(source: ts.SourceFile, location: Location): ApiMethod['authentication']['staticSignals'] {
  // Names are untrusted hints, not proofs of authorization. Restrict to a single top-level handler body.
  const declaration = source.statements.find(s => {
    const from = source.getLineAndCharacterOfPosition(s.getStart(source)).line + 1;
    const to = source.getLineAndCharacterOfPosition(s.getEnd()).line + 1;
    return from <= location.line && location.line <= to &&
      (ts.isFunctionDeclaration(s) || ts.isVariableStatement(s) || ts.isExportDeclaration(s));
  });
  if (!declaration || ts.isExportDeclaration(declaration)) return [];
  const signals: ApiMethod['authentication']['staticSignals'] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && AUTH_NAMES.has(node.expression.text)) {
      signals.push({ ...position(source, node.expression), name: node.expression.text });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration, visit);
  return signals.sort((a, b) => a.line - b.line || a.column - b.column);
}

export async function buildApiCatalog(repoArg: string, repoId?: string): Promise<ApiCatalog> {
  const root = await realpath(resolve(repoArg));
  const graph = await buildGraph(root, repoId);
  const snapshot = await scanRepository(root, repoId);
  if (snapshot.artifactId !== graph.sourceSnapshot.artifactId) throw new Error('Repository changed while building API catalog');
  const entries = new Map(snapshot.files.map(f => [f.path, f]));
  const graphPaths = new Set(graph.nodes.filter(n => n.kind === 'file').map(n => n.path));
  const routeFiles = snapshot.files.map(f => f.path).filter(path => ROUTE_FILE.test(path));
  if (routeFiles.length > MAX_ROUTES) throw new Error('Too many API routes');
  const cache = new Map<string, ModuleData>();
  const issues: ApiIssue[] = [];
  const report = (location: Location, code: string): void => {
    if (issues.length >= MAX_ISSUES) throw new Error('Too many API catalog issues');
    issues.push({ ...location, code });
  };
  const load = async (path: string): Promise<ModuleData | null> => {
    if (cache.has(path)) return cache.get(path)!;
    const file = entries.get(path);
    if (!file || !graphPaths.has(path) || !isSourceFile(path) || !permittedPath(path)) return null;
    if (cache.size >= MAX_MODULES) throw new Error('Too many dependency files for API catalog');
    const body = await verifiedRead(root, path, file.sha256, file.sizeBytes);
    const data = parseModule(path, body);
    cache.set(path, data);
    return data;
  };
  // Preserve origin while following named and star exports. Each recursion is bounded and never reads outside the scanned inventory.
  const exportsOf = async (path: string, ancestors: Set<string>): Promise<ExportRecord[]> => {
    const module = await load(path);
    if (!module) return [];
    if (ancestors.size >= MAX_REEXPORT_DEPTH || ancestors.has(path)) {
      report({ path, line: 1, column: 1 }, 'REEXPORT_CYCLE_OR_DEPTH');
      return [];
    }
    const next = new Set(ancestors); next.add(path);
    const explicit: ExportRecord[] = [];
    for (const item of module.exports) {
      if (!item.indirect) { explicit.push(item); continue; }
      const { specifier, imported, via } = item.indirect;
      const edge = matchingGraphEdge(graph, path, via, specifier);
      if (!edge?.to || edge.resolution !== 'resolved') {
        report(via, 'UNRESOLVED_HANDLER_REEXPORT');
        explicit.push({ ...item, origin: { status: 'unknown', location: null } });
        continue;
      }
      const targetPath = edge.to.slice('file:'.length);
      const candidates = (await exportsOf(targetPath, next)).filter(e => e.name === imported);
      if (candidates.length !== 1 || candidates[0]!.origin.status !== 'resolved' || candidates[0]!.typeOnly) {
        report(via, 'UNRESOLVED_HANDLER_REEXPORT');
        explicit.push({ ...item, origin: { status: 'unknown', location: null } });
      } else explicit.push({ ...item, origin: candidates[0]!.origin });
    }
    const explicitNames = new Set(explicit.map(e => e.name));
    const stars = new Map<string, Array<{ record: ExportRecord; via: Location }>>();
    for (const item of module.wildcard) {
      const edge = matchingGraphEdge(graph, path, item.via, item.specifier);
      if (!edge?.to || edge.resolution !== 'resolved') {
        report(item.via, 'UNRESOLVED_WILDCARD_REEXPORT');
        continue;
      }
      const upstream = (await exportsOf(edge.to.slice('file:'.length), next)).filter(e => e.name !== 'default' && !e.typeOnly);
      for (const entry of upstream) {
        if (explicitNames.has(entry.name)) continue;
        stars.set(entry.name, [...(stars.get(entry.name) ?? []), { record: entry, via: item.via }]);
      }
    }
    for (const [name, candidates] of stars) {
      if (candidates.length > 1) {
        report({ path, line: 1, column: 1 }, 'AMBIGUOUS_WILDCARD_REEXPORT');
        continue;
      }
      explicit.push({ ...candidates[0]!.record, declaration: candidates[0]!.via });
    }
    return explicit;
  };
  const routes: ApiRoute[] = [];
  for (const source of routeFiles) {
    const parsed = routePath(source);
    if (!parsed) {
      report({ path: source, line: 1, column: 1 }, 'UNSUPPORTED_ROUTE_SEGMENT');
      continue;
    }
    const file = entries.get(source)!;
    const data = await load(source);
    if (!data) throw new Error(`Scanned route unavailable: ${source}`);
    const hasParseError = graph.issues.some(i => i.path === source && /^TS\d+$/.test(i.code));
    if (hasParseError) report({ path: source, line: 1, column: 1 }, 'SOURCE_PARSE_ERROR');
    const results = hasParseError ? [] : await exportsOf(source, new Set());
    const methods: ApiMethod[] = [];
    for (const record of results) {
      if (!allowedMethod(record.name) || record.typeOnly) continue;
      if (methods.some(m => m.method === record.name)) {
        report(record.declaration, 'DUPLICATE_METHOD_EXPORT');
        continue;
      }
      const originModule = record.origin.location ? await load(record.origin.location.path) : null;
      methods.push({ method: record.name, declaredAt: record.declaration, handlerOrigin: record.origin,
        evidence: { declared: 'source-export', tested: 'not-checked', observed: 'not-checked' },
        authentication: { status: 'unknown', staticSignals: originModule && record.origin.location ? authSignals(originModule.source, record.origin.location) : [] },
        requestSchema: 'unknown', responseSchema: 'unknown', rateLimit: 'unknown' });
    }
    methods.sort((a, b) => METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
    const dependencies = graph.edges.filter(e => e.from === `file:${source}` && (e.relation === 'import' || e.relation === 'reexport'))
      .map(e => ({ specifier: e.specifier ?? '', path: e.to?.startsWith('file:') ? e.to.slice(5) : null,
        status: e.resolution === 'declared' ? 'unknown' as const : e.resolution,
        relation: e.relation as 'import' | 'reexport', typeOnly: e.typeOnly, line: e.line, column: e.column }));
    dependencies.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
    routes.push({ path: parsed.path, source, sourceSha256: file.sha256, dynamicSegments: parsed.dynamicSegments, methods, dependencies });
  }
  routes.sort((a, b) => compare(a.path, b.path) || compare(a.source, b.source));
  for (let i = 1; i < routes.length; i++) if (routes[i]!.path === routes[i - 1]!.path) {
    report({ path: routes[i]!.source, line: 1, column: 1 }, 'COLLIDING_ROUTE_PATH');
  }
  issues.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const unresolved = routes.reduce((n, r) => n + r.methods.filter(m => m.handlerOrigin.status === 'unknown').length, 0);
  const base: Omit<ApiCatalog, 'artifactId' | 'capturedAt'> = {
    schemaVersion: API_SCHEMA, producerVersion: VERSION, repoId: snapshot.repoId, sensitivity: 'private',
    sourceGraph: { artifactId: graph.artifactId, snapshotArtifactId: snapshot.artifactId,
      includedFilesHash: snapshot.provenance.includedFilesHash, commitSha: snapshot.provenance.commitSha, dirty: snapshot.provenance.dirty },
    coverage: { scope: 'app-api-routes-only', execution: 'not-performed', routeFiles: routeFiles.length, unresolvedMethods: unresolved },
    routes, issues, stats: { routes: routes.length, methods: routes.reduce((n, r) => n + r.methods.length, 0), unresolvedMethods: unresolved },
  };
  return { ...base, artifactId: canonical(base), capturedAt: new Date().toISOString() };
}

function validLocation(value: unknown): value is Location {
  return object(value) && typeof value.path === 'string' && permittedPath(value.path) &&
    Number.isSafeInteger(value.line) && (value.line as number) > 0 && Number.isSafeInteger(value.column) && (value.column as number) > 0;
}

export function validateApiCatalog(value: unknown): ApiCatalog {
  if (!object(value) || value.schemaVersion !== API_SCHEMA) throw new Error('Unsupported API catalog schemaVersion');
  const c = value as ApiCatalog;
  if (typeof c.producerVersion !== 'string' || !c.producerVersion || typeof c.repoId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(c.repoId) || c.sensitivity !== 'private' ||
    typeof c.capturedAt !== 'string' || !Number.isFinite(Date.parse(c.capturedAt)) ||
    !object(c.sourceGraph) || !/^sha256:[a-f0-9]{64}$/.test(c.sourceGraph.artifactId) ||
    !/^sha256:[a-f0-9]{64}$/.test(c.sourceGraph.snapshotArtifactId) || !isSha256(c.sourceGraph.includedFilesHash) ||
    !(c.sourceGraph.commitSha === null || typeof c.sourceGraph.commitSha === 'string' && /^[a-f0-9]{40}$/.test(c.sourceGraph.commitSha)) ||
    !(c.sourceGraph.dirty === null || typeof c.sourceGraph.dirty === 'boolean')) throw new Error('Invalid API metadata');
  if (!object(c.coverage) || c.coverage.scope !== 'app-api-routes-only' || c.coverage.execution !== 'not-performed' ||
    !Number.isSafeInteger(c.coverage.routeFiles) || c.coverage.routeFiles < 0 ||
    !Number.isSafeInteger(c.coverage.unresolvedMethods) || c.coverage.unresolvedMethods < 0 ||
    !Array.isArray(c.routes) || c.routes.length > MAX_ROUTES || !Array.isArray(c.issues) || c.issues.length > MAX_ISSUES) throw new Error('Invalid API coverage');
  const seen = new Set<string>();
  let methodCount = 0, unresolved = 0;
  for (const route of c.routes) {
    if (!object(route) || typeof route.source !== 'string' || !ROUTE_FILE.test(route.source) ||
      !isSha256(route.sourceSha256) || !Array.isArray(route.dynamicSegments) ||
      !Array.isArray(route.methods) || route.methods.length > METHODS.length || !Array.isArray(route.dependencies) || route.dependencies.length > 100_000) throw new Error('Invalid API route');
    const expected = routePath(route.source);
    if (!expected || expected.path !== route.path || JSON.stringify(expected.dynamicSegments) !== JSON.stringify(route.dynamicSegments) || seen.has(route.source)) throw new Error('Inconsistent API route path');
    seen.add(route.source);
    const methodsSeen = new Set<string>();
    for (const method of route.methods) {
      if (!object(method) || !allowedMethod(method.method) || methodsSeen.has(method.method) || !validLocation(method.declaredAt) ||
        !object(method.handlerOrigin) || !['resolved', 'unknown'].includes(method.handlerOrigin.status) ||
        !(method.handlerOrigin.location === null || validLocation(method.handlerOrigin.location)) ||
        (method.handlerOrigin.status === 'resolved') !== (method.handlerOrigin.location !== null) ||
        !object(method.evidence) || method.evidence.declared !== 'source-export' || method.evidence.tested !== 'not-checked' || method.evidence.observed !== 'not-checked' ||
        !object(method.authentication) || method.authentication.status !== 'unknown' || !Array.isArray(method.authentication.staticSignals) ||
        method.authentication.staticSignals.length > 10_000 || !method.authentication.staticSignals.every(s => validLocation(s) && typeof s.name === 'string' && AUTH_NAMES.has(s.name)) ||
        method.requestSchema !== 'unknown' || method.responseSchema !== 'unknown' || method.rateLimit !== 'unknown') throw new Error('Invalid API method evidence');
      methodsSeen.add(method.method); methodCount++;
      if (method.handlerOrigin.status === 'unknown') unresolved++;
      if (method.declaredAt.path !== route.source) throw new Error('Method declaration not in route');
    }
    for (const dep of route.dependencies) if (!object(dep) || typeof dep.specifier !== 'string' || dep.specifier.length > 2048 ||
      !['resolved', 'external', 'unknown'].includes(dep.status) || !['import', 'reexport'].includes(dep.relation) || typeof dep.typeOnly !== 'boolean' ||
      !(dep.path === null || typeof dep.path === 'string' && permittedPath(dep.path)) ||
      (dep.status === 'resolved') !== (dep.path !== null) ||
      !Number.isSafeInteger(dep.line) || dep.line < 1 || !Number.isSafeInteger(dep.column) || dep.column < 1) throw new Error('Invalid API dependency');
  }
  for (const issue of c.issues) if (!validLocation(issue) || typeof issue.code !== 'string' || !/^[A-Z_]{1,80}$/.test(issue.code)) throw new Error('Invalid API issue');
  if (!object(c.stats) || c.stats.routes !== c.routes.length || c.stats.methods !== methodCount || c.stats.unresolvedMethods !== unresolved ||
    c.coverage.unresolvedMethods !== unresolved || c.coverage.routeFiles < c.routes.length) throw new Error('Invalid API statistics');
  const { artifactId, capturedAt, ...base } = c;
  if (artifactId !== canonical(base)) throw new Error('API catalog content fingerprint mismatch');
  return c;
}

export function findApiRoute(catalog: ApiCatalog, path: string): ApiRoute[] {
  if (!path.startsWith('/')) throw new Error('API path must start with /');
  return catalog.routes.filter(route => route.path === path);
}
