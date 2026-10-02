# Autopay W04: Charging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Charge eligible, noticed invoices exactly once through the MSP’s Stripe account, with recoverable attempts, client controls, receipts, and visible failures.
**Architecture:** Schedule and freeze terms in the invoice’s issuing transaction, then use the W1 durable notice outbox to establish charging authority. Reserve under the invoice lock, close the transaction before Stripe calls, persist an unconfirmed PaymentIntent before confirming it, and reconcile every outcome through the existing payment ledger. W4a delivers notices and exclusions; W4b adds collection, recovery, and payment controls.
**Tech Stack:** TypeScript, Hono, PostgreSQL + Drizzle RLS, BullMQ, Stripe SDK, Astro + React, react-i18next, Vitest, Playwright.
**Spec:** docs/superpowers/specs/billing/2026-10-01-autopay-design.md · **Index:** docs/superpowers/plans/billing/2026-10-01-autopay-index.md

## Preconditions

- W1a, W1b, W2a, W2b, and W3 must be merged and verified before implementing W4a. W4b starts after W4a. This checkout has no `apps/api/src/services/autopay/`, no `apps/api/src/db/schema/autopay.ts`, and no `apps/api/src/jobs/autopayWorker.ts`; C2–C4 imports below are **prerequisite interfaces**, not claims that those implementations already exist. Read their landed implementations before applying these additions. Do not recreate W1–W3 in this wave.
- In particular, verify W1’s reservation coverage in manual/import payments, Checkout producers, and void; its `settlePaymentIntent`; late-success support in `recordStripePayment`; archived-key retention; durable notice callback retries; and all eight schema/tenancy registrations. Verify W2’s setup generation fencing, stop/detach behavior, and billing notifications. Verify W3’s fallback reminder suppression and Payments shell.
- W4 adds **no table, column, enum value, or migration**. C1 reserves `2026-11-20-1300NN-` only if a later reviewed schema change becomes necessary. Schema defects discovered here are unmet W1 prerequisites, not permission to silently introduce a second schema. Consequently there are no W4 edits to `CORE_ORG_CASCADE_DELETE_ORDER`, `AUDIT_ADMIN_REQUIRED_TABLES`, merge/export policies, RLS allowlists, or `encryptedColumnRegistry`; verification still runs their contracts.
- Preserve all C1–C9 public contracts. `Tx` below is a local structural alias: `type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]`. `DbExecutor` in `invoiceService.ts` is private, so do not import it as an exported type.
- Implementation commits in task steps are instructions for the future implementer. Authoring this plan does not run them. Branches: `feat/autopay-w04a-charging-notices`, then `feat/autopay-w04b-collection`. Each PR targets main; rebase the second after the first merges.

## Where this plan corrects or refines the spec/index

1. **Email and due-date locations.** `sendInvoiceEmail` and `resendInvoiceEmail` are in `apps/api/src/services/invoicePdf.ts`, not `invoiceService.ts`. The issued-date mutation is `updateIssuedDueDate` in `invoiceService.ts`; `updateInvoice` is draft-only. Wire the actual symbols. `runContractBillingSweep` in `jobs/contractWorker.ts` already calls `issueInvoice`; add only two issuing-transaction hooks, with three producer tests.
2. **There is no `invoices.issuedAt`.** `invoices` in `db/schema/invoices.ts` has `issueDate` (date) and mutable `updatedAt`. Both issuing writers stamp `updatedAt` at issuance. The first schedule captures it as `terms_snapshot.issuedAt`; replans preserve that timestamp. Comparing enrollment to midnight `issueDate` would reject an enrollment made earlier on the same day. Do not add a column or reinterpret a later edit’s `updatedAt` as issuance.
3. **No held transaction across Stripe.** `assertNoHeldDbContextForStripe` in `services/stripeSettle.ts` deliberately rejects escaping a held request transaction with `runOutsideDbContext` because that retains one pooled connection while borrowing another. C4 functions retain their signatures, but money routes own short contexts through `SELF_MANAGED_DB_CONTEXT_ROUTES` in `middleware/selfManagedDbContextRoutes.ts`. Call `runOutsideDbContext` only after those contexts have returned. Cached readiness reads inside scheduling never probe Stripe.
4. **Revocation must fail closed even in observe mode.** `assertInvoiceSessionsRevoked` in `stripeSessionRevocation.ts` obeys a rollout mode. Collection additionally checks unresolved Checkout mappings under the invoice lock. Add `autopay_collection` to its existing `RevocationReason` text union. An abandoned or blocked session is not evidence that Stripe cannot charge it.
5. **Applied money is distinct from provider success.** `recordStripePayment` in `stripeReconcile.ts` returns `{ invoiceId }` on both refusal and application; `settleCheckoutSession` in `stripeSettle.ts` returns `settled:true` for provider-paid. W4 reads the mapping’s `invoicePaymentId` after settlement, and records `unapplied` when capture could not be applied. It never routes this through `payment_failed`. The C9 event is `payment.unapplied`, not the prose-only `billing.payment_unapplied` spelling in §7.4.
6. **Authentication recovery replaces when necessary.** `apps/portal/package.json`, `lib/csp.ts`, and `services/partnerStripe.ts` provide no publishable-key/Stripe.js integration. A PaymentIntent’s `use_stripe_sdk` action is not a hosted URL. The confirm POST first retrieves/reconciles or cancels the old intent, verifies cancellation, then returns the existing public invoice document; its Pay button uses card-only `createInvoicePayLink` for replacement. The helper’s hour-bucketed key is not a cross-hour retry guarantee. This is the spec’s “complete or replace” option; never fabricate a Stripe authentication URL or expose a client secret. ACH returns to the W2 update-method flow.
7. **Unbounded replay is not a safety guarantee.** A lost create response can be retried with its original idempotency key only inside the provider’s retention window. After 23 hours, a reserved attempt with no recorded PI is quarantined with `state_reason='provider_create_unknown'`, retains its reservation, and raises `autopay.needs_attention`; it is never blindly recreated. Operators locate the attempt metadata in Stripe and reconcile or cancel it. This protects the “never a second PI” invariant through long outages.
8. **Notices report delivery truth.** Today `sendInvoiceEmail` stamps `sentAt` even when delivery returns `emailed:false`. Eligible autopay invoices instead stamp it only in the successful notice callback. Add the result reason `notice_queued`; the send UI reports queued rather than claiming delivery. A manual Send does not change the frozen recipient, fee, or date; an actual resend remains the existing copy operation.
9. **Staff mail is a separate path.** C9’s fixed kinds contain no staff-email kind. `dispatchNotice` in `contractRenewal.ts` calls the staff email service directly. Use W2’s billing notification dispatcher for MSP events and its staff-mail delivery path; do not invent a `billing_notice_kind` or relabel staff alerts as customer receipts. Customer notices always use `billing_notice_outbox`.
10. **W5 owns nonzero fee rollout and allocation.** W1 rejects fee-setting writes until W5. W4 calls `quoteProcessingFee`, records principal and fee separately, and preserves ACH method on reversal; its production fee remains zero. W5 must pass nonzero-fee partial-return tests before enabling fees. Keep C4’s `processingFee.ts`; do not introduce the spec’s competing `surchargeRules.ts` home.
11. **Tests must actually be registered.** `vitest.integration.config.ts` explicitly includes colocated real-DB suites. Add W4’s exact paths; the default unit runner excludes them. `index.ts` boots servers on import; use a production mount function called by `index.ts` and by Hono app tests, not a router-only test labelled “app-level”.

12. **Unconfirmed Stripe creation cannot set `off_session`.** The [Stripe create API](https://docs.stripe.com/api/payment_intents/create) permits that parameter only with `confirm=true`. Create with `confirm:false`, customer, method and metadata, persist the PI/mapping, then pass `off_session:true` to confirm. This preserves the required crash boundary without sending an invalid create request. The [idempotency contract](https://docs.stripe.com/api/idempotent_requests) also permits pruning after 24 hours, motivating the 23-hour quarantine above.

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


- Eligibility is captured once at issue for every org with an enrollment row, including ineligible rows. No enrollment means no schedule. Re-inclusion may re-evaluate exclusions only for an existing schedule; it must not sweep historical invoices into autopay.
- Use `partners.autopayEnabled`, never `autopay_charging_enabled`. Gate new setups/attempts; never gate reconciliation of existing money.
- UTC calendar dates determine collection. Notice lead is exactly 10 days for individual `us_bank_account`, otherwise 1. Unknown ACH holder type is not usable for charging until W2 resolves it; never infer “company”.
- Card soft retries are at day 3 and day 7 from the first attempt, not from the preceding failure. ACH R01/R09 gets one retry after 3 business days; exclude weekends and US Federal Reserve banking holidays. `requires_action` never retries automatically.
- Scheduled idempotency keys are exactly `autopay_<schedule>_<attempt_no>`. Client-initiated unscheduled keys are `autopay_client_<invoice>_<attempt_no>`, with the ordinal allocated under the invoice lock across all invoice attempts.
- Re-notice on method type, holder lead class, or fee terms changing. Never collect more principal or fee than noticed. Changes that reduce a legally permitted fee may lower the actual charge; changed method/fee terms still require a new notice.
- `ACTIVE_COLLECTION_ATTEMPT_STATES` stays exactly `reserved|created|confirming|processing`. Skip/exclude/replace also inspect unresolved `requires_action` and cancel it at Stripe before releasing client authority. Do not add it to C3’s fixed tuple.
- Every remote call is mocked at `getPartnerStripeClient`; no unit test constructs a Stripe client. Real DB locks, RLS, races, and crash replay use the integration runner.
- W4a keeps collection code absent; do not enable partners for live charging until W4b verification and the Stripe lab pass.

## Review Focus

1. A Checkout session is created in the gap between revocation and reservation, including observe mode: locked recheck defers, never creates a PI (Tasks 10 and 20).
2. Stop, rollout-disable, or key rotation happens after reservation but before confirmation: no unconfirmed debit starts; already processing money still settles through the original account (Tasks 9, 11, 13, 20).
3. An obsolete notice callback arrives after re-notice, skip, exclusion, or generation replacement: it cannot revive charging or satisfy a new notice’s lead time (Tasks 3 and 20).
4. A failed PI succeeds after retry/manual payment, or an ACH return arrives after success: provider truth is reconciled once; captured excess becomes unapplied; return reopens the invoice without resurrecting collection (Tasks 12, 13, 20).
5. Setup return is replayed or microdeposit verification finishes days later: one explicit payment authorization produces at most one unscheduled attempt, and a background setup sweep cannot turn it into an unnotified charge (Tasks 16 and 20).

## File map

Paths marked “prerequisite” exist after W1–W3. Test paths labelled new are created by this wave. Each path below has one responsibility; task Files blocks identify the narrower edits.

| File | Responsibility |
|---|---|
| `apps/api/src/services/autopay/scheduler.ts` (new) | C4 date helpers, eligibility snapshot, notice planning |
| `apps/api/src/services/autopay/scheduler.test.ts` (new) | Dates and eligibility matrix |
| `apps/api/src/services/autopay/chargingNotice.ts` (new) | Notice enqueue, fenced sent callback, re-notice |
| `apps/api/src/services/autopay/chargingNotice.test.ts` (new) | Delivery and stale-callback fencing |
| `apps/api/src/services/autopay/renderBillingNotice.ts` (prerequisite) | W4 render branches and append blocks |
| `apps/api/src/services/autopay/renderBillingNotice.test.ts` (prerequisite) | Closed variables and mandatory links |
| `packages/shared/src/utils/emailTemplates.ts` | Three W4 IDs, variables, labels, defaults |
| `packages/shared/src/utils/emailTemplates.test.ts` | Catalog completeness |
| `apps/api/src/services/emailTemplates/defaults.ts` | W4 preheaders and footers |
| `apps/api/src/services/invoiceService.ts` | Atomic issue hook, issued due-date re-notice, read model |
| `apps/api/src/services/invoiceService.test.ts` | Issue and due-date behavior |
| `apps/api/src/services/quoteAcceptService.ts` | Direct-issue hook |
| `apps/api/src/services/quoteAcceptService.test.ts` | One-time versus recurring-only issue |
| `apps/api/src/services/invoicePdf.ts` | Eligible Send redirects to outbox; resend unchanged |
| `apps/api/src/services/invoiceResend.test.ts` | Single-email and truthful result |
| `apps/api/src/jobs/contractWorker.test.ts` | Third issue producer routes through notice |
| `apps/api/src/services/autopay/invoiceControls.ts` (new) | Skip, include/exclude, scoped read model |
| `apps/api/src/services/autopay/invoiceControls.test.ts` (new) | Token, state, and access checks |
| `apps/api/src/routes/autopay/public.ts` (prerequisite) | Skip/confirm GET and POST |
| `apps/api/src/routes/invoices/autopay.ts` (new) | Exclusion and charge-now router |
| `apps/api/src/routes/autopay/mount.ts` (new) | Production registration used by index and app tests |
| `apps/api/src/routes/autopay/mount.test.ts` (new) | HTTP requests through production mounts |
| `apps/api/src/index.ts` | Invoke production W4 mount |
| `apps/api/src/middleware/selfManagedDbContextRoutes.ts` | Close contexts before new Stripe routes |
| `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts` | Exact method/path ownership |
| `packages/shared/src/validators/contracts.ts` | Contract exclusion update validation |
| `apps/api/src/services/contractService.ts` | Persist exclusion whitelist |
| `apps/api/src/routes/contracts/contracts.test.ts` | Existing PATCH exclusion and authorization |
| `apps/web/src/components/contracts/ContractEditor.tsx` | Exclusion form field |
| `apps/web/src/components/contracts/ContractEditor.test.tsx` | Exclusion field is mounted and saved |
| `apps/web/src/components/billing/InvoiceDetail.tsx` | Autopay status/exclusion/charge panel |
| `apps/web/src/components/billing/invoiceTypes.ts` | Autopay read model |
| `apps/web/src/components/billing/InvoiceDetail.autopay.test.tsx` (new) | Page composition and mutation feedback |
| `apps/web/src/components/billing/InvoiceActions.tsx` | Queued-notice result wording |
| `apps/web/src/components/billing/InvoiceActions.test.tsx` | Queue versus sent feedback |
| `apps/web/src/components/billing/AutopayListPage.tsx` (prerequisite) | Last result, unapplied and stuck notices |
| `apps/web/src/components/billing/AutopayListPage.test.tsx` (prerequisite) | List composition |
| `apps/web/src/components/settings/EmailTemplatesTab.tsx` | Billing & payments entries |
| `apps/web/src/locales/en/billing.json` | Web billing strings |
| `apps/api/src/services/autopay/failureClassifier.ts` (new) | C4 decline classification |
| `apps/api/src/services/autopay/failureClassifier.test.ts` (new) | Exhaustive return/decline table |
| `apps/api/src/services/autopay/retryDates.ts` (new) | UTC card and banking-day retry dates |
| `apps/api/src/services/autopay/retryDates.test.ts` (new) | Weekend/holiday boundaries |
| `apps/api/src/services/partnerStripe.ts` | Account-bound archived client and enrollment switch block |
| `apps/api/src/services/partnerStripe.test.ts` | Disconnect, permission loss, same/different account |
| `apps/api/src/services/stripeCredentialArchive.ts` | Keep unresolved PI credentials |
| `apps/api/src/services/stripeCredentialArchive.test.ts` (new) | Unresolved versus erasable archive |
| `apps/api/src/services/stripeSessionRevocation.ts` | Collection revocation reason |
| `apps/api/src/services/autopay/collectionEngine.ts` (new) | C4 collection, replay, outcomes |
| `apps/api/src/services/autopay/collectionEngine.test.ts` (new) | Stripe-boundary tests |
| `apps/api/src/services/autopay/paymentNotices.ts` (new) | Receipt, failure variants, MSP notifications |
| `apps/api/src/services/autopay/paymentNotices.test.ts` (new) | Idempotent outcome mail |
| `apps/api/src/services/stripeSettle.ts` | All-online receipt hook |
| `apps/api/src/__tests__/integration/stripeSettle.integration.test.ts` | Checkout receipt after applied settlement |
| `apps/api/src/services/stripeFinancialEventPoller.ts` | PI event dispatch through durable inbox |
| `apps/api/src/services/stripeFinancialEventPoller.test.ts` | Out-of-order PI outcomes |
| `apps/api/src/services/stripeReversalState.ts` | ACH return notification and method restoration |
| `apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts` | Late ACH return and replay |
| `apps/api/src/jobs/stripeReconcileSweep.ts` | No-age-cutoff attempt recovery |
| `apps/api/src/jobs/stripeReconcileSweep.test.ts` (new) | Old processing and reserved recovery |
| `apps/api/src/jobs/autopayWorker.ts` (prerequisite) | Collection job and notice-handler boot |
| `apps/api/src/jobs/autopayWorker.test.ts` (prerequisite) | Dispatch registration |
| `apps/api/src/jobs/scheduleRegistry.ts` | Hourly collection schedule |
| `apps/api/src/services/autopay/confirmPayment.ts` (new) | Cancel/reconcile before hosted replacement |
| `apps/api/src/services/autopay/confirmPayment.test.ts` (new) | Scanner safety and SCA race |
| `apps/api/src/services/autopay/bankPayment.ts` (new) | Invoice-bound setup and explicit bank charge |
| `apps/api/src/services/autopay/bankPayment.test.ts` (new) | Replay, pending verification, amount consent |
| `apps/api/src/routes/invoicesPublic.ts` | Extend existing pay route with bank setup |
| `apps/api/src/routes/portal/invoices.ts` | Portal bank setup/charge with CSRF |
| `apps/api/src/routes/portal/paymentMethods.ts` (prerequisite) | Return handling without background charge |
| `apps/portal/src/lib/api.ts` | Typed pay/skip/confirm clients |
| `apps/portal/src/components/portal/AutopayActionPage.tsx` (new) | Explicit skip/confirm POST UX |
| `apps/portal/src/components/portal/AutopayActionPage.test.tsx` (new) | GET safety and action feedback |
| `apps/portal/src/pages/autopay/[token]/skip.astro` (new) | Skip page composition |
| `apps/portal/src/pages/autopay/[token]/confirm.astro` (new) | Confirm page composition |
| `apps/portal/src/components/portal/PublicInvoiceView.tsx` | Public bank setup/pay button |
| `apps/portal/src/components/portal/InvoiceDetailView.tsx` | Portal bank setup/pay button |
| `apps/portal/src/components/portal/InvoiceDetailView.test.tsx` | Portal composition |
| `apps/portal/src/components/portal/PublicInvoiceView.autopay.test.tsx` (new) | Public composition |
| `apps/api/src/services/autopay/charging.integration.test.ts` (new) | Real-DB race/recovery/issue/tenant proof |
| `apps/api/vitest.integration.config.ts` | Discover colocated W4 DB tests |
| `e2e-tests/tests/autopay-charging.spec.ts` (new) | Stack smoke using test IDs |
| `apps/api/src/services/autopay/clientPaymentAuthority.ts` | New private request authority for explicit unscheduled payments |
| `apps/api/src/services/autopay/setupSession.ts` | Prerequisite setup metadata and accepted invoice terms |
| `apps/api/src/services/autopay/setupCompletion.ts` | Prerequisite invoice-bound token consumption exception |
| `apps/api/src/services/autopay/enrollmentViews.ts` | Prerequisite authorized latest-charge and attention projection |
| `apps/api/src/services/autopay/customerViews.ts` | Prerequisite skip/confirm purpose admission and lifecycle checks |
| `apps/api/src/services/autopay/staffNotifications.ts` | Prerequisite C9 event union and recipient policy |
| `apps/api/src/services/stripeReconcile.ts` | Preserve unapplied captures without false payment failure |
| `apps/api/src/services/stripeReconcile.test.ts` | Ledger refusal and late-success regressions |
| `apps/api/src/services/invoiceService.issue.integration.test.ts` | Manual issue schedule transaction proof |
| `apps/api/src/__tests__/integration/quoteAccept.integration.test.ts` | Direct quote issue schedule transaction proof |
| `apps/api/src/__tests__/integration/contractWorker.integration.test.ts` | Contract sweep schedule and single notice proof |
| `apps/api/src/jobs/scheduleRegistry.contract.test.ts` | Verify exact collection cron registration |
| `apps/api/src/services/workerEntrypointClosure.contract.test.ts` | Verify shared worker startup closure |
| `apps/api/src/services/workerRegistry.ts` | Read-only verification of prerequisite single worker ownership |
| `apps/api/src/worker.ts` | Read-only verification of prerequisite worker entrypoint |
| `apps/api/vitest.config.ts` | Exclude colocated charging integration suite from unit discovery |
| `apps/portal/src/components/portal/BankAutopayPayment.tsx` | New explicit setup, verification, and invoice-pay module |
| `apps/portal/src/components/portal/BankAutopayPayment.test.tsx` | New consent, return, and pending-verification tests |
| `apps/portal/src/pages/autopay/return.astro` | Prerequisite bank-versus-enrollment return composition |
| `apps/portal/src/pages/autopay/actions.test.ts` | New Skip, Confirm, and bank-return page composition tests |
| `apps/portal/src/layouts/PublicDocumentLayout.astro` | Existing shared portal layout consumed without replacement |
| `apps/portal/src/lib/runAction.ts` | Read-only prerequisite portal response adapter |
| `apps/portal/src/pages/invoice/[token].astro` | Existing public invoice shell composing the changed view |
| `apps/portal/src/pages/invoices/[id].astro` | Existing authenticated invoice shell composing the changed view |
| `apps/web/src/components/billing/InvoiceWorkspace.tsx` | Existing invoice shell renders changed InvoiceDetail |
| `apps/web/src/components/billing/InvoiceWorkspace.test.tsx` | Page-level real-child autopay composition |
| `apps/web/src/components/billing/autopayClient.ts` | Prerequisite last-charge and attention DTO fields |
| `apps/web/src/components/contracts/ContractWorkspace.tsx` | Pass server feature flag into ContractEditor |
| `apps/web/src/lib/api/contracts.ts` | Contract exclusion field and feature projection types |
| `apps/web/src/pages/billing/autopay.astro` | Prerequisite list page composition |
| `apps/web/src/pages/billing/invoices/[id].astro` | Existing invoice page composition |
| `apps/web/src/pages/contracts/[id].astro` | Existing contract page composition |
| `apps/web/src/components/settings/EmailTemplatesTab.test.tsx` | Rendered W4 template entries |
| `apps/web/src/components/settings/EmailTemplateEditor.tsx` | W4 preview sample variables |
| `apps/web/src/lib/i18n/localeParity.test.ts` | Run locale key parity contract |
| `apps/web/src/locales/en/settings.json` | W4 email template labels and preview copy |
| `apps/web/src/locales/de-DE/billing.json` | Autopay action, state, and attention copy with equal locale keys |
| `apps/web/src/locales/de-DE/settings.json` | W4 email template labels and preview copy |
| `apps/web/src/locales/es-419/billing.json` | Autopay action, state, and attention copy with equal locale keys |
| `apps/web/src/locales/es-419/settings.json` | W4 email template labels and preview copy |
| `apps/web/src/locales/fr-CA/billing.json` | Autopay action, state, and attention copy with equal locale keys |
| `apps/web/src/locales/fr-CA/settings.json` | W4 email template labels and preview copy |
| `apps/web/src/locales/fr-FR/billing.json` | Autopay action, state, and attention copy with equal locale keys |
| `apps/web/src/locales/fr-FR/settings.json` | W4 email template labels and preview copy |
| `apps/web/src/locales/it-IT/billing.json` | Autopay action, state, and attention copy with equal locale keys |
| `apps/web/src/locales/it-IT/settings.json` | W4 email template labels and preview copy |
| `apps/web/src/locales/pt-BR/billing.json` | Autopay action, state, and attention copy with equal locale keys |
| `apps/web/src/locales/pt-BR/settings.json` | W4 email template labels and preview copy |
| `apps/web/src/locales/tr-TR/billing.json` | Autopay action, state, and attention copy with equal locale keys |
| `apps/web/src/locales/tr-TR/settings.json` | W4 email template labels and preview copy |

---

W4a = Tasks 1–7. W4b = Tasks 8–21. Task 21 is repeated as the acceptance gate for each PR, restricted to that PR’s existing files. No infrastructure or migrations run during plan authoring.

### Task 1: UTC collection dates and eligibility inputs (W4a)
**Files:** Create `apps/api/src/services/autopay/scheduler.ts`; Test `apps/api/src/services/autopay/scheduler.test.ts`.
**Interfaces:** Consumes C3 `AutopayOffsetRule`, `AutopayPaymentMethodType`, `AccountHolderType`; produces C4 `computeCollectOn(input: { issueDate: string; dueDate: string; offsetDays: number; rule: AutopayOffsetRule; noticeDate: string; leadDays: number }): string` and `noticeLeadDays(method: { type: AutopayPaymentMethodType; accountHolderType: AccountHolderType | null }): 1 | 10`.

- [ ] **Step 1: Write the failing test** — create the colocated test:
```ts
import { describe, expect, it } from 'vitest';
import { computeCollectOn, noticeLeadDays } from './scheduler';

describe('collection date', () => {
  it.each([
    ['earlier', 1, '2026-10-02'], ['later', 1, '2026-10-31'],
    ['earlier', 10, '2026-10-11'], ['later', 10, '2026-10-31'],
  ] as const)('%s with %i days', (rule, leadDays, expected) => {
    expect(computeCollectOn({ issueDate: '2026-10-01', dueDate: '2026-10-31',
      offsetDays: 0, rule, noticeDate: '2026-10-01', leadDays })).toBe(expected);
  });
  it('uses UTC calendar arithmetic across a leap day', () => {
    expect(computeCollectOn({ issueDate: '2028-02-28', dueDate: '2028-02-29',
      offsetDays: 2, rule: 'later', noticeDate: '2028-02-28', leadDays: 1 }))
      .toBe('2028-03-01');
  });
  it('pushes a late notice into the following month', () => {
    expect(computeCollectOn({ issueDate: '2026-10-01', dueDate: '2026-10-01',
      offsetDays: 0, rule: 'earlier', noticeDate: '2026-10-28', leadDays: 10 }))
      .toBe('2026-11-07');
  });
  it.each(['2026-02-30', 'invalid', '2026-1-01'])('rejects %s', issueDate => {
    expect(() => computeCollectOn({ issueDate, dueDate: '2026-10-01',
      offsetDays: 0, rule: 'later', noticeDate: '2026-10-01', leadDays: 1 })).toThrow();
  });
  it.each([
    ['card', null, 1], ['card', 'individual', 1],
    ['us_bank_account', 'company', 1], ['us_bank_account', 'individual', 10],
  ] as const)('lead for %s/%s', (type, accountHolderType, expected) => {
    expect(noticeLeadDays({ type, accountHolderType })).toBe(expected);
  });
});
```
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/scheduler.test.ts`; the new module is missing.
- [ ] **Step 3: Implement** — start `scheduler.ts` with these complete functions. Unknown ACH holder type is refused by eligibility in Task 4, not retyped here.
```ts
import type { AutopayOffsetRule, AutopayPaymentMethodType, AccountHolderType } from '@breeze/shared';

export function utcDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid UTC date');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid UTC date');
  }
  return date;
}
export function addUtcDays(value: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error('Days must be an integer');
  const date = utcDay(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function computeCollectOn(input: {
  issueDate: string; dueDate: string; offsetDays: number;
  rule: AutopayOffsetRule; noticeDate: string; leadDays: number;
}): string {
  if (!Number.isInteger(input.offsetDays) || input.offsetDays < 0 || input.offsetDays > 60) {
    throw new Error('Invalid autopay offset');
  }
  if (input.leadDays !== 1 && input.leadDays !== 10) throw new Error('Invalid notice lead');
  utcDay(input.dueDate);
  const offsetDate = addUtcDays(input.issueDate, input.offsetDays);
  const chosen = input.rule === 'earlier'
    ? (offsetDate < input.dueDate ? offsetDate : input.dueDate)
    : (offsetDate > input.dueDate ? offsetDate : input.dueDate);
  const earliest = addUtcDays(input.noticeDate, input.leadDays);
  return chosen > earliest ? chosen : earliest;
}
export function noticeLeadDays(method: {
  type: AutopayPaymentMethodType; accountHolderType: AccountHolderType | null;
}): 1 | 10 {
  return method.type === 'us_bank_account' && method.accountHolderType === 'individual' ? 10 : 1;
}
```
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/scheduler.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/scheduler.ts apps/api/src/services/autopay/scheduler.test.ts`; `git commit -m "feat(billing): define UTC autopay notice dates"`.

### Task 2: Invoice notice template and immutable append blocks (W4a)
**Files:** Modify `packages/shared/src/utils/emailTemplates.ts`, `apps/api/src/services/emailTemplates/defaults.ts`, prerequisite `apps/api/src/services/autopay/renderBillingNotice.ts`; Test `packages/shared/src/utils/emailTemplates.test.ts`, `apps/api/src/services/autopay/renderBillingNotice.test.ts`.
**Interfaces:** Consumes C4 `renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext): Promise<RenderedNotice>`, `RenderedNotice`; produces the C6 `invoice_autopay` renderer. Extend W2’s existing `BillingNoticeContext` union with `{ charging: ChargingNoticeContext }`; preserve its registered-renderer and `{ autopay: AutopayNoticeContext }` arms and the fixed C4 signature.

- [ ] **Step 1: Write the failing test** — add to shared tests:
```ts
import { expect, it } from 'vitest';
import { EMAIL_TEMPLATE_IDS, varsForEmailTemplate } from './emailTemplates';
it('pins the invoice autopay variable contract', () => {
  expect(EMAIL_TEMPLATE_IDS).toContain('invoice_autopay');
  expect(varsForEmailTemplate('invoice_autopay')).toEqual([
    'org_name', 'partner_name', 'invoice_number', 'amount_due', 'due_date',
    'charge_date', 'payment_method', 'fee_amount', 'invoice_link',
  ]);
});
```
Add to API renderer tests, using the new branch context explicitly:
```ts
import { expect, it } from 'vitest';
import { renderChargingNotice } from './renderBillingNotice';
it('keeps skip, stop, fee and mandate text outside a partner override', () => {
  const result = renderChargingNotice({
    vars: { org_name: 'Customer', partner_name: 'Provider', invoice_number: 'INV-1',
      amount_due: 'USD 100.00', due_date: '2026-10-01', charge_date: '2026-10-11',
      payment_method: 'Bank ••1234', fee_amount: 'USD 0.00', invoice_link: 'https://portal.example.com/invoice/x' },
    custom: { subject: 'Invoice', heading: 'Invoice', html: '<p>Custom body</p>', buttonLabel: null },
    skipUrl: 'https://portal.example.com/autopay/s/skip',
    stopUrl: 'https://portal.example.com/autopay/t/stop',
    feeText: 'Processing fee: USD 0.00', authorizationText: 'Authorized bank debit; initiation date shown above.',
    frozen: { amount: '100.00', fee: '0.00', chargeDate: '2026-10-11' },
  });
  expect(result.html).toContain('/autopay/s/skip');
  expect(result.html).toContain('/autopay/t/stop');
  expect(result.html).toContain('Processing fee: USD 0.00');
  expect(result.html).toContain('Authorized bank debit');
  expect(result.text).toContain('/autopay/s/skip');
  expect(result.frozen.amount).toBe('100.00');
});
```
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/renderBillingNotice.test.ts`; missing renderer. `cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts`; missing ID.
- [ ] **Step 3: Implement** — add `'invoice_autopay'` to `EMAIL_TEMPLATE_IDS`; add the new variable literals to `EmailTemplateVarKey`; add these entries to the existing exhaustive records in `emailTemplates.ts`:
```ts
// VARS_BY_ID
invoice_autopay: ['org_name', 'partner_name', 'invoice_number', 'amount_due', 'due_date',
  'charge_date', 'payment_method', 'fee_amount', 'invoice_link'],
// LABEL_BY_ID
invoice_autopay: 'Invoice with automatic payment notice',
// HAS_CTA_BY_ID
invoice_autopay: true,
// FIELD_DEFAULTS_BY_ID
invoice_autopay: {
  subject: 'Invoice {{invoice_number}} — automatic payment notice',
  heading: 'Your invoice is ready', buttonLabel: 'View invoice',
  html: '<p>{{amount_due}} is due on {{due_date}}. We will initiate payment on or around {{charge_date}} using {{payment_method}}. Processing fee: {{fee_amount}}.</p>',
},
```
In API `defaults.ts`, add `invoice_autopay: 'Your invoice and automatic payment date.'` to `PREHEADER_BY_ID` and `invoice_autopay: 'Keep this notice for your records.'` to `FOOTER_BY_ID`. The existing `defaultSubject`, `defaultHtml`, and `defaultHeading` use the shared catalog; keep that delegation.

Add this real renderer to `renderBillingNotice.ts`, its context member to W1’s context type, and the early branch shown below to its existing function:
```ts
import { escapeHtml } from '../emailLayout';
import { renderPartnerEmail, type PartnerEmailCustom } from '../emailTemplates/renderPartnerEmail';
import type { RenderedNotice } from './noticeOutbox';

export interface ChargingNoticeContext {
  vars: Record<string, string>;
  custom?: PartnerEmailCustom | null;
  skipUrl: string;
  stopUrl: string;
  feeText: string;
  authorizationText: string;
  frozen: RenderedNotice['frozen'];
}
export function renderChargingNotice(ctx: ChargingNoticeContext): RenderedNotice {
  checkedUrl(ctx.skipUrl); checkedUrl(ctx.stopUrl); checkedUrl(ctx.vars.invoice_link!);
  const append = `<p>${escapeHtml(ctx.feeText)}</p><p>${escapeHtml(ctx.authorizationText)}</p>`
    + `<p><a href="${escapeHtml(ctx.skipUrl)}">Skip this invoice</a> · `
    + `<a href="${escapeHtml(ctx.stopUrl)}">Stop automatic payments</a></p>`;
  const rendered = renderPartnerEmail({ id: 'invoice_autopay', custom: ctx.custom,
    vars: ctx.vars, ctaUrl: ctx.vars.invoice_link, bodyAfterCta: append });
  return { ...rendered, frozen: ctx.frozen,
    text: `Invoice ${ctx.vars.invoice_number}\nAmount: ${ctx.vars.amount_due}\n`
      + `Charge on or around ${ctx.vars.charge_date} using ${ctx.vars.payment_method}\n`
      + `${ctx.feeText}\n${ctx.authorizationText}\nInvoice: ${ctx.vars.invoice_link}\n`
      + `Skip: ${ctx.skipUrl}\nStop: ${ctx.stopUrl}` };
}
// Extend the existing BillingNoticeContext union with:
// | { charging: ChargingNoticeContext }
// First branch inside renderBillingNotice:
if ('charging' in ctx) {
  if (kind !== 'invoice_autopay') throw new Error('Wrong charging notice context');
  return renderChargingNotice(ctx.charging);
}
```
Validate all appended URLs through W1’s existing safe URL checks; only `buildBillingLinkUrl`/`buildPublicInvoiceUrl` create production values. Keep HTML escaping even for generated values.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/renderBillingNotice.test.ts`; `cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts`.
- [ ] **Step 5: Commit** — `git add packages/shared/src/utils/emailTemplates.ts packages/shared/src/utils/emailTemplates.test.ts apps/api/src/services/emailTemplates/defaults.ts apps/api/src/services/autopay/renderBillingNotice.ts apps/api/src/services/autopay/renderBillingNotice.test.ts`; `git commit -m "feat(billing): render immutable autopay invoice notices"`.

### Task 3: Fenced notice delivery and re-notice (W4a)
**Files:** Create `apps/api/src/services/autopay/chargingNotice.ts`, `apps/api/src/services/autopay/chargingNotice.test.ts`; Modify prerequisite `apps/api/src/jobs/autopayWorker.ts`.
**Interfaces:** Consumes C4 `mintBillingLinkToken`, `buildBillingLinkUrl`, `enqueueBillingNotice`, `registerNoticeSentHandler`, `renderBillingNotice`; produces `AutopayTerms`, `enqueueAutopayNotice(tx: Tx, scheduleId: string): Promise<void>`, `invoiceAutopayNoticeSent: NoticeSentHandler`, `registerAutopayNoticeHandlers(): void`. `AutopayTerms` is a W4-private JSON shape, not a new database type.

- [ ] **Step 1: Write the failing test** — standalone Drizzle mock matching `.select().from().where().limit().for()`:
```ts
import { expect, it, vi } from 'vitest';
const { emit } = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('../invoiceEvents', () => ({ emitInvoiceEvent: emit }));
import { invoiceAutopayNoticeSent } from './chargingNotice';
import type { NoticeSentHandler } from './noticeOutbox';
it.each(['old-outbox', 'cancelled', 'new-generation'])(
  'does not revive authority after %s', async reason => {
    const writes: unknown[] = [];
    const responses = [
      [{ id: '10000000-0000-4000-8000-000000000001', partnerId: 'p', orgId: 'o' }],
      reason === 'old-outbox' ? [] : [{ id: 's', state: reason === 'cancelled' ? 'cancelled' : 'awaiting_notice',
        enrollmentGeneration: 1, enrollmentId: 'e' }],
      [{ generation: 2, status: 'active' }],
    ];
    const chain: Record<string, any> = {};
    for (const name of ['select', 'from', 'where', 'limit', 'for']) chain[name] = () => chain;
    chain.then = (resolve: (x: unknown) => unknown) => Promise.resolve(responses.shift()).then(resolve);
    chain.update = () => { writes.push(true); return chain; };
    await invoiceAutopayNoticeSent(chain as Parameters<NoticeSentHandler>[0], {
      id: 'outbox', invoiceId: '10000000-0000-4000-8000-000000000001', sentAt: new Date('2026-10-05T12:00Z'),
    } as Parameters<NoticeSentHandler>[1]);
    expect(writes).toEqual([]);
  });
```
Add the successful delayed-send case using the same chain: responses are invoice, current awaiting schedule with lead 10/date `2026-10-03`, matching active enrollment, update result, invoice update result. Assert schedule becomes `scheduled` with `collectOn='2026-10-15'`, invoice gets `sentAt`, and emitted event is `invoice.sent`. Repeat callback and assert no second stamp. This assertion must precede the implementation.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/chargingNotice.test.ts`; module missing.
- [ ] **Step 3: Implement** — complete notice module:
```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { billingNoticeOutbox, invoiceAutopaySchedules, invoices,
  orgAutopayEnrollments, organizations, partners } from '../../db/schema';
import type { AutopayPaymentMethodType, AccountHolderType } from '@breeze/shared';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { partnerEmailCustomFromSettings } from '../emailTemplates/renderPartnerEmail';
import { emitInvoiceEvent } from '../invoiceEvents';
import { mintBillingLinkToken, buildBillingLinkUrl } from './linkTokens';
import { enqueueBillingNotice, registerNoticeSentHandler, type NoticeSentHandler } from './noticeOutbox';
import { renderBillingNotice } from './renderBillingNotice';
import { addUtcDays } from './scheduler';
type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface AutopayTerms {
  issuedAt: string; offsetDays: number; rule: 'earlier' | 'later';
  cap: { enabled: false } | { enabled: true; amount: string; currency: string };
  methodType: AutopayPaymentMethodType; methodId: string; last4: string;
  methodLabel: string; accountHolderType: AccountHolderType | null;
  noticeLeadDays: 1 | 10; principal: string; currency: string;
  feeAmount: string; feeKind: 'none' | 'card_percent' | 'ach_flat';
  cardFeeBps: number; achFeeAmount: string; chargeDate: string;
  noticeSeq: number;
}
export async function enqueueAutopayNotice(tx: Tx, scheduleId: string): Promise<void> {
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.id, scheduleId)).limit(1);
  if (!schedule?.eligible || schedule.state !== 'awaiting_notice') return;
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, schedule.invoiceId)).limit(1);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, schedule.orgId)).limit(1);
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice!.partnerId)).limit(1);
  const contact = org?.billingContact as { email?: string } | null;
  if (!contact?.email) {
    await tx.update(invoiceAutopaySchedules).set({ stateReason: 'no_billing_contact' })
      .where(eq(invoiceAutopaySchedules.id, schedule.id));
    return;
  }
  const terms = schedule.termsSnapshot as AutopayTerms;
  const seq = terms.noticeSeq;
  const existing = await tx.select({ id: billingNoticeOutbox.id }).from(billingNoticeOutbox)
    .where(eq(billingNoticeOutbox.dedupeKey, `${invoice!.id}:invoice_autopay:${seq}`)).limit(1);
  if (existing[0]) return;
  const skip = await mintBillingLinkToken(tx, { orgId: schedule.orgId, invoiceId: schedule.invoiceId,
    enrollmentId: schedule.enrollmentId, generation: schedule.enrollmentGeneration,
    purpose: 'skip_invoice', ttlDays: 90 });
  const stop = await mintBillingLinkToken(tx, { orgId: schedule.orgId,
    enrollmentId: schedule.enrollmentId, generation: schedule.enrollmentGeneration,
    purpose: 'stop_autopay', ttlDays: 90 });
  // This existing helper uses the ambient db proxy. Caller must own that SAME tx.
  const link = await getOrMintInvoiceLink(invoice!);
  const rendered = await renderBillingNotice('invoice_autopay', { charging: {
    vars: { org_name: org!.name, partner_name: partner!.name,
      invoice_number: invoice!.invoiceNumber!, amount_due: `${terms.currency} ${terms.principal}`,
      due_date: invoice!.dueDate!, charge_date: schedule.collectOn!,
      payment_method: terms.methodLabel, fee_amount: `${terms.currency} ${terms.feeAmount}`,
      invoice_link: buildPublicInvoiceUrl(link.token) },
    custom: partnerEmailCustomFromSettings(partner!.settings, 'invoice_autopay'),
    skipUrl: buildBillingLinkUrl('skip_invoice', skip.token),
    stopUrl: buildBillingLinkUrl('stop_autopay', stop.token),
    feeText: `Processing fee: ${terms.currency} ${terms.feeAmount}`,
    authorizationText: terms.methodType === 'us_bank_account'
      ? 'Bank debit authorized during setup. The date is the initiation date; your bank controls settlement.'
      : 'Payment authorized during automatic payment setup.',
    frozen: { amount: terms.principal, fee: terms.feeAmount, chargeDate: schedule.collectOn,
      methodType: terms.methodType, enrollmentGeneration: schedule.enrollmentGeneration },
  } });
  const outbox = await enqueueBillingNotice(tx, { orgId: schedule.orgId, partnerId: invoice!.partnerId,
    invoiceId: invoice!.id, enrollmentId: schedule.enrollmentId, kind: 'invoice_autopay', seq,
    dedupeKey: `${invoice!.id}:invoice_autopay:${seq}`, toEmail: contact.email, rendered });
  await tx.update(invoiceAutopaySchedules).set({ noticeOutboxId: outbox.id,
    noticeSentAt: null, stateReason: null }).where(eq(invoiceAutopaySchedules.id, schedule.id));
}
export const invoiceAutopayNoticeSent: NoticeSentHandler = async (tx, row) => {
  if (!row.invoiceId || !row.sentAt) return;
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, row.invoiceId)).limit(1).for('update');
  if (!invoice || ['void', 'paid', 'draft'].includes(invoice.status)) return;
  const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(and(
    eq(invoiceAutopaySchedules.invoiceId, invoice.id), eq(invoiceAutopaySchedules.noticeOutboxId, row.id),
  )).limit(1).for('update');
  if (!schedule || schedule.state !== 'awaiting_notice') return;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
  if (!enrollment || enrollment.status !== 'active' || enrollment.generation !== schedule.enrollmentGeneration) return;
  const terms = schedule.termsSnapshot as AutopayTerms;
  const earliest = addUtcDays(row.sentAt.toISOString().slice(0, 10), terms.noticeLeadDays);
  await tx.update(invoiceAutopaySchedules).set({ noticeSentAt: row.sentAt, state: 'scheduled',
    collectOn: schedule.collectOn! > earliest ? schedule.collectOn : earliest,
  }).where(eq(invoiceAutopaySchedules.id, schedule.id));
  const changed = await tx.update(invoices).set({ sentAt: row.sentAt })
    .where(and(eq(invoices.id, invoice.id), isNull(invoices.sentAt))).returning({ id: invoices.id });
  if (changed.length) await emitInvoiceEvent({ type: 'invoice.sent', invoiceId: invoice.id,
    orgId: invoice.orgId, partnerId: invoice.partnerId, actorUserId: null });
};
export function registerAutopayNoticeHandlers(): void {
  registerNoticeSentHandler('invoice_autopay', invoiceAutopayNoticeSent);
}
```
The callback deliberately does not mutate frozen `chargeDate`: rendered history remains what the recipient saw. A delayed send moves initiation later (“on or around”), never earlier. Event publication retains `emitInvoiceEvent`’s existing best-effort semantics; it is not an exactly-once event bus. Charging authority is the committed outbox/schedule state, not Redis delivery. Register the callback at the start of W1’s `initializeAutopayWorkers`, before starting the notice worker. Do not register it only from the API process: dedicated `worker.ts` also dispatches notices.

W1’s `BillingNoticeContext` may have required common properties; extend it as a discriminated union with the `charging` case above rather than weakening all existing kinds or casting `as any`. The other cases retain their actual landed types.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/chargingNotice.test.ts src/jobs/autopayWorker.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/chargingNotice.ts apps/api/src/services/autopay/chargingNotice.test.ts apps/api/src/jobs/autopayWorker.ts`; `git commit -m "feat(billing): fence charging on delivered current notices"`.

