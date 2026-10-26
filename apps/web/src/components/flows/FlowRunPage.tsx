import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { isTerminalFlowRunStatus } from '@breeze/shared';
import { useFlowsGate } from '../../stores/featuresStore';
import { useOrgStore } from '../../stores/orgStore';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { cancelFlowRun } from './api';
import { FlowRunTimeline } from './FlowRunTimeline';
import { formatDurationMs, runDurationMs, statusChipClass } from './flowRunFormat';
import { useFlowRunPolling } from './useFlowRunPolling';

/** Run timeline page (#5219 W4): live status header plus step-by-step timeline. */
export default function FlowRunPage({ runId }: { runId: string }) {
  const { t } = useTranslation('flows');
  const { enabled, loaded } = useFlowsGate();
  const organizations = useOrgStore((s) => s.organizations) ?? [];
  const { run, loading, loadError, paused, lastUpdated, retry, refetch } = useFlowRunPolling(runId, enabled);
  const [cancelling, setCancelling] = useState(false);

  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelFlowRun(runId);
      refetch();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('errors.cancelFailed') }); // ActionError already toasted
    } finally {
      setCancelling(false);
    }
  };

  if (!enabled) {
    return loaded ? (
      <p className="p-4 text-sm text-muted-foreground" data-testid="flow-not-found">{t('errors.notFound')}</p>
    ) : null;
  }
  if (!run) {
    if (loading) return null;
    return loadError?.status === 404 ? (
      <p className="p-4 text-sm text-muted-foreground" data-testid="flow-run-not-found">{t('runDetail.notFound')}</p>
    ) : (
      <div className="space-y-2 p-4">
        <p className="text-sm text-destructive" data-testid="flow-run-error">{t('runDetail.loadFailed')}</p>
        <button type="button" className="rounded border px-3 py-1.5 text-sm" data-testid="flow-run-retry" onClick={retry}>
          {t('runDetail.retry')}
        </button>
      </div>
    );
  }

  const terminal = isTerminalFlowRunStatus(run.status);
  const orgName = organizations.find((o) => o.id === run.orgId)?.name ?? run.orgId;
  const unknownOutcome = run.errorCode === 'unknown_outcome' || run.steps.some((s) => s.status === 'unknown_outcome');

  return (
    <div className="space-y-4 p-4" data-testid="flow-run-page">
      <a className="text-sm text-primary hover:underline" href={`/flows/${run.flowId}#runs`} data-testid="flow-run-back">
        {t('runDetail.back')}
      </a>

      <header className="space-y-2">
        <h1 className="text-xl font-semibold">
          <a className="hover:underline" href={`/flows/${run.flowId}`} data-testid="flow-run-flow-link">{run.flowName}</a>
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className={statusChipClass(run.status)} data-testid="flow-run-status">
            {t(/* i18n-dynamic */ `runs.status.${run.status}`)}
          </span>
          <span data-testid="flow-run-version">{t('runDetail.version', { version: run.definitionVersion, seq: run.publicationSeq })}</span>
          <span data-testid="flow-run-trigger">
            {t(/* i18n-dynamic */ `runs.trigger.${run.triggerKind}`, { defaultValue: run.triggerKind })}
            {' · '}
            {t(/* i18n-dynamic */ `runs.via.${run.triggeredVia}`, { defaultValue: run.triggeredVia })}
          </span>
          <span data-testid="flow-run-org">{t('runDetail.org', { org: orgName })}</span>
          {run.startedAt && <span>{formatDateTime(run.startedAt)}</span>}
          <span data-testid="flow-run-duration">{formatDurationMs(runDurationMs(run))}</span>
        </div>

        {run.errorCode && run.errorCode !== 'unknown_outcome' && (
          <p className="text-sm text-destructive" data-testid="flow-run-error-code">
            {t(/* i18n-dynamic */ `runDetail.error.${run.errorCode}`, { defaultValue: run.errorCode })}
            <span className="ml-2 font-mono text-xs text-muted-foreground">{run.errorCode}</span>
          </p>
        )}

        {run.status === 'awaiting_approval' && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="flow-run-awaiting-approval">
            <span>{t('runDetail.awaitingApproval')} </span>
            <a className="font-medium text-primary hover:underline" href="/approvals" data-testid="flow-run-approvals-link">
              {t('runDetail.openApprovals')}
            </a>
          </div>
        )}
        {run.status === 'waiting' && (
          <p className="text-sm" data-testid="flow-run-wake">
            {run.wakeAt ? t('runDetail.waitingUntil', { time: formatDateTime(run.wakeAt) }) : t('runs.status.waiting')}
          </p>
        )}
        {run.status === 'queued' && (
          <p className="text-sm" data-testid="flow-run-queued">{t('runDetail.queuedNote')}</p>
        )}
        {unknownOutcome && (
          <p className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm" data-testid="flow-run-unknown-outcome">
            {t('runDetail.error.unknown_outcome')}
          </p>
        )}

        {!terminal && (
          <div className="pt-1">
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
              data-testid="flow-run-cancel"
              disabled={cancelling}
              onClick={() => { void cancel(); }}
            >
              {t('actions.cancelRun')}
            </button>
          </div>
        )}
      </header>

      {paused && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="flow-run-paused">
          <span>{t('runDetail.paused')}</span>
          {lastUpdated !== null && (
            <span className="text-muted-foreground" data-testid="flow-run-last-updated">
              {t('runDetail.lastUpdated', { time: formatDateTime(new Date(lastUpdated)) })}
            </span>
          )}
          <button type="button" className="rounded border px-2 py-1 text-xs" data-testid="flow-run-retry" onClick={retry}>
            {t('runDetail.retry')}
          </button>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('runDetail.timeline')}</h2>
        <FlowRunTimeline runId={run.id} definition={run.definition} steps={run.steps} bodiesPrunedAt={run.bodiesPrunedAt} />
      </section>
    </div>
  );
}
