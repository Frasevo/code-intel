import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { normalizedRelativePath, permittedPath } from './policy.ts';
import { scanRepository } from './scanner.ts';
import { sha256, VERSION, type Snapshot } from './snapshot.ts';

export const GRAPH_SCHEMA = 'code-graph/v1';
export type GraphNode =
  | { id: string; kind: 'file'; path: string; sha256: string }
  | { id: string; kind: 'symbol'; path: string; sha256: string; name: string; declaration: string; line: number; column: number; exported: boolean };
type SymbolNode = Extract<GraphNode, { kind: 'symbol' }>;
export type GraphEdge = { from: string; to: string | null; relation: 'import' | 'reexport' | 'dynamic-import' | 'require' | 'export' | 'consumer'; specifier: string | null; symbols: string[]; line: number; column: number; resolution: 'resolved' | 'unknown' | 'external' | 'declared'; typeOnly: boolean };
export type GraphIssue = { path: string; code: string; line: number; column: number };
export type Graph = {
  schemaVersion: 'code-graph/v1'; producerVersion: string; artifactId: string;
  repoId: string; capturedAt: string; sensitivity: 'private';
  sourceSnapshot: { artifactId: string; includedFilesHash: string; commitSha: string | null; dirty: boolean | null };
  coverage: { declarations: 'top-level-only'; modules: 'within-inventory-only'; tsconfig: 'loaded' | 'missing' | 'partial'; sourceFiles: number; analyzedFiles: number };
  nodes: GraphNode[]; edges: GraphEdge[]; issues: GraphIssue[];
  stats: { files: number; symbols: number; edges: number; unresolved: number };
};

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_AST_FILES = 20_000;
const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const HEX = /^[a-f0-9]{64}$/;
const fileId = (path: string): string => `file:${path}`;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const localPath = (root: string, abs: string): string | null => {
  const rel = relative(root, resolve(abs));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return normalizedRelativePath(rel.split(sep).join('/'));
};

export async function verifiedRead(root: string, path: string, hash: string, sizeBytes: number): Promise<string> {
  if (!permittedPath(path) || sizeBytes > MAX_SOURCE_BYTES) throw new Error('Unsafe source read');
  const absolute = resolve(root, path);
  if (localPath(root, absolute) !== path) throw new Error('Path outside inventory');
  // Reject linked parents too, including a Windows junction. The open uses O_NOFOLLOW on POSIX.
  let parent = dirname(absolute);
  while (parent !== root) {
    if ((await lstat(parent)).isSymbolicLink() || !(await stat(parent)).isDirectory()) throw new Error('Linked source parent');
    const next = dirname(parent);
    if (next === parent || !localPath(root, parent)) throw new Error('Unsafe parent');
    parent = next;
  }
  if (localPath(root, await realpath(absolute)) !== path) throw new Error('Linked source');
  if ((await lstat(absolute)).isSymbolicLink()) throw new Error('Linked source');
  const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== sizeBytes) throw new Error('Source changed since scan');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev || sha256(bytes) !== hash) {
      throw new Error(`Source changed since scan: ${path}`);
    }
    return bytes.toString('utf8');
  } finally { await file.close(); }
}

function position(sf: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: p.line + 1, column: p.character + 1 };
}

function sourceKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

