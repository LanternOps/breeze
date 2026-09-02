# QuickBooks Phase D2 — Payment Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a payment is recorded in Breeze against an invoice already pushed to QuickBooks, create the matching QuickBooks `Payment` applied to that invoice — and delete it from QuickBooks when the Breeze payment is voided or fully refunded — idempotently under crashes, retries and the connection's own CDC echo, gated by `push_mode` plus a new `push_payments` switch.

**Architecture:** The `payment` mapping row is both the desired-state record and the outbox. `requestPaymentPush` / `requestPaymentDelete` write `pending_op = 'push' | 'delete'` **inside the caller's already-locked payment transaction**; the post-commit BullMQ enqueue is only a latency optimisation, and the existing 15-minute reconcile sweep re-enqueues any stale `pending_op` row, so a lost enqueue self-heals with no operator action. The worker claims a row with a compare-and-set lease (`claimed_at`), calls QuickBooks with NO DB context held (the Phase C phase split), then re-reads under the invoice lock before stamping the remote ref. Breeze is the system of record for Breeze-origin payments (`breeze_origin = true`), so the Phase D pull never mutates one: it adopts, replays, or records a divergence. The push is **create-only** — a partial refund is a recorded divergence, never an amount rewrite.

**Tech Stack:** Hono, Drizzle, BullMQ, Vitest (unit + real-Postgres integration), React (web), QBO REST v3 `minorversion=70` (`POST /payment`, `POST /payment?operation=delete`, `requestid` idempotency, CDC).