### Task 4: Persist the issue-time eligibility snapshot (W4a)
**Files:** Modify `apps/api/src/services/autopay/scheduler.ts`; Test `apps/api/src/services/autopay/scheduler.test.ts`.
**Interfaces:** Consumes C4 `resolveBillingPaymentSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveBillingPaymentSettings>`, `isAutopayEnabledForPartner(db: Tx, partnerId: string): Promise<boolean>`, `getAutopayStripeReadiness(db: Tx, partnerId: string)`, `getAutopayMethod(db: Tx, orgId: string)`, `quoteProcessingFee(input: FeeQuoteInput): FeeQuote`; produces C4 `planAutopayForInvoice(tx: Tx, invoiceId: string): Promise<typeof invoiceAutopaySchedules.$inferSelect | null>`.

- [ ] **Step 1: Write the failing test** — append the matrix before implementing its helper:
```ts
import { eligibilityReason, type Eligibility } from './scheduler';
const good: Eligibility = {
  active: true, effective: true, methodUsable: true, charging: true,
  stripeReady: true, sameAccount: true, achCurrency: true,
  capCurrency: true, underCap: true, excludedContract: false, excludedInvoice: false,
};
it.each([
  ['active', false, 'not_enrolled'], ['effective', false, 'enrolled_after_issue'],
  ['methodUsable', false, 'method_not_usable'], ['charging', false, 'charging_disabled'],
  ['stripeReady', false, 'stripe_unavailable'], ['sameAccount', false, 'stripe_unavailable'],
  ['achCurrency', false, 'ach_currency_unsupported'], ['capCurrency', false, 'cap_currency_mismatch'],
  ['underCap', false, 'over_cap'], ['excludedContract', true, 'excluded_contract'],
  ['excludedInvoice', true, 'excluded_invoice'],
] as const)('%s yields %s', (key, value, reason) => {
  expect(eligibilityReason({ ...good, [key]: value })).toBe(reason);
});
it('keeps a fully eligible invoice eligible', () => expect(eligibilityReason(good)).toBeNull());
```
The real-DB test in Task 20 pins source-contract lineage, cap comparisons, same-day timestamps, no enrollment, and schedule rollback, which a pure boolean table cannot prove.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/scheduler.test.ts`; missing `eligibilityReason`.
- [ ] **Step 3: Implement** — append these imports and functions to `scheduler.ts`:
```ts
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { invoices, invoiceLines, contracts, organizations, orgAutopayEnrollments,
  invoiceAutopaySchedules } from '../../db/schema';
import type { AutopayIneligibleReason } from '@breeze/shared';
import { toMinorUnits } from '../stripeMoney';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { isAutopayEnabledForPartner } from './autopayGate';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { getAutopayMethod } from './paymentMethods';
import { quoteProcessingFee } from './processingFee';
import { enqueueAutopayNotice, type AutopayTerms } from './chargingNotice';
type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface Eligibility {
  active: boolean; effective: boolean; methodUsable: boolean; charging: boolean;
  stripeReady: boolean; sameAccount: boolean; achCurrency: boolean; capCurrency: boolean;
  underCap: boolean; excludedContract: boolean; excludedInvoice: boolean;
}
export function eligibilityReason(e: Eligibility): AutopayIneligibleReason | null {
  if (!e.active) return 'not_enrolled';
  if (!e.effective) return 'enrolled_after_issue';
  if (!e.methodUsable) return 'method_not_usable';
  if (!e.charging) return 'charging_disabled';
  if (!e.stripeReady || !e.sameAccount) return 'stripe_unavailable';
  if (!e.achCurrency) return 'ach_currency_unsupported';
  if (!e.capCurrency) return 'cap_currency_mismatch';
  if (!e.underCap) return 'over_cap';
  if (e.excludedContract) return 'excluded_contract';
  if (e.excludedInvoice) return 'excluded_invoice';
  return null;
}
export async function planAutopayForInvoice(tx: Tx, invoiceId: string)
  : Promise<typeof invoiceAutopaySchedules.$inferSelect | null> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  if (!invoice?.invoiceNumber || !invoice.issueDate || !invoice.dueDate) return null;
  const [existing] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1);
  if (existing) return existing;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1);
  if (!enrollment) return null;
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
  if (!org) throw new Error('Invoice organization missing');
  const settings = await resolveBillingPaymentSettings(tx, { partnerId: invoice.partnerId, orgId: invoice.orgId });
  const method = await getAutopayMethod(tx, invoice.orgId);
  const readiness = await getAutopayStripeReadiness(tx, invoice.partnerId);
  const charging = await isAutopayEnabledForPartner(tx, invoice.partnerId);
  const excluded = await tx.select({ id: contracts.id }).from(invoiceLines).innerJoin(contracts, and(
    eq(invoiceLines.sourceContractId, contracts.id), eq(invoiceLines.orgId, contracts.orgId),
  )).where(and(eq(invoiceLines.invoiceId, invoiceId), eq(contracts.autopayExcluded, true))).limit(1);
  const cap = settings.autopayCap.value;
  const capCurrency = !cap.enabled || cap.currency.toUpperCase() === invoice.currencyCode;
  const reason = eligibilityReason({ active: enrollment.status === 'active',
    effective: !!enrollment.effectiveFrom && enrollment.effectiveFrom <= invoice.updatedAt,
    methodUsable: !!method && ['active', 'pending_verification'].includes(method.status)
      && (method.type !== 'us_bank_account' || method.accountHolderType !== null),
    charging, stripeReady: readiness.ready,
    sameAccount: readiness.stripeAccountId === enrollment.stripeAccountId,
    achCurrency: method?.type !== 'us_bank_account' || invoice.currencyCode === 'USD',
    capCurrency, underCap: !cap.enabled || (capCurrency &&
      toMinorUnits(invoice.total, invoice.currencyCode) <= toMinorUnits(cap.amount, invoice.currencyCode)),
    excludedContract: excluded.length > 0, excludedInvoice: invoice.autopayExcluded,
  });
  const leadDays = method ? noticeLeadDays(method) : 1;
  const collectOn = computeCollectOn({ issueDate: invoice.issueDate, dueDate: invoice.dueDate,
    offsetDays: settings.autopayOffsetDays.value, rule: settings.autopayOffsetRule.value,
    noticeDate: new Date().toISOString().slice(0, 10), leadDays });
  const fee = method ? quoteProcessingFee({ methodType: method.type, cardFunding: method.cardFunding,
    principal: invoice.balance, currency: invoice.currencyCode, stripeAccountCountry: readiness.accountCountry,
    orgBillingCountry: org.billingAddressCountry, orgBillingRegion: org.billingAddressRegion,
    cardFeeBps: settings.cardFeeBps.value, achFeeAmount: settings.achFeeAmount.value,
    feeAttested: settings.feeAttested }) : { feeAmount: '0.00', kind: 'none' as const };
  const snapshot = method ? {
    issuedAt: invoice.updatedAt.toISOString(), offsetDays: settings.autopayOffsetDays.value,
    rule: settings.autopayOffsetRule.value, cap, methodType: method.type, methodId: method.id,
    last4: method.type === 'card' ? method.cardLast4 ?? '' : method.bankLast4 ?? '',
    methodLabel: method.type === 'card'
      ? `${method.cardBrand ?? 'Card'} ••${method.cardLast4 ?? ''}`
      : `${method.bankName ?? 'Bank'} ••${method.bankLast4 ?? ''}`,
    accountHolderType: method.accountHolderType, noticeLeadDays: leadDays,
    principal: invoice.balance, currency: invoice.currencyCode, feeAmount: fee.feeAmount,
    feeKind: fee.kind, cardFeeBps: settings.cardFeeBps.value,
    achFeeAmount: settings.achFeeAmount.value, chargeDate: collectOn, noticeSeq: 1,
  } satisfies AutopayTerms : { issuedAt: invoice.updatedAt.toISOString(), noticeSeq: 0 };
  const [created] = await tx.insert(invoiceAutopaySchedules).values({ orgId: invoice.orgId,
    invoiceId, enrollmentId: enrollment.id, enrollmentGeneration: enrollment.generation,
    eligible: reason === null, ineligibleReason: reason, collectOn, termsSnapshot: snapshot,
    state: reason === null ? 'awaiting_notice' : 'not_needed', stateReason: reason,
    attemptCount: 0 }).returning();
  if (!created) throw new Error('Autopay schedule insert failed');
  if (created.eligible) await enqueueAutopayNotice(tx, created.id);
  const [planned] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.id, created.id)).limit(1);
  return planned!;
}
```
No provider calls occur here. `pending_verification` remains eligible and noticed, but collection defers until method status becomes `active`. A failed/missing-contact notice leaves `awaiting_notice`, never `scheduled`.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/scheduler.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/scheduler.ts apps/api/src/services/autopay/scheduler.test.ts`; `git commit -m "feat(billing): snapshot autopay eligibility at issue"`.

### Task 5: Connect both issue transactions and route Send through the notice (W4a)
**Files:** Modify `apps/api/src/services/invoiceService.ts`, `apps/api/src/services/quoteAcceptService.ts`, `apps/api/src/services/invoicePdf.ts`, `apps/web/src/components/billing/InvoiceActions.tsx`; Test their existing `.test.ts`/`.test.tsx` files and `apps/api/src/jobs/contractWorker.test.ts`.
**Interfaces:** Consumes `planAutopayForInvoice(tx, invoiceId)`; preserves existing `issueInvoice(invoiceId: string, actor: InvoiceActor)`, `sendInvoiceEmail(invoiceId: string, actor: InvoiceActor, opts: SendInvoiceEmailOptions = {}): Promise<SendInvoiceResult>`, `resendInvoiceEmail(...)`. Produces truthful `SendInvoiceEmailReason` addition `'notice_queued'`.

- [ ] **Step 1: Write the failing test** — add this mock to the existing issue tests before the service import and assert it inside the existing successful issue case, which already queues the full invoice/source/counter chains:
```ts
const { plan } = vi.hoisted(() => ({ plan: vi.fn().mockResolvedValue(null) }));
vi.mock('./autopay/scheduler', () => ({ planAutopayForInvoice: plan }));
// In the successful issue assertion block:
expect(plan).toHaveBeenCalledWith(db, invoiceId);
```
In `quoteAcceptService.test.ts`, use its existing `baseParams` and successful one-time fixture; assert `plan` gets that fixture’s invoice ID and `db`. Add a recurring-only fixture assertion `expect(plan).not.toHaveBeenCalled()`. In `contractWorker.test.ts`, retain `issueInvoice` real in the new integration case in Task 20; unit test its existing issue→send ordering rather than asserting a nonexistent third planner call.

In `apps/api/src/services/invoiceResend.test.ts`, extend the existing invoicePdf import with `sendInvoiceEmail`, import the already mocked `emitInvoiceEvent`, and add this test inside the existing describe (so its verified `beforeEach` clears `dbResults` and `sendEmailMock`):
```ts
it('queues the issued autopay notice without sending or claiming delivery', async () => {
  dbResults.push([invoice({ sentAt: null })]);
  dbResults.push([{ eligible: true, state: 'awaiting_notice',
    noticeOutboxId: '33333333-3333-4333-8333-333333333333' }]);
  dbResults.push([{ status: 'pending', toEmail: 'billing@example.test' }]);
  const result = await sendInvoiceEmail(INV_ID, actor);
  expect(result).toMatchObject({ emailed: false, reason: 'notice_queued', recipients: [] });
  expect(sendEmailMock).not.toHaveBeenCalled();
  expect(emitInvoiceEvent).not.toHaveBeenCalled();
  expect(updateSetMock).not.toHaveBeenCalled();
});
```
Cover both plain Issue then Send and draft Send; resend must still call the existing delivery function and never enqueue a new notice. A failed outbox must stay visible as failure and must not fall back to a second invoice email.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/invoiceService.test.ts src/services/quoteAcceptService.test.ts src/services/invoiceResend.test.ts src/jobs/contractWorker.test.ts`; planner and email-routing assertions fail.
- [ ] **Step 3: Implement** — add the exact issuing hooks:
```ts
// invoiceService.ts import
import { planAutopayForInvoice } from './autopay/scheduler';
// In issueTx, after source flips and before return inv:
await planAutopayForInvoice(db, invoiceId);
```
```ts
// quoteAcceptService.ts import
import { planAutopayForInvoice } from './autopay/scheduler';
// Immediately after the existing issueFields update:
if (oneTime.length > 0) await planAutopayForInvoice(db, invoice!.id);
```
In `invoicePdf.ts`, import the two W1 tables, add `'notice_queued'` to `SendInvoiceEmailReason`, and insert this branch after the draft issue/reload and before `deliverInvoiceEmail`:
```ts
const [autopay] = await db.select().from(invoiceAutopaySchedules)
  .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1);
if (autopay?.eligible && ['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled'].includes(autopay.state)) {
  const [notice] = autopay.noticeOutboxId ? await db.select().from(billingNoticeOutbox)
    .where(eq(billingNoticeOutbox.id, autopay.noticeOutboxId)).limit(1) : [];
  if (notice?.status === 'sent') {
    return { invoice, emailed: true, recipients: [notice.toEmail] };
  }
  return { invoice, emailed: false, recipients: [],
    reason: notice?.status === 'failed' ? 'send_failed' : 'notice_queued' };
}
```
Do not override notice recipients/subject from the Send composer; the frozen notice is already queued by issue. In `InvoiceActions.issue` and its first-send `resend` handler’s existing result handling, put the queued branch before its generic `!emailed` warning:
```ts
if (result?.data?.reason === 'notice_queued') {
  showToast({ type: 'success', message: stableT('autopay.noticeQueued') });
}
```
Extend the existing `runAction` response types with `reason?: string`. Insert this as the first arm of the existing emailed/warning conditional, so it emits one toast, not two. This is not a second request. No change to `resendInvoiceEmail`. Contract worker remains one issue followed by one send.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/invoiceService.test.ts src/services/quoteAcceptService.test.ts src/services/invoiceResend.test.ts src/jobs/contractWorker.test.ts`; `cd apps/web && npx vitest run src/components/billing/InvoiceActions.test.tsx`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts apps/api/src/services/quoteAcceptService.ts apps/api/src/services/quoteAcceptService.test.ts apps/api/src/services/invoicePdf.ts apps/api/src/services/invoiceResend.test.ts apps/api/src/jobs/contractWorker.test.ts apps/web/src/components/billing/InvoiceActions.tsx apps/web/src/components/billing/InvoiceActions.test.tsx`; `git commit -m "feat(billing): schedule every issuing path and dedupe invoice sends"`.

### Task 6: Skip, exclusions, and issued due-date re-notice (W4a)
**Files:** Create `apps/api/src/services/autopay/invoiceControls.ts`, `apps/api/src/services/autopay/invoiceControls.test.ts`; Modify `apps/api/src/services/invoiceService.ts`, `packages/shared/src/validators/contracts.ts`, `apps/api/src/services/contractService.ts`, prerequisite `apps/api/src/services/autopay/staffNotifications.ts`; Test `apps/api/src/services/invoiceService.test.ts`, `apps/api/src/routes/contracts/contracts.test.ts`.
**Interfaces:** Consumes C4 `assertNoActiveCollection(tx: Tx, invoiceId: string): Promise<void>`, `resolveBillingLinkToken(db: Tx, token: string, purpose: BillingLinkPurpose)`, `requireInvoiceAccess(actor, invoice)`; produces `skipInvoice(tx: Tx, token: string): Promise<void>`, `setInvoiceAutopayExcluded(tx: Tx, invoiceId: string, excluded: boolean, actor: InvoiceActor): Promise<void>`, `renoticeSchedule(tx: Tx, invoiceId: string): Promise<void>`.

- [ ] **Step 1: Write the failing test** — in `invoiceControls.test.ts`:
```ts
import { expect, it, vi } from 'vitest';
const { active } = vi.hoisted(() => ({ active: vi.fn() }));
vi.mock('./reservation', () => ({ assertNoActiveCollection: active }));
import { assertControllable } from './invoiceControls';
it('refuses skip or exclusion while money is reserved', async () => {
  const error = Object.assign(new Error('Payment is processing'), { status: 409, code: 'COLLECTION_IN_PROGRESS' });
  active.mockRejectedValueOnce(error);
  await expect(assertControllable({} as never, '10000000-0000-4000-8000-000000000001'))
    .rejects.toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
});
```
Add route cases for cross-org/site, malformed UUID, nonboolean exclusion, missing invoice and terminal schedule. Add a due-date test with `state='skipped_by_client'`: updating due date preserves the skip; the same edit on `scheduled` clears notice authority, increments seq, and enqueues one replacement.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/invoiceControls.test.ts src/services/invoiceService.test.ts src/routes/contracts/contracts.test.ts`.
- [ ] **Step 3: Implement** — create `invoiceControls.ts`:
```ts
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { invoices, invoiceAutopaySchedules, invoiceCollectionAttempts, billingNoticeOutbox,
  billingLinkTokens, orgAutopayEnrollments, invoiceLines, contracts } from '../../db/schema';
import { InvoiceServiceError, type InvoiceActor } from '../invoiceTypes';
import { requireInvoiceAccess } from '../invoiceService';
import { assertNoActiveCollection } from './reservation';
import { resolveBillingLinkToken } from './linkTokens';
import { computeCollectOn } from './scheduler';
import { enqueueAutopayNotice, type AutopayTerms } from './chargingNotice';
type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function assertControllable(tx: Tx, invoiceId: string): Promise<void> {
  await assertNoActiveCollection(tx, invoiceId);
  const [action] = await tx.select({ id: invoiceCollectionAttempts.id }).from(invoiceCollectionAttempts)
    .where(and(eq(invoiceCollectionAttempts.invoiceId, invoiceId),
      eq(invoiceCollectionAttempts.state, 'requires_action'))).limit(1);
  if (action) throw new InvoiceServiceError('Resolve the pending payment confirmation first', 409, 'INVALID_STATE');
}
export async function renoticeSchedule(tx: Tx, invoiceId: string): Promise<void> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1).for('update');
  if (!invoice || !schedule || schedule.state !== 'scheduled') return;
  const terms = schedule.termsSnapshot as AutopayTerms;
  const collectOn = computeCollectOn({ issueDate: invoice.issueDate!, dueDate: invoice.dueDate!,
    offsetDays: terms.offsetDays, rule: terms.rule,
    noticeDate: new Date().toISOString().slice(0, 10), leadDays: terms.noticeLeadDays });
  if (schedule.noticeOutboxId) await tx.update(billingNoticeOutbox).set({ status: 'cancelled' }).where(and(
    eq(billingNoticeOutbox.id, schedule.noticeOutboxId), inArray(billingNoticeOutbox.status, ['pending', 'failed']),
  ));
  await tx.update(invoiceAutopaySchedules).set({ state: 'awaiting_notice', noticeSentAt: null,
    noticeOutboxId: null, collectOn, termsSnapshot: { ...terms, chargeDate: collectOn,
      noticeSeq: terms.noticeSeq + 1 } }).where(eq(invoiceAutopaySchedules.id, schedule.id));
  await enqueueAutopayNotice(tx, schedule.id);
}
export async function skipInvoice(tx: Tx, token: string): Promise<void> {
  const link = await resolveBillingLinkToken(tx, token, 'skip_invoice');
  if (!link?.invoiceId) throw new InvoiceServiceError('Link unavailable', 404, 'INVOICE_NOT_FOUND');
  const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.id, link.invoiceId),
    eq(invoices.orgId, link.orgId))).limit(1).for('update');
  if (!invoice) throw new InvoiceServiceError('Link unavailable', 404, 'INVOICE_NOT_FOUND');
  await assertControllable(tx, invoice.id);
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, link.enrollmentId!)).limit(1);
  if (!enrollment || enrollment.generation !== link.generation || enrollment.status !== 'active') {
    throw new InvoiceServiceError('Link unavailable', 404, 'INVOICE_NOT_FOUND');
  }
  const changed = await tx.update(invoiceAutopaySchedules).set({ state: 'skipped_by_client',
    clientSkippedAt: new Date(), stateReason: 'client_request' }).where(and(
    eq(invoiceAutopaySchedules.invoiceId, invoice.id),
    eq(invoiceAutopaySchedules.enrollmentGeneration, enrollment.generation),
    inArray(invoiceAutopaySchedules.state, ['awaiting_notice', 'scheduled', 'retry_scheduled']),
  )).returning();
  if (!changed.length) throw new InvoiceServiceError('Invoice cannot be skipped', 409, 'INVALID_STATE');
  await tx.update(billingLinkTokens).set({ consumedAt: new Date() }).where(eq(billingLinkTokens.id, link.id));
  await tx.update(billingNoticeOutbox).set({ status: 'cancelled' }).where(and(
    eq(billingNoticeOutbox.invoiceId, invoice.id), eq(billingNoticeOutbox.kind, 'invoice_autopay'),
    inArray(billingNoticeOutbox.status, ['pending', 'failed']),
  ));
}
export async function setInvoiceAutopayExcluded(tx: Tx, invoiceId: string, excluded: boolean,
  actor: InvoiceActor): Promise<void> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  requireInvoiceAccess(actor, invoice);
  await assertControllable(tx, invoiceId);
  if (['void', 'paid'].includes(invoice.status)) throw new InvoiceServiceError('Invoice is closed', 409, 'INVALID_STATE');
  await tx.update(invoices).set({ autopayExcluded: excluded }).where(eq(invoices.id, invoiceId));
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1).for('update');
  if (!schedule) return; // Draft flag, or a historical invoice without an enrollment snapshot.
  if (excluded) {
    await tx.update(invoiceAutopaySchedules).set({ state: 'excluded_by_msp',
      mspExcludedBy: actor.userId, mspExcludedAt: new Date() }).where(and(
      eq(invoiceAutopaySchedules.id, schedule.id),
      inArray(invoiceAutopaySchedules.state, ['awaiting_notice', 'scheduled', 'retry_scheduled', 'not_needed']),
    ));
    await tx.update(billingNoticeOutbox).set({ status: 'cancelled' }).where(and(
      eq(billingNoticeOutbox.invoiceId, invoiceId), eq(billingNoticeOutbox.kind, 'invoice_autopay'),
      inArray(billingNoticeOutbox.status, ['pending', 'failed']),
    ));
    return;
  }
  if (schedule.state !== 'excluded_by_msp') return;
  if (!schedule.eligible && schedule.ineligibleReason !== 'excluded_invoice') return;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id, schedule.enrollmentId)).limit(1);
  if (!enrollment || enrollment.status !== 'active' || enrollment.generation !== schedule.enrollmentGeneration) return;
  const [excludedContract] = await tx.select({ id: contracts.id }).from(invoiceLines).innerJoin(contracts,
    and(eq(invoiceLines.sourceContractId, contracts.id), eq(invoiceLines.orgId, contracts.orgId)))
    .where(and(eq(invoiceLines.invoiceId, invoiceId), eq(contracts.autopayExcluded, true))).limit(1);
  if (excludedContract) return;
  await tx.update(invoiceAutopaySchedules).set({ eligible: true, ineligibleReason: null,
    state: 'scheduled', mspExcludedBy: null, mspExcludedAt: null })
    .where(eq(invoiceAutopaySchedules.id, schedule.id));
  await renoticeSchedule(tx, invoiceId);
}
```
In W2 `staffNotifications.ts`, extend `AutopayStaffNotice.event` with `'autopay.skipped'` in W4a and give it title `Automatic payment skipped`. The skip POST invokes `notifyAutopayStaff` after the transaction commits with org/partner from the validated token identity and dedupe key `autopay:${invoiceId}:skipped`. It must not notify for an unsuccessful or repeated skip.

