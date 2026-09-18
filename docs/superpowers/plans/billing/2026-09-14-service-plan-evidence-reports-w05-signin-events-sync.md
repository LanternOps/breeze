---
issue: LanternOps/breeze#5784
wave: W05
spec: docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md
# tracking_issue: added by register_feature at Stage 4 — do not fill in by hand
---
# Evidence Reports W05: the `signin_events` Sync Domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start accumulating interactive Microsoft 365 sign-in events so W06 can
build the highest-value deliverable in the plan. **This wave produces no customer
artifact** — and it is worth a wave of its own precisely because Graph retains
sign-in logs only ~30 days, so the data can **only** accumulate forward from first
sync. Every week this wave is not shipped is a week W06 cannot report on.

**Architecture:** A seventh `m365_sync_domain`, `signin_events`, alongside the
existing six — **not** the existing `signin_activity` domain, which updates
exactly one column on `m365_users` and persists no events
(`apps/api/src/services/m365Sync/domains/signinActivity.ts:88-91`). A new
shape-1 table `m365_signin_events` (direct `org_id NOT NULL`, RLS enabled and
forced, one `FOR ALL` policy) holds interactive sign-ins only, with **no jsonb**
and no `connection_id`. The persister is an **append-only event** domain, not an
entity domain: idempotent upserts on `(org_id, graph_id)`, an overlapping bounded
delta window, and a checkpoint that advances only after pagination for the window
completes.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Vitest
(API unit with Drizzle mocks; API integration on real Postgres), the
`apps/m365-graph-read-executor` service, BullMQ.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md`
§3.5.1 (why an on-demand fetch does not work), §3.5.2 (the domain, the table, the
deliberate shape choices, the three limits the artifact must print), §4.1 (RLS),
§4.2 (registration lists), §4.4 (enum values), §4.6 (migration filenames), §9.1.

**Plan index:** `docs/superpowers/plans/billing/2026-09-14-service-plan-evidence-reports.md`

**Depends on:** **W01 only** (for nothing structural — W05 shares W01's migration
band and its rollout discipline). Independent of W02, W03 and W04. **W06 depends
on this wave.**

---

## Global Constraints

- **Consent does not change.** `AuditLog.Read.All` is already in
  `customer-graph-read` manifest **v3** (`packages/shared/src/m365/profiles.ts:107`)
  and is exactly the scope `/auditLogs/signIns` requires. **Identity Protection is
  explicitly out**: `IdentityRiskyUser.Read.All` / `IdentityRiskEvent.Read.All` are
  declared nowhere, and adding either is a manifest **v4** bump forcing every
  customer to re-consent. The `riskLevelAggregated` / `riskState` fields Graph
  returns **on the signIn resource itself** are available under `AuditLog.Read.All`
  and are persisted; the dedicated `identityProtection/riskyUsers` collection is
  **not** fetched.
- **Interactive sign-ins only.** Non-interactive, service-principal and
  managed-identity sign-ins are out of the first cut. Every string the feature
  emits says "interactive sign-ins", never "all sign-ins".
- **This is an append-only EVENT log, not an entity domain.** Inventory-style
  "unseen means stale" reconciliation must **not** be applied: marking an
  unreturned row stale would corrupt closed periods. `signinActivity.ts:39-42`
  already draws this "not an entity domain" distinction for its own sibling; this
  domain is the same in kind and different in shape — so it uses **neither**
  `planEntityWrites`/`markEntitiesStale` (the entity pattern used by `users`,
  `intune_devices`, `ca_policies`, `skus`) **nor** `signin_activity`'s
  update-in-place join.
- **Delta is an overlapping bounded window, not a bare watermark.** The next run's
  `since` is `MAX(signed_in_at)` for the org **minus an overlap** (Graph sign-in
  records surface with delay); writes are idempotent upserts on
  `(org_id, graph_id)`; and the checkpoint advances **only after pagination for
  the window completes** — a truncated page leaves the watermark where it was and
  returns a continuation.
- **Event time and ingestion time are separate columns** (`signed_in_at` vs
  `ingested_at`), so late-arriving events are detectable rather than silently
  changing a closed period's totals.
- **No jsonb, no bytea.** Keeping the raw Graph payload out means nothing lands in
  the `excludedOpen` export bucket and sign-in PII is limited to exactly the fields
  W06 renders. Compare `huntress_incidents.details` and `m365_ca_policies.conditions`,
  both `excludedOpen` for precisely this reason.
- **No `connection_id`.** The entity snapshot tables (`m365_users`,
  `m365_intune_devices`, …) carry none either; connection identity lives in
  `m365_sync_state`. Omitting it also removes the composite-FK direction question
  entirely. **If a later wave adds it, it must be `ON DELETE CASCADE` AND
  `DEFERRABLE INITIALLY IMMEDIATE`** — the org merge runs
  `SET CONSTRAINTS ALL DEFERRED` and a non-deferrable composite org FK aborts it
  with 23503.
- **Excluded from `ON_DEMAND_SYNC_DOMAINS`.** Like `signin_activity`, one
  technician pressing "Sync now" must not be able to spend a region's Graph
  budget.
- **Its own token bucket.** The 10-req/min-per-app-across-all-tenants limit that
  forces `signin_activity`'s 24 h floor applies to
  `/users?$select=signInActivity` — `apps/m365-graph-read-executor/src/signinLimiter.ts:1-14`
  says so in as many words. `/auditLogs/signIns` is a **different Graph surface**,
  so this domain gets its own bucket sized independently rather than sharing that
  one. It is still scheduled at the same 24 h default cadence.
- **Retention: 120 days**, purged by the existing `m365SyncRetentionWorker`.
  Monthly and quarterly deliverables both get a full prior period for comparison,
  and longer-horizon trend does not need raw rows because `previous.summary`
  carries the aggregates forward (W01's OD-11 contract).
- Migrations are idempotent, carry **no inner `BEGIN;`/`COMMIT;`**, and **write no
  rows** — so neither needs `SELECT set_config('breeze.scope','system',true);` and
  neither may be added to `migrationRlsScope.test.ts`'s frozen baseline (#4518).
- Migration filenames must sort after the newest on `origin/main` — re-check at the
  start of this wave.
- Run one API test file as `cd apps/api && npx vitest run <path>`. **Never**
  `pnpm --filter <pkg> test -- --run <path>`.
- Branch `feature/<parent#>-service-plan-evidence-reports/wave-<W05 sub-issue#>`,
  **targeting `main`**. PR body contains `Closes #<W05 sub-issue>`.

### Rollout gate — `M365_TENANT_SYNC_ENABLED`

**This wave is inert unless `M365_TENANT_SYNC_ENABLED` is on.** It is read at call
time by `isM365TenantSyncEnabled()` (`apps/api/src/config/env.ts:222-228`) and
defaults to `false`; with it off the ticker removes its repeat entry and nothing
syncs.

