import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  Apple,
  Package,
  ExternalLink,
  Monitor,
  Server,
  type LucideIcon
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import type { OSType } from './DeviceList';

type PatchItem = {
  id?: string;
  name?: string;
  title?: string;
  kb?: string;
  severity?: string;
  status?: string;
  category?: string;
  source?: string;
  releaseDate?: string;
  releasedAt?: string;
  installedAt?: string;
};

type PatchPayload = {
  compliancePercent?: number;
  compliance?: number;
  pending?: PatchItem[];
  pendingPatches?: PatchItem[];
  available?: PatchItem[];
  installed?: PatchItem[];
  installedPatches?: PatchItem[];
  applied?: PatchItem[];
  patches?: PatchItem[];
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

function formatDate(value?: string, timezone?: string) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], timezone ? { timeZone: timezone } : undefined);
}

function normalizePatchName(patch: PatchItem) {
  return patch.title || patch.name || patch.kb || 'Unnamed patch';
}

function getHomebrewUrl(patch: PatchItem): string | null {
  const category = (patch.category || '').toLowerCase();
  if (category !== 'homebrew' && category !== 'homebrew-cask') {
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

    const nativeInstalled = inferredInstalled.filter(patch => isNativePatchForOs(patch, normalizedOsType));
    const thirdPartyInstalled = inferredInstalled.filter(patch => !isNativePatchForOs(patch, normalizedOsType));

    const total = inferredPending.length + inferredInstalled.length;
    const compliance = data.compliancePercent ?? data.compliance ?? (total > 0 ? Math.round((inferredInstalled.length / total) * 100) : 100);

    return {
      pendingNative: nativePending,
      pendingOther: otherPending,
      installedNative: nativeInstalled,
      installedThirdParty: thirdPartyInstalled,
      compliancePercent: compliance
    };
  }, [payload, normalizedOsType]);

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
                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'pending-apple'}-${index}`} className="text-sm">
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
                      const brewUrl = normalizedOsType === 'macos' ? getHomebrewUrl(patch) : null;
                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'pending-other'}-${index}`} className="text-sm">
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
                            {badge ? (
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
                    const brewUrl = normalizedOsType === 'macos' ? getHomebrewUrl(patch) : null;
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
