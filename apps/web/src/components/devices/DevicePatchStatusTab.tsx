import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  Apple,
  Package,
  ExternalLink,
  Monitor,
  Server,
  Loader2,
  RefreshCw,
  CloudDownload,
  Download,
  type LucideIcon
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import type { OSType } from './DeviceList';
import PatchInstallHistory from '../patches/PatchInstallHistory';
import { widthPercentClass } from '@/lib/utils';
import { runAction, ActionError } from '@/lib/runAction';
import { ConfirmDialog } from '../shared/ConfirmDialog';

type PatchItem = {
  id?: string;
  name?: string;
  title?: string;
  kb?: string;
  kbNumber?: string;
  version?: string;
  externalId?: string;
  packageId?: string;
  description?: string;
  severity?: string;
  status?: string;
  category?: string;
  source?: string;
  releaseDate?: string;
  releasedAt?: string;
  installedAt?: string;
  requiresReboot?: boolean;
  isDownloaded?: boolean;
  approvalStatus?: string;
};

type PatchPayload = {
  compliancePercent?: number;
  compliance?: number;
  lastPatchScanAt?: string | null;
  lastPatchScanStatus?: string | null;
  pending?: PatchItem[];
  pendingPatches?: PatchItem[];
  missing?: PatchItem[];
  missingPatches?: PatchItem[];
  available?: PatchItem[];
  installed?: PatchItem[];
  installedPatches?: PatchItem[];
  applied?: PatchItem[];
  patches?: PatchItem[];
};

type PatchScanResponse = {
  jobId?: string;
  queuedCommandIds?: string[];
  dispatchedCommandIds?: string[];
  pendingCommandIds?: string[];
};

type PatchInstallResponse = {
  commandId?: string;
  commandStatus?: string;
  patchCount?: number;
};

type PatchHistoryResultItem = {
  id?: string;
  installId?: string;
  name?: string;
  title?: string;
  version?: string;
  source?: string;
  externalId?: string;
  packageId?: string;
  status?: string;
  rebootRequired?: boolean;
};

type PatchHistoryEntry = {
  type?: string;
  status?: string;
  completedAt?: string;
  result?: {
    results?: PatchHistoryResultItem[];
  };
};

type PatchHistoryResponse = {
  history?: PatchHistoryEntry[];
};

type DevicePatchStatusTabProps = {
  deviceId: string;
  timezone?: string;
  osType?: OSType;
};

