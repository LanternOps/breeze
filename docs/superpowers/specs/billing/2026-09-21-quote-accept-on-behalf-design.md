# Quote acceptance on behalf of a customer — design

**Date:** 2026-09-21
**Status:** approved (Todd, in-session), single PR, no feature-lifecycle registration
**Builds on:** `2026-06-16-quotes-proposals-design.md` (state machine, accept→convert),
`2026-08-21-quote-decline-completion-design.md` (`source: 'msp'` outcome attribution),
`2026-08-17-quote-revisions-design.md` (supersede rules)

## 1. Problem

A tech closes a deal on the phone, by email, or on a signed PO, and needs the
quote to become an invoice. Today the only accept paths are the customer's
public token link and the authenticated portal. The tech UI has no accept, no
decline, and no "mark converted" action, and there is no internal accept route
at all. The workaround is to send the quote and ask the customer to click, or
to hand-build an invoice that drifts from the quote.

The conversion itself is not missing. `acceptQuote`
(`apps/api/src/services/quoteAcceptService.ts`) already converts the quote,
allocates a gapless invoice number, issues the invoice at the quote's frozen
totals and tax, drafts contracts for recurring lines, snapshots executed
contract documents, and stages the Pax8 order. This feature adds a tech-side
entry point to that pipeline and records honest provenance for it.

## 2. Decisions (recorded from the brainstorm)

| # | Question | Decision |
|---|---|---|
| D1 | Issue the invoice immediately, or leave a draft for review? | **Reuse the pipeline verbatim.** Invoice is numbered and `sent`, contracts drafted, partner auto-email flag honoured. The confirmation dialog is the safety step. A draft-invoice variant would need an `issueInvoice: false` branch and the quote's frozen tax snapshot would not survive a later manual `issueInvoice`, which re-resolves tax. |
| D2 | What evidence is recorded? | **Method + required reference + signer name/email.** No file attachment in this PR (follow-up). |
| D3 | Who may do it? | **New `quotes:accept` permission**, back-filled to every role that holds `quotes:send`, separately revocable. |
| D4 | Which statuses are eligible? | **`draft`, `sent`, `viewed`.** A draft is claimed to `sent` inline (no delivery, no public link) and then accepted. `expired` and `declined` are rejected; Revise is the path. `superseded`/`converted` keep their existing 410/409. |

## 3. Non-goals

- Evidence file attachments (signed PDF, PO scan). Follow-up issue.
- Decline on behalf. Trivial and symmetrical, but not asked for; follow-up issue.
- Countersignature capture (deferred by the contract-documents spec, unchanged).
- An MCP or AI tool for this action. `aiToolsQuotes.ts` already exposes decline;
  accept on behalf is money-committing and stays human-only until asked for.
- Any change to customer-initiated acceptance semantics, the content hash, or
  the public-link liveness predicate.

## 4. API

### Route

`POST /api/v1/quotes/:id/accept-on-behalf` in `apps/api/src/routes/quotes/lifecycle.ts`.

Middleware: `requireScope(...)` as the sibling lifecycle routes, then
`requirePermission('quotes', 'accept')`. Org access is enforced by the auth
scope and the org-scoped quote lookup **before** the handler enters system
context. The handler then runs the accept under
`runOutsideDbContext(() => withSystemDbAccessContext(...))` exactly as
`routes/portal/quotes.ts` does, because the `partner_invoice_sequences` counter
is partner-axis and the accept transaction must be one unit. Contract-block
render data is pre-fetched outside the transaction, same as the portal route.

### Request body (Zod, `packages/shared/src/validators/quotes.ts`)

```ts
acceptQuoteOnBehalfSchema = z.object({
  method: z.enum(['verbal', 'email', 'signed_document', 'purchase_order', 'other']),
  reference: z.string().trim().min(1).max(500),
  signerName: z.string().trim().min(1).max(255),
  signerEmail: z.string().trim().email().max(255).optional().nullable(),
});
```

`reference` is what a dispute reviewer would look for: "PO 4471", "email from
J. Doe 2026-09-20 14:02", "call with owner, notes in T-0231".

### Response

Same shape as the portal accept: `{ quote, invoiceId, invoiceIssued,
contractIds, payUrl }`. `payUrl` is best-effort post-commit, as today.

