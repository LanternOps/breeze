# Autopay W02: Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let clients authorize, update, pause, and stop automatic payments for enabled partners without initiating automatic charges.
**Architecture:** W02 builds enrollment on W01's tenant-scoped settings, tokens, notice outbox, and Stripe account binding. Short database transactions preserve consent and enrollment generations; Stripe setup and reconciliation run outside those transactions. W2a ships the API, notifications, and recovery jobs; W2b composes the MSP and customer portal screens.
**Tech Stack:** TypeScript, Hono, PostgreSQL with Drizzle and forced RLS, Stripe Checkout, BullMQ, Astro, React, Vitest, and Playwright.
**Spec:** docs/superpowers/specs/billing/2026-10-01-autopay-design.md · **Index:** docs/superpowers/plans/billing/2026-10-01-autopay-index.md

## Preconditions

- W1a and W1b must be implemented and merged before executing this plan. At plan authoring, `apps/api/src/db/schema/autopay.ts` and `apps/api/src/services/autopay/` do not exist. C2–C4 references to those modules are required future interfaces, not claims about existing code. Verify their exports and actual column nullability before applying the code below; preserve the index's signatures.
- W2a precedes W2b. Neither PR creates schedules, charges an invoice by bank, or adds skip/confirm pages. W4 owns those operations.
- Read the approved spec, binding index, `CLAUDE.md`, and `.claude/skills/breeze-testing/SKILL.md` in full. Keep commits below as implementation instructions; authoring this plan does not execute them.
- Run migration naming checks against the actual newest migration before implementation. W2 uses the reserved `2026-11-20-1100NN-` block only while it still sorts after committed history.
- Retain existing uncommitted work. This planning task creates only this document; no feature registration, GitHub writes, application edits, package installation, migration execution, or commits are authorized by this task.

## Where this plan corrects or refines the spec/index

1. **W01 is a prerequisite, not present source.** The index declares `Tx` shorthand but `invoiceService.ts` does not export a `Tx` type. `InvoiceActor` is declared in `apps/api/src/services/invoiceTypes.ts` and re-exported by `invoiceService.ts`. Import W1 Task 5's `Tx` from `services/autopay/types.ts` (`typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]`) in payment methods, enrollment lifecycle and disclosure helpers. Never narrow C4 to `typeof db` or invent an `invoiceService.ts` export; raw transactions must remain accepted (CW-04).
2. **Consent needs durable pre-redirect storage.** C2's append-only `orgAutopayConsents` is the completed consent history; it cannot safely serve as a mutable setup attempt. Store the exact accepted terms, server-derived identities, generation, and setup reference before leaving Breeze, so a lost return, settings edit, or delayed microdeposit result cannot substitute new terms. The private W2 setup record and its migration are an additive refinement; C2 table names and C4 signatures stay unchanged.
3. **The notification enum needs a migration.** `notificationTypeEnum` in `apps/api/src/db/schema/notifications.ts` is a PostgreSQL enum sourced from `NOTIFICATION_TYPES`. Adding the TypeScript value alone cannot persist a `billing` notification. W2 includes an idempotent enum extension in its reserved migration block.
4. **Staff delivery differs from client outbox delivery.** `dispatchNotice` in `apps/api/src/services/contractRenewal.ts` sends staff email through `getEmailService().sendEmail`; it does not put staff notices in the billing notice outbox. Its `sendInAppNotification` call produces an alert. W2 retains the staff-email transport but inserts typed `billing` notifications and sends to the partner billing address. It does not invent an additional C3 notice kind.
5. **A removed async context is not a committed transaction.** `SELF_MANAGED_DB_CONTEXT_ROUTES` in `apps/api/src/middleware/selfManagedDbContextRoutes.ts` explicitly documents that `runOutsideDbContext` leaves the outer request transaction held. Setup and return endpoints must opt out and open their own short contexts. `runAfterDbContextExit` in `apps/api/src/db/index.ts` runs on rollback too; detachment must re-read committed removal state before calling Stripe and have a durable retry path.
6. **Colocated integration suites need discovery registration.** The `test.include` list in `apps/api/vitest.integration.config.ts` enumerates colocated real-DB suites. A filename ending in `.integration.test.ts` alone does not make it run. Register W2 suites there and exclude them from the unit runner.
7. **The request template variable list stays closed.** C6 does not allow `schedule_text` in editable `autopay_request` variables. Put the schedule and mandatory stop/fee/authorization disclosures in the renderer's non-editable append block. Extend W1's otherwise unspecified `BillingNoticeContext` additively for W2 rather than claiming its fields already exist.

8. **Settings navigation is a catalog, not a runtime registry with the spec's name.** `SETTINGS_CATALOG` in `apps/web/src/lib/settingsCatalog.ts` is the production source; `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts` is its reachability contract. Add the Payments destination to that catalog and assert it in the existing contract.
9. **Portal follows a separate presentation convention.** `lineWorkedVsBilledNote` in `apps/portal/src/lib/api.ts` explicitly states that portal has no i18n runtime; `apps/portal/package.json` has no react-i18next dependency. Keep portal copy in its existing English convention and add a portal-local `runAction` adapter around its API response shape. Web strings still use react-i18next and locale fallbacks.
10. **The real app is not currently importable without boot.** `app` in `apps/api/src/index.ts` is not exported, and the file unconditionally calls `bootstrap`; `index.bootBinarySync.test.ts` documents that side effect. Export the existing app and suppress only the bootstrap call under `NODE_ENV === 'test'` so mounting tests exercise the actual route composition.
11. **Effective settings alone cannot populate inheritance controls.** C4's resolver output intentionally returns effective values and sources, not raw nullable overrides. Add raw values and inherited effective values to the C7 GET response without changing the resolver signature; blank means null, while explicit unlimited remains false. The UI must never infer raw overrides from effective values.

12. **Partner-axis visibility belongs to the mutation orchestration (CW-05).** W1 Task 11's `getAutopayStripeReadiness` uses the passed executor and never escalates it. As `db/partnerAxisRead.ts` documents, organization scope has `accessiblePartnerIds: []` and cannot read `partners` or `stripe_connect_accounts`. Task 10 therefore opens short system contexts for staff mutations after real auth, `BILLING_MANAGE`, rollout and org-allowlist checks; Task 5 rechecks the actor’s non-null partner and org access, and the locked org's partner before any mutation. C4 services keep their caller-supplied `Tx` and never open a replacement transaction. Task 11 already supplies verified token/portal identity and a short system context for client stop. No RLS policy or C4 signature changes; Task 12 proves org-scoped request, notice rendering and resume through the real app and unprivileged database role.

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


- W2 feature switch is `partners.autopay_enabled` / `autopayEnabled`, default false. Disabled MSP, public, and portal autopay routes return 404 with `autopay_not_enabled`; background reconciliation still observes already-created Stripe objects.
- Defaults remain offset `0`, rule `later`, cap disabled, ACH `ach_preferred`, card fee `0`, ACH fee `'0.00'`. W2 does not expose fee or reminder writes.
- Generation increases on a request/re-enrollment, never on active-method replacement. A stale result returns `stale_generation` and cannot reactivate, replace a current method, or overwrite consent.
- Pending microdeposit verification may make enrollment active but cannot stamp the first usable `effective_from` until verification succeeds. Pause cancels future schedules; resume starts eligibility at resume time and never restores old schedules.
- Stopping cancels non-terminal schedules but preserves processing collection attempts and their settlement mappings. Stripe detach follows a committed removal and retries; it never attempts to recall a processing ACH debit.
- The expiry schedule is exactly `autopay-card-expiry-check`, cron `28 6 * * *`, job `card-expiry-check`, queue `autopay-jobs`. Setup reconciliation examines the last `24` hours; later verification arrives through the durable event inbox.
- All newly interactive elements use `autopay-` test IDs. W2 Payments tabs are gated; W3 may later expose the tab for reminders while keeping the Autopay section gated.

## Review Focus

1. Old authority returns after a newer request or a stopped/inactive org: Task 7 tests `old generations and superseded same-generation attempts never reactivate`, `refuses another Customer before writing a payment method`, and the real-DB `concurrent stale completions cannot reactivate a stopped enrollment`.
2. Delayed return or repeated microdeposit polling substitutes new terms or duplicates consent: Task 7 tests `retrieves provider truth and records the exact accepted authorization once` and `records no new consent or stop token when pending verification is polled twice`; Task 9 replays provider events from the durable inbox.
3. Stop rolls back or races a processing debit: Task 7's real-DB `a rolled-back stop cannot detach, and committed stop keeps a processing debit intact` verifies committed removal and preserved collection attempts; Task 2 verifies replacement-account detach refusal.
4. A disabled or foreign partner is reached through public, portal or bulk operations: Tasks 10–12 test feature gates, ownership and real application mounts before Stripe admission, including body-supplied foreign org IDs and GET safety.
5. Debit-card display or inherited settings misleads the client: Task 7 persists actual debit funding, Task 16 verifies the server-returned no-fee outcome, and Task 14 tests `keeps blank distinct from explicit unlimited and submits decimal cap without floats`.
6. C4 transaction compatibility and partner-axis visibility: Tasks 1–2 and 5 assert the shared `Tx` input; Task 12 proves raw-transaction rollback, org-scoped request/pause/resume with a frozen notice, and same-partner/foreign-partner rejection under `breeze_app`. Staff mutation services must retain their caller's transaction and validate the locked org against the authenticated partner.

## File map

These are implementation targets; only this plan is edited while planning. W1-owned paths marked Modify in tasks require the prerequisite merge. `apps/api/src/services/autopay/types.ts` is a read-only W1 dependency for Tasks 1, 2 and 5; reuse its `Tx` export without redefining it.

- `apps/api/migrations/2026-11-20-110000-autopay-setup-attempts.sql` — Idempotent tenant-scoped setup storage, forced RLS and immutable-authority trigger.
- `apps/api/src/db/schema/autopaySetupAttempts.ts` — Durable, tenant-scoped setup-attempt schema and frozen consent snapshot.
- `apps/api/src/db/schema/autopaySetupAttempts.integration.test.ts` — Regression and contract assertions for autopaySetupAttempts (real PostgreSQL).
- `apps/api/src/services/autopay/consentText.ts` — Versioned authorization text, immutable disclosure hashing and acceptance context; accepts the shared W1 `Tx`.
- `apps/api/src/services/autopay/consentText.test.ts` — Disclosure and consent regressions, including the shared W1 `Tx` parameter contract.
- `apps/api/src/db/schema/index.ts` — Export the private W2 setup-attempt table.
- `apps/api/src/services/tenantCascade.ts` — Register setup-attempt erasure ordering.
- `apps/api/src/services/orgMergeRegistry.ts` — Keep setup authority with the source org for erasure.
- `apps/api/src/services/tenantExportPolicyRegistry.ts` — Classify every setup-attempt column for export.
- `apps/api/vitest.config.ts` — Exclude colocated real-DB suites from the unit runner.
- `apps/api/vitest.integration.config.ts` — Discover all new colocated real-DB suites.
- `apps/api/src/services/autopay/paymentMethods.ts` — Payment-method lookup and unusable state on W1 `Tx`, plus committed-removal detachment.
- `apps/api/src/services/autopay/paymentMethods.test.ts` — Detachment regressions and both C4 payment-method executor type contracts.
- `packages/shared/src/utils/emailTemplates.ts` — Add fixed template IDs, variables, labels and CTA metadata.
- `packages/shared/src/constants/notificationTypes.ts` — Add the shared billing notification category.
- `apps/api/src/services/emailTemplates/defaults.ts` — Warm plain defaults for the four enrollment templates.
- `apps/api/src/services/autopay/renderBillingNotice.ts` — Register W2 renderers while preserving W1 notice dispatch.
- `apps/api/src/services/emailDomains/mailPurposes.ts` — Register staff.autopay in the platform mail lane.
- `apps/api/src/services/autopay/enrollmentNotices.ts` — Four enrollment notice renderers with protected disclosure append blocks.
- `apps/api/src/services/autopay/staffNotifications.ts` — Billing in-app notifications and staff email transport.
- `apps/api/migrations/2026-11-20-110100-autopay-billing-notification-type.sql` — Idempotent PostgreSQL billing notification enum extension.
- `apps/api/src/services/autopay/enrollmentNotices.test.ts` — Regression and contract assertions for enrollmentNotices.
- `apps/api/src/services/autopay/staffNotifications.test.ts` — Regression and contract assertions for staffNotifications.
- `apps/api/src/services/emailDomains/mailPurposes.test.ts` — Regression and contract assertions for mailPurposes.
- `apps/api/src/routes/orgs.test.ts` — Regression and contract assertions for orgs.
- `apps/web/src/components/settings/EmailTemplatesTab.tsx` — Compose Billing & payments template group.
- `apps/web/src/components/settings/EmailTemplateEditor.tsx` — Preview the new supported template variables.
- `apps/web/src/components/settings/EmailTemplatesTab.test.tsx` — Regression and contract assertions for EmailTemplatesTab.
- `packages/shared/src/utils/emailTemplates.test.ts` — Regression and contract assertions for emailTemplates.
- `apps/web/src/locales/en/settings.json` — English UI strings for settings autopay surfaces.
- `apps/web/src/locales/de-DE/settings.json` — English fallback leaves for settings autopay surfaces.
- `apps/web/src/locales/es-419/settings.json` — English fallback leaves for settings autopay surfaces.
- `apps/web/src/locales/fr-CA/settings.json` — English fallback leaves for settings autopay surfaces.
- `apps/web/src/locales/fr-FR/settings.json` — English fallback leaves for settings autopay surfaces.
- `apps/web/src/locales/it-IT/settings.json` — English fallback leaves for settings autopay surfaces.
- `apps/web/src/locales/pt-BR/settings.json` — English fallback leaves for settings autopay surfaces.
- `apps/web/src/locales/tr-TR/settings.json` — English fallback leaves for settings autopay surfaces.
- `apps/api/src/services/autopay/enrollmentLifecycle.ts` — Request, pause, resume and stop transitions on W1 `Tx`, with staff actor/partner/org authorization under org/enrollment locks.
- `apps/api/src/services/autopay/enrollmentLifecycle.test.ts` — Lifecycle regressions and all five C4 executor type contracts.
- `apps/api/src/services/autopay/enrollmentService.ts` — Binding C4 enrollment facade and exports.
- `apps/api/src/services/autopay/setupSession.ts` — Account-bound Customer recovery and setup Checkout creation.
- `apps/api/src/services/autopay/setupSession.test.ts` — Regression and contract assertions for setupSession.
- `apps/api/src/services/stripeCheckoutCallSites.test.ts` — Regression and contract assertions for stripeCheckoutCallSites.
- `apps/api/src/services/autopay/setupCompletion.ts` — Stripe retrieval, generation fencing, saved method and consent persistence.
- `apps/api/src/services/autopay/setupCompletion.test.ts` — Regression and contract assertions for setupCompletion.
- `apps/api/src/services/autopay/enrollmentService.integration.test.ts` — Regression and contract assertions for enrollmentService (real PostgreSQL).
- `apps/api/src/services/autopay/payAndSave.ts` — Explicit card authorization, invoice offer and post-settlement capture.
- `apps/api/src/services/autopay/payAndSave.test.ts` — Regression and contract assertions for payAndSave.
- `apps/api/src/services/invoiceCheckout.ts` — Card-only invoice Checkout with explicit off-session save parameters.
- `apps/api/src/services/stripeSettle.ts` — Capture authorized card only after the invoice payment is recorded.
- `apps/api/src/routes/invoicesPublic.ts` — Expose consent offer and save-enabled card Checkout on public invoices.
- `apps/api/src/routes/portal/invoices.ts` — Expose consent offer and save-enabled card Checkout on portal invoices.
- `apps/api/src/services/invoiceCheckout.test.ts` — Regression and contract assertions for invoiceCheckout.
- `apps/api/src/routes/invoicesPublic.test.ts` — Regression and contract assertions for invoicesPublic.
- `apps/api/src/routes/portal/invoices.test.ts` — Regression and contract assertions for invoices.
- `apps/api/src/services/autopay/setupReconciliation.ts` — Abandoned-return recovery and enrollment-event replay.
- `apps/api/src/services/autopay/setupReconciliation.test.ts` — Regression and contract assertions for setupReconciliation.
- `apps/api/src/jobs/stripeReconcileSweep.ts` — Recover recent setup and pay-and-save sessions.
- `apps/api/src/services/stripeFinancialEventPoller.ts` — Persist and replay setup, mandate and detach events.
- `apps/api/src/services/stripeReversalState.ts` — Keep enrollment events out of the monetary reversal reducer.
- `apps/api/src/routes/autopay/index.ts` — MSP list, bulk requests and per-org enrollment routes; staff writes use authorized short system contexts.
- `apps/api/src/routes/autopay/index.test.ts` — Route authorization, dispatch and short system-context orchestration regressions.
- `apps/api/src/services/autopay/enrollmentViews.ts` — Tenant-scoped MSP list and org enrollment projections.
- `apps/api/src/middleware/selfManagedDbContextRoutes.ts` — Release outer request transactions before Stripe workflows.
- `apps/api/src/services/autopay/autopayGate.ts` — Verified partner identity and fail-closed feature switch.
- `apps/api/src/routes/autopay/public.ts` — No-login setup, verified return and POST-only stop routes.
- `apps/api/src/routes/portal/paymentMethods.ts` — Authenticated portal method setup, return and stop routes.
- `apps/api/src/services/autopay/customerViews.ts` — Token/portal identity, branded setup data and owned completion.
- `apps/api/src/routes/autopay/public.test.ts` — Regression and contract assertions for public.
- `apps/api/src/routes/portal/paymentMethods.test.ts` — Detachment regressions and both C4 payment-method executor type contracts.
- `apps/api/src/middleware/partnerGuard.ts` — Admit explicit public autopay routes without staff authentication.
- `apps/api/src/routes/portal/helpers.ts` — Require JSON and existing cookie CSRF for autopay mutations.
- `apps/api/src/index.ts` — Export the real app safely in tests and mount all W2 API routers.
- `apps/api/src/index.autopay.integration.test.ts` — Real application mounts plus org-scoped request/notice/pause/resume, tenant rejection, and raw-transaction rollback under `breeze_app`.
- `apps/api/src/services/autopay/cardExpiryCheck.ts` — Once-per-method expiring-card notices.
- `apps/api/src/services/autopay/cardExpiryCheck.test.ts` — Regression and contract assertions for cardExpiryCheck.
- `apps/api/src/services/autopay/cardExpiryCheck.integration.test.ts` — Regression and contract assertions for cardExpiryCheck (real PostgreSQL).
- `apps/api/src/jobs/autopayWorker.ts` — Dispatch notices and expiry checks without losing W1 detach draining.
- `apps/api/src/jobs/scheduleRegistry.ts` — Register the exact autopay-card-expiry-check cron.
- `apps/api/src/services/workerRegistry.ts` — Register the worker lifecycle and preserve global-worker closure.
- `apps/api/src/jobs/autopayWorker.test.ts` — Regression and contract assertions for autopayWorker.
- `apps/api/src/jobs/scheduleRegistry.contract.test.ts` — Regression and contract assertions for scheduleRegistry.contract.
- `apps/api/src/services/workerEntrypointClosure.contract.test.ts` — Regression and contract assertions for workerEntrypointClosure.contract.
- `apps/api/src/services/autopay/paymentSettingsView.ts` — Raw overrides and inherited/effective settings projection.
- `apps/api/src/services/autopay/paymentSettingsView.test.ts` — Regression and contract assertions for paymentSettingsView.
- `apps/web/src/components/billing/PaymentsSettingsTab.tsx` — Partner settings form and reusable settings state hook.
- `apps/web/src/components/billing/OrgPaymentsSettingsSection.tsx` — Org overrides with blank inheritance and visible sources.
- `apps/web/src/components/billing/PaymentsSettingsTab.test.tsx` — Regression and contract assertions for PaymentsSettingsTab.
- `apps/api/src/routes/billingPaymentSettings.ts` — Mount raw/inherited settings projection into authorized W1 GETs.
- `apps/web/src/locales/en/billing.json` — English UI strings for billing autopay surfaces.
- `apps/web/src/locales/de-DE/billing.json` — English fallback leaves for billing autopay surfaces.
- `apps/web/src/locales/es-419/billing.json` — English fallback leaves for billing autopay surfaces.
- `apps/web/src/locales/fr-CA/billing.json` — English fallback leaves for billing autopay surfaces.
- `apps/web/src/locales/fr-FR/billing.json` — English fallback leaves for billing autopay surfaces.
- `apps/web/src/locales/it-IT/billing.json` — English fallback leaves for billing autopay surfaces.
- `apps/web/src/locales/pt-BR/billing.json` — English fallback leaves for billing autopay surfaces.
- `apps/web/src/locales/tr-TR/billing.json` — English fallback leaves for billing autopay surfaces.
- `apps/web/src/components/billing/autopayClient.ts` — Typed MSP transport with runAction mutation feedback.
- `apps/web/src/components/billing/OrgAutopayCard.tsx` — Org status, readiness, request and lifecycle controls.
- `apps/web/src/components/billing/AutopayListPage.tsx` — Bulk requests, statuses and unasked-client prompt.
- `apps/web/src/components/billing/AutopayListPage.test.tsx` — Regression and contract assertions for AutopayListPage.
- `apps/web/src/components/billing/OrgAutopayCard.test.tsx` — Regression and contract assertions for OrgAutopayCard.
- `apps/portal/src/lib/runAction.ts` — Portal response adapter with visible mutation outcomes.
- `apps/portal/src/lib/runAction.test.ts` — Regression and contract assertions for runAction.
- `apps/portal/src/lib/autopay.ts` — Customer enrollment response types.
- `apps/portal/src/components/portal/AutopaySetupPage.tsx` — Public and portal authorization, return and stop outcomes.
- `apps/portal/src/components/portal/AutopaySetupPage.test.tsx` — Regression and contract assertions for AutopaySetupPage.
- `apps/portal/src/components/portal/PaymentMethodsPage.tsx` — Authenticated saved-method view and update/stop actions.
- `apps/portal/src/components/portal/PaymentMethodsPage.test.tsx` — Regression and contract assertions for PaymentMethodsPage.
- `apps/portal/src/lib/api.ts` — Extend invoice DTOs and payment helpers for explicit authorization.
- `apps/portal/src/components/portal/PublicInvoiceView.tsx` — Unticked card-saving authorization on the public invoice.
- `apps/portal/src/components/portal/InvoiceDetailView.tsx` — Unticked card-saving authorization on the portal invoice.
- `apps/portal/src/components/portal/InvoiceDetailView.test.tsx` — Regression and contract assertions for InvoiceDetailView.
- `apps/portal/src/components/portal/PublicInvoiceView.test.tsx` — Regression and contract assertions for PublicInvoiceView.
- `apps/web/src/lib/navGates.test.ts` — Regression and contract assertions for navGates.
- `apps/web/src/lib/autopayVisibility.ts` — Read feature availability for web composition.
- `apps/web/src/components/billing/AutopayComposition.test.tsx` — Regression and contract assertions for AutopayComposition.
- `apps/web/src/pages/billing/autopay.astro` — Compose the MSP Autopay list in DashboardLayout.
- `apps/portal/src/pages/autopay/[token].astro` — Compose the public setup page in its public shell.
- `apps/portal/src/pages/autopay/return.astro` — Compose the verified setup return page in its public shell.
- `apps/portal/src/pages/autopay/[token]/stop.astro` — Compose the stop confirmation page in its public shell.
- `apps/portal/src/pages/payment-methods/index.astro` — Compose authenticated Payment methods page with server admission.
- `apps/portal/src/pages/autopay/composition.test.tsx` — Regression and contract assertions for composition.
- `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx` — Mount the gated payments hash tab.
- `apps/web/src/components/billing/OrgBillingSettings.tsx` — Compose org payment settings and enrollment controls.
- `apps/web/src/components/layout/Sidebar.tsx` — Gate the Billing Autopay navigation entry.
- `apps/web/src/components/settings/SettingsCatalog.tsx` — Apply autopay availability to settings navigation.
- `apps/web/src/lib/navGates.ts` — Fail-closed autopay navigation predicate.
- `apps/web/src/lib/settingsCatalog.ts` — Register the single Payments settings destination.
- `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts` — Regression and contract assertions for settingsPageRegistry.
- `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` — Regression and contract assertions for no-silent-mutations.
- `apps/web/src/lib/i18n/translationCoverage.test.ts` — Regression and contract assertions for translationCoverage.
- `apps/web/src/locales/en/common.json` — English UI strings for common autopay surfaces.
- `apps/web/src/locales/de-DE/common.json` — English fallback leaves for common autopay surfaces.
- `apps/web/src/locales/es-419/common.json` — English fallback leaves for common autopay surfaces.
- `apps/web/src/locales/fr-CA/common.json` — English fallback leaves for common autopay surfaces.
- `apps/web/src/locales/fr-FR/common.json` — English fallback leaves for common autopay surfaces.
- `apps/web/src/locales/it-IT/common.json` — English fallback leaves for common autopay surfaces.
- `apps/web/src/locales/pt-BR/common.json` — English fallback leaves for common autopay surfaces.
- `apps/web/src/locales/tr-TR/common.json` — English fallback leaves for common autopay surfaces.
- `apps/web/src/locales/en/pages.json` — English UI strings for pages autopay surfaces.
- `apps/web/src/locales/de-DE/pages.json` — English fallback leaves for pages autopay surfaces.
- `apps/web/src/locales/es-419/pages.json` — English fallback leaves for pages autopay surfaces.
- `apps/web/src/locales/fr-CA/pages.json` — English fallback leaves for pages autopay surfaces.
- `apps/web/src/locales/fr-FR/pages.json` — English fallback leaves for pages autopay surfaces.
- `apps/web/src/locales/it-IT/pages.json` — English fallback leaves for pages autopay surfaces.
- `apps/web/src/locales/pt-BR/pages.json` — English fallback leaves for pages autopay surfaces.
- `apps/web/src/locales/tr-TR/pages.json` — English fallback leaves for pages autopay surfaces.
- `apps/portal/src/lib/navItems.ts` — Add gated customer Payment methods navigation.
- `apps/portal/src/lib/navItems.test.ts` — Regression and contract assertions for navItems.
- `apps/portal/src/layouts/PortalLayout.astro` — Compose customer navigation using gated availability.
- `apps/portal/src/lib/protectedPaths.ts` — Protect the Payment methods route.
- `apps/portal/src/lib/protectedPaths.test.ts` — Regression and contract assertions for protectedPaths.
- `apps/portal/src/middleware.ts` — Apply no-store, no-referrer and no-index headers to token pages.
- `apps/portal/src/middleware.test.ts` — Regression and contract assertions for middleware.
- `e2e-tests/pages/AutopayEnrollmentPage.ts` — data-testid-only Playwright page object.
- `e2e-tests/tests/autopay-enrollment.spec.ts` — Regression and contract assertions for autopay-enrollment.

---

**PR split:** W2a is Tasks 1–13 (API, storage, emails, template editor and jobs). W2b is Tasks 14–19 (web/portal UI, composition and browser smoke). Task 20 verifies each PR against its applicable gates; execute its API/DB/lab subset before W2a and the complete checklist before W2b.

### Task 1: Preserve the authorization accepted before leaving Breeze
**Files:** Create `apps/api/migrations/2026-11-20-110000-autopay-setup-attempts.sql`, `apps/api/src/db/schema/autopaySetupAttempts.ts`, `apps/api/src/db/schema/autopaySetupAttempts.integration.test.ts`, `apps/api/src/services/autopay/consentText.ts`, `apps/api/src/services/autopay/consentText.test.ts`; Modify `apps/api/src/db/schema/index.ts`, `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/orgMergeRegistry.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/vitest.config.ts`, `apps/api/vitest.integration.config.ts`. Read W1 `apps/api/src/services/autopay/types.ts`; do not modify it.
**Interfaces:** Consumes W1 `Tx` from `./types` and C4 `resolveBillingPaymentSettings(db, {partnerId,orgId})`, `getAutopayStripeReadiness(db,partnerId)`, `quoteProcessingFee(input)` and C2 enrollment schema. Produces C4 `AUTOPAY_CONSENT_TEXT`, `CURRENT_AUTOPAY_CONSENT_VERSION`; private `autopaySetupAttempts`, `AutopayDisclosure`, `buildAutopayDisclosure`, `withAcceptedAutopayDisclosure`, `requireAcceptedAutopayDisclosure`.

The attempt is transaction data, not configuration: organization ownership is deliberate. Its immutable snapshot includes the *rendered* authorization, contact, source and settings accepted before redirect. Do not reconstruct consent from present-day settings when Stripe calls back. A client supplied `disclosureHash` is compared with the current server disclosure before saving; a mismatch returns 409 and requires showing the new terms. The private async context carries this precondition without changing C4's signature.

- [ ] **Step 1: Write the failing test** — create `consentText.test.ts`:
```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AUTOPAY_CONSENT_TEXT, CURRENT_AUTOPAY_CONSENT_VERSION,
  buildAutopayDisclosure, requireAcceptedAutopayDisclosure, withAcceptedAutopayDisclosure } from './consentText';
import type { Tx } from './types';
describe('accepted authorization', () => {
  it('accepts the shared database-or-transaction executor', () => {
    expectTypeOf<Parameters<typeof buildAutopayDisclosure>[0]>().toEqualTypeOf<Tx>();
  });
  it('requires a named MSP and schedule in both immutable versions', () => {
    for (const text of Object.values(AUTOPAY_CONSENT_TEXT[CURRENT_AUTOPAY_CONSENT_VERSION]!)) {
      expect(text).toContain('{{msp}}');
      expect(text).toContain('{{schedule}}');
      expect(text).toContain('stop');
    }
  });
  it('refuses a missing or changed browser disclosure', async () => {
    expect(() => requireAcceptedAutopayDisclosure('a'.repeat(64))).toThrow();
    await expect(withAcceptedAutopayDisclosure('a'.repeat(64), async () =>
      requireAcceptedAutopayDisclosure('b'.repeat(64)))).rejects.toMatchObject({status:409});
  });
  it('isolates two simultaneous browsers', async () => {
    await Promise.all(['a','b'].map(letter => withAcceptedAutopayDisclosure(letter.repeat(64), async () => {
      await Promise.resolve();
      expect(() => requireAcceptedAutopayDisclosure(letter.repeat(64))).not.toThrow();
    })));
  });
});
```
Create `autopaySetupAttempts.integration.test.ts`:
```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from '../../__tests__/integration/db-utils';
describe('durable setup authorization', () => {
  it('forces RLS and refuses changing accepted terms', async () => {
    const partner = await createPartner();
    const org = await createOrganization({partnerId:partner.id});
    const enrollment = randomUUID();
    const attempt = randomUUID();
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`INSERT INTO org_autopay_enrollments
        (id,org_id,partner_id,status,generation) VALUES
        (${enrollment},${org.id},${partner.id},'requested',1)`);
      await db.execute(sql`INSERT INTO autopay_setup_attempts
        (id,org_id,partner_id,enrollment_id,generation,source,method_type,
         stripe_connection_id,stripe_account_id,consent_snapshot)
        VALUES (${attempt},${org.id},${partner.id},${enrollment},1,'setup_page','card',
          ${randomUUID()},'acct_test','{"text":"accepted original"}'::jsonb)`);
    });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE autopay_setup_attempts SET consent_snapshot='{}'::jsonb WHERE id=${attempt}
    `))).rejects.toThrow(/immutable/);
    const rows = await withDbAccessContext({scope:'organization',orgId:randomUUID(),
      currentPartnerId:partner.id, accessibleOrgIds:[]}, () => db.execute(sql`
        SELECT id FROM autopay_setup_attempts WHERE id=${attempt}`));
    expect(Array.from(rows)).toEqual([]);
    await expect(withDbAccessContext({scope:'organization',orgId:randomUUID(),accessibleOrgIds:[]},()=>db.execute(sql`
      INSERT INTO autopay_setup_attempts(org_id,partner_id,enrollment_id,generation,source,method_type,
       stripe_connection_id,stripe_account_id,consent_snapshot)
      VALUES(${org.id},${partner.id},${enrollment},1,'setup_page','card',${randomUUID()},'acct_test','{}'::jsonb)
    `))).rejects.toMatchObject({code:'42501'});
    const flags=await withSystemDbAccessContext(()=>db.execute(sql`
      SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='autopay_setup_attempts'::regclass`));
    expect(Array.from(flags)).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM autopay_setup_attempts WHERE id=${attempt}`));
  });
});
```
`DbAccessContext` in `apps/api/src/db/index.ts` is authoritative for the context fixture; use the exact existing context keys after W1 lands. The fixture must execute as the unprivileged application role; an admin connection bypassing RLS is not a passing test.

Before the first real-DB run, add these exact entries to `test.include` in `apps/api/vitest.integration.config.ts` and to `test.exclude` in `apps/api/vitest.config.ts`:
```ts
'src/db/schema/autopaySetupAttempts.integration.test.ts',
'src/services/autopay/enrollmentService.integration.test.ts',
```
These co-located suites are not discovered by the existing integration glob. The normal unit suite must never import the integration setup and truncate the test database.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/consentText.test.ts`; missing module. Run the integration command below before applying the new migration; expect `relation autopay_setup_attempts does not exist`.
- [ ] **Step 3: Implement** — create the migration:
```sql
SELECT set_config('breeze.scope','system',true);
CREATE UNIQUE INDEX IF NOT EXISTS org_autopay_enrollments_id_org_uq
  ON org_autopay_enrollments(id,org_id);
CREATE TABLE IF NOT EXISTS autopay_setup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal bigserial NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL,
  generation integer NOT NULL CHECK(generation>0),
  token_id uuid,
  source text NOT NULL CHECK(source IN ('setup_page','pay_and_save','portal')),
  method_type text NOT NULL CHECK(method_type IN ('card','us_bank_account')),
  stripe_connection_id uuid NOT NULL,
  stripe_account_id text NOT NULL,
  stripe_customer_id text,
  checkout_session_id text,
  setup_intent_id text,
  payment_intent_id text,
  consent_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome text CHECK(outcome IN ('activated','pending_verification','stale_generation','failed')),
  CONSTRAINT autopay_setup_attempts_enrollment_org_fk FOREIGN KEY(enrollment_id,org_id)
    REFERENCES org_autopay_enrollments(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT autopay_setup_attempts_org_partner_fk FOREIGN KEY(org_id,partner_id)
    REFERENCES organizations(id,partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX IF NOT EXISTS autopay_setup_attempts_checkout_uq
  ON autopay_setup_attempts(stripe_account_id,checkout_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS autopay_setup_attempts_setup_intent_uq
  ON autopay_setup_attempts(stripe_account_id,setup_intent_id);
CREATE INDEX IF NOT EXISTS autopay_setup_attempts_unfinished_idx
  ON autopay_setup_attempts(created_at) WHERE completed_at IS NULL;
ALTER TABLE autopay_setup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopay_setup_attempts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
   AND tablename='autopay_setup_attempts' AND policyname='autopay_setup_attempts_tenant') THEN
  CREATE POLICY autopay_setup_attempts_tenant ON autopay_setup_attempts
   USING (public.breeze_current_scope()='system' OR public.breeze_has_org_access(org_id))
   WITH CHECK (public.breeze_current_scope()='system' OR public.breeze_has_org_access(org_id));
 END IF;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON autopay_setup_attempts TO breeze_app;
GRANT USAGE,SELECT ON SEQUENCE autopay_setup_attempts_ordinal_seq TO breeze_app;
CREATE OR REPLACE FUNCTION autopay_setup_attempts_immutable_authority() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.ordinal,NEW.org_id,NEW.partner_id,NEW.enrollment_id,NEW.generation,NEW.token_id,
   NEW.source,NEW.method_type,NEW.stripe_connection_id,NEW.stripe_account_id,
   NEW.consent_snapshot,NEW.created_at) IS DISTINCT FROM
   ROW(OLD.ordinal,OLD.org_id,OLD.partner_id,OLD.enrollment_id,OLD.generation,OLD.token_id,
   OLD.source,OLD.method_type,OLD.stripe_connection_id,OLD.stripe_account_id,
   OLD.consent_snapshot,OLD.created_at) THEN
   RAISE EXCEPTION 'autopay setup authority is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS autopay_setup_attempts_immutable_authority ON autopay_setup_attempts;
CREATE TRIGGER autopay_setup_attempts_immutable_authority BEFORE UPDATE ON autopay_setup_attempts
 FOR EACH ROW EXECUTE FUNCTION autopay_setup_attempts_immutable_authority();
```
The invoice id is immutable provenance inside `consent_snapshot`, not a live FK: invoices move during merge while consent authority stays with the loser. Completion requires a booked mapping with the same current organization and the snapshotted invoice id before pay-and-save. `token_id` is a historical identifier, not a bearer credential and not an FK: revoked token history may be pruned independently. Stripe connection/account identifiers are frozen historical identities and survive credential replacement.

Create `autopaySetupAttempts.ts`:
```ts
import { pgTable,uuid,text,integer,bigserial,jsonb,timestamp,uniqueIndex,index,foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations,partners } from './orgs';
import { orgAutopayEnrollments } from './autopay';
export const autopaySetupAttempts=pgTable('autopay_setup_attempts',{
 id:uuid('id').primaryKey().defaultRandom(),ordinal:bigserial('ordinal',{mode:'number'}).notNull().unique(),
 orgId:uuid('org_id').notNull().references(()=>organizations.id,{onDelete:'cascade'}),
 partnerId:uuid('partner_id').notNull().references(()=>partners.id,{onDelete:'cascade'}),
 enrollmentId:uuid('enrollment_id').notNull(),generation:integer('generation').notNull(),
 tokenId:uuid('token_id'),source:text('source').notNull(),methodType:text('method_type').notNull(),
 stripeConnectionId:uuid('stripe_connection_id').notNull(),stripeAccountId:text('stripe_account_id').notNull(),
 stripeCustomerId:text('stripe_customer_id'),checkoutSessionId:text('checkout_session_id'),
 setupIntentId:text('setup_intent_id'),paymentIntentId:text('payment_intent_id'),
 consentSnapshot:jsonb('consent_snapshot').notNull(),
 createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
 completedAt:timestamp('completed_at',{withTimezone:true}),outcome:text('outcome')
},t=>[
 uniqueIndex('autopay_setup_attempts_checkout_uq').on(t.stripeAccountId,t.checkoutSessionId),
 uniqueIndex('autopay_setup_attempts_setup_intent_uq').on(t.stripeAccountId,t.setupIntentId),
 index('autopay_setup_attempts_unfinished_idx').on(t.createdAt).where(sql`${t.completedAt} IS NULL`),
 foreignKey({name:'autopay_setup_attempts_enrollment_org_fk',columns:[t.enrollmentId,t.orgId],
   foreignColumns:[orgAutopayEnrollments.id,orgAutopayEnrollments.orgId]}).onDelete('cascade'),
 foreignKey({name:'autopay_setup_attempts_org_partner_fk',columns:[t.orgId,t.partnerId],
   foreignColumns:[organizations.id,organizations.partnerId]}).onDelete('cascade')
]);
```
Add this exact barrel export:
```ts
export * from './autopaySetupAttempts';
```
Add `'autopay_setup_attempts',` to `CORE_ORG_CASCADE_DELETE_ORDER` in `tenantCascade.ts` after `'automations',` and before the first `backup_` entry (verify `localeCompare`, not shell ASCII sorting). Add to `SPECIAL` in `orgMergeRegistry.ts`:
```ts
autopay_setup_attempts: {kind:'leave-for-erasure',note:'Immutable enrollment authority stays with the loser; its generation/status fence prevents completion after merge'},
```
Add to `CORE_TENANT_EXPORT_POLICY` in `tenantExportPolicyRegistry.ts`:
```ts
"autopay_setup_attempts": tablePolicy("org_id", {
 included:["id","ordinal","org_id","partner_id","enrollment_id","generation","source","method_type",
   "stripe_connection_id","stripe_account_id","stripe_customer_id","checkout_session_id",
   "setup_intent_id","payment_intent_id","created_at","completed_at","outcome"],
 reviewedIncluded:["token_id"],excludedSensitive:[],excludedOpen:["consent_snapshot"]
}),
```
Explicit registration decisions: direct `org_id` is auto-discovered by `rls-coverage.integration.test.ts`, so no shape allowlist entry; this row is mutable and erasable, so no `AUDIT_ADMIN_REQUIRED_TABLES` entry; no ciphertext or bearer token is stored, so no `encryptedColumnRegistry` entry. W1's immutable `org_autopay_consents` and encrypted `billing_link_tokens.token_ct` registrations remain required and are checked in the contract suites.

Create `consentText.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AutopayPaymentMethodType } from '@breeze/shared';
import type { Tx } from './types';
import { organizations,partners } from '../../db/schema';
import { InvoiceServiceError } from '../invoiceTypes';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { quoteProcessingFee } from './processingFee';
export const CURRENT_AUTOPAY_CONSENT_VERSION='2026-10-01.v1';
export const AUTOPAY_CONSENT_TEXT:Record<string,{card:string;us_bank_account:string}>={
 '2026-10-01.v1':{
  card:'I authorize {{msp}} to save this card and charge future eligible invoices automatically. {{schedule}} {{fee}} I can skip an announced payment or stop automatic payments before a payment starts. Stopping does not cancel money I already owe.',
  us_bank_account:'I authorize {{msp}} to save this US bank account and initiate recurring ACH debits for future eligible invoices. {{schedule}} {{fee}} I can skip an announced payment or stop automatic payments before a debit starts. A debit already processing may still complete. Stopping does not cancel money I already owe.'
 }
};
const accepted=new AsyncLocalStorage<string>();
export function withAcceptedAutopayDisclosure<T>(hash:string,fn:()=>Promise<T>):Promise<T>{
 return accepted.run(hash,fn);
}
export function requireAcceptedAutopayDisclosure(hash:string):void{
 if(accepted.getStore()!==hash)throw new InvoiceServiceError('The terms changed. Review them and try again.',409,'INVALID_STATE');
}
export interface AutopayDisclosure {
 version:string;text:string;hash:string;textHash:string;partnerName:string;scheduleText:string;feeText:string;
 achMode:'ach_preferred'|'ach_only'|'card_only';
 scheduleTerms:{offsetDays:number;rule:'earlier'|'later';cap:{enabled:false}|{enabled:true;amount:string;currency:string}};
 feeTerms:{methodType:AutopayPaymentMethodType;cardFeeBps:number;achFeeAmount:string;feeAttested:boolean;currency:string};
}
export async function buildAutopayDisclosure(db:Tx,orgId:string,methodType:AutopayPaymentMethodType):Promise<AutopayDisclosure>{
 const [row]=await db.select({org:organizations,partner:partners}).from(organizations)
  .innerJoin(partners,eq(partners.id,organizations.partnerId)).where(eq(organizations.id,orgId)).limit(1);
 if(!row)throw new InvoiceServiceError('Organization not found',404,'ORG_NOT_FOUND');
 const settings=await resolveBillingPaymentSettings(db,{partnerId:row.partner.id,orgId});
 const ready=await getAutopayStripeReadiness(db,row.partner.id);
 const achAvailable=ready.accountCountry==='US'&&row.org.currencyCode==='USD';
 const achMode=achAvailable?settings.achMode.value:'card_only';
 const scheduleTerms={offsetDays:settings.autopayOffsetDays.value,rule:settings.autopayOffsetRule.value,cap:settings.autopayCap.value};
 const scheduleText=`Invoices are charged ${scheduleTerms.offsetDays} days after issue or on their due date, whichever is ${scheduleTerms.rule}. `+
  (scheduleTerms.cap.enabled?`Only invoices up to ${scheduleTerms.cap.currency} ${scheduleTerms.cap.amount} qualify. `:'')+
  'We email the amount and date before each payment. Required advance notice can move the payment later. Existing invoices are not included.';
 const quote=quoteProcessingFee({methodType,cardFunding:methodType==='card'?'credit':null,principal:'100.00',
  currency:row.org.currencyCode,stripeAccountCountry:ready.accountCountry,orgBillingCountry:row.org.billingAddressCountry,
  orgBillingRegion:row.org.billingAddressRegion,cardFeeBps:settings.cardFeeBps.value,achFeeAmount:settings.achFeeAmount.value,
  feeAttested:settings.feeAttested});
 const bps=quote.appliedBps??0;
 const feeText=quote.kind==='card_percent'?`A credit-card processing fee of up to ${bps/100}% applies. Debit and prepaid cards have no fee.`:
  quote.kind==='ach_flat'?`Each bank payment includes a ${row.org.currencyCode} ${quote.feeAmount} processing fee.`:'No processing fee applies.';
 const feeTerms={methodType,cardFeeBps:methodType==='card'?bps:0,achFeeAmount:methodType==='us_bank_account'?quote.feeAmount:'0.00',
  feeAttested:settings.feeAttested,currency:row.org.currencyCode};
 const version=CURRENT_AUTOPAY_CONSENT_VERSION;
 const text=AUTOPAY_CONSENT_TEXT[version]![methodType].replace('{{msp}}',row.partner.name)
  .replace('{{schedule}}',scheduleText).replace('{{fee}}',feeText);
 const hash=createHash('sha256').update(JSON.stringify({version,text,scheduleTerms,feeTerms})).digest('hex');
 const textHash=createHash('sha256').update(text).digest('hex');
 return {version,text,hash,textHash,partnerName:row.partner.name,scheduleText,feeText,achMode,scheduleTerms,feeTerms};
}
```
The division for rendering integer basis points is presentation only; `quoteProcessingFee` remains the sole money computation.

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/consentText.test.ts`; from the root run `pnpm exec tsc --build apps/api/tsconfig.tests.json` for the disclosure executor type assertion. From the repository root run:
```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/db/schema/autopaySetupAttempts.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
pnpm test-stack down
```
- [ ] **Step 5: Commit** — `git add apps/api/migrations/2026-11-20-110000-autopay-setup-attempts.sql apps/api/src/db/schema/autopaySetupAttempts.ts apps/api/src/db/schema/autopaySetupAttempts.integration.test.ts apps/api/src/db/schema/index.ts apps/api/src/services/autopay/consentText.ts apps/api/src/services/autopay/consentText.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/vitest.config.ts apps/api/vitest.integration.config.ts` then `git commit -m "feat(billing): persist accepted autopay authorization before redirect"`.

### Task 2: Own payment-method usability and safe post-commit detachment
**Files:** Create `apps/api/src/services/autopay/paymentMethods.ts`, `apps/api/src/services/autopay/paymentMethods.test.ts`. Read W1 `apps/api/src/services/autopay/types.ts`; do not modify it.
**Interfaces:** Consumes W1 `Tx` from `./types`, C2 `orgPaymentMethods`, `orgAutopayEnrollments`, existing `getPartnerStripeClient(partnerId)` and `runAfterDbContextExit(label,work)`; produces the three exact C4 payment-method functions.

- [ ] **Step 1: Write the failing test** — `paymentMethods.test.ts`:
```ts
import { beforeEach,describe,expect,expectTypeOf,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as unknown[][],detach:vi.fn(),retrieve:vi.fn(),client:vi.fn()}));
vi.mock('../../db',()=>{
 const chain:any={};
 for(const name of ['select','from','innerJoin','where','limit','for'])chain[name]=()=>chain;
 chain.then=(resolve:any)=>Promise.resolve(m.rows.shift()??[]).then(resolve);
 return {db:chain,runOutsideDbContext:(fn:any)=>fn(),withSystemDbAccessContext:(fn:any)=>fn(),hasDbAccessContext:()=>false};
});
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:m.client}));
import {getAutopayMethod,markPaymentMethodUnusable,detachPaymentMethodPostCommit} from './paymentMethods';
import type { Tx } from './types';
describe('post-commit detach',()=>{
 it('accepts database and raw transaction inputs for both C4 operations',()=>{
  expectTypeOf<Parameters<typeof getAutopayMethod>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<Parameters<typeof markPaymentMethodUnusable>[0]>().toEqualTypeOf<Tx>();
 });
 beforeEach(()=>{m.rows.length=0;vi.clearAllMocks();m.client.mockResolvedValue({stripeAccountId:'acct_one',
  stripe:{paymentMethods:{retrieve:m.retrieve,detach:m.detach}}});});
 it('does nothing if rollback left the method active',async()=>{
  m.rows.push([]);await detachPaymentMethodPostCommit('p','m');expect(m.client).not.toHaveBeenCalled();
 });
 it('refuses to use a replacement Stripe account',async()=>{
  m.rows.push([{method:{stripePaymentMethodId:'pm_one'},enrollment:{stripeAccountId:'acct_old'}}]);
  await expect(detachPaymentMethodPostCommit('p','m')).rejects.toThrow(/account/);
  expect(m.detach).not.toHaveBeenCalled();
 });
 it('detaches a committed removed method and tolerates an already detached method',async()=>{
  for(const customer of ['cus_one',null]){
   m.rows.push([{method:{stripePaymentMethodId:'pm_one'},enrollment:{stripeAccountId:'acct_one'}}]);
   m.retrieve.mockResolvedValueOnce({id:'pm_one',customer});await detachPaymentMethodPostCommit('p','m');
  }
  expect(m.detach).toHaveBeenCalledTimes(1);
 });
});
```
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/paymentMethods.test.ts`; missing module; once present, the test-project type gate rejects a narrowed executor: `pnpm exec tsc --build apps/api/tsconfig.tests.json` from the repository root.
- [ ] **Step 3: Implement** — `paymentMethods.ts`:
```ts
import { and,eq,inArray } from 'drizzle-orm';
import { db as database,runOutsideDbContext,withSystemDbAccessContext } from '../../db';
import { orgPaymentMethods,orgAutopayEnrollments } from '../../db/schema';
import { getPartnerStripeClient } from '../partnerStripe';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import type { Tx } from './types';
export async function getAutopayMethod(db:Tx,orgId:string):Promise<typeof orgPaymentMethods.$inferSelect|null>{
 const [method]=await db.select().from(orgPaymentMethods).where(and(eq(orgPaymentMethods.orgId,orgId),
  eq(orgPaymentMethods.isAutopayMethod,true),inArray(orgPaymentMethods.status,['active','pending_verification']))).limit(1);
 return method??null;
}
export async function markPaymentMethodUnusable(tx:Tx,methodId:string,reason:string):Promise<void>{
 const [method]=await tx.select().from(orgPaymentMethods).where(eq(orgPaymentMethods.id,methodId)).limit(1);
 if(!method||method.status==='removed')return;
 const [enrollment]=await tx.select().from(orgAutopayEnrollments)
  .where(eq(orgAutopayEnrollments.id,method.enrollmentId)).limit(1).for('update');
 if(!enrollment)return;
 const [changed]=await tx.update(orgPaymentMethods).set({status:'unusable',unusableReason:reason})
  .where(and(eq(orgPaymentMethods.id,methodId),inArray(orgPaymentMethods.status,['active','pending_verification']))).returning();
 if(changed?.isAutopayMethod)await tx.update(orgAutopayEnrollments).set({needsAttentionReason:'method_unusable'})
  .where(and(eq(orgAutopayEnrollments.id,enrollment.id),inArray(orgAutopayEnrollments.status,['active','paused'])));
}
export async function detachPaymentMethodPostCommit(partnerId:string,methodId:string):Promise<void>{
 assertNoHeldDbContextForStripe('detachPaymentMethodPostCommit');
 const [row]=await withSystemDbAccessContext(()=>database.select({method:orgPaymentMethods,enrollment:orgAutopayEnrollments})
  .from(orgPaymentMethods).innerJoin(orgAutopayEnrollments,eq(orgAutopayEnrollments.id,orgPaymentMethods.enrollmentId))
  .where(and(eq(orgPaymentMethods.id,methodId),eq(orgPaymentMethods.status,'removed'),eq(orgAutopayEnrollments.partnerId,partnerId))).limit(1));
 if(!row)return;
 const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(partnerId));
 if(stripeAccountId!==row.enrollment.stripeAccountId)throw new Error('Stripe account changed; detachment requires its original account');
 try{
  const method=await runOutsideDbContext(()=>stripe.paymentMethods.retrieve(row.method.stripePaymentMethodId));
  if(method.customer)await runOutsideDbContext(()=>stripe.paymentMethods.detach(method.id));
 }catch(error){if((error as {code?:string}).code!=='resource_missing')throw error;}
}
```
`runAfterDbContextExit` runs even after rollback (`apps/api/src/db/index.ts`), therefore the committed-status read is mandatory. The reconciliation pass in Task 9 retries removed methods; a failed detach never restores local authority. Account replacement cannot detach a same-named method on a different account.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/paymentMethods.test.ts`; from the repository root run `pnpm exec tsc --build apps/api/tsconfig.tests.json` to evaluate the `expectTypeOf` contract assertions.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/paymentMethods.ts apps/api/src/services/autopay/paymentMethods.test.ts` then `git commit -m "feat(billing): fence unusable methods and detach after commit"`.

### Task 3: Enrollment email catalog, protected disclosures, and staff notifications (W2a)

**Files:** Modify `packages/shared/src/utils/emailTemplates.ts`, `packages/shared/src/constants/notificationTypes.ts`, `apps/api/src/services/emailTemplates/defaults.ts`, `apps/api/src/services/autopay/renderBillingNotice.ts`, `apps/api/src/services/emailDomains/mailPurposes.ts`; Create `apps/api/src/services/autopay/enrollmentNotices.ts`, `apps/api/src/services/autopay/staffNotifications.ts`, `apps/api/migrations/2026-11-20-110100-autopay-billing-notification-type.sql`; Test `apps/api/src/services/autopay/enrollmentNotices.test.ts`, `apps/api/src/services/autopay/staffNotifications.test.ts`, `apps/api/src/services/emailDomains/mailPurposes.test.ts`, `apps/api/src/routes/orgs.test.ts`.

**Interfaces:** Consumes `renderPartnerEmail(args: RenderPartnerEmailArgs): {subject:string;html:string}` and `partnerEmailCustomFromSettings(settings:unknown,id:EmailTemplateId)` from `services/emailTemplates/renderPartnerEmail.ts`; C4 `RenderedNotice`, `renderBillingNotice(kind,ctx)`; Produces `AutopayNoticeContext`, `renderAutopayNotice`, `notifyAutopayStaff` below. This is an additive W2 variant of the W1 `BillingNoticeContext` union, not a replacement of its other variants. Enrollment transition callers enqueue the returned customer notice inside their transaction, and invoke staff delivery after commit. `orgs.ts` already validates `emailTemplates` with `z.partialRecord(z.enum(EMAIL_TEMPLATE_IDS), emailTemplateOverrideSchema)`; changing that schema to a second copied ID list would regress the single source of truth.

- [ ] **Step 1: Write the failing test** — create `enrollmentNotices.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { EMAIL_TEMPLATE_IDS, varsForEmailTemplate, emailTemplateFieldDefaults } from '@breeze/shared';
const h = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../../db', () => ({ db: { select: () => ({ from: () => ({
  where: () => ({ limit: async () => h.rows.shift() ?? [] }),
}) }) } }));
import { renderAutopayNotice } from './enrollmentNotices';
const ctx = {
  orgId: '11111111-1111-4111-8111-111111111111',
  partnerId: '22222222-2222-4222-8222-222222222222',
  vars: { client_name: 'Accounts team', partner_name: 'Example MSP', org_name: 'Example client',
    setup_link: 'https://portal.example.test/autopay/token', ach_mode_text: 'Bank account or card' },
  ctaUrl: 'https://portal.example.test/autopay/token',
  scheduleText: 'Invoices are charged 5 days after issue or on the due date, whichever is later.',
  feeText: 'No processing fee applies.', stopUrl: 'https://portal.example.test/autopay/stop-token/stop',
};
describe('enrollment notices', () => {
  it.each([
    ['autopay_request', ['client_name', 'setup_link', 'ach_mode_text']],
    ['autopay_enrolled', ['client_name', 'payment_method', 'schedule_text', 'fee_text']],
    ['autopay_stopped', ['client_name', 'stopped_by', 'open_invoices_text']],
    ['card_expiring', ['client_name', 'payment_method', 'expires_on', 'update_link']],
  ] as const)('registers the closed %s catalog', (id, keys) => {
    expect(EMAIL_TEMPLATE_IDS).toContain(id);
    expect(varsForEmailTemplate(id)).toEqual(['partner_name', 'org_name', ...(id === 'autopay_request' || id === 'card_expiring' ? ['cta_button'] : []), ...keys]);
    expect(emailTemplateFieldDefaults(id).html).not.toBe('');
  });
  it('keeps schedule, stop and fee disclosures outside a custom body', async () => {
    h.rows.push([{ settings: { emailTemplates: { autopay_request: { html: '<p>Hello only</p>' } } } }]);
    const out = await renderAutopayNotice('autopay_request', ctx);
    expect(out.html).toContain('Hello only');
    expect(out.html).toContain(ctx.scheduleText);
    expect(out.html).toContain(ctx.feeText);
    expect(out.html).toContain(ctx.stopUrl);
    expect(out.text).toContain(ctx.scheduleText);
    expect(out.text).toContain(ctx.stopUrl);
    expect(out.frozen).toMatchObject({ scheduleText: ctx.scheduleText, feeText: ctx.feeText });
  });
  it('escapes client-controlled text even in immutable blocks', async () => {
    h.rows.push([{ settings: {} }]);
    const out = await renderAutopayNotice('autopay_request', { ...ctx,
      scheduleText: '<img src=x onerror=alert(1)>', stopUrl: 'javascript:alert(1)' });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).not.toContain('href="javascript:');
    expect(out.html).toContain('&lt;img');
  });
});
```

Create `staffNotifications.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], inserts: vi.fn(), send: vi.fn() }));
vi.mock('../../db', () => ({
  runOutsideDbContext: (f: () => unknown) => f(),
  withSystemDbAccessContext: (f: () => unknown) => f(),
  db: {
    select: () => { const q: any = {}; for (const k of ['from','innerJoin','where','limit']) q[k] = () => q;
      q.then = (f: (x: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(f); return q; },
    insert: () => ({ values: (v: unknown) => { h.inserts(v); return { onConflictDoNothing: async () => [] }; } }),
  },
}));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: h.send }) }));
import { notifyAutopayStaff } from './staffNotifications';
describe('autopay staff notifications', () => {
  beforeEach(() => { vi.clearAllMocks(); h.rows.length = 0; h.send.mockResolvedValue({}); });
  it('uses billing type and stable event payload, sends only to partner billing address', async () => {
    h.rows.push([{ userId: '11111111-1111-4111-8111-111111111111' }], [{ userId: '11111111-1111-4111-8111-111111111111' }, { userId: '22222222-2222-4222-8222-222222222222' }],
      [{ billingEmail: 'billing@example.test' }]);
    await notifyAutopayStaff({ orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444', event: 'autopay.enrolled',
      dedupeKey: 'enrollment:1:activated', message: 'Example client enabled automatic payments.' });
    expect(h.inserts).toHaveBeenCalledWith([
      expect.objectContaining({ userId: '11111111-1111-4111-8111-111111111111', type: 'billing', metadata: { event: 'autopay.enrolled' } }),
      expect.objectContaining({ userId: '22222222-2222-4222-8222-222222222222', type: 'billing', metadata: { event: 'autopay.enrolled' } }),
    ]);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'billing@example.test', purpose: 'staff.autopay' }));
  });
  it('does not fall back to the customer contact when the MSP billing address is blank', async () => {
    h.rows.push([], [], [{ billingEmail: null }]);
    await notifyAutopayStaff({ orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444', event: 'autopay.stopped',
      dedupeKey: 'enrollment:1:stopped', message: 'Automatic payments stopped.' });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('reports staff delivery failure to its post-commit caller', async () => {
    h.rows.push([], [], [{ billingEmail: 'billing@example.test' }]);
    h.send.mockRejectedValue(new Error('provider unavailable'));
    await expect(notifyAutopayStaff({ orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444',
      event: 'autopay.needs_attention', dedupeKey: 'method:1:unusable', message: 'Update method.' }))
      .rejects.toThrow('provider unavailable');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/enrollmentNotices.test.ts src/services/autopay/staffNotifications.test.ts`; missing imports and absent template IDs fail.
- [ ] **Step 3: Implement** — in `emailTemplates.ts`, append these four literals to `EMAIL_TEMPLATE_IDS`:

```ts
'autopay_request',
'autopay_enrolled',
'autopay_stopped',
'card_expiring',
```

Append these members to `EmailTemplateVarKey`:

```ts
| 'client_name' | 'setup_link' | 'ach_mode_text' | 'payment_method'
| 'schedule_text' | 'fee_text' | 'stopped_by' | 'open_invoices_text'
| 'expires_on' | 'update_link'
```

Add the following complete entries to `VARS_BY_ID`, `LABEL_BY_ID`, `HAS_CTA_BY_ID`, and `FIELD_DEFAULTS_BY_ID`, respectively:

```ts
// VARS_BY_ID
  autopay_request: ['partner_name','org_name','cta_button','client_name','setup_link','ach_mode_text'],
  autopay_enrolled: ['partner_name','org_name','client_name','payment_method','schedule_text','fee_text'],
  autopay_stopped: ['partner_name','org_name','client_name','stopped_by','open_invoices_text'],
  card_expiring: ['partner_name','org_name','cta_button','client_name','payment_method','expires_on','update_link'],
// LABEL_BY_ID
  autopay_request: 'Automatic payments request',
  autopay_enrolled: 'Automatic payments confirmed',
  autopay_stopped: 'Automatic payments stopped',
  card_expiring: 'Saved card expiring',
// HAS_CTA_BY_ID
  autopay_request: true,
  autopay_enrolled: false,
  autopay_stopped: false,
  card_expiring: true,
// FIELD_DEFAULTS_BY_ID
  autopay_request: {
    subject: 'Set up automatic payments with {{partner_name}}',
    heading: 'One less thing to remember', buttonLabel: 'Set up automatic payments',
    html: `<p>Hi {{client_name}},</p>
<p>{{partner_name}} invites you to set up automatic payments for future invoices. Save a payment method securely with Stripe, and we will send you an invoice before each payment.</p>
<p>{{ach_mode_text}}</p><p>{{cta_button}}</p>
<p>The schedule is shown below. You can stop automatic payments at any time. Existing open invoices still need to be paid separately.</p>`,
  },
  autopay_enrolled: {
    subject: 'Automatic payments are set up with {{partner_name}}',
    heading: 'Your payment method is saved', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p><p>Thank you for setting up automatic payments with {{partner_name}}.</p>
<p>Payment method: {{payment_method}}.</p><p>{{schedule_text}}</p><p>{{fee_text}}</p>
<p>We will send you an invoice before each payment. You can stop automatic payments at any time using the link below.</p>`,
  },
  autopay_stopped: {
    subject: 'Automatic payments stopped with {{partner_name}}',
    heading: 'Automatic payments have stopped', buttonLabel: '',
    html: `<p>Hi {{client_name}},</p><p>{{stopped_by}} stopped automatic payments with {{partner_name}}.</p>
<p>We will not start any new automatic payments. A payment already processing may still complete.</p>
<p>{{open_invoices_text}}</p><p>Please use the invoice payment links below for any amount still due.</p>`,
  },
  card_expiring: {
    subject: 'Please update your saved card for {{partner_name}}',
    heading: 'Your saved card expires soon', buttonLabel: 'Update payment method',
    html: `<p>Hi {{client_name}},</p><p>Your {{payment_method}} expires on {{expires_on}}.</p>
<p>Please update your payment method to keep future automatic payments running.</p><p>{{cta_button}}</p>
<p>Updating your method keeps your existing automatic-payment enrollment.</p>`,
  },
```

`autopay_request` deliberately does not introduce a `schedule_text` merge key: C6's closed list excludes it. The immutable append supplies the required schedule even when the MSP edits the body. In `defaults.ts`, add all four IDs to `PREHEADER_BY_ID` and `FOOTER_BY_ID`:

```ts
// PREHEADER_BY_ID
  autopay_request: 'Set up payments for future invoices.',
  autopay_enrolled: 'Your automatic payment details.',
  autopay_stopped: 'Future automatic payments have stopped.',
  card_expiring: 'Update your saved payment method.',
// FOOTER_BY_ID
  autopay_request: undefined,
  autopay_enrolled: undefined,
  autopay_stopped: undefined,
  card_expiring: undefined,
```

Create `enrollmentNotices.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { partners } from '../../db/schema';
import { escapeHtml } from '../emailLayout';
import { htmlToText } from '../inboundEmail/htmlToText';
import { partnerEmailCustomFromSettings, renderPartnerEmail } from '../emailTemplates/renderPartnerEmail';
import type { RenderedNotice } from './noticeOutbox';
export type EnrollmentNoticeKind = 'autopay_request' | 'autopay_enrolled' | 'autopay_stopped' | 'card_expiring';
export interface AutopayNoticeContext {
  partnerId: string; orgId: string; vars: Record<string,string>; ctaUrl?: string;
  scheduleText: string; feeText: string; stopUrl?: string; authorizationReference?: string;
  openInvoices?: { number: string; amount: string; currency: string; url: string }[];
}
const safeUrl = (value: string | undefined): string | null => {
  if (!value) return null;
  try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? value : null; }
  catch { return null; }
};
export async function renderAutopayNotice(kind: EnrollmentNoticeKind, ctx: AutopayNoticeContext): Promise<RenderedNotice> {
  const [partner] = await db.select({ settings: partners.settings }).from(partners)
    .where(eq(partners.id, ctx.partnerId)).limit(1);
  if (!partner) throw new Error('Partner not found while rendering billing notice');
  const blocks = [ctx.scheduleText, ctx.feeText, ctx.authorizationReference].filter((x): x is string => !!x);
  let append = blocks.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
  const textBlocks = [...blocks];
  const stop = safeUrl(ctx.stopUrl);
  if (stop) { append += `<p><a href="${escapeHtml(stop)}">Stop automatic payments</a></p>`;
    textBlocks.push(`Stop automatic payments: ${stop}`); }
  for (const invoice of ctx.openInvoices ?? []) {
    const url = safeUrl(invoice.url); if (!url) continue;
    const label = `${invoice.number}: ${invoice.amount} ${invoice.currency}`;
    append += `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`;
    textBlocks.push(`${label}: ${url}`);
  }
  const rendered = renderPartnerEmail({ id: kind,
    custom: partnerEmailCustomFromSettings(partner.settings, kind), vars: ctx.vars,
    ctaUrl: ctx.ctaUrl, brandName: ctx.vars.partner_name, bodyAfterCta: append });
  const text = [htmlToText(rendered.html), ctx.ctaUrl, ...textBlocks].filter(Boolean).join('\n\n');
  return { ...rendered, text, frozen: { scheduleText: ctx.scheduleText, feeText: ctx.feeText,
    authorizationReference: ctx.authorizationReference ?? null } };
}
```

In W1 `renderBillingNotice.ts`, preserve the registered W1 renderer shape and add the following complete W2 dispatch integration. If W1's implementation has landed with different private fields, reconcile it before W2a starts; the exported C4 function signature remains `renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext): Promise<RenderedNotice>`.

```ts
import type {BillingNoticeKind} from '@breeze/shared';
import {escapeHtml} from '../emailLayout';
import {renderPartnerEmail,type RenderPartnerEmailArgs} from '../emailTemplates/renderPartnerEmail';
import type {RenderedNotice} from './noticeOutbox';
import {renderAutopayNotice,type AutopayNoticeContext} from './enrollmentNotices';
interface RegisteredBillingNoticeContext {
  partnerId:string;orgId:string;data:Record<string,unknown>;
  frozen:Record<string,string|number|null>;
  mandatory:{skipUrl?:string;stopUrl?:string;feeDisclosure?:string;achAuthorizationReference?:string};
}
export type BillingNoticeContext=RegisteredBillingNoticeContext|{autopay:AutopayNoticeContext};
export type BillingNoticeRenderer=(ctx:RegisteredBillingNoticeContext)=>Promise<{
  email:Omit<RenderPartnerEmailArgs,'bodyBeforeCta'|'bodyAfterCta'>;text:string;
}>;
const renderers=new Map<BillingNoticeKind,BillingNoticeRenderer>();
export function registerBillingNoticeRenderer(kind:BillingNoticeKind,renderer:BillingNoticeRenderer):void{
  if(renderers.has(kind))throw new Error(`Billing renderer already registered: ${kind}`);
  renderers.set(kind,renderer);
}
const enrollmentRenderers:Partial<Record<BillingNoticeKind,(ctx:AutopayNoticeContext)=>Promise<RenderedNotice>>>={
  autopay_request:ctx=>renderAutopayNotice('autopay_request',ctx),
  autopay_enrolled:ctx=>renderAutopayNotice('autopay_enrolled',ctx),
  autopay_stopped:ctx=>renderAutopayNotice('autopay_stopped',ctx),
  card_expiring:ctx=>renderAutopayNotice('card_expiring',ctx),
};
function checkedUrl(value:string):string{
  const parsed=new URL(value);
  if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('Unsafe billing URL');
  return value;
}
export async function renderBillingNotice(kind:BillingNoticeKind,ctx:BillingNoticeContext):Promise<RenderedNotice>{
  if('autopay'in ctx){
    const render=enrollmentRenderers[kind];
    if(!render)throw new Error(`Wrong enrollment notice context for ${kind}`);
    return render(ctx.autopay);
  }
  const renderer=renderers.get(kind);
  if(!renderer)throw new Error(`No billing renderer: ${kind}`);
  const rendered=await renderer(ctx),html:string[]=[],text:string[]=[];
  for(const value of [ctx.mandatory.feeDisclosure,ctx.mandatory.achAuthorizationReference]){
    if(value){html.push(`<p>${escapeHtml(value)}</p>`);text.push(value);}
  }
  for(const [label,raw]of [['Skip this invoice',ctx.mandatory.skipUrl],['Stop automatic payments',ctx.mandatory.stopUrl]]){
    if(!raw)continue;const url=checkedUrl(raw);
    html.push(`<p><a href="${escapeHtml(url)}">${escapeHtml(label!)}</a></p>`);text.push(`${label}: ${url}`);
  }
  const email=renderPartnerEmail({...rendered.email,bodyBeforeCta:undefined,bodyAfterCta:html.join('')});
  return {...email,text:[rendered.text,...text].filter(Boolean).join('\n\n'),frozen:{...ctx.frozen}};
}
```

Append `'billing'` to `NOTIFICATION_TYPES`; add `'staff.autopay': { lane: 'platform' }` to `MAIL_PURPOSES`. Add that same entry to the expected closed registry in `mailPurposes.test.ts`. The staff-mail path is intentionally distinct from the customer billing outbox: C9 forbids another billing-notice kind and `contractRenewal.ts#dispatchNotice` is direct platform staff mail. Staff failures propagate to the caller for logging/reporting after commit; do not roll back a successful enrollment to hide an email error. This direct staff-mail path has the same delivery limitation as contractRenewal: the customer outbox is durable, while staff mail is best-effort. Do not describe staff email as exactly-once.

Full enum migration (no new table, column, RLS policy, export or cascade registration):

```sql
SELECT set_config('breeze.scope', 'system', true);
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'billing';
```

Create `staffNotifications.ts`:

```ts
import { and, eq, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizationUsers, partnerUsers, users, partners, userNotifications } from '../../db/schema';
import { getEmailService } from '../email';
import { escapeHtml } from '../emailLayout';
export interface AutopayStaffNotice {
  orgId: string; partnerId: string;
  event: 'autopay.enrolled' | 'autopay.stopped' | 'autopay.needs_attention';
  dedupeKey: string; message: string;
}
export async function notifyAutopayStaff(input: AutopayStaffNotice): Promise<void> {
  const email = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const local = await db.select({ userId: organizationUsers.userId }).from(organizationUsers)
      .innerJoin(users, eq(users.id, organizationUsers.userId))
      .where(and(eq(organizationUsers.orgId,input.orgId),eq(users.status,'active')));
    const partnerStaff = await db.select({ userId: partnerUsers.userId }).from(partnerUsers)
      .innerJoin(users,eq(users.id,partnerUsers.userId))
      .where(and(eq(partnerUsers.partnerId,input.partnerId),eq(users.status,'active'),or(
        eq(partnerUsers.orgAccess,'all'),
        and(eq(partnerUsers.orgAccess,'selected'),sql`${input.orgId} = ANY(${partnerUsers.orgIds})`))));
    const ids = [...new Set([...local,...partnerStaff].map((row) => row.userId))];
    if (ids.length) await db.insert(userNotifications).values(ids.map((userId) => ({
      userId, orgId: input.orgId, type: 'billing' as const,
      priority: input.event === 'autopay.needs_attention' ? 'high' as const : 'normal' as const,
      title: input.event === 'autopay.enrolled' ? 'Automatic payments enabled'
        : input.event === 'autopay.stopped' ? 'Automatic payments stopped' : 'Automatic payments need attention',
      message: input.message, link: '/billing/autopay', metadata: { event: input.event },
      dedupeKey: `${input.dedupeKey}:${userId}`, read: false,
    }))).onConflictDoNothing();
    const [partner] = await db.select({ billingEmail: partners.billingEmail }).from(partners)
      .where(eq(partners.id,input.partnerId)).limit(1);
    return partner?.billingEmail;
  }));
  if (!email) return;
  const service = getEmailService();
  if (!service) throw new Error('Staff email transport is unavailable');
  await runOutsideDbContext(() => service.sendEmail({ to: email, purpose: 'staff.autopay',
    subject: 'Automatic payments update', html: `<p>${escapeHtml(input.message)}</p>`, text: input.message }));
}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/enrollmentNotices.test.ts src/services/autopay/staffNotifications.test.ts src/services/emailTemplates src/services/emailDomains/mailPurposes.test.ts src/services/emailDomains/mailPurposes.callSites.test.ts src/routes/orgs.test.ts`; then `pnpm db:check-drift` from the root against the isolated test stack. Existing partner-template PUT tests must submit each new ID and reject an unknown ID; the route schema already consumes the catalog, so no duplicate validation implementation is needed.
- [ ] **Step 5: Commit** — `git add packages/shared/src/utils/emailTemplates.ts packages/shared/src/constants/notificationTypes.ts apps/api/src/services/emailTemplates/defaults.ts apps/api/src/services/autopay/renderBillingNotice.ts apps/api/src/services/autopay/enrollmentNotices.ts apps/api/src/services/autopay/enrollmentNotices.test.ts apps/api/src/services/autopay/staffNotifications.ts apps/api/src/services/autopay/staffNotifications.test.ts apps/api/src/services/emailDomains/mailPurposes.ts apps/api/src/services/emailDomains/mailPurposes.test.ts apps/api/src/routes/orgs.test.ts apps/api/migrations/2026-11-20-110100-autopay-billing-notification-type.sql` then `git commit -m "feat(billing): add autopay enrollment notices"`.

### Task 4: Compose the enrollment templates into the existing editor (W2a)

**Files:** Modify `apps/web/src/lib/i18n/translationCoverage.test.ts`, `apps/web/src/components/settings/EmailTemplatesTab.tsx`, `apps/web/src/components/settings/EmailTemplateEditor.tsx`, `apps/web/src/components/settings/EmailTemplatesTab.test.tsx`, `packages/shared/src/utils/emailTemplates.test.ts`, `apps/web/src/locales/en/settings.json`, `apps/web/src/locales/de-DE/settings.json`, `apps/web/src/locales/es-419/settings.json`, `apps/web/src/locales/fr-CA/settings.json`, `apps/web/src/locales/fr-FR/settings.json`, `apps/web/src/locales/it-IT/settings.json`, `apps/web/src/locales/pt-BR/settings.json`, `apps/web/src/locales/tr-TR/settings.json`.

**Interfaces:** Consumes Task 3 `EMAIL_TEMPLATE_IDS`, `emailTemplateLabel`, `emailTemplateFieldDefaults`, and the existing `EmailTemplateEditor({templateId,value,onBack,onSaved})` composition. Produces a **Billing & payments** group in `EmailTemplatesTab`, with one editor-launch button per new template. It stays in W2a because adding a customer email without its existing editing surface would leave that PR incomplete.

- [ ] **Step 1: Write the failing test** — in `EmailTemplatesTab.test.tsx`, add `within` to the existing testing-library import and add this test using the verified `routeFetch()` helper:

```tsx
it('mounts all four enrollment templates under Billing & payments and opens their existing editor',async()=>{
  routeFetch();render(<EmailTemplatesTab/>);
  const group=await screen.findByTestId('autopay-email-template-group');
  expect(group.textContent).toContain('Billing & payments');
  for(const id of ['autopay_request','autopay_enrolled','autopay_stopped','card_expiring']){
    expect(within(group).getByTestId(`autopay-email-template-${id}`)).toBeTruthy();
  }
  fireEvent.click(within(group).getByTestId('autopay-email-template-autopay_request'));
  expect(await screen.findByTestId('email-template-editor')).toBeTruthy();
});
```

In both `EmailTemplatesTab.test.tsx` and `packages/shared/src/utils/emailTemplates.test.ts`, replace the existing exact expected `EMAIL_TEMPLATE_IDS` array with this full expected array:

```ts
[
  'ticket_comment_notification','ticket_autoresponse','ticket_resolved',
  'quote_send','invoice_send','portal_invite',
  'autopay_request','autopay_enrolled','autopay_stopped','card_expiring',
]
```

In the existing editor test's loop over `EMAIL_TEMPLATE_IDS`, use this selector to preserve old test IDs while giving all newly added interactive elements the required prefix:

```ts
const newIds=new Set(['autopay_request','autopay_enrolled','autopay_stopped','card_expiring']);
const row=screen.getByTestId(newIds.has(id)?`autopay-email-template-${id}`:`email-template-row-${id}`);
expect(row.textContent).toContain(emailTemplateLabel(id));
```

Append this assertion in `apps/web/src/lib/i18n/translationCoverage.test.ts` before changing locale files. It uses the existing `readLocale` and `namespaceDuplicateRegressions` helpers:

```ts
it('enrollment template fallbacks are finite existing keys', () => {
  const english = readLocale('en');
  for (const key of AUTOPAY_ENROLLMENT_TEMPLATE_FALLBACKS) expect(english.has(key), key).toBe(true);
  const unrelated = new Map([['settings.json:unrelated.newCopy', 'English']]);
  expect(namespaceDuplicateRegressions(unrelated, unrelated, { 'settings.json': 0 })).toHaveLength(1);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/web && npx vitest run src/components/settings/EmailTemplatesTab.test.tsx`; the group and new editor-launch buttons do not exist yet. `cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts` fails the four-ID expectation before Task 3's catalog change.
- [ ] **Step 3: Implement** — add these module constants to `EmailTemplatesTab.tsx` after `TemplatesMap`:

```ts
const AUTOPAY_TEMPLATE_IDS=new Set<EmailTemplateId>(['autopay_request','autopay_enrolled','autopay_stopped','card_expiring']);
const BILLING_TEMPLATE_IDS=new Set<EmailTemplateId>(['quote_send','invoice_send',...AUTOPAY_TEMPLATE_IDS]);
```

Replace the existing `<ul data-testid="email-templates-list">` block with this full composition:

```tsx
<div className="space-y-4" data-testid="email-templates-list">
  {[
    {billing:false,ids:EMAIL_TEMPLATE_IDS.filter(id=>!BILLING_TEMPLATE_IDS.has(id))},
    {billing:true,ids:EMAIL_TEMPLATE_IDS.filter(id=>BILLING_TEMPLATE_IDS.has(id))},
  ].map(group=>(
    <section key={String(group.billing)} data-testid={group.billing?'autopay-email-template-group':'email-template-other-group'}>
      <h3 className="mb-2 text-sm font-semibold">
        {group.billing?t('emailTemplates.billingPayments'):t('emailTemplates.supportPortal')}
      </h3>
      <ul className="divide-y rounded-lg border">
        {group.ids.map(id=>(
          <li key={id}>
            <button type="button" onClick={()=>setSelectedId(id)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/40"
              data-testid={AUTOPAY_TEMPLATE_IDS.has(id)?`autopay-email-template-${id}`:`email-template-row-${id}`}>
              <span className="text-sm font-medium">
                {AUTOPAY_TEMPLATE_IDS.has(id)?t(/* i18n-dynamic */ `emailTemplates.labels.${id}`):emailTemplateLabel(id)}
              </span>
              <span className="text-xs text-muted-foreground" data-testid={`email-template-status-${id}`}>
                {isCustom(templates[id])?t('emailTemplates.custom'):t('emailTemplates.usingDefault')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  ))}
</div>
```

Add these values to `SAMPLE_VARS` in `EmailTemplateEditor.tsx`; no new save handler is needed, because the existing editor already uses `runAction`:

```ts
client_name:'Example client',
setup_link:'https://portal.example.test/autopay/example-token',
ach_mode_text:'Bank account (recommended) or card',
payment_method:'Visa debit ••1234',
schedule_text:'Invoices are charged on the due date or 5 days after issue, whichever is later.',
fee_text:'No processing fee applies.',
stopped_by:'Your accounts team',
open_invoices_text:'One invoice remains open.',
expires_on:'2026-10-31',
update_link:'https://portal.example.test/autopay/update-token',
```

Merge this exact JSON into the existing `emailTemplates` object in each of the eight listed `settings.json` locale files. Existing translated keys remain; these newly added keys receive English fallback values:

```json
{
  "billingPayments": "Billing & payments",
  "supportPortal": "Support & portal",
  "labels": {
    "autopay_request": "Automatic payments request",
    "autopay_enrolled": "Automatic payments confirmed",
    "autopay_stopped": "Automatic payments stopped",
    "card_expiring": "Saved card expiring"
  },
  "variables": {
    "client_name": "Client name",
    "setup_link": "Automatic payments setup link",
    "ach_mode_text": "Available payment methods",
    "payment_method": "Saved payment method",
    "schedule_text": "Payment schedule",
    "fee_text": "Processing fee terms",
    "stopped_by": "Who stopped automatic payments",
    "open_invoices_text": "Open invoice summary",
    "expires_on": "Card expiry date",
    "update_link": "Payment method update link"
  }
}
```

In `translationCoverage.test.ts`, add this exact exception set above `namespaceDuplicateRegressions` and make `if (AUTOPAY_ENROLLMENT_TEMPLATE_FALLBACKS.has(key)) continue;` its first statement inside `for (const [key, value] of english)`. Preserve all existing budgets and unrelated-key checks. W2b adds its separate UI key set later.

```ts
const AUTOPAY_ENROLLMENT_TEMPLATE_FALLBACKS = new Set([
  'settings.json:emailTemplates.billingPayments', 'settings.json:emailTemplates.supportPortal',
  ...['autopay_request','autopay_enrolled','autopay_stopped','card_expiring']
    .map(id => `settings.json:emailTemplates.labels.${id}`),
  ...['client_name','setup_link','ach_mode_text','payment_method','schedule_text','fee_text','stopped_by',
    'open_invoices_text','expires_on','update_link'].map(key => `settings.json:emailTemplates.variables.${key}`),
]);
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/web && npx vitest run src/components/settings/EmailTemplatesTab.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/i18n/translationCoverage.test.ts`, then `cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts`. The CTA catalog contract still passes: `cta_button` is offered only on templates whose CTA flag is true; enrolled/stopped do not gain a dead CTA variable.
- [ ] **Step 5: Commit** — `git add apps/web/src/lib/i18n/translationCoverage.test.ts apps/web/src/components/settings/EmailTemplatesTab.tsx apps/web/src/components/settings/EmailTemplateEditor.tsx apps/web/src/components/settings/EmailTemplatesTab.test.tsx packages/shared/src/utils/emailTemplates.test.ts apps/web/src/locales/en/settings.json apps/web/src/locales/de-DE/settings.json apps/web/src/locales/es-419/settings.json apps/web/src/locales/fr-CA/settings.json apps/web/src/locales/fr-FR/settings.json apps/web/src/locales/it-IT/settings.json apps/web/src/locales/pt-BR/settings.json apps/web/src/locales/tr-TR/settings.json` then `git commit -m "feat(billing): expose autopay email templates in the editor"`.

### Task 5: Request, pause, resume and stop enrollment under the organization lock
**Files:** Create `apps/api/src/services/autopay/enrollmentLifecycle.ts`, `apps/api/src/services/autopay/enrollmentLifecycle.test.ts`, `apps/api/src/services/autopay/enrollmentService.ts`. Read W1 `apps/api/src/services/autopay/types.ts`; do not modify it.
**Interfaces:** Consumes W1 `Tx` from `./types` and exact C4 `mintBillingLinkToken`, `revokeBillingLinkTokens`, `enqueueBillingNotice`, `getAutopayStripeReadiness`, `isAutopayEnabledForPartner`, `getAutopayMethod`; existing `InvoiceActor` and `requireOrgAccess`. Produces C4 `requestAutopay`, `pauseAutopay`, `resumeAutopay`, `turnOffAutopay`, `stopAutopayByClient`. All executor-taking functions and their lock/notice/stop helpers accept the shared database-or-transaction union without casts. The caller owns the transaction and must provide partner/system visibility; Task 10 supplies short system contexts for staff mutations, Task 11 for verified client stop. The notice context and staff notification adapter are defined in Task 3 and land in the same W2a PR.

- [ ] **Step 1: Write the failing test** — `enrollmentLifecycle.test.ts`:
```ts
import {describe,expect,expectTypeOf,it} from 'vitest';
import type { Tx } from './types';
import {NON_TERMINAL_SCHEDULE_STATES,nextEnrollmentRequest,requestAutopay,pauseAutopay,resumeAutopay,turnOffAutopay,stopAutopayByClient} from './enrollmentLifecycle';
describe('enrollment lifecycle',()=>{
 it('preserves the C4 executor union for every lifecycle operation',()=>{
  expectTypeOf<Parameters<typeof requestAutopay>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<Parameters<typeof pauseAutopay>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<Parameters<typeof resumeAutopay>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<Parameters<typeof turnOffAutopay>[0]>().toEqualTypeOf<Tx>();
  expectTypeOf<Parameters<typeof stopAutopayByClient>[0]>().toEqualTypeOf<Tx>();
 });
 it('cannot treat processing as permission for another charge',()=>{
  expect(NON_TERMINAL_SCHEDULE_STATES).toEqual(['awaiting_notice','scheduled','collecting','retry_scheduled','action_required']);
 });
 it('new requests advance authority but active clients are not reset',()=>{
  expect(nextEnrollmentRequest(null)).toBe(1);
  expect(nextEnrollmentRequest({status:'cancelled',generation:9})).toBe(10);
  expect(nextEnrollmentRequest({status:'requested',generation:9})).toBe(10);
  expect(nextEnrollmentRequest({status:'active',generation:9})).toBeNull();
  expect(nextEnrollmentRequest({status:'paused',generation:9})).toBeNull();
 });
});
```
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/enrollmentLifecycle.test.ts`; missing module. With a narrowed executor implementation, `pnpm exec tsc --build apps/api/tsconfig.tests.json` from the repository root must fail the five C4 parameter assertions.
- [ ] **Step 3: Implement** — `enrollmentLifecycle.ts`:
```ts
import {and,eq,inArray,sql} from 'drizzle-orm';
import {db as database,runAfterDbContextExit,withSystemDbAccessContext} from '../../db';
import {organizations,partners,orgAutopayEnrollments,orgPaymentMethods,invoiceAutopaySchedules,invoices,stripeConnectAccounts} from '../../db/schema';
import {InvoiceServiceError,type InvoiceActor} from '../invoiceTypes';
import {requireOrgAccess} from '../invoiceService';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getOrMintInvoiceLink,buildPublicInvoiceUrl} from '../invoiceLinkToken';
import {isAutopayEnabledForPartner} from './autopayGate';
import {getAutopayStripeReadiness} from './stripeCapabilities';
import {resolveBillingPaymentSettings} from './billingPaymentSettings';
import {mintBillingLinkToken,revokeBillingLinkTokens,buildBillingLinkUrl} from './linkTokens';
import {enqueueBillingNotice} from './noticeOutbox';
import {renderBillingNotice} from './renderBillingNotice';
import {getAutopayMethod,detachPaymentMethodPostCommit} from './paymentMethods';
import {notifyAutopayStaff} from './staffNotifications';
import type { Tx } from './types';
export const NON_TERMINAL_SCHEDULE_STATES=['awaiting_notice','scheduled','collecting','retry_scheduled','action_required'] as const;
export function nextEnrollmentRequest(row:{status:string;generation:number}|null):number|null{
 return row&&['active','paused'].includes(row.status)?null:(row?.generation??0)+1;
}
async function lockOrg(db:Tx,orgId:string,actor?:InvoiceActor){
 if(actor){
  if(!actor.partnerId)throw new InvoiceServiceError('Organization not found',404,'ORG_NOT_FOUND');
  requireOrgAccess(actor,orgId);
 }
 const [org]=await db.select().from(organizations).where(and(eq(organizations.id,orgId),
  actor?eq(organizations.partnerId,actor.partnerId!):undefined)).limit(1).for('update');
 if(!org)throw new InvoiceServiceError('Organization not found',404,'ORG_NOT_FOUND');
 if(org.deletedAt||!['active','trial'].includes(org.status)||['quick_support','unassigned_pool'].includes(org.type))
  throw new InvoiceServiceError('Organization is not available for automatic payments',409,'INVALID_STATE');
 return org;
}
async function lockEnrollment(db:Tx,orgId:string){
 const [row]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1).for('update');
 if(!row)throw new InvoiceServiceError('Automatic payments have not been requested',409,'INVALID_STATE');
 return row;
}
function contact(value:unknown):string|null{
 if(!value||typeof value!=='object')return null;
 const email=(value as {email?:unknown}).email;
 return typeof email==='string'&&email.trim()?email.trim():null;
}
async function notice(db:Tx,enrollment:typeof orgAutopayEnrollments.$inferSelect,kind:'autopay_request'|'autopay_stopped',recipient:string,vars:Record<string,string>,url?:string){
 const [org]=await db.select().from(organizations).where(eq(organizations.id,enrollment.orgId)).limit(1);
 const [partner]=await db.select().from(partners).where(eq(partners.id,enrollment.partnerId)).limit(1);
 if(!org||!partner)throw new Error('Autopay notice tenant disappeared');
 const settings=await resolveBillingPaymentSettings(db,{partnerId:partner.id,orgId:org.id});
 const scheduleText=`Invoices are charged ${settings.autopayOffsetDays.value} days after issue or on the due date, whichever is ${settings.autopayOffsetRule.value}. Required notice can move the payment later.`;
 const rendered=await renderBillingNotice(kind,{autopay:{partnerId:partner.id,orgId:org.id,
  vars:{partner_name:partner.name,org_name:org.name,client_name:org.name,...vars},ctaUrl:url,scheduleText,feeText:''}});
 await enqueueBillingNotice(db,{orgId:org.id,partnerId:partner.id,enrollmentId:enrollment.id,kind,
  seq:enrollment.generation,dedupeKey:`${enrollment.id}:${kind}:${enrollment.generation}:${enrollment.cancelledAt?.toISOString()??enrollment.pausedAt?.toISOString()??'request'}`,
  toEmail:recipient,rendered});
}
export async function requestAutopay(db:Tx,actor:InvoiceActor,input:{orgIds:string[];recipientOverride?:string}):Promise<{requested:string[];skipped:{orgId:string;reason:'no_billing_contact'|'already_active'|'stripe_not_ready'}[]}>{
 const result:{requested:string[];skipped:{orgId:string;reason:'no_billing_contact'|'already_active'|'stripe_not_ready'}[]}={requested:[],skipped:[]};
 for(const orgId of [...new Set(input.orgIds)].sort()){
  const org=await lockOrg(db,orgId,actor);
  if(!await isAutopayEnabledForPartner(db,org.partnerId))throw new InvoiceServiceError('Automatic payments unavailable',404,'INVALID_STATE');
  const [existing]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1).for('update');
  const generation=nextEnrollmentRequest(existing??null);
  if(generation===null){result.skipped.push({orgId,reason:'already_active'});continue;}
  const recipient=input.recipientOverride??contact(org.billingContact);
  if(!recipient){result.skipped.push({orgId,reason:'no_billing_contact'});continue;}
  const readiness=await getAutopayStripeReadiness(db,org.partnerId);
  const [connection]=await db.select().from(stripeConnectAccounts).where(and(eq(stripeConnectAccounts.partnerId,org.partnerId),eq(stripeConnectAccounts.status,'connected'))).limit(1).for('share');
  if(!readiness.ready||!connection){result.skipped.push({orgId,reason:'stripe_not_ready'});continue;}
  const values={status:'requested' as const,generation,stripeConnectionId:connection.id,stripeAccountId:connection.stripeAccountId,
   stripeCustomerId:existing?.stripeAccountId===connection.stripeAccountId?existing.stripeCustomerId:null,
   effectiveFrom:null,requestedBy:actor.userId,requestedAt:new Date(),requestRecipientEmail:recipient,
   pausedBy:null,pausedAt:null,cancelledAt:null,cancelSource:null,cancelReason:null,needsAttentionReason:null};
  const [enrollment]=existing?await db.update(orgAutopayEnrollments).set(values).where(eq(orgAutopayEnrollments.id,existing.id)).returning():
   await db.insert(orgAutopayEnrollments).values({orgId,partnerId:org.partnerId,...values}).returning();
  await revokeBillingLinkTokens(db,{orgId,enrollmentId:enrollment!.id});
  const token=await mintBillingLinkToken(db,{orgId,purpose:'enroll',enrollmentId:enrollment!.id,generation,ttlDays:30});
  const settings=await resolveBillingPaymentSettings(db,{partnerId:org.partnerId,orgId});
  const url=buildBillingLinkUrl('enroll',token.token);
  await notice(db,enrollment!,'autopay_request',recipient,{setup_link:url,ach_mode_text:settings.achMode.value==='ach_only'?'Use a US bank account.':'Choose a bank account or card.'},url);
  result.requested.push(orgId);
 }
 return result;
}
export async function pauseAutopay(db:Tx,actor:InvoiceActor,orgId:string):Promise<void>{
 const org=await lockOrg(db,orgId,actor);const enrollment=await lockEnrollment(db,orgId);
 if(enrollment.status==='paused')return;
 if(enrollment.status!=='active')throw new InvoiceServiceError('Only active automatic payments can be paused',409,'INVALID_STATE');
 const [updated]=await db.update(orgAutopayEnrollments).set({status:'paused',pausedBy:actor.userId,pausedAt:new Date()})
  .where(eq(orgAutopayEnrollments.id,enrollment.id)).returning();
 await db.update(invoiceAutopaySchedules).set({state:'cancelled',stateReason:'paused_by_msp'})
  .where(and(eq(invoiceAutopaySchedules.orgId,orgId),inArray(invoiceAutopaySchedules.state,[...NON_TERMINAL_SCHEDULE_STATES])));
 await db.update(autopaySetupAttempts).set({outcome:'stale_generation',completedAt:new Date()}).where(and(eq(autopaySetupAttempts.enrollmentId,enrollment.id),eq(autopaySetupAttempts.generation,enrollment.generation)));
 const recipient=enrollment.requestRecipientEmail??contact(org.billingContact);
 if(recipient)await notice(db,updated!,'autopay_stopped',recipient,{stopped_by:'Your service provider paused automatic payments',open_invoices_text:'Existing invoices remain payable using their payment links.'});
}
export async function resumeAutopay(db:Tx,actor:InvoiceActor,orgId:string):Promise<void>{
 await lockOrg(db,orgId,actor);const enrollment=await lockEnrollment(db,orgId);
 if(enrollment.status==='active')return;
 const method=await getAutopayMethod(db,orgId);
 if(enrollment.status!=='paused'||method?.status!=='active'||enrollment.needsAttentionReason)
  throw new InvoiceServiceError('Update the payment method before resuming',409,'INVALID_STATE');
 if(!await isAutopayEnabledForPartner(db,enrollment.partnerId)||!(await getAutopayStripeReadiness(db,enrollment.partnerId)).ready)
  throw new InvoiceServiceError('Stripe is not ready for automatic payments',409,'INVALID_STATE');
 await db.update(orgAutopayEnrollments).set({status:'active',effectiveFrom:new Date(),pausedBy:null,pausedAt:null})
  .where(eq(orgAutopayEnrollments.id,enrollment.id));
}
async function stop(db:Tx,orgId:string,source:'client'|'msp',actor?:InvoiceActor):Promise<void>{
 const org=await lockOrg(db,orgId,actor);const enrollment=await lockEnrollment(db,orgId);
 if(enrollment.status==='cancelled')return;
 const [updated]=await db.update(orgAutopayEnrollments).set({status:'cancelled',cancelledAt:new Date(),cancelSource:source,cancelReason:'autopay_stopped'})
  .where(eq(orgAutopayEnrollments.id,enrollment.id)).returning();
 await db.update(invoiceAutopaySchedules).set({state:'cancelled',stateReason:'autopay_stopped'})
  .where(and(eq(invoiceAutopaySchedules.orgId,orgId),inArray(invoiceAutopaySchedules.state,[...NON_TERMINAL_SCHEDULE_STATES])));
 const removed=await db.update(orgPaymentMethods).set({status:'removed',isAutopayMethod:false,removedAt:new Date()})
  .where(and(eq(orgPaymentMethods.orgId,orgId),eq(orgPaymentMethods.isAutopayMethod,true),inArray(orgPaymentMethods.status,['active','pending_verification','unusable']))).returning();
 await revokeBillingLinkTokens(db,{orgId,enrollmentId:enrollment.id});
 const open=await db.select().from(invoices).where(and(eq(invoices.orgId,orgId),inArray(invoices.status,['sent','partially_paid','overdue']),sql`${invoices.balance}>0`));
 const lines:string[]=[];
 for(const invoice of open){const link=await getOrMintInvoiceLink(invoice);lines.push(`${invoice.invoiceNumber??invoice.id}: ${invoice.currencyCode} ${invoice.balance} — ${buildPublicInvoiceUrl(link.token)}`);}
 const recipient=enrollment.requestRecipientEmail??contact(org.billingContact);
 if(recipient)await notice(db,updated!,'autopay_stopped',recipient,{stopped_by:source==='client'?'You':'Your service provider',open_invoices_text:lines.join('\n')||'There are no open invoices.'});
 for(const method of removed)runAfterDbContextExit('autopay.detach',()=>detachPaymentMethodPostCommit(enrollment.partnerId,method.id));
 runAfterDbContextExit('autopay.stopped',async()=>{
  const [committed]=await withSystemDbAccessContext(()=>database.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,enrollment.id)).limit(1));
  if(committed?.status==='cancelled'&&committed.generation===enrollment.generation)await notifyAutopayStaff({orgId,partnerId:enrollment.partnerId,event:'autopay.stopped',
   dedupeKey:`${enrollment.id}:stopped:${enrollment.generation}`,message:`Automatic payments stopped for ${org.name}.`});
 });
}
export async function turnOffAutopay(db:Tx,actor:InvoiceActor,orgId:string):Promise<void>{await stop(db,orgId,'msp',actor);}
export async function stopAutopayByClient(db:Tx,input:{orgId:string;source:'link'|'portal';portalUserId?:string}):Promise<void>{await stop(db,input.orgId,'client');}
```
Create `enrollmentService.ts` as the C4 facade:
```ts
export {requestAutopay,pauseAutopay,resumeAutopay,turnOffAutopay,stopAutopayByClient} from './enrollmentLifecycle';
```
Staff actors retain the existing nullable `InvoiceActor.userId` attribution contract; a partner identity is mandatory and the org allowlist is enforced. Public/client stop receives an org already authenticated by Task 11. These functions never substitute a new executor or independently commit. Stop changes schedules but never changes an `invoice_collection_attempts` row: an ACH debit already processing keeps its reservation and settles through W4. Pause preserves the method and generation. Resume resets the eligibility boundary to the resume timestamp and never restores cancelled schedules. Requested and cancelled enrollments alone can receive a new generation.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/enrollmentLifecycle.test.ts`; from the root run `pnpm exec tsc --build apps/api/tsconfig.tests.json` for all five C4 executor assertions. Also run Task 7's real-DB lifecycle cases and Task 12's org-scoped request/pause/resume, authorization and raw-transaction rollback cases after their implementation exists.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/enrollmentLifecycle.ts apps/api/src/services/autopay/enrollmentLifecycle.test.ts apps/api/src/services/autopay/enrollmentService.ts` then `git commit -m "feat(billing): manage autopay enrollment lifecycle"`.

### Task 6: Create one account-bound Customer and a setup-only Checkout session
**Files:** Create `apps/api/src/services/autopay/setupSession.ts`, `apps/api/src/services/autopay/setupSession.test.ts`; Modify `apps/api/src/services/autopay/enrollmentService.ts`, `apps/api/src/services/stripeCheckoutCallSites.test.ts`.
**Interfaces:** Consumes `buildAutopayDisclosure(db,orgId,methodType)`, `requireAcceptedAutopayDisclosure(hash)`, C4 readiness/gate and C2 enrollment; produces exact C4 `createAutopaySetupSession(input):Promise<{url:string}>` and private `prepareAutopayCapture(input)` reused by pay-and-save.

- [ ] **Step 1: Write the failing test** — `setupSession.test.ts`:
```ts
import {describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({client:vi.fn(),create:vi.fn()}));
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:mock.client}));
vi.mock('../../db',()=>({db:{},hasDbAccessContext:()=>false,
 withSystemDbAccessContext:(fn:any)=>fn(),runOutsideDbContext:(fn:any)=>fn()}));
import {createHostedAutopaySession} from './setupSession';
describe('Stripe setup boundary',()=>{
 it('pins one method, automatic bank verification and authority metadata',async()=>{
  mock.create.mockResolvedValue({id:'cs_setup',url:'https://checkout.stripe.com/test'});
  mock.client.mockResolvedValue({stripeAccountId:'acct_one',stripe:{checkout:{sessions:{create:mock.create}}}});
  await createHostedAutopaySession({partnerId:'p',stripeAccountId:'acct_one',stripeCustomerId:'cus_one',
   id:'attempt',orgId:'org',enrollmentId:'enroll',generation:7,tokenId:'token',methodType:'us_bank_account'},'public');
  expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({mode:'setup',customer:'cus_one',
   payment_method_types:['us_bank_account'],payment_method_options:{us_bank_account:{verification_method:'automatic'}},
   metadata:expect.objectContaining({org_id:'org',enrollment_id:'enroll',generation:'7',token_id:'token',setup_attempt_id:'attempt'})}),
   {idempotencyKey:'autopay_setup_attempt'});
 });
 it('refuses the wrong account before a provider mutation',async()=>{
  mock.create.mockClear();mock.client.mockResolvedValue({stripeAccountId:'acct_other',stripe:{checkout:{sessions:{create:mock.create}}}});
  await expect(createHostedAutopaySession({partnerId:'p',stripeAccountId:'acct_one',stripeCustomerId:'cus_one',
   id:'a',orgId:'o',enrollmentId:'e',generation:1,tokenId:null,methodType:'card'},'portal')).rejects.toThrow(/account/);
  expect(mock.create).not.toHaveBeenCalled();
 });
});
```
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/setupSession.test.ts`; missing module.
- [ ] **Step 3: Implement** — `setupSession.ts`:
```ts
import {and,eq,desc,sql} from 'drizzle-orm';
import type {AutopayPaymentMethodType} from '@breeze/shared';
import type Stripe from 'stripe';
import {db,withSystemDbAccessContext,runOutsideDbContext} from '../../db';
import {organizations,orgAutopayEnrollments,billingLinkTokens,stripeConnectAccounts} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getPartnerStripeClient} from '../partnerStripe';
import {assertNoHeldDbContextForStripe} from '../stripeSettle';
import {InvoiceServiceError} from '../invoiceTypes';
import {portalBase} from '../portalUrl';
import {mapStripeCheckoutError} from '../stripeCheckoutErrors';
import {isAutopayEnabledForPartner} from './autopayGate';
import {getAutopayStripeReadiness} from './stripeCapabilities';
import {buildAutopayDisclosure,requireAcceptedAutopayDisclosure} from './consentText';
export type SetupInput={orgId:string;methodType:AutopayPaymentMethodType;consentAccepted:true;
 returnTo:'public'|'portal';tokenId?:string;contactEmail:string;ip:string|null;userAgent:string|null};
export async function prepareAutopayCapture(input:SetupInput,source:'setup_page'|'pay_and_save'|'portal',invoiceId?:string,checkoutKey?:string){
 assertNoHeldDbContextForStripe('prepareAutopayCapture');
 const attempt=await withSystemDbAccessContext(async()=>{
  const [org]=await db.select().from(organizations).where(eq(organizations.id,input.orgId)).limit(1).for('update');
  if(!org||org.deletedAt||!['active','trial'].includes(org.status))throw new InvoiceServiceError('Organization unavailable',404,'ORG_NOT_FOUND');
  if(!await isAutopayEnabledForPartner(db,org.partnerId))throw new InvoiceServiceError('Automatic payments unavailable',404,'INVALID_STATE');
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,org.id)).limit(1).for('update');
  if(!enrollment||!['requested','active'].includes(enrollment.status))throw new InvoiceServiceError('Request automatic payments first',409,'INVALID_STATE');
  const ready=await getAutopayStripeReadiness(db,org.partnerId);
  const supported=['US','CA','GB','AU','NZ','AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IS','IE','IT','LV','LI','LT','LU','MT','NL','NO','PL','PT','RO','SK','SI','ES','SE'];
  if(!ready.accountCountry||!supported.includes(ready.accountCountry))throw new InvoiceServiceError('Automatic payments are unavailable for this Stripe account country',409,'INVALID_STATE');
  if(!ready.ready||ready.stripeAccountId!==enrollment.stripeAccountId)throw new InvoiceServiceError('Stripe account is not ready',409,'INVALID_STATE');
  const [connection]=await db.select().from(stripeConnectAccounts).where(and(eq(stripeConnectAccounts.id,enrollment.stripeConnectionId),eq(stripeConnectAccounts.status,'connected'))).limit(1).for('share');
  if(!connection||connection.stripeAccountId!==enrollment.stripeAccountId)throw new InvoiceServiceError('Stripe connection changed',409,'INVALID_STATE');
  if(input.tokenId){
   const [token]=await db.select().from(billingLinkTokens).where(eq(billingLinkTokens.id,input.tokenId)).limit(1).for('update');
   if(!token||token.orgId!==org.id||token.enrollmentId!==enrollment.id||token.purpose!=='enroll'||token.generation!==enrollment.generation||
    token.revokedAt||token.consumedAt||token.expiresAt<=new Date())throw new InvoiceServiceError('Setup link expired',404,'INVALID_STATE');
  }else if(source==='setup_page')throw new InvoiceServiceError('Setup link required',403,'INVALID_STATE');
  const disclosure=await buildAutopayDisclosure(db,org.id,input.methodType);
  requireAcceptedAutopayDisclosure(disclosure.hash);
  if((disclosure.achMode==='card_only'&&input.methodType!=='card')||(disclosure.achMode==='ach_only'&&input.methodType!=='us_bank_account'))
   throw new InvoiceServiceError('Payment method unavailable',409,'INVALID_STATE');
  if(checkoutKey){
   const [prior]=await db.select().from(autopaySetupAttempts).where(and(eq(autopaySetupAttempts.enrollmentId,enrollment.id),
    eq(autopaySetupAttempts.generation,enrollment.generation),sql`${autopaySetupAttempts.consentSnapshot}->>'checkoutKey'=${checkoutKey}`,
    sql`${autopaySetupAttempts.consentSnapshot}->>'hash'=${disclosure.hash}`)).orderBy(desc(autopaySetupAttempts.ordinal)).limit(1);
   if(prior&&prior.outcome!=='stale_generation')return prior;
  }
  const [saved]=await db.insert(autopaySetupAttempts).values({orgId:org.id,partnerId:org.partnerId,enrollmentId:enrollment.id,
   generation:enrollment.generation,tokenId:input.tokenId??null,source,methodType:input.methodType,
   stripeConnectionId:connection.id,stripeAccountId:connection.stripeAccountId,stripeCustomerId:enrollment.stripeCustomerId,
   consentSnapshot:{invoiceId:invoiceId??null,checkoutKey:checkoutKey??null,...disclosure,contactEmail:input.contactEmail,ip:input.ip,userAgent:input.userAgent,source}}).returning();
  return saved!;
 });
 if(attempt.stripeCustomerId)return attempt;
 const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(attempt.partnerId));
 if(stripeAccountId!==attempt.stripeAccountId)throw new Error('Stripe account changed');
 let customer:Stripe.Customer|undefined;
 let after:string|undefined;
 do{
  const page=await runOutsideDbContext(()=>stripe.customers.list({limit:100,...(after?{starting_after:after}:{})}));
  customer=page.data.find(candidate=>candidate.metadata.org_id===attempt.orgId&&candidate.metadata.partner_id===attempt.partnerId);
  after=page.has_more?page.data.at(-1)?.id:undefined;
 }while(!customer&&after);
 customer??=await runOutsideDbContext(()=>stripe.customers.create({metadata:{org_id:attempt.orgId,partner_id:attempt.partnerId}},
  {idempotencyKey:`autopay_customer_${attempt.orgId}_${attempt.stripeAccountId}`}));
 const customerId=customer.id;
 return withSystemDbAccessContext(async()=>{
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,attempt.enrollmentId)).limit(1).for('update');
  if(!enrollment||enrollment.stripeAccountId!==attempt.stripeAccountId)throw new Error('Stripe account changed');
  if(enrollment.stripeCustomerId&&enrollment.stripeCustomerId!==customerId)throw new Error('Stripe Customer identity conflict');
  await db.update(orgAutopayEnrollments).set({stripeCustomerId:customerId}).where(eq(orgAutopayEnrollments.id,enrollment.id));
  const [saved]=await db.update(autopaySetupAttempts).set({stripeCustomerId:customerId}).where(eq(autopaySetupAttempts.id,attempt.id)).returning();
  return saved!;
 });
}
export async function createHostedAutopaySession(attempt:{id:string;partnerId:string;orgId:string;enrollmentId:string;generation:number;tokenId:string|null;
 stripeCustomerId:string;stripeAccountId:string;methodType:string},returnTo:'public'|'portal'){
 const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(attempt.partnerId));
 if(stripeAccountId!==attempt.stripeAccountId)throw new Error('Stripe account changed');
 const metadata={org_id:attempt.orgId,enrollment_id:attempt.enrollmentId,generation:String(attempt.generation),token_id:attempt.tokenId??'',setup_attempt_id:attempt.id};
 try{return await runOutsideDbContext(()=>stripe.checkout.sessions.create({mode:'setup',customer:attempt.stripeCustomerId,
  payment_method_types:[attempt.methodType as AutopayPaymentMethodType],
  ...(attempt.methodType==='us_bank_account'?{currency:'usd',payment_method_options:{us_bank_account:{verification_method:'automatic' as const}}}:{}),
  metadata,setup_intent_data:{metadata},
  success_url:`${portalBase()}/autopay/return?session_id={CHECKOUT_SESSION_ID}&target=${returnTo}`,
  cancel_url:returnTo==='portal'?`${portalBase()}/payment-methods`:`${portalBase()}/autopay/return?cancelled=1`
 },{idempotencyKey:`autopay_setup_${attempt.id}`}));
 }catch(error){throw mapStripeCheckoutError(error,'USD')??error;}
}
export async function createAutopaySetupSession(input:SetupInput):Promise<{url:string}>{
 const attempt=await prepareAutopayCapture(input,input.returnTo==='portal'?'portal':'setup_page');
 if(!attempt.stripeCustomerId)throw new Error('Stripe Customer missing');
 const session=await createHostedAutopaySession({...attempt,stripeCustomerId:attempt.stripeCustomerId},input.returnTo);
 await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({checkoutSessionId:session.id,
  setupIntentId:typeof session.setup_intent==='string'?session.setup_intent:session.setup_intent?.id??null}).where(eq(autopaySetupAttempts.id,attempt.id)));
 if(!session.url)throw new InvoiceServiceError('Stripe returned no setup URL',500,'STRIPE_NO_URL');
 const valid=await withSystemDbAccessContext(async()=>{
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,attempt.enrollmentId)).limit(1);
  return enrollment&&enrollment.generation===attempt.generation&&['requested','active'].includes(enrollment.status)&&
   await isAutopayEnabledForPartner(db,attempt.partnerId);
 });
 if(!valid)throw new InvoiceServiceError('Automatic payment setup was cancelled',409,'INVALID_STATE');
 return {url:session.url};
}
```
Add to `enrollmentService.ts`:
```ts
export {createAutopaySetupSession} from './setupSession';
```
Add to `EXPECTED_CALL_SITES` in `stripeCheckoutCallSites.test.ts`:
```ts
'apps/api/src/services/autopay/setupSession.ts':1,
```
The enclosing catch calls the existing `mapStripeCheckoutError(error,currency)` so the AST contract keeps enforcing friendly currency errors.

The Customer idempotency key intentionally excludes mutable name/email. Never reuse that key with different Stripe parameters. The paginated Customer lookup recovers a response lost beyond Stripe's idempotency retention before creating a replacement. Customer list reads must be available on the restricted key; the Stripe lab exercises this recovery boundary.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/setupSession.test.ts src/services/stripeCheckoutCallSites.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/setupSession.ts apps/api/src/services/autopay/setupSession.test.ts apps/api/src/services/autopay/enrollmentService.ts apps/api/src/services/stripeCheckoutCallSites.test.ts` then `git commit -m "feat(billing): create account-bound autopay setup sessions"`.

### Task 7: Complete setup exactly once and fence stale or superseded authority
**Files:** Create `apps/api/src/services/autopay/setupCompletion.ts`, `apps/api/src/services/autopay/setupCompletion.test.ts`, `apps/api/src/services/autopay/enrollmentService.integration.test.ts`; Modify `apps/api/src/services/autopay/enrollmentService.ts`.
**Interfaces:** Consumes C4 `getAutopayMethod`, Task 1 snapshot, Task 2 detachment; produces exact C4 `completeAutopaySetup(partnerId,ref):Promise<{outcome:'activated'|'pending_verification'|'stale_generation'|'failed';orgId:string}>`, private `persistCapturedAutopayMethod` shared with pay-and-save.

- [ ] **Step 1: Write the failing test** — `setupCompletion.test.ts`:
```ts
import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rows:[] as unknown[][],writes:[] as Record<string,unknown>[],client:vi.fn(),
 session:vi.fn(),intent:vi.fn(),method:vi.fn(),mandate:vi.fn(),enqueue:vi.fn(),mint:vi.fn()}));
vi.mock('../../db',()=>{
 function chain(){const c:any={};for(const name of ['from','innerJoin','where','limit','for','orderBy','returning'])c[name]=()=>c;
  c.set=(value:Record<string,unknown>)=>{m.writes.push(value);return c;};
  c.values=(value:Record<string,unknown>)=>{m.writes.push(value);return c;};
  c.then=(resolve:any)=>Promise.resolve(m.rows.shift()??[]).then(resolve);return c;}
 return {db:{select:chain,insert:chain,update:chain},withSystemDbAccessContext:(fn:any)=>fn(),runOutsideDbContext:(fn:any)=>fn(),
  runAfterDbContextExit:vi.fn(),hasDbAccessContext:()=>false};
});
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:m.client}));
vi.mock('./noticeOutbox',()=>({enqueueBillingNotice:m.enqueue}));
vi.mock('./renderBillingNotice',()=>({renderBillingNotice:vi.fn(async()=>({subject:'Saved',html:'Saved',text:'Saved',frozen:{}}))}));
vi.mock('./linkTokens',()=>({mintBillingLinkToken:m.mint,buildBillingLinkUrl:()=> 'https://portal.example.test/portal/autopay/token/stop'}));
vi.mock('./staffNotifications',()=>({notifyAutopayStaff:vi.fn()}));
import {completeAutopaySetup,setupAuthorityOutcome,setupIntentOutcome} from './setupCompletion';
const snapshot={version:'2026-10-01.v1',text:'I authorize Example MSP.',textHash:'b'.repeat(64),hash:'a'.repeat(64),
 scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},
 contactEmail:'billing@example.test',ip:null,userAgent:null,source:'setup_page',scheduleText:'On the due date.',feeText:'No fee.'};
function attempt(extra:Record<string,unknown>={}){return {id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222',
 partnerId:'33333333-3333-4333-8333-333333333333',enrollmentId:'44444444-4444-4444-8444-444444444444',generation:3,tokenId:null,
 stripeConnectionId:'55555555-5555-4555-8555-555555555555',stripeAccountId:'acct_one',stripeCustomerId:'cus_one',methodType:'card',
 consentSnapshot:snapshot,outcome:null,completedAt:null,...extra};}
function queueAuthority(value=attempt()){
 m.rows.push([value],[value],[{id:value.orgId,status:'active',deletedAt:null}],
  [{id:value.enrollmentId,status:'requested',generation:3,stripeAccountId:'acct_one',stripeCustomerId:'cus_one',effectiveFrom:null}],
  [{id:value.id}],[{id:value.stripeConnectionId,stripeAccountId:'acct_one',status:'connected'}]);
}
beforeEach(()=>{
 vi.clearAllMocks();m.rows.length=0;m.writes.length=0;const value=attempt();
 m.client.mockResolvedValue({stripeAccountId:'acct_one',stripe:{checkout:{sessions:{retrieve:m.session}},setupIntents:{retrieve:m.intent},
  paymentMethods:{retrieve:m.method},mandates:{retrieve:m.mandate}}});
 m.session.mockResolvedValue({mode:'setup',setup_intent:'seti_one'});
 m.intent.mockResolvedValue({id:'seti_one',status:'succeeded',next_action:null,customer:'cus_one',payment_method:'pm_one',mandate:null,
  metadata:{setup_attempt_id:value.id,org_id:value.orgId,enrollment_id:value.enrollmentId,generation:'3',token_id:''}});
 m.method.mockResolvedValue({id:'pm_one',type:'card',customer:'cus_one',card:{brand:'visa',funding:'debit',last4:'1234',exp_month:12,exp_year:2030,country:'US'}});
 m.mint.mockResolvedValue({id:'token',token:'token'});m.enqueue.mockResolvedValue({id:'notice',created:true});
});
describe('completion fences',()=>{
 it.each(['paused','cancelled'])('cannot activate %s',status=>{
  expect(setupAuthorityOutcome({status,generation:3},3,true)).toBe('stale_generation');
 });
 it('old generations and superseded same-generation attempts never reactivate',()=>{
  expect(setupAuthorityOutcome({status:'requested',generation:4},3,true)).toBe('stale_generation');
  expect(setupAuthorityOutcome({status:'active',generation:3},3,false)).toBe('stale_generation');
 });
 it('microdeposits are pending but card authentication is never called success',()=>{
  expect(setupIntentOutcome({status:'requires_action',next_action:{type:'verify_with_microdeposits'}})).toBe('pending_verification');
  expect(setupIntentOutcome({status:'requires_action',next_action:{type:'use_stripe_sdk'}})).toBe('failed');
 });
 it('retrieves provider truth and records the exact accepted authorization once',async()=>{
  queueAuthority();m.rows.push([],[],[{id:'method_one'}],[],[],[]);
  expect(await completeAutopaySetup(attempt().partnerId,{checkoutSessionId:'cs_one'})).toEqual({outcome:'activated',orgId:attempt().orgId});
  expect(m.session).toHaveBeenCalledWith('cs_one');expect(m.intent).toHaveBeenCalledWith('seti_one');
  expect(m.writes).toContainEqual(expect.objectContaining({cardFunding:'debit',cardLast4:'1234',status:'active'}));
  expect(m.writes.filter(row=>'consentTextVersion'in row)).toEqual([expect.objectContaining({consentTextHash:snapshot.textHash,source:'setup_page',scheduleTerms:snapshot.scheduleTerms,feeTerms:snapshot.feeTerms})]);
  expect(m.enqueue).toHaveBeenCalledTimes(1);
  m.writes.length=0;queueAuthority(attempt({outcome:'activated',completedAt:new Date()}));
  await completeAutopaySetup(attempt().partnerId,{checkoutSessionId:'cs_one'});
  expect(m.writes).toEqual([]);expect(m.enqueue).toHaveBeenCalledTimes(1);
 });
 it('refuses another Customer before writing a payment method',async()=>{
  m.rows.push([attempt()]);m.intent.mockResolvedValueOnce({...await m.intent(),customer:'cus_other'});
  await expect(completeAutopaySetup(attempt().partnerId,{checkoutSessionId:'cs_one'})).rejects.toThrow(/binding/);
  expect(m.writes).toEqual([]);expect(m.method).not.toHaveBeenCalled();
 });
 it('preserves the first effective date when updating an active enrollment',async()=>{
  const value=attempt();const effectiveFrom=new Date('2026-10-01T00:00:00Z');
  m.rows.push([value],[value],[{id:value.orgId,status:'active'}],[{id:value.enrollmentId,status:'active',generation:3,
   stripeAccountId:'acct_one',stripeCustomerId:'cus_one',effectiveFrom}],[{id:value.id}],[{stripeAccountId:'acct_one',status:'connected'}],[],[],[{id:'new_method'}],[],[],[]);
  await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'});
  expect(m.writes).toContainEqual(expect.objectContaining({status:'active',effectiveFrom}));
  expect(m.writes.some(row=>'generation'in row&&row.generation!==3)).toBe(false);
 });
 it('records no new consent or stop token when pending verification is polled twice',async()=>{
  const value=attempt({outcome:'pending_verification',methodType:'us_bank_account'});
  m.intent.mockResolvedValueOnce({...await m.intent(),status:'requires_action',next_action:{type:'verify_with_microdeposits'}});
  m.method.mockResolvedValueOnce({id:'pm_bank',type:'us_bank_account',customer:'cus_one'});
  queueAuthority(value);
  expect((await completeAutopaySetup(value.partnerId,{setupIntentId:'seti_one'})).outcome).toBe('pending_verification');
  expect(m.writes).toEqual([]);expect(m.mint).not.toHaveBeenCalled();
 });
});
```
Create `enrollmentService.integration.test.ts` with real enrollment locking and mocked Stripe boundary:
```ts
import '../../__tests__/integration/setup';
import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {db,withSystemDbAccessContext} from '../../db';
import {createPartner,createOrganization} from '../../__tests__/integration/db-utils';
import {persistCapturedAutopayMethod} from './setupCompletion';
import {stopAutopayByClient} from './enrollmentLifecycle';
import {getPartnerStripeClient} from '../partnerStripe';
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:vi.fn()}));
vi.mock('./staffNotifications',()=>({notifyAutopayStaff:vi.fn()}));
describe('real enrollment authority fence',()=>{
 it('concurrent stale completions cannot reactivate a stopped enrollment',async()=>{
  const partner=await createPartner();const org=await createOrganization({partnerId:partner.id});
  const enrollmentId=randomUUID(),attemptId=randomUUID();
  await withSystemDbAccessContext(async()=>{
   await db.execute(sql`INSERT INTO org_autopay_enrollments(id,org_id,partner_id,status,generation,stripe_account_id,stripe_customer_id)
    VALUES(${enrollmentId},${org.id},${partner.id},'cancelled',2,'acct_one','cus_one')`);
   await db.execute(sql`INSERT INTO autopay_setup_attempts(id,org_id,partner_id,enrollment_id,generation,source,method_type,
    stripe_connection_id,stripe_account_id,stripe_customer_id,consent_snapshot)
    VALUES(${attemptId},${org.id},${partner.id},${enrollmentId},1,'setup_page','card',${randomUUID()},'acct_one','cus_one','{}'::jsonb)`);
  });
  const method={id:'pm_stale',type:'card',customer:'cus_one'} as any;
  const outcomes=await Promise.all([1,2].map(()=>persistCapturedAutopayMethod(attemptId,method,'activated','seti_stale',null)));
  expect(outcomes.map(row=>row.outcome)).toEqual(['stale_generation','stale_generation']);
  const rows=await withSystemDbAccessContext(()=>db.execute(sql`SELECT status FROM org_autopay_enrollments WHERE id=${enrollmentId}`));
  expect(Array.from(rows)).toEqual([{status:'cancelled'}]);
  const methods=await withSystemDbAccessContext(()=>db.execute(sql`SELECT id FROM org_payment_methods WHERE org_id=${org.id}`));
  expect(Array.from(methods)).toEqual([]);
 });
 it('a rolled-back stop cannot detach, and committed stop keeps a processing debit intact',async()=>{
  const partner=await createPartner();const org=await createOrganization({partnerId:partner.id});
  const enrollmentId=randomUUID(),methodId=randomUUID(),invoiceId=randomUUID(),collectionId=randomUUID();
  await withSystemDbAccessContext(async()=>{
   await db.execute(sql`INSERT INTO org_autopay_enrollments(id,org_id,partner_id,status,generation,stripe_account_id,stripe_customer_id)
    VALUES(${enrollmentId},${org.id},${partner.id},'active',1,'acct_stop','cus_stop')`);
   await db.execute(sql`INSERT INTO org_payment_methods(id,org_id,enrollment_id,stripe_payment_method_id,type,status,is_autopay_method)
    VALUES(${methodId},${org.id},${enrollmentId},'pm_stop','us_bank_account','active',true)`);
   await db.execute(sql`INSERT INTO invoices(id,partner_id,org_id,currency_code,status,total,amount_paid,balance)
    VALUES(${invoiceId},${partner.id},${org.id},'USD','paid','100.00','100.00','0.00')`);
   await db.execute(sql`INSERT INTO invoice_collection_attempts(id,org_id,invoice_id,schedule_id,attempt_no,payment_method_id,
    stripe_payment_intent_id,idempotency_key,principal_amount,fee_amount,currency,state,initiated_by)
    VALUES(${collectionId},${org.id},${invoiceId},NULL,1,${methodId},'pi_processing','stop_test','100.00','0.00','USD','processing','client_on_session')`);
  });
  await expect(withSystemDbAccessContext(async()=>{
   await stopAutopayByClient(db,{orgId:org.id,source:'portal'});throw new Error('force rollback');
  })).rejects.toThrow('force rollback');
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(getPartnerStripeClient).not.toHaveBeenCalled();
  const before=await withSystemDbAccessContext(()=>db.execute(sql`SELECT status FROM org_payment_methods WHERE id=${methodId}`));
  expect(Array.from(before)).toEqual([{status:'active'}]);
  vi.mocked(getPartnerStripeClient).mockResolvedValue({stripeAccountId:'acct_stop',defaultCurrency:'USD',
   stripe:{paymentMethods:{retrieve:vi.fn(async()=>({id:'pm_stop',customer:null})),detach:vi.fn()}} as any});
  await withSystemDbAccessContext(()=>stopAutopayByClient(db,{orgId:org.id,source:'portal'}));
  const after=await withSystemDbAccessContext(()=>db.execute(sql`SELECT state,principal_amount FROM invoice_collection_attempts WHERE id=${collectionId}`));
  expect(Array.from(after)).toEqual([{state:'processing',principal_amount:'100.00'}]);
  const enrollment=await withSystemDbAccessContext(()=>db.execute(sql`SELECT status,cancel_source FROM org_autopay_enrollments WHERE id=${enrollmentId}`));
  expect(Array.from(enrollment)).toEqual([{status:'cancelled',cancel_source:'client'}]);
 });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/setupCompletion.test.ts`; missing module.
- [ ] **Step 3: Implement** — `setupCompletion.ts`:
```ts
import type Stripe from 'stripe';
import {and,desc,eq,inArray} from 'drizzle-orm';
import {db,withSystemDbAccessContext,runOutsideDbContext,runAfterDbContextExit} from '../../db';
import {organizations,stripeConnectAccounts,orgAutopayEnrollments,orgPaymentMethods,orgAutopayConsents,billingLinkTokens} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getPartnerStripeClient} from '../partnerStripe';
import {assertNoHeldDbContextForStripe} from '../stripeSettle';
import {enqueueBillingNotice} from './noticeOutbox';
import {renderBillingNotice} from './renderBillingNotice';
import {mintBillingLinkToken,buildBillingLinkUrl} from './linkTokens';
import {detachPaymentMethodPostCommit} from './paymentMethods';
import {notifyAutopayStaff} from './staffNotifications';
import type {AutopayDisclosure} from './consentText';
type Outcome='activated'|'pending_verification'|'stale_generation'|'failed';
export function setupAuthorityOutcome(enrollment:{status:string;generation:number},generation:number,newest:boolean):'stale_generation'|null{
 return enrollment.generation!==generation||!['requested','active'].includes(enrollment.status)||!newest?'stale_generation':null;
}
export function setupIntentOutcome(intent:{status:string;next_action:{type:string}|null}):Outcome{
 return intent.status==='succeeded'?'activated':intent.status==='requires_action'&&intent.next_action?.type==='verify_with_microdeposits'?'pending_verification':'failed';
}
function id(value:string|{id:string}|null|undefined):string|null{return typeof value==='string'?value:value?.id??null;}
export async function persistCapturedAutopayMethod(attemptId:string,method:Stripe.PaymentMethod,outcome:Outcome,setupIntentId:string|null,mandateId:string|null):Promise<{outcome:Outcome;orgId:string}>{
 return withSystemDbAccessContext(async()=>{
  const [attempt]=await db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attemptId)).limit(1);
  if(!attempt)throw new Error('Unknown autopay setup');
  const [org]=await db.select().from(organizations).where(eq(organizations.id,attempt.orgId)).limit(1).for('update');
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,attempt.enrollmentId)).limit(1).for('update');
  const [latest]=await db.select({id:autopaySetupAttempts.id}).from(autopaySetupAttempts)
   .where(and(eq(autopaySetupAttempts.enrollmentId,attempt.enrollmentId),eq(autopaySetupAttempts.generation,attempt.generation)))
   .orderBy(desc(autopaySetupAttempts.ordinal)).limit(1);
  const [connection]=await db.select().from(stripeConnectAccounts).where(and(eq(stripeConnectAccounts.id,attempt.stripeConnectionId),eq(stripeConnectAccounts.status,'connected'))).limit(1).for('share');
  if(!org||org.deletedAt||!['active','trial'].includes(org.status)||!connection||connection.stripeAccountId!==attempt.stripeAccountId||!enrollment||
   ['stripe_account_changed','key_missing_permissions'].includes(enrollment.needsAttentionReason??'')||attempt.outcome==='stale_generation'||setupAuthorityOutcome(enrollment,attempt.generation,latest?.id===attempt.id)||
   enrollment.stripeAccountId!==attempt.stripeAccountId||enrollment.stripeCustomerId!==id(method.customer)){
   await db.update(autopaySetupAttempts).set({outcome:'stale_generation',completedAt:new Date()}).where(eq(autopaySetupAttempts.id,attempt.id));
   return {outcome:'stale_generation',orgId:attempt.orgId};
  }
  if((attempt.completedAt&&attempt.outcome==='activated')||(attempt.outcome==='pending_verification'&&outcome==='pending_verification'))return {outcome:attempt.outcome as Outcome,orgId:attempt.orgId};
  if(outcome==='failed'){
   await db.update(orgAutopayEnrollments).set({needsAttentionReason:'verification_failed'}).where(eq(orgAutopayEnrollments.id,enrollment.id));
   await db.update(autopaySetupAttempts).set({outcome:'failed'}).where(eq(autopaySetupAttempts.id,attempt.id));
   runAfterDbContextExit('autopay.verificationFailed',async()=>{
    const [committed]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attempt.id)).limit(1));
    if(committed?.outcome==='failed')await notifyAutopayStaff({orgId:attempt.orgId,partnerId:attempt.partnerId,event:'autopay.needs_attention',
     dedupeKey:`${attempt.id}:verification_failed`,message:'Automatic payments need a verified payment method.'});
   });
   return {outcome,orgId:attempt.orgId};
  }
  if(method.type!==attempt.methodType)throw new Error('Stripe returned the wrong method type');
  const snapshot=attempt.consentSnapshot as AutopayDisclosure&{contactEmail:string;ip:string|null;userAgent:string|null;source:'setup_page'|'pay_and_save'|'portal'};
  const [existing]=await db.select().from(orgPaymentMethods).where(and(eq(orgPaymentMethods.orgId,attempt.orgId),
   eq(orgPaymentMethods.stripePaymentMethodId,method.id))).limit(1);
  const replaced=await db.update(orgPaymentMethods).set({isAutopayMethod:false,status:'removed',removedAt:new Date()})
   .where(and(eq(orgPaymentMethods.orgId,attempt.orgId),eq(orgPaymentMethods.isAutopayMethod,true),inArray(orgPaymentMethods.status,['active','pending_verification']))).returning();
  const values={orgId:attempt.orgId,enrollmentId:enrollment.id,stripePaymentMethodId:method.id,type:method.type as 'card'|'us_bank_account',
   cardBrand:method.card?.brand??null,cardLast4:method.card?.last4??null,cardExpMonth:method.card?.exp_month??null,cardExpYear:method.card?.exp_year??null,
   cardFunding:method.card?(['credit','debit','prepaid'].includes(method.card.funding)?method.card.funding:'unknown'):null,cardCountry:method.card?.country??null,bankName:method.us_bank_account?.bank_name??null,
   bankLast4:method.us_bank_account?.last4??null,accountHolderType:method.us_bank_account?.account_holder_type??null,
   stripeMandateId:mandateId,stripeSetupIntentId:setupIntentId,status:outcome==='activated'?'active' as const:'pending_verification' as const,
   isAutopayMethod:true,removedAt:null,unusableReason:null};
  const [saved]=existing?await db.update(orgPaymentMethods).set(values).where(eq(orgPaymentMethods.id,existing.id)).returning():
   await db.insert(orgPaymentMethods).values(values).returning();
  const [consent]=await db.select({id:orgAutopayConsents.id}).from(orgAutopayConsents).where(and(eq(orgAutopayConsents.enrollmentId,enrollment.id),
   eq(orgAutopayConsents.generation,attempt.generation),eq(orgAutopayConsents.paymentMethodId,saved!.id),eq(orgAutopayConsents.consentTextHash,snapshot.textHash))).limit(1);
  if(!consent)await db.insert(orgAutopayConsents).values({orgId:attempt.orgId,enrollmentId:enrollment.id,generation:attempt.generation,paymentMethodId:saved!.id,
   consentTextVersion:snapshot.version,consentTextHash:snapshot.textHash,feeTerms:snapshot.feeTerms,scheduleTerms:snapshot.scheduleTerms,
   contactEmail:snapshot.contactEmail,ip:snapshot.ip,userAgent:snapshot.userAgent,source:snapshot.source});
  await db.update(orgAutopayEnrollments).set({status:'active',effectiveFrom:outcome==='activated'?enrollment.effectiveFrom??new Date():enrollment.effectiveFrom,
   needsAttentionReason:null}).where(eq(orgAutopayEnrollments.id,enrollment.id));
  await db.update(autopaySetupAttempts).set({outcome,completedAt:outcome==='activated'?new Date():null,setupIntentId}).where(eq(autopaySetupAttempts.id,attempt.id));
  if(attempt.tokenId)await db.update(billingLinkTokens).set({consumedAt:new Date()}).where(eq(billingLinkTokens.id,attempt.tokenId));
  const stop=await mintBillingLinkToken(db,{orgId:attempt.orgId,purpose:'stop_autopay',enrollmentId:enrollment.id,generation:enrollment.generation,ttlDays:365});
  const methodDescription=method.card?`${method.card.brand} ${method.card.funding} ••${method.card.last4}`:`${method.us_bank_account?.bank_name??'Bank'} ••${method.us_bank_account?.last4??''}`;
  const paymentMethod=methodDescription+(outcome==='pending_verification'?' (bank verification pending; no automatic payments yet)':'');
  await enqueueBillingNotice(db,{orgId:attempt.orgId,partnerId:attempt.partnerId,enrollmentId:enrollment.id,kind:'autopay_enrolled',seq:attempt.generation,
   dedupeKey:`${attempt.id}:autopay_enrolled:${outcome}`,toEmail:snapshot.contactEmail,
   rendered:await renderBillingNotice('autopay_enrolled',{autopay:{partnerId:attempt.partnerId,orgId:attempt.orgId,
    vars:{client_name:snapshot.contactEmail,payment_method:paymentMethod,schedule_text:snapshot.scheduleText,fee_text:snapshot.feeText},
    scheduleText:snapshot.scheduleText,feeText:snapshot.feeText,stopUrl:buildBillingLinkUrl('stop_autopay',stop.token),authorizationReference:snapshot.version}})});
  for(const old of replaced)if(old.id!==saved!.id)runAfterDbContextExit('autopay.detachReplaced',()=>detachPaymentMethodPostCommit(attempt.partnerId,old.id));
  runAfterDbContextExit('autopay.enrolled',async()=>{
   const [committed]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attempt.id)).limit(1));
   if(committed?.outcome===outcome)await notifyAutopayStaff({orgId:attempt.orgId,partnerId:attempt.partnerId,event:'autopay.enrolled',
    dedupeKey:`${attempt.id}:enrolled:${outcome}`,message:`Automatic payments ${outcome==='activated'?'enabled':'await bank verification'}.`});
  });
  return {outcome,orgId:attempt.orgId};
 });
}
export async function completeAutopaySetup(partnerId:string,ref:{checkoutSessionId?:string;setupIntentId?:string}):Promise<{outcome:Outcome;orgId:string}>{
 assertNoHeldDbContextForStripe('completeAutopaySetup');
 if(Boolean(ref.checkoutSessionId)===Boolean(ref.setupIntentId))throw new Error('Supply exactly one setup reference');
 const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(partnerId));
 let setupIntentId=ref.setupIntentId;
 if(ref.checkoutSessionId){
  const session=await runOutsideDbContext(()=>stripe.checkout.sessions.retrieve(ref.checkoutSessionId!));
  if(session.mode!=='setup')throw new Error('Expected setup Checkout');
  setupIntentId=id(session.setup_intent)??undefined;
 }
 if(!setupIntentId)throw new Error('Setup is not complete');
 const intent=await runOutsideDbContext(()=>stripe.setupIntents.retrieve(setupIntentId!));
 const [attempt]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(and(
  eq(autopaySetupAttempts.id,intent.metadata.setup_attempt_id??''),eq(autopaySetupAttempts.partnerId,partnerId),eq(autopaySetupAttempts.stripeAccountId,stripeAccountId))).limit(1));
 if(!attempt||attempt.orgId!==intent.metadata.org_id||attempt.enrollmentId!==intent.metadata.enrollment_id||String(attempt.generation)!==intent.metadata.generation||
  (attempt.tokenId??'')!==(intent.metadata.token_id??'')||attempt.stripeCustomerId!==id(intent.customer))throw new Error('Setup binding mismatch');
 const methodId=id(intent.payment_method);
 if(!methodId)return persistCapturedAutopayMethod(attempt.id,{id:'',customer:attempt.stripeCustomerId,type:attempt.methodType} as Stripe.PaymentMethod,'failed',intent.id,null);
 const method=await runOutsideDbContext(()=>stripe.paymentMethods.retrieve(methodId));
 const mandateId=id(intent.mandate);
 if(method.type==='us_bank_account'&&intent.status==='succeeded'){
  if(!mandateId)throw new Error('Verified bank setup has no mandate');
  const mandate=await runOutsideDbContext(()=>stripe.mandates.retrieve(mandateId));
  if(mandate.status!=='active'||id(mandate.payment_method)!==method.id)throw new Error('Bank mandate is not active');
 }
 return persistCapturedAutopayMethod(attempt.id,method,setupIntentOutcome(intent),intent.id,mandateId);
}
```
Add to `enrollmentService.ts`:
```ts
export {completeAutopaySetup} from './setupCompletion';
```
The account and Customer checks are independent of redirect input. Both the return path and poller load Stripe objects themselves. A pending bank verification keeps `effectiveFrom` null on a first enrollment; the first usable method sets it. Replacing an existing usable method preserves the original boundary. The latest accepted attempt wins within a generation, ordered by a database sequence allocated after acquiring the enrollment lock; this prevents an older tab completing later from replacing a newer authorized method.

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/setupCompletion.test.ts`; `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/enrollmentService.integration.test.ts`, then from the root `pnpm test-stack down`.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/setupCompletion.ts apps/api/src/services/autopay/setupCompletion.test.ts apps/api/src/services/autopay/enrollmentService.integration.test.ts apps/api/src/services/autopay/enrollmentService.ts` then `git commit -m "feat(billing): complete setup with durable consent and generation fencing"`.

### Task 8: Save an explicitly authorized card only after the invoice payment is booked
**Files:** Create `apps/api/src/services/autopay/payAndSave.ts`, `apps/api/src/services/autopay/payAndSave.test.ts`; Modify `apps/api/src/services/invoiceCheckout.ts`, `apps/api/src/services/stripeSettle.ts`, `apps/api/src/routes/invoicesPublic.ts`, `apps/api/src/routes/portal/invoices.ts`, `apps/api/src/services/invoiceCheckout.test.ts`, `apps/api/src/routes/invoicesPublic.test.ts`, `apps/api/src/routes/portal/invoices.test.ts`.
**Interfaces:** Consumes `prepareAutopayCapture(input,'pay_and_save',invoiceId)` and `persistCapturedAutopayMethod`; preserves `createInvoicePayLink(invoiceId,actor,urls={})` while adding optional `saveForAutopay`/authorization fields to `InvoiceCheckoutUrls`. Produces `prepareCardPayAndSave`, `finishCardPayAndSave`, and `payAndSaveSchema`. Ordinary payment parameters and idempotency keys stay byte-identical.

- [ ] **Step 1: Write the failing test** — `payAndSave.test.ts`:
```ts
import {describe,expect,it,vi} from 'vitest';
import {payAndSaveSchema,cardSaveStripeFields} from './payAndSave';
describe('pay-and-save request',()=>{
 it('defaults to an ordinary payment and refuses implicit authorization',()=>{
  expect(payAndSaveSchema.parse({})).toEqual({saveForAutopay:false});
  expect(payAndSaveSchema.safeParse({saveForAutopay:true}).success).toBe(false);
  expect(payAndSaveSchema.safeParse({saveForAutopay:true,consentAccepted:false,disclosureHash:'a'.repeat(64)}).success).toBe(false);
 });
 it('adds only customer and off-session card authority',()=>{
  expect(cardSaveStripeFields(null)).toEqual({});
  expect(cardSaveStripeFields({id:'attempt',stripeCustomerId:'cus_one'})).toEqual({customer:'cus_one',
   payment_intent_data:{setup_future_usage:'off_session',metadata:{autopay_setup_attempt_id:'attempt'}}});
 });
});
```
Extend `invoiceCheckout.test.ts` before changing the producer. Its existing `dbResults`, `sessionsCreateMock`, `getPartnerStripeClientMock`, `partnerClient`, `INV_ID`, `ORG_ID`, `actor`, and `expectedIdempotencyKey` are verified fixtures. Add this hoisted boundary stub and preserve its default null result for all ordinary-payment tests:

```ts
const { prepareSaveMock } = vi.hoisted(() => ({ prepareSaveMock: vi.fn(async (
  _invoiceId: string, _orgId: string, _input: { saveForAutopay?: boolean }, _checkoutKey: string,
): Promise<{ id: string; stripeCustomerId: string } | null> => null) }));
vi.mock('./autopay/payAndSave', async importOriginal => {
  const actual = await importOriginal<typeof import('./autopay/payAndSave')>();
  return { ...actual, prepareCardPayAndSave: prepareSaveMock };
});
```

Add `'update'` and `'set'` to the existing Drizzle `makeChain` method loop so the post-Checkout attempt binding has the exact source chain. Add `prepareSaveMock.mockResolvedValue(null);` to the existing `beforeEach`, then add this test in the existing `createInvoicePayLink` describe block:

```ts
it('checked card payments retain card-only Checkout and a stable save-enabled retry family', async () => {
  const captureId = '33333333-3333-4333-8333-333333333333';
  prepareSaveMock.mockResolvedValue({ id: captureId, stripeCustomerId: 'cus_saved' });
  getPartnerStripeClientMock.mockResolvedValue(partnerClient());
  sessionsCreateMock.mockResolvedValue({ id: 'cs_saved', url: 'https://checkout.stripe.com/c/cs_saved', payment_intent: 'pi_saved' });
  for (let replay = 0; replay < 2; replay++) {
    dbResults.push([{ id: INV_ID, orgId: ORG_ID, partnerId: actor.partnerId, status: 'sent',
      balance: '100.00', depositDue: null, amountPaid: '0.00', currencyCode: 'USD', invoiceNumber: 'INV-SAVE' }],
      [{ id: '44444444-4444-4444-8444-444444444444' }], []);
    await createInvoicePayLink(INV_ID, actor, {
      saveForAutopay: true, consentAccepted: true, disclosureHash: 'a'.repeat(64),
    });
  }
  expect(sessionsCreateMock).toHaveBeenCalledTimes(2);
  for (const [params, options] of sessionsCreateMock.mock.calls) {
    expect(params).toMatchObject({ mode: 'payment', payment_method_types: ['card'], customer: 'cus_saved',
      metadata: { autopay_setup_attempt_id: captureId },
      payment_intent_data: { setup_future_usage: 'off_session', metadata: { autopay_setup_attempt_id: captureId } } });
    expect(options.idempotencyKey).toBe(expectedIdempotencyKey(`inv_${INV_ID}_10000_bal_save_${captureId}`));
  }
  expect(prepareSaveMock.mock.calls[0]?.[3]).toBe(prepareSaveMock.mock.calls[1]?.[3]);
});
```

In `routes/invoicesPublic.test.ts`, preserve the verified GET query queues by mocking only the new projection. Keep the real validation schema:

```ts
vi.mock('../services/autopay/payAndSave', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/autopay/payAndSave')>();
  return { ...actual, getInvoiceAutopayOffer: vi.fn(async () => null) };
});
it('public invoice pay forwards only explicit card authorization', async () => {
  resolveMock.mockResolvedValue(invoice()); payLinkMock.mockResolvedValue({ url: 'https://checkout.stripe.com/c/cs_saved' });
  const res = await app().request(`/invoices/public/${TOKEN}/pay`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ saveForAutopay: true, consentAccepted: true, disclosureHash: 'a'.repeat(64) }) });
  expect(res.status).toBe(200);
  expect(payLinkMock).toHaveBeenCalledWith(INV_ID, expect.anything(), expect.objectContaining({
    saveForAutopay: true, consentAccepted: true, disclosureHash: 'a'.repeat(64),
  }));
});
it('public invoice pay refuses an unaccepted save request before Checkout', async () => {
  resolveMock.mockResolvedValue(invoice());
  const res = await app().request(`/invoices/public/${TOKEN}/pay`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ saveForAutopay: true }) });
  expect(res.status).toBe(400); expect(payLinkMock).not.toHaveBeenCalled();
});
```

In `routes/portal/invoices.test.ts`, add the following hoisted module stub to preserve the existing GET and ordinary Checkout fixtures, then append the test inside its existing describe block. Stripe itself stays mocked at that file's `getPartnerStripeClient` boundary:

```ts
vi.mock('../../services/autopay/payAndSave', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/autopay/payAndSave')>();
  return { ...actual, getInvoiceAutopayOffer: vi.fn(async () => null),
    prepareCardPayAndSave: vi.fn(async (_invoiceId: string, _orgId: string, input: { saveForAutopay?: boolean }) => {
      if (input.saveForAutopay) throw new Error('Unexpected accepted save in ordinary-payment fixture');
      return null;
    }) };
});
it('portal invoice pay rejects missing authorization before Stripe', async () => {
  const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ saveForAutopay: true }) });
  expect(res.status).toBe(400); expect(sessionsCreateMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/payAndSave.test.ts src/services/invoiceCheckout.test.ts src/routes/invoicesPublic.test.ts src/routes/portal/invoices.test.ts`; the missing module or missing explicit-authorization behavior fails.
- [ ] **Step 3: Implement** — `payAndSave.ts`:
```ts
import {z} from 'zod';
import {and,eq,isNotNull} from 'drizzle-orm';
import type Stripe from 'stripe';
import {db,withSystemDbAccessContext,runOutsideDbContext} from '../../db';
import {organizations,orgAutopayEnrollments,invoiceStripePayments,invoices} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getPartnerStripeClient} from '../partnerStripe';
import {InvoiceServiceError} from '../invoiceTypes';
import {assertNoHeldDbContextForStripe} from '../stripeSettle';
import {prepareAutopayCapture} from './setupSession';
import {persistCapturedAutopayMethod} from './setupCompletion';
import {withAcceptedAutopayDisclosure,buildAutopayDisclosure} from './consentText';
import {isAutopayEnabledForPartner} from './autopayGate';
export const payAndSaveSchema=z.object({saveForAutopay:z.boolean().default(false),consentAccepted:z.literal(true).optional(),
 disclosureHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).superRefine((value,ctx)=>{
 if(value.saveForAutopay&&(value.consentAccepted!==true||!value.disclosureHash))
  ctx.addIssue({code:'custom',message:'Explicit authorization is required',path:['consentAccepted']});
});
export type CardSaveInput={saveForAutopay?:boolean;consentAccepted?:true;disclosureHash?:string;ip?:string|null;userAgent?:string|null;contactEmail?:string};
export function cardSaveStripeFields(attempt:{id:string;stripeCustomerId:string|null}|null):Pick<Stripe.Checkout.SessionCreateParams,'customer'|'payment_intent_data'>{
 if(!attempt)return {};
 if(!attempt.stripeCustomerId)throw new Error('Autopay Customer missing');
 return {customer:attempt.stripeCustomerId,payment_intent_data:{setup_future_usage:'off_session',metadata:{autopay_setup_attempt_id:attempt.id}}};
}
export async function prepareCardPayAndSave(invoiceId:string,orgId:string,input:CardSaveInput,checkoutKey:string){
 if(!input.saveForAutopay)return null;
 if(input.consentAccepted!==true||!input.disclosureHash)throw new InvoiceServiceError('Authorize automatic payments first',400,'INVALID_STATE');
 const [org]=await withSystemDbAccessContext(()=>db.select().from(organizations).where(eq(organizations.id,orgId)).limit(1));
 const email=input.contactEmail??(org?.billingContact as {email?:string}|null)?.email;
 if(!email)throw new InvoiceServiceError('A billing contact is required',409,'INVALID_STATE');
 return withAcceptedAutopayDisclosure(input.disclosureHash,()=>prepareAutopayCapture({orgId,methodType:'card',consentAccepted:true,
  returnTo:'portal',contactEmail:email,ip:input.ip??null,userAgent:input.userAgent??null},'pay_and_save',invoiceId,checkoutKey));
}
export async function getInvoiceAutopayOffer(orgId:string):Promise<{eligible:boolean;consentText:string;consentVersion:string;disclosureHash:string}|null>{
 return withSystemDbAccessContext(async()=>{
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1);
  if(!enrollment||!['requested','active'].includes(enrollment.status)||!await isAutopayEnabledForPartner(db,enrollment.partnerId))return null;
  const disclosure=await buildAutopayDisclosure(db,orgId,'card');
  if(disclosure.achMode==='ach_only')return null;
  return {eligible:true,consentText:disclosure.text,consentVersion:disclosure.version,disclosureHash:disclosure.hash};
 });
}
export async function finishCardPayAndSave(partnerId:string,checkoutSessionId:string):Promise<void>{
 assertNoHeldDbContextForStripe('finishCardPayAndSave');
 const [mapping]=await withSystemDbAccessContext(()=>db.select({mapping:invoiceStripePayments,invoice:invoices}).from(invoiceStripePayments)
  .innerJoin(invoices,eq(invoices.id,invoiceStripePayments.invoiceId)).where(and(eq(invoiceStripePayments.stripeObjectId,checkoutSessionId),
   eq(invoices.partnerId,partnerId),isNotNull(invoiceStripePayments.invoicePaymentId))).limit(1));
 if(!mapping)return;
 const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(partnerId));
 if(stripeAccountId!==mapping.mapping.stripeAccountId)throw new Error('Stripe account changed');
 const session=await runOutsideDbContext(()=>stripe.checkout.sessions.retrieve(checkoutSessionId));
 if(session.mode!=='payment'||session.payment_status!=='paid')return;
 const piId=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
 if(!piId)return;
 const intent=await runOutsideDbContext(()=>stripe.paymentIntents.retrieve(piId));
 const attemptId=intent.metadata.autopay_setup_attempt_id;
 if(!attemptId)return;
 const [attempt]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(and(eq(autopaySetupAttempts.id,attemptId),
  eq(autopaySetupAttempts.partnerId,partnerId),eq(autopaySetupAttempts.orgId,mapping.invoice.orgId),
  eq(autopaySetupAttempts.stripeAccountId,stripeAccountId),eq(autopaySetupAttempts.source,'pay_and_save'))).limit(1));
 if(!attempt||(attempt.consentSnapshot as {invoiceId?:string}).invoiceId!==mapping.invoice.id||intent.setup_future_usage!=='off_session'||intent.status!=='succeeded')return;
 const customer=typeof intent.customer==='string'?intent.customer:intent.customer?.id;
 if(customer!==attempt.stripeCustomerId)throw new Error('Pay-and-save Customer mismatch');
 const methodId=typeof intent.payment_method==='string'?intent.payment_method:intent.payment_method?.id;
 if(!methodId)throw new Error('Paid card has no payment method');
 const method=await runOutsideDbContext(()=>stripe.paymentMethods.retrieve(methodId));
 if(method.type!=='card')throw new Error('Pay-and-save must remain card-only');
 await persistCapturedAutopayMethod(attempt.id,method,'activated',null,null);
}
```
In `InvoiceCheckoutUrls` (`invoiceCheckout.ts`) add these fields:
```ts
saveForAutopay?:boolean;
consentAccepted?:true;
disclosureHash?:string;
ip?:string|null;
userAgent?:string|null;
```
Add imports and insert after `chargeMinor > 0` validation, before reading the Stripe client:
```ts
import {prepareCardPayAndSave,cardSaveStripeFields} from './autopay/payAndSave';
const {expiresAt,quantum}=checkoutSessionExpiry();
const capture=await prepareCardPayAndSave(inv.id,inv.orgId,urls,`inv_${inv.id}_${chargeMinor}_${chargeNow.isDeposit?'dep':'bal'}${urls.idempotencySuffix??''}_e${quantum}`);
```
Move the existing `checkoutSessionExpiry()` declaration to this location; remove its later duplicate so the same expiry/quantum is used for capture and Checkout. Inside the existing metadata object add `...(capture?{autopay_setup_attempt_id:capture.id}:{}),` so recovery can discover a session whose response was lost. Inside the existing `stripe.checkout.sessions.create` object, immediately following `payment_method_types:['card']`, add:
```ts
...cardSaveStripeFields(capture),
```
Extend only the save-enabled idempotency family. Replace the existing `idempotencyKey` expression with:
```ts
idempotencyKey:`inv_${inv.id}_${chargeMinor}_${chargeNow.isDeposit?'dep':'bal'}${urls.idempotencySuffix??''}${capture?`_save_${capture.id}`:''}_e${quantum}`,
```
After the existing mapping INSERT commits and before returning the URL, bind the attempt:
```ts
if(capture)await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({checkoutSessionId:session.id,
 paymentIntentId:typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id??null}).where(eq(autopaySetupAttempts.id,capture.id)));
```
Import `autopaySetupAttempts` from `../db/schema/autopaySetupAttempts`. Keep all W1 reservation and SEC-150 revocation code at its original position.

In `invoicesPublic.ts`, import `getTrustedClientIpOrUndefined` from `../services/clientIp` and add `payAndSaveSchema` import from `../services/autopay/payAndSave`; validate a JSON body after the existing content-type check:
```ts
const parsed=payAndSaveSchema.safeParse(await c.req.json().catch(()=>({})));
if(!parsed.success)return c.json({error:'Invalid automatic-payment authorization'},400);
```
Add to the existing `createInvoicePayLink` options object:
```ts
...parsed.data,ip:getTrustedClientIpOrUndefined(c)??null,userAgent:c.req.header('user-agent')??null,
```
The existing trusted-client-IP helper determines whether proxy headers are trustworthy; persist null when it cannot identify a trusted address.

In `routes/portal/invoices.ts`, preserve the existing card Checkout producer. Import `getTrustedClientIpOrUndefined` from `../../services/clientIp`. Import `payAndSaveSchema`, `prepareCardPayAndSave`, `cardSaveStripeFields` from `../../services/autopay/payAndSave` and `autopaySetupAttempts` from `../../db/schema/autopaySetupAttempts`. Validate the JSON body immediately after reading `portalAuth`, then create the capture after `chargeMinor` is validated. Move the existing expiry declaration here and remove its later duplicate:
```ts
const parsed=payAndSaveSchema.safeParse(await c.req.json().catch(()=>({})));
if(!parsed.success)return c.json({error:'Invalid automatic-payment authorization'},400);
const {expiresAt:providerExpiresAtEpoch,quantum:expiryQuantum}=checkoutSessionExpiry();
const capture=await prepareCardPayAndSave(inv.id,auth.user.orgId,{...parsed.data,contactEmail:auth.user.email,ip:getTrustedClientIpOrUndefined(c)??null,userAgent:c.req.header('user-agent')??null},
 `inv_${inv.id}_${chargeMinor}_${chargeNow.isDeposit?'dep':'bal'}_e${expiryQuantum}`);
```
Add `...(capture?{autopay_setup_attempt_id:capture.id}:{}),` to its metadata and `...cardSaveStripeFields(capture),` after its unchanged `payment_method_types:['card']`; replace its idempotency expression with:
```ts
idempotencyKey:`inv_${inv.id}_${chargeMinor}_${chargeNow.isDeposit?'dep':'bal'}${capture?`_save_${capture.id}`:''}_e${expiryQuantum}`,
```
After its existing mapping transaction commits, insert the same attempt binding:
```ts
if(capture)await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({checkoutSessionId:session.id,
 paymentIntentId:typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id??null}).where(eq(autopaySetupAttempts.id,capture.id)));
```
Add `getInvoiceAutopayOffer` to each route's pay-and-save import. In the public GET `/:token`'s existing projected return object, after `payable`, insert:
```ts
autopay:await getInvoiceAutopayOffer(inv.orgId),
```
In the portal GET `/invoices/:id`'s response object, after `lines`, insert:
```ts
autopay:await getInvoiceAutopayOffer(auth.user.orgId),
```
These are the existing `invoicesPublicRoutes` (`routes/invoicesPublic.ts`) and `invoiceRoutes` (`routes/portal/invoices.ts`) customer-safe detail projections. Both resolve and authorize their invoice before exposing the offer; never accept an organization id from the browser to obtain this projection.

Finally import `finishCardPayAndSave` into `stripeSettle.ts` and call it *after* awaited `recordStripePayment`, before the existing return:
```ts
await finishCardPayAndSave(partnerId,session.id);
```
The helper verifies `invoicePaymentId` exists: `recordStripePayment` also returns an invoice id on a refused/terminal result, so its return alone cannot authorize saving a card. The payment remains booked if saving fails. Task 9 retries the unfinished capture, including mappings already settled, so a brief consent-write failure does not require a second payment.

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/payAndSave.test.ts src/services/invoiceCheckout.test.ts src/routes/invoicesPublic.test.ts src/routes/portal/invoices.test.ts src/services/stripeCheckoutCallSites.test.ts`; existing ordinary-payment assertions must stay byte-identical.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/payAndSave.ts apps/api/src/services/autopay/payAndSave.test.ts apps/api/src/services/invoiceCheckout.ts apps/api/src/services/stripeSettle.ts apps/api/src/routes/invoicesPublic.ts apps/api/src/routes/portal/invoices.ts apps/api/src/services/invoiceCheckout.test.ts apps/api/src/routes/invoicesPublic.test.ts apps/api/src/routes/portal/invoices.test.ts` then `git commit -m "feat(billing): save authorized cards after successful invoice settlement"`.

### Task 9: Recover abandoned returns and replay enrollment events durably
**Files:** Create `apps/api/src/services/autopay/setupReconciliation.ts`, `apps/api/src/services/autopay/setupReconciliation.test.ts`; Modify `apps/api/src/jobs/stripeReconcileSweep.ts`, `apps/api/src/services/stripeFinancialEventPoller.ts`, `apps/api/src/services/stripeReversalState.ts`.
**Interfaces:** Consumes `completeAutopaySetup`, `finishCardPayAndSave`, `markPaymentMethodUnusable`, `detachPaymentMethodPostCommit`; produces private `reconcileAutopaySetups`, `ingestAutopayStripeEvent`, `replayAutopayStripeEvents`. C5 stays one existing Stripe sweep, with no new setup queue.

The existing `stripeFinancialEvents` row contains the provider event id and account binding but only financial projections (`stripePayments.ts`); `ingestStripeFinancialEvent` rejects events without a PaymentIntent (`stripeReversalState.ts`). Enrollment uses a distinct ingestion branch in that same durable inbox and retrieves the event by id when replaying. `currency='XXX'` is the ISO no-currency sentinel on these non-monetary events. Never invent a PaymentIntent id or pass enrollment events into the monetary reducer.

- [ ] **Step 1: Write the failing test** — `setupReconciliation.test.ts`:
```ts
import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({rows:[] as unknown[][],updates:[] as Record<string,unknown>[],client:vi.fn(),event:vi.fn(),mandate:vi.fn(),unusable:vi.fn(),notify:vi.fn()}));
vi.mock('../../db',()=>{
 const chain=()=>{const c:any={};for(const name of ['from','innerJoin','where','limit','orderBy','returning'])c[name]=()=>c;
  c.set=(value:Record<string,unknown>)=>{m.updates.push(value);return c;};
  c.then=(resolve:any)=>Promise.resolve(m.rows.shift()??[]).then(resolve);return c;};
 return {db:{select:chain,update:chain},withSystemDbAccessContext:(fn:any)=>fn(),runOutsideDbContext:(fn:any)=>fn(),hasDbAccessContext:()=>false};
});
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:m.client}));
vi.mock('./paymentMethods',()=>({markPaymentMethodUnusable:m.unusable,detachPaymentMethodPostCommit:vi.fn()}));
vi.mock('./staffNotifications',()=>({notifyAutopayStaff:m.notify}));
vi.mock('./setupCompletion',()=>({completeAutopaySetup:vi.fn()}));
vi.mock('./payAndSave',()=>({finishCardPayAndSave:vi.fn()}));
import {AUTOPAY_STRIPE_EVENT_TYPES,isAutopayStripeEvent,replayAutopayStripeEvents} from './setupReconciliation';
const partnerId='11111111-1111-4111-8111-111111111111';
const orgId='22222222-2222-4222-8222-222222222222';
beforeEach(()=>{vi.clearAllMocks();m.rows.length=0;m.updates.length=0;
 m.client.mockResolvedValue({stripeAccountId:'acct_one',stripe:{events:{retrieve:m.event},mandates:{retrieve:m.mandate}}});});
describe('enrollment event dispatch',()=>{
 it('has exactly W2 events and does not steal money events',()=>{
  expect(AUTOPAY_STRIPE_EVENT_TYPES).toEqual(['setup_intent.succeeded','setup_intent.setup_failed','mandate.updated','payment_method.detached']);
  for(const type of AUTOPAY_STRIPE_EVENT_TYPES)expect(isAutopayStripeEvent(type)).toBe(true);
  expect(isAutopayStripeEvent('charge.refunded')).toBe(false);expect(isAutopayStripeEvent('payment_intent.succeeded')).toBe(false);
 });
 it.each(['payment_method.detached','mandate.updated'])('replays %s against the bound account before marking applied',async type=>{
  m.rows.push([{id:'inbox',stripeEventId:'evt_one',partnerId,stripeAccountId:'acct_one',eventType:type,livemode:false,attemptCount:0}],
   [{id:'method',orgId}],[]);
  m.event.mockResolvedValue({id:'evt_one',type,livemode:false,data:{object:{id:type==='mandate.updated'?'mandate_one':'pm_one'}}});
  m.mandate.mockResolvedValue({id:'mandate_one',status:'inactive',payment_method:'pm_one'});
  expect(await replayAutopayStripeEvents()).toBe(1);
  expect(m.event).toHaveBeenCalledWith('evt_one');
  expect(m.unusable).toHaveBeenCalledWith(expect.anything(),'method',type);
  expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({event:'autopay.needs_attention',orgId,partnerId}));
  expect(m.updates).toContainEqual(expect.objectContaining({status:'applied'}));
 });
 it('never processes an old event using a replacement account',async()=>{
  m.rows.push([{id:'inbox',stripeEventId:'evt_one',partnerId,stripeAccountId:'acct_old',eventType:'payment_method.detached',livemode:false,attemptCount:0}],[]);
  expect(await replayAutopayStripeEvents()).toBe(0);
  expect(m.event).not.toHaveBeenCalled();expect(m.unusable).not.toHaveBeenCalled();
  expect(m.updates).toContainEqual(expect.objectContaining({attemptCount:1}));
  expect(m.updates.some(row=>row.status==='applied')).toBe(false);
 });
});
```
- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/setupReconciliation.test.ts`; missing module.
- [ ] **Step 3: Implement** — `setupReconciliation.ts`:
```ts
import type Stripe from 'stripe';
import {createHash} from 'node:crypto';
import {and,asc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {db,withSystemDbAccessContext,runOutsideDbContext} from '../../db';
import {stripeConnectAccounts,stripeFinancialEvents,orgPaymentMethods,orgAutopayEnrollments} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getPartnerStripeClient} from '../partnerStripe';
import {assertNoHeldDbContextForStripe,HeldDbContextForStripeError} from '../stripeSettle';
import {completeAutopaySetup} from './setupCompletion';
import {finishCardPayAndSave} from './payAndSave';
import {markPaymentMethodUnusable,detachPaymentMethodPostCommit} from './paymentMethods';
import {notifyAutopayStaff} from './staffNotifications';
export const AUTOPAY_STRIPE_EVENT_TYPES=['setup_intent.succeeded','setup_intent.setup_failed','mandate.updated','payment_method.detached'] as const;
export function isAutopayStripeEvent(type:string):boolean{return (AUTOPAY_STRIPE_EVENT_TYPES as readonly string[]).includes(type);}
export async function ingestAutopayStripeEvent(partnerId:string,stripeAccountId:string,event:Stripe.Event):Promise<void>{
 if(!isAutopayStripeEvent(event.type))throw new Error('Unexpected autopay event');
 const [connection]=await withSystemDbAccessContext(()=>db.select().from(stripeConnectAccounts).where(and(eq(stripeConnectAccounts.partnerId,partnerId),eq(stripeConnectAccounts.stripeAccountId,stripeAccountId))).limit(1));
 if(!connection||event.account&&event.account!==stripeAccountId||event.livemode!==connection.livemode)throw new Error('Autopay event account mismatch');
 const digest=createHash('sha256').update(JSON.stringify({id:event.id,type:event.type,account:stripeAccountId,object:event.data.object})).digest('hex');
 await withSystemDbAccessContext(()=>db.insert(stripeFinancialEvents).values({partnerId,stripeConnectionId:connection.id,stripeAccountId,
  stripeEventId:event.id,eventType:event.type,livemode:event.livemode,providerCreated:event.created,paymentIntentId:null,currency:'XXX',payloadDigest:digest}).onConflictDoNothing());
 const [stored]=await withSystemDbAccessContext(()=>db.select().from(stripeFinancialEvents).where(eq(stripeFinancialEvents.stripeEventId,event.id)).limit(1));
 if(!stored||stored.partnerId!==partnerId||stored.stripeAccountId!==stripeAccountId||stored.payloadDigest!==digest)throw new Error('Autopay event identity conflict');
}
export async function replayAutopayStripeEvents():Promise<number>{
 assertNoHeldDbContextForStripe('replayAutopayStripeEvents');
 const rows=await withSystemDbAccessContext(()=>db.select().from(stripeFinancialEvents).where(and(eq(stripeFinancialEvents.status,'pending'),
  inArray(stripeFinancialEvents.eventType,[...AUTOPAY_STRIPE_EVENT_TYPES]))).orderBy(asc(stripeFinancialEvents.providerCreated)).limit(200));
 let applied=0;
 for(const row of rows){
  try{
   const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(row.partnerId));
   if(stripeAccountId!==row.stripeAccountId)throw new Error('Stripe event account changed');
   const event=await runOutsideDbContext(()=>stripe.events.retrieve(row.stripeEventId));
   if(event.type!==row.eventType||event.livemode!==row.livemode||event.account&&event.account!==row.stripeAccountId)throw new Error('Stripe replay identity mismatch');
   const object=event.data.object as {id:string;payment_method?:string|{id:string};status?:string};
   if(event.type.startsWith('setup_intent.')){
    const [known]=await withSystemDbAccessContext(()=>db.select({id:autopaySetupAttempts.id}).from(autopaySetupAttempts)
     .where(and(eq(autopaySetupAttempts.partnerId,row.partnerId),eq(autopaySetupAttempts.id,(event.data.object as Stripe.SetupIntent).metadata.setup_attempt_id??'00000000-0000-0000-0000-000000000000'))).limit(1));
    if(known)await completeAutopaySetup(row.partnerId,{setupIntentId:object.id});
   }else{
    let methodId:string|null=null;
    if(event.type==='payment_method.detached')methodId=object.id;
    else{
     const mandate=await runOutsideDbContext(()=>stripe.mandates.retrieve(object.id));
     if(mandate.status!=='active')methodId=typeof mandate.payment_method==='string'?mandate.payment_method:mandate.payment_method.id;
    }
    if(methodId){
     const methods=await withSystemDbAccessContext(()=>db.select({id:orgPaymentMethods.id,orgId:orgPaymentMethods.orgId}).from(orgPaymentMethods)
      .innerJoin(orgAutopayEnrollments,eq(orgAutopayEnrollments.id,orgPaymentMethods.enrollmentId)).where(and(eq(orgPaymentMethods.stripePaymentMethodId,methodId!),eq(orgPaymentMethods.isAutopayMethod,true),inArray(orgPaymentMethods.status,['active','pending_verification']),
       eq(orgAutopayEnrollments.partnerId,row.partnerId),eq(orgAutopayEnrollments.stripeAccountId,row.stripeAccountId))));
     for(const method of methods){
      await withSystemDbAccessContext(()=>markPaymentMethodUnusable(db,method.id,event.type));
      await notifyAutopayStaff({orgId:method.orgId,partnerId:row.partnerId,event:'autopay.needs_attention',dedupeKey:row.stripeEventId,
       message:'Automatic payments need a new payment method.'});
     }
    }
   }
   await withSystemDbAccessContext(()=>db.update(stripeFinancialEvents).set({status:'applied',processedAt:new Date(),lastError:null}).where(eq(stripeFinancialEvents.id,row.id)));
   applied++;
  }catch(error){
   if(error instanceof HeldDbContextForStripeError)throw error;
   await withSystemDbAccessContext(()=>db.update(stripeFinancialEvents).set({attemptCount:row.attemptCount+1,lastAttemptAt:new Date(),
    lastError:error instanceof Error?error.message:String(error)}).where(eq(stripeFinancialEvents.id,row.id)));
  }
 }
 return applied;
}
export async function reconcileAutopaySetups():Promise<number>{
 assertNoHeldDbContextForStripe('reconcileAutopaySetups');
 const attempts=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(and(isNull(autopaySetupAttempts.completedAt),
  sql`(${autopaySetupAttempts.createdAt}>now()-interval '24 hours' OR ${autopaySetupAttempts.outcome}='pending_verification' OR ${autopaySetupAttempts.source}='pay_and_save')`))
  .orderBy(asc(autopaySetupAttempts.createdAt)).limit(200));
 let completed=0;
 for(const attempt of attempts){
  try{
   let sessionId=attempt.checkoutSessionId;
   if(!sessionId&&attempt.stripeCustomerId){
    const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(attempt.partnerId));
    if(stripeAccountId!==attempt.stripeAccountId)throw new Error('Stripe setup account changed');
    let after:string|undefined;
    do{
     const page=await runOutsideDbContext(()=>stripe.checkout.sessions.list({customer:attempt.stripeCustomerId!,created:{gte:Math.floor(attempt.createdAt.getTime()/1000)-60},limit:100,...(after?{starting_after:after}:{})}));
     sessionId=page.data.find(session=>session.metadata?.setup_attempt_id===attempt.id||session.metadata?.autopay_setup_attempt_id===attempt.id)?.id??null;
     after=page.has_more?page.data.at(-1)?.id:undefined;
    }while(!sessionId&&after);
    if(sessionId)await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({checkoutSessionId:sessionId}).where(eq(autopaySetupAttempts.id,attempt.id)));
   }
   if(!sessionId)continue;
   if(attempt.source==='pay_and_save'){await finishCardPayAndSave(attempt.partnerId,sessionId);completed++;}
   else{
    const result=await completeAutopaySetup(attempt.partnerId,{checkoutSessionId:sessionId});
    if(result.outcome==='activated')completed++;
   }
  }catch(error){if(error instanceof HeldDbContextForStripeError)throw error;console.error('[autopay.setup-reconcile]',{attemptId:attempt.id,message:error instanceof Error?error.message:String(error)});}
 }
 const removed=await withSystemDbAccessContext(()=>db.select({id:orgPaymentMethods.id,partnerId:orgAutopayEnrollments.partnerId}).from(orgPaymentMethods)
  .innerJoin(orgAutopayEnrollments,eq(orgAutopayEnrollments.id,orgPaymentMethods.enrollmentId)).where(eq(orgPaymentMethods.status,'removed')));
 for(const method of removed){try{await detachPaymentMethodPostCommit(method.partnerId,method.id);}catch(error){console.error('[autopay.detach-retry]',{methodId:method.id,message:error instanceof Error?error.message:String(error)});}}
 return completed;
}
```
In `stripeFinancialEventPoller.ts` add imports and append the W2 types to `STRIPE_FINANCIAL_EVENT_TYPES`:
```ts
import {AUTOPAY_STRIPE_EVENT_TYPES,isAutopayStripeEvent,ingestAutopayStripeEvent,replayAutopayStripeEvents} from './autopay/setupReconciliation';
// Inside STRIPE_FINANCIAL_EVENT_TYPES:
...AUTOPAY_STRIPE_EVENT_TYPES,
```
Before `normalizeStripeFinancialEvent` inside the existing oldest-first loop:
```ts
if(isAutopayStripeEvent(event.type)){
 await ingestAutopayStripeEvent(partnerId,stripeAccountId,event);
 ingested++;
 continue;
}
```
Before `pollStripeFinancialEvents` returns, after monetary replay:
```ts
await replayAutopayStripeEvents();
```
In both pending-inbox selectors in `stripeReversalState.ts`, add this Drizzle predicate to their existing `and(...)` clause (import `like` from `drizzle-orm`):
```ts
like(stripeFinancialEvents.eventType,'charge.%'),
```
This retains every existing refund/dispute event, keeps the W2 non-monetary inbox out of the monetary reducer, and leaves W4 free to register its own PaymentIntent branch.

In `stripeReconcileSweep.ts` import `reconcileAutopaySetups` from `../services/autopay/setupReconciliation`. In the worker callback, immediately after `reconcilePendingStripePayments()` and before `pollStripeFinancialEvents()`:
```ts
const setups=await reconcileAutopaySetups();
```
Change its return to `{settled,setups,financialEvents}`. Call this from the worker callback, not after `reconcilePendingStripePayments`' early empty-list return: an account with no invoice mappings must still finish setup.
- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/setupReconciliation.test.ts src/services/stripeFinancialEventPoller.test.ts src/services/stripeReversalState`; then the real-DB completion test from Task 7. The Stripe lab must close the browser after success, leave microdeposits outstanding beyond 24 hours, detach a method directly in Stripe, and rotate a same-account key before replay.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/setupReconciliation.ts apps/api/src/services/autopay/setupReconciliation.test.ts apps/api/src/jobs/stripeReconcileSweep.ts apps/api/src/services/stripeFinancialEventPoller.ts apps/api/src/services/stripeReversalState.ts` then `git commit -m "feat(billing): reconcile setup captures and durable enrollment events"`.

### Task 10: MSP enrollment operations and read models (W2a)

**Files:** Create `apps/api/src/routes/autopay/index.ts`, `apps/api/src/routes/autopay/index.test.ts`, `apps/api/src/services/autopay/enrollmentViews.ts`; Modify `apps/api/src/middleware/selfManagedDbContextRoutes.ts`, `apps/api/src/services/autopay/autopayGate.ts`. Real-DB coverage is created in `apps/api/src/index.autopay.integration.test.ts` by Task 12.

**Interfaces:** Consumes C4 `requestAutopay(db,actor,{orgIds,recipientOverride?})`, `pauseAutopay(db,actor,orgId)`, `resumeAutopay(db,actor,orgId)`, `turnOffAutopay(db,actor,orgId)`, `getAutopayMethod(db,orgId)`, `requireAutopayEnabled()`; existing `InvoiceActor` in `services/invoiceTypes.ts` and `invoiceActorFrom` in `routes/invoices/invoices.ts`. Uses `runOutsideDbContext` + `withSystemDbAccessContext` for each authorized staff mutation; the C4 service receives that context-bound `db` without replacing its executor. Produces `autopayRoutes` and `listAutopayEnrollments(actor,orgId?)`. All route responses intentionally project only enrollment/method display fields; never return Stripe customer IDs, tokens, IPs or consent histories to this list.

- [ ] **Step 1: Write the failing test** — `index.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const h = vi.hoisted(() => ({ request: vi.fn(), pause: vi.fn(), resume: vi.fn(), off: vi.fn(), list: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' },401);
    c.set('auth',{ user:{ id:'11111111-1111-4111-8111-111111111111' },partnerId:'22222222-2222-4222-8222-222222222222',accessibleOrgIds:['33333333-3333-4333-8333-333333333333'] });
    return next();
  },
  requirePermission: () => async (c: any,next: any) => c.req.header('x-deny') ? c.json({error:'Forbidden'},403) : next(),
}));
vi.mock('../../db', () => ({ db: {},runOutsideDbContext:(fn:()=>unknown)=>fn(),
  withSystemDbAccessContext:vi.fn((fn:()=>unknown)=>fn()) }));
import { withSystemDbAccessContext } from '../../db';
vi.mock('../../services/autopay/autopayGate', () => ({ requireAutopayEnabled: () => async(c:any,next:any) => c.req.header('x-disabled') ? c.json({code:'autopay_not_enabled'},404) : next() }));
vi.mock('../../services/autopay/enrollmentService', () => ({ requestAutopay:h.request,pauseAutopay:h.pause,resumeAutopay:h.resume,turnOffAutopay:h.off }));
vi.mock('../../services/autopay/enrollmentViews', () => ({ listAutopayEnrollments:h.list }));
vi.mock('../invoices/invoices', () => ({ invoiceActorFrom:(c:any) => { const a=c.get('auth'); return {userId:a.user.id,partnerId:a.partnerId,accessibleOrgIds:a.accessibleOrgIds}; } }));
import { autopayRoutes } from './index';
const app = new Hono().route('/',autopayRoutes);
const orgId='33333333-3333-4333-8333-333333333333';
const headers={authorization:'Bearer test','content-type':'application/json'};
describe('MSP autopay routes',()=>{
  beforeEach(()=>{ vi.clearAllMocks(); h.list.mockResolvedValue([{orgId,status:'not_requested',enrollment:null,method:null}]); h.request.mockResolvedValue({requested:[orgId],skipped:[]}); });
  it('authenticates and enforces billing manage and feature switch',async()=>{
    expect((await app.request('/billing/autopay')).status).toBe(401);
    expect((await app.request('/billing/autopay',{headers:{...headers,'x-deny':'1'}})).status).toBe(403);
    expect((await app.request('/billing/autopay',{headers:{...headers,'x-disabled':'1'}})).status).toBe(404);
    expect(h.list).not.toHaveBeenCalled();
  });
  it('counts clients with no enrollment',async()=>{
    const res=await app.request('/billing/autopay',{headers});
    expect(await res.json()).toMatchObject({notRequestedCount:1,data:[{status:'not_requested'}]});
  });
  it.each(['pause','resume','turn_off'])('dispatches %s',async(action)=>{
    const res=await app.request(`/orgs/${orgId}/autopay`,{method:'PATCH',headers,body:JSON.stringify({action})});
    expect(res.status).toBe(200);
    expect(withSystemDbAccessContext).toHaveBeenCalledOnce();
    expect({pause:h.pause,resume:h.resume,turn_off:h.off}[action]).toHaveBeenCalledWith({},expect.anything(),orgId);
  });
  it('rejects malformed and empty bulk operations before writing',async()=>{
    for(const body of [{orgIds:[]},{orgIds:['not-a-uuid']},{orgIds:[orgId],recipientOverride:'invalid'}]) {
      expect((await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(400);
    }
    expect(h.request).not.toHaveBeenCalled();
  });
  it('passes the recipient override and exact scoped actor',async()=>{
    await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify({orgIds:[orgId],recipientOverride:'accounts@example.test'})});
    expect(withSystemDbAccessContext).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledWith({},expect.objectContaining({accessibleOrgIds:[orgId]}),{orgIds:[orgId],recipientOverride:'accounts@example.test'});
  });
  it('rejects an inaccessible org before dispatch, including mixed bulk requests',async()=>{
    const foreign='44444444-4444-4444-8444-444444444444';
    expect((await app.request(`/orgs/${foreign}/autopay`,{method:'PATCH',headers,body:'{"action":"pause"}'})).status).toBe(404);
    expect((await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify({orgIds:[orgId,foreign]})})).status).toBe(404);
    expect(h.pause).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
  it('returns 404 for a missing org and 500 for an unexpected service failure',async()=>{
    h.list.mockResolvedValueOnce([]);
    expect((await app.request(`/orgs/${orgId}/autopay`,{headers})).status).toBe(404);
    h.request.mockRejectedValueOnce(new Error('database unavailable'));
    expect((await app.request('/billing/autopay/requests',{method:'POST',headers,body:JSON.stringify({orgIds:[orgId]})})).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/routes/autopay/index.test.ts`; the router import is missing. Against the previous `withAuthDbAccessContext` implementation, the system-context dispatch assertions fail; Task 12 supplies the real org-RLS regression.
- [ ] **Step 3: Implement** — create `enrollmentViews.ts`:

```ts
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, orgAutopayEnrollments } from '../../db/schema';
import type { InvoiceActor } from '../invoiceTypes';
import { getAutopayMethod } from './paymentMethods';
import { getAutopayStripeReadiness } from './stripeCapabilities';
export async function listAutopayEnrollments(actor: InvoiceActor, orgId?: string) {
  if (!actor.partnerId || actor.accessibleOrgIds?.length === 0) return [];
  if (orgId && actor.accessibleOrgIds && !actor.accessibleOrgIds.includes(orgId)) return [];
  return runOutsideDbContext(() => withSystemDbAccessContext(async()=>{
    const rows=await db.select({org:organizations,enrollment:orgAutopayEnrollments})
      .from(organizations).leftJoin(orgAutopayEnrollments,and(eq(orgAutopayEnrollments.orgId,organizations.id),eq(orgAutopayEnrollments.partnerId,organizations.partnerId)))
      .where(and(eq(organizations.partnerId,actor.partnerId!),isNull(organizations.deletedAt),
        inArray(organizations.status,['active','trial']),eq(organizations.type,'customer'),
        orgId?eq(organizations.id,orgId):undefined,
        actor.accessibleOrgIds?inArray(organizations.id,actor.accessibleOrgIds):undefined))
      .orderBy(organizations.name,organizations.id);
    return Promise.all(rows.map(async({org,enrollment})=>{
      const saved=await getAutopayMethod(db,org.id);
      const stripeReadiness=await getAutopayStripeReadiness(db,org.partnerId);
      return {orgId:org.id,orgName:org.name,billingContact:org.billingContact,
        status:enrollment?.needsAttentionReason?'needs_attention':enrollment?.status??'not_requested',
        enrollment:enrollment?{status:enrollment.status,generation:enrollment.generation,effectiveFrom:enrollment.effectiveFrom,
          needsAttentionReason:enrollment.needsAttentionReason}:null,
        method:saved?{type:saved.type,cardBrand:saved.cardBrand,cardFunding:saved.cardFunding,
          cardLast4:saved.cardLast4,cardExpMonth:saved.cardExpMonth,cardExpYear:saved.cardExpYear,
          bankName:saved.bankName,bankLast4:saved.bankLast4,status:saved.status}:null,
        stripeReadiness:{ready:stripeReadiness.ready,missing:stripeReadiness.missing},lastChargeResult:null};
    }));
  }));
}
```

Create `routes/autopay/index.ts`. The middleware is attached to the three exact path families, not `'*'`: this router is mounted at `/` and must not impose staff authentication on the public router.

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSIONS } from '@breeze/shared';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../../db';
import { authMiddleware,requirePermission } from '../../middleware/auth';
import { zValidator } from '../../lib/validation';
import { invoiceActorFrom } from '../invoices/invoices';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { requireAutopayEnabled } from '../../services/autopay/autopayGate';
import { listAutopayEnrollments } from '../../services/autopay/enrollmentViews';
import { requestAutopay,pauseAutopay,resumeAutopay,turnOffAutopay } from '../../services/autopay/enrollmentService';
export const autopayRoutes=new Hono();
const manage=requirePermission(PERMISSIONS.BILLING_MANAGE.resource,PERMISSIONS.BILLING_MANAGE.action);
for(const path of ['/billing/autopay','/billing/autopay/requests','/orgs/:orgId/autopay']) {
  autopayRoutes.use(path,authMiddleware,manage,requireAutopayEnabled());
}
autopayRoutes.onError((err,c)=>{
  if(err instanceof InvoiceServiceError)return c.json({error:err.message,code:err.code},err.status);
  throw err;
});
const orgParam=z.object({orgId:z.string().uuid()});
const allowed=(actor:ReturnType<typeof invoiceActorFrom>,ids:string[])=>actor.userId!==null&&actor.partnerId!==null&&
  ids.every(id=>actor.accessibleOrgIds===null||actor.accessibleOrgIds.includes(id));
autopayRoutes.get('/billing/autopay',async c=>{
  const data=await listAutopayEnrollments(invoiceActorFrom(c));
  return c.json({data,notRequestedCount:data.filter(row=>row.status==='not_requested').length});
});
autopayRoutes.post('/billing/autopay/requests',zValidator('json',z.object({
  orgIds:z.array(z.string().uuid()).min(1).max(500),recipientOverride:z.string().email().max(255).optional(),
}).strict()),async c=>{
  const actor=invoiceActorFrom(c),input=c.req.valid('json');
  if(!allowed(actor,input.orgIds))return c.json({error:'Organization not found'},404);
  return c.json(await runOutsideDbContext(()=>withSystemDbAccessContext(()=>requestAutopay(db,actor,{...input,orgIds:[...new Set(input.orgIds)]}))));
});
autopayRoutes.get('/orgs/:orgId/autopay',zValidator('param',orgParam),async c=>{
  const actor=invoiceActorFrom(c),{orgId}=c.req.valid('param');
  if(!allowed(actor,[orgId]))return c.json({error:'Organization not found'},404);
  const [data]=await listAutopayEnrollments(actor,orgId);
  return data?c.json(data):c.json({error:'Organization not found'},404);
});
autopayRoutes.patch('/orgs/:orgId/autopay',zValidator('param',orgParam),
  zValidator('json',z.object({action:z.enum(['pause','resume','turn_off'])}).strict()),async c=>{
    const actor=invoiceActorFrom(c),{orgId}=c.req.valid('param');
    if(!allowed(actor,[orgId]))return c.json({error:'Organization not found'},404);
    const action=c.req.valid('json').action;
    await runOutsideDbContext(()=>withSystemDbAccessContext(()=>({pause:pauseAutopay,resume:resumeAutopay,turn_off:turnOffAutopay}[action](db,actor,orgId))));
    return c.json({success:true});
  });
```

The route owns one short system transaction per mutation; the lifecycle service keeps the supplied executor and its locks through commit/rollback. Real authentication and billing permission checks run before the system context. Route org-allowlist checks reject mixed unauthorized batches before dispatch; `lockOrg` also requires the authenticated partner, enforces actor org access, and predicates its locked lookup on that partner. Readiness, connection binding, partner notice rendering, tokens and outbox writes therefore share the authorized transaction. Never add partner-axis RLS grants for organization scope or use `runOutsideDbContext` as a substitute for releasing an outer request transaction. Add the following entries to `SELF_MANAGED_DB_CONTEXT_ROUTES` in `middleware/selfManagedDbContextRoutes.ts`, keeping the existing entries:

```ts
{ method: 'GET', pattern: /^\/api\/v1\/billing\/autopay\/?$/ },
{ method: 'GET', pattern: /^\/api\/v1\/orgs\/[^/]+\/autopay\/?$/ },
{ method: 'GET', pattern: /^\/api\/v1\/portal\/payment-methods\/?$/ },
{ method: 'POST', pattern: /^\/api\/v1\/billing\/autopay\/requests\/?$/ },
{ method: 'PATCH', pattern: /^\/api\/v1\/orgs\/[^/]+\/autopay\/?$/ },
{ method: 'POST', pattern: /^\/api\/v1\/portal\/payment-methods\/setup-session\/?$/ },
{ method: 'POST', pattern: /^\/api\/v1\/portal\/payment-methods\/setup-return\/?$/ },
{ method: 'POST', pattern: /^\/api\/v1\/portal\/autopay\/stop\/?$/ },
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/routes/autopay/index.test.ts src/middleware/selfManagedDbContextRoutes.test.ts`. Task 12's real-app PostgreSQL cases must prove org-scoped request/pause/resume and notice rendering, reject same-partner and foreign-partner targets, and retain raw-transaction rollback; Task 7 retains active-org and generation cases; an `accessibleOrgIds:null` actor still has a partner filter in every service read.
- [ ] **Step 5: Commit** — `git add apps/api/src/routes/autopay/index.ts apps/api/src/routes/autopay/index.test.ts apps/api/src/services/autopay/enrollmentViews.ts apps/api/src/middleware/selfManagedDbContextRoutes.ts` then `git commit -m "feat(billing): expose scoped autopay enrollment operations"`.

### Task 11: Public and portal setup, verified return, and stop boundaries (W2a)

**Files:** Create `apps/api/src/routes/autopay/public.ts`, `apps/api/src/routes/portal/paymentMethods.ts`, `apps/api/src/services/autopay/customerViews.ts`, `apps/api/src/routes/autopay/public.test.ts`, `apps/api/src/routes/portal/paymentMethods.test.ts`; Modify `apps/api/src/services/autopay/autopayGate.ts`, `apps/api/src/middleware/partnerGuard.ts`, `apps/api/src/routes/portal/helpers.ts`.

**Interfaces:** Consumes C4 token resolver, readiness/settings/fee resolver, `createAutopaySetupSession`, `completeAutopaySetup`, `stopAutopayByClient`; private `buildAutopayDisclosure(db,orgId,methodType)` and `withAcceptedAutopayDisclosure(hash,fn)` from Task 1; private `autopaySetupAttempts` from Task 1; existing `portalAuthMiddleware` (`routes/portal/auth.ts`), `portalFinancialMutationGuard` (`routes/portal/helpers.ts`) and `getTrustedClientIpOrUndefined` (`services/clientIp.ts`). Produces `publicAutopayRoutes`, `portalPaymentMethodRoutes`, `getAutopayCustomerPage(orgId)`, `resolveAutopayLinkIdentity(token,purpose)`, `completeOwnedAutopaySetup(identity,sessionId)`. Return DTO adds `methodLabel` and `feeText` around the unchanged C4 completion result.

- [ ] **Step 1: Write the failing test** — `public.test.ts`:

```ts
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
const h=vi.hoisted(()=>({identity:vi.fn(),page:vi.fn(),complete:vi.fn(),create:vi.fn(),stop:vi.fn()}));
vi.mock('../../db',()=>({db:{},withSystemDbAccessContext:(fn:()=>unknown)=>fn()}));
vi.mock('../../services/autopay/customerViews',()=>({resolveAutopayLinkIdentity:h.identity,getAutopayCustomerPage:h.page,completeOwnedAutopaySetup:h.complete}));
vi.mock('../../services/autopay/enrollmentService',()=>({createAutopaySetupSession:h.create,stopAutopayByClient:h.stop}));
vi.mock('../../services/autopay/consentText',()=>({withAcceptedAutopayDisclosure:(_hash:string,fn:()=>unknown)=>fn()}));
vi.mock('../../services/autopay/autopayGate',()=>({requireAutopayEnabled:()=>async(c:any,next:any)=>c.req.header('x-disabled')?c.json({code:'autopay_not_enabled'},404):next()}));
vi.mock('../../services/clientIp',()=>({getTrustedClientIpOrUndefined:()=>undefined}));
import { publicAutopayRoutes } from './public';
const app=new Hono().route('/autopay/public',publicAutopayRoutes);
const identity={orgId:'11111111-1111-4111-8111-111111111111',partnerId:'22222222-2222-4222-8222-222222222222',tokenId:'33333333-3333-4333-8333-333333333333',enrollmentId:'44444444-4444-4444-8444-444444444444',generation:1};
const headers={'content-type':'application/json'};
describe('public autopay token boundaries',()=>{
  beforeEach(()=>{vi.clearAllMocks();h.identity.mockResolvedValue(identity);h.page.mockResolvedValue({contactEmail:'billing@example.test',partnerName:'Example MSP'});h.create.mockResolvedValue({url:'https://checkout.stripe.com/c/test'});h.complete.mockResolvedValue({outcome:'activated',orgId:identity.orgId,methodLabel:'Visa debit ••1234',feeText:'No fee applies.'});});
  it('GET setup and stop never create sessions or cancel enrollment',async()=>{
    expect((await app.request('/autopay/public/token')).status).toBe(200);
    expect((await app.request('/autopay/public/stop-token/stop')).status).toBe(200);
    expect(h.identity).toHaveBeenCalledWith('token','enroll');
    expect(h.identity).toHaveBeenCalledWith('stop-token','stop_autopay');
    expect(h.create).not.toHaveBeenCalled();expect(h.stop).not.toHaveBeenCalled();
  });
  it('expired, revoked, wrong-purpose and missing tokens reveal no page data',async()=>{
    h.identity.mockResolvedValue(null);
    expect((await app.request('/autopay/public/token')).status).toBe(404);
    expect(h.page).not.toHaveBeenCalled();
  });
  it('feature-off rejects public page, setup, return and stop',async()=>{
    for(const [path,body] of [['/token',null],['/token/setup-session',{methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)}],['/setup-return',{token:'token',checkoutSessionId:'cs_test'}],['/token/stop',{}]] as const){
      const res=await app.request(`/autopay/public${path}`,{method:body?'POST':'GET',headers:{...headers,'x-disabled':'1'},body:body?JSON.stringify(body):undefined});
      expect(res.status).toBe(404);
    }
    expect(h.create).not.toHaveBeenCalled();expect(h.complete).not.toHaveBeenCalled();expect(h.stop).not.toHaveBeenCalled();
  });
  it('requires true authorization and the displayed disclosure hash',async()=>{
    for(const body of [{methodType:'card',consentAccepted:false,disclosureHash:'a'.repeat(64)},{methodType:'card',consentAccepted:true},{methodType:'sepa_debit',consentAccepted:true,disclosureHash:'a'.repeat(64)}]){
      expect((await app.request('/autopay/public/token/setup-session',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(400);
    }
    expect(h.create).not.toHaveBeenCalled();
  });
  it('takes org and contact only from the verified token identity',async()=>{
    await app.request('/autopay/public/token/setup-session',{method:'POST',headers,body:JSON.stringify({methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)})});
    expect(h.create).toHaveBeenCalledWith({orgId:identity.orgId,tokenId:identity.tokenId,methodType:'card',consentAccepted:true,returnTo:'public',contactEmail:'billing@example.test',ip:null,userAgent:null});
  });
  it('ties return to token ownership and displays the retrieved debit funding',async()=>{
    const res=await app.request('/autopay/public/setup-return',{method:'POST',headers,body:JSON.stringify({token:'token',checkoutSessionId:'cs_test'})});
    expect(h.complete).toHaveBeenCalledWith(identity,'cs_test');
    expect(await res.json()).toMatchObject({methodLabel:'Visa debit ••1234',feeText:'No fee applies.'});
  });
  it('only POST stop cancels and source is link',async()=>{
    const res=await app.request('/autopay/public/token/stop',{method:'POST',headers,body:'{}'});
    expect(res.status).toBe(200);expect(h.stop).toHaveBeenCalledWith({}, {orgId:identity.orgId,source:'link'});
  });
});
```

Create `paymentMethods.test.ts`:

```ts
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
const h=vi.hoisted(()=>({page:vi.fn(),identity:vi.fn(),complete:vi.fn(),create:vi.fn(),stop:vi.fn()}));
vi.mock('../../db',()=>({db:{},withSystemDbAccessContext:(fn:()=>unknown)=>fn()}));
vi.mock('./auth',()=>({portalAuthMiddleware:async(c:any,next:any)=>{
  if(!c.req.header('authorization')&&!c.req.header('cookie'))return c.json({error:'Unauthorized'},401);
  c.set('portalAuth',{authMethod:c.req.header('cookie')?'cookie':'bearer',user:{id:'33333333-3333-4333-8333-333333333333',orgId:'11111111-1111-4111-8111-111111111111',email:'portal@example.test'}});return next();
}}));
vi.mock('../../services/autopay/customerViews',()=>({getAutopayCustomerPage:h.page,resolveAutopayOrgIdentity:h.identity,completeOwnedAutopaySetup:h.complete}));
vi.mock('../../services/autopay/enrollmentService',()=>({createAutopaySetupSession:h.create,stopAutopayByClient:h.stop}));
vi.mock('../../services/autopay/consentText',()=>({withAcceptedAutopayDisclosure:(_hash:string,fn:()=>unknown)=>fn()}));
vi.mock('../../services/autopay/autopayGate',()=>({requireAutopayEnabled:()=>async(c:any,next:any)=>c.req.header('x-disabled')?c.json({code:'autopay_not_enabled'},404):next()}));
vi.mock('../../services/clientIp',()=>({getTrustedClientIpOrUndefined:()=>undefined}));
import { portalPaymentMethodRoutes } from './paymentMethods';
const app=new Hono().route('/portal',portalPaymentMethodRoutes);
const headers={authorization:'Bearer test','content-type':'application/json'};
describe('portal payment-method boundaries',()=>{
  beforeEach(()=>{vi.clearAllMocks();h.identity.mockResolvedValue({orgId:'11111111-1111-4111-8111-111111111111',partnerId:'22222222-2222-4222-8222-222222222222'});h.page.mockResolvedValue({});h.create.mockResolvedValue({url:'https://checkout.stripe.com/c/test'});});
  it('requires a portal session',async()=>expect((await app.request('/portal/payment-methods')).status).toBe(401));
  it('feature-off returns 404 on every method',async()=>{
    for(const path of ['/payment-methods','/payment-methods/setup-session','/payment-methods/setup-return','/autopay/stop']){
      expect((await app.request(`/portal${path}`,{method:path==='/payment-methods'?'GET':'POST',headers:{...headers,'x-disabled':'1'},body:path==='/payment-methods'?undefined:'{}'})).status).toBe(404);
    }
  });
  it('cookie POST without double-submit CSRF is denied',async()=>{
    expect((await app.request('/portal/autopay/stop',{method:'POST',headers:{cookie:'breeze_portal_session=test','content-type':'application/json'},body:'{}'})).status).toBe(403);
    expect(h.stop).not.toHaveBeenCalled();
  });
  it('bearer mutations remain supported and never accept a caller orgId',async()=>{
    expect((await app.request('/portal/payment-methods/setup-session',{method:'POST',headers,body:JSON.stringify({orgId:'44444444-4444-4444-8444-444444444444',methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)})})).status).toBe(400);
    await app.request('/portal/autopay/stop',{method:'POST',headers,body:'{}'});
    expect(h.stop).toHaveBeenCalledWith({}, {orgId:'11111111-1111-4111-8111-111111111111',source:'portal',portalUserId:'33333333-3333-4333-8333-333333333333'});
  });
  it('GET never invokes a mutation',async()=>{
    await app.request('/portal/payment-methods',{headers});
    expect(h.stop).not.toHaveBeenCalled();expect(h.create).not.toHaveBeenCalled();expect(h.complete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/routes/autopay/public.test.ts src/routes/portal/paymentMethods.test.ts`; both router imports are missing.
- [ ] **Step 3: Implement** — create `customerViews.ts`:

```ts
import { and,eq,inArray,isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { BillingLinkPurpose } from '@breeze/shared';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../../db';
import { organizations,partners,portalBranding,orgAutopayEnrollments } from '../../db/schema';
import { autopaySetupAttempts } from '../../db/schema/autopaySetupAttempts';
import { resolveBillingLinkToken } from './linkTokens';
import { buildAutopayDisclosure } from './consentText';
import { getAutopayMethod } from './paymentMethods';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { quoteProcessingFee } from './processingFee';
import { completeAutopaySetup } from './enrollmentService';
export interface AutopayIdentity {orgId:string;partnerId:string;tokenId?:string;enrollmentId?:string;generation?:number}
declare module 'hono' { interface ContextVariableMap {autopayIdentity:AutopayIdentity;autopayPartnerId:string} }
const scoped=<T>(fn:()=>Promise<T>)=>runOutsideDbContext(()=>withSystemDbAccessContext(fn));
export async function resolveAutopayOrgIdentity(orgId:string):Promise<AutopayIdentity|null>{
  return scoped(async()=>{
    const [org]=await db.select({orgId:organizations.id,partnerId:organizations.partnerId}).from(organizations)
      .where(and(eq(organizations.id,orgId),isNull(organizations.deletedAt),inArray(organizations.status,['active','trial']))).limit(1);
    return org??null;
  });
}
export async function resolveAutopayLinkIdentity(token:string,purpose:BillingLinkPurpose):Promise<AutopayIdentity|null>{
  return scoped(async()=>{
    const link=await resolveBillingLinkToken(db,token,purpose);
    if(!link?.enrollmentId)return null;
    const [row]=await db.select({orgId:organizations.id,partnerId:organizations.partnerId,enrollmentId:orgAutopayEnrollments.id,generation:orgAutopayEnrollments.generation})
      .from(organizations).innerJoin(orgAutopayEnrollments,and(eq(orgAutopayEnrollments.orgId,organizations.id),eq(orgAutopayEnrollments.partnerId,organizations.partnerId)))
      .where(and(eq(organizations.id,link.orgId),eq(orgAutopayEnrollments.id,link.enrollmentId),
        isNull(organizations.deletedAt),inArray(organizations.status,['active','trial']))).limit(1);
    if(!row||row.generation!==link.generation)return null;
    return {...row,tokenId:link.id};
  });
}
export async function getAutopayCustomerPage(orgId:string){
  return scoped(async()=>{
    const [org]=await db.select().from(organizations).where(eq(organizations.id,orgId)).limit(1);
    if(!org)throw new HTTPException(404,{message:'Automatic payments not found'});
    const [partner]=await db.select({name:partners.name}).from(partners).where(eq(partners.id,org.partnerId)).limit(1);
    const [brand]=await db.select({logoUrl:portalBranding.logoUrl,primaryColor:portalBranding.primaryColor}).from(portalBranding).where(eq(portalBranding.orgId,orgId)).limit(1);
    const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1);
    const method=await getAutopayMethod(db,orgId);
    const card=await buildAutopayDisclosure(db,orgId,'card');
    const bank=await buildAutopayDisclosure(db,orgId,'us_bank_account');
    const readiness=await getAutopayStripeReadiness(db,org.partnerId);
    const quote=(type:'card'|'us_bank_account',funding:'credit'|'debit'|null)=>quoteProcessingFee({
      methodType:type,cardFunding:funding,principal:'100.00',currency:org.currencyCode,
      stripeAccountCountry:readiness.accountCountry,orgBillingCountry:org.billingAddressCountry,
      orgBillingRegion:org.billingAddressRegion,cardFeeBps:card.feeTerms.cardFeeBps,
      achFeeAmount:bank.feeTerms.achFeeAmount,feeAttested:card.feeTerms.feeAttested,
    });
    const contact=org.billingContact as {email?:string}|null;
    return {orgId,orgName:org.name,partnerName:partner?.name??card.partnerName,
      logoUrl:brand?.logoUrl??null,primaryColor:brand?.primaryColor??null,
      contactEmail:enrollment?.requestRecipientEmail??contact?.email??'',
      scheduleText:card.scheduleText,achMode:card.achMode,consentVersion:card.version,
      consentText:{card:card.text,us_bank_account:bank.text},disclosures:{card,us_bank_account:bank},
      fees:{card:{...quote('card','credit'),text:card.feeText},
        debit:{...quote('card','debit'),text:'No fee applies to debit or prepaid cards.'},
        us_bank_account:{...quote('us_bank_account',null),text:bank.feeText}},
      enrollment:enrollment?{status:enrollment.status,generation:enrollment.generation,effectiveFrom:enrollment.effectiveFrom,needsAttentionReason:enrollment.needsAttentionReason}:null,
      method:method?{type:method.type,cardBrand:method.cardBrand,cardFunding:method.cardFunding,cardLast4:method.cardLast4,
        cardExpMonth:method.cardExpMonth,cardExpYear:method.cardExpYear,bankName:method.bankName,bankLast4:method.bankLast4,status:method.status}:null,
      processingWarning:'A payment already processing may still complete after you stop automatic payments.'};
  });
}
export async function completeOwnedAutopaySetup(identity:AutopayIdentity,checkoutSessionId:string){
  const owned=await scoped(async()=>{
    const [attempt]=await db.select().from(autopaySetupAttempts).where(and(
      eq(autopaySetupAttempts.checkoutSessionId,checkoutSessionId),eq(autopaySetupAttempts.orgId,identity.orgId),
      eq(autopaySetupAttempts.partnerId,identity.partnerId),
      identity.tokenId?eq(autopaySetupAttempts.tokenId,identity.tokenId):undefined,
      identity.enrollmentId?eq(autopaySetupAttempts.enrollmentId,identity.enrollmentId):undefined,
      identity.generation!==undefined?eq(autopaySetupAttempts.generation,identity.generation):undefined,
    )).limit(1);return attempt;
  });
  if(!owned)throw new HTTPException(404,{message:'Setup session not found'});
  const result=await completeAutopaySetup(identity.partnerId,{checkoutSessionId});
  if(result.orgId!==identity.orgId)throw new Error('Setup ownership invariant violated');
  const page=await getAutopayCustomerPage(identity.orgId),method=page.method;
  const methodLabel=!method?null:method.type==='card'
    ?`${method.cardBrand??'Card'} ${method.cardFunding??'unknown'} ••${method.cardLast4??'----'}`
    :`${method.bankName??'Bank account'} ••${method.bankLast4??'----'}`;
  const feeText=method?.type==='card'&&method.cardFunding!=='credit'?'No fee applies.':
    method?.type==='us_bank_account'?page.fees.us_bank_account.text:page.fees.card.text;
  return {...result,methodLabel,feeText};
}
```

In `autopayGate.ts`, extend only `requireAutopayEnabled`'s identity resolution; keep its C4 signature and `isAutopayEnabledForPartner` implementation. The explicit identity is assigned only by the token/portal middleware below. Never put a made-up staff `auth` object in the context.

```ts
export function requireAutopayEnabled(): MiddlewareHandler {
  return async(c,next)=>{
    const partnerId=c.get('autopayPartnerId')??c.get('auth')?.partnerId;
    if(!partnerId)return c.json({code:'autopay_not_enabled'},404);
    const enabled=await runOutsideDbContext(()=>withSystemDbAccessContext(()=>isAutopayEnabledForPartner(db,partnerId)));
    if(!enabled)return c.json({code:'autopay_not_enabled'},404);
    return next();
  };
}
```

The function's imports are `type MiddlewareHandler` from `hono` and `db, runOutsideDbContext, withSystemDbAccessContext` from `../../db`. The declarations in `customerViews.ts` add the two Hono context slots. Public/portal admission runs before this middleware, so there is no unspecified partner lookup or hidden dependency on staff authentication.

Create `routes/autopay/public.ts`:

```ts
import { Hono,type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { db,withSystemDbAccessContext } from '../../db';
import { zValidator } from '../../lib/validation';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { requireAutopayEnabled } from '../../services/autopay/autopayGate';
import { resolveAutopayLinkIdentity,getAutopayCustomerPage,completeOwnedAutopaySetup } from '../../services/autopay/customerViews';
import { withAcceptedAutopayDisclosure } from '../../services/autopay/consentText';
import { createAutopaySetupSession,stopAutopayByClient } from '../../services/autopay/enrollmentService';
export const publicAutopayRoutes=new Hono();
const setup=z.object({methodType:z.enum(['card','us_bank_account']),consentAccepted:z.literal(true),disclosureHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const returning=z.object({token:z.string().min(1).max(512),checkoutSessionId:z.string().regex(/^cs_[A-Za-z0-9_]+$/).max(255)}).strict();
const boundary=(purpose:'enroll'|'stop_autopay',fromBody=false):MiddlewareHandler=>async(c,next)=>{
  const token=fromBody?(await c.req.json<{token:string}>()).token:c.req.param('token');
  if(!token)return c.json({error:'Automatic payments not found'},404);
  const identity=await resolveAutopayLinkIdentity(token,purpose);
  if(!identity)return c.json({error:'Automatic payments not found'},404);
  c.set('autopayIdentity',identity);c.set('autopayPartnerId',identity.partnerId);
  c.header('Cache-Control','no-store');return next();
};
const gate=requireAutopayEnabled();
publicAutopayRoutes.post('/setup-return',zValidator('json',returning),boundary('enroll',true),gate,async c=>{
  return c.json(await completeOwnedAutopaySetup(c.get('autopayIdentity'),c.req.valid('json').checkoutSessionId));
});
publicAutopayRoutes.get('/:token',boundary('enroll'),gate,async c=>c.json(await getAutopayCustomerPage(c.get('autopayIdentity').orgId)));
publicAutopayRoutes.post('/:token/setup-session',boundary('enroll'),gate,zValidator('json',setup),async c=>{
  const identity=c.get('autopayIdentity'),input=c.req.valid('json');
  const page=await getAutopayCustomerPage(identity.orgId);
  return c.json(await withAcceptedAutopayDisclosure(input.disclosureHash,()=>createAutopaySetupSession({
    orgId:identity.orgId,tokenId:identity.tokenId,methodType:input.methodType,consentAccepted:true,returnTo:'public',
    contactEmail:page.contactEmail,ip:getTrustedClientIpOrUndefined(c)??null,userAgent:c.req.header('user-agent')??null,
  })));
});
publicAutopayRoutes.get('/:token/stop',boundary('stop_autopay'),gate,async c=>{
  const page=await getAutopayCustomerPage(c.get('autopayIdentity').orgId);
  return c.json({partnerName:page.partnerName,orgName:page.orgName,processingWarning:page.processingWarning});
});
publicAutopayRoutes.post('/:token/stop',boundary('stop_autopay'),gate,zValidator('json',z.object({}).strict()),async c=>{
  await withSystemDbAccessContext(()=>stopAutopayByClient(db,{orgId:c.get('autopayIdentity').orgId,source:'link'}));return c.json({success:true});
});
```

Create `routes/portal/paymentMethods.ts`:

```ts
import { Hono,type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { db,withSystemDbAccessContext } from '../../db';
import { zValidator } from '../../lib/validation';
import { portalAuthMiddleware } from './auth';
import { portalFinancialMutationGuard } from './helpers';
import { requireAutopayEnabled } from '../../services/autopay/autopayGate';
import { resolveAutopayOrgIdentity,getAutopayCustomerPage,completeOwnedAutopaySetup } from '../../services/autopay/customerViews';
import { withAcceptedAutopayDisclosure } from '../../services/autopay/consentText';
import { createAutopaySetupSession,stopAutopayByClient } from '../../services/autopay/enrollmentService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
export const portalPaymentMethodRoutes=new Hono();
const identity:MiddlewareHandler=async(c,next)=>{
  const owned=await resolveAutopayOrgIdentity(c.get('portalAuth').user.orgId);
  if(!owned)return c.json({error:'Automatic payments not found'},404);
  c.set('autopayIdentity',owned);c.set('autopayPartnerId',owned.partnerId);c.header('Cache-Control','no-store');return next();
};
for(const path of ['/payment-methods','/payment-methods/setup-session','/payment-methods/setup-return','/autopay/stop']){
  portalPaymentMethodRoutes.use(path,portalAuthMiddleware,identity,requireAutopayEnabled(),portalFinancialMutationGuard);
}
portalPaymentMethodRoutes.get('/payment-methods',async c=>c.json(await getAutopayCustomerPage(c.get('portalAuth').user.orgId)));
portalPaymentMethodRoutes.post('/payment-methods/setup-session',zValidator('json',z.object({
  methodType:z.enum(['card','us_bank_account']),consentAccepted:z.literal(true),disclosureHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict()),async c=>{
  const auth=c.get('portalAuth'),input=c.req.valid('json');
  return c.json(await withAcceptedAutopayDisclosure(input.disclosureHash,()=>createAutopaySetupSession({
    orgId:auth.user.orgId,methodType:input.methodType,consentAccepted:true,returnTo:'portal',contactEmail:auth.user.email,
    ip:getTrustedClientIpOrUndefined(c)??null,userAgent:c.req.header('user-agent')??null,
  })));
});
portalPaymentMethodRoutes.post('/payment-methods/setup-return',zValidator('json',z.object({checkoutSessionId:z.string().regex(/^cs_[A-Za-z0-9_]+$/).max(255)}).strict()),
  async c=>c.json(await completeOwnedAutopaySetup(c.get('autopayIdentity'),c.req.valid('json').checkoutSessionId)));
portalPaymentMethodRoutes.post('/autopay/stop',zValidator('json',z.object({}).strict()),async c=>{
  const auth=c.get('portalAuth');await withSystemDbAccessContext(()=>stopAutopayByClient(db,{orgId:auth.user.orgId,source:'portal',portalUserId:auth.user.id}));
  return c.json({success:true});
});
```

The existing `portalFinancialMutationGuard` enforces cookie CSRF for every POST, not just invoices/quotes; its JSON-content-type branch currently names only quote acceptance and invoice settlement. `zValidator('json',...)` remains the schema boundary for these routes. Add the new POST paths to that guard's `requiresJsonBody` expression so form submissions deterministically return 415:

```ts
|| /\/payment-methods\/(?:setup-session|setup-return)$/.test(c.req.path)
|| /\/autopay\/stop$/.test(c.req.path)
```

Add this explicit exemption to `isPartnerGuardExemptPath` in `middleware/partnerGuard.ts`, before its return false:

```ts
if (path.startsWith('/api/v1/autopay/public/')) return true;
```

This prevents a prefetched public GET carrying an unrelated staff Authorization header from entering `partnerGuard`'s account-activation write. Token purpose, active org, account binding and rollout gate still run inside the public router. Do not exempt the authenticated MSP or portal paths.

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/routes/autopay/public.test.ts src/routes/portal/paymentMethods.test.ts src/routes/portal/invoices.test.ts src/middleware/partnerGuard.test.ts`. Completion ownership, method funding and stale generation are additionally exercised against the real database in the enrollment integration task.
- [ ] **Step 5: Commit** — `git add apps/api/src/routes/autopay/public.ts apps/api/src/routes/autopay/public.test.ts apps/api/src/routes/portal/paymentMethods.ts apps/api/src/routes/portal/paymentMethods.test.ts apps/api/src/routes/portal/helpers.ts apps/api/src/services/autopay/customerViews.ts apps/api/src/services/autopay/autopayGate.ts apps/api/src/middleware/partnerGuard.ts` then `git commit -m "feat(billing): add token and portal autopay enrollment routes"`.

### Task 12: Mount every API route in the actual application and prove enum compatibility (W2a)

**Files:** Modify `apps/api/src/index.ts`, `apps/api/vitest.config.ts`, `apps/api/vitest.integration.config.ts`; Create `apps/api/src/index.autopay.integration.test.ts`; Test `apps/api/src/routes/orgs.test.ts`.

**Interfaces:** Consumes `autopayRoutes`, `publicAutopayRoutes`, `portalPaymentMethodRoutes` from Tasks 10–11. Also consumes the shared W1 `Tx` and Task 5 lifecycle functions to prove raw-transaction rollback; uses real organization membership, JWT authentication and forced RLS for request/pause/resume. Produces named `app` export from the existing `index.ts` Hono instance, with the same middleware and route order as production. Do not create a test-only substitute router. `index.ts` currently unconditionally calls `bootstrap` at import and exports no application; the `NODE_ENV !== 'test'` bootstrap guard is required for a real app-level test without opening a listener or workers.

- [ ] **Step 1: Write the failing test** — create `index.autopay.integration.test.ts`:

```ts
import './__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { eq,sql } from 'drizzle-orm';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { getTestDb } from './__tests__/integration/setup';
import { createPartner,createOrganization,createRole,createUser,assignUserToPartner,assignUserToOrganization,grantRolePermissions } from './__tests__/integration/db-utils';
import { partners,organizations,stripeConnectAccounts,orgAutopayEnrollments,orgPaymentMethods,billingNoticeOutbox,billingLinkTokens } from './db/schema';
import { db,withDbAccessContext,withSystemDbAccessContext } from './db';
import { requestAutopay,resumeAutopay } from './services/autopay/enrollmentLifecycle';
import { createAccessToken } from './services/jwt';
const h=vi.hoisted(()=>({identity:vi.fn(),page:vi.fn(),complete:vi.fn(),create:vi.fn(),stop:vi.fn(),stripe:vi.fn()}));
vi.mock('./services/partnerStripe',async actual=>({...await actual<typeof import('./services/partnerStripe')>(),getPartnerStripeClient:h.stripe}));
vi.mock('./services/autopay/customerViews',async actual=>({...await actual<typeof import('./services/autopay/customerViews')>(),
  resolveAutopayLinkIdentity:h.identity,getAutopayCustomerPage:h.page,completeOwnedAutopaySetup:h.complete}));
vi.mock('./services/autopay/enrollmentService',async actual=>({...await actual<typeof import('./services/autopay/enrollmentService')>(),
  createAutopaySetupSession:h.create,stopAutopayByClient:h.stop}));
import { app } from './index';
async function fixture(scope:'partner'|'organization'='partner',canManage=true){
  const partner=await createPartner();
  const org=await createOrganization({partnerId:partner.id});
  const otherPartner=await createPartner();
  const otherOrg=await createOrganization({partnerId:otherPartner.id});
  await getTestDb().update(partners).set({autopayEnabled:true}).where(eq(partners.id,partner.id));
  await getTestDb().update(organizations).set({billingContact:{email:'billing@example.test'}}).where(eq(organizations.id,org.id));
  const [connection]=await getTestDb().insert(stripeConnectAccounts).values({partnerId:partner.id,
    stripeAccountId:`acct_${randomUUID().replaceAll('-','')}`,status:'connected',accountCountry:'US',defaultCurrency:'USD',
    autopayCapabilitiesCheckedAt:new Date(),autopayMissingPermissions:[]}).returning();
  const role=await createRole({scope,partnerId:partner.id,orgId:scope==='organization'?org.id:undefined});
  if(canManage)await grantRolePermissions(role.id,[{resource:'billing',action:'manage'}]);
  const user=await createUser({partnerId:partner.id,orgId:scope==='organization'?org.id:null,
    email:`${randomUUID()}@example.test`,mfaEnabled:true});
  if(scope==='organization')await assignUserToOrganization(user.id,org.id,role.id);
  else await assignUserToPartner(user.id,partner.id,role.id,'all');
  const token=await createAccessToken({sub:user.id,email:user.email,roleId:role.id,scope,orgId:scope==='organization'?org.id:null,
    partnerId:partner.id,mfa:true,aep:1,mep:1,sid:randomUUID()});
  const actor={userId:user.id,partnerId:partner.id,accessibleOrgIds:scope==='organization'?[org.id]:null};
  return {partner,org,otherOrg,user,connection:connection!,actor,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}};
}
describe('autopay mounted in the production Hono application',()=>{
  beforeEach(()=>{vi.clearAllMocks();h.stripe.mockRejectedValue(new Error('Unexpected Stripe request'));});
  it('org-scoped request, pause and resume resolve partner rows without widening org authority',async()=>{
    const f=await fixture('organization');
    const role=await withSystemDbAccessContext(()=>db.execute(sql`SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`));
    expect(role[0]).toMatchObject({role:'breeze_app',rolsuper:false,rolbypassrls:false});
    // Negative control: these partner-axis rows exist but org RLS hides them.
    await withDbAccessContext({scope:'organization',orgId:f.org.id,accessibleOrgIds:[f.org.id],
      accessiblePartnerIds:[],currentPartnerId:f.partner.id,userId:f.user.id},async()=>{
      expect(await db.select({id:organizations.id}).from(organizations).where(eq(organizations.id,f.org.id))).toEqual([{id:f.org.id}]);
      expect(await db.select().from(partners).where(eq(partners.id,f.partner.id))).toEqual([]);
      expect(await db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId,f.partner.id))).toEqual([]);
    });
    const requested=await app.request('/api/v1/billing/autopay/requests',{method:'POST',headers:f.headers,
      body:JSON.stringify({orgIds:[f.org.id]})});
    expect(requested.status,await requested.clone().text()).toBe(200);
    expect(await requested.json()).toEqual({requested:[f.org.id],skipped:[]});
    const [enrollment]=await getTestDb().select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,f.org.id));
    expect(enrollment).toMatchObject({partnerId:f.partner.id,status:'requested',generation:1,
      stripeConnectionId:f.connection.id,stripeAccountId:f.connection.stripeAccountId,requestedBy:f.user.id});
    const [notice]=await getTestDb().select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.orgId,f.org.id));
    expect(notice).toMatchObject({orgId:f.org.id,enrollmentId:enrollment!.id,kind:'autopay_request',status:'pending',toEmail:'billing@example.test',
      rendered:{text:expect.stringContaining(f.partner.name)}});
    expect(notice).toMatchObject({rendered:{text:expect.stringContaining(f.org.name)}});
    const oldEffectiveFrom=new Date('2026-01-01T00:00:00Z');
    await getTestDb().update(orgAutopayEnrollments).set({status:'active',effectiveFrom:oldEffectiveFrom})
      .where(eq(orgAutopayEnrollments.id,enrollment!.id));
    await getTestDb().insert(orgPaymentMethods).values({orgId:f.org.id,enrollmentId:enrollment!.id,
      stripePaymentMethodId:`pm_${randomUUID().replaceAll('-','')}`,type:'card',status:'active',isAutopayMethod:true});
    const paused=await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{method:'PATCH',headers:f.headers,body:'{"action":"pause"}'});
    expect(paused.status,await paused.clone().text()).toBe(200);
    const notices=await getTestDb().select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.orgId,f.org.id));
    expect(notices.map(row=>row.kind).sort()).toEqual(['autopay_request','autopay_stopped']);
    expect(notices.find(row=>row.kind==='autopay_stopped')).toMatchObject({rendered:{text:expect.stringContaining(f.partner.name)}});
    // A raw transaction must stay usable and a caller rollback must undo resume.
    await expect(withSystemDbAccessContext(()=>db.transaction(async tx=>{
      await resumeAutopay(tx,f.actor,f.org.id);
      const [inside]=await tx.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,enrollment!.id));
      expect(inside!.status).toBe('active');
      throw new Error('rollback raw resume');
    }))).rejects.toThrow('rollback raw resume');
    const [rolledBack]=await getTestDb().select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,enrollment!.id));
    expect(rolledBack).toMatchObject({status:'paused',effectiveFrom:oldEffectiveFrom});
    const resumed=await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{method:'PATCH',headers:f.headers,body:'{"action":"resume"}'});
    expect(resumed.status,await resumed.clone().text()).toBe(200);
    const [active]=await getTestDb().select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,enrollment!.id));
    expect(active).toMatchObject({status:'active',generation:1,pausedAt:null,pausedBy:null});
    expect(active!.effectiveFrom!.getTime()).toBeGreaterThan(oldEffectiveFrom.getTime());
    expect(h.stripe).not.toHaveBeenCalled();
  });
  it.each(['organization','partner'] as const)('%s mutations reject unauthorized targets without partial writes',async scope=>{
    const f=await fixture(scope);
    const sibling=await createOrganization({partnerId:f.partner.id});
    const denied=scope==='organization'?[sibling.id,f.otherOrg.id]:[f.otherOrg.id];
    for(const orgId of denied){
      const request=await app.request('/api/v1/billing/autopay/requests',{method:'POST',headers:f.headers,
        body:JSON.stringify({orgIds:[f.org.id,orgId]})});
      expect(request.status,await request.clone().text()).toBe(404);
      for(const action of ['pause','resume','turn_off']){
        expect((await app.request(`/api/v1/orgs/${orgId}/autopay`,{method:'PATCH',headers:f.headers,
          body:JSON.stringify({action})})).status).toBe(404);
      }
    }
    // Even an unrestricted org list cannot authorize a different partner at the service boundary.
    await expect(withSystemDbAccessContext(()=>requestAutopay(db,{...f.actor,accessibleOrgIds:null},
      {orgIds:[f.org.id,f.otherOrg.id]}))).rejects.toMatchObject({status:404,code:'ORG_NOT_FOUND'});
    await expect(withSystemDbAccessContext(()=>requestAutopay(db,{...f.actor,partnerId:null},
      {orgIds:[f.org.id]}))).rejects.toMatchObject({status:404,code:'ORG_NOT_FOUND'});
    if(scope==='organization'){
      await expect(withSystemDbAccessContext(()=>requestAutopay(db,f.actor,{orgIds:[sibling.id]})))
        .rejects.toMatchObject({status:403,code:'ORG_DENIED'});
    }
    expect(await getTestDb().select().from(orgAutopayEnrollments)).toEqual([]);
    expect(await getTestDb().select().from(billingNoticeOutbox)).toEqual([]);
    expect(await getTestDb().select().from(billingLinkTokens)).toEqual([]);
    expect(h.stripe).not.toHaveBeenCalled();
  });
  it('org-scoped writes require billing permission and the rollout switch',async()=>{
    const denied=await fixture('organization',false);
    const enabled=await fixture('organization');
    await getTestDb().update(partners).set({autopayEnabled:false}).where(eq(partners.id,enabled.partner.id));
    for(const [f,status]of [[denied,403],[enabled,404]] as const){
      expect((await app.request('/api/v1/billing/autopay/requests',{method:'POST',headers:f.headers,
        body:JSON.stringify({orgIds:[f.org.id]})})).status).toBe(status);
      expect((await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{method:'PATCH',headers:f.headers,
        body:'{"action":"resume"}'})).status).toBe(status);
    }
    expect(await getTestDb().select().from(orgAutopayEnrollments)).toEqual([]);
    expect(await getTestDb().select().from(billingNoticeOutbox)).toEqual([]);
    expect(h.stripe).not.toHaveBeenCalled();
  });
  it('the actual enum accepts billing and adding it again is a no-op',async()=>{
    const before=await getTestDb().execute(sql`SELECT 'billing'::public.notification_type AS value`);
    expect(before[0]).toMatchObject({value:'billing'});
    await getTestDb().execute(sql`ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'billing'`);
    const after=await getTestDb().execute(sql`SELECT 'billing'::public.notification_type AS value`);
    expect(after[0]).toMatchObject({value:'billing'});
  });
  it('GET list is mounted, includes not-requested clients, and excludes another partner',async()=>{
    const f=await fixture();
    const res=await app.request('/api/v1/billing/autopay',{headers:f.headers});
    expect(res.status,await res.clone().text()).toBe(200);
    const body=await res.json();
    expect(body.data).toEqual([expect.objectContaining({orgId:f.org.id,status:'not_requested'})]);
    expect(body.notRequestedCount).toBe(1);
    expect((await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{headers:f.headers})).status).toBe(200);
    expect((await app.request(`/api/v1/orgs/${f.otherOrg.id}/autopay`,{headers:f.headers})).status).toBe(404);
  });
  it('MSP POST/PATCH mount validators run through the app',async()=>{
    const f=await fixture();
    expect((await app.request('/api/v1/billing/autopay/requests',{method:'POST',headers:f.headers,body:'{"orgIds":[]}'})).status).toBe(400);
    expect((await app.request(`/api/v1/orgs/${f.org.id}/autopay`,{method:'PATCH',headers:f.headers,body:'{"action":"charge"}'})).status).toBe(400);
  });
  it('public GET, setup, verified return and stop are all reachable without staff auth',async()=>{
    const f=await fixture();
    h.identity.mockResolvedValue({orgId:f.org.id,partnerId:f.partner.id,tokenId:randomUUID(),enrollmentId:randomUUID(),generation:1});
    h.page.mockResolvedValue({orgId:f.org.id,orgName:'Example client',partnerName:'Example MSP',contactEmail:'billing@example.test',processingWarning:'A payment already processing may still complete.'});
    h.create.mockResolvedValue({url:'https://checkout.stripe.com/c/test'});
    h.complete.mockResolvedValue({outcome:'pending_verification',orgId:f.org.id,methodLabel:'Bank ••6789',feeText:'No fee applies.'});
    const paths=[
      ['GET','/autopay/public/enroll-token',undefined],
      ['POST','/autopay/public/enroll-token/setup-session',{methodType:'card',consentAccepted:true,disclosureHash:'a'.repeat(64)}],
      ['POST','/autopay/public/setup-return',{token:'enroll-token',checkoutSessionId:'cs_test'}],
      ['GET','/autopay/public/stop-token/stop',undefined],
      ['POST','/autopay/public/stop-token/stop',{}],
    ] as const;
    for(const [method,path,body]of paths){
      const res=await app.request(`/api/v1${path}`,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
      expect(res.status,`${method} ${path}: ${await res.clone().text()}`).toBe(200);
    }
    expect(h.create).toHaveBeenCalledOnce();expect(h.complete).toHaveBeenCalledOnce();expect(h.stop).toHaveBeenCalledOnce();
    expect(h.stripe).not.toHaveBeenCalled();
  });
  it.each([
    ['GET','/portal/payment-methods'],['POST','/portal/payment-methods/setup-session'],
    ['POST','/portal/payment-methods/setup-return'],['POST','/portal/autopay/stop'],
  ])('mounted portal %s %s requires its own authentication',async(method,path)=>{
    const res=await app.request(`/api/v1${path}`,{method,headers:{'content-type':'application/json'},body:method==='POST'?'{}':undefined});
    expect(res.status).toBe(401);expect(await res.json()).toMatchObject({error:expect.stringContaining('authorization')});
  });
});
```

In the existing `describe('PATCH /orgs/partners/me — emailTemplates')` block in `routes/orgs.test.ts`, whose `setAuthContext`, `mockCurrentPartnerSelect`, `mockUpdateCapture` and `patchMe` helpers are already defined and verified, add:

```ts
it.each(['autopay_request','autopay_enrolled','autopay_stopped','card_expiring'])('accepts %s through partner settings validation',async(id)=>{
  setAuthContext({scope:'partner',partnerId:'11111111-1111-4111-8111-111111111111'});
  mockCurrentPartnerSelect({});
  const captured=mockUpdateCapture();
  const fields={subject:'Automatic payments',heading:'Payment details',buttonLabel:'Open',html:'<p>Hello {{client_name}}</p>'};
  const res=await patchMe({settings:{emailTemplates:{[id]:fields}}});
  expect(res.status).toBe(200);
  expect(captured().settings.emailTemplates[id]).toEqual(fields);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/index.autopay.integration.test.ts`; expect the missing `app` export/mounts or `billing` enum to fail. Against the pre-fix Task 10 route, the org-scoped request must fail its `{requested:[orgId],skipped:[]}` assertion because org RLS hides Stripe readiness; the resume fixture also needs the same system orchestration. Against a narrowed C4 executor, the raw `resumeAutopay(tx,...)` call must fail the test-project type gate. Add `'src/index.autopay.integration.test.ts'` to integration `include` and unit `exclude` before this invocation, so the test really runs and never tries the default no-DB runner. `cd apps/api && npx vitest run src/routes/orgs.test.ts` fails the new ID cases before Task 3's catalog additions.
- [ ] **Step 3: Implement** — add these imports and mounts in `index.ts`. Place the three mounts before the existing `/orgs` and `/portal` aggregate mounts, because the generic routers have broad auth middleware. The MSP autopay router has exact-path middleware and cannot shadow public requests.

```ts
import { autopayRoutes } from './routes/autopay';
import { publicAutopayRoutes } from './routes/autopay/public';
import { portalPaymentMethodRoutes } from './routes/portal/paymentMethods';
// Replace `const app = new Hono();`:
export const app = new Hono();
// Before existing api.route('/orgs', ...) and api.route('/portal', ...):
api.route('/autopay/public',publicAutopayRoutes);
api.route('/portal',portalPaymentMethodRoutes);
api.route('/',autopayRoutes);
// Replace the bottom-level bootstrap invocation:
if(process.env.NODE_ENV!=='test'){
  void bootstrap().catch((error)=>{
    console.error('[CRITICAL] API startup failed:',error);
    process.exit(1);
  });
}
```

Do not mount `portalPaymentMethodRoutes` a second time in `routes/portal/index.ts`: its own `portalAuthMiddleware` plus CSRF guard already make it a self-contained router. Keep the Task 12 org-scoped cases unmocked for auth, lifecycle services, readiness, rendering, outbox and SQL; only the existing Stripe boundary and unrelated public setup adapters are mocked. The request role assertion and org-RLS negative control prevent a superuser fixture from disguising CW-05. The application test loads the real root router, so deleting any one mount gives a failing test; a source-string assertion is not a substitute.

- [ ] **Step 4: Run it, expect PASS** — from the repository root run `pnpm exec tsc --build apps/api/tsconfig.tests.json` to check the raw-transaction call; run `cd apps/api && npx vitest run -c vitest.integration.config.ts src/index.autopay.integration.test.ts`, then `cd apps/api && npx vitest run src/routes/orgs.test.ts src/middleware/selfManagedDbContextRoutes.test.ts src/index.bootBinarySync.test.ts`; tear down with `pnpm test-stack down` from the root when the integration session is finished.
- [ ] **Step 5: Commit** — `git add apps/api/src/index.ts apps/api/src/index.autopay.integration.test.ts apps/api/vitest.config.ts apps/api/vitest.integration.config.ts apps/api/src/routes/orgs.test.ts` then `git commit -m "feat(billing): mount and verify autopay API routes"`.

### Task 13: Card expiry notices and worker registration (W2a)

**Files:** Create `apps/api/src/services/autopay/cardExpiryCheck.ts`, `apps/api/src/services/autopay/cardExpiryCheck.test.ts`, `apps/api/src/services/autopay/cardExpiryCheck.integration.test.ts`; Modify `apps/api/vitest.config.ts`, `apps/api/vitest.integration.config.ts`, `apps/api/src/jobs/autopayWorker.ts`, `apps/api/src/jobs/scheduleRegistry.ts`, `apps/api/src/services/workerRegistry.ts`; Test `apps/api/src/jobs/autopayWorker.test.ts`, `apps/api/src/jobs/scheduleRegistry.contract.test.ts`, `apps/api/src/services/workerEntrypointClosure.contract.test.ts`.

**Interfaces:** Consumes C4 `mintBillingLinkToken(tx,{orgId,purpose,enrollmentId,generation,ttlDays})`, `buildBillingLinkUrl(purpose,token)`, `enqueueBillingNotice(tx,input)`, `renderBillingNotice(kind,ctx)` and Task 3 `AutopayNoticeContext`; W1 queue `autopay-jobs` and notice-dispatch handler. Produces `checkExpiringAutopayCards(now?:Date):Promise<{enqueued:number}>`, `isCardExpiring(now,year,month):boolean`, and C5 `card-expiry-check` at schedule key `autopay-card-expiry-check`, cron **`28 6 * * *`**. A card is valid through the last day of its printed expiry month; warning starts 30 UTC calendar days before the first instant of the following month. A late daily run catches the rest of that window, and the outbox unique key sends once per method.

- [ ] **Step 1: Write the failing test** — create `cardExpiryCheck.test.ts`:

```ts
import { beforeEach,describe,expect,it,vi } from 'vitest';
const h=vi.hoisted(()=>({rows:[] as unknown[][],mint:vi.fn(),enqueue:vi.fn(),render:vi.fn(),disclosure:vi.fn()}));
vi.mock('../../db',()=>({runOutsideDbContext:(fn:()=>unknown)=>fn(),withSystemDbAccessContext:(fn:()=>unknown)=>fn(),db:{
  select:()=>{const q:any={};for(const key of ['from','innerJoin','where','limit','for'])q[key]=()=>q;
    q.then=(f:(x:unknown)=>unknown)=>Promise.resolve(h.rows.shift()??[]).then(f);return q;},
}}));
vi.mock('./linkTokens',()=>({mintBillingLinkToken:h.mint,buildBillingLinkUrl:(_purpose:string,token:string)=>`https://portal.example.test/autopay/${token}`}));
vi.mock('./noticeOutbox',()=>({enqueueBillingNotice:h.enqueue}));
vi.mock('./renderBillingNotice',()=>({renderBillingNotice:h.render}));
vi.mock('./consentText',()=>({buildAutopayDisclosure:h.disclosure}));
import {checkExpiringAutopayCards,isCardExpiring} from './cardExpiryCheck';
const methodId='11111111-1111-4111-8111-111111111111';
const row={method:{id:methodId,orgId:'22222222-2222-4222-8222-222222222222',enrollmentId:'33333333-3333-4333-8333-333333333333',cardBrand:'visa',cardLast4:'1234',cardExpYear:2026,cardExpMonth:10},
  enrollment:{id:'33333333-3333-4333-8333-333333333333',generation:4,requestRecipientEmail:'billing@example.test'},
  org:{id:'22222222-2222-4222-8222-222222222222',partnerId:'44444444-4444-4444-8444-444444444444',name:'Example client',billingContact:{email:'billing@example.test'}}};
describe('autopay card expiry',()=>{
  beforeEach(()=>{vi.clearAllMocks();h.rows.length=0;h.mint.mockResolvedValue({token:'update-token',id:'55555555-5555-4555-8555-555555555555'});h.enqueue.mockResolvedValue({id:'66666666-6666-4666-8666-666666666666',created:true});h.render.mockResolvedValue({subject:'Update your card',html:'<p>Update</p>',text:'Update',frozen:{}});h.disclosure.mockResolvedValue({partnerName:'Example MSP',scheduleText:'After issue',feeText:'No fee applies.'});});
  it.each([
    ['2026-10-01T23:59:59Z',2026,10,false],['2026-10-02T00:00:00Z',2026,10,true],
    ['2026-10-31T23:59:59Z',2026,10,true],['2026-11-01T00:00:00Z',2026,10,false],
    ['2028-01-31T00:00:00Z',2028,2,true],['2026-10-02T00:00:00Z',null,10,false],
  ])('handles month boundary %s', (now,year,month,expected)=>expect(isCardExpiring(new Date(now),year,month)).toBe(expected));
  it('enqueues one notice per method with an update token at the same generation',async()=>{
    h.rows.push([row],[row.org],[row.enrollment],[row.method],[]);
    expect(await checkExpiringAutopayCards(new Date('2026-10-02T06:28:00Z'))).toEqual({enqueued:1});
    expect(h.mint).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({purpose:'enroll',generation:4,ttlDays:30}));
    expect(h.enqueue).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({kind:'card_expiring',dedupeKey:`card-expiring:${methodId}`,seq:1}));
    expect(h.render).toHaveBeenCalledWith('card_expiring',expect.objectContaining({autopay:expect.objectContaining({vars:expect.objectContaining({expires_on:'2026-10-31'})})}));
  });
  it('does not mint another token or send another message on a repeated daily run',async()=>{
    h.rows.push([row],[row.org],[row.enrollment],[row.method],[{id:'66666666-6666-4666-8666-666666666666'}]);
    expect(await checkExpiringAutopayCards(new Date('2026-10-03T06:28:00Z'))).toEqual({enqueued:0});
    expect(h.mint).not.toHaveBeenCalled();expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('skips a method removed after the candidate read',async()=>{
    h.rows.push([row],[row.org],[row.enrollment],[]);
    expect(await checkExpiringAutopayCards(new Date('2026-10-02T06:28:00Z'))).toEqual({enqueued:0});
    expect(h.mint).not.toHaveBeenCalled();
  });
  it('empty population returns zero',async()=>{h.rows.push([]);expect(await checkExpiringAutopayCards()).toEqual({enqueued:0});});
});
```

Add this complete worker test to `autopayWorker.test.ts` (preserve W1's dispatcher tests):

```ts
import {describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({expiry:vi.fn(),notice:vi.fn()}));
vi.mock('../services/autopay/cardExpiryCheck',()=>({checkExpiringAutopayCards:h.expiry}));
vi.mock('../services/autopay/noticeOutbox',()=>({dispatchPendingBillingNotices:h.notice}));
vi.mock('../services/autopay/merge',()=>({drainAutopayMethodDetaches:vi.fn(async()=>undefined)}));
import {processAutopayJob} from './autopayWorker';
describe('autopay worker routing',()=>{
  it('dispatches the new job without consuming the notice-dispatch job',async()=>{
    h.expiry.mockResolvedValue({enqueued:2});h.notice.mockResolvedValue({sent:3,failed:0});
    expect(await processAutopayJob({type:'card-expiry-check'})).toEqual({enqueued:2});
    expect(await processAutopayJob({type:'notice-dispatch'})).toEqual({sent:3,failed:0});
    expect(h.expiry).toHaveBeenCalledOnce();expect(h.notice).toHaveBeenCalledOnce();
  });
});
```

Create `apps/api/src/services/autopay/cardExpiryCheck.integration.test.ts` before implementing the expiry job. It uses real PostgreSQL for locks/outbox/token writes; only email rendering and cached disclosure calculation are mocked, and there are no Stripe calls:

```ts
import '../../__tests__/integration/setup';
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {describe,expect,it,vi} from 'vitest';
import {getTestDb} from '../../__tests__/integration/setup';
import {createPartner,createOrganization} from '../../__tests__/integration/db-utils';
import {partners,stripeConnectAccounts,orgAutopayEnrollments,orgPaymentMethods,billingNoticeOutbox,billingLinkTokens} from '../../db/schema';
vi.mock('./consentText',()=>({buildAutopayDisclosure:vi.fn(async()=>({partnerName:'Example MSP',scheduleText:'On the due date.',feeText:'No fee applies.'}))}));
vi.mock('./renderBillingNotice',()=>({renderBillingNotice:vi.fn(async()=>({subject:'Update your card',html:'<p>Update your card</p>',text:'Update your card',frozen:{}}))}));
vi.mock('../partnerStripe',async actual=>({...await actual<typeof import('../partnerStripe')>(),getPartnerStripeClient:vi.fn(async()=>{throw new Error('Expiry must not call Stripe');})}));
import {checkExpiringAutopayCards} from './cardExpiryCheck';
describe('concurrent card expiry checks',()=>{
  it('commits one notice and one update token for simultaneous workers',async()=>{
    const testDb=getTestDb(),partner=await createPartner(),org=await createOrganization({partnerId:partner.id});
    await testDb.update(partners).set({autopayEnabled:true}).where(eq(partners.id,partner.id));
    const [connection]=await testDb.insert(stripeConnectAccounts).values({partnerId:partner.id,stripeAccountId:`acct_${randomUUID()}`,status:'connected',accountCountry:'US'}).returning();
    const [enrollment]=await testDb.insert(orgAutopayEnrollments).values({orgId:org.id,partnerId:partner.id,status:'active',generation:1,
      stripeConnectionId:connection!.id,stripeAccountId:connection!.stripeAccountId,requestRecipientEmail:'billing@example.test',effectiveFrom:new Date('2026-09-01T00:00:00Z')}).returning();
    const [method]=await testDb.insert(orgPaymentMethods).values({orgId:org.id,enrollmentId:enrollment!.id,
      stripePaymentMethodId:`pm_${randomUUID()}`,type:'card',status:'active',isAutopayMethod:true,
      cardBrand:'visa',cardLast4:'1234',cardFunding:'debit',cardExpMonth:10,cardExpYear:2026}).returning();
    const now=new Date('2026-10-02T06:28:00Z');
    const results=await Promise.all([checkExpiringAutopayCards(now),checkExpiringAutopayCards(now)]);
    expect(results.reduce((sum,result)=>sum+result.enqueued,0)).toBe(1);
    const notices=await testDb.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.dedupeKey,`card-expiring:${method!.id}`));
    expect(notices).toHaveLength(1);
    const tokens=await testDb.select().from(billingLinkTokens).where(and(eq(billingLinkTokens.enrollmentId,enrollment!.id),eq(billingLinkTokens.purpose,'enroll')));
    expect(tokens).toHaveLength(1);expect(tokens[0]?.generation).toBe(1);
    expect(await checkExpiringAutopayCards(new Date('2026-10-03T06:28:00Z'))).toEqual({enqueued:0});
  });
});
```

Register `'src/services/autopay/cardExpiryCheck.integration.test.ts'` in integration `include` and unit `exclude` before the red command. No RLS, concurrency or lock claim is delegated to a mock.

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/api && npx vitest run src/services/autopay/cardExpiryCheck.test.ts src/jobs/autopayWorker.test.ts`; missing card-expiry implementation and dispatch branch fail. Also run `pnpm test-stack up` then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/cardExpiryCheck.integration.test.ts`; the service import fails before implementation.
- [ ] **Step 3: Implement** — create `cardExpiryCheck.ts`:

```ts
import {and,eq,inArray,isNull} from 'drizzle-orm';
import {db,runOutsideDbContext,withSystemDbAccessContext} from '../../db';
import {organizations,partners,orgAutopayEnrollments,orgPaymentMethods,billingNoticeOutbox} from '../../db/schema';
import {mintBillingLinkToken,buildBillingLinkUrl} from './linkTokens';
import {enqueueBillingNotice} from './noticeOutbox';
import {renderBillingNotice} from './renderBillingNotice';
import {buildAutopayDisclosure} from './consentText';
export function isCardExpiring(now:Date,year:number|null,month:number|null):boolean{
  if(!year||!month||month<1||month>12)return false;
  const expiration=Date.UTC(year,month,1);
  return now.getTime()>=expiration-30*86400000&&now.getTime()<expiration;
}
export async function checkExpiringAutopayCards(now:Date=new Date()):Promise<{enqueued:number}>{
  return runOutsideDbContext(async()=>{
    const rows=await withSystemDbAccessContext(()=>db.select({method:orgPaymentMethods,enrollment:orgAutopayEnrollments,org:organizations})
      .from(orgPaymentMethods).innerJoin(orgAutopayEnrollments,and(eq(orgAutopayEnrollments.id,orgPaymentMethods.enrollmentId),eq(orgAutopayEnrollments.orgId,orgPaymentMethods.orgId)))
      .innerJoin(organizations,eq(organizations.id,orgPaymentMethods.orgId)).innerJoin(partners,eq(partners.id,organizations.partnerId))
      .where(and(eq(orgPaymentMethods.type,'card'),eq(orgPaymentMethods.status,'active'),eq(orgPaymentMethods.isAutopayMethod,true),
        eq(orgAutopayEnrollments.status,'active'),eq(partners.autopayEnabled,true),
        inArray(organizations.status,['active','trial']),isNull(organizations.deletedAt))));
    let enqueued=0;
    for(const row of rows){
      if(!isCardExpiring(now,row.method.cardExpYear,row.method.cardExpMonth))continue;
      const contact=row.org.billingContact as {email?:string}|null;
      const toEmail=row.enrollment.requestRecipientEmail??contact?.email;
      if(!toEmail)continue;
      const created=await withSystemDbAccessContext(async()=>{
        const [currentOrg]=await db.select({id:organizations.id}).from(organizations).where(and(
          eq(organizations.id,row.org.id),isNull(organizations.deletedAt),inArray(organizations.status,['active','trial']),
        )).limit(1).for('update');
        if(!currentOrg)return false;
        const [currentEnrollment]=await db.select().from(orgAutopayEnrollments).where(and(
          eq(orgAutopayEnrollments.id,row.enrollment.id),eq(orgAutopayEnrollments.orgId,row.org.id),
          eq(orgAutopayEnrollments.status,'active'),eq(orgAutopayEnrollments.generation,row.enrollment.generation),
        )).limit(1).for('update');
        if(!currentEnrollment)return false;
        const [current]=await db.select().from(orgPaymentMethods).where(and(eq(orgPaymentMethods.id,row.method.id),
          eq(orgPaymentMethods.status,'active'),eq(orgPaymentMethods.isAutopayMethod,true))).limit(1).for('update');
        if(!current)return false;
        const dedupeKey=`card-expiring:${current.id}`;
        const [sent]=await db.select({id:billingNoticeOutbox.id}).from(billingNoticeOutbox).where(eq(billingNoticeOutbox.dedupeKey,dedupeKey)).limit(1);
        if(sent)return false;
        const link=await mintBillingLinkToken(db,{orgId:row.org.id,purpose:'enroll',enrollmentId:row.enrollment.id,generation:row.enrollment.generation,ttlDays:30});
        const url=buildBillingLinkUrl('enroll',link.token);
        const terms=await buildAutopayDisclosure(db,row.org.id,'card');
        const expiresOn=new Date(Date.UTC(current.cardExpYear!,current.cardExpMonth!,0)).toISOString().slice(0,10);
        const rendered=await renderBillingNotice('card_expiring',{autopay:{
          partnerId:row.org.partnerId,orgId:row.org.id,ctaUrl:url,scheduleText:terms.scheduleText,feeText:terms.feeText,
          vars:{partner_name:terms.partnerName,org_name:row.org.name,client_name:row.org.name,
            payment_method:`${current.cardBrand??'Card'} ••${current.cardLast4??'----'}`,expires_on:expiresOn,update_link:url},
        }});
        return (await enqueueBillingNotice(db,{orgId:row.org.id,partnerId:row.org.partnerId,enrollmentId:row.enrollment.id,
          kind:'card_expiring',seq:1,dedupeKey,toEmail,rendered})).created;
      });
      if(created)enqueued++;
    }
    return {enqueued};
  });
}
```

Add `'autopay-card-expiry-check': '28 6 * * *'` to `JOB_SCHEDULES`. The W1 autopay worker must preserve its `notice-dispatch` branch and lifecycle exports. This complete W1+W2 worker implementation fixes those internal names for the rest of this plan:

```ts
import {Queue,Worker,type Job} from 'bullmq';
import {getBullMQConnection} from '../services/redis';
import {dispatchPendingBillingNotices} from '../services/autopay/noticeOutbox';
import {drainAutopayMethodDetaches} from '../services/autopay/merge';
import {checkExpiringAutopayCards} from '../services/autopay/cardExpiryCheck';
import {jobSchedule} from './scheduleRegistry';
import {attachWorkerObservability} from './workerObservability';
export type AutopayJobData={type:'notice-dispatch'}|{type:'card-expiry-check'};
let queue:Queue<AutopayJobData>|null=null;
let worker:Worker<AutopayJobData>|null=null;
export function getAutopayQueue():Queue<AutopayJobData>{
  return queue??=new Queue<AutopayJobData>('autopay-jobs',{connection:getBullMQConnection()});
}
export async function processNoticeDispatch():Promise<{sent:number;failed:number}>{
  const result=await dispatchPendingBillingNotices();
  await drainAutopayMethodDetaches();
  return result;
}
export async function processAutopayJob(data:AutopayJobData){
  switch(data.type){
    case 'notice-dispatch':return processNoticeDispatch();
    case 'card-expiry-check':return checkExpiringAutopayCards();
    default:throw new Error(`Unknown autopay job: ${(data as {type:string}).type}`);
  }
}
export function createAutopayWorker():Worker<AutopayJobData>{
  return new Worker<AutopayJobData>('autopay-jobs',(job:Job<AutopayJobData>)=>processAutopayJob(job.data),{
    connection:getBullMQConnection(),concurrency:1,
  });
}
export async function initializeAutopayWorkers():Promise<void>{
  if(worker)return;
  worker=createAutopayWorker();attachWorkerObservability(worker,'autopayWorker');
  worker.on('error',error=>console.error('[AutopayWorker]',error));
  const q=getAutopayQueue();
  await q.add('notice-dispatch',{type:'notice-dispatch'},{
    jobId:'billing-notice-dispatch',repeat:{pattern:jobSchedule('billing-notice-dispatch'),tz:'UTC'},
    removeOnComplete:{count:10},removeOnFail:{count:50},
  });
  await q.add('card-expiry-check',{type:'card-expiry-check'},{
    jobId:'autopay-card-expiry-check',repeat:{pattern:jobSchedule('autopay-card-expiry-check'),tz:'UTC'},
    removeOnComplete:{count:10},removeOnFail:{count:50},
  });
}
export async function shutdownAutopayWorkers():Promise<void>{
  if(worker){await worker.close();worker=null;}
  if(queue){await queue.close();queue=null;}
}
```

The W1 registry already has one `autopayWorker` entry. Verify and update that entry to this exact loader rather than inserting a duplicate:

```ts
{
  name:'autopayWorker',placement:'global',
  load:async()=>{const m=await import('../jobs/autopayWorker');
    return {init:m.initializeAutopayWorkers,shutdown:m.shutdownAutopayWorkers};},
},
```

`worker.ts#bootWorker` uses `startRegisteredWorkers` from `services/workerRegistry.ts`; no direct autopay import belongs in `worker.ts`. The registry loader is the entrypoint registration. Run the closure contract to prove that card expiry and its renderer have no runtime import of `routes/` or socket-owner modules. The existing W1 `queue.add(...,{repeat})` notice-dispatch registration and `processNoticeDispatch` detach-drain call remain; add only the card-expiry repeatable. Never leave two notice-dispatch schedules.

- [ ] **Step 4: Run it, expect PASS** — `cd apps/api && npx vitest run src/services/autopay/cardExpiryCheck.test.ts src/jobs/autopayWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts`. `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/autopay/cardExpiryCheck.integration.test.ts`, then `pnpm test-stack down` from the root. Expect one committed notice and one token under simultaneous workers.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/autopay/cardExpiryCheck.ts apps/api/src/services/autopay/cardExpiryCheck.test.ts apps/api/src/services/autopay/cardExpiryCheck.integration.test.ts apps/api/vitest.config.ts apps/api/vitest.integration.config.ts apps/api/src/jobs/autopayWorker.ts apps/api/src/jobs/autopayWorker.test.ts apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/workerRegistry.ts` then `git commit -m "feat(billing): schedule saved card expiry notices"`.

### Task 14: Payments settings form and inherited org overrides (W2b)

**Files:** Create `apps/api/src/services/autopay/paymentSettingsView.ts` (private settings response projection), `apps/api/src/services/autopay/paymentSettingsView.test.ts` (raw/inherited/default projection contract), `apps/web/src/components/billing/PaymentsSettingsTab.tsx` (form, loading and save hook), `apps/web/src/components/billing/OrgPaymentsSettingsSection.tsx` (controlled org section), `apps/web/src/components/billing/PaymentsSettingsTab.test.tsx` (inheritance and money validation); Modify `apps/api/src/routes/billingPaymentSettings.ts` (add raw/inherited response projection after W1); Modify `apps/web/src/locales/en/billing.json`, `apps/web/src/locales/de-DE/billing.json`, `apps/web/src/locales/es-419/billing.json`, `apps/web/src/locales/fr-CA/billing.json`, `apps/web/src/locales/fr-FR/billing.json`, `apps/web/src/locales/it-IT/billing.json`, `apps/web/src/locales/pt-BR/billing.json`, `apps/web/src/locales/tr-TR/billing.json` (identical new English fallback leaves).

**Interfaces:** Consumes C4 `resolveBillingPaymentSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveBillingPaymentSettings>` and C7 GET/PUT settings routes. Produces `PaymentSettingsView`, `PaymentValues`, `usePaymentSettings(orgId?: string)`, `PaymentFields`, and the C8 default component exports. C7 GET responses retain `effective` and `autopayEnabled`, adding `values` (stored nullable overrides) and `inherited` (partner resolution for orgs, code defaults for partner). Never derive raw overrides from effective values. `InheritedField` is the verified input component in `components/shared/InheritedField.tsx`; selects use its blank/source convention with a visible source line. Forms use one page Save, never autosave switches.

- [ ] **Step 1: Write the failing test** — create `PaymentsSettingsTab.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import PaymentsSettingsTab from './PaymentsSettingsTab';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const inherited = {
  autopayOffsetDays: { value: 7, source: 'partner' },
  autopayOffsetRule: { value: 'later', source: 'partner' },
  autopayCap: { value: { enabled: true, amount: '500.00', currency: 'USD' }, source: 'partner' },
  achMode: { value: 'ach_preferred', source: 'default' },
};
const values = { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null,
  autopayCapAmount: null, autopayCapCurrency: null, achMode: null };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(
    init?.method === 'PUT' ? { success: true } : { autopayEnabled: true, values, inherited, effective: inherited }));
});
function mount() {
  return render(<I18nextProvider i18n={i18n}><PaymentsSettingsTab orgId="11111111-1111-4111-8111-111111111111" /></I18nextProvider>);
}
it('keeps blank distinct from explicit unlimited and submits decimal cap without floats', async () => {
  mount();
  const days = await screen.findByTestId('autopay-offset-days');
  expect(days).toHaveValue(null);
  expect(days).toHaveAttribute('placeholder', '7');
  fireEvent.change(screen.getByTestId('autopay-cap-enabled'), { target: { value: 'false' } });
  fireEvent.click(screen.getByTestId('autopay-settings-save'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'PUT')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ ...values, autopayCapEnabled: false });
});
it('requires amount and currency together and does not accept exponent money', async () => {
  mount();
  fireEvent.change(await screen.findByTestId('autopay-cap-enabled'), { target: { value: 'true' } });
  fireEvent.change(screen.getByTestId('autopay-cap-amount'), { target: { value: '1e3' } });
  expect(screen.getByTestId('autopay-settings-save')).toBeDisabled();
  fireEvent.change(screen.getByTestId('autopay-cap-amount'), { target: { value: '1000.50' } });
  fireEvent.change(screen.getByTestId('autopay-cap-currency'), { target: { value: 'USD' } });
  expect(screen.getByTestId('autopay-settings-save')).not.toBeDisabled();
});
it('fails closed when autopay is disabled', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(Response.json({ autopayEnabled: false }));
  mount();
  await waitFor(() => expect(screen.queryByTestId('autopay-settings-loading')).toBeNull());
  expect(screen.queryByTestId('autopay-settings')).toBeNull();
});
```

Create `apps/api/src/services/autopay/paymentSettingsView.test.ts`; these query-chain mocks match the helper below, and the test compares raw null with explicit false before either can be flattened away:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import type { db } from '../../db';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), enabled: vi.fn() }));
vi.mock('./billingPaymentSettings', () => ({ resolveBillingPaymentSettings: mocks.resolve }));
vi.mock('./autopayGate', () => ({ isAutopayEnabledForPartner: mocks.enabled }));
import { paymentSettingsView } from './paymentSettingsView';
const partnerId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const inherited = {
  autopayOffsetDays: { value: 7, source: 'partner' }, autopayOffsetRule: { value: 'later', source: 'partner' },
  autopayCap: { value: { enabled: true, amount: '500.00', currency: 'USD' }, source: 'partner' },
  achMode: { value: 'ach_preferred', source: 'partner' },
};
function connection(row: Record<string, unknown> | null) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { value: { select: vi.fn(() => ({ from })) } as unknown as typeof db, where, limit };
}
beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockResolvedValue(true); mocks.resolve.mockResolvedValue(inherited); });
it('retains nullable raw overrides while exposing the inherited value and source', async () => {
  const cx = connection({ autopayCapEnabled: null });
  const view = await paymentSettingsView(cx.value, partnerId, orgId);
  expect(view.values.autopayCapEnabled).toBeNull();
  expect(view.inherited.autopayCap).toEqual(inherited.autopayCap);
  expect(view.effective.autopayCap.source).toBe('partner');
  expect(mocks.resolve).toHaveBeenNthCalledWith(1, cx.value, { partnerId, orgId });
  expect(mocks.resolve).toHaveBeenNthCalledWith(2, cx.value, { partnerId });
  expect(cx.limit).toHaveBeenCalledWith(1);
});
it('preserves an explicit unlimited org cap without overwriting the inherited display', async () => {
  const cx = connection({ autopayCapEnabled: false });
  mocks.resolve.mockImplementation(async (_db, args) => args.orgId
    ? { ...inherited, autopayCap: { value: { enabled: false }, source: 'org' } } : inherited);
  const view = await paymentSettingsView(cx.value, partnerId, orgId);
  expect(view.values.autopayCapEnabled).toBe(false);
  expect(view.effective.autopayCap).toEqual({ value: { enabled: false }, source: 'org' });
  expect(view.inherited.autopayCap.value).toEqual({ enabled: true, amount: '500.00', currency: 'USD' });
});
it('returns the exact code defaults as the partner inherited tier and fails closed on rollout', async () => {
  const cx = connection(null); mocks.enabled.mockResolvedValue(false);
  const view = await paymentSettingsView(cx.value, partnerId);
  expect(view.autopayEnabled).toBe(false);
  expect(view.inherited).toEqual({ autopayOffsetDays: { value: 0, source: 'default' },
    autopayOffsetRule: { value: 'later', source: 'default' }, autopayCap: { value: { enabled: false }, source: 'default' },
    achMode: { value: 'ach_preferred', source: 'default' } });
  expect(view.values).toEqual({ autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null,
    autopayCapAmount: null, autopayCapCurrency: null, achMode: null });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/web && npx vitest run src/components/billing/PaymentsSettingsTab.test.tsx`; missing component. `cd apps/api && npx vitest run src/services/autopay/paymentSettingsView.test.ts`; missing raw projection.

- [ ] **Step 3: Implement** — create this private projection in `services/autopay/paymentSettingsView.ts`. Import `paymentSettingsView` from `../services/autopay/paymentSettingsView` in `routes/billingPaymentSettings.ts`, and return its object from both W1 authorized GET handlers, passing their already authorized partner/org IDs. Preserve their existing authorization and response status. This is a private W2 helper, not a change to a C4 signature:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { billingPaymentSettings } from '../../db/schema';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { isAutopayEnabledForPartner } from './autopayGate';
import type { db } from '../../db';

export async function paymentSettingsView(connection: typeof db, partnerId: string, orgId?: string) {
  const [row] = await connection.select().from(billingPaymentSettings).where(orgId
    ? eq(billingPaymentSettings.orgId, orgId)
    : and(eq(billingPaymentSettings.partnerId, partnerId), isNull(billingPaymentSettings.orgId))).limit(1);
  const effective = await resolveBillingPaymentSettings(connection, { partnerId, orgId });
  const inherited = orgId
    ? await resolveBillingPaymentSettings(connection, { partnerId })
    : { autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
        autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' } };
  return {
    autopayEnabled: await isAutopayEnabledForPartner(connection, partnerId), effective, inherited,
    values: {
      autopayOffsetDays: row?.autopayOffsetDays ?? null,
      autopayOffsetRule: row?.autopayOffsetRule ?? null,
      autopayCapEnabled: row?.autopayCapEnabled ?? null,
      autopayCapAmount: row?.autopayCapAmount ?? null,
      autopayCapCurrency: row?.autopayCapCurrency ?? null,
      achMode: row?.achMode ?? null,
    },
  };
}
```

The partner `inherited` projection uses the four exact W1 code defaults from spec §9.1; effective runtime settings still come exclusively from the C4 resolver. No W2 consumer reads reminder/fee fields from this UI-only `inherited` projection.

Create `PaymentsSettingsTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import InheritedField from '../shared/InheritedField';
export interface PaymentValues {
  autopayOffsetDays: number | null; autopayOffsetRule: 'earlier' | 'later' | null;
  autopayCapEnabled: boolean | null; autopayCapAmount: string | null;
  autopayCapCurrency: string | null; achMode: 'ach_preferred' | 'ach_only' | null;
}
type Effective<T> = { value: T; source: 'org' | 'partner' | 'default' };
type Resolved = {
  autopayOffsetDays: Effective<number>; autopayOffsetRule: Effective<'earlier' | 'later'>;
  autopayCap: Effective<{ enabled: false } | { enabled: true; amount: string; currency: string }>;
  achMode: Effective<'ach_preferred' | 'ach_only'>;
};
export interface PaymentSettingsView { autopayEnabled: boolean; values: PaymentValues; inherited: Resolved; effective: Resolved }
export function usePaymentSettings(orgId?: string) {
  const { t } = useTranslation('billing');
  const [view, setView] = useState<PaymentSettingsView | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const path = orgId ? `/orgs/${orgId}/billing/payment-settings` : '/partner/billing/payment-settings';
  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const response = await fetchWithAuth(path);
      if (!response.ok) throw new Error('load');
      setView(await response.json());
    } catch { setView(null); setError(true); } finally { setLoading(false); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  const values = view?.values;
  const invalid = !!values && ((values.autopayOffsetDays !== null &&
    (!Number.isInteger(values.autopayOffsetDays) || values.autopayOffsetDays < 0 || values.autopayOffsetDays > 60)) ||
    (values.autopayCapEnabled === true && (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(values.autopayCapAmount ?? '') ||
      !/[1-9]/.test(values.autopayCapAmount ?? '') || !/^[A-Z]{3}$/.test(values.autopayCapCurrency ?? ''))));
  const save = async () => {
    if (!view?.autopayEnabled || invalid || saving) return;
    setSaving(true);
    try {
      await runAction({ request: () => fetchWithAuth(path, { method: 'PUT', body: JSON.stringify(view.values) }),
        errorFallback: t('autopay.error'), successMessage: t('autopay.saved') });
      await load();
    } finally { setSaving(false); }
  };
  return { view, loading, saving, invalid, error, load, save,
    setValues: (patch: Partial<PaymentValues>) => setView(current => current ? { ...current, values: { ...current.values, ...patch } } : current) };
}
export function PaymentFields({ view, setValues, disabled = false }: {
  view: PaymentSettingsView; setValues: (patch: Partial<PaymentValues>) => void; disabled?: boolean;
}) {
  const { t } = useTranslation('billing');
  const v = view.values; const inherited = view.inherited;
  const source = (s: string) => t(`autopay.source.${s}`);
  const cap = inherited.autopayCap.value;
  const choice = (id: string, value: string, inheritedValue: string, inheritedSource: string,
    options: string[], onChange: (value: string) => void) => <label className="block space-y-1" key={id}>
    <span>{t(`autopay.${id}`)}</span>
    <select data-testid={`autopay-${id}`} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{t('autopay.inherit', { value: inheritedValue, source: source(inheritedSource) })}</option>
      {options.map(option => <option key={option} value={option}>{t(`autopay.option.${option}`)}</option>)}
    </select>
    <span className="block text-xs text-muted-foreground">{t('autopay.inherit', { value: inheritedValue, source: source(inheritedSource) })}</span>
  </label>;
  return <fieldset disabled={disabled} className="space-y-4" data-testid="autopay-settings-fields">
    <InheritedField id="autopay-offset-days" data-testid="autopay-offset-days" label={t('autopay.offset-days')}
      value={v.autopayOffsetDays === null ? '' : String(v.autopayOffsetDays)}
      onChange={value => setValues({ autopayOffsetDays: value === '' ? null : Number(value) })}
      inheritedValue={String(inherited.autopayOffsetDays.value)} inheritedSource={source(inherited.autopayOffsetDays.source)} type="number" min={0} max={60} step="1" />
    {choice('offset-rule', v.autopayOffsetRule ?? '', t(`autopay.option.${inherited.autopayOffsetRule.value}`), inherited.autopayOffsetRule.source,
      ['earlier', 'later'], value => setValues({ autopayOffsetRule: value === '' ? null : value as 'earlier' | 'later' }))}
    {choice('cap-enabled', v.autopayCapEnabled === null ? '' : String(v.autopayCapEnabled), t(`autopay.option.${String(cap.enabled)}`), inherited.autopayCap.source,
      ['false', 'true'], value => setValues({ autopayCapEnabled: value === '' ? null : value === 'true', autopayCapAmount: null, autopayCapCurrency: null }))}
    {v.autopayCapEnabled === true && <>
      <InheritedField id="autopay-cap-amount" data-testid="autopay-cap-amount" label={t('autopay.cap-amount')}
        value={v.autopayCapAmount ?? ''} onChange={value => setValues({ autopayCapAmount: value || null })}
        inheritedValue={cap.enabled ? cap.amount : null} inheritedSource={source(inherited.autopayCap.source)} />
      <InheritedField id="autopay-cap-currency" data-testid="autopay-cap-currency" label={t('autopay.cap-currency')}
        value={v.autopayCapCurrency ?? ''} onChange={value => setValues({ autopayCapCurrency: value.trim().toUpperCase() || null })}
        inheritedValue={cap.enabled ? cap.currency : null} inheritedSource={source(inherited.autopayCap.source)} />
    </>}
    {choice('ach-mode', v.achMode ?? '', t(`autopay.option.${inherited.achMode.value}`), inherited.achMode.source,
      ['ach_preferred', 'ach_only'], value => setValues({ achMode: value === '' ? null : value as 'ach_preferred' | 'ach_only' }))}
    <p>{t('autopay.achRisk')}</p>
  </fieldset>;
}
export default function PaymentsSettingsTab({ orgId }: { orgId?: string }) {
  const model = usePaymentSettings(orgId); const { t } = useTranslation('billing');
  const { can } = usePermissions(); const canManage = can('billing', 'manage');
  if (model.loading) return <p data-testid="autopay-settings-loading">{t('autopay.loading')}</p>;
  if (model.error) return <p role="alert" data-testid="autopay-settings-error">{t('autopay.error')}</p>;
  if (!model.view?.autopayEnabled) return null;
  return <section data-testid="autopay-settings" className="space-y-4">
    <h2>{t('autopay.title')}</h2>
    <PaymentFields view={model.view} setValues={model.setValues} disabled={!canManage || model.saving} />
    {model.invalid && <p role="alert">{t('autopay.invalid')}</p>}
    {canManage && <button data-testid="autopay-settings-save" disabled={model.invalid || model.saving}
      onClick={() => void model.save().catch(e => handleActionError(e, t('autopay.error')))}>{t('autopay.save')}</button>}
  </section>;
}
```

Create `OrgPaymentsSettingsSection.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { PaymentFields, type PaymentSettingsView, type PaymentValues } from './PaymentsSettingsTab';
export default function OrgPaymentsSettingsSection({ view, setValues, disabled }: {
  view: PaymentSettingsView; setValues: (patch: Partial<PaymentValues>) => void; disabled: boolean;
}) {
  const { t } = useTranslation('billing');
  if (!view.autopayEnabled) return null;
  return <section data-testid="autopay-org-settings" className="rounded-lg border bg-card p-6 space-y-4">
    <h2>{t('autopay.title')}</h2><PaymentFields view={view} setValues={setValues} disabled={disabled} />
  </section>;
}
```

Merge these leaves under `autopay` into each listed billing locale JSON. Later tasks extend this same object; existing translations remain untouched.

```json
{
  "title":"Automatic payments", "loading":"Loading automatic payments…", "error":"Could not complete this action. Please try again.",
  "saved":"Payment settings saved.", "save":"Save", "invalid":"Enter 0–60 whole days and a positive cap amount with a three-letter currency.",
  "offset-days":"Days after issue", "offset-rule":"Compared with the due date", "cap-enabled":"Automatic payment limit", "cap-amount":"Maximum amount", "cap-currency":"Currency", "ach-mode":"Payment methods",
  "inherit":"{{value}} — inherited from {{source}}", "source":{"org":"Organization","partner":"Partner default","default":"Breeze default"},
  "option":{"earlier":"Whichever is earlier","later":"Whichever is later","false":"Unlimited","true":"Limit enabled","ach_preferred":"Bank account preferred; cards accepted","ach_only":"Bank account only"},
  "achRisk":"Bank payments are available for eligible US accounts in USD. Your business is responsible for ACH returns and Stripe return fees; individual account returns can arrive up to 60 days later."
}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/web && npx vitest run src/components/billing/PaymentsSettingsTab.test.tsx src/lib/i18n/localeParity.test.ts`; `cd apps/api && npx vitest run src/services/autopay/paymentSettingsView.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/web/src/components/billing/PaymentsSettingsTab.tsx apps/web/src/components/billing/OrgPaymentsSettingsSection.tsx apps/web/src/components/billing/PaymentsSettingsTab.test.tsx apps/api/src/routes/billingPaymentSettings.ts apps/api/src/services/autopay/paymentSettingsView.ts apps/api/src/services/autopay/paymentSettingsView.test.ts apps/web/src/locales/*/billing.json` then `git commit -m "feat(billing): add inherited autopay payment settings"`.

### Task 15: Org enrollment actions and the bulk enrollment list (W2b)

**Files:** Create `apps/web/src/components/billing/autopayClient.ts` (typed read/mutation transport), `apps/web/src/components/billing/OrgAutopayCard.tsx` (per-org actions), `apps/web/src/components/billing/AutopayListPage.tsx` (bulk enrollment), `apps/web/src/components/billing/AutopayListPage.test.tsx`, `apps/web/src/components/billing/OrgAutopayCard.test.tsx`; Modify `apps/web/src/locales/en/billing.json`, `apps/web/src/locales/de-DE/billing.json`, `apps/web/src/locales/es-419/billing.json`, `apps/web/src/locales/fr-CA/billing.json`, `apps/web/src/locales/fr-FR/billing.json`, `apps/web/src/locales/it-IT/billing.json`, `apps/web/src/locales/pt-BR/billing.json`, `apps/web/src/locales/tr-TR/billing.json` (new fallback leaves).

**Interfaces:** Consumes C7 operations routes and Task 14's `usePaymentSettings`. Produces default `OrgAutopayCard({orgId})`, default `AutopayListPage()`, `AutopayRow`, `readAutopay<T>(path)`, `mutateAutopay<T>(path, body, method?)`. API status `not_requested` is a projection for absent enrollment; needs attention is a projection over a real enrollment, never a new stored status. No W4 charge/schedule buttons.

- [ ] **Step 1: Write the failing test** — `AutopayListPage.test.tsx`:

```tsx
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fetchWithAuth } from '../../stores/auth';
import AutopayListPage from './AutopayListPage';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(init?.method === 'POST'
    ? { requested: [], skipped: [{ orgId: id, reason: 'no_billing_contact' }] }
    : { data: [{ orgId: id, orgName: 'Example client', billingContact: null, status: 'not_requested', enrollment: null, method: null }], notRequestedCount: 1 }));
});
it('does not label partial bulk failure as success and retains per-org reason', async () => {
  render(<AutopayListPage />);
  fireEvent.click(await screen.findByTestId('autopay-send-now'));
  expect(await screen.findByTestId('autopay-bulk-result')).toHaveTextContent('no_billing_contact');
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ orgIds: [id] });
});
it('dismisses only the local prompt and never sends a request', async () => {
  render(<AutopayListPage />);
  fireEvent.click(await screen.findByTestId('autopay-dismiss'));
  expect(screen.queryByTestId('autopay-unasked')).toBeNull();
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, i]) => !i?.method)).toBe(true);
});
```

Create `OrgAutopayCard.test.tsx`:

```tsx
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fetchWithAuth } from '../../stores/auth';
import OrgAutopayCard from './OrgAutopayCard';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
it('requires an override when billing contact is absent and sends it only for this request', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(init?.method
    ? { requested: ['11111111-1111-4111-8111-111111111111'], skipped: [] }
    : { orgId: '11111111-1111-4111-8111-111111111111', orgName: 'Example client', billingContact: null,
        status: 'not_requested', enrollment: null, method: null, stripeReadiness:{ready:true,missing:[]} }));
  render(<OrgAutopayCard orgId="11111111-1111-4111-8111-111111111111" />);
  expect(await screen.findByTestId('autopay-request')).toBeDisabled();
  fireEvent.change(screen.getByTestId('autopay-recipient'), { target: { value: 'billing@example.com' } });
  fireEvent.click(screen.getByTestId('autopay-request'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string).recipientOverride).toBe('billing@example.com');
});
```


Add this test to the same `OrgAutopayCard.test.tsx` before implementation:

```tsx
it('disables enrollment and names missing Stripe permissions even with a valid recipient',async()=>{
  vi.mocked(fetchWithAuth).mockResolvedValue(Response.json({
    orgId:'11111111-1111-4111-8111-111111111111',orgName:'Example client',
    billingContact:{email:'billing@example.test'},status:'not_requested',enrollment:null,method:null,
    stripeReadiness:{ready:false,missing:['setup_intents_write','mandates_read']},
  }));
  render(<OrgAutopayCard orgId="11111111-1111-4111-8111-111111111111"/>);
  expect(await screen.findByTestId('autopay-request')).toBeDisabled();
  expect(screen.getByTestId('autopay-stripe-not-ready')).toHaveTextContent('setup_intents_write');
  expect(screen.getByTestId('autopay-stripe-not-ready')).toHaveTextContent('mandates_read');
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/web && npx vitest run src/components/billing/AutopayListPage.test.tsx src/components/billing/OrgAutopayCard.test.tsx`; missing modules.
- [ ] **Step 3: Implement** — create `autopayClient.ts`:

```ts
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { i18n } from '../../lib/i18n';
export interface AutopayRow {
  orgId: string; orgName: string; billingContact: { email?: string | null } | null;
  stripeReadiness: {ready:boolean;missing:string[]};
  status: 'not_requested' | 'requested' | 'active' | 'paused' | 'cancelled' | 'needs_attention';
  enrollment: { status: 'requested' | 'active' | 'paused' | 'cancelled'; generation: number; effectiveFrom: string | null; needsAttentionReason: string | null } | null;
  method: { type: 'card' | 'us_bank_account'; cardBrand: string | null; cardLast4: string | null; cardExpMonth: number | null; cardExpYear: number | null; bankName: string | null; bankLast4: string | null; status: string } | null;
}
export async function readAutopay<T>(path: string): Promise<T> {
  const response = await fetchWithAuth(path);
  if (!response.ok) throw new Error(i18n.t('billing:autopay.error'));
  return response.json() as Promise<T>;
}
export function mutateAutopay<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  return runAction<T>({ request: () => fetchWithAuth(path, { method, body: JSON.stringify(body) }),
    errorFallback: i18n.t('billing:autopay.error'), successMessage: i18n.t('billing:autopay.done') });
}
export function methodLabel(method: AutopayRow['method']): string {
  if (!method) return '—';
  return method.type === 'card'
    ? `${method.cardBrand ?? i18n.t('billing:autopay.card')} ••${method.cardLast4 ?? '????'} ${method.cardExpMonth ?? ''}/${method.cardExpYear ?? ''}`
    : `${method.bankName ?? i18n.t('billing:autopay.bank')} ••${method.bankLast4 ?? '????'}`;
}
```

Create `OrgAutopayCard.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '../../lib/runAction';
import { readAutopay, mutateAutopay, methodLabel, type AutopayRow } from './autopayClient';
export default function OrgAutopayCard({ orgId }: { orgId: string }) {
  const { t } = useTranslation('billing');
  const [row, setRow] = useState<AutopayRow | null>(null); const [error, setError] = useState(false);
  const [recipient, setRecipient] = useState(''); const [busy, setBusy] = useState(false);
  const [off, setOff] = useState(false); const [result, setResult] = useState('');
  const load = useCallback(async () => { try { setRow(await readAutopay(`/orgs/${orgId}/autopay`)); setError(false); }
    catch { setError(true); } }, [orgId]);
  useEffect(() => { setRow(null); setRecipient(''); void load(); }, [load]);
  async function act(action: 'request' | 'pause' | 'resume' | 'turn_off') {
    if (busy) return; setBusy(true);
    try {
      if (action === 'request') {
        const response = await mutateAutopay<{ requested: string[]; skipped: { orgId: string; reason: string }[] }>(
          '/billing/autopay/requests', { orgIds: [orgId], ...(recipient.trim() ? { recipientOverride: recipient.trim() } : {}) });
        setResult(response.skipped.map(item => item.reason).join(', ') || t('autopay.done'));
      } else { await mutateAutopay(`/orgs/${orgId}/autopay`, { action }, 'PATCH'); setResult(t('autopay.done')); }
      setOff(false); await load();
    } catch (e) { handleActionError(e, t('autopay.error')); } finally { setBusy(false); }
  }
  if (error) return <p data-testid="autopay-org-error" role="alert">{t('autopay.error')}</p>;
  if (!row) return <p>{t('autopay.loading')}</p>;
  const requested = row.status === 'requested'; const active = row.enrollment?.status === 'active';
  const canRequest = !active && row.status !== 'paused';
  const email = recipient.trim() || row.billingContact?.email || '';
  return <section data-testid="autopay-org-card" className="rounded-lg border bg-card p-6 space-y-3">
    <h2>{t('autopay.title')}</h2><p data-testid="autopay-status">{t(`autopay.status.${row.status}`)}</p>
    <p>{methodLabel(row.method)}</p>
    {row.method?.status === 'pending_verification' && <p>{t('autopay.pending')}</p>}
    <p>{t('autopay.effective', { date: row.enrollment?.effectiveFrom ?? '—' })}</p>
    {row.enrollment?.needsAttentionReason && <p role="alert">{row.enrollment.needsAttentionReason}</p>}
    {!row.stripeReadiness?.ready && <p role="alert" data-testid="autopay-stripe-not-ready">{t('autopay.stripeNotReady', {permissions:row.stripeReadiness?.missing.join(', ') || t('autopay.stripeDisconnected')})}</p>}
    {canRequest && <><label>{t('autopay.recipient')}<input data-testid="autopay-recipient" type="email" value={recipient}
      placeholder={row.billingContact?.email ?? ''} onChange={e => setRecipient(e.target.value)} /></label>
      <button data-testid="autopay-request" disabled={busy || !row.stripeReadiness?.ready || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={() => void act('request')}>
        {t(requested ? 'autopay.resend' : 'autopay.request')}</button></>}
    {active && <button data-testid="autopay-pause" disabled={busy} onClick={() => void act('pause')}>{t('autopay.pause')}</button>}
    {row.enrollment?.status === 'paused' && <button data-testid="autopay-resume" disabled={busy} onClick={() => void act('resume')}>{t('autopay.resume')}</button>}
    {row.enrollment && row.enrollment.status !== 'cancelled' && <button data-testid="autopay-turn-off" disabled={busy} onClick={() => setOff(true)}>{t('autopay.turnOff')}</button>}
    {off && <div data-testid="autopay-off-confirm"><p>{t('autopay.processingWarning')}</p>
      <button data-testid="autopay-off-confirm-submit" disabled={busy} onClick={() => void act('turn_off')}>{t('autopay.turnOff')}</button>
      <button data-testid="autopay-off-cancel" onClick={() => setOff(false)}>{t('autopay.cancel')}</button></div>}
    {result && <p role="status" data-testid="autopay-org-result">{result}</p>}
  </section>;
}
```

Create `AutopayListPage.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '../../lib/runAction';
import { readAutopay, mutateAutopay, methodLabel, type AutopayRow } from './autopayClient';
export default function AutopayListPage() {
  const { t } = useTranslation('billing');
  const [rows, setRows] = useState<AutopayRow[]>([]); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false); const [selected, setSelected] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ requested: string[]; skipped: { orgId: string; reason: string }[] } | null>(null);
  const load = useCallback(async () => {
    try { const response = await readAutopay<{ data: AutopayRow[] }>('/billing/autopay'); setRows(response.data); setError(false); }
    catch { setError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function send(ids: string[]) {
    if (busy || !ids.length) return; setBusy(true);
    try { setResult(await mutateAutopay('/billing/autopay/requests', { orgIds: ids })); setSelected([]); await load(); }
    catch (e) { handleActionError(e, t('autopay.error')); } finally { setBusy(false); }
  }
  if (loading) return <p>{t('autopay.loading')}</p>;
  if (error) return <p data-testid="autopay-list-error" role="alert">{t('autopay.error')}</p>;
  const unasked = rows.filter(row => row.status === 'not_requested');
  return <main data-testid="autopay-list" className="space-y-4">
    <h1 data-testid="autopay-heading">{t('autopay.title')}</h1>
    {!dismissed && unasked.length > 0 && <aside data-testid="autopay-unasked"><p>{t('autopay.unasked', { count: unasked.length })}</p>
      <button data-testid="autopay-send-now" disabled={busy} onClick={() => void send(unasked.map(row => row.orgId))}>{t('autopay.sendNow')}</button>
      <button data-testid="autopay-dismiss" onClick={() => setDismissed(true)}>{t('autopay.dismiss')}</button></aside>}
    <button data-testid="autopay-bulk-send" disabled={busy || selected.length === 0} onClick={() => void send(selected)}>{t('autopay.request')}</button>
    <table data-testid="autopay-table"><thead><tr><th>{t('autopay.select')}</th><th>{t('autopay.client')}</th><th>{t('autopay.statusLabel')}</th><th>{t('autopay.method')}</th></tr></thead>
      <tbody>{rows.map(row => <tr data-testid={`autopay-row-${row.orgId}`} key={row.orgId}>
        <td><input type="checkbox" aria-label={t('autopay.selectClient', { name: row.orgName })} data-testid={`autopay-select-${row.orgId}`}
          checked={selected.includes(row.orgId)} disabled={busy || row.enrollment?.status === 'active'}
          onChange={e => setSelected(current => e.target.checked ? [...current, row.orgId] : current.filter(id => id !== row.orgId))} /></td>
        <td><a data-testid={`autopay-client-${row.orgId}`} href={`/organizations/${row.orgId}#billing`}>{row.orgName}</a></td>
        <td>{t(`autopay.status.${row.status}`)}</td><td>{methodLabel(row.method)}</td></tr>)}</tbody></table>
    {rows.length === 0 && <p data-testid="autopay-empty">{t('autopay.empty')}</p>}
    {result && <section data-testid="autopay-bulk-result" role="status"><p>{t('autopay.requestedCount', { count: result.requested.length })}</p>
      {result.skipped.map(item => <p key={item.orgId}>{rows.find(row => row.orgId === item.orgId)?.orgName ?? item.orgId}: {item.reason}</p>)}</section>}
  </main>;
}
```

Merge the following additional `autopay` leaves into all eight billing locales:

```json
{"stripeNotReady":"Automatic payments are unavailable. Check Stripe permissions: {{permissions}}.","stripeDisconnected":"Connect Stripe first","card":"Card","bank":"Bank account","done":"Request completed.","status":{"not_requested":"Not requested","requested":"Requested","active":"Active","paused":"Paused","cancelled":"Off","needs_attention":"Needs attention"},"pending":"Bank verification is pending. No automatic payments can be made yet.","effective":"Applies to invoices issued after {{date}}", "recipient":"Request recipient override (optional)","request":"Send request","resend":"Resend request","pause":"Pause","resume":"Resume","turnOff":"Turn off","cancel":"Cancel","processingWarning":"Future automatic payments will stop. A bank payment already processing cannot be recalled.","unasked_one":"{{count}} client not yet asked","unasked_other":"{{count}} clients not yet asked","sendNow":"Send now","dismiss":"Dismiss","select":"Select","client":"Client","statusLabel":"Status","method":"Payment method","selectClient":"Select {{name}}","empty":"No clients found.","requestedCount_one":"Request sent to {{count}} client.","requestedCount_other":"Requests sent to {{count}} clients."}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/web && npx vitest run src/components/billing/AutopayListPage.test.tsx src/components/billing/OrgAutopayCard.test.tsx src/lib/i18n/localeParity.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/web/src/components/billing/autopayClient.ts apps/web/src/components/billing/OrgAutopayCard.tsx apps/web/src/components/billing/AutopayListPage.tsx apps/web/src/components/billing/AutopayListPage.test.tsx apps/web/src/components/billing/OrgAutopayCard.test.tsx apps/web/src/locales/*/billing.json` then `git commit -m "feat(billing): add org and bulk autopay enrollment controls"`.

### Task 16: Public setup, explicit return/stop actions, and portal payment methods (W2b)

**Files:** Create `apps/portal/src/lib/runAction.ts`, `apps/portal/src/lib/runAction.test.ts` (portal response adapter), `apps/portal/src/lib/autopay.ts` (DTOs), `apps/portal/src/components/portal/AutopaySetupPage.tsx`, `apps/portal/src/components/portal/AutopaySetupPage.test.tsx`, `apps/portal/src/components/portal/PaymentMethodsPage.tsx`, `apps/portal/src/components/portal/PaymentMethodsPage.test.tsx` (customer enrollment UI).

**Interfaces:** Consumes `apiGet<T>(endpoint,config?)`, `apiPost<T>(endpoint,body?,config?)`, `ApiResponse<T>` from verified `apps/portal/src/lib/api.ts`; C7 public/portal routes; W2a response `disclosures[methodType].{text,hash,feeText}`, and return `{outcome,orgId,methodLabel,feeText}`. Produces named/default `AutopaySetupPage({token?,portal?,mode?})`, default `PaymentMethodsPage()`, and a portal-local `runAction<T>` that displays every failure/success through a required `onOutcome` callback. The portal has no i18n runtime or `runAction` today; use its existing English copy convention and CSRF-aware `apiPost`, not the web store/toasts. `GET` and React mounting perform reads only. Return confirmation and stop each require a user button that sends POST.

- [ ] **Step 1: Write the failing test** — create `runAction.test.ts`:

```ts
import { expect, it, vi } from 'vitest';
import { runAction } from './runAction';
it('surfaces HTTP 200 false success and transport errors', async () => {
  const onOutcome = vi.fn();
  const value = await runAction({ request: async () => ({ data: { success: false }, statusCode: 200 }),
    onOutcome, successMessage: 'Saved', errorFallback: 'Not saved' });
  expect(value).toBeNull(); expect(onOutcome).toHaveBeenLastCalledWith('Not saved', true);
  await runAction({ request: async () => { throw new Error('offline'); }, onOutcome,
    successMessage: 'Saved', errorFallback: 'Not saved' });
  expect(onOutcome).toHaveBeenLastCalledWith('Not saved', true);
});
```

Create `AutopaySetupPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiGet, apiPost } from '@/lib/api';
import AutopaySetupPage from './AutopaySetupPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(cleanup);
const disclosure = { text: 'I authorize Example MSP under these schedule terms.', hash: 'a'.repeat(64), feeText: 'No fee applies.' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', logoUrl: null,
    scheduleText: 'Invoices are charged on the later date.', achMode: 'ach_only', enrollment: { status: 'requested' }, method: null,
    disclosures: { card: disclosure, us_bank_account: disclosure } } });
});
it('ACH-only never offers card, requires consent, and reports stale terms', async () => {
  vi.mocked(apiPost).mockResolvedValue({ error: 'Terms changed. Reload this page.', statusCode: 409 });
  render(<AutopaySetupPage token="test-token" />);
  expect(await screen.findByTestId('autopay-method-us_bank_account')).toBeChecked();
  expect(screen.queryByTestId('autopay-method-card')).toBeNull();
  expect(screen.getByTestId('autopay-setup-submit')).toBeDisabled();
  fireEvent.click(screen.getByTestId('autopay-consent'));
  fireEvent.click(screen.getByTestId('autopay-setup-submit'));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/autopay/public/test-token/setup-session',
    { methodType: 'us_bank_account', consentAccepted: true, disclosureHash: disclosure.hash }, { redirectOnUnauthorized: false }));
  expect(await screen.findByTestId('autopay-feedback')).toHaveTextContent('Terms changed');
});
it('a scanner mounting the stop page never stops payments', async () => {
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', orgName: 'Example client', processingWarning: true } });
  render(<AutopaySetupPage token="stop-token" mode="stop" />);
  expect(await screen.findByTestId('autopay-stop-confirm')).toBeTruthy();
  expect(apiPost).not.toHaveBeenCalled();
  vi.mocked(apiPost).mockResolvedValue({ data: { success: true } });
  fireEvent.click(screen.getByTestId('autopay-stop-submit'));
  await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
});
it('a return page does not activate on mount and distinguishes debit fee outcome', async () => {
  window.history.replaceState({}, '', '/autopay/return?target=public&session_id=cs_test_1');
  sessionStorage.setItem('autopay-return-token', 'test-token');
  vi.mocked(apiPost).mockResolvedValue({ data: { outcome: 'activated', orgId: 'org', methodLabel: 'Visa debit ••1234', feeText: 'No fee applies.' } });
  render(<AutopaySetupPage mode="return" />);
  expect(apiPost).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('autopay-return-submit'));
  expect(await screen.findByTestId('autopay-return-outcome')).toHaveTextContent('Visa debit ••1234 — No fee applies.');
  expect(apiPost).toHaveBeenCalledWith('/autopay/public/setup-return', { checkoutSessionId: 'cs_test_1', token: 'test-token' }, { redirectOnUnauthorized: false });
});
it('uses the actual Stripe portal return target and never sends a public token', async () => {
  window.history.replaceState({}, '', '/autopay/return?target=portal&session_id=cs_test_2');
  sessionStorage.setItem('autopay-return-token', 'another-public-tab');
  vi.mocked(apiPost).mockResolvedValue({ data: { outcome: 'pending_verification', orgId: 'org', methodLabel: 'Bank ••6789', feeText: 'No fee applies.' } });
  render(<AutopaySetupPage mode="return" />);
  fireEvent.click(screen.getByTestId('autopay-return-submit'));
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/portal/payment-methods/setup-return', { checkoutSessionId: 'cs_test_2' }, { redirectOnUnauthorized: true }));
});
```

Create `PaymentMethodsPage.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiGet, apiPost } from '@/lib/api';
import PaymentMethodsPage from './PaymentMethodsPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
afterEach(cleanup);
it('shows pending verification and confirms stop before POST', async () => {
  vi.mocked(apiGet).mockResolvedValue({ data: { partnerName: 'Example MSP', achMode: 'ach_only', scheduleText: 'Due date',
    enrollment: { status: 'active' }, method: { type: 'us_bank_account', bankName: 'Test bank', bankLast4: '6789', status: 'pending_verification' }, disclosures: {} } });
  render(<PaymentMethodsPage />);
  expect(await screen.findByTestId('autopay-payment-methods')).toHaveTextContent('Verification pending');
  fireEvent.click(screen.getByTestId('autopay-portal-stop'));
  expect(apiPost).not.toHaveBeenCalled();
  expect(await screen.findByTestId('autopay-stop-confirm')).toHaveTextContent('cannot be recalled');
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/portal && npx vitest run src/lib/runAction.test.ts src/components/portal/AutopaySetupPage.test.tsx src/components/portal/PaymentMethodsPage.test.tsx`; missing modules.
- [ ] **Step 3: Implement** — create `lib/runAction.ts`:

```ts
import type { ApiResponse } from './api';
export async function runAction<T>({ request, onOutcome, successMessage, errorFallback, validate }: {
  request: () => Promise<ApiResponse<T>>; onOutcome: (message: string, error: boolean) => void;
  successMessage: string; errorFallback: string; validate?: (data: T) => boolean;
}): Promise<T | null> {
  try {
    const result = await request();
    const body = result.data as { success?: boolean; testResult?: { success?: boolean } } | undefined;
    if (result.error || !result.data || (result.statusCode ?? 200) >= 400 || body?.success === false ||
      body?.testResult?.success === false || (validate && !validate(result.data))) {
      onOutcome(result.error || errorFallback, true); return null;
    }
    onOutcome(successMessage, false); return result.data;
  } catch { onOutcome(errorFallback, true); return null; }
}
```

Create `lib/autopay.ts`:

```ts
export type MethodType = 'card' | 'us_bank_account';
export interface AutopayPageData {
  partnerName: string; logoUrl: string | null; primaryColor?: string | null; scheduleText: string;
  achMode: 'card_only' | 'ach_preferred' | 'ach_only';
  enrollment: { status: 'requested' | 'active' | 'paused' | 'cancelled'; effectiveFrom?: string | null } | null;
  method: { type: MethodType; cardBrand?: string | null; cardLast4?: string | null; cardFunding?: string | null;
    bankName?: string | null; bankLast4?: string | null; status: string } | null;
  disclosures: Record<MethodType, { text: string; hash: string; feeText: string }>;
}
export interface SetupOutcome { outcome: 'activated' | 'pending_verification' | 'stale_generation' | 'failed'; orgId: string; methodLabel: string | null; feeText: string }
export function savedMethodLabel(method: AutopayPageData['method']): string {
  if (!method) return 'No payment method on file';
  return method.type === 'card' ? `${method.cardBrand ?? 'Card'} ${method.cardFunding ?? ''} ••${method.cardLast4 ?? '????'}`
    : `${method.bankName ?? 'Bank account'} ••${method.bankLast4 ?? '????'}`;
}
```

Create `AutopaySetupPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { runAction } from '@/lib/runAction';
import type { AutopayPageData, MethodType, SetupOutcome } from '@/lib/autopay';
export default function AutopaySetupPage({ token, portal = false, mode = 'setup' }: {
  token?: string; portal?: boolean; mode?: 'setup' | 'return' | 'stop';
}) {
  const [data, setData] = useState<AutopayPageData | null>(null);
  const [stopName, setStopName] = useState<string | null>(null);
  const [method, setMethod] = useState<MethodType>('us_bank_account');
  const [accepted, setAccepted] = useState(false); const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(''); const [failed, setFailed] = useState(false);
  const [finished, setFinished] = useState(false); const [outcome, setOutcome] = useState<SetupOutcome | null>(null);
  const config = { redirectOnUnauthorized: portal };
  const base = portal ? '/portal/payment-methods' : `/autopay/public/${encodeURIComponent(token ?? '')}`;
  const onOutcome = (message: string, error: boolean) => { setFeedback(message); setFailed(error); };
  useEffect(() => {
    if (mode === 'return') return;
    let cancelled = false;
    const path = mode === 'stop' && !portal ? `${base}/stop` : base;
    void apiGet<AutopayPageData & { orgName?: string }>(path, { redirectOnUnauthorized: portal }).then(result => {
      if (cancelled) return;
      if (!result.data) { onOutcome(result.error || 'This link is unavailable. Ask your service provider for a new one.', true); return; }
      if (mode === 'stop') { setStopName(result.data.partnerName); return; }
      setData(result.data); setMethod(result.data.achMode === 'card_only' ? 'card' : 'us_bank_account'); setAccepted(false);
    });
    return () => { cancelled = true; };
  }, [base, mode, portal]);
  async function start() {
    if (!data || !accepted || busy) return; setBusy(true);
    const result = await runAction<{ url: string }>({
      request: () => apiPost(`${base}/setup-session`, { methodType: method, consentAccepted: true, disclosureHash: data.disclosures[method].hash }, config),
      onOutcome, successMessage: 'Opening secure Stripe setup…', errorFallback: 'Could not open secure setup. Try again.',
      validate: value => typeof value.url === 'string' && value.url.startsWith('https://checkout.stripe.com/'),
    });
    if (result) {
      if (!portal && token) {
        try { sessionStorage.setItem('autopay-return-token', token); }
        catch { onOutcome('Enable session storage to return securely from Stripe, then try again.', true); setBusy(false); return; }
      }
      window.location.assign(result.url);
    } else { setBusy(false); setAccepted(false); }
  }
  async function confirmReturn() {
    if (busy) return; setBusy(true);
    const params = new URLSearchParams(window.location.search);
    const checkoutSessionId = params.get('session_id');
    const returnToken = sessionStorage.getItem('autopay-return-token');
    const returnPortal = params.get('target') === 'portal';
    if (!checkoutSessionId || (!returnPortal && !returnToken)) { onOutcome('This return link is incomplete. Contact your service provider.', true); setBusy(false); return; }
    const result = await runAction<SetupOutcome>({
      request: () => apiPost(returnPortal ? '/portal/payment-methods/setup-return' : '/autopay/public/setup-return',
        { checkoutSessionId, ...(!returnPortal ? { token: returnToken } : {}) }, { redirectOnUnauthorized: returnPortal }),
      onOutcome, successMessage: 'Setup checked.', errorFallback: 'Could not confirm setup. Try again.',
    });
    if (result) { setOutcome(result); if (!returnPortal) sessionStorage.removeItem('autopay-return-token'); } setBusy(false);
  }
  async function stop() {
    if (busy || finished) return; setBusy(true);
    const result = await runAction({ request: () => apiPost(portal ? '/portal/autopay/stop' : `${base}/stop`, {}, config),
      onOutcome, successMessage: 'Automatic payments stopped. Any payment already processing will still complete.',
      errorFallback: 'Could not stop automatic payments. Try again.' });
    setFinished(result !== null); setBusy(false);
  }
  return <section className="mx-auto max-w-xl space-y-5 p-6" data-testid="autopay-setup-page">
    {feedback && <p role={failed ? 'alert' : 'status'} data-testid="autopay-feedback">{feedback}</p>}
    {mode === 'return' ? <div data-testid="autopay-return">
      <h1>Confirm automatic payment setup</h1>
      {!outcome && <button data-testid="autopay-return-submit" disabled={busy} onClick={() => void confirmReturn()}>Confirm setup</button>}
      {outcome && <div data-testid="autopay-return-outcome">
        <h2>{({ activated: 'Automatic payments are set up', pending_verification: 'Bank verification is pending',
          stale_generation: 'This setup request is no longer current', failed: 'Setup was not completed' })[outcome.outcome]}</h2>
        {(outcome.outcome === 'activated' || outcome.outcome === 'pending_verification') && <p>{outcome.methodLabel} — {outcome.feeText}</p>}
        {outcome.outcome === 'pending_verification' && <p>Follow Stripe’s verification instructions. No automatic payment can be made until verification completes.</p>}
        {outcome.outcome === 'stale_generation' && <p>This return did not restart automatic payments. Ask your service provider for a new request.</p>}
      </div>}
    </div> : mode === 'stop' ? stopName && <div data-testid="autopay-stop-confirm">
      <h1>Stop automatic payments to {stopName}?</h1>
      <p>Future automatic payments will stop. A bank payment already processing cannot be recalled. Open invoices still need to be paid.</p>
      <button data-testid="autopay-stop-submit" disabled={busy || finished} onClick={() => void stop()}>Stop automatic payments</button>
    </div> : data && <>
      {data.logoUrl && <img src={data.logoUrl} alt={`${data.partnerName} logo`} className="max-h-16" />}
      <h1>Set up automatic payments to {data.partnerName}</h1><p>{data.scheduleText}</p>
      <p>This applies to new invoices after enrollment. You can stop automatic payments at any time.</p>
      <fieldset disabled={busy}><legend>Choose your payment method</legend>
        {(data.achMode === 'card_only' ? ['card'] : data.achMode === 'ach_only' ? ['us_bank_account'] : ['us_bank_account', 'card']).map(value => {
          const type = value as MethodType;
          return <label key={type} className="block my-3"><input type="radio" name="autopay-method" data-testid={`autopay-method-${type}`}
            checked={method === type} onChange={() => { setMethod(type); setAccepted(false); }} />
            {type === 'card' ? 'Card' : data.achMode === 'ach_preferred' ? 'Bank account (recommended)' : 'Bank account'}
            <span className="block" data-testid={`autopay-fee-${type}`}>{data.disclosures[type].feeText}</span>
          </label>;
        })}
      </fieldset>
      <p data-testid="autopay-consent-text">{data.disclosures[method].text}</p>
      <label><input data-testid="autopay-consent" type="checkbox" checked={accepted} disabled={busy} onChange={e => setAccepted(e.target.checked)} /> I agree to this authorization.</label>
      <button data-testid="autopay-setup-submit" disabled={!accepted || busy} onClick={() => void start()}>Continue to secure Stripe setup</button>
    </>}
  </section>;
}
```

Create `PaymentMethodsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import { savedMethodLabel, type AutopayPageData } from '@/lib/autopay';
import AutopaySetupPage from './AutopaySetupPage';
export default function PaymentMethodsPage() {
  const [data, setData] = useState<AutopayPageData | null>(null); const [error, setError] = useState('');
  const [view, setView] = useState<'summary' | 'setup' | 'stop'>('summary');
  useEffect(() => { let current = true;
    void apiGet<AutopayPageData>('/portal/payment-methods').then(result => {
      if (!current) return; if (result.data) setData(result.data); else setError(result.error || 'Payment methods are unavailable.');
    }); return () => { current = false; };
  }, []);
  if (error) return <p role="alert" data-testid="autopay-payment-methods-error">{error}</p>;
  if (!data) return <p>Loading payment methods…</p>;
  return <main data-testid="autopay-payment-methods" className="space-y-5">
    <h1>Payment methods</h1><p>Automatic payments: {data.enrollment?.status ?? 'Not requested'}</p>
    <p data-testid="autopay-saved-method">{savedMethodLabel(data.method)}</p>
    {data.method?.status === 'pending_verification' && <p>Verification pending — no automatic payments can be made yet.</p>}
    {data.enrollment?.status === 'active' || data.enrollment?.status === 'requested' ?
      <button data-testid="autopay-update-method" onClick={() => setView('setup')}>Update payment method</button> :
      <p>Ask your service provider to send an automatic payment request.</p>}
    {data.enrollment && data.enrollment.status !== 'cancelled' && <button data-testid="autopay-portal-stop" onClick={() => setView('stop')}>Stop automatic payments</button>}
    {view !== 'summary' && <button data-testid="autopay-back" onClick={() => setView('summary')}>Back</button>}
    {view === 'setup' && <AutopaySetupPage portal />}
    {view === 'stop' && <AutopaySetupPage portal mode="stop" />}
  </main>;
}
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/portal && npx vitest run src/lib/runAction.test.ts src/components/portal/AutopaySetupPage.test.tsx src/components/portal/PaymentMethodsPage.test.tsx`.
- [ ] **Step 5: Commit** — `git add apps/portal/src/lib/runAction.ts apps/portal/src/lib/runAction.test.ts apps/portal/src/lib/autopay.ts apps/portal/src/components/portal/AutopaySetupPage.tsx apps/portal/src/components/portal/AutopaySetupPage.test.tsx apps/portal/src/components/portal/PaymentMethodsPage.tsx apps/portal/src/components/portal/PaymentMethodsPage.test.tsx` then `git commit -m "feat(portal): add consent setup and payment method management"`.

### Task 17: Unticked card pay-and-save controls in both invoice views (W2b)

**Files:** Modify `apps/portal/src/lib/api.ts` (add consent payload to existing payment helpers and DTOs), `apps/portal/src/components/portal/PublicInvoiceView.tsx`, `apps/portal/src/components/portal/InvoiceDetailView.tsx` (explicit opt-in + runAction), `apps/portal/src/components/portal/InvoiceDetailView.test.tsx`; Create `apps/portal/src/components/portal/PublicInvoiceView.test.tsx`.

**Interfaces:** Consumes W2a invoice detail projection `autopay?: { eligible: boolean; consentText: string; consentVersion: string; disclosureHash: string } | null`; pay bodies `{saveForAutopay:boolean,consentAccepted?:true,disclosureHash?:string}`. Produces backward-compatible `portalApi.payInvoice(id,config={},autopay?)` and `portalApi.payPublicInvoice(token,autopay?)`; existing callers supplying config keep working. Always card Checkout, zero one-time payment fee, no immediate bank charge.

- [ ] **Step 1: Write the failing test** — append this self-contained test to `InvoiceDetailView.test.tsx` before modifying the component; it uses that file's verified `detail` helper:

```tsx
it('future-card authorization starts unticked and is sent only with explicit consent', async () => {
  const { portalApi } = await import('@/lib/api');
  const pay = vi.spyOn(portalApi, 'payInvoice').mockResolvedValue({ error: 'Test payment was not started.', statusCode: 409 });
  const input = detail([]);
  input.autopay = { eligible: true, consentText: 'I authorize Example MSP for future invoices.',
    consentVersion: '2026-10-01', disclosureHash: 'a'.repeat(64) };
  render(<InvoiceDetailView detail={input} />);
  const box = screen.getByTestId('autopay-save-card');
  expect((box as HTMLInputElement).checked).toBe(false);
  fireEvent.click(box);
  fireEvent.click(screen.getByTestId('invoice-pay-button'));
  await vi.waitFor(() => expect(pay).toHaveBeenCalledWith(input.invoice.id, {}, {
    saveForAutopay: true, consentAccepted: true, disclosureHash: 'a'.repeat(64) }));
  expect(screen.getByTestId('autopay-save-card-text')).toHaveTextContent(input.autopay.consentText);
  pay.mockRestore();
});
```

Create `PublicInvoiceView.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PublicInvoiceView from './PublicInvoiceView';
import { portalApi, type PublicInvoiceDetail } from '@/lib/api';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
afterEach(cleanup);
const data: PublicInvoiceDetail = {
  invoice: { id: '11111111-1111-4111-8111-111111111111', invoiceNumber: 'INV-1', status: 'sent', currencyCode: 'USD',
    total: '100.00', subtotal: '100.00', taxTotal: '0.00', amountPaid: '0.00', balance: '100.00' },
  lines: [], chargeNow: { amount: '100.00', isDeposit: false }, payable: true,
  branding: { partnerName: 'Example MSP', contactEmail: null, logoUrl: null, primaryColor: null, theme: 'classic', pageSize: 'letter' },
  autopay: { eligible: true, consentText: 'I authorize Example MSP.', consentVersion: '2026-10-01', disclosureHash: 'a'.repeat(64) },
};
it('shows unticked consent only when the server says this invoice can save a card', () => {
  const view = render(<PublicInvoiceView token="token" initial={data} />);
  expect((screen.getByTestId('autopay-save-card') as HTMLInputElement).checked).toBe(false);
  view.unmount();
  render(<PublicInvoiceView token="other-token" initial={{ ...data, autopay: null }} />);
  expect(screen.queryByTestId('autopay-save-card')).toBeNull();
});
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/portal && npx vitest run src/components/portal/InvoiceDetailView.test.tsx src/components/portal/PublicInvoiceView.test.tsx`; missing checkbox and DTO fields.
- [ ] **Step 3: Implement** — add these types in `lib/api.ts` and the optional `autopay` property to both `InvoiceDetail` and `PublicInvoiceDetail`:

```ts
export interface InvoiceAutopayDisclosure { eligible: boolean; consentText: string; consentVersion: string; disclosureHash: string }
export interface SaveForAutopayInput { saveForAutopay: boolean; consentAccepted?: true; disclosureHash?: string }
// Inside each existing invoice detail interface:
autopay?: InvoiceAutopayDisclosure | null;
```

Replace the two object entries in `portalApi`:

```ts
payInvoice: async (id: string, config: ApiRequestConfig = {}, autopay?: SaveForAutopayInput): Promise<ApiResponse<{ url: string }>> =>
  apiPost<{ url: string }>(`/portal/invoices/${id}/pay`, autopay, config),
payPublicInvoice: async (token: string, autopay?: SaveForAutopayInput): Promise<ApiResponse<{ data: { url: string } }>> =>
  apiPost<{ data: { url: string } }>(`/invoices/public/${encodeURIComponent(token)}/pay`, autopay ?? {}, { redirectOnUnauthorized: false }),
```

In each invoice component import `runAction` from `@/lib/runAction`, and declare `const [saveForAutopay, setSaveForAutopay] = useState(false);` before its early returns. Add this effect before early returns, so changed terms require fresh consent:

```tsx
useEffect(() => { setSaveForAutopay(false); }, [detail?.autopay?.disclosureHash]);
```

Place this exact control next to the existing pay button, inside the existing payable branch:

```tsx
{detail.autopay?.eligible && <label className="block text-sm">
  <input type="checkbox" data-testid="autopay-save-card" checked={saveForAutopay} disabled={paying}
    onChange={e => setSaveForAutopay(e.target.checked)} /> Use this card for future invoices
  <span className="block" data-testid="autopay-save-card-text">{detail.autopay.consentText}</span>
</label>}
```

Replace `PublicInvoiceView`'s `pay` handler:

```tsx
const pay = async () => {
  if (paying) return; setPaying(true); setPayError(null);
  const optIn = saveForAutopay && detail.autopay?.eligible;
  const result = await runAction<{ data: { url: string } }>({
    request: () => portalApi.payPublicInvoice(token, optIn ? { saveForAutopay: true, consentAccepted: true,
      disclosureHash: detail.autopay!.disclosureHash } : { saveForAutopay: false }),
    onOutcome: (message, error) => { if (error) setPayError(message); },
    successMessage: 'Opening secure checkout…', errorFallback: 'Could not start payment. Please try again.',
    validate: value => typeof value.data?.url === 'string' && value.data.url.startsWith('https://checkout.stripe.com/'),
  });
  if (result) window.location.href = result.data.url; else setPaying(false);
};
```

Replace `InvoiceDetailView`'s `payInvoice` handler, retaining its terminal-409 behavior:

```tsx
const payInvoice = async () => {
  if (paying) return; setPaying(true); setPayError(null);
  const optIn = saveForAutopay && detail.autopay?.eligible;
  const result = await runAction<{ url: string }>({
    request: async () => {
      const response = await portalApi.payInvoice(invoice.id, {}, optIn ? { saveForAutopay: true, consentAccepted: true,
        disclosureHash: detail.autopay!.disclosureHash } : { saveForAutopay: false });
      setPayTerminal(response.statusCode === 409); return response;
    },
    onOutcome: (message, error) => { if (error) setPayError(message); },
    successMessage: 'Opening secure checkout…', errorFallback: 'Could not start payment. Please try again.',
    validate: value => typeof value.url === 'string' && value.url.startsWith('https://checkout.stripe.com/'),
  });
  if (result) window.location.href = result.url; else setPaying(false);
};
```

The existing verify-on-return `portalApi.settleInvoice` mutation in `InvoiceDetailView` also runs through the adapter. Replace only its promise source with the following expression, and change downstream `res.data`/`res.error` handling to the adapter's nullable returned payload (null is already surfaced through `onOutcome`):

```tsx
runAction<{ settled: boolean; invoiceId?: string }>({
  request: () => portalApi.settleInvoice(invoiceId, sessionId),
  onOutcome: (message, error) => { if (error) { setPayError(message); setSettleState('failed'); } },
  successMessage: 'Payment checked.', errorFallback: 'Could not confirm payment. Please try again.',
}).then(result => {
  if (cancelled) return;
  if (result?.settled) window.location.replace(withBase(`/invoices/${invoiceId}`));
  else if (result) setSettleState('pending');
})
```

- [ ] **Step 4: Run it, expect PASS** — `cd apps/portal && npx vitest run src/components/portal/InvoiceDetailView.test.tsx src/components/portal/PublicInvoiceView.test.tsx`.
- [ ] **Step 5: Commit** — `git add apps/portal/src/lib/api.ts apps/portal/src/components/portal/PublicInvoiceView.tsx apps/portal/src/components/portal/InvoiceDetailView.tsx apps/portal/src/components/portal/PublicInvoiceView.test.tsx apps/portal/src/components/portal/InvoiceDetailView.test.tsx` then `git commit -m "feat(portal): offer explicit future-card authorization on invoice payments"`.

### Task 18: Mount every W2 UI module, gate navigation, and preserve public-link privacy (W2b)

**Files:** Create `apps/web/src/lib/navGates.test.ts`, `apps/web/src/lib/autopayVisibility.ts`, `apps/web/src/components/billing/AutopayComposition.test.tsx`, `apps/web/src/pages/billing/autopay.astro`, `apps/portal/src/pages/autopay/[token].astro`, `apps/portal/src/pages/autopay/return.astro`, `apps/portal/src/pages/autopay/[token]/stop.astro`, `apps/portal/src/pages/payment-methods/index.astro`, `apps/portal/src/pages/autopay/composition.test.tsx`; Modify `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx`, `apps/web/src/components/billing/OrgBillingSettings.tsx`, `apps/web/src/components/layout/Sidebar.tsx`, `apps/web/src/components/settings/SettingsCatalog.tsx`, `apps/web/src/lib/navGates.ts`, `apps/web/src/lib/settingsCatalog.ts`, `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts`, `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, `apps/web/src/lib/i18n/translationCoverage.test.ts`, `apps/web/src/locales/en/common.json`, `apps/web/src/locales/de-DE/common.json`, `apps/web/src/locales/es-419/common.json`, `apps/web/src/locales/fr-CA/common.json`, `apps/web/src/locales/fr-FR/common.json`, `apps/web/src/locales/it-IT/common.json`, `apps/web/src/locales/pt-BR/common.json`, `apps/web/src/locales/tr-TR/common.json`, `apps/web/src/locales/en/pages.json`, `apps/web/src/locales/de-DE/pages.json`, `apps/web/src/locales/es-419/pages.json`, `apps/web/src/locales/fr-CA/pages.json`, `apps/web/src/locales/fr-FR/pages.json`, `apps/web/src/locales/it-IT/pages.json`, `apps/web/src/locales/pt-BR/pages.json`, `apps/web/src/locales/tr-TR/pages.json`, `apps/web/src/locales/en/billing.json`, `apps/web/src/locales/de-DE/billing.json`, `apps/web/src/locales/es-419/billing.json`, `apps/web/src/locales/fr-CA/billing.json`, `apps/web/src/locales/fr-FR/billing.json`, `apps/web/src/locales/it-IT/billing.json`, `apps/web/src/locales/pt-BR/billing.json`, `apps/web/src/locales/tr-TR/billing.json`, `apps/portal/src/lib/navItems.ts`, `apps/portal/src/lib/navItems.test.ts`, `apps/portal/src/layouts/PortalLayout.astro`, `apps/portal/src/lib/protectedPaths.ts`, `apps/portal/src/lib/protectedPaths.test.ts`, `apps/portal/src/middleware.ts`, `apps/portal/src/middleware.test.ts`.

**Interfaces:** Consumes Tasks 14–17 default exports and `usePaymentSettings`; produces `useAutopayEnabled(): boolean` and optional `NavGate.requiresAutopay`/`NavGateContext.autopayEnabled`. Extends verified `buildPortalNavItems(branding, autopayEnabled = false)`. Uses existing `useHashTab` in `PartnerBillingSettingsPage`; hash `payments`, never a query-state tab. Existing `SETTINGS_CATALOG` is the production registry; `settingsPageRegistry.test.ts` is its reachability contract, not a production export. W3 will remove only the outer Payments visibility gate; the Autopay module remains gated.

- [ ] **Step 1: Write the failing test** — create `AutopayComposition.test.tsx`:

```tsx
import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PartnerBillingSettingsPage from './PartnerBillingSettingsPage';
import OrgBillingSettings from './OrgBillingSettings';
import { fetchWithAuth } from '../../stores/auth';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./BillingRatesTab', () => ({ default: () => null }));
vi.mock('./BillingConnectionsTab', () => ({ default: () => null }));
const resolved = { autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
  autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' } };
beforeEach(() => {
  window.location.hash = ''; vi.clearAllMocks();
  vi.mocked(fetchWithAuth).mockImplementation(async url => Response.json(String(url).endsWith('/payment-settings') ? {
    autopayEnabled: true, inherited: resolved, effective: resolved,
    values: { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null },
  } : String(url).endsWith('/autopay') ? { orgId: '11111111-1111-4111-8111-111111111111', orgName: 'Example', status: 'not_requested', billingContact: null, enrollment: null, method: null }
  : { currencyCode: 'USD', invoiceTermsDays: 30, billingContact: null, taxExempt: false, data: [] }));
});
it('mounts Payments on its exact hash and removes the other page Save', async () => {
  window.location.hash = 'payments'; render(<PartnerBillingSettingsPage />);
  expect(await screen.findByTestId('autopay-settings')).toBeInTheDocument();
  expect(screen.queryByTestId('partner-billing-save')).toBeNull();
});
it('mounts org settings and enrollment card in the existing org Billing page', async () => {
  render(<OrgBillingSettings orgId="11111111-1111-4111-8111-111111111111" />);
  expect(await screen.findByTestId('autopay-org-settings')).toBeInTheDocument();
  expect(await screen.findByTestId('autopay-org-card')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-settings-save')).toBeNull();
  expect(screen.getByTestId('org-billing-save')).toBeInTheDocument();
});
```

Create `apps/portal/src/pages/autopay/composition.test.tsx`; source assertions verify the Astro mounts and rendered React assertions verify a test id for every module:

```tsx
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AutopaySetupPage from '../../components/portal/AutopaySetupPage';
import PaymentMethodsPage from '../../components/portal/PaymentMethodsPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(async () => ({ data: { partnerName: 'Example MSP', enrollment: null, method: null } })), apiPost: vi.fn() }));
afterEach(cleanup);
it.each(['./[token].astro', './return.astro', './[token]/stop.astro'])('%s mounts the public module inside the public shell', path => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  expect(source).toContain('PublicDocumentLayout'); expect(source).toContain('<AutopaySetupPage'); expect(source).toContain('client:load');
  render(<AutopaySetupPage mode="return" />); expect(screen.getByTestId('autopay-setup-page')).toBeTruthy();
});
it('mounts payment methods in the authenticated shell', async () => {
  const source = readFileSync(new URL('../payment-methods/index.astro', import.meta.url), 'utf8');
  expect(source).toContain('<PortalLayout'); expect(source).toContain('<PaymentMethodsPage');
  render(<PaymentMethodsPage />); expect(await screen.findByTestId('autopay-payment-methods')).toBeTruthy();
});
```

Create `apps/web/src/lib/navGates.test.ts`:

```ts
import { expect, it } from 'vitest';
import { isNavGateVisible, type NavGateContext } from './navGates';
const context: NavGateContext = { isPlatformAdmin: false, permissions: [{ resource: 'billing', action: 'manage' }],
  getScope: () => 'partner', toolSourcesEnabled: false, aiForOfficeEnabled: false, serviceManagementMode: 'native' };
it('autopay navigation fails closed until its partner gate is explicitly enabled', () => {
  const gate = { requiresAutopay: true, requiredPermission: { resource: 'billing', action: 'manage' } } as const;
  expect(isNavGateVisible(gate, context)).toBe(false);
  expect(isNavGateVisible(gate, { ...context, autopayEnabled: false })).toBe(false);
  expect(isNavGateVisible(gate, { ...context, autopayEnabled: true })).toBe(true);
  expect(isNavGateVisible(gate, { ...context, autopayEnabled: true, permissions: [] })).toBe(false);
});
```

Append behavior assertions in existing nav/protected-path test files before implementation:

```ts
// navItems.test.ts — uses existing imported buildPortalNavItems.
it('payment methods is fail-closed and can be visible without a branding row', () => {
  expect(buildPortalNavItems({}).some(item => item.href === '/payment-methods')).toBe(false);
  expect(buildPortalNavItems({}, true).some(item => item.href === '/payment-methods')).toBe(true);
});
// protectedPaths.test.ts — import the existing exported functions.
it('payment methods requires login and active account, public tokens do not', () => {
  expect(isProtectedPath('/payment-methods')).toBe(true);
  expect(requiresAccountStatusGuard('/payment-methods')).toBe(true);
  expect(isProtectedPath('/autopay/opaque-token/stop')).toBe(false);
});
```

In `settingsPageRegistry.test.ts`, import `SETTINGS_CATALOG` from `../settingsCatalog` and append:

```ts
it('Payments has one hash-addressed settings home', () => {
  expect(SETTINGS_CATALOG.filter(entry => entry.id === 'billing-payments')).toEqual([
    expect.objectContaining({ href: '/settings/billing#payments', requiresAutopay: true }),
  ]);
  const page = readFileSync(join(WEB_SRC, 'components/billing/PartnerBillingSettingsPage.tsx'), 'utf8');
  expect(page).toContain("activeTab === 'payments'"); expect(page).toContain('<PaymentsSettingsTab');
  expect(page).toContain('useHashTab');
});
```

Append this test to `apps/web/src/lib/i18n/translationCoverage.test.ts`:

```ts
it('W02 fallbacks name existing exact keys and never allow an unrelated English leaf', () => {
  const english = readLocale('en');
  for (const key of AUTOPAY_W02_ENGLISH_FALLBACKS) expect(english.has(key), key).toBe(true);
  const arbitrary = new Map([['billing.json:unrelated.newCopy', 'English']]);
  expect(namespaceDuplicateRegressions(arbitrary, arbitrary, { 'billing.json': 0 })).toHaveLength(1);
});
```

Append this test to `apps/portal/src/middleware.test.ts`. The existing `contextFor`, `run`, `onRequest`, and mocked `astro:middleware` seam were read in that file; this test performs no API call:

```ts
it.each(['/autopay/example-token', '/autopay/example-token/stop', '/autopay/return'])(
  '%s is private, anonymous, and read-only during GET', async pathname => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    try {
      const response = await run(contextFor(pathname, { signedIn: false }));
      expect(response.status).toBe(200);
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  },
);
```

- [ ] **Step 2: Run it, expect FAIL** — `cd apps/web && npx vitest run src/components/billing/AutopayComposition.test.tsx src/lib/__tests__/settingsPageRegistry.test.ts`; `cd apps/portal && npx vitest run src/pages/autopay/composition.test.tsx src/lib/navItems.test.ts src/lib/protectedPaths.test.ts`.
- [ ] **Step 3: Implement** — create `apps/web/src/lib/autopayVisibility.ts`:

```ts
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';
export function useAutopayEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { let live = true;
    void fetchWithAuth('/partner/billing/payment-settings').then(async response => {
      const data = response.ok ? await response.json() : null;
      if (live) setEnabled(data?.autopayEnabled === true);
    }).catch(() => { if (live) setEnabled(false); });
    return () => { live = false; };
  }, []);
  return enabled;
}
```

In `PartnerBillingSettingsPage`, import `PaymentsSettingsTab` and `useAutopayEnabled`, add `'payments'` to `BILLING_TABS`, and declare `const autopayEnabled = useAutopayEnabled();` beside its existing hooks. Add `{ id: 'payments', labelKey: 'partnerBillingSettingsTabs.payments' }` to `TABS`; change `renderedTabs` to `TABS.filter(tab => !tab.reserved && (tab.id !== 'payments' || autopayEnabled))`. Render `{activeTab === 'payments' && autopayEnabled && <PaymentsSettingsTab />}` inside the existing tabpanel. When the hash is `payments` while loading/off, show no Payments controls; once availability loads, the same hash renders its panel. Extend the bottom Save condition with `activeTab !== 'payments'` to prevent two independent Save buttons.

In `OrgBillingSettings`, import `usePaymentSettings`, `OrgPaymentsSettingsSection`, `OrgAutopayCard`, and `usePermissions`. Declare:

```tsx
const paymentSettings = usePaymentSettings(orgId);
const { can } = usePermissions();
const canManageAutopay = can('billing', 'manage');
```

Inside the existing page `save` try block, before the existing `runAction`, execute `if (canManageAutopay && paymentSettings.view?.autopayEnabled) await paymentSettings.save();`. Add `paymentSettings.invalid` and `paymentSettings.saving` to the early save guard and disabled condition. Add `paymentSettings`/`canManageAutopay` to that callback's dependencies. This is two existing endpoint writes: if the second fails, show its error and retain current inputs; a retry is idempotent. Do not report atomic cross-endpoint saving. Inside the existing page wrapper before its final Save:

```tsx
{paymentSettings.view?.autopayEnabled && <>
  <OrgPaymentsSettingsSection view={paymentSettings.view} setValues={paymentSettings.setValues}
    disabled={saving || paymentSettings.saving || !canManageAutopay} />
  {canManageAutopay && <OrgAutopayCard orgId={orgId} />}
</>}
```

In `navGates.ts`, add optional `requiresAutopay?: boolean` to `NavGate`, optional `autopayEnabled?: boolean` to `NavGateContext`, and the first predicate `if (gate.requiresAutopay && ctx.autopayEnabled !== true) return false;`. Add the same optional field to the local `NavItem` type in `Sidebar.tsx`. Both `Sidebar` and `SettingsCatalog` import/call `useAutopayEnabled()` and pass `autopayEnabled` to their existing `isNavGateVisible` context; add it to `SettingsCatalog`'s memo dependencies. Insert this item in `navSections`' Billing group:

```ts
{ name: 'Autopay', labelKey: 'nav.autopay', href: '/billing/autopay', icon: CreditCard,
  partnerScopeOnly: true, requiresAutopay: true, requiredPermission: { resource: 'billing', action: 'manage' } },
```

Add `data-testid={item.href === '/billing/autopay' ? 'autopay-nav' : undefined}` to the nav anchor created by `renderNavItem`. Add this entry to `SETTINGS_CATALOG` (the existing `CreditCard` import is verified):

```ts
{ id: 'billing-payments', name: 'Payments', labelKey: 'nav.payments', href: '/settings/billing#payments',
  icon: CreditCard, group: 'billing', partnerScopeOnly: true, requiresAutopay: true,
  requiredPermission: { resource: 'billing', action: 'manage' } },
```

Add the literal paths `'src/components/billing/PaymentsSettingsTab.tsx'` and `'src/components/billing/autopayClient.ts'` to `TARGET_GLOBS` in `no-silent-mutations.test.ts`; the transport itself contains the mutating `fetchWithAuth` calls lexically inside `runAction`.

Create `apps/web/src/pages/billing/autopay.astro`:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import AutopayListPage from '../../components/billing/AutopayListPage';
---
<DashboardLayout titleKey="titles.billingAutopay"><AutopayListPage client:load /></DashboardLayout>
```

Create `apps/portal/src/pages/autopay/[token].astro`:

```astro
---
import PublicDocumentLayout from '../../layouts/PublicDocumentLayout.astro';
import AutopaySetupPage from '../../components/portal/AutopaySetupPage';
const { token } = Astro.params;
---
<PublicDocumentLayout title="Set up automatic payments"><AutopaySetupPage token={token!} client:load /></PublicDocumentLayout>
```

Create `apps/portal/src/pages/autopay/return.astro`:

```astro
---
import PublicDocumentLayout from '../../layouts/PublicDocumentLayout.astro';
import AutopaySetupPage from '../../components/portal/AutopaySetupPage';
---
<PublicDocumentLayout title="Confirm automatic payment setup"><AutopaySetupPage mode="return" client:load /></PublicDocumentLayout>
```

Create `apps/portal/src/pages/autopay/[token]/stop.astro`:

```astro
---
import PublicDocumentLayout from '../../../layouts/PublicDocumentLayout.astro';
import AutopaySetupPage from '../../../components/portal/AutopaySetupPage';
const { token } = Astro.params;
---
<PublicDocumentLayout title="Stop automatic payments"><AutopaySetupPage token={token!} mode="stop" client:load /></PublicDocumentLayout>
```

Create `apps/portal/src/pages/payment-methods/index.astro`:

```astro
---
import PortalLayout from '../../layouts/PortalLayout.astro';
import PaymentMethodsPage from '../../components/portal/PaymentMethodsPage';
import { apiGet } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';
import { redirectToLoginAfter401 } from '../../lib/session';
const response = await apiGet('/portal/payment-methods', buildServerApiConfig(Astro.request));
if (response.statusCode === 401) return redirectToLoginAfter401(Astro);
if (response.statusCode === 404) return new Response('Not Found', { status: 404 });
---
<PortalLayout title="Payment methods"><PaymentMethodsPage client:load /></PortalLayout>
```

Change `buildPortalNavItems`'s signature to take `autopayEnabled = false` after `branding`, and add `autopayEnabled ? { href: '/payment-methods', label: 'Payment methods' } : null` immediately after Invoices. In `PortalLayout.astro`, import `apiGet` from `../lib/api` and `buildServerApiConfig` from `../lib/server`, then replace the navItems declaration:

```ts
const paymentMethods = await apiGet('/portal/payment-methods', { ...buildServerApiConfig(Astro.request), timeoutMs: 3000 });
const navItems = buildPortalNavItems(branding, paymentMethods.statusCode === 200);
```

This uses the gated route so a missing branding row does not hide a legitimate autopay enrollment. It never sends POST during rendering. Add `'/payment-methods'` to `PORTAL_PROTECTED_PREFIXES`. Extend the existing private-token header condition in `middleware.ts` with `|| pathname.startsWith('/autopay/')`; keep its `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow, noarchive`, and `Cache-Control: no-store` values.

Add `nav.autopay = "Autopay"`, `nav.payments = "Payments"` to all eight common locales; `titles.billingAutopay = "Automatic payments"` to all eight pages locales; and `partnerBillingSettingsTabs.payments = "Payments"` to all eight billing locales. English fallback is deliberate for this rollout. The existing translation coverage test caps exact-English duplicates: do not increase its namespace budgets. Add this finite per-key exception set to `translationCoverage.test.ts`:

```ts
const AUTOPAY_W02_ENGLISH_FALLBACKS = new Set([
  'common.json:nav.autopay', 'common.json:nav.payments', 'pages.json:titles.billingAutopay',
  'billing.json:partnerBillingSettingsTabs.payments',
  ...['title','loading','error','saved','save','invalid','offset-days','offset-rule','cap-enabled','cap-amount','cap-currency','ach-mode',
    'inherit','source.org','source.partner','source.default','option.earlier','option.later','option.false','option.true',
    'option.ach_preferred','option.ach_only','achRisk','done','status.not_requested','status.requested','status.active','status.paused',
    'status.cancelled','status.needs_attention','pending','effective','recipient','request','resend','pause','resume','turnOff','cancel',
    'processingWarning','unasked_one','unasked_other','sendNow','dismiss','select','client','statusLabel','method','selectClient','empty',
    'requestedCount_one','requestedCount_other','card','bank'].map(key => `billing.json:autopay.${key}`),
]);
```

In `namespaceDuplicateRegressions`, immediately after its `for (const [key,value] of english)` line, add `if (AUTOPAY_W02_ENGLISH_FALLBACKS.has(key)) continue;`. Leave the global 20% copy threshold unchanged. 

- [ ] **Step 4: Run it, expect PASS** — `cd apps/web && npx vitest run src/components/billing/AutopayComposition.test.tsx src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/billing/OrgBillingSettings.test.tsx src/lib/navGates.test.ts src/lib/settingsCatalog.test.ts src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts`; `cd apps/portal && npx vitest run src/pages/autopay/composition.test.tsx src/lib/navItems.test.ts src/lib/protectedPaths.test.ts src/lib/sessionClearCoverage.test.ts src/lib/disabledPageCoverage.test.ts src/middleware.test.ts`.
- [ ] **Step 5: Commit** — `git add apps/web/src/lib/autopayVisibility.ts apps/web/src/components/billing/AutopayComposition.test.tsx apps/web/src/pages/billing/autopay.astro apps/web/src/components/billing/PartnerBillingSettingsPage.tsx apps/web/src/components/billing/OrgBillingSettings.tsx apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/settings/SettingsCatalog.tsx apps/web/src/lib/navGates.ts apps/web/src/lib/navGates.test.ts apps/web/src/lib/settingsCatalog.ts apps/web/src/lib/__tests__/settingsPageRegistry.test.ts apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/lib/i18n/translationCoverage.test.ts apps/web/src/locales/*/common.json apps/web/src/locales/*/pages.json apps/web/src/locales/*/billing.json apps/portal/src/pages/autopay apps/portal/src/pages/payment-methods/index.astro apps/portal/src/lib/navItems.ts apps/portal/src/lib/navItems.test.ts apps/portal/src/layouts/PortalLayout.astro apps/portal/src/lib/protectedPaths.ts apps/portal/src/lib/protectedPaths.test.ts apps/portal/src/middleware.ts apps/portal/src/middleware.test.ts` then `git commit -m "feat(billing): mount gated autopay pages and navigation"`.

### Task 19: Browser enrollment smoke with data-testid page objects (W2b)

**Files:** Create `e2e-tests/pages/AutopayEnrollmentPage.ts` and `e2e-tests/tests/autopay-enrollment.spec.ts` (live-shell browser tests with deterministic route responses; Stripe stays mocked).

**Interfaces:** Consumes the verified `test`, `expect`, `authedPage`, `cleanPage` from `e2e-tests/fixtures.ts`; `BasePage` from `e2e-tests/pages/BasePage.ts`; the test IDs in Tasks 14–18. Produces an enrollment browser regression suite, including scanner-safe stop. These browser route fixtures test actual composed UI; the API/integration tasks and Stripe lab cover real authorization, DB and Stripe interactions.

- [ ] **Step 1: Write the failing test** — create `autopay-enrollment.spec.ts` first:

```ts
import { test, expect } from '../fixtures';
import { AutopayEnrollmentPage } from '../pages/AutopayEnrollmentPage';
const orgId = '11111111-1111-4111-8111-111111111111';
const disclosure = { text: 'I authorize Example MSP to collect new invoices under the stated schedule.', hash: 'a'.repeat(64), feeText: 'Bank account: no fee. Credit card: no fee. Debit card: no fee.' };
const setup = { partnerName: 'Example MSP', logoUrl: null, scheduleText: 'On the later of issue date or due date.', achMode: 'ach_preferred',
  enrollment: { status: 'requested' }, method: null, disclosures: { card: disclosure, us_bank_account: disclosure } };
test('bulk requests, unasked banner and skipped-recipient feedback', async ({ authedPage }) => {
  await authedPage.route('**/api/v1/billing/autopay', route => route.fulfill({ json: { data: [{ orgId, orgName: 'Example client', billingContact: null,
    status: 'not_requested', enrollment: null, method: null }], notRequestedCount: 1 } }));
  await authedPage.route('**/api/v1/billing/autopay/requests', route => route.fulfill({ json: { requested: [], skipped: [{ orgId, reason: 'no_billing_contact' }] } }));
  const page = new AutopayEnrollmentPage(authedPage); await page.openList();
  await expect(page.unasked()).toBeVisible(); await page.sendNow().click();
  await expect(page.bulkResult()).toContainText('no_billing_contact');
});
test('ACH-preferred is selected, fees visible, and explicit authorization required', async ({ cleanPage }) => {
  await cleanPage.route('**/api/v1/autopay/public/test-token', route => route.fulfill({ json: setup }));
  const page = new AutopayEnrollmentPage(cleanPage); await page.openSetup();
  await expect(page.bank()).toBeChecked(); await expect(page.bankFee()).toContainText('no fee');
  await expect(page.continueSetup()).toBeDisabled(); await page.consent().check();
  await expect(page.continueSetup()).toBeEnabled(); await page.card().check();
  await expect(page.consent()).not.toBeChecked();
});
test('ACH-only never offers card and stop page GET never submits', async ({ cleanPage }) => {
  await cleanPage.route('**/api/v1/autopay/public/test-token', route => route.fulfill({ json: { ...setup, achMode: 'ach_only' } }));
  let posts = 0;
  await cleanPage.route('**/api/v1/autopay/public/stop-token/stop', route => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: { partnerName: 'Example MSP', orgName: 'Example client', processingWarning: true, success: true } });
  });
  const page = new AutopayEnrollmentPage(cleanPage); await page.openSetup(); await expect(page.card()).toHaveCount(0);
  await page.openStop(); await expect(page.stopConfirm()).toBeVisible(); expect(posts).toBe(0);
  await page.stop().click(); await expect(page.feedback()).toContainText('stopped'); expect(posts).toBe(1);
});
test('Payments hash mounts inheritance without a second save action', async ({ authedPage }) => {
  const inherited = { autopayOffsetDays: { value: 7, source: 'partner' }, autopayOffsetRule: { value: 'later', source: 'partner' },
    autopayCap: { value: { enabled: false }, source: 'partner' }, achMode: { value: 'ach_preferred', source: 'partner' } };
  await authedPage.route('**/api/v1/partner/billing/payment-settings', route => route.fulfill({ json: { autopayEnabled: true,
    values: { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null }, inherited, effective: inherited } }));
  const page = new AutopayEnrollmentPage(authedPage); await page.openPayments();
  await expect(page.settings()).toBeVisible(); await expect(page.offset()).toHaveAttribute('placeholder', '7');
  await expect(authedPage.getByTestId('partner-billing-save')).toHaveCount(0);
});
```

Extend the same spec with a real authenticated portal shell case. This setup uses the verified `global-setup.ts` Docker/psql invocation pattern and restores the fixture flag in `finally`. Run this file serially because its fixture flag is shared; no Stripe key or card data is required. Add these imports and helper to the spec:

```ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PortalVisibilityPage } from '../pages/PortalVisibilityPage';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function fixtureSql(sql: string): string {
  const descriptor = JSON.parse(readFileSync(process.env.E2E_STACK_FILE ?? path.join(root, '.breeze-stack.json'), 'utf8')) as { project: string };
  return execFileSync('docker', ['compose', '-p', descriptor.project, '--env-file', '.env', '--env-file', '.env.stack',
    '-f', 'docker-compose.yml', '-f', 'docker-compose.override.yml.dev', '-f', 'docker-compose.override.yml.worktree',
    'exec', '-T', 'postgres', 'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'breeze', '-d', 'breeze'],
    { cwd: root, input: `BEGIN; SELECT set_config('breeze.scope','system',true); ${sql} COMMIT;`, encoding: 'utf8' }).trim().split('\n').at(-1)!;
}
test.describe.configure({ mode: 'serial' });
test('authenticated portal mounts Payment methods and its navigation', async ({ cleanPage }) => {
  const where = "id IN (SELECT o.partner_id FROM organizations o JOIN portal_users u ON u.org_id=o.id WHERE u.email='portal@breeze.local')";
  const previous = fixtureSql(`SELECT autopay_enabled FROM partners WHERE ${where};`);
  expect(['t', 'f']).toContain(previous);
  fixtureSql(`UPDATE partners SET autopay_enabled=true WHERE ${where};`);
  try {
    const portal = new PortalVisibilityPage(cleanPage);
    await portal.login('portal@breeze.local', 'PortalTest123!');
    await cleanPage.goto('/portal/payment-methods');
    await expect(cleanPage.getByTestId('autopay-payment-methods')).toBeVisible();
    await expect(cleanPage.getByTestId('portal-nav-payment-methods')).toBeVisible();
  } finally { fixtureSql(`UPDATE partners SET autopay_enabled=${previous === 't' ? 'true' : 'false'} WHERE ${where};`); }
});
```

- [ ] **Step 2: Run it, expect FAIL** — with `pnpm wt-stack up` already healthy, run `cd e2e-tests && pnpm exec playwright test tests/autopay-enrollment.spec.ts --project=chromium`; missing page-object import.
- [ ] **Step 3: Implement** — create `AutopayEnrollmentPage.ts`:

```ts
import { BasePage } from './BasePage';
export class AutopayEnrollmentPage extends BasePage {
  unasked = () => this.page.getByTestId('autopay-unasked');
  sendNow = () => this.page.getByTestId('autopay-send-now');
  bulkResult = () => this.page.getByTestId('autopay-bulk-result');
  bank = () => this.page.getByTestId('autopay-method-us_bank_account');
  card = () => this.page.getByTestId('autopay-method-card');
  bankFee = () => this.page.getByTestId('autopay-fee-us_bank_account');
  consent = () => this.page.getByTestId('autopay-consent');
  continueSetup = () => this.page.getByTestId('autopay-setup-submit');
  stopConfirm = () => this.page.getByTestId('autopay-stop-confirm');
  stop = () => this.page.getByTestId('autopay-stop-submit');
  feedback = () => this.page.getByTestId('autopay-feedback');
  settings = () => this.page.getByTestId('autopay-settings');
  offset = () => this.page.getByTestId('autopay-offset-days');
  async openList() { await this.page.goto('/billing/autopay'); await this.page.getByTestId('autopay-list').waitFor(); }
  async openSetup() { await this.page.goto('/portal/autopay/test-token'); await this.consent().waitFor(); }
  async openStop() { await this.page.goto('/portal/autopay/stop-token/stop'); await this.stopConfirm().waitFor(); }
  async openPayments() { await this.page.goto('/settings/billing#payments'); await this.settings().waitFor(); }
}
```

Every DOM locator is `getByTestId`; URL predicates and route interception are network operations. Do not use text, roles, CSS, or a live Stripe secret in this suite. The authenticated portal case above exercises real server-side gating; browser route interception is never used to pretend to intercept an SSR API call.

- [ ] **Step 4: Run it, expect PASS** — `cd e2e-tests && pnpm exec playwright test tests/autopay-enrollment.spec.ts --project=chromium`; save the report and trace for any failure, then `pnpm wt-stack down` from repository root after the verification/lab finishes.
- [ ] **Step 5: Commit** — `git add e2e-tests/pages/AutopayEnrollmentPage.ts e2e-tests/tests/autopay-enrollment.spec.ts` then `git commit -m "test(billing): exercise autopay enrollment browser flows"`.

### Task 20: Verification and Stripe test-mode lab

**Files:** Test the W2a and W2b files listed in the preceding tasks; this task creates no additional application file.
**Interfaces:** Consumes the complete C1–C9 W02 implementation; produces evidence for two independently reviewable PRs, with no collection-engine behavior enabled.

- [ ] **Step 1: Confirm the implementation prerequisites and test discovery** — verify W1 has landed, the two W2 migrations sort after committed history, and the W2 integration files appear in `vitest.integration.config.ts` and are excluded from the unit config. A run printing “No test files found” or skipped real-DB tests is a failure, not validation. Record the initial failing assertion from each preceding task before accepting its passing result.
- [ ] **Step 2: Run the type and unit gates** — from the repository root, run each command separately:

```bash
pnpm --filter @breeze/api exec tsc --noEmit
pnpm exec tsc --build apps/api/tsconfig.tests.json
pnpm --filter @breeze/shared typecheck
pnpm --filter @breeze/web exec astro check
pnpm --filter @breeze/portal exec astro check
```

The API test-project build is additional to the requested API command: `.github/workflows/ci.yml` checks test types through that project. It catches incorrect mock chains and fixtures that the production-only TypeScript project cannot see. In particular, Tasks 1–2 and 5 assert exact W1 `Tx` parameter types and Task 12 passes a real transaction to `resumeAutopay`; Vitest runtime alone does not evaluate those type assertions.

```bash
cd apps/api && npx vitest run src/services/autopay/ src/routes/autopay/ src/routes/portal/paymentMethods.test.ts src/services/invoiceCheckout.test.ts src/services/stripeCheckoutCallSites.test.ts src/services/stripeFinancialEventPoller.test.ts src/jobs/autopayWorker.test.ts src/routes/orgs.test.ts src/routes/portal/invoices.test.ts src/routes/invoicesPublic.test.ts
```

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts src/services/workerRegistry.test.ts src/services/encryptedColumnRegistry.test.ts src/middleware/selfManagedDbContextRoutes.test.ts src/services/emailDomains/mailPurposes.test.ts src/services/emailDomains/mailPurposes.callSites.test.ts
```

```bash
cd packages/shared && npx vitest run src/utils/emailTemplates.test.ts
```

```bash
cd apps/web && npx vitest run src/components/billing/ src/components/settings/EmailTemplatesTab.test.tsx src/components/layout/Sidebar src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/navGates
```

```bash
cd apps/portal && npx vitest run src/components/portal/ src/pages/autopay/composition.test.tsx src/lib/navItems.test.ts src/lib/protectedPaths.test.ts src/lib/disabledPageCoverage.test.ts src/lib/runAction.test.ts src/middleware.test.ts
```

- [ ] **Step 3: Run the database contracts** — do not substitute Drizzle mocks for these tests. From the root:

```bash
pnpm test-stack up
```

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/db/schema/autopaySetupAttempts.integration.test.ts src/services/autopay/enrollmentService.integration.test.ts src/services/autopay/cardExpiryCheck.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantCascadeExecution.integration.test.ts src/__tests__/integration/tenantCascadeErasureBreadth.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/stripeFinancialEventPoller.integration.test.ts src/__tests__/integration/stripeSettle.integration.test.ts src/index.autopay.integration.test.ts
```

```bash
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
pnpm test-stack down
```

Run the root commands from the root, not from a directory retained by a previous shell. Record actual file counts and confirm that the generation race, rollback/detach, forced-RLS forge, and duplicate completion assertions ran. For CW-04/CW-05, record Task 12's `breeze_app` role and org-scope partner-invisibility controls, successful org-scoped request/pause/resume with rendered notices, raw-transaction resume rollback, permission/rollout denials, and same-partner/foreign-partner rejection without partial enrollment/token/outbox writes.

- [ ] **Step 4: Run browser and stack smoke** — start an isolated worktree stack and execute the Playwright file through the existing Chromium project:

```bash
pnpm wt-stack up
cd e2e-tests && pnpm exec playwright test tests/autopay-enrollment.spec.ts --project=chromium
```

Exercise both the MSP app and portal under the stack's configured base paths. Confirm the `payments` hash survives reload; inherited values identify their source; disabled partners have no autopay navigation; direct disabled routes fail; request recipient overrides reach only the intended address; the public return screen reflects server retrieval; and public GETs never change enrollment state. Tear down from the root after the Stripe lab:

```bash
pnpm wt-stack down
```

- [ ] **Step 5: Record evidence and prepare the PR** — no verification-only commit is necessary when there is no diff. Commit fixes in the task that owns them, rerun the affected gates, and put command results and the lab outcomes in the PR description. W2a's description states the durable consent storage refinement, its tenancy classification, the preserved W1 `Tx` boundary, and the authorized short system transaction orchestration for org-scoped staff mutations; W2b states the settings home (Billing → Payments / org Billing → Payments), levels (partner default → org override), resolver (`resolveBillingPaymentSettings`), and configuration counts (zero → one home at each level). Do not represent an unrun Stripe lab or a missing W1 prerequisite as passing.

#### Stripe test-mode lab checklist

Use only an isolated test partner, Stripe test keys, synthetic billing contacts, and the local mail sink. Record Stripe object IDs and redacted outcomes in the PR evidence; never put keys or private customer data in fixtures. W2 creates no automatic charge or invoice schedule.

- [ ] Request enrollment for an org with a billing contact, resend it, and verify the first link cannot authorize the newer generation. Bulk-request one contactless org and confirm its explicit skipped reason; retry it with a recipient override without changing stored billing contact.
- [ ] Open setup for an enabled partner and verify one Customer for that org and Stripe account. Retry concurrent requests and a simulated lost Customer response; repeat recovery beyond Stripe's idempotency retention and confirm the existing metadata-bound Customer is recovered. Verify the restricted key can list Customers as well as create them.
- [ ] Enroll a Stripe test credit card through setup-only Checkout. Confirm metadata contains `org_id`, `enrollment_id`, `generation`, and `token_id`, plus the private attempt ID. Confirm no PaymentIntent charge, invoice payment, or schedule is created.
- [ ] Enroll a Stripe test debit card and check the stored funding, brand, last four digits and expiry. The return screen must name that debit card and show no fee. Repeat the return and assert one consent and one effective enrollment transition.
- [ ] Enroll a US bank account using automatic verification. Confirm holder type, bank, last four digits and mandate are stored. Confirm an ACH-only org offers no card choice and a forged card POST fails; non-US/non-USD eligibility follows the server disclosure.
- [ ] Exercise microdeposit verification. Before verification the method is `pending_verification`, first `effective_from` is null, and there is no charge. Verify after 24 hours using the durable event poller and confirm the original authorization snapshot survives a settings change.
- [ ] Close the browser after Stripe success, run the setup reconciliation sweep, and confirm activation and enrollment email occur once. Simulate loss before saving the Session ID; its metadata must recover the durable attempt. Replay the same event and repeat the sweep.
- [ ] Begin two same-generation method updates in separate tabs and finish them in reverse order. Only the latest accepted attempt wins; the generation stays unchanged. Stop, pause/resume, or re-enroll before an old tab returns and verify it cannot reactivate or replace the current method.
- [ ] Select the unticked pay-and-save checkbox on both invoice pages. Confirm payment Checkout remains card-only, sets the Customer and `setup_future_usage: 'off_session'`, and saves consent only after invoice settlement is recorded. A declined or unsettled payment saves nothing. Repeat the same create request and verify it reuses the same session/attempt family.
- [ ] Stop through the public confirm page and through the authenticated portal. GET alone changes nothing. POST cancels future schedules, revokes tokens, removes the local method, and detaches only after commit. Force a transaction rollback and verify Stripe is not detached. An existing processing ACH attempt retains its reservation and settlement identity.
- [ ] Pause and resume through the MSP page. Pause preserves the method; resume moves eligibility to resume time and does not restore cancelled schedules. A client update while paused is refused until an allowed lifecycle transition.
- [ ] Detach the saved method directly in Stripe, then mark an ACH mandate inactive. Poll the events and verify `markPaymentMethodUnusable`, needs-attention state, staff billing notification and staff email. Rotate the restricted key on the same account and replay safely; change accounts and confirm an old-account object never overwrites current authority.
- [ ] Use a test card expiring within the 30-day UTC window. Run `card-expiry-check` twice, including concurrent execution, and verify one `card_expiring` notice and one update token. Confirm the token keeps the enrollment generation and changes only the method.
- [ ] Disable the partner switch and verify direct MSP, public and portal routes return 404 before creating Stripe objects; all navigation disappears. Already-created setup/financial objects may still be reconciled safely. Re-enable and confirm there are still no W4 collection jobs, bank pay-and-save charge path, skip page or confirm-payment page in this wave.

#### Remaining execution risks

W1 source is not present in this checkout, so implementation must reconcile its private render/worker wiring while preserving C1–C9. Real DB, browser and Stripe checks above are execution gates, not results obtained while writing this plan. Staff email delivery uses the existing best-effort staff transport; failures are surfaced/logged and do not undo enrollment, while client notices use the durable billing outbox. Losing browser session storage can prevent the public immediate return display; the reconciliation sweep still completes server-owned setup safely.
