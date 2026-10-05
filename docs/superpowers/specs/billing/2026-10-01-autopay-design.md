# Autopay — Design Spec (billing sub-project 4b)

**Status:** Design approved in conversation 2026-10-01; written spec pending review.
**Program:** Billing. Follows Stripe Payments (`2026-06-15-stripe-payments-design.md`, which deferred
"saved cards / off-session auto-charge of recurring contracts" as sub-project 4b), the public
pay link (`2026-08-21-public-invoice-pay-link-design.md`), and the API-key Stripe model (#1610).
**Advisor quorum:** Fable + Codex (`gpt-6-astra`, xhigh, read-only) on 2026-10-01. Codex agreed
with the Breeze-native engine and amended D1–D7; every amendment is adopted below.
**Reference model:** Zomentum Payments' autopay (reviewed read-only in the product owner's own
account, 2026-10-01). What we adopted and what we did not is in §14.

---

## 1. Summary

An MSP turns on **automatic payments** for a client org. Breeze emails the client's billing
contact a "Set up automatic payments" request. The client opens a no-login page, sees the terms
and any processing fee, and saves a US bank account (ACH) or a card on a **Stripe-hosted setup
page on the MSP's own Stripe account**. From then on, every invoice issued to that org that
passes the eligibility rules is announced in its invoice email ("will be charged on or around
<date>") and charged by Breeze off-session on that date. Failures retry where retrying is
sound, then fall back to the normal pay link and payment reminders, which this project also
builds for **all** invoices. The MSP can optionally pass a credit-card percentage fee and/or an
ACH flat fee to the client, within hard legal guardrails.

Breeze stays the single invoice of record. Stripe stores the payment method and moves the money;
Breeze decides eligibility and timing, sends every email, retries, and books the result through
the existing `invoice_payments` / `recomputeInvoiceStatus()` reconcile point.

## 2. Decisions of record

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Engine | **Breeze-native scheduler + off-session PaymentIntents** on the MSP's key | Stripe Billing (Invoices/Subscriptions `charge_automatically`) would create a second invoice of record, add ~0.7% Billing fees, emit Stripe-branded emails, and risk double-booking in QBO/Xero. |
| 2 | Enrollment | **MSP enables, client authorizes.** MSP requests per org (single or bulk); the client's save-with-authorization-text IS the opt-in | Product decision. Matches the reference model. |
| 3 | MSP-entered methods | **Not in v1** | Product decision; also keeps Breeze out of card-data entry. |
| 4 | Opt-out | **Per-invoice skip + full stop**, both self-serve, MSP notified | Product decision. |
| 5 | Scope | **All invoices issued after enrollment**, subject to an amount cap and contract/invoice exclusions. Existing open invoices are not swept | Product decision. |
| 6 | ACH stance | Setting `ach_preferred` \| `ach_only` (partner default → org override) | Product decision. Non-US accounts effectively card-only. |
| 7 | Timing | **N days after issue or the due date, whichever is earlier\|later** (partner default → org override), then pushed later to satisfy notice lead time | Product decision; lead-time constraint from Codex (Reg E / Nacha). |
| 8 | Failures | Retry where sound (card soft declines day 3 and 7; ACH NSF once), else route to client action; final failure → reminders | Product decision, refined by Codex risk 5. |
| 9 | Reminders | **Built in this project, for all invoices**, off by default | Product decision; failures need a landing place. |
| 10 | Fee | **Card % (≤3%, credit only, US) + ACH flat**, applied at the payment, never an invoice line. **v1: autopay charges only** | Product decision. Hosted Checkout cannot distinguish credit from debit before charging, so pay-link card payments stay fee-free until a follow-up (§12.6). |
| 11 | Capture UX | **Stripe Checkout `mode:'setup'`**, method type chosen on Breeze's page first | No publishable key is stored (API-key model), Checkout handles Financial Connections + ACH mandate text, and fee disclosure / ACH nudge happen before redirect. |
| 12 | Detection | **Polling**, no webhooks | Matches the shipped architecture (`stripeSettle.ts`, `stripeReconcileSweep.ts`, `stripeFinancialEventPoller.ts`); MSP-owned accounts have no per-partner webhook secret. |
| 13 | Methods per org | **One active autopay method** per org in v1; "update" replaces it | Fallback across method types would change the fee mid-flight. |
| 14 | Availability | Card autopay on Stripe accounts in US, CA, GB, EEA, AU, NZ. ACH: US account + USD invoice only. India excluded (Stripe requires Subscriptions for recurring e-mandates) | Codex requirement #9 qualification. |
| 15 | Rollout | Charging enabled **per partner** by a platform-admin switch; enrollment can ship first | Codex D7. |

## 3. Scope and non-goals

**In scope:** settings (partner default → org override), enrollment (request, setup page, consent,
verification, pay-and-save by card, portal payment-methods page), opt-out (skip invoice, stop
autopay), scheduling at issue on all three issue paths, the collection engine (reservation,
PaymentIntents, settle/poll, retries, authentication recovery, ACH processing and returns,
unapplied money), "Charge now", receipts, MSP notifications, payment reminders for all invoices,
the processing fee with accounting, and the email templates for all of it.

**Non-goals (v1):**
- MSP-entered payment methods; multiple/fallback methods per org.
- SEPA / Bacs / BECS / PAD / ACSS bank debits; Indian cards off-session.
- Fees on one-time pay-link payments (§12.6).
- Stripe webhooks; Stripe Billing objects.
- Credit notes, or applying unapplied money to a different invoice.
- AI/MCP write tools for autopay (money movement). Read-only status may surface in `get_invoice`.
- Per-org email template overrides (templates stay partner-level, as today).
- Reference-model features: custom-field auto-collect filters, "delay invoice email" windows.

## 4. Ground truth this design builds on

Verified 2026-10-01 against `origin/main` (6a662cd9d8):

- **Stripe key:** one partner-axis `stripe_connect_accounts` row holding the MSP's own `sk_`/`rk_`
  key; every money path uses `getPartnerStripeClient` (`services/partnerStripe.ts:454`). Key save
  probes account, events and Checkout-sessions write only (`partnerStripe.ts:131-220`).
- **Settlement:** `recordStripePayment` (`services/stripeReconcile.ts:95-295`) is object-type
  agnostic but requires `amount == mapping.amount` (`:154`), `≤ balance` (`:162`), refuses a
  mapping already `failed` (`:119`), and hard-codes `method: 'card'` (`:167-171`).
- **Detection:** return-path settle + a 10-minute sweep over `checkout_session` rows aged 2 min–7
  days (`jobs/stripeReconcileSweep.ts:25-28`). The event poller lists only `charge.refunded` and
  `charge.dispute.*` (`services/stripeFinancialEventPoller.ts:9-16`). The webhook is legacy.
- **Revocation contract #5611:** card-only Checkout lets `expireOneSession` map
  `complete`+`unpaid` to `revoked` (`services/stripeSessionRevocation.ts:211-225`). This design
  keeps Checkout **payment** sessions card-only; ACH never goes through a Checkout payment session.
- **Reversals:** `applyStripeFinancialEvent` (`services/stripeReversalState.ts:186-425`) treats
  the mapping amount as the original payment (`:274`) and restores payments as `'card'` (`:392`).
- **Issue paths:** `issueInvoice` (`services/invoiceService.ts:1360`), quote acceptance which
  bypasses `issueInvoice` (`services/quoteAcceptService.ts:526`), and the contract sweep's
  post-commit auto-issue (`jobs/contractWorker.ts:112-130`).
- **Emails:** `EMAIL_TEMPLATE_IDS` (`packages/shared/src/utils/emailTemplates.ts:4-11`) rendered
  by `renderPartnerEmail` (`services/emailTemplates/renderPartnerEmail.ts`), partner-level
  overrides, non-editable append points (`:197`). Recipient = `organizations.billing_contact`
  (single address). The `invoice-events` queue has **no consumer** (`services/invoiceEvents.ts:5-9`).
- **Reminders:** none. The overdue sweep only flips status (`invoiceService.ts:2422-2444`).
- **Settings precedent:** `invoice_terms_days` partner → org with one resolver
  (`services/invoiceTerms.ts`) and `InheritedField` UI.
- **Contract lineage on lines:** `invoice_lines.source_contract_id` (`db/schema/invoices.ts:147`).
- **Org billing address:** `organizations.billing_address_region` / `_country`.
- **Merge policy kinds:** `orgMergeRegistry.ts:32-39` (`keep-survivor`, `custom`,
  `leave-for-erasure`, `follows-parent`, `blocks-merge`, …).

## 5. Data model

All new tables are tenant-scoped with RLS **enabled + forced** in the creating migration, and are
registered in every list CLAUDE.md requires (§5.9). Composite FKs that include `org_id` are
`DEFERRABLE INITIALLY IMMEDIATE`. Monetary amounts are `numeric(12,2)` in the invoice currency
unless suffixed `_minor`.

### 5.1 `billing_payment_settings` — dual-axis config (Partner-Wide First shape)

One partner row holds the defaults; an optional org row holds overrides. Per the Partner-Wide
First playbook, `org_id` XOR `partner_id` (both nullable, exactly one set,
`billing_payment_settings_one_owner_chk`): partner rows have `org_id NULL`, org rows have
`partner_id NULL`. The resolver finds the partner row through the org's `partner_id`. Unique
partial indexes: one partner row per partner, one org row per org.

| Column | Type | Notes |
|---|---|---|
| `autopay_offset_days` | int 0–60 | N in "N days after issue" |
| `autopay_offset_rule` | enum `earlier`\|`later` | vs. the due date |
| `autopay_cap_enabled` | bool | `false` = explicitly unlimited (distinct from NULL = inherit) |
| `autopay_cap_amount` | numeric(12,2) | used when cap enabled |
| `autopay_cap_currency` | char(3) | invoice in another currency → ineligible (`cap_currency_mismatch`) |
| `ach_mode` | enum `ach_preferred`\|`ach_only` | effective `card_only` when ACH unavailable |
| `card_fee_bps` | int 0–300 | credit cards only; 0 = no fee |
| `ach_fee_amount` | numeric(12,2) 0–25.00 | flat per ACH charge |
| `fee_attested_by` / `fee_attested_at` | uuid / timestamptz | partner row only; required before any card fee > 0 takes effect |
| `reminders_enabled` | bool | default false at partner level |
| `reminder_before_due_days` | int 1–31 | first upcoming reminder |
| `reminder_repeat_days` | int 1–31, nullable | repeat until due; NULL = no repeat |
| `overdue_reminder_every_days` | int 1–31 | default 7 |

On org rows **every column is nullable and NULL means inherit**. The partner row may also leave
columns NULL, in which case the resolver falls back to code defaults (§9.1).
`fee_attested_*` exist only on the partner row (CHECK). The platform-admin rollout switch
(`autopay_charging_enabled`) is **not** in this table. It lives with other admin-only partner
flags so MSPs can never edit it.

**RLS:** one dual-axis policy (`system OR breeze_has_org_access(org_id) OR
breeze_has_partner_access(partner_id)`) plus the additive **SELECT-only** inherited-default
branch `USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())` (template:
`2026-10-05-110000-config-policy-partner-wide-select.sql`). Register in
`DUAL_AXIS_TENANT_TABLES`. Writes to the partner row require partner scope + `billing:manage`.

### 5.2 `org_autopay_enrollments` — one per org

| Column | Notes |
|---|---|
| `org_id` (unique), `partner_id` | |
| `status` | `requested` \| `active` \| `paused` \| `cancelled` |
| `generation` | int, bumped on every request / re-enable. A setup result carrying an older generation can never (re)activate the enrollment. |
| `stripe_connection_id`, `stripe_account_id` | binding to the MSP's Stripe account at enrollment time |
| `stripe_customer_id` | one Stripe Customer per org per Stripe account, created lazily at first setup |
| `effective_from` | when the first usable method was confirmed; invoices issued earlier are never autopaid |
| `requested_by`, `requested_at`, `request_recipient_email` | |
| `paused_by/at`, `cancelled_at`, `cancel_source` (`client`\|`msp`\|`system`), `cancel_reason` | |
| `needs_attention_reason` | e.g. `method_unusable`, `stripe_account_changed`, `key_missing_permissions` |

### 5.3 `org_autopay_consents` — append-only consent history

`org_id`, `enrollment_id`, `generation`, `payment_method_id`, `consent_text_version`,
`consent_text_hash`, `fee_terms` (method type, bps or flat amount shown), `schedule_terms`
(offset/rule/cap shown), `contact_email`, `ip`, `user_agent`, `source`
(`setup_page`\|`pay_and_save`\|`portal`), `created_at`. **REVOKE UPDATE, DELETE** + immutability
trigger → also registered in `AUDIT_ADMIN_REQUIRED_TABLES`. The consent text shown is versioned
in code so `consent_text_version` resolves to exact wording.

### 5.4 `org_payment_methods`

`org_id`, `enrollment_id`, `stripe_payment_method_id`, `type` (`card`\|`us_bank_account`),
`card_brand`, `card_last4`, `card_exp_month/year`, `card_funding`
(`credit`\|`debit`\|`prepaid`\|`unknown`), `card_country`, `bank_name`, `bank_last4`,
`account_holder_type` (`individual`\|`company`), `stripe_mandate_id`, `stripe_setup_intent_id`,
`status` (`pending_verification`\|`active`\|`unusable`\|`removed`), `unusable_reason`,
`is_autopay_method` (partial unique: one per org where true, whatever the status; an unusable
method keeps the flag until it is replaced or removed),
`created_at`, `removed_at`.

### 5.5 `invoice_autopay_schedules` — one per invoice, written at issue

Immutable eligibility and terms (settings rule 6, "one snapshot moment"), plus mutable execution
state.

| Column | Notes |
|---|---|
| `org_id`, `invoice_id` (unique), `enrollment_id`, `enrollment_generation` | composite FK `(invoice_id, org_id) → invoices(id, org_id)` deferrable |
| `eligible` | bool |
| `ineligible_reason` | `not_enrolled`, `enrolled_after_issue`, `method_not_usable`, `over_cap`, `cap_currency_mismatch`, `ach_currency_unsupported`, `excluded_contract`, `excluded_invoice`, `charging_disabled`, `stripe_unavailable` |
| `collect_on` | date of initiation (not bank debit date) |
| `terms_snapshot` | jsonb: offset/rule/cap, method type + last4 named in the notice, fee terms, notice lead days |
| `notice_outbox_id`, `notice_sent_at` | charge is impossible until `notice_sent_at` is set |
| `state` | `awaiting_notice` \| `scheduled` \| `collecting` \| `retry_scheduled` \| `action_required` \| `succeeded` \| `failed` \| `skipped_by_client` \| `excluded_by_msp` \| `cancelled` \| `not_needed` |
| `state_reason`, `next_attempt_at`, `attempt_count` | |
| `client_skipped_at`, `msp_excluded_by/at` | |

### 5.6 `invoice_collection_attempts` — one per PaymentIntent

`org_id`, `invoice_id`, `schedule_id` (nullable only for `client_on_session` attempts, §6.4),
`attempt_no`, `payment_method_id`, `stripe_payment_intent_id`, `idempotency_key`,
`principal_amount`, `fee_amount`, `currency`, `state` (`reserved` \| `created` \| `confirming` \|
`processing` \| `succeeded` \| `failed` \| `requires_action` \| `canceled` \| `unapplied`),
`failure_code`, `decline_code`, `failure_class` (`soft`\|`hard`\|`auth_required`\|`nsf`\|`revoked`),
`invoice_stripe_payment_id` (mapping row), `initiated_by`
(`scheduler`\|`msp_charge_now`\|`client_on_session`),
`created_at`, `updated_at`.

**Reservation** is derived, not stored: the reserved amount on an invoice is the sum of
`principal_amount` over its attempts in `reserved|created|confirming|processing`, computed under
the invoice row lock (`SELECT … FOR UPDATE`). No new balance column can drift.

### 5.7 `billing_notice_outbox`

`org_id`, `invoice_id` (nullable), `enrollment_id` (nullable), `kind` (§8.1), `seq`,
`dedupe_key` (unique), `to_email`, `rendered` (jsonb: subject, html, text, frozen amount/date),
`status` (`pending`\|`sending`\|`sent`\|`failed`\|`cancelled`), `attempts`, `next_attempt_at`,
`sent_at`, `provider_message_id`, `last_error`. Content is rendered and frozen at enqueue, and
dispatch retries until `sent` or a terminal failure. Dependents (a schedule's charge eligibility)
key on `sent_at`, never on enqueue. This replaces the claim-then-best-effort pattern of
`contractRenewal.ts:44`, which can consume a notice without sending it.

### 5.8 `billing_link_tokens` and column additions

**`billing_link_tokens`:** `org_id`, `purpose` (`enroll`\|`skip_invoice`\|`stop_autopay`\|
`confirm_payment`), `token_hash`, `token_ct` (encrypted, registered in
`encryptedColumnRegistry.ts`, row-bound like `invoiceLinkToken.ts`), `enrollment_id`,
`invoice_id`, `generation`, `expires_at`, `consumed_at`, `revoked_at`. GET renders a
confirmation page. **Every state change is a POST** from that page, because email scanners
pre-fetch GET links.

**Column additions** (each needs export-policy classification, §5.9):
- `contracts.autopay_excluded` bool default false.
- `invoices.autopay_excluded` bool default false (settable on drafts and before charge).
- `invoice_stripe_payments.fee_amount` numeric default 0; gross = `amount + fee_amount`;
  `amount` stays the principal applied to the invoice. Also `payment_method_type` and
  `source` (`checkout`\|`autopay`).
- `PAYMENT_METHODS` gains `ach_debit` (`packages/shared/src/types/billing-enums.ts:12`), with
  QBO/Xero payment-method mapping.

### 5.9 Tenancy registrations (mechanical checklist, enforced by contract tests)

| Table | RLS shape | Cascade | Merge policy | Export policy |
|---|---|---|---|---|
| `billing_payment_settings` | dual-axis org XOR partner + SELECT branch; `DUAL_AXIS_TENANT_TABLES` | `CORE_ORG_CASCADE_DELETE_ORDER` | `keep-survivor` (loser's override row dropped) | `tablePolicy('org_id', …)` |
| `org_autopay_enrollments` | shape 1 | yes | `custom`: loser's enrollment cancelled (`cancel_source='system'`, `cancel_reason='org_merged'`) and **left on the loser**; never repointed | included; `stripe_customer_id` reviewedIncluded |
| `org_autopay_consents` | shape 1, append-only | yes + `AUDIT_ADMIN_REQUIRED_TABLES` | `leave-for-erasure` | included; jsonb → excludedOpen |
| `org_payment_methods` | shape 1 | yes | `custom`: loser's methods marked `removed`, detached post-commit, left on the loser | included |
| `invoice_autopay_schedules` | shape 1 | yes | `custom`: non-terminal loser schedules → `cancelled` (`org_merged`); then **all** rows repoint with their invoice | jsonb → excludedOpen |
| `invoice_collection_attempts` | shape 1 | yes | **`blocks-merge` while any loser attempt is `reserved|created|confirming|processing`**; otherwise repoint with the invoice (custom executor shared with schedules) | included |
| `billing_notice_outbox` | shape 1 | yes | `custom`: pending loser rows → `cancelled`; rows with an `invoice_id` repoint with the invoice; enrollment-only rows stay on the loser | jsonb → excludedOpen |
| `billing_link_tokens` | shape 1 | yes | `custom`: all loser tokens revoked; rows with an `invoice_id` repoint with the invoice | `token_hash`/`token_ct` excludedSensitive |

Plus the new columns on `contracts`, `invoices`, `invoice_stripe_payments`. Run
`tenantCascade.integration.test.ts`, `orgMerge*.test.ts`, `tenant-export-policy` and
`rls-coverage` locally before PR, because they redden only under Integration Tests / the full
unit suite.

**Principle (Codex risk 2):** autopay authority (consent, method, enrollment) is never
transferred across orgs by any merge. A survivor org re-enrolls on its own.

## 6. Enrollment

### 6.1 Prerequisite — Stripe key capability

`savePartnerStripeKey` gains capability probes for Customers, SetupIntents, PaymentIntents and
PaymentMethods write, and Mandates read, using the same invalid-id technique as the existing
Checkout probe: `resource_missing` = permitted, a permission error = missing. Results are cached
on the connection row. Autopay UI shows the exact missing permissions instead of failing late.
`online-payments.mdx` documents the restricted-key permission set.

### 6.2 MSP side

- **Org Billing tab → "Automatic payments" card:** status, method on file (brand/last4/expiry or
  bank/last4), effective-from, Send request / Resend, Pause, Turn off, link to exclusions.
  Disabled with a reason when there is no billing contact email or the key lacks permissions.
- **Billing → Autopay** (operational list, not settings): every org with status (`Not requested`,
  `Requested`, `Active`, `Needs attention`, `Paused`, `Off`), method, last charge result. Bulk
  "Send request", and a banner "N clients not yet asked" with "Send now" / "Dismiss".
- **Send request:** creates or bumps the enrollment (`status='requested'`, `generation+1`), mints
  an `enroll` token (revoking older ones), enqueues `autopay_request` to the billing contact (the
  recipient can be overridden per send). Permission: `billing:manage`.

### 6.3 Client setup page (no login, portal app)

1. GET `/autopay/<token>` renders the MSP-branded page: who is asking, the schedule in plain words
   ("invoices are charged N days after they're issued or on the due date, whichever is later"),
   the cap, how to skip an invoice or stop, and the method choices:
   - `ach_preferred`: **Bank account (recommended)** first and preselected; card second; each with
     its fee ("Bank account: free · Credit card: 3% fee · Debit card: no fee").
   - `ach_only`: bank account only.
   - Non-US / non-USD: card only.
2. The client chooses a type and ticks the authorization statement (versioned text). POST creates
   a Checkout Session `mode:'setup'` with `customer` (created lazily), the single chosen
   `payment_method_types`, `us_bank_account` `verification_method: 'automatic'` (instant
   bank login, microdeposit fallback),
   metadata `{org_id, enrollment_id, generation, token_id}`, and returns the URL.
3. **Return + verification.** The return handler retrieves the SetupIntent server-side (never
   trusts the redirect). A sweep (§7.5) also settles setup sessions the client never returned
   from. On success:
   - insert `org_payment_methods` (funding, holder type, mandate id read from the PM/mandate);
   - insert `org_autopay_consents`;
   - set the enrollment `active` and stamp `effective_from` (first time), **only if** the
     generation still matches and status is `requested`/`active`;
   - enqueue `autopay_enrolled` to the client and notify the MSP.
4. ACH microdeposits pending → method `pending_verification`. The enrollment is active but not
   chargeable until verified. Verification completes via the poller (`setup_intent.succeeded`).
5. The confirmation page states the outcome: "Visa debit ••1234 — no fee applies".

### 6.4 Pay-and-save (when the org's enrollment is `requested` or `active`)

- **Card, on the pay page** (public link + portal): an **unticked** "Use this card for future
  invoices" checkbox. When ticked, the existing Checkout `mode:'payment'` session (still
  card-only, #5611 untouched) adds `customer` + `payment_intent_data.setup_future_usage:
  'off_session'`. The customer is on-session and can authenticate. Settlement is unchanged. The
  PM is then saved + consent recorded as in §6.3.3.
- **"Pay by bank and set up autopay":** runs the §6.3 setup flow, then immediately charges the
  current invoice through the collection engine (§7.3 steps 1–4) as a `client_on_session`
  attempt with no schedule. The client is present and authorized this payment now, so no notice
  lead time applies. ACH never enters a Checkout payment session.

### 6.5 Portal (logged in)

New **Payment methods** page: autopay status, method on file, Update method (re-runs §6.3 for
this org), Stop automatic payments. Portal users have no roles today, so any active portal user
of the org may manage it. This matches who can pay invoices today.

### 6.6 Opt-out and lifecycle

- **Skip this invoice:** token page → POST → schedule `skipped_by_client`, any reservation
  released, `payment_reminder`-style email with the normal pay link, MSP notified.
- **Stop automatic payments:** token page or portal → POST → enrollment `cancelled`
  (`cancel_source='client'`) **immediately for future charges**; non-terminal schedules →
  `cancelled`; the autopay method is detached from the Stripe Customer (post-commit, retried) and
  marked `removed`. A processing ACH debit cannot be recalled, and the page says so. The client
  gets `autopay_stopped` listing still-open invoices with pay links; the MSP is notified.
- **MSP Pause:** non-terminal schedules → `cancelled` (invoices fall back to pay link +
  reminders); resume applies to invoices issued after resume. **MSP Turn off:** as client stop,
  `cancel_source='msp'`; the client is notified.
- **Card expiring:** 30 days before `card_exp`, `card_expiring` is enqueued once per method.
- **Re-enroll** after stop/turn-off = a new request (`generation+1`) and a new setup.
  **Update method** on an active enrollment does **not** bump the generation (existing schedules
  stay valid; the re-notice rule in §7.2 covers a type or fee change).
- **While an attempt is in flight** (`reserved|created|confirming|processing`), Skip is refused
  ("this payment is already processing"). Stop still cancels everything after it.

## 7. Charging engine

### 7.1 Scheduling at issue

A single `planAutopayForInvoice(tx, invoice)` runs **inside the issuing transaction** on all three
issue paths (`issueInvoice`, `quoteAcceptService`, and the contract sweep via `issueInvoice`). It
writes `invoice_autopay_schedules` for every invoice of an org with an enrollment row (eligible or
not, with the reason) and never for orgs without one.

Eligible iff: enrollment `active` with `effective_from ≤ issued_at`; an autopay method `active`
(or `pending_verification`, which defers until verified); charging enabled for the partner;
Stripe connection is the enrollment's account and has autopay capabilities; `currency` supported
by the method type (ACH: USD); `total ≤ cap` when the cap is enabled and the currencies match; no
line's `source_contract_id` references a contract with `autopay_excluded`; `invoice.autopay_excluded`
false.

**`collect_on`** = `issue_date + offset_days` vs `due_date` by `earlier|later`, then
`max(that, notice_date + lead_days)` where `lead_days` = **10** for `us_bank_account` with
`account_holder_type='individual'` (Reg E §1005.10(d), varying-amount debits), otherwise **1**.
`collect_on` is the initiation date; Stripe/the ACH network handle business-day settlement.

### 7.2 The notice

For an eligible invoice, the invoice email **is** the notice (`invoice_autopay` template). It is
enqueued automatically **at issue**, including when the MSP clicks Issue rather than Send. Holding
an invoice means keeping it a draft. It states the amount, the method (brand/last4), the fee if any
("$500.00 + $15.00 card processing fee"), `collect_on`, and the Skip and Stop links (appended
outside the editable body). The schedule stays `awaiting_notice` until the outbox row is `sent`,
then `scheduled`. If `notice_sent_at + lead_days > collect_on`, `collect_on` is moved forward and
the snapshot updated.

The outbox dispatch of `invoice_autopay` **is the invoice send**: it stamps `invoices.sent_at` and
emits `invoice.sent` exactly as `sendInvoiceEmail` does. For eligible invoices, the contract
sweep's post-commit `sendInvoiceEmail` (`contractWorker.ts:120-124`) and a manual Send both route to
this notice, so the client never receives two invoice emails. Resend sends a copy and does not
re-notice.

**Re-notice rule:** if at charge time the active method differs from the notice in **type or fee**
(the client replaced the method), Breeze sends an updated notice and reschedules under §7.1's lead
rules. The charge never exceeds the noticed amount + noticed fee.

### 7.3 Collection run

Job `autopay-collection-run` (hourly; picks schedules with `collect_on ≤ today` evaluated in UTC
and `state='scheduled'|'retry_scheduled'` with `next_attempt_at ≤ now`). Per schedule:

0. **Revoke open pay-link sessions** for the invoice through the existing SEC-150/#5611 revocation
   path. If any session cannot be revoked (it completed or is paid), defer this schedule to the next
   run and let the Checkout settle path win.
1. **Under the invoice row lock**, re-check: enrollment still `active` at the snapshot generation,
   method still usable, not skipped/excluded, charging enabled, same Stripe account, balance > 0,
   and no other reservation. The amount is the remaining unreserved balance (≤ noticed amount).
   Fee per §10.3, re-evaluated now and never above the noticed fee.
2. Insert the attempt `reserved` with a stable `idempotency_key`
   (`autopay_<schedule>_<attempt_no>`). Commit.
3. Outside any DB transaction (#1105): `paymentIntents.create` **unconfirmed** with `customer`,
   `payment_method`, `amount` = gross in minor units, `currency`, `off_session: true`, metadata
   `{invoice_id, org_id, partner_id, attempt_id, principal_minor, fee_minor}`; persist the PI id +
   insert the `invoice_stripe_payments` mapping (`stripe_object_type='payment_intent'`,
   `amount`=principal, `fee_amount`, `source='autopay'`) → attempt `created`. Then `confirm` →
   attempt `confirming`.
4. **Crash recovery:** the reconcile sweep resumes any attempt stuck in `reserved|created|confirming`
   by idempotency key / PI retrieval. It never creates a second PI for the same attempt.

### 7.4 Outcomes

| PI result | Handling |
|---|---|
| `succeeded` (card) | `settlePaymentIntent` → `recordStripePayment` (principal to `invoice_payments` with `method` card/`ach_debit`; fee to the mapping) → schedule `succeeded` → `payment_receipt` → accounting push |
| `processing` (ACH) | attempt `processing`, reservation held; invoice UI shows "Payment processing". Polled until terminal, **no 7-day cutoff** for autopay attempts |
| `requires_action` / `authentication_required` | attempt `requires_action`, schedule `action_required`. **No automatic retry.** `payment_failed` (confirm variant) carrying a `confirm_payment` token. The page takes the client on-session to complete or replace that attempt. MSP notified |
| failed, soft decline (card) | schedule `retry_scheduled` at day 3 and day 7 after the first attempt (each a new attempt + PI) |
| failed, ACH `R01`/`R09` (NSF / uncollected) | one retry after 3 business days |
| failed, hard (`R02` `R03` `R04` `R05` `R07` `R08` `R10` `R16` `R20` `R29`, `card_declined` hard codes, `expired_card`, `stolen_card`, `lost_card`) | method → `unusable`, enrollment `needs_attention_reason='method_unusable'`, `payment_failed` (update-method variant), schedule `failed` |
| last retry fails | schedule `failed`; the invoice enters the normal reminder/overdue flow (§8.2) |
| succeeded, then ACH return / dispute (≤60 days individual) | existing dispute path reverses principal **and** fee (§10.4), invoice reopens, both notified, method re-evaluated |
| Stripe succeeded but Breeze cannot apply (invoice voided / overpaid meanwhile) | attempt `unapplied`, **never** recorded as a failure. Partner banner + `billing.payment_unapplied` notification. The MSP resolves by refunding in Stripe (the poller observes the refund and closes it) |

Every failure enqueues `payment_failed` to the client (method-specific copy + pay-now /
update-method links) and notifies the MSP. Retries re-run the full §7.3 checks.

### 7.5 Detection (polling)

- `stripeReconcileSweep` gains branches for `payment_intent` attempts in non-terminal states, and
  for Checkout **setup** sessions/SetupIntents created in the last 24 h that were never settled.
- `stripeFinancialEventPoller` subscribes additionally to `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `payment_intent.processing`, `payment_intent.requires_action`,
  `setup_intent.succeeded`, `setup_intent.setup_failed`, `mandate.updated`,
  `payment_method.detached`. Late outcomes and out-of-band revocations (the client detached the PM
  or the mandate went inactive) land through the durable event inbox.
- `recordStripePayment`: a mapping `failed` is no longer terminal **for `payment_intent` rows**
  when a later success event arrives. Each retry is a new PI + attempt, so a success always maps to
  exactly one attempt. Success after `failed` on the same PI is recorded (Codex D2).
- `stripeCredentialArchive` keeps credentials alive while any `payment_intent` attempt is
  unresolved, so a key rotation or disconnect still allows reconciliation (Codex risk 2).

### 7.6 Concurrency with other producers (reservation contract)

Every collection producer takes the invoice row lock and honors the derived reservation:
- **Pay link / portal Checkout:** refuses to create a session while a reservation exists ("A
  payment is already processing"). An open session reserves nothing. Instead, the collection run
  revokes it before reserving (§7.3 step 0), reusing the existing #5611 revocation contract rather
  than adding a parallel guard.
- **Manual payment (`recordPayment`) and accounting-import payments:** limited to
  `balance − reserved`.
- **Void:** refused while a reservation exists (in-flight ACH cannot be recalled). After the
  outcome: void allowed, and money collected meanwhile is handled as unapplied.
- **Reset customer link:** always allowed (security operation). It revokes the public link only.
- **Due-date edit:** recomputes `collect_on` for `scheduled` schedules only, then re-notices.
- **Charge now (MSP):** allowed when the notice has been `sent` and, for individual ACH, the lead
  time is met. It runs §7.3 immediately (`initiated_by='msp_charge_now'`). For invoices with no
  eligible schedule it is unavailable (the client never received an autopay notice for it).

### 7.7 Stripe account change / disconnect

Disconnect or a key missing permissions → no new attempts or setups; in-flight attempts keep
reconciling via the archived credential; enrollments → `needs_attention_reason=
'stripe_account_changed'|'key_missing_permissions'`. Reconnecting the **same** account clears it.
A **different** account invalidates every Customer/PM: enrollments require a new request and setup
(Customers and PMs are account-scoped). The existing "account switch blocked once payments exist"
rule (`partnerStripe.ts:336-347`) extends to orgs with active enrollments.

## 8. Emails, notifications, reminders

### 8.1 Templates (new `EMAIL_TEMPLATE_IDS`, partner-editable, defaults + closed variable lists)

| Id | Trigger | Notes |
|---|---|---|
| `autopay_request` | MSP sends request | initial-enrollment wording; CTA = setup page |
| `autopay_enrolled` | setup confirmed | method, fee terms, schedule, how to stop |
| `invoice_autopay` | eligible invoice issued (the notice) | `{{charge_date}}`, `{{payment_method}}`, `{{fee_amount}}` |
| `payment_receipt` | any online payment settles (autopay **and** pay link) | itemizes the fee |
| `payment_failed` | any failed attempt | variants: update method / pay now / confirm payment |
| `payment_reminder` | upcoming due (non-autopay or fallen-back) | |
| `payment_overdue` | overdue cadence | |
| `autopay_stopped` | client stop, MSP pause/turn-off | lists open invoices with pay links |
| `card_expiring` | 30 days before expiry | CTA = update method |

**Non-editable appended blocks** (via `renderPartnerEmail` append points): Skip/Stop links, the fee
disclosure, and the ACH authorization reference. MSP edits cannot remove them. All sends use the
partner `billing` stream (sending domains, #6180) with `reply-to` = partner billing email, and go
through `billing_notice_outbox`.

**MSP notifications** (new `billing` notification types in
`packages/shared/src/constants/notificationTypes.ts`; in-app + email to the partner billing
address): `autopay.enrolled`, `autopay.skipped`, `autopay.stopped`, `autopay.needs_attention`,
`payment.failed_final`, `payment.ach_returned`, `payment.unapplied`. This finally gives
`payment.failed` a consumer.

### 8.2 Reminders (all invoices)

Job `invoice-reminder-sweep` (daily, after the 06:08 overdue sweep). For each invoice
`sent|partially_paid|overdue` with a balance, in a non-archived org, with effective
`reminders_enabled`, and **not** covered by a schedule in `awaiting_notice|scheduled|collecting|
retry_scheduled`:
- before due: first at `due − reminder_before_due_days`, then every `reminder_repeat_days` until due;
- overdue: every `overdue_reminder_every_days` until paid.

Each send is an outbox row with `dedupe_key = invoice:kind:seq`, so it is exactly-once and
retryable. Reminders default **off** at the partner level, so a release never starts emailing
existing MSPs' clients unasked.

## 9. Settings — home, level, resolver (settings rule 9)

### 9.1 Resolver

`resolveBillingPaymentSettings(partnerId, orgId?)` in `services/billingPaymentSettings.ts` is the
**only** reader, used by the scheduler, collection run, setup page, notices, reminders and UI. It
returns each field's effective value and its `source` (`org`\|`partner`\|`default`). Code defaults:
offset 0 / `later`, cap disabled, `ach_preferred`, card fee 0, ACH fee 0, reminders off (before-due
3 days, no repeat, overdue every 7 days).

### 9.2 Homes

| Concept | Home | Level | Places configured before → after |
|---|---|---|---|
| Autopay rules (timing, cap, ACH mode) | Billing settings → **Payments** tab; org settings Billing tab → "Payments" section | partner default → org override (blank = inherit, `InheritedField` shows the inherited value + source) | 0 → 1 |
| Processing fee + attestation | same Payments tab (attestation partner-only) | same | 0 → 1 |
| Reminder cadence | same Payments tab | same | 0 → 1 |
| Fee income item/account for accounting | Integrations → QBO/Xero connection settings | partner | 0 → 1 |
| Email wording | existing Partner → Email templates tab | partner | unchanged home |
| Contract exclusion / invoice exclusion | contract form toggle / invoice toggle | per document | 0 → 1 each |

Enrollments and saved methods are client data, not settings. They show on the org Billing tab
card and the Billing → Autopay list. Every new screen is registered in `settingsPageRegistry`
(rule 8). The rollout switch is admin-only and not an MSP setting.

## 10. Processing fee

### 10.1 Settings and attestation

`card_fee_bps` 0–300, `ach_fee_amount` 0–25.00. A card fee > 0 takes effect only after the
partner-level attestation: "I notified my acquirer (Stripe) and the card networks at least 30 days
ago" and "this fee does not exceed my cost of card acceptance". The attestation is stored with
user + timestamp. Orgs may override to 0 (exempt a client) or to another value within the bounds.

### 10.2 Hard rules (one table in code, `services/surchargeRules.ts`, re-checked at every charge)

- Stripe account country `US` and invoice currency `USD` for the card fee.
- Credit cards only: `card_funding` must be `credit`. `debit`, `prepaid`, `unknown` → no fee.
- Org billing state: **no card fee** in CA, CT, ME, MA; **capped at 2%** in CO. The list is kept
  with a dated source comment, and changes to it are code changes with tests.
- Effective card fee = `min(bps, 300, state cap)`. ACH fee is not subject to card-network rules,
  but stays capped at 25.00.
- Australia: no card fees (network no-surcharge rules from 2026-10-01). The account-country gate
  already excludes it.

### 10.3 Disclosure and computation

The fee is shown on the setup page per method type, on the confirmation, in `autopay_enrolled`, in
every `invoice_autopay` notice (computed amount), and itemized on `payment_receipt`.
`fee = round_half_up(principal × effective_bps / 10000)` in minor units, or the ACH flat amount.
At charge time the fee is recomputed under §10.2 and clamped to `≤ noticed fee` (a rule change can
lower it, never raise it). Consented terms are stored as the formula/maximum. Legality is
re-checked, never assumed frozen (Codex risk 4).

### 10.4 Money and accounting

- Charge gross = principal + fee. `invoice_payments` receives **principal only**. The invoice
  balance, status, PDF and the QBO/Xero invoice are unchanged.
- The fee lives on the mapping row (`fee_amount`). The accounting push books it as a separate
  income entry ("Payment processing fee", MSP-chosen item/account) for the same customer, under
  the same gating as payment push (connection has payment push on, auto mode). Not taxable by
  default; tax treatment is the MSP's responsibility (documented).
- **Refunds/disputes:** cumulative proportional allocation between principal and fee. For each
  reversal event, allocated-to-date totals are recomputed from the cumulative reversed gross, so
  rounding residue lands on the last event and the totals always reconcile exactly. A full refund
  returns the fee. `stripeReversalState` changes to compare against gross (`:274`) and to restore
  with the original `method` (`:392`).

## 11. API surface (sketch; exact routes settle in the plan)

- Partner: `GET/PUT /partner/billing/payment-settings`; `GET/PUT /orgs/:orgId/billing/payment-settings`.
- Autopay ops: `GET /billing/autopay` (org list + statuses), `POST /billing/autopay/requests`
  (bulk), `GET/PATCH /orgs/:orgId/autopay` (pause, resume, turn off), `PATCH /invoices/:id/autopay`
  (exclude/include), `POST /invoices/:id/autopay/charge-now`, `PATCH /contracts/:id`
  (`autopayExcluded`).
- Public (token, no login): `GET /autopay/public/:token`, `POST /autopay/public/:token/setup-session`,
  `POST /autopay/public/setup-return`, `GET/POST /autopay/public/:token/skip|stop|confirm`.
- Portal: `GET /portal/payment-methods`, `POST /portal/payment-methods/setup-session`,
  `POST /portal/autopay/stop`; pay endpoints accept `saveForAutopay`.
- Every web mutation handler uses `runAction` (no-silent-mutations guard).

## 12. Risks and their mitigations

1. **Money collected but not booked.** Mitigated by the reservation contract (§7.6), the
   `unapplied` state (§7.4), and polling until terminal (§7.5).
2. **Authority leaking across tenants.** Mitigated by the merge policies (§5.9), the account
   binding (§7.7), and generation checks (§5.2).
3. **Notice compliance (Reg E / Nacha).** The notice must be *sent* before a charge, 10-day lead
   for individual ACH accounts, and re-notice on method or fee change. Breeze implements the
   mechanics. A legal review of the consent and notice wording before GA is recommended.
4. **Surcharge legality.** The hard rule table (§10.2) plus MSP attestation. Breeze is not legal
   advice; the docs say so.
5. **ACH returns are the MSP's liability** (up to 60 days for individual accounts; return fees
   charged by Stripe). Documented on the Payments tab next to the ACH setting.
6. **Pay-link card payments stay fee-free in v1**, so a client can avoid the card fee by paying via
   link. Follow-up options: Stripe's surcharge API (public preview) or storing a publishable key
   for the Payment Element. Tracked as a follow-up issue.
7. **Email deliverability.** A notice that never sends blocks the charge (safe failure). The
   Billing → Autopay list surfaces schedules stuck in `awaiting_notice`.

## 13. Delivery waves (one feature, `feature-lifecycle` tracked)

1. **W1 Foundation (no user-visible autopay):** all tables + RLS + registrations; settings table,
   resolver, API; Stripe key capability probes; reservation helper wired into pay link, portal pay,
   manual and import payments, void; `invoice_stripe_payments` fee/source/method columns +
   `ach_debit`; `settlePaymentIntent`, sweep and poller extensions, credential-archive extension;
   notice outbox + dispatcher; template-ID plumbing.
2. **W2 Enrollment (clients can enroll; nothing charges):** MSP org card + Billing → Autopay list +
   bulk request; setup page + Checkout setup sessions + verification + consent; card pay-and-save;
   portal Payment methods; skip/stop/pause/turn-off; `autopay_request`, `autopay_enrolled`,
   `autopay_stopped`, `card_expiring`; MSP notifications for enrollment events.
3. **W3 Reminders (all invoices):** reminder sweep, cadence settings UI, `payment_reminder`,
   `payment_overdue`. Ships before charging so failures have a landing place.
4. **W4 Charging (per-partner switch):** `planAutopayForInvoice` on all three issue paths,
   `invoice_autopay` notice, collection run, outcomes table, authentication recovery, ACH
   processing + returns, unapplied money, bank-pay-and-enroll, Charge now, `payment_receipt`,
   `payment_failed`, failure notifications, disconnect handling, invoice/contract exclusions UI.
5. **W5 Processing fee:** settings + attestation, `surchargeRules.ts`, disclosure everywhere, fee in
   charges, reversal allocation, accounting fee entry + item/account setting.

## 14. Reference model — adopted vs. not

Adopted: per-client enable + request email (incl. bulk + "not yet asked" banner); method capture by
request, by first payment, and via portal; per-invoice "cancel auto-collection" link in the
pre-charge email; schedule "N days after issue or due date, earlier/later"; auto-collect cap;
existing open invoices not swept; reminder cadence (before due + repeat; weekly overdue); editable
templates for request / automated payment / reminder / overdue; per-method transaction fee.
Not adopted (v1): MSP-entered methods, multiple methods with fallback, custom-field auto-collect
filters, delayed invoice email, per-client allowed-method lists beyond `ach_only|ach_preferred`.

## 15. Testing

- **Unit:** resolver (inherit, explicit-unlimited vs NULL, sources); eligibility matrix;
  `collect_on` (earlier/later × lead days × due-date edits); `surchargeRules` table (funding ×
  state × country × cap); fee rounding; reversal allocation (property test over random partial
  refund sequences: allocated principal + fee always equals reversed gross); decline/return code
  classification; template variable lists.
- **Integration (real Postgres):** RLS forge (42501) on every new table incl. the dual-axis XOR
  (23514) and SELECT branch; cascade/merge/export contract suites; merge blocked by an in-flight
  attempt and loser authority cancelled; reservation races (autopay vs manual vs pay link,
  concurrent transactions); crash between PI create and confirm resumes without a second PI;
  outbox exactly-once under concurrent dispatchers; unapplied path; generation guard (stale setup
  cannot reactivate a cancelled enrollment); all three issue paths write schedules.
- **Stripe test mode (lab, MSP test key on a worktree stack):** card success; `4000002760003184`
  authentication required; insufficient-funds decline + retries; ACH instant verification success;
  ACH NSF return; microdeposit verification; dispute → reversal with fee; detach in Stripe →
  method unusable via poller; key without SetupIntents permission → UI shows missing permissions.
- **Playwright (`data-testid`):** setup page (ACH preferred / ACH only / fee display), portal
  Payment methods, MSP Autopay list + bulk request, Payments settings tab with inheritance.

## 16. Migration notes

Hand-written, idempotent, system scope elected before any write. Filenames must sort after the
newest committed migration at authoring time (as of this spec, `2026-11-19-101000-…`). Never add
to the closed `2026-08-06` block.
