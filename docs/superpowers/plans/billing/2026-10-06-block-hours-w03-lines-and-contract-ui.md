---
tracking_issue: LanternOps/breeze#4547
spec: docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md
index: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md
wave: W03 — lines and contract UI (the wave that opens the feature)
blast_radius: high (opens a money path; validators; AI tool surface; a public partner-API surface)
---

# Block Hours W03: Lines and Contract UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP add, edit and retire an `hour_block` contract line, and see the live balance of the open period and the closed-period history on the contract page. This is the wave that **flips the validator**: before it, no API can create a block line (W02 proved the engine over fixture rows); after it, every door — the contracts HTTP routes, the partner API, the `manage_contracts` AI tool — accepts one.

**Architecture:** Validators first (shared, pure, table-tested, with create/persisted parity), then the service writers (stamp `hour_block_first_period_start`, map the live-block unique index to a typed 409, lock the non-patchable fields, retire-vs-delete), then the one new read module (`contractHourBlockEstimate.ts`, the live open-period figure) wired into `computeContractEstimate`, then one new route (`GET /contracts/:id/hour-periods`), then the AI/partner doors, then the web (locale keys → editor → detail panel → assembly "held" notice), then the real-DB integration suite that proves the contract with Postgres.

**Tech Stack:** Hono + Drizzle + postgres.js, `@breeze/shared` Zod validators, Astro + React 19 islands + react-i18next, Vitest (unit + integration).

**Spec:** `docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md` — amendment sections at the top override the body; §1 (the line), §5 (Visibility). **Index:** `docs/superpowers/plans/billing/2026-10-06-block-hours-index.md` — C2, C6, C7 (W03 rows), C8, C9, C10, Open Decisions 10 and 13. Where this plan and the index disagree, the index wins.

**Depends on:** W01 and W02 **merged**. Consumed as given (index C2/C3/C6/C7): the `contract_lines` columns and CHECKs, `contract_lines_one_live_hour_block_per_org_uq`, `contract_hour_periods` (`contractHourPeriods` Drizzle export), `HOUR_BLOCK_LINE_TYPE` / `ROLLOVER_POLICIES` / `RolloverPolicy` in `@breeze/shared`, the fail-closed `case 'hour_block'` arms, and from W02 `contractHourBlocks.ts` (`entryHours`, `sumEntryHours`, `computePeriodMath`, `HourBlockLineSpec`), `contractHourBlockClose.ts`, the `generateDueInvoice` arm, retire-on-expire/cancel, the time-entry lock, and `AssemblyResult.heldForHourBlock`.

**Line numbers.** Every `file:line` below was verified against `origin/main` @ `327fa66b11`, which is **before W01/W02 land**. W01/W02 shift `contractService.ts` by roughly 100 lines. Locate every edit by **symbol name**, not by number; the numbers are there so a reviewer can see the code that was read.

**Settings rule 9 (CLAUDE.md "Settings — one concept, one home"):** does not apply — no `pages/settings/**` file and no `*Settings*` component is touched. Block hours is a contract-line field, edited in the contract editor only.

---

## READ THIS FIRST: where current code contradicts the index or the spec

These were found while writing the plan. Each is handled below; the first three need a human decision.

| # | Where | What | This plan's handling |
|---|---|---|---|
| 1 | Index C9 as first drafted (first period starting `>= today`) | Under-delivered on arrears and on drafts activated late: the in-progress arrears period is still unclaimed and is billed the block fee at its end, and a draft's first claim happens at activation, not at add time. The customer would pay the fee for a period whose hours are not closable. | **Resolved by the coordinator; the index C9 is now the refined rule and this plan implements it.** `hour_block_first_period_start` = the first period whose block fee has not yet been claimed: active contract -> `duePeriodStartFor(billingTiming, nextBillingAt, intervalMonths)` (`contractMath.ts:74`; advance -> next period, arrears -> period in progress); draft -> provisional stamp = the contract's first period, **re-stamped inside `activateContract`** (`contractService.ts:1815`, drafts only) to `duePeriodStartFor` over the `nextBillingAt` activation sets. Task 2 (`firstUnclaimedPeriodStart`), Task 3 (add + re-stamp, with tests). |
| 2 | Index C9 / kickoff: "contract-local today = the existing `todayISO` helper" | There is no contract-local date. `todayISO` (`contractService.ts:1811`) is `asOf.toISOString().slice(0, 10)` — **UTC**. `contracts` has no timezone column (`db/schema/contracts.ts:27-60`). | Uses UTC `todayISO` and **moves it to `contractMath.ts`** (exported) so the new estimate module can use it without a circular import. |
| 3 | Kickoff / index C7: `computeOpenHourBlockPeriod` "MUST be called inside a system DB context" and `computeContractEstimate` calls it | `computeContractEstimate` is called from `GET /:id/estimate` (`routes/contracts/contracts.ts:66-69`) and the AI `add_contract_line` action (`aiToolsBilling.ts:385`), both **inside a held request transaction**, both **partner-scope** (`requireScope('partner','system')`, `partnerScopeRefusal`). Escalating with `runOutsideDbContext(() => withSystemDbAccessContext(...))` there double-holds a pooled connection (CLAUDE.md "Partner-Wide First" step 3). | `computeOpenHourBlockPeriod` keeps the exact name/signature and opens **no** context. `time_entries` RLS is `system OR breeze_has_partner_access(partner_id)`, so a **partner-scope context holding `contract.partnerId` already sees the rows** — no escalation, no second connection. The function **fails closed** (throws) under an organization-scope or absent context so the partner-axis zero-rows trap can never render as "0 hours used". W04's portal handler satisfies the contract by wrapping in `runOutsideDbContext(() => withSystemDbAccessContext(...))` as the index says. See Task 6 for the full justification. |
| 4 | Kickoff: `removeContractLine` "currently deletes blindly and returns void" | It returns a `ContractLineAudit` (`contractService.ts:1793-1808`) and 404s on a miss since #3205 W03; HTTP answers `{ data: { ok: true } }` (`routes/contracts/lines.ts:80`). All **three** doors call it: HTTP, **the partner API (`routes/partnerApi/contracts.ts:236-250`)**, and the AI tool (`aiToolsContracts.ts:352`). | `ContractLineAudit` gains `retired?: boolean`; all three doors report `{ ok: true, retired }`. The partner API is a public surface the index does not mention — it opens with the shared schema and is covered in Task 8. |
| 5 | Index C6: add `'hour_block'` to `ALLOWANCE_LINE_TYPES` | `packages/shared/src/validators/quotes.test.ts:579-581` asserts `QUOTE_DEVICE_SET_TYPES` **equals** `ALLOWANCE_LINE_TYPES`. Adding the value turns that tripwire red. A quote line cannot express a block (spec: `quoteToContract.ts` unchanged). | Task 1 narrows that test to `ALLOWANCE_LINE_TYPES` minus `hour_block`, with the reason in a comment. `quotes.ts` itself is untouched. |
| 6 | Index C7 `resolveLineQty` arm | The arm `{counted:1, billed:1, included:null, overage:0, overageMode:null, live:false}` is right for a live block, but a **retired** block would still add its fee to the estimate, `listContracts.estimatedPeriodValue` and the MRR rollup, while W02's `generateDueInvoice` skips retired lines — the dashboard would promise money that is never billed. | The arm returns a zero quantity when `hourBlockRetiredAt !== null`. This extends C7 and does not rename or re-type it. |
| 7 | Spec §5: `ContractDetail`'s bar shows the **rate** as `overageRate` | The estimate field is `overageUnitPrice` (C8, after Plan-time amendment 1). | Uses C8's names throughout. |
| 8 | CLAUDE.md i18n traps | `translationCoverage.test.ts` caps exact-English duplicates per locale/namespace; `humanizedKeyRegression.test.ts` rejects a 4+-word key whose value equals its humanized name. | Every new string is a real translation that differs from English; no new key leaf is 4+ camel-case words whose value spells the key. |
| 9 | `ContractEditor.tsx:101-135` `buildLinePatch` | The generic allowance branch (`l.includedQuantity != null && !d.allowanceOn` → `patch.includedQuantity = null …`) would send three nulls the moment a tech renames a block line, because `draftFromLine` computes `allowanceOn` from `includedQuantity != null`. | Task 11 returns from `buildLinePatch` **before** the allowance branch for `hour_block`, and `ALLOWANCE_TYPES` (web) deliberately **excludes** `hour_block` — the generic "fixed quantity of devices" toggle is the wrong control for hours. Pinned by a test. |
| 10 | Index C7 "`createContractWithLinesDetailed` rejects `hour_block`" | The function inserts the contract row first, then loops the lines (`contractService.ts:2223-2250`); a mid-loop rejection would leave an orphan draft contract. | The rejection runs **before** the contract insert. |
| 11 | **W01's fail-closed guards and their tests** (`2026-10-06-block-hours-w01-foundation.md` Tasks 1-3) | W01 asserts `hour_block` is **not** in `CONTRACT_LINE_TYPES` / `ALLOWANCE_LINE_TYPES`, that `contractLineInputSchema` rejects it, and that the estimate (`resolveLineQty` arm) and `updateContractLine` (`assertNotHourBlock(current)`) throw `HOUR_BLOCK_NOT_ENABLED`. Left in place they turn W03 red. | Removed explicitly: Task 1 Step 4 (the two shared tests), Task 3 Step 3 item 2 (the arm) and Step 4 (the estimate test), Task 4 Step 3 item 0 and Step 4 (the update guard and its test). `generateDueInvoice`'s guard is W02's to replace and is untouched. |
| 12 | Mid-period edits (index Open Decision 15, default A) | `updateContractLine`'s docblock says "edits affect FUTURE periods only"; true for a flat line, **false** for a block: the close reads the line as it is. | Block edits apply to the open period at its close. The editor shows "Changes apply to the current open period (dates) at its close", the audit records before/after for the block columns, and the AI `patch` description no longer says "future periods only". |

---

## Global Constraints

- **Index wins.** Do not rename, re-type or re-home anything in index C2/C6/C7/C8/C9/C10. A wave plan may add private helpers (this plan adds `contractHourBlockEstimate.ts`'s pure helpers, `firstUnclaimedPeriodStart`, `hourBlockHasHistory`).
- **Open Decision 10 (default A):** `overageMode` on a block is `'bill'` only. The validator, the service lock and the UI all pin it; the UI never offers a choice.
- **Open Decision 13 (default A):** the live-block index is per org and counts **draft** contracts' lines. The editor error copy says "retire the current block first". Do not add a draft exemption.
- **No new migration, no new table, no new tenancy shape.** `contract_hour_periods` is Shape 1 (W01); the hour-periods route reads it in the ordinary request context exactly like `contract_billing_periods` in `getContract` (`contractService.ts:379-399`). The real-DB suite (Task 14) asserts that, rather than trusting the analogy.
- **Money.** Hours are exact 2-dp (`sumEntryHours`, never float sums of floats). The overage price goes through `assertRepresentable` (already on the allowance path, `contractService.ts:1605`, `:1615`) and `overageValue()` for display.
- **Never catch a 23505/23503 inside a context and continue.** The only catch in this wave maps a 23505 to `ContractServiceError` and **re-throws** inside the line writer's own `db.transaction` (the same shape as `isGroupFkViolation`, `contractService.ts:282-288`).
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`); the `no-silent-mutations` test guards it. This wave adds no new mutation handler — it changes the three existing ones (`addLine`, `saveLine`, `removeLine`) — and one `GET` (history), which is not a mutation.
- **Eight-locale parity with real translations** (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`, plus `tickets.json` for the held-hours notice).
- **Test commands:** `cd apps/api && npx vitest run <explicit paths>`; `cd apps/web && npx vitest run <explicit paths>`; `cd packages/shared && npx vitest run <explicit paths>`. **Never** `pnpm … test -- --run <path>`; **never** a trailing-slash directory filter; check the reported file count. Integration: `pnpm test-stack up` → `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` → `pnpm test-stack down` (tear down when done and say so).
- **Typecheck** (no root script): `cd packages/shared && npx tsc --noEmit -p .`; `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .`; `cd apps/web && npx tsc --noEmit -p .`. Check the exit code; never pipe to `tail` (an OOM reads as green).
- **Neutral wording** in code comments, test names, commit messages and the PR: this is a public repo.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

The five failure modes most likely to bite in this wave, each pinned by a test:

1. **Fee billed for a period whose hours are not counted (or the reverse)** — `first_period_start` must be the first period whose block fee is not yet claimed: the NEXT period for an advance contract mid-period, the period IN PROGRESS for arrears, and for a draft the period activation will actually claim. Pinned by Task 2 (`firstUnclaimedPeriodStart` table: draft, active advance, active arrears, monthly and quarterly), Task 3 (add stamps each case; `activateContract` re-stamps a draft with a past start date mid-period under both timings, never re-stamps a paused-then-resumed contract, and touches no lines when there is no block), and re-proved against real Postgres in Task 14.
2. **A second live block 500s instead of 409s** — the unique index is the only race-proof guard; the service must translate 23505 on exactly that index and not swallow other unique violations. Pinned by Task 3 (23505 on the index → 409 `HOUR_BLOCK_EXISTS`; 23505 on another constraint propagates) and Task 14 (add → retire → add-again against the real index).
3. **The partner-axis zero** — a drawdown read under an organization-scope or absent context sees **zero** `time_entries` and would render "0 of 10 hours used". Pinned by Task 6 (the guard throws; the pure builder is table-tested) and Task 14 (seeded entries: org-scope read sees 0, partner-scope and system see them).
4. **A retired line keeps billing in the estimate/MRR, or an edit un-retires it** — pinned by Task 3 (`resolveLineQty` retired arm via MRR and estimate), Task 4 (any patch of a retired block → `HOUR_BLOCK_FIELD_LOCKED`) and Task 5 (retire vs delete truth table, idempotent re-retire).
5. **The generic allowance UI corrupts a block on a rename** — `buildLinePatch` must not send `includedQuantity: null` for a block. Pinned by Task 11 (`ContractEditor.hourBlock.test.tsx`: description-only edit sends exactly `{ description }`).

---

## File structure

| Path | Responsibility |
|---|---|
| `packages/shared/src/validators/contracts.ts` | Modify. `'hour_block'` in the two type tuples; shape fields; block invariant rows; input + update schemas; `mergeContractLinePatch` |
| `packages/shared/src/validators/contracts.hourBlock.test.ts` | New. Table tests, create/persisted parity, merge, strict-update rejection |
| `packages/shared/src/validators/quotes.test.ts` | Modify one assertion (`:579-581`) |
| `packages/shared/src/types/hourBlock.ts` | New. `HourBlockEstimate` (C8) + re-export from `types/index.ts` |
| `apps/api/src/services/contractMath.ts` (+ `.test.ts`) | Modify. Export `todayISO`; add `firstUnclaimedPeriodStart` |
| `apps/api/src/services/contractTypes.ts` | Modify. Codes `HOUR_BLOCK_EXISTS`, `HOUR_BLOCK_FIELD_LOCKED`; `ContractLineAudit.retired` |
| `apps/api/src/services/contractService.ts` | Modify. `resolveLineQty`, add/update/remove line, `getContract` decoration, `computeContractEstimate`, quote-path rejection, audit columns |
| `apps/api/src/services/contractHourBlockEstimate.ts` (+ `.test.ts`) | New. `computeOpenHourBlockPeriod` (coordinator-fixed name/signature) + pure helpers |
| `apps/api/src/services/contractHourPeriodsRead.ts` (+ `.test.ts`) | New. `listContractHourPeriods` |
| `apps/api/src/routes/contracts/hourPeriods.ts`, `routes/contracts/index.ts` | New route + mount |
| `apps/api/src/routes/contracts/lines.ts`, `routes/partnerApi/contracts.ts`, `services/aiToolsContracts.ts` | Modify. `{ ok, retired }`; AI descriptions; audit action |
| `apps/api/src/services/aiToolsBilling.ts` | Modify one call: `includeHourBlock: false` |
| `apps/api/src/services/contractService.hourBlock.test.ts` | New. Unit suite for the service changes |
| `apps/api/src/__tests__/integration/contractHourBlockLines.integration.test.ts` | New. Real-DB proof |
| `apps/web/src/components/contracts/{lineTypes.ts,AllowanceCell.tsx,ContractEditor.tsx,ContractDetail.tsx,HourBlockPanel.tsx}` | Modify / new |
| `apps/web/src/lib/api/contracts.ts` | Modify. Types + `listContractHourPeriods` |
| `apps/web/src/components/billing/InvoicesPage.tsx`, `tickets/TicketWorkbench.tsx` | Modify. Held-for-block notice |
| `apps/web/src/locales/*/{billing,tickets}.json` | Modify (eight locales) |
| `apps/web/src/components/contracts/{ContractEditor,ContractDetail}.hourBlock.test.tsx` | New |

---

### Task 1: Shared validators — the flip

**Files:**
- Modify: `packages/shared/src/validators/contracts.ts`
- Modify: `packages/shared/src/validators/quotes.test.ts` (line 579-581)
- Create: `packages/shared/src/validators/contracts.hourBlock.test.ts`

**Interfaces:**
- Consumes (W01): `HOUR_BLOCK_LINE_TYPE`, `ROLLOVER_POLICIES`, `RolloverPolicy` exported from this file (index C6). They must be declared **above** `CONTRACT_LINE_TYPES`; if W01 placed them lower, move them up in this task (a `const` used before its declaration is a TDZ error at import time).
- Produces: `CONTRACT_LINE_TYPES` and `ALLOWANCE_LINE_TYPES` containing `'hour_block'`; `ContractLineShape` gains `rolloverPolicy?: string | null`, `rolloverCapHours?: string | null`, `hourBlockAlertPct?: number | null` (typed `string | null`, not `RolloverPolicy`, so a Drizzle `text` column row is assignable; membership is validated at runtime); `contractLineInputSchema` and `updateContractLineSchema` gain the three fields; `mergeContractLinePatch` carries them. **`hourBlockFirstPeriodStart` / `hourBlockRetiredAt` appear in no input schema.**

Facts verified: `contractLineInputSchema` is a non-strict `z.object` (`:195-228`), so a client-sent `hourBlockFirstPeriodStart` is **stripped**, not rejected, on create; `updateContractLineSchema` is `.strict()` (`:269-286`) so the same key is a 400 on patch. Both are pinned below. `PersistedContractLine extends ContractLineShape` (`:309`), so the three new optional shape fields are inherited and existing `PersistedContractLine` literals in `contracts.test.ts:456+` still compile.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/validators/contracts.hourBlock.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  CONTRACT_LINE_TYPES, ALLOWANCE_LINE_TYPES, HOUR_BLOCK_LINE_TYPE, ROLLOVER_POLICIES,
  contractLineInputSchema, updateContractLineSchema, contractLineInvariantIssues, mergeContractLinePatch,
  type ContractLineShape, type PersistedContractLine,
} from './contracts';

const GUID = '11111111-1111-4111-8111-111111111111';

const VALID = {
  lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
  includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none',
} as const;

describe('hour_block — type registration (#4547 W03)', () => {
  it('is a contract line type and an allowance type, and matches the W01 constant', () => {
    expect(HOUR_BLOCK_LINE_TYPE).toBe('hour_block');
    expect(CONTRACT_LINE_TYPES).toContain('hour_block');
    expect(ALLOWANCE_LINE_TYPES).toContain('hour_block');
    expect([...ROLLOVER_POLICIES]).toEqual(['none', 'carry_forward']);
  });
});

describe('contractLineInputSchema — hour_block', () => {
  it('accepts the minimal valid block', () => {
    expect(contractLineInputSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts fractional hours (the integrality rule is exempt) while a device allowance stays whole', () => {
    expect(contractLineInputSchema.safeParse({ ...VALID, includedQuantity: '7.50' }).success).toBe(true);
    const device = contractLineInputSchema.safeParse({
      lineType: 'per_device', description: 'x', unitPrice: '1.00', taxable: false,
      includedQuantity: '7.5', overageMode: 'bill', overageUnitPrice: '2.00',
    });
    expect(device.success).toBe(false);
  });

  it('accepts carry_forward with a cap and an alert percentage', () => {
    const r = contractLineInputSchema.safeParse({ ...VALID, rolloverPolicy: 'carry_forward', rolloverCapHours: '5', hourBlockAlertPct: 80 });
    expect(r.success).toBe(true);
  });

  const REJECTED: Array<[string, Record<string, unknown>, string]> = [
    ['no included hours', { includedQuantity: undefined, overageMode: undefined, overageUnitPrice: undefined }, 'includedQuantity'],
    ['zero included hours', { includedQuantity: '0' }, 'includedQuantity'],
    ["overageMode 'flag'", { overageMode: 'flag', overageUnitPrice: undefined }, 'overageMode'],
    ['no overage mode', { overageMode: undefined, overageUnitPrice: undefined }, 'overageMode'],
    ['no overage price', { overageUnitPrice: undefined }, 'overageUnitPrice'],
    ['no rollover policy', { rolloverPolicy: undefined }, 'rolloverPolicy'],
    ['a cap under rollover none', { rolloverPolicy: 'none', rolloverCapHours: '5' }, 'rolloverCapHours'],
    ['a zero cap under carry_forward', { rolloverPolicy: 'carry_forward', rolloverCapHours: '0' }, 'rolloverCapHours'],
    ['alert 0', { hourBlockAlertPct: 0 }, 'hourBlockAlertPct'],
    ['alert 101', { hourBlockAlertPct: 101 }, 'hourBlockAlertPct'],
    ['a fractional alert', { hourBlockAlertPct: 80.5 }, 'hourBlockAlertPct'],
    ['a site', { siteId: GUID }, 'siteId'],
    ['device roles', { deviceRoles: ['server'] }, 'deviceRoles'],
    ['a device group', { deviceGroupId: GUID }, 'deviceGroupId'],
    ['a manual quantity', { manualQuantity: '1.00' }, 'manualQuantity'],
  ];
  it.each(REJECTED)('rejects %s', (_name, patch, path) => {
    const r = contractLineInputSchema.safeParse({ ...VALID, ...patch });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path[0])).toContain(path);
  });

  it('rejects an unknown rollover policy', () => {
    expect(contractLineInputSchema.safeParse({ ...VALID, rolloverPolicy: 'forever' }).success).toBe(false);
  });

  it('rejects block-only fields on every other line type', () => {
    for (const extra of [{ rolloverPolicy: 'none' }, { rolloverCapHours: '5' }, { hourBlockAlertPct: 50 }]) {
      const flat = contractLineInputSchema.safeParse({ lineType: 'flat', description: 'x', unitPrice: '1.00', taxable: false, ...extra });
      expect(flat.success).toBe(false);
      const seat = contractLineInputSchema.safeParse({ lineType: 'per_seat', description: 'x', unitPrice: '1.00', taxable: false, ...extra });
      expect(seat.success).toBe(false);
    }
  });

  it('never accepts the server-stamped columns: create strips them, they never reach the parsed output', () => {
    const r = contractLineInputSchema.safeParse({
      ...VALID, hourBlockFirstPeriodStart: '2020-01-01', hourBlockRetiredAt: '2020-01-01T00:00:00Z',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty('hourBlockFirstPeriodStart');
      expect(r.data).not.toHaveProperty('hourBlockRetiredAt');
    }
  });
});

describe('updateContractLineSchema — hour_block', () => {
  it('accepts the three patchable block fields, nullable only where clearing leaves a valid row', () => {
    expect(updateContractLineSchema.safeParse({ rolloverPolicy: 'carry_forward' }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ rolloverCapHours: '12.5' }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ rolloverCapHours: null }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ hourBlockAlertPct: null }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ hourBlockAlertPct: 90 }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ rolloverPolicy: null }).success).toBe(false);
    expect(updateContractLineSchema.safeParse({ hourBlockAlertPct: 0 }).success).toBe(false);
  });

  it('rejects the server-stamped columns and lineType (strict schema)', () => {
    expect(updateContractLineSchema.safeParse({ hourBlockFirstPeriodStart: '2020-01-01' }).success).toBe(false);
    expect(updateContractLineSchema.safeParse({ hourBlockRetiredAt: '2020-01-01T00:00:00Z' }).success).toBe(false);
    expect(updateContractLineSchema.safeParse({ lineType: 'hour_block' }).success).toBe(false);
  });
});

