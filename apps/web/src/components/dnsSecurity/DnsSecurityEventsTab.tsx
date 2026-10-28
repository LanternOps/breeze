import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ScrollText, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';

type Action = 'allowed' | 'blocked' | 'redirected';

interface DnsEvent {
  id: string;
  timestamp: string;
  domain: string;
  queryType: string | null;
  action: Action;
  category: string | null;
  threatType: string | null;
  sourceIp: string | null;
  sourceHostname: string | null;
  deviceId: string | null;
  deviceHostname: string | null;
  integrationId: string | null;
}

const ACTION_BADGE: Record<Action, string> = {
  allowed: 'bg-muted text-muted-foreground',
  blocked: 'bg-destructive/15 text-destructive',
  redirected: 'bg-warning/15 text-warning',
};

const PAGE_SIZE = 100;
const HOUR_MS = 3_600_000;

/**
 * The Events tab always reads a bounded window (#10054): an unbounded
 * blocked-only list over a 30M-row table took minutes. The API applies the
 * same 7-day default when `start` is absent; the UI sends it explicitly so the
 * window is visible and selectable.
 */
const WINDOWS = {
  last24h: 24 * HOUR_MS,
  last7d: 7 * 24 * HOUR_MS,
  last30d: 30 * 24 * HOUR_MS,
  last90d: 90 * 24 * HOUR_MS,
} as const;
type WindowKey = keyof typeof WINDOWS;
const WINDOW_KEYS = Object.keys(WINDOWS) as WindowKey[];

interface EventsResponse {
  data?: DnsEvent[];
  pagination?: { total?: number | null; totalCapped?: boolean; nextCursor?: string | null };
  window?: { start?: string };
}

