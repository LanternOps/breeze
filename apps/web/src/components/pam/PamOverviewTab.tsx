import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Timer, Inbox } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import {
  type ElevationRequest,
  FLOW_LABELS,
  STATUS_LABELS,
  requestTarget,
  statusBadgeClass,
} from './types';

interface OverviewData {
  active: ElevationRequest[];
  pendingTotal: number;
  recent: ElevationRequest[];
}

export default function PamOverviewTab({ liveTick }: { liveTick: number }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const [activeRes, pendingRes, recentRes] = await Promise.all([
        fetchWithAuth('/pam/active', { signal }),
        fetchWithAuth('/pam/elevation-requests?status=pending&limit=1', { signal }),
        fetchWithAuth('/pam/elevation-requests?limit=10', { signal }),
      ]);
      for (const res of [activeRes, pendingRes, recentRes]) {
        if (!res.ok) {
          if (res.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          throw new Error(`Failed to load overview (HTTP ${res.status})`);
        }
      }
      const activeBody = await activeRes.json();
      const pendingBody = await pendingRes.json();
      const recentBody = await recentRes.json();
      setData({
        active: (activeBody.active ?? []) as ElevationRequest[],
        pendingTotal: Number(pendingBody.pagination?.total ?? 0),
        recent: ((recentBody.requests ?? []) as ElevationRequest[]).filter(
          (r) => r.status !== 'pending',
        ),
      });
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
  }, [fetchOverview, liveTick]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-card px-4 py-6 text-sm text-muted-foreground">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        Loading overview…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={<ShieldCheck className="h-5 w-5 text-green-500" />}
          label="Active elevations"
          value={data?.active.length ?? 0}
          testId="pam-stat-active"
        />
        <StatCard
          icon={<Inbox className="h-5 w-5 text-yellow-500" />}
          label="Pending requests"
          value={data?.pendingTotal ?? 0}
          testId="pam-stat-pending"
        />
        <StatCard
          icon={<Timer className="h-5 w-5 text-blue-500" />}
          label="Recent decisions"
          value={data?.recent.length ?? 0}
          testId="pam-stat-recent"
        />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Active elevations</h2>
        {!data || data.active.length === 0 ? (
          <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
            <ShieldCheck className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No active elevations</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Approved elevation windows will appear here until they expire or are revoked.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Device</th>
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                  <th className="px-3 py-2 font-medium">Flow</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {data.active.map((r) => (
                  <tr key={r.id} className="border-b last:border-0" data-testid={`pam-active-row-${r.id}`}>
                    <td className="px-3 py-2">{r.deviceHostname ?? r.deviceId}</td>
                    <td className="px-3 py-2">{r.subjectUsername}</td>
                    <td className="max-w-[280px] truncate px-3 py-2" title={requestTarget(r)}>
                      {requestTarget(r)}
                    </td>
                    <td className="px-3 py-2">{FLOW_LABELS[r.flowType]}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(r.status)}`}
                      >
                        {STATUS_LABELS[r.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {r.expiresAt ? <ExpiresIn at={r.expiresAt} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Recent decisions</h2>
        {!data || data.recent.length === 0 ? (
          <div className="rounded-md border border-dashed bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            No decided requests yet.
          </div>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {data.recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate" title={requestTarget(r)}>
                  <span className="font-medium">{r.deviceHostname ?? r.deviceId}</span>
                  <span className="text-muted-foreground"> · {r.subjectUsername} · </span>
                  {requestTarget(r)}
                </span>
                <span
                  className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(r.status)}`}
                >
                  {STATUS_LABELS[r.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <div className="rounded-md border bg-card px-4 py-3" data-testid={testId}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function ExpiresIn({ at }: { at: string }) {
  const ms = new Date(at).getTime() - Date.now();
  if (Number.isNaN(ms)) return <>—</>;
  if (ms <= 0) return <>expired</>;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return <>{mins}m</>;
  const hours = Math.floor(mins / 60);
  return (
    <>
      {hours}h {mins % 60}m
    </>
  );
}
