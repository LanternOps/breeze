# Xero W01: Core Neutralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the accounting core provider-neutral (one active connection per partner, neutral errors, capabilities, rate limiting, generic API and web) with **no QuickBooks behaviour change**, so W02–W05 can add Xero as a second `AccountingProvider`.

**Architecture:** Every `(partner, 'quickbooks')` lookup becomes `resolveActiveConnection(partnerId)` over a DB-enforced one-row-per-partner `accounting_connections`. QuickBooks-specific mechanics (fault parsing, idempotency keys, payment marker, 21-char reference cap, payment-method names, the "Deleted in QuickBooks" label) move behind the `AccountingProvider` interface. The core branches only on `AccountingProviderError.kind` and on `provider.capabilities`. A shared Redis limiter, specified by `provider.limits.rate`, turns throttling into a delayed retry that consumes no attempt.

**Tech Stack:** TypeScript, Hono, Drizzle ORM on PostgreSQL (RLS), BullMQ + ioredis, Vitest, React (Astro islands) + react-i18next.

**Spec:** `docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md` (the "W01 — Core neutralization" section and the "Advisor quorum" table). Program index: `docs/superpowers/plans/billing/2026-09-26-xero-accounting-integration-index.md`.

---

## Preconditions (hard gates, check before Task 1)

1. **PR #7136 merged** (`fix/quickbooks-synctoken-and-quote-push`, #7134/#7135). It rewrites parts of `quickbooksProvider.ts` (SyncToken healing), `accountingMappingService.ts` and `quoteAcceptService.ts`. W01 edits the same code.
2. **Issue #7161 fix merged** (PR #7165, branch `fix/7161-qbo-hidden-line-totals`, cut from main; error code `invoice_totals_mismatch`, post-push total drift reuses `synced_with_tax_variance` with `totalVarianceCents`). It zeroes hidden (`customerVisible = false`) lines in `buildLinePayload`, asserts that the pushed lines sum to Breeze's `subtotal` (`invoice_totals_mismatch`), and compares `remoteTotal` after a push. **W01 does not re-implement that fix.** Task 11 only moves its logic into the provider-neutral path and keeps its tests green. If #7161 is not on `origin/main` when W01b starts, stop and wait. Do not copy its diff into W01.

Check:

```bash
git fetch origin main
git log origin/main --oneline | grep -E '#7136|#7134|#7161' || echo "PRECONDITION NOT MET"
```

Expected: the #7136 squash commit and the #7161 fix commit are both listed. `PRECONDITION NOT MET` means stop.

**Line numbers in this plan** are from `origin/main` at `38d757815` (2026-09-26). Both preconditions shift them. Every task names the **symbol** it changes, so locate code by symbol and re-grep. Do not trust a line number on its own.

## Where this plan corrects or refines the spec (read before implementing)

Each item below was checked against the code. Where the plan does something the spec does not say, the reason is given.

1. **The old index is kept, not swapped (deviation, rollback safety).** The spec says to *replace* `accounting_connections_partner_provider_idx (partner_id, provider)` with a unique index on `(partner_id)`. `upsertConnection` does `ON CONFLICT (partner_id, provider)`, and Postgres needs a unique index that exactly matches the conflict target. If the old index is dropped and W01 is then rolled back to the previous image, every QuickBooks OAuth reconnect fails with "no unique or exclusion constraint matching the ON CONFLICT specification". The same failure hits during the rolling-restart window. W01 therefore **adds** `accounting_connections_partner_idx (partner_id)` and **keeps** the old index. The old index is redundant but harmless, because a unique `(partner_id)` implies a unique `(partner_id, provider)`. Dropping it is a one-line follow-up for any release after W01 has shipped. The plan files that follow-up; it is not part of W01.
2. **The migration's duplicate check must elect system scope.** `accounting_connections` is `FORCE ROW LEVEL SECURITY`. Migrations run as the table owner, so under the default `breeze.scope = 'none'` the `SELECT … HAVING count(*) > 1` sees **zero rows** and the assertion passes without checking anything. The spec does not mention this. The DO block runs `PERFORM set_config('breeze.scope', 'system', true)` first. (The index build itself is not RLS-filtered, so a real duplicate would still abort with 23505. The pre-check exists to give a readable message with a count.)
3. **`'quickbooks_error'` is never persisted.** The spec says "existing `'quickbooks_error'` values remain readable (no data migration)". A grep of `apps/api/migrations`, the Drizzle schema and `apps/web/src` finds the string only as an **in-process error code**: thrown by the coordinators, matched by the sync worker, and returned as the HTTP `code` field. No column stores it, and the web never reads it (verified: zero hits in `apps/web/src`). So: new throws use `'provider_error'`, the unions keep `'quickbooks_error'` as a dead alias, and the worker treats both as retryable. **HTTP responses that used to say `code: 'quickbooks_error'` now say `code: 'provider_error'`.** That is the one observable API change in W01. Its only consumers are tests. The affected test assertions are listed in Task 8.
4. **Payment jobs bind to a connection through their mapping row, not a payload field.** A payment job's `mappingId` names an `accounting_entity_mappings` row whose `integration_id` *is* the connection id (composite FK, `ON DELETE CASCADE`). Adding `connectionId` to payment payloads would duplicate that binding and allow the two to disagree. So payment jobs resolve their connection **from the mapping** and pass it to the coordinator as the target. This does not reinterpret the destination: disconnecting deletes the mapping by cascade, and the job then finds nothing owed. `push-invoice`, `void-invoice` and `sync-mapping` payloads gain `connectionId` as the spec says. The reconcile queue **already** carries `connectionId` (`ReconcileConnectionJobData`, `jobs/accountingReconcileWorker.ts`), which the spec's audit missed. W01 only changes how that worker *loads* the row: by id instead of `(partner, 'quickbooks')`.
5. **The remote-deleted "stable machine code" has nowhere to live.** The spec says the sentinel becomes "a provider-labelled constant plus a stable machine code; comparisons use the code". `accounting_entity_mappings` has no code column, and the spec also says "No new tables" and adds no mapping column. W01 keeps the persisted text: `Deleted in QuickBooks` stays byte-identical, and Xero will write `Deleted in Xero`. Comparisons go through a closed marker set (`INVOICE_REMOTE_DELETED_MARKERS`) plus the predicate `isInvoiceRemoteDeletedMarker()`. SQL guards use `notInArray`. The "machine code" is the classifier's return value `'remote_deleted'`, which already exists as `AccountingInvoicePushErrorCode 'remote_deleted'`. No data migration is needed.
6. **A throttled payment push must not count against the payment outbox.** The spec says "re-queues … without consuming a retry attempt", which is true of BullMQ attempts. The payment coordinator also has its own ceiling, `sync_attempts` / `PAYMENT_PUSH_MAX_ATTEMPTS = 100`, which marks a row `gave_up`, and a 10-minute claim lease (`PAYMENT_CLAIM_LEASE_MS`). A 429 must use `markPaymentMappingError(..., { countAttempt: 'never' })`. That releases the lease and keeps `pending_op` without counting. Otherwise sustained throttling would retire real pushes, and the lease would block the delayed retry for 10 minutes.
7. **The spec's call-site list is incomplete.** Also pinned to QuickBooks, and handled here:
   - `accountingPaymentPull.ts`: `mapQboPaymentMethod`, and the persisted messages `'Deleted in QuickBooks'` and `'Edited in QuickBooks; …'`.
   - `accountingPaymentMarker.ts`: `partialRefundDivergenceMessage` says "QuickBooks".
   - `accountingPaymentPush.ts`: `loadConnectedConnection`, and the `fireAudit({ provider: 'quickbooks' })` calls at ~776 and ~2003.
   - `routes/webhooks/quickbooks.ts`: `findConnectionByRealmFingerprint(db, 'quickbooks', …)`.
   - `invoiceService.ts` payment list: `source: 'quickbooks'`.
   - `routes/accounting/index.ts` callback: `environment: QBO_ENVIRONMENT`, and the audit key `quickbooksCustomerId`.
8. **Public API names that stay.** `InvoiceServiceError` code `'QUICKBOOKS_OWNED_PAYMENT'` and the void response field `quickbooksRecordUntouched` are read by `apps/web` (`InvoiceDetail.tsx` ~l.246, `InvoiceDetail.test.tsx:263`). Renaming them is a breaking API change with no Xero need in W01. They keep their names; only the human message interpolates the provider name. A generic rename is noted for W05, where the Xero-owned payment case first exists.
9. **"The entire existing QuickBooks suite passes unchanged" is read as "no assertion about QuickBooks behaviour changes".** Three kinds of test edit are unavoidable and are listed per task:
   - **Mock wiring.** For example, a worker test that mocked `getConnection` now mocks `getConnectionById` / `resolveActiveConnection`.
   - **Provider-rejection fixtures.** Core tests that hand-build a raw QuickBooks-shaped rejection (`{ status, qboFaultCode, … }`) now build it through `qboErrorToProviderError(...)`, because the provider throws that type.
   - **The code rename in item 3.** `'quickbooks_error'` becomes `'provider_error'`.

   Operator-visible strings (`QuickBooks rejected the payment sync (HTTP 400: Business Validation Error)`), Sentry tags (`qbo_fault_code`), statuses, and QBO `requestid`s stay **byte-identical**, and tests pin them.
10. **429 handling is a deliberate QuickBooks behaviour change**, and the spec mandates it. Today a QBO 429 is a generic error. It burns the BullMQ ladder (5 s → 80 s, 5 attempts) and increments `sync_attempts`. From W01c it becomes a delayed retry after `Retry-After` (default 60 s) that consumes no attempt. This is the only intended QBO behaviour change besides item 3. The UI hiding the bulk "push" action when no invoice-push-capable connection exists (Task 18) is a change only for **disconnected** partners, where the action already did nothing.
11. **CLAUDE.md tenancy obligations.** W01 adds no table and no column, only one index. So no cascade list, no `CORE_TENANT_EXPORT_POLICY` entry, no RLS allowlist change, and no org-merge policy. `accounting_connections` is partner-axis (shape 3) and is not in the org cascade (verified). No new file writes `accounting_connections` or `accounting_entity_mappings` directly, so `partner-wide-write-coverage.test.ts` needs no new allowlist entry. The test is still run in every PR (see Global Constraints) because it fails on a *stale* entry too. W01 adds no env var, so `envComposeParity.test.ts` is untouched. `XERO_DAILY_CALL_LIMIT` belongs to W02.

## Global Constraints

- No QuickBooks behaviour change except items 3 and 10 above. Every existing QBO unit and integration assertion keeps its meaning.
- QBO idempotency keys are byte-identical: invoice create `requestid = invoiceId`. Payment create `requestid = invoicePaymentId` when `pushGeneration === 0`, else `` `${invoicePaymentId}:g${pushGeneration}` ``. Customer create `` `customer-${organizationId}` ``. Item create `` `item-${catalogItemId}` ``. Task 10 pins all four.
- One accounting connection per partner, DB-enforced by `accounting_connections_partner_idx`. Connecting a different provider while any row exists returns **409** `{ code: 'accounting_provider_conflict' }`.
- A job's destination is never reinterpreted. Jobs without a `connectionId` (enqueued before deploy) run only when the partner's active connection has `provider === LEGACY_UNTARGETED_JOB_PROVIDER` (`'quickbooks'`, declared in `providerRegistry.ts`). Otherwise they are logged and completed.
- A capability is enforced at every layer. Routes return 409 `{ code: 'capability_unavailable' }`. Producers do not enqueue. Workers log and complete. The UI hides the control.
- The core never imports `quickbooksFault`, `quickbooksProvider` or any `qbo*`/`Qbo*`/`QBO_*` symbol, and never contains the literal `'quickbooks'`, except in the allowlist in Task 17.
- Migrations: the filename sorts after the newest committed migration (it was `2026-11-02-100400-backup-jobs-last-keepalive-at.sql` on 2026-09-26; re-check with `git ls-tree --name-only origin/main apps/api/migrations/ | sed 's#.*/##' | grep '^20' | sort | tail -1`). The migration is idempotent, has no inner `BEGIN`/`COMMIT`, and elects `breeze.scope = 'system'` before any read or write that must see all rows. Never edit a shipped migration.
- DB context: provider HTTP calls and Redis round trips run with no held DB context (`runOutsideDbContext`). Producers read partner-axis `accounting_connections` through `readWithPartnerAxisVisibility` (`db/partnerAxisRead.ts`). Under an org-scoped request context a plain read returns zero rows and silently skips the enqueue.
- Web mutations stay wrapped in `runAction`. `data-testid`s for QuickBooks stay byte-identical (`quickbooks-connect`, …): they become `` `${provider}-connect` ``.
- Run single test files with `cd apps/api && npx vitest run <path>`. Never use `pnpm … test -- --run`. Integration suites: `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>`, then `pnpm test-stack down`.
- Every PR runs, before opening: the full API unit suite (`cd apps/api && npx vitest run`), `npx tsc --noEmit -p apps/api`, and the accounting integration set below. PRs that touch the web also run `cd apps/web && npx vitest run` and `npx tsc --noEmit -p apps/web`.
- Files: aim for fewer than 500 lines for **new** files. `routes/accounting/index.ts` (1,325 lines) must not grow. New route helpers go in `routes/accounting/providerGate.ts`.

**The accounting integration set** (run in every W01 PR; verified list, grep `accounting|quickbooks` under `apps/api/src/__tests__/integration`):

```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts \
  src/__tests__/integration/accounting-connections-rls.integration.test.ts \
  src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts \
  src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts \
  src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts \
  src/__tests__/integration/accountingPartnerAuthority.integration.test.ts \
  src/__tests__/integration/accountingPaymentPull.integration.test.ts \
  src/__tests__/integration/accountingPaymentPush.integration.test.ts \
  src/__tests__/integration/accountingRealmFingerprint.integration.test.ts \
  src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts \
  src/__tests__/integration/orgAccountReadinessIntegrations.integration.test.ts \
  src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts \
  src/__tests__/integration/tenantCascadeExecution.integration.test.ts \
  src/__tests__/integration/tenantCascadeErasureBreadth.integration.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm test-stack down
```

Expected: every file passes. `accountingOneConnectionPerPartner.integration.test.ts` does not exist until Task 1 creates it. Before that, drop it from the list. If a filename above no longer exists, re-run `ls apps/api/src/__tests__/integration | grep -iE 'accounting|quickbooks|orgAccountReadiness|orgMergeCustom|tenantCascade'` and use that list. Do not skip a file silently.

**The QBO unit set** (the guard for "no behaviour change"; every task's verify step runs this):

```bash
cd apps/api && npx vitest run \
  src/services/accounting \
  src/jobs/accountingSyncWorker.test.ts src/jobs/accountingReconcileWorker.test.ts \
  src/routes/accounting \
  src/routes/webhooks \
  src/services/invoiceService \
  src/services/stripeReconcile src/services/stripeReversalState \
  src/services/quoteAcceptService \
  src/__tests__/partner-wide-write-coverage.test.ts \
  src/middleware/selfManagedDbContextRoutes.test.ts
```

Expected: `Test Files  N passed (N)`, and zero failed. Vitest filters are substring matches, so check that the reported file count is at least the number from the baseline run in Task 0.

## Review Focus

These are the failure modes the spec implies but no task would test on its own, most likely first. Each has a pinned test in the task that owns the code.

1. **A provider switch with jobs still queued.** A partner disconnects QuickBooks and connects another provider while `push-invoice` / `void-invoice` / `sync-mapping` jobs carrying the old `connectionId` sit in the queue. Expected: every such job is logged `reason=connection_gone` and completes without calling any provider. It does not fail, and it never runs against the new connection. *(Task 5, test "drops a job whose connection was replaced".)*
2. **A QBO create in flight before deploy, retried after it.** A `push-invoice` enqueued by the old image (no `connectionId`) whose create reached Intuit but whose response was lost. After deploy, BullMQ retries it. Expected: it runs, because the active provider is QuickBooks, and it sends the byte-identical `requestid=<invoiceId>`, so Intuit replays the original response and no duplicate invoice is created. *(Task 5, "legacy job runs against the active QuickBooks connection". Task 10, the requestid pin.)*
3. **A Stripe partial refund after the index change.** Expected: the divergence flag lands only on the payment mapping under the partner's active connection (`integration_id` filter). With no connection, zero rows are updated and nothing throws. *(Task 6.)*
4. **A partner with a stale `'disconnected'` row tries to connect.** The status union allows `'disconnected'`, although today's disconnect deletes the row. A row like that for provider A blocks a connect for provider B: `upsertConnection` → `AccountingProviderConflictError` → **409** `accounting_provider_conflict`, and the A row is untouched. A reconnect of provider A reuses the row (same id, same mappings). *(Task 2 unit, Task 1 integration, Task 15 route.)*
5. **A 429 during a payment push.** Expected: the mapping keeps `pending_op = 'push'`, `claimed_at` is released, `sync_attempts` is unchanged, and `last_error` says the provider is rate limiting. The BullMQ job is moved to delayed at `now + Retry-After` via `job.moveToDelayed(ts, token)` + `DelayedError`, and `attemptsMade` is not incremented. No `gave_up` ever results from throttling. *(Task 14.)*
6. **Redis unavailable at call time.** Expected: the local limiter fails **open** (`getRedis()` returns null) and the provider's own 429 stays the backstop. Accounting pushes are never blocked because a Redis replica flapped. *(Task 12.)*

---

## PR split

| PR | Branch (feature-lifecycle: `feature/<parent#>-xero/wave-<W01#>` + suffix) | Tasks | What ships | Stands alone because |
|---|---|---|---|---|
| **W01a** Server seam | `…/wave-<W01#>-a-seam` | 0–7 (8 tasks) | index + migration, `resolveActiveConnection`, provider-conflict 409 in the service, capabilities on the interface, every core lookup moved to the resolver, `connectionId` in job payloads + worker drop rules, Stripe `integration_id` filter, webhook routing helper | QBO declares every capability, and the resolver returns the one QBO row. Behaviour is identical. |
| **W01b** Errors + provider mechanics | `…/wave-<W01#>-b-mechanics` | 8–11 (4 tasks) | `AccountingProviderError` + QBO boundary translation, `'provider_error'`, mechanics table (remoteVersion, marker, limits, method, displayName/sentinel), requestid pin test, totals invariant in the neutral path | QBO translates its own faults, so the core sees the same classification. Strings, tags and keys are pinned. |
| **W01c** Rate limiting | `…/wave-<W01#>-c-ratelimit` | 12–14 (3 tasks) | generic per-connection + app-wide + concurrency limiter, daily-budget hook, QBO 429 → `rate_limited`, delayed requeue without an attempt | QBO limits (500/min, 10 concurrent per realm) sit above today's traffic. The only change is 429 handling (preamble item 10). |
| **W01d** API + web + guard | `…/wave-<W01#>-d-surface` | 15–19 (5 tasks) | route param enum + capability gate + explicit config errors + provider in OAuth state + `GET /accounting/providers`, `accountingCustomerImport.ts`, neutral-core guard test, generic web shell + provider-param components, i18n generalization | `xero` is accepted by the enum but refused by the registry gate, because it is not registered until W02. |

Merge order is strictly a → b → c → d. Each PR targets `main` and is rebased on the previous one after it merges. Do not stack PRs: a stacked PR runs no CI (CLAUDE.md).

---

## File structure

**Created**

| File | Responsibility | PR |
|---|---|---|
| `apps/api/migrations/2026-11-02-110000-accounting-connections-one-per-partner.sql` | Assert ≤1 row per partner, then add the unique `(partner_id)` index | a |
| `apps/api/src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts` | Real-DB proof of the index, the migration assertion and the conflict upsert | a |
| `apps/api/src/services/accounting/accountingWebhookRouting.ts` (+ `.test.ts`) | `routeWebhookToConnection(provider, fingerprint)` | a |
| `apps/api/src/jobs/accountingJobConnection.ts` (+ `.test.ts`) | `resolveJobConnection()`: connectionId / legacy / capability drop rules shared by both workers | a |
| `apps/api/src/services/accounting/accountingProviderError.ts` (+ `.test.ts`) | `AccountingProviderError`, `providerFaultSuffix`, `providerErrorKindOf` | b |
| `apps/api/src/services/accounting/quickbooksIdempotency.test.ts` | Pins the four QBO requestids byte-for-byte | b |
| `apps/api/src/services/accounting/accountingInvoiceTotals.ts` (+ `.test.ts`) | Provider-neutral totals invariant (moved from #7161's location) | b |
| `apps/api/src/services/accounting/accountingRateLimit.ts` (+ `.test.ts`) | Per-connection window + concurrency + app-wide limiter, daily-budget hook | c |
| `apps/api/src/jobs/accountingJobDelay.ts` (+ `.test.ts`) | `delayJobForRateLimit(job, token, retryAfterMs)` | c |
| `apps/api/src/routes/accounting/providerGate.ts` (+ `.test.ts`) | `requireProviderCapability(cap)` middleware, `providerConfigError()`, the providers-list handler | d |
| `apps/api/src/services/accounting/neutralCore.guard.test.ts` | Mechanical guard: no `'quickbooks'`/`qbo*` in core | d |
| `apps/web/src/lib/accountingProviders.ts` (+ `.test.ts`) | `AccountingProviderId`, display names, `accountingPath(provider, suffix)` | d |
| `apps/web/src/components/integrations/AccountingProviderCards.tsx` (+ `.test.tsx`) | Generic shell: one card per configured provider | d |

**Renamed (git mv; history kept)**

| From | To | PR |
|---|---|---|
| `apps/api/src/services/accounting/quickbooksCustomerImport.ts` (+ test) | `accountingCustomerImport.ts` (+ test) | d |
| `apps/web/src/components/integrations/QuickbooksIntegration.tsx` (+ 2 tests) | `AccountingConnectionPanel.tsx` (+ tests) | d |
| `apps/web/src/components/integrations/QuickbooksMappingWorkbench.tsx` (+ 2 tests) | `AccountingMappingWorkbench.tsx` (+ tests) | d |
| `apps/web/src/components/integrations/QuickbooksCustomerImport.tsx` (+ test) | `AccountingCustomerImport.tsx` (+ test) | d |

**Modified**: see each task's **Files** block.

---

## Task 0: Baseline (every PR starts here)

**Files:** none.

- [ ] **Step 1: Confirm the preconditions and branch**

```bash
cd <worktree>
git fetch origin main && git status -sb
git log origin/main --oneline | grep -E '#7136|#7161'
```

Expected: a clean tree on the wave branch, based on the current `origin/main`, and both preconditions listed.

- [ ] **Step 2: Record the baseline**

```bash
cd apps/api && npx vitest run src/services/accounting src/jobs/accountingSyncWorker.test.ts src/jobs/accountingReconcileWorker.test.ts src/routes/accounting src/routes/webhooks 2>&1 | tail -5
```

Expected: all pass. Write down the `Test Files` count. Every later run of the QBO unit set must report at least this many files, plus the new ones.

---
# PR W01a — Server seam

### Task 1: One connection per partner (migration + schema + real-DB proof)

**Files:**
- Create: `apps/api/migrations/2026-11-02-110000-accounting-connections-one-per-partner.sql`. Rename it if a newer migration has landed; it must sort after the newest file on `origin/main`.
- Modify: `apps/api/src/db/schema/accounting.ts` (the `accountingConnections` index block, ~L72-81)
- Create: `apps/api/src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: the unique index `accounting_connections_partner_idx` on `accounting_connections(partner_id)`, and the Drizzle `partnerIdx` entry. Task 2's `upsertConnection` targets this index in `ON CONFLICT`.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts
/**
 * Real-DB proof of Xero W01's one-connection-per-partner contract (spec D2):
 *  - the migration refuses to run while any partner holds >1 row, and it can
 *    SEE those rows under FORCE RLS (it elects system scope first);
 *  - re-running the migration is a no-op;
 *  - a second provider row for the same partner is refused by the index;
 *  - upsertConnection reuses the row on a same-provider reconnect and raises
 *    AccountingProviderConflictError on a different provider (Task 2).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { accountingConnections } from '../../db/schema';
import { createPartner } from './db-utils';
import {
  AccountingProviderConflictError,
  upsertConnection,
} from '../../services/accounting/accountingConnectionService';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-11-02-110000-accounting-connections-one-per-partner.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

describe.skipIf(!RUN)('accounting_connections: one connection per partner', () => {
  it('the index exists and re-running the migration is a no-op', async () => {
    await adminSql.unsafe(migrationSql);
    const idx = await adminSql`
      select indexdef from pg_indexes
      where tablename = 'accounting_connections' and indexname = 'accounting_connections_partner_idx'`;
    expect(idx).toHaveLength(1);
    expect(String(idx[0]!.indexdef)).toMatch(/UNIQUE INDEX .* \(partner_id\)$/);
    // Kept on purpose (plan preamble item 1): rollback safety for ON CONFLICT (partner_id, provider).
    const legacy = await adminSql`
      select 1 from pg_indexes where indexname = 'accounting_connections_partner_provider_idx'`;
    expect(legacy).toHaveLength(1);
  });

  it('refuses a second provider row for the same partner', async () => {
    const partner = await createPartner();
    await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'r-one-1' }));
    await expect(withSystemDbAccessContext(() => db.insert(accountingConnections).values({
      partnerId: partner.id, provider: 'xero',
    }))).rejects.toMatchObject({ code: '23505' });
  });

  it('the migration aborts, with a count, when a partner holds two rows (and it can see them under FORCE RLS)', async () => {
    const partner = await createPartner();
    let caught: unknown;
    await adminSql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('breeze.scope', 'system', true)`);
      await tx.unsafe('DROP INDEX accounting_connections_partner_idx');
      await tx`insert into accounting_connections (partner_id, provider) values (${partner.id}, 'quickbooks')`;
      await tx`insert into accounting_connections (partner_id, provider) values (${partner.id}, 'xero')`;
      // Reset to the migration runner's default scope, so the migration's own set_config is what makes the rows visible.
      await tx.unsafe(`SELECT set_config('breeze.scope', 'none', true)`);
      try {
        await tx.unsafe(`SAVEPOINT before_migration`);
        await tx.unsafe(migrationSql);
      } catch (err) {
        caught = err;
        await tx.unsafe(`ROLLBACK TO SAVEPOINT before_migration`);
      }
      throw new Error('rollback-sentinel'); // never keep the dropped index or the duplicate rows
    }).catch((err) => { if ((err as Error).message !== 'rollback-sentinel') throw err; });
    expect(String((caught as Error | undefined)?.message)).toMatch(/one-per-partner precondition failed: 1 partner/);
  });

  it('upsertConnection: same-provider reconnect reuses the row; a different provider raises AccountingProviderConflictError', async () => {
    const partner = await createPartner();
    const first = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'r-a' }));
    // Stale 'disconnected' row (Review Focus 4).
    await withSystemDbAccessContext(() => db.update(accountingConnections)
      .set({ status: 'disconnected' }).where(eq(accountingConnections.id, first.id)));

    const again = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'r-a', status: 'connected' }));
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('connected');

    await withSystemDbAccessContext(() => db.update(accountingConnections)
      .set({ status: 'disconnected' }).where(eq(accountingConnections.id, first.id)));
    await expect(withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'xero', { realmId: 'tenant-x' })))
      .rejects.toBeInstanceOf(AccountingProviderConflictError);
    const rows = await withSystemDbAccessContext(() => db.select().from(accountingConnections)
      .where(eq(accountingConnections.partnerId, partner.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('quickbooks');
    expect(rows[0]!.status).toBe('disconnected'); // untouched by the refused connect
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts
```

Expected: FAIL with `ENOENT … 2026-11-02-110000-accounting-connections-one-per-partner.sql`, and the import of `AccountingProviderConflictError` is undefined.

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-11-02-110000-accounting-connections-one-per-partner.sql
--
-- Xero W01 (spec D2): one accounting connection per partner, DB-enforced.
--
-- ADDS accounting_connections_partner_idx (partner_id) and deliberately KEEPS
-- accounting_connections_partner_provider_idx (partner_id, provider): the
-- previous image's upsertConnection uses ON CONFLICT (partner_id, provider),
-- which needs an index matching that target exactly. Dropping it would break
-- every QuickBooks reconnect on a rollback or during a rolling restart. It is
-- redundant (unique partner_id implies unique (partner_id, provider)); drop it
-- in a later release once W01 can no longer be rolled back.
--
-- Idempotent: the precheck is read-only and the index uses IF NOT EXISTS.

DO $$
DECLARE
  dup_partners integer;
BEGIN
  -- accounting_connections is FORCE ROW LEVEL SECURITY and migrations run as the
  -- table owner under breeze.scope='none', which sees ZERO rows. Without this the
  -- count below is always 0 and the precheck proves nothing.
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT count(*) INTO dup_partners
  FROM (
    SELECT partner_id
    FROM accounting_connections
    GROUP BY partner_id
    HAVING count(*) > 1
  ) d;

  IF dup_partners > 0 THEN
    RAISE WARNING 'accounting_connections: % partner(s) hold more than one connection row', dup_partners;
    RAISE EXCEPTION 'accounting_connections one-per-partner precondition failed: % partner(s) have more than one row; resolve by hand (disconnect the extra provider) before deploying', dup_partners;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_partner_idx
  ON accounting_connections (partner_id);
```

- [ ] **Step 4: Update the Drizzle schema**

In `apps/api/src/db/schema/accounting.ts`, inside the `accountingConnections` index callback, add the new index and a comment on the old one:

```ts
}, (table) => ({
  // Superseded by partnerIdx (Xero W01) but KEPT: the pre-W01 image's
  // ON CONFLICT (partner_id, provider) needs it on rollback. Drop in a later release.
  partnerProviderIdx: uniqueIndex('accounting_connections_partner_provider_idx')
    .on(table.partnerId, table.provider),
  // Xero W01 (spec D2): ONE accounting connection per partner, any provider.
  partnerIdx: uniqueIndex('accounting_connections_partner_idx').on(table.partnerId),
  idPartnerIdx: uniqueIndex('accounting_connections_id_partner_idx').on(table.id, table.partnerId),
  // …providerRealmFpIdx unchanged
```

- [ ] **Step 5: Check migration naming, RLS scope and drift**

```bash
bash scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
cd ../.. && export DATABASE_URL="$(grep ^DATABASE_URL= .env.test | cut -d= -f2-)" && pnpm db:migrate && pnpm db:check-drift
```

Expected: the naming check prints no error. Both unit tests PASS; the migration has no DML, and its only `set_config` is inside the DO block. `db:check-drift` reports no drift.

- [ ] **Step 6: Run the integration test** (it stays red until Task 2 adds `AccountingProviderConflictError`)

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts
```

Expected: the first three tests PASS. The fourth fails on the missing export. Commit only after Task 2.

- [ ] **Step 7: Commit together with Task 2** (see Task 2, Step 6).

---

### Task 2: `resolveActiveConnection`, `getConnectionById`, the provider-conflict upsert

**Files:**
- Modify: `apps/api/src/services/accounting/accountingConnectionService.ts`: `upsertConnection` (~L169-257), `listReconcilableConnections` (~L374-389); add functions next to `getConnection` (~L152).
- Test: `apps/api/src/services/accounting/accountingConnectionService.test.ts`

**Interfaces:**
- Consumes: the `accounting_connections_partner_idx` index (Task 1).
- Produces:
  ```ts
  export async function resolveActiveConnection(dbc: DbExecutor, partnerId: string): Promise<AccountingConnection | null>;
  export async function getConnectionById(dbc: DbExecutor, connectionId: string, partnerId: string): Promise<AccountingConnection | null>;
  export async function getConnectionForMapping(dbc: DbExecutor, mappingId: string, partnerId: string): Promise<AccountingConnection | null>;
  export class AccountingProviderConflictError extends Error {
    readonly code: 'accounting_provider_conflict';
    readonly status: 409;
    readonly existingProvider: AccountingProviderId;
    readonly requestedProvider: AccountingProviderId;
  }
  export async function listReconcilableConnections(dbc: DbExecutor): Promise<Array<{ id: string; partnerId: string; provider: AccountingProviderId }>>;
  ```
  `getConnection(db, partnerId, provider)` stays. It is the "this provider's row" read used by routes that carry a `:provider` param.

- [ ] **Step 1: Write the failing unit tests** (append to `accountingConnectionService.test.ts`, reusing its `makeMockDb`)

```ts
describe('one connection per partner (Xero W01)', () => {
  it('upsertConnection targets partner_id and only updates a SAME-provider row', async () => {
    const captured: { row?: any; insertValues?: any; updateSet?: any; conflictArg?: any } = {};
    const db = makeMockDb(captured); // makeMockDb gains one line in its onConflictDoUpdate: `captured.conflictArg = arg;`
    const { upsertConnection } = await import('./accountingConnectionService');
    const { accountingConnections } = await import('../../db/schema');

    await upsertConnection(db, 'p1', 'quickbooks', { accessToken: 'a' });

    expect(captured.conflictArg.target).toBe(accountingConnections.partnerId);
    const whereSql = new PgDialect().sqlToQuery(captured.conflictArg.setWhere as SQL).sql;
    expect(whereSql).toBe('"accounting_connections"."provider" = excluded.provider');
  });

  it('upsertConnection raises AccountingProviderConflictError when the partner already holds another provider', async () => {
    const existing = { id: 'c-qbo', partnerId: 'p1', provider: 'quickbooks' };
    const db = {
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })),
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [existing]) })) })) })),
    };
    const { upsertConnection, AccountingProviderConflictError } = await import('./accountingConnectionService');

    const err = await upsertConnection(db as any, 'p1', 'xero', { accessToken: 'a' }).catch((e) => e);

    expect(err).toBeInstanceOf(AccountingProviderConflictError);
    expect(err).toMatchObject({ code: 'accounting_provider_conflict', status: 409, existingProvider: 'quickbooks', requestedProvider: 'xero' });
    expect(err.message).toBe('Disconnect QuickBooks before connecting Xero');
  });

  it('resolveActiveConnection returns the partner\'s single row whatever its provider', async () => {
    const captured: { row?: any } = { row: { id: 'c1', partnerId: 'p1', provider: 'quickbooks', status: 'connected', pushMode: 'auto', environment: 'production', pullPayments: true, pushPayments: true } };
    const db = makeMockDb(captured);
    const { resolveActiveConnection } = await import('./accountingConnectionService');
    const conn = await resolveActiveConnection(db as any, 'p1');
    expect(conn?.id).toBe('c1');
    expect(conn?.provider).toBe('quickbooks');
  });

  it('resolveActiveConnection returns null when the partner has no row', async () => {
    const db = makeMockDb({});
    const { resolveActiveConnection } = await import('./accountingConnectionService');
    expect(await resolveActiveConnection(db as any, 'p1')).toBeNull();
  });
});
```

(The test file already imports `PgDialect` and the `SQL` type at its top.)

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts -t "one connection per partner"
```

