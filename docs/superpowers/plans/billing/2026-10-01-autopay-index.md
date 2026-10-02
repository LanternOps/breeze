---
spec: docs/superpowers/specs/billing/2026-10-01-autopay-design.md
---

# Autopay — Program Index

Five waves implement the approved spec. **Every wave plan obeys this index.** Where a wave plan and
this index disagree, the index wins. Cross-wave names, types and signatures are fixed here so the
five plans, written in parallel, compose. A wave plan may **add** private helpers. It must not
rename, re-type or re-home anything below.

## Waves

| Wave | Plan | Depends on | PR shape | Ships |
|---|---|---|---|---|
| W1 Foundation | `2026-10-01-autopay-w01-foundation.md` | — | 2 PRs: W1a schema+tenancy+settings, W1b money plumbing | nothing user-visible except the admin switch |
| W2 Enrollment | `2026-10-01-autopay-w02-enrollment.md` | W1 | 2 PRs: W2a API+emails, W2b web+portal UI | clients of switched-on partners can enroll; nothing charges |
| W3 Reminders | `2026-10-01-autopay-w03-reminders.md` | W1 (outbox, settings) | 1 PR | reminders for all invoices, off by default |
| W4 Charging | `2026-10-01-autopay-w04-charging.md` | W1, W2, W3 | 2 PRs: W4a scheduler+notice, W4b collection engine+UI | autopay charges for switched-on partners |
| W5 Processing fee | `2026-10-01-autopay-w05-processing-fee.md` | W1, W2, W4 | 1 PR | MSP-configurable card/ACH fee |

W3 may be implemented in parallel with W2.

## Refinement of the spec (decided here, applies to all waves)

**One per-partner switch gates the whole feature until GA**, not only charging (spec decision 15).
`partners.autopay_enabled` (W1) hides every autopay MSP surface and refuses every autopay route
for partners without it. That covers enrollment (W2), charging (W4) and fees (W5). Reminders (W3)
are **not** gated: they are an ordinary invoice feature and default off. Reason: W2 ships before
W4, and letting any MSP collect client consent for charges Breeze cannot yet make is a support
trap. Platform admins flip it via `PATCH /admin/partners/:partnerId/autopay`.

## Cross-wave contract

### C1. Migrations

Hand-written, idempotent, system scope elected before any write, no inner `BEGIN/COMMIT`. Reserved
slots sort after the newest committed migration as of 2026-10-01 (`2026-11-19-101000-…`). **Re-check
`ls apps/api/migrations | sort | tail -1` when implementing.** If anything newer has landed, rename
the wave's files to sort after it, keeping their relative order.

| Wave | Slot prefix | Files |
|---|---|---|
| W1 | `2026-11-20-1000NN-` | `100000-autopay-enums.sql`, `100100-billing-payment-settings.sql`, `100200-org-autopay-enrollments-methods-consents.sql`, `100300-invoice-autopay-schedules-attempts.sql`, `100400-billing-notice-outbox-link-tokens.sql`, `100500-autopay-column-additions.sql` (contracts, invoices, invoice_stripe_payments, stripe_connect_accounts, partners, payment method enum) |
| W2 | `2026-11-20-1100NN-` | only if W2 needs one (none expected) |
| W3 | `2026-11-20-1200NN-` | none expected (settings columns already exist from W1) |
| W4 | `2026-11-20-1300NN-` | none expected |
| W5 | `2026-11-20-1400NN-` | `140000-accounting-fee-income-mapping.sql` (fee item/account on the accounting connection) |

All billing settings columns, including the fee and reminder columns, are created in W1, so later
waves add UI and logic without schema churn.

### C2. Drizzle schema — `apps/api/src/db/schema/autopay.ts` (W1), exported from `schema/index.ts`

Table exports and SQL names:

