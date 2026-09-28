import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TopologyMonitoringStatus } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { parsePolicyArmState, policyRunsPerDay, topologyOperationsApi, topologySitePath, type TopologyPolicyRow } from './topologyOperationsApi';
import { useTopologyArmStepUp } from './TopologyArmStepUp';
import { formatTime } from './topologyOperationsFormat';

type PolicyStatus = TopologyMonitoringStatus['policies'][number];
const humanize = (reason: string) => reason.replaceAll('_', ' ');

/**
 * Recurring monitoring policies of one site with their live status (M3 Task 11).
 *
 * Reading, previewing and opening are passive GETs. Enabling is an explicit,
 * human-only arm (`POST …/policies/:id/arm`) pinned to the reviewed policy
 * revision, behind a server-driven `topology_arm` step-up. Success copy comes
 * from the returned arm state, so a blocked arm is never announced as active.
 */
export default function MonitoringPolicyPanel({ siteId, canConfigure, subject }: {
  siteId: string; canConfigure: boolean; subject?: { kind: 'node' | 'relationship'; id: string };
}) {
  const { t } = useTranslation('topology');
  const [policies, setPolicies] = useState<TopologyPolicyRow[] | null>(null);
  const [status, setStatus] = useState<TopologyMonitoringStatus | null>(null);
  const [error, setError] = useState<string>(), [reload, setReload] = useState(0);
  const [preview, setPreview] = useState<string>(), [busy, setBusy] = useState<string>(), [conflict, setConflict] = useState<string>();
  const { arm, prompt } = useTopologyArmStepUp();
  useEffect(() => {
    const abort = new AbortController(); setError(undefined);
    void Promise.all([topologyOperationsApi.policies(siteId, abort.signal), topologyOperationsApi.monitoring(siteId, abort.signal)]).then(([list, next]) => {
      if (abort.signal.aborted) return; setPolicies(list.items); setStatus(next);
    }).catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : t('operations.loadFailed')); });
    return () => abort.abort();
  }, [siteId, reload]);
  const refresh = () => { setConflict(undefined); setPreview(undefined); setReload((n) => n + 1); };
  const visible = (policies ?? []).filter((policy) => !subject
    || (subject.kind === 'node' ? policy.subjectNodeId === subject.id : policy.subjectRelationshipId === subject.id));
  const statusOf = (policy: TopologyPolicyRow): PolicyStatus | undefined => status?.policies.find((entry) => entry.policyId === policy.id);
  // Known codes get specific copy; anything else keeps the server's own explanation (e.g. no eligible collector).
  const friendly = (code: string) => code === 'revision_conflict' ? t('operations.policy.conflict') : code === 'step_up_required' ? t('operations.stepUp.intro') : undefined;
  const enable = (policy: TopologyPolicyRow) => arm({
    resource: { siteId, action: 'arm_policy', subjectId: policy.id }, fallback: t('operations.policy.enableFailed'),
    submit: async (grantId) => {
      setBusy(policy.id);
      try {
        await runAction({
          request: () => fetchWithAuth(`${topologySitePath(siteId)}/policies/${encodeURIComponent(policy.id)}/arm`, { method: 'POST',
            body: JSON.stringify({ expectedRevision: policy.revision, ...(grantId ? { stepUpGrantId: grantId } : {}) }) }),
          errorFallback: t('operations.policy.enableFailed'), friendly, parseSuccess: parsePolicyArmState,
          successMessage: (state) => state.enabled ? t('operations.policy.enabled') : t('operations.policy.blocked', { reason: humanize(state.blockedReason ?? 'not_enabled') }),
        });
        refresh();
      } catch (cause) {
        if (cause instanceof ActionError && cause.status === 409 && cause.code === 'revision_conflict') setConflict(policy.id);
        throw cause;
      } finally { setBusy(undefined); }
    },
  });
  const disable = async (policy: TopologyPolicyRow) => {
    setBusy(policy.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`${topologySitePath(siteId)}/policies/${encodeURIComponent(policy.id)}/disarm`, { method: 'POST', body: JSON.stringify({ expectedRevision: policy.revision }) }),
        errorFallback: t('operations.policy.disableFailed'), friendly, successMessage: t('operations.policy.disabled'), parseSuccess: parsePolicyArmState,
      });
      refresh();
    } catch (cause) {
      if (cause instanceof ActionError && cause.status === 409 && cause.code === 'revision_conflict') setConflict(policy.id);
      else if (!(cause instanceof ActionError)) setError(t('operations.policy.disableFailed'));
    } finally { setBusy(undefined); }
  };
  return <section data-testid={subject ? 'topology-policy-subject' : 'topology-policies'} aria-labelledby={`topology-policies-heading-${subject?.id ?? 'site'}`} className="space-y-3 border-t pt-3 text-sm">
    <h4 id={`topology-policies-heading-${subject?.id ?? 'site'}`} className="font-medium">{subject ? t('operations.policy.inspectorHeading') : t('operations.policy.heading')}</h4>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!policies && !error && <p role="status" className="text-muted-foreground">{t('loading')}</p>}
    {policies && !visible.length && <p data-testid="topology-monitor-none" className="text-muted-foreground">{subject ? t('operations.policy.noneForSubject') : t('operations.policy.none')}</p>}
    {policies && visible.length > 0 && !canConfigure && <p className="text-muted-foreground">{t('operations.policy.readOnly')}</p>}
    {prompt}
    {visible.map((policy) => {
      const live = statusOf(policy), definition = policy.definition, open = preview === policy.id;
      const enabled = live?.enabled ?? policy.enabled, requested = live?.activationIntent ?? policy.activationIntent ?? false;
      // `not_armed` is the compile's marker for intent without a human arm, not a failure.
      const rawBlocked = live?.blockedReason ?? policy.blockedReason ?? null, blocked = rawBlocked === 'not_armed' ? null : rawBlocked;
      return <div key={policy.id} data-testid={`topology-policy-${policy.key}`} className="space-y-2 rounded border p-3">
        <p className="font-medium">{policy.key} · {t(/* i18n-dynamic */ `recipes.${definition.recipeId}`)}</p>
        <p data-testid="topology-monitor-status" role="status">{enabled ? t('operations.policy.status.enabled')
          : blocked ? t('operations.policy.status.blocked', { reason: humanize(blocked) })
          : requested ? t('operations.policy.status.requested') : t('operations.policy.status.off')}</p>
        {live?.nextScheduledAt && <p className="text-muted-foreground">{t('operations.policy.next', { time: formatTime(live.nextScheduledAt) })}</p>}
        {live?.lastScheduledAt && <p className="text-muted-foreground">{t('operations.policy.last', { time: formatTime(live.lastScheduledAt) })}</p>}
        {live?.streaks.map((streak) => <p key={`${streak.contextKey}/${streak.family}`} data-testid="topology-monitor-streak" className="text-xs">
          {t('operations.policy.streak', { context: streak.contextKey, family: streak.family, failures: streak.consecutiveFailures, successes: streak.consecutiveSuccesses })}
          {streak.activeAlertId && <> · <a className="text-primary underline" href={`/alerts/${streak.activeAlertId}`}>{t('operations.policy.activeAlert')}</a></>}</p>)}
        {conflict === policy.id && <div data-testid="topology-monitor-conflict" role="alert" className="rounded border border-destructive p-2">{t('operations.policy.conflict')}
          <button data-testid="topology-monitor-reload" className="ml-2 underline" onClick={refresh}>{t('operations.policy.reload')}</button></div>}
        <div className="flex flex-wrap gap-2">
          <button data-testid="topology-monitor-preview" className="rounded border px-3 py-1" aria-expanded={open} onClick={() => setPreview(open ? undefined : policy.id)}>{open ? t('operations.policy.hidePreview') : t('operations.policy.preview')}</button>
          {canConfigure && enabled && <button data-testid="topology-monitor-disable" className="rounded border px-3 py-1 disabled:opacity-50" disabled={busy === policy.id} onClick={() => void disable(policy)}>{t('operations.policy.disable')}</button>}
        </div>
        {open && <div data-testid="topology-monitor-preview-panel" className="space-y-1 rounded bg-muted/40 p-2">
          <p>{t('operations.policy.subject')}: {t(/* i18n-dynamic */ `operations.policy.subjects.${definition.subject}`)}</p>
          <p>{t('operations.policy.targets')}: {definition.targetKeys.length ? definition.targetKeys.join(', ') : t('operations.policy.noTargets')}</p>
          <p>{t('operations.policy.families')}: {definition.families.join(', ')}</p>
          <p>{t('operations.policy.originMode')}: {t(/* i18n-dynamic */ `operations.policy.origins.${definition.origin}`)}</p>
          <p>{t('operations.policy.contexts')}</p>
          <p>{t('operations.policy.interval', { minutes: Math.round(definition.intervalSeconds / 60) })}</p>
          <p data-testid="topology-monitor-volume">{t('operations.policy.volume', { runs: policyRunsPerDay(definition.intervalSeconds, 1, definition.families.length) })}</p>
          <p>{definition.alertsEnabled ? t('operations.policy.thresholds', { failure: definition.failureThreshold, recovery: definition.recoveryThreshold }) : t('operations.policy.alertsOff')}</p>
          <p className="text-muted-foreground">{t('operations.policy.reuse')}</p>
          {canConfigure && !enabled && !requested && <p data-testid="topology-monitor-intent-required" className="text-muted-foreground">{t('operations.policy.intentRequired')}</p>}
          {canConfigure && !enabled && requested && <button data-testid="topology-monitor-enable" className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy === policy.id}
            onClick={() => void enable(policy)}>{t('operations.policy.enable')}</button>}
        </div>}
      </div>;
    })}
  </section>;
}
