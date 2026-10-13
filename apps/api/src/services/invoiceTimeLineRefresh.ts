/**
 * #8606 (feature #8601 W05): "Refresh from time entries" for an unissued draft.
 *
 * A draft's time_entry lines are snapshots taken at assembly. When a technician
 * later edits the source entry (its note, its start time, its approval), the
 * draft goes stale. This module decides, for ONE line and its source entry,
 * what a refresh may change. It is pure: the transactional caller
 * (`refreshDraftTimeLines` in invoiceService.ts) reads the rows under the
 * invoice lock and applies `set`.
 *
 * What a refresh may change: `description` (unless the line was hand-edited,
 * `description_edited`), `work_date`, `worked_minutes`, `is_unapproved_time`.
 * What it never changes: `quantity`, `unit_price`, `line_total`, the line
 * set itself (it never adds or removes a line), or anything on an issued
 * invoice. When the entry's billed duration no longer matches the line's
 * quantity, the line is reported `quantityDrifted` and left entirely alone, so
 * the totals the operator already reviewed cannot move under them.
 *
 * Every value is derived through the SAME helper assembly uses
 * (`timeEntryToLineSpec`), so a refreshed line is byte-identical to what a
 * fresh assembly of the entry would write for those fields, including the
 * partner-local `work_date` (`toPartnerLocalDate`).
 */
import type { BillingStatus } from '@breeze/shared';
import { timeEntryToLineSpec } from './invoiceAssembly';

/** The invoice_lines columns a refresh reads. */
export interface RefreshLine {
  id: string;
  sourceId: string | null;
  description: string | null;
  descriptionEdited: boolean;
  quantity: string;
  workDate: string | null;
  workedMinutes: number | null;
  isUnapprovedTime: boolean;
}

/** The time_entries columns a refresh reads. */
export interface RefreshEntry {
  id: string;
  orgId: string | null;
  ticketId: string | null;
  description: string | null;
  durationMinutes: number | null;
  billableMinutes: number | null;
  hourlyRate: string | null;
  isApproved: boolean;
  isBillable: boolean;
  billingStatus: BillingStatus;
  currencyCode: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface RefreshContext {
  orgId: string;
  /** The draft's stamped currency. */
  currencyCode: string;
  /** The invoice partner's zone, for `work_date` (same as assembly). */
  timeZone: string;
  /** True when a block of hours will bill this entry at its period close. */
  isHeld: (endedAt: Date) => boolean;
}

/**
 * Why a line was left alone.
 * - `source_missing`: the entry was deleted (or the line has no source id).
 * - `billed_elsewhere`: the entry is `billed`. Drafts never flip
 *   billing_status (only issueInvoice does), so a billed entry was billed by
 *   ANOTHER invoice; this draft will fail SOURCE_ALREADY_BILLED at issue.
 * - `contract` / `no_charge`: the entry is now covered or comped.
 * - `awaiting_approval`: the entry is held until the customer approves it.
 * - `held_for_hour_block`: a block of hours will bill it at period close.
 * - `other_org`, `not_billable`, `not_ended`, `currency_mismatch`,
 *   `missing_rate`: the entry would no longer be gathered by assembly.
 */
export type RefreshSkipReason =
  | 'source_missing' | 'billed_elsewhere' | 'contract' | 'no_charge' | 'awaiting_approval' | 'held_for_hour_block'
  | 'other_org' | 'not_billable' | 'not_ended' | 'currency_mismatch' | 'missing_rate';

export type RefreshableField = 'description' | 'workDate' | 'workedMinutes' | 'isUnapprovedTime';

export type TimeLineRefreshOutcome =
  | { lineId: string; status: 'refreshed'; changed: RefreshableField[] }
  | { lineId: string; status: 'unchanged' }
  | { lineId: string; status: 'skipped'; reason: RefreshSkipReason }
  | { lineId: string; status: 'quantityDrifted'; lineQuantity: string; entryQuantity: string };

export type TimeLineRefreshSet = Partial<{
  description: string; workDate: string | null; workedMinutes: number | null; isUnapprovedTime: boolean;
}>;

export interface TimeLineRefreshPlan {
  outcome: TimeLineRefreshOutcome;
  /** Columns to write; undefined when nothing may or need change. */
  set?: TimeLineRefreshSet;
}

function skip(lineId: string, reason: RefreshSkipReason): TimeLineRefreshPlan {
  return { outcome: { lineId, status: 'skipped', reason } };
}

/** Only `not_billed` is refreshable (the only state assembly gathers). Every
 *  other status maps to its own reason; the default keeps a future enum value
 *  from slipping through as refreshable. */
function statusSkipReason(status: BillingStatus): RefreshSkipReason | null {
  switch (status) {
    case 'not_billed': return null;
    case 'billed': return 'billed_elsewhere';
    case 'contract': return 'contract';
    case 'no_charge': return 'no_charge';
    case 'awaiting_approval': return 'awaiting_approval';
    default: return 'not_billable';
  }
}

function skipReason(entry: RefreshEntry, ctx: RefreshContext): RefreshSkipReason | null {
  const byStatus = statusSkipReason(entry.billingStatus);
  if (byStatus) return byStatus;
  if (entry.orgId !== ctx.orgId) return 'other_org';
  if (!entry.isBillable) return 'not_billable';
  if (entry.endedAt === null) return 'not_ended';
  if (ctx.isHeld(entry.endedAt)) return 'held_for_hour_block';
  if (entry.currencyCode !== ctx.currencyCode) return 'currency_mismatch';
  if (entry.hourlyRate == null) return 'missing_rate';
  return null;
}

export function planTimeLineRefresh(
  line: RefreshLine, entry: RefreshEntry | undefined, ctx: RefreshContext,
): TimeLineRefreshPlan {
  if (!line.sourceId || !entry || entry.id !== line.sourceId) return skip(line.id, 'source_missing');
  const reason = skipReason(entry, ctx);
  if (reason) return skip(line.id, reason);

  const spec = timeEntryToLineSpec(entry, ctx.currencyCode, ctx.timeZone);
  if (spec.quantity !== line.quantity) {
    return { outcome: { lineId: line.id, status: 'quantityDrifted', lineQuantity: line.quantity, entryQuantity: spec.quantity } };
  }

  const set: TimeLineRefreshSet = {};
  const changed: RefreshableField[] = [];
  if (!line.descriptionEdited && spec.description !== line.description) {
    set.description = spec.description; changed.push('description');
  }
  if (spec.workDate !== line.workDate) { set.workDate = spec.workDate; changed.push('workDate'); }
  if (spec.workedMinutes !== line.workedMinutes) { set.workedMinutes = spec.workedMinutes; changed.push('workedMinutes'); }
  if (spec.isUnapprovedTime !== line.isUnapprovedTime) { set.isUnapprovedTime = spec.isUnapprovedTime; changed.push('isUnapprovedTime'); }

  if (changed.length === 0) return { outcome: { lineId: line.id, status: 'unchanged' } };
  return { outcome: { lineId: line.id, status: 'refreshed', changed }, set };
}

export interface TimeLineRefreshSummary { refreshed: number; unchanged: number; skipped: number; quantityDrifted: number }

export function summarizeRefresh(outcomes: readonly TimeLineRefreshOutcome[]): TimeLineRefreshSummary {
  const s: TimeLineRefreshSummary = { refreshed: 0, unchanged: 0, skipped: 0, quantityDrifted: 0 };
  for (const o of outcomes) s[o.status] += 1;
  return s;
}
