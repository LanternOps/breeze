# Autopay W05: Processing Fee Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let enabled partners disclose and collect optional, bounded autopay processing fees, reverse them exactly, and book them separately in QuickBooks or Xero.
**Architecture:** Open W1’s existing settings contracts and extend W2’s existing forms and disclosures; W4 continues to own reservation, notice, collection, and settlement. Use cumulative integer allocation for reversals and a durable, account-bound accounting operation journal for fee income and refunds, drained by the existing accounting sweep.
**Tech Stack:** TypeScript, Hono, Zod, PostgreSQL/Drizzle with RLS, Vitest, React/Astro, react-i18next, Stripe SDK, QBO and Xero accounting adapters, Playwright.
**Spec:** docs/superpowers/specs/billing/2026-10-01-autopay-design.md · **Index:** docs/superpowers/plans/billing/2026-10-01-autopay-index.md

## Preconditions

**Precondition: W1, W2, W4 merged.** W4 includes its W3 dependency. This is one PR, `feat/autopay-processing-fee`; all tasks land together. Do not expose the fee inputs in a separately shipped PR.

This document is an implementation recipe, not evidence that its commands have run. Commit commands below are for implementation time. Plan authoring creates only this document.

Read the approved prerequisite plans before changing their code:

- `docs/superpowers/plans/billing/2026-10-01-autopay-w01-foundation.md`: Tasks 5/7 settings and routes, 9 principal settlement and reversal, 13 rendering, 16 `quoteProcessingFee`.
- `docs/superpowers/plans/billing/2026-10-01-autopay-w02-enrollment.md`: Tasks 1/7 consent and completion, 3 rendering, 11 customer views, 14 settings, 16/18 portal components and composition.
- `docs/superpowers/plans/billing/2026-10-01-autopay-w03-reminders.md`: Task 7 final Payments composition and ungated reminders.
- `docs/superpowers/plans/billing/2026-10-01-autopay-w04-charging.md`: Tasks 2/3 notices, 10/11 collection, 13 receipts, 14 linked-attempt returns, 16 bank-payment authorization, 17 confirmation, 20 real-DB fixtures.

Those plans, rather than absent files in this checkout, are the evidence for their new symbols. Existing symbols below were checked against this checkout. Re-read the named symbol when implementing; line numbers are not contracts. Recheck `ls apps/api/migrations | sort | tail -1` against C1 before writing migrations. Rename only unshipped W05 migrations if necessary and update every test reference.

## Where this plan corrects or refines the spec/index

1. **Keep the binding fee home.** Spec §10.2/§13 mentions `surchargeRules.ts`; C4 and W1 Task 16 already define `quoteProcessingFee` and `SURCHARGE_STATE_RULES` in `apps/api/src/services/autopay/processingFee.ts`. No competing rule table is created. The rules below are the approved conservative product policy, not a claim of legal advice.
2. **Attestation is a field of the existing partner PUT.** C7 already mounts `billingPaymentSettingsRoutes` (W1 Task 7). Add `feeAttestation: { acquirerAndNetworksNotified30DaysAgo: true, doesNotExceedAcceptanceCost: true }` only to `PartnerPaymentSettingsPatch`. The server derives user/time. No new attestation route, permission, or rollout switch. Both statements must be true in the same request. Saving a nonzero rate without attestation remains allowed but ineffective (`not_attested`).
3. **Consent history and confirmation are different facts.** W2 Task 7’s `persistCapturedAutopayMethod` in `setupCompletion.ts` uses the prospective `snapshot.feeText` even for a verified debit card. Keep the accepted consent snapshot unchanged; use verified funding for confirmation and the enrolled notice. W2 Task 11’s `completeOwnedAutopaySetup` already distinguishes funding. W05 makes their copy consistent.
4. **W1 already protects principal on reversal.** W1 Task 9 adds private `remainingPrincipalMinor` to `stripeReversalState.ts`. Replace it with C4 `allocateReversal`; do not regress its gross comparison or original-method restoration. W4 Task 14’s full-refund handling of unapplied captures also needs the fee counter. Principal accounting partial-refund divergence remains an existing operator-visible limitation; this PR automatically books the fee share only.
5. **The real connection table is partner-axis.** `accountingConnections` in `apps/api/src/db/schema/accounting.ts` has `partnerId`, no `orgId`; `accounting_connections` is absent from `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`). Its two new mapping columns therefore need no org export/cascade/merge entry. The Stripe mapping already has org RLS and lifecycle entries; its new scalar/journal columns do need export classification.
6. **Providers lack fee/refund primitives.** `AccountingProvider` (`services/accounting/types.ts`) has `createPayment` and `deletePayment`, not fee income or refunds. `quickbooksProvider` and `xeroProvider` implement invoice-linked principal payments. Add `postFeeEntry`: QBO SalesReceipt/RefundReceipt; Xero RECEIVE/SPEND BankTransaction. These are cash income/reversal records for the existing customer, never a second receivable or invoice line. Tax defaults to NON/NoTax. Fees require an explicit income item/account and the existing payment/deposit account (Xero also requires the exempt code); a missing mapping parks the fee debt visibly and does not roll back captured money.
7. **Reversal debt survives setting changes.** Initial fee export uses the principal push gates, including auto mode, payment push, currency and activation horizon. Once exported, its refund/restoration debt remains owed even if payment push is disabled; this matches `requestPaymentDelete`/`deletePaymentInAccounting` in `accountingPaymentPush.ts`. Bind every operation to its original connection and remote customer. A replacement connection must never receive old debt. Ambiguous provider writes become adopt-only after the provider’s replay window; never generate a new key to make an error disappear.
8. **No new scheduled job or route.** Extend the already mounted settings routes and `processReconcileSweep` in `jobs/accountingReconcileWorker.ts`. Its fee pass must be independent of payment pull being enabled. Existing `scheduleRegistry`/worker registration is retained and tested. A final composition task verifies all fee controls through their actual page shells.

9. **Preserve completed cross-wave boundaries (CW-11–CW-13).** Task 4 retains W4 Task 16’s integer `feeMinor` authorization comparison after clamping. Task 6 uses W4 Task 14’s linked-attempt bank fixture and verifies withdrawal application before reinstatement. Tasks 11–12 apply the index’s whole-feature rollout gate to accounting fee configuration: use W1’s `isAutopayEnabledForPartner`, expose `autopayEnabled` on the existing authorized accounting status GET, hide fee controls when false, and reject fee-field PATCHes (including null clears and mixed bodies) with `404 autopay_not_enabled`. Ordinary accounting settings, status/debt attention and already-owed debt draining remain available. Refinement 7 permits continued debt processing only; it grants no off-rollout mapping-repair exception.

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


- Card basis points: integer **0–300**; ACH amount: canonical decimal string **0.00–25.00**. Null means inherit; zero is an exemption. Fee attestation is partner-only and records authenticated user + server time.
- Card fees: US Stripe account, USD invoice, known US organization billing state, credit funding only; CA/CT/ME/MA prohibited, CO **200 bps**, other allowed states **300 bps** maximum. Debit/prepaid/unknown funding, unknown geography and non-US accounts have zero card fee. ACH fees require US/USD. No fee on Checkout payment sessions.
- Fee math and reversal allocation use integer minor units/BigInt; decimals become JSON numbers only at the existing provider wire boundary. Charge fee never exceeds the delivered notice fee. Never rewrite delivered notices or accepted consent.
- Settings homes: Payments at partner/org level (one existing home each); fee income mapping only Integrations accounting connection settings (one new concept/home). Use existing page Save; attestation checkboxes are not independently autosaved.
- No new org table, composite org FK, encrypted column, append-only table, or permission is needed. Registration no-ops are explicit in the migration task; do not add phantom allowlist entries.
- Real provider requests in the lab require test/sandbox credentials only. Unit/integration Stripe mocks stay at `getPartnerStripeClient`; pure allocation tests need no Stripe client.

## Review Focus

1. **A fee rises or becomes illegal after notice:** real collection assertions cover noticed upper bound, debit replacement, banned state, CO cap, missing attestation, and a nonzero bank fee exceeding client authorization (Task 4).
2. **Tiny partial refunds, duplicate events, and dispute reinstatement:** cumulative property tests and real reducer tests prove exact conservation and principal-only invoice restoration using a linked bank attempt and an asserted applied withdrawal before reinstatement (Tasks 5–6).
3. **Remote accounting write succeeds but the local acknowledgement is lost:** replay uses one frozen operation/key, stale leases cannot acknowledge successors, and expired ambiguity becomes adopt-only (Tasks 8–10).
4. **A tenant, rollout, or settings boundary is crossed:** org cannot attest; selected-org partner cannot edit defaults; null and zero differ; fee mapping writes and controls are gated while ordinary accounting settings, reminders and existing debt attention/draining remain usable (Tasks 1–2 and 11–12).
5. **Partner edits the template or the customer’s card turns out to be debit:** required fee itemization remains outside editable text and the actual enrollment confirmation says zero without rewriting consent (Task 3).

## File map

Existing W1/W2/W4 files are modified after those waves merge. Each path below is part of the implementation PR; plan authoring changes only this document.

- `packages/shared/src/validators/autopay.ts` — strict nullable fee validators and partner attestation shape.
- `packages/shared/src/validators/autopay.test.ts` — regression tests for autopay.
- `apps/api/src/services/autopay/billingPaymentSettings.ts` — validated fee writes, server attestation provenance and rollout gating.
- `apps/api/src/services/autopay/billingPaymentSettings.test.ts` — regression tests for billingPaymentSettings.
- `apps/api/src/routes/billingPaymentSettings.ts` — validated fee writes, server attestation provenance and rollout gating.
- `apps/api/src/index.autopayRoutes.test.ts` — app-mounted fee authorization and validation regression tests.
- `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` — document the existing settings writer authorization boundary.
- `apps/api/src/services/autopay/paymentSettingsView.ts` — raw, inherited and effective fee projection.
- `apps/api/src/services/autopay/paymentSettingsView.test.ts` — regression tests for paymentSettingsView.
- `apps/web/src/components/billing/PaymentsSettingsTab.tsx` — fee controls, percent display, attestation and reminder-safe Save.
- `apps/web/src/components/billing/PaymentsSettingsTab.test.tsx` — regression tests for PaymentsSettingsTab.
- `apps/web/src/components/billing/OrgPaymentsSettingsSection.tsx` — organization fee overrides in the existing controlled section.
- `apps/web/src/locales/en/billing.json` — fee billing disclosures and attestation copy with locale key parity.
- `apps/web/src/locales/de-DE/billing.json` — fee billing disclosures and attestation copy with locale key parity.
- `apps/web/src/locales/es-419/billing.json` — fee billing disclosures and attestation copy with locale key parity.
- `apps/web/src/locales/fr-CA/billing.json` — fee billing disclosures and attestation copy with locale key parity.
- `apps/web/src/locales/fr-FR/billing.json` — fee billing disclosures and attestation copy with locale key parity.
- `apps/web/src/locales/it-IT/billing.json` — fee billing disclosures and attestation copy with locale key parity.
- `apps/web/src/locales/pt-BR/billing.json` — fee billing disclosures and attestation copy with locale key parity.
- `apps/web/src/locales/tr-TR/billing.json` — fee billing disclosures and attestation copy with locale key parity.
- `apps/api/src/services/autopay/feeDisclosure.ts` — prospective, verified and charged-fee copy.
- `apps/api/src/services/autopay/feeDisclosure.test.ts` — regression tests for feeDisclosure.
- `apps/portal/src/components/portal/AutopaySetupPage.fees.test.tsx` — regression tests for AutopaySetupPage.fees.
- `apps/api/src/services/autopay/consentText.ts` — hash the disclosed prospective fee with new consent.
- `apps/api/src/services/autopay/setupCompletion.ts` — send verified fee text without rewriting accepted consent.
- `apps/api/src/services/autopay/setupCompletion.test.ts` — regression tests for setupCompletion.
- `apps/api/src/services/autopay/customerViews.ts` — return verified method fee confirmation.
- `apps/api/src/services/autopay/chargingNotice.ts` — protected principal-plus-fee notice line.
- `apps/api/src/services/autopay/renderBillingNotice.ts` — protected fee and receipt itemization.
- `apps/api/src/services/autopay/renderBillingNotice.test.ts` — regression tests for renderBillingNotice.
- `apps/portal/src/components/portal/AutopaySetupPage.tsx` — fee confirmation test identifier on the existing setup return view.
- `apps/docs/src/content/docs/features/online-payments.mdx` — processing-fee rules, attestation, accounting and liability documentation.
- `apps/api/src/services/autopay/collectionFee.ts` — integer current-fee/notice ceiling clamp.
- `apps/api/src/services/autopay/collectionFee.test.ts` — regression tests for collectionFee.
- `apps/api/src/services/autopay/collectionEngine.ts` — use the clamp and retain integer fee authorization for W4 bank payments.
- `apps/api/src/services/autopay/charging.integration.test.ts` — real reservation/provider assertions for changed fee eligibility and nonzero bank authorization ceilings.
- `apps/api/src/services/autopay/refundAllocation.ts` — cumulative proportional principal/fee allocation.
- `apps/api/src/services/autopay/refundAllocation.test.ts` — seeded property tests for conservation, residue and full refunds.
- `apps/api/migrations/2026-11-20-140000-accounting-fee-income-mapping.sql` — idempotent partner connection income references with RLS assertions.
- `apps/api/migrations/2026-11-20-140001-processing-fee-reversals.sql` — reversal amount, durable accounting journal, export-safe error and erasure guard.
- `apps/api/src/services/autopay/processingFeeSchema.integration.test.ts` — real-DB migration replay and forced RLS checks.
- `apps/api/src/services/accounting/accountingConnectionService.ts` — round-trip fee income references and reset them on realm change.
- `apps/api/src/services/accounting/accountingConnectionService.test.ts` — regression tests for accountingConnectionService.
- `apps/api/src/db/schema/accounting.ts` — Drizzle fee income reference columns.
- `apps/api/src/db/schema/stripePayments.ts` — Drizzle reversal and journal columns and checks.
- `apps/api/src/services/tenantExportPolicyRegistry.ts` — classify every new org-export column.
- `apps/api/src/services/stripeReversalState.ts` — reverse invoice principal only and persist cumulative fee share.
- `apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts` — real principal-only partial, linked-attempt ACH withdrawal/reinstatement and unapplied reversals.
- `apps/api/src/services/accounting/types.ts` — provider fee entry and durable operation types.
- `apps/api/src/services/accounting/accountingFeeEntry.ts` — stable identity, settings preflight and conservative adoption rules.
- `apps/api/src/services/accounting/accountingFeeEntry.test.ts` — regression tests for accountingFeeEntry.
- `apps/api/src/services/accounting/quickbooksProvider.ts` — separate SalesReceipt and RefundReceipt fee records.
- `apps/api/src/services/accounting/quickbooksProvider.test.ts` — regression tests for quickbooksProvider.
- `apps/api/src/services/accounting/xeroFeeEntries.ts` — RECEIVE/SPEND BankTransaction fee records.
- `apps/api/src/services/accounting/xeroFeeEntries.test.ts` — regression tests for xeroFeeEntries.
- `apps/api/src/services/accounting/xeroProvider.ts` — connect the provider interface to Xero fee writes.
- `apps/api/src/services/accounting/accountingFeePush.ts` — claim, send, adopt and acknowledge account-bound fee debt.
- `apps/api/src/services/accounting/accountingFeePush.integration.test.ts` — real-DB leases, ACK loss, destination binding, repair and erasure.
- `apps/api/src/jobs/accountingReconcileWorker.ts` — drain fee debt independently of payment pull.
- `apps/api/src/jobs/accountingReconcileWorker.test.ts` — regression tests for accountingReconcileWorker.
- `apps/api/vitest.integration.config.ts` — discover the new accounting real-DB suite.
- `apps/api/vitest.config.ts` — exclude the accounting real-DB suite from unit runs.
- `apps/web/src/components/integrations/AccountingFeeSettings.tsx` — one explicit Save for provider-specific income mapping.
- `apps/web/src/components/integrations/AccountingFeeSettings.test.tsx` — regression tests for AccountingFeeSettings.
- `apps/api/src/routes/accounting/index.ts` — gate fee-field PATCHes with W1 rollout and project its flag on authorized accounting status GET; retain ordinary settings and debt attention.
- `apps/api/src/routes/accounting/index.test.ts` — fee mapping rollout-off refusals, ordinary settings and ungated status/debt regressions.
- `apps/web/src/locales/en/integrations.json` — fee accounting mapping and attention copy with locale key parity.
- `apps/web/src/locales/de-DE/integrations.json` — fee accounting mapping and attention copy with locale key parity.
- `apps/web/src/locales/es-419/integrations.json` — fee accounting mapping and attention copy with locale key parity.
- `apps/web/src/locales/fr-CA/integrations.json` — fee accounting mapping and attention copy with locale key parity.
- `apps/web/src/locales/fr-FR/integrations.json` — fee accounting mapping and attention copy with locale key parity.
- `apps/web/src/locales/it-IT/integrations.json` — fee accounting mapping and attention copy with locale key parity.
- `apps/web/src/locales/pt-BR/integrations.json` — fee accounting mapping and attention copy with locale key parity.
- `apps/web/src/locales/tr-TR/integrations.json` — fee accounting mapping and attention copy with locale key parity.
- `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx` — compose the partner fee section through the Payments tab.
- `apps/web/src/components/billing/OrgBillingSettings.tsx` — compose org overrides with the existing page Save.
- `apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx` — regression tests for PartnerBillingSettingsPage.
- `apps/web/src/components/billing/OrgBillingSettings.test.tsx` — regression tests for OrgBillingSettings.
- `apps/web/src/components/integrations/AccountingConnectionPanel.tsx` — mount fee mapping only with rollout enabled; retain durable accounting attention when disabled.
- `apps/web/src/components/integrations/AccountingConnectionPanel.test.tsx` — enabled fee mapping and rollout-off hidden controls with visible ordinary settings/debt attention.
- `apps/web/src/components/integrations/IntegrationsPage.fees.test.tsx` — exercise the real Integrations page and accounting panel.
- `e2e-tests/tests/autopay-processing-fees.spec.ts` — authenticated browser fee-display and Save smoke.

---

### Task 1: Open strict fee settings and record partner attestation atomically
**Files:** Modify `packages/shared/src/validators/autopay.ts`, `packages/shared/src/validators/autopay.test.ts`, `apps/api/src/services/autopay/billingPaymentSettings.ts`, `apps/api/src/services/autopay/billingPaymentSettings.test.ts`, `apps/api/src/routes/billingPaymentSettings.ts`, `apps/api/src/index.autopayRoutes.test.ts`, `apps/api/src/__tests__/partner-wide-write-coverage.test.ts`.
**Interfaces:** Consumes W1 Tasks 5/7 `partnerPaymentSettingsPatchSchema`, `orgPaymentSettingsPatchSchema`, `updatePartnerPaymentSettings(db: Tx, partnerId: string, patch: PartnerPaymentSettingsPatch, actorUserId: string): Promise<void>`, `updateOrgPaymentSettings(db: Tx, orgId: string, patch: OrgPaymentSettingsPatch, actorUserId: string): Promise<void>`. Produces additive nullable `cardFeeBps`, `achFeeAmount`, and partner-only `feeAttestation`; all signatures remain unchanged.

- [ ] **Step 1: Write the failing test** — append to the shared validator suite; replace W1 assertions that intentionally rejected these newly supported fields, retaining rejection of raw provenance and unknown keys:

```ts
const attestation = { acquirerAndNetworksNotified30DaysAgo: true, doesNotExceedAcceptanceCost: true };
it('accepts exact limits, explicit zero and inheritance', () => {
  for (const schema of [partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema]) {
    for (const body of [{ cardFeeBps: 0, achFeeAmount: '0.00' },
      { cardFeeBps: 300, achFeeAmount: '25.00' }, { cardFeeBps: null, achFeeAmount: null }]) {
      expect(schema.parse(body)).toEqual(body);
    }
    for (const body of [{ cardFeeBps: 301 }, { cardFeeBps: -1 }, { cardFeeBps: 1.5 },
      { cardFeeBps: '300' }, { achFeeAmount: '25.01' }, { achFeeAmount: '-0.01' },
      { achFeeAmount: '1e1' }, { achFeeAmount: '1.001' }, { achFeeAmount: 1 },
      { achFeeAmount: '01.00' }, { feeAttestedBy: '11111111-1111-4111-8111-111111111111' },
      { feeAttestedAt: '2026-10-01T00:00:00Z' }]) expect(schema.safeParse(body).success).toBe(false);
  }
});
it('accepts only both affirmative partner statements', () => {
  expect(partnerPaymentSettingsPatchSchema.parse({ feeAttestation: attestation })).toEqual({ feeAttestation: attestation });
  expect(orgPaymentSettingsPatchSchema.safeParse({ feeAttestation: attestation }).success).toBe(false);
  for (const value of [true, false, null, {}, { acquirerAndNetworksNotified30DaysAgo: true },
    { ...attestation, doesNotExceedAcceptanceCost: false }, { ...attestation, extra: true }]) {
    expect(partnerPaymentSettingsPatchSchema.safeParse({ feeAttestation: value }).success).toBe(false);
  }
});
```

Remove W1’s fee-rejection assertions from `autopay.test.ts`, `billingPaymentSettings.test.ts`, and `index.autopayRoutes.test.ts`; retain their rejection of `feeAttestedBy`, `feeAttestedAt`, unknown keys and org attestation. Append these tests to `index.autopayRoutes.test.ts` inside its existing suite. Its `m`, `request`, `partnerPath`, `orgPath`, and `partnerId` are defined in W1 Task 7; these tests hit the exported `app`, not a second test-only router.

```ts
it('opens fee writes only behind the rollout gate and partner authority', async () => {
  const feeAttestation = { acquirerAndNetworksNotified30DaysAgo: true, doesNotExceedAcceptanceCost: true };
  expect((await request(partnerPath, 'PUT', { cardFeeBps: 300 })).status).toBe(404);
  expect(m.partnerWrite).not.toHaveBeenCalled();
  m.enabled = true;
  expect((await request(partnerPath, 'PUT', { cardFeeBps: 300, feeAttestation })).status).toBe(200);
  expect(m.partnerWrite).toHaveBeenCalledWith(expect.anything(), partnerId,
    { cardFeeBps: 300, feeAttestation }, partnerId);
  expect((await request(orgPath, 'PUT', { cardFeeBps: 0, achFeeAmount: '0.00' })).status).toBe(200);
  expect((await request(orgPath, 'PUT', { feeAttestation })).status).toBe(400);
  m.auth.scope = 'organization'; m.auth.orgId = orgId;
  expect((await request(partnerPath, 'PUT', { feeAttestation })).status).toBe(403);
  m.auth.scope = 'partner'; m.auth.partnerOrgAccess = 'selected';
  expect((await request(partnerPath, 'PUT', { feeAttestation })).status).toBe(403);
  m.auth.partnerOrgAccess = 'all'; m.allowed = false;
  expect((await request(partnerPath, 'PUT', { feeAttestation })).status).toBe(403);
  m.auth = null;
  expect((await request(partnerPath, 'PUT', { feeAttestation })).status).toBe(401);
});
```