### Errors

| Condition | Status | Code |
|---|---|---|
| Quote not in caller's scope | 404 | `QUOTE_NOT_FOUND` |
| Status `expired` or `declined` | 409 | `QUOTE_NOT_ACCEPTABLE` (message names Revise) |
| Status `converted` / `accepted` | 409 | existing `QUOTE_ALREADY_CONVERTED` |
| Status `superseded` | 410 | existing `QUOTE_SUPERSEDED` |
| Past `expiry_date` | 410 | existing `QUOTE_EXPIRED` |
| Line references a deleted device group/site | 409 | existing (`assertQuoteLinesAcceptable`) |
| Contract render data missing | 500 | existing `CONTRACT_RENDER_DATA_MISSING` |

The status guard for the on-behalf origin is `draft | sent | viewed`; the
customer origin keeps `sent | viewed`.

## 5. Service

### `acceptQuote` parameters

```ts
interface AcceptQuoteParams {
  // existing …
  origin?: 'customer' | 'on_behalf';   // default 'customer'
  actorUserId?: string | null;         // already present; now populated for on_behalf
  method?: string | null;              // on_behalf: the enum above; customer: provider.method
  reference?: string | null;           // on_behalf only
}
```

### Draft claim

When `origin === 'on_behalf'` and the locked quote is `draft`, the service runs
the draft→sent claim **before** the acceptance guards. The claim is the
existing send-time work in `quoteLifecycle.sendQuote` minus delivery:

- conditional `UPDATE … WHERE status = 'draft'` with row-count assertion;
- allocate `quoteNumber` via `allocateQuoteCounter` if unset;
- freeze the bill-to snapshot, presentation snapshot, and render locale;
- stamp `issueDate`, `sentAt`;
- write **no** `quote_recipients` rows, mint **no** accept token, set **no**
  public-link fields, send **no** email;
- on a revision, retire the parent (`superseded` + `publicLinkRevokedAt`)
  exactly as `sendQuote` does, so a customer holding the parent's link cannot
  accept it after the tech accepted the child.

To avoid a second copy of that logic, extract it from `sendQuote` into
`claimQuoteSent(db, quote, opts)` in `quoteLifecycle.ts` and have both
`sendQuote` and the on-behalf accept call it. `sendQuote`'s behaviour is
unchanged; the extraction is covered by its existing tests plus one new
assertion that the helper leaves `public_link_*` and `accept_token_*` null.

`sentAt` on a never-delivered quote is honest: `sent` means "frozen and
customer-bound", and the acceptance row carries `origin = 'on_behalf'` for
anyone who needs to know the customer never received a link.

### Acceptance capture

`AcceptanceProvider` gains nothing. The on-behalf path bypasses
`getAcceptanceProvider().capture()` and builds the capture result directly
(`signerName`, `signerEmail`, `method` from the body). Rationale: the provider
abstraction represents *how the customer signed*; an on-behalf record is not a
signature, and routing it through a "typed-signature" provider would mislabel
it. `ipAddress` and `userAgent` are the tech's, taken through
`getTrustedClientIpOrUndefined(c)` and clamped to 64 chars as today. The
content hash (`computeQuoteSha256`, version 2) is computed and stored
unchanged, so tamper-evidence works identically for both origins.

Everything after the acceptance insert is untouched: invoice + lines, inline
sequence allocation, `status: 'converted'`, contracts, executed documents, Pax8
staging, and the three post-commit side effects.

### Outcome notification

`notifyQuoteOutcome` is called with `source: 'msp'`. Per that helper's
contract this emits `quote.accepted` on the quote event bus and sends **no**
creator email (a self-inflicted outcome). The event payload gains
`origin: 'on_behalf'` and `actorUserId` so integrations can tell the two apart.

## 6. Data

One migration, named to sort after the newest committed migration at PR time
(check `ls apps/api/migrations | sort | tail -1`; do not assume today's date
sorts last), idempotent, no inner transaction.

`quote_acceptances` gains:

