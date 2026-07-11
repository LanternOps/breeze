# Breeze Extensions

This directory hosts optional extension packages. It is empty in the public
repo — extensions are separate (possibly private) repos cloned in:

    git clone <extension-repo-url> extensions/<name>
    pnpm install

Each extension is a pnpm workspace package carrying a `breeze-extension.json`
manifest (validated by `@breeze/extension-api`) that declares:

- `name` — lowercase slug; also the migration-ledger prefix (`<name>/<file>.sql`)
- `routeNamespace` — routes mount at `/api/v1/<routeNamespace>`
- `entry` — TS source entry (dev); prod loads `dist/index.cjs` if present
- `migrationsDir` — raw SQL migrations, same rules as `apps/api/migrations/`
  (idempotent, no inner BEGIN/COMMIT, `^\d{4}-.*\.sql$`, never edit shipped)
- `tenancy` — table registrations consumed by the org/device cascade machinery
  and contract tests

Extension tables MUST ship RLS policies in their creating migration, exactly
like core tables (see CLAUDE.md "Tenant Isolation / RLS"). Tables with an
`org_id` column are auto-discovered by the RLS coverage contract test.

With `extensions/` empty, every build, test, and boot path behaves exactly as
before — the seam is a no-op. Set `BREEZE_EXTENSIONS_ENABLED=false` to skip
loading even when extensions are present.

## Lockfile policy

Extension importers must NOT be committed to the public `pnpm-lock.yaml` — a
private extension's dependency graph would leak. Running `pnpm install` with an
extension present adds an `extensions/<name>` importer hunk locally; leave it
out of commits (`git checkout pnpm-lock.yaml` before staging). Docker builds
account for this: the builder stage runs a scoped
`pnpm install --filter './extensions/*' --no-frozen-lockfile` before building
extensions, so the committed lockfile stays extension-free.

## Trust boundary & lifecycle

- Anything that can write to `extensions/` or set `BREEZE_EXTENSIONS_DIR`
  can execute arbitrary code in the API process. Protect the extension
  directory like the API binary itself.
- Removing a previously migrated extension leaves its tables and data in
  place. Organization cascade-delete then fails loudly: the transaction rolls
  back with no partial erasure until the extension is restored, or its tables
  are dropped and its `<name>/` migration-ledger rows are deleted.
- `RESERVED_ROUTE_NAMESPACES` in `@breeze/extension-api` is maintained by hand.
  When core mounts a new `/api/v1` namespace, add it to that list.
