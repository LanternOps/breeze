import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react';
import { cn, formatNumber, formatSafeDate, friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import SecurityPageHeader from './SecurityPageHeader';
import SecurityStatCard from './SecurityStatCard';

type Threat = {
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  category: string;
  severity: string;
  status: string;
  detectedAt: string;
  filePath: string;
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };

const severityBadge: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-700 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-700 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-800 border-yellow-500/30',
  low: 'bg-blue-500/15 text-blue-700 border-blue-500/30'
};

const statusBadge: Record<string, string> = {
  active: 'bg-red-500/15 text-red-700 border-red-500/30',
  quarantined: 'bg-amber-500/15 text-amber-800 border-amber-500/30',
  removed: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
};

export default function VulnerabilitiesPage() {
  const [threats, setThreats] = useState<Threat[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [summary, setSummary] = useState({ total: 0, active: 0, quarantined: 0, critical: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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
      if (severity) params.set('severity', severity);
      if (status) params.set('status', status);
      if (category) params.set('category', category);

      const res = await fetchWithAuth(`/security/threats?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!Array.isArray(json.data)) throw new Error('Invalid response from server');
      setThreats(json.data);
      if (json.pagination) setPagination(json.pagination);
      if (json.summary) setSummary(json.summary);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[VulnerabilitiesPage] fetch error:', err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, severity, status, category]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  const handleBulkAction = async (action: 'quarantine' | 'remove') => {
    try {
      for (const id of selectedIds) {
        const res = await fetchWithAuth(`/security/threats/${id}/${action}`, { method: 'POST' });
        if (!res.ok) throw new Error(`Failed to ${action} threat ${id}: ${res.status}`);
      }
      setSelectedIds(new Set());
    } catch (err) {
      console.error('[VulnerabilitiesPage] bulk action error:', err);
      setError(friendlyFetchError(err));
    }
    fetchData(pagination.page);
  };

  const allSelected = threats.length > 0 && threats.every((t) => selectedIds.has(t.id));
  const someSelected = threats.some((t) => selectedIds.has(t.id));

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(threats.map((t) => t.id)) : new Set());
  };

  const toggleOne = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    setSelectedIds(next);
  };

  const { active, quarantined, critical } = summary;

  if (loading && threats.length === 0) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader title="Vulnerabilities" subtitle="Detected threats across all devices" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title="Vulnerabilities"
        subtitle="Detected threats across all devices"
        loading={loading}
        onRefresh={() => fetchData(pagination.page)}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <SecurityStatCard icon={AlertTriangle} label="Total" value={formatNumber(pagination.total)} />
        <SecurityStatCard icon={Shield} label="Critical" value={formatNumber(critical)} variant="danger" />
        <SecurityStatCard icon={ShieldAlert} label="Active" value={formatNumber(active)} variant="warning" />
        <SecurityStatCard icon={ShieldCheck} label="Quarantined" value={formatNumber(quarantined)} variant="success" />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative w-full lg:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search threats..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="quarantined">Quarantined</option>
            <option value="removed">Removed</option>
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
            <option value="">All categories</option>
            <option value="trojan">Trojan</option>
            <option value="ransomware">Ransomware</option>
            <option value="malware">Malware</option>
            <option value="spyware">Spyware</option>
            <option value="pup">PUP</option>
          </select>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-3">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <button type="button" onClick={() => handleBulkAction('quarantine')} className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted">
            <ShieldAlert className="h-4 w-4" /> Quarantine
          </button>
          <button type="button" onClick={() => handleBulkAction('remove')} className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted">
            <ShieldCheck className="h-4 w-4" /> Remove
          </button>
          <button type="button" onClick={() => setSelectedIds(new Set())} className="text-sm text-muted-foreground hover:text-foreground">
            Clear
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={(e) => toggleAll(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Threat</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Detected</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {threats.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No threats found.
                </td>
              </tr>
            ) : (
              threats.map((t) => (
                <tr key={t.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(t.id)}
                      onChange={(e) => toggleOne(t.id, e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </td>
                  <td className="px-4 py-3 text-sm font-medium">{t.deviceName}</td>
                  <td className="px-4 py-3 text-sm">{t.name}</td>
                  <td className="px-4 py-3 text-sm capitalize text-muted-foreground">{t.category}</td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold capitalize', severityBadge[t.severity])}>
                      {t.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold capitalize', statusBadge[t.status])}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatSafeDate(t.detectedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} total)
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => fetchData(pagination.page - 1)}
              className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => fetchData(pagination.page + 1)}
              className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
