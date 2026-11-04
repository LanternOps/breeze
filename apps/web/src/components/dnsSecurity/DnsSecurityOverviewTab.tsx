import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ShieldAlert, ShieldCheck, Activity, AlertTriangle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatNumber } from '@/lib/i18n/format';

/**
 * #10054 — whether the integrations in scope store allowed DNS queries. Sync
 * stores blocked + redirected events by default; allowed traffic is a
 * per-integration opt-in, so an allowed count can be partial or absent.
 */
type AllowedTrafficCoverage = 'all' | 'some' | 'none';

interface DnsStats {
  total: number | null;
  blocked: number;
  /** null when no integration in scope stores allowed traffic. */
  allowed: number | null;
  redirected: number;
  allowedTraffic: AllowedTrafficCoverage;
}

/** null stays null (not stored); a missing field counts as 0. */
function nullableCount(value: unknown): number | null {
  return value === null ? null : Number(value ?? 0);
}

interface TopBlockedEntry {
  domain: string;
  count: number;
  category?: string | null;
}

export default function DnsSecurityOverviewTab() {
  const { t } = useTranslation('security');
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
        // GET /dns-security/stats answers `{ summary: {...}, allowedTraffic }`.
        const body = await statsRes.json();
        const summary = body.summary ?? {};
        const allowedTraffic: AllowedTrafficCoverage =
          body.allowedTraffic === 'none' || body.allowedTraffic === 'some' ? body.allowedTraffic : 'all';
        setStats({
          total: nullableCount(summary.totalQueries),
          blocked: Number(summary.blockedQueries ?? 0),
          allowed: allowedTraffic === 'none' ? null : nullableCount(summary.allowedQueries),
          redirected: Number(summary.redirectedQueries ?? 0),
          allowedTraffic,
        });
      }
      if (topRes.ok) {
        const body = await topRes.json();
        setTopBlocked((body.data ?? []) as TopBlockedEntry[]);
      }

      if (!statsRes.ok && !topRes.ok) {
        throw new Error(t('dnsSecurityDnsSecurityOverviewTab.messages.loadFailed'));
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : t('dnsSecurityDnsSecurityOverviewTab.messages.loadFailed'));
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
          label={t('dnsSecurityDnsSecurityOverviewTab.stats.totalQueries')}
          value={stats ? stats.total : 0}
          notStoredLabel={t('dnsSecurityDnsSecurityOverviewTab.stats.notStored')}
          icon={<Activity className="h-4 w-4" />}
          loading={loading}
        />
        <StatCard
          label={t('dnsSecurityDnsSecurityOverviewTab.stats.blocked')}
          value={stats?.blocked ?? 0}
          icon={<ShieldAlert className="h-4 w-4" />}
          tone="destructive"
          loading={loading}
        />
        <StatCard
          label={t('dnsSecurityDnsSecurityOverviewTab.stats.allowed')}
          value={stats ? stats.allowed : 0}
          valueTestId="dns-overview-allowed-value"
          notStoredLabel={t('dnsSecurityDnsSecurityOverviewTab.stats.notStored')}
          icon={<ShieldCheck className="h-4 w-4" />}
          tone="success"
          loading={loading}
        />
        <StatCard
          label={t('dnsSecurityDnsSecurityOverviewTab.stats.redirected')}
          value={stats?.redirected ?? 0}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone="warning"
          loading={loading}
        />
      </div>

      {stats && stats.allowedTraffic !== 'all' && (
        <p
          data-testid="dns-overview-allowed-traffic-note"
          className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          {stats.allowedTraffic === 'none'
            ? t('dnsSecurityDnsSecurityOverviewTab.allowedTraffic.none')
            : t('dnsSecurityDnsSecurityOverviewTab.allowedTraffic.some')}
        </p>
      )}

      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('dnsSecurityDnsSecurityOverviewTab.topBlocked.title')}</h3>
        {loading && topBlocked.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            {t('dnsSecurityDnsSecurityOverviewTab.loading')}
          </div>
        ) : topBlocked.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground italic">
            {t('dnsSecurityDnsSecurityOverviewTab.topBlocked.empty')}
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
  valueTestId,
  notStoredLabel,
}: {
  label: string;
  /** null = not stored (see #10054), rendered as `notStoredLabel`, never as 0. */
  value: number | null;
  icon: React.ReactNode;
  tone?: 'destructive' | 'success' | 'warning';
  loading: boolean;
  valueTestId?: string;
  notStoredLabel?: string;
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
      <div data-testid={valueTestId} className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>
        {loading ? (
          <span className="text-muted-foreground">—</span>
        ) : value === null ? (
          <span className="text-base font-medium text-muted-foreground">{notStoredLabel}</span>
        ) : (
          formatNumber(value)
        )}
      </div>
    </div>
  );
}
