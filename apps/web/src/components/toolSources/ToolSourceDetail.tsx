import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { runClientAction } from '../../lib/runClientAction';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { Dialog } from '../shared/Dialog';
import { ScopeBadge } from '../shared/ScopeBadge';
import {
  deleteToolSource,
  discoverToolSource,
  getToolSource,
  listSourceTools,
  type ToolSourceDto,
  type ToolSourceToolDto,
} from './api';
import { DiscoveredToolsTable } from './DiscoveredToolsTable';
import { ToolSourceForm } from './ToolSourceForm';
import { ToolTestDrawer } from './ToolTestDrawer';
import { StatusChip, formatDiscoveredAt } from './statusChip';

/**
 * One tool source: its connection facts, its discovered tools, and the
 * lifecycle actions (re-discover, edit, delete). Discovery is asynchronous
 * (a BullMQ job), so after queueing one the page polls the source row until
 * its `lastDiscoveredAt` moves — otherwise the tool list silently stays stale
 * and the button reads as a no-op.
 */
export default function ToolSourceDetail({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation('toolSources');
  const [source, setSource] = useState<ToolSourceDto | null>(null);
  const [tools, setTools] = useState<ToolSourceToolDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [testing, setTesting] = useState<ToolSourceToolDto | null>(null);
  const [discovering, setDiscovering] = useState(false);
  // The re-discover poll below runs for up to a minute. Without this the loop
  // keeps setting state (and issuing requests) after the user has navigated
  // away — a leak whose only symptom in production is a React warning.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async (): Promise<ToolSourceDto | null> => {
    try {
      const [loadedSource, loadedTools] = await Promise.all([
        getToolSource(fetchWithAuth, sourceId),
        listSourceTools(fetchWithAuth, sourceId),
      ]);
      if (!mounted.current) return loadedSource;
      setSource(loadedSource);
      setTools(loadedTools);
      setLoadError(null);
      return loadedSource;
    } catch {
      if (mounted.current) setLoadError(t('detail.loadFailed'));
      return null;
    }
  }, [sourceId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rediscover = async () => {
    const before = source?.lastDiscoveredAt ?? null;
    try {
      const result = await runClientAction(() => discoverToolSource(fetchWithAuth, sourceId), {
        errorFallback: t('toasts.discoveryFailed'),
        successMessage: (result) => result?.warning ? '' : t('toasts.discoveryQueued'),
      });
      if (result?.warning === 'discovery_not_queued') {
        showToast({ type: 'warning', message: t('toasts.discoveryNotQueued') });
        return;
      }
    } catch (err) {
      handleActionError(err, t('toasts.discoveryFailed'));
      return;
    }
    // Poll for up to ~60s. Bounded on purpose: a source whose server is down
    // never moves `lastDiscoveredAt`, and an unbounded poll would spin for the
    // life of the tab.
    setDiscovering(true);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (!mounted.current) return;
      const refreshed = await load();
      if (refreshed && refreshed.lastDiscoveredAt !== before) break;
    }
    if (mounted.current) setDiscovering(false);
  };

  const remove = async () => {
    try {
      await runClientAction(() => deleteToolSource(fetchWithAuth, sourceId), {
        errorFallback: t('toasts.deleteFailed'),
        successMessage: t('toasts.deleted'),
      });
      window.location.href = '/settings/tool-sources';
    } catch (err) {
      handleActionError(err, t('toasts.deleteFailed'));
    } finally {
      setConfirmingDelete(false);
    }
  };

  if (loadError) {
    return <p data-testid="tool-source-detail-error" className="p-4 text-sm text-destructive">{loadError}</p>;
  }
  if (!source) return <div className="p-4 text-sm text-muted-foreground">{t('detail.back')}</div>;

  return (
    <div className="space-y-4 p-4" data-testid="tool-source-detail">
      <a href="/settings/tool-sources" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" />
        {t('detail.back')}
      </a>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{source.name}</h1>
            <span className="font-mono text-xs text-muted-foreground">{source.slug}</span>
            <ScopeBadge orgId={source.orgId} partnerId={source.partnerId} isSystem={false} />
            <StatusChip status={source.status} lastError={source.lastError} />
          </div>
          <p className="text-sm text-muted-foreground">
            {t('detail.endpoint')}: <span className="font-mono">{source.endpointUrl}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {t('detail.lastDiscovered')}: {formatDiscoveredAt(source.lastDiscoveredAt) ?? t('list.never')}
          </p>
          {source.status === 'error' && source.lastError && (
            <p data-testid="tool-source-last-error" className="text-sm text-destructive">{source.lastError}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="tool-source-rediscover"
            disabled={discovering}
            className="flex h-9 items-center gap-1 rounded-md border px-3 text-sm disabled:opacity-50"
            onClick={() => void rediscover()}
          >
            <RefreshCw className={discovering ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {discovering ? t('detail.discovering') : t('detail.rediscover')}
          </button>
          <button type="button" data-testid="tool-source-edit" className="h-9 rounded-md border px-3 text-sm" onClick={() => setEditing(true)}>
            {t('detail.edit')}
          </button>
          <button
            type="button"
            data-testid="tool-source-delete"
            className="h-9 rounded-md border border-destructive px-3 text-sm text-destructive"
            onClick={() => setConfirmingDelete(true)}
          >
            {t('detail.delete')}
          </button>
        </div>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('tools.heading')}</h2>
        <DiscoveredToolsTable
          sourceId={sourceId}
          tools={tools}
          onChanged={() => void load()}
          onTest={(tool) => setTesting(tool)}
        />
      </section>

      {editing && (
        <Dialog open onClose={() => setEditing(false)} title={t('form.edit')}>
          <ToolSourceForm
            source={source}
            onCancel={() => setEditing(false)}
            onSaved={(saved) => {
              setSource(saved);
              setEditing(false);
            }}
          />
        </Dialog>
      )}

      {testing && <ToolTestDrawer sourceId={sourceId} tool={testing} onClose={() => setTesting(null)} />}

      <ConfirmDialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={() => void remove()}
        title={t('detail.deleteTitle')}
        message={t('detail.deleteConfirm')}
        confirmLabel={t('detail.delete')}
        variant="destructive"
        confirmTestId="tool-source-delete-confirm"
      />
    </div>
  );
}
