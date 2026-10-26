# Contributing

Keep changes small, reviewable and backed by synthetic fixtures. Create a `feat/ci-XX-*` branch from updated `develop` and open a pull request against **`develop` only**. Do not merge into `main` until explicitly authorized; do not include confidential product data, credentials, external customer information, or files derived from private repositories.

- Use Node.js 24.x, install pinned dependencies with `npm ci --ignore-scripts`, run `npm run typecheck` and `npm test`.
- Add positive and adversarial tests for any change to file inclusion, provenance or import.
- Preserve versioned schemas. Breaking schema changes require a new major contract version.
- Use one coherent commit per functional delivery, with a `feat(ci-NN): ...` or `fix(ci-NN): ...` message. Once the PR to `develop` is merged, remove the feature branch locally and remotely.
- All contributions must be your own or lawfully licensed, with attribution when necessary. Apache-2.0 applies to original contributions unless separately agreed.

Prompts, documentation and third-party code must be reviewed for origin and licensing. Changes that affect security or permissions require explicit review.
