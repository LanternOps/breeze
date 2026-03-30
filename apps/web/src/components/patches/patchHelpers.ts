import type { Patch, PatchSeverity, PatchApprovalStatus } from './PatchList';
import type { UpdateRingItem } from './UpdateRingList';

const severityMap: Record<string, PatchSeverity> = {
  critical: 'critical',
  high: 'important',
  important: 'important',
  medium: 'moderate',
  moderate: 'moderate',
  low: 'low',
  info: 'low'
};

const approvalMap: Record<string, PatchApprovalStatus> = {
  approved: 'approved',
  approve: 'approved',
  declined: 'declined',
  decline: 'declined',
  rejected: 'declined',
  reject: 'declined',
  deferred: 'deferred',
  defer: 'deferred',
  pending: 'pending'
};

const osLabels: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
};

function formatSourceLabel(value: unknown): string {
  if (typeof value !== 'string') {
    return value ? String(value) : 'Unknown';
  }
  if (!value.trim()) return 'Unknown';
  return value
    .replace(/_/g, ' ')
    .split(' ')
    .map(part => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function normalizeSeverity(value?: string): PatchSeverity {
  if (!value) return 'low';
  return severityMap[value.toLowerCase()] ?? 'low';
}

function normalizeApprovalStatus(value?: string): PatchApprovalStatus {
  if (!value) return 'pending';
  return approvalMap[value.toLowerCase()] ?? 'pending';
}

function normalizeOs(value?: string): string {
  if (!value) return 'Unknown';
  return osLabels[value.toLowerCase()] ?? value;
}

export function normalizePatch(raw: Record<string, unknown>, index: number): Patch {
  const id = raw.id ?? raw.patchId ?? raw.patch_id ?? `patch-${index}`;
  const title = raw.title ?? raw.name ?? raw.patchTitle ?? 'Untitled patch';
  const source = raw.sourceName ?? raw.source_label ?? raw.source;
  const os = raw.os ?? raw.osType ?? raw.os_type ?? raw.platform;
  const releaseDate = raw.releaseDate ?? raw.releasedAt ?? raw.release_date ?? raw.createdAt ?? '';
  const approvalStatus = raw.approvalStatus ?? raw.approval_status ?? raw.status;

  return {
    id: String(id),
    title: String(title),
    severity: normalizeSeverity(raw.severity ? String(raw.severity) : undefined),
    source: formatSourceLabel(source),
    os: normalizeOs(os ? String(os) : undefined),
    releaseDate: String(releaseDate),
    approvalStatus: normalizeApprovalStatus(approvalStatus ? String(approvalStatus) : undefined),
    description: raw.description ? String(raw.description) : undefined
  };
}

export function normalizeRing(raw: Record<string, unknown>): UpdateRingItem {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? 'Untitled'),
    description: raw.description ? String(raw.description) : null,
    enabled: raw.enabled !== false,
    ringOrder: Number(raw.ringOrder ?? 0),
    deferralDays: Number(raw.deferralDays ?? 0),
    deadlineDays: raw.deadlineDays != null ? Number(raw.deadlineDays) : null,
    gracePeriodHours: Number(raw.gracePeriodHours ?? 4),
    categoryRules: Array.isArray(raw.categoryRules) ? raw.categoryRules as UpdateRingItem['categoryRules'] : [],
    deviceCount: raw.deviceCount != null ? Number(raw.deviceCount) : undefined,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : undefined,
  };
}

export type DevicePatchRow = {
  id: string;
  hostname: string;
  osType: string;
  lastSeenAt?: string;
  pendingPatches: number;
  criticalMissing: number;
  importantMissing: number;
  osMissing: number;
  thirdPartyMissing: number;
  lastInstalledAt?: string;
  lastScannedAt?: string;
  pendingReboot: boolean;
};