async function compilerOptions(
  root: string,
  files: Map<string, { sha256: string; sizeBytes: number }>,
  issues: GraphIssue[],
): Promise<{ options: ts.CompilerOptions; config: Graph['coverage']['tsconfig'] }> {
  const defaults: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve, allowJs: true,
  };
  if (!files.has('tsconfig.json')) return { options: defaults, config: 'missing' };
  let partial = false;
  const visited = new Set<string>();
  const readConfig = async (path: string, depth: number): Promise<ts.CompilerOptions> => {
    if (depth > 8 || visited.has(path)) {
      partial = true;
      issues.push({ path, code: 'TSCONFIG_CYCLE_OR_DEPTH', line: 1, column: 1 });
      return {};
    }
    visited.add(path);
    const file = files.get(path);
    if (!file || !path.endsWith('.json') || !permittedPath(path)) {
      partial = true;
      issues.push({ path: 'tsconfig.json', code: 'TSCONFIG_EXTENDS_UNAVAILABLE', line: 1, column: 1 });
      return {};
    }
    const input = await verifiedRead(root, path, file.sha256, file.sizeBytes);
    const parsed = ts.parseConfigFileTextToJson(path, input);
    if (parsed.error || typeof parsed.config !== 'object' || !parsed.config || Array.isArray(parsed.config)) {
      partial = true;
      issues.push({ path, code: 'TSCONFIG_PARSE_ERROR', line: 1, column: 1 });
      return {};
    }
    const config: Record<string, unknown> = parsed.config;
    let inherited: ts.CompilerOptions = {};
    if (typeof config.extends === 'string') {
      const ref = config.extends;
      // Never load a package or config outside root, even indirectly via tsconfig extends.
      if (ref.startsWith('.')) {
        const extended = resolve(root, dirname(path), ref.endsWith('.json') ? ref : `${ref}.json`);
        const rel = localPath(root, extended);
        if (rel && files.has(rel)) inherited = await readConfig(rel, depth + 1);
        else {
          partial = true;
          issues.push({ path, code: 'TSCONFIG_EXTENDS_UNAVAILABLE', line: 1, column: 1 });
        }
      } else {
        partial = true;
        issues.push({ path, code: 'TSCONFIG_EXTENDS_UNAVAILABLE', line: 1, column: 1 });
      }
    } else if (config.extends !== undefined) {
      partial = true;
      issues.push({ path, code: 'TSCONFIG_EXTENDS_UNSUPPORTED', line: 1, column: 1 });
    }
    const converted = ts.convertCompilerOptionsFromJson(config.compilerOptions ?? {}, resolve(root, dirname(path)), path);
    if (converted.errors.length) {
      partial = true;
      issues.push({ path, code: 'TSCONFIG_OPTIONS_INVALID', line: 1, column: 1 });
    }
    return { ...inherited, ...converted.options };
  };
  const merged = await readConfig('tsconfig.json', 0);
  return { options: { ...defaults, ...merged }, config: partial ? 'partial' : 'loaded' };
}

function graphDigest(graph: Omit<Graph, 'artifactId' | 'capturedAt'>): string {
  return `sha256:${sha256(JSON.stringify(graph))}`;
}