**Spec:** `docs/superpowers/specs/billing/2026-09-02-quickbooks-phase-d2-payment-push-design.md` (binding — its 15 numbered decisions are the authority; this plan implements them and never relitigates them). Parent spec: `docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md`. Builds on Phase C invoice push (#4492) and Phase D payment pull-back (#4531, walked in #4537). The in-code contract at `apps/api/src/services/accounting/accountingCurrency.ts:143-201` is the payment applier's ordering + at-most-once contract and stays satisfied.

## Global Constraints

- Branch `feat/quickbooks-payment-push`, based on `origin/main` at `aa09cfbcb` with the spec commit `ad3aa25d5` already on top. **Commit this plan file as the first commit.**
- **No DB context may be open across any QuickBooks HTTP call.** Every entry point that brackets a QBO call with DB work calls `assertNoAmbientDbContext(<name>)` and takes a `DbContextRunner` (`apps/api/src/services/accounting/dbContextGuard.ts:26-45` — read its header before writing a line of Task 3). Sync-state writes (error markers, lease release) commit in their OWN short context: a savepoint inside the caller's transaction rolls back the moment the caller throws, and the operator then sees no error at all.
- **`accountingPaymentPush.ts` never touches Redis.** Every function there returns the mapping ids that are owed an enqueue; the CALLER (invoiceService, stripeReconcile, the sync worker, the reconcile sweep) does the `add()` after its transaction returns. This keeps BullMQ out of the coordinator's unit tests and out of every held lock.
- **Money:** major-unit decimal strings in Breeze (`numeric(12,2)`). The push sends `Number(amount)` at the wire boundary only, mirroring `quickbooksProvider.pushInvoice`'s `Amount: Number(line.lineTotal)` (`quickbooksProvider.ts:628`). Never `fromMinorUnits` on this path — nothing arrives in minor units.
- **Never persist or rethrow a raw QBO response body.** Sanitize to `QuickBooks rejected the payment sync (HTTP <status>)` (pattern: `accountingInvoicePush.ts:243-248`).
- **Zero-row-throw on every write** (`.returning({ id })` + length check). A zero-row match is an RLS-context bug, not a no-op.
- **BullMQ jobIds contain no colons**; `removeOnComplete: true` / `removeOnFail: true` (Phase C lesson — BullMQ silently drops an `add()` whose jobId still sits in the retained completed/failed sets). Payment jobIds are `accounting-payment-<mappingId>-push` and `accounting-payment-<mappingId>-delete` so a delete enqueued while a push job is still active is never swallowed by a shared deterministic id (spec decision 7).
- Migration file MUST be named `apps/api/migrations/2026-10-02-110000-quickbooks-payment-push.sql`. Verified 2026-09-02: `'2026-10-02-100000-outbox-retention-indexes.sql'.localeCompare('2026-10-02-110000-quickbooks-payment-push.sql') === -1`, and that outbox file is the newest committed migration. **Re-verify with `ls apps/api/migrations | sort | tail -3` before creating it** — another branch may have raised the ceiling. Idempotent; no inner `BEGIN`/`COMMIT`.
- **The migration's backfill MUST run under `SELECT set_config('breeze.scope', 'system', true);`.** `accounting_entity_mappings` is `ENABLE` + `FORCE ROW LEVEL SECURITY`, and on managed Postgres the migration role is not a superuser, so an unscoped `UPDATE` silently matches zero rows while CI (superuser) masks it. Exact precedent: `apps/api/migrations/2026-09-30-100000-rls-scoped-backfill-replay.sql:1-24`.
- Web mutations wrap in `runAction` (`apps/web/src/lib/runAction.ts`); all copy through `t(...)` with genuine translations in **all 8 locale dirs** (`de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`). `translationCoverage.test.ts` enforces a global `< 0.2` duplicate ratio AND per-namespace, per-locale duplicate baselines (`namespaceDuplicateBaselines`, `:15`; `namespaceDuplicateRegressions`, `:579-596`) — English-identical strings in `integrations.json`/`billing.json` breach them.
- **`no-silent-mutations.test.ts` needs NO counter bump.** `src/components/integrations/QuickbooksIntegration.tsx` is already in `TARGET_GLOBS` (`:226`) and `expect(absoluteFiles.length).toBe(108)` (`:528`) counts FILES, not mutations. Adding a handler to an already-registered file changes nothing.
- Run one API unit file with `cd apps/api && npx vitest run <path>` (or `pnpm --filter @breeze/api test --run <path>` — **never** insert `--` before `--run`). Integration suites need a real DB (`pnpm test-stack up`): `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`.
- **No new tables** → no `tenantCascade`, export-policy, `orgMergeRegistry` or RLS-allowlist registrations. All three new columns land on two partner-axis tables that carry no `org_id`: `accounting_connections` and `accounting_entity_mappings` (`rls-coverage.integration.test.ts:216-217`). Verified 2026-09-02 that the erasure/merge `payment` arms already exist and need no change: `tenantCascade.ts:646,662` and `orgMerge.ts:846,858,877`. **Re-grep before calling Task 1 done** — this is the list that gets missed.
- `partner-wide-write-coverage.test.ts` gains ONE exemption entry for `services/accounting/accountingPaymentPush.ts` (Task 3), mirroring the `accountingPaymentPull.ts` line at `:191`. Reason strings in that map are long-form sentences; match the neighbours.
- **No new worker** → `workerRegistry.test.ts`'s count stays **123** and `workerEntrypointClosure.contract.test.ts` is untouched. The two new job types ride the existing `accounting-sync` queue.

### Name glossary (every task must match these exactly)

```ts
// apps/api/src/services/accounting/accountingPaymentMarker.ts   (Task 2, new)
// A dependency-free LEAF module: the payment identity rules both directions share.
export const BREEZE_PAYMENT_NOTE_PREFIX = 'Breeze payment ';
export function buildPaymentPrivateNote(invoicePaymentId: string): string;
export function parseBreezePaymentMarker(privateNote: string | null | undefined): string | null;
/** `<PaymentId>/<remoteInvoiceId>` — MOVED here from accountingPaymentPull.ts in
 *  Task 2 so the push coordinator does not have to import the pull module (that
 *  would close a real cycle: invoiceService -> push -> pull -> invoiceService).
 *  `accountingPaymentPull.ts` re-exports it, so its existing consumers are
 *  unaffected. */
export function paymentMappingRemoteId(remotePaymentId: string, remoteInvoiceId: string): string;

// apps/api/src/services/accounting/types.ts                     (Task 2)
export interface AccountingPaymentPayload {
  invoicePaymentId: string;
  remoteCustomerId: string;
  remoteInvoiceId: string;
  /** Major-unit decimal string, 2dp. Converted to a JSON number at the wire only. */
  amount: string;
  currencyCode: string;
  /** ISO date (YYYY-MM-DD) from invoice_payments.received_at. */
  txnDate: string;
  /** PaymentRefNum. Truncated to QBO's 21-char cap by the coordinator. Never an ownership key. */
  reference: string | null;
  /** `Breeze payment <uuid>` — the adoption marker (spec decision 3). */
  privateNote: string;
}
export interface AccountingDeletePaymentPayload {
  remotePaymentId: string;
  syncToken: string | null;
}
export type PaymentDeleteResult = 'deleted' | 'already_absent';
// AccountingProvider gains:
//   createPayment(conn: AccountingConnection, payment: AccountingPaymentPayload): Promise<RemoteRef>;
//   deletePayment(conn: AccountingConnection, payment: AccountingDeletePaymentPayload): Promise<PaymentDeleteResult>;
// ChangeSetPaymentLine gains:
//   /** Parsed from PrivateNote by parseBreezePaymentMarker; null unless the whole note matches. */
//   breezePaymentId: string | null;

// apps/api/src/services/accounting/accountingPaymentPush.ts     (Task 3, new)
export const PAYMENT_CLAIM_LEASE_MS = 10 * 60 * 1000;
export const PAYMENT_SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
export const PAYMENT_REF_MAX_LENGTH = 21;

export type AccountingPaymentPushErrorCode =
  | 'not_connected' | 'reauth_required'
  | 'push_disabled'          // terminal — the switch is off
  | 'sync_in_progress'       // RETRYABLE — lease held, or the mapping is not visible yet
  | 'invoice_not_synced'     // RETRYABLE — the invoice push has not landed a remote id yet
  | 'invoice_void'           // terminal — Breeze voided the invoice; decision 11 forbids the push
  | 'customer_not_mapped'    // terminal
  | 'home_currency_unknown' | 'currency_mismatch'  // terminal
  | 'quickbooks_error'       // RETRYABLE 502
  | 'record_failed';         // terminal 502 — QBO wrote, Breeze could not record it
// NOTE: there is deliberately no `payment_gone` CODE — it is an OUTCOME below.
// Nothing failed and nothing is left undone, and there is no durable row left to
// stamp a terminal error on. See Task 3's second resolved ambiguity.

export class AccountingPaymentPushError extends Error {
  constructor(
    public readonly code: AccountingPaymentPushErrorCode,
    public readonly status: 404 | 409 | 502,
    message: string,
  );
}

export type PaymentPushOutcome =
  | 'pushed'               // created in QBO; mapping synced with the composite remote id
  | 'already_adopted'      // the CDC echo filled the remote id before phase 2 ran
  | 'converted_to_delete'  // the payment vanished (void/refund) mid-flight; pending_op flipped
  | 'diverged'             // the amount changed mid-flight (partial refund); mapping -> error
  | 'payment_gone'         // the payment vanished and nothing existed remotely; mapping dropped
  | 'nothing_owed';        // pending_op was already cleared by another writer
export type PaymentDeleteOutcome = 'deleted' | 'already_absent' | 'nothing_owed';

export async function requestPaymentPush(
  tx: PaymentMappingExecutor,
  params: { invoicePaymentId: string; invoiceId: string; partnerId: string },
): Promise<string | null>;                      // mapping id to enqueue, or null
export async function requestPaymentDelete(
  tx: PaymentMappingExecutor,
  invoicePaymentId: string,
): Promise<string | null>;                      // mapping id to enqueue a DELETE for, or null
export async function pushPaymentToAccounting(
  mappingId: string, partnerId: string, runInDbContext: DbContextRunner,
): Promise<PaymentPushOutcome>;
export async function deletePaymentInAccounting(
  mappingId: string, partnerId: string, runInDbContext: DbContextRunner,
): Promise<PaymentDeleteOutcome>;
export async function fanOutOwedPayments(
  invoiceId: string, partnerId: string, runInDbContext: DbContextRunner,
): Promise<string[]>;                           // mapping ids to enqueue a PUSH for
export async function listOwedPaymentMappings(
  dbc: PaymentMappingExecutor, now: Date,
): Promise<Array<{ id: string; partnerId: string; pendingOp: 'push' | 'delete' }>>;

// apps/api/src/jobs/accountingSyncWorker.ts                     (Task 4)
export async function enqueueAccountingPaymentPush(mappingId: string, partnerId: string): Promise<boolean>;
export async function enqueueAccountingPaymentDelete(mappingId: string, partnerId: string): Promise<boolean>;
// AccountingSyncJobData gains:
//   { type: 'push-payment';   mappingId: string; partnerId: string }
//   { type: 'delete-payment'; mappingId: string; partnerId: string }

// apps/api/src/services/accounting/accountingPaymentPull.ts     (Task 6)
// PaymentPullOutcome gains: 'adopted' | 'breeze_origin_diverged' | 'skipped_breeze_origin'
//                         | 'skipped_pull_disabled' | 'breeze_origin_removed_remotely'
// markInvoiceDeletedRemotely returns: 'marked' | 'skipped_unmapped' | 'realm_changed' | 'invoice_void'

// apps/api/src/services/invoiceService.ts                       (Task 5)
// listPayments()'s rows gain: accountingSync: { status: string; lastError: string | null } | null
```

---

## File Structure

```
apps/api/migrations/2026-10-02-110000-quickbooks-payment-push.sql   (new)
apps/api/src/db/schema/accounting.ts                                (modify: 1 + 3 columns, 1 check, 1 partial index)
apps/api/src/services/accounting/accountingConnectionService.ts     (modify: pushPayments on the DTO/mapConnection/upsert; widen listReconcilableConnections)
apps/api/src/services/accounting/accountingPaymentMarker.ts         (new: the PrivateNote grammar, both directions, one place)
apps/api/src/services/accounting/types.ts                           (modify: payload types + 2 provider methods + breezePaymentId)
apps/api/src/services/accounting/quickbooksProvider.ts              (modify: createPayment/deletePayment, PrivateNote on CDC)
apps/api/src/services/accounting/accountingPaymentPush.ts           (new: request helpers + coordinator + fan-out + sweep query)
apps/api/src/services/accounting/accountingPaymentPull.ts           (modify: adoption, breeze_origin rules, pull-disabled skip, self-void guard)
apps/api/src/services/accounting/accountingInvoicePush.ts           (modify: fan-out hook after persistInvoiceRemoteRef)
apps/api/src/services/accounting/accountingInvoicePushCallSites.test.ts (modify: 4 methods, 2 modules)
apps/api/src/jobs/accountingSyncWorker.ts                           (modify: 2 job types, 2 enqueue helpers, payment terminal codes)
apps/api/src/jobs/accountingReconcileWorker.ts                      (modify: pull||push gate, pending_op sweep, new tally counters)
apps/api/src/services/invoiceService.ts                             (modify: recordPayment/voidPayment/listPayments hooks, paid_at fix)
apps/api/src/services/stripeReconcile.ts                            (modify: capture hook, full-refund delete, partial-refund divergence)
apps/api/src/routes/accounting/index.ts                             (modify: pushPayments in settingsSchema/PATCH/GET)
apps/api/src/__tests__/partner-wide-write-coverage.test.ts           (modify: one exemption entry)
apps/api/src/__tests__/integration/accountingPaymentPush.integration.test.ts (new)
apps/web/src/components/integrations/QuickbooksIntegration.tsx      (modify: push-payments toggle)
apps/web/src/components/billing/InvoiceDetail.tsx                   (modify: per-payment accounting-sync badges)
apps/web/src/components/billing/invoiceTypes.ts                     (modify: accountingSync on InvoicePayment)
apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/{billing,integrations}.json (modify)
docs/integrations/quickbooks-sandbox-verification.md                (modify: Phase D2 checklist, items 27+, PENDING)
docs/release-notes/next-release-draft.md                            (modify: one new section)
```

**Locked decisions (do not relitigate mid-task):**

1. **Both request helpers return the mapping id (`string | null`), never a boolean.** The spec's prose says `requestPaymentPush` "returns `false`" when nothing is owed, but the caller must enqueue `push-payment { mappingId }` after the transaction and therefore needs the id. `null` is the "nothing owed" signal for both helpers; the two are symmetric.
2. **`accountingPaymentPush.ts` performs no enqueue.** The spec says phase 2 should "re-enqueue" a converted delete; instead `pushPaymentToAccounting` returns `'converted_to_delete'` and the WORKER enqueues the delete. Same observable behaviour, and it keeps Redis (and BullMQ imports) out of a module that runs inside other people's transactions. `fanOutOwedPayments` likewise returns ids for `pushInvoiceToAccounting` to enqueue.
3. **The PrivateNote grammar lives in its own module** (`accountingPaymentMarker.ts`), imported by both the provider (parse) and the coordinator (build). Putting it in the provider would make the coordinator import a provider implementation; putting it in `types.ts` would put runtime code in a types-only module.
4. **`listReconcilableConnections` widens to `pull_payments OR push_payments`** rather than gaining a second function: it is already the single "which connections does the sweep care about" query, and spec decision 6 makes that predicate the answer.
5. **The stale-`pending_op` sweep is connection-agnostic.** It enumerates `accounting_entity_mappings` directly (partner-axis, one indexed query) rather than joining connections, because a `delete` must propagate even when both switches are off (spec decision 10) and even for a connection the reconcile fan-out skipped.
6. **Payment terminal codes include `not_connected`, `reauth_required` and `home_currency_unknown`** on top of the five the spec names. They are terminal for exactly the reason the invoice worker already treats them so (`accountingSyncWorker.ts:73-83`): retrying cannot fix a disconnected realm or an uncaptured home currency, and the mapping row carries the error for an operator.

---

### Task 1: Migration, mapping columns, `push_payments` on the connection

**Files:**
- Create: `apps/api/migrations/2026-10-02-110000-quickbooks-payment-push.sql`
- Modify: `apps/api/src/db/schema/accounting.ts:18-67` (connection), `:69-124` (mappings)
- Modify: `apps/api/src/services/accounting/accountingConnectionService.ts:16-44` (DTO), `:46-62` (upsert fields), `:121-146` (`mapConnection`), `:172-222` (`upsertConnection`), `:346-359` (`listReconcilableConnections`)
- Modify (fixtures broken by the widened DTO): `apps/api/src/services/accounting/quickbooksProvider.test.ts:12-25`, `apps/api/src/services/accounting/accountingInvoicePush.test.ts:109-117`
- Test: `apps/api/src/services/accounting/accountingConnectionService.test.ts` (extend), `apps/api/src/db/autoMigrate.test.ts` (auto-covers naming/order)

**Interfaces:**
- Consumes: `stripUndefined`, `encryptedField`, `fingerprintField` (all already local to `accountingConnectionService.ts`), `DbExecutor` (local type alias).
- Produces:
```ts
// accountingConnectionService.ts — ONE field APPENDED to the existing
// AccountingConnection interface (:16-44). The other 22 members are untouched.
export interface AccountingConnection {
  /** Per-connection Breeze -> QBO payment push switch. DB default true. */
  pushPayments: boolean;
}
// UpsertConnectionFields (:46-62) gains exactly one optional member:
export interface UpsertConnectionFields { pushPayments?: boolean }

/** Connections the 15-minute sweep should reconcile: 'connected' AND (pull OR push). */
export async function listReconcilableConnections(
  dbc: DbExecutor, provider: AccountingProviderId,
): Promise<Array<{ id: string; partnerId: string }>>;   // signature unchanged; PREDICATE widened
```
```ts
// db/schema/accounting.ts — accountingEntityMappings gains three columns:
breezeOrigin: boolean('breeze_origin').notNull().default(false),
pendingOp: varchar('pending_op', { length: 10 }),
claimedAt: timestamp('claimed_at', { withTimezone: true }),
// plus a CHECK `accounting_entity_mappings_pending_op_chk` and a partial index
// `accounting_entity_mappings_pending_op_idx` on (partner_id, pending_op).
```

- [ ] **Step 1: Confirm the migration name still sorts last.**

Run: `ls apps/api/migrations | sort | tail -3`
Expected: the newest `.sql` is `2026-10-02-100000-outbox-retention-indexes.sql` (or older). If a newer file exists, rename the new migration to sort strictly after it — `node -e "console.log('<newest>'.localeCompare('2026-10-02-110000-quickbooks-payment-push.sql'))"` must print `-1`.

- [ ] **Step 2: Write the migration.**

Create `apps/api/migrations/2026-10-02-110000-quickbooks-payment-push.sql`:

```sql
-- Phase D2 (payment push) — Task 1.
--
-- accounting_connections gains the Breeze -> QuickBooks payment push switch.
-- accounting_entity_mappings becomes its own outbox: `pending_op` records the
-- operation the row still owes QuickBooks, `claimed_at` is the worker's lease,
-- and `breeze_origin` tells the CDC pull that Breeze — not QuickBooks — is the
-- system of record for this payment (a CDC DELETION carries no PrivateNote, so
-- origin has to be known locally).
--
-- No RLS changes: both tables are partner-axis and already ENABLE + FORCE with
-- partner policies (2026-09-28-quickbooks-entity-mappings.sql:150-168). No
-- org_id anywhere, so no tenantCascade / export-policy / orgMerge registration.
--
-- The entity-partner guard trigger fires only on INSERT and
-- UPDATE OF partner_id, breeze_entity_type, breeze_entity_id, so a row whose
-- invoice_payments target has already been deleted can legally carry
-- pending_op = 'delete' until QuickBooks confirms the removal.

ALTER TABLE accounting_connections
  ADD COLUMN IF NOT EXISTS push_payments boolean NOT NULL DEFAULT true;

ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS breeze_origin boolean NOT NULL DEFAULT false;
ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS pending_op text;
ALTER TABLE accounting_entity_mappings
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounting_entity_mappings_pending_op_chk'
      AND conrelid = 'accounting_entity_mappings'::regclass
  ) THEN
    ALTER TABLE accounting_entity_mappings
      ADD CONSTRAINT accounting_entity_mappings_pending_op_chk
      CHECK (pending_op IS NULL OR pending_op IN ('push', 'delete'));
  END IF;
END $$;

-- The sweep's only predicate: "which rows still owe QuickBooks something".
-- Partial, so it stays tiny — the steady state is zero pending rows.
CREATE INDEX IF NOT EXISTS accounting_entity_mappings_pending_op_idx
  ON accounting_entity_mappings (partner_id, pending_op)
  WHERE pending_op IS NOT NULL;

-- Backfill: every invoice mapping that exists today was created by Breeze's own
-- push (accountingInvoicePush.ts is the only writer of breeze_entity_type =
-- 'invoice'), so those rows are Breeze-origin. Payment rows that exist today
-- came from the Phase D pull and stay false.
--
-- `breeze.scope = 'system'` is REQUIRED: accounting_entity_mappings is
-- ENABLE + FORCE ROW LEVEL SECURITY, and on managed Postgres the migration role
-- is not a superuser, so an unscoped UPDATE silently matches zero rows while CI
-- (superuser) reports success. Same pattern as
-- 2026-09-30-100000-rls-scoped-backfill-replay.sql. `is_local = true` scopes it
-- to autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  marked integer;
BEGIN
  UPDATE accounting_entity_mappings
     SET breeze_origin = true
   WHERE breeze_entity_type = 'invoice'
     AND breeze_origin = false;
  GET DIAGNOSTICS marked = ROW_COUNT;
  RAISE WARNING 'marked % invoice accounting mappings as Breeze-origin', marked;
END $$;
```

- [ ] **Step 3: RED — failing unit tests.**

In `apps/api/src/services/accounting/accountingConnectionService.test.ts`, append to the existing suite (it already has the `insertValues()` / `conflictUpdateSet()` / `compiledWhere()` helpers from Phase D — reuse them, do not redeclare):

```ts
describe('pushPayments switch (Phase D2)', () => {
  it('upsertConnection inserts pushPayments true by default', async () => {
    await upsertConnection(dbMock, 'p1', 'quickbooks', { realmId: 'realm-9' });
    expect(insertValues().pushPayments).toBe(true);
  });
  it('upsertConnection leaves pushPayments untouched on a token-only reconnect', async () => {
    await upsertConnection(dbMock, 'p1', 'quickbooks', { accessToken: 'a' });
    expect('pushPayments' in conflictUpdateSet()).toBe(false);
  });
  it('upsertConnection writes pushPayments when the caller supplies it', async () => {
    await upsertConnection(dbMock, 'p1', 'quickbooks', { pushPayments: false });
    expect(conflictUpdateSet().pushPayments).toBe(false);
  });
  it('mapConnection surfaces pushPayments', async () => {
    const conn = await getConnection(dbMock, 'p1', 'quickbooks');
    expect(conn).toMatchObject({ pushPayments: true });
  });
});

describe('listReconcilableConnections gates on pull OR push (spec decision 6)', () => {
  it('compiles a status filter plus an OR of both switches', async () => {
    await listReconcilableConnections(dbMock, 'quickbooks');
    // Assert the COMPILED clause + bound params, never "select was called".
    const { sql, params } = compiledWhere();
    expect(sql).toMatch(/"provider" = \$\d+ and "status" = \$\d+ and \("pull_payments" = \$\d+ or "push_payments" = \$\d+\)/i);
    expect(params).toEqual(['quickbooks', 'connected', true, true]);
  });
});
```

- [ ] **Step 4: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts`
Expected: FAIL — `insertValues().pushPayments` is `undefined`, and the compiled `where` has no `push_payments` term.

- [ ] **Step 5: Implement the schema and the service.**

In `apps/api/src/db/schema/accounting.ts`, add to the `accountingConnections` column block (immediately after `pullPayments`, `:49`):

```ts
  // Per-connection Breeze -> QBO payment push switch (Phase D2). Defaults true,
  // matching pullPayments: a connected realm should push the payments it is
  // already pulling, rather than silently opting every partner out.
  pushPayments: boolean('push_payments').notNull().default(true),
```

In the same file, add to the `accountingEntityMappings` column block (after `syncStatus`, `:87`):

```ts
  // TRUE for every mapping Breeze's own push created (payments here; invoices
  // by the Task-1 backfill). The CDC pull needs origin LOCALLY because a
  // deletion notification carries no PrivateNote to read it from.
  breezeOrigin: boolean('breeze_origin').notNull().default(false),
  // The operation this row still owes QuickBooks. NULL = nothing owed. Written
  // in the SAME transaction as the invoice_payments insert/delete, which is what
  // makes the mapping row the outbox rather than the BullMQ job.
  pendingOp: varchar('pending_op', { length: 10 }),
  // Worker lease. A claim is a compare-and-set on (pending_op IS NOT NULL AND
  // (claimed_at IS NULL OR claimed_at < now() - 10 min)).
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
```

and to its index/constraint block (after `syncStatusCheck`, `:113-116`):

```ts
  pendingOpCheck: check(
    'accounting_entity_mappings_pending_op_chk',
    sql`${table.pendingOp} IS NULL OR ${table.pendingOp} IN ('push', 'delete')`,
  ),
  pendingOpIdx: index('accounting_entity_mappings_pending_op_idx')
    .on(table.partnerId, table.pendingOp)
    .where(sql`${table.pendingOp} IS NOT NULL`),
```

In `apps/api/src/services/accounting/accountingConnectionService.ts`:
- Add to `AccountingConnection` (after `pullPayments`, `:39`): `/** Per-connection Breeze -> QBO payment push switch. DB default true. */ pushPayments: boolean;`
- Add to `UpsertConnectionFields` (after `pullPayments?`, `:61`): `pushPayments?: boolean;`
- Add to `mapConnection` (after `pullPayments: row.pullPayments`, `:142`): `pushPayments: row.pushPayments,`
- Add to `upsertConnection`'s `values` (after `pullPayments`, `:189`): `pushPayments: fields.pushPayments ?? true,`
- Add to `upsertConnection`'s `updateSet` (after `pullPayments`, `:217`): `pushPayments: fields.pushPayments,`
- Widen `listReconcilableConnections`'s predicate (`:351-358`) and its doc comment:

```ts
/**
 * Connections the 15-minute sweep should reconcile: 'connected' AND at least one
 * direction switched on. Phase D2 (spec decision 6): with pull OFF and push ON
 * the CDC pass still has to run — it is what adopts a Breeze-created Payment
 * whose phase 2 never landed, and what notices a Breeze-origin Payment someone
 * deleted in QuickBooks. It just suppresses NEW QuickBooks-origin imports.
 */
export async function listReconcilableConnections(
  dbc: DbExecutor,
  provider: AccountingProviderId,
): Promise<Array<{ id: string; partnerId: string }>> {
  return dbc
    .select({ id: accountingConnections.id, partnerId: accountingConnections.partnerId })
    .from(accountingConnections)
    .where(and(
      eq(accountingConnections.provider, provider),
      eq(accountingConnections.status, 'connected'),
      or(
        eq(accountingConnections.pullPayments, true),
        eq(accountingConnections.pushPayments, true),
      ),
    ));
}
```

Add `or` to the `drizzle-orm` import at `:1`.

- [ ] **Step 6: Fix the two full-object connection fixtures.**

`apps/api/src/services/accounting/quickbooksProvider.test.ts:22` and `apps/api/src/services/accounting/accountingInvoicePush.test.ts:114` each spell out every `AccountingConnection` member. Add `pushPayments: true,` next to `pullPayments: true,` in both.

- [ ] **Step 7: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts src/services/accounting/quickbooksProvider.test.ts src/services/accounting/accountingInvoicePush.test.ts src/db/autoMigrate.test.ts`
Expected: PASS (all four files).

- [ ] **Step 8: Verify the migration against a real database.**

Run, from the repo root with `pnpm test-stack up` running:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
bash scripts/check-migration-naming.sh
```
Expected: `db:migrate` applies the new file and logs `WARNING: marked N invoice accounting mappings as Breeze-origin`; `db:check-drift` reports NO drift; the naming guard prints OK. Re-run `pnpm db:migrate` once more — expected: the file is skipped (already recorded), i.e. re-application is a no-op.

- [ ] **Step 9: Re-grep the cascade lists (the step that gets missed).**

Run: `grep -rn "accounting_entity_mappings\|accounting_connections" apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMerge.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts`
Expected: the pre-existing Phase C/D arms only (`tenantCascade.ts:646,662`; `orgMerge.ts:846,858,877`). Neither table has an `org_id` column, so neither appears in `CORE_ORG_CASCADE_DELETE_ORDER` nor in `CORE_TENANT_EXPORT_POLICY` — **nothing to add**. Record that verification in the commit body.

- [ ] **Step 10: Commit.**

```bash
git add -A && git commit -m "feat(accounting): push-payments switch and pending-op outbox columns on accounting mappings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ"
```

---

### Task 2: Provider transport — `createPayment`, `deletePayment`, and the PrivateNote marker

**Files:**
- Create: `apps/api/src/services/accounting/accountingPaymentMarker.ts`
- Create: `apps/api/src/services/accounting/accountingPaymentMarker.test.ts`
- Modify: `apps/api/src/services/accounting/accountingPaymentPull.ts:146-176` (move `paymentMappingRemoteId` out, re-export it)
- Modify: `apps/api/src/services/accounting/types.ts:164-182` (`ChangeSetPaymentLine`), `:204-242` (`AccountingProvider`), and a new payload block after `:157`
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts:179-189` (`QboRawCdcPayment`), `:219-237` (`mapQboCdcPayment`), and two new methods after `voidInvoice` (`:730`)
- Modify: `apps/api/src/services/accounting/accountingInvoicePushCallSites.test.ts:41-43,61-89,103-110` (widen the scanner to four methods; the expected map stays as it is until Task 3)
- Test: `apps/api/src/services/accounting/types.test.ts` (extend), `apps/api/src/services/accounting/quickbooksProvider.test.ts` (extend)

**Interfaces:**
- Consumes: `qboRequest` (private, `quickbooksProvider.ts:916-948` — attaches `{ status, body }` to a non-2xx error, `body` truncated to 500 chars), `QBO_API_MINOR_VERSION` (`:30`), `toMinorUnits` (`@breeze/shared`).
- Produces:
```ts
// accountingPaymentMarker.ts
export const BREEZE_PAYMENT_NOTE_PREFIX = 'Breeze payment ';
export function buildPaymentPrivateNote(invoicePaymentId: string): string;
export function parseBreezePaymentMarker(privateNote: string | null | undefined): string | null;
export function paymentMappingRemoteId(remotePaymentId: string, remoteInvoiceId: string): string;
// accountingPaymentPull.ts keeps `export { paymentMappingRemoteId } from './accountingPaymentMarker';`
// so accountingCurrency.ts's contract comment and the pull test still resolve it there.

// types.ts
export interface AccountingPaymentPayload {
  invoicePaymentId: string; remoteCustomerId: string; remoteInvoiceId: string;
  amount: string; currencyCode: string; txnDate: string;
  reference: string | null; privateNote: string;
}
export interface AccountingDeletePaymentPayload { remotePaymentId: string; syncToken: string | null }
export type PaymentDeleteResult = 'deleted' | 'already_absent';
// AccountingProvider gains:
createPayment(conn: AccountingConnection, payment: AccountingPaymentPayload): Promise<RemoteRef>;
deletePayment(conn: AccountingConnection, payment: AccountingDeletePaymentPayload): Promise<PaymentDeleteResult>;
// ChangeSetPaymentLine gains:
breezePaymentId: string | null;
```

- [ ] **Step 1: RED — the marker grammar test.**

Create `apps/api/src/services/accounting/accountingPaymentMarker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BREEZE_PAYMENT_NOTE_PREFIX, buildPaymentPrivateNote, parseBreezePaymentMarker, paymentMappingRemoteId,
} from './accountingPaymentMarker';

const ID = '0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

describe('Breeze payment PrivateNote marker (spec decision 3)', () => {
  it('round-trips a payment id', () => {
    expect(buildPaymentPrivateNote(ID)).toBe(`${BREEZE_PAYMENT_NOTE_PREFIX}${ID}`);
    expect(parseBreezePaymentMarker(buildPaymentPrivateNote(ID))).toBe(ID);
  });

  it('is ANCHORED — a note that merely contains the marker is not a claim', () => {
    // An operator can type anything into PrivateNote. Only a note that IS the
    // marker, start to end, may hand a QuickBooks Payment ownership of a Breeze
    // payment row; a substring match would let a copied note steal a mapping.
    expect(parseBreezePaymentMarker(`See ${BREEZE_PAYMENT_NOTE_PREFIX}${ID}`)).toBeNull();
    expect(parseBreezePaymentMarker(`${BREEZE_PAYMENT_NOTE_PREFIX}${ID} (re-keyed)`)).toBeNull();
  });

  it('rejects a non-uuid payload, empty notes, and absent notes', () => {
    expect(parseBreezePaymentMarker(`${BREEZE_PAYMENT_NOTE_PREFIX}not-a-uuid`)).toBeNull();
    expect(parseBreezePaymentMarker(`${BREEZE_PAYMENT_NOTE_PREFIX}${ID.toUpperCase()}`)).toBeNull();
    expect(parseBreezePaymentMarker('')).toBeNull();
    expect(parseBreezePaymentMarker(null)).toBeNull();
    expect(parseBreezePaymentMarker(undefined)).toBeNull();
  });

  it('tolerates the whitespace QuickBooks round-trips through its UI', () => {
    expect(parseBreezePaymentMarker(`  ${BREEZE_PAYMENT_NOTE_PREFIX}${ID}\n`)).toBe(ID);
  });
});

describe('paymentMappingRemoteId (moved here from accountingPaymentPull.ts)', () => {
  it('qualifies the QuickBooks Payment id by the invoice it settles', () => {
    // A bare Payment id would let only the FIRST line of a split payment claim a
    // mapping; the rest would collide on accounting_entity_mappings_remote_uniq.
    expect(paymentMappingRemoteId('181', '145')).toBe('181/145');
    expect(paymentMappingRemoteId('181', '146')).toBe('181/146');
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingPaymentMarker.test.ts`
Expected: FAIL — `Failed to resolve import "./accountingPaymentMarker"`.

- [ ] **Step 3: Implement the marker module.**

Create `apps/api/src/services/accounting/accountingPaymentMarker.ts`:

```ts
/**
 * The `PrivateNote` ownership marker Breeze writes onto every QuickBooks
 * Payment it creates, and the anchored grammar that reads it back (Phase D2,
 * spec decision 3).
 *
 * Its own module because BOTH directions must share one grammar and the two
 * users sit on opposite sides of a dependency edge: the provider PARSES it
 * (`mapQboCdcPayment`), the push coordinator BUILDS it. Putting the pair in
 * `quickbooksProvider.ts` would make the provider-neutral coordinator import a
 * provider implementation; putting them in `types.ts` would put runtime code in
 * a types-only module.
 *
 * WHY A MARKER AT ALL: QBO's `requestid` idempotency window is 24 hours and
 * `PrivateNote` is not queryable, so there is no recovery QUERY for a create
 * whose response was lost. Instead the CDC pull ADOPTS: a Payment whose note
 * names a pending Breeze payment fills in the remote id. That makes the marker
 * an authorisation token, which is why the grammar is anchored — a note that
 * merely CONTAINS the phrase (an operator pasting a Breeze reference into a
 * hand-entered Payment) must never claim a Breeze payment row.
 *
 * `paymentMappingRemoteId` lives here for the same reason: it is the OTHER
 * identity rule the two directions share, and keeping it in
 * `accountingPaymentPull.ts` would force the push coordinator to import the pull
 * module — closing a real cycle (invoiceService -> push -> pull ->
 * invoiceService). This module imports nothing, so it can never be in one.
 */

export const BREEZE_PAYMENT_NOTE_PREFIX = 'Breeze payment ';

/** Lowercase canonical uuid only — the ids Postgres hands back are lowercase. */
const MARKER = /^Breeze payment ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function buildPaymentPrivateNote(invoicePaymentId: string): string {
  return `${BREEZE_PAYMENT_NOTE_PREFIX}${invoicePaymentId}`;
}

/** The whole note, or nothing. Leading/trailing whitespace is trimmed first
 *  because QuickBooks' own UI round-trips a trailing newline into the field. */
export function parseBreezePaymentMarker(privateNote: string | null | undefined): string | null {
  if (typeof privateNote !== 'string') return null;
  return MARKER.exec(privateNote.trim())?.[1] ?? null;
}

/**
 * `<PaymentId>/<remoteInvoiceId>` — the at-most-once claim key on
 * `accounting_entity_mappings.remote_entity_id` (Phase D decision 1, and the
 * refinement recorded in `accountingCurrency.ts:190-200`).
 *
 * One QuickBooks Payment can settle SEVERAL invoices (a split payment carries one
 * `Line` per invoice). `accounting_entity_mappings_remote_uniq` is unique on
 * `(integration_id, remote_entity_type, remote_entity_id)`, so a bare Payment id
 * would let only the first split line claim a mapping and the rest would collide.
 * Qualifying it by the invoice makes each (payment, invoice) pair its own claim,
 * and `reverseAccountingPayment` recovers the whole set with a `<PaymentId>/%`
 * prefix match.
 */
export function paymentMappingRemoteId(remotePaymentId: string, remoteInvoiceId: string): string {
  return `${remotePaymentId}/${remoteInvoiceId}`;
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingPaymentMarker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: RED — the type contract.**

Append to `apps/api/src/services/accounting/types.test.ts` (and add `AccountingDeletePaymentPayload`, `AccountingPaymentPayload`, `PaymentDeleteResult` to the `import type` block at `:2-15`):

```ts
describe('payment push seam is fully typed (Phase D2)', () => {
  it('createPayment takes a connection and a currency-bearing payment payload, returning a RemoteRef', () => {
    expectTypeOf<Parameters<AccountingProvider['createPayment']>>()
      .toEqualTypeOf<[AccountingConnection, AccountingPaymentPayload]>();
    expectTypeOf<ReturnType<AccountingProvider['createPayment']>>().toEqualTypeOf<Promise<RemoteRef>>();
    // Money stays a major-unit decimal STRING through the seam (spec §12).
    expectTypeOf<AccountingPaymentPayload['amount']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingPaymentPayload['currencyCode']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingPaymentPayload['privateNote']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingPaymentPayload['reference']>().toEqualTypeOf<string | null>();
  });

  it('deletePayment reports whether the Payment was there, so an already-deleted one is success', () => {
    expectTypeOf<Parameters<AccountingProvider['deletePayment']>>()
      .toEqualTypeOf<[AccountingConnection, AccountingDeletePaymentPayload]>();
    expectTypeOf<ReturnType<AccountingProvider['deletePayment']>>().toEqualTypeOf<Promise<PaymentDeleteResult>>();
    expectTypeOf<AccountingDeletePaymentPayload['syncToken']>().toEqualTypeOf<string | null>();
  });

  it('there is NO updatePayment — the push is create-only (spec decision 9)', () => {
    expectTypeOf<AccountingProvider>().not.toHaveProperty('updatePayment');
  });

  it('a CDC payment line carries the parsed Breeze marker', () => {
    expectTypeOf<ChangeSetPaymentLine['breezePaymentId']>().toEqualTypeOf<string | null>();
  });
});
```

- [ ] **Step 6: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/services/accounting/types.test.ts`
Expected: FAIL — `Property 'createPayment' does not exist on type 'AccountingProvider'` and `Module '"./types"' has no exported member 'AccountingPaymentPayload'`.

- [ ] **Step 7: Implement the types.**

In `apps/api/src/services/accounting/types.ts`, insert after `InvoicePushResult` (`:157`):

```ts
/**
 * One Breeze payment, as sent to the accounting provider (Phase D2).
 *
 * Deliberately carries NO payment-method reference: mapping Breeze's
 * `payment_method` enum onto QuickBooks `PaymentMethod` entities needs a
 * per-realm PaymentMethod list Breeze does not fetch, and a wrong rail on a
 * money row is worse than no rail at all (spec "Out of scope").
 */
export interface AccountingPaymentPayload {
  /** Breeze `invoice_payments.id` — the QBO `requestid` AND the PrivateNote marker. */
  invoicePaymentId: string;
  remoteCustomerId: string;
  remoteInvoiceId: string;
  /** Major-unit decimal string, 2dp. Converted to a JSON number at the wire only. */
  amount: string;
  /** The invoice's STAMPED currency. Asserted equal to the realm home currency
   *  by the coordinator BEFORE this payload is built; never sent as a CurrencyRef. */
  currencyCode: string;
  /** ISO date (YYYY-MM-DD) from `invoice_payments.received_at`. */
  txnDate: string;
  /** `PaymentRefNum` — cheque number, Stripe `pi_…`. Already truncated to QBO's
   *  21-char cap by the coordinator. NEVER an ownership key. */
  reference: string | null;
  /** `Breeze payment <uuid>` (accountingPaymentMarker.ts). The adoption marker. */
  privateNote: string;
}

export interface AccountingDeletePaymentPayload {
  remotePaymentId: string;
  /** The SyncToken Breeze last saw. Null forces the provider to read a fresh one. */
  syncToken: string | null;
}

/** `already_absent` = QuickBooks reports the Payment does not exist. That is
 *  SUCCESS for a delete: the desired end state is already true. */
export type PaymentDeleteResult = 'deleted' | 'already_absent';
```

Add to `ChangeSetPaymentLine` (after `paymentRefNum`, `:181`):

```ts
  /**
   * The Breeze `invoice_payments.id` this QuickBooks Payment claims to be,
   * parsed from `PrivateNote` by `parseBreezePaymentMarker` — null unless the
   * WHOLE note matches. Set on a Payment Breeze itself created; the pull uses
   * it to ADOPT a create whose response was lost (spec decision 3).
   */
  breezePaymentId: string | null;
```

Add to the `AccountingProvider` interface (after `voidInvoice`, `:239`):

```ts
  /**
   * CREATE ONLY — there is deliberately no `updatePayment`. Rewriting a
   * QuickBooks Payment's amount would rewrite receipt history, and Intuit models
   * a refund as a separate transaction; a Breeze partial refund is therefore
   * recorded as a divergence rather than pushed (spec decision 9).
   */
  createPayment(conn: AccountingConnection, payment: AccountingPaymentPayload): Promise<RemoteRef>;
  deletePayment(conn: AccountingConnection, payment: AccountingDeletePaymentPayload): Promise<PaymentDeleteResult>;
```

- [ ] **Step 8: RED — the provider transport tests.**

Append to `apps/api/src/services/accounting/quickbooksProvider.test.ts` (reuse its `conn()` and `jsonResponse()` helpers at `:12-25` and `:57-59`):

```ts
function paymentPayload(overrides: Partial<AccountingPaymentPayload> = {}): AccountingPaymentPayload {
  return {
    invoicePaymentId: '0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    remoteCustomerId: '55', remoteInvoiceId: '145',
    amount: '107.00', currencyCode: 'USD', txnDate: '2026-09-02',
    reference: 'ch_123', privateNote: 'Breeze payment 0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    ...overrides,
  };
}

describe('createPayment', () => {
  it('posts a Payment applied to the invoice, with requestid, PrivateNote and no CurrencyRef', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ Payment: { Id: '181', SyncToken: '0' } }));

    const ref = await quickbooksProvider.createPayment(conn(), paymentPayload());

    expect(ref).toEqual({ id: '181', syncToken: '0' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/v3/company/realm123/payment?minorversion=70');
    // Deterministic per Breeze payment: a network-level retry of a create that
    // actually landed must return the ORIGINAL Payment, not mint a second one.
    expect(String(url)).toContain('requestid=0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      CustomerRef: { value: '55' },
      TotalAmt: 107,
      TxnDate: '2026-09-02',
      PaymentRefNum: 'ch_123',
      PrivateNote: 'Breeze payment 0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
      Line: [{ Amount: 107, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }],
    });
    // Explicitly absent (spec decision 8 + the CurrencyRef rule pushInvoice follows).
    expect(body).not.toHaveProperty('CurrencyRef');
    expect(body).not.toHaveProperty('DepositToAccountRef');
    expect(body).not.toHaveProperty('PaymentMethodRef');
  });

  it('omits PaymentRefNum entirely when there is no reference', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ Payment: { Id: '182', SyncToken: '0' } }));
    await quickbooksProvider.createPayment(conn(), paymentPayload({ reference: null }));
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect('PaymentRefNum' in body).toBe(false);
  });

  it('throws when the response carries no Id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ Payment: {} }));
    await expect(quickbooksProvider.createPayment(conn(), paymentPayload()))
      .rejects.toThrow(/missing an Id/);
  });
});

describe('deletePayment', () => {
  it('posts operation=delete with the known SyncToken', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ Payment: { Id: '181', status: 'Deleted' } }));

    const result = await quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' });

    expect(result).toBe('deleted');
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('payment?operation=delete&minorversion=70');
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)))
      .toEqual({ Id: '181', SyncToken: '3' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('treats an Object Not Found fault as success — the desired end state already holds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ Fault: { Error: [{ code: '610', Message: 'Object Not Found' }] } }),
      { status: 400 },
    ));
    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('already_absent');
  });

  it('re-reads the SyncToken ONCE on a stale-object fault and retries the delete', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }),
        { status: 400 },
      ))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', SyncToken: '7' } }))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', status: 'Deleted' } }));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('deleted');

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[1]![0])).toContain('payment/181?minorversion=70');
    expect(JSON.parse(String((fetchSpy.mock.calls[2]![1] as RequestInit).body)))
      .toEqual({ Id: '181', SyncToken: '7' });
  });

  it('gives up after ONE stale retry so a token war cannot loop', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ Fault: { Error: [{ code: '5010' }] } }), { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', SyncToken: '7' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Fault: { Error: [{ code: '5010' }] } }), { status: 400 }));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('reads a fresh SyncToken first when Breeze holds none', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', SyncToken: '2' } }))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', status: 'Deleted' } }));
    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: null }))
      .resolves.toBe('deleted');
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('payment/181?minorversion=70');
  });
});

describe('mapQboCdcPayment PrivateNote marker', () => {
  it('parses a Breeze-authored note onto the change-set line', async () => {
    const line = mapQboCdcPaymentForTest({
      Id: '181', SyncToken: '0', TxnDate: '2026-09-02', TotalAmt: 107,
      PrivateNote: 'Breeze payment 0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
      Line: [{ Amount: 107, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }],
    }, conn());
    expect(line[0]!.breezePaymentId).toBe('0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b');
  });

  it('leaves breezePaymentId null for an operator-authored note', () => {
    const line = mapQboCdcPaymentForTest({
      Id: '182', SyncToken: '0', TxnDate: '2026-09-02', TotalAmt: 50,
      PrivateNote: 'cheque dropped off at reception',
      Line: [{ Amount: 50, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }],
    }, conn());
    expect(line[0]!.breezePaymentId).toBeNull();
  });
});
```

Add `AccountingPaymentPayload` to the file's `import type` block, and export the CDC mapper for the last two cases by adding `export { mapQboCdcPayment as mapQboCdcPaymentForTest };` — no, instead export `mapQboCdcPayment` itself from `quickbooksProvider.ts` (change `function mapQboCdcPayment` at `:219` to `export function mapQboCdcPayment`) and import it in the test as `mapQboCdcPayment`, renaming the two calls above accordingly. It is already an internal pure mapper alongside the exported `mapQboCustomer`/`mapQboAddress`/`mapQboHomeCurrency`, so exporting it matches the file's existing convention.

- [ ] **Step 9: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/services/accounting/quickbooksProvider.test.ts src/services/accounting/types.test.ts`
Expected: FAIL — `quickbooksProvider.createPayment is not a function`, `deletePayment is not a function`, `breezePaymentId` undefined.

- [ ] **Step 10: Implement the provider methods.**

In `apps/api/src/services/accounting/quickbooksProvider.ts`:

Add `PrivateNote?: string;` to `QboRawCdcPayment` (after `PaymentRefNum`, `:187`), import the marker parser at the top (`import { parseBreezePaymentMarker } from './accountingPaymentMarker';`), export `mapQboCdcPayment`, and add the field to every mapped line (`:227-236`):

```ts
  return invoiceLines.map(({ line, invoiceTxnId }) => ({
    remoteInvoiceId: invoiceTxnId,
    remotePaymentId: raw.Id,
    amountMinor: toMinorUnits(line.Amount ?? 0, currency),
    currency,
    txnDate: raw.TxnDate ?? '',
    remotePaymentSyncToken: raw.SyncToken ?? null,
    paymentMethodName: raw.PaymentMethodRef?.name ?? null,
    paymentRefNum: raw.PaymentRefNum ?? null,
    // Anchored whole-note match only — an operator-authored note that merely
    // mentions a Breeze id must never claim a Breeze payment row.
    breezePaymentId: parseBreezePaymentMarker(raw.PrivateNote),
  }));
```

Add the two methods immediately after `voidInvoice` (`:730`):

```ts
  async createPayment(conn: AccountingConnection, payment: AccountingPaymentPayload): Promise<RemoteRef> {
    // Idempotency key, exactly as pushInvoice's create path uses (`:663-678`):
    // QBO recognizes the same `requestid` for a rolling 24h window and returns
    // the ORIGINAL response rather than creating again, so a retry after a lost
    // response cannot double-book the customer's money. Deterministic per Breeze
    // payment and well under QBO's 50-char cap (a uuid is 36).
    const path = `payment?minorversion=${QBO_API_MINOR_VERSION}`
      + `&requestid=${encodeURIComponent(payment.invoicePaymentId)}`;
    const parsed = await this.qboRequest<{ Payment?: { Id?: string; SyncToken?: string } }>(
      conn,
      path,
      'QuickBooks payment create',
      {
        method: 'POST',
        body: JSON.stringify({
          CustomerRef: { value: payment.remoteCustomerId },
          // Wire-time Number() only — storage stays a major-unit decimal string.
          TotalAmt: Number(payment.amount),
          TxnDate: payment.txnDate,
          ...(payment.reference ? { PaymentRefNum: payment.reference } : {}),
          PrivateNote: payment.privateNote,
          Line: [{
            Amount: Number(payment.amount),
            LinkedTxn: [{ TxnId: payment.remoteInvoiceId, TxnType: 'Invoice' }],
          }],
          // CurrencyRef is deliberately NEVER sent — same rule as pushInvoice
          // (`:650-654`): the coordinator asserted home-currency equality before
          // this method was reached, and sending it to a single-currency realm is
          // a QBO error. DepositToAccountRef is omitted so QuickBooks books the
          // receipt to Undeposited Funds and the bookkeeper records the processor
          // fee at deposit time (spec decision 8). PaymentMethodRef needs a
          // per-realm PaymentMethod list Breeze does not fetch.
        }),
      },
    );
    if (!parsed.Payment?.Id) throw new Error('QuickBooks payment response was missing an Id');
    return { id: parsed.Payment.Id, syncToken: parsed.Payment.SyncToken };
  }

  async deletePayment(
    conn: AccountingConnection,
    payment: AccountingDeletePaymentPayload,
  ): Promise<PaymentDeleteResult> {
    let syncToken = payment.syncToken;
    // No token held (an adoption that never read one) — fetch one before trying.
    if (syncToken === null) {
      const fresh = await this.readPaymentSyncToken(conn, payment.remotePaymentId);
      if (fresh === null) return 'already_absent';
      syncToken = fresh;
    }

    try {
      await this.postPaymentDelete(conn, payment.remotePaymentId, syncToken);
      return 'deleted';
    } catch (err) {
      if (isQboObjectNotFound(err)) return 'already_absent';
      if (!isQboStaleObject(err)) throw err;
      // Stale token means the Payment STILL EXISTS with a newer revision (spec
      // decision 12). Read it once, retry once, then let the error out as
      // retryable — a Payment somebody is editing in a loop must not spin here.
      const fresh = await this.readPaymentSyncToken(conn, payment.remotePaymentId);
      if (fresh === null) return 'already_absent';
      try {
        await this.postPaymentDelete(conn, payment.remotePaymentId, fresh);
        return 'deleted';
      } catch (retryErr) {
        if (isQboObjectNotFound(retryErr)) return 'already_absent';
        throw retryErr;
      }
    }
  }

  /** Current SyncToken for a Payment, or null when QuickBooks says it is gone. */
  private async readPaymentSyncToken(conn: AccountingConnection, remotePaymentId: string): Promise<string | null> {
    try {
      const parsed = await this.qboRequest<{ Payment?: { SyncToken?: string } }>(
        conn,
        `payment/${encodeURIComponent(remotePaymentId)}?minorversion=${QBO_API_MINOR_VERSION}`,
        'QuickBooks payment read',
      );
      return parsed.Payment?.SyncToken ?? null;
    } catch (err) {
      if (isQboObjectNotFound(err)) return null;
      throw err;
    }
  }

  private async postPaymentDelete(conn: AccountingConnection, remotePaymentId: string, syncToken: string): Promise<void> {
    await this.qboRequest(
      conn,
      `payment?operation=delete&minorversion=${QBO_API_MINOR_VERSION}`,
      'QuickBooks payment delete',
      { method: 'POST', body: JSON.stringify({ Id: remotePaymentId, SyncToken: syncToken }) },
    );
  }
```

Then move `paymentMappingRemoteId` out of `apps/api/src/services/accounting/accountingPaymentPull.ts`: delete its body and doc comment (`:146-176`) and replace them with a re-export, so its three existing consumers (`accountingCurrency.ts`'s contract comment, the pull module itself, `accountingPaymentPull.test.ts`) keep resolving it where they already do:

```ts
// The composite at-most-once key moved to the dependency-free marker module in
// Phase D2 so the PUSH coordinator can use it without importing this module —
// invoiceService -> accountingPaymentPush -> accountingPaymentPull ->
// invoiceService would be a real cycle. Re-exported so nothing else has to move.
export { paymentMappingRemoteId } from './accountingPaymentMarker';
```

and add `import { paymentMappingRemoteId } from './accountingPaymentMarker';` to the pull module's own import block (it uses the function internally at `:574`).

And two module-level fault classifiers next to `isDeletedOrVoidedInvoice` (`:239-242`):

```ts
/**
 * `qboRequest` attaches `{ status, body }` (body truncated to 500 chars) to a
 * non-2xx error. Intuit's fault CODES are the stable signal — the Message text
 * is localized and has changed between minor versions — so match the code first
 * and keep the text as a belt-and-braces fallback.
 */
function qboFaultBody(err: unknown): string {
  return err && typeof err === 'object' && typeof (err as { body?: unknown }).body === 'string'
    ? (err as { body: string }).body
    : '';
}

/** QBO fault 610 — the object does not exist (already deleted, or never was). */
function isQboObjectNotFound(err: unknown): boolean {
  const body = qboFaultBody(err);
  return /"code"\s*:\s*"610"/.test(body) || /Object Not Found/i.test(body);
}

/** QBO fault 5010 — the object exists but our SyncToken is behind. */
function isQboStaleObject(err: unknown): boolean {
  const body = qboFaultBody(err);
  return /"code"\s*:\s*"5010"/.test(body) || /Stale Object/i.test(body);
}
```

- [ ] **Step 11: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/services/accounting/quickbooksProvider.test.ts src/services/accounting/types.test.ts src/services/accounting/accountingPaymentMarker.test.ts`
Expected: PASS. The reconcile worker's own tests may now fail to typecheck on `ChangeSetPaymentLine` fixtures — if `accountingReconcileWorker.test.ts` or `accountingPaymentPull.test.ts` construct a full `ChangeSetPaymentLine`, add `breezePaymentId: null` to those fixtures in this step.

- [ ] **Step 12: Widen the call-site gate to four methods.**

In `apps/api/src/services/accounting/accountingInvoicePushCallSites.test.ts`:
- rename the doc comment's subject to "pushInvoice/voidInvoice/createPayment/deletePayment";
- change `ProviderCall['method']` (`:64`) to `'pushInvoice' | 'voidInvoice' | 'createPayment' | 'deletePayment'`;
- replace the pre-filter and matcher (`:70`, `:77-82`) with a list-driven form:

```ts
const GUARDED_METHODS = ['pushInvoice', 'voidInvoice', 'createPayment', 'deletePayment'] as const;
type GuardedMethod = typeof GUARDED_METHODS[number];

function findProviderCalls(absPath: string): ProviderCall[] {
  const source = readFileSync(absPath, 'utf8');
  // Cheap pre-filter; the AST below is the authority.
  if (!GUARDED_METHODS.some((m) => source.includes(`.${m}(`))) return [];
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  const rel = relative(REPO_ROOT, absPath).split('\\').join('/');
  const calls: ProviderCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(sf);
      const method = GUARDED_METHODS.find((m) => text.endsWith(`.${m}`));
      if (method) {
        calls.push({
          file: rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          method,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}
```

- rewrite the second `it` (`:103-110`) as a per-module map so both coordinators are pinned:

```ts
  it('finds each guarded method called exactly once, inside its own coordinator', () => {
    const byModuleAndMethod: Record<string, Record<string, number>> = {};
    for (const call of calls) {
      const forFile = byModuleAndMethod[call.file] ??= {};
      forFile[call.method] = (forFile[call.method] ?? 0) + 1;
    }
    expect(byModuleAndMethod).toEqual({
      'apps/api/src/services/accounting/accountingInvoicePush.ts': { pushInvoice: 1, voidInvoice: 1 },
    });
  });
```

`EXPECTED_CALL_SITES` (`:41-43`) stays `{ 'apps/api/src/services/accounting/accountingInvoicePush.ts': 2 }` for now — the two new call sites do not exist until Task 3, and this step's job is to prove that nothing ELSE in `apps/api/src` or `ee/` already reaches the new transport methods.

- [ ] **Step 13: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingInvoicePushCallSites.test.ts`
Expected: PASS (2 tests) — `createPayment`/`deletePayment` have zero call sites outside the provider's own definitions, which the AST scan does not count (a method DECLARATION is not a call expression).

- [ ] **Step 14: Commit.**

```bash
git add -A && git commit -m "feat(accounting): QuickBooks payment create/delete transport and the Breeze PrivateNote marker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ"
```

---

### Task 3: The push coordinator — request helpers, lease, phase split, fan-out

**Files:**
- Create: `apps/api/src/services/accounting/accountingPaymentPush.ts`
- Create: `apps/api/src/services/accounting/accountingPaymentPush.test.ts`
- Modify: `apps/api/src/services/accounting/accountingPaymentPull.ts:886-916` (DELETE `clearPaymentMappingForInvoicePayment`; its job moves to `requestPaymentDelete`)
- Modify: `apps/api/src/services/accounting/accountingPaymentPull.test.ts` (drop the `clearPaymentMappingForInvoicePayment` cases; they move to the new suite)
- Modify: `apps/api/src/services/accounting/accountingInvoicePushCallSites.test.ts:41-43` (add the coordinator entry), `:103-116` (add its per-method row)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts:191` (one new exemption line after it)

**Interfaces:**
- Consumes: `assertNoAmbientDbContext` / `DbContextRunner` (`dbContextGuard.ts:35,37`), `resolveConnection` (`accountingMappingService.ts:160`), `resolveLiveConnection` (`:193`), `AccountingMappingError` (`:95`), `assertAccountingInvoicePushCurrency` + `AccountingCurrencyContractError` + `normalizeCurrencyCode` (`accountingCurrency.ts:64,31,48`), `paymentMappingRemoteId` + `buildPaymentPrivateNote` (`accountingPaymentMarker.ts`, Task 2), `getAccountingProvider` (`providerRegistry.ts`), `writeAuditEvent` / `requestLikeFromSnapshot` (`services/auditEvents`), `captureException` (`services/sentry`), `db` / `runOutsideDbContext` (`db/index.ts`).
- Produces: every symbol in the **Name glossary** under `accountingPaymentPush.ts`, plus:
```ts
/** Same shape as invoiceService's own DbExecutor: the ambient `db` proxy (which,
 *  inside an open access context, IS the transaction handle) or a drizzle tx handle. */
export type PaymentMappingExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export const PAYMENT_PUSH_DISABLED_MESSAGE = 'Payment push is disabled for this QuickBooks connection';
export function partialRefundDivergenceMessage(amount: string): string;
```

**Two ambiguities in the spec, resolved here (do not relitigate):**

- **Spec decisions 7 and 11 conflict on a mid-flight invoice void.** Decision 7 says phase 2 should convert to a delete when "invoice now void"; decision 11 says an invoice void must NEVER delete a QuickBooks payment, because deleting asserts the cash never arrived. Decision 11 wins — it is the later, argued deviation, and it is the one flagged to Todd. Concretely: **phase 1 refuses a push against an already-void invoice** (terminal `invoice_void`, mapping stamped), and **phase 2 stamps the remote ref normally** if the invoice went void during the QBO round trip. QuickBooks' own void then leaves that Payment unapplied as customer credit, which is exactly the symmetry decision 11 asks for.
- **`payment_gone` is an OUTCOME, not an error code.** Nothing failed and nothing is left undone: the mapping row is either deleted (nothing existed remotely) or flipped to `pending_op = 'delete'`. Throwing a terminal error with no durable row to stamp it on would produce a Sentry event and no operator-visible state.

- [ ] **Step 1: RED — the coordinator test harness and the first failing cases.**

Create `apps/api/src/services/accounting/accountingPaymentPush.test.ts`. The mock idiom is copied verbatim from `accountingPaymentPull.test.ts` (the `vi.hoisted` db quadruple, `ctx.depth` so the REAL `assertNoAmbientDbContext` runs its real logic, and a `runCtx` that emulates ROLLBACK by snapshotting the fixture arrays on entry and restoring them on throw):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  selectMock, insertMock, updateMock, deleteMock,
  resolveConnectionMock, resolveLiveConnectionMock,
  createPaymentMock, deletePaymentMock,
  writeAuditEventMock, captureExceptionMock,
  AccountingMappingError,
} = vi.hoisted(() => {
  class AccountingMappingError extends Error {
    constructor(public readonly code: string, public readonly status: 404 | 409 | 502, message: string) {
      super(message);
      this.name = 'AccountingMappingError';
    }
  }
  return {
    selectMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn(), deleteMock: vi.fn(),
    resolveConnectionMock: vi.fn(), resolveLiveConnectionMock: vi.fn(),
    createPaymentMock: vi.fn(), deletePaymentMock: vi.fn(),
    writeAuditEventMock: vi.fn(), captureExceptionMock: vi.fn(),
    AccountingMappingError,
  };
});

const ctx = vi.hoisted(() => ({ depth: 0, events: [] as string[] }));

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock },
  hasDbAccessContext: () => ctx.depth > 0,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./accountingMappingService', () => ({
  resolveConnection: resolveConnectionMock,
  resolveLiveConnection: resolveLiveConnectionMock,
  AccountingMappingError,
}));
vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => ({ createPayment: createPaymentMock, deletePayment: deletePaymentMock }),
}));
vi.mock('../auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
}));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import { accountingConnections, accountingEntityMappings, invoicePayments, invoices } from '../../db/schema';
import {
  requestPaymentPush, requestPaymentDelete,
  pushPaymentToAccounting, deletePaymentInAccounting, fanOutOwedPayments, listOwedPaymentMappings,
  AccountingPaymentPushError, PAYMENT_CLAIM_LEASE_MS,
} from './accountingPaymentPush';

