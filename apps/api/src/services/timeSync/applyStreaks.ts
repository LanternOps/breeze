import {
  TIME_SYNC_FINDING_CODES,
  type TimeSyncFindingCode,
} from '@breeze/shared';
export type FindingStreaks = Record<
  TimeSyncFindingCode,
  { present: number; absent: number }
>;
/**
 * Advances per-code observation counters by exactly one accepted snapshot.
 * Called only after sequence acceptance, so duplicates and alert sweeps never
 * move a counter. Every code is always present in the result.
 */
export function applyStreaks(
  previous: Partial<FindingStreaks> | null | undefined,
  findings: readonly TimeSyncFindingCode[],
): FindingStreaks {
  const present = new Set(findings);
  return Object.fromEntries(
    TIME_SYNC_FINDING_CODES.map((code) => [
      code,
      present.has(code)
        ? { present: (previous?.[code]?.present ?? 0) + 1, absent: 0 }
        : { present: 0, absent: (previous?.[code]?.absent ?? 0) + 1 },
    ]),
  ) as FindingStreaks;
}
