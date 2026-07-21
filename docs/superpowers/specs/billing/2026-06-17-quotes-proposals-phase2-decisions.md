# Quotes / Proposals — Phase 2 Scope & Decisions

**Date:** 2026-06-17
**Parent spec:** `docs/superpowers/specs/billing/2026-06-16-quotes-proposals-design.md` (all-phase design)
**Phase 1 plan:** `docs/superpowers/plans/billing/2026-06-16-quotes-proposals-phase1.md` (merged #1455)
**Billing RBAC:** merged #1454
**Status:** scope locked via brainstorming; implementation plan follows in `docs/superpowers/plans/`.

This document records the **locked cut** for Phase 2 and resolves the disagreements the
parent spec has with itself. The parent spec's narrative (§ Summary / §2 / §4) describes
acceptance as one atomic action that auto-creates an invoice, while both phasing sections
(spec §9 + Phase 1 plan "Deferred to later plans") split acceptance-record from
invoice-conversion. Where they conflict, **this document wins for Phase 2**.

## Locked scope — IN

1. **Lifecycle transitions** (Phase 1 stopped at `draft`/`sent` existence):
   - `draft → sent` (issue + send)
   - `sent → viewed` (first customer view, portal or public token)
   - `sent|viewed → accepted` (e-sign)
   - `sent|viewed → declined` (with reason)
   - `accepted → converted` (auto-create invoice)
2. **Send-email** — render PDF (reuse `quotePdf`), email the customer's billing contact with
   the PDF attached and a public accept link; stamp `sent_at`. The email is sent post-commit,
   outside the DB context (the contracts `generate` / invoice-send pattern).
   **Gated on `requirePermission('quotes','send')`** — wiring the currently-dead `quotes:send`
   permission registered in Phase 1.
3. **Customer-portal view** — `apps/portal/` quote list + detail + PDF + accept + decline,
   under `portalAuthMiddleware`, org-scoped (drafts filtered; `eq(org_id)` defense-in-depth
   atop RLS). Signer identity on accept = the authenticated `portal_user`.
4. **Public tokenized acceptance page** — unauthenticated, signed-token access for prospects
   without a portal account. Stamps `first_viewed_at`, transitions `sent → viewed`, renders
   customer-visible content, offers **Accept & Sign** / **Decline**. Signer identity = typed
   signature + token claims.
5. **Built-in e-sign accept** behind an `AcceptanceProvider` interface — typed-signature
   provider now; a DocuSign/PandaDoc adapter can be added later **without a data-model
   change**. Writes `quote_acceptances` with a `quote_sha256` content hash of the rendered
   quote at accept time (tamper-evidence).
6. **Accept → convert-to-invoice** *(decision: pulled forward into Phase 2)* — on accept,
   after recording the acceptance, create an invoice and set `quotes.status = 'converted'`
   with `converted_invoice_id`. **Only `one_time` lines are invoiced.** `monthly`/`annual`
   recurring lines are intentionally left out — Phase 4 turns them into a Contract.
   See "Recurring-line handling" below.
7. **`quote_images` upload + serve** — authed multipart upload (magic-byte sniff PNG/JPEG/WebP,
   reuse the avatar 5 MB cap), authed serve for the editor preview, and token-scoped serve for
   the public acceptance page. `bytea`-in-DB, RLS-protected (table shipped in Phase 1).
8. **Decline flow** *(decision: in scope)* — `sent|viewed → declined` with a reason, on both
   the portal and public paths. Requires one new column (below).

## Locked scope — OUT (Phase 3+)

- **Expiry** — neither the background sweep nor a read-time guard. *(decision: no guard now.)*
  A past-`expiry_date` quote can still be viewed and accepted in Phase 2; Phase 3 adds the
  sweep that flips status to `expired` and the accept-time guard.
- **Payment after convert** — the portal pay + public pay-link redirect. Convert *creates*
  the invoice; it does not start payment. Portal users reach the new invoice through the
  existing invoice pay flow (#1422); public-token users see an acceptance confirmation with
  the invoice number. Wiring accept → pay-link redirect is Phase 3.
- **Recurring-lines → Contract** — Phase 4.

## Key decisions (resolving spec/plan disagreements)

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| D1 | Does accept stop at `accepted` or go to `converted`? | **Go to `converted`** — accept auto-creates the invoice. | User decision. Matches the spec narrative; pulls the spec §9 / plan "Phase 3" convert step forward. |
| D2 | How are recurring lines handled on convert? | **One-time lines only.** Recurring lines are skipped and left for the Phase 4 Contract. | User decision. No double-billing risk. Trade-off accepted: a purely-recurring quote converts to a $0 invoice (see degenerate edge). |
| D3 | Is decline in Phase 2? | **Yes**, with reason, both paths. | User decision. Natural counterpart to accept; it's a "sent transition" the Phase 1 plan already filed under Phase 2. |
| D4 | Expiry guard at view/accept time? | **No.** Fully Phase 3. | User decision. Keeps Phase 2 focused; the sweep + guard ship together in Phase 3. |

### Recurring-line handling on convert (D2 detail)

- Convert builds the invoice from `quote_lines WHERE recurrence = 'one_time'` only, using
  `invoiceMath` for penny-exact totals (the quote's own `one_time_total` is the cross-check).
- **Degenerate edge:** a quote with **no** one-time lines (pure MRR) still transitions to
  `converted` and still creates an invoice, which will be `$0`. This is an accepted Phase 2
  trade-off; Phase 4 will route recurring-only quotes to a Contract instead. The plan must
  cover this case explicitly in a test (convert of a recurring-only quote ⇒ `$0` invoice,
  status `converted`, `converted_invoice_id` set) so the behavior is intentional, not a bug.

## Schema delta (Phase 2)

Exactly **one** migration, idempotent, no new tables (all Phase 2 tables shipped in Phase 1):

```sql
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS decline_reason text;
```

Plus the matching Drizzle field on `quotes`. All other lifecycle columns already exist
(`sent_at`, `first_viewed_at`, `viewed_at`, `accepted_at`, `declined_at`, `converted_at`,
`converted_invoice_id`). `quote_images` and `quote_acceptances` already have RLS enabled +
forced + org-axis policies and are already in the cascade + rls-coverage allowlists — **no
new RLS/cascade registration is required.** Functional `breeze_app` forge tests for the new
accept/image *write paths* are still added (the contract test alone misses write-path gaps).

## AcceptanceProvider interface (D1/§5 detail)

```ts
export interface AcceptanceCaptureInput {
  quoteId: string;
  signerName: string;          // typed signature (public) or portal_user name
  signerEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  acceptanceTokenJti?: string | null;
}
export interface AcceptanceCaptureResult {
  signerName: string;
  signerEmail: string | null;
  method: string;              // e.g. 'typed-signature'
}
export interface AcceptanceProvider {
  readonly kind: string;       // 'builtin'
  capture(input: AcceptanceCaptureInput): Promise<AcceptanceCaptureResult>;
}
```

- The **content hash** (`quote_sha256`) is computed by the accept *service*, not the provider:
  a deterministic canonical serialization of the quote header + ordered blocks + ordered lines
  + computed totals, SHA-256 hex. Quotes are immutable once `sent` (edits only in `draft`), so
  the hash is stable from send through accept.
- `TypedSignatureProvider` (`kind = 'builtin'`) validates a non-empty typed name and passes the
  fields through. A future vendor adapter performs the external signing handshake and maps the
  envelope reference into `quote_acceptances.acceptance_token_jti` — **same columns, no schema
  change**, satisfying the spec's provider-agnostic requirement.

## Security & trap checklist (carried into the plan)

1. **Public path is unauthenticated** — every read/write on the public token routes runs via
   `runOutsideDbContext → withSystemDbAccessContext`, scoped to the token's `org_id`/`quote_id`
   resolved from verified token claims. No bare `db` writes (the `rls_silent_zero_row_write`
   class). Token lookups are scoped, never global.
2. **Caddy** — the customer portal (`apps/portal/`) is a separate app from the web app. Verify
   the public page route (`/quote/*`) and the public API route (`/quotes/public/*`) are not
   shadowed by the hosted billing sidecar; add explicit carve-outs ahead of the catch-all and
   test the real URL through caddy, not just the dev port.
3. **Dual-map drift** — `quotes:send` is already in the registry/seed/Partner Billing roles, but
   confirm the `'send'` action has a label in `permissionsCatalog` `ACTION_LABELS` (the catalog
   test asserts every used resource/action has a label).
4. **Web mutations** route through `runAction`; penny math routes through `invoiceMath`/`quoteMath`.
5. **Real-DB tests** live in `apps/api/src/__tests__/integration/*.integration.test.ts`
   (the unit job has no `DATABASE_URL`). Required: public-token view/accept path, tamper-hash
   mismatch, accept→convert (one-time-only + recurring-only $0 edge), RBAC 403 on send for a
   `quotes:read`/`write`-only user, portal cross-org 404.

## Out-of-scope confirmation

Per the parent spec phasing, **Phase 3** = accept→pay-link (portal pay + public pay-link) +
expiry sweep; **Phase 4** = recurring lines → Contract. Phase 2 delivers everything above and
nothing beyond it.
