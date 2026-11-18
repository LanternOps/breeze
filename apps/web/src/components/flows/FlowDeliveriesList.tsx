import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { isFlowAdmissionRefusal, type FlowWebhookDeliveryDto } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { cn } from '@/lib/utils';
import { useOrgStore } from '../../stores/orgStore';
import { listWebhookDeliveries } from './api';

const PAGE = 50;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; deliveries: FlowWebhookDeliveryDto[]; identifiersHidden: boolean; more: boolean }
  | { kind: 'error' };

const STATUS_TONE: Record<FlowWebhookDeliveryDto['status'], string> = {
  accepted: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  org_unresolved: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  refused: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  invalid_body: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

/**
 * The webhook delivery log (Tool Catalog W05 #5220, Decision 2): authenticated
 * deliveries only (unauthenticated ones are never rows). A site- or
 * device-limited reader gets the sender-supplied identifiers (delivery id,
 * org-resolver value) nulled by the API, and is told they are hidden.
 */
export function FlowDeliveriesList({ flowId }: { flowId: string }) {
  const { t } = useTranslation('flows');
  const orgs = useOrgStore((s) => s.organizations) as Array<{ id: string; name: string }>;
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    listWebhookDeliveries(flowId, { limit: PAGE })
      .then(({ deliveries, identifiersHidden }) => {
        if (!cancelled) setState({ kind: 'ready', deliveries, identifiersHidden, more: deliveries.length === PAGE });
      })
      .catch((err: unknown) => {
        console.error('[FlowDeliveriesList] could not load deliveries', err);
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  const loadMore = async () => {
    if (state.kind !== 'ready' || loadingMore) return;
    const last = state.deliveries[state.deliveries.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await listWebhookDeliveries(flowId, { limit: PAGE, before: last.receivedAt });
      setState({
        kind: 'ready',
        deliveries: [...state.deliveries, ...page.deliveries],
        identifiersHidden: state.identifiersHidden || page.identifiersHidden,
        more: page.deliveries.length === PAGE,
      });
    } catch (err) {
      console.error('[FlowDeliveriesList] could not load more deliveries', err);
      setState({ kind: 'error' });
    } finally {
      setLoadingMore(false);
    }
  };

  const orgName = (id: string | null) => (id ? orgs?.find((o) => o.id === id)?.name ?? id : '—');
  const refusal = (code: string | null) =>
    code === null ? null : isFlowAdmissionRefusal(code) ? t(/* i18n-dynamic */ `usage.refused.${code}`) : code;

  return (
    <section className="space-y-2" data-testid="flow-deliveries">
      <h2 className="text-sm font-semibold">{t('deliveries.title')}</h2>
      {state.kind === 'loading' && <p className="text-sm text-muted-foreground">{t('runDetail.step.loading')}</p>}
      {state.kind === 'error' && (
        <p className="text-sm text-destructive" data-testid="flow-deliveries-error">{t('deliveries.loadFailed')}</p>
      )}
      {state.kind === 'ready' && state.deliveries.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="flow-deliveries-empty">{t('deliveries.empty')}</p>
      )}
      {state.kind === 'ready' && state.deliveries.length > 0 && (
        <>
          {state.identifiersHidden && (
            <p className="text-xs text-muted-foreground" data-testid="flow-deliveries-hidden">{t('deliveries.hidden')}</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="p-2 font-medium">{t('deliveries.columns.received')}</th>
                  <th className="p-2 font-medium">{t('deliveries.columns.status')}</th>
                  <th className="p-2 font-medium">{t('deliveries.columns.org')}</th>
                  <th className="p-2 font-medium">{t('deliveries.columns.run')}</th>
                  <th className="p-2 font-medium">{t('deliveries.columns.attempts')}</th>
                  <th className="p-2 font-medium">{t('deliveries.columns.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {state.deliveries.map((d) => (
                  <tr key={d.id} className="border-t align-top" data-testid={`flow-delivery-${d.id}`}>
                    <td className="whitespace-nowrap p-2">{formatDateTime(d.receivedAt)}</td>
                    <td className="p-2">
                      <span className={cn('rounded px-1.5 py-0.5 text-xs', STATUS_TONE[d.status])}>
                        {t(/* i18n-dynamic */ `deliveries.status.${d.status}`)}
                      </span>
                    </td>
                    <td className="p-2">{orgName(d.orgId)}</td>
                    <td className="p-2">
                      {d.runId ? (
                        <a className="text-primary hover:underline" href={`/flows/runs/${d.runId}`} data-testid={`flow-delivery-run-${d.id}`}>
                          {t('deliveries.openRun')}
                        </a>
                      ) : '—'}
                    </td>
                    <td className="p-2">{d.attempts}</td>
                    <td className="space-y-0.5 p-2 text-xs text-muted-foreground">
                      {refusal(d.refusalCode) && <div>{refusal(d.refusalCode)}</div>}
                      {d.status === 'org_unresolved' && d.resolverValue !== null && (
                        <div className="font-mono">{t('deliveries.resolverValue', { value: d.resolverValue })}</div>
                      )}
                      {d.deliveryId !== null && <div className="font-mono">{t('deliveries.deliveryId', { id: d.deliveryId })}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.more && (
            <button type="button" className="rounded border px-3 py-1 text-sm" disabled={loadingMore} onClick={loadMore} data-testid="flow-deliveries-more">
              {t('deliveries.loadMore')}
            </button>
          )}
        </>
      )}
    </section>
  );
}
