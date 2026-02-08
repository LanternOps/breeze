import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, KeyRound, Loader2, Search } from 'lucide-react';
import { formatNumber, friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import SecurityPageHeader from './SecurityPageHeader';
import SecurityStatCard from './SecurityStatCard';

type PolicyCheck = {
  rule: string;
  key: string;
  pass: boolean;
  current?: string;
  required?: string;
};

type PolicyDevice = {
  deviceId: string;
  deviceName: string;
  os: string;
  compliant: boolean;
  checks: PolicyCheck[];
  localAccounts: number;
  adminAccounts: number;
};

type CommonFailure = { rule: string; count: number };

type Summary = {
  total: number;
  compliant: number;
  nonCompliant: number;
  compliancePercent: number;
  commonFailures: CommonFailure[];
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };

export default function PasswordPolicyPage() {
  const [devices, setDevices] = useState<PolicyDevice[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, compliant: 0, nonCompliant: 0, compliancePercent: 0, commonFailures: [] });
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [complianceFilter, setComplianceFilter] = useState('');
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
      if (complianceFilter) params.set('compliance', complianceFilter);
      if (osFilter) params.set('os', osFilter);

      const res = await fetchWithAuth(`/security/password-policy?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!Array.isArray(json.data)) throw new Error('Invalid response from server');
      setDevices(json.data);
      if (json.pagination) setPagination(json.pagination);
      if (json.summary) setSummary(json.summary);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[PasswordPolicyPage] fetch error:', err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, complianceFilter, osFilter]);

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
        <SecurityPageHeader title="Password Policy" subtitle="Password compliance across all devices" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title="Password Policy"
        subtitle="Password compliance across all devices"
        loading={loading}
        onRefresh={() => fetchData(pagination.page)}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <SecurityStatCard icon={KeyRound} label="Total Devices" value={formatNumber(summary.total)} />
        <SecurityStatCard icon={KeyRound} label="Compliant" value={formatNumber(summary.compliant)} variant="success" />
        <SecurityStatCard icon={KeyRound} label="Non-compliant" value={formatNumber(summary.nonCompliant)} variant="danger" />
        <SecurityStatCard icon={KeyRound} label="Compliance" value={`${summary.compliancePercent}%`} variant={summary.compliancePercent >= 90 ? 'success' : 'warning'} />
      </div>

      {summary.commonFailures.length > 0 && (
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-sm font-semibold mb-3">Common Failures</p>
          <div className="space-y-2">
            {summary.commonFailures.map((f) => (
              <div key={f.rule} className="flex items-center justify-between text-sm">
                <span>{f.rule}</span>
                <span className="font-medium text-red-600">{f.count} devices</span>
              </div>
            ))}
          </div>
        </div>
      )}

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
        <select value={complianceFilter} onChange={(e) => setComplianceFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All</option>
          <option value="compliant">Compliant</option>
          <option value="non_compliant">Non-compliant</option>
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
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-center">Local Accts</th>
              <th className="px-4 py-3 text-center">Admin Accts</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {devices.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">No devices found.</td></tr>
            ) : (
              devices.map((d) => {
                const isExpanded = expanded.has(d.deviceId);
                return (
                  <tr key={d.deviceId}>
                    <td colSpan={6} className="p-0">
                      <div className="flex cursor-pointer items-center transition hover:bg-muted/40" onClick={() => toggleExpand(d.deviceId)}>
                        <div className="px-4 py-3 w-8">
                          {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                        </div>
                        <div className="flex-1 px-4 py-3 text-sm font-medium">{d.deviceName}</div>
                        <div className="px-4 py-3 text-sm capitalize text-muted-foreground">{d.os}</div>
                        <div className="px-4 py-3">
                          {d.compliant ? (
                            <span className="inline-flex rounded-full border bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 border-emerald-500/30">Compliant</span>
                          ) : (
                            <span className="inline-flex rounded-full border bg-red-500/15 px-2 py-0.5 text-xs font-semibold text-red-700 border-red-500/30">Non-compliant</span>
                          )}
                        </div>
                        <div className="px-4 py-3 text-center text-sm text-muted-foreground">{d.localAccounts}</div>
                        <div className="px-4 py-3 text-center text-sm text-muted-foreground">{d.adminAccounts}</div>
                      </div>
                      {isExpanded && (
                        <div className="border-t bg-muted/20 px-12 py-3">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-xs font-semibold uppercase text-muted-foreground">
                                <th className="pb-2">Rule</th>
                                <th className="pb-2">Result</th>
                                <th className="pb-2">Current</th>
                                <th className="pb-2">Required</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.checks.map((c) => (
                                <tr key={c.key}>
                                  <td className="py-1">{c.rule}</td>
                                  <td className="py-1">
                                    {c.pass ? <span className="text-emerald-600">Pass</span> : <span className="text-red-600">Fail</span>}
                                  </td>
                                  <td className="py-1 text-muted-foreground">{c.current ?? '-'}</td>
                                  <td className="py-1 text-muted-foreground">{c.required ?? '-'}</td>
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
