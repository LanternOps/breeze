import type { PortalApproval } from './api';
import { money } from './money';
import { formatDateTime } from './utils';

/** 150 -> "2 h 30 m", 60 -> "1 h", 45 -> "45 m". */
export function formatMinutes(total: number): string {
  const minutes = Math.max(0, Math.round(total));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

type AskSource = Pick<PortalApproval, 'trigger' | 'ticketNumber' | 'ask'>;

/** One plain sentence saying what the customer is being asked to approve. */
export function approvalAskSentence(a: AskSource): string {
  const ticket = `ticket #${a.ticketNumber}`;
  if (a.trigger === 'after_hours') {
    const { coverageStartsAt, coverageEndsAt } = a.ask;
    const window =
      coverageStartsAt && coverageEndsAt
        ? ` (${formatDateTime(coverageStartsAt)} to ${formatDateTime(coverageEndsAt)})`
        : '';
    return `Approve after-hours work on ${ticket}${window}`;
  }
  const hasMinutes = a.ask.minutes !== null;
  const hasAmount = a.ask.amount !== null;
  const amount = hasAmount ? money(a.ask.amount, a.ask.currencyCode) : '';
  if (hasMinutes && hasAmount) {
    return `Approve up to ${formatMinutes(a.ask.minutes as number)} (${amount}) more on ${ticket}`;
  }
  if (hasMinutes) return `Approve up to ${formatMinutes(a.ask.minutes as number)} more on ${ticket}`;
  if (hasAmount) return `Approve up to ${amount} more on ${ticket}`;
  return `Approve additional work on ${ticket}`;
}

function axis(budget: string | null, used: string | null): string | null {
  if (budget !== null && used !== null) return `Budget ${budget}, used ${used}`;
  if (budget !== null) return `Budget ${budget}`;
  if (used !== null) return `Used ${used}`;
  return null;
}

/** "Budget 10 h, used 9 h 45 m"; axes the snapshot does not carry are omitted. */
export function approvalSnapshotLine(
  snapshot: PortalApproval['snapshot'],
  currencyCode: string | null
): string | null {
  const time = axis(
    snapshot.budgetMinutes === null ? null : formatMinutes(snapshot.budgetMinutes),
    snapshot.consumedMinutes === null ? null : formatMinutes(snapshot.consumedMinutes)
  );
  const amount = axis(
    snapshot.budgetAmount === null ? null : money(snapshot.budgetAmount, currencyCode),
    snapshot.consumedAmount === null ? null : money(snapshot.consumedAmount, currencyCode)
  );
  const parts = [time, amount].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join('; ') : null;
}
