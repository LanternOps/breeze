// Device-level view of GET /patches/compliance (#9791 C): the device
// percentage, per-status device counts and the paginated device list the
// Patches page renders. Everything here is a pure function over rows the route
// has already loaded for the counted device set, so the list, the counts and
// totalDevices always describe the same population.

export const COMPLIANCE_DEVICE_STATUSES = [
  'all',
  'compliant',
  'needs-patches',
  'failed',
  'critical',
  'reboot',
  'third-party',
] as const;
export type ComplianceDeviceStatus = (typeof COMPLIANCE_DEVICE_STATUSES)[number];

export const COMPLIANCE_DEVICES_DEFAULT_LIMIT = 50;
export const COMPLIANCE_DEVICES_MAX_LIMIT = 200;

/** One counted device, as selected by the route's population query. */
export interface ComplianceDeviceDetail {
  id: string;
  hostname: string | null;
  displayName: string | null;
  osType: string | null;
  lastSeenAt: Date | null;
  status: string | null;
  orgId: string | null;
  pendingReboot: boolean | null;
}

/** The legacy `devicesNeedingPatches` entry (kept byte-compatible). */
export interface NeedingDevice {
  id: string;
  name: string;
  os: string;
  missingCount: number;
  approvedMissing: number;
  unapprovedMissing: number;
  failedMissing: number;
  criticalCount: number;
  importantCount: number;
  osMissing: number;
  thirdPartyMissing: number;
  lastInstalledAt: string | undefined;
  pendingReboot: boolean;
  lastScannedAt: string | undefined;
  lastSeen: string | undefined;
  staleImages?: number;
  unknownImages?: number;
}

/** A device list row; field names match the web's DevicePatchRow. */
export interface ComplianceDeviceRow {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  lastSeenAt: string | null;
  status: string | null;
  /** Load-bearing: the Patches page derives bulk-action confirmation scope from it. */
  orgId: string | null;
  pendingPatches: number;
  approvedMissing: number;
  unapprovedMissing: number;
  failedMissing: number;
  criticalMissing: number;
  importantMissing: number;
  osMissing: number;
  thirdPartyMissing: number;
  staleImages: number;
  pendingReboot: boolean;
  lastInstalledAt: string | null;
  lastScannedAt: string | null;
  compliant: boolean;
}

export interface ComplianceDeviceCounts {
  all: number;
  compliant: number;
  needsPatches: number;
  failed: number;
  critical: number;
  reboot: number;
  thirdParty: number;
}

export interface OutstandingTotals {
  patches: number;
  approved: number;
  unapproved: number;
  failed: number;
  critical: number;
}

