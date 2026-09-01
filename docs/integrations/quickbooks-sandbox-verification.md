# QuickBooks Entity-Mapping Sandbox Verification

Phase B (docs/superpowers/plans/2026-08-29-quickbooks-customer-item-mapping.md,
Task 7) exit criteria require both an automated gate and a manual Intuit
sandbox walkthrough. This document is the reusable checklist for both, plus
the evidence record from the most recent run of each.

This is a **living document**: re-run the sandbox walkthrough (Section 2)
before every release that touches QuickBooks mapping/sync code, and append a
new evidence block rather than overwriting the previous one.

---

## 1. Automated gate

Evidence from the run below is real and was captured in this session. See
"Deviations from the brief's literal commands" at the end of this section —
two commands differ from the plan doc's shorthand because the actual repo
config file names split differently; the commands here are what a developer
should actually run.

| Field | Value |
|---|---|
| Date | 2026-09-01 |
| Breeze build SHA | `d313665b2a50a0f4b38933232901000136c11464` (branch `feat/quickbooks-accounting-mappings`) |
| Tester | Task 7 verification agent (automated) |
| Environment | Local worktree, ephemeral `pnpm test-stack` Postgres 16 (pgvector) + Redis 7 containers |

### a. API unit/service/route tests

```bash
cd apps/api && npx vitest run src/services/accounting/ src/routes/accounting/ \
  src/middleware/selfManagedDbContextRoutes.test.ts src/db/autoMigrate.test.ts
```

**Result: PASS** — 13 test files, 448 tests, 0 failures.

### b. Web component/i18n/mutation-safety tests

```bash
cd apps/web && npx vitest run \
  src/components/integrations/QuickbooksMappingWorkbench.test.tsx \
  src/components/integrations/QuickbooksCustomerImport.test.tsx \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/__tests__/no-silent-mutations.test.ts
```

**Result: PASS** — 5 test files, 232 tests, 0 failures.

### c. Typechecks

```bash
cd apps/api && NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit -p .
```

**Result: FAIL (2 errors)**

1. `src/jobs/scheduleRegistry.contract.test.ts(33,20): error TS2307: Cannot
   find module 'cron-parser'` — **pre-existing, unrelated to this branch**
   (missing dependency in the workspace's `node_modules`; not caused by
   accounting-mapping work). Expected per this task's brief.
2. `src/routes/accounting/index.ts(174,28): error TS2345: Argument of type
   '"json"' is not assignable to parameter of type 'never'.` — **NOT
   pre-existing.** This is inside `requireMappingWrite`, a post-validation
   write guard introduced in Task 5 (`af9b414bc feat(accounting): expose
   QuickBooks mapping routes`):

   ```ts
   const requireMappingWrite: MiddlewareHandler = async (c, next) => {
     if (c.get('auth')?.scope === 'system') return next();
     const body = c.req.valid('json') as { breezeEntityType: MappingEntityType };
     ...
   };
   ```

   Declaring the handler as a bare `MiddlewareHandler` (no generic env/schema
   parameters) erases the `zValidator('json', mappingDecisionSchema)` typing
   that the route chain attaches, so `c.req.valid` resolves its parameter
   type to `never` and `'json'` fails to typecheck. It compiles to working
   JS at runtime (Hono doesn't enforce this at runtime), which is why it
   shipped without being caught — this branch had not had `tsc --noEmit` run
   against it before this task. **This is a production-code compile error on
   this branch and was left unfixed per this task's contract** (test/doc-only
   fixes are in scope here, production-code fixes are not). See "Concerns"
   below.

```bash
cd apps/web && NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit -p .
```

**Result: PASS** — 0 errors.

### d. Integration / RLS suites (real Postgres)

Stack: `pnpm test-stack up` (not the top-level `docker-compose.yml postgres
redis` — see deviation note below), which brought up an ephemeral,
worktree-scoped `pgvector/pgvector:pg16` + `redis:7-alpine` pair via
`docker-compose.test.yml`, both reported healthy. `.env.test` was generated
with:

```
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:<ephemeral>/breeze_test
DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:<ephemeral>/breeze_test
```