| Export | Table |
|---|---|
| `billingPaymentSettings` | `billing_payment_settings` |
| `orgAutopayEnrollments` | `org_autopay_enrollments` |
| `orgAutopayConsents` | `org_autopay_consents` |
| `orgPaymentMethods` | `org_payment_methods` |
| `invoiceAutopaySchedules` | `invoice_autopay_schedules` |
| `invoiceCollectionAttempts` | `invoice_collection_attempts` |
| `billingNoticeOutbox` | `billing_notice_outbox` |
| `billingLinkTokens` | `billing_link_tokens` |

Columns are exactly as spec §5, camelCased in Drizzle. Column additions, each with export-policy
classification:
- `contracts.autopayExcluded` (`autopay_excluded`, bool not null default false)
- `invoices.autopayExcluded` (`autopay_excluded`, bool not null default false)
- `invoiceStripePayments.feeAmount` (`fee_amount` numeric(12,2) not null default 0),
  `.paymentMethodType` (`payment_method_type` text null: `card`|`us_bank_account`), `.source`
  (`source` text not null default `'checkout'`: `checkout`|`autopay`)
- `stripeConnectAccounts.autopayCapabilitiesCheckedAt` (timestamptz null),
  `.autopayMissingPermissions` (text[] not null default `'{}'`)
- `partners.autopayEnabled` (`autopay_enabled` bool not null default false)
- `PAYMENT_METHODS` gains `'ach_debit'`

### C3. Shared types — `packages/shared/src/types/autopay.ts` (W1), re-exported from the types barrel

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
// + `export type X = (typeof X_CONST)[number]` for each.
```

The SQL enums carry identical values. Names: `autopay_enrollment_status`, `autopay_schedule_state`,
`collection_attempt_state`, `billing_notice_kind`, `billing_notice_status`, `billing_link_purpose`,
`org_payment_method_status`, `ach_mode`, `autopay_offset_rule`. Short vocabularies
(`cancel_source`, `failure_class`, `initiated_by`, `card_funding`, `account_holder_type`, payment
method `type`) are `text` with CHECK constraints.

### C4. Service modules (owner wave in brackets; signatures are binding)

All under `apps/api/src/services/autopay/` unless noted. `Tx` = the Drizzle transaction/db type
used elsewhere in `services/invoiceService.ts`. Amounts are decimal strings (`'123.45'`) like the
rest of billing.

```ts
// billingPaymentSettings.ts [W1]
export type SettingSource = 'org' | 'partner' | 'default';
export interface Effective<T> { value: T; source: SettingSource }
export interface EffectiveBillingPaymentSettings {
  autopayOffsetDays: Effective<number>; autopayOffsetRule: Effective<AutopayOffsetRule>;
  autopayCap: Effective<{ enabled: false } | { enabled: true; amount: string; currency: string }>;
  achMode: Effective<AchMode>;
  cardFeeBps: Effective<number>; achFeeAmount: Effective<string>;
  feeAttested: boolean; // partner row fee_attested_at != null
  remindersEnabled: Effective<boolean>; reminderBeforeDueDays: Effective<number>;
  reminderRepeatDays: Effective<number | null>; overdueReminderEveryDays: Effective<number>;
}
export async function resolveBillingPaymentSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveBillingPaymentSettings>;
export async function updatePartnerPaymentSettings(db: Tx, partnerId: string, patch: PartnerPaymentSettingsPatch, actorUserId: string): Promise<void>;
export async function updateOrgPaymentSettings(db: Tx, orgId: string, patch: OrgPaymentSettingsPatch, actorUserId: string): Promise<void>;
export const BILLING_PAYMENT_SETTINGS_DEFAULTS; // spec §9.1 code defaults

// autopayGate.ts [W1]
export async function isAutopayEnabledForPartner(db: Tx, partnerId: string): Promise<boolean>;
export function requireAutopayEnabled(): MiddlewareHandler; // 404 `autopay_not_enabled` when off

// reservation.ts [W1]
export interface LockedInvoiceForCollection { invoice: typeof invoices.$inferSelect; reservedAmount: string; unreservedBalance: string }
export async function lockInvoiceForCollection(tx: Tx, invoiceId: string): Promise<LockedInvoiceForCollection>; // SELECT … FOR UPDATE + sum of ACTIVE attempts
export async function assertNoActiveCollection(tx: Tx, invoiceId: string): Promise<void>; // throws InvoiceServiceError 409 'COLLECTION_IN_PROGRESS'

