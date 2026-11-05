import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActivityItem } from '@breeze/shared';
import { formatRelativeTime } from '@/lib/utils';
import { fetchWispActivity, safeActivityHref } from './wispActivity';

const MAX_ROWS = 5;
const FETCH_LIMIT = 50;

export default function WispWorkersPanel({ threadId, refreshKey = 0 }: { threadId: string; refreshKey?: number }) {
  const { t } = useTranslation('ai');
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

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
  }, [threadId, refreshKey]);

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
              return (
                <li key={item.id} data-testid="wisp-worker-row" className="text-xs">
                  <div className="flex items-baseline gap-2">
                    {href ? (
                      <a href={href} className="font-medium hover:underline">{item.title}</a>
                    ) : (
                      <span className="font-medium">{item.title}</span>
                    )}
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
