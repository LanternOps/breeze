import { and, eq } from 'drizzle-orm';
import {
  TIME_SYNC_FINDING_CODES,
  type TimeStatusSnapshot,
  type TimeSyncHealth,
} from '@breeze/shared';
import { db } from '../../db';
import { deviceTimeDaily } from '../../db/schema';
import type { TimeFindingsResult } from './findings';
import type { ExpectedTimezone } from './expectedTimezone';
// R12: daily worst_health order is critical > warning > unknown > healthy, so an
// unreadable observation never turns a mixed day into an unqualified healthy day.
const rank: Record<TimeSyncHealth, number> = {
  healthy: 0,
  unknown: 1,
  warning: 2,
  critical: 3,
};
export interface UpsertDailyInput {
  deviceId: string;
  orgId: string;
  snapshot: TimeStatusSnapshot;
  result: TimeFindingsResult;
  expectedTimezone: ExpectedTimezone | null;
  receivedAt: Date;
}
/**
 * Folds one accepted snapshot into its UTC collected-day evidence row. Runs on
 * the ambient ingest transaction while the device and status rows are locked;
 * it never opens its own transaction or swallows a failure. "Latest" fields
 * come from the latest accepted snapshot in serialized ingest order (R12).
 */
export async function upsertDaily(input: UpsertDailyInput): Promise<void> {
  const { deviceId, orgId, snapshot, result, expectedTimezone, receivedAt } =
    input;
  const day = new Date(snapshot.collectedAt).toISOString().slice(0, 10);
  const [previous] = await db
    .select()
    .from(deviceTimeDaily)
    .where(
      and(eq(deviceTimeDaily.deviceId, deviceId), eq(deviceTimeDaily.day, day)),
    )
    .for('update');
  const codes = new Set([
    ...(previous?.findingCodes ?? []),
    ...result.findings.map((f) => f.code),
  ]);
  const reportedSync = snapshot.status.lastSuccessfulSyncAt
    ? new Date(snapshot.status.lastSuccessfulSyncAt)
    : null;
  const lastSuccessfulSyncAt =
    previous?.lastSuccessfulSyncAt &&
    (!reportedSync || previous.lastSuccessfulSyncAt > reportedSync)
      ? previous.lastSuccessfulSyncAt
      : reportedSync;
  const values = {
    deviceId,
    orgId,
    day,
    worstHealth:
      previous && rank[previous.worstHealth] > rank[result.health]
        ? previous.worstHealth
        : result.health,
    findingCodes: TIME_SYNC_FINDING_CODES.filter((code) => codes.has(code)),
    source: snapshot.status.source,
    sourceKind: snapshot.status.sourceKind,
    syncType: snapshot.config.type,
    lastSuccessfulSyncAt,
    snapshotCount: (previous?.snapshotCount ?? 0) + 1,
    expectedTimezone: expectedTimezone?.iana ?? null,
    timezoneWindowsId: snapshot.timezone.windowsId,
    updatedAt: receivedAt,
  };
  await db
    .insert(deviceTimeDaily)
    .values({ ...values, createdAt: receivedAt })
    .onConflictDoUpdate({
      target: [deviceTimeDaily.deviceId, deviceTimeDaily.day],
      set: values,
    });
}
