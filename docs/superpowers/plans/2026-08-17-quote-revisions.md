---
tracking_issue: LanternOps/breeze#3796
---

# Quote Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **State lives on GitHub, not here.** This feature is tracked via the
> `feature-lifecycle` MCP server (parent issue + one `wave` sub-issue per wave).
> Call `get_feature_status` BEFORE reading this doc — the checkboxes below are
> intent, the sub-issues are reality. Branch per wave:
> `feature/<parent#>-quote-revisions/wave-<subissue#>`; PR bodies carry
> `Closes #<sub-issue>`.

**Goal:** Let an MSP revise an already-sent quote — create a linked editable copy, send it, and atomically retire the original so the customer can no longer accept the outdated version.

**Architecture:** Clone-based revision with supersede-at-send. `POST /quotes/:id/revise` deep-copies the quote into a linked draft (`revision_of_quote_id`, `revision_number`, number `Q-YYYY-NNNN-R<n>`); sending that draft flips the parent to a new terminal `superseded` status and stamps `public_link_revoked_at` in the same Postgres transaction. Revocation is **DB-authoritative only** — no Redis jti revoke on supersede (every public route loads the quote row anyway, and Redis can't join the transaction; this deviates from spec §3's "post-commit Redis cache" in the safe direction). Two pre-existing races that supersede makes hotter (unlocked draft edits vs send; ID-only status writes) are fixed in the same PR.

**Tech Stack:** Hono + Drizzle + Postgres (hand-written SQL migrations), Vitest (unit + integration configs), React (web), Astro (portal).

**Spec:** `docs/superpowers/specs/billing/2026-08-17-quote-revisions-design.md`

## Global Constraints

- Every mutation to `quotes` rows in this feature must be predicate-guarded (`WHERE status IN (...)`) or under `FOR UPDATE` — never a bare `WHERE id = ?` status write.
- Migration files: idempotent, no inner `BEGIN;/COMMIT;`, `ALTER TYPE ... ADD VALUE` alone in its own file. Never touch the closed `2026-08-06` date block.
- New columns on `quotes` MUST be classified in `CORE_TENANT_EXPORT_POLICY` in the same task that adds them.
- Status-enum mirrors that must stay in lockstep (parity tests enforce some): pg enum, shared Zod `quoteStatusSchema`, web `QuoteStatus` union + `STATUS_LABELS`/`STATUS_ROLES` + `quoteTypes.parity.test.ts`, AI tool enum in `aiToolsQuotes.ts`.
- Error codes introduced: `PARENT_CONVERTED` (409), `ALREADY_SUPERSEDED` (409), `REVISION_IN_PROGRESS` (409), `QUOTE_SUPERSEDED` (410). Reuse `INVALID_STATE`/`NOT_A_DRAFT` where noted.
- The public superseded response must never include the successor's token, content, or totals.
- Unit suites run with `pnpm --filter @breeze/api test -- <file>` / `pnpm --filter @breeze/web test -- <file>`. Integration suites (`vitest.integration.config.ts`) need a real Postgres (see `docs` in that config; locally use the fsync=off tmpfs container per memory) and do NOT run under `pnpm test`.
- Commit after every task with a `feat(quotes):`/`fix(quotes):`/`test(quotes):` message ending in the Claude co-author trailer.

---

## Wave Map

Six waves, each one reviewable PR. Dependencies are strictly linear — every
wave consumes the one before it, so they do not parallelize. Tasks below are
the implementation detail *within* a wave; the wave is the unit that gets a
sub-issue, a branch, and a PR.

Sub-issue numbers are recorded here for orientation only — **`get_feature_status`
is the source of truth**, and per-wave state (open/in-progress/done, branch,
linked PRs) is never written back into this doc.