Append to `billingPaymentSettings.test.ts` (retain the existing `vi`, `it`, `expect` and mutator imports; add `import type { Tx } from './types';` if absent; use this local mock):

```ts
it('stamps only server provenance and leaves existing attestation on ordinary edits', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  try {
    const conflict = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate: conflict }));
    const cx = { insert: vi.fn(() => ({ values })) } as unknown as Tx;
    const partner = '11111111-1111-4111-8111-111111111111';
    const actor = '22222222-2222-4222-8222-222222222222';
    await updatePartnerPaymentSettings(cx, partner, { cardFeeBps: 300,
      feeAttestation: { acquirerAndNetworksNotified30DaysAgo: true, doesNotExceedAcceptanceCost: true } }, actor);
    expect(values).toHaveBeenLastCalledWith({ partnerId: partner, orgId: null, cardFeeBps: 300,
      feeAttestedBy: actor, feeAttestedAt: new Date('2026-10-01T12:00:00Z') });
    expect(conflict.mock.calls[0]![0].set).not.toHaveProperty('feeAttestation');
    await updatePartnerPaymentSettings(cx, partner, { cardFeeBps: 0 }, actor);
    expect(conflict.mock.calls[1]![0].set).toEqual({ cardFeeBps: 0 });
    await expect(updateOrgPaymentSettings(cx, partner, { feeAttestation: {} } as never, actor)).rejects.toThrow();
  } finally { vi.useRealTimers(); }
});
```

- [ ] **Step 2: Run it, expect FAIL** — `(cd packages/shared && npx vitest run src/validators/autopay.test.ts)` and `cd apps/api && npx vitest run src/services/autopay/billingPaymentSettings.test.ts src/index.autopayRoutes.test.ts`. Expected: valid fee fields rejected, no provenance stamp, partner PUT returns 400.
- [ ] **Step 3: Implement** — replace the shared validator file with this complete version; existing exports and cap rules stay intact:

```ts
import { z } from 'zod';
import { ACH_MODES, AUTOPAY_OFFSET_RULES } from '../types/autopay';
import { currencyCodeSchema } from './currency';
const capPattern = /^(0|[1-9]\d{0,9})\.\d{2}$/;
const capAmount = z.string().regex(capPattern)
  .refine(value => capPattern.test(value) && BigInt(value.replace('.', '')) > 0n, 'Cap must be positive');
const achAmount = z.string().regex(/^(0|[1-9]\d?)\.\d{2}$/)
  .refine(value => /^(0|[1-9]\d?)\.\d{2}$/.test(value)
    && BigInt(value.replace('.', '')) <= 2500n, 'ACH fee must be between 0.00 and 25.00');
const fields = {
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
  cardFeeBps: z.number().int().min(0).max(300).nullable().optional(),
  achFeeAmount: achAmount.nullable().optional(),
};
function checkCap(value: { autopayCapEnabled?: boolean | null; autopayCapAmount?: string | null;
  autopayCapCurrency?: string | null }, ctx: z.RefinementCtx) {
  if (value.autopayCapEnabled === true) {
    if (value.autopayCapAmount == null) ctx.addIssue({ code: 'custom', path: ['autopayCapAmount'], message: 'An enabled cap requires amount' });
    if (value.autopayCapCurrency == null) ctx.addIssue({ code: 'custom', path: ['autopayCapCurrency'], message: 'An enabled cap requires currency' });
  } else if (value.autopayCapAmount != null || value.autopayCapCurrency != null
    || (value.autopayCapEnabled === undefined && ('autopayCapAmount' in value || 'autopayCapCurrency' in value))) {
    ctx.addIssue({ code: 'custom', path: ['autopayCapEnabled'], message: 'Supply the complete enabled cap together' });
  }
}
export const partnerPaymentSettingsPatchSchema = z.object({ ...fields,
  feeAttestation: z.object({ acquirerAndNetworksNotified30DaysAgo: z.literal(true),
    doesNotExceedAcceptanceCost: z.literal(true) }).strict().optional(),
}).strict().superRefine(checkCap);
export const orgPaymentSettingsPatchSchema = z.object(fields).strict().superRefine(checkCap);
export type PartnerPaymentSettingsPatch = z.infer<typeof partnerPaymentSettingsPatchSchema>;
export type OrgPaymentSettingsPatch = z.infer<typeof orgPaymentSettingsPatchSchema>;
```

Replace `columns` and the partner mutator; retain the org mutator, which parses the strict org schema first:

```ts
function columns(patch: OrgPaymentSettingsPatch) {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as OrgPaymentSettingsPatch;
  return defined.autopayCapEnabled !== undefined && defined.autopayCapEnabled !== true
    ? { ...defined, autopayCapAmount: null, autopayCapCurrency: null } : defined;
}
export async function updatePartnerPaymentSettings(db: Tx, partnerId: string,
  patch: PartnerPaymentSettingsPatch, actorUserId: string): Promise<void> {
  const { feeAttestation, ...settings } = partnerPaymentSettingsPatchSchema.parse(patch);
  const set = { ...columns(settings), ...(feeAttestation ? {
    feeAttestedBy: actorUserId, feeAttestedAt: new Date(),
  } : {}) };
  if (!Object.keys(set).length) return;
  await db.insert(billingPaymentSettings).values({ partnerId, orgId: null, ...set })
    .onConflictDoUpdate({ target: billingPaymentSettings.partnerId,
      targetWhere: isNotNull(billingPaymentSettings.partnerId), set });
}
```

Add the three new keys to W1’s `autopayFields` in `routes/billingPaymentSettings.ts`, preserving its existing members:

```ts
'cardFeeBps', 'achFeeAmount', 'feeAttestation',
```

Change the existing `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry in `partner-wide-write-coverage.test.ts` to the accurate explanation:

```ts
'services/autopay/billingPaymentSettings.ts': 'C4 settings mutators have one HTTP caller, routes/billingPaymentSettings.ts, which checks billing:manage plus canManagePartnerWidePolicies before partner writes; strict schemas reject owner/provenance writes and org attestation',
```

No new API route is introduced: W1’s `api.route('/', billingPaymentSettingsRoutes)` in `index.ts` stays byte-identical. The app-level test above is mandatory, including when the handler alone is green. Keep the existing audit call for the authorized patch; do not log Stripe secrets.
- [ ] **Step 4: Run it, expect PASS** — `(cd packages/shared && npx vitest run src/validators/autopay.test.ts)`; `cd apps/api && npx vitest run src/services/autopay/billingPaymentSettings.test.ts src/index.autopayRoutes.test.ts src/__tests__/partner-wide-write-coverage.test.ts`.
- [ ] **Step 5: Commit** — implementation time:

```bash
git add packages/shared/src/validators/autopay.ts packages/shared/src/validators/autopay.test.ts apps/api/src/services/autopay/billingPaymentSettings.ts apps/api/src/services/autopay/billingPaymentSettings.test.ts apps/api/src/routes/billingPaymentSettings.ts apps/api/src/index.autopayRoutes.test.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts
git commit -m "feat(billing): accept bounded fees and partner attestation"
```

### Task 2: Extend the existing Payments form with fee inheritance and attestation
**Files:** Modify `apps/api/src/services/autopay/paymentSettingsView.ts`, `apps/api/src/services/autopay/paymentSettingsView.test.ts`, `apps/web/src/components/billing/PaymentsSettingsTab.tsx`, `apps/web/src/components/billing/PaymentsSettingsTab.test.tsx`, `apps/web/src/components/billing/OrgPaymentsSettingsSection.tsx`, `apps/web/src/locales/en/billing.json`, `apps/web/src/locales/de-DE/billing.json`, `apps/web/src/locales/es-419/billing.json`, `apps/web/src/locales/fr-CA/billing.json`, `apps/web/src/locales/fr-FR/billing.json`, `apps/web/src/locales/it-IT/billing.json`, `apps/web/src/locales/pt-BR/billing.json`, `apps/web/src/locales/tr-TR/billing.json`.
**Interfaces:** Consumes W2 Task 14 `paymentSettingsView(connection: typeof db, partnerId: string, orgId?: string)`, `PaymentSettingsView`, `PaymentValues`, `usePaymentSettings(orgId?: string)`, `InheritedField` from `components/shared/InheritedField.tsx`. Produces additive fee projection and `FeeFields`; preserves one Save for each existing page.

- [ ] **Step 1: Write the failing test** — in W2’s `PaymentsSettingsTab.test.tsx`, replace its two fixture declarations with these complete fixtures. W3's hook reads reminder fields even when this test exercises fees. Its existing `mount` and mocked `fetchWithAuth` remain unchanged.

```ts
const inherited = {
  autopayOffsetDays:{value:7,source:'partner'},autopayOffsetRule:{value:'later',source:'partner'},
  autopayCap:{value:{enabled:true,amount:'500.00',currency:'USD'},source:'partner'},
  achMode:{value:'ach_preferred',source:'default'},cardFeeBps:{value:0,source:'default'},
  achFeeAmount:{value:'0.00',source:'default'},feeAttested:false,
  remindersEnabled:{value:false,source:'default'},reminderBeforeDueDays:{value:3,source:'default'},
  reminderRepeatDays:{value:null,source:'default'},overdueReminderEveryDays:{value:7,source:'default'},
};
const values={autopayOffsetDays:null,autopayOffsetRule:null,autopayCapEnabled:null,
  autopayCapAmount:null,autopayCapCurrency:null,achMode:null,cardFeeBps:null,achFeeAmount:null};