Append this private helper in `invoiceControls.ts` and call `await enqueueSkippedInvoiceConfirmation(tx,invoice)` after the successful schedule/token/outbox updates in `skipInvoice`. Add the shown imports to its existing imports. W3’s registry context is used exactly; `seq:0` keeps this one-time confirmation outside its recurring reminder ordinal calculation.
```ts
import {organizations,partners} from '../../db/schema';
import {getOrMintInvoiceLink,buildPublicInvoiceUrl} from '../invoiceLinkToken';
import {resolveBillingEmail} from '../invoicePdf';
import {enqueueBillingNotice} from './noticeOutbox';
import {renderBillingNotice} from './renderBillingNotice';
async function enqueueSkippedInvoiceConfirmation(tx:Tx,invoice:typeof invoices.$inferSelect):Promise<void>{
  const [org]=await tx.select().from(organizations).where(eq(organizations.id,invoice.orgId)).limit(1);
  const [partner]=await tx.select().from(partners).where(eq(partners.id,invoice.partnerId)).limit(1);
  const recipient=resolveBillingEmail(org!.billingContact);if(!recipient)return;
  const link=await getOrMintInvoiceLink(invoice);
  const rendered=await renderBillingNotice('payment_reminder',{partnerId:invoice.partnerId,orgId:invoice.orgId,
    mandatory:{},frozen:{amount:invoice.balance,currency:invoice.currencyCode,dueDate:invoice.dueDate},
    data:{invoiceNumber:invoice.invoiceNumber,balance:invoice.balance,currency:invoice.currencyCode,
      dueDate:invoice.dueDate,daysOverdue:0,payLink:buildPublicInvoiceUrl(link.token),
      partnerName:partner!.name,orgName:org!.name,partnerSettings:partner!.settings}});
  const prefix='Automatic payment has been skipped for this invoice. You can pay using the invoice link.';
  await enqueueBillingNotice(tx,{orgId:invoice.orgId,partnerId:invoice.partnerId,invoiceId:invoice.id,
    kind:'payment_reminder',seq:0,dedupeKey:`invoice:${invoice.id}:skip:1`,toEmail:recipient,
    rendered:{...rendered,subject:`Automatic payment skipped — ${invoice.invoiceNumber}`,
      html:`<p>${prefix}</p>${rendered.html}`,text:`${prefix}\n\n${rendered.text}`}});
}
```
The fixed prefix contains no unescaped customer input. No email token is returned in MSP JSON. This is explicit client-action feedback and is independent of reminder enablement. Test one reminder outbox row with `seq:0`, one staff event, and no second mutation/email on token replay.

Replace `updateIssuedDueDate` with this implementation; import `renoticeSchedule` from `./autopay/invoiceControls`:
```ts
export async function updateIssuedDueDate(invoiceId:string,dueDate:string,actor:InvoiceActor){
  return db.transaction(async tx=>{
    const [inv]=await tx.select().from(invoices).where(eq(invoices.id,invoiceId)).limit(1).for('update');
    if(!inv)throw new InvoiceServiceError('Invoice not found',404,'INVOICE_NOT_FOUND');
    requireInvoiceAccess(actor,inv);
    if(!['sent','partially_paid','overdue'].includes(inv.status)){
      throw new InvoiceServiceError('Due date can only be changed on an open issued invoice',409,'INVALID_STATE');
    }
    await tx.update(invoices).set({dueDate,updatedAt:new Date()}).where(eq(invoices.id,invoiceId));
    await recomputeInvoiceStatus(invoiceId,tx);
    await renoticeSchedule(tx,invoiceId);
    const [updated]=await tx.select().from(invoices).where(eq(invoices.id,invoiceId)).limit(1);
    return {invoice:updated!,audit:{orgId:inv.orgId,invoiceId,oldDueDate:inv.dueDate,newDueDate:dueDate}};
  });
}
``` For `retry_scheduled`, skipped, cancelled, failed, and terminal schedules, do not replan. At charge time full checks still apply.

Add `autopayExcluded: z.boolean().optional()` to shared `updateContractSchema`; in `contractService.updateContract`, add:
```ts
if (patch.autopayExcluded !== undefined) safeSet.autopayExcluded = patch.autopayExcluded;
```
Keep existing ownership/site gates and editable-state rules. Contract exclusion affects future schedules; existing scheduled invoices are rechecked at collection and stop with `excluded_contract`.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/invoiceControls.test.ts src/services/invoiceService.test.ts src/routes/contracts/contracts.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/invoiceControls.ts apps/api/src/services/autopay/invoiceControls.test.ts apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts packages/shared/src/validators/contracts.ts apps/api/src/services/contractService.ts apps/api/src/routes/contracts/contracts.test.ts`; `git commit -m "feat(billing): add guarded invoice autopay controls"`.

### Task 7: Mount W4a routes and compose exclusions and Skip (W4a)
**Files:** Create `apps/portal/src/components/portal/AutopayActionPage.tsx`, `apps/portal/src/components/portal/AutopayActionPage.test.tsx`, `apps/portal/src/pages/autopay/[token]/skip.astro`, `apps/portal/src/pages/autopay/actions.test.ts`; Create `apps/api/src/routes/invoices/autopay.ts`, `apps/api/src/routes/autopay/mount.ts`, `apps/api/src/routes/autopay/mount.test.ts`, `apps/web/src/components/billing/InvoiceDetail.autopay.test.tsx`; Modify `apps/api/src/index.ts`, prerequisite `apps/api/src/routes/autopay/public.ts`, `apps/api/src/services/autopay/customerViews.ts`, `apps/api/src/services/invoiceService.ts`, `apps/web/src/components/billing/InvoiceDetail.tsx`, `apps/web/src/components/billing/invoiceTypes.ts`, `apps/web/src/components/contracts/ContractEditor.tsx`, `apps/web/src/components/contracts/ContractWorkspace.tsx`, `apps/web/src/lib/api/contracts.ts`, `apps/web/src/components/settings/EmailTemplatesTab.tsx`; Test `apps/web/src/components/contracts/ContractEditor.test.tsx`, `apps/web/src/components/billing/InvoiceWorkspace.test.tsx`. Pages/shells rendered: `apps/web/src/pages/billing/invoices/[id].astro` → `InvoiceWorkspace.tsx` → `InvoiceDetail.tsx`; `apps/web/src/pages/contracts/[id].astro` → `ContractWorkspace.tsx` → `ContractEditor.tsx`.
**Interfaces:** Consumes Task 6 controls and W2 `requireAutopayEnabled(): MiddlewareHandler`; produces `invoiceAutopayRoutes`, `mountAutopayChargingRoutes(api: Hono): void`, `detail.autopay` JSON. Public skip is mounted on the existing W2 router, not a duplicate router with a different token middleware.

- [ ] **Step 1: Write the failing test** — production mount test, alongside the other route tests:
```ts
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
const { routes } = vi.hoisted(() => ({ routes: [] as string[] }));
vi.mock('../invoices/autopay', async () => {
  const { Hono } = await import('hono');
  return { invoiceAutopayRoutes: new Hono().patch('/:id/autopay', c => c.json({ mounted: true })) };
});
import { mountAutopayChargingRoutes } from './mount';
it('reaches the registered exclusion path through an app', async () => {
  const app = new Hono();
  const api = new Hono();
  mountAutopayChargingRoutes(api);
  app.route('/api/v1', api);
  const response = await app.request('/api/v1/invoices/10000000-0000-4000-8000-000000000001/autopay',
    { method: 'PATCH', body: JSON.stringify({ excluded: true }), headers: { 'content-type': 'application/json' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ mounted: true });
});
```
Add a second app test with real `invoiceAutopayRoutes`, mocked `authMiddleware`/`requirePermission` in the pattern of `routes/invoices/stripe.test.ts`, and mocks only at the controls boundary. Cases: 401, missing `INVOICES_WRITE` 403, rollout off 404, org/site denial, invalid UUID/JSON 400, processing 409, success 200. Add real public router GET/POST skip cases through its existing W2 production mount: GET calls only resolver/read projection; POST calls skip; wrong purpose, expired/consumed/generation mismatch all 404.

Before changing JSX, add to the existing full-page fixture tests:
```tsx
expect(screen.getByTestId('autopay-invoice-panel')).toBeInTheDocument();
expect(screen.getByTestId('autopay-invoice-excluded')).toBeInTheDocument();
expect(screen.getByTestId('autopay-contract-excluded')).toBeInTheDocument();
```
Use one assertion per owning page test; render the real child in `InvoiceWorkspace.test.tsx`, not a mocked module marker. A switched-off partner fixture asserts the panel/toggle is absent.
In `apps/portal/src/pages/autopay/actions.test.ts`, assert the actual Skip page composition:
```ts
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
it('Skip page hydrates the action module',()=>{
  const source=readFileSync(new URL('./[token]/skip.astro',import.meta.url),'utf8');
  expect(source).toContain('AutopayActionPage');expect(source).toContain('action="skip"');
  expect(source).toContain('client:load');expect(source).toContain('PublicDocumentLayout');
});
```
Component test (portal uses Node by default, so retain the environment directive):
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from '@/lib/api';
vi.mock('@/lib/api', () => ({apiGet:vi.fn(),apiPost:vi.fn()}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import AutopayActionPage from './AutopayActionPage';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('loads a scanner-safe GET and changes state only after an explicit click', async () => {
  vi.mocked(apiGet).mockResolvedValue({data:{state:'scheduled'}});
  render(<AutopayActionPage token="opaque-token" action="skip" />);
  await screen.findByTestId('autopay-skip-submit');
  expect(apiPost).not.toHaveBeenCalled();
  vi.mocked(apiPost).mockResolvedValue({data:{success:true}});
  fireEvent.click(screen.getByTestId('autopay-skip-submit'));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/autopay/public/opaque-token/skip', {},
    {redirectOnUnauthorized:false}));
  expect(await screen.findByTestId('autopay-action-result')).toHaveTextContent('skipped');
});
it('surfaces a rejected skip and retains the action', async () => {
  vi.mocked(apiGet).mockResolvedValue({data:{state:'processing'}});
  vi.mocked(apiPost).mockResolvedValue({error:'A payment is already processing',statusCode:409});
  render(<AutopayActionPage token="opaque-token" action="skip" />);
  fireEvent.click(await screen.findByTestId('autopay-skip-submit'));
  await waitFor(() => expect(screen.getByTestId('autopay-action-result')).toHaveTextContent('already processing'));
  expect(screen.getByTestId('autopay-skip-submit')).toBeEnabled();
});
```
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/routes/autopay/mount.test.ts`; `cd apps/portal && npx vitest run src/pages/autopay/actions.test.ts src/components/portal/AutopayActionPage.test.tsx`; `cd apps/web && npx vitest run src/components/billing/InvoiceDetail.autopay.test.tsx src/components/billing/InvoiceWorkspace.test.tsx src/components/contracts/ContractEditor.test.tsx`.
- [ ] **Step 3: Implement** — complete initial invoice router and production mount:
```ts
// routes/invoices/autopay.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { requireAutopayEnabled } from '../../services/autopay/autopayGate';
import { setInvoiceAutopayExcluded } from '../../services/autopay/invoiceControls';
import { invoiceActorFrom, handleServiceError } from './invoices';
export const invoiceAutopayRoutes = new Hono();
invoiceAutopayRoutes.use('*', authMiddleware);
invoiceAutopayRoutes.patch('/:id/autopay',
  requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action),
  requireAutopayEnabled(), zValidator('param', z.object({ id: z.string().uuid() })),
  zValidator('json', z.object({ excluded: z.boolean() }).strict()), async c => {
    try {
      await db.transaction(tx => setInvoiceAutopayExcluded(tx, c.req.valid('param').id,
        c.req.valid('json').excluded, invoiceActorFrom(c)));
      return c.json({ success: true });
    } catch (error) { return handleServiceError(c, error); }
  });
```
```ts
// routes/autopay/mount.ts
import type { Hono } from 'hono';
import { invoiceAutopayRoutes } from '../invoices/autopay';
export function mountAutopayChargingRoutes(api: Hono): void {
  api.route('/invoices', invoiceAutopayRoutes);
}
```
In `index.ts` import `mountAutopayChargingRoutes` and call `mountAutopayChargingRoutes(api)` immediately before `api.route('/invoices', invoiceRoutes)`, after public invoice/autopay mounts. Register on the existing `api` subapp so partner guard and audit middleware still apply. Source-assert this call in the mount test using `readFileSync(new URL('../../index.ts', import.meta.url), 'utf8')`; the HTTP test and production call assertion together prove the actual composition without importing the booting server.

Append to W2’s public router using its existing token-context/rate-limit/error boundary:
```ts
publicAutopayRoutes.get('/:token/skip', boundary('skip_invoice'), gate, async c => {
  const result = await withSystemDbAccessContext(async () => {
    const link = await resolveBillingLinkToken(db, c.req.param('token'), 'skip_invoice');
    if (!link?.invoiceId) return null;
    const [schedule] = await db.select({ state: invoiceAutopaySchedules.state,
      collectOn: invoiceAutopaySchedules.collectOn }).from(invoiceAutopaySchedules)
      .where(and(eq(invoiceAutopaySchedules.invoiceId, link.invoiceId),
        eq(invoiceAutopaySchedules.orgId, link.orgId),
        eq(invoiceAutopaySchedules.enrollmentGeneration, link.generation!))).limit(1);
    return schedule ?? null;
  });
  return result ? c.json(result) : c.json({ error: 'Link unavailable' }, 404);
});
publicAutopayRoutes.post('/:token/skip', boundary('skip_invoice'), gate, publicJsonPost, async c => {
  const skipped = await withSystemDbAccessContext(() => db.transaction(async tx => {
    const link = await resolveBillingLinkToken(tx,c.req.param('token'),'skip_invoice');
    if(!link?.invoiceId) throw new InvoiceServiceError('Link unavailable',404,'INVOICE_NOT_FOUND');
    await skipInvoice(tx,c.req.param('token'));
    return {invoiceId:link.invoiceId,orgId:link.orgId};
  }));
  await notifyAutopayStaff({orgId:skipped.orgId,partnerId:c.get('autopayIdentity').partnerId,
    event:'autopay.skipped',dedupeKey:`autopay:${skipped.invoiceId}:skipped`,
    message:'The client skipped automatic payment for this invoice.'});
  return c.json({ success: true });
});
```
W2's actual router is `publicAutopayRoutes`. Extend `boundary` and `resolveAutopayLinkIdentity` purpose unions to `'enroll'|'stop_autopay'|'skip_invoice'|'confirm_payment'`, preserving org lifecycle and token-generation validation. Add this middleware in `routes/autopay/public.ts`, importing `portalBase` from `../../services/portalUrl`. It follows the existing JSON admission in `invoicesPublicRoutes` (`routes/invoicesPublic.ts`) and additionally rejects a cross-origin browser request:
```ts
const publicJsonPost: MiddlewareHandler = async (c,next) => {
  if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    return c.json({error:'Invalid request'},400);
  }
  const origin=c.req.header('origin');
  if(origin && origin !== new URL(portalBase()).origin) return c.json({error:'Invalid request'},403);
  c.header('Cache-Control','no-store');c.header('Referrer-Policy','no-referrer');
  return next();
};
```
Use this middleware on confirm POST too. Tokens are still required, so a missing Origin header cannot confer authority. Add app requests asserting form POST is 400, foreign Origin is 403, revoked/deleted-org token is 404, and GET never calls the mutation service. Convert service errors into the established safe public error response; do not return DB/Stripe messages.

Add `autopay` to `getInvoice`’s response using the invoice’s already-authorized ID. Return null when the gate is off and there is no active or unapplied attempt. Preserve a read-only processing/unapplied panel after rollout disable; force `canExclude` and `canChargeNow` false. The gate cannot hide captured money that staff still needs to reconcile. DTO:
```ts
export interface InvoiceAutopayView {
  state: string; reason: string | null; collectOn: string | null;
  noticeSentAt: string | null; excluded: boolean; canExclude: boolean;
  canChargeNow: boolean; processing: boolean; unapplied: boolean;
}
```
Compute `processing` from C3 active attempts, `unapplied` from durable attempt state, and `canExclude` from invoice open state and no active/action-required attempt. `canChargeNow` is false throughout W4a; W4b supplies its authoritative predicate. Never expose tokens, payment-method IDs, or provider credentials in this projection.

Inside `InvoiceDetail` add the mutation handler and panel; `detail.autopay` is typed `InvoiceAutopayView | null`:
```tsx
const setAutopayExcluded = async (excluded: boolean) => {
  try {
    await runAction({ request: () => fetchWithAuth(`/invoices/${invoice.id}/autopay`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ excluded }),
    }), errorFallback: t('autopay.failed'), successMessage: t('autopay.saved') });
    await onChanged();
  } catch (error) { handleActionError(error, t('autopay.failed')); }
};
```
```tsx
{detail.autopay && <section data-testid="autopay-invoice-panel" aria-label={t('autopay.title')}>
  <h3>{t('autopay.title')}</h3>
  <p>{t(`autopay.states.${detail.autopay.state}`, { defaultValue: detail.autopay.state })}</p>
  {detail.autopay.reason && <p>{t(`autopay.reasons.${detail.autopay.reason}`, { defaultValue: detail.autopay.reason })}</p>}
  {detail.autopay.collectOn && <p>{t('autopay.chargeDate', { date: formatDate(detail.autopay.collectOn) })}</p>}
  <label><input type="checkbox" data-testid="autopay-invoice-excluded"
    checked={detail.autopay.excluded} disabled={!can('invoices', 'write') || !detail.autopay.canExclude}
    onChange={event => void setAutopayExcluded(event.target.checked)} />{t('autopay.excludeInvoice')}</label>
</section>}
```
Add `autopayExcluded:boolean` to `ContractSummary`, then render the toggle only when W2’s partner feature flag is true and editable, beside the existing contract billing controls:
```tsx
<label><input type="checkbox" data-testid="autopay-contract-excluded"
  checked={contract.autopayExcluded} disabled={!canWrite}
  onChange={event => void savePatch({ autopayExcluded: event.target.checked }, 'autopayExcluded')} />
  {t('autopay.excludeContract')}
</label>
```
Wrap the label in `{contract && autopayEnabled && (...)}`; `contract` and `canWrite` are existing editor bindings. Add `autopayEnabled?: boolean` to Props and destructure `autopayEnabled = false` in `ContractEditor({detail,presetOrgId,onChanged,autopayEnabled=false}: Props)`. In `getContract` (`contractService.ts`), after `getOwnedContractOr404` add `const autopayEnabled = await isAutopayEnabledForPartner(db,contract.partnerId);` and include `autopayEnabled` in both the site-filtered early return and normal return. Import the C4 gate helper. Add `autopayEnabled: boolean` to `ContractDetail` in `apps/web/src/lib/api/contracts.ts`. The existing loaded editor in `ContractWorkspace` becomes `<ContractEditor detail={detail} autopayEnabled={detail.autopayEnabled} onChanged={() => void load()} />`; the new-contract editor stays default false because there is no persisted contract to exclude. Keep its save pattern and optimistic rollback.

Add English keys under `autopay` in the existing **billing** namespace (ContractEditor uses it), then copy these keys with English values into each existing locale: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`. No `contracts.json` exists. Values: title “Automatic payment”; saved “Automatic payment updated”; noticeQueued “Automatic payment notice queued”; chargeDate “Charge on or around {{date}}”; excludeInvoice “Exclude this invoice from automatic payments”; excludeContract “Exclude invoices containing this contract”; state/reason labels for every C3 value. Extend W2’s Billing & payments group in `EmailTemplatesTab` with `invoice_autopay`; keep the existing row ID `email-template-row-invoice_autopay`.
Consume W2’s portal `runAction<T>({request,onOutcome,successMessage,errorFallback,validate?}): Promise<T|null>` from `apps/portal/src/lib/runAction.ts`. Its request returns `ApiResponse<T>`, not `Response`. Do not create or replace this prerequisite helper. `apiGet` and `apiPost` unwrap the API envelope and retain the portal’s CSRF/origin handling.
```tsx
// AutopayActionPage.tsx
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { navigateTo } from '@/lib/navigation';
import { runAction } from '@/lib/runAction';
type ActionResult = { success?: boolean; url?: string; processing?: boolean; paid?: boolean };
export default function AutopayActionPage({ token, action }: {token:string;action:'skip'|'confirm'}) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const endpoint = `/autopay/public/${encodeURIComponent(token)}/${action}`;
  useEffect(() => {
    let canceled = false;
    setReady(false);
    void apiGet<{state:string}>(endpoint, {redirectOnUnauthorized:false}).then(result => {
      if (canceled) return;
      if (result.data && !result.error) setReady(true);
      else setMessage('This link is unavailable.');
    }).catch(() => { if (!canceled) setMessage('This link is unavailable.'); });
    return () => { canceled = true; };
  }, [endpoint]);
  const submit = async () => {
    setBusy(true);
    const result = await runAction<ActionResult>({
      request: () => apiPost<ActionResult>(endpoint, {}, {redirectOnUnauthorized:false}),
      errorFallback: 'The request could not be completed.',
      successMessage: 'Request completed.',
      onOutcome: (text) => setMessage(text),
    });
    if (result) {
      if (result.url) void navigateTo(result.url);
      else {
        setReady(false);
        setMessage(action === 'skip' ? 'Automatic payment skipped. You can still pay the invoice directly.'
          : result.processing ? 'Payment is processing.' : result.paid ? 'Payment received.' : 'Payment needs billing review.');
      }
    }
    setBusy(false);
  };
  return <main data-testid={`autopay-${action}-page`}>
    <h1>{action === 'skip' ? 'Skip automatic payment' : 'Confirm payment'}</h1>
    <p>{action === 'skip' ? 'This skips automatic payment for this invoice only.'
      : 'Continue to a secure payment page. A payment already processing will not be charged again.'}</p>
    {message && <p role="status" data-testid="autopay-action-result">{message}</p>}
    {ready && <button data-testid={`autopay-${action}-submit`} disabled={busy} onClick={() => void submit()}>
      {action === 'skip' ? 'Skip this invoice' : 'Continue to payment'}
    </button>}
  </main>;
}
```
Create `apps/portal/src/pages/autopay/[token]/skip.astro`:
```astro
---
import PublicDocumentLayout from '../../../layouts/PublicDocumentLayout.astro';
import AutopayActionPage from '../../../components/portal/AutopayActionPage';
const { token } = Astro.params;
---
<PublicDocumentLayout title="Skip automatic payment">
  <AutopayActionPage token={token!} action="skip" client:load />
</PublicDocumentLayout>
```
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/routes/autopay/mount.test.ts`; `cd apps/portal && npx vitest run src/pages/autopay/actions.test.ts src/components/portal/AutopayActionPage.test.tsx`; `cd apps/web && npx vitest run src/components/billing/InvoiceDetail.autopay.test.tsx src/components/billing/InvoiceWorkspace.test.tsx src/components/contracts/ContractEditor.test.tsx`; `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/portal/src/components/portal/AutopayActionPage.tsx apps/portal/src/components/portal/AutopayActionPage.test.tsx 'apps/portal/src/pages/autopay/[token]/skip.astro' apps/portal/src/pages/autopay/actions.test.ts apps/web/src/components/contracts/ContractWorkspace.tsx apps/web/src/lib/api/contracts.ts apps/api/src/routes/invoices/autopay.ts apps/api/src/routes/autopay/mount.ts apps/api/src/routes/autopay/mount.test.ts apps/api/src/routes/autopay/public.ts apps/api/src/index.ts apps/api/src/services/invoiceService.ts apps/web/src/components/billing/InvoiceDetail.tsx apps/web/src/components/billing/invoiceTypes.ts apps/web/src/components/billing/InvoiceDetail.autopay.test.tsx apps/web/src/components/billing/InvoiceWorkspace.test.tsx apps/web/src/components/contracts/ContractEditor.tsx apps/web/src/components/contracts/ContractEditor.test.tsx apps/web/src/lib/api/contracts.ts apps/web/src/components/settings/EmailTemplatesTab.tsx apps/web/src/locales`; `git commit -m "feat(billing): mount autopay exclusion and notice surfaces"`.

**W4a release gate:** the Skip portal page in this task deploys with the notice. Run Task 21’s W4a checks before opening the PR.

### Task 8: Classify failures and compute bounded retry dates (W4b)
**Files:** Create `apps/api/src/services/autopay/failureClassifier.ts`, `apps/api/src/services/autopay/failureClassifier.test.ts`, `apps/api/src/services/autopay/retryDates.ts`, `apps/api/src/services/autopay/retryDates.test.ts`.
**Interfaces:** Produces C4 `classifyCollectionFailure(input: { methodType: AutopayPaymentMethodType; code: string | null; declineCode: string | null; achReturnCode: string | null; piStatus: string }): CollectionFailureClass`, private `retryAt(firstAttempt: Date, failure: Date, failureClass: CollectionFailureClass, attemptCount: number): Date | null`.

- [ ] **Step 1: Write the failing test**:
```ts
import { expect, it } from 'vitest';
import { classifyCollectionFailure } from './failureClassifier';
it.each([
  ['card', 'card_declined', 'insufficient_funds', null, 'requires_payment_method', 'soft'],
  ['card', 'card_declined', 'issuer_not_available', null, 'requires_payment_method', 'soft'],
  ['card', 'card_declined', 'stolen_card', null, 'requires_payment_method', 'hard'],
  ['card', 'expired_card', null, null, 'requires_payment_method', 'hard'],
  ['card', 'authentication_required', null, null, 'requires_payment_method', 'auth_required'],
  ['card', null, null, null, 'requires_action', 'auth_required'],
  ['card', 'card_declined', 'unknown_new_code', null, 'requires_payment_method', 'hard'],
  ['us_bank_account', null, null, 'R01', 'requires_payment_method', 'nsf'],
  ['us_bank_account', null, null, 'R09', 'requires_payment_method', 'nsf'],
  ...['R02','R03','R04','R16','R20'].map(code => ['us_bank_account', null, null, code, 'requires_payment_method', 'hard']),
  ...['R05','R07','R08','R10','R29'].map(code => ['us_bank_account', null, null, code, 'requires_payment_method', 'revoked']),
] as const)('classifies %s/%s/%s/%s', (methodType, code, declineCode, achReturnCode, piStatus, expected) => {
  expect(classifyCollectionFailure({ methodType: methodType as 'card' | 'us_bank_account',
    code, declineCode, achReturnCode, piStatus: piStatus! })).toBe(expected);
});
```
```ts
// retryDates.test.ts
import { expect, it } from 'vitest';
import { retryAt } from './retryDates';
it('anchors card retries on first attempt, not failure arrival', () => {
  const first = new Date('2026-10-01T15:00:00Z');
  expect(retryAt(first, new Date('2026-10-05T12:00Z'), 'soft', 1)?.toISOString()).toBe('2026-10-04T15:00:00.000Z');
  expect(retryAt(first, first, 'soft', 2)?.toISOString()).toBe('2026-10-08T15:00:00.000Z');
  expect(retryAt(first, first, 'soft', 3)).toBeNull();
});
it('skips weekends and Columbus Day for ACH', () => {
  const failed = new Date('2026-10-09T15:00Z');
  expect(retryAt(failed, failed, 'nsf', 1)?.toISOString()).toBe('2026-10-15T15:00:00.000Z');
  expect(retryAt(failed, failed, 'nsf', 2)).toBeNull();
});
it('never retries authentication or revoked authorization', () => {
  for (const kind of ['auth_required', 'revoked', 'hard'] as const) {
    expect(retryAt(new Date(), new Date(), kind, 1)).toBeNull();
  }
});
```
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/failureClassifier.test.ts src/services/autopay/retryDates.test.ts`.
- [ ] **Step 3: Implement**:
```ts
// failureClassifier.ts
import type { AutopayPaymentMethodType, CollectionFailureClass } from '@breeze/shared';
const SOFT = new Set(['insufficient_funds', 'issuer_not_available', 'processing_error', 'try_again_later', 'reenter_transaction']);
const REVOKED = new Set(['R05', 'R07', 'R08', 'R10', 'R29']);
export function classifyCollectionFailure(input: {
  methodType: AutopayPaymentMethodType; code: string | null; declineCode: string | null;
  achReturnCode: string | null; piStatus: string;
}): CollectionFailureClass {
  if (input.piStatus === 'requires_action' || input.code === 'authentication_required'
    || input.declineCode === 'authentication_required') return 'auth_required';
  if (input.methodType === 'us_bank_account') {
    const code = input.achReturnCode?.toUpperCase();
    if (code === 'R01' || code === 'R09') return 'nsf';
    if (code && REVOKED.has(code)) return 'revoked';
    return 'hard';
  }
  return SOFT.has(input.declineCode ?? input.code ?? '') ? 'soft' : 'hard';
}
```
```ts
// retryDates.ts
import type { CollectionFailureClass } from '@breeze/shared';
function nthWeekday(year: number, month: number, weekday: number, ordinal: number): string {
  const day = new Date(Date.UTC(year, month, 1));
  day.setUTCDate(1 + (weekday - day.getUTCDay() + 7) % 7 + 7 * (ordinal - 1));
  return day.toISOString().slice(0, 10);
}
function lastMonday(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month + 1, 0));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}
function bankHoliday(date: Date): boolean {
  const y = date.getUTCFullYear();
  const holidays = new Set([nthWeekday(y,0,1,3), nthWeekday(y,1,1,3), lastMonday(y,4),
    nthWeekday(y,8,1,1), nthWeekday(y,9,1,2), nthWeekday(y,10,4,4)]);
  for (const [month, day] of [[0,1], [5,19], [6,4], [10,11], [11,25]]) {
    const holiday = new Date(Date.UTC(y, month!, day!));
    // Federal Reserve closes Monday for a Sunday holiday; Saturday is already nonbusiness.
    if (holiday.getUTCDay() === 0) holiday.setUTCDate(holiday.getUTCDate() + 1);
    holidays.add(holiday.toISOString().slice(0,10));
  }
  return holidays.has(date.toISOString().slice(0,10));
}
export function retryAt(firstAttempt: Date, failure: Date,
  failureClass: CollectionFailureClass, attemptCount: number): Date | null {
  if (failureClass === 'soft' && attemptCount < 3) {
    const next = new Date(firstAttempt);
    next.setUTCDate(next.getUTCDate() + (attemptCount === 1 ? 3 : 7));
    return next;
  }
  if (failureClass === 'nsf' && attemptCount === 1) {
    const next = new Date(failure);
    let remaining = 3;
    while (remaining > 0) {
      next.setUTCDate(next.getUTCDate() + 1);
      if (next.getUTCDay() !== 0 && next.getUTCDay() !== 6 && !bankHoliday(next)) remaining--;
    }
    return next;
  }
  return null;
}
```
A network error, 429, permission error, or unknown provider response is **not** an outcome for this classifier; leave the same attempt recoverable. Extract ACH return codes from a retrieved Charge’s bank failure details when present; generic unknown bank failures fail closed without guessing R01 from an English message.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/failureClassifier.test.ts src/services/autopay/retryDates.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/failureClassifier.ts apps/api/src/services/autopay/failureClassifier.test.ts apps/api/src/services/autopay/retryDates.ts apps/api/src/services/autopay/retryDates.test.ts`; `git commit -m "feat(billing): classify collection failures and bound retries"`.

### Task 9: Account-bound reconciliation and disconnect fencing (W4b)
**Files:** Modify `apps/api/src/services/partnerStripe.ts`, `apps/api/src/services/stripeCredentialArchive.ts`; Test existing `apps/api/src/services/partnerStripe.test.ts`; Create `apps/api/src/services/stripeCredentialArchive.test.ts` for retention coverage.
**Interfaces:** Preserve one-argument `getPartnerStripeClient(partnerId: string)`; add optional reconciliation options `{ stripeAccountId: string; credentialId?: string | null; invoiceStripePaymentId?: string; reason: string }`. Consumes verified `getSupersededStripeCredential(credentialId, {reason,invoiceStripePaymentId?})` and `findLatestArchivedCredentialForAccount(partnerId,stripeAccountId)` in `stripeCredentialArchive.ts`.

- [ ] **Step 1: Write the failing test** — in the existing partner Stripe fixture suite, test the actual client boundary:
```ts
const { oldStripe, findLatestArchivedCredentialForAccount, getSupersededStripeCredential } = vi.hoisted(() => ({
  oldStripe: { paymentIntents: { retrieve: vi.fn() } },
  findLatestArchivedCredentialForAccount: vi.fn(), getSupersededStripeCredential: vi.fn(),
}));
vi.mock('./stripeCredentialArchive', async importOriginal => ({
  ...(await importOriginal<typeof import('./stripeCredentialArchive')>()),
  findLatestArchivedCredentialForAccount, getSupersededStripeCredential,
}));
it('cannot reinterpret a payment as belonging to the replacement account', async () => {
  dbMocks.selectResults.push([{ status: 'connected', apiKey: 'cipher', stripeAccountId: 'acct_new', defaultCurrency: 'USD' }]);
  findLatestArchivedCredentialForAccount.mockResolvedValue({ id: 'old-credential' });
  getSupersededStripeCredential.mockResolvedValue({ stripe: oldStripe, partnerId: PARTNER_A, stripeAccountId: 'acct_old' });
  const result = await getPartnerStripeClient(PARTNER_A, { stripeAccountId: 'acct_old', reason: 'autopay_reconcile' });
  expect(result.stripe).toBe(oldStripe);
  expect(result.stripeAccountId).toBe('acct_old');
});
```
Use the suite’s hoisted mocks for these imported archive functions. Add cases: active enrollment/no payments blocks account switch; same-account reconnect clears only Stripe-related attention; unusable method attention remains; a revoked key refuses new attempts; archived credential mismatch throws. Retention test seeds an unresolved reserved attempt without a mapping and asserts `eraseExpiredStripeCredentials` does not erase its matching account credential, including after 400 days.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/partnerStripe.test.ts src/services/stripeCredentialArchive.test.ts`.
- [ ] **Step 3: Implement** — before the existing live-key guard in `getPartnerStripeClient`, insert this branch and extend its signature with the options above:
```ts
if (reconciliation && (reconciliation.credentialId || !row?.apiKey
  || row.status !== 'connected' || row.stripeAccountId !== reconciliation.stripeAccountId)) {
  const credentialId = reconciliation.credentialId ??
    (await findLatestArchivedCredentialForAccount(partnerId, reconciliation.stripeAccountId))?.id;
  if (!credentialId) throw new PartnerStripeError('Original Stripe credential unavailable', 'NO_STRIPE_KEY');
  const archived = await getSupersededStripeCredential(credentialId, {
    reason: reconciliation.reason, invoiceStripePaymentId: reconciliation.invoiceStripePaymentId,
  });
  if (archived.partnerId !== partnerId || archived.stripeAccountId !== reconciliation.stripeAccountId) {
    throw new PartnerStripeError('Stripe account mismatch', 'STRIPE_CONNECTION_CHANGED');
  }
  return { stripe: archived.stripe, stripeAccountId: archived.stripeAccountId, defaultCurrency: null };
}
```
Leave live decryption/auditing and API version pin intact. New money always uses the one-argument form; archival access is reconciliation-only.

