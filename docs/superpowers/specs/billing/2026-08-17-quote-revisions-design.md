# Quote Revisions — Design Spec

**Date:** 2026-08-17
**Status:** Draft — pending Todd's review
**Advisor quorum:** Fable position + Codex (gpt-5.6-sol, xhigh, read-only) — AGREE with amendments; all amendments folded in below. One disagreement (superseding declined/expired parents) resolved in Codex's favor on the merits (§5.3).

## 1. Problem

There is no way to edit and resend an already-sent quote. Today the MSP's only options are:

- `cloneQuote` — produces an unlinked copy with a fresh, unrelated quote number, and **leaves the original sent quote live and acceptable** (the accept token is deterministically re-derivable and never expires before `expiryDate`/30 days).
- `resendQuote` — deliberately re-delivers the *same* document; refuses to change content.

So a pricing correction after send means the customer can still accept the wrong version, and nothing records which quote replaced which.

## 2. Goals / Non-goals

**Goals**

1. "Revise" a sent quote: open an editable copy, change anything, send it — atomically retiring the original.
2. Preserve the exact document each version was: prior versions stay immutable, their view/decline/acceptance history intact.
3. Customer-legible numbering: `Q-2026-0042` → `Q-2026-0042-R2` → `-R3`.
4. The superseded quote's public link degrades gracefully ("this quote has been replaced"), never serves stale-but-acceptable content, and never leaks the successor's capability URL.

**Non-goals**

- Revising a **converted** quote (customer already accepted; corrections go through invoicing/contracts).
- In-place editing of sent quotes (see §4-A rationale).
- A quote-version/snapshot table, PDF byte snapshots, or cross-version diffing UI (future work; the revision link makes it possible later).
- Changing the undo-send window, scheduled send, or resend semantics.

## 3. Design overview

Clone-based revision, supersede-at-send:

1. **`POST /quotes/:id/revise`** creates a new **draft** via the existing deep-copy machinery (fresh quote/block/line/image IDs, snapshots reset), linked to its parent by `revision_of_quote_id` and stamped `revision_number = parent + 1`. The parent is untouched — its link stays live while the revision is being drafted.
2. The revision draft is an ordinary draft: same editor, same `loadDraft` gate, same scheduled-send/undo-window machinery.
3. **Sending the revision supersedes the parent** in the same Postgres transaction: parent → `superseded` (new terminal status), `public_link_revoked_at` stamped, then the normal draft→sent claim on the revision. Redis jti revocation happens post-commit as a cache optimization — **the DB column is authoritative** (Codex amendment: Redis can't participate in the transaction, and today's Redis-only revocation has a fixed 30-day TTL).
4. The parent's public link renders a `410 QUOTE_SUPERSEDED` view; the authenticated portal shows a superseded banner and may link to the successor by ID (same-org, already authorized). The public view does **not** expose the successor token.

Why not in-place (revert sent→draft, edit, re-send): PDFs render live from current rows and the accept token is re-derivable byte-for-byte, so in-place edits silently mutate what the customer's existing link shows and destroy the record of what was actually sent/viewed/declined. `quote_sha256` (computed over block/line IDs at accept) and the invoice/contract/Pax8 conversion pipeline all assume a quote is one immutable document. Both advisors independently rejected in-place; it only becomes viable with a full version-snapshot model, which is a much larger feature.

## 4. Data model

Two new columns on `quotes` (no new tables), one enum value, two indexes.

```sql
-- Migration A (own file — ALTER TYPE ADD VALUE cannot share a transaction
-- with first use of the value; autoMigrate wraps each file in one txn):
-- 2026-08-XX-a-quote-superseded-status.sql
ALTER TYPE quote_status ADD VALUE IF NOT EXISTS 'superseded';

-- Migration B: 2026-08-XX-b-quote-revisions.sql (idempotent)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revision_of_quote_id uuid;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revision_number integer NOT NULL DEFAULT 1;

-- Same-tenant lineage: composite self-FK so a revision can never point
-- cross-org (quotes(id, org_id) needs a supporting unique index if absent).
-- Forbid org retargeting on revision drafts at the service layer too (§6.1).
ALTER TABLE quotes ADD CONSTRAINT quotes_revision_of_fk
  FOREIGN KEY (revision_of_quote_id, org_id) REFERENCES quotes (id, org_id);

-- Linear lineage forever (Codex amendment 4): at most ONE immediate
-- successor per quote, drafts included. Deleting an abandoned revision
-- draft frees the slot; a later revision revises the newest version.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_revision_of_uq
  ON quotes (revision_of_quote_id) WHERE revision_of_quote_id IS NOT NULL;

-- Integrity: root ⇔ revision 1
ALTER TABLE quotes ADD CONSTRAINT quotes_revision_number_chk
  CHECK ((revision_of_quote_id IS NULL AND revision_number = 1)
      OR (revision_of_quote_id IS NOT NULL AND revision_number >= 2));
```

