import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TOPOLOGY_TRACE_LIMITS, topologyCollectorsResponseSchema, topologyDiagnosticRunSchema } from '@breeze/shared/validators/topologyDiagnostics';
import type { CreateTopologyDiagnosticRequest, TopologyCollectorsResponse, TopologyDiagnosticRun } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { topologyRead } from './topologyApi';
import { parseTopologyHash, writeTopologyHash } from './topologyHash';
import TraceResultPanel from './TraceResultPanel';
const terminal = (run: TopologyDiagnosticRun) => ['completed', 'failed', 'cancelled', 'expired'].includes(run.state);

export default function TopologyDiagnosticsPanel({ siteId, subject, graphRevision, onClose }: { siteId: string; subject: CreateTopologyDiagnosticRequest['subject']; graphRevision: string; onClose: () => void }) {
  const { t } = useTranslation('topology');
  const [recipeId, setRecipeId] = useState<CreateTopologyDiagnosticRequest['recipeId']>('gateway_basic');
  const [family, setFamily] = useState<'ipv4' | 'ipv6' | 'both'>('ipv4');
  // Routed trace bounds (M3 Task 9): only hop and probe counts are requestable; the server pins timeouts.
  const [maxHops, setMaxHops] = useState<number>(TOPOLOGY_TRACE_LIMITS.defaultMaxHops), [probesPerHop, setProbesPerHop] = useState<number>(TOPOLOGY_TRACE_LIMITS.defaultProbesPerHop);
  const tracing = recipeId === 'trace_route';
  const [collectors, setCollectors] = useState<TopologyCollectorsResponse | null>(null), [origin, setOrigin] = useState('');
  const [runs, setRuns] = useState<TopologyDiagnosticRun[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null), active = useRef(true);
  const base = `/topology/sites/${siteId}`;
  useEffect(() => { active.current = true; heading.current?.focus(); return () => { active.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setCollectors(null); setOrigin(''); setError(undefined);
    const query = new URLSearchParams({ recipe: recipeId, subjectKind: subject.kind, subjectId: subject.id, graphRevision, ...(family !== 'both' ? { family } : {}) });
    void topologyRead(`${base}/collectors?${query}`, topologyCollectorsResponseSchema, controller.signal).then((result) => {
      if (controller.signal.aborted) return; setCollectors(result);
      const first = result.items.find((item) => item.eligible && (family !== 'both' || item.families.length === 2));
      if (first) setOrigin(`${first.origin.deviceId}/${first.origin.contextKey}`);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('loadFailed')); });
    return () => controller.abort();
  }, [siteId, subject.id, recipeId, family, graphRevision]);
  useEffect(() => {
    const ids = parseTopologyHash(window.location.hash)?.runIds ?? [], controller = new AbortController();
    void Promise.all(ids.map((id) => topologyRead(`${base}/diagnostic-runs/${id}`, topologyDiagnosticRunSchema, controller.signal))).then((result) => {
      if (!controller.signal.aborted) setRuns(result.filter((run) => run.plan.scope.siteId === siteId && run.plan.subject.id === subject.id));
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('loadFailed')); });
    return () => controller.abort();
  }, [siteId, subject.id]);
  useEffect(() => {
    if (!runs.some((run) => !terminal(run))) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let count = 0;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const results = await Promise.all(runs.map((run) => terminal(run) ? run : topologyRead(`${base}/diagnostic-runs/${run.id}`, topologyDiagnosticRunSchema, controller.signal)));
          if (!controller.signal.aborted) { setRuns(results); return; }
        } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('loadFailed')); }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, ++count < 5 ? 2000 : 5000);
    };
    timer = setTimeout(poll, runs.some((run) => Date.now() - Date.parse(run.queuedAt) > 10_000) ? 5000 : 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runs, siteId]);
  const selected = collectors?.items.find((item) => `${item.origin.deviceId}/${item.origin.contextKey}` === origin);
  const remember = (next: TopologyDiagnosticRun[]) => {
    setRuns(next); const navigation = parseTopologyHash(window.location.hash);
    if (navigation) writeTopologyHash({ ...navigation, runIds: next.map((run) => run.id) });
  };
  const start = async () => {
    if (!selected?.eligible || busy) return;
    setBusy(true); setError(undefined); const accepted: TopologyDiagnosticRun[] = [];
    try {
      for (const requestedFamily of family === 'both' ? ['ipv4', 'ipv6'] as const : [family]) {
        const run = await runAction({
          request: () => fetchWithAuth(`${base}/diagnostic-runs`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ recipeId, recipeVersion: 1, subject, graphRevision, family: requestedFamily, originDeviceId: selected.origin.deviceId, contextKey: selected.origin.contextKey, ...(tracing ? { trace: { maxHops, probesPerHop } } : {}) }) }),
          errorFallback: t('diagnosticFailed'), successMessage: t('diagnosticAccepted'), parseSuccess: (data) => topologyDiagnosticRunSchema.parse(data),
        });
        accepted.push(run); if (active.current) remember([...accepted]);
      }
    } catch (cause) { handleActionError(cause, t('loadFailed'));  if (active.current) setError(cause instanceof Error ? cause.message : t('diagnosticFailed')); }
    finally { if (active.current) setBusy(false); }
  };
  const stop = async (run: TopologyDiagnosticRun) => {
    try {
      const updated = await runAction({ request: () => fetchWithAuth(`${base}/diagnostic-runs/${run.id}/cancel`, { method: 'POST' }), errorFallback: t('stopFailed'), successMessage: t('stopRequested'), parseSuccess: (data) => topologyDiagnosticRunSchema.parse(data) });
      if (active.current) setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) { handleActionError(cause, t('loadFailed'));  }
  };
  return <section data-testid="topology-diagnostics" className="space-y-4 rounded border bg-card p-4" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <div className="flex justify-between gap-3"><h3 ref={heading} tabIndex={-1} className="font-semibold">{t('diagnostics')}</h3><button className="underline" onClick={onClose}>{t('close')}</button></div>
    <p className="text-sm text-muted-foreground">{t('diagnosticScope')}</p>
    <div className="flex flex-wrap gap-3">
      <label>{t('recipe')}<select data-testid="topology-recipe" className="ml-2 rounded border bg-background p-2" value={recipeId} onChange={(event) => setRecipeId(event.target.value as typeof recipeId)}>{['gateway_basic', 'dns_basic', 'internet_basic', 'target_connectivity', 'trace_route'].map((recipe) => <option key={recipe} value={recipe}>{t(/* i18n-dynamic */ `recipes.${recipe}`)}</option>)}</select></label>
      <label>{t('family')}<select data-testid="topology-family" className="ml-2 rounded border bg-background p-2" value={family} onChange={(event) => setFamily(event.target.value as typeof family)}><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option><option value="both">{t('bothFamilies')}</option></select></label>
      <label>{t('origin')}<select data-testid="topology-diagnostic-origin" className="ml-2 max-w-full rounded border bg-background p-2" value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">{t('chooseOrigin')}</option>{collectors?.items.map((item) => <option key={`${item.origin.deviceId}/${item.origin.contextKey}`} value={`${item.origin.deviceId}/${item.origin.contextKey}`} disabled={!item.eligible || family === 'both' && item.families.length !== 2}>{item.origin.agentId} · {item.origin.contextKey} {item.reasons.join(', ')}</option>)}</select></label>
    </div>
    {tracing && <div className="flex flex-wrap gap-3">
      <label>{t('operations.trace.maxHops')}<input data-testid="topology-trace-max-hops" type="number" className="ml-2 w-20 rounded border bg-background p-2" min={1} max={TOPOLOGY_TRACE_LIMITS.maxHops} value={maxHops}
        onChange={(event) => setMaxHops(Math.min(TOPOLOGY_TRACE_LIMITS.maxHops, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} /></label>
      <label>{t('operations.trace.probes')}<input data-testid="topology-trace-probes" type="number" className="ml-2 w-16 rounded border bg-background p-2" min={1} max={TOPOLOGY_TRACE_LIMITS.maxProbesPerHop} value={probesPerHop}
        onChange={(event) => setProbesPerHop(Math.min(TOPOLOGY_TRACE_LIMITS.maxProbesPerHop, Math.max(1, Math.trunc(Number(event.target.value)) || 1)))} /></label>
    </div>}
    {collectors?.items.length === 0 && <p>{t('noAgent')}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <button data-testid={tracing ? 'topology-trace-start' : 'topology-diagnostic-start'} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy || !selected?.eligible || runs.some((run) => !terminal(run))} onClick={() => void start()}>{runs.length ? t('retryNewRun') : t('runDiagnostic')}</button>
    {runs.map((run) => <div key={run.id} data-testid={`topology-run-${run.id}`} className="space-y-2 border-t pt-3">
      <p role="status">{run.cancelRequestedAt && !terminal(run) ? t('stopRequested') : run.state} · {run.plan.family} · {run.assessment}</p>
      <p className="break-words text-sm">{t('origin')}: {run.plan.origin.agentId} · {run.plan.origin.contextKey} · {t('deadline')}: {new Date(run.deadline).toLocaleString()}</p>
      <p className="text-sm">{t('acceptedPlan')}: {run.plan.steps.map((step) => step.method.toUpperCase()).join(' → ')}</p>
      {run.reasons.map((reason) => <p key={reason}>{reason === 'target_not_configured' ? t('targetNotConfigured') : reason.replaceAll('_', ' ')}</p>)}
      <ul className="space-y-2">{run.steps.map((step) => <li key={step.id} className="break-words text-sm"><span data-testid="topology-actual-method">{step.attribution.actualMethod?.toUpperCase() ?? t('notMeasured')}</span>: {step.reason === 'icmp_no_response' || step.attribution.requestedMethod === 'icmp' && step.state === 'timeout' ? t('noIcmpResponse') : step.state} · {step.attribution.family ?? t('unknown')} · {step.attribution.resolvedIp ?? t('unknown')} · {step.attribution.contextKey ?? t('unknown')} · {step.attribution.quality}</li>)}</ul>
      {run.plan.recipeId === 'trace_route' && <TraceResultPanel run={run} />}
      {!terminal(run) && <button data-testid="topology-diagnostic-stop" className="rounded border px-3 py-2" disabled={!!run.cancelRequestedAt} onClick={() => void stop(run)}>{t('stop')}</button>}
    </div>)}
  </section>;
}
