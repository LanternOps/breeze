import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '@/lib/utils';
import { formatCurrency } from '@/lib/i18n/format';
import { useOrgStore } from '@/stores/orgStore';
import { fetchWispActivity, safeActivityHref } from './wispActivity';
import type { ActivityItem } from '@breeze/shared';

export default function WispActivityPanel({ threadId, refreshKey = 0, collapsible = false }: { threadId: string; refreshKey?: number; collapsible?: boolean }) {
  const { t } = useTranslation('ai');
  const organizations = useOrgStore((s) => s.organizations);
  const orgNames = useMemo(() => new Map((organizations ?? []).map((o) => [o.id, o.name])), [organizations]);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const showBody = !collapsible || open;

  // Only the newest load may commit (thread switch, refresh, unmount).
  const loadToken = useRef(0);
  const load = useCallback(async (cursor: string | null) => {
    const token = ++loadToken.current;
    setLoading(true);
    try {
      const page = await fetchWispActivity(threadId, cursor);
      if (token !== loadToken.current) return;
      setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setFailed(false);
    } catch (err) {
      console.error('[WispActivityPanel] loading activity failed', err);
      if (token === loadToken.current) setFailed(true);
    } finally {
      if (token === loadToken.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [threadId]);

  useEffect(() => {
    void load(null);
    return () => { loadToken.current++; };
  }, [load, refreshKey]);

  return (
    <section data-testid="wisp-activity" className="space-y-2 px-4 py-3">
      {collapsible ? (
        <button
          type="button"
          data-testid="wisp-activity-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />}
          <span className="text-sm font-semibold">{t('wisp.activity.title')}</span>
          {loaded && <span className="text-xs text-muted-foreground">{t('wisp.activity.count', { count: items.length })}</span>}
          <span className="ml-auto text-xs text-muted-foreground">{open ? t('wisp.activity.hide') : t('wisp.activity.show')}</span>
        </button>
      ) : (
        <h3 className="text-sm font-semibold">{t('wisp.activity.title')}</h3>
      )}
      {showBody && failed && (
        <p data-testid="wisp-activity-load-error" className="text-xs text-destructive">{t('wisp.activity.loadFailed')}</p>
      )}
      {showBody && loaded && !failed && items.length === 0 && (
        <p data-testid="wisp-activity-empty" className="text-xs text-muted-foreground">{t('wisp.activity.empty')}</p>
      )}
      {showBody && (
      <ul id={bodyId} className="space-y-1.5">
        {items.map((item) => {
          const href = safeActivityHref(item.href);
          const orgName = item.orgId ? orgNames.get(item.orgId) : undefined;
          return (
            <li
              key={item.id}
              data-testid="wisp-activity-row"
              data-kind={item.kind}
              className="rounded border px-2 py-1.5 text-xs"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t(/* i18n-dynamic */ `wisp.activity.kind.${item.kind}`)}
                </span>
                {href ? (
                  <a href={href} className="font-medium hover:underline">{item.title}</a>
                ) : (
                  <span className="font-medium">{item.title}</span>
                )}
                <span className="ml-auto text-muted-foreground">{formatRelativeTime(new Date(item.at))}</span>
              </div>
              {item.detail && <p className="mt-0.5 line-clamp-2 text-muted-foreground">{item.detail}</p>}
              {(orgName || (item.costCents !== null && item.costCents > 0)) && (
                <div className="mt-0.5 flex gap-2 text-muted-foreground">
                  {orgName && <span>{orgName}</span>}
                  {item.costCents !== null && item.costCents > 0 && (
                    <span>{t('wisp.activity.cost', { amount: formatCurrency(item.costCents / 100) })}</span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      )}
      {showBody && nextCursor && (
        <button
          type="button"
          data-testid="wisp-activity-load-more"
          disabled={loading}
          onClick={() => void load(nextCursor)}
          className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {t('wisp.activity.loadMore')}
        </button>
      )}
    </section>
  );
}