```

Append these tests:


```tsx
it('preserves zero overrides and displays the inherited fee', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(init?.method === 'PUT'
    ? { success: true } : { autopayEnabled: true, values: { ...values, cardFeeBps: null, achFeeAmount: null },
      inherited: { ...inherited, cardFeeBps: { value: 300, source: 'partner' }, achFeeAmount: { value: '2.50', source: 'partner' } },
      effective: { ...inherited, feeAttested: true } }));
  mount();
  const card = await screen.findByTestId('autopay-card-fee-bps');
  expect(card).toHaveAttribute('placeholder', '300');
  expect(screen.queryByTestId('autopay-attest-notified')).toBeNull();
  fireEvent.change(card, { target: { value: '0' } });
  fireEvent.change(screen.getByTestId('autopay-ach-fee'), { target: { value: '0.00' } });
  fireEvent.click(screen.getByTestId('autopay-settings-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string)).toMatchObject({ cardFeeBps: 0, achFeeAmount: '0.00' });
});
it('requires both attestation statements when either is checked', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(Response.json({ autopayEnabled: true,
    values: { ...values, cardFeeBps: 300, achFeeAmount: '0.00' },
    inherited: { ...inherited, cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' } },
    effective: { ...inherited, feeAttested: false } }));
  render(<I18nextProvider i18n={i18n}><PaymentsSettingsTab /></I18nextProvider>);
  fireEvent.click(await screen.findByTestId('autopay-attest-notified'));
  expect(screen.getByTestId('autopay-settings-save')).toBeDisabled();
  fireEvent.click(screen.getByTestId('autopay-attest-cost'));
  expect(screen.getByTestId('autopay-settings-save')).not.toBeDisabled();
  expect(screen.getByTestId('autopay-fee-percent')).toHaveTextContent('3.00%');
});
```

Add this to the W2 `paymentSettingsView.test.ts` suite using its `connection`, `mocks`, `partnerId`, `orgId`, and `inherited`:

```ts
it('returns raw zero fee overrides and partner values without flattening them', async () => {
  mocks.resolve.mockResolvedValue({ ...inherited, cardFeeBps: { value: 300, source: 'partner' },
    achFeeAmount: { value: '2.50', source: 'partner' }, feeAttested: true });
  const view = await paymentSettingsView(connection({ cardFeeBps: 0, achFeeAmount: '0.00' }).value, partnerId, orgId);
  expect(view.values).toMatchObject({ cardFeeBps: 0, achFeeAmount: '0.00' });
  expect(view.inherited.cardFeeBps.value).toBe(300);
  expect(view.effective.feeAttested).toBe(true);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/web && npx vitest run src/components/billing/PaymentsSettingsTab.test.tsx`; `cd apps/api && npx vitest run src/services/autopay/paymentSettingsView.test.ts`. Expected: fee inputs absent and raw fee projection absent.
- [ ] **Step 3: Implement** — in `paymentSettingsView`, add to `values` and the partner `inherited` object respectively:

```ts
cardFeeBps: row?.cardFeeBps ?? null,
achFeeAmount: row?.achFeeAmount ?? null,
```

```ts
cardFeeBps: { value: 0, source: 'default' },
achFeeAmount: { value: '0.00', source: 'default' },
```

Retain the effective resolver object, which already includes `feeAttested`; no direct UI read of the settings table is added. Extend `PaymentValues` with `cardFeeBps: number | null; achFeeAmount: string | null;` and `Resolved` with `cardFeeBps: Effective<number>; achFeeAmount: Effective<string>; feeAttested?: boolean;`. Update earlier exact-object projection assertions to include these new keys. Every enabled W2/W3 raw `values` fixture in the listed settings/page tests must include `cardFeeBps:null, achFeeAmount:null`; the exact complete page fixture appears in Task 12. Retain existing non-null fee overrides when a test supplies them.

Add these complete definitions to `PaymentsSettingsTab.tsx`:

```tsx
export type FeeAffirmations = { notified: boolean; cost: boolean };
export function feeValuesInvalid(v: Pick<PaymentValues, 'cardFeeBps' | 'achFeeAmount'>): boolean {
  return (v.cardFeeBps !== null && (!Number.isInteger(v.cardFeeBps) || v.cardFeeBps < 0 || v.cardFeeBps > 300))
    || (v.achFeeAmount !== null && (!/^(0|[1-9]\d?)\.\d{2}$/.test(v.achFeeAmount)
      || BigInt(v.achFeeAmount.replace('.', '')) > 2500n));
}
export function FeeFields({ view, setValues, disabled, affirmations, setAffirmations }: {
  view: PaymentSettingsView; setValues: (patch: Partial<PaymentValues>) => void; disabled: boolean;
  affirmations?: FeeAffirmations; setAffirmations?: (value: FeeAffirmations) => void;
}) {
  const { t } = useTranslation('billing');
  if (!view.autopayEnabled) return null;
  const bps = view.values.cardFeeBps ?? view.inherited.cardFeeBps.value;
  const percent = Number.isInteger(bps) ? `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}%` : '—';
  return <fieldset disabled={disabled} data-testid="autopay-fees" className="space-y-4 border-t pt-4">
    <legend className="font-semibold">{t('autopay.fees.title')}</legend>
    <InheritedField id="autopay-card-fee-bps" data-testid="autopay-card-fee-bps"
      label={t('autopay.fees.cardBps')} value={view.values.cardFeeBps === null ? '' : String(view.values.cardFeeBps)}
      onChange={value => setValues({ cardFeeBps: value === '' ? null : Number(value) })}
      inheritedValue={String(view.inherited.cardFeeBps.value)}
      inheritedSource={t(`autopay.source.${view.inherited.cardFeeBps.source}`)} type="number" min={0} max={300} step="1" />
    <p data-testid="autopay-fee-percent">{percent}</p>
    <InheritedField id="autopay-ach-fee" data-testid="autopay-ach-fee" label={t('autopay.fees.ach')}
      value={view.values.achFeeAmount ?? ''} onChange={value => setValues({ achFeeAmount: value === '' ? null : value })}
      inheritedValue={view.inherited.achFeeAmount.value} inheritedSource={t(`autopay.source.${view.inherited.achFeeAmount.source}`)} />
    {!view.effective.feeAttested && <p data-testid="autopay-fee-inactive">{t('autopay.fees.inactive')}</p>}
    {affirmations && setAffirmations && <>
      <label className="flex gap-2"><input type="checkbox" data-testid="autopay-attest-notified" checked={affirmations.notified}
        onChange={event => setAffirmations({ ...affirmations, notified: event.target.checked })} />{t('autopay.fees.notified')}</label>
      <label className="flex gap-2"><input type="checkbox" data-testid="autopay-attest-cost" checked={affirmations.cost}
        onChange={event => setAffirmations({ ...affirmations, cost: event.target.checked })} />{t('autopay.fees.cost')}</label>
    </>}
    <p>{t('autopay.fees.rules')}</p><p>{t('autopay.fees.legal')}</p><p>{t('autopay.achRisk')}</p>
  </fieldset>;
}
```

W3 Task 7 (`docs/superpowers/plans/billing/2026-10-01-autopay-w03-reminders.md`) replaces W2's hook. Apply these edits to that final `usePaymentSettings`, preserving its generation/currentPath safeguards. Add state alongside its other hooks:

```tsx
const [affirmations,setAffirmations]=useState<FeeAffirmations>({notified:false,cost:false});
```

Replace its `invalid` declaration and its Save `body` declaration with these complete expressions:

```tsx
const feesInvalid=!!view?.autopayEnabled&&!!values&&feeValuesInvalid(values);
const attestationIncomplete=!!view?.autopayEnabled&&!orgId&&affirmations.notified!==affirmations.cost;
const invalid=loadedPath!==path||!reminders||reminderDraftInvalid(reminders)||autopayInvalid||feesInvalid||attestationIncomplete;
```

```tsx
const body={...(view.autopayEnabled?view.values:{}),...reminderPatch(reminders),
  ...(view.autopayEnabled&&!orgId&&affirmations.notified&&affirmations.cost?{
    feeAttestation:{acquirerAndNetworksNotified30DaysAgo:true,doesNotExceedAcceptanceCost:true},
  }:{})};
```

Keep its `JSON.stringify(body)` request and `runAction` intact. In the load effect, add `setAffirmations({notified:false,cost:false});` before `void load()`. After successful `runAction`, add `if(currentPath.current===path)setAffirmations({notified:false,cost:false});`. Add `affirmations,setAffirmations` to the existing returned object. Never precheck them from stored `feeAttested`.

In `PaymentsSettingsTab`, inside W3's gated autopay section immediately after `PaymentFields`, render:

```tsx
<FeeFields view={model.view} setValues={model.setValues} disabled={!canManage||model.saving}
  affirmations={orgId?undefined:model.affirmations} setAffirmations={orgId?undefined:model.setAffirmations}/>
```

Import `FeeFields` into `OrgPaymentsSettingsSection` and render it after `PaymentFields` without attestation props:

```tsx
<FeeFields view={view} setValues={setValues} disabled={disabled} />
```

Preserve W3’s always-visible reminders and existing gating: only the autopay/fees sections depend on `autopayEnabled`; no fee keys may be submitted when rollout is off. In the existing save payload builder that W3 uses for gated fields, include `cardFeeBps` and `achFeeAmount` among the autopay fields. Do not change its reminder-only payload.

Merge this exact `fees` object under `autopay` into each billing locale listed in Files (English fallback leaves in other locales):

```json
{
  "title": "Processing fees",
  "cardBps": "Credit-card fee (basis points, 0–300)",
  "ach": "Bank payment fee (USD, 0.00–25.00)",
  "inactive": "Card fees are inactive until your partner administrator affirms both statements below.",
  "notified": "I notified my acquirer (Stripe) and the card networks at least 30 days ago",
  "cost": "This fee does not exceed my cost of card acceptance",
  "rules": "Credit cards only. No card fee in CA, CT, ME or MA; Colorado is capped at 2%. Fees apply only to eligible US automatic payments in USD. Blank inherits; zero exempts this customer. One-time pay links have no fee.",
  "legal": "Breeze is not legal advice. You are responsible for surcharge eligibility, notices and tax treatment."
}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/web && npx vitest run src/components/billing/PaymentsSettingsTab.test.tsx src/lib/i18n/localeParity.test.ts`; `cd apps/api && npx vitest run src/services/autopay/paymentSettingsView.test.ts`.
- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/autopay/paymentSettingsView.ts apps/api/src/services/autopay/paymentSettingsView.test.ts apps/web/src/components/billing/PaymentsSettingsTab.tsx apps/web/src/components/billing/PaymentsSettingsTab.test.tsx apps/web/src/components/billing/OrgPaymentsSettingsSection.tsx apps/web/src/locales/*/billing.json
git commit -m "feat(billing): show inherited fees and partner attestation"
```

### Task 3: Disclose the fee on setup, confirmation, notices and receipts
**Files:** Create `apps/api/src/services/autopay/feeDisclosure.ts`, `apps/api/src/services/autopay/feeDisclosure.test.ts`, `apps/portal/src/components/portal/AutopaySetupPage.fees.test.tsx`; Modify `apps/api/src/services/autopay/consentText.ts`, `apps/api/src/services/autopay/setupCompletion.ts`, `apps/api/src/services/autopay/setupCompletion.test.ts`, `apps/api/src/services/autopay/customerViews.ts`, `apps/api/src/services/autopay/chargingNotice.ts`, `apps/api/src/services/autopay/renderBillingNotice.ts`, `apps/api/src/services/autopay/renderBillingNotice.test.ts`, `apps/portal/src/components/portal/AutopaySetupPage.tsx`, `apps/docs/src/content/docs/features/online-payments.mdx`.
**Interfaces:** Consumes W1 Task 16 `FeeQuote`; W2 Task 1 `AutopayDisclosure`, Task 7 `persistCapturedAutopayMethod`, Task 11 `completeOwnedAutopaySetup`; W4 Task 3 `AutopayTerms`, Task 13 `{payment:{id,vars,custom,frozen}}`. Produces private `prospectiveFeeText`, `verifiedFeeText`, `paymentFeeLine`; no C6 template IDs or variable lists change.

- [ ] **Step 1: Write the failing test** — create `feeDisclosure.test.ts`:

```ts
import { expect, it } from 'vitest';
import { prospectiveFeeText, verifiedFeeText, paymentFeeLine } from './feeDisclosure';
it('explains the maximum and excludes every non-credit funding result', () => {
  const text = prospectiveFeeText({ feeAmount: '2.00', kind: 'card_percent', appliedBps: 200, reason: 'state_capped' }, 'USD');
  expect(text).toContain('2.00%'); expect(text).toContain('Debit, prepaid and unknown-funding cards have no fee');
  for (const funding of ['debit','prepaid','unknown',null]) expect(verifiedFeeText('card', funding, text)).toBe('No processing fee applies to this card.');
  expect(verifiedFeeText('card', 'credit', text)).toBe(text);
  expect(paymentFeeLine('100.00','3.00','USD','card')).toBe('$100.00 + $3.00 card processing fee');
  expect(paymentFeeLine('100.00','2.50','USD','us_bank_account')).toBe('$100.00 + $2.50 bank processing fee');
  expect(paymentFeeLine('100.00','0.00','USD','card')).toBe('$100.00; no processing fee');
});
it('shows a flat fee and never labels setup as an immediate charge', () => {
  expect(prospectiveFeeText({ feeAmount:'2.50', kind:'ach_flat', appliedBps:null, reason:'applied' }, 'USD'))
    .toBe('Each bank payment includes a $2.50 processing fee. Saving this method does not itself charge a fee.');
});
```

Append to `renderBillingNotice.test.ts`; imports `renderBillingNotice`, `expect`, `it` already exist:

```ts
it('keeps receipt itemization when the partner removes every editable amount', async () => {
  const out = await renderBillingNotice('payment_receipt', { payment: {
    id: 'payment_receipt', custom: { subject:'Thank you', heading:'Paid', html:'<p>Thank you</p>', buttonLabel:'' },
    vars: { partner_name:'Example MSP', org_name:'Example customer', invoice_number:'INV-1', amount_paid:'USD 100.00',
      fee_amount:'USD 3.00', total_charged:'USD 103.00', payment_method:'Visa ••4242', paid_on:'2026-10-01', balance_remaining:'USD 0.00' },
    frozen: { amount:'100.00', fee:'3.00', total:'103.00' },
  } });
  for (const value of ['Principal: USD 100.00','Processing fee: USD 3.00','Total charged: USD 103.00']) {
    expect(out.html).toContain(value); expect(out.text).toContain(value);
  }
  expect(out.frozen).toEqual({ amount:'100.00', fee:'3.00', total:'103.00' });
});
```

Append to W2 Task 7's `setupCompletion.test.ts`; add `persistCapturedAutopayMethod` to its existing setup-completion import and import `renderBillingNotice` from `./renderBillingNotice` (the suite already mocks it). The explicit queue matches the direct persist path, which has one fewer lookup than the existing `queueAuthority` helper:

```ts
it('uses the verified debit fee in enrollment mail without rewriting accepted consent',async()=>{
  const accepted={...snapshot,feeText:'Credit card: up to 3.00% per automatic payment.',
    feeTerms:{...snapshot.feeTerms,cardFeeBps:300,feeAttested:true}};
  const before=JSON.stringify(accepted),value=attempt({consentSnapshot:accepted});
  m.rows.push([value],[{id:value.orgId,status:'active',deletedAt:null}],
    [{id:value.enrollmentId,status:'requested',generation:3,stripeAccountId:'acct_one',stripeCustomerId:'cus_one',effectiveFrom:null}],
    [{id:value.id}],[{id:value.stripeConnectionId,stripeAccountId:'acct_one',status:'connected'}],
    [],[],[{id:'method_one'}],[],[],[],[]);
  const method={id:'pm_one',type:'card',customer:'cus_one',card:{brand:'visa',funding:'debit',last4:'1234',
    exp_month:12,exp_year:2030,country:'US'}} as Parameters<typeof persistCapturedAutopayMethod>[1];
  expect(await persistCapturedAutopayMethod(value.id,method,'activated','seti_one',null))
    .toEqual({outcome:'activated',orgId:value.orgId});
  expect(vi.mocked(renderBillingNotice)).toHaveBeenCalledWith('autopay_enrolled',{
    autopay:expect.objectContaining({vars:expect.objectContaining({fee_text:'No processing fee applies to this card.'}),
      feeText:'No processing fee applies to this card.'}),
  });
  expect(m.writes.filter(row=>'consentTextVersion' in row)).toEqual([
    expect.objectContaining({consentTextHash:accepted.textHash,consentTextVersion:accepted.version,
      feeTerms:accepted.feeTerms,scheduleTerms:accepted.scheduleTerms}),
  ]);
  expect(JSON.stringify(accepted)).toBe(before);expect(m.enqueue).toHaveBeenCalledOnce();
  expect(m.client).not.toHaveBeenCalled();expect(m.rows).toHaveLength(0);
});
```

Append this protected invoice disclosure assertion to `renderBillingNotice.test.ts`:

```ts
it('keeps principal plus card fee outside edited invoice notice text',async()=>{
  const feeText='$100.00 + $3.00 card processing fee';
  const out=await renderBillingNotice('invoice_autopay',{charging:{
    vars:{org_name:'Customer',partner_name:'Provider',invoice_number:'INV-1',amount_due:'USD 100.00',
      due_date:'2026-10-01',charge_date:'2026-10-11',payment_method:'Visa ••4242',fee_amount:'USD 3.00',
      invoice_link:'https://portal.example.test/invoice/token'},
    custom:{subject:'Invoice',heading:'Invoice',html:'<p>Edited without amounts</p>',buttonLabel:null},
    skipUrl:'https://portal.example.test/autopay/skip/skip',stopUrl:'https://portal.example.test/autopay/stop/stop',
    feeText,authorizationText:'Payment authorized during automatic payment setup.',
    frozen:{amount:'100.00',fee:'3.00',chargeDate:'2026-10-11'},
  }});
  expect(out.html).toContain(feeText);expect(out.text).toContain(feeText);
  expect(out.frozen).toEqual({amount:'100.00',fee:'3.00',chargeDate:'2026-10-11'});
});
```

Create the portal test with the actual W2 Task 16 API boundary:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { apiGet, apiPost } from '../../lib/api';
import AutopaySetupPage from './AutopaySetupPage';
vi.mock('../../lib/api', () => ({ apiGet:vi.fn(), apiPost:vi.fn() }));
afterEach(cleanup);
const card = { text:'I authorize future payments.', hash:'a'.repeat(64), feeText:'Credit card: up to 3.00%. Debit, prepaid and unknown-funding cards have no fee.' };
const bank = { text:'I authorize bank payments.', hash:'b'.repeat(64), feeText:'Each bank payment includes a $2.50 processing fee.' };
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState({}, '', '/autopay/example');
  vi.mocked(apiGet).mockResolvedValue({ data:{ orgId:'11111111-1111-4111-8111-111111111111',
    partnerName:'Example MSP', orgName:'Customer', contactEmail:'billing@example.test', achMode:'ach_preferred',
    scheduleText:'On or around the due date.', disclosures:{card,us_bank_account:bank},
    consentText:{card:card.text,us_bank_account:bank.text}, consentVersion:'v1' } } as never);
});
it('renders both method fees through the setup page and does not mutate on mount', async () => {
  render(<AutopaySetupPage token="example" />);
  expect(await screen.findByTestId('autopay-fee-card')).toHaveTextContent('3.00%');
  expect(screen.getByTestId('autopay-fee-us_bank_account')).toHaveTextContent('$2.50');
  expect(apiPost).not.toHaveBeenCalled();
});
it('renders verified debit zero fee after explicit return confirmation', async () => {
  window.history.replaceState({}, '', '/autopay/return?target=public&session_id=cs_test');
  sessionStorage.setItem('autopay-return-token','example');
  vi.mocked(apiPost).mockResolvedValue({data:{outcome:'activated',orgId:'11111111-1111-4111-8111-111111111111',
    methodLabel:'Visa debit ••1234',feeText:'No processing fee applies to this card.'}} as never);
  render(<AutopaySetupPage token="example" mode="return" />);
  fireEvent.click(await screen.findByTestId('autopay-return-submit'));
  expect(await screen.findByTestId('autopay-return-outcome')).toHaveTextContent('No processing fee applies to this card.');
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/feeDisclosure.test.ts src/services/autopay/renderBillingNotice.test.ts src/services/autopay/setupCompletion.test.ts`; `cd apps/portal && npx vitest run src/components/portal/AutopaySetupPage.fees.test.tsx`. Expected: missing helper and missing protected principal/total itemization. W2 already renders method text, so that positive regression can pass before editing.
- [ ] **Step 3: Implement** — create `feeDisclosure.ts`:

```ts
import type { FeeQuote } from './processingFee';
export function displayMoney(amount: string, currency: string): string {
  return currency === 'USD' ? `$${amount}` : `${currency} ${amount}`;
}
export function prospectiveFeeText(quote: FeeQuote, currency: string): string {
  if (quote.kind === 'none') return 'No processing fee applies.';
  if (quote.kind === 'ach_flat') return `Each bank payment includes a ${displayMoney(quote.feeAmount,currency)} processing fee. Saving this method does not itself charge a fee.`;
  const bps = quote.appliedBps!;
  const percent = `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2,'0')}`;
  return `Credit card: up to ${percent}% per automatic payment. Debit, prepaid and unknown-funding cards have no fee. Saving this method does not itself charge a fee.`;
}
export function verifiedFeeText(type: string, funding: string | null, acceptedText: string): string {
  return type === 'card' && funding !== 'credit' ? 'No processing fee applies to this card.' : acceptedText;
}
export function paymentFeeLine(principal: string, fee: string, currency: string, methodType: string): string {
  return /^0(?:\.0+)?$/.test(fee) ? `${displayMoney(principal,currency)}; no processing fee`
    : `${displayMoney(principal,currency)} + ${displayMoney(fee,currency)} ${methodType === 'us_bank_account' ? 'bank' : 'card'} processing fee`;
}
```

In `consentText.ts` replace only the existing `feeText` ternary after `quoteProcessingFee` with `const feeText = prospectiveFeeText(quote, row.org.currencyCode);` and import that function from `./feeDisclosure`. Keep the accepted disclosure hashing after fee text assembly. Existing consents remain immutable; new setup snapshots use the new text.

In `setupCompletion.ts`, immediately before enqueueing `autopay_enrolled`, compute:

```ts
const displayFee = verifiedFeeText(method.type, method.card?.funding ?? null, snapshot.feeText);
```

Import `verifiedFeeText` from `./feeDisclosure`; replace `fee_text:snapshot.feeText` with `fee_text:displayFee` and the adjacent context `feeText:snapshot.feeText` with `feeText:displayFee`. The preceding consent insertion continues using the unmodified `snapshot.feeTerms`, `snapshot.textHash`, and `snapshot.scheduleTerms`.

In `customerViews.ts`, import the same helper and replace the final fee-text expression in `completeOwnedAutopaySetup`:

```ts
const prospective = method?.type === 'us_bank_account' ? page.fees.us_bank_account.text : page.fees.card.text;
const feeText = method ? verifiedFeeText(method.type, method.cardFunding, prospective) : 'No usable payment method confirmed.';
```

In `chargingNotice.ts`, import `paymentFeeLine` and replace the protected `feeText` assignment with:

```ts
feeText: paymentFeeLine(terms.principal, terms.feeAmount, terms.currency, terms.methodType),
```

Keep `fee_amount` exactly as defined by C6. In `renderBillingNotice.ts`, replace W4’s payment branch with this complete branch (existing `escapeHtml` and `renderPartnerEmail` imports remain):

```ts
if ('payment' in ctx) {
  if ((kind !== 'payment_receipt' && kind !== 'payment_failed') || ctx.payment.id !== kind) throw new Error('Missing payment notice context');
  const p = ctx.payment;
  const lines = kind === 'payment_receipt' ? [
    `Principal: ${p.vars.amount_paid}`, `Processing fee: ${p.vars.fee_amount}`, `Total charged: ${p.vars.total_charged}`,
  ] : [];
  const rendered = renderPartnerEmail({ id:kind, custom:p.custom, vars:p.vars,
    ctaUrl:p.vars.action_link, ctaLabel:p.vars.action_label,
    bodyAfterCta:lines.length ? lines.map(line=>`<p>${escapeHtml(line)}</p>`).join('') : undefined });
  return { ...rendered, frozen:p.frozen,
    text:[...Object.entries(p.vars).map(([key,value])=>`${key}: ${value}`), ...lines].join('\n') };
}
```

In `AutopaySetupPage.tsx`, add `data-testid="autopay-return-fee"` to the existing paragraph displaying `outcome.methodLabel` and `outcome.feeText`. Keep the return outcome wrapper, explicit POST button, per-method `autopay-fee-card`/`autopay-fee-us_bank_account`, and W4’s bank-payment confirmation untouched. W4’s authentication confirmation uses the frozen attempt fee; its receipt uses the mapping, never current settings.

Append this complete section to `online-payments.mdx`:

```mdx
## Processing fees

Processing fees are optional and apply to automatic payments only. One-time card pay links stay fee-free. The fee is added to the payment, never to the invoice balance, invoice PDF or accounting invoice.

In **Billing settings → Payments**, set a credit-card fee from 0 to 300 basis points (100 basis points = 1%) and a flat bank-payment fee from USD 0.00 to 25.00. Organization Billing settings can override either value. Blank inherits the partner default; zero exempts that organization.

A card fee remains inactive until a partner administrator affirms both statements: “I notified my acquirer (Stripe) and the card networks at least 30 days ago” and “this fee does not exceed my cost of card acceptance.” Breeze records the administrator and the time. Organization administrators cannot make this attestation for the partner.

Breeze’s conservative card-fee policy requires a US Stripe account, a USD invoice, a known US customer billing state and a credit card. Debit, prepaid and unknown-funding cards have no fee. No card fee is applied in CA, CT, ME or MA; Colorado is capped at 2%, and other supported states at 3%. Unknown geography and non-US accounts receive no card fee. Bank fees require US accounts and USD payments.

Customers see the applicable terms before saving a method, a confirmation after setup, the fee in each automatic-payment notice and principal/fee/total on their receipt. Rules are checked again before charging. The fee can decrease but cannot exceed the delivered notice. A change requiring a new notice postpones collection.

Your business remains responsible for ACH returns and Stripe return fees. Returns on individual bank accounts can arrive up to 60 days later. Stopping automatic payments cannot recall a debit already processing.

Refunds and disputes reverse principal and fee proportionally using cumulative totals. A full refund returns the full fee. A dispute reversal restores only the unrefunded share.

Under **Integrations → accounting connection**, choose the processing-fee income item (QuickBooks) or income account (Xero). Fees are exported separately when automatic payment push is enabled. Both providers require the configured payment/deposit account; Xero also requires the configured exempt tax code. Fee exports default to non-taxable; your business determines the appropriate tax treatment. Missing mapping or uncertain provider results remain visible for investigation and do not undo a successful customer payment.

Breeze is not legal advice. You are responsible for eligibility, required notices, acceptance-cost limits and tax treatment. Review your obligations before enabling fees.
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/feeDisclosure.test.ts src/services/autopay/renderBillingNotice.test.ts src/services/autopay/setupCompletion.test.ts src/routes/autopay/public.test.ts src/routes/portal/paymentMethods.test.ts`; `cd apps/portal && npx vitest run src/components/portal/AutopaySetupPage.fees.test.tsx`; `pnpm --filter @breeze/docs build` from root.
- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/autopay/feeDisclosure.ts apps/api/src/services/autopay/feeDisclosure.test.ts apps/api/src/services/autopay/consentText.ts apps/api/src/services/autopay/setupCompletion.ts apps/api/src/services/autopay/setupCompletion.test.ts apps/api/src/services/autopay/customerViews.ts apps/api/src/services/autopay/chargingNotice.ts apps/api/src/services/autopay/renderBillingNotice.ts apps/api/src/services/autopay/renderBillingNotice.test.ts apps/portal/src/components/portal/AutopaySetupPage.tsx apps/portal/src/components/portal/AutopaySetupPage.fees.test.tsx apps/docs/src/content/docs/features/online-payments.mdx
git commit -m "feat(billing): disclose processing fees throughout autopay"
```

### Task 4: Prove current legality and the delivered fee ceiling at collection
**Files:** Create `apps/api/src/services/autopay/collectionFee.ts`, `apps/api/src/services/autopay/collectionFee.test.ts`; Modify `apps/api/src/services/autopay/collectionEngine.ts`, `apps/api/src/services/autopay/charging.integration.test.ts`; Read W4-owned `apps/api/src/services/autopay/clientPaymentAuthority.ts` and W1-owned `apps/api/src/services/autopay/linkTokens.ts` (retain their contracts).
**Interfaces:** Consumes C4 `quoteProcessingFee(input: FeeQuoteInput): FeeQuote`, W4 Tasks 10/16 `reserveCollection` and `withClientPaymentAuthority`, C4 `mintBillingLinkToken`, W4 Task 20 `fixture()`, `attempts(invoiceId)` and `provider` mock at `getPartnerStripeClient`. Produces private `clampNoticedFee(quote: FeeQuote, currency: string, noticedFee?: string): string`. The C4 collection signatures do not change.

- [ ] **Step 1: Write the failing test** — create `collectionFee.test.ts`:

```ts
import { expect, it } from 'vitest';
import { quoteProcessingFee, type FeeQuoteInput } from './processingFee';
import { clampNoticedFee } from './collectionFee';
const input: FeeQuoteInput = {methodType:'card',cardFunding:'credit',principal:'100.00',currency:'USD',
  stripeAccountCountry:'US',orgBillingCountry:'US',orgBillingRegion:'NY',cardFeeBps:300,achFeeAmount:'0.00',feeAttested:true};
it.each([
  [{},'1.00','1.00'], [{cardFunding:'debit'},'3.00','0.00'],
  [{cardFunding:'prepaid'},'3.00','0.00'], [{cardFunding:'unknown'},'3.00','0.00'],
  [{orgBillingRegion:'CA'},'3.00','0.00'], [{orgBillingRegion:'CO'},'3.00','2.00'],
  [{feeAttested:false},'3.00','0.00'], [{stripeAccountCountry:'AU'},'3.00','0.00'],
] as const)('rechecks %j and clamps to %s', (changes, noticed, expected) => {
  const quote = quoteProcessingFee({...input,...changes});
  expect(clampNoticedFee(quote,'USD',noticed)).toBe(expected);
  if ('feeAttested' in changes) expect(quote.reason).toBe('not_attested');
});
it('refuses malformed or negative notice amounts',()=>{
  const quote=quoteProcessingFee(input);
  for(const value of ['-1.00','NaN','1e3','1.001']) expect(()=>clampNoticedFee(quote,'USD',value)).toThrow();
});
```

Append to W4’s `charging.integration.test.ts`; merge `billingPaymentSettings`, `users`, `billingLinkTokens` into its existing schema import (retain `organizations`), and import `AutopayTerms` from `./chargingNotice`, `withClientPaymentAuthority` from `./clientPaymentAuthority`, and `mintBillingLinkToken` from `./linkTokens`. This is a real DB suite, not a mocked lock test:

```ts
it.each([
  ['credit','NY','3.00',10300],['debit','NY','0.00',10000],
  ['credit','CA','0.00',10000],['credit','CO','2.00',10200],
] as const)('reserves current %s/%s fee %s and sends only principal plus fee',async(funding,region,fee,gross)=>{
  const f=await fixture();
  await withSystemDbAccessContext(async()=>{
    const [actor]=await db.insert(users).values({partnerId:f.partner.id,orgId:f.org.id,
      email:`fees-${randomUUID()}@example.test`,name:'Fee tester',status:'active'}).returning();
    await db.insert(billingPaymentSettings).values({partnerId:f.partner.id,orgId:null,cardFeeBps:300,
      feeAttestedBy:actor!.id,feeAttestedAt:new Date(),achFeeAmount:'0.00'});
    await db.update(organizations).set({billingAddressCountry:'US',billingAddressRegion:region}).where(eq(organizations.id,f.org.id));
    await db.update(orgPaymentMethods).set({cardFunding:funding}).where(eq(orgPaymentMethods.id,f.method.id));
    await db.update(invoiceAutopaySchedules).set({termsSnapshot:{...(f.schedule.termsSnapshot as AutopayTerms),
      cardFeeBps:300,feeAmount:'3.00',feeKind:'card_percent'}}).where(eq(invoiceAutopaySchedules.id,f.schedule.id));
  });
  const result=await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  expect(result.outcome).toBe('created');
  expect((await attempts(f.invoice.id))[0]).toMatchObject({principalAmount:'100.00',feeAmount:fee});
  expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({amount:gross}),expect.anything());
});
```

Add this real-reservation regression to the same suite. The valid invoice-bound token and matching principal/method/generation isolate the fee ceiling; refusal must leave the token unconsumed and create no attempt or provider call:

```ts
it('refuses a nonzero bank fee above the client authorization before consuming its token',async()=>{
  const f=await fixture();
  const token=await withSystemDbAccessContext(async()=>{
    const actor=await createUser({partnerId:f.partner.id,email:`bank-fee-${randomUUID()}@example.test`});
    await db.insert(billingPaymentSettings).values({partnerId:f.partner.id,orgId:null,
      cardFeeBps:0,achFeeAmount:'3.00',feeAttestedBy:actor.id,feeAttestedAt:new Date()});
    await db.update(organizations).set({billingAddressCountry:'US',billingAddressRegion:'NY'})
      .where(eq(organizations.id,f.org.id));
    await db.update(orgPaymentMethods).set({type:'us_bank_account',accountHolderType:'company',
      bankName:'Test bank',bankLast4:'6789',cardFunding:null}).where(eq(orgPaymentMethods.id,f.method.id));
    return mintBillingLinkToken(db,{orgId:f.org.id,enrollmentId:f.enrollment.id,invoiceId:f.invoice.id,
      purpose:'enroll',generation:f.enrollment.generation,ttlDays:1});
  });
  const result=await withClientPaymentAuthority({tokenId:token.id,invoiceId:f.invoice.id,
    generation:f.enrollment.generation,methodId:f.method.id,principal:'100.00',fee:'2.50',currency:'USD'},
    ()=>attemptCollection({invoiceId:f.invoice.id,initiatedBy:'client_on_session'}));
  expect(result).toMatchObject({outcome:'refused',reason:'client_authorization_required',attemptId:null});
  expect(await attempts(f.invoice.id)).toHaveLength(0);
  expect(provider.create).not.toHaveBeenCalled();
  const [authorization]=await withSystemDbAccessContext(()=>db.select().from(billingLinkTokens)
    .where(eq(billingLinkTokens.id,token.id)));
  expect(authorization!.consumedAt).toBeNull();
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/collectionFee.test.ts` (missing module). Then root `pnpm test-stack up`; `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/charging.integration.test.ts`. Existing W4 collection behavior is expected to pass the new legal-reduction and bank-authorization cases; do not manufacture a regression to turn those red.
- [ ] **Step 3: Implement** — create `collectionFee.ts`:

```ts
import {fromMinorUnits,toMinorUnits} from '../stripeMoney';
import type {FeeQuote} from './processingFee';
export function clampNoticedFee(quote:FeeQuote,currency:string,noticedFee?:string):string {
  const valid=(value:string)=>{
    if(!/^\d{1,10}(?:\.\d{1,2})?$/.test(value))throw new Error('Invalid processing fee');
    const n=toMinorUnits(value,currency);
    if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid processing fee');
    return n;
  };
  const current=valid(quote.feeAmount);
  return fromMinorUnits(noticedFee===undefined?current:Math.min(current,valid(noticedFee)),currency);
}
```

Import it in `collectionEngine.ts`. Replace W4’s `feeMinor` declaration with:

```ts
const feeAmount = clampNoticedFee(quote, invoice.currencyCode, terms?.feeAmount);
const feeMinor = toMinorUnits(feeAmount, invoice.currencyCode);
```

Use `feeAmount` directly in the attempt insert. Keep `toMinorUnits` imported and place both declarations before W4 Task 16’s authorization guard; retain its `feeMinor > toMinorUnits(authority.fee, invoice.currencyCode)` comparison unchanged. Preserve the preceding current-settings/funding/address quote and re-notice branches verbatim: increases, changed policy or method changes still defer; a helper clamp does not authorize bypassing notice. Preserve W4’s separately consented `client_on_session` bank flow and its current-amount binding. That flow has no schedule and therefore no noticedFee argument; its consent gate remains mandatory.
- [ ] **Step 4: Run it, expect PASS** — repeat both commands; all mock Stripe calls must observe `hasDbAccessContext() === false` through W4’s existing provider fixture.
- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/autopay/collectionFee.ts apps/api/src/services/autopay/collectionFee.test.ts apps/api/src/services/autopay/collectionEngine.ts apps/api/src/services/autopay/charging.integration.test.ts
git commit -m "test(billing): enforce current fee rules and notice ceiling"
```

### Task 5: Allocate cumulative reversals without losing a cent
**Files:** Create `apps/api/src/services/autopay/refundAllocation.ts`, `apps/api/src/services/autopay/refundAllocation.test.ts`.
**Interfaces:** Produces the exact C4 `allocateReversal(input: { principal: string; fee: string; cumulativeReversedGross: string }): { principalReversed: string; feeReversed: string }`. Principal is rounded half-up cumulatively; fee receives the complementary amount. The final cumulative event reaches both original totals exactly.

- [ ] **Step 1: Write the failing test** — complete `refundAllocation.test.ts`; seeded generators make the property test reproducible without a new package:

```ts
import {expect,it} from 'vitest';
import {allocateReversal} from './refundAllocation';
const money=(n:bigint)=>`${n/100n}.${String(n%100n).padStart(2,'0')}`;
const cents=(s:string)=>BigInt(s.replace('.',''));
it.each([
  ['9999999999.99','0.01','10000000000.00','9999999999.99','0.01'],
  ['100.00','3.00','51.50','50.00','1.50'],['100.00','3.00','103.00','100.00','3.00'],
  ['0.01','0.01','0.01','0.01','0.00'],['0.01','0.01','0.02','0.01','0.01'],
  ['100.00','0.00','33.33','33.33','0.00'],['0.00','0.00','0.00','0.00','0.00'],
])('allocates %s + %s reversed %s',(principal,fee,cumulativeReversedGross,principalReversed,feeReversed)=>{
  expect(allocateReversal({principal,fee,cumulativeReversedGross})).toEqual({principalReversed,feeReversed});
});
it('conserves deltas, remains monotone, and puts residue on the last event in 2000 random sequences',()=>{
  let seed=0x5fee1234;
  const next=(max:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
  for(let sample=0;sample<2000;sample++){
    const p=BigInt(1+next(1000000)),f=BigInt(next(2501)),g=p+f;
    const cuts=[...new Set([0,Number(g),...Array.from({length:30},()=>next(Number(g)+1))])].sort((a,b)=>a-b);
    let pp=0n,pf=0n,pr=0n,totalP=0n,totalF=0n;
    for(const cut of cuts){
      const r=BigInt(cut),input={principal:money(p),fee:money(f),cumulativeReversedGross:money(r)};
      const result=allocateReversal(input),ap=cents(result.principalReversed),af=cents(result.feeReversed);
      expect(ap+af).toBe(r);expect(ap>=pp&&af>=pf).toBe(true);
      expect(ap<=p&&af<=f).toBe(true);expect((ap-pp)+(af-pf)).toBe(r-pr);
      const error=ap*g-p*r;expect((error<0n?-error:error)*2n<=g).toBe(true);
      expect(allocateReversal(input)).toEqual(result);
      totalP+=ap-pp;totalF+=af-pf;pp=ap;pf=af;pr=r;
    }
    expect(totalP).toBe(p);expect(totalF).toBe(f);
  }
});
it('rejects invalid and out-of-range amounts on every argument',()=>{
  for(const key of ['principal','fee','cumulativeReversedGross'] as const)
    for(const value of ['-1.00','1.001','NaN','1e2','',' 1.00','10000000000.00'])
      expect(()=>allocateReversal({principal:'1.00',fee:'0.00',cumulativeReversedGross:'0.00',[key]:value})).toThrow();
  expect(()=>allocateReversal({principal:'1.00',fee:'0.01',cumulativeReversedGross:'1.02'})).toThrow('exceeds');
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/refundAllocation.test.ts`; missing module.
- [ ] **Step 3: Implement** — complete `refundAllocation.ts`:

```ts
function cents(value:string):bigint {
  if(!/^\d{1,11}(?:\.\d{1,2})?$/.test(value))throw new Error('Invalid reversal amount');
  const [whole,fraction='']=value.split('.');
  return BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));
}
function money(value:bigint):string{return `${value/100n}.${String(value%100n).padStart(2,'0')}`;}
export function allocateReversal(input:{principal:string;fee:string;cumulativeReversedGross:string})
  :{principalReversed:string;feeReversed:string}{
  const p=cents(input.principal),f=cents(input.fee),r=cents(input.cumulativeReversedGross),g=p+f;
  if(p>999999999999n||f>999999999999n)throw new Error('Invalid reversal amount');
  if(r>g)throw new Error('Reversal exceeds original gross amount');
  if(g===0n)return {principalReversed:'0.00',feeReversed:'0.00'};
  const allocated=(2n*p*r+g)/(2n*g);
  return {principalReversed:money(allocated),feeReversed:money(r-allocated)};
}
```

This decimal API is currency-neutral. Callers convert Stripe integer minor units with `fromMinorUnits(..., mapping.currency)` before calling it. Zero-fee JPY remains principal-only; nonzero fee policy remains USD-only.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/refundAllocation.test.ts`.
- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/autopay/refundAllocation.ts apps/api/src/services/autopay/refundAllocation.test.ts
git commit -m "feat(billing): allocate cumulative principal and fee reversals"
```

### Task 6: Persist reversal shares and durable fee bookkeeping without changing invoice principal
**Files:** Create `apps/api/migrations/2026-11-20-140000-accounting-fee-income-mapping.sql`, `apps/api/migrations/2026-11-20-140001-processing-fee-reversals.sql`, `apps/api/src/services/autopay/processingFeeSchema.integration.test.ts`; Modify `apps/api/src/services/accounting/accountingConnectionService.ts`, `apps/api/src/services/accounting/accountingConnectionService.test.ts`, `apps/api/src/db/schema/accounting.ts`, `apps/api/src/db/schema/stripePayments.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/stripeReversalState.ts`, `apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts`.
**Interfaces:** Consumes Task 5 `allocateReversal`, W1 Task 9 gross-aware `applyStripeFinancialEvent`, W4 Task 14 unapplied full refund and its existing local `seedAutopayBank(linkPayment=true)` fixture with linked enrollment/method/attempt and return-notice handoff. Produces `invoiceStripePayments.feeReversedAmount: string`, `.feeAccountingJournal: unknown[]`, `.feeAccountingError: string | null`, connection `.feeIncomeItemRef`/`.feeIncomeAccountRef`. Journal entries are defined in Task 10; pending entries and unbooked reversals cannot be silently erased.

- [ ] **Step 1: Write the failing test** — create the co-located schema integration test:

```ts
import '../../__tests__/integration/setup';
import {afterAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
const admin=postgres(process.env.DATABASE_URL!,{max:1});
afterAll(()=>admin.end({timeout:5}));
it('replays the two migrations and retains forced tenant isolation',async()=>{
  for(let n=0;n<2;n++)for(const filename of ['2026-11-20-140000-accounting-fee-income-mapping.sql','2026-11-20-140001-processing-fee-reversals.sql']){
    const source=readFileSync(new URL(`../../../migrations/${filename}`,import.meta.url),'utf8');
    await admin.begin(tx=>tx.unsafe(source));
  }
  const columns=await admin`select table_name,column_name from information_schema.columns where
    (table_name='accounting_connections' and column_name in ('fee_income_item_ref','fee_income_account_ref')) or
    (table_name='invoice_stripe_payments' and column_name in ('fee_reversed_amount','fee_accounting_journal','fee_accounting_error'))`;
  expect(columns).toHaveLength(5);
  const rows=await admin`select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('accounting_connections','invoice_stripe_payments')`;
  expect(rows).toHaveLength(2);
  expect(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
});
```

Append to the **existing** `stripeReversalState.integration.test.ts` using its verified local `seed(false)`, W4’s `seedAutopayBank`, `financialEvent`, and `runDb` helpers; retain W4’s `invoiceCollectionAttempts` and `stripeFinancialEvents` imports. `recordStripePayment` accepts gross after W1 Task 9:

```ts
runDb('partial refunds allocate once, ignore old totals and return the full fee at the end',async()=>{
  const f=await seed(false);
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAmount:'3.00',paymentMethodType:'card',
    source:'autopay',stripeObjectType:'payment_intent',stripeObjectId:f.paymentIntentId})
    .where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  await recordStripePayment({stripeObjectId:f.paymentIntentId,stripePaymentIntentId:f.paymentIntentId,
    stripeAccountId:f.accountId,amount:'103.00',currency:'USD'});
  const event=financialEvent(f,{stripeEventId:`evt_half_${f.invoiceId}`,chargeAmountMinor:10300,refundedAmountMinor:5150,providerCreated:200});
  await Promise.all([ingestStripeFinancialEvent(event),ingestStripeFinancialEvent(event)]);
  await ingestStripeFinancialEvent(financialEvent(f,{chargeAmountMinor:10300,refundedAmountMinor:1030,providerCreated:100}));
  let [mapping]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  const [payment]=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.id,mapping!.invoicePaymentId!)));
  expect(payment!.amount).toBe('50.00');expect(mapping!.feeReversedAmount).toBe('1.50');
  await ingestStripeFinancialEvent(financialEvent(f,{chargeAmountMinor:10300,refundedAmountMinor:10300,providerCreated:201}));
  [mapping]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  expect(mapping).toMatchObject({status:'refunded',invoicePaymentId:null,feeReversedAmount:'3.00'});
});
runDb('won ACH dispute restores only unrefunded principal and the correct rail',async()=>{
  const f=await seedAutopayBank();
  await withSystemDbAccessContext(async()=>{
    await db.update(invoiceStripePayments).set({feeAmount:'3.00'}).where(eq(invoiceStripePayments.id,f.mappingId));
    await db.update(invoiceCollectionAttempts).set({feeAmount:'3.00'}).where(eq(invoiceCollectionAttempts.id,f.attemptId));
  });
  await ingestStripeFinancialEvent(financialEvent(f,{chargeAmountMinor:10300,refundedAmountMinor:5150,providerCreated:200}));
  const withdrawal=financialEvent(f,{stripeEventId:`evt_fee_withdrawal_${f.invoiceId}`,
    eventType:'charge.dispute.funds_withdrawn',chargeAmountMinor:10300,disputeId:`dp_fee_${f.invoiceId}`,
    refundedAmountMinor:null,disputeAmountMinor:10300,disputeFundsWithdrawn:true,providerCreated:300});
  expect(await ingestStripeFinancialEvent(withdrawal)).toMatchObject({state:'applied'});
  const [withdrawn]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments)
    .where(eq(invoiceStripePayments.id,f.mappingId)));
  expect(withdrawn).toMatchObject({status:'disputed',invoicePaymentId:null,feeReversedAmount:'3.00'});
  const [appliedWithdrawal]=await withSystemDbAccessContext(()=>db.select().from(stripeFinancialEvents)
    .where(eq(stripeFinancialEvents.stripeEventId,withdrawal.stripeEventId)));
  expect(appliedWithdrawal!.status).toBe('applied');
  await ingestStripeFinancialEvent(financialEvent(f,{eventType:'charge.dispute.funds_reinstated',chargeAmountMinor:10300,disputeId:`dp_fee_${f.invoiceId}`,
    refundedAmountMinor:null,disputeAmountMinor:10300,disputeFundsWithdrawn:false,providerCreated:301}));
  const [mapping]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  const [payment]=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.id,mapping!.invoicePaymentId!)));
  expect(payment).toMatchObject({amount:'50.00',method:'ach_debit'});
  expect(mapping).toMatchObject({status:'partially_refunded',feeReversedAmount:'1.50'});
});
```

Append to `accountingConnectionService.test.ts`, whose existing `makeMockDb` captures `insertValues` and `updateSet`:

```ts
it('round-trips income refs and preserves them on a token-only reconnect',async()=>{
  const captured:{row?:any;insertValues?:any;updateSet?:any}={};
  const dbc=makeMockDb(captured);
  const {upsertConnection,mapConnection}=await import('./accountingConnectionService');
  const result=await upsertConnection(dbc,'11111111-1111-4111-8111-111111111111','quickbooks',{
    feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null});
  expect(result).toMatchObject({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null});
  expect(captured.insertValues).toMatchObject({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null});
  expect(captured.updateSet).toMatchObject({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null});
  await upsertConnection(dbc,'11111111-1111-4111-8111-111111111111','quickbooks',{});
  expect(captured.updateSet).not.toHaveProperty('feeIncomeItemRef');
  expect(captured.updateSet).not.toHaveProperty('feeIncomeAccountRef');
  expect(mapConnection(ambientConnectionRow() as never)).toMatchObject({feeIncomeItemRef:null,feeIncomeAccountRef:null});
});
```

In its existing `resetConnectionForRealmChange` test, replace the exact expected update object with this complete expectation before changing production code:

```ts
expect(updateSetMock.mock.calls.at(-1)![0]).toEqual({
  cdcCursor:null,lastReconcileAt:null,defaultIncomeAccountRef:null,defaultTaxCodeRef:null,
  defaultExemptTaxCodeRef:null,defaultPaymentAccountRef:null,feeIncomeItemRef:null,feeIncomeAccountRef:null,
  updatedAt:expect.any(Date),
});
```

Append this second regression to the reversal integration suite using W4 Task 14's `seedAutopayBank` fixture and existing `invoiceCollectionAttempts` import:

```ts
runDb('fully refunds an unapplied capture including its fee without creating a payment',async()=>{
  const f=await seedAutopayBank(false);
  await withSystemDbAccessContext(async()=>{
    await db.update(invoiceStripePayments).set({feeAmount:'3.00'}).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId));
    await db.update(invoiceCollectionAttempts).set({feeAmount:'3.00'}).where(eq(invoiceCollectionAttempts.id,f.attemptId));
  });
  const event=financialEvent(f,{chargeAmountMinor:10300,refundedAmountMinor:10300});
  await ingestStripeFinancialEvent(event);await ingestStripeFinancialEvent(event);
  const [attempt]=await withSystemDbAccessContext(()=>db.select().from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.id,f.attemptId)));
  const [mapping]=await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.stripePaymentIntentId,f.paymentIntentId)));
  const payments=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId,f.invoiceId)));
  expect(attempt).toMatchObject({state:'canceled',failureCode:'unapplied_refunded'});
  expect(mapping).toMatchObject({feeReversedAmount:'3.00',invoicePaymentId:null});
  expect(payments).toHaveLength(0);
});
```

- [ ] **Step 2: Run it, expect FAIL** — root `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/processingFeeSchema.integration.test.ts src/__tests__/integration/stripeReversalState.integration.test.ts`. Expected: migration file absent/new fee counter absent. Also run `cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts`; expected missing mapped/reset fields. Do not run the integration files through the unit config.
- [ ] **Step 3: Implement** — full `140000-accounting-fee-income-mapping.sql`:

```sql
SELECT set_config('breeze.scope','system',true);
ALTER TABLE accounting_connections
  ADD COLUMN IF NOT EXISTS fee_income_item_ref varchar(64),
  ADD COLUMN IF NOT EXISTS fee_income_account_ref varchar(64);
