import type { DeviceRole } from '@/lib/deviceRoles';
import { i18n } from '@/lib/i18n';
import { asRecord, toPercent } from '@/lib/deviceUtils';
import type { Device, DeviceStatus, OSType } from './DeviceList';

/** A device row exactly as `GET /devices` returns it (untyped on the wire). */
export type ApiDeviceRow = Record<string, unknown>;
export type DeviceListRow = Device;

// vm_host member role (#2308): unknown values degrade to "ungrouped" (null) by
// design — a wrong nesting would be worse than none — but the degradation must
// be observable, or a future third role silently flattens every affected fleet
// until someone files "VM nesting stopped working". Warn once per value, not
// per row/refetch.
const warnedUnknownLinkGroupRoles = new Set<string>();
function normalizeLinkGroupRole(value: unknown): 'host' | 'guest' | null {
  if (value === 'host' || value === 'guest') return value;
  if (value != null && !warnedUnknownLinkGroupRoles.has(String(value))) {
    warnedUnknownLinkGroupRoles.add(String(value));
    console.warn(`[devices] unknown linkGroupRole ${JSON.stringify(value)} — treating the device as ungrouped`);
  }
  return null;
}

/**
 * Maps a raw `/devices` list row to the shape `DeviceList` renders. Shared by
 * the fleet Devices page and the organization record's Devices tab so both show
 * identical data. `orgName` / `siteName` stay empty: callers resolve them from
 * their own org/site lookups.
 */
