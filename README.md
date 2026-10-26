# Frasevo Code Intel

Offline, read-only code inventory, TypeScript dependency graph, static Next.js API catalog, **CI-04 Markdown documentation traceability**, and **CI-05 deterministic context queries and hash-verified evidence with a versioned CLI contract**; CI-06 supports SHA-256-keyed AST reuse and a bounded-concurrency scanner with full file verification. CI-01 snapshots and the CI-02/03 artifact contracts remain compatible with v1.

This repository is independent of the Frasevo SaaS. All examples and fixtures are synthetic. It does not use AI, Ollama, Codex, API keys, external services, telemetry, or a database.

## Requirements

- Node.js 24.x (native TypeScript type stripping)
- TypeScript 5.8.3 as a runtime dependency for AST and resolution; `@types/node` for typechecking
- Git optional, used only for best-effort commit and dirty-state metadata

## Commands

Install dependencies once (`npm install --ignore-scripts` or your pnpm equivalent). Tests and typecheck do not need a GPU or network after installation.

```sh
# Keep results OUTSIDE the scanned repository. This tool does not change it.
node src/cli.ts scan ./my-project --out ../code-snapshot.json --repo-id sample-project
node src/cli.ts validate ../code-snapshot.json

# CI-02: graph with imports, reexports, symbols, and reverse consumers.
node src/cli.ts graph ./my-project --out ../code-graph.json --repo-id sample-project
node src/cli.ts graph-validate ../code-graph.json
# CI-06A1: first create a full snapshot + graph, then reuse them for later runs.
node src/cli.ts graph-incremental ./my-project --repo-id sample-project \
  --previous-snapshot ../code-snapshot.json --previous-graph ../code-graph.json \
  --out ../next-code-graph.json --invalidate-path src/lib/widget.ts
node src/cli.ts consumers ../code-graph.json --path src/lib/widget.ts

# CI-03: static Next.js App Router API declarations, no network or code execution.
node src/cli.ts api ./my-project --out ../api-catalog.json --repo-id sample-project
node src/cli.ts api-validate ../api-catalog.json
node src/cli.ts api-route ../api-catalog.json --path /api/items/[id]

# CI-04: source-cited Markdown links to code, other docs, and API routes.
node src/cli.ts docs ./my-project --out ../doc-trace.json --repo-id sample-project
node src/cli.ts docs-validate ../doc-trace.json
node src/cli.ts docs-file ../doc-trace.json --path README.md
node src/cli.ts docs-target ../doc-trace.json --path src/lib/widget.ts
node src/cli.ts docs-target ../doc-trace.json --path /api/items/[id]

# Generic import: source hashes cannot be independently checked, so marked unverified.
node src/cli.ts import ./inventory.json --repo-id sample-project --out ../imported-snapshot.json

npm test
npm run typecheck
```

`--repo-id` should be an opaque project identifier (not a workspace, customer, username or filesystem path). Without it, the scanner derives a stable local opaque ID from the resolved root path, which is **not intended for cross-machine identity**.

An example generic inventory input is:

```json
{
  "schemaVersion": "generic-file-inventory/v1",
  "files": [
    {
      "path": "src/index.ts",
      "sizeBytes": 17,
      "sha256": "1111111111111111111111111111111111111111111111111111111111111111"
    }
  ]
}
```

Import hashes are only producer claims. `validate` checks structural and internal fingerprint consistency; it **does not** authenticate the source checkout or the contents of imported files.

## Contracts and safety

- [`schemas/code-snapshot.v1.schema.json`](schemas/code-snapshot.v1.schema.json): `code-snapshot/v1` with `schemaVersion`, producer and artifact IDs, time, sensitivity, hash, files and optional Git identity.
- [`schemas/generic-file-inventory.v1.schema.json`](schemas/generic-file-inventory.v1.schema.json): portable input for generic import; no product-specific parsing.
- [`schemas/api-catalog.v1.schema.json`](schemas/api-catalog.v1.schema.json): `api-catalog/v1` with Next.js route files, method declarations, static dependency evidence and explicit unknowns.
- [`schemas/doc-trace.v1.schema.json`](schemas/doc-trace.v1.schema.json): `doc-trace/v1` with Markdown heading anchors, link references to verified inventory paths or API declarations, link coordinates, coverage caveats, and upstream fingerprint IDs.
- [`schemas/code-graph.v1.schema.json`](schemas/code-graph.v1.schema.json): `code-graph/v1` with top-level symbol and file nodes, import/reexport/consumer/export relationships, source locations and declaration hashes.
- `sourceTreeHash` is `null` on purpose: only permitted files are scanned. The `includedFilesHash` covers canonical file metadata, not the complete source tree.
- Secret-looking files/dirs, `.git`, dependencies, generated outputs, symlinks and binaries are excluded. Files over 8 MiB and scans over the safety limits fail explicitly. Source content is never put in the artifact.
- Artifacts are `private` by default. Do not publish real project inventory or snapshots. Git metadata may be `null` when unavailable.
- `verified` for a local scan refers to file-byte hashing, **not** production health, test results, source authenticity or external availability.
- Imports deliberately lose producer-side verification claims. No imports or snapshots are uploaded.

