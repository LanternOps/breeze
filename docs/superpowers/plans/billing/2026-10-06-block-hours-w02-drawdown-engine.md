---
tracking_issue: LanternOps/breeze#4547
spec: docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md
index: docs/superpowers/plans/billing/2026-10-06-block-hours-index.md
wave: W02 — drawdown engine (one PR)
blast_radius: high (row locks on time_entries inside the billing transaction; invoice money; terminal-status guard; org-move refusals)
---

# Block Hours W02: Drawdown Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close block-hour periods correctly — claim the period's eligible time entries under row locks, write the frozen ledger row, bill overage at the contracted rate, carry hours forward — on the billing run, and close the periods the billing run will never revisit with a daily sweep; and make every other path (time-entry edits, ad-hoc invoice assembly, org moves) respect a drawn or held hour.

**Architecture:** A pure module (`contractHourBlocks.ts`: hours arithmetic, rollover, the closable-period selector) and a DB module (`contractHourBlockClose.ts`: the claim-and-close transaction step, hold windows, the close-out sweep). `generateDueInvoice` bills the block fee like a `flat` line and, after the period claim, calls `closeHourBlockPeriods` for each block line inside the same caller-supplied system transaction. No API can create an `hour_block` line in this wave (`CONTRACT_LINE_TYPES` still excludes it — index "Why the feature opens in W03"); every test seeds block lines directly, the way `contractLineAllowance.integration.test.ts:63-71` does.

**Tech Stack:** Hono + Drizzle + postgres.js; Vitest unit + integration (real Postgres via `pnpm test-stack up`); BullMQ worker (`jobs/contractWorker.ts`).

**Spec:** `docs/superpowers/specs/billing/2026-09-02-block-hours-spec.md` — §2 (drawdown, claimed-period rule, claiming entries, terminal disposition), §3 (rollover), §4 (overage line), Decision 6, the 2026-09-19 amendments, and the 2026-10-06 plan-time amendments 3–7.

**Index:** `docs/superpowers/plans/billing/2026-10-06-block-hours-index.md` — C3, C4, C7, C9, C10, Open Decisions 9 and 11. Names and signatures there are fixed.

**Depends on:** W01 merged (`contract_hour_periods`, `contract_lines` block columns + CHECKs, `time_entries.contract_line_id` + `time_entries_contract_line_chk`, Drizzle `contractHourPeriods`, `HOUR_BLOCK_NOT_ENABLED` arms).

## Global Constraints

- Every function in this wave that reads `time_entries` runs inside a **system** DB context supplied by its caller, except the assembly gatherers, which run in the request's partner-scoped context (partner-axis RLS admits them) — `hourBlockHoldWindows` reads only Shape-1 contract tables and works in either.
- Claim query: `ORDER BY id FOR UPDATE` — the same lock class and order as `issueInvoice` (`invoiceService.ts:1482`).
- Minutes: `COALESCE(billable_minutes, duration_minutes, 0)`. Hours per entry: `round(minutes / 60, 2)` **before** summing. All hours arithmetic in integer hundredths.
- A period is closable iff ended (`periodEnd <= today`), `>= hour_block_first_period_start`, **claimed** (`contract_billing_periods` row), not closed, and, when the line is retired, `periodStart < retired_at::date`. Earliest first, contiguous, at most `HOUR_BLOCK_CLOSE_CAP = 12` per call.
- Period boundary instants: `new Date(\`${periodStart}T00:00:00Z\`)` — UTC midnight, half-open — the same UTC-date convention `assembleDraftFromOrg` uses (`invoiceService.ts:1328`), but exclusive at the end rather than its inclusive `T23:59:59Z`.
- Overage line: `source_type 'contract'`, `source_id` = block line, `source_contract_id` = contract, `parent_line_id NULL`, `catalog_item_id NULL`, `taxable` = the block line's `taxable`, `unit_price` = the line's `overage_unit_price`, quantity = overage hours `toFixed(2)`, description `"<line description> — hours over block, <periodStart> – <periodEnd>"`.
- Close-out overage goes on a **new draft** invoice that is never auto-issued.
- Error codes (index C10): `HOUR_BLOCK_CLOSE_MISMATCH` 500, `ENTRY_DRAWN_BY_BLOCK` 409, `HOUR_BLOCK_DRAWN_TIME` 409.
- No migration in this wave. No public schema accepts `contractLineId`.
- Commit messages and PR body: neutral wording; each commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Advance contract, overage from the previous period.** A reader of the invoice expects the overage line to name *last* period's dates, not this one's. Pinned: Task 4 `advance: P0 overage lands on the P1 invoice with P0's dates`.
2. **The contract is paused for two periods, then resumed.** Expect no ledger rows for the paused periods and no hours granted for them; the pre-pause claimed period still closes. Pinned: Task 3 selector `skips unclaimed periods` + Task 4 `pause gap grants no hours`.
3. **A technician issues an ad-hoc invoice for the same hours while the worker closes the period.** Expect one winner, a clean 409 for the loser, never a 500 or a deadlock, and no hour on both. Pinned: Task 5 concurrency suite.
4. **A technician edits a drawn entry's duration, or flips it back to `not_billed`.** Expect 409 `ENTRY_DRAWN_BY_BLOCK`; a description-only edit still works and does not re-stamp coverage/rate. Pinned: Task 2.
5. **An advance contract expires; its final period ends three weeks later.** Expect that period to close on the first sweep after it ends, with overage on a new draft invoice, and nothing re-billed ad hoc. Pinned: Task 7.

---

### Task 1: Pure arithmetic and the closable-period selector

**Files:**
- Create: `apps/api/src/services/contractHourBlocks.ts`
- Test: `apps/api/src/services/contractHourBlocks.test.ts`

**Interfaces:**
- Consumes: `computePeriod(startDate, intervalMonths, idx): { periodStart, periodEnd }` (`contractMath.ts:30`); `applyAllowance` (`contractAllowance.ts:57`) — used only in a parity test.
- Produces (index C7, exact): `HOUR_BLOCK_CLOSE_CAP`, `RolloverPolicy`, `HourBlockLineSpec`, `entryHours(minutes)`, `sumEntryHours(minutes[])`, `PeriodMath`, `computePeriodMath(spec, carriedInHours, consumedHours)`, `ClosablePeriod`, `selectClosablePeriods(args)`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/contractHourBlocks.test.ts
import { describe, expect, it } from 'vitest';
import {
  HOUR_BLOCK_CLOSE_CAP, computePeriodMath, entryHours, selectClosablePeriods, sumEntryHours,
  type HourBlockLineSpec,
} from './contractHourBlocks';
import { applyAllowance } from './contractAllowance';

const spec = (o: Partial<HourBlockLineSpec> = {}): HourBlockLineSpec => ({
  includedQuantity: '10.00', overageUnitPrice: '150.00', rolloverPolicy: 'none', rolloverCapHours: null, ...o,
});

describe('entryHours / sumEntryHours', () => {
  it.each([[0, 0], [20, 0.33], [30, 0.5], [40, 0.67], [60, 1], [90, 1.5], [125, 2.08]])(
    '%d min -> %d h', (m, h) => expect(entryHours(m)).toBe(h));
  it('rounds each entry before summing (20 min x 3 = 0.99, not 1.00)', () => {
    expect(sumEntryHours([20, 20, 20])).toBe(0.99);
  });
  it('has no float drift over many entries', () => {
    expect(sumEntryHours(Array(300).fill(20))).toBe(99); // 300 x 0.33
  });
  it('rejects negative minutes', () => {
    expect(() => entryHours(-1)).toThrow(/minutes must be >= 0/);
  });
});