describe('contractLineInvariantIssues — create and persisted agree on a block', () => {
  const SHAPES: Array<[string, ContractLineShape]> = [
    ['valid none', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none' }],
    ['valid carry + cap + alert', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'carry_forward', rolloverCapHours: '4', hourBlockAlertPct: 75 }],
    ['cap under none', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none', rolloverCapHours: '4' }],
    ['flag mode', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'flag', rolloverPolicy: 'none' }],
    ['no policy', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00' }],
    ['alert 101', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none', hourBlockAlertPct: 101 }],
    ['manual quantity', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none', manualQuantity: '1.00' }],
    ['block field on flat', { lineType: 'flat', rolloverPolicy: 'none' }],
  ];
  it.each(SHAPES)('%s', (_name, shape) => {
    const create = contractLineInvariantIssues(shape, { mode: 'create' }).map((i) => `${i.path}:${i.message}`).sort();
    const persisted = contractLineInvariantIssues(shape, { mode: 'persisted' }).map((i) => `${i.path}:${i.message}`).sort();
    expect(persisted).toEqual(create);
  });

  it('a valid block has no issues in either mode', () => {
    const shape: ContractLineShape = { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none' };
    expect(contractLineInvariantIssues(shape, { mode: 'create' })).toEqual([]);
    expect(contractLineInvariantIssues(shape, { mode: 'persisted' })).toEqual([]);
  });
});

describe('mergeContractLinePatch — block columns', () => {
  const current: PersistedContractLine = {
    lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false, catalogItemId: null,
    manualQuantity: null, siteId: null, siteName: null, deviceRoles: null, deviceGroupId: null, deviceGroupName: null,
    sortOrder: 0, includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00',
    rolloverPolicy: 'carry_forward', rolloverCapHours: '4.00', hourBlockAlertPct: 80,
  };

  it('leaves the block columns alone when the patch does not name them', () => {
    expect(mergeContractLinePatch(current, { description: 'Renamed' } as never)).toMatchObject({
      rolloverPolicy: 'carry_forward', rolloverCapHours: '4.00', hourBlockAlertPct: 80,
    });
  });

  it('null clears the cap and the alert; a value replaces them', () => {
    const cleared = mergeContractLinePatch(current, { rolloverCapHours: null, hourBlockAlertPct: null } as never);
    expect(cleared.rolloverCapHours).toBeNull();
    expect(cleared.hourBlockAlertPct).toBeNull();
    expect(mergeContractLinePatch(current, { rolloverCapHours: '9' } as never).rolloverCapHours).toBe('9');
  });

  it('persisted parity: switching to none while a cap is set is a 400-shaped issue on the MERGED row', () => {
    const merged = mergeContractLinePatch(current, { rolloverPolicy: 'none' } as never);
    const issues = contractLineInvariantIssues(merged, { mode: 'persisted' });
    expect(issues.map((i) => i.path)).toContain('rolloverCapHours');
    const fixed = mergeContractLinePatch(current, { rolloverPolicy: 'none', rolloverCapHours: null } as never);
    expect(contractLineInvariantIssues(fixed, { mode: 'persisted' })).toEqual([]);
  });

  it('persisted parity: clearing the included hours or leaving bill mode is rejected', () => {
    expect(contractLineInvariantIssues(mergeContractLinePatch(current, { includedQuantity: null } as never), { mode: 'persisted' }).length).toBeGreaterThan(0);
    expect(contractLineInvariantIssues(mergeContractLinePatch(current, { overageMode: 'flag', overageUnitPrice: null } as never), { mode: 'persisted' }).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/contracts.hourBlock.test.ts`
Expected: FAIL — `hour_block` is not in the tuples (`lineType` enum error), the new schema keys are stripped/unknown, the merge does not carry the fields.

- [ ] **Step 3: Implement**

In `packages/shared/src/validators/contracts.ts`:

1. Replace the two tuples (`:17`, `:29`). Use the literal (W01's constant is asserted equal by the test above):

```ts
export const CONTRACT_LINE_TYPES = ['flat', 'per_device', 'per_device_role', 'per_device_group', 'per_seat', 'manual', 'hour_block'] as const;
```
```ts
export const ALLOWANCE_LINE_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat', 'hour_block'] as const;
```
Update the comment above `ALLOWANCE_LINE_TYPES`: replace "#4547's hour_block joins this set." with "`hour_block` (#4547) is in this set: its included hours live in `included_quantity`, its extra-hours price in `overage_unit_price`, and it is the only member exempt from the whole-number rule below."

2. Extend `ContractLineShape` (after `overageUnitPrice?`, `:58`):

```ts
  // #4547 W03: block-hours columns. NULL together on every non-block type
  // (contract_lines_hour_block_chk ELSE branch). Typed `string | null`, not
  // RolloverPolicy, so a Drizzle `text` row is assignable; the invariant table
  // checks membership. hour_block_first_period_start and hour_block_retired_at
  // are deliberately NOT here: they are server-stamped and never client input.
  rolloverPolicy?: string | null;
  rolloverCapHours?: string | null;
  hourBlockAlertPct?: number | null;
```

3. In `contractLineInvariantIssues`, add `const isBlock = l.lineType === 'hour_block';` next to `isGroupLine`, and make three edits:

 a. The manualQuantity branch — a block rejects it in **both** modes (create tolerates it on pre-existing types only because the add writer nulls it, `:904`-era comment; a new type has no legacy to protect):

```ts
  } else if (!isManual && (opts.mode === 'persisted' || isBlock) && present(l.manualQuantity)) {
```
 b. The integrality rule:

```ts
  // Hours are fractional; devices and seats are whole.
  if (!isBlock && present(l.includedQuantity) && !Number.isInteger(Number(l.includedQuantity))) {
```
 and delete the `(#4547 scopes this rule …)` sentence from the comment above it.
 c. Immediately before `return issues;` add the block rows (twin of `contract_lines_hour_block_chk`, identical in both modes):

```ts
  // ---- #4547 W03: hour_block -------------------------------------------------
  // Twin of contract_lines_hour_block_chk (index C2). IDENTICAL IN BOTH MODES.
  // site / roles / group / manualQuantity are already rejected for a block by
  // the rules above (it is in neither SITE_SCOPABLE_LINE_TYPES, nor a role nor a
  // group line, and manualQuantity is rejected explicitly).
  if (isBlock) {
    if (!present(l.includedQuantity)) {
      issues.push({ path: 'includedQuantity', message: 'includedQuantity (hours per period) is required on hour_block lines' });
    }
    // Open Decision 10 (A): 'bill' only. A 'flag' block would silently absorb unlimited hours.
    if (l.overageMode !== 'bill') {
      issues.push({ path: 'overageMode', message: "hour_block lines must use overageMode 'bill'" });
    }
    if (!present(l.rolloverPolicy)) {
      issues.push({ path: 'rolloverPolicy', message: 'rolloverPolicy is required on hour_block lines' });
    } else if (!(ROLLOVER_POLICIES as readonly string[]).includes(l.rolloverPolicy as string)) {
      issues.push({ path: 'rolloverPolicy', message: "rolloverPolicy must be 'none' or 'carry_forward'" });
    }
    if (present(l.rolloverCapHours)) {
      if (l.rolloverPolicy !== 'carry_forward') {
        issues.push({ path: 'rolloverCapHours', message: "rolloverCapHours is only valid with rolloverPolicy 'carry_forward'" });
      }
      if (!(Number(l.rolloverCapHours) > 0)) {
        issues.push({ path: 'rolloverCapHours', message: 'rolloverCapHours must be greater than 0' });
      }
    }
    if (present(l.hourBlockAlertPct)) {
      const pct = l.hourBlockAlertPct as number;
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
        issues.push({ path: 'hourBlockAlertPct', message: 'hourBlockAlertPct must be a whole number from 1 to 100' });
      }
    }
  } else {
    if (present(l.rolloverPolicy)) issues.push({ path: 'rolloverPolicy', message: 'rolloverPolicy is only valid on hour_block lines' });
    if (present(l.rolloverCapHours)) issues.push({ path: 'rolloverCapHours', message: 'rolloverCapHours is only valid on hour_block lines' });
    if (present(l.hourBlockAlertPct)) issues.push({ path: 'hourBlockAlertPct', message: 'hourBlockAlertPct is only valid on hour_block lines' });
  }
```

4. `contractLineInputSchema` (after `overageUnitPrice`, `:213`):

```ts
  // #4547 W03: block hours. The server-stamped hour_block_first_period_start /
  // hour_block_retired_at are NOT fields here (non-strict object: a client-sent
  // value is stripped, never persisted).
  rolloverPolicy: z.enum(ROLLOVER_POLICIES).optional(),
  rolloverCapHours: money.optional(),
  hourBlockAlertPct: z.number().int().min(1).max(100).optional(),
```

5. `updateContractLineSchema` (after `overageUnitPrice`, `:282`):

```ts
  // #4547 W03: the three patchable block fields. Nullable only where clearing
  // leaves a valid row (a cap, an alert); the policy is required on a block, so
  // it has no null. hour_block_first_period_start / hour_block_retired_at stay
  // out: this schema is .strict(), so naming them is a 400, never a silent drop.
  rolloverPolicy: z.enum(ROLLOVER_POLICIES).optional(),
  rolloverCapHours: money.nullable().optional(),
  hourBlockAlertPct: z.number().int().min(1).max(100).nullable().optional(),
```

6. `mergeContractLinePatch` (after the `overageUnitPrice` line, `:354`):

```ts
    // #4547 W03: policy is never cleared (no null in the patch schema); the cap
    // and the alert are tri-state like the allowance columns above.
    rolloverPolicy: patch.rolloverPolicy ?? current.rolloverPolicy,
    rolloverCapHours: patchHasKey(patch, 'rolloverCapHours') ? (patch.rolloverCapHours ?? null) : current.rolloverCapHours,
    hourBlockAlertPct: patchHasKey(patch, 'hourBlockAlertPct') ? (patch.hourBlockAlertPct ?? null) : current.hourBlockAlertPct,
```

7. In `packages/shared/src/validators/quotes.test.ts:579-581` replace the assertion:

```ts
  it('QUOTE_DEVICE_SET_TYPES equals ALLOWANCE_LINE_TYPES minus hour_block', () => {
    // A quote line cannot express a block (quoteToContract.ts is unchanged by #4547):
    // block hours are created on the contract, never accepted from a quote.
    expect([...QUOTE_DEVICE_SET_TYPES]).toEqual([...ALLOWANCE_LINE_TYPES].filter((t) => t !== 'hour_block'));
  });
```

- [ ] **Step 3b: Remove W01's now-false tests** (they assert the opposite of this wave). In `packages/shared/src/validators/contracts.test.ts`, inside `describe('hour_block constants (#4547 W01)')`:
  - **DELETE** `it('does NOT add hour_block to CONTRACT_LINE_TYPES or ALLOWANCE_LINE_TYPES until W03', …)` — inverted by `contracts.hourBlock.test.ts` > `hour_block — type registration`.
  - **DELETE** `it('the line input schema still rejects hour_block, so no API can create one', …)` — inverted by `contractLineInputSchema — hour_block` > `accepts the minimal valid block`.
  - **KEEP** `it('exports the line-type literal and the rollover policies', …)`.
  - Remove `CONTRACT_LINE_TYPES, ALLOWANCE_LINE_TYPES,` from that file's import block if nothing else in the file uses them (lint).

- [ ] **Step 4: Run to verify it passes, then the neighbours**

Run: `cd packages/shared && npx vitest run src/validators/contracts.hourBlock.test.ts src/validators/contracts.test.ts src/validators/quotes.test.ts`
Expected: PASS, 3 files. Then `cd packages/shared && npx tsc --noEmit -p .` (exit 0).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/contracts.ts packages/shared/src/validators/contracts.hourBlock.test.ts packages/shared/src/validators/quotes.test.ts
git commit -m "feat(billing): accept hour_block contract lines in shared validators (#4547)

Adds the block line type to the line and allowance tuples, the three
patchable block fields, the block invariant rows (twin of the DB check, same
in create and persisted modes) and merge support. Server-stamped columns stay
out of every input schema.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Period helpers — `todayISO` and `firstUnclaimedPeriodStart`

**Files:**
- Modify: `apps/api/src/services/contractMath.ts`
- Modify: `apps/api/src/services/contractMath.test.ts`
- Modify: `apps/api/src/services/contractService.ts` (delete the private `todayISO`, `:1811-1813`, import it)

**Interfaces:**
- Produces:
  ```ts
  /** UTC calendar date of `asOf`. There is no contract-local date (contracts carry no timezone). */
  export function todayISO(asOf?: Date): string;
  /**
   * Index C9 (refined): the first period whose block fee has NOT yet been claimed.
   * Returns null for a non-draft contract with no billing pointer (the caller turns that into a typed error).
   */
  export function firstUnclaimedPeriodStart(c: {
    status: string; startDate: string; intervalMonths: number;
    billingTiming: 'advance' | 'arrears'; nextBillingAt: string | null;
  }): string | null;
  /**
   * I3: `candidate` may already be claimed (pause -> resume on an advance contract resets the pointer
   * onto a period that was claimed before the pause). Advance period by period until unclaimed.
   */
  export function advancePastClaimed(
    candidate: string, claimedStarts: ReadonlySet<string>, startDate: string, intervalMonths: number,
  ): string;
  ```
- Consumes: `computePeriod` / `periodIndexFor` (`contractMath.ts:30`, `:37`) — **deliberately not** `duePeriodStartFor`: its arrears branch is `addMonthsClamped(nextBillingAt, -interval)`, and month-end starts do not round-trip (a 03-31 monthly contract: `04-30` minus one month is `03-30`, not the real period start `03-31`). `nextBillingAt` is always a period boundary, so `periodIndexFor` finds its index exactly and `computePeriod` rebuilds the true boundary.

Why this rule (it replaces the first draft's "first period starting on or after today"): entitlement must start exactly where the fee starts. On an advance contract the current period was claimed without the fee, so the block starts at the next period. On an arrears contract the period in progress is billed at its end **with** the fee, so the block starts there. A draft has claimed nothing yet; its provisional stamp is the first period, and `activateContract` re-stamps it (Task 3) to the period activation really claims.

- [ ] **Step 1: Write the failing tests** — append to `contractMath.test.ts`:

```ts
import { advancePastClaimed, firstUnclaimedPeriodStart, todayISO } from './contractMath';

describe('todayISO (#4547 W03)', () => {
  it('is the UTC calendar date', () => {
    expect(todayISO(new Date('2026-10-06T23:59:59Z'))).toBe('2026-10-06');
    expect(todayISO(new Date('2026-10-07T00:00:00Z'))).toBe('2026-10-07');
  });
});

describe('firstUnclaimedPeriodStart — index C9 (#4547 W03)', () => {
  const c = (over: Record<string, unknown>) => ({
    status: 'active', startDate: '2026-06-01', intervalMonths: 1, billingTiming: 'advance', nextBillingAt: '2026-07-01', ...over,
  }) as Parameters<typeof firstUnclaimedPeriodStart>[0];

  it.each([
    ['active advance, added mid-June (June already claimed without the fee) -> NEXT period', c({}), '2026-07-01'],
    ['active arrears, added mid-June (June is billed at its end WITH the fee) -> period IN PROGRESS', c({ billingTiming: 'arrears' }), '2026-06-01'],
    ['active quarterly advance', c({ intervalMonths: 3, nextBillingAt: '2026-10-01' }), '2026-10-01'],
    ['active quarterly arrears', c({ intervalMonths: 3, billingTiming: 'arrears', nextBillingAt: '2026-10-01' }), '2026-07-01'],
    ['draft: provisional stamp is the first period', c({ status: 'draft', nextBillingAt: null }), '2026-06-01'],
    ['draft with a past start date is still its first period (activation re-stamps it)', c({ status: 'draft', startDate: '2025-01-01', nextBillingAt: null }), '2025-01-01'],
    ['draft ignores a stale pointer', c({ status: 'draft', nextBillingAt: '2026-09-01' }), '2026-06-01'],
    ['active with no pointer cannot be stamped', c({ nextBillingAt: null }), null],
    // S5: month-end starts. Periods of a 03-31 monthly contract: 03-31, 04-30, 05-31, 06-30 (each from the START date).
    ['03-31 monthly ARREARS, pointer 04-30: the period in progress starts 03-31 (duePeriodStartFor would say 03-30)', c({ startDate: '2026-03-31', billingTiming: 'arrears', nextBillingAt: '2026-04-30' }), '2026-03-31'],
    ['03-31 monthly ARREARS, pointer 05-31: period in progress starts 04-30', c({ startDate: '2026-03-31', billingTiming: 'arrears', nextBillingAt: '2026-05-31' }), '2026-04-30'],
    ['03-31 monthly ADVANCE, pointer 04-30: the next period', c({ startDate: '2026-03-31', nextBillingAt: '2026-04-30' }), '2026-04-30'],
  ])('%s', (_name, contract, expected) => {
    expect(firstUnclaimedPeriodStart(contract)).toBe(expected);
  });
});

describe('advancePastClaimed — pause -> resume lands the pointer on a claimed period (#4547 W03, I3)', () => {
  it.each([
    ['unclaimed candidate is returned as is', '2026-07-01', [], '2026-07-01'],
    ['one claimed period (June claimed before the pause) -> July', '2026-06-01', ['2026-06-01'], '2026-07-01'],
    ['two consecutive claimed periods -> August', '2026-06-01', ['2026-06-01', '2026-07-01'], '2026-08-01'],
    ['a claimed period later than the gap does not matter', '2026-06-01', ['2026-08-01'], '2026-06-01'],
  ])('%s', (_name, candidate, claimed, expected) => {
    expect(advancePastClaimed(candidate as string, new Set(claimed as string[]), '2026-06-01', 1)).toBe(expected);
  });

  it('walks month-end boundaries from the START date (03-31 contract)', () => {
    expect(advancePastClaimed('2026-03-31', new Set(['2026-03-31']), '2026-03-31', 1)).toBe('2026-04-30');
    expect(advancePastClaimed('2026-03-31', new Set(['2026-03-31', '2026-04-30']), '2026-03-31', 1)).toBe('2026-05-31');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractMath.test.ts`
Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Implement** — add to `contractMath.ts` (after `duePeriodStartFor`):

```ts
/** UTC calendar date of `asOf`. Contracts carry no timezone, so every "today" in
 *  the billing code is UTC (the claim query and the hour-block boundaries use the
 *  same convention). */
export function todayISO(asOf: Date = new Date()): string {
  return asOf.toISOString().slice(0, 10);
}

/**
 * Index C9: the first period whose block-hours fee has not yet been claimed, i.e.
 * where entitlement starts because the fee starts. Active: the period the billing
 * pointer will claim next (advance: the next period; arrears: the period in
 * progress). Draft: nothing is claimed, so the first period — provisional until
 * activateContract re-stamps it. Null when a non-draft contract has no pointer.
 *
 * Built from computePeriod/periodIndexFor, NOT duePeriodStartFor: `nextBillingAt`
 * is always a period boundary, so periodIndexFor returns its exact index k; the
 * pointer is period k's START (advance) or END (arrears, so the period in
 * progress is k-1). addMonthsClamped(nextBillingAt, -interval) would mis-derive
 * month-end starts. This is the PURE candidate; the caller must still walk it past
 * periods that are already claimed (advancePastClaimed) — a pause -> resume resets
 * an advance pointer onto a claimed period.
 */
export function firstUnclaimedPeriodStart(c: {
  status: string; startDate: string; intervalMonths: number;
  billingTiming: BillingTiming; nextBillingAt: string | null;
}): string | null {
  if (c.status === 'draft') return c.startDate;
  if (c.nextBillingAt === null) return null;
  const k = periodIndexFor(c.startDate, c.intervalMonths, c.nextBillingAt);
  const idx = c.billingTiming === 'arrears' ? Math.max(0, k - 1) : k;
  return computePeriod(c.startDate, c.intervalMonths, idx).periodStart;
}

/** `candidate` is a period boundary; step forward one period at a time while it is in `claimedStarts`. */
export function advancePastClaimed(
  candidate: string, claimedStarts: ReadonlySet<string>, startDate: string, intervalMonths: number,
): string {
  let idx = periodIndexFor(startDate, intervalMonths, candidate);
  let start = computePeriod(startDate, intervalMonths, idx).periodStart;
  for (let guard = 0; claimedStarts.has(start) && guard < 100000; guard++) {
    idx += 1;
    start = computePeriod(startDate, intervalMonths, idx).periodStart;
  }
  return start;
}
```
(`BillingTiming` is already imported at the top of the file.)

In `contractService.ts`: delete the private `function todayISO(...)` (`:1811-1813`) and add `todayISO` to the existing `contractMath` import (`:17`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/contractMath.test.ts src/services/contractService.test.ts`
Expected: PASS (2 files; `contractService.test.ts` proves the `todayISO` move did not change behaviour).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractMath.ts apps/api/src/services/contractMath.test.ts apps/api/src/services/contractService.ts
git commit -m "feat(billing): period helper for where block-hours entitlement starts (#4547)

Exports todayISO from contractMath and adds firstUnclaimedPeriodStart (the
pure rule index C9 stamps on a block line: the first period whose block fee
has not been claimed yet, derived from period boundaries rather than a month
subtraction) and advancePastClaimed for a pointer that landed on a claimed
period.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Service — add a block line (stamp, typed 409, fee-only quantity, quote path) and the re-stamp on activation

**Files:**
- Modify: `apps/api/src/services/contractTypes.ts`
- Modify: `apps/api/src/services/contractService.ts`
- Create: `apps/api/src/services/contractService.hourBlock.test.ts`

**Interfaces:**
- Produces: `ContractServiceErrorCode` gains `'HOUR_BLOCK_EXISTS'` (409) and `'HOUR_BLOCK_FIELD_LOCKED'` (400) — both map through the existing `handleContractError` (`routes/contracts/contracts.ts:46-53`), which echoes `err.status` and `code`; **no route change is needed** for the mapping.
- Consumes: `firstUnclaimedPeriodStart`, `advancePastClaimed` (Task 2), `nextBillingDate` / `periodIndexFor` (already imported by `contractService.ts`), `contractBillingPeriods` (already imported); `isPgUniqueViolation` from `../utils/pgErrors`; W01's Drizzle columns on `contractLines`.

Verified facts: `allowanceColumnsFor` (`:624-637`) is keyed on `ALLOWANCE_LINE_TYPE_SET` (built from the shared tuple), so Task 1's tuple change makes it pass `includedQuantity`/`overageMode`/`overageUnitPrice` through for a block with **no edit**. `assertRepresentable(allowance.overageUnitPrice, …)` already runs on the add path (`:1596`) and on the quote path (`:2255-2260`). The live-block index name is `contract_lines_one_live_hour_block_per_org_uq` (C2).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/contractService.hourBlock.test.ts`. The harness is the same controllable Drizzle chain `contractService.test.ts:1-60` uses; copy it verbatim (it is a per-file `vi.mock('../db')`), then:

```ts
vi.mock('./autopay/autopayGate', () => ({ isAutopayEnabledForPartner: vi.fn().mockResolvedValue(false) }));
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type QueuedQuery = { rows: unknown[] } | { error: unknown };
const results: QueuedQuery[] = [];
function queueResult(rows: unknown[]) { results.push({ rows }); }
function queueError(error: unknown) { results.push({ error }); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const result = results.shift() ?? { rows: [] };
      return 'error' in result ? reject(result.error) : resolve(result.rows);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db, assertInTransaction: vi.fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: vi.fn(),
  };
});
vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./invoiceService', () => ({ createManualInvoice: vi.fn(), addContractLine: vi.fn(), deleteDraftInvoice: vi.fn() }));
vi.mock('./contractQuantities', () => ({
  countContractDevices: vi.fn(), countContractSeats: vi.fn(), snapshotContractDevices: vi.fn(), groupMembersForBilling: vi.fn(),
}));
vi.mock('./contractHourBlockEstimate', () => ({ computeOpenHourBlockPeriod: vi.fn() }));

import * as svc from './contractService';
import { db } from '../db';

type Chain = { values: { mock: { calls: unknown[][] } }; delete: { mock: { calls: unknown[][] } }; set: { mock: { calls: unknown[][] } } };
const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

const BLOCK_INPUT = {
  lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
  includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'carry_forward',
  rolloverCapHours: '4', hourBlockAlertPct: 80,
} as never;

const contractRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1', status: 'active', orgId: 'org1', partnerId: 'p1', name: 'Acme MSA', currencyCode: 'USD',
  startDate: '2026-06-01', intervalMonths: 1, billingTiming: 'advance', nextBillingAt: '2026-07-01', ...over,
});

describe('addContractLineToContract — hour_block (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  /** `claimed`: contract_billing_periods rows at/after the candidate (only an ACTIVE contract is asked). */
  const addAndRead = async (contract: Record<string, unknown>, claimed: Array<{ periodStart: string }> = []) => {
    queueResult([contractRow(contract)]);                                                  // lockContract
    if (contract.status !== 'draft') queueResult(claimed);                                 // claimed periods >= candidate
    queueResult([{ id: 'l1', contractId: 'c1', orgId: 'org1', lineType: 'hour_block' }]);  // insert returning
    await svc.addContractLineToContract('c1', BLOCK_INPUT, actor);
    return (db as unknown as Chain).values.mock.calls[0]![0];
  };

  it('writes the block columns and nulls everything a block must not carry', async () => {
    expect(await addAndRead({})).toMatchObject({
      lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00',
      rolloverPolicy: 'carry_forward', rolloverCapHours: '4', hourBlockAlertPct: 80, hourBlockRetiredAt: null,
      siteId: null, deviceRoles: null, deviceGroupId: null, manualQuantity: null,
    });
  });

  it('active ADVANCE contract mid-period: starts at the NEXT period (the current one was claimed without the fee)', async () => {
    // June was claimed at its start; nextBillingAt points at July.
    expect(await addAndRead({ status: 'active', billingTiming: 'advance', nextBillingAt: '2026-07-01' }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-07-01' });
  });

  it('active ARREARS contract mid-period: starts at the period IN PROGRESS (its fee is billed at its end)', async () => {
    // June is accruing; arrears bills it on 2026-07-01 with this line on it.
    expect(await addAndRead({ status: 'active', billingTiming: 'arrears', nextBillingAt: '2026-07-01' }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-06-01' });
  });

  it('active quarterly arrears: the quarter in progress', async () => {
    expect(await addAndRead({ intervalMonths: 3, billingTiming: 'arrears', nextBillingAt: '2026-10-01' }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-07-01' });
  });

  it('03-31 contract, arrears, pointer 04-30: the period in progress starts 03-31 (no month-subtraction drift)', async () => {
    expect(await addAndRead({ startDate: '2026-03-31', billingTiming: 'arrears', nextBillingAt: '2026-04-30' }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-03-31' });
  });

  it('PAUSE -> RESUME on an advance contract: the pointer was reset onto a period claimed before the pause, so the block starts at the first UNCLAIMED one', async () => {
    // resumeContract points nextBillingAt at the period containing today (June), which was claimed before the pause.
    expect(await addAndRead({ nextBillingAt: '2026-06-01' }, [{ periodStart: '2026-06-01' }]))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-07-01' });
    results.length = 0; (db as unknown as Chain).values.mock.calls.length = 0;
    // ...and two consecutive claimed periods walk two steps.
    expect(await addAndRead({ nextBillingAt: '2026-06-01' }, [{ periodStart: '2026-06-01' }, { periodStart: '2026-07-01' }]))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-08-01' });
  });

  it("draft: the provisional stamp is the contract's FIRST period, whatever today is (activation re-stamps it)", async () => {
    expect(await addAndRead({ status: 'draft', startDate: '2025-01-01', nextBillingAt: null }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2025-01-01' });
  });

  it('an active contract with no billing pointer is a typed 409, never a null stamp', async () => {
    queueResult([contractRow({ status: 'active', nextBillingAt: null })]);
    await expect(svc.addContractLineToContract('c1', BLOCK_INPUT, actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
    expect((db as unknown as Chain).values.mock.calls).toHaveLength(0);
  });

  it('writes NULL block columns for every other line type', async () => {
    queueResult([contractRow({ status: 'draft' })]);
    queueResult([{ id: 'l1', contractId: 'c1', orgId: 'org1' }]);
    await svc.addContractLineToContract('c1', { lineType: 'flat', description: 'x', unitPrice: '5.00', taxable: false } as never, actor);
    expect((db as unknown as Chain).values.mock.calls[0]![0]).toMatchObject({
      rolloverPolicy: null, rolloverCapHours: null, hourBlockAlertPct: null,
      hourBlockFirstPeriodStart: null, hourBlockRetiredAt: null,
    });
  });

  it('maps a 23505 on the live-block index to 409 HOUR_BLOCK_EXISTS (driver and Drizzle-wrapped shapes)', async () => {
    for (const err of [
      { code: '23505', constraint_name: 'contract_lines_one_live_hour_block_per_org_uq' },
      { cause: { code: '23505', constraint_name: 'contract_lines_one_live_hour_block_per_org_uq' } },
    ]) {
      results.length = 0;
      queueResult([contractRow({ status: 'draft' })]);
      queueError(err);
      await expect(svc.addContractLineToContract('c1', BLOCK_INPUT, actor))
        .rejects.toMatchObject({ code: 'HOUR_BLOCK_EXISTS', status: 409 });
    }
  });

  it('does NOT swallow a 23505 on any other constraint', async () => {
    queueResult([contractRow({ status: 'draft' })]);
    queueError({ code: '23505', constraint_name: 'contract_lines_pkey' });
    await expect(svc.addContractLineToContract('c1', BLOCK_INPUT, actor))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('rejects an overage price the contract currency cannot represent (before any insert)', async () => {
    queueResult([contractRow({ currencyCode: 'JPY' })]);
    await expect(svc.addContractLineToContract('c1', { ...(BLOCK_INPUT as object), unitPrice: '1000', overageUnitPrice: '150.50' } as never, actor))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as Chain).values.mock.calls).toHaveLength(0);
  });

  it('is a typed 400 (not a DB error) when an internal caller omits the rollover policy', async () => {
    queueResult([contractRow({ status: 'draft' })]);
    await expect(svc.addContractLineToContract('c1', { ...(BLOCK_INPUT as object), rolloverPolicy: undefined } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 400 });
    expect((db as unknown as Chain).values.mock.calls).toHaveLength(0);
  });
});

describe('activateContract — re-stamps a draft block to the period activation claims (#4547 W03, index C9)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const asOf = new Date('2026-06-15T12:00:00Z');
  const lineStamps = () => (db as unknown as Chain).set.mock.calls.map((c) => c[0] as Record<string, unknown>)
    .filter((v) => 'hourBlockFirstPeriodStart' in v);

  it.each([
    // [timing, startDate, expected first_period_start, why]
    ['advance', '2026-06-01', '2026-06-01', 'activation mid-June claims June immediately, WITH the fee -> June counts'],
    ['arrears', '2026-06-01', '2026-06-01', 'arrears claims June at its end with the fee -> June counts (the period in progress)'],
    ['advance', '2026-09-01', '2026-09-01', 'a draft that has not started yet: its first period'],
    ['arrears', '2026-09-01', '2026-09-01', 'same, arrears'],
    ['advance', '2026-01-01', '2026-06-01', 'long-past start date: June is the period activation claims, not January'],
    ['arrears', '2026-01-01', '2026-06-01', 'same, arrears'],
  ])('%s, start %s -> first period %s (%s)', async (billingTiming, startDate, expected) => {
    queueResult([contractRow({ status: 'draft', billingTiming, startDate, nextBillingAt: null })]); // lockContract
    queueResult([{ id: 'b1', lineType: 'hour_block' }, { id: 'f1', lineType: 'flat' }]);          // line ids
    queueResult([]);                                                                              // re-stamp update
    queueResult([contractRow({ status: 'active' })]);                                             // contracts update returning
    await svc.activateContract('c1', actor, asOf);
    expect(lineStamps()).toEqual([{ hourBlockFirstPeriodStart: expected }]);
  });

  it('touches no lines when the contract has no block line (no extra query)', async () => {
    queueResult([contractRow({ status: 'draft', nextBillingAt: null })]);
    queueResult([{ id: 'f1', lineType: 'flat' }]);
    queueResult([contractRow({ status: 'active' })]);
    await svc.activateContract('c1', actor, asOf);
    expect(lineStamps()).toEqual([]);
  });

  it('NEVER re-stamps on a paused -> active resume: periods already claimed must stay closable', async () => {
    queueResult([contractRow({ status: 'paused', nextBillingAt: null })]);
    queueResult([{ id: 'b1', lineType: 'hour_block' }]);
    queueResult([contractRow({ status: 'active' })]);
    await svc.activateContract('c1', actor, asOf);
    expect(lineStamps()).toEqual([]);
  });
});

describe('createContractWithLinesDetailed — the quote path rejects hour_block (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('rejects BEFORE the contract row is inserted, so no orphan draft is left behind', async () => {
    await expect(svc.createContractWithLinesDetailed({
      partnerId: 'p1', orgId: 'org1', name: 'From quote', billingTiming: 'advance', intervalMonths: 1,
      startDate: '2026-06-01', currencyCode: 'USD',
      lines: [{ lineType: 'hour_block', description: 'x', unitPrice: '1.00', taxable: false }],
    } as never)).rejects.toMatchObject({ code: 'INVALID_STATE', status: 400 });
    expect((db as unknown as Chain).values.mock.calls).toHaveLength(0);
  });
});

describe('estimate and MRR count the block fee once and never hours (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const blockLine = (over: Record<string, unknown> = {}) => ({
    id: 'b1', contractId: 'c1', orgId: 'org1', lineType: 'hour_block', description: 'Support block',
    unitPrice: '1000.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null,
    deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00',
    rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: null,
    hourBlockFirstPeriodStart: '2026-06-01', hourBlockRetiredAt: null, ...over,
  });

  it('computeContractEstimate: the block line is quantity 1, no allowance, no overage; period total is the fee only', async () => {
    queueResult([contractRow({ status: 'active' })]);              // getOwnedContractOr404
    queueResult([blockLine()]);                                     // lines
    const out = await svc.computeContractEstimate('c1', actor, undefined, { includeHourBlock: false });
    expect(out.lines[0]).toMatchObject({
      lineType: 'hour_block', quantity: 1, value: '1000.00', counted: 1, included: null, overage: 0,
      overageMode: null, overageValue: '0.00', live: false,
    });
    expect(out.periodTotal).toBe('1000.00');
    expect(out.overages).toEqual([]);
    expect(out.hourBlock).toBeNull();
  });

  it('a RETIRED block contributes nothing to the estimate or the contracts list', async () => {
    queueResult([contractRow({ status: 'active' })]);
    queueResult([blockLine({ hourBlockRetiredAt: new Date('2026-07-01T00:00:00Z') })]);
    const out = await svc.computeContractEstimate('c1', actor, undefined, { includeHourBlock: false });
    expect(out.lines[0]).toMatchObject({ quantity: 0, value: '0.00' });
    expect(out.periodTotal).toBe('0.00');
  });

  it('summarizeActiveContractMrrByOrg counts the fee once per period and never hours; a retired block counts zero', async () => {
    for (const [line, expected] of [[blockLine(), '1000.00'], [blockLine({ hourBlockRetiredAt: new Date('2026-07-01T00:00:00Z') }), '0.00']] as const) {
      results.length = 0;
      queueResult([{ id: 'c1', orgId: 'org1', status: 'active', currencyCode: 'USD', intervalMonths: 1, endDate: null, nextBillingAt: '2026-07-01', billingTiming: 'advance' }]);
      queueResult([line]);
      const out = await svc.summarizeActiveContractMrrByOrg(['org1'], new Date('2026-06-20T00:00:00Z'));
      const total = out.get('org1')?.find((r) => r.currencyCode === 'USD')?.amount ?? '0.00';
      expect(Number(total)).toBe(Number(expected));
    }
  });
});
```

(The MRR test's `?? '0.00'` covers the rollup omitting a zero-value org; the `Number(...)` equality is the assertion.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractService.hourBlock.test.ts`
Expected: FAIL — `hourBlockFirstPeriodStart` is not written, no `HOUR_BLOCK_EXISTS`, `computeContractEstimate` takes no 4th argument and throws `HOUR_BLOCK_NOT_ENABLED` (W01's fail-closed arm), `createContractWithLinesDetailed` inserts the contract first.

- [ ] **Step 3: Implement**

`contractTypes.ts` — extend `ContractServiceErrorCode` (after `'CATALOG_ITEM_NOT_FOUND'`, `:131`), and `ContractLineAudit` (`:146-157`):

```ts
  // #4547 W03 (index C10): a second live block-hours line for the organization
  // (409) / an edit of a field a block does not allow, or of a retired block (400).
  | 'HOUR_BLOCK_EXISTS'
  | 'HOUR_BLOCK_FIELD_LOCKED'
```
```ts
  /** #4547 W03: true when a remove retired a block-hours line (history exists)
   *  instead of deleting it. Absent for every other line and for add/update. */
  retired?: boolean;
```
`contractLineAuditDetails` (`contractService.ts:240-248`) gains `...(audit.retired !== undefined ? { retired: audit.retired } : {})`.

`contractService.ts`:

1. Imports: add `firstUnclaimedPeriodStart`, `advancePastClaimed` to the existing `contractMath` import (`todayISO` is already there from Task 2; `nextBillingDate`, `periodIndexFor` are already imported); add `gte` to the `drizzle-orm` import; `import { isPgUniqueViolation } from '../utils/pgErrors';` (the file already imports `pgErrorNode` from there — extend that import); add `isNull` to the `drizzle-orm` import.

2. `resolveLineQty` — add the arm before `default`:

```ts
    case 'hour_block': {
      // #4547 W03 (index C7, delta 8): FEE ONLY. The period's hours are closed by
      // the billing path (W02) and shown by the estimate's `hourBlock`; they must
      // never appear as an allowance overage here, because aiToolsBilling's
      // interactive "add contract line to invoice" reads this arm and would
      // materialize hours as quantity. A retired block bills nothing (W02's
      // generateDueInvoice skips it), so it must not promise a fee either.
      if (line.hourBlockRetiredAt !== null) {
        return { counted: 0, billed: 0, included: null, overage: 0, overageMode: null, live: false };
      }
      return { counted: 1, billed: 1, included: null, overage: 0, overageMode: null, live: false };
    }
```
**Delete W01's fail-closed arm in the same edit** (`2026-10-06-block-hours-w01-foundation.md` Task 3 Step 9(c)): the `case 'hour_block': throw hourBlockNotEnabled();` immediately before `default:` in `resolveLineQty` is *replaced* by the arm above — there must be exactly one `case 'hour_block'` in that switch. (`hourBlockNotEnabled()` stays: `generateDueInvoice`'s pre-flight still uses it until W02 replaces it.)

2b. Helper (next to `lockContractRow`):

```ts
/** Index C9: where a block's entitlement starts. Pure candidate from the billing pointer (Task 2),
 *  then walked past periods that are already claimed — a pause -> resume on an advance contract
 *  resets the pointer onto a claimed period. A draft has nothing claimed. Run under the contract lock. */
async function blockFirstPeriodStart(tx: DbExecutor, c: typeof contracts.$inferSelect): Promise<string> {
  const candidate = firstUnclaimedPeriodStart({
    status: c.status, startDate: c.startDate, intervalMonths: c.intervalMonths,
    billingTiming: c.billingTiming as 'advance' | 'arrears', nextBillingAt: c.nextBillingAt,
  });
  if (candidate === null) {
    throw new ContractServiceError('The contract has no billing pointer to start a block-hours line from', 409, 'INVALID_STATE');
  }
  if (c.status === 'draft') return candidate;
  const claimed = await tx.select({ periodStart: contractBillingPeriods.periodStart }).from(contractBillingPeriods)
    .where(and(eq(contractBillingPeriods.contractId, c.id), gte(contractBillingPeriods.periodStart, candidate)));
  return advancePastClaimed(candidate, new Set(claimed.map((r) => r.periodStart)), c.startDate, c.intervalMonths);
}
```

3. `addContractLineToContract` — after `const allowance = allowanceColumnsFor(input);` block and its `assertRepresentable`, add:

```ts
    // #4547 W03: block-hours columns (index C2). The first counted period is
    // server-stamped (C9) and never client input.
    const isBlock = input.lineType === 'hour_block';
    if (isBlock && !input.rolloverPolicy) {
      // Service-level backstop for internal callers; the shared validator already requires it.
      throw new ContractServiceError('rolloverPolicy is required on hour_block lines', 400, 'INVALID_STATE');
    }
    // C9 (refined): where entitlement starts = where the fee starts (see Task 2). Reads the
    // contract's claimed periods when the contract is active; runs inside the contract row lock.
    const firstPeriodStart = isBlock ? await blockFirstPeriodStart(tx, c) : null;
    const blockColumns = isBlock
      ? {
          rolloverPolicy: input.rolloverPolicy!,
          rolloverCapHours: input.rolloverCapHours ?? null,
          hourBlockAlertPct: input.hourBlockAlertPct ?? null,
          hourBlockFirstPeriodStart: firstPeriodStart,
          hourBlockRetiredAt: null,
        }
      : {
          rolloverPolicy: null, rolloverCapHours: null, hourBlockAlertPct: null,
          hourBlockFirstPeriodStart: null, hourBlockRetiredAt: null,
        };
```
spread `...blockColumns,` after `...allowance,` in the `values({...})`; and extend the `catch`:

```ts
    } catch (err) {
      if (isGroupFkViolation(err)) {
        throw new ContractServiceError('Device group does not belong to this organization', 400, 'GROUP_NOT_IN_ORG');
      }
      // The live-block index is the ONLY race-proof guard (two concurrent adds on
      // two contracts both pass any read-then-insert check). Open Decision 13 (A):
      // a draft contract's block counts too — the copy says retire the current one first.
      if (isPgUniqueViolation(err, HOUR_BLOCK_LIVE_INDEX)) {
        throw new ContractServiceError(
          'This organization already has an active block-hours line. Retire it first, then add the new one.',
          409, 'HOUR_BLOCK_EXISTS',
        );
      }
      throw err;
    }
```
with `const HOUR_BLOCK_LIVE_INDEX = 'contract_lines_one_live_hour_block_per_org_uq';` near `ALLOWANCE_LINE_TYPE_SET`.

4. `createContractWithLinesDetailed` — first statement of the function body:

```ts
  // #4547 W03 (index C7): a quote cannot express a block, and this path inserts
  // the contract row BEFORE its lines — reject first so no orphan draft remains.
  if (spec.lines.some((l) => (l.lineType as string) === 'hour_block')) {
    throw new ContractServiceError('Block-hours lines cannot be created from a quote', 400, 'INVALID_STATE');
  }
```

5. `ContractEstimate` + `computeContractEstimate` signature (the hour-block wiring itself is Task 6; the signature and the null default land now so the Task 3 tests compile and pass):

```ts
export interface ContractEstimate {
  …existing fields…
  /** #4547 W03 (C8): the OPEN block period, live; null when the contract has no
   *  live block line (or the caller opted out via includeHourBlock:false). */
  hourBlock: HourBlockEstimate | null;
}
```
```ts
export async function computeContractEstimate(
  contractId: string,
  actor: ContractActor,
  deviceEvidence?: Map<string, readonly DeviceSnapshotRow[]>,
  opts: { includeHourBlock?: boolean } = {},
): Promise<ContractEstimate> {
```
and `return { …, overages, hourBlock: null };` (Task 6 replaces the `null`). `HourBlockEstimate` is imported type-only from `@breeze/shared` — it is created in Task 6 Step 3; until then add the interface file (see Task 6) **in this step** so the import resolves: create `packages/shared/src/types/hourBlock.ts` now (code in Task 6 Step 3) and export it from `types/index.ts`.

6. `activateContract` (`contractService.ts:1815`) — re-stamp a **draft's** block lines in the same transaction. The lines read selects `lineType` too (`select({ id: contractLines.id, lineType: contractLines.lineType })`), so the extra statement only runs for a contract that has a block (existing activation tests, whose line rows carry no `lineType`, issue no new query). After `nextAt` is computed and before the `contracts` update:

```ts
    // #4547 W03 (index C9): entitlement starts where the fee starts. A draft's block was stamped
    // provisionally at add time (its first period); the period activation will actually claim is
    // duePeriodStartFor over the pointer set below. DRAFTS ONLY: a paused->active resume has
    // already-claimed periods behind it, and moving first_period_start forward would strand them.
    if (c.status === 'draft' && lineRows.some((l) => l.lineType === 'hour_block')) {
      await tx.update(contractLines)
        .set({
          // a draft has claimed nothing, so the pure candidate is already the first unclaimed period
          hourBlockFirstPeriodStart: firstUnclaimedPeriodStart({
            status: 'active', startDate: c.startDate, intervalMonths: c.intervalMonths,
            billingTiming: c.billingTiming as 'advance' | 'arrears', nextBillingAt: nextAt,
          })!,
        })
        .where(and(
          eq(contractLines.contractId, contractId),
          eq(contractLines.lineType, 'hour_block'),
          isNull(contractLines.hourBlockRetiredAt),
        ));
    }
```
The activation-claim arithmetic the tests pin: `idx = periodIndexFor(start, interval, today)`; advance -> `nextAt` = that period's start (due immediately, claimed with the fee); arrears -> `nextAt` = that period's end, so `firstUnclaimedPeriodStart` (computePeriod-based) returns the same period start. Hence both timings re-stamp to the period containing the activation day (or the first period if the contract has not started).

- [ ] **Step 3b: Remove W01's now-false test.** In `apps/api/src/services/contractService.test.ts`, `describe('hour_block fails closed until its engine ships (#4547 W01)')`: **DELETE** `it('computeContractEstimate (resolveLineQty) refuses a forged hour_block line', …)` — superseded by this task's `computeContractEstimate: the block line is quantity 1…` and the retired-line tests. (**Keep** the `generateDueInvoice refuses a forged hour_block line…` test: W02 owns it.) The `updateContractLine` test in the same describe is deleted in Task 4.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/contractService.hourBlock.test.ts src/services/contractService.test.ts src/services/contractCoverage.test.ts`
Expected: PASS, 3 files. If an existing `computeContractEstimate` assertion uses `toEqual` on the whole result, it now sees `hourBlock: null` — add that key to the expected object (it is the intended new shape). Then `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` (exit 0; the W01 fail-closed arm in `generateDueInvoice` is W02's, untouched).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractTypes.ts apps/api/src/services/contractService.ts apps/api/src/services/contractService.hourBlock.test.ts packages/shared/src/types/hourBlock.ts packages/shared/src/types/index.ts
git commit -m "feat(billing): create block-hours lines with a server-stamped first period (#4547)

Adds the block columns to the line writer (entitlement starts at the first
period whose fee is not yet claimed, re-stamped when a draft is activated),
maps the live-block unique index to a typed 409, makes the quantity resolver
fee-only (zero when retired), and refuses block lines on the quote path before
any insert.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Service — edit a block line (allowed and locked fields)

**Files:**
- Modify: `apps/api/src/services/contractService.ts` (`updateContractLine`, `AUDITED_LINE_COLUMNS`)
- Modify: `apps/api/src/services/contractService.hourBlock.test.ts`

**Interfaces:**
- Consumes: Task 1's merged-row invariants; Task 3's error codes.
- Produces: per index C7, patchable on a block: `description`, `unitPrice`, `taxable`, `includedQuantity`, `overageUnitPrice`, `rolloverPolicy`, `rolloverCapHours`, `hourBlockAlertPct` (and `sortOrder`, `catalogItemId`/`refreshCatalogPrice`, which the generic transition table already handles). Locked → 400 `HOUR_BLOCK_FIELD_LOCKED`: `siteId`, `deviceRoles`, `deviceGroupId`, `manualQuantity`, `overageMode` ≠ `'bill'`, and **every** patch of a retired block. `hour_block_first_period_start` / `hour_block_retired_at` are unreachable (strict schema, Task 1).

**Mid-period semantics (index Open Decision 15, default A):** editing `includedQuantity`, `overageUnitPrice`, `rolloverPolicy` or `rolloverCapHours` applies at the **next close**: the close (W02) reads the line as it is at close time, so the open period (and any claimed-but-unclosed one) is settled with the new values; periods already closed are frozen in `contract_hour_periods` and never move. `updateContractLine`'s existing docblock claim — "Edits affect FUTURE periods only, by construction" — is **false for a block** and must be amended in this task (Step 3 item 4). The editor says so on the form (`form.midPeriodEdit`, with the open period's dates), and the audit entry records before/after for the block columns (`blockChanges`, numbers and enum values only — no free text).

- [ ] **Step 1: Write the failing tests** — append to `contractService.hourBlock.test.ts`:

```ts
describe('updateContractLine — hour_block (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const blockRow = (over: Record<string, unknown> = {}) => ({
    id: 'b1', contractId: 'c1', orgId: 'org1', lineType: 'hour_block', description: 'Support block',
    unitPrice: '1000.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null, siteName: null,
    deviceRoles: null, deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00',
    rolloverPolicy: 'carry_forward', rolloverCapHours: '4.00', hourBlockAlertPct: 80,
    hourBlockFirstPeriodStart: '2026-07-01', hourBlockRetiredAt: null, ...over,
  });
  const lockAndRead = (line: Record<string, unknown>) => { queueResult([contractRow()]); queueResult([line]); };

  it.each([
    ['siteId', { siteId: '22222222-2222-4222-8222-222222222222' }],
    ['siteId (null)', { siteId: null }],
    ['deviceRoles', { deviceRoles: ['server'] }],
    ['deviceGroupId', { deviceGroupId: '22222222-2222-4222-8222-222222222222' }],
    ['manualQuantity', { manualQuantity: '1.00' }],
    ["overageMode 'flag'", { overageMode: 'flag' }],
    ['overageMode null', { overageMode: null }],
  ])('locks %s on a block', async (_name, patch) => {
    lockAndRead(blockRow());
    await expect(svc.updateContractLine('c1', 'b1', patch as never, actor))
      .rejects.toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED', status: 400 });
    expect((db as unknown as Chain).set.mock.calls).toHaveLength(0);
  });

  it("allows overageMode 'bill' re-sent unchanged (a form echoing the current value)", async () => {
    lockAndRead(blockRow());
    queueResult([blockRow({ description: 'Renamed' })]); // update returning (withLineRefs runs no query: no site/group ids)
    await svc.updateContractLine('c1', 'b1', { overageMode: 'bill', description: 'Renamed' } as never, actor);
    expect((db as unknown as Chain).set.mock.calls[0]![0]).toMatchObject({ description: 'Renamed', overageMode: 'bill' });
  });

  it('refuses every patch of a RETIRED block', async () => {
    lockAndRead(blockRow({ hourBlockRetiredAt: new Date('2026-07-10T00:00:00Z') }));
    await expect(svc.updateContractLine('c1', 'b1', { description: 'x' } as never, actor))
      .rejects.toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED', status: 400 });
    expect((db as unknown as Chain).set.mock.calls).toHaveLength(0);
  });

  it('persists the block columns and the audit records names AND before/after for them (Open Decision 15)', async () => {
    lockAndRead(blockRow());
    queueResult([blockRow({ includedQuantity: '12.00', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: 90 })]);
    const { audit } = await svc.updateContractLine('c1', 'b1',
      { includedQuantity: '12', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: 90 } as never, actor);
    expect((db as unknown as Chain).set.mock.calls[0]![0]).toMatchObject({
      includedQuantity: '12', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: 90,
    });
    expect(audit.changedFields).toEqual(expect.arrayContaining(['includedQuantity', 'rolloverPolicy', 'rolloverCapHours', 'hourBlockAlertPct']));
    expect(audit.changedFields).not.toContain('description');
    expect(audit.blockChanges).toEqual({
      includedQuantity: { before: '10.00', after: '12.00' },
      rolloverPolicy: { before: 'carry_forward', after: 'none' },
      rolloverCapHours: { before: '4.00', after: null },
      hourBlockAlertPct: { before: 80, after: 90 },
    });
    // the shared audit-detail builder carries it to every door (HTTP, partner API, AI)
    expect(svc.contractLineAuditDetails(audit)).toMatchObject({ blockChanges: audit.blockChanges });
  });

  it('a non-block edit carries no blockChanges (audit payloads for other lines are unchanged)', async () => {
    lockAndRead({ ...blockRow(), lineType: 'flat', includedQuantity: null, overageMode: null, overageUnitPrice: null, rolloverPolicy: null, rolloverCapHours: null, hourBlockAlertPct: null, hourBlockFirstPeriodStart: null });
    queueResult([{ ...blockRow(), lineType: 'flat', description: 'Renamed', includedQuantity: null, overageMode: null, overageUnitPrice: null, rolloverPolicy: null, rolloverCapHours: null, hourBlockAlertPct: null, hourBlockFirstPeriodStart: null }]);
    const { audit } = await svc.updateContractLine('c1', 'b1', { description: 'Renamed' } as never, actor);
    expect(audit).not.toHaveProperty('blockChanges');
  });

  it('a switch to rollover none that leaves the cap set is a 400 INVALID_LINE_PATCH naming the cap', async () => {
    lockAndRead(blockRow());
    await expect(svc.updateContractLine('c1', 'b1', { rolloverPolicy: 'none' } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400, details: { issues: expect.arrayContaining([expect.objectContaining({ path: 'rolloverCapHours' })]) } });
  });

  it('block fields on a non-block line are INVALID_LINE_PATCH, not a silent write', async () => {
    lockAndRead({ ...blockRow(), lineType: 'flat', includedQuantity: null, overageMode: null, overageUnitPrice: null, rolloverPolicy: null, rolloverCapHours: null, hourBlockAlertPct: null, hourBlockFirstPeriodStart: null });
    await expect(svc.updateContractLine('c1', 'b1', { rolloverPolicy: 'none' } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
  });

  it('clearing the included hours is INVALID_LINE_PATCH (the DB twin would reject the row)', async () => {
    lockAndRead(blockRow());
    await expect(svc.updateContractLine('c1', 'b1', { includedQuantity: null, overageUnitPrice: null } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractService.hourBlock.test.ts`
Expected: FAIL — no lock check, the block columns are not in `.set()`, no audit names.

- [ ] **Step 3: Implement** in `contractService.ts`:

0. **Delete W01's guard** (`2026-10-06-block-hours-w01-foundation.md` Task 3 Step 9(d)): remove the line `assertNotHourBlock(current);` that W01 added directly after the `LINE_NOT_FOUND` throw in `updateContractLine` — it is replaced by item 3 below (`if (current.lineType === 'hour_block') assertBlockPatchAllowed(current, patch);`). If no other `assertNotHourBlock(...)` call remains in `contractService.ts` (W01's Step 10 may have added read-site calls — `git grep -n assertNotHourBlock apps/api/src`), also delete the helper and the `type ContractLineType` import W01 added for it; if calls remain, leave the helper.

1. `AUDITED_LINE_COLUMNS` (`:215-219`) — append `'rolloverPolicy', 'rolloverCapHours', 'hourBlockAlertPct'`. Add the before/after record (Open Decision 15). In `contractTypes.ts`, `ContractLineAudit` gains

```ts
  /** #4547 W03: block lines only. Before/after of the columns a mid-period edit moves; the next close
   *  reads them. Numbers and enum values only — never free text (the audit no-free-text rule). */
  blockChanges?: Record<string, { before: string | number | null; after: string | number | null }>;
```
and `contractLineAuditDetails` (`contractService.ts:240-248`) gains `...(audit.blockChanges ? { blockChanges: audit.blockChanges } : {})`. In `diffLineAudit`, after `changedFields` is computed:

```ts
const BLOCK_AUDIT_COLUMNS = ['includedQuantity', 'overageUnitPrice', 'rolloverPolicy', 'rolloverCapHours', 'hourBlockAlertPct'] as const;
// …inside diffLineAudit, in the returned object:
    ...(after.lineType === 'hour_block'
      ? (() => {
          const moved = BLOCK_AUDIT_COLUMNS.filter((f) => changedFields.includes(f));
          if (moved.length === 0) return {};
          const v = (x: unknown): string | number | null => (x === null || x === undefined ? null : typeof x === 'number' ? x : String(x));
          return { blockChanges: Object.fromEntries(moved.map((f) => [f, { before: v(before[f]), after: v(after[f]) }])) };
        })()
      : {}),
```

2. Add the lock helper next to `isGroupFkViolation`:

```ts
/** Fields a block-hours line cannot take (index C7). The shared validator's
 *  invariants would also reject most of them on the merged row, but as the
 *  generic INVALID_LINE_PATCH; naming them HOUR_BLOCK_FIELD_LOCKED tells the
 *  caller this is a property of the line type, not a typo. A key present with
 *  any value — including null — counts, like the rest of the patch logic. */
const HOUR_BLOCK_LOCKED_KEYS = ['siteId', 'deviceRoles', 'deviceGroupId', 'manualQuantity'] as const;

function assertBlockPatchAllowed(
  current: { hourBlockRetiredAt: Date | string | null },
  patch: UpdateContractLineInput,
): void {
  if (current.hourBlockRetiredAt !== null) {
    throw new ContractServiceError('A retired block-hours line cannot be edited', 400, 'HOUR_BLOCK_FIELD_LOCKED', { fields: ['retired'] });
  }
  const locked: string[] = HOUR_BLOCK_LOCKED_KEYS.filter((k) => patchHasKey(patch, k));
  // Open Decision 10 (A): the mode stays 'bill'. Re-sending 'bill' is a no-op.
  if (patchHasKey(patch, 'overageMode') && patch.overageMode !== 'bill') locked.push('overageMode');
  if (locked.length > 0) {
    throw new ContractServiceError(
      `These fields cannot be changed on a block-hours line: ${locked.join(', ')}`,
      400, 'HOUR_BLOCK_FIELD_LOCKED', { fields: locked },
    );
  }
}
```

3. In `updateContractLine`, immediately after the `LINE_NOT_FOUND` throw (`:1672`):

```ts
    if (current.lineType === 'hour_block') assertBlockPatchAllowed(current, patch);
```
(`import type { RolloverPolicy } from '@breeze/shared'` — W01 exports it) and in the `.set({...})` (`:1744-1760`) add:

```ts
        // #4547 W03: NULL on every non-block line (the merge carries current
        // values, and the invariants above reject a block field on another type).
        rolloverPolicy: (merged.rolloverPolicy ?? null) as RolloverPolicy | null,   // the invariants above proved membership
        rolloverCapHours: merged.rolloverCapHours ?? null,
        hourBlockAlertPct: merged.hourBlockAlertPct ?? null,
```

4. Amend `updateContractLine`'s docblock: after "Edits affect FUTURE periods only, by construction rather than by a guard: invoice lines carry their own copies…" add: "EXCEPTION (#4547, Open Decision 15): on an `hour_block` line `includedQuantity`, `overageUnitPrice`, `rolloverPolicy` and `rolloverCapHours` are read by the close (W02) at close time, so an edit applies to the open period when it closes; closed periods are frozen in `contract_hour_periods`. The audit records before/after (`blockChanges`)."

- [ ] **Step 3b: Remove W01's now-false test.** In `apps/api/src/services/contractService.test.ts`, `describe('hour_block fails closed until its engine ships (#4547 W01)')`: **DELETE** `it('updateContractLine refuses to patch a forged hour_block line', …)` — inverted by this task's lock tests, which now patch a live block successfully and refuse only the locked fields. After this and Task 3's deletion, the describe keeps only the `generateDueInvoice` test (W02's to replace).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/contractService.hourBlock.test.ts src/services/contractService.test.ts`
Expected: PASS (2 files). The existing `updateContractLine` suite proves a non-block edit still writes the same columns plus three NULLs; if one asserts `toEqual` on the full `.set()` argument, add the three `null` keys.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.hourBlock.test.ts
git commit -m "feat(billing): edit rules for block-hours lines (#4547)

Patchable: price, hours, extra-hours price, rollover policy, cap, alert.
Locked with a typed code: site, roles, group, manual quantity, a non-bill
overage mode, and every field of a retired block.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Service — retire vs delete, history decoration, the three doors' DELETE response

**Files:**
- Modify: `apps/api/src/services/contractService.ts` (`removeContractLine`, `getContract`, `DecoratedContractLine`)
- Modify: `apps/api/src/routes/contracts/lines.ts`, `apps/api/src/routes/partnerApi/contracts.ts`, `apps/api/src/services/aiToolsContracts.ts`
- Modify: `apps/api/src/services/contractService.hourBlock.test.ts`, `apps/api/src/routes/contracts/contracts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** True when a block line has billing history: a ledger row for it, or ANY claimed
   *  period at or after its first_period_start. The SAME predicate drives retire-vs-delete
   *  and the UI's "retire" confirm copy, so the copy can never disagree with the action. */
  async function hourBlockHasHistory(tx: DbExecutor, line: { id: string; contractId: string; hourBlockFirstPeriodStart: string | null }): Promise<boolean>;
  ```
  `DecoratedContractLine` gains `hourBlockHasHistory?: boolean` (present on `hour_block` lines only). `removeContractLine` returns `ContractLineAudit` with `retired: true | false` **for block lines only** (absent for every other type, so existing audit assertions are unchanged). DELETE answers `{ data: { ok: true, retired: boolean } }` on all three doors.
- Consumes: `contractHourPeriods` (W01 Drizzle export), `contractBillingPeriods`.

Rule (index C7): a block line with ≥1 ledger row **or** any claimed period `>= first_period_start` is **retired** (`hour_block_retired_at = now()`); otherwise it is deleted. Retired lines are excluded from the live-block count by the index's `WHERE hour_block_retired_at IS NULL`. Re-retiring is a no-op (idempotent). Deleting a block with no history is safe: no `contract_hour_periods` row references it (`ON DELETE RESTRICT` is the backstop) and no `time_entries.contract_line_id` can point at it, because entries are stamped only by a close that writes a ledger row in the same transaction.

Why "claimed period ≥ first_period_start" and not only the ledger: on an advance contract the period is claimed at its **start**, but its ledger row appears only when the **next** claim closes it. Deleting in between would strand a claimed-but-unclosed period whose `not_billed` entries would then bill ad hoc — spec Decision 6 option C, which "must not ship".

- [ ] **Step 1: Write the failing tests** — append to `contractService.hourBlock.test.ts`:

```ts
describe('removeContractLine — retire vs delete (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'b1', lineType: 'hour_block', hourBlockFirstPeriodStart: '2026-07-01', hourBlockRetiredAt: null, ...over,
  });

  it('DELETES a block with no ledger row and no claimed period at or after its first period', async () => {
    queueResult([contractRow()]);   // lockContract
    queueResult([row()]);           // pre-read
    queueResult([]);                // history: no ledger row
    queueResult([]);                // history: no claimed period
    queueResult([]);                // delete
    const audit = await svc.removeContractLine('c1', 'b1', actor);
    expect(audit).toMatchObject({ contractLineId: 'b1', lineType: 'hour_block', retired: false });
    expect((db as unknown as Chain).delete.mock.calls).toHaveLength(1);
    expect((db as unknown as Chain).set.mock.calls).toHaveLength(0);
  });

  it('RETIRES a block that has a ledger row (and never deletes it)', async () => {
    queueResult([contractRow()]);
    queueResult([row()]);
    queueResult([{ id: 'hp1' }]);   // ledger row exists
    queueResult([]);                // update retired_at
    const audit = await svc.removeContractLine('c1', 'b1', actor);
    expect(audit).toMatchObject({ lineType: 'hour_block', retired: true });
    expect((db as unknown as Chain).delete.mock.calls).toHaveLength(0);
    // W02: a retired line's period closes iff generated_at <= retired_at, which compares transaction clocks —
    // so the stamp must be the DATABASE's now() (transaction time), never a JS Date from another clock.
    const set = (db as unknown as Chain).set.mock.calls[0]![0] as { hourBlockRetiredAt: unknown };
    expect(set.hourBlockRetiredAt).not.toBeInstanceOf(Date);
    expect(set.hourBlockRetiredAt).toHaveProperty('queryChunks');
  });

  it('RETIRES a block with a claimed-but-unclosed period (the advance-billing window)', async () => {
    queueResult([contractRow()]);
    queueResult([row()]);
    queueResult([]);                // no ledger row yet
    queueResult([{ id: 'cbp1' }]);  // but period >= first_period_start is claimed
    queueResult([]);
    const audit = await svc.removeContractLine('c1', 'b1', actor);
    expect(audit.retired).toBe(true);
    expect((db as unknown as Chain).delete.mock.calls).toHaveLength(0);
  });

  it('re-removing an already retired block is an idempotent no-op that does not move retired_at', async () => {
    queueResult([contractRow()]);
    queueResult([row({ hourBlockRetiredAt: new Date('2026-07-10T00:00:00Z') })]);
    const audit = await svc.removeContractLine('c1', 'b1', actor);
    expect(audit.retired).toBe(true);
    expect((db as unknown as Chain).set.mock.calls).toHaveLength(0);
    expect((db as unknown as Chain).delete.mock.calls).toHaveLength(0);
  });

  it('a non-block line is deleted exactly as before, with no history queries and no retired key', async () => {
    queueResult([contractRow()]);
    queueResult([{ id: 'l1', lineType: 'flat', hourBlockFirstPeriodStart: null, hourBlockRetiredAt: null }]);
    queueResult([]);
    const audit = await svc.removeContractLine('c1', 'l1', actor);
    expect(audit).not.toHaveProperty('retired');
    expect((db as unknown as Chain).delete.mock.calls).toHaveLength(1);
  });
});

describe('getContract — hourBlockHasHistory decoration (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  it('marks a retired block as having history without querying, and a live one by the same predicate', async () => {
    const live = { id: 'b1', contractId: 'c1', orgId: 'org1', lineType: 'hour_block', siteId: null, deviceGroupId: null, hourBlockFirstPeriodStart: '2026-07-01', hourBlockRetiredAt: null, sortOrder: 0 };
    const retired = { ...live, id: 'b2', hourBlockRetiredAt: new Date('2026-07-10T00:00:00Z') };
    const flat = { id: 'f1', contractId: 'c1', orgId: 'org1', lineType: 'flat', siteId: null, deviceGroupId: null, hourBlockFirstPeriodStart: null, hourBlockRetiredAt: null, sortOrder: 1 };
    queueResult([contractRow()]);          // getOwnedContractOr404
    queueResult([live, retired, flat]);    // lines
    queueResult([]);                       // periods
    queueResult([{ id: 'hp1' }]);          // live block: ledger row exists
    const out = await svc.getContract('c1', actor);
    const byId = new Map(out.lines.map((l) => [l.id, l]));
    expect(byId.get('b2')?.hourBlockHasHistory).toBe(true);
    expect(byId.get('b1')?.hourBlockHasHistory).toBe(true);
    expect(byId.get('f1')).not.toHaveProperty('hourBlockHasHistory');
  });
});
```

(The `getContract` queue order depends on the order the decoration runs relative to `periods`; the implementation below decorates **after** `withLineRefs` and the periods read, so the order is lock/contract, lines, periods, then one history read per live block. If the existing `autopay` mock or queue order differs when run, adjust the queue, not the implementation.)

Route test — append to `routes/contracts/contracts.test.ts` near `:364`:

```ts
  it('DELETE reports { ok: true, retired } so the UI can say retired vs removed (#4547 W03)', async () => {
    (removeContractLine as any).mockResolvedValueOnce({
      orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme', contractLineId: LINE_ID, lineType: 'hour_block', retired: true,
    });
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, retired: true } });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'contract.line.removed', details: expect.objectContaining({ lineType: 'hour_block', retired: true }),
    }));
  });
```
(Use the file's existing names for the mocked service/audit imports and `ORG_ID`/`CONTRACT_ID`/`LINE_ID` constants; the surrounding test at `:364-375` shows them. The existing test at `:364` keeps `{ data: { ok: true } }`? — it asserts `{ ok: true }`; update it to expect `{ ok: true, retired: false }`, because the route now always includes the boolean.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractService.hourBlock.test.ts src/routes/contracts/contracts.test.ts`
Expected: FAIL — block lines are deleted blindly, no `retired`, no decoration.

- [ ] **Step 3: Implement**

`contractService.ts`:

1. Imports: `gte`, `lte` from `drizzle-orm` (`gte` was added in Task 3); `contractHourPeriods` from `../db/schema` (`sql` is already imported).

2. Helper (next to `withLineRefs`):

```ts
/** See Task 5 interface block. Two short indexed reads, ledger first (the common
 *  answer for a long-lived block). Runs on the caller's executor so remove sees it
 *  under the contract row lock. */
async function hourBlockHasHistory(
  tx: DbExecutor,
  line: { id: string; contractId: string; hourBlockFirstPeriodStart: string | null },
): Promise<boolean> {
  const [ledger] = await tx.select({ id: contractHourPeriods.id }).from(contractHourPeriods)
    .where(eq(contractHourPeriods.contractLineId, line.id)).limit(1);
  if (ledger) return true;
  if (line.hourBlockFirstPeriodStart === null) return false;
  const [claimed] = await tx.select({ id: contractBillingPeriods.id }).from(contractBillingPeriods)
    .where(and(
      eq(contractBillingPeriods.contractId, line.contractId),
      gte(contractBillingPeriods.periodStart, line.hourBlockFirstPeriodStart),
      // Mirrors W02's close criterion: a retired line's period closes iff it was claimed while the line
      // was live (generated_at <= hour_block_retired_at), and retire stamps now(). Every existing claim
      // satisfies this at retire time; stating it keeps the two predicates from drifting.
      lte(contractBillingPeriods.generatedAt, sql`now()`),
    )).limit(1);
  return !!claimed;
}
```

3. `DecoratedContractLine` (`:165-168`) — add `hourBlockHasHistory?: boolean;`.

4. `getContract` — wrap the final `lines: await withLineRefs(lines)` (and the early restricted-actor return) with a decorator:

```ts
async function withBlockHistory<T extends { id: string; contractId: string; lineType: string; hourBlockFirstPeriodStart: string | null; hourBlockRetiredAt: Date | string | null }>(
  rows: T[],
): Promise<Array<T & { hourBlockHasHistory?: boolean }>> {
  const out: Array<T & { hourBlockHasHistory?: boolean }> = [];
  for (const r of rows) {
    if (r.lineType !== 'hour_block') { out.push(r); continue; }
    // A retired block always has history (it is only ever retired because it did).
    out.push({ ...r, hourBlockHasHistory: r.hourBlockRetiredAt !== null ? true : await hourBlockHasHistory(db, r) });
  }
  return out;
}
```
and `lines: await withBlockHistory(await withLineRefs(lines)),` in both return statements. (At most a handful of block lines per contract, so a per-line read is fine; non-block contracts add zero queries.)

5. `removeContractLine` — select the extra columns and branch:

```ts
    const [row] = await tx.select({
      id: contractLines.id, lineType: contractLines.lineType,
      hourBlockFirstPeriodStart: contractLines.hourBlockFirstPeriodStart,
      hourBlockRetiredAt: contractLines.hourBlockRetiredAt,
    }).from(contractLines)
      .where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId))).limit(1);
    if (!row) throw new ContractServiceError('Contract line not found', 404, 'LINE_NOT_FOUND');
    const audit = { orgId: c.orgId, contractId, contractName: c.name, contractLineId: row.id, lineType: row.lineType };
    if (row.lineType === 'hour_block') {
      // Already retired: idempotent, and retired_at must not move (W02 bounds the
      // close-out sweep to claims with generated_at <= retired_at).
      if (row.hourBlockRetiredAt !== null) return { ...audit, retired: true };
      // Index C7: history => retire (never delete: the ledger FK is ON DELETE RESTRICT and a
      // claimed-but-unclosed period must still close via W02's sweep); else delete.
      if (await hourBlockHasHistory(tx, { id: row.id, contractId, hourBlockFirstPeriodStart: row.hourBlockFirstPeriodStart })) {
        await tx.update(contractLines).set({ hourBlockRetiredAt: sql`now()` })
          .where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId)));
        return { ...audit, retired: true };
      }
      await tx.delete(contractLines).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId)));
      return { ...audit, retired: false };
    }
    await tx.delete(contractLines).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId)));
    return audit;
```

Doors:
- `routes/contracts/lines.ts:75-81`: `return c.json({ data: { ok: true, retired: audit.retired === true } });` (replace the old comment accordingly: "ok always; retired tells the UI whether the line was kept as history").
- `routes/partnerApi/contracts.ts:244-246`: same `{ data: { ok: true, retired: audit.retired === true } }`; and the Partner API test beside it asserts the new body.
- `aiToolsContracts.ts:352-354`: `return JSON.stringify({ ok: true, retired: audit.retired === true });`
- Audit action: keep `contract.line.removed` for both outcomes (the details carry `retired: true`); adding a new audit action name would force three union-type edits and the audit-catalog surface for no benefit.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/contractService.hourBlock.test.ts src/services/contractService.test.ts src/routes/contracts/contracts.test.ts src/routes/partnerApi/contracts.test.ts src/services/aiToolsContracts.manageContracts.test.ts`
Expected: PASS, 5 files. Existing remove assertions that `toEqual` the AI result `{ ok: true }` now see `retired: false` — update them.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/services/contractService.hourBlock.test.ts apps/api/src/routes/contracts/lines.ts apps/api/src/routes/contracts/contracts.test.ts apps/api/src/routes/partnerApi/contracts.ts apps/api/src/routes/partnerApi/contracts.test.ts apps/api/src/services/aiToolsContracts.ts apps/api/src/services/aiToolsContracts.manageContracts.test.ts
git commit -m "feat(billing): retire a block-hours line that has history instead of deleting it (#4547)

A block with a ledger row or a claimed period at or after its first period is
retired; otherwise it is deleted. The detail read reports whether a block has
history so the editor's confirm copy follows the same rule.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The live open-period figure — `computeOpenHourBlockPeriod` and `computeContractEstimate.hourBlock`

**Files:**
- Create: `packages/shared/src/types/hourBlock.ts`; modify `packages/shared/src/types/index.ts`
- Create: `apps/api/src/services/contractHourBlockEstimate.ts`, `apps/api/src/services/contractHourBlockEstimate.test.ts`
- Modify: `apps/api/src/services/contractService.ts` (`computeContractEstimate`)
- Modify: `apps/api/src/services/aiToolsBilling.ts:385`

**Interfaces:**
- Produces (coordinator-fixed name and signature; W04's portal handler and alert sweep reuse it):
  ```ts
  export async function computeOpenHourBlockPeriod(
    contract: typeof contracts.$inferSelect,
    line: typeof contractLines.$inferSelect,
    asOf?: Date,
  ): Promise<HourBlockEstimate>;
  ```
  plus exported pure helpers `openPeriodFor(...)` and `buildHourBlockEstimate(...)` (module-internal; not part of the cross-wave contract).
- Consumes: W02 `sumEntryHours` / `computePeriodMath` / `HourBlockLineSpec` / `RolloverPolicy` (`contractHourBlocks.ts`, index C7); `overageValue` (`contractAllowance.ts:84`); `computePeriod` / `periodIndexFor` / `todayISO` (`contractMath.ts`); `contractHourPeriods` (W01).

**The context rule — chosen and justified.** `computeContractEstimate` runs inside a held request transaction on the HTTP route (`routes/contracts/contracts.ts:66-69`) and inside the AI tool's ambient transaction (`aiToolsBilling.ts:385`, which locks the destination invoice and the source contract first and holds both through materialization). `time_entries` RLS is `system OR breeze_has_partner_access(partner_id)` (`2026-06-12-a-ticketing-time-parts.sql:60-64`; `breeze_has_partner_access` is true for `scope = 'system'` or a partner id in `breeze_accessible_partner_ids()`, `2026-04-11-partners-rls.sql:58-67`). So:

- **Organization scope** (or no context) sees **zero** rows — the partner-axis trap. Neither existing door can reach this function that way (`requireScope('partner','system')`, `partnerScopeRefusal`), but a future door could.
- **Partner scope holding `contract.partnerId`** already sees the rows. Both existing doors are exactly this. Escalating them with `runOutsideDbContext(() => withSystemDbAccessContext(...))` would add a **second pooled connection while the request holds one** — the hang-at-concurrency-≥-pool-size hazard CLAUDE.md "Partner-Wide First" step 3 describes — and would drop RLS for no gain.
- **System scope** (workers; W04's portal handler after its own `runOutsideDbContext(() => withSystemDbAccessContext(...))`) sees everything and filters by `org_id` explicitly.

So the function opens **no** context and **asserts** one. It is the coordinator's contract ("must be called inside a system DB context, does not open one itself") with one precise extension: a partner-scope context for the owning partner is also sufficient, and the guard turns every other context into a loud 500 instead of a silent "0 hours used". The explicit `org_id = contract.org_id` filter scopes the read inside either context. Pinned by this task's guard tests and by Task 14's real-DB trap test.

`computeContractEstimate` gets an opt-out, `opts.includeHourBlock` (default **true**). The AI `add_contract_line` action passes `false`: it reads `lines[]` only, runs inside two held locks on a money path, and must never depend on the drawdown read (index delta 8).

**Known, bounded approximation (it is in the JSDoc):** `carriedInHours` is the last **closed** ledger row's `carried_out_hours`. Between a period's end and the next daily billing run (W02) that period is claimed but unclosed, so under `carry_forward` its leftover is not yet in `carriedInHours`. The lag is at most one sweep and the figure is an estimate; the ledger — not this read — is what bills.

- [ ] **Step 1: Write the failing tests** — create `apps/api/src/services/contractHourBlockEstimate.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Queued = { rows: unknown[] };
const results: Queued[] = [];
const queueResult = (rows: unknown[]) => results.push({ rows });
const ctxMock = vi.hoisted(() => ({ getCurrentDbAccessContext: vi.fn() }));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(results.shift()?.rows ?? []);
  return { db: chain, getCurrentDbAccessContext: ctxMock.getCurrentDbAccessContext };
});

import { computeOpenHourBlockPeriod, openPeriodFor, buildHourBlockEstimate } from './contractHourBlockEstimate';

describe('openPeriodFor (index C9)', () => {
  it.each([
    ['2026-06-01', '2026-06-01', '2026-06-15', '2026-06-01', '2026-07-01'],   // contract-aligned block, mid-period
    ['2026-06-01', '2026-07-01', '2026-06-15', '2026-07-01', '2026-08-01'],   // block added mid-period: not yet counting
    ['2026-06-01', '2026-07-01', '2026-07-01', '2026-07-01', '2026-08-01'],   // first counted day
    ['2026-06-01', '2026-06-01', '2026-09-30', '2026-09-01', '2026-10-01'],   // a later period
  ])('start %s first %s today %s -> [%s, %s)', (startDate, firstPeriodStart, today, ps, pe) => {
    expect(openPeriodFor({ startDate, intervalMonths: 1, firstPeriodStart, today })).toEqual({ periodStart: ps, periodEnd: pe });
  });
});

describe('buildHourBlockEstimate', () => {
  const line = {
    id: 'b1', includedQuantity: '10.00', overageUnitPrice: '150.00', rolloverPolicy: 'none',
    rolloverCapHours: null as string | null, hourBlockAlertPct: 80 as number | null,
  };
  const contract = { currencyCode: 'USD', billingTiming: 'advance' as const };
  const period = { periodStart: '2026-09-01', periodEnd: '2026-10-01' };
  const entry = (minutes: number, over: Record<string, unknown> = {}) => ({ minutes, isApproved: true, currencyCode: 'USD', ...over });
  const build = (entries: ReturnType<typeof entry>[], over: Record<string, unknown> = {}) =>
    buildHourBlockEstimate({ line, contract, period, carriedInHours: 0, entries, lateEntryMinutes: [], ...over } as never);

  it('6.5 of 10 used: 3.5 remaining, no overage', () => {
    expect(build([entry(390)])).toMatchObject({
      lineId: 'b1', periodStart: '2026-09-01', periodEnd: '2026-10-01', includedHours: 10, carriedInHours: 0,
      consumedHours: 6.5, remainingHours: 3.5, overageHours: 0, overageValue: '0.00',
      overageUnitPrice: '150.00', alertPct: 80, billingTiming: 'advance',
    });
  });

  it('12 of 10 used: 2 hours over, priced at the contract rate, nothing remaining', () => {
    expect(build([entry(720)])).toMatchObject({ consumedHours: 12, remainingHours: 0, overageHours: 2, overageValue: '300.00' });
  });

  it('carried-in hours extend the opening balance', () => {
    expect(build([entry(720)], { carriedInHours: 3 })).toMatchObject({ carriedInHours: 3, consumedHours: 12, remainingHours: 1, overageHours: 0 });
  });

  it('rounds each entry to 2dp BEFORE summing: three 20-minute entries are 0.99 h, not 1.00', () => {
    expect(build([entry(20), entry(20), entry(20)]).consumedHours).toBe(0.99);
  });

  it('unapproved is a subset of consumed; mixed-currency hours still draw and are flagged', () => {
    const out = build([entry(60, { isApproved: false }), entry(30), entry(90, { currencyCode: 'EUR' })]);
    expect(out).toMatchObject({ consumedHours: 3, unapprovedHours: 1, foreignCurrencyHours: 1.5 });
  });

  it('late-entry hours are summed from the closed-period minutes', () => {
    expect(build([], { lateEntryMinutes: [90, 30] }).lateEntryHours).toBe(2);
  });

  it('an arrears contract reports its timing (drives the "bills next invoice" note)', () => {
    expect(build([], { contract: { currencyCode: 'USD', billingTiming: 'arrears' } }).billingTiming).toBe('arrears');
  });
});

describe('computeOpenHourBlockPeriod — context guard (partner-axis trap)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const contract = { id: 'c1', orgId: 'org1', partnerId: 'p1', startDate: '2026-06-01', intervalMonths: 1, billingTiming: 'advance', currencyCode: 'USD' } as never;
  const line = {
    id: 'b1', lineType: 'hour_block', includedQuantity: '10.00', overageUnitPrice: '150.00', rolloverPolicy: 'none',
    rolloverCapHours: null, hourBlockAlertPct: null, hourBlockFirstPeriodStart: '2026-06-01', hourBlockRetiredAt: null,
  } as never;

  it.each([
    ['no context', undefined],
    ['organization scope', { scope: 'organization', orgId: 'org1', accessibleOrgIds: ['org1'], accessiblePartnerIds: [] }],
    ['a different partner', { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: ['other'] }],
  ])('fails closed under %s instead of returning zero hours', async (_name, ctx) => {
    ctxMock.getCurrentDbAccessContext.mockReturnValue(ctx);
    await expect(computeOpenHourBlockPeriod(contract, line, new Date('2026-06-15T00:00:00Z')))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 500 });
  });

  it.each([
    ['system scope', { scope: 'system', orgId: null, accessibleOrgIds: null }],
    ['the owning partner', { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: ['p1'] }],
  ])('reads under %s', async (_name, ctx) => {
    ctxMock.getCurrentDbAccessContext.mockReturnValue(ctx);
    queueResult([{ carriedOut: '2.00' }]); // last ledger row
    queueResult([{ minutes: 60, isApproved: true, currencyCode: 'USD' }]); // open-period entries
    queueResult([]);                       // late entries
    const out = await computeOpenHourBlockPeriod(contract, line, new Date('2026-06-15T00:00:00Z'));
    expect(out).toMatchObject({ periodStart: '2026-06-01', periodEnd: '2026-07-01', carriedInHours: 2, consumedHours: 1, remainingHours: 11 });
  });

  it('is a typed 500 for an incomplete block row rather than a NaN estimate', async () => {
    ctxMock.getCurrentDbAccessContext.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null });
    await expect(computeOpenHourBlockPeriod(contract, { ...(line as object), includedQuantity: null } as never))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 500 });
  });
});
```

(`carriedInHours: 2` under `rolloverPolicy: 'none'` only proves the ledger read is plumbed; real data under `none` carries 0.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractHourBlockEstimate.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

1. `packages/shared/src/types/hourBlock.ts` (index C8 verbatim; Task 3 already created this file — verify it matches) and `export * from './hourBlock';` in `types/index.ts`:

```ts
/** Index C8 (#4547): the live figures for a block line's OPEN period. Hours are
 *  exact 2-dp numbers; money is a 2-dp string (overageValue()). */
export interface HourBlockEstimate {
  lineId: string;
  periodStart: string; periodEnd: string;          // the OPEN period, half-open
  includedHours: number; carriedInHours: number;
  consumedHours: number; unapprovedHours: number;  // unapproved ⊆ consumed (Decision 4)
  foreignCurrencyHours: number;                    // Decision 8 flag
  remainingHours: number; overageHours: number;
  overageUnitPrice: string; overageValue: string;
  alertPct: number | null;
  billingTiming: 'advance' | 'arrears';            // drives the "bills next invoice" note
  lateEntryHours: number;                          // not_billed entries in already-closed periods
}
```

2. `apps/api/src/services/contractHourBlockEstimate.ts`:

```ts
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { HourBlockEstimate } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../db';
import { contractHourPeriods, timeEntries, type contracts, type contractLines } from '../db/schema';
import { computePeriod, periodIndexFor, todayISO } from './contractMath';
import { computePeriodMath, sumEntryHours, type HourBlockLineSpec, type RolloverPolicy } from './contractHourBlocks';
import { overageValue } from './contractAllowance';
import { ContractServiceError } from './contractTypes';

/**
 * Fail closed unless `time_entries` rows of `partnerId` are RLS-visible: system
 * scope, or partner scope holding that partner. `time_entries` is partner-axis
 * (Shape 3), so an organization-scope or absent context reads ZERO rows — which
 * this module would otherwise render as "0 of N hours used", i.e. free hours.
 */
function assertDrawdownReadable(partnerId: string): void {
  const ctx = getCurrentDbAccessContext();
  const ok = ctx?.scope === 'system'
    || (ctx?.scope === 'partner' && (ctx.accessiblePartnerIds ?? []).includes(partnerId));
  if (!ok) {
    throw new ContractServiceError(
      'Block-hours usage can only be read where time entries are visible: a system context, or a partner context for the owning partner',
      500, 'INVALID_STATE',
    );
  }
}

/** The period the figures are for: the contract period containing `today`, or —
 *  when the block starts counting later (an advance contract's current period was claimed before the block existed — index C9 "first unclaimed period") — the first
 *  counted period. Entries ended before `periodStart` are not eligible, so for a
 *  not-yet-started period the consumed figure is naturally 0. */
export function openPeriodFor(a: {
  startDate: string; intervalMonths: number; firstPeriodStart: string; today: string;
}): { periodStart: string; periodEnd: string } {
  let idx = periodIndexFor(a.startDate, a.intervalMonths, a.today);
  let p = computePeriod(a.startDate, a.intervalMonths, idx);
  // firstPeriodStart is itself a period boundary, so this terminates on equality.
  for (let guard = 0; p.periodStart < a.firstPeriodStart && guard < 100000; guard++) {
    idx += 1;
    p = computePeriod(a.startDate, a.intervalMonths, idx);
  }
  return p;
}

export interface OpenPeriodEntry { minutes: number; isApproved: boolean; currencyCode: string | null }

/** Pure: raw rows in, C8 out. Round-each-then-sum via sumEntryHours (20 min x 3 = 0.99 h). */
export function buildHourBlockEstimate(a: {
  line: {
    id: string; includedQuantity: string; overageUnitPrice: string; rolloverPolicy: string;
    rolloverCapHours: string | null; hourBlockAlertPct: number | null;
  };
  contract: { currencyCode: string; billingTiming: 'advance' | 'arrears' };
  period: { periodStart: string; periodEnd: string };
  carriedInHours: number;
  entries: readonly OpenPeriodEntry[];
  lateEntryMinutes: readonly number[];
}): HourBlockEstimate {
  const spec: HourBlockLineSpec = {
    includedQuantity: a.line.includedQuantity,
    overageUnitPrice: a.line.overageUnitPrice,
    rolloverPolicy: a.line.rolloverPolicy as RolloverPolicy,
    rolloverCapHours: a.line.rolloverCapHours,
  };
  const consumed = sumEntryHours(a.entries.map((e) => e.minutes));
  const unapproved = sumEntryHours(a.entries.filter((e) => !e.isApproved).map((e) => e.minutes));
  const foreign = sumEntryHours(
    a.entries.filter((e) => e.currencyCode !== null && e.currencyCode !== a.contract.currencyCode).map((e) => e.minutes),
  );
  const math = computePeriodMath(spec, a.carriedInHours, consumed);
  const remaining = Math.max(0, Math.round((math.openingHours - math.consumedHours) * 100) / 100);
  return {
    lineId: a.line.id,
    periodStart: a.period.periodStart, periodEnd: a.period.periodEnd,
    includedHours: math.includedHours, carriedInHours: math.carriedInHours,
    consumedHours: math.consumedHours, unapprovedHours: unapproved,
    foreignCurrencyHours: foreign,
    remainingHours: remaining, overageHours: math.overageHours,
    overageUnitPrice: a.line.overageUnitPrice,
    overageValue: overageValue(
      { counted: math.consumedHours, billed: 1, included: math.openingHours, overage: math.overageHours, overageMode: 'bill' },
      { overageUnitPrice: a.line.overageUnitPrice }, a.contract.currencyCode,
    ),
    alertPct: a.line.hourBlockAlertPct,
    billingTiming: a.contract.billingTiming,
    lateEntryHours: sumEntryHours(a.lateEntryMinutes),
  };
}

/**
 * Live figures for a block line's OPEN period (index C8). Reads only; no FOR
 * UPDATE (the close, W02, is what locks). Eligibility is index C9's: org,
 * billable, not_billed, ended within the period, minutes =
 * COALESCE(billable_minutes, duration_minutes, 0); unapproved and any-currency
 * entries draw.
 *
 * CONTEXT: this function opens NO database context. It must be called where
 * `time_entries` rows of `contract.partnerId` are RLS-visible — a system context
 * (workers; W04's portal handler wraps it in runOutsideDbContext +
 * withSystemDbAccessContext) or a partner-scope context for the owning partner
 * (the contract routes and the AI tool, which run inside a held request
 * transaction and must NOT open a second connection). Any other context throws
 * rather than reading zero rows. The explicit `org_id` filter below scopes the
 * read inside either context.
 *
 * APPROXIMATION: carriedInHours is the last CLOSED ledger row's carried_out. In
 * the window between a period's end and the next billing sweep, that period is
 * claimed but unclosed, so its leftover is not yet reflected. The ledger, not
 * this read, is what bills.
 */
export async function computeOpenHourBlockPeriod(
  contract: typeof contracts.$inferSelect,
  line: typeof contractLines.$inferSelect,
  asOf: Date = new Date(),
): Promise<HourBlockEstimate> {
  assertDrawdownReadable(contract.partnerId);
  if (
    line.lineType !== 'hour_block' || line.includedQuantity === null || line.overageUnitPrice === null
    || line.rolloverPolicy === null || line.hourBlockFirstPeriodStart === null
  ) {
    throw new ContractServiceError(`Contract line ${line.id} is not a complete block-hours line`, 500, 'INVALID_STATE');
  }
  const period = openPeriodFor({
    startDate: contract.startDate, intervalMonths: contract.intervalMonths,
    firstPeriodStart: line.hourBlockFirstPeriodStart, today: todayISO(asOf),
  });
  // Dates -> instants: UTC midnight, the convention the invoice assembly range uses (index C9).
  const from = new Date(`${period.periodStart}T00:00:00Z`);
  const to = new Date(`${period.periodEnd}T00:00:00Z`);

  const [last] = await db.select({ carriedOut: contractHourPeriods.carriedOutHours }).from(contractHourPeriods)
    .where(eq(contractHourPeriods.contractLineId, line.id))
    .orderBy(desc(contractHourPeriods.periodStart)).limit(1);

  const eligible = and(
    eq(timeEntries.orgId, contract.orgId), eq(timeEntries.isBillable, true),
    eq(timeEntries.billingStatus, 'not_billed'), isNotNull(timeEntries.endedAt),
  );
  const minutes = sql<number>`COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes}, 0)`;
  const entries = await db.select({ minutes, isApproved: timeEntries.isApproved, currencyCode: timeEntries.currencyCode })
    .from(timeEntries)
    .where(and(eligible, gte(timeEntries.endedAt, from), lt(timeEntries.endedAt, to)));
  // Not-billed billable entries whose end falls inside a period this line already
  // closed: the ledger cannot re-close, so they bill separately (spec "Out of scope").
  const late = await db.select({ minutes }).from(timeEntries).where(and(
    eligible,
    sql`EXISTS (
      SELECT 1 FROM contract_hour_periods p
       WHERE p.contract_line_id = ${line.id}
         AND ${timeEntries.endedAt} >= p.period_start::timestamp
         AND ${timeEntries.endedAt} <  p.period_end::timestamp)`,
  ));

  return buildHourBlockEstimate({
    line: {
      id: line.id, includedQuantity: line.includedQuantity, overageUnitPrice: line.overageUnitPrice,
      rolloverPolicy: line.rolloverPolicy, rolloverCapHours: line.rolloverCapHours,
      hourBlockAlertPct: line.hourBlockAlertPct,
    },
    contract: { currencyCode: contract.currencyCode, billingTiming: contract.billingTiming as 'advance' | 'arrears' },
    period,
    carriedInHours: last ? Number(last.carriedOut) : 0,
    entries: entries.map((e) => ({ minutes: Number(e.minutes), isApproved: e.isApproved, currencyCode: e.currencyCode })),
    lateEntryMinutes: late.map((e) => Number(e.minutes)),
  });
}
```

3. `contractService.ts`: import `computeOpenHourBlockPeriod`; in `computeContractEstimate`, replace the Task 3 placeholder `hourBlock: null` with:

```ts
  // #4547 W03: the OPEN period of the live block, if any. Ambient context (see
  // contractHourBlockEstimate.ts for why there is no escalation); the AI add-line
  // action opts out because it reads lines[] only.
  const liveBlock = lines.find((l) => l.lineType === 'hour_block' && l.hourBlockRetiredAt === null);
  const hourBlock = liveBlock && opts.includeHourBlock !== false
    ? await computeOpenHourBlockPeriod(contract, liveBlock)
    : null;
  return { currencyCode: contract.currencyCode, periodTotal: fromCents(cents), lines: out, uncoveredDevices, overages, hourBlock };
```

4. `aiToolsBilling.ts:385`: `const estimate = await computeContractEstimate(contractId, contractActor, deviceEvidence, { includeHourBlock: false });` — update the existing `aiToolsBilling` test's `toHaveBeenCalledWith(...)` for that call to include `{ includeHourBlock: false }` (find with `git grep -n computeContractEstimate -- apps/api/src/services/aiToolsBilling*.test.ts`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/contractHourBlockEstimate.test.ts src/services/contractService.hourBlock.test.ts src/services/contractService.test.ts`
and the `aiToolsBilling` test file(s) found above. Expected: PASS. Typecheck `apps/api` and `packages/shared`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/hourBlock.ts packages/shared/src/types/index.ts apps/api/src/services/contractHourBlockEstimate.ts apps/api/src/services/contractHourBlockEstimate.test.ts apps/api/src/services/contractService.ts apps/api/src/services/aiToolsBilling.ts
git add -u apps/api/src/services
git commit -m "feat(billing): live open-period figure for a block-hours line (#4547)

computeOpenHourBlockPeriod reads the open period's drawdown without opening a
database context and refuses to run where time entries are not visible, so a
wrongly scoped caller errors instead of showing zero hours used. The contract
estimate carries it; the interactive add-line action opts out.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `GET /contracts/:id/hour-periods` — the closed-period history

**Files:**
- Create: `apps/api/src/services/contractHourPeriodsRead.ts`, `apps/api/src/services/contractHourPeriodsRead.test.ts`
- Create: `apps/api/src/routes/contracts/hourPeriods.ts`, `apps/api/src/routes/contracts/hourPeriods.test.ts`
- Modify: `apps/api/src/routes/contracts/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HourPeriodRow {
    id: string; contractLineId: string; periodStart: string; periodEnd: string;
    includedHours: string; carriedInHours: string; consumedHours: string; overageHours: string; carriedOutHours: string;
    foreignCurrencyHours: string; entryCount: number; overageUnitPrice: string; currencyCode: string;
    overageInvoiceId: string | null; closeSource: 'billing_run' | 'close_out'; closedAt: string;
  }
  export async function listContractHourPeriods(
    contractId: string, query: { limit: number; cursor?: string }, actor: ContractActor,
  ): Promise<{ items: HourPeriodRow[]; nextCursor: string | null }>;
  ```
  Route: `GET /contracts/:id/hour-periods?limit=&cursor=` → `{ data: { items, nextCursor } }`; `contracts:read`; partner/system scope; org access through `getOwnedContractOr404` (`requireOrgAccess`). Newest first by `(period_start desc, id desc)`; the cursor is `YYYY-MM-DD|<uuid>` of the last returned row.
- Hours stay **strings** here (`numeric(12,2)` columns, the API's convention for stored quantities); the estimate's C8 hours are numbers because they are computed. The web uses `Number()` for display.

**Verified:** `contract_hour_periods` is org-axis Shape 1 (index C3), so unlike `time_entries` it is readable in the ordinary request context — `getContract` already reads its sibling `contract_billing_periods` that way (`contractService.ts:379-399`). Task 14 asserts it against real Postgres rather than trusting the analogy. The route mounts **before** `contractCrudRoutes`, like every `/:id/...` sibling (`routes/contracts/index.ts:12-21`).

- [ ] **Step 1: Write the failing tests**

`contractHourPeriodsRead.test.ts` — reuse the thenable Drizzle chain mock and the four stubs (`./autopay/autopayGate`, `./contractEvents`, `./invoiceService`, `./contractQuantities`) from `contractService.hourBlock.test.ts` (Task 3), because `./contractService` is imported for `getOwnedContractOr404`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// ...the vi.mock('../db') chain + queue helpers and the four stubs from Task 3's test file...
import { encodeHourPeriodCursor, decodeHourPeriodCursor, listContractHourPeriods } from './contractHourPeriodsRead';

describe('hour-period cursor', () => {
  it('round-trips and rejects a malformed value', () => {
    const c = encodeHourPeriodCursor('2026-08-01', '11111111-1111-4111-8111-111111111111');
    expect(c).toBe('2026-08-01|11111111-1111-4111-8111-111111111111');
    expect(decodeHourPeriodCursor(c)).toEqual({ periodStart: '2026-08-01', id: '11111111-1111-4111-8111-111111111111' });
    expect(decodeHourPeriodCursor('nope')).toBeNull();
    expect(decodeHourPeriodCursor("2026-08-01|x'; drop")).toBeNull();
  });
});

describe('listContractHourPeriods', () => {
  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const row = (i: number) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`, contractLineId: 'b1', periodStart: `2026-0${i}-01`, periodEnd: `2026-0${i + 1}-01`,
    includedHours: '10.00', carriedInHours: '0.00', consumedHours: '6.50', overageHours: '0.00', carriedOutHours: '0.00',
    foreignCurrencyHours: '0.00', entryCount: 4, overageUnitPrice: '150.00', currencyCode: 'USD',
    overageInvoiceId: null, closeSource: 'billing_run', closedAt: new Date('2026-09-01T00:00:00Z'),
  });
  beforeEach(() => { results.length = 0; });

  it('returns a page and a cursor when more rows exist (limit+1 read), with ISO closedAt', async () => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1' }]);   // getOwnedContractOr404
    queueResult([row(3), row(2), row(1)]);                           // limit 2 -> reads 3
    const out = await listContractHourPeriods('c1', { limit: 2 }, actor);
    expect(out.items.map((r) => r.periodStart)).toEqual(['2026-03-01', '2026-02-01']);
    expect(out.nextCursor).toBe('2026-02-01|00000000-0000-4000-8000-000000000002');
    expect(typeof out.items[0]!.closedAt).toBe('string');
  });

  it('has no cursor on the last page', async () => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1' }]);
    queueResult([row(2), row(1)]);
    const out = await listContractHourPeriods('c1', { limit: 5 }, actor);
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBeNull();
  });

  it('404s an unknown contract and 403s a foreign org', async () => {
    queueResult([]);
    await expect(listContractHourPeriods('nope', { limit: 5 }, actor)).rejects.toMatchObject({ code: 'CONTRACT_NOT_FOUND', status: 404 });
    queueResult([{ id: 'c2', orgId: 'org9', partnerId: 'p1' }]);
    await expect(listContractHourPeriods('c2', { limit: 5 }, actor)).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
});
```

`routes/contracts/hourPeriods.test.ts` — copy the `vi.mock` blocks and the auth mock from `routes/contracts/contracts.test.ts:1-83` verbatim (service, auditEvents, db, contractTypes, auth), add `vi.mock('../../services/contractHourPeriodsRead', () => ({ listContractHourPeriods: vi.fn() }))`, and drive `contractRoutes` from `./index` so the mount is part of what is tested:

```ts
const CONTRACT_ID = '11111111-1111-1111-1111-111111111111';

describe('GET /:id/hour-periods (#4547 W03)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the page and forwards limit, cursor and the actor', async () => {
    (listContractHourPeriods as any).mockResolvedValue({ items: [{ id: 'hp1' }], nextCursor: null });
    const cursor = '2026-08-01|22222222-2222-4222-8222-222222222222';
    const res = await contractRoutes.request(`/${CONTRACT_ID}/hour-periods?limit=5&cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { items: [{ id: 'hp1' }], nextCursor: null } });
    expect(listContractHourPeriods).toHaveBeenCalledWith(CONTRACT_ID, { limit: 5, cursor }, expect.objectContaining({ userId: 'u1' }));
  });

  it('defaults the limit', async () => {
    (listContractHourPeriods as any).mockResolvedValue({ items: [], nextCursor: null });
    await contractRoutes.request(`/${CONTRACT_ID}/hour-periods`);
    expect(listContractHourPeriods).toHaveBeenCalledWith(CONTRACT_ID, { limit: 24 }, expect.anything());
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'cursor=nope'])('rejects %s with 400 and no service call', async (qs) => {
    const res = await contractRoutes.request(`/${CONTRACT_ID}/hour-periods?${qs}`);
    expect(res.status).toBe(400);
    expect(listContractHourPeriods).not.toHaveBeenCalled();
  });

  it('maps a service error to its status and code', async () => {
    (listContractHourPeriods as any).mockRejectedValue(new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND'));
    const res = await contractRoutes.request(`/${CONTRACT_ID}/hour-periods`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'CONTRACT_NOT_FOUND' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractHourPeriodsRead.test.ts src/routes/contracts/hourPeriods.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement**

`apps/api/src/services/contractHourPeriodsRead.ts`:

```ts
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { contractHourPeriods } from '../db/schema';
import { getOwnedContractOr404, requireWholeContractSiteAccess } from './contractService';
import type { ContractActor } from './contractTypes';

export interface HourPeriodRow { /* exactly as in the Interfaces block above */ }

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const encodeHourPeriodCursor = (periodStart: string, id: string): string => `${periodStart}|${id}`;
export function decodeHourPeriodCursor(raw: string): { periodStart: string; id: string } | null {
  const m = CURSOR_RE.exec(raw);
  return m ? { periodStart: m[1]!, id: m[2]! } : null;
}

/** Closed periods of a contract's block line(s), newest first. Org-axis table, so
 *  the ordinary request context is enough (unlike time_entries). */
export async function listContractHourPeriods(
  contractId: string, query: { limit: number; cursor?: string }, actor: ContractActor,
): Promise<{ items: HourPeriodRow[]; nextCursor: string | null }> {
  await getOwnedContractOr404(contractId, actor);               // 404 + org access
  await requireWholeContractSiteAccess(actor, contractId);       // no-op for an unrestricted actor
  const conds = [eq(contractHourPeriods.contractId, contractId)];
  const cur = query.cursor ? decodeHourPeriodCursor(query.cursor) : null;
  if (query.cursor && !cur) return { items: [], nextCursor: null };   // the route validates; defence in depth
  if (cur) {
    conds.push(sql`(${contractHourPeriods.periodStart}, ${contractHourPeriods.id}) < (${cur.periodStart}::date, ${cur.id}::uuid)`);
  }
  const rows = await db.select().from(contractHourPeriods).where(and(...conds))
    .orderBy(desc(contractHourPeriods.periodStart), desc(contractHourPeriods.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const items: HourPeriodRow[] = page.map((r) => ({
    id: r.id, contractLineId: r.contractLineId, periodStart: r.periodStart, periodEnd: r.periodEnd,
    includedHours: r.includedHours, carriedInHours: r.carriedInHours, consumedHours: r.consumedHours,
    overageHours: r.overageHours, carriedOutHours: r.carriedOutHours, foreignCurrencyHours: r.foreignCurrencyHours,
    entryCount: r.entryCount, overageUnitPrice: r.overageUnitPrice, currencyCode: r.currencyCode,
    overageInvoiceId: r.overageInvoiceId, closeSource: r.closeSource as HourPeriodRow['closeSource'],
    closedAt: new Date(r.closedAt).toISOString(),
  }));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: rows.length > query.limit && last ? encodeHourPeriodCursor(last.periodStart, last.id) : null,
  };
}
```

`apps/api/src/routes/contracts/hourPeriods.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { listContractHourPeriods } from '../../services/contractHourPeriodsRead';
import { contractActorFrom, handleContractError } from './contracts';

export const contractHourPeriodRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const idParam = z.object({ id: z.string().guid() });
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}\|[0-9a-fA-F-]{36}$/).optional(),
}).strict();

contractHourPeriodRoutes.get('/:id/hour-periods', scopes, readPerm,
  zValidator('param', idParam), zValidator('query', querySchema), async (c) => {
  try {
    return c.json({ data: await listContractHourPeriods(c.req.valid('param').id, c.req.valid('query'), contractActorFrom(c)) });
  } catch (err) { return handleContractError(c, err); }
});
```

`routes/contracts/index.ts` — import it and mount directly after the lines route:

```ts
contractRoutes.route('/', contractHourPeriodRoutes); // /:id/hour-periods (#4547 W03) — before the /:id param matchers
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/contractHourPeriodsRead.test.ts src/routes/contracts/hourPeriods.test.ts src/routes/contracts/contracts.test.ts`
Expected: PASS, 3 files. Typecheck `apps/api`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractHourPeriodsRead.ts apps/api/src/services/contractHourPeriodsRead.test.ts apps/api/src/routes/contracts/hourPeriods.ts apps/api/src/routes/contracts/hourPeriods.test.ts apps/api/src/routes/contracts/index.ts
git commit -m "feat(billing): closed block-period history endpoint (#4547)

Paginated, newest first, contracts:read with org access. The ledger table is
org-axis, so the ordinary request context reads it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The AI tool and the partner API — the other doors

**Files:**
- Create: `apps/api/src/services/contractHourBlockLocked.ts` (+ `.test.ts`) — maps the strict update schema's refusal of the two server-stamped columns to `HOUR_BLOCK_FIELD_LOCKED`
- Modify: `apps/api/src/routes/contracts/lines.ts`, `apps/api/src/routes/partnerApi/contracts.ts` (pass the hook as `zValidator`'s third argument on PATCH)
- Modify: `apps/api/src/services/aiToolsContracts.ts` (the `line` / `patch` property descriptions, `:279-300`; the `update_line` catch)
- Modify: `apps/api/src/services/aiToolsContracts.manageContracts.test.ts`
- Modify: `apps/api/src/routes/partnerApi/contracts.test.ts`
- Modify: `apps/api/src/routes/contracts/contracts.test.ts` (POST/PATCH block cases)

**Interfaces:**
- Consumes: Task 1's schemas. The tool wraps `contractLineInputSchema` / `updateContractLineSchema` directly (`aiToolsContracts.ts:97-98`) and its own input schema is an open record (`aiToolSchemas.ts:658-659`, `aiAgentSdkTools.ts:3647-3648`), so **no schema change is needed for the tool to accept a block** — only its **description** must teach the model that the type and its fields exist.
- Produces: descriptions inside the frozen budget. `aiTools.descriptionBudget.contract.test.ts` has an **empty** baseline (`DESCRIPTION_BUDGET_BASELINE = new Map([])`, `:29`): tool descriptions ≤ 300, **every parameter description ≤ 160**, no workflow prose. Never add a baseline entry.

The partner API (`routes/partnerApi/contracts.ts:196-250`) uses the same two schemas inside a partner-scope context. It opens automatically with Task 1; it needs no code beyond the DELETE body done in Task 5. This task adds the tests that prove the public surface, because it is the one door the index does not list.

- [ ] **Step 1: Write the failing tests**

Append to `aiToolsContracts.manageContracts.test.ts`:

```ts
describe('manage_contracts — hour_block (#4547 W03)', () => {
  beforeEach(() => vi.clearAllMocks());
  const block = {
    lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
    includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'carry_forward',
    rolloverCapHours: '4', hourBlockAlertPct: 80,
  };

  it('add_line accepts a valid block and forwards it verbatim', async () => {
    const out = await getTool().handler({ action: 'add_line', contractId: 'contract-1', line: block }, auth);
    expect(contractService.addContractLineToContract).toHaveBeenCalledWith('contract-1', block, actor);
    expect(JSON.parse(out)).toMatchObject({ id: 'line-1' });
  });

  it("add_line rejects overageMode 'flag' on a block with a VALIDATION_ERROR naming the field", async () => {
    const parsed = JSON.parse(await getTool().handler({
      action: 'add_line', contractId: 'contract-1', line: { ...block, overageMode: 'flag', overageUnitPrice: undefined },
    }, auth));
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toMatch(/overageMode/);
    expect(contractService.addContractLineToContract).not.toHaveBeenCalled();
  });

  it('add_line rejects a block with no rolloverPolicy, and block fields on a flat line', async () => {
    const noPolicy = JSON.parse(await getTool().handler({ action: 'add_line', contractId: 'contract-1', line: { ...block, rolloverPolicy: undefined } }, auth));
    expect(noPolicy.code).toBe('VALIDATION_ERROR');
    const onFlat = JSON.parse(await getTool().handler({
      action: 'add_line', contractId: 'contract-1',
      line: { lineType: 'flat', description: 'x', unitPrice: '1.00', taxable: false, rolloverPolicy: 'none' },
    }, auth));
    expect(onFlat.code).toBe('VALIDATION_ERROR');
    expect(contractService.addContractLineToContract).not.toHaveBeenCalled();
  });

  it('a client-supplied first-period start never reaches the service', async () => {
    await getTool().handler({ action: 'add_line', contractId: 'contract-1', line: { ...block, hourBlockFirstPeriodStart: '2020-01-01' } }, auth);
    const forwarded = (contractService.addContractLineToContract as any).mock.calls[0][1];
    expect(forwarded).not.toHaveProperty('hourBlockFirstPeriodStart');
  });

  it('update_line accepts the patchable block fields; the server-stamped ones are HOUR_BLOCK_FIELD_LOCKED, not a generic validation error', async () => {
    await getTool().handler({ action: 'update_line', contractId: 'contract-1', lineId: 'line-1', patch: { rolloverCapHours: null, hourBlockAlertPct: 90 } }, auth);
    expect(contractService.updateContractLine).toHaveBeenCalledWith('contract-1', 'line-1', { rolloverCapHours: null, hourBlockAlertPct: 90 }, actor);
    (contractService.updateContractLine as any).mockClear();
    for (const key of ['hourBlockRetiredAt', 'hourBlockFirstPeriodStart']) {
      const bad = JSON.parse(await getTool().handler({ action: 'update_line', contractId: 'contract-1', lineId: 'line-1', patch: { [key]: '2026-01-01' } }, auth));
      expect(bad).toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED', details: { fields: [key] } });
    }
    // an unrelated unknown key stays an ordinary validation error
    const other = JSON.parse(await getTool().handler({ action: 'update_line', contractId: 'contract-1', lineId: 'line-1', patch: { lineType: 'flat' } }, auth));
    expect(other.code).toBe('VALIDATION_ERROR');
    expect(contractService.updateContractLine).not.toHaveBeenCalled();
  });

  it('remove_line reports whether the block was retired', async () => {
    (contractService.removeContractLine as any).mockResolvedValueOnce({
      orgId: 'org-1', contractId: 'contract-1', contractName: 'Acme MSA', contractLineId: 'line-1', lineType: 'hour_block', retired: true,
    });
    expect(JSON.parse(await getTool().handler({ action: 'remove_line', contractId: 'contract-1', lineId: 'line-1' }, auth)))
      .toEqual({ ok: true, retired: true });
  });

  it('the line description teaches the model that hour_block and its fields exist', () => {
    const props = getTool().definition.input_schema.properties as Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
    expect(props.line!.description).toContain('hour_block');
    for (const field of ['rolloverPolicy', 'rolloverCapHours', 'hourBlockAlertPct']) {
      expect(props.line!.properties).toHaveProperty(field);
      expect(props.patch!.properties).toHaveProperty(field);
    }
    expect(props.line!.properties!.includedQuantity!.description).toContain('hour_block');
  });
});
```

Append to `routes/contracts/contracts.test.ts` (next to the allowance route test at `:232`):

```ts
  it('POST /:id/lines accepts a valid block and 400s on each violation, with no service call (#4547 W03)', async () => {
    (svc.addContractLineToContract as any).mockResolvedValue({ id: LINE_ID, orgId: ORG_ID, lineType: 'hour_block', unitPrice: '1000.00', contractName: 'Acme' });
    const post = (body: unknown) => app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const ok = {
      lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
      includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none',
    };
    expect((await post(ok)).status).toBe(200);
    expect(svc.addContractLineToContract).toHaveBeenCalledTimes(1);
    for (const bad of [
      { ...ok, overageMode: 'flag', overageUnitPrice: undefined },
      { ...ok, rolloverPolicy: undefined },
      { ...ok, rolloverPolicy: 'none', rolloverCapHours: '4' },
      { ...ok, hourBlockAlertPct: 101 },
      { ...ok, siteId: ORG_ID },
    ]) expect((await post(bad)).status).toBe(400);
    expect(svc.addContractLineToContract).toHaveBeenCalledTimes(1);
  });

  it('POST maps a duplicate live block to 409 HOUR_BLOCK_EXISTS', async () => {
    (svc.addContractLineToContract as any).mockRejectedValue(new ContractServiceError('exists', 409, 'HOUR_BLOCK_EXISTS'));
    const res = await app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineType: 'hour_block', description: 'b', unitPrice: '1.00', taxable: false, includedQuantity: '1', overageMode: 'bill', overageUnitPrice: '1.00', rolloverPolicy: 'none' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'HOUR_BLOCK_EXISTS' });
  });

  it('PATCH rejects the server-stamped columns (strict) and maps HOUR_BLOCK_FIELD_LOCKED to 400', async () => {
    const patch = (body: unknown) => app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const key of ['hourBlockFirstPeriodStart', 'hourBlockRetiredAt']) {
      const res = await patch({ [key]: '2020-01-01' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED', details: { fields: [key] } });
    }
    expect(svc.updateContractLine).not.toHaveBeenCalled();
    // an unrelated unknown key is still the ordinary validation 400 (no code)
    const other = await patch({ lineType: 'flat' });
    expect(other.status).toBe(400);
    expect(await other.json()).not.toHaveProperty('code');
    (svc.updateContractLine as any).mockRejectedValueOnce(new ContractServiceError('locked', 400, 'HOUR_BLOCK_FIELD_LOCKED'));
    const locked = await patch({ overageMode: 'flag' });
    expect(locked.status).toBe(400);
    expect(await locked.json()).toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED' });
  });
```

`routes/partnerApi/contracts.test.ts` — inside the file's existing `POST /contracts/:id/lines` describe (mirror its harness): a valid block returns 201 and calls the service with the block fields; the same five invalid bodies return 400 with no service call; DELETE returns `{ data: { ok: true, retired: true } }` when the service reports `retired: true`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiToolsContracts.manageContracts.test.ts src/routes/contracts/contracts.test.ts src/routes/partnerApi/contracts.test.ts`
Expected: FAIL on the description test (no `hour_block` text, no `rolloverPolicy` property). The schema-driven cases already pass once Task 1 is in the checkout.

Create `contractHourBlockLocked.test.ts` first (red):

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { updateContractLineSchema } from '@breeze/shared';
import { stampedKeysFromZod, stampedKeysErrorBody } from './contractHourBlockLocked';

const failure = (body: unknown) => { const r = updateContractLineSchema.safeParse(body); if (r.success) throw new Error('expected failure'); return r.error; };

describe('server-stamped block columns on a line patch (#4547 W03)', () => {
  it('names exactly the stamped keys the strict schema refused', () => {
    expect(stampedKeysFromZod(failure({ hourBlockFirstPeriodStart: '2026-01-01' }))).toEqual(['hourBlockFirstPeriodStart']);
    expect(stampedKeysFromZod(failure({ hourBlockRetiredAt: 'x', hourBlockFirstPeriodStart: 'y' })).sort()).toEqual(['hourBlockFirstPeriodStart', 'hourBlockRetiredAt']);
  });
  it('ignores other unknown keys and other failures', () => {
    expect(stampedKeysFromZod(failure({ lineType: 'flat' }))).toEqual([]);
    expect(stampedKeysFromZod(failure({ unitPrice: 'abc' }))).toEqual([]);
  });
  it('builds the 400 body only when a stamped key is involved', () => {
    expect(stampedKeysErrorBody(failure({ hourBlockRetiredAt: 'x' }))).toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED', details: { fields: ['hourBlockRetiredAt'] } });
    expect(stampedKeysErrorBody(failure({ lineType: 'flat' }))).toBeNull();
    expect(stampedKeysErrorBody(new Error('boom'))).toBeNull();
    expect(stampedKeysErrorBody(new z.ZodError([]))).toBeNull();
  });
});
```

- [ ] **Step 3: Implement** the descriptions in `aiToolsContracts.ts` (each ≤ 160 characters; lengths measured), and the stamped-key mapping.

`apps/api/src/services/contractHourBlockLocked.ts`:

```ts
import { ZodError } from 'zod';

export const HOUR_BLOCK_STAMPED_KEYS = ['hourBlockFirstPeriodStart', 'hourBlockRetiredAt'] as const;

/** The server-stamped block columns a PATCH named and the strict update schema refused. */
export function stampedKeysFromZod(error: { issues: ReadonlyArray<{ code?: string; keys?: readonly string[] }> }): string[] {
  const out = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    for (const k of issue.keys ?? []) if ((HOUR_BLOCK_STAMPED_KEYS as readonly string[]).includes(k)) out.add(k);
  }
  return [...out];
}

/** 400 body for HOUR_BLOCK_FIELD_LOCKED, or null when the failure is not about a stamped key. */
export function stampedKeysErrorBody(err: unknown): { error: string; code: 'HOUR_BLOCK_FIELD_LOCKED'; details: { fields: string[] } } | null {
  if (!(err instanceof ZodError)) return null;
  const fields = stampedKeysFromZod(err);
  if (fields.length === 0) return null;
  return { error: `These fields are set by the server and cannot be changed: ${fields.join(', ')}`, code: 'HOUR_BLOCK_FIELD_LOCKED', details: { fields } };
}

/** zValidator hook (third argument) for the line PATCH routes: only the stamped-key failure is mapped; every
 *  other validation failure falls through to the shared readable 400. */
export function hourBlockStampedKeyHook(
  result: { success: boolean; error?: unknown },
  c: { json: (body: unknown, status: 400) => Response },
): Response | undefined {
  if (result.success) return undefined;
  const body = stampedKeysErrorBody(result.error);
  return body ? c.json(body, 400) : undefined;
}
```
Wire it: `lines.ts` PATCH — `zValidator('json', updateContractLineSchema, hourBlockStampedKeyHook)`; `partnerApi/contracts.ts` PATCH likewise; `aiToolsContracts.ts` — in the tool's `catch`, `const json = serviceErrorToJson(err) ?? zodErrorToJson(err);` becomes `const stamped = stampedKeysErrorBody(err); if (stamped) return JSON.stringify(stamped); const json = serviceErrorToJson(err) ?? zodErrorToJson(err);`. (The shared strict schema is unchanged: the keys are still refused; only the answer is typed.)

`properties.patch.description` (**replaces** "…Future periods only; generated invoices unchanged." — untrue for a block, Open Decision 15; ≤ 160, measured):
```
"Header (update) or line (update_line) patch; lineType immutable. siteId:null widens to org. Invoices unchanged; hour_block edits apply at open period close."
```
`properties.line.description` (151):
```
"Line: flat|per_device|per_device_role|per_device_group|per_seat|manual|hour_block (fields below). Contract currency prices; gaps fail, never converted."
```
`properties.line.properties` — replace three descriptions and add three keys:
```ts
includedQuantity: { type: 'string', description: 'Allowance: whole number for device/seat lines; hours per period (decimals ok) for hour_block. Bills a minimum. Supply with overageMode.' },       // 135
overageMode: { type: 'string', enum: ['bill', 'flag'], description: 'bill adds a sibling invoice line for excess units; flag reports excess without billing. hour_block must use bill.' },           // 113
overageUnitPrice: { type: 'string', description: 'Contract-currency price per excess unit (per extra hour on hour_block); required for overageMode bill. Allowance bills includedQuantity x unitPrice.' }, // 148
rolloverPolicy: { type: 'string', enum: ['none', 'carry_forward'], description: 'hour_block only, required: none (unused hours expire) or carry_forward (unused hours roll into the next period).' }, // 112
rolloverCapHours: { type: 'string', description: 'hour_block with carry_forward only: most hours that may roll over each period. Omit for no limit.' },                                                  // 97
hourBlockAlertPct: { type: 'integer', description: 'hour_block only: whole percent 1-100 of the block used that raises an alert. Optional.' },                                                          // 86
```
`properties.patch.properties` — update the two existing descriptions and add three keys:
```ts
includedQuantity: { type: ['string', 'null'], description: 'Allowance bills every period even if the live count is lower: a whole number, or hours (decimals ok) on hour_block. Rule applies to the merged line.' }, // 148
overageMode: { type: ['string', 'null'], enum: ['bill', 'flag', null], description: 'bill charges excess; flag reports it. Merged line needs includedQuantity and overageMode together; absent fields unchanged; null clears. hour_block stays bill.' }, // 159
rolloverPolicy: { type: 'string', enum: ['none', 'carry_forward'], description: 'hour_block: none or carry_forward. A switch to none needs rolloverCapHours null in the same patch.' },   // 98
rolloverCapHours: { type: ['string', 'null'], description: 'hour_block carry_forward: most hours rolled over per period; null removes the limit.' },                                                  // 84
hourBlockAlertPct: { type: ['integer', 'null'], description: 'hour_block: whole percent 1-100 that raises an alert; null removes it.' },                                                              // 70
```
(`overageUnitPrice` in `patch` is unchanged; the tool-level `definition.description` needs no change.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/aiToolsContracts.manageContracts.test.ts src/services/aiToolsContracts.test.ts src/services/aiToolsContracts.registryParity.contract.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/routes/contracts/contracts.test.ts src/routes/partnerApi/contracts.test.ts`
Expected: PASS, 6 files. The budget test is the gate on the description lengths (a `params` offence names the tool and the length).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsContracts.ts apps/api/src/services/aiToolsContracts.manageContracts.test.ts apps/api/src/routes/contracts/contracts.test.ts apps/api/src/routes/partnerApi/contracts.test.ts
git commit -m "feat(billing): teach the contracts tool about block-hours lines (#4547)

The tool's line schema is generic, so the descriptions spell out the type and
its fields within the parameter budget. HTTP and partner API behaviour for the
new line type is pinned by route tests.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Org merge refuses a pair that both hold a live block (index Open Decision 14)

**Files:**
- Modify: `apps/api/src/services/orgMerge.ts` (`loadAndValidate` `:334`, `assertPairStillMergeable` `:599`, new `assertNotBothHaveLiveHourBlock`)
- Modify: `apps/api/src/services/orgMerge.test.ts` (the `assertPairStillMergeable` describe, `:332`)
- Modify: `apps/api/src/__tests__/integration/orgMerge.integration.test.ts` (new describe at the end)
- Modify: `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` (one case pinning *why* the preflight is needed)

**Why it lands in W03.** `contract_lines` is a plain `repoint` in the merge registry (`orgMergeRegistry.ts:834`), and `contract_lines_one_live_hour_block_per_org_uq` is on `(org_id)`. Merging two orgs that each hold a live block would repoint the loser's block onto the survivor and fail mid-transaction with a 23505 — after the loser was fenced and its sockets closed. W03 is the wave that makes a block creatable, so it must also make the merge refuse the pair cleanly. (One live block on one side is fine: the repoint leaves exactly one.)

**Where.** The engine already has two pair-level validation points, both reachable before any destructive step: `loadAndValidate` (pre-fence; `executeOrgMerge` and `previewOrgMerge` both call it, `:1022`, `:1358`) and `assertPairStillMergeable` (inside the merge transaction, under the pair row lock, `:1073` — the TOCTOU recheck). Both throw `MergeValidationError`, "a refusal the caller can render as a 4xx — never an engine bug" (`:164-168`). `collectMergeBlockers` is the wrong home: it is loser-only and its `buildMergeBlockedMessage` is PAM/payment-specific. The new check is a **pair** property, so it joins the pair validators and runs at both points.

**Interfaces:**
- Produces:
  ```ts
  export const DUAL_LIVE_HOUR_BLOCK_MESSAGE = 'Both organizations have a live block of hours; retire one first';
  export async function assertNotBothHaveLiveHourBlock(loserOrgId: string, survivorOrgId: string): Promise<void>; // throws MergeValidationError
  ```
  The query must run in a system context: `contract_lines` is org-axis, and `loadAndValidate` wraps it; `assertPairStillMergeable` is already inside the merge's system transaction.

- [ ] **Step 1: Write the failing tests**

`orgMerge.test.ts` — in the `describe('assertPairStillMergeable …')` block (it queues one `execute()` response per call, FIFO; the new check issues a **second** `execute()`):

```ts
  it('rejects when BOTH organizations hold a live block of hours (the live-block index is per org)', async () => {
    mockState.executeResponses = [
      [row({}), row({ id: S, status: 'active' })],   // the pair lock read
      [{ org_id: L }, { org_id: S }],                // live hour_block lines: one per org
    ];
    await expect(assertPairStillMergeable(loser, survivor)).rejects.toThrow(/live block of hours/i);
  });

  it('passes when only one side holds a live block (the repoint leaves exactly one)', async () => {
    mockState.executeResponses = [[row({}), row({ id: S, status: 'active' })], [{ org_id: L }]];
    await expect(assertPairStillMergeable(loser, survivor)).resolves.toBeUndefined();
  });

  it('passes when neither does', async () => {
    mockState.executeResponses = [[row({}), row({ id: S, status: 'active' })], []];
    await expect(assertPairStillMergeable(loser, survivor)).resolves.toBeUndefined();
  });
```
The existing tests in that describe queue only the pair-lock response; the new query then gets `undefined` from the mocked queue. The implementation treats a non-array result as "no live blocks" so they stay green without edits.

`orgMerge.integration.test.ts` — append, following the PAM-refusal describe's shape (`:1529`). Seed with raw SQL through the file's `getTestDb()` (the same handle `snapshotOrgState`/`query` use):

```ts
describe('blocks-merge: both organizations hold a live block of hours (#4547 W03, Open Decision 14)', () => {
  let f: Fixture;
  beforeEach(async () => {
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    f = await seedFixture();
  });
  afterEach(() => vi.restoreAllMocks());

  /** One draft contract with one live (or retired) block line for `orgId`. */
  async function seedBlock(orgId: string, opts: { retired?: boolean } = {}): Promise<string> {
    const contractId = randomUUID();
    const lineId = randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO contracts (id, partner_id, org_id, name, status, billing_timing, interval_months, start_date, currency_code)
      VALUES (${contractId}::uuid, ${f.partner}::uuid, ${orgId}::uuid, 'Block contract', 'draft', 'advance', 1, '2026-12-01', 'USD')`);
    await getTestDb().execute(sql`
      INSERT INTO contract_lines (id, contract_id, org_id, line_type, description, unit_price, taxable,
        included_quantity, overage_mode, overage_unit_price, rollover_policy, hour_block_first_period_start, hour_block_retired_at)
      VALUES (${lineId}::uuid, ${contractId}::uuid, ${orgId}::uuid, 'hour_block', 'Support block', '1000.00', false,
        '10.00', 'bill', '150.00', 'none', '2026-12-01', ${opts.retired ? sql`now()` : sql`NULL`})`);
    return lineId;
  }

  it('preview and execute refuse the pair with the typed message; the loser is never fenced', async () => {
    await seedBlock(f.loser);
    await seedBlock(f.survivor);
    const before = await snapshotOrgState(f.loser);
    await expect(orgMergeModule.previewOrgMerge(f.loser, f.survivor, f.partner))
      .rejects.toMatchObject({ name: 'MergeValidationError', message: expect.stringContaining('live block of hours') });
    const fence = vi.spyOn(orgMergeModule, 'fenceLoser');
    await expect(orgMergeModule.executeOrgMerge({
      loserOrgId: f.loser, survivorOrgId: f.survivor, partnerId: f.partner,
      performedBy: f.actor, performedByEmail: f.actorEmail,
    })).rejects.toMatchObject({ name: 'MergeValidationError', message: expect.stringContaining('retire one first') });
    expect(fence).not.toHaveBeenCalled();
    expect(await snapshotOrgState(f.loser)).toEqual(before);
  });

  it('is allowed when only one side holds a live block, or when the other side is retired', async () => {
    await seedBlock(f.loser);
    await expect(orgMergeModule.previewOrgMerge(f.loser, f.survivor, f.partner)).resolves.toBeDefined();
    await seedBlock(f.survivor, { retired: true });
    await expect(orgMergeModule.previewOrgMerge(f.loser, f.survivor, f.partner)).resolves.toBeDefined();
  });
});
```
(Reuse the file's existing imports for `randomUUID`, `sql`, `getTestDb`, `orgMergeModule`, `vi`, `snapshotOrgState`.)

`orgMergeRegistry.integration.test.ts` — append (imports to add at the top: `import { partners, organizations, contracts, contractLines } from '../../db/schema'; import { isPgUniqueViolation } from '../../utils/pgErrors';`):

```ts
describe('contract_lines live-block index vs the merge registry (#4547 W03, Open Decision 14)', () => {
  it('contract_lines is a plain repoint, and repointing a second live block onto the same org violates the live-block index — the reason orgMerge refuses such a pair before it fences anything', async () => {
    expect(getOrgMergePolicies().get('contract_lines')).toMatchObject({ kind: 'repoint' });

    const sfx = randomUUID().slice(0, 8);
    const { a, b } = await withSystemDbAccessContext(async () => {
      const [p] = await db.insert(partners).values({ name: `MB ${sfx}`, slug: `mb-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
      const seed = async (tag: string) => {
        const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: `MB ${tag} ${sfx}`, slug: `mb-${tag}-${sfx}`, currencyCode: 'USD' }).returning({ id: organizations.id });
        const [c] = await db.insert(contracts).values({ partnerId: p!.id, orgId: o!.id, name: 'Block', status: 'draft', intervalMonths: 1, startDate: '2026-12-01', currencyCode: 'USD', billingTiming: 'advance' }).returning({ id: contracts.id });
        const [l] = await db.insert(contractLines).values({
          contractId: c!.id, orgId: o!.id, lineType: 'hour_block', description: 'Block', unitPrice: '1.00', taxable: false,
          includedQuantity: '1.00', overageMode: 'bill', overageUnitPrice: '1.00', rolloverPolicy: 'none', hourBlockFirstPeriodStart: '2026-12-01',
        }).returning({ id: contractLines.id });
        return { orgId: o!.id, lineId: l!.id };
      };
      return { a: await seed('a'), b: await seed('b') };
    });

    // What the registry's plain repoint does to the loser's block (constraints deferred, as the merge walk does).
    const err = await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      try {
        await db.execute(sql`UPDATE contract_lines SET org_id = ${b.orgId}::uuid WHERE id = ${a.lineId}::uuid`);
        return null;
      } catch (e) { return e; }
    });
    expect(isPgUniqueViolation(err, 'contract_lines_one_live_hour_block_per_org_uq')).toBe(true);
  });
});
```
(If the registry ever moves `contract_lines` to a custom executor that handles the collision, this case fails on its first assertion and the preflight can be revisited — that is its job.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/orgMerge.test.ts`
Expected: FAIL on the first new case (no refusal). Integration (needs `pnpm test-stack up`): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgMerge.integration.test.ts` — the new describe FAILS (preview resolves for the dual-block pair).

- [ ] **Step 3: Implement** in `orgMerge.ts`:

```ts
export const DUAL_LIVE_HOUR_BLOCK_MESSAGE = 'Both organizations have a live block of hours; retire one first';

/**
 * #4547 W03 (index Open Decision 14). `contract_lines` merges by plain repoint and
 * contract_lines_one_live_hour_block_per_org_uq is on (org_id): two orgs that each
 * hold a live block would 23505 mid-walk, after the loser was fenced. A PAIR
 * property (loser-only collectMergeBlockers cannot see it), so it joins the pair
 * validators. One side live, or one side retired, is fine. Runs in a system
 * context (contract_lines is org-axis; the caller wraps it or is already in the
 * merge transaction).
 */
export async function assertNotBothHaveLiveHourBlock(loserOrgId: string, survivorOrgId: string): Promise<void> {
  const rows = (await dbModule.db.execute(sql`
    SELECT DISTINCT org_id
      FROM contract_lines
     WHERE line_type = 'hour_block'
       AND hour_block_retired_at IS NULL
       AND org_id IN (${uuid(loserOrgId)}, ${uuid(survivorOrgId)})`)) as unknown;
  if (Array.isArray(rows) && rows.length >= 2) throw new MergeValidationError(DUAL_LIVE_HOUR_BLOCK_MESSAGE);
}
```
Call sites:
- `loadAndValidate`, after `if (reason) throw …` (`:371-372`):
  ```ts
  await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(() => assertNotBothHaveLiveHourBlock(loser.id, survivor.id)),
  );
  ```
- `assertPairStillMergeable`, after the `if (reason) { throw … }` block (`:652-654`), still inside the merge transaction:
  ```ts
  await assertNotBothHaveLiveHourBlock(loser.id, survivor.id);
  ```
  (Direct call, not `self.`: it is the same module and the existing unit tests of `assertPairStillMergeable` drive it directly.)

Because `executeOrgMerge` calls `self.loadAndValidate` first, the refusal happens **before** `fenceLoser`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/orgMerge.test.ts src/services/orgMergeRegistry.test.ts` (and the **full** `orgMerge.test.ts` once — CLAUDE.md notes some merge contracts only red in the full unit suite). Then the integration file above and `orgMergeRegistry.integration.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgMerge.ts apps/api/src/services/orgMerge.test.ts apps/api/src/__tests__/integration/orgMerge.integration.test.ts
git commit -m "fix(orgs): refuse a merge when both organizations hold a live block of hours (#4547)

The live-block unique index is per organization, so repointing the loser's
block onto a survivor that has its own would fail mid-merge. The pair is now
refused before the loser is fenced, and again inside the merge transaction.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Locale keys — eight locales, real translations

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json` and `…/tickets.json`

**Interfaces (the key set the later web tasks consume):**

| Key (billing namespace unless noted) | Used by |
|---|---|
| `contracts.shared.lineType.hourBlock` | `LINE_TYPE_LABELS` (editor, detail) |
| `contracts.hourBlock.form.{hoursPerPeriod, extraRate, rolloverMode, rolloverExpire, rolloverCarry, carryCap, alertPct, required, firstPeriod, midPeriodEdit, midPeriodEditNoDates, onlyOne}` | editor add + edit forms |
| `contracts.hourBlock.row.{perPeriod, retiredBadge, startsOn}` | `AllowanceCell`, editor/detail line rows |
| `contracts.hourBlock.errors.{exists, locked}` | editor `friendly` maps |
| `contracts.hourBlock.retire.{title, message, confirm, toast}` | remove-confirm dialog, success toast |
| `contracts.hourBlock.detail.{title, usage, carried, unapproved, foreign, over, advanceNote, arrearsNote, lateEntry, startsLater, extraRate, loadFailed}` | `HourBlockPanel` |
| `contracts.hourBlock.history.{title, empty, included, carriedIn, used, over, carriedOut, loadMore, invoiceRemoved}` | `HourBlockPanel` history |
| `invoicesPage.dialog.heldForHourBlock_one/_other` | `InvoicesPage` (Task 13) |
| `tickets`: `ticketWorkbench.invoice.heldForHourBlock_one/_other` | `TicketWorkbench` (Task 13) |

**Traps this task is built around (CLAUDE.md "Testing Standards", `apps/web/src/locales/README.md`):**
- `translationCoverage.test.ts` caps exact-English duplicates per locale and namespace (`billing.json` is capped at 58–61 depending on locale). **Never raise a cap.** Every value below differs from English in every locale; if a locale test reds, change the translation.
- `humanizedKeyRegression.test.ts` flags a key whose leaf is 4+ camel-case words and whose value is that humanized leaf. Every leaf here is ≤ 3 words.
- `localeParity.test.ts` pins identical keys **and identical `{{interpolation}}` token sets** across locales; the plural pairs use `_one` / `_other` like every other pair in these files.
- Files are exactly `JSON.stringify(obj, null, 2) + "\n"` (verified for all eight), so a deep-merge script rewrites them byte-stably.
- Machine-drafted copy: the PR description must say `pt-BR strings are machine-drafted pending native review` and `es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review` (README). tr-TR is reviewed the same way.

- [ ] **Step 1: Run the parity suites first (they pass, and prove the harness works)**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/locales/humanizedKeyRegression.test.ts`
Expected: PASS (3 files). This is the baseline the merge must keep green. (There is no red step for a pure data change; the red proof is Task 11/12's component tests, which assert on the English strings and fail until these keys exist.)

- [ ] **Step 2: Save the merge script to a scratch path outside the repo** (e.g. `/tmp/merge-hourblock-i18n.mjs`; it is not committed) and run it from `apps/web`: `node /tmp/merge-hourblock-i18n.mjs`.

```js
import fs from 'node:fs';
import path from 'node:path';

const LOCALES_DIR = path.resolve('src/locales');

// One object per locale: { billing: {...}, tickets: {...} }. `h` is the shared
// block under contracts.hourBlock; `held` is the plural pair.
const L = {
  en: {
    line: 'Block hours',
    h: {
      form: {
        hoursPerPeriod: 'Hours included per period',
        extraRate: 'Price per extra hour',
        rolloverMode: 'Unused hours at period end',
        rolloverExpire: 'Expire',
        rolloverCarry: 'Carry forward',
        carryCap: 'Carry-forward limit in hours (blank for no limit)',
        alertPct: 'Alert at % of block used (optional)',
        required: 'Enter the included hours and the price per extra hour.',
        firstPeriod: 'Hours count from the first billing period still to be invoiced; on a draft contract this is set when it is activated. Earlier time bills as usual.',
        midPeriodEdit: "Changes apply to the current open period ({{start}} – {{end}}) at its close.",
        midPeriodEditNoDates: "Changes apply to the current open period at its close.",
        onlyOne: 'This organization already has an active block. Retire it before adding another.',
      },
      row: { perPeriod: '{{hours}} hours per period', retiredBadge: 'Retired', startsOn: 'Counts from {{date}}' },
      errors: {
        exists: 'This organization already has an active block-hours line. Retire it first, then add the new one.',
        locked: "That field can't be changed on a block-hours line.",
      },
      retire: {
        title: 'Retire block hours',
        message: "\"{{description}}\" has billing history, so it is retired instead of deleted. No new periods; already-billed periods still settle. Its closed periods stay on the contract.",
        confirm: 'Retire block',
        toast: 'Block hours retired',
      },
      detail: {
        title: 'Block hours',
        usage: '{{used}} of {{included}} hours used · {{remaining}} remaining · period ends {{end}}',
        carried: 'Includes {{hours}} hours carried forward.',
        unapproved: '{{hours}} hours of this time are not yet approved.',
        foreign: '{{hours}} hours were logged in another currency; they still draw down the block.',
        over: '{{hours}} hours over the block → {{amount}} at period close',
        advanceNote: 'Overage bills on the following invoice.',
        arrearsNote: "Overage bills on this period's invoice.",
        lateEntry: '{{hours}} hours were entered after their period closed and bill separately.',
        startsLater: "Block starts {{date}}.",
        extraRate: 'Extra hours: {{rate}} each',
        loadFailed: "Block usage couldn't be loaded.",
      },
      history: {
        title: 'Closed block periods', empty: 'No block period has closed yet.', included: 'Included',
        carriedIn: 'Carried in', used: 'Used', over: 'Over', carriedOut: 'Carried out', loadMore: 'Load more',
        invoiceRemoved: "Overage invoice removed — hours not billed",
      },
    },
    held: {
      one: "{{count}} time entry ({{hours}} hours) is held for this organization's block hours and will be billed when the block period closes.",
      other: "{{count}} time entries ({{hours}} hours) are held for this organization's block hours and will be billed when the block period closes.",
    },
  },

  'de-DE': {
    line: 'Stundenkontingent',
    h: {
      form: {
        hoursPerPeriod: 'Enthaltene Stunden pro Zeitraum',
        extraRate: 'Preis pro zusätzlicher Stunde',
        rolloverMode: 'Ungenutzte Stunden am Zeitraumende',
        rolloverExpire: 'Verfallen',
        rolloverCarry: 'Übertragen',
        carryCap: 'Übertragslimit in Stunden (leer für unbegrenzt)',
        alertPct: 'Warnung bei % des Kontingents (optional)',
        required: 'Geben Sie die enthaltenen Stunden und den Preis pro zusätzlicher Stunde ein.',
        firstPeriod: 'Die Stunden zählen ab dem ersten Abrechnungszeitraum, der noch nicht abgerechnet wurde; bei einem Entwurf wird er bei der Aktivierung festgelegt. Frühere Zeit wird wie gewohnt abgerechnet.',
        midPeriodEdit: "Änderungen gelten für den laufenden Zeitraum ({{start}} – {{end}}) bei dessen Abschluss.",
        midPeriodEditNoDates: "Änderungen gelten für den laufenden Zeitraum bei dessen Abschluss.",
        onlyOne: 'Diese Organisation hat bereits ein aktives Kontingent. Beenden Sie es, bevor Sie ein weiteres hinzufügen.',
      },
      row: { perPeriod: '{{hours}} Stunden pro Zeitraum', retiredBadge: 'Beendet', startsOn: 'Zählt ab {{date}}' },
      errors: {
        exists: 'Diese Organisation hat bereits eine aktive Stundenkontingent-Position. Beenden Sie sie zuerst und fügen Sie dann die neue hinzu.',
        locked: 'Dieses Feld kann bei einer Stundenkontingent-Position nicht geändert werden.',
      },
      retire: {
        title: 'Stundenkontingent beenden',
        message: "„{{description}}“ hat eine Abrechnungshistorie und wird daher beendet statt gelöscht. Keine neuen Zeiträume; bereits abgerechnete Zeiträume werden weiterhin abgeschlossen. Abgeschlossene Zeiträume bleiben im Vertrag.",
        confirm: 'Kontingent beenden',
        toast: 'Stundenkontingent beendet',
      },
      detail: {
        title: 'Stundenkontingent',
        usage: '{{used}} von {{included}} Stunden verbraucht · {{remaining}} verbleibend · Zeitraum endet am {{end}}',
        carried: 'Enthält {{hours}} übertragene Stunden.',
        unapproved: '{{hours}} Stunden dieser Zeit sind noch nicht genehmigt.',
        foreign: '{{hours}} Stunden wurden in einer anderen Währung erfasst; sie verbrauchen das Kontingent trotzdem.',
        over: '{{hours}} Stunden über dem Kontingent → {{amount}} bei Zeitraumabschluss',
        advanceNote: 'Mehrstunden werden auf der folgenden Rechnung abgerechnet.',
        arrearsNote: 'Mehrstunden werden auf der Rechnung für diesen Zeitraum abgerechnet.',
        lateEntry: '{{hours}} Stunden wurden nach Abschluss ihres Zeitraums erfasst und werden separat abgerechnet.',
        startsLater: "Das Kontingent beginnt am {{date}}.",
        extraRate: 'Zusätzliche Stunden: je {{rate}}',
        loadFailed: 'Die Kontingentnutzung konnte nicht geladen werden.',
      },
      history: {
        title: 'Abgeschlossene Kontingentzeiträume', empty: 'Noch kein Kontingentzeitraum abgeschlossen.', included: 'Enthalten',
        carriedIn: 'Übertrag Eingang', used: 'Verbraucht', over: 'Darüber', carriedOut: 'Übertrag Ausgang', loadMore: 'Mehr laden',
        invoiceRemoved: "Mehrstunden-Rechnung entfernt – Stunden nicht abgerechnet",
      },
    },
    held: {
      one: '{{count}} Zeiteintrag ({{hours}} Stunden) wird für das Stundenkontingent dieser Organisation zurückgehalten und abgerechnet, sobald der Kontingentzeitraum abgeschlossen ist.',
      other: '{{count}} Zeiteinträge ({{hours}} Stunden) werden für das Stundenkontingent dieser Organisation zurückgehalten und abgerechnet, sobald der Kontingentzeitraum abgeschlossen ist.',
    },
  },

  'es-419': {
    line: 'Bolsa de horas',
    h: {
      form: {
        hoursPerPeriod: 'Horas incluidas por período',
        extraRate: 'Precio por hora adicional',
        rolloverMode: 'Horas sin usar al final del período',
        rolloverExpire: 'Vencen',
        rolloverCarry: 'Se trasladan',
        carryCap: 'Límite de horas trasladables (vacío para sin límite)',
        alertPct: 'Alertar al usar este % de la bolsa (opcional)',
        required: 'Ingresa las horas incluidas y el precio por hora adicional.',
        firstPeriod: 'Las horas cuentan desde el primer período de facturación aún por facturar; en un contrato en borrador se define al activarlo. El tiempo anterior se factura como de costumbre.',
        midPeriodEdit: "Los cambios se aplican al período abierto actual ({{start}} – {{end}}) cuando se cierre.",
        midPeriodEditNoDates: "Los cambios se aplican al período abierto actual cuando se cierre.",
        onlyOne: 'Esta organización ya tiene una bolsa activa. Retírala antes de agregar otra.',
      },
      row: { perPeriod: '{{hours}} horas por período', retiredBadge: 'Retirada', startsOn: 'Cuenta desde {{date}}' },
      errors: {
        exists: 'Esta organización ya tiene una línea de bolsa de horas activa. Retírala primero y luego agrega la nueva.',
        locked: 'Ese campo no se puede cambiar en una línea de bolsa de horas.',
      },
      retire: {
        title: 'Retirar bolsa de horas',
        message: "«{{description}}» tiene historial de facturación, por lo que se retira en lugar de eliminarse. No habrá períodos nuevos; los períodos ya facturados se siguen liquidando. Los períodos cerrados permanecen en el contrato.",
        confirm: 'Retirar bolsa',
        toast: 'Bolsa de horas retirada',
      },
      detail: {
        title: 'Bolsa de horas',
        usage: '{{used}} de {{included}} horas usadas · {{remaining}} restantes · el período termina el {{end}}',
        carried: 'Incluye {{hours}} horas trasladadas.',
        unapproved: '{{hours}} horas de este tiempo aún no están aprobadas.',
        foreign: '{{hours}} horas se registraron en otra moneda; igualmente descuentan de la bolsa.',
        over: '{{hours}} horas por encima de la bolsa → {{amount}} al cierre del período',
        advanceNote: 'El exceso se factura en la factura siguiente.',
        arrearsNote: 'El exceso se factura en la factura de este período.',
        lateEntry: '{{hours}} horas se registraron después del cierre de su período y se facturan por separado.',
        startsLater: "La bolsa comienza el {{date}}.",
        extraRate: 'Horas adicionales: {{rate}} cada una',
        loadFailed: 'No se pudo cargar el uso de la bolsa.',
      },
      history: {
        title: 'Períodos de bolsa cerrados', empty: 'Aún no se ha cerrado ningún período de bolsa.', included: 'Incluidas',
        carriedIn: 'Trasladadas de entrada', used: 'Usadas', over: 'Exceso', carriedOut: 'Trasladadas de salida', loadMore: 'Cargar más',
        invoiceRemoved: "Factura del exceso eliminada: horas no facturadas",
      },
    },
    held: {
      one: '{{count}} registro de tiempo ({{hours}} horas) está retenido para la bolsa de horas de esta organización y se facturará cuando se cierre el período de la bolsa.',
      other: '{{count}} registros de tiempo ({{hours}} horas) están retenidos para la bolsa de horas de esta organización y se facturarán cuando se cierre el período de la bolsa.',
    },
  },

  'pt-BR': {
    line: 'Banco de horas',
    h: {
      form: {
        hoursPerPeriod: 'Horas incluídas por período',
        extraRate: 'Preço por hora extra',
        rolloverMode: 'Horas não usadas no fim do período',
        rolloverExpire: 'Expiram',
        rolloverCarry: 'Acumulam',
        carryCap: 'Limite de horas acumuláveis (vazio para sem limite)',
        alertPct: 'Alertar ao usar este % do banco (opcional)',
        required: 'Informe as horas incluídas e o preço por hora extra.',
        firstPeriod: 'As horas contam a partir do primeiro período de cobrança ainda não faturado; em um contrato em rascunho isso é definido na ativação. O tempo anterior é cobrado normalmente.',
        midPeriodEdit: "As alterações valem para o período aberto atual ({{start}} – {{end}}) quando ele for encerrado.",
        midPeriodEditNoDates: "As alterações valem para o período aberto atual quando ele for encerrado.",
        onlyOne: 'Esta organização já tem um banco ativo. Desative-o antes de adicionar outro.',
      },
      row: { perPeriod: '{{hours}} horas por período', retiredBadge: 'Desativado', startsOn: 'Conta a partir de {{date}}' },
      errors: {
        exists: 'Esta organização já tem uma linha de banco de horas ativa. Desative-a primeiro e depois adicione a nova.',
        locked: 'Esse campo não pode ser alterado em uma linha de banco de horas.',
      },
      retire: {
        title: 'Desativar banco de horas',
        message: "\"{{description}}\" tem histórico de cobrança, por isso é desativado em vez de excluído. Sem novos períodos; os períodos já faturados ainda são liquidados. Os períodos encerrados permanecem no contrato.",
        confirm: 'Desativar banco',
        toast: 'Banco de horas desativado',
      },
      detail: {
        title: 'Banco de horas',
        usage: '{{used}} de {{included}} horas usadas · {{remaining}} restantes · o período termina em {{end}}',
        carried: 'Inclui {{hours}} horas acumuladas.',
        unapproved: '{{hours}} horas deste tempo ainda não foram aprovadas.',
        foreign: '{{hours}} horas foram registradas em outra moeda; elas ainda consomem o banco.',
        over: '{{hours}} horas acima do banco → {{amount}} no fechamento do período',
        advanceNote: 'O excedente é cobrado na fatura seguinte.',
        arrearsNote: 'O excedente é cobrado na fatura deste período.',
        lateEntry: '{{hours}} horas foram lançadas depois do fechamento do período e são cobradas separadamente.',
        startsLater: "O banco começa em {{date}}.",
        extraRate: 'Horas extras: {{rate}} cada',
        loadFailed: 'Não foi possível carregar o uso do banco.',
      },
      history: {
        title: 'Períodos do banco encerrados', empty: 'Nenhum período do banco foi encerrado ainda.', included: 'Incluídas',
        carriedIn: 'Acumuladas na entrada', used: 'Usadas', over: 'Excedente', carriedOut: 'Acumuladas na saída', loadMore: 'Carregar mais',
        invoiceRemoved: "Fatura do excedente removida — horas não cobradas",
      },
    },
    held: {
      one: '{{count}} lançamento de tempo ({{hours}} horas) está retido para o banco de horas desta organização e será cobrado quando o período do banco for encerrado.',
      other: '{{count}} lançamentos de tempo ({{hours}} horas) estão retidos para o banco de horas desta organização e serão cobrados quando o período do banco for encerrado.',
    },
  },

  'fr-FR': {
    line: "Forfait d'heures",
    h: {
      form: {
        hoursPerPeriod: 'Heures incluses par période',
        extraRate: 'Prix par heure supplémentaire',
        rolloverMode: 'Heures non utilisées en fin de période',
        rolloverExpire: 'Expirent',
        rolloverCarry: 'Reportées',
        carryCap: 'Plafond de report en heures (vide pour illimité)',
        alertPct: 'Alerter à ce % du forfait consommé (facultatif)',
        required: 'Saisissez les heures incluses et le prix par heure supplémentaire.',
        firstPeriod: "Les heures comptent à partir de la première période de facturation encore à facturer ; pour un contrat brouillon, elle est fixée à l'activation. Le temps antérieur est facturé comme d'habitude.",
        midPeriodEdit: "Les modifications s'appliquent à la période en cours ({{start}} – {{end}}) à sa clôture.",
        midPeriodEditNoDates: "Les modifications s'appliquent à la période en cours à sa clôture.",
        onlyOne: "Cette organisation a déjà un forfait actif. Retirez-le avant d'en ajouter un autre.",
      },
      row: { perPeriod: '{{hours}} heures par période', retiredBadge: 'Retiré', startsOn: 'Compte à partir du {{date}}' },
      errors: {
        exists: "Cette organisation a déjà une ligne de forfait d'heures active. Retirez-la d'abord, puis ajoutez la nouvelle.",
        locked: "Ce champ ne peut pas être modifié sur une ligne de forfait d'heures.",
      },
      retire: {
        title: "Retirer le forfait d'heures",
        message: "« {{description}} » a un historique de facturation ; il est donc retiré au lieu d'être supprimé. Plus de nouvelles périodes ; les périodes déjà facturées sont toujours réglées. Les périodes clôturées restent dans le contrat.",
        confirm: 'Retirer le forfait',
        toast: "Forfait d'heures retiré",
      },
      detail: {
        title: "Forfait d'heures",
        usage: '{{used}} heures utilisées sur {{included}} · {{remaining}} restantes · la période se termine le {{end}}',
        carried: 'Comprend {{hours}} heures reportées.',
        unapproved: "{{hours}} heures de ce temps ne sont pas encore approuvées.",
        foreign: '{{hours}} heures ont été saisies dans une autre devise ; elles décomptent quand même le forfait.',
        over: '{{hours}} heures au-delà du forfait → {{amount}} à la clôture de la période',
        advanceNote: 'Le dépassement est facturé sur la facture suivante.',
        arrearsNote: 'Le dépassement est facturé sur la facture de cette période.',
        lateEntry: '{{hours}} heures ont été saisies après la clôture de leur période et sont facturées séparément.',
        startsLater: "Le forfait commence le {{date}}.",
        extraRate: 'Heures supplémentaires : {{rate}} chacune',
        loadFailed: "Impossible de charger la consommation du forfait.",
      },
      history: {
        title: 'Périodes de forfait clôturées', empty: "Aucune période de forfait n'a encore été clôturée.", included: 'Incluses',
        carriedIn: 'Reportées en entrée', used: 'Utilisées', over: 'Dépassement', carriedOut: 'Reportées en sortie', loadMore: 'Charger plus',
        invoiceRemoved: "Facture du dépassement supprimée — heures non facturées",
      },
    },
    held: {
      one: "{{count}} saisie de temps ({{hours}} heures) est retenue pour le forfait d'heures de cette organisation et sera facturée à la clôture de la période du forfait.",
      other: "{{count}} saisies de temps ({{hours}} heures) sont retenues pour le forfait d'heures de cette organisation et seront facturées à la clôture de la période du forfait.",
    },
  },

  'fr-CA': {
    line: "Banque d'heures",
    h: {
      form: {
        hoursPerPeriod: 'Heures incluses par période',
        extraRate: 'Prix par heure supplémentaire',
        rolloverMode: 'Heures inutilisées à la fin de la période',
        rolloverExpire: 'Expirent',
        rolloverCarry: 'Reportées',
        carryCap: 'Plafond de report en heures (vide pour aucune limite)',
        alertPct: "Alerter à ce % de la banque utilisé (facultatif)",
        required: 'Saisissez les heures incluses et le prix par heure supplémentaire.',
        firstPeriod: "Les heures comptent à partir de la première période de facturation encore à facturer; pour un contrat brouillon, elle est fixée à l'activation. Le temps antérieur est facturé comme d'habitude.",
        midPeriodEdit: "Les modifications s'appliquent à la période en cours ({{start}} – {{end}}) à sa clôture.",
        midPeriodEditNoDates: "Les modifications s'appliquent à la période en cours à sa clôture.",
        onlyOne: "Cette organisation a déjà une banque active. Retirez-la avant d'en ajouter une autre.",
      },
      row: { perPeriod: '{{hours}} heures par période', retiredBadge: 'Retirée', startsOn: 'Compte à partir du {{date}}' },
      errors: {
        exists: "Cette organisation a déjà une ligne de banque d'heures active. Retirez-la d'abord, puis ajoutez la nouvelle.",
        locked: "Ce champ ne peut pas être modifié sur une ligne de banque d'heures.",
      },
      retire: {
        title: "Retirer la banque d'heures",
        message: "« {{description}} » a un historique de facturation; elle est donc retirée plutôt que supprimée. Plus de nouvelles périodes; les périodes déjà facturées sont tout de même réglées. Les périodes clôturées restent au contrat.",
        confirm: 'Retirer la banque',
        toast: "Banque d'heures retirée",
      },
      detail: {
        title: "Banque d'heures",
        usage: '{{used}} heures utilisées sur {{included}} · {{remaining}} restantes · la période se termine le {{end}}',
        carried: 'Comprend {{hours}} heures reportées.',
        unapproved: "{{hours}} heures de ce temps ne sont pas encore approuvées.",
        foreign: '{{hours}} heures ont été saisies dans une autre devise; elles réduisent quand même la banque.',
        over: '{{hours}} heures au-delà de la banque → {{amount}} à la clôture de la période',
        advanceNote: 'Le dépassement est facturé sur la facture suivante.',
        arrearsNote: 'Le dépassement est facturé sur la facture de cette période.',
        lateEntry: '{{hours}} heures ont été saisies après la clôture de leur période et sont facturées séparément.',
        startsLater: "La banque commence le {{date}}.",
        extraRate: 'Heures supplémentaires : {{rate}} chacune',
        loadFailed: "Impossible de charger l'utilisation de la banque.",
      },
      history: {
        title: 'Périodes de banque clôturées', empty: "Aucune période de banque n'a encore été clôturée.", included: 'Incluses',
        carriedIn: 'Reportées en entrée', used: 'Utilisées', over: 'Dépassement', carriedOut: 'Reportées en sortie', loadMore: 'Charger plus',
        invoiceRemoved: "Facture du dépassement supprimée — heures non facturées",
      },
    },
    held: {
      one: "{{count}} saisie de temps ({{hours}} heures) est retenue pour la banque d'heures de cette organisation et sera facturée à la clôture de la période de la banque.",
      other: "{{count}} saisies de temps ({{hours}} heures) sont retenues pour la banque d'heures de cette organisation et seront facturées à la clôture de la période de la banque.",
    },
  },

  'it-IT': {
    line: 'Monte ore',
    h: {
      form: {
        hoursPerPeriod: 'Ore incluse per periodo',
        extraRate: 'Prezzo per ora aggiuntiva',
        rolloverMode: 'Ore non utilizzate a fine periodo',
        rolloverExpire: 'Scadono',
        rolloverCarry: 'Riportate',
        carryCap: 'Limite di ore riportabili (vuoto per nessun limite)',
        alertPct: 'Avvisa al % del monte ore utilizzato (facoltativo)',
        required: 'Inserisci le ore incluse e il prezzo per ora aggiuntiva.',
        firstPeriod: "Le ore contano dal primo periodo di fatturazione ancora da fatturare; in un contratto in bozza viene stabilito all'attivazione. Il tempo precedente viene fatturato come di consueto.",
        midPeriodEdit: "Le modifiche si applicano al periodo aperto corrente ({{start}} – {{end}}) alla sua chiusura.",
        midPeriodEditNoDates: "Le modifiche si applicano al periodo aperto corrente alla sua chiusura.",
        onlyOne: 'Questa organizzazione ha già un monte ore attivo. Ritiralo prima di aggiungerne un altro.',
      },
      row: { perPeriod: '{{hours}} ore per periodo', retiredBadge: 'Ritirato', startsOn: 'Conta dal {{date}}' },
      errors: {
        exists: 'Questa organizzazione ha già una riga di monte ore attiva. Ritirala prima, poi aggiungi quella nuova.',
        locked: 'Questo campo non può essere modificato su una riga di monte ore.',
      },
      retire: {
        title: 'Ritira il monte ore',
        message: "«{{description}}» ha uno storico di fatturazione, quindi viene ritirato anziché eliminato. Nessun nuovo periodo; i periodi già fatturati vengono comunque regolati. I periodi chiusi restano nel contratto.",
        confirm: 'Ritira monte ore',
        toast: 'Monte ore ritirato',
      },
      detail: {
        title: 'Monte ore',
        usage: '{{used}} di {{included}} ore usate · {{remaining}} rimanenti · il periodo termina il {{end}}',
        carried: 'Include {{hours}} ore riportate.',
        unapproved: '{{hours}} ore di questo tempo non sono ancora approvate.',
        foreign: "{{hours}} ore sono state registrate in un'altra valuta; consumano comunque il monte ore.",
        over: '{{hours}} ore oltre il monte ore → {{amount}} alla chiusura del periodo',
        advanceNote: "L'eccedenza viene fatturata nella fattura successiva.",
        arrearsNote: "L'eccedenza viene fatturata nella fattura di questo periodo.",
        lateEntry: '{{hours}} ore sono state inserite dopo la chiusura del loro periodo e vengono fatturate separatamente.',
        startsLater: "Il monte ore inizia il {{date}}.",
        extraRate: 'Ore aggiuntive: {{rate}} ciascuna',
        loadFailed: "Impossibile caricare l'utilizzo del monte ore.",
      },
      history: {
        title: 'Periodi di monte ore chiusi', empty: 'Nessun periodo di monte ore è ancora stato chiuso.', included: 'Incluse',
        carriedIn: 'Riportate in ingresso', used: 'Usate', over: 'Eccedenza', carriedOut: 'Riportate in uscita', loadMore: 'Carica altro',
        invoiceRemoved: "Fattura dell'eccedenza rimossa — ore non fatturate",
      },
    },
    held: {
      one: '{{count}} registrazione di tempo ({{hours}} ore) è trattenuta per il monte ore di questa organizzazione e verrà fatturata alla chiusura del periodo del monte ore.',
      other: '{{count}} registrazioni di tempo ({{hours}} ore) sono trattenute per il monte ore di questa organizzazione e verranno fatturate alla chiusura del periodo del monte ore.',
    },
  },

  'tr-TR': {
    line: 'Saat paketi',
    h: {
      form: {
        hoursPerPeriod: 'Dönem başına dahil saat',
        extraRate: 'Ek saat başına fiyat',
        rolloverMode: 'Dönem sonunda kullanılmayan saatler',
        rolloverExpire: 'Sona erer',
        rolloverCarry: 'Sonraki döneme aktarılır',
        carryCap: 'Aktarım sınırı (saat; sınırsız için boş bırakın)',
        alertPct: "Paketin bu %'si kullanıldığında uyar (isteğe bağlı)",
        required: 'Dahil saatleri ve ek saat başına fiyatı girin.',
        firstPeriod: 'Saatler, henüz faturalanmamış ilk faturalama döneminden itibaren sayılır; taslak sözleşmede bu, etkinleştirildiğinde belirlenir. Öncesindeki süre her zamanki gibi faturalanır.',
        midPeriodEdit: "Değişiklikler, mevcut açık döneme ({{start}} – {{end}}) dönem kapandığında uygulanır.",
        midPeriodEditNoDates: "Değişiklikler, mevcut açık döneme dönem kapandığında uygulanır.",
        onlyOne: 'Bu kuruluşun zaten etkin bir saat paketi var. Yenisini eklemeden önce onu kullanımdan kaldırın.',
      },
      row: { perPeriod: 'Dönem başına {{hours}} saat', retiredBadge: 'Kullanımdan kaldırıldı', startsOn: '{{date}} tarihinden itibaren sayılır' },
      errors: {
        exists: 'Bu kuruluşun zaten etkin bir saat paketi satırı var. Önce onu kullanımdan kaldırın, ardından yenisini ekleyin.',
        locked: 'Bu alan bir saat paketi satırında değiştirilemez.',
      },
      retire: {
        title: 'Saat paketini kullanımdan kaldır',
        message: "\"{{description}}\" faturalama geçmişine sahip olduğundan silinmek yerine kullanımdan kaldırılır. Yeni dönem yok; zaten faturalanmış dönemler yine de kapanır. Kapanmış dönemler sözleşmede kalır.",
        confirm: 'Paketi kaldır',
        toast: 'Saat paketi kullanımdan kaldırıldı',
      },
      detail: {
        title: 'Saat paketi',
        usage: '{{included}} saatin {{used}} saati kullanıldı · {{remaining}} kaldı · dönem {{end}} tarihinde bitiyor',
        carried: 'Aktarılan {{hours}} saati içerir.',
        unapproved: 'Bu sürenin {{hours}} saati henüz onaylanmadı.',
        foreign: '{{hours}} saat başka bir para biriminde kaydedildi; yine de paketten düşer.',
        over: 'Paketin {{hours}} saat üzerinde → dönem kapanışında {{amount}}',
        advanceNote: 'Aşım, sonraki faturada faturalanır.',
        arrearsNote: 'Aşım, bu dönemin faturasında faturalanır.',
        lateEntry: '{{hours}} saat, dönemi kapandıktan sonra girildi ve ayrıca faturalanır.',
        startsLater: "Paket {{date}} tarihinde başlar.",
        extraRate: 'Ek saatler: saat başına {{rate}}',
        loadFailed: 'Paket kullanımı yüklenemedi.',
      },
      history: {
        title: 'Kapanan paket dönemleri', empty: 'Henüz kapanan bir paket dönemi yok.', included: 'Dahil',
        carriedIn: 'Gelen aktarım', used: 'Kullanılan', over: 'Aşım', carriedOut: 'Giden aktarım', loadMore: 'Daha fazla yükle',
        invoiceRemoved: "Aşım faturası kaldırıldı — saatler faturalanmadı",
      },
    },
    held: {
      one: '{{count}} zaman kaydı ({{hours}} saat) bu kuruluşun saat paketi için bekletiliyor ve paket dönemi kapandığında faturalanacak.',
      other: '{{count}} zaman kaydı ({{hours}} saat) bu kuruluşun saat paketi için bekletiliyor ve paket dönemi kapandığında faturalanacak.',
    },
  },
};

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

for (const [locale, c] of Object.entries(L)) {
  const billingPath = path.join(LOCALES_DIR, locale, 'billing.json');
  const billing = JSON.parse(fs.readFileSync(billingPath, 'utf8'));
  deepMerge(billing, {
    contracts: { shared: { lineType: { hourBlock: c.line } }, hourBlock: c.h },
    invoicesPage: { dialog: { heldForHourBlock_one: c.held.one, heldForHourBlock_other: c.held.other } },
  });
  fs.writeFileSync(billingPath, `${JSON.stringify(billing, null, 2)}\n`);

  const ticketsPath = path.join(LOCALES_DIR, locale, 'tickets.json');
  const tickets = JSON.parse(fs.readFileSync(ticketsPath, 'utf8'));
  deepMerge(tickets, {
    ticketWorkbench: { invoice: { heldForHourBlock_one: c.held.one, heldForHourBlock_other: c.held.other } },
  });
  fs.writeFileSync(ticketsPath, `${JSON.stringify(tickets, null, 2)}\n`);
}
console.log('merged', Object.keys(L).length, 'locales');
```

- [ ] **Step 3: Verify**

Run: `cd apps/web && node /tmp/merge-hourblock-i18n.mjs && git diff --stat -- src/locales` (16 files changed, additions only — a deletion in the diff means the script clobbered something) then `npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/locales/humanizedKeyRegression.test.ts`. Expected: PASS, 3 files. If `translationCoverage` reds for a locale, reword that locale's offending value (the failure names namespace and locale); do **not** edit the caps.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/locales
git commit -m "feat(web): block-hours strings in all eight locales (#4547)

Line type label, editor form, retire confirmation, usage panel, closed-period
history, and the held-for-block notice on invoice assembly.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web — the block branch of the contract editor

**Files:**
- Modify: `apps/web/src/components/contracts/lineTypes.ts`, `AllowanceCell.tsx`, `ContractEditor.tsx`
- Modify: `apps/web/src/lib/api/contracts.ts`
- Create: `apps/web/src/components/contracts/ContractEditor.hourBlock.test.tsx`

**Interfaces:**
- Consumes: Task 10's keys; the API contract of Tasks 1-7 (`rolloverPolicy`, `rolloverCapHours`, `hourBlockAlertPct`, `hourBlockFirstPeriodStart`, `hourBlockRetiredAt`, `hourBlockHasHistory` on a line; `DELETE` → `{ data: { ok, retired } }`; error codes `HOUR_BLOCK_EXISTS`, `HOUR_BLOCK_FIELD_LOCKED`).
- Produces: `LINE_TYPE_LABELS.hour_block`; `HOUR_BLOCK_TYPE`; web types `RolloverPolicy`, the extended `ContractLine` / `UpdateContractLinePatch` / `ContractEstimate`, `HourPeriodRow`, `listContractHourPeriods(contractId, { limit?, cursor? })`.
- New fields on `ContractLine` are **optional** (`?:`) so the many existing test fixtures that build `ContractLine` literals keep compiling.

Design decisions (all inside CLAUDE.md's "proceed without asking" scope — reversible, in-scope, established patterns):
- **`ALLOWANCE_TYPES` (web) deliberately does not gain `hour_block`.** The generic toggle ("include a fixed quantity, then handle extras", whole numbers, a `flag` option) is the wrong control for hours and its patch builder is wrong for a block (READ THIS FIRST #9). The block has its own fieldset; `overageMode` is fixed to `bill` and is never shown as a choice (Open Decision 10).
- Site select, device roles, device group and manual quantity are already hidden for the type: they render only under `SITE_SCOPED_TYPES` / `per_device_role` / `per_device_group` / `manual`, none of which include `hour_block`.
- The extra-hours price reuses the add form's existing `lineOveragePrice` state (it **is** the `overage_unit_price` column) under its own testid.
- A retired block shows a "Retired" badge and **no** Edit/Remove buttons; the server would refuse both anyway (`HOUR_BLOCK_FIELD_LOCKED`, idempotent retire).
- Hours are decimals: `MONEY_RE` (`^\d+(\.\d{1,2})?$`, 2 dp) is the grammar, plus `> 0`.
- The editor shows the stamped first counted period on the row (`startsOn`; for a draft it is provisional until activation, which the add-form note says) and a general note in the add form. A date preview in the add form would need `computePeriod` in the browser; not worth a second copy of the date rules.

- [ ] **Step 1: Write the failing tests** — create `ContractEditor.hourBlock.test.tsx` (harness copied from `ContractEditor.allowance.test.tsx:1-80`: same `vi.mock`s for `../../stores/auth`, `@/lib/navigation`, `../shared/Toast`, `../catalog/CatalogItemPicker`, `../../lib/api/catalog`, and a `../../lib/api/contracts` partial mock):

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock('../catalog/CatalogItemPicker', () => ({ default: () => null }));
vi.mock('../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) }),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(), updateContract: vi.fn(), addContractLine: vi.fn(), removeContractLine: vi.fn(),
    updateContractLine: vi.fn(), contractTransition: vi.fn(), getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const contract = {
  autopayExcluded: false, id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'active',
  billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: '2026-07-01',
  autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD',
  notes: null, terms: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
} as const;

const blockLine = (p: Partial<Record<string, unknown>> = {}) => ({
  id: 'b1', contractId: 'ct-1', orgId: 'org-1', lineType: 'hour_block', description: 'Support block',
  catalogItemId: null, unitPrice: '1000.00', manualQuantity: null, siteId: null, siteName: null, deviceRoles: null,
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null,
  includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00', taxable: false, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z', rolloverPolicy: 'carry_forward', rolloverCapHours: '4.00', hourBlockAlertPct: 80,
  hourBlockFirstPeriodStart: '2026-07-01', hourBlockRetiredAt: null, hourBlockHasHistory: false, ...p,
});
const flatLine = () => ({
  id: 'f1', contractId: 'ct-1', orgId: 'org-1', lineType: 'flat', description: 'Base', catalogItemId: null,
  unitPrice: '50.00', manualQuantity: null, siteId: null, siteName: null, deviceRoles: null, deviceGroupId: null,
  deviceGroupName: null, deviceGroup: null, site: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
  taxable: true, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z',
});

describe('ContractEditor — block hours (#4547 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [] });
      if (url.startsWith('/device-groups')) return resp({ data: [] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [], hourBlock: null },
    }));
    (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'new' } }));
    (api.updateContractLine as any).mockResolvedValue(resp({ data: blockLine() }));
    (api.removeContractLine as any).mockResolvedValue(resp({ data: { ok: true, retired: false } }));
  });

  function renderEdit(lines: unknown[] = []) {
    return render(<ContractEditor detail={{ autopayEnabled: false, contract: contract as any, lines: lines as any, periods: [] }} onChanged={vi.fn()} />);
  }
  const pickBlock = async () => {
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'hour_block' } });
    await screen.findByTestId('contract-line-block-fields');
  };
  const fillValidBlock = () => {
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Support block' } });
    fireEvent.change(screen.getByTestId('contract-line-price'), { target: { value: '1000.00' } });
    fireEvent.change(screen.getByTestId('contract-line-block-hours'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('contract-line-block-extra-rate'), { target: { value: '150.00' } });
  };

  it('offers the block type and shows only the block fields: no site, roles, group, manual quantity, allowance toggle or overage-mode choice', async () => {
    renderEdit();
    expect(Array.from((screen.getByTestId('contract-line-type') as HTMLSelectElement).options).map((o) => o.value)).toContain('hour_block');
    await pickBlock();
    for (const gone of ['contract-line-site', 'contract-line-group', 'contract-line-qty', 'contract-line-allowance-toggle',
      'contract-line-overage-mode-group', 'contract-line-overage-flag', 'contract-line-included-qty']) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
    expect(screen.queryByTestId('contract-line-roles')).toBeNull();
    expect(screen.getByTestId('contract-line-block-firstperiod')).toBeInTheDocument();
  });

  it('adds a block with the exact payload: hours, bill mode, rate, policy — and no site/roles/group/manual/cap/alert keys', async () => {
    renderEdit();
    await pickBlock();
    fillValidBlock();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    const body = (api.addContractLine as any).mock.calls[0][1];
    expect(body).toMatchObject({
      lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
      includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none',
    });
    for (const absent of ['siteId', 'deviceRoles', 'deviceGroupId', 'manualQuantity', 'rolloverCapHours', 'hourBlockAlertPct']) {
      expect(body[absent]).toBeUndefined();
    }
  });

  it('disables the cap under rollover none, sends it under carry_forward, and sends the alert percentage', async () => {
    renderEdit();
    await pickBlock();
    fillValidBlock();
    expect(screen.getByTestId('contract-line-block-cap')).toBeDisabled();
    fireEvent.click(screen.getByTestId('contract-line-block-rollover-carry'));
    expect(screen.getByTestId('contract-line-block-cap')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('contract-line-block-cap'), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('contract-line-block-alert'), { target: { value: '80' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    expect((api.addContractLine as any).mock.calls[0][1]).toMatchObject({
      rolloverPolicy: 'carry_forward', rolloverCapHours: '4', hourBlockAlertPct: 80,
    });
    // Switching back to none must not leak a stale cap into the payload.
    (api.addContractLine as any).mockClear();
    await pickBlock();
    fillValidBlock();
    fireEvent.click(screen.getByTestId('contract-line-block-rollover-carry'));
    fireEvent.change(screen.getByTestId('contract-line-block-cap'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('contract-line-block-rollover-none'));
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    expect((api.addContractLine as any).mock.calls[0][1].rolloverCapHours).toBeUndefined();
  });

  it('gates Add on valid hours (fractional ok, zero not), price, cap and alert bounds', async () => {
    renderEdit();
    await pickBlock();
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Support block' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();           // nothing entered yet
    fillValidBlock();
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    for (const bad of ['0', '0.00', '-1', 'abc', '1.234', '']) {
      fireEvent.change(screen.getByTestId('contract-line-block-hours'), { target: { value: bad } });
      expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    }
    fireEvent.change(screen.getByTestId('contract-line-block-hours'), { target: { value: '7.5' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    for (const bad of ['0', '101', '12.5', 'x']) {
      fireEvent.change(screen.getByTestId('contract-line-block-alert'), { target: { value: bad } });
      expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    }
    fireEvent.change(screen.getByTestId('contract-line-block-alert'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('contract-line-block-extra-rate'), { target: { value: '' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
  });

  it('blocks a second live block on the same contract with the retire-first hint, and a retired one does not count', async () => {
    renderEdit([blockLine()]);
    await pickBlock();
    fillValidBlock();
    expect(screen.getByTestId('contract-line-block-exists')).toBeInTheDocument();
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
  });

  it('a retired block does not count toward the one-live-block hint', async () => {
    renderEdit([blockLine({ hourBlockRetiredAt: '2026-07-10T00:00:00Z', hourBlockHasHistory: true })]);
    await pickBlock();
    fillValidBlock();
    expect(screen.queryByTestId('contract-line-block-exists')).toBeNull();
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
  });

  it('maps HOUR_BLOCK_EXISTS to the friendly retire-first copy', async () => {
    (api.addContractLine as any).mockResolvedValue(resp({ error: 'exists', code: 'HOUR_BLOCK_EXISTS' }, false, 409));
    renderEdit();
    await pickBlock();
    fillValidBlock();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringContaining('already has an active block-hours line'),
    })));
  });

  it('REGRESSION: renaming a block sends exactly { description } — never the generic allowance-clearing nulls', async () => {
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Support block (renamed)' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect((api.updateContractLine as any).mock.calls[0][2]).toEqual({ description: 'Support block (renamed)' });
  });

  it('editing sends only the changed block fields; "none" clears the cap in the same patch; 10 vs 10.00 is not a change', async () => {
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect((screen.getByTestId('line-edit-block-hours-0') as HTMLInputElement).value).toBe('10');
    fireEvent.change(screen.getByTestId('line-edit-block-hours-0'), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('line-edit-block-extra-rate-0'), { target: { value: '175.00' } });
    fireEvent.click(screen.getByTestId('line-edit-block-rollover-none-0'));
    fireEvent.change(screen.getByTestId('line-edit-block-alert-0'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect((api.updateContractLine as any).mock.calls[0][2]).toEqual({
      includedQuantity: '12', overageUnitPrice: '175.00', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: null,
    });
    expect(screen.queryByTestId('line-edit-block-overage-mode-0')).toBeNull();   // mode is never a choice
  });

  it('states that edits apply to the current open period at its close — with the period dates once the estimate is loaded', async () => {
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-block-midperiod-0')).toHaveTextContent('Changes apply to the current open period at its close.');
  });

  it('shows the open period dates in that notice when the estimate carries the live block', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({ data: {
      currencyCode: 'USD', periodTotal: '1000.00', lines: [], uncoveredDevices: null, overages: [],
      hourBlock: { lineId: 'b1', periodStart: '2026-09-01', periodEnd: '2026-10-01', includedHours: 10, carriedInHours: 0, consumedHours: 0, unapprovedHours: 0, foreignCurrencyHours: 0, remainingHours: 10, overageHours: 0, overageUnitPrice: '150.00', overageValue: '0.00', alertPct: null, billingTiming: 'advance', lateEntryHours: 0 },
    } }));
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    await waitFor(() => expect(screen.getByTestId('line-edit-block-midperiod-0')).toHaveTextContent(/current open period \(.+ – .+\) at its close/));
  });

  it('maps HOUR_BLOCK_FIELD_LOCKED on save to its copy', async () => {
    (api.updateContractLine as any).mockResolvedValue(resp({ error: 'locked', code: 'HOUR_BLOCK_FIELD_LOCKED' }, false, 400));
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-block-hours-0'), { target: { value: '11' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringContaining("can't be changed on a block-hours line"),
    })));
  });

  it('remove confirm says RETIRE for a block with history and plain remove otherwise; the toast follows the server', async () => {
    renderEdit([blockLine({ hourBlockHasHistory: true })]);
    fireEvent.click(await screen.findByTestId('line-remove-0'));
    expect(await screen.findByText(/retired instead of deleted/i)).toBeInTheDocument();
    (api.removeContractLine as any).mockResolvedValue(resp({ data: { ok: true, retired: true } }));
    fireEvent.click(screen.getByTestId('contract-line-remove-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Block hours retired' })));
  });

  it('remove confirm for a block with no history keeps the ordinary remove copy', async () => {
    renderEdit([blockLine({ hourBlockHasHistory: false })]);
    fireEvent.click(await screen.findByTestId('line-remove-0'));
    expect(screen.queryByText(/retired instead of deleted/i)).toBeNull();
  });

  it('a retired block shows a Retired badge and offers neither Edit nor Remove, and adds nothing to the estimate', async () => {
    renderEdit([blockLine({ hourBlockRetiredAt: '2026-07-10T00:00:00Z', hourBlockHasHistory: true }), flatLine()]);
    expect(await screen.findByTestId('line-block-summary-0')).toHaveTextContent('Retired');
    expect(screen.queryByTestId('line-edit-0')).toBeNull();
    expect(screen.queryByTestId('line-remove-0')).toBeNull();
    expect(screen.getByTestId('line-edit-1')).toBeInTheDocument();
  });

  it('a live block shows the stamped first counted period and its hours per period', async () => {
    renderEdit([blockLine()]);
    expect(await screen.findByTestId('line-block-summary-0')).toHaveTextContent(/Counts from/);
    expect(screen.getByTestId('line-qty-0')).toHaveTextContent('10 hours per period');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractEditor.hourBlock.test.tsx`
Expected: FAIL — `hour_block` is not in `LINE_TYPE_LABELS`, so the select has no such option; nothing else exists.

- [ ] **Step 3: Implement**

**3a. `apps/web/src/lib/api/contracts.ts`:**

```ts
import type { ContractLineType, HourBlockEstimate } from '@breeze/shared';
export type RolloverPolicy = 'none' | 'carry_forward';
```
`ContractEstimate` gains `hourBlock?: HourBlockEstimate | null;`. `ContractLine` gains (all optional): `rolloverPolicy?: RolloverPolicy | null; rolloverCapHours?: string | null; hourBlockAlertPct?: number | null; hourBlockFirstPeriodStart?: string | null; hourBlockRetiredAt?: string | null; hourBlockHasHistory?: boolean;`. `UpdateContractLinePatch` gains `rolloverPolicy?: RolloverPolicy; rolloverCapHours?: string | null; hourBlockAlertPct?: number | null;`. New:

```ts
/** One closed block period from GET /contracts/:id/hour-periods (#4547 W03). Hours are numeric strings. */
export interface HourPeriodRow {
  id: string; contractLineId: string; periodStart: string; periodEnd: string;
  includedHours: string; carriedInHours: string; consumedHours: string; overageHours: string; carriedOutHours: string;
  foreignCurrencyHours: string; entryCount: number; overageUnitPrice: string; currencyCode: string;
  overageInvoiceId: string | null; closeSource: 'billing_run' | 'close_out'; closedAt: string;
}

export function listContractHourPeriods(contractId: string, query: { limit?: number; cursor?: string } = {}): Promise<Response> {
  const params = new URLSearchParams();
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const qs = params.toString();
  return fetchWithAuth(`/contracts/${contractId}/hour-periods${qs ? `?${qs}` : ''}`);
}
```

**3b. `lineTypes.ts`:** add `hour_block: 'contracts.shared.lineType.hourBlock',` to `LINE_TYPE_LABELS` (the `Record<ContractLineType, string>` type makes this mandatory once the shared tuple has the value); add

```ts
/** #4547: block hours has its OWN add/edit branch (hours are decimals, overageMode is
 *  fixed to 'bill', and there is a rollover policy). It is deliberately NOT in
 *  ALLOWANCE_TYPES below: the generic "fixed quantity of devices/seats" control and its
 *  patch builder are the wrong tool for it (ContractEditor.buildLinePatch). */
export const HOUR_BLOCK_TYPE: ContractLineType = 'hour_block';
```
and fix the `ALLOWANCE_TYPES` comment to say it mirrors the **device/seat** members of `ALLOWANCE_LINE_TYPES` (everything except `hour_block`).

**3c. `AllowanceCell.tsx`** — after the two `unresolved` early returns:

```tsx
  // #4547: a block's quantity cell is its entitlement, not a counted-vs-included figure
  // (the live balance lives in the estimate's hourBlock and the detail panel).
  if (line.lineType === 'hour_block') {
    return <span data-testid="allowance-hour-block">{t('contracts.hourBlock.row.perPeriod', { hours: Number(line.includedQuantity ?? 0) })}</span>;
  }
```

**3d. `ContractEditor.tsx`:**

1. Imports: add `HOUR_BLOCK_TYPE` to the `./lineTypes` import; `type RolloverPolicy` to the `../../lib/api/contracts` import; `formatDate` to the `../billing/invoiceTypes` import.

2. Helpers (next to `allowanceFieldsValid`):

```ts
const hoursForInput = (v: string | null | undefined): string => (v == null ? '' : String(Number(v)));
const sameNumber = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a == null || a === '') ? (b == null || b === '') : (b != null && b !== '' && Number(a) === Number(b));

/** The block fields' grammar, shared by the add form and the edit draft. Hours are
 *  decimals (2 dp), so MONEY_RE with > 0; the cap only matters under carry_forward. */
function blockFieldsValid(f: { hours: string; price: string; policy: RolloverPolicy; cap: string; alert: string }): boolean {
  const hours = f.hours.trim();
  if (!MONEY_RE.test(hours) || !(Number(hours) > 0)) return false;
  if (!MONEY_RE.test(f.price.trim())) return false;
  const cap = f.cap.trim();
  if (f.policy === 'carry_forward' && cap !== '' && !(MONEY_RE.test(cap) && Number(cap) > 0)) return false;
  const alert = f.alert.trim();
  if (alert !== '' && !(/^\d+$/.test(alert) && Number(alert) >= 1 && Number(alert) <= 100)) return false;
  return true;
}
```

3. `EditLineDraft` gains `blockHours: string; blockPolicy: RolloverPolicy; blockCap: string; blockAlert: string;`. `draftFromLine` — set `allowanceOn: l.includedQuantity != null && l.lineType !== 'hour_block',` and:

```ts
    blockHours: hoursForInput(l.includedQuantity),
    blockPolicy: (l.rolloverPolicy ?? 'none') as RolloverPolicy,
    blockCap: hoursForInput(l.rolloverCapHours),
    blockAlert: l.hourBlockAlertPct == null ? '' : String(l.hourBlockAlertPct),
```

4. `buildLinePatch` — immediately after the catalog `if/else` and **before** the `manual` line, add (this is the READ THIS FIRST #9 fix):

```ts
  if (l.lineType === 'hour_block') {
    // overageMode is never sent (Open Decision 10); the generic allowance branch below
    // must not run for a block or a rename would send includedQuantity: null.
    if (!sameNumber(d.blockHours, l.includedQuantity)) patch.includedQuantity = d.blockHours.trim();
    if (!sameNumber(d.overageUnitPrice, l.overageUnitPrice)) patch.overageUnitPrice = d.overageUnitPrice.trim();
    if (d.blockPolicy !== (l.rolloverPolicy ?? 'none')) patch.rolloverPolicy = d.blockPolicy;
    const cap = d.blockPolicy === 'carry_forward' && d.blockCap.trim() !== '' ? d.blockCap.trim() : null;
    if (!sameNumber(cap, l.rolloverCapHours ?? null)) patch.rolloverCapHours = cap;
    const alert = d.blockAlert.trim() === '' ? null : Number(d.blockAlert);
    if (alert !== (l.hourBlockAlertPct ?? null)) patch.hourBlockAlertPct = alert;
    return patch;
  }
```
`editDraftIncomplete` — after the description check:

```ts
  if (l.lineType === 'hour_block') {
    return !blockFieldsValid({ hours: d.blockHours, price: d.overageUnitPrice, policy: d.blockPolicy, cap: d.blockCap, alert: d.blockAlert })
      || (d.catalogItemId === null && !MONEY_RE.test(d.unitPrice));
  }
```

5. State (next to the allowance state, `:257-260`): `const [lineBlockHours, setLineBlockHours] = useState(''); const [lineBlockRollover, setLineBlockRollover] = useState<RolloverPolicy>('none'); const [lineBlockCap, setLineBlockCap] = useState(''); const [lineBlockAlert, setLineBlockAlert] = useState('');`.

6. Derived values (next to `allowanceIncomplete`, `:565-568`):

```ts
  const blockSelected = lineType === HOUR_BLOCK_TYPE;
  const liveBlockOnContract = lines.some((l) => l.lineType === 'hour_block' && !l.hourBlockRetiredAt);
  const blockIncomplete = blockSelected && !blockFieldsValid({
    hours: lineBlockHours, price: lineOveragePrice, policy: lineBlockRollover, cap: lineBlockCap, alert: lineBlockAlert,
  });
  const blockBlocked = blockSelected && (blockIncomplete || liveBlockOnContract);
```
Add `|| blockBlocked` to the `addLine` early-return guard (`:742`), to the `useCallback` deps, and to the Add button's `disabled` (`:1756`).

7. `addLine` payload (`:762-766`) — replace the three allowance keys:

```ts
          includedQuantity: blockSelected ? lineBlockHours.trim() : (allowanceOn ? lineIncludedQty : undefined),
          overageMode: blockSelected ? 'bill' : (allowanceOn ? lineOverageMode : undefined),
          overageUnitPrice: blockSelected
            ? lineOveragePrice.trim()
            : (allowanceOn && lineOverageMode === 'bill' ? lineOveragePrice : undefined),
          rolloverPolicy: blockSelected ? lineBlockRollover : undefined,
          rolloverCapHours: blockSelected && lineBlockRollover === 'carry_forward' && lineBlockCap.trim() !== '' ? lineBlockCap.trim() : undefined,
          hourBlockAlertPct: blockSelected && lineBlockAlert.trim() !== '' ? Number(lineBlockAlert) : undefined,
```
`friendly` gains `HOUR_BLOCK_EXISTS: t('contracts.hourBlock.errors.exists')` (extend the existing ternary into a lookup). After a successful add, also reset `setLineBlockHours(''); setLineBlockRollover('none'); setLineBlockCap(''); setLineBlockAlert('');`. In the line-type `onChange` (`:1503-1509`) reset the same four fields.

8. `removeLine` — typed response and a toast that follows the server:

```ts
      await runAction<{ data?: { ok?: boolean; retired?: boolean } }>({
        request: () => removeContractLine(contract.id, lineId),
        errorFallback: t('contracts.contractEditor.errors.removeLine'),
        successMessage: (r) => (r?.data?.retired
          ? t('contracts.hourBlock.retire.toast')
          : t('contracts.contractEditor.toast.lineRemoved')),
        onUnauthorized: UNAUTHORIZED,
      });
```
`saveLine`'s `friendly` map gains `HOUR_BLOCK_FIELD_LOCKED: t('contracts.hourBlock.errors.locked'), HOUR_BLOCK_EXISTS: t('contracts.hourBlock.errors.exists'),`.

9. The client-side estimate memo (`:490-499`) — first statement in the loop: `if (l.lineType === 'hour_block' && l.hourBlockRetiredAt) continue;`.

10. Render — line row (`:1393-1405`, the type cell): after the group span add

```tsx
{l.lineType === 'hour_block'
  ? <span className="block text-xs text-muted-foreground" data-testid={`line-block-summary-${idx}`}>
      {l.hourBlockRetiredAt
        ? t('contracts.hourBlock.row.retiredBadge')
        : (l.hourBlockFirstPeriodStart ? t('contracts.hourBlock.row.startsOn', { date: formatDate(l.hourBlockFirstPeriodStart) }) : null)}
    </span>
  : null}
```
and wrap the Edit/Remove button group (`{linesEditable && (` at `:1411`) as `{linesEditable && !(l.lineType === 'hour_block' && l.hourBlockRetiredAt) && (`.

11. Render — edit form: immediately **above** the `{ALLOWANCE_TYPES.has(l.lineType) && (` block at `:1195`:

```tsx
{l.lineType === 'hour_block' && (
  <fieldset className="flex flex-col gap-2 text-xs text-muted-foreground" data-testid={`line-edit-block-fields-${idx}`}>
    {/* Open Decision 15: the close reads the line as it is, so an edit moves the open period's figures. */}
    <span data-testid={`line-edit-block-midperiod-${idx}`}>
      {liveEstimate?.hourBlock
        ? t('contracts.hourBlock.form.midPeriodEdit', { start: formatDate(liveEstimate.hourBlock.periodStart), end: formatDate(liveEstimate.hourBlock.periodEnd) })
        : t('contracts.hourBlock.form.midPeriodEditNoDates')}
    </span>
    <label className="flex flex-col gap-1">
      {t('contracts.hourBlock.form.hoursPerPeriod')}
      <input type="number" min="0.01" step="0.01" value={d.blockHours}
        onChange={(e) => setEditDraft({ ...d, blockHours: e.target.value })}
        data-testid={`line-edit-block-hours-${idx}`}
        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring" />
    </label>
    <label className="flex flex-col gap-1">
      {t('contracts.hourBlock.form.extraRate')}
      <input type="number" min="0" step="0.01" value={d.overageUnitPrice}
        onChange={(e) => setEditDraft({ ...d, overageUnitPrice: e.target.value })}
        data-testid={`line-edit-block-extra-rate-${idx}`}
        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring" />
    </label>
    <fieldset className="flex flex-col gap-1">
      <legend>{t('contracts.hourBlock.form.rolloverMode')}</legend>
      <div className="flex flex-wrap gap-3 text-sm text-foreground">
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name={`edit-rollover-${l.id}`} checked={d.blockPolicy === 'none'}
            onChange={() => setEditDraft({ ...d, blockPolicy: 'none', blockCap: '' })}
            data-testid={`line-edit-block-rollover-none-${idx}`} />
          {t('contracts.hourBlock.form.rolloverExpire')}
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name={`edit-rollover-${l.id}`} checked={d.blockPolicy === 'carry_forward'}
            onChange={() => setEditDraft({ ...d, blockPolicy: 'carry_forward' })}
            data-testid={`line-edit-block-rollover-carry-${idx}`} />
          {t('contracts.hourBlock.form.rolloverCarry')}
        </label>
      </div>
    </fieldset>
    <label className="flex flex-col gap-1">
      {t('contracts.hourBlock.form.carryCap')}
      <input type="number" min="0.01" step="0.01" value={d.blockCap} disabled={d.blockPolicy !== 'carry_forward'}
        onChange={(e) => setEditDraft({ ...d, blockCap: e.target.value })}
        data-testid={`line-edit-block-cap-${idx}`}
        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60" />
    </label>
    <label className="flex flex-col gap-1">
      {t('contracts.hourBlock.form.alertPct')}
      <input type="number" min="1" max="100" step="1" value={d.blockAlert}
        onChange={(e) => setEditDraft({ ...d, blockAlert: e.target.value })}
        data-testid={`line-edit-block-alert-${idx}`}
        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring" />
    </label>
  </fieldset>
)}
```
(`d` and `idx` are the edit-row locals the neighbouring allowance block already uses.)

12. Render — add form: immediately **above** the `{ALLOWANCE_TYPES.has(lineType) && (` block at `:1641`:

```tsx
{blockSelected && (
  <fieldset className="flex flex-col gap-2 text-xs text-muted-foreground sm:col-span-2" data-testid="contract-line-block-fields">
    <span data-testid="contract-line-block-firstperiod">{t('contracts.hourBlock.form.firstPeriod')}</span>
    {liveBlockOnContract && (
      <span className="text-amber-600 dark:text-amber-500" data-testid="contract-line-block-exists">
        {t('contracts.hourBlock.form.onlyOne')}
      </span>
    )}
    <label className="flex flex-col gap-1">
      {t('contracts.hourBlock.form.hoursPerPeriod')}
      <input type="number" min="0.01" step="0.01" value={lineBlockHours}
        onChange={(e) => setLineBlockHours(e.target.value)} data-testid="contract-line-block-hours"
        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring" />
    </label>
    <label className="flex flex-col gap-1">
      {t('contracts.hourBlock.form.extraRate')}
      <input type="number" min="0" step="0.01" value={lineOveragePrice}
        onChange={(e) => setLineOveragePrice(e.target.value)} data-testid="contract-line-block-extra-rate"
        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring" />
      {lineOveragePrice !== '' && !MONEY_RE.test(lineOveragePrice.trim()) && (
        <span className="text-xs text-destructive" data-testid="contract-line-block-extra-rate-invalid">
          {t('contracts.contractEditor.addLine.priceNotRepresentable', { currency: contractCurrency })}
        </span>
      )}
    </label>
    <fieldset className="flex flex-col gap-1">
      <legend>{t('contracts.hourBlock.form.rolloverMode')}</legend>
      <div className="flex flex-wrap gap-3 text-sm text-foreground">
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name="block-rollover" checked={lineBlockRollover === 'none'}
            onChange={() => { setLineBlockRollover('none'); setLineBlockCap(''); }}
            data-testid="contract-line-block-rollover-none" />
          {t('contracts.hourBlock.form.rolloverExpire')}
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" name="block-rollover" checked={lineBlockRollover === 'carry_forward'}
            onChange={() => setLineBlockRollover('carry_forward')} data-testid="contract-line-block-rollover-carry" />
          {t('contracts.hourBlock.form.rolloverCarry')}
        </label>
      </div>
    </fieldset>
    <label className="flex flex-col gap-1">
      {t('contracts.hourBlock.form.carryCap')}
      <input type="number" min="0.01" step="0.01" value={lineBlockCap} disabled={lineBlockRollover !== 'carry_forward'}
        onChange={(e) => setLineBlockCap(e.target.value)} data-testid="contract-line-block-cap"
        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60" />
    </label>
    <label className="flex flex-col gap-1">
      {t('contracts.hourBlock.form.alertPct')}
      <input type="number" min="1" max="100" step="1" value={lineBlockAlert}
        onChange={(e) => setLineBlockAlert(e.target.value)} data-testid="contract-line-block-alert"
        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring" />
    </label>
    {blockIncomplete && (
      <span className="text-amber-600 dark:text-amber-500" data-testid="contract-line-block-required">{t('contracts.hourBlock.form.required')}</span>
    )}
  </fieldset>
)}
```

13. Remove confirm (`:1859-1877`) — choose the copy by the same predicate the server uses:

```tsx
        title={pendingRemove?.lineType === 'hour_block' && pendingRemove.hourBlockHasHistory
          ? t('contracts.hourBlock.retire.title') : t('contracts.contractEditor.removeLineConfirm.title')}
        message={
          pendingRemove
            ? (pendingRemove.lineType === 'hour_block' && pendingRemove.hourBlockHasHistory
                ? t('contracts.hourBlock.retire.message', { description: pendingRemove.description })
                : t('contracts.contractEditor.removeLineConfirm.message', { description: pendingRemove.description || t('contracts.contractEditor.removeLineConfirm.thisLine') }))
            : ''
        }
        confirmLabel={pendingRemove?.lineType === 'hour_block' && pendingRemove.hourBlockHasHistory
          ? t('contracts.hourBlock.retire.confirm') : t('contracts.contractEditor.removeLineConfirm.confirm')}
```

- [ ] **Step 4: Run to verify it passes, then the neighbours**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractEditor.hourBlock.test.tsx src/components/contracts/ContractEditor.allowance.test.tsx src/components/contracts/ContractEditor.editline.test.tsx src/components/contracts/ContractEditor.test.tsx src/components/contracts/AllowanceCell.test.tsx src/components/contracts/ContractEditor.catalogline.test.tsx`
Expected: PASS, 6 files. Then `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts` (no new mutation handler, but the guard reads these files) and `cd apps/web && npx tsc --noEmit -p .`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/contracts/lineTypes.ts apps/web/src/components/contracts/AllowanceCell.tsx apps/web/src/components/contracts/ContractEditor.tsx apps/web/src/components/contracts/ContractEditor.hourBlock.test.tsx apps/web/src/lib/api/contracts.ts
git commit -m "feat(web): add, edit and retire block-hours lines in the contract editor (#4547)

A dedicated branch for the block type: hours, price per extra hour, rollover
policy with a cap that only applies when carrying forward, and an optional
alert. The overage mode is never a choice. Removing a block with history says
retire.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Web — the hours bar and closed-period history on the contract page

**Files:**
- Create: `apps/web/src/components/contracts/HourBlockPanel.tsx`, `apps/web/src/components/contracts/ContractDetail.hourBlock.test.tsx`
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx`

**Interfaces:**
- Consumes: `ContractEstimate.hourBlock` (Task 6), `listContractHourPeriods` / `HourPeriodRow` (Task 11 types), Task 10 keys.
- Produces: `<HourBlockPanel contractId currency hourBlock estimateFailed reloadKey />`. Renders only when the contract has at least one `hour_block` line (live or retired), so a contract without a block is byte-for-byte unchanged.

Behaviour (spec §5 and the kickoff):
- Bar: "6.5 of 10 hours used · 3.5 remaining · period ends 1 Oct". The denominator is `includedHours + carriedInHours` (the opening balance); a separate line says how many hours were carried in.
- Sub-figures, each its own testid: unapproved (⊆ used), foreign-currency note (they **still** draw down), late entries (billed separately).
- Over the block: "2 hours over the block → $300.00 at period close", plus the timing note — advance → "bills on the following invoice", arrears → "bills on this period's invoice".
- Before the first counted period (`periodStart > today`): "Hours start counting {{date}}" and a 0-used bar.
- History: newest first, "Load more" with the server cursor, empty and error states. It is a `GET`, so no `runAction`.

- [ ] **Step 1: Write the failing tests** — `ContractDetail.hourBlock.test.tsx` (harness copied from `ContractDetail.allowance.test.tsx:1-60`, with `listContractHourPeriods` added to the partial `../../lib/api/contracts` mock):

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as api from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) => selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, contractTransition: vi.fn(), generateContractInvoice: vi.fn(), getContractEstimate: vi.fn(), listContractHourPeriods: vi.fn() };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const baseDetail: ContractDetailData = {
  autopayEnabled: false,
  contract: {
    autopayExcluded: false, id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'active',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: '2026-07-01',
    autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD',
    notes: null, terms: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [], periods: [],
};
const blockLine = (p: Record<string, unknown> = {}) => ({
  id: 'b1', contractId: 'ct-1', orgId: 'org-1', lineType: 'hour_block', description: 'Support block',
  catalogItemId: null, unitPrice: '1000.00', manualQuantity: null, siteId: null, siteName: null, deviceRoles: null,
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null, includedQuantity: '10.00',
  overageMode: 'bill', overageUnitPrice: '150.00', taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
  rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: 80, hourBlockFirstPeriodStart: '2026-06-01',
  hourBlockRetiredAt: null, ...p,
}) as ContractDetailData['lines'][number];

const hb = (p: Record<string, unknown> = {}) => ({
  lineId: 'b1', periodStart: '2026-09-01', periodEnd: '2026-10-01', includedHours: 10, carriedInHours: 0,
  consumedHours: 6.5, unapprovedHours: 0, foreignCurrencyHours: 0, remainingHours: 3.5, overageHours: 0,
  overageUnitPrice: '150.00', overageValue: '0.00', alertPct: 80, billingTiming: 'advance', lateEntryHours: 0, ...p,
});
const estimateWith = (hourBlock: unknown) => resp({ data: {
  currencyCode: 'USD', periodTotal: '1000.00', uncoveredDevices: null, overages: [],
  lines: [{ lineId: 'b1', lineType: 'hour_block', quantity: 1, value: '1000.00', live: false, counted: 1, included: null, overage: 0, overageMode: null, overageValue: '0.00' }],
  hourBlock,
} });
const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `hp${i}`, contractLineId: 'b1', periodStart: `2026-0${i}-01`, periodEnd: `2026-0${i + 1}-01`,
  includedHours: '10.00', carriedInHours: '0.00', consumedHours: '12.00', overageHours: '2.00', carriedOutHours: '0.00',
  foreignCurrencyHours: '0.00', entryCount: 5, overageUnitPrice: '150.00', currencyCode: 'USD',
  overageInvoiceId: 'inv-1', closeSource: 'billing_run', closedAt: '2026-09-01T00:00:00Z', ...over,
});

describe('ContractDetail — block hours (#4547 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = [{ resource: 'contracts', action: 'manage' }];
    (api.listContractHourPeriods as any).mockResolvedValue(resp({ data: { items: [], nextCursor: null } }));
  });
  const renderDetail = (lines: ContractDetailData['lines'], hourBlock: unknown = null) => {
    (api.getContractEstimate as any).mockResolvedValue(estimateWith(hourBlock));
    return render(<ContractDetail detail={{ ...baseDetail, lines }} onChanged={vi.fn()} />);
  };

  it('renders nothing for a contract with no block line (and never fetches history)', async () => {
    renderDetail([]);
    await screen.findByTestId('contract-detail');
    expect(screen.queryByTestId('hour-block-panel')).toBeNull();
    expect(api.listContractHourPeriods).not.toHaveBeenCalled();
  });

  it('shows the usage bar: 6.5 of 10 used, 3.5 remaining, the period end, and a progressbar', async () => {
    renderDetail([blockLine()], hb());
    const usage = await screen.findByTestId('hour-block-usage');
    expect(usage).toHaveTextContent(/6\.5 of 10 hours used · 3\.5 remaining · period ends/);
    const bar = screen.getByTestId('hour-block-bar');
    expect(bar).toHaveAttribute('role', 'progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '6.5');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
    expect(screen.queryByTestId('hour-block-over')).toBeNull();
  });

  it('opening balance includes carried-in hours and says so', async () => {
    renderDetail([blockLine()], hb({ carriedInHours: 3, includedHours: 10, consumedHours: 6.5, remainingHours: 6.5 }));
    expect(await screen.findByTestId('hour-block-usage')).toHaveTextContent(/6\.5 of 13 hours used/);
    expect(screen.getByTestId('hour-block-carried')).toHaveTextContent('3 hours carried forward');
  });

  it('over-block state: hours over, the money at period close, and the advance-billing note', async () => {
    renderDetail([blockLine()], hb({ consumedHours: 12, remainingHours: 0, overageHours: 2, overageValue: '300.00' }));
    const over = await screen.findByTestId('hour-block-over');
    expect(over).toHaveTextContent(/2 hours over the block/);
    expect(over).toHaveTextContent('300.00');
    expect(screen.getByTestId('hour-block-timing-note')).toHaveTextContent('following invoice');
  });

  it('an arrears contract says the overage is on THIS period\'s invoice instead', async () => {
    renderDetail([blockLine()], hb({ consumedHours: 12, remainingHours: 0, overageHours: 2, overageValue: '300.00', billingTiming: 'arrears' }));
    expect(await screen.findByTestId('hour-block-timing-note')).toHaveTextContent("this period's invoice");
  });

  it('shows the unapproved, foreign-currency and late-entry sub-figures only when non-zero', async () => {
    renderDetail([blockLine()], hb({ unapprovedHours: 1, foreignCurrencyHours: 1.5, lateEntryHours: 2 }));
    expect(await screen.findByTestId('hour-block-unapproved')).toHaveTextContent('1 hours');
    expect(screen.getByTestId('hour-block-foreign')).toHaveTextContent('1.5 hours');
    expect(screen.getByTestId('hour-block-late')).toHaveTextContent('2 hours');
    expect(screen.getByTestId('hour-block-extra-rate')).toHaveTextContent('150.00');
  });

  it('no sub-figures and no notes at zero', async () => {
    renderDetail([blockLine()], hb());
    await screen.findByTestId('hour-block-usage');
    for (const id of ['hour-block-unapproved', 'hour-block-foreign', 'hour-block-late', 'hour-block-carried', 'hour-block-over']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('before the first counted period it says "Block starts <date>" instead of a 0-used bar', async () => {
    renderDetail([blockLine()], hb({ periodStart: '2999-01-01', periodEnd: '2999-02-01', consumedHours: 0, remainingHours: 10 }));
    expect(await screen.findByTestId('hour-block-starts-later')).toHaveTextContent(/^Block starts /);
    expect(screen.queryByTestId('hour-block-bar')).toBeNull();
    expect(screen.queryByTestId('hour-block-usage')).toBeNull();
    expect(screen.getByTestId('hour-block-extra-rate')).toBeInTheDocument();
  });

  it('a failed estimate shows the load-failed note without crashing the page', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({}, false));
    render(<ContractDetail detail={{ ...baseDetail, lines: [blockLine()] }} onChanged={vi.fn()} />);
    expect(await screen.findByTestId('hour-block-load-failed')).toBeInTheDocument();
  });

  it('lists closed periods newest first with an invoice link, and loads more with the server cursor', async () => {
    (api.listContractHourPeriods as any)
      .mockResolvedValueOnce(resp({ data: { items: [row(3), row(2)], nextCursor: '2026-02-01|x' } }))
      .mockResolvedValueOnce(resp({ data: { items: [row(1, { overageInvoiceId: null, overageHours: '0.00' })], nextCursor: null } }));
    renderDetail([blockLine()], hb());
    const table = await screen.findByTestId('hour-block-history');
    await waitFor(() => expect(within(table).getAllByTestId(/^hour-block-history-row-/)).toHaveLength(2));
    expect(within(table).getByTestId('hour-block-history-row-hp3').querySelector('a[href="/billing/invoices/inv-1"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId('hour-block-history-more'));
    await waitFor(() => expect(within(table).getAllByTestId(/^hour-block-history-row-/)).toHaveLength(3));
    expect((api.listContractHourPeriods as any).mock.calls[1][1]).toMatchObject({ cursor: '2026-02-01|x' });
    expect(screen.queryByTestId('hour-block-history-more')).toBeNull();
  });

  it('empty history and a failed history fetch are both explicit', async () => {
    renderDetail([blockLine()], hb());
    expect(await screen.findByTestId('hour-block-history-empty')).toBeInTheDocument();
    (api.listContractHourPeriods as any).mockResolvedValue(resp({}, false));
    const { unmount } = renderDetail([blockLine()], hb());
    unmount();
    renderDetail([blockLine()], hb());
    expect(await screen.findByTestId('hour-block-history-error')).toBeInTheDocument();
  });

  it('flags a closed period that had overage but lost its invoice, and shows a plain dash only when nothing was over', async () => {
    (api.listContractHourPeriods as any).mockResolvedValue(resp({ data: { items: [
      row(3, { overageInvoiceId: null, overageHours: '2.00' }),   // invoice removed: hours not billed
      row(2, { overageInvoiceId: null, overageHours: '0.00' }),   // nothing over: no invoice expected
      row(1),                                                       // invoiced
    ], nextCursor: null } }));
    renderDetail([blockLine()], hb());
    expect(await screen.findByTestId('hour-block-history-removed-hp3')).toHaveTextContent('Overage invoice removed — hours not billed');
    expect(screen.queryByTestId('hour-block-history-removed-hp2')).toBeNull();
    expect(screen.queryByTestId('hour-block-history-removed-hp1')).toBeNull();
  });

  it('a retired block still shows its history and a Retired badge in the lines table, with no live bar', async () => {
    (api.listContractHourPeriods as any).mockResolvedValue(resp({ data: { items: [row(1)], nextCursor: null } }));
    renderDetail([blockLine({ hourBlockRetiredAt: '2026-07-10T00:00:00Z' })], null);
    expect(await screen.findByTestId('hour-block-history')).toBeInTheDocument();
    expect(screen.queryByTestId('hour-block-bar')).toBeNull();
    expect(screen.getByTestId('contract-detail-line-b1')).toHaveTextContent('Retired');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractDetail.hourBlock.test.tsx`
Expected: FAIL — no `hour-block-panel`.

- [ ] **Step 3: Implement**

`HourBlockPanel.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { HourBlockEstimate } from '@breeze/shared';
import { listContractHourPeriods, type HourPeriodRow } from '../../lib/api/contracts';
import { formatDate, formatMoney } from '../billing/invoiceTypes';

/** 6.5 -> "6.5", 10 -> "10", "12.00" -> "12": hours are 2-dp, never padded. */
const fmtHours = (n: number | string): string => String(Number(Number(n).toFixed(2)));
const PAGE = 12;

interface Props {
  contractId: string;
  currency: string;
  hourBlock: HourBlockEstimate | null;
  estimateFailed: boolean;
  /** Changes whenever the parent reloads the estimate; the history reloads with it. */
  reloadKey: unknown;
}

export default function HourBlockPanel({ contractId, currency, hourBlock: est, estimateFailed, reloadKey }: Props) {
  const { t } = useTranslation('billing');
  const [rows, setRows] = useState<HourPeriodRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (after?: string) => {
    let res: Response;
    try {
      res = await listContractHourPeriods(contractId, { limit: PAGE, cursor: after });
    } catch {
      if (mounted.current) { setFailed(true); setLoaded(true); }
      return;
    }
    if (!res.ok) { if (mounted.current) { setFailed(true); setLoaded(true); } return; }
    const body = (await res.json().catch(() => null)) as { data?: { items: HourPeriodRow[]; nextCursor: string | null } } | null;
    if (!mounted.current) return;
    setFailed(false);
    setRows((prev) => (after ? [...prev, ...(body?.data?.items ?? [])] : (body?.data?.items ?? [])));
    setCursor(body?.data?.nextCursor ?? null);
    setLoaded(true);
  }, [contractId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load, reloadKey]);

  const opening = est ? est.includedHours + est.carriedInHours : 0;
  const pct = est && opening > 0 ? Math.min(100, (est.consumedHours / opening) * 100) : 0;
  const alerting = !!est && est.alertPct != null && pct >= est.alertPct;
  const startsLater = !!est && est.periodStart > new Date().toISOString().slice(0, 10);

  return (
    <section className="rounded-lg border bg-card shadow-xs" data-testid="hour-block-panel">
      <h3 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('contracts.hourBlock.detail.title')}
      </h3>

      <div className="space-y-2 p-3 text-sm">
        {est && startsLater ? (
          <>
            {/* I9: the block starts at the NEXT period (advance, added mid-period) — say so instead of a 0-used bar. */}
            <p className="font-medium" data-testid="hour-block-starts-later">
              {t('contracts.hourBlock.detail.startsLater', { date: formatDate(est.periodStart) })}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="hour-block-extra-rate">
              {t('contracts.hourBlock.detail.extraRate', { rate: formatMoney(est.overageUnitPrice, currency) })}
            </p>
          </>
        ) : est ? (
          <>
            <p className="font-medium tabular-nums" data-testid="hour-block-usage">
              {t('contracts.hourBlock.detail.usage', {
                used: fmtHours(est.consumedHours), included: fmtHours(opening),
                remaining: fmtHours(est.remainingHours), end: formatDate(est.periodEnd),
              })}
            </p>
            <div
              role="progressbar" aria-valuemin={0} aria-valuemax={opening} aria-valuenow={est.consumedHours}
              aria-label={t('contracts.hourBlock.detail.title')} data-testid="hour-block-bar"
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className={est.overageHours > 0 ? 'h-full bg-destructive' : alerting ? 'h-full bg-amber-500' : 'h-full bg-primary'}
                style={{ width: `${pct}%` }}
              />
            </div>
            {est.carriedInHours > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="hour-block-carried">
                {t('contracts.hourBlock.detail.carried', { hours: fmtHours(est.carriedInHours) })}
              </p>
            )}
            {est.unapprovedHours > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="hour-block-unapproved">
                {t('contracts.hourBlock.detail.unapproved', { hours: fmtHours(est.unapprovedHours) })}
              </p>
            )}
            {est.foreignCurrencyHours > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="hour-block-foreign">
                {t('contracts.hourBlock.detail.foreign', { hours: fmtHours(est.foreignCurrencyHours) })}
              </p>
            )}
            {est.overageHours > 0 && (
              <div data-testid="hour-block-over">
                <p className="font-medium text-destructive">
                  {t('contracts.hourBlock.detail.over', { hours: fmtHours(est.overageHours), amount: formatMoney(est.overageValue, currency) })}
                </p>
                <p className="text-xs text-muted-foreground" data-testid="hour-block-timing-note">
                  {est.billingTiming === 'advance' ? t('contracts.hourBlock.detail.advanceNote') : t('contracts.hourBlock.detail.arrearsNote')}
                </p>
              </div>
            )}
            {est.lateEntryHours > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="hour-block-late">
                {t('contracts.hourBlock.detail.lateEntry', { hours: fmtHours(est.lateEntryHours) })}
              </p>
            )}
            <p className="text-xs text-muted-foreground" data-testid="hour-block-extra-rate">
              {t('contracts.hourBlock.detail.extraRate', { rate: formatMoney(est.overageUnitPrice, currency) })}
            </p>
          </>
        ) : estimateFailed ? (
          <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="hour-block-load-failed">
            {t('contracts.hourBlock.detail.loadFailed')}
          </p>
        ) : null}
      </div>

      <h4 className="border-y px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('contracts.hourBlock.history.title')}
      </h4>
      {failed ? (
        <p className="px-3 py-4 text-xs text-amber-600 dark:text-amber-500" data-testid="hour-block-history-error">
          {t('contracts.hourBlock.detail.loadFailed')}
        </p>
      ) : loaded && rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground" data-testid="hour-block-history-empty">
          {t('contracts.hourBlock.history.empty')}
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="hour-block-history">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.billingHistory.period')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.included')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.carriedIn')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.used')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.over')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('contracts.hourBlock.history.carriedOut')}</th>
              <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.billingHistory.invoice')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t" data-testid={`hour-block-history-row-${r.id}`}>
                <td className="px-3 py-2">{formatDate(r.periodStart)} – {formatDate(r.periodEnd)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.includedHours)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.carriedInHours)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.consumedHours)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.overageHours)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtHours(r.carriedOutHours)}</td>
                <td className="px-3 py-2">
                  {r.overageInvoiceId
                    ? <a href={`/billing/invoices/${r.overageInvoiceId}`} className="text-primary hover:underline">{t('contracts.contractDetail.billingHistory.viewInvoice')}</a>
                    : Number(r.overageHours) > 0
                      // I7: the ledger says hours were over, but the draft invoice that carried them is gone
                      // (the FK is ON DELETE SET NULL) — nothing billed them. Say so; never a quiet dash.
                      ? <span className="text-xs text-amber-600 dark:text-amber-500" data-testid={`hour-block-history-removed-${r.id}`}>{t('contracts.hourBlock.history.invoiceRemoved')}</span>
                      : <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor && !failed && (
        <div className="border-t px-3 py-2">
          <button
            type="button" onClick={() => void load(cursor)} data-testid="hour-block-history-more"
            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
          >
            {t('contracts.hourBlock.history.loadMore')}
          </button>
        </div>
      )}
    </section>
  );
}
```

`ContractDetail.tsx`:
1. `import HourBlockPanel from './HourBlockPanel';`
2. Insert between the header card (`data-testid="contract-header"`, closes at `:386`) and the `{/* Lines (read-only) */}` card:

```tsx
          {lines.some((l) => l.lineType === 'hour_block') && (
            <HourBlockPanel
              contractId={contract.id}
              currency={currency}
              hourBlock={estimate?.hourBlock ?? null}
              estimateFailed={estimateFailed}
              reloadKey={estimate}
            />
          )}
```
3. In the lines table's type cell (`:411-431`), after the group span:

```tsx
                        {l.lineType === 'hour_block' && l.hourBlockRetiredAt
                          ? <span className="block text-xs text-muted-foreground">{t('contracts.hourBlock.row.retiredBadge')}</span>
                          : null}
```

- [ ] **Step 4: Run to verify it passes, then the neighbours**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractDetail.hourBlock.test.tsx src/components/contracts/ContractDetail.allowance.test.tsx src/components/contracts/ContractDetail.outcome.test.tsx src/components/contracts/ContractDetail.groups.test.tsx src/components/contracts/ContractDetail.currency.test.tsx` then `cd apps/web && npx tsc --noEmit -p .`.
Expected: PASS, 5 files.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/contracts/HourBlockPanel.tsx apps/web/src/components/contracts/ContractDetail.tsx apps/web/src/components/contracts/ContractDetail.hourBlock.test.tsx
git commit -m "feat(web): block-hours balance and closed-period history on the contract page (#4547)

Usage bar for the open period with the unapproved, foreign-currency and
late-entry notes, the over-block state with the money due at period close and
the billing-timing note, and a paginated list of closed periods.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Held-for-block notice on invoice assembly

**Files:**
- Create: `apps/api/src/__tests__/integration/invoiceAssemblyHeldHourBlock.integration.test.ts`
- Modify (only if the integration test is red): `apps/api/src/services/invoiceService.ts` (`finishAssembly`, `:1288-1318`), `apps/api/src/services/invoiceAssembly.ts` (`mergeAssembly`, `:81-89`)
- Modify: `apps/web/src/components/billing/InvoicesPage.tsx`, `apps/web/src/components/billing/InvoicesPage.test.tsx`
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx`, `apps/web/src/components/tickets/TicketWorkbench.test.tsx`

**Interfaces:**
- Consumes (W02, index C7): `AssemblyResult.heldForHourBlock: { count: number; hours: number }`, produced by `gatherOrgTimeEntries` / `gatherTicketBillables` when an entry falls inside a block's pending window. **W03 owns rendering it, and verifying it reaches the response.** `finishAssembly` returns `{ ...invoice, blockedByCurrency, missingRate }` today (`invoiceService.ts:1317`); whether W02 threaded `heldForHourBlock` through it and through `mergeAssembly` is the first thing this task proves.
- Produces: `POST /orgs/:orgId/invoices/assemble` and `POST /tickets/:id/invoice` answer `data.heldForHourBlock: { count, hours }` (always present, `{ count: 0, hours: 0 }` when nothing is held); when **everything** gatherable is held the 409 `NOTHING_TO_INVOICE` carries `details.heldForHourBlock`. The web renders "N time entries (X hours) are held for this organization's block hours and will be billed when the block period closes." as a warning toast, exactly where the existing `blockedByCurrency` notice lives.

Where the web does this today (verified): the org assembly dialog is `InvoicesPage.tsx` (`submitDialog`, `:307-361`; the partial-success warning toast per blocked currency at `:337-339`); the per-ticket assembly is `TicketWorkbench.tsx` (`createInvoice`, `:625-668`; blocked/missing-rate panel at `:1285-1320`).

- [ ] **Step 1: Write the failing tests**

*API (real DB)* — `invoiceAssemblyHeldHourBlock.integration.test.ts` (imports and seeding style of `contractLineAllowanceLifecycle.integration.test.ts`: `import './setup'`, `withSystemDbAccessContext`, a partner/org/user, a block line inserted **directly** with `hour_block_first_period_start` = the current period's start so the open window is live):

```ts
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { randomUUID } from 'node:crypto';
import { db, withSystemDbAccessContext } from '../../db';
import { contractLines, contracts, organizations, partners, timeEntries, users } from '../../db/schema';
import { assembleDraftFromOrg } from '../../services/invoiceService';
import { computePeriod, periodIndexFor, todayISO } from '../../services/contractMath';

/** First day of the current UTC month, one month back, as the contract start: today is always inside period idx>=1. */
function currentPeriod() {
  const t = todayISO();
  const startDate = `${String(Number(t.slice(0, 4)) - 1)}-${t.slice(5, 7)}-01`;
  const idx = periodIndexFor(startDate, 1, t);
  return { startDate, ...computePeriod(startDate, 1, idx) };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = randomUUID().slice(0, 8);
    const [p] = await db.insert(partners).values({ name: `HB ${sfx}`, slug: `hb-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'HBOrg', slug: `hb-${sfx}`, taxRate: '0.00000' }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({ partnerId: p!.id, orgId: o!.id, email: `hb-${sfx}@x.io`, name: 'HB', status: 'active' }).returning({ id: users.id });
    const per = currentPeriod();
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Block contract', status: 'active', intervalMonths: 1, startDate: per.startDate,
      nextBillingAt: per.periodEnd, currencyCode: 'USD', billingTiming: 'advance', createdBy: u!.id,
    }).returning({ id: contracts.id });
    await db.insert(contractLines).values({
      contractId: c!.id, orgId: o!.id, lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
      includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00',
      rolloverPolicy: 'none', hourBlockFirstPeriodStart: per.periodStart,
    });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id, per, actor: { userId: u!.id, partnerId: p!.id, accessibleOrgIds: [o!.id] } };
  });
}

const entry = (f: { partnerId: string; orgId: string; userId: string }, endedAt: Date, minutes: number) => ({
  partnerId: f.partnerId, orgId: f.orgId, userId: f.userId, startedAt: new Date(endedAt.getTime() - minutes * 60_000), endedAt,
  durationMinutes: minutes, isBillable: true, hourlyRate: '100.00', currencyCode: 'USD', billingStatus: 'not_billed' as const, isApproved: true,
});

describe('assembly reports hours held for the organization block (#4547 W03, Open Decision 9)', () => {
  it('a mixed gather returns the draft plus heldForHourBlock', async () => {
    const f = await seed();
    const inWindow = new Date(`${f.per.periodStart}T02:00:00Z`);
    const before = new Date(new Date(`${f.per.periodStart}T00:00:00Z`).getTime() - 3 * 86_400_000);
    await withSystemDbAccessContext(() => db.insert(timeEntries).values([entry(f, inWindow, 60), entry(f, before, 30)]));
    const from = new Date(before.getTime() - 86_400_000).toISOString().slice(0, 10);
    const to = f.per.periodEnd;
    const out = await withSystemDbAccessContext(() => assembleDraftFromOrg({ orgId: f.orgId, from, to }, f.actor as never));
    expect(out.heldForHourBlock).toEqual({ count: 1, hours: 1 });
    expect(out.lines).toHaveLength(1);                                   // only the entry outside the block window
  });

  it('when EVERYTHING gatherable is held, the 409 carries heldForHourBlock so the UI can say why', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => db.insert(timeEntries).values([entry(f, new Date(`${f.per.periodStart}T02:00:00Z`), 90)]));
    await expect(withSystemDbAccessContext(() => assembleDraftFromOrg(
      { orgId: f.orgId, from: f.per.periodStart, to: f.per.periodEnd }, f.actor as never,
    ))).rejects.toMatchObject({ code: 'NOTHING_TO_INVOICE', status: 409, details: { heldForHourBlock: { count: 1, hours: 1.5 } } });
  });

  it('with no block, heldForHourBlock is zero and the response shape is otherwise unchanged', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => db.update(contractLines).set({ hourBlockRetiredAt: new Date() }));
    await withSystemDbAccessContext(() => db.insert(timeEntries).values([entry(f, new Date(`${f.per.periodStart}T02:00:00Z`), 60)]));
    const out = await withSystemDbAccessContext(() => assembleDraftFromOrg(
      { orgId: f.orgId, from: f.per.periodStart, to: f.per.periodEnd }, f.actor as never));
    expect(out.heldForHourBlock).toEqual({ count: 0, hours: 0 });
    expect(out.lines).toHaveLength(1);
  });
});
```
(The `time_entries` currency/rate CHECKs and the `time_entries_org_partner_fk` are satisfied by the same-partner org and the stamped USD currency. The all-held case also needs `finishAssembly` to put the held figure in the 409 details; that is the code change below if W02 did not.)

*Web — `InvoicesPage.test.tsx`*, inside `describe('assemble blocked-by-currency recovery')` after its last `it`:

```tsx
    it('warns that entries are held for the block hours, then still opens the draft', async () => {
      wireAssemble(() => json({
        data: { invoice: { id: 'inv-new' }, lines: [], blockedByCurrency: [], heldForHourBlock: { count: 2, hours: 1.5 } },
      }));
      await openAndFill();
      fireEvent.click(screen.getByTestId('invoices-assemble-submit'));
      await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-new'));
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'warning',
        message: expect.stringMatching(/2 time entries \(1\.5 hours\) are held for this organization's block hours/),
      }));
    });

    it('says nothing when nothing is held', async () => {
      wireAssemble(() => json({
        data: { invoice: { id: 'inv-new' }, lines: [], blockedByCurrency: [], heldForHourBlock: { count: 0, hours: 0 } },
      }));
      await openAndFill();
      fireEvent.click(screen.getByTestId('invoices-assemble-submit'));
      await waitFor(() => expect(navigateTo).toHaveBeenCalled());
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    });

    it('on 409 NOTHING_TO_INVOICE with held hours, explains why instead of leaving a bare error', async () => {
      wireAssemble(() => json({
        error: 'No unbilled billable work in range', code: 'NOTHING_TO_INVOICE',
        details: { heldForHourBlock: { count: 1, hours: 1 } },
      }, false, 409));
      await openAndFill();
      fireEvent.click(screen.getByTestId('invoices-assemble-submit'));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'warning', message: expect.stringContaining('1 time entry (1 hours) is held'),
      })));
      expect(navigateTo).not.toHaveBeenCalled();
    });
```

*Web — `TicketWorkbench.test.tsx`*, after `'navigates straight to the draft when nothing was left out'` (`:2742`):

```tsx
  it('warns about hours held for the organization block, then opens the draft', async () => {
    const ticket = makeTicket({ id: 'tk-1' });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if ((!init?.method || init.method === 'GET') && url === '/tickets/tk-1') return makeJsonResponse({ data: ticket });
      if (init?.method === 'POST' && url === '/tickets/tk-1/invoice') {
        return makeJsonResponse({ data: { invoice: { id: 'inv-1' }, lines: [], blockedByCurrency: [], missingRate: [], heldForHourBlock: { count: 1, hours: 0.5 } } });
      }
      return makeJsonResponse({ success: true });
    });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-create-invoice'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-1'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning', message: expect.stringContaining('1 time entry (0.5 hours) is held'),
    }));
  });
```

- [ ] **Step 2: Run to verify it fails**

API: `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/invoiceAssemblyHeldHourBlock.integration.test.ts`. Web: `cd apps/web && npx vitest run src/components/billing/InvoicesPage.test.tsx src/components/tickets/TicketWorkbench.test.tsx`.
Expected: web FAIL (no toast). API: **if W02 threaded the figure the three API cases may already pass** — then this half of the task is a verified no-op; if any is red, apply the threading below.

- [ ] **Step 3: Implement**

*API threading (only what the red test names):*
- `mergeAssembly` (`invoiceAssembly.ts:81-89`): `out.heldForHourBlock` is the sum of the parts' (`count` and `hours`, hours re-rounded to 2 dp), `{ count: 0, hours: 0 }` for parts without it; initial values in `partitionByCurrency` / `mergeAssembly` literals gain `heldForHourBlock: { count: 0, hours: 0 }` so the type is never optional downstream.
- `finishAssembly` (`invoiceService.ts:1288`):

```ts
  const held = gathered.heldForHourBlock ?? { count: 0, hours: 0 };
  …
    // (after the blocked / missing-rate branches)
    throw new InvoiceServiceError(
      nothingMessage, 409, 'NOTHING_TO_INVOICE',
      held.count > 0 ? { heldForHourBlock: held } : undefined,
    );
  …
  return { ...(await getInvoice(inv.id, actor)), blockedByCurrency, missingRate, heldForHourBlock: held };
```
(`InvoiceServiceError`'s fourth argument is the `details` payload `handleInvoiceError` echoes, as the two existing branches above it already use.)

*Web:*

`InvoicesPage.tsx` — types and handling:

```ts
interface HeldForHourBlock { count: number; hours: number }
interface AssembleResult {
  data: { id?: string; invoice?: { id?: string }; blockedByCurrency?: BlockedCurrencyGroup[]; heldForHourBlock?: HeldForHourBlock };
}
/** "1.5", not "1.50": hours are shown without padding. */
const heldMessage = (t: TFunction, h: HeldForHourBlock) =>
  t('invoicesPage.dialog.heldForHourBlock', { count: h.count, hours: Number(Number(h.hours).toFixed(2)) });
```
(use the file's existing `t` type alias or inline the call). After the blocked-group toasts (`:337-339`):

```ts
      const held = result?.data?.heldForHourBlock;
      if (held && held.count > 0) showToast({ type: 'warning', message: heldMessage(t, held) });
```
and in the `catch`, before `handleActionError`:

```ts
      if (err instanceof ActionError && err.code === 'NOTHING_TO_INVOICE') {
        // runAction already toasted the server's message; add WHY when the work is merely held for a block.
        const held = (err.body as { details?: { heldForHourBlock?: HeldForHourBlock } } | undefined)?.details?.heldForHourBlock;
        if (held && held.count > 0) { showToast({ type: 'warning', message: heldMessage(t, held) }); return; }
      }
```
(add `heldMessage`/`t` to the `useCallback` deps as the linter requires.)

`TicketWorkbench.tsx`: `import { showToast } from '../shared/Toast';` (the test already mocks that path); extend `AssembleInvoiceResponse.data` with `heldForHourBlock?: { count: number; hours: number }`; in `createInvoice` after `const missing = …`:

```ts
      const held = result?.data?.heldForHourBlock;
      if (held && held.count > 0) {
        showToast({ type: 'warning', message: t('ticketWorkbench.invoice.heldForHourBlock', { count: held.count, hours: Number(Number(held.hours).toFixed(2)) }) });
      }
```
and, in the `catch`, for `err.code === 'NOTHING_TO_INVOICE'` with `details.heldForHourBlock`, the same toast. The partial-success panel logic (blocked / missing rate) is untouched.

- [ ] **Step 4: Run to verify it passes**

Run the Step 2 commands again. Expected: PASS (API 3 cases, web 2 files). Then `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` and `cd apps/web && npx tsc --noEmit -p .`; and the existing assembly suites (`invoiceService*.test.ts`, `invoiceAssembly*.test.ts`) in case `mergeAssembly`'s literal shape changed. Tear the stack down when Task 14 is done, not between tasks.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/invoiceAssemblyHeldHourBlock.integration.test.ts apps/web/src/components/billing/InvoicesPage.tsx apps/web/src/components/billing/InvoicesPage.test.tsx apps/web/src/components/tickets/TicketWorkbench.tsx apps/web/src/components/tickets/TicketWorkbench.test.tsx
git add -u apps/api/src/services
git commit -m "feat(billing): tell the operator when assembled hours are held for a block (#4547)

Invoice assembly already holds a block's open-period entries off ad hoc
invoices; the org and ticket assembly screens now say how many entries and
hours were held and that they settle when the block period closes, including
when everything was held and the draft would otherwise be an unexplained error.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Real-Postgres proof and the verification bar

**Files:**
- Create: `apps/api/src/__tests__/integration/contractHourBlockLines.integration.test.ts`

This is the task that proves, against the real index, the real RLS and the real `breeze_app` role, what the unit tests above can only mock: the live-block index frees on retire **and** on delete; the first-period stamp persists; retired lines vanish from MRR; the estimate's drawdown read works under partner and system scope and **fails closed** under organization scope (with the proof that an org-scoped read of `time_entries` returns zero); and `contract_hour_periods` is readable in the ordinary request context.

- [ ] **Step 1: Write the test** (it is red until Tasks 1-9 are in the checkout; written last because it exercises all of them)

```ts
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contractBillingPeriods, contractHourPeriods, contractLines, contracts, organizations, partners, timeEntries, users } from '../../db/schema';
import {
  activateContract, addContractLineToContract, computeContractEstimate, removeContractLine, summarizeActiveContractMrrByOrg,
  updateContractLine, type ContractActorT,
} from '../../services/contractService';
import { computeOpenHourBlockPeriod } from '../../services/contractHourBlockEstimate';
import { listContractHourPeriods } from '../../services/contractHourPeriodsRead';
import { computePeriod, periodIndexFor, todayISO } from '../../services/contractMath';