## Development plan

1. **CI-01 (complete):** offline scanner, generic import, snapshot contract, tests.
2. **CI-02 (complete):** TypeScript AST symbols, in-inventory dependencies and reverse consumers.
3. **CI-03 (complete):** Next.js route registry, provenance and declared/tested/observed distinctions.
4. **CI-04 (complete):** Markdown link/anchor references and traceability without executing the target repository.
5. **CI-05 (implemented; CI validation pending):** deterministic context selection, hash-verified excerpts, and versioned read-only CLI `context-query/v1`.
6. **CI-06A1/A2 (implemented; integration validation pending):** reusable AST graph metadata and bounded-concurrency inventory hashing; CI-06B (pending decision) optional read-only MCP.

See [PENDIENTE.md](PENDIENTE.md) for the active roadmap. See [SECURITY.md](SECURITY.md) for safe use and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions.

## CI-02 graph guarantees and limitations

`graph` first performs CI-01 scanning and byte hashing, then verifies included files again before parsing. Only included `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files are analyzed. It parses source without executing project scripts, plugins, tsconfig modules or application code. It uses TypeScript's Compiler API and module resolver with an inventory-only virtual host.

- Top-level named declarations, exports, import/reexport statements, literal and non-literal `import()`/`require()` and reverse **file-level** consumers are recorded. Each relation references a source line/column; each declaration has a SHA-256 hash.
- Resolution is `resolved` only when the module is present in the scanned source inventory; unresolved local/alias references are `unknown`; bare packages and Node built-ins are `external`. External source content is **never** indexed. The graph does **not** claim proof of runtime execution or exact symbol bindings.
- `tsconfig.json` supports JSONC, relative in-root `extends` and compiler options including `baseUrl`/`paths`. Package-level or outside-root extends are **not loaded** and mark coverage `partial`. A missing tsconfig is `missing`. No repository configuration is executed.
- Parse diagnostics contain safe error codes and locations rather than source snippets. Malformed source does not become PASS. Source paths and symbol names remain private. Snapshot `sourceTreeHash` is still `null`: not all files and behaviors are covered.
- The graph is a separate `code-graph/v1` artifact to preserve `code-snapshot/v1` consumers. Its `artifactId` excludes `capturedAt` and is stable for equal file contents and graph data; a graph is invalidated by a changed scanned file hash. `validate` and `graph-validate` verify internal consistency, not ownership or source authenticity.
- Graph reading is bounded to the scanner's file/size limits; large workspaces and polyglot cross-language resolution require dedicated later benchmarking. A resolved dependency means a static source-level link, never verified runtime availability.

Do not upload real generated graphs, identifiers, file paths or secrets as public fixtures. Use only the included synthetic tests.

## CI-03 API catalog guarantees and limitations

`api` reads a new CI-01 snapshot and CI-02 graph of the same source identity, then produces the separate `api-catalog/v1` contract. No execution of `next`, project scripts, Node modules, auth providers, network requests, or runtime probes occurs. Only permitted `app/api/**/route.ts|js` and `src/app/api/**/route.ts|js` files are treated as API routes. Route groups are omitted from URL paths; `[id]`, `[...slug]`, `[[...slug]]` are retained as path parameters. Unsupported interception/parallel route segments are reported rather than guessed.

The seven recognized HTTP method names are Next.js App Router's `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. A method is **declared** when an AST export is found, including supported named, imported-alias and wildcard reexports. Origin resolution traverses **only files already in the verified CI-01 inventory**, using graph references, with cycle and depth limits. A named export of a missing target may still appear as declared, but its origin remains `unknown` with a diagnostic. A direct export is never proof that it is a callable, functioning endpoint.

