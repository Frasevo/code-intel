# Frasevo Code Intel

Offline, read-only code inventory, TypeScript dependency graph, static Next.js API catalog, **CI-04 Markdown documentation traceability**, and **CI-05A bounded deterministic selection**. CI-01 snapshots and the CI-02/03 artifact contracts remain compatible with v1.

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
5. **CI-05A (implemented):** in-memory deterministic selection from validated v1 indexes; CI-05B/C remain pending.
6. **CI-06:** incremental indexing and optional read-only MCP.

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
- CI-05B will add hash-verified excerpts; CI-05C will define a stable versioned response schema and CLI. Do not treat this provisional TypeScript API as a public contract.

### Branch workflow

Create `feat/ci-05a-context-selection` from current `develop`, make **one commit** for this coherent change, submit a PR targeting **`develop` only**, and delete the feature branch after merging. **Do not merge or promote anything into `main` until explicitly instructed.** Local Node 22 testing requires experimental type stripping; the repository CI targets Node 24.
