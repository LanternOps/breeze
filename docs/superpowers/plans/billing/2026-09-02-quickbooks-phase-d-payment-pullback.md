# QuickBooks Phase D — Payment Pull-back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reflect payments recorded in QuickBooks Online against invoices Breeze pushed there back onto the Breeze invoice, idempotently — within seconds when Intuit's webhook reaches us, within 15 minutes when it does not. Breeze stays the system of record for the invoice; QuickBooks is the source of truth for QuickBooks-origin payments only. A QBO-origin payment deleted or voided in QBO is mirrored (row deleted, invoice recomputed, audited); manual and Stripe payments are never touched by the pull.

**Architecture:** Webhook enqueues, CDC does the work (Approach A). `POST /api/v1/webhooks/quickbooks` verifies an app-level HMAC, resolves each `realmId` to a connection through a new keyed `realm_id_fingerprint` column, and enqueues ONE per-connection `reconcile-connection` job on a new `accounting-reconcile` BullMQ queue. A 15-minute repeatable sweep enqueues the same job for every connected realm with `pull_payments = true`. The job resolves a live token with nothing held, calls `provider.reconcileChanges` (QBO CDC) outside any DB context, then applies each change through `accountingPaymentPull.ts` — one short self-committing context per item, invoice row locked FIRST. One job type, one applier, one code path for webhook, sweep, replay and "Sync now".

**Tech Stack:** Hono, Drizzle, BullMQ, Vitest (unit + real-Postgres integration), React (web), QBO REST v3 `minorversion=70` CDC.

**Spec:** `docs/superpowers/specs/billing/2026-09-02-quickbooks-phase-d-payment-pullback-design.md` (binding). The in-code contract at `apps/api/src/services/accounting/accountingCurrency.ts:143-186` **item 4** is the payment applier's ordering + at-most-once contract; this plan satisfies it and Task 8 marks it delivered. Parent spec: `docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md` (§ Pull-back: Payment). Builds on Phase B (#4372) and Phase C (#4492).

## Global Constraints

- Branch `feat/quickbooks-payment-pullback`, based on `origin/main` at `1f67eb345`. **Commit this plan file as the first commit.**
- **No DB context may be open across any QuickBooks HTTP call.** Every entry point that brackets a QBO call with DB work calls `assertNoAmbientDbContext(<name>)` and takes a `DbContextRunner` (`apps/api/src/services/accounting/dbContextGuard.ts` — read its header before writing a line of Task 3 or 4). Sync-state writes (cursor advance, mapping error markers) commit in their OWN short context, because a savepoint inside the caller's transaction rolls back the moment the caller throws and the operator then sees no error at all.
- **Money:** major-unit decimal strings in Breeze (`numeric(12,2)`), integer minor units on the `ChangeSet`, converted **exactly once** with `fromMinorUnits` — and only through `normalizeAccountingPayment` (`accountingCurrency.ts:107-146`), which asserts currency equality BEFORE converting. Never call `fromMinorUnits` directly in the applier.
- **Never persist or rethrow a raw QBO response body.** Sanitize to `QuickBooks rejected the payment sync (HTTP <status>)` (pattern: `accountingInvoicePush.ts:243-248`).
- **Zero-row-throw on every write** (`.returning({ id })` + length check). A zero-row match is an RLS-context bug, not a no-op.
- **BullMQ jobIds contain no colons**; `removeOnComplete: true` / `removeOnFail: true` (Phase C lesson — BullMQ silently drops an `add()` whose jobId still sits in the retained completed/failed sets, so a re-enqueue after fixing a mapping became a no-op the route still reported as `enqueued`).
- Migration file MUST be named `2026-10-01-quickbooks-payment-pullback.sql`. Verified: it sorts strictly after every committed migration (`'2026-10-01-100000-script-children-rls.sql'.localeCompare('2026-10-01-quickbooks-payment-pullback.sql') === -1`; `q` > `1`). **Re-verify with `ls apps/api/migrations | sort | tail -3` before creating it** — another branch may have raised the ceiling. Idempotent; no inner `BEGIN`/`COMMIT`.
- Web mutations wrap in `runAction` (`apps/web/src/lib/runAction.ts`); all copy through `t(...)` with genuine translations in **all 8 locale dirs** (`de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`); `translationCoverage.test.ts` caps English duplicates per namespace per locale.
- Run one API unit file with `cd apps/api && npx vitest run <path>` (or `pnpm --filter @breeze/api test --run <path>` — **never** insert `--` before `--run`). Integration suites need a real DB (`pnpm test-stack up`): `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`.
- `partner-wide-write-coverage.test.ts` gains ONE exemption entry for the new applier (Task 3). Its reason string must be ≥20 characters or the test fails.
- **No new tables** → no `tenantCascade`, export-policy, `orgMergeRegistry` or RLS-allowlist registrations. The four new columns live on `accounting_connections`, which is partner-axis (`rls-coverage.integration.test.ts:216`) and outside the org cascade, so the export-policy column rule does not fire. Verified: `tenantCascade.ts:651-661` and `orgMerge.ts:841-878` already carry `breeze_entity_type = 'payment'` arms shipped by Phase C, and `orgMergeRegistry.ts:555` already repoints `invoice_payments`.

---

## File Structure

```
apps/api/migrations/2026-10-01-quickbooks-payment-pullback.sql          (new)
apps/api/src/db/schema/accounting.ts                                    (modify: 3 new columns + partial unique index)
apps/api/src/config/env.ts                                              (modify: QBO_WEBHOOK_VERIFIER_TOKEN)
apps/api/src/config/validate.ts                                         (modify: envObjectSchema entry)
apps/api/src/services/accounting/accountingConnectionService.ts         (modify: DTO + fingerprint/cursor/pull helpers)
apps/api/src/services/accounting/types.ts                               (modify: widened ChangeSet)
apps/api/src/services/accounting/quickbooksProvider.ts                  (modify: reconcileChanges — replaces the Phase D stub)
apps/api/src/services/accounting/accountingPaymentPull.ts               (new: the guarded applier)
apps/api/src/services/accounting/accountingCurrency.ts                  (modify: item 4 marked delivered — Task 8)
apps/api/src/services/invoiceService.ts                                 (modify: voidPayment mapping clear, listPayments source)
apps/api/src/services/stripeReconcile.ts                                (modify: full-refund mapping clear)
apps/api/src/jobs/accountingReconcileWorker.ts                          (new: job + 15-min sweep + enqueue helpers)
apps/api/src/services/workerRegistry.ts                                 (modify: one entry, 118 -> 119)
apps/api/src/routes/webhooks/quickbooks.ts                              (new: POST /api/v1/webhooks/quickbooks)
apps/api/src/index.ts                                                   (modify: mount, next to the Stripe webhook)
apps/api/src/routes/accounting/index.ts                                 (modify: pullPayments setting, GET fields, POST /:provider/reconcile)
apps/api/src/__tests__/partner-wide-write-coverage.test.ts               (modify: one exemption entry)
apps/api/src/__tests__/integration/accountingPaymentPull.integration.test.ts       (new)
apps/api/src/__tests__/integration/accountingRealmFingerprint.integration.test.ts  (new)
apps/web/src/components/integrations/QuickbooksIntegration.tsx          (modify: toggle, last-sync line, Sync now)
apps/web/src/components/billing/InvoiceDetail.tsx                       (modify: QuickBooks badge + void suppression)
apps/web/src/components/billing/invoiceTypes.ts                         (modify: source union)
apps/web/src/components/billing/AccountingSyncCard.test.tsx             (modify: pin the "Deleted in QuickBooks" copy path)
apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/{billing,integrations}.json  (modify)
apps/web/src/lib/__tests__/no-silent-mutations.test.ts                  (modify: TARGET_GLOBS + counter 107 -> 108)
docs/integrations/quickbooks-sandbox-verification.md                    (modify: Phase D checklist, items 17-23)
apps/docs/src/content/docs/features/accounting-integrations.mdx         (modify: pull-back section)
```

Decisions locked here (do not relitigate mid-task):

1. **Composite remote id.** A pulled payment's mapping row carries `remote_entity_id = '<PaymentId>/<remoteInvoiceId>'`. One QBO Payment split across several Breeze invoices then satisfies the existing `accounting_entity_mappings_remote_uniq` index `(integration_id, remote_entity_type, remote_entity_id)`, and reversal looks up `remote_entity_id LIKE '<PaymentId>/%'` scoped to the connection. This REFINES `accountingCurrency.ts` item 4's phrase "the unique (connection, remotePaymentId) mapping": a bare `remotePaymentId` cannot represent a split payment. Task 8 updates that comment to say so.
2. **Over-payment is allowed by the applier**, deliberately, and it is a real divergence from `invoiceService.recordPayment` (`invoiceService.ts:1418-1420` throws `OVERPAYMENT` when `amountCents > balanceCents`). QuickBooks is the source of truth for a QBO-origin payment; refusing to mirror one because it exceeds Breeze's cached balance would strand the invoice permanently out of sync with the books and produce no operator-visible remediation. The applier writes `invoice_payments` directly (never through `recordPayment`) and lets `recomputeInvoiceStatus` derive whatever status falls out.
3. **CDC overflow is handled by window-halving, not a cursor.** QBO's CDC operation caps at 1000 objects per entity and its `QueryResponse` reports `totalCount`; there is no `startPosition` cursor on `/cdc` the way there is on `/query`. When any entity reports `totalCount > returned.length`, the provider halves the `[since, now]` window and recurses on both halves (depth cap 6, i.e. down to ~11 hours from the 30-day floor), merging and de-duplicating by Id. Sandbox item 22 records the observed behaviour.
4. **Deletions are processed before additions** in a run, so a delete-and-recreate inside one CDC window lands in the right order.
5. **The cursor advances only on a clean run.** `currency_mismatch` and `skipped_unmapped` count as clean (they are permanent, recorded, and re-processing them changes nothing); a single `failed` item leaves the cursor where it was and rethrows so BullMQ retries the whole window.
6. **`POST /:provider/reconcile` is NOT registered in `SELF_MANAGED_DB_CONTEXT_ROUTES`.** It only enqueues to Redis and never calls QuickBooks in the handler — exactly the reasoning already recorded for `push-bulk` at `middleware/selfManagedDbContextRoutes.ts:90-92`. Registering it would drop the ambient request transaction for no benefit and break `writeRouteAudit`'s assumptions about the request context.
7. **The per-connection `webhook_verifier_token_encrypted` column stays unused and is NOT dropped.** Intuit's verifier token is app-level (`QBO_WEBHOOK_VERIFIER_TOKEN`), one per app environment. Task 1 documents the column as reserved; `encryptedColumnRegistry.ts:104` keeps its entry.
8. **The fingerprint backfill runs from `initializeAccountingReconcileWorkers()`** (Task 4), not from a bespoke boot hook. That is the registry-driven boot path (`workerRegistry.ts`), it runs exactly once per worker-bearing process, and the step is idempotent so a double run is a no-op. The webhook (API process) reads fingerprints out of the shared database, so it does not need the backfill to have run in its own process.

---

### Task 1: Migration, connection columns, realm fingerprint, env var

**Files:**
- Create: `apps/api/migrations/2026-10-01-quickbooks-payment-pullback.sql`
- Modify: `apps/api/src/db/schema/accounting.ts:18-48`, `apps/api/src/services/accounting/accountingConnectionService.ts`, `apps/api/src/config/env.ts:141-144`, `apps/api/src/config/validate.ts:695-702`
- Modify (fixtures broken by the widened DTO): `apps/api/src/services/accounting/quickbooksProvider.test.ts:6-18`, `apps/api/src/services/accounting/accountingInvoicePush.test.ts:105-120`
- Test: `apps/api/src/services/accounting/accountingConnectionService.test.ts` (extend), `apps/api/src/config/validate.test.ts` (extend the `it.each`), new `apps/api/src/__tests__/integration/accountingRealmFingerprint.integration.test.ts`, `apps/api/src/db/autoMigrate.test.ts` (auto-covers naming/order)

