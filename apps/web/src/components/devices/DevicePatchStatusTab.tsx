import { useCallback, useEffect, useMemo, useState } from 'react';
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
  type LucideIcon
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import type { OSType } from './DeviceList';

type PatchItem = {
  id?: string;
  name?: string;
  title?: string;
  kb?: string;
  externalId?: string;
  description?: string;
  severity?: string;
  status?: string;
  category?: string;
  source?: string;
  releaseDate?: string;
  releasedAt?: string;
  installedAt?: string;
  requiresReboot?: boolean;
};

type PatchPayload = {
  compliancePercent?: number;
  compliance?: number;
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
        installedNativeTitle: 'Installed Linux Updates',
        installedNativeEmpty: 'No Linux updates reported.',
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

function normalizePatchName(patch: PatchItem) {
  return patch.title || patch.name || patch.kb || 'Unnamed patch';
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
  const explicitKb = (patch.kb || '').trim();
  if (explicitKb) {
    return explicitKb.toUpperCase().startsWith('KB') ? explicitKb.toUpperCase() : `KB${explicitKb}`;
  }

  const name = patch.title || patch.name || '';
  const match = name.match(/kb\d{4,8}/i);
  return match ? match[0].toUpperCase() : null;
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

export default function DevicePatchStatusTab({ deviceId, timezone, osType }: DevicePatchStatusTabProps) {
  const [payload, setPayload] = useState<PatchPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [siteTimezone, setSiteTimezone] = useState<string | undefined>(timezone);
  const [controlAction, setControlAction] = useState<
    'install-native' | 'scan-native' | 'scan-third-party' | 'install-third-party' | null
  >(null);
  const [controlNotice, setControlNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  // Use provided timezone, fetched siteTimezone, or browser default
  const effectiveTimezone = timezone ?? siteTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const fetchPatchStatus = useCallback(async () => {
    setLoading(true);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch patch status');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchPatchStatus();
  }, [fetchPatchStatus]);

  const normalizedOsType: OSType = osType ?? 'macos';
  const displayCopy = useMemo(() => getPatchDisplayCopy(normalizedOsType), [normalizedOsType]);
  const NativeIcon = displayCopy.nativeIcon;
  const nativeSource = useMemo(() => getNativePatchSource(normalizedOsType), [normalizedOsType]);
  const nativeProviderLabel = useMemo(() => getNativePatchProviderLabel(normalizedOsType), [normalizedOsType]);

  const { pendingNative, pendingOther, installedNative, installedThirdParty, compliancePercent, missingCount } = useMemo(() => {
    const data = payload ?? {};
    const pendingList = data.pending ?? data.pendingPatches ?? data.available ?? [];
    const missingList = data.missing ?? data.missingPatches ?? [];
    const installedList = data.installed ?? data.installedPatches ?? data.applied ?? [];
    const patches = data.patches ?? [];

    const inferredPending = pendingList.length > 0
      ? pendingList
      : patches.filter(patch => (patch.status || '').toLowerCase() === 'pending' || (patch.status || '').toLowerCase() === 'available');
    const inferredMissing = missingList.length > 0
      ? missingList
      : patches.filter(patch => (patch.status || '').toLowerCase() === 'missing');
    const inferredInstalled = installedList.length > 0
      ? installedList
      : patches.filter(patch => (patch.status || '').toLowerCase() === 'installed');

    const nativePending = inferredPending.filter(patch => isNativePatchForOs(patch, normalizedOsType));
    const otherPending = inferredPending.filter(patch => !isNativePatchForOs(patch, normalizedOsType));

    const nativeInstalled = inferredInstalled.filter(patch => isNativePatchForOs(patch, normalizedOsType));
    const thirdPartyInstalled = inferredInstalled.filter(patch => !isNativePatchForOs(patch, normalizedOsType));

    const total = inferredPending.length + inferredInstalled.length;
    const compliance = data.compliancePercent ?? data.compliance ?? (total > 0 ? Math.round((inferredInstalled.length / total) * 100) : 100);

    return {
      pendingNative: nativePending,
      pendingOther: otherPending,
      installedNative: nativeInstalled,
      installedThirdParty: thirdPartyInstalled,
      compliancePercent: compliance,
      missingCount: inferredMissing.length
    };
  }, [payload, normalizedOsType]);

  const nativePendingIds = useMemo(() => readPatchIds(pendingNative), [pendingNative]);
  const thirdPartyPendingIds = useMemo(() => readPatchIds(pendingOther), [pendingOther]);

  const queuePatchScan = useCallback(async (
    action: 'scan-native' | 'scan-third-party',
    source: string,
    label: string
  ) => {
    setControlAction(action);
    setControlNotice(null);
    try {
      const response = await fetchWithAuth('/patches/scan', {
        method: 'POST',
        body: JSON.stringify({
          deviceIds: [deviceId],
          source
        })
      });
      const body = await response.json().catch(() => ({})) as PatchScanResponse & { error?: string };
      if (!response.ok) {
        throw new Error(body.error || `Failed to queue ${label.toLowerCase()}`);
      }

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
      setControlNotice({
        kind: 'error',
        message: err instanceof Error ? err.message : `Failed to queue ${label.toLowerCase()}`
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

    setControlAction(action);
    setControlNotice(null);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/patches/install`, {
        method: 'POST',
        body: JSON.stringify({ patchIds })
      });
      const body = await response.json().catch(() => ({})) as PatchInstallResponse & { error?: string };
      if (!response.ok) {
        throw new Error(body.error || `Failed to queue ${label.toLowerCase()}`);
      }

      const commandSuffix = body.commandId ? ` (command ${body.commandId})` : '';
      const patchCount = typeof body.patchCount === 'number' ? body.patchCount : patchIds.length;
      const dispatchSuffix = body.commandStatus === 'sent' ? ' and dispatched now' : '';
      setControlNotice({
        kind: 'success',
        message: `${label} queued for ${patchCount} patches${commandSuffix}${dispatchSuffix}.`
      });
    } catch (err) {
      setControlNotice({
        kind: 'error',
        message: err instanceof Error ? err.message : `Failed to queue ${label.toLowerCase()}`
      });
    } finally {
      setControlAction(null);
    }
  }, [deviceId]);

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
          onClick={fetchPatchStatus}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Patch Controls</h3>
            <p className="text-sm text-muted-foreground">Queue scans and installs for this device</p>
          </div>
          <button
            type="button"
            onClick={fetchPatchStatus}
            disabled={controlAction !== null}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${controlAction === null ? '' : 'animate-spin'}`} />
            Refresh patch data
          </button>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => queuePatchInstall('install-native', nativePendingIds, `Install pending ${nativeProviderLabel} patches`)}
            disabled={controlAction !== null || nativePendingIds.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {controlAction === 'install-native' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4 text-green-500" />}
            Install pending OS patches ({nativePendingIds.length})
          </button>

          <button
            type="button"
            onClick={() => queuePatchScan('scan-native', nativeSource, `Run ${nativeProviderLabel} patch scan`)}
            disabled={controlAction !== null}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {controlAction === 'scan-native' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
            Run OS patch scan
          </button>

          <button
            type="button"
            onClick={() => queuePatchScan('scan-third-party', 'third_party', 'Run third-party patch scan')}
            disabled={controlAction !== null}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {controlAction === 'scan-third-party' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
            Run 3rd-party scan
          </button>

          <button
            type="button"
            onClick={() => queuePatchInstall('install-third-party', thirdPartyPendingIds, 'Install pending third-party patches')}
            disabled={controlAction !== null || thirdPartyPendingIds.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {controlAction === 'install-third-party' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4 text-blue-500" />}
            Install 3rd-party patches ({thirdPartyPendingIds.length})
          </button>
        </div>

        {controlNotice && (
          <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            controlNotice.kind === 'success'
              ? 'border-green-400/50 bg-green-500/10 text-green-700'
              : 'border-destructive/40 bg-destructive/10 text-destructive'
          }`}>
            {controlNotice.message}
          </div>
        )}

        {missingCount > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {missingCount} stale missing records are excluded from pending install counts.
          </p>
        )}
      </div>

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
            <div className="h-full rounded-full bg-primary" style={{ width: `${compliancePercent}%` }} />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{pendingNative.length + pendingOther.length} pending</span>
            <span>{installedNative.length + installedThirdParty.length} installed</span>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <NativeIcon className="h-4 w-4 text-gray-600" />
            <h3 className="font-semibold">{displayCopy.pendingNativeTitle}</h3>
            {pendingNative.length > 0 && (
              <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
                {pendingNative.length}
              </span>
            )}
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">{displayCopy.pendingNativePrimaryColumn}</th>
                    <th className="px-4 py-3">Category</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pendingNative.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        {displayCopy.pendingNativeEmpty}
                      </td>
                    </tr>
                  ) : (
                    pendingNative.map((patch, index) => {
                      const badge = getCategoryBadge(patch, normalizedOsType);
                      const severityBadge = getSeverityBadge(patch.severity);
                      const kbLabel = getKbLabel(patch);
                      const releaseLabel = getReleaseLabel(patch, effectiveTimezone);
                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'pending-apple'}-${index}`} className="text-sm">
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <p className="font-medium">{normalizePatchName(patch)}</p>
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
                            </div>
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
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
            <h3 className="font-semibold">{displayCopy.pendingThirdPartyTitle}</h3>
            {pendingOther.length > 0 && (
              <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
                {pendingOther.length}
              </span>
            )}
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">{displayCopy.pendingThirdPartyPrimaryColumn}</th>
                    <th className="px-4 py-3">{displayCopy.pendingThirdPartySecondaryColumn}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pendingOther.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-6 text-center text-sm text-muted-foreground">
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
                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'pending-other'}-${index}`} className="text-sm">
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <div className="font-medium">
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
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <NativeIcon className="h-4 w-4 text-gray-600" />
            <h3 className="font-semibold">{displayCopy.installedNativeTitle}</h3>
            <span className="text-xs text-muted-foreground">({installedNative.length})</span>
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">{displayCopy.installedNativePrimaryColumn}</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Installed</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {installedNative.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        {displayCopy.installedNativeEmpty}
                      </td>
                    </tr>
                  ) : (
                    installedNative.map((patch, index) => {
                      const badge = getCategoryBadge(patch, normalizedOsType);
                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'apple'}-${index}`} className="text-sm">
                          <td className="px-4 py-3 font-medium">{normalizePatchName(patch)}</td>
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

      {installedThirdParty.length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <Package className="h-4 w-4 text-blue-500" />
            <h3 className="font-semibold">{displayCopy.installedThirdPartyTitle}</h3>
            <span className="text-xs text-muted-foreground">({installedThirdParty.length})</span>
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">Software</th>
                    <th className="px-4 py-3">Installed</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {installedThirdParty.map((patch, index) => {
                    const brewUrl = normalizedOsType === 'macos' ? getHomebrewUrl(patch, normalizedOsType) : null;
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
    </div>
  );
}