Each method always has `evidence.tested=not-checked`, `evidence.observed=not-checked`, `authentication.status=unknown`, `requestSchema=unknown`, `responseSchema=unknown`, `rateLimit=unknown` unless a future version defines *separate explicit evidence*. The `authentication.staticSignals` array contains only AST-level names used in the declaring handler; **it never proves that authentication is effective**, and an empty array never implies public access. CI-03 does **not** generate request samples without a verified request/response contract.

Dependencies show direct static imports and reexports of the route file (with source coordinates), not complete transitive reachability or effective permissions. Route collisions and unsupported segments appear in `issues`. The artifact fingerprint omits `capturedAt` and its internal validation checks consistency only; authenticating the source checkout requires independent re-scanning. Do not publish private catalogs, source paths, or artifacts generated from Frasevo.


## CI-04 documentation coverage and limits

`docs` performs read-only local CI-01/02/03 indexing and cross-checks the snapshot, graph and API fingerprints before producing a fourth independent `doc-trace/v1` artifact. It reads only Markdown `.md` / `.mdx` files permitted by the CI-01 scanner and rechecks file hashes before processing. Outputs must remain **outside** the scanned repository.

- Static Markdown inline links `[text](path)`, full reference uses `[text][ref]` plus `[ref]: path`, and ATX headings (`# Heading`) are supported. References carry documentation path, line, column, target, and status. Multiple same-name headings get `-1`, `-2` suffixes. Supported targets: inventory files, headings in indexed Markdown, and **exact declared** Next.js API route paths such as `/api/items/[id]`. Backticks and fenced blocks are excluded; Markdown image links are excluded.
- `resolved` means **a static match** to an included file, Markdown heading or API declaration, not that the documentation is accurate, a link works in production, an endpoint is reachable, authenticated, tested, or current. A link that cannot be established is `unknown` rather than inferred as broken or valid. `/api/items/123` does not prove a match to `/api/items/[id]`.
- External links are preserved only as `kind=external`, without recording their URLs, query strings, or credentials. Unsafe/absolute targets are `unknown` without exporting their target. The output retains internal paths/headings and is therefore always `private`.
- This core deliberately does **not** implement full CommonMark, MDX JSX links, wiki links, HTML anchors, link text inspection, runtime documentation generation, endpoint probes, API examples, dependency transitive reachability, or doc-to-symbol inference. Complex nested Markdown/parenthesized paths may be missed. CI-05/06 can extend indexing and performance without changing v1 semantics.
- Fingerprints bind output content and referenced upstream artifact IDs (excluding `capturedAt`); they do not provide cryptographic proof of repository ownership or prevent someone from forging a whole JSON artifact. Repeat scanning against a trusted checkout for stronger assurance.

## CI-05A context selector (programmatic API only)

`src/context.ts` exposes `selectContext({ snapshot, graph, api, docs }, { path?, keyword?, depth?, maxResults?, maxBytes? })`. This implementation **does not read source files, use the network, run code, or contact an LLM**. Callers supply v1 artifacts generated for the same checkout; it validates artifact fingerprints, repository identities, provenance and cross-index file hashes before returning any results.

- Use exact inventory-relative paths, or exact declared API paths such as `/api/items`; keyword matching is case-insensitive over indexed paths, declared symbol names, route paths, and heading slugs. Neither file contents nor non-indexed descriptions are searched.
- Optional `depth` is 0–2 (default 0); expansions run from an exact file or route path across resolved TypeScript graph edges and resolved document links. A relationship is static evidence only; consumer edges are not execution traces. Incoming document links, fuzzy route parameters and heuristic interpretations are not inferred.
- Each hit includes its source schema (`code-snapshot/v1`, `code-graph/v1`, `api-catalog/v1` or `doc-trace/v1`), corresponding artifact ID and record reference, with source path/line/column when available. Results are deterministically ranked (exact path, partial path, keyword, relations), with stable tie-breakers. `no-match` means not found in the **included indexes only**.
- Default limits: 20 results, 16 KiB JSON output; hard limits: 50 results, 64 KiB JSON, depth 2 and 5,000 candidates. `truncated=true` reports a bounded partial selection. If query metadata itself exceeds the requested byte limit, the query is rejected. Unverified source content, runtime proof, authentication, request/response schemas and testing status are **not supplied**.
- CI-05B adds hash-verified excerpts, while CI-05C wraps both outputs in a versioned `context-query/v1` contract and exposes them through the CLI. The TypeScript selector result by itself remains internal.

## CI-05B evidence pack (programmatic API only)

