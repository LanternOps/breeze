import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Power,
  Terminal,
  Monitor,
  Download,
  Package,
  Wrench,
  Trash2,
  HardDrive,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type ActivityEvent = {
  id: string;
  action?: string;
  message?: string;
  result?: 'success' | 'failure' | 'denied';
  initiatedBy?: string | null;
  timestamp?: string;
  actor?: { type?: string; name?: string; email?: string | null };
};

type DeviceActivityFeedProps = {
  deviceId: string;
  timezone?: string;
  /** How many activity rows to show on the overview. */
  limit?: number;
};

// "Deliberate actions taken on this endpoint." An event is shown only if its
// action starts with one of these prefixes (first match also picks the icon).
// Config/policy churn, discovery, and monitoring noise are intentionally
// excluded — the full set lives on the Activities tab.
const ACTION_RULES: { prefix: string; icon: LucideIcon }[] = [
  { prefix: 'device.command', icon: Power },              // reboot / shutdown / wake / lock / refresh
  { prefix: 'script.', icon: Terminal },                  // run / cancel
  { prefix: 'device.remote_access', icon: Monitor },      // remote session launched
  { prefix: 'device.patch', icon: Download },             // patch install / rollback
  { prefix: 'device.software', icon: Package },           // software install / uninstall / update
  { prefix: 'device.maintenance', icon: Wrench },         // maintenance enable / disable
  { prefix: 'device.filesystem.cleanup', icon: HardDrive },
  { prefix: 'device.decommission', icon: Trash2 },
  { prefix: 'device.permanent_delete', icon: Trash2 },
  { prefix: 'device.restore', icon: RotateCcw },
];

function ruleFor(action?: string) {
  if (!action) return undefined;
  return ACTION_RULES.find((r) => action.startsWith(r.prefix));
}

// initiatedBy values worth surfacing — a person doing something is implicit via
// the actor name, but "this happened automatically" is the interesting signal.
const INITIATOR_LABELS: Record<string, string> = {
  ai: 'AI',
  automation: 'Automation',
  policy: 'Policy',
  schedule: 'Schedule',
  integration: 'Integration',
};

function timeAgo(value?: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function absoluteTime(value?: string, timezone?: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString([], timezone ? { timeZone: timezone } : undefined);
}

export default function DeviceActivityFeed({ deviceId, timezone, limit = 8 }: DeviceActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [activeAlerts, setActiveAlerts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    try {
      // Over-fetch raw events, then keep only the endpoint actions. Alerts are
      // a separate source — we only need the active count for the pinned strip.
      const [eventsRes, alertsRes] = await Promise.all([
        fetchWithAuth(`/devices/${deviceId}/events?limit=40`),
        fetchWithAuth(`/devices/${deviceId}/alerts?status=active`),
      ]);
      if (signal?.aborted) return;
      if (!eventsRes.ok) throw new Error('events');

      const eventsJson = await eventsRes.json();
      const rawEvents: ActivityEvent[] = Array.isArray(eventsJson?.data) ? eventsJson.data : [];
      setEvents(rawEvents.filter((e) => ruleFor(e.action)));

      if (alertsRes.ok) {
        const alertsJson = await alertsRes.json();
        const payload = alertsJson?.data ?? alertsJson;
        setActiveAlerts(Array.isArray(payload) ? payload.length : 0);
      }
    } catch {
      if (!signal?.aborted) setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const visible = useMemo(() => events.slice(0, limit), [events, limit]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-lg font-semibold">Activity</h3>
      </div>

      {/* Pinned alert summary — only when this device has active alerts. */}
      {activeAlerts > 0 && (
        <a
          href="#alerts"
          className="mt-4 flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm font-medium text-foreground transition hover:bg-warning/15"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <span className="flex-1">
            {activeAlerts} active alert{activeAlerts === 1 ? '' : 's'}
          </span>
          <span className="text-muted-foreground">View →</span>
        </a>
      )}

      <div className="mt-4">
        {loading ? (
          <div className="space-y-3" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <div className="skeleton h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="skeleton h-3 w-3/4" />
                  <div className="skeleton h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load activity.{' '}
            <button type="button" onClick={() => void load()} className="font-medium text-primary hover:underline">
              Retry
            </button>
          </p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent actions on this device.</p>
        ) : (
          <ul className="space-y-3">
            {visible.map((e) => {
              const Icon = ruleFor(e.action)?.icon ?? Activity;
              const initiator = e.initiatedBy ? INITIATOR_LABELS[e.initiatedBy] : undefined;
              const who = e.actor?.name && e.actor.name !== 'System' ? e.actor.name : initiator ?? e.actor?.name;
              const failed = e.result === 'failure' || e.result === 'denied';
              return (
                <li key={e.id} className="flex gap-3">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                      failed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={e.message || e.action}>
                      {e.message || e.action}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                      {who && <span className="truncate">{who}</span>}
                      {/* Show the initiator chip only when it isn't already the "who". */}
                      {initiator && who !== initiator && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {initiator}
                        </span>
                      )}
                      {who && <span aria-hidden="true">·</span>}
                      <span title={absoluteTime(e.timestamp, timezone)}>{timeAgo(e.timestamp)}</span>
                      {failed && <span className="font-medium text-destructive">· Failed</span>}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!loading && !error && (
        <a
          href="#activities"
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          View all activity
          <span aria-hidden="true">→</span>
        </a>
      )}
    </div>
  );
}
