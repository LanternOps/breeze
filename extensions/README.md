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

## Seam v2: manifest flags and ExtensionContext

### `agentRoutes` manifest flag

Set `agentRoutes: true` in `breeze-extension.json` when the extension mounts
routes under `/api/v1/<routeNamespace>/agent/` that are authenticated with
`ctx.agentAuthMiddleware` (device/agent tokens) rather than user sessions.
The core loader responds by registering that path prefix as a skip-prefix on
the global per-IP rate limiter (`registerGlobalRateLimitSkipPrefix`), the
same treatment core's own `/api/v1/agents/` and `/api/v1/helper/` routes get.
This is safe because agent-token auth carries its own per-agent/per-org
limits independent of the global per-IP bucket — device fleets share IPs
(NAT, proxies) and would otherwise collide with the same limit budget as
interactive dashboard traffic. Only set this flag for routes actually gated
by agent-token auth; do not use it to bypass rate limiting on user-facing
routes.

### `deviceOrgMoveDeleteTables` tenancy list

Register a `device_id`-bearing extension table here when its rows must be
**deleted**, not org_id-re-stamped, when a device moves to a different
organization (`PATCH` device org-move flow). Use this instead of
`deviceOrgDenormalizedTables` when the table's rows FK a source/config row
(e.g. an extension-owned sources/config table) that stays behind in the old
org — rewriting `org_id` on the child row alone would leave it pointing at a
parent row in a different tenant, corrupting cross-row consistency under RLS.
Core deletes these rows (via `getDeviceOrgMoveDeleteTables()`, which merges
core and extension registrations) in the same transaction as the org-move,
before the denormalized-column rewrite pass. Tables that don't have this FK
shape and can simply have `org_id` rewritten in place belong in
`deviceOrgDenormalizedTables` instead.

### New `ExtensionContext` members

- **`agentAuthMiddleware`** — Core's agent-token auth middleware. Apply it to
  any route intended for devices/agents rather than logged-in users; it
  validates the agent token, sets `c.get('agent')` to an
  `ExtensionAgentContext` (`deviceId`, `agentId`, `orgId`, `siteId`, `role`),
  and opens the request's org RLS context accordingly. Routes under this
  middleware should also be declared via the `agentRoutes` manifest flag (see
  above) so they're excluded from the global per-IP rate limiter — agent auth
  enforces its own per-agent/per-org limits instead.

- **`db`** — Core's ALS-bound Drizzle handle (`ExtensionDatabase`), scoped to
  the ambient request via Node's `AsyncLocalStorage`. It runs *inside* the
  same request-scoped RLS transaction core uses — the Postgres session GUCs
  that scope row visibility to the caller's org are already set, so plain
  queries against extension tables are automatically tenant-isolated as long
  as the tables carry an `org_id` column with RLS policies (see "Tenant
  Isolation / RLS" in the root `CLAUDE.md`). `ExtensionDatabase` is a
  structural type exposing only `execute()`; cast it to your own Drizzle
  database type to get full query-builder ergonomics:
  `const db = ctx.db as unknown as PostgresJsDatabase<typeof myExtensionSchema>;`
  The extension must pin the same `drizzle-orm` version as core to keep the
  wire format compatible.

- **`secrets`** — Column-bound `encryptForColumn(table, column, plaintext)` /
  `decryptForColumn(table, column, ciphertext)` helpers backed by core's
  encryption-at-rest primitives. Use these for any extension-owned secret
  column (API tokens, credentials, etc.) instead of rolling your own crypto.
  Important: extension secret columns are **not** entries in core's
  `encryptedColumnRegistry` (`apps/api/src/services/encryptedColumnRegistry.ts`)
  — that registry only tracks core tables. Key-rotation tooling built against
  `encryptedColumnRegistry` will not discover or rotate extension secret
  columns; an extension that stores encrypted secrets is responsible for its
  own key-rotation tooling and runbook.

- **`audit`** — `(event: ExtensionAuditEvent) => Promise<void>`. Queues an
  audit-log entry with fire-and-forget retry semantics (same pipeline core
  routes use via `createAuditLogAsync`). Call this after any state-changing
  action so it shows up in the org's audit trail; set `actorType: 'agent'`
  for actions taken by a device/agent (routes behind `agentAuthMiddleware`)
  versus `'user'` / `'api_key'` / `'system'` as appropriate. The call does
  not block on write completion, so don't rely on it for read-your-writes
  consistency.

## Trust boundary & lifecycle

- Anything that can write to `extensions/` or set `BREEZE_EXTENSIONS_DIR`
  can execute arbitrary code in the API process. Protect the extension
  directory like the API binary itself.
- Removing a previously migrated extension leaves its tables and data in
  place. Organization cascade-delete then fails loudly: the transaction rolls
  back with no partial erasure until the extension is restored, or its tables
  are dropped and its `<name>/` migration-ledger rows are deleted.
- `RESERVED_ROUTE_NAMESPACES` in `@breeze/extension-api` is maintained by
  hand. When core mounts a new `/api/v1` namespace, add it to that list (and
  to the ground-truth contract array in `packages/extension-api/src/index.test.ts`).
  Regenerate the inner-mount list with
  `grep -oE "api\.route\('/[a-z0-9-]+" apps/api/src/index.ts`, then add the
  outer-app mounts that bypass that router: `oauth`, `settings`, and the
  shortlink prefix `s`.