export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function lastActivity(installed?: string, scanned?: string): { label: string; tooltip: string } {
  const inst = installed ? new Date(installed).getTime() : 0;
  const scan = scanned ? new Date(scanned).getTime() : 0;
  if (!inst && !scan) return { label: '\u2014', tooltip: 'No activity recorded' };
  if (inst >= scan) {
    const label = formatRelativeTime(installed!);
    return { label: `Installed ${label}`, tooltip: scanned ? `Last scanned ${formatRelativeTime(scanned)}` : 'No scan recorded' };
  }
  const label = formatRelativeTime(scanned!);
  return { label: `Scanned ${label}`, tooltip: installed ? `Last installed ${formatRelativeTime(installed)}` : 'No install recorded' };
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type PatchSeveritySummary = {
  total: number;
  patched: number;
  pending: number;
};

export type DevicePatchNeed = {
  id: string;
  name: string;
  os: string;
  missingCount: number;
  criticalCount: number;
  importantCount: number;
  osMissing: number;
  thirdPartyMissing: number;
  lastInstalledAt?: string;
  lastScannedAt?: string;
  pendingReboot: boolean;
  lastSeen?: string;
};

export type PatchComplianceData = {
  totalDevices: number;
  compliantDevices: number;
  criticalSummary: PatchSeveritySummary;
  importantSummary: PatchSeveritySummary;
  devicesNeedingPatches: DevicePatchNeed[];
};

export function normalizeSummary(raw?: Record<string, unknown>): PatchSeveritySummary {
  if (!raw) {
    return { total: 0, patched: 0, pending: 0 };
  }

  return {
    total: toNumber(raw.total ?? raw.totalCount ?? raw.count),
    patched: toNumber(raw.patched ?? raw.approved ?? raw.installed),
    pending: toNumber(raw.pending ?? raw.awaiting)
  };
}

export function normalizeDeviceNeed(raw: Record<string, unknown>, index: number): DevicePatchNeed {
  const id = raw.id ?? raw.deviceId ?? raw.device_id ?? `device-${index}`;
  const name = raw.name ?? raw.hostname ?? raw.deviceName ?? 'Unknown device';
  const os = raw.os ?? raw.osName ?? raw.osType ?? raw.platform ?? 'Unknown OS';

  return {
    id: String(id),
    name: String(name),
    os: String(os),
    missingCount: toNumber(raw.missingCount ?? raw.missing ?? raw.patchesMissing),
    criticalCount: toNumber(raw.criticalCount ?? raw.critical ?? raw.criticalMissing),
    importantCount: toNumber(raw.importantCount ?? raw.important ?? raw.importantMissing),
    osMissing: toNumber(raw.osMissing ?? raw.os_missing ?? 0),
    thirdPartyMissing: toNumber(raw.thirdPartyMissing ?? raw.third_party_missing ?? 0),
    lastInstalledAt: raw.lastInstalledAt ? String(raw.lastInstalledAt) : raw.last_installed_at ? String(raw.last_installed_at) : undefined,
    lastScannedAt: raw.lastScannedAt ? String(raw.lastScannedAt) : raw.last_scanned_at ? String(raw.last_scanned_at) : undefined,
    pendingReboot: Boolean(raw.pendingReboot ?? raw.pending_reboot ?? false),
    lastSeen: raw.lastSeen ? String(raw.lastSeen) : raw.last_seen ? String(raw.last_seen) : undefined
  };
}

export function normalizeCompliance(raw: Record<string, unknown>): PatchComplianceData {
  const summary = raw.summary && typeof raw.summary === 'object' ? (raw.summary as Record<string, unknown>) : undefined;
  const severitySummary = raw.severitySummary && typeof raw.severitySummary === 'object'
    ? (raw.severitySummary as Record<string, unknown>)
    : undefined;
  const severity = raw.severity && typeof raw.severity === 'object'
    ? (raw.severity as Record<string, unknown>)
    : undefined;
  const totalDevices = toNumber(raw.totalDevices ?? raw.total_devices ?? raw.total ?? summary?.total);
  const compliantDevices = toNumber(raw.compliantDevices ?? raw.compliant_devices ?? raw.compliant ?? summary?.approved);
  const criticalSummary = normalizeSummary(
    (raw.criticalSummary ?? raw.critical_summary ?? severitySummary?.critical ?? severity?.critical) as
      | Record<string, unknown>
      | undefined
  );
  const importantSummary = normalizeSummary(
    (raw.importantSummary ?? raw.important_summary ?? severitySummary?.important ?? severity?.important) as
      | Record<string, unknown>
      | undefined
  );

  const deviceList = raw.devicesNeedingPatches ?? raw.devices_needing_patches ?? raw.devices ?? [];
  const devicesNeedingPatches = Array.isArray(deviceList)
    ? deviceList.map((device: Record<string, unknown>, index: number) => normalizeDeviceNeed(device, index))
    : [];

  return {
    totalDevices,
    compliantDevices,
    criticalSummary,
    importantSummary,
    devicesNeedingPatches
  };
}
