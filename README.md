# Frasevo Code Intel

Offline, read-only code inventory and **CI-02 TypeScript AST dependency graph** for TypeScript/Next.js and related source files. CI-01 snapshots remain compatible with v1.

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
- [`schemas/code-graph.v1.schema.json`](schemas/code-graph.v1.schema.json): `code-graph/v1` with top-level symbol and file nodes, import/reexport/consumer/export relationships, source locations and declaration hashes.
- `sourceTreeHash` is `null` on purpose: only permitted files are scanned. The `includedFilesHash` covers canonical file metadata, not the complete source tree.
- Secret-looking files/dirs, `.git`, dependencies, generated outputs, symlinks and binaries are excluded. Files over 8 MiB and scans over the safety limits fail explicitly. Source content is never put in the artifact.
- Artifacts are `private` by default. Do not publish real project inventory or snapshots. Git metadata may be `null` when unavailable.
- `verified` for a local scan refers to file-byte hashing, **not** production health, test results, source authenticity or external availability.
- Imports deliberately lose producer-side verification claims. No imports or snapshots are uploaded.

## Development plan

1. **CI-01 (this phase):** offline scanner, generic import, snapshot contract, tests.
2. **CI-02 (this phase):** TypeScript AST symbols, in-inventory dependencies and reverse consumers.
3. **CI-03:** Next.js route registry, provenance and declared/tested/observed distinctions.
4. **CI-04:** documentation references and traceability.
5. **CI-05:** bounded, source-cited context retrieval with deterministic fallback.
6. **CI-06:** incremental indexing and optional read-only MCP.

See [SECURITY.md](SECURITY.md) for safe use and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions.

## CI-02 graph guarantees and limitations

`graph` first performs CI-01 scanning and byte hashing, then verifies included files again before parsing. Only included `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` files are analyzed. It parses source without executing project scripts, plugins, tsconfig modules or application code. It uses TypeScript's Compiler API and module resolver with an inventory-only virtual host.

- Top-level named declarations, exports, import/reexport statements, literal and non-literal `import()`/`require()` and reverse **file-level** consumers are recorded. Each relation references a source line/column; each declaration has a SHA-256 hash.
- Resolution is `resolved` only when the module is present in the scanned source inventory; unresolved local/alias references are `unknown`; bare packages and Node built-ins are `external`. External source content is **never** indexed. The graph does **not** claim proof of runtime execution or exact symbol bindings.
- `tsconfig.json` supports JSONC, relative in-root `extends` and compiler options including `baseUrl`/`paths`. Package-level or outside-root extends are **not loaded** and mark coverage `partial`. A missing tsconfig is `missing`. No repository configuration is executed.
- Parse diagnostics contain safe error codes and locations rather than source snippets. Malformed source does not become PASS. Source paths and symbol names remain private. Snapshot `sourceTreeHash` is still `null`: not all files and behaviors are covered.
- The graph is a separate `code-graph/v1` artifact to preserve `code-snapshot/v1` consumers. Its `artifactId` excludes `capturedAt` and is stable for equal file contents and graph data; a graph is invalidated by a changed scanned file hash. `validate` and `graph-validate` verify internal consistency, not ownership or source authenticity.
- Graph reading is bounded to the scanner's file/size limits; large workspaces and polyglot cross-language resolution require dedicated later benchmarking. A resolved dependency means a static source-level link, never verified runtime availability.

Do not upload real generated graphs, identifiers, file paths or secrets as public fixtures. Use only the included synthetic tests.