ALTER TABLE accounting_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_connections FORCE ROW LEVEL SECURITY;
-- Retain the existing four partner policies. Fail rather than weaken isolation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='accounting_connections' AND policyname='breeze_partner_isolation_select') THEN
    RAISE EXCEPTION 'accounting_connections partner RLS precondition missing';
  END IF;
END $$;
```

Full `140001-processing-fee-reversals.sql`:

```sql
SELECT set_config('breeze.scope','system',true);
ALTER TABLE invoice_stripe_payments
  ADD COLUMN IF NOT EXISTS fee_reversed_amount numeric(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS fee_accounting_journal jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fee_accounting_error text;
DO $$
DECLARE n bigint;
BEGIN
  UPDATE invoice_stripe_payments
  SET fee_reversed_amount =
    LEAST(amount+fee_amount,(refunded_amount_minor+CASE WHEN dispute_funds_withdrawn THEN dispute_amount_minor ELSE 0 END)/100)
    - round(amount*LEAST(amount+fee_amount,(refunded_amount_minor+CASE WHEN dispute_funds_withdrawn THEN dispute_amount_minor ELSE 0 END)/100)
      /NULLIF(amount+fee_amount,0),2)
  WHERE currency='USD' AND fee_amount>0 AND fee_reversed_amount IS DISTINCT FROM
    LEAST(amount+fee_amount,(refunded_amount_minor+CASE WHEN dispute_funds_withdrawn THEN dispute_amount_minor ELSE 0 END)/100)
    - round(amount*LEAST(amount+fee_amount,(refunded_amount_minor+CASE WHEN dispute_funds_withdrawn THEN dispute_amount_minor ELSE 0 END)/100)
      /NULLIF(amount+fee_amount,0),2);
  GET DIAGNOSTICS n=ROW_COUNT;
  RAISE WARNING 'Backfilled fee reversal allocation on % Stripe mappings',n;
END $$;
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_fee_reversed_check;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_fee_reversed_check
  CHECK (fee_reversed_amount>=0 AND fee_reversed_amount<=fee_amount);
ALTER TABLE invoice_stripe_payments DROP CONSTRAINT IF EXISTS invoice_stripe_payments_fee_journal_check;
ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_fee_journal_check
  CHECK (jsonb_typeof(fee_accounting_journal)='array');
ALTER TABLE invoice_stripe_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_stripe_payments FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='invoice_stripe_payments' AND policyname='breeze_org_isolation_select') THEN
    RAISE EXCEPTION 'invoice_stripe_payments org RLS precondition missing';
  END IF;
END $$;
-- Erasure is not a Stripe refund. Completed bookkeeping can be erased; an owed
-- operation or an unexported reversal cannot lose its durable identity.
CREATE OR REPLACE FUNCTION breeze_guard_fee_journal_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE net numeric; unfinished boolean;
BEGIN
  IF jsonb_array_length(OLD.fee_accounting_journal)=0 THEN RETURN OLD; END IF;
  SELECT COALESCE(sum(CASE WHEN e->'payload'->>'direction'='refund' THEN -1 ELSE 1 END*(e->'payload'->>'amount')::numeric),0),
    COALESCE(bool_or(e->>'state' IS DISTINCT FROM 'posted'),false)
    INTO net,unfinished FROM jsonb_array_elements(OLD.fee_accounting_journal) e;
  IF unfinished OR net<>OLD.fee_amount-OLD.fee_reversed_amount THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PROCESSING_FEE_ACCOUNTING_PENDING';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS invoice_stripe_payments_fee_delete_guard ON invoice_stripe_payments;
CREATE TRIGGER invoice_stripe_payments_fee_delete_guard BEFORE DELETE ON invoice_stripe_payments
FOR EACH ROW EXECUTE FUNCTION breeze_guard_fee_journal_delete();
```

These alter existing tables, not create them. Existing policies already cover new columns; do not replace them with permissive policies. The same-file ENABLE/FORCE statements and policy assertions preserve that boundary. No FK is introduced; there is no composite org FK to make deferrable.

Add these schema properties beside the existing income/fee columns:

```ts
// accountingConnections
feeIncomeItemRef: varchar('fee_income_item_ref', { length:64 }),
feeIncomeAccountRef: varchar('fee_income_account_ref', { length:64 }),
// invoiceStripePayments
feeReversedAmount: numeric('fee_reversed_amount', { precision:12, scale:2 }).notNull().default('0.00'),
feeAccountingJournal: jsonb('fee_accounting_journal').$type<unknown[]>().notNull().default([]),
feeAccountingError: text('fee_accounting_error'),
```

Add to `invoiceStripePayments`’ existing `(t) => [...]` callback (add `check` to the existing `drizzle-orm/pg-core` import and retain the existing `sql` import):

```ts
check('invoice_stripe_payments_fee_reversed_check',sql`${t.feeReversedAmount} >= 0 AND ${t.feeReversedAmount} <= ${t.feeAmount}`),
check('invoice_stripe_payments_fee_journal_check',sql`jsonb_typeof(${t.feeAccountingJournal}) = 'array'`),
```

In `accountingConnectionService.ts`, add to `AccountingConnection` and `UpsertConnectionFields`:

```ts
feeIncomeItemRef?: string | null;
feeIncomeAccountRef?: string | null;
```

In `mapConnection` add:

```ts
feeIncomeItemRef: row.feeIncomeItemRef ?? null,
feeIncomeAccountRef: row.feeIncomeAccountRef ?? null,
```

In both `upsertConnection` insert/update field objects add these properties (undefined preserves an existing value, matching the surrounding default-ref fields):

```ts
feeIncomeItemRef: fields.feeIncomeItemRef,
feeIncomeAccountRef: fields.feeIncomeAccountRef,
```

In `resetConnectionForRealmChange` add `feeIncomeItemRef:null, feeIncomeAccountRef:null` beside the other ref resets. Frozen fee journals are not rewritten.


In `applyStripeFinancialEvent`, import `allocateReversal` from `./autopay/refundAllocation`, remove W1’s private `remainingPrincipalMinor`, and replace the target calculation after the refund high-water/dispute ordering logic:

```ts
const reversedGrossMinor=Math.min(originalMinor,refunded+(disputeWithdrawn?disputeAmount:0));
const allocation=allocateReversal({principal:mapping.amount,fee:mapping.feeAmount,
  cumulativeReversedGross:fromMinorUnits(reversedGrossMinor,mapping.currency)});