describe('computePeriodMath', () => {
  it.each`
    policy             | cap        | carriedIn | consumed | opening | overage | carriedOut
    ${'none'}          | ${null}    | ${0}      | ${0}     | ${10}   | ${0}    | ${0}
    ${'none'}          | ${null}    | ${0}      | ${6.5}   | ${10}   | ${0}    | ${0}
    ${'none'}          | ${null}    | ${0}      | ${10}    | ${10}   | ${0}    | ${0}
    ${'none'}          | ${null}    | ${0}      | ${12.33} | ${10}   | ${2.33} | ${0}
    ${'carry_forward'} | ${null}    | ${0}      | ${6.5}   | ${10}   | ${0}    | ${3.5}
    ${'carry_forward'} | ${null}    | ${3.5}    | ${12}    | ${13.5} | ${0}    | ${1.5}
    ${'carry_forward'} | ${'2.00'}  | ${0}      | ${6.5}   | ${10}   | ${0}    | ${2}
    ${'carry_forward'} | ${'2.00'}  | ${2}      | ${15}    | ${12}   | ${3}    | ${0}
  `('$policy cap=$cap in=$carriedIn used=$consumed', ({ policy, cap, carriedIn, consumed, opening, overage, carriedOut }) => {
    const m = computePeriodMath(spec({ rolloverPolicy: policy, rolloverCapHours: cap }), carriedIn, consumed);
    expect(m).toEqual({
      includedHours: 10, carriedInHours: carriedIn, openingHours: opening,
      consumedHours: consumed, overageHours: overage, carriedOutHours: carriedOut,
    });
  });
  it('agrees with applyAllowance(single_block) on the overage split', () => {
    const m = computePeriodMath(spec(), 0, 12.33);
    const r = applyAllowance(12.33, { includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00' }, 'single_block');
    expect(r.billed).toBe(1);
    expect(Math.round(r.overage * 100) / 100).toBe(m.overageHours);
  });
});

describe('selectClosablePeriods', () => {
  const base = {
    contractStartDate: '2026-01-01', intervalMonths: 1, firstPeriodStart: '2026-01-01',
    retiredAt: null, closedPeriodStarts: new Set<string>(),
  };
  /** Claims generated at 06:00 UTC on each period's start day (the worker's run time). */
  const claimed = (...s: string[]) => s.map((periodStart) => ({ periodStart, generatedAt: new Date(`${periodStart}T06:00:00Z`) }));

  it('closes ended, claimed periods earliest first', () => {
    const r = selectClosablePeriods({ ...base, claims: claimed('2026-01-01', '2026-02-01', '2026-03-01'), todayISO: '2026-03-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-01-01', '2026-02-01']);
    expect(r).toMatchObject({ truncated: false, blockedBy: null });
  });
  it('a period ending today is ended (half-open)', () => {
    const r = selectClosablePeriods({ ...base, claims: claimed('2026-01-01'), todayISO: '2026-02-01' });
    expect(r.periods.map((p) => p.periodEnd)).toEqual(['2026-02-01']);
  });
  it('skips unclaimed periods (pause gap) without blocking', () => {
    const r = selectClosablePeriods({ ...base, claims: claimed('2026-01-01', '2026-04-01'), todayISO: '2026-06-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-01-01', '2026-04-01']);
  });
  it('never closes a period before the first block period', () => {
    const r = selectClosablePeriods({ ...base, firstPeriodStart: '2026-03-01', claims: claimed('2026-01-01', '2026-02-01', '2026-03-01'), todayISO: '2026-04-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-03-01']);
  });
  it('skips already-closed periods', () => {
    const r = selectClosablePeriods({ ...base, closedPeriodStarts: new Set(['2026-01-01']), claims: claimed('2026-01-01', '2026-02-01'), todayISO: '2026-03-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-02-01']);
  });
  it('a retired line closes only periods claimed while it was live', () => {
    const r = selectClosablePeriods({ ...base, retiredAt: new Date('2026-02-15T10:00:00Z'), claims: claimed('2026-01-01', '2026-02-01', '2026-03-01'), todayISO: '2026-05-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-01-01', '2026-02-01']);
  });
  it('expiry on the claim day: the final period claimed and retired in one transaction still closes', () => {
    // generateDueInvoice claims 2026-03-01 and retires the line in the same transaction:
    // generated_at and hour_block_retired_at are both now() — equal, so the claim counts.
    const at = new Date('2026-03-01T06:00:00Z');
    const r = selectClosablePeriods({ ...base, retiredAt: at, claims: [{ periodStart: '2026-03-01', generatedAt: at }], todayISO: '2026-04-01' });
    expect(r.periods.map((p) => p.periodStart)).toEqual(['2026-03-01']);
  });
  it('arrears retire mid-period: the period claimed AFTER retirement (no fee billed) never closes', () => {
    const r = selectClosablePeriods({ ...base, retiredAt: new Date('2026-06-20T10:00:00Z'),
      claims: [{ periodStart: '2026-06-01', generatedAt: new Date('2026-07-01T06:00:00Z') }], contractStartDate: '2026-06-01', firstPeriodStart: '2026-06-01', todayISO: '2026-07-02' });
    expect(r.periods).toEqual([]);
  });
  it('stops at the cap and reports truncation', () => {
    const starts = Array.from({ length: 15 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}-01`).slice(0, 12)
      .concat(['2026-01-01', '2026-02-01', '2026-03-01']);
    const r = selectClosablePeriods({ ...base, contractStartDate: '2025-01-01', firstPeriodStart: '2025-01-01', claims: starts.map((periodStart) => ({ periodStart, generatedAt: new Date(`${periodStart}T06:00:00Z`) })), todayISO: '2026-06-01' });
    expect(r.periods).toHaveLength(HOUR_BLOCK_CLOSE_CAP);
    expect(r.truncated).toBe(true);
    expect(r.periods[0]!.periodStart).toBe('2025-01-01');
  });
  it('works for quarterly intervals and month-end starts', () => {
    const r = selectClosablePeriods({ ...base, contractStartDate: '2026-01-31', firstPeriodStart: '2026-01-31', intervalMonths: 3, claims: claimed('2026-01-31'), todayISO: '2026-05-01' });
    expect(r.periods).toEqual([{ index: 0, periodStart: '2026-01-31', periodEnd: '2026-04-30' }]);
  });
});
```

The quarterly expectation's `periodEnd` must equal `computePeriod('2026-01-31', 3, 0).periodEnd`; if `addMonthsClamped` (`contractMath.ts:21`) yields a different clamp, correct the literal to that function's output — the selector must not re-implement date math.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/contractHourBlocks.test.ts`
Expected: FAIL — `Failed to resolve import "./contractHourBlocks"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/contractHourBlocks.ts
/**
 * Block hours (#4547) — pure arithmetic. No DB, no I/O, no contract-line enum
 * import (same reason contractAllowance.ts gives). All hours are carried as
 * integer HUNDREDTHS internally so a period of 300 x 20-minute entries sums to
 * exactly 99.00, never 98.99999.
 */
import { computePeriod } from './contractMath';

export const HOUR_BLOCK_CLOSE_CAP = 12;
export type RolloverPolicy = 'none' | 'carry_forward';

export interface HourBlockLineSpec {
  includedQuantity: string;
  overageUnitPrice: string;
  rolloverPolicy: RolloverPolicy;
  rolloverCapHours: string | null;
}

const toH = (v: string | number): number => Math.round(Number(v) * 100);
const fromH = (h: number): number => h / 100;

/** Hundredths of an hour for one entry: round(minutes / 60, 2). 5m/3 never ties. */
function entryHundredths(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error('minutes must be >= 0');
  return Math.round((minutes * 100) / 60);
}

export function entryHours(minutes: number): number {
  return fromH(entryHundredths(minutes));
}

export function sumEntryHours(minutes: readonly number[]): number {
  let total = 0;
  for (const m of minutes) total += entryHundredths(m);
  return fromH(total);
}

export interface PeriodMath {
  includedHours: number; carriedInHours: number; openingHours: number;
  consumedHours: number; overageHours: number; carriedOutHours: number;
}

export function computePeriodMath(spec: HourBlockLineSpec, carriedInHours: number, consumedHours: number): PeriodMath {
  const included = toH(spec.includedQuantity);
  const carriedIn = toH(carriedInHours);
  const consumed = toH(consumedHours);
  const opening = included + carriedIn;
  const overage = Math.max(0, consumed - opening);
  const leftover = Math.max(0, opening - consumed);
  const carriedOut = spec.rolloverPolicy === 'none'
    ? 0
    : Math.min(leftover, spec.rolloverCapHours == null ? leftover : toH(spec.rolloverCapHours));
  return {
    includedHours: fromH(included), carriedInHours: fromH(carriedIn), openingHours: fromH(opening),
    consumedHours: fromH(consumed), overageHours: fromH(overage), carriedOutHours: fromH(carriedOut),
  };
}

export interface ClosablePeriod { index: number; periodStart: string; periodEnd: string }
/** One contract_billing_periods row: the period it claims and when it was claimed. */
export interface PeriodClaim { periodStart: string; generatedAt: Date }

/**
 * Earliest-first walk from the block's first period. A period is closable iff
 * ended, claimed, unclosed, and — for a retired line — CLAIMED WHILE THE LINE WAS
 * LIVE (generated_at <= hour_block_retired_at). The claim is what billed the block
 * fee, so entitlement follows the claim, never a date comparison: a period claimed
 * and retired in the same transaction (expiry on the claim day) still closes, and
 * an arrears period claimed after a mid-period retirement (no fee) never does.
 * Unclaimed periods are SKIPPED — never entitled (pause gaps, pre-activation).
 * Contiguity is guaranteed by walking in order and closing everything eligible:
 * a claimed+ended period is never left behind an older one that is still open.
 */
export function selectClosablePeriods(args: {
  contractStartDate: string; intervalMonths: number; firstPeriodStart: string;
  retiredAt: Date | null; claims: readonly PeriodClaim[]; closedPeriodStarts: ReadonlySet<string>;
  todayISO: string; cap?: number;
}): { periods: ClosablePeriod[]; truncated: boolean; blockedBy: string | null } {
  const cap = args.cap ?? HOUR_BLOCK_CLOSE_CAP;
  const entitled = new Set(args.claims
    .filter((c) => args.retiredAt === null || c.generatedAt.getTime() <= args.retiredAt.getTime())
    .map((c) => c.periodStart));
  const periods: ClosablePeriod[] = [];
  for (let idx = 0; ; idx++) {
    const p = computePeriod(args.contractStartDate, args.intervalMonths, idx);
    if (p.periodStart < args.firstPeriodStart) continue;
    if (p.periodEnd > args.todayISO) break;                 // not ended — nothing later has ended either
    if (!entitled.has(p.periodStart)) continue;
    if (args.closedPeriodStarts.has(p.periodStart)) continue;
    if (periods.length === cap) return { periods, truncated: true, blockedBy: null };
    periods.push({ index: idx, periodStart: p.periodStart, periodEnd: p.periodEnd });
  }
  return { periods, truncated: false, blockedBy: null };
}
```

`blockedBy` stays in the signature (index C7) and is always `null` here: with every eligible period closed in order there is no blocking case in a single call. Keep it — Task 3 sets it when a close of an earlier period fails and later ones must not proceed.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/contractHourBlocks.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractHourBlocks.ts apps/api/src/services/contractHourBlocks.test.ts
git commit -m "feat(billing): block hours period arithmetic and closable-period selector (#4547)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Block-drawn entries are immutable

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts:1008-1010` (update guard), `:1172-1178` (delete guard)
- Test: `apps/api/src/services/timeEntryService.test.ts` (unit, existing mock harness) and `apps/api/src/__tests__/integration/timeEntryBlockDrawn.integration.test.ts` (new)

**Interfaces:**
- Consumes: `time_entries.contract_line_id` (W01, Drizzle `timeEntries.contractLineId`).
- Produces: `TimeEntryServiceError` code `'ENTRY_DRAWN_BY_BLOCK'` (409). Add it to the error-code union in `timeEntryService.ts` (search `ENTRY_BILLED` for the union).

- [ ] **Step 1: Write the failing tests**

Unit (follow the existing `updateTimeEntry` tests in `timeEntryService.test.ts`: they stub `getEntryOr404`'s select — reuse that helper and add `contractLineId` to the fixture row):

```ts
describe('block-drawn entries (#4547)', () => {
  const drawn = { ...baseEntry, billingStatus: 'contract' as const, contractLineId: 'line-1' };
  const included = { ...baseEntry, billingStatus: 'contract' as const, contractLineId: null };

  it.each(['startedAt', 'endedAt', 'isBillable', 'hourlyRate', 'billingStatus', 'ticketId', 'workTypeId'] as const)(
    'refuses %s on a block-drawn entry', async (field) => {
      mockEntry(drawn);
      const value = field === 'billingStatus' ? 'not_billed' : field === 'isBillable' ? false
        : field.endsWith('At') ? new Date('2026-07-02T00:00:00Z') : field === 'hourlyRate' ? '1.00' : null;
      await expect(updateTimeEntry(drawn.id, { [field]: value } as never, manageBillingActor))
        .rejects.toMatchObject({ status: 409, code: 'ENTRY_DRAWN_BY_BLOCK' });
    });

  it('allows a description edit on a block-drawn entry', async () => {
    mockEntry(drawn);
    await expect(updateTimeEntry(drawn.id, { description: 'clarified' }, manageBillingActor)).resolves.toBeDefined();
  });

  it('still lets a manage_billing holder flip a card-included entry (amendment 1)', async () => {
    mockEntry(included);
    await expect(updateTimeEntry(included.id, { billingStatus: 'not_billed' }, manageBillingActor)).resolves.toBeDefined();
  });

  it('refuses to delete a block-drawn entry', async () => {
    mockEntry(drawn);
    await expect(deleteTimeEntry(drawn.id, manageBillingActor)).rejects.toMatchObject({ status: 409, code: 'ENTRY_DRAWN_BY_BLOCK' });
  });
});
```

Integration (real DB; the unit mocks cannot prove the description-only path leaves the stamp alone):

```ts
// apps/api/src/__tests__/integration/timeEntryBlockDrawn.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { timeEntries } from '../../db/schema';
import { updateTimeEntry } from '../../services/timeEntryService';
import { seedBlockFixture, seedEntry, systemActor } from './hourBlockFixtures';

describe('block-drawn entry edits (real DB) #4547', () => {
  it('description edit keeps coverage, rate and billable minutes', async () => {
    const f = await seedBlockFixture();
    const id = await seedEntry(f, { minutes: 90, endedAt: '2026-07-10T12:00:00Z', hourlyRate: '120.00' });
    await withSystemDbAccessContext(() => db.update(timeEntries)
      .set({ billingStatus: 'contract', contractLineId: f.blockLineId }).where(eq(timeEntries.id, id)));
    const before = await readEntry(id);
    await withSystemDbAccessContext(() => updateTimeEntry(id, { description: 'clarified' }, systemActor(f)));
    const after = await readEntry(id);
    expect(after).toMatchObject({
      description: 'clarified', billingStatus: 'contract', contractLineId: f.blockLineId,
      coverage: before.coverage, hourlyRate: before.hourlyRate, billableMinutes: before.billableMinutes,
    });
  });
});

async function readEntry(id: string) {
  const [r] = await withSystemDbAccessContext(() => db.select().from(timeEntries).where(eq(timeEntries.id, id)));
  return r!;
}
```

Create the shared fixture module now — Tasks 3–8 reuse it:

```ts
// apps/api/src/__tests__/integration/hourBlockFixtures.ts
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  contractBillingPeriods, contractLines, contracts, organizations, partners, users, timeEntries,
} from '../../db/schema';
import type { ContractActorT } from '../../services/contractService';

export interface BlockFixture {
  partnerId: string; orgId: string; userId: string; contractId: string; blockLineId: string;
  currency: string; actor: ContractActorT;
}

/** One org, one active monthly contract starting 2026-07-01, one live block line
 *  (10 h, 150.00/h overage, no rollover) whose first period is the contract's first. */
export async function seedBlockFixture(o: {
  timing?: 'advance' | 'arrears'; rollover?: 'none' | 'carry_forward'; cap?: string | null;
  included?: string; firstPeriodStart?: string; startDate?: string; nextBillingAt?: string;
  currency?: string; status?: 'active' | 'paused' | 'cancelled' | 'expired'; endDate?: string | null;
} = {}): Promise<BlockFixture> {
  const currency = o.currency ?? 'USD';
  const startDate = o.startDate ?? '2026-07-01';
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `HB ${sfx}`, slug: `hb-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [org] = await db.insert(organizations).values({ currencyCode: currency, partnerId: p!.id, name: 'HBOrg', slug: `hb-${sfx}`, taxRate: '0.10000' }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({ partnerId: p!.id, orgId: org!.id, email: `hb-${sfx}@x.io`, name: 'Tech', status: 'active' }).returning({ id: users.id });
    const timing = o.timing ?? 'arrears';
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: org!.id, name: 'Support block', status: o.status ?? 'active', intervalMonths: 1,
      startDate, endDate: o.endDate ?? null, currencyCode: currency, billingTiming: timing,
      nextBillingAt: o.nextBillingAt ?? (timing === 'advance' ? startDate : '2026-08-01'), createdBy: u!.id,
    }).returning({ id: contracts.id });
    const [l] = await db.insert(contractLines).values({
      contractId: c!.id, orgId: org!.id, lineType: 'hour_block', description: 'Support hours',
      unitPrice: '1000.00', taxable: true,
      includedQuantity: o.included ?? '10.00', overageMode: 'bill', overageUnitPrice: '150.00',
      rolloverPolicy: o.rollover ?? 'none', rolloverCapHours: o.cap ?? null,
      hourBlockFirstPeriodStart: o.firstPeriodStart ?? startDate,
    }).returning({ id: contractLines.id });
    return {
      partnerId: p!.id, orgId: org!.id, userId: u!.id, contractId: c!.id, blockLineId: l!.id, currency,
      actor: { userId: u!.id, partnerId: p!.id, accessibleOrgIds: [org!.id] } as unknown as ContractActorT,
    };
  });
}

export async function seedEntry(f: BlockFixture, e: {
  minutes: number; endedAt: string; billableMinutes?: number | null; isBillable?: boolean;
  billingStatus?: 'not_billed' | 'no_charge' | 'billed' | 'contract'; isApproved?: boolean;
  hourlyRate?: string | null; currencyCode?: string;
}): Promise<string> {
  const ended = new Date(e.endedAt);
  const [row] = await withSystemDbAccessContext(() => db.insert(timeEntries).values({
    partnerId: f.partnerId, orgId: f.orgId, userId: f.userId,
    startedAt: new Date(ended.getTime() - e.minutes * 60_000), endedAt: ended,
    durationMinutes: e.minutes, billableMinutes: e.billableMinutes ?? null,
    description: 'Work', isBillable: e.isBillable ?? true, hourlyRate: e.hourlyRate === undefined ? '120.00' : e.hourlyRate,
    billingStatus: e.billingStatus ?? 'not_billed', isApproved: e.isApproved ?? true,
    currencyCode: e.currencyCode ?? f.currency,
  }).returning({ id: timeEntries.id }));
  return row!.id;
}

export async function claimPeriod(f: BlockFixture, periodStart: string, periodEnd: string, invoiceId: string | null = null) {
  await withSystemDbAccessContext(() => db.insert(contractBillingPeriods)
    .values({ contractId: f.contractId, orgId: f.orgId, periodStart, periodEnd, invoiceId }));
}

export function systemActor(f: BlockFixture) {
  // Shape of TimeEntryActor: copy the fields from the existing integration tests
  // that call updateTimeEntry (grep `updateTimeEntry(` under __tests__/integration).
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId], manageAll: true, manageBilling: true } as never;
}

export async function entryState(id: string) {
  const [r] = await withSystemDbAccessContext(() => db.select({
    billingStatus: timeEntries.billingStatus, contractLineId: timeEntries.contractLineId,
  }).from(timeEntries).where(eq(timeEntries.id, id)));
  return r!;
}
```

`billableMinutes` must satisfy `time_entries_billable_minutes_chk` (`2026-10-24-210000-…sql`): with no minimum/rounding stamped, pass `null` or a value equal to `minutes`. Tests that need billable ≠ duration set `minimumMinutes` on the row too (e.g. `minimumMinutes: 30, billableMinutes: 30` for a 20-minute entry).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/timeEntryService.test.ts -t "block-drawn"`
Expected: FAIL — the update resolves (no 409) for every locked field.

- [ ] **Step 3: Implement**

In `timeEntryService.ts`, beside `BILLED_LOCKED_ENTRY_FIELDS` (`:563`):

```ts
/** A block close (#4547) stamped this entry: it was consumed by a prepaid hour
 *  bank and is as frozen as an invoiced one. A card-INCLUDED entry is also
 *  'contract' but carries no line — it stays editable (billing-profiles #4628 §5). */
function isBlockDrawn(entry: { billingStatus: string; contractLineId: string | null }): boolean {
  return entry.billingStatus === 'contract' && entry.contractLineId !== null;
}
```

In `updateTimeEntry`, directly after the existing `billed` guard (`:1008-1010`):

```ts
  if (isBlockDrawn(entry) && BILLED_LOCKED_ENTRY_FIELDS.some((k) => (input as Record<string, unknown>)[k] !== undefined)) {
    throw new TimeEntryServiceError(
      'This entry was drawn from a block of prepaid hours; only its description can change',
      409, 'ENTRY_DRAWN_BY_BLOCK');
  }
```

In `deleteTimeEntry`, after the `billed` refusal (`:1172-1178`):

```ts
  if (isBlockDrawn(entry)) {
    throw new TimeEntryServiceError(
      'This entry was drawn from a block of prepaid hours and cannot be deleted', 409, 'ENTRY_DRAWN_BY_BLOCK');
  }
```

Then read the rest of `updateTimeEntry` (`:1012-1160`). If a description-only patch reaches a billing re-stamp (`billingStampFromEntry` / the function at `:376`), guard it so it runs only when one of `BILLED_LOCKED_ENTRY_FIELDS` is present — the integration test is the judge. Also grep for other `time_entries` mutators that change `billing_status` (`grep -n "billingStatus" apps/api/src/services/timeEntryService.ts` — bulk approve/reject, `:1321`) and apply `isBlockDrawn` to any that can touch a drawn row; list them in the commit message.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/timeEntryService.test.ts`
Expected: PASS. Then with `pnpm test-stack up`:
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/timeEntryBlockDrawn.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/services/timeEntryService.test.ts \
  apps/api/src/__tests__/integration/timeEntryBlockDrawn.integration.test.ts apps/api/src/__tests__/integration/hourBlockFixtures.ts
git commit -m "feat(billing): entries drawn by a block of hours are read-only (#4547)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Close one block line's periods (claim, ledger, overage)

**Files:**
- Create: `apps/api/src/services/contractHourBlockClose.ts`
- Modify: `apps/api/src/services/contractTypes.ts:49` (`'HOUR_BLOCK_CLOSE_MISMATCH'` in `ContractServiceErrorCode`)
- Test: `apps/api/src/__tests__/integration/contractHourBlockClose.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 (`selectClosablePeriods`, `computePeriodMath`, `sumEntryHours`); `addContractLine(invoiceId, {...}, actor)` (`invoiceService.ts:424-446`); `createManualInvoice({ orgId, notes?, currencyCode }, actor)` (`invoiceService.ts:172`); `assertInTransaction` (same import `contractService.ts` uses); Drizzle `contractHourPeriods`, `contractBillingPeriods`, `timeEntries`.
- Produces: `HourBlockCloseSummary`, `closeHourBlockPeriods(args)` exactly as index C7.

- [ ] **Step 1: Write the failing integration tests**

```ts
// apps/api/src/__tests__/integration/contractHourBlockClose.integration.test.ts
import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods, contractLines, contracts, invoiceLines } from '../../db/schema';
import { closeHourBlockPeriods } from '../../services/contractHourBlockClose';
import { createManualInvoice } from '../../services/invoiceService';
import { claimPeriod, entryState, seedBlockFixture, seedEntry, type BlockFixture } from './hourBlockFixtures';

const AS_OF = new Date('2026-08-01T06:00:00Z');

async function loadRows(f: BlockFixture) {
  return withSystemDbAccessContext(async () => {
    const [c] = await db.select().from(contracts).where(eq(contracts.id, f.contractId));
    const [l] = await db.select().from(contractLines).where(eq(contractLines.id, f.blockLineId));
    return { contract: c!, line: l! };
  });
}

async function close(f: BlockFixture, asOf = AS_OF) {
  return withSystemDbAccessContext(async () => {
    const { contract, line } = await loadRows(f);
    const actor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const inv = await createManualInvoice({ orgId: f.orgId, currencyCode: f.currency }, actor);
    const r = await closeHourBlockPeriods({ contract, line, overageInvoice: { id: inv.id, actor }, closeSource: 'billing_run', asOf });
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    return { ...r, invoiceId: inv.id, lines };
  });
}

async function ledger(f: BlockFixture) {
  return withSystemDbAccessContext(() => db.select().from(contractHourPeriods)
    .where(eq(contractHourPeriods.contractLineId, f.blockLineId)).orderBy(contractHourPeriods.periodStart));
}

describe('closeHourBlockPeriods (real DB) #4547', () => {
  it('under the block: ledger row, entries marked, no overage line', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    const a = await seedEntry(f, { minutes: 240, endedAt: '2026-07-10T12:00:00Z' });
    const b = await seedEntry(f, { minutes: 150, endedAt: '2026-07-31T23:59:00Z' });
    const r = await close(f);
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]).toMatchObject({ periodStart: '2026-07-01', periodEnd: '2026-08-01', consumedHours: 6.5, overageHours: 0, entryCount: 2, overageInvoiceLineId: null });
    expect(r.lines).toHaveLength(0);
    expect(await entryState(a)).toEqual({ billingStatus: 'contract', contractLineId: f.blockLineId });
    expect(await entryState(b)).toEqual({ billingStatus: 'contract', contractLineId: f.blockLineId });
    expect(await ledger(f)).toHaveLength(1);
  });

  it('over the block: one aggregate overage line at the contracted rate', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 600, endedAt: '2026-07-10T12:00:00Z' });
    await seedEntry(f, { minutes: 140, endedAt: '2026-07-11T12:00:00Z' });   // 2.33 h
    const r = await close(f);
    expect(r.closes[0]).toMatchObject({ consumedHours: 12.33, overageHours: 2.33 });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      description: 'Support hours — hours over block, 2026-07-01 – 2026-08-01',
      quantity: '2.33', unitPrice: '150.00', lineTotal: '349.50',
      sourceType: 'contract', sourceId: f.blockLineId, sourceContractId: f.contractId,
      parentLineId: null, catalogItemId: null, taxable: true,
    });
    const [row] = await ledger(f);
    expect(row).toMatchObject({ overageHours: '2.33', overageUnitPrice: '150.00', currencyCode: 'USD', closeSource: 'billing_run' });
    expect(row!.overageInvoiceId).toBe(r.invoiceId);
  });

  it('boundary: an entry ending exactly at periodEnd belongs to the next period', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    const inside = await seedEntry(f, { minutes: 60, endedAt: '2026-07-01T00:00:00Z' });
    const next = await seedEntry(f, { minutes: 60, endedAt: '2026-08-01T00:00:00Z' });
    await close(f);
    expect((await entryState(inside)).billingStatus).toBe('contract');
    expect((await entryState(next)).billingStatus).toBe('not_billed');
  });

  it('reads COALESCE(billable_minutes, duration_minutes)', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 20, billableMinutes: 30, endedAt: '2026-07-10T12:00:00Z' }); // seedEntry sets minimumMinutes 30
    const r = await close(f);
    expect(r.closes[0]!.consumedHours).toBe(0.5);
  });

  it('ignores no_charge, non-billable, already-billed and card-included entries', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    const nc = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', billingStatus: 'no_charge' });
    const nb = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', isBillable: false });
    const inc = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', billingStatus: 'contract', hourlyRate: null });
    const r = await close(f);
    expect(r.closes[0]).toMatchObject({ consumedHours: 0, entryCount: 0 });
    expect(await entryState(nc)).toEqual({ billingStatus: 'no_charge', contractLineId: null });
    expect(await entryState(nb)).toEqual({ billingStatus: 'not_billed', contractLineId: null });
    expect(await entryState(inc)).toEqual({ billingStatus: 'contract', contractLineId: null });
  });

  it('draws unapproved, NULL-rate and foreign-currency entries; flags the foreign hours', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', isApproved: false });
    await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', hourlyRate: null });
    await seedEntry(f, { minutes: 90, endedAt: '2026-07-10T12:00:00Z', currencyCode: 'EUR' });
    const r = await close(f);
    expect(r.closes[0]).toMatchObject({ consumedHours: 3.5, foreignCurrencyHours: 1.5, entryCount: 3 });
  });

  it('carries forward across three periods, earliest first, in one call', async () => {
    const f = await seedBlockFixture({ rollover: 'carry_forward', cap: '4.00' });
    for (const [s, e] of [['2026-07-01', '2026-08-01'], ['2026-08-01', '2026-09-01'], ['2026-09-01', '2026-10-01']] as const) await claimPeriod(f, s, e);
    await seedEntry(f, { minutes: 240, endedAt: '2026-07-10T12:00:00Z' });  // 4 h used -> 6 left, capped 4
    await seedEntry(f, { minutes: 780, endedAt: '2026-08-10T12:00:00Z' });  // 13 h of 14 -> 1 left
    await seedEntry(f, { minutes: 720, endedAt: '2026-09-10T12:00:00Z' });  // 12 h of 11 -> 1 over
    const r = await close(f, new Date('2026-10-01T06:00:00Z'));
    expect(r.closes.map((c) => [c.periodStart, c.carriedInHours, c.consumedHours, c.overageHours, c.carriedOutHours])).toEqual([
      ['2026-07-01', 0, 4, 0, 4], ['2026-08-01', 4, 13, 0, 1], ['2026-09-01', 1, 12, 1, 0],
    ]);
  });

  it('is idempotent: a second call closes nothing and adds no line', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 700, endedAt: '2026-07-10T12:00:00Z' });
    await close(f);
    const again = await close(f);
    expect(again.closes).toEqual([]);
    expect(again.lines).toEqual([]);
    expect(await ledger(f)).toHaveLength(1);
  });

  it('never closes an unclaimed period and never one before the first block period', async () => {
    const f = await seedBlockFixture({ firstPeriodStart: '2026-08-01' });
    await claimPeriod(f, '2026-07-01', '2026-08-01');            // claimed, but before the block
    const early = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    const unclaimed = await seedEntry(f, { minutes: 60, endedAt: '2026-08-10T12:00:00Z' });
    const r = await close(f, new Date('2026-09-02T06:00:00Z'));
    expect(r.closes).toEqual([]);
    expect((await entryState(early)).billingStatus).toBe('not_billed');
    expect((await entryState(unclaimed)).billingStatus).toBe('not_billed');
  });

  it('the overage rate and currency are snapshot at close', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 660, endedAt: '2026-07-10T12:00:00Z' });
    await close(f);
    await withSystemDbAccessContext(() => db.update(contractLines).set({ overageUnitPrice: '999.00' }).where(eq(contractLines.id, f.blockLineId)));
    const [row] = await ledger(f);
    expect(row!.overageUnitPrice).toBe('150.00');
  });
});
```

`seedEntry` with `billableMinutes` must also stamp `minimumMinutes` so the CHECK holds — extend the fixture's insert: `minimumMinutes: e.billableMinutes != null && e.billableMinutes !== e.minutes ? e.billableMinutes : null`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractHourBlockClose.integration.test.ts`
Expected: FAIL — `Failed to resolve import "../../services/contractHourBlockClose"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/contractHourBlockClose.ts
/**
 * Block hours (#4547) — the period close. Runs INSIDE the caller's system
 * transaction (generateDueInvoice or the close-out sweep), which already holds
 * the contract row lock. time_entries is partner-axis RLS: an org-scoped
 * context would see zero rows here, which is why every caller is system.
 *
 * The close CLAIMS rows, it does not count them (spec §2 "Claiming the
 * entries"): SELECT … ORDER BY id FOR UPDATE, compute from exactly the locked
 * set, flip exactly that set. ORDER BY id is issueInvoice's order, so the two
 * paths serialize instead of deadlocking.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { assertInTransaction } from '../db';   // same import contractService.ts uses — adjust the path if it differs
import { contractBillingPeriods, contractHourPeriods, contractLines, contracts, timeEntries } from '../db/schema';
import { addContractLine, type InvoiceActor } from './invoiceService';
import { ContractServiceError } from './contractTypes';
import { computePeriodMath, selectClosablePeriods, sumEntryHours, type ClosablePeriod, type RolloverPolicy } from './contractHourBlocks';

export interface HourBlockCloseSummary {
  contractLineId: string; description: string;
  periodStart: string; periodEnd: string;
  includedHours: number; carriedInHours: number; consumedHours: number;
  overageHours: number; carriedOutHours: number; foreignCurrencyHours: number;
  entryCount: number;
  overageInvoiceLineId: string | null;
  closeSource: 'billing_run' | 'close_out';
}

type ContractRow = typeof contracts.$inferSelect;
type LineRow = typeof contractLines.$inferSelect;
type OverageInvoice = { id: string; actor: InvoiceActor };

const dayStart = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const todayUTC = (d: Date): string => d.toISOString().slice(0, 10);

export async function closeHourBlockPeriods(args: {
  contract: ContractRow; line: LineRow;
  overageInvoice: OverageInvoice | (() => Promise<OverageInvoice>);
  closeSource: 'billing_run' | 'close_out'; asOf: Date;
}): Promise<{ closes: HourBlockCloseSummary[]; truncated: boolean }> {
  assertInTransaction('closeHourBlockPeriods');
  const { contract, line } = args;
  if (line.lineType !== 'hour_block' || line.hourBlockFirstPeriodStart == null) {
    throw new ContractServiceError(`Contract line ${line.id} is not a block of hours`, 500, 'INVALID_STATE');
  }

  const claims = await db.select({ periodStart: contractBillingPeriods.periodStart, generatedAt: contractBillingPeriods.generatedAt })
    .from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, contract.id));
  const closed = await db.select({ s: contractHourPeriods.periodStart }).from(contractHourPeriods)
    .where(eq(contractHourPeriods.contractLineId, line.id));
  const { periods, truncated } = selectClosablePeriods({
    contractStartDate: contract.startDate, intervalMonths: contract.intervalMonths,
    firstPeriodStart: line.hourBlockFirstPeriodStart,
    retiredAt: line.hourBlockRetiredAt ?? null,
    claims,
    closedPeriodStarts: new Set(closed.map((r) => r.s)),
    todayISO: todayUTC(args.asOf),
  });
  if (truncated) {
    console.warn('[contractHourBlocks] close backlog hit the cap', { contractId: contract.id, lineId: line.id, closing: periods.length });
  }

  let invoice: OverageInvoice | null = typeof args.overageInvoice === 'function' ? null : args.overageInvoice;
  const out: HourBlockCloseSummary[] = [];
  for (const p of periods) {
    out.push(await closeOne(contract, line, p, args.closeSource, async () => {
      if (!invoice) invoice = await (args.overageInvoice as () => Promise<OverageInvoice>)();
      return invoice;
    }));
  }
  return { closes: out, truncated };
}

async function carriedInFor(lineId: string, periodStart: string): Promise<number> {
  const [prev] = await db.select({ out: contractHourPeriods.carriedOutHours }).from(contractHourPeriods)
    .where(and(eq(contractHourPeriods.contractLineId, lineId), lt(contractHourPeriods.periodStart, periodStart)))
    .orderBy(desc(contractHourPeriods.periodStart)).limit(1);
  return prev ? Number(prev.out) : 0;
}

async function closeOne(
  contract: ContractRow, line: LineRow, p: ClosablePeriod,
  closeSource: 'billing_run' | 'close_out', getInvoice: () => Promise<OverageInvoice>,
): Promise<HourBlockCloseSummary> {
  // 1. Claim: lock exactly the eligible rows, issueInvoice's order.
  const locked = await db.select({
    id: timeEntries.id,
    minutes: sql<number>`COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes}, 0)`.mapWith(Number),
    currencyCode: timeEntries.currencyCode,
  }).from(timeEntries).where(and(
    eq(timeEntries.orgId, contract.orgId),
    eq(timeEntries.isBillable, true),
    eq(timeEntries.billingStatus, 'not_billed'),
    isNotNull(timeEntries.endedAt),
    gte(timeEntries.endedAt, dayStart(p.periodStart)),
    lt(timeEntries.endedAt, dayStart(p.periodEnd)),
  )).orderBy(asc(timeEntries.id)).for('update');

  // 2. Compute from exactly the locked set.
  const consumed = sumEntryHours(locked.map((r) => r.minutes));
  const foreign = sumEntryHours(locked.filter((r) => r.currencyCode !== contract.currencyCode).map((r) => r.minutes));
  const carriedIn = await carriedInFor(line.id, p.periodStart);
  const math = computePeriodMath({
    includedQuantity: line.includedQuantity!, overageUnitPrice: line.overageUnitPrice!,
    rolloverPolicy: line.rolloverPolicy as RolloverPolicy, rolloverCapHours: line.rolloverCapHours ?? null,
  }, carriedIn, consumed);

  // 3. Mark exactly that set; any drift aborts the whole billing transaction.
  const ids = locked.map((r) => r.id);
  if (ids.length > 0) {
    const flipped = await db.update(timeEntries)
      .set({ billingStatus: 'contract', contractLineId: line.id, updatedAt: new Date() })
      .where(and(inArray(timeEntries.id, ids), eq(timeEntries.billingStatus, 'not_billed')))
      .returning({ id: timeEntries.id });
    if (flipped.length !== ids.length) {
      throw new ContractServiceError(
        `Block close for line ${line.id} locked ${ids.length} entries but marked ${flipped.length}`,
        500, 'HOUR_BLOCK_CLOSE_MISMATCH');
    }
  }

  // 4. Overage line (bill mode is the only mode — CHECK contract_lines_hour_block_chk).
  let overageInvoiceLineId: string | null = null;
  let overageInvoiceId: string | null = null;
  if (math.overageHours > 0) {
    const inv = await getInvoice();
    // Lock order note: the invoice is either this run's own uncommitted draft
    // (billing path) or one this sweep just created — nothing else can hold it,
    // so addContractLine's invoice→contract order cannot cycle with the
    // contract lock we already hold. This is an exception, not the repo rule.
    const { line: il } = await addContractLine(inv.id, {
      description: `${line.description} — hours over block, ${p.periodStart} – ${p.periodEnd}`,
      quantity: math.overageHours.toFixed(2),
      unitPrice: line.overageUnitPrice!,
      taxable: line.taxable,
      catalogItemId: null,
      sourceId: line.id,
      contractId: contract.id,
    }, inv.actor);
    overageInvoiceLineId = il.id;
    overageInvoiceId = inv.id;
  }

  // 5. Ledger row. The unique key makes a lost race a no-op; a no-op AFTER we
  //    marked rows means another closer won between our select and insert —
  //    impossible under the contract row lock, so treat it as corruption.
  const inserted = await db.insert(contractHourPeriods).values({
    contractLineId: line.id, contractId: contract.id, orgId: contract.orgId,
    periodStart: p.periodStart, periodEnd: p.periodEnd,
    includedHours: math.includedHours.toFixed(2), carriedInHours: math.carriedInHours.toFixed(2),
    consumedHours: math.consumedHours.toFixed(2), overageHours: math.overageHours.toFixed(2),
    carriedOutHours: math.carriedOutHours.toFixed(2), foreignCurrencyHours: foreign.toFixed(2),
    entryCount: ids.length, overageUnitPrice: line.overageUnitPrice!, currencyCode: contract.currencyCode,
    overageInvoiceId, closeSource,
  }).onConflictDoNothing({ target: [contractHourPeriods.contractLineId, contractHourPeriods.periodStart] })
    .returning({ id: contractHourPeriods.id });
  if (inserted.length === 0) {
    throw new ContractServiceError(`Block period ${p.periodStart} for line ${line.id} closed concurrently`, 500, 'HOUR_BLOCK_CLOSE_MISMATCH');
  }

  return {
    contractLineId: line.id, description: line.description,
    periodStart: p.periodStart, periodEnd: p.periodEnd,
    includedHours: math.includedHours, carriedInHours: math.carriedInHours, consumedHours: math.consumedHours,
    overageHours: math.overageHours, carriedOutHours: math.carriedOutHours, foreignCurrencyHours: foreign,
    entryCount: ids.length, overageInvoiceLineId, closeSource,
  };
}
```

