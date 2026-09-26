import { useTranslation } from 'react-i18next';
import type { TopologyDiagnosticRun, TopologyTraceHop } from '@breeze/shared';

type HopGroup = { ttl: number; replies: TopologyTraceHop[]; silent: TopologyTraceHop[] };

/** Group one trace's probes by TTL, keeping each silent probe as an explicit unknown. */
export function groupTraceHops(hops: readonly TopologyTraceHop[]): HopGroup[] {
  const groups = new Map<number, HopGroup>();
  for (const hop of hops) {
    const group = groups.get(hop.ttl) ?? { ttl: hop.ttl, replies: [], silent: [] };
    (hop.address === null ? group.silent : group.replies).push(hop);
    groups.set(hop.ttl, group);
  }
  return [...groups.values()].sort((a, b) => a.ttl - b.ttl);
}

/**
 * Observed routed path of a `trace_route` run (M3 Task 9 evidence). It is ICMP
 * evidence from one origin at one moment, rendered apart from topology
 * relationships and never drawn onto the map. An unanswered TTL is "Unknown
 * (no reply)": the UI never invents or guesses a responder.
 */
export default function TraceResultPanel({ run }: { run: TopologyDiagnosticRun }) {
  const { t } = useTranslation('topology');
  const traces = run.steps.flatMap((step) => step.details.trace ? [{ step, trace: step.details.trace }] : []);
  if (!traces.length) return null;
  return <>{traces.map(({ step, trace }) => <div key={step.id} data-testid="topology-trace-path" className="space-y-2 rounded border p-2 text-sm">
    <p className="font-medium">{t('operations.trace.heading')}</p>
    <p className="text-xs text-muted-foreground">{t('operations.trace.explanation')}</p>
    <p data-testid="topology-trace-outcome">{trace.destinationReached ? t('operations.trace.reached') : t('operations.trace.notReached')}
      {step.attribution.resolvedIp ? ` · ${step.attribution.resolvedIp}` : ''}</p>
    {step.attribution.routeChanged && <p className="text-amber-700 dark:text-amber-400">{t('operations.trace.routeChanged')}</p>}
    <ol data-testid="topology-trace-hops" className="space-y-1">{groupTraceHops(trace.hops).map((group) => <li key={group.ttl} data-testid="topology-trace-hop" className="break-words">
      <span className="font-medium">{t('operations.trace.hop', { ttl: group.ttl })}: </span>
      {group.replies.map((hop) => <span key={`${hop.attempt}`} className="mr-2">{hop.address}
        {hop.outcome === 'unreachable' ? ` (${t('operations.trace.unreachable', { address: hop.address })})` : hop.rttMs !== null ? ` ${hop.rttMs} ms` : ''}</span>)}
      {group.silent.map((hop) => <span key={`${hop.attempt}`} className="mr-2 text-muted-foreground">{hop.outcome === 'unsupported' ? t('operations.trace.unsupported') : t('operations.trace.unknownHop')}</span>)}
      {new Set(group.replies.map((hop) => hop.address)).size > 1 && <span className="text-xs text-muted-foreground">{t('operations.trace.alternatives')}</span>}
    </li>)}</ol>
    {trace.hopsOmitted > 0 && <p className="text-xs text-muted-foreground">{t('operations.trace.omitted', { count: trace.hopsOmitted })}</p>}
    {step.truncated && <p className="text-xs text-muted-foreground">{t('operations.trace.truncated')}</p>}
  </div>)}</>;
}