**Interfaces:**
- Consumes: `hmacFingerprint` and `getActiveSecretEncryptionKeyId` (`services/secretCrypto.ts:148,170`), `encryptedField`/`decryptNullable`/`stripUndefined` (already local to the connection service), `withSystemDbAccessContext` (`db/index.ts:610`).
- Produces:
```ts
// accountingConnectionService.ts — the four fields APPENDED to the existing
// AccountingConnection interface (`:14-34`). All four are REQUIRED members; the
// existing 18 fields are untouched.
export interface AccountingConnection {
  // id, partnerId, provider, realmId, accessToken, refreshToken,
  // accessTokenExpiresAt, refreshTokenExpiresAt, environment, homeCurrency,
  // multiCurrencyEnabled, defaultIncomeAccountRef, defaultTaxCodeRef, pushMode,
  // status, createdAt, updatedAt, lastError  <- unchanged
  /** hmacFingerprint(realmId): `fp1:<keyId|legacy>:<hex>`. Null until backfilled. */
  realmIdFingerprint: string | null;
  /** Per-connection QBO -> Breeze payment pull-back switch. DB default true. */
  pullPayments: boolean;
  /** Stamped only after a CDC run in which no item failed. */
  lastReconcileAt: Date | null;
  /** CDC watermark. Column already existed (2026-06-23 migration); now read/written. */
  cdcCursor: Date | null;
}
// UpsertConnectionFields (`:36-51`) gains exactly one optional member:
export interface UpsertConnectionFields { pullPayments?: boolean }

/** `fp1:<keyId>:<hex>` -> `<keyId>`; null for a malformed/absent fingerprint. */
export function fingerprintKeyGeneration(fingerprint: string | null): string | null;

/** Webhook realm routing. System context. Exactly one row by the partial unique index. */
export async function findConnectionByRealmFingerprint(
  dbc: DbExecutor, provider: AccountingProviderId, realmIdFingerprint: string,
): Promise<AccountingConnection | null>;

/** Idempotent boot step. Re-fingerprints every row whose fingerprint is NULL or was
 *  computed under a different encryption-key generation (self-heals a key rotation).
 *  Opens its own system context; must be called with none open. */
export async function backfillRealmFingerprints(): Promise<{ scanned: number; updated: number; skipped: number }>;

/** Connections the 15-minute sweep should reconcile: status 'connected' AND pull_payments. */
export async function listReconcilableConnections(
  dbc: DbExecutor, provider: AccountingProviderId,
): Promise<Array<{ id: string; partnerId: string }>>;

/** Advance the CDC watermark and stamp last_reconcile_at. Guarded UPDATE (no CAS —
 *  the worker's shared jobId makes concurrent runs for one connection impossible);
 *  zero rows THROWS, because that means the DB context is wrong. */
export async function advanceReconcileCursor(
  dbc: DbExecutor, connectionId: string, partnerId: string, cursor: Date, reconciledAt: Date,
): Promise<void>;

// config/env.ts
export const QBO_WEBHOOK_VERIFIER_TOKEN: string; // '' when unset
```

- [ ] **Step 1: Write the migration.** `apps/api/migrations/2026-10-01-quickbooks-payment-pullback.sql`, mirroring `2026-09-30-quickbooks-invoice-push.sql`'s style:
```sql
-- Phase D (payment pull-back) — Task 1. accounting_connections gains a keyed
-- realm fingerprint (realm_id_encrypted uses a random IV, so SQL cannot query
-- it), the per-connection pull switch, and the clean-run reconcile stamp.
-- cdc_cursor already exists (2026-06-23-quickbooks-accounting-connections.sql).
-- No RLS changes: accounting_connections is partner-axis and already
-- ENABLE+FORCE with a partner policy; no new table.
--
-- realm_id_fingerprint is populated by the APP, never here: the HMAC key lives
-- in the process, so SQL cannot compute it. See backfillRealmFingerprints().

ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS realm_id_fingerprint text;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS pull_payments boolean NOT NULL DEFAULT true;
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS last_reconcile_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_provider_realm_fp_idx
  ON accounting_connections (provider, realm_id_fingerprint)
  WHERE realm_id_fingerprint IS NOT NULL;
```
- [ ] **Step 2: RED — failing unit tests.** In `accountingConnectionService.test.ts` (Drizzle-mock idiom already in that file). First add four local helpers so the assertions read the ARGUMENTS Drizzle actually received rather than "the mock was called" (the vacuous-assertion trap):
```ts
const CURSOR = new Date('2026-09-02T20:10:00.000Z');
const STAMP  = new Date('2026-09-02T20:10:01.000Z');
/** The object passed to `.values(...)` on the last insert. */
const insertValues = () => valuesMock.mock.calls.at(-1)![0] as Record<string, unknown>;
/** The `set` of the last `.onConflictDoUpdate({ target, set })`. */
const conflictUpdateSet = () => (onConflictMock.mock.calls.at(-1)![0] as { set: Record<string, unknown> }).set;
/** The object passed to `.set(...)` on the last update. */
const updateSet = () => setMock.mock.calls.at(-1)![0] as Record<string, unknown>;
/** The SQL Drizzle compiled for the last `.where(...)` — asserts on the real clause,
 *  not on "where was called". Idiom: `oauth/revocationRetry.test.ts:2,148,172`. */
import { PgDialect } from 'drizzle-orm/pg-core';
const dialect = new PgDialect();
const compiledWhere = () => dialect.sqlToQuery(whereMock.mock.calls.at(-1)![0] as SQL);

describe('realm fingerprint', () => {
  it('upsertConnection writes hmacFingerprint(realmId) on connect and reconnect', async () => {
    await upsertConnection(dbMock, 'p1', 'quickbooks', { realmId: 'realm-9' });
    expect(insertValues().realmIdFingerprint).toBe(hmacFingerprint('realm-9'));
    expect(conflictUpdateSet().realmIdFingerprint).toBe(hmacFingerprint('realm-9'));
  });
  it('upsertConnection leaves the fingerprint untouched when realmId is omitted (token-only reconnect)', async () => {
    await upsertConnection(dbMock, 'p1', 'quickbooks', { accessToken: 'a' });
    expect('realmIdFingerprint' in conflictUpdateSet()).toBe(false);
  });
  it('upsertConnection nulls the fingerprint when realmId is explicitly null', async () => {
    await upsertConnection(dbMock, 'p1', 'quickbooks', { realmId: null });
    expect(conflictUpdateSet().realmIdFingerprint).toBeNull();
  });
  it('fingerprintKeyGeneration parses the key id and returns null for junk', () => {
    expect(fingerprintKeyGeneration('fp1:k2:abcd')).toBe('k2');
    expect(fingerprintKeyGeneration('abcd')).toBeNull();
    expect(fingerprintKeyGeneration(null)).toBeNull();
  });
  it('mapConnection surfaces realmIdFingerprint, pullPayments, lastReconcileAt and cdcCursor', async () => {
    const conn = await getConnection(dbMock, 'p1', 'quickbooks');
    expect(conn).toMatchObject({ pullPayments: true, cdcCursor: CURSOR, lastReconcileAt: null });
  });
});

describe('advanceReconcileCursor', () => {
  it('writes cdc_cursor + last_reconcile_at scoped to (id, partnerId)', async () => {
    await advanceReconcileCursor(dbMock, 'c1', 'p1', CURSOR, STAMP);
    expect(updateSet()).toEqual({ cdcCursor: CURSOR, lastReconcileAt: STAMP, updatedAt: expect.any(Date) });
  });
  it('throws when the guarded update matches no row (wrong DB context)', async () => {
    returningMock.mockResolvedValueOnce([]);
    await expect(advanceReconcileCursor(dbMock, 'c1', 'p1', CURSOR, STAMP))
      .rejects.toThrow(/matched no accounting_connections row/);
  });
});

describe('listReconcilableConnections', () => {
  it('filters to provider AND status connected AND pull_payments true', async () => {
    await listReconcilableConnections(dbMock, 'quickbooks');
    // Assert the COMPILED clause + bound params, not just "select was called".
    const { sql, params } = compiledWhere();
    expect(sql).toMatch(/"provider" = \$\d+ and "status" = \$\d+ and "pull_payments" = \$\d+/i);
    expect(params).toEqual(['quickbooks', 'connected', true]);
  });
});
```
  In `validate.test.ts`, add `'QBO_WEBHOOK_VERIFIER_TOKEN'` to the existing `it.each` list in `describe('envSchema ↔ validateConfig parse-input contract (#2896)')` (~line 2500), which asserts `ENV_SCHEMA_KEYS` contains the key and `buildEnvParseInput` round-trips it.
- [ ] **Step 3: Run to verify failure.** `cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts src/config/validate.test.ts` — expect FAIL (`fingerprintKeyGeneration is not a function`, `advanceReconcileCursor is not exported`, `ENV_SCHEMA_KEYS` missing the key).
- [ ] **Step 4: Implement.**
  - `db/schema/accounting.ts`: add `realmIdFingerprint: text('realm_id_fingerprint')`, `pullPayments: boolean('pull_payments').notNull().default(true)`, `lastReconcileAt: timestamp('last_reconcile_at', { withTimezone: true })`, and the partial unique index `providerRealmFpIdx: uniqueIndex('accounting_connections_provider_realm_fp_idx').on(table.provider, table.realmIdFingerprint).where(sql\`${table.realmIdFingerprint} IS NOT NULL\`)`. Add a comment on `webhookVerifierTokenEncrypted` recording that it is RESERVED and unused (the verifier token is app-level; see decision 7).
  - `accountingConnectionService.ts`: widen `AccountingConnection` + `mapConnection` with the four fields; add `fingerprintField(value)` mirroring `encryptedField` (undefined -> undefined, null -> null, string -> `hmacFingerprint(value)`) and thread it into BOTH `values` and `updateSet` in `upsertConnection`; add `pullPayments` to `UpsertConnectionFields` and to both sets (insert default `true`, update only when the caller supplies it — the same "do not reset settings on a token-only reconnect" rule the `pushMode` comment at `:163-168` records); add `fingerprintKeyGeneration`, `findConnectionByRealmFingerprint`, `listReconcilableConnections`, `advanceReconcileCursor` (guarded UPDATE, `.returning({ id })`, throw on zero rows) and `backfillRealmFingerprints`.
  - `backfillRealmFingerprints`: `assertNoAmbientDbContext('backfillRealmFingerprints')`, then `withSystemDbAccessContext` a select of `{ id, partnerId, realmIdEncrypted, realmIdFingerprint }` for every row with a non-null `realm_id_encrypted`; compute `activeGen = getActiveSecretEncryptionKeyId() ?? 'legacy'`; for each row where `realmIdFingerprint === null || fingerprintKeyGeneration(realmIdFingerprint) !== activeGen`, decrypt the realm id and UPDATE the fingerprint scoped to `(id, partnerId)`. Catch `isPgUniqueViolation(err, 'accounting_connections_provider_realm_fp_idx')` per row -> `skipped++` plus a `captureException` (two partners claiming one realm is a real conflict an operator must see, not a crash that blocks boot). Return the counts.
  - `config/env.ts`: `export const QBO_WEBHOOK_VERIFIER_TOKEN = process.env.QBO_WEBHOOK_VERIFIER_TOKEN?.trim() ?? '';` next to the other four.
  - `config/validate.ts`: `QBO_WEBHOOK_VERIFIER_TOKEN: z.string().optional(),` inside the existing QBO block at `:695-702`, with a one-line comment that it is optional at boot because only the webhook route needs it and a region without the Intuit webhook relies on the sweep.
  - Fix the two full-object `AccountingConnection` fixtures (`quickbooksProvider.test.ts:6-18`, `accountingInvoicePush.test.ts:105-120`) by adding `realmIdFingerprint: null, pullPayments: true, lastReconcileAt: null, cdcCursor: null`.
