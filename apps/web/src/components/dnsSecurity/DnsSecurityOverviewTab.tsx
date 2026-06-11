import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck, Activity, AlertTriangle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

interface DnsStats {
  total: number;
  blocked: number;
  allowed: number;
  redirected: number;
  /** Optional aggregations the API may include; render only when present. */
  topCategories?: Array<{ category: string; count: number }>;
  topDomains?: Array<{ domain: string; count: number }>;
}

interface TopBlockedEntry {
  domain: string;
  count: number;
  category?: string | null;
}

export default function DnsSecurityOverviewTab() {
  const [stats, setStats] = useState<DnsStats | null>(null);
  const [topBlocked, setTopBlocked] = useState<TopBlockedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, topRes] = await Promise.all([
        fetchWithAuth('/dns-security/stats', { signal }),
        fetchWithAuth('/dns-security/top-blocked?limit=10', { signal }),
      ]);

      if (statsRes.status === 401 || topRes.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }

      if (statsRes.ok) {
        const body = await statsRes.json();
        const data = body.data ?? body;
        setStats({
          total: Number(data.total ?? 0),
          blocked: Number(data.blocked ?? 0),
          allowed: Number(data.allowed ?? 0),
          redirected: Number(data.redirected ?? 0),
          topCategories: data.topCategories,
          topDomains: data.topDomains,
        });
      }
      if (topRes.ok) {
        const body = await topRes.json();
        setTopBlocked((body.data ?? []) as TopBlockedEntry[]);
      }

      if (!statsRes.ok && !topRes.ok) {
        throw new Error('Failed to load overview');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load overview');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchOverview(controller.signal);
    return () => controller.abort();
  }, [fetchOverview]);

  return (
    <div className="space-y-4">
      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total queries"
          value={stats?.total ?? 0}
          icon={<Activity className="h-4 w-4" />}
          loading={loading}
        />
        <StatCard
          label="Blocked"
          value={stats?.blocked ?? 0}
          icon={<ShieldAlert className="h-4 w-4" />}
          tone="destructive"
          loading={loading}
        />
        <StatCard
          label="Allowed"
          value={stats?.allowed ?? 0}
          icon={<ShieldCheck className="h-4 w-4" />}
          tone="success"
          loading={loading}
        />
        <StatCard
          label="Redirected"
          value={stats?.redirected ?? 0}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone="warning"
          loading={loading}
        />
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">Top blocked domains</h3>
        {loading && topBlocked.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Loading…
          </div>
        ) : topBlocked.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground italic">
            No blocked domains in the current window.
          </p>
        ) : (
          <ol className="space-y-1 text-sm">
            {topBlocked.map((entry, idx) => (
              <li
                key={entry.domain}
                className="flex items-center justify-between rounded px-2 py-1 hover:bg-muted/30"
              >
                <span className="font-mono text-xs">
                  <span className="mr-2 inline-block w-5 text-right text-muted-foreground">{idx + 1}.</span>
                  {entry.domain}
                  {entry.category && (
                    <span className="ml-2 text-muted-foreground">({entry.category})</span>
                  )}
                </span>
                <span className="font-mono text-xs font-medium">{entry.count}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone,
  loading,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: 'destructive' | 'success' | 'warning';
  loading: boolean;
}) {
  const toneClass =
    tone === 'destructive'
      ? 'text-destructive'
      : tone === 'success'
        ? 'text-success'
        : tone === 'warning'
          ? 'text-warning'
          : 'text-foreground';
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>
        {loading ? <span className="text-muted-foreground">—</span> : value.toLocaleString()}
      </div>
    </div>
  );
}
