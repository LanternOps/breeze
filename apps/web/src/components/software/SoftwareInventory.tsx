import { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Package,
  RotateCcw,
  Search,
  ShieldCheck,
  ShieldX,
  XCircle,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import DeviceDrawer from './DeviceDrawer';

type VersionInfo = { version: string; count: number };

type SoftwareRow = {
  name: string;
  vendor: string | null;
  deviceCount: number;
  versions: VersionInfo[];
  firstSeen: string | null;
  lastSeen: string | null;
  policyStatus: 'allowed' | 'blocked' | 'audit' | 'no_policy';
};

type Toast = {
  id: string;
  type: 'success' | 'error';
  message: string;
};

type DrawerState = {
  softwareName: string;
  vendor: string | null;
} | null;

type ActionMenu = {
  name: string;
  vendor: string | null;
  x: number;
  y: number;
} | null;

const policyBadge: Record<string, { label: string; className: string }> = {
  allowed: { label: 'Allowed', className: 'bg-green-100 text-green-700 border-green-300' },
  blocked: { label: 'Blocked', className: 'bg-red-100 text-red-700 border-red-300' },
  audit: { label: 'Audit', className: 'bg-yellow-100 text-yellow-700 border-yellow-300' },
  no_policy: { label: 'No Policy', className: 'bg-muted text-muted-foreground border-muted' },
};

type SoftwareInventoryProps = {
  onSwitchToPolicies?: (prefill?: { name: string; vendor?: string; mode?: string }) => void;
};

export default function SoftwareInventory({ onSwitchToPolicies }: SoftwareInventoryProps = {}) {
  const [data, setData] = useState<SoftwareRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [sortBy, setSortBy] = useState<'deviceCount' | 'name' | 'vendor' | 'lastSeen'>('deviceCount');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const limit = 50;

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [actionMenu, setActionMenu] = useState<ActionMenu>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        sortBy,
        sortOrder,
      });
      if (debouncedSearch) params.set('search', debouncedSearch);

      const res = await fetchWithAuth(`/software-inventory?${params}`);
      if (!res.ok) throw new Error('Failed to load software inventory');
      const json = await res.json();
      setData(Array.isArray(json.data) ? json.data : []);
      setTotal(json.pagination?.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [offset, debouncedSearch, sortBy, sortOrder]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Close action menu on outside click
  useEffect(() => {
    if (!actionMenu) return;
    const handler = () => setActionMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [actionMenu]);

  const handleSort = (col: typeof sortBy) => {
    if (sortBy === col) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortOrder(col === 'name' || col === 'vendor' ? 'asc' : 'desc');
    }
    setOffset(0);
  };

  const handleApprove = async (name: string, vendor: string | null) => {
    try {
      const res = await fetchWithAuth('/software-inventory/approve', {
        method: 'POST',
        body: JSON.stringify({ softwareName: name, vendor: vendor || undefined }),
      });
      if (!res.ok) throw new Error('Failed to approve');
      showToast('success', `"${name}" added to allowlist`);
      await fetchData();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to approve');
    }
  };

  const handleDeny = async (name: string, vendor: string | null) => {
    try {
      const res = await fetchWithAuth('/software-inventory/deny', {
        method: 'POST',
        body: JSON.stringify({ softwareName: name, vendor: vendor || undefined }),
      });
      if (!res.ok) throw new Error('Failed to deny');
      showToast('success', `"${name}" added to blocklist`);
      await fetchData();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to deny');
    }
  };

  const handleClear = async (name: string, vendor: string | null) => {
    try {
      const res = await fetchWithAuth('/software-inventory/clear', {
        method: 'POST',
        body: JSON.stringify({ softwareName: name, vendor: vendor || undefined }),
      });
      if (!res.ok) throw new Error('Failed to clear status');
      showToast('success', `"${name}" policy status cleared`);
      await fetchData();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to clear status');
    }
  };

  const handleCreatePolicy = (name: string, vendor: string | null) => {
    if (onSwitchToPolicies) {
      onSwitchToPolicies({ name, vendor: vendor || undefined, mode: 'blocklist' });
    } else {
      const params = new URLSearchParams({ prefill: '1', name });
      if (vendor) params.set('vendor', vendor);
      params.set('mode', 'blocklist');
      window.location.href = `/software-policies?${params}`;
    }
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  const SortIcon = ({ col }: { col: typeof sortBy }) => {
    if (sortBy !== col) return null;
    return sortOrder === 'asc' ? <span className="ml-1">&#9650;</span> : <span className="ml-1">&#9660;</span>;
  };

  return (
    <div className="space-y-6">
      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`flex items-center gap-2 rounded-lg px-4 py-3 shadow-lg ${
                toast.type === 'success'
                  ? 'bg-green-600 text-white'
                  : 'bg-destructive text-destructive-foreground'
              }`}
            >
              {toast.type === 'success' ? (
                <CheckCircle className="h-5 w-5" />
              ) : (
                <XCircle className="h-5 w-5" />
              )}
              <span className="text-sm font-medium">{toast.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search software..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <span className="text-sm text-muted-foreground">{total} unique software</span>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border bg-card">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground"
                  onClick={() => handleSort('name')}
                >
                  Name <SortIcon col="name" />
                </th>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground"
                  onClick={() => handleSort('vendor')}
                >
                  Vendor <SortIcon col="vendor" />
                </th>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground"
                  onClick={() => handleSort('deviceCount')}
                >
                  Devices <SortIcon col="deviceCount" />
                </th>
                <th className="px-4 py-3">Versions</th>
                <th className="px-4 py-3">Policy Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && data.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                    <p className="mt-2 text-sm text-muted-foreground">Loading software inventory...</p>
                  </td>
                </tr>
              ) : data.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Package className="mx-auto h-8 w-8 text-muted-foreground/50" />
                    <p className="mt-2 text-sm font-medium text-muted-foreground">
                      No software data collected yet
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Software inventory is collected automatically from enrolled devices every 15 minutes.
                    </p>
                  </td>
                </tr>
              ) : (
                data.map((row) => {
                  const badge = policyBadge[row.policyStatus] ?? policyBadge.no_policy;
                  return (
                    <tr key={`${row.name}|${row.vendor}`} className="border-t hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setDrawer({ softwareName: row.name, vendor: row.vendor })}
                          className="font-medium text-primary hover:underline text-left"
                        >
                          {row.name}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {row.vendor || '-'}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setDrawer({ softwareName: row.name, vendor: row.vendor })}
                          className="inline-flex items-center rounded-full border bg-muted/50 px-2.5 py-0.5 text-xs font-medium hover:bg-muted"
                        >
                          {row.deviceCount}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {row.versions.slice(0, 3).map((v) => (
                            <span
                              key={v.version}
                              className="inline-flex items-center rounded-full border bg-muted/30 px-2 py-0.5 text-xs"
                            >
                              {v.version}
                              <span className="ml-1 text-muted-foreground">({v.count})</span>
                            </span>
                          ))}
                          {row.versions.length > 3 && (
                            <span className="inline-flex items-center text-xs text-muted-foreground">
                              +{row.versions.length - 3} more
                            </span>
                          )}
                          {row.versions.length === 0 && (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="relative flex justify-end">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActionMenu(
                                actionMenu?.name === row.name
                                  ? null
                                  : { name: row.name, vendor: row.vendor, x: e.clientX, y: e.clientY }
                              );
                            }}
                            className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                          >
                            Actions
                            <ChevronDown className="h-3 w-3" />
                          </button>
                          {actionMenu?.name === row.name && (
                            <div
                              className="absolute right-0 top-9 z-10 w-44 rounded-md border bg-card shadow-lg"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setActionMenu(null);
                                  handleApprove(row.name, row.vendor);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                              >
                                <ShieldCheck className="h-4 w-4 text-green-600" />
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActionMenu(null);
                                  handleDeny(row.name, row.vendor);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                              >
                                <ShieldX className="h-4 w-4 text-red-600" />
                                Deny
                              </button>
                              {(row.policyStatus === 'allowed' || row.policyStatus === 'blocked') && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActionMenu(null);
                                    handleClear(row.name, row.vendor);
                                  }}
                                  className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                                >
                                  <RotateCcw className="h-4 w-4 text-muted-foreground" />
                                  Clear Status
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setActionMenu(null);
                                  handleCreatePolicy(row.name, row.vendor);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted"
                              >
                                <Package className="h-4 w-4" />
                                Create Policy
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > limit && (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              Showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-muted-foreground">
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Device Drawer */}
      {drawer && (
        <DeviceDrawer
          softwareName={drawer.softwareName}
          vendor={drawer.vendor}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}