- [ ] **Step 5: RED then GREEN — the real-Postgres fingerprint suite.** Create `apps/api/src/__tests__/integration/accountingRealmFingerprint.integration.test.ts`, mirroring `accountingInvoicePushCurrency.integration.test.ts`'s harness (`import './setup'`, `const runDb = it.runIf(!!process.env.DATABASE_URL)`, `createPartner` from `./db-utils`, seeds inside `withSystemDbAccessContext`):
```ts
runDb('backfills a null fingerprint and finds the connection by it', async () => {
  const partner = await createPartner();
  const conn = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', {
    realmId: 'realm-backfill-1', environment: 'sandbox',
  }));
  // Simulate a pre-Phase-D row.
  await withSystemDbAccessContext(() => db.update(accountingConnections)
    .set({ realmIdFingerprint: null }).where(eq(accountingConnections.id, conn.id)));

  const first = await backfillRealmFingerprints();
  expect(first.updated).toBeGreaterThanOrEqual(1);
  const second = await backfillRealmFingerprints();       // idempotent
  expect(second.updated).toBe(0);

  const found = await withSystemDbAccessContext(() =>
    findConnectionByRealmFingerprint(db, 'quickbooks', hmacFingerprint('realm-backfill-1')));
  expect(found?.id).toBe(conn.id);
  expect(found?.pullPayments).toBe(true);
});

runDb('re-fingerprints a row stamped under a stale key generation', async () => {
  const partner = await createPartner();
  const conn = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'realm-rotated' }));
  await withSystemDbAccessContext(() => db.update(accountingConnections)
    .set({ realmIdFingerprint: 'fp1:retired-key:deadbeef' }).where(eq(accountingConnections.id, conn.id)));
  await backfillRealmFingerprints();
  const [row] = await withSystemDbAccessContext(() => db.select().from(accountingConnections).where(eq(accountingConnections.id, conn.id)));
  expect(row!.realmIdFingerprint).toBe(hmacFingerprint('realm-rotated'));
});

runDb('advanceReconcileCursor throws when the connection is not this partner\'s', async () => {
  const [a, b] = [await createPartner(), await createPartner()];
  const conn = await withSystemDbAccessContext(() => upsertConnection(db, a.id, 'quickbooks', { realmId: 'realm-cursor' }));
  await expect(withSystemDbAccessContext(() =>
    advanceReconcileCursor(db, conn.id, b.id, new Date(), new Date()),
  )).rejects.toThrow(/matched no accounting_connections row/);
});
```
  Run it RED first (the exports do not exist), then GREEN after Step 4.
- [ ] **Step 6: Verify.** `cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts src/services/accounting/quickbooksProvider.test.ts src/services/accounting/accountingInvoicePush.test.ts src/config/validate.test.ts src/db/autoMigrate.test.ts`; `pnpm db:migrate && pnpm db:check-drift` (clean); `bash scripts/check-migration-naming.sh`; `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/accountingRealmFingerprint.integration.test.ts`.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(accounting): realm fingerprint, pull-payments switch and CDC cursor on accounting connections"`

---

### Task 2: Provider CDC — `reconcileChanges` and the widened `ChangeSet`

**Files:**
- Modify: `apps/api/src/services/accounting/types.ts:157-176` (ChangeSet), `apps/api/src/services/accounting/quickbooksProvider.ts:565-567` (replace the `NotImplemented: Phase D` stub)
- Modify: `apps/api/src/services/accounting/types.test.ts` (new pinned tuple), `apps/api/src/services/accounting/accountingCurrency.test.ts:34-43` (the `payment()` fixture gains the three new fields)
- Test: `apps/api/src/services/accounting/quickbooksProvider.test.ts` (extend)

**Interfaces:**
- Consumes: the private `qboRequest<T>(conn, path, operation, init)` helper (`quickbooksProvider.ts:578-611` — `reconcileChanges` is a class method so `this.qboRequest` is in scope), `QBO_API_MINOR_VERSION`, `toMinorUnits` (`@breeze/shared`).
- Produces:
```ts
// types.ts — ChangeSet REPLACED (the inline payment shape is promoted to a named type
// so the applier and the worker can both reference one line without an indexed access)
export interface ChangeSetPaymentLine {
  remoteInvoiceId: string;
  remotePaymentId: string;
  /** Provider-reported INTEGER MINOR UNITS. Convert exactly once, and only via
   *  normalizeAccountingPayment (accountingCurrency.ts) — multi-currency §11. */
  amountMinor: number;
  /** Provider-reported ISO 4217 code for this payment. */
  currency: string;
  /** ISO date (YYYY-MM-DD) from Payment.TxnDate. */
  txnDate: string;
  /** QBO Payment SyncToken at CDC read time — the applier's "QBO edited it" signal. */
  remotePaymentSyncToken: string | null;
  /** PaymentMethodRef.name; null when the realm did not expand the ref. */
  paymentMethodName: string | null;
  /** PaymentRefNum (cheque number etc.); null when absent. */
  paymentRefNum: string | null;
}
export interface ChangeSet {
  /** The instant the CDC window ends. Becomes the connection's next cdc_cursor. */
  cursor: Date;
  payments: ChangeSetPaymentLine[];
  /** QBO Payment ids the realm reports as status:"Deleted", plus voided (TotalAmt 0) payments. */
  deletedPayments: string[];
  /** QBO Invoice ids the realm reports as status:"Deleted" or voided. */
  deletedInvoices: string[];
}
// AccountingProvider.reconcileChanges signature UNCHANGED:
//   reconcileChanges(conn: AccountingConnection, sinceCursor: Date | null): Promise<ChangeSet>
export const QBO_CDC_LOOKBACK_DAYS = 30;   // QBO's CDC lookback limit
export const QBO_CDC_CURSOR_SLACK_MS = 5 * 60 * 1000;  // re-read 5 min behind the cursor
export const QBO_CDC_MAX_SPLIT_DEPTH = 6;  // window-halving cap (decision 3)

// PRIVATE to the provider class — one CDC request over one window.
interface CdcWindowResult {
  payments: ChangeSetPaymentLine[];
  deletedPayments: string[];
  deletedInvoices: string[];
  /** True when any entity block reported totalCount > the array it returned. */
  overflowed: boolean;
}
// private async fetchCdcWindow(conn: AccountingConnection, from: Date, to: Date): Promise<CdcWindowResult>
```

- [ ] **Step 1: RED — type pins + parser tests.** In `types.test.ts` add:
```ts
it('reconcileChanges returns a ChangeSet carrying deletions and per-line QBO metadata', () => {
  expectTypeOf<Parameters<AccountingProvider['reconcileChanges']>>()
    .toEqualTypeOf<[AccountingConnection, Date | null]>();
  expectTypeOf<ReturnType<AccountingProvider['reconcileChanges']>>().toEqualTypeOf<Promise<ChangeSet>>();
  expectTypeOf<ChangeSet['deletedPayments']>().toEqualTypeOf<string[]>();
  expectTypeOf<ChangeSet['deletedInvoices']>().toEqualTypeOf<string[]>();
  expectTypeOf<ChangeSetPaymentLine['amountMinor']>().toEqualTypeOf<number>();
  expectTypeOf<ChangeSetPaymentLine['remotePaymentSyncToken']>().toEqualTypeOf<string | null>();
  expectTypeOf<ChangeSetPaymentLine['paymentMethodName']>().toEqualTypeOf<string | null>();
  expectTypeOf<ChangeSetPaymentLine['paymentRefNum']>().toEqualTypeOf<string | null>();
});
```
  In `quickbooksProvider.test.ts` add realistic CDC fixtures (write these objects out in full — they are the QBO wire shape the parser is being held to):
```ts
function cdcResponse(entityBlocks: Record<string, unknown>[], time = '2026-09-02T20:10:00.000Z') {
  return { CDCResponse: [{ QueryResponse: entityBlocks }], time };
}
function qboPayment(overrides: Record<string, unknown> = {}) {
  return {
    Id: '180', SyncToken: '0', TxnDate: '2026-09-02', TotalAmt: 150.0,
    CurrencyRef: { value: 'USD', name: 'United States Dollar' },
    CustomerRef: { value: '58' },
    PaymentMethodRef: { value: '2', name: 'Check' },
    PaymentRefNum: '10441',
    Line: [{ Amount: 150.0, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }],
    MetaData: { CreateTime: '2026-09-02T20:04:34-07:00', LastUpdatedTime: '2026-09-02T20:04:34-07:00' },
    ...overrides,
  };
}

describe('reconcileChanges (CDC)', () => {
  it('requests entities=Payment,Invoice with changedSince 5 minutes behind the cursor', async () => {
    const spy = mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment()], startPosition: 1, maxResults: 1, totalCount: 1 }]));
    const since = new Date('2026-09-02T20:00:00.000Z');
    await quickbooksProvider.reconcileChanges(conn(), since);
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/cdc?entities=Payment%2CInvoice');
    expect(url).toContain(`changedSince=${encodeURIComponent('2026-09-02T19:55:00.000Z')}`);
    expect(url).toContain('minorversion=70');
  });

  it('floors a null cursor at 30 days and never earlier than the connection createdAt', async () => {
    mockFetchJsonOnce(cdcResponse([]));
    const created = new Date(Date.now() - 5 * 24 * 3600_000);
    const spy = vi.mocked(globalThis.fetch);
    await quickbooksProvider.reconcileChanges(conn({ createdAt: created }), null);
    expect(String(spy.mock.calls[0]![0])).toContain(encodeURIComponent(new Date(created.getTime() - QBO_CDC_CURSOR_SLACK_MS).toISOString()));
  });

  it('emits one payment line per Invoice-linked Line, in minor units', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment()] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.payments).toEqual([{
      remoteInvoiceId: '145', remotePaymentId: '180', amountMinor: 15000, currency: 'USD',
      txnDate: '2026-09-02', remotePaymentSyncToken: '0', paymentMethodName: 'Check', paymentRefNum: '10441',
    }]);
  });

  it('splits one Payment applied across two invoices into two lines', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment({
      TotalAmt: 250.0,
      Line: [
        { Amount: 100.0, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] },
        { Amount: 150.0, LinkedTxn: [{ TxnId: '146', TxnType: 'Invoice' }] },
      ],
    })] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.payments.map((p) => [p.remoteInvoiceId, p.amountMinor])).toEqual([['145', 10000], ['146', 15000]]);
  });

  it('ignores non-Invoice LinkedTxn lines (deposits, credit applications)', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment({
      Line: [{ Amount: 150.0, LinkedTxn: [{ TxnId: '9', TxnType: 'CreditMemo' }] }],
    })] }]));
    expect((await quickbooksProvider.reconcileChanges(conn(), new Date())).payments).toEqual([]);
  });

  it('treats a voided payment (TotalAmt 0, no lines) as a deletion, not a zero payment', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment({ TotalAmt: 0, Line: [] })] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.payments).toEqual([]);
    expect(cs.deletedPayments).toEqual(['180']);
  });

  it('collects status:"Deleted" Payment and Invoice entities into the deletion lists', async () => {
    mockFetchJsonOnce(cdcResponse([
      { Payment: [{ Id: '181', status: 'Deleted', domain: 'QBO', MetaData: { LastUpdatedTime: '2026-09-02T20:06:00-07:00' } }] },
      { Invoice: [{ Id: '145', status: 'Deleted', domain: 'QBO', MetaData: { LastUpdatedTime: '2026-09-02T20:07:00-07:00' } }] },
    ]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.deletedPayments).toEqual(['181']);
    expect(cs.deletedInvoices).toEqual(['145']);
  });

  it('halves the window when an entity reports more changes than it returned, and de-duplicates', async () => {
    const overflow = cdcResponse([{ Payment: [qboPayment()], startPosition: 1, maxResults: 1, totalCount: 2 }]);
    const settled = cdcResponse([{ Payment: [qboPayment({ Id: '182' })], totalCount: 1 }]);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(overflow))   // full window: overflowing
      .mockResolvedValueOnce(jsonResponse(settled))    // first half
      .mockResolvedValueOnce(jsonResponse(cdcResponse([{ Payment: [qboPayment()] }])));  // second half
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date(Date.now() - 3600_000));
    expect(cs.payments.map((p) => p.remotePaymentId).sort()).toEqual(['180', '182']);
  });

  it('returns the window end as the cursor and never a raw QBO body on failure', async () => {
    mockFetchJsonOnce({ Fault: { Error: [{ Detail: 'realm secrets' }] } }, 500);
    await expect(quickbooksProvider.reconcileChanges(conn(), new Date())).rejects.toThrow(/QuickBooks change data capture failed with 500/);
    await expect(quickbooksProvider.reconcileChanges(conn(), new Date())).rejects.not.toThrow(/realm secrets/);
  });
});
```
- [ ] **Step 2: Run to verify failure.** `cd apps/api && npx vitest run src/services/accounting/quickbooksProvider.test.ts src/services/accounting/types.test.ts` — expect FAIL (`NotImplemented: Phase D`, `ChangeSetPaymentLine` not exported).
- [ ] **Step 3: Implement.**
  - `types.ts`: replace `ChangeSet` with the shape above, exporting `ChangeSetPaymentLine`. Leave `AccountingProvider.reconcileChanges`'s signature alone.
  - `accountingCurrency.test.ts:34-43`: extend the `payment()` fixture defaults with `remotePaymentSyncToken: '0', paymentMethodName: null, paymentRefNum: null`. (`normalizeAccountingPayment`'s own parameter type is `ChangeSet['payments'][number]`, so it keeps compiling unchanged; no production change to `accountingCurrency.ts` in this task.)
  - `quickbooksProvider.ts`: add the three exported constants and a private `fetchCdcWindow(conn, from, to, depth)` that issues `cdc?entities=Payment,Invoice&changedSince=<from.toISOString()>&minorversion=70` through `this.qboRequest`, walks `CDCResponse[].QueryResponse[]` entity blocks, and returns `{ payments, deletedPayments, deletedInvoices, overflowed }` where `overflowed` is true when any block's `totalCount` exceeds its returned array length. `reconcileChanges` computes `from = max(sinceCursor ?? epoch, conn.createdAt ?? epoch, now - 30d) - 5min` and `to = now`, calls `fetchCdcWindow`, and on `overflowed && depth < QBO_CDC_MAX_SPLIT_DEPTH` recurses on `[from, mid]` and `[mid, to]`, merging and de-duplicating (payments by `${remotePaymentId}/${remoteInvoiceId}`, deletions by id). Payment mapping: `amountMinor = toMinorUnits(Line.Amount, currency)`; `currency = CurrencyRef?.value ?? conn.homeCurrency ?? ''` (the applier's currency guard rejects an empty code — never guess); `paymentMethodName = PaymentMethodRef?.name ?? null`; `paymentRefNum = PaymentRefNum ?? null`. A Payment with `TotalAmt === 0` or no Invoice-linked line goes into `deletedPayments` (QBO voids a Payment by zeroing it, not by deleting it). An Invoice entity with `status === 'Deleted'` **or** `TotalAmt === 0 && Balance === 0 && PrivateNote` containing `Voided` goes into `deletedInvoices`. `cursor` is `to`. Error path: `qboRequest` already attaches `status` and a 500-char-sliced body to the thrown error and never returns it in the message — pass the operation label `'QuickBooks change data capture'` and do not add a body to the message.