export function toDeviceListRow(raw: ApiDeviceRow): DeviceListRow {
  const d = raw;
  const metrics = asRecord(d.metrics);
  const hardware = asRecord(d.hardware);

  return {
    id: d.id as string,
    hostname: (d.hostname ?? i18n.t('devices:devicesPage.unknownDevice')) as string,
    displayName: typeof d.displayName === 'string' ? d.displayName : undefined,
    os: (d.osType ?? d.os ?? 'windows') as OSType,
    osVersion: (d.osVersion ?? '') as string,
    status: (d.status ?? 'offline') as DeviceStatus,
    cpuPercent: toPercent(metrics?.cpuPercent ?? d.cpuPercent ?? hardware?.cpuPercent),
    ramPercent: toPercent(metrics?.ramPercent ?? d.ramPercent ?? hardware?.ramPercent),
    lastSeen: (d.lastSeenAt ?? d.lastSeen ?? '') as string,
    orgId: (d.orgId ?? '') as string,
    orgName: '', // Will be resolved from orgs
    siteId: (d.siteId ?? '') as string,
    siteName: '', // Will be resolved from sites
    agentVersion: (d.agentVersion ?? '') as string,
    updateOfferWithheldReason: (d.updateOfferWithheldReason ?? null) as string | null,
    updateAttemptTargetVersion: (d.updateAttemptTargetVersion ?? null) as string | null,
    updateAttemptStartedAt: (d.updateAttemptStartedAt ?? null) as string | null,
    updateAttemptLastAt: (d.updateAttemptLastAt ?? null) as string | null,
    watchdogVersion: (d.watchdogVersion ?? null) as string | null,
    helperVersion: (d.helperVersion ?? null) as string | null,
    helperInstallIssue: (d.helperInstallIssue ?? null) as string | null,
    agentServerUrl: (d.agentServerUrl ?? null) as string | null,
    // Opt-in WAN/LAN IP columns (#2503). Both are string-or-null on the
    // wire; anything else degrades to null so a malformed value renders
    // the dash instead of leaking through the type.
    wanIp: typeof d.wanIp === 'string' ? d.wanIp : null,
    lanIp: typeof d.lanIp === 'string' ? d.lanIp : null,
    tags: (d.tags ?? []) as string[],
    deviceRole: d.deviceRole as DeviceRole | undefined,
    deviceRoleSource: d.deviceRoleSource as string | undefined,
    mainAgentSilentSince: (d.mainAgentSilentSince ?? null) as string | null,
    watchdogStatus: (d.watchdogStatus ?? null) as Device['watchdogStatus'],
    lastUser: d.lastUser as string | undefined,
    uptimeSeconds: typeof d.uptimeSeconds === 'number' ? d.uptimeSeconds : undefined,
    osBuild: d.osBuild as string | undefined,
    architecture: d.architecture as string | undefined,
    isHeadless: typeof d.isHeadless === 'boolean' ? d.isHeadless : undefined,
    pendingReboot: d.pendingReboot === true,
    // RMM-QA-176: the manual maintenance lease end. This transform is an
    // explicit whitelist, so omitting it would silently make every
    // leased device look "not in maintenance" to isInMaintenance while
    // every other test stayed green.
    maintenanceUntil: typeof d.maintenanceUntil === 'string' ? d.maintenanceUntil : null,
    // Collision enrollment (#2764). A non-null uuid means this row may be
    // replacing an earlier device with the same hostname; the list shows
    // a "Possible duplicate" badge and the device page a review banner.
    // Anything non-string degrades to null so a malformed value can never
    // light the badge.
    possibleReplacementOfDeviceId:
      typeof d.possibleReplacementOfDeviceId === 'string'
        ? d.possibleReplacementOfDeviceId
        : null,
    batteryStatus: (d.batteryStatus as Device['batteryStatus']) ?? null,
    activeVpns: (d.activeVpns as Device['activeVpns']) ?? null,
    // Linked multi-boot profiles (#2138): grouping is computed
    // client-side per page in DeviceList from this id alone.
    linkGroupId: typeof d.linkGroupId === 'string' ? d.linkGroupId : null,
    // vm_host member role (#2308): validated against the known values so
    // an unexpected API value degrades to "ungrouped" instead of leaking
    // (warned once per value — see normalizeLinkGroupRole).
    linkGroupRole: normalizeLinkGroupRole(d.linkGroupRole),
    enrolledAt: d.enrolledAt as string | undefined,
    lastLogAt: (d.lastLogAt ?? null) as string | null,
    desktopAccess: (d.desktopAccess as Device['desktopAccess']) ?? null,
    hardware: hardware ? {
      cpuModel: hardware.cpuModel as string | undefined,
      cpuCores: typeof hardware.cpuCores === 'number' ? hardware.cpuCores : undefined,
      ramTotalMb: typeof hardware.ramTotalMb === 'number' ? hardware.ramTotalMb : undefined,
      diskTotalGb: typeof hardware.diskTotalGb === 'number' ? hardware.diskTotalGb : undefined,
    } : undefined,
    // Reliability column (#1720): score is null until the reliability
    // worker has computed one for the device; the column renders a dash
    // and sorts those rows last. Trend is validated against the known
    // enum rather than blind-cast, so an unexpected API value falls back
    // to null (no glyph) instead of leaking through the type.
    reliabilityProvisional: d.reliabilityProvisional === true,
    reliabilityScore: typeof d.reliabilityScore === 'number' ? d.reliabilityScore : null,
    reliabilityTrend:
      d.reliabilityTrend === 'improving' ||
      d.reliabilityTrend === 'stable' ||
      d.reliabilityTrend === 'degrading'
        ? d.reliabilityTrend
        : null,
    // Hardware & RAID rollup (#6854 W04): null until a report arrives.
    // The API summary is `{counts, controllerNames}`; the web Device
    // field is the flat numeric counts record the column tooltip reads.
    hardwareHealth:
      d.hardwareHealth === 'ok' || d.hardwareHealth === 'warning' ||
      d.hardwareHealth === 'critical' || d.hardwareHealth === 'unknown'
        ? d.hardwareHealth
        : null,
    hardwareHealthSummary: asRecord(d.hardwareHealthSummary)
      ? Object.fromEntries(Object.entries(
          asRecord(asRecord(d.hardwareHealthSummary)?.counts) ?? asRecord(d.hardwareHealthSummary)!,
        ).filter((entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]))) : null,
    // RDS per-session helper mode (Task 12): validated against the known
    // values so an unexpected API value falls back to null rather than
    // leaking through the type — Tasks 13/14 gate the session picker on
    // this being exactly 'on-demand'.
    helperLifecycleMode:
      d.helperLifecycleMode === 'always-on' || d.helperLifecycleMode === 'on-demand'
        ? d.helperLifecycleMode
        : null,
    // Custom field values (#6594) — powers the opt-in custom field
    // columns. Agent rows only; the API's customFields column is
    // already selected in the list query (routes/devices/core.ts).
    customFields: (asRecord(d.customFields) ?? null) as Record<string, unknown> | null,
  };
}