Registration obligations (both fire on **columns**, not just tables):

- `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`): `revision_of_quote_id` and `revision_number` → `included` (tenant identifiers/counters).
- No RLS/cascade changes — `quotes` is already shape-1 with policies, and already in every cascade list. `revision_of_quote_id` is nulled implicitly on parent delete? **No** — parent deletion is impossible for issued quotes (delete is draft-only), and org-cascade erasure deletes the whole lineage together, children-before-parents ordering unaffected (self-FK within one table; erasure deletes all `quotes` rows of the org in one statement — verify the cascade suite passes with a lineage fixture; if the single-statement delete trips the self-FK, add `ON DELETE` handling or delete in two passes ordered by `revision_of_quote_id IS NOT NULL DESC`).

Schema mirrors to update in the same PR: Drizzle schema, shared Zod status enum (`packages/shared/src/validators/quotes.ts`), web `quoteTypes.ts` unions/status maps/filter options, status-parity tests, and the AI/MCP tool schemas that enumerate quote statuses.

## 5. Lifecycle

### 5.1 Which quotes can be revised

| Parent status | Revisable? | Notes |
|---|---|---|
| `draft` | No — 409 | Just edit it. |
| `sent`, `viewed` | Yes | The headline case. |
| `declined`, `expired` | Yes | Re-engage with corrected terms. |
| `converted` (and legacy `accepted`) | No — 409 `PARENT_CONVERTED` | Accepted quotes are settled documents. |
| `superseded` | No — 409 `ALREADY_SUPERSEDED` | Revise the successor instead (response includes its ID). |

One open revision draft per parent, enforced by `quotes_revision_of_uq` (§4) → 409 `REVISION_IN_PROGRESS` with the existing draft's ID. Chains are strictly linear: R3 revises R2, never a second child of R1.

### 5.2 Revise (draft creation)

`reviseQuote(quoteId, actor)` — a dedicated service function sharing the deep-copy internals with `cloneQuote`, **not** `cloneQuote` + patch-after (that would burn a counter allocation and could leave a half-linked row on failure). Differences from clone:

