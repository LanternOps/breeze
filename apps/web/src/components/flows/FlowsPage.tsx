import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowSummaryDto } from '@breeze/shared';
import { useFlowsGate } from '../../stores/featuresStore';
import { ResponsiveTable, DataCard } from '../shared/ResponsiveTable';
import { ScopeBadge } from '../shared/ScopeBadge';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { listFlows } from './api';

const PAGE_LIMIT = 100;

/**
 * Flows list (#5218 W3 PR B). Read-only: flows are drafted in AI chat and
 * reviewed here; enabling and runs arrive in a later release.
 */
export default function FlowsPage() {
  const { t } = useTranslation('flows');
  const { enabled, loaded } = useFlowsGate();
  const [flows, setFlows] = useState<FlowSummaryDto[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    listFlows({ limit: PAGE_LIMIT })
      .then((res) => {
        if (cancelled) return;
        setFlows(res.flows);
        setLoadFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        // A failed LIST is not "you have no flows" — say so.
        setLoadFailed(true);
        setFlows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (!enabled) {
    // Unknown (still loading /config) renders nothing; known-disabled is a 404 surface.
    return loaded ? (
      <p className="p-4 text-sm text-muted-foreground" data-testid="flow-not-found">{t('errors.notFound')}</p>
    ) : null;
  }

  const rows = flows ?? [];
  const owner = (flow: FlowSummaryDto) => (
    <ScopeBadge orgId={flow.orgId} partnerId={flow.partnerId} isSystem={false} />
  );
  const statusChip = (flow: FlowSummaryDto) => (
    <span className="rounded bg-muted px-1.5 py-0.5 text-xs" data-testid={`flow-status-${flow.id}`}>
      {t(/* i18n-dynamic */ `status.${flow.status}`)}
    </span>
  );
  const tierBadge = (flow: FlowSummaryDto) => t('step.tier', { tier: flow.effectiveTier });
  const triggerLabel = (flow: FlowSummaryDto) =>
    t(/* i18n-dynamic */ `trigger.${flow.triggerType}`, { defaultValue: flow.triggerType });

  // W05 (#5220): a monthly cap refuses runs without pausing the flow, so the
  // list says so next to the status.
  const refusedBadge = (flow: FlowSummaryDto) =>
    flow.lastAdmissionRefusal ? (
      <span
        className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        title={t(/* i18n-dynamic */ `usage.refused.${flow.lastAdmissionRefusal.code}`)}
        data-testid={`flow-refused-${flow.id}`}
      >
        {t('usage.refusedBadge')}
      </span>
    ) : null;

  return (
    <div className="space-y-4 p-4" data-testid="flows-page">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <a className="text-sm text-primary hover:underline" href="/settings/flow-limits" data-testid="flows-limits-link">
          {t('usage.limitsLink')}
        </a>
      </header>

      {loadFailed && <p data-testid="flow-error" className="text-sm text-destructive">{t('errors.loadFailed')}</p>}

      {flows !== null && rows.length === 0 && !loadFailed ? (
        <div data-testid="flow-empty" className="rounded-md border border-dashed p-8 text-center">
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
                  <th className="p-2">{t('list.owner')}</th>
                  <th className="p-2">{t('list.status')}</th>
                  <th className="p-2">{t('list.tier')}</th>
                  <th className="p-2">{t('list.trigger')}</th>
                  <th className="p-2">{t('list.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((flow) => (
                  <tr key={flow.id} data-testid={`flow-row-${flow.id}`} className="border-t">
                    <td className="p-2">
                      <a className="font-medium hover:underline" href={`/flows/${flow.id}`}>{flow.name}</a>
                      <div className="font-mono text-xs text-muted-foreground">{flow.slug}</div>
                    </td>
                    <td className="p-2">{owner(flow)}</td>
                    <td className="p-2"><div className="flex flex-wrap items-center gap-1">{statusChip(flow)}{refusedBadge(flow)}</div></td>
                    <td className="p-2">{tierBadge(flow)}</td>
                    <td className="p-2">{triggerLabel(flow)}</td>
                    <td className="p-2">{formatDateTime(flow.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
          cards={
            <>
              {rows.map((flow) => (
                <DataCard key={flow.id}>
                  <a className="font-medium hover:underline" href={`/flows/${flow.id}`}>{flow.name}</a>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{flow.slug}</span>
                    {owner(flow)}
                    {statusChip(flow)}
                    {refusedBadge(flow)}
                    <span>{tierBadge(flow)}</span>
                    <span>{triggerLabel(flow)}</span>
                  </div>
                </DataCard>
              ))}
            </>
          }
        />
      )}
    </div>
  );
}
