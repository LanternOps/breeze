import type { SlaDto } from '@breeze/shared';
import type { tickets } from '../../db/schema';
import {
  resolveSlaTargets,
  SLA_AT_RISK_RATIO,
} from '../ticketSla';

type TicketSlaRow = Pick<
  typeof tickets.$inferSelect,
  | 'priority'
  | 'status'
  | 'createdAt'
  | 'firstResponseAt'
  | 'resolvedAt'
  | 'responseSlaMinutes'
  | 'resolutionSlaMinutes'
  | 'slaBreachedAt'
  | 'slaPausedAt'
  | 'slaPausedMinutes'
>;

const minutes = (from: Date, to: Date) =>
  Math.max(0, (to.getTime() - from.getTime()) / 60_000);

export function ticketSla(row: TicketSlaRow, now: Date): SlaDto {
  const targets = resolveSlaTargets({
    overrideResponseMinutes: row.responseSlaMinutes,
    overrideResolutionMinutes: row.resolutionSlaMinutes,
    priority: row.priority,
  });
  const firstResponseMinutes = row.firstResponseAt
    ? minutes(row.createdAt, row.firstResponseAt)
    : null;
  const resolutionMinutes = row.resolvedAt
    ? Math.max(
        0,
        minutes(row.createdAt, row.resolvedAt) -
          (row.slaPausedMinutes ?? 0),
      )
    : null;

  const configured =
    targets.responseMinutes !== null ||
    targets.resolutionMinutes !== null;
  let status: SlaDto['status'];

  // Match the MSP list's SQL twins in routes/tickets/tickets.ts:61-85.
  // A stamped breach wins; elapsed time alone never invents one.
  if (row.slaBreachedAt) status = 'breached';
  else if (!configured) status = 'not_configured';
  else if (
    row.status === 'resolved' ||
    row.status === 'closed' ||
    row.resolvedAt
  ) status = 'met';
  else {
    const unmet = [
      row.firstResponseAt ? null : targets.responseMinutes,
      targets.resolutionMinutes,
    ].filter((value): value is number => value !== null);

    if (unmet.length === 0) status = 'met';
    else if (
      row.status === 'pending' ||
      row.status === 'on_hold' ||
      row.slaPausedAt
    ) status = 'paused';
    else {
      const activeElapsed =
        minutes(row.createdAt, now) - (row.slaPausedMinutes ?? 0);
      const target = Math.min(...unmet);
      status = activeElapsed >= target * SLA_AT_RISK_RATIO
        ? 'at_risk'
        : 'on_track';
    }
  }

  return {
    firstResponseMinutes,
    resolutionMinutes,
    responseTargetMinutes: targets.responseMinutes,
    resolutionTargetMinutes: targets.resolutionMinutes,
    status,
  };
}