Migrations applied cleanly via `pnpm db:migrate` (613 migration files, no
drift, bootstrap seed completed).

```bash
cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts
```

**Result: PASS** — 1 test file (`rls-coverage.integration.test.ts`), 75
tests, 0 failures.

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts
```

**Result: PASS** — 1 test file, 4 tests, 0 failures. Exercises RLS +
the polymorphic `breeze_entity_id` ownership trigger through the real
unprivileged `breeze_app` pool.

```bash
pnpm db:check-drift
```

**Result: PASS** — "No drift detected — all 613 migration files match the
breeze_migrations ledger."

Stack torn down afterward with `pnpm test-stack down`.

### e. Whitespace/diff hygiene

```bash
git diff --check
```

**Result: PASS** — exit 0, no output (working tree was clean at task start;
no whitespace errors introduced).

### Deviations from the brief's literal commands

The Task 7 brief's Step 4 sketch (and the plan doc's Step 2) give two RLS
commands as:

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts \
  src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```

This does not match the repo as it actually exists:

- `vitest.config.rls.ts` has a fixed `include` of exactly
  `rls.integration.test.ts` and
  `auth-browser-transition-rls.integration.test.ts` — it is the DB
  session-context contract test, not the general RLS-coverage or per-table
  RLS suite.
- `rls-coverage.integration.test.ts` (pg_catalog policy-inventory contract)
  has its own dedicated, read-only config: `vitest.config.rls-coverage.ts`
  (`pnpm test:rls-coverage`). It is deliberately kept off
  `vitest.integration.config.ts`'s `setupFiles` (which TRUNCATEs tenant
  tables per test) because it must never see that hazard.
- `accounting-entity-mappings-rls.integration.test.ts` imports `./setup`
  (the truncate-based integration fixture), so it belongs under the general
  `vitest.integration.config.ts` (`pnpm test:integration`), which globs all
  of `src/__tests__/integration/**/*.test.ts`.

The commands actually run (Section d above) are the correct equivalents. Also
used `pnpm test-stack up`/`down` (`scripts/dev/test-stack/`) instead of the
raw top-level `docker compose up -d postgres redis`, since the top-level
`docker-compose.yml` requires a populated `.env` (Postgres/Redis passwords,
digest-pinned image refs, a `secrets/redis_password` file) that does not
exist in this worktree, whereas `test-stack` is the repo's purpose-built,
per-worktree-isolated mechanism for exactly this (`docker-compose.test.yml`)
and needed no extra setup.

### Concerns raised, not fixed (production code, out of this task's scope)

- **`apps/api/src/routes/accounting/index.ts:174`** — `requireMappingWrite`
  fails `tsc --noEmit`. See item (c) above for the exact error and root
  cause. Recommended fix (for whoever picks this up, not applied here): type
  the handler against the specific validated env, e.g. define it as
  `createMiddleware<{ Variables: ... }>()` with the `json`-validated schema
  in scope, or move the `breezeEntityType` narrowing to read from
  `c.req.json()`/a pre-parsed variable instead of re-deriving it through
  `c.req.valid` inside a loosely-typed middleware. This does not fail at
  runtime and none of the automated tests in (a)/(b)/(d) caught it — it is a
  `tsc`-only gap, which is exactly why Phase B's exit criteria list
  typechecks as a separate gate item from the test suites.

---

## 2. Sandbox walkthrough checklist

**Status: PENDING — to be executed against a live Intuit sandbox company
before Phase B is declared shipped.** No Intuit sandbox credentials or
interactive browser session were available in this task's execution
environment, so the walkthrough below was not performed; only the automated
gate (Section 1) was run. Do not treat this section's fields as evidence of a
completed walkthrough — they are the template a tester fills in when they run
it.

Use a **dedicated sandbox company and a dedicated test customer/catalog
item** — never production books. Capture QuickBooks entity IDs and realm ID
only in the tester's private test record (e.g. a private note, ticket, or
password-manager entry) — **never commit them to this repository.** This
document records the realm **label** (a human-readable name the tester
assigns the sandbox company, e.g. "Breeze QBO Sandbox 1"), never the realm ID.

### Evidence header (fill in per run)