Add `'HOUR_BLOCK_CLOSE_MISMATCH'` to `ContractServiceErrorCode` (`contractTypes.ts:49`). Confirm where `assertInTransaction` is exported (`grep -rn "export function assertInTransaction" apps/api/src`) and fix the import. Confirm `addContractLine`'s returned `line.lineTotal` for `2.33 × 150.00` is `'349.50'` (it uses `multiplyToCurrency`); if `addContractLine` rejects `catalogItemId: null` explicitly, omit the key.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractHourBlockClose.integration.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractHourBlockClose.ts apps/api/src/services/contractTypes.ts \
  apps/api/src/__tests__/integration/contractHourBlockClose.integration.test.ts apps/api/src/__tests__/integration/hourBlockFixtures.ts
git commit -m "feat(billing): close block-hour periods under row locks with a frozen ledger row (#4547)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the close into `generateDueInvoice`; retire on expire/cancel

**Files:**
- Modify: `apps/api/src/services/contractService.ts` — `GenerateResult` (`:1940-1964`), `generateDueInvoice` (`:1998-2212`), `cancelContract` (`:1870-1885`)
- Modify: `apps/api/src/jobs/contractWorker.ts:79-98` (log closes + truncation)
- Test: `apps/api/src/__tests__/integration/contractHourBlockBilling.integration.test.ts` (new); `apps/api/src/services/contractService.test.ts` (unit: every early return carries `hourBlockCloses: []`)

