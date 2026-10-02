# Autopay W01: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish tenant-safe settings, collection reservations, Stripe settlement, and durable billing notices that subsequent autopay waves can use without changing existing Checkout payments.
**Architecture:** W1a adds the eight tenant-scoped tables, lifecycle registrations, shared contracts, settings resolver, and platform-admin rollout control. W1b makes existing payment producers honor invoice reservations and adds reusable Stripe, token, notice, worker, and fee plumbing. No enrollment, charge scheduler, real notice renderer, fee editing, or new UI ships in this wave.
**Tech Stack:** TypeScript, Hono, PostgreSQL, Drizzle, BullMQ, Redis, Vitest, Astro checks.
**Spec:** docs/superpowers/specs/billing/2026-10-01-autopay-design.md · **Index:** docs/superpowers/plans/billing/2026-10-01-autopay-index.md

## Preconditions

- Read the approved spec, binding C1–C9 index, `CLAUDE.md`, and `.claude/skills/breeze-testing/SKILL.md` before implementation. This document is an implementation plan; its commit and test commands are instructions for the implementation session, not commands run while authoring it.
- Begin W1a on the current main base. Land W1a before rebasing W1b onto main; each PR targets main. Confirm actual repository merge rules at implementation time; this document does not authorize merging.
- Check `ls apps/api/migrations | sort | tail -1` before creating migrations. Preserve the six C1 filenames below unless a newer committed migration forces the index's explicit sort-last renaming procedure. Also run `git ls-files 'apps/api/migrations/[0-9]*.sql' | sort | tail -1` to identify the newest committed SQL file; the unfiltered command currently returns the `preflight` directory. The newest committed SQL file read for this plan is `2026-11-19-101000-ai-budget-reservation-replay-attempts.sql`.
- Have the existing dependencies and worktree test-stack tooling available. Real database assertions must run on the isolated test stack, never production. Do not interpret a unit-only run as RLS verification.
- No system-scoped table is introduced. All eight new tables are tenant-scoped. The org-owned authority/history tables are customer records, not partner-wide configuration.

## Where this plan corrects or refines the spec/index

- `CUSTOM_EXECUTORS` is implemented in `apps/api/src/services/orgMergeCustomExecutors.ts`, imported by `orgMerge.ts`. Add executors in that actual module. The current unconditional `blocks-merge` behavior needs an active-attempt predicate rather than blocking all historical attempts.
- Invoice history moves during merge while payment authority stays on the losing org. Cancel/revoke first and clear `invoice_autopay_schedules.enrollment_id` and `invoice_collection_attempts.payment_method_id` on moved terminal records, allowing NULL only for terminal states through CHECK constraints; composite org FKs must never be relaxed to permit a survivor record to retain usable authority from another org. Task 4 spells out the constraints and migration behavior.
- `sendEmail` in `apps/api/src/services/email.ts` returns `Promise<void>`; it exposes neither a provider id nor a provider idempotency contract. The outbox guarantees deduplicated enqueue and fenced concurrent dispatch, but delivery is at least once across an external-send/DB-commit crash. Keep `provider_message_id` null rather than fabricate an id, and do not claim exactly-once external delivery. A sent-handler retry must not resend mail after `sent_at` is durable.
- `renderPartnerEmail` in `apps/api/src/services/emailTemplates/renderPartnerEmail.ts` returns only subject and HTML. The per-kind renderer supplies plain text explicitly; mandatory blocks are appended to both HTML and text. W1 installs no production kinds or template ids.
- `startRegisteredWorkers` is already called by `bootWorker` in `apps/api/src/worker.ts`. Register the worker through `WORKER_REGISTRY`; do not add a second direct startup invocation. Test the actual entrypoint connection and both expected-name contracts. **CW-06:** Task 15 also owns `WORKER_READINESS_MANIFEST` registration with `consumers('autopayWorker')` in `jobs/workerReadinessManifest.ts`, required whenever Redis is available. W3 Task 5 only verifies this prerequisite; W1 must supply it and run `workerReadinessCoverage.test.ts` in Tasks 15 and 17.
- C4's `Tx` is not an exported invoice-service symbol. Introduce the same DB/transaction union in `services/autopay/types.ts`; no binding function signature changes.
- The index supersedes the spec's charging-only rollout flag and deferred fee calculator: use `partners.autopay_enabled`, put the pure calculator in `services/autopay/processingFee.ts`, keep fees unwritable until W5, and leave setup/PI sweep branches to W2/W4. No `autopay_charging_enabled` or `services/surchargeRules.ts` is created.

- `ensureAppRole` in `apps/api/src/db/ensureAppRole.ts` refreshes broad table grants on every boot. A migration-only consent REVOKE would be undone; Task 2 also re-revokes consent UPDATE/DELETE/TRUNCATE after that grant and tests a boot-time refresh.
- `buildKeepSurvivor` in `apps/api/src/services/orgMergeExecutors.ts` adopts the loser's row when the survivor has none. The spec requires dropping loser payment settings, so Task 4 special-cases that table in execution and preview. `CORE_ORG_CASCADE_DELETE_ORDER` stays alphabetic; `topologicalCascadeOrder` in `apps/api/src/services/tenantCascade.ts` supplies the actual FK-children-first execution order.
- `CORE_TENANT_EXPORT_POLICY` in `apps/api/src/services/tenantExportPolicyRegistry.ts` describes organization exports. All eight new tables and new columns on `contracts`, `invoices`, and `invoice_stripe_payments` receive explicit classifications. The new `partners.autopay_enabled` and `stripe_connect_accounts` capability columns are partner-owned configuration and remain outside individual-org exports; Task 4 documents that exclusion instead of inventing an org ownership predicate.
- `toChangeSetPaymentLine` in `apps/api/src/services/accounting/xeroPayments.ts` has no provider payment-rail metadata and returns `other`. Preserve that value rather than infer ACH from a reference or account name. `QBO_PAYMENT_METHOD_NAMES` in `apps/api/src/services/accounting/quickbooksProvider.ts` gains the explicit ACH-debit name, and the web's exhaustive `PAYMENT_METHOD_LABELS` gains its label.
- `recordPaymentSchema` in `packages/shared/src/validators/invoices.ts` accepts a number today. Preserve that public input and pass `String(input.amount)` to the C4 decimal-string boundary. `applyInsideTransaction` in `apps/api/src/services/accounting/accountingPaymentPull.ts` currently permits imported overpayment; Task 8 deliberately rejects inserts/increases above unreserved balance, rolls back, and preserves retry state rather than silently dropping part of an external payment.
- `createInvoicePayLink` in `apps/api/src/services/invoiceCheckout.ts` and the portal pay handler publish mappings after Stripe returns. A preflight reservation check alone cannot cover that gap. Task 8 rechecks under the invoice lock, persists revocation intent on a raced session, and withholds its URL. W4 must also call existing `assertInvoiceSessionsRevoked` from `apps/api/src/services/stripeSessionRevocation.ts` under that same invoice lock before reserving.
- `applyStripeFinancialEvent` in `apps/api/src/services/stripeReversalState.ts` previously treated mapping amount as both charge gross and ledger principal. Task 9 adds a private cumulative proportional principal calculation so W1 fee-bearing reversals cannot inflate invoice principal; W5 still owns the public reversal-allocation API and fee-income posting. `eraseExpiredStripeCredentials` in `apps/api/src/services/stripeCredentialArchive.ts` must check active attempts before even its existing 400-day erasure cap.
- `readWithPartnerAxisVisibility` in `apps/api/src/db/partnerAxisRead.ts` is needed for an authenticated org caller's rollout-flag read. It is not used to bypass the new settings table's RLS. Org `reminderRepeatDays: null` means inherit under the spec's nullable override model; it cannot independently disable repeats while a partner repeats. The plan exposes this limitation without changing C4.
- The app is currently private and `bootstrap` runs on import in `apps/api/src/index.ts`. Task 7 exports the existing app and guards bootstrap under `NODE_ENV !== 'test'`, allowing real mount tests. Admin mounting stays under the existing `platformAdminMiddleware` hub and MFA pattern.
- `main` in `apps/api/scripts/check-drift.ts` compares migration filenames with `breeze_migrations`; it does not inspect Drizzle columns or apply migrations. Task 2 therefore includes real PostgreSQL enum, column/type/nullability, unique-constraint, FK-deferral, and replay assertions. The index's unfiltered latest-migration command also includes directories; the filtered committed-file check in Preconditions resolves that ambiguity.

## Global Constraints

- Money: `numeric(12,2)` decimal strings in services; Stripe in integer minor units via the existing
  `services/stripeMoney.ts` helpers. Never floats.
- Every Stripe call goes through `getPartnerStripeClient` and runs **outside** any DB transaction
  (`runOutsideDbContext`).
- Checkout **payment** sessions stay `payment_method_types: ['card']` (#5611). ACH only via setup
  sessions + PaymentIntents.
- No-login token routes: GET renders and never mutates; every state change is a POST.
- Tenancy: every new org-scoped table has RLS enabled + forced in its creating migration, composite
  `org_id` FKs `DEFERRABLE INITIALLY IMMEDIATE`, and is registered in cascade, merge and export per
  spec §5.9. Run `pnpm test-stack up` and the integration + `test:rls-coverage` suites before the
  PR.
- Migrations: idempotent, `SELECT set_config('breeze.scope','system',true)` before any write, never
  added to the `migrationRlsScope` baseline, C1 slots.
- Tests are co-located; the API uses Vitest with Drizzle mocks per the `breeze-testing` skill.
  Real-DB behaviour gets `*.integration.test.ts`. Run single files with
  `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`).
- Web: `runAction` for mutations, `data-testid` on interactive elements, `window.location.hash`
  for tab state, i18n keys.
- No internal infrastructure details, customer names or real keys in code, tests or docs.


- All commands start at the repository root; directory-specific runs use subshells. The commands are for implementation, not plan authoring.
- W1a = Tasks 1–7. W1b = Tasks 8–17. Task 17 verifies each PR at its boundary and the combined wave.
- Settings defaults: offset `0`, rule `later`, cap `{ enabled: false }`, ACH mode `ach_preferred`, card fee `0` bps, ACH fee `'0.00'`, reminders `false`, before due `3`, repeat `null`, overdue every `7` days. PUT accepts autopay/reminder fields only and rejects fee/attestation fields.
- Active reservations are precisely `reserved`, `created`, `confirming`, `processing`. Principal reduces availability; fee never reduces invoice balance. Failed PaymentIntent mappings can settle on a later success; failed Checkout mappings retain existing behavior.
- Notice dispatch: batch at most `50`, claim lease `15` minutes, at most `8` send attempts, exponential retry `min(60 × 2^(attempts − 1), 3600)` seconds. A durable `sent_at` means subsequent retries execute handlers without another send. Provider acceptance is the existing application's send-success boundary.
- Card fee rules are the approved conservative product policy dated `2026-10-01`: US account, USD, US billing address, credit funding, attestation, maximum `300` bps; CA/CT/ME/MA disabled, CO maximum `200` bps. ACH flat maximum `'25.00'`. Missing country/state information fails closed for card fees. Monetary arithmetic uses decimal strings and integer minor units, with half-up rounding.
- W1 creates no UI module. Web edits are exhaustive payment-method labels only; UI composition and Playwright setup screens belong to later waves.

## Review Focus

1. Simultaneous manual/import/pay-link payment and reservation: Task 8 uses two real transactions and proves the second producer observes the committed reservation before creating money movement.
2. Merge of a debtor with active payment authority: Task 4 blocks active attempts and proves all loser authority is cancelled/removed without becoming survivor authority.
3. Crash or handler failure after a notice was accepted: Task 14 tests concurrent claims, durable send acknowledgement, handler-only recovery, and eventual retry exhaustion.
4. Late Stripe success after failure, with a fee or bank method: Tasks 9–10 prove principal-only booking, gross verification, method preservation, and unchanged zero-fee Checkout behavior.
5. Inherited false/zero/null settings and malicious extra fields: Tasks 5–7 prove explicit unlimited/off wins, org tokens can read defaults but cannot write partner rows, and fee/attestation injection is rejected.
6. Worker readiness ownership: Task 15 declares exactly one Redis-required `autopayWorker` consumer matching its observability attachment; Tasks 15 and 17 run the readiness coverage contract before W3 relies on that registration.

## File map

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-11-20-100000-autopay-enums.sql` | Create: Apply autopay enums with idempotent SQL and creating-file tenancy rules. |
| `apps/api/migrations/2026-11-20-100100-billing-payment-settings.sql` | Create: Apply billing payment settings with idempotent SQL and creating-file tenancy rules. |
| `apps/api/migrations/2026-11-20-100200-org-autopay-enrollments-methods-consents.sql` | Create: Apply org autopay enrollments methods consents with idempotent SQL and creating-file tenancy rules. |
| `apps/api/migrations/2026-11-20-100300-invoice-autopay-schedules-attempts.sql` | Create: Apply invoice autopay schedules attempts with idempotent SQL and creating-file tenancy rules. |
| `apps/api/migrations/2026-11-20-100400-billing-notice-outbox-link-tokens.sql` | Create: Apply billing notice outbox link tokens with idempotent SQL and creating-file tenancy rules. |
| `apps/api/migrations/2026-11-20-100500-autopay-column-additions.sql` | Create: Apply autopay column additions with idempotent SQL and creating-file tenancy rules. |
| `apps/api/src/__tests__/integration/autopayFoundation.integration.test.ts` | Create: Verify create the eight tenant-scoped tables and immutable consent history. |
| `apps/api/src/__tests__/integration/autopayMerge.integration.test.ts` | Create: Verify register lifecycle ownership and make merge cancel authority before moving history. |
| `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` | Modify: Verify register lifecycle ownership and make merge cancel authority before moving history. |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | Modify: Register dual-axis settings and assert the SELECT-only defaults branch. |
| `apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts` | Modify: Verify reconcile gross Stripe charges into principal and preserve the payment method. |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | Modify: Verify strict settings writes and one inheritance resolver. |
| `apps/api/src/db/ensureAppRole.ts` | Modify: Preserve consent immutability after per-boot privilege refresh. |
| `apps/api/src/db/schema/autopay.ts` | Create: Define all eight autopay tables and SQL-mirrored constraints. |
| `apps/api/src/db/schema/autopayColumns.test.ts` | Create: Verify add backward-compatible billing columns and the ACH payment rail. |
| `apps/api/src/db/schema/contracts.ts` | Modify: Add the contract autopay exclusion column. |
| `apps/api/src/db/schema/index.ts` | Modify: Export the new Drizzle table definitions. |
| `apps/api/src/db/schema/invoices.ts` | Modify: Add invoice exclusion and inherit the expanded payment-method enum. |
| `apps/api/src/db/schema/orgs.ts` | Modify: Add the platform-controlled partner autopay flag. |
| `apps/api/src/db/schema/stripePayments.ts` | Modify: Add fee, payment rail, source, capability columns, and mapping tenant uniqueness. |
| `apps/api/src/index.autopayRoutes.test.ts` | Create: Verify mount the settings and admin routes through the real API app. |
| `apps/api/src/index.ts` | Modify: Export the app, mount settings routes, and guard test-time bootstrap. |
| `apps/api/src/jobs/autopayWorker.test.ts` | Create: Verify register the autopay worker and its one-minute notice job. |
| `apps/api/src/jobs/autopayWorker.ts` | Create: Register the autopay worker and its one-minute notice job. |
| `apps/api/src/jobs/scheduleRegistry.ts` | Modify: Register the one-minute billing-notice-dispatch schedule. |
| `apps/api/src/jobs/workerReadinessManifest.ts` | Modify: Declare the single Redis-required autopayWorker consumer for W1 and later waves. |
| `apps/api/src/jobs/workerReadinessCoverage.test.ts` | Test existing: Verify exact manifest/observability attachment coverage in Tasks 15 and 17. |
| `apps/api/src/routes/admin/autopayRollout.test.ts` | Create: Verify partner rollout gate and platform-admin mutation. |
| `apps/api/src/routes/admin/autopayRollout.ts` | Create: Partner rollout gate and platform-admin mutation. |
| `apps/api/src/routes/admin/index.ts` | Modify: Mount rollout control under platform-admin authorization. |
| `apps/api/src/routes/billingPaymentSettings.ts` | Create: Mount the settings and admin routes through the real API app. |
| `apps/api/src/routes/invoicesPublic.test.ts` | Modify: Verify serialize every existing collection producer against reservations. |
| `apps/api/src/routes/invoicesPublic.ts` | Modify: Return a customer-safe collection-in-progress refusal. |
| `apps/api/src/routes/portal/invoices.test.ts` | Modify: Verify serialize every existing collection producer against reservations. |
| `apps/api/src/routes/portal/invoices.ts` | Modify: Apply reservation guards and Checkout publication checks to portal payment. |
| `apps/api/src/routes/stripeConnect/index.test.ts` | Modify: Verify probe restricted-key capabilities and persist account-bound readiness. |
| `apps/api/src/routes/stripeConnect/index.ts` | Modify: Return saved/refreshed autopay capability facts. |
| `apps/api/src/services/accounting/accountingPaymentPull.test.ts` | Modify: Verify serialize every existing collection producer against reservations. |
| `apps/api/src/services/accounting/accountingPaymentPull.ts` | Modify: Limit imported inserts and increases to unreserved invoice balance. |
| `apps/api/src/services/accounting/autopayPaymentMethods.test.ts` | Create: Verify add backward-compatible billing columns and the ACH payment rail. |
| `apps/api/src/services/accounting/quickbooksProvider.ts` | Modify: Recognize explicitly named ACH-debit payment methods. |
| `apps/api/src/services/autopay/autopayGate.test.ts` | Create: Verify partner rollout gate and platform-admin mutation. |
| `apps/api/src/services/autopay/autopayGate.ts` | Create: Partner rollout gate and platform-admin mutation. |
| `apps/api/src/services/autopay/billingPaymentSettings.test.ts` | Create: Verify strict settings writes and one inheritance resolver. |
| `apps/api/src/services/autopay/billingPaymentSettings.ts` | Create: Strict settings writes and one inheritance resolver. |
| `apps/api/src/services/autopay/foundation.contract.test.ts` | Create: Verify verification and release evidence for both PRs. |
| `apps/api/src/services/autopay/linkTokens.test.ts` | Create: Verify row-bound billing link tokens. |
| `apps/api/src/services/autopay/linkTokens.ts` | Create: Row-bound billing link tokens. |
| `apps/api/src/services/autopay/merge.test.ts` | Create: Verify register lifecycle ownership and make merge cancel authority before moving history. |
| `apps/api/src/services/autopay/merge.ts` | Create: Register lifecycle ownership and make merge cancel authority before moving history. |
| `apps/api/src/services/autopay/noticeOutbox.integration.test.ts` | Create: Verify durable billing outbox, fenced dispatch, and handler recovery. |
| `apps/api/src/services/autopay/noticeOutbox.ts` | Create: Durable billing outbox, fenced dispatch, and handler recovery. |
| `apps/api/src/services/autopay/processingFee.test.ts` | Create: Verify pure processing-fee policy and exact rounding. |
| `apps/api/src/services/autopay/processingFee.ts` | Create: Pure processing-fee policy and exact rounding. |
| `apps/api/src/services/autopay/renderBillingNotice.test.ts` | Create: Verify per-kind billing rendering with mandatory append blocks. |
| `apps/api/src/services/autopay/renderBillingNotice.ts` | Create: Per-kind billing rendering with mandatory append blocks. |
| `apps/api/src/services/autopay/reservation.integration.test.ts` | Create: Verify serialize every existing collection producer against reservations. |
| `apps/api/src/services/autopay/reservation.test.ts` | Create: Verify serialize every existing collection producer against reservations. |
| `apps/api/src/services/autopay/reservation.ts` | Create: Serialize every existing collection producer against reservations. |
| `apps/api/src/services/autopay/stripeCapabilities.test.ts` | Create: Verify probe restricted-key capabilities and persist account-bound readiness. |
| `apps/api/src/services/autopay/stripeCapabilities.ts` | Create: Probe restricted-key capabilities and persist account-bound readiness. |
| `apps/api/src/services/autopay/types.ts` | Create: Strict settings writes and one inheritance resolver. |
| `apps/api/src/services/emailDomains/mailPurposes.test.ts` | Modify: Verify durable billing outbox, fenced dispatch, and handler recovery. |
| `apps/api/src/services/emailDomains/mailPurposes.ts` | Modify: Classify billing notices into the partner billing mail lane. |
| `apps/api/src/services/encryptedColumnRegistry.ts` | Modify: Register row-bound billing token ciphertext for rotation. |
| `apps/api/src/services/invoiceCheckout.test.ts` | Modify: Verify serialize every existing collection producer against reservations. |
| `apps/api/src/services/invoiceCheckout.ts` | Modify: Check reservations before Stripe and before publishing Checkout mappings. |
| `apps/api/src/services/invoiceService.test.ts` | Modify: Verify serialize every existing collection producer against reservations. |
| `apps/api/src/services/invoiceService.ts` | Modify: Limit manual payments and reject voids while money is reserved. |
| `apps/api/src/services/invoiceTypes.ts` | Modify: Expose the typed COLLECTION_IN_PROGRESS conflict. |
| `apps/api/src/services/orgMerge.ts` | Modify: Enforce active-attempt blockers, settings deletion, and post-commit detach. |
| `apps/api/src/services/orgMergeCustomExecutors.ts` | Modify: Register autopay custom merge executors. |
| `apps/api/src/services/orgMergeRegistry.ts` | Modify: Declare cancellation, retention, history movement, and active-attempt merge policies. |
| `apps/api/src/services/partnerStripe.test.ts` | Modify: Verify probe restricted-key capabilities and persist account-bound readiness. |
| `apps/api/src/services/partnerStripe.ts` | Modify: Preserve the client export and save/refresh account-bound capability snapshots. |
| `apps/api/src/services/partnerStripeClient.ts` | Create: Centralize stored, candidate, and archived Stripe client construction. |
| `apps/api/src/services/stripeCredentialArchive.test.ts` | Create: Verify settle PaymentIntents with account-bound retained credentials. |
| `apps/api/src/services/stripeCredentialArchive.ts` | Modify: Retain superseded credentials while collection attempts are active. |
| `apps/api/src/services/stripeReconcile.test.ts` | Modify: Verify reconcile gross Stripe charges into principal and preserve the payment method. |
| `apps/api/src/services/stripeReconcile.ts` | Modify: Validate gross Stripe amounts and record principal with the original rail. |
| `apps/api/src/services/stripeReversalState.ts` | Modify: Allocate gross reversals to principal and preserve ACH restoration. |
| `apps/api/src/services/stripeSettle.test.ts` | Create: Verify settle PaymentIntents with account-bound retained credentials. |
| `apps/api/src/services/stripeSettle.ts` | Modify: Retrieve and settle PaymentIntents against the original Stripe account. |
| `apps/api/src/services/tenantCascade.ts` | Modify: Register all tenant tables and audit-admin consent erasure. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Modify: Classify every new org-export column and document partner-owned exclusions. |
| `apps/api/src/services/workerEntrypointClosure.contract.test.ts` | Modify: Verify register the autopay worker and its one-minute notice job. |
| `apps/api/src/services/workerRegistry.test.ts` | Modify: Verify register the autopay worker and its one-minute notice job. |
| `apps/api/src/services/workerRegistry.ts` | Modify: Register autopay worker initialization and shutdown. |
| `apps/api/vitest.config.ts` | Modify: Exclude real-DB autopay suites from the unit runner. |
| `apps/api/vitest.integration.config.ts` | Modify: Discover co-located real-DB autopay suites. |
| `apps/docs/src/content/docs/features/online-payments.mdx` | Modify: Document restricted-key permissions required by autopay probes. |
| `apps/web/src/components/billing/invoiceTypes.test.ts` | Modify: Verify add backward-compatible billing columns and the ACH payment rail. |
| `apps/web/src/components/billing/invoiceTypes.ts` | Modify: Add the exhaustive ACH-debit display label. |
| `packages/shared/src/types/autopay.test.ts` | Create: Verify publish the cross-wave vocabulary and SQL enums. |
| `packages/shared/src/types/autopay.ts` | Create: Publish the cross-wave vocabulary and SQL enums. |
| `packages/shared/src/types/billing-enums.test.ts` | Modify: Verify add backward-compatible billing columns and the ACH payment rail. |
| `packages/shared/src/types/billing-enums.ts` | Modify: Add ach_debit to the shared payment-method tuple. |
| `packages/shared/src/types/index.ts` | Modify: Export the binding autopay vocabulary. |
| `packages/shared/src/validators/autopay.test.ts` | Create: Verify strict settings writes and one inheritance resolver. |
| `packages/shared/src/validators/autopay.ts` | Create: Strict settings writes and one inheritance resolver. |
| `packages/shared/src/validators/index.ts` | Modify: Export strict partner and org payment-settings patch validators. |

---

## PR W1a — schema, tenancy, and settings

### Task 1: Publish the cross-wave vocabulary and SQL enums
**Files:** Create `packages/shared/src/types/autopay.ts`, `packages/shared/src/types/autopay.test.ts`, `apps/api/migrations/2026-11-20-100000-autopay-enums.sql`; Modify `packages/shared/src/types/index.ts`.
**Interfaces:** Consumes C3's exact constant tuples · Produces every C3 constant and its singular element type, including `AutopayOffsetRule`, `AchMode`, `BillingNoticeKind`, `BillingLinkPurpose`, `AutopayPaymentMethodType`, `CardFundingType`, `AccountHolderType`, `CollectionFailureClass`, `CollectionAttemptInitiator`.

- [ ] **Step 1: Write the failing test** — create `packages/shared/src/types/autopay.test.ts`.

```ts
import { describe, expect, it } from 'vitest';
import * as vocabulary from './autopay';
import { ACTIVE_COLLECTION_ATTEMPT_STATES, COLLECTION_ATTEMPT_STATES, BILLING_NOTICE_KINDS } from './autopay';