- [ ] **Step 4: Run to verify pass.** `cd apps/api && npx vitest run src/services/accounting/` — all green, including `accountingCurrency.test.ts`.
- [ ] **Step 5: Commit.** `git commit -am "feat(accounting): implement QuickBooks CDC reconcileChanges with deletions and split-payment lines"`

---

### Task 3: The payment applier + the two Phase-D TODO fill-ins

**Files:**
- Create: `apps/api/src/services/accounting/accountingPaymentPull.ts`
- Create: `apps/api/src/services/accounting/accountingPaymentPull.test.ts`
- Create: `apps/api/src/__tests__/integration/accountingPaymentPull.integration.test.ts`
- Modify: `apps/api/src/services/invoiceService.ts:1487-1490` (the `voidPayment` Phase D TODO) and `:1502-1515` (`listPayments` source), `apps/api/src/services/stripeReconcile.ts:185-188` (the full-refund Phase D TODO)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts:169-171` (one new exemption entry)

**Interfaces:**
- Consumes: `assertNoAmbientDbContext` + `DbContextRunner` (`dbContextGuard.ts`), `normalizeAccountingPayment` + `AccountingCurrencyContractError` (`accountingCurrency.ts:107-146`), `ChangeSetPaymentLine` (Task 2), `AccountingConnection` (Task 1), `recomputeInvoiceStatus` (`invoiceService.ts:1361`), `writeAuditEvent` + `requestLikeFromSnapshot` (`services/auditEvents.ts:20,111` — the applier runs off-request, so it uses the system-scope writer, exactly like `stripeReconcile.ts`), `captureException`, `isPgUniqueViolation`.
- Produces:
```ts
export type PaymentPullOutcome =
  | 'applied'            // new invoice_payments row + new mapping row
  | 'updated'            // QBO edited the payment (newer SyncToken) -> amount/date/token refreshed
  | 'replayed'           // same SyncToken already recorded -> no-op
  | 'reversed'           // mirrored a QBO delete/void
  | 'skipped_unmapped'   // Breeze never pushed this invoice; not an error
  | 'currency_mismatch'  // recorded on the mapping row as sync_status='error'; no payment row
  | 'failed';            // anything else; the worker leaves the cursor and rethrows

export interface PaymentPullResult {
  outcome: PaymentPullOutcome;
  remotePaymentId: string;
  remoteInvoiceId: string | null;
  invoiceId: string | null;
  invoicePaymentId: string | null;
}

/** `<PaymentId>/<remoteInvoiceId>` — decision 1. */
export function paymentMappingRemoteId(remotePaymentId: string, remoteInvoiceId: string): string;

/** QBO PaymentMethod name -> Breeze payment_method enum. Unknown/absent -> 'other'. */
export function mapQboPaymentMethod(name: string | null): 'cash' | 'check' | 'card' | 'other';

/** Apply ONE CDC payment line. Entered with NO ambient context; one short
 *  self-committing context, invoice row locked FIRST (accountingCurrency.ts item 4). */
export async function applyAccountingPayment(
  conn: AccountingConnection, line: ChangeSetPaymentLine, runInDbContext: DbContextRunner,
): Promise<PaymentPullResult>;

/** Mirror a QBO payment delete/void: every mapping row `LIKE '<PaymentId>/%'` for
 *  this connection. Returns one result per invoice the payment touched. */
export async function reverseAccountingPayment(
  conn: AccountingConnection, remotePaymentId: string, runInDbContext: DbContextRunner,
): Promise<PaymentPullResult[]>;

/** Flip the invoice mapping to error/'Deleted in QuickBooks'. Never clears
 *  remote_entity_id; never re-pushes. */
export async function markInvoiceDeletedRemotely(
  conn: AccountingConnection, remoteInvoiceId: string, runInDbContext: DbContextRunner,
): Promise<'marked' | 'skipped_unmapped'>;

/** Deletes the 'payment' mapping row for one invoice_payments id, INSIDE the
 *  caller's transaction. Returns the number of rows removed (0 is legitimate:
 *  a manual or Stripe payment has no mapping). Used by invoiceService.voidPayment
 *  and stripeReconcile's full-refund branch — both already hold the invoice lock. */
export async function clearPaymentMappingForInvoicePayment(
  tx: { delete: (...args: any[]) => any }, invoicePaymentId: string,
): Promise<number>;

// invoiceService.ts — listPayments' derived source widens:
//   source: 'stripe' | 'quickbooks' | 'manual'
```

- [ ] **Step 1: RED — unit tests with compiled-SQL assertions.** Create `accountingPaymentPull.test.ts` using the Drizzle-mock + `ctx.depth` idiom from `accountingInvoicePush.test.ts:41-90`:
```ts
const ctx = vi.hoisted(() => ({ depth: 0, events: [] as string[] }));
vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock },
  hasDbAccessContext: () => ctx.depth > 0,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
