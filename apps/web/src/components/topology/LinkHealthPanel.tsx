import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TopologyInterfaceMeasurement, TopologyLinkHealthResponse } from '@breeze/shared';
import { topologyApi } from './topologyApi';
import { topologyHealthLabel } from './topologyPresentation';
import { formatCapacity, formatMetric, formatTime } from './topologyOperationsFormat';

type Side = 'source' | 'target';

/**
 * Current link health with each endpoint port's OWN latest measurement (M3
 * Task 6 read). Passive: one GET per relationship/refresh; no timer. Unknown is
 * never shown as healthy, a port with no canonical identity is "Port not
 * identified", and a null rate is "Not measured" with its reason.
 */
export default function LinkHealthPanel({ siteId, relationshipId, labels, onOpenHistory, refresh = 0 }: {
  siteId: string; relationshipId: string; labels: Record<Side, string | null>;
  onOpenHistory: (interfaceId: string, label: string) => void; refresh?: number | string;
}) {
  const { t } = useTranslation('topology');
  const [health, setHealth] = useState<TopologyLinkHealthResponse | null>(null), [error, setError] = useState<string>();
  useEffect(() => {
    setHealth(null); setError(undefined);
    const abort = new AbortController();
    void topologyApi.linkHealth(siteId, relationshipId, abort.signal).then((next) => { if (!abort.signal.aborted) setHealth(next); })
      .catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : t('operations.loadFailed')); });
    return () => abort.abort();
  }, [siteId, relationshipId, refresh]);
  if (error) return <p data-testid="topology-link-health-error" role="alert" className="text-sm text-destructive">{error}</p>;
  if (!health) return <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>;
  const measured = health.health.status !== 'unknown' && health.health.freshness !== 'unknown' && !!(health.endpoints.source || health.endpoints.target);
  return <section data-testid="topology-link-health" aria-labelledby="topology-link-health-heading" className="space-y-2 border-t pt-3 text-sm">
    <h4 id="topology-link-health-heading" className="font-medium">{t('operations.link.heading')}</h4>
    <p data-testid="topology-link-status">{t(/* i18n-dynamic */ `healthStatus.${health.health.status}`, { defaultValue: topologyHealthLabel(health.health.status, health.health.reasons) })} · {health.health.coverage}</p>
    <p data-testid="topology-health-freshness">{measured && health.freshUntil ? t('operations.link.freshUntil', { time: formatTime(health.freshUntil) }) : t('notMeasured')}</p>
    {!health.interfaceEvidence.applies && <p data-testid="topology-link-interface-evidence" className="text-muted-foreground">{t('operations.link.notApplicable')}</p>}
    {health.interfaceEvidence.applies && (['source', 'target'] as const).map((side) => <Endpoint key={side} side={side} measurement={health.endpoints[side]} label={labels[side]} onOpenHistory={onOpenHistory} />)}
  </section>;
}

function Endpoint({ side, measurement, label, onOpenHistory }: { side: Side; measurement: TopologyInterfaceMeasurement | null; label: string | null; onOpenHistory: (interfaceId: string, label: string) => void }) {
  const { t } = useTranslation('topology');
  const name = label ?? t('operations.link.portNotIdentified');
  return <div data-testid={`topology-link-endpoint-${side}`} className="space-y-1 rounded border p-2">
    <p className="font-medium">{t(/* i18n-dynamic */ `operations.link.endpoint.${side}`)}: <span className="break-words">{measurement ? name : t('operations.link.portNotIdentified')}</span></p>
    {measurement && <>
      {measurement.retired && <p className="text-muted-foreground">{t('operations.link.retired')}</p>}
      <p>{t(/* i18n-dynamic */ `healthStatus.${measurement.status}`)} · {measurement.freshness}</p>
      <p>{t('operations.link.adminOper', { admin: measurement.adminStatus ?? t('notMeasured'), oper: measurement.operStatus ?? t('notMeasured') })}</p>
      <p>{t('operations.link.capacity', { capacity: formatCapacity(measurement.capacityBps) ?? t('notMeasured') })}</p>
      {measurement.observedAt && <p className="text-muted-foreground">{t('operations.link.observed', { time: formatTime(measurement.observedAt) })}</p>}
      {measurement.rates && <ul aria-label={t('operations.link.rates')}>{measurement.rates.values.map((rate) => <li key={rate.name}>
        {t(/* i18n-dynamic */ `operations.history.series.${rate.name}`)}: {rate.value === null ? `${t('notMeasured')}${rate.reason ? ` (${rate.reason.replaceAll('_', ' ')})` : ''}` : formatMetric(rate.value, rate.unit)}
      </li>)}</ul>}
      {measurement.reasons.length > 0 && <p className="text-muted-foreground">{measurement.reasons.map((reason) => reason.replaceAll('_', ' ')).join(', ')}</p>}
      <button data-testid={`topology-history-open-${side}`} className="rounded border px-2 py-1" onClick={() => onOpenHistory(measurement.interfaceId, name)}>{t('operations.link.openHistory')}</button>
    </>}
  </div>;
}
