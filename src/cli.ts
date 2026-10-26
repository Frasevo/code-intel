#!/usr/bin/env node
import { lstat, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanRepository } from './scanner.ts';
import { importArtifact, readJsonArtifact } from './importer.ts';
import { validateSnapshot, type Snapshot } from './snapshot.ts';
import { buildGraph, validateGraph, consumersOf, type Graph, type GraphReuseStats } from './graph.ts';
import { buildApiCatalog, validateApiCatalog, findApiRoute, type ApiCatalog } from './api-registry.ts';
import { buildDocTrace, validateDocTrace, referencesFrom, referencesTo, type DocTrace } from './docs.ts';
import { selectContext, type ContextIndexes, type ContextQuery } from './context.ts';
import { buildEvidencePack, type EvidenceLimits } from './evidence.ts';
import { createContextArtifact, validateContextArtifact, type ContextArtifact } from './context-artifact.ts';
import { serveMcpStdio } from './mcp.ts';

function usage(): never {
  throw new Error('Usage: mcp-stdio <repo> --snapshot <file> --graph <file> --api <file> --docs <file> [--allow-evidence] | context-select <repo> --snapshot <file> --graph <file> --api <file> --docs <file> --out <file> (--path <path> | --keyword <word>) [--depth 0..2] [--max-results 1..50] [--max-bytes 2048..65536] | context-evidence <repo> [same index/query/output options] [--max-lines 1..12] [--max-chars 80..2048] [--max-source-files 1..20] [--max-source-bytes 1..33554432] [--max-pack-bytes 2048..65536] | context-validate <file> | docs <repo> --out <file> [--repo-id <id>] | docs-validate <index> | docs-file <index> --path <doc> | docs-target <index> --path <target> | api <repo> --out <file> [--repo-id <id>] | api-validate <catalog> | api-route <catalog> --path </api/path> | scan <repo> --out <file> [--repo-id <id>] | graph <repo> --out <file> [--repo-id <id>] | graph-incremental <repo> --previous-graph <file> --previous-snapshot <file> --out <file> [--repo-id <id>] [--invalidate-path <relative-file>] | graph-validate <graph> | consumers <graph> --path <relative-file> | import <input> --out <file> --repo-id <id> | validate <snapshot>');
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (index === args.length - 1 || args[index + 1]!.startsWith('--')) usage();
  return args[index + 1];
}

function checkArgs(args: string[], permitted: Set<string>): void {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (!args[i]!.startsWith('--') || !permitted.has(args[i]!) || seen.has(args[i]!) || i === args.length - 1 || args[i + 1]!.startsWith('--')) usage();
    seen.add(args[i]!);
    i++;
  }
}