const runCtx = async <T>(fn: () => Promise<T>): Promise<T> => {
  ctx.depth++; ctx.events.push('ctx:enter');
  try { return await fn(); } finally { ctx.events.push('ctx:exit'); ctx.depth--; }
};
// Same compiled-SQL helpers as Task 1 Step 2 (PgDialect().sqlToQuery), plus:
const dialect = new PgDialect();
/** The compiled SQL text of a Drizzle builder call's `.where(...)` argument. */
const compiledSql = (whereArg: SQL) => dialect.sqlToQuery(whereArg).sql;
const LINE: ChangeSetPaymentLine = {
  remoteInvoiceId: '145', remotePaymentId: '180', amountMinor: 15000, currency: 'USD',
  txnDate: '2026-09-02', remotePaymentSyncToken: '0', paymentMethodName: 'Check', paymentRefNum: '10441',
};
```
  Cases, each a real test:
  1. `mapQboPaymentMethod` table: `'Cash' -> 'cash'`, `'Check' -> 'check'`, `'Cheque' -> 'check'`, `'Credit Card' -> 'card'`, `'Visa' -> 'card'`, `'Direct Debit' -> 'other'`, `null -> 'other'`; matching is case-insensitive and trimmed.
  2. `paymentMappingRemoteId('180', '145') === '180/145'`.
  3. **No invoice mapping** for `remoteInvoiceId` -> `{ outcome: 'skipped_unmapped' }`, and **no insert or update was issued** (`expect(insertMock).not.toHaveBeenCalled()`).
  4. **Lock order:** the first statement issued inside the context is the invoice `SELECT ... FOR UPDATE`. Assert on the compiled SQL: `expect(compiledSql(selectMock.mock.calls[1])).toMatch(/for update/i)` and that the `invoice_payments` sum read happens AFTER it.
  5. **Replay:** mapping present, `syncStatus:'synced'`, `remoteSyncToken` equal to the line's -> `'replayed'`, no `invoice_payments` write, no `recomputeInvoiceStatus` call.
  6. **Update:** mapping present with `remoteSyncToken:'0'`, line carries `'1'` -> `'updated'`; assert the `invoice_payments` UPDATE **set** clause carries `{ amount: '150.00', receivedAt: '2026-09-02' }` and the mapping UPDATE carries `{ remoteSyncToken: '1', syncStatus: 'synced', lastError: null }`; `recomputeInvoiceStatus` called once as `(inv.id, db)` — the ambient `db` proxy, which inside the open context IS the transaction handle, so the sum it reads is consistent with the lock we hold (`invoiceService.ts:1355-1360`).
  7. **Currency mismatch:** locked invoice `currencyCode:'USD'`, line `currency:'EUR'` -> `'currency_mismatch'`; the mapping row is written `syncStatus:'error'` with the message from `AccountingCurrencyContractError` (assert the exact text `Payment currency EUR does not match invoice currency USD. Cross-currency payments are not supported.`); **no** `invoice_payments` insert.
  8. **Applied:** happy path -> `'applied'`; assert the insert values object equals `{ invoiceId, orgId, amount: '150.00', method: 'check', reference: '10441', receivedAt: '2026-09-02', recordedBy: null, note: 'Pulled from QuickBooks' }`, the mapping insert equals `{ integrationId, partnerId, breezeEntityType: 'payment', breezeEntityId: <paymentRowId>, remoteEntityType: 'Payment', remoteEntityId: '180/145', remoteSyncToken: '0', linkStatus: 'confirmed', syncStatus: 'synced' }`, and `writeAuditEvent` was called with `action: 'accounting.payment.pulled'`, `resourceType: 'invoice'`, `actorType: 'system'`.
  9. **Reference fallback:** `paymentRefNum: null` -> `reference` is the QBO payment id `'180'`.
  10. **Zero-row insert throws:** `returning()` resolves `[]` -> rejects with `/refusing to record a QuickBooks payment/` and the result never reports `'applied'`.
  11. **Reversal:** two mapping rows `'180/145'` and `'180/146'` -> two `'reversed'` results; assert each `invoice_payments` DELETE is scoped by the mapping's `breezeEntityId` (`expect(compiledSql(deleteMock.mock.calls[0])).toMatch(/"invoice_payments".*"id" = \$1/s)`), that a manual payment id on the same invoice is NOT in any delete's args, and that `writeAuditEvent` fired `accounting.payment.reversed` per invoice.
  12. **Reversal with no mapping rows** -> `[]`, no deletes.
  13. **`markInvoiceDeletedRemotely`:** mapping found -> UPDATE set `{ syncStatus: 'error', lastError: 'Deleted in QuickBooks' }` and the set object has **no** `remoteEntityId` key; no mapping -> `'skipped_unmapped'`.
  14. **Ambient-context guard:** `await runCtx(() => applyAccountingPayment(conn, line, runCtx))` rejects with `/must run with NO ambient DB access context/`.
  15. **Context discipline:** one apply produces exactly `['ctx:enter','ctx:exit']` and ends at `ctx.depth === 0`.
- [ ] **Step 2: Run to verify failure.** `cd apps/api && npx vitest run src/services/accounting/accountingPaymentPull.test.ts` — expect FAIL (module does not exist).
- [ ] **Step 3: Implement `accountingPaymentPull.ts`.** Module header states the DB-access contract verbatim from `accountingInvoicePush.ts:21-39` (phase split, why it is load-bearing) and cites `accountingCurrency.ts` item 4. `applyAccountingPayment`:
  1. `assertNoAmbientDbContext('applyAccountingPayment')`.
  2. ONE `runInDbContext(async () => { ... })` — that invocation IS the transaction, so everything below shares it and commits together:
     a. Unlocked discovery read of the `invoice` mapping for `(integrationId = conn.id, remoteEntityType = 'Invoice', remoteEntityId = line.remoteInvoiceId)` scoped to `conn.partnerId`. None -> return `skipped_unmapped`. (Not authoritative — rechecked implicitly under the lock, mirroring `recordStripePayment`'s "unlocked discovery read" comment at `stripeReconcile.ts:41-47`.)
     b. `SELECT ... FROM invoices WHERE id = <mapping.breezeEntityId> AND partner_id = <conn.partnerId> FOR UPDATE`. Missing -> `skipped_unmapped` (an erased org).
     c. Re-read the `payment` mapping for `paymentMappingRemoteId(line.remotePaymentId, line.remoteInvoiceId)` **under the lock** — this is the authoritative at-most-once claim.
     d. `normalizeAccountingPayment(line, { invoiceId: inv.id, currencyCode: inv.currencyCode })` against the LOCKED invoice's stamped currency. Catch `AccountingCurrencyContractError`: upsert the payment mapping row `syncStatus:'error'`, `lastError: err.message` (already sanitized, never a QBO body) and return `currency_mismatch`.
     e. Existing mapping + same `remoteSyncToken` -> `replayed`. Existing mapping + different token -> UPDATE `invoice_payments` (`amount`, `receivedAt`, `method`, `reference`) and the mapping (`remoteSyncToken`, `syncStatus:'synced'`, `lastError:null`, `lastSyncedAt`), `recomputeInvoiceStatus(inv.id, db)`, audit `accounting.payment.pulled` with `details.replacedSyncToken`, return `updated`.
     f. Otherwise INSERT `invoice_payments` with `{ invoiceId: inv.id, orgId: inv.orgId, amount: normalized.amount, method: mapQboPaymentMethod(line.paymentMethodName), reference: line.paymentRefNum ?? line.remotePaymentId, receivedAt: normalized.txnDate, recordedBy: null, note: 'Pulled from QuickBooks' }`, `.returning({ id })`, zero rows -> throw `refusing to record a QuickBooks payment with no row`. INSERT the mapping row `confirmed/synced` with the sync token; catch `isPgUniqueViolation(err, 'accounting_entity_mappings_remote_uniq')` and re-read + return `replayed` (a concurrent webhook and sweep raced). `recomputeInvoiceStatus(inv.id, db)`. Audit `accounting.payment.pulled` (`orgId: inv.orgId`, `resourceType: 'invoice'`, `resourceId: inv.id`, `actorType: 'system'`, `details: { provider: conn.provider, remotePaymentId, remoteInvoiceId, amount, currency, invoicePaymentId }`).
  `reverseAccountingPayment`: `assertNoAmbientDbContext`; one `runInDbContext` per matched mapping row (so one bad invoice cannot roll back the others). Inside each: `SELECT ... FOR UPDATE` the invoice that owns the mapped `invoice_payments` row, re-read the mapping, `DELETE FROM invoice_payments WHERE id = <mapping.breezeEntityId>` (the mapping is the ONLY thing that authorises the delete — a payment with no mapping is manual or Stripe and is structurally unreachable here), delete the mapping, `recomputeInvoiceStatus(inv.id, db)`, audit `accounting.payment.reversed` with the destroyed row's amount/method snapshot taken BEFORE the delete (the `voidPayment` precedent at `invoiceService.ts:1477-1486`).
  `markInvoiceDeletedRemotely`: one short context; guarded UPDATE of the `invoice` mapping to `syncStatus:'error'`, `lastError:'Deleted in QuickBooks'`, `updatedAt`; the set object deliberately omits `remoteEntityId` and `linkStatus`.
  `clearPaymentMappingForInvoicePayment(tx, invoicePaymentId)`: `tx.delete(accountingEntityMappings).where(and(eq(breezeEntityType,'payment'), eq(breezeEntityId, invoicePaymentId))).returning({ id })`, returns `rows.length`.
- [ ] **Step 4: RED then GREEN — the two TODO fill-ins and `listPayments`.** First extend the existing suites:
  - `invoiceService` tests: `voidPayment` on a QBO-origin payment deletes its `payment` mapping row inside the same transaction (assert `clearPaymentMappingForInvoicePayment` called with the tx handle and the payment id); `voidPayment` on a manual payment removes nothing extra (returns 0, does not throw).
  - `listPayments` returns `source: 'quickbooks'` for a payment carrying a `payment` mapping, `'stripe'` for a succeeded Stripe mapping, `'manual'` otherwise; a payment with BOTH (structurally impossible, but assert the precedence) reports `'stripe'`.
  - `stripeReconcile` tests: the full-refund branch calls `clearPaymentMappingForInvoicePayment` before deleting `invoice_payments`.
  Then implement: replace the TODO comment at `invoiceService.ts:1487-1490` with the call (inside the existing `db.transaction`, before the `invoicePayments` delete); replace the TODO at `stripeReconcile.ts:185-188` the same way; widen `listPayments` with a second `select` over `accountingEntityMappings` where `breezeEntityType = 'payment'` and `breezeEntityId` is in the page's payment ids, building a `qboIds` Set alongside the existing `stripeIds` Set.
- [ ] **Step 5: Add the partner-wide-write-coverage exemption.** In `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`, inside `ALLOWED_WITHOUT_CAPABILITY_CHECK`, directly after the `accountingInvoicePush.ts` entry at line 171:
```ts
  'services/accounting/accountingPaymentPull.ts': 'QBO-signed webhook / system-context CDC backstop writes payment mapping rows and invoice_payments; there is no tenant caller to gate — the connection is resolved by id or realm fingerprint and every write carries that connection\'s (integration_id, partner_id), enforced by the composite FK (mirrors the Stripe webhook precedent)',
```
- [ ] **Step 6: RED then GREEN — the real-Postgres applier suite.** Create `apps/api/src/__tests__/integration/accountingPaymentPull.integration.test.ts`, mirroring `accountingInvoicePushCurrency.integration.test.ts` (`import './setup'`, `runDb = it.runIf(!!process.env.DATABASE_URL)`, `createPartner`/`createOrganization` from `./db-utils`, `upsertConnection`, and local `seedInvoice`/`seedInvoiceMapping` helpers copied from that file's shape). Tests:
  1. **Idempotent apply:** apply the same `ChangeSetPaymentLine` twice -> exactly ONE `invoice_payments` row, ONE mapping row, second call returns `replayed`, invoice `status = 'paid'` and `balance = '0.00'`.
  2. **Split payment:** two lines sharing `remotePaymentId '180'` against two different invoices -> two `invoice_payments` rows, two mapping rows (`'180/145'`, `'180/146'`) under the one Payment id, both invoices recomputed.
  3. **Selective reversal:** seed a manual `invoice_payments` row AND apply a QBO line on the SAME invoice, then `reverseAccountingPayment(conn, '180')` -> the QBO-origin row and its mapping are gone, the manual row survives with its `recordedBy` intact, invoice recomputed back to `partially_paid`.
  4. **Currency mismatch:** EUR line against a USD invoice -> `currency_mismatch`, ZERO `invoice_payments` rows for the invoice, and the payment mapping row exists with `sync_status = 'error'` carrying the sanitized message.
  5. **Unmapped invoice:** a line whose `remoteInvoiceId` has no `invoice` mapping -> `skipped_unmapped`, nothing written anywhere.
  6. **Cross-partner forge rejected:** insert a `payment` mapping row under partner B pointing at partner A's `invoice_payments` id and assert the DB refuses it — `expect(sqlCause(caught).code).toBe('23514')` and `expect(sqlCause(caught).message).toMatch(/does not belong to partner/i)`, exactly the assertion `accounting-entity-mappings-rls.integration.test.ts:82-104` already uses.
  7. **`voidPayment` clears the mapping:** apply a QBO payment, then call `invoiceService.voidPayment` on the resulting row -> both the payment row and its mapping row are gone.
  8. **`markInvoiceDeletedRemotely`:** flips the invoice mapping to `error`/`Deleted in QuickBooks` and leaves `remote_entity_id` intact.
- [ ] **Step 7: Verify.** `cd apps/api && npx vitest run src/services/accounting/accountingPaymentPull.test.ts src/services/invoiceService src/services/stripeReconcile src/__tests__/partner-wide-write-coverage.test.ts`; then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/accountingPaymentPull.integration.test.ts`.
- [ ] **Step 8: Commit.** `git commit -am "feat(accounting): QuickBooks payment applier with invoice-first locking and at-most-once mapping claim"`

---

### Task 4: The reconcile worker, the 15-minute sweep, and registry registration

**Files:**
- Create: `apps/api/src/jobs/accountingReconcileWorker.ts` (template: `apps/api/src/jobs/accountingSyncWorker.ts`; repeatable pattern: `apps/api/src/jobs/huntressSync.ts:1108-1126`)
- Create: `apps/api/src/jobs/accountingReconcileWorker.test.ts`
- Modify: `apps/api/src/services/workerRegistry.ts:1086-1093` (new entry after `accountingSyncWorker`)
- Modify: `apps/api/src/services/workerRegistry.test.ts:25,54,60,64,84,91` and `apps/api/src/services/workerEntrypointClosure.contract.test.ts:272,301,454`

