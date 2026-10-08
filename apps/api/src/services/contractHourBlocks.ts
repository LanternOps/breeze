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