Expected: FAIL. `resolveActiveConnection` and `AccountingProviderConflictError` are not exported, and `conflictArg.target` is an array.

- [ ] **Step 3: Implement**

In `accountingConnectionService.ts`, add `sql` to the `drizzle-orm` import and import the display-name helper:

```ts
import { and, eq, isNotNull, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { accountingProviderDisplayName, getAccountingProvider } from './providerRegistry';
```

Add these next to `getConnection`:

```ts
/**
 * The partner's ONE accounting connection, any provider (Xero W01, spec D2 —
 * enforced by accounting_connections_partner_idx). Null when none exists.
 * Replaces every `getConnection(db, partnerId, 'quickbooks')` in the core.
 * W02 adds the `pending_tenant` exclusion HERE, and only here.
 */
export async function resolveActiveConnection(
  dbc: DbExecutor,
  partnerId: string,
): Promise<AccountingConnection | null> {
  const [row] = await dbc
    .select()
    .from(accountingConnections)
    .where(eq(accountingConnections.partnerId, partnerId))
    .limit(1);
  return row ? mapConnection(row) : null;
}

/** Load one connection by id, partner-guarded. Jobs carry this id (spec: "a job's destination is never reinterpreted"). */
export async function getConnectionById(
  dbc: DbExecutor,
  connectionId: string,
  partnerId: string,
): Promise<AccountingConnection | null> {
  const [row] = await dbc
    .select()
    .from(accountingConnections)
    .where(and(eq(accountingConnections.id, connectionId), eq(accountingConnections.partnerId, partnerId)))
    .limit(1);
  return row ? mapConnection(row) : null;
}

/**
 * The connection a mapping row belongs to (its integration_id). Payment jobs
 * bind to their connection THROUGH the outbox row (plan preamble item 4): the
 * composite FK cascades on disconnect, so a job whose connection is gone finds
 * no mapping at all rather than a different connection.
 */
export async function getConnectionForMapping(
  dbc: DbExecutor,
  mappingId: string,
  partnerId: string,
): Promise<AccountingConnection | null> {
  const [row] = await dbc
    .select({ connection: accountingConnections })
    .from(accountingEntityMappings)
    .innerJoin(accountingConnections, and(
      eq(accountingConnections.id, accountingEntityMappings.integrationId),
      eq(accountingConnections.partnerId, accountingEntityMappings.partnerId),
    ))
    .where(and(eq(accountingEntityMappings.id, mappingId), eq(accountingEntityMappings.partnerId, partnerId)))
    .limit(1);
  return row ? mapConnection(row.connection) : null;
}

/** 409 — the partner already has a connection to a DIFFERENT provider (spec D2). */
export class AccountingProviderConflictError extends Error {
  readonly code = 'accounting_provider_conflict' as const;
  readonly status = 409 as const;
  constructor(
    readonly existingProvider: AccountingProviderId,
    readonly requestedProvider: AccountingProviderId,
  ) {
    super(`Disconnect ${accountingProviderDisplayName(existingProvider)} before connecting ${accountingProviderDisplayName(requestedProvider)}`);
    this.name = 'AccountingProviderConflictError';
  }
}
```

In `upsertConnection`, replace the insert statement:

```ts
  const [row] = await db
    .insert(accountingConnections)
    .values(values)
    .onConflictDoUpdate({
      // accounting_connections_partner_idx (Xero W01): one row per partner. The
      // update fires ONLY for a same-provider reconnect; a different provider's
      // row makes this a no-op that returns nothing (handled below), so a Xero
      // connect can never overwrite a QuickBooks row's tokens or settings.
      target: accountingConnections.partnerId,
      set: updateSet,
      setWhere: sql`${accountingConnections.provider} = excluded.provider`,
    })
    .returning();

  if (!row) {
    const existing = await resolveActiveConnection(db, partnerId);
    if (existing && existing.provider !== provider) {
      throw new AccountingProviderConflictError(existing.provider, provider);
    }
    throw new Error('Failed to persist accounting connection');
  }
```

Replace `listReconcilableConnections` with a version that drops the provider filter and returns the provider. The worker filters on capability (Task 5).

```ts
export async function listReconcilableConnections(
  dbc: DbExecutor,
): Promise<Array<{ id: string; partnerId: string; provider: AccountingProviderId }>> {
  const rows = await dbc
    .select({ id: accountingConnections.id, partnerId: accountingConnections.partnerId, provider: accountingConnections.provider })
    .from(accountingConnections)
    .where(and(
      eq(accountingConnections.status, 'connected'),
      or(eq(accountingConnections.pullPayments, true), eq(accountingConnections.pushPayments, true)),
    ));
  return rows as Array<{ id: string; partnerId: string; provider: AccountingProviderId }>;
}
```

`accountingProviderDisplayName` does not exist until Task 3. Do Task 3 **before** running Step 4, or add it now exactly as Task 3 defines it.

- [ ] **Step 4: Update the existing callers of `listReconcilableConnections`** (tsc finds them: the reconcile worker's sweep, and its test mock). Do the worker change in Task 5. For now, replace `listReconcilableConnections(db, 'quickbooks')` with `listReconcilableConnections(db)` so it compiles.

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts
npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts src/__tests__/integration/accountingRealmFingerprint.integration.test.ts
npx tsc --noEmit -p .
```

Expected: all PASS, including every pre-existing `upsertConnection` test (their mock returns a row, so the conflict path never triggers). tsc is clean.

- [ ] **Step 6: Commit Tasks 1–2**

```bash
git add apps/api/migrations/2026-11-02-110000-accounting-connections-one-per-partner.sql apps/api/src/db/schema/accounting.ts \
  apps/api/src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts \
  apps/api/src/services/accounting/accountingConnectionService.ts apps/api/src/services/accounting/accountingConnectionService.test.ts \
  apps/api/src/jobs/accountingReconcileWorker.ts
git commit -m "feat(accounting): one accounting connection per partner + resolveActiveConnection (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Provider capabilities and registry helpers

**Files:**
- Modify: `apps/api/src/services/accounting/types.ts` (the `AccountingProvider` interface, ~L300)
- Modify: `apps/api/src/services/accounting/providerRegistry.ts`
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts` (the class fields, ~L449)
- Test: `apps/api/src/services/accounting/providerRegistry.test.ts`, `apps/api/src/services/accounting/types.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type AccountingCapability = 'connect' | 'mapping' | 'customerImport' | 'invoicePush' | 'paymentPull' | 'paymentPush';
  export type AccountingCapabilities = Readonly<Record<AccountingCapability, boolean>>;
  export const ACCOUNTING_PROVIDER_IDS = ['quickbooks', 'xero'] as const;   // types.ts: AccountingProviderId = typeof ACCOUNTING_PROVIDER_IDS[number]
  // AccountingProvider gains:
  readonly displayName: string;
  readonly capabilities: AccountingCapabilities;
  // providerRegistry.ts
  export const LEGACY_UNTARGETED_JOB_PROVIDER: AccountingProviderId;          // 'quickbooks'
  export function getAccountingProvider(id: AccountingProviderId): AccountingProvider;             // unchanged; throws for unregistered ids
  export function findAccountingProvider(id: AccountingProviderId): AccountingProvider | null;
  export function providerSupports(id: AccountingProviderId, capability: AccountingCapability): boolean; // false when unregistered
  export function accountingProviderDisplayName(id: AccountingProviderId): string;
  export function listRegisteredAccountingProviders(): AccountingProvider[];
  ```

Note that `types.ts` gains a runtime `const` (`ACCOUNTING_PROVIDER_IDS`). Its header comment says it is a types-only module. `INVOICE_REMOTE_DELETED_ERROR` already broke that rule, and a tuple constant carries no imports, so it cannot create a cycle.

- [ ] **Step 1: Write the failing tests**

Append to `providerRegistry.test.ts`:

```ts
  it('QuickBooks declares every capability (Xero W01)', async () => {
    const { getAccountingProvider } = await import('./providerRegistry');
    expect(getAccountingProvider('quickbooks').capabilities).toEqual({
      connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true,
    });
    expect(getAccountingProvider('quickbooks').displayName).toBe('QuickBooks');
  });

  it('an unregistered provider supports nothing but still has a display name', async () => {
    const { providerSupports, findAccountingProvider, accountingProviderDisplayName } = await import('./providerRegistry');
    expect(findAccountingProvider('xero')).toBeNull();
    expect(providerSupports('xero', 'connect')).toBe(false);
    expect(providerSupports('quickbooks', 'invoicePush')).toBe(true);
    expect(accountingProviderDisplayName('xero')).toBe('Xero');
    expect(accountingProviderDisplayName('quickbooks')).toBe('QuickBooks');
  });

  it('legacy untargeted jobs belong to QuickBooks (spec: a job destination is never reinterpreted)', async () => {
    const { LEGACY_UNTARGETED_JOB_PROVIDER } = await import('./providerRegistry');
    expect(LEGACY_UNTARGETED_JOB_PROVIDER).toBe('quickbooks');
  });
```

Append to `types.test.ts`:

```ts
describe('provider capabilities and identity (Xero W01)', () => {
  it('declares the six capabilities and a display name', () => {
    expectTypeOf<AccountingProvider['capabilities']>().toEqualTypeOf<AccountingCapabilities>();
    expectTypeOf<keyof AccountingCapabilities>().toEqualTypeOf<
      'connect' | 'mapping' | 'customerImport' | 'invoicePush' | 'paymentPull' | 'paymentPush'
    >();
    expectTypeOf<AccountingProvider['displayName']>().toEqualTypeOf<string>();
  });
});
```

Add `AccountingCapabilities` to that file's `import type { … } from './types'`.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/providerRegistry.test.ts src/services/accounting/types.test.ts
```

Expected: FAIL. `capabilities` is undefined, `providerSupports` is not a function, and the type test reports that `capabilities` does not exist.

- [ ] **Step 3: Implement**

`types.ts`: replace the `AccountingProviderId` line and add the capability types and interface members:

```ts
export const ACCOUNTING_PROVIDER_IDS = ['quickbooks', 'xero'] as const;
export type AccountingProviderId = typeof ACCOUNTING_PROVIDER_IDS[number];

/**
 * What a provider implementation can do today (spec "Provider capabilities").
 * Enforced at EVERY layer — routes (409 capability_unavailable), producers
 * (no enqueue), workers (log + complete) and the UI (hidden). This is what lets
 * each Xero wave ship alone: a W02-connected row defaults to push_mode='auto' /
 * pull_payments=true / push_payments=true, and without these gates the generic
 * workers would call provider methods that do not exist yet.
 */
export type AccountingCapability =
  | 'connect' | 'mapping' | 'customerImport' | 'invoicePush' | 'paymentPull' | 'paymentPush';
export type AccountingCapabilities = Readonly<Record<AccountingCapability, boolean>>;
```

In `interface AccountingProvider`, directly under `readonly provider`:

```ts
  /** Brand name used in operator-visible text ("QuickBooks", "Xero"). Never translated. */
  readonly displayName: string;
  readonly capabilities: AccountingCapabilities;
```

`quickbooksProvider.ts`, in `class QuickbooksProvider`:

```ts
  readonly provider = 'quickbooks' as const;
  readonly displayName = 'QuickBooks';
  readonly capabilities = {
    connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true,
  } as const;
```

`providerRegistry.ts` (whole file):

```ts
import { quickbooksProvider } from './quickbooksProvider';
import type { AccountingCapability, AccountingProvider, AccountingProviderId } from './types';

const providers: Partial<Record<AccountingProviderId, AccountingProvider>> = {
  quickbooks: quickbooksProvider,
};

/**
 * Brand names for ids with NO registered implementation yet (Xero until W02),
 * so a message about a refused or conflicting provider can still name it. A
 * registered provider's own `displayName` always wins.
 */
const FALLBACK_DISPLAY_NAMES: Record<AccountingProviderId, string> = {
  quickbooks: 'QuickBooks',
  xero: 'Xero',
};

/**
 * Jobs enqueued before Xero W01 carry no connectionId. They were QuickBooks
 * work by construction (no other provider existed), so they run ONLY when the
 * partner's active connection is this provider, and are dropped otherwise
 * (spec W01 "Jobs carry connectionId"; Codex quorum finding 4).
 */
export const LEGACY_UNTARGETED_JOB_PROVIDER: AccountingProviderId = 'quickbooks';

export function getAccountingProvider(id: AccountingProviderId): AccountingProvider {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown accounting provider: ${id}`);
  }
  return provider;
}

export function findAccountingProvider(id: AccountingProviderId): AccountingProvider | null {
  return providers[id] ?? null;
}

export function providerSupports(id: AccountingProviderId, capability: AccountingCapability): boolean {
  return providers[id]?.capabilities[capability] === true;
}

export function accountingProviderDisplayName(id: AccountingProviderId): string {
  return providers[id]?.displayName ?? FALLBACK_DISPLAY_NAMES[id] ?? id;
}

export function listRegisteredAccountingProviders(): AccountingProvider[] {
  return Object.values(providers).filter((p): p is AccountingProvider => !!p);
}
```

- [ ] **Step 4: Fix the test mocks that now lack exports**

Every file that does `vi.mock('…/providerRegistry', () => ({ getAccountingProvider: … }))` and exercises a module that imports a new helper fails with `[vitest] No "providerSupports" export is defined on the "…providerRegistry" mock`. Find them all:

```bash
cd apps/api && grep -rln "providerRegistry'" src --include='*.test.ts' | xargs grep -l "vi.mock(.*providerRegistry"
```

In each accounting test on that list, extend the factory without changing any assertion:

```ts
vi.mock('./providerRegistry', () => ({
  getAccountingProvider: /* existing */,
  findAccountingProvider: (id: string) => (id === 'quickbooks' ? /* the same object getAccountingProvider returns */ {} : null),
  providerSupports: (id: string) => id === 'quickbooks',
  accountingProviderDisplayName: (id: string) => (id === 'xero' ? 'Xero' : 'QuickBooks'),
  LEGACY_UNTARGETED_JOB_PROVIDER: 'quickbooks',
  listRegisteredAccountingProviders: () => [],
}));
```

(The paths differ per file, e.g. `'../../services/accounting/providerRegistry'` in route tests. The email-domain `providerRegistry` hits on that grep are a different module; leave them alone.)

- [ ] **Step 5: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting/providerRegistry.test.ts src/services/accounting/types.test.ts src/services/accounting/quickbooksProvider.test.ts && npx tsc --noEmit -p .
```

Expected: PASS, and tsc is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/accounting/{types.ts,types.test.ts,providerRegistry.ts,providerRegistry.test.ts,quickbooksProvider.ts}
git commit -m "feat(accounting): provider capabilities, display names and legacy job provider (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Move every core lookup onto the active connection

**Files (verified call sites at `38d757815`; re-grep after the preconditions):**
- `apps/api/src/services/accounting/accountingMappingService.ts`: `ListMappingProposalsInput.provider` (~L89), `resolveConnection` (~L185-202), `resolveConnectionAndToken` (~L247-256), the `organizationExternalLinks.system` filter (~L440), the `input.provider` types (~L636, ~L659, ~L668), the address audit (`details.source`, ~L1370), and the two `resolveConnection(partnerId, provider)` callers (~L846, ~L1234).
- `apps/api/src/services/accounting/accountingInvoicePush.ts`: `persistInvoiceCurrencyMismatchErrorInOwnContext` (~L283), the push Phase 1 (~L695), the `syncMappedEntity` inputs (~L773, ~L792), the void (~L976); signatures of `pushInvoiceToAccounting` and `voidInvoiceInAccounting`.
- `apps/api/src/services/accounting/accountingPaymentPush.ts`: `loadConnectedConnection` (~L460-477), the `fireAudit({ provider: 'quickbooks' })` calls (~L776, ~L2003), `resolveConnection` (~L1567, ~L1948); signatures of `pushPaymentToAccounting` and `deletePaymentInAccounting`.
- `apps/api/src/services/invoiceService.ts`: `InvoiceAccountingSync.provider` + `getInvoiceAccountingSync` (~L694-751), the void pre-check and in-tx connection reads (~L1876-1885, ~L1943-1953), the untouched-void audit `provider` (~L2039), the payment-list `source` (~L2097-2122).
- Tests (mock wiring and fixtures only): `accountingMappingService.test.ts`, `accountingInvoicePush.test.ts`, `accountingPaymentPush.test.ts`, `routes/accounting/*.test.ts`, `invoiceService*.test.ts`.

**Interfaces:**
- Consumes: `resolveActiveConnection`, `getConnectionById` (Task 2); `accountingProviderDisplayName`, `providerSupports` (Task 3).
- Produces:
  ```ts
  // accountingMappingService.ts
  export type ConnectionTarget =
    | { connectionId: string }             // jobs: the exact connection the work was enqueued for
    | { provider: AccountingProviderId }   // routes: the :provider in the URL
    | undefined;                           // producer-less callers: the partner's active connection
  export async function resolveConnection(partnerId: string, target?: ConnectionTarget): Promise<AccountingConnection>;
  export async function resolveConnectionAndToken(partnerId: string, target: ConnectionTarget, runInDbContext: DbContextRunner): Promise<{ conn: AccountingConnection; liveConn: AccountingConnection }>;
  // ListMappingProposalsInput / SyncMappedEntityInput: provider: AccountingProviderId (was 'quickbooks')
  // accountingInvoicePush.ts
  export async function pushInvoiceToAccounting(invoiceId: string, partnerId: string, runInDbContext: DbContextRunner, target?: ConnectionTarget): Promise<InvoicePushOutcome>;
  export async function voidInvoiceInAccounting(invoiceId: string, partnerId: string, runInDbContext: DbContextRunner, target?: ConnectionTarget): Promise<…unchanged…>;
  // accountingPaymentPush.ts
  export async function pushPaymentToAccounting(mappingId: string, partnerId: string, runInDbContext: DbContextRunner, target?: ConnectionTarget): Promise<PaymentPushOutcome>;
  export async function deletePaymentInAccounting(mappingId: string, partnerId: string, runInDbContext: DbContextRunner, target?: ConnectionTarget): Promise<PaymentDeleteOutcome>;
  // invoiceService.ts
  export interface InvoiceAccountingSync { provider: AccountingProviderId; … }
  ```

The trailing optional `target` keeps every existing call compiling and meaning the same thing ("the partner's active connection", which today is the one QBO row). Task 5 passes it from the workers and Task 15 from the routes.

- [ ] **Step 1: Write the failing tests** (append to `accountingMappingService.test.ts`; its `getConnection` mock sits on the hoisted `accountingConnectionService` mock)

```ts
describe('resolveConnection targets (Xero W01)', () => {
  it('no target: returns the partner\'s active connection whatever its provider', async () => {
    resolveActiveConnectionMock.mockResolvedValue(connRow({ id: 'c1', provider: 'quickbooks' }));
    const { resolveConnection } = await import('./accountingMappingService');
    await expect(resolveConnection('p1')).resolves.toMatchObject({ id: 'c1' });
  });

  it('provider target that does not match the active connection is not_connected, named after the TARGET provider', async () => {
    resolveActiveConnectionMock.mockResolvedValue(connRow({ id: 'c1', provider: 'quickbooks' }));
    const { resolveConnection } = await import('./accountingMappingService');
    await expect(resolveConnection('p1', { provider: 'xero' })).rejects.toMatchObject({
      code: 'not_connected', status: 404, message: 'Xero is not connected for this partner',
    });
  });

  it('connectionId target that no longer matches the active row is not_connected (the destination is never reinterpreted)', async () => {
    resolveActiveConnectionMock.mockResolvedValue(connRow({ id: 'c-new', provider: 'quickbooks' }));
    const { resolveConnection } = await import('./accountingMappingService');
    await expect(resolveConnection('p1', { connectionId: 'c-old' })).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('no row at all keeps the QuickBooks wording for a quickbooks route and a neutral one otherwise', async () => {
    resolveActiveConnectionMock.mockResolvedValue(null);
    const { resolveConnection } = await import('./accountingMappingService');
    await expect(resolveConnection('p1', { provider: 'quickbooks' })).rejects.toMatchObject({ message: 'QuickBooks is not connected for this partner' });
    await expect(resolveConnection('p1')).rejects.toMatchObject({ message: 'No accounting system is connected for this partner' });
  });

  it('reauth_required keeps its exact QuickBooks message', async () => {
    resolveActiveConnectionMock.mockResolvedValue(connRow({ provider: 'quickbooks', status: 'reauth_required' }));
    const { resolveConnection } = await import('./accountingMappingService');
    await expect(resolveConnection('p1')).rejects.toMatchObject({ code: 'reauth_required', message: 'QuickBooks needs to be reconnected' });
  });
});
```

Add `resolveActiveConnection: resolveActiveConnectionMock` (a `vi.hoisted` `vi.fn()`) to the file's `accountingConnectionService` mock. Default it in `beforeEach` to delegate to the existing `getConnection` mock, `resolveActiveConnectionMock.mockImplementation((_db, partnerId) => getConnectionMock(_db, partnerId, 'quickbooks'))`, so every pre-existing test keeps its fixture unchanged. `connRow` is the file's existing connection-row factory; if the file names it differently, use that name.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingMappingService.test.ts -t "resolveConnection targets"
```

Expected: FAIL. `resolveConnection` still takes `provider: 'quickbooks'` and calls `getConnection`.

- [ ] **Step 3: Implement `resolveConnection` / `resolveConnectionAndToken`**

```ts
export type ConnectionTarget =
  | { connectionId: string }
  | { provider: AccountingProviderId }
  | undefined;

function notConnectedMessage(provider: AccountingProviderId | null): string {
  return provider
    ? `${accountingProviderDisplayName(provider)} is not connected for this partner`
    : 'No accounting system is connected for this partner';
}

/**
 * The connection this call must act on (Xero W01). Always the partner's ONE
 * active row (accounting_connections_partner_idx), then checked against the
 * caller's target: a route's :provider, or a job's connectionId. A mismatch is
 * `not_connected` — never "use whatever is connected now".
 */