`src/evidence.ts` exposes `buildEvidencePack(root, indexes, contextQuery, limits?)`. Supply an existing `ContextIndexes` value from CI-05A, a local checkout root and a query. It first validates all four indexes and uses `selectContext`; it then reads **only source files with indexed line/column coordinates**, with the existing `verifiedRead()` checks (permitted relative path, in-root real path, no linked parents/files, expected byte size and SHA-256). Source bytes are never returned for failed reads. The function itself remains a private TypeScript API; CI-05C provides its versioned CLI wrapper.

- Each result carries the selected hit and its artifact reference plus `status`, `verification`, `reason`, `expectedSha256` and a nullable excerpt with `sourcePath`, start/end line, first-column offset, text and truncation flag. `indexed` means that the source file matches the **supplied** snapshot hash and the indexed location exists; it never means the code executes or the interpretation is true. `unknown` is used for unavailable/changed files or invalid positions, and `not-checked` for non-positioned hits and reading-budget exhaustion. `no-match` is only no match **among included indexes**.
- Defaults: 5 lines, 640 UTF-16 code units, 8 distinct source files, 16 MiB total source reads and 32 KiB output. Hard maximums: 12 lines, 2048 UTF-16 code units, 20 source files, 32 MiB input and 64 KiB JSON output. The CI-05A context query maintains its separate maximums of 50 hits, 64 KiB and 2 relation levels. Long lines are cropped **around the indexed column**; line endings in excerpts are normalized to `\n`. `truncated` indicates output or selection limits; the excerpt-level flag indicates missing surrounding lines or cropped content.
- The file-reader verifies bytes against the supplied hash, but this **does not authenticate the provenance of user-provided indexes**, commit identity, or repository ownership; it also does not prevent sensitive string literals within permitted source files. Keep evidence private and review before sharing. There is no whole-repository completeness guarantee, no external evidence and no runtime/security proof.

Example (TypeScript, using already-built indexes):

```ts
import { buildEvidencePack } from './src/evidence.ts';

const pack = await buildEvidencePack('./my-project', indexes, {
  path: 'src/lib/items.ts', keyword: 'getItems', depth: 1,
}, { maxLines: 3, maxChars: 400 });
// pack.records: only hash-verified excerpts are status === 'indexed'
```

## CI-05C — Versioned queries from existing indexes

The read-only `context-select` and `context-evidence` commands accept the **same four prebuilt indexes** for one checkout. Reuse artifacts from CI-01 through CI-04; no implicit reindexing or execution occurs. The repository root is mandatory to prevent writing the output into the source tree. It is accessed only for bounded, verified excerpt reads in evidence mode. Save indexes and response JSON **outside** the scanned repository.

```sh
# Run after scan, graph, api and docs with the same --repo-id, unchanged checkout.
node src/cli.ts context-select ./my-project \
  --snapshot ../code-snapshot.json --graph ../code-graph.json \
  --api ../api-catalog.json --docs ../doc-trace.json \
  --path src/lib/items.ts --depth 1 --max-results 20 \
  --out ../context-selection.json

node src/cli.ts context-evidence ./my-project \
  --snapshot ../code-snapshot.json --graph ../code-graph.json \
  --api ../api-catalog.json --docs ../doc-trace.json \
  --keyword getItems --max-lines 3 --max-chars 400 \
  --out ../context-evidence.json

node src/cli.ts context-validate ../context-evidence.json
```

The schema is [`schemas/context-query.v1.schema.json`](schemas/context-query.v1.schema.json), and `src/context-artifact.ts` exposes `createContextArtifact()` and `validateContextArtifact()` to application code. Both CLI modes produce a **private** envelope with `schemaVersion: "context-query/v1"`, `producerVersion`, `repoId`, `artifactId`, `sensitivity`, `mode` and `result`. The `result.sources` field lists the IDs of all four original indexes; `mode=selection` gives ordered `hits`, while `mode=evidence` gives annotated `records` with excerpt positions and status.