| Column | Type | Notes |
|---|---|---|
| `origin` | `text NOT NULL DEFAULT 'customer'` | CHECK `origin IN ('customer','on_behalf')` |
| `method` | `varchar(32) NULL` | customer rows back-filled to `'typed-signature'` (the only provider that has ever run); on-behalf rows hold the request enum |
| `reference` | `text NULL` | required at the API for on-behalf; CHECK `(origin = 'customer') OR (reference IS NOT NULL)` |
| `recorded_by_user_id` | `uuid NULL REFERENCES users(id) ON DELETE SET NULL` | the tech; CHECK `(origin = 'customer') = (recorded_by_user_id IS NULL)` |

The back-fill `UPDATE` elects system scope first
(`PERFORM set_config('breeze.scope','system',true)`) and reports its row count
with `RAISE WARNING`, per the migrations README.

Registry updates in the same PR:

- `tenantExportPolicyRegistry.ts`: add `origin`, `method`, `reference`,
  `recorded_by_user_id` to the `included` bucket of `quote_acceptances`. None
  match `SUSPICIOUS_NAME_PARTS`; none are open containers.
- No cascade-list change: the table is already in `CORE_ORG_CASCADE_DELETE_ORDER`
  and has no `device_id`/`ticket_id`.
- RLS: existing shape-1 `org_id` policy covers the new columns; nothing to add.

Drizzle schema (`schema/quotes.ts`) mirrors the four columns.

## 7. Permission

- `packages/shared/src/constants/permissions.ts`: `QUOTES_ACCEPT: { resource: 'quotes', action: 'accept' }`.
- `apps/api/src/db/seed.ts`: grant to every seeded role that holds `QUOTES_SEND`.
- `routes/permissionsCatalog.ts`: resource `quotes` already has a label; the
  action appears automatically. `permissionsCatalog.test.ts` must stay green.
- Back-fill migration for existing partners, modelled on
  `2026-10-16-190000-agreements-permission.sql`: insert the `permissions` row if
  absent (explicit existence check, no `ON CONFLICT`), then insert a
  `role_permissions` row for every role, system or custom, that holds
  `('quotes','send')`. Match on the **existing grant**, not the role name.
  Wildcard `'*:*'` roles need no row. This grants no new authority to any role
  that could not already send, which is the no-regression rule; partners who
  want acceptance narrower than sending revoke it afterwards.
- Docs: add the permission to the roles/permissions reference page in
  `apps/docs`.

## 8. Audit

The route writes one audit row through `writeRouteAudit(c, …)` with
`action: 'quote.accepted_on_behalf'`, `resourceType: 'quote'`, `resourceId`,
and details `{ method, reference, signerName, signerEmail, invoiceId,
invoiceNumber, contractIds, wasDraft }`. Build the payload in a small SSOT
module `services/quoteAcceptOnBehalfAudit.ts` mirroring
`quoteSupersedeAudit.ts`, so the shape is unit-testable without HTTP.

Customer-initiated accepts remain audit-less (they are anonymous); this PR does
not change that.

## 9. Web UI

### Action (`apps/web/src/components/billing/quotes/QuoteActions.tsx`)

- Button **"Accept on behalf"**, shown when `can('quotes','accept')` and status
  is `draft | sent | viewed`. Placed next to Send, secondary style. Hidden, not
  disabled, when the permission is missing, matching the other quote actions.
- Dialog fields: Method (select), Reference (required text, helper copy:
  "Where a reviewer would find the customer's agreement"), Signer name
  (required, prefilled from the quote's `billToName`, else blank; never derive
  a name from an email address), Signer email (optional, prefilled from the
  first `quote_recipients` row when one exists).
- Consequences block, always visible:
  - "An invoice for <one-time total> will be issued and numbered now."
  - "Recurring lines become draft contracts you activate later." (only when
    recurring lines exist)
  - "The invoice will be emailed to the customer." (only when the partner's
    `auto_email_invoice_on_quote_accept` flag is on; the flag is served by the
    partner billing settings endpoint used by `PartnerBillingSettingsPage`, so
    the dialog fetches it on open rather than assuming the quote page has it)
  - On `draft`: "This quote was never sent. The customer's first sight of it
    will be the invoice."
- Primary button label: "Accept and issue invoice". Submits via `runAction`
  with `successMessage: 'Quote accepted. Invoice <number> issued.'`, then
  refetches the quote so the workspace switches to the converted read view.
- API wrapper `acceptQuoteOnBehalf(id, body)` in `apps/web/src/lib/api/quotes.ts`.
- `can` helper: `quotes.accept` is a new action string; type it in
  `quoteTypes.ts` if the action union is typed.