/** round(compliant / total * 100); an empty fleet is 0, never NaN. */
export function devicePercent(compliantDevices: number, totalDevices: number): number {
  if (totalDevices <= 0) return 0;
  return Math.round((compliantDevices / totalDevices) * 100);
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function compareRows(a: ComplianceDeviceRow, b: ComplianceDeviceRow): number {
  return (
    b.criticalMissing - a.criticalMissing
    || b.pendingPatches - a.pendingPatches
    // A stale-image-only device (0 pending) still needs an update: list it
    // ahead of compliant devices rather than interleaved by id.
    || Number(a.compliant) - Number(b.compliant)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * One row per counted device. A device is compliant exactly when it has no
 * `devicesNeedingPatches` entry, which is how the route derives
 * compliantDevices, so the row set and the summary cannot disagree.
 */
export function buildComplianceDeviceRows(
  details: readonly ComplianceDeviceDetail[],
  needingById: ReadonlyMap<string, NeedingDevice>,
): ComplianceDeviceRow[] {
  const rows = details.map((d): ComplianceDeviceRow => {
    const n = needingById.get(d.id);
    return {
      id: d.id,
      hostname: d.hostname ?? n?.name ?? '',
      displayName: d.displayName?.trim() ? d.displayName : null,
      osType: d.osType ?? n?.os ?? 'unknown',
      lastSeenAt: toIso(d.lastSeenAt),
      status: d.status ?? null,
      orgId: d.orgId ?? null,
      pendingPatches: n?.missingCount ?? 0,
      approvedMissing: n?.approvedMissing ?? 0,
      unapprovedMissing: n?.unapprovedMissing ?? 0,
      failedMissing: n?.failedMissing ?? 0,
      criticalMissing: n?.criticalCount ?? 0,
      importantMissing: n?.importantCount ?? 0,
      osMissing: n?.osMissing ?? 0,
      thirdPartyMissing: n?.thirdPartyMissing ?? 0,
      staleImages: n?.staleImages ?? 0,
      // The live heartbeat flag (devices.pending_reboot) for every device, so
      // a compliant device that installed patches and awaits a restart shows.
      pendingReboot: Boolean(d.pendingReboot ?? n?.pendingReboot),
      lastInstalledAt: n?.lastInstalledAt ?? null,
      lastScannedAt: n?.lastScannedAt ?? null,
      compliant: n === undefined,
    };
  });
  return rows.sort(compareRows);
}

const STATUS_PREDICATES: Record<ComplianceDeviceStatus, (row: ComplianceDeviceRow) => boolean> = {
  all: () => true,
  compliant: (r) => r.compliant,
  'needs-patches': (r) => !r.compliant,
  failed: (r) => r.failedMissing > 0,
  critical: (r) => r.criticalMissing > 0,
  reboot: (r) => r.pendingReboot,
  'third-party': (r) => r.thirdPartyMissing > 0,
};

export function summarizeComplianceDevices(rows: readonly ComplianceDeviceRow[]): {
  deviceCounts: ComplianceDeviceCounts;
  outstandingTotals: OutstandingTotals;
} {
  const count = (status: ComplianceDeviceStatus) => rows.filter(STATUS_PREDICATES[status]).length;
  const sum = (pick: (r: ComplianceDeviceRow) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
  return {
    deviceCounts: {
      all: rows.length,
      compliant: count('compliant'),
      needsPatches: count('needs-patches'),
      failed: count('failed'),
      critical: count('critical'),
      reboot: count('reboot'),
      thirdParty: count('third-party'),
    },
    outstandingTotals: {
      patches: sum((r) => r.pendingPatches),
      approved: sum((r) => r.approvedMissing),
      unapproved: sum((r) => r.unapprovedMissing),
      failed: sum((r) => r.failedMissing),
      critical: sum((r) => r.criticalMissing),
    },
  };
}

/**
 * Filter by status and (literal, case-insensitive) hostname/display-name
 * search, then slice one page. `total` is the filtered count for the pager;
 * search narrows the list only, never the summary counts.
 */
export function pageComplianceDevices(
  rows: readonly ComplianceDeviceRow[],
  opts: { status: ComplianceDeviceStatus; search?: string; limit: number; offset: number },
): { devices: ComplianceDeviceRow[]; total: number } {
  const needle = opts.search?.trim().toLowerCase() ?? '';
  const matches = rows.filter((r) =>
    STATUS_PREDICATES[opts.status](r)
    && (needle === ''
      || r.hostname.toLowerCase().includes(needle)
      || (r.displayName?.toLowerCase().includes(needle) ?? false)),
  );
  return { devices: matches.slice(opts.offset, opts.offset + opts.limit), total: matches.length };
}

/**
 * The additive device-level fields of the GET /patches/compliance response.
 * `rows` must be every counted device (rows.length === totalDevices).
 */
export function complianceDeviceListFields(
  rows: readonly ComplianceDeviceRow[],
  compliantDevices: number,
  query: { status?: ComplianceDeviceStatus; search?: string; limit?: number; offset?: number },
) {
  const status = query.status ?? 'all';
  const search = query.search ? query.search : null;
  const limit = query.limit ?? COMPLIANCE_DEVICES_DEFAULT_LIMIT;
  const offset = query.offset ?? 0;
  const { deviceCounts, outstandingTotals } = summarizeComplianceDevices(rows);
  const page = pageComplianceDevices(rows, { status, search: search ?? undefined, limit, offset });
  return {
    devicePercent: devicePercent(compliantDevices, rows.length),
    failedDevices: deviceCounts.failed,
    deviceCounts,
    outstandingTotals,
    devices: page.devices,
    devicesPage: { status, search, limit, offset, total: page.total },
  };
}
