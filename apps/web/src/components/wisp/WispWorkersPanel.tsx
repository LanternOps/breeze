import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActivityItem } from '@breeze/shared';
import { formatRelativeTime } from '@/lib/utils';
import { fetchWispActivity, safeActivityHref } from './wispActivity';

const MAX_ROWS = 5;
const FETCH_LIMIT = 50;
/** Refetch cadence while any listed specialist is still queued, running or waiting on an approval. */
const POLL_INTERVAL_MS = 10_000;

const WORKER_STATUS_KEYS = ['queued', 'running', 'awaiting_approval', 'completed', 'failed'] as const;
// A row with a pending approval is live too: it flips to "Approvals decided"
// when someone decides, and nothing else would refetch it.
const isLive = (i: ActivityItem) =>
  i.runStatus === 'queued' || i.runStatus === 'running' || (i.runStatus === 'awaiting_approval' && (i.pendingApprovals ?? 0) > 0);

/**
 * The label to show and, while a step is still waiting, where to decide it.
 * A run never leaves `awaiting_approval` today (#11965), so that status only
 * means "waiting" while the API still counts a pending step. An older API
 * sends no count; the raw status is the best there is then.
 */
function workerStatus(item: ActivityItem): { key: string; href: string | null } | null {
  if (!item.runStatus || !(WORKER_STATUS_KEYS as readonly string[]).includes(item.runStatus)) return null;
  if (item.runStatus !== 'awaiting_approval' || item.pendingApprovals === undefined) {
    return { key: item.runStatus, href: null };
  }
  if (item.pendingApprovals === 0) return { key: 'approvals_decided', href: null };
  return {
    key: 'awaiting_approval',
    href: item.pendingIntentId ? `/approvals#intent-${encodeURIComponent(item.pendingIntentId)}` : '/approvals',
  };
}

export default function WispWorkersPanel({ threadId, refreshKey = 0 }: { threadId: string; refreshKey?: number }) {
  const { t } = useTranslation('ai');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const polling = items.some(isLive);
  const [tick, setTick] = useState(0);

  // Poll only while something is live; the interval is torn down the moment
  // the list settles (or on unmount) so an idle panel makes no requests.
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => setTick((n) => n + 1), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [polling]);

  useEffect(() => {
    // Cleanup flips this, so an unmounted or outdated request never commits.
    let current = true;
    fetchWispActivity(threadId, null, FETCH_LIMIT)
      .then((page) => {
        if (!current) return;
        setItems(page.items.filter((i) => i.kind === 'specialist').slice(0, MAX_ROWS));
        setFailed(false);
        setLoaded(true);
      })
      .catch((err) => {
        console.error('[WispWorkersPanel] loading workers failed', err);
        if (!current) return;
        setFailed(true);
        setLoaded(true);
      });
    return () => { current = false; };
  }, [threadId, refreshKey, tick]);

  return (
    <section data-testid="wisp-workers">
      <div className="px-4 py-3">
        <h2 className="text-sm font-semibold">{t('wisp.rail.workersTitle')}</h2>
      </div>
      <div className="space-y-2 px-4 pb-3">
        {failed && (
          <p data-testid="wisp-workers-load-error" className="text-xs text-destructive">{t('wisp.activity.loadFailed')}</p>
        )}
        {loaded && !failed && items.length === 0 && (
          <p data-testid="wisp-workers-empty" className="text-xs text-muted-foreground">{t('wisp.rail.workersEmpty')}</p>
        )}
        {!failed && items.length > 0 && (
          <ul className="space-y-2">
            {items.map((item) => {
              const href = safeActivityHref(item.href);
              const status = workerStatus(item);
              const statusLabel = status && t(/* i18n-dynamic */ `wisp.rail.workerStatus.${status.key}`);
              return (
                <li key={item.id} data-testid="wisp-worker-row" className="text-xs">
                  <div className="flex items-baseline gap-2">
                    {href ? (
                      <a href={href} className="font-medium hover:underline">{item.title}</a>
                    ) : (
                      <span className="font-medium">{item.title}</span>
                    )}
                    {status && (status.href ? (
                      <a href={status.href} className="shrink-0 font-medium text-primary hover:underline">
                        <span data-testid="wisp-worker-status">{statusLabel}</span>
                      </a>
                    ) : (
                      <span data-testid="wisp-worker-status" className="shrink-0 text-muted-foreground">
                        {statusLabel}
                      </span>
                    ))}
                    <span className="ml-auto shrink-0 text-muted-foreground">{formatRelativeTime(new Date(item.at))}</span>
                  </div>
                  {item.detail && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.detail}</p>}
                </li>
              );
            })}
          </ul>
        )}
        <a href="/ai-agents/runs" className="inline-block text-xs text-primary hover:underline">{t('wisp.rail.allRuns')}</a>
      </div>
    </section>
  );
}