| Wave | Title | Tasks | Deliverable | Risk |
|---|---|---|---|---|
| W01 ([#3797](https://github.com/LanternOps/breeze/issues/3797)) | Schema + status foundation | 1, 2 | `revision_of_quote_id`/`revision_number` columns, `superseded` enum value, export-policy classification, all status mirrors | Low — additive DDL, no behavior |
| W02 ([#3798](https://github.com/LanternOps/breeze/issues/3798)) | Revise service + route | 3, 4 | `reviseQuote()`, `POST /quotes/:id/revise`, lineage in the read payload, `quote.revised` audit | Medium — new numbering + linearity semantics |
| W03 ([#3799](https://github.com/LanternOps/breeze/issues/3799)) | Supersede-at-send + concurrency hardening | 5, 6 | Parent retired atomically on revision send; `acceptQuote` 410s; `loadDraft` row lock; CAS predicates on view/decline/resend | **High — the core of the feature; touches shared lifecycle paths** |
| W04 ([#3800](https://github.com/LanternOps/breeze/issues/3800)) | Public + portal API | 7 | 410 `QUOTE_SUPERSEDED` public view, asset routes closed, portal successor pointer | Medium — customer-facing, must not leak the successor token |
| W05 ([#3801](https://github.com/LanternOps/breeze/issues/3801)) | Web + portal UI | 8, 9 | Revise action, revision/superseded banners, lineage links, portal replaced view, locale parity | Medium — broad surface, locale sweep |
| W06 ([#3802](https://github.com/LanternOps/breeze/issues/3802)) | Integration proof + verification | 10, 11 | Race matrix against real Postgres, lineage erasure, constraint proofs, full-suite + live acceptance | Medium — proves W03's claims |

**Carried into later waves by the W01 review (PR #3806):**

- **W02 — org retarget must reject revision drafts.** `updateQuote`'s `orgChanged`
  branch (`quoteService.ts`) moves a draft to another customer. On a revision
  draft that leaves `revision_of_quote_id` pointing into the old org, so the
  composite FK `(revision_of_quote_id, org_id)` no longer resolves and Postgres
  raises a bare 23503 that surfaces as a 500. W02 must refuse the retarget with a
  typed 409 when `revisionOfQuoteId != null`.
- **W02 — construct the lineage pair in ONE place.** `revisionOfQuoteId` and
  `revisionNumber` are correlated but the Drizzle type permits illegal pairs
  (only `quotes_revision_number_chk` rejects them). Set both through a single
  helper, never field-by-field, so the CHECK stays a backstop rather than the
  only defense.
- **W03/W05 — status matrices missing `superseded`.** `quoteLifecycle.test.ts`'s
  re-send refusal `it.each` and `QuoteDetail.orderBreakdown.test.tsx`'s
  `it.each` both enumerate statuses without it; neither array is type-checked
  against `QuoteStatus`.
- **W02/W03 — consider `isOpenQuoteStatus()`.** "Is this quote in flight" is now
  re-derived ad hoc in at least two places (`RESENDABLE_STATUSES`, inline
  `!== 'sent' && !== 'viewed'` checks). Introduce the predicate when a third call
  site justifies it — not before.
- **Ops note (not a wave):** the migration comment "FKs are checked at statement
  end" holds only while `tenantCascade` deletes an org's quotes in ONE statement.
  If that delete is ever batched, revisit the self-FK assumption.

**Wave gating:** W03 must not start until W02's route is merged (it depends on
`revisionOfQuoteId` being populated by a real code path). W06 is the only wave
that can meaningfully fail W03 retroactively — if its race matrix disproves the
supersede atomicity, W03 reopens rather than W06 absorbing a fix.

**Status at time of wave registration:** Task 1 is already implemented and
reviewed clean on branch `quote-revisions` (commit `704552c7d`, rebased onto
main 2026-08-21). W01 therefore starts partially complete — only Task 2 remains
in it. Everything from Task 3 onward is unstarted.

---

### Task 1: Migrations + Drizzle schema + export policy

**Files:**
- Create: `apps/api/migrations/2026-08-17-a-quote-superseded-status.sql`
- Create: `apps/api/migrations/2026-08-17-b-quote-revisions.sql`
- Modify: `apps/api/src/db/schema/quotes.ts` (enum line 12-14, columns after line 107, indexes block lines 111-118)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:254` (the `"quotes"` entry)

**Interfaces:**
- Produces: `quotes.revisionOfQuoteId: uuid | null`, `quotes.revisionNumber: integer NOT NULL DEFAULT 1`, enum value `'superseded'` on `quoteStatusEnum`. Later tasks import these from `../db/schema/quotes`.

*(If the implementation date is no longer 2026-08-17, use the actual date in both filenames — keep the `-a-`/`-b-` infix pair on that same date.)*

- [ ] **Step 1: Write migration A** (sole statement — `ADD VALUE` cannot share a transaction with first use; each migration file is one transaction):

```sql
-- Quote revisions (spec 2026-08-17): terminal status for a quote replaced by a
-- newer revision. Own file: ALTER TYPE ... ADD VALUE cannot run in the same
-- transaction as first use of the value (autoMigrate wraps each file in one).
ALTER TYPE quote_status ADD VALUE IF NOT EXISTS 'superseded';
```

- [ ] **Step 2: Write migration B**:

```sql
-- Quote revisions (spec 2026-08-17): lineage columns + linearity constraints.
-- No RLS changes: quotes' existing shape-1 org policies cover the new columns.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revision_of_quote_id uuid;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS revision_number integer NOT NULL DEFAULT 1;

-- Same-tenant lineage: composite self-FK onto quotes_id_org_uq so a revision
-- can never point at another org's quote. No ON DELETE action needed: issued
-- quotes cannot be deleted (delete is draft-only) and org erasure removes the
-- whole lineage in one statement (FKs are checked at statement end).
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_revision_of_fk
    FOREIGN KEY (revision_of_quote_id, org_id) REFERENCES quotes (id, org_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Linear lineage forever: at most ONE immediate successor per quote (drafts
-- included). Deleting an abandoned revision draft frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_revision_of_uq
  ON quotes (revision_of_quote_id) WHERE revision_of_quote_id IS NOT NULL;

-- Root <=> revision 1.
DO $$ BEGIN
  ALTER TABLE quotes ADD CONSTRAINT quotes_revision_number_chk
    CHECK ((revision_of_quote_id IS NULL AND revision_number = 1)
        OR (revision_of_quote_id IS NOT NULL AND revision_number >= 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 3: Update the Drizzle schema.** In `apps/api/src/db/schema/quotes.ts`: add `'superseded'` to `quoteStatusEnum` (after `'expired'`, before `'converted'` — order in the array is cosmetic for pg enums added via ADD VALUE, but keep the TS array matching the SQL type's final member set); add columns after `publicLinkRevokedAt` (line 107):

```ts
  // Quote revisions: immediate-parent link + 1-based position in the lineage.
  // A revision keeps the root's number with an -R<n> suffix and, when sent,
  // flips its parent to 'superseded' (see sendQuote). Linearity is enforced by
  // quotes_revision_of_uq (one successor ever) + quotes_revision_number_chk.
  revisionOfQuoteId: uuid('revision_of_quote_id'),
  revisionNumber: integer('revision_number').notNull().default(1),
```

and in the table's third argument add, alongside the existing indexes:

```ts
  uniqueIndex('quotes_revision_of_uq').on(t.revisionOfQuoteId).where(sql`${t.revisionOfQuoteId} IS NOT NULL`),
  foreignKey({
    columns: [t.revisionOfQuoteId, t.orgId],
    foreignColumns: [t.id, t.orgId],
    name: 'quotes_revision_of_fk',
  }),
```

(`foreignKey` is already imported at the top of the file; self-references on the same table object are legal in Drizzle when passed in the table callback.)

- [ ] **Step 4: Classify the new columns.** In `tenantExportPolicyRegistry.ts:254`, add `"revision_of_quote_id","revision_number"` to the `included` array of the `"quotes"` entry (both are tenant identifiers/counters; neither is an open container or secret).

- [ ] **Step 5: Verify locally.** Run `pnpm --filter @breeze/api test -- autoMigrate` (naming/ordering/reference assertions) and, with the dev DB up, `DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:migrate && pnpm db:check-drift`. Expected: migrations apply cleanly and re-apply as no-ops; drift check green.

- [ ] **Step 6: Commit** — `feat(quotes): revision lineage columns + superseded status (migrations, schema, export policy)`.

---

### Task 2: Status-enum mirrors (shared Zod, web types, AI tools)

**Files:**
- Modify: `packages/shared/src/validators/quotes.ts:16` (`quoteStatusSchema`)
- Modify: `apps/web/src/components/billing/quotes/quoteTypes.ts:16-17` (union), `:320` (`STATUS_LABELS`), `:334` (`STATUS_ROLES`)
- Modify: `apps/web/src/components/billing/quotes/quoteTypes.parity.test.ts` (`statusMembers`)
- Modify: `apps/api/src/services/aiToolsQuotes.ts:133` (list-tool status enum)

**Interfaces:**
- Produces: `'superseded'` accepted by `quoteStatusSchema` (which `listQuotesQuerySchema.status` derives from, so the list filter works with no further change) and rendered by the web status maps.

- [ ] **Step 1: Run the parity test to see it green pre-change** — `pnpm --filter @breeze/web test -- quoteTypes.parity` — then add `'superseded'` to `quoteStatusSchema` in the shared validator. Re-run: expect FAIL (schema has a member the union lacks). This is the drift guard doing its job.

- [ ] **Step 2: Update the web mirrors.** Add `| 'superseded'` to `QuoteStatus`; add to both maps:

```ts
// STATUS_LABELS
superseded: 'Superseded',
// STATUS_ROLES — replaced-by-a-newer-version is a quiet historical state, not
// a warning; neutral matches draft's grey.
superseded: { role: 'neutral' },
```

and `superseded: true` to `statusMembers` in the parity test.

- [ ] **Step 3: Update the AI list tool.** In `aiToolsQuotes.ts:133` add `'superseded'` to the `enum` array (it must mirror `quoteStatusSchema` — the route re-validates with the shared schema, so a missing member here just hides the filter from the model).

- [ ] **Step 4: Run** `pnpm --filter @breeze/web test -- quoteTypes.parity` (PASS) and `pnpm --filter @breeze/shared test` (PASS).

- [ ] **Step 5: Commit** — `feat(quotes): superseded status across shared/web/AI mirrors`.

---

### Task 3: `reviseQuote` service

**Files:**
- Modify: `apps/api/src/services/quoteService.ts` (new exports `reviseQuote`, internal `resolveQuoteLineageRoot`; small parameterization of `cloneQuote`)
- Test: `apps/api/src/services/quoteService.revise.test.ts` (new, alongside existing `quoteService.test.ts` — mirror its Drizzle mock setup exactly)

**Interfaces:**
- Consumes: Task 1 columns; `QuoteServiceError` from `./quoteTypes`; `cloneQuote` internals.
- Produces: `export async function reviseQuote(id: string, actor: QuoteActor): Promise<typeof quotes.$inferSelect>` — creates the linked draft. Throws `QuoteServiceError` with codes: 404 `QUOTE_NOT_FOUND`, 409 `NOT_A_DRAFT`-inverse cases as `INVALID_STATE` (draft parent, legacy no-number), 409 `PARENT_CONVERTED`, 409 `ALREADY_SUPERSEDED` (message contains successor id), 409 `REVISION_IN_PROGRESS` (message contains draft id; `details` not available — put ids in a new optional `meta` field, see Step 3).

- [ ] **Step 1: Write failing tests** in `quoteService.revise.test.ts`. Cases (use the same `vi.mock`-based Drizzle chain mocks as `quoteService.test.ts` — read that file first and copy its harness):
  1. draft parent → 409 `INVALID_STATE`
  2. converted parent → 409 `PARENT_CONVERTED`
  3. superseded parent → 409 `ALREADY_SUPERSEDED`
  4. parent with an existing draft successor → 409 `REVISION_IN_PROGRESS`
  5. sent parent, no successor → inserts a draft with `revisionOfQuoteId = parent.id`, `revisionNumber = parent.revisionNumber + 1`, `quoteNumber = 'Q-2026-0042-R2'`, and **no** counter allocation (assert `allocateQuoteCounter` mock not called)
  6. parent that is itself R2 (`revisionNumber: 2`, `revisionOfQuoteId` set, number `Q-2026-0042-R2`) → new draft numbered `Q-2026-0042-R3` derived from the **root's** stored number (mock the root read), never `Q-2026-0042-R2-R3`
  7. legacy parent with `quoteNumber: null` → 409 `INVALID_STATE`
  8. unique-violation on insert (mock throws error with `code: '23505'`, `constraint: 'quotes_revision_of_uq'`) → 409 `REVISION_IN_PROGRESS`

- [ ] **Step 2: Run** `pnpm --filter @breeze/api test -- quoteService.revise` — expect FAIL (`reviseQuote` not exported).

- [ ] **Step 3: Implement.** First add an optional machine-readable payload to `QuoteServiceError` in `apps/api/src/services/quoteTypes.ts`:

```ts
export class QuoteServiceError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    /** Optional machine-readable context (e.g. { quoteId } of the conflicting
     *  revision draft) — routes serialize it as `meta` when present. */
    public meta?: Record<string, string>,
  ) { super(message); }
}
```

(Check the actual current constructor shape in `quoteTypes.ts` first and extend it additively — existing `new QuoteServiceError(msg, status, code)` call sites must not change.)

Then parameterize the clone core. In `cloneQuote` (quoteService.ts:324), add an internal-only fourth parameter and thread it through the insert:

```ts
/** Internal revision overrides for the clone core — never exposed on the route. */
interface CloneRevisionOverrides {
  quoteNumber: string;
  revisionOfQuoteId: string;
  revisionNumber: number;
}

export async function cloneQuote(
  id: string, actor: QuoteActor, input: CloneQuoteInput = {},
  revision?: CloneRevisionOverrides,
) {
```

Inside: when `revision` is set, skip the `allocateQuoteCounter`/`formatQuoteNumber` pair and use `revision.quoteNumber`; forbid retargeting (`if (revision && input.orgId) throw` — defensive, `reviseQuote` never passes it); and add to the `tx.insert(quotes).values({...})` object:

```ts
      quoteNumber: revision?.quoteNumber ?? quoteNumber,
      revisionOfQuoteId: revision?.revisionOfQuoteId ?? null,
      revisionNumber: revision?.revisionNumber ?? 1,
```

Then the new functions:

```ts
/** Walk revision_of links to the lineage root (bounded — linearity is
 *  DB-enforced, but cap the walk so corrupt data can't loop). */
async function resolveQuoteLineageRoot(quote: typeof quotes.$inferSelect): Promise<typeof quotes.$inferSelect> {
  let current = quote;
  for (let hop = 0; hop < 100 && current.revisionOfQuoteId; hop++) {
    const [parent] = await db.select().from(quotes).where(eq(quotes.id, current.revisionOfQuoteId)).limit(1);
    if (!parent) throw new QuoteServiceError('Quote lineage is corrupt', 409, 'INVALID_STATE');
    current = parent;
  }
  if (current.revisionOfQuoteId) throw new QuoteServiceError('Quote lineage is corrupt', 409, 'INVALID_STATE');
  return current;
}

const REVISABLE_STATUSES = new Set(['sent', 'viewed', 'declined', 'expired']);

/**
 * Create a linked draft revision of an issued quote. The parent is NOT touched
 * here — it stays live until the revision is actually sent (sendQuote flips it
 * to 'superseded'). Linearity (one successor ever) is enforced by
 * quotes_revision_of_uq; the pre-check below exists to return a helpful 409
 * with the existing draft's id, and the 23505 catch closes the race.
 */
export async function reviseQuote(id: string, actor: QuoteActor) {
  const { quote: parent } = await getQuote(id, actor); // org-access 404
  if (parent.status === 'draft') {
    throw new QuoteServiceError('This quote is still a draft — edit it directly', 409, 'INVALID_STATE');
  }
  if (parent.status === 'converted' || parent.status === 'accepted') {
    throw new QuoteServiceError('This quote was accepted — changes go through its invoice or contract', 409, 'PARENT_CONVERTED');
  }
  if (parent.status === 'superseded') {
    const [successor] = await db.select({ id: quotes.id }).from(quotes)
      .where(eq(quotes.revisionOfQuoteId, parent.id)).limit(1);
    throw new QuoteServiceError('This quote was already replaced — revise the newer version', 409,
      'ALREADY_SUPERSEDED', successor ? { successorQuoteId: successor.id } : undefined);
  }
  if (!REVISABLE_STATUSES.has(parent.status)) {
    throw new QuoteServiceError(`Cannot revise a quote in status ${parent.status}`, 409, 'INVALID_STATE');
  }
  if (!parent.quoteNumber) {
    throw new QuoteServiceError('This quote has no quote number and cannot be revised', 409, 'INVALID_STATE');
  }
  const [existing] = await db.select({ id: quotes.id, status: quotes.status }).from(quotes)
    .where(eq(quotes.revisionOfQuoteId, parent.id)).limit(1);
  if (existing) {
    throw new QuoteServiceError('A revision of this quote is already in progress', 409,
      'REVISION_IN_PROGRESS', { revisionQuoteId: existing.id });
  }
  const root = await resolveQuoteLineageRoot(parent);
  if (!root.quoteNumber) {
    throw new QuoteServiceError('This quote has no quote number and cannot be revised', 409, 'INVALID_STATE');
  }
  const revisionNumber = parent.revisionNumber + 1;
  try {
    return await cloneQuote(id, actor, {}, {
      quoteNumber: `${root.quoteNumber}-R${revisionNumber}`,
      revisionOfQuoteId: parent.id,
      revisionNumber,
    });
  } catch (err) {
    // Concurrent revise lost the quotes_revision_of_uq race → same 409 as the
    // pre-check, minus the id (the caller re-fetches).
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      throw new QuoteServiceError('A revision of this quote is already in progress', 409, 'REVISION_IN_PROGRESS');
    }
    throw err;
  }
}
```

(Adjust the 23505 detection to however `quoteService.ts` already inspects pg error codes — grep the file for `'23505'` first and copy that idiom if one exists.)

- [ ] **Step 4: Run** `pnpm --filter @breeze/api test -- quoteService.revise` (PASS) and `pnpm --filter @breeze/api test -- quoteService` (existing clone tests still PASS).

- [ ] **Step 5: Commit** — `feat(quotes): reviseQuote service — linked draft with -R<n> numbering`.

---

### Task 4: Revise route + audit + lineage in the read payload

**Files:**
- Modify: `apps/api/src/routes/quotes/quotes.ts` (new route after the `/:id/clone` handler at line 72-91; extend the GET `/:id` payload around line 95-121)
- Modify: `apps/api/src/services/quoteService.ts` (`getQuote` — lineage lookups)
- Test: `apps/api/src/routes/quotes/quotes.revise.test.ts` (new; mirror the mounted-route + mocked-`getUserPermissions` harness of `routes/quotes/lifecycle.test.ts` — RBAC coverage must be HTTP-level, not constant comparison)

**Interfaces:**
- Consumes: `reviseQuote` (Task 3).
- Produces: `POST /api/v1/quotes/:id/revise` → 200 `{ data: <quote row> }`, gated `quotes:write`, audited as `quote.revised`. `getQuote` return gains two fields later tasks and the web consume:
  - `revisionOf: { id: string; quoteNumber: string | null; recipients: string[] } | null` (immediate parent + its authorized recipients, for the composer prefill)
  - `successor: { id: string; quoteNumber: string | null; status: string } | null` (immediate child, any status)

- [ ] **Step 1: Write failing tests** in `quotes.revise.test.ts`:
  1. `POST /:id/revise` with `quotes:write` → 200, body is the new draft, `reviseQuote` called with the actor
  2. without `quotes:write` (e.g. TECH role mock) → 403
  3. service throws `REVISION_IN_PROGRESS` with `meta` → response `{ error, code: 'REVISION_IN_PROGRESS', meta: { revisionQuoteId } }`, 409
  4. audit: `writeRouteAudit` mock called with `action: 'quote.revised'` and details containing `parentQuoteId`, `revisionNumber`, `parentStatus`

- [ ] **Step 2: Run** `pnpm --filter @breeze/api test -- quotes.revise` — FAIL (route not mounted).

- [ ] **Step 3: Implement the route** (in `quotes.ts`, after the clone route; `writeRouteAudit` is already imported at line 34):

```ts
// POST /:id/revise — create a linked draft revision of an issued quote. The
// parent stays live until the revision is SENT (sendQuote supersedes it).
// quotes:write like clone; the send itself will require quotes:send.
quoteCrudRoutes.post('/:id/revise', scopes, writePerm, zValidator('param', idParam), async (c) => {
  const id = c.req.valid('param').id;
  try {
    const actor = quoteActorFrom(c);
    const { quote: parent } = await getQuote(id, actor);
    const revision = await reviseQuote(id, actor);
    writeRouteAudit(c, {
      orgId: revision.orgId,
      action: 'quote.revised',
      resourceType: 'quote',
      resourceId: revision.id,
      result: 'success',
      details: { parentQuoteId: id, revisionNumber: revision.revisionNumber, parentStatus: parent.status },
    });
    return c.json({ data: revision });
  } catch (err) { return handleServiceError(c, err); }
});
```

Also extend `handleServiceError` (quotes.ts:54) to serialize `meta`:

```ts
  if (err instanceof QuoteServiceError) {
    return c.json(err.meta ? { error: err.message, code: err.code, meta: err.meta } : { error: err.message, code: err.code }, err.status);
  }
```

(Note: the double `getQuote` — once here for `parent.status`, once inside `reviseQuote` — is two cheap reads in the same request transaction; do not refactor `reviseQuote`'s signature to avoid it.)

- [ ] **Step 4: Extend `getQuote`** (quoteService.ts:519+). After the existing pax8 lookup, add:

```ts
  const revisionOf = q.revisionOfQuoteId ? await (async () => {
    const [parent] = await db.select({ id: quotes.id, quoteNumber: quotes.quoteNumber })
      .from(quotes).where(eq(quotes.id, q.revisionOfQuoteId!)).limit(1);
    if (!parent) return null;
    // Same-org by FK; safe unfiltered in this request context (see getQuoteRecipients).
    const recipients = await db.select({ email: quoteRecipients.email }).from(quoteRecipients)
      .where(eq(quoteRecipients.quoteId, parent.id)).orderBy(quoteRecipients.createdAt);
    return { id: parent.id, quoteNumber: parent.quoteNumber, recipients: recipients.map((r) => r.email) };
  })() : null;
  const [successorRow] = await db.select({ id: quotes.id, quoteNumber: quotes.quoteNumber, status: quotes.status })
    .from(quotes).where(eq(quotes.revisionOfQuoteId, q.id)).limit(1);
```

and include `revisionOf` and `successor: successorRow ?? null` in `getQuote`'s return object (find the `return {` at the end of the function and add both keys; import `quoteRecipients` from the schema if not already imported in this file). Add a unit test in `quoteService.revise.test.ts` asserting both fields populate.

- [ ] **Step 5: Run** `pnpm --filter @breeze/api test -- quotes.revise quoteService.revise` — PASS. Also `pnpm --filter @breeze/api test -- lifecycle.test` (untouched but adjacent — still PASS).

- [ ] **Step 6: Commit** — `feat(quotes): POST /quotes/:id/revise route + lineage in read payload`.

---

### Task 5: Supersede-at-send in `sendQuote` + accept-path 410s

**Files:**
- Modify: `apps/api/src/services/quoteLifecycle.ts` (`sendQuote`, lines 62-276)
- Modify: `apps/api/src/services/quoteAcceptService.ts` (status guard region, ~line 101-109)
- Modify: `apps/api/src/routes/quotes/lifecycle.ts` (`/:id/send` handler line 82-95 — audit the supersede)
- Modify: `apps/api/src/jobs/quoteSendQueue.ts` (worker — audit the supersede; find `processQuoteSendJob` ~line 151)
- Test: `apps/api/src/services/quoteLifecycle.supersede.test.ts` (new; copy the mock harness from the existing `quoteLifecycle` unit tests — grep `apps/api/src/services` for `quoteLifecycle*.test.ts` and mirror)

**Interfaces:**
- Consumes: Task 1 columns/status.
- Produces: `sendQuote`'s return type gains `superseded?: { parentQuoteId: string; previousStatus: string }`. New service behavior later tasks rely on: sending a revision flips the parent to `superseded` + stamps `publicLinkRevokedAt` atomically; `acceptQuote` throws 410 `QUOTE_SUPERSEDED` for superseded/revoked quotes.

- [ ] **Step 1: Write failing tests** in `quoteLifecycle.supersede.test.ts`:
  1. sending a quote with `revisionOfQuoteId` set: parent locked (`FOR UPDATE` select issued), parent updated to `{ status: 'superseded', publicLinkRevokedAt: <Date> }` with a `WHERE status IN ('sent','viewed','declined','expired')` predicate, child claim proceeds, result carries `superseded: { parentQuoteId, previousStatus: 'sent' }`
  2. parent already `converted` → throws 409 `PARENT_CONVERTED`, no child claim attempted
  3. parent update matches 0 rows (mock) → throws 409 `PARENT_CONVERTED` (the only way a locked parent in the allowed set can vanish is a concurrent settle)
  4. non-revision send (`revisionOfQuoteId: null`) → no parent statements at all, `superseded` absent from result
  5. revision send with `opts.to` empty → recipient fallback prefers the PARENT's recipients (mock `quote_recipients` read, org-filtered) over the org billing contact
  6. revision send with no `opts.subject` → `deliverQuoteEmail` receives subject `Updated proposal Q-2026-0042-R2 from <partner name>`
  7. `acceptQuote` on a `superseded` quote → 410 `QUOTE_SUPERSEDED`; on a sent quote with `publicLinkRevokedAt` set → 410 `QUOTE_SUPERSEDED`

  Mock discipline: assert the parent-update's **bound predicate values** (walk the where-clause params), not just that `.update` was called — the vacuous-assertion trap.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement in `sendQuote`.** After the `status !== 'draft'` check (line 71) and before the contract-variable gate, add the parent lock + validation; after the child claim succeeds (line 213-215), flip the parent. Concretely:

```ts
  // ---- Revision supersede, part 1: lock + validate the parent -------------
  // Runs INSIDE the ambient request/system transaction so the parent flip and
  // the child's draft→sent claim commit or roll back together. Lock order
  // (parent first) matches acceptQuote's FOR UPDATE on the same row, so a
  // concurrent accept and this send serialize instead of deadlocking.
  const SUPERSEDABLE = ['sent', 'viewed', 'declined', 'expired'] as const;
  let parentToSupersede: { id: string; status: string } | null = null;
  if (quote.revisionOfQuoteId) {
    const [parent] = await db.select({ id: quotes.id, status: quotes.status })
      .from(quotes).where(eq(quotes.id, quote.revisionOfQuoteId)).limit(1).for('update');
    if (!parent) throw new QuoteServiceError('Original quote not found', 409, 'INVALID_STATE');
    if (parent.status === 'converted' || parent.status === 'accepted') {
      throw new QuoteServiceError(
        'The original quote was accepted while this revision was being drafted — it can no longer be sent',
        409, 'PARENT_CONVERTED');
    }
    if (!(SUPERSEDABLE as readonly string[]).includes(parent.status)) {
      throw new QuoteServiceError(`Cannot supersede a quote in status ${parent.status}`, 409, 'INVALID_STATE');
    }
    parentToSupersede = parent;
  }
```

For the recipient fallback (spec §9), replace the `recipientEmails` computation (lines 166-171): compute `parentRecipients` when `parentToSupersede` is set (explicit org filter — this also runs under the worker's SYSTEM context, where `getQuoteRecipients`' unfiltered read would be cross-tenant):

```ts
  const parentRecipients = parentToSupersede
    ? (await db.select({ email: quoteRecipients.email }).from(quoteRecipients)
        .where(and(eq(quoteRecipients.quoteId, parentToSupersede.id), eq(quoteRecipients.orgId, quote.orgId)))
        .orderBy(quoteRecipients.createdAt)).map((r) => r.email)
    : [];
  const recipientEmails = Array.from(new Set(
    (opts.to && opts.to.length > 0 ? opts.to
      : parentRecipients.length > 0 ? parentRecipients
      : (billingRecipient ? [billingRecipient] : []))
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  ));
```

Default subject for a revision (before the `deliverQuoteEmail` call): `const effectiveOpts = parentToSupersede && !opts.subject ? { ...opts, subject: \`Updated proposal ${quoteNumber} from ${partnerRow?.name ?? 'your provider'}\` } : opts;` and pass `opts: effectiveOpts` into `deliverQuoteEmail`.

After the child claim succeeds (after the `claimed.length === 0` throw at line 213-215):

```ts
  // ---- Revision supersede, part 2: retire the parent ----------------------
  // Predicate re-asserts the allowed set even under the lock (belt to the
  // FOR UPDATE strap). public_link_revoked_at is the DB-authoritative
  // revocation for the parent's public link — deliberately NO Redis revoke:
  // Redis can't join this transaction, and every public route loads the row.
  let supersededResult: { parentQuoteId: string; previousStatus: string } | undefined;
  if (parentToSupersede) {
    const flipped = await db.update(quotes)
      .set({ status: 'superseded', publicLinkRevokedAt: now, updatedAt: now })
      .where(and(eq(quotes.id, parentToSupersede.id), inArray(quotes.status, [...SUPERSEDABLE])))
      .returning({ id: quotes.id });
    if (flipped.length === 0) {
      throw new QuoteServiceError('The original quote settled while sending the revision', 409, 'PARENT_CONVERTED');
    }
    supersededResult = { parentQuoteId: parentToSupersede.id, previousStatus: parentToSupersede.status };
  }
```

and add `superseded: supersededResult` to the return object (line 275). Import `inArray` from drizzle-orm and `quoteRecipients` (already imported at line 3) as needed; `QuoteServiceError` is already imported. Note the columns preserved on the parent: `declinedAt`, `declineReason`, `expiryDate`, `viewedAt` are untouched — historical record.

- [ ] **Step 4: `acceptQuote` 410s.** In `quoteAcceptService.ts`, immediately before the existing sent|viewed status guard (~line 101), add:

```ts
  if (quote.status === 'superseded' || quote.publicLinkRevokedAt != null) {
    throw new QuoteServiceError('This quote has been replaced by a newer version', 410, 'QUOTE_SUPERSEDED');
  }
```

- [ ] **Step 5: Audit `quote.superseded`.** In `routes/quotes/lifecycle.ts` `/:id/send` handler: capture the result, and when `result.superseded` is set, call `writeRouteAudit(c, { orgId: result.quote.orgId, action: 'quote.superseded', resourceType: 'quote', resourceId: result.superseded.parentQuoteId, result: 'success', details: { supersededByQuoteId: id, previousStatus: result.superseded.previousStatus, revisionNumber: result.quote.revisionNumber, emailed: result.emailed } })` (import `writeRouteAudit` — already imported at line 8). In `jobs/quoteSendQueue.ts` `processQuoteSendJob`, after a successful `sendQuote`, mirror it with the job-safe form used by `quoteExpiryReaper.ts:8`: `writeAuditEvent(requestLikeFromSnapshot({}), { ... same fields ... })`, wrapped in try/catch that logs and continues (an audit failure must not fail the send job).

- [ ] **Step 6: Run** `pnpm --filter @breeze/api test -- quoteLifecycle.supersede quoteAcceptService` — PASS, plus the full existing lifecycle/send-queue unit files.

- [ ] **Step 7: Commit** — `feat(quotes): supersede-at-send — revision send retires the parent atomically`.

---

### Task 6: Concurrency hardening (pre-existing races supersede makes hotter)

**Files:**
- Modify: `apps/api/src/services/quoteService.ts` (`loadDraft` line 195-201)
- Modify: `apps/api/src/services/quoteLifecycle.ts` (`sendQuote` child lock; `markQuoteViewed` line 728-741; `declineQuoteByActor` line 744-758; `resendQuote` line 637+; `getQuoteShareLink` line 608+)
- Test: extend `quoteLifecycle.supersede.test.ts` + `quoteService.revise.test.ts`

**Interfaces:**
- Consumes: nothing new. Produces: no signature changes — behavior only (predicate-guarded writes, row locks).

- [ ] **Step 1: Write failing tests:**
  1. `loadDraft` issues its select with `FOR UPDATE`
  2. `markQuoteViewed` on a quote read as `sent`: update predicate requires `status = 'sent'`; on a quote read as `viewed`/other: predicate requires `status <> 'superseded'`; 0-rows-matched is a silent no-op (no throw)
  3. `declineQuoteByActor`: update carries `WHERE status IN ('sent','viewed')` + uses `.returning`; 0 rows → 409 `INVALID_STATE`
  4. `resendQuote` and `getQuoteShareLink`: both issue a `FOR UPDATE` re-read of the quote's status after `getQuote` and re-run the linkable gate on the fresh status (superseded → 409 via `assertLinkableQuote`'s not-in-`RESENDABLE_STATUSES` branch — no code change needed there, `superseded` is already refused)
  5. `sendQuote` locks the child row before reading its content

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement:**
  - `loadDraft`: append `.for('update')` to the select (line 196). Every block/line mutator funnels through it, so one change serializes all draft edits against send.
  - `sendQuote`: at the top, before `getQuote(id, actor)`, add `await db.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, id)).limit(1).for('update');` with a comment: locks the child for the rest of the transaction so a concurrent draft edit (now blocked on loadDraft's FOR UPDATE) can't land between the content read and the claim. (Locking before the access check is harmless: an inaccessible id 404s at getQuote and the lock dies with the transaction.)
  - `markQuoteViewed`: change the update to `.where(and(eq(quotes.id, quoteId), q.status === 'sent' ? eq(quotes.status, 'sent') : ne(quotes.status, 'superseded')))` (import `ne`). Comment: a stale read must never resurrect/stomp a just-committed supersede; 0 rows = someone settled it first, which is fine for a cosmetic stamp.
  - `declineQuoteByActor`: change the update to add `inArray(quotes.status, ['sent', 'viewed'])` and `.returning({ id: quotes.id })`; when 0 rows, throw `new QuoteServiceError('This quote can no longer be declined', 409, 'INVALID_STATE')`.
  - `resendQuote` + `getQuoteShareLink`: after `getQuote`, add `const [fresh] = await db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, id)).limit(1).for('update'); assertLinkableQuote({ ...quote, status: fresh?.status ?? quote.status }, <verb>);` replacing the existing `assertLinkableQuote(quote, ...)` call (keep passing the full row — only status is refreshed). This serializes against the parent-flip lock in Task 5.

- [ ] **Step 4: Run** the full API unit suite for the touched files: `pnpm --filter @breeze/api test -- quoteLifecycle quoteService` — all PASS (including pre-existing tests; if an existing test asserted the old unguarded SQL shape, update it to the new predicate — that is the point of the change, note it in the commit).

- [ ] **Step 5: Commit** — `fix(quotes): serialize draft edits vs send; predicate-guard lifecycle status writes`.

---

### Task 7: Public + portal API — superseded handling

**Files:**
- Modify: `apps/api/src/routes/quotesPublic.ts` (GET `/:token` line 53-93; three asset routes lines 96-143; decline line 210-263)
- Modify: `apps/api/src/routes/portal/quotes.ts` (detail handler ~line 46; grep for the detail response object)
- Test: `apps/api/src/routes/quotesPublic.superseded.test.ts` (new; HTTP-level, mirror `quotesPublicRoutes` existing test harness — grep for `quotesPublic*.test.ts` and copy its app-mounting + mock setup)

**Interfaces:**
- Consumes: Task 1/5. Produces: public GET on a superseded/revoked quote → **410** `{ error, code: 'QUOTE_SUPERSEDED', data: { branding: { partnerName } } }`; asset routes → 404; public decline → 410 `QUOTE_SUPERSEDED`; portal detail response gains `supersededByQuoteId: string | null`.

- [ ] **Step 1: Write failing tests:**
  1. GET `/:token` with a **signature-valid, non-Redis-revoked** token for a quote with `status: 'superseded'` → 410, `code: 'QUOTE_SUPERSEDED'`, body contains partner name, and contains **no** blocks/lines/totals and no successor identifiers
  2. Same for a `sent` quote with `publicLinkRevokedAt` set (belt-and-strap: revocation without the flip)
  3. Each asset route (images / line-image / contract-file) for a superseded quote → 404
  4. POST `/:token/decline` on superseded → 410 `QUOTE_SUPERSEDED`
  5. POST `/:token/accept` on superseded → 410 (already thrown by `acceptQuote` from Task 5 — this is the HTTP-level proof)
  6. A Redis-revoked jti still 401s before any of the above (the accept-consumed path is unchanged)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** In the GET handler's system-context closure (line 58-86), right after the `if (!quote || quote.status === 'draft') return null;` guard:

```ts
      // A replaced quote's link degrades to an explicit "superseded" notice —
      // never stale-but-acceptable content, never the successor's link. The DB
      // columns are the revocation authority (no Redis marker is written on
      // supersede), so this branch IS the enforcement, not a courtesy.
      if (quote.status === 'superseded' || quote.publicLinkRevokedAt != null) {
        const [p] = await db.select({ name: partners.name }).from(partners).where(eq(partners.id, quote.partnerId)).limit(1);
        return { superseded: true as const, partnerName: p?.name ?? 'your provider' };
      }
```

and after the closure returns, branch before the existing 404:

```ts
    if (data && 'superseded' in data) {
      return c.json({ error: 'This proposal has been replaced by an updated version — please use the link in the latest email.', code: 'QUOTE_SUPERSEDED', data: { branding: { partnerName: data.partnerName } } }, 410);
    }
```

Asset routes: widen each quote select to `{ id: quotes.id, status: quotes.status, publicLinkRevokedAt: quotes.publicLinkRevokedAt }` and `return null` when `status === 'superseded' || publicLinkRevokedAt != null` (falls through to the existing 404).

Decline route: in the closure (line 214+), after the durable-consumption guards and before the status guard, add `if (quote.status === 'superseded' || quote.publicLinkRevokedAt != null) return 'superseded' as const;` and at the response layer `if (result === 'superseded') return c.json({ error: 'This quote has been replaced by a newer version', code: 'QUOTE_SUPERSEDED' }, 410);`.

Portal detail (`routes/portal/quotes.ts`): after loading the quote, add the successor lookup — **non-draft children only** (an authenticated portal user must not learn a revision is being drafted):

```ts
    const [successor] = await db.select({ id: quotes.id }).from(quotes)
      .where(and(eq(quotes.revisionOfQuoteId, quote.id), ne(quotes.status, 'draft'))).limit(1);
```

and include `supersededByQuoteId: successor?.id ?? null` in the detail response object. (Portal accept/decline handlers already refuse non-sent/viewed statuses; verify with a quick test that superseded → their existing 409/410 path, and add the same explicit 410 `QUOTE_SUPERSEDED` branch there if their error copy would otherwise be misleading — match whatever guard idiom those handlers use.)

- [ ] **Step 4: Run** `pnpm --filter @breeze/api test -- quotesPublic portal` — PASS (new + existing).

- [ ] **Step 5: Commit** — `feat(quotes): superseded public link degrades to a 410 notice; portal successor pointer`.

---

### Task 8: Web UI — revise action, banners, lineage links

**Files:**
- Modify: `apps/web/src/lib/api/quotes.ts` (new `reviseQuote` fn near `cloneQuote` at line 95)
- Modify: `apps/web/src/components/billing/quotes/QuoteActions.tsx` (action gating ~line 768-773; clone handler pattern at ~line 663-682)
- Modify: `apps/web/src/components/billing/quotes/QuoteWorkspace.tsx` (revision banner)
- Modify: `apps/web/src/components/billing/quotes/QuoteDetail.tsx` (superseded banner + forward/back links)
- Modify: web quote type defs in `quoteTypes.ts` (`Quote` interface — add `revisionOfQuoteId`, `revisionNumber`; the detail payload types for `revisionOf`/`successor` live wherever `getQuote`'s response type is declared — grep `quoteTypes.ts` and `lib/api/quotes.ts` for the detail-response interface and extend it)
- Locale files: add new keys to `apps/web/src/locales/en/billing.json` **and every other locale dir** (run the localeParity test to enumerate); bump `translationCoverage` baselines for keys identical to English
- Test: `apps/web/src/components/billing/quotes/QuoteActions.revise.test.tsx` (new; mirror `QuoteActions.clone.test.tsx`), extend `QuoteDetail.lifecycle.test.tsx`

**Interfaces:**
- Consumes: `POST /quotes/:id/revise` (Task 4), `revisionOf`/`successor` payload fields (Task 4), status mirrors (Task 2).
- Produces: user-facing Revise flow. No new exports consumed by later tasks.

- [ ] **Step 1: Write failing web tests:**
  1. QuoteActions shows **Revise** for statuses sent/viewed/declined/expired when `can('quotes','write')`; hidden for draft/converted/superseded and for read-only viewers
  2. Clicking Revise calls the API and, on success, navigates to the new draft **exactly the way `clone()` does** (read `QuoteActions.tsx:663-682` first and assert the same navigation seam)
  3. A 409 `REVISION_IN_PROGRESS` response with `meta.revisionQuoteId` surfaces a toast/dialog offering "Open existing revision" that navigates to that id (wrap the call in `runAction` per the repo rule; the 409 is an `ActionError` — branch on `err.status === 409 && body.code === 'REVISION_IN_PROGRESS'`, mirroring how QuoteActions already branches on typed error codes — grep the file for `ActionError`)
  4. QuoteDetail on a superseded quote renders the status pill + "Replaced by <number>" link (from `successor`); on a revision renders "Revision of <number>" link (from `revisionOf`); on a parent with a draft successor renders a "Revision in progress" notice linking to the draft
  5. QuoteWorkspace on a revision draft renders a persistent banner "Revision of <parent number> — sending will replace the original and disable its link"

- [ ] **Step 2: Run** `pnpm --filter @breeze/web test -- QuoteActions.revise QuoteDetail.lifecycle` — FAIL.

- [ ] **Step 3: Implement.**
  - `lib/api/quotes.ts`:

```ts
export function reviseQuote(id: string): Promise<Response> {
  return fetchWithAuth(`${API}/quotes/${id}/revise`, { method: 'POST' });
}
```

(match the exact fetch idiom of the adjacent `cloneQuote` at line 95 — same base-URL constant, same auth wrapper.)
  - `QuoteActions.tsx`: add `canRevise = can('quotes','write') && ['sent','viewed','declined','expired'].includes(status)` next to the existing gates (line 768-773); add the Revise button next to Clone with distinct copy (Revise = "replace this quote"; Clone = "start a similar quote"); handler mirrors `clone()`'s `runAction` + navigate shape, plus the `REVISION_IN_PROGRESS` recovery branch.
  - Send-dialog copy: when the workspace quote has `revisionOfQuoteId`, the send confirm/composer shows a line "Sending will replace <parent number> and disable its link" (the composer component is inside QuoteActions — thread the `revisionOf` info via props the same way the existing quote prop flows).
  - Composer To-prefill: when the quote is a revision and the composer opens with no recipients, prefill from `revisionOf.recipients` (labelled as previously authorized recipients). The server already falls back to parent recipients when To is empty (Task 5), so this is display-honesty, not correctness.
  - `QuoteDetail.tsx` / `QuoteWorkspace.tsx`: banners/links per the tests. All user-visible strings through the i18n layer used by the surrounding file — never compare a translated string with `=== i18n.t(...)` for logic; branch on status/ids.
- [ ] **Step 4: Locale sweep.** Add every new key to `en/billing.json` and all sibling locales (machine-translate placeholders are the repo norm — copy the pattern of the most recent billing key addition via `git log -p --follow apps/web/src/locales/en/billing.json | head -100`). Run `pnpm --filter @breeze/web test -- localeParity translationCoverage` and bump baselines where a translation is legitimately identical to English.
- [ ] **Step 5: Run** `pnpm --filter @breeze/web test -- QuoteActions QuoteDetail QuoteWorkspace localeParity translationCoverage` — PASS, then the whole web suite `pnpm --filter @breeze/web test`.
- [ ] **Step 6: Commit** — `feat(quotes,web): Revise action, revision banners, superseded lineage links`.

---

### Task 9: Portal UI — superseded views

**Files:**
- Modify: `apps/portal/src/components/portal/PublicQuoteView.tsx` (status branches at lines ~38/61/237/251)
- Modify: the portal public quote page `apps/portal/src/pages/quote/[token].astro` (410 handling) and authenticated `QuoteDetailView.tsx` (superseded banner) — grep `apps/portal/src` for `QuoteDetailView` first
- Test: portal component tests alongside, mirroring however `PublicQuoteView` is currently tested (grep for `PublicQuoteView*.test*`; if untested, add `PublicQuoteView.superseded.test.tsx` using the web vitest+jsdom pattern)

**Interfaces:**
- Consumes: 410 `QUOTE_SUPERSEDED` public response (Task 7); portal `supersededByQuoteId` (Task 7).

- [ ] **Step 1: Write failing tests:** (a) the public page, on a 410 `QUOTE_SUPERSEDED` fetch result, renders the partner-branded "This proposal has been replaced by an updated version — please use the link in the latest email, or contact <partnerName>." with **no** totals, no accept/decline, no successor link; (b) authenticated `QuoteDetailView` with `status: 'superseded'` renders read-only with a "Replaced by a newer version" banner that links to `/portal/quotes/<supersededByQuoteId>` when present.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Public page: branch on the fetch's 410 + `code === 'QUOTE_SUPERSEDED'` before the generic invalid-link branch, rendering `data.branding.partnerName` from the error body. `PublicQuoteView`: add a `superseded` status branch beside the existing declined (line 251) / expired (line 61) branches — badge + message, interactive controls hidden (the `open` gate at line 38 already excludes it). Authenticated view: banner + in-portal link by id (safe: portal auth + the successor's own `quote_recipients` gate what they can do there).
- [ ] **Step 4: Run** portal tests — PASS.
- [ ] **Step 5: Commit** — `feat(quotes,portal): superseded quote views`.

---

### Task 10: Integration tests — race matrix, lineage erasure, export policy

**Files:**
- Create: `apps/api/src/services/quoteRevisions.integration.test.ts` (register in whatever include-glob `vitest.integration.config.ts` uses — check it; existing `*.integration.test.ts` files are auto-discovered)

**Interfaces:** consumes everything above; produces CI-blocking proof.

Read `apps/api/src/services/quoteSendQueue.integration.test.ts` first and reuse its ephemeral-Postgres bootstrap + migration replay verbatim (private containers, distinct ports, `docker rm -f` cleanup names — use `breeze-pg-quoterev`). Every test runs against real Postgres with the full migration set applied.

- [ ] **Step 1: Write the suite** (these are the behaviors only real Postgres can prove):
  1. **Full happy path:** seed partner/org → create quote → send → revise → edit a line on the revision → send revision. Assert: parent `status='superseded'`, `publicLinkRevokedAt` set, `declinedAt`/`viewedAt` untouched; child `sent`, number `Q-<year>-NNNN-R2`, `revisionNumber=2`.
  2. **Accept-vs-supersede race, both orders:** two concurrent transactions — one running `acceptQuote(parent)`, one running `sendQuote(revision)` (use two separate pg connections and explicit `BEGIN`; start A, let it hold the parent `FOR UPDATE`, fire B, then commit A). Accept-first: revision send throws `PARENT_CONVERTED` and the revision **stays draft**. Send-first: accept fails its status guard with 410 `QUOTE_SUPERSEDED`.
  3. **Concurrent revise:** two `reviseQuote(parent)` calls racing → exactly one draft exists; the loser got `REVISION_IN_PROGRESS` (pre-check or 23505 path — either code, same outcome).
  4. **Unique-successor lifecycle:** revise → delete the draft (`deleteDraftQuote`) → revise again succeeds (slot freed).
  5. **Constraint proofs:** direct SQL insert of `revision_number=1` with a parent → `23514` (`quotes_revision_number_chk`); cross-org `revision_of_quote_id` → FK violation (`quotes_revision_of_fk`).
  6. **Scheduled-send inheritance:** `scheduleQuoteSend` on a revision, let the worker fire (or invoke `processQuoteSendJob` directly as the send-queue suite does) → parent superseded; and the cancel path (`cancelQuoteSend` before fire) leaves the parent untouched and the revision a draft.
  7. **Org-erasure of a lineage:** build R1(superseded)→R2(superseded)→R3(sent), run the tenant cascade erasure for the org (call the same entry point `tenantCascade.integration.test.ts` uses) → succeeds; the single-statement quotes delete must not trip the self-FK.
  8. **RLS forge:** as `breeze_app` under another org's context, attempt `UPDATE quotes SET revision_of_quote_id = ...` / select of the lineage → blocked/invisible (reuse the forge idiom from any `*PartnerRls.integration.test.ts`).
- [ ] **Step 2: Run locally** against the ephemeral containers: `pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts quoteRevisions.integration` — all PASS. Also run the two export-policy suites (`tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`) and `tenantCascade.integration.test.ts` — they must be green with the Task 1 column classifications.
- [ ] **Step 3: Commit** — `test(quotes): revision race matrix, lineage erasure, constraint proofs (integration)`.

---

### Task 11: Full verification + docs

**Files:**
- Modify: `apps/docs/` quotes page (only if one documents the send lifecycle — check `grep -ril "quote" apps/docs/src | head`; if the update is more than a paragraph, defer to the `update-breeze-docs` skill post-merge and note it in the PR)

- [ ] **Step 1:** `pnpm --filter @breeze/api test` (full unit), `pnpm --filter @breeze/web test`, `pnpm --filter @breeze/shared test` — all green.
- [ ] **Step 2:** Integration + RLS configs (real DB): `vitest.integration.config.ts` shards relevant files (at minimum the four suites named in Task 10 Step 2) and `vitest.config.rls.ts` (`rls-coverage` — no allowlist change was needed, this proves it).
- [ ] **Step 3:** Typecheck via build path (`pnpm build` or the turbo typecheck CI uses — there is no root typecheck script). Watch for the web `astro check` ANSI trap: verify with the `Result (N files): X errors` summary line, not a grep for "error ts".
- [ ] **Step 4:** Fresh-DB migration proof: drop/recreate the dev DB (or a throwaway container), run `pnpm db:migrate` twice — second run a no-op; `pnpm db:check-drift` green.
- [ ] **Step 5:** Live acceptance on the worktree stack (`worktree-stack` skill): send → revise → change a price → send revision. Verify in the browser: old public link shows the branded replaced notice (410 view); new link renders and accepts; accepted revision's invoice totals match the revised price; web list filter shows Superseded; undo-send on a revision cancels cleanly with the parent untouched.
- [ ] **Step 6:** One `quote.revised` + one `quote.superseded` row visible in the audit log UI/table from the acceptance run.
- [ ] **Step 7:** Commit any leftovers; open the PR with the spec linked, noting: the DB-authoritative-revocation deviation from spec §3, the effect-digest note (spec §8: `manage_quotes:send` digests pin the CHILD quote's `updated_at`; the parent bump is inert), and the three spec §13 defaults for Todd's eyes.
