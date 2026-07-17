# PSA P0-1 Stage 1 — Shared Accounting Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Stage 1 of the PSA P0-1 accounting sync (spec: `docs/superpowers/specs/2026-07-16-psa-p0-1-accounting-sync-design.md`): schema/migrations/RLS for all accounting-sync tables, connection instances + one-active-provider rule, the typed provider contract, the transactional outbox with fenced-lease workers, org/partner erasure pre-clears, accounting permissions, invoice-payment soft-void, and the legacy QBO-link backfill.

**Architecture:** All new tables are partner-axis (RLS shape 3) with composite partner-safe FKs into invoices/payments/orgs/catalog. Financial mutations will later (Stage 3) write `accounting_sync_operations` rows in the same Postgres transaction; this stage builds that outbox plus a relay → BullMQ → fenced-lease worker pipeline where the DB row, never Redis, is the source of truth. No provider HTTP is implemented in this stage — worker handlers are a registry that Stage 3 populates; tests drive the machinery with injected handlers.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL (hand-written SQL migrations), BullMQ + Redis, Vitest (unit: mocked Drizzle chain; integration: real Postgres on :5433 as `breeze_app`).

## Global Constraints

Every task implicitly includes these. Copied from the spec and repo contracts:

- **Migrations:** hand-written SQL in `apps/api/migrations/`, named `2026-07-21-<letter>-<slug>.sql` (letters force same-day ordering; the newest shipped migration is `2026-07-20-...`, so this prefix sorts last — **if newer migrations exist at execution time, bump the date so the new files still sort last**). Idempotent (`IF NOT EXISTS`, `DO $$` guards, `DROP POLICY IF EXISTS` then `CREATE`). **No inner `BEGIN;`/`COMMIT;`** (autoMigrate wraps each file in a transaction). Never edit a shipped migration. Cleanup/backfill statements report row counts via `GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING`.
- **RLS:** every new table gets `partner_id uuid NOT NULL REFERENCES partners(id)`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and ONE `FOR ALL TO breeze_app` policy `USING/WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))` — in the **same migration** that creates the table. Register each table in `PARTNER_TENANT_TABLES` (Task 7). No GRANT statements needed (ensureAppRole blanket-grants).
- **Column naming:** local-entity reference columns on accounting tables are named `organization_id` / `catalog_item_id` / `invoice_id` / `invoice_payment_id` — deliberately NOT `org_id`, so org-axis auto-discovery does not demand `breeze_has_org_access` policies. Consequence: NO automated contract covers org-erasure for these tables; Task 8's pre-clears + test are the only guard.
- **Status columns:** `varchar` + named `CHECK` constraint (matches `accounting_connections`; avoids enum-ALTER-in-transaction problems). Allowed values come verbatim from the shared SSOT tuples in Task 1.
- **BullMQ jobIds:** hyphen-separated only, never colons.
- **No provider HTTP inside a DB transaction** — Stage 1 has no provider HTTP at all; the worker handler signature (Task 14) receives no db transaction.
- **Money is integer cents** for comparison (`toCents`/`fromCents` from `invoiceService`-adjacent utils); `numeric(12,2)` in Postgres.
- **Tax variance threshold** (later stages): strictly greater than one minor unit of the connection currency.
- **Node:** v22.20.0 (`.nvmrc`). Wrong Node produces false test failures.
- **Commands:**
  - Unit tests (api): `pnpm --filter @breeze/api test <path>`
  - Integration tests: `cd apps/api && pnpm test:integration <path>` (needs Postgres on :5433 + Redis :6380; `pnpm test:docker` manages lifecycle)
  - RLS coverage: `cd apps/api && pnpm test:rls-coverage`
  - Typecheck: `cd apps/api && npx tsc --noEmit` (and `cd packages/shared && pnpm typecheck`)
  - Drift/ledger check: `cd apps/api && DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm db:check-drift`
- **Commit per task**, message style `feat(accounting): ...` / `test(accounting): ...`.
- Integration test DB context helpers: `db, withDbAccessContext, withSystemDbAccessContext` from `../../db`; fixtures via `createPartner`, `createOrganization` from `./db-utils`; RLS denials assert `rejects.toMatchObject({ cause: { code: '42501' } })`, CHECK violations `'23514'`, FK violations `'23503'`, unique `'23505'`.

## File Structure (locked decomposition)

| File | Responsibility |
|---|---|
| `packages/shared/src/types/accounting-sync-enums.ts` | SSOT tuples for every accounting status/state vocabulary (Task 1) |
| `apps/api/migrations/2026-07-21-a-accounting-sync-core-evolution.sql` | connections evolution, `invoices(id,partner_id)` uq, `invoice_payments` soft-void/origin (Task 2) |
| `apps/api/migrations/2026-07-21-b-accounting-entity-tax-mappings.sql` | `accounting_entity_mappings`, `accounting_tax_mappings` (Task 4) |
| `apps/api/migrations/2026-07-21-c-accounting-sync-operations.sql` | `accounting_sync_operations`, `accounting_sync_attempts` (Task 5) |
| `apps/api/migrations/2026-07-21-d-accounting-sync-inbound-tables.sql` | remote payments, allocations, webhook receipts, cursors, exceptions (Task 6) |
| `apps/api/migrations/2026-07-21-e-accounting-permissions.sql` | `accounting:*` permission rows + role grants (Task 9) |
| `apps/api/src/db/schema/accountingSync.ts` | Drizzle declarations for the 9 new tables (Tasks 4–6; composite FKs stay SQL-only per house style) |
| `apps/api/src/services/accounting/remoteTenantKey.ts` | versioned HMAC of provider tenant IDs (Task 11) |
| `apps/api/src/services/accounting/accountingOutbox.ts` | operation insert/coalesce/idempotency-key/payload-hash (Task 13) |
| `apps/api/src/services/accounting/accountingErasureGuard.ts` | live/ambiguous-work guard for org erasure (Task 8) |
| `apps/api/src/services/accounting/legacyLinkBackfill.ts` | legacy QBO org-link → mapping backfill (Task 15) |
| `apps/api/src/jobs/accountingSyncWorker.ts` | queue, relay, fenced-lease worker, repair sweep, handler registry (Task 14) |
| `apps/api/src/services/accounting/accountingConnectionService.ts` | + activate/soft-disconnect/tenant-hash backfill (Task 12) |
| `apps/api/src/services/accounting/types.ts` | typed provider contract (Task 10) |
| `apps/api/src/services/invoiceService.ts` | soft-void `voidPayment`, voided-aware recompute (Task 3) |
| `apps/api/src/services/tenantCascade.ts` | accounting org-erasure pre-clears (Task 8) |

Out of scope for Stage 1 (later stages): provider write implementations, webhook routes, reconciliation, mapping/setup/Sync Center UI and routes, wiring `createSyncOperation` into `invoiceService` mutations, dual-write of customer import.

---

### Task 1: Shared accounting-sync SSOT enums

**Files:**
- Create: `packages/shared/src/types/accounting-sync-enums.ts`
- Test: `packages/shared/src/types/accounting-sync-enums.test.ts`
- Modify: `packages/shared/src/index.ts` (barrel export)

**Interfaces:**
- Consumes: nothing.
- Produces: the exact tuples below. Every later task's `CHECK` constraint values, Drizzle defaults, and TS types derive from these. Types: `AccountingConnectionStatus`, `AccountingSyncDirection`, `AccountingSyncEntityType`, `AccountingOperationStatus`, `AccountingLinkState`, `AccountingErrorCategory`, `InvoicePaymentOrigin`, `AccountingExceptionStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/accounting-sync-enums.test.ts
import { describe, it, expect } from 'vitest';
import {
  ACCOUNTING_CONNECTION_STATUSES,
  ACCOUNTING_SYNC_DIRECTIONS,
  ACCOUNTING_SYNC_ENTITY_TYPES,
  ACCOUNTING_OPERATION_STATUSES,
  ACCOUNTING_LINK_STATES,
  ACCOUNTING_ERROR_CATEGORIES,
  INVOICE_PAYMENT_ORIGINS,
  ACCOUNTING_EXCEPTION_STATUSES,
} from './accounting-sync-enums';