- The `artifactId` is SHA-256 of the UTF-8 JSON body **without** `artifactId`, with object keys recursively sorted. This makes results reproducible regardless of JSON formatting or object key ordering. It is an **integrity fingerprint, not a signature** or evidence that the source is authentic/current. Do not treat hand-crafted self-consistent JSON as independently verified evidence.
- `--path` and/or `--keyword` is mandatory. Path accepts an included relative path or exact `/api/` route path. `--depth` 0–2, `--max-results` 1–50 (default 20), `--max-bytes` 2048–65536 (default 16384); the independent `--max-lines`, `--max-chars`, `--max-source-files`, `--max-source-bytes` and `--max-pack-bytes` limits apply only to `context-evidence` as documented above. Output limits are enforced prior to writing. Rejected/unknown arguments, duplicates, malformed numeric flags and incompatible indexes fail closed.
- Source excerpts are returned only when the current file bytes match the supplied snapshot SHA-256. `not-checked` does **not** mean success, and `unknown` never includes unreadable/unverified bytes. The CLI does not claim test coverage, runtime reachability, access permissions, production behavior or completeness of excluded files.
- CLI writes are atomic and reject symlink destinations; the resolved output directory must exist and be outside the scanned root. Results may include internal paths and literal permitted source text, so they must not be published without review. Keep potentially confidential indexes and result files out of version control.

### Branch workflow

Create a new `feat/ci-XX-*` branch from updated `develop` for each core, make **one coherent commit**, submit a PR targeting **`develop` only**, and remove the feature branch after merging. **Do not merge or promote anything into `main` until explicitly instructed.** Local Node 22 testing requires experimental type stripping; the repository CI targets Node 24.

## CI-06A1 incremental graph analysis

`graph-incremental` takes locally produced `code-snapshot/v1` and `code-graph/v1` artifacts from the **same previous run and repo ID**. They form a private local cache, kept outside the target repository. The current scan always enumerates included files and verifies SHA-256 of their bytes. Only AST output for unchanged source hashes can be reused; the new `code-graph/v1` is fully rebuilt with current provenance and fingerprint. The CLI prints `AST: reused=N parsed=M` (and a fallback reason if necessary). There are no new published schema fields.

- An edited TS/JS source invalidates its own cached AST automatically. Optionally pass `--invalidate-path <relative-file>` to force re-parse even with identical content; the library accepts multiple explicit paths. Denied paths are rejected.
- Source file creation/deletion, changed JSON configuration (including `tsconfig.json`), unsupported previous producer versions and explicitly invalidated non-source paths force a complete AST pass. The previous snapshot, graph and repository identity must be mutually compatible. Source paths, symbols and imports in prior caches are **private, trusted local data**: an artifact fingerprint alone is not an authenticity signature against a maliciously forged cache.
- Reuse saves AST parsing, not file hashing. An unmodified source can only be considered `filesystem-verified` because the current scanner still performs a full tree traversal and SHA-256 calculation. No filesystem event stream or `mtime`-only cache is trusted in this phase. CI-06A2 improves scanning throughput without skipping enumeration or hashing.
- Benchmark illustration (single local run, Node 22): 100 synthetic TS files with 25 exported functions each, one edited file; median full graph ~119 ms, incremental ~89 ms (four measurements after two warm-up runs); 99 files reused and 1 parsed, identical fingerprint. Measurements vary with file sizes, filesystem and machine. Official Node 24 Ubuntu/Windows validation is still pending.

## CI-06A2 safe inventory throughput

`scan`, `graph` and `graph-incremental` share `scanRepository()`. It now overlaps hashing I/O for **up to four files at a time**, bounded by a fixed cap on simultaneously open file handles. The directory traversal still enumerates every permitted directory; every included file still gets a freshly computed SHA-256 from its bytes, with pre/post metadata checks. The scanner avoids entering excluded directories and avoids resolving disallowed files. Its result is sorted canonically by `createSnapshot()`, so completion order does not alter the artifact ID.

**No change journal or trusted filesystem watcher is available.** `mtime`, file size, Git status and an earlier hash cannot authorize skipping a file. This is an I/O scheduling improvement, not a partial scan. File additions, removals, equal-size edits and policy exclusions remain accounted for in full scans. Like other filesystem scanners, it does not promise an atomic cross-file snapshot during concurrent external writes; changes detected while a file is read cause an error.

- Contract remains `code-snapshot/v1`, with no new schema fields. Native read-only behavior, policy exclusions, file/total size caps, and symlink rejection are unchanged.
- New tests check deterministic ordering across many files, create/delete/mtime-preserving rewrites and exclusion/symlink/size protections. Tests use synthetic content only.
- Local illustrative Node 22 benchmark: 400 small/mid-sized TypeScript files, same filesystem, eight paired measurements after three warm-ups, medians **~272 ms** (CI-06A1 scanner) and **~85 ms** (CI-06A2 scanner). Includes file enumeration and hashing; excludes AST indexing. Results are machine-specific and may reverse on some disks, network filesystems or file distributions. Large repository and Node 24 CI benchmarks remain pending.
