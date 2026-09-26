import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TopologyImpactResponse } from '@breeze/shared';
import { TopologyReadError } from './topologyApi';
import { topologyOperationsApi, type ImpactSubject } from './topologyOperationsApi';

const humanize = (reason: string) => reason.replaceAll('_', ' ');

/**
 * Cautious incident impact for the selected node or connection (M3 Task 10
 * read). Loaded only when asked: fresh measured failures stay separate from
 * entities that only POSSIBLY depend on the subject, every possible entry
 * states its path uncertainty, and the view says plainly that it never changes
 * an alert. Pinned to the map revision the user is looking at; a changed map is
 * a visible 409, never a silent re-read.
 */
export default function ImpactPanel({ siteId, subject, graphRevision, onSelectNode }: {
  siteId: string; subject: ImpactSubject; graphRevision: string; onSelectNode?: (nodeId: string) => void;
}) {
  const { t } = useTranslation('topology');
  const [impact, setImpact] = useState<TopologyImpactResponse | null>(null);
  const [error, setError] = useState<string>(), [changed, setChanged] = useState(false), [loading, setLoading] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { setImpact(null); setError(undefined); setChanged(false); abort.current?.abort(); }, [siteId, subject.kind, subject.id]);
  useEffect(() => () => abort.current?.abort(), []);
  const load = async () => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setLoading(true); setError(undefined); setChanged(false);
    try {
      const next = await topologyOperationsApi.impact(siteId, subject, graphRevision, 5, controller.signal);
      if (!controller.signal.aborted) setImpact(next);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof TopologyReadError && cause.status === 409) { setImpact(null); setChanged(true); }
      else setError(cause instanceof Error ? cause.message : t('operations.loadFailed'));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };
  return <section data-testid="topology-impact" aria-labelledby="topology-impact-heading" className="space-y-2 border-t pt-3 text-sm">
    <h4 id="topology-impact-heading" className="font-medium">{t('operations.impact.heading')}</h4>
    <button data-testid="topology-impact-load" className="rounded border px-3 py-1 disabled:opacity-50" disabled={loading} onClick={() => void load()}>{impact ? t('operations.impact.reload') : t('operations.impact.load')}</button>
    {loading && <p role="status" className="text-muted-foreground">{t('loading')}</p>}
    {changed && <p data-testid="topology-impact-changed" role="alert">{t('operations.impact.changed')}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {impact && <>
      <p data-testid="topology-impact-no-alerts" className="text-xs text-muted-foreground">{t('operations.impact.noAlerts')}</p>
      {!impact.subject.measured && <p data-testid="topology-impact-hypothetical" role="note" className="rounded border border-amber-500/50 p-2">{t('operations.impact.hypothetical')}</p>}
      {impact.coverage === 'partial' && <p data-testid="topology-impact-partial" role="note" className="rounded border border-amber-500/50 p-2">{t('operations.impact.partial', { reasons: impact.reasons.map(humanize).join(', ') })}</p>}
      <div data-testid="topology-impact-measured"><p className="font-medium">{t('operations.impact.measured')}</p>
        {!impact.measuredFailures.length ? <p className="text-muted-foreground">{t('operations.impact.noMeasured', { minutes: impact.window.minutes })}</p>
          : <ul>{impact.measuredFailures.map((failure) => <li key={`${failure.kind}/${failure.id}`} data-testid="topology-impact-measured-item">
            {t(/* i18n-dynamic */ `healthStatus.${failure.status}`)} · {failure.kind} {failure.id.slice(0, 8)}{failure.reasons.length ? ` · ${failure.reasons.map(humanize).join(', ')}` : ''}</li>)}</ul>}</div>
      <div data-testid="topology-impact-potential"><p className="font-medium">{t('operations.impact.potential')}</p>
        {!impact.potentiallyAffected.length ? <p className="text-muted-foreground">{t('operations.impact.noPotential')}</p>
          : <ul className="space-y-1">{impact.potentiallyAffected.map((entry) => {
            const pathReason = entry.reasons.find((reason) => ['alternative_path_unverified', 'no_known_alternative_path', 'group_member_possible'].includes(reason));
            return <li key={entry.id} data-testid="topology-impact-potential-item" className="break-words">
              {onSelectNode ? <button className="text-primary underline" onClick={() => onSelectNode(entry.id)}>{entry.label}</button> : <span className="font-medium">{entry.label}</span>}
              {' · '}{t(/* i18n-dynamic */ `operations.impact.basis.${entry.basis}`)} · {t('operations.impact.hops', { count: entry.hops })}
              {pathReason && <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ `operations.impact.pathReason.${pathReason}`)}</span>}
            </li>;
          })}</ul>}
        {impact.counts.omittedPotentiallyAffected > 0 && <p className="text-xs text-muted-foreground">{t('operations.impact.omittedCount', { count: impact.counts.omittedPotentiallyAffected })}</p>}
      </div>
      {impact.alternatives.length > 0 && <p data-testid="topology-impact-alternatives">{t('operations.impact.alternatives', { count: impact.alternatives.length })}</p>}
      {impact.routedPaths.map((path) => <p key={path.stepId} data-testid="topology-impact-routed">{t('operations.impact.routed', { responding: path.respondingHops, gaps: path.gapHops })} · {path.destinationReached ? t('operations.trace.reached') : t('operations.trace.notReached')}</p>)}
      <p data-testid="topology-impact-cause">{t(/* i18n-dynamic */ `operations.impact.cause.${impact.causeSuggestion.state}`, { count: impact.causeSuggestion.corroboratingIds.length })}</p>
      {impact.assumptions.length > 0 && <p className="text-xs text-muted-foreground">{t('operations.impact.assumptions', { items: impact.assumptions.map(humanize).join(', ') })}</p>}
    </>}
  </section>;
}