const PARTNER = 'p1';
const ORG = 'org-a';
const CONN_ID = 'c1';
const INVOICE = 'inv-1';
const PAYMENT = '0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const MAPPING = 'map-pay-1';
const NOW = new Date('2026-09-02T20:00:00.000Z');

interface ConnRow { id: string; partnerId: string; provider: string; status: string; pushMode: string; pushPayments: boolean; homeCurrency: string | null; multiCurrencyEnabled: boolean | null }
interface InvRow { id: string; partnerId: string; orgId: string; status: string; currencyCode: string }
interface PayRow { id: string; invoiceId: string; orgId: string; amount: string; reference: string | null; receivedAt: string }
interface MapRow {
  id: string; integrationId: string; partnerId: string; breezeEntityType: string; breezeEntityId: string;
  remoteEntityType: string; remoteEntityId: string | null; remoteSyncToken: string | null;
  breezeOrigin: boolean; pendingOp: string | null; claimedAt: Date | null;
  linkStatus: string; syncStatus: string; lastError: string | null; updatedAt: Date;
}

let currentConns: ConnRow[] = [];
let currentInvoices: InvRow[] = [];
let currentPayments: PayRow[] = [];
let currentMappings: MapRow[] = [];
const inserted: Array<Record<string, unknown>> = [];
const updates: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
const deletes: Array<unknown> = [];
let snapshots: Array<{ conns: ConnRow[]; invoices: InvRow[]; payments: PayRow[]; mappings: MapRow[] }> = [];
/** Fixture switch: make the next mapping claim CAS match zero rows (lease held). */
let claimLostToRacer = false;

/** Emulates one short self-committing transaction: state written inside a
 *  callback that THROWS is rolled back, which is the whole reason the
 *  coordinator commits its error markers in their own context. */
const runCtx = async <T>(fn: () => Promise<T>): Promise<T> => {
  ctx.depth++;
  ctx.events.push('ctx:enter');
  snapshots.push({
    conns: currentConns.map((r) => ({ ...r })),
    invoices: currentInvoices.map((r) => ({ ...r })),
    payments: currentPayments.map((r) => ({ ...r })),
    mappings: currentMappings.map((r) => ({ ...r })),
  });
  try {
    const result = await fn();
    snapshots.pop();
    return result;
  } catch (err) {
    const snap = snapshots.pop()!;
    currentConns = snap.conns; currentInvoices = snap.invoices;
    currentPayments = snap.payments; currentMappings = snap.mappings;
    throw err;
  } finally {
    ctx.events.push('ctx:exit');
    ctx.depth--;
  }
};

function connRow(o: Partial<ConnRow> = {}): ConnRow {
  return { id: CONN_ID, partnerId: PARTNER, provider: 'quickbooks', status: 'connected', pushMode: 'auto', pushPayments: true, homeCurrency: 'USD', multiCurrencyEnabled: false, ...o };
}
function invRow(o: Partial<InvRow> = {}): InvRow {
  return { id: INVOICE, partnerId: PARTNER, orgId: ORG, status: 'partially_paid', currencyCode: 'USD', ...o };
}
function payRow(o: Partial<PayRow> = {}): PayRow {
  return { id: PAYMENT, invoiceId: INVOICE, orgId: ORG, amount: '107.00', reference: 'ch_123', receivedAt: '2026-09-02', ...o };
}
function invoiceMapRow(o: Partial<MapRow> = {}): MapRow {
  return { id: 'map-inv-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'invoice', breezeEntityId: INVOICE, remoteEntityType: 'Invoice', remoteEntityId: '145', remoteSyncToken: '2', breezeOrigin: true, pendingOp: null, claimedAt: null, linkStatus: 'confirmed', syncStatus: 'synced', lastError: null, updatedAt: NOW, ...o };
}
function orgMapRow(o: Partial<MapRow> = {}): MapRow {
  return { id: 'map-org-1', integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'org', breezeEntityId: ORG, remoteEntityType: 'Customer', remoteEntityId: '55', remoteSyncToken: '0', breezeOrigin: false, pendingOp: null, claimedAt: null, linkStatus: 'confirmed', syncStatus: 'synced', lastError: null, updatedAt: NOW, ...o };
}
function paymentMapRow(o: Partial<MapRow> = {}): MapRow {
  return { id: MAPPING, integrationId: CONN_ID, partnerId: PARTNER, breezeEntityType: 'payment', breezeEntityId: PAYMENT, remoteEntityType: 'Payment', remoteEntityId: null, remoteSyncToken: null, breezeOrigin: true, pendingOp: 'push', claimedAt: null, linkStatus: 'create_new', syncStatus: 'pending', lastError: null, updatedAt: new Date(NOW.getTime() - 5 * 60_000), ...o };
}

/** Walks a REAL compiled drizzle condition (the schema imports above are not
 *  mocked) and answers whether the given value is bound anywhere in it — so the
 *  fixture reader filters on the SAME clause the code actually issued, instead
 *  of a mock that ignores its `where` argument (the vacuous-assertion trap). */
function condHas(node: unknown, value: unknown, seen = new Set<unknown>()): boolean {
  if (node === value) return true;
  if (node && typeof node === 'object') {
    if (seen.has(node)) return false;
    seen.add(node);
    for (const v of Object.values(node as Record<string, unknown>)) if (condHas(v, value, seen)) return true;
  }
  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.depth = 0; ctx.events = []; snapshots = [];
  inserted.length = 0; updates.length = 0; deletes.length = 0;
  claimLostToRacer = false;
  currentConns = [connRow()];
  currentInvoices = [invRow()];
  currentPayments = [payRow()];
  currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow()];

  resolveConnectionMock.mockImplementation(async () => ({ ...currentConns[0], provider: 'quickbooks' }));
  resolveLiveConnectionMock.mockImplementation(async (c: unknown) => ({ ...(c as object), accessToken: 'fresh' }));
  createPaymentMock.mockResolvedValue({ id: '181', syncToken: '0' });
  deletePaymentMock.mockResolvedValue('deleted');

  const rowsFor = (table: unknown, cond: unknown): unknown[] => {
    if (table === accountingConnections) return currentConns.filter((r) => condHas(cond, r.partnerId));
    if (table === invoices) return currentInvoices.filter((r) => condHas(cond, r.id));
    if (table === invoicePayments) {
      return currentPayments.filter((r) => condHas(cond, r.id) || condHas(cond, r.invoiceId));
    }
    if (table === accountingEntityMappings) {
      return currentMappings.filter((r) =>
        (condHas(cond, r.id) || condHas(cond, r.breezeEntityId) || condHas(cond, r.breezeEntityType))
        && condHas(cond, r.partnerId));
    }
    return [];
  };
  const selectable = (table: unknown) => ({
    where: (cond: unknown) => {
      const rows = rowsFor(table, cond);
      const out = Object.assign(Promise.resolve(rows), {
        limit: () => Object.assign(Promise.resolve(rows.slice(0, 1)), { for: () => Promise.resolve(rows.slice(0, 1)) }),
        for: () => Promise.resolve(rows),
      });
      return out;
    },
  });
  selectMock.mockImplementation(() => ({ from: (table: unknown) => selectable(table) }));

  insertMock.mockImplementation((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const finish = () => {
        // The (integration_id, breeze_entity_type, breeze_entity_id) unique index.
        const clash = currentMappings.some((m) =>
          m.integrationId === values.integrationId
          && m.breezeEntityType === values.breezeEntityType
          && m.breezeEntityId === values.breezeEntityId);
        if (clash) return Promise.resolve([]);          // onConflictDoNothing
        const row = { id: `map-new-${currentMappings.length}`, remoteEntityId: null, remoteSyncToken: null, claimedAt: null, lastError: null, updatedAt: NOW, ...values } as MapRow;
        currentMappings.push(row);
        inserted.push({ table, ...values });
        return Promise.resolve([{ id: row.id }]);
      };
      return { onConflictDoNothing: () => ({ returning: finish }), returning: finish };
    },
  }));

  updateMock.mockImplementation((table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: (cond: unknown) => ({
        returning: () => {
          if (table === accountingEntityMappings && claimLostToRacer && 'claimedAt' in patch && patch.claimedAt instanceof Date) {
            claimLostToRacer = false;
            return Promise.resolve([]);                  // the CAS matched nobody
          }
          const rows = rowsFor(table, cond);
          for (const row of rows) Object.assign(row as object, patch);
          updates.push({ table, patch });
          return Promise.resolve(rows.map((r) => ({ id: (r as { id: string }).id })));
        },
      }),
    }),
  }));

  deleteMock.mockImplementation((table: unknown) => ({
    where: (cond: unknown) => ({
      returning: () => {
        const rows = rowsFor(table, cond);
        deletes.push({ table, ids: rows.map((r) => (r as { id: string }).id) });
        if (table === accountingEntityMappings) currentMappings = currentMappings.filter((r) => !rows.includes(r));
        if (table === invoicePayments) currentPayments = currentPayments.filter((r) => !rows.includes(r));
        return Promise.resolve(rows.map((r) => ({ id: (r as { id: string }).id })));
      },
    }),
  }));
});

const mapping = () => currentMappings.find((m) => m.breezeEntityType === 'payment') ?? null;
```

Then the cases:

```ts
describe('requestPaymentPush gating (spec decision 10)', () => {
  it('inserts a pending Breeze-origin push mapping and returns its id', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow()];
    const id = await runCtx(() => requestPaymentPush({ select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock } as never, {
      invoicePaymentId: PAYMENT, invoiceId: INVOICE, partnerId: PARTNER,
    }));
    expect(id).toBeTruthy();
    expect(inserted[0]).toMatchObject({
      integrationId: CONN_ID, partnerId: PARTNER,
      breezeEntityType: 'payment', breezeEntityId: PAYMENT, remoteEntityType: 'Payment',
      breezeOrigin: true, linkStatus: 'create_new', syncStatus: 'pending', pendingOp: 'push',
    });
    expect(inserted[0]!.remoteEntityId ?? null).toBeNull();
  });

  it('returns null when push_payments is off — no row, nothing to enqueue', async () => {
    currentConns = [connRow({ pushPayments: false })];
    currentMappings = [invoiceMapRow(), orgMapRow()];
    await expect(runCtx(() => requestPaymentPush(dbHandle(), { invoicePaymentId: PAYMENT, invoiceId: INVOICE, partnerId: PARTNER })))
      .resolves.toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('returns null in manual push mode — the invoice push fan-out covers it', async () => {
    currentConns = [connRow({ pushMode: 'manual' })];
    currentMappings = [invoiceMapRow(), orgMapRow()];
    await expect(runCtx(() => requestPaymentPush(dbHandle(), { invoicePaymentId: PAYMENT, invoiceId: INVOICE, partnerId: PARTNER })))
      .resolves.toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('returns null when the invoice has no synced remote id yet', async () => {
    currentMappings = [invoiceMapRow({ remoteEntityId: null, syncStatus: 'pending' }), orgMapRow()];
    await expect(runCtx(() => requestPaymentPush(dbHandle(), { invoicePaymentId: PAYMENT, invoiceId: INVOICE, partnerId: PARTNER })))
      .resolves.toBeNull();
  });

  it('accepts an invoice mapping that synced with a tax variance', async () => {
    currentMappings = [invoiceMapRow({ syncStatus: 'synced_with_tax_variance' }), orgMapRow()];
    await expect(runCtx(() => requestPaymentPush(dbHandle(), { invoicePaymentId: PAYMENT, invoiceId: INVOICE, partnerId: PARTNER })))
      .resolves.toBeTruthy();
  });

  it('returns null (never throws) when a racer already claimed the payment mapping', async () => {
    // currentMappings still holds the payment row from beforeEach, so the insert
    // conflicts. A THROW here would abort the caller's payment transaction and
    // undo a payment the operator already recorded.
    await expect(runCtx(() => requestPaymentPush(dbHandle(), { invoicePaymentId: PAYMENT, invoiceId: INVOICE, partnerId: PARTNER })))
      .resolves.toBeNull();
  });
});

describe('requestPaymentDelete (spec: the destroyer-side helper)', () => {
  it('flips a synced Breeze-origin mapping to pending_op=delete and KEEPS the row', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ remoteEntityId: '181/145', remoteSyncToken: '0', pendingOp: null, syncStatus: 'synced', linkStatus: 'confirmed', claimedAt: NOW })];
    await expect(runCtx(() => requestPaymentDelete(dbHandle(), PAYMENT))).resolves.toBe(MAPPING);
    expect(mapping()).toMatchObject({ pendingOp: 'delete', syncStatus: 'pending', claimedAt: null });
    expect(deletes).toHaveLength(0);
  });

  it('DELETES a still-pending push mapping with no remote id — nothing exists in QuickBooks', async () => {
    await expect(runCtx(() => requestPaymentDelete(dbHandle(), PAYMENT))).resolves.toBeNull();
    expect(mapping()).toBeNull();
  });

  it('DELETES a QuickBooks-origin mapping without asking QuickBooks to delete anything', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ breezeOrigin: false, remoteEntityId: '181/145', pendingOp: null, syncStatus: 'synced' })];
    await expect(runCtx(() => requestPaymentDelete(dbHandle(), PAYMENT))).resolves.toBeNull();
    expect(mapping()).toBeNull();
  });

  it('is a no-op for a payment with no mapping at all (the common manual/Stripe case)', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow()];
    await expect(runCtx(() => requestPaymentDelete(dbHandle(), PAYMENT))).resolves.toBeNull();
  });
});

describe('pushPaymentToAccounting', () => {
  it('refuses an ambient DB context', async () => {
    await expect(runCtx(() => pushPaymentToAccounting(MAPPING, PARTNER, runCtx)))
      .rejects.toThrow(/must run with NO ambient DB access context/);
  });

  it('leases, calls QuickBooks with NOTHING held, then stamps the composite remote id', async () => {
    let depthAtProviderCall = -1;
    createPaymentMock.mockImplementationOnce(async () => { depthAtProviderCall = ctx.depth; return { id: '181', syncToken: '0' }; });

    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('pushed');

    expect(depthAtProviderCall).toBe(0);
    expect(ctx.depth).toBe(0);
    expect(createPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh' }),
      {
        invoicePaymentId: PAYMENT, remoteCustomerId: '55', remoteInvoiceId: '145',
        amount: '107.00', currencyCode: 'USD', txnDate: '2026-09-02',
        reference: 'ch_123', privateNote: `Breeze payment ${PAYMENT}`,
      },
    );
    expect(mapping()).toMatchObject({
      remoteEntityId: '181/145', remoteSyncToken: '0',
      syncStatus: 'synced', linkStatus: 'confirmed', pendingOp: null, claimedAt: null,
    });
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.pushed', orgId: ORG, resourceType: 'invoice', resourceId: INVOICE,
    }));
  });

  it('truncates PaymentRefNum to QuickBooks 21-character cap', async () => {
    currentPayments = [payRow({ reference: 'pi_3PabcdefghijklmnopqrstuvwxyZ' })];
    await pushPaymentToAccounting(MAPPING, PARTNER, runCtx);
    expect(createPaymentMock.mock.calls[0]![1].reference).toBe('pi_3Pabcdefghijklmnopq');
    expect(createPaymentMock.mock.calls[0]![1].reference).toHaveLength(21);
  });

  it('is RETRYABLE when another worker holds the lease', async () => {
    claimLostToRacer = true;
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'sync_in_progress', status: 409 });
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('is RETRYABLE, and releases the lease, when the invoice has not synced yet', async () => {
    currentMappings = [invoiceMapRow({ remoteEntityId: null, syncStatus: 'pending' }), orgMapRow(), paymentMapRow()];
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'invoice_not_synced' });
    // Lease released and the work still owed, so the sweep re-enqueues it.
    expect(mapping()).toMatchObject({ pendingOp: 'push', claimedAt: null });
  });

  it('is TERMINAL and stamps the row when push_payments is off', async () => {
    currentConns = [connRow({ pushPayments: false })];
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'push_disabled' });
    expect(mapping()).toMatchObject({
      pendingOp: null, claimedAt: null, syncStatus: 'error',
      lastError: 'Payment push is disabled for this QuickBooks connection',
    });
  });

  it('is TERMINAL on a currency mismatch, BEFORE any QuickBooks call', async () => {
    currentInvoices = [invRow({ currencyCode: 'EUR' })];
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'currency_mismatch' });
    expect(createPaymentMock).not.toHaveBeenCalled();
    expect(resolveLiveConnectionMock).not.toHaveBeenCalled();   // no token refresh for a push that can never land
    expect(mapping()!.syncStatus).toBe('error');
  });

  it('is TERMINAL when the organization is not mapped to a QuickBooks customer', async () => {
    currentMappings = [invoiceMapRow(), paymentMapRow()];
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'customer_not_mapped' });
  });

  it('is TERMINAL against an invoice Breeze already voided (spec decision 11)', async () => {
    currentInvoices = [invRow({ status: 'void' })];
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'invoice_void' });
    expect(createPaymentMock).not.toHaveBeenCalled();
  });

  it('converts to a delete when the payment vanished BEFORE the QuickBooks call', async () => {
    currentPayments = [];
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ remoteEntityId: '181/145', remoteSyncToken: '0' })];
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('converted_to_delete');
    expect(createPaymentMock).not.toHaveBeenCalled();
    expect(mapping()).toMatchObject({ pendingOp: 'delete', claimedAt: null });
  });

  it('reports payment_gone and drops the mapping when nothing exists remotely either', async () => {
    currentPayments = [];
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('payment_gone');
    expect(mapping()).toBeNull();
  });

  it('converts to a delete when the payment vanished DURING the QuickBooks call (spec decision 7)', async () => {
    createPaymentMock.mockImplementationOnce(async () => { currentPayments = []; return { id: '181', syncToken: '0' }; });
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('converted_to_delete');
    // The remote ref is stamped ANYWAY: the delete needs an Id and a SyncToken.
    expect(mapping()).toMatchObject({ remoteEntityId: '181/145', remoteSyncToken: '0', pendingOp: 'delete', claimedAt: null });
  });

  it('keeps the ECHO-stored token when the CDC pull adopted the row first', async () => {
    createPaymentMock.mockImplementationOnce(async () => {
      const m = mapping()!;
      m.remoteEntityId = '181/145'; m.remoteSyncToken = '4'; m.syncStatus = 'synced'; m.pendingOp = null;
      return { id: '181', syncToken: '0' };
    });
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('already_adopted');
    expect(mapping()).toMatchObject({ remoteSyncToken: '4', claimedAt: null });   // NOT overwritten with '0'
  });

  it('records a divergence when a partial refund changed the amount mid-flight (spec decision 9)', async () => {
    createPaymentMock.mockImplementationOnce(async () => { currentPayments = [payRow({ amount: '40.00' })]; return { id: '181', syncToken: '0' }; });
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('diverged');
    expect(mapping()).toMatchObject({
      remoteEntityId: '181/145', syncStatus: 'error', pendingOp: null, claimedAt: null,
      lastError: 'Partially refunded in Stripe (40.00); record the refund in QuickBooks',
    });
    expect(deletePaymentMock).not.toHaveBeenCalled();
  });

  it('sanitizes a QuickBooks failure, COMMITS the marker, keeps pending_op and rethrows 502', async () => {
    createPaymentMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 400, body: '{"Fault":{"Error":[{"Detail":"secret"}]}}' }));
    await expect(pushPaymentToAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'quickbooks_error', status: 502 });
    expect(mapping()).toMatchObject({
      syncStatus: 'error',
      lastError: 'QuickBooks rejected the payment sync (HTTP 400)',
      pendingOp: 'push',      // still owed -> the sweep retries it
      claimedAt: null,        // lease released
    });
    expect(JSON.stringify(mapping())).not.toContain('secret');
  });
});

describe('deletePaymentInAccounting', () => {
  beforeEach(() => {
    currentPayments = [];
    currentMappings = [invoiceMapRow(), orgMapRow(), paymentMapRow({ remoteEntityId: '181/145', remoteSyncToken: '3', pendingOp: 'delete', syncStatus: 'pending' })];
  });

  it('deletes in QuickBooks with nothing held, then removes the mapping row', async () => {
    let depthAtProviderCall = -1;
    deletePaymentMock.mockImplementationOnce(async () => { depthAtProviderCall = ctx.depth; return 'deleted'; });

    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('deleted');

    expect(depthAtProviderCall).toBe(0);
    expect(deletePaymentMock).toHaveBeenCalledWith(expect.anything(), { remotePaymentId: '181', syncToken: '3' });
    expect(mapping()).toBeNull();
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.deleted', orgId: ORG, resourceId: INVOICE,
    }));
  });

  it('propagates a delete even with BOTH switches off — Breeze owns what it created (decision 10)', async () => {
    currentConns = [connRow({ pushPayments: false, pushMode: 'manual' })];
    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('deleted');
  });

  it('treats an already-absent QuickBooks Payment as success and still clears the row', async () => {
    deletePaymentMock.mockResolvedValueOnce('already_absent');
    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('already_absent');
    expect(mapping()).toBeNull();
  });

  it('KEEPS the row, releases the lease and rethrows when QuickBooks fails', async () => {
    deletePaymentMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx))
      .rejects.toMatchObject({ code: 'quickbooks_error' });
    expect(mapping()).toMatchObject({ pendingOp: 'delete', claimedAt: null, lastError: 'QuickBooks rejected the payment sync (HTTP 500)' });
  });

  it('is a no-op when the row no longer owes a delete', async () => {
    currentMappings = [invoiceMapRow(), orgMapRow()];
    await expect(deletePaymentInAccounting(MAPPING, PARTNER, runCtx)).resolves.toBe('nothing_owed');
    expect(deletePaymentMock).not.toHaveBeenCalled();
  });
});

describe('fanOutOwedPayments', () => {
  it('creates a pending push mapping for every unmapped payment and returns their ids', async () => {
    currentPayments = [payRow({ id: PAYMENT }), payRow({ id: 'pay-2', amount: '10.00' })];
    currentMappings = [invoiceMapRow(), orgMapRow()];
    const ids = await fanOutOwedPayments(INVOICE, PARTNER, runCtx);
    expect(ids).toHaveLength(2);
    expect(inserted.every((v) => v.pendingOp === 'push' && v.breezeOrigin === true)).toBe(true);
  });

  it('skips payments that already carry a mapping', async () => {
    currentPayments = [payRow({ id: PAYMENT }), payRow({ id: 'pay-2', amount: '10.00' })];
    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toHaveLength(1);
  });

  it('returns nothing when push_payments is off', async () => {
    currentConns = [connRow({ pushPayments: false })];
    currentMappings = [invoiceMapRow(), orgMapRow()];
    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toEqual([]);
  });

  it('runs in MANUAL push mode — it is the only way payments reach QuickBooks there', async () => {
    currentConns = [connRow({ pushMode: 'manual' })];
    currentMappings = [invoiceMapRow(), orgMapRow()];
    await expect(fanOutOwedPayments(INVOICE, PARTNER, runCtx)).resolves.toHaveLength(1);
  });
});

describe('listOwedPaymentMappings (the sweep query)', () => {
  it('returns rows whose lease has expired and whose update is older than the grace window', async () => {
    currentMappings = [paymentMapRow({ pendingOp: 'push', claimedAt: null, updatedAt: new Date(NOW.getTime() - 5 * 60_000) })];
    await expect(runCtx(() => listOwedPaymentMappings(dbHandle(), NOW)))
      .resolves.toEqual([{ id: MAPPING, partnerId: PARTNER, pendingOp: 'push' }]);
  });
});
```

Add a `dbHandle()` helper next to the fixtures: `const dbHandle = () => ({ select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock } as never);`

- [ ] **Step 2: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingPaymentPush.test.ts`
Expected: FAIL — `Failed to resolve import "./accountingPaymentPush"`.

- [ ] **Step 3: Implement `accountingPaymentPush.ts` — module header, types and helpers.**

```ts
/**
 * The ONE sanctioned entry to `AccountingProvider.createPayment`/`deletePayment`
 * (Phase D2 — docs/superpowers/specs/billing/2026-09-02-quickbooks-phase-d2-payment-push-design.md).
 *
 * THE MAPPING ROW IS THE OUTBOX (spec decision 1). `requestPaymentPush` /
 * `requestPaymentDelete` run INSIDE the caller's already-locked payment
 * transaction and write `pending_op`; the BullMQ enqueue that follows is only a
 * latency optimisation. A lost enqueue — Redis down, the process dying between
 * commit and `add()`, a savepoint not yet committed — is recovered by the
 * 15-minute reconcile sweep, which re-enqueues every stale `pending_op` row. The
 * mapping is NEVER cleared until QuickBooks confirms, so a delete cannot be lost
 * even after BullMQ exhausts its attempts.
 *
 * EXCLUSIVE CLAIM BY LEASE (spec decision 2). A worker claims a row with a
 * compare-and-set — `SET claimed_at = now() WHERE id = ? AND pending_op = ? AND
 * (claimed_at IS NULL OR claimed_at < now() - 10 min)`. Zero rows means somebody
 * else holds it: `sync_in_progress`, retryable. The Phase C upsert idiom is not
 * enough here because it only excludes racing INSERTs, and a payment row can be
 * re-entered by the sweep while a webhook-triggered job is still running.
 *
 * THIS MODULE NEVER TOUCHES REDIS. Every function returns the mapping ids that
 * are owed an enqueue and lets the CALLER do the `add()` after its transaction
 * returns. That keeps BullMQ out of `invoiceService`'s locked transactions, out
 * of this module's unit tests, and out of any code path holding a row lock.
 *
 * DB ACCESS CONTRACT (verbatim from `accountingInvoicePush.ts`, the Phase-C
 * coordinator this module mirrors). `pushPaymentToAccounting` /
 * `deletePaymentInAccounting` MUST be entered with NO ambient DB access context
 * (asserted) and take a `runInDbContext` runner instead. Each DB phase is one
 * SHORT invocation of that runner — a real transaction that commits on its own —
 * and no context is ever open across a QuickBooks call:
 *
 *   Phase 1  lease CAS, connection, payment + invoice, mappings, currency guard,
 *            payload build                                          [COMMITS]
 *   ─ token resolution, then the QBO create/delete — nothing held ─
 *   Phase 2  invoice FOR UPDATE, re-read, stamp / convert / diverge  [COMMITS]
 *
 * The split is load-bearing. Held inside ONE caller-opened transaction, every
 * write that records a FAILURE would be a savepoint that rolls back the instant
 * this coordinator throws: the operator sees no error at all, the lease is never
 * released, and a pooled Postgres connection sits idle-in-transaction across the
 * whole QuickBooks round trip (#1105). Phase 1 exploits the same property in the
 * OTHER direction — a typed refusal that must NOT be recorded simply throws, and
 * the rolled-back transaction un-claims the lease for free; a refusal that MUST
 * be recorded returns a value so its write commits, and the throw happens after
 * the runner returns.
 */

import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import { accountingConnections, accountingEntityMappings, invoicePayments, invoices } from '../../db/schema';
import type { AccountingEntityMapping as AccountingEntityMappingRow } from '../../db/schema';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import { AccountingMappingError, resolveConnection, resolveLiveConnection } from './accountingMappingService';
import { AccountingCurrencyContractError, assertAccountingInvoicePushCurrency, normalizeCurrencyCode } from './accountingCurrency';
// The marker module is a dependency-free LEAF. Importing `accountingPaymentPull`
// here instead would close a cycle: invoiceService -> this module -> pull ->
// invoiceService (pull needs `recomputeInvoiceStatus`).
import { buildPaymentPrivateNote, paymentMappingRemoteId } from './accountingPaymentMarker';
import { getAccountingProvider } from './providerRegistry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../auditEvents';
import { captureException } from '../sentry';
import type { AccountingConnection } from './accountingConnectionService';
import type { AccountingPaymentPayload, RemoteRef } from './types';

/** Worker lease window (spec decision 2). A job that dies mid-flight frees its
 *  claim after this long, and the sweep re-enqueues it. */
export const PAYMENT_CLAIM_LEASE_MS = 10 * 60 * 1000;
/** A row must be at least this stale before the sweep re-enqueues it, so the
 *  sweep never races the immediate enqueue the caller just made. */
export const PAYMENT_SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
/** QuickBooks caps PaymentRefNum at 21 characters and REJECTS a longer one. */
export const PAYMENT_REF_MAX_LENGTH = 21;

export const PAYMENT_PUSH_DISABLED_MESSAGE = 'Payment push is disabled for this QuickBooks connection';

export function partialRefundDivergenceMessage(amount: string): string {
  return `Partially refunded in Stripe (${amount}); record the refund in QuickBooks`;
}

export type AccountingPaymentPushErrorCode =
  | 'not_connected' | 'reauth_required'
  | 'push_disabled'
  | 'sync_in_progress'
  | 'invoice_not_synced'
  | 'invoice_void'
  | 'customer_not_mapped'
  | 'home_currency_unknown' | 'currency_mismatch'
  | 'quickbooks_error'
  | 'record_failed';

export class AccountingPaymentPushError extends Error {
  constructor(
    public readonly code: AccountingPaymentPushErrorCode,
    public readonly status: 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'AccountingPaymentPushError';
  }
}

export type PaymentPushOutcome =
  | 'pushed' | 'already_adopted' | 'converted_to_delete' | 'diverged'
  | 'payment_gone' | 'nothing_owed';
export type PaymentDeleteOutcome = 'deleted' | 'already_absent' | 'nothing_owed';

export type PaymentMappingExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type MappingRow = AccountingEntityMappingRow;
type InvoiceRow = typeof invoices.$inferSelect;
type PaymentRow = typeof invoicePayments.$inferSelect;

const SYNCED_INVOICE_STATUSES = new Set(['synced', 'synced_with_tax_variance']);

function sanitizePaymentSyncErrorMessage(err: unknown): string {
  const status = err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : undefined;
  return status ? `QuickBooks rejected the payment sync (HTTP ${status})` : 'QuickBooks rejected the payment sync';
}

/** `resolveConnection`/`resolveLiveConnection` throw the mapping-service error
 *  hierarchy; only the two codes they can actually raise are re-typed. */
function translateMappingError(err: unknown): never {
  if (err instanceof AccountingMappingError) {
    if (err.code === 'not_connected') throw new AccountingPaymentPushError('not_connected', 404, err.message);
    if (err.code === 'reauth_required') throw new AccountingPaymentPushError('reauth_required', 409, err.message);
    throw new AccountingPaymentPushError('quickbooks_error', err.status as 502, err.message);
  }
  throw err;
}

function translateCurrencyError(err: unknown, conn: AccountingConnection): never {
  if (!(err instanceof AccountingCurrencyContractError)) throw err;
  if (err.code === 'ACCOUNTING_HOME_CURRENCY_UNKNOWN') {
    throw new AccountingPaymentPushError('home_currency_unknown', 409, err.message);
  }
  const home = normalizeCurrencyCode(conn.homeCurrency);
  throw new AccountingPaymentPushError(
    'currency_mismatch', 409,
    `${err.message} Record this payment in ${home ?? 'the connected home currency'} or reconcile it in QuickBooks by hand.`,
  );
}
```

