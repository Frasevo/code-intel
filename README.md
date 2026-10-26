# Frasevo Code Intel

Offline, read-only code inventory for TypeScript/Next.js and related source files. **CI-01** provides a secure baseline for future dependency graphs, API discovery and evidence-backed context retrieval.

This repository is independent of the Frasevo SaaS. All examples and fixtures are synthetic. It does not use AI, Ollama, Codex, API keys, external services, telemetry, or a database.

## Requirements

- Node.js 24.x (native TypeScript type stripping; no external runtime dependencies)
- Git optional, used only for best-effort commit and dirty-state metadata

## Commands

```sh
# Keep results OUTSIDE the scanned repository. This tool does not change it.
node src/cli.ts scan ./my-project --out ../code-snapshot.json --repo-id sample-project
node src/cli.ts validate ../code-snapshot.json

# Generic import: source hashes cannot be independently checked, so marked unverified.
node src/cli.ts import ./inventory.json --repo-id sample-project --out ../imported-snapshot.json

npm test
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
- `sourceTreeHash` is `null` on purpose: only permitted files are scanned. The `includedFilesHash` covers canonical file metadata, not the complete source tree.
- Secret-looking files/dirs, `.git`, dependencies, generated outputs, symlinks and binaries are excluded. Files over 8 MiB and scans over the safety limits fail explicitly. Source content is never put in the artifact.
- Artifacts are `private` by default. Do not publish real project inventory or snapshots. Git metadata may be `null` when unavailable.
- `verified` for a local scan refers to file-byte hashing, **not** production health, test results, source authenticity or external availability.
- Imports deliberately lose producer-side verification claims. No imports or snapshots are uploaded.

## Development plan

1. **CI-01 (this phase):** offline scanner, generic import, snapshot contract, tests.
2. **CI-02:** TypeScript AST symbols and dependency graph.
3. **CI-03:** Next.js route registry, provenance and declared/tested/observed distinctions.
4. **CI-04:** documentation references and traceability.
5. **CI-05:** bounded, source-cited context retrieval with deterministic fallback.
6. **CI-06:** incremental indexing and optional read-only MCP.

See [SECURITY.md](SECURITY.md) for safe use and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions.