**Interfaces:**
- Consumes: `getBullMQConnection` (`services/redis`), `attachWorkerObservability` (`jobs/workerObservability.ts:201`), `resolveConnectionAndToken` (`accountingMappingService.ts:222`), `getConnection` (`accountingConnectionService.ts:119`), `getAccountingProvider`, `runOutsideDbContext` / `withSystemDbAccessContext` / `db`, `captureException`, and everything Task 1 and Task 3 export.
- Produces:
```ts
export const ACCOUNTING_RECONCILE_QUEUE = 'accounting-reconcile';
export const RECONCILE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export interface ReconcileConnectionJobData {
  type: 'reconcile-connection'; connectionId: string; partnerId: string;
  trigger: 'webhook' | 'sweep' | 'manual';
}
export interface ReconcileSweepJobData { type: 'sweep' }
export type AccountingReconcileJobData = ReconcileConnectionJobData | ReconcileSweepJobData;

export interface ReconcileRunSummary {
  applied: number; updated: number; replayed: number; reversed: number;
  skippedUnmapped: number; currencyMismatch: number; failed: number;
  invoicesMarkedDeleted: number;
  cursorBefore: Date | null; cursorAfter: Date | null;
}

/** Exported for direct unit testing (the invoiceWorker/accountingSyncWorker idiom). */
export async function processReconcileConnectionJob(data: ReconcileConnectionJobData): Promise<ReconcileRunSummary | null>;
export async function processReconcileSweep(): Promise<{ enqueued: number; failed: number }>;

/** jobId `accounting-reconcile-<connectionId>` (no colons). Returns whether the
 *  queue ACCEPTED the job — the "Sync now" route reports it honestly. */
export async function enqueueAccountingReconcile(
  connectionId: string, partnerId: string, trigger: ReconcileConnectionJobData['trigger'],
): Promise<boolean>;

export function getAccountingReconcileQueue(): Queue<AccountingReconcileJobData>;
export function createAccountingReconcileWorker(): Worker<AccountingReconcileJobData>;
export async function initializeAccountingReconcileWorkers(): Promise<void>;
export async function shutdownAccountingReconcileWorkers(): Promise<void>;
```

- [ ] **Step 1: RED — worker tests.** Create `accountingReconcileWorker.test.ts` reusing the `ctx.depth`/`runCtx` instrumentation from Task 3 (the `../db` mock exposes `hasDbAccessContext: () => ctx.depth > 0` and `withSystemDbAccessContext: (fn) => runCtx(fn)`, so the real `assertNoAmbientDbContext` runs its real logic). Cases:
  A shared empty fixture the gating cases assert against:
```ts
const EMPTY_CHANGESET: ChangeSet = {
  cursor: new Date('2026-09-02T20:10:00.000Z'), payments: [], deletedPayments: [], deletedInvoices: [],
};
```
  1. **Gating — no connection:** `getConnection` resolves null -> returns `null`, `reconcileChanges` never called.
  2. **Gating — not connected:** `status:'reauth_required'` -> returns `null`, provider never called.
  3. **Gating — pull off:** `pullPayments:false` -> returns `null`, provider never called, and `resolveConnectionAndToken` never called either (no token refresh for a switched-off connection).
  4. **No context around the provider call:**
```ts
let depthAtProviderCall = -1;
reconcileChangesMock.mockImplementationOnce(async () => { depthAtProviderCall = ctx.depth; return EMPTY_CHANGESET; });
await processReconcileConnectionJob({ type: 'reconcile-connection', connectionId: 'c1', partnerId: 'p1', trigger: 'sweep' });
expect(depthAtProviderCall).toBe(0);
expect(ctx.depth).toBe(0);
```
  5. **Deletions before additions:** a ChangeSet with `deletedPayments:['181']`, `deletedInvoices:['145']` and one payment line -> assert call order via a shared `order: string[]` push from each mock: `['markInvoiceDeletedRemotely', 'reverseAccountingPayment', 'applyAccountingPayment']`.
  6. **Cursor advances on a clean run:** all outcomes in `{applied, replayed, skipped_unmapped, currency_mismatch}` -> `advanceReconcileCursor` called once with `changeSet.cursor` and a `Date`; summary `cursorAfter` equals it.
  7. **Cursor does NOT advance on a dirty run:** one applier call rejects -> `advanceReconcileCursor` NOT called, and `processReconcileConnectionJob` rethrows so BullMQ retries.
  8. **Sweep:** `listReconcilableConnections` returns three rows -> `enqueueAccountingReconcile` called three times with `trigger:'sweep'`; a false return counts into `failed`; the enqueue calls happen at `ctx.depth === 0` (Redis work never inside a DB context).
  9. **Enqueue helper:** options are exactly `{ jobId: 'accounting-reconcile-c1', attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: true }`, the jobId contains no `:`, and a throwing `queue.add` is swallowed into `false` + `captureException`.
- [ ] **Step 2: Run to verify failure.** `cd apps/api && npx vitest run src/jobs/accountingReconcileWorker.test.ts` — expect FAIL (module does not exist).
- [ ] **Step 3: Implement the worker.** Module header records the retry taxonomy: a per-item `failed` leaves the cursor alone and rethrows (retryable); `currency_mismatch` and `skipped_unmapped` are recorded permanent outcomes and count as clean. `processReconcileConnectionJob` follows the Phase C shape exactly:
```ts
export async function processReconcileConnectionJob(data: ReconcileConnectionJobData): Promise<ReconcileRunSummary | null> {
  const startedAt = Date.now();
  return runOutsideDbContext(async () => {
    const runInDbContext = <T>(fn: () => Promise<T>): Promise<T> =>
      withSystemDbAccessContext(fn, `accountingReconcile.${data.trigger}`);

    const conn = await runInDbContext(() => getConnection(db, data.partnerId, 'quickbooks'));
    if (!conn || conn.id !== data.connectionId || conn.status !== 'connected' || !conn.pullPayments) return null;

    const { conn: fresh, liveConn } = await resolveConnectionAndToken(data.partnerId, 'quickbooks', runInDbContext);
    const provider = getAccountingProvider(fresh.provider);
    const changes = await runOutsideDbContext(() => provider.reconcileChanges(liveConn, fresh.cdcCursor));

    const summary = emptySummary(fresh.cdcCursor);
    // Deletions BEFORE additions (decision 4): a delete-and-recreate inside one
    // CDC window must not resurrect-then-delete.
    for (const remoteInvoiceId of changes.deletedInvoices) {
      const r = await markInvoiceDeletedRemotely(fresh, remoteInvoiceId, runInDbContext);
      if (r === 'marked') summary.invoicesMarkedDeleted++;
    }
    for (const remotePaymentId of changes.deletedPayments) {
      for (const r of await reverseAccountingPayment(fresh, remotePaymentId, runInDbContext)) tally(summary, r.outcome);
    }
    for (const line of changes.payments) {
      try {
        tally(summary, (await applyAccountingPayment(fresh, line, runInDbContext)).outcome);
      } catch (err) {
        summary.failed++;
        captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
          service: 'accountingPaymentPull', connectionId: fresh.id, remotePaymentId: line.remotePaymentId,
        });
      }
    }

    logRunLine(data, summary, Date.now() - startedAt);
    if (summary.failed > 0) {
      // Leave the cursor exactly where it was and rethrow so BullMQ retries the
      // whole window. Advancing past a failed item loses it permanently.
      throw new Error(`accounting reconcile for connection ${fresh.id} had ${summary.failed} failed item(s)`);
    }
    summary.cursorAfter = changes.cursor;
    await runInDbContext(() => advanceReconcileCursor(db, fresh.id, data.partnerId, changes.cursor, new Date()));
    return summary;
  });
}
```
  Supporting private helpers in the same module: `emptySummary(cursorBefore)` (all counters 0, `cursorAfter: null`), `tally(summary, outcome)` (one `switch` mapping each `PaymentPullOutcome` onto its counter — `failed` included, so a reversal that reports `failed` is caught the same way a thrown apply is), `logRunLine(data, summary, durationMs)` (one `console.log` with connectionId, trigger, every counter, cursor before/after and duration), and `scheduleRepeatSweep(): Promise<void>` (the remove-then-add below).
  Aggregate outcomes into `ReconcileRunSummary`; log one line per run (`connectionId`, trigger, counts by outcome, cursor before/after, duration ms). On a clean run, `await runInDbContext(() => advanceReconcileCursor(db, fresh.id, data.partnerId, changes.cursor, new Date()))`. Per-item terminal failures go to `captureException` with `{ service: 'accountingPaymentPull', connectionId, remotePaymentId }` and no QBO body. `processReconcileSweep` reads `listReconcilableConnections` in ONE short system context, then enqueues with nothing held. `initializeAccountingReconcileWorkers` creates the worker (concurrency 2), attaches observability as `'accountingReconcileWorker'`, awaits `backfillRealmFingerprints()` (decision 8 — log the counts, and `captureException` + continue on failure so a backfill problem never blocks worker boot), then `scheduleRepeatSweep()`: `getRepeatableJobs()` -> `removeRepeatableByKey` every entry named `'sweep'` -> `queue.add('sweep', { type: 'sweep' }, { repeat: { every: RECONCILE_SWEEP_INTERVAL_MS }, removeOnComplete: { count: 10 }, removeOnFail: { count: 30 } })`, exactly mirroring `huntressSync.ts:1108-1126`. **No `scheduleRegistry` slot** — 15 minutes is below `COARSE_REPEAT_INTERVAL_MS` (1 h) and `scheduleRegistry.contract.test.ts`'s coarse-`every` assertion only fires at or above that.
- [ ] **Step 4: Register in the worker registry and bump BOTH counters.** In `workerRegistry.ts`, immediately after the `accountingSyncWorker` entry (`:1086-1093`):
```ts
  {
    name: 'accountingReconcileWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/accountingReconcileWorker');
      return { init: m.initializeAccountingReconcileWorkers, shutdown: m.shutdownAccountingReconcileWorkers };
    },
  },
```
  **Do NOT copy `placement: 'global'` on faith** — `workerEntrypointClosure.contract.test.ts` is the mechanical authority (CLAUDE.md: never relitigate placement by guessing). Run it and take its verdict. Then: in `workerRegistry.test.ts` rename `EXPECTED_118_NAMES` -> `EXPECTED_119_NAMES` (both the declaration at `:25` and the use at `:60`), insert `'accountingReconcileWorker'` immediately after `'accountingSyncWorker'` in the list at `:54`, and change `118` -> `119` at `:64`, `:84`, `:91`. In `workerEntrypointClosure.contract.test.ts`, insert the same name after `'accountingSyncWorker'` at `:301` in `EXPECTED_NAMES` (`:272`) and change `118` -> `119` at `:454`.
- [ ] **Step 5: Run to verify pass.** `cd apps/api && npx vitest run src/jobs/accountingReconcileWorker.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/scheduleRegistry.contract.test.ts`.
- [ ] **Step 6: Commit.** `git commit -am "feat(accounting): accounting-reconcile worker with 15-minute CDC sweep and clean-run cursor advance"`

---

### Task 5: The Intuit webhook route

**Files:**
- Create: `apps/api/src/routes/webhooks/quickbooks.ts` (template: `apps/api/src/routes/tickets/emailWebhook.ts` — verify -> enqueue -> 202; the Stripe route reconciles inline and is deliberately NOT the model)
- Create: `apps/api/src/routes/webhooks/quickbooks.test.ts` (harness: `apps/api/src/routes/webhooks/stripe.test.ts`)
- Modify: `apps/api/src/index.ts` (import at the `:40` block, mount at `:931`)

**Interfaces:**
- Consumes: `getTrustedClientIp` + `rateLimitIpKey` (`services/clientIp`), `rateLimiter` (`services/rate-limit`), `getRedis`, `quickbooksProvider.verifyWebhook` (`quickbooksProvider.ts:569-576`, already shipped: HMAC-SHA256, base64, `timingSafeEqual`), `hmacFingerprint`, `findConnectionByRealmFingerprint` (Task 1), `enqueueAccountingReconcile` (Task 4), `withSystemDbAccessContext`, `QBO_WEBHOOK_VERIFIER_TOKEN` (Task 1), `captureMessage`/`captureException`.
- Produces: `export const quickbooksWebhookRoutes: Hono` mounted at `/webhooks`, serving `POST /api/v1/webhooks/quickbooks`. Status matrix:

| Status | Condition | Intuit behaviour |
|---|---|---|
| 429 | rate limiter denies (fails CLOSED, so a Redis outage lands here) | retries |
| 503 | `QBO_WEBHOOK_VERIFIER_TOKEN` unset — **never 200** | retries (24 h backoff) |
| 401 | missing or bad `intuit-signature` | does NOT retry |
| 400 | body is not JSON, or has no `eventNotifications` array | does NOT retry |
| 503 | every queue `add` for the request failed | retries |
| 202 | accepted (including "all realms unknown") | done |

