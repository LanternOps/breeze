import { useCallback, useEffect, useState } from 'react';
import { ScrollText, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

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

export default function DnsSecurityEventsTab() {
  const [events, setEvents] = useState<DnsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  /**
   * Default to blocked-only — per the decision surface (Q5: "Blocked
   * threats by default; volume of allowed queries is huge and noisy").
   */
  const [showAll, setShowAll] = useState(false);

  const fetchEvents = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (!showAll) params.set('action', 'blocked');
      const res = await fetchWithAuth(`/dns-security/events?${params.toString()}`, { signal });
      if (!res.ok) {
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(`Failed to load events (HTTP ${res.status})`);
      }
      const body = await res.json();
      setEvents((body.data ?? []) as DnsEvent[]);
      setTotal(Number(body.pagination?.total ?? 0));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchEvents(controller.signal);
    return () => controller.abort();
  }, [fetchEvents]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium">DNS query events</h2>
          <p className="text-xs text-muted-foreground">
            {loading ? 'Loading…' : `${events.length} of ${total} ${showAll ? 'event' : 'blocked event'}${total === 1 ? '' : 's'} (most recent 100)`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="h-4 w-4 rounded border"
            />
            Show all (not just blocked)
          </label>
          <button
            type="button"
            onClick={() => void fetchEvents()}
            disabled={loading}
            title="Refresh"
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
          Loading events…
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
          <ScrollText className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">
            {showAll ? 'No DNS events recorded' : 'No blocked DNS events'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {showAll
              ? 'Configure an integration and wait for the first 15-minute sync to complete.'
              : 'No threats blocked in the recent window. Try toggling "Show all" to see allowed traffic.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Device</th>
                <th className="px-3 py-2 text-left">Domain</th>
                <th className="px-3 py-2 text-left">Category</th>
                <th className="px-3 py-2 text-left">Action</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-3 py-1.5 whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td className="px-3 py-1.5">
                    {e.deviceHostname ?? e.sourceHostname ?? e.sourceIp ?? <span className="text-muted-foreground italic">unknown</span>}
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
                      {e.action}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
