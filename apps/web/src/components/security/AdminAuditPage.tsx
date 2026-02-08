import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Search, Shield, User } from 'lucide-react';
import { cn, formatNumber, formatSafeDate, friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import SecurityPageHeader from './SecurityPageHeader';
import SecurityStatCard from './SecurityStatCard';

type AdminAccount = {
  username: string;
  isBuiltIn: boolean;
  enabled: boolean;
  lastLogin: string;
  passwordAgeDays: number;
  issues: string[];
};

type AdminDevice = {
  deviceId: string;
  deviceName: string;
  os: string;
  adminAccounts: AdminAccount[];
  totalAdmins: number;
  hasIssues: boolean;
  issueTypes: string[];
};

type Summary = {
  totalDevices: number;
  devicesWithIssues: number;
  totalAdmins: number;
  defaultAccounts: number;
  weakPasswords: number;
  staleAccounts: number;
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };

const issueBadge: Record<string, string> = {
  default_account: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  weak_password: 'bg-red-500/15 text-red-700 border-red-500/30',
  stale_account: 'bg-orange-500/15 text-orange-700 border-orange-500/30'
};

const issueLabel: Record<string, string> = {
  default_account: 'Default',
  weak_password: 'Weak Password',
  stale_account: 'Stale'
};

export default function AdminAuditPage() {
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [summary, setSummary] = useState<Summary>({ totalDevices: 0, devicesWithIssues: 0, totalAdmins: 0, defaultAccounts: 0, weakPasswords: 0, staleAccounts: 0 });
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [issueFilter, setIssueFilter] = useState('');
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
      if (issueFilter) params.set('issue', issueFilter);
      if (osFilter) params.set('os', osFilter);

      const res = await fetchWithAuth(`/security/admin-audit?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!Array.isArray(json.data)) throw new Error('Invalid response from server');
      setDevices(json.data);
      if (json.pagination) setPagination(json.pagination);
      if (json.summary) setSummary(json.summary);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[AdminAuditPage] fetch error:', err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, issueFilter, osFilter]);

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
        <SecurityPageHeader title="Admin Account Audit" subtitle="Privileged account review across all devices" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title="Admin Account Audit"
        subtitle="Privileged account review across all devices"
        loading={loading}
        onRefresh={() => fetchData(pagination.page)}
      />

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <SecurityStatCard icon={User} label="Total Devices" value={formatNumber(summary.totalDevices)} />
        <SecurityStatCard icon={Shield} label="With Issues" value={formatNumber(summary.devicesWithIssues)} variant="warning" />
        <SecurityStatCard icon={User} label="Total Admins" value={formatNumber(summary.totalAdmins)} />
        <SecurityStatCard icon={User} label="Default Accts" value={formatNumber(summary.defaultAccounts)} variant={summary.defaultAccounts > 0 ? 'warning' : 'default'} />
        <SecurityStatCard icon={User} label="Weak Passwords" value={formatNumber(summary.weakPasswords)} variant={summary.weakPasswords > 0 ? 'danger' : 'default'} />
        <SecurityStatCard icon={User} label="Stale Accts" value={formatNumber(summary.staleAccounts)} variant={summary.staleAccounts > 0 ? 'warning' : 'default'} />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative w-full lg:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="search" placeholder="Search devices or users..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <select value={issueFilter} onChange={(e) => setIssueFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All</option>
          <option value="default_account">Default Accounts</option>
          <option value="weak_password">Weak Passwords</option>
          <option value="stale_account">Stale Accounts</option>
          <option value="no_issues">No Issues</option>
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
              <th className="px-4 py-3 text-center">Admins</th>
              <th className="px-4 py-3">Issues</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {devices.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">No devices found.</td></tr>
            ) : (
              devices.map((d) => {
                const isExpanded = expanded.has(d.deviceId);
                return (
                  <tr key={d.deviceId}>
                    <td colSpan={5} className="p-0">
                      <div className="flex cursor-pointer items-center transition hover:bg-muted/40" onClick={() => toggleExpand(d.deviceId)}>
                        <div className="px-4 py-3 w-8">
                          {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                        </div>
                        <div className="flex-1 px-4 py-3 text-sm font-medium">{d.deviceName}</div>
                        <div className="px-4 py-3 text-sm capitalize text-muted-foreground">{d.os}</div>
                        <div className="px-4 py-3 text-center text-sm">{d.totalAdmins}</div>
                        <div className="px-4 py-3">
                          {d.hasIssues ? (
                            <div className="flex flex-wrap gap-1">
                              {d.issueTypes.map((issue) => (
                                <span key={issue} className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold', issueBadge[issue] ?? '')}>
                                  {issueLabel[issue] ?? issue}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">None</span>
                          )}
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="border-t bg-muted/20 px-12 py-3">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-xs font-semibold uppercase text-muted-foreground">
                                <th className="pb-2">Username</th>
                                <th className="pb-2">Type</th>
                                <th className="pb-2">Enabled</th>
                                <th className="pb-2">Last Login</th>
                                <th className="pb-2">Password Age</th>
                                <th className="pb-2">Issues</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.adminAccounts.map((a) => (
                                <tr key={a.username}>
                                  <td className="py-1 font-medium">{a.username}</td>
                                  <td className="py-1">
                                    {a.isBuiltIn ? (
                                      <span className="inline-flex rounded border bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium">Built-in</span>
                                    ) : (
                                      <span className="text-muted-foreground">Custom</span>
                                    )}
                                  </td>
                                  <td className="py-1">
                                    {a.enabled ? <span className="text-emerald-600">Yes</span> : <span className="text-muted-foreground">No</span>}
                                  </td>
                                  <td className="py-1 text-muted-foreground">{formatSafeDate(a.lastLogin)}</td>
                                  <td className="py-1 text-muted-foreground">{a.passwordAgeDays}d</td>
                                  <td className="py-1">
                                    {a.issues.length > 0 ? (
                                      <div className="flex flex-wrap gap-1">
                                        {a.issues.map((issue) => (
                                          <span key={issue} className={cn('inline-flex rounded-full border px-1.5 py-0.5 text-[11px] font-semibold', issueBadge[issue] ?? '')}>
                                            {issueLabel[issue] ?? issue}
                                          </span>
                                        ))}
                                      </div>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">-</span>
                                    )}
                                  </td>
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