// stripeCapabilities.ts [W1]
export type AutopayStripeCapability = 'customers_write' | 'setup_intents_write' | 'payment_intents_write' | 'payment_methods_write' | 'mandates_read';
export async function probeAutopayCapabilities(stripe: Stripe): Promise<{ missing: AutopayStripeCapability[] }>;
export async function getAutopayStripeReadiness(db: Tx, partnerId: string): Promise<{ ready: boolean; missing: AutopayStripeCapability[]; stripeAccountId: string | null; accountCountry: string | null }>;

// linkTokens.ts [W1]
export async function mintBillingLinkToken(tx: Tx, input: { orgId: string; purpose: BillingLinkPurpose; enrollmentId?: string; invoiceId?: string; generation?: number; ttlDays: number }): Promise<{ token: string; id: string }>;
export async function resolveBillingLinkToken(db: Tx, token: string, purpose: BillingLinkPurpose): Promise<typeof billingLinkTokens.$inferSelect | null>; // null if expired/revoked/consumed(where single-use)
export async function revokeBillingLinkTokens(tx: Tx, filter: { orgId: string; purpose?: BillingLinkPurpose; enrollmentId?: string; invoiceId?: string }): Promise<number>;
export function buildBillingLinkUrl(purpose: BillingLinkPurpose, token: string): string; // portal base + C7 paths

// noticeOutbox.ts [W1]
export interface RenderedNotice { subject: string; html: string; text: string; frozen: Record<string, string | number | null> }
export async function enqueueBillingNotice(tx: Tx, input: { orgId: string; partnerId: string; invoiceId?: string; enrollmentId?: string; kind: BillingNoticeKind; seq: number; dedupeKey: string; toEmail: string; rendered: RenderedNotice }): Promise<{ id: string; created: boolean }>; // ON CONFLICT (dedupe_key) DO NOTHING
export type NoticeSentHandler = (tx: Tx, row: typeof billingNoticeOutbox.$inferSelect) => Promise<void>;
export function registerNoticeSentHandler(kind: BillingNoticeKind, handler: NoticeSentHandler): void; // W4 registers invoice_autopay
export async function dispatchPendingBillingNotices(now?: Date): Promise<{ sent: number; failed: number }>;

// renderBillingNotice.ts [W1 plumbing; each wave adds its kinds' renderers]
export async function renderBillingNotice(kind: BillingNoticeKind, ctx: BillingNoticeContext): Promise<RenderedNotice>; // wraps renderPartnerEmail + non-editable append blocks

// processingFee.ts [W1 — pure, full rule table]
export interface FeeQuoteInput { methodType: AutopayPaymentMethodType; cardFunding: CardFundingType | null; principal: string; currency: string; stripeAccountCountry: string | null; orgBillingCountry: string | null; orgBillingRegion: string | null; cardFeeBps: number; achFeeAmount: string; feeAttested: boolean }
export interface FeeQuote { feeAmount: string; kind: 'none' | 'card_percent' | 'ach_flat'; appliedBps: number | null; reason: 'disabled' | 'not_attested' | 'debit_or_prepaid' | 'unknown_funding' | 'non_us' | 'state_banned' | 'state_capped' | 'applied' }
export function quoteProcessingFee(input: FeeQuoteInput): FeeQuote;
export const SURCHARGE_STATE_RULES: Record<string, { banned: true } | { maxBps: number }>; // CA CT ME MA banned; CO 200

// stripeSettle.ts [W1, existing file] — new export
export async function settlePaymentIntent(partnerId: string, paymentIntentId: string): Promise<{ settled: boolean; status: Stripe.PaymentIntent.Status; invoiceId: string | null }>;