- [ ] **Step 4: Implement the request helpers and the mapping-row primitives.**

```ts
// ---------------------------------------------------------------------------
// Loads + mapping-row primitives (every one partner-scoped at the SQL level:
// RLS is stricter than the app layer, and a missing partner filter here is a
// cross-tenant read waiting for a system-context caller)
// ---------------------------------------------------------------------------

async function loadPaymentMappingByPaymentId(
  tx: PaymentMappingExecutor, invoicePaymentId: string,
): Promise<MappingRow | null> {
  const rows = await tx
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      eq(accountingEntityMappings.breezeEntityId, invoicePaymentId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

async function loadMappingById(mappingId: string, partnerId: string): Promise<MappingRow | null> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

async function loadTypedMapping(
  tx: PaymentMappingExecutor, integrationId: string, partnerId: string,
  breezeEntityType: 'invoice' | 'org', breezeEntityId: string,
): Promise<MappingRow | null> {
  const rows = await tx
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.integrationId, integrationId),
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.breezeEntityType, breezeEntityType),
      eq(accountingEntityMappings.breezeEntityId, breezeEntityId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

/** The partner's connected QuickBooks connection, or null. Read through the
 *  CALLER's handle so it participates in the caller's transaction. */
async function loadConnectedConnection(
  tx: PaymentMappingExecutor, partnerId: string,
): Promise<{ id: string; pushMode: string; pushPayments: boolean } | null> {
  const rows = await tx
    .select({
      id: accountingConnections.id,
      pushMode: accountingConnections.pushMode,
      pushPayments: accountingConnections.pushPayments,
    })
    .from(accountingConnections)
    .where(and(
      eq(accountingConnections.partnerId, partnerId),
      eq(accountingConnections.provider, 'quickbooks'),
      eq(accountingConnections.status, 'connected'),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Inserts the pending Breeze-origin `payment` mapping, or reports that somebody
 * already owns this payment.
 *
 * `onConflictDoNothing`, NOT a caught unique violation: this runs inside the
 * CALLER's payment transaction, and a real 23505 would abort that transaction —
 * undoing an `invoice_payments` row an operator (or Stripe) already committed.
 * Zero rows back means a mapping exists; there is nothing to enqueue.
 */
async function insertPendingPushMapping(
  tx: PaymentMappingExecutor, integrationId: string, partnerId: string, invoicePaymentId: string,
): Promise<string | null> {
  const rows = await tx
    .insert(accountingEntityMappings)
    .values({
      integrationId,
      partnerId,
      breezeEntityType: 'payment',
      breezeEntityId: invoicePaymentId,
      remoteEntityType: 'Payment',
      remoteEntityId: null,
      breezeOrigin: true,
      linkStatus: 'create_new',
      syncStatus: 'pending',
      pendingOp: 'push',
    })
    .onConflictDoNothing({
      target: [
        accountingEntityMappings.integrationId,
        accountingEntityMappings.breezeEntityType,
        accountingEntityMappings.breezeEntityId,
      ],
    })
    .returning({ id: accountingEntityMappings.id });
  return (rows as Array<{ id: string }>)[0]?.id ?? null;
}

async function deleteMappingRow(tx: PaymentMappingExecutor, mappingId: string): Promise<number> {
  const rows = await tx
    .delete(accountingEntityMappings)
    .where(eq(accountingEntityMappings.id, mappingId))
    .returning({ id: accountingEntityMappings.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// requestPaymentPush / requestPaymentDelete — called INSIDE the caller's
// already-locked payment transaction
// ---------------------------------------------------------------------------

/**
 * Record that a freshly-inserted Breeze payment owes QuickBooks a create.
 *
 * Called by `invoiceService.recordPayment` and `stripeReconcile.recordStripePayment`
 * inside their locked transaction, immediately after the `invoice_payments`
 * insert. Returns the mapping id the caller must enqueue a `push-payment` job
 * for once its transaction returns, or `null` when nothing is owed.
 *
 * Manual push mode returns null on purpose: the invoice's own manual "Push to
 * QuickBooks" fans its payments out afterwards (`fanOutOwedPayments`), so an
 * operator who has opted out of automatic pushes does not get automatic ones
 * through the payment door instead.
 *
 * Inside a REQUEST context the caller's transaction is a savepoint, so the
 * worker can start before it commits and see no mapping row at all. That is why
 * "mapping not found" is retryable in the coordinator, never terminal.
 */
export async function requestPaymentPush(
  tx: PaymentMappingExecutor,
  params: { invoicePaymentId: string; invoiceId: string; partnerId: string },
): Promise<string | null> {
  const conn = await loadConnectedConnection(tx, params.partnerId);
  if (!conn || !conn.pushPayments || conn.pushMode !== 'auto') return null;

  const invoiceMapping = await loadTypedMapping(tx, conn.id, params.partnerId, 'invoice', params.invoiceId);
  if (!invoiceMapping?.remoteEntityId) return null;
  if (!SYNCED_INVOICE_STATUSES.has(invoiceMapping.syncStatus)) return null;

  return insertPendingPushMapping(tx, conn.id, params.partnerId, params.invoicePaymentId);
}

/**
 * A Breeze payment row is about to be destroyed — do the right thing with its
 * accounting mapping. The single destroyer-side helper (it REPLACES Phase D's
 * `clearPaymentMappingForInvoicePayment`, which only ever deleted the row).
 *
 * Called by `invoiceService.voidPayment` and `stripeReconcile`'s full-refund
 * branch, BEFORE the `invoice_payments` delete, inside the transaction that
 * already holds the invoice lock. `breeze_entity_id` is polymorphic, so there is
 * no FK to cascade: without this call the mapping outlives its payment and a
 * later CDC delivery for the same QuickBooks Payment reads as "already applied"
 * and silently skips.
 *
 * Three cases:
 *  - Breeze-origin WITH a remote id -> keep the row, flip `pending_op='delete'`.
 *    Breeze created that Payment in QuickBooks, so Breeze owns its removal —
 *    regardless of `push_mode` or `push_payments` (spec decision 10).
 *  - Breeze-origin with NO remote id -> delete the row. Nothing exists in
 *    QuickBooks. If a create is in flight right now, its phase 2 finds the
 *    payment row gone and converts ITSELF to a delete (spec decision 7), so
 *    nothing is stranded.
 *  - QuickBooks-origin -> delete the row, as Phase D always did. The pull's
 *    reversal path owns those; asking QuickBooks to delete its own payment
 *    because Breeze voided a mirror of it would be backwards.
 *
 * Returns the mapping id to enqueue a `delete-payment` job for, or `null`.
 * Zero rows is LEGITIMATE and deliberately not a throw: a manual or Stripe
 * payment usually has no accounting mapping at all.
 */
export async function requestPaymentDelete(
  tx: PaymentMappingExecutor,
  invoicePaymentId: string,
): Promise<string | null> {
  const mapping = await loadPaymentMappingByPaymentId(tx, invoicePaymentId);
  if (!mapping) return null;

  if (!mapping.breezeOrigin || !mapping.remoteEntityId) {
    await deleteMappingRow(tx, mapping.id);
    return null;
  }

  const rows = await tx
    .update(accountingEntityMappings)
    .set({
      pendingOp: 'delete',
      syncStatus: 'pending',
      claimedAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingEntityMappings.id, mapping.id),
      eq(accountingEntityMappings.partnerId, mapping.partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (rows.length !== 1) {
    throw new Error(
      `accountingPaymentPush: delete request matched no accounting_entity_mappings row (id=${mapping.id}); `
      + 'refusing to destroy a Breeze payment whose QuickBooks Payment would then be orphaned',
    );
  }
  return mapping.id;
}
```

- [ ] **Step 5: Implement the lease, the sweep query and the fan-out.**

```ts
// ---------------------------------------------------------------------------
// Lease (spec decision 2)
// ---------------------------------------------------------------------------

/** Compare-and-set claim. Null = somebody else holds it, or nothing is owed. */
async function claimPaymentMapping(
  mappingId: string, partnerId: string, op: 'push' | 'delete', now: Date,
): Promise<MappingRow | null> {
  const leaseCutoff = new Date(now.getTime() - PAYMENT_CLAIM_LEASE_MS);
  const rows = await db
    .update(accountingEntityMappings)
    .set({ claimedAt: now, updatedAt: now })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.pendingOp, op),
      or(
        isNull(accountingEntityMappings.claimedAt),
        lt(accountingEntityMappings.claimedAt, leaseCutoff),
      ),
    ))
    .returning();
  return (rows as MappingRow[])[0] ?? null;
}

/** Release the lease, keeping `pending_op` — the work is still owed. */
async function releaseLease(mappingId: string, partnerId: string): Promise<void> {
  await db
    .update(accountingEntityMappings)
    .set({ claimedAt: null, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
}

/**
 * Stamp a permanent refusal: release the lease, CLEAR `pending_op` (retrying can
 * never succeed) and record why, so the mapping card shows an operator what to
 * fix. Runs inside the caller's phase-1 transaction, which is why phase 1
 * RETURNS a refusal instead of throwing it.
 */
async function markPaymentMappingError(
  mappingId: string, partnerId: string, message: string, opts: { clearPendingOp: boolean },
): Promise<void> {
  await db
    .update(accountingEntityMappings)
    .set({
      syncStatus: 'error',
      lastError: message,
      claimedAt: null,
      ...(opts.clearPendingOp ? { pendingOp: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
}

/** `markPaymentMappingError` in its OWN short, self-committing transaction, and
 *  still best-effort: opening the context can fail (pool exhaustion), and that
 *  must not replace the caller's real typed error with a raw one. Sentry has the
 *  original either way. Mirrors accountingInvoicePush.ts:278-291. */
async function markPaymentMappingErrorInOwnContext(
  runInDbContext: DbContextRunner, mappingId: string, partnerId: string,
  message: string, opts: { clearPendingOp: boolean },
): Promise<void> {
  try {
    await runInDbContext(() => markPaymentMappingError(mappingId, partnerId, message, opts));
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', mappingId, partnerId,
    });
  }
}

// ---------------------------------------------------------------------------
// Sweep query + fan-out
// ---------------------------------------------------------------------------

/**
 * Every mapping row that still owes QuickBooks an operation, is not currently
 * leased, and is old enough that the caller's own immediate enqueue has had
 * time to run.
 *
 * DELIBERATELY connection-agnostic: it does not join `accounting_connections`,
 * because a `delete` must propagate even when both switches are off and even for
 * a connection the reconcile fan-out skipped (spec decision 10). The partial
 * index `accounting_entity_mappings_pending_op_idx` serves it, and the steady
 * state is zero rows.
 */
export async function listOwedPaymentMappings(
  dbc: PaymentMappingExecutor, now: Date,
): Promise<Array<{ id: string; partnerId: string; pendingOp: 'push' | 'delete' }>> {
  const leaseCutoff = new Date(now.getTime() - PAYMENT_CLAIM_LEASE_MS);
  const ageCutoff = new Date(now.getTime() - PAYMENT_SWEEP_MIN_AGE_MS);
  const rows = await dbc
    .select({
      id: accountingEntityMappings.id,
      partnerId: accountingEntityMappings.partnerId,
      pendingOp: accountingEntityMappings.pendingOp,
    })
    .from(accountingEntityMappings)
    .where(and(
      inArray(accountingEntityMappings.pendingOp, ['push', 'delete']),
      or(
        isNull(accountingEntityMappings.claimedAt),
        lt(accountingEntityMappings.claimedAt, leaseCutoff),
      ),
      lt(accountingEntityMappings.updatedAt, ageCutoff),
    ));
  return rows as Array<{ id: string; partnerId: string; pendingOp: 'push' | 'delete' }>;
}

/**
 * After an invoice lands in QuickBooks, give every payment of that invoice a
 * pending push mapping (spec decision 10).
 *
 * Runs in BOTH modes: in `manual` it is the only way payments reach QuickBooks
 * at all, and in `auto` it catches payments recorded while the invoice push was
 * still pending (their `requestPaymentPush` returned null because the invoice
 * had no remote id yet). Returns the mapping ids the caller must enqueue.
 */
export async function fanOutOwedPayments(
  invoiceId: string, partnerId: string, runInDbContext: DbContextRunner,
): Promise<string[]> {
  return runInDbContext(async () => {
    const conn = await loadConnectedConnection(db, partnerId);
    if (!conn || !conn.pushPayments) return [];

    const invoiceMapping = await loadTypedMapping(db, conn.id, partnerId, 'invoice', invoiceId);
    if (!invoiceMapping?.remoteEntityId) return [];
    if (!SYNCED_INVOICE_STATUSES.has(invoiceMapping.syncStatus)) return [];

    const payments = await db
      .select({ id: invoicePayments.id })
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, invoiceId));
    if (payments.length === 0) return [];

    const claimed = await db
      .select({ breezeEntityId: accountingEntityMappings.breezeEntityId })
      .from(accountingEntityMappings)
      .where(and(
        eq(accountingEntityMappings.integrationId, conn.id),
        eq(accountingEntityMappings.partnerId, partnerId),
        eq(accountingEntityMappings.breezeEntityType, 'payment'),
        inArray(accountingEntityMappings.breezeEntityId, payments.map((p) => p.id)),
      ));
    const owned = new Set(claimed.map((r) => r.breezeEntityId));

    const enqueue: string[] = [];
    for (const payment of payments) {
      if (owned.has(payment.id)) continue;
      const mappingId = await insertPendingPushMapping(db, conn.id, partnerId, payment.id);
      if (mappingId) enqueue.push(mappingId);
    }
    return enqueue;
  });
}
```

- [ ] **Step 6: Implement `pushPaymentToAccounting`.**

```ts
type PushPrep =
  | { kind: 'outcome'; outcome: PaymentPushOutcome }
  | { kind: 'refused'; error: AccountingPaymentPushError }
  | {
      kind: 'ready';
      conn: AccountingConnection;
      invoiceId: string;
      orgId: string;
      remoteInvoiceId: string;
      amount: string;
      payload: AccountingPaymentPayload;
    };

export async function pushPaymentToAccounting(
  mappingId: string,
  partnerId: string,
  runInDbContext: DbContextRunner,
): Promise<PaymentPushOutcome> {
  assertNoAmbientDbContext('pushPaymentToAccounting');

  // ---- Phase 1: lease + loads + guards, one short self-committing context ----
  const prep: PushPrep = await runInDbContext(async () => {
    const now = new Date();
    const claimed = await claimPaymentMapping(mappingId, partnerId, 'push', now);
    if (!claimed) {
      const existing = await loadMappingById(mappingId, partnerId);
      if (existing && existing.pendingOp === null) {
        return { kind: 'outcome', outcome: 'nothing_owed' } as const;
      }
      // Either a live lease, or the row is not visible yet because the caller's
      // transaction is still an uncommitted savepoint. Both are retryable, which
      // is why `sync_in_progress` is absent from the worker's terminal set.
      return {
        kind: 'refused',
        error: new AccountingPaymentPushError(
          'sync_in_progress', 409,
          'Another QuickBooks payment sync for this payment is already in flight; it will be retried',
        ),
      } as const;
    }

    // A typed refusal that must NOT be recorded simply THROWS: this whole phase
    // is one transaction, so the throw rolls the lease claim back too.
    const conn = await resolveConnection(partnerId, 'quickbooks').catch(translateMappingError);
    if (!conn.pushPayments) {
      await markPaymentMappingError(mappingId, partnerId, PAYMENT_PUSH_DISABLED_MESSAGE, { clearPendingOp: true });
      return {
        kind: 'refused',
        error: new AccountingPaymentPushError('push_disabled', 409, PAYMENT_PUSH_DISABLED_MESSAGE),
      } as const;
    }

    const payment = await loadPaymentRow(claimed.breezeEntityId);
    if (!payment) {
      // Voided or fully refunded before this job started.
      if (claimed.remoteEntityId) {
        await convertToDelete(mappingId, partnerId);
        return { kind: 'outcome', outcome: 'converted_to_delete' } as const;
      }
      await deleteMappingRow(db, mappingId);
      return { kind: 'outcome', outcome: 'payment_gone' } as const;
    }

    const invoice = await loadOwnedInvoice(payment.invoiceId, partnerId);
    if (!invoice) {
      await deleteMappingRow(db, mappingId);
      return { kind: 'outcome', outcome: 'payment_gone' } as const;
    }
    if (invoice.status === 'void') {
      // Spec decision 11: a void never DELETES a QuickBooks payment, and it must
      // not create one either — QuickBooks refuses to apply a Payment to a void
      // Invoice, and asserting cash against a document the operator voided is
      // exactly the divergence decision 11 exists to prevent.
      const message = 'Invoice was voided in Breeze; QuickBooks payments are not pushed to a void invoice';
      await markPaymentMappingError(mappingId, partnerId, message, { clearPendingOp: true });
      return { kind: 'refused', error: new AccountingPaymentPushError('invoice_void', 409, message) } as const;
    }

    const invoiceMapping = await loadTypedMapping(db, conn.id, partnerId, 'invoice', invoice.id);
    if (!invoiceMapping?.remoteEntityId || !SYNCED_INVOICE_STATUSES.has(invoiceMapping.syncStatus)) {
      // RETRYABLE: the invoice push may still be in flight, and its own fan-out
      // will re-enqueue this payment when it lands. Release the lease so the
      // sweep can pick the row up, and keep `pending_op`.
      await releaseLease(mappingId, partnerId);
      return {
        kind: 'refused',
        error: new AccountingPaymentPushError(
          'invoice_not_synced', 409,
          'The invoice has not finished syncing to QuickBooks yet; the payment push will be retried',
        ),
      } as const;
    }

    const orgMapping = await loadTypedMapping(db, conn.id, partnerId, 'org', invoice.orgId);
    if (!orgMapping?.remoteEntityId || orgMapping.linkStatus === 'unlinked' || orgMapping.linkStatus === 'suggested') {
      const message = 'This organization is not mapped to a QuickBooks customer yet — confirm or create a mapping first';
      await markPaymentMappingError(mappingId, partnerId, message, { clearPendingOp: true });
      return { kind: 'refused', error: new AccountingPaymentPushError('customer_not_mapped', 409, message) } as const;
    }

    // Currency guard BEFORE any token refresh or network call (spec decision 13,
    // multi-currency §11 contract at accountingCurrency.ts:143-201).
    try {
      assertAccountingInvoicePushCurrency(conn, { currencyCode: invoice.currencyCode });
    } catch (err) {
      let typed: AccountingPaymentPushError;
      try { translateCurrencyError(err, conn); } catch (e) { typed = e as AccountingPaymentPushError; }
      await markPaymentMappingError(mappingId, partnerId, typed!.message, { clearPendingOp: true });
      return { kind: 'refused', error: typed! } as const;
    }

    return {
      kind: 'ready',
      conn,
      invoiceId: invoice.id,
      orgId: invoice.orgId,
      remoteInvoiceId: invoiceMapping.remoteEntityId,
      amount: payment.amount,
      payload: {
        invoicePaymentId: payment.id,
        remoteCustomerId: orgMapping.remoteEntityId,
        remoteInvoiceId: invoiceMapping.remoteEntityId,
        amount: payment.amount,
        currencyCode: invoice.currencyCode,
        txnDate: payment.receivedAt,
        // QuickBooks REJECTS a PaymentRefNum over 21 chars, and a Stripe
        // payment_intent id is 27. Truncation is safe because this field is
        // human reference only — ownership lives in PrivateNote (decision 3).
        reference: payment.reference ? payment.reference.slice(0, PAYMENT_REF_MAX_LENGTH) : null,
        privateNote: buildPaymentPrivateNote(payment.id),
      },
    } as const;
  });

  if (prep.kind === 'outcome') return prep.outcome;
  if (prep.kind === 'refused') throw prep.error;

  // ---- Token refresh, then QuickBooks, with NOTHING held ----
  const liveConn = await resolveLiveConnection(prep.conn).catch(translateMappingError);
  const provider = getAccountingProvider(prep.conn.provider);

  let ref: RemoteRef;
  try {
    ref = await runOutsideDbContext(() => provider.createPayment(liveConn, prep.payload));
  } catch (err) {
    const message = sanitizePaymentSyncErrorMessage(err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', mappingId, invoicePaymentId: prep.payload.invoicePaymentId,
    });
    // Own short context so the marker COMMITS before the throw. `pending_op` is
    // KEPT: the work is still owed and the sweep must retry it.
    await markPaymentMappingErrorInOwnContext(runInDbContext, mappingId, partnerId, message, { clearPendingOp: false });
    throw new AccountingPaymentPushError('quickbooks_error', 502, message);
  }

  // ---- Phase 2: invoice FOR UPDATE first, then re-read everything ----
  let outcome: PaymentPushOutcome;
  let audit: { orgId: string; invoiceId: string; details: Record<string, unknown> } | null = null;
  try {
    const phase2 = await runInDbContext(async () => {
      await lockOwnedInvoice(prep.invoiceId, partnerId);

      const mapping = await loadMappingById(mappingId, partnerId);
      if (!mapping) {
        throw new Error(
          `accountingPaymentPush: mapping ${mappingId} vanished between the QuickBooks create and phase 2 `
          + `(remote payment ${ref.id}); refusing to lose the QuickBooks sync result`,
        );
      }
      const remoteEntityId = paymentMappingRemoteId(ref.id, prep.remoteInvoiceId);

      // The echo won the race: the CDC pull adopted this row and stored a token
      // that is at least as new as ours. Keep ITS token; just release the lease.
      if (mapping.remoteEntityId === remoteEntityId) {
        await releaseLease(mappingId, partnerId);
        return { outcome: 'already_adopted' as const, audit: null };
      }

      const payment = await loadPaymentRow(mapping.breezeEntityId);
      if (!payment) {
        // Voided or fully refunded during the round trip. Stamp the ref anyway —
        // the delete needs an Id and a SyncToken — then flip to delete.
        await stampRemoteRef(mappingId, partnerId, remoteEntityId, ref.syncToken ?? null, {
          syncStatus: 'pending', linkStatus: 'confirmed', pendingOp: 'delete', lastError: null,
        });
        return { outcome: 'converted_to_delete' as const, audit: null };
      }

      if (payment.amount !== prep.amount) {
        // A partial refund reduced the amount mid-flight. Rewriting a QuickBooks
        // Payment's amount would rewrite receipt history (spec decision 9), so
        // record the divergence and leave the Payment exactly as created.
        const message = partialRefundDivergenceMessage(payment.amount);
        await stampRemoteRef(mappingId, partnerId, remoteEntityId, ref.syncToken ?? null, {
          syncStatus: 'error', linkStatus: 'confirmed', pendingOp: null, lastError: message,
        });
        return { outcome: 'diverged' as const, audit: null };
      }

      await stampRemoteRef(mappingId, partnerId, remoteEntityId, ref.syncToken ?? null, {
        syncStatus: 'synced', linkStatus: 'confirmed', pendingOp: null, lastError: null, stampSyncedAt: true,
      });
      return {
        outcome: 'pushed' as const,
        audit: {
          orgId: prep.orgId,
          invoiceId: prep.invoiceId,
          details: {
            invoicePaymentId: payment.id,
            remotePaymentId: ref.id,
            remoteInvoiceId: prep.remoteInvoiceId,
            amount: payment.amount,
            currency: prep.payload.currencyCode,
          },
        },
      };
    });
    outcome = phase2.outcome;
    audit = phase2.audit;
  } catch (dbErr) {
    captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)), undefined, {
      service: 'accountingPaymentPush', mappingId, remotePaymentId: ref.id,
    });
    const message = `QuickBooks accepted the payment (remote id ${ref.id}) but Breeze failed to record it — do not retry; contact support to reconcile`;
    // `pending_op` CLEARED: a retry would create a SECOND QuickBooks Payment for
    // money that only moved once. The CDC echo will adopt the orphan instead.
    await markPaymentMappingErrorInOwnContext(runInDbContext, mappingId, partnerId, message, { clearPendingOp: true });
    throw new AccountingPaymentPushError('record_failed', 502, message);
  }

  if (audit) {
    fireAudit(prep.conn, 'accounting.payment.pushed', audit.orgId, audit.invoiceId, audit.details);
  }
  return outcome;
}
```

with these remaining private helpers:

```ts
async function loadPaymentRow(invoicePaymentId: string): Promise<PaymentRow | null> {
  const rows = await db.select().from(invoicePayments).where(eq(invoicePayments.id, invoicePaymentId)).limit(1);
  return (rows as PaymentRow[])[0] ?? null;
}

/** The invoice row, LOCKED. Partner-guarded: a mapping can outlive an erased org. */
async function lockOwnedInvoice(invoiceId: string, partnerId: string): Promise<InvoiceRow | null> {
  const rows = await db
    .select().from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.partnerId, partnerId)))
    .limit(1).for('update');
  return (rows as InvoiceRow[])[0] ?? null;
}

async function loadOwnedInvoice(invoiceId: string, partnerId: string): Promise<InvoiceRow | null> {
  const rows = await db
    .select().from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.partnerId, partnerId)))
    .limit(1);
  return (rows as InvoiceRow[])[0] ?? null;
}

async function convertToDelete(mappingId: string, partnerId: string): Promise<void> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({ pendingOp: 'delete', syncStatus: 'pending', claimedAt: null, updatedAt: new Date() })
    .where(and(eq(accountingEntityMappings.id, mappingId), eq(accountingEntityMappings.partnerId, partnerId)))
    .returning({ id: accountingEntityMappings.id });
  if (rows.length !== 1) {
    throw new Error(`accountingPaymentPush: converting mapping ${mappingId} to a delete matched no row`);
  }
}

async function stampRemoteRef(
  mappingId: string, partnerId: string, remoteEntityId: string, remoteSyncToken: string | null,
  state: {
    syncStatus: 'pending' | 'synced' | 'error';
    linkStatus: 'confirmed';
    pendingOp: 'delete' | null;
    lastError: string | null;
    stampSyncedAt?: boolean;
  },
): Promise<void> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({
      remoteEntityId,
      remoteSyncToken,
      linkStatus: state.linkStatus,
      syncStatus: state.syncStatus,
      pendingOp: state.pendingOp,
      claimedAt: null,
      lastError: state.lastError,
      ...(state.stampSyncedAt ? { lastSyncedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(accountingEntityMappings.id, mappingId), eq(accountingEntityMappings.partnerId, partnerId)))
    .returning({ id: accountingEntityMappings.id });
  if (rows.length !== 1) {
    throw new Error(
      `accountingPaymentPush: stamping the remote ref matched no accounting_entity_mappings row (id=${mappingId}); `
      + 'refusing to lose the QuickBooks payment result',
    );
  }
}

/** Off-request path (worker): the system-scope audit writer, never
 *  writeRouteAudit. Never lets an audit failure undo committed money state. */
function fireAudit(
  conn: AccountingConnection,
  action: 'accounting.payment.pushed' | 'accounting.payment.deleted',
  orgId: string, invoiceId: string, details: Record<string, unknown>,
): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId,
      action,
      resourceType: 'invoice',
      resourceId: invoiceId,
      actorType: 'system',
      actorId: null,
      result: 'success',
      details: { provider: conn.provider, ...details },
    });
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', action, resourceId: invoiceId,
    });
  }
}
```

- [ ] **Step 7: Implement `deletePaymentInAccounting`.**