In the locked account-switch branch of `savePartnerStripeKey`, add the enrollment condition to the existing “payments exist” block:
```ts
const [activeEnrollment] = await db.select({ id: orgAutopayEnrollments.id }).from(orgAutopayEnrollments)
  .where(and(eq(orgAutopayEnrollments.partnerId, input.partnerId), eq(orgAutopayEnrollments.status, 'active'))).limit(1);
if (activeEnrollment && current.stripeAccountId !== accountId) {
  throw new PartnerStripeError('Turn off automatic payments before changing Stripe accounts.', 'STRIPE_ACCOUNT_CHANGE_BLOCKED');
}
```
Place this code inside the existing `if (current && current.stripeAccountId !== accountId)` block in `savePartnerStripeKey`. It uses the existing `STRIPE_ACCOUNT_CHANGE_BLOCKED` error code. On disconnect or confirmed missing permissions, set affected enrollments’ `needsAttentionReason` to `stripe_account_changed` or `key_missing_permissions` without deleting customer/method/account identity. Preserve generation and all active attempts. Reconnect only clears these two reasons for matching account + successful probes; it never clears `method_unusable` or restores removed methods.

Extend `archiveSupersededCredential`’s mapping pin predicate to `(checkout_session pending) OR (payment_intent unresolved)`. Extend `eraseExpiredStripeCredentials` with this SQL guard **outside** its age/hard-cap OR, so the hard cap cannot override it:
```ts
sql`NOT EXISTS (
  SELECT 1 FROM invoice_collection_attempts a
  JOIN org_payment_methods m ON m.id = a.payment_method_id
  JOIN org_autopay_enrollments e ON e.id = m.enrollment_id
  WHERE e.partner_id = ${stripeConnectCredentials.partnerId}
    AND e.stripe_account_id = ${stripeConnectCredentials.stripeAccountId}
    AND a.state IN ('reserved','created','confirming','processing','requires_action','unapplied')
)`
```
For mapped attempts use `invoice_stripe_payments.stripe_account_id` as the primary account binding; the enrollment join covers reserved attempts without mappings. Preserve W1’s required retention for late returns after resolved captures. Key destruction by Stripe itself remains an operational blocker: show attention and keep ledger evidence; an archived ciphertext cannot make a revoked key valid.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/partnerStripe.test.ts src/services/stripeCredentialArchive.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/partnerStripe.ts apps/api/src/services/partnerStripe.test.ts apps/api/src/services/stripeCredentialArchive.ts apps/api/src/services/stripeCredentialArchive.test.ts`; `git commit -m "fix(billing): retain original Stripe authority for in-flight payments"`.

### Task 10: Revoke Checkout and reserve under the invoice lock (W4b)
**Files:** Create `apps/api/src/services/autopay/collectionEngine.ts`, `apps/api/src/services/autopay/collectionEngine.test.ts`; Modify `apps/api/src/services/stripeSessionRevocation.ts`.
**Interfaces:** Consumes C4 `lockInvoiceForCollection(tx: Tx, invoiceId: string): Promise<LockedInvoiceForCollection>` and readiness/settings/method/fee helpers; produces private `reserveCollection(input: CollectionInput): Promise<CollectionResult | { attempt: typeof invoiceCollectionAttempts.$inferSelect }>`; C4 `attemptCollection` is completed in Task 11. `CollectionInput` and `CollectionResult` preserve C4 exactly.

- [ ] **Step 1: Write the failing test** — first assertions in the new collection suite:
```ts
import { expect, it, vi } from 'vitest';
const { client } = vi.hoisted(() => ({ client: vi.fn() }));
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: client }));
import { collectionNoticeAllows } from './collectionEngine';
it('requires actual delivery and the full ACH notice period for charge-now', () => {
  expect(collectionNoticeAllows(null, 10, new Date('2026-10-20T00:00Z'))).toBe(false);
  expect(collectionNoticeAllows(new Date('2026-10-01T23:59Z'), 10, new Date('2026-10-10T23:59Z'))).toBe(false);
  expect(collectionNoticeAllows(new Date('2026-10-01T23:59Z'), 10, new Date('2026-10-11T23:59Z'))).toBe(true);
  expect(client).not.toHaveBeenCalled();
});
```
The DB race assertion belongs in Task 20 and must fail before this reservation code is implemented: start pay-link insertion between revocation and invoice lock, assert outcome deferred and zero PI create calls. Run it with revocation mode observe as well as enforce.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/collectionEngine.test.ts`; module missing.
- [ ] **Step 3: Implement** — complete reservation stage, retaining integer minor units:
```ts
import { and, eq, inArray, isNull, sql, asc, lte, or, gt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { invoices, invoiceLines, contracts, organizations, orgAutopayEnrollments, orgPaymentMethods,
  invoiceAutopaySchedules, invoiceCollectionAttempts, invoiceStripePayments } from '../../db/schema';
import type { CollectionAttemptInitiator } from '@breeze/shared';
import { toMinorUnits, fromMinorUnits } from '../stripeMoney';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import { requestInvoiceSessionRevocation } from '../stripeSessionRevocation';
import { lockInvoiceForCollection } from './reservation';
import { getAutopayMethod } from './paymentMethods';
import { isAutopayEnabledForPartner } from './autopayGate';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { quoteProcessingFee } from './processingFee';
import { noticeLeadDays, computeCollectOn } from './scheduler';
import { enqueueAutopayNotice, type AutopayTerms } from './chargingNotice';
export type CollectionInput = { invoiceId: string; initiatedBy: CollectionAttemptInitiator; scheduleId?: string };
export type CollectionResult = { attemptId: string | null; outcome: 'created' | 'deferred' | 'refused'; reason?: string };
export function collectionNoticeAllows(sentAt: Date | null, lead: number, now: Date): boolean {
  return !!sentAt && now.getTime() >= sentAt.getTime() + lead * 86_400_000;
}
export async function reserveCollection(input: CollectionInput)
  : Promise<CollectionResult | { attempt: typeof invoiceCollectionAttempts.$inferSelect }> {
  return withSystemDbAccessContext(async () => {
    const locked = await lockInvoiceForCollection(db, input.invoiceId);
    const invoice = locked.invoice;
    const defer = (reason: string): CollectionResult => ({ attemptId: null, outcome: 'deferred', reason });
    const refuse = (reason: string): CollectionResult => ({ attemptId: null, outcome: 'refused', reason });
    if (!['sent','partially_paid','overdue'].includes(invoice.status)) return refuse('not_payable');
    if (toMinorUnits(locked.unreservedBalance, invoice.currencyCode) <= 0) return refuse('nothing_to_pay');
    if (toMinorUnits(locked.reservedAmount, invoice.currencyCode) > 0) return defer('collection_in_progress');
    const [unrevoked] = await db.select({ id: invoiceStripePayments.id }).from(invoiceStripePayments).where(and(
      eq(invoiceStripePayments.invoiceId, invoice.id), eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.status, 'pending'), isNull(invoiceStripePayments.invoicePaymentId),
      sql`${invoiceStripePayments.revocationState} <> 'revoked'`,
    )).limit(1);
    if (unrevoked) return defer('checkout_session_unrevoked');
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1).for('update');
    if (!enrollment || enrollment.status !== 'active') return refuse('enrollment_inactive');
    if (!await isAutopayEnabledForPartner(db, invoice.partnerId)) return refuse('charging_disabled');
    const readiness = await getAutopayStripeReadiness(db, invoice.partnerId);
    if (!readiness.ready || readiness.stripeAccountId !== enrollment.stripeAccountId) return refuse('stripe_unavailable');
    const method = await getAutopayMethod(db, invoice.orgId);
    if (!method || method.status !== 'active' || method.enrollmentId !== enrollment.id) return defer('method_not_usable');
    if (method.type === 'us_bank_account' && (invoice.currencyCode !== 'USD' || !method.accountHolderType)) {
      return refuse('ach_currency_unsupported');
    }
    const [schedule] = input.scheduleId ? await db.select().from(invoiceAutopaySchedules).where(and(
      eq(invoiceAutopaySchedules.id, input.scheduleId), eq(invoiceAutopaySchedules.invoiceId, invoice.id),
      eq(invoiceAutopaySchedules.orgId, invoice.orgId),
    )).limit(1).for('update') : [];
    if (input.initiatedBy !== 'client_on_session' && !schedule) return refuse('schedule_required');
    if (input.initiatedBy === 'client_on_session' && input.scheduleId) return refuse('unexpected_schedule');
    if (schedule && (!schedule.eligible || !['scheduled','retry_scheduled'].includes(schedule.state)
      || schedule.enrollmentGeneration !== enrollment.generation || invoice.autopayExcluded)) return refuse('schedule_inactive');
    if (schedule) {
      const [excluded] = await db.select({ id: contracts.id }).from(invoiceLines).innerJoin(contracts,
        and(eq(invoiceLines.sourceContractId, contracts.id), eq(invoiceLines.orgId, contracts.orgId)))
        .where(and(eq(invoiceLines.invoiceId, invoice.id), eq(contracts.autopayExcluded, true))).limit(1);
      if (excluded) {
        await db.update(invoiceAutopaySchedules).set({ state: 'excluded_by_msp', stateReason: 'excluded_contract' })
          .where(eq(invoiceAutopaySchedules.id, schedule.id));
        return refuse('excluded_contract');
      }
    }
    const settings = await resolveBillingPaymentSettings(db, { partnerId: invoice.partnerId, orgId: invoice.orgId });
    const [org] = await db.select().from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
    const terms = schedule?.termsSnapshot as AutopayTerms | undefined;
    const principalMinor = terms ? Math.min(toMinorUnits(locked.unreservedBalance, invoice.currencyCode),
      toMinorUnits(terms.principal, invoice.currencyCode)) : toMinorUnits(locked.unreservedBalance, invoice.currencyCode);
    const principal = fromMinorUnits(principalMinor, invoice.currencyCode);
    const quote = quoteProcessingFee({ methodType: method.type, cardFunding: method.cardFunding,
      principal, currency: invoice.currencyCode, stripeAccountCountry: readiness.accountCountry,
      orgBillingCountry: org!.billingAddressCountry, orgBillingRegion: org!.billingAddressRegion,
      cardFeeBps: settings.cardFeeBps.value, achFeeAmount: settings.achFeeAmount.value, feeAttested: settings.feeAttested });
    if (terms && (terms.methodType !== method.type || terms.noticeLeadDays !== noticeLeadDays(method)
      || (terms.methodId !== method.id && toMinorUnits(quote.feeAmount, invoice.currencyCode) !== toMinorUnits(terms.feeAmount, invoice.currencyCode))
      || terms.cardFeeBps !== settings.cardFeeBps.value || terms.achFeeAmount !== settings.achFeeAmount.value
      || toMinorUnits(quote.feeAmount, invoice.currencyCode) > toMinorUnits(terms.feeAmount, invoice.currencyCode))) {
      const collectOn = computeCollectOn({ issueDate: invoice.issueDate!, dueDate: invoice.dueDate!,
        offsetDays: terms.offsetDays, rule: terms.rule, noticeDate: new Date().toISOString().slice(0,10),
        leadDays: noticeLeadDays(method) });
      await db.update(invoiceAutopaySchedules).set({ state: 'awaiting_notice', noticeSentAt: null,
        noticeOutboxId: null, collectOn, termsSnapshot: { ...terms, methodId: method.id, methodType: method.type,
          last4: method.cardLast4 ?? method.bankLast4 ?? '',
          methodLabel: `${method.cardBrand ?? method.bankName ?? 'Payment method'} ••${method.cardLast4 ?? method.bankLast4 ?? ''}`,
          accountHolderType: method.accountHolderType, noticeLeadDays: noticeLeadDays(method),
          principal, feeAmount: quote.feeAmount, feeKind: quote.kind, cardFeeBps: settings.cardFeeBps.value,
          achFeeAmount: settings.achFeeAmount.value, chargeDate: collectOn, noticeSeq: terms.noticeSeq + 1 } })
        .where(eq(invoiceAutopaySchedules.id, schedule!.id));
      await enqueueAutopayNotice(db, schedule!.id);
      return defer('renotice_required');
    }
    if (schedule && !collectionNoticeAllows(schedule.noticeSentAt, terms!.noticeLeadDays, new Date())) return defer('notice_lead');
    if (schedule?.state === 'retry_scheduled' && schedule.nextAttemptAt && schedule.nextAttemptAt > new Date()) return defer('retry_not_due');
    const feeMinor = Math.min(toMinorUnits(quote.feeAmount, invoice.currencyCode),
      terms ? toMinorUnits(terms.feeAmount, invoice.currencyCode) : Number.MAX_SAFE_INTEGER);
    const [ordinal] = await db.select({ n: sql<number>`coalesce(max(${invoiceCollectionAttempts.attemptNo}),0)::int` })
      .from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.invoiceId, invoice.id));
    const attemptNo = schedule ? schedule.attemptCount + 1 : (ordinal?.n ?? 0) + 1;
    const [attempt] = await db.insert(invoiceCollectionAttempts).values({ orgId: invoice.orgId,
      invoiceId: invoice.id, scheduleId: schedule?.id ?? null, attemptNo, paymentMethodId: method.id,
      idempotencyKey: schedule ? `autopay_${schedule.id}_${attemptNo}` : `autopay_client_${invoice.id}_${attemptNo}`,
      principalAmount: principal, feeAmount: fromMinorUnits(feeMinor, invoice.currencyCode),
      currency: invoice.currencyCode, state: 'reserved', initiatedBy: input.initiatedBy }).returning();
    if (schedule) await db.update(invoiceAutopaySchedules).set({ state: 'collecting', attemptCount: attemptNo })
      .where(eq(invoiceAutopaySchedules.id, schedule.id));
    return { attempt: attempt! };
  }, 'autopay.reserve');
}
```
Add `'autopay_collection'` to `RevocationReason` in `stripeSessionRevocation.ts`. Authorization must finish before invoking revocation; it runs under system scope. C4’s service signature cannot accept an actor, so routes prove invoice scope before calling it, and the scheduler derives IDs only from trusted DB rows.

Do not carry a DB transaction through the outer invocation. The row lock is also taken by W1’s manual/import/Checkout producer paths. An open Checkout reserves no money, but its unresolved mapping prevents autopay from reserving. Do not trust a prior revocation summary alone.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/collectionEngine.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/collectionEngine.ts apps/api/src/services/autopay/collectionEngine.test.ts apps/api/src/services/stripeSessionRevocation.ts`; `git commit -m "feat(billing): reserve autopay only after locked Checkout recheck"`.

### Task 11: Create, persist, confirm, and recover one PaymentIntent (W4b)
**Files:** Modify `apps/api/src/services/autopay/collectionEngine.ts`; Test `apps/api/src/services/autopay/collectionEngine.test.ts` and real-DB crash case in `apps/api/src/services/autopay/charging.integration.test.ts` (Task 20).
**Interfaces:** Produces C4 `attemptCollection(input: { invoiceId: string; initiatedBy: CollectionAttemptInitiator; scheduleId?: string }): Promise<{ attemptId: string | null; outcome: 'created' | 'deferred' | 'refused'; reason?: string }>` and private `resumeCollectionAttempt(attemptId: string): Promise<void>`; consumes C4 `applyAttemptOutcome(partnerId: string, attemptId: string): Promise<void>` defined in Task 12.

- [ ] **Step 1: Write the failing test** — assert provider parameters at the required boundary:
```ts
import { paymentIntentCreateParams } from './collectionEngine';
it('creates unconfirmed with principal and fee metadata, never confirms before mapping', () => {
  const params = paymentIntentCreateParams({ id: '10000000-0000-4000-8000-000000000001',
    invoiceId: '20000000-0000-4000-8000-000000000001', orgId: '30000000-0000-4000-8000-000000000001',
    principalAmount: '100.00', feeAmount: '2.50', currency: 'USD' } as never,
    'cus_test', 'pm_test', '40000000-0000-4000-8000-000000000001', 'card');
  expect(params).toMatchObject({ amount: 10250, currency: 'usd', customer: 'cus_test',
    payment_method: 'pm_test', confirm: false, metadata: { principal_minor: '10000', fee_minor: '250' } });
  expect(params).not.toHaveProperty('off_session');
});
```
In the mocked-client orchestration case, `create` records a call, the mapping insert rejects, and `confirm` must have zero calls; retry returns the same PI for the same key. A second case throws after Stripe accepted confirm; retry retrieves and applies success without a second create. A 24-hour missing-ID case neither creates nor releases the reservation.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/collectionEngine.test.ts`.
- [ ] **Step 3: Implement** — append this stage to `collectionEngine.ts`:
```ts
import type Stripe from 'stripe';
import { getPartnerStripeClient } from '../partnerStripe';
export function paymentIntentCreateParams(attempt: typeof invoiceCollectionAttempts.$inferSelect,
  customer: string, method: string, partnerId: string, methodType: 'card' | 'us_bank_account'): Stripe.PaymentIntentCreateParams {
  const principal = toMinorUnits(attempt.principalAmount, attempt.currency);
  const fee = toMinorUnits(attempt.feeAmount, attempt.currency);
  return { amount: principal + fee, currency: attempt.currency.toLowerCase(), customer,
    payment_method: method, payment_method_types: [methodType], confirm: false,
    metadata: { invoice_id: attempt.invoiceId, org_id: attempt.orgId, partner_id: partnerId,
      attempt_id: attempt.id, principal_minor: String(principal), fee_minor: String(fee) } };
}
export async function loadAttempt(attemptId: string) {
  return withSystemDbAccessContext(async () => {
    const [attempt] = await db.select().from(invoiceCollectionAttempts)
      .where(eq(invoiceCollectionAttempts.id, attemptId)).limit(1);
    if (!attempt) throw new Error('Collection attempt not found');
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, attempt.invoiceId)).limit(1);
    const [method] = await db.select().from(orgPaymentMethods).where(eq(orgPaymentMethods.id, attempt.paymentMethodId)).limit(1);
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.id, method!.enrollmentId)).limit(1);
    const [mapping] = attempt.invoiceStripePaymentId ? await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.id, attempt.invoiceStripePaymentId)).limit(1) : [];
    if (!invoice || !method || !enrollment || invoice.orgId !== method.orgId || enrollment.orgId !== invoice.orgId) {
      throw new Error('Collection authority mismatch');
    }
    return { attempt, invoice, method, enrollment, mapping };
  }, 'autopay.loadAttempt');
}
export async function resumeCollectionAttempt(attemptId: string): Promise<void> {
  assertNoHeldDbContextForStripe('resumeCollectionAttempt');
  let data = await loadAttempt(attemptId);
  if (!['reserved','created','confirming'].includes(data.attempt.state)) {
    await applyAttemptOutcome(data.invoice.partnerId, attemptId);
    return;
  }
  if (!data.attempt.stripePaymentIntentId && Date.now() - data.attempt.createdAt.getTime() >= 23 * 3_600_000) {
    await withSystemDbAccessContext(async () => {
      if (data.attempt.scheduleId) await db.update(invoiceAutopaySchedules).set({ stateReason: 'provider_create_unknown' })
        .where(eq(invoiceAutopaySchedules.id, data.attempt.scheduleId));
    });
    return; // Reservation intentionally retained; attention notification is Task 14.
  }
  const { stripe } = await withSystemDbAccessContext(() => getPartnerStripeClient(data.invoice.partnerId, {
    stripeAccountId: data.mapping?.stripeAccountId ?? data.enrollment.stripeAccountId,
    credentialId: data.mapping?.revocationCredentialId,
    invoiceStripePaymentId: data.mapping?.id, reason: 'autopay_recovery',
  }));
  let pi: Stripe.PaymentIntent;
  if (data.attempt.stripePaymentIntentId) {
    pi = await runOutsideDbContext(() => stripe.paymentIntents.retrieve(data.attempt.stripePaymentIntentId!));
  } else {
    pi = await runOutsideDbContext(() => stripe.paymentIntents.create(paymentIntentCreateParams(data.attempt,
      data.enrollment.stripeCustomerId!, data.method.stripePaymentMethodId, data.invoice.partnerId, data.method.type),
    { idempotencyKey: data.attempt.idempotencyKey }));
    await withSystemDbAccessContext(async () => {
      await lockInvoiceForCollection(db, data.attempt.invoiceId);
      const [mapping] = await db.insert(invoiceStripePayments).values({ orgId: data.attempt.orgId,
        invoiceId: data.attempt.invoiceId, stripeAccountId: data.enrollment.stripeAccountId,
        stripeObjectType: 'payment_intent', stripeObjectId: pi.id, stripePaymentIntentId: pi.id,
        amount: data.attempt.principalAmount, feeAmount: data.attempt.feeAmount, currency: data.attempt.currency,
        source: 'autopay', paymentMethodType: data.method.type, status: 'pending',
      }).onConflictDoNothing({ target: invoiceStripePayments.stripeObjectId }).returning();
      const [existing] = mapping ? [mapping] : await db.select().from(invoiceStripePayments)
        .where(eq(invoiceStripePayments.stripeObjectId, pi.id)).limit(1);
      if (!existing || existing.invoiceId !== data.attempt.invoiceId || existing.orgId !== data.attempt.orgId) {
        throw new Error('PaymentIntent mapping conflict');
      }
      await db.update(invoiceCollectionAttempts).set({ stripePaymentIntentId: pi.id,
        invoiceStripePaymentId: existing.id, state: 'created', updatedAt: new Date() })
        .where(and(eq(invoiceCollectionAttempts.id, attemptId), eq(invoiceCollectionAttempts.state, 'reserved')));
    }, 'autopay.persistIntent');
  }
  data = await loadAttempt(attemptId);
  if (pi.status !== 'requires_confirmation') {
    await applyAttemptOutcome(data.invoice.partnerId, attemptId);
    return;
  }
  const decision = await withSystemDbAccessContext(async () => {
    const locked = await lockInvoiceForCollection(db, data.attempt.invoiceId);
    const [currentAttempt] = await db.select().from(invoiceCollectionAttempts)
      .where(eq(invoiceCollectionAttempts.id, attemptId)).limit(1).for('update');
    if (!currentAttempt || !['created','confirming'].includes(currentAttempt.state)) return 'done' as const;
    const method = await getAutopayMethod(db, data.invoice.orgId);
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.id, data.enrollment.id)).limit(1).for('update');
    const readiness = await getAutopayStripeReadiness(db, data.invoice.partnerId);
    const [schedule] = data.attempt.scheduleId ? await db.select().from(invoiceAutopaySchedules)
      .where(eq(invoiceAutopaySchedules.id, data.attempt.scheduleId)).limit(1) : [];
    const valid = ['sent','partially_paid','overdue'].includes(locked.invoice.status)
      && toMinorUnits(locked.invoice.balance, locked.invoice.currencyCode) >= toMinorUnits(currentAttempt.principalAmount, currentAttempt.currency)
      && enrollment?.status === 'active' && method?.id === data.method.id && method.status === 'active'
      && (!schedule || (schedule.state === 'collecting' && schedule.enrollmentGeneration === enrollment.generation))
      && await isAutopayEnabledForPartner(db, data.invoice.partnerId)
      && readiness.ready && readiness.stripeAccountId === data.enrollment.stripeAccountId;
    if (valid) await db.update(invoiceCollectionAttempts).set({ state: 'confirming', updatedAt: new Date() })
      .where(eq(invoiceCollectionAttempts.id, attemptId));
    return valid ? 'confirm' as const : 'cancel' as const;
  }, 'autopay.beforeConfirm');
  if (decision === 'done') return;
  if (decision === 'cancel') {
    const canceled = await runOutsideDbContext(() => stripe.paymentIntents.cancel(pi.id));
    if (canceled.status !== 'canceled') throw new Error('Stripe has not canceled the attempt');
    await withSystemDbAccessContext(async () => {
      await lockInvoiceForCollection(db, data.attempt.invoiceId);
      await db.update(invoiceCollectionAttempts).set({ state: 'canceled', updatedAt: new Date() })
        .where(and(eq(invoiceCollectionAttempts.id, attemptId),
          inArray(invoiceCollectionAttempts.state, ['reserved','created','confirming'])));
    });
    return;
  }
  try {
    await runOutsideDbContext(() => stripe.paymentIntents.confirm(pi.id,
      { off_session: data.attempt.initiatedBy !== 'client_on_session' },
      { idempotencyKey: `${data.attempt.idempotencyKey}_confirm` }));
  } catch (error) {
    // Card refusals are HTTP errors with a durable PI outcome; transport failures are retried by retrieval.
    const provider = error as { payment_intent?: unknown; type?: string };
    if (!provider.payment_intent && provider.type !== 'StripeCardError') throw error;
  }
  await applyAttemptOutcome(data.invoice.partnerId, attemptId);
}
export async function attemptCollection(input: CollectionInput): Promise<CollectionResult> {
  assertNoHeldDbContextForStripe('attemptCollection');
  const revocation = await requestInvoiceSessionRevocation({ invoiceId: input.invoiceId,
    reason: 'autopay_collection', requestedByUserId: null });
  if (revocation.charged || revocation.blocked || revocation.stillPending) {
    return { attemptId: null, outcome: 'deferred', reason: 'checkout_session_unrevoked' };
  }
  const reserved = await reserveCollection(input);
  if (!('attempt' in reserved)) return reserved;
  await resumeCollectionAttempt(reserved.attempt.id);
  return { attemptId: reserved.attempt.id, outcome: 'created' };
}
```
**Confirmation boundary:** once the attempt is committed `confirming`, it is in flight. Stop prevents subsequent attempts and leaves this one reconcilable; it cannot promise to recall a debit whose confirmation already started. Recheck active method/account/generation before the `created → confirming` write, and do not downgrade an attempt already settled by another worker. All local attempt writes acquire the invoice lock and use state predicates. A provider-confirm result cannot overwrite `succeeded`/`unapplied` with a stale status.

