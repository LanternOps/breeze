---
tracking_issue: LanternOps/breeze#8865
---
# Standalone agreement signing — Spec

**Status:** draft (spec-drafted, awaiting approval).
**Tracking:** LanternOps/breeze#8865.
**Vocabulary:** follows `2026-09-14-agreements-vocabulary-and-ia-design.md` §2 — "Agreement template", "Signed agreement", "Contract" (billing). This spec adds one term: **Agreement request** — an agreement sent to a client for signature on its own. UI never says "contract document".
**Advisor quorum:** Fable + Codex `gpt-6-astra` xhigh (verdict in §9).

All file:line references are against `origin/main` at `ec95c2f236`.

## 1. Problem

A signed agreement (`contract_documents`, `apps/api/src/db/schema/contractDocuments.ts:66-86`) can only come into existence by accepting a quote. The only writer is `createExecutedDocuments` (`apps/api/src/services/contractDocumentService.ts:198`), whose only caller is `acceptQuote` (`apps/api/src/services/quoteAcceptService.ts:681`). An MSP whose client is already on an MSA and now needs a HIPAA BAA, a DPA or an MSA amendment signed has to:

1. Build a quote carrying the agreement section plus a $0 line, because send refuses a quote with no customer-visible line (`apps/api/src/routes/quotes/lifecycle.ts:301`, `QUOTE_EMPTY`).
2. Send it. The client sees a $0 line table, a "Total $0.00" box, the sign panel, and the agreement **collapsed underneath** (`apps/portal/src/components/portal/quoteAgreements.tsx`, #7040). The thing being signed is the hidden part.
3. After acceptance, find the signed agreement under Agreements → Signed agreements (unlinked, because a $0 quote creates no billing contract — `contractDocumentService.ts:216`) and link it by hand.

It leaves $0 "quotes" in lists and reports, and the signer evidence lives on `quote_acceptances`, which `ON DELETE CASCADE`s with the quote (`apps/api/src/db/schema/quotes.ts:241`) while the signed PDF keeps null references (`contractDocuments.ts:69-70`). A BAA carries a ~6-year HIPAA retention expectation; the record that proves who signed it must not be deletable as a side effect of tidying quotes.

## 2. Users & scope

**Tenancy.** An agreement request is a per-org transactional record, exactly like `contract_documents` and `quotes`: it names one client org, one signer set, one frozen document. It is **not** a config/policy table, so the partner-wide-first rule (epic #2135) does not apply; `org_id NOT NULL`, Shape-1 RLS (`breeze_has_org_access(org_id)`), matching `2026-07-16-contract-documents.sql:85-156`. The *template* it pins stays dual-axis (`contract_templates`, org XOR partner). On the **staff** path (create/PATCH/record-signed/preview) templates are read in the request's own context — the partner-wide SELECT branch already exists (`apps/api/migrations/2026-10-10-100400-identity-contracts-partner-wide-select.sql:63-70`), so no system escalation. Only the **unauthenticated/portal accept** path pre-fetches the pinned version under system scope, exactly as `loadContractBlockRenderData` is used from `routes/quotesPublic.ts:248` today, and that read is never the authorisation guard (§3.1).

**MSP staff (web).** Partner- and org-scope tokens, gated by the `agreements` resource (`packages/shared/src/constants/permissions.ts:100-101`) plus one new action (OD7, resolved with the quorum):

| Action | Permission | Note |
|---|---|---|
| List/view requests, download signed agreement, preview | `agreements:read` | same as `routes/contracts/documents.ts:23` |
| Create/edit/delete a draft | `agreements:write` | template authorship + drafting |
| Send, remind, copy link, void, **record signed elsewhere** | `agreements:send` (**new**) | sending a legal document to a client and recording their assent are a different blast radius from editing templates, as `quotes:send`/`quotes:accept` are from `quotes:write` (`permissions.ts:106,112`). Back-filled from `agreements:write` in the W2 migration (pattern: vocabulary spec §4) so nobody loses a capability they have today. |

**Client-side signers (portal).** Two identities, mirroring quotes:
- **Token recipients** — anyone holding the signing link emailed at send time. Public page, no login; the link is a signed JWT with a per-request `jti`, single-use, expiring with the request (pattern: `apps/api/src/services/quoteAcceptToken.ts:70-87`, `routes/quotesPublic.ts`).
- **Portal users** — a logged-in portal user whose email is in `agreement_request_recipients` can sign from the portal (pattern: the `quote_recipients` check at `apps/api/src/routes/portal/quotes.ts:249-254`). Portal users not on the recipient list can see that a request exists for their org but cannot sign it (fail closed, like legacy quotes without recipient rows).

**Out of this spec's users:** MSP countersigners (Open Decision 5), third-party witnesses.

## 3. Proposed design

### 3.1 Entry points (web)

All three open the same **Send agreement for signature** dialog (`apps/web/src/components/agreements/SendAgreementDialog.tsx`, new), pre-filled from where it was opened:

| Surface | File | Pre-fill |
|---|---|---|
| Org record → Billing tab → Agreements section | `apps/web/src/components/organizations/record/OrgBillingTab.tsx` (embeds `SignedAgreementsPage` with `lockedOrgId`) | org |
| Contract workspace header, beside the "Under {{template}} v{{n}}" pill (`apps/web/src/components/contracts/ContractWorkspace.tsx:159`) | `ContractWorkspace.tsx` | org + contract |
| Agreements → Signed agreements page header | `apps/web/src/components/agreements/SignedAgreementsPage.tsx` | none (org picker) |

Dialog fields: organization (locked when pre-filled) · agreement template (published version only; pinned at create — `templateVersionId` is immutable once sent) · optional **file against contract** (that org's contracts) · recipients (emails; pre-filled from the org's billing contact) · optional cover message · expiry (default now + 30 days, no setting — see §3.6) · manual variable values for any `{{…}}` the template uses that the auto set does not supply. The dialog creates the draft first (`POST …/agreement-requests`), shows the live preview from `GET …/:id/preview` (§5) so the sender sees exactly what the client will see, then `POST …/:id/send` — all through `runAction` (`apps/web/src/lib/runAction.ts`).

**Template authorisation (every staff write).** Create, PATCH and record-signed run the same guard the quote writer runs for a contract block — `assertContractBlockValid` (`apps/api/src/services/quoteService.ts:1581-1600`: version exists, belongs to the template, is `published`; template not archived; template owned by the target org or its partner). Extract it as `assertTemplateVersionUsable(ref, { orgId, partnerId })` in `contractTemplateService` and call it from both writers. The system-scope render on the accept path is **not** a substitute for this check.

The Signed agreements page gains a status chip row — **Awaiting signature · Signed · Declined/voided/expired** — persisted in `window.location.hash` (`#status=pending`, via `useHashState` as `SignedAgreementsPage.tsx:6` already does for `#unlinked`). Pending requests are rows in the same table (Template · Organization · Recipients · Sent · Expires · Status) with row actions **Remind / Copy link / Void**. No third tab: the vocabulary spec's two-tab shell stays.

### 3.2 Client signing page (portal)

- Public: `apps/portal/src/pages/agreement/[token].astro` → `<PublicAgreementView>` (new), structured like `apps/portal/src/pages/quote/[token].astro` + `PublicQuoteView.tsx` but with **no lines, no totals, no price**.
- Logged-in: `apps/portal/src/pages/agreements/[id].astro` + `agreements/index.astro` → `<AgreementDetailView>`; the portal dashboard lists requests awaiting the user's signature.

Layout, top to bottom: `DocumentHeader` (partner branding, template name, "Agreement from {{partner}} for {{org}}", effective date) → the agreement **expanded** → `SignaturePanel` **below** it → cover message, download link. Reuse, concretely:

| Piece | Today | Change |
|---|---|---|
| `DocumentPaper`, `DocumentHeader`, `DocumentFooter` | `apps/portal/src/components/portal/documentShell.tsx:30,98,371` | none |
| `ContractBody` (authored HTML / uploaded PDF iframe + download) | `quoteAgreements.tsx:51` — module-private | **export** it; its `ContractSummary` input is built from the request DTO instead of a quote block |
| `SignaturePanel` | `SignaturePanel.tsx:43` | add optional `heading` / `intro` props — the copy "sign and accept this proposal" is hard-coded (`SignaturePanel.tsx:76-78`); add an optional **signer email** field (`requireSignerEmail`) so a shared link can name the receipt inbox (§3.6). Pass `agreements=[]`, `acceptLabel="Sign agreement"`, `testIdPrefix="public-agreement"` / `"agreement"`. Quote callers are unchanged (defaults keep today's copy). |
| Decline with reason | `SignaturePanel` inline confirm → `onDecline(reason)` | none |

Signing = typing the full legal name + ticking the box (the `TypedSignatureProvider`, `apps/api/src/services/acceptanceProvider.ts:27`). On the public page the signer email is **required** (the token is shared by every recipient, so it is the only way to know who to send the signed copy to); on the logged-in portal it defaults to the session user's email. The portal `api.ts` gets `getPublicAgreement(token)`, `acceptPublicAgreement`, `declinePublicAgreement`, plus the logged-in equivalents.

### 3.3 Acceptance → signed agreement filed directly

New service `apps/api/src/services/agreementRequestAcceptService.ts`, `acceptAgreementRequest(params)`, shaped after `acceptQuote` (`quoteAcceptService.ts:168`) but ~1/5 the size — no invoice, no contracts, no Pax8:

1. `SELECT … FOR UPDATE` on the request row (serialises double-submit, `quoteAcceptService.ts:171-174`).
2. Durable single-use check **before** the status guard: `public_response_consumed_at IS NOT NULL AND public_response_jti = claims.jti` → 401 `RESPONSE_CONSUMED` (`quoteAcceptService.ts:177-187`); then the DB-authoritative link check `public_link_revoked_at IS NOT NULL` → 410 (`isPublicLinkDead`, `routes/quotesPublic.ts:87-89`).
3. Status guard: `sent` | `viewed` for a customer signature; `draft` | `sent` | `viewed` for on-behalf (§3.4 — same reasoning as `quoteAcceptService.ts:206-214`: the tech must not have to email a live link for something already agreed). `isAgreementRequestExpired(expiresAt, now)` → 410 `AGREEMENT_EXPIRED`. `expires_at` is a **timestamptz instant** (not a UTC calendar day like `quotes.expiry_date`, `services/quoteExpiry.ts:4-9`); the one helper is used by send, view, accept, decline, remind, copy-link and the reaper so no two paths disagree.
4. Capture: customer path → `getAcceptanceProvider().capture(...)`; on-behalf path builds the capture directly (`quoteAcceptService.ts:386-420`), same guard that a blank signer name is a 400.
5. Content hash: `computeAgreementSha256(input, hashVersion = 1)` in `services/agreementContentHash.ts`, same canonicalisation as the `contracts` part of `computeQuoteSha256` (`apps/api/src/services/quoteContentHash.ts:112-121`): sorted keys, `JSON.stringify`, sha256. Two branches of one versioned family: rendered → `{ kind:'rendered', versionSha, vars (manual over auto, sorted), renderLocale, effectiveDate }`; externally-signed upload → `{ kind:'external', versionSha, bytesSha256, mime }` so the bytes are bound too (OD4).
6. **Freeze** via the shared path (§3.7) → one `contract_documents` row with `source_kind='request'`, `agreement_request_id`, `contract_id` copied from the request, and the evidence snapshot columns (§4.2) populated. Before freezing, the request path asserts the unresolved-variable set is **empty** and throws `AGREEMENT_VARIABLES_UNRESOLVED` — it must never reach the blank-and-capture fallback at `contractDocumentService.ts:246-260`, which exists for a quote send gate that has already run.
7. Request → `signed`, `signed_at`, and for a token accept `public_response_jti/consumed_at/outcome` in the same transaction. The signed agreement is found from the request via `contract_documents.agreement_request_id` (unique partial index) — there is deliberately **no** back-reference column on the request (§4.1).
8. Post-commit, by the caller (never inside the tx — `quoteAcceptService.ts:614-615`): revoke the jti in Redis, emit `agreement.signed`, email the signed copy and the outcome (§3.6).

One request, one signer: any recipient may settle it and the **first committed response wins** (the `FOR UPDATE` + status guard make the second a 409/401). Multi-signer is OD5.

Because `contract_id` was chosen at send, the signed agreement appears on the contract's Signed agreements section immediately. If none was chosen, it is listed unlinked and `linkContractDocument` (`contractDocumentService.ts`, PATCH `/contracts/contract-documents/:id`) still works unchanged.

The route wrappers copy the quote ones: public `POST /agreements/public/:token/accept` and portal `POST /portal/agreements/:id/accept` both run `runOutsideDbContext(() => withSystemDbAccessContext(() => acceptAgreementRequest(...)))` (`routes/quotesPublic.ts:252`, `routes/portal/quotes.ts:272`), with the pinned template version pre-fetched outside the transaction under system scope (`lifecycle.ts:146-151`: the public path has no user context at all, and the accept transaction itself runs system-scoped). Every public token route resolves the request through one shared `resolve()` that checks token validity, Redis jti revocation, merged-org continuity (`resolveMergedOrgIds`) and the org lifecycle gate, exactly as `routes/quotesPublic.ts:60-66`, and one `isPublicLinkDead` predicate — enumerated by a test like `quotesPublic.superseded.test.ts` so a new route cannot skip it.

### 3.4 Record signed elsewhere (on-behalf)

`POST /contracts/agreement-requests/record-signed` (`agreements:send`), multipart. Creates a request **and** signs it in one transaction (`draft → signed`, no link minted) with `origin='on_behalf'`, `method ∈ QUOTE_ACCEPT_ON_BEHALF_METHODS` (reuse the tuple, `packages/shared/src/validators/quotes.ts:446-460`), required `reference` ("DocuSign envelope 4F2…", "wet-ink copy in client folder"), `signerName`, optional `signerEmail`, `signedAt` (the real signing date, may be in the past), optional `contractId`. Two shapes:

- **Template-based** — `templateVersionId` + variable values: the signed agreement is Breeze's own render (§3.7), exactly like a customer signature, with the evidence columns recording that an MSP tech recorded it. Same fail-closed unresolved-variable check as send (§3.5).
- **Externally-signed file** — `file` part (PDF/PNG/JPEG, sniffed, 10 MB; reuse `sniffEvidenceMime` + limits from `apps/api/src/services/quoteAcceptanceEvidence.ts:36-125`) **and** the `templateVersionId` it is an instance of. The uploaded bytes become `contract_documents.pdf_data` verbatim with `mime` from the sniff and `rendered_html NULL` — the same storage the `sourceType === 'uploaded'` branch uses today (`contractDocumentService.ts:223-234`). Inline bytea, no blob-store key, so nothing to add to `OBJECT_PRECLEAR_TABLES` (`services/tenantCascade.ts:1392`). `template_id/template_version_id` stay NOT NULL: an externally-signed copy is always "an instance of template X" so it lists, filters and counts like every other signed agreement (Open Decision 3 covers a template-less upload). The download route must name the file by its stored MIME (`contentDispositionFor`, `services/attachmentFilename.ts`) — today's `GET /:id/pdf` always says `.pdf` (`routes/contracts/documents.ts:79`); the list row carries `mime` so the UI labels a scanned image honestly.

The web dialog (**Record signed agreement**, same three entry points) is the counterpart of the accept-on-behalf dialog on quotes. `writeRouteAudit` with a new `billing.agreement.recorded_on_behalf` event (pattern: `services/quoteAcceptOnBehalfAudit.ts`).

### 3.5 Lifecycle

```
draft ──send──▶ sent ──first open──▶ viewed ──sign──▶ signed
  │               │                    │
  │               ├──decline───────────┴──▶ declined
  │               ├──void (MSP)────────────▶ voided
  │               └──expires_at passes─────▶ expired
  └──delete (draft only)
```

| Transition | Who | Mechanics |
|---|---|---|
| send | MSP | re-runs the template guard (§3.1), writes recipients, mints the token (identity columns persisted so **resend reuses the same link**, `2026-08-13-quote-accept-token-identity.sql`), emails recipients, `sent_at`. Send gate: `findUnresolvedVariables` (`contractTemplateRender.ts:379-392`) must be empty. It tests **key presence**, so the request-side auto map (§3.7) must simply **omit** `quote.*`, `totals.*` and `dates.expiry` — then a template that declares them is refused with `AGREEMENT_VARIABLES_UNRESOLVED` unless the sender supplied them as manual values (an auto declaration never falls back to the manual map, so the dialog surfaces them as required manual fields). A blank `{{totals.monthly}}` in a BAA is a worse legal record than a refused send. |
| viewed | client | public/portal GET stamps `first_viewed_at`, `sent→viewed` (`services/quoteLifecycle.ts:1318 markQuoteViewed`) |
| remind / resend | MSP | `POST /:id/remind`: re-sends the same link (regenerated from identity — `quoteAcceptToken.ts:100`), increments `reminder_count`, `last_reminded_at`. Manual only in v1; an automatic reminder job is Open Decision 8. |
| void | MSP | `sent`/`viewed` → `voided` with `void_reason`, `voided_by`, **`public_link_revoked_at = now()`** (the DB-authoritative kill, mirroring `quotes.public_link_revoked_at` and checked by every token route via `isPublicLinkDead`) plus the Redis jti revoke (`quoteAcceptToken.ts:134`, a 30-day marker that is only the hot path). Signed requests **cannot** be voided or deleted (409 `AGREEMENT_ALREADY_SIGNED`) — retention, §4.4. |
| copy link | MSP | `GET /:id/link` regenerates the stable link from the persisted identity; 409 when not `sent`/`viewed`. |
| decline | client | reason optional; durable jti consumption as in `routes/quotesPublic.ts:306-355`. |
| expire | system | `agreementRequestExpiryReaper` cloned from `apps/api/src/jobs/quoteExpiryReaper.ts:59` (flip `sent/viewed` past `expires_at`, audit `billing.agreement.expired`); the accept path also checks at read time so the sweep is a status tidy, not the guard. |
| delete | MSP | `draft` only. Everything else is immutable history. |

**Token.** A sibling `services/agreementAcceptToken.ts`, **not** a generalisation of `quoteAcceptToken.ts`: its claim insertion order and payload key order are load-bearing for byte-identical regeneration and pinned by a golden-vector test (`quoteAcceptToken.ts:29-40`), so quote tokens must keep their exact no-`kind` payload. The sibling shares the keyring/`kid` helpers and the Redis revoke helpers (`quoteAcceptToken.ts:134-143`, fail-closed when Redis is down) but has its own claim set `{ kind:'agreement_request', requestId, orgId, partnerId, jti }` and its own golden vector; each verifier rejects the other's tokens. `exp` = `expires_at` (not the 30-day default at `quoteAcceptToken.ts:10`), `jti` random UUID, revocation keyed by jti; the DB columns (`public_link_revoked_at`, `public_response_*`) are the durable authority.

### 3.6 Notifications

| Event | Recipient | Mechanism |
|---|---|---|
| sent / remind | request recipients | new `services/agreementRequestEmail.ts` `buildAgreementRequestTemplate` shaped after `buildQuoteTemplate` (`services/quoteEmail.ts:36`), rendered through `emailTemplates/renderPartnerEmail.ts` with partner branding; link = `portalBase()` (`services/portalUrl.ts:35`) + `/agreement/<token>` |
| signed (customer) | creator, else partner billing inbox | `services/agreementOutcomeNotify.ts` cloned from `notifyQuoteOutcome` (`services/quoteOutcomeNotify.ts:30`): bus event `agreement.signed` + email; no email for an MSP-recorded outcome (same rule) |
| signed | signer email (captured at signing, §3.2) + every request recipient | "Your signed copy" email with the file attached (≤ 10 MB). No portal account is needed and the signing token is already consumed, so the attachment is the delivery; an org that has portal users can also download it from the portal (§5). |
| declined / expired | creator | bus event + email, as above |

Events `agreement.sent|viewed|signed|declined|voided|expired` ride the quote-events bus pattern (`services/quoteEvents.ts`) so webhooks/integrations see them. **No new setting is introduced** (expiry is a per-request field with a hard-coded default, reminders are manual), so settings rule 9 does not fire in this spec; the first setting (default expiry, auto-reminder cadence) would be partner-level under Billing → Agreements and is noted in Open Decision 8.

### 3.7 Shared accept-and-freeze path (extraction)

`createExecutedDocuments` (`contractDocumentService.ts:198-292`) and `resolveAutoVariables` (`contractTemplateRender.ts:289`) both take a full `QuoteRow`. Extract:

```ts
// services/contractTemplateRender.ts
export interface AgreementRenderContext {
  clientName: string; clientAddress: BillToAddress | null; sellerName: string;
  currencyCode: string; renderLocale: string; effectiveDate: string | Date;
  quote?: { number: string | null; title: string | null; expiryDate: string | null;
            totals: { oneTime; monthly; annual; total } }; // absent on a request
}
export function renderContextFromQuote(q: QuoteRow, opts): AgreementRenderContext
export function renderContextFromRequest(r: AgreementRequestRow, org, partner): AgreementRenderContext
export function resolveAutoVariables(ctx: AgreementRenderContext, opts?): Record<string,string>
```
When `ctx.quote` is absent the keys `quote.*`, `totals.*` and `dates.expiry` are **omitted** from the returned map (not set to `''`), because `findUnresolvedVariables` tests key presence (§3.5). For a quote context the function must return the exact map it returns today — same keys, same money formatting, manual-over-auto precedence applied by the caller as now (`contractDocumentService.ts:73-81`), HTML-form vs `pdf: true` maps kept distinct (`:60-72`), `renderLocale` precedence unchanged (`contractTemplateRender.ts:289-310`). `client.name` on a request comes from the org's billing name, snapshotted at send as `client_name_snapshot` so a later org rename does not change what was hashed.

**Hash compatibility is an input property, not a byte property.** `verifyQuoteAcceptanceHash` (`services/quoteAcceptanceVerify.ts:46-60`) re-derives the hash from the quote, blocks, lines and *resolved variables* — it never hashes the PDF. So the refactor must preserve the full variable map, the accepted-date pin, the persisted locale incl. legacy NULL → `'en'` (`acceptanceRenderLocale`, `:25`), and both v1/v2 canonical forms. The existing verifier tests mock the resolver (`quoteAcceptanceVerify.test.ts:30`); W1 adds **golden fixtures** (real acceptance rows + their stored `quote_sha256`) that run the real resolver through the extracted path. Note the limit honestly: after a quote is deleted the snapshot preserves *attribution and PDF-byte integrity* (`sha256`), not an independent re-verification of the original quote hash.

```ts
// services/contractDocumentService.ts
export async function freezeSignedAgreement(input: {
  source: { kind: 'quote'; quoteId; quoteAcceptanceId } | { kind: 'request'; agreementRequestId };
  orgId; contractId: string | null; templateId; templateVersionId;
  render: { sourceType; bodyHtml; fileData; templateName; versionSha256 };
  ctx: AgreementRenderContext; manualValues: Record<string,string>;
  evidence: SignedAgreementEvidence;           // §4.2 snapshot
  externalBytes?: { data: Buffer; mime: string }; // §3.4 upload — skips rendering
}): Promise<{ id: string; sha256: string }>
```
`createExecutedDocuments` becomes a loop over quote contract blocks calling `freezeSignedAgreement` — same inputs, same `rendered_html`/PDF bytes, so existing acceptance hashes keep verifying (`services/quoteAcceptanceVerify.ts:46`). `renderAuthoredContractPdf` takes `ctx` instead of `quote` (it only reads `sellerSnapshot.name` and `billToName`, `contractDocumentService.ts:167-171`). Both callers keep the invariant in the file header: the freeze runs **inside the caller's transaction**, a failure rolls the acceptance back, and it uses the bare `db` under the caller's system context.

## 4. Tenancy & data model impact

Migration name: sort after the newest shipped file, `2026-12-28-130000-pam-reconciliation-reset-capability.sql` — i.e. `2026-12-29-<HHMMSS>-agreement-requests.sql` or later at implementation time (never a `2026-10-15-*` name; `2026-08-06` is closed). Idempotent, no inner `BEGIN`, `SELECT set_config('breeze.scope','system',true)` before the back-fill (§4.2). RLS in the same file.

### 4.1 New tables

**`agreement_requests`** — Shape 1, `org_id NOT NULL`. Auto-discovered by `rls-coverage.integration.test.ts` (no allowlist entry needed). Four per-command policies on `breeze_has_org_access(org_id)`, copied from `2026-07-16-contract-documents.sql:144-156`.

| Column | Type | Note |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid NOT NULL → organizations | |
| `status` | text NOT NULL CHECK IN (draft, sent, viewed, signed, declined, voided, expired) | |
| `template_id`, `template_version_id` | uuid NOT NULL → contract_templates / _versions `ON DELETE RESTRICT` | pinned at send; same as contract_documents |
| `contract_id` | uuid NULL | composite FK `(contract_id, org_id) → contracts(id, org_id)` **`ON DELETE SET NULL (contract_id) DEFERRABLE INITIALLY IMMEDIATE`** — the column list is required or the SET NULL also targets `org_id NOT NULL` and a contract delete fails; exact precedent `apps/api/migrations/2026-10-15-170000-service-deliverables.sql:56-59`. Unique index `contracts_id_org_uq` exists (`schema/contracts.ts:58`). A request can never file against another org's contract. |
| *(no `signed_agreement_id`)* | — | **Deliberately absent.** A back-reference plus `contract_documents.agreement_request_id` would form an FK cycle; `topologicalCascadeOrder` includes `SET NULL` edges unless the constraint is named in `CASCADE_ORDER_SET_NULL_EDGE_BREAKS` (`services/tenantCascade.ts:1375,1441`), so erasure would fail even on empty tables. The signed agreement is found by `agreement_request_id` (unique partial index `WHERE agreement_request_id IS NOT NULL`). |
| `public_link_revoked_at` | timestamptz | set by void; DB-authoritative link kill (`quotes.public_link_revoked_at` precedent) |
| `label`, `cover_message` | text | |
| `variable_values` | jsonb NOT NULL DEFAULT '{}' | manual `{{…}}` values; `excludedOpen` |
| `client_name_snapshot`, `client_address_snapshot` (jsonb), `seller_snapshot` (jsonb) | | frozen at send, feed the render context |
| `document_locale`, `render_locale` | varchar(16) | as quotes (#3777) |
| `effective_date` | date | default = sign date; may be set by sender |
| `expires_at` | timestamptz NOT NULL | |
| `sent_at`, `first_viewed_at`, `signed_at`, `declined_at`, `voided_at`, `expired_at` | timestamptz | |
| `decline_reason`, `void_reason` | text | |
| `accept_token_jti`, `accept_token_issued_at`, `accept_token_expires_at`, `accept_token_kid` | | stable link identity (`2026-08-13-quote-accept-token-identity.sql`) |
| `public_response_jti`, `public_response_consumed_at`, `public_response_outcome` | | durable single-use (#2875) |
| `reminder_count` int NOT NULL DEFAULT 0, `last_reminded_at` | | |
| `created_by`, `voided_by` | uuid → users `ON DELETE SET NULL` | |
| `created_at`, `updated_at` | | |

Indexes: `(org_id)`, `(org_id, status)`, `(contract_id)`, `(expires_at) WHERE status IN ('sent','viewed')` for the reaper.

**`agreement_request_recipients`** — mirrors `quote_recipients` (`schema/quotes.ts:297-310`): `id`, `request_id`, `org_id NOT NULL`, `email` (lower/trim CHECK), `created_at`; unique `(request_id, email)`; composite FK `(request_id, org_id) → agreement_requests(id, org_id)` **DEFERRABLE INITIALLY IMMEDIATE ON DELETE CASCADE** (a request needs a unique `(id, org_id)` index for this). Shape 1, same four policies. Sorts before `agreement_requests` in `localeCompare` (`_` < `s`), which is also the FK-safe order.

### 4.2 `contract_documents` changes (ALTER)

- `source_kind text NOT NULL DEFAULT 'quote' CHECK IN ('quote','request')` — the **durable** source discriminator.
- `agreement_request_id uuid NULL → agreement_requests ON DELETE SET NULL`.
- CHECK `contract_documents_one_source_chk`: `NOT (quote_id IS NOT NULL AND agreement_request_id IS NOT NULL) AND (source_kind <> 'quote' OR agreement_request_id IS NULL) AND (source_kind <> 'request' OR (quote_id IS NULL AND quote_acceptance_id IS NULL))`.

  Why not a strict XOR on the two FK columns: both are `ON DELETE SET NULL`, so after the source row is deleted both are NULL and a strict XOR would raise 23514 **during the parent delete** — the same trap `2026-10-27-100000-quote-acceptances-on-behalf.sql:68-77` documents for `recorder_chk`. `source_kind` is what a reviewer reads; the FKs are conveniences that may legitimately go NULL. The writer (`freezeSignedAgreement`) is the only insert path and always sets the matching FK.
- FK direction forces `SET NULL`: `agreement_requests` sorts before `contract_documents` in `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, `services/tenantCascade.ts:505-523`), so erasure deletes requests first; `NO ACTION`/`RESTRICT` would abort it with 23503 (`tenantCascade.integration.test.ts` property 5).
- **Evidence snapshot** (the retention fix, Open Decision 2): `signer_name varchar(255)`, `signer_email varchar(255)`, `signed_at timestamptz`, `signer_ip varchar(64)`, `signer_user_agent text`, `acceptance_origin text CHECK IN ('customer','on_behalf')`, `acceptance_method varchar(32)`, `acceptance_reference text`, `recorded_by_user_id uuid → users ON DELETE SET NULL`, `content_sha256 char(64)`, `content_hash_version smallint`, `acceptance_render_locale varchar(16)`. All nullable so legacy rows load; the migration **back-fills** them from `quote_acceptances` for every row whose `quote_acceptance_id` still resolves, under system scope, with `GET DIAGNOSTICS` + `RAISE WARNING` row count. After this, a signed agreement is self-describing: deleting its quote (or request) no longer erases who signed it. The UI continues to say "accepted by X on D (quote Q-123)" from these columns, and `listContractDocuments` (`contractDocumentService.ts:354-398`) reads `signerName`/`signedAt` from them instead of the `quote_acceptances` left join.
- `quote_acceptances` is **not** changed; it remains the primary acceptance record for quotes (hash verification, evidence file, dispute view).

### 4.3 Registrations (mechanical — grep, don't judge)

| List | File | Entry |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `apps/api/src/services/tenantCascade.ts:505` | `'agreement_request_recipients'`, `'agreement_requests'` (alphabetical; both before `'agreement_…'`-adjacent entries — verify with `localeCompare`), children before parents holds |
| `orgMergeRegistry.ts` | `apps/api/src/services/orgMergeRegistry.ts:872` | both tables `repoint` (plain org rows; the composite FKs are deferrable so the merge's `SET CONSTRAINTS ALL DEFERRED` repoint succeeds) |
| `CORE_TENANT_EXPORT_POLICY` | `apps/api/src/services/tenantExportPolicyRegistry.ts:340,727` | `agreement_requests`: `included` = ids, status, timestamps, label, cover_message, reasons, snapshots' scalar columns, reminder counts, `created_by`, `voided_by`, `public_link_revoked_at`; `excludedSensitive` = **all four** `accept_token_jti/issued_at/expires_at/kid` and `public_response_jti` — exactly how `quotes` classifies them (`:734`); the `*_at` ones trip the suspicious-name check (`services/tenantExportPolicy.ts:230`) if merely `included`; `excludedOpen` = `variable_values`, `client_address_snapshot`, `seller_snapshot` (jsonb). `agreement_request_recipients`: all `included`. **`contract_documents` (column add)**: new scalar evidence columns `included`; `content_sha256`, `content_hash_version` `reviewedIncluded`; `pdf_data` stays `excludedOpen`. |
| `OBJECT_PRECLEAR_TABLES` | `tenantCascade.ts:1392` | **no entry** — no blob keys (§3.4) |
| `AUDIT_ADMIN_REQUIRED_TABLES` | `tenantCascade.ts` | only if Open Decision 2 picks the append-only option |
| `DEVICE_*` / `TICKET_*` lists | — | not applicable (no `device_id`/`ticket_id`) |
| `rls-coverage` allowlists | `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | none (Shape 1 auto-discovered) |

### 4.4 Retention semantics

- **Request deletion:** only `draft`. Signed/declined/voided/expired requests are history and return 409. There is nothing on a request that is the sole copy of evidence once signed, because the snapshot lives on the signed agreement (§4.2); the request keeps the sender side (who sent, when, reminders).
- **Quote deletion:** unchanged mechanics; the back-fill means the signed agreement retains signer evidence after `quote_acceptances` cascades. The evidence *file* on an on-behalf quote acceptance (`evidence_*`, #6633) still goes with the quote — noted, not fixed here (Open Decision 2).
- **Signed agreement deletion:** no API deletes `contract_documents` today and none is added.
- **Org deletion (GDPR erasure):** `cascadeDeleteOrg` deletes requests, recipients and signed agreements with the org, as it does today. This spec does **not** promise 6-year retention across erasure; a legal-hold model is Open Decision 2b. Tenant export includes the request metadata and the signed agreement row (bytes excluded as today).

## 5. API surface

New sub-mount **`/contracts/agreement-requests`** beside `/contracts/contract-documents` (`apps/api/src/routes/contracts/index.ts`), file `routes/contracts/agreementRequests.ts`. Justification: a request has its own lifecycle and write verbs; `contract-documents` stays a read/link resource for the *result*; the vocabulary spec's D4 (no API path renames, new endpoints live under existing mounts) is honoured. Same `requireScope('partner','organization','system')` + `agreements:*` middleware as `documents.ts:21-24`. Every mutation writes `writeRouteAudit`.

| Method & path | Perm | Body / effect |
|---|---|---|
| `GET /` | read | `?orgId&contractId&status=pending|signed|closed&templateId`; list rows joined with template name/version, recipients, signed agreement id |
| `POST /` | write | create `draft` (org, templateId → latest published version pinned, contractId?, recipients[], coverMessage?, expiresAt?, variableValues?, label?) |
| `GET /:id` | read | detail incl. timeline |
| `PATCH /:id` | write | draft only |
| `DELETE /:id` | write | draft only |
| `GET /:id/preview` | read | rendered HTML / uploaded file for the sender's preview, same render path as the client |
| `POST /:id/send` | **send** | template guard + variable gate → `sent`; returns `{ emailed, link }` |
| `POST /:id/remind` | send | resend same link; 409 unless `sent`/`viewed` |
| `GET /:id/link` | send | stable link (copy link) |
| `POST /:id/void` | send | `{ reason? }` |
| `POST /record-signed` | send | multipart (§3.4) → creates + signs; returns `{ request, signedAgreementId }` |

Public (unauthenticated, mounted **before** authed routers as `/quotes/public` is at `apps/api/src/index.ts:813-818`): `GET /agreements/public/:token` (DTO: branding, template name/version, rendered HTML or file URL, status, cover message, signer hint — never internal ids beyond the request id), `GET /agreements/public/:token/file`, `POST …/accept` (`acceptQuoteSchema` reused: `signerName`, `signerEmail?`), `POST …/decline` (`declineQuoteSchema`). Rate-limited like quotes.

Portal (`routes/portal/agreements.ts`, `portalAuth`): `GET /portal/agreements` (pending requests for the org), `GET /portal/agreements/:id`, `GET …/:id/file`, `POST …/:id/accept`, `POST …/:id/decline` — accept/decline require a recipient-email match (`routes/portal/quotes.ts:249-254`). Signed copies are addressed by **document id, not request id**, so quote-sourced agreements are served too: `GET /portal/signed-agreements` lists the org's `contract_documents` (both `source_kind`s, metadata only) and `GET /portal/signed-agreements/:documentId/file` streams the bytes with a MIME-correct filename. This is a new read model beside the document library — `services/portal/documentsReadModel.ts:34` reads only `org_documents` and is not widened.

Existing `GET /contracts/contract-documents` list rows gain `sourceKind`, `agreementRequestId`, and the evidence snapshot fields; the PDF stream and link endpoints are unchanged. `auditSensitiveRead` stays on every byte download (`documents.ts:83`).

## 6. Out of scope

- MSP countersignature and multi-party signing order (Open Decision 5 records the hook).
- Agreement-to-agreement relationships (BAA "under" an MSA) beyond both being filed on the same contract (Open Decision 6).
- A legal-hold / retention-after-erasure model (Open Decision 2b).
- Automatic reminder schedules and partner-level default settings (Open Decision 8).
- Template-less uploads (a signed document that is not an instance of any Breeze template) (Open Decision 3).
- Changing how quote-embedded agreements are *presented* (#7040 stays).
- Drawn/image signatures, third-party e-sign providers; the `AcceptanceProvider` seam (`acceptanceProvider.ts:16`) remains the place for that.
- Renaming DB tables, enums or API mounts (vocabulary spec D4/D5).

## 7. Open Decisions

**OD1 — Data shape.**
- A. **New `agreement_requests` (+ recipients) and the evidence snapshot on `contract_documents`; `quote_acceptances` untouched.** Pro: no change to a shipped `NOT NULL … CASCADE` column; one durable record per signed agreement; cascade order falls out of the FK direction (§4.2). Con: evidence exists in two places for quote-sourced agreements (acceptance row = primary, snapshot = durable copy).
- B. Generalise `quote_acceptances` into a source-agnostic acceptance table (`quote_id` nullable, `agreement_request_id` XOR). Pro: one acceptance table. Con: relaxes `quote_id NOT NULL` + cascade on a shipped table that every reader (`quoteAcceptanceVerify.ts`, evidence routes, portal detail) assumes; the table name lies; the retention gap is not fixed because the row still cascades with its source.
- C. New `agreement_acceptances` table (request-sourced only). Pro: symmetric with quotes. Con: a third evidence location, and `contract_documents` still is not self-describing — the §8 gap persists.
- **Recommend A.**

**OD2 — Retention / deletion policy for evidence.**
- A. **App-layer: signed requests undeletable (409), signed agreements have no delete API, evidence snapshot on the signed agreement, back-fill for legacy rows.** Pro: closes the quote-deletion gap without new DB machinery. Con: a future admin/bulk endpoint could still delete rows.
- B. Append-only `contract_documents`: `REVOKE DELETE` from `breeze_app` + immutability trigger, registered in `AUDIT_ADMIN_REQUIRED_TABLES` so erasure uses the admin role. Pro: DB-enforced. Con: `linkContractDocument` UPDATEs the row (trigger must allow `contract_id` only); more migration surface.
- **Recommend A for W1, B as a follow-up once the link-only UPDATE allowance is designed.**
- **OD2b — legal hold across org erasure.** Out of scope; recommend a follow-up issue ("retain signed agreements N years after org deletion, partner-visible, erasure of PII in the snapshot") rather than an implicit promise. The on-behalf evidence *file* on quote acceptances (#6633) still cascades with the quote — fold into the same follow-up.

**OD3 — Uploaded externally-signed copies.**
- A. **Allowed, must name the template version it instantiates; bytes stored verbatim in `pdf_data`, `mime` sniffed (PDF/PNG/JPEG), `acceptance_method='signed_document'`, reference required.** Pro: one storage path, lists/filters/usage counts stay truthful, no blob key. Con: a document that is not any Breeze template cannot be recorded.
- B. Also allow template-less uploads (`template_id` nullable). Pro: covers client-paper BAAs. Con: breaks the `NOT NULL` invariant every reader relies on; "Under {{template}}" pills and usage counts need a null branch.
- C. Only Breeze-rendered documents; externally-signed copies go to `org_documents`. Pro: no change. Con: the signed BAA is not an agreement in Breeze's eyes.
- **Recommend A**, with a "Generic uploaded agreement" template per partner as the documented workaround for B.

**OD4 — Content hash for request-sourced agreements.**
- A. **`computeAgreementSha256`, its own `hash_version`, two branches: rendered `{versionSha, sorted resolved vars, renderLocale, effectiveDate}` and external `{versionSha, bytesSha256, mime}` so an uploaded copy's bytes are bound (Codex).** Pro: minimal, verifiable with the same re-render path. Con: a second hash family to maintain.
- B. Reuse `computeQuoteSha256` with a synthetic quote. Con: canonical form includes quote fields that do not exist; brittle.
- **Recommend A.**

**OD5 — Countersignature.**
- A. **Out of scope; any one recipient may settle the request and the first committed response wins. Reserve the data shape**: evidence columns are the *one signer's*; a later `agreement_request_signers` table (role: signer|countersigner, order) would supersede the recipient list and migrate the scalar evidence. Nothing in this spec blocks it.
- B. Build a two-party flow now. Con: doubles the lifecycle, email set and portal surface for a use case not in the issue.
- **Recommend A.**

**OD6 — Agreement-to-agreement relationships (BAA under MSA).**
- A. **None in v1**: both documents are filed on the same contract; the contract is the grouping. Pro: zero schema. Con: an org with no billing contract has no grouping.
- B. `contract_documents.parent_document_id` (self-FK, same org, DEFERRABLE composite). Pro: expresses "amendment of"/"BAA under". Con: UI to pick the parent, a tree to render, cycles to guard.
- **Recommend A**, revisit with amendments/renewals (vocabulary spec §8 risk 1).

**OD7 — Permission for send and record-on-behalf.**
- A. `agreements:write` for both, stated in the PR. Pro: no migration, matches the issue text. Con: "edit templates" and "send a legal document / record a client's assent" are different blast radii; quotes separate `quotes:send` and `quotes:accept` from `quotes:write` (`permissions.ts:103-112`), and `contracts:write` is not a meaningful boundary to lean on.
- B. **Add `agreements:send` now** (send, remind, copy link, void, record-signed), back-filled action-for-action from `agreements:write` in the W2 migration (pattern: vocabulary spec §4; `Partner Billing` preset gets it, `Partner Billing Viewer` does not), catalog label + RBAC tests as that wave did.
- **Recommend B.** Fable's draft recommended A-then-follow-up; Codex disagreed on the grounds above and the long-term rule ("best design, not fastest") settles it — the migration pattern is already proven and a later split would have to claw back a capability. Recorded in §9 as resolved on the merits, not silently.

**OD8 — Lifecycle extras: automatic reminders, default expiry setting.**
- A. **v1: manual remind, per-request expiry with hard-coded 30-day default; no setting.** Pro: no settings rule-9 work, no scheduler. Con: MSPs must remember to remind.
- B. Partner-level setting (Billing → Agreements: default expiry, reminder cadence) + a BullMQ repeat job. Pro: hands-off. Con: a setting (home/level/resolver) and a job in the first cut.
- **Recommend A**, B in W4 with a rule-9 statement.

**OD9 — Quote-embedded agreements on the shared path.**
- A. **Yes: `createExecutedDocuments` delegates to `freezeSignedAgreement`; the migration back-fills the evidence snapshot on existing quote-sourced rows; the portal lists the org's signed agreements (both kinds) in one place.** Pro: one writer, retention fix applies to the existing N rows, `signerName/signedAt` in lists no longer vanish when a quote is deleted. Con: a touch to the quote accept path (regression risk; covered by `quoteAcceptService.test.ts` + hash-verification tests).
- B. Leave the quote path alone. Con: two writers to keep in lockstep; the §8 gap stays for quote-sourced agreements.
- **Recommend A.**

## 8. Test & rollout notes

**Contract / integration suites (Integration Tests job, 8 shards — never Test API):**
- `tenantCascade.integration.test.ts` — both new tables present, alphabetised, FK children before parents; org erasure with a signed request + signed agreement + recipients completes.
- `orgMergeRegistry.integration.test.ts` + `orgMerge.test.ts` (full unit suite) — merge policies registered; a merge with a request filed on a contract repoints both without 23503 (the deferrable composite FKs).
- `tenantCascade.integration.test.ts` topological pass — proves there is no FK cycle between `agreement_requests` and `contract_documents` (no entry needed in `CASCADE_ORDER_SET_NULL_EDGE_BREAKS`); deleting a contract nulls only `contract_id` on its requests.
- `quoteAcceptanceVerify` golden fixtures (new, Test API) — stored `quote_sha256` values from real v1 and v2 acceptances re-verify through the extracted resolver with the mock removed.
- `agreementAcceptToken.test.ts` golden vector + cross-rejection (a quote token is a 401 on every agreement route and vice versa); `quoteAcceptToken.test.ts` golden vector byte-identical before and after.
- `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` — every new column classified; `contract_documents` column adds included.
- `rls-coverage.integration.test.ts` — auto-discovery; plus a new `agreementRequestsRls.integration.test.ts`: cross-tenant forge insert as `breeze_app` → 42501; org-scoped read sees only its rows; a request filing against another org's contract → 23503 on the composite FK.
- `migrationRlsScope.test.ts` — the back-fill elects system scope first.
- New `contractDocumentsSourceCheck.integration.test.ts` — the one-source CHECK: both FKs set → 23514; deleting a quote leaves the snapshot intact and `source_kind='quote'`; deleting a draft request works, a signed one is refused by the service.

**Unit (Test API):** `agreementRequestAcceptService.test.ts` (status guard incl. draft-only-for-on-behalf, replay 401, revoked-link 410, expiry 410 at the instant boundary, on-behalf capture guard, unresolved variables refused before freeze, freeze called inside tx, first-response-wins); `agreementContentHash.test.ts` (determinism, key ordering, external branch binds bytes); `contractTemplateRender.test.ts` additions (`renderContextFromRequest` omits quote-only keys; quote context map byte-identical to today's); `assertTemplateVersionUsable` rejects another partner's template, an unpublished version, a version of a different template; `quoteAcceptService.test.ts` unchanged expectations through the extracted freeze; route tests per `documents.test.ts` shape, including every public route going through the shared `resolve()`/`isPublicLinkDead` (enumeration test); `agreementsSendPermission` seed/catalog/RBAC tests as in the vocabulary spec §4. Web: `SendAgreementDialog.test.tsx`, `SignedAgreementsPage.test.tsx` status chips (`#status=`), `no-silent-mutations.test.ts` passes without allowlist additions. Portal: `PublicAgreementView.test.tsx`, `AgreementDetailView.test.tsx`.

**E2E (Playwright, `data-testid` only):** `e2e-tests/tests/agreement-standalone-signing.spec.ts` modelled on `quote-contract-proposal.spec.ts`: send from contract workspace → open public link → agreement expanded, no price → sign → signed agreement appears on the contract's Signed agreements section; record-signed-elsewhere with upload; void kills the link (401 page). Testids use the `agreements-` prefix (`agreements-send-dialog`, `agreements-status-filter`, `public-agreement-sign-*`).

**Waves (each independently shippable):**

| Wave | Scope | Ships value on its own | Rigor |
|---|---|---|---|
| W1 | Migration (tables, `contract_documents` columns, CHECK, back-fill), registrations, `freezeSignedAgreement` extraction with the quote path delegating to it, `AgreementRenderContext`, `computeAgreementSha256`, `assertTemplateVersionUsable`, verifier golden fixtures; `record-signed` endpoint + web **Record signed agreement** dialog (gated on `agreements:write` until W2 ships the permission — stated in the PR) | Yes — an MSP can file an externally-signed BAA against a contract today; retention fix lands for all existing signed agreements | **high** (migration, tenancy, accept path) |
| W2 | `agreements:send` permission migration + RBAC; create/send/preview/link/void endpoints, `agreementAcceptToken`, public signing page (`SignaturePanel` props) + emails incl. signed-copy delivery, `agreementOutcomeNotify`, Send dialog at the three entry points, status chips | Yes — the headline flow | high (public token path, permission migration) |
| W3 | Portal logged-in list/detail/sign, `/portal/signed-agreements` read model + download, remind endpoint + UI, expiry reaper, `agreement.*` bus events, docs (`apps/docs/.../agreements.mdx`) | Yes | medium |
| W4 (optional) | OD8 settings + auto reminders, OD2 append-only | Yes | high (settings rule 9) |

Rollout: no feature flag needed — nothing changes for quotes except the shared writer (W1), which is covered by the existing accept suites and hash re-verification; deploy W1 and confirm `verifyQuoteAcceptanceHash` still passes on a sample of production acceptances before W2.

## 9. Advisor quorum

Codex `gpt-6-astra`, `model_reasoning_effort=xhigh`, `codex exec -s read-only` against this worktree, 2026-10-15. Verdict: "the request-plus-snapshot model is sound, but several proposed mechanics conflict with repository contracts." Every citation was checked against `origin/main` before being applied.

| Decision | Fable (draft) | Codex | Resolution |
|---|---|---|---|
| OD1 data shape | A: new `agreement_requests` + evidence snapshot on `contract_documents` | AGREE; but the `signed_agreement_id` back-reference forms an FK cycle that `topologicalCascadeOrder` cannot break (`tenantCascade.ts:1375,1441`), and the composite contract FK needs `SET NULL (contract_id)` (`2026-10-15-170000-service-deliverables.sql:58`) | Applied: back-reference dropped (unique partial index on `agreement_request_id` instead); FK syntax fixed (§4.1) |
| OD2 / OD2b retention | A app-layer + deferred legal hold | AGREE | — |
| OD3 uploaded copies | A template-required, inline bytes | AGREE; MIME-correct filenames (`documents.ts:79`) | Applied (§3.4) |
| OD4 hash | A own family | AGREE; must bind external bytes | Applied: `external` branch over `bytesSha256 + mime` (§3.3) |
| OD5 countersignature | out of scope | AGREE; state first-committed-response-wins | Applied (§3.3) |
| OD6 BAA-under-MSA | contract is the grouping | AGREE | — |
| OD7 permission | A `agreements:write` now, split later | **DISAGREE** — send/record assent need separate authority now; `contracts:write` is not a boundary | **Resolved on the merits in Codex's favour**: `agreements:send` added in W2 with a back-fill (§2, OD7). Not a silent switch — both positions are recorded in OD7. |
| OD8 reminders/settings | manual, no setting | AGREE; expiry must be one consistent boundary | Applied: `expires_at` instant + single helper (§3.3) |
| OD9 quote path on shared writer | yes + back-fill | AGREE; byte-identical output is not hash compatibility — preserve inputs, add real-resolver golden fixtures (`quoteAcceptanceVerify.test.ts:30` mocks it) | Applied (§3.7, §8) |

Mechanical corrections from the critique, all applied: template partner-wide SELECT branch already exists so no system escalation on staff paths, and staff writes need the quote writer's template guard (`quoteService.ts:1581`); `findUnresolvedVariables` is key-presence (`contractTemplateRender.ts:379`) so the request auto map omits quote-only keys and freeze fails closed instead of blanking (`contractDocumentService.ts:246`); on-behalf may settle a `draft` (`quoteAcceptService.ts:206-214`); token = sibling module, not a generalisation (`quoteAcceptToken.ts:29` claim order is contractual), with cross-rejection; void writes `public_link_revoked_at` and every token route shares one `resolve()`/`isPublicLinkDead` (`quotesPublic.ts:60-89`); signed-copy delivery by email to a captured signer email + recipients (`SignaturePanel` gains props; `:14,:76`); portal downloads keyed by document id (`documentsReadModel.ts:34` is `org_documents`-only); `accept_token_*_at` classified `excludedSensitive` (`tenantExportPolicy.ts:230`).

No open disagreement remains between the two advisors. Decisions still open for Todd are the recommendations in §7 themselves (none is blocked on an advisor split).
