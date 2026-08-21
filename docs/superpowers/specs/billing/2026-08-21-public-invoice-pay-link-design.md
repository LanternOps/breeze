# Public Invoice Pay Link — UX + Design Spec

**Date:** 2026-08-21
**Status:** Approved (Todd, 2026-08-21) — advisor quorum ran (Fable position + Codex xhigh review); resolutions inline, marked **[quorum]**
**Problem:** A real customer, invoice in hand, could not pay: *"it does not allow me to pay them without logging into a client portal. I do not recall having a portal login."*

## 1. The gap

Payment today has exactly one frictionless moment, and it is bound to the wrong object:

1. Quote accept (`POST /quotes/public/:token/accept`) revokes the accept token (single-use jti), mints a one-shot Stripe checkout URL, and returns it **in that one response**. The `payUrl` lives only in React state on the confirmation screen (`PublicQuoteView.tsx`). Close the tab → gone. The quote link itself now 401s.
2. Nothing auto-emails the issued invoice (`emitAcceptInvoiceIssued` only emits the bus event + queues the PDF render).
3. When the MSP sends the invoice, the email CTA is `<portalBase>/invoices/<id>` — the **authenticated** portal. Nothing in the invoice send path invites the customer to the portal, so most recipients have no login. Dead end.
4. The MSP-side "Copy payment link" (`POST /invoices/:id/pay-link`) copies a raw Stripe checkout URL — expires in ~24h, shows no invoice, single amount snapshot. Another one-shot trap.

**Root cause:** the payment link is bound to a single-use *acceptance* token instead of to the *invoice*. Quotes have a public surface; invoices don't.

## 2. Design principle

> **Every invoice email carries one durable link that always works: view the invoice, download the PDF, and pay whatever is due now — no login, no expiry cliff, correct in every lifecycle state.**

Trust model is identical to the quote accept link (bearer link = access), and strictly less dangerous: the worst a link holder can do is *view* the invoice or *pay* it. Same as Stripe's own hosted invoice links.

## 3. Token design — **[quorum: opaque token, not JWT]**

**256-bit random opaque token; no new table; three new columns on `invoices`.**

My original position was an HS256 JWT + version column mirroring `quoteAcceptToken.ts`. Codex overturned it and I agree: verification must read the invoice row anyway (status + revocation), so the JWT is stateless in name only — while inheriting the general JWT keyring's rotation lifetime, which is designed for access-token lifetimes, not year-scale links (the quote `kid`-loss path is exactly this failure mode and already warranted a Sentry alert). A signing-key compromise would also forge links for *every* invoice; an opaque-token leak is scoped to one.

- Token: 32 random bytes, base64url (~43 chars — email-friendly vs a ~300-char JWT). No embedded claims; the invoice is resolved **by token hash**.
- Columns:
  - `public_link_token_hash` `char(64)` — SHA-256 hex, unique partial index; the lookup key. Export policy: `excludedSensitive`.
  - `public_link_token_ct` `text` — the token encrypted at rest (reuse the existing partner-Stripe encryption service), so "Copy link"/re-send reproduce the *same* URL instead of minting a growing family of live credentials. Export policy: `excludedSensitive`.
  - `public_link_expires_at` `timestamp` — persisted at mint (never recomputed from mutable due dates). Export policy: `included`.
- **Verification path touches no key**: hash the presented token → indexed lookup → check expiry + status. Encryption-key loss degrades to "next copy-link mints a fresh URL" (old links keep working) — strictly better than the JWT kid-loss mode where verification itself dies.
- **Multi-use.** No jti, no Redis. **Reset** = overwrite hash+ct+expiry (every previously issued link dies at once); no separate version column needed — replacing the hash *is* the revocation.
- Minted lazily on first send/copy-link (concurrent-mint race handled with a conditional `WHERE public_link_token_hash IS NULL` claim + loser re-read, same shape as `resolveAcceptUrl`).
- **Expiry: 12 months from mint, never earlier than due date + 180 days** **[quorum]** (2 years was too long for a bearer link to invoice PII; status-gating limits *payment*, not disclosure). Re-sending an invoice whose link expired mints a fresh link — mirroring the quote expired-identity path. The authenticated portal remains the long-term archive.
- No new table → no RLS/cascade registrations; the three columns get export-policy rows as above.

URL: `<portalBase>/invoice/<token>` (singular, mirroring `/quote/<token>`).

## 4. Lifecycle → page state matrix