export async function buildGraph(rootArg: string, repoId?: string): Promise<Graph> {
  const root = await realpath(resolve(rootArg));
  const snapshot: Snapshot = await scanRepository(root, repoId);
  const inventory = new Map(snapshot.files.map(f => [f.path, f]));
  const candidates = snapshot.files.filter(f => TYPESCRIPT_SOURCE.test(f.path));
  if (candidates.length > MAX_AST_FILES) throw new Error('Too many AST input files');
  const contents = new Map<string, string>();
  for (const file of candidates) contents.set(file.path, await verifiedRead(root, file.path, file.sha256, file.sizeBytes));
  const issues: GraphIssue[] = [];
  const { options, config } = await compilerOptions(root, inventory, issues);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const validFiles = new Set(candidates.map(f => f.path));
  const directories = new Set<string>([root]);
  for (const path of validFiles) {
    let directory = dirname(resolve(root, path));
    while (directory !== root && !directories.has(directory)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  const compilerHost: ts.ModuleResolutionHost = {
    fileExists: p => validFiles.has(localPath(root, p) ?? ''),
    readFile: p => contents.get(localPath(root, p) ?? ''),
    directoryExists: p => directories.has(resolve(p)),
    realpath: p => p,
    getCurrentDirectory: () => root,
    useCaseSensitiveFileNames: () => true,
  };
  const resolveSpecifier = (specifier: string, sourcePath: string): { to: string | null; resolution: 'resolved' | 'unknown' | 'external' } => {
    if (specifier.startsWith('node:')) return { to: null, resolution: 'external' };
    const outcome = ts.resolveModuleName(specifier, resolve(root, sourcePath), options, compilerHost).resolvedModule;
    if (outcome) {
      const internal = localPath(root, outcome.resolvedFileName);
      if (internal && validFiles.has(internal)) return { to: fileId(internal), resolution: 'resolved' };
    }
    return { to: null, resolution: specifier.startsWith('.') || specifier.startsWith('/') ||
      (options.paths && Object.keys(options.paths).some(key => key === specifier || (key.includes('*') && specifier.startsWith(key.split('*')[0]!))))
      ? 'unknown' : 'external' };
  };

  for (const file of candidates) {
    nodes.push({ id: fileId(file.path), kind: 'file', path: file.path, sha256: file.sha256 });
    const source = contents.get(file.path)!;
    const sf = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true, sourceKind(file.path));
    // Parse diagnostics are available on the concrete SourceFile but omitted from TS's public interface.
    const diagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    for (const diag of diagnostics) {
      const pos = sf.getLineAndCharacterOfPosition(diag.start ?? 0);
      issues.push({ path: file.path, code: `TS${diag.code}`, line: pos.line + 1, column: pos.character + 1 });
    }
    const declared = new Map<string, SymbolNode[]>();
    const localExports = new Map<string, string[]>();
    const addSymbol = (declaration: ts.Node, name: string, declarationKind: string, exported: boolean): void => {
      const pos = position(sf, declaration);
      const node: SymbolNode = {
        id: `symbol:${file.path}:${pos.line}:${pos.column}:${name}`,
        kind: 'symbol', path: file.path, name, declaration: declarationKind,
        line: pos.line, column: pos.column, exported,
        sha256: sha256(source.slice(declaration.getStart(sf), declaration.getEnd())),
      };
      nodes.push(node);
      const entries = declared.get(name) ?? [];
      entries.push(node);
      declared.set(name, entries);
    };
    const isExported = (node: ts.Node): boolean => !!ts.canHaveModifiers(node) &&
      !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && (statement.name || isExported(statement))) addSymbol(statement, statement.name?.text ?? 'default', 'function', isExported(statement));
      else if (ts.isClassDeclaration(statement) && (statement.name || isExported(statement))) addSymbol(statement, statement.name?.text ?? 'default', 'class', isExported(statement));
      else if (ts.isInterfaceDeclaration(statement)) addSymbol(statement, statement.name.text, 'interface', isExported(statement));
      else if (ts.isTypeAliasDeclaration(statement)) addSymbol(statement, statement.name.text, 'type', isExported(statement));
      else if (ts.isEnumDeclaration(statement)) addSymbol(statement, statement.name.text, 'enum', isExported(statement));
      else if (ts.isModuleDeclaration(statement)) addSymbol(statement, statement.name.text, 'namespace', isExported(statement));
      else if (ts.isVariableStatement(statement)) {
        for (const item of statement.declarationList.declarations) {
          if (ts.isIdentifier(item.name)) addSymbol(item, item.name.text, 'variable', isExported(statement));
        }
      } else if (ts.isExportAssignment(statement)) addSymbol(statement, 'default', 'default-assignment', true);
      if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const original = (element.propertyName ?? element.name).text;
          localExports.set(original, [...(localExports.get(original) ?? []), element.name.text]);
        }
      }
    }
    const addRelation = (node: ts.Node, relation: GraphEdge['relation'], specifier: string | null, symbols: string[] = [], typeOnly = false): void => {
      const pos = position(sf, node);
      const { to, resolution } = specifier === null ? { to: null, resolution: 'unknown' as const } : resolveSpecifier(specifier, file.path);
      edges.push({ from: fileId(file.path), to, relation, specifier, symbols, line: pos.line, column: pos.column, resolution, typeOnly });
      if (to !== null) edges.push({ from: to, to: fileId(file.path), relation: 'consumer', specifier, symbols, line: pos.line, column: pos.column, resolution: 'resolved', typeOnly });
    };
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement)) {
        const named = statement.importClause?.namedBindings;
        const symbols = [
          ...(statement.importClause?.name ? ['default'] : []),
          ...(named && ts.isNamedImports(named) ? named.elements.map(el => (el.propertyName ?? el.name).text) : []),
          ...(named && ts.isNamespaceImport(named) ? ['*'] : []),
        ];
        addRelation(statement, 'import', ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null, symbols,
          !!statement.importClause?.isTypeOnly || !!(named && ts.isNamedImports(named) && named.elements.length && named.elements.every(el => el.isTypeOnly)));
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        const symbols = statement.exportClause && ts.isNamedExports(statement.exportClause) ?
          statement.exportClause.elements.map(el => (el.propertyName ?? el.name).text) :
          statement.exportClause && ts.isNamespaceExport(statement.exportClause) ? [statement.exportClause.name.text] : ['*'];
        addRelation(statement, 'reexport', ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null, symbols,
          statement.isTypeOnly);
      } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
        const expr = statement.moduleReference.expression;
        addRelation(statement, 'require', expr && ts.isStringLiteral(expr) ? expr.text : null);
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          addRelation(node, 'dynamic-import', node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!) ? node.arguments[0]!.text : null);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          addRelation(node, 'require', node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!) ? node.arguments[0]!.text : null);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    for (const [name, declarations] of declared) {
      for (const declaration of declarations) {
        if (localExports.has(name)) declaration.exported = true;
        if (declaration.exported) {
          const exportNames = localExports.get(name) ?? [];
          if (exportNames.length === 0) exportNames.push(name);
          for (const exportedName of new Set(exportNames)) {
            edges.push({ from: fileId(file.path), to: declaration.id, relation: 'export', specifier: null,
              symbols: [exportedName], line: declaration.line, column: declaration.column, resolution: 'declared', typeOnly: declaration.declaration === 'type' || declaration.declaration === 'interface' });
          }
        }
      }
    }
  }
  // Canonical ordering is independent of filesystem enumeration and runtime traversal details.
  nodes.sort((a, b) => compare(a.id, b.id));
  edges.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  issues.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const graphBase: Omit<Graph, 'artifactId' | 'capturedAt'> = {
    schemaVersion: GRAPH_SCHEMA, producerVersion: VERSION, repoId: snapshot.repoId, sensitivity: 'private',
    sourceSnapshot: { artifactId: snapshot.artifactId, includedFilesHash: snapshot.provenance.includedFilesHash,
      commitSha: snapshot.provenance.commitSha, dirty: snapshot.provenance.dirty },
    coverage: { declarations: 'top-level-only', modules: 'within-inventory-only', tsconfig: config,
      sourceFiles: snapshot.stats.files, analyzedFiles: candidates.length },
    nodes, edges, issues,
    stats: { files: candidates.length, symbols: nodes.filter(x => x.kind === 'symbol').length, edges: edges.length,
      unresolved: edges.filter(x => x.resolution === 'unknown').length },
  };
  return { ...graphBase, artifactId: graphDigest(graphBase), capturedAt: new Date().toISOString() };
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validateGraph(value: unknown): Graph {
  if (!object(value) || value.schemaVersion !== GRAPH_SCHEMA) throw new Error('Unsupported code graph schemaVersion');
  const g = value as Graph;
  if (g.sensitivity !== 'private' || typeof g.repoId !== 'string' || !/^[\w.:-]{1,128}$/.test(g.repoId) ||
    typeof g.producerVersion !== 'string' || !g.producerVersion ||
    typeof g.capturedAt !== 'string' || !Number.isFinite(Date.parse(g.capturedAt)) ||
    !object(g.sourceSnapshot) || !/^sha256:[a-f0-9]{64}$/.test(g.sourceSnapshot.artifactId) ||
    !HEX.test(g.sourceSnapshot.includedFilesHash) ||
    !(g.sourceSnapshot.commitSha === null || typeof g.sourceSnapshot.commitSha === 'string' && /^[a-f0-9]{40}$/.test(g.sourceSnapshot.commitSha)) ||
    !(g.sourceSnapshot.dirty === null || typeof g.sourceSnapshot.dirty === 'boolean')) throw new Error('Invalid graph metadata');
  if (!object(g.coverage) || g.coverage.declarations !== 'top-level-only' || g.coverage.modules !== 'within-inventory-only' ||
    !['loaded', 'missing', 'partial'].includes(g.coverage.tsconfig) || !Number.isSafeInteger(g.coverage.sourceFiles) ||
    !Number.isSafeInteger(g.coverage.analyzedFiles) || g.coverage.sourceFiles < g.coverage.analyzedFiles || g.coverage.analyzedFiles < 0) throw new Error('Invalid coverage');
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges) || !Array.isArray(g.issues) ||
    g.nodes.length > 500_000 || g.edges.length > 1_000_000 || g.issues.length > 100_000) throw new Error('Invalid graph collections');
  const ids = new Set<string>();
  let fileCount = 0, symbolCount = 0;
  for (const n of g.nodes) {
    if (!object(n) || typeof n.id !== 'string' || ids.has(n.id) || typeof n.path !== 'string' || !permittedPath(n.path) || !HEX.test(n.sha256)) throw new Error('Invalid or duplicate graph node');
    ids.add(n.id);
    if (n.kind === 'file') { fileCount++; if (n.id !== fileId(n.path)) throw new Error('Invalid file ID'); }
    else if (n.kind === 'symbol') {
      symbolCount++;
      if (typeof n.name !== 'string' || typeof n.declaration !== 'string' || typeof n.exported !== 'boolean' ||
        !Number.isSafeInteger(n.line) || n.line < 1 || !Number.isSafeInteger(n.column) || n.column < 1 ||
        n.id !== `symbol:${n.path}:${n.line}:${n.column}:${n.name}`) throw new Error('Invalid symbol ID');
    } else throw new Error('Unsupported graph node');
  }
  for (const e of g.edges) {
    if (!object(e) || typeof e.from !== 'string' || !ids.has(e.from) || (e.to !== null && (typeof e.to !== 'string' || !ids.has(e.to))) ||
      !['import', 'reexport', 'dynamic-import', 'require', 'export', 'consumer'].includes(e.relation) ||
      !['resolved', 'unknown', 'external', 'declared'].includes(e.resolution) ||
      !(e.specifier === null || typeof e.specifier === 'string') || !Array.isArray(e.symbols) ||
      e.symbols.some((s: unknown) => typeof s !== 'string') || typeof e.typeOnly !== 'boolean' ||
      !Number.isSafeInteger(e.line) || e.line < 1 || !Number.isSafeInteger(e.column) || e.column < 1 ||
      (e.resolution === 'resolved' && e.to === null) || (['unknown','external'].includes(e.resolution) && e.to !== null)) throw new Error('Invalid graph edge');
  }
  for (const issue of g.issues) {
    if (!object(issue) || typeof issue.path !== 'string' || !permittedPath(issue.path) || typeof issue.code !== 'string' ||
      !Number.isSafeInteger(issue.line) || issue.line < 1 || !Number.isSafeInteger(issue.column) || issue.column < 1) throw new Error('Invalid graph issue');
  }
  if (!object(g.stats) || g.stats.files !== fileCount || g.stats.files !== g.coverage.analyzedFiles ||
    g.stats.symbols !== symbolCount || g.stats.edges !== g.edges.length ||
    g.stats.unresolved !== g.edges.filter(e => e.resolution === 'unknown').length) throw new Error('Invalid graph stats');
  const { artifactId, capturedAt, ...base } = g;
  if (artifactId !== graphDigest(base)) throw new Error('Graph content fingerprint mismatch');
  return g;
}

export function consumersOf(graph: Graph, path: string): string[] {
  if (!normalizedRelativePath(path)) throw new Error('Invalid file path');
  if (!graph.nodes.some(n => n.id === fileId(path))) throw new Error('File is not present in graph');
  return [...new Set(graph.edges.filter(edge => edge.relation === 'consumer' && edge.from === fileId(path))
    .map(edge => edge.to!.slice('file:'.length)))].sort(compare);
}
