import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, AlertTriangle, Apple, Package, ExternalLink } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

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
};

const severityStyles: Record<string, string> = {
  critical: 'text-red-600',
  important: 'text-orange-600',
  moderate: 'text-yellow-600',
  low: 'text-blue-600'
};

const categoryBadges: Record<string, { label: string; className: string }> = {
  system: { label: 'OS Update', className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
  security: { label: 'Security', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  application: { label: 'App', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  homebrew: { label: 'Homebrew', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' }
};

function getCategoryBadge(patch: PatchItem) {
  const name = (patch.name || patch.title || '').toLowerCase();

  // Auto-detect macOS updates by name
  if (name.startsWith('macos') || name.startsWith('mac os')) {
    return categoryBadges.system;
  }
  // Auto-detect security updates
  if (name.includes('security') || name.includes('xprotect') || name.includes('gatekeeper') || name.includes('mrt')) {
    return categoryBadges.security;
  }

  // Use category from data if available
  const category = (patch.category || '').toLowerCase();
  return categoryBadges[category] || null;
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

export default function DevicePatchStatusTab({ deviceId, timezone }: DevicePatchStatusTabProps) {
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

  const { pendingApple, pendingOther, installedApple, installedThirdParty, compliancePercent } = useMemo(() => {
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

    // Helper to determine if patch is from Apple (not Homebrew)
    const isApplePatch = (patch: PatchItem) => {
      const category = (patch.category || '').toLowerCase();
      const name = (patch.name || patch.title || '').toLowerCase();

      // Exclude Homebrew packages (they have source=apple but category=homebrew)
      if (category === 'homebrew' || category === 'homebrew-cask') {
        return false;
      }

      // Apple system/security/app updates
      return category === 'system' ||
        category === 'security' ||
        category === 'application' ||
        name.startsWith('macos') ||
        name.startsWith('mac os') ||
        name.includes('xprotect') ||
        name.includes('gatekeeper') ||
        name.includes('rosetta');
    };

    // Split pending patches
    const applePending = inferredPending.filter(isApplePatch);
    const otherPending = inferredPending.filter(p => !isApplePatch(p));

    // Split installed patches
    const appleInstalled = inferredInstalled.filter(isApplePatch);
    const thirdPartyInstalled = inferredInstalled.filter(p => !isApplePatch(p));

    const total = inferredPending.length + inferredInstalled.length;
    const compliance = data.compliancePercent ?? data.compliance ?? (total > 0 ? Math.round((inferredInstalled.length / total) * 100) : 100);

    return {
      pendingApple: applePending,
      pendingOther: otherPending,
      installedApple: appleInstalled,
      installedThirdParty: thirdPartyInstalled,
      compliancePercent: compliance
    };
  }, [payload]);

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
            <span>{pendingApple.length + pendingOther.length} pending</span>
            <span>{installedApple.length + installedThirdParty.length} installed</span>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Pending Apple Updates */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <Apple className="h-4 w-4 text-gray-600" />
            <h3 className="font-semibold">Pending Apple Updates</h3>
            {pendingApple.length > 0 && (
              <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700">
                {pendingApple.length}
              </span>
            )}
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">Update</th>
                    <th className="px-4 py-3">Category</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pendingApple.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        No pending Apple updates.
                      </td>
                    </tr>
                  ) : (
                    pendingApple.map((patch, index) => {
                      const badge = getCategoryBadge(patch);
                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'pending-apple'}-${index}`} className="text-sm">
                          <td className="px-4 py-3 font-medium">{normalizePatchName(patch)}</td>
                          <td className="px-4 py-3">
                            {badge && (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                                {badge.label}
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

        {/* Pending Other Updates (Homebrew, etc.) */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
            <h3 className="font-semibold">Pending Package Updates</h3>
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
                    <th className="px-4 py-3">Package</th>
                    <th className="px-4 py-3">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {pendingOther.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        No pending package updates.
                      </td>
                    </tr>
                  ) : (
                    pendingOther.map((patch, index) => {
                      const badge = getCategoryBadge(patch);
                      const brewUrl = getHomebrewUrl(patch);
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
                            {badge && (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                                {badge.label}
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

        {/* Installed Apple Updates */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <Apple className="h-4 w-4 text-gray-600" />
            <h3 className="font-semibold">Installed Apple Updates</h3>
            <span className="text-xs text-muted-foreground">({installedApple.length})</span>
          </div>
          <div className="mt-4 overflow-hidden rounded-md border">
            <div className="max-h-64 overflow-y-auto">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40 sticky top-0">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">Update</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Installed</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {installedApple.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-6 text-center text-sm text-muted-foreground">
                        No Apple updates reported.
                      </td>
                    </tr>
                  ) : (
                    installedApple.map((patch, index) => {
                      const badge = getCategoryBadge(patch);
                      return (
                        <tr key={patch.id ?? `${patch.name ?? patch.title ?? 'apple'}-${index}`} className="text-sm">
                          <td className="px-4 py-3 font-medium">{normalizePatchName(patch)}</td>
                          <td className="px-4 py-3">
                            {badge && (
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                                {badge.label}
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

      {/* Installed Third-Party Updates */}
      {installedThirdParty.length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <Package className="h-4 w-4 text-blue-500" />
            <h3 className="font-semibold">Installed Third-Party Updates</h3>
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
                    const brewUrl = getHomebrewUrl(patch);
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
