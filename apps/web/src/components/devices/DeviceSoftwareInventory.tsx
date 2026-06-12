import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Package,
  Search,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  X,
  Box,
  ArrowUpCircle,
  Trash2,
  Loader2,
  AlertTriangle
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';

// Mirrors the API's softwareActions packageId regex. Used to decide whether a
// correlated update's packageId can be sent to the winget-only `--id` path.
const WINGET_PACKAGE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isApplePublisher(publisher: string): boolean {
  const p = publisher.toLowerCase();
  return p === 'apple' || p === 'apple inc.' || p === 'apple inc' || p === 'com.apple' || p.startsWith('com.apple.');
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 384 512" fill="currentColor" aria-label="Apple">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-62.1 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

type SoftwareItem = {
  id?: string;
  name?: string;
  title?: string;
  version?: string;
  publisher?: string;
  vendor?: string;
  installDate?: string;
  installedAt?: string;
  install_date?: string;
  // Available-update correlation, populated server-side from the third-party
  // patch data the agent already reports (winget upgrade). Absent/false means
  // no managed update is known for this row.
  updateAvailable?: boolean;
  availableVersion?: string | null;
  updatePackageId?: string | null;
  updateSource?: string | null;
};

type DeviceSoftwareInventoryProps = {
  deviceId: string;
  timezone?: string;
  osType?: string;
};

type SoftwareAction = 'update' | 'uninstall';

// We block update/uninstall for Apple-published macOS apps because their
// package-manager identity (Apple-signed App Store / OS components) is not
// expressible to `brew upgrade`/`brew uninstall`. The agent would just
// return "no supported update command" — better to disable upfront and
// explain why than to queue a guaranteed-to-fail command.
//
// The Update button is *additionally* gated on `updateAvailable`: a row only
// gets an actionable Update when the server has correlated it to a real
// available update (from the third-party patch scan). This is what stops the
// old "click Update, winget finds nothing, silent no-op" behavior — if no
// update is known we disable with an explanatory tooltip instead.
function actionsAreSupported(
  osType: string | undefined,
  isApple: boolean,
  updateAvailable: boolean
): {
  update: { allowed: boolean; reason?: string };
  uninstall: { allowed: boolean; reason?: string };
} {
  const os = (osType || '').toLowerCase();
  const noUpdateReason = 'No update available — this package is up to date or not tracked by a package manager.';

  if (os === 'macos' || os === 'darwin') {
    if (isApple) {
      const reason = 'Apple-signed apps are managed by macOS — uninstall via Settings, update via Software Update.';
      return { update: { allowed: false, reason }, uninstall: { allowed: false, reason } };
    }
    return {
      update: updateAvailable ? { allowed: true } : { allowed: false, reason: noUpdateReason },
      uninstall: { allowed: true },
    };
  }
  if (os === 'windows' || os === 'linux') {
    return {
      update: updateAvailable ? { allowed: true } : { allowed: false, reason: noUpdateReason },
      uninstall: { allowed: true },
    };
  }
  const reason = `Software actions are not supported on ${osType || 'this OS'}.`;
  return { update: { allowed: false, reason }, uninstall: { allowed: false, reason } };
}

function formatDate(value?: string, timezone?: string) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], timezone ? { timeZone: timezone } : undefined);
}

type ConfirmState = {
  action: SoftwareAction;
  name: string;
  version: string;
};