```ts
/**
 * Remove from QuickBooks a Payment Breeze created there.
 *
 * Runs regardless of `push_mode` AND `push_payments` (spec decision 10): once
 * Breeze created a Payment in QuickBooks it owns its removal, and switching the
 * feature off must not strand money in the books that Breeze no longer records.
 */
export async function deletePaymentInAccounting(
  mappingId: string,
  partnerId: string,
  runInDbContext: DbContextRunner,
): Promise<PaymentDeleteOutcome> {
  assertNoAmbientDbContext('deletePaymentInAccounting');

  const prep = await runInDbContext(async () => {
    const now = new Date();
    const claimed = await claimPaymentMapping(mappingId, partnerId, 'delete', now);
    if (!claimed) {
      const existing = await loadMappingById(mappingId, partnerId);
      if (!existing || existing.pendingOp !== 'delete') {
        return { kind: 'outcome', outcome: 'nothing_owed' } as const;
      }
      return {
        kind: 'refused',
        error: new AccountingPaymentPushError(
          'sync_in_progress', 409,
          'Another QuickBooks payment delete for this payment is already in flight; it will be retried',
        ),
      } as const;
    }

    if (!claimed.remoteEntityId) {
      // Nothing exists in QuickBooks. Drop the row; there is nothing to call.
      await deleteMappingRow(db, mappingId);
      return { kind: 'outcome', outcome: 'already_absent' } as const;
    }

    const conn = await resolveConnection(partnerId, 'quickbooks').catch(translateMappingError);

    // `<PaymentId>/<remoteInvoiceId>` (paymentMappingRemoteId). Split on the
    // FIRST separator only: QBO ids are numeric, but the invoice half is opaque.
    const separator = claimed.remoteEntityId.indexOf('/');
    const remotePaymentId = separator === -1 ? claimed.remoteEntityId : claimed.remoteEntityId.slice(0, separator);
    const remoteInvoiceId = separator === -1 ? null : claimed.remoteEntityId.slice(separator + 1);

    // Audit context: the payment row is already gone, so the org comes from the
    // invoice this Payment settled. Absent context downgrades to a log, never a
    // failure — the delete itself is what matters.
    let orgId: string | null = null;
    let invoiceId: string | null = null;
    if (remoteInvoiceId) {
      const invoiceMapping = await loadRemoteInvoiceMapping(conn.id, partnerId, remoteInvoiceId);
      if (invoiceMapping) {
        const invoice = await loadOwnedInvoice(invoiceMapping.breezeEntityId, partnerId);
        if (invoice) { orgId = invoice.orgId; invoiceId = invoice.id; }
      }
    }

    return {
      kind: 'ready',
      conn,
      remotePaymentId,
      remoteInvoiceId,
      syncToken: claimed.remoteSyncToken ?? null,
      invoicePaymentId: claimed.breezeEntityId,
      orgId,
      invoiceId,
    } as const;
  });

  if (prep.kind === 'outcome') return prep.outcome;
  if (prep.kind === 'refused') throw prep.error;

  const liveConn = await resolveLiveConnection(prep.conn).catch(translateMappingError);
  const provider = getAccountingProvider(prep.conn.provider);

  let result: PaymentDeleteResult;
  try {
    result = await runOutsideDbContext(() => provider.deletePayment(liveConn, {
      remotePaymentId: prep.remotePaymentId,
      syncToken: prep.syncToken,
    }));
  } catch (err) {
    const message = sanitizePaymentSyncErrorMessage(err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', mappingId, remotePaymentId: prep.remotePaymentId,
    });
    // `pending_op` KEPT: the mapping is never cleared until QuickBooks confirms,
    // which is what makes a delete survive Redis failure and exhausted retries.
    await markPaymentMappingErrorInOwnContext(runInDbContext, mappingId, partnerId, message, { clearPendingOp: false });
    throw new AccountingPaymentPushError('quickbooks_error', 502, message);
  }

  await runInDbContext(async () => {
    const removed = await deleteMappingRow(db, mappingId);
    if (removed !== 1) {
      throw new Error(`accountingPaymentPush: payment mapping delete matched no row (id=${mappingId})`);
    }
  });

  if (prep.orgId && prep.invoiceId) {
    fireAudit(prep.conn, 'accounting.payment.deleted', prep.orgId, prep.invoiceId, {
      invoicePaymentId: prep.invoicePaymentId,
      remotePaymentId: prep.remotePaymentId,
      remoteInvoiceId: prep.remoteInvoiceId,
      result,
    });
  } else {
    console.warn(
      '[accountingPaymentPush] deleted a QuickBooks payment with no resolvable Breeze invoice for the audit trail',
      `mappingId=${mappingId}`, `remotePaymentId=${prep.remotePaymentId}`,
    );
  }
  return result;
}

async function loadRemoteInvoiceMapping(
  integrationId: string, partnerId: string, remoteInvoiceId: string,
): Promise<MappingRow | null> {
  const rows = await db
    .select().from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.integrationId, integrationId),
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'invoice'),
      eq(accountingEntityMappings.remoteEntityId, remoteInvoiceId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}
```

Add `PaymentDeleteResult` to the `import type ... from './types'` list.

- [ ] **Step 8: Retire `clearPaymentMappingForInvoicePayment`.**

Delete the function and its doc comment from `apps/api/src/services/accounting/accountingPaymentPull.ts:886-916`, and delete the now-orphan section header. Its responsibility — "a Breeze payment row is being destroyed; do the right thing with its mapping" — now belongs to `requestPaymentDelete`, which does strictly more (Phase D only ever deleted; D2 must keep a Breeze-origin row alive until QuickBooks confirms). Remove the corresponding `describe('clearPaymentMappingForInvoicePayment', …)` block from `accountingPaymentPull.test.ts` — the equivalent cases now live in `accountingPaymentPush.test.ts`'s `requestPaymentDelete` suite. Task 5 repoints the two production call sites; until then `pnpm build` will flag them, which is the intended red.

- [ ] **Step 9: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingPaymentPush.test.ts src/services/accounting/accountingPaymentPull.test.ts`
Expected: PASS for `accountingPaymentPush.test.ts` (all cases). `accountingPaymentPull.test.ts` passes once the removed suite is gone.

- [ ] **Step 10: Close the call-site gate on the new coordinator.**

In `apps/api/src/services/accounting/accountingInvoicePushCallSites.test.ts`, add to `EXPECTED_CALL_SITES` (`:41-43`):

```ts
const EXPECTED_CALL_SITES: Record<string, number> = {
  'apps/api/src/services/accounting/accountingInvoicePush.ts': 2,       // one pushInvoice, one voidInvoice
  'apps/api/src/services/accounting/accountingPaymentPush.ts': 2,       // one createPayment, one deletePayment
};
```

and to the per-method expectation:

```ts
    expect(byModuleAndMethod).toEqual({
      'apps/api/src/services/accounting/accountingInvoicePush.ts': { pushInvoice: 1, voidInvoice: 1 },
      'apps/api/src/services/accounting/accountingPaymentPush.ts': { createPayment: 1, deletePayment: 1 },
    });
```

- [ ] **Step 11: Register the partner-wide-write exemption.**

In `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, immediately after the `accountingPaymentPull.ts` line (`:191`):

```ts
  'services/accounting/accountingPaymentPush.ts': 'worker-driven outbound half of the same accounting_entity_mappings rows as accountingPaymentPull.ts above; there is no tenant caller to gate — the request helpers run inside invoiceService/stripeReconcile transactions that are already gated, the coordinator runs under system context from the accounting-sync worker, and every write carries the connection\'s (integration_id, partner_id) enforced by the composite FK',
```

- [ ] **Step 12: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingInvoicePushCallSites.test.ts src/__tests__/partner-wide-write-coverage.test.ts`
Expected: PASS.

- [ ] **Step 13: Commit.**

```bash
git add -A && git commit -m "feat(accounting): payment push coordinator with mapping-row outbox and worker lease

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ"
```

---

### Task 4: Workers — payment job types, enqueue helpers, reconcile gating and the stale-`pending_op` sweep

**Files:**
- Modify: `apps/api/src/jobs/accountingSyncWorker.ts:1-37` (header), `:54-64` (job union), `:66-83` (terminal codes), `:112-148` (handler), `:194-226` (enqueue helpers)
- Modify: `apps/api/src/jobs/accountingSyncWorker.test.ts` (extend)
- Modify: `apps/api/src/jobs/accountingReconcileWorker.ts:98-122` (summary), `:141-176` (empty/tally), `:195-214` (log line), `:230-239` (gate), `:380-397` (sweep)
- Modify: `apps/api/src/jobs/accountingReconcileWorker.test.ts` (extend)

**Interfaces:**
- Consumes: `pushPaymentToAccounting`, `deletePaymentInAccounting`, `listOwedPaymentMappings`, `AccountingPaymentPushError`, `AccountingPaymentPushErrorCode`, `PaymentPushOutcome` (Task 3); `listReconcilableConnections` (Task 1, widened predicate).
- Produces:
```ts
// accountingSyncWorker.ts
interface PushPaymentJobData   { type: 'push-payment';   mappingId: string; partnerId: string }
interface DeletePaymentJobData { type: 'delete-payment'; mappingId: string; partnerId: string }
export type AccountingSyncJobData =
  PushInvoiceJobData | VoidInvoiceJobData | PushPaymentJobData | DeletePaymentJobData;
export async function enqueueAccountingPaymentPush(mappingId: string, partnerId: string): Promise<boolean>;
export async function enqueueAccountingPaymentDelete(mappingId: string, partnerId: string): Promise<boolean>;

// accountingReconcileWorker.ts — ReconcileRunSummary gains:
//   pendingOpsSwept: number
// and processReconcileSweep's return gains the same counter:
export async function processReconcileSweep(): Promise<{ enqueued: number; failed: number; pendingOpsEnqueued: number; pendingOpsFailed: number }>;
```

- [ ] **Step 1: RED — sync-worker tests.**

Append to `apps/api/src/jobs/accountingSyncWorker.test.ts` (its harness at `:1-57` already mocks bullmq, redis, `../db`, `getConnection` and the invoice coordinator — add one more coordinator mock alongside them):

```ts
const { pushPaymentMock, deletePaymentMock } = vi.hoisted(() => ({
  pushPaymentMock: vi.fn(), deletePaymentMock: vi.fn(),
}));
// The REAL AccountingPaymentPushError class is kept so the worker's
// instanceof/terminal branch exercises the real taxonomy.
vi.mock('../services/accounting/accountingPaymentPush', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/accounting/accountingPaymentPush')>();
  return { ...actual, pushPaymentToAccounting: pushPaymentMock, deletePaymentInAccounting: deletePaymentMock };
});

const MAPPING_ID = '33333333-3333-3333-3333-333333333333';

describe('payment jobs', () => {
  beforeEach(() => {
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pushMode: 'auto', pullPayments: true, pushPayments: true });
    pushPaymentMock.mockResolvedValue('pushed');
    deletePaymentMock.mockResolvedValue('deleted');
  });

  it('runs a push-payment job through the coordinator with a SYSTEM runner and no ambient context', async () => {
    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(runOutsideDbContextMock).toHaveBeenCalled();
    expect(pushPaymentMock).toHaveBeenCalledWith(MAPPING_ID, PARTNER_ID, expect.any(Function));
  });

  it('does NOT apply the pushMode gate to payment jobs — the coordinator owns that', async () => {
    // The pushMode gate exists for push-invoice only. requestPaymentPush already
    // refused to create the mapping in manual mode, so a payment job that EXISTS
    // in manual mode came from the manual fan-out and must run.
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pushMode: 'manual', pushPayments: true });
    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(pushPaymentMock).toHaveBeenCalled();
  });

  it('enqueues the follow-up delete when a push converted itself to one', async () => {
    pushPaymentMock.mockResolvedValueOnce('converted_to_delete');
    await processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(queueAddMock).toHaveBeenCalledWith(
      'delete-payment',
      { type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID },
      expect.objectContaining({ jobId: `accounting-payment-${MAPPING_ID}-delete` }),
    );
  });

  it('runs a delete-payment job even when the connection has both switches off', async () => {
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pushMode: 'manual', pushPayments: false });
    await processAccountingSyncJob({ type: 'delete-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID });
    expect(deletePaymentMock).toHaveBeenCalledWith(MAPPING_ID, PARTNER_ID, expect.any(Function));
  });

  it.each<AccountingPaymentPushErrorCode>([
    'push_disabled', 'customer_not_mapped', 'currency_mismatch', 'home_currency_unknown',
    'invoice_void', 'record_failed', 'not_connected', 'reauth_required',
  ])('treats %s as TERMINAL — logged, not rethrown', async (code) => {
    pushPaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError(code, 409, 'nope'));
    await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
      .resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it.each<AccountingPaymentPushErrorCode>(['quickbooks_error', 'sync_in_progress', 'invoice_not_synced'])(
    'rethrows %s so BullMQ retries', async (code) => {
      pushPaymentMock.mockRejectedValueOnce(new AccountingPaymentPushError(code, 502, 'later'));
      await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: MAPPING_ID, partnerId: PARTNER_ID }))
        .rejects.toThrow('later');
    });

  it('uses per-operation jobIds so a delete is never swallowed by a live push job', async () => {
    await enqueueAccountingPaymentPush(MAPPING_ID, PARTNER_ID);
    await enqueueAccountingPaymentDelete(MAPPING_ID, PARTNER_ID);
    const ids = queueAddMock.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(ids).toEqual([`accounting-payment-${MAPPING_ID}-push`, `accounting-payment-${MAPPING_ID}-delete`]);
    expect(ids.every((id) => !id.includes(':'))).toBe(true);
    expect(queueAddMock.mock.calls[0]![2]).toEqual({
      jobId: `accounting-payment-${MAPPING_ID}-push`,
      attempts: 5, backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true, removeOnFail: true,
    });
  });

  it('swallows a Redis outage into false rather than failing the caller', async () => {
    queueAddMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(enqueueAccountingPaymentPush(MAPPING_ID, PARTNER_ID)).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});
```

Add `enqueueAccountingPaymentPush`, `enqueueAccountingPaymentDelete` to the import at `:52-56`, and `AccountingPaymentPushError`, `type AccountingPaymentPushErrorCode` from `'../services/accounting/accountingPaymentPush'`.

- [ ] **Step 2: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/jobs/accountingSyncWorker.test.ts`
Expected: FAIL — `enqueueAccountingPaymentPush is not a function`, and `processAccountingSyncJob` ignores the two new job types.

- [ ] **Step 3: Implement the sync worker changes.**

In `apps/api/src/jobs/accountingSyncWorker.ts`:

Extend the job union (`:54-64`):

```ts
interface PushPaymentJobData {
  type: 'push-payment';
  /** accounting_entity_mappings.id — the outbox row, NOT the invoice_payments id.
   *  The mapping is the durable record of what is owed; the job is a nudge. */
  mappingId: string;
  partnerId: string;
}
interface DeletePaymentJobData {
  type: 'delete-payment';
  mappingId: string;
  partnerId: string;
}
export type AccountingSyncJobData =
  PushInvoiceJobData | VoidInvoiceJobData | PushPaymentJobData | DeletePaymentJobData;
```

Add the payment terminal set next to `TERMINAL_CODES` (`:73-83`):

```ts
/**
 * Terminal for a PAYMENT job. Same rule as the invoice set above — retrying can
 * never fix a permanent configuration problem, and the mapping row already
 * carries the reason for an operator. `record_failed` is terminal for the
 * stronger reason: the QuickBooks Payment already exists, so a retry would
 * create a SECOND one for money that moved once. `quickbooks_error`,
 * `sync_in_progress` and `invoice_not_synced` are the retryable trio.
 */
const PAYMENT_TERMINAL_CODES: ReadonlySet<AccountingPaymentPushErrorCode> = new Set([
  'push_disabled',
  'customer_not_mapped',
  'home_currency_unknown',
  'currency_mismatch',
  'invoice_void',
  'record_failed',
  'not_connected',
  'reauth_required',
]);
```

Replace the handler body (`:112-148`) so the two families are dispatched separately:

```ts
export async function processAccountingSyncJob(data: AccountingSyncJobData): Promise<void> {
  await runOutsideDbContext(async () => {
    const runInDbContext = <T>(fn: () => Promise<T>): Promise<T> =>
      withSystemDbAccessContext(fn, `accountingSync.${data.type}`);

    const conn = await runInDbContext(() => getConnection(db, data.partnerId, 'quickbooks'));
    if (!conn || conn.status !== 'connected') return;
    // The pushMode gate applies to push-invoice ONLY. A payment job that exists
    // at all was authorised when its mapping row was created — `requestPaymentPush`
    // already refused in manual mode, so a payment job in manual mode came from
    // the invoice push's own fan-out and must run. Deletes run in every mode:
    // once Breeze created a Payment in QuickBooks it owns its removal.
    if (data.type === 'push-invoice' && conn.pushMode !== 'auto') return;

    if (data.type === 'push-payment' || data.type === 'delete-payment') {
      await processPaymentJob(data, runInDbContext);
      return;
    }

    try {
      if (data.type === 'push-invoice') {
        await pushInvoiceToAccounting(data.invoiceId, data.partnerId, runInDbContext);
      } else {
        await voidInvoiceInAccounting(data.invoiceId, data.partnerId, runInDbContext);
      }
    } catch (err) {
      if (err instanceof AccountingInvoicePushError && TERMINAL_CODES.has(err.code)) {
        console.error(
          '[AccountingSyncWorker] terminal failure, not retrying',
          `type=${data.type}`, `invoiceId=${data.invoiceId}`, `code=${err.code}`, err.message,
        );
        captureException(err, undefined, { service: 'accountingSyncWorker', type: data.type, invoiceId: data.invoiceId, code: err.code });
        return;
      }
      throw err;
    }
  });
}

async function processPaymentJob(
  data: PushPaymentJobData | DeletePaymentJobData,
  runInDbContext: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const startedAt = Date.now();
  let outcome: string;
  try {
    outcome = data.type === 'push-payment'
      ? await pushPaymentToAccounting(data.mappingId, data.partnerId, runInDbContext)
      : await deletePaymentInAccounting(data.mappingId, data.partnerId, runInDbContext);
  } catch (err) {
    if (err instanceof AccountingPaymentPushError && PAYMENT_TERMINAL_CODES.has(err.code)) {
      console.error(
        '[AccountingSyncWorker] terminal payment failure, not retrying',
        `type=${data.type}`, `mappingId=${data.mappingId}`, `code=${err.code}`, err.message,
      );
      captureException(err, undefined, {
        service: 'accountingPaymentPush', type: data.type, mappingId: data.mappingId, code: err.code,
      });
      return;
    }
    throw err;
  }

  console.log(
    '[AccountingSyncWorker] payment job complete',
    `type=${data.type}`, `mappingId=${data.mappingId}`, `outcome=${outcome}`, `durationMs=${Date.now() - startedAt}`,
  );

  // The coordinator never touches Redis, so the follow-up delete it decided on
  // (the payment was voided/refunded while the create was in flight) is enqueued
  // HERE. If this enqueue is lost the sweep re-enqueues it within 15 minutes —
  // the mapping row still carries pending_op = 'delete'.
  if (outcome === 'converted_to_delete') {
    await enqueueAccountingPaymentDelete(data.mappingId, data.partnerId);
  }
}
```

Add the two enqueue helpers after `enqueueAccountingInvoiceVoid` (`:226`):

```ts
/**
 * Nudge the worker to push a pending payment mapping. Fire-and-forget: the
 * mapping row is the durable record, so a Redis outage only delays the push
 * until the 15-minute reconcile sweep re-enqueues it.
 *
 * The jobId carries the OPERATION as well as the mapping id. With a shared
 * `accounting-payment-<mappingId>` id, a delete enqueued while a push job for
 * the same row was still active would be silently swallowed as a duplicate —
 * and the QuickBooks Payment would stay in the books forever.
 */
export async function enqueueAccountingPaymentPush(mappingId: string, partnerId: string): Promise<boolean> {
  return enqueuePaymentJob('push-payment', mappingId, partnerId);
}

/** Same contract as the push enqueue above, for the removal half. */
export async function enqueueAccountingPaymentDelete(mappingId: string, partnerId: string): Promise<boolean> {
  return enqueuePaymentJob('delete-payment', mappingId, partnerId);
}

async function enqueuePaymentJob(
  type: 'push-payment' | 'delete-payment', mappingId: string, partnerId: string,
): Promise<boolean> {
  const op = type === 'push-payment' ? 'push' : 'delete';
  try {
    await getAccountingSyncQueue().add(
      type,
      { type, mappingId, partnerId } as AccountingSyncJobData,
      { jobId: `accounting-payment-${mappingId}-${op}`, ...ENQUEUE_OPTS },
    );
    return true;
  } catch (err) {
    console.error(`[AccountingSyncWorker] failed to enqueue ${type}`, `mappingId=${mappingId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}
```

Import `pushPaymentToAccounting`, `deletePaymentInAccounting`, `AccountingPaymentPushError` and `type AccountingPaymentPushErrorCode` from `'../services/accounting/accountingPaymentPush'`, and extend the module header's retry-taxonomy paragraph to name the payment codes.

- [ ] **Step 4: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/jobs/accountingSyncWorker.test.ts`
Expected: PASS.

- [ ] **Step 5: RED — reconcile worker gating and sweep tests.**

Append to `apps/api/src/jobs/accountingReconcileWorker.test.ts` (add a `listOwedPaymentMappings` mock and the two payment enqueue mocks to its existing hoisted block):

```ts
describe('gate: pull OR push (spec decision 6)', () => {
  it('still runs the CDC pass when pull is off but push is on', async () => {
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pullPayments: false, pushPayments: true, realmIdFingerprint: 'fp', cdcCursor: null });
    reconcileChangesMock.mockResolvedValue(EMPTY_CHANGESET);
    await expect(processReconcileConnectionJob({ type: 'reconcile-connection', connectionId: 'c1', partnerId: 'p1', trigger: 'sweep' }))
      .resolves.not.toBeNull();
    expect(reconcileChangesMock).toHaveBeenCalled();
  });

  it('returns null and touches nothing when BOTH switches are off', async () => {
    getConnectionMock.mockResolvedValue({ id: 'c1', status: 'connected', pullPayments: false, pushPayments: false });
    await expect(processReconcileConnectionJob({ type: 'reconcile-connection', connectionId: 'c1', partnerId: 'p1', trigger: 'sweep' }))
      .resolves.toBeNull();
    expect(reconcileChangesMock).not.toHaveBeenCalled();
    expect(resolveConnectionAndTokenMock).not.toHaveBeenCalled();
  });
});

describe('stale pending_op sweep', () => {
  it('re-enqueues every owed mapping by its own operation, with nothing held', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([]);
    listOwedPaymentMappingsMock.mockResolvedValue([
      { id: 'm1', partnerId: 'p1', pendingOp: 'push' },
      { id: 'm2', partnerId: 'p2', pendingOp: 'delete' },
    ]);
    let depthAtEnqueue = -1;
    enqueuePaymentPushMock.mockImplementation(async () => { depthAtEnqueue = ctx.depth; return true; });

    const summary = await processReconcileSweep();

    expect(enqueuePaymentPushMock).toHaveBeenCalledWith('m1', 'p1');
    expect(enqueuePaymentDeleteMock).toHaveBeenCalledWith('m2', 'p2');
    expect(summary.pendingOpsEnqueued).toBe(2);
    // Redis work never happens inside a DB context.
    expect(depthAtEnqueue).toBe(0);
  });

  it('counts a refused enqueue as failed rather than reporting it as queued', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([]);
    listOwedPaymentMappingsMock.mockResolvedValue([{ id: 'm1', partnerId: 'p1', pendingOp: 'push' }]);
    enqueuePaymentPushMock.mockResolvedValue(false);
    await expect(processReconcileSweep()).resolves.toMatchObject({ pendingOpsEnqueued: 0, pendingOpsFailed: 1 });
  });

  it('sweeps owed mappings even when NO connection is reconcilable (deletes must still propagate)', async () => {
    listReconcilableConnectionsMock.mockResolvedValue([]);
    listOwedPaymentMappingsMock.mockResolvedValue([{ id: 'm2', partnerId: 'p2', pendingOp: 'delete' }]);
    await processReconcileSweep();
    expect(enqueuePaymentDeleteMock).toHaveBeenCalledWith('m2', 'p2');
  });
});
```

- [ ] **Step 6: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/jobs/accountingReconcileWorker.test.ts`
Expected: FAIL — the both-off case still returns a summary (the gate reads `!conn.pullPayments` alone), and `processReconcileSweep` has no `pendingOpsEnqueued`.

- [ ] **Step 7: Implement the reconcile worker changes.**

In `apps/api/src/jobs/accountingReconcileWorker.ts`:

Widen the gate (`:239`) and its doc comment (`:220-229`):

```ts
    // Returns null when the job is a no-op: no connection, a connection that is
    // not the one the job names, one that is not `connected`, or one with BOTH
    // direction switches off. Phase D2 (spec decision 6): pull-off/push-on still
    // runs the CDC pass — it is what ADOPTS a Breeze-created Payment whose phase
    // 2 never landed and what notices a Breeze-origin Payment deleted in
    // QuickBooks — it just suppresses new QuickBooks-origin imports.
    if (!conn || conn.id !== data.connectionId || conn.status !== 'connected') return null;
    if (!conn.pullPayments && !conn.pushPayments) return null;
```

Extend the sweep (`:380-397`):

```ts
/**
 * The 15-minute fan-out, in two passes.
 *
 * Pass 1 enqueues one `reconcile-connection` job per connection with either
 * direction switched on. Pass 2 is the OUTBOX BACKSTOP (spec decision 1): every
 * `accounting_entity_mappings` row that still owes QuickBooks a push or a delete,
 * whose lease has expired and whose last update is older than the grace window,
 * is re-enqueued on the accounting-sync queue. That is what makes a lost
 * enqueue — Redis down, the process dying between COMMIT and `add()`, BullMQ
 * exhausting its attempts — recover with no operator action.
 *
 * Pass 2 is deliberately NOT gated on any connection switch: a delete must
 * propagate even for a connection whose push is switched off, because Breeze
 * created that Payment in QuickBooks and owns its removal.
 *
 * Both passes read inside ONE short system context each, CLOSED before any Redis
 * work — an `add()` that blocks on a slow Redis must never hold a pooled
 * Postgres connection.
 */
export async function processReconcileSweep(): Promise<{
  enqueued: number; failed: number; pendingOpsEnqueued: number; pendingOpsFailed: number;
}> {
  return runOutsideDbContext(async () => {
    const connections = await withSystemDbAccessContext(
      () => listReconcilableConnections(db, 'quickbooks'),
      'accountingReconcile.sweep.list',
    );

    let enqueued = 0;
    let failed = 0;
    for (const connection of connections) {
      if (await enqueueAccountingReconcile(connection.id, connection.partnerId, 'sweep')) enqueued++;
      else failed++;
    }

    const owed = await withSystemDbAccessContext(
      () => listOwedPaymentMappings(db, new Date()),
      'accountingReconcile.sweep.pendingOps',
    );

    let pendingOpsEnqueued = 0;
    let pendingOpsFailed = 0;
    for (const row of owed) {
      const accepted = row.pendingOp === 'push'
        ? await enqueueAccountingPaymentPush(row.id, row.partnerId)
        : await enqueueAccountingPaymentDelete(row.id, row.partnerId);
      if (accepted) pendingOpsEnqueued++;
      else pendingOpsFailed++;
    }

    console.log(
      '[AccountingReconcileWorker] sweep complete',
      `connections=${connections.length}`, `enqueued=${enqueued}`, `failed=${failed}`,
      `pendingOps=${owed.length}`, `pendingOpsEnqueued=${pendingOpsEnqueued}`, `pendingOpsFailed=${pendingOpsFailed}`,
    );
    return { enqueued, failed, pendingOpsEnqueued, pendingOpsFailed };
  });
}
```

Import `listOwedPaymentMappings` from `'../services/accounting/accountingPaymentPush'` and `enqueueAccountingPaymentPush` / `enqueueAccountingPaymentDelete` from `'./accountingSyncWorker'`.

- [ ] **Step 8: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/jobs/accountingReconcileWorker.test.ts src/jobs/accountingSyncWorker.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts`
Expected: PASS. `workerRegistry.test.ts` still asserts **123** workers — no worker was added, only two job types on the existing `accounting-sync` queue.

- [ ] **Step 9: Commit.**

```bash
git add -A && git commit -m "feat(accounting): payment push/delete jobs, pull-or-push reconcile gate and the pending-op sweep

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ"
```

---

### Task 5: Payment-path hooks — `invoiceService`, `stripeReconcile`, invoice-push fan-out, and the `paid_at` fix (#4542)

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts:18-20` (imports), `:1362-1373` (`recomputeInvoiceStatus`), `:1375-1458` (`recordPayment`), `:1460-1506` (`voidPayment`), `:1508-1544` (`listPayments`), `:1640-1641` (`voidInvoice`'s direct update)
- Modify: `apps/api/src/services/stripeReconcile.ts:10` (import), `:93-115` (`recordStripePayment`), `:177-233` (`reflectStripeRefund`)
- Modify: `apps/api/src/services/accounting/accountingInvoicePush.ts:626-648` (after `persistInvoiceRemoteRef`)
- Test: `apps/api/src/services/invoiceService.test.ts`, `apps/api/src/services/stripeReconcile.test.ts`, `apps/api/src/services/accounting/accountingInvoicePush.test.ts` (all extend)

**Interfaces:**
- Consumes: `requestPaymentPush`, `requestPaymentDelete`, `fanOutOwedPayments` (Task 3); `enqueueAccountingPaymentPush`, `enqueueAccountingPaymentDelete` (Task 4).
- Produces:
```ts
// invoiceService.listPayments() rows gain, alongside `source`:
accountingSync: { status: 'pending' | 'synced' | 'error' | 'synced_with_tax_variance'; lastError: string | null } | null;
// `source` is 'quickbooks' ONLY for a mapping with breeze_origin = false; a
// Breeze-origin payment keeps 'manual'/'stripe' and carries accountingSync.
// voidPayment throws InvoiceServiceError(409, 'QUICKBOOKS_OWNED_PAYMENT') for a
// QuickBooks-origin payment.
```

- [ ] **Step 1: RED — `recomputeInvoiceStatus` clears `paid_at` (#4542).**

Add to `apps/api/src/services/invoiceService.test.ts`:

```ts
describe('recomputeInvoiceStatus paid_at lifecycle (#4542)', () => {
  it('stamps paid_at when the invoice becomes paid', async () => {
    // total 100.00, one 100.00 payment, paidAt currently null
    setupInvoice({ total: '100.00', paidAt: null }, [{ amount: '100.00' }]);
    await recomputeInvoiceStatus(INVOICE_ID);
    expect(lastInvoicePatch()).toMatchObject({ status: 'paid', paidAt: expect.any(Date) });
  });

  it('CLEARS paid_at when a reversal drops the invoice out of paid', async () => {
    // The bug: paid_at survived the reversal, so a partially_paid invoice
    // reported a payment date and every "paid in period" report double-counted it.
    setupInvoice({ total: '100.00', paidAt: new Date('2026-09-01T00:00:00Z') }, [{ amount: '40.00' }]);
    await recomputeInvoiceStatus(INVOICE_ID);
    expect(lastInvoicePatch()).toMatchObject({ status: 'partially_paid', paidAt: null });
  });

  it('leaves paid_at alone when the invoice is still paid (no needless write)', async () => {
    setupInvoice({ total: '100.00', paidAt: new Date('2026-09-01T00:00:00Z') }, [{ amount: '100.00' }]);
    await recomputeInvoiceStatus(INVOICE_ID);
    expect('paidAt' in lastInvoicePatch()).toBe(false);
  });
});

describe('voidInvoice clears paid_at (#4542)', () => {
  it('nulls paid_at on the void update', async () => {
    await voidInvoice(INVOICE_ID, 'duplicate', {}, ACTOR);
    expect(invoicePatchWith('status', 'void')).toMatchObject({ voidedAt: expect.any(Date), paidAt: null });
  });
});
```

(`setupInvoice` / `lastInvoicePatch` / `invoicePatchWith` are the file's existing fixture helpers — reuse them; do not add new ones.)

- [ ] **Step 2: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/services/invoiceService.test.ts -t "paid_at"`
Expected: FAIL — the reversal case reports `paidAt` absent from the patch, and the void update has no `paidAt`.

- [ ] **Step 3: Fix `paid_at`.**

`invoiceService.ts:1369-1372` becomes:

