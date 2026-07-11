import { useCallback, useEffect, useRef, useState } from 'react';
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
  ChevronLeft,
  ChevronRight,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { formatDateTime } from '@/lib/dateTimeFormat';
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
  // When true (and on lg+ screens), the pane renders as a thin vertical bar
  // showing the item count instead of the full card. The parent owns this state
  // and animates the rail width; below lg the full card always renders.
  collapsed?: boolean;
  // Toggles the collapsed state. Wired to both the collapsed bar (expand) and
  // the header chevron in the expanded card (collapse). Omit to disable the
  // affordance entirely.
  onToggleCollapse?: () => void;
  // Reports whether the pane has anything worth showing (events or active
  // alerts) so the parent can pick the data-driven default (open when there's
  // content, collapsed when empty).
  onHasContentChange?: (hasContent: boolean) => void;
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
  // Automated agent-dispatched commands (scheduled patches, automations). Listed
  // here ONLY so ruleFor() can pick an icon — they are deliberately excluded
  // from ACTION_PREFIXES below. The server surfaces these solely via the
  // actor-scoped includeAutomated predicate (system actors, no manual twin);
  // sending them as plain action prefixes would re-admit the manual
  // (actor_type='user') twin rows and double-list them.
  { prefix: 'agent.command.install_patches', icon: Download },
  { prefix: 'agent.command.rollback_patches', icon: RotateCcw },
  { prefix: 'agent.command.script', icon: Terminal },
  { prefix: 'agent.command.software_uninstall', icon: Package },
  { prefix: 'agent.command.software_update', icon: Package },
];

const AUTOMATED_ACTION_PREFIX = 'agent.command.';

function ruleFor(action?: string) {
  if (!action) return undefined;
  return ACTION_RULES.find((r) => action.startsWith(r.prefix));
}

// The deliberate-action prefix set, sent to the API so the filter runs
// server-side (index-backed) instead of over-fetching raw rows and discarding
// most of them client-side (issue #1726). The agent.command.* rules are
// excluded — those rows arrive only through the actor-scoped includeAutomated
// predicate, never as plain prefix matches (see the comment above).
const ACTION_PREFIXES = ACTION_RULES.filter((r) => !r.prefix.startsWith(AUTOMATED_ACTION_PREFIX))
  .map((r) => r.prefix)
  .join(',');

// How many filtered rows to request per page. Small fixed window for a fast,
// predictable first paint; "Load more" pulls the next page on demand.
const PAGE_SIZE = 10;

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
  return formatDateTime(d, timezone ? { timeZone: timezone } : undefined);
}

