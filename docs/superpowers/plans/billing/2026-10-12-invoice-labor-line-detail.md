---
issue: 8078
status: draft-for-approval
tracking_issue: LanternOps/breeze#8601
---

# Invoice Labor Line Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Time entries reach invoices with the date they were worked and (opt-in) per-day grouping, and AI/MCP callers can write and edit the work note that prints on the line.

**Architecture:** Carry the work date as a typed `invoice_lines.work_date date` column beside `worked_minutes` (the #6467 precedent: structured data rendered at display time, never baked into `description`). Grouping is render-time presentation over the existing one-line-per-time-entry rows, so `source_id`, the `SOURCE_ALREADY_BILLED` lock, accounting sync and block-hours drawdown are untouched. The itemization setting copies the #3205 W07 appendix shape: partner default column, per-invoice override, frozen at issue.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only), hand-written SQL migrations, pdfkit, Astro/React web + portal, Vitest.

**Spec:** GitHub issue #8078 body (no separate spec doc). Design decisions are the Open Decisions at the end of this file.

## Global Constraints

- Hand-written migration only; slot `2026-12-23-180000-<slug>.sql` (newest committed on `origin/main` at authoring: `2026-12-23-100000-tier1-sweep-indexes.sql`; open PR #8517 holds `…-140000-portal-branding-enable-hour-block.sql`). Re-run `git ls-tree origin/main apps/api/migrations/ --name-only | sort | tail` before writing; move up if anything newer landed; a second same-day file takes `180100`, a third `180200` (W5). Migration order must follow wave order; re-slot if another wave lands out of order.
- Migrations: idempotent (`ADD COLUMN IF NOT EXISTS`), no inner `BEGIN;`/`COMMIT;`, `SELECT set_config('breeze.scope','system',true);` before any row write. `invoice_lines` is hot: nullable column, no default, no NOT NULL (metadata-only add).
- Never edit or rename a shipped migration. Then `pnpm db:check-drift`.
- Tenancy: new columns on `invoice_lines`/`invoices` (shape 1, `org_id`) and `partners` (partner axis) need NO new policy. No new table anywhere in this plan.
- Hours math is unchanged: hours rounded to 2dp first, then `roundToCurrency(hours × rate)` (`invoiceAssembly.ts` `entryHours`/`computeLineTotal`). Nothing in this plan merges lines or touches amounts.
- Tests: API `cd apps/api && npx vitest run <files>` (no `--` before flags); web `cd apps/web && npx vitest run <files>`. Typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` and check the exit code (never pipe to `tail`).
- Red first: every task writes the failing assertion, watches it fail, then implements.
- New web en locale keys go in all 7 locales under `apps/web/src/locales/<locale>/` (the `localeParity` test lives in `apps/web/src/lib/i18n`). New API `pdf:` keys go in `apps/api/src/i18n/locales/{en,pt-BR}/pdf.json` (`apps/api/src/i18n/localeParity.test.ts`).
- Web mutation handlers use `runAction` (`apps/web/src/lib/runAction.ts`).
- Waves are sequential PRs off `main`. A stacked PR (base ≠ `main`) runs no CI (`ci.yml` triggers only on PRs to main): if you must stack, run `gh workflow run CI --ref <branch>`.
- Public repo: no customer names, hostnames, IPs or session ids in code, tests, commits or PR bodies. Fixtures use "an hourly client".

## Verified findings (re-checked on `origin/main` 7773695ee7; the issue's line numbers had drifted)

1. **Gap 1 confirmed.** `aiToolsTicketing.ts` shared property `description: 'Ticket description (create)'` (~line 614). The handlers for `log_time_entry` (~1249), `start_timer` (~1304), `stop_timer` (~1332) already read `input.description` and pass it to the service; only the schema text hides it. `aiTimeEntryProposal.ts` builds a `log_time_entry` intent from a fixed `TRIGGER_DESCRIPTION[trigger]` string, so proposals do send a description (generic text).
2. **Gap 2 confirmed.** `invoiceAssembly.ts`: `entryDescription = r.description?.trim() || 'Labor'` (line 121, hardcoded English, stored). `gatherOrgTimeEntries` (~188) selects `endedAt` only and range-filters on `ended_at`; `startedAt` is never selected. `invoice_lines` has no date column.
3. **Customer-visibility correction to the brief.** A `time_entry` line is built with `name` unset, and `lineTitle` is `name ?? description`. So **the technician's work note already prints as the line title on every customer invoice today** (PDF, email HTML, portal, public link). The note is not a *new* exposure. What is new is (a) MCP callers will now be told to write one (W1 must say "printed on the customer invoice"), (b) the date, which is low risk, and (c) technician identity, which is out of scope here (Open Decision 12). Making notes opt-in would regress every existing invoice, so this plan does not; the real mitigation is an optional separate customer-facing note (Open Decision 4) and the W1 wording.
4. **Gap 3 confirmed.** No MCP action edits a time entry. REST `PATCH /time-entries/:id` → `updateTimeEntry` (`timeEntryService.ts` ~1125). `BILLED_LOCKED_ENTRY_FIELDS` (~592) omits `description`, and the service message says "only its description can change" for a billed or block-drawn entry. So a billed entry's description stays editable, **but that edit cannot change an issued line** (lines are copies, see 5).
5. **Gap 4 verified end to end: drafts snapshot, nothing refreshes.** Writers of `invoice_lines` are: insert at assembly (`invoiceService.ts` ~1250), `addLine` (~294), a second insert (~380), `updateLine` (~543, a manual edit), `changeInvoiceCurrency` reprice (~641, catalog lines only), deletes (~558, ~667), issue-time stamping of ticket label/subject/category (~1604) and the reissue clone (~2434/2438). None reads `time_entries` after assembly. Editing an unissued entry's description or `startedAt` leaves the draft line stale. Draft refresh does not exist; it needs an explicit action (W5).
6. **Timezone.** `partners.timezone varchar(64) NOT NULL DEFAULT 'UTC'` exists (`db/schema/orgs.ts` ~44). `organizations` has no timezone column (`sites.timezone` does). `invoicePdf.ts` `formatDate` forces `en-US` + `timeZone:'UTC'`, which is correct for date-only invoice dates but wrong for instants. The work date must therefore be converted **once, at assembly, in the partner timezone**, and stored as a `date`, so renderers never convert instants.
7. **Accounting.** `buildLinePayload` (`accountingInvoicePush.ts` ~607): `description = title + accountingLineNote(line)`. Xero truncates the base to keep the suffix (`DESCRIPTION_MAX = 4000`, `xeroInvoices.ts` ~30/119). QuickBooks sends `Description: line.description` uncapped (`quickbooksProvider.ts` ~953). Xero has no per-line date field. QuickBooks `SalesItemLineDetail` has `ServiceDate` (**verify against Intuit's current API reference in W4 Task 1; do not rely on this plan**). Stripe Checkout sends a single `Invoice <number>` line item (`invoiceCheckout.ts` ~189); line descriptions never reach Stripe. Nothing to do there.
8. **Block hours.** Entries inside a block window are held out of assembly (`partitionHoldingBlockHours`) and at close become `billing_status='contract'` with `contract_line_id`; one aggregated overage line (`source_type='contract'`) is created. So the new date applies only to `time_entry` lines, and held or drawn entries never get detail lines. Open PR #8517 (block hours W04) touches portal branding, `tenantExportPolicyRegistry.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `portal.ts` schema and migration `…-140000`; it does **not** touch `invoicePdf.ts`, `apps/portal` invoice components or invoice routes. Conflict risk is limited to the export-policy registry/test files (additive lines in different tables; resolve by rebase). Land order does not matter, but re-check the migration slot.
9. **Cascade/export.** `invoice_lines` is in `tenantCascade.ts` (~657) and `orgMergeRegistry.ts` (~976, listed as a table only; no column-level obligations found: re-grep in W2). Export policy: `invoice_lines` (~507) and `invoices` (~521) are `tablePolicy("org_id", {included, …})`; every new column on them must be classified. `partners` appears only in comments in `tenantExportPolicyRegistry.ts` and in `MERGE_NOOP_PARTNER_AXIS_TABLES`, so partner columns carry no export classification (state this in the PR; the grep step below proves it).

## Review Focus

- Partner with the setting OFF: rendered PDF/HTML must be byte-identical to today (golden test, W3).
- Entry spanning midnight in a non-UTC partner timezone: date is the **start** date in the partner timezone (W2).
- Held / block-consumed entries must never produce a detail line or a work date (W2).
- Draft vs issued: changing the partner default after issue must not reflow an issued invoice (W3 freeze).
- Long notes near the 4000-char accounting caps and non-ASCII text in pdfkit wrapping/page breaks (W3/W4).
- A hand-edited draft line description must survive a refresh (W5).

## Wave map

| Wave | Ships | Migration | Independent of | Leaves behind if the next never ships |
|---|---|---|---|---|
| W1 | MCP `description` documented, `update_time_entry` action | none | everything | Agents can write/edit notes; invoices unchanged. Complete value on its own. |
| W2 | `invoice_lines.work_date` captured at assembly, copied on reissue, exported | `180000` (one nullable column) | W1 | Data is captured but nothing prints it. Harmless, additive; W3 can ship any time later with no backfill gap for new invoices. |
| W3 | Itemization setting + render of date / per-day grouping in PDF, HTML, web, portal, public link | `180100` (partner + invoice columns) | W1 | Needs W2. If W4/W5 never ship, customers still see detail on the invoice; accounting copy lacks the date. |
| W4 | Accounting sync (QBO `ServiceDate`, description policy, caps) | none | W1, W5 | Needs W2 **and W3** (the frozen `line_detail` gates whether the date is pushed). Accounting copies lack the date, same as today. |
| W5 | "Refresh from time entries" for unissued drafts | `180200` (`description_edited` + draft backfill) | W3, W4 | Needs W2. Drafts stay snapshots (today's behavior). Deferrable (Open Decision 9). |

W3 and W4 stay separate: W3 is a customer-facing layout change reviewed by eye; W4 is an external-API change with its own lab verification. W4 follows W3 (it consumes the frozen setting); W5 needs only W2 but **ships after W3** so migration `180200` sorts after `180100` (re-slot at authoring time anyway).

**No backfill (Open Decision 7).** Existing issued lines keep `work_date = NULL` and renderers print nothing for NULL. Issued invoices are immutable documents: back-filling would change what a customer already received on a re-render. Existing drafts get `NULL` too; W5's refresh is how an operator opts a draft in. Reissue/copy paths (`invoiceService.ts` ~2409 `cloneValues`) copy `work_date` verbatim; W3 also copies the header's `line_detail`/`line_grouping` in the reissue header (~2387) so the reissued draft keeps the original's presentation (a reissue is a draft, so the issue-time freeze re-resolves from these overrides, not the partner default).

## File structure

- `apps/api/src/services/invoiceAssembly.ts`: select `startedAt`, compute `workDate`, add to `DraftLineSpec`.
- `apps/api/src/services/invoiceWorkDate.ts` (new, W2): `toPartnerLocalDate(instant, timeZone): string` and nothing else (pure, one test file).
- `packages/shared/src/utils/invoiceLineDetail.ts` (new, W3): pure helpers shared by web and portal (and API where it does not need i18n): `lineWorkedVsBilled`, `groupLinesForDisplay`.
- `apps/api/src/services/invoicePdf.ts`, `invoiceService.ts`, `routes/invoicesPublic.ts`, `routes/invoices/settings.ts`, `routes/invoices/lifecycle.ts`, web `BillingDocumentsTab.tsx`, `InvoiceActions.tsx`, `InvoiceDocument.tsx`, `InvoiceEditor.tsx`, `invoiceTypes.ts`, portal `invoicePaper.tsx`, `lib/api.ts`.

---

## W1: MCP gaps (no migration, no invoice change)

### Task 1.1: Document the time-entry `description` (customer-visibility cue)

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts` (the `manage_tickets` input_schema; keep the single `description` property, see below)
- Test: `apps/api/src/services/aiToolsTicketing.schema.test.ts` (create if no schema test exists; otherwise the existing `aiToolsTicketing.*.test.ts` that reads `definition.input_schema`)

**Interfaces:** Produces: `manage_tickets.input_schema.properties.description.description` mentions all of `create`, `log_time_entry`, `start_timer`, `stop_timer` and the phrase `printed on the customer invoice`.

Design note: one shared property serves ticket create and three time actions, so keep one property and make the text action-qualified (do not add a second property; two names for the same handler input would diverge). `z.undefined()` must not appear in any schema.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { registerTicketingTools } from './aiToolsTicketing';

describe('manage_tickets description property', () => {
  it('documents the time-entry work note and its customer visibility', () => {
    const tools = new Map<string, any>();
    registerTicketingTools(tools);
    const tool = tools.get('manage_tickets')!;
    const text = (tool.definition.input_schema.properties as any).description.description as string;
    for (const a of ['create', 'log_time_entry', 'start_timer', 'stop_timer']) expect(text).toContain(a);
    expect(text).toContain('printed on the customer invoice');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiToolsTicketing.schema.test.ts`
Expected: FAIL (text is `Ticket description (create)`).

- [ ] **Step 3: Implement.** Replace line ~614 text with:
`'Ticket description (create). Work note for log_time_entry/start_timer/stop_timer: what was done; printed on the customer invoice line when the time is billed, so write it for the customer, no internal commentary.'`
Also add the same sentence to the `manage_tickets` top-level description only if it stays under the existing length cap (check `aiToolSchemas` length tests).

- [ ] **Step 4: Run test + the ticketing suite**

Run: `cd apps/api && npx vitest run src/services/aiToolsTicketing`
Expected: PASS. Trap: `SAFE_WRITE_SITES` contract tests key by **line number** (`aiTools.userOwnedRelease.contract.test.ts` ~139 currently has no `aiToolsTicketing.ts`/`aiToolsBilling.ts` entries; re-grep and re-key only if one appears).

- [ ] **Step 5: Commit** `fix(ai): document manage_tickets time-entry description (#8078)`

### Task 1.2: `update_time_entry` action

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts` (action enum ~578, properties, handler branch after `stop_timer`)
- Modify: `apps/api/src/services/aiToolSchemas.ts` (~376 action list), `aiGuardrails.ts` (~82 tier list and the `resource/action` map ~919), `aiAgentSdkTools.ts`, `aiToolRateLimits*`, `mcpCoverage.ts`
- Test: `aiToolsTicketing.updateTimeEntry.test.ts` (create), `aiAgentSdkTools.mcpCoverage.test.ts`, the existing outputShape/siteScope/deviceScope/writeGaps tests

**Interfaces:**
- Consumes: `updateTimeEntry(id, input: UpdateTimeEntryInput, actor)` (`timeEntryService.ts` ~1125), `timeEntryActorFrom(auth)`, `TimeEntryServiceError`.
- Produces: `manage_tickets` action `update_time_entry` with required `timeEntryId` (string uuid) and optional `description`, `startedAt`, `endedAt`, `isBillable`, `workType`. `hourlyRate` is rejected (rate edits stay REST/UI behind `time_entries:manage_billing`). Returns `{ timeEntry, currencyCode }` or `{ error }`.

Guardrail tier: Tier 2, same as `log_time_entry`/`start_timer`/`stop_timer` (`aiGuardrails.ts` ~79-82 and the note at ~404 record the 2026-07-20 downgrade); a note/time edit on the caller's own entry is reversible. Agent principals: refuse like `log_time_entry` does (`agent_principal_requires_intent_release`) because an unattended agent should not rewrite human timesheets; confirm in the quorum.

Billed lock: the service already enforces it (`ENTRY_BILLED`, `ENTRY_DRAWN_BY_BLOCK`). Do not duplicate the check in the handler; the test pins that the MCP path surfaces the 409 message.

Validation (quorum): reuse the REST `updateTimeEntrySchema` (`packages/shared/src/validators/timeEntries.ts` ~86: future-start and description-length rules) rather than ad-hoc parsing, and reject an update with no changed field. `updateTimeEntry` unconditionally clears approval (`timeEntryService.ts` ~1263), so an empty patch would silently un-approve the entry.

- [ ] **Step 1: Failing tests**

```ts
it('rejects an empty patch (it would clear approval)', async () => {
  expect(JSON.parse(await run({ action: 'update_time_entry', timeEntryId: ID })).error).toMatch(/at least one field/);
});
it('applies the REST validator (oversized description, future start)', async () => { expect(updateTimeEntry).not.toHaveBeenCalled(); // after sending description of 10_001 chars and a startedAt one day in the future; both return { error } });
it('edits only the description of a billed entry', async () => {
  // mock updateTimeEntry to throw TimeEntryServiceError('…only its description can change', 409, 'ENTRY_BILLED') when startedAt present
  const out = JSON.parse(await run({ action: 'update_time_entry', timeEntryId: ID, startedAt: '2026-09-16T10:00:00Z' }));
  expect(out.error).toMatch(/invoiced/);
  const ok = JSON.parse(await run({ action: 'update_time_entry', timeEntryId: ID, description: 'Replaced switch' }));
  expect(updateTimeEntry).toHaveBeenLastCalledWith(ID, { description: 'Replaced switch' }, expect.anything());
  expect(ok.timeEntry).toBeDefined();
});
it('requires timeEntryId and rejects hourlyRate', async () => {
  expect(JSON.parse(await run({ action: 'update_time_entry' })).error).toMatch(/timeEntryId/);
  expect(JSON.parse(await run({ action: 'update_time_entry', timeEntryId: ID, hourlyRate: 1 })).error).toMatch(/hourlyRate/);
});
it('is refused for an agent principal', async () => { // call with an agent-run auth context (same fixture as the log_time_entry test); expect { error: 'agent_principal_requires_intent_release' } and updateTimeEntry not called });
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiToolsTicketing.updateTimeEntry.test.ts`. Expected: FAIL (`Unknown action`).
- [ ] **Step 3: Implement** the handler branch (shape mirrors `log_time_entry`: scope pre-check via the entry's ticket using `findTicketWithAccess` when the entry has one, build a sparse `UpdateTimeEntryInput` including only defined fields, `Date` parse with an `Invalid Date` guard returning `{error}`, catch `TimeEntryServiceError`), then register in every registry listed above. Run `grep -rn "log_time_entry" apps/api/src --include='*.ts' -l` and add `update_time_entry` wherever `log_time_entry` is enumerated; the registries disagree if one is missed and `mcpCoverage` tests fail.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/aiToolsTicketing src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiGuardrails src/services/aiToolSchemas` then the typecheck. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(ai): update_time_entry action keeping the billed lock (#8078)`

**W1 PR:** `Refs #8078` (no closing keyword; the issue spans waves). CI: Test API. No integration suite impact.

---

## W2: Line detail contract (`work_date`)

### Task 2.1: Pure partner-local date helper

**Files:** Create `apps/api/src/services/invoiceWorkDate.ts`, test `invoiceWorkDate.test.ts`.

**Interfaces:** Produces `toPartnerLocalDate(instant: Date, timeZone: string): string` returning `YYYY-MM-DD`; invalid/unknown zone falls back to `'UTC'` (never throws; a bad stored zone must not block invoicing).

- [ ] **Step 1: Failing test**

```ts
import { toPartnerLocalDate } from './invoiceWorkDate';
it('uses the partner zone, not UTC', () => {
  // 2026-09-17T02:30Z is Sep 16 evening in New York
  expect(toPartnerLocalDate(new Date('2026-09-17T02:30:00Z'), 'America/New_York')).toBe('2026-09-16');
  expect(toPartnerLocalDate(new Date('2026-09-17T02:30:00Z'), 'UTC')).toBe('2026-09-17');
});
it('falls back to UTC for a bad zone', () => {
  expect(toPartnerLocalDate(new Date('2026-09-17T02:30:00Z'), 'Not/AZone')).toBe('2026-09-17');
});
it('a midnight-spanning entry takes its START date', () => {
  // caller passes startedAt; documented here so nobody passes endedAt
  expect(toPartnerLocalDate(new Date('2026-09-16T23:30:00-04:00'), 'America/New_York')).toBe('2026-09-16');
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/invoiceWorkDate.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement**

```ts
export function toPartnerLocalDate(instant: Date, timeZone: string): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  try { return fmt(timeZone); } catch { return fmt('UTC'); }
}
```
(`en-CA` formats `YYYY-MM-DD`; the test asserts it so a runtime ICU difference fails loudly.)
- [ ] **Step 4:** Run test; expect PASS. **Step 5: Commit.**

### Task 2.2: Migration + schema + export-policy classification

**Files:**
- Create: `apps/api/migrations/2026-12-23-180000-invoice-lines-work-date.sql`
- Modify: `apps/api/src/db/schema/invoices.ts` (`invoiceLines`, next to `workedMinutes`), `apps/api/src/services/tenantExportPolicyRegistry.ts` (line ~507, add `"work_date"` to `included`)
- Test: `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `tenantCascade.integration.test.ts`, `rls-coverage.integration.test.ts` (own config: run it as CI does, `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; pointing `vitest.integration.config.ts` at it finds no files and exits 1), `migrationRlsScope.test.ts`

Migration body:

```sql
-- #8078: the date a time-entry line was worked, in the partner's timezone,
-- captured at assembly. NULL on every pre-existing line (no backfill: issued
-- invoices are immutable) and on every non-time_entry line.
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS work_date date;
```
(No row writes, so no `set_config` is needed; `migrationRlsScope.test.ts` confirms. No NOT NULL, no default: metadata-only on a hot table. No index: nothing filters on it.)

Typed `date` column chosen over `jsonb` (jsonb would force `excludedOpen` and hide data from tenant export) and over text in `description` (editing the description would erase it; the #6467 lesson). Classification: `included` (a date is not sensitive).

- [ ] **Step 1: Failing test.** Add `"work_date"` expectation: run the grep first.

```bash
grep -rn 'invoice_lines' apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
```
Then bring up the stack and run the contract suites **before** adding the classification, to watch the red:
`pnpm test-stack up` then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts` (confirm the exact config flag from `docs/agents/testing.md`; do not guess).
Expected: FAIL: column `work_date` is unclassified.
- [ ] **Step 2:** Add the column to the Drizzle schema and the migration; run `pnpm db:check-drift`.
- [ ] **Step 3:** Add `work_date` to the `included` array. Re-run the four suites + `migrationRlsScope.test.ts` (`cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts` or wherever `find` locates it). Expected PASS. These fail **only** under the Integration Tests CI job (8 shards), never Test API.
- [ ] **Step 4:** `pnpm test-stack down`; state in the PR that it was torn down.
- [ ] **Step 5: Commit.**

### Task 2.3: Assembly selects `startedAt` and stamps `workDate`; reissue copies it

**Files:**
- Modify: `invoiceAssembly.ts` (`TimeEntryRow`, `timeEntryToLineSpec`, `gatherOrgTimeEntries` ~188, `gatherTicketBillables` ~262, `DraftLineSpec` type), `invoiceService.ts` (~1250 insert mapping, ~2409 `cloneValues`, row type/select ~900-1000 so `workDate` is returned), partner timezone read at the two assembly entry points.
- Test: `invoiceAssembly.test.ts`, `invoiceService.*.test.ts` that cover the clone, an integration test `invoiceWorkDate.integration.test.ts`.

**Interfaces:**
- Consumes: `toPartnerLocalDate` (Task 2.1).
- Produces: `TimeEntryRow.startedAt?: Date | null`; `DraftLineSpec.workDate?: string | null`; `invoice_lines.work_date`; line rows from `invoiceService` expose `workDate: string | null`.
- Which timestamp: **`started_at`** defines the work date (work began that day). The range filter stays on `ended_at` (a billing-window concern; do not change it). Timezone: `partners.timezone` of the invoice's partner.

- [ ] **Step 1: Failing tests**

```ts
it('stamps workDate from startedAt in the partner timezone', () => {
  const spec = timeEntryToLineSpec(row({ startedAt: new Date('2026-09-17T02:30:00Z') }), 'USD', 'America/New_York');
  expect(spec.workDate).toBe('2026-09-16');
});
it('leaves workDate null when startedAt is missing (never fabricates)', () => {
  expect(timeEntryToLineSpec(row({ startedAt: null }), 'USD', 'UTC').workDate).toBeNull();
});
it('does not change quantity, unitPrice or lineTotal', () => { const a = timeEntryToLineSpec(row({ startedAt: new Date('2026-09-16T10:00:00Z') }), 'USD', 'UTC'); const b = timeEntryToLineSpec(row({ startedAt: null }), 'USD', 'UTC'); expect({ ...a, workDate: null }).toEqual(b); });
it('held block-hour entries are still partitioned out (no spec, hence no workDate)', () => { // feed an entry inside a hold window through partitionHoldingBlockHours; expect it in the held list and absent from `included` specs });
it('reissue clone copies workDate verbatim', async () => { // clone via the reissue path with a source line workDate '2026-09-16'; expect every cloned line's workDate to equal its source });
```
Integration: assemble an org with an entry spanning local midnight, assert the persisted `invoice_lines.work_date`; assert a non-time-entry line (manual, contract overage) has `work_date IS NULL`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/invoiceAssembly.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Add `startedAt: timeEntries.startedAt` to both selects; third parameter `timeZone = 'UTC'` on `timeEntryToLineSpec` (callers pass the partner zone; default keeps existing call sites green); add `timeZone` to `partitionTimeEntries` and `partitionHoldingBlockHours` (~228) and pass `(r, c) => timeEntryToLineSpec(r, c, timeZone)` into the **unchanged** generic `partitionByCurrency` (parts and AI-usage charges share it); set `workDate` only when `startedAt` is non-null; map `workDate` in the insert at ~1250 and `cloneValues`. Do not change `entryDescription`/`'Labor'` here (Open Decision 10).
- [ ] **Step 4:** Run the touched unit files, the typecheck, then the integration test via test-stack (tear down after).
- [ ] **Step 5: Commit.**

**W2 PR:** `Refs #8078`. CI: Test API + Integration Tests (the export-policy suites). If #8517 merges first, rebase and re-check the migration slot.

---

## W3: Itemization setting + rendering

Setting shape (Open Decision 3, appendix pattern): `partners.invoice_line_detail text NOT NULL DEFAULT 'off'` (`off` | `date`), `partners.invoice_line_grouping text NOT NULL DEFAULT 'entry'` (`entry` | `day`), per-invoice nullable overrides `invoices.line_detail text` and `invoices.line_grouping text` (NULL = inherit), resolved and **frozen at issue** beside `deviceAppendix` (`invoiceService.ts` ~1580) so a later partner default change never reflows an issued invoice. A draft renders live from `invoice ?? partner`; `loadInvoiceForRender` reads only the frozen invoice columns for issued documents (settings-audit rules 5/6, `invoicePresentation.ts`). Values are CHECK-constrained text, not Postgres enums (cheap to extend later), not boolean (two axes).

### Task 3.1: Migration, schema, resolver, freeze at issue

**Files:**
- Create: `apps/api/migrations/2026-12-23-180100-invoice-line-detail-setting.sql`
- Modify: `db/schema/orgs.ts` (~153), `db/schema/invoices.ts` (~91), `invoiceService.ts` (issue stamp ~1580; `quoteAcceptService.ts` ~556 when it issues), `routes/invoices/settings.ts`, `routes/invoices/lifecycle.ts` (per-send override, mirror ~52 only if the appendix has one: it does), `lib/sendComposer.ts`, `invoicePresentation.ts` or a new `resolveLineDetail(invoice, partner)` beside the appendix resolver, `tenantExportPolicyRegistry.ts` (`invoices` ~521 `included` += `line_detail`, `line_grouping`)
- Test: `invoiceLineDetail.resolve.test.ts`, `invoiceIssue.lineDetailFreeze.integration.test.ts`, export-policy/cascade/RLS suites

Migration:

```sql
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_line_detail text NOT NULL DEFAULT 'off';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_line_grouping text NOT NULL DEFAULT 'entry';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_detail text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_grouping text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_invoice_line_detail_check') THEN
    ALTER TABLE partners ADD CONSTRAINT partners_invoice_line_detail_check CHECK (invoice_line_detail IN ('off','date'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_invoice_line_grouping_check') THEN
    ALTER TABLE partners ADD CONSTRAINT partners_invoice_line_grouping_check CHECK (invoice_line_grouping IN ('entry','day'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_line_detail_check') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_line_detail_check CHECK (line_detail IS NULL OR line_detail IN ('off','date'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_line_grouping_check') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_line_grouping_check CHECK (line_grouping IS NULL OR line_grouping IN ('entry','day'));
  END IF;
END $$;
```
`partners` is small: NOT NULL DEFAULT is a metadata-only add on PG ≥ 11 (constant default); `invoices` columns are nullable with no default. No row writes, so no `set_config`.

Quorum additions (all verified against the code): (a) the per-invoice override is **not** in `updateInvoiceSchema` (`packages/shared/src/validators/invoices.ts` ~71) or `updateInvoice` (~577); persist it through the same path the appendix override uses (`routes/invoices/settings.ts` / `invoiceService.ts` ~1052-1100), with a route test that sending `null` resets to inherit and that an unknown value is a 400, never silently dropped. (b) `getInvoice` (~767) returns the raw draft header, so add **resolved** preview fields (`resolvedLineDetail`, `resolvedLineGrouping`) to the detail response for `InvoiceDocument`, keeping the raw nullable overrides for the editor. (c) Combination rule: grouping `day` only takes effect when detail is `date`; with detail `off` the document renders exactly as today whatever grouping says (validator accepts the pair; the resolver normalises `{off, day}` → `{off, entry}`; test all four combinations). (d) Copy both columns in the reissue header.

- [ ] **Step 1: Failing tests.** Resolver: `resolveLineDetail({lineDetail:null}, {invoiceLineDetail:'date'}) → {detail:'date', grouping:'entry'}`; invoice override wins; unknown value coerces to `off`. Freeze: issue a draft with partner `date`, then set the partner back to `off`, then `loadInvoiceForRender` still returns detail `date`. Export-policy suite red because `invoices` columns are unclassified.
- [ ] **Step 2:** Run (unit: `cd apps/api && npx vitest run src/services/invoiceLineDetail.resolve.test.ts`; integration via test-stack, then down). Expect FAIL.
- [ ] **Step 3:** Implement migration, schema, resolver, stamp at issue (`lineDetail: inv.lineDetail ?? partner?.invoiceLineDetail ?? 'off'`, same for grouping, in the same `update` that sets `deviceAppendix`), PATCH validation in `settings.ts` (Zod `z.enum`; never `z.undefined()`), partner-defaults route, per-send override mirror of the appendix. Classify `line_detail`, `line_grouping` as `included`. Grep proof that `partners` has no export policy: `grep -n "\"partners\"" apps/api/src/services/tenantExportPolicyRegistry.ts` returns no `tablePolicy` entry; put the result in the PR.
- [ ] **Step 4:** Run unit + the four integration suites + `pnpm db:check-drift` + typecheck.
- [ ] **Step 5: Commit.**

### Task 3.2: Shared display helpers and the golden OFF test

**Files:** Create `packages/shared/src/utils/invoiceLineDetail.ts` (+ test), export from the package index; Modify API `invoicePdf.ts` `lineNote` and `accountingInvoicePush.ts` `accountingLineNote` to call the shared structured helper.

**Interfaces:** Produces
```ts
export function lineWorkedVsBilled(l: { quantity: string; workedMinutes: number | null }): { worked: string; billed: string } | null;
export function formatWorkDate(isoDate: string, locale: string): string;           // date-only, Intl in UTC, no instant conversion
export function groupLinesForDisplay<L extends { ticketId: string | null; workDate: string | null; customerVisible: boolean }>(
  lines: L[], mode: 'entry' | 'day'): Array<{ ticketId: string | null; days: Array<{ workDate: string | null; lines: L[] }> }>;
```
The helper returns structured data; each surface localises (API `tApi`, web/portal i18n), which removes the three-to-four hand-copied twins' *logic* while leaving each surface's own string lookup (Open Decision 11).

- [ ] **Step 1: Failing tests** (shared): worked==billed → `null`; 110 min vs `1.50` → `{worked:'1.83',billed:'1.50'}`; `formatWorkDate('2026-09-16','en')` → `Sep 16, 2026` even when `TZ=America/Los_Angeles` and `TZ=Pacific/Auckland` (loop `process.env.TZ`); grouping `entry` keeps input order and ticket groups; `day` buckets by `workDate` ascending with `null` dates last in one bucket; per-line amounts never altered (quantity/total untouched; assert identity of line objects).
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/utils/invoiceLineDetail.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Then **golden test first**: before touching `invoicePdf.ts`, add `invoicePdf.golden.test.ts` that renders a fixed invoice (time-entry line with `workedMinutes != quantity`, a hidden line, a non-time line, tax and no-tax) with detail `off`/grouping `entry`, and snapshot the HTML string; for the PDF, assert the extracted text and the page count (pdfkit embeds a creation date, so snapshotting raw bytes is not stable: stub `Info.CreationDate` or compare text + geometry from `invoiceColumnsFor`). Run it on **unmodified** code and commit the snapshot, so the refactor of `lineNote` is proven byte-identical.
- [ ] **Step 4:** Run golden + shared + `invoicePdf*`/`accountingInvoicePush.test.ts`; expect PASS with no snapshot diff.
- [ ] **Step 5: Commit.**

### Task 3.3: PDF and customer HTML render

**Files:** Modify `invoicePdf.ts` (`InvoiceLineRow` gains `workDate`, `loadInvoiceForRender` ~736 selects it and the frozen `lineDetail`/`lineGrouping`; `renderInvoiceHtml` ~185; `renderInvoicePdfBuffer` ~377/451-480), `i18n/locales/{en,pt-BR}/pdf.json` (a `lineDetail.day`-style key only if a label is needed; the date itself needs none). Test: `invoicePdf.lineDetail.test.ts`.

Layout: **no new column.** With `date`, a muted sub-line under the line title (before the worked-vs-billed note) reads `Sep 16, 2026`; with grouping `day`, each ticket group gets day sub-headers (`Sep 16, 2026`) and the per-line date sub-line is suppressed (the header carries it). In pdfkit, add the date line to `descHeight` exactly as `noteHeight` is, and give the day sub-header the same `y > doc.page.height - 140` page-break guard the ticket header uses. Lines with `workDate NULL` render exactly as today, in an undated bucket after the dated ones. Hidden (`customerVisible=false`) lines stay filtered before grouping. A `time_entry`-only rule: only lines with `workDate != null` can print a date.

Pagination (quorum, verified: the existing guard tests only the row's starting `y`): compute the full row height (title + blurb + date + note) first and `addPage()` **before drawing any cell of the row** when it will not fit, so numeric cells never stay behind on the previous page; a row taller than a page is the one allowed overflow. Fixtures use Helvetica-encodable text (accented Latin, not CJK; pdfkit's built-in Helvetica has no CJK glyphs, so a CJK note renders as missing glyphs today: record that as a known pre-existing limitation, not a W3 task). Assert alignment through the extracted text positions, not just page count.

- [ ] **Step 1: Failing tests:** `date`+`entry`: HTML contains `Sep 16, 2026` under the title, and not for a manual line; `day`: one sub-header per distinct date, two entries on one day share a header and keep their own amounts and rows; `off`: identical to golden; `workDate` NULL with `date` on: identical to golden; long note (3,000 chars, non-ASCII Latin, e.g. `Ünïcödé ✓`-style accents repeated) wraps and a long invoice paginates without clipping (assert `doc` page count increases and the last line's text appears via the text-extraction helper the existing pdf tests use); note + date + worked-vs-billed all present; HTML escaping of a note containing `<script>`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/invoicePdf.lineDetail.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Step 4: run the file, the golden and the whole `invoicePdf*` set + typecheck. Step 5: Commit.

### Task 3.4: Public link and portal API/UI

**Files:** Modify `routes/invoicesPublic.ts` (~140 explicit select: add `workDate`; the resolved `lineDetail`/`lineGrouping` must come from the frozen invoice columns), portal API `routes/portal/invoices.ts` (re-find the line select path), `apps/portal/src/lib/api.ts` (line type + `lineWorkedVsBilledNote` ~511 now calls the shared helper), `apps/portal/src/components/portal/{invoicePaper,InvoiceDetailView,PublicInvoiceView}.tsx`. Tests: `invoicesPublic.test.ts`, portal `InvoiceDetailView.test.tsx`, plus a portal i18n parity test if portal has one (grep `localeParity` in `apps/portal`).

- [ ] **Step 1: Failing tests:** public response includes `workDate` per line and the frozen mode; portal view renders the date sub-line for `date` and day sub-headers for `day`, nothing extra for `off`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/invoicesPublic.test.ts`; `cd apps/portal && npx vitest run src/components/portal/InvoiceDetailView.test.tsx`; expect FAIL.
- [ ] **Step 3-5:** implement, rerun, commit.

### Task 3.5: Web document, editor, settings, per-invoice override

**Files:** Modify `apps/web/src/components/billing/{invoiceTypes.ts (~139 twin helper → shared), InvoiceDocument.tsx, InvoiceEditor.tsx, InvoiceDetail.tsx, BillingDocumentsTab.tsx, InvoiceActions.tsx}`, `apps/web/src/locales/*/…json` (all 7). Tests: `InvoiceDocument.test.tsx`, `InvoiceEditor.test.tsx`, `BillingDocumentsTab.test.tsx`, localeParity.

UI: Partner default in `BillingDocumentsTab` beside "Billed devices" (one home per setting; states count of places configured before/after in the PR template, per settings rule 9: before 0, after 1 partner default + 1 per-invoice override, like the appendix). Per-invoice override in `InvoiceActions` for drafts. In `InvoiceEditor`, the work note is the line description the editor already shows; add a muted cue under time-entry lines: "Printed on the customer invoice". All mutations via `runAction`; `no-silent-mutations.test.ts` must stay green.

- [ ] **Step 1: Failing tests** (render with `date`/`day`, override control calls the PATCH through `runAction`, cue shown only on `source_type='time_entry'`).
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/billing/InvoiceDocument.test.tsx src/components/billing/BillingDocumentsTab.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n`; expect FAIL.
- [ ] **Step 3-5:** implement, add keys to all 7 locales, typecheck web (`cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .`, check the exit code), commit.

### Task 3.6: AI billing surface

Verified: the appendix override (`deviceAppendix`) is **not** exposed in `aiToolsBilling.ts` (only `routes/invoices/lifecycle.ts` and `quoteAcceptService.ts` carry it), so there is no AI-tool change in this wave. AI callers get the partner default; an AI override is a follow-up if wanted. No task.

**W3 PR:** `Refs #8078`. CI: Test API, Test Web, Integration Tests (export policy). After W3 merges, add a docs page note under the billing docs (separate docs commit in the same PR).

---

## W4: Accounting sync

### Task 4.1: Verify provider capabilities, then map the date

**Files:** Modify `accountingInvoicePush.ts` (`buildLinePayload` ~607, neutral payload type `AccountingInvoiceLinePayload` in `providerRegistry.ts`), `quickbooksProvider.ts` (~953), `xeroInvoices.ts`. Tests: `accountingInvoicePush.test.ts`, `accountingXeroInvoicePush.integration.test.ts`, `accountingInvoicePushCallSites.test.ts`, provider unit tests.

Policy (Open Decision 5, recommended): the neutral payload gains `serviceDate?: string | null`. QuickBooks maps it to `SalesItemLineDetail.ServiceDate` (**Step 1 is to confirm against Intuit's current API reference and one sandbox push; if absent, fall back to the description suffix**). Xero (no date field) appends ` — Sep 16, 2026`-style text to the description **only when the invoice's frozen `line_detail` is `date`**, so an OFF partner's accounting copy is byte-identical to today. Truncation (quorum, verified): Xero today truncates the whole description, and only its numeric fallback suffix gets reserved space, so the worked-vs-billed disclosure is *not* currently protected. Change `buildLinePayload` to return `{base, suffix}` (suffix = worked-vs-billed + date) and have each provider reserve `suffix` plus any fallback suffix before truncating the base. QuickBooks gains a cap at its **verified** limit (Step 1); this is the one intentional change for OFF partners (a >limit description is truncated instead of rejected by QBO): test it explicitly and call it out in the PR. Otherwise OFF output is byte-identical. `buildLinePayload` receives only the line today; thread the invoice's frozen `lineDetail` in from the call site (~764). Hidden lines keep today's zeroed amounts (`pushedLineAmounts`).

- [ ] **Step 1: Failing tests:** payload for a dated line with detail `date` carries `serviceDate`; with `off` it is absent and description identical to a captured baseline; QuickBooks body has `ServiceDate` only when present; a 4,500-char description is truncated to the cap with the worked-vs-billed suffix intact (multi-byte safe: count UTF-16 vs characters per the provider's rule; test with emoji); Xero path unchanged for `off`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/accounting/accountingInvoicePush.test.ts src/services/accounting/accountingInvoicePushCallSites.test.ts`; expect FAIL.
- [ ] **Step 3-5:** implement, run, commit. Lab: push one dated invoice to each provider sandbox and note the result in the PR (use the existing Xero lab push procedure).

**W4 PR:** `Refs #8078`. Depends on W2 and W3. CI: Test API; the Xero integration test runs under Integration Tests.

---

## W5: Refresh drafts from time entries (deferrable, Open Decision 9)

**Files:** Modify `invoiceService.ts` (new `refreshDraftTimeLines(invoiceId, actor)`), `routes/invoices/lines.ts` or the file that holds line routes (new `POST /invoices/:id/refresh-time-lines`), `aiToolsBilling.ts` (action `refresh_time_lines`; Tier 2, draft-only), web button in `InvoiceEditor.tsx` via `runAction`, all 7 locales.

Semantics: only on `status='draft'`, under the invoice lock (same lock order as `changeInvoiceCurrency`: `lockDraftInvoice` first). For each `time_entry` line whose source entry is still `not_billed`, re-read the entry and refresh `work_date` and the description. A hand-edited description must not be clobbered, and the line cannot tell an edited description from an assembled one by comparison, so this wave adds `invoice_lines.description_edited boolean NOT NULL DEFAULT false` (migration `180200`, which writes rows and so elects system scope first; classified `included`), set by `updateLine` when the description changes. Because pre-existing drafts cannot say whether they were edited, the migration backfills `description_edited = true` for every existing `time_entry` line on a draft invoice (conservative: nothing existing is overwritten), and `cloneValues` copies the flag. Refresh skips edited descriptions but still refreshes `work_date`. It also refreshes `worked_minutes` and `is_unapproved_time` (both are assembly snapshots; time-entry edits clear approval), never `quantity`/`unit_price`/`line_total`. A changed billed duration would silently change totals, so such lines are reported as `quantityDrifted` and left alone. Issued/billed lines: 409. W5 also runs the `invoice_lines` grep (`tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`) and classifies `description_edited` as `included`, then the four contract suites under Integration Tests.

- [ ] **Step 1: Failing tests:** entry description edited after assembly → refresh updates the line; hand-edited line description is preserved; entry already `billed` elsewhere → skipped and reported; non-draft → 409 `INVOICE_NOT_DRAFT`; `workDate` updates when `startedAt` was edited.
- [ ] **Step 2-5:** as above (`cd apps/api && npx vitest run src/services/invoiceRefresh.test.ts`, integration via test-stack, typecheck, `pnpm db:check-drift`, commit). Recommendation: defer until W3 is in use (operators may find re-assembly sufficient).

---

## Line-grouping semantics

| | per-entry (default) | per-day | per-ticket |
|---|---|---|---|
| One invoice line is | one time entry (today) | one time entry, **presented** under a day sub-header | one time entry, under the ticket header (already how every renderer groups) |
| Qty/rate math | unchanged, per entry | unchanged, per entry; the header shows no total (a computed total would be a second source of truth, add one only after the PDF/portal agree) | unchanged |
| `source_id` / `SOURCE_ALREADY_BILLED` | unchanged, 1:1 | unchanged, 1:1 | unchanged, 1:1 |
| Accounting sync | one remote line per entry | same, one per entry | same |
| Block-hours hold | n/a, held entries never become lines | same | same |

An **assembly-time merge** (one line per day or per ticket) would change line cardinality, make `source_id` one-to-many, require a link table to release the `billed` lock on void, blend work types and rates (unless merges are restricted to identical rate+work type+currency, which makes a partial merge surprising), lose per-entry traceability in the accounting copy and break `refresh`. Rejected; recommended in Open Decision 2.

## Edge-case test matrix (owner task in brackets)

Entry with no description keeps `'Labor'` [2.3]; midnight-spanning entry [2.1]; partner OFF byte-identical [3.2/3.3]; draft vs issued [3.1]; hidden lines [3.3]; unapproved time keeps its marker [3.3]; multi-currency blocked groups unaffected (no change to `partitionByCurrency`) [2.3]; description near the 4000 caps [4.1]; non-ASCII + long-note wrapping/pagination [3.3]; worked≠billed note present alongside the date [3.3].

## Self-review

- Spec coverage: gaps 1-4 → W1.1, W2/W3, W1.2, finding 5 + W5. Grouping axis → Decision 2. Block hours → finding 8 and Decision 6. PII → finding 3, W1.1, Decision 4. Cascade/export → W2.2/3.1 with grep and suite names.
- Types: `workDate` (camel) ↔ `work_date`; `lineDetail`/`lineGrouping` ↔ `line_detail`/`line_grouping`; `toPartnerLocalDate`, `formatWorkDate`, `groupLinesForDisplay`, `lineWorkedVsBilled` used consistently.

## Open Decisions

1. **Line-detail contract.** Options: (a) typed `invoice_lines.work_date date`; (b) text baked into `description`; (c) jsonb. Timestamp: `started_at` vs `ended_at`; timezone: partner vs UTC. **Recommend (a), `started_at`, partner timezone** (`partners.timezone`), converted once at assembly. Why: a typed column survives description edits (#6467), keeps tenant export complete (jsonb would be `excludedOpen`), and storing a date removes every renderer's timezone question.
2. **Grouping.** Options: render-time presentation over per-entry lines vs assembly-time merge. Default per-entry. **Recommend render-time, default `entry`, `day` as the only alternate.** Why: keeps one line per entry, which `source_id`, the issue-time lock, accounting sync and drawdown depend on.
3. **Setting shape and home.** Options: partner column + per-invoice override frozen at issue (appendix pattern) vs a new partner-wide profile table; per-org override or none; toggles (date / note / technician / worked time). **Recommend partner columns (`invoice_line_detail`, `invoice_line_grouping`) + per-invoice override + freeze at issue; no per-org override in v1; toggles v1 = date only (worked-vs-billed already always shows when it differs); technician name deferred.** Why: smallest design with the proven snapshot behavior; a table adds partner-wide RLS and registry work for two scalars. A per-org override is a follow-up if MSPs ask.
4. **Customer-facing note.** Options: reuse `time_entries.description` (today's behavior: it is already the printed line title) vs a separate customer-visible note on the entry. **Recommend reuse now, plus the W1 "printed on the customer invoice" wording and the editor cue; add a separate `customer_note` only if MSPs need internal-only detail.** Why: reuse regresses nothing; a second field is a migration, a form field and a sync story for an unproven need. Default OFF for the *date* and *technician*; note stays as today (the brief assumed notes were not yet visible; they are, finding 3).
5. **Accounting sync.** Options: fold the date into the description string vs structured per-provider mapping (QBO `ServiceDate`) vs both; truncation policy. **Recommend structured `serviceDate` on the neutral payload, QBO `ServiceDate` (after verification), Xero description suffix only when the invoice's frozen detail is on, truncate the base and keep the suffix, defensive cap on QuickBooks.** Why: no loss under caps and OFF partners stay byte-identical.
6. **Block-hours overage line.** Options: leave aggregated vs list the consumed entries' dates/notes. **Recommend leave aggregated now; revisit alongside #8517 W04 (customer-facing support hours).** Why: the overage line is `source_type='contract'`, listing entries there would double-describe hours already shown as drawdown.
7. **Backfill.** **Recommend none.** Why: issued invoices are immutable documents; NULL prints nothing; reissue copies the column.
8. **Wave cut.** **Recommend W1 (MCP) first and independent, W2, W3, W4, W5 as above.** Why: W1 has no migration and unblocks the original complaint immediately. W3/W4 stay separate because one is layout-reviewed and the other needs external lab verification.
9. **Draft refresh.** In scope or deferred. **Recommend defer W5** until W3 is used; if built, track `description_edited` so hand edits are never clobbered. Why: the staleness is real (verified) but re-assembly is a workable escape hatch.
10. **`'Labor'` fallback.** Options: keep, localise at render, replace with work-type name. **Recommend keep for now** (it is stored, English, and out of this issue's scope), note as a follow-up: render `NULL`/empty descriptions as the work-type name. Why: changing stored text is a behavior change on existing drafts; needs its own decision with i18n.
11. **Shared helper vs duplication.** **Recommend extract structured helpers into `packages/shared` (Task 3.2) and let each surface localise.** Why: removes duplicated logic from API pdf, accounting, web and portal while respecting that each uses its own i18n.
12. **Technician identity on invoices (added).** Options: never; opt-in per partner. **Recommend out of scope**, revisit with Decision 4. Why: it is the genuinely new PII exposure and needs its own opt-in and cue.
13. **Agent principals and `update_time_entry` (added).** Refuse like `log_time_entry` (intent release) vs allow. **Recommend refuse.** Why: unattended agents should not rewrite human timesheets.

## Quorum record

Codex (medium, read-only; the repo asks for `xhigh` on consequential choices, so the orchestrator may re-run at `xhigh` before approval) returned 11 findings; each was verified against the cited code and folded in above (W1 empty-patch/validator, W3 PATCH path, resolved preview fields, `{off,day}` rule, reissue presentation copy, pdf pagination and CJK font limit, W4 depends on W3, Xero/QBO suffix reservation and the QBO OFF cap exception, W5 edited-flag backfill and snapshot columns). No unresolved disagreements.
