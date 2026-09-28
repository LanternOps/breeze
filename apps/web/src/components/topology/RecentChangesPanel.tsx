import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TopologyChange } from '@breeze/shared';
import { topologyOperationsApi } from './topologyOperationsApi';
import { formatTime } from './topologyOperationsFormat';

const WINDOWS = { '1h': 3_600_000, '24h': 86_400_000 } as const;
type ChangeWindow = keyof typeof WINDOWS;

/**
 * Recent topology changes of one site (M3 Task 10 read), loaded on request and
 * paged by the server cursor. Each row states what changed (attachment, route,
 * source, collection gap, measurement, configuration) and marks a change whose
 * detailed observation has aged out as "Detail expired" instead of hiding it.
 */
export default function RecentChangesPanel({ siteId }: { siteId: string }) {
  const { t } = useTranslation('topology');
  const [range, setRange] = useState<ChangeWindow>('24h');
  const [changes, setChanges] = useState<TopologyChange[] | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [loadedWindow, setLoadedWindow] = useState<{ since: string; until: string } | null>(null);
  const [error, setError] = useState<string>(), [loading, setLoading] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => { abort.current?.abort(); setChanges(null); setCursor(null); setLoadedWindow(null); }, [siteId, range]);
  const load = async (more: boolean) => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const until = new Date();
    const span = more && loadedWindow ? loadedWindow : { since: new Date(until.getTime() - WINDOWS[range]).toISOString(), until: until.toISOString() };
    setLoading(true); setError(undefined);
    try {
      const page = await topologyOperationsApi.changes(siteId, span, more ? cursor ?? undefined : undefined, controller.signal);
      if (controller.signal.aborted) return;
      setLoadedWindow(span); setCursor(page.cursor); setChanges((current) => more && current ? [...current, ...page.changes] : page.changes);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('operations.loadFailed')); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  return <section data-testid="topology-changes" aria-labelledby="topology-changes-heading" className="space-y-2 border-t pt-3 text-sm">
    <h4 id="topology-changes-heading" className="font-medium">{t('operations.changes.heading')}</h4>
    <div className="flex flex-wrap items-center gap-2">
      <label>{t('operations.changes.window')}<select data-testid="topology-changes-window" className="ml-1 rounded border bg-background p-1" value={range} onChange={(event) => setRange(event.target.value as ChangeWindow)}>
        {(Object.keys(WINDOWS) as ChangeWindow[]).map((key) => <option key={key} value={key}>{t(/* i18n-dynamic */ `operations.changes.windows.${key}`)}</option>)}</select></label>
      <button data-testid="topology-changes-load" className="rounded border px-3 py-1 disabled:opacity-50" disabled={loading} onClick={() => void load(false)}>{changes ? t('refresh') : t('operations.changes.load')}</button>
    </div>
    {loading && <p role="status" className="text-muted-foreground">{t('loading')}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {changes && !changes.length && <p data-testid="topology-changes-empty" className="text-muted-foreground">{t('operations.changes.empty')}</p>}
    {changes && changes.length > 0 && <ol className="space-y-1">{changes.map((change) => <li key={change.id} data-testid="topology-change" data-kind={change.kind} className="break-words rounded border p-2">
      <span className="font-medium">{t(/* i18n-dynamic */ `operations.changes.kinds.${change.kind}`)}</span> · {t(/* i18n-dynamic */ `operations.changes.categories.${change.category}`)}
      <span className="block text-xs text-muted-foreground">{formatTime(change.at)}
        {change.attributes.method ? ` · ${change.attributes.method}` : ''}{change.attributes.outcome ? ` · ${change.attributes.outcome}` : ''}{change.attributes.state ? ` · ${change.attributes.state}` : ''}</span>
      {change.detail === 'expired' && <span data-testid="topology-change-expired" className="text-xs text-muted-foreground">{t('operations.changes.expired')}</span>}
    </li>)}</ol>}
    {cursor && <button data-testid="topology-changes-more" className="rounded border px-3 py-1 disabled:opacity-50" disabled={loading} onClick={() => void load(true)}>{t('operations.changes.more')}</button>}
  </section>;
}
