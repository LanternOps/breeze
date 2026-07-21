# Stripe Payments — Design Spec (billing sub-project 4/4)

**Status:** Design accepted 2026-06-15.
**Program:** Billing. Follows Product Catalog (#1365, merged), Invoice Engine (#1383, merged),
Recurring Contracts (#1411, in review). This is the capstone: let MSP partners collect online
payment from their own clients for invoices the engine produces.
**Frame:** `docs/superpowers/specs/billing/2026-06-14-billing-architecture-overview.md`,
`docs/superpowers/specs/billing/2026-06-14-invoice-engine-design.md`.

---

## 1. One-paragraph summary

An MSP partner authorizes **their own** Stripe account via OAuth (Stripe Connect **Standard**
accounts). Their clients pay a sent invoice online from the existing customer portal through
**Stripe Hosted Checkout**, with the charge created **directly on the MSP's connected account**
(`Stripe-Account: acct_xxx`). A signature-verified Stripe webhook reconciles captured payments —
and reflected refunds — back into the existing `invoice_payments` table via the engine's single
`recomputeInvoiceStatus()` reconcile point. Breeze never touches the funds, takes no fee, and bears
no merchant/chargeback liability.

## 2. Decisions of record (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Connect account type | **Standard + OAuth** | MSP uses/owns their existing Stripe account, one-click authorize. "We don't want to be in the middle." |
| Charge model | **Direct charges** on the connected account | MSP is merchant of record; client's statement shows the MSP; chargebacks/refunds/payouts/compliance are the MSP's. |
| Platform fee | **None** (`application_fee_amount` not used; no fee plumbing built) | Per product decision 2026-06-15. |
| Payment UX | **Stripe Hosted Checkout (redirect)** | SAQ A (no card data in our DOM) — lowest PCI/audit surface, matters for the SOC 2 / security-tier roadmap. Least code. |
| Refunds | **Reflect-only via webhook** | MSP refunds in their own Stripe dashboard; Breeze listens to `charge.refunded` and stays in sync. Breeze does not initiate refunds in v1. |
| Stripe↔invoice link | **Mapping table**, never a `stripe_*` column on core tables | `invoice-engine-design.md:151-154`; `billing-architecture-overview.md:91-93`. |
| Reconcile point | Existing `invoice_payments` rows + `recomputeInvoiceStatus()` | Single path for manual and Stripe payments; `invoice_payments.method='card'` and the open `reference` column were designed for this. |

## 3. Scope & non-goals

**In scope (v1):**
- Partner-side Stripe Connect onboarding (OAuth authorize / status / disconnect).
- Customer portal "Pay" action → Hosted Checkout on the connected account.
- Webhook reconcile: captured payments recorded into `invoice_payments`; status auto-transitions.
- Refund reflection: `charge.refunded` adjusts the linked payment (full → void, partial → reduce).
- Light up `payment.failed` on the existing `invoice-events` bus (others already defined).

**Explicit non-goals (deferred):**
- No application/platform fee; no funds flow through Breeze.
- No saved cards / off-session auto-charge of recurring contracts (possible **sub-project 4b**).
- No Breeze-initiated refunds (no refund button) — reflect-only.
- No embedded Checkout / Payment Element in v1 (redirect only; embedded is a fast-follow).
- No QB/Xero accounting sync (separate deferred spec).
- No multi-currency beyond what the invoice already carries (`invoices.currencyCode`).

## 4. Data model

Two new tables. Both get RLS enabled + forced + policies **in the creating migration** (idempotent),
allowlist entries in the same PR, and a functional `breeze_app` forge test. No changes to
`invoices` / `invoice_payments` columns.

### 4.1 `stripe_connect_accounts` — RLS shape 3 (partner-axis)

One row per partner (the MSP's connected account).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `partner_id` | uuid not null → partners(id) | tenant axis; **unique** (one connection per partner in v1) |
| `stripe_account_id` | text not null | `acct_xxx`; **unique** |
| `credentials` | jsonb | encrypted via `secretCrypto` — stores the OAuth access/refresh token returned by Connect, used only for `deauthorize`. Charges use the platform key + `Stripe-Account` header, not this token. Registered in `encryptedColumnRegistry.ts`. |
| `livemode` | boolean not null | guards test-vs-live mismatch |
| `status` | enum `stripe_connect_status` = `connected \| disconnected` | |
| `scope` | varchar | OAuth scope granted (`read_write`) |
| `connected_by` | uuid → users(id) | MSP user who authorized |
| `connected_at` | timestamptz | |
| `disconnected_at` | timestamptz null | |
| `created_at` / `updated_at` | timestamptz | |

- **Policy:** `breeze_has_partner_access(partner_id)` (flat, never tree traversal).
- Add `'stripe_connect_accounts'` to `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts`.

### 4.2 `invoice_stripe_payments` — RLS shape 1 (direct `org_id`)

The mapping row: links a Stripe object to the `invoice_payments` row we create. The
`unique(stripe_object_id)` is the **idempotency key** for webhook redelivery.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid not null → organizations(id) | tenant axis (auto-discovered by the coverage test) |
| `invoice_id` | uuid not null → invoices(id) on delete cascade | |
| `invoice_payment_id` | uuid null → invoice_payments(id) on delete set null | the recorded payment row; null until capture |
| `stripe_account_id` | text not null | the connected `acct_xxx` |
| `stripe_object_type` | enum = `checkout_session \| payment_intent \| charge` | |
| `stripe_object_id` | text not null | **unique** — idempotency key |
| `stripe_payment_intent_id` | text null | denormalized for refund lookup from `charge.refunded` |
| `amount` | numeric(12,2) not null | captured amount |
| `currency` | char(3) not null | |
| `status` | enum `stripe_payment_status` = `pending \| succeeded \| failed \| refunded \| partially_refunded` | |
| `last_event_at` | timestamptz | last webhook applied |
| `created_at` / `updated_at` | timestamptz | |

- **Policy:** `breeze_has_org_access(org_id)`.
- **Cascade contract (load-bearing):** add `invoice_stripe_payments` to **both** the `core.ts`
  device/org-delete lists **and** `ORG_CASCADE_DELETE_ORDER` in `tenantCascade.ts` (ordered before
  `invoices`/`invoice_payments` it FKs). RLS-coverage passing ≠ cascade coverage; only the
  Integration Tests job catches a miss here, and it has bitten three billing PRs already.

## 5. Connect onboarding (MSP admin side)

New router `apps/api/src/routes/stripeConnect/` mounted at `/api/v1/partner/stripe-connect`.
All routes: `partner` scope, `requirePermission(BILLING_MANAGE...)`, `requireMfa()` — mirroring the
existing `/billing/portal` posture (and deliberately distinct from it; that route is the
breeze-billing/platform-bills-MSP path).

| Route | Behavior |
|---|---|
| `POST /oauth/start` | Build the Stripe Connect OAuth URL (`STRIPE_CONNECT_CLIENT_ID`, `scope=read_write`, `redirect_uri=STRIPE_OAUTH_REDIRECT_URL`) with a signed, short-TTL `state` (CSRF + partner binding, stored in Redis). Return `{ url }`. |
| `GET /oauth/callback` | Verify `state`; exchange `code` at `https://connect.stripe.com/oauth/token` for `stripe_user_id` + tokens; upsert `stripe_connect_accounts` (encrypt token, set `status='connected'`, `livemode`); audit-log; redirect back to the partner billing settings page. |
| `GET /` | Return connection status (`connected`/`disconnected`, masked account id, `livemode`). |
| `DELETE /` | Call Stripe `oauth/deauthorize` for the account, set `status='disconnected'`, `disconnected_at`; audit-log. |

Disconnect is also driven passively by the `account.application.deauthorized` webhook (if the MSP
revokes from their own Stripe dashboard).

## 6. Payment flow (customer portal side)

New route in the existing portal router: `POST /api/v1/portal/invoices/:id/pay`. Auth = the existing
portal session/token (org-scoped `portalAuth`).

1. Load the invoice under the portal's org context; reject unless status ∈ `{sent, partially_paid,
   overdue}` (not `draft`/`void`/`paid`) and `balance > 0`.
2. Require an active `stripe_connect_accounts` row for `invoice.partner_id`; else `409
   STRIPE_NOT_CONNECTED`.
3. `stripe.checkout.sessions.create({ mode:'payment', line_items:[{ price_data:{ currency,
   unit_amount: balanceCents, product_data:{ name: 'Invoice <number>' } }, quantity:1 }],
   success_url, cancel_url, metadata:{ invoice_id, org_id, partner_id, invoice_balance_cents } },
   { stripeAccount: acct_xxx, idempotencyKey: 'inv_<id>_<balanceCents>' })`.
4. Insert an `invoice_stripe_payments` row (`stripe_object_type='checkout_session'`,
   `status='pending'`).
5. Return `{ url }`. The portal redirects the browser to Stripe.

`success_url`/`cancel_url` return to portal pages that show an optimistic "payment processing"
state. **The webhook is authoritative** — the success page never marks the invoice paid itself
(it may poll `GET /portal/invoices/:id` which reflects the reconciled status).

## 7. Webhook handler

New route `POST /api/v1/webhooks/stripe/connect`, mounted **outside** auth middleware (like the
Mailgun inbound webhook), IP rate-limited, returns `202` on accept.

- **Signature:** verify the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET` using
  `stripe.webhooks.constructEvent` (handles the `t=`/`v1=` scheme + replay window). Invalid → `400`,
  no body processing.
- **Connect routing:** Connect events carry `event.account = acct_xxx`. Resolve the partner via
  `stripe_connect_accounts.stripe_account_id`; ignore events for unknown accounts.
- **DB context (load-bearing):** the webhook is an **unauthenticated path**, so all DB work runs
  under `withSystemDbAccessContext` with a system actor. Bare `db` writes here would silently match
  **0 rows** under `breeze_app` RLS with no error — the exact `last_login_at`-freeze class of bug
  from #1375. This is called out so it is impossible to miss.
- **Idempotency:** upsert the `invoice_stripe_payments` mapping keyed on `unique(stripe_object_id)`;
  Stripe **will** redeliver, so a duplicate is a no-op. Only a state-advancing transition records a
  payment.

### Handled events

| Event | Action |
|---|---|
| `checkout.session.completed` | Record the captured payment (see §8); set mapping `status='succeeded'`. **Only** the session records a capture — it is keyed on the session id and carries `payment_intent` + `amount_total`. `payment_intent.succeeded` is deliberately **ignored** (handling both double-fires every payment and triggers a redelivery/retry storm). |
| `payment_intent.payment_failed` | Mapping `status='failed'`; emit `payment.failed`. No invoice change. |
| `charge.refunded` | Reflect refund (see §8.1). |
| `account.application.deauthorized` | Mark the partner's connection `disconnected`. |

## 8. Recording payments & refunds into the engine

The webhook calls a thin new service path `recordStripePayment(...)` in `invoiceService.ts` (rather
than the user-facing `recordPayment`, which requires a real `userId`). It runs under system context
and, **in one transaction**:

1. Inserts an `invoice_payments` row: `method='card'`, `reference=<payment_intent_id>`,
   `recordedBy=null` (system), `amount`, `receivedAt=today`.
2. Sets `invoice_stripe_payments.invoice_payment_id` to the new row.
3. Calls the existing `recomputeInvoiceStatus(invoiceId)` — the single reconcile point that derives
   `amountPaid`/`balance`/`status`, stamps `paidAt`, and respects the existing overpayment guard.
4. Emits `payment.recorded` (and `invoice.paid` if balance hit 0) — reusing the existing emit calls.

`recordStripePayment` reuses the overpayment guard; a Stripe amount exceeding balance is rejected
and surfaced (mapping `status='failed'` + alert), never silently written.

### 8.1 Refund reflection

On `charge.refunded`, look up the mapping by `stripe_payment_intent_id`, then adjust the linked
`invoice_payments` row — **no schema change** (the positive-only `amount` is reduced, never made
negative):

- **Full refund** (`amount_refunded == amount`): void the linked payment row (reuse the
  `voidPayment` mechanics: delete row + recompute), set mapping `status='refunded'`.
- **Partial refund** (`0 < amount_refunded < amount`): set the payment row
  `amount = original − amount_refunded`, recompute, set mapping `status='partially_refunded'`.
- `recomputeInvoiceStatus` reopens `balance`/`status` (e.g. `paid → partially_paid`/`overdue`).
- Emit `payment.voided` (full) — partial reflection reuses `payment.recorded`'s recompute path; an
  optional `payment.refunded` event type may be added if a downstream consumer needs it (deferred
  until there is one).

## 9. Events

Reuse the existing **unconsumed** `invoice-events` BullMQ bus (`services/invoiceEvents.ts`). The
Stripe path naturally emits the already-defined `payment.recorded`, `payment.voided`, and
`invoice.paid`. **One new type added:** `payment.failed`. No new queue.

## 10. Config / env

Add to the config validator (`apps/api/src/config/`), all **optional** — the feature is dormant
unless set (same pattern as the Cloudflare mTLS feature):

- `STRIPE_SECRET_KEY` — platform key; used for OAuth token exchange and acting via `Stripe-Account`.
- `STRIPE_CONNECT_CLIENT_ID` — `ca_xxx` for the OAuth authorize URL.
- `STRIPE_WEBHOOK_SECRET` — Connect endpoint signing secret.
- `STRIPE_OAUTH_REDIRECT_URL` — Connect OAuth callback.

`stripe@^22` is already a dependency. No publishable key needed (Hosted Checkout is a redirect).
When introducing these as required-anywhere later, follow the deploy rule: add to `/opt/breeze/.env`
**and** map explicitly in the compose `environment:` block.

## 11. Security considerations

- **Webhook is the only unauthenticated write path** — signature-verified, IP rate-limited, system
  DB context, idempotent. No tenant data is trusted from the payload beyond the verified
  `event.account` → partner mapping and our own `metadata`.
- **Tenant isolation:** both new tables RLS-forced; partner-axis and org-axis policies; functional
  `breeze_app` forge tests (not just the coverage contract, which does not catch a missing second
  axis or an `is_system`-style hole).
- **Secrets:** OAuth tokens encrypted at rest via `secretCrypto` + `encryptedColumnRegistry`.
- **CSRF on OAuth:** signed short-TTL `state` bound to the partner, stored in Redis.
- **livemode guard:** reject webhook/charge processing when `event.livemode` disagrees with the
  stored connection's `livemode`.
- **Amount integrity:** charge amount is computed server-side from `invoice.balance`; the portal
  never supplies an amount.

## 12. Testing strategy

- **Unit:** signature verify (valid / tampered / replayed); idempotent redelivery (same
  `stripe_object_id` twice → one payment); `recordStripePayment` overpayment guard; full & partial
  refund math → status transitions; `payment.failed` emission.
- **Integration (real DB, `breeze_app`, `*.integration.test.ts`):** RLS forge on
  `stripe_connect_accounts` (partner cross-tenant) and `invoice_stripe_payments` (org cross-tenant),
  re-seeded per `it` (never memoize the fixture); the **webhook-writes-under-system-context** path —
  prove a legit reconcile succeeds and a cross-tenant forge fails, non-vacuously; cascade-delete
  coverage for `invoice_stripe_payments`.
- **Contract:** add both tables to `rls-coverage.integration.test.ts` allowlists; `db:check-drift`
  clean.

## 13. Service-layer-first / surface parity

All logic lives in services (`stripeConnectService`, `recordStripePayment` + refund reflection in
`invoiceService`). Routes (partner, portal, webhook) are thin. AI/MCP write tools are **not** added
in v1 (read-only `list_invoices`/`get_invoice` already exist); a future `pay`/`refund` tool would
subscribe through the same service layer.

## 14. File manifest (new / changed)

**New**
- `apps/api/src/db/schema/stripePayments.ts` — both tables + enums.
- `apps/api/migrations/2026-06-15-stripe-payments.sql` — tables + RLS policies (idempotent). Use a same-day `-a-`/`-b-` infix only if a follow-up constraint migration is split out.
- `apps/api/src/services/stripeConnectService.ts` — OAuth start/callback/status/deauthorize, client factory (`{ stripeAccount }`).
- `apps/api/src/services/stripeWebhook.ts` — verify + dispatch + reconcile/refund/deauthorize handlers.
- `apps/api/src/routes/stripeConnect/index.ts` — partner routes.
- `apps/api/src/routes/webhooks/stripe.ts` — webhook route.
- Portal `pay` handler in the existing portal router.
- Tests alongside each.

**Changed**
- `apps/api/src/services/invoiceService.ts` — add `recordStripePayment` + refund reflection (reuse `recomputeInvoiceStatus`).
- `apps/api/src/services/invoiceEvents.ts` — add `payment.failed`.
- `apps/api/src/services/encryptedColumnRegistry.ts` — register `stripe_connect_accounts.credentials`.
- `apps/api/src/config/*` — optional Stripe env vars.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist both tables.
- `apps/api/src/services/tenantCascade.ts` + `core.ts` — cascade lists.
- Route index mounts; portal billing settings UI gets a "Connect Stripe" control (web).

## 15. References

- `docs/superpowers/specs/billing/2026-06-14-billing-architecture-overview.md` — program frame, mapping-table rule, `payment.*`.
- `docs/superpowers/specs/billing/2026-06-14-invoice-engine-design.md` — invoice/payment model, Stripe forward-compat (`:151-154`), reconcile point.
- `apps/api/src/db/schema/invoices.ts` — `invoices`, `invoice_payments`, `invoiceLines`, `partnerInvoiceSequences`.
- `apps/api/src/services/invoiceService.ts` — `recordPayment`, `voidPayment`, `recomputeInvoiceStatus`.
- `apps/api/src/routes/portal/` — portal auth + invoice view (the "pay online" surface).
- `apps/api/src/routes/invoices/payments.ts` — manual payment recording (peer surface).
- `apps/api/src/db/schema/integrations.ts` — `psaConnections`/`psaTicketMappings` connection+mapping pattern.
- `apps/api/src/services/secretCrypto.ts` + `encryptedColumnRegistry.ts` — credential encryption.
- `apps/api/src/routes/tickets/emailWebhook.ts` + `services/inboundEmail/mailgun.ts` — webhook + HMAC precedent.