const targetMinor=principalMinor-toMinorUnits(allocation.principalReversed,mapping.currency);
```

`principalMinor`/`originalMinor` are W1 Task 9’s principal/gross variables. In **both** mapping updates (before full payment deletion and after partial/restored payment changes), add `feeReversedAmount: allocation.feeReversed`. In W4 Task 14’s unapplied full-refund escape add `feeReversedAmount: mapping.feeAmount`; keep partial unapplied captures in attention/pending state without manufacturing a principal payment. Keep original method restoration, all event identity checks, locks, dispute ordering and monotonic refund high-water checks.

Fix the argument to existing `partialRefundDivergenceMessage` to use `fromMinorUnits(principalMinor-targetMinor,mapping.currency)`; passing gross minus remaining principal would misreport the fee as principal divergence. Preserve existing accounting delete/push hooks and `recomputeInvoiceStatus`.

**Registration edits and deliberate no-ops:**

- In `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`), the existing `invoice_stripe_payments` policy keeps all existing classifications and W1’s additions. Append `"fee_reversed_amount","fee_accounting_error"` to its `included` array, and replace its empty `excludedOpen` array with `"excludedOpen":["fee_accounting_journal"]`. JSONB is never `included` even though this journal is typed.

Replace the policy with this complete W1-preserving entry:

```ts
  "invoice_stripe_payments": tablePolicy("org_id", {"included":["fee_reversed_amount","fee_accounting_error","fee_amount","payment_method_type","source","id","org_id","invoice_id","invoice_payment_id","stripe_account_id","stripe_object_type","stripe_object_id","stripe_payment_intent_id","amount","currency","status","last_event_at","refunded_amount_minor","dispute_amount_minor","dispute_funds_withdrawn","last_dispute_event_created","last_dispute_event_id","payment_received_at","revocation_state","revocation_reason","revocation_requested_at","revoked_at","revocation_attempts","revocation_next_attempt_at","revocation_last_error","revocation_last_provider_code","revocation_requested_by_user_id","provider_expires_at","created_at","updated_at"],"reviewedIncluded":["revocation_credential_id"],"excludedSensitive":[],"excludedOpen":["fee_accounting_journal"]}),
```

- `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`) already has the alphabetical sequence `'invoice_payments', 'invoice_stripe_payments', 'invoices'`; keep it. The delete trigger enforces owed-operation retention even during cascades. Erasure can abort partway through the existing resumable walk; resolve the fee debt and rerun.
- `orgMergeRegistry.ts` already lists `"invoice_stripe_payments"` as repoint. Keep it: the journal’s frozen remote customer/connection stays unchanged when the local mapping follows its invoice. Do not reinterpret accounting destination after a merge.
- `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts` already contains `['accounting_connections','partner_id']`; direct org-axis discovery already covers the Stripe table. No new allowlist entry.
- `AUDIT_ADMIN_REQUIRED_TABLES` and `encryptedColumnRegistry.ts` need no edit: no immutable audit table or encrypted column is added. Neither income reference is a credential.
- `accounting_connections` has no org-cascade/export entry; do not add one for these columns.

- [ ] **Step 4: Run it, expect PASS**:

```bash
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/processingFeeSchema.integration.test.ts src/__tests__/integration/stripeReversalState.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/accounting-connections-rls.integration.test.ts src/__tests__/integration/stripe-payments-rls.integration.test.ts)
(cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts src/services/orgMerge.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts)
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
```

- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/accounting/accountingConnectionService.ts apps/api/src/services/accounting/accountingConnectionService.test.ts apps/api/migrations/2026-11-20-140000-accounting-fee-income-mapping.sql apps/api/migrations/2026-11-20-140001-processing-fee-reversals.sql apps/api/src/db/schema/accounting.ts apps/api/src/db/schema/stripePayments.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/stripeReversalState.ts apps/api/src/services/autopay/processingFeeSchema.integration.test.ts apps/api/src/__tests__/integration/stripeReversalState.integration.test.ts
git commit -m "feat(billing): persist cumulative fee reversals and accounting debt"
```

### Task 7: Define provider-neutral fee identity, frozen payload and adoption
**Files:** Modify `apps/api/src/services/accounting/types.ts`; Create `apps/api/src/services/accounting/accountingFeeEntry.ts`, `apps/api/src/services/accounting/accountingFeeEntry.test.ts`.
**Interfaces:** Consumes existing `AccountingConnection`, `RemoteRef`, `AccountingProviderError`; produces `AccountingFeeEntryPayload`, `AccountingProvider.postFeeEntry(conn: AccountingConnection, entry: AccountingFeeEntryPayload): Promise<RemoteRef>`, plus pure identity/adoption helpers. This is additive to the accounting interface, not a change to C4.

- [ ] **Step 1: Write the failing test** — complete `accountingFeeEntry.test.ts`:

```ts
import {expect,it,vi} from 'vitest';
import {adoptFeeEntry,feeEntryMarker,feeEntryDocumentNumber,requireFeeCreateWindow,feeEntrySettings} from './accountingFeeEntry';
import type {AccountingFeeEntryPayload} from './types';
import type {AccountingConnection} from './accountingConnectionService';
const e:AccountingFeeEntryPayload={operationId:'75c63cda-0d5c-41dc-978b-97efdd340abf',remoteCustomerId:'customer-1',amount:'2.50',
  currencyCode:'USD',txnDate:'2026-10-01',direction:'receipt',incomeRef:'income-1',bankAccountRef:null,
  exemptTaxCodeRef:null,firstSubmittedAt:'2026-10-01T00:00:00.000Z'};
it('adopts an exact receipt and uses a stable short document identity',()=>{
  expect(feeEntryDocumentNumber(e)).toHaveLength(21);
  expect(feeEntryDocumentNumber({...e})).toBe(feeEntryDocumentNumber(e));
  expect(adoptFeeEntry('quickbooks',e,[{id:'receipt-1',marker:feeEntryMarker(e),amount:'2.50',
    customerId:e.remoteCustomerId,currency:'USD',remoteVersion:'0'}])).toEqual({id:'receipt-1',remoteVersion:'0'});
});
it.each([{amount:'2.51'},{customerId:'another'},{currency:'CAD'},{deleted:true},{marker:'other'},{id:''}])('rejects ambiguous adoption %j',change=>{
  expect(()=>adoptFeeEntry('xero',e,[{id:'receipt-1',marker:feeEntryMarker(e),amount:'2.50',customerId:e.remoteCustomerId,currency:'USD',...change}])).toThrow('ambiguous');
});
it('validates provider-specific fee settings before freezing an operation',()=>{
  const conn={provider:'xero',feeIncomeItemRef:'wrong',feeIncomeAccountRef:'200',defaultPaymentAccountRef:'bank',
    defaultExemptTaxCodeRef:null} as AccountingConnection;
  expect(()=>feeEntrySettings(conn)).toThrow('exempt');
  expect(feeEntrySettings({...conn,defaultExemptTaxCodeRef:'NONE'})).toEqual({incomeRef:'200',bankAccountRef:'bank',exemptTaxCodeRef:'NONE'});
  expect(()=>feeEntrySettings({...conn,provider:'quickbooks',feeIncomeItemRef:null})).toThrow('income');
  expect(()=>feeEntrySettings({...conn,provider:'quickbooks',defaultPaymentAccountRef:null})).toThrow('payment account');
});
it('never creates again after the conservative replay window',()=>{
  vi.useFakeTimers();try{
    vi.setSystemTime(new Date('2026-10-01T00:06:00Z'));
    expect(()=>requireFeeCreateWindow('xero',e)).toThrow('uncertain');
    expect(()=>requireFeeCreateWindow('quickbooks',e)).not.toThrow();
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    expect(()=>requireFeeCreateWindow('quickbooks',e)).toThrow('uncertain');
  }finally{vi.useRealTimers();}
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/accounting/accountingFeeEntry.test.ts`; helper module missing.
- [ ] **Step 3: Implement** — add the payload to `types.ts`, and the method inside `AccountingProvider`:

```ts
export interface AccountingFeeEntryPayload {
  operationId:string; remoteCustomerId:string; amount:string; currencyCode:string; txnDate:string;
  direction:'receipt'|'refund'; incomeRef:string; bankAccountRef:string|null; exemptTaxCodeRef:string|null;
  firstSubmittedAt:string;
}
```

```ts
postFeeEntry(conn: AccountingConnection, entry: AccountingFeeEntryPayload): Promise<RemoteRef>;
```

Create the complete helper file:

```ts
import {createHash} from 'node:crypto';
import {toMinorUnits} from '@breeze/shared';
import {AccountingProviderError} from './accountingProviderError';
import type {AccountingFeeEntryPayload,AccountingProviderId,RemoteRef} from './types';
import type {AccountingConnection} from './accountingConnectionService';
export function feeEntryMarker(e:AccountingFeeEntryPayload):string{return `Breeze fee ${e.operationId}`;}
export function feeEntryDocumentNumber(e:AccountingFeeEntryPayload):string{
  return `bf${createHash('sha256').update(e.operationId).digest('hex').slice(0,19)}`;
}
export function feeEntryError(provider:AccountingProviderId,message:string,kind:'validation'|'transient'='validation'){
  return new AccountingProviderError({provider,kind,operation:'fee entry',message});
}
export function feeEntrySettings(conn:AccountingConnection):Pick<AccountingFeeEntryPayload,'incomeRef'|'bankAccountRef'|'exemptTaxCodeRef'>{
  const incomeRef=conn.provider==='xero'?conn.feeIncomeAccountRef:conn.feeIncomeItemRef;
  if(!incomeRef)throw feeEntryError(conn.provider,'Choose a processing fee income mapping in Integrations');
  if(!conn.defaultPaymentAccountRef)throw feeEntryError(conn.provider,'Choose a processing fee payment account in Integrations');
  if(conn.provider==='xero'&&!conn.defaultExemptTaxCodeRef)throw feeEntryError(conn.provider,'Choose a processing fee exempt tax code in Integrations');
  return {incomeRef,bankAccountRef:conn.defaultPaymentAccountRef,exemptTaxCodeRef:conn.defaultExemptTaxCodeRef};
}
export function validateFeeEntry(provider:AccountingProviderId,e:AccountingFeeEntryPayload):void{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.operationId)
    ||e.currencyCode!=='USD'||!/^\d{1,10}\.\d{2}$/.test(e.amount)||toMinorUnits(e.amount,'USD')<=0
    ||!Number.isFinite(Date.parse(e.firstSubmittedAt))||!e.remoteCustomerId||!e.incomeRef
    ||!/^\d{4}-\d{2}-\d{2}$/.test(e.txnDate))throw feeEntryError(provider,'Invalid processing fee entry');
}
export function requireFeeCreateWindow(provider:AccountingProviderId,e:AccountingFeeEntryPayload):void{
  const age=Date.now()-Date.parse(e.firstSubmittedAt),limit=provider==='xero'?5*60*1000:23*60*60*1000;
  if(age<0||age>=limit)throw feeEntryError(provider,'Processing fee outcome is uncertain; adoption will retry without creating another entry','transient');
}
export function adoptFeeEntry(provider:AccountingProviderId,e:AccountingFeeEntryPayload,hits:Array<{
  id:string;marker:string;amount:string;customerId:string;currency:string;remoteVersion?:string;deleted?:boolean;
}>):RemoteRef|null{
  if(!hits.length)return null;
  const h=hits[0]!;
  if(hits.length!==1||!h.id||h.deleted||h.marker!==feeEntryMarker(e)||h.customerId!==e.remoteCustomerId
    ||h.currency!==e.currencyCode||!/^\d+(?:\.\d{1,2})?$/.test(h.amount)
    ||toMinorUnits(h.amount,'USD')!==toMinorUnits(e.amount,'USD'))throw feeEntryError(provider,'Processing fee adoption is ambiguous');
  return {id:h.id,remoteVersion:h.remoteVersion};
}
```

The replay limits are conservative local safety limits, not promises of indefinite provider idempotency. Operations older than these limits still perform lookup; only creation is stopped. The official [Xero idempotency guide](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/) describes response replay through `Idempotency-Key`. Never assume it replaces permanent local identity. QBO lookup uses the existing document-number convention, with a full marker check to detect a hash collision or manual edit.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/accounting/accountingFeeEntry.test.ts`. Complete both provider tasks before the full TypeScript check because the required interface method is intentionally added first.
- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/accounting/types.ts apps/api/src/services/accounting/accountingFeeEntry.ts apps/api/src/services/accounting/accountingFeeEntry.test.ts
git commit -m "feat(accounting): define durable processing fee entry contract"
```

### Task 8: Book QuickBooks fee receipts and proportional fee refunds
**Files:** Modify `apps/api/src/services/accounting/quickbooksProvider.ts`, `apps/api/src/services/accounting/quickbooksProvider.test.ts`.
**Interfaces:** Consumes Task 7 `AccountingFeeEntryPayload` and identity helpers; produces `QuickbooksProvider.postFeeEntry` using existing private `boundary<T>` and `qboRequest<T>`. No invoice or principal payment payload changes.

- [ ] **Step 1: Write the failing test** — append within the existing provider suite, using its actual `conn(overrides)` helper, `quickbooksProvider`, and `jsonResponse`:

```ts
it.each(['receipt','refund'] as const)('posts a non-taxable fee %s using one stable operation',async direction=>{
  const entry={operationId:'75c63cda-0d5c-41dc-978b-97efdd340abf',remoteCustomerId:'customer-1',amount:'1.50',
    currencyCode:'USD',txnDate:'2026-10-01',direction,incomeRef:'fee-item',bankAccountRef:'bank-1',exemptTaxCodeRef:null,
    firstSubmittedAt:new Date().toISOString()};
  const entity=direction==='receipt'?'SalesReceipt':'RefundReceipt';
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(jsonResponse({QueryResponse:{}}))
    .mockResolvedValueOnce(jsonResponse({[entity]:{Id:'fee-1',SyncToken:'0'}}));
  expect(await quickbooksProvider.postFeeEntry(conn({homeCurrency:'USD'}),entry)).toEqual({id:'fee-1',remoteVersion:'0'});
  const [url,init]=fetcher.mock.calls[1]!;
  expect(String(url)).toContain(`requestid=${entry.operationId}`);
  const body=JSON.parse(init!.body as string);
  expect(body.CustomerRef).toEqual({value:'customer-1'});
  expect(body.Line).toEqual([{Amount:1.5,DetailType:'SalesItemLineDetail',Description:'Payment processing fee',
    SalesItemLineDetail:{ItemRef:{value:'fee-item'},Qty:1,UnitPrice:1.5,TaxCodeRef:{value:'NON'}}}]);
  expect(body).not.toHaveProperty('LinkedTxn');
});
it('adopts a fee after remote success without another create',async()=>{
  const entry={operationId:'75c63cda-0d5c-41dc-978b-97efdd340abf',remoteCustomerId:'customer-1',amount:'1.50',currencyCode:'USD',
    txnDate:'2026-10-01',direction:'receipt' as const,incomeRef:'fee-item',bankAccountRef:null,exemptTaxCodeRef:null,
    firstSubmittedAt:'2020-01-01T00:00:00Z'};
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(jsonResponse({QueryResponse:{SalesReceipt:[{
    Id:'fee-1',SyncToken:'0',PrivateNote:`Breeze fee ${entry.operationId}`,TotalAmt:1.5,CustomerRef:{value:'customer-1'},CurrencyRef:{value:'USD'},
  }]}}));
  expect((await quickbooksProvider.postFeeEntry(conn({homeCurrency:'USD'}),entry)).id).toBe('fee-1');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/accounting/quickbooksProvider.test.ts`; method missing.
- [ ] **Step 3: Implement** — add `AccountingFeeEntryPayload` to the existing types import and import helpers from `./accountingFeeEntry`. Add this complete method inside `QuickbooksProvider`:

```ts
async postFeeEntry(conn:AccountingConnection,entry:AccountingFeeEntryPayload):Promise<RemoteRef>{
  return this.boundary('QuickBooks fee entry',async()=>{
    validateFeeEntry('quickbooks',entry);
    const entity=entry.direction==='receipt'?'SalesReceipt':'RefundReceipt';
    const doc=feeEntryDocumentNumber(entry);
    type Row={Id?:string;SyncToken?:string;PrivateNote?:string;TotalAmt?:number;CustomerRef?:{value?:string};CurrencyRef?:{value?:string}};
    const query=`select * from ${entity} where DocNumber = '${doc}' maxresults 2`;
    const found=await this.qboRequest<{QueryResponse?:{SalesReceipt?:Row[];RefundReceipt?:Row[]}}>(conn,
      `query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`,'QuickBooks fee lookup');
    if(!found.QueryResponse)throw feeEntryError('quickbooks','Fee lookup could not be enumerated','transient');
    const adopted=adoptFeeEntry('quickbooks',entry,(found.QueryResponse[entity]??[]).map(row=>({
      id:row.Id??'',marker:row.PrivateNote??'',amount:String(row.TotalAmt),customerId:row.CustomerRef?.value??'',
      currency:row.CurrencyRef?.value??conn.homeCurrency??'',remoteVersion:row.SyncToken,
    })));
    if(adopted)return adopted;
    requireFeeCreateWindow('quickbooks',entry);
    const response=await this.qboRequest<{SalesReceipt?:Row;RefundReceipt?:Row}>(conn,
      `${entity.toLowerCase()}?minorversion=${QBO_API_MINOR_VERSION}&requestid=${encodeURIComponent(entry.operationId)}`,
      'QuickBooks fee create',{method:'POST',body:JSON.stringify({DocNumber:doc,PrivateNote:feeEntryMarker(entry),
        CustomerRef:{value:entry.remoteCustomerId},TxnDate:entry.txnDate,
        ...(entry.bankAccountRef?{DepositToAccountRef:{value:entry.bankAccountRef}}:{}),
        Line:[{Amount:Number(entry.amount),DetailType:'SalesItemLineDetail',Description:'Payment processing fee',
          SalesItemLineDetail:{ItemRef:{value:entry.incomeRef},Qty:1,UnitPrice:Number(entry.amount),TaxCodeRef:{value:'NON'}}}],
      })});
    const row=response[entity];
    if(!row?.Id)throw feeEntryError('quickbooks','Fee response omitted its id','transient');
    return {id:row.Id,remoteVersion:row.SyncToken};
  });
}
```

The coordinator requires the existing payment/deposit account setting before it freezes a new operation, so both QBO receipt and refund use the same explicit cash destination. Test that account on both sandbox paths in the lab. A validation refusal parks the operation, preserving its identity; it never falls back to an invoice payment. The separate refund object is consistent with Intuit’s definition of a [RefundReceipt](https://static.developer.intuit.com/sdkdocs/qbv3doc/ipp-v3-java-devkit-javadoc/com/intuit/ipp/data/RefundReceipt.html) as a refund of all or part of a sale.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/accounting/quickbooksProvider.test.ts src/services/accounting/quickbooksProviderBoundary.test.ts src/services/accounting/quickbooksProviderMechanics.test.ts`.
- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/accounting/quickbooksProvider.ts apps/api/src/services/accounting/quickbooksProvider.test.ts
git commit -m "feat(accounting): post processing fees as QuickBooks cash receipts"
```

### Task 9: Book Xero fee income and reversals as bank transactions
**Files:** Create `apps/api/src/services/accounting/xeroFeeEntries.ts`, `apps/api/src/services/accounting/xeroFeeEntries.test.ts`; Modify `apps/api/src/services/accounting/xeroProvider.ts`.
**Interfaces:** Consumes verified `xeroApiGet<T>(ctx,path,operation,opts?)`, `xeroApiWrite<T>(ctx,method,path,body,operation,opts?)`, `xeroQuery`, `XeroCallContext` in `xeroHttp.ts`, and `callContext(conn,timeoutMs?)` in `xeroProvider.ts`. Produces `postXeroFeeEntry(ctx: XeroCallContext, entry: AccountingFeeEntryPayload): Promise<RemoteRef>`.

- [ ] **Step 1: Write the failing test** — complete `xeroFeeEntries.test.ts`:

```ts
import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({get:vi.fn(),write:vi.fn()}));
vi.mock('./xeroHttp',async original=>({...await original<typeof import('./xeroHttp')>(),xeroApiGet:h.get,xeroApiWrite:h.write}));
import {postXeroFeeEntry} from './xeroFeeEntries';
import type {XeroCallContext} from './xeroHttp';
const ctx={} as XeroCallContext;
const entry={operationId:'75c63cda-0d5c-41dc-978b-97efdd340abf',remoteCustomerId:'contact-1',amount:'1.50',currencyCode:'USD',
  txnDate:'2026-10-01',direction:'receipt' as const,incomeRef:'200',bankAccountRef:'bank-1',exemptTaxCodeRef:'NONE',firstSubmittedAt:new Date().toISOString()};
beforeEach(()=>{vi.clearAllMocks();h.get.mockResolvedValue({BankTransactions:[]});
  h.write.mockResolvedValue({BankTransactions:[{BankTransactionID:'fee-1',Status:'AUTHORISED'}]});});