export default function DeviceActivityFeed({
  deviceId,
  timezone,
  collapsed = false,
  onToggleCollapse,
  onHasContentChange,
}: DeviceActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [activeAlerts, setActiveAlerts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  // A failed "Load more" is surfaced separately from the whole-pane `error` so a
  // failed append never blanks the rows already on screen.
  const [loadMoreError, setLoadMoreError] = useState(false);
  // Whether the last page came back full, i.e. there may be more to load.
  const [hasMore, setHasMore] = useState(false);
  // Highest page already appended to `events`. The next "Load more" fetches
  // loadedPage + 1 and only advances on success, so a failed page can be retried
  // without skipping rows.
  const [loadedPage, setLoadedPage] = useState(0);

  // Single in-flight controller for the component. Aborting it on a device
  // switch (or unmount) cancels BOTH the initial load and any in-flight "Load
  // more", so a slow request can't append the previous device's rows.
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous in-flight guard for "Load more". `disabled={loadingMore}` is
  // driven by async React state, so a fast double-click can slip two clicks
  // through before the re-render — both would fetch the same page and append
  // duplicate rows. This ref flips synchronously at click time to serialize.
  const loadMoreInFlight = useRef(false);

  // Fetch one page of deliberate-action events. page 1 (re)loads from scratch;
  // higher pages append. Filtering runs server-side and the count(*) is skipped
  // (withTotal omitted), so each page is a bounded index-backed read.
  const loadPage = useCallback(
    async (page: number, signal: AbortSignal) => {
      const isFirst = page === 1;
      if (isFirst) {
        setLoading(true);
        setError(false);
      } else {
        setLoadingMore(true);
        setLoadMoreError(false);
      }
      try {
        const eventsUrl = `/devices/${deviceId}/events?limit=${PAGE_SIZE}&page=${page}&includeAutomated=true&actions=${encodeURIComponent(
          ACTION_PREFIXES
        )}`;
        // The active-alert count is only needed on the initial load.
        const [eventsRes, alertsRes] = await Promise.all([
          fetchWithAuth(eventsUrl, { signal }),
          isFirst
            ? fetchWithAuth(`/devices/${deviceId}/alerts?status=active`, { signal })
            : Promise.resolve(null),
        ]);
        if (signal.aborted) return;
        if (!eventsRes.ok) throw new Error('events');

        const eventsJson = await eventsRes.json();
        const pageEvents: ActivityEvent[] = Array.isArray(eventsJson?.data) ? eventsJson.data : [];
        setEvents((prev) => (isFirst ? pageEvents : [...prev, ...pageEvents]));
        setHasMore(pageEvents.length === PAGE_SIZE);
        setLoadedPage(page);

        if (isFirst && alertsRes && alertsRes.ok) {
          const alertsJson = await alertsRes.json();
          const payload = alertsJson?.data ?? alertsJson;
          setActiveAlerts(Array.isArray(payload) ? payload.length : 0);
        }
        // Deliberate: if the events fetch succeeded but the alerts fetch failed,
        // we don't fail the whole pane — the feed is the primary content and the
        // pinned alert banner is a secondary signal. activeAlerts stays at its
        // prior value (0 on first load) and the banner simply doesn't render.
      } catch {
        if (signal.aborted) return;
        // Surface the failure: whole-pane error on the first page, inline
        // "Load more" error otherwise — never swallowed.
        if (isFirst) setError(true);
        else setLoadMoreError(true);
      } finally {
        if (!signal.aborted) {
          if (isFirst) setLoading(false);
          else setLoadingMore(false);
        }
      }
    },
    [deviceId]
  );

  // Reload from page 1 whenever the device changes; abort any in-flight request
  // (initial or load-more) on switch/unmount.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadedPage(0);
    void loadPage(1, controller.signal);
    return () => controller.abort();
  }, [loadPage]);

  // Report whether the pane has anything worth showing so the parent can collapse
  // the rail when it's empty. Skip while loading OR errored: an error is not
  // "no content", and collapsing on error would shove the "Couldn't load /
  // Retry" pane into a narrow strip. On error the parent keeps its prior layout.
  useEffect(() => {
    if (loading || error) return;
    onHasContentChange?.(events.length > 0 || activeAlerts > 0);
  }, [loading, error, events.length, activeAlerts, onHasContentChange]);

  // Retry the whole pane from page 1 on a fresh controller (the mount effect's
  // controller is aborted once its cleanup runs).
  const reload = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadedPage(0);
    void loadPage(1, controller.signal);
  }, [loadPage]);

  const loadMore = useCallback(() => {
    const signal = abortRef.current?.signal;
    if (!signal || signal.aborted || loadMoreInFlight.current) return;
    loadMoreInFlight.current = true;
    void loadPage(loadedPage + 1, signal).finally(() => {
      loadMoreInFlight.current = false;
    });
  }, [loadedPage, loadPage]);

  const visible = events;

  // Total noteworthy items for the collapsed-bar badge: recent actions plus any
  // active alerts (an alert with no events is still worth surfacing).
  const itemCount = events.length + activeAlerts;
  const countLabel = itemCount > 99 ? '99+' : `${itemCount}${hasMore ? '+' : ''}`;

  return (
    <>
      {/* Collapsed state — a thin vertical handle (desktop only; below lg the
          full card always renders). Clicking it expands the rail. */}
      {collapsed && (
        <button
          type="button"
          onClick={onToggleCollapse}
          data-testid="activity-rail-collapsed"
          aria-label={
            `Expand activity` +
            (itemCount > 0 ? ` (${itemCount} item${itemCount === 1 ? '' : 's'})` : '') +
            (activeAlerts > 0 ? `, ${activeAlerts} active alert${activeAlerts === 1 ? '' : 's'}` : '')
          }
          className={`hidden w-full flex-col items-center gap-3 rounded-lg border bg-card py-4 shadow-xs transition hover:bg-muted/50 lg:flex lg:h-full ${
            activeAlerts > 0 ? 'border-warning/40' : ''
          }`}
        >
          <Activity className={`h-4 w-4 ${activeAlerts > 0 ? 'text-warning' : 'text-muted-foreground'}`} />
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : itemCount > 0 ? (
            <span
              className={`rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
                activeAlerts > 0 ? 'bg-warning/15 text-warning' : 'bg-primary/10 text-primary'
              }`}
            >
              {countLabel}
            </span>
          ) : null}
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground [writing-mode:vertical-rl]">
            Activity
          </span>
          <ChevronLeft className="mt-auto h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </button>
      )}

      {/* Expanded card — hidden on desktop while collapsed so it never overflows
          the 44px rail; always visible below lg. */}
      <div className={`rounded-lg border bg-card p-6 shadow-xs ${collapsed ? 'lg:hidden' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Activity</h3>
        </div>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Collapse activity"
            className="hidden rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground lg:inline-flex"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
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
            <button
              type="button"
              onClick={reload}
              className="font-medium text-primary hover:underline"
            >
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
              const failed = e.result === 'failure' || e.result === 'denied';
              // Tag the automated-dispatch rows (the agent.command.* family the
              // server returns only for non-user actors) as "Automated". Keyed on
              // the action, not actor.type, so other system-actor rows aren't
              // mislabeled — and an explicit initiatedBy label still wins.
              const automated = !initiator && (e.action ?? '').startsWith(AUTOMATED_ACTION_PREFIX);
              const namedActor = e.actor?.name && e.actor.name !== 'System' ? e.actor.name : undefined;
              // For automated rows the "Automated" chip already conveys the actor,
              // so drop the generic "System" label and keep only a real name.
              const who = automated ? namedActor : namedActor ?? initiator ?? e.actor?.name;
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
                      {automated && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Automated
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

        {!loading && !error && hasMore && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="text-sm font-medium text-primary hover:underline disabled:opacity-60"
            >
              {loadingMore ? 'Loading…' : loadMoreError ? 'Try again' : 'Load more'}
            </button>
            {loadMoreError && !loadingMore && (
              <span className="text-xs text-destructive">Couldn&apos;t load more.</span>
            )}
          </div>
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
    </>
  );
}