> Setting a value in `/opt/breeze/.env` is **necessary but not sufficient**.
> Compose interpolation only happens for variables listed in the service's
> `environment:` block, so `M365_TENANT_SYNC_ENABLED` must be present in
> `/opt/breeze/.env` **and** explicitly mapped in the `api` service's
> `environment:` block of `/opt/breeze/docker-compose.yml`. The same applies to
> the new `M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS` and the new limiter's rate var on
> the `m365-graph-read-executor` service. **Confirm per region, and confirm this
> wave is actually syncing, before W06's first artifact is promised to a
> customer** — a W06 report generated the week W05 lands covers almost nothing.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-17-094000-m365-sync-domain-signin-events.sql` | `ALTER TYPE m365_sync_domain ADD VALUE` — **alone in the file** |
| `apps/api/migrations/2026-10-17-094100-m365-signin-events.sql` | table + indexes + RLS enable/force/policy + grant |
| `apps/api/src/db/schema/m365Sync.ts` | `m365SyncDomainEnum` label + `m365SigninEvents` table |
| `apps/api/src/services/tenantCascade.ts` | `CORE_ORG_CASCADE_DELETE_ORDER` entry |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `CORE_TENANT_EXPORT_POLICY` entry, every column `included` |
| `apps/api/src/services/orgMergeRegistry.ts` | **`repoint-dedupe`, not a resolve-phase delete** — see Task 4 |
| `packages/shared/src/m365/sync.ts` (+ `.test.ts`) | the seventh domain + its cadence and bounds |
| `apps/api/src/services/m365Sync/lifecycle.ts` (+ test) | exclude from `ON_DEMAND_SYNC_DOMAINS` |
| `apps/m365-graph-read-executor/src/microsoft/signinEvents.ts` | the paged `/auditLogs/signIns` reader |
| `apps/m365-graph-read-executor/src/microsoft/readActions.ts`, `config.ts`, `signinEventsLimiter.ts` | action, item cap, own token bucket |
| `packages/shared/src/m365/readActions.ts` | the sync action + its projection allowlist |
| `apps/api/src/services/m365Sync/domains/signinEvents.ts` (+ `.test.ts`) | the append-only persister |
| `apps/api/src/services/m365Sync/run.ts` (+ `.test.ts`), `types.ts` | `DOMAIN_PERSISTERS` + implemented-domains |
| `apps/api/src/jobs/m365SyncRetentionWorker.ts` (+ `.test.ts`) | the 120-day event purge |
| `apps/api/src/__tests__/integration/m365SigninEvents.integration.test.ts` | RLS forge, delta, idempotency, retention |

---

### Task 1: The enum migration

**Files:**
- Create: `apps/api/migrations/2026-10-17-094000-m365-sync-domain-signin-events.sql`

**Interfaces:**
- Produces: the `m365_sync_domain` label `'signin_events'`.

**Alone in the file, and it must sort BEFORE Task 2's table migration.** A label
added by `ALTER TYPE` cannot be *used* until the adding transaction commits, and
`autoMigrate` wraps each file in one transaction. `…-094000-` sorts before
`…-094100-`, which is the whole reason for the two-file split.

- [ ] **Step 1: Re-check the newest migration on `origin/main`**

```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
```
If main gained something later than `2026-10-17-0941…`, rename **both** files
upward, keeping the enum file sorting first.

- [ ] **Step 2: Write the migration**

```sql
-- m365 sync: the signin_events domain (#5784 W05). Enum add ONLY, in its own
-- file and sorting BEFORE the table migration that uses it: a label added by
-- ALTER TYPE cannot be used until the transaction that added it commits, and
-- autoMigrate wraps each file in one transaction.
--
-- NOT the same as the existing 'signin_activity' domain, which updates one
-- column on m365_users (services/m365Sync/domains/signinActivity.ts:88-91) and
-- persists no events. This one is an append-only interactive sign-in log.
--
-- No rows are written, so no breeze.scope election is required. Idempotent.
ALTER TYPE m365_sync_domain ADD VALUE IF NOT EXISTS 'signin_events';
```

- [ ] **Step 3: Run the guards**

```bash
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: PASS. **Never** add this file to `migrationRlsScope.test.ts`'s frozen
baseline.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-17-094000-m365-sync-domain-signin-events.sql
git commit -m "feat(m365): signin_events sync domain enum label (#5784 W05)"
```

---

### Task 2: The table migration — shape 1, RLS enabled and forced

**Files:**
- Create: `apps/api/migrations/2026-10-17-094100-m365-signin-events.sql`

**Interfaces:**
- Produces: table `m365_signin_events`; unique index
  `m365_signin_events_org_graph_uniq`; index
  `m365_signin_events_org_signed_in_idx`; policy
  `m365_signin_events_org_access`.

**Tenancy shape 1, direct `org_id`.** RLS **enabled and forced**, with the single
`FOR ALL` policy the sibling M365 tables already use, **in the same migration that
creates the table — never deferred**. The template is
`apps/api/migrations/2026-10-16-170200-m365-tenant-sync-foundation.sql:321-358`.
`breeze_has_org_access` short-circuits TRUE under
`breeze_current_scope() = 'system'`, so the cross-org sync worker needs no second
policy — same as the six existing domains. There is **no partner axis and no
partner-wide read branch**: this is tenant telemetry, not config policy, so
`DUAL_AXIS_TENANT_TABLES` and the partner-wide SELECT branch do not apply.

The `GRANT` is deliberately **unguarded**. A `pg_roles` existence guard would turn
a missing `breeze_app` role into a silent success — migration recorded as applied,
RLS forced, zero app-role privileges — resurfacing much later as scattered 42501s.
Bare, it aborts the run loudly with 42704.

- [ ] **Step 1: Write the migration**

```sql
-- m365_signin_events (#5784 W05): interactive Microsoft 365 sign-ins, append-only.
--
-- Tenancy shape 1: direct org_id NOT NULL, RLS enabled + forced, one FOR ALL
-- breeze_has_org_access(org_id) policy created HERE, in the table's own
-- migration. Template: 2026-10-16-170200-m365-tenant-sync-foundation.sql:321-358.
--
-- Deliberate shape choices (spec §3.5.2):
--   * NO connection_id. The entity snapshot tables carry none either; connection
--     identity lives in m365_sync_state. Omitting it removes the composite-FK
--     direction question entirely. A later wave adding it MUST make it
--     ON DELETE CASCADE and DEFERRABLE INITIALLY IMMEDIATE — the org merge runs
--     SET CONSTRAINTS ALL DEFERRED and a non-deferrable composite org FK aborts
--     it with 23503.
--   * NO jsonb. The raw Graph payload stays out, so nothing lands in the
--     excludedOpen export bucket and sign-in PII is exactly the fields the
--     report renders.
--   * tenant_id is tenant PROVENANCE, following m365_secure_score_snapshots:
--     retained history outlives a disconnect/rebind (services/m365Sync/lifecycle.ts:84)
--     and must never be attributed to the tenant that replaced it.
--   * signed_in_at (Graph createdDateTime, the event time and the watermark) and
--     ingested_at are SEPARATE, so late-arriving events are detectable rather
--     than silently changing a closed period's totals.
--
-- DDL only: no rows are written, so no breeze.scope election is required.
-- Depends on 2026-10-17-094000-m365-sync-domain-signin-events.sql only for
-- ordering discipline; this file uses no new enum label.

CREATE TABLE IF NOT EXISTS m365_signin_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  graph_id TEXT NOT NULL,
  signed_in_at TIMESTAMPTZ NOT NULL,
  user_graph_id TEXT,
  user_principal_name TEXT,
  app_id TEXT,
  app_display_name TEXT,
  client_app_used TEXT,
  ip_address TEXT,
  location_city TEXT,
  location_country TEXT,
  conditional_access_status TEXT,
  status_error_code INTEGER,
  status_failure_reason TEXT,
  risk_level_aggregated TEXT,
  risk_state TEXT,
  is_interactive BOOLEAN,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- (org_id, graph_id) is what makes re-sync idempotent: the overlapping delta
-- window deliberately re-fetches recent events, and every write is an upsert.
CREATE UNIQUE INDEX IF NOT EXISTS m365_signin_events_org_graph_uniq
  ON m365_signin_events (org_id, graph_id);

-- The report's only access pattern: one org, one period, newest first. Also the
-- index the delta watermark query (MAX(signed_in_at) per org) rides.
CREATE INDEX IF NOT EXISTS m365_signin_events_org_signed_in_idx
  ON m365_signin_events (org_id, signed_in_at DESC);

ALTER TABLE m365_signin_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE m365_signin_events FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'm365_signin_events'
      AND policyname = 'm365_signin_events_org_access'
  ) THEN
    CREATE POLICY m365_signin_events_org_access ON public.m365_signin_events
      FOR ALL USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
END $$;

-- Unguarded on purpose (repo default): a pg_roles existence guard would turn a
-- missing breeze_app role into a SILENT success and resurface later as scattered
-- 42501s. Bare, it aborts loudly with 42704.
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.m365_signin_events TO breeze_app;
```

- [ ] **Step 2: Run the guards and apply twice**

```bash
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
pnpm test-stack up
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
```
Expected: guards PASS, second migrate a clean no-op.

- [ ] **Step 3: Forge a cross-tenant insert by hand as `breeze_app`**

```bash
docker exec -it <test-stack postgres> psql -U breeze_app -d breeze
```
Then, with **no** `breeze.scope` set, attempt
`INSERT INTO m365_signin_events (org_id, tenant_id, graph_id, signed_in_at) VALUES ('<some org>', gen_random_uuid(), 'x', now());`
Expected: `ERROR: new row violates row-level security policy for table
"m365_signin_events"`. **If it succeeds, stop and fix the policy before writing
any TypeScript** — every later "green" would be built on an unprotected table.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-17-094100-m365-signin-events.sql
git commit -m "feat(m365): m365_signin_events table with forced RLS (#5784 W05)"
```

---

### Task 3: Drizzle schema

**Files:**
- Modify: `apps/api/src/db/schema/m365Sync.ts`

**Interfaces:**
- Produces: `m365SyncDomainEnum` gains `'signin_events'`; `m365SigninEvents`;
  `type M365SigninEventRow`.

- [ ] **Step 1: Add the enum label and the table**

In `m365SyncDomainEnum` (`:34-41`), add `'signin_events'` after `'secure_score'`.
**Order matters for readability only** — the pg enum's label order is set by the
migration, and Drizzle's array is the type-level mirror; keep the two in the same
order to avoid confusing the next reader.

Then, modelled on `m365SecureScoreSnapshots` (`:231-257`):

```ts
/**
 * #5784 W05. Interactive Microsoft 365 sign-ins, append-only.
 *
 * NOT an entity domain: there is no core_hash, no is_stale and no stale_since,
 * and inventory-style "unseen means stale" reconciliation must never be applied
 * — marking an unreturned row stale would corrupt a closed reporting period.
 * Writes are idempotent upserts on (org_id, graph_id); the delta window
 * deliberately overlaps because Graph sign-in records surface with delay.
 *
 * No jsonb by design: the raw Graph payload stays out so nothing lands in the
 * excludedOpen export bucket and sign-in PII is exactly the fields the report
 * renders. No connection_id by design: connection identity lives in
 * m365_sync_state, and omitting it removes the composite-FK direction question.
 */
export const m365SigninEvents = pgTable(
  'm365_signin_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    /** The verified M365 tenant this row came from; history survives a rebind. */
    tenantId: uuid('tenant_id').notNull(),
    /** Graph signIn.id. (org_id, graph_id) is what makes re-sync idempotent. */
    graphId: text('graph_id').notNull(),
    /** Graph createdDateTime — the EVENT time, and the delta watermark. */
    signedInAt: timestamp('signed_in_at', { withTimezone: true }).notNull(),
    /** Stable id kept alongside the UPN, which is renameable. */
    userGraphId: text('user_graph_id'),
    userPrincipalName: text('user_principal_name'),
    /** Stable app id alongside the display name. */
    appId: text('app_id'),
    appDisplayName: text('app_display_name'),
    /** Legacy-auth detection. */
    clientAppUsed: text('client_app_used'),
    ipAddress: text('ip_address'),
    locationCity: text('location_city'),
    locationCountry: text('location_country'),
    /** success / failure / notApplied. */
    conditionalAccessStatus: text('conditional_access_status'),
    statusErrorCode: integer('status_error_code'),
    statusFailureReason: text('status_failure_reason'),
    /** From the signIn resource under AuditLog.Read.All — NOT Identity
     *  Protection, which would be a manifest v4 bump. Can come back as Graph's
     *  `hidden` sentinel without P2; the report renders that as unmeasured. */
    riskLevelAggregated: text('risk_level_aggregated'),
    riskState: text('risk_state'),
    isInteractive: boolean('is_interactive'),
    /** Separate from signed_in_at so late arrivals are detectable. */
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgGraphUniq: uniqueIndex('m365_signin_events_org_graph_uniq').on(table.orgId, table.graphId),
    orgSignedInIdx: index('m365_signin_events_org_signed_in_idx').on(table.orgId, table.signedInAt),
  }),
);

export type M365SigninEventRow = typeof m365SigninEvents.$inferSelect;
```

Confirm `text`, `integer`, `boolean`, `index` and `uniqueIndex` are already
imported in this file; add what is missing.

- [ ] **Step 2: Typecheck and drift check**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:check-drift
```
Expected: clean, no drift. A drift complaint about index ordering means the
Drizzle index definition and the SQL disagree — fix the Drizzle side, never the
shipped migration.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/m365Sync.ts
git commit -m "feat(m365): Drizzle schema for m365_signin_events (#5784 W05)"
```

---

### Task 4: The four registration lists — the step that gets missed

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/services/orgMergeRegistry.ts`

**Interfaces:**
- Produces: `CORE_ORG_CASCADE_DELETE_ORDER` gains `'m365_signin_events'`;
  `CORE_TENANT_EXPORT_POLICY` gains an entry with **every column `included`**;
  `orgMergeRegistry` gains a **`repoint-dedupe`** classification.

**A new `org_id` table is NOT done until it is in all of these.** Missing a
cascade list is a latent GDPR org-erasure bug — the org delete either strands rows
under a dead tenant or aborts on an FK violation. It has shipped or blocked CI
five times; code review caught it **0/5**, the contract tests **5/5**. Treat it as
a mechanical grep, not a judgement call.

Lists that **do not** apply, stated so nobody adds them:
- `DEVICE_ID_JOIN_POLICY_TABLES` / `CORE_DEVICE_CASCADE_DELETE_TABLES` /
  `CORE_DEVICE_ORG_DENORMALIZED_TABLES` — **no `device_id` column**.
- `AUDIT_ADMIN_REQUIRED_TABLES` — not append-only in the REVOKE-DELETE sense;
  DELETE is granted because retention purges it.
- `DUAL_AXIS_TENANT_TABLES` and the partner-wide SELECT branch — no partner axis.
- **`rls-coverage.integration.test.ts` needs no allowlist entry at all.** A plain
  shape-1 `org_id NOT NULL` table is **auto-discovered** by its
  `information_schema.columns` join on `column_name = 'org_id'`, provided the
  policies reference `breeze_has_org_access(org_id)` — which Task 2's do — and the
  table is not in `ORG_AXIS_POLICY_EXCLUDED_TABLES`, which it must not be.

> ### Deviation from the spec, with evidence — org merge is `repoint-dedupe`, not a resolve-phase delete
>
> Spec §4.2 says to classify `m365_signin_events` as a *resolve-phase snapshot*,
> "alongside the five existing M365 tables in `orgMergeCustomExecutors.ts:444`".
> **Do not do that.** Those five (`m365_sync_state`, `m365_users`,
> `m365_intune_devices`, `m365_ca_policies`, `m365_license_skus`) are classified
> `custom` with a resolve-phase `DELETE FROM … WHERE org_id = loser` for two
> reasons the registry states explicitly
> (`orgMergeRegistry.ts:410-421`, `orgMergeCustomExecutors.ts:423-449`): they
> carry composite FKs that would be violated at COMMIT, **and** every row is *"a
> re-derivable snapshot of a Microsoft tenant … the next run repopulates"*.
>
> Neither holds here. `m365_signin_events` carries **no composite FK** (that is
> the point of omitting `connection_id`), and it is **not re-derivable**: Graph
> retains sign-in logs only ~30 days, so a merge that deletes a year of a
> customer's sign-in history destroys evidence nothing can reproduce. The
> registry already draws exactly this distinction one screen further down
> (`orgMergeRegistry.ts:422-426`): *"History is NEVER deleted: it cannot be
> regenerated"* — `m365_secure_score_snapshots` and `m365_posture_rollups` are
> `repoint-dedupe` for that reason. `m365_signin_events` belongs with the history
> tables, and it has exactly the unique key such a classification needs.
>
> This is a correction to the spec's §4.2 row, not a deviation from Gate A: no
> Open Decision covers it, and the spec's own §3.5.2 retention rationale
> ("Breeze accumulates forward from first sync only … those events are
> unrecoverable") is the argument for treating it as history. **Say so in the PR
> body** so the reviewer sees the reasoning rather than a silent divergence.

- [ ] **Step 1: Write the failing contract check first**

With Task 2's migration applied to the test stack:

```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```
Expected: **FAIL**, naming `m365_signin_events` as an `org_id` table missing from
`CORE_ORG_CASCADE_DELETE_ORDER` and from `CORE_TENANT_EXPORT_POLICY`. **If both
pass, stop** — the migration did not apply to the test database and every later
"green" in this wave would be vacuous.

- [ ] **Step 2: Add the cascade entry, alphabetically**

In `apps/api/src/services/tenantCascade.ts`, insert `'m365_signin_events'`
**between `'m365_secure_score_snapshots'` (`:539`) and `'m365_sync_state'`
(`:540`)** — `se` < `si` < `sy` under `localeCompare`, which is what
`tenantCascade.integration.test.ts` asserts. The surrounding comment block
(`:526-532`) already explains that FK-children-before-parents is asserted
separately against a runtime `pg_constraint` read; this table's only FK is
`org_id → organizations`, and `organizations` is last in the array, so the
ordering is satisfied.

Do **not** add it to `AUDIT_ADMIN_REQUIRED_TABLES` (`:1039-1046`): DELETE is
granted because the retention worker purges this table.

- [ ] **Step 3: Add the export-policy entry — every column `included`**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, modelled on the
`m365_secure_score_snapshots` entry (`:343`) but with **no `excludedOpen`
members**, because there is no jsonb, bytea or credential column:

```ts
  "m365_signin_events": tablePolicy("org_id", {"included":["id","org_id","tenant_id","graph_id","signed_in_at","user_graph_id","user_principal_name","app_id","app_display_name","client_app_used","ip_address","location_city","location_country","conditional_access_status","status_error_code","status_failure_reason","risk_level_aggregated","risk_state","is_interactive","ingested_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

Every column is ordinary customer data or a tenant identifier. None matches
`SUSPICIOUS_NAME_PARTS` (password, hash, token, secret, credential, refresh, …),
so none needs `reviewedIncluded`. None is credential, private-key or verifier
material, so none needs `excludedSensitive`. **None is `json`, `jsonb` or
`bytea`** — which is the whole reason the table was designed without a payload
column.

- [ ] **Step 4: Add the org-merge classification — `repoint-dedupe`**

In `apps/api/src/services/orgMergeRegistry.ts`, beside the two history tables at
`:422-426`:

```ts
  // #5784 W05. History, NOT a re-derivable snapshot: Graph retains sign-in logs
  // ~30 days, so a merge that deleted these would destroy evidence nothing can
  // reproduce. Same disposition as the two tables above, and for the same stated
  // reason. Dedupe key is the Graph event id, which the unique index
  // m365_signin_events_org_graph_uniq (org_id, graph_id) already enforces:
  // a loser row whose graph_id already exists under the survivor is dropped,
  // the rest repoint. There is no composite FK to violate at COMMIT — the table
  // deliberately carries no connection_id.
  m365_signin_events: { kind: 'repoint-dedupe', key: ['graph_id'] },
```

Read the `repoint-dedupe` entries immediately above to confirm the exact field
spelling (`key`, and whether `keyWhere` is needed — it is not here, the index is
not partial).

- [ ] **Step 5: Re-run the contract suites**

```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: all green, each with a non-zero test count. `rls-coverage` should pass
**without** an allowlist edit — if it demands one, the policy is not using
`breeze_has_org_access(org_id)` and Task 2 needs fixing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "feat(m365): register m365_signin_events in cascade, export policy and org merge (#5784 W05)"
```

---

### Task 5: The seventh domain in the shared contract

**Files:**
- Modify: `packages/shared/src/m365/sync.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/m365Sync/lifecycle.ts` (+ its test)

**Interfaces:**
- Produces: `M365_SYNC_DOMAINS` gains `'signin_events'`;
  `M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS.signin_events = 24 * HOUR`;
  `M365_SYNC_DOMAIN_INTERVAL_BOUNDS.signin_events = { min: 24 * HOUR, max: 7 * 24 * HOUR }`;
  `ON_DEMAND_SYNC_DOMAINS` excludes it.

**Three total records break the build until updated.** Both interval maps are
`Record<M365SyncDomain, …>`, and `DOMAIN_PERSISTERS` (Task 8) is a **total**
`Record` on purpose — the comment at `apps/api/src/services/m365Sync/run.ts:220-225`
says so: *"a domain added to `M365SyncDomain` later is a compile error here
instead of a silent `noop` in production."*

- [ ] **Step 1: Update the assertion that names the domains, and watch it fail**

`packages/shared/src/m365/sync.test.ts:10-15` currently reads *"names exactly the
**six** persisted domains in schedule order"*. Change it to seven:

```ts
it('names exactly the seven persisted domains in schedule order', () => {
  expect(M365_SYNC_DOMAINS).toEqual([
    'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score', 'signin_events',
  ]);
  expect(new Set(M365_SYNC_DOMAINS).size).toBe(M365_SYNC_DOMAINS.length);
});
```

Run `cd packages/shared && npx vitest run src/m365/sync.test.ts`.
Expected: FAIL — the constant still has six.

- [ ] **Step 2: Add the domain, its cadence and its bounds**

In `packages/shared/src/m365/sync.ts`:

- `M365_SYNC_DOMAINS` (`:9-16`) gains `'signin_events'` **last**, matching the
  test's schedule order.
- `M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS` (`:23-30`) gains
  `signin_events: 24 * HOUR,`.
- `M365_SYNC_DOMAIN_INTERVAL_BOUNDS` (`:38-45`) gains
  `signin_events: { min: 24 * HOUR, max: 7 * 24 * HOUR },` — the same floor
  `signin_activity` carries, because this is the other expensive identity surface.

- [ ] **Step 3: Exclude it from on-demand sync**

`apps/api/src/services/m365Sync/lifecycle.ts:18-24` currently filters out exactly
`signin_activity`. Widen it and update the comment:

```ts
/**
 * Sign-in domains are excluded from on-demand: their Graph surfaces are
 * app-wide throttled, not per-tenant (spec §4.1), so one technician pressing
 * "Sync now" must not be able to spend the region's budget.
 *
 * `signin_events` (#5784 W05) hits /auditLogs/signIns, a DIFFERENT surface from
 * signin_activity's /users?$select=signInActivity — it has its own token bucket
 * rather than sharing that one — but the same on-demand reasoning applies.
 */
const NON_ON_DEMAND_DOMAINS: ReadonlySet<M365SyncDomain> = new Set(['signin_activity', 'signin_events']);

export const ON_DEMAND_SYNC_DOMAINS: readonly M365SyncDomain[] =
  M365_SYNC_DOMAINS.filter((domain) => !NON_ON_DEMAND_DOMAINS.has(domain));
```

Add a test in the lifecycle suite asserting `ON_DEMAND_SYNC_DOMAINS` contains
neither sign-in domain.

- [ ] **Step 4: Run to verify they pass**

```bash
cd packages/shared && npx vitest run src/m365/sync.test.ts && npx tsc --noEmit
cd ../../apps/api && npx vitest run src/services/m365Sync/ && npx tsc --noEmit -p tsconfig.json
```
Expected: the shared suite PASSES; the API typecheck **fails** on
`DOMAIN_PERSISTERS` and possibly `M365_SYNC_IMPLEMENTED_DOMAINS` — that is the
total-`Record` guard doing exactly its job. Tasks 6–8 satisfy it; do **not** widen
the Record to a Partial to make this green early.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/m365/sync.ts packages/shared/src/m365/sync.test.ts apps/api/src/services/m365Sync/lifecycle.ts
git commit -m "feat(m365): signin_events as the seventh sync domain, excluded from on-demand (#5784 W05)"
```

---

### Task 6: The executor's paged `/auditLogs/signIns` reader and its own token bucket

**Files:**
- Create: `apps/m365-graph-read-executor/src/microsoft/signinEvents.ts`
- Create: `apps/m365-graph-read-executor/src/signinEventsLimiter.ts` (+ test)
- Modify: `apps/m365-graph-read-executor/src/microsoft/readActions.ts`, `config.ts`
- Modify: `packages/shared/src/m365/readActions.ts`

**Interfaces:**
- Produces: the sync action `m365.sync.signinEvents` taking
  `{ since: string; until: string; continuation?: string }` and returning
  `{ items, continuation, truncated, sources }`; a projection allowlist naming
  exactly the persisted fields; `M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS` (default
  25 000, matching `_USERS` / `_DEVICES`).

**Why a new action rather than widening `m365.signins.list`.** The interactive
read action is capped at `sinceHours ≤ 168` (7 days) and `pageSize ≤ 50` over **at
most two pages — 100 rows, no continuation**
(`apps/m365-graph-read-executor/src/microsoft/readActions.ts:16-21` and `:128-146`).
A monthly review needs 30 days; a quarterly one 90. Widening the interactive
action would put pagination and a per-run time budget inside a technician-facing
read. The sync action is separate, paginated, bounded by
`M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS`, and uses the existing AES-256-GCM
continuation mechanism already built for `signin_activity`.

**Its own token bucket, not `signinLimiter`.** `signinLimiter.ts:1-14` throttles
`/users?$select=signInActivity`, whose 10-req/min limit is *per app across all
tenants*. `/auditLogs/signIns` is a different Graph surface with its own limits,
so sharing that bucket would needlessly starve both. Copy `signinLimiter.ts`'s
shape — including `tryTake` **never blocking**, so an empty bucket makes the caller
stop paging and hand back a continuation rather than holding an executor slot
asleep — and give it its own env-configurable rate.

- [ ] **Step 1: Write the failing reader tests**

```ts
it('pages until the window is exhausted and returns no continuation', async () => {
  graph.queue([{ value: [ev('1')], '@odata.nextLink': 'p2' }, { value: [ev('2')] }]);
  const res = await readSigninEvents(client, { since: SINCE, until: UNTIL });
  expect(res.items.map((i) => i.id)).toEqual(['1', '2']);
  expect(res.continuation).toBeNull();
  expect(res.truncated).toBe(false);
});

it('returns a continuation and truncated=true when the item cap is hit', async () => {
  graph.queue([{ value: manyEvents(30_000), '@odata.nextLink': 'p2' }]);
  const res = await readSigninEvents(client, { since: SINCE, until: UNTIL, maxItems: 25_000 });
  expect(res.continuation).toBeTruthy();
  expect(res.truncated).toBe(true);
});

it('stops paging without blocking when the token bucket is empty', async () => {
  limiter.drain();
  const res = await readSigninEvents(client, { since: SINCE, until: UNTIL });
  // tryTake NEVER blocks: an empty bucket hands back a continuation, which is
  // strictly better than holding an executor slot asleep (signinLimiter.ts:12-14).
  expect(res.continuation).toBeTruthy();
  expect(graph.callCount).toBeLessThan(2);
});

it('projects only the allowlisted fields — no raw payload leaves the executor', async () => {
  graph.queue([{ value: [{ ...ev('1'), deviceDetail: { browser: 'x' }, appliedConditionalAccessPolicies: [{ id: 'p' }] }] }]);
  const res = await readSigninEvents(client, { since: SINCE, until: UNTIL });
  expect(Object.keys(res.items[0]).sort()).toEqual(SIGNIN_EVENT_FIELDS.slice().sort());
});

it('reports an unlicensed tenant as a complete, zero-item success', async () => {
  graph.rejectWith({ status: 403, code: 'Authentication_RequestFromUnsupportedUserRole' });
  const res = await readSigninEvents(client, { since: SINCE, until: UNTIL });
  expect(res.sources.signinEvents).toBe('unlicensed');
  expect(res.items).toEqual([]);
});
```

Read the existing executor tests for the exact mock-client dialect and the
unlicensed-detection helper before writing these — `signin_activity` already
handles the unlicensed case (`domains/signinActivity.ts:12-14, 59`) and the
executor side of that detection is the shape to reuse.

- [ ] **Step 2: Run to verify they fail, then write the reader and the limiter**

The reader filters `createdDateTime ge {since} and createdDateTime lt {until}` and
`signInEventTypes` restricted to **interactive** sign-ins; orders by
`createdDateTime` ascending so a continuation resumes deterministically; pages
with `@odata.nextLink`; stops at `maxItems` or an empty bucket and returns a
continuation; and projects exactly:

```ts
export const SIGNIN_EVENT_FIELDS = [
  'id', 'createdDateTime', 'userId', 'userPrincipalName', 'appId', 'appDisplayName',
  'clientAppUsed', 'ipAddress', 'location', 'conditionalAccessStatus', 'status',
  'riskLevelAggregated', 'riskState', 'isInteractive',
] as const;
```

Nothing else leaves the executor. `location` is flattened to city/country by the
persister, and `status` to `errorCode` / `failureReason`.

Add `maxItemsSigninEvents: boundedInteger(source, 'M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS', 25_000, 1, 200_000),`
to `apps/m365-graph-read-executor/src/config.ts` beside the four existing caps
(`:226-229`).

- [ ] **Step 3: Register the action in both places**

`packages/shared/src/m365/readActions.ts` declares the action and its argument
shape (shared by the API and the executor);
`apps/m365-graph-read-executor/src/microsoft/readActions.ts` adds the dispatch
case delegating to `readSigninEvents`. **Do not touch the existing
`m365.signins.list` case (`:128-146`) or `SIGNIN_MAX_PAGES` (`:18`)** — the
interactive read action keeps its 7-day / 100-row cap.

- [ ] **Step 4: Run to verify they pass, then commit**

```bash
cd apps/m365-graph-read-executor && npx vitest run
cd ../../packages/shared && npx vitest run src/m365/ && npx tsc --noEmit
```

```bash
git add apps/m365-graph-read-executor packages/shared/src/m365/readActions.ts
git commit -m "feat(m365): paged /auditLogs/signIns sync reader with its own token bucket (#5784 W05)"
```

---

### Task 7: The append-only persister

**Files:**
- Create: `apps/api/src/services/m365Sync/domains/signinEvents.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `PersistContext`, `M365SyncActionResult`, `DomainPersistResult`
  (`apps/api/src/services/m365Sync/types.ts:67-81`); `m365SigninEvents` (Task 3).
- Produces: `persistSigninEvents(ctx, result): Promise<SigninEventsPersistResult>`
  where `SigninEventsPersistResult extends DomainPersistResult` and adds
  `{ continuation: string | null; unlicensed: boolean }` — the same extension
  shape `SigninPersistResult` uses (`domains/signinActivity.ts:9-14`).

**Neither existing pattern fits, and using either would be a bug.**
- The **entity** pattern (`planEntityWrites` / `markEntitiesStale`, used by
  `users`, `intune_devices`, `ca_policies`, `skus`) marks unreturned rows stale.
  Applied here it would mark **every event outside the delta window** stale on
  every run and corrupt closed periods.
- The **`signin_activity`** pattern updates one column on `m365_users` and
  persists no rows at all.

This domain inserts events with `ON CONFLICT (org_id, graph_id) DO UPDATE` — an
upsert, because the overlapping window deliberately re-fetches recent events and a
re-fetch must be a no-op, not a duplicate. `complete` is true only when the window
was fully paginated and nothing was truncated.

- [ ] **Step 1: Write the failing tests**

```ts
it('upserts on (org_id, graph_id) so a re-fetched event is not duplicated', async () => {
  await persistSigninEvents(ctx, resultWith([ev('g1'), ev('g1')]));
  expect(upserts).toHaveLength(1);
  expect(upserts[0].onConflictTarget).toEqual(['org_id', 'graph_id']);
});

it('NEVER marks unreturned rows stale', async () => {
  await persistSigninEvents(ctx, resultWith([ev('g2')]));
  // Entity-domain reconciliation would corrupt every closed reporting period.
  expect(staleCalls).toHaveLength(0);
});

it('reports complete=false and keeps the watermark when a continuation remains', async () => {
  const res = await persistSigninEvents(ctx, resultWith([ev('g3')], { continuation: 'c1' }));
  expect(res.complete).toBe(false);
  expect(res.continuation).toBe('c1');
});

it('reports complete=true for an unlicensed tenant with zero items', async () => {
  const res = await persistSigninEvents(ctx, { ...EMPTY, sources: { signinEvents: 'unlicensed' } });
  // An unlicensed tenant IS complete: there is nothing to enumerate. Same rule
  // signinActivity.ts:70-72 states for its own sibling.
  expect(res.unlicensed).toBe(true);
  expect(res.complete).toBe(true);
  expect(res.inserted).toBe(0);
});

it('stores the Graph `hidden` sentinel for risk fields rather than inventing a level', async () => {
  await persistSigninEvents(ctx, resultWith([{ ...ev('g4'), riskLevelAggregated: 'hidden', riskState: 'hidden' }]));
  expect(upserts[0].row.riskLevelAggregated).toBe('hidden');
});

it('flattens location and status into their own columns and keeps no payload', async () => {
  await persistSigninEvents(ctx, resultWith([{ ...ev('g5'), location: { city: 'Austin', countryOrRegion: 'US' }, status: { errorCode: 50126, failureReason: 'Invalid username or password' } }]));
  expect(upserts[0].row).toMatchObject({ locationCity: 'Austin', locationCountry: 'US', statusErrorCode: 50126 });
  expect(Object.keys(upserts[0].row)).not.toContain('location');
});

it('sets ingested_at independently of signed_in_at so late arrivals are detectable', async () => {
  await persistSigninEvents(ctx, resultWith([{ ...ev('g6'), createdDateTime: '2026-09-01T00:00:00Z' }]));
  expect(upserts[0].row.signedInAt).toEqual(new Date('2026-09-01T00:00:00Z'));
  expect(upserts[0].row.ingestedAt).toBeUndefined();   // DB default now()
});
```

- [ ] **Step 2: Run to verify they fail, then write the persister**

Run: `cd apps/api && npx vitest run src/services/m365Sync/domains/signinEvents.test.ts`
Expected: FAIL — module not found.

Write the module with a header comment that draws the same "not an entity domain"
distinction `signinActivity.ts:39-42` draws, and says explicitly that stale
reconciliation must never be applied here. Chunk the upserts with the existing
`M365_SYNC_PERSIST_CHUNK_SIZE` constant; reuse `writeEntityChunks` **only if** it
is a plain chunked-write helper with no staleness coupling — read it first, and if
it is entangled with `planEntityWrites`, write a local chunker instead.

- [ ] **Step 3: Add the delta-window helper**

The persister also owns the watermark. Export from the same module:

```ts
/**
 * The next run's window. `since` is MAX(signed_in_at) for the org MINUS an
 * overlap, because Graph sign-in records surface with delay — a bare watermark
 * would permanently skip anything that arrived late. Writes are idempotent
 * upserts on (org_id, graph_id), so the overlap costs nothing but a re-fetch.
 *
 * The checkpoint advances ONLY after pagination for the window completes: a
 * truncated page leaves the watermark where it was and returns a continuation.
 */
export const SIGNIN_EVENTS_OVERLAP_MINUTES = 60;

export async function signinEventsWindow(orgId: string, now: Date): Promise<{ since: string; until: string }>;
```

First run for an org: `since = now - 7 days` (Graph keeps ~30 but a cold start
should not try to pull a month in one go; the next runs catch up). Test both the
cold-start and the steady-state case.

- [ ] **Step 4: Run to verify they pass, then commit**

Run: `cd apps/api && npx vitest run src/services/m365Sync/domains/signinEvents.test.ts`

```bash
git add apps/api/src/services/m365Sync/domains/signinEvents.ts apps/api/src/services/m365Sync/domains/signinEvents.test.ts
git commit -m "feat(m365): append-only signin_events persister with an overlapping delta window (#5784 W05)"
```

---

### Task 8: Register the persister — satisfying the total-`Record` guard

**Files:**
- Modify: `apps/api/src/services/m365Sync/run.ts` (+ `.test.ts`)
- Modify: `apps/api/src/services/m365Sync/types.ts`

**Interfaces:**
- Produces: `DOMAIN_PERSISTERS.signin_events = persistSigninEvents`;
  `M365_SYNC_IMPLEMENTED_DOMAINS` covers seven domains.

Task 5 deliberately left the API typecheck failing here. `DOMAIN_PERSISTERS`
(`run.ts:226-233`) is a **total** `Record<M365SyncDomain, M365DomainPersister | undefined>`
on purpose — its comment (`:220-225`) says a domain added to `M365SyncDomain`
later must be *"a compile error here instead of a silent `noop` in production."*

- [ ] **Step 1: Update the parity assertions, and watch them fail**

`run.test.ts:440-447` reads *"has a function for all **six** contracted domains"*.
Change the wording to seven and run
`cd apps/api && npx vitest run src/services/m365Sync/run.test.ts`.
Expected: FAIL — `DOMAIN_PERSISTERS` has no `signin_events` key.

- [ ] **Step 2: Add the entry**

```ts
  signin_events: persistSigninEvents,
```

with the import at the top. `M365_SYNC_IMPLEMENTED_DOMAINS` (`types.ts:115`) is
`= M365_SYNC_DOMAINS`, so it picks the new domain up automatically — confirm that
is still the case rather than assuming; if it has become a hand-written list,
add the domain there too.

- [ ] **Step 3: Confirm `writeCompletion` needs no change**

`writeCompletion` (`run.ts:368-387`) already sets `lastCompleteSnapshotAt` only
when `args.persisted.complete`, which is exactly the semantics Task 7's persister
produces. **Do not change it.** W03's and W06's generators read
`last_complete_snapshot_at` and a change here would silently alter every domain's
freshness.

- [ ] **Step 4: Run to verify they pass**

```bash
cd apps/api && npx vitest run src/services/m365Sync/ && npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, clean — the typecheck failure Task 5 introduced is now resolved by
implementation rather than by loosening the type.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365Sync/run.ts apps/api/src/services/m365Sync/run.test.ts apps/api/src/services/m365Sync/types.ts
git commit -m "feat(m365): register the signin_events persister (#5784 W05)"
```

---

### Task 9: The 120-day retention purge

**Files:**
- Modify: `apps/api/src/jobs/m365SyncRetentionWorker.ts` (+ `.test.ts`)

**Interfaces:**
- Produces: `SIGNIN_EVENTS_RETENTION_DAYS = 120` and a batched purge.

**`STALE_ENTITY_TABLES` is the wrong list.** It is a fixed array
(`m365SyncRetentionWorker.ts:39-44`) of tables whose **stale** rows expire, keyed
on `is_stale` / `stale_since` — columns `m365_signin_events` deliberately does not
have. This domain needs its own sweep: hard-delete events older than 120 days,
batched by `ctid` exactly as the existing loop does (`:52-69`).

**Why 120 days.** Monthly and quarterly deliverables both get a full prior period
for comparison, and longer-horizon trend does not need raw rows because
`previous.summary` carries the aggregates forward (W01's OD-11 contract). It is
also why the spec deferred a daily-aggregate tier rather than rejecting it: adding
one later over retained raw data is easy, recovering raw data from aggregates is
impossible.

- [ ] **Step 1: Write the failing test**

```ts
it('deletes sign-in events older than 120 days in batches', async () => {
  await runM365SyncRetention();
  const stmt = executed.find((s) => s.includes('m365_signin_events'));
  expect(stmt).toMatch(/signed_in_at\s*<\s*now\(\)\s*-\s*interval/i);
  expect(stmt).toMatch(/ctid IN \(/);
  expect(stmt).toMatch(/LIMIT 10000/);
});

it('does not add m365_signin_events to the stale-entity sweep', () => {
  // It has no is_stale / stale_since columns; the stale sweep would error.
  expect(STALE_ENTITY_TABLES).not.toContain('m365_signin_events');
});

it('keeps an event inside the retention window', async () => {
  // Guard against an off-by-one that would silently shorten a quarterly
  // deliverable's comparison window.
  expect(SIGNIN_EVENTS_RETENTION_DAYS).toBe(120);
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `cd apps/api && npx vitest run src/jobs/m365SyncRetentionWorker.test.ts`
Expected: FAIL.

Add the constant and a purge function modelled on the existing batched loop
(`:52-69`), deleting `WHERE signed_in_at < now() - interval '120 days'` with
`ctid IN (SELECT … LIMIT BATCH_SIZE)` until a batch deletes zero rows. Call it
from the worker's job body beside the stale-entity sweep, and log the total
deleted.

The worker already runs under a system DB context — confirm by reading its
wrapper rather than assuming, and match whatever the stale sweep uses.

- [ ] **Step 3: Run to verify it passes, then commit**

Run: `cd apps/api && npx vitest run src/jobs/m365SyncRetentionWorker.test.ts`

```bash
git add apps/api/src/jobs/m365SyncRetentionWorker.ts apps/api/src/jobs/m365SyncRetentionWorker.test.ts
git commit -m "feat(m365): 120-day retention purge for m365_signin_events (#5784 W05)"
```

---

### Task 10: Integration tests against real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/m365SigninEvents.integration.test.ts`

**Placement matters.** An integration test outside
`apps/api/src/__tests__/integration/` is picked up by **no** config and runs
**zero** tests while reporting success.

- [ ] **Case 1 — RLS forge, the load-bearing one.** Under an org-A request
  context, attempt to insert an `m365_signin_events` row with org B's `org_id`.
  Expect `new row violates row-level security policy` (42501). Then attempt to
  SELECT org B's rows and expect zero. **If either succeeds, stop the wave.**

- [ ] **Case 2 — system context writes across orgs.** Under
  `withSystemDbAccessContext`, insert rows for two orgs and read both back —
  proving the sync worker needs no second policy because
  `breeze_has_org_access` short-circuits TRUE under
  `breeze_current_scope() = 'system'`.

- [ ] **Case 3 — idempotent re-sync.** Persist the same batch of events twice.
  Assert the row count is unchanged and no unique-violation escaped. This is what
  makes the overlapping delta window safe.

- [ ] **Case 4 — the overlapping window and the watermark.** Persist a batch,
  call `signinEventsWindow`, and assert `since` is
  `MAX(signed_in_at) − SIGNIN_EVENTS_OVERLAP_MINUTES`, not `MAX(signed_in_at)`.
  Then persist a **truncated** result (continuation present) and assert
  `last_complete_snapshot_at` on the `m365_sync_state` row did **not** advance
  while `last_success_at` did — the exact distinction W03's and W06's generators
  depend on.

- [ ] **Case 5 — a late-arriving event does not silently rewrite a closed
  period.** Insert an event with `signed_in_at` inside a past period and
  `ingested_at` now. Assert both columns hold their own value, so a reader can
  detect the late arrival.

- [ ] **Case 6 — retention.** Insert events at 119 and 121 days old, run the
  purge, and assert the 119-day one survives and the 121-day one is gone.

- [ ] **Case 7 — org erasure and org merge.** Run the tenant cascade delete for an
  org with events and assert it completes with no FK violation and no stranded
  rows. Then merge org A into org B where **both** hold an event with the same
  `graph_id`: assert the merge completes, B keeps one row for that `graph_id`, and
  A's other events are **repointed, not deleted**. **This is the assertion that
  proves the Task 4 classification** — if the events vanish, the registry entry was
  written as a resolve-phase delete and a year of unrecoverable sign-in history
  would be destroyed on every merge.

- [ ] **Step 2: Run the suite**

```bash
pnpm test-stack up
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365SigninEvents.integration.test.ts
```
Expected: green with a **non-zero reported test count**.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/m365SigninEvents.integration.test.ts
git commit -m "test(m365): RLS forge, delta, idempotency, retention and merge coverage for signin events (#5784 W05)"
```

---

### Task 11: Wave verification and PR

- [ ] **Step 1: Unit suites** — `cd apps/api && npx vitest run`;
  `cd packages/shared && npx vitest run`;
  `cd apps/m365-graph-read-executor && npx vitest run` → all green.

- [ ] **Step 2: Typecheck and lint** —
  `cd apps/api && npx tsc --noEmit -p tsconfig.json`;
  `cd packages/shared && npx tsc --noEmit`; `pnpm lint` → clean.

- [ ] **Step 3: Contract suites on a live database**

```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/m365SigninEvents.integration.test.ts
```
→ green, each with a non-zero test count. **`pnpm test` does not run these**, and
this wave adds a table — it is exactly the case where a unit-green PR reddens
Integration Tests.

- [ ] **Step 4: Verify as `breeze_app` by hand, one more time**

```bash
docker exec -it <test-stack postgres> psql -U breeze_app -d breeze
```
Forge a cross-tenant insert. Expected: `new row violates row-level security
policy`. Do this even though Case 1 covers it — the suite runs through the app's
own context helpers, and this checks the raw role.

- [ ] **Step 5: Manual smoke** (`pnpm wt-stack up`, with
  `M365_TENANT_SYNC_ENABLED=true`). Connect a test tenant, wait for or trigger a
  sync tick, and confirm: `m365_sync_state` has a `signin_events` row; rows land
  in `m365_signin_events`; a second tick inserts no duplicates; and
  `ON_DEMAND_SYNC_DOMAINS` does not offer the domain in the "Sync now" UI.

- [ ] **Step 6: Tear down**

```bash
pnpm test-stack down && pnpm wt-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

- [ ] **Step 7: PR**

Against **`main`**, `Closes #<W05 sub-issue>`, linking the spec and the plan index,
with sections:

- **Tenancy** — new table `m365_signin_events`, shape 1, RLS enabled **and**
  forced with one `FOR ALL` `breeze_has_org_access(org_id)` policy created in the
  table's own migration; the hand-forged cross-tenant insert and its 42501; the
  three registration lists touched and the four that deliberately are not, with
  the reason for each.
- **The org-merge classification is a deliberate correction to the spec.** Spec
  §4.2 called for a resolve-phase delete alongside the five re-derivable M365
  snapshot tables; this PR classifies it `repoint-dedupe` alongside the two
  **history** tables instead, because Graph retains sign-in logs only ~30 days and
  a merge that deleted them would destroy evidence nothing can reproduce. Quote
  `orgMergeRegistry.ts:422-426` (*"History is NEVER deleted: it cannot be
  regenerated"*). Integration Case 7 proves it.
- **No consent change.** `AuditLog.Read.All` is already in `customer-graph-read`
  v3. Identity Protection is **out** — it would be a manifest v4 bump forcing every
  customer to re-consent. The `riskLevelAggregated` / `riskState` fields come from
  the signIn resource itself.
- **Scope of the event class** — interactive sign-ins only. Non-interactive,
  service-principal and managed-identity sign-ins are out of the first cut, and
  every string says "interactive sign-ins".
- **Throttle** — its own token bucket, not `signinLimiter`'s; excluded from
  `ON_DEMAND_SYNC_DOMAINS`; 24 h default cadence with a 24 h floor.
- **Rollout** — **no customer-visible change in this wave.**
  `M365_TENANT_SYNC_ENABLED` must be on for it to do anything, and a value in
  `/opt/breeze/.env` is necessary but not sufficient: it must also be mapped in
  the `api` service's `environment:` block of `/opt/breeze/docker-compose.yml`.
  The same applies to `M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS` and the new limiter rate
  on the `m365-graph-read-executor` service. **Ship this at least one full
  deliverable period before W06's first artifact is promised to a customer** —
  Graph keeps ~30 days, so the table can only accumulate forward and a W06 report
  generated the week this lands covers almost nothing.

Run `/pr-review-toolkit:review-pr`; act only on confirmed, consequential findings.
Enqueue with `gh pr merge <N>` on green — **never `--admin`**. The PR targets
`main`, so CI (including the blocking `integration-test` job) already ran; do not
hand-dispatch.

---

## Self-review

**Spec coverage.** §3.5.1 (why the interactive action cannot serve a monthly
review, and why a new paged sync action is needed instead) → Task 6, with the
existing action explicitly left alone. §3.5.2 the seventh domain, distinct from
`signin_activity` → Tasks 1, 3, 5; consent unchanged and Identity Protection out →
Global Constraints and the PR body; own token bucket → Task 6; excluded from
on-demand → Task 5 Step 3; the table's every column → Tasks 2 and 3; the four
deliberate shape choices (no `connection_id`, no jsonb, separate event/ingestion
time, overlapping bounded delta) → Tasks 2, 3, 7 and integration Cases 4 and 5;
per-run cap + continuation → Tasks 6 and 7; 120-day retention → Task 9 and
integration Case 6; the three limits the artifact must print (P1/P2 licence,
`hidden` risk sentinel, ~30-day Graph retention) → persisted faithfully here
(Task 7's unlicensed and `hidden` cases) and **rendered** by W06. §4.1 RLS in the
creating migration → Task 2; §4.2 registration lists → Task 4, with the org-merge
row corrected and the correction argued from the registry's own comments; §4.4
enum in its own file ahead of the table → Tasks 1 and 2; §4.5 no consent change →
Global Constraints; §4.6 filenames → Tasks 1 and 2 Step 1. §9.1 Test API
assertions (`sync.test.ts` six→seven, `run.test.ts` persister parity) → Tasks 5
and 8; Integration Tests list → Task 11 Step 3; RLS forge → Task 2 Step 3,
integration Case 1 and Task 11 Step 4.

**Placeholders.** Five places deliberately instruct a lookup rather than guessing,
each naming what to read: the executor's mock-client dialect and unlicensed
helper (Task 6 Step 1), whether `writeEntityChunks` is safe to reuse or is
entangled with `planEntityWrites` (Task 7 Step 2), whether
`M365_SYNC_IMPLEMENTED_DOMAINS` is still derived from `M365_SYNC_DOMAINS`
(Task 8 Step 2), the `repoint-dedupe` field spelling (Task 4 Step 4) and the
retention worker's DB-context wrapper (Task 9 Step 2). Each says what to do in
either case.

**Type consistency.** `m365SigninEvents`, `M365SigninEventRow`,
`persistSigninEvents`, `SigninEventsPersistResult`, `signinEventsWindow`,
`SIGNIN_EVENTS_OVERLAP_MINUTES`, `SIGNIN_EVENTS_RETENTION_DAYS`,
`readSigninEvents`, `SIGNIN_EVENT_FIELDS`, `M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS`,
`NON_ON_DEMAND_DOMAINS` and the domain literal `'signin_events'` are spelled
identically in every task that mentions them, and the literal matches the pg enum
label, the Drizzle enum member, `M365_SYNC_DOMAINS`, both interval records,
`DOMAIN_PERSISTERS` and the two sync tests. The table name
`m365_signin_events` is identical in the migration, the Drizzle table, all three
registration lists and the retention purge. `SigninEventsPersistResult` mirrors
`SigninPersistResult`'s extension shape (`domains/signinActivity.ts:9-14`) so the
run loop needs no special case.

**Cross-wave contracts.** This wave defines none of W01's four and consumes none
of them — it produces no report and touches no deliverable. What it owes **W06**
is: the table and its columns (Task 3), `signinEventsWindow`'s watermark semantics
(Task 7), the `unlicensed` and `hidden` sentinels W06 must render as unmeasured
(Task 7), and the `last_complete_snapshot_at` freshness contract W06 reads
unchanged (Task 8 Step 3, which explicitly forbids touching `writeCompletion`).