```ts
  const patch: Record<string, unknown> = { amountPaid, balance, status, updatedAt: new Date() };
  if (status === 'paid' && inv.paidAt === null) patch.paidAt = new Date();
  // #4542: paid_at was STAMPED but never CLEARED, so an invoice that fell back
  // out of `paid` — a voided payment, a QuickBooks-side reversal, a Stripe
  // refund — kept reporting a payment date it no longer had, and every
  // "paid in period" report counted it twice.
  if (status !== 'paid' && inv.paidAt !== null) patch.paidAt = null;
  if (status === 'overdue' && inv.markedOverdueAt === null) patch.markedOverdueAt = new Date();
```

`invoiceService.ts:1641` becomes:

```ts
    // paid_at cleared with the same reasoning as recomputeInvoiceStatus above
    // (#4542): this update bypasses the recompute entirely, so a paid invoice
    // that is voided would otherwise keep its payment date forever.
    await db.update(invoices).set({ status: 'void', voidedAt: now, voidReason: reason, paidAt: null, updatedAt: now }).where(eq(invoices.id, invoiceId));
```

- [ ] **Step 4: RED — the payment hooks.**

Add to `apps/api/src/services/invoiceService.test.ts` (mock `../services/accounting/accountingPaymentPush` and `../jobs/accountingSyncWorker` in the file's existing hoisted block):

```ts
describe('recordPayment -> QuickBooks push hook', () => {
  it('requests the push INSIDE the payment transaction and enqueues AFTER it returns', async () => {
    requestPaymentPushMock.mockResolvedValue('map-1');
    const order: string[] = [];
    requestPaymentPushMock.mockImplementation(async () => { order.push('request'); return 'map-1'; });
    enqueuePaymentPushMock.mockImplementation(async () => { order.push('enqueue'); return true; });

    await recordPayment(INVOICE_ID, { amount: '10.00', method: 'check', receivedAt: '2026-09-02' }, ACTOR);

    expect(requestPaymentPushMock).toHaveBeenCalledWith(expect.anything(), {
      invoicePaymentId: expect.any(String), invoiceId: INVOICE_ID, partnerId: PARTNER_ID,
    });
    expect(order).toEqual(['request', 'enqueue']);
  });

  it('does not enqueue when nothing is owed', async () => {
    requestPaymentPushMock.mockResolvedValue(null);
    await recordPayment(INVOICE_ID, { amount: '10.00', method: 'check', receivedAt: '2026-09-02' }, ACTOR);
    expect(enqueuePaymentPushMock).not.toHaveBeenCalled();
  });

  it('never fails a committed payment because Redis is down', async () => {
    requestPaymentPushMock.mockResolvedValue('map-1');
    enqueuePaymentPushMock.mockRejectedValue(new Error('redis down'));
    await expect(recordPayment(INVOICE_ID, { amount: '10.00', method: 'check', receivedAt: '2026-09-02' }, ACTOR))
      .resolves.toBeTruthy();
  });
});

describe('voidPayment', () => {
  it('requests a delete inside the transaction and enqueues after', async () => {
    requestPaymentDeleteMock.mockResolvedValue('map-1');
    await voidPayment(PAYMENT_ID, ACTOR);
    expect(requestPaymentDeleteMock).toHaveBeenCalledWith(expect.anything(), PAYMENT_ID);
    expect(enqueuePaymentDeleteMock).toHaveBeenCalledWith('map-1', PARTNER_ID);
  });

  it('REFUSES a QuickBooks-origin payment at the service layer, not just in the UI', async () => {
    // Until now only the UI hid the button, so any API client could void a row
    // QuickBooks owns — and the next CDC sweep would pull it straight back in,
    // leaving an audit trail of a void that did nothing.
    setPaymentMapping({ breezeOrigin: false });
    await expect(voidPayment(PAYMENT_ID, ACTOR)).rejects.toMatchObject({
      status: 409, code: 'QUICKBOOKS_OWNED_PAYMENT',
    });
    expect(requestPaymentDeleteMock).not.toHaveBeenCalled();
  });
});

describe('listPayments source + accountingSync', () => {
  it('classifies a BREEZE-ORIGIN mapped payment as manual, with its sync state attached', async () => {
    setPaymentMapping({ breezeOrigin: true, syncStatus: 'synced', lastError: null });
    const [row] = await listPayments(INVOICE_ID, ACTOR);
    expect(row).toMatchObject({ source: 'manual', accountingSync: { status: 'synced', lastError: null } });
  });

  it('classifies a QUICKBOOKS-ORIGIN mapped payment as quickbooks with no sync card', async () => {
    setPaymentMapping({ breezeOrigin: false, syncStatus: 'synced', lastError: null });
    const [row] = await listPayments(INVOICE_ID, ACTOR);
    expect(row).toMatchObject({ source: 'quickbooks', accountingSync: null });
  });

  it('surfaces a push failure on a Stripe payment without changing its source', async () => {
    setStripeLinked(true);
    setPaymentMapping({ breezeOrigin: true, syncStatus: 'error', lastError: 'QuickBooks rejected the payment sync (HTTP 400)' });
    const [row] = await listPayments(INVOICE_ID, ACTOR);
    expect(row).toMatchObject({
      source: 'stripe',
      accountingSync: { status: 'error', lastError: 'QuickBooks rejected the payment sync (HTTP 400)' },
    });
  });

  it('leaves an unmapped payment with a null sync card', async () => {
    setPaymentMapping(null);
    const [row] = await listPayments(INVOICE_ID, ACTOR);
    expect(row).toMatchObject({ source: 'manual', accountingSync: null });
  });
});
```

- [ ] **Step 5: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/services/invoiceService.test.ts`
Expected: FAIL — `requestPaymentPush` is never called; `voidPayment` still calls the removed `clearPaymentMappingForInvoicePayment`; `accountingSync` is absent.

- [ ] **Step 6: Implement the `invoiceService` hooks.**

Replace the import at `:20` and extend `:18`:

```ts
import { enqueueAccountingInvoicePush, enqueueAccountingInvoiceVoid, enqueueAccountingPaymentPush, enqueueAccountingPaymentDelete } from '../jobs/accountingSyncWorker';
import { requestPaymentPush, requestPaymentDelete } from './accounting/accountingPaymentPush';
```

In `recordPayment`, inside the transaction right after `recomputeInvoiceStatus(invoiceId, tx)` (`:1429`):

```ts
    // The mapping row is the OUTBOX and it is written HERE, in the same
    // transaction as the payment — not from a post-commit hook. If the process
    // dies before the enqueue below, the reconcile sweep finds the pending row
    // and pushes it anyway; if this transaction rolls back, no promise to
    // QuickBooks survives it either.
    const paymentPushMappingId = await requestPaymentPush(tx, {
      invoicePaymentId: payment!.id, invoiceId, partnerId: inv.partnerId,
    });
```

and return it from the transaction (`:1431`): `return { inv, payment: payment!, updated, paymentPushMappingId };`. After the transaction, next to the existing event emissions (`:1440`):

```ts
  // Fire-and-forget nudge. `enqueueAccountingPaymentPush` is itself
  // Redis-outage-safe; the extra try/catch is the same defensive belt as the
  // issue-side push hook, so no unexpected throw can fail a committed payment.
  if (paymentPushMappingId) {
    try {
      await enqueueAccountingPaymentPush(paymentPushMappingId, inv.partnerId);
    } catch (err) {
      console.error('[invoiceService] enqueueAccountingPaymentPush failed (payment already committed)', `paymentId=${payment.id}`, err instanceof Error ? err.message : err);
    }
  }
```

In `voidPayment`, add the origin refusal and swap the mapping clear (`:1476-1495`):

```ts
    if (!pay || pay.invoiceId !== pre.invoiceId) throw new InvoiceServiceError('Payment not found', 404, 'PAYMENT_NOT_FOUND');

    // QuickBooks-origin payments are refused at the SERVICE layer, not just
    // hidden in the UI (spec decision 14). QuickBooks is the system of record
    // for them: a Breeze-side void would not touch the books, and the next CDC
    // sweep would pull the payment straight back in — leaving an audit trail of
    // a void that did nothing.
    const [existingMapping] = await tx
      .select({ breezeOrigin: accountingEntityMappings.breezeOrigin })
      .from(accountingEntityMappings)
      .where(and(
        eq(accountingEntityMappings.breezeEntityType, 'payment'),
        eq(accountingEntityMappings.breezeEntityId, paymentId),
      ))
      .limit(1);
    if (existingMapping && !existingMapping.breezeOrigin) {
      throw new InvoiceServiceError(
        'This payment came from QuickBooks; reverse it in QuickBooks instead',
        409, 'QUICKBOOKS_OWNED_PAYMENT',
      );
    }

    // The existing audit snapshot at `:1479-1487` is UNCHANGED — keep it exactly
    // as it is (orgId, paymentId, invoiceId, amount, method, reference, recordedBy).
    const audit = { orgId: pay.orgId, paymentId, invoiceId: pay.invoiceId, amount: pay.amount, method: pay.method, reference: pay.reference, recordedBy: pay.recordedBy };
    // Replaces Phase D's clearPaymentMappingForInvoicePayment. A Breeze-origin
    // payment that reached QuickBooks keeps its mapping row with
    // pending_op = 'delete' until QuickBooks confirms the removal; everything
    // else has its row dropped. Zero rows is the normal case.
    const deleteMappingId = await requestPaymentDelete(tx, paymentId);
    await tx.delete(invoicePayments).where(eq(invoicePayments.id, paymentId));
    await recomputeInvoiceStatus(pay.invoiceId, tx);
    const inv = await getOwnedInvoiceOr404(pay.invoiceId, tx);
    return { inv, audit, deleteMappingId };
```

and after the transaction, beside the existing `emitInvoiceEvent` (`:1504`):

```ts
  if (deleteMappingId) {
    try {
      await enqueueAccountingPaymentDelete(deleteMappingId, inv.partnerId);
    } catch (err) {
      console.error('[invoiceService] enqueueAccountingPaymentDelete failed (void already committed)', `paymentId=${paymentId}`, err instanceof Error ? err.message : err);
    }
  }
```

In `listPayments`, widen the mapping read and the mapper (`:1527-1543`):

```ts
  const qboLinked = paymentIds.length === 0 ? [] : await db
    .select({
      breezeEntityId: accountingEntityMappings.breezeEntityId,
      breezeOrigin: accountingEntityMappings.breezeOrigin,
      syncStatus: accountingEntityMappings.syncStatus,
      lastError: accountingEntityMappings.lastError,
    })
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.partnerId, inv.partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      inArray(accountingEntityMappings.breezeEntityId, paymentIds),
    ));
  const mappingByPaymentId = new Map(qboLinked.map((r) => [r.breezeEntityId, r]));
  // Stripe wins a (structurally impossible) double link: it is the badge that
  // gates the destructive hand-void affordance.
  return rows.map((r) => {
    const mapping = mappingByPaymentId.get(r.id) ?? null;
    // `quickbooks` means "QuickBooks OWNS this row", which is true only for a
    // payment the pull created (spec decision 14). A Breeze-origin payment that
    // Breeze PUSHED to QuickBooks stays manual/stripe — it is still hand-voidable,
    // and the void propagates the deletion — and instead carries a sync badge.
    const source = stripeIds.has(r.id)
      ? ('stripe' as const)
      : mapping && !mapping.breezeOrigin ? ('quickbooks' as const) : ('manual' as const);
    return {
      ...r,
      source,
      accountingSync: mapping && mapping.breezeOrigin
        ? { status: mapping.syncStatus, lastError: mapping.lastError }
        : null,
    };
  });
```

- [ ] **Step 7: RED then GREEN — the Stripe hooks.**

Add to `apps/api/src/services/stripeReconcile.test.ts`:

```ts
it('requests a QuickBooks push for a captured Stripe payment, enqueued after the transaction', async () => {
  requestPaymentPushMock.mockResolvedValue('map-1');
  await recordStripePayment(captureInput());
  expect(requestPaymentPushMock).toHaveBeenCalledWith(expect.anything(), {
    invoicePaymentId: expect.any(String), invoiceId: INVOICE_ID, partnerId: PARTNER_ID,
  });
  expect(enqueuePaymentPushMock).toHaveBeenCalledWith('map-1', PARTNER_ID);
});

it('mirrors a FULL Stripe refund as a QuickBooks delete', async () => {
  requestPaymentDeleteMock.mockResolvedValue('map-1');
  await reflectStripeRefund({ ...refundInput(), amountRefundedCents: 10700, chargeAmountCents: 10700 });
  expect(requestPaymentDeleteMock).toHaveBeenCalledWith(expect.anything(), PAYMENT_ID);
  expect(enqueuePaymentDeleteMock).toHaveBeenCalledWith('map-1', PARTNER_ID);
});

it('records a PARTIAL Stripe refund as a divergence and NEVER rewrites the QuickBooks Payment', async () => {
  // Rewriting a Payment's amount would rewrite receipt history, and Intuit
  // models a refund as its own transaction (spec decision 9).
  setPaymentMapping({ breezeOrigin: true, remoteEntityId: '181/145' });
  await reflectStripeRefund({ ...refundInput(), amountRefundedCents: 6700, chargeAmountCents: 10700 });
  expect(requestPaymentDeleteMock).not.toHaveBeenCalled();
  expect(enqueuePaymentPushMock).not.toHaveBeenCalled();
  expect(lastMappingPatch()).toMatchObject({
    syncStatus: 'error',
    lastError: 'Partially refunded in Stripe (40.00); record the refund in QuickBooks',
    pendingOp: null,
  });
});

it('leaves a partial refund alone when the payment was never pushed', async () => {
  setPaymentMapping(null);
  await reflectStripeRefund({ ...refundInput(), amountRefundedCents: 6700, chargeAmountCents: 10700 });
  expect(lastMappingPatch()).toBeNull();
});
```

Run: `cd apps/api && npx vitest run src/services/stripeReconcile.test.ts` — expect FAIL. Then implement.

In `apps/api/src/services/stripeReconcile.ts`, replace the `clearPaymentMappingForInvoicePayment` import (`:10`) with `import { requestPaymentDelete, requestPaymentPush, partialRefundDivergenceMessage } from './accounting/accountingPaymentPush';` and add `import { enqueueAccountingPaymentPush, enqueueAccountingPaymentDelete } from '../jobs/accountingSyncWorker';`.

In `recordStripePayment`, after `recomputeInvoiceStatus(inv.id)` (`:111`):

```ts
    // Gross amount is what settles the invoice, so gross is what QuickBooks gets
    // (spec decision 8). DepositToAccountRef is omitted by the provider, so the
    // receipt lands in Undeposited Funds and the bookkeeper records the
    // processor fee at deposit time. Fee expense entries are out of scope.
    const paymentPushMappingId = await requestPaymentPush(db, {
      invoicePaymentId: payment!.id, invoiceId: inv.id, partnerId: inv.partnerId,
    });
```

Carry it on the `recorded` outcome (`:113-114`) and, in the post-transaction block (`:125-131`), enqueue it:

```ts
  } else if (outcome.kind === 'recorded') {
    await emitInvoiceEvent({ type: 'payment.recorded', invoiceId: outcome.invoiceId, orgId: outcome.orgId,
      partnerId: outcome.partnerId, paymentId: outcome.paymentId });
    if (outcome.paymentPushMappingId) {
      await enqueueAccountingPaymentPush(outcome.paymentPushMappingId, outcome.partnerId);
    }
    // UNCHANGED, kept in place after the new enqueue above:
    if (outcome.paid) {
      await emitInvoiceEvent({ type: 'invoice.paid', invoiceId: outcome.invoiceId, orgId: outcome.orgId, partnerId: outcome.partnerId });
    }
  }
```

In `reflectStripeRefund`'s full-refund arm, replace the `clearPaymentMappingForInvoicePayment(db, paymentId)` call (`:193`):

```ts
      // A full refund is a void: the money went back. Breeze-origin mappings
      // keep their row with pending_op='delete' until QuickBooks confirms the
      // Payment is gone; QuickBooks-origin ones are simply dropped.
      deleteMappingId = await requestPaymentDelete(db, paymentId);
```

and add an `else` branch to the partial arm (`:219-229`), after the amount update:

```ts
      // Spec decision 9: a partial refund is a DIVERGENCE, not an update. The
      // QuickBooks Payment stays exactly as created and the mapping tells a human
      // to record the refund in QuickBooks, because rewriting a Payment's amount
      // would rewrite receipt history.
      const remaining = fromMinorUnits(remainingCents, input.currency);
      await db.update(accountingEntityMappings)
        .set({
          syncStatus: 'error',
          lastError: partialRefundDivergenceMessage(remaining),
          pendingOp: null,
          claimedAt: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(accountingEntityMappings.breezeEntityType, 'payment'),
          eq(accountingEntityMappings.breezeEntityId, paymentId),
          eq(accountingEntityMappings.breezeOrigin, true),
          isNotNull(accountingEntityMappings.remoteEntityId),
        ))
        .returning({ id: accountingEntityMappings.id });
```

and enqueue the delete after the enclosing `withSystemDbAccessContext` returns:

```ts
  if (deleteMappingId) {
    await enqueueAccountingPaymentDelete(deleteMappingId, partnerId);
  }
```

(`deleteMappingId` and `partnerId` are hoisted `let`s declared before the `withSystemDbAccessContext` call; `partnerId` is already resolved by `invoicePartnerId(mapping.invoiceId)` at `:232`.)

`stripeReconcile.ts` also needs `accountingEntityMappings` added to its `../db/schema` import and `isNotNull` added to its `drizzle-orm` import — the partial-refund arm is the file's first `accounting_entity_mappings` write.

- [ ] **Step 8: RED then GREEN — the invoice-push fan-out hook.**

Add to `apps/api/src/services/accounting/accountingInvoicePush.test.ts`:

```ts
it('fans out the invoice payments after a successful push and enqueues each', async () => {
  fanOutOwedPaymentsMock.mockResolvedValue(['map-a', 'map-b']);
  await pushInvoiceToAccounting(INVOICE, PARTNER, runCtx);
  expect(fanOutOwedPaymentsMock).toHaveBeenCalledWith(INVOICE, PARTNER, runCtx);
  expect(enqueuePaymentPushMock).toHaveBeenCalledWith('map-a', PARTNER);
  expect(enqueuePaymentPushMock).toHaveBeenCalledWith('map-b', PARTNER);
});

it('never fails a landed invoice push because the payment fan-out threw', async () => {
  fanOutOwedPaymentsMock.mockRejectedValue(new Error('boom'));
  await expect(pushInvoiceToAccounting(INVOICE, PARTNER, runCtx)).resolves.toMatchObject({ syncStatus: 'synced' });
  expect(captureExceptionMock).toHaveBeenCalled();
});
```

Run it RED, then in `accountingInvoicePush.ts`, immediately after the `becameVoid` block (`:636`) and before the `return`:

```ts
  // Fan out this invoice's payments (spec decision 10). Runs in BOTH modes: in
  // `manual` it is the ONLY way payments reach QuickBooks, and in `auto` it
  // catches payments recorded while this push was still in flight — their own
  // `requestPaymentPush` returned null because the invoice had no remote id yet.
  // Lazily imported for the same reason the void enqueue above is: this module
  // is imported BY accountingSyncWorker, so a static import would be a cycle.
  // Best-effort: the invoice push has already landed and been recorded, and the
  // reconcile sweep re-enqueues any mapping this leaves pending.
  try {
    const owed = await fanOutOwedPayments(inv.id, partnerId, runInDbContext);
    if (owed.length > 0) {
      const { enqueueAccountingPaymentPush } = await import('../../jobs/accountingSyncWorker');
      for (const mappingId of owed) await enqueueAccountingPaymentPush(mappingId, partnerId);
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingInvoicePush', invoiceId: inv.id, phase: 'payment-fan-out',
    });
  }
```

with `import { fanOutOwedPayments } from './accountingPaymentPush';` at the top.

- [ ] **Step 9: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/services/invoiceService.test.ts src/services/stripeReconcile.test.ts src/services/accounting/accountingInvoicePush.test.ts src/services/accounting/accountingPaymentPush.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck the whole API package** (Task 3 deliberately left the two `clearPaymentMappingForInvoicePayment` call sites red).

Run: `pnpm build --filter @breeze/api`
Expected: clean — no unresolved import of `clearPaymentMappingForInvoicePayment` anywhere.

- [ ] **Step 11: Commit.**

```bash
git add -A && git commit -m "feat(accounting): push Breeze payments to QuickBooks from record/void/refund, and clear paid_at on reversal (#4542)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ"
```

---

### Task 6: The pull side — adoption, Breeze-origin rules, pull-disabled skip, self-void guard

**Files:**
- Modify: `apps/api/src/services/accounting/accountingPaymentPull.ts:91-112` (outcome union), `:135-140` (`PendingAudit`), `:384-603` (`applyInsideTransaction`), `:771-837` (`reverseOneInsideTransaction`), `:869-884` (`markInvoiceDeletedRemotely`)
- Modify: `apps/api/src/services/accounting/accountingPaymentPull.test.ts` (extend)
- Modify: `apps/api/src/jobs/accountingReconcileWorker.ts:98-122` (summary), `:141-176` (`emptySummary`/`tally`), `:195-214` (`logRunLine`), `:254-257` (the `markInvoiceDeletedRemotely` arm)
- Modify: `apps/api/src/jobs/accountingReconcileWorker.test.ts` (extend)

**Interfaces:**
- Consumes: `ChangeSetPaymentLine.breezePaymentId` (Task 2), `AccountingConnection.pushPayments`/`pullPayments` (Task 1), `paymentMappingRemoteId` (local).
- Produces:
```ts
export type PaymentPullOutcome =
  | 'applied' | 'updated' | 'replayed' | 'reversed'
  | 'skipped_unmapped' | 'currency_mismatch' | 'invoice_void' | 'realm_changed' | 'failed'
  // --- Phase D2 ---
  | 'adopted'                        // a Breeze-created Payment whose phase 2 never landed
  | 'breeze_origin_diverged'         // QuickBooks edited a payment Breeze owns
  | 'skipped_breeze_origin'          // Breeze-origin, but the push/delete job owns the outcome
  | 'skipped_pull_disabled'          // pull off; only NEW QuickBooks-origin imports are suppressed
  | 'breeze_origin_removed_remotely';// somebody deleted a Breeze-created Payment in QuickBooks

export const BREEZE_ORIGIN_DIVERGED_MESSAGE =
  'Edited in QuickBooks; Breeze remains the source of truth for this payment';
export const BREEZE_ORIGIN_REMOVED_MESSAGE = 'Deleted in QuickBooks';

export async function markInvoiceDeletedRemotely(
  conn: AccountingConnection, remoteInvoiceId: string,
  runInDbContext: DbContextRunner, expectedRealmFingerprint: string | null,
): Promise<'marked' | 'skipped_unmapped' | 'realm_changed' | 'invoice_void'>;

// ReconcileRunSummary gains: adopted, breezeOriginDiverged, skippedBreezeOrigin,
//                           skippedPullDisabled, breezeOriginRemovedRemotely,
//                           invoicesSelfVoided
```
All five new payment outcomes are CLEAN for the CDC cursor: each is a recorded, permanent decision, and re-reading the same window would reach the identical one.

- [ ] **Step 1: RED — pull-side tests.**

Append to `apps/api/src/services/accounting/accountingPaymentPull.test.ts` (its harness at `:1-70` and `runCtx` at `:387-409` are reused unchanged; add `breezePaymentId: null` to the shared `LINE` fixture first, then):

```ts
const BREEZE_PAY = '0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

describe('adoption of a Breeze-created Payment (spec decision 3)', () => {
  it('fills in the remote id and token on a pending push mapping whose create response was lost', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), {
      ...paymentMapping(), breezeEntityId: BREEZE_PAY, remoteEntityId: null, remoteSyncToken: null,
      breezeOrigin: true, pendingOp: 'push', syncStatus: 'pending', claimedAt: null,
    }];
    const r = await applyAccountingPayment(conn(), { ...LINE, breezePaymentId: BREEZE_PAY }, runCtx, REALM_FP);
    expect(r.outcome).toBe('adopted');
    expect(currentMappings[1]).toMatchObject({
      remoteEntityId: '181/145', remoteSyncToken: '0',
      syncStatus: 'synced', pendingOp: null, claimedAt: null,
    });
    // NO second invoice_payments row: adoption claims the existing one.
    expect(currentPayments).toHaveLength(1);
    expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'accounting.payment.adopted',
    }));
  });

  it('refuses to adopt when the amounts disagree — the push job owns that outcome', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '40.00' }];
    currentMappings = [invoiceMapping(), { ...paymentMapping(), breezeEntityId: BREEZE_PAY, remoteEntityId: null, breezeOrigin: true, pendingOp: 'push', syncStatus: 'pending' }];
    const r = await applyAccountingPayment(conn(), { ...LINE, breezePaymentId: BREEZE_PAY }, runCtx, REALM_FP);
    expect(r.outcome).toBe('skipped_breeze_origin');
    expect(currentMappings[1]!.remoteEntityId).toBeNull();
  });

  it('refuses to adopt when the marker names a payment on a DIFFERENT invoice', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: 'inv-other', orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), { ...paymentMapping(), breezeEntityId: BREEZE_PAY, remoteEntityId: null, breezeOrigin: true, pendingOp: 'push', syncStatus: 'pending' }];
    await expect(applyAccountingPayment(conn(), { ...LINE, breezePaymentId: BREEZE_PAY }, runCtx, REALM_FP))
      .resolves.toMatchObject({ outcome: 'skipped_breeze_origin' });
  });

  it('refuses to adopt a marker naming a payment Breeze does not own — no row is inserted', async () => {
    currentMappings = [invoiceMapping()];
    const r = await applyAccountingPayment(conn(), { ...LINE, breezePaymentId: BREEZE_PAY }, runCtx, REALM_FP);
    expect(r.outcome).toBe('skipped_breeze_origin');
    expect(currentPayments).toHaveLength(0);
  });

  it('reports a divergence when QuickBooks MOVED a Breeze payment to another invoice', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), { ...paymentMapping(), breezeEntityId: BREEZE_PAY, remoteEntityId: '181/999', breezeOrigin: true, pendingOp: null, syncStatus: 'synced' }];
    const r = await applyAccountingPayment(conn(), { ...LINE, breezePaymentId: BREEZE_PAY }, runCtx, REALM_FP);
    expect(r.outcome).toBe('breeze_origin_diverged');
    expect(currentMappings[1]).toMatchObject({
      syncStatus: 'error',
      lastError: 'Edited in QuickBooks; Breeze remains the source of truth for this payment',
    });
  });
});

describe('the echo of a Breeze-origin payment (spec decision 5)', () => {
  const breezeOriginMapping = (o = {}) => ({
    ...paymentMapping(), breezeEntityId: BREEZE_PAY, remoteEntityId: '181/145',
    remoteSyncToken: '0', breezeOrigin: true, pendingOp: null, syncStatus: 'synced', ...o,
  });

  it('replays an identical token without touching the money row', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), breezeOriginMapping()];
    const r = await applyAccountingPayment(conn(), { ...LINE, remotePaymentSyncToken: '0' }, runCtx, REALM_FP);
    expect(r.outcome).toBe('replayed');
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it('stores a NEWER token and stays clean when the amount is unchanged', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), breezeOriginMapping()];
    const r = await applyAccountingPayment(conn(), { ...LINE, remotePaymentSyncToken: '3' }, runCtx, REALM_FP);
    expect(r.outcome).toBe('replayed');
    // The token is stored anyway so a later corrective delete has the right one.
    expect(currentMappings[1]!.remoteSyncToken).toBe('3');
    expect(currentPayments[0]!.amount).toBe('107.00');
  });

  it('records a divergence — and STILL stores the token — when QuickBooks changed the amount', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), breezeOriginMapping()];
    const r = await applyAccountingPayment(conn(), { ...LINE, remotePaymentSyncToken: '3', amountMinor: 4000 }, runCtx, REALM_FP);
    expect(r.outcome).toBe('breeze_origin_diverged');
    expect(currentMappings[1]).toMatchObject({
      remoteSyncToken: '3', syncStatus: 'error',
      lastError: 'Edited in QuickBooks; Breeze remains the source of truth for this payment',
    });
    // Breeze is the system of record: the money row is NOT rewritten.
    expect(currentPayments[0]!.amount).toBe('107.00');
  });
});

describe('pull disabled (spec decision 6, #4543)', () => {
  it('suppresses a NEW QuickBooks-origin import and says so', async () => {
    currentMappings = [invoiceMapping()];
    const r = await applyAccountingPayment(conn({ pullPayments: false }), LINE, runCtx, REALM_FP);
    expect(r.outcome).toBe('skipped_pull_disabled');
    expect(currentPayments).toHaveLength(0);
  });

  it('still ADOPTS a Breeze-created Payment with pull off — push and pull are separate switches', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), { ...paymentMapping(), breezeEntityId: BREEZE_PAY, remoteEntityId: null, breezeOrigin: true, pendingOp: 'push', syncStatus: 'pending' }];
    await expect(applyAccountingPayment(conn({ pullPayments: false }), { ...LINE, breezePaymentId: BREEZE_PAY }, runCtx, REALM_FP))
      .resolves.toMatchObject({ outcome: 'adopted' });
  });

  it('still REPLAYS a Breeze-origin echo with pull off', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), { ...paymentMapping(), breezeEntityId: BREEZE_PAY, remoteEntityId: '181/145', remoteSyncToken: '0', breezeOrigin: true, syncStatus: 'synced' }];
    await expect(applyAccountingPayment(conn({ pullPayments: false }), LINE, runCtx, REALM_FP))
      .resolves.toMatchObject({ outcome: 'replayed' });
  });
});

describe('a Breeze-origin Payment deleted in QuickBooks (spec decision 5)', () => {
  it('KEEPS the Breeze payment row, clears the remote id and marks the mapping', async () => {
    // The money moved (a Stripe charge, a cheque). Deleting the Breeze row
    // because somebody removed the QuickBooks mirror would destroy the record of
    // a real payment.
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), { ...paymentMapping(), breezeEntityId: BREEZE_PAY, remoteEntityId: '181/145', breezeOrigin: true, syncStatus: 'synced' }];
    const results = await reverseAccountingPayment(conn(), '181', runCtx, REALM_FP);
    expect(results.map((r) => r.outcome)).toEqual(['breeze_origin_removed_remotely']);
    expect(currentPayments).toHaveLength(1);
    expect(currentMappings[1]).toMatchObject({
      syncStatus: 'error', lastError: 'Deleted in QuickBooks',
      remoteEntityId: null, remoteSyncToken: null, pendingOp: null,
    });
    expect(recomputeMock).not.toHaveBeenCalled();
  });

  it('treats a dropped allocation on a Breeze-origin payment as divergence, not reversal', async () => {
    currentPayments = [{ id: BREEZE_PAY, invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), { ...paymentMapping(), breezeEntityId: BREEZE_PAY, remoteEntityId: '181/145', breezeOrigin: true, syncStatus: 'synced' }];
    const results = await reverseStaleAllocations(conn(), '181', ['999'], runCtx, REALM_FP);
    expect(results.map((r) => r.outcome)).toEqual(['breeze_origin_removed_remotely']);
    expect(currentPayments).toHaveLength(1);
  });

  it('still DESTROYS a QuickBooks-origin payment row (Phase D behaviour, unchanged)', async () => {
    currentPayments = [{ id: 'pay-qbo', invoiceId: INVOICE, orgId: ORG, amount: '107.00' }];
    currentMappings = [invoiceMapping(), { ...paymentMapping(), breezeEntityId: 'pay-qbo', remoteEntityId: '181/145', breezeOrigin: false, syncStatus: 'synced' }];
    const results = await reverseAccountingPayment(conn(), '181', runCtx, REALM_FP);
    expect(results.map((r) => r.outcome)).toEqual(['reversed']);
    expect(currentPayments).toHaveLength(0);
  });
});