**Stripe API refinement:** set `off_session` on `paymentIntents.confirm`, not unconfirmed create; create accepts it only with `confirm=true`. This deliberately corrects the literal §7.3 wording while preserving its durable mapping-before-charge requirement. Source: [Stripe PaymentIntent create](https://docs.stripe.com/api/payment_intents/create). The 23-hour quarantine leaves margin inside [Stripe’s idempotency retention](https://docs.stripe.com/api/idempotent_requests); it is not a claim of unlimited provider deduplication.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/collectionEngine.test.ts`; run Task 20’s crash test once its DB fixture is in place.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/collectionEngine.ts apps/api/src/services/autopay/collectionEngine.test.ts`; `git commit -m "feat(billing): persist intents before confirm and recover stable attempts"`.

### Task 12: Apply authoritative outcomes without losing captured money (W4b)
**Files:** Modify `apps/api/src/services/autopay/collectionEngine.ts`, `apps/api/src/services/stripeReconcile.ts`; Test `apps/api/src/services/autopay/collectionEngine.test.ts`, `apps/api/src/services/stripeReconcile.test.ts`.
**Interfaces:** Produces C4 `applyAttemptOutcome(partnerId: string, attemptId: string): Promise<void>`; consumes C4 `settlePaymentIntent(partnerId: string, paymentIntentId: string): Promise<{ settled: boolean; status: Stripe.PaymentIntent.Status; invoiceId: string | null }>`, `markPaymentMethodUnusable(tx: Tx, methodId: string, reason: string): Promise<void>`; private `enqueueAttemptNotice` and `notifyPaymentAttention` are defined completely in Tasks 13–14.

- [ ] **Step 1: Write the failing test** — table-test the state reducer before adding network orchestration:
```ts
import { outcomeState } from './collectionEngine';
it.each([
  ['processing', null, 'processing'], ['requires_action', null, 'requires_action'],
  ['requires_payment_method', 'authentication_required', 'requires_action'],
  ['requires_payment_method', 'card_declined', 'failed'], ['canceled', null, 'canceled'],
  ['succeeded', null, 'succeeded'], ['requires_confirmation', null, 'created'],
] as const)('%s produces %s', (status, code, expected) => {
  expect(outcomeState(status, code)).toBe(expected);
});
```
In the `getPartnerStripeClient`-mocked orchestration case return PI `succeeded`, mock W1 settlement to return `settled:true`, then supply a mapping with no `invoicePaymentId` and status `failed`. Assert attempt `unapplied`, schedule `failed` with `stateReason='payment_unapplied'`, one `payment.unapplied` notice, zero `payment_failed` and zero receipt. Replay the same outcome; notification dedupe key remains unchanged. The real refusal path is mandatory in Task 20, not replaced by this mock.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/collectionEngine.test.ts src/services/stripeReconcile.test.ts`.
- [ ] **Step 3: Implement** — append to the engine:
```ts
import { settlePaymentIntent } from '../stripeSettle';
import { classifyCollectionFailure } from './failureClassifier';
import { retryAt } from './retryDates';
import { markPaymentMethodUnusable } from './paymentMethods';
import { enqueueAttemptNotice, notifyPaymentAttention } from './paymentNotices';
export function outcomeState(status: string, code: string | null) {
  if (status === 'succeeded') return 'succeeded' as const;
  if (status === 'processing') return 'processing' as const;
  if (status === 'canceled') return 'canceled' as const;
  if (status === 'requires_action' || code === 'authentication_required') return 'requires_action' as const;
  if (status === 'requires_confirmation') return 'created' as const;
  return 'failed' as const;
}
export async function readProviderFailure(stripe: Stripe, pi: Stripe.PaymentIntent,
  methodType: 'card' | 'us_bank_account') {
  const charge = methodType === 'us_bank_account' && pi.last_payment_error && pi.latest_charge
    ? typeof pi.latest_charge === 'string'
      ? await runOutsideDbContext(() => stripe.charges.retrieve(pi.latest_charge as string))
      : pi.latest_charge : null;
  const code = pi.last_payment_error?.code ?? charge?.failure_code ?? null;
  const declineCode = pi.last_payment_error?.decline_code ?? charge?.outcome?.reason ?? null;
  const network = (charge?.outcome as {network_decline_code?:string|null}|null)?.network_decline_code;
  const raw = [network, code, declineCode].find(value => typeof value === 'string' && /^R\d{2}$/.test(value));
  // Older Stripe API versions may supply only the documented normalized code.
  const normalized: Record<string,string> = {insufficient_funds:'R01',bank_account_closed:'R02',
    bank_account_invalid_details:'R03',debit_not_authorized:'R07',bank_account_frozen:'R16',bank_account_restricted:'R20'};
  return {code,declineCode,achReturnCode:methodType === 'us_bank_account'
    ? raw ?? normalized[declineCode ?? code ?? ''] ?? null : null};
}
export async function applyAttemptOutcome(partnerId: string, attemptId: string): Promise<void> {
  assertNoHeldDbContextForStripe('applyAttemptOutcome');
  const data = await loadAttempt(attemptId);
  if (data.invoice.partnerId !== partnerId) throw new Error('Attempt partner mismatch');
  if (!data.attempt.stripePaymentIntentId || data.attempt.failureCode === 'unapplied_refunded') return;
  const accountId = data.mapping?.stripeAccountId ?? data.enrollment.stripeAccountId;
  const { stripe } = await withSystemDbAccessContext(() => getPartnerStripeClient(partnerId, {
    stripeAccountId: accountId, credentialId: data.mapping?.revocationCredentialId,
    invoiceStripePaymentId: data.mapping?.id, reason: 'autopay_outcome',
  }));
  const pi = await runOutsideDbContext(() => stripe.paymentIntents.retrieve(data.attempt.stripePaymentIntentId!));
  if (pi.metadata.attempt_id !== attemptId || pi.metadata.invoice_id !== data.invoice.id
    || pi.metadata.org_id !== data.invoice.orgId || pi.metadata.partner_id !== partnerId
    || pi.currency.toUpperCase() !== data.attempt.currency
    || pi.amount !== toMinorUnits(data.attempt.principalAmount, data.attempt.currency)
      + toMinorUnits(data.attempt.feeAmount, data.attempt.currency)) throw new Error('PaymentIntent binding mismatch');
  const failure = await readProviderFailure(stripe, pi, data.method.type);
  const state = outcomeState(pi.status, failure.code);
  if (state === 'created') return; // Recovery owns confirmation; outcome application cannot start money.
  if (state === 'succeeded') await settlePaymentIntent(partnerId, pi.id);
  const event = await withSystemDbAccessContext(async () => {
    await lockInvoiceForCollection(db, data.invoice.id);
    const [attempt] = await db.select().from(invoiceCollectionAttempts)
      .where(eq(invoiceCollectionAttempts.id, attemptId)).limit(1).for('update');
    if (!attempt) throw new Error('Attempt disappeared');
    if (attempt.failureCode === 'unapplied_refunded') return null;
    if (['succeeded', 'unapplied'].includes(attempt.state) && state !== 'succeeded') return null;
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.id, attempt.invoiceStripePaymentId!)).limit(1);
    const [schedule] = attempt.scheduleId ? await db.select().from(invoiceAutopaySchedules)
      .where(eq(invoiceAutopaySchedules.id, attempt.scheduleId)).limit(1).for('update') : [];
    const [enrollment] = await db.select().from(orgAutopayEnrollments)
      .where(eq(orgAutopayEnrollments.id, data.enrollment.id)).limit(1);
    const mayAdvance = !!schedule && schedule.attemptCount === attempt.attemptNo
      && schedule.enrollmentGeneration === enrollment?.generation && enrollment.status === 'active'
      && ['collecting','retry_scheduled','action_required'].includes(schedule.state);
    if (state !== 'succeeded' && attempt.updatedAt.getTime() !== data.attempt.updatedAt.getTime()) return null;
    if (state === 'succeeded') {
      if (!mapping) throw new Error('Captured attempt has no mapping');
      const reversed = ['refunded','partially_refunded','disputed','partially_disputed'].includes(mapping.status);
      const applied = !!mapping.invoicePaymentId || (reversed && mapping.paymentReceivedAt !== null);
      await db.update(invoiceCollectionAttempts).set({ state: applied ? 'succeeded' : 'unapplied', updatedAt: new Date() })
        .where(eq(invoiceCollectionAttempts.id, attemptId));
      if (schedule) await db.update(invoiceAutopaySchedules).set({ state: applied ? 'succeeded' : 'failed',
        stateReason: applied ? (reversed ? 'payment_reversed' : null) : 'payment_unapplied', nextAttemptAt: null,
      }).where(eq(invoiceAutopaySchedules.id, schedule.id));
      if (applied && !reversed) await enqueueAttemptNotice(db, attemptId, 'receipt');
      return applied ? null : 'payment.unapplied' as const;
    }
    if (state === 'processing') {
      await db.update(invoiceCollectionAttempts).set({ state: 'processing', updatedAt: new Date() })
        .where(eq(invoiceCollectionAttempts.id, attemptId));
      return null;
    }
    if (state === 'canceled') {
      await db.update(invoiceCollectionAttempts).set({ state: 'canceled', updatedAt: new Date() })
        .where(eq(invoiceCollectionAttempts.id, attemptId));
      if (mayAdvance) await db.update(invoiceAutopaySchedules).set({ state: 'cancelled', nextAttemptAt: null })
        .where(eq(invoiceAutopaySchedules.id, schedule!.id));
      return null;
    }
    const failureClass = classifyCollectionFailure({ methodType: data.method.type,
      code: failure.code, declineCode: failure.declineCode,
      achReturnCode: failure.achReturnCode, piStatus: pi.status });
    const authRequired = failureClass === 'auth_required';
    const targetState = authRequired ? 'requires_action' as const : 'failed' as const;
    const sameFailure = attempt.state === targetState && attempt.failureClass === failureClass;
    const failureAt = sameFailure ? attempt.updatedAt : new Date();
    await db.update(invoiceCollectionAttempts).set({ state: targetState,
      failureCode: failure.achReturnCode ?? failure.code,
      declineCode: failure.declineCode, failureClass, updatedAt: failureAt,
    }).where(eq(invoiceCollectionAttempts.id, attemptId));
    const [first] = await db.select({ createdAt: invoiceCollectionAttempts.createdAt }).from(invoiceCollectionAttempts)
      .where(attempt.scheduleId ? eq(invoiceCollectionAttempts.scheduleId, attempt.scheduleId)
        : eq(invoiceCollectionAttempts.id, attempt.id)).orderBy(asc(invoiceCollectionAttempts.createdAt)).limit(1);
    const next = schedule ? sameFailure && schedule.state === 'retry_scheduled' && schedule.attemptCount === attempt.attemptNo
      ? schedule.nextAttemptAt : retryAt(first!.createdAt, failureAt, failureClass, attempt.attemptNo) : null;
    if (mayAdvance) await db.update(invoiceAutopaySchedules).set({
      state: authRequired ? 'action_required' : next ? 'retry_scheduled' : 'failed',
      stateReason: failureClass, nextAttemptAt: next,
    }).where(eq(invoiceAutopaySchedules.id, schedule!.id));
    if (failureClass === 'hard' || failureClass === 'revoked') {
      await markPaymentMethodUnusable(db, data.method.id, pi.last_payment_error?.code ?? failureClass);
    }
    await enqueueAttemptNotice(db, attemptId, authRequired ? 'confirm'
      : failureClass === 'hard' || failureClass === 'revoked' ? 'update' : 'pay');
    return authRequired ? 'autopay.needs_attention' as const
      : next ? null : 'payment.failed_final' as const;
  }, 'autopay.applyOutcome');
  if (event) await notifyPaymentAttention({ partnerId, orgId: data.invoice.orgId,
    invoiceId: data.invoice.id, attemptId, event });
}
```
Persist the **first observed failure time** once, rather than moving NSF’s three-business-day clock on every poll. For a retry schedule already set for the same failed attempt, retain its `nextAttemptAt`; the same PI may later succeed, but a stale failure cannot postpone the retry indefinitely. The `readProviderFailure` adapter reads structured Charge/PaymentIntent fields. The [Stripe network-code table](https://docs.stripe.com/declines/network-codes) maps normalized bank codes to the same retry classes; a normalized R01 representative is used only when Stripe omits the raw R01/R09 distinction, which has identical policy. Unknown codes fail closed. Never parse translated messages.

In W1’s `recordStripePayment` terminal branch, captured autopay refusals must not emit the legacy `payment.failed`. Carry `source: mapping.source` in its internal terminal result; post-commit emission becomes:
```ts
if (outcome.source !== 'autopay') {
  await emitInvoiceEvent({ type: 'payment.failed', invoiceId: outcome.invoiceId,
    orgId: outcome.orgId, partnerId: outcome.partnerId });
}
```
Mapping status may remain `failed` because that existing enum describes ledger application; the attempt is the explicit `unapplied` money state. W1 must already permit a late success to re-enter a failed `payment_intent` mapping. Preserve all Checkout behavior. `settlePaymentIntent` must also use the Task 9 account-bound client internally; a live-key-only settlement would defeat archival recovery.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/collectionEngine.test.ts src/services/stripeReconcile.test.ts` and the unapplied real-DB case in Task 20.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/collectionEngine.ts apps/api/src/services/autopay/collectionEngine.test.ts apps/api/src/services/stripeReconcile.ts apps/api/src/services/stripeReconcile.test.ts apps/api/src/services/stripeSettle.ts`; `git commit -m "feat(billing): reconcile autopay outcomes and preserve unapplied captures"`.

### Task 13: Receipts for every online payment and failure variants (W4b)
**Files:** Create `apps/api/src/services/autopay/paymentNotices.ts`, `apps/api/src/services/autopay/paymentNotices.test.ts`; Modify prerequisite `apps/api/src/services/autopay/renderBillingNotice.ts`, `packages/shared/src/utils/emailTemplates.ts`, `apps/api/src/services/emailTemplates/defaults.ts`, `apps/api/src/services/stripeSettle.ts`, `apps/web/src/components/settings/EmailTemplatesTab.tsx`; Test `apps/api/src/__tests__/integration/stripeSettle.integration.test.ts`, shared catalog tests, renderer tests.
**Interfaces:** Produces `enqueueAttemptNotice(tx: Tx, attemptId: string, variant: 'receipt' | 'confirm' | 'update' | 'pay'): Promise<void>`, `enqueueOnlineReceipt(tx: Tx, mappingId: string): Promise<void>`; consumes C4 renderer/outbox/token contracts. C6 IDs and variables are byte-for-byte unchanged.

- [ ] **Step 1: Write the failing test**:
```ts
import { expect, it } from 'vitest';
import { noticeDedupeKey } from './paymentNotices';
it('shares a receipt identity between return, sweep, and event replay', () => {
  expect(noticeDedupeKey('mapping-1', 'payment_receipt')).toBe('mapping-1:payment_receipt:1');
  expect(noticeDedupeKey('attempt-1', 'payment_failed')).toBe('attempt-1:payment_failed:1');
});
```
In the existing settlement tests mock `getPartnerStripeClient`, return a paid Checkout, apply a mapping, and assert exactly one `payment_receipt` outbox insert on replay. Unpaid checkout, unapplied mapping, and manual cash payment produce none. Renderer assertions pin both closed lists below and that hostile template overrides cannot remove the fee disclosure.
In the existing `stripeSettle.integration.test.ts`, import `billingNoticeOutbox`, `organizations`, and `and`; use its actual local `seedPendingPayment`, `retrieveMock`, and `runDb`:
```ts
runDb('enqueues one receipt for a paid Checkout and none on settlement replay', async () => {
  const {f,inv}=await seedPendingPayment();
  await withSystemDbAccessContext(()=>db.update(organizations).set({billingContact:{email:'billing@example.test'}})
    .where(eq(organizations.id,f.orgId)));
  await settleCheckoutSession(f.partnerId,'cs_settle_1');
  await settleCheckoutSession(f.partnerId,'cs_settle_1');
  const notices=await withSystemDbAccessContext(()=>db.select().from(billingNoticeOutbox).where(and(
    eq(billingNoticeOutbox.invoiceId,inv.id),eq(billingNoticeOutbox.kind,'payment_receipt'))));
  expect(notices).toHaveLength(1);
  expect(notices[0]!.rendered).toMatchObject({frozen:{amount:'100.00',fee:'0.00'}});
});
```
Execute real-DB assertions with `pnpm test-stack up` followed by `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/stripeSettle.integration.test.ts`; never pass this suite to the default unit runner.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/paymentNotices.test.ts src/services/autopay/renderBillingNotice.test.ts`.
- [ ] **Step 3: Implement** — add IDs/variable union entries and exhaustive map entries:
```ts
// EMAIL_TEMPLATE_IDS additions
'payment_receipt', 'payment_failed',
// VARS_BY_ID entries
payment_receipt: ['org_name','partner_name','invoice_number','amount_paid','fee_amount',
  'total_charged','payment_method','paid_on','balance_remaining'],
payment_failed: ['org_name','partner_name','invoice_number','amount_due','failure_text','action_link','action_label'],
// LABEL_BY_ID
payment_receipt: 'Online payment receipt',
payment_failed: 'Payment could not be completed',
// HAS_CTA_BY_ID
payment_receipt: false,
payment_failed: true,
// FIELD_DEFAULTS_BY_ID
payment_receipt: { subject: 'Payment receipt for {{invoice_number}}', heading: 'Payment received',
  buttonLabel: '', html: '<p>Paid: {{amount_paid}}. Processing fee: {{fee_amount}}. Total charged: {{total_charged}}.</p><p>{{payment_method}} on {{paid_on}}. Remaining balance: {{balance_remaining}}.</p>' },
payment_failed: { subject: 'Action needed for invoice {{invoice_number}}', heading: 'Payment needs attention',
  buttonLabel: 'Review payment', html: '<p>{{failure_text}}</p><p>Amount due: {{amount_due}}.</p>' },
```
Add both IDs to API preheader/footer records and W2’s editor group. Renderer uses `action_link`/`action_label` for `payment_failed`; receipt includes fee text in `bodyAfterCta` regardless of override. The renderer’s private W4 result context is `{ payment: { id: 'payment_receipt'|'payment_failed'; vars: Record<string,string>; custom: PartnerEmailCustom|null; frozen: RenderedNotice['frozen'] } }`:
```ts
if ('payment' in ctx) {
  if ((kind !== 'payment_receipt' && kind !== 'payment_failed') || ctx.payment.id !== kind) throw new Error('Missing payment notice context');
  const p = ctx.payment;
  const rendered = renderPartnerEmail({ id: kind, custom: p.custom, vars: p.vars,
    ctaUrl: p.vars.action_link, ctaLabel: p.vars.action_label,
    bodyAfterCta: kind === 'payment_receipt' ? `<p>Processing fee: ${escapeHtml(p.vars.fee_amount)}</p>` : undefined });
  return { ...rendered, frozen: p.frozen,
    text: Object.entries(p.vars).map(([key,value]) => `${key}: ${value}`).join('\n') };
}
```
Complete customer notice module:
```ts
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { invoiceCollectionAttempts, invoiceStripePayments, invoices, organizations, partners, orgPaymentMethods, orgAutopayEnrollments, billingNoticeOutbox } from '../../db/schema';
import { toMinorUnits, fromMinorUnits } from '../stripeMoney';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { resolveBillingEmail } from '../invoicePdf';
import { partnerEmailCustomFromSettings } from '../emailTemplates/renderPartnerEmail';
import { mintBillingLinkToken, buildBillingLinkUrl } from './linkTokens';
import { enqueueBillingNotice } from './noticeOutbox';
import { renderBillingNotice } from './renderBillingNotice';
type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export function noticeDedupeKey(id: string, kind: string): string { return `${id}:${kind}:1`; }
export async function enqueueOnlineReceipt(tx: Tx, mappingId: string): Promise<void> {
  const [mapping] = await tx.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.id, mappingId)).limit(1);
  if (!mapping?.invoicePaymentId || mapping.status !== 'succeeded') return;
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, mapping.invoiceId)).limit(1);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, mapping.orgId)).limit(1);
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice!.partnerId)).limit(1);
  const email = resolveBillingEmail(org!.billingContact);
  if (!email) return;
  const total = fromMinorUnits(toMinorUnits(mapping.amount, mapping.currency)
    + toMinorUnits(mapping.feeAmount, mapping.currency), mapping.currency);
  const vars = { org_name: org!.name, partner_name: partner!.name, invoice_number: invoice!.invoiceNumber!,
    amount_paid: `${mapping.currency} ${mapping.amount}`, fee_amount: `${mapping.currency} ${mapping.feeAmount}`,
    total_charged: `${mapping.currency} ${total}`, payment_method: mapping.paymentMethodType === 'us_bank_account' ? 'Bank debit' : 'Card',
    paid_on: mapping.paymentReceivedAt!, balance_remaining: `${invoice!.currencyCode} ${invoice!.balance}` };
  const rendered = await renderBillingNotice('payment_receipt', { payment: { id: 'payment_receipt', vars,
    custom: partnerEmailCustomFromSettings(partner!.settings, 'payment_receipt'),
    frozen: { amount: mapping.amount, fee: mapping.feeAmount, total } } });
  await enqueueBillingNotice(tx, { orgId: mapping.orgId, partnerId: invoice!.partnerId, invoiceId: invoice!.id,
    kind: 'payment_receipt', seq: 1, dedupeKey: noticeDedupeKey(mapping.id, 'payment_receipt'), toEmail: email, rendered });
}
export async function enqueueAttemptNotice(tx: Tx, attemptId: string,
  variant: 'receipt' | 'confirm' | 'update' | 'pay'): Promise<void> {
  const [attempt] = await tx.select().from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.id, attemptId)).limit(1);
  if (!attempt) throw new Error('Attempt not found for notice');
  if (variant === 'receipt') {
    if (attempt.invoiceStripePaymentId) await enqueueOnlineReceipt(tx, attempt.invoiceStripePaymentId);
    return;
  }
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, attempt.invoiceId)).limit(1);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, attempt.orgId)).limit(1);
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice!.partnerId)).limit(1);
  const [method] = await tx.select().from(orgPaymentMethods).where(eq(orgPaymentMethods.id, attempt.paymentMethodId)).limit(1);
  const email = resolveBillingEmail(org!.billingContact);
  if (!email) return;
  const dedupeKey = noticeDedupeKey(attemptId, 'payment_failed');
  const [existingNotice] = await tx.select({id:billingNoticeOutbox.id}).from(billingNoticeOutbox)
    .where(eq(billingNoticeOutbox.dedupeKey,dedupeKey)).limit(1);
  if (existingNotice) return;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.id,method!.enrollmentId)).limit(1);
  if (!enrollment) throw new Error('Enrollment missing for notice');
  let tokenId: string | null = null;
  let actionLink: string;
  if (variant === 'pay') actionLink = buildPublicInvoiceUrl((await getOrMintInvoiceLink(invoice!)).token);
  else {
    const token = await mintBillingLinkToken(tx, { orgId: attempt.orgId, invoiceId: invoice!.id,
      enrollmentId: method!.enrollmentId, generation: enrollment.generation, purpose: variant === 'confirm' ? 'confirm_payment' : 'enroll', ttlDays: 14 });
    tokenId = token.id;
    actionLink = buildBillingLinkUrl(variant === 'confirm' ? 'confirm_payment' : 'enroll', token.token);
  }
  const failureText = variant === 'confirm' ? 'Your bank requires confirmation before this payment can complete.'
    : variant === 'update' ? 'This payment method cannot be used. Please update it or pay this invoice.'
    : attempt.failureClass === 'nsf' ? 'The bank reported insufficient available funds. One retry may follow.'
    : 'Payment could not be completed. You can pay this invoice now.';
  const vars = { org_name: org!.name, partner_name: partner!.name, invoice_number: invoice!.invoiceNumber!,
    amount_due: `${invoice!.currencyCode} ${invoice!.balance}`, failure_text: failureText,
    action_link: actionLink, action_label: variant === 'confirm' ? 'Confirm payment' : variant === 'update' ? 'Update payment method' : 'Pay invoice' };
  const rendered = await renderBillingNotice('payment_failed', { payment: { id: 'payment_failed', vars,
    custom: partnerEmailCustomFromSettings(partner!.settings, 'payment_failed'), frozen: { attemptId, variant, tokenId } } });
  await enqueueBillingNotice(tx, { orgId: attempt.orgId, partnerId: invoice!.partnerId, invoiceId: invoice!.id,
    kind: 'payment_failed', seq: 1, dedupeKey: noticeDedupeKey(attemptId, 'payment_failed'), toEmail: email, rendered });
}
```
Before minting, check the existing dedupe key, so replay cannot mint unreferenced tokens. Include the enrollment generation on both confirm/update tokens, loaded from the method’s enrollment. Confirm resolution binds to the **exact attempt** via the existing outbox’s `rendered.frozen.attemptId` and the rendered action token’s stored row ID; add `tokenId` to `frozen` at creation. Never resolve a confirm token by “latest attempt for invoice”, because a stale token could then confirm a later charge.

In `settleCheckoutSession`, after `recordStripePayment` commits, use a short system context to load the mapping by `session.id` and call `enqueueOnlineReceipt(db, mapping.id)`. Add the same hook after W1 `settlePaymentIntent` application, and in the existing reconcile capture path so a capture without browser return also gets a receipt. The unique outbox key makes all entry points converge. Never send from inside ledger mutation; enqueue atomically where the ledger is available, dispatch later.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/paymentNotices.test.ts src/services/autopay/renderBillingNotice.test.ts`; `cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/paymentNotices.ts apps/api/src/services/autopay/paymentNotices.test.ts apps/api/src/services/autopay/renderBillingNotice.ts apps/api/src/services/autopay/renderBillingNotice.test.ts apps/api/src/services/stripeSettle.ts apps/api/src/__tests__/integration/stripeSettle.integration.test.ts packages/shared/src/utils/emailTemplates.ts packages/shared/src/utils/emailTemplates.test.ts apps/api/src/services/emailTemplates/defaults.ts apps/web/src/components/settings/EmailTemplatesTab.tsx`; `git commit -m "feat(billing): send online receipts and actionable payment failures"`.

### Task 14: MSP attention notifications and late ACH returns (W4b)
**Files:** Modify `apps/api/src/services/autopay/paymentNotices.ts`, prerequisite `apps/api/src/services/autopay/staffNotifications.ts`, `apps/api/src/services/stripeReversalState.ts`; Test `apps/api/src/services/autopay/paymentNotices.test.ts`, `apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts`.
**Interfaces:** Produces private `notifyPaymentAttention(input: {partnerId:string;orgId:string;invoiceId:string;attemptId:string;event:'payment.failed_final'|'payment.ach_returned'|'payment.unapplied'|'autopay.needs_attention'}): Promise<void>`; consumes W2 `notifyAutopayStaff(input: AutopayStaffNotice): Promise<void>` in `services/autopay/staffNotifications.ts`; extend its event union with C9 `autopay.skipped`, `payment.failed_final`, `payment.ach_returned`, and `payment.unapplied` without changing its signature.

- [ ] **Step 1: Write the failing test** — pin notification identity and reversal method:
```ts
import { attentionDedupeKey } from './paymentNotices';
it('dedupes each attempt outcome independently', () => {
  expect(attentionDedupeKey('a', 'payment.unapplied')).toBe('autopay:a:payment.unapplied');
  expect(attentionDedupeKey('a', 'payment.ach_returned')).not.toBe(attentionDedupeKey('a', 'payment.unapplied'));
});
```
Extend the existing `apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts`, whose real local helpers are `seed(linkPayment=true,invoiceAmount=100)` and `financialEvent(f,overrides)`. Add the three W1 table imports and this complete fixture/test before modifying the reducer:
```ts
async function seedAutopayBank(linkPayment=true) {
  const f=await seed(linkPayment);
  return withSystemDbAccessContext(async()=>{
    const [mapping]=await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId));
    const [enrollment]=await db.insert(orgAutopayEnrollments).values({orgId:f.orgId,partnerId:f.partnerId,
      status:'active',generation:1,stripeConnectionId:f.connectionId,stripeAccountId:f.accountId,
      stripeCustomerId:`cus_${f.invoiceId}`,effectiveFrom:new Date('2026-01-01'),requestedAt:new Date('2026-01-01')}).returning();
    const [method]=await db.insert(orgPaymentMethods).values({orgId:f.orgId,enrollmentId:enrollment!.id,
      stripePaymentMethodId:`pm_${f.invoiceId}`,type:'us_bank_account',bankName:'Test bank',bankLast4:'6789',
      accountHolderType:'company',status:'active',isAutopayMethod:true}).returning();
    await db.update(invoiceStripePayments).set({stripeObjectType:'payment_intent',stripeObjectId:f.paymentIntentId,
      source:'autopay',paymentMethodType:'us_bank_account',feeAmount:'0.00',
      ...(!linkPayment?{status:'failed' as const}:{}),
    }).where(eq(invoiceStripePayments.id,mapping!.id));
    if(mapping!.invoicePaymentId)await db.update(invoicePayments).set({method:'ach_debit'})
      .where(eq(invoicePayments.id,mapping!.invoicePaymentId));
    const [attempt]=await db.insert(invoiceCollectionAttempts).values({orgId:f.orgId,invoiceId:f.invoiceId,
      scheduleId:null,attemptNo:1,paymentMethodId:method!.id,stripePaymentIntentId:f.paymentIntentId,
      invoiceStripePaymentId:mapping!.id,idempotencyKey:`autopay_return_${f.invoiceId}`,principalAmount:'100.00',
      feeAmount:'0.00',currency:'USD',state:linkPayment?'succeeded':'unapplied',initiatedBy:'client_on_session'}).returning();
    return {...f,attemptId:attempt!.id};
  });
}
runDb('returns and restores bank principal once, preserving ach_debit',async()=>{
  const f=await seedAutopayBank();
  const withdrawal=financialEvent(f,{stripeEventId:`evt_out_${f.invoiceId}`,eventType:'charge.dispute.funds_withdrawn',
    providerCreated:300,refundedAmountMinor:null,disputeId:`dp_${f.invoiceId}`,disputeAmountMinor:10000,disputeFundsWithdrawn:true});
  await ingestStripeFinancialEvent(withdrawal);await ingestStripeFinancialEvent(withdrawal);
  const [open]=await withSystemDbAccessContext(()=>db.select().from(invoices).where(eq(invoices.id,f.invoiceId)));
  expect(open!.balance).toBe('100.00');
  const restore=financialEvent(f,{stripeEventId:`evt_back_${f.invoiceId}`,eventType:'charge.dispute.funds_reinstated',
    providerCreated:301,refundedAmountMinor:null,disputeId:`dp_${f.invoiceId}`,disputeAmountMinor:10000,disputeFundsWithdrawn:false});
  await ingestStripeFinancialEvent(restore);await ingestStripeFinancialEvent(restore);
  const payments=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId,f.invoiceId)));
  expect(payments).toHaveLength(1);expect(payments[0]).toMatchObject({amount:'100.00',method:'ach_debit'});
});
runDb('closes a full refund of unapplied capture without inventing a ledger payment',async()=>{
  const f=await seedAutopayBank(false);
  const refund=financialEvent(f,{refundedAmountMinor:10000});
  await ingestStripeFinancialEvent(refund);await ingestStripeFinancialEvent(refund);
  const [attempt]=await withSystemDbAccessContext(()=>db.select().from(invoiceCollectionAttempts)
    .where(eq(invoiceCollectionAttempts.id,f.attemptId)));
  expect(attempt).toMatchObject({state:'canceled',failureCode:'unapplied_refunded'});
  const payments=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId,f.invoiceId)));
  expect(payments).toHaveLength(0);
});
```
Use a hoisted mock of `notifyPaymentAttention` from `../../services/autopay/paymentNotices` to assert exactly one `payment.ach_returned` for the withdrawal, none for event replay or reinstatement. Keep the real ledger reducer. Real-DB command: `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/stripeReversalState.integration.test.ts`.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/paymentNotices.test.ts`; then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/stripeReversalState.integration.test.ts`.
- [ ] **Step 3: Implement** — append to `paymentNotices.ts`:
```ts
import { notifyAutopayStaff } from './staffNotifications';
export function attentionDedupeKey(attemptId: string, event: string): string {
  return `autopay:${attemptId}:${event}`;
}
export async function notifyPaymentAttention(input: {
  partnerId: string; orgId: string; invoiceId: string; attemptId: string;
  event: 'payment.failed_final' | 'payment.ach_returned' | 'payment.unapplied' | 'autopay.needs_attention';
}): Promise<void> {
  const message = input.event === 'payment.unapplied'
    ? 'Stripe collected money that could not be applied. Review the payment and refund it in Stripe if appropriate.'
    : input.event === 'payment.ach_returned' ? 'A bank payment was returned. The invoice balance has reopened.'
    : input.event === 'payment.failed_final' ? 'Automatic payment has stopped retrying. The client can pay the invoice directly.'
    : 'Automatic payment needs attention. Review the invoice before trying again.';
  await notifyAutopayStaff({partnerId:input.partnerId,orgId:input.orgId,event:input.event,
    dedupeKey:attentionDedupeKey(input.attemptId,input.event),
    message:`${message} Invoice: ${input.invoiceId}`});
}
```
Extend W2’s `AutopayStaffNotice.event` union exactly:
```ts
event: 'autopay.enrolled' | 'autopay.stopped' | 'autopay.skipped' | 'autopay.needs_attention'
  | 'payment.failed_final' | 'payment.ach_returned' | 'payment.unapplied';