const partnerCtx = (partnerId: string, orgIds: string[]) =>
  ({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null }) as never;
const orgCtx = (orgId: string) =>
  ({ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null }) as never;

interface Fixture { partnerId: string; orgId: string; userId: string; actor: ContractActorT }

async function seedOrg(partnerId?: string): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = randomUUID().slice(0, 8);
    let pid = partnerId;
    if (!pid) {
      const [p] = await db.insert(partners).values({ name: `HBL ${sfx}`, slug: `hbl-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
      pid = p!.id;
    }
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: pid, name: `HBLOrg ${sfx}`, slug: `hbl-${sfx}`, taxRate: '0.00000' }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({ partnerId: pid, orgId: o!.id, email: `hbl-${sfx}@x.io`, name: 'HBL', status: 'active' }).returning({ id: users.id });
    return { partnerId: pid, orgId: o!.id, userId: u!.id, actor: { userId: u!.id, partnerId: pid, accessibleOrgIds: [o!.id] } };
  });
}

const seedContract = (f: Fixture, over: Record<string, unknown> = {}) => withSystemDbAccessContext(async () => {
  const [c] = await db.insert(contracts).values({
    partnerId: f.partnerId, orgId: f.orgId, name: 'Block contract', status: 'draft', intervalMonths: 1,
    startDate: '2020-01-01', currencyCode: 'USD', billingTiming: 'advance', createdBy: f.userId, ...over,
  } as never).returning();
  return c!;
});

const BLOCK = {
  lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
  includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none',
} as never;

const ledger = (f: Fixture, contractId: string, lineId: string) => withSystemDbAccessContext(() => db.insert(contractHourPeriods).values({
  contractLineId: lineId, contractId, orgId: f.orgId, periodStart: '2020-02-01', periodEnd: '2020-03-01',
  includedHours: '10.00', carriedInHours: '0.00', consumedHours: '4.00', overageHours: '0.00', carriedOutHours: '0.00',
  entryCount: 2, overageUnitPrice: '150.00', currencyCode: 'USD', closeSource: 'billing_run',
}).returning({ id: contractHourPeriods.id }));

describe('block-hours lines against real Postgres (#4547 W03)', () => {
  describe('entitlement starts where the fee starts (index C9)', () => {
    const today = todayISO();
    const startDate = `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}-01`;       // day 1: no month-end clamping
    const cur = computePeriod(startDate, 1, periodIndexFor(startDate, 1, today));      // the period in progress
    const stampOf = (lineId: string) => withSystemDbAccessContext(async () =>
      (await db.select({ s: contractLines.hourBlockFirstPeriodStart }).from(contractLines).where(eq(contractLines.id, lineId)))[0]!.s);

    it('active ADVANCE contract: the next period; the stamp and the other block columns persist', async () => {
      const f = await seedOrg();
      const c = await seedContract(f, { status: 'active', startDate, billingTiming: 'advance', nextBillingAt: cur.periodEnd });
      const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
      expect(row).toMatchObject({
        lineType: 'hour_block', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: null,
        hourBlockRetiredAt: null, siteId: null, deviceRoles: null,
      });
      expect(row.hourBlockFirstPeriodStart).toBe(cur.periodEnd);
    });

    it('active ARREARS contract: the period in progress', async () => {
      const f = await seedOrg();
      const c = await seedContract(f, { status: 'active', startDate, billingTiming: 'arrears', nextBillingAt: cur.periodEnd });
      const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
      expect(row.hourBlockFirstPeriodStart).toBe(cur.periodStart);
    });

    it('PAUSE -> RESUME on an advance contract: the pointer sits on a period claimed before the pause, so the block starts at the first UNCLAIMED one', async () => {
      const f = await seedOrg();
      const c = await seedContract(f, { status: 'active', startDate, billingTiming: 'advance', nextBillingAt: cur.periodStart });
      await withSystemDbAccessContext(() => db.insert(contractBillingPeriods).values({
        contractId: c.id, orgId: f.orgId, periodStart: cur.periodStart, periodEnd: cur.periodEnd,
      }));
      const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
      expect(row.hourBlockFirstPeriodStart).toBe(cur.periodEnd);
    });

    it.each(['advance', 'arrears'] as const)('%s DRAFT with a past start date: provisional first period, re-stamped to the period activation claims', async (billingTiming) => {
      const f = await seedOrg();
      const c = await seedContract(f, { status: 'draft', startDate, billingTiming });
      const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
      expect(row.hourBlockFirstPeriodStart).toBe(startDate);                            // provisional: the contract's first period
      await withSystemDbAccessContext(() => activateContract(c.id, f.actor, new Date()));
      expect(await stampOf(row.id)).toBe(cur.periodStart);                              // the period containing the activation day
    });
  });

  it('add -> retire -> add again: the live-block index rejects a second block, frees on delete, frees on retire', async () => {
    const f = await seedOrg();
    const c1 = await seedContract(f, { name: 'C1' });
    const c2 = await seedContract(f, { name: 'C2' });

    const first = await withSystemDbAccessContext(() => addContractLineToContract(c1.id, BLOCK, f.actor));
    // Same contract and a sibling contract of the same org both hit the REAL index.
    for (const contractId of [c1.id, c2.id]) {
      await expect(withSystemDbAccessContext(() => addContractLineToContract(contractId, BLOCK, f.actor)))
        .rejects.toMatchObject({ code: 'HOUR_BLOCK_EXISTS', status: 409 });
    }

    // No history -> DELETE; the index frees.
    const removed = await withSystemDbAccessContext(() => removeContractLine(c1.id, first.id, f.actor));
    expect(removed.retired).toBe(false);
    expect(await withSystemDbAccessContext(() => db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.id, first.id)))).toHaveLength(0);
    const second = await withSystemDbAccessContext(() => addContractLineToContract(c2.id, BLOCK, f.actor));

    // History -> RETIRE (row kept, ledger FK intact); the index frees again.
    await ledger(f, c2.id, second.id);
    const retired = await withSystemDbAccessContext(() => removeContractLine(c2.id, second.id, f.actor));
    expect(retired.retired).toBe(true);
    const [kept] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, second.id)));
    expect(kept!.hourBlockRetiredAt).toBeInstanceOf(Date);          // stamped with the database's now() (transaction time)
    // Idempotent: a second remove neither deletes nor moves retired_at.
    const again = await withSystemDbAccessContext(() => removeContractLine(c2.id, second.id, f.actor));
    expect(again.retired).toBe(true);
    const [still] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, second.id)));
    expect(still!.hourBlockRetiredAt!.getTime()).toBe(kept!.hourBlockRetiredAt!.getTime());

    const third = await withSystemDbAccessContext(() => addContractLineToContract(c1.id, BLOCK, f.actor));
    expect(third.id).not.toBe(second.id);

    // A retired block refuses every edit.
    await expect(withSystemDbAccessContext(() => updateContractLine(c2.id, second.id, { description: 'x' } as never, f.actor)))
      .rejects.toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED' });
  });

  it('a claimed period at or after the first period retires instead of deleting, even with no ledger row yet', async () => {
    const f = await seedOrg();
    const c = await seedContract(f, { status: 'active', nextBillingAt: '2099-01-01' });
    const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
    await withSystemDbAccessContext(() => db.execute(
      // contract_billing_periods claim for the line's first period (advance contracts claim at the period start).
      (async () => { const { sql } = await import('drizzle-orm'); return sql`
        INSERT INTO contract_billing_periods (contract_id, org_id, period_start, period_end)
        VALUES (${c.id}::uuid, ${f.orgId}::uuid, ${row.hourBlockFirstPeriodStart}::date, (${row.hourBlockFirstPeriodStart}::date + interval '1 month')::date)`; })() as never));
    const out = await withSystemDbAccessContext(() => removeContractLine(c.id, row.id, f.actor));
    expect(out.retired).toBe(true);
    expect(await withSystemDbAccessContext(() => db.select({ id: contractLines.id }).from(contractLines).where(eq(contractLines.id, row.id)))).toHaveLength(1);
  });

  it('MRR counts the block fee once and never hours; a retired block counts nothing', async () => {
    const f = await seedOrg();
    const c = await seedContract(f, { status: 'active', nextBillingAt: '2099-01-01' });
    const row = await withSystemDbAccessContext(() => addContractLineToContract(c.id, BLOCK, f.actor));
    // 100 hours of entries must not move MRR.
    await withSystemDbAccessContext(() => db.insert(timeEntries).values(Array.from({ length: 10 }, (_, i) => ({
      partnerId: f.partnerId, orgId: f.orgId, userId: f.userId,
      startedAt: new Date(Date.now() - (i + 1) * 3_600_000 * 10), endedAt: new Date(Date.now() - (i + 1) * 3_600_000 * 10 + 36_000_00),
      durationMinutes: 600, isBillable: true, hourlyRate: '100.00', currencyCode: 'USD', billingStatus: 'not_billed' as const,
    }))));
    const mrr = await withSystemDbAccessContext(() => summarizeActiveContractMrrByOrg([f.orgId]));
    expect(mrr.get(f.orgId)).toEqual([{ currencyCode: 'USD', amount: '1000.00' }]);

    await withSystemDbAccessContext(() => db.update(contractLines).set({ hourBlockRetiredAt: new Date() }).where(eq(contractLines.id, row.id)));
    const after = await withSystemDbAccessContext(() => summarizeActiveContractMrrByOrg([f.orgId]));
    expect(Number(after.get(f.orgId)?.find((r) => r.currencyCode === 'USD')?.amount ?? '0')).toBe(0);
  });

  describe('the open-period read and the partner-axis trap', () => {
    async function seedOpenPeriod() {
      const f = await seedOrg();
      const t = todayISO();
      const startDate = `${Number(t.slice(0, 4)) - 1}-${t.slice(5, 7)}-01`;
      const per = computePeriod(startDate, 1, periodIndexFor(startDate, 1, t));
      const c = await seedContract(f, { status: 'active', startDate, nextBillingAt: per.periodEnd });
      // Inserted directly so the block already counts the CURRENT period (service stamping would start it next period).
      const [line] = await withSystemDbAccessContext(() => db.insert(contractLines).values({
        contractId: c.id, orgId: f.orgId, lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
        includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none',
        hourBlockFirstPeriodStart: per.periodStart,
      }).returning());
      const other = await seedOrg(f.partnerId);                       // a second org of the same partner
      const at = new Date(`${per.periodStart}T02:00:00Z`);
      const e = (orgId: string, minutes: number, over: Record<string, unknown> = {}) => ({
        partnerId: f.partnerId, orgId, userId: f.userId, startedAt: new Date(at.getTime() - minutes * 60_000), endedAt: at,
        durationMinutes: minutes, isBillable: true, hourlyRate: '100.00', currencyCode: 'USD',
        billingStatus: 'not_billed' as const, isApproved: true, ...over,
      });
      await withSystemDbAccessContext(() => db.insert(timeEntries).values([
        e(f.orgId, 390),                                              // 6.5 h, approved
        e(f.orgId, 60, { isApproved: false }),                        // 1 h, unapproved
        e(f.orgId, 600, { isBillable: false }),                       // ignored
        e(f.orgId, 600, { billingStatus: 'no_charge' }),              // ignored
        e(other.orgId, 600),                                          // another org: ignored
      ]));
      return { f, c, line: line!, per };
    }

    it('reads the same figures under system scope and under the owning partner', async () => {
      const { f, c, line } = await seedOpenPeriod();
      const viaSystem = await withSystemDbAccessContext(() => computeOpenHourBlockPeriod(c, line));
      const viaPartner = await withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => computeOpenHourBlockPeriod(c, line));
      for (const out of [viaSystem, viaPartner]) {
        expect(out).toMatchObject({ consumedHours: 7.5, unapprovedHours: 1, remainingHours: 2.5, overageHours: 0, includedHours: 10 });
      }
    });

    it('THE TRAP: an organization-scoped read of time_entries sees ZERO rows, and the estimate refuses to run there', async () => {
      const { f, c, line } = await seedOpenPeriod();
      const seen = await withDbAccessContext(orgCtx(f.orgId), () => db.select({ id: timeEntries.id }).from(timeEntries).where(eq(timeEntries.orgId, f.orgId)));
      expect(seen).toHaveLength(0);                                   // partner-axis RLS: the org token cannot see its own entries
      await expect(withDbAccessContext(orgCtx(f.orgId), () => computeOpenHourBlockPeriod(c, line)))
        .rejects.toMatchObject({ code: 'INVALID_STATE', status: 500 });   // fail closed, never "0 hours used"
    });

    it('computeContractEstimate carries the live block under the partner context the route uses', async () => {
      const { f, c } = await seedOpenPeriod();
      const est = await withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => computeContractEstimate(c.id, f.actor));
      expect(est.hourBlock).toMatchObject({ consumedHours: 7.5, remainingHours: 2.5 });
      expect(est.periodTotal).toBe('1000.00');                        // the fee once; hours never in the money total
      const optedOut = await withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => computeContractEstimate(c.id, f.actor, undefined, { includeHourBlock: false }));
      expect(optedOut.hourBlock).toBeNull();
    });

    it('contract_hour_periods (Shape 1) is readable in the ordinary request context, and only for its own org', async () => {
      const { f, c, line } = await seedOpenPeriod();
      await ledger(f, c.id, line.id);
      const page = await withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => listContractHourPeriods(c.id, { limit: 10 }, f.actor));
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ consumedHours: '4.00', closeSource: 'billing_run' });
      const ownOrg = await withDbAccessContext(orgCtx(f.orgId), () => db.select({ id: contractHourPeriods.id }).from(contractHourPeriods));
      expect(ownOrg).toHaveLength(1);
      const stranger = await seedOrg();
      const foreign = await withDbAccessContext(orgCtx(stranger.orgId), () => db.select({ id: contractHourPeriods.id }).from(contractHourPeriods));
      expect(foreign).toHaveLength(0);
      await expect(withDbAccessContext(partnerCtx(f.partnerId, [stranger.orgId]), () => listContractHourPeriods(c.id, { limit: 10 }, { ...f.actor, accessibleOrgIds: [stranger.orgId] })))
        .rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
    });
  });
});
```

(The seeds intentionally use the same table/column names `contractLineAllowanceLifecycle.integration.test.ts` and `contractLineEditing.integration.test.ts` use. If a `time_entries` CHECK rejects a seed, fix the **seed**, never the production rule. The `contract_billing_periods` raw insert in the claimed-period case uses only NOT NULL columns; if the table has more, add them.)

- [ ] **Step 2: Run to verify**

`pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockLines.integration.test.ts src/__tests__/integration/invoiceAssemblyHeldHourBlock.integration.test.ts src/__tests__/integration/orgMerge.integration.test.ts`
Expected: PASS. Debug a red test against the layer it names; do not loosen assertions.

- [ ] **Step 3: The full verification bar** (each command's exit code is the evidence)

```bash
# shared
cd packages/shared && npx vitest run src/validators/contracts.hourBlock.test.ts src/validators/contracts.test.ts src/validators/quotes.test.ts && npx tsc --noEmit -p .
# api unit (small explicit batches; check the reported file count)
cd apps/api && npx vitest run src/services/contractMath.test.ts src/services/contractService.hourBlock.test.ts src/services/contractService.test.ts src/services/contractService.siteScope.test.ts src/services/contractHourBlockEstimate.test.ts src/services/contractHourPeriodsRead.test.ts
cd apps/api && npx vitest run src/routes/contracts/contracts.test.ts src/routes/contracts/hourPeriods.test.ts src/routes/partnerApi/contracts.test.ts src/services/aiToolsContracts.manageContracts.test.ts src/services/aiToolsContracts.test.ts src/services/aiToolsContracts.registryParity.contract.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/contractCoverage.test.ts
cd apps/api && npx vitest run src/services/orgMerge.test.ts src/services/orgMergeRegistry.test.ts      # the FULL orgMerge.test.ts: some contracts only red there
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .
# api integration (stack up)
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractHourBlockLines.integration.test.ts src/__tests__/integration/invoiceAssemblyHeldHourBlock.integration.test.ts src/__tests__/integration/orgMerge.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/contractEstimate.integration.test.ts src/__tests__/integration/contractLineEditing.integration.test.ts src/__tests__/integration/contractLineAllowance.integration.test.ts src/__tests__/integration/contractLineAllowanceLifecycle.integration.test.ts src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts src/__tests__/integration/contractService.integration.test.ts src/__tests__/integration/partnerApiContracts.integration.test.ts
# web
cd apps/web && npx vitest run src/components/contracts/ContractEditor.hourBlock.test.tsx src/components/contracts/ContractDetail.hourBlock.test.tsx src/components/contracts/ContractEditor.allowance.test.tsx src/components/contracts/ContractDetail.allowance.test.tsx src/components/billing/InvoicesPage.test.tsx src/components/tickets/TicketWorkbench.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/locales/humanizedKeyRegression.test.ts src/lib/__tests__/no-silent-mutations.test.ts
cd apps/web && npx tsc --noEmit -p .
# tear down
pnpm test-stack down
```
`pnpm db:check-drift` and the RLS/tenancy contract suites are **not** required: this wave adds no table, column or policy (W01 owns them). If a previous wave's migration is not yet on the base branch, rebase first and re-run.

- [ ] **Step 4: Manual check in a worktree stack** (feature-testing skill; `pnpm wt-stack up`, tear down after). With a partner, an org, an active monthly advance contract and a few time entries: add a block (10 h, \$150/h, carry-forward cap 4) — the row reads "Counts from <next period start>"; add a second block on the same contract (Add disabled with the retire-first hint) and on a second contract of the same org (server 409 toast); open the contract page — bar, then log time past the block — "over the block → \$ at period close" and the advance note; remove a block with no history (deleted) and one with a ledger row (confirm says retire; toast "Block hours retired"); assemble an ad hoc invoice over the open period — the held toast appears. Record what was and was not walked in the PR.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/contractHourBlockLines.integration.test.ts
git commit -m "test(billing): real-database proof for block-hours lines (#4547)

The live-block index frees on delete and on retire, the first period stamp
persists, retired lines drop out of MRR, the open-period read works under the
owning partner and system scope and refuses an organization scope that would
read zero entries, and the closed-period ledger is readable in the ordinary
request context for its own org only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec / index coverage.**

| Requirement | Where |
|---|---|
| Spec §1 line, C2 validator twin, `hour_block` in both tuples, integrality exemption | Task 1 |
| C6 `ContractLineShape` fields, invariant rows (both modes), server-stamped columns never client input, strict update rejection | Task 1 (tests pin strip-on-create and 400-on-patch) |
| C9 (refined): first period whose fee is not yet claimed — active advance → next, active arrears → in progress, draft → provisional then re-stamped in `activateContract` (drafts only) | Tasks 2, 3, 14 |
| `assertRepresentable` on the extra-hours price | Task 3 (already on the path; JPY test pins it) |
| 23505 → 409 `HOUR_BLOCK_EXISTS`, other 23505 untouched | Tasks 3, 14 |
| `allowanceColumnsFor` passes block columns through | Task 3 (no edit needed; the insert assertion pins it) |
| Quote path rejects `hour_block`, before the contract insert | Task 3 |
| `resolveLineQty` fee-only arm (delta 8); MRR once, never hours; retired = 0 | Tasks 3, 14 |
| `updateContractLine` allowed/locked fields, `overageMode` pinned to bill, mid-period edit semantics stated | Task 4 (+ UI copy `midPeriodEdit`) |
| `removeContractLine` retire vs delete, idempotent, history predicate shared with the UI | Task 5 |
| `computeContractEstimate.hourBlock` (C8), system/partner context chosen and justified, double-pool hazard avoided | Task 6 |
| `GET /contracts/:id/hour-periods`, paginated, `contracts:read`, org access, Shape 1 verified | Tasks 7, 14 |
| AI `line` description + budget; add_line accepts a block and rejects `flag` | Task 8 |
| Partner API (unlisted door) | Tasks 5, 8 |
| Open Decision 14 (merge preflight, coordinator addition), incl. the registry-level case | Task 9 |
| Open Decision 15 (mid-period edit = applies at next close): UI notice with dates, audit before/after, AI description | Tasks 4, 8, 10, 11 |
| W01 fail-closed guards/tests removed (not just shadowed) | Tasks 1, 3, 4 |
| Retire uses the database `now()`, history predicate mirrors W02's `generated_at <= retired_at` close rule | Task 5 |
| Stamped-key patch → `HOUR_BLOCK_FIELD_LOCKED` on HTTP, partner API and AI | Task 8 |
| History: overage with a removed invoice is flagged; "Block starts <date>" instead of a 0-used bar | Task 12 |
| Web: add/edit forms, hidden site/roles/group/manual, `bill` fixed, cap disabled under none, retire copy, `runAction` | Tasks 10, 11 |
| Web: bar, sub-figures, over-block, advance/arrears note, late-entry note, history | Task 12 |
| `heldForHourBlock` notice (coordinator addition) | Task 13 |
| 8 locales with real translations; parity/coverage/humanized tests | Task 10 |
| Index C10 codes `HOUR_BLOCK_EXISTS` 409 / `HOUR_BLOCK_FIELD_LOCKED` 400 | Tasks 3, 4 |
| Open Decisions 10 and 13 defaults | Global Constraints; Tasks 1, 4, 11 |

**Placeholder scan.** No "TBD" / "similar to Task N". Two places say "reuse the harness of file X lines a-b verbatim" (Task 7's unit and route tests, Task 8's partner-API case) — each names the exact file and line range and states what to add; the surrounding mock blocks are 60-80 lines of boilerplate that exist unchanged in the repo and are deliberately not duplicated a third time. Task 13's API half is conditional on W02's threading and says exactly which three assertions decide it.

**Type / name consistency.** `HourBlockEstimate` (C8) is used verbatim in Tasks 3, 6, 11, 12. `computeOpenHourBlockPeriod(contract, line, asOf?)` is the coordinator's exact signature. `ContractLineAudit.retired?: boolean` → `{ ok, retired }` on all three doors → `removeLine`'s `successMessage`. `hourBlockHasHistory` is computed once (`hourBlockHasHistory()` in the service) and drives both the retire action and the confirm copy. Test ids used in Tasks 11/12 tests match the markup given.

**Known limits / follow-ups (not done here, by design).**
1. ~~C9 timing-agnosticism~~ — resolved: the coordinator adopted the "first unclaimed period" rule in the index; Tasks 2/3/14 implement it, including the `activateContract` re-stamp. Remaining sharp edge: a *paused* contract's resume deliberately does not re-stamp (claimed periods behind it must stay closable); a block added to a **paused** contract is not possible (`assertEditable` allows draft/active only).
2. `carriedInHours` lags by at most one sweep (documented in the module).
3. The editor shows the stamped first period on the row, not a preview in the add form (a browser copy of `computePeriod` is not worth it).
4. Foreign-currency and late-entry figures are informational; there is still no adjustment mechanism (spec "Out of scope").

**Verification that was actually done while writing this plan:** every `file:line` cited was read against `origin/main` @ `327fa66b11`; nothing here was executed — W01/W02 are not in this checkout, so no test could be run. The first thing the implementer does after rebasing onto W02 is run Task 1's test file; the second is Task 14's.