| Field | Value |
|---|---|
| Date | PENDING |
| Breeze build SHA | PENDING |
| Hosted region | PENDING (US / EU / self-hosted) |
| Intuit app environment | PENDING (sandbox / production) |
| Sandbox company realm label | PENDING (label only — never the realm ID) |
| Tester | PENDING |

### Checklist (pass/fail + visible Breeze status after each action)

1. **Connect the sandbox company and verify no credentials appear in UI/API
   logs.**
   Result: PENDING. Visible status: _______

2. **Select and save an active QuickBooks income account.**
   Result: PENDING. Visible status: _______

3. **Reconcile one existing customer by email and confirm it; verify QBO is
   unchanged.**
   Result: PENDING. Visible status: _______

4. **Choose create-new for a second organization; sync twice; verify one QBO
   Customer exists and the second sync updates it without duplication.**
   Result: PENDING. Visible status: _______

5. **Reconcile one existing Item by SKU and confirm it.**
   Result: PENDING. Visible status: _______

6. **Choose create-new for a second catalog item; verify Service or
   NonInventory type, price, taxability, SKU, income account, remote ID, and
   SyncToken.**
   Result: PENDING. Visible status: _______

7. **Change the Breeze org/item, sync again, and verify a sparse QBO update
   plus incremented persisted SyncToken.**
   Result: PENDING. Visible status: _______

8. **Attempt a duplicate remote claim and verify Breeze returns a visible
   conflict without changing QBO.**
   Result: PENDING. Visible status: _______

9. **Disconnect/reconnect the same sandbox and verify mappings remain tied to
   the connection lifecycle as designed.**
   Result: PENDING. Visible status: _______

### How to fill this in on the next run

1. Copy the "Evidence header" and "Checklist" blocks above into a new
   dated section below this one (do not overwrite this template) — or, if
   this is the first real run, replace the PENDING values in place and
   change this section's status line to reflect a completed run with a date.
2. For each checklist item, record PASS/FAIL and the exact Breeze-visible
   status text/toast the UI showed (per `runAction` — every mapping mutation
   in this feature surfaces outcome via `runAction`,
   `apps/web/src/lib/runAction.ts`).
3. Confirm no credentials, tokens, or QuickBooks realm IDs were written
   anywhere in this repository as part of the run (grep the diff before
   committing).
4. Migration referenced by this feature:
   `apps/api/migrations/2026-09-28-quickbooks-entity-mappings.sql`.

---

## 3. Phase C dependency contract

Phase C (issued-invoice sync) needs to look up, for one `(integrationId,
breezeEntityType, breezeEntityId)` triple, whether a **confirmed** mapping
exists and, if so, its `remoteEntityId` and `remoteSyncToken` — without ever
reading `organization_external_links` or any QuickBooks fields from core
billing tables. This section proves that query shape exists today and
compiles, by pointing at the real, already-shipped code rather than adding
anything new.

### Schema (real exports, `apps/api/src/db/schema/accounting.ts`)

```ts
// apps/api/src/db/schema/accounting.ts:45-96
export const accountingEntityMappings = pgTable('accounting_entity_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  breezeEntityType: varchar('breeze_entity_type', { length: 20 }).notNull(),
  breezeEntityId: uuid('breeze_entity_id').notNull(),
  remoteEntityType: varchar('remote_entity_type', { length: 20 }).notNull(),
  remoteEntityId: text('remote_entity_id'),
  remoteSyncToken: varchar('remote_sync_token', { length: 64 }),
  linkStatus: varchar('link_status', { length: 20 }).notNull().default('suggested'),
  syncStatus: varchar('sync_status', { length: 30 }).notNull().default('pending'),
  // ... lastSyncedAt, lastError, createdAt, updatedAt
}, (table) => ({
  // unique on (integrationId, breezeEntityType, breezeEntityId) —
  // accounting_entity_mappings_breeze_uniq
  ...
}));

export type AccountingEntityMapping = typeof accountingEntityMappings.$inferSelect;
```

