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
import { managementFindings } from './enforcement';
export type EventMarks = Record<string, string>;
export interface TimeSyncFinding {
  code: TimeSyncFindingCode;
  severity: TimeSyncFindingSeverity;
  detail: Record<string, string | number | null>;
}
/**
 * Inputs beyond the snapshot. There is deliberately no `now`: every age the
 * resolver measures (event activity window, mark pruning, sync_stale) is taken
 * against `snapshot.collectedAt`, because event `occurredAt`, carried-forward
 * marks and `lastSuccessfulSyncAt` are all stamped by the device's own clock.
 * Comparing them with server time would hide or pin findings on exactly the
 * devices this feature exists for — those with a wrong clock. Server time
 * (`receivedAt`) is used only for freshness (`isTimeStatusStale`).
 */
export interface TimeFindingsContext {
  expectedTimezone: ExpectedTimezone | null;
  previousEventMarks: EventMarks;
  enforcementSettings?: {
    enforceNtp: boolean;
    timezoneAutoFix: boolean;
  } | null;
}
/**
 * A mark stamped later than this after the snapshot's own `collectedAt` cannot
 * have come from the device's current clock: the clock was stepped back since
 * (which is what a correction does). Such marks belong to the old clock domain
 * and are dropped. The slack absorbs events logged during collection.
 */
export const TIME_SYNC_CLOCK_STEP_TOLERANCE_MS = 5 * 60_000;
/**
 * Insertion index of the peer name in each Time-Service failure event (R19,
 * #7487). Event 134's template is `ErrorMessage, RetryMinutes, DomainPeer`
 * (lab-observed), so its `properties[0]` is localized OS error text and must
 * never reach a finding. The provider manifest gives 24 = `DomainPeer,
 * ErrorMessage` and 47 = `ManualPeer, ErrorMessage`. Event 29 carries only
 * `RetryMinutes`, so it never names a peer.
 */
const PEER_PROPERTY_INDEX: Readonly<Record<number, number>> = {
  24: 0,
  47: 0,
  134: 2,
};
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
  const ref = Date.parse(snapshot.collectedAt);
  const time = (value: string | null | undefined) =>
    value ? Date.parse(value) : -Infinity;
  for (const event of events) {
    const key = String(event.eventId);
    if (time(event.occurredAt) > time(marks[key]))
      marks[key] = event.occurredAt;
  }
  for (const [key, mark] of Object.entries(marks)) {
    const t = time(mark);
    if (
      !Number.isFinite(t) ||
      ref - t > 7 * 86_400_000 ||
      t - ref > TIME_SYNC_CLOCK_STEP_TOLERANCE_MS
    )
      delete marks[key];
  }
  const success = Math.max(
    time(marks['35']),
    time(marks['37']),
    time(status.lastSuccessfulSyncAt),
  );
  const active = (id: number) =>
    ref - time(marks[String(id)]) <= TIME_SYNC_EVENT_ACTIVE_WINDOW_MS &&
    time(marks[String(id)]) > success;
  // The newest active event's peer, flag suffix (`,0x9`) stripped. Anything
  // that is not exactly one token (absent, empty, free text) is unknown: null.
  const peer = (ids: number[]) => {
    const newest = events
      .filter((e) => ids.includes(e.eventId) && active(e.eventId))
      .sort((a, b) => time(b.occurredAt) - time(a.occurredAt))[0];
    const index = newest && PEER_PROPERTY_INDEX[newest.eventId];
    if (!newest || index === undefined) return null;
    const hosts = parseNtpServerHosts(newest.properties[index] ?? null);
    return hosts.length === 1 ? hosts[0]! : null;
  };
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
  if (badHost !== undefined || active(134)) {
    const eventHost = peer([134]);
    add('ntp_server_unresolvable', {
      host:
        eventHost !== null && isValidNtpServerHost(eventHost)
          ? eventHost
          : (badHost ?? null),
    });
  }
  if ([24, 29, 47].some(active))
    add('ntp_peer_unreachable', {
      source: peer([24, 47]) ?? status.source ?? null,
    });
  if (active(129))
    add('domain_source_unavailable', { domainDns: domain.domainDns });
  if (
    ['member', 'dc', 'pdc_emulator'].includes(domain.role) &&
    // An unreadable Type (null) is unknown, not a problem.
    config.type !== null &&
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
      ref - time(status.lastSuccessfulSyncAt) > threshold) ||
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
  for (const finding of managementFindings(
    snapshot.enforcement,
    config.policyManagedValues,
    ctx.enforcementSettings,
  )) {
    found.set(finding.code, finding);
  }
  const findings = TIME_SYNC_FINDING_CODES.flatMap((code) =>
    found.has(code) ? [found.get(code)!] : [],
  );
  return {
    health: healthForFindings(findings, status.method),
    findings,
    eventMarks: marks,
  };
}