### Provenance (`QuoteDetail.tsx`)

The acceptance panel that today shows "Accepted by <signer> on <date>" renders,
for `origin = 'on_behalf'`: "Accepted on behalf of <signerName> by <tech
display name> on <date> · <method label> · <reference>". `GET /quotes/:id`
already returns the acceptance record; extend the serializer with the four new
fields plus the recorder's display name (join `users`, null-safe for deleted
users).

### Portal (`apps/portal/src/components/portal/QuoteDetailView.tsx`)

Where the signature block would render for a converted quote, on-behalf rows
show "Accepted on your behalf by <partner name> on <date>." with no method or
reference (internal detail). The portal API serializer exposes `origin` only.

## 10. Testing

Frameworks per repo standard (Vitest API, jsdom web). Red first on each.

**Route** (`routes/quotes/lifecycle.test.ts`, real `requirePermission`, mocked
`getUserPermissions`):
- `quotes:send` alone → 403; `quotes:accept` → 200.
- Body validation: missing `reference` → 400; bad `method` → 400.
- Audit row written with the SSOT payload.

**Service** (`quoteAcceptService.test.ts`):
- Draft quote, origin on_behalf → claimed (number allocated, snapshots frozen,
  no recipients, no accept token, no public link), then converted; invoice
  issued at the quote's totals.
- Draft quote, origin customer → still rejected (guard unchanged).
- `expired`/`declined` → 409 `QUOTE_NOT_ACCEPTABLE`; `superseded` → 410.
- Acceptance row: `origin`, `method`, `reference`, `recorded_by_user_id`
  populated; `quote_sha256` equals the customer-path hash for the same quote.
- Draft revision on_behalf → parent superseded and its link revoked.
- Concurrency: two on-behalf accepts on one quote → one invoice (reuses the
  existing `FOR UPDATE` test pattern).

**Integration** (`src/__tests__/integration/quoteAcceptOnBehalf.integration.test.ts`,
real Postgres): draft → accept-on-behalf → invoice `sent` with a number, total
equals quote one-time total, tax equals quote `taxRate` (not the org's current
rate), recurring lines produced draft contracts, `quote_acceptances` row has
the four fields, no `public_link_*` set. Migration replay via the standard
`readFileSync` path so a rename shows up in `autoMigrate.test.ts`.

**Migration/contract suites:** `migrationRlsScope.test.ts` (system scope
elected before the back-fill), `tenant-export-policy.integration.test.ts`,
`tenantExportErasureRoundtrip`, `rls-coverage` (no new table, sanity only),
`permissionsCatalog.test.ts`.

**Web** (`QuoteActions.test.tsx`): button present only with `quotes:accept`
and only on `draft|sent|viewed`; draft warning shown only on draft; submit
calls `runAction` with the typed body; `no-silent-mutations` stays green.

**Manual acceptance on a worktree stack:** run the flow from a draft with a
recurring line, then verify as the customer in the portal that the quote shows
the on-behalf notice and the invoice pay link works. Note from the revisions
run: use `pressSequentially` for money inputs; portal islands do not hydrate
under `wt-stack` (#3906), so check portal copy in server HTML.

## 11. Risks and mitigations

- **Mis-click burns an invoice number and may email the customer.** Mitigated
  by the required reference field and the consequences block; the invoice can
  be voided as any other. Not adding an undo window: the accept transaction
  also drafts contracts and stages Pax8, and unwinding those is a larger
  feature than this one.
- **`sendQuote` extraction regresses send.** The helper is a pure move;
  `sendQuote`'s existing suite plus the revisions integration suite cover the
  supersede path.
- **Permission back-fill misses a custom role.** The migration matches on the
  existing `quotes:send` grant across all roles; the agreements migration
  proved the pattern.
- **Stacked-PR CI blind spot.** Single PR against `main`; integration job
  runs on the PR itself.

## 12. Follow-ups to file at PR time

1. Evidence attachment on an on-behalf acceptance (signed PDF / PO upload).
2. Decline on behalf, same dialog shape, `declineQuoteByActor` already exists.
3. Optional customer notification email on on-behalf acceptance ("Your
   provider recorded your acceptance of Q-…; reply if this is wrong").