const categoryBadges: Record<string, { label: string; className: string }> = {
  system: { label: 'System', className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
  security: { label: 'Security', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  application: { label: 'App', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  homebrew: { label: 'Homebrew', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  definitions: { label: 'Definitions', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  driver: { label: 'Driver', className: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300' },
  feature: { label: 'Feature', className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300' }
};

const severityBadges: Record<string, { label: string; className: string }> = {
  critical: { label: 'Critical', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  important: { label: 'Important', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  high: { label: 'High', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  moderate: { label: 'Moderate', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  medium: { label: 'Medium', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  low: { label: 'Low', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  unknown: { label: 'Unknown', className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300' }
};

const sourceBadges: Record<string, { label: string; className: string }> = {
  microsoft: { label: 'WU', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  apple: { label: 'Apple', className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300' },
  linux: { label: 'Pkg', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  third_party: { label: '3rd Party', className: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' },
  custom: { label: 'Custom', className: 'bg-slate-100 text-slate-600 dark:bg-slate-900/30 dark:text-slate-400' }
};

type PatchDisplayCopy = {
  nativeIcon: LucideIcon;
  pendingNativeTitle: string;
  pendingNativeEmpty: string;
  pendingNativePrimaryColumn: string;
  pendingThirdPartyTitle: string;
  pendingThirdPartyEmpty: string;
  pendingThirdPartyPrimaryColumn: string;
  pendingThirdPartySecondaryColumn: string;
  installedNativeTitle: string;
  installedNativeEmpty: string;
  installedNativePrimaryColumn: string;
  installedThirdPartyTitle: string;
};

function getPatchDisplayCopy(osType: OSType): PatchDisplayCopy {
  switch (osType) {
    case 'windows':
      return {
        nativeIcon: Monitor,
        pendingNativeTitle: 'Pending Windows Updates',
        pendingNativeEmpty: 'No pending Windows updates.',
        pendingNativePrimaryColumn: 'Update',
        pendingThirdPartyTitle: 'Pending Third-Party Updates',
        pendingThirdPartyEmpty: 'No pending third-party updates.',
        pendingThirdPartyPrimaryColumn: 'Software',
        pendingThirdPartySecondaryColumn: 'Category',
        installedNativeTitle: 'Installed Windows Updates',
        installedNativeEmpty: 'No Windows updates reported.',
        installedNativePrimaryColumn: 'Update',
        installedThirdPartyTitle: 'Installed Third-Party Updates'
      };
    case 'linux':
      return {
        nativeIcon: Server,
        pendingNativeTitle: 'Pending Linux Updates',
        pendingNativeEmpty: 'No pending Linux updates.',
        pendingNativePrimaryColumn: 'Package',
        pendingThirdPartyTitle: 'Pending Third-Party Updates',
        pendingThirdPartyEmpty: 'No pending third-party updates.',
        pendingThirdPartyPrimaryColumn: 'Software',
        pendingThirdPartySecondaryColumn: 'Category',
        installedNativeTitle: 'Recently Installed Linux Updates',
        installedNativeEmpty: 'No recent Linux update installs.',
        installedNativePrimaryColumn: 'Package',
        installedThirdPartyTitle: 'Installed Third-Party Updates'
      };
    case 'macos':
    default:
      return {
        nativeIcon: Apple,
        pendingNativeTitle: 'Pending Apple Updates',
        pendingNativeEmpty: 'No pending Apple updates.',
        pendingNativePrimaryColumn: 'Update',
        pendingThirdPartyTitle: 'Pending Package Updates',
        pendingThirdPartyEmpty: 'No pending package updates.',
        pendingThirdPartyPrimaryColumn: 'Package',
        pendingThirdPartySecondaryColumn: 'Type',
        installedNativeTitle: 'Installed Apple Updates',
        installedNativeEmpty: 'No Apple updates reported.',
        installedNativePrimaryColumn: 'Update',
        installedThirdPartyTitle: 'Installed Third-Party Updates'
      };
  }
}

function getNativePatchSource(osType: OSType): 'microsoft' | 'apple' | 'linux' {
  if (osType === 'windows') return 'microsoft';
  if (osType === 'linux') return 'linux';
  return 'apple';
}

function getNativePatchProviderLabel(osType: OSType): string {
  if (osType === 'windows') return 'Windows';
  if (osType === 'linux') return 'Linux';
  return 'Apple';
}

function readPatchIds(patches: PatchItem[]): string[] {
  const unique = new Set<string>();
  for (const patch of patches) {
    if (typeof patch.id === 'string' && patch.id.length > 0) {
      unique.add(patch.id);
    }
  }
  return [...unique];
}

// The device-patches endpoint sends approvalStatus for current payloads. Any
// explicit non-approved status blocks install controls; an absent value (older
// payloads / tests) is treated as installable.
function isAwaitingApproval(patch: PatchItem): boolean {
  return !isPatchApprovedForInstall(patch);
}

// Only approved pending patches may be sent to the install endpoint. Mixing in
// an unapproved id makes the server reject the whole batch with 409.
function readApprovedPatchIds(patches: PatchItem[]): string[] {
  return readPatchIds(patches.filter(patch => !isAwaitingApproval(patch)));
}

function isPatchApprovedForInstall(patch: PatchItem): boolean {
  // The API sends approvalStatus for current device-patch payloads. Older or
  // test-only payloads without the field are treated as installable to preserve
  // existing behavior.
  return patch.approvalStatus == null || patch.approvalStatus === 'approved';
}

function getApprovalBadge(patch: PatchItem): { label: string; className: string } {
  switch ((patch.approvalStatus ?? 'approved').toLowerCase()) {
    case 'approved':
      return { label: 'Approved', className: 'bg-success/15 text-success border-success/30' };
    case 'declined':
      return { label: 'Declined', className: 'bg-destructive/15 text-destructive border-destructive/30' };
    case 'deferred':
      return { label: 'Deferred', className: 'bg-blue-500/20 text-blue-700 border-blue-500/40' };
    case 'pending':
    default:
      return { label: 'Pending Approval', className: 'bg-warning/15 text-warning border-warning/30' };
  }
}

function getCategoryBadge(patch: PatchItem, osType: OSType) {
  const name = (patch.name || patch.title || '').toLowerCase();
  const category = (patch.category || '').toLowerCase();

  if (category === 'homebrew-cask') {
    return categoryBadges.homebrew;
  }

  if (categoryBadges[category]) {
    return categoryBadges[category];
  }

  if (osType === 'macos') {
    if (name.startsWith('macos') || name.startsWith('mac os')) {
      return categoryBadges.system;
    }
    if (name.includes('security') || name.includes('xprotect') || name.includes('gatekeeper') || name.includes('mrt')) {
      return categoryBadges.security;
    }
  }

  if (osType === 'windows') {
    if (name.includes('security intelligence')) {
      return categoryBadges.definitions;
    }
    if (name.includes('driver')) {
      return categoryBadges.driver;
    }
    if (name.includes('security update') || name.includes('cumulative update')) {
      return categoryBadges.security;
    }
  }

  return null;
}

function isApplePatch(patch: PatchItem) {
  const source = (patch.source || '').toLowerCase();
  const category = (patch.category || '').toLowerCase();
  const name = (patch.name || patch.title || '').toLowerCase();

  if (category === 'homebrew' || category === 'homebrew-cask') {
    return false;
  }

  if (source === 'apple') {
    return true;
  }
  if (source === 'microsoft' || source === 'linux' || source === 'third_party' || source === 'custom') {
    return false;
  }

  return category === 'system' ||
    category === 'security' ||
    category === 'application' ||
    name.startsWith('macos') ||
    name.startsWith('mac os') ||
    name.includes('xprotect') ||
    name.includes('gatekeeper') ||
    name.includes('rosetta');
}

function isWindowsPatch(patch: PatchItem) {
  const source = (patch.source || '').toLowerCase();
  const category = (patch.category || '').toLowerCase();
  const name = (patch.name || patch.title || '').toLowerCase();

  if (source === 'microsoft') {
    return true;
  }
  if (source === 'apple' || source === 'linux' || source === 'third_party' || source === 'custom') {
    return false;
  }

  if (category === 'security' || category === 'definitions' || category === 'driver' || category === 'feature' || category === 'system') {
    return true;
  }

  return name.includes('windows') ||
    name.includes('cumulative update') ||
    name.includes('security intelligence update') ||
    /kb\d{4,8}/i.test(name);
}

function isLinuxPatch(patch: PatchItem) {
  const source = (patch.source || '').toLowerCase();
  const category = (patch.category || '').toLowerCase();

  if (source === 'linux') {
    return true;
  }
  if (source === 'apple' || source === 'microsoft' || source === 'third_party' || source === 'custom') {
    return false;
  }

  return category === 'system' || category === 'security';
}

function isNativePatchForOs(patch: PatchItem, osType: OSType) {
  if (osType === 'windows') return isWindowsPatch(patch);
  if (osType === 'linux') return isLinuxPatch(patch);
  return isApplePatch(patch);
}

function formatDate(value?: string, timezone?: string, fallback = 'Not reported') {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], timezone ? { timeZone: timezone } : undefined);
}

function formatDateTime(value?: string | null, timezone?: string, fallback = 'Never') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    ...(timezone ? { timeZone: timezone } : {}),
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function normalizePatchName(patch: PatchItem) {
  return patch.title || patch.name || patch.kb || patch.kbNumber || 'Unnamed patch';
}

function isInstalledResultStatus(status?: string) {
  const normalized = (status || '').toLowerCase();
  return normalized === 'installed' || normalized === 'success' || normalized === 'completed';
}

function isLinuxInstallResult(patch: PatchHistoryResultItem) {
  const source = (patch.source || '').toLowerCase();
  const installId = (patch.installId || '').toLowerCase();
  const externalId = (patch.externalId || '').toLowerCase();
  const packageId = (patch.packageId || '').toLowerCase();

  return source === 'linux' ||
    installId.startsWith('apt:') ||
    installId.startsWith('yum:') ||
    externalId.startsWith('apt:') ||
    externalId.startsWith('yum:') ||
    packageId.startsWith('apt:') ||
    packageId.startsWith('yum:');
}

function sortPatchItemsByInstalledAtDesc(patches: PatchItem[]): PatchItem[] {
  return [...patches].sort((a, b) => {
    const aTime = a.installedAt ? new Date(a.installedAt).getTime() : 0;
    const bTime = b.installedAt ? new Date(b.installedAt).getTime() : 0;
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });
}

function recentLinuxInstallsFromHistory(history: PatchHistoryEntry[]): PatchItem[] {
  const installs: PatchItem[] = [];
  const seen = new Set<string>();

  for (const entry of history) {
    if ((entry.status || '').toLowerCase() !== 'completed') {
      continue;
    }
    const results = entry.result?.results ?? [];
    for (const patch of results) {
      if (!isInstalledResultStatus(patch.status) || !isLinuxInstallResult(patch)) {
        continue;
      }

      const installed: PatchItem = {
        id: patch.id ?? patch.installId ?? patch.externalId ?? patch.packageId,
        title: patch.title ?? patch.name ?? patch.packageId ?? patch.installId ?? patch.externalId,
        name: patch.name ?? patch.title ?? patch.packageId ?? patch.installId ?? patch.externalId,
        version: patch.version,
        source: 'linux',
        status: 'installed',
        externalId: patch.externalId,
        packageId: patch.packageId,
        category: 'system',
        installedAt: entry.completedAt,
        requiresReboot: patch.rebootRequired,
      };
      const key = [
        installed.id,
        installed.externalId,
        installed.packageId,
        installed.name,
        installed.installedAt,
      ].filter(Boolean).join('|');
      if (!seen.has(key)) {
        seen.add(key);
        installs.push(installed);
      }
    }
  }

  return sortPatchItemsByInstalledAtDesc(installs);
}

function getSeverityBadge(severity?: string) {
  const normalized = (severity || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'unknown') return null;

  if (severityBadges[normalized]) {
    return severityBadges[normalized];
  }

  return {
    label: normalized.charAt(0).toUpperCase() + normalized.slice(1),
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300'
  };
}

function getKbLabel(patch: PatchItem): string | null {
  // Check explicit kbNumber field first (agent sends this)
  const explicitKbNumber = (patch.kbNumber || '').trim();
  if (explicitKbNumber) {
    return explicitKbNumber.toUpperCase().startsWith('KB') ? explicitKbNumber.toUpperCase() : `KB${explicitKbNumber}`;
  }

  const explicitKb = (patch.kb || '').trim();
  if (explicitKb) {
    return explicitKb.toUpperCase().startsWith('KB') ? explicitKb.toUpperCase() : `KB${explicitKb}`;
  }

  // Try to extract from externalId (agent maps kbNumber to externalId)
  const extId = (patch.externalId || '').trim();
  if (extId && /^kb\d{4,8}$/i.test(extId)) {
    return extId.toUpperCase();
  }

  const name = patch.title || patch.name || '';
  const match = name.match(/kb\d{4,8}/i);
  return match ? match[0].toUpperCase() : null;
}

function getSourceBadge(patch: PatchItem): { label: string; className: string } | null {
  const source = (patch.source || '').toLowerCase();
  const category = (patch.category || '').toLowerCase();
  const externalId = (patch.externalId || '').toLowerCase();

  // Detect winget from externalId pattern (e.g. "winget:Publisher.App:1.0")
  if (externalId.startsWith('winget:')) {
    return { label: 'winget', className: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' };
  }

  // Detect chocolatey from externalId
  if (externalId.startsWith('chocolatey:')) {
    return { label: 'choco', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' };
  }

  // Homebrew categories
  if (category === 'homebrew' || category === 'homebrew-cask') {
    return { label: 'brew', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' };
  }

  if (sourceBadges[source]) {
    return sourceBadges[source];
  }

  return null;
}

function getReleaseLabel(patch: PatchItem, timezone?: string): string | null {
  const value = patch.releaseDate || patch.releasedAt;
  if (!value) return null;
  const formatted = formatDate(value, timezone, '');
  return formatted ? `Released ${formatted}` : null;
}

function getInstalledVersionFromDescription(description?: string): string | null {
  if (!description) return null;
  const match = description.match(/^installed:\s*(.+)$/i);
  if (!match || !match[1]) return null;
  return match[1].trim() || null;
}

function getAvailableVersionFromExternalId(externalId?: string): string | null {
  if (!externalId) return null;
  const parts = externalId.split(':');
  if (parts.length < 3) return null;
  const candidate = parts[parts.length - 1]?.trim();
  if (!candidate || candidate === 'latest') return null;
  if (!/[0-9]/.test(candidate)) return null;
  return candidate;
}

function getHomebrewPendingDetails(patch: PatchItem, osType: OSType) {
  if (osType !== 'macos') return null;

  const category = (patch.category || '').toLowerCase();
  const source = (patch.source || '').toLowerCase();
  const installedVersion = getInstalledVersionFromDescription(patch.description);
  const availableVersion = getAvailableVersionFromExternalId(patch.externalId);
  const brewLike = category === 'homebrew' ||
    category === 'homebrew-cask' ||
    source === 'third_party' ||
    !!installedVersion;

  if (!brewLike) return null;

  const packageType = category === 'homebrew-cask'
    ? 'Cask'
    : category === 'homebrew'
      ? 'Formula'
      : 'Homebrew';

  const versionLabel = installedVersion && availableVersion
    ? `Installed ${installedVersion} -> ${availableVersion}`
    : installedVersion
      ? `Installed ${installedVersion}`
      : availableVersion
        ? `Available ${availableVersion}`
        : null;

  return { packageType, versionLabel };
}

function getHomebrewUrl(patch: PatchItem, osType: OSType): string | null {
  const category = (patch.category || '').toLowerCase();
  const source = (patch.source || '').toLowerCase();
  const brewLikeCategory = category === 'homebrew' || category === 'homebrew-cask';
  const brewLikeSource = osType === 'macos' && source === 'third_party';

  if (!brewLikeCategory && !brewLikeSource) {
    return null;
  }

  const name = patch.name || patch.title || '';
  if (!name) return null;

  // Handle tap packages like "mongodb/brew/mongodb-community@7.0"
  // Extract just the package name after the last slash
  const packageName = name.includes('/') ? name.split('/').pop() : name;
  if (!packageName) return null;

  // Remove version suffix like "@7.0" for the URL
  const baseName = packageName.split('@')[0];

  const baseUrl = category === 'homebrew-cask'
    ? 'https://formulae.brew.sh/cask/'
    : 'https://formulae.brew.sh/formula/';

  return `${baseUrl}${baseName}`;
}

// ---------------------------------------------------------------------------
// Poll interval / duration constants for post-install auto-refresh
// macOS softwareupdate installs can take 30+ minutes to download + install,
// and the post-install rescan adds another 60s. The frontend polls for the
// full duration since the backend uses fire-and-forget command queuing.
// ---------------------------------------------------------------------------
const INSTALL_POLL_INTERVAL_MS = 5_000;
const INSTALL_POLL_MAX_DURATION_MS = 1_800_000;
const RECENT_LINUX_INSTALL_DAYS = 7;
const RECENT_LINUX_INSTALL_HISTORY_LIMIT = 100;
const RECENT_LINUX_INSTALL_WINDOW_MS = RECENT_LINUX_INSTALL_DAYS * 24 * 60 * 60 * 1000;

export default function DevicePatchStatusTab({ deviceId, timezone, osType }: DevicePatchStatusTabProps) {
  const [payload, setPayload] = useState<PatchPayload | null>(null);
  const [recentLinuxInstalls, setRecentLinuxInstalls] = useState<PatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [siteTimezone, setSiteTimezone] = useState<string | undefined>(timezone);
  const [controlAction, setControlAction] = useState<
    'install-native' | 'scan-native' | 'scan-third-party' | 'install-third-party' | null
  >(null);
  const [controlNotice, setControlNotice] = useState<{ kind: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Track per-patch install in progress: patchId -> true
  const [installingPatchIds, setInstallingPatchIds] = useState<Set<string>>(new Set());

  // Pending confirmation for the destructive batch-install controls. Installing
  // patches is destructive (queues installs that may reboot the device), so it
  // must be confirmed before firing rather than firing on a single click.
  const [pendingInstall, setPendingInstall] = useState<
    { action: 'install-native' | 'install-third-party'; patchIds: string[]; label: string } | null
  >(null);

  // Track polling state after install
  const [isPolling, setIsPolling] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);
  const priorPendingCountRef = useRef<number>(-1);
  const recentLinuxInstallsRequestRef = useRef(0);

  // Use provided timezone, fetched siteTimezone, or browser default
  const effectiveTimezone = timezone ?? siteTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const normalizedOsType: OSType = osType ?? 'macos';

  const fetchPatchStatus = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/patches`);
      if (!response.ok) throw new Error('Failed to fetch patch status');
      const json = await response.json();
      const data = json?.data ?? json;
      setPayload(data);
      if (json?.timezone || json?.siteTimezone) {
        setSiteTimezone(json.timezone ?? json.siteTimezone);
      }
      return data as PatchPayload;
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : 'Failed to fetch patch status');
      }
      return null;
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [deviceId]);

  useEffect(() => {
    fetchPatchStatus();
  }, [fetchPatchStatus]);

  const fetchRecentLinuxInstalls = useCallback(async (clear = false) => {
    if (normalizedOsType !== 'linux') {
      recentLinuxInstallsRequestRef.current += 1;
      setRecentLinuxInstalls([]);
      return [];
    }

    const requestId = recentLinuxInstallsRequestRef.current + 1;
    recentLinuxInstallsRequestRef.current = requestId;

    if (clear) {
      setRecentLinuxInstalls([]);
    }

    try {
      const completedAfter = new Date(Date.now() - RECENT_LINUX_INSTALL_WINDOW_MS).toISOString();
      const params = new URLSearchParams({
        limit: String(RECENT_LINUX_INSTALL_HISTORY_LIMIT),
        offset: '0',
        type: 'install',
        status: 'completed',
        completedAfter,
      });
      const response = await fetchWithAuth(`/devices/${deviceId}/patches/history?${params.toString()}`);
      if (!response.ok) {
        if (recentLinuxInstallsRequestRef.current === requestId) {
          setRecentLinuxInstalls([]);
        }
        return [];
      }
      const json = await response.json() as PatchHistoryResponse;
      const installs = recentLinuxInstallsFromHistory(json.history ?? []);
      if (recentLinuxInstallsRequestRef.current === requestId) {
        setRecentLinuxInstalls(installs);
      }
      return installs;
    } catch {
      if (recentLinuxInstallsRequestRef.current === requestId) {
        setRecentLinuxInstalls([]);
      }
      return [];
    }
  }, [deviceId, normalizedOsType]);

  useEffect(() => {
    void fetchRecentLinuxInstalls(true);
  }, [fetchRecentLinuxInstalls]);

  const refreshPatchView = useCallback(async (silent = false) => {
    const data = await fetchPatchStatus(silent);
    await fetchRecentLinuxInstalls(false);
    return data;
  }, [fetchPatchStatus, fetchRecentLinuxInstalls]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const displayCopy = useMemo(() => getPatchDisplayCopy(normalizedOsType), [normalizedOsType]);
  const NativeIcon = displayCopy.nativeIcon;
  const nativeSource = useMemo(() => getNativePatchSource(normalizedOsType), [normalizedOsType]);
  const nativeProviderLabel = useMemo(() => getNativePatchProviderLabel(normalizedOsType), [normalizedOsType]);

  const { pendingNative, pendingOther, installedNative, installedThirdParty, compliancePercent } = useMemo(() => {
    const data = payload ?? {};
    const pendingList = data.pending ?? data.pendingPatches ?? data.available ?? [];
    const installedList = data.installed ?? data.installedPatches ?? data.applied ?? [];
    const patches = data.patches ?? [];

    const inferredPending = pendingList.length > 0
      ? pendingList
      : patches.filter(patch => (patch.status || '').toLowerCase() === 'pending' || (patch.status || '').toLowerCase() === 'available');
    const inferredInstalled = installedList.length > 0
      ? installedList
      : patches.filter(patch => (patch.status || '').toLowerCase() === 'installed');

    const nativePending = inferredPending.filter(patch => isNativePatchForOs(patch, normalizedOsType));
    const otherPending = inferredPending.filter(patch => !isNativePatchForOs(patch, normalizedOsType));

    const effectiveInstalled = normalizedOsType === 'linux'
      ? inferredInstalled.filter(patch => !isLinuxPatch(patch))
      : inferredInstalled;
    const nativeInstalled = normalizedOsType === 'linux'
      ? []
      : effectiveInstalled.filter(patch => isNativePatchForOs(patch, normalizedOsType));
    const thirdPartyInstalled = effectiveInstalled.filter(patch => !isNativePatchForOs(patch, normalizedOsType));

    const total = inferredPending.length + effectiveInstalled.length;
    const computedCompliance = total > 0 ? Math.round((effectiveInstalled.length / total) * 100) : 100;
    const compliance = normalizedOsType === 'linux'
      ? computedCompliance
      : data.compliancePercent ?? data.compliance ?? computedCompliance;

    return {
      pendingNative: nativePending,
      pendingOther: otherPending,
      installedNative: nativeInstalled,
      installedThirdParty: thirdPartyInstalled,
      compliancePercent: compliance
    };
  }, [payload, normalizedOsType]);

  // Only approved pending patches are eligible for the batch install buttons;
  // sending an unapproved id would make the server 409 the entire batch.
  const nativePendingIds = useMemo(() => readApprovedPatchIds(pendingNative), [pendingNative]);
  const thirdPartyPendingIds = useMemo(() => readApprovedPatchIds(pendingOther), [pendingOther]);
  const nativeAwaitingApproval = useMemo(() => pendingNative.filter(isAwaitingApproval).length, [pendingNative]);
  const thirdPartyAwaitingApproval = useMemo(() => pendingOther.filter(isAwaitingApproval).length, [pendingOther]);
  const displayedInstalledNative = normalizedOsType === 'linux' ? recentLinuxInstalls : installedNative;
  const lastPatchScanLabel = formatDateTime(payload?.lastPatchScanAt, effectiveTimezone);
  const lastPatchScanStatus = payload?.lastPatchScanStatus
    ? payload.lastPatchScanStatus.charAt(0).toUpperCase() + payload.lastPatchScanStatus.slice(1)
    : null;

  // -------------------------------------------------------------------------
  // Post-install polling: poll every 5s for up to 90s watching pending count
  // -------------------------------------------------------------------------
  const startInstallPolling = useCallback((initialPendingCount: number) => {
    // Stop any existing poll
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    priorPendingCountRef.current = initialPendingCount;
    pollStartRef.current = Date.now();
    setIsPolling(true);
    setControlNotice({ kind: 'info', message: 'Installing patches... Polling for updates.' });

    pollTimerRef.current = setInterval(async () => {
      const elapsed = Date.now() - pollStartRef.current;
      if (elapsed >= INSTALL_POLL_MAX_DURATION_MS) {
        // Timeout -- stop polling
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setIsPolling(false);
        setInstallingPatchIds(new Set());
        setControlNotice({ kind: 'info', message: 'Install is taking longer than expected. macOS updates can take 30+ minutes. Refresh the page later to check status.' });
        await refreshPatchView(true);
        return;
      }

      const freshData = await fetchPatchStatus(true);
      if (!freshData) return;

      const freshPending = freshData.pending ?? freshData.pendingPatches ?? freshData.available ?? [];
      const currentPendingCount = freshPending.length;

      if (currentPendingCount < priorPendingCountRef.current) {
        // Pending count went down -- install completed (at least partially)
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setIsPolling(false);
        setInstallingPatchIds(new Set());
        const installed = priorPendingCountRef.current - currentPendingCount;
        await fetchRecentLinuxInstalls(false);
        setControlNotice({
          kind: 'success',
          message: `${installed} patch${installed !== 1 ? 'es' : ''} installed successfully. ${currentPendingCount} still pending.`
        });
      }
    }, INSTALL_POLL_INTERVAL_MS);
  }, [fetchPatchStatus, fetchRecentLinuxInstalls, refreshPatchView]);

  const queuePatchScan = useCallback(async (
    action: 'scan-native' | 'scan-third-party',
    source: string,
    label: string
  ) => {
    setControlAction(action);
    setControlNotice(null);
    try {
      // runAction gives the toast feedback (and HTTP-200 {success:false}
      // handling); we keep the detailed inline notice with the queued/dispatched
      // breakdown the toast can't carry.
      const body = await runAction<PatchScanResponse & { error?: string }>({
        request: () =>
          fetchWithAuth('/patches/scan', {
            method: 'POST',
            body: JSON.stringify({ deviceIds: [deviceId], source }),
          }),
        errorFallback: `Failed to queue ${label.toLowerCase()}`,
        successMessage: `${label} queued`,
      });

      const queuedCount = Array.isArray(body.queuedCommandIds) ? body.queuedCommandIds.length : 0;
      const dispatchedCount = Array.isArray(body.dispatchedCommandIds) ? body.dispatchedCommandIds.length : 0;
      const jobSuffix = body.jobId ? ` (job ${body.jobId})` : '';
      const commandSuffix = queuedCount > 0 ? ` - ${queuedCount} command queued` : '';
      const dispatchSuffix = dispatchedCount > 0 ? ` - ${dispatchedCount} dispatched now` : '';
      setControlNotice({
        kind: 'success',
        message: `${label} queued${commandSuffix}${dispatchSuffix}${jobSuffix}.`
      });
    } catch (err) {
      // runAction already toasted the failure; mirror it inline. (No 401 redirect
      // wired here — the device page resolves auth before mounting this tab.)
      setControlNotice({
        kind: 'error',
        message: err instanceof ActionError ? err.message : err instanceof Error ? err.message : `Failed to queue ${label.toLowerCase()}`
      });
    } finally {
      setControlAction(null);
    }
  }, [deviceId]);

  const queuePatchInstall = useCallback(async (
    action: 'install-native' | 'install-third-party',
    patchIds: string[],
    label: string
  ) => {
    if (patchIds.length === 0) {
      setControlNotice({
        kind: 'error',
        message: `No pending patches available for ${label.toLowerCase()}.`
      });
      return;
    }

    const currentPendingCount = pendingNative.length + pendingOther.length;
    setControlAction(action);
    setControlNotice(null);
    try {
      const body = await runAction<PatchInstallResponse & {
        error?: string;
        unapprovedPatchIds?: string[];
        missingPatchIds?: string[];
      }>({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}/patches/install`, {
            method: 'POST',
            body: JSON.stringify({ patchIds }),
          }),
        errorFallback: `Failed to queue ${label.toLowerCase()}`,
        successMessage: `${label} queued`,
      });

      const commandSuffix = body.commandId ? ` (command ${body.commandId})` : '';
      const patchCount = typeof body.patchCount === 'number' ? body.patchCount : patchIds.length;
      const dispatchSuffix = body.commandStatus === 'sent' ? ' and dispatched now' : '';
      setControlNotice({
        kind: 'success',
        message: `${label} queued for ${patchCount} patches${commandSuffix}${dispatchSuffix}.`
      });

      // Start polling for completion
      startInstallPolling(currentPendingCount);
    } catch (err) {
      // runAction already toasted; the 409 "pending approval" detail in the JSON
      // body can't ride the toast, so add it to the inline notice when present.
      let message = err instanceof ActionError ? err.message : err instanceof Error ? err.message : `Failed to queue ${label.toLowerCase()}`;
      if (err instanceof ActionError && err.status === 409 && !/pending approval/i.test(message)) {
        message += ' (some patches may still be pending approval - approve them first or refresh)';
      }
      setControlNotice({ kind: 'error', message });
    } finally {
      setControlAction(null);
    }
  }, [deviceId, pendingNative.length, pendingOther.length, startInstallPolling]);

  // The batch-install buttons request confirmation first; the ConfirmDialog's
  // onConfirm runs the queuePatchInstall above. Destructive action ⇒ never fire
  // on a single click.
  const requestInstall = useCallback((
    action: 'install-native' | 'install-third-party',
    patchIds: string[],
    label: string
  ) => {
    if (patchIds.length === 0) {
      setControlNotice({ kind: 'error', message: `No pending patches available for ${label.toLowerCase()}.` });
      return;
    }
    setPendingInstall({ action, patchIds, label });
  }, []);

  // Single-patch install handler
  const queueSinglePatchInstall = useCallback(async (patchId: string, patchName: string) => {
    if (!patchId) return;

    const currentPendingCount = pendingNative.length + pendingOther.length;
    setInstallingPatchIds(prev => new Set(prev).add(patchId));
    setControlNotice(null);
    try {
      const body = await runAction<PatchInstallResponse & { error?: string }>({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}/patches/install`, {
            method: 'POST',
            body: JSON.stringify({ patchIds: [patchId] }),
          }),
        errorFallback: `Failed to install ${patchName}`,
        successMessage: `Install queued for "${patchName}"`,
      });

      const dispatchSuffix = body.commandStatus === 'sent' ? ' and dispatched' : '';
      setControlNotice({
        kind: 'success',
        message: `Install queued for "${patchName}"${dispatchSuffix}.`
      });

      // Start polling for completion
      startInstallPolling(currentPendingCount);
    } catch (err) {
      setInstallingPatchIds(prev => {
        const next = new Set(prev);
        next.delete(patchId);
        return next;
      });
      // runAction already toasted; mirror inline.
      setControlNotice({
        kind: 'error',
        message: err instanceof ActionError ? err.message : err instanceof Error ? err.message : `Failed to install ${patchName}`
      });
    }
  }, [deviceId, pendingNative.length, pendingOther.length, startInstallPolling]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading patch status...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => refreshPatchView()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  const isBusy = controlAction !== null || isPolling;

  return (
    <div className="space-y-6">
      {/* ================================================================ */}
      {/* Patch Controls                                                   */}
      {/* ================================================================ */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Patch Controls</h3>
            <p className="text-sm text-muted-foreground">
              Queue scans and installs for this device
              <span className="mx-2 hidden sm:inline">|</span>
              <span className="block sm:inline">
                Last scan: {lastPatchScanLabel}
                {lastPatchScanStatus && <span> ({lastPatchScanStatus})</span>}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => refreshPatchView()}
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isPolling ? 'animate-spin' : ''}`} />
            {isPolling ? 'Polling...' : 'Refresh patch data'}
          </button>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => requestInstall('install-native', nativePendingIds, `Install pending ${nativeProviderLabel} patches`)}
            disabled={isBusy || nativePendingIds.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {controlAction === 'install-native' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4 text-green-500" />}
            Install pending OS patches ({nativePendingIds.length})
            {nativeAwaitingApproval > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                ({nativeAwaitingApproval} pending approval)
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => queuePatchScan('scan-native', nativeSource, `Run ${nativeProviderLabel} patch scan`)}
            disabled={isBusy}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {controlAction === 'scan-native' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
            Run OS patch scan
          </button>

          <button
            type="button"
            onClick={() => queuePatchScan('scan-third-party', 'third_party', 'Run third-party patch scan')}
            disabled={isBusy}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {controlAction === 'scan-third-party' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
            Run 3rd-party scan
          </button>

          <button
            type="button"
            onClick={() => requestInstall('install-third-party', thirdPartyPendingIds, 'Install pending third-party patches')}
            disabled={isBusy || thirdPartyPendingIds.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {controlAction === 'install-third-party' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4 text-blue-500" />}
            Install 3rd-party patches ({thirdPartyPendingIds.length})
            {thirdPartyAwaitingApproval > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                ({thirdPartyAwaitingApproval} pending approval)
              </span>
            )}
          </button>
        </div>

        {controlNotice && (
          <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            controlNotice.kind === 'success'
              ? 'border-green-400/50 bg-green-500/10 text-green-700 dark:text-green-400'
              : controlNotice.kind === 'info'
                ? 'border-blue-400/50 bg-blue-500/10 text-blue-700 dark:text-blue-400'
                : 'border-destructive/40 bg-destructive/10 text-destructive'
          }`}>
            <span className="inline-flex items-center gap-1.5">
              {isPolling && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {controlNotice.message}
            </span>
          </div>
        )}

      </div>

      {/* ================================================================ */}
      {/* Patch Compliance                                                 */}
      {/* ================================================================ */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Patch Compliance</h3>
            <p className="text-sm text-muted-foreground">Pending vs installed updates</p>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle className="h-4 w-4 text-green-500" />
            {compliancePercent}% compliant
          </div>
        </div>
        <div className="mt-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full bg-primary ${widthPercentClass(compliancePercent)}`} />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{pendingNative.length + pendingOther.length} pending</span>
            <span>{displayedInstalledNative.length + installedThirdParty.length} installed</span>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ============================================================== */}
        {/* Pending Native OS Updates                                       */}
        {/* ============================================================== */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <NativeIcon className="h-4 w-4 text-gray-600" />
            <h3 className="text-sm font-semibold">{displayCopy.pendingNativeTitle}</h3>
            {pendingNative.length > 0 && (
              <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
                {pendingNative.length}
              </span>
            )}
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-x-auto overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">{displayCopy.pendingNativePrimaryColumn}</th>
                    {normalizedOsType === 'windows' && <th className="px-4 py-3">KB#</th>}
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Approval</th>
                    <th className="w-16 px-2 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pendingNative.length === 0 ? (
                    <tr>
                      <td colSpan={normalizedOsType === 'windows' ? 6 : 5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        {displayCopy.pendingNativeEmpty}
                      </td>
                    </tr>
                  ) : (
                    pendingNative.map((patch, index) => {
                      const badge = getCategoryBadge(patch, normalizedOsType);
                      const severityBadge = getSeverityBadge(patch.severity);
                      const kbLabel = getKbLabel(patch);
                      const releaseLabel = getReleaseLabel(patch, effectiveTimezone);
                      const srcBadge = getSourceBadge(patch);
                      const patchId = patch.id;
                      const isInstalling = patchId ? installingPatchIds.has(patchId) : false;
                      const notDownloaded = patch.isDownloaded === false;
                      const approvalBadge = getApprovalBadge(patch);
                      const isApproved = isPatchApprovedForInstall(patch);
                      const patchName = normalizePatchName(patch);
                      const installTitle = isApproved
                        ? `Install ${patchName}`
                        : `This org has not approved ${patchName}. Approve the patch before installing.`;

                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'pending-native'}-${index}`} className="text-sm">
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5">
                                <p className="font-medium">{patchName}</p>
                                {notDownloaded && (
                                  <span title="Not yet downloaded -- install will take longer" className="inline-flex items-center text-muted-foreground">
                                    <CloudDownload className="h-3.5 w-3.5" />
                                  </span>
                                )}
                              </div>
                              {(severityBadge || (normalizedOsType !== 'windows' && kbLabel) || releaseLabel || patch.requiresReboot) && (
                                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                  {severityBadge && (
                                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${severityBadge.className}`}>
                                      {severityBadge.label}
                                    </span>
                                  )}
                                  {/* Show KB inline badge only when there is no dedicated KB column */}
                                  {normalizedOsType !== 'windows' && kbLabel && (
                                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
                                      {kbLabel}
                                    </span>
                                  )}
                                  {releaseLabel && <span>{releaseLabel}</span>}
                                  {patch.requiresReboot && (
                                    <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-[11px] font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200">
                                      Reboot required
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                          {normalizedOsType === 'windows' && (
                            <td className="px-4 py-3">
                              {kbLabel ? (
                                <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
                                  {kbLabel}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">--</span>
                              )}
                            </td>
                          )}
                          <td className="px-4 py-3">
                            {srcBadge ? (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${srcBadge.className}`}>
                                {srcBadge.label}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">--</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {badge ? (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                                {badge.label}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground capitalize">
                                {patch.category || 'Uncategorized'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${approvalBadge.className}`}>
                              {approvalBadge.label}
                            </span>
                          </td>
                          <td className="px-2 py-3">
                            {patchId && (
                              <span title={installTitle} className="inline-flex">
                                <button
                                  type="button"
                                  aria-label={installTitle}
                                  disabled={isBusy || isInstalling || !isApproved}
                                  onClick={() => queueSinglePatchInstall(patchId, patchName)}
                                  className="inline-flex items-center justify-center rounded-md border p-1.5 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {isInstalling ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                                  ) : (
                                    <Download className={`h-3.5 w-3.5 ${isApproved ? 'text-green-600' : 'text-muted-foreground'}`} />
                                  )}
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* Pending Third-Party Updates                                     */}
        {/* ============================================================== */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
            <h3 className="text-sm font-semibold">{displayCopy.pendingThirdPartyTitle}</h3>
            {pendingOther.length > 0 && (
              <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
                {pendingOther.length}
              </span>
            )}
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-x-auto overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">{displayCopy.pendingThirdPartyPrimaryColumn}</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">{displayCopy.pendingThirdPartySecondaryColumn}</th>
                    <th className="px-4 py-3">Approval</th>
                    <th className="w-16 px-2 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pendingOther.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        {displayCopy.pendingThirdPartyEmpty}
                      </td>
                    </tr>
                  ) : (
                    pendingOther.map((patch, index) => {
                      const badge = getCategoryBadge(patch, normalizedOsType);
                      const brewUrl = normalizedOsType === 'macos' ? getHomebrewUrl(patch, normalizedOsType) : null;
                      const brewDetails = getHomebrewPendingDetails(patch, normalizedOsType);
                      const severityBadge = getSeverityBadge(patch.severity);
                      const kbLabel = getKbLabel(patch);
                      const releaseLabel = getReleaseLabel(patch, effectiveTimezone);
                      const srcBadge = getSourceBadge(patch);
                      const patchId = patch.id;
                      const isInstalling = patchId ? installingPatchIds.has(patchId) : false;
                      const notDownloaded = patch.isDownloaded === false;
                      const approvalBadge = getApprovalBadge(patch);
                      const isApproved = isPatchApprovedForInstall(patch);
                      const patchName = normalizePatchName(patch);
                      const installTitle = isApproved
                        ? `Install ${patchName}`
                        : `This org has not approved ${patchName}. Approve the patch before installing.`;

                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'pending-other'}-${index}`} className="text-sm">
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5">
                                <div className="font-medium">
                                  {brewUrl ? (
                                    <a
                                      href={brewUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                                    >
                                      {patchName}
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  ) : (
                                    patchName
                                  )}
                                </div>
                                {notDownloaded && (
                                  <span title="Not yet downloaded -- install will take longer" className="inline-flex items-center text-muted-foreground">
                                    <CloudDownload className="h-3.5 w-3.5" />
                                  </span>
                                )}
                              </div>
                              {(severityBadge || kbLabel || releaseLabel || patch.requiresReboot) && (
                                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                                  {severityBadge && (
                                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${severityBadge.className}`}>
                                      {severityBadge.label}
                                    </span>
                                  )}
                                  {kbLabel && (
                                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
                                      {kbLabel}
                                    </span>
                                  )}
                                  {releaseLabel && <span>{releaseLabel}</span>}
                                  {patch.requiresReboot && (
                                    <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-[11px] font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200">
                                      Reboot required
                                    </span>
                                  )}
                                </div>
                              )}
                              {brewDetails?.versionLabel && (
                                <div className="text-xs text-muted-foreground">
                                  {brewDetails.versionLabel}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {srcBadge ? (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${srcBadge.className}`}>
                                {srcBadge.label}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">--</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {brewDetails ? (
                              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                                {brewDetails.packageType}
                              </span>
                            ) : badge ? (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                                {badge.label}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground capitalize">
                                {patch.category || 'Third-party'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${approvalBadge.className}`}>
                              {approvalBadge.label}
                            </span>
                          </td>
                          <td className="px-2 py-3">
                            {patchId && (
                              <span title={installTitle} className="inline-flex">
                                <button
                                  type="button"
                                  aria-label={installTitle}
                                  disabled={isBusy || isInstalling || !isApproved}
                                  onClick={() => queueSinglePatchInstall(patchId, patchName)}
                                  className="inline-flex items-center justify-center rounded-md border p-1.5 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {isInstalling ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                                  ) : (
                                    <Download className={`h-3.5 w-3.5 ${isApproved ? 'text-green-600' : 'text-muted-foreground'}`} />
                                  )}
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* Installed Native OS Updates                                     */}
        {/* ============================================================== */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <NativeIcon className="h-4 w-4 text-gray-600" />
            <h3 className="text-sm font-semibold">{displayCopy.installedNativeTitle}</h3>
            <span className="text-xs text-muted-foreground">({displayedInstalledNative.length})</span>
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-x-auto overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">{displayCopy.installedNativePrimaryColumn}</th>
                    {normalizedOsType === 'windows' && <th className="px-4 py-3">KB#</th>}
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Installed</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {displayedInstalledNative.length === 0 ? (
                    <tr>
                      <td colSpan={normalizedOsType === 'windows' ? 4 : 3} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        {displayCopy.installedNativeEmpty}
                      </td>
                    </tr>
                  ) : (
                    displayedInstalledNative.map((patch, index) => {
                      const badge = getCategoryBadge(patch, normalizedOsType);
                      const kbLabel = getKbLabel(patch);
                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'apple'}-${index}`} className="text-sm">
                          <td className="px-4 py-3 font-medium">{normalizePatchName(patch)}</td>
                          {normalizedOsType === 'windows' && (
                            <td className="px-4 py-3">
                              {kbLabel ? (
                                <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
                                  {kbLabel}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">--</span>
                              )}
                            </td>
                          )}
                          <td className="px-4 py-3">
                            {badge ? (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                                {badge.label}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground capitalize">
                                {patch.category || 'Uncategorized'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(patch.installedAt, effectiveTimezone)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ================================================================ */}
      {/* Installed Third-Party Updates                                     */}
      {/* ================================================================ */}
      {installedThirdParty.length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <Package className="h-4 w-4 text-blue-500" />
            <h3 className="text-sm font-semibold">{displayCopy.installedThirdPartyTitle}</h3>
            <span className="text-xs text-muted-foreground">({installedThirdParty.length})</span>
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">Software</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">Installed</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {installedThirdParty.map((patch, index) => {
                    const brewUrl = normalizedOsType === 'macos' ? getHomebrewUrl(patch, normalizedOsType) : null;
                    const srcBadge = getSourceBadge(patch);
                    return (
                      <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'thirdparty'}-${index}`} className="text-sm">
                        <td className="px-4 py-3 font-medium">
                          {brewUrl ? (
                            <a
                              href={brewUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                            >
                              {normalizePatchName(patch)}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            normalizePatchName(patch)
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {srcBadge ? (
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${srcBadge.className}`}>
                              {srcBadge.label}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">--</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(patch.installedAt, effectiveTimezone)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <PatchInstallHistory deviceId={deviceId} />

      {/* Destructive batch-install confirmation. Installing pending patches may
          reboot the device, so it must be confirmed before firing. */}
      <ConfirmDialog
        open={pendingInstall !== null}
        onClose={() => setPendingInstall(null)}
        onConfirm={() => {
          if (!pendingInstall) return;
          const { action, patchIds, label } = pendingInstall;
          setPendingInstall(null);
          void queuePatchInstall(action, patchIds, label);
        }}
        title="Install pending patches"
        variant="warning"
        confirmLabel="Install"
        confirmTestId="confirm-install-patches"
        isLoading={controlAction !== null}
        message={
          pendingInstall
            ? `Queue installation of ${pendingInstall.patchIds.length} ${
                pendingInstall.patchIds.length === 1 ? 'patch' : 'patches'
              } on this device? This may require a reboot.`
            : ''
        }
      />
    </div>
  );
}