- [ ] **Step 1: RED — route tests.** `quickbooks.test.ts`, mirroring `stripe.test.ts`'s `vi.hoisted` + sub-router `.request()` idiom:
```ts
const { rateLimiter, verifyWebhook, findConnectionByRealmFingerprint, enqueueAccountingReconcile, captureMessage } =
  vi.hoisted(() => ({
    rateLimiter: vi.fn().mockResolvedValue({ allowed: true }),
    verifyWebhook: vi.fn().mockReturnValue(true),
    findConnectionByRealmFingerprint: vi.fn().mockResolvedValue({ id: 'c1', partnerId: 'p1' }),
    enqueueAccountingReconcile: vi.fn().mockResolvedValue(true),
    captureMessage: vi.fn(),
  }));
// The route imports QBO_WEBHOOK_VERIFIER_TOKEN as a module-level const, so the
// token is per-module-instance: mock it once for the happy cases, and use
// vi.resetModules() + vi.doMock('') + a dynamic re-import for the single
// missing-token (503) case. Do NOT try to mutate the const between tests.
const envState = vi.hoisted(() => ({ verifierToken: 'test-verifier-token' }));
const TOKEN = 'test-verifier-token';
const SIG = 'ZmFrZS1zaWduYXR1cmU=';   // any base64 string; verifyWebhook is mocked
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  QBO_WEBHOOK_VERIFIER_TOKEN: envState.verifierToken,
}));
vi.mock('../../services/rate-limit', () => ({ rateLimiter }));
vi.mock('../../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: () => '1.2.3.4',
}));
vi.mock('../../services/accounting/providerRegistry', () => ({ getAccountingProvider: () => ({ verifyWebhook }) }));
vi.mock('../../services/accounting/accountingConnectionService', () => ({ findConnectionByRealmFingerprint }));
vi.mock('../../jobs/accountingReconcileWorker', () => ({ enqueueAccountingReconcile }));
vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn() }));

const BODY = JSON.stringify({ eventNotifications: [{ realmId: '1185883561', dataChangeEvent: { entities: [
  { name: 'Payment', id: '180', operation: 'Update', lastUpdated: '2026-09-02T20:04:34.000Z' },
] } }] });
```
  Cases: 429 when the limiter denies (and `verifyWebhook` never called); 503 + `captureMessage` when the env token is `''` — written as its own `it` that does `vi.resetModules(); envState.verifierToken = ''; const { quickbooksWebhookRoutes: fresh } = await import('./quickbooks');` and asserts `verifyWebhook` was never called (a 200 here would tell Intuit the event was handled when it was not); 401 with no `intuit-signature` header; 401 when `verifyWebhook` returns false; 400 on `'not json'`; 400 on `{}` (no `eventNotifications`); 202 + `enqueueAccountingReconcile('c1','p1','webhook')` called once on the happy path; **the RAW body string is passed verbatim to `verifyWebhook`** (`expect(verifyWebhook).toHaveBeenCalledWith(SIG, BODY, TOKEN)`); unknown realm -> 202 with zero enqueues; two notifications for the SAME realm -> exactly ONE enqueue; 503 when the only enqueue returns false; **no entity id appears in any `console.log`/`console.info` argument** (assert with a `console.info` spy against `/180/`).
- [ ] **Step 2: Run to verify failure.** `cd apps/api && npx vitest run src/routes/webhooks/quickbooks.test.ts`.
- [ ] **Step 3: Implement the route.** Header comment states the flow and the status table above. Order inside the handler: rate limit (`RATE_LIMIT = 240`, `RATE_WINDOW_SECONDS = 60`, key `qbo-webhook:${rateLimitIpKey(ip)}`) -> `const raw = await c.req.text()` (before anything can consume the body) -> env-token check -> `getAccountingProvider('quickbooks').verifyWebhook(sig, raw, QBO_WEBHOOK_VERIFIER_TOKEN)` -> `JSON.parse` in a try/catch -> shape check on `eventNotifications` -> for each unique `realmId`: `withSystemDbAccessContext(() => findConnectionByRealmFingerprint(db, 'quickbooks', hmacFingerprint(realmId)))` and, outside that context, `enqueueAccountingReconcile(conn.id, conn.partnerId, 'webhook')`. Count `{ notifications, matched, dropped, enqueued, failed }` and log one line with those counts and the entity NAMES only (`Payment`, `Invoice`), never ids. Return 503 when `enqueued === 0 && failed > 0`; otherwise 202 `{ accepted: true }`. The handler never acts on payload entity ids — CDC is the only thing that decides what changed.
- [ ] **Step 4: Mount it.** In `index.ts`, import `{ quickbooksWebhookRoutes }` alongside the Stripe webhook import at `:40`, and mount directly after `api.route('/webhooks', stripeWebhookRoutes);` at `:931`:
```ts
// Intuit QuickBooks webhook — no session auth, HMAC-gated with the app-level
// verifier token. partnerGuard passes through (no Authorization header); the
// route reads the raw body itself via c.req.text(), so no body-consuming
// middleware may sit in front of it. NOT in SELF_MANAGED_DB_CONTEXT_ROUTES:
// there is no ambient auth transaction to opt out of on an unauthenticated route.
api.route('/webhooks', quickbooksWebhookRoutes);
```
- [ ] **Step 5: Run to verify pass.** `cd apps/api && npx vitest run src/routes/webhooks/ src/middleware/selfManagedDbContextRoutes.test.ts` (the middleware suite must stay untouched and green).
- [ ] **Step 6: Commit.** `git commit -am "feat(accounting): Intuit webhook route that verifies, routes realms by fingerprint and enqueues a reconcile"`

---

### Task 6: Settings, "Sync now" route, and the `GET /:provider` fields