describe('accounting-sync enums', () => {
  it('tuples contain the spec vocabulary exactly', () => {
    expect(ACCOUNTING_CONNECTION_STATUSES).toEqual([
      'pending_setup', 'connected', 'disconnecting', 'disconnected',
      'reauth_required', 'legacy_unverified', 'error',
    ]);
    expect(ACCOUNTING_SYNC_DIRECTIONS).toEqual(['outbound', 'inbound']);
    expect(ACCOUNTING_SYNC_ENTITY_TYPES).toEqual(['customer', 'item', 'invoice', 'payment', 'reconcile']);
    expect(ACCOUNTING_OPERATION_STATUSES).toEqual([
      'pending', 'queued', 'running', 'succeeded', 'succeeded_with_variance',
      'waiting_dependency', 'ambiguous', 'blocked', 'failed', 'canceled',
    ]);
    expect(ACCOUNTING_LINK_STATES).toEqual([
      'legacy_unverified', 'suggested', 'confirmed', 'create_approved', 'inactive',
    ]);
    expect(ACCOUNTING_ERROR_CATEGORIES).toEqual([
      'reauth_required', 'rate_limited', 'transient', 'ambiguous_write',
      'validation', 'not_found', 'conflict', 'configuration',
    ]);
    expect(INVOICE_PAYMENT_ORIGINS).toEqual(['manual', 'stripe', 'accounting_provider']);
    expect(ACCOUNTING_EXCEPTION_STATUSES).toEqual(['open', 'resolved', 'dismissed']);
  });

  it('no tuple contains duplicates', () => {
    for (const t of [
      ACCOUNTING_CONNECTION_STATUSES, ACCOUNTING_SYNC_DIRECTIONS, ACCOUNTING_SYNC_ENTITY_TYPES,
      ACCOUNTING_OPERATION_STATUSES, ACCOUNTING_LINK_STATES, ACCOUNTING_ERROR_CATEGORIES,
      INVOICE_PAYMENT_ORIGINS, ACCOUNTING_EXCEPTION_STATUSES,
    ]) {
      expect(new Set(t).size).toBe(t.length);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared test src/types/accounting-sync-enums.test.ts`
Expected: FAIL — cannot resolve `./accounting-sync-enums`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/types/accounting-sync-enums.ts
/**
 * Single source of truth for the accounting-sync (PSA P0-1) vocabularies.
 * Every layer derives from these tuples: SQL CHECK constraints (values copied
 * verbatim into hand-written migrations), Drizzle column defaults, API service
 * types, Zod validators, and the web UI. Values mirror the spec
 * (docs/superpowers/specs/2026-07-16-psa-p0-1-accounting-sync-design.md §8, §13).
 */
export const ACCOUNTING_CONNECTION_STATUSES = [
  'pending_setup', 'connected', 'disconnecting', 'disconnected',
  'reauth_required', 'legacy_unverified', 'error',
] as const;

export const ACCOUNTING_SYNC_DIRECTIONS = ['outbound', 'inbound'] as const;

export const ACCOUNTING_SYNC_ENTITY_TYPES = [
  'customer', 'item', 'invoice', 'payment', 'reconcile',
] as const;

export const ACCOUNTING_OPERATION_STATUSES = [
  'pending', 'queued', 'running', 'succeeded', 'succeeded_with_variance',
  'waiting_dependency', 'ambiguous', 'blocked', 'failed', 'canceled',
] as const;

export const ACCOUNTING_LINK_STATES = [
  'legacy_unverified', 'suggested', 'confirmed', 'create_approved', 'inactive',
] as const;

export const ACCOUNTING_ERROR_CATEGORIES = [
  'reauth_required', 'rate_limited', 'transient', 'ambiguous_write',
  'validation', 'not_found', 'conflict', 'configuration',
] as const;

export const INVOICE_PAYMENT_ORIGINS = ['manual', 'stripe', 'accounting_provider'] as const;

export const ACCOUNTING_EXCEPTION_STATUSES = ['open', 'resolved', 'dismissed'] as const;

export type AccountingConnectionStatus = (typeof ACCOUNTING_CONNECTION_STATUSES)[number];
export type AccountingSyncDirection = (typeof ACCOUNTING_SYNC_DIRECTIONS)[number];
export type AccountingSyncEntityType = (typeof ACCOUNTING_SYNC_ENTITY_TYPES)[number];
export type AccountingOperationStatus = (typeof ACCOUNTING_OPERATION_STATUSES)[number];
export type AccountingLinkState = (typeof ACCOUNTING_LINK_STATES)[number];
export type AccountingErrorCategory = (typeof ACCOUNTING_ERROR_CATEGORIES)[number];
export type InvoicePaymentOrigin = (typeof INVOICE_PAYMENT_ORIGINS)[number];
export type AccountingExceptionStatus = (typeof ACCOUNTING_EXCEPTION_STATUSES)[number];
```

- [ ] **Step 4: Export from the shared barrel**

Run: `grep -n "billing-enums" packages/shared/src/index.ts`
Add directly below the line that exports `./types/billing-enums`:

```ts
export * from './types/accounting-sync-enums';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @breeze/shared test src/types/accounting-sync-enums.test.ts`
Expected: PASS (2 tests). Then `cd packages/shared && pnpm typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/accounting-sync-enums.ts packages/shared/src/types/accounting-sync-enums.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): accounting-sync SSOT status/state vocabularies (PSA P0-1 Stage 1)"
```

---

### Task 2: Migration A — core-table evolution (connections, invoices, invoice_payments)

**Files:**
- Create: `apps/api/migrations/2026-07-21-a-accounting-sync-core-evolution.sql`
- Modify: `apps/api/src/db/schema/accounting.ts` (new columns/indexes on `accountingConnections`)
- Modify: `apps/api/src/db/schema/invoices.ts` (`invoices_id_partner_uq`; `invoicePayments` origin/void columns + `invoice_payments_id_invoice_uq`)

**Interfaces:**
- Consumes: Task 1 vocabulary values (copied verbatim into CHECKs).
- Produces: composite FK targets used by Tasks 4–6: `invoices(id, partner_id)` (unique `invoices_id_partner_uq`), `invoice_payments(id, invoice_id)` (unique `invoice_payments_id_invoice_uq`), plus existing `accounting_connections(id, partner_id)`, `organizations(id, partner_id)`, `catalog_items(id, partner_id)`. Drizzle columns: `accountingConnections.{remoteTenantKeyHash, remoteTenantKeyVersion, remoteCompanyName, isActive, activatedAt, deactivatedAt, disconnectedAt, archivedAt, defaultPaymentAccountRef, autoPostPausedAt, autoPostPauseReason, lastWebhookAt, lastReconcileAt}`; `invoicePayments.{origin, voidedAt, voidedBy, voidReason}`.

- [ ] **Step 1: Write the migration**

`invoices.partner_id` is already `NOT NULL` (`apps/api/src/db/schema/invoices.ts:28`) — the composite FK target is valid without a backfill. Do NOT drop `accounting_connections_partner_provider_idx` (shipped `upsertConnection` targets it with ON CONFLICT; it is removed by a later contract-phase migration, spec §8.12 step 5).

```sql
-- PSA P0-1 Stage 1 (spec §8.1, §8.2, §8.12 expand phase):
-- accounting_connections instance columns, invoices (id, partner_id) FK target,
-- invoice_payments origin + soft-void lifecycle.
-- Idempotent: IF NOT EXISTS / DO $$ guards. No inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- 1. accounting_connections: connection-instance columns (spec §8.1)
-- ---------------------------------------------------------------------------
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS remote_tenant_key_hash CHAR(64);
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS remote_tenant_key_version SMALLINT;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS remote_company_name VARCHAR(255);
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS default_payment_account_ref VARCHAR(64);
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS auto_post_paused_at TIMESTAMPTZ;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS auto_post_pause_reason VARCHAR(500);
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS last_reconcile_at TIMESTAMPTZ;

-- Normalize any out-of-vocabulary status before the CHECK lands. Count is
-- forensic evidence — never silently fix (repo migration rule).
DO $$
DECLARE n bigint;
BEGIN
  UPDATE accounting_connections
     SET status = 'error',
         last_error = COALESCE(last_error, 'status normalized by 2026-07-21-a migration')
   WHERE status NOT IN ('pending_setup','connected','disconnecting','disconnected',
                        'reauth_required','legacy_unverified','error');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'accounting_connections status normalization: % rows', n; END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_connections_status_chk'
      AND conrelid = 'accounting_connections'::regclass
  ) THEN
    ALTER TABLE accounting_connections
      ADD CONSTRAINT accounting_connections_status_chk
      CHECK (status IN ('pending_setup','connected','disconnecting','disconnected',
                        'reauth_required','legacy_unverified','error'));
  END IF;
END $$;

-- Hash and version travel together (spec review revision: MATCH SIMPLE nulls).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_connections_tenant_hash_version_chk'
      AND conrelid = 'accounting_connections'::regclass
  ) THEN
    ALTER TABLE accounting_connections
      ADD CONSTRAINT accounting_connections_tenant_hash_version_chk
      CHECK ((remote_tenant_key_hash IS NULL) = (remote_tenant_key_version IS NULL));
  END IF;
END $$;

-- Shipped single-connection partners are implicitly the active posting target.
-- Activate exactly one connected, credentialed row per partner (oldest first).
DO $$
DECLARE n bigint;
BEGIN
  UPDATE accounting_connections c
     SET is_active = TRUE,
         activated_at = COALESCE(c.activated_at, now())
   WHERE c.status = 'connected'
     AND c.access_token_encrypted IS NOT NULL
     AND c.refresh_token_encrypted IS NOT NULL
     AND c.is_active = FALSE
     AND NOT EXISTS (
       SELECT 1 FROM accounting_connections o
        WHERE o.partner_id = c.partner_id AND o.is_active AND o.id <> c.id
     )
     AND c.id = (
       SELECT x.id FROM accounting_connections x
        WHERE x.partner_id = c.partner_id AND x.status = 'connected'
        ORDER BY x.created_at, x.id LIMIT 1
     );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'accounting_connections active-flag backfill: % rows', n; END IF;
END $$;

-- A disconnected/legacy stub cannot be activated by flipping one column (spec §8.1).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_connections_active_connected_chk'
      AND conrelid = 'accounting_connections'::regclass
  ) THEN
    ALTER TABLE accounting_connections
      ADD CONSTRAINT accounting_connections_active_connected_chk
      CHECK ((NOT is_active)
             OR (status = 'connected'
                 AND access_token_encrypted IS NOT NULL
                 AND refresh_token_encrypted IS NOT NULL));
  END IF;
END $$;

-- Connection-instance identity (spec §8.1). The legacy full
-- (partner_id, provider) unique index intentionally REMAINS until the
-- Stage-5-era contract migration.
CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_partner_provider_tenant_uq
  ON accounting_connections (partner_id, provider, remote_tenant_key_hash)
  WHERE remote_tenant_key_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_pending_stub_uq
  ON accounting_connections (partner_id, provider)
  WHERE remote_tenant_key_hash IS NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_one_active_uq
  ON accounting_connections (partner_id)
  WHERE is_active = TRUE;

-- ---------------------------------------------------------------------------
-- 2. invoices: partner-safe composite FK target (spec §8.2)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS invoices_id_partner_uq ON invoices (id, partner_id);

-- ---------------------------------------------------------------------------
-- 3. invoice_payments: origin + soft-void lifecycle (spec §8.2)
-- ---------------------------------------------------------------------------
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS origin VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP;
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id);
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS void_reason VARCHAR(500);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoice_payments_origin_chk'
      AND conrelid = 'invoice_payments'::regclass
  ) THEN
    ALTER TABLE invoice_payments
      ADD CONSTRAINT invoice_payments_origin_chk
      CHECK (origin IN ('manual','stripe','accounting_provider'));
  END IF;
END $$;

-- A voided allocation always records why (spec §8.2).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoice_payments_void_reason_chk'
      AND conrelid = 'invoice_payments'::regclass
  ) THEN
    ALTER TABLE invoice_payments
      ADD CONSTRAINT invoice_payments_void_reason_chk
      CHECK (voided_at IS NULL OR void_reason IS NOT NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_id_invoice_uq
  ON invoice_payments (id, invoice_id);

-- Origin backfill (spec §8.2): rows linked from invoice_stripe_payments are
-- 'stripe'; the column default already made everything else 'manual'.
-- The spec requires BOTH counts reported.
DO $$
DECLARE n bigint;
BEGIN
  UPDATE invoice_payments p
     SET origin = 'stripe'
    FROM invoice_stripe_payments s
   WHERE s.invoice_payment_id = p.id
     AND p.origin = 'manual';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'invoice_payments stripe-origin backfill: % rows', n; END IF;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM invoice_payments WHERE origin = 'manual';
  RAISE WARNING 'invoice_payments manual-origin rows after backfill: %', n;
END $$;
```

- [ ] **Step 2: Update the Drizzle declarations**

In `apps/api/src/db/schema/accounting.ts`, extend the import line to include `boolean, smallint` and add after the existing `lastError` column (keep every existing column untouched):

```ts
  remoteTenantKeyHash: char('remote_tenant_key_hash', { length: 64 }),
  remoteTenantKeyVersion: smallint('remote_tenant_key_version'),
  remoteCompanyName: varchar('remote_company_name', { length: 255 }),
  isActive: boolean('is_active').notNull().default(false),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  defaultPaymentAccountRef: varchar('default_payment_account_ref', { length: 64 }),
  autoPostPausedAt: timestamp('auto_post_paused_at', { withTimezone: true }),
  autoPostPauseReason: varchar('auto_post_pause_reason', { length: 500 }),
  lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
  lastReconcileAt: timestamp('last_reconcile_at', { withTimezone: true }),
```

In `apps/api/src/db/schema/invoices.ts`:
1. In the `invoices` table's index array, after the `invoices_id_org_uq` entry, add:

```ts
  // Composite-FK target for accounting partner binding (PSA P0-1 §8.2).
  // Created in SQL migration 2026-07-21-a; declared for documentation.
  uniqueIndex('invoices_id_partner_uq').on(t.id, t.partnerId)
```

2. In `invoicePayments`, after `createdAt`, add columns, and add the unique index to its index array:

```ts
  // PSA P0-1 §8.2: origin controls outbound echo suppression; soft-void keeps
  // the row for provenance. amount sums must filter voided_at IS NULL.
  origin: varchar('origin', { length: 20 }).notNull().default('manual'),
  voidedAt: timestamp('voided_at'),
  voidedBy: uuid('voided_by').references(() => users.id),
  voidReason: varchar('void_reason', { length: 500 }),
```

```ts
  uniqueIndex('invoice_payments_id_invoice_uq').on(t.id, t.invoiceId)
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Apply migrations on the integration DB and prove idempotency**

```bash
cd apps/api && pnpm test:integration src/__tests__/integration/tenantCascade.integration.test.ts
```
Expected: PASS (globalSetup applies the new migration; cascade contract still green — the new columns add no `org_id` table).

```bash
psql postgresql://breeze_test:breeze_test@localhost:5433/breeze_test -v ON_ERROR_STOP=1 -f migrations/2026-07-21-a-accounting-sync-core-evolution.sql
psql postgresql://breeze_test:breeze_test@localhost:5433/breeze_test -v ON_ERROR_STOP=1 -f migrations/2026-07-21-a-accounting-sync-core-evolution.sql
```
Expected: both runs exit 0 (WARNINGs about counts are fine; errors are not).

```bash
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm db:check-drift
```
Expected: exit 0 — ledger complete.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-21-a-accounting-sync-core-evolution.sql apps/api/src/db/schema/accounting.ts apps/api/src/db/schema/invoices.ts
git commit -m "feat(accounting): connection-instance columns, invoice partner FK target, payment soft-void schema (P0-1 Stage 1)"
```

---

### Task 3: Invoice payment soft-void service behavior

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts` (`voidPayment`, `recomputeInvoiceStatus`, `listPayments`, stripe-side insert)
- Modify: `apps/api/src/services/invoiceService.test.ts`
- Create: `apps/api/src/__tests__/integration/invoicePaymentSoftVoid.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 columns (`invoicePayments.voidedAt/voidedBy/voidReason/origin`).
- Produces: `voidPayment(paymentId: string, actor: InvoiceActor, opts?: { reason?: string })` — same return shape `{ invoice, audit }` as today; row is UPDATEd, never deleted. `recomputeInvoiceStatus` counts only `voided_at IS NULL` allocations. Stage 3 will rely on the retained row + `origin` for reversal/echo suppression.

- [ ] **Step 1: Update the unit tests (write failing tests first)**

In `apps/api/src/services/invoiceService.test.ts`, find the existing `voidPayment` tests (`grep -n "voidPayment" apps/api/src/services/invoiceService.test.ts`) and replace them with:

```ts
  it('voidPayment soft-voids (update, never delete) and recomputes', async () => {
    // 1: select payment row
    queueResult([{ id: 'pay1', invoiceId: 'i1', orgId: 'org1', amount: '50.00', method: 'cash', reference: null, recordedBy: 'u1', voidedAt: null }]);
    // 2: getOwnedInvoiceOr404 (guard)
    queueResult([{ id: 'i1', status: 'partially_paid', orgId: 'org1', partnerId: 'p1', total: '100.00', invoiceNumber: 'INV-1', voidedAt: null, dueDate: null, paidAt: null, markedOverdueAt: null }]);
    // 3: UPDATE invoice_payments (soft-void)
    queueResult([]);
    // 4: recompute → getOwnedInvoiceOr404
    queueResult([{ id: 'i1', status: 'partially_paid', orgId: 'org1', partnerId: 'p1', total: '100.00', invoiceNumber: 'INV-1', voidedAt: null, dueDate: null, paidAt: null, markedOverdueAt: null }]);
    // 5: recompute → select non-voided payments (none left)
    queueResult([]);
    // 6: recompute → UPDATE invoices
    queueResult([]);
    // 7: final getOwnedInvoiceOr404
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', total: '100.00', invoiceNumber: 'INV-1', voidedAt: null, dueDate: null, paidAt: null, markedOverdueAt: null }]);

    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    const res = await svc.voidPayment('pay1', actor, { reason: 'duplicate entry' });
    expect(res.audit).toMatchObject({ paymentId: 'pay1', invoiceId: 'i1', amount: '50.00' });
    expect((db as { delete: unknown }).delete).not.toHaveBeenCalled();
    expect((db as { update: unknown }).update).toHaveBeenCalled();
  });

  it('voidPayment rejects an already-voided payment with 409', async () => {
    queueResult([{ id: 'pay1', invoiceId: 'i1', orgId: 'org1', amount: '50.00', method: 'cash', reference: null, recordedBy: 'u1', voidedAt: new Date() }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(svc.voidPayment('pay1', actor)).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_VOIDED', status: 409 });
  });
```

(If the queue order doesn't match the actual number of awaited db calls in the current `getOwnedInvoiceOr404`, align the `queueResult` count to the real call sequence — the assertions on delete/update are the contract.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/api test src/services/invoiceService.test.ts`
Expected: FAIL — current `voidPayment` deletes the row and has no `PAYMENT_ALREADY_VOIDED` guard.

- [ ] **Step 3: Implement soft-void**

Replace the body of `voidPayment` in `apps/api/src/services/invoiceService.ts` (keep the existing site-axis guard comment and `audit` capture):

```ts
export async function voidPayment(paymentId: string, actor: InvoiceActor, opts?: { reason?: string }) {
  const [pay] = await db.select().from(invoicePayments).where(eq(invoicePayments.id, paymentId)).limit(1);
  if (!pay) throw new InvoiceServiceError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  if (pay.voidedAt !== null) throw new InvoiceServiceError('Payment already voided', 409, 'PAYMENT_ALREADY_VOIDED');
  // The payment row carries orgId but not siteId; load the parent invoice so the
  // site-axis guard runs against the invoice's site (a site-restricted caller must
  // not void a payment on an out-of-site invoice).
  const parentInv = await getOwnedInvoiceOr404(pay.invoiceId);
  requireInvoiceAccess(actor, parentInv);
  const audit = {
    orgId: pay.orgId,
    paymentId,
    invoiceId: pay.invoiceId,
    amount: pay.amount,
    method: pay.method,
    reference: pay.reference,
    recordedBy: pay.recordedBy,
  };
  // Soft-void (PSA P0-1 §8.2): the row is financial provenance — outbound
  // reversal and inbound reconciliation must never depend on a deleted row.
  await db.update(invoicePayments)
    .set({
      voidedAt: new Date(),
      voidedBy: actor.userId ?? null,
      voidReason: (opts?.reason ?? 'user_void').slice(0, 500),
    })
    .where(and(eq(invoicePayments.id, paymentId), isNull(invoicePayments.voidedAt)));
  await recomputeInvoiceStatus(pay.invoiceId);
  const inv = await getOwnedInvoiceOr404(pay.invoiceId);
  await emitInvoiceEvent({ type: 'payment.voided', invoiceId: pay.invoiceId, orgId: pay.orgId, partnerId: inv.partnerId, paymentId, actorUserId: actor.userId });
  return { invoice: inv, audit };
}
```

Ensure `isNull` is imported from `drizzle-orm` at the top of the file (extend the existing import).

In `recomputeInvoiceStatus`, change the payments select to exclude voided rows:

```ts
  const paidRows = await db.select({ amount: invoicePayments.amount }).from(invoicePayments)
    .where(and(eq(invoicePayments.invoiceId, invoiceId), isNull(invoicePayments.voidedAt)));
```

In `listPayments` (find with `grep -n "listPayments" apps/api/src/services/invoiceService.ts`), add `origin: invoicePayments.origin, voidedAt: invoicePayments.voidedAt, voidReason: invoicePayments.voidReason` to the selected columns so history views can show voided rows explicitly; do NOT filter them out of the list.

Stripe origin at insert time: run `grep -rn "insert(invoicePayments)" apps/api/src --include='*.ts'`. In the Stripe-settlement path (the insert that is later linked from `invoice_stripe_payments`), add `origin: 'stripe'` to the inserted values object. The manual `recordPayment` path needs no change (column default `'manual'`).

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `pnpm --filter @breeze/api test src/services/invoiceService.test.ts`
Expected: PASS (all — including untouched suite members).

- [ ] **Step 5: Write the integration test**

```ts
// apps/api/src/__tests__/integration/invoicePaymentSoftVoid.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { invoices, invoicePayments } from '../../db/schema';
import * as invoiceSvc from '../../services/invoiceService';
import { createOrganization, createPartner } from './db-utils';

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null };
}

describe('invoice payment soft-void (real DB)', () => {
  it('void retains the row, restores balance, and excludes the amount from totals', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    // Seed an issued invoice directly (system context): total 100, no payments.
    const [inv] = await withSystemDbAccessContext(() =>
      db.insert(invoices).values({
        partnerId: partner.id, orgId: org.id, status: 'sent', invoiceNumber: 'INV-SVOID-1',
        subtotal: '100.00', total: '100.00', balance: '100.00',
      }).returning(),
    );

    const actor = { userId: null, partnerId: partner.id, accessibleOrgIds: [org.id] };
    await withDbAccessContext(partnerContext(partner.id, [org.id]), async () => {
      await invoiceSvc.recordPayment(inv.id, { amount: 40, method: 'cash', receivedAt: '2026-07-16' }, actor);
    });

    const [afterPay] = await withSystemDbAccessContext(() =>
      db.select().from(invoices).where(eq(invoices.id, inv.id)),
    );
    expect(afterPay.amountPaid).toBe('40.00');

    const [payRow] = await withSystemDbAccessContext(() =>
      db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, inv.id)),
    );
    expect(payRow.origin).toBe('manual');

    await withDbAccessContext(partnerContext(partner.id, [org.id]), async () => {
      await invoiceSvc.voidPayment(payRow.id, actor, { reason: 'test void' });
    });

    // Row survives, is marked voided, and no longer counts toward totals.
    const [voided] = await withSystemDbAccessContext(() =>
      db.select().from(invoicePayments).where(eq(invoicePayments.id, payRow.id)),
    );
    expect(voided).toBeDefined();
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidReason).toBe('test void');

    const [afterVoid] = await withSystemDbAccessContext(() =>
      db.select().from(invoices).where(eq(invoices.id, inv.id)),
    );
    expect(afterVoid.amountPaid).toBe('0.00');
    expect(afterVoid.balance).toBe('100.00');

    // Double-void is a 409, not a second mutation.
    await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      expect(invoiceSvc.voidPayment(payRow.id, actor)).rejects.toMatchObject({ code: 'PAYMENT_ALREADY_VOIDED' }),
    );
  });
});
```

(If `recordPayment`'s `RecordPaymentInput` field names differ — check with `grep -n "RecordPaymentInput" apps/api/src/services/invoiceTypes.ts` — align the literal in the test to the real shape.)

- [ ] **Step 6: Run the integration test**

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/invoicePaymentSoftVoid.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts apps/api/src/__tests__/integration/invoicePaymentSoftVoid.integration.test.ts
git commit -m "feat(accounting): soft-void invoice payments with origin metadata (P0-1 Stage 1)"
```

---

### Task 4: Migration B — entity mappings + tax mappings

**Files:**
- Create: `apps/api/migrations/2026-07-21-b-accounting-entity-tax-mappings.sql`
- Create: `apps/api/src/db/schema/accountingSync.ts` (first two tables)
- Modify: `apps/api/src/db/schema/index.ts` (barrel export)

**Interfaces:**
- Consumes: composite FK targets from Task 2 (`invoices_id_partner_uq`, plus pre-existing `accounting_connections_id_partner_idx`, `organizations_id_partner_id_unique`, `catalog_items_id_partner_uq`).
- Produces: Drizzle exports `accountingEntityMappings`, `accountingTaxMappings` used by Tasks 7, 8, 12, 15. Column names exactly as in the SQL below.

- [ ] **Step 1: Write the migration**

```sql
-- PSA P0-1 Stage 1 (spec §8.3, §8.5): connection-scoped entity mappings and
-- tax mappings. Partner-axis RLS (shape 3), composite partner-safe FKs.
-- Idempotent. No inner BEGIN/COMMIT. No GRANTs (ensureAppRole blanket-grants).

CREATE TABLE IF NOT EXISTS accounting_entity_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  entity_type VARCHAR(20) NOT NULL,
  organization_id UUID,
  catalog_item_id UUID,
  invoice_id UUID,
  remote_entity_type VARCHAR(40) NOT NULL,
  remote_id VARCHAR(128) NOT NULL,
  remote_version VARCHAR(64),
  remote_document_number VARCHAR(64),
  remote_display_name VARCHAR(255),
  link_state VARCHAR(20) NOT NULL DEFAULT 'suggested',
  created_by UUID REFERENCES users(id),
  confirmed_by UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounting_entity_mappings_entity_type_chk
    CHECK (entity_type IN ('customer','item','invoice')),
  CONSTRAINT accounting_entity_mappings_link_state_chk
    CHECK (link_state IN ('legacy_unverified','suggested','confirmed','create_approved','inactive')),
  -- Exactly the local reference appropriate to entity_type (spec §8.3).
  -- Invoice mappings carry BOTH the invoice and its owning organization.
  CONSTRAINT accounting_entity_mappings_local_ref_chk CHECK (
    (entity_type = 'customer' AND organization_id IS NOT NULL AND catalog_item_id IS NULL AND invoice_id IS NULL)
    OR (entity_type = 'item' AND catalog_item_id IS NOT NULL AND organization_id IS NULL AND invoice_id IS NULL)
    OR (entity_type = 'invoice' AND invoice_id IS NOT NULL AND organization_id IS NOT NULL AND catalog_item_id IS NULL)
  )
);

-- Partner-safe composite FKs: a mapping cannot point at a connection or local
-- entity owned by another partner, even under system context.
DO $$ BEGIN
  ALTER TABLE accounting_entity_mappings
    ADD CONSTRAINT accounting_entity_mappings_conn_partner_fk
    FOREIGN KEY (connection_id, partner_id) REFERENCES accounting_connections(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_entity_mappings
    ADD CONSTRAINT accounting_entity_mappings_org_partner_fk
    FOREIGN KEY (organization_id, partner_id) REFERENCES organizations(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_entity_mappings
    ADD CONSTRAINT accounting_entity_mappings_item_partner_fk
    FOREIGN KEY (catalog_item_id, partner_id) REFERENCES catalog_items(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_entity_mappings
    ADD CONSTRAINT accounting_entity_mappings_invoice_partner_fk
    FOREIGN KEY (invoice_id, partner_id) REFERENCES invoices(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One local mapping per connection/entity type; one remote claim per connection.
CREATE UNIQUE INDEX IF NOT EXISTS accounting_entity_mappings_conn_customer_uq
  ON accounting_entity_mappings (connection_id, organization_id) WHERE entity_type = 'customer';
CREATE UNIQUE INDEX IF NOT EXISTS accounting_entity_mappings_conn_item_uq
  ON accounting_entity_mappings (connection_id, catalog_item_id) WHERE entity_type = 'item';
CREATE UNIQUE INDEX IF NOT EXISTS accounting_entity_mappings_conn_invoice_uq
  ON accounting_entity_mappings (connection_id, invoice_id) WHERE entity_type = 'invoice';
CREATE UNIQUE INDEX IF NOT EXISTS accounting_entity_mappings_remote_claim_uq
  ON accounting_entity_mappings (connection_id, remote_entity_type, remote_id);
CREATE INDEX IF NOT EXISTS accounting_entity_mappings_partner_idx
  ON accounting_entity_mappings (partner_id);
CREATE INDEX IF NOT EXISTS accounting_entity_mappings_conn_state_idx
  ON accounting_entity_mappings (connection_id, entity_type, link_state);

ALTER TABLE accounting_entity_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_entity_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_entity_mappings_partner_access ON accounting_entity_mappings;
CREATE POLICY accounting_entity_mappings_partner_access ON accounting_entity_mappings
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_tax_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  breeze_tax_key VARCHAR(40) NOT NULL,
  breeze_rate NUMERIC(8,5),
  remote_tax_ref VARCHAR(64) NOT NULL,
  remote_tax_name VARCHAR(128),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  provider_metadata JSONB,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE accounting_tax_mappings
    ADD CONSTRAINT accounting_tax_mappings_conn_partner_fk
    FOREIGN KEY (connection_id, partner_id) REFERENCES accounting_connections(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_tax_mappings_conn_key_uq
  ON accounting_tax_mappings (connection_id, breeze_tax_key);
-- One default taxable mapping per connection (spec §8.5).
CREATE UNIQUE INDEX IF NOT EXISTS accounting_tax_mappings_conn_default_uq
  ON accounting_tax_mappings (connection_id) WHERE is_default = TRUE;
CREATE INDEX IF NOT EXISTS accounting_tax_mappings_partner_idx
  ON accounting_tax_mappings (partner_id);

ALTER TABLE accounting_tax_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_tax_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_tax_mappings_partner_access ON accounting_tax_mappings;
CREATE POLICY accounting_tax_mappings_partner_access ON accounting_tax_mappings
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 2: Create the Drizzle schema file**

```ts
// apps/api/src/db/schema/accountingSync.ts
// PSA P0-1 Stage 1 accounting-sync tables. All partner-axis (RLS shape 3).
// Composite partner-safe FKs are created in the SQL migrations (2026-07-21-b/c/d),
// not declared here — house style, keeps Drizzle types simple. Local-entity
// columns are deliberately organization_id / invoice_id / etc. (NOT org_id):
// these are partner-axis tables and must not trip org-axis auto-discovery.
// Org-erasure coverage is therefore MANUAL — see the accounting pre-clears in
// services/tenantCascade.ts; every table here that references an org-owned
// entity MUST have a pre-clear entry there.
import {
  pgTable, uuid, varchar, timestamp, char, date, numeric, jsonb, integer,
  boolean, index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

export const accountingEntityMappings = pgTable('accounting_entity_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  entityType: varchar('entity_type', { length: 20 }).notNull(), // 'customer' | 'item' | 'invoice'
  organizationId: uuid('organization_id'),
  catalogItemId: uuid('catalog_item_id'),
  invoiceId: uuid('invoice_id'),
  remoteEntityType: varchar('remote_entity_type', { length: 40 }).notNull(),
  remoteId: varchar('remote_id', { length: 128 }).notNull(),
  remoteVersion: varchar('remote_version', { length: 64 }),
  remoteDocumentNumber: varchar('remote_document_number', { length: 64 }),
  remoteDisplayName: varchar('remote_display_name', { length: 255 }),
  linkState: varchar('link_state', { length: 20 }).notNull().default('suggested'),
  createdBy: uuid('created_by').references(() => users.id),
  confirmedBy: uuid('confirmed_by').references(() => users.id),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('accounting_entity_mappings_remote_claim_uq')
    .on(t.connectionId, t.remoteEntityType, t.remoteId),
  index('accounting_entity_mappings_partner_idx').on(t.partnerId),
  index('accounting_entity_mappings_conn_state_idx').on(t.connectionId, t.entityType, t.linkState),
]);

export const accountingTaxMappings = pgTable('accounting_tax_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  breezeTaxKey: varchar('breeze_tax_key', { length: 40 }).notNull(),
  breezeRate: numeric('breeze_rate', { precision: 8, scale: 5 }),
  remoteTaxRef: varchar('remote_tax_ref', { length: 64 }).notNull(),
  remoteTaxName: varchar('remote_tax_name', { length: 128 }),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  providerMetadata: jsonb('provider_metadata'),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('accounting_tax_mappings_conn_key_uq').on(t.connectionId, t.breezeTaxKey),
  index('accounting_tax_mappings_partner_idx').on(t.partnerId),
]);
```

Add to `apps/api/src/db/schema/index.ts`, directly after the `export * from './accounting';` line:

```ts
export * from './accountingSync';
```

- [ ] **Step 3: Typecheck + apply + idempotency + drift**

```bash
cd apps/api && npx tsc --noEmit
pnpm test:integration src/__tests__/integration/tenantCascade.integration.test.ts
psql postgresql://breeze_test:breeze_test@localhost:5433/breeze_test -v ON_ERROR_STOP=1 -f migrations/2026-07-21-b-accounting-entity-tax-mappings.sql
psql postgresql://breeze_test:breeze_test@localhost:5433/breeze_test -v ON_ERROR_STOP=1 -f migrations/2026-07-21-b-accounting-entity-tax-mappings.sql
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm db:check-drift
```
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-07-21-b-accounting-entity-tax-mappings.sql apps/api/src/db/schema/accountingSync.ts apps/api/src/db/schema/index.ts
git commit -m "feat(accounting): entity + tax mapping tables with partner RLS and composite FKs (P0-1 Stage 1)"
```

---

### Task 5: Migration C — sync operations (outbox) + attempts

**Files:**
- Create: `apps/api/migrations/2026-07-21-c-accounting-sync-operations.sql`
- Modify: `apps/api/src/db/schema/accountingSync.ts` (append two tables)

**Interfaces:**
- Consumes: FK targets from Tasks 2/4.
- Produces: Drizzle exports `accountingSyncOperations`, `accountingSyncAttempts` used by Tasks 7, 8, 12, 13, 14. Unique `accounting_sync_operations_id_conn_partner_uq (id, connection_id, partner_id)` is the composite target every child (attempts, exceptions, remote-payment headers, self-dependency) binds to.

- [ ] **Step 1: Write the migration**

```sql
-- PSA P0-1 Stage 1 (spec §8.6, §8.7): the transactional outbox
-- (accounting_sync_operations) and append-only attempt evidence
-- (accounting_sync_attempts). Partner-axis RLS. Idempotent. No inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS accounting_sync_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  direction VARCHAR(10) NOT NULL,
  entity_type VARCHAR(12) NOT NULL,
  organization_id UUID,
  catalog_item_id UUID,
  invoice_id UUID,
  invoice_payment_id UUID,
  operation VARCHAR(40) NOT NULL,
  local_version INTEGER NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(220) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  payload JSONB NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  depends_on_operation_id UUID,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  queued_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  lease_owner VARCHAR(128),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_category VARCHAR(20),
  last_error_code VARCHAR(64),
  last_error_message VARCHAR(500),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounting_sync_operations_direction_chk
    CHECK (direction IN ('outbound','inbound')),
  CONSTRAINT accounting_sync_operations_entity_type_chk
    CHECK (entity_type IN ('customer','item','invoice','payment','reconcile')),
  CONSTRAINT accounting_sync_operations_status_chk
    CHECK (status IN ('pending','queued','running','succeeded','succeeded_with_variance',
                      'waiting_dependency','ambiguous','blocked','failed','canceled')),
  CONSTRAINT accounting_sync_operations_error_category_chk
    CHECK (last_error_category IS NULL OR last_error_category IN
           ('reauth_required','rate_limited','transient','ambiguous_write',
            'validation','not_found','conflict','configuration')),
  -- Typed entity binding (spec §8.6): reconcile is the only entity-less type.
  CONSTRAINT accounting_sync_operations_entity_ref_chk CHECK (
    (entity_type = 'customer' AND organization_id IS NOT NULL AND catalog_item_id IS NULL
       AND invoice_id IS NULL AND invoice_payment_id IS NULL)
    OR (entity_type = 'item' AND catalog_item_id IS NOT NULL AND organization_id IS NULL
       AND invoice_id IS NULL AND invoice_payment_id IS NULL)
    OR (entity_type = 'invoice' AND invoice_id IS NOT NULL AND invoice_payment_id IS NULL
       AND catalog_item_id IS NULL)
    OR (entity_type = 'payment' AND invoice_payment_id IS NOT NULL AND invoice_id IS NOT NULL
       AND catalog_item_id IS NULL)
    OR (entity_type = 'reconcile' AND organization_id IS NULL AND catalog_item_id IS NULL
       AND invoice_id IS NULL AND invoice_payment_id IS NULL)
  ),
  -- A running operation always carries a complete lease.
  CONSTRAINT accounting_sync_operations_lease_chk CHECK (
    status <> 'running' OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_sync_operations_idem_uq
  ON accounting_sync_operations (idempotency_key);
-- Composite target for child FKs (attempts/exceptions/headers/self-dependency).
CREATE UNIQUE INDEX IF NOT EXISTS accounting_sync_operations_id_conn_partner_uq
  ON accounting_sync_operations (id, connection_id, partner_id);
CREATE INDEX IF NOT EXISTS accounting_sync_operations_claim_idx
  ON accounting_sync_operations (status, next_attempt_at)
  WHERE status IN ('pending','queued','running');
CREATE INDEX IF NOT EXISTS accounting_sync_operations_conn_status_idx
  ON accounting_sync_operations (connection_id, status);
CREATE INDEX IF NOT EXISTS accounting_sync_operations_partner_idx
  ON accounting_sync_operations (partner_id);
CREATE INDEX IF NOT EXISTS accounting_sync_operations_invoice_idx
  ON accounting_sync_operations (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS accounting_sync_operations_org_idx
  ON accounting_sync_operations (organization_id) WHERE organization_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE accounting_sync_operations
    ADD CONSTRAINT accounting_sync_operations_conn_partner_fk
    FOREIGN KEY (connection_id, partner_id) REFERENCES accounting_connections(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_operations
    ADD CONSTRAINT accounting_sync_operations_org_partner_fk
    FOREIGN KEY (organization_id, partner_id) REFERENCES organizations(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_operations
    ADD CONSTRAINT accounting_sync_operations_item_partner_fk
    FOREIGN KEY (catalog_item_id, partner_id) REFERENCES catalog_items(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_operations
    ADD CONSTRAINT accounting_sync_operations_invoice_partner_fk
    FOREIGN KEY (invoice_id, partner_id) REFERENCES invoices(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_operations
    ADD CONSTRAINT accounting_sync_operations_payment_invoice_fk
    FOREIGN KEY (invoice_payment_id, invoice_id) REFERENCES invoice_payments(id, invoice_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Dependency stays inside the same connection AND partner (spec §8.6).
DO $$ BEGIN
  ALTER TABLE accounting_sync_operations
    ADD CONSTRAINT accounting_sync_operations_depends_fk
    FOREIGN KEY (depends_on_operation_id, connection_id, partner_id)
    REFERENCES accounting_sync_operations(id, connection_id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE accounting_sync_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_sync_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_sync_operations_partner_access ON accounting_sync_operations;
CREATE POLICY accounting_sync_operations_partner_access ON accounting_sync_operations
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_sync_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  attempt_number INTEGER NOT NULL,
  provider_request_id VARCHAR(64),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  send_started_at TIMESTAMPTZ,
  response_received_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  outcome VARCHAR(30),
  provider_http_status INTEGER,
  error_category VARCHAR(20),
  error_code VARCHAR(64),
  error_message VARCHAR(500),
  remote_id VARCHAR(128),
  remote_version VARCHAR(64),
  response_summary VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE accounting_sync_attempts
    ADD CONSTRAINT accounting_sync_attempts_operation_fk
    FOREIGN KEY (operation_id, connection_id, partner_id)
    REFERENCES accounting_sync_operations(id, connection_id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_sync_attempts_op_attempt_uq
  ON accounting_sync_attempts (operation_id, attempt_number);
CREATE INDEX IF NOT EXISTS accounting_sync_attempts_partner_idx
  ON accounting_sync_attempts (partner_id);

ALTER TABLE accounting_sync_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_sync_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_sync_attempts_partner_access ON accounting_sync_attempts;
CREATE POLICY accounting_sync_attempts_partner_access ON accounting_sync_attempts
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 2: Append the Drizzle declarations**

Append to `apps/api/src/db/schema/accountingSync.ts`:

```ts
export const accountingSyncOperations = pgTable('accounting_sync_operations', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  direction: varchar('direction', { length: 10 }).notNull(), // 'outbound' | 'inbound'
  entityType: varchar('entity_type', { length: 12 }).notNull(),
  organizationId: uuid('organization_id'),
  catalogItemId: uuid('catalog_item_id'),
  invoiceId: uuid('invoice_id'),
  invoicePaymentId: uuid('invoice_payment_id'),
  operation: varchar('operation', { length: 40 }).notNull(),
  localVersion: integer('local_version').notNull().default(1),
  idempotencyKey: varchar('idempotency_key', { length: 220 }).notNull(),
  status: varchar('status', { length: 30 }).notNull().default('pending'),
  payload: jsonb('payload').notNull(),
  payloadSha256: char('payload_sha256', { length: 64 }).notNull(),
  dependsOnOperationId: uuid('depends_on_operation_id'),
  availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  queuedAt: timestamp('queued_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  leaseOwner: varchar('lease_owner', { length: 128 }),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastErrorCategory: varchar('last_error_category', { length: 20 }),
  lastErrorCode: varchar('last_error_code', { length: 64 }),
  lastErrorMessage: varchar('last_error_message', { length: 500 }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('accounting_sync_operations_idem_uq').on(t.idempotencyKey),
  uniqueIndex('accounting_sync_operations_id_conn_partner_uq').on(t.id, t.connectionId, t.partnerId),
  index('accounting_sync_operations_conn_status_idx').on(t.connectionId, t.status),
  index('accounting_sync_operations_partner_idx').on(t.partnerId),
]);

export const accountingSyncAttempts = pgTable('accounting_sync_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  operationId: uuid('operation_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  attemptNumber: integer('attempt_number').notNull(),
  providerRequestId: varchar('provider_request_id', { length: 64 }),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  sendStartedAt: timestamp('send_started_at', { withTimezone: true }),
  responseReceivedAt: timestamp('response_received_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  outcome: varchar('outcome', { length: 30 }),
  providerHttpStatus: integer('provider_http_status'),
  errorCategory: varchar('error_category', { length: 20 }),
  errorCode: varchar('error_code', { length: 64 }),
  errorMessage: varchar('error_message', { length: 500 }),
  remoteId: varchar('remote_id', { length: 128 }),
  remoteVersion: varchar('remote_version', { length: 64 }),
  responseSummary: varchar('response_summary', { length: 1000 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('accounting_sync_attempts_op_attempt_uq').on(t.operationId, t.attemptNumber),
  index('accounting_sync_attempts_partner_idx').on(t.partnerId),
]);
```

- [ ] **Step 3: Typecheck + apply + idempotency + drift**

Same commands as Task 4 Step 3, substituting `migrations/2026-07-21-c-accounting-sync-operations.sql`.
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-07-21-c-accounting-sync-operations.sql apps/api/src/db/schema/accountingSync.ts
git commit -m "feat(accounting): transactional outbox operations + append-only attempts (P0-1 Stage 1)"
```

---

### Task 6: Migration D — remote payments, allocations, webhook receipts, cursors, exceptions

**Files:**
- Create: `apps/api/migrations/2026-07-21-d-accounting-sync-inbound-tables.sql`
- Modify: `apps/api/src/db/schema/accountingSync.ts` (append five tables)

**Interfaces:**
- Consumes: `accounting_sync_operations_id_conn_partner_uq` (Task 5), `invoice_payments_id_invoice_uq`, `invoices_id_partner_uq` (Task 2).
- Produces: Drizzle exports `accountingRemotePayments`, `accountingPaymentAllocations`, `accountingWebhookReceipts`, `accountingSyncCursors`, `accountingSyncExceptions` used by Tasks 7, 8, 14, 15.

- [ ] **Step 1: Write the migration**

```sql
-- PSA P0-1 Stage 1 (spec §8.4, §8.8, §8.9, §8.10): remote payment identity,
-- allocations, webhook receipts, per-stream cursors, exceptions.
-- Partner-axis RLS. Idempotent. No inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS accounting_remote_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  remote_payment_id VARCHAR(128) NOT NULL,
  remote_version VARCHAR(64),
  remote_status VARCHAR(40),
  origin VARCHAR(10) NOT NULL,
  payment_date DATE,
  currency CHAR(3),
  total_amount NUMERIC(12,2),
  outbound_operation_id UUID,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounting_remote_payments_origin_chk CHECK (origin IN ('breeze','provider'))
);

DO $$ BEGIN
  ALTER TABLE accounting_remote_payments
    ADD CONSTRAINT accounting_remote_payments_conn_partner_fk
    FOREIGN KEY (connection_id, partner_id) REFERENCES accounting_connections(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_remote_payments
    ADD CONSTRAINT accounting_remote_payments_outbound_op_fk
    FOREIGN KEY (outbound_operation_id, connection_id, partner_id)
    REFERENCES accounting_sync_operations(id, connection_id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_remote_payments_conn_remote_uq
  ON accounting_remote_payments (connection_id, remote_payment_id);
-- Composite target for allocation + exception FKs.
CREATE UNIQUE INDEX IF NOT EXISTS accounting_remote_payments_id_conn_partner_uq
  ON accounting_remote_payments (id, connection_id, partner_id);
CREATE INDEX IF NOT EXISTS accounting_remote_payments_partner_idx
  ON accounting_remote_payments (partner_id);

ALTER TABLE accounting_remote_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_remote_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_remote_payments_partner_access ON accounting_remote_payments;
CREATE POLICY accounting_remote_payments_partner_access ON accounting_remote_payments
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remote_payment_header_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  invoice_payment_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  remote_invoice_id VARCHAR(128),
  remote_allocation_key VARCHAR(200) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  reversed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE accounting_payment_allocations
    ADD CONSTRAINT accounting_payment_allocations_header_fk
    FOREIGN KEY (remote_payment_header_id, connection_id, partner_id)
    REFERENCES accounting_remote_payments(id, connection_id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Binds the allocation to the exact local payment row; a matching payment ID
-- cannot smuggle an invoice from another partner (spec §8.2, §8.4).
DO $$ BEGIN
  ALTER TABLE accounting_payment_allocations
    ADD CONSTRAINT accounting_payment_allocations_payment_invoice_fk
    FOREIGN KEY (invoice_payment_id, invoice_id) REFERENCES invoice_payments(id, invoice_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_payment_allocations
    ADD CONSTRAINT accounting_payment_allocations_invoice_partner_fk
    FOREIGN KEY (invoice_id, partner_id) REFERENCES invoices(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_payment_allocations
    ADD CONSTRAINT accounting_payment_allocations_conn_partner_fk
    FOREIGN KEY (connection_id, partner_id) REFERENCES accounting_connections(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_payment_allocations_header_key_uq
  ON accounting_payment_allocations (remote_payment_header_id, remote_allocation_key);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_payment_allocations_conn_payment_uq
  ON accounting_payment_allocations (connection_id, invoice_payment_id);
CREATE INDEX IF NOT EXISTS accounting_payment_allocations_invoice_idx
  ON accounting_payment_allocations (invoice_id);
CREATE INDEX IF NOT EXISTS accounting_payment_allocations_partner_idx
  ON accounting_payment_allocations (partner_id);

ALTER TABLE accounting_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_payment_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_payment_allocations_partner_access ON accounting_payment_allocations;
CREATE POLICY accounting_payment_allocations_partner_access ON accounting_payment_allocations
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_webhook_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  provider VARCHAR(20) NOT NULL,
  provider_event_key VARCHAR(200) NOT NULL,
  body_sha256 CHAR(64) NOT NULL,
  event_time TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  processed_at TIMESTAMPTZ,
  last_error VARCHAR(500),
  CONSTRAINT accounting_webhook_receipts_status_chk
    CHECK (processing_status IN ('pending','processing','processed','failed'))
);

DO $$ BEGIN
  ALTER TABLE accounting_webhook_receipts
    ADD CONSTRAINT accounting_webhook_receipts_conn_partner_fk
    FOREIGN KEY (connection_id, partner_id) REFERENCES accounting_connections(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Repeated delivery of one provider event creates one receipt (spec §8.8).
CREATE UNIQUE INDEX IF NOT EXISTS accounting_webhook_receipts_conn_event_uq
  ON accounting_webhook_receipts (connection_id, provider_event_key);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_webhook_receipts_id_conn_partner_uq
  ON accounting_webhook_receipts (id, connection_id, partner_id);
CREATE INDEX IF NOT EXISTS accounting_webhook_receipts_partner_idx
  ON accounting_webhook_receipts (partner_id);

ALTER TABLE accounting_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_webhook_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_webhook_receipts_partner_access ON accounting_webhook_receipts;
CREATE POLICY accounting_webhook_receipts_partner_access ON accounting_webhook_receipts
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_sync_cursors (
  connection_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  stream VARCHAR(30) NOT NULL,
  cursor JSONB,
  overlap_from TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, stream)
);

DO $$ BEGIN
  ALTER TABLE accounting_sync_cursors
    ADD CONSTRAINT accounting_sync_cursors_conn_partner_fk
    FOREIGN KEY (connection_id, partner_id) REFERENCES accounting_connections(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS accounting_sync_cursors_partner_idx
  ON accounting_sync_cursors (partner_id);

ALTER TABLE accounting_sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_sync_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_sync_cursors_partner_access ON accounting_sync_cursors;
CREATE POLICY accounting_sync_cursors_partner_access ON accounting_sync_cursors
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounting_sync_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  partner_id UUID NOT NULL REFERENCES partners(id),
  operation_id UUID,
  webhook_receipt_id UUID,
  category VARCHAR(40) NOT NULL,
  entity_type VARCHAR(12),
  organization_id UUID,
  catalog_item_id UUID,
  invoice_id UUID,
  invoice_payment_id UUID,
  remote_entity_id VARCHAR(128),
  summary VARCHAR(300) NOT NULL,
  details JSONB,
  status VARCHAR(10) NOT NULL DEFAULT 'open',
  resolution VARCHAR(1000),
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounting_sync_exceptions_status_chk
    CHECK (status IN ('open','resolved','dismissed'))
);

DO $$ BEGIN
  ALTER TABLE accounting_sync_exceptions
    ADD CONSTRAINT accounting_sync_exceptions_conn_partner_fk
    FOREIGN KEY (connection_id, partner_id) REFERENCES accounting_connections(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_exceptions
    ADD CONSTRAINT accounting_sync_exceptions_operation_fk
    FOREIGN KEY (operation_id, connection_id, partner_id)
    REFERENCES accounting_sync_operations(id, connection_id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_exceptions
    ADD CONSTRAINT accounting_sync_exceptions_receipt_fk
    FOREIGN KEY (webhook_receipt_id, connection_id, partner_id)
    REFERENCES accounting_webhook_receipts(id, connection_id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_exceptions
    ADD CONSTRAINT accounting_sync_exceptions_org_partner_fk
    FOREIGN KEY (organization_id, partner_id) REFERENCES organizations(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_exceptions
    ADD CONSTRAINT accounting_sync_exceptions_item_partner_fk
    FOREIGN KEY (catalog_item_id, partner_id) REFERENCES catalog_items(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_exceptions
    ADD CONSTRAINT accounting_sync_exceptions_invoice_partner_fk
    FOREIGN KEY (invoice_id, partner_id) REFERENCES invoices(id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE accounting_sync_exceptions
    ADD CONSTRAINT accounting_sync_exceptions_payment_invoice_fk
    FOREIGN KEY (invoice_payment_id, invoice_id) REFERENCES invoice_payments(id, invoice_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS accounting_sync_exceptions_conn_status_idx
  ON accounting_sync_exceptions (connection_id, status);
CREATE INDEX IF NOT EXISTS accounting_sync_exceptions_partner_idx
  ON accounting_sync_exceptions (partner_id);
-- One OPEN ambiguous-write exception per operation (dedup target for repair).
CREATE UNIQUE INDEX IF NOT EXISTS accounting_sync_exceptions_open_op_category_uq
  ON accounting_sync_exceptions (operation_id, category) WHERE status = 'open' AND operation_id IS NOT NULL;

ALTER TABLE accounting_sync_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_sync_exceptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_sync_exceptions_partner_access ON accounting_sync_exceptions;
CREATE POLICY accounting_sync_exceptions_partner_access ON accounting_sync_exceptions
  FOR ALL TO breeze_app
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 2: Append the Drizzle declarations**

Append to `apps/api/src/db/schema/accountingSync.ts`:

```ts
export const accountingRemotePayments = pgTable('accounting_remote_payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  remotePaymentId: varchar('remote_payment_id', { length: 128 }).notNull(),
  remoteVersion: varchar('remote_version', { length: 64 }),
  remoteStatus: varchar('remote_status', { length: 40 }),
  origin: varchar('origin', { length: 10 }).notNull(), // 'breeze' | 'provider'
  paymentDate: date('payment_date'),
  currency: char('currency', { length: 3 }),
  totalAmount: numeric('total_amount', { precision: 12, scale: 2 }),
  outboundOperationId: uuid('outbound_operation_id'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('accounting_remote_payments_conn_remote_uq').on(t.connectionId, t.remotePaymentId),
  uniqueIndex('accounting_remote_payments_id_conn_partner_uq').on(t.id, t.connectionId, t.partnerId),
  index('accounting_remote_payments_partner_idx').on(t.partnerId),
]);

export const accountingPaymentAllocations = pgTable('accounting_payment_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  remotePaymentHeaderId: uuid('remote_payment_header_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  invoicePaymentId: uuid('invoice_payment_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  remoteInvoiceId: varchar('remote_invoice_id', { length: 128 }),
  remoteAllocationKey: varchar('remote_allocation_key', { length: 200 }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('accounting_payment_allocations_header_key_uq').on(t.remotePaymentHeaderId, t.remoteAllocationKey),
  uniqueIndex('accounting_payment_allocations_conn_payment_uq').on(t.connectionId, t.invoicePaymentId),
  index('accounting_payment_allocations_invoice_idx').on(t.invoiceId),
  index('accounting_payment_allocations_partner_idx').on(t.partnerId),
]);

export const accountingWebhookReceipts = pgTable('accounting_webhook_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  provider: varchar('provider', { length: 20 }).notNull(),
  providerEventKey: varchar('provider_event_key', { length: 200 }).notNull(),
  bodySha256: char('body_sha256', { length: 64 }).notNull(),
  eventTime: timestamp('event_time', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  processingStatus: varchar('processing_status', { length: 20 }).notNull().default('pending'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  lastError: varchar('last_error', { length: 500 }),
}, (t) => [
  uniqueIndex('accounting_webhook_receipts_conn_event_uq').on(t.connectionId, t.providerEventKey),
  uniqueIndex('accounting_webhook_receipts_id_conn_partner_uq').on(t.id, t.connectionId, t.partnerId),
  index('accounting_webhook_receipts_partner_idx').on(t.partnerId),
]);

export const accountingSyncCursors = pgTable('accounting_sync_cursors', {
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  stream: varchar('stream', { length: 30 }).notNull(),
  cursor: jsonb('cursor'),
  overlapFrom: timestamp('overlap_from', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.connectionId, t.stream] }),
  index('accounting_sync_cursors_partner_idx').on(t.partnerId),
]);

export const accountingSyncExceptions = pgTable('accounting_sync_exceptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  operationId: uuid('operation_id'),
  webhookReceiptId: uuid('webhook_receipt_id'),
  category: varchar('category', { length: 40 }).notNull(),
  entityType: varchar('entity_type', { length: 12 }),
  organizationId: uuid('organization_id'),
  catalogItemId: uuid('catalog_item_id'),
  invoiceId: uuid('invoice_id'),
  invoicePaymentId: uuid('invoice_payment_id'),
  remoteEntityId: varchar('remote_entity_id', { length: 128 }),
  summary: varchar('summary', { length: 300 }).notNull(),
  details: jsonb('details'),
  status: varchar('status', { length: 10 }).notNull().default('open'),
  resolution: varchar('resolution', { length: 1000 }),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('accounting_sync_exceptions_conn_status_idx').on(t.connectionId, t.status),
  index('accounting_sync_exceptions_partner_idx').on(t.partnerId),
]);
```

- [ ] **Step 3: Typecheck + apply + idempotency + drift**

Same commands as Task 4 Step 3, substituting `migrations/2026-07-21-d-accounting-sync-inbound-tables.sql`.
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-07-21-d-accounting-sync-inbound-tables.sql apps/api/src/db/schema/accountingSync.ts
git commit -m "feat(accounting): remote payments, allocations, receipts, cursors, exceptions tables (P0-1 Stage 1)"
```

---

### Task 7: RLS registration + cross-partner forge suite

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`)
- Create: `apps/api/src/__tests__/integration/accountingSyncPartnerRls.integration.test.ts`

**Interfaces:**
- Consumes: all tables from Tasks 2–6; `db, withDbAccessContext, withSystemDbAccessContext` from `../../db`; `createPartner, createOrganization` from `./db-utils`.
- Produces: the functional forge proof the spec's Stage 1 gate requires. Also the shared test helper `seedAccountingFixture(partnerId)` (local to the new file) reused as the pattern for later suites.

- [ ] **Step 1: Register the nine new tables**

In `rls-coverage.integration.test.ts`, add to `PARTNER_TENANT_TABLES` (alphabetical position within the map is not enforced; add as one block):

```ts
  // PSA P0-1 accounting sync (2026-07-21): all partner-axis (Shape 3). Local
  // entity refs use organization_id/invoice_id (NOT org_id) plus composite
  // partner-safe FKs, so org-axis auto-discovery is intentionally not tripped.
  // Functional forge proof: accountingSyncPartnerRls.integration.test.ts.
  // Org-erasure pre-clears: services/tenantCascade.ts (accounting block).
  ['accounting_entity_mappings', 'partner_id'],
  ['accounting_tax_mappings', 'partner_id'],
  ['accounting_sync_operations', 'partner_id'],
  ['accounting_sync_attempts', 'partner_id'],
  ['accounting_remote_payments', 'partner_id'],
  ['accounting_payment_allocations', 'partner_id'],
  ['accounting_webhook_receipts', 'partner_id'],
  ['accounting_sync_cursors', 'partner_id'],
  ['accounting_sync_exceptions', 'partner_id'],
```

(`accounting_connections` is already registered.)

- [ ] **Step 2: Run the coverage contract to verify it passes**

Run: `cd apps/api && pnpm test:rls-coverage`
Expected: PASS — every listed table has RLS enabled+forced and a `breeze_has_partner_access` policy covering all four DML commands. If this FAILS, a migration from Tasks 4–6 is missing a policy — fix the migration is NOT allowed if already committed as applied elsewhere; in this repo's flow (unreleased branch) fix the migration file before merge.

- [ ] **Step 3: Write the forge suite**

```ts
// apps/api/src/__tests__/integration/accountingSyncPartnerRls.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  accountingConnections, accountingEntityMappings, accountingSyncOperations,
  accountingSyncAttempts, accountingRemotePayments, accountingPaymentAllocations,
  invoices, invoicePayments,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null };
}

async function seedConnection(partnerId: string) {
  const [conn] = await withSystemDbAccessContext(() =>
    db.insert(accountingConnections).values({
      partnerId, provider: 'quickbooks', status: 'pending_setup',
    }).returning(),
  );
  return conn;
}

async function seedInvoiceWithPayment(partnerId: string, orgId: string) {
  return withSystemDbAccessContext(async () => {
    const [inv] = await db.insert(invoices).values({
      partnerId, orgId, status: 'sent', subtotal: '100.00', total: '100.00', balance: '100.00',
    }).returning();
    const [pay] = await db.insert(invoicePayments).values({
      invoiceId: inv.id, orgId, amount: '25.00', method: 'other', receivedAt: '2026-07-16',
    }).returning();
    return { inv, pay };
  });
}

describe('accounting sync partner RLS + physical tenant binding (real breeze_app role)', () => {
  it('cross-partner SELECT is hidden and cross-partner INSERT forge fails with 42501', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const connA = await seedConnection(partnerA.id);

    await withSystemDbAccessContext(() =>
      db.insert(accountingEntityMappings).values({
        connectionId: connA.id, partnerId: partnerA.id, entityType: 'customer',
        organizationId: orgA.id, remoteEntityType: 'Customer', remoteId: 'QB-1',
        linkState: 'confirmed',
      }),
    );

    const seenByB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select().from(accountingEntityMappings).where(eq(accountingEntityMappings.partnerId, partnerA.id)),
    );
    expect(seenByB).toHaveLength(0);

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db.insert(accountingEntityMappings).values({
          connectionId: connA.id, partnerId: partnerA.id, entityType: 'customer',
          organizationId: orgA.id, remoteEntityType: 'Customer', remoteId: 'QB-FORGED',
        }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('SYSTEM context cannot bind partner B\'s org to partner A\'s connection (composite FK 23503)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const connA = await seedConnection(partnerA.id);

    await expect(
      withSystemDbAccessContext(() =>
        db.insert(accountingEntityMappings).values({
          connectionId: connA.id, partnerId: partnerA.id, entityType: 'customer',
          organizationId: orgB.id, remoteEntityType: 'Customer', remoteId: 'QB-XT',
        }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('mapping entity CHECK rejects mismatched local references (23514)', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const connA = await seedConnection(partnerA.id);

    await expect(
      withSystemDbAccessContext(() =>
        db.insert(accountingEntityMappings).values({
          connectionId: connA.id, partnerId: partnerA.id, entityType: 'item',
          organizationId: orgA.id, // item mapping must NOT carry an org ref
          remoteEntityType: 'Item', remoteId: 'QB-I1',
        }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('operation binding partner B\'s invoice to partner A\'s connection fails (23503)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const connA = await seedConnection(partnerA.id);
    const { inv } = await seedInvoiceWithPayment(partnerB.id, orgB.id);

    await expect(
      withSystemDbAccessContext(() =>
        db.insert(accountingSyncOperations).values({
          connectionId: connA.id, partnerId: partnerA.id, direction: 'outbound',
          entityType: 'invoice', invoiceId: inv.id, operation: 'invoice_post',
          idempotencyKey: `forge-${inv.id}`, payload: {}, payloadSha256: '0'.repeat(64),
        }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('attempt must bind the exact (operation, connection, partner) triple (23503)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const connA = await seedConnection(partnerA.id);
    const connB = await seedConnection(partnerB.id);
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const { inv } = await seedInvoiceWithPayment(partnerA.id, orgA.id);

    const [op] = await withSystemDbAccessContext(() =>
      db.insert(accountingSyncOperations).values({
        connectionId: connA.id, partnerId: partnerA.id, direction: 'outbound',
        entityType: 'invoice', invoiceId: inv.id, operation: 'invoice_post',
        idempotencyKey: `op-${inv.id}`, payload: {}, payloadSha256: '0'.repeat(64),
      }).returning(),
    );

    await expect(
      withSystemDbAccessContext(() =>
        db.insert(accountingSyncAttempts).values({
          operationId: op.id, connectionId: connB.id, partnerId: partnerB.id, attemptNumber: 1,
        }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('allocation cannot pair partner A\'s header with partner B\'s invoice (23503)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const connA = await seedConnection(partnerA.id);
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const { inv: invB, pay: payB } = await seedInvoiceWithPayment(partnerB.id, orgB.id);

    const [header] = await withSystemDbAccessContext(() =>
      db.insert(accountingRemotePayments).values({
        connectionId: connA.id, partnerId: partnerA.id,
        remotePaymentId: 'QBP-1', origin: 'provider',
      }).returning(),
    );

    await expect(
      withSystemDbAccessContext(() =>
        db.insert(accountingPaymentAllocations).values({
          remotePaymentHeaderId: header.id, connectionId: connA.id, partnerId: partnerA.id,
          invoicePaymentId: payB.id, invoiceId: invB.id,
          remoteAllocationKey: 'k1', amount: '25.00',
        }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('one-active-connection partial unique holds (23505)', async () => {
    const partnerA = await createPartner();
    // Two connected credentialed rows; activating both must fail.
    const mk = (provider: string) => withSystemDbAccessContext(() =>
      db.insert(accountingConnections).values({
        partnerId: partnerA.id, provider, status: 'connected',
        accessTokenEncrypted: 'enc-a', refreshTokenEncrypted: 'enc-r',
        isActive: true, activatedAt: new Date(),
      }).returning(),
    );
    await mk('quickbooks');
    await expect(mk('xero')).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('is_active requires connected status with credentials (23514)', async () => {
    const partnerA = await createPartner();
    await expect(
      withSystemDbAccessContext(() =>
        db.insert(accountingConnections).values({
          partnerId: partnerA.id, provider: 'quickbooks', status: 'disconnected', isActive: true,
        }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('tenant hash and version travel together (23514)', async () => {
    const partnerA = await createPartner();
    await expect(
      withSystemDbAccessContext(() =>
        db.insert(accountingConnections).values({
          partnerId: partnerA.id, provider: 'quickbooks', status: 'pending_setup',
          remoteTenantKeyHash: 'a'.repeat(64), // version missing
        }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
```

Note: the second `seedConnection` per partner in the attempt test uses provider `'quickbooks'` for both partners — the legacy `(partner_id, provider)` unique is per partner, so this is fine.

- [ ] **Step 4: Run the forge suite**

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/accountingSyncPartnerRls.integration.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/accountingSyncPartnerRls.integration.test.ts
git commit -m "test(accounting): register partner RLS coverage + cross-partner forge suite (P0-1 Stage 1)"
```

---

### Task 8: Org/partner erasure pre-clears + live-work guard (spec §8.14)

**Files:**
- Create: `apps/api/src/services/accounting/accountingErasureGuard.ts`
- Modify: `apps/api/src/services/tenantCascade.ts` (pre-clear entries + guard call)
- Modify: the org-delete route caller (located via grep; expected `apps/api/src/routes/organizations.ts`)
- Create: `apps/api/src/__tests__/integration/accountingErasure.integration.test.ts`

**Interfaces:**
- Consumes: all Task 4–6 tables; `ASSOCIATED_SYSTEM_SCOPED_TABLES` pattern in `tenantCascade.ts` (entries are `{ table: string; clearSql: (orgId: string) => ReturnType<typeof sql> }`, executed in array order before the FK-safe main loop).
- Produces: `AccountingErasureBlockedError` (exported class with `operationIds: string[]`), thrown by `assertNoLiveAccountingWorkForOrg(orgId)`; `cascadeDeleteOrg` calls it before pre-clears. Partner path needs no new list — `cascadeDeletePartner` runs the org cascade per child org first (these pre-clears fire there), then dynamically sweeps every `partner_id` table, which covers all nine accounting tables.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/src/__tests__/integration/accountingErasure.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  accountingConnections, accountingEntityMappings, accountingTaxMappings,
  accountingSyncOperations, accountingSyncAttempts, accountingRemotePayments,
  accountingPaymentAllocations, accountingSyncExceptions,
  invoices, invoicePayments, organizations,
} from '../../db/schema';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { AccountingErasureBlockedError } from '../../services/accounting/accountingErasureGuard';
import { createOrganization, createPartner } from './db-utils';

async function seedFullAccountingHistory(partnerId: string, orgId: string) {
  return withSystemDbAccessContext(async () => {
    const [conn] = await db.insert(accountingConnections).values({
      partnerId, provider: 'quickbooks', status: 'pending_setup',
    }).returning();
    const [inv] = await db.insert(invoices).values({
      partnerId, orgId, status: 'sent', subtotal: '100.00', total: '100.00', balance: '100.00',
    }).returning();
    const [pay] = await db.insert(invoicePayments).values({
      invoiceId: inv.id, orgId, amount: '25.00', method: 'other', receivedAt: '2026-07-16',
    }).returning();
    await db.insert(accountingEntityMappings).values({
      connectionId: conn.id, partnerId, entityType: 'customer', organizationId: orgId,
      remoteEntityType: 'Customer', remoteId: 'QB-C1', linkState: 'confirmed',
    });
    await db.insert(accountingEntityMappings).values({
      connectionId: conn.id, partnerId, entityType: 'invoice', invoiceId: inv.id,
      organizationId: orgId, remoteEntityType: 'Invoice', remoteId: 'QB-INV1', linkState: 'confirmed',
    });
    await db.insert(accountingTaxMappings).values({
      connectionId: conn.id, partnerId, breezeTaxKey: 'exempt', remoteTaxRef: 'NON',
    });
    const [op] = await db.insert(accountingSyncOperations).values({
      connectionId: conn.id, partnerId, direction: 'outbound', entityType: 'invoice',
      invoiceId: inv.id, operation: 'invoice_post', status: 'succeeded',
      idempotencyKey: `inv-${inv.id}-v1`, payload: {}, payloadSha256: '0'.repeat(64),
    }).returning();
    await db.insert(accountingSyncAttempts).values({
      operationId: op.id, connectionId: conn.id, partnerId, attemptNumber: 1, outcome: 'succeeded',
    });
    const [header] = await db.insert(accountingRemotePayments).values({
      connectionId: conn.id, partnerId, remotePaymentId: 'QBP-1', origin: 'provider',
    }).returning();
    await db.insert(accountingPaymentAllocations).values({
      remotePaymentHeaderId: header.id, connectionId: conn.id, partnerId,
      invoicePaymentId: pay.id, invoiceId: inv.id, remoteAllocationKey: 'k1', amount: '25.00',
    });
    await db.insert(accountingSyncExceptions).values({
      connectionId: conn.id, partnerId, operationId: op.id, category: 'tax_variance',
      entityType: 'invoice', invoiceId: inv.id, summary: 'variance', status: 'open',
    });
    return { conn, inv, pay, op, header };
  });
}

describe('org erasure with accounting history (spec §8.14)', () => {
  it('cascadeDeleteOrg completes without FK violation and preserves partner-level rows', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { conn } = await seedFullAccountingHistory(partner.id, org.id);

    await cascadeDeleteOrg(org.id, null);

    await withSystemDbAccessContext(async () => {
      // Org is gone.
      expect(await db.select().from(organizations).where(eq(organizations.id, org.id))).toHaveLength(0);
      // No accounting row references the erased org's entities.
      expect(await db.select().from(accountingEntityMappings)
        .where(eq(accountingEntityMappings.partnerId, partner.id))).toHaveLength(0);
      expect(await db.select().from(accountingSyncOperations)
        .where(eq(accountingSyncOperations.partnerId, partner.id))).toHaveLength(0);
      expect(await db.select().from(accountingSyncAttempts)
        .where(eq(accountingSyncAttempts.partnerId, partner.id))).toHaveLength(0);
      expect(await db.select().from(accountingPaymentAllocations)
        .where(eq(accountingPaymentAllocations.partnerId, partner.id))).toHaveLength(0);
      expect(await db.select().from(accountingRemotePayments)
        .where(eq(accountingRemotePayments.partnerId, partner.id))).toHaveLength(0);
      expect(await db.select().from(accountingSyncExceptions)
        .where(eq(accountingSyncExceptions.partnerId, partner.id))).toHaveLength(0);
      // Partner-level rows survive.
      expect(await db.select().from(accountingConnections)
        .where(eq(accountingConnections.id, conn.id))).toHaveLength(1);
      expect(await db.select().from(accountingTaxMappings)
        .where(eq(accountingTaxMappings.partnerId, partner.id))).toHaveLength(1);
    });
  });

  it('org erasure is blocked (fail-closed) while an ambiguous operation references the org', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { op } = await seedFullAccountingHistory(partner.id, org.id);

    await withSystemDbAccessContext(() =>
      db.update(accountingSyncOperations)
        .set({ status: 'ambiguous' })
        .where(eq(accountingSyncOperations.id, op.id)),
    );

    await expect(cascadeDeleteOrg(org.id, null)).rejects.toBeInstanceOf(AccountingErasureBlockedError);

    // Nothing was deleted.
    await withSystemDbAccessContext(async () => {
      expect(await db.select().from(organizations).where(eq(organizations.id, org.id))).toHaveLength(1);
      expect(await db.select().from(accountingSyncOperations)
        .where(eq(accountingSyncOperations.id, op.id))).toHaveLength(1);
    });
  });

  it('org erasure is blocked while an unexpired running lease references the org', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { op } = await seedFullAccountingHistory(partner.id, org.id);

    await withSystemDbAccessContext(() =>
      db.update(accountingSyncOperations)
        .set({
          status: 'running',
          leaseToken: sql`gen_random_uuid()`,
          leaseExpiresAt: sql`now() + interval '60 seconds'`,
        })
        .where(eq(accountingSyncOperations.id, op.id)),
    );

    await expect(cascadeDeleteOrg(org.id, null)).rejects.toBeInstanceOf(AccountingErasureBlockedError);
  });
});
```

(Check `cascadeDeleteOrg`'s exact signature with `grep -n "export async function cascadeDeleteOrg" apps/api/src/services/tenantCascade.ts` — pass `performedBy` in the form it expects; if it requires an email/actor object, adjust the two call sites in this test accordingly.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/accountingErasure.integration.test.ts`
Expected: FAIL — test 1 errors with FK violation (`accounting_*` rows reference the invoices being cascade-deleted), tests 2–3 cannot resolve `AccountingErasureBlockedError`.

- [ ] **Step 3: Implement the guard**

```ts
// apps/api/src/services/accounting/accountingErasureGuard.ts
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';

/**
 * Fail-closed erasure gate (spec §8.14): an org cannot be erased while an
 * accounting operation referencing its entities is running under an unexpired
 * lease or sitting in `ambiguous` — a remote financial write may exist that
 * has not been adopted or proven absent. Same rule as connection disconnect.
 */
export class AccountingErasureBlockedError extends Error {
  readonly operationIds: string[];
  constructor(operationIds: string[]) {
    super(`Org erasure blocked: ${operationIds.length} accounting operation(s) are running or ambiguous`);
    this.name = 'AccountingErasureBlockedError';
    this.operationIds = operationIds;
  }
}

export async function assertNoLiveAccountingWorkForOrg(orgId: string): Promise<void> {
  const rows = await withSystemDbAccessContext(async () => {
    const result = await db.execute(sql`
      SELECT o.id FROM accounting_sync_operations o
      WHERE (o.organization_id = ${orgId}
             OR o.invoice_id IN (SELECT id FROM invoices WHERE org_id = ${orgId})
             OR o.invoice_payment_id IN (SELECT id FROM invoice_payments WHERE org_id = ${orgId}))
        AND (o.status = 'ambiguous'
             OR (o.status = 'running' AND o.lease_expires_at > now()))
      LIMIT 50
    `);
    return result as unknown as Array<{ id: string }>;
  });
  const ids = Array.from(rows, (r) => r.id);
  if (ids.length > 0) throw new AccountingErasureBlockedError(ids);
}
```

(If `db.execute` in this repo returns `{ rows }` rather than an iterable of rows, mirror how `tenantCascade.ts`'s `extractRowCount`/row access does it — check `grep -n "db.execute" apps/api/src/services/tenantCascade.ts` and copy that access pattern.)

- [ ] **Step 4: Add the pre-clears and guard call to `tenantCascade.ts`**

Append these entries to the END of the `ASSOCIATED_SYSTEM_SCOPED_TABLES` array (order within this block is load-bearing: exceptions → allocations+headers → attempts → operations → mappings):

```ts
  // PSA P0-1 accounting sync (spec §8.14): partner-axis tables that hold
  // RESTRICT-style composite FKs into this org's invoices/payments. They use
  // organization_id (not org_id), so neither the org_id sweep nor the cascade
  // contract test reaches them — these pre-clears are the ONLY org-erasure
  // coverage. Every new accounting table referencing an org-owned entity MUST
  // be added here in the same PR that creates it.
  {
    table: 'accounting_sync_exceptions',
    clearSql: (orgId) => sql`
      DELETE FROM accounting_sync_exceptions e
      WHERE e.organization_id = ${orgId}
         OR e.invoice_id IN (SELECT id FROM invoices WHERE org_id = ${orgId})
         OR e.invoice_payment_id IN (SELECT id FROM invoice_payments WHERE org_id = ${orgId})
         OR e.operation_id IN (
              SELECT o.id FROM accounting_sync_operations o
              WHERE o.organization_id = ${orgId}
                 OR o.invoice_id IN (SELECT id FROM invoices WHERE org_id = ${orgId})
                 OR o.invoice_payment_id IN (SELECT id FROM invoice_payments WHERE org_id = ${orgId})
            )
    `,
  },
  {
    // Allocations for this org's invoices, plus remote-payment headers whose
    // every allocation belonged to this org (or whose outbound op is org-bound).
    // Headers spanning another org's allocations survive with those allocations.
    table: 'accounting_payment_allocations',
    clearSql: (orgId) => sql`
      WITH org_ops AS (
        SELECT o.id FROM accounting_sync_operations o
        WHERE o.organization_id = ${orgId}
           OR o.invoice_id IN (SELECT id FROM invoices WHERE org_id = ${orgId})
           OR o.invoice_payment_id IN (SELECT id FROM invoice_payments WHERE org_id = ${orgId})
      ),
      del_alloc AS (
        DELETE FROM accounting_payment_allocations
        WHERE invoice_id IN (SELECT id FROM invoices WHERE org_id = ${orgId})
        RETURNING id, remote_payment_header_id
      )
      DELETE FROM accounting_remote_payments h
      WHERE (h.id IN (SELECT remote_payment_header_id FROM del_alloc)
             OR h.outbound_operation_id IN (SELECT id FROM org_ops))
        AND NOT EXISTS (
          SELECT 1 FROM accounting_payment_allocations a
          WHERE a.remote_payment_header_id = h.id
            AND a.id NOT IN (SELECT id FROM del_alloc)
        )
    `,
  },
  {
    table: 'accounting_sync_attempts',
    clearSql: (orgId) => sql`
      DELETE FROM accounting_sync_attempts
      WHERE operation_id IN (
        SELECT o.id FROM accounting_sync_operations o
        WHERE o.organization_id = ${orgId}
           OR o.invoice_id IN (SELECT id FROM invoices WHERE org_id = ${orgId})
           OR o.invoice_payment_id IN (SELECT id FROM invoice_payments WHERE org_id = ${orgId})
      )
    `,
  },
  {
    // Detach dependency references into the deleted set, then delete the ops.
    table: 'accounting_sync_operations',
    clearSql: (orgId) => sql`
      WITH org_ops AS (
        SELECT o.id FROM accounting_sync_operations o
        WHERE o.organization_id = ${orgId}
           OR o.invoice_id IN (SELECT id FROM invoices WHERE org_id = ${orgId})
           OR o.invoice_payment_id IN (SELECT id FROM invoice_payments WHERE org_id = ${orgId})
      ),
      detach AS (
        UPDATE accounting_sync_operations
        SET depends_on_operation_id = NULL
        WHERE depends_on_operation_id IN (SELECT id FROM org_ops)
          AND id NOT IN (SELECT id FROM org_ops)
        RETURNING id
      )
      DELETE FROM accounting_sync_operations WHERE id IN (SELECT id FROM org_ops)
    `,
  },
  {
    table: 'accounting_entity_mappings',
    clearSql: (orgId) => sql`
      DELETE FROM accounting_entity_mappings
      WHERE organization_id = ${orgId}
         OR invoice_id IN (SELECT id FROM invoices WHERE org_id = ${orgId})
    `,
  },
```

Then, in `cascadeDeleteOrg`, immediately BEFORE the `for (const assoc of ASSOCIATED_SYSTEM_SCOPED_TABLES)` loop (~line 557), add:

```ts
  // Fail-closed accounting gate (PSA P0-1 §8.14): a live lease or ambiguous
  // remote write must be adopted/resolved before the org's financial rows
  // can be erased. Throws AccountingErasureBlockedError.
  await assertNoLiveAccountingWorkForOrg(orgId);
```

with the import at the top of `tenantCascade.ts`:

```ts
import { assertNoLiveAccountingWorkForOrg } from './accounting/accountingErasureGuard';
```

- [ ] **Step 5: Map the guard error to HTTP 409 at the route caller**

Run: `grep -rn "cascadeDeleteOrg" apps/api/src/routes` — expected hit in the organizations delete route. In that handler's try/catch (or wrapping the call), add before generic error handling:

```ts
    if (err instanceof AccountingErasureBlockedError) {
      return c.json({
        error: 'Organization has running or ambiguous accounting operations; resolve them before deletion',
        operationIds: err.operationIds,
      }, 409);
    }
```

with the corresponding import. If the route has no try/catch, wrap only the cascade call.

- [ ] **Step 6: Run the integration tests**

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/accountingErasure.integration.test.ts`
Expected: PASS (3 tests).
Also run: `cd apps/api && pnpm test:integration src/__tests__/integration/tenantCascade.integration.test.ts`
Expected: PASS — the contract test only inspects `org_id`-columned tables, unaffected.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/accounting/accountingErasureGuard.ts apps/api/src/services/tenantCascade.ts apps/api/src/routes/organizations.ts apps/api/src/__tests__/integration/accountingErasure.integration.test.ts
git commit -m "feat(accounting): org-erasure pre-clears + fail-closed live-work guard (P0-1 Stage 1, spec 8.14)"
```

---

### Task 9: `accounting:*` permissions

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts` (`PERMISSION_GRANTS`)
- Modify: `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS`)
- Create: `apps/api/migrations/2026-07-21-e-accounting-permissions.sql`
- Modify: `apps/api/src/routes/accounting/index.ts` (permission middleware)
- Test: `apps/api/src/db/seed.test.ts` (extend)

**Interfaces:**
- Consumes: existing `requirePermission(resource, action)` middleware and `PERMISSIONS` API re-export (see `apps/api/src/routes/invoices/invoices.ts:20`).
- Produces: `PERMISSION_GRANTS.ACCOUNTING_VIEW/_MANAGE/_MAP/_POST/_RESOLVE` — `{ resource: 'accounting', action: 'view' | 'manage' | 'map' | 'post' | 'resolve' }`. Stage 2+ routes reuse these. MFA semantics stay the existing `requireMfa()` session-flag check (spec §15.1 as revised — no step-up mechanism in P0-1).

- [ ] **Step 1: Write the failing seed test**

In `apps/api/src/db/seed.test.ts`, add (mirroring existing DEFAULT_PERMISSIONS assertions):

```ts
  it('seeds the five accounting permissions', () => {
    const accounting = DEFAULT_PERMISSIONS.filter((p) => p.resource === 'accounting').map((p) => p.action).sort();
    expect(accounting).toEqual(['manage', 'map', 'post', 'resolve', 'view']);
  });
```

Run: `pnpm --filter @breeze/api test src/db/seed.test.ts`
Expected: FAIL — empty array.

- [ ] **Step 2: Add the grants**

In `packages/shared/src/constants/permissions.ts`, after the Invoices block:

```ts
  // Accounting sync (PSA P0-1). MFA gate: manage/map mutations plus activation,
  // disconnect, cancellation, and exception dismissal use requireMfa() —
  // session-flag semantics, no step-up mechanism exists in P0-1.
  ACCOUNTING_VIEW: { resource: 'accounting', action: 'view' },
  ACCOUNTING_MANAGE: { resource: 'accounting', action: 'manage' },
  ACCOUNTING_MAP: { resource: 'accounting', action: 'map' },
  ACCOUNTING_POST: { resource: 'accounting', action: 'post' },
  ACCOUNTING_RESOLVE: { resource: 'accounting', action: 'resolve' },
```

In `apps/api/src/db/seed.ts` `DEFAULT_PERMISSIONS`, after the invoices entries:

```ts
  { resource: 'accounting', action: 'view', description: 'View accounting connections, mappings, sync status, and exceptions' },
  { resource: 'accounting', action: 'manage', description: 'Connect/reconnect/disconnect providers, activate, and change financial defaults' },
  { resource: 'accounting', action: 'map', description: 'Confirm/create/remap customer, item, tax, and account mappings' },
  { resource: 'accounting', action: 'post', description: 'Manually/bulk post and retry financial sync operations' },
  { resource: 'accounting', action: 'resolve', description: 'Resolve or dismiss accounting reconciliation exceptions' },
```

- [ ] **Step 3: Write the migration**

```sql
-- PSA P0-1 Stage 1 (spec §15.1): accounting permissions + grant to the same
-- partner-scope system roles that hold invoices:send (billing admins).
-- Idempotent. No inner BEGIN/COMMIT.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'accounting' AND action = 'view') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('accounting', 'view', 'View accounting connections, mappings, sync status, and exceptions');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'accounting' AND action = 'manage') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('accounting', 'manage', 'Connect/reconnect/disconnect providers, activate, and change financial defaults');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'accounting' AND action = 'map') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('accounting', 'map', 'Confirm/create/remap customer, item, tax, and account mappings');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'accounting' AND action = 'post') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('accounting', 'post', 'Manually/bulk post and retry financial sync operations');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'accounting' AND action = 'resolve') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('accounting', 'resolve', 'Resolve or dismiss accounting reconciliation exceptions');
  END IF;
END $$;

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'invoices' AND p1.action = 'send'
JOIN roles r ON r.id = rp.role_id AND r.is_system = TRUE AND r.scope = 'partner'
JOIN permissions p2 ON p2.resource = 'accounting' AND p2.action IN ('view','manage','map','post','resolve')
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
```

- [ ] **Step 4: Wire permissions into the existing accounting routes**

In `apps/api/src/routes/accounting/index.ts`, add near the `partnerScopes` const (import `requirePermission` from `../../middleware/auth` and `PERMISSIONS` from `../../services/permissions`, matching `routes/invoices/invoices.ts:20`):

```ts
const accountingView = requirePermission(PERMISSIONS.ACCOUNTING_VIEW.resource, PERMISSIONS.ACCOUNTING_VIEW.action);
const accountingManage = requirePermission(PERMISSIONS.ACCOUNTING_MANAGE.resource, PERMISSIONS.ACCOUNTING_MANAGE.action);
const accountingMap = requirePermission(PERMISSIONS.ACCOUNTING_MAP.resource, PERMISSIONS.ACCOUNTING_MAP.action);
```

Then insert into each route's middleware chain immediately after `partnerScopes`:
- GET status route (`GET /:provider`) → `accountingView`
- `GET /:provider/connect`, `GET /:provider/callback`, disconnect route, settings route → `accountingManage`
- customer list/import routes → `accountingMap`

Keep `requireMfa()` exactly where it is today (connect/write routes).

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @breeze/api test src/db/seed.test.ts
pnpm --filter @breeze/api test src/routes/accounting
cd apps/api && npx tsc --noEmit && cd ../..
cd packages/shared && pnpm typecheck && cd ../..
```
Expected: seed test PASS; existing accounting route tests may FAIL with 403 if their mock auth lacks the new permission — update those tests' auth fixture to include `accounting` grants the same way invoice route tests grant `invoices:*` (copy that fixture pattern), then re-run to PASS.

- [ ] **Step 6: Apply migration + drift (same commands as Task 4 Step 3, file `2026-07-21-e-accounting-permissions.sql`), then commit**

```bash
git add packages/shared/src/constants/permissions.ts apps/api/src/db/seed.ts apps/api/src/db/seed.test.ts apps/api/migrations/2026-07-21-e-accounting-permissions.sql apps/api/src/routes/accounting/index.ts
git commit -m "feat(accounting): accounting:{view,manage,map,post,resolve} permissions + route gating (P0-1 Stage 1)"
```

---

### Task 10: Typed provider contract

**Files:**
- Modify: `apps/api/src/services/accounting/types.ts`
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts`
- Test: `apps/api/src/services/accounting/quickbooksProvider.normalizeError.test.ts`

**Interfaces:**
- Consumes: `AccountingErrorCategory` from `@breeze/shared` (Task 1).
- Produces: the DTO types below plus `AccountingProvider` members `capabilities`, `upsertCustomer`, `upsertItem`, `createInvoice`, `voidInvoice`, `createPayment`, `reversePayment`, `reconcile`, `normalizeError`. Stage 2/3 implement the bodies. **Keep every currently-implemented member of the interface (OAuth, customer listing, webhook verification, company profile) byte-identical** — routes and the customer import depend on them.

- [ ] **Step 1: Read the current contract**

Run: `cat apps/api/src/services/accounting/types.ts` and `grep -n "pushInvoice\|upsertCustomer\|upsertItem\|voidInvoice\|reconcileChanges\|listRemoteItems" apps/api/src -r`
Expected: the `...args: unknown[]` methods exist only in `types.ts` and `quickbooksProvider.ts` (they throw `NotImplemented`). If any route calls them, STOP and report — the rename below would break it.

- [ ] **Step 2: Write the failing normalizeError test**

```ts
// apps/api/src/services/accounting/quickbooksProvider.normalizeError.test.ts
import { describe, it, expect } from 'vitest';
import { QuickbooksProvider } from './quickbooksProvider';

describe('QuickbooksProvider.normalizeError', () => {
  const provider = new QuickbooksProvider();
  const cases: Array<[unknown, string]> = [
    [{ status: 401, message: 'token expired' }, 'reauth_required'],
    [{ status: 403, message: 'forbidden' }, 'reauth_required'],
    [{ status: 429, retryAfterSeconds: 30 }, 'rate_limited'],
    [{ status: 404 }, 'not_found'],
    [{ status: 500 }, 'transient'],
    [{ status: 503 }, 'transient'],
    [{ status: 400, code: '5010' }, 'conflict'], // QBO stale-object / SyncToken
    [{ status: 400, code: '6000' }, 'validation'],
    [{ status: 422 }, 'validation'],
    [new Error('socket hang up'), 'transient'],
  ];
  it.each(cases)('maps %j to %s', (input, category) => {
    expect(provider.normalizeError(input).category).toBe(category);
  });
  it('bounds the message length to 500 chars', () => {
    const result = provider.normalizeError({ status: 400, message: 'x'.repeat(2000) });
    expect(result.message.length).toBeLessThanOrEqual(500);
  });
});
```

Run: `pnpm --filter @breeze/api test src/services/accounting/quickbooksProvider.normalizeError.test.ts`
Expected: FAIL — `normalizeError` does not exist.

- [ ] **Step 3: Add the DTO types**

In `apps/api/src/services/accounting/types.ts`, add (import `AccountingErrorCategory` from `@breeze/shared`):

```ts
// ---------------------------------------------------------------------------
// Typed provider write/read contract (PSA P0-1 §7.2). Adapters translate these
// shared DTOs to/from provider payloads; they never decide Breeze permissions,
// retries, or mapping policy.
// ---------------------------------------------------------------------------

export interface ProviderContext {
  connectionId: string;
  partnerId: string;
  accessToken: string;
  remoteTenantId: string; // QBO realmId / Xero tenantId (decrypted, provider-call-boundary only)
  environment: 'production' | 'sandbox';
}

export interface RemotePageRequest { cursor?: string; pageSize?: number }
export interface RemotePage<T> { items: T[]; nextCursor?: string }

export interface RemoteCustomer {
  remoteId: string; displayName: string; email?: string; active: boolean; remoteVersion?: string;
}
export interface RemoteItem {
  remoteId: string; name: string; sku?: string; active: boolean; remoteVersion?: string; incomeAccountRef?: string;
}
export interface RemoteAccount { ref: string; name: string; type: string; active: boolean }
export interface RemoteTaxCode { ref: string; name: string; rate?: number; active: boolean }
export interface RemoteCompanyProfile {
  companyName: string; baseCurrency: string; country?: string; remoteTenantId: string;
}

/** Every write carries the stable Breeze operation ID + the persisted per-attempt
 * provider request ID (spec §7.2). The operation ID never changes on retry. */
export interface RemoteWriteInputBase {
  operationId: string;
  providerRequestId: string;
  currency: string;
}

export interface CustomerUpsert extends RemoteWriteInputBase {
  remoteId?: string;
  remoteVersion?: string;
  snapshot: {
    name: string; contactName?: string; email?: string; phone?: string;
    billingAddress?: Record<string, string>; active: boolean;
  };
}

export interface ItemUpsert extends RemoteWriteInputBase {
  remoteId?: string;
  remoteVersion?: string;
  snapshot: {
    name: string; sku?: string; description?: string; unitPrice: string;
    incomeAccountRef: string; taxCodeRef?: string; active: boolean;
  };
}

export interface InvoiceCreateLine {
  description: string; quantity: string; unitPrice: string; amount: string;
  taxable: boolean; remoteItemRef?: string; incomeAccountRef?: string;
}

export interface InvoiceCreate extends RemoteWriteInputBase {
  remoteCustomerId: string;
  documentNumber: string; // Breeze invoice number → QBO DocNumber / Xero InvoiceNumber
  issueDate: string; dueDate?: string;
  lines: InvoiceCreateLine[];
  taxCodeRef?: string;
  totals: { subtotal: string; taxTotal: string; total: string };
  publicNote?: string;
}

export interface InvoiceVoid extends RemoteWriteInputBase {
  remoteInvoiceId: string; remoteVersion?: string;
}

export interface PaymentCreate extends RemoteWriteInputBase {
  remoteCustomerId: string; remoteInvoiceId: string;
  amount: string; receivedDate: string; reference?: string;
  paymentAccountRef: string;
}

export interface PaymentReverse extends RemoteWriteInputBase {
  remotePaymentId: string; remoteVersion?: string;
}

export interface ReconcileRequest { stream: 'payments' | 'invoices'; cursor?: unknown; overlapFrom?: string }
export interface ReconcilePage { changes: unknown[]; nextCursor?: unknown; done: boolean }

export interface RemoteWriteResult {
  remoteId: string; remoteVersion?: string; remoteDocumentNumber?: string; responseSummary?: string;
}
export interface RemoteInvoiceResult extends RemoteWriteResult {
  remoteTotals: { subtotal: string; taxTotal: string; total: string };
}
export interface RemotePaymentResult extends RemoteWriteResult {
  remoteStatus?: string;
}

export interface NormalizedProviderError {
  category: AccountingErrorCategory;
  message: string;
  code?: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
}

/** Declares native behavior; cannot waive P0 outcomes (spec §7.2). */
export interface ProviderCapabilities {
  explicitTaxOverride: boolean;
  idempotencyWindowSeconds: number | null; // null = provider-documented requestid semantics, no fixed cache window
  webhookCategories: string[];
  multiAllocationPayments: boolean;
}
```

- [ ] **Step 4: Replace the untyped interface members**

In the `AccountingProvider` interface in `types.ts`: delete every `(...args: unknown[])` member and add (keep all currently-implemented members exactly as they are):

```ts
  readonly capabilities: ProviderCapabilities;

  getCompanyProfile(ctx: ProviderContext): Promise<RemoteCompanyProfile>;
  listItems(ctx: ProviderContext, page: RemotePageRequest): Promise<RemotePage<RemoteItem>>;
  listAccounts(ctx: ProviderContext): Promise<RemoteAccount[]>;
  listTaxCodes(ctx: ProviderContext): Promise<RemoteTaxCode[]>;

  upsertCustomer(ctx: ProviderContext, input: CustomerUpsert): Promise<RemoteWriteResult>;
  upsertItem(ctx: ProviderContext, input: ItemUpsert): Promise<RemoteWriteResult>;
  createInvoice(ctx: ProviderContext, input: InvoiceCreate): Promise<RemoteInvoiceResult>;
  voidInvoice(ctx: ProviderContext, input: InvoiceVoid): Promise<RemoteWriteResult>;
  createPayment(ctx: ProviderContext, input: PaymentCreate): Promise<RemotePaymentResult>;
  reversePayment(ctx: ProviderContext, input: PaymentReverse): Promise<RemoteWriteResult>;

  reconcile(ctx: ProviderContext, input: ReconcileRequest): Promise<ReconcilePage>;
  normalizeError(error: unknown): NormalizedProviderError;
```

If the interface already declares a company-profile or list method under another name that IS implemented, keep the implemented one and skip the duplicate declaration here (do not break the shipped customer listing).

- [ ] **Step 5: Update `QuickbooksProvider`**

Rename `pushInvoice` → `createInvoice`, keep `upsertCustomer`/`upsertItem`/`voidInvoice`, rename `reconcileChanges` → `reconcile`, and add `createPayment`/`reversePayment`/`getCompanyProfile`/`listItems`/`listAccounts`/`listTaxCodes` where missing — all with the new typed signatures, all bodies still `throw new Error('NotImplemented: Phase B')` (customer/item), `'NotImplemented: Phase C'` (invoice/payment), `'NotImplemented: Phase D'` (reconcile/company/list-discovery), matching the file's existing phase markers. Add:

```ts
  readonly capabilities: ProviderCapabilities = {
    explicitTaxOverride: true,          // QBO TxnTaxDetail override
    idempotencyWindowSeconds: null,     // QBO requestid follows documented lifetime rules, not a fixed cache
    webhookCategories: ['Customer', 'Item', 'Invoice', 'Payment'],
    multiAllocationPayments: true,      // QBO Payment.Line can span invoices (read inbound)
  };

  normalizeError(error: unknown): NormalizedProviderError {
    const bounded = (m: string | undefined, fallback: string) => (m ?? fallback).slice(0, 500);
    const e = error as { status?: number; code?: string; message?: string; retryAfterSeconds?: number };
    const httpStatus = typeof e?.status === 'number' ? e.status : undefined;
    if (httpStatus === 401 || httpStatus === 403) {
      return { category: 'reauth_required', httpStatus, message: bounded(e.message, 'QuickBooks authorization expired or revoked') };
    }
    if (httpStatus === 429) {
      return { category: 'rate_limited', httpStatus, retryAfterSeconds: e.retryAfterSeconds, message: bounded(e.message, 'QuickBooks rate limit') };
    }
    if (httpStatus === 404) return { category: 'not_found', httpStatus, message: bounded(e.message, 'QuickBooks object not found') };
    if (httpStatus !== undefined && httpStatus >= 500) return { category: 'transient', httpStatus, message: bounded(e.message, 'QuickBooks server error') };
    if (e?.code === '5010') {
      // QBO stale-object error: SyncToken out of date — fetch latest before deciding.
      return { category: 'conflict', httpStatus, code: e.code, message: bounded(e.message, 'QuickBooks SyncToken stale') };
    }
    if (httpStatus === 400 || httpStatus === 422) {
      return { category: 'validation', httpStatus, code: e.code, message: bounded(e.message, 'QuickBooks validation error') };
    }
    if (httpStatus === 409) return { category: 'conflict', httpStatus, message: bounded(e.message, 'QuickBooks conflict') };
    return { category: 'transient', message: bounded(e?.message, 'Unknown QuickBooks error') };
  }
```

(Import the new types from `./types`. `QuickbooksProvider` must already be exported as a class; if only an instance is exported, export the class too for the test.)

- [ ] **Step 6: Run tests + typecheck**

```bash
pnpm --filter @breeze/api test src/services/accounting
cd apps/api && npx tsc --noEmit
```
Expected: normalizeError test PASS (11 cases); typecheck clean (the compile itself proves `QuickbooksProvider` still satisfies `AccountingProvider`).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/accounting/types.ts apps/api/src/services/accounting/quickbooksProvider.ts apps/api/src/services/accounting/quickbooksProvider.normalizeError.test.ts
git commit -m "feat(accounting): typed provider contract with capabilities + normalized errors (P0-1 Stage 1)"
```

---

### Task 11: Versioned remote-tenant HMAC helper

**Files:**
- Create: `apps/api/src/services/accounting/remoteTenantKey.ts`
- Test: `apps/api/src/services/accounting/remoteTenantKey.test.ts`
- Modify: `apps/api/src/config/env.ts` (+ `.env.example` if present: `grep -rn "QBO_CLIENT_ID" apps/api/.env.example .env.example 2>/dev/null`)

**Interfaces:**
- Consumes: `ACCOUNTING_TENANT_HMAC_KEY_V1` env var (base64-encoded ≥32-byte key).
- Produces: `computeRemoteTenantKeyHash(provider: string, rawTenantId: string, version?: number): { hash: string; version: number }` (64-char hex) and `ACTIVE_TENANT_KEY_VERSION = 1`. Used by Task 12's backfill and the Stage 2 OAuth flow. Key rotation = add v2 to `KEYS`, bump `ACTIVE_TENANT_KEY_VERSION`, dual-read until rederived (spec §15.3).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/accounting/remoteTenantKey.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/env', () => ({
  ACCOUNTING_TENANT_HMAC_KEY_V1: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
}));

import { computeRemoteTenantKeyHash, ACTIVE_TENANT_KEY_VERSION } from './remoteTenantKey';

describe('remote tenant key hash', () => {
  it('is deterministic, versioned, 64-char hex, and provider-scoped', () => {
    const a = computeRemoteTenantKeyHash('quickbooks', 'realm-123');
    const b = computeRemoteTenantKeyHash('quickbooks', 'realm-123');
    expect(a).toEqual(b);
    expect(a.version).toBe(ACTIVE_TENANT_KEY_VERSION);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    // Same raw ID under a different provider must not collide.
    expect(computeRemoteTenantKeyHash('xero', 'realm-123').hash).not.toBe(a.hash);
    // Never the identity/plaintext.
    expect(a.hash).not.toContain('realm-123');
  });

  it('throws for an unconfigured key version', () => {
    expect(() => computeRemoteTenantKeyHash('quickbooks', 'realm-123', 99)).toThrow(/not configured/);
  });
});
```

Run: `pnpm --filter @breeze/api test src/services/accounting/remoteTenantKey.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 2: Implement**

In `apps/api/src/config/env.ts`, alongside the QBO_* exports:

```ts
export const ACCOUNTING_TENANT_HMAC_KEY_V1 = process.env.ACCOUNTING_TENANT_HMAC_KEY_V1 ?? '';
```

```ts
// apps/api/src/services/accounting/remoteTenantKey.ts
import { createHmac } from 'crypto';
import { ACCOUNTING_TENANT_HMAC_KEY_V1 } from '../../config/env';

/**
 * Versioned keyed hash of the provider tenant identifier (QBO realm / Xero
 * tenant) — equality and reconnect detection without exposing the raw ID
 * (spec §8.1, §15.3). The raw tenant ID itself stays encrypted in
 * realm_id_encrypted; this hash is what uniqueness and webhook lookups use.
 * Rotation: add the next version to KEYS, bump ACTIVE_TENANT_KEY_VERSION,
 * dual-read the prior version until every connection hash is rederived.
 */
export const ACTIVE_TENANT_KEY_VERSION = 1;

const KEYS: Record<number, string> = {
  1: ACCOUNTING_TENANT_HMAC_KEY_V1,
};

export function computeRemoteTenantKeyHash(
  provider: string,
  rawTenantId: string,
  version: number = ACTIVE_TENANT_KEY_VERSION,
): { hash: string; version: number } {
  const key = KEYS[version];
  if (!key) throw new Error(`accounting tenant HMAC key v${version} is not configured`);
  const hash = createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`${provider}:${rawTenantId}`)
    .digest('hex');
  return { hash, version };
}
```

If a `.env.example` exists with the QBO_* placeholders, add `ACCOUNTING_TENANT_HMAC_KEY_V1=base64-encoded-32-byte-key` next to them (generic placeholder only — repo rule).

- [ ] **Step 3: Run test + typecheck**

Run: `pnpm --filter @breeze/api test src/services/accounting/remoteTenantKey.test.ts && cd apps/api && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/accounting/remoteTenantKey.ts apps/api/src/services/accounting/remoteTenantKey.test.ts apps/api/src/config/env.ts
git commit -m "feat(accounting): versioned HMAC tenant-key hashing (P0-1 Stage 1)"
```

---

### Task 12: Connection lifecycle — activate, soft disconnect, tenant-hash backfill

**Files:**
- Modify: `apps/api/src/services/accounting/accountingConnectionService.ts`
- Modify: `apps/api/src/routes/accounting/index.ts` (disconnect handler)
- Test: `apps/api/src/services/accounting/accountingConnectionService.test.ts` (create or extend)

**Interfaces:**
- Consumes: Task 2 columns; Task 5/6 tables (nonterminal-work checks); Task 11 `computeRemoteTenantKeyHash`; existing `decryptSecret` (same import the service already uses for tokens — check its current import line).
- Produces:
  - `activateConnection(partnerId: string, connectionId: string): Promise<ActivationResult>` where `ActivationResult = { ok: true } | { ok: false; code: 'NOT_FOUND' | 'NOT_CONNECTED' | 'CURRENCY_MISMATCH' | 'OLD_CONNECTION_HAS_WORK' | 'VARIANCE_OPEN'; operationCount?: number }`
  - `softDisconnectConnection(partnerId: string, connectionId: string, opts: { confirmCancel?: boolean; cancelReason?: string; actorUserId?: string | null }): Promise<DisconnectResult>` where `DisconnectResult = { ok: true; canceledCount: number } | { ok: false; code: 'NOT_FOUND' | 'LIVE_OR_AMBIGUOUS'; operationIds: string[] } | { ok: false; code: 'NONTERMINAL_WORK'; counts: Record<string, number> }`
  - `backfillTenantKeyHashes(): Promise<{ hashed: number; corrupt: number }>`
  - `NONTERMINAL_OUTBOUND_STATUSES = ['pending','queued','running','waiting_dependency','ambiguous','blocked','failed'] as const`
  - Existing `upsertConnection`, `getConnection`, `markStatus` unchanged; `deleteConnection` kept but ONLY for the tenant-erasure workflow (add that comment) — no route may call it anymore.

- [ ] **Step 1: Write the failing unit tests**

Create/extend `accountingConnectionService.test.ts` using the repo's controllable-chain mock (copy the `vi.mock('../../db', ...)` block from `src/services/invoiceService.test.ts`, adding `'transaction'` support):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute', 'onConflictDoUpdate', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  (db as { transaction: unknown }).transaction = (fn: (tx: unknown) => unknown) => fn(db);
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

vi.mock('./remoteTenantKey', () => ({
  ACTIVE_TENANT_KEY_VERSION: 1,
  computeRemoteTenantKeyHash: vi.fn(() => ({ hash: 'a'.repeat(64), version: 1 })),
}));

import { activateConnection, softDisconnectConnection } from './accountingConnectionService';

describe('activateConnection guards', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('refuses a non-connected candidate', async () => {
    queueResult([]); // advisory lock execute
    queueResult([{ id: 'c1', partnerId: 'p1', status: 'disconnected', accessTokenEncrypted: null, refreshTokenEncrypted: null, homeCurrency: 'USD' }]);
    const res = await activateConnection('p1', 'c1');
    expect(res).toEqual({ ok: false, code: 'NOT_CONNECTED' });
  });

  it('refuses a currency mismatch', async () => {
    queueResult([]); // advisory lock
    queueResult([{ id: 'c1', partnerId: 'p1', status: 'connected', accessTokenEncrypted: 'e', refreshTokenEncrypted: 'e', homeCurrency: 'EUR' }]);
    queueResult([{ currencyCode: 'USD' }]); // partner
    const res = await activateConnection('p1', 'c1');
    expect(res).toEqual({ ok: false, code: 'CURRENCY_MISMATCH' });
  });

  it('refuses when the old active connection still has nonterminal outbound work', async () => {
    queueResult([]); // advisory lock
    queueResult([{ id: 'c2', partnerId: 'p1', status: 'connected', accessTokenEncrypted: 'e', refreshTokenEncrypted: 'e', homeCurrency: 'USD' }]);
    queueResult([{ currencyCode: 'USD' }]); // partner
    queueResult([{ id: 'c1' }]); // current active connection
    queueResult([{ count: 3 }]); // nonterminal outbound ops on old active
    const res = await activateConnection('p1', 'c2');
    expect(res).toEqual({ ok: false, code: 'OLD_CONNECTION_HAS_WORK', operationCount: 3 });
  });
});

describe('softDisconnectConnection guards', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('blocks on a live lease or ambiguous operation regardless of confirmCancel', async () => {
    queueResult([]); // advisory lock
    queueResult([{ id: 'c1', partnerId: 'p1', status: 'connected' }]);
    queueResult([{ id: 'op-1' }, { id: 'op-2' }]); // live/ambiguous ops
    const res = await softDisconnectConnection('p1', 'c1', { confirmCancel: true, cancelReason: 'x' });
    expect(res).toEqual({ ok: false, code: 'LIVE_OR_AMBIGUOUS', operationIds: ['op-1', 'op-2'] });
  });

  it('requires explicit confirmation for other nonterminal work', async () => {
    queueResult([]); // advisory lock
    queueResult([{ id: 'c1', partnerId: 'p1', status: 'connected' }]);
    queueResult([]); // no live/ambiguous
    queueResult([{ status: 'pending', count: 2 }]); // nonterminal counts
    const res = await softDisconnectConnection('p1', 'c1', {});
    expect(res).toEqual({ ok: false, code: 'NONTERMINAL_WORK', counts: { pending: 2 } });
  });
});
```

Run: `pnpm --filter @breeze/api test src/services/accounting/accountingConnectionService.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 2: Implement**

Add to `accountingConnectionService.ts` (imports: `and, eq, inArray, isNull, sql` from `drizzle-orm`; `accountingSyncOperations, accountingSyncExceptions, partners` from `../../db/schema`; `db` is already imported/passed in this file — match its existing style of taking `db` as the first param OR importing; use the same style the file already uses):

```ts
export const NONTERMINAL_OUTBOUND_STATUSES = [
  'pending', 'queued', 'running', 'waiting_dependency', 'ambiguous', 'blocked', 'failed',
] as const;

export type ActivationResult =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_CONNECTED' | 'CURRENCY_MISMATCH' | 'OLD_CONNECTION_HAS_WORK' | 'VARIANCE_OPEN'; operationCount?: number };

/**
 * One-active-provider switch (spec §9.2). Runs in one transaction under the
 * per-connection coordination lock; no provider HTTP happens in here. The
 * partial unique index accounting_connections_one_active_uq backstops the
 * transition; the checks give the user actionable errors instead of 23505.
 */
export async function activateConnection(partnerId: string, connectionId: string): Promise<ActivationResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'acct-conn-' + connectionId}))`);

    const [candidate] = await tx.select().from(accountingConnections)
      .where(and(eq(accountingConnections.id, connectionId), eq(accountingConnections.partnerId, partnerId)))
      .limit(1);
    if (!candidate) return { ok: false as const, code: 'NOT_FOUND' as const };
    if (candidate.status !== 'connected' || !candidate.accessTokenEncrypted || !candidate.refreshTokenEncrypted) {
      return { ok: false as const, code: 'NOT_CONNECTED' as const };
    }

    const [partner] = await tx.select({ currencyCode: partners.currencyCode }).from(partners)
      .where(eq(partners.id, partnerId)).limit(1);
    if (!partner || (candidate.homeCurrency && candidate.homeCurrency !== partner.currencyCode)) {
      return { ok: false as const, code: 'CURRENCY_MISMATCH' as const };
    }

    const [oldActive] = await tx.select({ id: accountingConnections.id }).from(accountingConnections)
      .where(and(
        eq(accountingConnections.partnerId, partnerId),
        eq(accountingConnections.isActive, true),
      )).limit(1);

    if (oldActive && oldActive.id !== connectionId) {
      const [work] = await tx.select({ count: sql<number>`count(*)::int` }).from(accountingSyncOperations)
        .where(and(
          eq(accountingSyncOperations.connectionId, oldActive.id),
          eq(accountingSyncOperations.direction, 'outbound'),
          inArray(accountingSyncOperations.status, [...NONTERMINAL_OUTBOUND_STATUSES]),
        ));
      if (work && work.count > 0) {
        return { ok: false as const, code: 'OLD_CONNECTION_HAS_WORK' as const, operationCount: work.count };
      }
      const [variance] = await tx.select({ count: sql<number>`count(*)::int` }).from(accountingSyncExceptions)
        .where(and(
          eq(accountingSyncExceptions.connectionId, oldActive.id),
          eq(accountingSyncExceptions.category, 'tax_variance'),
          eq(accountingSyncExceptions.status, 'open'),
        ));
      if (variance && variance.count > 0) return { ok: false as const, code: 'VARIANCE_OPEN' as const };

      await tx.update(accountingConnections)
        .set({ isActive: false, deactivatedAt: new Date(), updatedAt: new Date() })
        .where(eq(accountingConnections.id, oldActive.id));
    }

    if (!oldActive || oldActive.id !== connectionId) {
      await tx.update(accountingConnections)
        .set({ isActive: true, activatedAt: new Date(), updatedAt: new Date() })
        .where(eq(accountingConnections.id, connectionId));
    }
    return { ok: true as const };
  });
}

export type DisconnectResult =
  | { ok: true; canceledCount: number }
  | { ok: false; code: 'NOT_FOUND' | 'LIVE_OR_AMBIGUOUS'; operationIds: string[] }
  | { ok: false; code: 'NONTERMINAL_WORK'; counts: Record<string, number> };

/**
 * Soft disconnect (spec §9.4, decision 9): revoke usability, keep provenance.
 * Never passes a live/ambiguous operation. Only conclusively non-ambiguous
 * operations may be canceled, and only with an explicit confirmation + reason.
 */
export async function softDisconnectConnection(
  partnerId: string,
  connectionId: string,
  opts: { confirmCancel?: boolean; cancelReason?: string; actorUserId?: string | null },
): Promise<DisconnectResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'acct-conn-' + connectionId}))`);

    const [conn] = await tx.select().from(accountingConnections)
      .where(and(eq(accountingConnections.id, connectionId), eq(accountingConnections.partnerId, partnerId)))
      .limit(1);
    if (!conn) return { ok: false as const, code: 'NOT_FOUND' as const, operationIds: [] };

    // Fail-closed: unexpired running lease or ambiguous write blocks disconnect.
    const live = await tx.select({ id: accountingSyncOperations.id }).from(accountingSyncOperations)
      .where(and(
        eq(accountingSyncOperations.connectionId, connectionId),
        sql`(${accountingSyncOperations.status} = 'ambiguous'
             OR (${accountingSyncOperations.status} = 'running' AND ${accountingSyncOperations.leaseExpiresAt} > now()))`,
      )).limit(50);
    if (live.length > 0) {
      return { ok: false as const, code: 'LIVE_OR_AMBIGUOUS' as const, operationIds: live.map((r) => r.id) };
    }

    const cancelable = ['pending', 'queued', 'waiting_dependency', 'blocked', 'failed'];
    if (!opts.confirmCancel || !opts.cancelReason) {
      const countRows = await tx.select({
        status: accountingSyncOperations.status,
        count: sql<number>`count(*)::int`,
      }).from(accountingSyncOperations)
        .where(and(
          eq(accountingSyncOperations.connectionId, connectionId),
          inArray(accountingSyncOperations.status, cancelable),
        ))
        .groupBy(accountingSyncOperations.status);
      if (countRows.length > 0) {
        const counts: Record<string, number> = {};
        for (const r of countRows) counts[r.status] = r.count;
        return { ok: false as const, code: 'NONTERMINAL_WORK' as const, counts };
      }
    }

    let canceledCount = 0;
    if (opts.confirmCancel && opts.cancelReason) {
      const canceled = await tx.update(accountingSyncOperations)
        .set({
          status: 'canceled',
          lastErrorCategory: 'configuration',
          lastErrorCode: 'canceled_on_disconnect',
          lastErrorMessage: opts.cancelReason.slice(0, 500),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(accountingSyncOperations.connectionId, connectionId),
          inArray(accountingSyncOperations.status, cancelable),
        ))
        .returning({ id: accountingSyncOperations.id });
      canceledCount = canceled.length;
    }

    await tx.update(accountingConnections)
      .set({
        status: 'disconnected',
        isActive: false,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        disconnectedAt: new Date(),
        deactivatedAt: conn.isActive ? new Date() : conn.deactivatedAt,
        updatedAt: new Date(),
      })
      .where(eq(accountingConnections.id, connectionId));
    // Provider-side token revocation is attempted by the Stage 2 route layer
    // (outside this transaction, outside any DB context) where supported.
    return { ok: true as const, canceledCount };
  });
}

/**
 * Application backfill (spec §8.1, §8.12 step 3): derive remote_tenant_key_hash
 * for rows that predate connection-instance identity. Corrupt ciphertext marks
 * the connection error — never guesses.
 */
export async function backfillTenantKeyHashes(): Promise<{ hashed: number; corrupt: number }> {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(accountingConnections)
      .where(and(isNull(accountingConnections.remoteTenantKeyHash), sql`realm_id_encrypted IS NOT NULL`));
    let hashed = 0; let corrupt = 0;
    for (const row of rows) {
      try {
        const rawTenantId = decryptSecret(row.realmIdEncrypted as string);
        const { hash, version } = computeRemoteTenantKeyHash(row.provider, rawTenantId);
        await db.update(accountingConnections)
          .set({ remoteTenantKeyHash: hash, remoteTenantKeyVersion: version, updatedAt: new Date() })
          .where(and(eq(accountingConnections.id, row.id), isNull(accountingConnections.remoteTenantKeyHash)));
        hashed++;
      } catch {
        await db.update(accountingConnections)
          .set({ status: 'error', lastError: 'tenant identity undecryptable during hash backfill', updatedAt: new Date() })
          .where(eq(accountingConnections.id, row.id));
        corrupt++;
      }
    }
    if (hashed + corrupt > 0) console.log(`[accounting] tenant-hash backfill: hashed=${hashed} corrupt=${corrupt}`);
    return { hashed, corrupt };
  });
}
```

Match the file's existing convention for `db` access (explicit first param vs module import) and its `decryptSecret` import; if `decryptSecret` is async in this repo, `await` it. Add the erasure-only comment on `deleteConnection`:

```ts
// ERASURE-ONLY (spec §8.13): ordinary APIs must never hard-delete a connection.
// Disconnect is softDisconnectConnection. This remains solely for the tested
// partner/tenant-erasure workflow.
```

- [ ] **Step 3: Switch the disconnect route**

In `apps/api/src/routes/accounting/index.ts`, find the handler that calls `deleteConnection` (`grep -n "deleteConnection" apps/api/src/routes/accounting/index.ts`). Replace the call with:

```ts
  const body = await c.req.json().catch(() => ({}));
  const result = await softDisconnectConnection(partner.partnerId, connectionId, {
    confirmCancel: body?.confirmCancel === true,
    cancelReason: typeof body?.cancelReason === 'string' ? body.cancelReason : undefined,
    actorUserId: c.get('auth')?.userId ?? null,
  });
  if (!result.ok && result.code === 'LIVE_OR_AMBIGUOUS') {
    return c.json({ error: 'Running or ambiguous accounting operations must resolve before disconnect', operationIds: result.operationIds }, 409);
  }
  if (!result.ok && result.code === 'NONTERMINAL_WORK') {
    return c.json({ error: 'Unfinished accounting operations exist; retry with confirmCancel and a cancelReason to cancel them', counts: result.counts }, 409);
  }
  if (!result.ok) return c.json({ error: 'Connection not found' }, 404);
```

The legacy route identifies the connection by `(partnerId, provider)`, not id — resolve the connection first via the existing `getConnection(db, partnerId, provider)` and pass its `id`. Keep the route's existing audit write (`writeRouteAudit`) after success.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm --filter @breeze/api test src/services/accounting
pnpm --filter @breeze/api test src/routes/accounting
cd apps/api && npx tsc --noEmit
```
Expected: new unit tests PASS; any existing disconnect route test expecting hard-delete must be updated to expect soft-disconnect semantics (row retained, `status='disconnected'`, tokens nulled).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/accountingConnectionService.ts apps/api/src/services/accounting/accountingConnectionService.test.ts apps/api/src/routes/accounting/index.ts
git commit -m "feat(accounting): activation transaction, soft disconnect, tenant-hash backfill (P0-1 Stage 1)"
```

---

### Task 13: Outbox core service — create, coalesce, idempotency key, payload hash

**Files:**
- Create: `apps/api/src/services/accounting/accountingOutbox.ts`
- Test: `apps/api/src/services/accounting/accountingOutbox.test.ts`

**Interfaces:**
- Consumes: `accountingSyncOperations` (Task 5); `AccountingSyncDirection`, `AccountingSyncEntityType` from `@breeze/shared` (Task 1).
- Produces (used by Task 14 tests and by Stage 3's invoiceService wiring):
  - `deriveIdempotencyKey(input: IdempotencyKeyInput): string` — `` `${connectionId}-${entityType}-${operation}-${localEntityId}-v${localVersion}` ``
  - `canonicalJson(value: unknown): string` (recursive key-sorted stringify)
  - `payloadSha256(payload: unknown): string` (64-char hex)
  - `createSyncOperation(dbc: typeof db, input: CreateSyncOperationInput): Promise<{ operation: SyncOperationRow; created: boolean }>` — callable with a transaction handle so Stage 3 can insert in the SAME financial transaction; replays (same key) return the existing row with `created: false`; older unstarted versions of the same logical target are coalesced to `canceled`.
  - `type SyncOperationRow = typeof accountingSyncOperations.$inferSelect`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/accounting/accountingOutbox.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'execute', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  return { db: makeChain(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});

import { db } from '../../db';
import { canonicalJson, payloadSha256, deriveIdempotencyKey, createSyncOperation } from './accountingOutbox';

describe('accountingOutbox primitives', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe(canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
  });

  it('payloadSha256 is 64-char hex and deterministic', () => {
    const h = payloadSha256({ x: 1, y: 'z' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadSha256({ y: 'z', x: 1 })).toBe(h);
  });

  it('idempotency key: connection + entity + operation + local entity + version', () => {
    expect(deriveIdempotencyKey({
      connectionId: 'conn1', entityType: 'invoice', operation: 'invoice_post',
      invoiceId: 'inv1', localVersion: 2,
    })).toBe('conn1-invoice-invoice_post-inv1-v2');
    // payment operations key on the payment id (most specific local entity)
    expect(deriveIdempotencyKey({
      connectionId: 'conn1', entityType: 'payment', operation: 'payment_post',
      invoicePaymentId: 'pay1', invoiceId: 'inv1', localVersion: 1,
    })).toBe('conn1-payment-payment_post-pay1-v1');
  });

  it('createSyncOperation returns created:true on first insert', async () => {
    queueResult([]);                       // coalesce UPDATE
    queueResult([{ id: 'op1', status: 'pending' }]); // INSERT ... returning
    const res = await createSyncOperation(db, {
      connectionId: 'conn1', partnerId: 'p1', direction: 'outbound',
      entityType: 'invoice', operation: 'invoice_post', invoiceId: 'inv1',
      localVersion: 1, payload: { total: '10.00' },
    });
    expect(res.created).toBe(true);
    expect(res.operation.id).toBe('op1');
  });

  it('createSyncOperation replay returns the existing row with created:false', async () => {
    queueResult([]);                       // coalesce UPDATE
    queueResult([]);                       // INSERT conflict → no rows
    queueResult([{ id: 'op1', status: 'queued' }]); // reselect by key
    const res = await createSyncOperation(db, {
      connectionId: 'conn1', partnerId: 'p1', direction: 'outbound',
      entityType: 'invoice', operation: 'invoice_post', invoiceId: 'inv1',
      localVersion: 1, payload: { total: '10.00' },
    });
    expect(res.created).toBe(false);
    expect(res.operation.id).toBe('op1');
  });
});
```

Run: `pnpm --filter @breeze/api test src/services/accounting/accountingOutbox.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 2: Implement**

```ts
// apps/api/src/services/accounting/accountingOutbox.ts
import { createHash } from 'crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { db as dbType } from '../../db';
import { accountingSyncOperations } from '../../db/schema';
import type { AccountingSyncDirection, AccountingSyncEntityType } from '@breeze/shared';

export type SyncOperationRow = typeof accountingSyncOperations.$inferSelect;

export interface IdempotencyKeyInput {
  connectionId: string;
  entityType: AccountingSyncEntityType;
  operation: string;
  localVersion: number;
  organizationId?: string;
  catalogItemId?: string;
  invoiceId?: string;
  invoicePaymentId?: string;
}

export interface CreateSyncOperationInput extends IdempotencyKeyInput {
  partnerId: string;
  direction: AccountingSyncDirection;
  payload: Record<string, unknown>;
  status?: 'pending' | 'blocked' | 'waiting_dependency';
  blockedReason?: string;
  dependsOnOperationId?: string;
  createdBy?: string | null;
}

/** Most-specific local entity wins; reconcile operations have none. */
function localEntityId(input: IdempotencyKeyInput): string {
  return input.invoicePaymentId ?? input.invoiceId ?? input.catalogItemId ?? input.organizationId ?? 'none';
}

export function deriveIdempotencyKey(input: IdempotencyKeyInput): string {
  return `${input.connectionId}-${input.entityType}-${input.operation}-${localEntityId(input)}-v${input.localVersion}`;
}

/** Deterministic stringify: object keys sorted recursively so the payload
 * hash is stable across serializations. Arrays keep order (order is data). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function payloadSha256(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Transactional outbox insert (spec §8.6, §11.1). Call with the SAME
 * transaction handle as the financial mutation. A technical replay (same
 * idempotency key) returns the existing row; a new business version first
 * coalesces older UNSTARTED versions of the same logical target to canceled.
 * Immutable payloads: this function never updates an existing row's payload.
 */
export async function createSyncOperation(
  dbc: typeof dbType,
  input: CreateSyncOperationInput,
): Promise<{ operation: SyncOperationRow; created: boolean }> {
  const idempotencyKey = deriveIdempotencyKey(input);

  const entityCond =
    input.invoicePaymentId ? eq(accountingSyncOperations.invoicePaymentId, input.invoicePaymentId)
    : input.invoiceId ? eq(accountingSyncOperations.invoiceId, input.invoiceId)
    : input.catalogItemId ? eq(accountingSyncOperations.catalogItemId, input.catalogItemId)
    : input.organizationId ? eq(accountingSyncOperations.organizationId, input.organizationId)
    : sql`TRUE`;

  // Coalesce: an older, not-yet-started version of the same logical operation
  // is superseded — cancel it rather than let two versions race (spec §11.1).
  await dbc.update(accountingSyncOperations)
    .set({ status: 'canceled', completedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(accountingSyncOperations.connectionId, input.connectionId),
      eq(accountingSyncOperations.entityType, input.entityType),
      eq(accountingSyncOperations.operation, input.operation),
      entityCond,
      lt(accountingSyncOperations.localVersion, input.localVersion),
      inArray(accountingSyncOperations.status, ['pending', 'waiting_dependency']),
    ));

  const inserted = await dbc.insert(accountingSyncOperations)
    .values({
      connectionId: input.connectionId,
      partnerId: input.partnerId,
      direction: input.direction,
      entityType: input.entityType,
      organizationId: input.organizationId,
      catalogItemId: input.catalogItemId,
      invoiceId: input.invoiceId,
      invoicePaymentId: input.invoicePaymentId,
      operation: input.operation,
      localVersion: input.localVersion,
      idempotencyKey,
      status: input.status ?? 'pending',
      payload: input.payload,
      payloadSha256: payloadSha256(input.payload),
      dependsOnOperationId: input.dependsOnOperationId,
      lastErrorMessage: input.status === 'blocked' ? (input.blockedReason ?? null) : null,
      lastErrorCategory: input.status === 'blocked' ? 'configuration' : null,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing({ target: accountingSyncOperations.idempotencyKey })
    .returning();

  if (inserted.length > 0) return { operation: inserted[0], created: true };

  const [existing] = await dbc.select().from(accountingSyncOperations)
    .where(eq(accountingSyncOperations.idempotencyKey, idempotencyKey)).limit(1);
  return { operation: existing, created: false };
}
```

- [ ] **Step 3: Run tests + typecheck**

Run: `pnpm --filter @breeze/api test src/services/accounting/accountingOutbox.test.ts && cd apps/api && npx tsc --noEmit`
Expected: PASS (5 tests), clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/accounting/accountingOutbox.ts apps/api/src/services/accounting/accountingOutbox.test.ts
git commit -m "feat(accounting): outbox create/coalesce with canonical payload hashing (P0-1 Stage 1)"
```

---

### Task 14: Relay, fenced-lease worker, repair sweep

This is Stage 1's highest-risk net-new component (no repo precedent — closest prior art is advisory-lock job dedup). Its crash/replay/fencing tests land in this same task, not later.

**Files:**
- Create: `apps/api/src/jobs/accountingSyncWorker.ts`
- Test: `apps/api/src/jobs/accountingSyncWorker.test.ts` (unit: retry schedule)
- Create: `apps/api/src/__tests__/integration/accountingOutboxWorker.integration.test.ts`
- Modify: `apps/api/src/config/env.ts` (`ACCOUNTING_SYNC_ENABLED`)
- Modify: `apps/api/src/index.ts` (worker registration)

**Interfaces:**
- Consumes: Task 5/6 tables; `getBullMQConnection` from `../services/redis`; `captureException` from `../services/sentry`; `withSystemDbAccessContext` from `../db`.
- Produces:
  - `registerOperationHandler(operation: string, handler: OperationHandler)` / `clearOperationHandlers()` — Stage 3 registers `invoice_post` etc.; Stage 1 registers none.
  - `type OperationHandler = (op: SyncOperationRow, ctx: { heartbeat: () => Promise<void> }) => Promise<OperationOutcome>`
  - `type OperationOutcome = { outcome: 'succeeded' | 'succeeded_with_variance'; remoteId?: string; remoteVersion?: string; responseSummary?: string } | { outcome: 'failed' | 'blocked'; errorCategory: AccountingErrorCategory; errorCode?: string; errorMessage?: string } | { outcome: 'ambiguous'; errorCode?: string; errorMessage?: string }`
  - `relayPendingOperations(enqueue?: (opId: string) => Promise<void>, limit?: number): Promise<number>`
  - `claimOperation(operationId: string, workerId: string): Promise<SyncOperationRow | null>`
  - `heartbeatLease(operationId: string, leaseToken: string): Promise<void>`
  - `completeOperationFenced(operationId: string, leaseToken: string, patch: Record<string, unknown>): Promise<boolean>`
  - `processOperationJob(operationId: string, workerId?: string): Promise<string>`
  - `repairSweep(): Promise<{ requeued: number; ambiguous: number }>`
  - `nextRetryDelaySeconds(attemptCount: number): number | null` — `[30, 120, 600, 3600, 21600]`, `null` after 5
  - `initializeAccountingSyncWorkers()` / `shutdownAccountingSyncWorkers()`

- [ ] **Step 1: Write the failing unit test (retry schedule)**

```ts
// apps/api/src/jobs/accountingSyncWorker.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('bullmq', () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn() }));

import { nextRetryDelaySeconds } from './accountingSyncWorker';

describe('transient retry schedule (spec §13.2: 30s, 2m, 10m, 1h, 6h, then failed)', () => {
  it('follows the fixed schedule and exhausts after the fifth attempt', () => {
    expect(nextRetryDelaySeconds(1)).toBe(30);
    expect(nextRetryDelaySeconds(2)).toBe(120);
    expect(nextRetryDelaySeconds(3)).toBe(600);
    expect(nextRetryDelaySeconds(4)).toBe(3600);
    expect(nextRetryDelaySeconds(5)).toBe(null);
  });
});
```

Run: `pnpm --filter @breeze/api test src/jobs/accountingSyncWorker.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 2: Implement the worker module**

Add to `apps/api/src/config/env.ts`:

```ts
export const ACCOUNTING_SYNC_ENABLED = process.env.ACCOUNTING_SYNC_ENABLED === 'true';
```

```ts
// apps/api/src/jobs/accountingSyncWorker.ts
// PSA P0-1 Stage 1 (spec §7.1, §13): outbox relay + fenced-lease worker +
// repair sweep. The accounting_sync_operations row is the source of truth;
// BullMQ is delivery machinery only (attempts: 1 — retries are DB-scheduled
// via next_attempt_at, never BullMQ backoff). jobIds use hyphens, never colons.
import os from 'os';
import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { accountingSyncOperations, accountingSyncAttempts, accountingSyncExceptions } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { ACCOUNTING_SYNC_ENABLED } from '../config/env';
import type { SyncOperationRow } from '../services/accounting/accountingOutbox';
import type { AccountingErrorCategory } from '@breeze/shared';

const ACCOUNTING_SYNC_QUEUE = 'accounting-sync';
const LEASE_SECONDS = 60;
const STALE_QUEUED_SECONDS = 300;
const RETRY_SCHEDULE_SECONDS = [30, 120, 600, 3600, 21600] as const;

export type OperationOutcome =
  | { outcome: 'succeeded' | 'succeeded_with_variance'; remoteId?: string; remoteVersion?: string; responseSummary?: string }
  | { outcome: 'failed' | 'blocked'; errorCategory: AccountingErrorCategory; errorCode?: string; errorMessage?: string }
  | { outcome: 'ambiguous'; errorCode?: string; errorMessage?: string };

export type OperationHandler = (
  op: SyncOperationRow,
  ctx: { heartbeat: () => Promise<void> },
) => Promise<OperationOutcome>;

const operationHandlers = new Map<string, OperationHandler>();
export function registerOperationHandler(operation: string, handler: OperationHandler): void {
  operationHandlers.set(operation, handler);
}
export function clearOperationHandlers(): void {
  operationHandlers.clear();
}

/** Transient schedule (spec §13.2). attemptCount is the attempt that just
 * failed (1-based). Returns null when retries are exhausted → status failed. */
export function nextRetryDelaySeconds(attemptCount: number): number | null {
  return attemptCount < RETRY_SCHEDULE_SECONDS.length ? RETRY_SCHEDULE_SECONDS[attemptCount] : null;
}

let accountingSyncQueue: Queue | null = null;
export function getAccountingSyncQueue(): Queue {
  if (!accountingSyncQueue) {
    accountingSyncQueue = new Queue(ACCOUNTING_SYNC_QUEUE, { connection: getBullMQConnection() });
  }
  return accountingSyncQueue;
}

export async function enqueueOperationJob(operationId: string): Promise<void> {
  await getAccountingSyncQueue().add('process-operation', { operationId }, {
    jobId: `acct-op-${operationId}`,
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 },
    attempts: 1,
  });
}

/** Claim committed pending operations (short transaction, SKIP LOCKED) and
 * hand them to BullMQ. Queue-add failure reverts the row — Redis is never the
 * only record of work (spec §7.1). */
export async function relayPendingOperations(
  enqueue: (opId: string) => Promise<void> = enqueueOperationJob,
  limit = 25,
): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const claimed = await db.execute(sql`
      UPDATE accounting_sync_operations
      SET status = 'queued', queued_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM accounting_sync_operations
        WHERE status = 'pending' AND next_attempt_at <= now() AND available_at <= now()
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `);
    const ids = Array.from(claimed as unknown as Iterable<{ id: string }>, (r) => r.id);
    let queued = 0;
    for (const id of ids) {
      try {
        await enqueue(id);
        queued++;
      } catch (err) {
        await db.update(accountingSyncOperations)
          .set({ status: 'pending', queuedAt: null, updatedAt: new Date() })
          .where(and(eq(accountingSyncOperations.id, id), eq(accountingSyncOperations.status, 'queued')));
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return queued;
  });
}

/** Fenced claim: queued → running with a fresh lease token. Returns null when
 * another worker already owns the operation. */
export async function claimOperation(operationId: string, workerId: string): Promise<SyncOperationRow | null> {
  const [row] = await db.update(accountingSyncOperations)
    .set({
      status: 'running',
      leaseToken: sql`gen_random_uuid()`,
      leaseOwner: workerId,
      leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
      startedAt: sql`COALESCE(started_at, now())`,
      attemptCount: sql`attempt_count + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(accountingSyncOperations.id, operationId), eq(accountingSyncOperations.status, 'queued')))
    .returning();
  return row ?? null;
}

export async function heartbeatLease(operationId: string, leaseToken: string): Promise<void> {
  await db.update(accountingSyncOperations)
    .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_SECONDS})`, updatedAt: new Date() })
    .where(and(
      eq(accountingSyncOperations.id, operationId),
      eq(accountingSyncOperations.status, 'running'),
      eq(accountingSyncOperations.leaseToken, leaseToken),
    ));
}

/** Fenced terminal/retry update: only the lease owner's write lands. A stale
 * worker's completion affects zero rows (spec §7.1 step 5). */
export async function completeOperationFenced(
  operationId: string,
  leaseToken: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const rows = await db.update(accountingSyncOperations)
    .set({ ...patch, leaseToken: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(
      eq(accountingSyncOperations.id, operationId),
      eq(accountingSyncOperations.status, 'running'),
      eq(accountingSyncOperations.leaseToken, leaseToken),
    ))
    .returning({ id: accountingSyncOperations.id });
  return rows.length > 0;
}

async function startAttempt(op: SyncOperationRow): Promise<string> {
  const [attempt] = await db.insert(accountingSyncAttempts).values({
    operationId: op.id,
    connectionId: op.connectionId,
    partnerId: op.partnerId,
    attemptNumber: op.attemptCount,
  }).returning({ id: accountingSyncAttempts.id });
  return attempt.id;
}

async function finishAttempt(attemptId: string, fields: Record<string, unknown>): Promise<void> {
  // Attempts are append-only evidence: outcome is written once, never flipped.
  await db.update(accountingSyncAttempts)
    .set({ ...fields, completedAt: new Date() })
    .where(and(eq(accountingSyncAttempts.id, attemptId), isNull(accountingSyncAttempts.outcome)));
}

async function openAmbiguousException(op: SyncOperationRow, message: string): Promise<void> {
  // Deduped by the partial unique (operation_id, category) WHERE status='open'.
  await db.insert(accountingSyncExceptions).values({
    connectionId: op.connectionId,
    partnerId: op.partnerId,
    operationId: op.id,
    category: 'ambiguous_write',
    entityType: op.entityType,
    organizationId: op.organizationId,
    catalogItemId: op.catalogItemId,
    invoiceId: op.invoiceId,
    invoicePaymentId: op.invoicePaymentId,
    summary: message.slice(0, 300),
    status: 'open',
  }).onConflictDoNothing();
}

export async function processOperationJob(
  operationId: string,
  workerId = `${os.hostname()}-${process.pid}`,
): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const op = await claimOperation(operationId, workerId);
    if (!op) return 'not_claimed';
    const leaseToken = op.leaseToken as string;

    const handler = operationHandlers.get(op.operation);
    if (!handler) {
      // Visible, not silent (spec §11.1): no registered handler = blocked.
      await completeOperationFenced(op.id, leaseToken, {
        status: 'blocked',
        lastErrorCategory: 'configuration',
        lastErrorCode: 'handler_not_registered',
        lastErrorMessage: `No handler registered for operation '${op.operation}'`,
      });
      return 'blocked';
    }

    const attemptId = await startAttempt(op);
    try {
      const result = await handler(op, { heartbeat: () => heartbeatLease(op.id, leaseToken) });
      return await applyOutcome(op, leaseToken, attemptId, result);
    } catch (err) {
      // Handler threw without classifying. Conservative rule (spec §8.7):
      // if this attempt was marked sent with no conclusive response, ambiguous;
      // otherwise transient-retry semantics.
      const [attempt] = await db.select().from(accountingSyncAttempts)
        .where(eq(accountingSyncAttempts.id, attemptId)).limit(1);
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (attempt?.sendStartedAt && !attempt.responseReceivedAt) {
        return await applyOutcome(op, leaseToken, attemptId, { outcome: 'ambiguous', errorMessage: message });
      }
      return await applyOutcome(op, leaseToken, attemptId, {
        outcome: 'failed', errorCategory: 'transient', errorMessage: message,
      });
    }
  });
}

async function applyOutcome(
  op: SyncOperationRow,
  leaseToken: string,
  attemptId: string,
  result: OperationOutcome,
): Promise<string> {
  if (result.outcome === 'succeeded' || result.outcome === 'succeeded_with_variance') {
    await finishAttempt(attemptId, {
      outcome: result.outcome, remoteId: result.remoteId, remoteVersion: result.remoteVersion,
      responseSummary: result.responseSummary?.slice(0, 1000),
    });
    await completeOperationFenced(op.id, leaseToken, {
      status: result.outcome, completedAt: new Date(),
      lastErrorCategory: null, lastErrorCode: null, lastErrorMessage: null,
    });
    return result.outcome;
  }

  if (result.outcome === 'ambiguous') {
    await finishAttempt(attemptId, {
      outcome: 'ambiguous', errorCategory: 'ambiguous_write',
      errorCode: result.errorCode, errorMessage: result.errorMessage?.slice(0, 500),
    });
    await completeOperationFenced(op.id, leaseToken, {
      status: 'ambiguous',
      lastErrorCategory: 'ambiguous_write',
      lastErrorCode: result.errorCode ?? null,
      lastErrorMessage: result.errorMessage?.slice(0, 500) ?? null,
    });
    await openAmbiguousException(op, result.errorMessage ?? 'Provider write outcome unknown');
    return 'ambiguous';
  }

  // failed | blocked
  await finishAttempt(attemptId, {
    outcome: result.outcome, errorCategory: result.errorCategory,
    errorCode: result.errorCode, errorMessage: result.errorMessage?.slice(0, 500),
  });
  const errorPatch = {
    lastErrorCategory: result.errorCategory,
    lastErrorCode: result.errorCode ?? null,
    lastErrorMessage: result.errorMessage?.slice(0, 500) ?? null,
  };
  if (result.outcome === 'failed' && result.errorCategory === 'transient') {
    const delay = nextRetryDelaySeconds(op.attemptCount);
    if (delay !== null) {
      await completeOperationFenced(op.id, leaseToken, {
        ...errorPatch, status: 'pending',
        nextAttemptAt: sql`now() + make_interval(secs => ${delay})`,
      });
      return 'retry_scheduled';
    }
  }
  await completeOperationFenced(op.id, leaseToken, { ...errorPatch, status: result.outcome });
  return result.outcome;
}

/** Repair (spec §7.1): stale queued rows return to pending; expired running
 * leases reset to pending ONLY when the persisted attempt proves no provider
 * send started — otherwise they become ambiguous for read-after-write recovery.
 * The idempotency key and payload are never touched. */
export async function repairSweep(): Promise<{ requeued: number; ambiguous: number }> {
  return withSystemDbAccessContext(async () => {
    let requeued = 0;
    let ambiguous = 0;

    const staleQueued = await db.execute(sql`
      UPDATE accounting_sync_operations
      SET status = 'pending', queued_at = NULL, updated_at = now()
      WHERE status = 'queued' AND queued_at < now() - make_interval(secs => ${STALE_QUEUED_SECONDS})
      RETURNING id
    `);
    requeued += Array.from(staleQueued as unknown as Iterable<{ id: string }>).length;

    const expired = await db.select().from(accountingSyncOperations)
      .where(and(
        eq(accountingSyncOperations.status, 'running'),
        sql`${accountingSyncOperations.leaseExpiresAt} < now()`,
      ))
      .limit(100);

    for (const op of expired) {
      const [attempt] = await db.select().from(accountingSyncAttempts)
        .where(and(
          eq(accountingSyncAttempts.operationId, op.id),
          eq(accountingSyncAttempts.attemptNumber, op.attemptCount),
        )).limit(1);
      const sendMayHaveHappened = Boolean(attempt?.sendStartedAt) && !attempt?.responseReceivedAt;
      if (sendMayHaveHappened) {
        const rows = await db.update(accountingSyncOperations)
          .set({
            status: 'ambiguous', leaseToken: null, leaseOwner: null, leaseExpiresAt: null,
            lastErrorCategory: 'ambiguous_write', lastErrorCode: 'lease_expired_after_send',
            lastErrorMessage: 'Worker lease expired after the provider send started; outcome unknown',
            updatedAt: new Date(),
          })
          .where(and(
            eq(accountingSyncOperations.id, op.id),
            eq(accountingSyncOperations.status, 'running'),
            sql`${accountingSyncOperations.leaseExpiresAt} < now()`,
          ))
          .returning({ id: accountingSyncOperations.id });
        if (rows.length > 0) {
          ambiguous++;
          await openAmbiguousException(op, 'Worker lease expired after provider send started');
        }
      } else {
        const rows = await db.update(accountingSyncOperations)
          .set({
            status: 'pending', leaseToken: null, leaseOwner: null, leaseExpiresAt: null,
            queuedAt: null, updatedAt: new Date(),
          })
          .where(and(
            eq(accountingSyncOperations.id, op.id),
            eq(accountingSyncOperations.status, 'running'),
            sql`${accountingSyncOperations.leaseExpiresAt} < now()`,
          ))
          .returning({ id: accountingSyncOperations.id });
        if (rows.length > 0) requeued++;
      }
    }
    return { requeued, ambiguous };
  });
}

let accountingSyncWorker: Worker | null = null;

export async function initializeAccountingSyncWorkers(): Promise<void> {
  if (!ACCOUNTING_SYNC_ENABLED) {
    console.log('[accounting] sync worker disabled (ACCOUNTING_SYNC_ENABLED != true)');
    return;
  }
  accountingSyncWorker = new Worker(
    ACCOUNTING_SYNC_QUEUE,
    async (job: Job) => {
      if (job.name === 'process-operation') return processOperationJob(job.data.operationId);
      if (job.name === 'relay-sweep') return relayPendingOperations();
      if (job.name === 'repair-sweep') return repairSweep();
      throw new Error(`Unknown accounting job: ${job.name}`);
    },
    { connection: getBullMQConnection(), concurrency: 5 },
  );
  accountingSyncWorker.on('error', (err) => captureException(err));
  accountingSyncWorker.on('failed', (_job, err) => captureException(err));
  await getAccountingSyncQueue().add('relay-sweep', {}, {
    jobId: 'acct-relay-repeat', repeat: { every: 10_000 }, removeOnComplete: { count: 10 }, removeOnFail: { count: 10 },
  });
  await getAccountingSyncQueue().add('repair-sweep', {}, {
    jobId: 'acct-repair-repeat', repeat: { every: 60_000 }, removeOnComplete: { count: 10 }, removeOnFail: { count: 10 },
  });
}

export async function shutdownAccountingSyncWorkers(): Promise<void> {
  await accountingSyncWorker?.close();
  await accountingSyncQueue?.close();
  accountingSyncWorker = null;
  accountingSyncQueue = null;
}
```

Register in `apps/api/src/index.ts`: add `['accountingSyncWorker', initializeAccountingSyncWorkers],` to the `workers` array (next to `['invoiceWorker', initializeInvoiceWorkers],`), with the import; add `shutdownAccountingSyncWorkers()` wherever the other shutdown functions are called (`grep -n "shutdownInvoiceWorkers" apps/api/src/index.ts` and mirror).

If `db.execute` results are not directly iterable in this repo (postgres.js returns an array-like), mirror the row-access pattern used in `tenantCascade.ts`'s `extractRowCount`.

- [ ] **Step 3: Run the unit test**

Run: `pnpm --filter @breeze/api test src/jobs/accountingSyncWorker.test.ts` — Expected: PASS.

- [ ] **Step 4: Write the integration crash/replay/fencing suite**

```ts
// apps/api/src/__tests__/integration/accountingOutboxWorker.integration.test.ts
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { accountingConnections, accountingSyncOperations, accountingSyncAttempts, accountingSyncExceptions } from '../../db/schema';
import { createSyncOperation } from '../../services/accounting/accountingOutbox';
import {
  claimOperation, clearOperationHandlers, completeOperationFenced, processOperationJob,
  registerOperationHandler, relayPendingOperations, repairSweep,
} from '../../jobs/accountingSyncWorker';
import { createOrganization, createPartner } from './db-utils';

afterEach(() => clearOperationHandlers());

async function seedOp(status = 'pending') {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return withSystemDbAccessContext(async () => {
    const [conn] = await db.insert(accountingConnections).values({
      partnerId: partner.id, provider: 'quickbooks', status: 'pending_setup',
    }).returning();
    const { operation } = await createSyncOperation(db, {
      connectionId: conn.id, partnerId: partner.id, direction: 'outbound',
      entityType: 'customer', operation: 'customer_upsert', organizationId: org.id,
      localVersion: 1, payload: { name: 'Acme' },
    });
    if (status !== 'pending') {
      await db.update(accountingSyncOperations).set({ status }).where(eq(accountingSyncOperations.id, operation.id));
    }
    return { partner, org, conn, op: operation };
  });
}

describe('accounting outbox relay + fenced worker (real DB)', () => {
  it('Redis-outage semantics: enqueue failure reverts the claim; a later relay retries it', async () => {
    const { op } = await seedOp();
    const failing = async () => { throw new Error('redis down'); };
    expect(await relayPendingOperations(failing)).toBe(0);
    const [afterFail] = await withSystemDbAccessContext(() =>
      db.select().from(accountingSyncOperations).where(eq(accountingSyncOperations.id, op.id)));
    expect(afterFail.status).toBe('pending'); // DB row is the record, not Redis

    const seen: string[] = [];
    expect(await relayPendingOperations(async (id) => { seen.push(id); })).toBe(1);
    expect(seen).toEqual([op.id]);
    const [afterOk] = await withSystemDbAccessContext(() =>
      db.select().from(accountingSyncOperations).where(eq(accountingSyncOperations.id, op.id)));
    expect(afterOk.status).toBe('queued');
  });

  it('two workers cannot both claim one operation; stale fenced completion writes nothing', async () => {
    const { op } = await seedOp('queued');
    const first = await withSystemDbAccessContext(() => claimOperation(op.id, 'worker-a'));
    expect(first).not.toBeNull();
    const second = await withSystemDbAccessContext(() => claimOperation(op.id, 'worker-b'));
    expect(second).toBeNull();

    // A stale/forged token cannot overwrite the owner's operation.
    const stale = await withSystemDbAccessContext(() =>
      completeOperationFenced(op.id, '00000000-0000-0000-0000-000000000000', { status: 'succeeded', completedAt: new Date() }));
    expect(stale).toBe(false);
    const ok = await withSystemDbAccessContext(() =>
      completeOperationFenced(op.id, first!.leaseToken as string, { status: 'succeeded', completedAt: new Date() }));
    expect(ok).toBe(true);
  });

  it('worker with no registered handler blocks the operation visibly', async () => {
    const { op } = await seedOp('queued');
    expect(await processOperationJob(op.id, 'worker-t')).toBe('blocked');
    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(accountingSyncOperations).where(eq(accountingSyncOperations.id, op.id)));
    expect(row.status).toBe('blocked');
    expect(row.lastErrorCode).toBe('handler_not_registered');
  });

  it('handler success path persists the attempt and the fenced terminal state', async () => {
    const { op } = await seedOp('queued');
    registerOperationHandler('customer_upsert', async () => ({ outcome: 'succeeded', remoteId: 'QB-9' }));
    expect(await processOperationJob(op.id, 'worker-t')).toBe('succeeded');
    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(accountingSyncOperations).where(eq(accountingSyncOperations.id, op.id)));
    expect(row.status).toBe('succeeded');
    expect(row.leaseToken).toBeNull();
    const attempts = await withSystemDbAccessContext(() =>
      db.select().from(accountingSyncAttempts).where(eq(accountingSyncAttempts.operationId, op.id)));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe('succeeded');
    expect(attempts[0].remoteId).toBe('QB-9');
  });

  it('repair: expired lease WITHOUT send evidence returns to pending with the same idempotency key', async () => {
    const { op } = await seedOp('queued');
    const claimed = await withSystemDbAccessContext(() => claimOperation(op.id, 'worker-crash'));
    await withSystemDbAccessContext(() => db.insert(accountingSyncAttempts).values({
      operationId: op.id, connectionId: claimed!.connectionId, partnerId: claimed!.partnerId,
      attemptNumber: claimed!.attemptCount, // crashed BEFORE send_started_at was written
    }));
    await withSystemDbAccessContext(() => db.update(accountingSyncOperations)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(accountingSyncOperations.id, op.id)));

    const result = await repairSweep();
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(accountingSyncOperations).where(eq(accountingSyncOperations.id, op.id)));
    expect(row.status).toBe('pending');
    expect(row.idempotencyKey).toBe(op.idempotencyKey); // identity preserved
    expect(row.leaseToken).toBeNull();
  });

  it('repair: expired lease WITH send evidence becomes ambiguous + one deduped exception', async () => {
    const { op } = await seedOp('queued');
    const claimed = await withSystemDbAccessContext(() => claimOperation(op.id, 'worker-crash'));
    await withSystemDbAccessContext(() => db.insert(accountingSyncAttempts).values({
      operationId: op.id, connectionId: claimed!.connectionId, partnerId: claimed!.partnerId,
      attemptNumber: claimed!.attemptCount, sendStartedAt: new Date(), // crashed mid-flight
    }));
    await withSystemDbAccessContext(() => db.update(accountingSyncOperations)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(accountingSyncOperations.id, op.id)));

    const result = await repairSweep();
    expect(result.ambiguous).toBeGreaterThanOrEqual(1);
    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(accountingSyncOperations).where(eq(accountingSyncOperations.id, op.id)));
    expect(row.status).toBe('ambiguous');

    // Second sweep creates no duplicate exception (partial unique dedup).
    await repairSweep();
    const exceptions = await withSystemDbAccessContext(() =>
      db.select().from(accountingSyncExceptions).where(eq(accountingSyncExceptions.operationId, op.id)));
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].category).toBe('ambiguous_write');
  });

  it('replay of the same business operation creates no second row', async () => {
    const { conn, op, partner, org } = await seedOp();
    const replay = await withSystemDbAccessContext(() => createSyncOperation(db, {
      connectionId: conn.id, partnerId: partner.id, direction: 'outbound',
      entityType: 'customer', operation: 'customer_upsert', organizationId: org.id,
      localVersion: 1, payload: { name: 'Acme' },
    }));
    expect(replay.created).toBe(false);
    expect(replay.operation.id).toBe(op.id);
  });
});
```

- [ ] **Step 5: Run the integration suite**

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/accountingOutboxWorker.integration.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit && cd ../..
git add apps/api/src/jobs/accountingSyncWorker.ts apps/api/src/jobs/accountingSyncWorker.test.ts apps/api/src/__tests__/integration/accountingOutboxWorker.integration.test.ts apps/api/src/config/env.ts apps/api/src/index.ts
git commit -m "feat(accounting): outbox relay + fenced-lease worker + repair sweep (P0-1 Stage 1)"
```

---

### Task 15: Legacy QBO organization-link backfill

**Files:**
- Create: `apps/api/src/services/accounting/legacyLinkBackfill.ts`
- Create: `apps/api/src/__tests__/integration/accountingLegacyBackfill.integration.test.ts`
- Modify: `apps/api/src/index.ts` (boot registration)

**Interfaces:**
- Consumes: `organizations.accountingProvider/accountingExternalId`; Task 4 mappings; Task 6 exceptions; Task 12 `backfillTenantKeyHashes`.
- Produces: `runLegacyAccountingLinkBackfill(): Promise<LegacyBackfillResult>` with `LegacyBackfillResult = { orgsExamined: number; mappingsCreated: number; stubsCreated: number; conflicts: number; alreadyMapped: number }`. Idempotent — safe on every boot. New mappings start `legacy_unverified` (no realm provenance in the old columns; a numeric ID match alone is not enough across realms — spec §8.11). Legacy org columns keep being read/written by the shipped import until Stage 2's dual-write; this backfill only ADDS the authoritative mapping rows.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/src/__tests__/integration/accountingLegacyBackfill.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { accountingConnections, accountingEntityMappings, accountingSyncExceptions, organizations } from '../../db/schema';
import { runLegacyAccountingLinkBackfill } from '../../services/accounting/legacyLinkBackfill';
import { createOrganization, createPartner } from './db-utils';

describe('legacy QBO org-link backfill (spec §8.11)', () => {
  it('creates legacy_unverified mappings, a credential-free stub, conflict exceptions — idempotently', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const orgC = await createOrganization({ partnerId: partner.id }); // no legacy link

    await withSystemDbAccessContext(async () => {
      await db.update(organizations).set({ accountingProvider: 'quickbooks', accountingExternalId: 'QB-77' })
        .where(eq(organizations.id, orgA.id));
      // orgB claims the SAME remote id → conflict, not silent selection.
      await db.update(organizations).set({ accountingProvider: 'quickbooks', accountingExternalId: 'QB-77' })
        .where(eq(organizations.id, orgB.id));
    });

    const first = await runLegacyAccountingLinkBackfill();
    expect(first.orgsExamined).toBe(2);
    expect(first.stubsCreated).toBe(1);        // partner had no QBO connection
    expect(first.mappingsCreated).toBe(1);     // one org wins the unique remote claim
    expect(first.conflicts).toBe(1);           // the other becomes an open exception

    await withSystemDbAccessContext(async () => {
      const [stub] = await db.select().from(accountingConnections)
        .where(and(eq(accountingConnections.partnerId, partner.id), eq(accountingConnections.provider, 'quickbooks')));
      expect(stub.status).toBe('legacy_unverified');
      expect(stub.accessTokenEncrypted).toBeNull();
      expect(stub.isActive).toBe(false);

      const mappings = await db.select().from(accountingEntityMappings)
        .where(eq(accountingEntityMappings.partnerId, partner.id));
      expect(mappings).toHaveLength(1);
      expect(mappings[0].linkState).toBe('legacy_unverified');
      expect(mappings[0].remoteId).toBe('QB-77');

      const exceptions = await db.select().from(accountingSyncExceptions)
        .where(and(eq(accountingSyncExceptions.partnerId, partner.id), eq(accountingSyncExceptions.category, 'legacy_link_conflict')));
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0].status).toBe('open');
    });

    // Re-run: nothing changes (idempotent).
    const second = await runLegacyAccountingLinkBackfill();
    expect(second.mappingsCreated).toBe(0);
    expect(second.stubsCreated).toBe(0);
    expect(second.conflicts).toBe(0);
    expect(second.alreadyMapped + second.conflicts + second.mappingsCreated).toBeLessThanOrEqual(second.orgsExamined);
  });
});
```

Run: `cd apps/api && pnpm test:integration src/__tests__/integration/accountingLegacyBackfill.integration.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 2: Implement**

```ts
// apps/api/src/services/accounting/legacyLinkBackfill.ts
// Spec §8.11: migrate shipped organizations.accounting_provider/_external_id
// links into accounting_entity_mappings. The legacy columns lack realm
// provenance, so every migrated mapping starts legacy_unverified; promotion to
// confirmed requires a remote lookup against the selected tenant (Stage 2).
// Conflicts are never silently selected — they become open exceptions.
// Idempotent: safe to run on every boot.
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  accountingConnections, accountingEntityMappings, accountingSyncExceptions, organizations,
} from '../../db/schema';

export interface LegacyBackfillResult {
  orgsExamined: number;
  mappingsCreated: number;
  stubsCreated: number;
  conflicts: number;
  alreadyMapped: number;
}

export async function runLegacyAccountingLinkBackfill(): Promise<LegacyBackfillResult> {
  return withSystemDbAccessContext(async () => {
    const result: LegacyBackfillResult = {
      orgsExamined: 0, mappingsCreated: 0, stubsCreated: 0, conflicts: 0, alreadyMapped: 0,
    };

    const linked = await db.select({
      id: organizations.id,
      partnerId: organizations.partnerId,
      externalId: organizations.accountingExternalId,
    }).from(organizations)
      .where(and(
        eq(organizations.accountingProvider, 'quickbooks'),
        isNotNull(organizations.accountingExternalId),
        isNull(organizations.deletedAt),
      ));
    result.orgsExamined = linked.length;
    if (linked.length === 0) return result;

    const byPartner = new Map<string, typeof linked>();
    for (const row of linked) {
      const list = byPartner.get(row.partnerId) ?? [];
      list.push(row);
      byPartner.set(row.partnerId, list);
    }

    for (const [partnerId, orgs] of byPartner) {
      // Reuse any retained QBO connection instance; otherwise create the
      // credential-free legacy stub (spec §8.11). The partial unique
      // accounting_connections_pending_stub_uq makes the insert race-safe.
      let [conn] = await db.select().from(accountingConnections)
        .where(and(
          eq(accountingConnections.partnerId, partnerId),
          eq(accountingConnections.provider, 'quickbooks'),
        ))
        .orderBy(accountingConnections.createdAt)
        .limit(1);
      if (!conn) {
        const inserted = await db.insert(accountingConnections).values({
          partnerId, provider: 'quickbooks', status: 'legacy_unverified',
        }).onConflictDoNothing().returning();
        if (inserted.length > 0) {
          conn = inserted[0];
          result.stubsCreated++;
        } else {
          [conn] = await db.select().from(accountingConnections)
            .where(and(
              eq(accountingConnections.partnerId, partnerId),
              eq(accountingConnections.provider, 'quickbooks'),
            )).limit(1);
        }
      }
      if (!conn) continue;

      for (const org of orgs) {
        const existing = await db.select({ id: accountingEntityMappings.id }).from(accountingEntityMappings)
          .where(and(
            eq(accountingEntityMappings.connectionId, conn.id),
            eq(accountingEntityMappings.entityType, 'customer'),
            eq(accountingEntityMappings.organizationId, org.id),
          )).limit(1);
        if (existing.length > 0) {
          result.alreadyMapped++;
          continue;
        }

        const inserted = await db.insert(accountingEntityMappings).values({
          connectionId: conn.id,
          partnerId,
          entityType: 'customer',
          organizationId: org.id,
          remoteEntityType: 'Customer',
          remoteId: org.externalId as string,
          linkState: 'legacy_unverified',
        }).onConflictDoNothing().returning({ id: accountingEntityMappings.id });

        if (inserted.length > 0) {
          result.mappingsCreated++;
          continue;
        }

        // Remote id already claimed by another org in this connection —
        // never silently selected (spec §8.11). One open exception per org.
        const openException = await db.select({ id: accountingSyncExceptions.id }).from(accountingSyncExceptions)
          .where(and(
            eq(accountingSyncExceptions.connectionId, conn.id),
            eq(accountingSyncExceptions.category, 'legacy_link_conflict'),
            eq(accountingSyncExceptions.organizationId, org.id),
            eq(accountingSyncExceptions.status, 'open'),
          )).limit(1);
        if (openException.length === 0) {
          await db.insert(accountingSyncExceptions).values({
            connectionId: conn.id,
            partnerId,
            category: 'legacy_link_conflict',
            entityType: 'customer',
            organizationId: org.id,
            remoteEntityId: org.externalId as string,
            summary: 'Legacy QuickBooks customer id is claimed by another organization in this connection',
            status: 'open',
          });
        }
        result.conflicts++;
      }
    }

    console.log(
      `[accounting] legacy link backfill: examined=${result.orgsExamined} created=${result.mappingsCreated} ` +
      `stubs=${result.stubsCreated} conflicts=${result.conflicts} alreadyMapped=${result.alreadyMapped}`,
    );
    return result;
  });
}
```

- [ ] **Step 3: Register both backfills at boot**

In `apps/api/src/index.ts`, add to the `workers` array (they are idempotent and cheap when there is nothing to do):

```ts
    ['accountingTenantHashBackfill', backfillTenantKeyHashes],
    ['accountingLegacyLinkBackfill', runLegacyAccountingLinkBackfill],
```

with the imports from `./services/accounting/accountingConnectionService` and `./services/accounting/legacyLinkBackfill`. If the `workers` array's function type is `() => Promise<void>`, wrap: `async () => { await backfillTenantKeyHashes(); }` (same for the other).

- [ ] **Step 4: Run tests**

```bash
cd apps/api && pnpm test:integration src/__tests__/integration/accountingLegacyBackfill.integration.test.ts
npx tsc --noEmit
```
Expected: PASS (1 test), clean typecheck.

- [ ] **Step 5: Full Stage 1 gate run, then commit**

```bash
cd apps/api && pnpm test:integration && pnpm test:rls-coverage && cd ../..
pnpm test --filter=@breeze/api
pnpm test --filter=@breeze/shared
```
Expected: all green (this is the Stage 1 gate: RLS forge suite, cascade contract, outbox crash/replay, backfill accounting).

```bash
git add apps/api/src/services/accounting/legacyLinkBackfill.ts apps/api/src/__tests__/integration/accountingLegacyBackfill.integration.test.ts apps/api/src/index.ts
git commit -m "feat(accounting): legacy QBO org-link backfill with stubs + conflict exceptions (P0-1 Stage 1)"
```

---

## Self-Review Notes (performed while authoring)

1. **Spec coverage (Stage 1 scope):** schema/migrations/RLS → Tasks 2, 4–6; connection instances + one-active rule → Tasks 2, 12; typed provider contract → Task 10; generic mappings → Task 4; tax mappings → Task 4; durable operations/attempts → Tasks 5, 13, 14; webhook receipts + cursors + exceptions → Task 6; permissions → Task 9; org/partner erasure pre-clears (§8.14) → Task 8; legacy QBO-link backfill (§8.11) → Task 15; payment soft-void (§8.2) → Tasks 2–3; tenant-key HMAC (§8.1/§15.3) → Task 11. Deliberately deferred to Stage 2/3 (per spec stages): OAuth tenant-selection flow, provider revocation call on disconnect, `createSyncOperation` wiring inside `issueInvoice`/`recordPayment`/`voidPayment`, webhook routes, reconciliation, all UI.
2. **Known judgment calls an implementer must not "fix":** BullMQ `attempts: 1` is deliberate (retries are DB-scheduled); the legacy `(partner_id, provider)` unique index stays; attempts rows are filled in but outcome is write-once; `deleteConnection` survives for erasure only; new-table status columns are varchar+CHECK (not pgEnum) to match `accounting_connections` and keep the vocabularies migration-evolvable.
3. **Type consistency:** `SyncOperationRow` defined in Task 13, consumed by Task 14; `AccountingErasureBlockedError` defined Task 8 and used in its route step; `NONTERMINAL_OUTBOUND_STATUSES` (Task 12) matches the operation status vocabulary (Task 1); handler outcome statuses match `ACCOUNTING_OPERATION_STATUSES`.
4. **Escape hatches marked:** steps that touch code whose exact current shape wasn't verifiable at plan time (queueResult counts in Task 3, `db.execute` row access, `RecordPaymentInput` field names, `cascadeDeleteOrg` signature, existing-interface member names in Task 10) say exactly what to check and what invariant to preserve. These are verification instructions, not open design questions.

**Execution order is Task 1 → 15 strictly** (each consumes the previous tasks' schema/exports). After Task 15, Stage 1's gate is the full command block in Task 15 Step 5 plus `pnpm db:check-drift`.