**Interfaces:**
- Consumes: Task 3 `closeHourBlockPeriods`; W01's fail-closed `case 'hour_block'` arm (replaced here).
- Produces: `GenerateResult.hourBlockCloses: HourBlockCloseSummary[]`, `GenerateResult.hourBlockCloseTruncated: boolean`; retirement stamping on expiry/cancel.

- [ ] **Step 1: Write the failing integration tests**

```ts
// apps/api/src/__tests__/integration/contractHourBlockBilling.integration.test.ts
import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods, contractLines, contracts, invoiceLines } from '../../db/schema';
import { cancelContract, generateDueInvoice, pauseContract, resumeContract } from '../../services/contractService';
import { entryState, seedBlockFixture, seedEntry } from './hourBlockFixtures';

const run = (contractId: string, at: string) =>
  withSystemDbAccessContext(() => generateDueInvoice(contractId, new Date(`${at}T06:00:00Z`)));
const linesOf = (invoiceId: string) => withSystemDbAccessContext(() =>
  db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));

describe('generateDueInvoice with a block of hours (real DB) #4547', () => {
  it('arrears: fee and that period\'s overage on one invoice', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await seedEntry(f, { minutes: 720, endedAt: '2026-07-15T12:00:00Z' });           // 12 h, 2 over
    const r = await run(f.contractId, '2026-08-01');
    expect(r.generated).toBe(true);
    expect(r.hourBlockCloses).toHaveLength(1);
    expect(r.hourBlockCloses[0]).toMatchObject({ periodStart: '2026-07-01', overageHours: 2 });
    const lines = await linesOf(r.invoiceId!);
    expect(lines.map((l) => [l.description, l.quantity, l.unitPrice])).toEqual([
      ['Support hours', '1.00', '1000.00'],
      ['Support hours — hours over block, 2026-07-01 – 2026-08-01', '2.00', '150.00'],
    ]);
    expect(r.overages).toEqual([]);   // device-unit overages never carry hours (index delta 7)
  });

  it('advance: P0 overage lands on the P1 invoice with P0\'s dates', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01' });
    const r0 = await run(f.contractId, '2026-07-01');
    expect(r0.hourBlockCloses).toEqual([]);
    expect(await linesOf(r0.invoiceId!)).toHaveLength(1);
    await seedEntry(f, { minutes: 660, endedAt: '2026-07-20T12:00:00Z' });           // 11 h, 1 over
    const r1 = await run(f.contractId, '2026-08-01');
    const lines = await linesOf(r1.invoiceId!);
    expect(lines.map((l) => l.description)).toEqual([
      'Support hours', 'Support hours — hours over block, 2026-07-01 – 2026-08-01',
    ]);
  });

  it('pause gap grants no hours', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await run(f.contractId, '2026-08-01');                                        // claims + closes July
    await withSystemDbAccessContext(() => pauseContract(f.contractId, f.actor));
    const pausedWork = await seedEntry(f, { minutes: 60, endedAt: '2026-08-15T12:00:00Z' });
    await withSystemDbAccessContext(() => resumeContract(f.contractId, f.actor, '2026-10-05'));
    await run(f.contractId, '2026-11-01');
    const rows = await withSystemDbAccessContext(() => db.select({ s: contractHourPeriods.periodStart })
      .from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)).orderBy(contractHourPeriods.periodStart));
    expect(rows.map((r) => r.s)).toEqual(['2026-07-01', '2026-10-01']);        // August/September never closed
    expect((await entryState(pausedWork)).billingStatus).toBe('not_billed');   // bills ad hoc
  });

  it('a block added mid-period on an active advance contract does not absorb that period', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-08-01', firstPeriodStart: '2026-08-01' });
    // July was claimed before the block existed.
    await withSystemDbAccessContext(() => db.execute(
      `INSERT INTO contract_billing_periods (contract_id, org_id, period_start, period_end) VALUES ('${f.contractId}', '${f.orgId}', '2026-07-01', '2026-08-01')` as never));
    const julyWork = await seedEntry(f, { minutes: 60, endedAt: '2026-07-20T12:00:00Z' });
    await run(f.contractId, '2026-08-01');
    expect((await entryState(julyWork)).billingStatus).toBe('not_billed');
  });

  it('a retired line bills no fee', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await withSystemDbAccessContext(() => db.insert(contractLines).values({
      contractId: f.contractId, orgId: f.orgId, lineType: 'flat', description: 'Managed services', unitPrice: '500.00', taxable: true,
    }));
    await withSystemDbAccessContext(() => db.update(contractLines).set({ hourBlockRetiredAt: new Date('2026-06-30T00:00:00Z') })
      .where(eq(contractLines.id, f.blockLineId)));
    const r = await run(f.contractId, '2026-08-01');
    expect((await linesOf(r.invoiceId!)).map((l) => l.description)).toEqual(['Managed services']);
  });

  it('a contract whose only line is a retired block generates nothing', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await withSystemDbAccessContext(() => db.update(contractLines).set({ hourBlockRetiredAt: new Date('2026-06-30T00:00:00Z') })
      .where(eq(contractLines.id, f.blockLineId)));
    const r = await run(f.contractId, '2026-08-01');
    expect(r).toMatchObject({ generated: false, skipped: 'not_due', hourBlockCloses: [] });
  });

  it('expiry and cancellation retire the live block line', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', endDate: '2026-08-01' });
    await run(f.contractId, '2026-08-01');                                        // bills July, then expires
    const [l] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, f.blockLineId)));
    expect(l!.hourBlockRetiredAt).not.toBeNull();

    const g = await seedBlockFixture({ timing: 'arrears' });
    await withSystemDbAccessContext(() => cancelContract(g.contractId, g.actor));
    const [m] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, g.blockLineId)));
    expect(m!.hourBlockRetiredAt).not.toBeNull();
  });

  it('a re-run is already_billed and closes nothing twice', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await seedEntry(f, { minutes: 700, endedAt: '2026-07-15T12:00:00Z' });
    await run(f.contractId, '2026-08-01');
    await withSystemDbAccessContext(() => db.update(contracts).set({ nextBillingAt: '2026-08-01' }).where(eq(contracts.id, f.contractId)));
    const again = await run(f.contractId, '2026-08-01');
    expect(again).toMatchObject({ generated: false, skipped: 'already_billed', hourBlockCloses: [] });
  });
});
```