```
In `notifyAutopayStaff`, compute `const urgent = input.event === 'autopay.needs_attention' || input.event.startsWith('payment.');` and use `priority: urgent ? 'high' as const : 'normal' as const`. Use `title: input.event === 'autopay.enrolled' ? 'Automatic payments enabled' : input.event === 'autopay.stopped' ? 'Automatic payments stopped' : input.event === 'autopay.skipped' ? 'Automatic payment skipped' : 'Payment needs attention'`. Preserve W2’s combined organization/partner recipient policy and per-user dedupe suffix. Preserve `purpose:'staff.autopay'`, including when no staff user exists but the partner has a billing email. Staff email is best-effort and may repeat on retry; in-app notifications dedupe, customer notices remain durable.

In `applyStripeFinancialEvent` in `stripeReversalState.ts`, preserve its existing invoice → mapping → event lock order, charge/account/currency validation, cumulative reversal calculation, and accounting push/delete hooks. Change the restore insert to:
```ts
method: mapping.paymentMethodType === 'us_bank_account' ? 'ach_debit' : 'card',
```
Before the existing `payment_capture_not_linked` branch, after partner/account/currency/amount validation and while its invoice→mapping→event locks are held, add the full-refund escape for unapplied capture. Import `invoiceCollectionAttempts`. This is reachable even when the mapping's ledger status is `failed`:
```ts
if(mapping.source==='autopay' && !mapping.invoicePaymentId && !mapping.paymentReceivedAt){
  const [attempt]=await db.select().from(invoiceCollectionAttempts)
    .where(eq(invoiceCollectionAttempts.invoiceStripePaymentId,mapping.id)).limit(1).for('update');
  const refunded=event.refundedAmountMinor===null?null:Number(event.refundedAmountMinor);
  if(attempt?.state==='unapplied' && refunded===originalMinor && event.eventType==='charge.refunded'){
    await db.update(invoiceCollectionAttempts).set({state:'canceled',failureCode:'unapplied_refunded',updatedAt:new Date()})
      .where(eq(invoiceCollectionAttempts.id,attempt.id));
    await db.update(invoiceStripePayments).set({status:'refunded',refundedAmountMinor:String(originalMinor),updatedAt:new Date()})
      .where(eq(invoiceStripePayments.id,mapping.id));
    await db.update(stripeFinancialEvents).set({status:'applied',processedAt:new Date(),lastError:null,updatedAt:new Date()})
      .where(eq(stripeFinancialEvents.id,event.id));
    return {state:'applied',invoiceId:invoice.id,orgId:invoice.orgId,partnerId:invoice.partnerId,change:'unchanged'};
  }
}
```
A partial refund retains `unapplied` and the attention banner until the captured balance is resolved; it must not create an invoice payment. The attempt outcome path's `unapplied_refunded` guard prevents later PI-success replay from restoring that banner.

After an **applied** reversal whose mapping is an autopay bank debit, load the mapped attempt, call `notifyPaymentAttention` with `payment.ach_returned` after commit, and call `markPaymentMethodUnusable` inside a short transaction for revoked/hard return codes. NSF stays eligible only for future invoice policy; do not resurrect the succeeded schedule for a late return. Set its `stateReason='payment_reversed'` for operator visibility. Refunds of unapplied money close that attempt as `canceled` with `failureCode='unapplied_refunded'`; they do not fabricate an `invoice_payments` row.

No nonzero-fee reversal allocation ships here; W1 keeps fee writes closed and W5 owns that extension. Receipt/ledger principal is unchanged by whether a notification can be delivered.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/paymentNotices.test.ts`; then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/stripeReversalState.integration.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/paymentNotices.ts apps/api/src/services/autopay/paymentNotices.test.ts apps/api/src/services/autopay/staffNotifications.ts apps/api/src/services/stripeReversalState.ts apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts`; `git commit -m "feat(billing): surface unapplied payments and returned bank debits"`.

### Task 15: Durable PI polling and collection job registration (W4b)
**Files:** Modify `apps/api/src/services/autopay/collectionEngine.ts`, `apps/api/src/jobs/stripeReconcileSweep.ts`, `apps/api/src/services/stripeFinancialEventPoller.ts`, `apps/api/src/services/stripeReversalState.ts`, prerequisite `apps/api/src/jobs/autopayWorker.ts`, `apps/api/src/jobs/scheduleRegistry.ts`; Create `apps/api/src/jobs/stripeReconcileSweep.test.ts`; Test `apps/api/src/services/stripeFinancialEventPoller.test.ts`, prerequisite `apps/api/src/jobs/autopayWorker.test.ts`, `apps/api/src/services/autopay/collectionEngine.test.ts`, `apps/api/src/jobs/scheduleRegistry.contract.test.ts`, `apps/api/src/services/workerEntrypointClosure.contract.test.ts`. Registration verification: `apps/api/src/services/workerRegistry.ts`, `apps/api/src/index.ts`, `apps/api/src/worker.ts`.
**Interfaces:** Produces C4 `runAutopayCollection(now?: Date): Promise<{ attempted: number; deferred: number }>`; consumes `resumeCollectionAttempt`, `applyAttemptOutcome`; C5 queue remains `autopay-jobs`, schedule key `autopay-collection-run`, cron `15 * * * *`, job `collection-run`.

- [ ] **Step 1: Write the failing test**:
```ts
import { JOB_SCHEDULES } from './scheduleRegistry';
it('registers the exact charging schedule', () => {
  expect(JOB_SCHEDULES['autopay-collection-run']).toBe('15 * * * *');
});
```
Create `apps/api/src/jobs/stripeReconcileSweep.test.ts` (no such unit suite exists today). This uses the verified `PgDialect.sqlToQuery` pattern from `db/sqlValues.test.ts`; it is an orchestration test and makes no Stripe call:
```ts
import {beforeEach,expect,it,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import type {SQL} from 'drizzle-orm';
const m=vi.hoisted(()=>({execute:vi.fn(),select:vi.fn(),predicates:[] as unknown[],depth:0,
  resume:vi.fn(),apply:vi.fn(),client:vi.fn(),capture:vi.fn()}));
vi.mock('../db',()=>({hasDbAccessContext:()=>m.depth>0,runOutsideDbContext:async(fn:()=>Promise<unknown>)=>fn(),
  withSystemDbAccessContext:async(fn:()=>Promise<unknown>)=>{m.depth++;try{return await fn();}finally{m.depth--;}},
  db:{execute:m.execute,select:m.select}}));
vi.mock('../services/partnerStripe',()=>({getPartnerStripeClient:m.client}));
vi.mock('../services/stripeReconcile',()=>({recordStripePayment:vi.fn()}));
vi.mock('../services/autopay/collectionEngine',()=>({resumeCollectionAttempt:m.resume,applyAttemptOutcome:m.apply}));
vi.mock('../services/stripeFinancialEventPoller',()=>({pollStripeFinancialEvents:vi.fn()}));
vi.mock('../services/redis',()=>({getBullMQConnection:vi.fn()}));
vi.mock('../services/sentry',()=>({captureException:m.capture}));
vi.mock('./workerObservability',()=>({attachWorkerObservability:vi.fn()}));
import {reconcilePendingStripePayments} from './stripeReconcileSweep';
const dialect=new PgDialect();
const partnerId='10000000-0000-4000-8000-000000000001';
const id=(n:number)=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const rows=Array.from({length:201},(_,i)=>({id:id(i+1),state:i<200?'requires_action':'processing',partnerId}));
beforeEach(()=>{
  vi.clearAllMocks();m.predicates.length=0;m.depth=0;m.execute.mockResolvedValue([]);
  m.client.mockRejectedValue(new Error('Unexpected provider access'));
  m.select.mockImplementation(()=>{
    let predicate:SQL;
    const chain={from:vi.fn(()=>chain),innerJoin:vi.fn(()=>chain),
      where:vi.fn((value:SQL)=>{predicate=value;m.predicates.push(value);return chain;}),
      orderBy:vi.fn(()=>chain),limit:vi.fn(async(count:number)=>{
        const query=dialect.sqlToQuery(predicate);
        const cursor=query.params.find(v=>typeof v==='string'&&v.startsWith('20000000-0000-4000-8000-')) as string|undefined;
        return rows.filter(row=>!cursor||row.id>cursor).slice(0,count);
      })};return chain;
  });
  m.apply.mockImplementation(async(_partnerId:string,attemptId:string)=>{
    expect(m.depth).toBe(0);if(attemptId!==id(201))throw new Error('Provider unavailable');
  });
});
it('recovers beyond 200 blocked attempts even with no Checkout candidates',async()=>{
  await reconcilePendingStripePayments();
  expect(m.apply).toHaveBeenCalledTimes(201);
  expect(m.apply).toHaveBeenLastCalledWith(partnerId,id(201));
  expect(new Set(m.apply.mock.calls.map(call=>call[1])).size).toBe(201);
  expect(m.capture).toHaveBeenCalledTimes(200);expect(m.client).not.toHaveBeenCalled();
  const queries=m.predicates.map(value=>dialect.sqlToQuery(value as SQL));
  expect(queries[1]!.params).toContain(id(200));expect(queries[2]!.params).toContain(id(201));
  for(const query of queries)expect(query.sql).not.toMatch(/created_at|interval|7 days/i);
});
```
Add event-poller cases for all four PI event types using its actual `base` fixture and `normalizeStripeFinancialEvent`. Each normalized row retains `paymentIntentId`, account, mode, amount, and currency. Real event-before-mapping, duplicate, and reversal tests use the existing integration inbox suite; none can acknowledge a missing mapping as applied.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/jobs/stripeReconcileSweep.test.ts src/services/stripeFinancialEventPoller.test.ts src/jobs/autopayWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts`.
- [ ] **Step 3: Implement** — engine sweep:
```ts
export async function runAutopayCollection(now = new Date()): Promise<{ attempted: number; deferred: number }> {
  assertNoHeldDbContextForStripe('runAutopayCollection');
  let attempted = 0;
  let deferred = 0;
  let cursor: string | undefined;
  for (;;) {
    const due = await withSystemDbAccessContext(() => db.select({id:invoiceAutopaySchedules.id,
      invoiceId:invoiceAutopaySchedules.invoiceId}).from(invoiceAutopaySchedules).where(and(
      inArray(invoiceAutopaySchedules.state,['scheduled','retry_scheduled']),
      lte(invoiceAutopaySchedules.collectOn,now.toISOString().slice(0,10)),
      or(isNull(invoiceAutopaySchedules.nextAttemptAt),lte(invoiceAutopaySchedules.nextAttemptAt,now)),
      cursor ? gt(invoiceAutopaySchedules.id,cursor) : undefined,
    )).orderBy(asc(invoiceAutopaySchedules.id)).limit(200));
    if (!due.length) break;
    for (const row of due) {
      try {
        const result=await attemptCollection({invoiceId:row.invoiceId,scheduleId:row.id,initiatedBy:'scheduler'});
        if(result.outcome==='created')attempted++;else deferred++;
      } catch(error) {deferred++;captureException(error instanceof Error?error:new Error(String(error)));}
    }
    cursor=due[due.length-1]!.id;
  }
  return { attempted, deferred };
}
```
Import existing `captureException` from `../sentry`. Add an attempt recovery selection to `reconcilePendingStripePayments`, without any `createdAt` maximum:
```ts
let cursor: string | undefined;
for (;;) {
  const attempts = await runWithSystemDbAccess(() => db.select({id:invoiceCollectionAttempts.id,
    state:invoiceCollectionAttempts.state,partnerId:invoices.partnerId}).from(invoiceCollectionAttempts)
    .innerJoin(invoices,eq(invoices.id,invoiceCollectionAttempts.invoiceId)).where(and(
      inArray(invoiceCollectionAttempts.state,['reserved','created','confirming','processing','requires_action']),
      cursor?gt(invoiceCollectionAttempts.id,cursor):undefined,
    )).orderBy(asc(invoiceCollectionAttempts.id)).limit(200));
  if(!attempts.length)break;
  for(const attempt of attempts){
    try{
      if(['reserved','created','confirming'].includes(attempt.state))await resumeCollectionAttempt(attempt.id);
      else await applyAttemptOutcome(attempt.partnerId,attempt.id);
    }catch(error){
      if(error instanceof HeldDbContextForStripeError)throw error;
      captureException(error instanceof Error?error:new Error(String(error)));
    }
  }
  cursor=attempts[attempts.length-1]!.id;
}
```
Import `eq`, `inArray`, `asc`, `gt`, `invoiceCollectionAttempts`, and the two engine functions. Execute this branch even when the old Checkout candidate list is empty; preserve its 2-minute–7-day window only for Checkout. Immutable-ID keyset pagination visits every existing candidate once per pass even when the first 200 remain blocked. A concurrently inserted lower-ID row is handled on the next hourly pass; no mutable timestamp cursor can cause an endless loop.

Add these exact event types to `STRIPE_FINANCIAL_EVENT_TYPES`:
```ts
'payment_intent.succeeded',
'payment_intent.payment_failed',
'payment_intent.processing',
'payment_intent.requires_action',
```
Before the reversal-only branch of `normalizeStripeFinancialEvent`, return:
```ts
if (event.type.startsWith('payment_intent.')) {
  const pi = event.data.object as Stripe.PaymentIntent;
  return { partnerId, stripeAccountId, stripeEventId: event.id, eventType: event.type,
    livemode: event.livemode, providerCreated: event.created, paymentIntentId: pi.id,
    currency: pi.currency, chargeAmountMinor: pi.amount };
}
```
`ingestStripeFinancialEvent` remains the durable insert and cursor advancement boundary. In `applyStripeFinancialEvent`, detect a PI inbox row **before** the existing “no refund/dispute data → ignored” transaction. In a short context join its account+PI to mapping→attempt→invoice and validate partner/org. If missing, leave `pending` with the existing retry update; never acknowledge an event that arrived before mapping insertion. Outside the context call `applyAttemptOutcome`, then mark the inbox row `applied` in a short context. Never call it recursively from inside `recordStripePayment`’s `processPendingStripeFinancialEventsForPayment`; that post-capture replay path must filter to reversal event types to avoid settle → inbox → settle recursion.

Archived accounts must remain poll candidates while unresolved attempts exist. A disconnected row retains the account cursor; obtain its client via Task 9’s reconciliation options and keep existing event account/livemode validation. The existing “historical payments block account switching” rule prevents a single cursor being reinterpreted across a different account.

Registration edits:
```ts
// JOB_SCHEDULES in jobs/scheduleRegistry.ts
'autopay-collection-run': '15 * * * *',
```
```ts
// jobs/autopayWorker.ts imports and module-level cron
import { runAutopayCollection } from '../services/autopay/collectionEngine';
const COLLECTION_CRON = jobSchedule('autopay-collection-run');
// Extend W1's job-data discriminated union with { type: 'collection-run' }.
// Existing worker switch:
case 'collection-run': return runAutopayCollection();
// Existing repeat registration:
await queue.add('collection-run', { type: 'collection-run' }, {
  repeat: { pattern: COLLECTION_CRON }, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 },
});
```
Verify W1’s `WORKER_REGISTRY` already has one global autopay entry and both entrypoints use `startRegisteredWorkers`. Do not create a second worker instance in `index.ts`. The contract tests must resolve the literal cron callsite and prove both entrypoints reach the same registry entry.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/jobs/stripeReconcileSweep.test.ts src/services/stripeFinancialEventPoller.test.ts src/jobs/autopayWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts`, plus `cd apps/api && npx vitest run src/services/autopay/collectionEngine.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/collectionEngine.ts apps/api/src/services/autopay/collectionEngine.test.ts apps/api/src/jobs/stripeReconcileSweep.ts apps/api/src/jobs/stripeReconcileSweep.test.ts apps/api/src/services/stripeFinancialEventPoller.ts apps/api/src/services/stripeFinancialEventPoller.test.ts apps/api/src/services/stripeReversalState.ts apps/api/src/jobs/autopayWorker.ts apps/api/src/jobs/autopayWorker.test.ts apps/api/src/jobs/scheduleRegistry.ts`; `git commit -m "feat(billing): register collection and reconcile PaymentIntents without age cutoff"`.

### Task 16: Explicit, invoice-bound bank setup and pay (W4b)
**Files:** Create `apps/api/src/services/autopay/bankPayment.ts`, `apps/api/src/services/autopay/bankPayment.test.ts`, `apps/api/src/services/autopay/clientPaymentAuthority.ts`; Modify prerequisite `apps/api/src/services/autopay/setupSession.ts`, `apps/api/src/services/autopay/setupCompletion.ts`, `apps/api/src/services/autopay/collectionEngine.ts`, `apps/api/src/routes/invoicesPublic.ts`, `apps/api/src/routes/portal/invoices.ts`, prerequisite `apps/api/src/routes/portal/paymentMethods.ts`.
**Interfaces:** Preserves C4 `createAutopaySetupSession(input: { orgId: string; methodType: AutopayPaymentMethodType; consentAccepted: true; returnTo: 'public' | 'portal'; tokenId?: string; contactEmail: string; ip: string | null; userAgent: string | null }): Promise<{ url: string }>` and `attemptCollection`. Produces private request-scoped `withClientPaymentAuthority`, `getClientPaymentAuthority`; existing pay endpoints accept a discriminated body `{ methodType:'us_bank_account'; phase:'setup'|'collect'; consentAccepted:true; setupSessionId?:string }`.

- [ ] **Step 1: Write the failing test** — prove the authority cannot leak across concurrent calls:
```ts
import { expect, it } from 'vitest';
import { getClientPaymentAuthority, withClientPaymentAuthority } from './clientPaymentAuthority';
it('isolates each client authorization and restores the empty context', async () => {
  const base = { tokenId: '10000000-0000-4000-8000-000000000001', generation: 1,
    principal: '100.00', fee: '0.00', currency: 'USD', methodId: 'pm_local' };
  const result = await Promise.all(['invoice-a','invoice-b'].map(invoiceId =>
    withClientPaymentAuthority({ ...base, invoiceId }, async () => {
      await Promise.resolve();
      return getClientPaymentAuthority()?.invoiceId;
    })));
  expect(result).toEqual(['invoice-a','invoice-b']);
  expect(getClientPaymentAuthority()).toBeUndefined();
});
```
Bank service tests mock only the Stripe boundary and use real DB in Task 20 for token consumption. Cases: pending microdeposits refuses collection, setup-return replay consumes one token once, wrong invoice/org/account/generation/method refuses, amount or fee above authorization refuses, background setup sweep never calls `attemptCollection`. Two concurrent collect POSTs create one attempt.
Pin the strict body before adding the bank route branches:
```ts
import {bankPaySchema} from './bankPayment';
it('requires consent, an unchanged disclosure, decimal amounts, and a session for collect',()=>{
  const base={methodType:'us_bank_account',phase:'setup',consentAccepted:true,disclosureHash:'a'.repeat(64),principal:'100.00',fee:'0.00',currency:'USD'};
  expect(bankPaySchema.safeParse(base).success).toBe(true);
  for(const patch of [{consentAccepted:false},{disclosureHash:''},{principal:100},{currency:'EUR'},{phase:'collect'}]){
    expect(bankPaySchema.safeParse({...base,...patch}).success).toBe(false);
  }
  expect(bankPaySchema.safeParse({...base,phase:'collect',setupSessionId:'cs_test_1'}).success).toBe(true);
});
```
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/bankPayment.test.ts`.
- [ ] **Step 3: Implement** — the request authority is private and cannot be supplied by arbitrary request JSON:
```ts
// clientPaymentAuthority.ts
import { AsyncLocalStorage } from 'node:async_hooks';
export interface ClientPaymentAuthority {
  tokenId: string; invoiceId: string; generation: number; methodId: string;
  principal: string; fee: string; currency: string;
}
const authority = new AsyncLocalStorage<ClientPaymentAuthority>();
export function withClientPaymentAuthority<T>(value: ClientPaymentAuthority, run: () => Promise<T>): Promise<T> {
  return authority.run(value, run);
}
export function getClientPaymentAuthority(): ClientPaymentAuthority | undefined { return authority.getStore(); }
```
Add to `reserveCollection` before writing the attempt, under the same invoice lock:
```ts
if (input.initiatedBy === 'client_on_session') {
  const authority = getClientPaymentAuthority();
  if (!authority || authority.invoiceId !== invoice.id || authority.generation !== enrollment.generation
    || authority.methodId !== method.id || authority.currency !== invoice.currencyCode
    || principalMinor > toMinorUnits(authority.principal, invoice.currencyCode)
    || feeMinor > toMinorUnits(authority.fee, invoice.currencyCode)) return refuse('client_authorization_required');
  const consumed = await db.update(billingLinkTokens).set({ consumedAt: new Date() }).where(and(
    eq(billingLinkTokens.id, authority.tokenId), eq(billingLinkTokens.orgId, invoice.orgId),
    eq(billingLinkTokens.invoiceId, invoice.id), eq(billingLinkTokens.generation, enrollment.generation),
    eq(billingLinkTokens.purpose, 'enroll'), isNull(billingLinkTokens.consumedAt),
    isNull(billingLinkTokens.revokedAt), sql`${billingLinkTokens.expiresAt} > NOW()`,
  )).returning({ id: billingLinkTokens.id });
  if (!consumed.length) return refuse('client_authorization_used');
}
```
Import `billingLinkTokens` and `getClientPaymentAuthority` in the engine. Consume and reserve atomically, so a failed transaction does not burn authorization. The setup flow must not consume this invoice-bound token when merely saving the method; reserve consumes it. Ordinary enrollment tokens retain W2’s single-use behavior.

Add the setup authority alongside the collection authority in `clientPaymentAuthority.ts`. This private request context preserves C4's fixed setup signature:
```ts
export interface BankSetupTerms {invoiceId:string;orgId:string;principal:string;fee:string;currency:string;disclosureHash:string}
const setupAuthority=new AsyncLocalStorage<BankSetupTerms>();
export function withBankSetupTerms<T>(terms:BankSetupTerms,run:()=>Promise<T>):Promise<T>{return setupAuthority.run(terms,run);}
export function getBankSetupTerms():BankSetupTerms|undefined{return setupAuthority.getStore();}
```
Add the strict input schema and these complete setup/offer helpers to `bankPayment.ts`. Existing routes supply the invoice/org after their own token or portal authorization; a caller-provided org ID is never trusted as admission:
```ts
import {z} from 'zod';
import {organizations} from '../../db/schema';
import {InvoiceServiceError} from '../invoiceTypes';
import {resolveBillingEmail} from '../invoicePdf';
import {isAutopayEnabledForPartner} from './autopayGate';
import {getAutopayStripeReadiness} from './stripeCapabilities';
import {resolveBillingPaymentSettings} from './billingPaymentSettings';
import {quoteProcessingFee} from './processingFee';
import {buildAutopayDisclosure,withAcceptedAutopayDisclosure} from './consentText';
import {mintBillingLinkToken} from './linkTokens';
import {createAutopaySetupSession} from './enrollmentService';
import {withBankSetupTerms} from './clientPaymentAuthority';
export const bankPaySchema=z.object({methodType:z.literal('us_bank_account'),phase:z.enum(['setup','collect']),
  consentAccepted:z.literal(true),disclosureHash:z.string().regex(/^[a-f0-9]{64}$/),
  principal:z.string().regex(/^\d+\.\d{2}$/),fee:z.string().regex(/^\d+\.\d{2}$/),currency:z.literal('USD'),
  setupSessionId:z.string().regex(/^cs_[A-Za-z0-9_]+$/).max(255).optional()}).strict().superRefine((value,ctx)=>{
    if(value.phase==='collect'&&!value.setupSessionId)ctx.addIssue({code:'custom',path:['setupSessionId'],message:'Setup session required'});
  });
export async function getBankAutopayOffer(invoiceId:string,orgId:string){
  return withSystemDbAccessContext(async()=>{
    const [invoice]=await db.select().from(invoices).where(and(eq(invoices.id,invoiceId),eq(invoices.orgId,orgId))).limit(1);
    if(!invoice||invoice.currencyCode!=='USD'||!['sent','partially_paid','overdue'].includes(invoice.status))return null;
    if(!await isAutopayEnabledForPartner(db,invoice.partnerId))return null;
    const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1);
    const [org]=await db.select().from(organizations).where(eq(organizations.id,orgId)).limit(1);
    const ready=await getAutopayStripeReadiness(db,invoice.partnerId);
    if(!org||org.deletedAt||!['active','trial'].includes(org.status)||!enrollment||!['requested','active'].includes(enrollment.status)
      ||!ready.ready||ready.accountCountry!=='US'||ready.stripeAccountId!==enrollment.stripeAccountId)return null;
    const settings=await resolveBillingPaymentSettings(db,{partnerId:invoice.partnerId,orgId});
    if(settings.achMode.value==='card_only')return null;
    const quote=quoteProcessingFee({methodType:'us_bank_account',cardFunding:null,principal:invoice.balance,currency:'USD',
      stripeAccountCountry:ready.accountCountry,orgBillingCountry:org.billingAddressCountry,orgBillingRegion:org.billingAddressRegion,
      cardFeeBps:settings.cardFeeBps.value,achFeeAmount:settings.achFeeAmount.value,feeAttested:settings.feeAttested});
    const disclosure=await buildAutopayDisclosure(db,orgId,'us_bank_account');
    const method=await getAutopayMethod(db,orgId);
    return {available:true,principal:invoice.balance,fee:quote.feeAmount,currency:'USD',disclosureHash:disclosure.hash,
      consentText:`I authorize a bank payment of USD ${invoice.balance}, plus a processing fee of USD ${quote.feeAmount}, for this invoice. ${disclosure.text}`,
      methodStatus:method?.type==='us_bank_account'&&['active','pending_verification'].includes(method.status)?method.status:null};
  });
}
export async function startInvoiceBankSetup(input:{invoiceId:string;orgId:string;terms:z.infer<typeof bankPaySchema>;
  returnTo:'public'|'portal';ip:string|null;userAgent:string|null}){
  assertNoHeldDbContextForStripe('startInvoiceBankSetup');
  const offer=await getBankAutopayOffer(input.invoiceId,input.orgId);
  if(!offer||offer.principal!==input.terms.principal||offer.fee!==input.terms.fee
    ||offer.currency!==input.terms.currency||offer.disclosureHash!==input.terms.disclosureHash){
    throw new InvoiceServiceError('The terms changed. Review them and try again.',409,'INVALID_STATE');
  }
  const authority=await withSystemDbAccessContext(async()=>{
    const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,input.orgId)).limit(1).for('update');
    const [org]=await db.select().from(organizations).where(eq(organizations.id,input.orgId)).limit(1);
    if(!enrollment||!org)throw new InvoiceServiceError('Automatic payments unavailable',404,'INVALID_STATE');
    const contactEmail=resolveBillingEmail(org.billingContact);
    if(!contactEmail)throw new InvoiceServiceError('A billing contact is required',409,'INVALID_STATE');
    const token=await mintBillingLinkToken(db,{orgId:org.id,invoiceId:input.invoiceId,enrollmentId:enrollment.id,
      generation:enrollment.generation,purpose:'enroll',ttlDays:1});
    return {tokenId:token.id,contactEmail};
  });
  return withBankSetupTerms({invoiceId:input.invoiceId,orgId:input.orgId,principal:offer.principal,fee:offer.fee,
    currency:offer.currency,disclosureHash:offer.disclosureHash},()=>withAcceptedAutopayDisclosure(offer.disclosureHash,
    ()=>createAutopaySetupSession({orgId:input.orgId,methodType:'us_bank_account',consentAccepted:true,
      returnTo:input.returnTo,tokenId:authority.tokenId,contactEmail:authority.contactEmail,ip:input.ip,userAgent:input.userAgent})));
}
```
In `setupSession.ts`, import `getBankSetupTerms` from `./clientPaymentAuthority` and merge the following block after W2 validates its disclosure, before the setup-attempt insert:
```ts
const bankPayment=getBankSetupTerms();
if(bankPayment && (bankPayment.orgId!==org.id||bankPayment.disclosureHash!==disclosure.hash||input.methodType!=='us_bank_account')){
  throw new InvoiceServiceError('Bank setup authority changed',409,'INVALID_STATE');
}
```
Add `bankPayment: bankPayment ?? null` to the persisted `consentSnapshot`. In `createHostedAutopaySession` extend its private argument with `consentSnapshot: unknown`; after its existing metadata declaration add:
```ts
const bank=(attempt.consentSnapshot as {bankPayment?:{invoiceId:string;principal:string;fee:string;currency:string}}).bankPayment;
const paymentMetadata=bank?{invoice_id:bank.invoiceId,principal_minor:String(toMinorUnits(bank.principal,bank.currency)),
  fee_minor:String(toMinorUnits(bank.fee,bank.currency)),currency:bank.currency}:{};
```
Import `toMinorUnits` from `../stripeMoney`. Use `metadata:{...metadata,...paymentMetadata}` and `setup_intent_data:{metadata:{...metadata,...paymentMetadata}}`; append `${bank?'&bank=1':''}` to the existing success URL. In `setupCompletion.ts` change only the token-consumption predicate to `if(attempt.tokenId && !(attempt.consentSnapshot as {bankPayment?:unknown}).bankPayment)`; method persistence and generation fences remain unchanged.

In both existing pay handlers, parse the request body once, preserve W2's card schema when `body.methodType !== 'us_bank_account'`, and insert the bank branch after the existing invoice/token/org admission and before any card-Checkout work. Public branch, using the existing authorized `inv`:
```ts
if(body.methodType==='us_bank_account'){
  const terms=bankPaySchema.parse(body);
  const result=terms.phase==='setup'
    ? await startInvoiceBankSetup({invoiceId:inv.id,orgId:inv.orgId,terms,returnTo:'public',
      ip:getTrustedClientIpOrUndefined(c)??null,userAgent:c.req.header('user-agent')??null})
    : await collectAfterBankSetup({invoiceId:inv.id,orgId:inv.orgId,setupSessionId:terms.setupSessionId!});
  return c.json({data:result});
}
```
Portal branch, after its verified authorized `inv` load:
```ts
if(body.methodType==='us_bank_account'){
  const terms=bankPaySchema.parse(body);
  const result=terms.phase==='setup'
    ? await startInvoiceBankSetup({invoiceId:inv.id,orgId:inv.orgId,terms,returnTo:'portal',
      ip:getTrustedClientIpOrUndefined(c)??null,userAgent:c.req.header('user-agent')??null})
    : await collectAfterBankSetup({invoiceId:inv.id,orgId:inv.orgId,setupSessionId:terms.setupSessionId!});
  return c.json(result);
}
```
Import the three bank helpers from the new module and `getTrustedClientIpOrUndefined` from `services/clientIp` using each route's relative path. Convert Zod failure to 400 through the existing `zValidator` admission rather than leaving `.parse` exceptions as 500: use a discriminated union between the strict bank schema and W2's ordinary-card/pay-and-save schema at the existing JSON boundary, then `body` is its validated result. Add `bankAutopay: await getBankAutopayOffer(inv.id,inv.orgId)` only after GET has authorized the same invoice. All provider calls remain outside the completed request context.

`bankPayment.ts` exports this verified completion adapter:
```ts
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { invoices, billingLinkTokens, orgAutopayEnrollments } from '../../db/schema';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import { getPartnerStripeClient } from '../partnerStripe';
import { completeAutopaySetup } from './enrollmentService';
import { getAutopayMethod } from './paymentMethods';
import { withClientPaymentAuthority } from './clientPaymentAuthority';
import { attemptCollection } from './collectionEngine';
import { fromMinorUnits, toMinorUnits } from '../stripeMoney';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
export async function collectAfterBankSetup(input: { invoiceId: string; orgId: string; setupSessionId: string }) {
  assertNoHeldDbContextForStripe('collectAfterBankSetup');
  const invoice = await withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(invoices).where(and(eq(invoices.id, input.invoiceId),
      eq(invoices.orgId, input.orgId))).limit(1);
    if (!row) throw new Error('Invoice unavailable');
    return row;
  });
  const { stripe, stripeAccountId } = await withSystemDbAccessContext(() => getPartnerStripeClient(invoice.partnerId));
  const session = await runOutsideDbContext(() => stripe.checkout.sessions.retrieve(input.setupSessionId));
  if (session.mode !== 'setup' || session.metadata?.invoice_id !== invoice.id
    || session.metadata.org_id !== invoice.orgId || !session.metadata.token_id) throw new Error('Setup binding mismatch');
  const completion = await completeAutopaySetup(invoice.partnerId, { checkoutSessionId: session.id });
  if (completion.outcome !== 'activated') return { attemptId: null, outcome: 'deferred' as const, reason: completion.outcome };
  const authority = await withSystemDbAccessContext(async () => {
    const [token] = await db.select().from(billingLinkTokens).where(eq(billingLinkTokens.id, session.metadata!.token_id!)).limit(1);
    const [enrollment] = await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1);
    const method = await getAutopayMethod(db, invoice.orgId);
    if (!token || token.invoiceId !== invoice.id || token.orgId !== invoice.orgId
      || token.generation !== enrollment?.generation || token.consumedAt || token.revokedAt
      || token.expiresAt <= new Date() || enrollment.stripeAccountId !== stripeAccountId
      || String(enrollment.generation) !== session.metadata!.generation
      || method?.type !== 'us_bank_account' || method.status !== 'active') throw new Error('Bank authorization unavailable');
    const [setup]=await db.select().from(autopaySetupAttempts).where(and(
      eq(autopaySetupAttempts.checkoutSessionId,session.id),eq(autopaySetupAttempts.orgId,invoice.orgId),
      eq(autopaySetupAttempts.stripeAccountId,stripeAccountId),eq(autopaySetupAttempts.tokenId,token.id))).limit(1);
    const accepted=(setup?.consentSnapshot as {bankPayment?:{invoiceId:string;principal:string;fee:string;currency:string}}|undefined)?.bankPayment;
    if(!accepted||accepted.invoiceId!==invoice.id||accepted.currency!==invoice.currencyCode||setup?.generation!==enrollment.generation){
      throw new Error('Bank payment consent unavailable');
    }
    const principalMinor = toMinorUnits(accepted.principal,accepted.currency);
    const feeMinor = toMinorUnits(accepted.fee,accepted.currency);
    if(String(principalMinor)!==session.metadata!.principal_minor||String(feeMinor)!==session.metadata!.fee_minor){
      throw new Error('Bank payment metadata differs from accepted consent');
    }
    if (!Number.isSafeInteger(principalMinor) || principalMinor <= 0 || !Number.isSafeInteger(feeMinor) || feeMinor < 0
      || session.metadata!.currency !== invoice.currencyCode) throw new Error('Invalid authorized amount');
    return { tokenId: token.id, invoiceId: invoice.id, generation: enrollment.generation,
      methodId: method.id, principal: fromMinorUnits(principalMinor, invoice.currencyCode),
      fee: fromMinorUnits(feeMinor, invoice.currencyCode), currency: invoice.currencyCode };
  });
  return withClientPaymentAuthority(authority, () => attemptCollection({ invoiceId: invoice.id, initiatedBy: 'client_on_session' }));
}
```
W2's actual implementation owners are `setupSession.ts#prepareAutopayCapture` / `createHostedAutopaySession` and `setupCompletion.ts#completeAutopaySetup`; `enrollmentService.ts` is the export hub. Preserve its public signatures. Import `withAcceptedAutopayDisclosure` from `./consentText` and wrap the setup call with the submitted server-issued `disclosureHash`. W2 validates that hash against `buildAutopayDisclosure`; never accept the enrollment checkbox without that authority.

Setup phase: authorized public invoice token or portal identity resolves the invoice; short transaction mints an `enroll` token bound to invoice/org/enrollment/generation with TTL 1 day. Pass its `tokenId` to W2’s unchanged `createAutopaySetupSession`. In that function, when `tokenId` resolves to an invoice-bound token, read the invoice’s current balance, call `quoteProcessingFee`, and add server-computed `invoice_id`, `principal_minor`, `fee_minor`, and `currency` to its existing setup session metadata. Also bind `setup_intent_data.metadata`; both are created server-side. Persist the same values in `autopaySetupAttempts.consentSnapshot.bankPayment` before the provider call. Extend the private hosted-session argument with `consentSnapshot: unknown` and derive metadata exclusively from that durable snapshot. Its return URL preserves W2’s `/autopay/return?session_id={CHECKOUT_SESSION_ID}&target=${returnTo}` and appends `&bank=1` only for this invoice-bound bank flow; these query fields are provider return protocol, not transient tab state. `setupCompletion` consumes ordinary enroll tokens as before but leaves an invoice-bound token with `consentSnapshot.bankPayment` unconsumed until reserve; only that typed snapshot authorizes the exception. Display that exact amount and fee before consent; if the amount changes between display and POST, return 409 for a fresh consent screen.

After setup return, show “Bank account saved — pay USD … now” and require the explicit collect POST. If microdeposits are pending, show pending and no pay button; after verification the client can return and authorize again. Neither `completeAutopaySetup`, the setup sweep, nor a GET may initiate payment. The current invoice may predate enrollment; this is precisely why `client_on_session` has no schedule. Existing future-invoice enrollment remains active.

Extend only the existing `/invoices/public/:token/pay` and `/portal/invoices/:id/pay` handlers; card/default branch remains unchanged. Portal retains `portalAuth` plus CSRF, public retains invoice-token validation plus origin/rate protections. Revalidate org and invoice after setup return; a `setupSessionId` is an identifier, never authorization by itself. Preserve the respective `{data:{url}}` and `{url}` setup response envelopes.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/bankPayment.test.ts`; `cd apps/api && npx vitest run src/routes/invoicesPublic.test.ts src/routes/portal/invoices.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/bankPayment.ts apps/api/src/services/autopay/bankPayment.test.ts apps/api/src/services/autopay/clientPaymentAuthority.ts apps/api/src/services/autopay/setupSession.ts apps/api/src/services/autopay/setupCompletion.ts apps/api/src/services/autopay/collectionEngine.ts apps/api/src/routes/invoicesPublic.ts apps/api/src/routes/portal/invoices.ts apps/api/src/routes/portal/paymentMethods.ts`; `git commit -m "feat(billing): bind immediate bank payments to explicit invoice consent"`.

### Task 17: Token confirmation API and Confirm page (W4b)
**Files:** Create `apps/api/src/services/autopay/confirmPayment.ts`, `apps/api/src/services/autopay/confirmPayment.test.ts`, `apps/portal/src/pages/autopay/[token]/confirm.astro`; Modify prerequisite `apps/api/src/routes/autopay/public.ts`, `apps/api/src/routes/autopay/mount.test.ts`, `apps/portal/src/pages/autopay/actions.test.ts`, `apps/portal/src/components/portal/AutopayActionPage.test.tsx`. Page shell: `apps/portal/src/layouts/PublicDocumentLayout.astro`, shared module `apps/portal/src/components/portal/AutopayActionPage.tsx`.
**Interfaces:** Consumes C4 token resolver; produces private `confirmInvoicePayment(token: string): Promise<{url?:string;processing?:boolean;paid?:boolean}>`. GET `/autopay/public/:token/confirm` reads only; POST invokes this service. Confirm token resolves the exact attempt through Task 13’s frozen tokenId/attemptId binding.

- [ ] **Step 1: Write the failing test** — actual page source composition test:
```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it.each(['confirm'])('%s page hydrates the action module', action => {
  const source = readFileSync(new URL(`./[token]/${action}.astro`, import.meta.url), 'utf8');
  expect(source).toContain('AutopayActionPage');
  expect(source).toContain(`action="${action}"`);
  expect(source).toContain('client:load');
  expect(source).toContain('PublicDocumentLayout');
});
```

API test: GET with `requires_action` never calls Stripe confirm/cancel/create; POST with a raced `processing` result does not create replacement; cancellation timeout leaves original authority untouched. POST with canceled original returns the public invoice document URL and consumes the exact token once; no second PI or Checkout session is created by confirm POST.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/portal && npx vitest run src/pages/autopay/actions.test.ts src/components/portal/AutopayActionPage.test.tsx`; `cd apps/api && npx vitest run src/services/autopay/confirmPayment.test.ts src/routes/autopay/mount.test.ts`.
- [ ] **Step 3: Implement** — no Stripe.js or publishable key is added. The confirm POST algorithm is cancel-before-replace:
```ts
// confirmPayment.ts
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { billingNoticeOutbox, billingLinkTokens, invoiceCollectionAttempts, invoices } from '../../db/schema';
import { resolveBillingLinkToken } from './linkTokens';
import { loadAttempt, applyAttemptOutcome } from './collectionEngine';
import { getPartnerStripeClient } from '../partnerStripe';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
export async function confirmInvoicePayment(token: string): Promise<{url?:string;processing?:boolean;paid?:boolean}> {
  assertNoHeldDbContextForStripe('confirmInvoicePayment');
  const binding = await withSystemDbAccessContext(async () => {
    const link = await resolveBillingLinkToken(db, token, 'confirm_payment');
    if (!link?.invoiceId) throw new Error('Link unavailable');
    const [notice] = await db.select().from(billingNoticeOutbox).where(and(
      eq(billingNoticeOutbox.invoiceId, link.invoiceId), eq(billingNoticeOutbox.orgId, link.orgId),
      eq(billingNoticeOutbox.kind, 'payment_failed'),
      sql`${billingNoticeOutbox.rendered}->'frozen'->>'tokenId' = ${link.id}`,
    )).limit(1);
    const frozen = notice?.rendered as { frozen?: { attemptId?: string } } | undefined;
    if (!frozen?.frozen?.attemptId) throw new Error('Link unavailable');
    return { link, attemptId: frozen.frozen.attemptId };
  });
  const data = await loadAttempt(binding.attemptId);
  if (binding.link.enrollmentId !== data.enrollment.id || binding.link.generation !== data.enrollment.generation) {
    throw new Error('Link unavailable');
  }
  if (data.attempt.invoiceId !== binding.link.invoiceId || data.attempt.orgId !== binding.link.orgId) throw new Error('Link unavailable');
  const { stripe } = await withSystemDbAccessContext(() => getPartnerStripeClient(data.invoice.partnerId, {
    stripeAccountId: data.mapping!.stripeAccountId, credentialId: data.mapping!.revocationCredentialId,
    invoiceStripePaymentId: data.mapping!.id, reason: 'client_confirmation',
  }));
  const pi = await runOutsideDbContext(() => stripe.paymentIntents.retrieve(data.attempt.stripePaymentIntentId!));
  if (pi.status === 'succeeded' || pi.status === 'processing') {
    await applyAttemptOutcome(data.invoice.partnerId, data.attempt.id);
    if (pi.status === 'processing') return { processing: true };
    const settled = await loadAttempt(data.attempt.id);
    if (settled.attempt.state === 'unapplied') throw new Error('Payment received but needs billing review');
    return { paid: !!settled.mapping?.invoicePaymentId };
  }
  if (pi.status !== 'canceled') {
    const canceled = await runOutsideDbContext(() => stripe.paymentIntents.cancel(pi.id));
    if (canceled.status !== 'canceled') throw new Error('Payment is still processing');
  }
  await withSystemDbAccessContext(async () => {
    await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, data.invoice.id)).for('update');
    await db.update(invoiceCollectionAttempts).set({ state: 'canceled', updatedAt: new Date() })
      .where(and(eq(invoiceCollectionAttempts.id, data.attempt.id), eq(invoiceCollectionAttempts.state, 'requires_action')));
  });
  return withSystemDbAccessContext(async () => {
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id,data.invoice.id)).limit(1).for('update');
    const link = await getOrMintInvoiceLink(invoice!);
    await db.update(billingLinkTokens).set({ consumedAt: new Date() })
      .where(eq(billingLinkTokens.id, binding.link.id));
    return { url: buildPublicInvoiceUrl(link.token) };
  });
}
```
After verified cancellation return the existing public invoice document URL; its normal Pay button owns replacement card Checkout. `createInvoicePayLink` includes an expiry quantum in its idempotency key, so a stable suffix alone would not dedupe confirm POSTs across hours. No replacement Checkout is created by this token endpoint. Reconcile/cancel refusal never releases local state. The replacement is fee-free under the v1 card Checkout rule. Hard ACH failures use an update-method token, not this card replacement flow.

The existing W2 public router owns the `/confirm` GET/POST. Its GET returns `{state,amount,currency}` derived through the exact frozen binding, no provider call. Its POST calls `confirmInvoicePayment`, returns `result` directly, and uses the same safe token errors as Skip. Add those requests to the production-mounted app tests.
```ts
publicAutopayRoutes.get('/:token/confirm',boundary('confirm_payment'),gate,async c=>{
  const result=await withSystemDbAccessContext(async()=>{
    const link=await resolveBillingLinkToken(db,c.req.param('token'),'confirm_payment');
    if(!link?.invoiceId)return null;
    const [notice]=await db.select().from(billingNoticeOutbox).where(and(
      eq(billingNoticeOutbox.invoiceId,link.invoiceId),eq(billingNoticeOutbox.orgId,link.orgId),
      eq(billingNoticeOutbox.kind,'payment_failed'),sql`${billingNoticeOutbox.rendered}->'frozen'->>'tokenId'=${link.id}`)).limit(1);
    const attemptId=(notice?.rendered as {frozen?:{attemptId?:string}}|undefined)?.frozen?.attemptId;
    if(!attemptId)return null;
    const [attempt]=await db.select().from(invoiceCollectionAttempts).where(and(eq(invoiceCollectionAttempts.id,attemptId),
      eq(invoiceCollectionAttempts.invoiceId,link.invoiceId),eq(invoiceCollectionAttempts.orgId,link.orgId))).limit(1);
    return attempt?{state:attempt.state,amount:attempt.principalAmount,currency:attempt.currency}:null;
  });
  return result?c.json(result):c.json({error:'Link unavailable'},404);
});
publicAutopayRoutes.post('/:token/confirm',boundary('confirm_payment'),gate,publicJsonPost,async c=>{
  try{return c.json(await confirmInvoicePayment(c.req.param('token')));}
  catch{return c.json({error:'Payment could not be confirmed. Refresh the invoice to check its status.'},409);}
});
```
Import the two attempt/outbox tables, `and`, `eq`, `sql`, and `confirmInvoicePayment` at their verified module paths. The GET stays read-only even for a terminal attempt. The POST owns its short contexts; the W4 self-managed route entry prevents a held request transaction from spanning Stripe.

Create the confirm page (the shared component and Skip page landed in Task 7):

```astro
---
import PublicDocumentLayout from '../../../layouts/PublicDocumentLayout.astro';
import AutopayActionPage from '../../../components/portal/AutopayActionPage';
const { token } = Astro.params;
---
<PublicDocumentLayout title="Confirm payment">
  <AutopayActionPage token={token!} action="confirm" client:load />
</PublicDocumentLayout>
```
No SSR token API request, no GET mutation, no token logging. Stop remains the existing W2 page. Both action pages use the shared module already mounted and tested in W4a.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/portal && npx vitest run src/pages/autopay/actions.test.ts src/components/portal/AutopayActionPage.test.tsx`; `cd apps/api && npx vitest run src/services/autopay/confirmPayment.test.ts src/routes/autopay/mount.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/confirmPayment.ts apps/api/src/services/autopay/confirmPayment.test.ts apps/api/src/routes/autopay/public.ts apps/api/src/routes/autopay/mount.test.ts 'apps/portal/src/pages/autopay/[token]/confirm.astro' apps/portal/src/pages/autopay/actions.test.ts apps/portal/src/components/portal/AutopayActionPage.test.tsx`; `git commit -m "feat(billing): confirm token actions before hosted payment replacement"`.

### Task 18: Mount Charge now with short request contexts (W4b)
**Files:** Modify `apps/api/src/routes/invoices/autopay.ts`, `apps/api/src/routes/autopay/mount.test.ts`, `apps/api/src/middleware/selfManagedDbContextRoutes.ts`, `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts`, `apps/api/src/services/invoiceService.ts`, `apps/web/src/components/billing/InvoiceDetail.tsx`, `apps/web/src/components/billing/InvoiceDetail.autopay.test.tsx`, `apps/web/src/components/billing/InvoiceWorkspace.test.tsx`. Production shell: `apps/web/src/components/billing/InvoiceWorkspace.tsx`; page `apps/web/src/pages/billing/invoices/[id].astro`.
**Interfaces:** Consumes exact C4 `attemptCollection` with `initiatedBy:'msp_charge_now'`, `withAuthDbAccessContext<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T>`, `invoiceActorFrom(c)`. Produces C7 POST `/invoices/:id/autopay/charge-now` and `canChargeNow` projection.

- [ ] **Step 1: Write the failing test**:
```ts
import { expect, it } from 'vitest';
import { isSelfManagedDbContextRoute } from './selfManagedDbContextRoutes';
it('only opts the network-bearing charge POST out of ambient context', () => {
  expect(isSelfManagedDbContextRoute('POST', '/api/v1/invoices/abc/autopay/charge-now')).toBe(true);
  expect(isSelfManagedDbContextRoute('PATCH', '/api/v1/invoices/abc/autopay')).toBe(false);
});
```
Add to mounted-app tests: authenticated INVOICES_WRITE caller, valid org/site, current eligible schedule, notice sent too recently → 409 and no Stripe; no schedule → 409; wrong org → 403/404 with no revocation; eligible → service receives exact schedule ID and `msp_charge_now`. Browser composition test clicks `autopay-charge-now`, observes POST, and asserts 409 error toast rather than a success refresh.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/routes/autopay/mount.test.ts src/middleware/selfManagedDbContextRoutes.test.ts`; `cd apps/web && npx vitest run src/components/billing/InvoiceDetail.autopay.test.tsx src/components/billing/InvoiceWorkspace.test.tsx`.
- [ ] **Step 3: Implement** — self-managed entry:
```ts
{ method: 'POST', pattern: /^\/api\/v1\/invoices\/[^/]+\/autopay\/charge-now\/?$/ },
```
Add to the already-mounted `invoiceAutopayRoutes` (imports `withAuthDbAccessContext`, `invoices`, `invoiceAutopaySchedules`, `eq`, `requireInvoiceAccess`, `InvoiceServiceError`, `attemptCollection`):
```ts
invoiceAutopayRoutes.post('/:id/autopay/charge-now',
  requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action),
  zValidator('param', z.object({ id: z.string().uuid() })), async c => {
    try {
      const actor = invoiceActorFrom(c);
      const scheduleId = await withAuthDbAccessContext(c.get('auth'), async () => {
        const [invoice] = await db.select().from(invoices).where(eq(invoices.id, c.req.valid('param').id)).limit(1);
        if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
        requireInvoiceAccess(actor, invoice);
        if (!await isAutopayEnabledForPartner(db, invoice.partnerId)) {
          throw new InvoiceServiceError('Automatic payments unavailable', 404, 'INVOICE_NOT_FOUND');
        }
        const [schedule] = await db.select().from(invoiceAutopaySchedules)
          .where(eq(invoiceAutopaySchedules.invoiceId, invoice.id)).limit(1);
        if (!schedule?.eligible) throw new InvoiceServiceError('Invoice has no eligible notice', 409, 'INVALID_STATE');
        return schedule.id;
      });
      const result = await attemptCollection({ invoiceId: c.req.valid('param').id,
        scheduleId, initiatedBy: 'msp_charge_now' });
      if (result.outcome !== 'created') return c.json({ error: result.reason, code: result.reason }, 409);
      return c.json({ data: result });
    } catch (error) { return handleServiceError(c, error); }
  });
```
For exact C7 gate semantics, invoke `requireAutopayEnabled()` in a short-context middleware before the handler, or factor its read-only check into this short context and return its exact `404 {error:'autopay_not_enabled'}` body. Do not wrap the whole handler in the normal context-bearing gate. The normal permission/auth middleware still runs; only its automatic transaction is disabled for this exact route.

`getInvoice` computes `canChargeNow` from open invoice, eligible scheduled/retry schedule, matching active enrollment generation, active usable method, gate/readiness, no active attempt, `noticeSentAt` plus full lead met. It does not require `collectOn ≤ today` for a manual Charge now, but never bypasses notice lead or retry deadline. The service is authoritative if the UI projection goes stale.

Add to `InvoiceDetail` inside the existing autopay panel:
```tsx
<button type="button" data-testid="autopay-charge-now"
  disabled={!can('invoices', 'write') || !detail.autopay.canChargeNow}
  onClick={async () => {
    try {
      await runAction({ request: () => fetchWithAuth(`/invoices/${invoice.id}/autopay/charge-now`, { method: 'POST' }),
        errorFallback: t('autopay.chargeFailed'), successMessage: t('autopay.chargeStarted'), onUnauthorized: UNAUTHORIZED });
      await onChanged();
    } catch (error) { handleActionError(error, t('autopay.chargeFailed')); }
  }}>{t('autopay.chargeNow')}</button>
```
Disable while the request is pending to prevent duplicate clicks; the DB reservation remains the concurrency guard. Never say “paid” from the POST response: ACH may be processing. `runAction` success says “Payment attempt started”.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/routes/autopay/mount.test.ts src/middleware/selfManagedDbContextRoutes.test.ts`; `cd apps/web && npx vitest run src/components/billing/InvoiceDetail.autopay.test.tsx src/components/billing/InvoiceWorkspace.test.tsx`, then the production app smoke in Task 21.
- [ ] **Step 5: Commit** — `git add apps/api/src/routes/invoices/autopay.ts apps/api/src/routes/autopay/mount.test.ts apps/api/src/middleware/selfManagedDbContextRoutes.ts apps/api/src/middleware/selfManagedDbContextRoutes.test.ts apps/api/src/services/invoiceService.ts apps/web/src/components/billing/InvoiceDetail.tsx apps/web/src/components/billing/InvoiceDetail.autopay.test.tsx apps/web/src/components/billing/InvoiceWorkspace.test.tsx`; `git commit -m "feat(billing): mount notice-gated Charge now"`.

### Task 19: Compose bank payment, list status, and partner attention UI (W4b)
**Files:** Create `apps/portal/src/components/portal/BankAutopayPayment.tsx`, `apps/portal/src/components/portal/BankAutopayPayment.test.tsx`; Modify prerequisite `apps/portal/src/pages/autopay/return.astro`, `apps/portal/src/pages/autopay/actions.test.ts`; Modify `apps/portal/src/lib/api.ts`, `apps/portal/src/components/portal/PublicInvoiceView.tsx`, `apps/portal/src/components/portal/InvoiceDetailView.tsx`, prerequisite `apps/web/src/components/billing/AutopayListPage.tsx`, prerequisite `apps/api/src/services/autopay/enrollmentViews.ts`, `apps/web/src/components/billing/autopayClient.ts`, `apps/web/src/components/billing/InvoiceDetail.tsx`; Test `apps/portal/src/components/portal/PublicInvoiceView.autopay.test.tsx` (new), `apps/portal/src/components/portal/InvoiceDetailView.test.tsx`, prerequisite `apps/web/src/components/billing/AutopayListPage.test.tsx`. Composition pages: `apps/portal/src/pages/invoice/[token].astro`, `apps/portal/src/pages/invoices/[id].astro`, prerequisite `apps/web/src/pages/billing/autopay.astro`. Modify the eight billing and eight settings locale paths enumerated individually in the File map; preserve existing W2 group copy and add only W4 keys.
**Interfaces:** Bank pay phases from Task 16; C9 attention event names; existing C7 GET `/billing/autopay` gains lastCharge `{state,createdAt,principalAmount,currency}` and awaitingNotice `{count,oldestCreatedAt,reason,invoiceId}`. No additional settings home or query-param tab state.

- [ ] **Step 1: Write the failing test** — add to existing portal fixture tests before rendering the new button:
```tsx
it('mounts bank pay only when the server offers it', () => {
  const data = detail([]);
  render(<InvoiceDetailView detail={{ ...data, bankAutopay: { available: true, fee: '0.00' } }} />);
  expect(screen.getByTestId('autopay-bank-pay')).toBeTruthy();
});
```
Add public view tests with mocked GET invoice data and `bankAutopay.available:true`; click invokes setup phase only after the existing consent control is checked. Pending verification response displays `autopay-bank-pending` and has no charge button. A newly active method displays `autopay-bank-confirm-pay`, and clicking it sends collect with the server-verified setup session ID. The app never posts `client_on_session` directly.

Autopay list page tests: last-charge processing row, final failure row, unapplied banner, and a 24-hour-old awaiting-notice row. Assert `autopay-last-charge`, `autopay-notice-stuck`, and `autopay-unapplied-banner` on the real page, not a mocked child. A cross-org caller never receives another org’s last charge.
Before implementation, create this component test (in addition to the parent-page tests above):
```tsx
// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
vi.mock('@/lib/api',()=>({apiGet:vi.fn(),apiPost:vi.fn()}));
vi.mock('@/lib/navigation',()=>({navigateTo:vi.fn()}));
import {apiGet,apiPost} from '@/lib/api';
import {navigateTo} from '@/lib/navigation';
import BankAutopayPayment from './BankAutopayPayment';
const offer={available:true,principal:'100.00',fee:'0.00',currency:'USD',consentText:'Authorize payment and future automatic payments.',
  disclosureHash:'a'.repeat(64),methodStatus:null} as const;
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();window.history.replaceState({},'','/');});
afterEach(cleanup);
it('requires consent and stores continuation before Stripe redirect',async()=>{
  vi.mocked(apiPost).mockResolvedValue({data:{data:{url:'https://checkout.stripe.com/c/setup/example'}}});
  render(<BankAutopayPayment target={{invoiceId:'invoice-1',publicToken:'token-1'}} offer={offer}/>);
  expect(screen.getByTestId('autopay-bank-pay')).toBeDisabled();
  fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(screen.getByTestId('autopay-bank-pay'));
  await waitFor(()=>expect(navigateTo).toHaveBeenCalled());
  expect(apiPost).toHaveBeenCalledWith('/invoices/public/token-1/pay',expect.objectContaining({phase:'setup',disclosureHash:offer.disclosureHash}),{redirectOnUnauthorized:false});
  expect(JSON.parse(sessionStorage.getItem('autopay-bank-return')!)).toEqual({invoiceId:'invoice-1',publicToken:'token-1'});
});
it('return reads only until the explicit payment confirmation',async()=>{
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1'}));
  window.history.replaceState({},'','/autopay/return?bank=1&session_id=cs_bank_one');
  vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'active'}}});
  vi.mocked(apiPost).mockResolvedValue({data:{outcome:'created',attemptId:'attempt-1'}});
  render(<BankAutopayPayment returning/>);await screen.findByTestId('autopay-bank-confirm-pay');
  expect(apiPost).not.toHaveBeenCalled();fireEvent.click(screen.getByTestId('autopay-bank-consent'));
  fireEvent.click(screen.getByTestId('autopay-bank-confirm-pay'));
  await waitFor(()=>expect(apiPost).toHaveBeenCalledWith('/portal/invoices/invoice-1/pay',expect.objectContaining({phase:'collect',setupSessionId:'cs_bank_one'}),{redirectOnUnauthorized:true}));
});
it('pending verification has no charge button or mutation on refresh',async()=>{
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',setupSessionId:'cs_pending'}));
  vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'pending_verification'}}});
  render(<BankAutopayPayment returning/>);await screen.findByTestId('autopay-bank-pending');
  expect(screen.queryByTestId('autopay-bank-confirm-pay')).toBeNull();fireEvent.click(screen.getByTestId('autopay-bank-refresh'));
  await waitFor(()=>expect(apiGet).toHaveBeenCalledTimes(2));expect(apiPost).not.toHaveBeenCalled();
});
```
Run `cd apps/portal && npx vitest run src/components/portal/BankAutopayPayment.test.tsx` and observe the missing component failure before creating it.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/portal && npx vitest run src/components/portal/BankAutopayPayment.test.tsx src/components/portal/PublicInvoiceView.autopay.test.tsx src/components/portal/InvoiceDetailView.test.tsx`; `cd apps/web && npx vitest run src/components/billing/AutopayListPage.test.tsx`.
- [ ] **Step 3: Implement** — extend the existing typed API methods with optional bank input; default `{}` preserves the card callers. Keep `apiPost` rather than raw portal fetch so cookies/CSRF remain intact:
```ts
export type BankPayInput = {
  methodType: 'us_bank_account'; phase: 'setup' | 'collect'; consentAccepted: true; disclosureHash: string;
  principal: string; fee: string; currency: string; setupSessionId?: string;
};
```
The public method is `payPublicInvoice(token, input?: SaveForAutopayInput | BankPayInput)` using `/invoices/public/${encodeURIComponent(token)}/pay`; portal method is `payInvoice(id, config = {}, input?: SaveForAutopayInput | BankPayInput)` using `/portal/invoices/${id}/pay`. Keep existing optional `config` position for portal callers. Extend response types with `{attemptId?:string;outcome?:string;reason?:string}` without removing URL envelopes.