| Invoice state | Link resolves? | Page shows |
|---|---|---|
| `draft` | No — generic "link isn't valid" | (drafts are MSP-internal; also unreachable: link minted at issue/send) |
| `sent` | Yes | Full invoice + **Pay $X now** (X = `computeChargeNow` — deposit-aware) |
| `sent` + deposit | Yes | "Due now: deposit $X of $Total" + **Pay deposit $X** |
| `partially_paid` | Yes | Paid-to-date bar + **Pay balance $Y** |
| `overdue` | Yes | Amber "was due <date>" banner + pay CTA (no penalty implied — none is modeled) |
| `paid` | Yes | Green "Paid on <date>" state, **no** pay button, PDF download stays |
| Payment just made, settle pending | Yes | "Confirming payment…" — suppress further checkout attempts **[quorum]** |
| No Stripe key / zero balance | Yes | View + PDF with "Online payment isn't available — contact <MSP>" |
| `void`, not replaced | Yes (token valid) | "This invoice is no longer due. Questions? <MSP contact>" — no amounts |
| `void` + `replaced_by_invoice_id` | Yes | Same, plus "An updated invoice has been issued" (**no** auto-link to the replacement — its email carries its own token) **[quorum confirmed]** |
| Bad/expired token, or reset | No | Generic "This link is invalid or has expired — contact <sender>" (no existence leak; mirror the quote page's no-login-redirect rule) |

The page never dead-ends into a login. Paid and void states are deliberately *calm* — clicking an old link after paying must confirm, not alarm.

## 5. Public page (`apps/portal/src/pages/invoice/[token].astro` + `PublicInvoiceView`)

Mirror `PublicQuoteView`/`documentShell` composition — MSP-branded (`portalBranding` logo/color, partner document theme), platform-anonymous like the email envelope.

**Layout, top to bottom:**
1. Partner branding header.
2. Status pill + invoice number + issue/due dates.
3. **Amount panel** (the reason the customer is here — above the line items): Total / Paid to date / **Due now** (bold, deposit-aware), then the primary CTA **Pay $X now**. Secondary: **Download PDF**.
4. Bill-to + seller blocks, customer-visible lines, subtotal/tax/total, notes/terms. Explicit public DTO — reuse `getCustomerInvoice`/`toCustomerInvoiceLine`, never a spread invoice row **[quorum]**. Bill-to name/address/tax-id are the customer's own data and stay; internal-only fields never cross.
5. Footer: "Have a portal account? Sign in to see all your invoices" → `<portalBase>/login`. Present tense only — no signup pitch.

**Pay flow (return URL redesign — [quorum: durable token must not reach Stripe logs]):**
- `Pay now` → `POST /invoices/public/:token/pay` → redirect to Stripe hosted checkout.
- `success_url` = `<portalBase>/invoice/return?session_id={CHECKOUT_SESSION_ID}` — **session id only, no invoice token**. `cancel_url` = same page without params… which needs the token; instead `cancel_url` = the return page with `?canceled=1&session_id=…` (resolved the same way).
- The return page POSTs `/invoices/public/settle-return {sessionId}` → server validates the session against its own `invoice_stripe_payments` mapping (unguessable id, ours, recent), settles idempotently, and responds `{publicUrl}` (server decrypts `public_link_token_ct`) → `location.replace(publicUrl)` lands on the durable page in its new state. The URL handout is bounded: only for mappings pending or settled within the last hour.
- Reconcile sweep remains the eventual backstop.

**View stamping:** GET stamps `first_viewed_at`/`viewed_at` best-effort — but treat it as **"link fetched," not proof of human viewing** **[quorum]**: email scanners prefetch links. Stamp only on the full invoice JSON fetch, first-view only-if-null semantics unchanged from the portal path. (Same caveat exists for quotes today; parity, not regression.)

## 6. API surface (`routes/invoicesPublic.ts`, mounted unauthenticated at `/invoices/public` before the auth-gated `/invoices` router — same ordering trick as `/quotes/public`)

| Route | Behavior |
|---|---|
| `GET /:token` | Hash → indexed lookup; system DB context; expiry + non-draft check; return public DTO + branding + `chargeNow` |
| `GET /:token/pdf` | Stream stored PDF (render-on-demand fallback), `safeContentDispositionFilename` hardening |
| `POST /:token/pay` | Shared checkout primitive (see below) — deposit-first `computeChargeNow`, currency-aware minor units, idempotency key `inv_<id>_<minor>_<dep|bal>`, pending `invoice_stripe_payments` row, public return URLs. 409s: not payable, nothing to pay, Stripe not connected |
| `POST /settle-return` | Session-id-keyed settle (no token needed): mapping must be ours + recent; idempotent; returns `{publicUrl}` |

**Shared checkout primitive [quorum]:** extract the portal checkout handler + `invoiceCheckout.ts` into ONE service with configurable success/cancel URLs — this feature must not create a third copy of the deposit/currency/mapping/idempotency logic.

**Hardening [quorum additions]:**
- `Cache-Control: no-store` on HTML/JSON/PDF; `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow, noarchive` on the public page + API responses.
- Per-IP **and per-token** rate limits tighter than the 300/min global default, especially `/pay`, `/settle-return`, `/pdf` (Stripe mutations + render cost).
- `/pay` requires a JSON body + custom header (same-origin fetch shape); CORS stays supplementary.
- All reads/writes in `runOutsideDbContext(withSystemDbAccessContext(...))` with hash-scoped WHEREs, like `quotesPublic.ts`.
- On **reset / void / successful payment**: best-effort expire this invoice's open Checkout sessions (old sessions must not remain payable against a revoked link) **[quorum]**.

## 7. Email + PDF changes

- `buildInvoiceTemplate`: CTA URL becomes the public link; label **"View & pay invoice"** (or "View invoice" when the partner has no Stripe key — known at send time). The muted portal line becomes "You can view this invoice and download a copy any time using this link."
- Plain-text body carries the same URL.
- Invoice PDF footer gains "Pay online: <public URL>" (quotes already print their accept link).
- **Re-send now dispenses a credential.** Update the `resendInvoiceEmail` doc-comment rationale ("dispenses no credential" is obsolete). Paid-invoice re-send stays allowed — the link lands on the paid state.
- Overdue reminder emails (future) must use the same link — consumer, not in scope.

## 8. Quote-accept flow changes — **[quorum: durable page becomes canonical]**

1. **Kill the one-shot `payUrl` UX.** After a successful accept, `location.replace(<invoice public URL>)` — the accept response returns `invoiceUrl` and the confirmation moment *is* the durable invoice page (which shows Pay now). No two competing links, nothing held only in React state. `payDeferred` copy survives only for the mint-failure edge.
2. **Auto-email the invoice on acceptance** — post-commit, best-effort/swallowed like every accept side effect, to the **org billing contact + the quote's recorded recipients** (known addresses only — never the unverified signer-entered email **[quorum]**).
   - **Default ON, partner-level toggle** — held against Codex's grandfather-off recommendation: with the canonical redirect the email is recovery/recordkeeping, and the feature exists because customers lose the moment. Toggle gate and read-back must share the same `!== false` expression (partners.settings sub-object replacement trap, #3597).

## 9. MSP-side UX (`InvoiceActions` / `InvoiceDetail`)

- **Copy invoice link** ("view & pay" in the tooltip — it is not purely a payment link once paid **[quorum]**): replaces the raw 24h Stripe URL as the headline copy action; `GET /invoices/:id/public-link` (mint-or-reproduce, `invoices:send` permission). The Stripe-direct link stays available under the payments section for charge-now workflows.
- **Reset link** — overwrites hash/ct/expiry after a confirm dialog ("Anyone with the old link will lose access…"); requires `invoices:send`; **audited** **[quorum]**. Overflow menu; rare action.
- Send/re-send composer: unchanged fields; helper text under To notes the email contains a no-login pay link.

## 10. Companion pre-existing issues (found by quorum — fix alongside, not blockers)

- **Settle vs reconcile-sweep race:** `stripeReconcile.ts` checks `invoicePaymentId` then inserts/updates without `FOR UPDATE`; settle and sweep can double-process a mapping. Add row locking / atomic claim.
- **Refund semantics are undefined for the public page:** a full refund recomputes status and can flip the page payable again, and a refunded mapping needs a terminal-state guard before settle replay. Decide (reopened debt vs credit vs void) before GA of the link; until then the page simply reflects whatever status the engine computes.

## 11. Explicitly out of scope

- Portal-account auto-provisioning or invite-on-send.
- Auto-linking a void invoice to its replacement's public page.
- Overdue dunning emails (consumer of this link, own spec).
- ACH/async payment methods (v1 stays card-only, matching the portal path).

## 12. Test contract (minimum)

- Token: mint → hash lookup roundtrip; copy-link byte-stability (decrypt path); decrypt-failure → fresh mint without killing verification; concurrent mint claims once.
- Reset revocation: old token 401s the moment hash is replaced.
- State matrix: each row of §4 against public GET + pay (409 semantics).
- Deposit-then-balance through the *same* link (two checkout sessions, distinct idempotency keys).
- `settle-return` with a foreign/stale `session_id` → 404/409, no `publicUrl` leak; idempotent replay.
- Expiry: honored at read; expired-link re-send mints fresh.
- Cross-tenant: hash lookup is global by construction — assert the resolved row's org scopes every subsequent read/write.
- Headers: no-store/no-referrer/robots on every public response.
- Integration: accept → redirect URL returned + auto-email dispatched with the public URL (toggle honored, `!== false` gate); email snapshot contains no portal `/invoices/<id>` URL.