- Locks the parent `FOR UPDATE`, validates status per §5.1, derives `revision_number = parent.revision_number + 1` under the lock.
- Quote number: base number + `-R<n>` suffix (§7) — **no counter allocation**.
- Sets `revision_of_quote_id`. No org retargeting (clone's retarget option is disabled for revisions).
- Copies authored content (blocks/lines/images, cover page, terms, title, expiry-relative fields reset exactly as clone does today). Does **not** copy `quote_recipients` (cumulative authorized-signer log; the composer prefills instead, §8).
- Rejects legacy parents with `quote_number IS NULL` (resend already treats that as corruption).

### 5.3 Send + supersede (the atomic step)

Logic lives in `sendQuote()` itself (not the route) so the scheduled-send worker inherits it for free. When the outgoing draft has `revision_of_quote_id`:

Inside the existing send transaction, in order:

1. `SELECT ... FOR UPDATE` the **parent**.
2. Verify parent status ∈ {sent, viewed, declined, expired}. If `converted`: abort → 409 `PARENT_CONVERTED`, revision stays draft (UI explains and offers deletion). If already `superseded` (impossible under the unique index unless data was hand-edited): abort.
3. Update parent: `status = 'superseded'`, `public_link_revoked_at = now()`. Preserve `declined_at`/`decline_reason`/`expiry_date`/`viewed_at` — they remain the historical record; the audit event records `previousStatus`.
4. Proceed with the revision's normal conditional draft→sent claim (token mint, snapshots, recipients).

Post-commit (best-effort): `revokeQuoteAcceptJti(parent.acceptTokenJti)` in Redis; email delivery as today. Email failure leaves the revision sent and parent superseded — same semantics as today's send, surfaced via `send_email_reason` banners which already render in both QuoteDetail and QuoteWorkspace.

**Uniform supersede for declined/expired parents** (resolved disagreement): my initial position kept declined/expired parents' statuses; Codex argued — and I accept — that status should be the *current* lifecycle truth ("not the latest version"), with `previousStatus` in the audit event and the decline/expiry columns preserved. It also means one rule instead of three.

**Race matrix** (accept already opens with `FOR UPDATE`; both sides serialize on the parent row):

- Accept wins the lock → parent converts; revision send then 409s `PARENT_CONVERTED`.
- Revision send wins → parent superseded; the in-flight accept re-reads and fails its sent|viewed guard → customer sees the superseded view.
- Customer accepts while a revision draft merely exists → allowed by design (drafting doesn't retire the parent); the later send 409s.

### 5.4 Concurrency hardening rolled in (pre-existing bugs this feature makes hotter)

Codex amendments 1 and 3 — these are real today but currently benign-ish; supersede raises the stakes, so fix them in this feature's PR:

1. **`loadDraft` TOCTOU:** status check then unlocked writes lets a concurrent edit land after send commits. Fix: `loadDraft` takes the row `FOR UPDATE`; `sendQuote` locks the child before its final content read.
2. **ID-only status writes:** `markQuoteViewed` and `declineQuoteByActor` check status then update by bare ID — a stale read can stomp a just-committed `superseded`. Fix: compare-and-set predicates (`WHERE status IN (...)`) + assert rowcount, matching the expiry reaper's existing pattern.
3. **Resend / share-link vs supersede:** `resendQuote` and share-link issuance must lock or CAS on status so they can't email/return the old capability mid-replacement. (`RESENDABLE_STATUSES` already excludes anything terminal, so `superseded` is refused for free once the read is serialized.)

## 6. Access revocation & public/portal behavior

### 6.1 Revocation

`public_link_revoked_at` (exists, currently written/read by nothing) becomes the **durable authority**. Enforcement points, all of which must check it in addition to the Redis jti set:

- `quotesPublic.ts` GET `/:token`, the three asset routes, POST accept, POST decline.
- `quoteAcceptService.acceptQuote` (defense in depth under the row lock).

Split token verification from capability validation in the public resolver: a **signature-valid** token for a revoked/superseded quote may load the row and return a distinct `410 QUOTE_SUPERSEDED` response (today revoked jtis die as a generic 401 before the quote loads, which would render as "link invalid" — wrong message for a customer holding a legitimately retired link). Mutation and asset routes stay hard-closed (410, no content).

### 6.2 What the customer sees

- **Public page** (`/quote/[token]`, old link): partner-branded "This proposal has been replaced by an updated version — please use the link in the latest email, or contact <partner>." No successor token, no successor content, no totals from either version (don't serve stale prices).
- **Authenticated portal:** superseded quotes remain listed (history), rendered read-only with a "Replaced by Q-2026-0042-R2" banner linking to the successor **by ID** (portal auth + `quote_recipients` on the successor gate it as usual — note the successor's recipients are only inserted at its send, so a superseded banner only ever appears once a successor is actually sent, which is exactly when it has recipients).
- Accept/decline/pay on a superseded quote: 410 everywhere.

## 7. Numbering

Literal suffix stored in `quote_number`: root keeps `Q-2026-0042`; revision N stores `Q-2026-0042-R<N>` (derive the **base from the chain root's stored number**, never by string-parsing or by appending to the parent's display number — no `-R2-R3` accidents). Fits varchar(40) (`Q-YYYY-NNNN-R99` = 15 chars), satisfies the `(partner_id, quote_number)` unique index, needs no counter allocation, substring search finds the whole lineage, and every outward consumer (invoice notes, contract names, PDF header, email subject/attachment names) inherits it with zero changes.

Documented quirk: a revision issued in 2027 keeps its `Q-2026-...` base — the year identifies the lineage's original allocation, not each revision's issue year. (Same as invoice-credit-note conventions; acceptable.)

Rejected alternatives: fresh number per revision (hides the customer-visible relationship — the whole point); composite `(base_number, revision_number)` with display-time formatting (cleanest in a greenfield, but every outward consumer treats `quote_number` as opaque text today and would need changes, with drift risk).

## 8. API surface

- `POST /quotes/:id/revise` → 201 `{ quote }` (the new draft). Permission: `quotes:write`. Errors: 404, 409 `NOT_REVISABLE` / `PARENT_CONVERTED` / `ALREADY_SUPERSEDED` (+ successor ID) / `REVISION_IN_PROGRESS` (+ draft ID), 422 legacy-no-number.
- `sendQuote` / scheduled-send worker: supersede step per §5.3; new 409 `PARENT_CONVERTED` surfaced through the existing send-error plumbing (and as `send_email_reason='schedule_failed'`-style draft outcome for the scheduled path — reuse the existing fire-time-rejection lane).
- Quote read payloads gain `revisionOfQuoteId`, `revisionNumber`, and (computed) `supersededByQuoteId` (from the reverse lookup — cheap under the unique index) so both webs of the UI can link both directions.
- Public GET: new `status: 'superseded'` shape per §6.
- MCP/AI tools: `get_quote`/list schemas pick up the new fields + status; the `manage_quotes:send` action-intent effect digest pins `updated_at`, which the supersede write bumps on the **parent** — no change needed (the digest is per-quote and the sent quote is the child), but note it in the PR for the approvals reviewer.

## 9. Web UI

- **QuoteDetail** (non-draft statuses): primary "Revise" action for sent|viewed|declined|expired, gated `quotes:write`. On 409 `REVISION_IN_PROGRESS`, offer "Open existing revision draft". Superseded quotes: status chip + "Replaced by <number>" link forward; revisions show "Revision of <number>" link back.
- **QuoteWorkspace/Editor** on a revision draft: persistent banner "Revision of Q-2026-0042 — sending will replace the original", with a link to the parent.
- **Send composer**: reuse as-is; prefill To from the parent's authorized recipients (describe as "previously authorized recipients" — `quote_recipients` is cumulative and doesn't store CC, so exact last-envelope prefill is out of scope; if that matters later, add send-attempt envelope storage). Subject default: "Updated proposal Q-2026-0042-R2 from <partner>". Confirm copy states the original link will stop working.
- **List view**: status filter gains `superseded`; row shows the suffixed number (no extra lineage UI in the list for v1).
- Undo-send countdown works unchanged on revisions (the supersede happens at fire time inside `sendQuote`, so cancelling the scheduled send leaves the parent untouched — a property worth an explicit test).

## 10. Audit & events

New audit actions (filling a real gap — send/accept/decline currently write no audit at all, but that backfill is out of scope):

- `quote.revised` — on draft creation: `{ parentQuoteId, revisionNumber, parentStatus }`.
- `quote.superseded` — on the parent at revision send: `{ supersededByQuoteId, previousStatus, revisionNumber }`.

The existing `quote.resend` action is unaffected. Optionally emit `quote.superseded` on the reserved `quote-events` bus alongside `quote.viewed` (cheap, no consumer yet).

## 11. Testing

- **Unit (Vitest, Drizzle mocks):** `reviseQuote` status matrix (§5.1), numbering derivation incl. chain-root base + legacy-no-number rejection, revision_number check-constraint mirrors in Zod. Beware vacuous where-clause assertions — walk bound params (`vacuous_drizzle_where_clause_assertions` lesson).
- **Integration (real PG):** the §5.3 race matrix with two concurrent transactions (accept vs revision-send, both lock orders); supersede + revocation columns committed atomically; CAS fixes in §5.4 (view/decline vs supersede); unique-successor index under concurrent revise calls; org-erasure of a full lineage passes `tenantCascade.integration.test.ts`; export-policy suites green with the two new columns classified.
- **Route/HTTP:** revise RBAC (mounted route + real `requirePermission`, not constant comparison); public 410 `QUOTE_SUPERSEDED` on GET/accept/decline/assets with a signature-valid token; portal superseded rendering; successor-token non-leakage assertion on the public payload.
- **Web (jsdom):** Revise action gating per status, revision banner, composer prefill, `REVISION_IN_PROGRESS` recovery path. Locale keys → check tr-TR parity baselines.
- **Live acceptance:** worktree stack — send, revise, edit price, send revision, verify old link shows the replaced view, new link accepts, invoice totals match the revision.

## 12. Migration & rollout notes

- Two migration files (§4): `-a-` enum (sole statement), `-b-` columns/FK/index/check — same-day `-a-`/`-b-` infix convention; **not** on the closed 2026-08-06 block.
- Backfill: none — all existing quotes are revision 1 roots (`DEFAULT 1`, null parent).
- Self-hosted: no new env vars, no breaking API changes; release notes mention the new status value for anyone consuming the API/webhooks-adjacent status enums.

## 13. Open questions for Todd (defaults chosen, proceeding unless overridden)

1. **Expiry of a revision draft's parent while drafting:** if the parent expires (reaper) while a revision is being drafted, revision send still supersedes it (expired ∈ allowed set). Default: yes, that's the point of re-engaging. 
2. **Public superseded page contact affordance:** plain text "contact <partner>" vs a mailto to the partner's reply-to. Default: plain text with the partner's billing email shown (already public in the email footer).
3. **Should "Clone" remain visible on revisable quotes** now that "Revise" exists? Default: yes, keep both — clone still serves "similar quote for another customer/deal"; the two actions get distinct copy so techs pick correctly.
