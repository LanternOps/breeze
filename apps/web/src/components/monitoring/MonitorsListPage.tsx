import { useHashState } from '@/lib/useHashState';
import { useOrgStore } from '../../stores/orgStore';
import ConversionLedger from './conversion/ConversionLedger';
import ConversionPendingBanner from './conversion/ConversionPendingBanner';
import PendingPoliciesList from './conversion/PendingPoliciesList';
import LegacyRulesTable from './LegacyRulesTable';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';
import { ScopeBadge } from '../shared/ScopeBadge';
import { BuiltInBadge } from './BuiltInBadge';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { Switch } from '../pam/ui';
import AlertsTabStrip from '../alerts/AlertsTabStrip';
import RecommendedMonitors from './RecommendedMonitors';
import type { MonitorKind } from '@breeze/shared';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type MonitorRow = {
  id: string;
  name: string;
  kind: MonitorKind;
  severity: string;
  enabled: boolean;
  orgId: string | null;
  partnerId: string | null;
  builtinKey?: string | null;
  attachmentCount?: number;
};

type ListView = 'all' | 'needs-conversion';

export default function MonitorsListPage() {
  const { t } = useTranslation(['monitoring', 'common']);
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [view] = useHashState<ListView>('all', (hash) => (hash === 'needs-conversion' ? 'needs-conversion' : undefined));
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const showView = (next: ListView) => { window.location.hash = next === 'all' ? '' : next; };
  const [ledgerRevision, setLedgerRevision] = useState(0);
  const [rows, setRows] = useState<MonitorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<MonitorRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchMonitors = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/monitor-definitions');
      if (!response.ok) throw new Error(stableT('monitoring:list.errors.fetch'));
      const data = await response.json();
      setRows(Array.isArray(data?.data) ? data.data : []);
      setLedgerRevision((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('monitoring:list.errors.fetch'));
    } finally {
      setLoading(false);
    }
  }, [stableT]);

  useEffect(() => {
    void fetchMonitors();
  }, [fetchMonitors]);

  const handleToggleEnabled = async (row: MonitorRow) => {
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/monitor-definitions/${row.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: !row.enabled }),
          }),
        errorFallback: t('monitoring:list.errors.toggle'),
        onUnauthorized: UNAUTHORIZED,
      });
      void fetchMonitors();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('monitoring:list.errors.toggle'));
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/monitor-definitions/${pendingDelete.id}`, { method: 'DELETE' }),
        errorFallback: t('monitoring:list.errors.delete'),
        onUnauthorized: UNAUTHORIZED,
      });
      setPendingDelete(null);
      void fetchMonitors();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('monitoring:list.errors.delete'));
    } finally {
      setDeleting(false);
    }
  };

  const deployedToLabel = (row: MonitorRow) => {
    const count = row.attachmentCount ?? 0;
    if (count === 0) return t('monitoring:list.notDeployed');
    return t('monitoring:list.policiesCount', { count });
  };

  const renderName = (row: MonitorRow) => (
    <button
      type="button"
      onClick={() => void navigateTo(`/alerts/monitors/${row.id}`)}
      className="text-left text-primary hover:underline"
    >
      {row.name}
    </button>
  );

  const renderActions = (row: MonitorRow) => (
    <button
      type="button"
      data-testid={`monitors-list-delete-${row.id}`}
      onClick={() => setPendingDelete(row)}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
      aria-label={t('monitoring:editor.actions.delete')}
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );

  const renderEnabledToggle = (row: MonitorRow) => (
    <Switch
      checked={row.enabled}
      onToggle={() => void handleToggleEnabled(row)}
      testId={`monitors-list-enabled-${row.id}`}
      ariaLabel={t('monitoring:list.toggleEnabled', { name: row.name })}
    />
  );

  return (
    <div className="space-y-6" data-testid="monitors-list-page">
      <AlertsTabStrip currentPath="/alerts/monitors" />
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('monitoring:list.title')}</h1>
          <p className="text-muted-foreground">{t('monitoring:list.description')}</p>
        </div>
        <button
          type="button"
          data-testid="monitors-list-new"
          onClick={() => void navigateTo('/alerts/monitors/new')}
          className="flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('monitoring:list.new')}
        </button>
      </div>

      <ConversionPendingBanner orgId={currentOrgId} onReview={() => showView('needs-conversion')} onConverted={() => void fetchMonitors()} revision={ledgerRevision} />
      <div className="flex gap-2" role="tablist" aria-label={t('monitoring:list.views.ariaLabel')}>
        {(['all', 'needs-conversion'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            data-testid={`monitors-list-view-${v}`}
            onClick={() => showView(v)}
            className={`rounded-md border px-3 py-1.5 text-sm ${view === v ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}
          >
            {v === 'all' ? t('monitoring:list.views.all') : t('monitoring:list.views.needsConversion')}
          </button>
        ))}
      </div>
      {view === 'needs-conversion' ? (
        <div className="space-y-6" data-testid="monitors-list-needs-conversion">
          <PendingPoliciesList orgId={currentOrgId} revision={ledgerRevision} />
          <div>
            <h2 className="text-sm font-semibold">{t('monitoring:legacy.title')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('monitoring:legacy.description')}</p>
            <div className="mt-2">
              <LegacyRulesTable onConverted={() => void fetchMonitors()} />
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Only after a successful load: a failed read must never read as "nothing deployed". */}
          {!loading && !error && <RecommendedMonitors rows={rows} onAttached={() => void fetchMonitors()} />}

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && rows.length === 0 && !error && (
            <div className="rounded-md border border-dashed p-6 text-center">
              <p className="text-sm text-muted-foreground">{t('monitoring:list.empty')}</p>
            </div>
          )}

          {rows.length > 0 && (
            <ResponsiveTable
              table={
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-left text-xs font-medium uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">{t('monitoring:list.columns.name')}</th>
                      <th className="px-4 py-3">{t('monitoring:list.columns.kind')}</th>
                      <th className="px-4 py-3">{t('monitoring:list.columns.severity')}</th>
                      <th className="px-4 py-3">{t('monitoring:list.columns.deployedTo')}</th>
                      <th className="px-4 py-3">{t('monitoring:list.columns.owner')}</th>
                      <th className="px-4 py-3">{t('monitoring:list.columns.enabled')}</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row) => (
                      <tr key={row.id} data-testid={`monitors-list-row-${row.id}`}>
                        <td className="px-4 py-3">{renderName(row)}</td>
                        <td className="px-4 py-3">{t(/* i18n-dynamic */ `monitoring:kinds.${row.kind}`)}</td>
                        <td className="px-4 py-3">{t(/* i18n-dynamic */ `monitoring:severities.${row.severity}`)}</td>
                        <td className="px-4 py-3">{deployedToLabel(row)}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5">
                            <ScopeBadge orgId={row.orgId} partnerId={row.partnerId} isSystem={false} />
                            {row.builtinKey && <BuiltInBadge label={t('monitoring:list.builtIn')} hint={t('monitoring:list.builtInHint')} />}
                          </span>
                        </td>
                        <td className="px-4 py-3">{renderEnabledToggle(row)}</td>
                        <td className="px-4 py-3 text-right">{renderActions(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              }
              cards={
                <>
                  {rows.map((row) => (
                    <DataCard key={row.id}>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          {renderName(row)}
                          <span className="inline-flex items-center gap-1.5">
                            <ScopeBadge orgId={row.orgId} partnerId={row.partnerId} isSystem={false} />
                            {row.builtinKey && <BuiltInBadge label={t('monitoring:list.builtIn')} hint={t('monitoring:list.builtInHint')} />}
                          </span>
                        </div>
                        <CardField label={t('monitoring:list.columns.kind')}>
                          {t(/* i18n-dynamic */ `monitoring:kinds.${row.kind}`)}
                        </CardField>
                        <CardField label={t('monitoring:list.columns.severity')}>
                          {t(/* i18n-dynamic */ `monitoring:severities.${row.severity}`)}
                        </CardField>
                        <CardField label={t('monitoring:list.columns.deployedTo')}>{deployedToLabel(row)}</CardField>
                        <CardActions>
                          {renderEnabledToggle(row)}
                          {renderActions(row)}
                        </CardActions>
                      </div>
                    </DataCard>
                  ))}
                </>
              }
            />
          )}

        </>
      )}

      <ConversionLedger orgId={currentOrgId ?? undefined} revision={ledgerRevision} onChanged={() => void fetchMonitors()} />

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title={t('monitoring:list.columns.name')}
        message={t('monitoring:list.deleteConfirm', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('monitoring:editor.actions.delete')}
        isLoading={deleting}
        confirmTestId="monitors-list-delete-confirm"
      />
    </div>
  );
}