describe('autopay cross-wave vocabulary', () => {
  it('reserves only provider-in-flight states; authentication is not a reservation', () => {
    expect(ACTIVE_COLLECTION_ATTEMPT_STATES).toEqual(['reserved', 'created', 'confirming', 'processing']);
    expect(COLLECTION_ATTEMPT_STATES).toContain('requires_action');
    expect(COLLECTION_ATTEMPT_STATES).toContain('unapplied');
    expect(COLLECTION_ATTEMPT_STATES).toContain('canceled');
  });
  it('keeps every tuple duplicate-free and all nine notice kinds stable', () => {
    for (const values of Object.values(vocabulary)) {
      expect(new Set(values).size).toBe(values.length);
    }
    expect(BILLING_NOTICE_KINDS).toEqual(['autopay_request', 'autopay_enrolled', 'invoice_autopay', 'payment_receipt', 'payment_failed', 'payment_reminder', 'payment_overdue', 'autopay_stopped', 'card_expiring']);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd packages/shared && npx vitest run src/types/autopay.test.ts`; missing `./autopay`.
- [ ] **Step 3: Implement** — create `packages/shared/src/types/autopay.ts` with the complete contract below.

```ts
export const AUTOPAY_ENROLLMENT_STATUSES = ['requested', 'active', 'paused', 'cancelled'] as const;
export const AUTOPAY_CANCEL_SOURCES = ['client', 'msp', 'system'] as const;
export const AUTOPAY_NEEDS_ATTENTION_REASONS = ['method_unusable', 'stripe_account_changed', 'key_missing_permissions', 'verification_failed'] as const;
export const ACH_MODES = ['ach_preferred', 'ach_only'] as const;
export const AUTOPAY_OFFSET_RULES = ['earlier', 'later'] as const;
export const AUTOPAY_PAYMENT_METHOD_TYPES = ['card', 'us_bank_account'] as const;
export const CARD_FUNDING_TYPES = ['credit', 'debit', 'prepaid', 'unknown'] as const;
export const ACCOUNT_HOLDER_TYPES = ['individual', 'company'] as const;
export const ORG_PAYMENT_METHOD_STATUSES = ['pending_verification', 'active', 'unusable', 'removed'] as const;
export const AUTOPAY_SCHEDULE_STATES = ['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled', 'action_required', 'succeeded', 'failed', 'skipped_by_client', 'excluded_by_msp', 'cancelled', 'not_needed'] as const;
export const AUTOPAY_INELIGIBLE_REASONS = ['not_enrolled', 'enrolled_after_issue', 'method_not_usable', 'over_cap', 'cap_currency_mismatch', 'ach_currency_unsupported', 'excluded_contract', 'excluded_invoice', 'charging_disabled', 'stripe_unavailable'] as const;
export const COLLECTION_ATTEMPT_STATES = ['reserved', 'created', 'confirming', 'processing', 'succeeded', 'failed', 'requires_action', 'canceled', 'unapplied'] as const;
export const ACTIVE_COLLECTION_ATTEMPT_STATES = ['reserved', 'created', 'confirming', 'processing'] as const;
export const COLLECTION_FAILURE_CLASSES = ['soft', 'hard', 'auth_required', 'nsf', 'revoked'] as const;
export const COLLECTION_ATTEMPT_INITIATORS = ['scheduler', 'msp_charge_now', 'client_on_session'] as const;
export const BILLING_NOTICE_KINDS = ['autopay_request', 'autopay_enrolled', 'invoice_autopay', 'payment_receipt', 'payment_failed', 'payment_reminder', 'payment_overdue', 'autopay_stopped', 'card_expiring'] as const;
export const BILLING_NOTICE_STATUSES = ['pending', 'sending', 'sent', 'failed', 'cancelled'] as const;
export const BILLING_LINK_PURPOSES = ['enroll', 'skip_invoice', 'stop_autopay', 'confirm_payment'] as const;
export const CONSENT_SOURCES = ['setup_page', 'pay_and_save', 'portal'] as const;

export type AutopayEnrollmentStatus = (typeof AUTOPAY_ENROLLMENT_STATUSES)[number];
export type AutopayCancelSource = (typeof AUTOPAY_CANCEL_SOURCES)[number];
export type AutopayNeedsAttentionReason = (typeof AUTOPAY_NEEDS_ATTENTION_REASONS)[number];
export type AchMode = (typeof ACH_MODES)[number];
export type AutopayOffsetRule = (typeof AUTOPAY_OFFSET_RULES)[number];
export type AutopayPaymentMethodType = (typeof AUTOPAY_PAYMENT_METHOD_TYPES)[number];
export type CardFundingType = (typeof CARD_FUNDING_TYPES)[number];
export type AccountHolderType = (typeof ACCOUNT_HOLDER_TYPES)[number];
export type OrgPaymentMethodStatus = (typeof ORG_PAYMENT_METHOD_STATUSES)[number];
export type AutopayScheduleState = (typeof AUTOPAY_SCHEDULE_STATES)[number];
export type AutopayIneligibleReason = (typeof AUTOPAY_INELIGIBLE_REASONS)[number];
export type CollectionAttemptState = (typeof COLLECTION_ATTEMPT_STATES)[number];
export type ActiveCollectionAttemptState = (typeof ACTIVE_COLLECTION_ATTEMPT_STATES)[number];
export type CollectionFailureClass = (typeof COLLECTION_FAILURE_CLASSES)[number];
export type CollectionAttemptInitiator = (typeof COLLECTION_ATTEMPT_INITIATORS)[number];
export type BillingNoticeKind = (typeof BILLING_NOTICE_KINDS)[number];
export type BillingNoticeStatus = (typeof BILLING_NOTICE_STATUSES)[number];
export type BillingLinkPurpose = (typeof BILLING_LINK_PURPOSES)[number];
export type ConsentSource = (typeof CONSENT_SOURCES)[number];
```

Append to `packages/shared/src/types/index.ts` (the existing root `packages/shared/src/index.ts` already re-exports `./types`):

```ts
export * from './autopay';
```

Create `apps/api/migrations/2026-11-20-100000-autopay-enums.sql`:

```sql
SELECT set_config('breeze.scope','system',true);
DO $$ BEGIN
  CREATE TYPE autopay_enrollment_status AS ENUM ('requested', 'active', 'paused', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE autopay_schedule_state AS ENUM ('awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled', 'action_required', 'succeeded', 'failed', 'skipped_by_client', 'excluded_by_msp', 'cancelled', 'not_needed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE collection_attempt_state AS ENUM ('reserved', 'created', 'confirming', 'processing', 'succeeded', 'failed', 'requires_action', 'canceled', 'unapplied');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE billing_notice_kind AS ENUM ('autopay_request', 'autopay_enrolled', 'invoice_autopay', 'payment_receipt', 'payment_failed', 'payment_reminder', 'payment_overdue', 'autopay_stopped', 'card_expiring');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE billing_notice_status AS ENUM ('pending', 'sending', 'sent', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE billing_link_purpose AS ENUM ('enroll', 'skip_invoice', 'stop_autopay', 'confirm_payment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE org_payment_method_status AS ENUM ('pending_verification', 'active', 'unusable', 'removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE ach_mode AS ENUM ('ach_preferred', 'ach_only');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE autopay_offset_rule AS ENUM ('earlier', 'later');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 4: Run it, expect PASS** — `cd packages/shared && npx vitest run src/types/autopay.test.ts`. SQL enum equality is tested against PostgreSQL in Task 2.
- [ ] **Step 5: Commit** — `git add packages/shared/src/types/autopay.ts packages/shared/src/types/autopay.test.ts packages/shared/src/types/index.ts apps/api/migrations/2026-11-20-100000-autopay-enums.sql` then `git commit -m "feat(billing): define autopay contract vocabulary"`.

### Task 2: Create the eight tenant-scoped tables and immutable consent history
**Files:** Create `apps/api/migrations/2026-11-20-100100-billing-payment-settings.sql`, `apps/api/migrations/2026-11-20-100200-org-autopay-enrollments-methods-consents.sql`, `apps/api/migrations/2026-11-20-100300-invoice-autopay-schedules-attempts.sql`, `apps/api/migrations/2026-11-20-100400-billing-notice-outbox-link-tokens.sql`, `apps/api/src/db/schema/autopay.ts`, `apps/api/src/__tests__/integration/autopayFoundation.integration.test.ts`; Modify `apps/api/src/db/schema/index.ts`, `apps/api/src/db/ensureAppRole.ts`.
**Interfaces:** Consumes C3 tuples; existing `organizations`, `partners` (`db/schema/orgs.ts`), `invoices` (`db/schema/invoices.ts`), `stripeConnectAccounts` and `invoiceStripePayments` (`db/schema/stripePayments.ts`) · Produces all eight C2 table exports with decimal-string money, composite tenant FKs and the exact C1 migration slots.

- [ ] **Step 1: Write the failing test** — create the following complete real-DB suite. `createPartner` and `createOrganization` are the existing factories in `src/__tests__/integration/db-utils.ts`; `withDbAccessContext`, `withSystemDbAccessContext` and `DbAccessContext` are existing exports from `src/db/index.ts`. Driver errors are wrapped in `.cause`, as in `accounting-connections-rls.integration.test.ts`.

```ts
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as autopaySchema from '../../db/schema/autopay';
import * as vocabulary from '@breeze/shared';
import { ensureAppRole } from '../../db/ensureAppRole';

import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createPartner, createOrganization } from './db-utils';

const tables = ['billing_payment_settings', 'org_autopay_enrollments', 'org_autopay_consents', 'org_payment_methods', 'invoice_autopay_schedules', 'invoice_collection_attempts', 'billing_notice_outbox', 'billing_link_tokens'] as const;
const run = it.runIf(Boolean(process.env.DATABASE_URL));
const admin = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async()=>{ await admin.end({timeout:5}); });

async function fixture() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const a = await createOrganization({ partnerId: partner.id });
    const b = await createOrganization({ partnerId: partner.id });
    const ctx: DbAccessContext = { scope: 'organization', orgId: a.id, currentPartnerId: partner.id, accessibleOrgIds: [a.id], accessiblePartnerIds: [], userId: null };
    const connection = randomUUID(), enrollment = randomUUID(), method = randomUUID(), invoice = randomUUID(), schedule = randomUUID();
    await db.execute(sql`INSERT INTO stripe_connect_accounts(id,partner_id,stripe_account_id) VALUES (${connection}::uuid,${partner.id}::uuid,${'acct_'+connection})`);
    await db.execute(sql`INSERT INTO org_autopay_enrollments(id,org_id,partner_id,stripe_connection_id,stripe_account_id) VALUES (${enrollment}::uuid,${b.id}::uuid,${partner.id}::uuid,${connection}::uuid,${'acct_'+connection})`);
    await db.execute(sql`INSERT INTO org_payment_methods(id,org_id,enrollment_id,stripe_payment_method_id,type) VALUES (${method}::uuid,${b.id}::uuid,${enrollment}::uuid,${'pm_'+method},'card')`);
    await db.execute(sql`INSERT INTO invoices(id,partner_id,org_id,currency_code) VALUES (${invoice}::uuid,${partner.id}::uuid,${b.id}::uuid,'USD')`);
    await db.execute(sql`INSERT INTO invoice_autopay_schedules(id,org_id,invoice_id,enrollment_id,enrollment_generation,eligible,terms_snapshot) VALUES (${schedule}::uuid,${b.id}::uuid,${invoice}::uuid,${enrollment}::uuid,1,true,'{}')`);
    return { partner, a, b, ctx, connection, enrollment, method, invoice, schedule };
  });
}
async function state(work: () => Promise<unknown>) {
  try { await work(); return undefined; }
  catch (e) { return (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as {code?: string}).code; }
}
describe('autopay foundation PostgreSQL contracts', () => {
  run('replays the five creating migrations without changing their schema', async()=>{
    for (const name of ['2026-11-20-100000-autopay-enums.sql','2026-11-20-100100-billing-payment-settings.sql','2026-11-20-100200-org-autopay-enrollments-methods-consents.sql','2026-11-20-100300-invoice-autopay-schedules-attempts.sql','2026-11-20-100400-billing-notice-outbox-link-tokens.sql']) {
      const body=readFileSync(join(__dirname,'../../../migrations',name),'utf8');
      for(let n=0;n<2;n++) await admin.begin(async tx=>{ await tx.unsafe(body); });
    }
  });
  run('matches every Drizzle column and unique constraint, and defers composite org foreign keys', async()=>{
    const definitions=[autopaySchema.billingPaymentSettings,autopaySchema.orgAutopayEnrollments,autopaySchema.orgAutopayConsents,autopaySchema.orgPaymentMethods,autopaySchema.invoiceAutopaySchedules,autopaySchema.invoiceCollectionAttempts,autopaySchema.billingNoticeOutbox,autopaySchema.billingLinkTokens];
    const normalized=(value:string)=>value.replaceAll('"','').replace(/\s/g,'').replace(/^char\(/,'character(');
    for(const table of definitions){
      const cfg=getTableConfig(table);
      const columns=await admin`SELECT attname AS name,attnotnull AS required,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=to_regclass(${cfg.name}) AND attnum>0 AND NOT attisdropped ORDER BY attname`;
      expect(columns.map(c=>[c.name,c.required,normalized(c.type)])).toEqual(cfg.columns.map(c=>[c.name,c.notNull,normalized(c.getSQLType())]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
      const uniques=await admin`SELECT conname FROM pg_constraint WHERE conrelid=to_regclass(${cfg.name}) AND contype='u' ORDER BY conname`;
      expect(uniques.map(u=>u.conname).sort()).toEqual(cfg.uniqueConstraints.map(u=>u.name).sort());
      const constraints=await admin`SELECT c.condeferrable,c.condeferred FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.conrelid=to_regclass(${cfg.name}) AND c.contype='f' AND cardinality(c.conkey)>1 AND a.attname='org_id'`;
      for(const fk of constraints) expect(fk).toMatchObject({condeferrable:true,condeferred:false});
    }
  });
  run('keeps all nine PostgreSQL enum vocabularies identical to C3',async()=>{
    const pairs=[['autopay_enrollment_status',vocabulary.AUTOPAY_ENROLLMENT_STATUSES],['autopay_schedule_state',vocabulary.AUTOPAY_SCHEDULE_STATES],['collection_attempt_state',vocabulary.COLLECTION_ATTEMPT_STATES],['billing_notice_kind',vocabulary.BILLING_NOTICE_KINDS],['billing_notice_status',vocabulary.BILLING_NOTICE_STATUSES],['billing_link_purpose',vocabulary.BILLING_LINK_PURPOSES],['org_payment_method_status',vocabulary.ORG_PAYMENT_METHOD_STATUSES],['ach_mode',vocabulary.ACH_MODES],['autopay_offset_rule',vocabulary.AUTOPAY_OFFSET_RULES]] as const;
    for(const [name,values] of pairs){
      const rows=await admin`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname=${name} ORDER BY e.enumsortorder`;
      expect(rows.map(r=>r.enumlabel)).toEqual([...values]);
    }
  });
  run('rejects incomplete enabled-cap tuples instead of accepting SQL UNKNOWN',async()=>{
    const f=await fixture();
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings(org_id,autopay_cap_enabled,autopay_cap_currency) VALUES (${f.a.id}::uuid,true,'USD')`)))).toBe('23514');
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings(org_id,autopay_cap_enabled,autopay_cap_amount) VALUES (${f.a.id}::uuid,true,50)`)))).toBe('23514');
  });
  run('does not grant org tokens cross-partner defaults or partner-scope writes',async()=>{
    const f=await fixture();
    const other=await withSystemDbAccessContext(()=>createPartner());
    await withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings(partner_id) VALUES (${other.id}::uuid)`));
    const visible=await withDbAccessContext(f.ctx,()=>db.execute(sql`SELECT id FROM billing_payment_settings WHERE partner_id=${other.id}::uuid`));
    expect(visible).toHaveLength(0);
    expect(await state(()=>withDbAccessContext(f.ctx,()=>db.execute(sql`INSERT INTO billing_payment_settings(partner_id) VALUES (${f.partner.id}::uuid)`)))).toBe('42501');
  });
  run('startup privilege refresh preserves consent revocations',async()=>{
    const prior=process.env.BREEZE_APP_DB_PASSWORD;
    process.env.BREEZE_APP_DB_PASSWORD=decodeURIComponent(new URL(process.env.DATABASE_URL_APP!).password);
    try { expect(await ensureAppRole()).toBe(true); }
    finally { if(prior===undefined) delete process.env.BREEZE_APP_DB_PASSWORD; else process.env.BREEZE_APP_DB_PASSWORD=prior; }
    const rows=await admin`SELECT has_table_privilege('breeze_app','org_autopay_consents','UPDATE') AS u,has_table_privilege('breeze_app','org_autopay_consents','DELETE') AS d`;
    expect(rows[0]).toMatchObject({u:false,d:false});
  });

  run('has forced RLS for every table and an unprivileged application pool', async () => {
    const f = await fixture();
    await withDbAccessContext(f.ctx, async () => {
      const roles = await db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname=current_user`);
      expect(roles[0]).toMatchObject({ who: 'breeze_app', rolbypassrls: false });
      for (const name of tables) {
        const rows = await db.execute(sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass(${name})`);
        expect(rows[0]).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});
      }
    });
  });
  for (const table of tables) run(`rejects cross-org forged INSERT into ${table} with 42501`, async () => {
    const f = await fixture();
    const q = {
      billing_payment_settings: sql`INSERT INTO billing_payment_settings(org_id) VALUES (${f.b.id}::uuid)`,
      org_autopay_enrollments: sql`INSERT INTO org_autopay_enrollments(org_id,partner_id,stripe_connection_id,stripe_account_id) VALUES (${f.b.id}::uuid,${f.partner.id}::uuid,${f.connection}::uuid,'acct_forge')`,
      org_autopay_consents: sql`INSERT INTO org_autopay_consents(org_id,enrollment_id,generation,payment_method_id,consent_text_version,consent_text_hash,fee_terms,schedule_terms,contact_email,source) VALUES (${f.b.id}::uuid,${f.enrollment}::uuid,1,${f.method}::uuid,'v1','hash','{}','{}','client@example.com','setup_page')`,
      org_payment_methods: sql`INSERT INTO org_payment_methods(org_id,enrollment_id,stripe_payment_method_id,type) VALUES (${f.b.id}::uuid,${f.enrollment}::uuid,'pm_forge','card')`,
      invoice_autopay_schedules: sql`INSERT INTO invoice_autopay_schedules(org_id,invoice_id,enrollment_id,enrollment_generation,eligible,terms_snapshot) VALUES (${f.b.id}::uuid,${f.invoice}::uuid,${f.enrollment}::uuid,1,true,'{}')`,
      invoice_collection_attempts: sql`INSERT INTO invoice_collection_attempts(org_id,invoice_id,schedule_id,attempt_no,payment_method_id,idempotency_key,principal_amount,currency,initiated_by) VALUES (${f.b.id}::uuid,${f.invoice}::uuid,${f.schedule}::uuid,1,${f.method}::uuid,${randomUUID()},1,'USD','scheduler')`,
      billing_notice_outbox: sql`INSERT INTO billing_notice_outbox(org_id,invoice_id,kind,seq,dedupe_key,to_email,rendered) VALUES (${f.b.id}::uuid,${f.invoice}::uuid,'payment_receipt',1,${randomUUID()},'client@example.com','{}')`,
      billing_link_tokens: sql`INSERT INTO billing_link_tokens(org_id,purpose,token_hash,token_ct,expires_at) VALUES (${f.b.id}::uuid,'stop_autopay',${randomUUID()},'ciphertext',now()+interval '1 day')`,
    }[table];
    expect(await state(() => withDbAccessContext(f.ctx, () => db.execute(q!)))).toBe('42501');
  });
  run('org token reads inherited defaults but cannot update them, and XOR rejects both/neither owners', async () => {
    const f=await fixture();
    await withSystemDbAccessContext(() => db.execute(sql`INSERT INTO billing_payment_settings(partner_id,autopay_offset_days) VALUES (${f.partner.id}::uuid,9)`));
    const rows=await withDbAccessContext(f.ctx,()=>db.execute(sql`SELECT autopay_offset_days FROM billing_payment_settings WHERE partner_id=${f.partner.id}::uuid`));
    expect(rows).toHaveLength(1); expect(rows[0]!.autopay_offset_days).toBe(9);
    const changed=await withDbAccessContext(f.ctx,()=>db.execute(sql`UPDATE billing_payment_settings SET autopay_offset_days=1 WHERE partner_id=${f.partner.id}::uuid RETURNING id`));
    expect(changed).toHaveLength(0);
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings(org_id,partner_id) VALUES (${f.a.id}::uuid,${f.partner.id}::uuid)`)))).toBe('23514');
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings DEFAULT VALUES`)))).toBe('23514');
  });
  run('consent remains append-only even under system scope', async () => {
    const f=await fixture();
    const [consent]=await withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO org_autopay_consents(org_id,enrollment_id,generation,payment_method_id,consent_text_version,consent_text_hash,fee_terms,schedule_terms,contact_email,source) VALUES (${f.b.id}::uuid,${f.enrollment}::uuid,1,${f.method}::uuid,'v1','hash','{}','{}','client@example.com','setup_page') RETURNING id`));
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`UPDATE org_autopay_consents SET contact_email='changed@example.com' WHERE id=${consent!.id}::uuid`)))).toBe('42501');
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`DELETE FROM org_autopay_consents WHERE id=${consent!.id}::uuid`)))).toBe('42501');
    const grants=await withSystemDbAccessContext(()=>db.execute(sql`SELECT has_table_privilege('breeze_app','org_autopay_consents','UPDATE') AS u,has_table_privilege('breeze_app','org_autopay_consents','DELETE') AS d`));
    expect(grants[0]).toMatchObject({u:false,d:false});
    await expect(admin.begin(async tx=>{
      await tx`SELECT set_config('breeze.scope','system',true)`;
      await tx`UPDATE org_autopay_consents SET contact_email='changed@example.com' WHERE id=${consent!.id}`;
    })).rejects.toMatchObject({code:'55000'});
    await withSystemDbAccessContext(async()=>{
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention='1'`);
      const removed=await db.execute(sql`DELETE FROM org_autopay_consents WHERE id=${consent!.id}::uuid RETURNING id`);
      expect(removed).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/autopayFoundation.integration.test.ts`; import `../../db/schema/autopay` is missing before the schema implementation.
- [ ] **Step 3: Implement** — use the complete SQL below. The settings inheritance SELECT policy is deliberately separate from its write policy. Monetary bounds are SQL checks as well as later HTTP validation. Nullable historical authority links are allowed only after cancellation/terminal outcomes; live rows always retain same-org composite references.

`apps/api/migrations/2026-11-20-100100-billing-payment-settings.sql`:

```sql
SELECT set_config('breeze.scope','system',true);
CREATE TABLE IF NOT EXISTS billing_payment_settings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid REFERENCES organizations(id),
 partner_id uuid REFERENCES partners(id),
 autopay_offset_days integer CHECK (autopay_offset_days BETWEEN 0 AND 60),
 autopay_offset_rule autopay_offset_rule,
 autopay_cap_enabled boolean,
 autopay_cap_amount numeric(12,2),
 autopay_cap_currency char(3),
 ach_mode ach_mode,
 card_fee_bps integer CHECK (card_fee_bps BETWEEN 0 AND 300),
 ach_fee_amount numeric(12,2) CHECK (ach_fee_amount BETWEEN 0 AND 25),
 fee_attested_by uuid REFERENCES users(id),
 fee_attested_at timestamptz,
 reminders_enabled boolean,
 reminder_before_due_days integer CHECK (reminder_before_due_days BETWEEN 1 AND 31),
 reminder_repeat_days integer CHECK (reminder_repeat_days BETWEEN 1 AND 31),
 overdue_reminder_every_days integer CHECK (overdue_reminder_every_days BETWEEN 1 AND 31),
 CONSTRAINT billing_payment_settings_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
 CONSTRAINT billing_payment_settings_cap_chk CHECK ((autopay_cap_enabled IS TRUE AND autopay_cap_amount IS NOT NULL AND autopay_cap_currency IS NOT NULL AND autopay_cap_amount > 0 AND autopay_cap_currency ~ '^[A-Z]{3}$') OR (autopay_cap_enabled IS NOT TRUE AND autopay_cap_amount IS NULL AND autopay_cap_currency IS NULL)),
 CONSTRAINT billing_payment_settings_attestation_chk CHECK ((fee_attested_by IS NULL) = (fee_attested_at IS NULL) AND (org_id IS NULL OR fee_attested_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_settings_partner_uq ON billing_payment_settings(partner_id) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_payment_settings_org_uq ON billing_payment_settings(org_id) WHERE org_id IS NOT NULL;
ALTER TABLE billing_payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payment_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON billing_payment_settings;
CREATE POLICY breeze_autopay_tenant ON billing_payment_settings FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON billing_payment_settings TO breeze_app;
DROP POLICY IF EXISTS billing_payment_settings_partner_default_select ON billing_payment_settings;
CREATE POLICY billing_payment_settings_partner_default_select ON billing_payment_settings FOR SELECT USING (org_id IS NULL AND partner_id=public.breeze_current_partner_id());
```

`apps/api/migrations/2026-11-20-100200-org-autopay-enrollments-methods-consents.sql`:

```sql
SELECT set_config('breeze.scope','system',true);
CREATE TABLE IF NOT EXISTS org_autopay_enrollments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 partner_id uuid NOT NULL REFERENCES partners(id),
 status autopay_enrollment_status NOT NULL DEFAULT 'requested',
 generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
 stripe_connection_id uuid NOT NULL,
 stripe_account_id text NOT NULL,
 stripe_customer_id text,
 effective_from timestamptz,
 requested_by uuid,
 requested_at timestamptz,
 request_recipient_email text,
 paused_by uuid,
 paused_at timestamptz,
 cancelled_at timestamptz,
 cancel_source text CHECK (cancel_source IN ('client','msp','system')),
 cancel_reason text,
 needs_attention_reason text CHECK (needs_attention_reason IN ('method_unusable','stripe_account_changed','key_missing_permissions','verification_failed')),
 CONSTRAINT org_autopay_enrollments_org_id_unique UNIQUE (org_id), CONSTRAINT org_autopay_enrollments_id_org_id_unique UNIQUE (id,org_id),
 CONSTRAINT org_autopay_enrollments_org_partner_fk FOREIGN KEY (org_id,partner_id) REFERENCES organizations(id,partner_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT org_autopay_enrollments_connection_partner_fk FOREIGN KEY (stripe_connection_id,partner_id) REFERENCES stripe_connect_accounts(id,partner_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE TABLE IF NOT EXISTS org_payment_methods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 enrollment_id uuid NOT NULL,
 stripe_payment_method_id text NOT NULL,
 type text NOT NULL CHECK (type IN ('card','us_bank_account')),
 card_brand text,
 card_last4 text,
 card_exp_month integer CHECK (card_exp_month BETWEEN 1 AND 12),
 card_exp_year integer,
 card_funding text CHECK (card_funding IN ('credit','debit','prepaid','unknown')),
 card_country text,
 bank_name text,
 bank_last4 text,
 account_holder_type text CHECK (account_holder_type IN ('individual','company')),
 stripe_mandate_id text,
 stripe_setup_intent_id text,
 status org_payment_method_status NOT NULL DEFAULT 'pending_verification',
 unusable_reason text,
 is_autopay_method boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 removed_at timestamptz,
 CONSTRAINT org_payment_methods_id_org_id_unique UNIQUE (id,org_id),
 CONSTRAINT org_payment_methods_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS org_payment_methods_autopay_uq ON org_payment_methods(org_id) WHERE is_autopay_method AND status IN ('active','pending_verification');
CREATE TABLE IF NOT EXISTS org_autopay_consents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 enrollment_id uuid NOT NULL,
 generation integer NOT NULL CHECK (generation > 0),
 payment_method_id uuid NOT NULL,
 consent_text_version text NOT NULL,
 consent_text_hash text NOT NULL,
 fee_terms jsonb NOT NULL,
 schedule_terms jsonb NOT NULL,
 contact_email text NOT NULL,
 ip text,
 user_agent text,
 source text NOT NULL CHECK (source IN ('setup_page','pay_and_save','portal')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT org_autopay_consents_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT org_autopay_consents_method_org_fk FOREIGN KEY (payment_method_id,org_id) REFERENCES org_payment_methods(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
ALTER TABLE org_autopay_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_autopay_enrollments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON org_autopay_enrollments;
CREATE POLICY breeze_autopay_tenant ON org_autopay_enrollments FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON org_autopay_enrollments TO breeze_app;
ALTER TABLE org_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_payment_methods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON org_payment_methods;
CREATE POLICY breeze_autopay_tenant ON org_payment_methods FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON org_payment_methods TO breeze_app;
ALTER TABLE org_autopay_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_autopay_consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON org_autopay_consents;
CREATE POLICY breeze_autopay_tenant ON org_autopay_consents FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON org_autopay_consents TO breeze_app;
REVOKE UPDATE,DELETE,TRUNCATE ON org_autopay_consents FROM breeze_app,PUBLIC;
GRANT SELECT,DELETE ON org_autopay_consents TO breeze_audit_admin;
REVOKE INSERT,UPDATE,TRUNCATE ON org_autopay_consents FROM breeze_audit_admin;
CREATE OR REPLACE FUNCTION org_autopay_consents_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='breeze_audit_admin' AND current_setting('breeze.allow_audit_retention',true)='1' THEN RETURN OLD; END IF;
 RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='autopay consents are append-only';
END $$;
DROP TRIGGER IF EXISTS org_autopay_consents_immutable ON org_autopay_consents;
CREATE TRIGGER org_autopay_consents_immutable BEFORE UPDATE OR DELETE ON org_autopay_consents FOR EACH ROW EXECUTE FUNCTION org_autopay_consents_immutable();
```

`apps/api/migrations/2026-11-20-100300-invoice-autopay-schedules-attempts.sql`:

```sql
SELECT set_config('breeze.scope','system',true);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_stripe_payments_id_org_uq ON invoice_stripe_payments(id,org_id);
CREATE TABLE IF NOT EXISTS invoice_autopay_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 invoice_id uuid NOT NULL,
 enrollment_id uuid,
 enrollment_generation integer NOT NULL,
 eligible boolean NOT NULL,
 ineligible_reason text CHECK (ineligible_reason IN ('not_enrolled','enrolled_after_issue','method_not_usable','over_cap','cap_currency_mismatch','ach_currency_unsupported','excluded_contract','excluded_invoice','charging_disabled','stripe_unavailable')),
 collect_on date,
 terms_snapshot jsonb NOT NULL,
 notice_outbox_id uuid,
 notice_sent_at timestamptz,
 state autopay_schedule_state NOT NULL DEFAULT 'awaiting_notice',
 state_reason text,
 next_attempt_at timestamptz,
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
 client_skipped_at timestamptz,
 msp_excluded_by uuid,
 msp_excluded_at timestamptz,
 CONSTRAINT invoice_autopay_schedules_invoice_id_unique UNIQUE (invoice_id), CONSTRAINT invoice_autopay_schedules_id_org_id_unique UNIQUE (id,org_id),
 CONSTRAINT invoice_autopay_schedules_authority_chk CHECK (enrollment_id IS NOT NULL OR state IN ('succeeded','failed','skipped_by_client','excluded_by_msp','cancelled','not_needed')),
 CONSTRAINT invoice_autopay_schedules_invoice_org_fk FOREIGN KEY (invoice_id,org_id) REFERENCES invoices(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT invoice_autopay_schedules_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS invoice_autopay_schedules_due_idx ON invoice_autopay_schedules(state,collect_on,next_attempt_at);
CREATE TABLE IF NOT EXISTS invoice_collection_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 invoice_id uuid NOT NULL,
 schedule_id uuid,
 attempt_no integer NOT NULL CHECK (attempt_no > 0),
 payment_method_id uuid,
 stripe_payment_intent_id text,
 idempotency_key text NOT NULL,
 principal_amount numeric(12,2) NOT NULL CHECK (principal_amount > 0),
 fee_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
 currency char(3) NOT NULL,
 state collection_attempt_state NOT NULL DEFAULT 'reserved',
 failure_code text,
 decline_code text,
 failure_class text CHECK (failure_class IN ('soft','hard','auth_required','nsf','revoked')),
 invoice_stripe_payment_id uuid,
 initiated_by text NOT NULL CHECK (initiated_by IN ('scheduler','msp_charge_now','client_on_session')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT invoice_collection_attempts_idempotency_key_unique UNIQUE (idempotency_key), CONSTRAINT invoice_collection_attempts_stripe_payment_intent_id_unique UNIQUE (stripe_payment_intent_id), CONSTRAINT invoice_collection_attempts_schedule_id_attempt_no_unique UNIQUE (schedule_id,attempt_no),
 CONSTRAINT invoice_collection_attempts_schedule_chk CHECK (schedule_id IS NOT NULL OR initiated_by='client_on_session'),
 CONSTRAINT invoice_collection_attempts_authority_chk CHECK (payment_method_id IS NOT NULL OR state IN ('succeeded','failed','canceled','unapplied')),
 CONSTRAINT invoice_collection_attempts_invoice_org_fk FOREIGN KEY (invoice_id,org_id) REFERENCES invoices(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT invoice_collection_attempts_schedule_org_fk FOREIGN KEY (schedule_id,org_id) REFERENCES invoice_autopay_schedules(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT invoice_collection_attempts_method_org_fk FOREIGN KEY (payment_method_id,org_id) REFERENCES org_payment_methods(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT invoice_collection_attempts_mapping_org_fk FOREIGN KEY (invoice_stripe_payment_id,org_id) REFERENCES invoice_stripe_payments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS invoice_collection_attempts_active_idx ON invoice_collection_attempts(invoice_id,state) WHERE state IN ('reserved','created','confirming','processing');
ALTER TABLE invoice_autopay_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_autopay_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON invoice_autopay_schedules;
CREATE POLICY breeze_autopay_tenant ON invoice_autopay_schedules FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON invoice_autopay_schedules TO breeze_app;
ALTER TABLE invoice_collection_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_collection_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON invoice_collection_attempts;
CREATE POLICY breeze_autopay_tenant ON invoice_collection_attempts FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON invoice_collection_attempts TO breeze_app;
```

`apps/api/migrations/2026-11-20-100400-billing-notice-outbox-link-tokens.sql`:

```sql
SELECT set_config('breeze.scope','system',true);
CREATE TABLE IF NOT EXISTS billing_notice_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 invoice_id uuid,
 enrollment_id uuid,
 kind billing_notice_kind NOT NULL,
 seq integer NOT NULL CHECK (seq >= 0),
 dedupe_key text NOT NULL,
 to_email text NOT NULL,
 rendered jsonb NOT NULL,
 status billing_notice_status NOT NULL DEFAULT 'pending',
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 provider_message_id text,
 last_error text,
 CONSTRAINT billing_notice_outbox_dedupe_key_unique UNIQUE (dedupe_key), CONSTRAINT billing_notice_outbox_id_org_id_unique UNIQUE (id,org_id),
 CONSTRAINT billing_notice_outbox_invoice_org_fk FOREIGN KEY (invoice_id,org_id) REFERENCES invoices(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT billing_notice_outbox_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS billing_notice_outbox_dispatch_idx ON billing_notice_outbox(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS billing_link_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 purpose billing_link_purpose NOT NULL,
 token_hash text NOT NULL,
 token_ct text NOT NULL,
 enrollment_id uuid,
 invoice_id uuid,
 generation integer CHECK (generation > 0),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 revoked_at timestamptz,
 CONSTRAINT billing_link_tokens_token_hash_unique UNIQUE (token_hash),
 CONSTRAINT billing_link_tokens_invoice_org_fk FOREIGN KEY (invoice_id,org_id) REFERENCES invoices(id,org_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT billing_link_tokens_enrollment_org_fk FOREIGN KEY (enrollment_id,org_id) REFERENCES org_autopay_enrollments(id,org_id) DEFERRABLE INITIALLY IMMEDIATE
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invoice_autopay_schedules_notice_org_fk') THEN
  ALTER TABLE invoice_autopay_schedules ADD CONSTRAINT invoice_autopay_schedules_notice_org_fk FOREIGN KEY (notice_outbox_id,org_id) REFERENCES billing_notice_outbox(id,org_id) DEFERRABLE INITIALLY IMMEDIATE;
 END IF;
END $$;
ALTER TABLE billing_notice_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_notice_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON billing_notice_outbox;
CREATE POLICY breeze_autopay_tenant ON billing_notice_outbox FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON billing_notice_outbox TO breeze_app;
ALTER TABLE billing_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_link_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_autopay_tenant ON billing_link_tokens;
CREATE POLICY breeze_autopay_tenant ON billing_link_tokens FOR ALL USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id)) WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON billing_link_tokens TO breeze_app;
```

Create `apps/api/src/db/schema/autopay.ts`. PostgreSQL owns DEFERRABLE attributes, which this Drizzle FK builder does not expose.

```ts
import { pgTable, uuid, text, boolean, integer, numeric, jsonb, date, timestamp, char, pgEnum, check, unique, uniqueIndex, index, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, partners } from './orgs';
import { users } from './users';
import { invoices } from './invoices';
import { stripeConnectAccounts, invoiceStripePayments } from './stripePayments';
import { AUTOPAY_ENROLLMENT_STATUSES, AUTOPAY_SCHEDULE_STATES, COLLECTION_ATTEMPT_STATES, BILLING_NOTICE_KINDS, BILLING_NOTICE_STATUSES, BILLING_LINK_PURPOSES, ORG_PAYMENT_METHOD_STATUSES, ACH_MODES, AUTOPAY_OFFSET_RULES } from '@breeze/shared';
export const autopayEnrollmentStatusEnum = pgEnum('autopay_enrollment_status', [...AUTOPAY_ENROLLMENT_STATUSES]);
export const autopayScheduleStateEnum = pgEnum('autopay_schedule_state', [...AUTOPAY_SCHEDULE_STATES]);
export const collectionAttemptStateEnum = pgEnum('collection_attempt_state', [...COLLECTION_ATTEMPT_STATES]);
export const billingNoticeKindEnum = pgEnum('billing_notice_kind', [...BILLING_NOTICE_KINDS]);
export const billingNoticeStatusEnum = pgEnum('billing_notice_status', [...BILLING_NOTICE_STATUSES]);
export const billingLinkPurposeEnum = pgEnum('billing_link_purpose', [...BILLING_LINK_PURPOSES]);
export const orgPaymentMethodStatusEnum = pgEnum('org_payment_method_status', [...ORG_PAYMENT_METHOD_STATUSES]);
export const achModeEnum = pgEnum('ach_mode', [...ACH_MODES]);
export const autopayOffsetRuleEnum = pgEnum('autopay_offset_rule', [...AUTOPAY_OFFSET_RULES]);

export const billingPaymentSettings = pgTable('billing_payment_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  autopayOffsetDays: integer('autopay_offset_days'),
  autopayOffsetRule: autopayOffsetRuleEnum('autopay_offset_rule'),
  autopayCapEnabled: boolean('autopay_cap_enabled'),
  autopayCapAmount: numeric('autopay_cap_amount', { precision: 12, scale: 2 }),
  autopayCapCurrency: char('autopay_cap_currency', { length: 3 }),
  achMode: achModeEnum('ach_mode'),
  cardFeeBps: integer('card_fee_bps'),
  achFeeAmount: numeric('ach_fee_amount', { precision: 12, scale: 2 }),
  feeAttestedBy: uuid('fee_attested_by').references(() => users.id),
  feeAttestedAt: timestamp('fee_attested_at', { withTimezone: true }),
  remindersEnabled: boolean('reminders_enabled'),
  reminderBeforeDueDays: integer('reminder_before_due_days'),
  reminderRepeatDays: integer('reminder_repeat_days'),
  overdueReminderEveryDays: integer('overdue_reminder_every_days'),
}, (t) => [
  check('billing_payment_settings_autopay_offset_days_check', sql`${t.autopayOffsetDays} BETWEEN 0 AND 60`),
  check('billing_payment_settings_card_fee_bps_check', sql`${t.cardFeeBps} BETWEEN 0 AND 300`),
  check('billing_payment_settings_ach_fee_amount_check', sql`${t.achFeeAmount} BETWEEN 0 AND 25`),
  check('billing_payment_settings_reminder_before_due_days_check', sql`${t.reminderBeforeDueDays} BETWEEN 1 AND 31`),
  check('billing_payment_settings_reminder_repeat_days_check', sql`${t.reminderRepeatDays} BETWEEN 1 AND 31`),
  check('billing_payment_settings_overdue_reminder_every_days_check', sql`${t.overdueReminderEveryDays} BETWEEN 1 AND 31`),
  check('billing_payment_settings_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  check('billing_payment_settings_cap_chk', sql`(${t.autopayCapEnabled} IS TRUE AND ${t.autopayCapAmount} IS NOT NULL AND ${t.autopayCapCurrency} IS NOT NULL AND ${t.autopayCapAmount} > 0 AND ${t.autopayCapCurrency} ~ '^[A-Z]{3}$') OR (${t.autopayCapEnabled} IS NOT TRUE AND ${t.autopayCapAmount} IS NULL AND ${t.autopayCapCurrency} IS NULL)`),
  check('billing_payment_settings_attestation_chk', sql`(${t.feeAttestedBy} IS NULL) = (${t.feeAttestedAt} IS NULL) AND (${t.orgId} IS NULL OR ${t.feeAttestedAt} IS NULL)`),
  uniqueIndex('billing_payment_settings_partner_uq').on(t.partnerId).where(sql`${t.partnerId} IS NOT NULL`),
  uniqueIndex('billing_payment_settings_org_uq').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
]);

export const orgAutopayEnrollments = pgTable('org_autopay_enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  status: autopayEnrollmentStatusEnum('status').notNull().default('requested'),
  generation: integer('generation').notNull().default(1),
  stripeConnectionId: uuid('stripe_connection_id').notNull(),
  stripeAccountId: text('stripe_account_id').notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }),
  requestedBy: uuid('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }),
  requestRecipientEmail: text('request_recipient_email'),
  pausedBy: uuid('paused_by'),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelSource: text('cancel_source').$type<'client' | 'msp' | 'system'>(),
  cancelReason: text('cancel_reason'),
  needsAttentionReason: text('needs_attention_reason'),
}, (t) => [
  check('org_autopay_enrollments_generation_check', sql`${t.generation} > 0`),
  check('org_autopay_enrollments_cancel_source_check', sql`${t.cancelSource} IN ('client','msp','system')`),
  check('org_autopay_enrollments_needs_attention_reason_check', sql`${t.needsAttentionReason} IN ('method_unusable','stripe_account_changed','key_missing_permissions','verification_failed')`),
  unique().on(t.orgId),
  unique().on(t.id,t.orgId),
  foreignKey({name:'org_autopay_enrollments_org_partner_fk',columns:[t.orgId,t.partnerId],foreignColumns:[organizations.id,organizations.partnerId]}),
  foreignKey({name:'org_autopay_enrollments_connection_partner_fk',columns:[t.stripeConnectionId,t.partnerId],foreignColumns:[stripeConnectAccounts.id,stripeConnectAccounts.partnerId]}),
]);

export const orgPaymentMethods = pgTable('org_payment_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  enrollmentId: uuid('enrollment_id').notNull(),
  stripePaymentMethodId: text('stripe_payment_method_id').notNull(),
  type: text('type').notNull().$type<'card' | 'us_bank_account'>(),
  cardBrand: text('card_brand'),
  cardLast4: text('card_last4'),
  cardExpMonth: integer('card_exp_month'),
  cardExpYear: integer('card_exp_year'),
  cardFunding: text('card_funding').$type<'credit' | 'debit' | 'prepaid' | 'unknown'>(),
  cardCountry: text('card_country'),
  bankName: text('bank_name'),
  bankLast4: text('bank_last4'),
  accountHolderType: text('account_holder_type').$type<'individual' | 'company'>(),
  stripeMandateId: text('stripe_mandate_id'),
  stripeSetupIntentId: text('stripe_setup_intent_id'),
  status: orgPaymentMethodStatusEnum('status').notNull().default('pending_verification'),
  unusableReason: text('unusable_reason'),
  isAutopayMethod: boolean('is_autopay_method').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => [
  check('org_payment_methods_type_check', sql`${t.type} IN ('card','us_bank_account')`),
  check('org_payment_methods_card_exp_month_check', sql`${t.cardExpMonth} BETWEEN 1 AND 12`),
  check('org_payment_methods_card_funding_check', sql`${t.cardFunding} IN ('credit','debit','prepaid','unknown')`),
  check('org_payment_methods_account_holder_type_check', sql`${t.accountHolderType} IN ('individual','company')`),
  unique().on(t.id,t.orgId),
  foreignKey({name:'org_payment_methods_enrollment_org_fk',columns:[t.enrollmentId,t.orgId],foreignColumns:[orgAutopayEnrollments.id,orgAutopayEnrollments.orgId]}),
  uniqueIndex('org_payment_methods_autopay_uq').on(t.orgId).where(sql`${t.isAutopayMethod} AND ${t.status} IN ('active','pending_verification')`),
]);

export const orgAutopayConsents = pgTable('org_autopay_consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  enrollmentId: uuid('enrollment_id').notNull(),
  generation: integer('generation').notNull(),
  paymentMethodId: uuid('payment_method_id').notNull(),
  consentTextVersion: text('consent_text_version').notNull(),
  consentTextHash: text('consent_text_hash').notNull(),
  feeTerms: jsonb('fee_terms').notNull(),
  scheduleTerms: jsonb('schedule_terms').notNull(),
  contactEmail: text('contact_email').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('org_autopay_consents_generation_check', sql`${t.generation} > 0`),
  check('org_autopay_consents_source_check', sql`${t.source} IN ('setup_page','pay_and_save','portal')`),
  foreignKey({name:'org_autopay_consents_enrollment_org_fk',columns:[t.enrollmentId,t.orgId],foreignColumns:[orgAutopayEnrollments.id,orgAutopayEnrollments.orgId]}),
  foreignKey({name:'org_autopay_consents_method_org_fk',columns:[t.paymentMethodId,t.orgId],foreignColumns:[orgPaymentMethods.id,orgPaymentMethods.orgId]}),
]);

export const billingNoticeOutbox = pgTable('billing_notice_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  invoiceId: uuid('invoice_id'),
  enrollmentId: uuid('enrollment_id'),
  kind: billingNoticeKindEnum('kind').notNull(),
  seq: integer('seq').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  toEmail: text('to_email').notNull(),
  rendered: jsonb('rendered').notNull(),
  status: billingNoticeStatusEnum('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  providerMessageId: text('provider_message_id'),
  lastError: text('last_error'),
}, (t) => [
  check('billing_notice_outbox_seq_check', sql`${t.seq} >= 0`),
  check('billing_notice_outbox_attempts_check', sql`${t.attempts} >= 0`),
  unique().on(t.dedupeKey),
  unique().on(t.id,t.orgId),
  foreignKey({name:'billing_notice_outbox_invoice_org_fk',columns:[t.invoiceId,t.orgId],foreignColumns:[invoices.id,invoices.orgId]}),
  foreignKey({name:'billing_notice_outbox_enrollment_org_fk',columns:[t.enrollmentId,t.orgId],foreignColumns:[orgAutopayEnrollments.id,orgAutopayEnrollments.orgId]}),
  index('billing_notice_outbox_dispatch_idx').on(t.status,t.nextAttemptAt),
]);

export const invoiceAutopaySchedules = pgTable('invoice_autopay_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  invoiceId: uuid('invoice_id').notNull(),
  enrollmentId: uuid('enrollment_id'),
  enrollmentGeneration: integer('enrollment_generation').notNull(),
  eligible: boolean('eligible').notNull(),
  ineligibleReason: text('ineligible_reason'),
  collectOn: date('collect_on'),
  termsSnapshot: jsonb('terms_snapshot').notNull(),
  noticeOutboxId: uuid('notice_outbox_id'),
  noticeSentAt: timestamp('notice_sent_at', { withTimezone: true }),
  state: autopayScheduleStateEnum('state').notNull().default('awaiting_notice'),
  stateReason: text('state_reason'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
  clientSkippedAt: timestamp('client_skipped_at', { withTimezone: true }),
  mspExcludedBy: uuid('msp_excluded_by'),
  mspExcludedAt: timestamp('msp_excluded_at', { withTimezone: true }),
}, (t) => [
  check('invoice_autopay_schedules_ineligible_reason_check', sql`${t.ineligibleReason} IN ('not_enrolled','enrolled_after_issue','method_not_usable','over_cap','cap_currency_mismatch','ach_currency_unsupported','excluded_contract','excluded_invoice','charging_disabled','stripe_unavailable')`),
  check('invoice_autopay_schedules_attempt_count_check', sql`${t.attemptCount} >= 0`),
  check('invoice_autopay_schedules_authority_chk', sql`${t.enrollmentId} IS NOT NULL OR ${t.state} IN ('succeeded','failed','skipped_by_client','excluded_by_msp','cancelled','not_needed')`),
  unique().on(t.invoiceId),
  unique().on(t.id,t.orgId),
  foreignKey({name:'invoice_autopay_schedules_invoice_org_fk',columns:[t.invoiceId,t.orgId],foreignColumns:[invoices.id,invoices.orgId]}),
  foreignKey({name:'invoice_autopay_schedules_enrollment_org_fk',columns:[t.enrollmentId,t.orgId],foreignColumns:[orgAutopayEnrollments.id,orgAutopayEnrollments.orgId]}),
  foreignKey({name:'invoice_autopay_schedules_notice_org_fk',columns:[t.noticeOutboxId,t.orgId],foreignColumns:[billingNoticeOutbox.id,billingNoticeOutbox.orgId]}),
  index('invoice_autopay_schedules_due_idx').on(t.state,t.collectOn,t.nextAttemptAt),
]);

export const invoiceCollectionAttempts = pgTable('invoice_collection_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  invoiceId: uuid('invoice_id').notNull(),
  scheduleId: uuid('schedule_id'),
  attemptNo: integer('attempt_no').notNull(),
  paymentMethodId: uuid('payment_method_id'),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  principalAmount: numeric('principal_amount', { precision: 12, scale: 2 }).notNull(),
  feeAmount: numeric('fee_amount', { precision: 12, scale: 2 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull(),
  state: collectionAttemptStateEnum('state').notNull().default('reserved'),
  failureCode: text('failure_code'),
  declineCode: text('decline_code'),
  failureClass: text('failure_class').$type<'soft' | 'hard' | 'auth_required' | 'nsf' | 'revoked'>(),
  invoiceStripePaymentId: uuid('invoice_stripe_payment_id'),
  initiatedBy: text('initiated_by').notNull().$type<'scheduler' | 'msp_charge_now' | 'client_on_session'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('invoice_collection_attempts_attempt_no_check', sql`${t.attemptNo} > 0`),
  check('invoice_collection_attempts_principal_amount_check', sql`${t.principalAmount} > 0`),
  check('invoice_collection_attempts_fee_amount_check', sql`${t.feeAmount} >= 0`),
  check('invoice_collection_attempts_failure_class_check', sql`${t.failureClass} IN ('soft','hard','auth_required','nsf','revoked')`),
  check('invoice_collection_attempts_initiated_by_check', sql`${t.initiatedBy} IN ('scheduler','msp_charge_now','client_on_session')`),
  check('invoice_collection_attempts_schedule_chk', sql`${t.scheduleId} IS NOT NULL OR ${t.initiatedBy}='client_on_session'`),
  check('invoice_collection_attempts_authority_chk', sql`${t.paymentMethodId} IS NOT NULL OR ${t.state} IN ('succeeded','failed','canceled','unapplied')`),
  unique().on(t.idempotencyKey),
  unique().on(t.stripePaymentIntentId),
  unique().on(t.scheduleId,t.attemptNo),
  foreignKey({name:'invoice_collection_attempts_invoice_org_fk',columns:[t.invoiceId,t.orgId],foreignColumns:[invoices.id,invoices.orgId]}),
  foreignKey({name:'invoice_collection_attempts_schedule_org_fk',columns:[t.scheduleId,t.orgId],foreignColumns:[invoiceAutopaySchedules.id,invoiceAutopaySchedules.orgId]}),
  foreignKey({name:'invoice_collection_attempts_method_org_fk',columns:[t.paymentMethodId,t.orgId],foreignColumns:[orgPaymentMethods.id,orgPaymentMethods.orgId]}),
  foreignKey({name:'invoice_collection_attempts_mapping_org_fk',columns:[t.invoiceStripePaymentId,t.orgId],foreignColumns:[invoiceStripePayments.id,invoiceStripePayments.orgId]}),
  index('invoice_collection_attempts_active_idx').on(t.invoiceId,t.state).where(sql`${t.state} IN ('reserved','created','confirming','processing')`),
]);

export const billingLinkTokens = pgTable('billing_link_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  purpose: billingLinkPurposeEnum('purpose').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenCt: text('token_ct').notNull(),
  enrollmentId: uuid('enrollment_id'),
  invoiceId: uuid('invoice_id'),
  generation: integer('generation'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  check('billing_link_tokens_generation_check', sql`${t.generation} > 0`),
  unique().on(t.tokenHash),
  foreignKey({name:'billing_link_tokens_invoice_org_fk',columns:[t.invoiceId,t.orgId],foreignColumns:[invoices.id,invoices.orgId]}),
  foreignKey({name:'billing_link_tokens_enrollment_org_fk',columns:[t.enrollmentId,t.orgId],foreignColumns:[orgAutopayEnrollments.id,orgAutopayEnrollments.orgId]}),
]);
```

Append to `apps/api/src/db/schema/index.ts`:

```ts
export * from './autopay';
```

In `ensureAppRole` (`apps/api/src/db/ensureAppRole.ts`), add inside the existing per-boot privilege-hardening DO block after its blanket table GRANT:

```sql
IF to_regclass('public.org_autopay_consents') IS NOT NULL THEN
 REVOKE UPDATE,DELETE,TRUNCATE ON org_autopay_consents FROM breeze_app;
END IF;
```

- [ ] **Step 4: Run it, expect PASS** — `pnpm test-stack up`; `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/autopayFoundation.integration.test.ts`; `(set -a; . ./.env.test; set +a; pnpm db:check-drift)` from repo root. This command checks migration filenames against the ledger only; the integration suite above separately replays migrations and checks Drizzle columns and constraints. SQL-only DEFERRABLE attributes remain intentional.
- [ ] **Step 5: Commit** — `git add apps/api/migrations/2026-11-20-100100-billing-payment-settings.sql apps/api/migrations/2026-11-20-100200-org-autopay-enrollments-methods-consents.sql apps/api/migrations/2026-11-20-100300-invoice-autopay-schedules-attempts.sql apps/api/migrations/2026-11-20-100400-billing-notice-outbox-link-tokens.sql apps/api/src/db/schema/autopay.ts apps/api/src/db/schema/index.ts apps/api/src/db/ensureAppRole.ts apps/api/src/__tests__/integration/autopayFoundation.integration.test.ts` then `git commit -m "feat(billing): add tenant-isolated autopay foundation tables"`.

### Task 3: Add backward-compatible billing columns and the ACH payment rail
**Files:** Create `apps/api/migrations/2026-11-20-100500-autopay-column-additions.sql`, `apps/api/src/db/schema/autopayColumns.test.ts`, `apps/api/src/services/accounting/autopayPaymentMethods.test.ts`, `apps/web/src/components/billing/invoiceTypes.test.ts`; Modify `apps/api/src/db/schema/contracts.ts`, `apps/api/src/db/schema/invoices.ts`, `apps/api/src/db/schema/stripePayments.ts`, `apps/api/src/db/schema/orgs.ts`, `packages/shared/src/types/billing-enums.ts`, `packages/shared/src/types/billing-enums.test.ts`, `apps/api/src/services/accounting/quickbooksProvider.ts`, `apps/web/src/components/billing/invoiceTypes.ts`.
**Interfaces:** Consumes existing `PaymentMethod` and `PAYMENT_METHODS` (`packages/shared/src/types/billing-enums.ts`), `mapQboPaymentMethod` (`quickbooksProvider.ts`), `toChangeSetPaymentLine` (`xeroPayments.ts`) · Produces C2's exact column additions and `'ach_debit'` throughout the shared type, database enum and exhaustive web label mapping. Existing Checkout rows keep `feeAmount='0'`, `source='checkout'`, `paymentMethodType=null`; money plumbing interprets that historical null as card.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/db/schema/autopayColumns.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PAYMENT_METHODS } from '@breeze/shared';
import { contracts } from './contracts';
import { invoices, paymentMethodEnum } from './invoices';
import { partners } from './orgs';
import { invoiceStripePayments, stripeConnectAccounts } from './stripePayments';

describe('autopay additions preserve historical defaults', () => {
  it('defaults every exclusion and rollout to false and every historical fee to zero', () => {
    expect(contracts.autopayExcluded.default).toBe(false);
    expect(invoices.autopayExcluded.default).toBe(false);
    expect(partners.autopayEnabled.default).toBe(false);
    expect(invoiceStripePayments.feeAmount.default).toBe('0');
    expect(invoiceStripePayments.source.default).toBe('checkout');
    expect(invoiceStripePayments.paymentMethodType.notNull).toBe(false);
    expect(stripeConnectAccounts.autopayMissingPermissions.notNull).toBe(true);
  });
  it('appends ACH without reordering historical enum values', () => {
    expect(PAYMENT_METHODS).toEqual(['cash','check','bank_transfer','card','other','ach_debit']);
    expect(paymentMethodEnum.enumValues).toEqual(PAYMENT_METHODS);
  });
});
```

Create `apps/api/src/services/accounting/autopayPaymentMethods.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapQboPaymentMethod } from './quickbooksProvider';
import { toChangeSetPaymentLine } from './xeroPayments';

describe('accounting ACH classification', () => {
  it('recognizes an explicit ACH debit name without inferring a rail from ambiguous names', () => {
    expect(mapQboPaymentMethod(' ACH DEBIT ')).toBe('ach_debit');
    expect(mapQboPaymentMethod('ACH')).toBe('other');
    expect(mapQboPaymentMethod('Wire')).toBe('other');
    expect(mapQboPaymentMethod(null)).toBe('other');
  });
  it('keeps Xero payments with no rail metadata unknown even when their reference says ACH', () => {
    const row = toChangeSetPaymentLine({ PaymentID:'payment-1', PaymentType:'ACCRECPAYMENT', Status:'AUTHORISED', Amount:10, Date:'2026-10-01', Reference:'ACH debit', Invoice:{ InvoiceID:'invoice-1', Type:'ACCREC', CurrencyCode:'USD' } }, {homeCurrency:'USD'});
    expect(row?.method).toBe('other');
    expect(row?.paymentMethodName).toBeNull();
  });
});
```

Create `apps/web/src/components/billing/invoiceTypes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PAYMENT_METHODS } from '@breeze/shared';
import { PAYMENT_METHOD_LABELS } from './invoiceTypes';

describe('invoice payment method labels', () => {
  it('labels every shared rail, including ACH debit', () => {
    expect(Object.keys(PAYMENT_METHOD_LABELS).sort()).toEqual([...PAYMENT_METHODS].sort());
    expect(PAYMENT_METHOD_LABELS.ach_debit).toBe('ACH debit');
  });
});
```

Replace only the payment-method expected array in the existing `packages/shared/src/types/billing-enums.test.ts` with `['cash','check','bank_transfer','card','other','ach_debit']` before implementation.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/db/schema/autopayColumns.test.ts src/services/accounting/autopayPaymentMethods.test.ts`; missing schema properties and the explicit ACH mapping fail. `cd apps/web && npx vitest run src/components/billing/invoiceTypes.test.ts` fails on the missing label.
- [ ] **Step 3: Implement** — create the complete C1 additions migration:

```sql
SELECT set_config('breeze.scope','system',true);
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'ach_debit';
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS autopay_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS autopay_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE invoice_stripe_payments
 ADD COLUMN IF NOT EXISTS fee_amount numeric(12,2) NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS payment_method_type text,
 ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'checkout';
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_fee_amount_chk;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_fee_amount_chk CHECK (fee_amount >= 0);
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_method_type_chk;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_method_type_chk CHECK (payment_method_type IN ('card','us_bank_account'));
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_source_chk;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_source_chk CHECK (source IN ('checkout','autopay'));
ALTER TABLE stripe_connect_accounts
 ADD COLUMN IF NOT EXISTS autopay_capabilities_checked_at timestamptz,
 ADD COLUMN IF NOT EXISTS autopay_missing_permissions text[] NOT NULL DEFAULT '{}';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS autopay_enabled boolean NOT NULL DEFAULT false;
```

Add these exact fields inside the corresponding existing Drizzle table objects. `boolean`, `numeric`, `text`, `timestamp`, and `sql` are already imported by these files; add `check` to `stripePayments.ts`'s `pg-core` import for the constraints below.

```ts
// contracts in db/schema/contracts.ts; invoices in db/schema/invoices.ts:
autopayExcluded: boolean('autopay_excluded').notNull().default(false),

// partners in db/schema/orgs.ts:
autopayEnabled: boolean('autopay_enabled').notNull().default(false),

// stripeConnectAccounts in db/schema/stripePayments.ts:
autopayCapabilitiesCheckedAt: timestamp('autopay_capabilities_checked_at', { withTimezone: true }),
autopayMissingPermissions: text('autopay_missing_permissions').array().notNull().default(sql`'{}'::text[]`),

// invoiceStripePayments in db/schema/stripePayments.ts:
feeAmount: numeric('fee_amount', { precision: 12, scale: 2 }).notNull().default('0'),
paymentMethodType: text('payment_method_type').$type<'card' | 'us_bank_account'>(),
source: text('source').$type<'checkout' | 'autopay'>().notNull().default('checkout'),
```

Add to the existing `invoiceStripePayments` table's index/constraint array:

```ts
uniqueIndex('invoice_stripe_payments_id_org_uq').on(t.id, t.orgId),
check('invoice_stripe_payments_fee_amount_chk', sql`${t.feeAmount} >= 0`),
check('invoice_stripe_payments_method_type_chk', sql`${t.paymentMethodType} IN ('card','us_bank_account')`),
check('invoice_stripe_payments_source_chk', sql`${t.source} IN ('checkout','autopay')`),
```

Replace `PAYMENT_METHODS` (`packages/shared/src/types/billing-enums.ts`) with:

```ts
export const PAYMENT_METHODS = ['cash', 'check', 'bank_transfer', 'card', 'other', 'ach_debit'] as const;
```

Add to the existing `QBO_PAYMENT_METHOD_NAMES` (`apps/api/src/services/accounting/quickbooksProvider.ts`):

```ts
'ach debit': 'ach_debit',
```

Keep the existing `mapQboPaymentMethod` trim/lowercase handling. Revise its comment to say that the explicitly named `ACH debit` rail is recognized, while `ACH`, `Wire` and `Direct Debit` remain unknown. `toChangeSetPaymentLine` (`apps/api/src/services/accounting/xeroPayments.ts`) remains `method:'other'`: Xero supplies no payment-method field, so neither its reference nor a bank-account name proves ACH. This is an explicit code-evidenced refinement of the request's assumed Xero mapping; both accounting push implementations already accept `AccountingPaymentMethod = PaymentMethod` (`services/accounting/types.ts`) without mapping an enum to a provider payment-method id.

Replace the exhaustive labels in `apps/web/src/components/billing/invoiceTypes.ts`:

```ts
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  check: 'Check',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  other: 'Other',
  ach_debit: 'ACH debit',
};
```

The `paymentMethodEnum` declaration in `db/schema/invoices.ts` already directly spreads `PAYMENT_METHODS`. The shipped SQL has one constraint on this vocabulary: the `payment_method` enum created by `2026-06-15-a-invoice-engine.sql`; add the value forward, do not rewrite that migration. Recheck the complete surface before committing with `rg -n 'PaymentMethod|PAYMENT_METHODS|bank_transfer|payment_method' packages/shared/src apps/api/src apps/web/src apps/portal/src apps/api/migrations`; any newly landed exhaustive mapping must be handled in this task's same TDD cycle.

- [ ] **Step 4: Run it, expect PASS** — `cd packages/shared && npx vitest run src/types/billing-enums.test.ts`; `cd apps/api && npx vitest run src/db/schema/autopayColumns.test.ts src/services/accounting/autopayPaymentMethods.test.ts src/services/accounting/accountingPaymentPull.test.ts src/services/accounting/xeroPayments.test.ts`; `cd apps/web && npx vitest run src/components/billing/invoiceTypes.test.ts`; from root `(set -a; . ./.env.test; set +a; pnpm db:check-drift)`.
- [ ] **Step 5: Commit** — `git add apps/api/migrations/2026-11-20-100500-autopay-column-additions.sql apps/api/src/db/schema/autopayColumns.test.ts apps/api/src/db/schema/contracts.ts apps/api/src/db/schema/invoices.ts apps/api/src/db/schema/stripePayments.ts apps/api/src/db/schema/orgs.ts packages/shared/src/types/billing-enums.ts packages/shared/src/types/billing-enums.test.ts apps/api/src/services/accounting/autopayPaymentMethods.test.ts apps/api/src/services/accounting/quickbooksProvider.ts apps/web/src/components/billing/invoiceTypes.ts apps/web/src/components/billing/invoiceTypes.test.ts` then `git commit -m "feat(billing): add autopay columns and ACH debit payment rail"`.

### Task 4: Register lifecycle ownership and make merge cancel authority before moving history
**Files:** Create `apps/api/src/services/autopay/merge.ts`, `apps/api/src/services/autopay/merge.test.ts`, `apps/api/src/__tests__/integration/autopayMerge.integration.test.ts`; Modify `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/orgMergeRegistry.ts`, `apps/api/src/services/orgMergeCustomExecutors.ts`, `apps/api/src/services/orgMerge.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/encryptedColumnRegistry.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts`.
**Interfaces:** Consumes `CustomMergeExecutor` and `MergeTableOutcome` (`orgMergeCustomExecutors.ts`), `runPolicy`, `collectMergeBlockers`, `previewOrgMerge`, `executeOrgMerge` (`orgMerge.ts`), `extractRowCount` (`db/rowCount.ts`), `getPartnerStripeClient(partnerId)` (`partnerStripe.ts`) · Produces private `autopayMergeExecutors`, `autopayMergeBlockerCount(loserOrgId: string): SQL`, and `drainAutopayMethodDetaches(): Promise<void>`. W1b's notice worker calls the last function once per dispatch tick. W1a also calls it only after the merge transaction commits. No W1a import points at a W1b file.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/__tests__/integration/autopayMerge.integration.test.ts`:

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { createPartner, createOrganization } from './db-utils';
import { collectMergeBlockers, runPolicy, OrgMergeBlockedError, buildMergeBlockedMessage } from '../../services/orgMerge';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { ACTIVE_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';

const run = it.runIf(Boolean(process.env.DATABASE_URL));
async function seed() {
  return withSystemDbAccessContext(async () => {
    const p=await createPartner();
    const l=await createOrganization({partnerId:p.id});
    const s=await createOrganization({partnerId:p.id});
    const connection=randomUUID(), enrollment=randomUUID(), method=randomUUID(), invoice=randomUUID(), schedule=randomUUID(), attempt=randomUUID();
    await db.execute(sql`INSERT INTO stripe_connect_accounts(id,partner_id,stripe_account_id) VALUES (${connection}::uuid,${p.id}::uuid,${'acct_'+connection})`);
    await db.execute(sql`INSERT INTO org_autopay_enrollments(id,org_id,partner_id,stripe_connection_id,stripe_account_id,status) VALUES (${enrollment}::uuid,${l.id}::uuid,${p.id}::uuid,${connection}::uuid,${'acct_'+connection},'active')`);
    await db.execute(sql`INSERT INTO org_payment_methods(id,org_id,enrollment_id,stripe_payment_method_id,type,status,is_autopay_method) VALUES (${method}::uuid,${l.id}::uuid,${enrollment}::uuid,${'pm_'+method},'card','active',true)`);
    await db.execute(sql`INSERT INTO invoices(id,org_id,partner_id,currency_code) VALUES (${invoice}::uuid,${l.id}::uuid,${p.id}::uuid,'USD')`);
    await db.execute(sql`INSERT INTO invoice_autopay_schedules(id,org_id,invoice_id,enrollment_id,enrollment_generation,eligible,terms_snapshot,state) VALUES (${schedule}::uuid,${l.id}::uuid,${invoice}::uuid,${enrollment}::uuid,1,true,'{"last4":"4242"}','scheduled')`);
    await db.execute(sql`INSERT INTO invoice_collection_attempts(id,org_id,invoice_id,schedule_id,attempt_no,payment_method_id,idempotency_key,principal_amount,currency,initiated_by,state) VALUES (${attempt}::uuid,${l.id}::uuid,${invoice}::uuid,${schedule}::uuid,1,${method}::uuid,${randomUUID()},10,'USD','scheduler','failed')`);
    await db.execute(sql`INSERT INTO billing_notice_outbox(org_id,invoice_id,enrollment_id,kind,seq,dedupe_key,to_email,rendered) VALUES (${l.id}::uuid,${invoice}::uuid,${enrollment}::uuid,'invoice_autopay',1,${randomUUID()},'client@example.com','{}'),(${l.id}::uuid,NULL,${enrollment}::uuid,'autopay_request',1,${randomUUID()},'client@example.com','{}')`);
    await db.execute(sql`INSERT INTO billing_link_tokens(org_id,invoice_id,enrollment_id,purpose,token_hash,token_ct,expires_at) VALUES (${l.id}::uuid,${invoice}::uuid,${enrollment}::uuid,'skip_invoice',${randomUUID()},'ct',now()+interval '1 day')`);
    await db.execute(sql`INSERT INTO org_autopay_consents(org_id,enrollment_id,generation,payment_method_id,consent_text_version,consent_text_hash,fee_terms,schedule_terms,contact_email,source) VALUES (${l.id}::uuid,${enrollment}::uuid,1,${method}::uuid,'v1','hash','{}','{}','client@example.com','setup_page')`);
    await db.execute(sql`INSERT INTO billing_payment_settings(org_id,autopay_offset_days) VALUES (${l.id}::uuid,15)`);
    return {p,l,s,enrollment,method,invoice,schedule,attempt};
  });
}
describe('autopay merge authority boundary',()=>{
  it('explains payment blockers without mislabeling them as PAM evidence',()=>{
    const payment={table:'invoice_collection_attempts',loserRows:2};
    expect(buildMergeBlockedMessage([payment])).toContain('2 payment collection attempt(s) are still in flight');
    expect(buildMergeBlockedMessage([payment])).not.toContain('PAM');
    expect(buildMergeBlockedMessage([payment,{table:'pam_actuations',loserRows:1}])).toContain('Audit-admin retention is not a merge mechanism');
  });
  for (const state of ACTIVE_COLLECTION_ATTEMPT_STATES) run(`blocks an attempt in ${state} before moving any authority`,async()=>{
    const f=await seed();
    await withSystemDbAccessContext(()=>db.execute(sql`UPDATE invoice_collection_attempts SET state=${state}::collection_attempt_state WHERE id=${f.attempt}::uuid`));
    const blockers=await withSystemDbAccessContext(()=>collectMergeBlockers(f.l.id));
    expect(blockers).toContainEqual({table:'invoice_collection_attempts',loserRows:1});
    await expect(withSystemDbAccessContext(()=>runPolicy('invoice_collection_attempts',getOrgMergePolicies().get('invoice_collection_attempts')!,f.l.id,f.s.id,'resolve'))).rejects.toBeInstanceOf(OrgMergeBlockedError);
    const rows=await withSystemDbAccessContext(()=>db.execute(sql`SELECT org_id,status FROM org_autopay_enrollments WHERE id=${f.enrollment}::uuid`));
    expect(rows[0]).toMatchObject({org_id:f.l.id,status:'active'});
  });
  run('moves invoice history while cancelling and leaving loser authority, even when survivor has no settings',async()=>{
    const f=await seed();
    await withSystemDbAccessContext(async()=>{
      expect(await collectMergeBlockers(f.l.id)).toEqual([]);
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      const tables=['billing_payment_settings','org_autopay_enrollments','org_payment_methods','invoice_autopay_schedules','invoice_collection_attempts','billing_notice_outbox','billing_link_tokens'];
      const policies=getOrgMergePolicies();
      for(const table of tables) await runPolicy(table,policies.get(table)!,f.l.id,f.s.id,'resolve');
      await db.execute(sql`UPDATE invoices SET org_id=${f.s.id}::uuid WHERE id=${f.invoice}::uuid`);
      for(const table of tables) await runPolicy(table,policies.get(table)!,f.l.id,f.s.id,'move');
      await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const [enrollment]=await db.execute(sql`SELECT org_id,status,cancel_source,cancel_reason FROM org_autopay_enrollments WHERE id=${f.enrollment}::uuid`);
      expect(enrollment).toMatchObject({org_id:f.l.id,status:'cancelled',cancel_source:'system',cancel_reason:'org_merged'});
      const [consent]=await db.execute(sql`SELECT org_id,enrollment_id,payment_method_id FROM org_autopay_consents WHERE enrollment_id=${f.enrollment}::uuid`);
      expect(consent).toMatchObject({org_id:f.l.id,enrollment_id:f.enrollment,payment_method_id:f.method});
      const [method]=await db.execute(sql`SELECT org_id,status,is_autopay_method FROM org_payment_methods WHERE id=${f.method}::uuid`);
      expect(method).toMatchObject({org_id:f.l.id,status:'removed',is_autopay_method:false});
      const [schedule]=await db.execute(sql`SELECT org_id,state,state_reason,enrollment_id,terms_snapshot FROM invoice_autopay_schedules WHERE id=${f.schedule}::uuid`);
      expect(schedule).toMatchObject({org_id:f.s.id,state:'cancelled',state_reason:'org_merged',enrollment_id:null,terms_snapshot:{last4:'4242'}});
      const [attempt]=await db.execute(sql`SELECT org_id,state,payment_method_id FROM invoice_collection_attempts WHERE id=${f.attempt}::uuid`);
      expect(attempt).toMatchObject({org_id:f.s.id,state:'failed',payment_method_id:null});
      const notices=await db.execute(sql`SELECT org_id,invoice_id,enrollment_id,status FROM billing_notice_outbox ORDER BY invoice_id NULLS LAST`);
      expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({org_id:f.s.id,invoice_id:f.invoice,enrollment_id:null,status:'cancelled'}),expect.objectContaining({org_id:f.l.id,invoice_id:null,enrollment_id:f.enrollment,status:'cancelled'})]));
      const [token]=await db.execute(sql`SELECT org_id,enrollment_id,revoked_at FROM billing_link_tokens WHERE invoice_id=${f.invoice}::uuid`);
      expect(token).toMatchObject({org_id:f.s.id,enrollment_id:null}); expect(token!.revoked_at).not.toBeNull();
      expect(await db.execute(sql`SELECT id FROM billing_payment_settings WHERE org_id IN (${f.l.id}::uuid,${f.s.id}::uuid)`)).toHaveLength(0);
    });
  });
});
```

Create `apps/api/src/services/autopay/merge.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({ execute:vi.fn(), getClient:vi.fn(), retrieve:vi.fn(), detach:vi.fn() }));
vi.mock('../../db',()=>({db:{execute:m.execute},withSystemDbAccessContext:async(fn:()=>Promise<unknown>)=>fn(),runOutsideDbContext:async(fn:()=>Promise<unknown>)=>fn()}));
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:m.getClient}));
import { drainAutopayMethodDetaches } from './merge';

beforeEach(()=>{
  vi.clearAllMocks();
  m.execute.mockResolvedValueOnce([{id:'00000000-0000-4000-8000-000000000001',partner_id:'00000000-0000-4000-8000-000000000002',stripe_account_id:'acct_original',stripe_customer_id:'cus_original',stripe_payment_method_id:'pm_original'}]).mockResolvedValue([]);
  m.getClient.mockResolvedValue({stripeAccountId:'acct_original',stripe:{paymentMethods:{retrieve:m.retrieve,detach:m.detach}}});
  m.retrieve.mockResolvedValue({id:'pm_original',customer:'cus_original'});
  m.detach.mockResolvedValue({id:'pm_original',customer:null});
});
describe('durable removed-method detach queue',()=>{
  it('detaches only the original account and customer, then acknowledges the row',async()=>{
    await drainAutopayMethodDetaches();
    expect(m.detach).toHaveBeenCalledWith('pm_original'); expect(m.execute).toHaveBeenCalledTimes(2);
  });
  it('leaves a failed detach queued for retry',async()=>{
    m.detach.mockRejectedValueOnce(new Error('network error'));
    await drainAutopayMethodDetaches(); expect(m.execute).toHaveBeenCalledTimes(1);
  });
  it('does not detach a method attached to another customer',async()=>{
    m.retrieve.mockResolvedValueOnce({customer:'cus_other'});
    await drainAutopayMethodDetaches(); expect(m.detach).not.toHaveBeenCalled(); expect(m.execute).toHaveBeenCalledTimes(1);
  });
  it('does not reuse a replacement Stripe account',async()=>{
    m.getClient.mockResolvedValueOnce({stripeAccountId:'acct_replacement',stripe:{paymentMethods:{retrieve:m.retrieve,detach:m.detach}}});
    await drainAutopayMethodDetaches(); expect(m.retrieve).not.toHaveBeenCalled(); expect(m.detach).not.toHaveBeenCalled();
  });
  it('acknowledges a method already detached without issuing a second detach',async()=>{
    m.retrieve.mockResolvedValueOnce({customer:null});
    await drainAutopayMethodDetaches(); expect(m.detach).not.toHaveBeenCalled(); expect(m.execute).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/merge.test.ts`; missing module. Run `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/autopayMerge.integration.test.ts`; no policies/executors/blocker exist yet.
- [ ] **Step 3: Implement** — create `apps/api/src/services/autopay/merge.ts`:

```ts
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { extractRowCount } from '../../db/rowCount';
import type { CustomMergeExecutor, MergeTableOutcome } from '../orgMergeCustomExecutors';
import { getPartnerStripeClient } from '../partnerStripe';

export function autopayMergeBlockerCount(loser: string): SQL {
  return sql`SELECT count(*)::int AS n FROM invoice_collection_attempts
    WHERE org_id=${loser}::uuid AND state IN ('reserved','created','confirming','processing')`;
}
const outcome=(moved=0,notes:string[]=[]):MergeTableOutcome=>({moved,dropped:0,notes});
async function update(q:SQL) { return extractRowCount(await db.execute(q)); }

export const autopayMergeExecutors: Readonly<Record<string,CustomMergeExecutor>> = {
  org_autopay_enrollments: async(loser)=>{
    const n=await update(sql`UPDATE org_autopay_enrollments SET status='cancelled',cancel_source='system',cancel_reason='org_merged',cancelled_at=COALESCE(cancelled_at,now()),generation=generation+1 WHERE org_id=${loser}::uuid AND (status<>'cancelled' OR cancel_reason IS DISTINCT FROM 'org_merged')`);
    return outcome(0,n?[`${n} autopay enrollment(s) cancelled and retained with the source organization`]:[]);
  },
  org_payment_methods: async(loser)=>{
    const n=await update(sql`UPDATE org_payment_methods SET status='removed',is_autopay_method=false,removed_at=COALESCE(removed_at,now()),unusable_reason='org_merged' WHERE org_id=${loser}::uuid AND status<>'removed'`);
    return outcome(0,n?[`${n} payment method(s) removed; original-account detach queued after commit`]:[]);
  },
  invoice_autopay_schedules: async(loser,survivor)=>{
    await update(sql`UPDATE invoice_autopay_schedules SET state='cancelled',state_reason='org_merged',next_attempt_at=NULL WHERE org_id=${loser}::uuid AND state IN ('awaiting_notice','scheduled','collecting','retry_scheduled','action_required')`);
    return outcome(await update(sql`UPDATE invoice_autopay_schedules SET enrollment_id=NULL,org_id=${survivor}::uuid WHERE org_id=${loser}::uuid`));
  },
  invoice_collection_attempts: async(loser,survivor)=>{
    // requires_action is not reserved, but its client authority must die before history moves.
    await update(sql`UPDATE invoice_collection_attempts SET state='canceled',updated_at=now() WHERE org_id=${loser}::uuid AND state='requires_action'`);
    return outcome(await update(sql`UPDATE invoice_collection_attempts SET payment_method_id=NULL,org_id=${survivor}::uuid WHERE org_id=${loser}::uuid AND state NOT IN ('reserved','created','confirming','processing')`));
  },
  billing_notice_outbox: async(loser,survivor)=>{
    await update(sql`UPDATE billing_notice_outbox SET status='cancelled',last_error='org_merged' WHERE org_id=${loser}::uuid AND status IN ('pending','sending','failed')`);
    return outcome(await update(sql`UPDATE billing_notice_outbox SET enrollment_id=NULL,org_id=${survivor}::uuid WHERE org_id=${loser}::uuid AND invoice_id IS NOT NULL`));
  },
  billing_link_tokens: async(loser,survivor)=>{
    await update(sql`UPDATE billing_link_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE org_id=${loser}::uuid`);
    return outcome(await update(sql`UPDATE billing_link_tokens SET enrollment_id=NULL,org_id=${survivor}::uuid WHERE org_id=${loser}::uuid AND invoice_id IS NOT NULL`));
  },
};

// Removed rows are the durable queue. Only org_merged remains pending; a successful
// detach changes its reason to org_merged:detached, leaving the authority removed.
export async function drainAutopayMethodDetaches(): Promise<void> {
  await runOutsideDbContext(async()=>{
    const rows=await withSystemDbAccessContext(()=>db.execute(sql`
      SELECT m.id,m.stripe_payment_method_id,e.partner_id,e.stripe_account_id,e.stripe_customer_id
      FROM org_payment_methods m JOIN org_autopay_enrollments e ON e.id=m.enrollment_id AND e.org_id=m.org_id
      WHERE m.status='removed' AND m.unusable_reason='org_merged' ORDER BY m.removed_at,m.id LIMIT 100`));
    for (const row of rows as unknown as Array<{id:string;stripe_payment_method_id:string;partner_id:string;stripe_account_id:string;stripe_customer_id:string|null}>) {
      try {
        const client=await withSystemDbAccessContext(()=>getPartnerStripeClient(row.partner_id));
        if(client.stripeAccountId!==row.stripe_account_id) throw new Error('original Stripe account credential unavailable');
        const method=await client.stripe.paymentMethods.retrieve(row.stripe_payment_method_id);
        const customer=typeof method.customer==='string'?method.customer:method.customer?.id;
        if(customer && customer!==row.stripe_customer_id) throw new Error('payment method customer changed');
        if(customer) await client.stripe.paymentMethods.detach(row.stripe_payment_method_id);
        await withSystemDbAccessContext(()=>db.execute(sql`UPDATE org_payment_methods SET unusable_reason='org_merged:detached' WHERE id=${row.id}::uuid AND status='removed' AND unusable_reason='org_merged'`));
      } catch(error) {
        console.error('[autopay] method detach remains queued',{methodId:row.id,error:error instanceof Error?error.message:'unknown'});
      }
    }
  });
}
```

In `orgMergeRegistry.ts`, add these exact entries to `SPECIAL`:

```ts
billing_payment_settings: { kind: 'keep-survivor' },
org_autopay_enrollments: { kind: 'custom', note: 'Cancel with org_merged and retain authority on the loser.' },
org_autopay_consents: { kind: 'leave-for-erasure', note: 'Append-only authorization evidence belongs to the loser.' },
org_payment_methods: { kind: 'custom', note: 'Remove and retain on loser; detach from original Stripe account after commit.' },
invoice_autopay_schedules: { kind: 'custom', note: 'Cancel non-terminal schedules, detach enrollment authority, then repoint invoice history.' },
invoice_collection_attempts: { kind: 'blocks-merge', note: 'Block reserved/created/confirming/processing; otherwise repoint history after detaching method authority.' },
billing_notice_outbox: { kind: 'custom', note: 'Cancel unsent notices; repoint invoice rows and retain enrollment-only rows.' },
billing_link_tokens: { kind: 'custom', note: 'Revoke all tokens; repoint invoice rows and retain enrollment-only rows.' },
```

In `orgMergeCustomExecutors.ts`, add the import and spread at the start of `CUSTOM_EXECUTORS` (its actual implementation home):

```ts
import { autopayMergeExecutors } from './autopay/merge';

// First property of CUSTOM_EXECUTORS:
...autopayMergeExecutors,
```

The existing registry comment saying every custom executor leaves zero loser rows is already too strong for existing fenced history. Revise that contract comment to say authority-only and enrollment-only rows are explicitly retained by their policy; moved history severs all authority references.

In `orgMerge.ts`, import:

```ts
import { autopayMergeBlockerCount, drainAutopayMethodDetaches } from './autopay/merge';
```

At the beginning of `buildMergeBlockedMessage`, before its existing PAM-only message, add this branch. The existing PAM message stays byte-identical for its existing callers:

```ts
const paymentBlockers = blockers.filter((b) => b.table === 'invoice_collection_attempts');
if (paymentBlockers.length > 0) {
  const count = paymentBlockers.reduce((n, b) => n + b.loserRows, 0);
  const paymentMessage = `merge blocked: ${count} payment collection attempt(s) are still in flight. Wait for settlement or cancellation before merging; changing organizations cannot cancel an in-flight bank debit.`;
  const otherBlockers = blockers.filter((b) => b.table !== 'invoice_collection_attempts');
  return otherBlockers.length > 0
    ? `${paymentMessage} ${buildMergeBlockedMessage(otherBlockers)}`
    : paymentMessage;
}
```

Add this shared builder next to `collectMergeBlockers`:

```ts
function mergeBlockerCount(table: string, loserOrgId: string): SQL {
  return table === 'invoice_collection_attempts'
    ? autopayMergeBlockerCount(loserOrgId)
    : sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id=${uuid(loserOrgId)}`;
}
```

Replace the unconditional `scalarCount(SELECT count(*) ... WHERE org_id=...)` expression **inside each blocks-merge branch** in `collectMergeBlockers`, `previewOrgMerge`, and `runPolicy` with:

```ts
await scalarCount(mergeBlockerCount(table, loserOrgId))
```

Replace the entire `runPolicy` `'blocks-merge'` case with:

```ts
case 'blocks-merge': {
  const rows = await scalarCount(mergeBlockerCount(table, loserOrgId));
  if (rows > 0) throw new OrgMergeBlockedError([{ table, loserRows: rows }]);
  if (table === 'invoice_collection_attempts' && phase === 'move') {
    return CUSTOM_EXECUTORS.invoice_collection_attempts!(loserOrgId, survivorOrgId);
  }
  return noOpOutcome();
}
```

At the start of the existing `'keep-survivor'` case in `runPolicy`, before `buildKeepSurvivor`, add:

```ts
if (table === 'billing_payment_settings') {
  return phase === 'resolve'
    ? { moved: 0, dropped: await exec(sql`DELETE FROM billing_payment_settings WHERE org_id=${uuid(loserOrgId)}`), notes: [] }
    : noOpOutcome();
}
```

At the start of `countWouldDrop(table, policy, loserOrgId, survivorOrgId)`, return the full loser settings count for that same table:

```ts
if (table === 'billing_payment_settings') {
  return scalarCount(sql`SELECT count(*)::int AS n FROM billing_payment_settings WHERE org_id=${uuid(loserOrgId)}`);
}
```

In `previewOrgMerge`, after the blocker count is computed in the blocks-merge branch and before its existing `if (loserRows === 0) continue`, add the zero-active-attempt history case so terminal attempts still contribute to merge size:

```ts
if (table === 'invoice_collection_attempts' && loserRows === 0) {
  const historyRows = await scalarCount(sql`SELECT count(*)::int AS n FROM invoice_collection_attempts WHERE org_id=${uuid(loserOrgId)}`);
  if (historyRows > 0) {
    tables.push({ table, policy: policy.kind, loserRows: historyRows, wouldDrop: 0 });
    totalMovableRows += historyRows;
  }
  continue;
}
```

`executeOrgMerge` already fences the loser, rechecks blockers inside Phase B, and defers FKs before the two-pass walk. After its existing `await self.stampTerminalShell(input, loser)` and before returning the committed result, add:

```ts
try {
  await drainAutopayMethodDetaches();
} catch (error) {
  console.error('[orgMerge] autopay method detach queue will retry', error);
}
```

This call never runs inside Phase B. A failed post-commit call never unfences or rolls back a completed merge. W1b's dispatcher drains the same durable queue after restart. Authority is already unusable locally before any Stripe HTTP occurs.

Register all eight SQL table names in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`) at these alphabetical insertion points; `topologicalCascadeOrder` remains the actual FK-safe execution ordering:

```ts
// Insert between 'bare_metal_recoveries' and 'brain_device_context':
'billing_link_tokens',
'billing_notice_outbox',
'billing_payment_settings',
// Insert immediately before the existing 'invoice_documents' entry:
'invoice_autopay_schedules',
'invoice_collection_attempts',
// Insert immediately before the existing 'org_billing_profile_assignments' entry:
'org_autopay_consents',
'org_autopay_enrollments',
// Insert between the existing 'org_documents' and 'org_ticket_settings' entries:
'org_payment_methods',
```

Add `'org_autopay_consents'` to `AUDIT_ADMIN_REQUIRED_TABLES` in the same file. The creating migration permits retention DELETE only under `breeze_audit_admin` plus `breeze.allow_audit_retention='1'`, matching this erasure executor's role/GUC handling.

Add `'billing_payment_settings'` to **both** `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES` in `rls-coverage.integration.test.ts`. Do not add a `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` entry; its existing SELECT-branch assertion must inspect the new table. The other seven org tables are auto-discovered and need no allowlist exemption.

Add to `CUSTOM_EXECUTORS_THAT_NEVER_WRITE_ORG_ID` (`orgMergeRegistry.integration.test.ts`):

```ts
org_autopay_enrollments: 'Cancel and retain source authority; proven by autopayMerge.integration.test.ts.',
org_payment_methods: 'Remove and retain source authority; proven by autopayMerge.integration.test.ts.',
```

Add to `encryptedColumnRegistry` (`encryptedColumnRegistry.ts`):

```ts
{ table: 'billing_link_tokens', column: 'token_ct', kind: 'text', aadBinding: 'row', description: 'Autopay bearer link token, encrypted and bound to its row id' },
```


Add these complete entries to `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`):

```ts
'billing_link_tokens': tablePolicy('org_id', {"included":["id","org_id","purpose","enrollment_id","invoice_id","generation","expires_at","consumed_at","revoked_at","CONSTRAINT","CONSTRAINT"],"reviewedIncluded":[],"excludedSensitive":["token_hash","token_ct"],"excludedOpen":[]}),
'billing_notice_outbox': tablePolicy('org_id', {"included":["id","org_id","invoice_id","enrollment_id","kind","seq","dedupe_key","to_email","status","attempts","next_attempt_at","sent_at","provider_message_id","last_error","CONSTRAINT","CONSTRAINT"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["rendered"]}),
'billing_payment_settings': tablePolicy('org_id', {"included":["id","org_id","partner_id","autopay_offset_days","autopay_offset_rule","autopay_cap_enabled","autopay_cap_amount","autopay_cap_currency","ach_mode","card_fee_bps","ach_fee_amount","fee_attested_by","fee_attested_at","reminders_enabled","reminder_before_due_days","reminder_repeat_days","overdue_reminder_every_days","CONSTRAINT","CONSTRAINT","CONSTRAINT"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
'invoice_autopay_schedules': tablePolicy('org_id', {"included":["id","org_id","invoice_id","enrollment_id","enrollment_generation","eligible","ineligible_reason","collect_on","notice_outbox_id","notice_sent_at","state","state_reason","next_attempt_at","attempt_count","client_skipped_at","msp_excluded_by","msp_excluded_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["terms_snapshot"]}),
'invoice_collection_attempts': tablePolicy('org_id', {"included":["id","org_id","invoice_id","schedule_id","attempt_no","payment_method_id","stripe_payment_intent_id","idempotency_key","principal_amount","fee_amount","currency","state","failure_code","decline_code","failure_class","invoice_stripe_payment_id","initiated_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
'org_autopay_consents': tablePolicy('org_id', {"included":["id","org_id","enrollment_id","generation","payment_method_id","consent_text_version","contact_email","ip","user_agent","source","created_at"],"reviewedIncluded":["consent_text_hash"],"excludedSensitive":[],"excludedOpen":["fee_terms","schedule_terms"]}),
'org_autopay_enrollments': tablePolicy('org_id', {"included":["id","org_id","partner_id","status","generation","stripe_connection_id","stripe_account_id","effective_from","requested_by","requested_at","request_recipient_email","paused_by","paused_at","cancelled_at","cancel_source","cancel_reason","needs_attention_reason"],"reviewedIncluded":["stripe_customer_id"],"excludedSensitive":[],"excludedOpen":[]}),
'org_payment_methods': tablePolicy('org_id', {"included":["id","org_id","enrollment_id","stripe_payment_method_id","type","card_brand","card_last4","card_exp_month","card_exp_year","card_funding","card_country","bank_name","bank_last4","account_holder_type","stripe_mandate_id","stripe_setup_intent_id","status","unusable_reason","is_autopay_method","created_at","removed_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

Replace the existing three entries below with these exact column-complete entries; only the new columns change classification:

```ts
  "contracts": tablePolicy("org_id", {"included":["autopay_excluded","id","partner_id","org_id","name","status","billing_timing","interval_months","start_date","end_date","next_billing_at","auto_issue","auto_renew","renewal_term_months","renewal_notice_days","currency_code","notes","terms","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "invoices": tablePolicy("org_id", {"included":["autopay_excluded","id","partner_id","org_id","site_id","invoice_number","status","currency_code","document_locale","document_theme","document_page_size","device_appendix","evidence_version","issue_date","due_date","subtotal","tax_rate","tax_total","total","amount_paid","balance","deposit_due","bill_to_name","bill_to_tax_id","bill_to_tax_exempt","notes","terms","terms_and_conditions","sent_at","first_viewed_at","viewed_at","paid_at","marked_overdue_at","voided_at","void_reason","replaces_invoice_id","replaced_by_invoice_id","pdf_document_ref","pdf_sha256","created_by","created_at","updated_at","public_link_expires_at"],"reviewedIncluded":[],"excludedSensitive":["public_link_token_hash","public_link_token_ct"],"excludedOpen":["bill_to_address","seller_snapshot"]}),
  "invoice_stripe_payments": tablePolicy("org_id", {"included":["fee_amount","payment_method_type","source","id","org_id","invoice_id","invoice_payment_id","stripe_account_id","stripe_object_type","stripe_object_id","stripe_payment_intent_id","amount","currency","status","last_event_at","refunded_amount_minor","dispute_amount_minor","dispute_funds_withdrawn","last_dispute_event_created","last_dispute_event_id","payment_received_at","revocation_state","revocation_reason","revocation_requested_at","revoked_at","revocation_attempts","revocation_next_attempt_at","revocation_last_error","revocation_last_provider_code","revocation_requested_by_user_id","provider_expires_at","created_at","updated_at"],"reviewedIncluded":["revocation_credential_id"],"excludedSensitive":[],"excludedOpen":[]}),
```

Add this classification comment next to those entries; do **not** invent an org-export policy for a table with no `org_id`:

```ts
// Autopay W1 partner-axis additions are outside the per-org export registry:
// partners.autopay_enabled: platform-managed partner rollout configuration.
// stripe_connect_accounts.autopay_capabilities_checked_at: partner connection diagnostic timestamp.
// stripe_connect_accounts.autopay_missing_permissions: partner connection diagnostic labels.
// None belongs to one organization's portable export; tablePolicy accepts only id/org_id ownership.
```

`partners` and `stripe_connect_accounts` are partner-axis tables and have no org-cascade/export entry. Their three new fields are explicitly classified above as outside the individual-org export; this is the safe correction to the request's blanket “every new column” wording. The existing org-export completeness contract still checks every new column on `contracts`, `invoices` and `invoice_stripe_payments`.

- [ ] **Step 4: Run it, expect PASS** — from the repository root:

```bash
pnpm test-stack up
(cd apps/api && npx vitest run src/services/autopay/merge.test.ts src/services/orgMerge.test.ts src/services/orgMergeCustomExecutors.test.ts)
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/autopayFoundation.integration.test.ts src/__tests__/integration/autopayMerge.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantCascadeExecution.integration.test.ts src/__tests__/integration/tenantCascadeErasureBreadth.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts)
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm test-stack down
```

Expected: active attempts refuse the merge, all terminal history passes deferred FKs after moving, the source retains no usable authority, the survivor never inherits the loser's payment settings, every column is classified, and consent erasure succeeds through the audit-admin path.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/merge.ts apps/api/src/services/autopay/merge.test.ts apps/api/src/__tests__/integration/autopayMerge.integration.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/orgMergeCustomExecutors.ts apps/api/src/services/orgMerge.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/encryptedColumnRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` then `git commit -m "feat(billing): preserve autopay tenant ownership through merge and erasure"`.

### Task 5: Strict settings writes and one inheritance resolver (W1a)

**Files:** Create `packages/shared/src/validators/autopay.ts`, `packages/shared/src/validators/autopay.test.ts`, `apps/api/src/services/autopay/types.ts`, `apps/api/src/services/autopay/billingPaymentSettings.ts`, `apps/api/src/services/autopay/billingPaymentSettings.test.ts`; Modify `packages/shared/src/validators/index.ts`, `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`.

**Interfaces:** Consumes C2 `billingPaymentSettings`, `organizations`, and C3 `AutopayOffsetRule`, `AchMode`. Produces C4 `SettingSource`, `Effective<T>`, `EffectiveBillingPaymentSettings`, `BILLING_PAYMENT_SETTINGS_DEFAULTS`, `resolveBillingPaymentSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveBillingPaymentSettings>`, `updatePartnerPaymentSettings(db: Tx, partnerId: string, patch: PartnerPaymentSettingsPatch, actorUserId: string): Promise<void>`, `updateOrgPaymentSettings(db: Tx, orgId: string, patch: OrgPaymentSettingsPatch, actorUserId: string): Promise<void>`; shared `partnerPaymentSettingsPatchSchema`, `orgPaymentSettingsPatchSchema`, and inferred patch types. `Tx` matches private `DbExecutor` in `services/invoiceService.ts` exactly.

The settings home is Billing → Payments at partner level and Org Billing → Payments at org level, with one resolver and 0 → 1 homes per level. W1 adds the API only; W2 mounts the settings UI. An enabled cap is one atomic value: never combine one owner's enable flag with another owner's amount or currency. Org NULL means inherit, including reminder repeat; the current schema cannot express an org-specific no-repeat override of a repeating partner cadence.

- [ ] **Step 1: Write the failing test** — create `packages/shared/src/validators/autopay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema } from './autopay';

describe.each([partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema])('payment settings patch', schema => {
  it.each([
    {}, { autopayOffsetDays: 0 }, { autopayOffsetDays: 60 },
    { autopayOffsetRule: 'earlier' }, { achMode: 'ach_only' },
    { autopayCapEnabled: false }, { autopayCapEnabled: null },
    { autopayCapEnabled: true, autopayCapAmount: '9999999999.99', autopayCapCurrency: 'USD' },
    { remindersEnabled: false, reminderRepeatDays: null },
    { reminderBeforeDueDays: 1, overdueReminderEveryDays: 31 },
  ])('accepts %j without coercing false, zero or null', value => {
    expect(schema.parse(value)).toEqual(value);
  });
  it.each([
    { cardFeeBps: 0 }, { cardFeeBps: 300 }, { achFeeAmount: '0.00' },
    { attestation: true }, { feeAttestedAt: null }, { feeAttestedBy: null },
    { autopayEnabled: true }, { partnerId: '11111111-1111-4111-8111-111111111111' },
    { autopayOffsetDays: -1 }, { autopayOffsetDays: 61 }, { autopayOffsetDays: '1' },
    { reminderBeforeDueDays: 0 }, { reminderRepeatDays: 32 },
    { overdueReminderEveryDays: 1.5 }, { autopayOffsetRule: 'earliest' },
    { autopayCapEnabled: true }, { autopayCapAmount: '10.00' },
    { autopayCapAmount: null }, { autopayCapCurrency: null },
    { autopayCapEnabled: true, autopayCapAmount: 'invalid', autopayCapCurrency: 'USD' },
    { autopayCapEnabled: false, autopayCapAmount: '10.00' },
    { autopayCapEnabled: true, autopayCapAmount: '0.00', autopayCapCurrency: 'USD' },
    { autopayCapEnabled: true, autopayCapAmount: '1.001', autopayCapCurrency: 'USD' },
    { autopayCapEnabled: true, autopayCapAmount: '10000000000.00', autopayCapCurrency: 'USD' },
    { autopayCapEnabled: true, autopayCapAmount: '1.00', autopayCapCurrency: 'ZZZ' },
  ])('rejects %j', value => expect(schema.safeParse(value).success).toBe(false));
});
```

Create `apps/api/src/services/autopay/billingPaymentSettings.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Tx } from './types';
import { billingPaymentSettings } from '../../db/schema';
import { resolveBillingPaymentSettings, updatePartnerPaymentSettings, updateOrgPaymentSettings } from './billingPaymentSettings';

const partnerId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
function fixture(rows: Array<Record<string, unknown>>, orgVisible = true) {
  const upsert = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate: upsert }));
  const select = vi.fn(() => ({ from: (table: unknown) => ({ where: () =>
    table === billingPaymentSettings ? Promise.resolve(rows) : {
      limit: async () => orgVisible ? [{ id: orgId, partnerId }] : [],
    },
  }) }));
  return { tx: { select, insert: vi.fn(() => ({ values })) } as unknown as Tx, values, upsert, select };
}

describe('billing payment settings', () => {
  it('returns all defaults with source=default and no attestation', async () => {
    const f = fixture([]);
    const value = await resolveBillingPaymentSettings(f.tx, { partnerId });
    expect(value).toEqual({
      autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
      autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' },
      cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' }, feeAttested: false,
      remindersEnabled: { value: false, source: 'default' }, reminderBeforeDueDays: { value: 3, source: 'default' },
      reminderRepeatDays: { value: null, source: 'default' }, overdueReminderEveryDays: { value: 7, source: 'default' },
    });
  });
  it('keeps explicit zero/false and inherits a cap as one value', async () => {
    const f = fixture([
      { orgId: null, partnerId, autopayOffsetDays: 10, remindersEnabled: true,
        autopayCapEnabled: true, autopayCapAmount: '200.00', autopayCapCurrency: 'USD', feeAttestedAt: new Date() },
      { orgId, partnerId: null, autopayOffsetDays: 0, remindersEnabled: false, autopayCapEnabled: null },
    ]);
    const result = await resolveBillingPaymentSettings(f.tx, { partnerId, orgId });
    expect(result.autopayOffsetDays).toEqual({ value: 0, source: 'org' });
    expect(result.remindersEnabled).toEqual({ value: false, source: 'org' });
    expect(result.autopayCap).toEqual({ value: { enabled: true, amount: '200.00', currency: 'USD' }, source: 'partner' });
    expect(result.feeAttested).toBe(true);
  });
  it('explicit unlimited overrides a capped partner; null reminder repeat inherits', async () => {
    const f = fixture([
      { orgId: null, partnerId, autopayCapEnabled: true, autopayCapAmount: '200.00', autopayCapCurrency: 'USD', reminderRepeatDays: 5 },
      { orgId, partnerId: null, autopayCapEnabled: false, reminderRepeatDays: null },
    ]);
    const result = await resolveBillingPaymentSettings(f.tx, { partnerId, orgId });
    expect(result.autopayCap).toEqual({ value: { enabled: false }, source: 'org' });
    expect(result.reminderRepeatDays).toEqual({ value: 5, source: 'partner' });
  });
  it('rejects a mismatched or invisible organization before reading settings', async () => {
    const f = fixture([], false);
    await expect(resolveBillingPaymentSettings(f.tx, { partnerId, orgId })).rejects.toMatchObject({ status: 404 });
    expect(f.select).toHaveBeenCalledTimes(1);
  });
  it('does not turn a malformed enabled cap into unlimited', async () => {
    const f = fixture([{ orgId: null, partnerId, autopayCapEnabled: true }]);
    await expect(resolveBillingPaymentSettings(f.tx, { partnerId })).rejects.toMatchObject({ status: 409 });
  });
  it('writes only the selected owner and provided fields, using a conflict upsert', async () => {
    const f = fixture([]);
    await updatePartnerPaymentSettings(f.tx, partnerId, { remindersEnabled: true }, actorId);
    expect(f.values).toHaveBeenLastCalledWith({ partnerId, orgId: null, remindersEnabled: true });
    await updateOrgPaymentSettings(f.tx, orgId, { autopayCapEnabled: null }, actorId);
    expect(f.values).toHaveBeenLastCalledWith({ orgId, partnerId: null, autopayCapEnabled: null,
      autopayCapAmount: null, autopayCapCurrency: null });
    expect(f.upsert).toHaveBeenCalledTimes(2);
  });
  it('revalidates service callers and never writes forbidden fee fields', async () => {
    const f = fixture([]);
    await expect(updatePartnerPaymentSettings(f.tx, partnerId, { cardFeeBps: 100 } as never, actorId)).rejects.toThrow();
    await expect(updateOrgPaymentSettings(f.tx, orgId, { achFeeAmount: '1.00' } as never, actorId)).rejects.toThrow();
    expect(f.values).not.toHaveBeenCalled();
    await updatePartnerPaymentSettings(f.tx, partnerId, {}, actorId);
    await updatePartnerPaymentSettings(f.tx, partnerId, { remindersEnabled: undefined }, actorId);
    expect(f.values).not.toHaveBeenCalled();
  });
  it('propagates database failures without claiming the settings were saved', async () => {
    const f = fixture([]);
    f.upsert.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(updatePartnerPaymentSettings(f.tx, partnerId, { remindersEnabled: true }, actorId)).rejects.toThrow('database unavailable');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — from the repository root:

```bash
(cd packages/shared && npx vitest run src/validators/autopay.test.ts)
(cd apps/api && npx vitest run src/services/autopay/billingPaymentSettings.test.ts)
```

Expected: missing `./autopay`, `./types`, and `./billingPaymentSettings` modules. Do not accept a test-discovery failure.

- [ ] **Step 3: Implement** — create `packages/shared/src/validators/autopay.ts`:

```ts
import { z } from 'zod';
import { ACH_MODES, AUTOPAY_OFFSET_RULES } from '../types/autopay';
import { currencyCodeSchema } from './currency';

const capPattern = /^(0|[1-9]\d{0,9})\.\d{2}$/;
const capAmount = z.string().regex(capPattern)
  .refine(value => capPattern.test(value) && BigInt(value.replace('.', '')) > 0n, 'Cap must be positive');
const patch = z.object({
  autopayOffsetDays: z.number().int().min(0).max(60).nullable().optional(),
  autopayOffsetRule: z.enum(AUTOPAY_OFFSET_RULES).nullable().optional(),
  autopayCapEnabled: z.boolean().nullable().optional(),
  autopayCapAmount: capAmount.nullable().optional(),
  autopayCapCurrency: currencyCodeSchema.nullable().optional(),
  achMode: z.enum(ACH_MODES).nullable().optional(),
  remindersEnabled: z.boolean().nullable().optional(),
  reminderBeforeDueDays: z.number().int().min(1).max(31).nullable().optional(),
  reminderRepeatDays: z.number().int().min(1).max(31).nullable().optional(),
  overdueReminderEveryDays: z.number().int().min(1).max(31).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.autopayCapEnabled === true) {
    if (value.autopayCapAmount == null) ctx.addIssue({ code: 'custom', path: ['autopayCapAmount'], message: 'An enabled cap requires amount' });
    if (value.autopayCapCurrency == null) ctx.addIssue({ code: 'custom', path: ['autopayCapCurrency'], message: 'An enabled cap requires currency' });
  } else if (value.autopayCapAmount != null || value.autopayCapCurrency != null
    || (value.autopayCapEnabled === undefined && ('autopayCapAmount' in value || 'autopayCapCurrency' in value))) {
    ctx.addIssue({ code: 'custom', path: ['autopayCapEnabled'], message: 'Supply the complete enabled cap together' });
  }
});
export const partnerPaymentSettingsPatchSchema = patch;
export const orgPaymentSettingsPatchSchema = patch;
export type PartnerPaymentSettingsPatch = z.infer<typeof partnerPaymentSettingsPatchSchema>;
export type OrgPaymentSettingsPatch = z.infer<typeof orgPaymentSettingsPatchSchema>;
```

Append this exact export to `packages/shared/src/validators/index.ts`:

```ts
export * from './autopay';
```

Create `apps/api/src/services/autopay/types.ts`:

```ts
import type { db } from '../../db';
export type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
```

Create `apps/api/src/services/autopay/billingPaymentSettings.ts`:

```ts
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema,
  type PartnerPaymentSettingsPatch, type OrgPaymentSettingsPatch,
  type AutopayOffsetRule, type AchMode,
} from '@breeze/shared';
import { billingPaymentSettings, organizations } from '../../db/schema';
import type { Tx } from './types';

export type SettingSource = 'org' | 'partner' | 'default';
export interface Effective<T> { value: T; source: SettingSource }
export interface EffectiveBillingPaymentSettings {
  autopayOffsetDays: Effective<number>; autopayOffsetRule: Effective<AutopayOffsetRule>;
  autopayCap: Effective<{ enabled: false } | { enabled: true; amount: string; currency: string }>;
  achMode: Effective<AchMode>;
  cardFeeBps: Effective<number>; achFeeAmount: Effective<string>;
  feeAttested: boolean;
  remindersEnabled: Effective<boolean>; reminderBeforeDueDays: Effective<number>;
  reminderRepeatDays: Effective<number | null>; overdueReminderEveryDays: Effective<number>;
}
export const BILLING_PAYMENT_SETTINGS_DEFAULTS = {
  autopayOffsetDays: 0, autopayOffsetRule: 'later' as AutopayOffsetRule,
  autopayCap: { enabled: false } as const, achMode: 'ach_preferred' as AchMode,
  cardFeeBps: 0, achFeeAmount: '0.00', remindersEnabled: false,
  reminderBeforeDueDays: 3, reminderRepeatDays: null, overdueReminderEveryDays: 7,
};
type Row = typeof billingPaymentSettings.$inferSelect;
function pick<T>(org: T | null | undefined, partner: T | null | undefined, fallback: T): Effective<T> {
  if (org != null) return { value: org, source: 'org' };
  if (partner != null) return { value: partner, source: 'partner' };
  return { value: fallback, source: 'default' };
}
function cap(org: Row | undefined, partner: Row | undefined): EffectiveBillingPaymentSettings['autopayCap'] {
  const row = org?.autopayCapEnabled != null ? org : partner?.autopayCapEnabled != null ? partner : undefined;
  if (!row) return { value: { enabled: false }, source: 'default' };
  const source: SettingSource = row === org ? 'org' : 'partner';
  if (!row.autopayCapEnabled) return { value: { enabled: false }, source };
  if (!row.autopayCapAmount || !row.autopayCapCurrency) {
    throw new HTTPException(409, { message: 'Enabled autopay cap has incomplete terms' });
  }
  return { value: { enabled: true, amount: row.autopayCapAmount, currency: row.autopayCapCurrency }, source };
}
export async function resolveBillingPaymentSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveBillingPaymentSettings> {
  if (args.orgId) {
    const [org] = await db.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.id, args.orgId), eq(organizations.partnerId, args.partnerId))).limit(1);
    if (!org) throw new HTTPException(404, { message: 'Organization not found' });
  }
  const rows = await db.select().from(billingPaymentSettings).where(or(
    eq(billingPaymentSettings.partnerId, args.partnerId),
    args.orgId ? eq(billingPaymentSettings.orgId, args.orgId) : undefined,
  ));
  const partner = rows.find(row => row.partnerId === args.partnerId && row.orgId === null);
  const org = args.orgId ? rows.find(row => row.orgId === args.orgId && row.partnerId === null) : undefined;
  const d = BILLING_PAYMENT_SETTINGS_DEFAULTS;
  return {
    autopayOffsetDays: pick(org?.autopayOffsetDays, partner?.autopayOffsetDays, d.autopayOffsetDays),
    autopayOffsetRule: pick(org?.autopayOffsetRule, partner?.autopayOffsetRule, d.autopayOffsetRule),
    autopayCap: cap(org, partner), achMode: pick(org?.achMode, partner?.achMode, d.achMode),
    cardFeeBps: pick(org?.cardFeeBps, partner?.cardFeeBps, d.cardFeeBps),
    achFeeAmount: pick(org?.achFeeAmount, partner?.achFeeAmount, d.achFeeAmount),
    feeAttested: partner?.feeAttestedAt != null,
    remindersEnabled: pick(org?.remindersEnabled, partner?.remindersEnabled, d.remindersEnabled),
    reminderBeforeDueDays: pick(org?.reminderBeforeDueDays, partner?.reminderBeforeDueDays, d.reminderBeforeDueDays),
    reminderRepeatDays: pick<number | null>(org?.reminderRepeatDays, partner?.reminderRepeatDays, d.reminderRepeatDays),
    overdueReminderEveryDays: pick(org?.overdueReminderEveryDays, partner?.overdueReminderEveryDays, d.overdueReminderEveryDays),
  };
}
function columns(patch: PartnerPaymentSettingsPatch) {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as PartnerPaymentSettingsPatch;
  return defined.autopayCapEnabled !== undefined && defined.autopayCapEnabled !== true
    ? { ...defined, autopayCapAmount: null, autopayCapCurrency: null }
    : defined;
}
export async function updatePartnerPaymentSettings(db: Tx, partnerId: string, patch: PartnerPaymentSettingsPatch, actorUserId: string): Promise<void> {
  const set = columns(partnerPaymentSettingsPatchSchema.parse(patch));
  if (!Object.keys(set).length) return;
  // The sole HTTP caller checks full-partner capability and audits actorUserId.
  // W5 consumes actorUserId for attestation provenance; W1 cannot write fees.
  void actorUserId;
  await db.insert(billingPaymentSettings).values({ partnerId, orgId: null, ...set })
    .onConflictDoUpdate({ target: billingPaymentSettings.partnerId,
      targetWhere: isNotNull(billingPaymentSettings.partnerId), set });
}
export async function updateOrgPaymentSettings(db: Tx, orgId: string, patch: OrgPaymentSettingsPatch, actorUserId: string): Promise<void> {
  const set = columns(orgPaymentSettingsPatchSchema.parse(patch));
  if (!Object.keys(set).length) return;
  void actorUserId;
  await db.insert(billingPaymentSettings).values({ orgId, partnerId: null, ...set })
    .onConflictDoUpdate({ target: billingPaymentSettings.orgId,
      targetWhere: isNotNull(billingPaymentSettings.orgId), set });
}
```

In `ALLOWED_WITHOUT_CAPABILITY_CHECK` (`apps/api/src/__tests__/partner-wide-write-coverage.test.ts`) insert this documented entry. Task 7's route tests prove the gate; the existing contract's stale-entry assertion proves this exemption continues to identify a writer.

```ts
  'services/autopay/billingPaymentSettings.ts': 'C4 settings mutators have one HTTP caller, routes/billingPaymentSettings.ts, which checks billing:manage plus canManagePartnerWidePolicies before partner writes; service parsers reject owner changes and fee writes',
```

- [ ] **Step 4: Run it, expect PASS**:

```bash
(cd packages/shared && npx vitest run src/validators/autopay.test.ts)
(cd apps/api && npx vitest run src/services/autopay/billingPaymentSettings.test.ts src/__tests__/partner-wide-write-coverage.test.ts)
```

- [ ] **Step 5: Commit** — implementation-time only:

```bash
git add packages/shared/src/validators/autopay.ts packages/shared/src/validators/autopay.test.ts packages/shared/src/validators/index.ts apps/api/src/services/autopay/types.ts apps/api/src/services/autopay/billingPaymentSettings.ts apps/api/src/services/autopay/billingPaymentSettings.test.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts
git commit -m "feat(billing): resolve and validate inherited payment settings"
```

### Task 6: Partner rollout gate and platform-admin mutation (W1a)

**Files:** Create `apps/api/src/services/autopay/autopayGate.ts`, `apps/api/src/services/autopay/autopayGate.test.ts`, `apps/api/src/routes/admin/autopayRollout.ts`, `apps/api/src/routes/admin/autopayRollout.test.ts`. Task 7 mounts the new admin router.

**Interfaces:** Consumes `Tx`, C2 `partners.autopayEnabled`, existing `readWithPartnerAxisVisibility(fn)` in `db/partnerAxisRead.ts`, `getCurrentDbAccessContext`, `runOutsideDbContext`, `withSystemDbAccessContext`, `requireMfa`, `writeRouteAudit`. Produces C4 `isAutopayEnabledForPartner(db: Tx, partnerId: string): Promise<boolean>` and `requireAutopayEnabled(): MiddlewareHandler`; C7 `adminAutopayRolloutRoutes` handles `PATCH /partners/:partnerId/autopay` beneath the admin hub.

`platformAdminMiddleware` in `middleware/platformAdmin.ts` authenticates and checks the platform-admin flag; it does not automatically elevate a partner-scoped admin's database context. The rollout write opens a short system context after that authorization. Never install a second platform-admin gate inside the child router; `adminRoutes` owns it, exactly as `adminSendingDomainsRoutes` does.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/services/autopay/autopayGate.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Tx } from './types';
const m = vi.hoisted(() => ({ rows: [] as Array<{ enabled: boolean }>, scope: 'partner', elevated: vi.fn() }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }) },
  getCurrentDbAccessContext: () => ({ scope: m.scope }),
}));
vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: async (fn: () => Promise<unknown>) => {
  m.elevated(); return fn();
} }));
import { db } from '../../db';
import { isAutopayEnabledForPartner, requireAutopayEnabled } from './autopayGate';
const partnerId = '11111111-1111-4111-8111-111111111111';
beforeEach(() => { m.rows = []; m.scope = 'partner'; m.elevated.mockClear(); });
describe('autopay rollout gate', () => {
  it.each([{ rows: [] }, { rows: [{ enabled: false }] }])('fails closed for %j', async ({ rows }) => {
    m.rows = rows; expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(false);
  });
  it('reads fresh state on each call', async () => {
    m.rows = [{ enabled: true }]; expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(true);
    m.rows = [{ enabled: false }]; expect(await isAutopayEnabledForPartner(db as Tx, partnerId)).toBe(false);
  });
  it('uses an escaped ambient handle for organization callers, never their held tx', async () => {
    m.scope = 'organization'; m.rows = [{ enabled: true }];
    const tx = { select: vi.fn(() => { throw new Error('old transaction escaped'); }) } as unknown as Tx;
    expect(await isAutopayEnabledForPartner(tx, partnerId)).toBe(true);
    expect(m.elevated).toHaveBeenCalledOnce();
  });
  it('returns the binding machine code and only calls the handler when on', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('auth', { partnerId } as never); await next(); });
    app.get('/protected', requireAutopayEnabled(), c => c.json({ reached: true }));
    const off = await app.request('/protected');
    expect(off.status).toBe(404); expect(await off.json()).toMatchObject({ code: 'autopay_not_enabled' });
    m.rows = [{ enabled: true }]; expect((await app.request('/protected')).status).toBe(200);
  });
});
```

Create `apps/api/src/routes/admin/autopayRollout.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const m = vi.hoisted(() => ({
  auth: null as any, rows: [] as Array<{ id: string; autopayEnabled: boolean }>,
  update: vi.fn(), set: vi.fn(), audit: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: { update: (...args: unknown[]) => { m.update(...args); return {
    set: (value: unknown) => { m.set(value); return { where: () => ({ returning: async () => m.rows }) }; },
  }; } },
  runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../middleware/auth', async importOriginal => ({
  ...(await importOriginal<typeof import('../../middleware/auth')>()),
  authMiddleware: async (c: any, next: any) => {
    if (!m.auth) {
      const { HTTPException } = await import('hono/http-exception');
      throw new HTTPException(401, { message: 'Not authenticated' });
    }
    c.set('auth', m.auth); await next();
  },
  requireMfa: () => async (c: any, next: any) => m.auth?.token?.mfa ? next() : c.json({ code: 'MFA_REQUIRED' }, 403),
}));
vi.mock('../../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: (...args: unknown[]) => m.audit(...args) }));
import { platformAdminMiddleware } from '../../middleware/platformAdmin';
import { adminAutopayRolloutRoutes } from './autopayRollout';
const partnerId = '11111111-1111-4111-8111-111111111111';
const app = new Hono();
app.use('/admin/*', platformAdminMiddleware);
app.route('/admin', adminAutopayRolloutRoutes);
function request(body: unknown, id = partnerId) {
  return app.request(`/admin/partners/${id}/autopay`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks(); m.auth = { user: { id: partnerId, isPlatformAdmin: true }, token: { mfa: true } };
  m.rows = [{ id: partnerId, autopayEnabled: true }];
});
describe('autopay admin rollout', () => {
  it.each([true, false])('writes and audits autopayEnabled=%s', async autopayEnabled => {
    m.rows[0]!.autopayEnabled = autopayEnabled;
    const response = await request({ autopayEnabled });
    expect(response.status).toBe(200); expect(m.set).toHaveBeenCalledWith({ autopayEnabled });
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resourceId: partnerId,
      action: 'partner.autopay_rollout.update', details: { autopayEnabled } }));
  });
  it('denies unauthenticated, partner-admin and missing-MFA callers', async () => {
    m.auth = null; expect((await request({ autopayEnabled: true })).status).toBe(401);
    m.auth = { user: { isPlatformAdmin: false }, token: { mfa: true } };
    expect((await request({ autopayEnabled: true })).status).toBe(403);
    m.auth = { user: { isPlatformAdmin: true }, token: { mfa: false } };
    expect((await request({ autopayEnabled: true })).status).toBe(403); expect(m.update).not.toHaveBeenCalled();
  });
  it.each([{}, { autopayEnabled: 'true' }, { autopayEnabled: true, partnerId }])('rejects %j', async body => {
    expect((await request(body)).status).toBe(400); expect(m.update).not.toHaveBeenCalled();
  });
  it('rejects malformed ids and returns 404 for absent partners', async () => {
    expect((await request({ autopayEnabled: true }, 'bad')).status).toBe(400);
    m.rows = []; expect((await request({ autopayEnabled: true })).status).toBe(404);
    expect(m.audit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**:

```bash
(cd apps/api && npx vitest run src/services/autopay/autopayGate.test.ts src/routes/admin/autopayRollout.test.ts)
```

Expected: missing gate and rollout modules.

- [ ] **Step 3: Implement** — create `apps/api/src/services/autopay/autopayGate.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { db as ambientDb, getCurrentDbAccessContext } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { partners } from '../../db/schema';
import type { Tx } from './types';
export async function isAutopayEnabledForPartner(db: Tx, partnerId: string): Promise<boolean> {
  const load = async (executor: Tx) => {
    const [row] = await executor.select({ enabled: partners.autopayEnabled }).from(partners)
      .where(eq(partners.id, partnerId)).limit(1);
    return row?.enabled === true;
  };
  // partnerId must come from authenticated context or an RLS-visible org row.
  return getCurrentDbAccessContext()?.scope === 'organization'
    ? readWithPartnerAxisVisibility(() => load(ambientDb)) : load(db);
}
export function requireAutopayEnabled(): MiddlewareHandler {
  return async (c, next) => {
    const partnerId = c.get('auth')?.partnerId;
    if (!partnerId || !await isAutopayEnabledForPartner(ambientDb, partnerId)) {
      return c.json({ error: 'Automatic payments are not enabled', code: 'autopay_not_enabled' }, 404);
    }
    await next();
  };
}
```

Create `apps/api/src/routes/admin/autopayRollout.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';

export const adminAutopayRolloutRoutes = new Hono();
adminAutopayRolloutRoutes.patch('/partners/:partnerId/autopay', requireMfa(),
  zValidator('param', z.object({ partnerId: z.string().guid() })),
  zValidator('json', z.object({ autopayEnabled: z.boolean() }).strict()),
  async c => {
    const { partnerId } = c.req.valid('param');
    const { autopayEnabled } = c.req.valid('json');
    const [updated] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.update(partners).set({ autopayEnabled }).where(eq(partners.id, partnerId))
        .returning({ id: partners.id, autopayEnabled: partners.autopayEnabled })));
    if (!updated) return c.json({ error: 'Partner not found' }, 404);
    writeRouteAudit(c as never, { orgId: null, action: 'partner.autopay_rollout.update',
      resourceType: 'partner', resourceId: partnerId, details: { autopayEnabled } });
    return c.json({ data: updated });
  });
```

The existing partner-wide write scanner derives tables from a `partnerId` column. `partners` is id-keyed, so this route needs no scanner exemption; adding one would fail the scanner's stale-entry test. Authorization is proved by the real platform-admin middleware tests above.

- [ ] **Step 4: Run it, expect PASS**:

```bash
(cd apps/api && npx vitest run src/services/autopay/autopayGate.test.ts src/routes/admin/autopayRollout.test.ts src/__tests__/partner-wide-write-coverage.test.ts)
```

- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/autopay/autopayGate.ts apps/api/src/services/autopay/autopayGate.test.ts apps/api/src/routes/admin/autopayRollout.ts apps/api/src/routes/admin/autopayRollout.test.ts
git commit -m "feat(billing): add platform-controlled autopay rollout gate"
```

### Task 7: Mount the settings and admin routes through the real API app (W1a)

**Files:** Create `apps/api/src/routes/billingPaymentSettings.ts`, `apps/api/src/index.autopayRoutes.test.ts`; Modify `apps/api/src/index.ts`, `apps/api/src/routes/admin/index.ts`. The app-level test is co-located with the application entrypoint it verifies; it exercises the actual route modules, not a test reconstruction of their mount statements.

**Interfaces:** Consumes Task 5's exact resolver/update signatures and strict patch schemas; consumes Task 6's `isAutopayEnabledForPartner(db: Tx, partnerId: string): Promise<boolean>` and `adminAutopayRolloutRoutes`; produces C7 GET/PUT `/partner/billing/payment-settings`, GET/PUT `/orgs/:orgId/billing/payment-settings`, PATCH `/admin/partners/:partnerId/autopay`, under the existing `/api/v1` prefix. Exports the existing `app` for request tests without changing production startup.

Apply authentication per route, as `invoiceSettingsRoutes` in `routes/invoices/settings.ts` does. A `use('*', authMiddleware)` in a router mounted at `/` leaks onto later public siblings. GET remains available to authorized settings readers when rollout is off, and the partner response includes `autopayEnabled`. Only PUTs containing an autopay field are gated; reminder-only writes are always available. Mixed writes fail atomically when rollout is off.

- [ ] **Step 1: Write the failing test** — create `apps/api/src/index.autopayRoutes.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  auth: null as any, allowed: true, enabled: false,
  read: vi.fn(), partnerWrite: vi.fn(), orgWrite: vi.fn(),
  adminRows: [] as Array<{ id: string; autopayEnabled: boolean }>, update: vi.fn(),
  orgRows: [] as Array<{ partnerId: string }>,
}));
vi.mock('./services/redis', async importOriginal => ({
  ...(await importOriginal<typeof import('./services/redis')>()), getRedis: () => null,
  isRedisAvailable: () => false, isBullMQAvailable: () => false,
}));
vi.mock('./middleware/globalRateLimit', async importOriginal => ({
  ...(await importOriginal<typeof import('./middleware/globalRateLimit')>()),
  globalRateLimit: () => async (_c: any, next: any) => next(),
}));
vi.mock('./middleware/partnerGuard', async importOriginal => ({
  ...(await importOriginal<typeof import('./middleware/partnerGuard')>()),
  partnerGuardWithExemptions: async (_c: any, next: any) => next(),
}));
vi.mock('./middleware/auth', async importOriginal => ({
  ...(await importOriginal<typeof import('./middleware/auth')>()),
  authMiddleware: async (c: any, next: any) => {
    if (!m.auth) {
      const { HTTPException } = await import('hono/http-exception');
      throw new HTTPException(401, { message: 'Not authenticated' });
    }
    c.set('auth', m.auth); await next();
  },
  requirePermission: () => async (c: any, next: any) => m.allowed ? next() : c.json({ error: 'Forbidden' }, 403),
  requireMfa: () => async (c: any, next: any) => m.auth?.token?.mfa ? next() : c.json({ code: 'MFA_REQUIRED' }, 403),
}));
vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof import('./db')>();
  return { ...actual, runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    db: { ...actual.db,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => m.orgRows }) }) }),
      update: (...args: unknown[]) => { m.update(...args); return { set: () => ({ where: () => ({ returning: async () => m.adminRows }) }) }; },
    },
  };
});
vi.mock('./services/autopay/billingPaymentSettings', () => ({
  resolveBillingPaymentSettings: (...args: unknown[]) => m.read(...args),
  updatePartnerPaymentSettings: (...args: unknown[]) => m.partnerWrite(...args),
  updateOrgPaymentSettings: (...args: unknown[]) => m.orgWrite(...args),
}));
vi.mock('./services/autopay/autopayGate', async importOriginal => ({
  ...(await importOriginal<typeof import('./services/autopay/autopayGate')>()),
  isAutopayEnabledForPartner: async () => m.enabled,
}));
vi.mock('./services/auditService', async importOriginal => ({
  ...(await importOriginal<typeof import('./services/auditService')>()),
  createAuditLogAsync: vi.fn(), runWithAuditRequestTracking: async (next: () => Promise<void>) => { await next(); return true; },
}));
vi.mock('./services/auditEvents', async importOriginal => ({
  ...(await importOriginal<typeof import('./services/auditEvents')>()), writeRouteAudit: vi.fn(),
}));
vi.mock('./services/auditOrgResolver', () => ({ resolveAuditOrgIdForPartner: async () => null }));
import { app } from './index';
const partnerId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const otherOrg = '44444444-4444-4444-8444-444444444444';
const partnerPath = '/api/v1/partner/billing/payment-settings';
const orgPath = `/api/v1/orgs/${orgId}/billing/payment-settings`;
function request(path: string, method = 'GET', body?: unknown) {
  return app.request(path, { method, ...(body === undefined ? {} : {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) });
}
beforeEach(() => {
  vi.clearAllMocks(); m.allowed = true; m.enabled = false;
  m.auth = { scope: 'partner', partnerId, partnerOrgAccess: 'all', orgId: null,
    user: { id: partnerId, email: 'admin@example.test', isPlatformAdmin: false }, token: { mfa: true },
    principal: { kind: 'user_session' }, canAccessOrg: (id: string) => id === orgId, accessibleOrgIds: [orgId] };
  m.read.mockResolvedValue({ remindersEnabled: { value: false, source: 'default' } });
  m.partnerWrite.mockResolvedValue(undefined); m.orgWrite.mockResolvedValue(undefined);
  m.adminRows = [{ id: partnerId, autopayEnabled: true }];
  m.orgRows = [{ partnerId }];
});
describe('autopay routes through exported API application', () => {
  it('mounts both GET routes and returns the partner rollout flag', async () => {
    const partner = await request(partnerPath);
    expect(partner.status).toBe(200); expect(await partner.json()).toMatchObject({ autopayEnabled: false });
    expect((await request(orgPath)).status).toBe(200);
    expect(m.read).toHaveBeenLastCalledWith(expect.anything(), { partnerId, orgId });
  });
  it('keeps reminders writable with rollout off, including organization scope', async () => {
    expect((await request(partnerPath, 'PUT', { remindersEnabled: true })).status).toBe(200);
    m.auth.scope = 'organization'; m.auth.orgId = orgId;
    expect((await request(orgPath, 'PUT', { reminderRepeatDays: null })).status).toBe(200);
    expect(m.partnerWrite).toHaveBeenCalledOnce(); expect(m.orgWrite).toHaveBeenCalledOnce();
    expect((await request(partnerPath)).status).toBe(403);
  });
  it('rejects mixed autopay/reminder writes atomically until enabled', async () => {
    const response = await request(partnerPath, 'PUT', { remindersEnabled: true, autopayOffsetDays: 0 });
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'autopay_not_enabled' });
    expect(m.partnerWrite).not.toHaveBeenCalled();
    m.enabled = true; expect((await request(partnerPath, 'PUT', { autopayOffsetDays: 0 })).status).toBe(200);
  });
  it.each([{ cardFeeBps: 0 }, { achFeeAmount: '0.00' }, { attestation: true }, { bogus: 1 }])('rejects forbidden fields %j', async body => {
    expect((await request(partnerPath, 'PUT', body)).status).toBe(400);
    expect((await request(orgPath, 'PUT', body)).status).toBe(400);
    expect(m.partnerWrite).not.toHaveBeenCalled(); expect(m.orgWrite).not.toHaveBeenCalled();
  });
  it('enforces authentication, permission, full-partner capability and org access', async () => {
    m.allowed = false; expect((await request(partnerPath, 'PUT', { remindersEnabled: true })).status).toBe(403);
    m.allowed = true; m.auth.partnerOrgAccess = 'selected';
    expect((await request(partnerPath, 'PUT', { remindersEnabled: true })).status).toBe(403);
    expect((await request(`/api/v1/orgs/${otherOrg}/billing/payment-settings`)).status).toBe(403);
    m.auth = null; expect((await request(partnerPath)).status).toBe(401);
    expect((await request(orgPath, 'PUT', { remindersEnabled: true })).status).toBe(401);
    expect(m.partnerWrite).not.toHaveBeenCalled(); expect(m.orgWrite).not.toHaveBeenCalled();
  });
  it('rejects malformed, absent and mismatched organization rows before a write', async () => {
    expect((await request('/api/v1/orgs/bad/billing/payment-settings')).status).toBe(400);
    m.orgRows = [];
    expect((await request(orgPath)).status).toBe(404);
    expect((await request(orgPath, 'PUT', { remindersEnabled: true })).status).toBe(404);
    m.orgRows = [{ partnerId: otherOrg }];
    expect((await request(orgPath)).status).toBe(404);
    expect(m.orgWrite).not.toHaveBeenCalled();
  });
  it('mounts rollout beneath the real platform-admin hub and MFA gate', async () => {
    const path = `/api/v1/admin/partners/${partnerId}/autopay`;
    expect((await request(path, 'PATCH', { autopayEnabled: true })).status).toBe(403);
    m.auth.user.isPlatformAdmin = true; m.auth.token.mfa = false;
    expect((await request(path, 'PATCH', { autopayEnabled: true })).status).toBe(403);
    m.auth.token.mfa = true;
    expect((await request(path, 'PATCH', { autopayEnabled: true })).status).toBe(200);
    expect(m.update).toHaveBeenCalledOnce();
  });
  it('surfaces service failures as server errors', async () => {
    m.partnerWrite.mockRejectedValueOnce(new Error('unavailable'));
    expect((await request(partnerPath, 'PUT', { remindersEnabled: true })).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**:

```bash
(cd apps/api && npx vitest run src/index.autopayRoutes.test.ts)
```

Expected: the app export/new route modules are absent. Once imports exist but mounts do not, successful-route assertions return 404. This is the regression the task must prevent.

- [ ] **Step 3: Implement** — create `apps/api/src/routes/billingPaymentSettings.ts`:

```ts
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema } from '@breeze/shared';
import { db } from '../db';
import { organizations } from '../db/schema';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireScope, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { writeRouteAudit } from '../services/auditEvents';
import { resolveAuditOrgIdForPartner } from '../services/auditOrgResolver';
import { resolveBillingPaymentSettings, updatePartnerPaymentSettings, updateOrgPaymentSettings } from '../services/autopay/billingPaymentSettings';
import { isAutopayEnabledForPartner } from '../services/autopay/autopayGate';

export const billingPaymentSettingsRoutes = new Hono();
const writePermission = requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action);
const autopayFields = new Set(['autopayOffsetDays', 'autopayOffsetRule', 'autopayCapEnabled', 'autopayCapAmount', 'autopayCapCurrency', 'achMode']);
function partnerFrom(c: Context): string {
  const partnerId = c.get('auth')?.partnerId;
  if (!partnerId) throw new HTTPException(403, { message: 'Partner context required' });
  return partnerId;
}
async function orgPartner(c: Context, orgId: string): Promise<string> {
  const auth = c.get('auth');
  if (!auth.canAccessOrg(orgId)) throw new HTTPException(403, { message: 'Organization access denied' });
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, orgId)).limit(1);
  if (!org || (auth.scope !== 'system' && org.partnerId !== auth.partnerId)) {
    throw new HTTPException(404, { message: 'Organization not found' });
  }
  return org.partnerId;
}
async function refuseDisabledAutopay(c: Context, partnerId: string, patch: object): Promise<Response | undefined> {
  if (Object.keys(patch).some(key => autopayFields.has(key)) && !await isAutopayEnabledForPartner(db, partnerId)) {
    return c.json({ error: 'Automatic payments are not enabled', code: 'autopay_not_enabled' }, 404);
  }
}
billingPaymentSettingsRoutes.get('/partner/billing/payment-settings', authMiddleware, requireScope('partner'), async c => {
  const partnerId = partnerFrom(c);
  const data = await resolveBillingPaymentSettings(db, { partnerId });
  return c.json({ data, autopayEnabled: await isAutopayEnabledForPartner(db, partnerId) });
});
billingPaymentSettingsRoutes.put('/partner/billing/payment-settings', authMiddleware, requireScope('partner'), writePermission,
  zValidator('json', partnerPaymentSettingsPatchSchema), async c => {
    const auth = c.get('auth');
    if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const partnerId = partnerFrom(c); const patch = c.req.valid('json');
    const refusal = await refuseDisabledAutopay(c, partnerId, patch); if (refusal) return refusal;
    await updatePartnerPaymentSettings(db, partnerId, patch, auth.user.id);
    writeRouteAudit(c as never, { orgId: await resolveAuditOrgIdForPartner(partnerId),
      action: 'partner.payment_settings.update', resourceType: 'partner', resourceId: partnerId,
      details: { changedFields: Object.keys(patch) } });
    return c.json({ data: await resolveBillingPaymentSettings(db, { partnerId }),
      autopayEnabled: await isAutopayEnabledForPartner(db, partnerId) });
  });
billingPaymentSettingsRoutes.get('/orgs/:orgId/billing/payment-settings', authMiddleware,
  zValidator('param', z.object({ orgId: z.string().guid() })), async c => {
    const { orgId } = c.req.valid('param'); const partnerId = await orgPartner(c, orgId);
    return c.json({ data: await resolveBillingPaymentSettings(db, { partnerId, orgId }) });
  });
billingPaymentSettingsRoutes.put('/orgs/:orgId/billing/payment-settings', authMiddleware, writePermission,
  zValidator('param', z.object({ orgId: z.string().guid() })), zValidator('json', orgPaymentSettingsPatchSchema), async c => {
    const { orgId } = c.req.valid('param'); const partnerId = await orgPartner(c, orgId); const patch = c.req.valid('json');
    const refusal = await refuseDisabledAutopay(c, partnerId, patch); if (refusal) return refusal;
    await updateOrgPaymentSettings(db, orgId, patch, c.get('auth').user.id);
    writeRouteAudit(c as never, { orgId, action: 'organization.payment_settings.update', resourceType: 'organization',
      resourceId: orgId, details: { changedFields: Object.keys(patch) } });
    return c.json({ data: await resolveBillingPaymentSettings(db, { partnerId, orgId }) });
  });
```

In `apps/api/src/routes/admin/index.ts`, add the import and mount below the existing `adminRoutes.use('*', platformAdminMiddleware)`; keep the existing `/admin` mount in `src/index.ts` unchanged:

```ts
import { adminAutopayRolloutRoutes } from './autopayRollout';
```

```ts
adminRoutes.route('/', adminAutopayRolloutRoutes);
```

In `apps/api/src/index.ts`, add the import beside `invoiceSettingsRoutes`, then mount before both the `/orgs` and `/partner` catch-all routers:

```ts
import { billingPaymentSettingsRoutes } from './routes/billingPaymentSettings';
```

```ts
api.route('/', billingPaymentSettingsRoutes);
```

Replace the existing `const app = new Hono()` declaration and the terminal unconditional bootstrap call with these exact blocks. The only startup change is that importing the app under Vitest no longer starts listeners, migrations or workers; production still calls the same `bootstrap()`.

```ts
export const app = new Hono();
```

```ts
if (process.env.NODE_ENV !== 'test') {
  void bootstrap().catch((error) => {
    console.error('[CRITICAL] API startup failed:', error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run it, expect PASS**:

```bash
(cd apps/api && npx vitest run src/index.autopayRoutes.test.ts src/routes/admin/autopayRollout.test.ts src/services/autopay/autopayGate.test.ts src/services/autopay/billingPaymentSettings.test.ts src/routes/invoices/settings.test.ts src/routes/admin/sendingDomains.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/routerAuthGate.contract.test.ts)
```

The app test must return 200 from every new success path and 401/403/404/400 from the intended boundary. Do not weaken it to a source-text assertion or replace `app` with a test-only Hono reconstruction.

- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/routes/billingPaymentSettings.ts apps/api/src/index.autopayRoutes.test.ts apps/api/src/index.ts apps/api/src/routes/admin/index.ts
git commit -m "feat(billing): mount payment settings and autopay rollout routes"
```

**PR boundary — W1a ends here.** Tasks 1–7 form schema, tenancy and settings. Run the Verification task's W1a commands before opening this PR. W1b begins with Task 8 and is based on the merged W1a commit; both PRs target `main`.

## PR W1b — money plumbing

Start W1b after W1a has merged into `main`; create `feat/autopay-w01-money-plumbing` from that main. W1b consumes W1a's tables, shared literals and `Tx` type. It does not turn on a partner, register a real notice kind, initiate a PaymentIntent, or schedule collections.

### Task 8: Serialize every existing collection producer against reservations

**Files:** Create `apps/api/src/services/autopay/reservation.ts`, `apps/api/src/services/autopay/reservation.test.ts`, `apps/api/src/services/autopay/reservation.integration.test.ts`. Modify `apps/api/src/services/invoiceTypes.ts`, `apps/api/src/services/invoiceCheckout.ts`, `apps/api/src/services/invoiceCheckout.test.ts`, `apps/api/src/routes/portal/invoices.ts`, `apps/api/src/routes/portal/invoices.test.ts`, `apps/api/src/routes/invoicesPublic.ts`, `apps/api/src/routes/invoicesPublic.test.ts`, `apps/api/src/services/invoiceService.ts`, `apps/api/src/services/invoiceService.test.ts`, `apps/api/src/services/accounting/accountingPaymentPull.ts`, `apps/api/src/services/accounting/accountingPaymentPull.test.ts`, `apps/api/vitest.config.ts`, `apps/api/vitest.integration.config.ts`.

**Interfaces:** Consumes `Tx` from `services/autopay/types.ts`, `ACTIVE_COLLECTION_ATTEMPT_STATES` from `@breeze/shared`, `InvoiceServiceError` from `services/invoiceTypes.ts`, `markSessionRevocationRequestedInTx(sessionId, reason, requestedByUserId, dbc)` from `services/stripeSessionRevocation.ts`. Produces C4 `LockedInvoiceForCollection`, `lockInvoiceForCollection(tx: Tx, invoiceId: string): Promise<LockedInvoiceForCollection>`, `assertNoActiveCollection(tx: Tx, invoiceId: string): Promise<void>`. Adds private-domain `assertCollectionAmountAvailable(tx: Tx, invoiceId: string, amount: string, replacingPaymentId?: string): Promise<void>` for the manual and import producers.

The unlocked invoice read in `createInvoicePayLink` and the portal pay handler remains an authorization preflight. Reservation checks occur in a short transaction before Stripe and again under the invoice lock before publishing the mapping. Never hold the invoice lock across Stripe. If a reservation appeared during the Stripe call, commit its Checkout mapping plus revocation intent and refuse to return its URL. W4 must call the existing `assertInvoiceSessionsRevoked(invoiceId, tx)` after acquiring the invoice lock and before inserting a reservation; its pre-lock revocation pass alone cannot close the opposite race.

Accounting changes deliberately: `applyInsideTransaction` in `services/accounting/accountingPaymentPull.ts` currently permits overpayment. New imports and increases now obey `balance − reserved` even when reserved is zero. A refused import throws, rolls back, and leaves the existing caller's failed-run/cursor retry behavior intact. Never truncate an external payment silently. Decreases and identical provider echoes do not consume additional balance.

- [ ] **Step 1: Write the failing test** — create `reservation.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Tx } from './types';
import { assertNoActiveCollection, lockInvoiceForCollection, assertCollectionAmountAvailable } from './reservation';

function executor(rows: unknown[][]) {
  const calls: Array<{ op: string; value?: unknown }> = [];
  const chain: Record<string, unknown> = {};
  for (const op of ['select', 'from', 'where', 'limit', 'for']) {
    chain[op] = vi.fn((value?: unknown) => { calls.push({ op, value }); return chain; });
  }
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(resolve);
  return { tx: chain as unknown as Tx, calls };
}
const invoice = { id: '11111111-1111-4111-8111-111111111111', currencyCode: 'USD', total: '100.00' };

describe('invoice collection reservation', () => {
  it('locks the invoice before summing only active attempts and returns exact decimals', async () => {
    const { tx, calls } = executor([[invoice], [{ reservedAmount: '60.00', balance: '90.00', unreservedBalance: '30.00' }]]);
    await expect(lockInvoiceForCollection(tx, invoice.id)).resolves.toMatchObject({
      invoice: { balance: '90.00' }, reservedAmount: '60.00', unreservedBalance: '30.00',
    });
    expect(calls.findIndex(c => c.op === 'for')).toBeLessThan(calls.map(c => c.op).lastIndexOf('select'));
    expect(calls.find(c => c.op === 'for')?.value).toBe('update');
    const projection = calls.filter(c => c.op === 'select')[1]!.value as Record<string, SQL>;
    const q = new PgDialect().sqlToQuery(projection.reservedAmount!);
    expect(q.params).toEqual(expect.arrayContaining(['reserved', 'created', 'confirming', 'processing']));
    expect(q.params).not.toContain('requires_action');
  });
  it('returns a typed 404 for an invisible invoice', async () => {
    const { tx } = executor([[]]);
    await expect(lockInvoiceForCollection(tx, invoice.id)).rejects.toMatchObject({ status: 404, code: 'INVOICE_NOT_FOUND' });
  });
  it('refuses a pay link whenever principal is reserved', async () => {
    const { tx } = executor([[invoice], [{ reservedAmount: '0.01', balance: '100.00', unreservedBalance: '99.99' }]]);
    await expect(assertNoActiveCollection(tx, invoice.id)).rejects.toMatchObject({ status: 409, code: 'COLLECTION_IN_PROGRESS' });
  });
  it.each([
    ['40.00', '60.00', '40.00', null],
    ['40.01', '60.00', '40.00', 'COLLECTION_IN_PROGRESS'],
    ['100.01', '0.00', '100.00', 'OVERPAYMENT'],
  ])('limits amount %s with reserved %s to %s', async (amount, reservedAmount, unreservedBalance, code) => {
    const { tx } = executor([[invoice], [{ reservedAmount, balance: '100.00', unreservedBalance }]]);
    const pending = assertCollectionAmountAvailable(tx, invoice.id, amount);
    if (code) await expect(pending).rejects.toMatchObject({ code });
    else await expect(pending).resolves.toBeUndefined();
  });
  it('allows decreasing an existing import even if the invoice is fully reserved', async () => {
    const { tx } = executor([[invoice], [{ reservedAmount: '50.00', balance: '50.00', unreservedBalance: '0.00' }], [{ amount: '50.00' }]]);
    await expect(assertCollectionAmountAvailable(tx, invoice.id, '40.00', '22222222-2222-4222-8222-222222222222')).resolves.toBeUndefined();
  });
});
```

Create the co-located real-DB test `reservation.integration.test.ts`. The deterministic barrier is an unresolved promise released in `finally`, not a timing sleep. Stripe is mocked at `getPartnerStripeClient`; the row locks, sums, manual payment and void paths are real.

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, invoices, stripeConnectAccounts, orgAutopayEnrollments, orgPaymentMethods, invoiceCollectionAttempts, invoiceStripePayments, invoicePayments, accountingConnections, accountingEntityMappings } from '../../db/schema';
import { lockInvoiceForCollection } from './reservation';
import { createInvoicePayLink } from '../invoiceCheckout';
import { recordPayment, voidInvoice } from '../invoiceService';
import { resetInvoiceLink } from '../invoiceLinkToken';
import { applyAccountingPayment } from '../accounting/accountingPaymentPull';
import { getConnection } from '../accounting/accountingConnectionService';
import type { ChangeSetPaymentLine } from '../accounting/types';

const mocks = vi.hoisted(() => ({ create: vi.fn(), client: vi.fn() }));
vi.mock('../partnerStripe', async (original) => ({
  ...(await original<typeof import('../partnerStripe')>()), getPartnerStripeClient: mocks.client,
}));
vi.mock('../invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

async function fixture() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({ name: 'Reservation test', slug: `reservation-${suffix}`, type: 'msp', plan: 'pro', status: 'active' }).returning();
    const [org] = await db.insert(organizations).values({ partnerId: partner!.id, name: 'Synthetic customer', slug: `reservation-${suffix}`, currencyCode: 'USD' }).returning();
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner!.id, stripeAccountId: `acct_${suffix}`, apiKey: 'enc:synthetic', status: 'connected', livemode: false }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org!.id, partnerId: partner!.id, stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: org!.id, enrollmentId: enrollment!.id, stripePaymentMethodId: `pm_${suffix}`, type: 'card', status: 'active' }).returning();
    const [invoice] = await db.insert(invoices).values({ orgId: org!.id, partnerId: partner!.id, currencyCode: 'USD', status: 'sent', issueDate: '2026-10-01', dueDate: '2026-10-31', total: '100.00', subtotal: '100.00', balance: '100.00' }).returning();
    const actor = { userId: null, partnerId: partner!.id, accessibleOrgIds: [org!.id] };
    const attempt = { orgId: org!.id, invoiceId: invoice!.id, paymentMethodId: method!.id, attemptNo: 1, idempotencyKey: `reservation-${suffix}`, principalAmount: '60.00', currency: 'USD', initiatedBy: 'client_on_session' as const, state: 'reserved' as const };
    mocks.client.mockResolvedValue({ stripe: { checkout: { sessions: { create: mocks.create } } }, stripeAccountId: connection!.stripeAccountId, defaultCurrency: 'USD' });
    return { invoice: invoice!, actor, attempt };
  });
}

beforeEach(() => { vi.clearAllMocks(); });
describe('reservation with real PostgreSQL', () => {
  it('serializes a concurrent manual payment behind the reservation and refuses its excess', async () => {
    const f = await fixture();
    let acquired!: () => void;
    let release!: () => void;
    const locked = new Promise<void>(r => { acquired = r; });
    const gate = new Promise<void>(r => { release = r; });
    const reserve = withSystemDbAccessContext(async () => {
      await lockInvoiceForCollection(db, f.invoice.id);
      await db.insert(invoiceCollectionAttempts).values(f.attempt);
      acquired();
      await gate;
    });
    await locked;
    const manual = withSystemDbAccessContext(() => recordPayment(f.invoice.id, { amount: 40.01, method: 'cash', receivedAt: '2026-10-01' }, f.actor));
    try { release(); await reserve; await expect(manual).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' }); }
    finally { release(); await reserve; }
    const rows = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoice.id)));
    expect(rows).toHaveLength(0);
    await withSystemDbAccessContext(() => recordPayment(f.invoice.id, { amount: 40, method: 'cash', receivedAt: '2026-10-01' }, f.actor));
    const state = await withSystemDbAccessContext(() => lockInvoiceForCollection(db, f.invoice.id));
    expect(state).toMatchObject({ reservedAmount: '60.00', unreservedBalance: '0.00' });
  });
  it('applies an accounting import only within the real locked unreserved balance', async () => {
    const f = await fixture();
    const connection = await withSystemDbAccessContext(async () => {
      await db.insert(invoiceCollectionAttempts).values(f.attempt);
      const [created] = await db.insert(accountingConnections).values({ partnerId: f.invoice.partnerId, provider: 'quickbooks', homeCurrency: 'USD', pullPayments: true }).returning();
      await db.insert(accountingEntityMappings).values({ integrationId: created!.id, partnerId: f.invoice.partnerId, breezeEntityType: 'invoice', breezeEntityId: f.invoice.id, remoteEntityType: 'Invoice', remoteEntityId: 'synthetic-invoice', breezeOrigin: true, linkStatus: 'confirmed', syncStatus: 'synced' });
      return getConnection(db, f.invoice.partnerId, 'quickbooks');
    });
    if (!connection) throw new Error('Synthetic accounting connection was not created');
    const line: ChangeSetPaymentLine = { remoteInvoiceId: 'synthetic-invoice', remotePaymentId: 'synthetic-payment', amountMinor: 4001, currency: 'USD', txnDate: '2026-10-01', remotePaymentVersion: '1', method: 'check', paymentMethodName: 'Check', paymentRefNum: null, breezePaymentId: null };
    await expect(applyAccountingPayment(connection, line, fn => withSystemDbAccessContext(fn), null)).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
    expect(await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoice.id)))).toHaveLength(0);
    await expect(applyAccountingPayment(connection, { ...line, amountMinor: 4000 }, fn => withSystemDbAccessContext(fn), null)).resolves.toMatchObject({ outcome: 'applied' });
    const state = await withSystemDbAccessContext(() => lockInvoiceForCollection(db, f.invoice.id));
    expect(state).toMatchObject({ reservedAmount: '60.00', unreservedBalance: '0.00' });
  });
  it('blocks link and void while allowing a customer-link reset', async () => {
    const f = await fixture();
    await withSystemDbAccessContext(() => db.insert(invoiceCollectionAttempts).values(f.attempt));
    await expect(createInvoicePayLink(f.invoice.id, f.actor)).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
    await expect(withSystemDbAccessContext(() => voidInvoice(f.invoice.id, 'synthetic', {}, f.actor))).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
    await expect(withSystemDbAccessContext(() => resetInvoiceLink(f.invoice))).resolves.toMatchObject({ origin: 'reset' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('withholds a stale Checkout amount when manual payment wins during Stripe HTTP', async () => {
    const f = await fixture();
    mocks.create.mockImplementation(async () => {
      await withSystemDbAccessContext(() => recordPayment(f.invoice.id, { amount: 25, method: 'cash', receivedAt: '2026-10-01' }, f.actor));
      return { id: `cs_${f.invoice.id}`, url: 'https://checkout.stripe.com/c/pay/synthetic', payment_intent: null };
    });
    await expect(createInvoicePayLink(f.invoice.id, f.actor)).rejects.toMatchObject({ code: 'STRIPE_REVOCATION_PENDING' });
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, f.invoice.id)));
    expect(mapping).toMatchObject({ revocationState: 'revocation_requested' });
  });
  it('persists revocation intent and withholds the URL when reservation wins during Stripe HTTP', async () => {
    const f = await fixture();
    mocks.create.mockImplementation(async () => {
      await withSystemDbAccessContext(async () => {
        await lockInvoiceForCollection(db, f.invoice.id);
        await db.insert(invoiceCollectionAttempts).values(f.attempt);
      });
      return { id: `cs_${f.invoice.id}`, url: 'https://checkout.stripe.com/c/pay/synthetic', payment_intent: null };
    });
    await expect(createInvoicePayLink(f.invoice.id, f.actor)).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
    const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, f.invoice.id)));
    expect(mapping).toMatchObject({ revocationState: 'revocation_requested' });
  });
});
```

Add this complete case to `routes/invoicesPublic.test.ts`, using its verified local `invoice`, `app`, `TOKEN`, `resolveMock` and `payLinkMock` helpers:

```ts
it('public pay returns the reservation conflict without exposing a payment URL', async () => {
  resolveMock.mockResolvedValue(invoice());
  payLinkMock.mockRejectedValueOnce(new InvoiceServiceError('A payment is already processing', 409, 'COLLECTION_IN_PROGRESS'));
  const response = await app().request(`/invoices/public/${TOKEN}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'A payment is already processing', code: 'COLLECTION_IN_PROGRESS' });
});
```

In `invoiceCheckout.test.ts` add a hoisted reservation boundary mock, preserving its real `InvoiceServiceError` and existing Drizzle queue:

```ts
const reservation = vi.hoisted(() => ({ assert: vi.fn(), lock: vi.fn(), invoice: null as Record<string, unknown> | null }));
vi.mock('./autopay/reservation', () => ({ assertNoActiveCollection: reservation.assert, lockInvoiceForCollection: reservation.lock }));
```

In that file's existing Drizzle chain `then`, immediately after `const rows = dbResults.shift() ?? []`, insert:

```ts
const first = rows[0];
if (first && typeof first === 'object' && 'currencyCode' in first && 'balance' in first) {
  reservation.invoice = first as Record<string, unknown>;
}
```

Add `reservation.invoice = null; reservation.assert.mockResolvedValue(undefined); reservation.lock.mockImplementation(async () => ({ invoice: reservation.invoice, reservedAmount: '0.00' }));` to that suite's `beforeEach`, then add:

```ts
it('refuses a reserved invoice before calling Stripe', async () => {
  dbResults.push([{ id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent', currencyCode: 'USD', balance: '100.00' }]);
  reservation.assert.mockRejectedValueOnce(new InvoiceServiceError('A payment is already processing', 409, 'COLLECTION_IN_PROGRESS'));
  await expect(createInvoicePayLink(INV_ID, actor)).rejects.toMatchObject({ status: 409, code: 'COLLECTION_IN_PROGRESS' });
  expect(sessionsCreateMock).not.toHaveBeenCalled();
});
```

In `routes/portal/invoices.test.ts`, add this boundary mock:

```ts
const reservation = vi.hoisted(() => ({ assert: vi.fn(), lock: vi.fn(), invoice: null as Record<string, unknown> | null }));
vi.mock('../../services/autopay/reservation', () => ({ assertNoActiveCollection: reservation.assert, lockInvoiceForCollection: reservation.lock }));
```

In the portal test's existing Drizzle chain `then`, immediately after `const rows = dbResults.shift() ?? []`, insert:

```ts
const first = rows[0];
if (first && typeof first === 'object' && 'currencyCode' in first && 'balance' in first) {
  reservation.invoice = first as Record<string, unknown>;
}
```

Add `reservation.invoice = null; reservation.assert.mockResolvedValue(undefined); reservation.lock.mockImplementation(async () => ({ invoice: reservation.invoice, reservedAmount: '0.00' }));` to its existing `beforeEach`, then add:

```ts
it('portal pay returns 409 for a reservation before contacting Stripe', async () => {
  dbResults.push([{ id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent', currencyCode: 'USD', balance: '100.00' }]);
  reservation.assert.mockRejectedValueOnce(new InvoiceServiceError('A payment is already processing', 409, 'COLLECTION_IN_PROGRESS'));
  const response = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
  expect(sessionsCreateMock).not.toHaveBeenCalled();
});
```

In `accountingPaymentPull.test.ts`, add a hoisted `collectionAvailable = vi.fn().mockResolvedValue(undefined)` and `vi.mock('../autopay/reservation', () => ({ assertCollectionAmountAvailable: collectionAvailable }))`. Keep this as a boundary mock: the real sum/lock behavior is tested above. Add the import `InvoiceServiceError` from `../invoiceTypes` and the following complete tests beside `applyAccountingPayment` tests:

```ts
it('holds an imported payment for retry when an active attempt owns its balance', async () => {
  collectionAvailable.mockRejectedValueOnce(new InvoiceServiceError('A payment is already processing', 409, 'COLLECTION_IN_PROGRESS'));
  await expect(applyAccountingPayment(conn(), LINE, runCtx, REALM_FP)).rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
  expect(currentPayments).toHaveLength(0);
  expect(currentMappings.filter(row => row.breezeEntityType === 'payment')).toHaveLength(0);
});
it('checks only the increase when replacing an imported payment', async () => {
  currentPayments = [paymentRow()];
  currentMappings.push(paymentMappingRow({ remoteSyncToken: 'old' }));
  await applyAccountingPayment(conn(), { ...LINE, remotePaymentVersion: 'new' }, runCtx, REALM_FP);
  expect(collectionAvailable).toHaveBeenCalledWith(db, INVOICE_ID, '150.00', currentPayments[0]!.id);
});
```

In `services/invoiceService.test.ts`, add this complete mock beside its existing `stripeSessionRevocation` mock. Existing service tests retain their invoice/payment query queues; the reservation arithmetic and locks are exercised by the real-database test above.

```ts
vi.mock('./autopay/reservation', () => ({
  assertCollectionAmountAvailable: vi.fn().mockResolvedValue(undefined),
  assertNoActiveCollection: vi.fn().mockResolvedValue(undefined),
}));
```

The existing shared `recordPaymentSchema` in `packages/shared/src/validators/invoices.ts` accepts a numeric `amount`. Keep that public input unchanged and convert it with `String(input.amount)` when passing the new decimal-string helper. Do not add floating-point arithmetic.

- [ ] **Step 2: Run it, expect FAIL** — missing reservation module/exports, or the public conflict code is not in the typed union:

```bash
(cd apps/api && npx vitest run src/services/autopay/reservation.test.ts src/services/invoiceCheckout.test.ts src/routes/portal/invoices.test.ts src/routes/invoicesPublic.test.ts src/services/invoiceService.test.ts src/services/accounting/accountingPaymentPull.test.ts)
```

- [ ] **Step 3: Implement** — create `reservation.ts`:

```ts
import { eq, inArray, sql } from 'drizzle-orm';
import { ACTIVE_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';
import { invoices, invoicePayments, invoiceCollectionAttempts } from '../../db/schema';
import { InvoiceServiceError } from '../invoiceTypes';
import type { Tx } from './types';

export interface LockedInvoiceForCollection {
  invoice: typeof invoices.$inferSelect;
  reservedAmount: string;
  unreservedBalance: string;
}
function hundredths(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new InvoiceServiceError('Invalid payment amount', 400, 'INVALID_AMOUNT');
  const magnitude = BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -magnitude : magnitude;
}
export async function lockInvoiceForCollection(tx: Tx, invoiceId: string): Promise<LockedInvoiceForCollection> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  const reserved = sql`coalesce((select sum(${invoiceCollectionAttempts.principalAmount}) from ${invoiceCollectionAttempts}
    where ${invoiceCollectionAttempts.invoiceId} = ${invoiceId}
    and ${inArray(invoiceCollectionAttempts.state, [...ACTIVE_COLLECTION_ATTEMPT_STATES])}), 0)`;
  const balance = sql`${invoice.total}::numeric - coalesce((select sum(${invoicePayments.amount}) from ${invoicePayments}
    where ${invoicePayments.invoiceId} = ${invoiceId}), 0)`;
  const [amounts] = await tx.select({
    reservedAmount: sql<string>`(${reserved})::numeric(12,2)::text`,
    balance: sql<string>`(${balance})::numeric(12,2)::text`,
    unreservedBalance: sql<string>`greatest(0, (${balance}) - (${reserved}))::numeric(12,2)::text`,
  }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!amounts) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  return { invoice: { ...invoice, balance: amounts.balance }, reservedAmount: amounts.reservedAmount, unreservedBalance: amounts.unreservedBalance };
}
export async function assertNoActiveCollection(tx: Tx, invoiceId: string): Promise<void> {
  const locked = await lockInvoiceForCollection(tx, invoiceId);
  if (hundredths(locked.reservedAmount) > 0n) {
    throw new InvoiceServiceError('A payment is already processing', 409, 'COLLECTION_IN_PROGRESS');
  }
}
export async function assertCollectionAmountAvailable(tx: Tx, invoiceId: string, amount: string, replacingPaymentId?: string): Promise<void> {
  const locked = await lockInvoiceForCollection(tx, invoiceId);
  let previous = 0n;
  if (replacingPaymentId) {
    const [payment] = await tx.select({ amount: invoicePayments.amount }).from(invoicePayments)
      .where(sql`${invoicePayments.id} = ${replacingPaymentId} and ${invoicePayments.invoiceId} = ${invoiceId}`).limit(1);
    if (!payment) throw new InvoiceServiceError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    previous = hundredths(payment.amount);
  }
  const requested = hundredths(amount);
  if (requested < 0n) throw new InvoiceServiceError('Invalid payment amount', 400, 'INVALID_AMOUNT');
  if (requested - previous <= hundredths(locked.unreservedBalance)) return;
  if (hundredths(locked.reservedAmount) > 0n) {
    throw new InvoiceServiceError('Payment exceeds the balance available while another payment is processing', 409, 'COLLECTION_IN_PROGRESS');
  }
  throw new InvoiceServiceError('Payment exceeds balance', 400, 'OVERPAYMENT');
}
```

Add `| 'COLLECTION_IN_PROGRESS'` to `InvoiceServiceErrorCode` in `invoiceTypes.ts`. Import the three reservation exports where used below.

In `createInvoicePayLink`, immediately after `requireSiteAccess(actor, inv.siteId)`, add:

```ts
await withSystemDbAccessContext(() => assertNoActiveCollection(db, inv.id));
```

At its final mapping transaction, declare `let racedCollection = false; let racedBalance = false;` beside `let raced = false` and insert this as the callback's first statement, before locking `stripeConnectAccounts`:

```ts
const collection = await lockInvoiceForCollection(db, inv.id);
racedCollection = collection.reservedAmount !== '0.00';
racedBalance = !PAYABLE.has(collection.invoice.status)
  || collection.invoice.currencyCode !== inv.currencyCode
  || toMinorUnits(computeChargeNow({ depositDue: collection.invoice.depositDue, amountPaid: collection.invoice.amountPaid, balance: collection.invoice.balance }, collection.invoice.currencyCode).amount, collection.invoice.currencyCode) !== chargeMinor;
```

Replace `raced = racedRevocation !== undefined` with:

```ts
raced = racedRevocation !== undefined || racedCollection || racedBalance;
```

Retain the existing mapping insert and `markSessionRevocationRequestedInTx` block. Immediately after that transaction returns, before its `if (raced)` block, add:

```ts
if (racedCollection) {
  throw new InvoiceServiceError('A payment is already processing', 409, 'COLLECTION_IN_PROGRESS');
}
```

In the portal `POST /invoices/:id/pay`, inside the existing producer-gate `try`, before `assertNoPendingRevocation(inv.id)`, add:

```ts
await withSystemDbAccessContext(() => assertNoActiveCollection(db, inv.id));
```

Replace that `catch`'s typed condition/body with:

```ts
if (err instanceof InvoiceServiceError && (err.code === REVOCATION_PENDING_CODE || err.code === 'COLLECTION_IN_PROGRESS')) {
  return c.json({ error: err.message, code: err.code }, 409);
}
throw err;
```

In the portal final mapping phase add `let racedCollection = false; let racedBalance = false;` beside `let raced = false`; insert this before the connection SHARE read:

```ts
const collection = await lockInvoiceForCollection(db, inv.id);
racedCollection = collection.reservedAmount !== '0.00';
racedBalance = !PAYABLE.has(collection.invoice.status)
  || collection.invoice.currencyCode !== inv.currencyCode
  || toMinorUnits(computeChargeNow({ depositDue: collection.invoice.depositDue, amountPaid: collection.invoice.amountPaid, balance: collection.invoice.balance }, collection.invoice.currencyCode).amount, collection.invoice.currencyCode) !== chargeMinor;
```

Replace its assignment to `raced` with `raced = racedRevocation !== undefined || racedCollection || racedBalance`. Keep the durable mapping and revocation-intent insert. Before its existing `if (raced)` response, add:

```ts
if (racedCollection) return c.json({ error: 'A payment is already processing', code: 'COLLECTION_IN_PROGRESS' }, 409);
```

In public `POST /:token/pay`, keep delegation to `createInvoicePayLink`. Add the following explicit customer-safe branch to its existing `InvoiceServiceError` catch:

```ts
if (err.code === 'COLLECTION_IN_PROGRESS') {
  return c.json({ error: 'A payment is already processing', code: err.code }, 409);
}
```

In `recordPayment` in `invoiceService.ts`, after `requireInvoiceAccess(actor, inv)` on the locked row and the two status checks, insert:

```ts
await assertCollectionAmountAvailable(tx, invoiceId, String(input.amount));
```

Keep its existing currency representability checks, recomputation, accounting outbox and SEC-150 revocation phases. In `voidInvoice`, after its locked-row authorization and status checks, insert:

```ts
await assertNoActiveCollection(db, invoiceId);
```

Do not call either reservation guard from `resetInvoiceLink` or its route: resetting the bearer capability remains allowed while ACH is processing.

In `applyInsideTransaction` in `accountingPaymentPull.ts`, import `assertCollectionAmountAvailable` from `../autopay/reservation`. Immediately before `const updatedPayments` in the existing external-origin edit branch, insert:

```ts
await assertCollectionAmountAvailable(db, inv.id, normalized.amount, existing.breezeEntityId);
```

Immediately before `const insertedPayments` in the first-delivery branch, insert:

```ts
await assertCollectionAmountAvailable(db, inv.id, normalized.amount);
```

Replace the module's old “OVER-PAYMENT IS ALLOWED” comment with:

```ts
// External-origin inserts/increases obey the locked unreserved balance. A
// conflict throws and rolls this application back; the caller retains its
// CDC cursor and retries instead of dropping or truncating provider money.
```

Add the literal `'src/services/autopay/**/*.integration.test.ts',` to `test.include` in `vitest.integration.config.ts` and to `test.exclude` in `vitest.config.ts`. Register this directory once even if a previous W1 task has already added it. Adjust existing checkout/portal fixture boundary mocks as shown above, not their business assertions. The real-DB suite is the proof that the boundary implementation actually locks and sums.

- [ ] **Step 4: Run it, expect PASS**:

```bash
(cd apps/api && npx vitest run src/services/autopay/reservation.test.ts src/services/invoiceCheckout.test.ts src/routes/portal/invoices.test.ts src/routes/invoicesPublic.test.ts src/services/invoiceService.test.ts src/services/accounting/accountingPaymentPull.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/reservation.integration.test.ts src/__tests__/integration/invoiceCheckout.integration.test.ts src/__tests__/integration/accountingPaymentPull.integration.test.ts src/__tests__/integration/stripeSessionRevocation.integration.test.ts)
```

Run each command from the repository root; the subshells preserve that working directory. Expected: refused manual/import writes leave no payment or claim row; reset succeeds; the Checkout race leaves one mapped, revocation-requested session and returns no URL.

- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/autopay/reservation.ts apps/api/src/services/autopay/reservation.test.ts apps/api/src/services/autopay/reservation.integration.test.ts apps/api/src/services/invoiceTypes.ts apps/api/src/services/invoiceCheckout.ts apps/api/src/services/invoiceCheckout.test.ts apps/api/src/routes/portal/invoices.ts apps/api/src/routes/portal/invoices.test.ts apps/api/src/routes/invoicesPublic.ts apps/api/src/routes/invoicesPublic.test.ts apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts apps/api/src/services/accounting/accountingPaymentPull.ts apps/api/src/services/accounting/accountingPaymentPull.test.ts apps/api/vitest.config.ts apps/api/vitest.integration.config.ts
git commit -m "feat(billing): serialize collection producers against autopay reservations"
```

### Task 9: Reconcile gross Stripe charges into principal and preserve the payment method

**Files:** Modify `apps/api/src/services/stripeReconcile.ts`, `apps/api/src/services/stripeReconcile.test.ts`, `apps/api/src/services/stripeReversalState.ts`, `apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts`.

**Interfaces:** Consumes W1a `invoiceStripePayments.feeAmount`, `.paymentMethodType`, `.source`; existing `toMinorUnits(value, currency)`/`fromMinorUnits(value, currency)` from `services/stripeMoney.ts`; existing `recordStripePayment(input, options)` and `applyStripeFinancialEvent(stripeEventId)`. Produces the same exported signatures, with gross validation, principal-only ledger writes, `ach_debit` restoration, and late-success handling for a failed PaymentIntent mapping.

A fee-bearing mapping must never restore gross into `invoice_payments`. W1 therefore adds a private cumulative proportional principal calculation to `stripeReversalState.ts` while W5 still owns the public `allocateReversal` API and accounting fee entry. Do not add the future W5 module now.

- [ ] **Step 1: Write the failing test** — append this complete matrix to the existing `recordStripePayment` describe in `stripeReconcile.test.ts`; `queueResult`, `insertValues`, and the reset hooks are already present in that file:

```ts
it.each([
  ['payment_intent', 'failed', 'us_bank_account', '3.00', '103.00', 'ach_debit', true],
  ['payment_intent', 'pending', 'card', '3.00', '103.00', 'card', true],
  ['checkout_session', 'pending', null, '0.00', '100.00', 'card', true],
  ['checkout_session', 'failed', null, '0.00', '100.00', 'card', false],
  ['payment_intent', 'pending', 'card', '3.00', '100.00', 'card', false],
])('captures %s/%s/%s with fee %s and gross %s', async (stripeObjectType, status, paymentMethodType, feeAmount, gross, method, records) => {
  const mapping = { id: 'm1', invoiceId: 'inv1', invoicePaymentId: null, stripeAccountId: 'acct_1', stripeObjectType, status, paymentMethodType, feeAmount, amount: '100.00', currency: 'USD', stripePaymentIntentId: 'pi_1' };
  queueResult([mapping]);
  queueResult([{ id: 'inv1', orgId: 'org1', partnerId: 'p1', status: 'sent', balance: '100.00', currencyCode: 'USD' }]);
  queueResult([mapping]);
  if (records) {
    queueResult([{ id: 'pay1' }]); queueResult([{ id: 'm1' }]); queueResult([{ status: 'paid' }]);
  }
  await recordStripePayment({ stripeObjectId: stripeObjectType === 'payment_intent' ? 'pi_1' : 'cs_1', stripePaymentIntentId: 'pi_1', stripeAccountId: 'acct_1', amount: gross, currency: 'USD' });
  if (records) expect(insertValues.calls).toContainEqual(expect.objectContaining({ amount: '100.00', method }));
  else expect(insertValues.calls).toHaveLength(0);
});
```

In `stripeReversalState.integration.test.ts`, add the following tests using the verified local `seed(false)` and `financialEvent` helpers. Each test starts with a genuine unlinked mapping, settles it through the real service, then uses real database state for reversals:

```ts
runDb('ACH full dispute and reinstatement preserve principal, fee and original method', async () => {
  const f = await seed(false);
  await withSystemDbAccessContext(() => db.update(invoiceStripePayments).set({
    stripeObjectType: 'payment_intent', stripeObjectId: f.paymentIntentId,
    paymentMethodType: 'us_bank_account', source: 'autopay', feeAmount: '3.00', status: 'failed',
  }).where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
  await recordStripePayment({ stripeObjectId: f.paymentIntentId, stripePaymentIntentId: f.paymentIntentId, stripeAccountId: f.accountId, amount: '103.00', currency: 'USD' });
  const captured = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoiceId)));
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ amount: '100.00', method: 'ach_debit' });
  await ingestStripeFinancialEvent(financialEvent(f, { stripeEventId: 'evt_ach_withdraw', eventType: 'charge.dispute.funds_withdrawn', chargeAmountMinor: 10300, refundedAmountMinor: null, disputeAmountMinor: 10300, disputeFundsWithdrawn: true, providerCreated: 300 }));
  expect(await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoiceId)))).toHaveLength(0);
  await ingestStripeFinancialEvent(financialEvent(f, { stripeEventId: 'evt_ach_restore', eventType: 'charge.dispute.funds_reinstated', chargeAmountMinor: 10300, refundedAmountMinor: null, disputeAmountMinor: 10300, disputeFundsWithdrawn: false, providerCreated: 301 }));
  const restored = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoiceId)));
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({ amount: '100.00', method: 'ach_debit' });
});
runDb('partial gross refund reduces only the proportional principal and duplicate delivery is harmless', async () => {
  const f = await seed(false);
  await withSystemDbAccessContext(() => db.update(invoiceStripePayments).set({ feeAmount: '3.00', paymentMethodType: 'card', source: 'autopay', stripeObjectType: 'payment_intent', stripeObjectId: f.paymentIntentId }).where(eq(invoiceStripePayments.stripePaymentIntentId, f.paymentIntentId)));
  await recordStripePayment({ stripeObjectId: f.paymentIntentId, stripePaymentIntentId: f.paymentIntentId, stripeAccountId: f.accountId, amount: '103.00', currency: 'USD' });
  const event = financialEvent(f, { stripeEventId: 'evt_fee_partial', chargeAmountMinor: 10300, refundedAmountMinor: 5150 });
  await ingestStripeFinancialEvent(event);
  await ingestStripeFinancialEvent(event);
  const payments = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoiceId)));
  expect(payments).toHaveLength(1);
  expect(payments[0]).toMatchObject({ amount: '50.00', method: 'card' });
});
```

- [ ] **Step 2: Run it, expect FAIL** — nonzero fee currently fails amount matching; failed PaymentIntent is ignored; ACH reinstatement hard-codes card:

```bash
(cd apps/api && npx vitest run src/services/stripeReconcile.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/stripeReversalState.integration.test.ts)
```

- [ ] **Step 3: Implement** — import `toMinorUnits` alongside `fromMinorUnits` in `stripeReconcile.ts`. In `captureUnderLock`, replace the failed/refunded/disputed early-return condition with:

```ts
if ((mapping.status === 'failed' && mapping.stripeObjectType !== 'payment_intent')
    || mapping.status === 'refunded' || mapping.status === 'disputed') {
  return { kind: 'noop', invoiceId: mapping.invoiceId };
}
```

Replace its `mapping.amount` comparison and overpayment check with:

```ts
const principalAmount = mapping.amount ?? input.amount;
const principalMinor = toMinorUnits(principalAmount, input.currency);
const feeMinor = toMinorUnits(mapping.feeAmount ?? '0.00', input.currency);
const grossMinor = principalMinor + feeMinor;
if (!Number.isSafeInteger(grossMinor) || grossMinor <= 0
    || toMinorUnits(input.amount, input.currency) !== grossMinor) {
  return terminalFail(`amount mismatch (event=${input.amount} principal=${principalAmount} fee=${mapping.feeAmount ?? '0.00'})`);
}
if (principalMinor > toMinorUnits(inv.balance, inv.currencyCode)) {
  return terminalFail('overpayment: principal exceeds balance');
}
```

Replace the payment insert's amount/method fields with:

```ts
invoiceId: inv.id, orgId: inv.orgId,
amount: fromMinorUnits(principalMinor, inv.currencyCode),
method: mapping.paymentMethodType === 'us_bank_account' ? 'ach_debit' : 'card',
reference: input.stripePaymentIntentId,
receivedAt, recordedBy: null, note: null,
```

Change the misleading “Gross amount is what settles the invoice” comment immediately before `requestPaymentPush` to:

```ts
// Only principal settles the invoice and enters this accounting payment
// outbox. The mapping preserves the fee separately for W5 fee-income posting.
```

In `stripeReversalState.ts`, insert this private helper before `applyStripeFinancialEvent`:

```ts
function remainingPrincipalMinor(principalMinor: number, feeMinor: number, reversedGrossMinor: number): number {
  const principal = BigInt(principalMinor);
  const gross = principal + BigInt(feeMinor);
  if (gross <= 0n) throw new Error('Stripe mapping has a non-positive gross amount');
  const reversed = BigInt(reversedGrossMinor);
  const bounded = reversed < 0n ? 0n : reversed > gross ? gross : reversed;
  // Cumulative half-up allocation; computing from total-to-date eliminates
  // per-event rounding drift and a full reversal removes the final cent.
  const allocatedPrincipal = (principal * bounded * 2n + gross) / (2n * gross);
  return Number(principal - allocatedPrincipal);
}
```

Replace `const originalMinor = toMinorUnits(mapping.amount, mapping.currency)` with:

```ts
const principalMinor = toMinorUnits(mapping.amount, mapping.currency);
const feeMinor = toMinorUnits(mapping.feeAmount ?? '0.00', mapping.currency);
const originalMinor = principalMinor + feeMinor;
```

All event gross bounds and charge amount comparisons continue to use `originalMinor`. Replace `targetMinor` initialization with:

```ts
const reversedGrossMinor = Math.min(originalMinor, refunded + (disputeWithdrawn ? disputeAmount : 0));
const targetMinor = remainingPrincipalMinor(principalMinor, feeMinor, reversedGrossMinor);
```

Change the partial-refund divergence message's monetary argument from `fromMinorUnits(originalMinor - targetMinor, mapping.currency)` to `fromMinorUnits(principalMinor - targetMinor, mapping.currency)`, because the accounting payment contains principal only. Replace the restore insert's hard-coded `method: 'card'` with:

```ts
method: mapping.paymentMethodType === 'us_bank_account' ? 'ach_debit' : 'card',
```

Keep event dedupe, capture/reversal ordering, account/currency guards, cumulative refund high-water and the existing checkout behavior unchanged. W4 remains responsible for marking a succeeded-but-unapplicable PaymentIntent attempt `unapplied`; W1 does not add the future outcome worker.

- [ ] **Step 4: Run it, expect PASS**:

```bash
(cd apps/api && npx vitest run src/services/stripeReconcile.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/stripeReversalState.integration.test.ts src/__tests__/integration/stripeSettle.integration.test.ts)
```

Expected: the complete existing checkout reversal suite passes with fee zero, late PI success records once, gross matches Stripe, and fees never enter invoice principal.

- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/stripeReconcile.ts apps/api/src/services/stripeReconcile.test.ts apps/api/src/services/stripeReversalState.ts apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts
git commit -m "feat(billing): reconcile Stripe gross amounts and ACH principal"
```

### Task 10: Settle PaymentIntents with account-bound retained credentials

**Files:** Create `apps/api/src/services/partnerStripeClient.ts`, `apps/api/src/services/stripeSettle.test.ts`, `apps/api/src/services/stripeCredentialArchive.test.ts`. Modify `apps/api/src/services/autopay/merge.ts`, `apps/api/src/services/autopay/merge.test.ts`, `apps/api/src/services/partnerStripe.ts`, `apps/api/src/services/stripeSettle.ts`, `apps/api/src/services/stripeCredentialArchive.ts`.

**Interfaces:** Consumes `recordStripePayment(input, options)` from `stripeReconcile.ts`, `assertNoHeldDbContextForStripe(operation: string)` from `stripeSettle.ts`, `getSupersededStripeCredential(credentialId, context)` and `findLatestArchivedCredentialForAccount(partnerId, stripeAccountId)` from `stripeCredentialArchive.ts`, `ACTIVE_COLLECTION_ATTEMPT_STATES` from `@breeze/shared`. Produces C4 `settlePaymentIntent(partnerId: string, paymentIntentId: string): Promise<{ settled: boolean; status: Stripe.PaymentIntent.Status; invoiceId: string | null }>`. The public one-argument `getPartnerStripeClient(partnerId)` import remains available from `partnerStripe.ts`; additional credential-source overloads are private infrastructure.

The factory is split into a focused module so both candidate-key validation and archived settlement can be mocked at `getPartnerStripeClient` rather than patching the Stripe constructor. Candidate keys are never persisted to probe them. `settlePaymentIntent` is never gated on rollout, enrollment status or the current payment method: disabling future collections cannot prevent money already in flight from being booked.

- [ ] **Step 1: Write the failing test** — create `stripeSettle.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], depth: 0, held: false, client: vi.fn(), retrieve: vi.fn(), record: vi.fn(), archive: vi.fn() }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'innerJoin', 'where', 'limit']) chain[name] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(resolve);
  return {
    db: chain,
    hasDbAccessContext: () => h.held || h.depth > 0,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => { h.depth++; try { return await fn(); } finally { h.depth--; } },
  };
});
vi.mock('./partnerStripe', () => ({
  getPartnerStripeClient: h.client,
  PartnerStripeError: class PartnerStripeError extends Error { constructor(message: string, readonly code: string) { super(message); } },
}));
vi.mock('./stripeReconcile', () => ({ recordStripePayment: h.record }));
vi.mock('./stripeCredentialArchive', () => ({ findLatestArchivedCredentialForAccount: h.archive }));
import { settlePaymentIntent } from './stripeSettle';
const mapping = { id: '11111111-1111-4111-8111-111111111111', invoiceId: '22222222-2222-4222-8222-222222222222', stripeAccountId: 'acct_original', revocationCredentialId: null };
beforeEach(() => {
  vi.clearAllMocks(); h.rows.length = 0; h.depth = 0; h.held = false;
  h.client.mockResolvedValue({ stripe: { paymentIntents: { retrieve: h.retrieve } }, stripeAccountId: 'acct_original', defaultCurrency: 'USD' });
  h.record.mockResolvedValue({ invoiceId: mapping.invoiceId });
  h.retrieve.mockImplementation(async () => { expect(h.depth).toBe(0); return { id: 'pi_test', status: 'succeeded', amount_received: 10300, currency: 'usd' }; });
});
describe('settlePaymentIntent', () => {
  it('books provider gross outside the Stripe HTTP phase and checks the durable payment link', async () => {
    h.rows.push([mapping], [{ invoicePaymentId: '33333333-3333-4333-8333-333333333333' }]);
    await expect(settlePaymentIntent('44444444-4444-4444-8444-444444444444', 'pi_test')).resolves.toEqual({ settled: true, status: 'succeeded', invoiceId: mapping.invoiceId });
    expect(h.record).toHaveBeenCalledWith({ stripeObjectId: 'pi_test', stripePaymentIntentId: 'pi_test', stripeAccountId: 'acct_original', amount: '103.00', currency: 'USD' });
  });
  it('processing keeps the reservation and does not write a payment', async () => {
    h.rows.push([mapping]);
    h.retrieve.mockResolvedValue({ id: 'pi_test', status: 'processing', currency: 'usd', amount_received: 0 });
    await expect(settlePaymentIntent('partner', 'pi_test')).resolves.toEqual({ settled: false, status: 'processing', invoiceId: mapping.invoiceId });
    expect(h.record).not.toHaveBeenCalled();
  });
  it('uses the mapping archive when the partner disconnected, without checking rollout', async () => {
    h.rows.push([{ ...mapping, revocationCredentialId: 'archive-id' }], [{ invoicePaymentId: 'payment-id' }]);
    await settlePaymentIntent('partner', 'pi_test');
    expect(h.client).toHaveBeenCalledWith('partner', { archivedCredentialId: 'archive-id', invoiceStripePaymentId: mapping.id });
  });
  it('never retrieves another partner\'s mapping', async () => {
    h.rows.push([]);
    await expect(settlePaymentIntent('wrong-partner', 'pi_test')).rejects.toMatchObject({ status: 404, code: 'INVOICE_NOT_FOUND' });
    expect(h.client).not.toHaveBeenCalled();
  });
  it('does not claim settled when captured money could not be applied', async () => {
    h.rows.push([mapping], [{ invoicePaymentId: null }]);
    await expect(settlePaymentIntent('partner', 'pi_test')).resolves.toMatchObject({ settled: false, status: 'succeeded' });
  });
  it('rejects a held caller transaction before any query or HTTP call', async () => {
    h.held = true;
    await expect(settlePaymentIntent('partner', 'pi_test')).rejects.toThrow(/must run outside any DB access context/);
    expect(h.client).not.toHaveBeenCalled();
  });
});
```

Create `stripeCredentialArchive.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], updates: [] as unknown[], audit: vi.fn() }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'innerJoin', 'where', 'limit', 'orderBy', 'update']) chain[name] = vi.fn(() => chain);
  chain.set = (value: unknown) => { h.updates.push(value); return chain; };
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(resolve);
  return { db: chain };
});
vi.mock('./auditEvents', () => ({ writeAuditEventAsync: h.audit, requestLikeFromSnapshot: () => ({}) }));
import { eraseExpiredStripeCredentials } from './stripeCredentialArchive';
const now = new Date('2026-10-01T00:00:00Z');
const expired = { id: 'credential', partnerId: 'partner', stripeAccountId: 'acct_original', generation: 1, eraseHardCapAt: new Date('2025-01-01T00:00:00Z') };
beforeEach(() => { vi.clearAllMocks(); h.rows.length = 0; h.updates.length = 0; });
describe('credential retention for active collection', () => {
  it('an active attempt overrides even the historical 400-day erase cap', async () => {
    h.rows.push([expired], [{ id: 'active-attempt' }]);
    expect(await eraseExpiredStripeCredentials(now)).toBe(0);
    expect(h.updates).toHaveLength(0);
  });
  it('erases after the hard cap once no active attempt remains', async () => {
    h.rows.push([expired], [], []);
    expect(await eraseExpiredStripeCredentials(now)).toBe(1);
    expect(h.updates).toContainEqual({ apiKey: null, erasedAt: now, updatedAt: now });
  });
});
```

In `services/autopay/merge.test.ts`, extend the existing hoisted `m` fixture with `findArchive: vi.fn()`; initialize it with `m.findArchive.mockReset().mockResolvedValue(null)` in the existing `beforeEach`. Replace the partner factory mock with the following block and add the DB-only archive lookup mock:

```ts
vi.mock('../partnerStripe', () => ({
  getPartnerStripeClient: m.getClient,
  PartnerStripeError: class PartnerStripeError extends Error { constructor(message: string, readonly code: string) { super(message); } },
}));
vi.mock('../stripeCredentialArchive', () => ({ findLatestArchivedCredentialForAccount: m.findArchive }));
```

Add this test; provider HTTP remains exclusively behind `m.getClient`:

```ts
it('detaches with the original archived account after the live account changes', async () => {
  m.execute.mockReset().mockResolvedValueOnce([{ id: 'method', stripe_payment_method_id: 'pm_original', partner_id: 'partner', stripe_account_id: 'acct_original', stripe_customer_id: 'cus_original' }]).mockResolvedValue([]);
  m.getClient.mockResolvedValueOnce({ stripeAccountId: 'acct_replacement', stripe: { paymentMethods: { retrieve: m.retrieve, detach: m.detach } } });
  m.findArchive.mockResolvedValue({ id: 'archive' });
  m.getClient.mockResolvedValueOnce({ stripeAccountId: 'acct_original', stripe: { paymentMethods: { retrieve: m.retrieve, detach: m.detach } } });
  m.retrieve.mockResolvedValue({ customer: 'cus_original' });
  await drainAutopayMethodDetaches();
  expect(m.getClient).toHaveBeenCalledWith('partner', { archivedCredentialId: 'archive', reason: 'autopay_org_merge_detach' });
  expect(m.detach).toHaveBeenCalledWith('pm_original');
});
```

Replace that file's existing `partnerStripe` mock with this boundary, including the error class now consumed by the archive fallback:

```ts
vi.mock('../partnerStripe', () => ({
  getPartnerStripeClient: m.getClient,
  PartnerStripeError: class PartnerStripeError extends Error {
    constructor(message: string, public code: string) { super(message); }
  },
}));
```

Add the disconnected-account branch before implementation:

```ts
it('uses the archived original credential after disconnect', async () => {
  const { PartnerStripeError } = await import('../partnerStripe');
  m.getClient.mockRejectedValueOnce(new PartnerStripeError('Disconnected', 'NO_STRIPE_KEY'));
  m.findArchive.mockResolvedValueOnce({ id: 'archive' });
  m.getClient.mockResolvedValueOnce({ stripeAccountId: 'acct_original', stripe: { paymentMethods: { retrieve: m.retrieve, detach: m.detach } } });
  await drainAutopayMethodDetaches();
  expect(m.getClient).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002', {
    archivedCredentialId: 'archive', reason: 'autopay_org_merge_detach',
  });
  expect(m.detach).toHaveBeenCalledWith('pm_original');
});
```

- [ ] **Step 2: Run it, expect FAIL** — the settle export is missing and the current eraser deletes the active-attempt credential:

```bash
(cd apps/api && npx vitest run src/services/stripeSettle.test.ts src/services/stripeCredentialArchive.test.ts src/services/autopay/merge.test.ts)
```

- [ ] **Step 3: Implement** — create `partnerStripeClient.ts` with the existing stored-key behavior and two narrowly scoped overloads:

```ts
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { stripeConnectAccounts } from '../db/schema/stripePayments';
import { decryptSecret } from './secretCrypto';
import { PartnerStripeError } from './partnerStripe';
import { getSupersededStripeCredential } from './stripeCredentialArchive';

interface StoredClient { stripe: Stripe; stripeAccountId: string; defaultCurrency: string | null }
type ArchivedSource = { archivedCredentialId: string; invoiceStripePaymentId?: string; reason?: 'payment_intent_settlement' | 'autopay_org_merge_detach' };
type CandidateSource = { candidateApiKey: string };
const API_VERSION = '2026-08-26.dahlia';
export function getPartnerStripeClient(partnerId: string, source: CandidateSource): Promise<{ stripe: Stripe }>;
export function getPartnerStripeClient(partnerId: string, source?: ArchivedSource): Promise<StoredClient>;
export async function getPartnerStripeClient(partnerId: string, source?: CandidateSource | ArchivedSource): Promise<StoredClient | { stripe: Stripe }> {
  if (source && 'candidateApiKey' in source) {
    return { stripe: new Stripe(source.candidateApiKey, { apiVersion: API_VERSION }) };
  }
  if (source && 'archivedCredentialId' in source) {
    const archived = await getSupersededStripeCredential(source.archivedCredentialId, { reason: source.reason ?? 'payment_intent_settlement', invoiceStripePaymentId: source.invoiceStripePaymentId });
    if (archived.partnerId !== partnerId) throw new PartnerStripeError('Archived credential belongs to another partner', 'STRIPE_CONNECTION_CHANGED');
    return { stripe: archived.stripe, stripeAccountId: archived.stripeAccountId, defaultCurrency: null };
  }
  const [row] = await db.select({ apiKey: stripeConnectAccounts.apiKey, status: stripeConnectAccounts.status, stripeAccountId: stripeConnectAccounts.stripeAccountId, defaultCurrency: stripeConnectAccounts.defaultCurrency })
    .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  if (!row || row.status !== 'connected' || !row.apiKey) throw new PartnerStripeError('Online payment is not available — connect Stripe first.', 'NO_STRIPE_KEY');
  let key: string | null;
  try { key = decryptSecret(row.apiKey); }
  catch (error) {
    console.error('[partnerStripe] failed to decrypt stored key', { partnerId, message: error instanceof Error ? error.message : String(error) });
    throw new PartnerStripeError('Stored Stripe key could not be read — please reconnect Stripe.', 'STRIPE_KEY_UNREADABLE');
  }
  if (!key) throw new PartnerStripeError('Stored Stripe key could not be read — please reconnect Stripe.', 'STRIPE_KEY_UNREADABLE');
  return { stripe: new Stripe(key, { apiVersion: API_VERSION }), stripeAccountId: row.stripeAccountId, defaultCurrency: row.defaultCurrency };
}
```

Remove the old `getPartnerStripeClient` implementation from `partnerStripe.ts`, then add:

```ts
import { getPartnerStripeClient } from './partnerStripeClient';
export { getPartnerStripeClient } from './partnerStripeClient';
```

`PartnerStripeError` remains in `partnerStripe.ts`; its import cycle with the factory is safe because the class is only accessed when a function is called, never at module initialization. The factory does no provider HTTP work. All existing one-argument imports and return shapes stay unchanged.

In `stripeSettle.ts`, add imports `type Stripe from 'stripe'`, `and, eq` from `drizzle-orm`, `db, runOutsideDbContext` from `../db`, `invoices, invoiceStripePayments` from `../db/schema`, `InvoiceServiceError` from `./invoiceTypes`, `PartnerStripeError` from `./partnerStripe`, and `findLatestArchivedCredentialForAccount` from `./stripeCredentialArchive`. Append:

```ts
export async function settlePaymentIntent(partnerId: string, paymentIntentId: string): Promise<{ settled: boolean; status: Stripe.PaymentIntent.Status; invoiceId: string | null }> {
  assertNoHeldDbContextForStripe('settlePaymentIntent');
  const [mapping] = await withSystemDbAccessContext(() => db.select({
    id: invoiceStripePayments.id, invoiceId: invoiceStripePayments.invoiceId,
    stripeAccountId: invoiceStripePayments.stripeAccountId,
    revocationCredentialId: invoiceStripePayments.revocationCredentialId,
  }).from(invoiceStripePayments).innerJoin(invoices, eq(invoices.id, invoiceStripePayments.invoiceId))
    .where(and(eq(invoices.partnerId, partnerId), eq(invoiceStripePayments.stripeObjectType, 'payment_intent'), eq(invoiceStripePayments.stripeObjectId, paymentIntentId))).limit(1));
  if (!mapping) throw new InvoiceServiceError('Payment mapping not found', 404, 'INVOICE_NOT_FOUND');
  const archived = async (credentialId: string) => withSystemDbAccessContext(() => getPartnerStripeClient(partnerId, { archivedCredentialId: credentialId, invoiceStripePaymentId: mapping.id }));
  let client: Awaited<ReturnType<typeof getPartnerStripeClient>> | null = null;
  if (mapping.revocationCredentialId) client = await archived(mapping.revocationCredentialId);
  else {
    try { client = await withSystemDbAccessContext(() => getPartnerStripeClient(partnerId)); }
    catch (error) { if (!(error instanceof PartnerStripeError) || error.code !== 'NO_STRIPE_KEY') throw error; }
    if (!client || client.stripeAccountId !== mapping.stripeAccountId) {
      const credential = await withSystemDbAccessContext(() => findLatestArchivedCredentialForAccount(partnerId, mapping.stripeAccountId));
      if (!credential) throw new PartnerStripeError('No credential remains for the payment account', 'NO_STRIPE_KEY');
      client = await archived(credential.id);
    }
  }
  if (client.stripeAccountId !== mapping.stripeAccountId) throw new PartnerStripeError('Payment account binding changed', 'STRIPE_CONNECTION_CHANGED');
  const intent = await runOutsideDbContext(() => client!.stripe.paymentIntents.retrieve(paymentIntentId));
  if (intent.id !== paymentIntentId) throw new Error('Stripe returned a different PaymentIntent');
  if (intent.status !== 'succeeded') return { settled: false, status: intent.status, invoiceId: mapping.invoiceId };
  await recordStripePayment({ stripeObjectId: intent.id, stripePaymentIntentId: intent.id, stripeAccountId: mapping.stripeAccountId, amount: fromMinorUnits(intent.amount_received, intent.currency), currency: intent.currency.toUpperCase() });
  const [applied] = await withSystemDbAccessContext(() => db.select({ invoicePaymentId: invoiceStripePayments.invoicePaymentId }).from(invoiceStripePayments).where(eq(invoiceStripePayments.id, mapping.id)).limit(1));
  return { settled: Boolean(applied?.invoicePaymentId), status: intent.status, invoiceId: mapping.invoiceId };
}
```

In `stripeCredentialArchive.ts`, import `inArray` from `drizzle-orm`, `ACTIVE_COLLECTION_ATTEMPT_STATES` from `@breeze/shared`, and `invoiceCollectionAttempts, orgPaymentMethods, orgAutopayEnrollments` from `../db/schema/autopay`.

In `archiveSupersededCredential`, keep the existing Checkout re-point update. Immediately after it, before `return archived.id`, append this PaymentIntent update:

```ts
await db.update(invoiceStripePayments).set({ revocationCredentialId: archived.id, updatedAt: now }).where(and(
  eq(invoiceStripePayments.stripeAccountId, input.stripeAccountId),
  eq(invoiceStripePayments.stripeObjectType, 'payment_intent'),
  isNull(invoiceStripePayments.revocationCredentialId),
  sql`exists (select 1 from ${invoiceCollectionAttempts}
    where (${invoiceCollectionAttempts.invoiceStripePaymentId} = ${invoiceStripePayments.id}
      or ${invoiceCollectionAttempts.stripePaymentIntentId} = ${invoiceStripePayments.stripeObjectId})
    and ${inArray(invoiceCollectionAttempts.state, [...ACTIVE_COLLECTION_ATTEMPT_STATES])})`,
));
```

In `eraseExpiredStripeCredentials`, insert this block at the beginning of each candidate iteration, before computing `pastHardCap`:

```ts
const [activeAttempt] = await db.select({ id: invoiceCollectionAttempts.id })
  .from(invoiceCollectionAttempts)
  .innerJoin(orgPaymentMethods, eq(orgPaymentMethods.id, invoiceCollectionAttempts.paymentMethodId))
  .innerJoin(orgAutopayEnrollments, eq(orgAutopayEnrollments.id, orgPaymentMethods.enrollmentId))
  .where(and(
    eq(orgAutopayEnrollments.partnerId, candidate.partnerId),
    eq(orgAutopayEnrollments.stripeAccountId, candidate.stripeAccountId),
    inArray(invoiceCollectionAttempts.state, [...ACTIVE_COLLECTION_ATTEMPT_STATES]),
  )).limit(1);
if (activeAttempt) continue;
```

This conservatively retains every archived generation for that partner/account while an active attempt exists, including a `reserved` attempt whose PI/mapping has not yet been persisted. Method/enrollment records remain after cancellation, so detaching a saved method does not break the retention join. Terminal methods may be nulled during org merge only after the active-attempt guard has refused the merge. Update the two erasure comments to state that the 400-day cap applies only after active collection attempts resolve; do not silently leave the old “unconditionally” promise in documentation.

In `services/autopay/merge.ts`, extend its `partnerStripe` import with `PartnerStripeError`, and import `findLatestArchivedCredentialForAccount` from `../stripeCredentialArchive`. Replace the W1a `drainAutopayMethodDetaches` client load and account guard with this block:

```ts
const client = await withSystemDbAccessContext(async () => {
  let live: Awaited<ReturnType<typeof getPartnerStripeClient>> | null = null;
  try { live = await getPartnerStripeClient(row.partner_id); }
  catch (error) { if (!(error instanceof PartnerStripeError) || error.code !== 'NO_STRIPE_KEY') throw error; }
  if (live?.stripeAccountId === row.stripe_account_id) return live;
  const archived = await findLatestArchivedCredentialForAccount(row.partner_id, row.stripe_account_id);
  if (!archived) throw new Error('original Stripe account credential unavailable');
  const original = await getPartnerStripeClient(row.partner_id, { archivedCredentialId: archived.id, reason: 'autopay_org_merge_detach' });
  if (original.stripeAccountId !== row.stripe_account_id) throw new Error('archived Stripe credential account mismatch');
  return original;
});
```

The existing method customer-binding check, retrieve/detach HTTP outside the context, and durable retry marker remain unchanged. A missing archived key leaves the removed method queued, never detaches on a replacement account.

- [ ] **Step 4: Run it, expect PASS**:

```bash
(cd apps/api && npx vitest run src/services/stripeSettle.test.ts src/services/stripeCredentialArchive.test.ts src/services/stripeReconcile.test.ts src/services/autopay/merge.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/stripeSettle.integration.test.ts src/__tests__/integration/stripeSessionRevocation.integration.test.ts)
```

Expected: no Stripe retrieve observes a held DB context; active attempts retain keys beyond 400 days; paid but unlinked mappings return `settled:false`; existing Checkout settlement and revocation tests remain green.

- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/autopay/merge.ts apps/api/src/services/autopay/merge.test.ts apps/api/src/services/partnerStripeClient.ts apps/api/src/services/partnerStripe.ts apps/api/src/services/stripeSettle.ts apps/api/src/services/stripeSettle.test.ts apps/api/src/services/stripeCredentialArchive.ts apps/api/src/services/stripeCredentialArchive.test.ts
git commit -m "feat(billing): settle PaymentIntents using retained account credentials"
```

### Task 11: Probe restricted-key capabilities and persist account-bound readiness

**Files:** Create `apps/api/src/services/autopay/stripeCapabilities.ts`, `apps/api/src/services/autopay/stripeCapabilities.test.ts`. Modify `apps/api/src/services/partnerStripe.ts`, `apps/api/src/services/partnerStripe.test.ts`, `apps/api/src/routes/stripeConnect/index.ts`, `apps/api/src/routes/stripeConnect/index.test.ts`, `apps/docs/src/content/docs/features/online-payments.mdx`.

**Interfaces:** Consumes the candidate/stored overloads of `getPartnerStripeClient` re-exported by `partnerStripe.ts`, `Tx` from `services/autopay/types.ts`, and W1a `stripeConnectAccounts.autopayCapabilitiesCheckedAt`/`.autopayMissingPermissions`. Produces C4 `AutopayStripeCapability`, `probeAutopayCapabilities(stripe: Stripe): Promise<{ missing: AutopayStripeCapability[] }>`, `getAutopayStripeReadiness(db: Tx, partnerId: string): Promise<{ ready: boolean; missing: AutopayStripeCapability[]; stripeAccountId: string | null; accountCountry: string | null }>`.

The probe uses update/retrieve operations on impossible synthetic IDs, never creates real Customers, SetupIntents, PaymentIntents or PaymentMethods. Only `resource_missing` proves a capability. Permission errors add that exact permission to `missing`; authentication failures and transient/unknown errors throw, leaving the last persisted readiness untouched. A key that supports existing checkout but lacks autopay permissions still saves successfully, with `missing` persisted. Readiness is false for never-probed connections and unsupported account countries, even when the default array is empty.

- [ ] **Step 1: Write the failing test** — create `stripeCapabilities.test.ts`:

```ts
import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ client: vi.fn(), depth: 0 }));
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: h.client }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn() }));
import { getPartnerStripeClient } from '../partnerStripe';
import { probeAutopayCapabilities, getAutopayStripeReadiness } from './stripeCapabilities';
import type { Tx } from './types';
const missingResource = () => Object.assign(new Error('synthetic missing object'), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
function client() {
  const call = () => vi.fn().mockRejectedValue(missingResource());
  return { customers: { update: call() }, setupIntents: { update: call() }, paymentIntents: { update: call() }, paymentMethods: { update: call() }, mandates: { retrieve: call() } };
}
function executor(row?: Record<string, unknown>): Tx {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'where', 'limit']) chain[name] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(row ? [row] : []).then(resolve);
  return chain as unknown as Tx;
}
beforeEach(() => vi.clearAllMocks());
describe('autopay capability probes', () => {
  it('proves all five write/read permissions using missing resources without creating objects', async () => {
    const sdk = client(); h.client.mockResolvedValue({ stripe: sdk });
    const { stripe } = await getPartnerStripeClient('partner', { candidateApiKey: 'synthetic_candidate' });
    await expect(probeAutopayCapabilities(stripe)).resolves.toEqual({ missing: [] });
    expect(sdk.customers.update).toHaveBeenCalledWith('cus_breeze_autopay_permission_probe', { metadata: {} });
    expect(sdk.setupIntents.update).toHaveBeenCalledTimes(1);
    expect(sdk.paymentIntents.update).toHaveBeenCalledTimes(1);
    expect(sdk.paymentMethods.update).toHaveBeenCalledTimes(1);
    expect(sdk.mandates.retrieve).toHaveBeenCalledTimes(1);
  });
  it('reports only the denied permission', async () => {
    const sdk = client(); sdk.setupIntents.update.mockRejectedValue(Object.assign(new Error('denied'), { type: 'StripePermissionError' }));
    h.client.mockResolvedValue({ stripe: sdk });
    const { stripe } = await getPartnerStripeClient('partner');
    await expect(probeAutopayCapabilities(stripe)).resolves.toEqual({ missing: ['setup_intents_write'] });
  });
  it.each(['StripeAPIError', 'StripeConnectionError', 'StripeRateLimitError', 'StripeAuthenticationError', 'unexpected'])('does not call %s a missing permission', async (type) => {
    const sdk = client(); sdk.customers.update.mockRejectedValue(Object.assign(new Error('probe failure'), { type }));
    h.client.mockResolvedValue({ stripe: sdk });
    const { stripe } = await getPartnerStripeClient('partner');
    await expect(probeAutopayCapabilities(stripe)).rejects.toThrow('probe failure');
  });
  it.each([
    ['US', new Date(), [], true], ['IN', new Date(), [], false],
    ['US', null, [], false], ['US', new Date(), ['mandates_read'], false],
  ])('country=%s probe=%s missing=%s yields ready=%s', async (accountCountry, checked, missing, ready) => {
    const tx = executor({ status: 'connected', stripeAccountId: 'acct_test', accountCountry, autopayCapabilitiesCheckedAt: checked, autopayMissingPermissions: missing });
    await expect(getAutopayStripeReadiness(tx, 'partner')).resolves.toMatchObject({ ready, missing, stripeAccountId: 'acct_test', accountCountry });
  });
  it('an invisible or disconnected connection cannot become ready', async () => {
    await expect(getAutopayStripeReadiness(executor(), 'partner')).resolves.toEqual({ ready: false, missing: [], stripeAccountId: null, accountCountry: null });
  });
});
```

In `partnerStripe.test.ts`, replace its `vi.mock('stripe', ...)` constructor stub with this factory-boundary mock. Keep the existing hoisted `accountsRetrieveMock`, `eventsListMock`, `sessionsExpireMock`, and Drizzle/context fixtures:

```ts
const { clientBoundaryMock, capabilityProbeMock, clientRow } = vi.hoisted(() => ({ clientBoundaryMock: vi.fn(), capabilityProbeMock: vi.fn(), clientRow: { current: null as Record<string, unknown> | null } }));
vi.mock('./partnerStripeClient', () => ({ getPartnerStripeClient: clientBoundaryMock }));
vi.mock('./autopay/stripeCapabilities', () => ({ probeAutopayCapabilities: capabilityProbeMock }));
```

In that file's existing `dbMocks` SELECT terminal `run`, replace `return Promise.resolve(dbMocks.selectResults.shift() ?? [])` with this code so the client-boundary mock sees the generation the preceding real service read selected:

```ts
const resultRows = dbMocks.selectResults.shift() ?? [];
clientRow.current = (resultRows[0] as Record<string, unknown> | undefined) ?? null;
return Promise.resolve(resultRows);
```

Add these statements to its `beforeEach` after resetting the existing fixture queues:

```ts
clientRow.current = null;
capabilityProbeMock.mockReset().mockResolvedValue({ missing: [] });
clientBoundaryMock.mockReset().mockImplementation(async (_partnerId: string, source?: { candidateApiKey?: string }) => {
  const stripe = { accounts: { retrieve: accountsRetrieveMock }, events: { list: eventsListMock }, checkout: { sessions: { expire: sessionsExpireMock } } };
  if (source?.candidateApiKey) return { stripe };
  const row = clientRow.current;
  if (!row || row.status !== 'connected' || !row.apiKey) {
    throw new PartnerStripeError('Online payment is not available — connect Stripe first.', 'NO_STRIPE_KEY');
  }
  return { stripe, stripeAccountId: String(row.stripeAccountId), defaultCurrency: row.defaultCurrency ?? null };
});
```

Add these tests to its `savePartnerStripeKey` describe:

```ts
it('saves a checkout-capable key with missing autopay permissions in both upsert arms', async () => {
  capabilityProbeMock.mockResolvedValue({ missing: ['setup_intents_write', 'mandates_read'] });
  dbMocks.selectResults.push([]);
  const result = await savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID });
  expect(clientBoundaryMock).toHaveBeenCalledWith(PARTNER_A, { candidateApiKey: TEST_KEY });
  expect(result).toMatchObject({ autopayMissingPermissions: ['setup_intents_write', 'mandates_read'], autopayCapabilitiesCheckedAt: expect.any(Date) });
  expect(dbMocks.insertedValues[0]).toMatchObject({ autopayMissingPermissions: ['setup_intents_write', 'mandates_read'], autopayCapabilitiesCheckedAt: expect.any(Date) });
  expect(dbMocks.upsertConfigs[0]).toMatchObject({ set: expect.objectContaining({ autopayMissingPermissions: ['setup_intents_write', 'mandates_read'] }) });
});
it('does not overwrite a saved capability snapshot on a probe outage', async () => {
  capabilityProbeMock.mockRejectedValue(Object.assign(new Error('temporary'), { type: 'StripeAPIError' }));
  await expect(savePartnerStripeKey({ partnerId: PARTNER_A, apiKey: TEST_KEY, userId: USER_ID })).rejects.toMatchObject({ code: 'STRIPE_UNAVAILABLE' });
  expect(dbMocks.insertedValues).toHaveLength(0);
});
```

In `routes/stripeConnect/index.test.ts`, add these fields to both existing `savePartnerStripeKey` and `refreshPartnerStripeAccount` resolved fixtures in `beforeEach`:

```ts
autopayCapabilitiesCheckedAt: new Date('2026-10-01T00:00:00Z'),
autopayMissingPermissions: ['mandates_read'],
```

Add these exact fields to the existing POST `/key` and POST `/refresh` success `toEqual` response objects (the GET snapshot fixture is unchanged):

```ts
autopayCapabilitiesCheckedAt: '2026-10-01T00:00:00.000Z',
autopayMissingPermissions: ['mandates_read'],
```

Then add:

```ts
it('POST /refresh returns persisted autopay readiness facts', async () => {
  const response = await stripeConnectRoutes.request('/refresh', { method: 'POST' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ autopayCapabilitiesCheckedAt: '2026-10-01T00:00:00.000Z', autopayMissingPermissions: ['mandates_read'] });
});
```

This is an existing mounted route (`stripeConnectRoutes` in `routes/stripeConnect/index.ts`); W1 adds no new path here. Its existing permission, partner-scope and refresh error tests remain mandatory.

In `partnerStripe.test.ts`, keep its `connectedRow` fixture's current account/status/key fields and add `connectedAt: new Date('2026-10-01T00:00:00Z')`. Its row still serves the one generation SELECT; the mocked factory consumes no second queue entry. Add the following fields to `returnedRow` and every inline refresh RETURNING fixture:

```ts
autopayCapabilitiesCheckedAt: new Date('2026-10-01T00:00:00Z'),
autopayMissingPermissions: [],
```

Add `autopayCapabilitiesCheckedAt: expect.any(Date), autopayMissingPermissions: []` to the refresh success test's exact returned-object and written-patch assertions. Preserve the old/new-account row values in its two-attempt retry fixtures. In the guard test `guards the update on partner + account id + connected status`, additionally assert:

```ts
expect(terms.columns).toContain('api_key');
expect(terms.params).toContain('enc(sk_test_x)');
```

Extend the save-key success exact-object assertion in `partnerStripe.test.ts` with `autopayCapabilitiesCheckedAt: expect.any(Date)` and `autopayMissingPermissions: []`. These are deliberate additional response facts.

- [ ] **Step 2: Run it, expect FAIL** — the probe module is missing and save/refresh do not persist or return capability facts:

```bash
(cd apps/api && npx vitest run src/services/autopay/stripeCapabilities.test.ts src/services/partnerStripe.test.ts src/routes/stripeConnect/index.test.ts)
```

- [ ] **Step 3: Implement** — create `stripeCapabilities.ts`:

```ts
import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { runOutsideDbContext } from '../../db';
import { stripeConnectAccounts } from '../../db/schema/stripePayments';
import type { Tx } from './types';
export type AutopayStripeCapability = 'customers_write' | 'setup_intents_write' | 'payment_intents_write' | 'payment_methods_write' | 'mandates_read';
const COUNTRIES = new Set(['US', 'CA', 'GB', 'AU', 'NZ', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
export async function probeAutopayCapabilities(stripe: Stripe): Promise<{ missing: AutopayStripeCapability[] }> {
  const probes: Array<[AutopayStripeCapability, () => Promise<unknown>]> = [
    ['customers_write', () => stripe.customers.update('cus_breeze_autopay_permission_probe', { metadata: {} })],
    ['setup_intents_write', () => stripe.setupIntents.update('seti_breeze_autopay_permission_probe', { metadata: {} })],
    ['payment_intents_write', () => stripe.paymentIntents.update('pi_breeze_autopay_permission_probe', { metadata: {} })],
    ['payment_methods_write', () => stripe.paymentMethods.update('pm_breeze_autopay_permission_probe', { metadata: {} })],
    ['mandates_read', () => stripe.mandates.retrieve('mandate_breeze_autopay_permission_probe')],
  ];
  const missing: AutopayStripeCapability[] = [];
  for (const [capability, probe] of probes) {
    try { await runOutsideDbContext(probe); }
    catch (error) {
      const failure = error as { type?: string; code?: string };
      if (failure.type === 'StripePermissionError') { missing.push(capability); continue; }
      if (failure.type === 'StripeInvalidRequestError' && failure.code === 'resource_missing') continue;
      throw error;
    }
  }
  return { missing };
}
export async function getAutopayStripeReadiness(db: Tx, partnerId: string): Promise<{ ready: boolean; missing: AutopayStripeCapability[]; stripeAccountId: string | null; accountCountry: string | null }> {
  const [row] = await db.select({ status: stripeConnectAccounts.status, stripeAccountId: stripeConnectAccounts.stripeAccountId, accountCountry: stripeConnectAccounts.accountCountry, autopayCapabilitiesCheckedAt: stripeConnectAccounts.autopayCapabilitiesCheckedAt, autopayMissingPermissions: stripeConnectAccounts.autopayMissingPermissions })
    .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  if (!row || row.status !== 'connected') return { ready: false, missing: [], stripeAccountId: null, accountCountry: null };
  const all: AutopayStripeCapability[] = ['customers_write', 'setup_intents_write', 'payment_intents_write', 'payment_methods_write', 'mandates_read'];
  const known = new Set<string>(all);
  const raw = row.autopayMissingPermissions;
  const missing = raw.filter((value): value is AutopayStripeCapability => known.has(value));
  return { ready: row.autopayCapabilitiesCheckedAt !== null && raw.length === 0 && COUNTRIES.has(row.accountCountry ?? ''), missing, stripeAccountId: row.stripeAccountId, accountCountry: row.accountCountry };
}
```

`getAutopayStripeReadiness` does not escalate its passed executor. Partner-axis callers must invoke it in a short system context or an authorized partner context before opening an org transaction; an org-scoped context that cannot see the row fails closed. The function does not call Stripe.

In `partnerStripe.ts`, import `probeAutopayCapabilities, type AutopayStripeCapability` from `./autopay/stripeCapabilities`. Replace `const probe = new Stripe(apiKey, { apiVersion: API_VERSION })` in `savePartnerStripeKey` with:

```ts
const { stripe: probe } = await getPartnerStripeClient(input.partnerId, { candidateApiKey: apiKey });
```

Immediately after the existing Checkout write-permission probe and before any credential archive/update, insert:

```ts
let autopayMissingPermissions: AutopayStripeCapability[];
try { ({ missing: autopayMissingPermissions } = await probeAutopayCapabilities(probe)); }
catch (error) {
  throw isTransientStripeError(error)
    ? new PartnerStripeError('Could not verify automatic-payment permissions — try again.', 'STRIPE_UNAVAILABLE')
    : new PartnerStripeError('Could not verify automatic-payment permissions for this key.', 'STRIPE_ACCOUNT_UNKNOWN');
}
```

Add `autopayCapabilitiesCheckedAt: Date; autopayMissingPermissions: AutopayStripeCapability[];` to the save return type and `StripeAccountRefreshResult`. In both the INSERT values and UPDATE set of the save upsert, insert the exact same fields:

```ts
autopayCapabilitiesCheckedAt: now,
autopayMissingPermissions,
```

Add those fields to the function's returned object as well.

For refresh, guard capability results against same-account key rotation as well as account replacement. Replace the first client-loading statement of `refreshPartnerStripeAccount` with:

```ts
const snapshot = await withSystemDbAccessContext(async () => {
  const [generation] = await db.select({ apiKey: stripeConnectAccounts.apiKey, connectedAt: stripeConnectAccounts.connectedAt })
    .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  const client = await getPartnerStripeClient(partnerId);
  if (!generation?.apiKey) throw new PartnerStripeError('Online payment is not available — connect Stripe first.', 'NO_STRIPE_KEY');
  return { ...client, encryptedKey: generation.apiKey, connectedAt: generation.connectedAt };
});
const { stripe, stripeAccountId } = snapshot;
```

The existing account retrieve and its error classification stay in place. After retrieving account facts and before the UPDATE, add:

```ts
let autopayMissingPermissions: AutopayStripeCapability[];
try { ({ missing: autopayMissingPermissions } = await probeAutopayCapabilities(stripe)); }
catch (error) {
  throw isTransientStripeError(error)
    ? new PartnerStripeError('Could not verify automatic-payment permissions — try again.', 'STRIPE_UNAVAILABLE')
    : new PartnerStripeError('Could not verify automatic-payment permissions for this key.', 'STRIPE_ACCOUNT_UNKNOWN');
}
```

Add `autopayCapabilitiesCheckedAt: now, autopayMissingPermissions` to the existing refresh UPDATE; add `eq(stripeConnectAccounts.apiKey, snapshot.encryptedKey)` to its `and(...)` predicate. The ciphertext stays solely inside this function and the parameterized predicate, never a log, route response or audit payload. Add both new columns to its RETURNING projection and returned object:

```ts
autopayCapabilitiesCheckedAt: updated.autopayCapabilitiesCheckedAt ?? now,
autopayMissingPermissions: updated.autopayMissingPermissions as AutopayStripeCapability[],
```

Keep the existing one-retry `STRIPE_CONNECTION_CHANGED` behavior on a zero-row update. The existing `getPartnerStripeAccountSnapshot` currently spreads the entire refresh result. Preserve its established GET snapshot shape while POST refresh gains readiness facts: replace `const fresh = await refreshPartnerStripeAccount(partnerId)` in that function with:

```ts
const {
  autopayCapabilitiesCheckedAt: _autopayChecked,
  autopayMissingPermissions: _autopayMissing,
  ...fresh
} = await refreshPartnerStripeAccount(partnerId);
```

Existing GET exact-object assertions remain unchanged. The readiness resolver reads the persisted columns directly, and POST refresh returns its guarded RETURNING facts.

In the POST `/key` and POST `/refresh` JSON responses in `routes/stripeConnect/index.ts`, add:

```ts
autopayCapabilitiesCheckedAt: result.autopayCapabilitiesCheckedAt.toISOString(),
autopayMissingPermissions: result.autopayMissingPermissions,
```

Append this text under the connection instructions in `online-payments.mdx`:

```md
### Restricted-key permissions

For existing invoice checkout, the key must read the Stripe account and Events and have Checkout Sessions write access. Breeze also checks the following permissions for automatic payments:

| Stripe resource | Required access |
| --- | --- |
| Customers | Write |
| SetupIntents | Write |
| PaymentIntents | Write |
| PaymentMethods | Write |
| Mandates | Read |

Saving or refreshing the key checks these permissions without creating a payment or saving a customer's payment method. A missing automatic-payment permission does not disable existing card checkout. Automatic payments remain unavailable until every required permission is present and the feature is enabled for your partner account. Use **Refresh** after updating a restricted key's permissions.

Automatic payments support Stripe accounts in the United States, Canada, United Kingdom, European Economic Area, Australia and New Zealand. Bank-account debit requires a United States Stripe account and a USD invoice. Existing one-time invoice checkout remains card-only.
```

- [ ] **Step 4: Run it, expect PASS**:

```bash
(cd apps/api && npx vitest run src/services/autopay/stripeCapabilities.test.ts src/services/partnerStripe.test.ts src/routes/stripeConnect/index.test.ts src/services/stripeSettle.test.ts)
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: restricted-key failure lists are exact; transient failures do not overwrite readiness; refresh returns facts from its guarded RETURNING result; all Stripe mocks sit at the factory boundary.

- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/autopay/stripeCapabilities.ts apps/api/src/services/autopay/stripeCapabilities.test.ts apps/api/src/services/partnerStripe.ts apps/api/src/services/partnerStripe.test.ts apps/api/src/routes/stripeConnect/index.ts apps/api/src/routes/stripeConnect/index.test.ts apps/docs/src/content/docs/features/online-payments.mdx
git commit -m "feat(billing): persist Stripe automatic-payment capability readiness"
```

### Task 12: Row-bound billing link tokens
**Files:** Create `apps/api/src/services/autopay/linkTokens.ts`; Test `apps/api/src/services/autopay/linkTokens.test.ts`.
**Interfaces:** Consumes `Tx` from `services/autopay/types.ts`, `BillingLinkPurpose` from `@breeze/shared`, `billingLinkTokens` from `db/schema`, `encryptSecret(value, { aad })`, `columnAad(spec, rowId)`, and `portalBase()`. Produces all four C4 exports: `mintBillingLinkToken(tx: Tx, input: { orgId: string; purpose: BillingLinkPurpose; enrollmentId?: string; invoiceId?: string; generation?: number; ttlDays: number }): Promise<{ token: string; id: string }>`, `resolveBillingLinkToken(db: Tx, token: string, purpose: BillingLinkPurpose): Promise<typeof billingLinkTokens.$inferSelect | null>`, `revokeBillingLinkTokens(tx: Tx, filter: { orgId: string; purpose?: BillingLinkPurpose; enrollmentId?: string; invoiceId?: string }): Promise<number>`, and `buildBillingLinkUrl(purpose: BillingLinkPurpose, token: string): string`.

Existing evidence: `hashInvoiceLinkToken`, `getOrMintInvoiceLink`, and `buildPublicInvoiceUrl` in `apps/api/src/services/invoiceLinkToken.ts`; `columnAad` in `apps/api/src/services/encryptedColumnRegistry.ts`. Resolve uses the hash only, so encryption-key rotation cannot invalidate an issued link. The caller owns RLS context; anonymous routes in W2 must establish system lookup context and bind subsequent access to the returned org.

- [ ] **Step 1: Write the failing test** — create `linkTokens.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Tx } from './types';
const { encrypt } = vi.hoisted(() => ({ encrypt: vi.fn((v: string, o: { aad: string }) => `sealed:${o.aad}:${v}`) }));
vi.mock('../secretCrypto', () => ({ encryptSecret: encrypt }));
vi.mock('../portalUrl', () => ({ portalBase: () => 'https://portal.example.test/portal' }));
import { mintBillingLinkToken, resolveBillingLinkToken, revokeBillingLinkTokens, buildBillingLinkUrl } from './linkTokens';

function fakeDb(rows: unknown[] = []) {
  const writes: unknown[] = [];
  const chain: any = {};
  for (const name of ['from', 'where', 'limit', 'returning']) chain[name] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  const api = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => ({ values: vi.fn(async (v: unknown) => { writes.push(v); }) })),
    update: vi.fn(() => ({ set: vi.fn((v: unknown) => { writes.push(v); return chain; }) })),
  };
  return { tx: api as unknown as Tx, api, writes };
}
beforeEach(() => vi.clearAllMocks());
describe('billing links', () => {
  it('stores 32 random bytes as a hash and a row-bound ciphertext', async () => {
    const f = fakeDb();
    const input = { orgId: '11111111-1111-4111-8111-111111111111', purpose: 'enroll' as const, ttlDays: 7 };
    const a = await mintBillingLinkToken(f.tx, input);
    const b = await mintBillingLinkToken(f.tx, input);
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
    expect(f.writes[0]).toMatchObject({ id: a.id, orgId: input.orgId,
      tokenHash: createHash('sha256').update(a.token).digest('hex'),
      tokenCt: `sealed:billing_link_tokens.token_ct:${a.id}:${a.token}` });
    expect(encrypt).toHaveBeenCalledWith(a.token, { aad: `billing_link_tokens.token_ct:${a.id}` });
  });
  it.each([0, -1, Infinity, NaN, 1.5])('rejects invalid TTL %s without writing', async ttlDays => {
    const f = fakeDb();
    await expect(mintBillingLinkToken(f.tx, { orgId: crypto.randomUUID(), purpose: 'enroll', ttlDays })).rejects.toThrow('ttlDays');
    expect(f.api.insert).not.toHaveBeenCalled();
  });
  it('rejects malformed token before querying', async () => {
    const f = fakeDb();
    expect(await resolveBillingLinkToken(f.tx, 'bad token', 'enroll')).toBeNull();
    expect(f.api.select).not.toHaveBeenCalled();
  });
  it.each([
    { expiresAt: new Date(0) }, { revokedAt: new Date() },
    { consumedAt: new Date() }, { purpose: 'confirm_payment' },
  ])('refuses expired/revoked/consumed/wrong-purpose rows: %j', async changes => {
    const row = { purpose: 'enroll', expiresAt: new Date(Date.now() + 100000), revokedAt: null, consumedAt: null, ...changes };
    expect(await resolveBillingLinkToken(fakeDb([row]).tx, 'A'.repeat(43), 'enroll')).toBeNull();
  });
  it('GET-style resolution performs no mutation, including repeated reads', async () => {
    const row = { purpose: 'enroll', expiresAt: new Date(Date.now() + 100000), revokedAt: null, consumedAt: null };
    const f = fakeDb([row]);
    expect(await resolveBillingLinkToken(f.tx, 'A'.repeat(43), 'enroll')).toEqual(row);
    expect(await resolveBillingLinkToken(f.tx, 'A'.repeat(43), 'enroll')).toEqual(row);
    expect(f.writes).toEqual([]);
  });
  it('returns zero on unknown token and counts revoked rows', async () => {
    expect(await resolveBillingLinkToken(fakeDb().tx, 'A'.repeat(43), 'enroll')).toBeNull();
    expect(await revokeBillingLinkTokens(fakeDb([{ id: '1' }, { id: '2' }]).tx,
      { orgId: crypto.randomUUID(), purpose: 'enroll' })).toBe(2);
  });
  it.each([
    ['enroll', ''], ['skip_invoice', '/skip'], ['stop_autopay', '/stop'], ['confirm_payment', '/confirm'],
  ] as const)('builds %s on the portal base', (purpose, suffix) => {
    expect(buildBillingLinkUrl(purpose, 'a/b')).toBe(`https://portal.example.test/portal/autopay/a%2Fb${suffix}`);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/linkTokens.test.ts`; missing `./linkTokens` module.
- [ ] **Step 3: Implement** — create `linkTokens.ts`:

```ts
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { BillingLinkPurpose } from '@breeze/shared';
import { billingLinkTokens } from '../../db/schema';
import { encryptSecret } from '../secretCrypto';
import { columnAad, encryptedColumnRegistry } from '../encryptedColumnRegistry';
import { portalBase } from '../portalUrl';
import type { Tx } from './types';
const spec = encryptedColumnRegistry.find(s => s.table === 'billing_link_tokens' && s.column === 'token_ct');
if (!spec) throw new Error('billing_link_tokens.token_ct is not registered');

export async function mintBillingLinkToken(tx: Tx, input: {
  orgId: string; purpose: BillingLinkPurpose; enrollmentId?: string;
  invoiceId?: string; generation?: number; ttlDays: number;
}): Promise<{ token: string; id: string }> {
  if (!Number.isSafeInteger(input.ttlDays) || input.ttlDays <= 0) throw new Error('ttlDays must be a positive integer');
  const expiresAt = new Date(Date.now() + input.ttlDays * 86400000);
  if (!Number.isFinite(expiresAt.getTime())) throw new Error('ttlDays exceeds Date range');
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const tokenCt = encryptSecret(token, { aad: columnAad(spec!, id) });
  if (!tokenCt) throw new Error('Could not encrypt billing link');
  await tx.insert(billingLinkTokens).values({
    id, orgId: input.orgId, purpose: input.purpose,
    enrollmentId: input.enrollmentId ?? null, invoiceId: input.invoiceId ?? null,
    generation: input.generation ?? null, expiresAt,
    tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'), tokenCt,
  });
  return { token, id };
}
export async function resolveBillingLinkToken(db: Tx, token: string, purpose: BillingLinkPurpose): Promise<typeof billingLinkTokens.$inferSelect | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db.select().from(billingLinkTokens).where(and(
    eq(billingLinkTokens.tokenHash, createHash('sha256').update(token, 'utf8').digest('hex')),
    eq(billingLinkTokens.purpose, purpose),
  )).limit(1);
  if (!row || row.purpose !== purpose || row.expiresAt.getTime() <= Date.now() || row.revokedAt) return null;
  if ((purpose === 'enroll' || purpose === 'confirm_payment') && row.consumedAt) return null;
  return row;
}
export async function revokeBillingLinkTokens(tx: Tx, filter: {
  orgId: string; purpose?: BillingLinkPurpose; enrollmentId?: string; invoiceId?: string;
}): Promise<number> {
  const rows = await tx.update(billingLinkTokens).set({ revokedAt: new Date() }).where(and(
    eq(billingLinkTokens.orgId, filter.orgId), isNull(billingLinkTokens.revokedAt),
    filter.purpose === undefined ? undefined : eq(billingLinkTokens.purpose, filter.purpose),
    filter.enrollmentId === undefined ? undefined : eq(billingLinkTokens.enrollmentId, filter.enrollmentId),
    filter.invoiceId === undefined ? undefined : eq(billingLinkTokens.invoiceId, filter.invoiceId),
  )).returning({ id: billingLinkTokens.id });
  return rows.length;
}
export function buildBillingLinkUrl(purpose: BillingLinkPurpose, token: string): string {
  const suffix: Record<BillingLinkPurpose, string> = {
    enroll: '', skip_invoice: '/skip', stop_autopay: '/stop', confirm_payment: '/confirm',
  };
  return `${portalBase()}/autopay/${encodeURIComponent(token)}${suffix[purpose]}`;
}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/linkTokens.test.ts src/services/invoiceLinkToken.test.ts src/services/encryptedColumnRegistry.test.ts`.
- [ ] **Step 5: Commit** — from repository root:

```bash
git add apps/api/src/services/autopay/linkTokens.ts apps/api/src/services/autopay/linkTokens.test.ts
git commit -m "feat(billing): add row-bound autopay action tokens"
```

### Task 13: Per-kind billing rendering with mandatory append blocks
**Files:** Create `apps/api/src/services/autopay/renderBillingNotice.ts`; Test `apps/api/src/services/autopay/renderBillingNotice.test.ts`.
**Interfaces:** Consumes `BillingNoticeKind`, `RenderPartnerEmailArgs`, `renderPartnerEmail(args): { subject: string; html: string }`; produces `BillingNoticeContext`, `registerBillingNoticeRenderer(kind: BillingNoticeKind, renderer: BillingNoticeRenderer): void`, `renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext): Promise<RenderedNotice>`. `RenderedNotice` is the C4 type exported by `noticeOutbox.ts` in Task 14; use a type-only import, which is erased at runtime. Implement Tasks 13–14 in sequence before the W1b typecheck.

`renderPartnerEmail` and its `bodyAfterCta` append point are verified in `apps/api/src/services/emailTemplates/renderPartnerEmail.ts`. Registry callbacks select templates and plain text; the wrapper, not editable template HTML, owns Skip/Stop/fee/authorization blocks. No production registry entry or new `EMAIL_TEMPLATE_IDS` value is added in W1.

- [ ] **Step 1: Write the failing test** — create `renderBillingNotice.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { BillingNoticeKind } from '@breeze/shared';
import type { RenderPartnerEmailArgs } from '../emailTemplates/renderPartnerEmail';
const { renderedArgs } = vi.hoisted(() => ({ renderedArgs: vi.fn() }));
vi.mock('../emailTemplates/renderPartnerEmail', () => ({
  renderPartnerEmail: (args: RenderPartnerEmailArgs) => {
    renderedArgs(args);
    return { subject: 'Frozen subject', html: `${args.custom?.html ?? ''}${args.bodyAfterCta ?? ''}` };
  },
}));
import { renderBillingNotice, registerBillingNoticeRenderer, type BillingNoticeContext } from './renderBillingNotice';

const ctx: BillingNoticeContext = { partnerId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222', data: {},
  frozen: { amount: '100.00', date: '2026-10-20' },
  mandatory: { skipUrl: 'https://portal.example.test/skip', stopUrl: 'https://portal.example.test/stop',
    feeDisclosure: 'Fee < $3', achAuthorizationReference: 'Mandate <reference>' } };
describe('billing renderer registry', () => {
  it('starts with no production renderers', async () => {
    await expect(renderBillingNotice('card_expiring', ctx)).rejects.toThrow('No billing renderer');
  });
  it('appends escaped mandatory copy outside a fully replaced editable body', async () => {
    const fakeKind = 'test_only' as BillingNoticeKind;
    registerBillingNoticeRenderer(fakeKind, async () => ({
      email: { id: 'invoice_send', vars: {}, custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Partner replacement</p>' } },
      text: 'Partner text',
    }));
    const result = await renderBillingNotice(fakeKind, ctx);
    expect(result.html).toContain('<p>Partner replacement</p>');
    expect(result.html).toContain('Fee &lt; $3');
    expect(result.html).toContain('Mandate &lt;reference&gt;');
    expect(result.html).toContain('https://portal.example.test/skip');
    expect(result.html).toContain('https://portal.example.test/stop');
    expect(result.text).toContain('Fee < $3');
    expect(result.text).toContain('Stop automatic payments: https://portal.example.test/stop');
    expect(result.frozen).toEqual(ctx.frozen);
    expect(result.frozen).not.toBe(ctx.frozen);
    expect(renderedArgs).toHaveBeenCalledWith(expect.objectContaining({ bodyAfterCta: expect.stringContaining('Stop automatic payments') }));
    await expect(renderBillingNotice(fakeKind, { ...ctx, mandatory: { stopUrl: 'javascript:alert(1)' } })).rejects.toThrow('Unsafe billing URL');
    expect(() => registerBillingNoticeRenderer(fakeKind, async () => ({ email: { id: 'invoice_send', vars: {} }, text: '' }))).toThrow('already registered');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/renderBillingNotice.test.ts`; missing renderer module.
- [ ] **Step 3: Implement** — create `renderBillingNotice.ts`:

```ts
import type { BillingNoticeKind } from '@breeze/shared';
import { escapeHtml } from '../emailLayout';
import { renderPartnerEmail, type RenderPartnerEmailArgs } from '../emailTemplates/renderPartnerEmail';
import type { RenderedNotice } from './noticeOutbox';
export interface BillingNoticeContext {
  partnerId: string;
  orgId: string;
  data: Record<string, unknown>;
  frozen: Record<string, string | number | null>;
  mandatory: { skipUrl?: string; stopUrl?: string; feeDisclosure?: string; achAuthorizationReference?: string };
}
export type BillingNoticeRenderer = (ctx: BillingNoticeContext) => Promise<{
  email: Omit<RenderPartnerEmailArgs, 'bodyBeforeCta' | 'bodyAfterCta'>;
  text: string;
}>;
const renderers = new Map<BillingNoticeKind, BillingNoticeRenderer>();
export function registerBillingNoticeRenderer(kind: BillingNoticeKind, renderer: BillingNoticeRenderer): void {
  if (renderers.has(kind)) throw new Error(`Billing renderer already registered: ${kind}`);
  renderers.set(kind, renderer);
}
function checkedUrl(value: string): string {
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Unsafe billing URL');
  return value;
}
export async function renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext): Promise<RenderedNotice> {
  const renderer = renderers.get(kind);
  if (!renderer) throw new Error(`No billing renderer: ${kind}`);
  const rendered = await renderer(ctx);
  const html: string[] = [];
  const text: string[] = [];
  for (const value of [ctx.mandatory.feeDisclosure, ctx.mandatory.achAuthorizationReference]) {
    if (value) { html.push(`<p>${escapeHtml(value)}</p>`); text.push(value); }
  }
  for (const [label, raw] of [
    ['Skip this invoice', ctx.mandatory.skipUrl],
    ['Stop automatic payments', ctx.mandatory.stopUrl],
  ]) {
    if (!raw) continue;
    const url = checkedUrl(raw);
    html.push(`<p><a href="${escapeHtml(url)}">${escapeHtml(label!)}</a></p>`);
    text.push(`${label}: ${url}`);
  }
  const email = renderPartnerEmail({ ...rendered.email, bodyBeforeCta: undefined, bodyAfterCta: html.join('') });
  return { ...email, text: [rendered.text, ...text].filter(Boolean).join('\n\n'), frozen: { ...ctx.frozen } };
}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/renderBillingNotice.test.ts src/services/emailTemplates/renderPartnerEmail.test.ts`.
- [ ] **Step 5: Commit** — from repository root:

```bash
git add apps/api/src/services/autopay/renderBillingNotice.ts apps/api/src/services/autopay/renderBillingNotice.test.ts
git commit -m "feat(billing): add notice renderer registry and mandatory disclosures"
```


### Task 14: Durable billing outbox, fenced dispatch, and handler recovery
**Files:** Create `apps/api/src/services/autopay/noticeOutbox.ts`; Test `apps/api/src/services/autopay/noticeOutbox.integration.test.ts`; Modify `apps/api/src/services/emailDomains/mailPurposes.ts`, `apps/api/src/services/emailDomains/mailPurposes.test.ts`, `apps/api/vitest.integration.config.ts`, `apps/api/vitest.config.ts`.
**Interfaces:** Consumes `Tx`, `billingNoticeOutbox`, `organizations`, `partners`, `getEmailService(): EmailService | null`, `withSystemDbAccessContext`, `assertOutsideHeldDbContext`, `runOutsideDbContext`. Produces the exact C4 `RenderedNotice`, `enqueueBillingNotice`, `NoticeSentHandler`, `registerNoticeSentHandler`, and `dispatchPendingBillingNotices` signatures shown below.

Existing evidence: `EmailService.sendEmail` in `services/email.ts` uses `MAIL_PURPOSES` in `services/emailDomains/mailPurposes.ts` to choose the partner billing lane. It returns void; `providerMessageId` stays null. `setup` in `src/__tests__/integration/setup.ts` provides real Postgres and migrations. This test must be co-located and explicitly included in the integration configuration and excluded from the unit configuration.

- [ ] **Step 1: Write the failing test** — create `noticeOutbox.integration.test.ts`:

```ts
import '../../__tests__/integration/setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { billingNoticeOutbox, organizations, partners } from '../../db/schema';
const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: send }) }));
import { enqueueBillingNotice, dispatchPendingBillingNotices, registerNoticeSentHandler } from './noticeOutbox';
const ids: string[] = [];
async function fixture(kind: 'autopay_request' | 'invoice_autopay' = 'autopay_request') {
  return withSystemDbAccessContext(async () => {
    const suffix = crypto.randomUUID();
    const [p] = await db.insert(partners).values({ name: 'Outbox fixture', slug: `outbox-${suffix}`, type: 'msp', plan: 'pro', status: 'active', billingEmail: 'billing@example.test' }).returning();
    const [o] = await db.insert(organizations).values({ name: 'Outbox org', slug: `org-${suffix}`, partnerId: p!.id }).returning();
    const input = { partnerId: p!.id, orgId: o!.id, kind, seq: 1, dedupeKey: `test:${suffix}`, toEmail: 'client@example.test',
      rendered: { subject: 'Frozen', html: '<p>100.00</p>', text: '100.00', frozen: { amount: '100.00' } } };
    const result = await enqueueBillingNotice(db, input);
    ids.push(result.id);
    return { ...result, input };
  });
}
afterEach(async () => {
  if (ids.length) await withSystemDbAccessContext(() => db.delete(billingNoticeOutbox).where(inArray(billingNoticeOutbox.id, ids.splice(0))));
  send.mockReset().mockResolvedValue(undefined);
});
describe('billing outbox on real PostgreSQL', () => {
  it('dedupes enqueue without changing the frozen original', async () => {
    const f = await fixture();
    const result = await withSystemDbAccessContext(() => enqueueBillingNotice(db, {
      ...f.input, rendered: { ...f.input.rendered, text: 'changed' },
    }));
    expect(result).toEqual({ id: f.id, created: false });
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, f.id)));
    expect(row!.rendered).toMatchObject({ text: '100.00' });
  });
  it('two dispatchers send the same due row once', async () => {
    await fixture();
    const results = await Promise.all([dispatchPendingBillingNotices(), dispatchPendingBillingNotices()]);
    expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'billing.notice', replyTo: 'billing@example.test' }));
  });
  it('retries an expired sending lease and exhausts the eighth failed send', async () => {
    const f = await fixture();
    await withSystemDbAccessContext(() => db.update(billingNoticeOutbox).set({ status: 'sending', attempts: 7, nextAttemptAt: new Date(0) }).where(eq(billingNoticeOutbox.id, f.id)));
    send.mockRejectedValueOnce(new Error('synthetic transport failure'));
    expect(await dispatchPendingBillingNotices()).toEqual({ sent: 0, failed: 1 });
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, f.id)));
    expect(row).toMatchObject({ status: 'failed', attempts: 8, sentAt: null });
    await dispatchPendingBillingNotices(new Date(Date.now() + 86400000));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('backs off ordinary failure and never sends cancelled rows', async () => {
    const f = await fixture();
    const now = new Date();
    send.mockRejectedValueOnce(new Error('temporary'));
    expect(await dispatchPendingBillingNotices(now)).toEqual({ sent: 0, failed: 1 });
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, f.id)));
    expect(row).toMatchObject({ status: 'pending', attempts: 1, sentAt: null });
    expect(row!.nextAttemptAt!.getTime()).toBe(now.getTime() + 60000);
    await withSystemDbAccessContext(() => db.update(billingNoticeOutbox).set({ status: 'cancelled' }).where(eq(billingNoticeOutbox.id, f.id)));
    await dispatchPendingBillingNotices(new Date(now.getTime() + 60001));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('handler failure after durable send acknowledgement retries without re-sending', async () => {
    const f = await fixture('invoice_autopay');
    let calls = 0;
    registerNoticeSentHandler('invoice_autopay', async () => {
      if (++calls === 1) throw new Error('handler unavailable');
    });
    const now = new Date();
    expect(await dispatchPendingBillingNotices(now)).toEqual({ sent: 0, failed: 1 });
    const [ack] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, f.id)));
    expect(ack!.sentAt).not.toBeNull();
    expect(ack!.status).toBe('pending');
    expect(await dispatchPendingBillingNotices(new Date(now.getTime() + 60001))).toEqual({ sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });
  it('rejects enqueue when the caller supplies another partner', async () => {
    const f = await fixture();
    await expect(withSystemDbAccessContext(() => enqueueBillingNotice(db, {
      ...f.input, partnerId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(),
    }))).rejects.toThrow('Billing notice ownership mismatch');
  });
});
```

Also add this expected object entry to the exact-object assertion in `mailPurposes.test.ts`, **before** changing production code:

```ts
'billing.notice': { lane: 'partner', stream: 'billing', fallbackFrom: 'default' },
```

The default fallback avoids changing the existing exact list of branded quote/invoice document purposes; the partner lane still selects the partner billing identity. Add the literal `'src/services/autopay/**/*.integration.test.ts'` to `test.include` in `vitest.integration.config.ts` and `test.exclude` in `vitest.config.ts` if Task 8 has not already done so. These are test-discovery changes, made with the failing tests.

- [ ] **Step 2: Run it, expect FAIL** — from repository root:

```bash
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/noticeOutbox.integration.test.ts)
```

Expected missing `noticeOutbox` module; the mail-purpose unit contract also fails until the classification is added.

- [ ] **Step 3: Implement** — create `noticeOutbox.ts`:

```ts
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { BillingNoticeKind } from '@breeze/shared';
import { db, assertOutsideHeldDbContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { billingNoticeOutbox, organizations, partners } from '../../db/schema';
import { getEmailService } from '../email';
import type { Tx } from './types';
export interface RenderedNotice {
  subject: string; html: string; text: string;
  frozen: Record<string, string | number | null>;
}
export async function enqueueBillingNotice(tx: Tx, input: {
  orgId: string; partnerId: string; invoiceId?: string; enrollmentId?: string;
  kind: BillingNoticeKind; seq: number; dedupeKey: string; toEmail: string; rendered: RenderedNotice;
}): Promise<{ id: string; created: boolean }> {
  const [org] = await tx.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, input.orgId)).limit(1);
  if (!org || org.partnerId !== input.partnerId) throw new Error('Billing notice ownership mismatch');
  const [created] = await tx.insert(billingNoticeOutbox).values({
    orgId: input.orgId, invoiceId: input.invoiceId ?? null, enrollmentId: input.enrollmentId ?? null,
    kind: input.kind, seq: input.seq, dedupeKey: input.dedupeKey, toEmail: input.toEmail,
    rendered: structuredClone(input.rendered), status: 'pending', attempts: 0, nextAttemptAt: new Date(),
  }).onConflictDoNothing({ target: billingNoticeOutbox.dedupeKey }).returning({ id: billingNoticeOutbox.id });
  if (created) return { id: created.id, created: true };
  const [existing] = await tx.select({ id: billingNoticeOutbox.id }).from(billingNoticeOutbox).where(and(
    eq(billingNoticeOutbox.dedupeKey, input.dedupeKey), eq(billingNoticeOutbox.orgId, input.orgId),
  )).limit(1);
  if (!existing) throw new Error('Billing notice dedupe ownership mismatch');
  return { id: existing.id, created: false };
}
export type NoticeSentHandler = (tx: Tx, row: typeof billingNoticeOutbox.$inferSelect) => Promise<void>;
const handlers = new Map<BillingNoticeKind, NoticeSentHandler>();
export function registerNoticeSentHandler(kind: BillingNoticeKind, handler: NoticeSentHandler): void {
  if (handlers.has(kind)) throw new Error(`Billing sent handler already registered: ${kind}`);
  handlers.set(kind, handler);
}
type Row = typeof billingNoticeOutbox.$inferSelect;
const scope = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const owns = (row: Row) => and(eq(billingNoticeOutbox.id, row.id),
  eq(billingNoticeOutbox.status, 'sending'), eq(billingNoticeOutbox.attempts, row.attempts));

export async function dispatchPendingBillingNotices(now = new Date()): Promise<{ sent: number; failed: number }> {
  assertOutsideHeldDbContext('dispatchPendingBillingNotices');
  return runOutsideDbContext(async () => {
    const claimed = await scope(() => db.transaction(async tx => {
      const due = await tx.select().from(billingNoticeOutbox).where(and(
        inArray(billingNoticeOutbox.status, ['pending', 'sending']),
        or(isNull(billingNoticeOutbox.nextAttemptAt), lte(billingNoticeOutbox.nextAttemptAt, now)),
      )).orderBy(asc(billingNoticeOutbox.nextAttemptAt), asc(billingNoticeOutbox.id)).limit(50).for('update', { skipLocked: true });
      const rows: Row[] = [];
      for (const row of due) {
        if (!row.sentAt && row.attempts >= 8) {
          await tx.update(billingNoticeOutbox).set({ status: 'failed', lastError: 'Send attempts exhausted' }).where(eq(billingNoticeOutbox.id, row.id));
          continue;
        }
        const [claim] = await tx.update(billingNoticeOutbox).set({ status: 'sending', attempts: row.attempts + 1,
          nextAttemptAt: new Date(now.getTime() + 15 * 60000) }).where(eq(billingNoticeOutbox.id, row.id)).returning();
        rows.push(claim!);
      }
      return rows;
    }));
    const counts = { sent: 0, failed: 0 };
    for (let row of claimed) {
      try {
        if (!row.sentAt) {
          const [sender] = await scope(() => db.select({ id: partners.id, name: partners.name, billingEmail: partners.billingEmail })
            .from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, row.orgId)).limit(1));
          if (!sender) throw new Error('Billing notice organization missing');
          const email = getEmailService();
          if (!email) throw new Error('Email transport is not configured');
          const rendered = row.rendered as RenderedNotice;
          // No transaction/context remains held while the provider is contacted.
          await email.sendEmail({ purpose: 'billing.notice', partnerId: sender.id, partnerName: sender.name,
            replyTo: sender.billingEmail ?? undefined, to: row.toEmail,
            subject: rendered.subject, html: rendered.html, text: rendered.text });
          const [ack] = await scope(() => db.update(billingNoticeOutbox).set({ sentAt: new Date(), providerMessageId: null })
            .where(owns(row)).returning());
          if (!ack) continue; // cancelled or fenced: never resurrect authority
          row = ack;
        }
        const completed = await scope(() => db.transaction(async tx => {
          const [current] = await tx.select().from(billingNoticeOutbox).where(owns(row)).for('update');
          if (!current?.sentAt) return false;
          const handler = handlers.get(current.kind);
          if (handler) await handler(tx as Tx, current);
          await tx.update(billingNoticeOutbox).set({ status: 'sent', lastError: null, nextAttemptAt: now }).where(owns(row));
          return true;
        }));
        if (completed) counts.sent++;
      } catch (error) {
        const delay = Math.min(60 * 2 ** Math.min(row.attempts - 1, 6), 3600) * 1000;
        await scope(() => db.update(billingNoticeOutbox).set({
          status: !row.sentAt && row.attempts >= 8 ? 'failed' : 'pending',
          nextAttemptAt: new Date(now.getTime() + delay),
          lastError: error instanceof Error ? error.name : 'BillingNoticeError',
        }).where(owns(row)));
        // Do not persist raw transport exceptions: they may contain bearer URLs.
        counts.failed++;
      }
    }
    return counts;
  });
}
```

Add the production mail-purpose entry inside `MAIL_PURPOSES`:

```ts
'billing.notice': { lane: 'partner', stream: 'billing', fallbackFrom: 'default' },
```

A failed acknowledgement commit after provider acceptance is the explicit delivery ambiguity described at the top. Do not mark a notice sent before contacting the provider, and do not execute a sent handler before a durable acknowledgement. Handlers execute in a transaction and must limit themselves to DB state changes/outboxes. W4's handler must be registered in every dispatcher process before the job starts.

- [ ] **Step 4: Run it, expect PASS** — with the test stack running:

```bash
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/noticeOutbox.integration.test.ts)
(cd apps/api && npx vitest run src/services/emailDomains/mailPurposes.test.ts src/services/emailDomains/mailPurposes.callSites.test.ts src/services/autopay/renderBillingNotice.test.ts)
```

Each command starts at repository root. Confirm the real integration file reports executed tests, not skips.

- [ ] **Step 5: Commit** — from repository root:

```bash
git add apps/api/src/services/autopay/noticeOutbox.ts apps/api/src/services/autopay/noticeOutbox.integration.test.ts apps/api/src/services/emailDomains/mailPurposes.ts apps/api/src/services/emailDomains/mailPurposes.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts
git commit -m "feat(billing): dispatch durable notices with retry and send acknowledgement"
```

### Task 15: Register the autopay worker and its one-minute notice job
**Files:** Create `apps/api/src/jobs/autopayWorker.ts`; Test `apps/api/src/jobs/autopayWorker.test.ts`, existing `apps/api/src/jobs/workerReadinessCoverage.test.ts`; Modify `apps/api/src/jobs/scheduleRegistry.ts`, `apps/api/src/jobs/workerReadinessManifest.ts`, `apps/api/src/services/workerRegistry.ts`, `apps/api/src/services/workerRegistry.test.ts`, `apps/api/src/services/workerEntrypointClosure.contract.test.ts`.
**Interfaces:** Consumes `dispatchPendingBillingNotices(now?: Date): Promise<{ sent: number; failed: number }>`, Task 4's private detach-drain service, `jobSchedule`, `getBullMQConnection`, and `attachWorkerObservability`. Produces `initializeAutopayWorkers(): Promise<void>`, `shutdownAutopayWorkers(): Promise<void>`, `processNoticeDispatch(): Promise<{ sent: number; failed: number }>`. C5 queue = `autopay-jobs`; job = `notice-dispatch`; schedule key = `billing-notice-dispatch`; cron = `* * * * *`. Produces one `WORKER_READINESS_MANIFEST` entry with `initializer: 'autopayWorker'`, `consumers: ['autopayWorker']`, and `requiredWhen: 'redis'`, consumed as a W1 prerequisite by W3 Task 5.

Existing evidence: `consumers` in `jobs/workerReadinessManifest.ts` defaults to the initializer's name and `requiredWhen: 'redis'`; `workerReadinessCoverage.test.ts` requires an exact match between manifest consumer names and production observability attachments. `initializeInvoiceWorkers` in `jobs/invoiceWorker.ts`; `WORKER_REGISTRY` in `services/workerRegistry.ts`; `bootWorker` calls `startRegisteredWorkers('worker', ...)` in `src/worker.ts`. `scheduleRegistry.contract.test.ts` deliberately excludes sub-hourly cron patterns from coarse collision checks, so the one-minute binding contract needs no exemption or altered cron.

- [ ] **Step 1: Write the failing test** — create `autopayWorker.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue({}), close: vi.fn().mockResolvedValue(undefined),
  work: vi.fn(), dispatch: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
  drain: vi.fn().mockResolvedValue(undefined), observe: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class { add = mocks.add; close = mocks.close; },
  Worker: class { constructor(name: string, processor: unknown) { mocks.work(name, processor); } on() { return this; } close = mocks.close; },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/autopay/noticeOutbox', () => ({ dispatchPendingBillingNotices: mocks.dispatch }));
vi.mock('../services/autopay/merge', () => ({ drainAutopayMethodDetaches: mocks.drain }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: mocks.observe }));
import { initializeAutopayWorkers, shutdownAutopayWorkers, processNoticeDispatch } from './autopayWorker';
import { jobSchedule } from './scheduleRegistry';
import { WORKER_REGISTRY, selectWorkers } from '../services/workerRegistry';
import { WORKER_READINESS_MANIFEST } from './workerReadinessManifest';
beforeEach(() => vi.clearAllMocks());
describe('autopay worker registration', () => {
  it('registers precisely the C5 cadence and closes both resources', async () => {
    expect(jobSchedule('billing-notice-dispatch')).toBe('* * * * *');
    await initializeAutopayWorkers();
    expect(mocks.work).toHaveBeenCalledWith('autopay-jobs', expect.any(Function));
    expect(mocks.observe).toHaveBeenCalledOnce();
    expect(mocks.observe).toHaveBeenCalledWith(expect.anything(), 'autopayWorker');
    expect(mocks.add).toHaveBeenCalledWith('notice-dispatch', { type: 'notice-dispatch' }, expect.objectContaining({
      jobId: 'billing-notice-dispatch', repeat: { pattern: '* * * * *', tz: 'UTC' },
    }));
    expect(await processNoticeDispatch()).toEqual({ sent: 1, failed: 0 });
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.drain).toHaveBeenCalledOnce();
    await shutdownAutopayWorkers();
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
  it('is selected by the real worker registry and actual entrypoint uses that registry', () => {
    const entry = WORKER_REGISTRY.find(e => e.name === 'autopayWorker');
    expect(entry?.placement).toBe('global');
    expect(selectWorkers('worker')).toContain(entry);
    const entrypoint = readFileSync(new URL('../worker.ts', import.meta.url), 'utf8');
    expect(entrypoint).toContain("await import('./services/workerRegistry')");
    expect(entrypoint).toContain("startRegisteredWorkers('worker'");
  });
  it('declares exactly one Redis-required consumer for later waves', () => {
    expect(WORKER_READINESS_MANIFEST.filter(entry => entry.initializer === 'autopayWorker')).toEqual([{
      kind: 'consumers', initializer: 'autopayWorker',
      consumers: ['autopayWorker'], requiredWhen: 'redis',
    }]);
  });
  it('propagates dispatcher failure so BullMQ records it', async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error('database down'));
    await expect(processNoticeDispatch()).rejects.toThrow('database down');
  });
});
```

Add `'autopayWorker'` immediately after `'invoiceWorker'` in `EXPECTED_WORKER_NAMES` in `workerRegistry.test.ts` and `EXPECTED_NAMES` in `workerEntrypointClosure.contract.test.ts`, before the production registry edit. Both exact-name contracts must go red when the worker is absent.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/jobs/autopayWorker.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessCoverage.test.ts`; missing worker and registry name mismatch. After adding the worker but before the manifest row, the new manifest assertion and existing readiness coverage contract must fail for the undeclared autopay consumer.
- [ ] **Step 3: Implement** — create `autopayWorker.ts`:

```ts
import { Queue, Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { dispatchPendingBillingNotices } from '../services/autopay/noticeOutbox';
import { drainAutopayMethodDetaches } from '../services/autopay/merge';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';
type AutopayJobData = { type: 'notice-dispatch' };
let queue: Queue<AutopayJobData> | null = null;
let worker: Worker<AutopayJobData> | null = null;
export async function processNoticeDispatch(): Promise<{ sent: number; failed: number }> {
  const result = await dispatchPendingBillingNotices();
  // Removed method rows form the durable detach queue; retry post-commit failures.
  await drainAutopayMethodDetaches();
  return result;
}
export async function initializeAutopayWorkers(): Promise<void> {
  if (worker) return;
  queue = new Queue<AutopayJobData>('autopay-jobs', { connection: getBullMQConnection() });
  worker = new Worker<AutopayJobData>('autopay-jobs', async (job: Job<AutopayJobData>) => {
    if (job.data.type !== 'notice-dispatch') throw new Error(`Unknown autopay job: ${job.name}`);
    return processNoticeDispatch();
  }, { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, 'autopayWorker');
  worker.on('error', error => console.error('[autopayWorker]', error));
  await queue.add('notice-dispatch', { type: 'notice-dispatch' }, {
    jobId: 'billing-notice-dispatch',
    repeat: { pattern: jobSchedule('billing-notice-dispatch'), tz: 'UTC' },
    removeOnComplete: { count: 10 }, removeOnFail: { count: 50 },
  });
}
export async function shutdownAutopayWorkers(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
```

Inside `JOB_SCHEDULES` in `scheduleRegistry.ts`, add:

```ts
// Fine-grained billing outbox tick; intentionally outside the coarse collision grid.
'billing-notice-dispatch': '* * * * *',
```

Inside `WORKER_REGISTRY` in `workerRegistry.ts`, immediately after the invoice worker entry, add:

```ts
{
  name: 'autopayWorker',
  placement: 'global',
  load: async () => {
    const m = await import('../jobs/autopayWorker');
    return { init: m.initializeAutopayWorkers, shutdown: m.shutdownAutopayWorkers };
  },
},
```

Inside `WORKER_READINESS_MANIFEST` in `jobs/workerReadinessManifest.ts`, immediately after `consumers('invoiceWorker'),`, add exactly once:

```ts
consumers('autopayWorker'),
```

This uses the existing helper's default consumer name and `requiredWhen: 'redis'`, matching `attachWorkerObservability(worker, 'autopayWorker')`. Worker construction is unconditional when initialized, so readiness must not be gated by a partner's autopay rollout flag. W3 Task 5 verifies this W1-owned row without adding another one. Keep the existing readiness coverage test unchanged and run it against the new production attachment and manifest entry.

The entrypoint registration is the existing registry call, exercised by the test above. Do not directly import this worker into `src/worker.ts` or start it twice. Future waves add handlers to this one worker and the fixed C5 schedules; W1 adds only notice dispatch.

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/jobs/autopayWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessCoverage.test.ts`.
- [ ] **Step 5: Commit** — from repository root:

```bash
git add apps/api/src/jobs/workerReadinessManifest.ts apps/api/src/jobs/autopayWorker.ts apps/api/src/jobs/autopayWorker.test.ts apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts apps/api/src/services/workerEntrypointClosure.contract.test.ts
git commit -m "feat(billing): register autopay notice dispatcher lifecycle"
```

### Task 16: Pure processing-fee policy and exact rounding
**Files:** Create `apps/api/src/services/autopay/processingFee.ts`; Test `apps/api/src/services/autopay/processingFee.test.ts`.
**Interfaces:** Produces exactly C4 `FeeQuoteInput`, `FeeQuote`, `quoteProcessingFee(input: FeeQuoteInput): FeeQuote`, and `SURCHARGE_STATE_RULES: Record<string, { banned: true } | { maxBps: number }>`. Consumes C3 `AutopayPaymentMethodType`, `CardFundingType`, and `toMinorUnits`/`fromMinorUnits` from `services/stripeMoney.ts`.

`toMinorUnits` and `fromMinorUnits` are re-exported by `apps/api/src/services/stripeMoney.ts` from `packages/shared/src/utils/currency.ts`. Input is constrained to nonnegative fixed-point numeric(12,2); integer conversion is safe within this domain. Percentage multiplication and half-up rounding use BigInt. The approved state policy is encoded as a product restriction, not a statement that every otherwise permitted surcharge is legally authorized. Fees remain zero in user workflows until W5 opens settings writes.

- [ ] **Step 1: Write the failing test** — create `processingFee.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { quoteProcessingFee, SURCHARGE_STATE_RULES, type FeeQuoteInput } from './processingFee';
const base: FeeQuoteInput = {
  methodType: 'card', cardFunding: 'credit', principal: '100.00', currency: 'USD',
  stripeAccountCountry: 'US', orgBillingCountry: 'US', orgBillingRegion: 'NY',
  cardFeeBps: 300, achFeeAmount: '0.00', feeAttested: true,
};
describe('fee rule Cartesian product', () => {
  for (const funding of ['credit', 'debit', 'prepaid', 'unknown', null] as const)
  for (const account of ['US', 'CA', 'AU', null])
  for (const country of ['US', 'CA', null])
  for (const state of ['NY', 'CA', 'CT', 'ME', 'MA', 'CO', null])
  for (const attested of [false, true])
  for (const bps of [0, 100, 200, 300, 500]) {
    it(`${funding}/${account}/${country}/${state}/${attested}/${bps}`, () => {
      const quote = quoteProcessingFee({ ...base, cardFunding: funding, stripeAccountCountry: account,
        orgBillingCountry: country, orgBillingRegion: state, feeAttested: attested, cardFeeBps: bps });
      const allowed = bps > 0 && attested && funding === 'credit' && account === 'US'
        && country === 'US' && state !== null && !['CA', 'CT', 'ME', 'MA'].includes(state);
      const expectedBps = allowed ? Math.min(bps, 300, state === 'CO' ? 200 : 300) : 0;
      expect(quote.feeAmount).toBe(`${Math.floor(expectedBps / 100)}.${String(expectedBps % 100).padStart(2, '0')}`);
      expect(quote.appliedBps).toBe(allowed ? expectedBps : null);
      expect(quote.kind).toBe(allowed ? 'card_percent' : 'none');
    });
  }
  it.each([
    ['0.50', 100, '0.01'], ['0.49', 100, '0.00'], ['1.50', 100, '0.02'],
    ['9999999999.99', 300, '300000000.00'],
  ] as const)('rounds %s at %s bps half-up to %s', (principal, cardFeeBps, expected) => {
    expect(quoteProcessingFee({ ...base, principal, cardFeeBps }).feeAmount).toBe(expected);
  });
  it.each([['0.00', '0.00'], ['0.01', '0.01'], ['24.99', '24.99'], ['25.00', '25.00'], ['99.00', '25.00']])(
    'caps ACH flat %s at %s independently of card attestation', (achFeeAmount, expected) => {
      expect(quoteProcessingFee({ ...base, methodType: 'us_bank_account', cardFunding: null,
        feeAttested: false, orgBillingRegion: 'CA', achFeeAmount }).feeAmount).toBe(expected);
    });
  it.each(['JPY', 'EUR', 'AUD'])('does not quote unsupported currency %s', currency => {
    expect(quoteProcessingFee({ ...base, currency }).feeAmount).toBe('0.00');
    expect(quoteProcessingFee({ ...base, currency, methodType: 'us_bank_account', achFeeAmount: '25.00' }).feeAmount).toBe('0.00');
  });
  it.each(['-1.00', 'NaN', '1.005', '10000000000.00', '1e2'])('rejects malformed/out-of-domain principal %s', principal => {
    expect(() => quoteProcessingFee({ ...base, principal })).toThrow('money');
  });
  it('pins reasons, normalization, and the approved state table', () => {
    expect(SURCHARGE_STATE_RULES).toEqual({ CA: { banned: true }, CT: { banned: true }, ME: { banned: true }, MA: { banned: true }, CO: { maxBps: 200 } });
    expect(quoteProcessingFee({ ...base, cardFeeBps: 0 }).reason).toBe('disabled');
    expect(quoteProcessingFee({ ...base, feeAttested: false }).reason).toBe('not_attested');
    expect(quoteProcessingFee({ ...base, cardFunding: 'debit' }).reason).toBe('debit_or_prepaid');
    expect(quoteProcessingFee({ ...base, cardFunding: null }).reason).toBe('unknown_funding');
    expect(quoteProcessingFee({ ...base, orgBillingRegion: 'ZZ' }).reason).toBe('non_us');
    expect(quoteProcessingFee({ ...base, orgBillingRegion: 'MA' }).reason).toBe('state_banned');
    expect(quoteProcessingFee({ ...base, orgBillingRegion: 'CO' }).reason).toBe('state_capped');
    expect(quoteProcessingFee({ ...base, orgBillingRegion: ' ny ', currency: 'usd', stripeAccountCountry: 'us' }).reason).toBe('applied');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/processingFee.test.ts`; missing fee module.
- [ ] **Step 3: Implement** — create `processingFee.ts`:

```ts
import type { AutopayPaymentMethodType, CardFundingType } from '@breeze/shared';
import { toMinorUnits, fromMinorUnits } from '../stripeMoney';
export interface FeeQuoteInput {
  methodType: AutopayPaymentMethodType; cardFunding: CardFundingType | null;
  principal: string; currency: string; stripeAccountCountry: string | null;
  orgBillingCountry: string | null; orgBillingRegion: string | null;
  cardFeeBps: number; achFeeAmount: string; feeAttested: boolean;
}
export interface FeeQuote {
  feeAmount: string; kind: 'none' | 'card_percent' | 'ach_flat'; appliedBps: number | null;
  reason: 'disabled' | 'not_attested' | 'debit_or_prepaid' | 'unknown_funding' | 'non_us' | 'state_banned' | 'state_capped' | 'applied';
}
// Approved conservative product policy, 2026-10-01, autopay design §10.2.
// Changes require updated table tests and review before fee settings are opened.
export const SURCHARGE_STATE_RULES: Record<string, { banned: true } | { maxBps: number }> = {
  CA: { banned: true }, CT: { banned: true }, ME: { banned: true }, MA: { banned: true }, CO: { maxBps: 200 },
};
const US_REGIONS = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const upper = (v: string | null) => v?.trim().toUpperCase() ?? '';
function minor(value: string): bigint {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid money value');
  const cents = toMinorUnits(value, 'USD');
  if (!Number.isSafeInteger(cents) || cents > 999999999999) throw new Error('Invalid money range');
  return BigInt(cents);
}
export function quoteProcessingFee(input: FeeQuoteInput): FeeQuote {
  const principal = minor(input.principal);
  const flat = minor(input.achFeeAmount);
  if (!Number.isSafeInteger(input.cardFeeBps) || input.cardFeeBps < 0) throw new Error('Invalid fee bps');
  const none = (reason: FeeQuote['reason']): FeeQuote => ({ feeAmount: '0.00', kind: 'none', appliedBps: null, reason });
  if (principal === 0n) return none('disabled');
  const country = upper(input.stripeAccountCountry);
  const currency = upper(input.currency);
  if (input.methodType === 'us_bank_account') {
    if (flat === 0n) return none('disabled');
    if (country !== 'US' || currency !== 'USD') return none('non_us');
    const capped = flat > 2500n ? 2500n : flat;
    return { feeAmount: fromMinorUnits(Number(capped), 'USD'), kind: 'ach_flat', appliedBps: null, reason: 'applied' };
  }
  if (input.cardFeeBps === 0) return none('disabled');
  if (!input.feeAttested) return none('not_attested');
  if (input.cardFunding === 'debit' || input.cardFunding === 'prepaid') return none('debit_or_prepaid');
  if (input.cardFunding !== 'credit') return none('unknown_funding');
  const state = upper(input.orgBillingRegion);
  if (country !== 'US' || currency !== 'USD' || upper(input.orgBillingCountry) !== 'US' || !US_REGIONS.has(state)) return none('non_us');
  const rule = SURCHARGE_STATE_RULES[state];
  if (rule && 'banned' in rule) return none('state_banned');
  const stateCap = rule && 'maxBps' in rule ? rule.maxBps : 300;
  const bps = Math.min(input.cardFeeBps, 300, stateCap);
  const fee = (principal * BigInt(bps) + 5000n) / 10000n;
  return { feeAmount: fromMinorUnits(Number(fee), 'USD'), kind: 'card_percent', appliedBps: bps,
    reason: stateCap < Math.min(input.cardFeeBps, 300) ? 'state_capped' : 'applied' };
}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/processingFee.test.ts`; all Cartesian combinations, cap boundaries, and half-cent ties pass. No Stripe network call occurs in this pure module.
- [ ] **Step 5: Commit** — from repository root:

```bash
git add apps/api/src/services/autopay/processingFee.ts apps/api/src/services/autopay/processingFee.test.ts
git commit -m "feat(billing): quote autopay fees with conservative jurisdiction limits"
```

### Task 17: Verification and release evidence for both PRs
**Files:** Create `apps/api/src/services/autopay/foundation.contract.test.ts`; Test all files listed below. No additional production module is created by this task.
**Interfaces:** Consumes the finished W1 C1–C7 surface. Produces a reproducible verification record for W1a and W1b, including the exact migration filenames, C4 compile-time signatures, app mounts, worker closure and readiness coverage, and real tenancy/concurrency results.

- [ ] **Step 1: Write the failing test** — add `foundation.contract.test.ts` before final acceptance:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type Stripe from 'stripe';
import type { MiddlewareHandler } from 'hono';
import type { Tx } from './types';
import type { BillingLinkPurpose } from '@breeze/shared';
import type { billingLinkTokens } from '../../db/schema';

describe('W1 public foundation contract', () => {
  it('preserves the link and gate signatures used by later waves', () => {
    expectTypeOf<typeof import('./linkTokens').mintBillingLinkToken>().toEqualTypeOf<(
      tx: Tx, input: { orgId: string; purpose: BillingLinkPurpose; enrollmentId?: string; invoiceId?: string; generation?: number; ttlDays: number }
    ) => Promise<{ token: string; id: string }>>();
    expectTypeOf<typeof import('./linkTokens').resolveBillingLinkToken>().toEqualTypeOf<(
      db: Tx, token: string, purpose: BillingLinkPurpose
    ) => Promise<typeof billingLinkTokens.$inferSelect | null>>();
    expectTypeOf<typeof import('./autopayGate').requireAutopayEnabled>().toEqualTypeOf<() => MiddlewareHandler>();
    expectTypeOf<typeof import('../stripeSettle').settlePaymentIntent>().toEqualTypeOf<(
      partnerId: string, paymentIntentId: string
    ) => Promise<{ settled: boolean; status: Stripe.PaymentIntent.Status; invoiceId: string | null }>>();
  });
  it('has all six ordered migration slots and no migration-level transaction wrapper', () => {
    const names = [
      '2026-11-20-100000-autopay-enums.sql',
      '2026-11-20-100100-billing-payment-settings.sql',
      '2026-11-20-100200-org-autopay-enrollments-methods-consents.sql',
      '2026-11-20-100300-invoice-autopay-schedules-attempts.sql',
      '2026-11-20-100400-billing-notice-outbox-link-tokens.sql',
      '2026-11-20-100500-autopay-column-additions.sql',
    ];
    for (const name of names) {
      const file = new URL(`../../../migrations/${name}`, import.meta.url);
      expect(existsSync(file)).toBe(true);
      const sql = readFileSync(file, 'utf8');
      expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/m);
      expect(sql).toMatch(/set_config\('breeze.scope',\s*'system',\s*true\)/);
    }
  });
});
```

If C1's sort-last precondition required a later prefix, change all six literals together, retaining the ordered suffixes. This test intentionally pins filenames used by migration replay tests.

- [ ] **Step 2: Run it, expect FAIL** — on the pre-implementation base, `cd apps/api && npx vitest run src/services/autopay/foundation.contract.test.ts` fails for absent migration files; `pnpm --filter @breeze/api exec tsc --noEmit` fails for absent C4 exports. On the completed branch it should already pass: do not delete working code merely to manufacture a final verification failure. Preserve the genuine red runs from the component tasks as TDD evidence.
- [ ] **Step 3: Implement** — the implementation in this task is the acceptance run, not another behavior change. Run these exact commands, each from repository root unless enclosed in a subshell. Do not skip a failing check; repair its owning implementation and rerun the affected check before proceeding.

**At the W1a boundary (Tasks 1–7):**

```bash
pnpm --filter @breeze/shared exec tsc --noEmit
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec astro check
(cd packages/shared && npx vitest run src/types/autopay.test.ts src/types/billing-enums.test.ts src/validators/autopay.test.ts)
(cd apps/api && npx vitest run src/db/schema/autopayColumns.test.ts src/services/accounting/autopayPaymentMethods.test.ts src/services/autopay/merge.test.ts src/services/autopay/billingPaymentSettings.test.ts src/services/autopay/autopayGate.test.ts src/routes/admin/autopayRollout.test.ts src/index.autopayRoutes.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/__tests__/partner-wide-write-coverage.test.ts)
(cd apps/web && npx vitest run src/components/billing/invoiceTypes.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/autopayFoundation.integration.test.ts src/__tests__/integration/autopayMerge.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantCascadeExecution.integration.test.ts src/__tests__/integration/tenantCascadeErasureBreadth.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts)
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
(set -a; . ./.env.test; set +a; pnpm db:check-drift)
pnpm test-stack down
```

The drift command explicitly loads the generated worktree `.env.test` from `renderEnvTest` in `scripts/dev/test-stack/envfile.ts`; its subshell does not change the parent environment. The integration setup applies migrations, the foundation suite replays them and checks columns, and `db:check-drift` verifies the migration ledger. W1a must typecheck without any W1b imports; post-commit method detachment is a W1a private service and the later worker only adds periodic retry.

**At the W1b boundary (all Tasks 1–17):**

```bash
pnpm --filter @breeze/shared exec tsc --noEmit
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec astro check
(cd apps/api && npx vitest run src/services/autopay/linkTokens.test.ts src/services/autopay/renderBillingNotice.test.ts src/services/autopay/processingFee.test.ts src/services/autopay/foundation.contract.test.ts src/services/autopay/reservation.test.ts src/services/autopay/stripeCapabilities.test.ts src/services/stripeSettle.test.ts src/services/stripeCredentialArchive.test.ts src/services/autopay/merge.test.ts src/services/stripeReconcile.test.ts src/services/partnerStripe.test.ts src/services/invoiceCheckout.test.ts src/services/invoiceService.test.ts src/routes/portal/invoices.test.ts src/routes/invoicesPublic.test.ts src/services/invoiceService.test.ts src/services/accounting/accountingPaymentPull.test.ts src/routes/stripeConnect/index.test.ts src/jobs/autopayWorker.test.ts)
(cd apps/api && npx vitest run src/jobs/scheduleRegistry.contract.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessCoverage.test.ts src/services/emailDomains/mailPurposes.test.ts src/services/emailDomains/mailPurposes.callSites.test.ts src/services/encryptedColumnRegistry.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/reservation.integration.test.ts src/services/autopay/noticeOutbox.integration.test.ts src/__tests__/integration/invoiceCheckout.integration.test.ts src/__tests__/integration/accountingPaymentPull.integration.test.ts src/__tests__/integration/stripeSessionRevocation.integration.test.ts src/__tests__/integration/stripeSettle.integration.test.ts src/__tests__/integration/stripeReversalState.integration.test.ts src/__tests__/integration/autopayFoundation.integration.test.ts src/__tests__/integration/autopayMerge.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantCascadeExecution.integration.test.ts src/__tests__/integration/tenantCascadeErasureBreadth.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts)
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
(set -a; . ./.env.test; set +a; pnpm db:check-drift)
(cd apps/api && npx vitest run)
pnpm test-stack down
```

No new screen ships, so a new Playwright UI suite would not exercise W1's new behavior. Existing card Checkout route/service regressions and the Stripe lab below cover the reachable surface. Do not mark enrollment, notice compliance lead times, charging retries, or W5 fee accounting verified by this wave.

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/foundation.contract.test.ts`, followed by the boundary commands above. Acceptance means no failed or silently skipped targeted integration tests, no schema drift, preserved fee-zero/card Checkout behavior, passing real app-mount tests, exactly one Redis-required autopay readiness entry matching its production attachment with passing `workerReadinessCoverage.test.ts`, and closed test-stack resources. Record actual command results in each PR; this plan does not claim those runs have already happened.
- [ ] **Step 5: Commit** — from repository root:

```bash
git add apps/api/src/services/autopay/foundation.contract.test.ts
git commit -m "test(billing): pin autopay foundation contracts"
```

## Stripe test-mode lab checklist

Run against a disposable worktree stack and an MSP test-mode account. Record only synthetic ids; never paste secret/restricted keys into a PR or this plan. W1 does not create real off-session charges automatically. Seeded test PaymentIntents may be used to drive the new settler explicitly.

- [ ] Save a full test key and refresh: the persisted capability check timestamp advances and `autopay_missing_permissions` is empty. A restricted test key missing each of Customers write, SetupIntents write, PaymentIntents write, PaymentMethods write, and Mandates read produces the corresponding exact capability identifier. Probes create no customer, method, setup, or payment object.
- [ ] Complete an ordinary card Checkout session: invoice principal, method `card`, mapping source `checkout`, and fee `0.00` match the previous release. Payment-mode Checkout still accepts only cards.
- [ ] Reserve a synthetic invoice in `processing`: MSP link creation, portal pay, and public pay refuse; manual/import payment may use only the unreserved balance; void refuses; resetting the public link still succeeds.
- [ ] Retrieve a succeeded test PaymentIntent with mapping principal `100.00`, fee `3.00`, Stripe gross `103.00`: settlement books exactly `100.00`. Repeat retrieval and settlement: no second invoice payment appears.
- [ ] Retrieve a succeeded US-bank PaymentIntent: the invoice method is `ach_debit`. A failed mapping for the same PI can settle on late success; a failed Checkout mapping stays subject to its existing terminal rule.
- [ ] Simulate `processing` and `requires_action`: `settlePaymentIntent` returns unsettled and does not invent a payment. Do not claim W4 outcome orchestration or authentication recovery is implemented here.
- [ ] Rotate/disconnect a test credential with an active PI attempt: retention keeps the original account credential beyond ordinary cleanup limits, settlement uses the original account, and no new charge is authorized by retention.
- [ ] Replay a gross partial/full refund and dispute restoration on a bank mapping: principal remains capped to its original amount, fee is never posted to invoice balance, and restoration retains `ach_debit`. Repeat zero-fee card cases to prove unchanged Checkout behavior.
- [ ] Force a notice send failure with a fake renderer/transport on the lab stack: backoff occurs, no schedule can treat enqueue as send, and a successful retry sets `sent_at`. Reset the dispatcher after durable acknowledgement but before handler completion: handler recovery must not send another email.
- [ ] Tear down the disposable stack and report any resources intentionally left running. Keep partner rollout off outside the explicitly selected lab partner.