export async function resolveConnection(
  partnerId: string,
  target?: ConnectionTarget,
): Promise<AccountingConnection> {
  const wanted = target && 'provider' in target ? target.provider : null;
  const conn = await resolveActiveConnection(db, partnerId);
  if (!conn) throw new AccountingMappingError('not_connected', 404, notConnectedMessage(wanted));
  if (wanted && conn.provider !== wanted) {
    throw new AccountingMappingError('not_connected', 404, notConnectedMessage(wanted));
  }
  if (target && 'connectionId' in target && conn.id !== target.connectionId) {
    throw new AccountingMappingError('not_connected', 404, notConnectedMessage(conn.provider));
  }
  const label = accountingProviderDisplayName(conn.provider);
  if (conn.status === 'reauth_required') {
    throw new AccountingMappingError('reauth_required', 409, `${label} needs to be reconnected`);
  }
  if (conn.status !== 'connected') {
    throw new AccountingMappingError('not_connected', 404, notConnectedMessage(conn.provider));
  }
  return conn;
}
```

`resolveLiveConnection` uses `` `${accountingProviderDisplayName(conn.provider)} needs to be reconnected` ``. `resolveConnectionAndToken(partnerId, target, runInDbContext)` passes `target` through.

- [ ] **Step 4: Sweep the remaining sites** (mechanical; each is a find/replace of the pattern shown)

| Site | Before | After |
|---|---|---|
| `accountingMappingService.ts` types | `provider: 'quickbooks'` | `provider: AccountingProviderId` |
| `accountingMappingService.ts` ~L440 | `eq(organizationExternalLinks.system, 'quickbooks')` | `eq(organizationExternalLinks.system, conn.provider)` (use the connection already resolved in that function; pass it down if needed) |
| `accountingMappingService.ts` ~L1370 | `{ source: 'quickbooks', message: 'Address imported from QuickBooks' }` | `` { source: conn.provider, message: `Address imported from ${accountingProviderDisplayName(conn.provider)}` } `` |
| `accountingMappingService.ts` ~L846, ~L1234 | `resolveConnection(partnerId, provider)` | `resolveConnection(partnerId, { provider })` |
| `accountingInvoicePush.ts` ~L283 | `resolveConnection(partnerId, 'quickbooks')` | `resolveConnection(partnerId, target)` (thread `target` into `persistInvoiceCurrencyMismatchErrorInOwnContext`) |
| `accountingInvoicePush.ts` ~L695, ~L976 | `resolveConnection(partnerId, 'quickbooks')` | `resolveConnection(partnerId, target)` |
| `accountingInvoicePush.ts` ~L773, ~L792 | `provider: 'quickbooks'` | `provider: conn.provider` |
| `accountingInvoicePush.ts` `translateCurrencyError` | `conn.provider === 'xero' ? 'Xero' : 'QuickBooks'` | `accountingProviderDisplayName(conn.provider)` |
| `accountingPaymentPush.ts` `loadConnectedConnection` | `eq(accountingConnections.provider, 'quickbooks')` | drop that predicate (the partner has one row), select `provider` too, and return `null` unless `providerSupports(row.provider, 'paymentPush')` |
| `accountingPaymentPush.ts` ~L1567, ~L1948 | `resolveConnection(partnerId, 'quickbooks')` | `resolveConnection(partnerId, target)` |
| `accountingPaymentPush.ts` ~L776, ~L2003 | `provider: 'quickbooks'` | `provider: (await getConnectionForMapping(db, mapping.id, mapping.partnerId))?.provider ?? LEGACY_UNTARGETED_JOB_PROVIDER` at ~L776 (the row exists, so its connection exists). At ~L2003 no mapping row is guaranteed, so `provider: conn?.provider ?? LEGACY_UNTARGETED_JOB_PROVIDER`, where `conn` is `getConnectionForMapping(...)` read once at the top of that branch. |
| `invoiceService.ts` `getInvoiceAccountingSync` | `eq(accountingConnections.provider, 'quickbooks')` + `provider: 'quickbooks'` | drop the predicate, select `provider: accountingConnections.provider`, return `provider: row.provider as AccountingProviderId` |
| `invoiceService.ts` ~L1876-1885, ~L1943-1953 | `eq(accountingConnections.provider, 'quickbooks')` | drop the predicate (one row per partner); keep `.limit(1)` |
| `invoiceService.ts` ~L2039 | `provider: 'quickbooks'` | `provider: audit.provider`; carry the connection's provider into `audit` from the in-tx read above |
| `invoiceService.ts` ~L2097-2122 | `source: 'quickbooks'` | join `accountingConnections` on `integrationId`, select `provider`, and use `mapping.provider` as the source. The union becomes `'stripe' \| 'manual' \| AccountingProviderId`. |
| `invoiceService.ts` ~L1959 message | `'This payment came from QuickBooks; reverse it in QuickBooks instead'` | `` `This payment came from ${label}; reverse it in ${label} instead` `` with `label = accountingProviderDisplayName(provider)`; the code `QUICKBOOKS_OWNED_PAYMENT` stays (preamble item 8) |

After the sweep this must print nothing:

```bash
cd apps/api && grep -rn "'quickbooks'" src/services/accounting/accountingMappingService.ts src/services/accounting/accountingInvoicePush.ts src/services/accounting/accountingPaymentPush.ts src/services/invoiceService.ts
```

Expected: no output.

- [ ] **Step 5: Keep the existing suites green (wiring and fixtures only)**

- Where a test mocks `accountingConnectionService` with only `getConnection`, add `resolveActiveConnection`, `getConnectionById` and `getConnectionForMapping`, delegating to that same `getConnection` mock (as in Step 1). No fixture row changes.
- `InvoiceAccountingSync.provider` stays `'quickbooks'` for every QBO fixture, so snapshots are unchanged.
- The payment-list test that asserts `source: 'quickbooks'` stays byte-identical, because the joined provider is `'quickbooks'`.

```bash
cd apps/api && npx vitest run src/services/accounting src/services/invoiceService src/routes/accounting src/services/stripeReconcile src/services/stripeReversalState && npx tsc --noEmit -p .
```

Expected: PASS, with the same file count as the baseline plus the new tests. tsc is clean.

- [ ] **Step 6: Commit**

```bash
git add -A apps/api/src/services apps/api/src/routes/accounting
git commit -m "refactor(accounting): resolve the partner's active connection instead of (partner, 'quickbooks') (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Jobs carry `connectionId`; producers and workers enforce capabilities

**Files:**
- Create: `apps/api/src/jobs/accountingJobConnection.ts`, `apps/api/src/jobs/accountingJobConnection.test.ts`
- Modify: `apps/api/src/jobs/accountingSyncWorker.ts`: the job data types (~L80-110), `processAccountingSyncJob` (~L187-290), `processPaymentJob`, the enqueue helpers (~L381-470), `processMappingSweep` (~L472-500)
- Modify: `apps/api/src/jobs/accountingReconcileWorker.ts`: `classifyReconcileSkip` (~L287), `processReconcileConnectionJob` (~L337-367), `processReconcileSweep` (~L574-640)
- Modify (producers): `apps/api/src/services/invoiceService.ts`, the issue hook (~L1614-1622) and the void hook (~L2372-2380); `apps/api/src/routes/accounting/index.ts`, the push-bulk route (~L1226-1290) and the mapping-sync enqueue (~L1096); `apps/api/src/services/accounting/accountingPaymentPush.ts`, `listOwedPaymentMappings` (~L1305)
- Test: `apps/api/src/jobs/accountingSyncWorker.test.ts`, `apps/api/src/jobs/accountingReconcileWorker.test.ts`, `apps/api/src/services/invoiceService.issue*.test.ts` (whichever file covers the issue hook; `grep -ln enqueueAccountingInvoicePush src/services/*.test.ts`)

**Interfaces:**
- Consumes: `getConnectionById`, `resolveActiveConnection`, `getConnectionForMapping`, `listReconcilableConnections` (Task 2); `providerSupports`, `LEGACY_UNTARGETED_JOB_PROVIDER` (Task 3); `ConnectionTarget` (Task 4).
- Produces:
  ```ts
  // jobs/accountingJobConnection.ts
  export type JobDropReason = 'connection_gone' | 'legacy_non_quickbooks' | 'capability_unavailable';
  export type JobConnectionResolution =
    | { kind: 'ok'; conn: AccountingConnection; target: ConnectionTarget }
    | { kind: 'absent'; conn: AccountingConnection | null }   // legacy job, no/unconnected row: today's not-connected path
    | { kind: 'drop'; reason: JobDropReason };
  export async function resolveJobConnection(
    job: { partnerId: string; connectionId?: string; mappingId?: string },
    capability: AccountingCapability,
    dbc: DbExecutor,
  ): Promise<JobConnectionResolution>;
  export function logJobDrop(queue: string, jobType: string, data: { partnerId: string; connectionId?: string }, reason: JobDropReason): void;
  // jobs/accountingSyncWorker.ts: payloads
  interface PushInvoiceJobData { type: 'push-invoice'; invoiceId: string; partnerId: string; connectionId?: string } // optional ONLY for legacy jobs
  interface VoidInvoiceJobData { type: 'void-invoice'; invoiceId: string; partnerId: string; connectionId?: string }
  interface SyncMappingJobData { type: 'sync-mapping'; partnerId: string; breezeEntityType: MappingEntityType; breezeEntityId: string; connectionId?: string }
  // enqueue helpers (connectionId REQUIRED for new jobs):
  export async function enqueueAccountingInvoicePush(invoiceId: string, partnerId: string, connectionId: string): Promise<boolean>;
  export async function enqueueAccountingInvoiceVoid(invoiceId: string, partnerId: string, connectionId: string): Promise<boolean>;
  export async function enqueueAccountingMappingSync(breezeEntityType: MappingEntityType, breezeEntityId: string, partnerId: string, connectionId: string): Promise<boolean>;
  // producer helper (services/accounting/accountingConnectionService.ts)
  export async function resolveActiveConnectionFor(partnerId: string, capability: AccountingCapability): Promise<AccountingConnection | null>; // readWithPartnerAxisVisibility + capability check
  // listOwedPaymentMappings rows gain: integrationId: string; provider: AccountingProviderId
  ```
  Job ids are **unchanged** (`accounting-push-${invoiceId}`, …). Dedup semantics must not move.

**Drop rules** (these are the contract; the tests below pin each row):

| Job | connectionId present | Row by id | Result |
|---|---|---|---|
| push/void/sync-mapping | yes | missing | drop `connection_gone` (log + complete) |
| push/void/sync-mapping | yes | found, capability false | drop `capability_unavailable` |
| push/void/sync-mapping | yes | found, capability true | ok, target `{ connectionId }` |
| push/void/sync-mapping | **no (legacy)** | active row missing / not connected | today's not-connected path (`absent`) |
| push/void/sync-mapping | **no (legacy)** | active row provider ≠ `LEGACY_UNTARGETED_JOB_PROVIDER` | drop `legacy_non_quickbooks` |
| push/void/sync-mapping | **no (legacy)** | active QBO row | ok, target `{ connectionId: row.id }` |
| push-payment / delete-payment | n/a (bound by mapping) | `getConnectionForMapping` null | `absent` (today's path; the mapping is gone or orphaned) |
| push-payment / delete-payment | n/a | found, `paymentPush` false | drop `capability_unavailable` |
| reconcile-connection | always present | id ≠ live / missing | existing `missing` / `connection_mismatch` (unchanged) |
| reconcile-connection | always present | `paymentPull` false | new skip `capability_unavailable` |

- [ ] **Step 1: Write the failing tests**

`apps/api/src/jobs/accountingJobConnection.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConnectionById: vi.fn(),
  resolveActiveConnection: vi.fn(),
  getConnectionForMapping: vi.fn(),
  supports: vi.fn((id: string) => id === 'quickbooks'),
}));
vi.mock('../services/accounting/accountingConnectionService', () => ({
  getConnectionById: mocks.getConnectionById,
  resolveActiveConnection: mocks.resolveActiveConnection,
  getConnectionForMapping: mocks.getConnectionForMapping,
}));
vi.mock('../services/accounting/providerRegistry', () => ({
  providerSupports: (id: string, _cap: string) => mocks.supports(id),
  LEGACY_UNTARGETED_JOB_PROVIDER: 'quickbooks',
}));

const qbo = { id: 'c-qbo', partnerId: 'p1', provider: 'quickbooks', status: 'connected' };
const xero = { id: 'c-xero', partnerId: 'p1', provider: 'xero', status: 'connected' };

describe('resolveJobConnection (Xero W01 drop rules)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops a job whose connection was replaced (provider switch with queued jobs)', async () => {
    mocks.getConnectionById.mockResolvedValue(null); // c-qbo was deleted by disconnect; c-xero is live
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', connectionId: 'c-qbo' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'drop', reason: 'connection_gone' });
    expect(mocks.resolveActiveConnection).not.toHaveBeenCalled(); // never re-targeted
  });

  it('drops a targeted job when the provider lacks the capability', async () => {
    mocks.getConnectionById.mockResolvedValue(xero);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', connectionId: 'c-xero' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'drop', reason: 'capability_unavailable' });
  });

  it('legacy job runs against the active QuickBooks connection (pre-deploy in-flight create)', async () => {
    mocks.resolveActiveConnection.mockResolvedValue(qbo);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'ok', conn: qbo, target: { connectionId: 'c-qbo' } });
  });

  it('legacy job is dropped when the active connection is not QuickBooks', async () => {
    mocks.resolveActiveConnection.mockResolvedValue(xero);
    mocks.supports.mockReturnValue(true);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'drop', reason: 'legacy_non_quickbooks' });
  });

  it('legacy job with no active row takes today\'s not-connected path', async () => {
    mocks.resolveActiveConnection.mockResolvedValue(null);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'absent', conn: null });
  });

  it('payment jobs bind through their mapping row', async () => {
    mocks.getConnectionForMapping.mockResolvedValue(qbo);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', mappingId: 'm1' }, 'paymentPush', {} as any))
      .resolves.toEqual({ kind: 'ok', conn: qbo, target: { connectionId: 'c-qbo' } });
  });
});
```

Append to `accountingSyncWorker.test.ts`:

```ts
describe('connectionId + capability gates (Xero W01)', () => {
  it('a job for a replaced connection completes without calling the coordinator', async () => {
    getConnectionByIdMock.mockResolvedValue(null);
    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: 'i1', partnerId: 'p1', connectionId: 'c-old' });
    expect(pushInvoiceToAccountingMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[AccountingSyncWorker] job dropped'), 'reason=connection_gone', 'type=push-invoice', expect.anything(), expect.anything());
  });

  it('a targeted job passes { connectionId } through to the coordinator', async () => {
    getConnectionByIdMock.mockResolvedValue(connectionRow({ id: 'c1', provider: 'quickbooks' }));
    await processAccountingSyncJob({ type: 'push-invoice', invoiceId: 'i1', partnerId: 'p1', connectionId: 'c1' });
    expect(pushInvoiceToAccountingMock).toHaveBeenCalledWith('i1', 'p1', expect.any(Function), { connectionId: 'c1' });
  });
});
```

(`logSpy = vi.spyOn(console, 'log')` in the describe's `beforeEach`. `getConnectionByIdMock` is added to the file's hoisted `accountingConnectionService` mock. `pushInvoiceToAccountingMock` is the file's existing coordinator mock; reuse whatever name it has.)

Append to the issue-hook test (`invoiceService` issue suite):

```ts
it('does not enqueue an auto-push when the partner has no invoice-push-capable connection (Xero W01 producer gate)', async () => {
  resolveActiveConnectionForMock.mockResolvedValue(null);
  await issueInvoice(INVOICE_ID, actor);
  expect(enqueueAccountingInvoicePushMock).not.toHaveBeenCalled();
});

it('enqueues the auto-push with the active connection id', async () => {
  resolveActiveConnectionForMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks' });
  await issueInvoice(INVOICE_ID, actor);
  expect(enqueueAccountingInvoicePushMock).toHaveBeenCalledWith(INVOICE_ID, PARTNER_ID, 'c1');
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/jobs/accountingJobConnection.test.ts src/jobs/accountingSyncWorker.test.ts
```

Expected: FAIL. The module does not exist, and the worker ignores `connectionId`.

- [ ] **Step 3: Implement `accountingJobConnection.ts`**

```ts
/**
 * Which connection an accounting job runs against (Xero W01, spec "Jobs carry
 * connectionId"). ONE place for the drop rules both accounting workers share.
 *
 * A job's destination is NEVER reinterpreted: a job carrying a connectionId runs
 * against that row or not at all; a legacy job (enqueued before W01, no
 * connectionId) was QuickBooks work by construction and runs only against a
 * QuickBooks active connection. Payment jobs bind through their outbox mapping
 * row instead of a payload field (plan preamble item 4).
 */
import type { AccountingConnection, DbExecutor } from '../services/accounting/accountingConnectionService';
import {
  getConnectionById,
  getConnectionForMapping,
  resolveActiveConnection,
} from '../services/accounting/accountingConnectionService';
import { LEGACY_UNTARGETED_JOB_PROVIDER, providerSupports } from '../services/accounting/providerRegistry';
import type { ConnectionTarget } from '../services/accounting/accountingMappingService';
import type { AccountingCapability } from '../services/accounting/types';

export type JobDropReason = 'connection_gone' | 'legacy_non_quickbooks' | 'capability_unavailable';
export type JobConnectionResolution =
  | { kind: 'ok'; conn: AccountingConnection; target: ConnectionTarget }
  | { kind: 'absent'; conn: AccountingConnection | null }
  | { kind: 'drop'; reason: JobDropReason };

export async function resolveJobConnection(
  job: { partnerId: string; connectionId?: string; mappingId?: string },
  capability: AccountingCapability,
  dbc: DbExecutor,
): Promise<JobConnectionResolution> {
  if (job.mappingId !== undefined) {
    const conn = await getConnectionForMapping(dbc, job.mappingId, job.partnerId);
    if (!conn || conn.status !== 'connected') return { kind: 'absent', conn };
    if (!providerSupports(conn.provider, capability)) return { kind: 'drop', reason: 'capability_unavailable' };
    return { kind: 'ok', conn, target: { connectionId: conn.id } };
  }
  if (job.connectionId !== undefined) {
    const conn = await getConnectionById(dbc, job.connectionId, job.partnerId);
    if (!conn) return { kind: 'drop', reason: 'connection_gone' };
    if (!providerSupports(conn.provider, capability)) return { kind: 'drop', reason: 'capability_unavailable' };
    if (conn.status !== 'connected') return { kind: 'absent', conn };
    return { kind: 'ok', conn, target: { connectionId: conn.id } };
  }
  const active = await resolveActiveConnection(dbc, job.partnerId);
  if (!active) return { kind: 'absent', conn: null };
  if (active.provider !== LEGACY_UNTARGETED_JOB_PROVIDER) return { kind: 'drop', reason: 'legacy_non_quickbooks' };
  if (active.status !== 'connected') return { kind: 'absent', conn: active };
  return { kind: 'ok', conn: active, target: { connectionId: active.id } };
}

export function logJobDrop(
  queue: string,
  jobType: string,
  data: { partnerId: string; connectionId?: string },
  reason: JobDropReason,
): void {
  console.log(`[${queue}] job dropped`, `reason=${reason}`, `type=${jobType}`,
    `partnerId=${data.partnerId}`, `connectionId=${data.connectionId ?? 'legacy'}`);
}
```

- [ ] **Step 4: Wire the sync worker**

In `processAccountingSyncJob`, replace the `getConnection(db, data.partnerId, 'quickbooks')` block with the following. The existing branches below it stay; they now read `resolution`.

```ts
    const capability = data.type === 'push-payment' || data.type === 'delete-payment'
      ? 'paymentPush' : data.type === 'sync-mapping' ? 'mapping' : 'invoicePush';
    const resolution = await runInDbContext(() => resolveJobConnection(
      { partnerId: data.partnerId,
        connectionId: 'connectionId' in data ? data.connectionId : undefined,
        mappingId: 'mappingId' in data ? data.mappingId : undefined },
      capability, db));
    if (resolution.kind === 'drop') {
      logJobDrop('AccountingSyncWorker', data.type, { partnerId: data.partnerId,
        connectionId: 'connectionId' in data ? data.connectionId : undefined }, resolution.reason);
      return;
    }
    const conn = resolution.kind === 'ok' ? resolution.conn : null;
    const target = resolution.kind === 'ok' ? resolution.target : undefined;
```

Move the `sync-mapping` branch below this block (it runs today without a connection check). Call `syncMappedEntity({ partnerId, provider: conn.provider, … }, runInDbContext, target)`. If `conn` is null, keep today's behaviour: call `syncMappedEntity`, which raises its own `not_connected`, which is terminal. The rest of the function uses `conn` / `!conn || conn.status !== 'connected'` exactly as today. It passes `target` as the new last argument to `pushInvoiceToAccounting`, `voidInvoiceInAccounting`, `pushPaymentToAccounting` and `deletePaymentInAccounting`.

Update the enqueue helpers so `connectionId` is required and lands in the payload:

```ts
export async function enqueueAccountingInvoicePush(invoiceId: string, partnerId: string, connectionId: string): Promise<boolean> {
  try {
    await getAccountingSyncQueue().add(
      'push-invoice',
      { type: 'push-invoice', invoiceId, partnerId, connectionId },
      { jobId: `accounting-push-${invoiceId}`, ...ENQUEUE_OPTS }, // jobId unchanged: dedup must not move
    );
    return true;
  } catch (err) { /* unchanged */ }
}
```

Apply the same change to `enqueueAccountingInvoiceVoid` and `enqueueAccountingMappingSync`. In `processMappingSweep`, add `integrationId: accountingEntityMappings.integrationId` to the select, `innerJoin(accountingConnections, eq(accountingConnections.id, accountingEntityMappings.integrationId))`, and `provider: accountingConnections.provider`. Skip rows where `!providerSupports(row.provider, 'mapping')`, and pass `row.integrationId` as `connectionId`.

In the converted-to-delete follow-up (`processPaymentJob`), nothing changes; payment enqueue signatures are unchanged.

- [ ] **Step 5: Wire the producers**

In `accountingConnectionService.ts`:

```ts
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';

/**
 * Producer-side gate (spec "capabilities … producers don't enqueue"). Reads the
 * partner-axis row through readWithPartnerAxisVisibility: producers run inside
 * whatever request context issued the invoice, and an org-scoped RLS context
 * sees ZERO accounting_connections rows, which would silently skip every
 * enqueue for org-scoped users (#2822). partnerId comes from a row the caller
 * already resolved under its own context, never from the client.
 */
export async function resolveActiveConnectionFor(
  partnerId: string,
  capability: AccountingCapability,
): Promise<AccountingConnection | null> {
  const conn = await readWithPartnerAxisVisibility(() => resolveActiveConnection(db, partnerId));
  return conn && providerSupports(conn.provider, capability) ? conn : null;
}
```

In the `invoiceService.ts` issue hook:

```ts
  try {
    const conn = await resolveActiveConnectionFor(inv.partnerId, 'invoicePush');
    if (conn) await enqueueAccountingInvoicePush(invoiceId, inv.partnerId, conn.id);
  } catch (err) { /* existing log line */ }
```

Do the same in the void hook with `enqueueAccountingInvoiceVoid(invoiceId, voidedPartnerId, conn.id)`. The route push-bulk resolves once per request with `resolveActiveConnection(db, partner.partnerId)` (the route runs under partner auth, so RLS sees the row). It returns 409 `capability_unavailable` when the provider mismatches the route param or lacks `invoicePush`, and passes `conn.id` to every enqueue. The mapping-sync enqueue at ~L1096 passes the connection the route already resolved.

`listOwedPaymentMappings`: add `innerJoin(accountingConnections, and(eq(accountingConnections.id, accountingEntityMappings.integrationId), eq(accountingConnections.partnerId, accountingEntityMappings.partnerId)))`, select `provider: accountingConnections.provider`, and have the reconcile sweep skip rows where `!providerSupports(row.provider, 'paymentPush')`.

- [ ] **Step 6: Wire the reconcile worker**

- `processReconcileConnectionJob`: `const conn = await runInDbContext(() => getConnectionById(db, data.connectionId, data.partnerId));`. `classifyReconcileSkip` then keeps its `missing` / `connection_mismatch` semantics. When loading by id, `connection_mismatch` can only occur for a row whose id differs, which is impossible, so it reduces to `missing`; keep the branch for the log shape. After it, add `if (!providerSupports(conn.provider, 'paymentPull')) → skip 'capability_unavailable'` (extend `ReconcileSkipReason`).
- Replace `resolveConnectionAndToken(data.partnerId, 'quickbooks', runInDbContext)` with `resolveConnectionAndToken(data.partnerId, { connectionId: data.connectionId }, runInDbContext)`.
- `processReconcileSweep`: `listReconcilableConnections(db)`, then `connections.filter((c) => providerSupports(c.provider, 'paymentPull'))`.

- [ ] **Step 7: Keep the existing worker tests green (wiring and fixtures only)**

- In `accountingSyncWorker.test.ts`'s `accountingConnectionService` mock, point `resolveActiveConnection`, `getConnectionById` and `getConnectionForMapping` all at the existing `getConnectionMock`, so every fixture keeps driving the same branch. Add `provider: 'quickbooks'` to the object-literal rows at ~L316-L382, which have no `provider` field; the legacy rule reads it.
- Mock `../services/accounting/providerRegistry` with `providerSupports: () => true`, `LEGACY_UNTARGETED_JOB_PROVIDER: 'quickbooks'`.
- In `accountingReconcileWorker.test.ts`, the `getConnection` mock becomes `getConnectionById`; the `listReconcilableConnections` fixture rows gain `provider: 'quickbooks'`.
- In the issue and void hook tests, mock `resolveActiveConnectionFor` to return `{ id: 'c1', provider: 'quickbooks' }` by default and update `toHaveBeenCalledWith(invoiceId, partnerId)` to `(invoiceId, partnerId, 'c1')`.

```bash
cd apps/api && npx vitest run src/jobs src/services/invoiceService src/routes/accounting src/services/accounting && npx tsc --noEmit -p .
```

Expected: PASS, and tsc is clean.

- [ ] **Step 8: Commit**

```bash
git add -A apps/api/src/jobs apps/api/src/services apps/api/src/routes/accounting
git commit -m "feat(accounting): jobs carry connectionId; capability gates in producers and workers (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Stripe paths filter payment mappings by `integration_id`

**Files:**
- Modify: `apps/api/src/services/stripeReconcile.ts`: the partial-refund `db.update(accountingEntityMappings)` (~L377-388) in `reflectStripeRefund`; move `const partnerId = await invoicePartnerId(mapping.invoiceId)` (~L392) above it.
- Modify: `apps/api/src/services/stripeReversalState.ts`: the partial-refund update (~L358-369); `invoice.partnerId` is in scope (~L229).
- Test: the existing Stripe reconcile/reversal suites (`grep -ln "partialRefundDivergenceMessage\|accountingEntityMappings" apps/api/src/services/stripe*.test.ts`).

**Interfaces:**
- Consumes: `resolveActiveConnection(dbc, partnerId)` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test** (in the reconcile suite that covers the partial refund; mirror it in the reversal suite)

```ts
it('flags only the payment mapping under the partner\'s active connection (integration_id filter, Xero W01)', async () => {
  resolveActiveConnectionMock.mockResolvedValue({ id: 'conn-1', partnerId: PARTNER_ID, provider: 'quickbooks' });
  await reflectStripeRefund(partialRefundInput);
  const where = renderSql(lastAccountingMappingUpdateWhere());
  expect(where).toContain('"accounting_entity_mappings"."integration_id" = $');
  expect(where).toContain('"accounting_entity_mappings"."partner_id" = $');
});

it('skips the divergence flag, without throwing, when the partner has no accounting connection', async () => {
  resolveActiveConnectionMock.mockResolvedValue(null);
  await expect(reflectStripeRefund(partialRefundInput)).resolves.toBeDefined();
  expect(accountingMappingUpdateCalls()).toHaveLength(0);
});
```

`renderSql` is `(w: SQL) => new PgDialect().sqlToQuery(w).sql`. `lastAccountingMappingUpdateWhere` and `accountingMappingUpdateCalls` read the file's existing db-mock capture; if the suite captures updates differently, assert through that capture.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/stripeReconcile src/services/stripeReversalState
```

Expected: FAIL. The where clause has no `integration_id`.

- [ ] **Step 3: Implement** (the same shape in both files)

```ts
      // Xero W01 hardening: scope the flag to the partner's ACTIVE connection's
      // mapping. One connection per partner and ON DELETE CASCADE already make a
      // cross-connection match impossible; this makes it impossible by predicate
      // too, instead of by schema accident.
      const activeConn = await resolveActiveConnection(db, partnerId);
      if (activeConn) {
        await db.update(accountingEntityMappings)
          .set({ syncStatus: 'error', lastError: partialRefundDivergenceMessage(refunded), updatedAt: new Date() })
          .where(and(
            eq(accountingEntityMappings.integrationId, activeConn.id),
            eq(accountingEntityMappings.partnerId, partnerId),
            eq(accountingEntityMappings.breezeEntityType, 'payment'),
            eq(accountingEntityMappings.breezeEntityId, paymentId),
            eq(accountingEntityMappings.breezeOrigin, true),
            isNotNull(accountingEntityMappings.remoteEntityId),
          ));
      }
```

In `stripeReversalState.ts`, `partnerId` is `invoice.partnerId` and `paymentId` is `payment.id`. Both run inside the existing system context, so `db` sees the partner-axis row.

- [ ] **Step 4: Run and confirm they pass**, together with the coverage guard. The files keep a direct `.update(accountingEntityMappings`, so their allowlist entries stay valid and not stale.

```bash
cd apps/api && npx vitest run src/services/stripeReconcile src/services/stripeReversalState src/__tests__/partner-wide-write-coverage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/stripeReconcile.ts apps/api/src/services/stripeReversalState.ts apps/api/src/services/stripe*.test.ts
git commit -m "fix(billing): scope Stripe partial-refund mapping flags by integration_id (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Shared webhook routing helper

**Files:**
- Create: `apps/api/src/services/accounting/accountingWebhookRouting.ts`, `apps/api/src/services/accounting/accountingWebhookRouting.test.ts`
- Modify: `apps/api/src/routes/webhooks/quickbooks.ts`: `lookupConnectionsChunked` (~L128-137) and the enqueue loop (~L221-233). **The route URL `/webhooks/quickbooks` does not change.**
- Test: `apps/api/src/routes/webhooks/quickbooks.test.ts` (must stay green unchanged except for mock wiring)

**Interfaces:**
- Consumes: `findConnectionByRealmFingerprint` (existing), `providerSupports` (Task 3), `enqueueAccountingReconcile` (existing).
- Produces:
  ```ts
  export type WebhookRouteOutcome = 'enqueued' | 'enqueue_failed' | 'no_connection' | 'capability_unavailable';
  /** Must be called with NO ambient DB context; opens its own short system context for the lookup. */
  export async function routeWebhookToConnection(provider: AccountingProviderId, realmFingerprint: string): Promise<WebhookRouteOutcome>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ find: vi.fn(), enqueue: vi.fn(), supports: vi.fn(() => true) }));
vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn(), runOutsideDbContext: (fn: () => unknown) => fn() }));
vi.mock('./accountingConnectionService', () => ({ findConnectionByRealmFingerprint: m.find }));
vi.mock('./providerRegistry', () => ({ providerSupports: m.supports }));
vi.mock('../../jobs/accountingReconcileWorker', () => ({ enqueueAccountingReconcile: m.enqueue }));

describe('routeWebhookToConnection', () => {
  beforeEach(() => vi.clearAllMocks());
  it('enqueues a webhook-triggered reconcile for the matching connection', async () => {
    m.find.mockResolvedValue({ id: 'c1', partnerId: 'p1', provider: 'quickbooks' });
    m.enqueue.mockResolvedValue(true);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await expect(routeWebhookToConnection('quickbooks', 'fp1:k:abc')).resolves.toBe('enqueued');
    expect(m.find).toHaveBeenCalledWith({}, 'quickbooks', 'fp1:k:abc');
    expect(m.enqueue).toHaveBeenCalledWith('c1', 'p1', 'webhook');
  });
  it('reports no_connection for an unknown fingerprint', async () => {
    m.find.mockResolvedValue(null);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await expect(routeWebhookToConnection('quickbooks', 'fp')).resolves.toBe('no_connection');
  });
  it('does not enqueue when the provider cannot pull payments', async () => {
    m.find.mockResolvedValue({ id: 'c1', partnerId: 'p1', provider: 'xero' });
    m.supports.mockReturnValue(false);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await expect(routeWebhookToConnection('xero', 'fp')).resolves.toBe('capability_unavailable');
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it('reports enqueue_failed honestly (the route answers 503 so the sender retries)', async () => {
    m.find.mockResolvedValue({ id: 'c1', partnerId: 'p1', provider: 'quickbooks' });
    m.enqueue.mockResolvedValue(false);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await expect(routeWebhookToConnection('quickbooks', 'fp')).resolves.toBe('enqueue_failed');
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingWebhookRouting.test.ts
```

Expected: FAIL with "Cannot find module './accountingWebhookRouting'".

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/accounting/accountingWebhookRouting.ts
/**
 * Provider webhook → connection → reconcile job (spec W01 "Webhooks"). Every
 * provider's webhook route verifies its own signature, extracts its tenant/realm
 * ids, fingerprints them, and calls this — the lookup and enqueue rules live
 * once. Webhooks are doorbells: the reconcile worker's change pull decides what
 * actually changed.
 */
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { findConnectionByRealmFingerprint } from './accountingConnectionService';
import { providerSupports } from './providerRegistry';
import { enqueueAccountingReconcile } from '../../jobs/accountingReconcileWorker';
import type { AccountingProviderId } from './types';

export type WebhookRouteOutcome = 'enqueued' | 'enqueue_failed' | 'no_connection' | 'capability_unavailable';

export async function routeWebhookToConnection(
  provider: AccountingProviderId,
  realmFingerprint: string,
): Promise<WebhookRouteOutcome> {
  const conn = await withSystemDbAccessContext(
    () => findConnectionByRealmFingerprint(db, provider, realmFingerprint),
  );
  if (!conn) return 'no_connection';
  if (!providerSupports(conn.provider, 'paymentPull')) return 'capability_unavailable';
  const ok = await runOutsideDbContext(() => enqueueAccountingReconcile(conn.id, conn.partnerId, 'webhook'));
  return ok ? 'enqueued' : 'enqueue_failed';
}
```

In `routes/webhooks/quickbooks.ts`, keep the rate limit, verifier, signature, shape check, dedupe and cap exactly as they are. Replace the `lookupConnectionsChunked` + enqueue loop with the following. The literal `'quickbooks'` stays allowed in this file, because `routes/webhooks/` is outside the guard's scope.

```ts
  let matched = 0; let dropped = realmsCapped; let enqueued = 0; let failed = 0;
  try {
    for (const realmId of cappedRealmIds) {
      const outcome = await routeWebhookToConnection('quickbooks', hmacFingerprint(realmId));
      if (outcome === 'no_connection' || outcome === 'capability_unavailable') { dropped += 1; continue; }
      matched += 1;
      if (outcome === 'enqueued') enqueued += 1; else failed += 1;
    }
  } catch (err) {
    console.error('[quickbooksWebhook] realm lookup failed', err instanceof Error ? err.message : err);
    return c.json({ error: 'Service Unavailable' }, 503);
  }
```

This changes one thing: the old code ran every lookup in ONE system context (chunked) and then enqueued. Now each realm opens its own short context. `MAX_REALMS_PER_PAYLOAD` bounds the count, and an Intuit delivery usually carries one realm. A lookup failure still answers 503. Keep `REALM_LOOKUP_CHUNK_SIZE` only if something else uses it; otherwise delete it.

- [ ] **Step 4: Run the helper and the existing webhook suite**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingWebhookRouting.test.ts src/routes/webhooks/quickbooks.test.ts src/routes/webhooks.mountOrder.test.ts
```

Expected: PASS. If `quickbooks.test.ts` mocks `findConnectionByRealmFingerprint` and `enqueueAccountingReconcile` at their original modules, it keeps working, because the helper imports from those modules. Response codes and log fields are asserted unchanged.

- [ ] **Step 5: Run the full W01a verification** (the QBO unit set, the accounting integration set, and tsc; commands in Global Constraints). Then commit:

```bash
git add apps/api/src/services/accounting/accountingWebhookRouting.ts apps/api/src/services/accounting/accountingWebhookRouting.test.ts apps/api/src/routes/webhooks/quickbooks.ts
git commit -m "refactor(accounting): shared routeWebhookToConnection used by the QuickBooks webhook (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Open PR W01a** (`Part of #<W01 sub-issue>`; do not use `Closes`, since W01 closes with W01d). State the preamble items 1, 2 and 4 in the PR body.

---
# PR W01b — Neutral errors and provider mechanics

### Task 8: `AccountingProviderError`, QBO boundary translation, `'provider_error'`

**Files:**
- Create: `apps/api/src/services/accounting/accountingProviderError.ts`, `apps/api/src/services/accounting/accountingProviderError.test.ts`
- Modify: `apps/api/src/services/accounting/quickbooksFault.ts` (add the translator; it is the only QBO-aware module the provider already imports)
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts`: wrap every public async method (`exchangeCode`, `refresh`, `listRemoteCustomers`, `listRemoteItems`, `fetchRealmSettings`, `listRemoteIncomeAccounts`, `upsertCustomer`, `upsertItem`, `pushInvoice`, `voidInvoice`, `createPayment`, `deletePayment`, `reconcileChanges`) in a boundary
- Modify: `accountingInvoicePush.ts`: `sanitizeInvoiceSyncErrorMessage`, `voidBlockedByPaymentsMessage`, `logProviderFault`, `translateMappingError`, `translateNestedSyncError`, the `pushInvoice` catch (~L846-861), the `voidInvoice` catch (~L1031-1053), and the `AccountingInvoicePushErrorCode` union
- Modify: `accountingPaymentPush.ts`: `sanitizePaymentSyncErrorMessage`, `logProviderFault`, `translateMappingError`, the `createPayment` catch (~L1676-1692), the retry at ~L1821, the delete catch (~L2040-2054), and the `AccountingPaymentPushErrorCode` union
- Modify: `accountingMappingService.ts`: `callProviderOrThrow` (~L263-271), ~L1323, and the `AccountingMappingErrorCode` union
- Modify: `accountingTokens.ts`: `isInvalidGrant` (~L27-31)
- Modify: `quickbooksCustomerImport.ts`: the `QbImportErrorCode` union and the 502 throw (~L118). Task 16 renames the file.
- Modify: `apps/api/src/jobs/accountingSyncWorker.ts`: comments naming `quickbooks_error`; add a legacy-alias test
- Tests (the listed edits only): `accountingInvoicePush.test.ts` (the payment-linked fixture ~L1294), `accountingPaymentPush.test.ts` (the fault fixture ~L1412), `accountingTokens.test.ts` (the invalid_grant fixtures ~L408, ~L434); `'quickbooks_error'` → `'provider_error'` assertions in `accountingSyncWorker.test.ts`, `routes/accounting/customers.test.ts`, `invoicePush.test.ts`, `mappings.test.ts`, `quickbooksCustomerImport.test.ts`, `accountingInvoicePush.test.ts`, `accountingMappingService.test.ts`, `accountingPaymentPush.test.ts`, `__tests__/integration/accountingPaymentPush.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // accountingProviderError.ts
  export type AccountingProviderErrorKind =
    | 'reauth' | 'rate_limited' | 'validation' | 'not_found' | 'stale_version'
    | 'payment_linked' | 'duplicate_doc_number' | 'transient';
  export interface AccountingProviderErrorInit {
    kind: AccountingProviderErrorKind; provider: AccountingProviderId; operation: string;
    message?: string; httpStatus?: number; providerCode?: string; providerMessage?: string;
    retryAfterMs?: number; logBody?: string; telemetryTags?: Record<string, string>; cause?: unknown;
  }
  export class AccountingProviderError extends Error {
    readonly kind; readonly provider; readonly operation; readonly httpStatus?; readonly providerCode?;
    readonly providerMessage?; readonly retryAfterMs?; readonly logBody?; readonly telemetryTags: Record<string, string>;
    get status(): number | undefined; // = httpStatus, so generic `status` readers keep working
  }
  export function isAccountingProviderError(err: unknown): err is AccountingProviderError;
  export function providerErrorKindOf(err: unknown): AccountingProviderErrorKind;       // non-provider errors → 'transient'
  export function providerFaultSuffix(err: unknown): string;                            // byte-identical to qboFaultSuffix's output
  export function providerTelemetryTags(err: unknown): Record<string, string>;          // {} for non-provider errors
  export function providerLogFields(err: unknown): { status: string; faultCode: string; body: string };
  // quickbooksFault.ts
  export function qboErrorToProviderError(err: unknown, operation: string): AccountingProviderError;
  ```
- Error-code unions gain `'provider_error'` and keep `'quickbooks_error'` as a dead alias (preamble item 3).

**QBO kind mapping** (every value is what today's behaviour already implies, so no outcome changes):

| QBO condition | kind | Core effect (unchanged from today) |
|---|---|---|
| token endpoint `error: invalid_grant`, or HTTP 400 with `/invalid_grant/i` in the message | `reauth` | `accountingTokens` marks `reauth_required` |
| `isQboPaymentLinkedRefusal(err)` | `payment_linked` | void → `void_blocked_by_payments` (terminal) |
| fault `5010` / `Stale Object` | `stale_version` | handled inside the provider; if it escapes → `provider_error` (retry) |
| fault `610` / `Object Not Found` | `not_found` | handled inside the provider; if it escapes → `provider_error` |
| HTTP 400 + `/Duplicate Document Number/i` in the body | `duplicate_doc_number` | handled inside the provider; if it escapes → `provider_error` |
| any other HTTP 400 | `validation` | → `provider_error` (retry, as today) |
| everything else (401, 403, **429 until W01c**, 5xx, network, JSON parse) | `transient` | → `provider_error` (retry) |

- [ ] **Step 1: Write the failing tests**

`accountingProviderError.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AccountingProviderError, providerErrorKindOf, providerFaultSuffix, providerTelemetryTags,
} from './accountingProviderError';
import { qboErrorToProviderError } from './quickbooksFault';

describe('AccountingProviderError', () => {
  it('keeps the original message and exposes httpStatus as status', () => {
    const e = new AccountingProviderError({ kind: 'transient', provider: 'quickbooks', operation: 'QuickBooks invoice push', httpStatus: 500 });
    expect(e.message).toBe('QuickBooks invoice push failed with 500');
    expect(e.status).toBe(500);
  });

  it('providerFaultSuffix reproduces qboFaultSuffix byte-for-byte', () => {
    const e = new AccountingProviderError({ kind: 'validation', provider: 'quickbooks', operation: 'x', httpStatus: 400, providerMessage: 'Business Validation Error' });
    expect(providerFaultSuffix(e)).toBe(' (HTTP 400: Business Validation Error)');
    expect(providerFaultSuffix(Object.assign(new Error('raw'), { status: 500 }))).toBe(' (HTTP 500)');
    expect(providerFaultSuffix(new Error('raw'))).toBe('');
  });

  it('non-provider errors are transient and carry no provider tags', () => {
    expect(providerErrorKindOf(new TypeError('bug'))).toBe('transient');
    expect(providerTelemetryTags(new TypeError('bug'))).toEqual({});
  });
});

describe('qboErrorToProviderError (QBO boundary)', () => {
  const raw = (fields: Record<string, unknown>, message = 'QuickBooks invoice void failed with 400') =>
    Object.assign(new Error(message), fields);

  it.each([
    [raw({ status: 400, qboError: 'invalid_grant' }, 'invalid_grant'), 'reauth'],
    [raw({ status: 400, qboFaultCode: '6000', qboFaultMessage: 'Business Validation Error', qboPaymentLinked: true }), 'payment_linked'],
    [raw({ status: 400, qboFaultCode: '5010', qboFaultMessage: 'Stale Object Error' }), 'stale_version'],
    [raw({ status: 400, qboFaultCode: '610', qboFaultMessage: 'Object Not Found' }), 'not_found'],
    [raw({ status: 400, body: '{"Fault":{"Error":[{"Message":"Duplicate Document Number Error"}]}}' }), 'duplicate_doc_number'],
    [raw({ status: 400, qboFaultCode: '6000', qboFaultMessage: 'Business Validation Error' }), 'validation'],
    [raw({ status: 429 }), 'transient'],   // W01c changes this row to rate_limited
    [raw({ status: 503 }), 'transient'],
    [new Error('fetch failed'), 'transient'],
  ])('%# classifies', (err, kind) => {
    expect(qboErrorToProviderError(err, 'op').kind).toBe(kind);
  });

  it('keeps message, status, the QBO fields and the qbo_fault_code tag', () => {
    const t = qboErrorToProviderError(raw({ status: 400, body: 'b', qboFaultCode: '6000', qboFaultMessage: 'Business Validation Error' }), 'QuickBooks payment create');
    expect(t.message).toBe('QuickBooks invoice void failed with 400');
    expect(t.status).toBe(400);
    expect(t.providerMessage).toBe('Business Validation Error');
    expect(t.logBody).toBe('b');
    expect(t.telemetryTags).toEqual({ qbo_fault_code: '6000' });
    expect((t as unknown as { qboFaultCode: string }).qboFaultCode).toBe('6000'); // QBO-aware readers unchanged
  });

  it('is idempotent on an already-translated error', () => {
    const t = qboErrorToProviderError(raw({ status: 500 }), 'op');
    expect(qboErrorToProviderError(t, 'other')).toBe(t);
  });
});
```

Append to `accountingSyncWorker.test.ts`:

```ts
it('treats the legacy quickbooks_error code as retryable (dead alias, Xero W01)', async () => {
  getConnectionMock.mockResolvedValue(connectionRow());
  pushInvoiceToAccountingMock.mockRejectedValue(new AccountingInvoicePushError('quickbooks_error', 502, 'x'));
  await expect(processAccountingSyncJob({ type: 'push-invoice', invoiceId: 'i1', partnerId: 'p1' })).rejects.toThrow('x');
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingProviderError.test.ts
```

Expected: FAIL with "Cannot find module './accountingProviderError'".

- [ ] **Step 3: Implement `accountingProviderError.ts`**

```ts
/**
 * The provider-neutral failure every AccountingProvider throws (spec W01
 * "Neutral error model"). Providers translate their own faults at their
 * boundary; the core branches on `kind` ONLY and never parses a provider body.
 *
 * `providerMessage` is the short fault CLASS ("Business Validation Error") —
 * never a provider `Detail`, which carries customer names and amounts.
 * `logBody` is for the SERVER LOG only (it never reaches Sentry or a mapping
 * card). `telemetryTags` are chosen by the provider and must be id- and PII-free
 * (QuickBooks keeps its historical `qbo_fault_code` tag this way).
 */
import type { AccountingProviderId } from './types';

export type AccountingProviderErrorKind =
  | 'reauth' | 'rate_limited' | 'validation' | 'not_found' | 'stale_version'
  | 'payment_linked' | 'duplicate_doc_number' | 'transient';

export interface AccountingProviderErrorInit {
  kind: AccountingProviderErrorKind;
  provider: AccountingProviderId;
  operation: string;
  message?: string;
  httpStatus?: number;
  providerCode?: string;
  providerMessage?: string;
  retryAfterMs?: number;
  logBody?: string;
  telemetryTags?: Record<string, string>;
  cause?: unknown;
}

export class AccountingProviderError extends Error {
  readonly kind: AccountingProviderErrorKind;
  readonly provider: AccountingProviderId;
  readonly operation: string;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  readonly retryAfterMs?: number;
  readonly logBody?: string;
  readonly telemetryTags: Record<string, string>;

  constructor(init: AccountingProviderErrorInit) {
    super(
      init.message ?? (init.httpStatus !== undefined ? `${init.operation} failed with ${init.httpStatus}` : `${init.operation} failed`),
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = 'AccountingProviderError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.operation = init.operation;
    this.httpStatus = init.httpStatus;
    this.providerCode = init.providerCode;
    this.providerMessage = init.providerMessage;
    this.retryAfterMs = init.retryAfterMs;
    this.logBody = init.logBody;
    this.telemetryTags = init.telemetryTags ?? {};
  }

  /** Mirrors httpStatus so generic `err.status` readers (route error mappers) keep working. */
  get status(): number | undefined {
    return this.httpStatus;
  }
}

export function isAccountingProviderError(err: unknown): err is AccountingProviderError {
  return err instanceof AccountingProviderError;
}

export function providerErrorKindOf(err: unknown): AccountingProviderErrorKind {
  return isAccountingProviderError(err) ? err.kind : 'transient';
}

function statusOf(err: unknown): number | undefined {
  if (isAccountingProviderError(err)) return err.httpStatus;
  const s = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
}

/** ` (HTTP 400: Business Validation Error)` — identical output to the old qboFaultSuffix. */
export function providerFaultSuffix(err: unknown): string {
  const status = statusOf(err);
  const message = isAccountingProviderError(err) ? err.providerMessage ?? null : null;
  if (status === undefined) return message ? ` (${message})` : '';
  return message ? ` (HTTP ${status}: ${message})` : ` (HTTP ${status})`;
}

export function providerTelemetryTags(err: unknown): Record<string, string> {
  return isAccountingProviderError(err) ? { ...err.telemetryTags } : {};
}

export function providerLogFields(err: unknown): { status: string; faultCode: string; body: string } {
  const status = statusOf(err);
  return {
    status: status === undefined ? 'none' : String(status),
    faultCode: isAccountingProviderError(err) ? err.providerCode ?? 'none' : 'none',
    body: isAccountingProviderError(err) ? err.logBody ?? '' : '',
  };
}
```

- [ ] **Step 4: Add the QBO translator** (in `quickbooksFault.ts`, after `isQboPaymentLinkedRefusal`)

```ts
import { AccountingProviderError, type AccountingProviderErrorKind } from './accountingProviderError';

/** Fields QBO-aware code (the provider, this module, and quickbooksProvider.test.ts) still reads. */
const QBO_CARRIED_FIELDS = ['body', 'qboFaultCode', 'qboFaultMessage', 'qboPaymentLinked', 'qboError'] as const;

function classifyQbo(err: unknown, status: number | undefined, fault: QboFault): AccountingProviderErrorKind {
  const e = (err ?? {}) as { qboError?: unknown; message?: unknown; body?: unknown };
  if (e.qboError === 'invalid_grant' || (status === 400 && /invalid_grant/i.test(String(e.message ?? '')))) return 'reauth';
  if (isQboPaymentLinkedRefusal(err)) return 'payment_linked';
  if (fault.code === '5010' || (fault.message && /Stale Object/i.test(fault.message))) return 'stale_version';
  if (fault.code === '610' || (fault.message && /Object Not Found/i.test(fault.message))) return 'not_found';
  if (status === 400 && typeof e.body === 'string' && /Duplicate Document Number/i.test(e.body)) return 'duplicate_doc_number';
  if (status === 400) return 'validation';
  return 'transient';
}

/**
 * THE QuickBooks boundary (Xero W01): every public QuickbooksProvider method
 * rethrows through this. Message and status are preserved verbatim, and the
 * QBO-specific fields are carried along for QBO-aware readers. The core reads
 * `kind` and the neutral fields only (enforced by neutralCore.guard.test.ts).
 */
export function qboErrorToProviderError(err: unknown, operation: string): AccountingProviderError {
  if (err instanceof AccountingProviderError) return err;
  const e = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const fault = qboFaultOf(err);
  const translated = new AccountingProviderError({
    kind: classifyQbo(err, status, fault),
    provider: 'quickbooks',
    operation,
    message: err instanceof Error ? err.message : String(err),
    httpStatus: status,
    providerCode: fault.code ?? undefined,
    providerMessage: fault.message ?? undefined,
    logBody: typeof e.body === 'string' ? e.body : undefined,
    telemetryTags: { qbo_fault_code: fault.code ?? 'none' },
    cause: err,
  });
  for (const key of QBO_CARRIED_FIELDS) {
    if (e[key] !== undefined) Object.assign(translated, { [key]: e[key] });
  }
  return translated;
}
```

Update the module's header comment: the coordinators no longer read these fields, only the provider and this translator do.

- [ ] **Step 5: Wrap the provider's public methods** (`quickbooksProvider.ts`)

Add one private helper and route each public async method through it. The method bodies are otherwise untouched, so all internal 5010/610/DocNumber handling still sees raw QBO errors.

```ts
  /** Translate at the boundary; internal retries (5010 re-read, DocNumber fallback) run on raw errors first. */
  private async boundary<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw qboErrorToProviderError(err, operation);
    }
  }

  async pushInvoice(conn: AccountingConnection, invoice: AccountingInvoicePayload, lineMappings: readonly AccountingInvoiceLineMapping[]): Promise<InvoicePushResult> {
    return this.boundary('QuickBooks invoice push', () => this.pushInvoiceRaw(conn, invoice, lineMappings));
  }
  private async pushInvoiceRaw(/* same params */): Promise<InvoicePushResult> { /* the existing body, unchanged */ }
```

Repeat for the other 12 public async methods. Name each operation after the string its `qboRequest` call already uses (`'QuickBooks payment create'`, `'QuickBooks invoice void'`, …). `verifyWebhook` and `buildAuthUrl` are synchronous and stay as they are.

- [ ] **Step 6: Switch the core to kinds** (the sites listed under **Files**)

`accountingInvoicePush.ts`:

```ts
import {
  providerErrorKindOf, providerFaultSuffix, providerLogFields, providerTelemetryTags,
} from './accountingProviderError';
// remove: import { isQboPaymentLinkedRefusal, qboFaultOf, qboFaultSuffix } from './quickbooksFault';

function sanitizeInvoiceSyncErrorMessage(err: unknown, label: string): string {
  return `${label} rejected the invoice sync${providerFaultSuffix(err)}`;
}

function voidBlockedByPaymentsMessage(err: unknown, label: string): string {
  return `${label} will not void this invoice because a payment is applied to it there`
    + ` — remove or unapply that payment in ${label}, then void the invoice again${providerFaultSuffix(err)}`;
}

function logProviderFault(operation: string, mappingId: string, err: unknown): void {
  const f = providerLogFields(err);
  console.error(`[accountingInvoicePush] ${operation} failed`, `mappingId=${mappingId}`,
    `status=${f.status}`, `faultCode=${f.faultCode}`, `body=${f.body}`);
}
```

In the `pushInvoice` catch:

```ts
    const label = accountingProviderDisplayName(conn.provider);
    const message = sanitizeInvoiceSyncErrorMessage(err, label);
    logProviderFault('pushInvoice', mappingRow.id, err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingInvoicePush', accounting_mapping_id: mappingRow.id, invoice_id: inv.id,
      ...providerTelemetryTags(err),
    });
    await markInvoiceMappingErrorInOwnContext(runInDbContext, mappingRow.id, partnerId, message);
    throw new AccountingInvoicePushError('provider_error', 502, message);
```

In the void catch, `const blockedByPayments = providerErrorKindOf(err) === 'payment_linked';` and use the `label` variants. Replace the other `'quickbooks_error'` throws with `'provider_error'`. `translateNestedSyncError` accepts `'provider_error' || 'quickbooks_error' || 'sync_in_progress'` and rethrows `'provider_error'`.

Make the same moves in `accountingPaymentPush.ts`: the message becomes `` `${label} rejected the payment sync${providerFaultSuffix(err)}` ``, `providerTelemetryTags` replaces the tags, `'provider_error'` replaces the code, and the `quickbooksFault` import goes away. `label` comes from `prep.conn.provider`.

`accountingMappingService.ts` `callProviderOrThrow` and ~L1323: `'provider_error'`.

`accountingTokens.ts`:

```ts
import { providerErrorKindOf } from './accountingProviderError';

// Only an explicit, provider-classified OAuth refusal is permanent reauth. The
// provider decides what that means (QBO: invalid_grant) — the core never parses it.
function isInvalidGrant(err: unknown): boolean {
  return providerErrorKindOf(err) === 'reauth';
}
```

Add `'provider_error'` to each code union beside `'quickbooks_error'`, with the comment `// 'quickbooks_error': pre-W01 alias, never thrown any more; kept so an in-flight comparison still compiles`.

- [ ] **Step 7: Update the fixtures and assertions named under Files** (these are the only test edits)

```ts
// accountingInvoicePush.test.ts ~L1294, accountingPaymentPush.test.ts ~L1412: the fixture now models what the provider throws
import { qboErrorToProviderError } from './quickbooksFault';
voidInvoiceMock.mockRejectedValue(qboErrorToProviderError(Object.assign(new Error('QuickBooks invoice void failed with 400'), {
  status: 400, qboFaultCode: '6000', qboFaultMessage: 'Business Validation Error', qboPaymentLinked: true,
}), 'QuickBooks invoice void'));
// accountingTokens.test.ts ~L408 and ~L434
mocks.provider.refresh.mockRejectedValueOnce(qboErrorToProviderError({ status: 400, qboError: 'invalid_grant', message: 'invalid_grant' }, 'QuickBooks token refresh'));
```

Every assertion in those tests stays byte-identical. That includes `lastError === 'QuickBooks rejected the payment sync (HTTP 400: Business Validation Error)'`, the `qbo_fault_code: '6000'` Sentry tag, and the server-log body line (it now comes from `logBody`).

Then replace `'quickbooks_error'` with `'provider_error'` in the assertion files listed under **Files**:

```bash
cd apps/api && grep -rln "'quickbooks_error'" src --include='*.test.ts' | xargs sed -i '' "s/'quickbooks_error'/'provider_error'/g"
git diff --stat -- '*.test.ts'
```

(On Linux, use `sed -i` without `''`.) Then restore the single legacy-alias test you added in Step 1 to `'quickbooks_error'`.

- [ ] **Step 8: Run and confirm everything passes**

```bash
cd apps/api && npx vitest run src/services/accounting src/jobs/accountingSyncWorker.test.ts src/jobs/accountingReconcileWorker.test.ts src/routes/accounting && npx tsc --noEmit -p .
grep -rn "quickbooksFault\|qboFaultOf\|isQboPaymentLinkedRefusal\|qboError" src/services/accounting/accounting*.ts src/jobs src/routes/accounting | grep -v '\.test\.ts'
```

Expected: tests PASS, `quickbooksProvider.test.ts` and `quickbooksFault.test.ts` pass with **no edits**, and tsc is clean. The grep prints nothing.

- [ ] **Step 9: Commit**

```bash
git add -A apps/api/src/services/accounting apps/api/src/jobs apps/api/src/routes/accounting apps/api/src/__tests__/integration/accountingPaymentPush.integration.test.ts
git commit -m "refactor(accounting): AccountingProviderError; QuickBooks translates faults at its boundary (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The mechanics table: remote version, payment marker, limits, payment method, provider-labelled sentinel

**Files:**
- Modify: `apps/api/src/services/accounting/types.ts`: `RemoteRef`, `RemoteCustomer`, `RemoteItem`, `InvoiceVoidResult`, `AccountingPaymentPayload`, `AccountingDeletePaymentPayload`, `ChangeSetPaymentLine`, `ChangeSet` docs, `AccountingProvider`, and `INVOICE_REMOTE_DELETED_ERROR`
- Modify: `quickbooksProvider.ts` (produce the renamed fields, `paymentMarker`, `limits`, `method`); move `mapQboPaymentMethod` and `QBO_PAYMENT_METHOD_NAMES` here from `accountingPaymentPull.ts` (~L222-250)
- Modify: `accountingPaymentPull.ts` (use `line.method` and `line.remotePaymentVersion`, labelled messages, and the marker predicate), `accountingPaymentPush.ts` (`limits.paymentRefMax`, `marker`, labelled messages), `accountingInvoicePush.ts` (`isInvoiceRemoteDeletedMarker`, `notInArray`), `accountingPaymentMarker.ts` (`partialRefundDivergenceMessage(total, label)`), `invoiceService.ts` (`remoteDeleted`), `accountingMappingService.ts` (`.remoteVersion`)
- Test: `types.test.ts` (the pinned contract), `accountingPaymentPull.test.ts` (the `mapQboPaymentMethod` import moves to `./quickbooksProvider`), and rename-only fixture edits that tsc will list

**Interfaces:**
- Produces (in `types.ts`):
  ```ts
  export interface RemoteRef { …; remoteVersion?: string /* was syncToken */ }
  export interface RemoteCustomer { …; remoteVersion?: string }   export interface RemoteItem { …; remoteVersion?: string }
  export interface InvoiceVoidResult { remoteVersion: string | null /* was syncToken */ }
  export interface AccountingDeletePaymentPayload { remotePaymentId: string; remoteVersion: string | null /* was syncToken */ }
  export interface AccountingPaymentPayload { …; marker: string /* was privateNote */ }
  export type AccountingPaymentMethod = PaymentMethod;             // from @breeze/shared (PAYMENT_METHODS)
  export interface ChangeSetPaymentLine { …; remotePaymentVersion: string | null /* was remotePaymentSyncToken */; method: AccountingPaymentMethod }
  export interface RateLimitSpec {
    perConnection: { limit: number; windowSeconds: number };
    maxConcurrentPerConnection: number | null;
    appWide: { limit: number; windowSeconds: number } | null;
    dailyPerConnection: { limit: () => number } | null;
  }
  export interface AccountingProvider {
    …
    readonly limits: { readonly paymentRefMax: number; readonly rate: RateLimitSpec };
    readonly paymentMarker: { embed(reference: string | null, marker: string): string; extract(text: string | null | undefined): string | null };
    /** The environment a fresh connection records (QBO: QBO_ENVIRONMENT; Xero: 'production'). */
    connectEnvironment(): AccountingEnvironment;
    /** Null when the instance is configured for this provider; otherwise an operator-facing reason. */
    configError(): string | null;
  }
  export const INVOICE_REMOTE_DELETED_MARKERS: readonly string[];      // ['Deleted in QuickBooks', 'Deleted in Xero']
  export function invoiceRemoteDeletedMarker(displayName: string): string;
  export function isInvoiceRemoteDeletedMarker(lastError: string | null | undefined): boolean;
  /** @deprecated pre-W01 name for the QuickBooks marker; kept for existing test imports. */
  export const INVOICE_REMOTE_DELETED_ERROR = 'Deleted in QuickBooks';
  // accountingPaymentPull.ts
  export function breezeOriginDivergedMessage(label: string): string;   // `Edited in ${label}; Breeze remains the source of truth for this payment`
  export function breezeOriginRemovedMessage(label: string): string;    // `Deleted in ${label}`
  ```
  `AccountingEntityMapping.remoteSyncToken` is **not** renamed. It mirrors the `remote_sync_token` column, which the spec keeps.
- QBO values: `paymentRefMax: 21`; `rate: { perConnection: { limit: 500, windowSeconds: 60 }, maxConcurrentPerConnection: 10, appWide: null, dailyPerConnection: null }` (Intuit's published per-realm throttles: 500 requests/min and 10 concurrent). `paymentMarker.embed(_ref, marker) => marker` (the marker goes in `PrivateNote`, and the reference stays in `PaymentRefNum`). `paymentMarker.extract = parseBreezePaymentMarker`. `connectEnvironment() => QBO_ENVIRONMENT as AccountingEnvironment`. `configError()` is the body of today's route-level `validateProviderConfig` for QuickBooks. It moves here in Task 15; it is declared now so the type is complete.

- [ ] **Step 1: Update the pinned contract first** (`types.test.ts`; this is the failing test)

```ts
describe('provider mechanics (Xero W01)', () => {
  it('results carry an opaque remote version, never a provider-named token', () => {
    expectTypeOf<RemoteRef['remoteVersion']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<InvoiceVoidResult['remoteVersion']>().toEqualTypeOf<string | null>();
    expectTypeOf<ChangeSetPaymentLine['remotePaymentVersion']>().toEqualTypeOf<string | null>();
    expectTypeOf<RemoteRef>().not.toHaveProperty('syncToken');
    expectTypeOf<ChangeSetPaymentLine>().not.toHaveProperty('remotePaymentSyncToken');
  });
  it('payments carry a neutral marker and a neutral method', () => {
    expectTypeOf<AccountingPaymentPayload['marker']>().toEqualTypeOf<string>();
    expectTypeOf<AccountingPaymentPayload>().not.toHaveProperty('privateNote');
    expectTypeOf<ChangeSetPaymentLine['method']>().toEqualTypeOf<AccountingPaymentMethod>();
  });
  it('providers declare limits, a payment marker codec, environment and config checks', () => {
    expectTypeOf<AccountingProvider['limits']['paymentRefMax']>().toEqualTypeOf<number>();
    expectTypeOf<AccountingProvider['limits']['rate']>().toEqualTypeOf<RateLimitSpec>();
    expectTypeOf<Parameters<AccountingProvider['paymentMarker']['embed']>>().toEqualTypeOf<[string | null, string]>();
    expectTypeOf<ReturnType<AccountingProvider['configError']>>().toEqualTypeOf<string | null>();
  });
});
```

In the existing pinned block, replace `AccountingPaymentPayload['privateNote']` with `['marker']` and `remotePaymentSyncToken` with `remotePaymentVersion`. These are the only edits to existing pins, and the spec requires them ("update the pinned types.test.ts contract").

Add a runtime test (`accountingPaymentPull.test.ts` or a new `types.markers.test.ts`):

```ts
import { INVOICE_REMOTE_DELETED_ERROR, invoiceRemoteDeletedMarker, isInvoiceRemoteDeletedMarker } from './types';
it('the QuickBooks remote-deleted marker is byte-identical to what production rows hold', () => {
  expect(invoiceRemoteDeletedMarker('QuickBooks')).toBe('Deleted in QuickBooks');
  expect(INVOICE_REMOTE_DELETED_ERROR).toBe('Deleted in QuickBooks');
  expect(isInvoiceRemoteDeletedMarker('Deleted in QuickBooks')).toBe(true);
  expect(isInvoiceRemoteDeletedMarker('Deleted in Xero')).toBe(true);
  expect(isInvoiceRemoteDeletedMarker('Payment pull: Deleted in QuickBooks')).toBe(false);
  expect(isInvoiceRemoteDeletedMarker(null)).toBe(false);
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/types.test.ts
```

Expected: FAIL. The properties do not exist.

- [ ] **Step 3: Implement the types, then follow tsc**

Make the `types.ts` changes from **Interfaces**, then run `npx tsc --noEmit -p apps/api`. Fix every reported site with a pure rename: `syncToken` → `remoteVersion` on seam results, `privateNote` → `marker`, `remotePaymentSyncToken` → `remotePaymentVersion`. The QBO provider maps its wire field to the neutral name, for example `return { id: parsed.Payment.Id, remoteVersion: parsed.Payment.SyncToken }`. Where the core persists it, write `remoteSyncToken: ref.remoteVersion ?? null` (column name unchanged). Then do the non-rename edits:

```ts
// types.ts
export const INVOICE_REMOTE_DELETED_MARKERS: readonly string[] = ['Deleted in QuickBooks', 'Deleted in Xero'];
export function invoiceRemoteDeletedMarker(displayName: string): string {
  return `Deleted in ${displayName}`;
}
export function isInvoiceRemoteDeletedMarker(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && INVOICE_REMOTE_DELETED_MARKERS.includes(lastError);
}
```

```ts
// accountingInvoicePush.ts: every `=== INVOICE_REMOTE_DELETED_ERROR` → isInvoiceRemoteDeletedMarker(...);
// every SQL guard `ne(accountingEntityMappings.lastError, INVOICE_REMOTE_DELETED_ERROR)` →
notInArray(accountingEntityMappings.lastError, [...INVOICE_REMOTE_DELETED_MARKERS]),
```

```ts
// accountingPaymentPull.ts (the invoice-deleted writer ~L1503):
await markInvoiceMappingError(conn, mapping.id, invoiceRemoteDeletedMarker(accountingProviderDisplayName(conn.provider)));
// method (~L556):
const method = line.method;
// BREEZE_ORIGIN_* constants become functions; callers pass accountingProviderDisplayName(conn.provider).
// Keep `export const BREEZE_ORIGIN_REMOVED_MESSAGE = breezeOriginRemovedMessage('QuickBooks')` and
// `BREEZE_ORIGIN_DIVERGED_MESSAGE = breezeOriginDivergedMessage('QuickBooks')` as deprecated aliases for existing test imports.
```

```ts
// accountingPaymentPush.ts (payload build ~L1655):
const provider = getAccountingProvider(conn.provider);
reference: payment.reference ? payment.reference.slice(0, provider.limits.paymentRefMax) : null,
marker: buildPaymentPrivateNote(payment.id),
// PAYMENT_REF_MAX_LENGTH stays exported (= 21) with a @deprecated note; nothing in the core reads it.
```

```ts
// quickbooksProvider.ts
readonly limits = {
  paymentRefMax: 21, // QBO REJECTS a PaymentRefNum over 21 chars
  rate: {
    perConnection: { limit: 500, windowSeconds: 60 }, // Intuit: 500 req/min per realm per app
    maxConcurrentPerConnection: 10,                    // Intuit: 10 concurrent per realm per app
    appWide: null,
    dailyPerConnection: null,
  },
} as const satisfies AccountingProvider['limits'];
readonly paymentMarker = {
  embed: (_reference: string | null, marker: string): string => marker, // PrivateNote holds the marker; PaymentRefNum keeps the reference
  extract: parseBreezePaymentMarker,
};
connectEnvironment(): AccountingEnvironment { return QBO_ENVIRONMENT as AccountingEnvironment; }
configError(): string | null {
  if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET || !QBO_REDIRECT_URI || !QBO_ENVIRONMENT) {
    return 'QuickBooks OAuth is not configured on this instance';
  }
  if (QBO_ENVIRONMENT !== 'sandbox' && QBO_ENVIRONMENT !== 'production') {
    return 'QBO_ENVIRONMENT must be sandbox or production';
  }
  return null;
}
// createPayment body: PrivateNote: this.paymentMarker.embed(payment.reference, payment.marker)
// mapQboCdcPayment: method: mapQboPaymentMethod(raw.PaymentMethodRef?.name ?? null), remotePaymentVersion: raw.SyncToken ?? null
```

Move `QBO_PAYMENT_METHOD_NAMES` and `mapQboPaymentMethod` verbatim from `accountingPaymentPull.ts` into `quickbooksProvider.ts` (exported), and change the test import. `paymentMethodName` stays on `ChangeSetPaymentLine` for display and logging. Its pin is kept.

`accountingPaymentMarker.ts`: `partialRefundDivergenceMessage(totalRefunded: string, label: string)` returns `` `${PREFIX}${totalRefunded}; record the refund in ${label} (this ${label} payment still shows the full amount)` ``. Both Stripe callers pass `accountingProviderDisplayName(activeConn.provider)`. The Task 6 code already holds `activeConn`.

Update the `ChangeSet` doc comments: "The instant the CDC window ends" becomes "The provider's change cursor (changes since `sinceCursor`)". The QBO 30-day backfill notes move to `reconcileChanges` in `quickbooksProvider.ts`. Doc-only.

- [ ] **Step 4: Run and confirm they pass**

```bash
cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/accounting src/jobs src/services/invoiceService src/services/stripeReconcile src/services/stripeReversalState src/routes/accounting
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingPaymentPull.integration.test.ts src/__tests__/integration/accountingPaymentPush.integration.test.ts src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts
```

Expected: PASS. Integration fixtures that set `syncToken` on a mocked provider result are renamed by tsc; the persisted-column assertions (`remoteSyncToken`) are unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api/src
git commit -m "refactor(accounting): provider-owned mechanics - remote version, marker, limits, payment method, labelled sentinels (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Pin the QuickBooks idempotency keys byte-for-byte

**Files:**
- Create: `apps/api/src/services/accounting/quickbooksIdempotency.test.ts`

**Interfaces:**
- Consumes: `quickbooksProvider` (Task 9 field names).
- Produces: nothing. This is a regression pin (spec quorum finding 1; Review Focus 2).

- [ ] **Step 1: Write the pin test**

```ts
/**
 * Spec W01 / Codex quorum finding 1: QBO requestids are BYTE-IDENTICAL to
 * pre-W01. A create accepted by Intuit before a deploy, whose response was lost,
 * is retried after the deploy; only an identical requestid makes Intuit replay
 * the original instead of booking a duplicate in the customer's QuickBooks.
 * Changing any expected string below is a production money bug, not a refactor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./accountingRateLimit', () => ({  // W01c: passthrough so no Redis is needed (harmless before W01c)
  withProviderCallSlot: (_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn(),
}));
import { quickbooksProvider } from './quickbooksProvider';
import type { AccountingConnection } from './accountingConnectionService';

const conn = {
  id: 'c1', partnerId: 'p1', provider: 'quickbooks', realmId: 'realm123', accessToken: 'tok', refreshToken: 'r',
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000), refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
  environment: 'sandbox', homeCurrency: 'USD', multiCurrencyEnabled: null, defaultIncomeAccountRef: null,
  defaultTaxCodeRef: null, pushMode: 'auto', status: 'connected', createdAt: null, updatedAt: null, lastError: null,
  realmIdFingerprint: null, pullPayments: true, pushPayments: true, lastReconcileAt: null, cdcCursor: null,
} as AccountingConnection;

function requestIdOf(fetchMock: ReturnType<typeof vi.spyOn>, call = 0): string | null {
  return new URL(String((fetchMock.mock.calls[call] as unknown[])[0])).searchParams.get('requestid');
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.restoreAllMocks());

describe('QuickBooks requestid pins (Xero W01)', () => {
  it('invoice create: requestid = invoiceId', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ Invoice: { Id: '9', SyncToken: '0', TotalAmt: 107, TxnTaxDetail: { TotalTax: 7 } } }));
    await quickbooksProvider.pushInvoice(conn, {
      invoiceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', docNumber: 'INV-1', txnDate: '2026-09-01', dueDate: null,
      customerRef: { id: '55' }, currencyCode: 'USD', subtotal: '100.00', taxTotal: '7.00', total: '107.00',
      lines: [{ invoiceLineId: 'l1', description: 'x', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', taxable: true }],
      mapping: null,
    }, []);
    expect(requestIdOf(f)).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it.each([
    [0, '11111111-2222-3333-4444-555555555555'],
    [1, '11111111-2222-3333-4444-555555555555:g1'],
    [7, '11111111-2222-3333-4444-555555555555:g7'],
  ])('payment create at generation %i: requestid = %s', async (pushGeneration, expected) => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ Payment: { Id: '77', SyncToken: '0' } }));
    await quickbooksProvider.createPayment(conn, {
      invoicePaymentId: '11111111-2222-3333-4444-555555555555', remoteCustomerId: '55', remoteInvoiceId: '9',
      amount: '10.00', currencyCode: 'USD', txnDate: '2026-09-01', reference: null,
      marker: 'Breeze payment 11111111-2222-3333-4444-555555555555', pushGeneration,
    });
    expect(requestIdOf(f)).toBe(expected);
  });

  it('customer create: requestid = customer-<organizationId>', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ Customer: { Id: '5', SyncToken: '0' } }));
    await quickbooksProvider.upsertCustomer(conn, {
      organizationId: 'org-1', displayName: 'Acme', billingEmail: null, taxId: null, currencyCode: 'USD',
    }, null);
    expect(requestIdOf(f)).toBe('customer-org-1');
  });

  it('item create: requestid = item-<catalogItemId>', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ Item: { Id: '6', SyncToken: '0' } }));
    await quickbooksProvider.upsertItem(conn, {
      catalogItemId: 'item-1', name: 'Support', description: null, type: 'Service', unitPrice: '10.00',
      currencyCode: 'USD', taxable: true, active: true, incomeAccountRef: '1',
    }, null);
    expect(requestIdOf(f)).toBe('item-item-1');
  });
});
```

- [ ] **Step 2: Run it (it must PASS immediately; this is a pin, not TDD red)**

```bash
cd apps/api && npx vitest run src/services/accounting/quickbooksIdempotency.test.ts
```

Expected: PASS, 6 tests. **Control:** temporarily change `const createRequestId = invoice.invoiceId;` in `quickbooksProvider.ts` to `` `inv-${invoice.invoiceId}` ``, re-run, and confirm the first test FAILS with `expected 'inv-aaaa…' to be 'aaaa…'`. Revert and re-run until it PASSES. If the control does not go red, the pin is vacuous; fix the test.

If `upsertCustomer` / `upsertItem` issue a lookup request before the create in the current code (check the existing tests at `quickbooksProvider.test.ts` ~L172 and ~L274), add that response first and read `requestIdOf(f, 1)`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/accounting/quickbooksIdempotency.test.ts
git commit -m "test(accounting): pin QuickBooks requestids byte-for-byte (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Totals invariant on the provider-neutral path (after #7161)

**Precondition:** #7161 is merged (see Preconditions). This task **moves** #7161's logic; it does not re-derive it.

**Files:**
- Create: `apps/api/src/services/accounting/accountingInvoiceTotals.ts`, `apps/api/src/services/accounting/accountingInvoiceTotals.test.ts`
- Modify: wherever #7161 placed (a) the hidden-line zeroing, (b) the pre-push sum assertion, and (c) the `remoteTotal` comparison. Find them with the grep in Step 1. Expected locations: `buildLinePayload` / `buildInvoicePayload` in `accountingInvoicePush.ts` (~L622-660), and `computeTaxVariance` and its caller after `providerImpl.pushInvoice` (~L863).
- Move tests: #7161's tests for these three behaviours go to `accountingInvoiceTotals.test.ts` with **assertions unchanged**. Tests that exercise the full push flow stay where they are.

**Interfaces:**
- Produces:
  ```ts
  /** Hidden lines (customerVisible = false) are pushed at zero, so the pushed document equals what the customer was billed. */
  export function pushedLineAmounts(line: { customerVisible: boolean; unitPrice: string; lineTotal: string }): { unitPrice: string; lineTotal: string };
  /** Throws AccountingInvoicePushError('invoice_totals_mismatch', 409, …) unless Σ lines.lineTotal === subtotal (to the cent, in the invoice currency). */
  export function assertPushedTotalsMatch(payload: AccountingInvoicePayload): void;
  /** Post-push drift, integer minor units; null when the provider did not report that figure. */
  export function remoteTotalsVariance(payload: AccountingInvoicePayload, result: InvoicePushResult): { taxVarianceCents: number | null; totalVarianceCents: number | null };
  ```
  If #7161 already exported functions for these jobs under other names, **keep #7161's names** and re-export them from `accountingInvoiceTotals.ts` rather than renaming, so its tests move without edits. The contract is the behaviour, not the name.

- [ ] **Step 1: Locate #7161's implementation**

```bash
cd apps/api && grep -rn "invoice_totals_mismatch\|customerVisible\|remoteTotal" src/services/accounting --include='*.ts' | grep -v '\.test\.ts'
git log origin/main --oneline -- src/services/accounting | grep -i 7161
```

Expected: hits in `accountingInvoicePush.ts`, and possibly in `quickbooksProvider.ts`. **Any hit in `quickbooksProvider.ts` that does the zeroing, the sum assertion or the total comparison is exactly what this task moves out**, because a Xero provider must not have to re-implement it. A `TotalAmt` → `remoteTotal` parse in the provider stays there; that is wire mapping.

- [ ] **Step 2: Write the neutral-module tests** (these are new; move #7161's unit tests in beside them unchanged)

```ts
import { describe, expect, it } from 'vitest';
import { assertPushedTotalsMatch, pushedLineAmounts, remoteTotalsVariance } from './accountingInvoiceTotals';

const payload = (over: Partial<Record<string, unknown>> = {}) => ({
  invoiceId: 'i1', docNumber: 'INV-1', txnDate: '2026-09-01', dueDate: null, customerRef: { id: '1' },
  currencyCode: 'USD', subtotal: '100.00', taxTotal: '7.00', total: '107.00', mapping: null,
  lines: [
    { invoiceLineId: 'a', description: 'A', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', taxable: true },
    { invoiceLineId: 'b', description: 'B (hidden)', quantity: '1.00', unitPrice: '0.00', lineTotal: '0.00', taxable: true },
  ],
  ...over,
}) as any;

describe('accountingInvoiceTotals (provider-neutral, #7161 moved)', () => {
  it('a hidden priced line is pushed at zero', () => {
    expect(pushedLineAmounts({ customerVisible: false, unitPrice: '50.00', lineTotal: '50.00' })).toEqual({ unitPrice: '0.00', lineTotal: '0.00' });
    expect(pushedLineAmounts({ customerVisible: true, unitPrice: '50.00', lineTotal: '50.00' })).toEqual({ unitPrice: '50.00', lineTotal: '50.00' });
  });
  it('passes when the pushed lines sum to the subtotal', () => {
    expect(() => assertPushedTotalsMatch(payload())).not.toThrow();
  });
  it('refuses to push when they do not (invoice_totals_mismatch, 409)', () => {
    const bad = payload({ lines: [{ invoiceLineId: 'a', description: 'A', quantity: '1.00', unitPrice: '150.00', lineTotal: '150.00', taxable: true }] });
    expect(() => assertPushedTotalsMatch(bad)).toThrow(expect.objectContaining({ code: 'invoice_totals_mismatch', status: 409 }));
  });
  it('reports tax AND total variance in minor units', () => {
    expect(remoteTotalsVariance(payload(), { id: '9', remoteTaxTotal: '7.00', remoteTotal: '157.00' } as any))
      .toEqual({ taxVarianceCents: 0, totalVarianceCents: 5000 });
    expect(remoteTotalsVariance(payload(), { id: '9', remoteTaxTotal: null, remoteTotal: null } as any))
      .toEqual({ taxVarianceCents: null, totalVarianceCents: null });
  });
});
```

- [ ] **Step 3: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingInvoiceTotals.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 4: Implement by moving #7161's code**

```ts
// apps/api/src/services/accounting/accountingInvoiceTotals.ts
/**
 * Invoice totals invariant for EVERY provider (spec W01 "Invoice totals
 * invariant"; the fix itself is #7161). Breeze's computeInvoiceTotals excludes
 * customerVisible=false lines, so the accounting payload sends them at zero and
 * the pushed lines must sum to Breeze's subtotal; after a push both tax and total
 * are compared. Provider-neutral on purpose — a provider maps fields, it does not
 * decide what the customer was billed.
 */
import { toMinorUnits } from '@breeze/shared';
import { AccountingInvoicePushError } from './accountingInvoicePush';
import type { AccountingInvoicePayload, InvoicePushResult } from './types';

export function pushedLineAmounts(line: { customerVisible: boolean; unitPrice: string; lineTotal: string }): { unitPrice: string; lineTotal: string } {
  return line.customerVisible ? { unitPrice: line.unitPrice, lineTotal: line.lineTotal } : { unitPrice: '0.00', lineTotal: '0.00' };
}

export function assertPushedTotalsMatch(payload: AccountingInvoicePayload): void {
  const sum = payload.lines.reduce((acc, l) => acc + toMinorUnits(l.lineTotal, payload.currencyCode), 0);
  const subtotal = toMinorUnits(payload.subtotal, payload.currencyCode);
  if (sum !== subtotal) {
    throw new AccountingInvoicePushError(
      'invoice_totals_mismatch', 409,
      `The invoice lines being pushed total ${sum} but the invoice subtotal is ${subtotal} (minor units); not pushed`,
    );
  }
}

export function remoteTotalsVariance(
  payload: AccountingInvoicePayload,
  result: InvoicePushResult,
): { taxVarianceCents: number | null; totalVarianceCents: number | null } {
  const cur = payload.currencyCode;
  return {
    taxVarianceCents: result.remoteTaxTotal === null ? null : toMinorUnits(result.remoteTaxTotal, cur) - toMinorUnits(payload.taxTotal, cur),
    totalVarianceCents: result.remoteTotal === null ? null : toMinorUnits(result.remoteTotal, cur) - toMinorUnits(payload.total, cur),
  };
}
```

If #7161's error message text differs, **keep #7161's text**; its tests pin it. If `toMinorUnits`'s signature in `@breeze/shared` differs from `(amount: string, currency: string) => number`, adapt the call. The provider already uses it (`quickbooksProvider.ts` L2), so copy that usage.

The `AccountingInvoicePushError` import creates an `accountingInvoiceTotals` ↔ `accountingInvoicePush` cycle. If tsc or vitest reports it, move `AccountingInvoicePushError` and its code union into `accountingInvoicePushErrors.ts` and re-export it from `accountingInvoicePush.ts`, so existing imports do not change.

Then, in `accountingInvoicePush.ts`: `buildLinePayload` uses `pushedLineAmounts(line)`; `assertPushedTotalsMatch(payload)` runs right after `buildInvoicePayload` and **before** any provider call or remote write; and the post-push comparison uses `remoteTotalsVariance`. How a total variance is persisted (which `syncStatus`, which message) stays exactly as #7161 wrote it. Delete the originals from wherever Step 1 found them.

- [ ] **Step 5: Run and confirm everything passes**, including every #7161 test at its new or old location

```bash
cd apps/api && npx vitest run src/services/accounting && npx tsc --noEmit -p .
grep -rn "customerVisible\|invoice_totals_mismatch" src/services/accounting/quickbooksProvider.ts
```

Expected: PASS, tsc clean, and the grep prints nothing.

- [ ] **Step 6: Run the W01b verification** (the QBO unit set, the accounting integration set, and tsc). Then commit and open PR W01b (`Part of #<W01 sub-issue>`):

```bash
git add -A apps/api/src/services/accounting
git commit -m "refactor(accounting): totals invariant on the provider-neutral push path (#7161 moved, Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
# PR W01c — Rate limiting

### Task 12: The generic accounting rate limiter

**Files:**
- Create: `apps/api/src/services/accounting/accountingRateLimit.ts`, `apps/api/src/services/accounting/accountingRateLimit.test.ts`
- Create: `apps/api/src/__tests__/integration/accountingRateLimit.integration.test.ts` (real Redis; this proves the Lua scripts)

**Interfaces:**
- Consumes: `getRedis()` (`services/redis.ts`, returns `Redis | null`), `rateLimiter(redis, key, limit, windowSeconds, cost, { refundOnReject })` (`services/rate-limit.ts`), `runOutsideDbContext` (`db`), `AccountingProviderError` (Task 8), `RateLimitSpec` (Task 9). **No new Redis client.**
- Produces:
  ```ts
  export const RATE_LIMIT_FALLBACK_RETRY_MS = 5_000;
  export const BACKGROUND_DEFER_RATIO = 0.2;
  /** Acquire every slot the spec declares, run fn, release the concurrency slot. Throws AccountingProviderError{kind:'rate_limited', retryAfterMs} when any slot is refused. */
  export async function withProviderCallSlot<T>(provider: AccountingProviderId, spec: RateLimitSpec, connectionId: string, fn: () => Promise<T>): Promise<T>;
  /** Record a provider-reported "calls left today" (e.g. Xero X-DayLimit-Remaining, W02). */
  export async function noteDailyRemaining(provider: AccountingProviderId, connectionId: string, remaining: number): Promise<void>;
  /** 0..1 remaining fraction of today's budget, or null when the provider declares no daily budget. */
  export async function dailyBudgetRemainingRatio(provider: AccountingProviderId, spec: RateLimitSpec, connectionId: string): Promise<number | null>;
  /** True when background sweeps for this connection must wait (remaining below BACKGROUND_DEFER_RATIO). */
  export async function shouldDeferBackgroundWork(provider: AccountingProviderId, spec: RateLimitSpec, connectionId: string): Promise<boolean>;
  ```

**Failure policy (deliberate):**
- `getRedis()` returns null (Redis known down) → **fail open**: run the call, warn once per process. The provider's own 429 is the backstop, and pushes must not stop because the limiter's store is down (Review Focus 6).
- An error inside `rateLimiter()` → it fails **closed**, as all its callers do → `rate_limited` with `RATE_LIMIT_FALLBACK_RETRY_MS`. Jobs are delayed without consuming an attempt (Task 14); interactive routes get a 429.

Redis keys all share the `acct-rl:` prefix, which is what `rateLimiter`'s bucket label logs. They contain provider and connection ids only, no PII: `acct-rl:<provider>:conn:<id>`, `acct-rl:<provider>:app`, `acct-rl:<provider>:inflight:<id>`, `acct-rl:<provider>:day:<id>`, `acct-rl:<provider>:day-remaining:<id>`.

- [ ] **Step 1: Write the failing unit tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  redis: { eval: vi.fn(), incr: vi.fn(), pexpire: vi.fn(), pttl: vi.fn(), get: vi.fn(), set: vi.fn() } as any,
  redisOn: true,
  rateLimiter: vi.fn(),
}));
vi.mock('../redis', () => ({ getRedis: () => (m.redisOn ? m.redis : null) }));
vi.mock('../rate-limit', () => ({ rateLimiter: m.rateLimiter }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn() }));

import { withProviderCallSlot, shouldDeferBackgroundWork } from './accountingRateLimit';
import { AccountingProviderError } from './accountingProviderError';

const spec = {
  perConnection: { limit: 60, windowSeconds: 60 },
  maxConcurrentPerConnection: 5,
  appWide: { limit: 10_000, windowSeconds: 60 },
  dailyPerConnection: { limit: () => 1_000 },
};
const allowed = { allowed: true, remaining: 10, resetAt: new Date(Date.now() + 60_000) };

describe('withProviderCallSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.redisOn = true;
    m.rateLimiter.mockResolvedValue(allowed);
    m.redis.eval.mockResolvedValue(1);  // concurrency slot granted / released
    m.redis.incr.mockResolvedValue(1);  // first call of the day
    m.redis.pttl.mockResolvedValue(86_400_000);
  });

  it('runs the call and releases the concurrency slot', async () => {
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'ok')).resolves.toBe('ok');
    expect(m.rateLimiter).toHaveBeenCalledWith(m.redis, 'acct-rl:xero:conn:c1', 60, 60, 1, { refundOnReject: true });
    expect(m.rateLimiter).toHaveBeenCalledWith(m.redis, 'acct-rl:xero:app', 10_000, 60, 1, { refundOnReject: true });
    expect(m.redis.eval).toHaveBeenCalledTimes(2); // acquire + release
  });

  it('refuses with rate_limited and the window reset as retryAfterMs', async () => {
    m.rateLimiter.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 12_000) });
    const err = await withProviderCallSlot('xero', spec, 'c1', async () => 'never').catch((e) => e);
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterMs).toBeGreaterThan(10_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(12_000);
  });

  it('refuses when the concurrency cap is reached, without running the call', async () => {
    m.redis.eval.mockResolvedValueOnce(0);
    const fn = vi.fn();
    await expect(withProviderCallSlot('xero', spec, 'c1', fn)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses when today\'s budget is spent, retrying when the day window ends', async () => {
    m.redis.incr.mockResolvedValueOnce(1_001);
    m.redis.pttl.mockResolvedValueOnce(3_600_000);
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'x')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3_600_000 });
  });

  it('releases the concurrency slot even when the call throws', async () => {
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(m.redis.eval).toHaveBeenCalledTimes(2);
  });

  it('fails OPEN when Redis is unavailable', async () => {
    m.redisOn = false;
    await expect(withProviderCallSlot('xero', spec, 'c1', async () => 'ok')).resolves.toBe('ok');
    expect(m.rateLimiter).not.toHaveBeenCalled();
  });

  it('QuickBooks-shaped spec (no app-wide, no daily) makes exactly one window check', async () => {
    const qbo = { perConnection: { limit: 500, windowSeconds: 60 }, maxConcurrentPerConnection: 10, appWide: null, dailyPerConnection: null };
    await withProviderCallSlot('quickbooks', qbo, 'c1', async () => 'ok');
    expect(m.rateLimiter).toHaveBeenCalledTimes(1);
    expect(m.redis.incr).not.toHaveBeenCalled();
  });
});

describe('shouldDeferBackgroundWork (tier-aware daily budget hook)', () => {
  beforeEach(() => { vi.clearAllMocks(); m.redisOn = true; });
  it('defers background work below 20% of the daily budget', async () => {
    m.redis.get.mockImplementation(async (k: string) => (k.endsWith(':day-remaining:c1') ? '150' : '0'));
    await expect(shouldDeferBackgroundWork('xero', spec, 'c1')).resolves.toBe(true);
  });
  it('does not defer above it', async () => {
    m.redis.get.mockImplementation(async (k: string) => (k.endsWith(':day-remaining:c1') ? '900' : '0'));
    await expect(shouldDeferBackgroundWork('xero', spec, 'c1')).resolves.toBe(false);
  });
  it('never defers for a provider with no daily budget', async () => {
    await expect(shouldDeferBackgroundWork('quickbooks', { ...spec, dailyPerConnection: null }, 'c1')).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingRateLimit.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/accounting/accountingRateLimit.ts
/**
 * Accounting provider call limiter (spec W01 "Rate limiting"): a per-connection
 * sliding window, an optional per-connection concurrency cap, an optional
 * per-provider app-wide window, and an optional daily budget — all specified by
 * `provider.limits.rate`, all on the shared Redis client (`getRedis`) and the
 * shared sliding-window helper (`rateLimiter`). Providers wrap every outbound
 * API call in `withProviderCallSlot`; a refusal is an
 * AccountingProviderError{kind:'rate_limited'} that the workers turn into a
 * delayed retry that consumes no attempt (jobs/accountingJobDelay.ts).
 */
import type Redis from 'ioredis';
import { getRedis } from '../redis';
import { rateLimiter } from '../rate-limit';
import { runOutsideDbContext } from '../../db';
import { AccountingProviderError } from './accountingProviderError';
import type { AccountingProviderId, RateLimitSpec } from './types';

export const RATE_LIMIT_FALLBACK_RETRY_MS = 5_000;
export const BACKGROUND_DEFER_RATIO = 0.2;
const DAY_MS = 24 * 60 * 60 * 1000;
const INFLIGHT_TTL_MS = 120_000; // self-heals a slot a crashed process never released

// KEYS[1] = counter, ARGV[1] = cap, ARGV[2] = ttl ms. 1 = acquired, 0 = refused.
const ACQUIRE_LUA = `
local v = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if v > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1`;
// Never below zero: a release after the TTL reset must not bank a negative slot.
const RELEASE_LUA = `
local v = redis.call('DECR', KEYS[1])
if v < 0 then redis.call('SET', KEYS[1], 0, 'PX', ARGV[1]) end
return v`;

let warnedRedisDown = false;

function refused(provider: AccountingProviderId, what: string, retryAfterMs: number): AccountingProviderError {
  return new AccountingProviderError({
    kind: 'rate_limited', provider, operation: `accounting call slot (${what})`,
    message: `Accounting provider rate limit reached (${what}); retrying automatically`,
    retryAfterMs: Math.max(1_000, Math.ceil(retryAfterMs)),
  });
}

async function checkWindow(redis: Redis, provider: AccountingProviderId, key: string, limit: number, windowSeconds: number, what: string): Promise<void> {
  const result = await rateLimiter(redis, key, limit, windowSeconds, 1, { refundOnReject: true });
  if (!result.allowed) {
    const wait = result.resetAt.getTime() - Date.now();
    throw refused(provider, what, wait > 0 ? wait : RATE_LIMIT_FALLBACK_RETRY_MS);
  }
}

async function checkDaily(redis: Redis, provider: AccountingProviderId, spec: RateLimitSpec, connectionId: string): Promise<void> {
  if (!spec.dailyPerConnection) return;
  const key = `acct-rl:${provider}:day:${connectionId}`;
  const used = await redis.incr(key);
  if (used === 1) await redis.pexpire(key, DAY_MS);
  if (used > spec.dailyPerConnection.limit()) {
    const ttl = await redis.pttl(key);
    throw refused(provider, 'daily budget', ttl > 0 ? ttl : DAY_MS);
  }
}

export async function withProviderCallSlot<T>(
  provider: AccountingProviderId,
  spec: RateLimitSpec,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const redis = getRedis();
  if (!redis) {
    if (!warnedRedisDown) {
      warnedRedisDown = true;
      console.warn('[accountingRateLimit] Redis unavailable; accounting calls are not locally rate limited (provider 429s still apply)');
    }
    return fn();
  }

  const inflightKey = `acct-rl:${provider}:inflight:${connectionId}`;
  await runOutsideDbContext(async () => {
    await checkWindow(redis, provider, `acct-rl:${provider}:conn:${connectionId}`, spec.perConnection.limit, spec.perConnection.windowSeconds, 'per connection');
    if (spec.appWide) {
      await checkWindow(redis, provider, `acct-rl:${provider}:app`, spec.appWide.limit, spec.appWide.windowSeconds, 'app-wide');
    }
    await checkDaily(redis, provider, spec, connectionId);
    if (spec.maxConcurrentPerConnection !== null) {
      const ok = await redis.eval(ACQUIRE_LUA, 1, inflightKey, spec.maxConcurrentPerConnection, INFLIGHT_TTL_MS);
      if (Number(ok) !== 1) throw refused(provider, 'concurrency', 2_000);
    }
  });

  try {
    return await fn();
  } finally {
    if (spec.maxConcurrentPerConnection !== null) {
      try {
        await runOutsideDbContext(() => redis.eval(RELEASE_LUA, 1, inflightKey, INFLIGHT_TTL_MS));
      } catch (err) {
        // The TTL self-heals a missed release; never let it replace fn's outcome.
        console.error('[accountingRateLimit] concurrency release failed', err instanceof Error ? err.message : err);
      }
    }
  }
}

export async function noteDailyRemaining(provider: AccountingProviderId, connectionId: string, remaining: number): Promise<void> {
  const redis = getRedis();
  if (!redis || !Number.isFinite(remaining)) return;
  await runOutsideDbContext(() => redis.set(`acct-rl:${provider}:day-remaining:${connectionId}`, String(Math.max(0, Math.floor(remaining))), 'PX', DAY_MS));
}

export async function dailyBudgetRemainingRatio(provider: AccountingProviderId, spec: RateLimitSpec, connectionId: string): Promise<number | null> {
  if (!spec.dailyPerConnection) return null;
  const redis = getRedis();
  if (!redis) return null;
  const limit = spec.dailyPerConnection.limit();
  if (limit <= 0) return 0;
  const [reported, used] = await runOutsideDbContext(() => Promise.all([
    redis.get(`acct-rl:${provider}:day-remaining:${connectionId}`),
    redis.get(`acct-rl:${provider}:day:${connectionId}`),
  ]));
  const fromCounter = (limit - Number(used ?? 0)) / limit;
  const fromHeader = reported === null ? 1 : Number(reported) / limit;
  return Math.max(0, Math.min(fromCounter, fromHeader, 1));
}

export async function shouldDeferBackgroundWork(provider: AccountingProviderId, spec: RateLimitSpec, connectionId: string): Promise<boolean> {
  const ratio = await dailyBudgetRemainingRatio(provider, spec, connectionId);
  return ratio !== null && ratio < BACKGROUND_DEFER_RATIO;
}
```

- [ ] **Step 4: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingRateLimit.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Real-Redis proof of the Lua scripts** (`src/__tests__/integration/accountingRateLimit.integration.test.ts`)

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { withProviderCallSlot } from '../../services/accounting/accountingRateLimit';

const RUN = !!process.env.REDIS_URL;
const spec = { perConnection: { limit: 1000, windowSeconds: 60 }, maxConcurrentPerConnection: 2, appWide: null, dailyPerConnection: null };

describe.skipIf(!RUN)('accountingRateLimit against real Redis', () => {
  it('admits at most maxConcurrentPerConnection concurrent calls and frees slots afterwards', async () => {
    const conn = `it-${Date.now()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = withProviderCallSlot('xero', spec, conn, () => gate);
    const b = withProviderCallSlot('xero', spec, conn, () => gate);
    await new Promise((r) => setTimeout(r, 50));
    await expect(withProviderCallSlot('xero', spec, conn, async () => 'third')).rejects.toMatchObject({ kind: 'rate_limited' });
    release();
    await Promise.all([a, b]);
    await expect(withProviderCallSlot('xero', spec, conn, async () => 'after')).resolves.toBe('after');
  });
});
```

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingRateLimit.integration.test.ts
```

Expected: PASS (it needs `pnpm test-stack up`, which writes `REDIS_URL` into `.env.test`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/accounting/accountingRateLimit.ts apps/api/src/services/accounting/accountingRateLimit.test.ts apps/api/src/__tests__/integration/accountingRateLimit.integration.test.ts
git commit -m "feat(accounting): generic per-connection/app-wide/concurrency/daily accounting rate limiter (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: QuickBooks calls go through the limiter; 429 becomes `rate_limited`

**Files:**
- Modify: `apps/api/src/services/accounting/quickbooksProvider.ts`: `qboRequest` (the private request helper, ~L1210-1265)
- Modify: `apps/api/src/services/accounting/quickbooksFault.ts`: `classifyQbo` (a 429 row) and `qboErrorToProviderError` (carry `retryAfterMs`)
- Test: `quickbooksProvider.test.ts` (**mock wiring only**: add the passthrough mock below), `accountingProviderError.test.ts` (flip the 429 row), `quickbooksIdempotency.test.ts` (it already has the passthrough)

**Interfaces:**
- Consumes: `withProviderCallSlot` (Task 12), `this.limits.rate` (Task 9).
- Produces: QBO 429 → `AccountingProviderError{ kind: 'rate_limited', retryAfterMs }`. `retryAfterMs` comes from `Retry-After` (seconds, or an HTTP date) and defaults to `60_000` when the header is absent.

- [ ] **Step 1: Write the failing tests**

In `quickbooksProvider.test.ts`, first add the mock-wiring edit, next to the existing `vi.mock('../sentry', …)`:

```ts
const { slotMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./accountingRateLimit', () => ({ withProviderCallSlot: slotMock }));
```

Then append:

```ts
describe('rate limiting (Xero W01)', () => {
  it('every API call goes through the connection\'s call slot with the QBO limits', async () => {
    mockFetchJsonOnce({ QueryResponse: { Customer: [] } });
    await quickbooksProvider.listRemoteCustomers(conn());
    expect(slotMock).toHaveBeenCalledWith('quickbooks', quickbooksProvider.limits.rate, 'c1', expect.any(Function));
  });

  it('a 429 is rate_limited with Retry-After honoured', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }));
    const err = await quickbooksProvider.listRemoteCustomers(conn()).catch((e) => e);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000, status: 429 });
  });

  it('a 429 without Retry-After waits 60s', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const err = await quickbooksProvider.listRemoteCustomers(conn()).catch((e) => e);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
  });
});
```

In `accountingProviderError.test.ts`, change the row `[raw({ status: 429 }), 'transient']` to `[raw({ status: 429 }), 'rate_limited']`.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/quickbooksProvider.test.ts -t "rate limiting" src/services/accounting/accountingProviderError.test.ts
```

Expected: FAIL. `slotMock` is not called, and the 429 is classified `transient`.

- [ ] **Step 3: Implement**

`quickbooksFault.ts`: in `classifyQbo`, add `if (status === 429) return 'rate_limited';` as the first line after the `reauth` check. In `qboErrorToProviderError`, pass `retryAfterMs: typeof e.retryAfterMs === 'number' ? e.retryAfterMs : (status === 429 ? 60_000 : undefined)`.

`quickbooksProvider.ts`, in `qboRequest`, wrap the existing fetch-and-parse body and attach `retryAfterMs` on a 429:

```ts
  private async qboRequest<T>(conn: AccountingConnection, path: string, operation: string, init: RequestInit = {}): Promise<T> {
    return withProviderCallSlot('quickbooks', this.limits.rate, conn.id, async () => {
      // … existing body up to `if (!response.ok) {` unchanged …
      if (!response.ok) {
        const error = new Error(`${operation} failed with ${response.status}`);
        const fault = parseQboFault(text);
        Object.assign(error, {
          status: response.status,
          body: text.slice(0, 500),
          qboFaultCode: fault.code ?? undefined,
          qboFaultMessage: fault.message ?? undefined,
          qboPaymentLinked: fault.paymentLinked === true ? true : undefined,
          // Xero W01: throttling is a delay, not a failure. Intuit usually omits
          // Retry-After on 429; 60s is its documented throttle window.
          retryAfterMs: response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after')) ?? 60_000 : undefined,
        });
        // … existing console.error + throw unchanged …
      }
      // … existing JSON parse unchanged …
    });
  }
```

with a module-level helper:

```ts
/** `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
```

Leave `requestTokens` (the token endpoint) outside the slot. It is not realm-scoped, and a throttled refresh is already retried by `accountingTokens`.

Find every other test that exercises the **real** provider and give it the same passthrough mock:

```bash
cd apps/api && grep -rln "from './quickbooksProvider'\|services/accounting/quickbooksProvider'" src --include='*.test.ts'
```

- [ ] **Step 4: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting && npx tsc --noEmit -p .
```

Expected: PASS. Every pre-existing provider assertion is unchanged; the slot is a passthrough in these tests.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api/src/services/accounting
git commit -m "feat(accounting): QuickBooks calls take a rate-limit slot; 429 is rate_limited with Retry-After (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `rate_limited` re-queues without consuming an attempt (coordinators, workers, routes, sweeps)

**Files:**
- Create: `apps/api/src/jobs/accountingJobDelay.ts`, `apps/api/src/jobs/accountingJobDelay.test.ts`
- Modify: `accountingInvoicePush.ts`: the `AccountingInvoicePushError` constructor (add `retryAfterMs`, and status `429`), the push and void catches, `translateNestedSyncError`
- Modify: `accountingPaymentPush.ts`: the `AccountingPaymentPushError` constructor, the `createPayment` catch (~L1676), the delete catch (~L2040), `markPaymentMappingErrorInOwnContext` (accept `countAttempt`)
- Modify: `accountingMappingService.ts`: the `AccountingMappingError` constructor, `callProviderOrThrow`
- Modify: `apps/api/src/jobs/accountingSyncWorker.ts`: `processAccountingSyncJob(data, ctx?)`, `processPaymentJob`, `createAccountingSyncWorker`
- Modify: `apps/api/src/jobs/accountingReconcileWorker.ts`: `processReconcileConnectionJob(data, ctx?)`, `processReconcileSweep` (budget deferral), `createAccountingReconcileWorker`
- Modify: `apps/api/src/routes/accounting/index.ts`: `handleInvoicePushError` and `handleMappingError` set `Retry-After`
- Test: `accountingSyncWorker.test.ts`, `accountingReconcileWorker.test.ts`, `accountingPaymentPush.test.ts`, `accountingInvoicePush.test.ts`, `routes/accounting/invoicePush.test.ts`

**Interfaces:**
- Consumes: `AccountingProviderError` kind `'rate_limited'` (Tasks 8, 13), `shouldDeferBackgroundWork` (Task 12).
- Produces:
  ```ts
  // jobs/accountingJobDelay.ts
  export const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
  export const MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1000;
  export interface AccountingJobContext { job?: Job; token?: string }
  export function rateLimitRetryAfterMs(err: unknown): number | null;              // null = not a rate limit
  /** moveToDelayed(now + retryAfter, token) + throw DelayedError; without job/token rethrows err (normal retry). */
  export async function delayJobForRateLimit(ctx: AccountingJobContext | undefined, err: unknown, retryAfterMs: number): Promise<never>;
  // coordinator errors
  new AccountingInvoicePushError('rate_limited', 429, message, { retryAfterMs })   // same shape for AccountingPaymentPushError / AccountingMappingError
  // workers
  export async function processAccountingSyncJob(data: AccountingSyncJobData, ctx?: AccountingJobContext): Promise<void>;
  export async function processReconcileConnectionJob(data: ReconcileConnectionJobData, ctx?: AccountingJobContext): Promise<ReconcileRunSummary | null>;
  ```

- [ ] **Step 1: Write the failing tests**

`accountingJobDelay.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('bullmq', () => ({
  DelayedError: class DelayedError extends Error { constructor() { super('bullmq:movedToDelayed'); this.name = 'DelayedError'; } },
}));
import { delayJobForRateLimit, rateLimitRetryAfterMs, MAX_RATE_LIMIT_DELAY_MS } from './accountingJobDelay';
import { AccountingProviderError } from '../services/accounting/accountingProviderError';

describe('accountingJobDelay', () => {
  it('recognises provider and coordinator rate limits', () => {
    expect(rateLimitRetryAfterMs(new AccountingProviderError({ kind: 'rate_limited', provider: 'quickbooks', operation: 'x', retryAfterMs: 30_000 }))).toBe(30_000);
    expect(rateLimitRetryAfterMs(Object.assign(new Error('x'), { code: 'rate_limited', retryAfterMs: 5_000 }))).toBe(5_000);
    expect(rateLimitRetryAfterMs(Object.assign(new Error('x'), { code: 'provider_error' }))).toBeNull();
  });

  it('moves the job to delayed WITHOUT consuming an attempt', async () => {
    const job = { moveToDelayed: vi.fn(async () => undefined), attemptsMade: 2 };
    const before = Date.now();
    await expect(delayJobForRateLimit({ job: job as any, token: 'tok' }, new Error('x'), 30_000)).rejects.toMatchObject({ name: 'DelayedError' });
    const [ts, token] = job.moveToDelayed.mock.calls[0]!;
    expect(token).toBe('tok');
    expect(ts).toBeGreaterThanOrEqual(before + 30_000);
    expect(job.attemptsMade).toBe(2);
  });

  it('clamps an absurd Retry-After to 24h', async () => {
    const job = { moveToDelayed: vi.fn(async () => undefined) };
    await delayJobForRateLimit({ job: job as any, token: 't' }, new Error('x'), 10 * MAX_RATE_LIMIT_DELAY_MS).catch(() => undefined);
    expect(job.moveToDelayed.mock.calls[0]![0]).toBeLessThanOrEqual(Date.now() + MAX_RATE_LIMIT_DELAY_MS);
  });

  it('without a lock token, rethrows so the normal retry ladder applies (logged)', async () => {
    const err = new Error('throttled');
    await expect(delayJobForRateLimit(undefined, err, 1_000)).rejects.toBe(err);
  });
});
```

Append to `accountingPaymentPush.test.ts` (Review Focus 5):

```ts
it('a 429 during payment create keeps the push owed, releases the lease, and does NOT count an attempt', async () => {
  createPaymentMock.mockRejectedValueOnce(new AccountingProviderError({
    kind: 'rate_limited', provider: 'quickbooks', operation: 'QuickBooks payment create', httpStatus: 429, retryAfterMs: 30_000,
  }));
  const before = mapping()!.syncAttempts;

  const err = await pushPaymentToAccounting(MAPPING, PARTNER, runCtx).catch((e) => e);

  expect(err).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 30_000 });
  expect(mapping()!.pendingOp).toBe('push');
  expect(mapping()!.claimedAt).toBeNull();
  expect(mapping()!.syncAttempts).toBe(before);
  expect(mapping()!.terminalReason ?? null).toBeNull();
  expect(mapping()!.lastError).toBe('QuickBooks is rate limiting requests; retrying automatically');
});
```

(`mapping()`, `MAPPING`, `PARTNER`, `runCtx` and `createPaymentMock` are that file's existing fixtures. Use whatever the file calls them.)

Append to `accountingSyncWorker.test.ts`:

```ts
it('a rate-limited payment job is delayed, not failed (Review Focus 5)', async () => {
  getConnectionMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'connected', pushMode: 'auto', pushPayments: true });
  pushPaymentToAccountingMock.mockRejectedValue(new AccountingPaymentPushError('rate_limited', 429, 'throttled', { retryAfterMs: 30_000 }));
  const job = { moveToDelayed: vi.fn(async () => undefined) };
  await expect(processAccountingSyncJob({ type: 'push-payment', mappingId: 'm1', partnerId: 'p1' }, { job: job as any, token: 't' }))
    .rejects.toMatchObject({ name: 'DelayedError' });
  expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 't');
});
```

(Add a `DelayedError` class to this file's `vi.mock('bullmq', …)` factory, exactly as in `accountingJobDelay.test.ts`.)

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/jobs/accountingJobDelay.test.ts src/jobs/accountingSyncWorker.test.ts src/services/accounting/accountingPaymentPush.test.ts
```

Expected: FAIL (module missing; `retryAfterMs` not accepted; attempt counted).

- [ ] **Step 3: Implement `accountingJobDelay.ts`**

```ts
/**
 * Throttling is a delay, not a failure (spec W01 "Rate limiting"): a job refused
 * by the limiter or by a provider 429 goes back to `delayed` at Retry-After and
 * keeps its attempt budget — same mechanism as scriptReviewWorker's concurrency
 * cap (moveToDelayed + DelayedError; BullMQ passes skipAttempt for it).
 */
import { DelayedError, type Job } from 'bullmq';
import { isAccountingProviderError } from '../services/accounting/accountingProviderError';

export const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
export const MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1000;

export interface AccountingJobContext { job?: Job; token?: string }

export function rateLimitRetryAfterMs(err: unknown): number | null {
  if (isAccountingProviderError(err)) {
    return err.kind === 'rate_limited' ? err.retryAfterMs ?? DEFAULT_RATE_LIMIT_DELAY_MS : null;
  }
  const e = err && typeof err === 'object' ? err as { code?: unknown; retryAfterMs?: unknown } : null;
  if (e?.code !== 'rate_limited') return null;
  return typeof e.retryAfterMs === 'number' ? e.retryAfterMs : DEFAULT_RATE_LIMIT_DELAY_MS;
}

export async function delayJobForRateLimit(ctx: AccountingJobContext | undefined, err: unknown, retryAfterMs: number): Promise<never> {
  if (!ctx?.job || !ctx.token) {
    console.error('[accountingJobDelay] cannot delay a rate-limited job without its lock token; falling back to a normal retry');
    throw err;
  }
  const delay = Math.min(Math.max(retryAfterMs, 1_000), MAX_RATE_LIMIT_DELAY_MS);
  await ctx.job.moveToDelayed(Date.now() + delay, ctx.token);
  throw new DelayedError();
}
```

- [ ] **Step 4: Coordinators**

Give each of the three error classes the same optional fourth argument:

```ts
export class AccountingInvoicePushError extends Error {
  readonly retryAfterMs?: number;
  constructor(
    public readonly code: AccountingInvoicePushErrorCode,
    public readonly status: 404 | 409 | 429 | 502,
    message: string,
    opts: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'AccountingInvoicePushError';
    this.retryAfterMs = opts.retryAfterMs;
  }
}
```

Add `'rate_limited'` to the three code unions. **It must not be added to any `*TERMINAL_CODES` set.**

In the invoice `pushInvoice` / `voidInvoice` catches, before the generic path:

```ts
    const throttleMs = providerErrorKindOf(err) === 'rate_limited' ? (err as AccountingProviderError).retryAfterMs ?? 60_000 : null;
    if (throttleMs !== null) {
      // Nothing was accepted remotely: the mapping stays exactly as claimed
      // (pending), no error marker, no Sentry. The job is delayed (accountingJobDelay).
      throw new AccountingInvoicePushError('rate_limited', 429,
        `${accountingProviderDisplayName(conn.provider)} is rate limiting requests; retrying automatically`, { retryAfterMs: throttleMs });
    }
```

`translateNestedSyncError`: `if (err.code === 'rate_limited') throw new AccountingInvoicePushError('rate_limited', 429, err.message, { retryAfterMs: err.retryAfterMs });`

In the payment `createPayment` catch and the delete catch:

```ts
    if (providerErrorKindOf(err) === 'rate_limited') {
      const message = `${label} is rate limiting requests; retrying automatically`;
      // Review Focus 5: keep pending_op, RELEASE the lease (a held 10-minute lease
      // would block the delayed retry), and do NOT count toward
      // PAYMENT_PUSH_MAX_ATTEMPTS — throttling must never retire a real push.
      await markPaymentMappingErrorInOwnContext(runInDbContext, mappingId, partnerId, message, { clearPendingOp: false, countAttempt: 'never' });
      throw new AccountingPaymentPushError('rate_limited', 429, message, { retryAfterMs: (err as AccountingProviderError).retryAfterMs });
    }
```

Widen `markPaymentMappingErrorInOwnContext`'s `opts` to `{ clearPendingOp: boolean; countAttempt?: 'always' | 'never' }` and pass it through. `markPaymentMappingError` already supports it.

`callProviderOrThrow` (mapping service): rethrow a rate limit as `new AccountingMappingError('rate_limited', 429, err.message, { retryAfterMs: err.retryAfterMs })` before the generic `'provider_error'`.

- [ ] **Step 5: Workers**

`accountingSyncWorker.ts`: add `ctx?: AccountingJobContext` to `processAccountingSyncJob` and pass it to `processPaymentJob`. In each branch's catch (sync-mapping, invoice, payment), first:

```ts
      const throttleMs = rateLimitRetryAfterMs(err);
      if (throttleMs !== null) return delayJobForRateLimit(ctx, err, throttleMs);
```

Change the worker factory to pass the token:

```ts
    async (job: Job<AccountingSyncJobData>, token?: string) => processAccountingSyncJob(job.data, { job, token }),
```

Make the same change in `accountingReconcileWorker.ts`: `processReconcileConnectionJob(data, ctx?)` wraps `provider.reconcileChanges` and `resolveConnectionAndToken` in a try whose catch delays on `rateLimitRetryAfterMs(err) !== null`. The factory passes `(job, token)`.

Daily-budget deferral in `processReconcileSweep` pass 1:

```ts
    for (const connection of connections) {
      const provider = findAccountingProvider(connection.provider);
      if (provider && await shouldDeferBackgroundWork(connection.provider, provider.limits.rate, connection.id)) {
        deferred++;
        continue;
      }
      if (await enqueueAccountingReconcile(connection.id, connection.partnerId, 'sweep')) enqueued++;
      else failed++;
    }
```

Add `deferred` to the sweep's return object and its log line. Apply the same guard per row in `processMappingSweep` (Task 5 already selects `provider` and `integrationId`). For QuickBooks, `dailyPerConnection` is null, so this never defers. The guard exists for W02.

- [ ] **Step 6: Routes answer 429 with `Retry-After`**

In `routes/accounting/index.ts`, `handleInvoicePushError` and `handleMappingError`:

```ts
  if (err instanceof AccountingInvoicePushError) {
    if (err.retryAfterMs !== undefined) c.header('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
    return c.json({ error: err.message, code: err.code }, err.status);
  }
```

(Widen the `c` parameter type to `Context` so `header` is available.) Test in `invoicePush.test.ts`:

```ts
it('a throttled manual push answers 429 with Retry-After', async () => {
  pushInvoiceToAccountingMock.mockRejectedValue(new AccountingInvoicePushError('rate_limited', 429, 'QuickBooks is rate limiting requests; retrying automatically', { retryAfterMs: 30_000 }));
  const res = await app.request(`/accounting/quickbooks/invoices/${INVOICE_ID}/push`, { method: 'POST', headers: authHeaders });
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('30');
  expect(await res.json()).toMatchObject({ code: 'rate_limited' });
});
```

- [ ] **Step 7: Run and confirm everything passes**

```bash
cd apps/api && npx vitest run src/jobs src/services/accounting src/routes/accounting && npx tsc --noEmit -p .
```

Expected: PASS and tsc clean. Then run the full W01c verification (the QBO unit set, the accounting integration set).

- [ ] **Step 8: Commit and open PR W01c**

```bash
git add -A apps/api/src
git commit -m "feat(accounting): throttled accounting jobs re-queue at Retry-After without consuming an attempt (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The PR body states preamble item 10 (the one deliberate QBO behaviour change).

---
# PR W01d — API and web surface, import rename, guard

### Task 15: Routes: provider enum, capability gate, explicit config errors, provider in OAuth state, `GET /accounting/providers`

**Files:**
- Create: `apps/api/src/routes/accounting/providerGate.ts`, `apps/api/src/routes/accounting/providerGate.test.ts`
- Modify: `apps/api/src/routes/accounting/index.ts`: `providerParamSchema` / `invoicePushParamSchema` (~L146, ~L195), `validateProviderConfig` (~L433, deleted), `AccountingStatePayload` / `createState` / `verifyState` (~L343-384), `/:provider/connect` (~L446), `/:provider/callback` (~L472-687), every other `/:provider/*` handler, and the QBO env import (~L14, deleted)
- Test: `routes/accounting/index.test.ts`, `invoicePush.test.ts`, `permissions.test.ts`, `partnerAuthority.test.ts`, `owedOperations.test.ts`, `reconcile.test.ts`, `mappings.test.ts`, `customers.test.ts` (mock wiring only), plus the new `providerGate.test.ts`

**Interfaces:**
- Consumes: `findAccountingProvider`, `providerSupports`, `accountingProviderDisplayName`, `listRegisteredAccountingProviders`, `LEGACY_UNTARGETED_JOB_PROVIDER` (Task 3); `provider.configError()` and `provider.connectEnvironment()` (Task 9); `AccountingProviderConflictError`, `resolveActiveConnection` (Task 2).
- Produces:
  ```ts
  // routes/accounting/providerGate.ts
  /** Replaces validateProviderConfig. null = proceed; otherwise the response to return. */
  export function providerGateResponse(c: Context, provider: AccountingProviderId, capability: AccountingCapability): Response | null;
  //   unregistered or capability false → 409 { error, code: 'capability_unavailable' }
  //   registered + capable but provider.configError() → 400 { error: <configError>, code: 'provider_not_configured' }
  export function listProvidersHandler(c: Context): Promise<Response>;   // GET /accounting/providers
  // GET /accounting/providers → 200
  //   { data: Array<{ id: AccountingProviderId; displayName: string; configured: boolean; capabilities: AccountingCapabilities }>,
  //     activeConnection: { provider: AccountingProviderId; status: AccountingConnectionStatus } | null }
  ```
- OAuth state payload gains `provider: AccountingProviderId`. A state minted by the pre-W01 image (no `provider`, valid for 10 minutes across a deploy) is read as `LEGACY_UNTARGETED_JOB_PROVIDER`.

The capability check lives **inside** each handler (as a call to `providerGateResponse`) rather than as another middleware. The customer-import route's chain is already at Hono's variadic type-inference limit (`routes/accounting/index.ts` ~L105-110 documents this), and a tenth handler turns `c.req.valid(...)` into `never`.

**Route → capability map** (the one used everywhere):

| Route | Capability |
|---|---|
| `GET /:provider`, `GET /:provider/connect`, `GET /:provider/callback`, `POST /:provider/disconnect`, `PATCH /:provider/settings`, `POST /:provider/settings/refresh` | `connect` |
| `GET /:provider/customers`, `POST /:provider/customers/import` | `customerImport` |
| `GET\|PUT /:provider/mappings`, `POST /:provider/mappings/sync`, `GET /:provider/income-accounts`, `GET /:provider/remote-candidates` | `mapping` |
| `POST /:provider/invoices/:invoiceId/push`, `POST /:provider/invoices/push-bulk` | `invoicePush` |
| `POST /:provider/reconcile` | `paymentPull` |
| `GET /:provider/owed-operations` | `paymentPush` |

- [ ] **Step 1: Write the failing tests**

`providerGate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const reg = vi.hoisted(() => ({
  qbo: { provider: 'quickbooks', displayName: 'QuickBooks', configError: vi.fn(() => null),
    capabilities: { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true } },
}));
vi.mock('../../services/accounting/providerRegistry', () => ({
  findAccountingProvider: (id: string) => (id === 'quickbooks' ? reg.qbo : null),
  providerSupports: (id: string, cap: string) => id === 'quickbooks' && (reg.qbo.capabilities as any)[cap] === true,
  accountingProviderDisplayName: (id: string) => (id === 'xero' ? 'Xero' : 'QuickBooks'),
  listRegisteredAccountingProviders: () => [reg.qbo],
}));
import { providerGateResponse } from './providerGate';

function run(provider: 'quickbooks' | 'xero', cap: 'connect' | 'invoicePush') {
  const app = new Hono();
  app.get('/', (c) => providerGateResponse(c, provider, cap) ?? c.json({ ok: true }));
  return app.request('/');
}

describe('providerGateResponse', () => {
  it('lets a registered, capable, configured provider through', async () => {
    expect((await run('quickbooks', 'connect')).status).toBe(200);
  });
  it('refuses an unregistered provider with 409 capability_unavailable', async () => {
    const res = await run('xero', 'connect');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Xero is not available on this instance yet', code: 'capability_unavailable' });
  });
  it('refuses a missing capability with 409 capability_unavailable', async () => {
    (reg.qbo.capabilities as any).invoicePush = false;
    const res = await run('quickbooks', 'invoicePush');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('capability_unavailable');
    (reg.qbo.capabilities as any).invoicePush = true;
  });
  it('returns the provider\'s own explicit config error as 400', async () => {
    reg.qbo.configError.mockReturnValueOnce('QuickBooks OAuth is not configured on this instance');
    const res = await run('quickbooks', 'connect');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'QuickBooks OAuth is not configured on this instance', code: 'provider_not_configured' });
  });
});
```

Append to `routes/accounting/index.test.ts`, using its existing app, auth and cookie helpers:

```ts
describe('provider generalisation (Xero W01)', () => {
  it('accepts xero in the URL but refuses it via the registry (409 capability_unavailable)', async () => {
    const res = await request('GET', '/accounting/xero/connect');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('capability_unavailable');
  });

  it('refuses connect with 409 accounting_provider_conflict when another provider is active', async () => {
    resolveActiveConnectionMock.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'disconnected' });
    const res = await request('GET', '/accounting/quickbooks/connect');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'accounting_provider_conflict', error: 'Disconnect Xero before connecting QuickBooks' });
  });

  it('records the provider in the OAuth state and rejects a state minted for another provider', async () => {
    const { state, cookie } = await startConnect('quickbooks'); // existing helper that calls /connect and reads the state out of authUrl
    const payload = JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString('utf8'));
    expect(payload.provider).toBe('quickbooks');
    const res = await request('GET', `/accounting/xero/callback?code=c&realmId=r&state=${state}`, { cookie });
    expect(res.status).toBe(409); // xero is refused by the registry gate before state checks run
  });

  it('a callback that hits a provider conflict redirects with error=provider_conflict', async () => {
    upsertConnectionMock.mockRejectedValueOnce(new AccountingProviderConflictErrorClass('xero', 'quickbooks'));
    const res = await completeCallback('quickbooks');   // existing happy-path helper
    expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&error=provider_conflict#accounting');
  });

  it('GET /accounting/providers lists registered providers with configuration and capabilities', async () => {
    resolveActiveConnectionMock.mockResolvedValue({ id: 'c1', provider: 'quickbooks', status: 'connected' });
    const res = await request('GET', '/accounting/providers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ id: 'quickbooks', displayName: 'QuickBooks', configured: true,
        capabilities: { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true } }],
      activeConnection: { provider: 'quickbooks', status: 'connected' },
    });
  });
});
```

If `index.test.ts` names its helpers differently (`startConnect`, `completeCallback`, `request`), use its existing ones. The assertions are the contract.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/routes/accounting/providerGate.test.ts src/routes/accounting/index.test.ts -t "provider generalisation|providerGateResponse"
```

Expected: FAIL. `xero` fails the enum with 400, and the module is missing.

- [ ] **Step 3: Implement `providerGate.ts`**

```ts
// apps/api/src/routes/accounting/providerGate.ts
/**
 * Provider admission for every /accounting/:provider route (Xero W01). The URL
 * enum admits every KNOWN provider id; this gate admits only a REGISTERED
 * provider that declares the route's capability and is configured on this
 * instance. Called at the top of each handler (not as middleware — the import
 * route's chain is at Hono's type-inference limit).
 */
import type { Context } from 'hono';
import { db } from '../../db';
import {
  accountingProviderDisplayName, findAccountingProvider, listRegisteredAccountingProviders, providerSupports,
} from '../../services/accounting/providerRegistry';
import { resolveActiveConnection } from '../../services/accounting/accountingConnectionService';
import type { AccountingCapability, AccountingProviderId } from '../../services/accounting/types';

export function providerGateResponse(c: Context, provider: AccountingProviderId, capability: AccountingCapability): Response | null {
  const impl = findAccountingProvider(provider);
  if (!impl) {
    return c.json({ error: `${accountingProviderDisplayName(provider)} is not available on this instance yet`, code: 'capability_unavailable' }, 409);
  }
  if (!providerSupports(provider, capability)) {
    return c.json({ error: `${impl.displayName} does not support this yet`, code: 'capability_unavailable' }, 409);
  }
  const configError = impl.configError();
  if (configError) return c.json({ error: configError, code: 'provider_not_configured' }, 400);
  return null;
}

export async function listProvidersHandler(c: Context, partnerId: string): Promise<Response> {
  const active = await resolveActiveConnection(db, partnerId);
  return c.json({
    data: listRegisteredAccountingProviders().map((p) => ({
      id: p.provider, displayName: p.displayName, configured: p.configError() === null, capabilities: p.capabilities,
    })),
    activeConnection: active ? { provider: active.provider, status: active.status } : null,
  });
}
```

- [ ] **Step 4: Rewire `routes/accounting/index.ts`**

1. `const providerParamSchema = z.object({ provider: z.enum(ACCOUNTING_PROVIDER_IDS) });`, and the same in `invoicePushParamSchema`.
2. Delete `validateProviderConfig` and the `QBO_*` import. At the top of **every** `/:provider` handler, replace `const configError = validateProviderConfig(provider); if (configError) return c.json({ error: configError }, 400);`, or add it where the handler had none:

   ```ts
   const gate = providerGateResponse(c, provider, '<capability from the table>');
   if (gate) return gate;
   ```

   Behaviour note for QuickBooks: routes that used to validate config (connect, callback, customers, import, settings refresh, push, push-bulk, remote-candidates) return the same 400 and the same message, with an added `code`. Routes that did not (status, disconnect, settings PATCH, owed-operations, reconcile, mappings, income-accounts) now also 400 when QBO env vars are missing. Every one of them already failed at the first provider call in that state. List this in the PR body.
3. Register `GET /providers` **before** `accountingRoutes.get('/:provider', …)`, or `/:provider` captures it and the enum rejects it with 400:

   ```ts
   accountingRoutes.get('/providers', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingRead,
     zValidator('query', partnerQuerySchema), async (c) => {
       const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
       if ('error' in partner) return c.json({ error: partner.error }, partner.status);
       return listProvidersHandler(c, partner.partnerId);
     });
   ```
4. OAuth state:

   ```ts
   interface AccountingStatePayload { partnerId: string; userId: string | null; provider?: AccountingProviderId; nonce: string; exp: number; }
   function createState(partnerId: string, userId: string | null, provider: AccountingProviderId): string | null { /* payload gains provider */ }
   ```

   In the callback, after `verifyState`:

   ```ts
   // Pre-W01 states carry no provider; they were QuickBooks flows (10-minute TTL spans at most one deploy).
   const stateProvider = state.provider ?? LEGACY_UNTARGETED_JOB_PROVIDER;
   if (stateProvider !== provider) return c.json({ error: 'OAuth state was issued for a different provider' }, 400);
   ```
5. `/connect` refuses a cross-provider connect before starting OAuth:

   ```ts
   const active = await resolveActiveConnection(db, partner.partnerId);
   if (active && active.provider !== provider) {
     const conflict = new AccountingProviderConflictError(active.provider, provider);
     return c.json({ error: conflict.message, code: conflict.code }, 409);
   }
   ```
6. Callback: `environment: providerClient.connectEnvironment()` replaces `QBO_ENVIRONMENT as …`. The `upsertConnection` catch adds, before the generic `persist_failed`:

   ```ts
   if (err instanceof AccountingProviderConflictError) {
     deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
     return c.redirect(`/integrations?accounting=${provider}&error=provider_conflict#accounting`);
   }
   ```

   Every hard-coded `?accounting=quickbooks` becomes `?accounting=${provider}`. Every `'[accounting] QuickBooks …'` log string becomes `` `[accounting] ${providerClient.displayName} …` ``, with the same text for QBO.
7. Customer import audit: `details: { source: `${provider}_import`, [`${provider}CustomerId`]: item.customerId, siteId: item.siteId }`. This keeps `source: 'quickbooks_import'` and `quickbooksCustomerId` byte-identical for QBO.
8. `resolveConnectionAndToken(partner.partnerId, provider, …)` calls become `resolveConnectionAndToken(partner.partnerId, { provider }, …)`. Pass the same `{ provider }` target to `pushInvoiceToAccounting` and to the mapping-service calls.

Route test files that mock `providerRegistry` or `accountingConnectionService` need the new exports added (as in Task 3 Step 4), plus `configError: () => null` and `connectEnvironment: () => 'sandbox'` on the mocked provider object. The one test that asserted `{ error: 'QuickBooks OAuth is not configured on this instance' }` with `toEqual` now also sees `code: 'provider_not_configured'`; switch it to `toMatchObject` (a wiring edit, not a semantic one).

- [ ] **Step 5: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/routes/accounting src/middleware/selfManagedDbContextRoutes.test.ts src/routes/webhooks.mountOrder.test.ts && npx tsc --noEmit -p .
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingPartnerAuthority.integration.test.ts
```

Expected: PASS, and tsc is clean. The `routes/accounting/index.ts` line count must not grow: `wc -l src/routes/accounting/index.ts` ≤ 1325. If it has grown, move the OAuth state helpers (`createState`, `verifyState`, `stateCookieValue`, `constantTimeEqual`, `signingSecret`, `hmac`) into `routes/accounting/oauthState.ts`, unchanged except for the new `provider` field.

- [ ] **Step 6: Commit**

```bash
git add -A apps/api/src/routes/accounting
git commit -m "feat(accounting): provider-generic routes - enum + capability gate, provider in OAuth state, GET /accounting/providers (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: `quickbooksCustomerImport.ts` → `accountingCustomerImport.ts`

**Files:**
- Rename: `apps/api/src/services/accounting/quickbooksCustomerImport.ts` → `accountingCustomerImport.ts`; `quickbooksCustomerImport.test.ts` → `accountingCustomerImport.test.ts` (`git mv`)
- Modify: `routes/accounting/index.ts` (the import and the calls, ~L27-31, ~L206, ~L831, ~L852)
- Modify (comments only): `addressMapping.ts` (L3-9), `accountingMappingService.ts` (~L67, ~L118), `orgAccountReadinessIntegrations.ts` (~L247), `routes/sso.ts` (~L311), `services/aiToolsOrgs.ts` (~L26, ~L71, ~L283), `services/orgImport/slug.ts` (L4)

**Interfaces:**
- Produces:
  ```ts
  export type AccountingImportErrorCode = 'not_connected' | 'reauth_required' | 'provider_error' | 'capability_unavailable';
  export class AccountingImportError extends Error { readonly code: AccountingImportErrorCode; readonly status: 400 | 404 | 409 | 502 }
  export async function listAccountingCustomersAnnotated(partnerId: string, provider: AccountingProviderId): Promise<AnnotatedCustomer[]>;
  export async function importAccountingCustomers(input: { partnerId: string; provider: AccountingProviderId; customerIds: string[]; actor: OrgImportActor }): Promise<AccountingImportSummary>;
  export type AccountingImportSummary = /* the old QbImportSummary, renamed */;
  ```
  `organization_external_links.system` is written as `conn.provider` (`'quickbooks'` for QBO, byte-identical). The module only ever calls `listRemoteCustomers`, so it is provider-neutral by construction.

- [ ] **Step 1: Rename and write the failing test**

```bash
git mv apps/api/src/services/accounting/quickbooksCustomerImport.ts apps/api/src/services/accounting/accountingCustomerImport.ts
git mv apps/api/src/services/accounting/quickbooksCustomerImport.test.ts apps/api/src/services/accounting/accountingCustomerImport.test.ts
```

In `accountingCustomerImport.test.ts`, change the imports to the new names (`AccountingImportError`, `importAccountingCustomers`, `listAccountingCustomersAnnotated`), pass `provider: 'quickbooks'` / `'quickbooks'` to every call, and change `'quickbooks_error'` to `'provider_error'` if Task 8 has not already done so. Then add:

```ts
it('refuses a provider that is not the partner\'s active connection', async () => {
  resolveActiveConnectionMock.mockResolvedValue(connRow({ provider: 'quickbooks' }));
  await expect(listAccountingCustomersAnnotated('p1', 'xero')).rejects.toMatchObject({ code: 'not_connected', status: 404, message: 'Xero is not connected for this partner' });
});

it('dedupes against organization_external_links under the connection\'s provider', async () => {
  resolveActiveConnectionMock.mockResolvedValue(connRow({ provider: 'quickbooks' }));
  await importAccountingCustomers({ partnerId: 'p1', provider: 'quickbooks', customerIds: ['1'], actor: { userId: null } });
  expect(commitImportMock).toHaveBeenCalledWith(expect.objectContaining({ externalSystem: 'quickbooks' }));
});
```

(`commitImportMock` is whatever this file already calls the org-import seam mock; the assertion is the contract.)

- [ ] **Step 2: Run and confirm it fails**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingCustomerImport.test.ts
```

Expected: FAIL (old names).

- [ ] **Step 3: Implement**

Rename the symbols. Delete `const PROVIDER = 'quickbooks' as const;`. `fetchCustomers(partnerId, provider)` resolves through the mapping service's rules so the wording matches everywhere:

```ts
async function fetchCustomers(partnerId: string, provider: AccountingProviderId): Promise<{ conn: AccountingConnection; customers: RemoteCustomer[] }> {
  if (!providerSupports(provider, 'customerImport')) {
    throw new AccountingImportError(`${accountingProviderDisplayName(provider)} customer import is not available yet`, 'capability_unavailable', 409);
  }
  const conn = await runOutsideDbContext(() => withSystemDbAccessContext(() => resolveActiveConnection(db, partnerId)));
  const label = accountingProviderDisplayName(provider);
  if (!conn || conn.provider !== provider || (conn.status !== 'connected' && conn.status !== 'reauth_required')) {
    throw new AccountingImportError(`${label} is not connected for this partner`, 'not_connected', 404);
  }
  if (conn.status === 'reauth_required') throw new AccountingImportError(`${label} needs to be reconnected`, 'reauth_required', 409);
  // … getValidAccessToken exactly as today, with `${label}` in its messages …
  try {
    return { conn, customers: await getAccountingProvider(provider).listRemoteCustomers({ ...conn, accessToken }) };
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)));
    throw new AccountingImportError(`${label} returned an error while listing customers`, 'provider_error', 502);
  }
}
```

Every `externalSystem: PROVIDER` becomes `externalSystem: conn.provider`. In the route, `handleImportError` checks `instanceof AccountingImportError`, and the handlers call the new functions with `provider`.

Update the comment-only references listed under **Files** to the new filename. This grep must print nothing:

```bash
cd apps/api && grep -rn "quickbooksCustomerImport\|QbImportError\|QbImportSummary\|importQuickbooksCustomers\|listQuickbooksCustomersAnnotated" src
```

- [ ] **Step 4: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingCustomerImport.test.ts src/routes/accounting/customers.test.ts && npx tsc --noEmit -p .
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/api/src
git commit -m "refactor(accounting): quickbooksCustomerImport -> provider-neutral accountingCustomerImport (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Mechanical guard: the accounting core stays neutral

**Files:**
- Create: `apps/api/src/services/accounting/neutralCore.guard.test.ts`

**Interfaces:**
- Produces: a failing unit test (Test API job) whenever a core accounting file contains the literal `'quickbooks'` (any quote style), or imports `quickbooksFault` / `quickbooksProvider` or a `qbo*` / `Qbo*` / `QBO_*` symbol.

**Scope** (spec W01 "Mechanical guard"):
- scanned: `apps/api/src/services/accounting/**/*.ts`, `apps/api/src/jobs/**/*.ts`, `apps/api/src/routes/accounting/**/*.ts` (tests excluded)
- exempt by rule: files named `*Provider.ts` (e.g. `quickbooksProvider.ts`; W02 adds `xeroProvider.ts`), `quickbooksFault.ts`, `providerRegistry.ts`
- `ALLOWLIST`: starts **empty**. An entry needs a reason of at least 20 characters, and a stale entry (a file that no longer violates) fails, as `partner-wide-write-coverage.test.ts` does.

- [ ] **Step 1: Write the guard, with its own controls**

```ts
/**
 * Xero W01 neutral-core guard (spec "Mechanical guard"). The accounting core
 * (services/accounting, jobs, routes/accounting) must not name QuickBooks in code:
 * no 'quickbooks' literal and no import of QuickBooks internals. Provider code
 * lives in *Provider.ts / quickbooksFault.ts / providerRegistry.ts.
 *
 * AST-based (like accountingInvoicePushCallSites.test.ts) so comments and
 * template text that merely MENTION QuickBooks never trip it, and a literal
 * hidden in a template or a computed key always does.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..', '..');
const ROOTS = ['services/accounting', 'jobs', 'routes/accounting'].map((p) => join(SRC, p));
const EXEMPT = (rel: string) => /Provider\.ts$/.test(rel) || rel.endsWith('/quickbooksFault.ts') || rel.endsWith('/providerRegistry.ts');
/** Repo-src-relative path -> reason (≥ 20 chars). STARTS EMPTY; the core push/pull/mapping services may never be added. */
const ALLOWLIST: Record<string, string> = {};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

export function findViolations(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'quickbooks') {
      out.push(`literal 'quickbooks' at ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (/quickbooksFault|quickbooksProvider/.test(spec)) out.push(`imports ${spec}`);
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (/^(qbo|Qbo|QBO_)/.test(imported)) out.push(`imports symbol ${imported} from ${spec}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('neutral accounting core (Xero W01)', () => {
  it('the guard catches what it claims to (controls)', () => {
    expect(findViolations(`const p = 'quickbooks';`, 'x.ts')).toHaveLength(1);
    expect(findViolations('const p = `quickbooks`;', 'x.ts')).toHaveLength(1);
    expect(findViolations(`import { qboFaultOf } from './quickbooksFault';`, 'x.ts')).toHaveLength(2);
    expect(findViolations(`import { QBO_CLIENT_ID } from '../../config/env';`, 'x.ts')).toHaveLength(1);
    expect(findViolations(`// talks to QuickBooks\nconst label = 'QuickBooks';`, 'x.ts')).toHaveLength(0);
    expect(findViolations(`const s = 'quickbooks_import';`, 'x.ts')).toHaveLength(0);
  });

  it('no core file names QuickBooks in code', () => {
    const failures: string[] = [];
    for (const file of ROOTS.flatMap(walk)) {
      const rel = relative(SRC, file);
      if (EXEMPT(rel) || ALLOWLIST[rel]) continue;
      for (const v of findViolations(readFileSync(file, 'utf8'), file)) failures.push(`${rel}: ${v}`);
    }
    expect(failures, `Move QuickBooks specifics behind AccountingProvider (see docs/superpowers/plans/billing/2026-09-26-xero-w01-core-neutralization.md):\n${failures.join('\n')}`).toEqual([]);
  });

  it('allowlist entries are justified and not stale', () => {
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${rel}: reason too short`).toBeGreaterThanOrEqual(20);
      expect(findViolations(readFileSync(join(SRC, rel), 'utf8'), rel).length, `${rel}: stale allowlist entry`).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd apps/api && npx vitest run src/services/accounting/neutralCore.guard.test.ts
```

Expected: the controls PASS. The scan either PASSES (Tasks 4–16 already removed every site) or lists the remaining offenders. Fix each offender by moving it behind the provider or the registry. **Do not add it to `ALLOWLIST`** unless it is not core push/pull/mapping code and you write down why. Known candidates to check: `LEGACY_UNTARGETED_JOB_PROVIDER` users (they are fine: they import a constant, not a literal), and any leftover `provider: 'quickbooks'` default in a job type.

- [ ] **Step 3: Mutation control** (evidence-discipline: prove the red is real)

Temporarily add `const _x = 'quickbooks';` to `apps/api/src/jobs/accountingSyncWorker.ts`, run the guard, and confirm it FAILS naming `jobs/accountingSyncWorker.ts: literal 'quickbooks' at <line>`. Revert and confirm it PASSES.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/accounting/neutralCore.guard.test.ts
git commit -m "test(accounting): mechanical guard - no QuickBooks literals or imports in the accounting core (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Web: generic accounting shell, provider-parameterised components

**Files:**
- Create: `apps/web/src/lib/accountingProviders.ts`, `apps/web/src/lib/accountingProviders.test.ts`
- Create: `apps/web/src/components/integrations/AccountingProviderCards.tsx`, `AccountingProviderCards.test.tsx`
- Rename (`git mv`, with their tests): `QuickbooksIntegration.tsx` → `AccountingConnectionPanel.tsx` (plus `.test.tsx` and `.accountingPermissions.test.tsx`); `QuickbooksMappingWorkbench.tsx` → `AccountingMappingWorkbench.tsx` (plus both tests); `QuickbooksCustomerImport.tsx` → `AccountingCustomerImport.tsx` (plus its test)
- Modify: `components/integrations/IntegrationsPage.tsx` (`AccountingSubTab` ~L62, `accountingSubTabs`, `parseHash` ~L183-192, the render ~L592-598), `components/billing/AccountingSyncCard.tsx` (the push URL ~L215), `components/billing/InvoiceDetail.tsx` (passes `provider` to the card; the payment badges ~L672-694), `components/billing/InvoicesPage.tsx` (`pushSelectedToQuickbooks` ~L395-433, the menu item ~L850), `components/billing/invoiceTypes.ts` (L172, L242)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`: the renamed paths, **plus** `AccountingCustomerImport.tsx`, which was missing before although it already uses `runAction`)

**Interfaces:**
- Consumes: `GET /accounting/providers` (Task 15), `/accounting/:provider/*`.
- Produces:
  ```ts
  // lib/accountingProviders.ts
  export const ACCOUNTING_PROVIDER_IDS = ['quickbooks', 'xero'] as const;
  export type AccountingProviderId = (typeof ACCOUNTING_PROVIDER_IDS)[number];
  export type AccountingCapability = 'connect' | 'mapping' | 'customerImport' | 'invoicePush' | 'paymentPull' | 'paymentPush';
  export const ACCOUNTING_PROVIDER_NAMES: Record<AccountingProviderId, string>;     // brand names, never translated
  export function isAccountingProviderId(v: string): v is AccountingProviderId;
  export function accountingPath(provider: AccountingProviderId, suffix?: string): string; // '/accounting/quickbooks' + suffix
  export interface AccountingProviderSummary { id: AccountingProviderId; displayName: string; configured: boolean; capabilities: Record<AccountingCapability, boolean> }
  export interface AccountingProvidersResponse { data: AccountingProviderSummary[]; activeConnection: { provider: AccountingProviderId; status: string } | null }
  export async function fetchAccountingProviders(): Promise<AccountingProvidersResponse | null>;   // null on 401/403/network
  export function useActivePushProvider(enabled: boolean): AccountingProviderId | null;          // active provider iff it supports invoicePush
  // components
  export default function AccountingConnectionPanel(props: { provider: AccountingProviderId }): JSX.Element;
  export default function AccountingMappingWorkbench(props: { provider: AccountingProviderId; /* existing props */ }): JSX.Element;
  export default function AccountingCustomerImport(props: { provider: AccountingProviderId; onUnauthorized: () => void }): JSX.Element;
  export default function AccountingProviderCards(props: { selected: AccountingProviderId | null; onSelect: (p: AccountingProviderId) => void }): JSX.Element;
  // AccountingSyncCard Props gain: provider: AccountingProviderId
  ```
- Invariants: **every QBO `data-testid` is unchanged** (`quickbooks-connect` becomes `` `${provider}-connect` ``). Hash segments are unchanged (`#quickbooks`, `#quickbooks-customers`, `#quickbooks-items`). Every mutation keeps `runAction`.

- [ ] **Step 1: Write the failing tests**

`lib/accountingProviders.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { accountingPath, ACCOUNTING_PROVIDER_NAMES, isAccountingProviderId } from './accountingProviders';

describe('accountingProviders', () => {
  it('builds provider-scoped API paths', () => {
    expect(accountingPath('quickbooks')).toBe('/accounting/quickbooks');
    expect(accountingPath('quickbooks', '/invoices/push-bulk')).toBe('/accounting/quickbooks/invoices/push-bulk');
    expect(accountingPath('xero', '/connect')).toBe('/accounting/xero/connect');
  });
  it('knows brand names and ids', () => {
    expect(ACCOUNTING_PROVIDER_NAMES.quickbooks).toBe('QuickBooks');
    expect(ACCOUNTING_PROVIDER_NAMES.xero).toBe('Xero');
    expect(isAccountingProviderId('xero')).toBe(true);
    expect(isAccountingProviderId('stripe')).toBe(false);
  });
});
```

`AccountingProviderCards.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: m.fetchWithAuth }));
import AccountingProviderCards from './AccountingProviderCards';

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const caps = { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true };

describe('AccountingProviderCards', () => {
  it('shows one card per configured provider only', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'quickbooks', displayName: 'QuickBooks', configured: true, capabilities: caps },
      { id: 'xero', displayName: 'Xero', configured: false, capabilities: caps },
    ], activeConnection: null }));
    render(<AccountingProviderCards selected={null} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('accounting-provider-card-quickbooks')).toBeTruthy());
    expect(screen.queryByTestId('accounting-provider-card-xero')).toBeNull();
  });

  it('greys out another provider\'s card while one is connected (one provider per partner)', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: [
      { id: 'quickbooks', displayName: 'QuickBooks', configured: true, capabilities: caps },
      { id: 'xero', displayName: 'Xero', configured: true, capabilities: { ...caps, invoicePush: false } },
    ], activeConnection: { provider: 'quickbooks', status: 'connected' } }));
    render(<AccountingProviderCards selected="quickbooks" onSelect={() => {}} />);
    const xero = await screen.findByTestId('accounting-provider-card-xero');
    expect(xero.getAttribute('aria-disabled')).toBe('true');
    expect(xero.textContent).toContain('Disconnect QuickBooks first');
  });
});
```

Append to the renamed `AccountingConnectionPanel.test.tsx`:

```tsx
it('calls the provider-scoped API for its provider prop', async () => {
  render(<AccountingConnectionPanel provider="quickbooks" />);
  await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/accounting/quickbooks'));
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/web && npx vitest run src/lib/accountingProviders.test.ts src/components/integrations/AccountingProviderCards.test.tsx
```

Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `lib/accountingProviders.ts`**

```ts
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

export const ACCOUNTING_PROVIDER_IDS = ['quickbooks', 'xero'] as const;
export type AccountingProviderId = (typeof ACCOUNTING_PROVIDER_IDS)[number];
export type AccountingCapability = 'connect' | 'mapping' | 'customerImport' | 'invoicePush' | 'paymentPull' | 'paymentPush';

/** Brand names — never translated. */
export const ACCOUNTING_PROVIDER_NAMES: Record<AccountingProviderId, string> = { quickbooks: 'QuickBooks', xero: 'Xero' };

export function isAccountingProviderId(v: string): v is AccountingProviderId {
  return (ACCOUNTING_PROVIDER_IDS as readonly string[]).includes(v);
}

export function accountingPath(provider: AccountingProviderId, suffix = ''): string {
  return `/accounting/${provider}${suffix}`;
}

export interface AccountingProviderSummary {
  id: AccountingProviderId; displayName: string; configured: boolean; capabilities: Record<AccountingCapability, boolean>;
}
export interface AccountingProvidersResponse {
  data: AccountingProviderSummary[];
  activeConnection: { provider: AccountingProviderId; status: string } | null;
}

export async function fetchAccountingProviders(): Promise<AccountingProvidersResponse | null> {
  try {
    const res = await fetchWithAuth('/accounting/providers');
    if (!res.ok) return null;
    return (await res.json()) as AccountingProvidersResponse;
  } catch {
    return null;
  }
}

/** The provider an invoice push would go to: the active connection, iff it can push invoices. */
export function useActivePushProvider(enabled: boolean): AccountingProviderId | null {
  const [provider, setProvider] = useState<AccountingProviderId | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetchAccountingProviders().then((r) => {
      if (!live || !r?.activeConnection) return;
      const summary = r.data.find((p) => p.id === r.activeConnection!.provider);
      if (summary?.capabilities.invoicePush) setProvider(summary.id);
    });
    return () => { live = false; };
  }, [enabled]);
  return provider;
}
```

- [ ] **Step 4: Implement `AccountingProviderCards.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchAccountingProviders, type AccountingProviderId, type AccountingProvidersResponse } from '../../lib/accountingProviders';

interface Props { selected: AccountingProviderId | null; onSelect: (p: AccountingProviderId) => void }

export default function AccountingProviderCards({ selected, onSelect }: Props) {
  const { t } = useTranslation('integrations');
  const [state, setState] = useState<AccountingProvidersResponse | null>(null);
  useEffect(() => { void fetchAccountingProviders().then(setState); }, []);
  if (!state) return null;
  const active = state.activeConnection;
  const activeName = active ? state.data.find((p) => p.id === active.provider)?.displayName ?? active.provider : null;
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="accounting-provider-cards">
      {state.data.filter((p) => p.configured).map((p) => {
        const blocked = !!active && active.provider !== p.id;
        return (
          <button
            key={p.id}
            type="button"
            data-testid={`accounting-provider-card-${p.id}`}
            aria-pressed={selected === p.id}
            aria-disabled={blocked}
            disabled={blocked}
            onClick={() => onSelect(p.id)}
            className={`rounded-lg border p-4 text-left ${blocked ? 'cursor-not-allowed opacity-50' : 'hover:bg-muted'} ${selected === p.id ? 'border-primary' : ''}`}
          >
            <div className="font-medium">{p.displayName}</div>
            <div className="text-sm text-muted-foreground">
              {blocked
                ? t('accountingProviders.disconnectOtherFirst', { provider: activeName })
                : active?.provider === p.id
                  ? t('accountingProviders.connected')
                  : t('accountingProviders.notConnected')}
            </div>
          </button>
        );
      })}
    </div>
  );
}
```

Add the three `accountingProviders.*` keys to `locales/en/integrations.json` (`"disconnectOtherFirst": "Disconnect {{provider}} first"`, `"connected": "Connected"`, `"notConnected": "Not connected"`) and to the other seven locales. Task 19's script adds them if you run it after this step.

- [ ] **Step 5: Rename and parameterise the three components**

```bash
cd apps/web/src/components/integrations
git mv QuickbooksIntegration.tsx AccountingConnectionPanel.tsx
git mv QuickbooksIntegration.test.tsx AccountingConnectionPanel.test.tsx
git mv QuickbooksIntegration.accountingPermissions.test.tsx AccountingConnectionPanel.accountingPermissions.test.tsx
git mv QuickbooksMappingWorkbench.tsx AccountingMappingWorkbench.tsx
git mv QuickbooksMappingWorkbench.test.tsx AccountingMappingWorkbench.test.tsx
git mv QuickbooksMappingWorkbench.accountingPermissions.test.tsx AccountingMappingWorkbench.accountingPermissions.test.tsx
git mv QuickbooksCustomerImport.tsx AccountingCustomerImport.tsx
git mv QuickbooksCustomerImport.test.tsx AccountingCustomerImport.test.tsx
```

In each component:

- Add `provider: AccountingProviderId` to the props, and `const providerName = ACCOUNTING_PROVIDER_NAMES[provider];`.
- Every `"/accounting/quickbooks…"` literal (listed in the web inventory: `AccountingConnectionPanel` ×10, `AccountingMappingWorkbench` ×6, `AccountingCustomerImport` ×2) becomes `accountingPath(provider, '…')`.
- Every `data-testid="quickbooks-…"` becomes `` data-testid={`${provider}-…`} ``.
- The workbench hash tabs `["quickbooks-customers","quickbooks-items"]` become `` [`${provider}-customers`, `${provider}-items`] ``.
- The OAuth return check `params.get("accounting") === "quickbooks"` becomes `=== provider`.
- The panel passes `provider` down to the workbench and the import.
- Every `t(...)` call on a key moved in Task 19 gets `{ provider: providerName }` added to its options (existing interpolation values are kept).

Callers:

- `IntegrationsPage.tsx`:
  - `type AccountingSubTab = AccountingProviderId | "stripe";`
  - `accountingSubTabs` lists `quickbooks`, `xero`, `stripe`. Keep the list static so `parseHash('#xero…')` routes correctly.
  - The sub-tab buttons render a provider only when `AccountingProviderCards`' data marks it configured. Simplest: render `<AccountingProviderCards selected={…} onSelect={(p) => { window.location.hash = p; }} />` above the panel and hide provider sub-tab buttons.
  - The panel render becomes `activeTab === "accounting" && !isOrgScoped && isAccountingProviderId(accountingSubTab) && (canReadAccounting ? <AccountingConnectionPanel provider={accountingSubTab} /> : <AccessDenied testId={`accounting-${accountingSubTab}-denied`} />)`. The testid stays `accounting-quickbooks-denied` for QBO.
- `AccountingSyncCard.tsx`: `Props` gains `provider: AccountingProviderId`, and the push URL becomes `` accountingPath(provider, `/invoices/${invoiceId}/push`) ``. `InvoiceDetail.tsx` passes `sync?.provider ?? pushProvider`, where `const pushProvider = useActivePushProvider(canPush);`, and renders the card only when that resolves to a provider or `sync` exists. Payment badges use `ACCOUNTING_PROVIDER_NAMES[payment.source]` when `isAccountingProviderId(payment.source)`.
- `InvoicesPage.tsx`: `const pushProvider = useActivePushProvider(canManageAccounting);`. Rename `pushSelectedToQuickbooks` to `pushSelectedToAccounting`. Its URL is `accountingPath(pushProvider, '/invoices/push-bulk')`, and the menu item renders only when `pushProvider` is non-null. This is a change only for disconnected partners, where the action used to enqueue jobs the worker then dropped (preamble item 10).
- `invoiceTypes.ts`: L172 `provider: AccountingProviderId;` and L242 `source?: 'stripe' | 'manual' | AccountingProviderId;` (import the type from `../../lib/accountingProviders`).

Test wiring: in the renamed tests, change `import QuickbooksIntegration from './QuickbooksIntegration'` to the new module and render with `provider="quickbooks"`. The same applies to the workbench and import tests. `IntegrationsPage` tests mock `fetchWithAuth` for `/accounting/providers` and return QBO configured. Every existing assertion (testids, English strings, URLs) stays byte-identical. That is the "no behaviour change" check for the web.

`no-silent-mutations.test.ts` `TARGET_GLOBS`: replace `QuickbooksIntegration.tsx` and `QuickbooksMappingWorkbench.tsx` with the new paths, and **add** `src/components/integrations/AccountingCustomerImport.tsx`.

- [ ] **Step 6: Run and confirm everything passes**

```bash
cd apps/web && npx vitest run src/lib/accountingProviders.test.ts src/components/integrations src/components/billing src/lib/__tests__/no-silent-mutations.test.ts src/lib/orgReadiness.integrations.test.ts && npx tsc --noEmit -p .
grep -rn '"/accounting/quickbooks\|`/accounting/quickbooks\|QuickbooksIntegration\|QuickbooksMappingWorkbench\|QuickbooksCustomerImport' src
```

Expected: tests PASS and tsc is clean. The grep prints nothing.

- [ ] **Step 7: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): generic accounting shell with provider cards; accounting components take the provider (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: i18n keys become provider-generic

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json` and `…/billing.json`
- Modify: the Task 18 components (key names), `apps/web/src/lib/i18n/translationCoverage.test.ts` (~L59, key names)
- Scratch (not committed): `<scratchpad>/generalize-accounting-i18n.mjs`

**Interfaces:**
- Key moves (`{{provider}}` replaces every `QuickBooks Online`, `QuickBooks` and `QBO` in the moved **values**; keys whose value names no provider are moved unchanged):

| Namespace | From | To |
|---|---|---|
| integrations | `quickbooksIntegration.*` | `accountingConnection.*` |
| integrations | `quickbooksMapping.*` | `accountingMapping.*` |
| integrations | `quickbooksCustomerImport.*` | `accountingCustomerImport.*` |
| integrations | `integrationsPage.quickbooks` | *(deleted; tab labels use `ACCOUNTING_PROVIDER_NAMES`)* |
| billing | `invoiceDetail.payments.{quickbooks,viaQuickbooks,inQuickbooks,syncingToQuickbooks,quickbooksSyncFailed,reverseInQuickbooksToo}` | `invoiceDetail.payments.{provider,viaProvider,inProvider,syncingToProvider,providerSyncFailed,reverseInProviderToo}` |
| billing | `invoicesPage.bulk.{quickbooks,quickbooksQueued,quickbooksQueuedPartial,quickbooksQueuedFailed,quickbooksFailed}` | `invoicesPage.bulk.{pushToProvider,providerQueued,providerQueuedPartial,providerQueuedFailed,providerFailed}` |
| billing | `invoiceDetail.accountingSync.*` | same keys; values get `{{provider}}` |

Inside the moved keys, camelCase **key names** that embed "QuickBooks" (e.g. `failedToStartTheQuickBooksConnection`) are renamed by replacing `QuickBooks`/`Quickbooks` with `Provider` (`failedToStartTheProviderConnection`), so no key name carries a brand. `billingConnectionsTab.*` is **out of scope for W01**: it is a static marketing-style tab with no provider context. It is noted as a W02 follow-up, when Xero first appears there.

- [ ] **Step 1: Write the failing check**

The existing parity and key-usage tests are the failing tests. After Task 18 renamed the key *usages*, `keyUsage.test.ts` reports keys used but not defined:

```bash
cd apps/web && npx vitest run src/lib/i18n
```

Expected: FAIL. `keyUsage` lists the missing `accountingConnection.*` etc. (If Task 18 has not yet switched the key names in code, switch them first. That is the red.)

- [ ] **Step 2: Write and run the move script** (scratch file, not committed)

```js
// <scratchpad>/generalize-accounting-i18n.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES_DIR = process.argv[2]; // apps/web/src/locales
const brand = (s) => s.replace(/QuickBooks Online|QuickBooks|QBO/g, '{{provider}}');
const keyName = (k) => k.replace(/QuickBooks|Quickbooks/g, 'Provider');
const mapValues = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) =>
  [keyName(k), typeof v === 'string' ? brand(v) : mapValues(v)]));

const MOVES = {
  'integrations.json': [['quickbooksIntegration', 'accountingConnection'], ['quickbooksMapping', 'accountingMapping'], ['quickbooksCustomerImport', 'accountingCustomerImport']],
};
const LEAF_MOVES = {
  'billing.json': [
    ['invoiceDetail.payments', { quickbooks: 'provider', viaQuickbooks: 'viaProvider', inQuickbooks: 'inProvider', syncingToQuickbooks: 'syncingToProvider', quickbooksSyncFailed: 'providerSyncFailed', reverseInQuickbooksToo: 'reverseInProviderToo' }],
    ['invoicesPage.bulk', { quickbooks: 'pushToProvider', quickbooksQueued: 'providerQueued', quickbooksQueuedPartial: 'providerQueuedPartial', quickbooksQueuedFailed: 'providerQueuedFailed', quickbooksFailed: 'providerFailed' }],
  ],
};
const at = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

for (const locale of readdirSync(LOCALES_DIR)) {
  for (const file of ['integrations.json', 'billing.json']) {
    const p = join(LOCALES_DIR, locale, file);
    const json = JSON.parse(readFileSync(p, 'utf8'));
    for (const [from, to] of MOVES[file] ?? []) {
      if (json[from]) { json[to] = mapValues(json[from]); delete json[from]; }
    }
    if (file === 'integrations.json' && json.integrationsPage) delete json.integrationsPage.quickbooks;
    for (const [parent, renames] of LEAF_MOVES[file] ?? []) {
      const node = at(json, parent);
      if (!node) continue;
      for (const [from, to] of Object.entries(renames)) {
        if (from in node) { node[to] = brand(node[from]); delete node[from]; }
      }
    }
    if (file === 'billing.json') {
      const sync = at(json, 'invoiceDetail.accountingSync');
      if (sync) Object.assign(sync, mapValues(sync));
    }
    writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
  }
}
```

```bash
node <scratchpad>/generalize-accounting-i18n.mjs apps/web/src/locales
git diff --stat apps/web/src/locales
grep -rn "QuickBooks\|QBO" apps/web/src/locales/*/integrations.json apps/web/src/locales/*/billing.json | grep -v billingConnectionsTab
```

Expected: 16 files changed. The final grep prints only strings outside the moved subtrees; review each and leave the ones that are not accounting-provider text. Hand-review `de-DE`, `fr-FR` and `tr-TR` for grammar around `{{provider}}` (German case endings, Turkish suffixes such as `QuickBooks'a` become `{{provider}}'a`). Leave a suffix that is correct for "QuickBooks" as it is. `{{provider}}` is always "QuickBooks" until W02, and W02 reviews those strings for "Xero".

- [ ] **Step 3: Update the renamed key usages in code** (the Task 18 components, plus `InvoiceDetail.tsx`, `InvoicesPage.tsx`, `AccountingSyncCard.tsx`) to the new key names, each with `{ provider: providerName }`. Update the QuickBooks payment key names at `translationCoverage.test.ts` ~L59.

- [ ] **Step 4: Run and confirm everything passes**

```bash
cd apps/web && npx vitest run src/lib/i18n src/components/integrations src/components/billing && npx tsc --noEmit -p .
```

Expected: PASS. `localeParity` passes because every locale moved identically, `keyUsage` passes, and the component tests still see "QuickBooks …" English text through interpolation.

- [ ] **Step 5: Run the full W01d verification**

```bash
cd apps/api && npx vitest run && npx tsc --noEmit -p .
cd ../web && npx vitest run && npx tsc --noEmit -p .
# accounting integration set (Global Constraints), then:
pnpm test-stack down
```

Expected: all green.

- [ ] **Step 6: Commit and open PR W01d** (`Closes #<W01 sub-issue>`, since this is the last W01 PR)

```bash
git add -A apps/web/src
git commit -m "feat(web): provider-generic accounting i18n keys (Xero W01)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

PR body: link this plan, restate preamble items 3, 8 and 10, and include the manual check below.

- [ ] **Step 7: Manual check** (the `feature-testing` skill, against a `worktree-stack` with `QBO_*` sandbox env)

1. On `/integrations#accounting`, exactly one card (QuickBooks) shows. The QuickBooks panel renders and connect / disconnect / sync now behave as before.
2. The OAuth round trip returns to `/integrations?accounting=quickbooks&connected=1#accounting` with the success toast.
3. With QuickBooks connected, `curl -H "Authorization: Bearer …" /api/v1/accounting/xero/connect` → 409 `capability_unavailable`.
4. On an invoice, "Push to QuickBooks" still works, and bulk push is offered. With QuickBooks disconnected, bulk push is not offered.
5. `#quickbooks-items` deep link opens the Items tab.

Tear the stack down afterwards and say in the PR what was run.

---

## Self-review (done while writing; kept for the executor)

**Spec coverage (W01 section → task):**

| Spec requirement | Task |
|---|---|
| `resolveActiveConnection` replacing every `(partner, 'quickbooks')` lookup | 2, 4, 5, 7, 15, 16; enforced by 17 |
| unique `(partner_id)` + precheck + 409 `accounting_provider_conflict` + web greys out the other card | 1, 2, 15, 18 (old index kept: preamble 1) |
| jobs carry `connectionId`; drop on gone / provider change; legacy jobs QBO-only | 5 (payment jobs bind via mapping: preamble 4) |
| Stripe `integration_id` hardening | 6 |
| `AccountingProviderError` kinds; QBO translates at its boundary; core branches on kind; `'provider_error'` | 8 (+ 13 for 429) |
| mechanics table: remoteVersion, idempotency provider-owned and pinned, paymentMarker, limits, neutral method, displayName sentinel, ChangeSet wording | 9, 10 |
| capabilities `{connect, mapping, customerImport, invoicePush, paymentPull, paymentPush}` enforced at routes, producers, workers and UI | 3, 5, 7, 15, 18 |
| totals invariant (hidden lines, subtotal assertion, tax + total compare) | 11 (#7161 precondition) |
| per-connection + app-wide limiter from `provider.limits.rate`; Retry-After requeue without an attempt; tier-aware daily budget hook | 12, 13, 14 |
| `routeWebhookToConnection`; QBO URL unchanged | 7 |
| route param `z.enum(['quickbooks','xero'])` gated by registry and capabilities; explicit config error; provider in OAuth state; `?accounting=<provider>` | 15 |
| `accountingCustomerImport.ts` / `AccountingImportError` | 16 |
| web shell + provider-param components + `invoiceTypes` unions + generic i18n + `runAction` | 18, 19 |
| guard test | 17 |
| acceptance: QBO suite passes (see preamble 9 for the allowed edits) | every task's verify step + the QBO unit set + the accounting integration set |

**Deliberately not in W01:** dropping `accounting_connections_partner_provider_idx` (a follow-up release); relaxing the callback's required `realmId` query field and the tenant picker (W02, since the spec's "OAuth callback requires realmId" item is a W02 concern); `XERO_*` env and `envComposeParity` (W02); the `pending_tenant` exclusion (W02, one line in `resolveActiveConnection`); renaming `QUICKBOOKS_OWNED_PAYMENT` / `quickbooksRecordUntouched` (W05); `billingConnectionsTab` copy (W02); import-paging budget deferral (W03, when Xero import pages through the limiter).

**Placeholder scan:** every code step contains code. The one conditional instruction (Task 11, "keep #7161's names if it created them") exists because #7161 is being written in parallel; the behaviour contract is fully specified.

**Type consistency check:** `ConnectionTarget` (Task 4) is used by Tasks 5, 14, 15 and 16. `resolveJobConnection` returns `target` (Task 5). `AccountingProviderError.retryAfterMs` (Task 8) is read by `rateLimitRetryAfterMs` (Task 14). `RateLimitSpec` (Task 9) is used by `withProviderCallSlot` (Task 12) and `limits.rate` (Tasks 9, 13). `LEGACY_UNTARGETED_JOB_PROVIDER` (Task 3) is used by Tasks 4, 5 and 15. `providerSupports` / `findAccountingProvider` / `accountingProviderDisplayName` (Task 3) are used throughout.