export default function DnsSecurityEventsTab() {
  const { t } = useTranslation('security');
  const [events, setEvents] = useState<DnsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [totalCapped, setTotalCapped] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [windowKey, setWindowKey] = useState<WindowKey>('last7d');
  // The window start the first page was read with; "Load more" reuses it so
  // every page and the count describe the same window.
  const windowStartRef = useRef<string | null>(null);
  // Bumped by every first-page fetch; a response from an older generation (a
  // superseded refresh, or a Load more that was in flight when the range or
  // filter changed) is dropped instead of mixing two windows' rows.
  const generationRef = useRef(0);

  /**
   * Default to blocked-only — per the decision surface (Q5: "Blocked
   * threats by default; volume of allowed queries is huge and noisy").
   */
  const [showAll, setShowAll] = useState(false);

  const requestPage = useCallback(async (
    start: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<EventsResponse | null> => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), start });
    if (!showAll) params.set('action', 'blocked');
    if (cursor) params.set('cursor', cursor);
    const res = await fetchWithAuth(`/dns-security/events?${params.toString()}`, { signal });
    if (!res.ok) {
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return null;
      }
      throw new Error(t('dnsSecurityDnsSecurityEventsTab.messages.loadHttpError', { status: res.status }));
    }
    return (await res.json()) as EventsResponse;
  }, [showAll, t]);

  const fetchEvents = useCallback(async (signal?: AbortSignal) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setNextCursor(null);
    try {
      const start = new Date(Date.now() - WINDOWS[windowKey]).toISOString();
      const body = await requestPage(start, null, signal);
      if (!body || generation !== generationRef.current) return;
      windowStartRef.current = body.window?.start ?? start;
      setEvents(body.data ?? []);
      setTotal(Number(body.pagination?.total ?? 0));
      setTotalCapped(body.pagination?.totalCapped === true);
      setNextCursor(body.pagination?.nextCursor ?? null);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : t('dnsSecurityDnsSecurityEventsTab.messages.loadFailed'));
    } finally {
      if (!signal?.aborted && generation === generationRef.current) setLoading(false);
    }
  }, [requestPage, windowKey, t]);

  const loadMore = useCallback(async () => {
    const start = windowStartRef.current;
    if (!nextCursor || !start) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const body = await requestPage(start, nextCursor);
      if (!body || generation !== generationRef.current) return;
      setEvents((prev) => [...prev, ...(body.data ?? [])]);
      setNextCursor(body.pagination?.nextCursor ?? null);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : t('dnsSecurityDnsSecurityEventsTab.messages.loadFailed'));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, requestPage, t]);

  const countKey = showAll
    ? (totalCapped ? 'dnsSecurityDnsSecurityEventsTab.eventCountCapped' : 'dnsSecurityDnsSecurityEventsTab.eventCount')
    : (totalCapped ? 'dnsSecurityDnsSecurityEventsTab.blockedEventCountCapped' : 'dnsSecurityDnsSecurityEventsTab.blockedEventCount');

  useEffect(() => {
    const controller = new AbortController();
    void fetchEvents(controller.signal);
    return () => controller.abort();
  }, [fetchEvents]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">{t('dnsSecurityDnsSecurityEventsTab.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {loading
              ? t('dnsSecurityDnsSecurityEventsTab.loading')
              : t(/* i18n-dynamic */ countKey, {
                  count: total,
                  shown: events.length.toLocaleString(),
                  total: total.toLocaleString(),
                })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={windowKey}
            onChange={(e) => setWindowKey(e.target.value as WindowKey)}
            aria-label={t('dnsSecurityDnsSecurityEventsTab.window.label')}
            data-testid="dns-events-window"
            className="h-8 rounded border bg-background px-2 text-sm"
          >
            {WINDOW_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(/* i18n-dynamic */ `dnsSecurityDnsSecurityEventsTab.window.${key}`)}
              </option>
            ))}
          </select>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="h-4 w-4 rounded border"
            />
            {t('dnsSecurityDnsSecurityEventsTab.showAll')}
          </label>
          <button
            type="button"
            onClick={() => void fetchEvents()}
            disabled={loading}
            title={t('dnsSecurityDnsSecurityEventsTab.actions.refresh')}
            className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && events.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border bg-card px-4 py-6 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          {t('dnsSecurityDnsSecurityEventsTab.loadingEvents')}
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
          <ScrollText className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">
            {showAll
              ? t('dnsSecurityDnsSecurityEventsTab.empty.allTitle')
              : t('dnsSecurityDnsSecurityEventsTab.empty.blockedTitle')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {showAll
              ? t('dnsSecurityDnsSecurityEventsTab.empty.allDescription')
              : t('dnsSecurityDnsSecurityEventsTab.empty.blockedDescription')}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">{t('dnsSecurityDnsSecurityEventsTab.table.when')}</th>
                <th className="px-3 py-2 text-left">{t('dnsSecurityDnsSecurityEventsTab.table.device')}</th>
                <th className="px-3 py-2 text-left">{t('dnsSecurityDnsSecurityEventsTab.table.domain')}</th>
                <th className="px-3 py-2 text-left">{t('dnsSecurityDnsSecurityEventsTab.table.category')}</th>
                <th className="px-3 py-2 text-left">{t('dnsSecurityDnsSecurityEventsTab.table.action')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-3 py-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(e.timestamp)}
                  </td>
                  <td className="px-3 py-1.5">
                    {e.deviceHostname ?? e.sourceHostname ?? e.sourceIp ?? (
                      <span className="text-muted-foreground italic">{t('dnsSecurityDnsSecurityEventsTab.unknown')}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">{e.domain}</td>
                  <td className="px-3 py-1.5 text-xs">
                    {e.category ? (
                      <>
                        <span className="font-medium">{e.category}</span>
                        {e.threatType && <span className="text-muted-foreground"> · {e.threatType}</span>}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ACTION_BADGE[e.action]}`}>
                      {t(/* i18n-dynamic */ `dnsSecurityDnsSecurityEventsTab.actions.${e.action}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor && (
            <div className="border-t px-3 py-2 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="dns-events-load-more"
                className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
              >
                {loadingMore
                  ? t('dnsSecurityDnsSecurityEventsTab.loading')
                  : t('dnsSecurityDnsSecurityEventsTab.loadMore')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
