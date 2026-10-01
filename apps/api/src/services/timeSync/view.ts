import { and, eq } from 'drizzle-orm';
import {
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_FINDING_SEVERITY,
  TIME_SYNC_UNSET_SITE_TIMEZONES,
  parseNtpServerHosts,
  type TimeSyncHealth,
  type TimeSyncType,
  type TimeSyncServiceState,
  type TimeSyncServiceStartType,
  type TimeSyncStatusMethod,
  type TimeSyncSourceKind,
  type TimeSyncJoinType,
  type TimeSyncDomainRole,
  type TimeSyncAutoUpdate,
  type TimeSyncEnforcementState,
} from '@breeze/shared';
import { db } from '../../db';
import { deviceTimeStatus, devices, sites } from '../../db/schema';
import {
  resolveExpectedTimezone,
  type ExpectedTimezone,
} from './expectedTimezone';
import { healthForFindings, type TimeSyncFinding } from './findings';
import { isTimeStatusStale } from './freshness';
import { resolveDeviceTimeSyncSettings } from './settings';
import { managementFindings, readEnforcement } from './enforcement';
export interface DeviceTimeStatusView {
  deviceId: string;
  state: 'reported' | 'not_reported' | 'unsupported_os';
  stale: boolean;
  receivedAt: string | null;
  collectedAt: string | null;
  health: TimeSyncHealth;
  findings: TimeSyncFinding[];
  config: {
    syncType: TimeSyncType | null;
    ntpServer: string | null;
    ntpServerHosts: string[];
    specialPollIntervalSeconds: number | null;
    policyManaged: boolean;
    policyManagedValues: string[];
    serviceState: TimeSyncServiceState;
    serviceStartType: TimeSyncServiceStartType;
    hostTimeProviderEnabled: boolean | null;
  } | null;
  status: {
    method: TimeSyncStatusMethod;
    source: string | null;
    sourceKind: TimeSyncSourceKind;
    lastSuccessfulSyncAt: string | null;
    lastSyncError: string | null;
    stratum: number | null;
    pollIntervalSeconds: number | null;
  } | null;
  domain: {
    joinType: TimeSyncJoinType;
    role: TimeSyncDomainRole;
    domainDns: string | null;
    forestDns: string | null;
    pdcName: string | null;
  } | null;
  timezone: {
    windowsId: string | null;
    biasMinutes: number | null;
    autoUpdate: TimeSyncAutoUpdate;
    expected: ExpectedTimezone | null;
    expectedUnsetReason: 'site_utc_default' | 'no_site' | 'unmapped' | null;
  } | null;
  recentEvents: Array<{
    recordId: number;
    eventId: number;
    level: number;
    occurredAt: string;
    message: string;
  }>;
  enforcement: TimeSyncEnforcementState | null;
}
export async function getDeviceTimeStatusView(
  deviceId: string,
): Promise<DeviceTimeStatusView | null> {
  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      osType: devices.osType,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return null;
  const [row] = await db
    .select()
    .from(deviceTimeStatus)
    .where(
      and(
        eq(deviceTimeStatus.deviceId, deviceId),
        eq(deviceTimeStatus.orgId, device.orgId),
      ),
    )
    .limit(1);
  if (!row)
    return {
      deviceId,
      state: device.osType === 'windows' ? 'not_reported' : 'unsupported_os',
      stale: false,
      receivedAt: null,
      collectedAt: null,
      health: 'unknown',
      findings: [],
      config: null,
      status: null,
      domain: null,
      timezone: null,
      recentEvents: [],
      enforcement: null,
    };
  const [site] = await db
    .select({ id: sites.id, name: sites.name, timezone: sites.timezone })
    .from(sites)
    .where(and(eq(sites.id, device.siteId), eq(sites.orgId, device.orgId)))
    .limit(1);
  // Policy-dependent findings are recomputed from live policy on every read,
  // so a pin change or a disabled enforcement takes effect without a snapshot.
  const resolvedTimeSettings = await resolveDeviceTimeSyncSettings(deviceId);
  const expected = resolveExpectedTimezone({
    site: site ?? null,
    policy: resolvedTimeSettings.policy,
  });
  const enforcement = readEnforcement(row.enforcement);
  const findings: TimeSyncFinding[] = TIME_SYNC_FINDING_CODES.filter(
    (code) =>
      code !== 'timezone_mismatch' &&
      code !== 'policy_not_applied' &&
      code !== 'policy_conflict_gpo' &&
      row.findings.includes(code),
  ).map((code) => ({
    code,
    severity: TIME_SYNC_FINDING_SEVERITY[code],
    detail: row.findingDetails[code] ?? {},
  }));
  findings.push(
    ...managementFindings(enforcement, row.policyManagedValues, {
      enforceNtp: resolvedTimeSettings.settings.enforceNtp,
      timezoneAutoFix: resolvedTimeSettings.settings.timezone.autoFix,
    }),
  );
  if (
    expected &&
    row.timezoneAutoUpdate !== 'on' &&
    row.timezoneWindowsId !== expected.windowsId
  )
    findings.push({
      code: 'timezone_mismatch',
      severity: 'info',
      detail: {
        actual: row.timezoneWindowsId,
        expected: expected.windowsId,
        expectedIana: expected.iana,
        expectedSource: expected.source,
        expectedSourceName: expected.sourceName,
      },
    });
  findings.sort(
    (a, b) =>
      TIME_SYNC_FINDING_CODES.indexOf(a.code) -
      TIME_SYNC_FINDING_CODES.indexOf(b.code),
  );
  return {
    deviceId,
    state: 'reported',
    stale: isTimeStatusStale(row.receivedAt, new Date()),
    receivedAt: row.receivedAt.toISOString(),
    collectedAt: row.collectedAt.toISOString(),
    health: healthForFindings(findings, row.statusMethod),
    findings,
    config: {
      syncType: row.syncType,
      ntpServer: row.ntpServer,
      ntpServerHosts: parseNtpServerHosts(row.ntpServer),
      specialPollIntervalSeconds: row.specialPollIntervalSeconds,
      policyManaged: row.policyManaged,
      policyManagedValues: row.policyManagedValues,
      serviceState: row.serviceState,
      serviceStartType: row.serviceStartType,
      hostTimeProviderEnabled: row.hostTimeProviderEnabled,
    },
    status: {
      method: row.statusMethod,
      source: row.source,
      sourceKind: row.sourceKind,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastSyncError: row.lastSyncError,
      stratum: row.stratum,
      pollIntervalSeconds: row.pollIntervalSeconds,
    },
    domain: {
      joinType: row.joinType,
      role: row.domainRole,
      domainDns: row.domainDns,
      forestDns: row.forestDns,
      pdcName: row.pdcName,
    },
    timezone: {
      windowsId: row.timezoneWindowsId,
      biasMinutes: row.timezoneBiasMinutes,
      autoUpdate: row.timezoneAutoUpdate,
      expected,
      expectedUnsetReason: expected
        ? null
        : !site
          ? 'no_site'
          : (TIME_SYNC_UNSET_SITE_TIMEZONES as readonly string[]).includes(
                site.timezone,
              )
            ? 'site_utc_default'
            : 'unmapped',
    },
    recentEvents: row.recentEvents,
    enforcement,
  };
}