Replace the raw `db.execute(... as never)` in the mid-period test with `claimPeriod(f, '2026-07-01', '2026-08-01')` from the fixtures — shown inline only to make the intent explicit. If `cancelContract`'s actor parameter needs real permissions (`ContractActor` is fail-closed — `contractTypes.ts:6-39`), build it the way `contractService.integration.test.ts` does.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractHourBlockBilling.integration.test.ts`
Expected: FAIL — `HOUR_BLOCK_NOT_ENABLED` thrown from the W01 arm.

- [ ] **Step 3: Implement**

`GenerateResult` (`:1940`): add, with doc comments,

```ts
  /** Block-hour periods closed on this run (#4547). Always present (`[]`). Never
   *  folded into `overages`, whose counts are whole devices/seats. */
  hourBlockCloses: HourBlockCloseSummary[];
  /** True when a block line's close backlog hit HOUR_BLOCK_CLOSE_CAP this run. */
  hourBlockCloseTruncated: boolean;
```

and add `hourBlockCloses: [], hourBlockCloseTruncated: false` to all six early returns (`:2018`, `:2019`, `:2033`, `:2048`, `:2152` region `already_billed`, and the expired-at-due-check return). Use a local `const EMPTY_HB = { hourBlockCloses: [], hourBlockCloseTruncated: false } as const;` spread into each.

In `generateDueInvoice`:

1. After loading `lines` (`:2043-2045`), split: `const billable = lines.filter((l) => !(l.lineType === 'hour_block' && l.hourBlockRetiredAt !== null));` and change the empty guard to `if (billable.length === 0)`. Iterate `billable` in the materialize loop. Keep `lines` for the close step (retired lines' pre-retirement periods are the sweep's job — Task 7 — so the close step below uses only live block lines).
2. Replace the W01 arm in the switch:

```ts
      case 'hour_block':
        // The block FEE bills like flat (qty 1, unit_price = the whole block).
        // Hours are settled by closeHourBlockPeriods after the claim below; the
        // allowance columns are deliberately NOT passed to applyAllowance here,
        // or the materializer would treat included hours as a device allowance.
        quantity = '1';
        break;
```

   and directly below the switch change the `applyAllowance` call to
   `const r = l.lineType === 'hour_block' ? applyAllowance(1, NO_ALLOWANCE, 'single_block') : applyAllowance(Number(quantity), l, 'included_units');`
   with `const NO_ALLOWANCE = { includedQuantity: null, overageMode: null, overageUnitPrice: null } as const;` at module scope.
3. After the claim succeeds and `periodId` is known (`:2164`), **before** the evidence/outcomes inserts:

```ts
  // 3a. Block hours (#4547): close every closable claimed period of each LIVE
  //     block line, onto this run's own draft. Same transaction as the claim, so
  //     a failure rolls back fee, claim and drawdown together.
  const hourBlockCloses: HourBlockCloseSummary[] = [];
  let hourBlockCloseTruncated = false;
  for (const l of billable) {
    if (l.lineType !== 'hour_block') continue;
    const r = await closeHourBlockPeriods({ contract: c, line: l, overageInvoice: { id: inv.id, actor }, closeSource: 'billing_run', asOf });
    hourBlockCloses.push(...r.closes);
    hourBlockCloseTruncated ||= r.truncated;
  }
```

   and return `hourBlockCloses, hourBlockCloseTruncated` on the success path.
4. Retirement. Add a module-private helper and call it as `retireLiveHourBlocks(contractId)` in both expiry branches (`:2031`, `:2196`) and in `cancelContract`, inside the same transaction as the status change:

```ts
/** Expire/cancel end the block (#4547 plan-time amendment 5): stamp the live
 *  line retired so the one-live-block-per-org index frees for a successor.
 *  Pre-retirement claimed periods still close via runHourBlockCloseOutSweep. */
async function retireLiveHourBlocks(contractId: string): Promise<void> {
  // now() = transaction start, the same instant contract_billing_periods.generated_at
  // (DEFAULT now()) gets for a claim in this transaction — so a final period claimed
  // on the expiring run satisfies generated_at <= retired_at. Never pass asOf here.
  await db.update(contractLines).set({ hourBlockRetiredAt: sql`now()` })
    .where(and(eq(contractLines.contractId, contractId), eq(contractLines.lineType, 'hour_block'), isNull(contractLines.hourBlockRetiredAt)));
}
```

   In `cancelContract` use the transaction handle it already opens (read `:1870-1885`; if it uses `tx`, pass `tx` and give the helper an executor parameter like `lockContractRow(tx, …)` does).
5. `contractWorker.ts` (`:79-98`): after the existing gap/uncovered warnings,

```ts
        if (res.hourBlockCloseTruncated) {
          console.warn('[contractWorker] block-hours close backlog capped; remaining periods close on later runs', { contractId: id });
        }
        for (const hb of res.hourBlockCloses.filter((h) => h.foreignCurrencyHours > 0)) {
          console.warn('[contractWorker] block hours absorbed entries stamped in another currency', { contractId: id, ...hb });
        }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractHourBlockBilling.integration.test.ts src/__tests__/integration/contractLineAllowance.integration.test.ts src/__tests__/integration/billingEvidence.integration.test.ts src/__tests__/integration/contractWorker.integration.test.ts`
