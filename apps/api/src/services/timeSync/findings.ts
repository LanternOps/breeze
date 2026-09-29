import {
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_FINDING_SEVERITY,
  TIME_SYNC_EVENT_ACTIVE_WINDOW_MS,
  TIME_SYNC_DEFAULT_POLL_SECONDS,
  parseNtpServerHosts,
  isValidNtpServerHost,
  type TimeStatusSnapshot,
  type TimeSyncFindingCode,
  type TimeSyncFindingSeverity,
  type TimeSyncHealth,
  type TimeSyncStatusMethod,
} from '@breeze/shared';
import type { ExpectedTimezone } from './expectedTimezone';
export type EventMarks = Record<string, string>;
export interface TimeSyncFinding {
  code: TimeSyncFindingCode;
  severity: TimeSyncFindingSeverity;
  detail: Record<string, string | number | null>;
}
export interface TimeFindingsContext {
  now: Date;
  expectedTimezone: ExpectedTimezone | null;
  previousEventMarks: EventMarks;
  enforcementSettings?: {
    enforceNtp: boolean;
    timezoneAutoFix: boolean;
  } | null;
}
export interface TimeFindingsResult {
  health: TimeSyncHealth;
  findings: TimeSyncFinding[];
  eventMarks: EventMarks;
}
export function healthForFindings(
  findings: TimeSyncFinding[],
  method: TimeSyncStatusMethod,
): TimeSyncHealth {
  if (findings.some((f) => f.severity === 'critical')) return 'critical';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  return method === 'unavailable' && findings.length === 0
    ? 'unknown'
    : 'healthy';
}
export function resolveTimeFindings(
  snapshot: TimeStatusSnapshot,
  ctx: TimeFindingsContext,
): TimeFindingsResult {
  const { config, status, domain, timezone, events } = snapshot;
  const marks: EventMarks = { ...ctx.previousEventMarks };
  const time = (value: string | null | undefined) =>
    value ? Date.parse(value) : -Infinity;
  for (const event of events) {
    const key = String(event.eventId);
    if (time(event.occurredAt) > time(marks[key]))
      marks[key] = event.occurredAt;
  }
  for (const [key, mark] of Object.entries(marks)) {
    if (!Number.isFinite(time(mark)) || +ctx.now - time(mark) > 7 * 86_400_000)
      delete marks[key];
  }
  const success = Math.max(
    time(marks['35']),
    time(marks['37']),
    time(status.lastSuccessfulSyncAt),
  );
  const active = (id: number) =>
    +ctx.now - time(marks[String(id)]) <= TIME_SYNC_EVENT_ACTIVE_WINDOW_MS &&
    time(marks[String(id)]) > success;
  const property = (ids: number[]) =>
    events
      .filter((e) => ids.includes(e.eventId) && active(e.eventId))
      .sort((a, b) => time(b.occurredAt) - time(a.occurredAt))[0]
      ?.properties[0] ?? null;
  const found = new Map<TimeSyncFindingCode, TimeSyncFinding>();
  const add = (
    code: TimeSyncFindingCode,
    detail: TimeSyncFinding['detail'],
  ) => {
    found.set(code, {
      code,
      severity: TIME_SYNC_FINDING_SEVERITY[code],
      detail,
    });
  };
  if (
    domain.role === 'forest_root_pdc_emulator' &&
    (config.type === 'NT5DS' || active(12))
  )
    add('pdc_no_external_source', { domainDns: domain.domainDns });
  if (
    status.sourceKind === 'local_clock' ||
    status.sourceKind === 'free_running'
  )
    add('source_local_clock', {
      source: status.source,
      sourceKind: status.sourceKind,
    });
  if (
    ['dc', 'pdc_emulator', 'forest_root_pdc_emulator'].includes(domain.role) &&
    (config.hostTimeProviderEnabled === true || status.sourceKind === 'vm_host')
  )
    add('dc_vm_host_sync', { role: domain.role });
  const badHost =
    config.type === 'NTP' || config.type === 'AllSync'
      ? parseNtpServerHosts(config.ntpServer).find(
          (host) => !isValidNtpServerHost(host),
        )
      : undefined;
  if (badHost !== undefined || active(134))
    add('ntp_server_unresolvable', { host: badHost ?? property([134]) });
  if ([24, 29, 47].some(active))
    add('ntp_peer_unreachable', {
      source: property([24, 29, 47]) ?? status.source,
    });
  if (active(129))
    add('domain_source_unavailable', { domainDns: domain.domainDns });
  if (
    ['member', 'dc', 'pdc_emulator'].includes(domain.role) &&
    config.type !== 'NT5DS' &&
    config.type !== 'AllSync' &&
    !config.policyManaged
  )
    add('member_not_on_hierarchy', { type: config.type });
  const disabled =
    config.type === 'NoSync' || config.serviceStartType === 'disabled';
  if (disabled)
    add('sync_disabled', {
      reason: config.type === 'NoSync' ? 'no_sync' : 'service_disabled',
    });
  const poll =
    status.pollIntervalSeconds ??
    config.specialPollIntervalSeconds ??
    TIME_SYNC_DEFAULT_POLL_SECONDS;
  const threshold = Math.max(3 * poll * 1000, 86_400_000);
  if (
    !disabled &&
    ((status.lastSuccessfulSyncAt !== null &&
      +ctx.now - time(status.lastSuccessfulSyncAt) > threshold) ||
      active(36))
  )
    add('sync_stale', {
      lastSuccessfulSyncAt: status.lastSuccessfulSyncAt,
      thresholdHours: threshold / 3_600_000,
    });
  if (active(52))
    add('correction_refused', { occurredAt: marks['52'] ?? null });
  const expected = ctx.expectedTimezone;
  if (
    expected &&
    timezone.autoUpdate !== 'on' &&
    timezone.windowsId !== expected.windowsId
  )
    add('timezone_mismatch', {
      actual: timezone.windowsId,
      expected: expected.windowsId,
      expectedIana: expected.iana,
      expectedSource: expected.source,
      expectedSourceName: expected.sourceName,
    });
  const findings = TIME_SYNC_FINDING_CODES.flatMap((code) =>
    found.has(code) ? [found.get(code)!] : [],
  );
  return {
    health: healthForFindings(findings, status.method),
    findings,
    eventMarks: marks,
  };
}