function within(root: string, destination: string): boolean {
  const rel = relative(root, destination);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function outputSnapshot(snapshot: Snapshot | Graph | ApiCatalog | DocTrace | ContextArtifact, output: string, scanRoot?: string): Promise<void> {
  const target = resolve(output);
  const dir = await realpath(dirname(target));
  const destination = resolve(dir, basename(target));
  if (scanRoot && within(await realpath(scanRoot), destination)) {
    throw new Error('Output must be outside the repository being scanned');
  }
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error('Refusing to overwrite symlink output');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = resolve(dir, `.frasevo-snapshot-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temp, destination);
  } finally { await rm(temp, { force: true }); }
}

/** Strict decimal parsing: reject negative numbers, fractions, exponents and overflow. */
function numberOption(args: string[], name: string): number | undefined {
  const raw = option(args, name);
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`Invalid numeric option: ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid numeric option: ${name}`);
  return value;
}

const CONTEXT_FLAGS = new Set(['--snapshot','--graph','--api','--docs','--out', '--path','--keyword',
  '--depth','--max-results','--max-bytes']);
const EVIDENCE_FLAGS = new Set([...CONTEXT_FLAGS, '--max-lines','--max-chars','--max-source-files',
  '--max-source-bytes','--max-pack-bytes']);

async function contextCommand(mode: 'selection' | 'evidence', repo: string, args: string[]): Promise<void> {
  checkArgs(args, mode === 'selection' ? CONTEXT_FLAGS : EVIDENCE_FLAGS);
  const required = ['--snapshot','--graph','--api','--docs','--out'];
  const values = Object.fromEntries(required.map(name => [name, option(args, name)]));
  if (required.some(name => !values[name])) usage();
  const query: ContextQuery = {};
  const path = option(args, '--path');
  const keyword = option(args, '--keyword');
  if (path !== undefined) query.path = path;
  if (keyword !== undefined) query.keyword = keyword;
  query.depth = numberOption(args, '--depth') as ContextQuery['depth'];
  query.maxResults = numberOption(args, '--max-results');
  query.maxBytes = numberOption(args, '--max-bytes');
  const limits: EvidenceLimits = {
    maxLines: numberOption(args, '--max-lines'),
    maxChars: numberOption(args, '--max-chars'),
    maxSourceFiles: numberOption(args, '--max-source-files'),
    maxSourceBytes: numberOption(args, '--max-source-bytes'),
    maxPackBytes: numberOption(args, '--max-pack-bytes'),
  };
  // Undefined options must not mask the evidence module's safe defaults.
  for (const name of Object.keys(limits) as (keyof EvidenceLimits)[]) {
    if (limits[name] === undefined) delete limits[name];
  }
  const [snapshot, graph, api, docs] = await Promise.all([
    readJsonArtifact(values['--snapshot']!), readJsonArtifact(values['--graph']!),
    readJsonArtifact(values['--api']!), readJsonArtifact(values['--docs']!),
  ]);
  const indexes: ContextIndexes = {
    snapshot: validateSnapshot(snapshot), graph: validateGraph(graph),
    api: validateApiCatalog(api), docs: validateDocTrace(docs),
  };
  const result = mode === 'selection' ?
    createContextArtifact(indexes, 'selection', selectContext(indexes, query)) :
    createContextArtifact(indexes, 'evidence', await buildEvidencePack(repo, indexes, query, limits));
  await outputSnapshot(result, values['--out']!, repo);
  console.log(`Wrote ${result.schemaVersion} ${mode} response (${result.artifactId})`);
}

export async function main(args: string[]): Promise<void> {
  const [command, target, ...rest] = args;
  if (!target || target.startsWith('--')) usage();
  if (command === 'context-select' || command === 'context-evidence') {
    await contextCommand(command === 'context-select' ? 'selection' : 'evidence', target, rest);
  } else if (command === 'mcp-stdio') {
    const allowEvidence = rest.includes('--allow-evidence');
    if (rest.filter(arg => arg === '--allow-evidence').length > 1) usage();
    const flags = rest.filter(arg => arg !== '--allow-evidence');
    checkArgs(flags, new Set(['--snapshot', '--graph', '--api', '--docs']));
    const paths = ['--snapshot', '--graph', '--api', '--docs'].map(name => option(flags, name));
    if (paths.some(path => !path)) usage();
    const [snapshot, graph, api, docs] = await Promise.all(paths.map(path => readJsonArtifact(path!)));
    const indexes: ContextIndexes = { snapshot: validateSnapshot(snapshot), graph: validateGraph(graph),
      api: validateApiCatalog(api), docs: validateDocTrace(docs) };
    await serveMcpStdio(target, indexes, allowEvidence);
  } else if (command === 'context-validate') {
    if (rest.length) usage();
    const response = validateContextArtifact(await readJsonArtifact(target));
    console.log(`Valid ${response.schemaVersion} (${response.artifactId})`);
  } else if (command === 'docs') {
    checkArgs(rest, new Set(['--out', '--repo-id']));
    const out = option(rest, '--out');
    if (!out) usage();
    const docs = await buildDocTrace(target, option(rest, '--repo-id'));
    validateDocTrace(docs);
    await outputSnapshot(docs, out, target);
    console.log(`Wrote ${docs.stats.documents} documents and ${docs.stats.references} references`);
  } else if (command === 'docs-validate') {
    if (rest.length) usage();
    const docs = validateDocTrace(await readJsonArtifact(target));
    console.log(`Valid ${docs.schemaVersion} (${docs.artifactId})`);
  } else if (command === 'docs-file' || command === 'docs-target') {
    checkArgs(rest, new Set(['--path']));
    const path = option(rest, '--path');
    if (!path) usage();
    const docs = validateDocTrace(await readJsonArtifact(target));
    console.log(JSON.stringify(command === 'docs-file' ? referencesFrom(docs, path) : referencesTo(docs, path), null, 2));
  } else if (command === 'api') {
    checkArgs(rest, new Set(['--out', '--repo-id']));
    const out = option(rest, '--out');
    if (!out) usage();
    const catalog = await buildApiCatalog(target, option(rest, '--repo-id'));
    validateApiCatalog(catalog);
    await outputSnapshot(catalog, out, target);
    console.log(`Wrote ${catalog.stats.routes} API routes and ${catalog.stats.methods} method declarations`);
  } else if (command === 'api-validate') {
    if (rest.length) usage();
    const catalog = validateApiCatalog(await readJsonArtifact(target));
    console.log(`Valid ${catalog.schemaVersion} (${catalog.artifactId})`);
  } else if (command === 'api-route') {
    checkArgs(rest, new Set(['--path']));
    const path = option(rest, '--path');
    if (!path) usage();
    const catalog = validateApiCatalog(await readJsonArtifact(target));
    console.log(JSON.stringify(findApiRoute(catalog, path), null, 2));
  } else if (command === 'scan') {
    checkArgs(rest, new Set(['--out', '--repo-id']));
    const out = option(rest, '--out');
    if (!out) usage();
    const snapshot = await scanRepository(target, option(rest, '--repo-id'));
    await outputSnapshot(snapshot, out, target);
    console.log(`Wrote ${snapshot.stats.files} files to snapshot (${snapshot.artifactId})`);
  } else if (command === 'graph' || command === 'graph-incremental') {
    checkArgs(rest, new Set(command === 'graph' ? ['--out', '--repo-id'] : ['--out', '--repo-id', '--previous-graph', '--previous-snapshot', '--invalidate-path']));
    const out = option(rest, '--out');
    if (!out) usage();
    const stats: GraphReuseStats = { reusedFiles: 0, parsedFiles: 0, fallback: null };
    const cache = command === 'graph-incremental' ? {
      snapshot: validateSnapshot(await readJsonArtifact(option(rest, '--previous-snapshot') ?? usage())),
      graph: validateGraph(await readJsonArtifact(option(rest, '--previous-graph') ?? usage())),
      invalidatePaths: option(rest, '--invalidate-path') ? [option(rest, '--invalidate-path')!] : [],
      stats,
    } : undefined;
    const graph = await buildGraph(target, option(rest, '--repo-id'), cache);
    validateGraph(graph);
    await outputSnapshot(graph, out, target);
    console.log(`Wrote graph with ${graph.stats.files} files, ${graph.stats.symbols} symbols and ${graph.stats.edges} edges`);
    if (cache) console.log(`AST: reused=${stats.reusedFiles} parsed=${stats.parsedFiles}${stats.fallback ? ` fallback=${stats.fallback}` : ''}; inventory fully verified`);
  } else if (command === 'graph-validate') {
    if (rest.length) usage();
    const graph = validateGraph(await readJsonArtifact(target));
    console.log(`Valid ${graph.schemaVersion} (${graph.artifactId})`);
  } else if (command === 'consumers') {
    checkArgs(rest, new Set(['--path']));
    const path = option(rest, '--path');
    if (!path) usage();
    const graph = validateGraph(await readJsonArtifact(target));
    console.log(JSON.stringify(consumersOf(graph, path), null, 2));
  } else if (command === 'import') {
    checkArgs(rest, new Set(['--out', '--repo-id']));
    const out = option(rest, '--out');
    const repoId = option(rest, '--repo-id');
    if (!out || !repoId) usage();
    const snapshot = importArtifact(await readJsonArtifact(target), repoId);
    await outputSnapshot(snapshot, out);
    console.log(`Imported ${snapshot.stats.files} file records (${snapshot.provenance.verification})`);
  } else if (command === 'validate') {
    if (rest.length > 0) usage();
    const snapshot = validateSnapshot(await readJsonArtifact(target));
    console.log(`Valid ${snapshot.schemaVersion} (${snapshot.artifactId})`);
  } else usage();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Unexpected error');
    process.exitCode = 1;
  });
}