// consentText.ts [W2]
export const AUTOPAY_CONSENT_TEXT: Record<string /* version */, { card: string; us_bank_account: string }>;
export const CURRENT_AUTOPAY_CONSENT_VERSION: string;

// enrollmentService.ts [W2]
export async function requestAutopay(db: Tx, actor: InvoiceActor, input: { orgIds: string[]; recipientOverride?: string }): Promise<{ requested: string[]; skipped: { orgId: string; reason: 'no_billing_contact' | 'already_active' | 'stripe_not_ready' }[] }>;
export async function pauseAutopay(db: Tx, actor: InvoiceActor, orgId: string): Promise<void>;
export async function resumeAutopay(db: Tx, actor: InvoiceActor, orgId: string): Promise<void>;
export async function turnOffAutopay(db: Tx, actor: InvoiceActor, orgId: string): Promise<void>;
export async function stopAutopayByClient(db: Tx, input: { orgId: string; source: 'link' | 'portal'; portalUserId?: string }): Promise<void>;
export async function createAutopaySetupSession(input: { orgId: string; methodType: AutopayPaymentMethodType; consentAccepted: true; returnTo: 'public' | 'portal'; tokenId?: string; contactEmail: string; ip: string | null; userAgent: string | null }): Promise<{ url: string }>;
export async function completeAutopaySetup(partnerId: string, ref: { checkoutSessionId?: string; setupIntentId?: string }): Promise<{ outcome: 'activated' | 'pending_verification' | 'stale_generation' | 'failed'; orgId: string }>;

// paymentMethods.ts [W2]
export async function getAutopayMethod(db: Tx, orgId: string): Promise<typeof orgPaymentMethods.$inferSelect | null>; // is_autopay_method & status in (active, pending_verification)
export async function markPaymentMethodUnusable(tx: Tx, methodId: string, reason: string): Promise<void>; // also sets enrollment needs_attention_reason='method_unusable'
export async function detachPaymentMethodPostCommit(partnerId: string, methodId: string): Promise<void>;

// scheduler.ts [W4]
export function computeCollectOn(input: { issueDate: string; dueDate: string; offsetDays: number; rule: AutopayOffsetRule; noticeDate: string; leadDays: number }): string;
export function noticeLeadDays(method: { type: AutopayPaymentMethodType; accountHolderType: AccountHolderType | null }): 1 | 10;
export async function planAutopayForInvoice(tx: Tx, invoiceId: string): Promise<typeof invoiceAutopaySchedules.$inferSelect | null>;

// failureClassifier.ts [W4 — pure]
export function classifyCollectionFailure(input: { methodType: AutopayPaymentMethodType; code: string | null; declineCode: string | null; achReturnCode: string | null; piStatus: string }): CollectionFailureClass;

// collectionEngine.ts [W4]
export async function runAutopayCollection(now?: Date): Promise<{ attempted: number; deferred: number }>;
export async function attemptCollection(input: { invoiceId: string; initiatedBy: CollectionAttemptInitiator; scheduleId?: string }): Promise<{ attemptId: string | null; outcome: 'created' | 'deferred' | 'refused'; reason?: string }>;
export async function applyAttemptOutcome(partnerId: string, attemptId: string): Promise<void>; // idempotent, called by sweep + poller

// reminderSweep.ts [W3]
export async function runInvoiceReminderSweep(now?: Date): Promise<{ enqueued: number }>;
export function reminderDueToday(input: { dueDate: string; today: string; beforeDueDays: number; repeatDays: number | null; overdueEveryDays: number; lastSentSeq: number }): { kind: 'payment_reminder' | 'payment_overdue'; seq: number } | null;

