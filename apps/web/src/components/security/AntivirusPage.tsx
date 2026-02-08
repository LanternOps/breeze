import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip
} from 'recharts';
import { Loader2, Search, ShieldCheck, ShieldOff } from 'lucide-react';
import { cn, formatNumber, friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import SecurityPageHeader from './SecurityPageHeader';
import SecurityStatCard from './SecurityStatCard';

type DeviceStatus = {
  deviceId: string;
  deviceName: string;
  os: string;
  status: string;
  riskLevel: string;
  realTimeProtection: boolean;
  provider: { name: string; vendor: string } | null;
};

type DashboardStats = {
  totalDevices: number;
  protectedDevices: number;
  atRiskDevices: number;
  unprotectedDevices: number;
  offlineDevices: number;
  providers: Array<{ providerId: string; providerName: string; deviceCount: number; coverage: number }>;
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };

const chartTooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '12px'
};

const PIE_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6'];

const statusBadge: Record<string, string> = {
  protected: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  at_risk: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  unprotected: 'bg-red-500/15 text-red-700 border-red-500/30',
  offline: 'bg-slate-500/15 text-slate-700 border-slate-500/30'
};

export default function AntivirusPage() {
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [dashboard, setDashboard] = useState<DashboardStats | null>(null);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [osFilter, setOsFilter] = useState('');
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

      const [statusRes, dashRes] = await Promise.all([
        fetchWithAuth(`/security/status?${params}`, { signal: controller.signal }),
        fetchWithAuth('/security/dashboard', { signal: controller.signal })
      ]);

      if (!statusRes.ok) throw new Error(`${statusRes.status}`);
      const statusJson = await statusRes.json();
      if (!Array.isArray(statusJson.data)) throw new Error('Invalid response from server');
      setDevices(statusJson.data);
      if (statusJson.pagination) setPagination(statusJson.pagination);

      if (dashRes.ok) {
        const dashJson = await dashRes.json();
        setDashboard(dashJson.data ?? null);
      } else {
        console.error('[AntivirusPage] dashboard fetch failed:', dashRes.status);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[AntivirusPage] fetch error:', err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter, osFilter]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  if (loading && devices.length === 0) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader title="Antivirus Coverage" subtitle="Endpoint protection status across all devices" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const total = dashboard?.totalDevices ?? 0;
  const prot = dashboard?.protectedDevices ?? 0;
  const unprot = dashboard?.unprotectedDevices ?? 0;
  const coveragePercent = total ? Math.round((prot / total) * 100) : 0;

  const pieData = (dashboard?.providers ?? [])
    .filter((p) => p.deviceCount > 0)
    .map((p) => ({ name: p.providerName, value: p.deviceCount }));

  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title="Antivirus Coverage"
        subtitle="Endpoint protection status across all devices"
        loading={loading}
        onRefresh={() => fetchData(pagination.page)}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <SecurityStatCard icon={ShieldCheck} label="Total Devices" value={formatNumber(total)} />
        <SecurityStatCard icon={ShieldCheck} label="Protected" value={formatNumber(prot)} variant="success" />
        <SecurityStatCard icon={ShieldOff} label="Unprotected" value={formatNumber(unprot)} variant="danger" />
        <SecurityStatCard icon={ShieldCheck} label="Coverage" value={`${coveragePercent}%`} variant={coveragePercent >= 90 ? 'success' : 'warning'} />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        {pieData.length > 0 && (
          <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-4">
            <p className="text-sm font-semibold">Provider Distribution</p>
            <div className="mt-4 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={chartTooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 space-y-2">
              {(dashboard?.providers ?? []).map((p, i) => (
                <div key={p.providerId} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="truncate">{p.providerName}</span>
                  </div>
                  <span className="font-medium">{p.deviceCount}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={cn('space-y-4', pieData.length > 0 ? 'lg:col-span-8' : 'lg:col-span-12')}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative w-full lg:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search devices..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
              <option value="">All statuses</option>
              <option value="protected">Protected</option>
              <option value="at_risk">At Risk</option>
              <option value="unprotected">Unprotected</option>
              <option value="offline">Offline</option>
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
                  <th className="px-4 py-3">Device</th>
                  <th className="px-4 py-3">OS</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Real-time</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {devices.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">No devices found.</td>
                  </tr>
                ) : (
                  devices.map((d) => (
                    <tr key={d.deviceId} className="transition hover:bg-muted/40">
                      <td className="px-4 py-3 text-sm font-medium">{d.deviceName}</td>
                      <td className="px-4 py-3 text-sm capitalize text-muted-foreground">{d.os}</td>
                      <td className="px-4 py-3 text-sm">{d.provider?.name ?? 'Unknown'}</td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold', statusBadge[d.status] ?? '')}>
                          {d.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {d.realTimeProtection ? (
                          <span className="text-emerald-600">Active</span>
                        ) : (
                          <span className="text-red-600">Inactive</span>
                        )}
                      </td>
                    </tr>
                  ))
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
      </div>
    </div>
  );
}
