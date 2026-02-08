import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Loader2,
  Sparkles,
  X
} from 'lucide-react';
import { cn, formatNumber, friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import SecurityPageHeader from './SecurityPageHeader';
import SecurityStatCard from './SecurityStatCard';

type Recommendation = {
  id: string;
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  status: 'open' | 'dismissed' | 'completed';
  impact: string;
  effort: string;
  affectedDevices: number;
  steps: string[];
};

type Summary = {
  total: number;
  open: number;
  completed: number;
  dismissed: number;
  criticalAndHigh: number;
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };

const priorityBadge: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-700 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-700 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-800 border-yellow-500/30',
  low: 'bg-blue-500/15 text-blue-700 border-blue-500/30'
};

const statusBadge: Record<string, string> = {
  open: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  completed: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  dismissed: 'bg-slate-500/15 text-slate-700 border-slate-500/30'
};

const impactColor: Record<string, string> = {
  high: 'text-red-600',
  medium: 'text-amber-600',
  low: 'text-blue-600'
};

const categoryLabel: Record<string, string> = {
  antivirus: 'Antivirus',
  firewall: 'Firewall',
  encryption: 'Encryption',
  password_policy: 'Password Policy',
  admin_accounts: 'Admin Accounts',
  patch_compliance: 'Patch Compliance',
  vulnerability_management: 'Vuln. Mgmt'
};

export default function RecommendationsPage() {
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, open: 0, completed: 0, dismissed: 0, criticalAndHigh: 0 });
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [priorityFilter, setPriorityFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (page = 1) => {
    setError(undefined);
    setLoading(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (priorityFilter) params.set('priority', priorityFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (statusFilter) params.set('status', statusFilter);

      const res = await fetchWithAuth(`/security/recommendations?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!Array.isArray(json.data)) throw new Error('Invalid response from server');
      setRecs(json.data);
      if (json.pagination) setPagination(json.pagination);
      if (json.summary) setSummary(json.summary);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[RecommendationsPage] fetch error:', err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [priorityFilter, categoryFilter, statusFilter]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  const handleAction = async (id: string, action: 'complete' | 'dismiss') => {
    try {
      const res = await fetchWithAuth(`/security/recommendations/${id}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      console.error(`[RecommendationsPage] ${action} error:`, err);
      setError(friendlyFetchError(err));
    }
    fetchData(pagination.page);
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading && recs.length === 0) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader title="Security Recommendations" subtitle="Prioritized remediation guidance" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title="Security Recommendations"
        subtitle="Prioritized remediation guidance"
        loading={loading}
        onRefresh={() => fetchData(pagination.page)}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <SecurityStatCard icon={Sparkles} label="Total" value={formatNumber(summary.total)} />
        <SecurityStatCard icon={Lightbulb} label="Open" value={formatNumber(summary.open)} variant="warning" />
        <SecurityStatCard icon={Sparkles} label="Critical + High" value={formatNumber(summary.criticalAndHigh)} variant="danger" />
        <SecurityStatCard icon={Check} label="Completed" value={formatNumber(summary.completed)} variant="success" />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All categories</option>
          <option value="antivirus">Antivirus</option>
          <option value="firewall">Firewall</option>
          <option value="encryption">Encryption</option>
          <option value="password_policy">Password Policy</option>
          <option value="admin_accounts">Admin Accounts</option>
          <option value="patch_compliance">Patch Compliance</option>
          <option value="vulnerability_management">Vuln. Mgmt</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="completed">Completed</option>
          <option value="dismissed">Dismissed</option>
        </select>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {recs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground lg:col-span-2">
            No recommendations match your filters.
          </div>
        ) : (
          recs.map((rec) => {
            const isExpanded = expandedIds.has(rec.id);
            return (
              <div key={rec.id} className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase', priorityBadge[rec.priority])}>
                        {rec.priority}
                      </span>
                      <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold', statusBadge[rec.status])}>
                        {rec.status}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {categoryLabel[rec.category] ?? rec.category}
                      </span>
                    </div>
                    <p className="text-sm font-medium">{rec.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{rec.description}</p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <span>Impact: <span className={cn('font-medium capitalize', impactColor[rec.impact])}>{rec.impact}</span></span>
                  <span>Effort: <span className="font-medium capitalize">{rec.effort}</span></span>
                  <span>Devices: <span className="font-medium">{rec.affectedDevices}</span></span>
                </div>

                {rec.steps.length > 0 && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => toggleExpand(rec.id)}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {isExpanded ? 'Hide steps' : `${rec.steps.length} remediation steps`}
                    </button>
                    {isExpanded && (
                      <ol className="mt-2 ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
                        {rec.steps.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}

                {rec.status === 'open' && (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleAction(rec.id, 'complete')}
                      className="inline-flex items-center gap-1 rounded-md border bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20"
                    >
                      <Check className="h-3 w-3" /> Mark Complete
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAction(rec.id, 'dismiss')}
                      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                    >
                      <X className="h-3 w-3" /> Dismiss
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
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