Create a dedicated `BankAutopayPayment.tsx`; W2’s `AutopaySetupPage` has no fixed-method or callback props, so it is not an embeddable invoice-payment component. Both authorized GET projections add this DTO from server-read policy and invoice balance:
```ts
export interface BankAutopayOffer {
  available:boolean;principal:string;fee:string;currency:string;consentText:string;disclosureHash:string;
  methodStatus:'active'|'pending_verification'|null;
}
```
Extend `InvoiceDetail` and `PublicInvoiceDetail` in `apps/portal/src/lib/api.ts` with `bankAutopay?: BankAutopayOffer|null`. GET returns an offer only for payable USD invoices, a requested/active enrollment, ACH-enabled policy, live charging gate, ready same-account Stripe connection, and no existing collection reservation. Principal/fee and the enrollment disclosure come from `quoteProcessingFee` and W2 `buildAutopayDisclosure`; the setup POST must compare all submitted terms against that fresh server result. A returned setup can render its verification status even if another payment has since made collection unavailable.

Implementation:
```tsx
import {useEffect,useState} from 'react';
import {apiGet,apiPost,type ApiResponse,type BankAutopayOffer} from '@/lib/api';
import {runAction} from '@/lib/runAction';
import {navigateTo} from '@/lib/navigation';
type Target={invoiceId:string;publicToken?:string};
type View={target:Target;offer:BankAutopayOffer;setupSessionId?:string};
type Result={url?:string;attemptId?:string|null;outcome?:'created'|'deferred'|'refused';reason?:string};
const key='autopay-bank-return';
const path=(target:Target)=>target.publicToken?`/invoices/public/${encodeURIComponent(target.publicToken)}`:`/portal/invoices/${encodeURIComponent(target.invoiceId)}`;
function unwrap<T>(response:ApiResponse<T|{data:T}>,publicRequest:boolean):ApiResponse<T>{
  return {...response,data:publicRequest?(response.data as {data?:T}|undefined)?.data:response.data as T|undefined};
}
async function read(target:Target){
  type Data={invoice:{id:string};bankAutopay?:BankAutopayOffer|null};
  return unwrap(await apiGet<Data|{data:Data}>(path(target),{redirectOnUnauthorized:!target.publicToken}),!!target.publicToken);
}
export default function BankAutopayPayment({target,offer,returning=false}:{target?:Target;offer?:BankAutopayOffer|null;returning?:boolean}){
  const [view,setView]=useState<View|null>(target&&offer?{target,offer}:null);
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[finished,setFinished]=useState(false);
  const [message,setMessage]=useState(''),[failed,setFailed]=useState(false);
  const outcome=(text:string,error:boolean)=>{setMessage(text);setFailed(error);};
  useEffect(()=>{if(!returning){setView(target&&offer?{target,offer}:null);setAccepted(false);}},
    [target?.invoiceId,target?.publicToken,offer?.disclosureHash,returning]);
  useEffect(()=>{
    if(!returning)return;let canceled=false;
    try{
      const stored=JSON.parse(sessionStorage.getItem(key)??'null') as (Target&{setupSessionId?:string})|null;
      const session=new URLSearchParams(window.location.search).get('session_id')??stored?.setupSessionId;
      if(!stored||typeof stored.invoiceId!=='string'||(stored.publicToken!==undefined&&typeof stored.publicToken!=='string')||!session||!/^cs_[A-Za-z0-9_]+$/.test(session))throw new Error();
      sessionStorage.setItem(key,JSON.stringify({...stored,setupSessionId:session}));
      void read(stored).then(response=>{
        if(canceled)return;
        if(response.data?.invoice.id!==stored.invoiceId||!response.data.bankAutopay)throw new Error();
        setView({target:stored,offer:response.data.bankAutopay,setupSessionId:session});
      }).catch(()=>{if(!canceled)outcome('Could not reload the invoice. Refresh to try again.',true);});
    }catch{outcome('This return is incomplete. Open the invoice and try again.',true);}
    return()=>{canceled=true;};
  },[returning]);
  async function refresh(){
    if(!view||busy)return;setBusy(true);
    try{const result=await read(view.target);if(!result.data?.bankAutopay)throw new Error();
      setView({...view,offer:result.data.bankAutopay});setAccepted(false);
    }catch{outcome('Could not check verification.',true);}finally{setBusy(false);}
  }
  async function submit(){
    if(!view||!accepted||busy||finished)return;setBusy(true);
    const collecting=!!view.setupSessionId;
    if(!collecting){try{sessionStorage.setItem(key,JSON.stringify(view.target));}
      catch{outcome('Enable session storage to return securely.',true);setBusy(false);return;}}
    const result=await runAction<Result>({request:async()=>unwrap(await apiPost<Result|{data:Result}>(`${path(view.target)}/pay`,{
      methodType:'us_bank_account',phase:collecting?'collect':'setup',consentAccepted:true,disclosureHash:view.offer.disclosureHash,
      principal:view.offer.principal,fee:view.offer.fee,currency:view.offer.currency,...(collecting?{setupSessionId:view.setupSessionId}:{}),
    },{redirectOnUnauthorized:!view.target.publicToken}),!!view.target.publicToken),onOutcome:outcome,
      successMessage:collecting?'Payment request checked.':'Opening secure bank setup…',errorFallback:'Could not start bank payment.',
      validate:value=>collecting?['created','deferred','refused'].includes(value.outcome??''):
        typeof value.url==='string'&&value.url.startsWith('https://checkout.stripe.com/')});
    setBusy(false);if(!result)return;
    if(!collecting&&result.url){void navigateTo(result.url);return;}
    if(result.outcome==='created'){try{sessionStorage.removeItem(key);}catch{}setFinished(true);
      outcome('Bank payment started. Processing may take several days.',false);return;}
    if(result.reason==='pending_verification'){setView({...view,offer:{...view.offer,methodStatus:'pending_verification'}});
      setAccepted(false);outcome('Bank verification is pending. No payment has started.',false);return;}
    outcome('Payment has not started. Refresh the invoice to check its status.',true);
  }
  if(!view)return returning?<p role="status" data-testid="autopay-bank-return-status">{message||'Loading invoice…'}</p>:null;
  if(!view.offer.available)return <p data-testid="autopay-bank-unavailable">Bank payment is unavailable for this invoice.</p>;
  const pending=!!view.setupSessionId&&view.offer.methodStatus==='pending_verification';
  return <section data-testid="autopay-bank-module" className="space-y-3">
    <h2>Pay by bank and set up autopay</h2>
    <p>Invoice payment: {view.offer.currency} {view.offer.principal}. Processing fee: {view.offer.currency} {view.offer.fee}.</p>
    {message&&<p role={failed?'alert':'status'} data-testid="autopay-bank-result">{message}</p>}
    {pending&&!finished?<div data-testid="autopay-bank-pending"><p>Bank verification is pending. No payment has started.</p>
      <button type="button" data-testid="autopay-bank-refresh" disabled={busy} onClick={()=>void refresh()}>Refresh verification</button></div>
      :!finished&&<><label><input type="checkbox" data-testid="autopay-bank-consent" checked={accepted} disabled={busy}
        onChange={event=>setAccepted(event.target.checked)}/>{view.offer.consentText}</label>
        <button type="button" data-testid={view.setupSessionId?'autopay-bank-confirm-pay':'autopay-bank-pay'} disabled={busy||!accepted}
          onClick={()=>void submit()}>{view.setupSessionId?'Pay this invoice now':'Pay by bank and set up autopay'}</button></>}
  </section>;
}
```
Mount inside each invoice page’s existing payable area, importing the real component:
```tsx
// PublicInvoiceView, whose existing props include token and whose loaded detail has invoice
<BankAutopayPayment target={{invoiceId:invoice.id,publicToken:token}} offer={detail.bankAutopay}/>
// InvoiceDetailView
<BankAutopayPayment target={{invoiceId:invoice.id}} offer={detail.bankAutopay}/>
```
Modify prerequisite `apps/portal/src/pages/autopay/return.astro` to compose the return module; keep W2 enrollment return as the default:
```astro
---
import PublicDocumentLayout from '../../layouts/PublicDocumentLayout.astro';
import AutopaySetupPage from '../../components/portal/AutopaySetupPage';
import BankAutopayPayment from '../../components/portal/BankAutopayPayment';
const bank=Astro.url.searchParams.get('bank')==='1';
---
<PublicDocumentLayout title="Confirm automatic payment setup">
  {bank?<BankAutopayPayment returning client:load/>:<AutopaySetupPage mode="return" client:load/>}
</PublicDocumentLayout>
```
Add a page-source assertion in `pages/autopay/actions.test.ts` for `return.astro` containing `BankAutopayPayment`, `returning`, and `client:load`; the real component tests above assert `autopay-bank-module`. Session storage is continuation context only: API identity, account, generation, invoice, fresh consent, and atomic token consumption remain authoritative. Never route ACH through a payment-mode Checkout.