describe('markInvoiceDeletedRemotely self-void guard', () => {
  it('reports invoice_void — NOT an error — when Breeze itself voided the invoice', async () => {
    // The QuickBooks void is Breeze's OWN echo: voidInvoiceInAccounting sent it.
    // Stamping "Deleted in QuickBooks" would put a scary error on the mapping
    // card for a void the operator performed in Breeze thirty seconds earlier.
    currentInvoices = [{ ...invoice(), status: 'void' }];
    currentMappings = [invoiceMapping()];
    await expect(markInvoiceDeletedRemotely(conn(), '145', runCtx, REALM_FP)).resolves.toBe('invoice_void');
    expect(currentMappings[0]!.syncStatus).not.toBe('error');
  });

  it('still marks an invoice QuickBooks deleted behind Breeze back', async () => {
    currentInvoices = [{ ...invoice(), status: 'sent' }];
    currentMappings = [invoiceMapping()];
    await expect(markInvoiceDeletedRemotely(conn(), '145', runCtx, REALM_FP)).resolves.toBe('marked');
    expect(currentMappings[0]).toMatchObject({ syncStatus: 'error', lastError: 'Deleted in QuickBooks', remoteEntityId: '145' });
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingPaymentPull.test.ts`
Expected: FAIL — every new outcome comes back as `applied`/`reversed`/`marked`.

- [ ] **Step 3: Widen the outcome union and the audit actions.**

In `apps/api/src/services/accounting/accountingPaymentPull.ts`, extend `PaymentPullOutcome` (`:91-112`) with the five new members and this comment block:

```ts
  // --- Phase D2 (payment push). ALL FIVE ARE CLEAN FOR THE CDC CURSOR: each is
  // a recorded, permanent decision, and re-reading the same window would reach
  // the identical one. ---
  // A Payment BREEZE created, whose create response was lost before phase 2
  // recorded the remote id. The note's marker names a pending push mapping, so
  // the pull fills the id in instead of inserting a second payment row.
  | 'adopted'
  // QuickBooks edited a payment Breeze owns (amount changed, or the allocation
  // moved to another invoice). The Breeze row is NOT rewritten — Breeze is the
  // system of record for its own payments — and the mapping carries the reason.
  | 'breeze_origin_diverged'
  // Breeze-origin, but none of the adoption guards held. Deliberately no write:
  // the push or delete job owns this row's outcome, and a pull-side guess would
  // race it.
  | 'skipped_breeze_origin'
  // `pull_payments` is off. Only NEW QuickBooks-origin imports are suppressed —
  // adoptions, echoes and remote deletions of Breeze-origin payments still run
  // (spec decision 6). Logged per item, which is the #4543 fix for this reason.
  | 'skipped_pull_disabled'
  // Somebody deleted, in QuickBooks, a Payment Breeze created. The Breeze row
  // SURVIVES (the money moved); the mapping goes to error with its remote id
  // cleared, so a later push can recreate it.
  | 'breeze_origin_removed_remotely'
```

Extend `PendingAudit['action']` (`:137`) to `'accounting.payment.pulled' | 'accounting.payment.reversed' | 'accounting.payment.adopted' | 'accounting.payment.diverged'`, and add the two messages as exported constants beside `PAYMENT_PULL_ERROR_PREFIX` (`:172`):

```ts
/** Not prefixed with PAYMENT_PULL_ERROR_PREFIX: these land on the PAYMENT
 *  mapping row, which has exactly one owner, not on the shared invoice mapping. */
export const BREEZE_ORIGIN_DIVERGED_MESSAGE = 'Edited in QuickBooks; Breeze remains the source of truth for this payment';
export const BREEZE_ORIGIN_REMOVED_MESSAGE = 'Deleted in QuickBooks';
```

- [ ] **Step 4: Implement the applier branches.**

In `applyInsideTransaction`, immediately after the authoritative claim read at `(c)` (`:447`), insert:

```ts
  // (c2) Pull switched off. Only a NEW QuickBooks-origin import is suppressed:
  // a line that already has a mapping, or that carries Breeze's own marker, is
  // this connection's outbound work echoing back and must still be processed
  // (spec decision 6). Logged with the id so the skip is never silent (#4543).
  if (!existing && !line.breezePaymentId && !conn.pullPayments) {
    console.log(
      '[accountingPaymentPull] skipping a QuickBooks-origin payment because pull_payments is off',
      `connectionId=${conn.id}`, `remotePaymentId=${line.remotePaymentId}`, `remoteInvoiceId=${line.remoteInvoiceId}`,
    );
    return noAudit(result('skipped_pull_disabled', line.remotePaymentId, line.remoteInvoiceId, inv.id));
  }
```

Then, at the top of the `if (existing)` block (`:471`), branch on origin:

```ts
  if (existing) {
    // Breeze-origin: this is our OWN write echoing back. Never mutate the money
    // row from QuickBooks (spec decision 5).
    if (existing.breezeOrigin) {
      return applyBreezeOriginEcho(conn, line, existing, normalized, inv);
    }
    // Everything below here — the same-token replay, the amount/method/date
    // update, the token write, clearPaymentPullMappingError and the recompute
    // (`:475-536`) — is UNCHANGED. Do not edit it; it is the QuickBooks-origin
    // path, and QuickBooks stays the source of truth for those payments.
```

and, after the `if (existing)` block closes and before `(f)` (`:538`), insert the adoption branch:

```ts
  // (e2) No mapping for this (payment, invoice) pair — but the note carries
  // Breeze's own marker, so this Payment is a create of ours whose response we
  // never saw. ADOPT the pending mapping rather than inserting a second payment
  // row (spec decision 3). Every guard below must hold; any failure is a clean
  // `skipped_breeze_origin`, because the push or delete job owns the outcome and
  // a pull-side guess would race it.
  if (line.breezePaymentId) {
    const owned = await loadPaymentMappingByBreezeId(conn, line.breezePaymentId);
    if (!owned) {
      return noAudit(result('skipped_breeze_origin', line.remotePaymentId, line.remoteInvoiceId, inv.id));
    }
    if (owned.remoteEntityId && owned.remoteEntityId !== remoteMappingId) {
      // QuickBooks moved (or copied) this Payment's allocation to a different
      // invoice. Breeze cannot follow that without rewriting its own ledger, so
      // record it for a human.
      await markPaymentMappingDiverged(conn, owned.id, BREEZE_ORIGIN_DIVERGED_MESSAGE);
      return {
        result: result('breeze_origin_diverged', line.remotePaymentId, line.remoteInvoiceId, inv.id, owned.breezeEntityId),
        audit: divergedAudit(inv, line, owned.breezeEntityId, 'allocation_moved'),
      };
    }
    const pay = owned.remoteEntityId ? null : await loadPaymentRow(owned.breezeEntityId);
    const adoptable = owned.remoteEntityId === null
      && owned.pendingOp === 'push'
      && owned.syncStatus === 'pending'
      && pay !== null
      && pay.invoiceId === inv.id
      && pay.amount === normalized.amount;
    if (!adoptable) {
      return noAudit(result('skipped_breeze_origin', line.remotePaymentId, line.remoteInvoiceId, inv.id, owned.breezeEntityId));
    }

    const adopted = await db
      .update(accountingEntityMappings)
      .set({
        remoteEntityId: remoteMappingId,
        remoteSyncToken: line.remotePaymentSyncToken,
        linkStatus: 'confirmed',
        syncStatus: 'synced',
        pendingOp: null,
        claimedAt: null,
        lastError: null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(accountingEntityMappings.id, owned.id),
        eq(accountingEntityMappings.partnerId, conn.partnerId),
        // Guarded: only a still-unclaimed row may be adopted. A push job's phase 2
        // that landed a microsecond ago must win, not be overwritten.
        isNull(accountingEntityMappings.remoteEntityId),
      ))
      .returning({ id: accountingEntityMappings.id });
    if (adopted.length !== 1) {
      return noAudit(result('skipped_breeze_origin', line.remotePaymentId, line.remoteInvoiceId, inv.id, owned.breezeEntityId));
    }
    // No recompute: the payment row already exists and already counted.
    return {
      result: result('adopted', line.remotePaymentId, line.remoteInvoiceId, inv.id, owned.breezeEntityId),
      audit: {
        orgId: inv.orgId,
        action: 'accounting.payment.adopted',
        resourceId: inv.id,
        details: {
          remotePaymentId: line.remotePaymentId,
          remoteInvoiceId: line.remoteInvoiceId,
          invoicePaymentId: owned.breezeEntityId,
          amount: normalized.amount,
          currency: normalized.currencyCode,
        },
      },
    };
  }
```

plus the three new helpers:

```ts
/**
 * The echo of a payment Breeze itself pushed (spec decision 5).
 *
 * The token is stored in EVERY branch, including the diverged one: a later
 * corrective delete needs the CURRENT SyncToken, and refusing to record it would
 * make that delete fail with a stale-object fault forever.
 */
async function applyBreezeOriginEcho(
  conn: AccountingConnection,
  line: ChangeSetPaymentLine,
  existing: MappingRow,
  normalized: NormalizedAccountingPayment,
  inv: InvoiceRow,
): Promise<ApplyOutcome> {
  const noAudit = (r: PaymentPullResult): ApplyOutcome => ({ result: r, audit: null });

  if (existing.remoteSyncToken === line.remotePaymentSyncToken) {
    return noAudit(result('replayed', line.remotePaymentId, line.remoteInvoiceId, inv.id, existing.breezeEntityId));
  }

  const pay = await loadPaymentRow(existing.breezeEntityId);
  const unchanged = pay !== null && pay.amount === normalized.amount;

  const stored = await db
    .update(accountingEntityMappings)
    .set({ remoteSyncToken: line.remotePaymentSyncToken, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, existing.id),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (stored.length !== 1) {
    throw new Error(`accountingPaymentPull: storing the echoed SyncToken matched no row (id=${existing.id})`);
  }

  if (unchanged) {
    // A token bump with no financial change — QuickBooks re-saved the Payment
    // (a memo edit, a deposit). Nothing to do, and NOT an error.
    return noAudit(result('replayed', line.remotePaymentId, line.remoteInvoiceId, inv.id, existing.breezeEntityId));
  }

  await markPaymentMappingDiverged(conn, existing.id, BREEZE_ORIGIN_DIVERGED_MESSAGE);
  return {
    result: result('breeze_origin_diverged', line.remotePaymentId, line.remoteInvoiceId, inv.id, existing.breezeEntityId),
    audit: divergedAudit(inv, line, existing.breezeEntityId, 'amount_changed'),
  };
}

/** The `payment` mapping row for one Breeze payment id, scoped to this connection. */
async function loadPaymentMappingByBreezeId(
  conn: AccountingConnection, invoicePaymentId: string,
): Promise<MappingRow | null> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.integrationId, conn.id),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      eq(accountingEntityMappings.breezeEntityId, invoicePaymentId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

/** Flips a PAYMENT mapping row to error. Never touches remote_entity_id or
 *  link_status: the link back to QuickBooks must survive the divergence so a
 *  human can compare the two records. */
async function markPaymentMappingDiverged(
  conn: AccountingConnection, mappingId: string, message: string,
): Promise<void> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({ syncStatus: 'error', lastError: message, pendingOp: null, claimedAt: null, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (rows.length !== 1) {
    throw new Error(`accountingPaymentPull: divergence marker matched no row (id=${mappingId})`);
  }
}

function divergedAudit(
  inv: InvoiceRow, line: ChangeSetPaymentLine, invoicePaymentId: string, reason: 'amount_changed' | 'allocation_moved',
): PendingAudit {
  return {
    orgId: inv.orgId,
    action: 'accounting.payment.diverged',
    resourceId: inv.id,
    details: {
      remotePaymentId: line.remotePaymentId,
      remoteInvoiceId: line.remoteInvoiceId,
      invoicePaymentId,
      remoteAmountMinor: line.amountMinor,
      reason,
    },
  };
}
```

Import `NormalizedAccountingPayment` as a type from `./accountingCurrency` and `isNull` from `drizzle-orm`.

- [ ] **Step 5: Implement the reversal and self-void branches.**

In `reverseOneInsideTransaction`, immediately after the realm guard (`:777`) and BEFORE the unlocked payment read:

```ts
  // A Payment BREEZE created that somebody removed in QuickBooks. The Breeze
  // payment row SURVIVES: the money really moved (a Stripe charge, a cheque),
  // and deleting Breeze's record because the accounting mirror was removed would
  // destroy the evidence of a real receipt. Clearing remote_entity_id makes the
  // payment re-pushable; the error puts the decision in front of a human.
  // `reverseStaleAllocations` reaches the same branch, which is why a dropped
  // allocation on a Breeze-origin payment is a divergence, not a reversal.
  if (mapping.breezeOrigin) {
    const marked = await db
      .update(accountingEntityMappings)
      .set({
        syncStatus: 'error',
        lastError: BREEZE_ORIGIN_REMOVED_MESSAGE,
        remoteEntityId: null,
        remoteSyncToken: null,
        pendingOp: null,
        claimedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(accountingEntityMappings.id, mapping.id),
        eq(accountingEntityMappings.partnerId, conn.partnerId),
      ))
      .returning({ id: accountingEntityMappings.id });
    if (marked.length !== 1) {
      throw new Error(`accountingPaymentPull: Breeze-origin removal marker matched no row (id=${mapping.id})`);
    }
    return {
      result: result('breeze_origin_removed_remotely', remotePaymentId, remoteInvoiceId, null, mapping.breezeEntityId),
      audit: null,
    };
  }
```

Replace `markInvoiceDeletedRemotely` (`:869-884`):

```ts
export async function markInvoiceDeletedRemotely(
  conn: AccountingConnection,
  remoteInvoiceId: string,
  runInDbContext: DbContextRunner,
  expectedRealmFingerprint: string | null,
): Promise<'marked' | 'skipped_unmapped' | 'realm_changed' | 'invoice_void'> {
  assertNoAmbientDbContext('markInvoiceDeletedRemotely');

  return runInDbContext(async () => {
    if (!await realmStillMatches(conn, expectedRealmFingerprint)) return 'realm_changed';
    const mapping = await loadMappingByRemoteId(conn, 'invoice', 'Invoice', remoteInvoiceId);
    if (!mapping) return 'skipped_unmapped';

    // SELF-VOID GUARD (Phase D2). Breeze's own void job voids the invoice in
    // QuickBooks, and CDC reports that void as a deletion — so without this the
    // operator voids an invoice in Breeze and, seconds later, the mapping card
    // shows the alarming "Deleted in QuickBooks". A Breeze invoice that is
    // ALREADY void is the author of this notification, not its victim.
    const rows = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.id, mapping.breezeEntityId), eq(invoices.partnerId, conn.partnerId)));
    if ((rows as Array<{ status: string }>)[0]?.status === 'void') return 'invoice_void';

    await markInvoiceMappingError(conn, mapping.id, BREEZE_ORIGIN_REMOVED_MESSAGE);
    return 'marked';
  });
}
```

- [ ] **Step 6: Run to verify pass.**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingPaymentPull.test.ts`
Expected: PASS.

- [ ] **Step 7: Tally the new outcomes in the reconcile worker.**

In `apps/api/src/jobs/accountingReconcileWorker.ts`, add to `ReconcileRunSummary` (`:98-122`):

```ts
  /** Breeze-created Payments whose lost create response the echo recovered. */
  adopted: number;
  /** Breeze-origin payments QuickBooks edited. Recorded, not applied. */
  breezeOriginDiverged: number;
  /** Breeze-origin lines the pull deliberately left to the push/delete job. */
  skippedBreezeOrigin: number;
  /** New QuickBooks-origin imports suppressed because pull_payments is off. */
  skippedPullDisabled: number;
  /** Breeze-created Payments somebody removed in QuickBooks. */
  breezeOriginRemovedRemotely: number;
  /** CDC "deleted" invoices that were Breeze's OWN void echoing back. */
  invoicesSelfVoided: number;
```

zero them in `emptySummary` (`:141-156`), add the five arms to `tally` (`:164-176`), add all six to `logRunLine` (`:195-214`), and extend the `markInvoiceDeletedRemotely` arm (`:254-257`):

```ts
    for (const remoteInvoiceId of changes.deletedInvoices) {
      const outcome = await markInvoiceDeletedRemotely(fresh, remoteInvoiceId, runInDbContext, expectedRealmFingerprint);
      if (outcome === 'marked') summary.invoicesMarkedDeleted++;
      else if (outcome === 'invoice_void') summary.invoicesSelfVoided++;
    }
```

- [ ] **Step 8: RED then GREEN — the worker tally test.**

Add to `apps/api/src/jobs/accountingReconcileWorker.test.ts`:

```ts
it('tallies every Phase D2 outcome and still advances the cursor — all five are CLEAN', async () => {
  applyAccountingPaymentMock
    .mockResolvedValueOnce({ outcome: 'adopted' })
    .mockResolvedValueOnce({ outcome: 'breeze_origin_diverged' })
    .mockResolvedValueOnce({ outcome: 'skipped_breeze_origin' })
    .mockResolvedValueOnce({ outcome: 'skipped_pull_disabled' });
  reverseAccountingPaymentMock.mockResolvedValue([{ outcome: 'breeze_origin_removed_remotely' }]);
  markInvoiceDeletedRemotelyMock.mockResolvedValue('invoice_void');
  reconcileChangesMock.mockResolvedValue({
    ...EMPTY_CHANGESET, deletedInvoices: ['145'], deletedPayments: ['181'],
    payments: [paymentLine(), paymentLine(), paymentLine(), paymentLine()],
  });

  const summary = await processReconcileConnectionJob({ type: 'reconcile-connection', connectionId: 'c1', partnerId: 'p1', trigger: 'sweep' });

  expect(summary).toMatchObject({
    adopted: 1, breezeOriginDiverged: 1, skippedBreezeOrigin: 1, skippedPullDisabled: 1,
    breezeOriginRemovedRemotely: 1, invoicesSelfVoided: 1, invoicesMarkedDeleted: 0, failed: 0,
  });
  expect(advanceReconcileCursorMock).toHaveBeenCalled();
});
```

Run: `cd apps/api && npx vitest run src/jobs/accountingReconcileWorker.test.ts` — RED first (the counters do not exist), then GREEN after Step 7.

- [ ] **Step 9: Run the whole accounting unit surface.**

Run: `cd apps/api && npx vitest run src/services/accounting src/jobs/accountingSyncWorker.test.ts src/jobs/accountingReconcileWorker.test.ts`
Expected: PASS. (Bare substring, no trailing slash — `src/services/accounting/` would silently skip nothing here, but the bare form is the habit the repo's test rules ask for; check the reported file count covers all of `accountingPaymentPush`, `accountingPaymentPull`, `accountingPaymentMarker`, `accountingInvoicePush`, `accountingMappingService`, `accountingConnectionService`, `accountingCurrency`, `quickbooksProvider`, `types`, `accountingInvoicePushCallSites`.)

- [ ] **Step 10: Commit.**

```bash
git add -A && git commit -m "feat(accounting): CDC adoption, Breeze-origin echo rules and the invoice self-void guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ"
```

---

### Task 7: Settings route and web — the `pushPayments` toggle and per-payment sync badges

**Files:**
- Modify: `apps/api/src/routes/accounting/index.ts:95-106` (`settingsSchema`), `:224-244` (`requireInvoicePushForSyncSwitches`), `:591-631` (`GET /:provider`), `:688-719` (`PATCH /:provider/settings`)
- Modify: `apps/api/src/routes/accounting/index.test.ts` (extend — or the accounting route suite that exists)
- Modify: `apps/web/src/components/integrations/QuickbooksIntegration.tsx:29-57` (status shape), `:254-289` (handler, as the template), `:555-591` (toggle JSX, as the template)
- Modify: `apps/web/src/components/integrations/QuickbooksIntegration.test.tsx`
- Modify: `apps/web/src/components/billing/invoiceTypes.ts:145-159`
- Modify: `apps/web/src/components/billing/InvoiceDetail.tsx:539-582`
- Modify: `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json` (`quickbooksIntegration`, after `pullPayments*`) and `.../billing.json` (`invoiceDetail.payments`)

**Interfaces:**
- Consumes: `GET /accounting/quickbooks` → `pushPayments: boolean`; `PATCH /accounting/quickbooks/settings` accepts `{ pushPayments }`; `listPayments`'s `accountingSync` (Task 5).
- Produces:
```ts
// invoiceTypes.ts — InvoicePayment gains
accountingSync?: {
  status: 'pending' | 'synced' | 'error' | 'synced_with_tax_variance';
  lastError: string | null;
} | null;
// QuickbooksIntegration.tsx — QuickbooksStatus gains
pushPayments?: boolean;
// and one handler, through runAction
async function handleSetPushPayments(next: boolean): Promise<void>;
```
New `data-testid`s: `quickbooks-pushpayments` (the toggle), `invoice-payment-qbosync-${p.id}` (the badge).
New i18n keys — `integrations.json` under `quickbooksIntegration`: `pushPayments`, `pushPaymentsDescription`, `pushPaymentsEnabled`, `pushPaymentsDisabled`, `failedToUpdatePushPayments`. `billing.json` under `invoiceDetail.payments`: `inQuickbooks`, `syncingToQuickbooks`, `quickbooksSyncFailed`.

- [ ] **Step 1: RED — route tests.**

Add to the accounting routes suite:

```ts
it('PATCH accepts pushPayments and echoes the persisted value', async () => {
  const res = await client.patch('/accounting/quickbooks/settings', { pushPayments: false });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ pushPayments: false });
});

it('PATCH pushPayments requires invoices:write, like pushMode and pullPayments (finding D)', async () => {
  // Switching outbound money writes off is the same authority as switching
  // inbound ones off; a partner admin without invoices:write must not do either.
  withoutPermission('invoices', 'write');
  const res = await client.patch('/accounting/quickbooks/settings', { pushPayments: false });
  expect(res.status).toBe(403);
});

it('GET returns pushPayments, and defaults it true when no connection exists', async () => {
  expect(await (await client.get('/accounting/quickbooks')).json()).toMatchObject({ pushPayments: true });
  await disconnect();
  expect(await (await client.get('/accounting/quickbooks')).json()).toMatchObject({ pushPayments: true });
});
```

Run: `cd apps/api && npx vitest run src/routes/accounting` — expect FAIL (`pushPayments` is stripped by the schema, absent from both responses).

- [ ] **Step 2: Implement the route changes.**

`settingsSchema` (`:95-106`) gains, next to `pullPayments`:

```ts
  // Phase D2 — whether Breeze pushes its own payments INTO QuickBooks for this
  // connection. Same tier as pushMode/pullPayments: a plain connection setting,
  // not a captured external fact.
  pushPayments: z.boolean().optional(),
```

`SettingsWriteJsonInput` (`:235`) becomes `{ pushMode?: 'auto' | 'manual'; pullPayments?: boolean; pushPayments?: boolean }`, and the guard (`:242`):

```ts
  if (!('pushMode' in body) && !('pullPayments' in body) && !('pushPayments' in body)) return next();
```

with the doc comment above it extended: *"…or flip `pushPayments` off and silently stop every Breeze payment from reaching the books. All three are the same authority the manual/bulk push routes require."*

`PATCH` gains one spread (`:700`) and one returning column (`:714`):

```ts
// inside `.set({ ... })`, after the existing pullPayments spread at `:700`:
      ...('pushPayments' in body ? { pushPayments: body.pushPayments } : {}),

// inside `.returning({ ... })`, after the existing pullPayments column at `:714`:
      pushPayments: accountingConnections.pushPayments,
```

`GET` gains `pushPayments: true,` in the disconnected shape (`:608`) and `pushPayments: connection.pushPayments,` in the connected one (`:628`).

Run: `cd apps/api && npx vitest run src/routes/accounting` — expect PASS.

- [ ] **Step 3: RED — web component tests.**

Add to `apps/web/src/components/integrations/QuickbooksIntegration.test.tsx` (its harness at `:1-49` mocks `fetchWithAuth`, `showToast`, `usePermissions` and `getJwtClaims`; reuse it):

```ts
it("renders the push-payments toggle from the server's value and PATCHes on click", async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonResponse({ ...connected, pushPayments: true }));
  render(<QuickbooksIntegration />);
  const toggle = await screen.findByTestId("quickbooks-pushpayments");
  expect(toggle).toHaveAttribute("aria-checked", "true");

  fetchWithAuth.mockResolvedValueOnce(jsonResponse({ ...connected, pushPayments: false }));
  fireEvent.click(toggle);
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
    "/accounting/quickbooks/settings",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ pushPayments: false }) }),
  ));
  await waitFor(() => expect(screen.getByTestId("quickbooks-pushpayments")).toHaveAttribute("aria-checked", "false"));
});

it("reverts the switch and toasts on a failed PATCH — it never renders optimistically", async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonResponse({ ...connected, pushPayments: true }));
  render(<QuickbooksIntegration />);
  const toggle = await screen.findByTestId("quickbooks-pushpayments");
  fetchWithAuth.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 500));
  fireEvent.click(toggle);
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })));
  expect(screen.getByTestId("quickbooks-pushpayments")).toHaveAttribute("aria-checked", "true");
});

it("hides the push-payments toggle without invoices:write", async () => {
  canWriteInvoices = false;
  fetchWithAuth.mockResolvedValueOnce(jsonResponse({ ...connected, pushPayments: true }));
  render(<QuickbooksIntegration />);
  await screen.findByTestId("quickbooks-pushmode-auto");
  expect(screen.queryByTestId("quickbooks-pushpayments")).toBeNull();
});
```

and to the `InvoiceDetail` payments tests:

```ts
it('badges a synced Breeze-origin payment and STILL offers the reverse button', async () => {
  // The push does not transfer ownership: Breeze created this payment, so it
  // stays hand-voidable — and the void propagates the deletion to QuickBooks.
  renderDetail({ payments: [{ ...payment(), source: 'manual', accountingSync: { status: 'synced', lastError: null } }] });
  expect(screen.getByTestId(`invoice-payment-qbosync-${PAYMENT_ID}`)).toHaveTextContent('In QuickBooks');
  expect(screen.getByTestId(`invoice-payment-void-${PAYMENT_ID}`)).toBeInTheDocument();
});

it('shows a pending payment as syncing', async () => {
  renderDetail({ payments: [{ ...payment(), source: 'manual', accountingSync: { status: 'pending', lastError: null } }] });
  expect(screen.getByTestId(`invoice-payment-qbosync-${PAYMENT_ID}`)).toHaveTextContent('Syncing');
});

it('surfaces the sync error text on a failed push', async () => {
  renderDetail({ payments: [{ ...payment(), source: 'stripe', accountingSync: { status: 'error', lastError: 'QuickBooks rejected the payment sync (HTTP 400)' } }] });
  const badge = screen.getByTestId(`invoice-payment-qbosync-${PAYMENT_ID}`);
  expect(badge).toHaveTextContent('QuickBooks sync failed');
  expect(badge).toHaveAttribute('title', 'QuickBooks rejected the payment sync (HTTP 400)');
});

it('renders no sync badge when a payment has no mapping', async () => {
  renderDetail({ payments: [{ ...payment(), source: 'manual', accountingSync: null }] });
  expect(screen.queryByTestId(`invoice-payment-qbosync-${PAYMENT_ID}`)).toBeNull();
});

it('keeps a QuickBooks-ORIGIN payment un-voidable (unchanged Phase D behaviour)', async () => {
  renderDetail({ payments: [{ ...payment(), source: 'quickbooks', accountingSync: null }] });
  expect(screen.getByTestId(`invoice-payment-quickbooks-${PAYMENT_ID}`)).toBeInTheDocument();
  expect(screen.queryByTestId(`invoice-payment-void-${PAYMENT_ID}`)).toBeNull();
});
```

Run: `cd apps/web && npx vitest run src/components/integrations/QuickbooksIntegration.test.tsx src/components/billing/InvoiceDetail` — expect FAIL.

- [ ] **Step 4: Implement the web changes.**

`apps/web/src/components/billing/invoiceTypes.ts:158` — add after `source`:

```ts
  /** QuickBooks push state for a BREEZE-ORIGIN payment (Phase D2). Null when the
   *  payment has no QuickBooks mapping, and always null for `source: 'quickbooks'`
   *  (that badge already says QuickBooks owns the row). */
  accountingSync?: {
    status: 'pending' | 'synced' | 'error' | 'synced_with_tax_variance';
    lastError: string | null;
  } | null;
```

`QuickbooksIntegration.tsx` — add `pushPayments?: boolean;` to `QuickbooksStatus` (`:29-57`), a `savingPushPayments` state beside `savingPullPayments`, and the handler immediately after `handleSetPullPayments` (`:289`):

```tsx
  // Same non-optimistic shape as handleSetPullPayments above: the switch renders
  // from the SERVER's echoed value, so a rejected PATCH leaves it showing the
  // setting QuickBooks actually still has rather than a lie the operator then
  // acts on. This one gates OUTBOUND money writes, which makes the honesty
  // matter more, not less.
  const handleSetPushPayments = useCallback(
    async (next: boolean) => {
      if (savingPushPayments || (status?.pushPayments ?? false) === next) return;
      setSavingPushPayments(true);
      try {
        const updated = await runAction<QuickbooksStatus>({
          request: () =>
            fetchWithAuth("/accounting/quickbooks/settings", {
              method: "PATCH",
              body: JSON.stringify({ pushPayments: next }),
            }),
          errorFallback: t("quickbooksIntegration.failedToUpdatePushPayments"),
          successMessage: next
            ? t("quickbooksIntegration.pushPaymentsEnabled")
            : t("quickbooksIntegration.pushPaymentsDisabled"),
          onUnauthorized,
        });
        setStatus((prev) =>
          prev ? { ...prev, pushPayments: updated.pushPayments } : prev,
        );
      } catch (err) {
        if (isMfaError(err))
          setLoadError(t("quickbooksIntegration.mfaRequiredHint"));
        else if (!(err instanceof ActionError))
          handleActionError(
            err,
            t("quickbooksIntegration.failedToUpdatePushPayments"),
          );
      } finally {
        setSavingPushPayments(false);
      }
    },
    [savingPushPayments, status?.pushPayments, onUnauthorized],
  );
```

and the toggle immediately after the pull-payments block (`:591`), same markup with `pushPayments`/`savingPushPayments`/`quickbooks-pushpayments` substituted:

```tsx
          {/* Phase D2: the outbound half. Sits under the pull toggle so the two
              read as one direction-of-travel pair. */}
          {canWriteInvoices && (
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                {t("quickbooksIntegration.pushPayments")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("quickbooksIntegration.pushPaymentsDescription")}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={status.pushPayments === true}
              aria-label={t("quickbooksIntegration.pushPayments")}
              onClick={() =>
                void handleSetPushPayments(status.pushPayments !== true)
              }
              disabled={savingPushPayments}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:opacity-50 ${
                status.pushPayments === true ? "bg-emerald-500/80" : "bg-muted"
              }`}
              data-testid="quickbooks-pushpayments"
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white transition ${
                  status.pushPayments === true
                    ? "translate-x-5"
                    : "translate-x-1"
                }`}
              />
            </button>
          </div>
          )}
```

`InvoiceDetail.tsx` — add one badge inside the badge span, after the `quickbooks` badge (`:560`):

```tsx
                      {p.accountingSync && (
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                            p.accountingSync.status === 'error'
                              ? 'border-destructive/40 bg-destructive/10 text-destructive'
                              : 'border-border bg-muted text-muted-foreground'
                          }`}
                          data-testid={`invoice-payment-qbosync-${p.id}`}
                          title={p.accountingSync.lastError ?? undefined}
                        >
                          {p.accountingSync.status === 'error'
                            ? t('invoiceDetail.payments.quickbooksSyncFailed')
                            : p.accountingSync.status === 'pending'
                              ? t('invoiceDetail.payments.syncingToQuickbooks')
                              : t('invoiceDetail.payments.inQuickbooks')}
                        </span>
                      )}
```

The void button branch at `:566-579` is deliberately UNCHANGED: a Breeze-origin payment stays hand-voidable in every sync state, and the void is what propagates the deletion to QuickBooks.

- [ ] **Step 5: i18n in all 8 locales.**

Add to `integrations.json` → `quickbooksIntegration`, and to `billing.json` → `invoiceDetail.payments`:

| key | en | de-DE | es-419 | fr-CA | fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|---|
| `pushPayments` | Payment push | Zahlungsübertragung | Envío de pagos | Envoi des paiements | Envoi des paiements | Invio dei pagamenti | Envio de pagamentos | Ödeme gönderimi |
| `pushPaymentsDescription` | Send payments recorded in Breeze to QuickBooks, and remove them there when they are voided. | In Breeze erfasste Zahlungen an QuickBooks senden und dort entfernen, wenn sie storniert werden. | Enviar a QuickBooks los pagos registrados en Breeze y eliminarlos allí cuando se anulen. | Envoyer dans QuickBooks les paiements saisis dans Breeze et les y supprimer lorsqu'ils sont annulés. | Envoyer vers QuickBooks les paiements enregistrés dans Breeze et les y supprimer en cas d'annulation. | Invia a QuickBooks i pagamenti registrati in Breeze e rimuovili quando vengono annullati. | Enviar ao QuickBooks os pagamentos registrados no Breeze e removê-los quando forem estornados. | Breeze'de kaydedilen ödemeleri QuickBooks'a gönder ve iptal edildiklerinde oradan kaldır. |
| `pushPaymentsEnabled` | Payments will be sent to QuickBooks | Zahlungen werden an QuickBooks gesendet | Los pagos se enviarán a QuickBooks | Les paiements seront envoyés dans QuickBooks | Les paiements seront envoyés vers QuickBooks | I pagamenti verranno inviati a QuickBooks | Os pagamentos serão enviados ao QuickBooks | Ödemeler QuickBooks'a gönderilecek |
| `pushPaymentsDisabled` | Payments will no longer be sent to QuickBooks | Zahlungen werden nicht mehr an QuickBooks gesendet | Los pagos ya no se enviarán a QuickBooks | Les paiements ne seront plus envoyés dans QuickBooks | Les paiements ne seront plus envoyés vers QuickBooks | I pagamenti non verranno più inviati a QuickBooks | Os pagamentos não serão mais enviados ao QuickBooks | Ödemeler artık QuickBooks'a gönderilmeyecek |
| `failedToUpdatePushPayments` | Failed to update the payment push setting. | Die Einstellung für die Zahlungsübertragung konnte nicht aktualisiert werden. | No se pudo actualizar la configuración de envío de pagos. | Impossible de mettre à jour le paramètre d'envoi des paiements. | Impossible de mettre à jour le paramètre d'envoi des paiements. | Impossibile aggiornare l'impostazione di invio dei pagamenti. | Não foi possível atualizar a configuração de envio de pagamentos. | Ödeme gönderimi ayarı güncellenemedi. |
| `inQuickbooks` | In QuickBooks | In QuickBooks vorhanden | En QuickBooks | Dans QuickBooks | Dans QuickBooks | Presente in QuickBooks | No QuickBooks | QuickBooks'ta |
| `syncingToQuickbooks` | Syncing… | Wird synchronisiert… | Sincronizando… | Synchronisation… | Synchronisation… | Sincronizzazione… | Sincronizando… | Eşitleniyor… |
| `quickbooksSyncFailed` | QuickBooks sync failed | QuickBooks-Synchronisierung fehlgeschlagen | Error de sincronización con QuickBooks | Échec de la synchronisation QuickBooks | Échec de la synchronisation QuickBooks | Sincronizzazione con QuickBooks non riuscita | Falha na sincronização com o QuickBooks | QuickBooks eşitlemesi başarısız oldu |

None of the non-English values repeats its English counterpart, so `namespaceDuplicateBaselines` (`translationCoverage.test.ts:15`) is not moved — do not edit those baselines.

- [ ] **Step 6: Run to verify pass.**

Run: `cd apps/web && npx vitest run src/components/integrations/QuickbooksIntegration.test.tsx src/components/billing src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/translationCoverage.test.ts`
Expected: PASS. `no-silent-mutations` needs no counter change — `QuickbooksIntegration.tsx` is already in `TARGET_GLOBS` (`:226`) and the `108` at `:528` counts files, not handlers.

- [ ] **Step 7: Commit.**

```bash
git add -A && git commit -m "feat(web): QuickBooks push-payments toggle and per-payment sync badges

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ"
```

---

### Task 8: The real-Postgres integration suite

**Files:**
- Create: `apps/api/src/__tests__/integration/accountingPaymentPush.integration.test.ts`

**Interfaces:**
- Consumes: `./setup`, `createPartner` / `createOrganization` / `createUser` (`./db-utils`), `upsertConnection` (`accountingConnectionService`), everything Tasks 1-6 export. Mirrors the harness of `accountingPaymentPull.integration.test.ts:1-134` — `import './setup'`, `const runDb = it.runIf(!!process.env.DATABASE_URL)`, a `systemRunner: DbContextRunner`, and `seedFixture`/`seedInvoice`/`seedInvoiceMapping` built from raw Drizzle inserts inside `withSystemDbAccessContext`.
- Produces: no code contracts.

**Why only this suite can prove these:** the mapping-row outbox, the lease CAS, the `pending_op` CHECK, the partner guard trigger's INSERT-only firing (which is what lets a `delete` row outlive its payment), the `breeze_uniq` index behind `onConflictDoNothing`, and `recomputeInvoiceStatus`'s real `paid_at` behaviour are all database facts. A mocked `db` asserts the SQL Breeze *meant* to write.

- [ ] **Step 1: Write the suite.**

```ts
/**
 * QuickBooks payment PUSH against real Postgres (Phase D2).
 *
 * What only this file can prove: the mapping row really is written in the SAME
 * transaction as the payment (roll the transaction back and neither exists); the
 * lease CAS really excludes a second worker; a `pending_op='delete'` row really
 * survives the deletion of its `invoice_payments` target (the partner guard
 * trigger fires only on INSERT and UPDATE OF partner_id/entity_type/entity_id);
 * `paid_at` really is cleared by a reversal; and a cross-partner mapping forge
 * really is refused by the trigger with 23514.
 */
import { describe, expect, it, vi } from 'vitest';
import './setup';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { accountingEntityMappings, invoicePayments, invoices } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import type { DbContextRunner } from '../../services/accounting/dbContextGuard';
import {
  requestPaymentPush, requestPaymentDelete, pushPaymentToAccounting,
  deletePaymentInAccounting, fanOutOwedPayments, listOwedPaymentMappings,
  PAYMENT_CLAIM_LEASE_MS,
} from '../../services/accounting/accountingPaymentPush';
import { applyAccountingPayment, reverseAccountingPayment } from '../../services/accounting/accountingPaymentPull';
import { recordPayment, voidPayment, listPayments, recomputeInvoiceStatus } from '../../services/invoiceService';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const systemRunner: DbContextRunner = (fn) => withSystemDbAccessContext(fn, 'accountingPaymentPush.test');
```

Seed helpers mirror the pull suite's (`seedFixture` → partner + org + user + a `connected` USD connection with `pushPayments: true`; `seedInvoice` → an issued `sent` invoice; `seedInvoiceMapping` → a `synced` invoice mapping with `remoteEntityId: '145'`; `seedOrgMapping` → a `confirmed` Customer mapping with `remoteEntityId: '55'`). Stub the provider transport by spying on the object `getAccountingProvider('quickbooks')` returns (`vi.spyOn(provider, 'createPayment')`), NOT by mocking `fetch` — this suite is about the database, and the provider's own wire format is already pinned by Task 2.

Cases, each a `runDb(...)`:

1. **`recordPayment` writes the payment and its pending mapping in ONE transaction.**
```ts
runDb('records the payment and its pending push mapping atomically', async () => {
  const f = await seedFixture();
  await recordPayment(f.invoiceId, { amount: '40.00', method: 'check', receivedAt: '2026-09-02' }, f.actor);
  const [map] = await loadPaymentMappings(f);
  expect(map).toMatchObject({
    breezeEntityType: 'payment', remoteEntityType: 'Payment', remoteEntityId: null,
    breezeOrigin: true, pendingOp: 'push', syncStatus: 'pending', linkStatus: 'create_new',
  });
});
```
2. **A rolled-back payment transaction leaves NO mapping.** Wrap `requestPaymentPush` in `db.transaction` and throw; assert zero mapping rows. This is the property that makes the outbox trustworthy.
3. **Phase 2 stamps the composite remote id.** Run `pushPaymentToAccounting` with `createPayment` stubbed to `{ id: '181', syncToken: '0' }`; assert `remote_entity_id = '181/145'`, `sync_status='synced'`, `pending_op` NULL, `claimed_at` NULL, and that a second `pushPaymentToAccounting` for the same mapping returns `'nothing_owed'` and does NOT call `createPayment` again.
4. **The lease excludes a second worker.** Claim the row by hand (`UPDATE … SET claimed_at = now()`), then `pushPaymentToAccounting` rejects with `sync_in_progress` and `createPayment` is never called. Then set `claimed_at` to `now() - PAYMENT_CLAIM_LEASE_MS - 1000` and assert the push proceeds — the lease really does expire.
5. **The echo AFTER phase 2 replays.** Feed `applyAccountingPayment` a line with `remotePaymentId: '181'`, `remoteInvoiceId: '145'`, the same token and `breezePaymentId` set; expect `'replayed'` and exactly ONE `invoice_payments` row.
6. **The echo BEFORE phase 2 adopts, and phase 2 keeps the echo's token.** Stub `createPayment` to run `applyAccountingPayment` (with `remotePaymentSyncToken: '4'`) before returning `{ id: '181', syncToken: '0' }`; assert the push returns `'already_adopted'`, the mapping holds token `'4'`, and there is still exactly one payment row.
7. **A void after a push flips to delete-pending and the row SURVIVES a failed enqueue.** Push, then `voidPayment`; assert the `invoice_payments` row is gone, the mapping row is NOT (this is the property the partner guard trigger has to permit), and it carries `pending_op='delete'` with its `remote_entity_id` intact.
8. **The sweep picks that row up.** Backdate `updated_at` past `PAYMENT_SWEEP_MIN_AGE_MS`; assert `listOwedPaymentMappings(db, new Date())` returns it with `pendingOp: 'delete'`.
9. **`deletePaymentInAccounting` removes the mapping.** Stub `deletePayment` to `'deleted'`; assert zero mapping rows afterwards.
10. **The `pending_op` CHECK rejects a bogus value.** A raw UPDATE to `pending_op = 'sideways'` fails with `23514`.
11. **A cross-partner mapping forge is refused.** Insert a `payment` mapping for partner B naming partner A's `invoice_payments` id; expect `23514` from `validate_accounting_mapping_entity_partner`.
12. **A Breeze-origin CDC delete leaves `invoice_payments` intact.** Push, then `reverseAccountingPayment(conn, '181', systemRunner, fp)`; assert the outcome is `breeze_origin_removed_remotely`, the payment row still exists, the invoice `amount_paid` is unchanged, and the mapping is `error` / `remote_entity_id` NULL.
13. **`paid_at` is cleared after a reversal (#4542).** Pay the invoice in full, assert `paid_at` is set and the status is `paid`; `voidPayment`; assert the status is back to `sent`/`partially_paid` and `paid_at` IS NULL.
14. **`listPayments` classification.** A Breeze-origin synced mapping → `source: 'manual'` with `accountingSync.status === 'synced'`; a QuickBooks-origin mapping → `source: 'quickbooks'` with `accountingSync === null`.
15. **`voidPayment` refuses a QuickBooks-origin payment.** Seed a `breeze_origin = false` mapping; expect `QUICKBOOKS_OWNED_PAYMENT` and that both the payment row and the mapping survive.
16. **`fanOutOwedPayments` is idempotent.** Two payments, no mappings → two ids; run it again → zero ids, and still exactly two mapping rows (the `breeze_uniq` index behind `onConflictDoNothing`).

- [ ] **Step 2: Run it RED first.**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/accountingPaymentPush.integration.test.ts`
Expected before Tasks 1-6 are merged into the working tree: FAIL. On this branch Tasks 1-6 are already in, so instead **prove each control fires** before trusting the green: temporarily revert one behaviour at a time (drop the `pending_op` from `requestPaymentPush`; remove the `or(isNull(claimedAt), lt(...))` from the lease; delete the `paid_at` clear) and confirm cases 1, 4 and 13 respectively go red. Restore, then re-run.

- [ ] **Step 3: Run to verify pass.**

Run (with `pnpm test-stack up` and `DATABASE_URL` exported):
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/accountingPaymentPush.integration.test.ts
```
Expected: PASS, 16 cases, none skipped. **A skipped run is not a pass** — `runDb` is `it.runIf(!!process.env.DATABASE_URL)`, so confirm the reporter says 16 passed rather than 16 skipped.

- [ ] **Step 4: Run every contract suite the spec names.**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/accountingPaymentPush.integration.test.ts \
  src/__tests__/integration/accountingPaymentPull.integration.test.ts \
  src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts \
  src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls.ts
cd apps/api && npx vitest run src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/services/accounting/accountingInvoicePushCallSites.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/db/autoMigrate.test.ts
bash scripts/check-migration-naming.sh
pnpm db:check-drift
```
Expected: all green. `rls-coverage` and the two export-policy suites must pass **without** any new registration — that is the evidence for the "no `org_id`, so no cascade work" claim in Global Constraints, not an assumption.

- [ ] **Step 5: Commit.**

```bash
git add -A && git commit -m "test(accounting): real-Postgres coverage for the QuickBooks payment push outbox and lease

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ"
```

---

### Task 9: Docs, release note, full verification, PR — then STOP

**Files:**
- Modify: `docs/integrations/quickbooks-sandbox-verification.md` (append a `### Phase D2 checklist (payment push)` section after the Phase D block, which ends at item 26; the file is 760 lines)
- Modify: `docs/release-notes/next-release-draft.md` (append one `##` section after the existing QuickBooks payment pull-back entry at `:15-54`)

**Interfaces:** consumes everything; produces no code contracts.

- [ ] **Step 1: Add the Phase D2 sandbox checklist, PENDING.**

Append to `docs/integrations/quickbooks-sandbox-verification.md`. The Phase D block (`:335`) is already closed out — **`Status: EXECUTED 2026-09-02 …`** with items 17-26 carrying `Result:` lines — so this is a NEW section continuing the numbering at 27, not an edit to that one. Use the same "**bold instruction** / Result: / Visible status:" shape, with every `Result:` left as `PENDING`:

```markdown
### Phase D2 checklist (payment push)

**Status: PENDING — not yet run.** Items 27-38 below have never been executed
against a live Intuit sandbox. Item 27 is a HARD PREREQUISITE for 28-38: without
a working Development webhook the echo/adoption cases cannot be observed at
webhook latency at all, and the 15-minute sweep is the only path left.

27. **Re-register the Development webhook URL in the Intuit developer portal
    (#4545)** and confirm the verifier handshake, exactly as Phase D item 17 did.
    The URL registered during the Phase D walk is dead; every echo case below
    depends on it.
    Result: PENDING.

28. **Record a manual payment in Breeze against an invoice already pushed to
    QuickBooks** and confirm a QuickBooks Payment appears, applied to that
    invoice, with the invoice balance dropping by the payment amount and the
    payment's `PrivateNote` reading `Breeze payment <uuid>`.
    Visible status: the payment row in Breeze shows the "In QuickBooks" badge.
    Result: PENDING.

29. **Let the webhook echo arrive** and confirm the reconcile run logs
    `replayed` (not `applied`), that NO second payment row appears in Breeze, and
    that the invoice balance is unchanged.
    Result: PENDING.

30. **Pay an invoice with a Stripe test card** and confirm the QuickBooks Payment
    carries the GROSS charge amount, has no `DepositToAccountRef` (so it lands in
    Undeposited Funds), and that its `PaymentRefNum` is the truncated
    `pi_…` reference.
    Result: PENDING.

31. **Void the Breeze payment** and confirm the QuickBooks Payment is deleted,
    the invoice balance returns, the mapping row disappears, and an
    `accounting.payment.deleted` audit entry is written.
    Result: PENDING.

32. **Delete the QuickBooks Payment by hand** and confirm the Breeze payment row
    SURVIVES, its mapping flips to `error` / "Deleted in QuickBooks" with the
    remote id cleared, and a subsequent invoice re-push re-creates the Payment.
    Result: PENDING.

33. **Edit the QuickBooks Payment's amount by hand** and confirm Breeze does NOT
    change its own payment amount, the mapping goes to `error` / "Edited in
    QuickBooks; Breeze remains the source of truth for this payment", and the
    stored SyncToken advances (so a later delete does not fail stale).
    Result: PENDING.

34. **Set `push_mode = manual`, record a payment, and confirm NOTHING is pushed.**
    Then press "Push to QuickBooks" on the invoice and confirm the invoice syncs
    first and the payment follows.
    Result: PENDING.

35. **Switch `push_payments` off, record a payment (nothing should be created),
    then void an already-pushed payment** and confirm the DELETE still
    propagates — Breeze owns the removal of what it created, regardless of the
    switch.
    Result: PENDING.

36. **Record a payment larger than the QuickBooks invoice balance** and confirm
    QuickBooks rejects it, the mapping shows the sanitized
    `QuickBooks rejected the payment sync (HTTP n)` (never a fault body), and the
    job is retried rather than marked terminal.
    Result: PENDING.

37. **Void a fully-paid invoice in Breeze** and confirm the QuickBooks Invoice is
    voided while its Payment is LEFT IN PLACE as unapplied customer credit
    (spec decision 11), and that the invoice mapping does NOT show
    "Deleted in QuickBooks" when the void echoes back (the self-void guard).
    Result: PENDING.

38. **Kill the API between the QuickBooks create and phase 2** (stop the
    container while a push job is in flight) and confirm that within one
    15-minute sweep the CDC pass ADOPTS the orphaned Payment: the mapping gains
    the remote id, no second Payment is created, and the reconcile summary
    reports `adopted=1`.
    Result: PENDING.
```

- [ ] **Step 2: Add the release-notes entry.**

Append to `docs/release-notes/next-release-draft.md`, after the existing `## QuickBooks payment pull-back (#4531, sandbox-verified in #4537)` section (which ends the file at `:54`), matching its `**Self-Hosting / Upgrade Notes**` shape:

```markdown
## QuickBooks payment push (#<PR>)

Payments recorded in Breeze against an invoice that is already in QuickBooks are
now created in QuickBooks automatically, and deleted there when the Breeze
payment is voided or fully refunded. Breeze stays the system of record for its
own payments: a payment edited in QuickBooks is flagged as diverged rather than
silently overwritten in Breeze, and a partial Stripe refund is flagged for the
bookkeeper instead of rewriting a QuickBooks receipt.

**Self-Hosting / Upgrade Notes**

- **This turns on OUTBOUND writes to QuickBooks for every connected realm at
  deploy time.** The new `accounting_connections.push_payments` column defaults
  to `true`, so a realm that is connected and in `push_mode = auto` will start
  creating QuickBooks Payments as soon as the API restarts. Set it to `false`
  first (Integrations → QuickBooks → "Payment push") on any realm whose books you
  are not ready to have Breeze write into.
- Deleting a payment propagates regardless of `push_mode` AND `push_payments`:
  once Breeze created a Payment in QuickBooks it owns its removal, so switching
  the feature off cannot strand money in the books.
- Migration `2026-10-02-110000-quickbooks-payment-push.sql` adds
  `accounting_connections.push_payments` and three columns on
  `accounting_entity_mappings` (`breeze_origin`, `pending_op`, `claimed_at`), plus
  a partial index. It backfills `breeze_origin = true` for existing invoice
  mappings and logs the count as a `WARNING`. No new tables, no RLS changes.
- No new worker and no new queue: the two job types ride the existing
  `accounting-sync` queue, and the 15-minute `accounting-reconcile` sweep gained a
  second pass that re-enqueues any mapping still owing QuickBooks work. A Redis
  outage therefore delays a push by at most one sweep — it never loses one.
- Fixes #4542: `invoices.paid_at` is now cleared whenever an invoice falls out of
  `paid` (a voided payment, a QuickBooks reversal, a refund) and on void. Existing
  rows are NOT retro-corrected; the next recompute of an affected invoice fixes it.
```

- [ ] **Step 3: Merge `origin/main` and re-verify.**

Local green is not CI green — PR CI tests the MERGE COMMIT, so merge first and re-run:

```bash
git fetch origin
git merge origin/main
ls apps/api/migrations | sort | tail -3     # confirm the new file still sorts last
bash scripts/check-migration-naming.sh
```
If `origin/main` landed a migration that now sorts AFTER `2026-10-02-110000-quickbooks-payment-push.sql`, rename this branch's file (it is unmerged, so it is still editable) and sweep every reference to the old path.

- [ ] **Step 4: Full verification sweep.**

```bash
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/accountingPaymentPush.integration.test.ts \
  src/__tests__/integration/accountingPaymentPull.integration.test.ts \
  src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts \
  src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls.ts
pnpm db:migrate && pnpm db:check-drift
pnpm lint
pnpm build --filter @breeze/api --filter @breeze/web
```
Expected: all green, `db:check-drift` clean, `pnpm lint` clean. Fix anything red before opening the PR.

- [ ] **Step 5: Open the PR — and STOP.**

```bash
git push -u origin feat/quickbooks-payment-push
gh pr create --base main --head feat/quickbooks-payment-push \
  --title "feat(accounting): QuickBooks Phase D2 — payment push" \
  --body "$(cat <<'BODY'
Implements `docs/superpowers/specs/billing/2026-09-02-quickbooks-phase-d2-payment-push-design.md`.

Payments recorded in Breeze against an invoice already in QuickBooks are created
there and deleted when the Breeze payment is voided or fully refunded. The push
is idempotent under crashes, retries and its own CDC echo.

## How it works

- **The mapping row is the outbox.** `requestPaymentPush`/`requestPaymentDelete`
  write `pending_op` in the SAME transaction as the `invoice_payments`
  insert/delete; the BullMQ enqueue that follows is a latency optimisation. The
  15-minute reconcile sweep re-enqueues any stale `pending_op` row, so a lost
  enqueue self-heals and a delete survives an exhausted BullMQ retry budget.
- **Exclusive claim by lease** (`claimed_at` compare-and-set, 10-minute window)
  rather than by upsert — the Phase C upsert only excludes racing inserts.
- **Idempotency** = QBO `requestid` (the Breeze payment uuid, 24h window) plus a
  `PrivateNote` marker `Breeze payment <uuid>`. `PrivateNote` is not queryable,
  so recovery is by ADOPTION: the CDC pull fills in the remote id when it sees a
  Payment whose note names a pending mapping. A crash between create and phase 2
  self-heals within one sweep, even past the 24h window.
- **`breeze_origin`** on the mapping row tells the pull who owns a payment. A
  CDC deletion carries no note, so origin has to be known locally.
- **Create-only.** A partial refund is a recorded divergence, never an amount
  rewrite: rewriting a QuickBooks Payment's amount would rewrite receipt history.

## Notable

- `push_payments` defaults to **true**, which turns on outbound writes for every
  connected realm at deploy time. Called out in the release-notes draft.
- Migration `2026-10-02-110000-quickbooks-payment-push.sql`: one column on
  `accounting_connections`, three on `accounting_entity_mappings`, one CHECK, one
  partial index, and a `breeze_origin` backfill run under
  `set_config('breeze.scope','system', true)` (both tables are FORCE RLS, so an
  unscoped backfill would silently match zero rows on managed Postgres).
- No `org_id` on either table, so no `tenantCascade` / export-policy /
  `orgMergeRegistry` / RLS-allowlist registration — verified by running
  `rls-coverage`, `tenantCascade` and both export-policy suites, not assumed.
- No new worker: two job types on the existing `accounting-sync` queue, so
  `workerRegistry` stays at 123.
- One `partner-wide-write-coverage` exemption for `accountingPaymentPush.ts`.
- Fixes #4542 (`paid_at` never cleared) and the pull-disabled half of #4543.

## Deviations from the brief

1. **Invoice void leaves QuickBooks payments in place** (spec decision 11) rather
   than deleting them. Deleting would assert the cash was never received;
   QuickBooks' own void leaves the Payment unapplied as customer credit, which
   mirrors Breeze keeping its payment rows. Reverting to delete-then-void is a
   contained change in the void coordinator. This also resolves the conflict
   between spec decisions 7 and 11: phase 1 REFUSES a push against an
   already-void invoice, and phase 2 stamps the remote ref normally if the
   invoice went void mid-flight.
2. **Partial refunds are flagged, not pushed** (spec decision 9). The brief left
   refunds "probably out of scope"; this makes it explicit and chooses divergence
   over amount rewriting. `RefundReceipt`/credit memos stay out of scope.
3. **`push_payments` defaults on**, as the brief asked — but it enables outbound
   money writes for every connected realm at deploy time, so it is called out in
   the release notes rather than shipped quietly.

## Not done here

The sandbox walkthrough. `docs/integrations/quickbooks-sandbox-verification.md`
gains a `### Phase D2 checklist (payment push)` section, items 27-38, all
**PENDING** — item 27 is re-registering the dead Development webhook (#4545) and
gates the rest.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ
BODY
)"
```

Then run ONE `requesting-code-review` round and fix confirmed, consequential findings inline. **Do not merge, do not deploy** — the sandbox walkthrough has to be executed against a live Intuit sandbox first, and item 27 (#4545) is a prerequisite for it.

- [ ] **Step 6: Commit the docs.**

```bash
git add -A && git commit -m "docs(accounting): Phase D2 sandbox checklist and payment-push release note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BdvjnGttKy7i5oPuGz5HnJ"
```

(Run this BEFORE Step 5's `gh pr create` — the ordering above lists the PR body last only because it summarises the docs.)

---

## Self-review notes (kept for executors)

**Spec coverage.** Decision 1 (mapping-as-outbox) → T1 columns + T3 request helpers + T4 sweep. Decision 2 (lease CAS) → T3 `claimPaymentMapping`, proved in T8 case 4. Decision 3 (`requestid` + `PrivateNote` + adoption) → T2 marker + provider `requestid`, T6 adoption branch, T8 case 6. Decision 4 (`breeze_origin`) → T1 column + backfill, T3 sets it on insert. Decision 5 (pull rules for the echo) → T6 `applyBreezeOriginEcho`, the Breeze-origin reversal branch, and `reverseStaleAllocations` reaching the same handler. Decision 6 (`pull || push` gating + `skipped_pull_disabled`) → T1 `listReconcilableConnections`, T4 gate, T6 skip + per-item log. Decision 7 (phase-2 re-read, per-operation jobIds) → T3 phase 2, T4 jobIds. Decision 8 (Stripe gross, no `DepositToAccountRef`) → T2 provider body, T5 capture hook. Decision 9 (full refund = delete, partial = divergence, no `updatePayment`) → T2 type test, T3 `diverged`, T5 `reflectStripeRefund`. Decision 10 (`push_mode` + `push_payments`, fan-out, deletes always) → T1 column, T3 gating + `fanOutOwedPayments`, T5 invoice-push hook, T7 toggle. Decision 11 (void leaves payments) → T3 `invoice_void` refusal + phase-2 stamp, T6 self-void guard, PR deviation 1. Decision 12 (delete semantics, stale retry) → T2 `deletePayment`. Decision 13 (home currency only) → T3 phase-1 currency guard. Decision 14 (`voidPayment` refuses QBO-origin, `listPayments` classification) → T5. Decision 15 (#4542) → T5 steps 1-3, T8 case 13. Data model → T1. Components table → the File Structure block. Observability (4 audit actions, worker log lines, Sentry) → T3 `fireAudit`, T4 log line, T6 audit actions. Testing section → T2/T3/T5/T6 unit steps, T8 integration, T9 sandbox. Out-of-scope items are named and untouched.

**Three ambiguities resolved, all recorded in-plan rather than silently applied.** (a) Both request helpers return `string | null`, not `boolean` — the caller needs the mapping id to enqueue (File Structure decision 1). (b) The coordinator never enqueues; `converted_to_delete` and `fanOutOwedPayments` hand ids back to the caller (decision 2). (c) Spec decisions 7 and 11 conflict on a mid-flight invoice void; decision 11 wins, stated at the head of Task 3.

**`payment_gone` is an OUTCOME, not an error code** — nothing failed and nothing is left undone, and there is no durable row left to stamp a terminal error on. The Name glossary, Task 3's `AccountingPaymentPushErrorCode`, and Task 4's `PAYMENT_TERMINAL_CODES` all agree on this: the code union carries `invoice_void` where the spec's prose listed `payment_gone`.

**Type consistency spot-checks.** `PaymentDeleteResult` (`'deleted' | 'already_absent'`, T2) is the PROVIDER's return; `PaymentDeleteOutcome` (`'deleted' | 'already_absent' | 'nothing_owed'`, T3) is the COORDINATOR's — near-identical on purpose, and T4's `processPaymentJob` only ever compares the coordinator's. `paymentMappingRemoteId(remotePaymentId, remoteInvoiceId)` (existing, `accountingPaymentPull.ts:174`) is the single builder of the composite id and is imported by T3, never re-derived. `markPaymentMappingError` (T3, on the PAYMENT row) and `markInvoiceMappingError` (existing, T6, on the INVOICE row) are different functions in different modules; only the invoice one uses `PAYMENT_PULL_ERROR_PREFIX`, because that column is shared with the push path.

**The cascade-list re-grep in Task 1 Step 9 is not optional.** It has shipped or blocked CI five times and code review has caught it 0/5. Neither touched table has an `org_id`, so the expected answer is "nothing to add" — but confirm it by running the grep and the three integration suites, not by reading this sentence.

**The migration backfill's `set_config('breeze.scope','system', true)` is load-bearing.** CI runs as a superuser and would report a truthful-looking `0` either way; managed Postgres would leave every existing invoice mapping with `breeze_origin = false`, and the pull would then treat Breeze's own invoices as QuickBooks-origin.