// refundAllocation.ts [W5 — pure]
export function allocateReversal(input: { principal: string; fee: string; cumulativeReversedGross: string }): { principalReversed: string; feeReversed: string };
```

`InvoiceActor` is the existing actor type used by `issueInvoice`/`sendInvoiceEmail`.

### C5. Jobs (`apps/api/src/jobs/scheduleRegistry.ts` keys) and worker

One new worker file `apps/api/src/jobs/autopayWorker.ts` (W1). Queue `autopay-jobs`, registered in
`services/workerRegistry.ts` and the worker entrypoint the same way as `invoiceWorker.ts` (satisfy
`workerEntrypointClosure.contract.test.ts` + `scheduleRegistry.contract.test.ts`).

| Schedule key | Cron | Job name | Owner |
|---|---|---|---|
| `billing-notice-dispatch` | `* * * * *` | `notice-dispatch` | W1 |
| `autopay-card-expiry-check` | `28 6 * * *` | `card-expiry-check` | W2 |
| `invoice-reminder-sweep` | `18 6 * * *` | `reminder-sweep` | W3 |
| `autopay-collection-run` | `15 * * * *` | `collection-run` | W4 |

Setup-session and PaymentIntent reconciliation are **branches inside the existing**
`jobs/stripeReconcileSweep.ts` (W2 adds setup sessions, W4 adds payment intents). The financial
event poller gains event types per spec §7.5: W2 adds the `setup_intent.*`, `mandate.updated` and
`payment_method.detached` handlers, and W4 adds the `payment_intent.*` handlers.

### C6. Email templates (`packages/shared/src/utils/emailTemplates.ts`)

New `EMAIL_TEMPLATE_IDS` (wave that adds each id + defaults + var list):

| Id | Wave | Vars (closed list, in addition to the common partner/org vars) |
|---|---|---|
| `autopay_request` | W2 | `client_name`, `setup_link`, `ach_mode_text` |
| `autopay_enrolled` | W2 | `client_name`, `payment_method`, `schedule_text`, `fee_text` |
| `autopay_stopped` | W2 | `client_name`, `stopped_by`, `open_invoices_text` |
| `card_expiring` | W2 | `client_name`, `payment_method`, `expires_on`, `update_link` |
| `payment_reminder` | W3 | `invoice_number`, `amount_due`, `due_date`, `pay_link` |
| `payment_overdue` | W3 | `invoice_number`, `amount_due`, `due_date`, `days_overdue`, `pay_link` |
| `invoice_autopay` | W4 | `invoice_number`, `amount_due`, `due_date`, `charge_date`, `payment_method`, `fee_amount`, `invoice_link` |
| `payment_receipt` | W4 | `invoice_number`, `amount_paid`, `fee_amount`, `total_charged`, `payment_method`, `paid_on`, `balance_remaining` |
| `payment_failed` | W4 | `invoice_number`, `amount_due`, `failure_text`, `action_link`, `action_label` |

The Skip/Stop links, the fee disclosure and the ACH authorization reference are **append blocks**
in `renderBillingNotice`, outside the editable body. The `EmailTemplatesTab.tsx` editor lists the
new ids under a "Billing & payments" group (the wave adding the id adds its editor entry).

### C7. HTTP surface (mount in `apps/api/src/index.ts`; each wave adds an app-level test that hits its routes)

| Route | File | Wave | Auth |
|---|---|---|---|
| `GET/PUT /partner/billing/payment-settings` | `routes/billingPaymentSettings.ts` | W1 | partner scope, `BILLING_MANAGE` for PUT |
| `GET/PUT /orgs/:orgId/billing/payment-settings` | same | W1 | org access, `BILLING_MANAGE` for PUT |
| `PATCH /admin/partners/:partnerId/autopay` | `routes/admin/autopayRollout.ts` | W1 | platform admin |
| `GET /billing/autopay` · `POST /billing/autopay/requests` · `GET/PATCH /orgs/:orgId/autopay` | `routes/autopay/index.ts` | W2 | `BILLING_MANAGE` + `requireAutopayEnabled` |
| `GET /autopay/public/:token` · `POST /autopay/public/:token/setup-session` · `POST /autopay/public/setup-return` · `GET/POST /autopay/public/:token/stop` | `routes/autopay/public.ts` | W2 | token |
| `GET/POST /autopay/public/:token/skip` · `GET/POST /autopay/public/:token/confirm` | same file | W4 | token |
| `GET /portal/payment-methods` · `POST /portal/payment-methods/setup-session` · `POST /portal/payment-methods/setup-return` · `POST /portal/autopay/stop` | `routes/portal/paymentMethods.ts` | W2 | portal auth + CSRF guard |
| `POST /invoices/:id/autopay/charge-now` · `PATCH /invoices/:id/autopay` | `routes/invoices/autopay.ts` | W4 | `INVOICES_WRITE` + `requireAutopayEnabled` |

Portal page paths used by `buildBillingLinkUrl`: `enroll` → `/autopay/<token>`, `skip_invoice` →
`/autopay/<token>/skip`, `stop_autopay` → `/autopay/<token>/stop`, `confirm_payment` →
`/autopay/<token>/confirm`, setup return → `/autopay/return`.

### C8. UI files (each wave ends with a mount/registration task naming the page/shell)

| File | Wave | Mounted in |
|---|---|---|
| `apps/web/src/components/billing/PaymentsSettingsTab.tsx` (+ `OrgPaymentsSettingsSection.tsx`) | W2 creates (autopay section); W3 adds reminders section; W5 adds fees section | `PartnerBillingSettingsPage.tsx` new `payments` tab; `OrgBillingSettings.tsx` |
| `apps/web/src/components/billing/OrgAutopayCard.tsx` | W2 | `OrgBillingSettings.tsx` |
| `apps/web/src/components/billing/AutopayListPage.tsx` + `apps/web/src/pages/billing/autopay.astro` | W2 | Sidebar Billing group (`components/layout/Sidebar.tsx`) |
| Invoice autopay panel in `InvoiceDetail.tsx` (status, exclude, Charge now) | W4 | `InvoiceDetail.tsx` |
| Contract exclusion toggle | W4 | `components/contracts/ContractEditor.tsx` |
| `apps/portal/src/components/portal/AutopaySetupPage.tsx` + `pages/autopay/[token].astro`, `pages/autopay/return.astro`, `pages/autopay/[token]/stop.astro` | W2 | portal routes |
| `pages/autopay/[token]/skip.astro`, `pages/autopay/[token]/confirm.astro` | W4 | portal routes |
| `apps/portal/src/components/portal/PaymentMethodsPage.tsx` + `pages/payment-methods/index.astro` | W2 | `apps/portal/src/lib/navItems.ts` |
| "Use this card for future invoices" checkbox | W2 | `PublicInvoiceView.tsx`, `InvoiceDetailView.tsx` |

Every new screen is registered in `settingsPageRegistry` where it is a settings page (rule 8).
Every mutation uses `runAction`. Every interactive element has a `data-testid` prefixed `autopay-`.
All web strings go through react-i18next with keys in `apps/web/src/locales/en/*.json`. Other
locales get English fallbacks per the repo's locale tests.

### C9. Notifications

`NOTIFICATION_TYPES` (`packages/shared/src/constants/notificationTypes.ts`) gains `'billing'` (W2).
Event keys, carried in the notification payload `event` field: `autopay.enrolled`,
`autopay.skipped`, `autopay.stopped`, `autopay.needs_attention` (W2/W4), `payment.failed_final`,
`payment.ach_returned`, `payment.unapplied` (W4). The MSP email goes to the partner billing email
through the outbox (`kind` not in `BILLING_NOTICE_KINDS`, so it uses the existing staff-email path
used by `contractRenewal.ts`).

## Global constraints (every task in every wave)

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

## Review focus (cross-wave)

1. A client pays through the pay link while autopay is about to run: exactly one payment lands
   (W1 reservation + W4 step 0).
2. A client stops autopay while an ACH debit is processing: future charges stop and the processing
   debit still settles and books (W2 + W4).
3. An org merge with an active enrollment: the survivor is never charged with the loser's method
   (W1 merge policies).
4. Stripe reports success after Breeze recorded a manual payment: money lands in `unapplied`, never
   dropped (W4).
5. A partner turns the switch off mid-flight: no new setups or charges, and in-flight attempts
   still reconcile (W1 gate + W4).
