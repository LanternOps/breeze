import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Search, Shield, ShieldOff } from 'lucide-react';
import { formatNumber, friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import SecurityPageHeader from './SecurityPageHeader';
import SecurityStatCard from './SecurityStatCard';

type FirewallProfile = {
  name: string;
  enabled: boolean;
  inboundPolicy: string;
  outboundPolicy: string;
};

type FirewallDevice = {
  deviceId: string;
  deviceName: string;
  os: string;
  firewallEnabled: boolean;
  profiles: FirewallProfile[];
  rulesCount: number;
};

type Summary = {
  total: number;
  enabled: number;
  disabled: number;
  coveragePercent: number;
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };

export default function FirewallPage() {
  const [devices, setDevices] = useState<FirewallDevice[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, enabled: 0, disabled: 0, coveragePercent: 0 });
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [osFilter, setOsFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchData = useCallback(async (page = 1) => {
    setError(undefined);
    setLoading(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (statusFilter) params.set('status', statusFilter);
      if (osFilter) params.set('os', osFilter);

      const res = await fetchWithAuth(`/security/firewall?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!Array.isArray(json.data)) throw new Error('Invalid response from server');
      setDevices(json.data);
      if (json.pagination) setPagination(json.pagination);
      if (json.summary) setSummary(json.summary);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[FirewallPage] fetch error:', err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter, osFilter]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading && devices.length === 0) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader title="Firewall Status" subtitle="Network protection across all devices" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title="Firewall Status"
        subtitle="Network protection across all devices"
        loading={loading}
        onRefresh={() => fetchData(pagination.page)}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <SecurityStatCard icon={Shield} label="Total Devices" value={formatNumber(summary.total)} />
        <SecurityStatCard icon={Shield} label="Enabled" value={formatNumber(summary.enabled)} variant="success" />
        <SecurityStatCard icon={ShieldOff} label="Disabled" value={formatNumber(summary.disabled)} variant="danger" />
        <SecurityStatCard icon={Shield} label="Coverage" value={`${summary.coveragePercent}%`} variant={summary.coveragePercent >= 90 ? 'success' : 'warning'} />
      </div>

      <div className="h-3 w-full rounded-full bg-muted">
        <div className="h-3 rounded-full bg-sky-500" style={{ width: `${summary.coveragePercent}%` }} />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative w-full lg:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="search" placeholder="Search devices..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All statuses</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <select value={osFilter} onChange={(e) => setOsFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All OS</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="linux">Linux</option>
        </select>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 w-8" />
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">OS</th>
              <th className="px-4 py-3">Firewall</th>
              <th className="px-4 py-3 text-right">Rules</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {devices.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">No devices found.</td></tr>
            ) : (
              devices.map((d) => {
                const isExpanded = expanded.has(d.deviceId);
                return (
                  <tr key={d.deviceId} className="group">
                    <td colSpan={5} className="p-0">
                      <div
                        className="flex cursor-pointer items-center transition hover:bg-muted/40"
                        onClick={() => toggleExpand(d.deviceId)}
                      >
                        <div className="px-4 py-3 w-8">
                          {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                        </div>
                        <div className="flex-1 px-4 py-3 text-sm font-medium">{d.deviceName}</div>
                        <div className="px-4 py-3 text-sm capitalize text-muted-foreground">{d.os}</div>
                        <div className="px-4 py-3">
                          {d.firewallEnabled ? (
                            <span className="inline-flex rounded-full border bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 border-emerald-500/30">Enabled</span>
                          ) : (
                            <span className="inline-flex rounded-full border bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-700 border-red-500/30">Disabled</span>
                          )}
                        </div>
                        <div className="px-4 py-3 text-right text-sm text-muted-foreground">{d.rulesCount}</div>
                      </div>
                      {isExpanded && (
                        <div className="border-t bg-muted/20 px-12 py-3">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-xs font-semibold uppercase text-muted-foreground">
                                <th className="pb-2">Profile</th>
                                <th className="pb-2">Status</th>
                                <th className="pb-2">Inbound</th>
                                <th className="pb-2">Outbound</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.profiles.map((p) => (
                                <tr key={p.name}>
                                  <td className="py-1 font-medium">{p.name}</td>
                                  <td className="py-1">
                                    {p.enabled ? (
                                      <span className="text-emerald-600">Active</span>
                                    ) : (
                                      <span className="text-red-600">Inactive</span>
                                    )}
                                  </td>
                                  <td className="py-1 capitalize text-muted-foreground">{p.inboundPolicy}</td>
                                  <td className="py-1 capitalize text-muted-foreground">{p.outboundPolicy}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</p>
          <div className="flex gap-2">
            <button type="button" disabled={pagination.page <= 1} onClick={() => fetchData(pagination.page - 1)} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">Previous</button>
            <button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => fetchData(pagination.page + 1)} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
