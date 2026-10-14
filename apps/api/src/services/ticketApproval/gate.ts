import { multiplyToCurrency, toMinorUnits } from '@breeze/shared';
import type { TicketApprovalEnforcement, TicketApprovalTrigger } from '../../db/schema';

/**
 * Customer work approval gate (#4617 spec §5.3–§5.5). PURE: every figure is
 * loaded by the caller under the ticket row lock (requests.ts loadGateContext),
 * so two writers on the same ticket see each other's committed result.
 *
 * Money is in MINOR units of the ticket's budget currency (cents for USD, yen
 * for JPY) via the shared exact-decimal helpers — never `Number(rate) * hours`.
 */

export type GateTrigger = TicketApprovalTrigger;
export type GateOperation = 'create_finished' | 'start_timer' | 'stop' | 'update';

export interface GateEntry {
  isBillable: boolean;
  coverage: 'billable' | 'included' | 'non_billable';
  /** Billed quantity, `COALESCE(billable_minutes, duration_minutes)`; null = still running. */
  minutes: number | null;
  hourlyRate: string | null;
  currencyCode: string | null;
  isAfterHoursWorkType: boolean;
}

export interface GateInput {
  settings: { enabled: boolean; budgetTrigger: boolean; afterHoursTrigger: boolean; enforcement: TicketApprovalEnforcement };
  ticket: { budgetMinutes: number | null; budgetAmount: string | null; budgetCurrencyCode: string | null };
  /** Consumed by the ticket's settled entries, EXCLUDING the entry being written. */
  consumed: { minutes: number; amountMinor: number };
  /** Σ approved extensions of the ticket's approved budget requests. */
  approvedExtensions: { minutes: number; amountMinor: number };
  entry: GateEntry;
  /** An approved after-hours consent covers this entry (requests.ts afterHoursCovered). */
  afterHoursCovered: boolean;
  /** Queue rule (spec §5.3): a pending budget request exists on the ticket. */
  pendingBudgetRequest: boolean;
  operation: GateOperation;
}

export type GateResult =
  | { kind: 'pass' }
  | { kind: 'hold'; trigger: GateTrigger; overMinutes: number; overAmountMinor: number }
  /** Only ever for `operation === 'start_timer'` in hard mode: past work is never refused. */
  | { kind: 'refuse'; trigger: GateTrigger };

/**
 * The money an entry would put on an invoice, in minor units of `budgetCurrency`.
 * Quantity derivation is invoiceAssembly's `entryHours` (minutes / 60, 2 dp)
 * and the product is `multiplyToCurrency` (one half-up round), so a held
 * figure equals what the invoice would charge. Null = unknown price.
 */
export function entryAmountMinor(
  e: Pick<GateEntry, 'minutes' | 'hourlyRate' | 'currencyCode'>,
  budgetCurrency: string,
): number | null {
  if (e.minutes == null || e.hourlyRate == null || e.currencyCode == null) return null;
  if (e.currencyCode !== budgetCurrency) return null;
  const hours = (e.minutes / 60).toFixed(2);
  return toMinorUnits(multiplyToCurrency(hours, e.hourlyRate, e.currencyCode), e.currencyCode);
}

const PASS: GateResult = { kind: 'pass' };

export function evaluateApprovalGate(i: GateInput): GateResult {
  const s = i.settings;
  if (!s.enabled) return PASS;
  const e = i.entry;
  // Included, non-billable and ticketless work is never held (spec §5.1).
  if (!e.isBillable || e.coverage !== 'billable') return PASS;
  const refuseOrPass = (trigger: GateTrigger): GateResult =>
    s.enforcement === 'hard' ? { kind: 'refuse', trigger } : PASS;

  // After-hours first (spec §5.4). An entry is linked to one request at a time.
  if (s.afterHoursTrigger && e.isAfterHoursWorkType && !i.afterHoursCovered) {
    if (i.operation === 'start_timer') return refuseOrPass('after_hours');
    if (e.minutes == null) return PASS; // still running: evaluated at stop
    return { kind: 'hold', trigger: 'after_hours', overMinutes: 0, overAmountMinor: 0 };
  }

  if (!s.budgetTrigger) return PASS;
  const t = i.ticket;
  const ceilMinutes = t.budgetMinutes == null ? null : t.budgetMinutes + i.approvedExtensions.minutes;
  const ceilMinor = t.budgetAmount == null || t.budgetCurrencyCode == null
    ? null
    : toMinorUnits(t.budgetAmount, t.budgetCurrencyCode) + i.approvedExtensions.amountMinor;
  if (ceilMinutes == null && ceilMinor == null) return PASS;

  if (i.operation === 'start_timer') {
    if (i.pendingBudgetRequest) return refuseOrPass('budget');
    const atCeiling = (ceilMinutes != null && i.consumed.minutes >= ceilMinutes)
      || (ceilMinor != null && i.consumed.amountMinor >= ceilMinor);
    return atCeiling ? refuseOrPass('budget') : PASS;
  }
  if (e.minutes == null) return PASS; // still running after an update: evaluated at stop
  // Queue rule: while a budget request is pending, later work joins it rather
  // than being tested against the remaining headroom (spec §5.3).
  if (i.pendingBudgetRequest) return { kind: 'hold', trigger: 'budget', overMinutes: 0, overAmountMinor: 0 };

  const overMinutes = ceilMinutes == null ? 0 : Math.max(0, i.consumed.minutes + e.minutes - ceilMinutes);
  let overAmountMinor = 0;
  let unknownMoney = false;
  if (ceilMinor != null) {
    const amount = entryAmountMinor(e, t.budgetCurrencyCode!);
    if (amount == null) unknownMoney = true;
    else overAmountMinor = Math.max(0, i.consumed.amountMinor + amount - ceilMinor);
  }
  if (overMinutes > 0 || overAmountMinor > 0 || unknownMoney) {
    return { kind: 'hold', trigger: 'budget', overMinutes, overAmountMinor };
  }
  return PASS;
}
