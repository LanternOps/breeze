import type { HourBlockHoldWindow } from '../contractHourBlockHolds';

/**
 * Pure classification helpers for the Support usage buckets (block hours W04).
 * Kept out of hourBlockCoverage.ts so unit suites can use them without mocking
 * the DB. The window type is the one ad-hoc invoice assembly uses, so "held
 * from ad-hoc billing" and "shown as covered by the block" cannot drift apart.
 */
export type { HourBlockHoldWindow };

/** One block period, open or closed: [start, end), with the hours past its entitlement. */
export interface BlockPeriodCoverage {
  start: Date;
  end: Date;
  overageMinutes: number;
}

/** True when a not-billed entry that ended at `endedAt` is reserved for a block. */
export function isHeldByBlock(endedAt: Date | null, windows: readonly HourBlockHoldWindow[]): boolean {
  if (endedAt === null) return false;
  const t = endedAt.getTime();
  return windows.some(
    (w) => t >= w.start.getTime() && (w.end === null || t < w.end.getTime()),
  );
}

/**
 * Split block-drawn minutes into covered vs over. Per period the overage is
 * assigned to the LATEST-ended entries first (the hours that went past the
 * block), splitting the boundary entry; everything else is covered. covered +
 * over === minutes for every entry, and a period's over minutes sum to its
 * overage (bounded by the entries visible to the caller). An entry that fits
 * no known period is treated as fully covered: this never invents overage.
 */
export function allocateBlockCoverage(
  entries: ReadonlyArray<{ key: string; endedAt: Date | null; minutes: number }>,
  periods: readonly BlockPeriodCoverage[],
): Map<string, { covered: number; over: number }> {
  const out = new Map<string, { covered: number; over: number }>();
  const groups = new Map<BlockPeriodCoverage, Array<typeof entries[number]>>();

  for (const entry of entries) {
    const t = entry.endedAt?.getTime();
    const period = t === undefined
      ? undefined
      : periods.find((p) => t >= p.start.getTime() && t < p.end.getTime());
    if (!period) {
      out.set(entry.key, { covered: entry.minutes, over: 0 });
      continue;
    }
    groups.set(period, [...(groups.get(period) ?? []), entry]);
  }

  for (const [period, group] of groups) {
    let remaining = Math.max(0, period.overageMinutes);
    const latestFirst = [...group].sort(
      (a, b) => (b.endedAt!.getTime() - a.endedAt!.getTime()) || (a.key < b.key ? 1 : -1),
    );
    for (const entry of latestFirst) {
      const over = Math.min(entry.minutes, remaining);
      remaining -= over;
      out.set(entry.key, { covered: entry.minutes - over, over });
    }
  }
  return out;
}
