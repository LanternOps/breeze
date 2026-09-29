import { and, eq } from 'drizzle-orm';
import {
  TIME_SYNC_RECENT_EVENTS_MAX,
  type TimeStatusSnapshot,
  type TimeSyncHealth,
} from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { deviceTimeStatus, devices, sites } from '../../db/schema';
import {
  resolveExpectedTimezone,
  type ExpectedTimezone,
} from './expectedTimezone';
import { resolveTimeFindings, type TimeFindingsResult } from './findings';
type StatusRow = typeof deviceTimeStatus.$inferSelect;
export interface IngestTimeStatusResult {
  accepted: boolean;
  reason?: 'stale_sequence';
  health?: TimeSyncHealth;
}
type IngestArgs = {
  deviceId: string;
  orgId: string;
  agentVersion: string | null;
  snapshot: TimeStatusSnapshot;
  receivedAt: Date;
};
export function buildTimeStatusRow(
  args: IngestArgs,
  previous: StatusRow | undefined,
  expected: ExpectedTimezone | null,
  resolved: TimeFindingsResult,
): StatusRow {
  const { snapshot: s, receivedAt } = args;
  const events = new Map<number, StatusRow['recentEvents'][number]>();
  for (const e of [...(previous?.recentEvents ?? []), ...s.events]) {
    const existing = events.get(e.recordId);
    if (
      !existing ||
      Date.parse(e.occurredAt) >= Date.parse(existing.occurredAt)
    )
      events.set(e.recordId, {
        recordId: e.recordId,
        eventId: e.eventId,
        level: e.level,
        occurredAt: e.occurredAt,
        message: e.message,
      });
  }
  return {
    deviceId: args.deviceId,
    orgId: args.orgId,
    lastSequence: s.sequence,
    collectedAt: new Date(s.collectedAt),
    receivedAt,
    agentVersion: args.agentVersion,
    health: resolved.health,
    findings: resolved.findings.map((f) => f.code),
    findingDetails: Object.fromEntries(
      resolved.findings.map((f) => [f.code, f.detail]),
    ),
    findingStreaks: previous?.findingStreaks ?? {},
    syncType: s.config.type,
    ntpServer: s.config.ntpServer,
    specialPollIntervalSeconds: s.config.specialPollIntervalSeconds,
    policyManaged: s.config.policyManaged,
    policyManagedValues: s.config.policyManagedValues,
    serviceState: s.config.serviceState,
    serviceStartType: s.config.serviceStartType,
    hostTimeProviderEnabled: s.config.hostTimeProviderEnabled,
    statusMethod: s.status.method,
    source: s.status.source,
    sourceKind: s.status.sourceKind,
    lastSuccessfulSyncAt: s.status.lastSuccessfulSyncAt
      ? new Date(s.status.lastSuccessfulSyncAt)
      : null,
    lastSyncError: s.status.lastSyncError,
    stratum: s.status.stratum,
    pollIntervalSeconds: s.status.pollIntervalSeconds,
    joinType: s.domain.joinType,
    domainRole: s.domain.role,
    domainDns: s.domain.domainDns,
    forestDns: s.domain.forestDns,
    pdcName: s.domain.pdcName,
    timezoneWindowsId: s.timezone.windowsId,
    timezoneBiasMinutes: s.timezone.biasMinutes,
    timezoneAutoUpdate: s.timezone.autoUpdate,
    expectedTimezone: expected?.iana ?? null,
    expectedTimezoneWindowsId: expected?.windowsId ?? null,
    expectedTimezoneSource: expected
      ? `${expected.source}:${expected.sourceId}`
      : null,
    eventMarks: resolved.eventMarks,
    recentEvents: [...events.values()]
      .sort(
        (a, b) =>
          Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
          b.recordId - a.recordId,
      )
      .slice(0, TIME_SYNC_RECENT_EVENTS_MAX),
    createdAt: previous?.createdAt ?? receivedAt,
    updatedAt: receivedAt,
  };
}
export async function ingestTimeStatusSnapshot(
  args: IngestArgs,
): Promise<IngestTimeStatusResult> {
  return withDbTransaction(async () => {
    // Parent first: serializes the empty-row case and matches device deletion lock order.
    const [owner] = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(eq(devices.id, args.deviceId), eq(devices.orgId, args.orgId)))
      .for('update');
    if (!owner)
      throw new Error('Time status device missing or ownership changed');
    const [previous] = await db
      .select()
      .from(deviceTimeStatus)
      .where(
        and(
          eq(deviceTimeStatus.deviceId, args.deviceId),
          eq(deviceTimeStatus.orgId, args.orgId),
        ),
      )
      .for('update');
    if (
      previous &&
      args.snapshot.sequence <= previous.lastSequence &&
      Date.parse(args.snapshot.collectedAt) <=
        previous.collectedAt.getTime() + 3_600_000
    )
      return { accepted: false, reason: 'stale_sequence' };
    const [site] = await db
      .select({ id: sites.id, name: sites.name, timezone: sites.timezone })
      .from(sites)
      .where(and(eq(sites.id, owner.siteId), eq(sites.orgId, args.orgId)))
      .limit(1);
    const expected = resolveExpectedTimezone({ site: site ?? null });
    const resolved = resolveTimeFindings(args.snapshot, {
      expectedTimezone: expected,
      previousEventMarks: previous?.eventMarks ?? {},
    });
    const row = buildTimeStatusRow(args, previous, expected, resolved);
    await db
      .insert(deviceTimeStatus)
      .values(row)
      .onConflictDoUpdate({ target: deviceTimeStatus.deviceId, set: row });
    return { accepted: true, health: resolved.health };
  });
}