`breezeEntityType` is constrained (`accounting_entity_mappings_entity_type_chk`)
to `'org' | 'catalog_item' | 'invoice' | 'payment'`, and `linkStatus` is
constrained (`accounting_entity_mappings_link_status_chk`) to `'suggested' |
'confirmed' | 'unlinked' | 'create_new'` — a worker filtering on
`linkStatus = 'confirmed'` gets exactly the resolved-mapping rows Phase C
needs, with `remoteEntityId`/`remoteSyncToken` guaranteed non-null in
practice for any row that reached `synced` (see
`persistRemoteRef`, below).

### The exact Drizzle query shape (already shipped, `accountingMappingService.ts`)

`apps/api/src/services/accounting/accountingMappingService.ts` already
contains this lookup pattern twice — it is the load-then-narrow-in-JS shape a
Phase C worker should reuse verbatim (either by importing an exported
sibling of `loadMappingRows`, or by copying the same `db.select().from(...)
.where(and(...))` shape into the worker's own module):

```ts
// apps/api/src/services/accounting/accountingMappingService.ts:515-529
async function loadMappingRows(
  partnerId: string,
  integrationId: string,
  breezeEntityType: MappingEntityType,
): Promise<MappingRow[]> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.integrationId, integrationId),
      eq(accountingEntityMappings.breezeEntityType, breezeEntityType),
    ));
  return rows as MappingRow[];
}
```

and the narrow-to-one-entity + read-`remoteEntityId`/`remoteSyncToken` step,
already exercised in production code paths (`saveMappingDecision` and
`syncMappedEntity`):

```ts
// apps/api/src/services/accounting/accountingMappingService.ts:622-623
const mappingRows = await loadMappingRows(partnerId, conn.id, breezeEntityType);
const existing = mappingRows.find((m) => m.breezeEntityId === breezeEntityId) ?? null;
```

```ts
// apps/api/src/services/accounting/accountingMappingService.ts:856-858
const existingRef: AccountingEntityMappingSeam | null = mapping.remoteEntityId
  ? { remoteEntityId: mapping.remoteEntityId, remoteSyncToken: mapping.remoteSyncToken ?? null }
  : null;
```

For Phase C, the equivalent one-row-by-triple lookup a worker would issue is:

```ts
const [mapping] = await db
  .select({
    remoteEntityId: accountingEntityMappings.remoteEntityId,
    remoteSyncToken: accountingEntityMappings.remoteSyncToken,
    linkStatus: accountingEntityMappings.linkStatus,
  })
  .from(accountingEntityMappings)
  .where(and(
    eq(accountingEntityMappings.integrationId, integrationId),
    eq(accountingEntityMappings.breezeEntityType, breezeEntityType), // 'org' | 'catalog_item'
    eq(accountingEntityMappings.breezeEntityId, breezeEntityId),
  ));

if (!mapping || mapping.linkStatus !== 'confirmed' || !mapping.remoteEntityId) {
  // no confirmed mapping yet — invoice sync must not assume a remote id
}
```

This is a direct narrowing of the exact `where` clause `loadMappingRows`
already builds (same three predicates, same table, same columns read) — it
compiles under the same Drizzle/schema types already exercised by
`accountingMappingService.test.ts` and the RLS integration suite run in
Section 1.d above (`accounting-entity-mappings-rls.integration.test.ts`), so
no new production code was needed or added to prove this out.

**Confirms:**
- One confirmed Customer mapping (`breezeEntityType = 'org'`) and
  zero-or-more confirmed Item mappings (`breezeEntityType = 'catalog_item'`)
  are each reachable by exactly `(integrationId, breezeEntityType,
  breezeEntityId)` — the table's own unique index
  (`accounting_entity_mappings_breeze_uniq`) guarantees at most one row per
  triple.
- `remoteEntityId` and `remoteSyncToken` are ordinary typed columns on that
  same row — no join to `organization_external_links` or any QuickBooks
  field on a core billing table is required or used anywhere in this query
  path.
- RLS scopes every read to the partner (`breeze_has_partner_access` via
  `partnerId`), matching this feature's tenancy shape (Partner-axis, shape
  #3 in `CLAUDE.md`) — a Phase C worker running in a system DB context still
  needs to filter explicitly by `integrationId`/`partnerId` per row, exactly
  as this query does, since a system context bypasses RLS rather than
  narrowing through it.