it.each([['receipt','RECEIVE'],['refund','SPEND']] as const)('writes %s without creating a receivable',async(direction,type)=>{
  expect(await postXeroFeeEntry(ctx,{...entry,direction})).toEqual({id:'fee-1'});
  const body=h.write.mock.calls[0]![3];
  expect(body.BankTransactions[0]).toMatchObject({Type:type,Contact:{ContactID:'contact-1'},BankAccount:{AccountID:'bank-1'},
    LineAmountTypes:'NoTax',LineItems:[{Description:'Payment processing fee',Quantity:1,UnitAmount:1.5,AccountCode:'200',TaxType:'NONE'}]});
  expect(h.write.mock.calls[0]![5]).toEqual({idempotencyKey:`breeze-fee-${entry.operationId}`});
});
it('adopts a lost acknowledgement after the create window',async()=>{
  h.get.mockResolvedValue({BankTransactions:[{BankTransactionID:'fee-1',Status:'AUTHORISED',Reference:`Breeze fee ${entry.operationId}`,
    Total:1.5,Contact:{ContactID:'contact-1'},CurrencyCode:'USD'}]});
  expect(await postXeroFeeEntry(ctx,{...entry,firstSubmittedAt:'2020-01-01T00:00:00Z'})).toEqual({id:'fee-1',remoteVersion:undefined});
  expect(h.write).not.toHaveBeenCalled();
});
it('refuses incomplete settings and malformed lookup bodies without writing',async()=>{
  await expect(postXeroFeeEntry(ctx,{...entry,bankAccountRef:null})).rejects.toThrow('payment account');
  h.get.mockResolvedValue({});await expect(postXeroFeeEntry(ctx,entry)).rejects.toThrow('enumerated');
  expect(h.write).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/accounting/xeroFeeEntries.test.ts`; missing module.
- [ ] **Step 3: Implement** — complete `xeroFeeEntries.ts`:

```ts
import {xeroApiGet,xeroApiWrite,xeroQuery,type XeroCallContext} from './xeroHttp';
import {adoptFeeEntry,feeEntryError,feeEntryMarker,requireFeeCreateWindow,validateFeeEntry} from './accountingFeeEntry';
import type {AccountingFeeEntryPayload,RemoteRef} from './types';
interface Row{BankTransactionID?:string;Reference?:string;Total?:number;Status?:string;CurrencyCode?:string;
  Contact?:{ContactID?:string};HasValidationErrors?:boolean}
export async function postXeroFeeEntry(ctx:XeroCallContext,entry:AccountingFeeEntryPayload):Promise<RemoteRef>{
  validateFeeEntry('xero',entry);
  if(!entry.bankAccountRef||!entry.exemptTaxCodeRef)throw feeEntryError('xero','Choose a payment account and exempt tax code for processing fees');
  const marker=feeEntryMarker(entry),type=entry.direction==='receipt'?'RECEIVE':'SPEND';
  const body=await xeroApiGet<{BankTransactions?:Row[]}>(ctx,`BankTransactions${xeroQuery({
    where:`Reference=="${marker}"&&Type=="${type}"`,page:1,pageSize:100})}`,'Xero fee lookup');
  if(!Array.isArray(body?.BankTransactions))throw feeEntryError('xero','Fee lookup could not be enumerated','transient');
  const adopted=adoptFeeEntry('xero',entry,body.BankTransactions.map(row=>({id:row.BankTransactionID??'',marker:row.Reference??'',
    amount:String(row.Total),customerId:row.Contact?.ContactID??'',currency:row.CurrencyCode??'',deleted:row.Status!=='AUTHORISED'})));
  if(adopted)return adopted;
  requireFeeCreateWindow('xero',entry);
  const result=await xeroApiWrite<{BankTransactions?:Row[]}>(ctx,'PUT','BankTransactions',{BankTransactions:[{
    Type:type,Contact:{ContactID:entry.remoteCustomerId},BankAccount:{AccountID:entry.bankAccountRef},Date:entry.txnDate,
    Reference:marker,CurrencyCode:entry.currencyCode,LineAmountTypes:'NoTax',LineItems:[{Description:'Payment processing fee',
      Quantity:1,UnitAmount:Number(entry.amount),AccountCode:entry.incomeRef,TaxType:entry.exemptTaxCodeRef}],
  }]},'Xero fee create',{idempotencyKey:`breeze-fee-${entry.operationId}`});
  const row=result?.BankTransactions?.[0];
  if(!row?.BankTransactionID||row.HasValidationErrors||row.Status!=='AUTHORISED')throw feeEntryError('xero','Fee response did not confirm an authorised entry','transient');
  return {id:row.BankTransactionID};
}
```

Import `postXeroFeeEntry` from `./xeroFeeEntries` and `AccountingFeeEntryPayload` from `./types` into `xeroProvider.ts`; add inside `XeroProvider`:

```ts
async postFeeEntry(conn:AccountingConnection,entry:AccountingFeeEntryPayload):Promise<RemoteRef>{
  return postXeroFeeEntry(callContext(conn),entry);
}
```

Explicit `NoTax` plus the configured exempt code avoids inheriting an account’s taxable default, which Xero otherwise applies when tax type is omitted ([Xero tax guide](https://developer.xero.com/documentation/guides/how-to-guides/tax-in-xero/)). This is bookkeeping of an already collected fee, not Xero’s deprecated Receipts expense endpoint.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/accounting/xeroFeeEntries.test.ts src/services/accounting/xeroProvider.test.ts src/services/accounting/xeroPayments.test.ts`; both provider methods now satisfy the extended interface.
- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/services/accounting/xeroFeeEntries.ts apps/api/src/services/accounting/xeroFeeEntries.test.ts apps/api/src/services/accounting/xeroProvider.ts
git commit -m "feat(accounting): post Xero processing fee bank transactions"
```

### Task 10: Drain durable fee operations through the existing accounting sweep
**Files:** Create `apps/api/src/services/accounting/accountingFeePush.ts`, `apps/api/src/services/accounting/accountingFeePush.integration.test.ts`; Modify `apps/api/src/services/accounting/types.ts`, `apps/api/src/jobs/accountingReconcileWorker.ts`, `apps/api/src/jobs/accountingReconcileWorker.test.ts`, `apps/api/vitest.integration.config.ts`, `apps/api/vitest.config.ts`.
**Interfaces:** Consumes Tasks 6–9 mapping fields and `postFeeEntry`, verified `getConnectionById(db,connectionId,partnerId)`, `resolveActiveConnection(db,partnerId)`, `getValidAccessToken(db,connection)`, `assertAccountingInvoicePushCurrency(connection,{currencyCode})`, `getAccountingProvider(id)`, `providerSupports(id,'paymentPush')`. Produces `pushFeeForStripeMapping(mappingId: string): Promise<boolean>`, `drainAccountingFees(): Promise<{posted:number;failed:number}>`. No new job name, queue, schedule or worker entrypoint.

- [ ] **Step 1: Write the failing test** — create the following real DB suite. It uses verified `createPartner`, `createOrganization`, and `upsertConnection`. Provider HTTP is mocked at the accounting provider boundary; no Stripe call occurs:

```ts
import '../../__tests__/integration/setup';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {db,hasDbAccessContext,withSystemDbAccessContext} from '../../db';
import * as dbAccess from '../../db';
import * as tokens from './accountingTokens';
import {accountingConnections,accountingEntityMappings,invoicePayments,invoiceStripePayments,invoices} from '../../db/schema';
import {createPartner,createOrganization} from '../../__tests__/integration/db-utils';
import {upsertConnection} from './accountingConnectionService';
import {getAccountingProvider} from './providerRegistry';
import {pushFeeForStripeMapping} from './accountingFeePush';
import type {AccountingFeeJournalEntry} from './types';
afterEach(()=>vi.restoreAllMocks());
async function seedFee(provider:'quickbooks'|'xero'='quickbooks'){return withSystemDbAccessContext(async()=>{
  const partner=await createPartner(),org=await createOrganization({partnerId:partner.id});
  const conn=await upsertConnection(db,partner.id,provider,{realmId:`fee-${partner.id}`,accessToken:'access',refreshToken:'refresh',
    accessTokenExpiresAt:new Date('2099-01-01'),refreshTokenExpiresAt:new Date('2099-01-01'),environment:'sandbox',
    homeCurrency:'USD',pushMode:'auto',pushPayments:true,pullPayments:false,
    feeIncomeItemRef:provider==='xero'?null:'fee-item',feeIncomeAccountRef:provider==='xero'?'200':null,
    defaultPaymentAccountRef:'bank-1',defaultExemptTaxCodeRef:'NONE'});
  await db.update(accountingConnections).set({pushPaymentsSince:null}).where(eq(accountingConnections.id,conn.id));
  const [invoice]=await db.insert(invoices).values({partnerId:partner.id,orgId:org.id,status:'paid',currencyCode:'USD',
    invoiceNumber:`FEE-${randomUUID()}`,subtotal:'100.00',taxTotal:'0.00',total:'100.00',amountPaid:'100.00',balance:'0.00'}).returning();
  const [payment]=await db.insert(invoicePayments).values({invoiceId:invoice!.id,orgId:org.id,amount:'100.00',method:'card',receivedAt:'2026-10-01'}).returning();
  await db.insert(accountingEntityMappings).values([
    {integrationId:conn.id,partnerId:partner.id,breezeEntityType:'org',breezeEntityId:org.id,remoteEntityType:'Customer',remoteEntityId:'customer-1',linkStatus:'confirmed',syncStatus:'synced'},
    {integrationId:conn.id,partnerId:partner.id,breezeEntityType:'invoice',breezeEntityId:invoice!.id,remoteEntityType:'Invoice',remoteEntityId:'invoice-1',linkStatus:'confirmed',syncStatus:'synced'},
  ]);
  const [mapping]=await db.insert(invoiceStripePayments).values({orgId:org.id,invoiceId:invoice!.id,invoicePaymentId:payment!.id,
    stripeAccountId:`acct_${partner.id}`,stripeObjectType:'payment_intent',stripeObjectId:`pi_${partner.id}`,stripePaymentIntentId:`pi_${partner.id}`,
    amount:'100.00',feeAmount:'2.50',currency:'USD',status:'succeeded',source:'autopay',paymentMethodType:'card',paymentReceivedAt:'2026-10-01'}).returning();
  return {mapping:mapping!,conn,payment:payment!};
});}
async function read(id:string){return (await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.id,id))))[0]!;}
it('serializes concurrent claims outside DB context and ignores the payment-pull switch',async()=>{
  const f=await seedFee();let release!:()=>void,entered!:()=>void;
  const wait=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockImplementation(async()=>{
    expect(hasDbAccessContext()).toBe(false);entered();await wait;return {id:'fee-1'};
  });
  const first=pushFeeForStripeMapping(f.mapping.id);await started;
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);release();await first;
  expect(post).toHaveBeenCalledTimes(1);
});
it('retries a lost response using the same operation and frozen item, then refunds and restores only fees',async()=>{
  const f=await seedFee();const posted=new Map<string,string>();
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockImplementation(async(_c,p)=>{
    if(!posted.has(p.operationId)){posted.set(p.operationId,'fee-1');throw new Error('response lost');}
    return {id:posted.get(p.operationId)!};
  });
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('response lost');
  const before=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  await expect(withSystemDbAccessContext(()=>db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id)))).rejects.toThrow();
  await withSystemDbAccessContext(()=>db.update(accountingConnections).set({feeIncomeItemRef:'different',pushPayments:false}).where(eq(accountingConnections.id,f.conn.id)));
  await withSystemDbAccessContext(async()=>{
    const row=await read(f.mapping.id);
    const journal=row.feeAccountingJournal as AccountingFeeJournalEntry[];
    journal[0]!.leaseUntil=new Date(0).toISOString();
    await db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,f.mapping.id));
  });
  await pushFeeForStripeMapping(f.mapping.id);
  expect(post.mock.calls[1]![1]).toEqual(post.mock.calls[0]![1]);
  expect(before[0]!.payload.incomeRef).toBe('fee-item');
  post.mockResolvedValue({id:'fee-reversal'});
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'1.00'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'0.00'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await pushFeeForStripeMapping(f.mapping.id);
  expect(post.mock.calls.slice(2).map(([,p])=>[p.direction,p.amount])).toEqual([['refund','1.00'],['receipt','1.00']]);
  const [payment]=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.id,f.payment.id)));
  expect(payment!.amount).toBe('100.00');
});
it('does not start the Xero replay clock when token preparation fails',async()=>{
  const f=await seedFee('xero');
  const token=vi.spyOn(tokens,'getValidAccessToken').mockRejectedValueOnce(new Error('token unavailable')).mockResolvedValue('access');
  const post=vi.spyOn(getAccountingProvider('xero'),'postFeeEntry').mockResolvedValue({id:'fee-1'});
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('token unavailable');
  const journal=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  expect(journal[0]!.payload.firstSubmittedAt).toBe('');expect(post).not.toHaveBeenCalled();
  journal[0]!.leaseUntil=new Date(0).toISOString();
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(true);expect(token).toHaveBeenCalledTimes(2);
});
it('adopts remote success after a failed local acknowledgement',async()=>{
  const f=await seedFee(),original=dbAccess.withSystemDbAccessContext;
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'fee-remote'});
  let fail=true;
  const context=vi.spyOn(dbAccess,'withSystemDbAccessContext').mockImplementation(((fn:any,label?:string)=>{
    if(label==='accountingFee.ack'&&fail){fail=false;return Promise.reject(new Error('ack unavailable'));}
    return original(fn,label);
  }) as typeof dbAccess.withSystemDbAccessContext);
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('ack unavailable');
  context.mockRestore();
  const journal=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  expect(journal[0]!.state).toBe('pending');journal[0]!.leaseUntil=new Date(0).toISOString();
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await pushFeeForStripeMapping(f.mapping.id);
  expect(post.mock.calls[1]![1]).toEqual(post.mock.calls[0]![1]);
  expect(((await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[])[0]).toMatchObject({state:'posted',remoteId:'fee-remote'});
});
it('keeps a successor acknowledgement when an expired worker finishes last',async()=>{
  const f=await seedFee();let release!:(value:{id:string})=>void,entered!:()=>void;
  const wait=new Promise<{id:string}>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockImplementationOnce(async()=>{entered();return wait;})
    .mockResolvedValueOnce({id:'adopted-id'});
  const old=pushFeeForStripeMapping(f.mapping.id);await started;
  const journal=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  journal[0]!.leaseUntil=new Date(0).toISOString();
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await pushFeeForStripeMapping(f.mapping.id);release({id:'stale-id'});await old;
  expect(((await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[])[0]!.remoteId).toBe('adopted-id');
});
it('refuses to move exported fee debt to a different accounting realm',async()=>{
  const f=await seedFee();const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'fee-1'});
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(async()=>{
    await db.update(accountingConnections).set({realmIdFingerprint:'f'.repeat(64)}).where(eq(accountingConnections.id,f.conn.id));
    await db.update(invoiceStripePayments).set({feeReversedAmount:'2.50'}).where(eq(invoiceStripePayments.id,f.mapping.id));
  });
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);expect(post).toHaveBeenCalledTimes(1);
  expect((await read(f.mapping.id)).feeAccountingError).toContain('Original accounting destination');
});
it('blocks erasure of a reversal not yet queued, then allows settled journal erasure without refunding again',async()=>{
  const f=await seedFee();const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'fee-1'});
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'2.50'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await expect(withSystemDbAccessContext(()=>db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id)))).rejects.toThrow();
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(()=>db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id)));
  expect(post.mock.calls.map(([,p])=>[p.direction,p.amount])).toEqual([['receipt','2.50'],['refund','2.50']]);
});
it('leaves no frozen operation for missing Xero settings and succeeds after repair',async()=>{
  const f=await seedFee('xero');
  await withSystemDbAccessContext(()=>db.update(accountingConnections).set({defaultExemptTaxCodeRef:null}).where(eq(accountingConnections.id,f.conn.id)));
  const post=vi.spyOn(getAccountingProvider('xero'),'postFeeEntry').mockResolvedValue({id:'bank-fee'});
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('exempt');
  expect((await read(f.mapping.id)).feeAccountingJournal).toEqual([]);expect(post).not.toHaveBeenCalled();
  await withSystemDbAccessContext(()=>db.update(accountingConnections).set({defaultExemptTaxCodeRef:'NONE'}).where(eq(accountingConnections.id,f.conn.id)));
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(true);
  expect(post.mock.calls[0]![1]).toMatchObject({incomeRef:'200',exemptTaxCodeRef:'NONE'});
});
it.each([{pushMode:'manual' as const},{pushPayments:false},{status:'reauth_required' as const}])('does not originate fee entries with %j',async change=>{
  const f=await seedFee();await withSystemDbAccessContext(()=>db.update(accountingConnections).set(change).where(eq(accountingConnections.id,f.conn.id)));
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry');
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);expect(post).not.toHaveBeenCalled();
});
```

Add this contract to existing `accountingReconcileWorker.test.ts`: mock the new drain at its import boundary, then assert it runs even when the existing connection-list mock returns no pullable connections. Use the existing `processReconcileSweep` import:

```ts
vi.mock('../services/accounting/accountingFeePush',()=>({drainAccountingFees:vi.fn(async()=>({posted:0,failed:0}))}));
```

```ts
it('runs the independent fee debt drain on every reconcile sweep',async()=>{
  const {drainAccountingFees}=await import('../services/accounting/accountingFeePush');
  await processReconcileSweep();
  expect(drainAccountingFees).toHaveBeenCalled();
});
```

Before running the new real-DB suite, add this literal to `test.include` in `apps/api/vitest.integration.config.ts` and `test.exclude` in `apps/api/vitest.config.ts`:

```ts
'src/services/accounting/accountingFeePush.integration.test.ts',
```

W1 already registers the `autopay/**/*.integration.test.ts` glob; the accounting directory has no corresponding glob. This registration is part of the failing-test setup.

- [ ] **Step 2: Run it, expect FAIL** — root `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/accounting/accountingFeePush.integration.test.ts`; missing coordinator. Unit registration check: `cd apps/api && npx vitest run src/jobs/accountingReconcileWorker.test.ts`.
- [ ] **Step 3: Implement** — add the complete journal type in `types.ts`:

```ts
export interface AccountingFeeJournalEntry {
  connectionId:string; realmFingerprint:string; payload:AccountingFeeEntryPayload;
  state:'pending'|'posted'; leaseToken:string|null; leaseUntil:string|null; remoteId:string|null; error:string|null;
}
```

Create `accountingFeePush.ts`:

```ts
import {randomUUID} from 'node:crypto';
import {and,asc,eq,gt} from 'drizzle-orm';
import {fromMinorUnits,toMinorUnits} from '@breeze/shared';
import {db,runOutsideDbContext,withSystemDbAccessContext} from '../../db';
import {accountingConnections,accountingEntityMappings,invoicePayments,invoiceStripePayments,invoices} from '../../db/schema';
import {getConnectionById,resolveActiveConnection} from './accountingConnectionService';
import {assertAccountingInvoicePushCurrency} from './accountingCurrency';
import {getAccountingProvider,providerSupports} from './providerRegistry';
import {getValidAccessToken} from './accountingTokens';
import {feeEntrySettings} from './accountingFeeEntry';
import {AccountingProviderError} from './accountingProviderError';
import type {AccountingFeeEntryPayload,AccountingFeeJournalEntry} from './types';
const LEASE_MS=10*60*1000;
function journalOf(value:unknown):AccountingFeeJournalEntry[]{
  if(!Array.isArray(value))throw new Error('Invalid processing fee journal');
  for(const e of value){if(!e||!e.payload||!['pending','posted'].includes(e.state)||!e.connectionId||!e.payload.operationId)
    throw new Error('Invalid processing fee journal');}
  return structuredClone(value) as AccountingFeeJournalEntry[];
}
const signed=(e:AccountingFeeJournalEntry)=>toMinorUnits(e.payload.amount,e.payload.currencyCode)*(e.payload.direction==='receipt'?1:-1);
async function lockMapping(id:string){
  const [ref]=await db.select({invoiceId:invoiceStripePayments.invoiceId}).from(invoiceStripePayments).where(eq(invoiceStripePayments.id,id)).limit(1);
  if(!ref)return null;
  const [invoice]=await db.select().from(invoices).where(eq(invoices.id,ref.invoiceId)).limit(1).for('update');
  if(!invoice)return null;
  const [mapping]=await db.select().from(invoiceStripePayments).where(and(eq(invoiceStripePayments.id,id),
    eq(invoiceStripePayments.invoiceId,invoice.id),eq(invoiceStripePayments.orgId,invoice.orgId))).limit(1).for('update');
  return mapping?{invoice,mapping}:null;
}
async function save(id:string,journal:AccountingFeeJournalEntry[],error:string|null=null){
  await db.update(invoiceStripePayments).set({feeAccountingJournal:journal,feeAccountingError:error}).where(eq(invoiceStripePayments.id,id));
}
async function prepare(id:string){
  const locked=await lockMapping(id);if(!locked)return null;
  const {invoice,mapping}=locked,journal=journalOf(mapping.feeAccountingJournal),first=journal[0];
  if(mapping.currency!=='USD')throw new Error('Processing fee accounting requires USD');
  const target=toMinorUnits(mapping.feeAmount,'USD')-toMinorUnits(mapping.feeReversedAmount,'USD');
  if(target<0)throw new Error('Fee reversal exceeds original fee');
  const conn=first?await getConnectionById(db,first.connectionId,invoice.partnerId):await resolveActiveConnection(db,invoice.partnerId);
  if(first&&(!conn||conn.realmIdFingerprint!==first.realmFingerprint)){
    await save(id,journal,'Original accounting destination is unavailable. Reconnect the same connection; do not send this debt to another company.');return null;
  }
  if(!first){
    if(target===0||!mapping.invoicePaymentId||!mapping.paymentReceivedAt||!['succeeded','partially_refunded','partially_disputed'].includes(mapping.status))return null;
    if(!conn||conn.status!=='connected'||!conn.pushPayments||conn.pushMode!=='auto'||!providerSupports(conn.provider,'paymentPush')||invoice.status==='void')return null;
    const [raw]=await db.select({since:accountingConnections.pushPaymentsSince}).from(accountingConnections).where(eq(accountingConnections.id,conn.id)).limit(1);
    const [payment]=await db.select().from(invoicePayments).where(eq(invoicePayments.id,mapping.invoicePaymentId)).limit(1);
    if(!raw||!payment||(raw.since&&payment.createdAt<raw.since))return null;
  }
  if(!conn||conn.status!=='connected'||!providerSupports(conn.provider,'paymentPush'))return null;
  assertAccountingInvoicePushCurrency(conn,{currencyCode:mapping.currency});
  const delta=target-journal.reduce((sum,e)=>sum+signed(e),0);
  if(delta!==0){
    let base:AccountingFeeEntryPayload;
    if(first)base=first.payload;
    else{
      const [inv]=await db.select().from(accountingEntityMappings).where(and(eq(accountingEntityMappings.integrationId,conn.id),
        eq(accountingEntityMappings.partnerId,invoice.partnerId),eq(accountingEntityMappings.breezeEntityType,'invoice'),eq(accountingEntityMappings.breezeEntityId,invoice.id))).limit(1);
      if(!inv?.remoteEntityId||!['synced','synced_with_tax_variance'].includes(inv.syncStatus))return null;
      const [customer]=await db.select().from(accountingEntityMappings).where(and(eq(accountingEntityMappings.integrationId,conn.id),
        eq(accountingEntityMappings.partnerId,invoice.partnerId),eq(accountingEntityMappings.breezeEntityType,'org'),eq(accountingEntityMappings.breezeEntityId,invoice.orgId))).limit(1);
      if(!customer?.remoteEntityId||['suggested','unlinked'].includes(customer.linkStatus))return null;
      const feeSettings=feeEntrySettings(conn);
      if(!conn.realmIdFingerprint)throw new Error('Original accounting destination has no fingerprint');
      const refusal=getAccountingProvider(conn.provider).paymentPushPreflight?.(conn);
      if(refusal)throw new Error(refusal);
      base={operationId:randomUUID(),remoteCustomerId:customer.remoteEntityId,amount:'0.00',currencyCode:mapping.currency,
        txnDate:mapping.paymentReceivedAt!,direction:'receipt',...feeSettings,firstSubmittedAt:''};
    }
    journal.push({connectionId:conn.id,realmFingerprint:first?.realmFingerprint??conn.realmIdFingerprint!,payload:{...base,
      operationId:randomUUID(),amount:fromMinorUnits(Math.abs(delta),'USD'),direction:delta>0?'receipt':'refund',
      txnDate:first?mapping.updatedAt.toISOString().slice(0,10):mapping.paymentReceivedAt!,firstSubmittedAt:''},
      state:'pending',leaseToken:null,leaseUntil:null,remoteId:null,error:null});
  }
  const next=journal.find(e=>e.state==='pending');
  if(!next){await save(id,journal);return null;}
  if(next.leaseUntil&&Date.parse(next.leaseUntil)>Date.now()){await save(id,journal);return null;}
  next.leaseToken=randomUUID();next.leaseUntil=new Date(Date.now()+LEASE_MS).toISOString();
  next.error=null;
  await save(id,journal);
  return {partnerId:invoice.partnerId,entry:structuredClone(next)};
}
export async function pushFeeForStripeMapping(id:string):Promise<boolean>{
  return runOutsideDbContext(async()=>{
    try{
      const claim=await withSystemDbAccessContext(()=>prepare(id),'accountingFee.prepare');
      if(!claim)return false;
      const conn=await withSystemDbAccessContext(()=>getConnectionById(db,claim.entry.connectionId,claim.partnerId),'accountingFee.connection');
      if(!conn||conn.status!=='connected'||conn.realmIdFingerprint!==claim.entry.realmFingerprint)throw new Error('Original fee accounting destination changed');
      const accessToken=await getValidAccessToken(db,conn);
      const payload=await withSystemDbAccessContext(async()=>{
        const row=await lockMapping(id);if(!row)return null;
        const journal=journalOf(row.mapping.feeAccountingJournal),entry=journal.find(e=>e.payload.operationId===claim.entry.payload.operationId);
        if(!entry||entry.leaseToken!==claim.entry.leaseToken)return null;
        entry.payload.firstSubmittedAt||=new Date().toISOString();await save(id,journal);
        return structuredClone(entry.payload);
      },'accountingFee.submit');
      if(!payload)return false;
      let ref:{id:string;remoteVersion?:string};
      for(let retry=0;;retry++){
        try{ref=await getAccountingProvider(conn.provider).postFeeEntry({...conn,accessToken},payload);break;}
        catch(error){
          if(retry>=2||!(error instanceof AccountingProviderError)||error.kind!=='transient'
            ||Date.now()-Date.parse(payload.firstSubmittedAt)>=4*60*1000)throw error;
          await new Promise(resolve=>setTimeout(resolve,(retry+1)*1000));
        }
      }
      await withSystemDbAccessContext(async()=>{
        const row=await lockMapping(id);if(!row)throw new Error('Processing fee journal disappeared');
        const journal=journalOf(row.mapping.feeAccountingJournal),entry=journal.find(e=>e.payload.operationId===claim.entry.payload.operationId);
        if(!entry||entry.leaseToken!==claim.entry.leaseToken)return;
        entry.state='posted';entry.remoteId=ref.id;entry.leaseToken=null;entry.leaseUntil=null;entry.error=null;
        await save(id,journal);
      },'accountingFee.ack');
      return true;
    }catch(error){
      // Keep the lease until expiry after uncertainty; retry never invents a key.
      await withSystemDbAccessContext(async()=>{
        const row=await lockMapping(id);if(!row)return;
        await db.update(invoiceStripePayments).set({feeAccountingError:error instanceof Error?error.message.slice(0,500):'Processing fee sync failed'})
          .where(eq(invoiceStripePayments.id,id));
      },'accountingFee.error');
      throw error;
    }
  });
}
export async function drainAccountingFees():Promise<{posted:number;failed:number}>{
  return runOutsideDbContext(async()=>{
    let cursor:string|undefined,posted=0,failed=0;
    for(;;){
      const rows=await withSystemDbAccessContext(()=>db.select({id:invoiceStripePayments.id}).from(invoiceStripePayments).where(and(
        gt(invoiceStripePayments.feeAmount,'0.00'),cursor?gt(invoiceStripePayments.id,cursor):undefined)).orderBy(asc(invoiceStripePayments.id)).limit(100));
      if(!rows.length)break;
      for(const row of rows)try{for(let n=0;n<20;n++){if(!await pushFeeForStripeMapping(row.id))break;posted++;}}
        catch{failed++;}
      cursor=rows[rows.length-1]!.id;
    }
    return {posted,failed};
  });
}
```

Never clear a lease in an error handler without checking its token; an older failure could otherwise steal a successor’s claim. The above test expiration is fixture setup, not production retry behavior. Tokens are obtained before `firstSubmittedAt` is recorded. Provider transient errors get at most two immediate retries using the same frozen payload; every retry first performs adoption lookup. An unresolved result outside the replay window stays adopt-only and requires operator investigation. ACK always re-reads under the same invoice→mapping lock order, so a concurrent refund or restoration is retained. Partial refund before first export exports net fee cash once; subsequent deltas are separate refund/restoration entries.

In `accountingReconcileWorker.ts`, import `drainAccountingFees` from `../services/accounting/accountingFeePush`. Immediately before `processReconcileSweep`’s existing final summary/return, inside its `runOutsideDbContext` body but **outside** the connection/pull loop, add:

```ts
const feeResult=await drainAccountingFees();
console.info('[AccountingReconcileWorker] processing fee sync',feeResult);
```

Run registration contracts: no new schedule key belongs in `scheduleRegistry`, and no new worker belongs in `workerRegistry` or `worker.ts`. Existing worker import closure now reaches this coordinator through `accountingReconcileWorker`.
- [ ] **Step 4: Run it, expect PASS**:

```bash
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/accounting/accountingFeePush.integration.test.ts)
(cd apps/api && npx vitest run src/jobs/accountingReconcileWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts src/services/accounting/neutralCore.guard.test.ts)
```

- [ ] **Step 5: Commit**:

```bash
git add apps/api/vitest.integration.config.ts apps/api/vitest.config.ts apps/api/src/services/accounting/types.ts apps/api/src/services/accounting/accountingFeePush.ts apps/api/src/services/accounting/accountingFeePush.integration.test.ts apps/api/src/jobs/accountingReconcileWorker.ts apps/api/src/jobs/accountingReconcileWorker.test.ts
git commit -m "feat(accounting): drain durable processing fee receipts and reversals"
```

### Task 11: Expose fee income mappings and sync attention in the existing connection settings
**Files:** Create `apps/web/src/components/integrations/AccountingFeeSettings.tsx`, `apps/web/src/components/integrations/AccountingFeeSettings.test.tsx`; Modify `apps/api/src/routes/accounting/index.ts`, `apps/api/src/routes/accounting/index.test.ts`, `apps/web/src/locales/en/integrations.json`, `apps/web/src/locales/de-DE/integrations.json`, `apps/web/src/locales/es-419/integrations.json`, `apps/web/src/locales/fr-CA/integrations.json`, `apps/web/src/locales/fr-FR/integrations.json`, `apps/web/src/locales/it-IT/integrations.json`, `apps/web/src/locales/pt-BR/integrations.json`, `apps/web/src/locales/tr-TR/integrations.json`.
**Read:** W1-owned `apps/api/src/services/autopay/autopayGate.ts`; reuse its flag lookup without modifying the helper.
**Interfaces:** Consumes Task 6 connection fields and existing `PATCH /accounting/:provider/settings`, `mapConnection`, `upsertConnection`, `resetConnectionForRealmChange`, `accountingPath(provider,suffix?)`, `runAction`. Consumes Task 6’s nullable fee refs on `AccountingConnection` and W1 C4 `isAutopayEnabledForPartner(db, partnerId)`. Fee-field PATCHes require rollout; ordinary settings remain ungated. Produces read-only `autopayEnabled:boolean` on both existing accounting status GET branches and `AccountingFeeSettings({provider,itemRef,accountRef,disabled,onSaved})`; Task 12 mounts it.

- [ ] **Step 1: Write the failing test** — append to the existing accounting route suite using its verified `app`, `mocks.dbUpdateSet`, `mocks.dbUpdateReturning`, `authState`. Add `autopayEnabled:vi.fn(async()=>true)` to its existing hoisted `mocks` object, add this module mock, and reset with `mocks.autopayEnabled.mockResolvedValue(true);` in the existing `beforeEach`:

```ts
vi.mock('../../services/autopay/autopayGate',()=>({isAutopayEnabledForPartner:mocks.autopayEnabled}));
```

Append these complete route regressions:

```ts
it('writes only the supplied fee mapping and refuses the wrong provider field',async()=>{
  mocks.dbUpdateReturning.mockResolvedValueOnce([{status:'connected',feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null}]);
  const request=(provider:string,body:unknown)=>app.request(`/accounting/${provider}/settings`,{
    method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  expect((await request('quickbooks',{feeIncomeItemRef:'fee-item'})).status).toBe(200);
  expect(mocks.dbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({feeIncomeItemRef:'fee-item'}));
  expect(mocks.dbUpdateSet.mock.calls.at(-1)![0]).not.toHaveProperty('pushPayments');
  expect((await request('xero',{feeIncomeItemRef:'wrong-kind'})).status).toBe(400);
  expect((await request('quickbooks',{feeIncomeAccountRef:'200'})).status).toBe(400);
  expect((await request('quickbooks',{feeIncomeItemRef:'x'.repeat(65)})).status).toBe(400);
  authState.scope='organization';
  expect((await request('quickbooks',{feeIncomeItemRef:'fee-item'})).status).toBe(403);
});
```

```ts
it.each([
  ['quickbooks',{feeIncomeItemRef:'fee-item'}],
  ['quickbooks',{feeIncomeItemRef:null}],
  ['xero',{feeIncomeAccountRef:'200'}],
  ['xero',{feeIncomeAccountRef:null}],
  ['quickbooks',{feeIncomeAccountRef:null,pushPayments:false}],
  ['xero',{feeIncomeItemRef:null,pushMode:'manual'}],
] as const)('refuses fee fields for %s with rollout off, including clears and mixed writes',async(provider,body)=>{
  mocks.autopayEnabled.mockResolvedValue(false);
  const res=await app.request(`/accounting/${provider}/settings`,{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({code:'autopay_not_enabled'});
  expect(mocks.autopayEnabled).toHaveBeenCalledWith(expect.anything(),authState.partnerId);
  expect(mocks.dbUpdateSet).not.toHaveBeenCalled();
});
it('preserves ordinary accounting settings with rollout off',async()=>{
  mocks.autopayEnabled.mockResolvedValue(false);
  mocks.dbUpdateReturning.mockResolvedValueOnce([{status:'connected',pushMode:'manual'}]);
  const res=await app.request('/accounting/quickbooks/settings',{method:'PATCH',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({pushMode:'manual'})});
  expect(res.status).toBe(200);
  expect(mocks.dbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({pushMode:'manual'}));
  expect(mocks.dbUpdateSet.mock.calls.at(-1)![0]).not.toHaveProperty('feeIncomeItemRef');
  expect(mocks.dbUpdateSet.mock.calls.at(-1)![0]).not.toHaveProperty('feeIncomeAccountRef');
});
it.each([true,false])('projects the existing partner rollout flag %s on accounting status',async enabled=>{
  mocks.autopayEnabled.mockResolvedValue(enabled);
  const res=await app.request('/accounting/quickbooks');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({autopayEnabled:enabled});
  expect(mocks.autopayEnabled).toHaveBeenCalledWith(expect.anything(),authState.partnerId);
});
```

Create `AccountingFeeSettings.test.tsx`:

```tsx
import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {fetchWithAuth} from '../../stores/auth';
import AccountingFeeSettings from './AccountingFeeSettings';
vi.mock('../../stores/auth',()=>({fetchWithAuth:vi.fn()}));
vi.mock('@/lib/navigation',()=>({navigateTo:vi.fn()}));
it('saves one nullable provider-specific ref and reports failure without losing the draft',async()=>{
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(Response.json({error:'Choose an income item'},{status:400}))
    .mockResolvedValueOnce(Response.json({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null}));
  const onSaved=vi.fn();render(<AccountingFeeSettings provider="quickbooks" itemRef={null} accountRef={null} disabled={false} onSaved={onSaved}/>);
  fireEvent.change(screen.getByTestId('autopay-accounting-fee-ref'),{target:{value:'fee-item'}});
  fireEvent.click(screen.getByTestId('autopay-accounting-fee-save'));
  await screen.findByTestId('autopay-accounting-fee-error');
  expect(screen.getByTestId('autopay-accounting-fee-ref')).toHaveValue('fee-item');
  fireEvent.click(screen.getByTestId('autopay-accounting-fee-save'));
  await waitFor(()=>expect(onSaved).toHaveBeenCalledWith({feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null}));
  expect(JSON.parse(vi.mocked(fetchWithAuth).mock.calls[1]![1]!.body as string)).toEqual({feeIncomeItemRef:'fee-item'});
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/routes/accounting/index.test.ts`; `cd apps/web && npx vitest run src/components/integrations/AccountingFeeSettings.test.tsx`. Expected: ignored/unknown fee settings, missing form/status flag, and fee-field writes accepted with rollout off.
- [ ] **Step 3: Implement** — Add these fields to `settingsSchema` in `routes/accounting/index.ts`:

```ts
feeIncomeItemRef: z.string().trim().min(1).max(64).nullable().optional(),
feeIncomeAccountRef: z.string().trim().min(1).max(64).nullable().optional(),
```

Import W1’s helper in `routes/accounting/index.ts`:

```ts
import {isAutopayEnabledForPartner} from '../../services/autopay/autopayGate';
```

In the existing PATCH handler, after `const body = c.req.valid('json')`, `resolvePartnerId`, and its error guard, but before any update or the provider-field validation below, add:

```ts
if (('feeIncomeItemRef' in body || 'feeIncomeAccountRef' in body)
  && !await isAutopayEnabledForPartner(db,partner.partnerId)) {
  return c.json({error:'Automatic payments are not enabled',code:'autopay_not_enabled'},404);
}
```

Check field presence, not truthiness: null clears and mixed ordinary/fee patches must be rejected as a whole without any write. Keep existing authentication, partner authority, MFA, validation and permissions. Do not gate the entire accounting router or ordinary settings patches. Then add the provider-field validation:

```ts
if ((provider==='xero' && body.feeIncomeItemRef != null)
  || (provider!=='xero' && body.feeIncomeAccountRef != null)) {
  return c.json({error:'Use the processing fee mapping for this accounting provider'},400);
}
```

Add to the update `.set`:

```ts
...('feeIncomeItemRef' in body ? {feeIncomeItemRef:body.feeIncomeItemRef}:{}),
...('feeIncomeAccountRef' in body ? {feeIncomeAccountRef:body.feeIncomeAccountRef}:{}),
```

Add to the safe `.returning` and connected GET response respectively:

```ts
feeIncomeItemRef: accountingConnections.feeIncomeItemRef,
feeIncomeAccountRef: accountingConnections.feeIncomeAccountRef,
```

```ts
feeIncomeItemRef: connection.feeIncomeItemRef ?? null,
feeIncomeAccountRef: connection.feeIncomeAccountRef ?? null,
```

In the authorized GET `/:provider` handler, after `resolvePartnerId` and its error guard, read the same flag:

```ts
const autopayEnabled=await isAutopayEnabledForPartner(db,partner.partnerId);
```

Add `autopayEnabled,` to both connected and disconnected JSON responses. This is a read-only projection, never a writable accounting setting, and the GET itself remains ungated so existing debt stays visible. Task 12 consumes this flag; no second rollout switch or settings endpoint is introduced.

The existing route already has full partner authority, `ACCOUNTING_MANAGE`, MFA, and a partner/provider predicate. No new route or duplicate mount in `index.ts`. Do not put these refs into billing settings.

Create the complete fee settings subform; it has one explicit Save, and no switch or autosave inside it:

```tsx
import {useEffect,useState} from 'react';
import {useTranslation} from 'react-i18next';
import '../../lib/i18n';
import {fetchWithAuth} from '../../stores/auth';
import {runAction,handleActionError} from '../../lib/runAction';
import {accountingPath,type AccountingProviderId} from '../../lib/accountingProviders';
type Saved={feeIncomeItemRef:string|null;feeIncomeAccountRef:string|null};
export default function AccountingFeeSettings({provider,itemRef,accountRef,disabled,onSaved}:{
  provider:AccountingProviderId;itemRef:string|null;accountRef:string|null;disabled:boolean;onSaved:(value:Saved)=>void;
}){
  const {t}=useTranslation('integrations');
  const current=provider==='xero'?accountRef:itemRef;
  const [draft,setDraft]=useState(current??''),[saving,setSaving]=useState(false),[error,setError]=useState(false);
  useEffect(()=>{setDraft(current??'');setError(false);},[current,provider]);
  const save=async()=>{
    if(saving||disabled||draft.trim().length>64)return;
    setSaving(true);setError(false);
    try{
      const ref=draft.trim()||null;
      const result=await runAction<Saved>({request:()=>fetchWithAuth(accountingPath(provider,'/settings'),{
        method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(provider==='xero'?{feeIncomeAccountRef:ref}:{feeIncomeItemRef:ref})}),
        errorFallback:t('accountingFees.failed'),successMessage:t('accountingFees.saved')});
      onSaved(result);
    }catch(e){setError(true);handleActionError(e,t('accountingFees.failed'));}finally{setSaving(false);}
  };
  return <section data-testid="autopay-accounting-fees" className="rounded-lg border p-4 space-y-3">
    <h3 className="font-medium">{t('accountingFees.title')}</h3>
    <label className="block" htmlFor="autopay-accounting-fee-ref">{t(provider==='xero'?'accountingFees.account':'accountingFees.item')}</label>
    <input id="autopay-accounting-fee-ref" data-testid="autopay-accounting-fee-ref" value={draft} maxLength={64}
      disabled={disabled||saving} onChange={e=>setDraft(e.target.value)} className="rounded border px-3 py-2"/>
    <p>{t('accountingFees.help')}</p>
    {error&&<p role="alert" data-testid="autopay-accounting-fee-error">{t('accountingFees.failed')}</p>}
    <button type="button" data-testid="autopay-accounting-fee-save" disabled={disabled||saving||draft.trim().length>64}
      onClick={()=>void save()}>{t('accountingFees.save')}</button>
  </section>;
}
```

Merge this object at the root of each listed integrations locale:

```json
{"accountingFees":{"title":"Processing fee income","item":"QuickBooks processing-fee item ID","account":"Xero processing-fee income account code","help":"Fees are separate non-taxable income entries for the same customer. Automatic payment push and a payment/deposit account must be configured; Xero also needs an exempt tax code. Blank leaves fee export waiting for a mapping. Existing entries keep their original destination and mapping.","save":"Save fee mapping","saved":"Processing fee mapping saved","failed":"Could not save the processing fee mapping. Check your permissions and try again.","attention":"Processing fee accounting needs attention. Check the income mapping and connection. Uncertain entries are checked before any retry."}}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/routes/accounting/index.test.ts src/routes/accounting/permissions.test.ts src/routes/accounting/partnerAuthority.test.ts src/services/accounting/accountingConnectionService.test.ts`; `cd apps/web && npx vitest run src/components/integrations/AccountingFeeSettings.test.tsx src/lib/i18n/localeParity.test.ts`.
- [ ] **Step 5: Commit**:

```bash
git add apps/api/src/routes/accounting/index.ts apps/api/src/routes/accounting/index.test.ts apps/web/src/components/integrations/AccountingFeeSettings.tsx apps/web/src/components/integrations/AccountingFeeSettings.test.tsx apps/web/src/locales/*/integrations.json
git commit -m "feat(accounting): configure processing fee income mappings"
```

### Task 12: Compose fee modules into the actual pages and exercise a browser Save
**Files:** Modify `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx`, `apps/web/src/components/billing/OrgBillingSettings.tsx`, `apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx`, `apps/web/src/components/billing/OrgBillingSettings.test.tsx`, `apps/web/src/components/integrations/AccountingConnectionPanel.tsx`, `apps/web/src/components/integrations/AccountingConnectionPanel.test.tsx`, `apps/api/src/routes/accounting/index.ts`, `apps/api/src/routes/accounting/index.test.ts`; Create `apps/web/src/components/integrations/IntegrationsPage.fees.test.tsx`, `e2e-tests/tests/autopay-processing-fees.spec.ts`; Read `apps/web/src/components/integrations/IntegrationsPage.tsx` (existing shell, no edit).
**Interfaces:** Consumes W3 Task 7’s final composition of W2’s `PaymentsSettingsTab`/`OrgPaymentsSettingsSection` and Task 11 `AccountingFeeSettings` plus accounting status `autopayEnabled:boolean` derived from W1’s rollout helper. Configuration requires `status?.autopayEnabled === true`; status, ordinary settings and debt attention remain ungated. Produces page-level `autopay-fee-settings-page`, `autopay-org-fee-settings-page`, and the mounted `autopay-accounting-fees` module. Existing page URLs and hash keys remain unchanged; no new settings screen or `settingsPageRegistry` entry.

- [ ] **Step 1: Write the failing test** — in both billing page test files add this full fixture factory; it includes W3’s required reminder projection so a fee test cannot accidentally fail during reminder loading:

```ts
function feeView(enabled=true){
  const effective={autopayOffsetDays:{value:0,source:'default'},autopayOffsetRule:{value:'later',source:'default'},
    autopayCap:{value:{enabled:false},source:'default'},achMode:{value:'ach_preferred',source:'default'},
    cardFeeBps:{value:300,source:'partner'},achFeeAmount:{value:'2.50',source:'partner'},feeAttested:true,
    remindersEnabled:{value:false,source:'default'},reminderBeforeDueDays:{value:3,source:'default'},
    reminderRepeatDays:{value:null,source:'default'},overdueReminderEveryDays:{value:7,source:'default'}};
  return {autopayEnabled:enabled,effective,inherited:effective,values:{autopayOffsetDays:null,autopayOffsetRule:null,
    autopayCapEnabled:null,autopayCapAmount:null,autopayCapCurrency:null,achMode:null,cardFeeBps:null,achFeeAmount:null}};
}
```

Append to `PartnerBillingSettingsPage.test.tsx` using its verified `fetchMock`, `json`, `renderPage`, `selectTab`:

```tsx
it('mounts fee settings in the real Payments tab',async()=>{
  fetchMock.mockImplementation(async path=>json(String(path).endsWith('/payment-settings')?feeView():
    {currencyCode:'USD',invoiceNumberPrefix:'INV',invoiceTermsDays:30}));
  renderPage();await selectTab('payments');
  expect(await screen.findByTestId('autopay-fee-settings-page')).toBeInTheDocument();
  expect(await screen.findByTestId('autopay-fees')).toBeInTheDocument();
  expect(screen.getByTestId('autopay-attest-notified')).toBeInTheDocument();
});
it('keeps the Payments tab but hides fees when rollout is off',async()=>{
  fetchMock.mockImplementation(async path=>json(String(path).endsWith('/payment-settings')?feeView(false):
    {currencyCode:'USD',invoiceNumberPrefix:'INV',invoiceTermsDays:30}));
  renderPage();await selectTab('payments');
  await screen.findByTestId('autopay-settings-save');
  expect(screen.queryByTestId('autopay-fees')).toBeNull();
});
```

Append to `OrgBillingSettings.test.tsx` using its verified `orgPayload`, `json`, `fetchMock`:

```tsx
it('mounts inherited fees without partner attestation in the org page',async()=>{
  fetchMock.mockImplementation(async path=>String(path).endsWith('/payment-settings')?json(feeView()):
    String(path).endsWith('/autopay')?json({status:'not_requested',method:null}):orgPayload());
  render(<OrgBillingSettings orgId="11111111-1111-4111-8111-111111111111"/>);
  expect(await screen.findByTestId('autopay-org-fee-settings-page')).toBeInTheDocument();
  expect(await screen.findByTestId('autopay-card-fee-bps')).toHaveAttribute('placeholder','300');
  expect(screen.queryByTestId('autopay-attest-notified')).toBeNull();
});
```

Append to the existing `AccountingConnectionPanel.test.tsx`, using its verified `connected`, `jsonResponse`, and mocked `fetchWithAuth`:

```tsx
it('mounts the fee form in the connected accounting card',async()=>{
  fetchWithAuth.mockImplementation(async(url:string)=>url==='/accounting/quickbooks'
    ?jsonResponse({...connected,autopayEnabled:true,feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null,feeAccountingErrorCount:1})
    :jsonResponse({data:[],count:0}));
  render(<AccountingConnectionPanel provider="quickbooks"/>);
  expect(await screen.findByTestId('autopay-accounting-fees')).toBeInTheDocument();
  expect(screen.getByTestId('autopay-accounting-fee-ref')).toHaveValue('fee-item');
  expect(screen.getByTestId('autopay-accounting-fee-attention')).toBeInTheDocument();
});
```

Append this rollout-off composition regression to the same panel suite; it renders the real form owner and waits for loaded status before asserting absence:

```tsx
it('hides fee configuration with rollout off but retains ordinary settings and debt attention',async()=>{
  fetchWithAuth.mockImplementation(async(url:string)=>url==='/accounting/quickbooks'
    ?jsonResponse({...connected,autopayEnabled:false,feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null,feeAccountingErrorCount:1})
    :jsonResponse({data:[],count:0}));
  render(<AccountingConnectionPanel provider="quickbooks"/>);
  expect(await screen.findByTestId('autopay-accounting-fee-attention')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-accounting-fees')).toBeNull();
  expect(screen.queryByTestId('autopay-accounting-fee-ref')).toBeNull();
  expect(screen.queryByTestId('autopay-accounting-fee-save')).toBeNull();
  expect(screen.getByTestId('quickbooks-pushmode-manual')).toBeInTheDocument();
});
```

In `routes/accounting/index.test.ts`, add `dbFeeErrorWhere:vi.fn(async()=>[{n:0}])` to the existing hoisted `mocks` object. Extend the existing `db` mock with this exact independent chain and reset `mocks.dbFeeErrorWhere.mockResolvedValue([{n:0}]);` in `beforeEach`:

```ts
select:vi.fn(()=>({from:vi.fn(()=>({innerJoin:vi.fn(()=>({where:mocks.dbFeeErrorWhere}))}))})),
```

Append these tests in the existing route suite before adding the aggregate:

```ts
it('reports only the partner fee-error count even with no surviving connection',async()=>{
  mocks.autopayEnabled.mockResolvedValue(false);
  mocks.getConnection.mockResolvedValueOnce(null);
  mocks.dbFeeErrorWhere.mockResolvedValueOnce([{n:2}]);
  const res=await app.request('/accounting/quickbooks');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({status:'disconnected',autopayEnabled:false,feeAccountingErrorCount:2});
});
it('denies selected-org callers before reading the fee-error aggregate',async()=>{
  authState.partnerOrgAccess='selected';
  expect((await app.request('/accounting/quickbooks')).status).toBe(403);
  expect(mocks.dbFeeErrorWhere).not.toHaveBeenCalled();
});
```

Create `IntegrationsPage.fees.test.tsx` with the actual page and panel, stubbing only unrelated account workbench content:

```tsx
import {expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
const h=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('../../stores/auth',async original=>({...await original<typeof import('../../stores/auth')>(),fetchWithAuth:h.fetch}));
vi.mock('../../lib/authScope',()=>({getJwtClaims:()=>({scope:'partner',partnerId:'11111111-1111-4111-8111-111111111111'}),loginPathWithNext:()=>'/login'}));
vi.mock('../../lib/permissions',()=>({usePermissions:()=>({permissions:[],can:()=>true})}));
vi.mock('../../stores/orgStore',()=>({useOrgStore:(selector:any)=>selector({currentOrgId:null})}));
vi.mock('@/lib/navigation',()=>({navigateTo:vi.fn()}));
vi.mock('./AccountingMappingWorkbench',()=>({default:()=>null}));
vi.mock('./AccountingCustomerImport',()=>({default:()=>null}));
import IntegrationsPage from './IntegrationsPage';
it.each([true,false])('composes accounting fee visibility from rollout %s through Integrations',async enabled=>{
  window.history.replaceState({},'', '/integrations#quickbooks-customers');
  const capabilities={connect:true,mapping:true,customerImport:true,invoicePush:true,paymentPull:true,paymentPush:true};
  h.fetch.mockImplementation(async(path:string)=>Response.json(path==='/accounting/providers'?{
    data:[{id:'quickbooks',displayName:'QuickBooks',configured:true,capabilities},{id:'xero',displayName:'Xero',configured:false,capabilities}],
    activeConnection:{provider:'quickbooks',status:'connected'},
  }:path==='/accounting/quickbooks'?{status:'connected',environment:'sandbox',pushMode:'auto',pullPayments:true,pushPayments:true,
    capabilities,autopayEnabled:enabled,feeAccountingErrorCount:1,feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null,features:{tenantSelection:false,settingsOptions:false}}:{data:[],count:0}));
  render(<IntegrationsPage/>);
  expect(await screen.findByTestId('autopay-accounting-fee-attention')).toBeInTheDocument();
  expect(screen.getByTestId('quickbooks-pushmode-manual')).toBeInTheDocument();
  if(enabled)expect(screen.getByTestId('autopay-accounting-fees')).toBeInTheDocument();
  else expect(screen.queryByTestId('autopay-accounting-fees')).toBeNull();
});
```

Create the browser smoke. The authenticated fixture and API routing boundary are verified in `e2e-tests/fixtures.ts`; DOM assertions use only `data-testid`:

```ts
import {test,expect} from '../fixtures';
test('processing fees display and save through the actual Payments page',async({authedPage:page})=>{
  const effective={autopayOffsetDays:{value:0,source:'default'},autopayOffsetRule:{value:'later',source:'default'},
    autopayCap:{value:{enabled:false},source:'default'},achMode:{value:'ach_preferred',source:'default'},
    cardFeeBps:{value:0,source:'default'},achFeeAmount:{value:'0.00',source:'default'},feeAttested:false,
    remindersEnabled:{value:false,source:'default'},reminderBeforeDueDays:{value:3,source:'default'},
    reminderRepeatDays:{value:null,source:'default'},overdueReminderEveryDays:{value:7,source:'default'}};
  let saved:Record<string,unknown>|null=null;
  await page.route('**/partner/billing/payment-settings',async route=>{
    if(route.request().method()==='PUT'){saved=route.request().postDataJSON();await route.fulfill({json:{success:true}});return;}
    await route.fulfill({json:{autopayEnabled:true,effective,inherited:effective,values:{autopayOffsetDays:null,autopayOffsetRule:null,
      autopayCapEnabled:null,autopayCapAmount:null,autopayCapCurrency:null,achMode:null,cardFeeBps:null,achFeeAmount:null}}});
  });
  await page.goto('/settings/billing#payments');
  await page.getByTestId('autopay-card-fee-bps').fill('300');
  await page.getByTestId('autopay-ach-fee').fill('2.50');
  await page.getByTestId('autopay-attest-notified').check();
  await expect(page.getByTestId('autopay-settings-save')).toBeDisabled();
  await page.getByTestId('autopay-attest-cost').check();
  await page.getByTestId('autopay-settings-save').click();
  await expect.poll(()=>saved).toMatchObject({cardFeeBps:300,achFeeAmount:'2.50',feeAttestation:{
    acquirerAndNetworksNotified30DaysAgo:true,doesNotExceedAcceptanceCost:true}});
});
```

This browser smoke verifies composition/hydration and Save serialization. Real RLS and money behavior remain in the integration suites; a mocked browser response is not evidence of Stripe collection.
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/web && npx vitest run src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/billing/OrgBillingSettings.test.tsx src/components/integrations/AccountingConnectionPanel.test.tsx src/components/integrations/IntegrationsPage.fees.test.tsx`. Expected: missing wrappers/accounting fee mount or fee controls visible with rollout off. Also run `cd apps/api && npx vitest run src/routes/accounting/index.test.ts`; the disconnected rollout-off fee-error count is missing.
- [ ] **Step 3: Implement** — replace the partner Payments tab expression (W3 Task 7) with:

```tsx
{activeTab==='payments'&&<div data-testid="autopay-fee-settings-page"><PaymentsSettingsTab/></div>}
```

Replace W3’s org Payments composition with:

```tsx
{paymentSettings.view&&paymentSettings.reminders&&<div data-testid="autopay-org-fee-settings-page">
  <OrgPaymentsSettingsSection view={paymentSettings.view} setValues={paymentSettings.setValues}
    reminders={paymentSettings.reminders} setReminders={paymentSettings.setReminders}
    disabled={saving||paymentSettings.saving||!canManageAutopay}/>
  {paymentSettings.view.autopayEnabled&&canManageAutopay&&<OrgAutopayCard orgId={orgId}/>}
</div>}
```

In `AccountingConnectionPanel.tsx`, import `AccountingFeeSettings` and extend `QuickbooksStatus` with `autopayEnabled?:boolean; feeIncomeItemRef?:string|null; feeIncomeAccountRef?:string|null; feeAccountingErrorCount?:number;`. Missing/loading flags fail closed for configuration. Place this in the main panel content outside the connected/disconnected branch; the form itself requires a connected account and W1 rollout, while the debt attention stays outside that gate:

```tsx
{!isOrgScoped&&<>
  {isConnected&&status?.autopayEnabled===true&&<AccountingFeeSettings provider={provider} itemRef={status?.feeIncomeItemRef??null} accountRef={status?.feeIncomeAccountRef??null}
    disabled={!canManageAccounting} onSaved={value=>setStatus(previous=>previous?{...previous,...value}:previous)}/>}
  {!!status?.feeAccountingErrorCount&&<p role="alert" data-testid="autopay-accounting-fee-attention">{t('accountingFees.attention')}</p>}
</>}
```

To expose durable failures safely, import `invoiceStripePayments` and `invoices` from the schema into `routes/accounting/index.ts` (merge existing imports). In the existing authorized GET handler, after `resolvePartnerId` and its error guard but before the `if (!connection)` branch, calculate only a count; never return journal payloads, remote identities or tokens:

```ts
const feeErrors=await db.select({n:sql<number>`count(*)::int`}).from(invoiceStripePayments)
  .innerJoin(invoices,eq(invoices.id,invoiceStripePayments.invoiceId))
  .where(and(eq(invoices.partnerId,partner.partnerId),sql`${invoiceStripePayments.feeAccountingError} IS NOT NULL`));
```

Add `feeAccountingErrorCount: feeErrors[0]?.n ?? 0` to both connected and disconnected responses, retaining Task 11’s `autopayEnabled` projection on both. Do not gate this aggregate, its attention UI, or Task 10’s already-owed fee-debt drain on rollout. Any pending fee error for this partner remains visible even when its old connection is unavailable; the text makes no claim that retargeting is safe. Keep GET read-only. The Step 1 aggregate mock and denied-caller test cover its exact Drizzle chain.

No new URL/nav destination exists. Run `settingsPageRegistry.test.ts` and preserve Payments’ hash-state behavior. Each new module now has a real page-level test; do not replace it with a stub returning its test ID.
- [ ] **Step 4: Run it, expect PASS**:

```bash
(cd apps/api && npx vitest run src/routes/accounting/index.test.ts)
(cd apps/web && npx vitest run src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/billing/OrgBillingSettings.test.tsx src/components/integrations/AccountingConnectionPanel.test.tsx src/components/integrations/IntegrationsPage.fees.test.tsx src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts)
pnpm wt-stack up
(cd e2e-tests && npx playwright test tests/autopay-processing-fees.spec.ts --project=chromium)
```

- [ ] **Step 5: Commit**:

```bash
git add apps/web/src/components/billing/PartnerBillingSettingsPage.tsx apps/web/src/components/billing/OrgBillingSettings.tsx apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx apps/web/src/components/billing/OrgBillingSettings.test.tsx apps/web/src/components/integrations/AccountingConnectionPanel.tsx apps/web/src/components/integrations/AccountingConnectionPanel.test.tsx apps/web/src/components/integrations/IntegrationsPage.fees.test.tsx apps/api/src/routes/accounting/index.ts apps/api/src/routes/accounting/index.test.ts e2e-tests/tests/autopay-processing-fees.spec.ts
git commit -m "feat(billing): compose fee controls and accounting attention in settings pages"
```

### Task 13: Verification and Stripe test-mode lab
**Files:** Test every test file named in Tasks 1–12, explicitly including Task 4 bank authorization, Task 6 linked-attempt reversals, and Tasks 11–12 accounting API/panel/page rollout regressions; no new implementation file. Review `apps/api/src/index.ts`, `apps/api/src/jobs/scheduleRegistry.ts`, `apps/api/src/services/workerRegistry.ts`, `apps/api/src/worker.ts`, `apps/web/src/lib/settingsCatalog.ts` for retained registrations.
**Interfaces:** Consumes the complete single-PR change; produces recorded test output and lab evidence in the PR body. A plan’s expected results are not a claim that tests passed.

- [ ] **Step 1: Write the failing test** — the erasure regression below belongs to Task 10's initial test batch, before its implementation; keep it in `accountingFeePush.integration.test.ts`. At verification time, inspect the initial failing output and execute the completed test again. This task adds no late production behavior.

```ts
it('blocks erasure of a reversal not yet queued, then allows settled journal erasure without refunding again',async()=>{
  const f=await seedFee();const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'fee-1'});
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'2.50'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await expect(withSystemDbAccessContext(()=>db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id)))).rejects.toThrow();
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(()=>db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id)));
  expect(post.mock.calls.map(([,p])=>[p.direction,p.amount])).toEqual([['receipt','2.50'],['refund','2.50']]);
});
```

- [ ] **Step 2: Run it, expect FAIL** — on the pre-Task-10 implementation the exact command `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/accounting/accountingFeePush.integration.test.ts` fails because the coordinator is absent. At final verification, require the recorded initial failure rather than deleting a working constraint to manufacture a failure.
- [ ] **Step 3: Implement** — no additional production change. Check the final implementation against the exact SQL guard and journal ACK/claim code above; retain the test. Run these commands from root, using subshells to avoid working-directory drift:

```bash
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec astro check
pnpm --filter @breeze/portal exec astro check
(cd packages/shared && npx vitest run src/validators/autopay.test.ts)
(cd apps/api && npx vitest run src/services/autopay src/services/accounting src/routes/accounting src/index.autopayRoutes.test.ts src/services/stripeReconcile.test.ts src/jobs/accountingReconcileWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts src/services/orgMerge.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/__tests__/partner-wide-write-coverage.test.ts)
(cd apps/web && npx vitest run src/components/billing/PaymentsSettingsTab.test.tsx src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/billing/OrgBillingSettings.test.tsx src/components/integrations/AccountingFeeSettings.test.tsx src/components/integrations/AccountingConnectionPanel.test.tsx src/components/integrations/IntegrationsPage.fees.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts)
(cd apps/portal && npx vitest run src/components/portal/AutopaySetupPage.test.tsx src/components/portal/AutopaySetupPage.fees.test.tsx)
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/processingFeeSchema.integration.test.ts src/services/autopay/charging.integration.test.ts src/services/accounting/accountingFeePush.integration.test.ts src/__tests__/integration/stripeReversalState.integration.test.ts src/__tests__/integration/stripeSettle.integration.test.ts src/__tests__/integration/accountingPaymentPush.integration.test.ts src/__tests__/integration/accountingPaymentPull.integration.test.ts src/__tests__/integration/accounting-connections-rls.integration.test.ts src/__tests__/integration/stripe-payments-rls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts)
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
pnpm wt-stack up
(cd e2e-tests && npx playwright test tests/autopay-processing-fees.spec.ts --project=chromium)
pnpm wt-stack down
pnpm test-stack down
```

- [ ] **Step 4: Run it, expect PASS** — all above commands discover their intended files and pass; no skipped real-DB suite counts as a pass. Check a cross-org write as `breeze_app` fails with `42501`. Explicitly verify CW-11: the bank fee ceiling returns `client_authorization_required` with no attempt/provider call/token consumption; CW-12: the linked-attempt withdrawal is applied before principal/rail reinstatement assertions; CW-13: fee-field PATCHes (including null and mixed bodies) return `404 autopay_not_enabled`, enabled writes still work, off-rollout forms stay hidden, and ordinary settings plus connected/disconnected debt attention remain available. Task 10 debt processing retains its existing ungated behavior. The typecheck must include the collection engine (including W4’s retained `feeMinor` comparison), both provider adapters and the web/portal islands. Inspect a small viewport: labels, basis-point/percent pairing, both affirmations, inherited zero/blank state, and one Save per fee form are readable and keyboard accessible.
- [ ] **Step 5: Commit** — implementation-time verification checkpoint. The regression was written and committed with Task 10; `--allow-empty` records this final checkpoint without rewriting or duplicating test changes:

```bash
git add apps/api/src/services/accounting/accountingFeePush.integration.test.ts
git commit --allow-empty -m "test(billing): record processing fee verification checkpoint"
```

**Stripe test-mode lab checklist** — run on a disposable worktree stack after the automated suites. Record invoice, attempt, outbox and mapping IDs in private PR evidence; never commit keys, customers or infrastructure addresses.

- [ ] Enable the partner rollout switch. Set card 300 bps and ACH 2.50 without attestation: a credit quote returns `not_attested`, card charge fee stays zero. Attest both statements through the partner form and verify server user/time. Try the org API with the same attestation: 400; try an org token against partner PUT: 403.
- [ ] Enroll a test credit card for a US/NY customer. Verify per-method setup terms, protected enrolled text, notice `$100.00 + $3.00 card processing fee`, Stripe gross 103.00, invoice principal 100.00 and protected receipt principal/fee/total. Override the editable template to omit amounts and repeat: protected text remains.
- [ ] Verify debit, prepaid/unknown funding, CA/CT/ME/MA and non-US account quotes suppress card fees. Move the organization to CO after a 3.00 notice: the charge is at most 2.00. Increase fees after a smaller notice: collection defers/re-notices, never silently charges above that notice.
- [ ] Override an org to zero, then clear it to inherit. Confirm the API raw values, resolver source and resulting charge agree. Disable rollout: billing and accounting fee controls disappear while reminders and ordinary accounting settings remain editable; PATCH either fee-mapping field, including null clears, returns `404 autopay_not_enabled` without applying mixed ordinary fields. Existing fee debt attention remains visible and already-owed debt drains; already processing attempts still reconcile. Re-enable rollout before changing mappings; no off-rollout repair exception exists.
- [ ] Enroll ACH with instant verification and microdeposit pending. Verify fee terms before authorization, no fee on setup itself, and eventual USD principal+flat fee on the PaymentIntent. Authorize a nonzero bank fee, then raise the configured fee before collection: the original authorization must refuse the excess without consuming its token. Test a return; invoice reopens by principal only, fee reversal is tracked. A stop while processing does not erase the fee history.
- [ ] Refund 51.50 of a 103.00 charge, repeat the event, then refund the rest. Expect principal reversal 50.00 then 100.00 cumulative, fee 1.50 then 3.00 cumulative, never a fee in `invoice_payments`. Test a dispute withdrawal and reinstatement after a partial refund; retain the prior refunded share and original card/ACH method.
- [ ] Configure QBO’s fee item in the sandbox. Verify SalesReceipt amount equals fee only, the same customer, no invoice linkage, NON tax, and RefundReceipt on fee reversal. Verify the configured payment account receives the receipt and funds the refund; a missing account must fail before a journal operation is frozen. Export the principal through its existing Payment path once.
- [ ] Configure Xero’s income account, payment account and exempt code. Verify RECEIVE fee income and SPEND reversal, ContactID binding, NoTax treatment and unchanged accounting invoice. A won dispute produces a new positive entry for only the restored fee share.
- [ ] Simulate response loss/local ACK failure with provider test doubles: same operation ID/payload on retry, marker adoption, no duplicate cash entry. Let the replay window expire: lookup continues; creation is refused and the connection card shows attention. Do not resolve ambiguity by minting another ID.
- [ ] Disconnect/reconnect the same accounting row during a retry; verify the original destination stays bound. Replacing it with a different connection must park old fee debt, not send it to a new company. Disable payment pull and verify fee drain still runs; disable payment push and verify already owed fee refunds still run.
- [ ] Verify pending fee operations prevent org erasure with `PROCESSING_FEE_ACCOUNTING_PENDING`. Once all known operations match the current net fee, erasure can proceed without issuing a new Stripe refund. Shut down both stacks and record that none was left running.

**PR evidence:** one W05 PR, all 13 tasks, home/level/resolver/count statement from Global Constraints, successful automated commands, sandbox results, and any operator intervention needed for adopt-only accounting errors. Remaining limitations are explicit: invalid remote item/account references require operator repair, and a submitted frozen operation cannot be silently retargeted; provider replay windows are finite; replacement accounting connections do not inherit old debts; existing partial principal-payment divergence still requires the accounting reconciliation workflow.
