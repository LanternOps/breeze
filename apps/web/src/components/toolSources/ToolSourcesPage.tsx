import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Plus } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { Dialog } from '../shared/Dialog';
import { ResponsiveTable, DataCard } from '../shared/ResponsiveTable';
import { ScopeBadge } from '../shared/ScopeBadge';
import { listToolSources, type ToolSourceDto } from './api';
import { ToolSourceForm } from './ToolSourceForm';
import { StatusChip, formatDiscoveredAt } from './statusChip';

/**
 * Tool sources list (#5216 W01 PR C). Read-only apart from "Add source"; a
 * source's tools, credentials and lifecycle live on its detail page.
 */
export default function ToolSourcesPage() {
  const { t } = useTranslation('toolSources');
  const [sources, setSources] = useState<ToolSourceDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setSources(await listToolSources(fetchWithAuth));
      setLoadError(null);
    } catch {
      // A failed LIST is not a mutation, so it does not go through runAction —
      // but it must still be visible rather than an eternal empty state.
      setLoadError(t('list.loadFailed'));
      setSources([]);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = sources ?? [];

  return (
    <div className="space-y-4 p-4" data-testid="tool-sources-page">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <button
          type="button"
          data-testid="tool-sources-add"
          className="flex h-9 items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground"
          onClick={() => setCreating(true)}
        >
          <Plus className="h-4 w-4" />
          {t('list.add')}
        </button>
      </header>

      {loadError && <p data-testid="tool-sources-error" className="text-sm text-destructive">{loadError}</p>}

      {sources !== null && rows.length === 0 && !loadError ? (
        <div data-testid="tool-sources-empty" className="rounded-md border border-dashed p-8 text-center">
          <p className="font-medium">{t('empty.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('empty.body')}</p>
        </div>
      ) : (
        <ResponsiveTable
          table={
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">{t('list.name')}</th>
                  <th className="p-2">{t('list.kind')}</th>
                  <th className="p-2">{t('list.status')}</th>
                  <th className="p-2">{t('list.tools')}</th>
                  <th className="p-2">{t('list.lastDiscovered')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((source) => (
                  <tr key={source.id} data-testid={`tool-source-row-${source.id}`} className="border-t">
                    <td className="p-2">
                      <a className="font-medium hover:underline" href={`/settings/tool-sources/${source.id}`}>
                        {source.name}
                      </a>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{source.slug}</span>
                        <ScopeBadge orgId={source.orgId} partnerId={source.partnerId} isSystem={false} />
                      </div>
                    </td>
                    <td className="p-2 uppercase">{source.kind}</td>
                    <td className="p-2"><StatusChip status={source.status} lastError={source.lastError} /></td>
                    <td className="p-2">
                      {t('list.toolCount', { enabled: source.enabledToolCount, total: source.toolCount })}
                    </td>
                    <td className="p-2">{formatDiscoveredAt(source.lastDiscoveredAt) ?? t('list.never')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
          cards={
            <>
              {rows.map((source) => (
                <DataCard key={source.id}>
                  <a className="font-medium hover:underline" href={`/settings/tool-sources/${source.id}`}>
                    {source.name}
                  </a>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{source.slug}</span>
                    <ScopeBadge orgId={source.orgId} partnerId={source.partnerId} isSystem={false} />
                    <StatusChip status={source.status} lastError={source.lastError} />
                    <span>{t('list.toolCount', { enabled: source.enabledToolCount, total: source.toolCount })}</span>
                  </div>
                </DataCard>
              ))}
            </>
          }
        />
      )}

      {creating && (
        <Dialog open onClose={() => setCreating(false)} title={t('form.create')}>
          <ToolSourceForm
            source={null}
            onCancel={() => setCreating(false)}
            onSaved={(saved) => {
              setCreating(false);
              // Straight to the detail page: a freshly created source has a
              // discovery job queued and nothing to show in the list yet.
              window.location.href = `/settings/tool-sources/${saved.id}`;
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