export default function DeviceSoftwareInventory({ deviceId, timezone, osType }: DeviceSoftwareInventoryProps) {
  const [software, setSoftware] = useState<SoftwareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [siteTimezone, setSiteTimezone] = useState<string | undefined>(timezone);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [, setTotal] = useState(0);
  const [publisherFilter, setPublisherFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'apple' | 'third-party'>('all');
  // True when a patch policy with third_party in its sources governs this
  // device — i.e. these updates can be managed/auto-approved by policy. Drives
  // the "manage these automatically" nudge banner.
  const [thirdPartyManaged, setThirdPartyManaged] = useState(false);
  // Rows currently in-flight (keyed by row id) so the table can show a
  // per-row spinner and disable other actions on that row without disabling
  // the entire grid.
  const [pendingActions, setPendingActions] = useState<Record<string, SoftwareAction | undefined>>({});
  // null when no confirm dialog is open. Only Uninstall opens one — Update
  // queues directly, since the worst case is a silent no-op when the package
  // is already current.
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const pageSize = 25;

  // Use provided timezone, fetched siteTimezone, or browser default
  const effectiveTimezone = timezone ?? siteTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchSoftware = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      // Fetch all software (use high limit since we're doing client-side filtering)
      const response = await fetchWithAuth(`/devices/${deviceId}/software?limit=1000`);
      if (!response.ok) throw new Error('Failed to fetch software inventory');
      const json = await response.json();
      const payload = json?.data ?? json;
      setSoftware(Array.isArray(payload) ? payload : []);
      setTotal(json?.pagination?.total ?? (Array.isArray(payload) ? payload.length : 0));
      setThirdPartyManaged(json?.thirdPartyUpdatesManaged === true);
      if (json?.timezone || json?.siteTimezone) {
        setSiteTimezone(json.timezone ?? json.siteTimezone);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch software inventory');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchSoftware();
  }, [fetchSoftware]);

  const queueSoftwareAction = useCallback(
    async (
      rowId: string,
      action: SoftwareAction,
      name: string,
      version: string,
      opts?: { packageId?: string | null; availableVersion?: string | null }
    ) => {
      setPendingActions((prev) => ({ ...prev, [rowId]: action }));
      const verb = action === 'update' ? 'Update' : 'Uninstall';
      // Updates send the winget packageId (when known) so the agent upgrades by
      // --id, and never pin a version — we always want the latest available.
      // Only a winget-shaped id is forwarded: the third_party patch bucket also
      // carries Homebrew ids like "homebrew:cask:foo" whose colons the API
      // rejects — those fall back to a name-based upgrade (which brew uses anyway).
      const body: Record<string, string> = { name };
      if (action === 'update') {
        if (opts?.packageId && WINGET_PACKAGE_ID.test(opts.packageId)) {
          body.packageId = opts.packageId;
        }
      } else if (version) {
        body.version = version;
      }
      const successMessage =
        action === 'update' && opts?.availableVersion
          ? `Update to ${opts.availableVersion} queued for "${name}"`
          : `${verb} queued for "${name}"`;
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/devices/${deviceId}/software/${action}`, {
              method: 'POST',
              body: JSON.stringify(body),
            }),
          errorFallback: `${verb} could not be queued`,
          successMessage,
        });
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) {
          return;
        }
        if (!(err instanceof ActionError)) {
          showToast({ message: `${verb} could not be queued`, type: 'error' });
        }
      } finally {
        setPendingActions((prev) => {
          const next = { ...prev };
          delete next[rowId];
          return next;
        });
      }
    },
    [deviceId]
  );

  // Get unique publishers for filter dropdown
  const publishers = useMemo(() => {
    const publisherSet = new Set<string>();
    for (const item of software) {
      const pub = item.publisher ?? item.vendor;
      if (pub) publisherSet.add(pub);
    }
    return Array.from(publisherSet).sort();
  }, [software]);

  const rows = useMemo(() => {
    return software.map((item, index) => {
      const publisher = item.publisher ?? item.vendor ?? '-';
      const isApple = isApplePublisher(publisher);
      const updateAvailable = item.updateAvailable === true;
      return {
        id: item.id ?? `${item.name ?? item.title ?? 'software'}-${index}`,
        name: item.name ?? item.title ?? 'Unknown software',
        version: item.version || '-',
        rawVersion: item.version || '',
        publisher,
        isApple,
        updateAvailable,
        availableVersion: item.availableVersion ?? null,
        updatePackageId: item.updatePackageId ?? null,
        installDate: formatDate(item.installDate ?? item.installedAt ?? item.install_date, effectiveTimezone),
        capabilities: actionsAreSupported(osType, isApple, updateAvailable),
      };
    });
  }, [software, effectiveTimezone, osType]);

  const filteredRows = useMemo(() => {
    return rows.filter(item => {
      // Type filter (Apple vs Third Party)
      if (typeFilter === 'apple' && !item.isApple) return false;
      if (typeFilter === 'third-party' && item.isApple) return false;

      // Publisher filter
      if (publisherFilter !== 'all' && item.publisher !== publisherFilter) {
        return false;
      }

      // Search filter
      if (debouncedSearch) {
        const searchLower = debouncedSearch.toLowerCase();
        return (
          item.name.toLowerCase().includes(searchLower) ||
          item.publisher.toLowerCase().includes(searchLower) ||
          item.version.toLowerCase().includes(searchLower)
        );
      }

      return true;
    });
  }, [rows, debouncedSearch, publisherFilter, typeFilter]);

  const totalPages = Math.ceil(filteredRows.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedRows = filteredRows.slice(startIndex, startIndex + pageSize);

  const clearFilters = () => {
    setSearch('');
    setDebouncedSearch('');
    setPublisherFilter('all');
    setTypeFilter('all');
    setCurrentPage(1);
  };

  const isMac = osType?.toLowerCase() === 'macos' || osType?.toLowerCase() === 'darwin';
  const hasActiveFilters = search || publisherFilter !== 'all' || typeFilter !== 'all';
  const updatesAvailableCount = useMemo(
    () => rows.filter((r) => r.updateAvailable).length,
    [rows]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading software inventory...</p>
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
          onClick={fetchSoftware}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Installed Software</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {filteredRows.length === rows.length
              ? rows.length
              : `${filteredRows.length} / ${rows.length}`}
          </span>
        </div>
        <button
          type="button"
          onClick={fetchSoftware}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, publisher, version..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {/* Type filter (Apple vs Third Party) — only on macOS */}
        {isMac && (
          <div className="flex items-center rounded-md border bg-background text-sm">
            {(['all', 'apple', 'third-party'] as const).map(type => (
              <button
                key={type}
                type="button"
                onClick={() => { setTypeFilter(type); setCurrentPage(1); }}
                className={`flex items-center gap-1.5 px-3 py-2 transition-colors first:rounded-l-md last:rounded-r-md ${
                  typeFilter === type
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                {type === 'apple' && <AppleIcon className="h-3.5 w-3.5" />}
                {type === 'third-party' && <Box className="h-3.5 w-3.5" />}
                {type === 'all' ? 'All' : type === 'apple' ? 'Apple' : '3rd Party'}
              </button>
            ))}
          </div>
        )}

        {/* Publisher filter */}
        <select
          value={publisherFilter}
          onChange={(e) => {
            setPublisherFilter(e.target.value);
            setCurrentPage(1);
          }}
          className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 max-w-[200px]"
        >
          <option value="all">All Publishers ({publishers.length})</option>
          {publishers.map(pub => (
            <option key={pub} value={pub}>{pub}</option>
          ))}
        </select>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
        )}
      </div>

      {/* Available-updates summary + policy nudge */}
      {updatesAvailableCount > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
          <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <div className="text-foreground">
            <span className="font-medium">
              {updatesAvailableCount} update{updatesAvailableCount === 1 ? '' : 's'} available
            </span>
            {thirdPartyManaged ? (
              <span className="text-muted-foreground">
                {' '}
                — third-party updates are policy-managed on this device.
              </span>
            ) : (
              <span className="text-muted-foreground">
                {' '}
                — update individually below, or enable third-party patching in a configuration policy to manage these automatically.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="mt-4 overflow-hidden rounded-md border">
        <div className="max-h-[500px] overflow-auto">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40 sticky top-0">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Publisher</th>
                <th className="px-4 py-3">Installed</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {hasActiveFilters
                      ? 'No software matches your filters.'
                      : 'No software inventory reported.'}
                  </td>
                </tr>
              ) : (
                paginatedRows.map(item => {
                  const pendingAction = pendingActions[item.id];
                  const isUpdatePending = pendingAction === 'update';
                  const isUninstallPending = pendingAction === 'uninstall';
                  const anyPending = pendingAction !== undefined;
                  return (
                    <tr key={item.id} className="text-sm hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">
                        <span className="flex items-center gap-2">
                          {item.isApple ? (
                            <AppleIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <Box className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          {item.name}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {item.updateAvailable && item.availableVersion ? (
                          <span className="inline-flex items-center gap-1">
                            <span>{item.version}</span>
                            <ArrowUpCircle className="h-3 w-3 text-emerald-600" />
                            <span className="font-semibold text-emerald-600">{item.availableVersion}</span>
                          </span>
                        ) : (
                          item.version
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{item.publisher}</td>
                      <td className="px-4 py-3 text-muted-foreground">{item.installDate}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            data-testid={`software-update-${item.id}`}
                            disabled={!item.capabilities.update.allowed || anyPending}
                            title={item.capabilities.update.reason ?? 'Queue an update for this package'}
                            onClick={() =>
                              queueSoftwareAction(item.id, 'update', item.name, item.rawVersion, {
                                packageId: item.updatePackageId,
                                availableVersion: item.availableVersion,
                              })
                            }
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isUpdatePending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ArrowUpCircle className="h-3.5 w-3.5" />
                            )}
                            Update
                          </button>
                          <button
                            type="button"
                            data-testid={`software-uninstall-${item.id}`}
                            disabled={!item.capabilities.uninstall.allowed || anyPending}
                            title={item.capabilities.uninstall.reason ?? 'Uninstall this package'}
                            onClick={() =>
                              setConfirmState({ action: 'uninstall', name: item.name, version: item.rawVersion })
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {isUninstallPending ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                            Uninstall
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} - {Math.min(startIndex + pageSize, filteredRows.length)} of{' '}
            {filteredRows.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(1)}
              disabled={currentPage === 1}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              First
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm min-w-[100px] text-center">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage(totalPages)}
              disabled={currentPage === totalPages}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              Last
            </button>
          </div>
        </div>
      )}

      {confirmState && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="software-uninstall-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmState(null);
          }}
        >
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              <div className="flex-1">
                <h4 id="software-uninstall-title" className="text-base font-semibold">
                  Uninstall {confirmState.name}?
                </h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  This will queue an uninstall command for "{confirmState.name}" on this device.
                  Uninstalling user data or dependencies may impact other software on the device.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmState(null)}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-uninstall"
                onClick={() => {
                  // Resolve the row id from current rows so the spinner key
                  // matches the row the user is looking at. We re-derive id
                  // by name+version because pagination/filters could have
                  // shuffled the visible set since the user clicked.
                  const row = rows.find(
                    (r) => r.name === confirmState.name && r.rawVersion === confirmState.version
                  );
                  const rowId = row?.id ?? `${confirmState.name}-${confirmState.version}`;
                  const name = confirmState.name;
                  const version = confirmState.version;
                  setConfirmState(null);
                  void queueSoftwareAction(rowId, 'uninstall', name, version);
                }}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90"
              >
                Uninstall
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