In W2 `listAutopayEnrollments` (`services/autopay/enrollmentViews.ts`), after its verified `rows` query and before its `Promise.all`, add:
```ts
const authorizedOrgIds = rows.map(({org}) => org.id);
if (!authorizedOrgIds.length) return [];
const latest = await db.selectDistinctOn([invoiceCollectionAttempts.orgId], { orgId: invoiceCollectionAttempts.orgId,
  state: invoiceCollectionAttempts.state, createdAt: invoiceCollectionAttempts.createdAt,
  principalAmount: invoiceCollectionAttempts.principalAmount, currency: invoiceCollectionAttempts.currency,
}).from(invoiceCollectionAttempts).where(inArray(invoiceCollectionAttempts.orgId, authorizedOrgIds))
  .orderBy(invoiceCollectionAttempts.orgId, desc(invoiceCollectionAttempts.createdAt), desc(invoiceCollectionAttempts.id));
const lastByOrg = new Map<string, (typeof latest)[number]>();
for (const attempt of latest) if (!lastByOrg.has(attempt.orgId)) lastByOrg.set(attempt.orgId, attempt);
```
Compute the other two projections in the same authorized-org scope:
```ts
const waiting=await db.select({orgId:invoiceAutopaySchedules.orgId,invoiceId:invoiceAutopaySchedules.invoiceId,
  reason:invoiceAutopaySchedules.stateReason,createdAt:billingNoticeOutbox.createdAt,
}).from(invoiceAutopaySchedules).leftJoin(billingNoticeOutbox,eq(billingNoticeOutbox.id,invoiceAutopaySchedules.noticeOutboxId))
  .where(and(inArray(invoiceAutopaySchedules.orgId,authorizedOrgIds),eq(invoiceAutopaySchedules.state,'awaiting_notice')))
  .orderBy(asc(billingNoticeOutbox.createdAt),asc(invoiceAutopaySchedules.id));
const attentionByOrg=new Map<string,{count:number;oldestCreatedAt:string;reason:string|null;invoiceId:string}>();
for(const row of waiting){
  const missing=row.reason==='no_billing_contact';
  if(!missing&&(!row.createdAt||Date.now()-row.createdAt.getTime()<24*3_600_000))continue;
  const prior=attentionByOrg.get(row.orgId);
  if(prior)prior.count++;
  else attentionByOrg.set(row.orgId,{count:1,oldestCreatedAt:(row.createdAt??new Date()).toISOString(),reason:row.reason,invoiceId:row.invoiceId});
}
const unapplied=await db.select({orgId:invoiceCollectionAttempts.orgId,n:sql<number>`count(*)::int`})
  .from(invoiceCollectionAttempts).where(and(inArray(invoiceCollectionAttempts.orgId,authorizedOrgIds),
    eq(invoiceCollectionAttempts.state,'unapplied'))).groupBy(invoiceCollectionAttempts.orgId);
const unappliedByOrg=new Map(unapplied.map(row=>[row.orgId,row.n]));
```
Add `invoiceCollectionAttempts`, `invoiceAutopaySchedules`, `billingNoticeOutbox` schema imports and `asc`, `desc`, `sql` Drizzle imports. In each row’s final object include `lastCharge:lastByOrg.get(org.id)??null`, `awaitingNotice:attentionByOrg.get(org.id)??null`, and `unappliedCount:unappliedByOrg.get(org.id)??0`. No unscoped aggregate is joined back into a scoped list.

The query uses one latest row per authorized org; retain the leading org-ID ordering required by `DISTINCT ON`. Join `billing_notice_outbox` for `awaiting_notice` age: “stuck” means oldest pending/failed notice is at least **24 hours** old, or `stateReason='no_billing_contact'` immediately. Do not infer age from `collectOn`. Return failure reason and an invoice link so staff can fix delivery. Add an org-filtered unapplied count and banner link to those invoices; keep the banner visible until refund/reconciliation closes the attempt, even if the rollout gate is disabled afterward.

Extend `AutopayRow` in prerequisite `apps/web/src/components/billing/autopayClient.ts` with the following fields. In `listAutopayEnrollments` use `lastCharge: lastByOrg.get(org.id) ?? null` in each already-scoped returned row; serialize Dates through the existing JSON response.
```ts
lastCharge: {state:string;createdAt:string;principalAmount:string;currency:string}|null;
awaitingNotice: {count:number;oldestCreatedAt:string;reason:string|null;invoiceId:string}|null;
unappliedCount: number;
```
Compute the banner count in the list component as `const unappliedCount = rows.reduce((sum,row) => sum + row.unappliedCount,0);`. Keep W2's temporary `lastChargeResult:null` until its existing consumers are migrated, then remove that private placeholder property in the same task.

Concrete list cells and banner:
```tsx
<td data-testid="autopay-last-charge">{row.lastCharge
  ? t(`autopay.attemptStates.${row.lastCharge.state}`, { defaultValue: row.lastCharge.state })
  : t('autopay.noCharge')}</td>
{row.awaitingNotice?.count > 0 && <a data-testid="autopay-notice-stuck"
  href={`/billing/invoices/${row.awaitingNotice.invoiceId}`}>{t('autopay.noticeStuck')}</a>}
{unappliedCount > 0 && <div role="status" data-testid="autopay-unapplied-banner">
  {t('autopay.unapplied', { count: unappliedCount })}
</div>}
```
Add these English keys to each existing billing locale: `failed`, `chargeFailed`, `chargeStarted`, `chargeNow`, `noCharge`, `noticeStuck`, `unapplied`, plus all attempt-state labels. Use English values in non-English locales; `localeParity.test.ts` requires equal keys, so runtime fallback alone is insufficient. Keep existing page/sidebar mounts; no new settings registry entry is warranted because these are operational screens already registered by W2.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/portal && npx vitest run src/components/portal/BankAutopayPayment.test.tsx src/components/portal/PublicInvoiceView.autopay.test.tsx src/components/portal/InvoiceDetailView.test.tsx`; `cd apps/web && npx vitest run src/components/billing/AutopayListPage.test.tsx`; `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/portal/src/components/portal/BankAutopayPayment.tsx apps/portal/src/components/portal/BankAutopayPayment.test.tsx apps/portal/src/pages/autopay/return.astro apps/portal/src/pages/autopay/actions.test.ts apps/portal/src/lib/api.ts apps/portal/src/components/portal/PublicInvoiceView.tsx apps/portal/src/components/portal/PublicInvoiceView.autopay.test.tsx apps/portal/src/components/portal/InvoiceDetailView.tsx apps/portal/src/components/portal/InvoiceDetailView.test.tsx apps/web/src/components/billing/AutopayListPage.tsx apps/web/src/components/billing/AutopayListPage.test.tsx apps/api/src/services/autopay/enrollmentViews.ts apps/web/src/components/billing/autopayClient.ts apps/web/src/components/billing/InvoiceDetail.tsx apps/web/src/locales`; `git commit -m "feat(billing): compose bank payment and collection attention views"`.

### Task 20: Prove locks, crash recovery, generation fencing, and all issue producers (W4b)
**Files:** Create `apps/api/src/services/autopay/charging.integration.test.ts`; Modify `apps/api/vitest.integration.config.ts`, `apps/api/vitest.config.ts`, `apps/api/src/services/invoiceService.issue.integration.test.ts`, `apps/api/src/__tests__/integration/quoteAccept.integration.test.ts`, `apps/api/src/__tests__/integration/contractWorker.integration.test.ts`.
**Interfaces:** Uses actual `createPartner(options?)`, `createOrganization({partnerId})` from `src/__tests__/integration/db-utils.ts`; never imports local helpers from another test file. Tests C4 functions against real Postgres with provider calls mocked at `getPartnerStripeClient` only.

- [ ] **Step 1: Write the failing test** — author these assertions before implementing their owning collection stages (Tasks 10–12); this task groups their real-DB execution and fixture ownership, not test-after-code development:
```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, hasDbAccessContext } from '../../db';
import { createPartner, createOrganization } from '../../__tests__/integration/db-utils';
import { partners, invoices, orgAutopayEnrollments, orgPaymentMethods, invoiceAutopaySchedules,
  invoiceCollectionAttempts, invoiceStripePayments, stripeConnectAccounts } from '../../db/schema';
import { encryptSecret } from '../secretCrypto';
import { attemptCollection, resumeCollectionAttempt, applyAttemptOutcome } from './collectionEngine';
import { recordPayment } from '../invoiceService';
import { createInvoicePayLink } from '../invoiceCheckout';
const provider = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), confirm: vi.fn(), cancel: vi.fn(),
  sessionCreate: vi.fn(), sessionExpire: vi.fn(), sessionRetrieve: vi.fn() }));
vi.mock('../partnerStripe', async importOriginal => ({
  ...(await importOriginal<typeof import('../partnerStripe')>()),
  getPartnerStripeClient: vi.fn(async () => ({ stripeAccountId: 'acct_autopay_test', defaultCurrency: 'USD',
    stripe: { paymentIntents: { create: provider.create, retrieve: provider.retrieve, confirm: provider.confirm, cancel: provider.cancel },
      checkout: { sessions: { create: provider.sessionCreate, expire: provider.sessionExpire, retrieve: provider.sessionRetrieve } } } })),
}));
vi.mock('../invoiceEvents', () => ({ emitInvoiceEvent: vi.fn() }));
vi.mock('../../jobs/accountingSyncWorker', () => ({ enqueueAccountingInvoicePush: vi.fn(), enqueueAccountingInvoiceVoid: vi.fn(),
  enqueueAccountingPaymentPush: vi.fn(), enqueueAccountingPaymentDelete: vi.fn() }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn() }));
let currentPi: any;
beforeEach(() => {
  vi.clearAllMocks();
  provider.create.mockImplementation(async (params, options) => {
    expect(hasDbAccessContext()).toBe(false);
    if (!currentPi) currentPi = { ...params, id: 'pi_autopay_test', status: 'requires_confirmation', amount_received: 0,
      last_payment_error: null, latest_charge: null, created: Math.floor(Date.now()/1000) };
    expect(options.idempotencyKey).toMatch(/^autopay_/);
    return currentPi;
  });
  provider.retrieve.mockImplementation(async () => { expect(hasDbAccessContext()).toBe(false); return currentPi; });
  provider.confirm.mockImplementation(async () => {
    expect(hasDbAccessContext()).toBe(false);
    currentPi = { ...currentPi, status: 'processing' }; return currentPi;
  });
  provider.cancel.mockImplementation(async () => { currentPi = { ...currentPi, status: 'canceled' }; return currentPi; });
  currentPi = null;
});
async function fixture() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await db.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, partner.id));
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner.id,
      stripeAccountId: 'acct_autopay_test', status: 'connected', accountCountry: 'US', defaultCurrency: 'USD',
      apiKey: encryptSecret(['sk','test','fixture_only'].join('_')), autopayMissingPermissions: [],
      autopayCapabilitiesCheckedAt: new Date() }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id,
      status: 'active', generation: 1, stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId,
      stripeCustomerId: 'cus_autopay_test', effectiveFrom: new Date('2020-01-01T00:00Z'), requestedAt: new Date() }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: org.id, enrollmentId: enrollment!.id,
      stripePaymentMethodId: 'pm_autopay_test', type: 'card', cardBrand: 'visa', cardLast4: '4242', cardFunding: 'credit',
      status: 'active', isAutopayMethod: true }).returning();
    const today = new Date().toISOString().slice(0,10);
    const [invoice] = await db.insert(invoices).values({ partnerId: partner.id, orgId: org.id,
      invoiceNumber: `TEST-${randomUUID()}`, currencyCode: 'USD', status: 'sent', issueDate: today, dueDate: today,
      total: '100.00', balance: '100.00', amountPaid: '0.00' }).returning();
    const [schedule] = await db.insert(invoiceAutopaySchedules).values({ orgId: org.id, invoiceId: invoice!.id,
      enrollmentId: enrollment!.id, enrollmentGeneration: 1, eligible: true, collectOn: today,
      state: 'scheduled', noticeSentAt: new Date(Date.now()-20*86_400_000), attemptCount: 0,
      termsSnapshot: { issuedAt: new Date().toISOString(), offsetDays: 0, rule: 'later', cap: {enabled:false},
        methodType:'card', methodId:method!.id, last4:'4242', methodLabel:'Visa ••4242', accountHolderType:null,
        noticeLeadDays:1, principal:'100.00', currency:'USD', feeAmount:'0.00', feeKind:'none',
        cardFeeBps:0, achFeeAmount:'0.00', chargeDate:today, noticeSeq:1 } }).returning();
    return { partner, org, enrollment:enrollment!, method:method!, invoice:invoice!, schedule:schedule!,
      actor:{userId:null,partnerId:partner.id,accessibleOrgIds:[org.id]} };
  });
}
async function attempts(invoiceId:string) {
  return withSystemDbAccessContext(() => db.select().from(invoiceCollectionAttempts)
    .where(eq(invoiceCollectionAttempts.invoiceId,invoiceId)));
}
it('holds a real reservation against manual and pay-link producers', async () => {
  const f = await fixture();
  const result = await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  expect(result.outcome).toBe('created');
  const ctx = {scope:'partner' as const,orgId:null,accessibleOrgIds:[f.org.id],accessiblePartnerIds:[f.partner.id]};
  await expect(withDbAccessContext(ctx, () => recordPayment(f.invoice.id, {
    amount:100, method:'cash', receivedAt:new Date().toISOString().slice(0,10),
  },f.actor))).rejects.toMatchObject({status:409});
  await expect(createInvoicePayLink(f.invoice.id,f.actor)).rejects.toMatchObject({status:409});
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(provider.sessionCreate).not.toHaveBeenCalled();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('processing');
});
it('two collection workers reserve exactly one attempt', async () => {
  const f = await fixture();
  const input = {invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler' as const};
  const results = await Promise.all([attemptCollection(input),attemptCollection(input)]);
  expect(results.filter(r=>r.outcome==='created')).toHaveLength(1);
  expect(await attempts(f.invoice.id)).toHaveLength(1);
  expect(provider.create).toHaveBeenCalledTimes(1);
});
it('recovers a lost create response with the same key and one provider PI', async () => {
  const f = await fixture();
  const normal = provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async (...args) => { await normal(...args); throw new Error('response lost'); });
  await expect(attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'})).rejects.toThrow('response lost');
  const [attempt] = await attempts(f.invoice.id);
  expect(attempt!.state).toBe('reserved'); expect(provider.confirm).not.toHaveBeenCalled();
  await resumeCollectionAttempt(attempt!.id);
  expect(provider.create.mock.calls[0]![1].idempotencyKey).toBe(provider.create.mock.calls[1]![1].idempotencyKey);
  expect((await attempts(f.invoice.id))[0]!.stripePaymentIntentId).toBe('pi_autopay_test');
});
it('recovers a crash after mapping commit but before confirm without creating again', async () => {
  const f = await fixture();
  provider.confirm.mockRejectedValueOnce(new Error('process stopped'));
  await expect(attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'})).rejects.toThrow();
  const [attempt] = await attempts(f.invoice.id);
  expect(attempt!.invoiceStripePaymentId).toBeTruthy();
  await resumeCollectionAttempt(attempt!.id);
  expect(provider.create).toHaveBeenCalledTimes(1);
});
it('preserves captured money as unapplied after an out-of-band void', async () => {
  const f = await fixture();
  const result = await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  // Deliberately bypass the normal void guard to model an external/admin inconsistency.
  await withSystemDbAccessContext(()=>db.update(invoices).set({status:'void'}).where(eq(invoices.id,f.invoice.id)));
  currentPi = {...currentPi,status:'succeeded',amount_received:10000};
  await applyAttemptOutcome(f.partner.id,result.attemptId!);
  expect((await attempts(f.invoice.id))[0]!.state).toBe('unapplied');
  const [mapping] = await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments)
    .where(eq(invoiceStripePayments.invoiceId,f.invoice.id)));
  expect(mapping!.invoicePaymentId).toBeNull();
});
it('does not confirm when a late payment closes the invoice after reservation',async()=>{
  const f=await fixture();const normal=provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async(...args)=>{
    const pi=await normal(...args);
    // Model the ledger state committed by an older provider-success replay under its invoice lock.
    await withSystemDbAccessContext(()=>db.update(invoices).set({status:'paid',amountPaid:'100.00',balance:'0.00'})
      .where(eq(invoices.id,f.invoice.id)));
    return pi;
  });
  await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  expect(provider.confirm).not.toHaveBeenCalled();expect(provider.cancel).toHaveBeenCalledTimes(1);
  expect((await attempts(f.invoice.id))[0]!.state).toBe('canceled');
});
it('does not confirm an old enrollment generation after create', async () => {
  const f = await fixture();
  const normal = provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async (...args) => {
    const pi = await normal(...args);
    await withSystemDbAccessContext(()=>db.update(orgAutopayEnrollments).set({generation:2})
      .where(eq(orgAutopayEnrollments.id,f.enrollment.id)));
    return pi;
  });
  await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  expect(provider.confirm).not.toHaveBeenCalled();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('canceled');
});
```
Do not skip this suite when `DATABASE_URL` is missing: the explicit integration runner/setup must fail to start. Extend the same fixture with row-lock barriers for manual-first, autopay-first, and a Checkout mapping inserted after revocation but before reservation. A race assertion checks the losing producer never calls Stripe, not just that only one ledger payment was booked after two real charges.

Add the three issue-path assertions to the **existing real-DB cases** listed below. Seed an enrollment in `requested` status to avoid needing a Stripe setup in issue-path tests; the invariant is that every enrollment row produces a schedule, including ineligible `not_enrolled`:
```ts
await db.insert(orgAutopayEnrollments).values({orgId,partnerId,status:'requested',generation:1,requestedAt:new Date()});
```
Use W1’s nullable pre-setup Stripe fields; requested enrollment cannot require a Stripe customer/account that does not yet exist.

- `invoiceService.issue.integration.test.ts`, case `assembles, numbers, freezes, flips source rows to billed`: local `seedFixture()`, `actor(f)`, `ctx(f)`, `dayBefore()`, `dayAfter()` already exist. Seed the enrollment for `f.orgId/f.partnerId`; after `svc.issueInvoice(invoice.id, actor(f))`, assert one schedule for `issued.id`.
- `quoteAccept.integration.test.ts`, case `issues the converted invoice (sent + number + balance) so it is immediately payable`: local `seed()`, `ctxFor`, `actorFor` already exist. Seed before `acceptQuote({quoteId:created.id,signerName:'Jane Buyer'})`; assert one schedule for `res.invoiceId`. Its recurring-only case asserts zero schedules because the converted invoice remains draft.
- `contractWorker.integration.test.ts`, case `autoIssue: sweep issues the invoice post-commit; no double-billing on re-sweep`: seed after org creation, preserve `autoIssue:true` and real `createdBy` user. Query invoice ID from `contractBillingPeriods` after `runContractBillingSweep(new Date('2026-07-01T05:00:00Z'))`; assert one schedule, and still one after re-sweep. Do not substitute `contractWorker.renewal.integration.test.ts`: its fixture never auto-issues.

Exact assertion, inline in each existing case with that case’s verified ID binding:
```ts
const schedules = await withSystemDbAccessContext(() => db.select().from(invoiceAutopaySchedules)
  .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)));
expect(schedules).toHaveLength(1);
expect(schedules[0]!.ineligibleReason).toBe('not_enrolled');
```
For the first two cases use `issued.id` and `res.invoiceId` directly, rather than introducing an undefined `invoiceId` variable.
- [ ] **Step 2: Run it, expect FAIL** — before each owning stage is implemented:
```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/charging.integration.test.ts src/services/invoiceService.issue.integration.test.ts src/__tests__/integration/quoteAccept.integration.test.ts src/__tests__/integration/contractWorker.integration.test.ts
```
Expected failure is a missing C4 implementation or the specific reservation/schedule assertion. “No test files found” is a registration failure, not a valid red test.
- [ ] **Step 3: Implement** — register the new colocated suite in the existing `test.include` array:
```ts
'src/services/autopay/charging.integration.test.ts',
```
The three existing issue suites are already registered. Fix the owning implementation until each newly written assertion passes; do not relax the race expectations or mock Drizzle for this task. Add cross-org read/forge cases using `withDbAccessContext` and a second org, stale-generation setup completion after stop, current-generation notice callback fencing, and rollback of schedule/outbox when issue fails its guarded source update. Those are real state transitions, not source-string tests.
- [ ] **Step 4: Run it, expect PASS** — repeat the integration command from Step 2 and check all four files are reported. Then `pnpm test-stack down` from repo root after the final verification run, not while another suite uses it.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/charging.integration.test.ts apps/api/vitest.integration.config.ts apps/api/src/services/invoiceService.issue.integration.test.ts apps/api/src/__tests__/integration/quoteAccept.integration.test.ts apps/api/src/__tests__/integration/contractWorker.integration.test.ts`; `git commit -m "test(billing): prove autopay races recovery and issuance contracts"`.

### Task 21: Verification and Stripe test-mode lab
**Files:** Create `e2e-tests/tests/autopay-charging.spec.ts`; verify all implementation files above. No production migration, secret, real customer, or infrastructure address is added.
**Interfaces:** Uses existing Playwright `test, expect` from `e2e-tests/fixtures`, `authedPage`, and all W04 `autopay-*` test IDs. The application and worker both use the production mounts/registry.

- [ ] **Step 1: Write the failing test** — stack smoke is written before final composition. The test consumes explicit test-mode fixture URLs supplied by the lab; absent fixture data is a failure, not a skip:
```ts
import { test, expect } from '../fixtures';
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing test-mode fixture ${name}`);
  return value;
}
test('invoice panel and scanner-safe public action are mounted', async ({authedPage:page,browser}) => {
  await page.goto(`/billing/invoices/${required('AUTOPAY_TEST_INVOICE_ID')}`);
  await expect(page.getByTestId('autopay-invoice-panel')).toBeVisible();
  await expect(page.getByTestId('autopay-invoice-excluded')).toBeVisible();
  await expect(page.getByTestId('autopay-charge-now')).toBeVisible();
  const client = await browser.newContext();
  const publicPage = await client.newPage();
  const posts: string[] = [];
  publicPage.on('request', request => { if (request.method()==='POST') posts.push(request.url()); });
  await publicPage.goto(required('AUTOPAY_TEST_SKIP_URL'));
  await expect(publicPage.getByTestId('autopay-skip-page')).toBeVisible();
  await expect(publicPage.getByTestId('autopay-skip-submit')).toBeVisible();
  expect(posts).toEqual([]);
  await publicPage.getByTestId('autopay-skip-submit').click();
  await expect(publicPage.getByTestId('autopay-action-result')).toBeVisible();
  expect(posts.some(url=>url.endsWith('/skip'))).toBe(true);
  await client.close();
});
```
Add list, contract, public invoice bank button, logged-in bank button, and confirm page cases using their actual test IDs. Seed via W2’s enrollment setup in a Stripe **test-mode** partner on the isolated worktree stack; never hardcode invoice IDs or public tokens in source. The final lab below supplies these disposable fixture values.
- [ ] **Step 2: Run it, expect FAIL** — `cd e2e-tests && npx playwright test tests/autopay-charging.spec.ts --project=chromium`; before final composition the missing mounted ID is the expected failure.
- [ ] **Step 3: Implement** — complete any missing production mount identified by the smoke. Exact verification commands, run from repo root unless a command explicitly changes directory:
```bash
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec astro check
pnpm --filter @breeze/web exec tsc --noEmit
pnpm --filter @breeze/portal exec astro check
pnpm --filter @breeze/portal exec tsc --noEmit
pnpm --filter @breeze/shared exec tsc --noEmit
```
Targeted unit suites:
```bash
cd apps/api && npx vitest run src/services/autopay/scheduler.test.ts src/services/autopay/chargingNotice.test.ts src/services/autopay/renderBillingNotice.test.ts src/services/autopay/invoiceControls.test.ts src/services/autopay/failureClassifier.test.ts src/services/autopay/retryDates.test.ts src/services/autopay/collectionEngine.test.ts src/services/autopay/paymentNotices.test.ts src/services/autopay/bankPayment.test.ts src/services/autopay/confirmPayment.test.ts src/services/invoiceService.test.ts src/services/quoteAcceptService.test.ts src/services/invoiceResend.test.ts src/services/partnerStripe.test.ts src/services/stripeCredentialArchive.test.ts src/services/stripeReconcile.test.ts src/services/stripeFinancialEventPoller.test.ts src/jobs/stripeReconcileSweep.test.ts src/jobs/contractWorker.test.ts src/jobs/autopayWorker.test.ts src/routes/autopay/mount.test.ts src/routes/invoicesPublic.test.ts src/routes/portal/invoices.test.ts src/routes/contracts/contracts.test.ts src/middleware/selfManagedDbContextRoutes.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts
```
```bash
cd apps/web && npx vitest run src/components/billing/InvoiceDetail.autopay.test.tsx src/components/billing/InvoiceWorkspace.test.tsx src/components/billing/InvoiceActions.test.tsx src/components/contracts/ContractEditor.test.tsx src/components/billing/AutopayListPage.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/settingsPageRegistry.test.ts
cd apps/portal && npx vitest run src/components/portal/AutopayActionPage.test.tsx src/components/portal/BankAutopayPayment.test.tsx src/components/portal/PublicInvoiceView.autopay.test.tsx src/components/portal/InvoiceDetailView.test.tsx src/pages/autopay/actions.test.ts
cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts
```
Real database and tenancy contracts (W1 owns registrations; W4 still proves them):
```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/charging.integration.test.ts src/services/invoiceService.issue.integration.test.ts src/__tests__/integration/quoteAccept.integration.test.ts src/__tests__/integration/contractWorker.integration.test.ts src/__tests__/integration/stripeSessionRevocation.integration.test.ts src/__tests__/integration/stripeSettle.integration.test.ts src/__tests__/integration/stripeReversalState.integration.test.ts src/__tests__/integration/stripeFinancialEventPoller.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```
```bash
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter @breeze/api test:integration-suite-coverage
pnpm db:check-drift
cd apps/api && npx vitest run
```
Check that all expected files ran; no silent `runIf` skips, no “No test files found”, no tests of an empty fake app. Use `pnpm wt-stack up` for the UI/Stripe lab, then:
```bash
cd e2e-tests && npx playwright test tests/autopay-charging.spec.ts --project=chromium
```
- [ ] **Step 4: Run it, expect PASS** — all commands above, then the lab checklist below. Capture the task/PR’s exact test counts, failures, and lab PI IDs in private review evidence, not public source. A real Stripe case that was not run is marked not run, never inferred from mocked tests.
- [ ] **Step 5: Commit** — `git add e2e-tests/tests/autopay-charging.spec.ts`; `git commit -m "test(billing): verify mounted charging flows on the worktree stack"`. Tear down only stacks started for this work: `pnpm test-stack down` and `pnpm wt-stack down`. State what remains running. Do not merge as part of implementing this plan unless separately instructed.

#### Stripe test-mode lab checklist

Run on a disposable partner whose key and account are in test mode. Keep `autopayEnabled` off for unrelated partners. Existing invoice balances, reservations, Stripe object counts, notices and accounting rows are the evidence; a green browser toast is not enough.

- [ ] **4242 success:** enroll card `4242 4242 4242 4242`; issue with no Send; confirm one `invoice_autopay` and no `invoice_send`; after notice lead, charge once. Assert one PI, one principal payment, one receipt, and schedule succeeded.
- [ ] **Authentication:** use `4000 0027 6000 3184`; confirm `requires_action`, no automatic retry, one confirm variant. GET the link repeatedly without state changes; POST replaces only after verified cancellation, then follow the invoice Pay button and complete hosted card authentication.
- [ ] **Insufficient funds:** `4000 0000 0000 9995`; verify card soft classification, attempts on first-attempt day 3 and day 7, new PI per attempt, stable key on replay, final failure and reminder eligibility.
- [ ] **ACH success:** Stripe test bank success account/Financial Connections flow; confirm method type and individual/company classification, USD restriction, correct 10/1-day notice, processing reservation, then settlement after closing the browser. No Checkout payment session accepts ACH.
- [ ] **ACH NSF return:** use Stripe’s current test-bank insufficient-funds scenario; verify structured R01/R09 classification, one retry after three banking days, no third attempt, failed-final notification.
- [ ] **Microdeposits:** select manual verification; pending method never charges. Complete verification, then return and make an explicit bank-pay POST; a background setup completion alone must not charge.
- [ ] **Late return/dispute:** successful bank payment, then test return/dispute; invoice reopens, existing reversal ledger changes once, payment method re-evaluates, `payment.ach_returned` arrives. W4 fee is zero; repeat proportional principal/fee cases only when W5 enables fees.
- [ ] **Notice replacement:** change card to individual bank after notice; old callback cannot authorize it, new notice has ten days, old Skip remains invoice-scoped but cannot reach another generation. Due-date edit re-notices only scheduled rows.
- [ ] **Stop/disable/disconnect:** pause/stop or disable rollout during processing, rotate the key, then disconnect. No new setup or attempt; original PI still settles by account-bound archived credential. Reconnect same account clears only Stripe attention; different account with active enrollments is blocked.
- [ ] **Failure of permissions:** replace key with one lacking PaymentIntents permission. UI shows exact missing capability, no new PI, retained attempts remain visible. Restore a usable same-account key and verify recovery.
- [ ] **Crash boundaries:** stop worker after provider create and before mapping persistence, then after mapping persistence and before confirm. Restart; same attempt/key/PI resumes. An unknown create older than 23 hours is quarantined without a second PI.
- [ ] **Unapplied:** arrange a controlled test-only ledger conflict after capture; attempt becomes unapplied, banner + `payment.unapplied` appear, client gets no false failure/receipt. Refund in Stripe; poller closes the unapplied item.
- [ ] **Race:** hold a Checkout session open while collection runs; completion wins and autopay defers, or revocation wins and Checkout cannot pay. Race manual payment and collection in both orders. Count actual Stripe charges, not just ledger rows.
- [ ] **Tenant/generation:** stale enrollment/setup/skip/confirm token never operates after re-enrollment, and no org/user can view or charge another org’s invoice.

Open rollout risks: W1–W3 have not landed in this authoring checkout, so their implementation-specific context shapes must be verified before coding; provider access can be permanently lost when a key is revoked; staff-email delivery retains the existing staff path’s limitation; legal approval of notice/consent wording and W5’s nonzero-fee allocation remain separate gates. These risks do not justify widening token authority, bypassing notice lead, or charging through a different Stripe account.