Expected: PASS — the allowance, evidence and worker suites prove the existing generation path is unchanged.
Run: `cd apps/api && npx vitest run src/services/contractService.test.ts src/jobs/contractWorker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractService.ts apps/api/src/jobs/contractWorker.ts \
  apps/api/src/services/contractService.test.ts apps/api/src/__tests__/integration/contractHourBlockBilling.integration.test.ts
git commit -m "feat(billing): bill the block fee and close block periods on the contract billing run (#4547)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Concurrency — close vs. issue, close vs. edit, close vs. close

**Files:**
- Test: `apps/api/src/__tests__/integration/contractHourBlockConcurrency.integration.test.ts` (new)
- Modify: none expected; if a test reds, the fix lands in `contractHourBlockClose.ts` and is re-reviewed (high-blast surface).

**Interfaces:**
- Consumes: `generateDueInvoice`, `assembleDraftFromOrg` + `issueInvoice` (`invoiceService.ts:1320`, `:1379`), `updateTimeEntry`.

These must run **concurrently on two connections**, not sequentially (spec Codex 3). Use two `withSystemDbAccessContext` transactions and a `pg_advisory_lock` handshake so the interleaving is deterministic — find the existing pattern with `grep -rln "pg_advisory\|Promise.all" apps/api/src/__tests__/integration | xargs grep -l "for('update')\|FOR UPDATE"` and copy it; if none fits, use this one:

- [ ] **Step 1: Write the tests**

```ts
// apps/api/src/__tests__/integration/contractHourBlockConcurrency.integration.test.ts
import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods, invoiceLines, timeEntries } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { assembleDraftFromOrg, issueInvoice } from '../../services/invoiceService';
import { updateTimeEntry } from '../../services/timeEntryService';
import { seedBlockFixture, seedEntry, systemActor } from './hourBlockFixtures';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const AT = new Date('2026-08-01T06:00:00Z');

describe('block close concurrency (real DB) #4547', () => {
  it('close vs. issueInvoice over the same entries: one winner, a clean 409, no hour on both', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const e = await seedEntry(f, { minutes: 120, endedAt: '2026-07-15T12:00:00Z' });
    // Build the ad-hoc draft BEFORE holds exist (Task 6 would otherwise exclude it):
    // seed it directly as a line sourced from the entry.
    const draft = await sys(() => assembleDraftFromOrgIgnoringHolds(f));
    const results = await Promise.allSettled([
      sys(() => generateDueInvoice(f.contractId, AT)),
      sys(() => issueInvoice(draft.id, { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] })),
    ]);
    const issue = results[1];
    const [row] = await sys(() => db.select({ s: timeEntries.billingStatus, l: timeEntries.contractLineId }).from(timeEntries).where(eq(timeEntries.id, e)));
    if (row!.s === 'contract') {
      expect(issue.status).toBe('rejected');
      expect((issue as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'SOURCE_ALREADY_BILLED' });
    } else {
      expect(row!.s).toBe('billed');
      const [ledger] = await sys(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
      expect(ledger!.entryCount).toBe(0);
    }
    for (const r of results) if (r.status === 'rejected') expect((r.reason as { status?: number }).status).not.toBe(500);
  });

  it('a duration edit racing a close: the ledger matches exactly the rows it marked', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const ids = await Promise.all([1, 2, 3].map(() => seedEntry(f, { minutes: 60, endedAt: '2026-07-15T12:00:00Z' })));
    await Promise.allSettled([
      sys(() => generateDueInvoice(f.contractId, AT)),
      sys(() => updateTimeEntry(ids[1]!, { endedAt: new Date('2026-07-15T14:00:00Z') }, systemActor(f))),
    ]);
    const marked = await sys(() => db.select({ m: sql<number>`COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes})`.mapWith(Number) })
      .from(timeEntries).where(eq(timeEntries.contractLineId, f.blockLineId)));
    const [ledger] = await sys(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
    const expected = marked.reduce((n, r) => n + Math.round((r.m * 100) / 60), 0) / 100;
    expect(Number(ledger!.consumedHours)).toBe(expected);
    expect(ledger!.entryCount).toBe(marked.length);
  });

  it('two billing runs at once: one invoice, one ledger row', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await seedEntry(f, { minutes: 700, endedAt: '2026-07-15T12:00:00Z' });
    const rs = await Promise.all([sys(() => generateDueInvoice(f.contractId, AT)), sys(() => generateDueInvoice(f.contractId, AT))]);
    expect(rs.filter((r) => r.generated)).toHaveLength(1);
    const rows = await sys(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
    expect(rows).toHaveLength(1);
    const overageLines = await sys(() => db.select().from(invoiceLines).where(eq(invoiceLines.sourceId, f.blockLineId)));
    expect(overageLines.filter((l) => l.description.includes('hours over block'))).toHaveLength(1);
  });
});

/** An ad-hoc draft carrying the entry, created the way a technician's draft made
 *  before the block existed would look (assembly holds, Task 6, exclude it today). */
async function assembleDraftFromOrgIgnoringHolds(f: { orgId: string; partnerId: string; userId: string }) {
  return assembleDraftFromOrg({ orgId: f.orgId, from: '2026-07-01', to: '2026-07-31' },
    { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });
}
```

Order Task 5 **before** Task 6 when implementing, or (after Task 6 lands) seed the ad-hoc draft's invoice line directly (`insert(invoiceLines).values({ sourceType: 'time_entry', sourceId: e, … })`) so the test does not depend on the gatherer. The run's outcome is nondeterministic by design; the assertions hold for both winners.

- [ ] **Step 2: Run**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractHourBlockConcurrency.integration.test.ts`
Expected: PASS. Run it 5 times (`for i in 1 2 3 4 5; do …; done`) — a deadlock (`40P01`) or a 500 on any run is a failure to fix, not a flake.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/contractHourBlockConcurrency.integration.test.ts
git commit -m "test(billing): block close serializes with invoice issue, entry edits and parallel runs (#4547)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Ad-hoc assembly holds block-covered entries (Open Decision 9 A)

**Files:**
- Modify: `apps/api/src/services/contractHourBlockClose.ts` (add `hourBlockHoldWindows`)
- Modify: `apps/api/src/services/invoiceAssembly.ts:42-47` (`AssemblyResult`), `:81-88` (`mergeAssembly`), `:181-199` (`gatherOrgTimeEntries`), `:222-231` (`gatherTicketBillables`)
- Test: `apps/api/src/services/invoiceAssembly.test.ts` (merge), `apps/api/src/__tests__/integration/hourBlockAssemblyHold.integration.test.ts` (new)

**Interfaces:**
- Produces: `hourBlockHoldWindows(orgId, asOf?)` (index C7); `AssemblyResult.heldForHourBlock: { count: number; hours: number }` (W03 renders it).

Hold window definition (index delta 3), per block line `L` of the org:
- **W1** — every claimed period `P` with `P.start >= L.first_period_start`, `(L.retired_at IS NULL OR P.generated_at <= L.retired_at)` (claimed while live — the selector's rule), and no ledger row `(L, P.start)`: `[P.start, P.end)`.
- **W2** — only when `L` is live and its contract is `active`: `[max(L.first_period_start, min(currentPeriodStart, duePeriodStart)), ∞)`, where `currentPeriodStart` is the period containing today and `duePeriodStart` is the period the next run will claim (`generateDueInvoice`'s rule: advance → `periodIndexFor(nextBillingAt)`, arrears → one back). The `min` closes the arrears gap between a period's end and the run that claims it.

Entries in unclaimed past periods (pause gaps) and in closed periods (late entries) are **not** held — they bill ad hoc, which is the documented behaviour.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/__tests__/integration/hourBlockAssemblyHold.integration.test.ts
import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods } from '../../db/schema';
import { gatherOrgTimeEntries } from '../../services/invoiceAssembly';
import { hourBlockHoldWindows } from '../../services/contractHourBlockClose';
import { claimPeriod, seedBlockFixture, seedEntry } from './hourBlockFixtures';

const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-12-31T23:59:59Z');

describe('ad-hoc assembly holds block-covered time (real DB) #4547', () => {
  it('holds open-period entries and reports them; bills the rest', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-08-01', startDate: '2026-07-01', firstPeriodStart: '2026-07-01' });
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    const held = await seedEntry(f, { minutes: 90, endedAt: '2026-07-20T12:00:00Z' });
    const before = await seedEntry(f, { minutes: 60, endedAt: '2026-06-20T12:00:00Z' });
    const r = await withSystemDbAccessContext(() => gatherOrgTimeEntries(f.orgId, FROM, TO, 'USD', new Date('2026-07-25T00:00:00Z')));
    expect(r.included.map((l) => l.sourceId)).toEqual([before]);
    expect(r.heldForHourBlock).toEqual({ count: 1, hours: 1.5 });
    expect(r.included.map((l) => l.sourceId)).not.toContain(held);
  });

  it('does not hold entries in a closed period (late entry) or in an unclaimed pause gap', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', nextBillingAt: '2026-11-01' });
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await withSystemDbAccessContext(() => db.insert(contractHourPeriods).values({
      contractLineId: f.blockLineId, contractId: f.contractId, orgId: f.orgId, periodStart: '2026-07-01', periodEnd: '2026-08-01',
      includedHours: '10.00', carriedInHours: '0.00', consumedHours: '0.00', overageHours: '0.00', carriedOutHours: '0.00',
      foreignCurrencyHours: '0.00', entryCount: 0, overageUnitPrice: '150.00', currencyCode: 'USD', closeSource: 'billing_run',
    }));
    const late = await seedEntry(f, { minutes: 60, endedAt: '2026-07-20T12:00:00Z' });
    const gap = await seedEntry(f, { minutes: 60, endedAt: '2026-08-20T12:00:00Z' });
    const r = await withSystemDbAccessContext(() => gatherOrgTimeEntries(f.orgId, FROM, TO, 'USD', new Date('2026-10-15T00:00:00Z')));
    expect(r.included.map((l) => l.sourceId).sort()).toEqual([late, gap].sort());
    expect(r.heldForHourBlock).toEqual({ count: 0, hours: 0 });
  });

  it('holds the final claimed period of a cancelled contract until the sweep closes it', async () => {
    const f = await seedBlockFixture({ timing: 'advance', status: 'cancelled', nextBillingAt: undefined });
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 60, endedAt: '2026-07-20T12:00:00Z' });
    const w = await withSystemDbAccessContext(() => hourBlockHoldWindows(f.orgId, new Date('2026-07-25T00:00:00Z')));
    expect(w).toEqual([{ start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z'), contractLineId: f.blockLineId }]);
  });

  it('arrears: holds the just-ended period until the run claims it', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', nextBillingAt: '2026-08-01' });   // July unclaimed until the 08-01 run
    const julyWork = await seedEntry(f, { minutes: 60, endedAt: '2026-07-30T12:00:00Z' });
    const r = await withSystemDbAccessContext(() => gatherOrgTimeEntries(f.orgId, FROM, TO, 'USD', new Date('2026-08-01T02:00:00Z')));
    expect(r.included.map((l) => l.sourceId)).not.toContain(julyWork);
    expect(r.heldForHourBlock.count).toBe(1);
  });

  it('works in a partner-scoped request context (Shape-1 reads only)', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const w = await withDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId] },
      () => hourBlockHoldWindows(f.orgId, new Date('2026-07-25T00:00:00Z')));
    expect(w).toHaveLength(1);
  });
});
```

The `withDbAccessContext` argument shape must match `apps/api/src/db/index.ts` — copy it from an existing partner-scoped integration test (`grep -rn "withDbAccessContext(" apps/api/src/__tests__/integration | head`).

Unit, `invoiceAssembly.test.ts`: `mergeAssembly` sums `heldForHourBlock` across parts; `partitionTimeEntries` output carries `{ count: 0, hours: 0 }`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hourBlockAssemblyHold.integration.test.ts`
Expected: FAIL — `hourBlockHoldWindows` is not exported / `heldForHourBlock` undefined.

- [ ] **Step 3: Implement**

`contractHourBlockClose.ts`:

```ts
export async function hourBlockHoldWindows(orgId: string, asOf: Date = new Date()):
  Promise<Array<{ start: Date; end: Date | null; contractLineId: string }>> {
  const blocks = await db.select({ line: contractLines, contract: contracts })
    .from(contractLines).innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(eq(contractLines.orgId, orgId), eq(contractLines.lineType, 'hour_block')));
  const today = todayUTC(asOf);
  const out: Array<{ start: Date; end: Date | null; contractLineId: string }> = [];
  for (const { line, contract } of blocks) {
    const first = line.hourBlockFirstPeriodStart!;
    const retiredAt = line.hourBlockRetiredAt;
    const claimed = await db.select({ s: contractBillingPeriods.periodStart, e: contractBillingPeriods.periodEnd, g: contractBillingPeriods.generatedAt })
      .from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, contract.id));
    const closed = new Set((await db.select({ s: contractHourPeriods.periodStart }).from(contractHourPeriods)
      .where(eq(contractHourPeriods.contractLineId, line.id))).map((r) => r.s));
    for (const p of claimed) {
      // Same entitlement rule as selectClosablePeriods: claimed while the line was live.
      if (p.s < first || closed.has(p.s) || (retiredAt !== null && p.g.getTime() > retiredAt.getTime())) continue;
      out.push({ start: dayStart(p.s), end: dayStart(p.e), contractLineId: line.id });            // W1
    }
    if (retiredAt === null && contract.status === 'active') {
      // W2 opens at the EARLIER of the calendar-current period and the period the
      // next run will claim. On arrears the just-ended period stays unclaimed until
      // the worker runs; without the second term its entries would be unheld in
      // that gap and an ad-hoc invoice could bill them before the block fee does.
      // Period starts come from computePeriod (never addMonthsClamped(-n)) so a
      // 03-31 contract's periods line up with the claims.
      const cur = computePeriod(contract.startDate, contract.intervalMonths,
        Math.max(0, periodIndexFor(contract.startDate, contract.intervalMonths, today))).periodStart;
      let due = cur;
      if (contract.nextBillingAt) {
        const idxAt = periodIndexFor(contract.startDate, contract.intervalMonths, contract.nextBillingAt);
        due = computePeriod(contract.startDate, contract.intervalMonths,
          Math.max(0, contract.billingTiming === 'advance' ? idxAt : idxAt - 1)).periodStart;   // generateDueInvoice's own rule
      }
      const open = [cur, due, first].reduce((a, b) => (a < b ? a : b));
      out.push({ start: dayStart(open < first ? first : open), end: null, contractLineId: line.id }); // W2
    }
  }
  return out;
}
```

(import `computePeriod`, `periodIndexFor` from `./contractMath`; `periodIndexFor`'s behaviour for `asOf < startDate` must be checked — clamp with `Math.max(0, …)` as shown.)

`invoiceAssembly.ts`:

```ts
export interface AssemblyResult {
  included: DraftLineSpec[];
  blockedByCurrency: Record<string, DraftLineSpec[]>;
  missingRate: MissingRateSpec[];
  /** Not-billed entries inside a block-of-hours pending window (#4547). They are
   *  billed by the block's period close, never ad hoc. Reported, never silent. */
  heldForHourBlock: { count: number; hours: number };
}
```

- every constructor of an `AssemblyResult` (`partitionByCurrency`, `partitionTimeEntries`, the parts/AI-usage gatherers, `mergeAssembly`'s seed) initialises `heldForHourBlock: { count: 0, hours: 0 }`; `mergeAssembly` sums both fields (hours via `sumEntryHours`-style hundredths: `Math.round((a + b) * 100) / 100`).
- `gatherOrgTimeEntries(orgId, from, to, headerCurrency, asOf = new Date())` and `gatherTicketBillables(ticketId, headerCurrency, asOf = new Date())`: select `endedAt` too; after the query, compute `const windows = await hourBlockHoldWindows(orgId, asOf)` (ticket path: the ticket's org, from the first row's `orgId` — select it) and split rows with

```ts
const inWindow = (t: Date) => windows.some((w) => t >= w.start && (w.end === null || t < w.end));
const held = rows.filter((r) => inWindow(r.endedAt!));
const billable = rows.filter((r) => !inWindow(r.endedAt!));
const result = partitionTimeEntries(billable, headerCurrency);
result.heldForHourBlock = { count: held.length, hours: sumEntryHours(held.map((r) => (r.billableMinutes ?? r.durationMinutes) ?? 0)) };
return result;
```

  `invoiceAssembly.ts` importing `contractHourBlockClose.ts` must not create an import cycle with `invoiceService.ts` (which `contractHourBlockClose.ts` imports for `addContractLine`). If it does, move `hourBlockHoldWindows` into a third file `contractHourBlockHolds.ts` that imports only `db`, schema and `contractMath`, and re-export it from `contractHourBlockClose.ts` so index C7's import path still works.
- `finishAssembly` (`invoiceService.ts`, called at `:1352` and `:1372`): if an empty gather is an error ("No unbilled billable work in range"), make the error message say "— N entries (X h) are held for block hours" when `heldForHourBlock.count > 0`, and include `heldForHourBlock` both in the success return and in the empty-gather error's `details` (W03 Task 13 renders `details.heldForHourBlock` on the 409), so the route passes it through. Read `finishAssembly` first.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/invoiceAssembly.test.ts && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hourBlockAssemblyHold.integration.test.ts src/__tests__/integration/assemblyBlockedByCurrency.integration.test.ts`
Expected: PASS (the currency suite proves the existing partitions are unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractHourBlockClose.ts apps/api/src/services/invoiceAssembly.ts apps/api/src/services/invoiceService.ts \
  apps/api/src/services/invoiceAssembly.test.ts apps/api/src/__tests__/integration/hourBlockAssemblyHold.integration.test.ts
git commit -m "feat(billing): ad-hoc invoice assembly leaves block-covered time for the block close (#4547)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Close-out sweep for periods the billing run will not revisit

**Files:**
- Modify: `apps/api/src/services/contractHourBlockClose.ts` (add `runHourBlockCloseOutSweep`)
- Modify: `apps/api/src/jobs/contractWorker.ts:137-150` (run it after `runContractBillingSweep()` in the billing-sweep job)
- Test: `apps/api/src/__tests__/integration/hourBlockCloseOut.integration.test.ts` (new); `apps/api/src/jobs/contractWorker.test.ts` (ordering)

**Interfaces:**
- Consumes: `closeHourBlockPeriods` with a lazy `overageInvoice` factory; `createManualInvoice`; `lockContractRow` (`contractService.ts:308`); `buildAutomationEligibleOrgPredicate` (imported at `contractWorker.ts:21`).
- Produces: `runHourBlockCloseOutSweep(asOf?)` (index C7).

Candidates: every `hour_block` line where **(contract `status <> 'active'`) OR (`hour_block_retired_at IS NOT NULL`)**, on an automation-eligible org, that has at least one claimed, ended period `>= first_period_start` with no ledger row (the selector decides; the SQL pre-filter only narrows). Per contract: own `runOutsideDbContext(() => withSystemDbAccessContext(...))` transaction, `lockContractRow` first, per-contract try/catch with Sentry capture exactly like `runContractBillingSweep` (`captureException` at `contractWorker.ts:108`, `:128`).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/__tests__/integration/hourBlockCloseOut.integration.test.ts
import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods, contracts, invoiceLines, invoices } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { runHourBlockCloseOutSweep } from '../../services/contractHourBlockClose';
import { entryState, seedBlockFixture, seedEntry } from './hourBlockFixtures';

const at = (d: string) => new Date(`${d}T06:00:00Z`);

describe('runHourBlockCloseOutSweep (real DB) #4547', () => {
  it('advance contract expiring: the final period closes after it ends, overage on a new draft', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-08-01' });
    const r = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01'))); // claims July, expires
    expect(r.generated).toBe(true);
    await seedEntry(f, { minutes: 720, endedAt: '2026-07-25T12:00:00Z' });             // 2 h over

    expect(await runHourBlockCloseOutSweep(at('2026-07-28'))).toMatchObject({ closes: 0 }); // not ended yet
    const s = await runHourBlockCloseOutSweep(at('2026-08-02'));
    expect(s).toMatchObject({ closes: 1, errors: 0 });

    const [row] = await withSystemDbAccessContext(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
    expect(row).toMatchObject({ periodStart: '2026-07-01', overageHours: '2.00', closeSource: 'close_out' });
    const [inv] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, row!.overageInvoiceId!)));
    expect(inv!.status).toBe('draft');
    expect(inv!.id).not.toBe(r.invoiceId);
    const lines = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv!.id)));
    expect(lines.map((l) => l.description)).toEqual(['Support hours — hours over block, 2026-07-01 – 2026-08-01']);
  });

  it('cancelled mid-period with no overage: closes, marks entries, creates no invoice', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01' });
    await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01')));
    await withSystemDbAccessContext(() => db.update(contracts).set({ status: 'cancelled', nextBillingAt: null }).where(eq(contracts.id, f.contractId)));
    const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    const before = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.orgId, f.orgId)));
    await runHourBlockCloseOutSweep(at('2026-08-02'));
    const after = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.orgId, f.orgId)));
    expect(after).toHaveLength(before.length);
    expect(await entryState(e)).toEqual({ billingStatus: 'contract', contractLineId: f.blockLineId });
  });

  it('is idempotent and leaves active live blocks to the billing run', async () => {
    const live = await seedBlockFixture({ timing: 'arrears' });
    await seedEntry(live, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    expect(await runHourBlockCloseOutSweep(at('2026-08-02'))).toMatchObject({ closes: 0 });
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-08-01' });
    await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01')));
    await runHourBlockCloseOutSweep(at('2026-08-02'));
    expect(await runHourBlockCloseOutSweep(at('2026-08-03'))).toMatchObject({ closes: 0 });
  });

  it('a sweep racing a manual generate on the same contract closes each period once', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-08-01' });
    await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01')));
    await seedEntry(f, { minutes: 700, endedAt: '2026-07-10T12:00:00Z' });
    await Promise.all([runHourBlockCloseOutSweep(at('2026-08-02')), runHourBlockCloseOutSweep(at('2026-08-02'))]);
    const rows = await withSystemDbAccessContext(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
    expect(rows).toHaveLength(1);
  });
});
```

Worker unit test: the billing-sweep job calls `runContractRenewalSweep` → `runContractBillingSweep` → `runHourBlockCloseOutSweep`, in that order (mock all three, assert `mock.invocationCallOrder`).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hourBlockCloseOut.integration.test.ts`
Expected: FAIL — `runHourBlockCloseOutSweep` is not exported.

- [ ] **Step 3: Implement**

```ts
export async function runHourBlockCloseOutSweep(asOf: Date = new Date()): Promise<{ contracts: number; closes: number; errors: number }> {
  const candidates = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.selectDistinct({ contractId: contractLines.contractId }).from(contractLines)
      .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
      .where(and(
        eq(contractLines.lineType, 'hour_block'),
        or(ne(contracts.status, 'active'), isNotNull(contractLines.hourBlockRetiredAt)),
        buildAutomationEligibleOrgPredicate(contracts.orgId),
        sql`EXISTS (SELECT 1 FROM contract_billing_periods p
                    WHERE p.contract_id = ${contractLines.contractId}
                      AND p.period_start >= ${contractLines.hourBlockFirstPeriodStart}
                      AND p.period_end <= ${asOf.toISOString().slice(0, 10)}::date
                      AND NOT EXISTS (SELECT 1 FROM contract_hour_periods h
                                      WHERE h.contract_line_id = ${contractLines.id} AND h.period_start = p.period_start))`,
      ))));
  let closes = 0; let errors = 0;
  for (const { contractId } of candidates) {
    try {
      closes += await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        const c = await lockContractRow(db, contractId);
        const actor: InvoiceActor = { userId: c.createdBy, partnerId: c.partnerId, accessibleOrgIds: [c.orgId] };
        const lines = await db.select().from(contractLines)
          .where(and(eq(contractLines.contractId, contractId), eq(contractLines.lineType, 'hour_block')));
        let n = 0;
        for (const line of lines) {
          if (c.status === 'active' && line.hourBlockRetiredAt === null) continue;   // billing run owns it
          const r = await closeHourBlockPeriods({
            contract: c, line, closeSource: 'close_out', asOf,
            overageInvoice: async () => {
              const inv = await createManualInvoice({ orgId: c.orgId, currencyCode: c.currencyCode,
                notes: `Block hours over the included amount on contract "${c.name}" (final period)` }, actor);
              return { id: inv.id, actor };
            },
          });
          n += r.closes.length;
        }
        return n;
      }));
    } catch (err) {
      errors += 1;
      console.error('[contractHourBlocks] close-out failed', { contractId, err });
      captureException(err);   // same Sentry helper contractWorker.ts:108 uses — import it from there
    }
  }
  return { contracts: candidates.length, closes, errors };
}
```