**Files:**
- Modify: `apps/api/src/routes/accounting/index.ts:93-99` (`settingsSchema`), `:527-563` (`GET /:provider`), `:615-655` (`PATCH /:provider/settings`), plus a new `POST /:provider/reconcile`
- Test: `apps/api/src/routes/accounting/index.test.ts` (extend), new `apps/api/src/routes/accounting/reconcile.test.ts` (harness: `routes/accounting/invoicePush.test.ts`'s `authState` mocks)
- **Untouched:** `apps/api/src/middleware/selfManagedDbContextRoutes.ts` and its test — see decision 6.

**Interfaces:**
- Consumes: `enqueueAccountingReconcile` (Task 4), `resolvePartnerId`, `partnerScopes`, `requireMfa()`, `requireInvoicePush` (`routes/accounting/index.ts:213-215`), `writeRouteAudit`.
- Produces:
  - `settingsSchema` gains `pullPayments: z.boolean().optional()`; the PATCH's spread gains `...('pullPayments' in body ? { pullPayments: body.pullPayments } : {})` and its `.returning({...})` gains `pullPayments: accountingConnections.pullPayments`.
  - `GET /accounting/:provider` response gains `pullPayments: boolean` and `lastReconcileAt: string | null` — and the not-connected branch (`:534-543`) gains `pullPayments: true, lastReconcileAt: null` so the shape is identical either way.
  - `POST /accounting/:provider/reconcile` — `authMiddleware, partnerScopes, requireMfa(), requireInvoicePush, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema)`; 404 when there is no connection; enqueues with `trigger: 'manual'`; returns `{ enqueued: boolean }` **honestly** (the Phase C lesson recorded at `accountingSyncWorker.ts:184-192`); audits `accounting.reconcile.requested` with `resourceType: 'accounting_connection'`, `details: { provider, connectionId, enqueued }`.

- [ ] **Step 1: RED — route tests.** In `index.test.ts`: `PATCH /accounting/quickbooks/settings` with `{ pullPayments: false }` persists it and echoes it; `settingsSchema` still rejects an empty body and still rejects `homeCurrency`/`multiCurrencyEnabled` (read-only captured facts); `GET /accounting/quickbooks` returns `pullPayments` and `lastReconcileAt` for a connected partner AND for the disconnected branch. In new `reconcile.test.ts`: 200 `{ enqueued: true }` on the happy path with `enqueueAccountingReconcile` called `('c1','p1','manual')`; 200 `{ enqueued: false }` (not a 500) when the enqueue returns false, with the audit recording `enqueued: false`; 404 when `getConnection` returns null; 403 for an org-scoped token; 403 without MFA; 403 without `invoices:write`; the audit fires with `action: 'accounting.reconcile.requested'`.
- [ ] **Step 2: Run to verify failure.** `cd apps/api && npx vitest run src/routes/accounting/`.
- [ ] **Step 3: Implement.** Add the schema field, the PATCH spread + returning, the two GET fields on both branches, and the route body (a `getConnection` read, then `enqueueAccountingReconcile`, then `writeRouteAudit`). Add a comment on the route explaining why it is NOT in `SELF_MANAGED_DB_CONTEXT_ROUTES`, citing the `push-bulk` precedent at `middleware/selfManagedDbContextRoutes.ts:90-92`.
- [ ] **Step 4: Run to verify pass.** `cd apps/api && npx vitest run src/routes/accounting/ src/middleware/selfManagedDbContextRoutes.test.ts`.
- [ ] **Step 5: Commit.** `git commit -am "feat(accounting): pullPayments setting, reconcile-now route and reconcile status on the connection GET"`

---

### Task 7: Web — toggle, last-sync, Sync now, QuickBooks payment badge

**Files:**
- Modify: `apps/web/src/components/integrations/QuickbooksIntegration.tsx` (`QuickbooksStatus` at `:28-46`, push-mode row at `:415-450`, refresh button at `:461-474`)
- Modify: `apps/web/src/components/billing/InvoiceDetail.tsx:545-564`, `apps/web/src/components/billing/invoiceTypes.ts:154`
- Modify: `apps/web/src/components/integrations/QuickbooksIntegration.test.tsx`, `apps/web/src/components/billing/InvoiceDetail` payments tests, `apps/web/src/components/billing/AccountingSyncCard.test.tsx`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS` + the `107` at `:522`)
- Modify: `apps/web/src/locales/<8 locales>/integrations.json` and `.../billing.json`

**Interfaces:**
- Consumes: `GET /accounting/quickbooks` (`pullPayments`, `lastReconcileAt`), `PATCH /accounting/quickbooks/settings` (`{ pullPayments }`), `POST /accounting/quickbooks/reconcile` (`{ enqueued }`), `invoice.payments[].source`.
- Produces:
```ts
// invoiceTypes.ts:154 — widened
source?: 'stripe' | 'manual' | 'quickbooks';
// QuickbooksIntegration.tsx — QuickbooksStatus gains
pullPayments?: boolean;
lastReconcileAt?: string | null;
// new handlers, both through runAction
async function handleSetPullPayments(next: boolean): Promise<void>;
async function handleReconcileNow(): Promise<void>;
```
  New `data-testid`s: `quickbooks-pullpayments` (the toggle), `quickbooks-last-reconcile` (the line), `quickbooks-reconcile-now` (the button), `invoice-payment-quickbooks-${p.id}` (the badge).
  New i18n keys — `integrations.json` under `quickbooksIntegration`: `pullPayments`, `pullPaymentsDescription`, `pullPaymentsEnabled`, `pullPaymentsDisabled`, `failedToUpdatePullPayments`, `lastPaymentSync`, `never`, `syncNow`, `syncNowQueued`, `syncNowNotQueued`, `failedToSyncNow`. `billing.json` under `invoiceDetail.payments`: `quickbooks`, `viaQuickbooks`.

- [ ] **Step 1: RED — component tests.**
  - `QuickbooksIntegration.test.tsx`: the toggle renders from `pullPayments` and PATCHes `{ pullPayments: false }` through `fetchWithAuth`, showing the success toast; a failing PATCH shows the error toast and reverts the switch; `lastReconcileAt: null` renders the "Never" copy and a timestamp renders formatted; "Sync now" POSTs `/accounting/quickbooks/reconcile` and toasts `syncNowQueued`; a `{ enqueued: false }` response toasts `syncNowNotQueued` (**not** success — this is the honest-reporting rule reaching the UI); the org-scoped branch (`getJwtClaims` -> `scope: 'organization'`) still short-circuits to `quickbooks-org-scope` and renders none of the three new controls.
  - `InvoiceDetail` payments tests: `source: 'quickbooks'` renders `invoice-payment-quickbooks-${id}` with the `quickbooks` copy and renders `viaQuickbooks` **instead of** `invoice-payment-void-${id}`; `source: 'manual'` still renders the void button; `source: 'stripe'` is unchanged.
  - `AccountingSyncCard.test.tsx`: a `syncStatus: 'error'` card with `lastError: 'Deleted in QuickBooks'` renders that exact string in `invoice-accounting-sync-error` (pins the copy path the spec relies on — no new branch is added to the component).
- [ ] **Step 2: Run to verify failure.** `cd apps/web && npx vitest run src/components/integrations/QuickbooksIntegration.test.tsx src/components/billing/AccountingSyncCard.test.tsx src/components/billing/InvoiceDetail`.
- [ ] **Step 3: Implement.** Both new handlers go through `runAction` with `errorFallback`/`successMessage`/`onUnauthorized` exactly like `handleSetPushMode` (`:190-226`) and `handleRefreshSettings` (`:231-266`). The toggle sits directly beside the push-mode row; the "Last payment sync" line and "Sync now" button sit beside the "Refresh settings" button. Widen the `source` union in `invoiceTypes.ts` and add the two branches in `InvoiceDetail.tsx` (mirroring the Stripe branch at `:545-564` — a badge span plus a `viaQuickbooks` label replacing the void button). All copy through `t(...)`.
- [ ] **Step 4: i18n in all 8 locales.** Add the 12 `integrations.json` keys and 2 `billing.json` keys to `apps/web/src/locales/en/` first, then write **genuine translations** in `de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR` — do not copy the English through. `translationCoverage.test.ts` enforces both a global `< 0.2` duplicate ratio (`:588`) and per-namespace, per-locale duplicate baselines (`namespaceDuplicateBaselines` at `:15`); adding English-identical strings to `billing.json`/`integrations.json` will breach those ceilings. If a genuinely untranslatable proper noun ("QuickBooks") is the whole value, that key is the only acceptable duplicate.
- [ ] **Step 5: `no-silent-mutations` registration.** `QuickbooksIntegration.tsx` is currently NOT in `TARGET_GLOBS` (only `QuickbooksMappingWorkbench.tsx` at `:136` is), so its mutations ship unguarded today and the two new ones would too. Add `'src/components/integrations/QuickbooksIntegration.tsx'` to `TARGET_GLOBS`, bump `expect(absoluteFiles.length).toBe(107)` -> `108` at `:522`, and append a line to the changelog comment block above it recording why. (`InvoiceDetail.tsx` at `:118` and `AccountingSyncCard.tsx` at `:123` are already members; they need no bump.)
- [ ] **Step 6: Run to verify pass.** `cd apps/web && npx vitest run src/components/integrations/QuickbooksIntegration.test.tsx src/components/billing/ src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/translationCoverage.test.ts`.
- [ ] **Step 7: Commit.** `git commit -am "feat(web): QuickBooks pull-payments toggle, sync-now action and QuickBooks payment badge"`

---

### Task 8: Contract comment, docs, sandbox checklist, full sweep, PR

**Files:**
- Modify: `apps/api/src/services/accounting/accountingCurrency.ts:143-186` (the deferred-enforcement comment)
- Modify: `docs/integrations/quickbooks-sandbox-verification.md` (a `### Phase D checklist (payment pull-back)` section after the Phase C block at `:282-334`)
- Modify: `apps/docs/src/content/docs/features/accounting-integrations.mdx`

**Interfaces:** consumes everything; produces no code contracts.

- [ ] **Step 1: Mark item 4 delivered and record the refinement.** Rewrite the trailing block in `accountingCurrency.ts` so the STATUS line reads that items 1-4 are all delivered, and replace item 4's body with what actually shipped, naming `accountingPaymentPull.ts` and `apps/api/src/__tests__/integration/accountingPaymentPull.integration.test.ts`. It must state the one deliberate refinement in plain terms: the at-most-once claim is keyed on the COMPOSITE `remote_entity_id` `'<PaymentId>/<remoteInvoiceId>'`, not on `remotePaymentId` alone, because one QBO Payment legitimately settles several Breeze invoices and a bare payment id could represent only the first of them. Also record the ordering the applier actually takes (unlocked mapping discovery -> invoice `FOR UPDATE` -> mapping re-read under the lock -> `normalizeAccountingPayment` against the LOCKED invoice's currency -> claim + insert + recompute in the same transaction) and point at the integration test that proves it.
- [ ] **Step 2: Sandbox checklist.** Add `### Phase D checklist (payment pull-back)` continuing the existing numbering at 17, in the same "**bold instruction** / Result: / Visible status:" format the Phase C block uses, with a `Status: PENDING` line noting it has not been run:
  17. **Register the webhook URL through a tunnel and confirm Intuit's verifier handshake**, then receive a PARTIAL payment against a pushed invoice in QBO and confirm Breeze flips the invoice to `partially_paid` within seconds with a "QuickBooks" badge on the payment row.
  18. **Record the remaining balance in QBO** and confirm Breeze flips to `paid` with `paid_at` stamped.
  19. **Replay the same Intuit notification** (re-deliver from the Intuit dashboard, or re-run "Sync now") and confirm NO duplicate payment row appears and the run logs `replayed`.
  20. **Delete the payment in QBO** and confirm Breeze deletes only that payment row, recomputes the invoice, and writes an `accounting.payment.reversed` audit entry — while a manually recorded payment on the same invoice survives untouched.
  21. **Disable the webhook and let the 15-minute sweep run with a stale cursor** — confirm the same end state is reached with no webhook at all (this is the guaranteed path in every region; only the US deployment receives Intuit notifications).
  22. **Record the observed CDC paging behaviour**: make more than 1000 payment changes in one window if feasible, otherwise capture a normal response's `QueryResponse` block verbatim (`startPosition`, `maxResults`, `totalCount`) so decision 3's window-halving can be confirmed or replaced with a real cursor.
  23. **Toggle `pull_payments` off** and confirm the next sweep no-ops for that connection (no QBO call at all), then toggle it back on and confirm the backlog lands on the following run.
  Also add: **void an invoice in QBO** and confirm the Breeze invoice mapping flips to `error` / "Deleted in QuickBooks" in the sync card and is never auto-resurrected.
- [ ] **Step 3: Feature docs.** In `accounting-integrations.mdx`, document the pull-back: what is mirrored (QBO-origin payments only), what is not (manual and Stripe payments, credit memos, QBO-originated refunds, foreign-currency payments), the 15-minute sweep vs. the webhook latency optimisation and why only one region receives notifications, the `pullPayments` switch and why it exists (double-entry double-counting until the payment PUSH slice lands), and the exact "Deleted in QuickBooks" invoice-mapping error copy.
- [ ] **Step 4: Full verification sweep.** In order, all from the repo root unless noted:
```bash
pnpm --filter @breeze/api test                                   # full API unit suite
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/accountingPaymentPull.integration.test.ts \
  src/__tests__/integration/accountingRealmFingerprint.integration.test.ts \
  src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts \
  src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts \
  src/__tests__/integration/tenantCascadeExecution.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls.ts
pnpm --filter @breeze/web test
pnpm db:check-drift                                              # clean
bash scripts/check-migration-naming.sh
pnpm lint
pnpm build --filter @breeze/api --filter @breeze/web             # tsc via turbo
```
- [ ] **Step 5: Commit.** `git commit -am "docs(accounting): Phase D contract closure, sandbox checklist and pull-back feature docs"`
- [ ] **Step 6: Open the PR and STOP.** `gh pr create --base main --head feat/quickbooks-payment-pullback` with a body covering: the four new columns and the migration name, the webhook status matrix, the worker/queue and its two counter bumps, the applier's lock order and at-most-once key, the `partner-wide-write-coverage` exemption, the `no-silent-mutations` bump, and the two divergences named in decisions 1 and 2. Then run ONE `requesting-code-review` round and fix confirmed findings inline. **Do not merge, do not deploy** — the sandbox walkthrough (Step 2) has to be executed against a live Intuit sandbox before this ships.

---

## Self-review notes (kept for executors)

- **Spec coverage.** Migration + 4 columns (T1); realm fingerprint + backfill + lookup (T1); `QBO_WEBHOOK_VERIFIER_TOKEN` (T1); CDC `reconcileChanges`, widened `ChangeSet`, 30-day floor, voided-as-deletion, paging (T2); applier apply/reverse/mark-deleted, method mapping, audit rows, over-payment posture (T3); the two live Phase-D TODOs and `listPayments` source (T3); `partner-wide-write-coverage` exemption (T3); worker + sweep + registry + both counters (T4); webhook route, mount, rate limit, status matrix, unknown-realm drop, counters (T5); `pullPayments` setting, `GET` fields, "Sync now" (T6); web toggle/last-sync/Sync-now/badge/void-suppression/i18n (T7); `accountingCurrency.ts` item 4, sandbox walkthrough, feature docs (T8). Out of scope per the spec and untouched here: payment PUSH Breeze -> QBO, foreign-currency payments, credit memos and QBO refunds, cross-region webhook forwarding, dropping `webhook_verifier_token_encrypted`.
- **Two deliberate divergences from the spec's prose, both recorded as locked decisions rather than silently applied.** (a) Decision 1: the mapping's `remote_entity_id` is the composite `<PaymentId>/<remoteInvoiceId>`, which the spec's "Data model" section already prescribes but `accountingCurrency.ts` item 4 does not — T8 reconciles the comment. (b) Decision 2: the spec justifies allowing over-payment with "Breeze already tolerates multiple payments past balance", which is not true of the manual path — `invoiceService.recordPayment` throws `OVERPAYMENT` at `invoiceService.ts:1418-1420`. The applier still allows it, for the reason stated in decision 2, but the justification is the correct one.
- **Decision 3 (CDC window-halving) is the one place the plan implements a mechanism the spec describes differently** ("`maxResults`/`startPosition` per entity"). QBO's `/cdc` operation has no `startPosition` cursor; window-halving is deterministic and correct regardless of which is true, and sandbox item 22 captures the evidence to settle it.
- **No new tables, so no cascade/export-policy/RLS-allowlist work** — verified against the shipped Phase C arms (`tenantCascade.ts:651-661`, `orgMerge.ts:841-878`, `orgMergeRegistry.ts:555`, `rls-coverage.integration.test.ts:216`), not assumed. Re-grep before writing T3 anyway; that list is the one that gets missed.
- **The worker registry counter appears in FOUR places across two files** (`workerRegistry.test.ts:64,84,91` plus the renamed `EXPECTED_118_NAMES` at `:25,60`; `workerEntrypointClosure.contract.test.ts:301,454`). Missing one reds the Test API job.
- **`placement: 'global'` in T4 Step 4 is a proposal, not a verdict.** Run `workerEntrypointClosure.contract.test.ts` and take what it says (CLAUDE.md: never relitigate placement by guessing).
- **T7 Step 5 fixes pre-existing debt on purpose:** `QuickbooksIntegration.tsx` has run-action mutations today but is absent from `no-silent-mutations`' `TARGET_GLOBS`, so nothing was guarding them. Adding the file is what the counter bump is for; it is in scope because this task adds two more mutations to that same file.
- **`selfManagedDbContextRoutes.ts` is deliberately untouched** (decision 6). If a reviewer asks why the reconcile route is not registered there, the answer is in the route's own comment and in the `push-bulk` precedent at `:90-92`: the handler enqueues to Redis and makes no outbound QuickBooks call, so there is nothing to opt out of.