`lockContractRow` lives in `contractService.ts`, which will import this module (Task 4) — importing it back is a cycle. Pass it in instead: move the lock to a 3-line local `SELECT … FOR UPDATE` on `contracts` here (same statement as `contractService.ts:308-312`), with a comment pointing at the original. The draft is never auto-issued: nothing here calls `issueInvoice`, and the returned summary carries no `autoIssue`.

`contractWorker.ts`: in the billing-sweep job, after `await runContractBillingSweep();`,

```ts
      const hb = await runHourBlockCloseOutSweep();
      if (hb.closes > 0 || hb.errors > 0) console.info('[contractWorker] block-hours close-out', hb);
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hourBlockCloseOut.integration.test.ts && npx vitest run src/jobs/contractWorker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/contractHourBlockClose.ts apps/api/src/jobs/contractWorker.ts apps/api/src/jobs/contractWorker.test.ts \
  apps/api/src/__tests__/integration/hourBlockCloseOut.integration.test.ts
git commit -m "feat(billing): daily close-out of block-hour periods after expiry, cancellation or retirement (#4547)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Org moves refuse block-drawn time (Open Decision 11 A)

**Files:**
- Create: `apps/api/src/services/ticketMoveHourBlockGuard.ts`
- Modify: `apps/api/src/services/ticketService.ts:3434` (call before the currency guard), `apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts:883` (same), and every catch site of `TicketMoveCurrencyBlockedError`: `apps/api/src/routes/tickets/moveOrg.ts`, `apps/api/src/routes/devices/moveOrg.ts`, `apps/api/src/services/aiToolsTicketing.ts`, `apps/api/src/services/unassignedPool/assignParkedDevice.ts`
- Test: `apps/api/src/__tests__/integration/hourBlockOrgMove.integration.test.ts` (new); route tests beside each route

**Interfaces:**
- Produces: `assertNoHourBlockDrawnTime(tx, { ticketIds }): Promise<void>`; `class TicketMoveHourBlockError extends Error { status = 409; code = 'HOUR_BLOCK_DRAWN_TIME'; details: { drawnTimeEntries: number } }`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/__tests__/integration/hourBlockOrgMove.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations, tickets, timeEntries } from '../../db/schema';
import { moveTicketOrg } from '../../services/ticketService';
import { seedBlockFixture, seedEntry } from './hourBlockFixtures';

describe('org moves and block-drawn time (real DB) #4547', () => {
  it('refuses a ticket move when the ticket carries block-drawn time', async () => {
    const f = await seedBlockFixture();
    const target = await seedSiblingOrg(f.partnerId);
    const ticketId = await seedTicket(f);
    const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    await withSystemDbAccessContext(() => db.update(timeEntries)
      .set({ ticketId, billingStatus: 'contract', contractLineId: f.blockLineId }).where(eq(timeEntries.id, e)));
    await expect(withSystemDbAccessContext(() => moveTicketOrg(ticketId, target, ticketMoveActor(f, target), {})))
      .rejects.toMatchObject({ status: 409, code: 'HOUR_BLOCK_DRAWN_TIME', details: { drawnTimeEntries: 1 } });
    const [t] = await withSystemDbAccessContext(() => db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketId)));
    expect(t!.orgId).toBe(f.orgId);   // nothing moved
  });

  it('still moves a ticket whose time is only held (not yet drawn)', async () => {
    const f = await seedBlockFixture();
    const target = await seedSiblingOrg(f.partnerId);
    const ticketId = await seedTicket(f);
    const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    await withSystemDbAccessContext(() => db.update(timeEntries).set({ ticketId }).where(eq(timeEntries.id, e)));
    await expect(withSystemDbAccessContext(() => moveTicketOrg(ticketId, target, ticketMoveActor(f, target), {}))).resolves.toBeDefined();
  });
});
```

Write `seedSiblingOrg`, `seedTicket` and `ticketMoveActor` in the same file by copying the setup from the existing ticket-move integration suite (`grep -rln "moveTicketOrg(" apps/api/src/__tests__/integration`) — `moveTicketOrg`'s signature and the `rowVersion` it needs (`ticketService.ts:3094`, `xmin` check at `:3386`) come from there. Add the device-move twin by copying the device-move integration suite's fixture (`billingEvidenceDeviceMove.integration.test.ts` moves a device; reuse its harness): a device whose ticket carries a drawn entry → 409 `HOUR_BLOCK_DRAWN_TIME`. Route tests: the tickets and devices move routes map the error to HTTP 409 with `code` and `details` in the body, like `TICKET_MOVE_CURRENCY_BLOCKED`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hourBlockOrgMove.integration.test.ts`
Expected: FAIL — the first test rejects with a 23503 FK violation (`time_entries_contract_line_org_fk`) at commit, not a 409.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/ticketMoveHourBlockGuard.ts
import { inArray } from 'drizzle-orm';
import { timeEntries } from '../db/schema';
import type { Tx } from './ticketMoveCurrencyGuard';   // reuse its Tx alias; export it there if it is private

/**
 * #4547: time drawn by a block of hours is pinned to the block's org by the
 * composite (contract_line_id, org_id) FK. Moving it would fail at commit, and
 * detaching it would make an already-paid-for hour billable again. Both movers
 * refuse instead — the operator moves the ticket before the period closes, or
 * not at all. 409 carrier shaped like TicketMoveCurrencyBlockedError.
 */
export class TicketMoveHourBlockError extends Error {
  readonly status = 409 as const;
  readonly code = 'HOUR_BLOCK_DRAWN_TIME' as const;
  constructor(public details: { drawnTimeEntries: number }) {
    super(`${details.drawnTimeEntries} time ${details.drawnTimeEntries === 1 ? 'entry was' : 'entries were'} drawn from a block of prepaid hours and cannot move to another organization`);
    this.name = 'TicketMoveHourBlockError';
  }
}

export async function assertNoHourBlockDrawnTime(tx: Tx, input: { ticketIds: string[] }): Promise<void> {
  if (input.ticketIds.length === 0) return;
  // Lock EVERY time entry of the moving tickets, id order — the global
  // tickets -> time_entries order both movers and the block close already use.
  // If a close holds them, we wait and then see contract_line_id; if we hold
  // them first, the close's FOR UPDATE re-evaluates `org_id = <old org>` after
  // our commit (READ COMMITTED) and drops the moved rows. Either way: a clean
  // 409 or a clean move, never a 23503 at commit.
  const rows = await tx.select({ id: timeEntries.id, contractLineId: timeEntries.contractLineId })
    .from(timeEntries).where(inArray(timeEntries.ticketId, input.ticketIds))
    .orderBy(timeEntries.id).for('update');
  const drawn = rows.filter((r) => r.contractLineId !== null).length;
  if (drawn > 0) throw new TicketMoveHourBlockError({ drawnTimeEntries: drawn });
}
```

Call it in `moveTicketOrg` immediately before `assertTicketMoveCurrencyCompatible` (`ticketService.ts:3434`) with `{ ticketIds: [ticketId] }`, and in `moveDeviceOrgInTransaction.ts` immediately before `:883` with the same `ticketIds` array it already computes. The currency guard then re-locks a subset of the same rows in the same order — a no-op for a lock already held. Add a concurrency case to the integration test: a ticket move and a `generateDueInvoice` over the same entry run concurrently (`Promise.allSettled`, two system transactions); assert the outcome is either (moved, entry `not_billed` in the target org) or (409 `HOUR_BLOCK_DRAWN_TIME`, entry drawn in the source org), never a 23503 or 40P01. In each catch site, add a branch for `TicketMoveHourBlockError` next to the `TicketMoveCurrencyBlockedError` one, returning the same 409 JSON shape (`{ error: message, code, details }`).

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hourBlockOrgMove.integration.test.ts` then the four touched routes'/services' unit tests (`npx vitest run src/routes/tickets/moveOrg.test.ts src/routes/devices/moveOrg.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/aiToolsTicketing.test.ts`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketMoveHourBlockGuard.ts apps/api/src/services/ticketService.ts \
  apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts apps/api/src/routes/tickets/moveOrg.ts \
  apps/api/src/routes/devices/moveOrg.ts apps/api/src/services/aiToolsTicketing.ts \
  apps/api/src/services/unassignedPool/assignParkedDevice.ts apps/api/src/__tests__/integration/hourBlockOrgMove.integration.test.ts
git commit -m "feat(billing): ticket and device org moves keep block-drawn time in its organization (#4547)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification and PR

- [ ] **Step 1: Typecheck**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p . ; echo "tsc exit $?"`
Expected: `tsc exit 0` (never pipe tsc to `tail`).

- [ ] **Step 2: Unit suites in batches** (foreground, generous timeouts)

```bash
cd apps/api
npx vitest run src/services/contractHourBlocks.test.ts src/services/contractService.test.ts src/services/contractService.siteScope.test.ts
npx vitest run src/services/timeEntryService.test.ts src/services/invoiceAssembly.test.ts src/jobs/contractWorker.test.ts
npx vitest run src/services/orgMerge.test.ts        # only reds in the full suite otherwise
```

- [ ] **Step 3: Integration suites** (`pnpm test-stack up` first; `pnpm test-stack down` at the end)

```bash
cd apps/api
npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractHourBlockClose.integration.test.ts \
  src/__tests__/integration/contractHourBlockBilling.integration.test.ts src/__tests__/integration/contractHourBlockConcurrency.integration.test.ts
npx vitest run -c vitest.integration.config.ts src/__tests__/integration/hourBlockAssemblyHold.integration.test.ts \
  src/__tests__/integration/hourBlockCloseOut.integration.test.ts src/__tests__/integration/hourBlockOrgMove.integration.test.ts \
  src/__tests__/integration/timeEntryBlockDrawn.integration.test.ts
npx vitest run -c vitest.integration.config.ts src/__tests__/integration/contractLineAllowance.integration.test.ts \
  src/__tests__/integration/billingEvidence.integration.test.ts src/__tests__/integration/contractWorker.integration.test.ts \
  src/__tests__/integration/assemblyBlockedByCurrency.integration.test.ts src/__tests__/integration/multiCurrencyWave6ContractBilling.integration.test.ts
npx vitest run -c vitest.integration.config.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```

Expected: all PASS; record the file and test counts for the PR body.

- [ ] **Step 4: Open the PR**

Branch `feature/4547-block-hours/wave-<W02 sub-issue#>` off fresh `origin/main` (W01 merged). PR body: what W02 does (engine only; no API creates a block line yet), the test evidence with counts, "Part of #4547" and `Closes #<W02 sub-issue>`. Neutral wording. Run `/pr-review-toolkit:review-pr` (one round), post the summary as a PR comment, stop.

---

## Self-review

- **Spec coverage (W02 slice):** §2 ledger-at-close, claimed-period rule, earliest-first contiguity, 12-period cap → Tasks 1, 3. Claiming entries (lock order, mark-what-you-locked, count check) → Task 3, 5. Eligibility incl. unapproved (D4), NULL rate, any currency + flag (D8) → Task 3. Terminal disposition narrowed by amendment 1 → Task 2. §3 rollover → Task 1, 3. §4 overage line → Task 3, 4; lock-order exception documented in code → Task 3. Decision 6 A (as amended: sweep) → Task 7. Plan-time amendments 3 (hold) → Task 6; 5 (retire on expire/cancel) → Task 4; 6 (org moves) → Task 8; 7 (outcomes untouched, `hourBlockCloses`) → Task 4. Spec §"Out of scope" late entries → Task 6 test 2 (billed ad hoc, not held). Not in W02 by design: line writers, estimate, UI, AI description (W03); portal, alerts, docs (W04).
- **Placeholder scan:** every code step has code. Steps that say "copy the harness from X" name the exact file and grep — the harness shape (actor fields, `rowVersion`) is environment detail an implementer must read, not design.
- **Type consistency vs. index C7:** `closeHourBlockPeriods({ contract, line, overageInvoice, closeSource, asOf })`, `HourBlockCloseSummary` fields, `hourBlockHoldWindows(orgId, asOf?)`, `runHourBlockCloseOutSweep(asOf?) → { contracts, closes, errors }`, `GenerateResult.hourBlockCloses / hourBlockCloseTruncated`, error codes `HOUR_BLOCK_CLOSE_MISMATCH` / `ENTRY_DRAWN_BY_BLOCK` / `HOUR_BLOCK_DRAWN_TIME` — all match.
- **Review Focus coverage:** 1 → Task 4 advance test; 2 → Task 1 + Task 4 pause test; 3 → Task 5; 4 → Task 2; 5 → Task 7 first test.
