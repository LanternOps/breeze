/**
 * AI Operator task detail page (Wave W07 of #5205, read-only side). Mirrors
 * `RunDetailPage`'s fetch/loading/error/not-found state machine
 * (`requestIdRef`/`mountedRef`, monotonic per-request guard) — see that
 * file's `load()` for the exact pattern this copies.
 *
 * Read-only: no delegate/approve/answer controls here. Those need a
 * `runAction`-wrapped mutation, which is out of scope for this wave.
 */
// TODO(W08): delegate/answer actions land in a later wave

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { EmptyState } from '../shared/EmptyState';
import { cn } from '@/lib/utils';
import type {
  AiOperatorOperationDispatchState,
  AiOperatorOperationResultState,
  AiOperatorTaskDto,
  AiOperatorTaskNextAction,
  AiOperatorTaskOriginKind,
  AiOperatorTaskOutcome,
  AiOperatorTaskPhase,
  AiOperatorWaitReason,
} from '@breeze/shared';
import { taskStateLabel } from './operatorTaskLabels';

interface OperatorTaskDetailProps {
  taskId: string;
}

type Translator = (key: string) => string;

/**
 * Literal switches below (not dynamic `${...}` keys) so the i18n key-usage
 * scanner can see every key — same convention as RunDetailPage's
 * `skipItemLabel`/`skipReasonLabel` (issue #4462).
 */
function originKindLabel(t: Translator, kind: AiOperatorTaskOriginKind): string {
  switch (kind) {
    case 'manual': return t('operatorTaskDetail.origin.manual');
    case 'alert': return t('operatorTaskDetail.origin.alert');
    case 'ticket': return t('operatorTaskDetail.origin.ticket');
    case 'schedule': return t('operatorTaskDetail.origin.schedule');
    case 'anomaly': return t('operatorTaskDetail.origin.anomaly');
    case 'sweep': return t('operatorTaskDetail.origin.sweep');
    case 'chat': return t('operatorTaskDetail.origin.chat');
    default: return kind;
  }
}

function phaseLabel(t: Translator, phase: AiOperatorTaskPhase): string {
  switch (phase) {
    case 'investigate': return t('operatorTaskDetail.phase.investigate');
    case 'plan': return t('operatorTaskDetail.phase.plan');
    case 'execute': return t('operatorTaskDetail.phase.execute');
    case 'verify': return t('operatorTaskDetail.phase.verify');
    case 'document': return t('operatorTaskDetail.phase.document');
    default: return phase;
  }
}

function waitReasonLabel(t: Translator, reason: AiOperatorWaitReason): string {
  switch (reason) {
    case 'approval': return t('operatorTaskDetail.waitReason.approval');
    case 'information': return t('operatorTaskDetail.waitReason.information');
    case 'execution': return t('operatorTaskDetail.waitReason.execution');
    case 'device': return t('operatorTaskDetail.waitReason.device');
    case 'maintenance_window': return t('operatorTaskDetail.waitReason.maintenanceWindow');
    case 'verification_window': return t('operatorTaskDetail.waitReason.verificationWindow');
    default: return reason;
  }
}

function nextActionLabel(t: Translator, action: AiOperatorTaskNextAction): string {
  switch (action) {
    case 'approve_in_inbox': return t('operatorTaskDetail.nextAction.approveInInbox');
    case 'answer_question': return t('operatorTaskDetail.nextAction.answerQuestion');
    case 'waiting_for_device': return t('operatorTaskDetail.nextAction.waitingForDevice');
    case 'waiting_for_maintenance_window': return t('operatorTaskDetail.nextAction.waitingForMaintenanceWindow');
    case 'waiting_for_verification_window': return t('operatorTaskDetail.nextAction.waitingForVerificationWindow');
    case 'waiting_for_execution': return t('operatorTaskDetail.nextAction.waitingForExecution');
    case 'queued': return t('operatorTaskDetail.nextAction.queued');
    case 'in_progress': return t('operatorTaskDetail.nextAction.inProgress');
    case 'paused': return t('operatorTaskDetail.nextAction.paused');
    case 'stopping': return t('operatorTaskDetail.nextAction.stopping');
    case 'handed_off': return t('operatorTaskDetail.nextAction.handedOff');
    case 'none': return t('operatorTaskDetail.nextAction.none');
    default: return action;
  }
}

function dispatchStateLabel(t: Translator, state: AiOperatorOperationDispatchState): string {
  switch (state) {
    case 'reserved': return t('operatorTaskDetail.dispatchState.reserved');
    case 'dispatched': return t('operatorTaskDetail.dispatchState.dispatched');
    case 'dispatch_failed': return t('operatorTaskDetail.dispatchState.dispatchFailed');
    case 'abandoned': return t('operatorTaskDetail.dispatchState.abandoned');
    default: return state;
  }
}

function resultStateLabel(t: Translator, state: AiOperatorOperationResultState): string {
  switch (state) {
    case 'pending': return t('operatorTaskDetail.resultState.pending');
    case 'succeeded': return t('operatorTaskDetail.resultState.succeeded');
    case 'failed': return t('operatorTaskDetail.resultState.failed');
    case 'unknown': return t('operatorTaskDetail.resultState.unknown');
    case 'superseded': return t('operatorTaskDetail.resultState.superseded');
    default: return state;
  }
}

function outcomeLabel(t: Translator, outcome: AiOperatorTaskOutcome): string {
  switch (outcome) {
    case 'verified_resolved': return t('operatorTaskDetail.outcome.verifiedResolved');
    case 'investigation_complete': return t('operatorTaskDetail.outcome.investigationComplete');
    case 'report_delivered': return t('operatorTaskDetail.outcome.reportDelivered');
    case 'no_action_needed': return t('operatorTaskDetail.outcome.noActionNeeded');
    case 'trial_complete': return t('operatorTaskDetail.outcome.trialComplete');
    case 'unresolved': return t('operatorTaskDetail.outcome.unresolved');
    case 'unknown_effect': return t('operatorTaskDetail.outcome.unknownEffect');
    default: return outcome;
  }
}

export default function OperatorTaskDetail({ taskId }: OperatorTaskDetailProps) {
  const { t } = useTranslation('aiOperator');
  const [task, setTask] = useState<AiOperatorTaskDto | null>(null);
  const [loading, setLoading] = useState(true);
  // Boolean, not the translated string — keeps `t` out of `load`'s deps (a
  // translated-string dependency re-fires the fetch when a non-English
  // locale finishes loading; review fix, PR #5254). Matches
  // OperatorTaskActivityFeed's `error` state shape.
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);

  // Monotonic request id + mount guard — same pattern as RunDetailPage's
  // `load()`/`requestIdRef`/`mountedRef`.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (id: string) => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    setLoading(true);
    setError(false);
    setNotFound(false);
    try {
      const response = await fetchWithAuth(`/ai/operator/tasks/${id}`);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (response.status === 404) {
        setNotFound(true);
        return;
      }
      if (!response.ok) {
        setError(true);
        return;
      }
      const body = (await response.json()) as { data?: AiOperatorTaskDto };
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (!body.data) {
        setError(true);
        return;
      }
      setTask(body.data);
    } catch (err) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      console.error('[operator-task-detail] load failed', id, err);
      setError(true);
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(taskId);
  }, [taskId, load]);

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="operator-task-loading">
        {t('operatorTaskDetail.loading')}
      </p>
    );
  }

  if (notFound) {
    return (
      <EmptyState
        testId="operator-task-not-found"
        title={t('operatorTaskDetail.notFound.title')}
        description={t('operatorTaskDetail.notFound.description')}
      />
    );
  }

  if (error || !task) {
    return (
      <div data-testid="operator-task-error" className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{t('operatorTaskDetail.errors.load')}</p>
        <button
          type="button"
          onClick={() => void load(taskId)}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  const targetText = task.target.deviceId
    ? (task.target.label ?? task.target.deviceId)
    : t('operatorTaskDetail.target.none');

  return (
    <div className="space-y-6">
      <div>
        <p className="text-lg font-semibold">{task.objective}</p>
        <p className="text-sm text-muted-foreground">
          {t('operatorTaskDetail.agent', { name: task.agent.name })}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase text-muted-foreground">{t('operatorTaskDetail.target.label')}</dt>
          <dd data-testid="operator-task-target">{targetText}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">{t('operatorTaskDetail.origin.label')}</dt>
          <dd>{originKindLabel(t, task.originKind)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">{t('operatorTaskDetail.state.label')}</dt>
          <dd>
            <span
              data-testid="operator-task-state"
              className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium')}
            >
              {taskStateLabel(t, task.state)}
            </span>
            {task.phase && <span className="ml-2 text-muted-foreground">{phaseLabel(t, task.phase)}</span>}
          </dd>
        </div>
        {task.waitReason && (
          <div>
            <dt className="text-xs uppercase text-muted-foreground">{t('operatorTaskDetail.waitReason.label')}</dt>
            <dd>{waitReasonLabel(t, task.waitReason)}</dd>
          </div>
        )}
        <div>
          <dt className="text-xs uppercase text-muted-foreground">{t('operatorTaskDetail.nextAction.label')}</dt>
          <dd data-testid="operator-task-next-action">{nextActionLabel(t, task.nextAction)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">{t('operatorTaskDetail.deadline.label')}</dt>
          <dd>{task.deadlineAt ? formatDateTime(task.deadlineAt) : t('operatorTaskDetail.deadline.none')}</dd>
        </div>
      </dl>

      {(task.outcome || task.handoffSummary) && (
        <div className="space-y-2 rounded-md border p-4" data-testid="operator-task-outcome">
          {task.outcome && (
            <p className="text-sm">
              <span className="font-medium">{t('operatorTaskDetail.outcome.label')}: </span>
              {outcomeLabel(t, task.outcome)}
              {task.outcomeDetail ? ` — ${task.outcomeDetail}` : ''}
            </p>
          )}
          {task.handoffSummary && (
            <p className="text-sm">
              <span className="font-medium">{t('operatorTaskDetail.handoffSummary.label')}: </span>
              {task.handoffSummary}
            </p>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t('operatorTaskDetail.operations.heading')}</h3>
        {task.operations.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="operator-task-operations-empty">
            {t('operatorTaskDetail.operations.empty')}
          </p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="operator-task-operations-list">
            {task.operations.map((op) => (
              <li
                key={`${op.operationKey}-${op.attemptOrdinal}`}
                data-testid={`operator-task-operation-${op.operationKey}`}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs text-muted-foreground">{op.operationKey}</span>
                <span>{t('operatorTaskDetail.operations.attempt', { n: op.attemptOrdinal })}</span>
                <span className="ml-auto">{dispatchStateLabel(t, op.dispatchState)}</span>
                <span>{resultStateLabel(t, op.resultState)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">{t('operatorTaskDetail.runs.heading')}</h3>
        {task.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="operator-task-runs-empty">
            {t('operatorTaskDetail.runs.empty')}
          </p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="operator-task-runs-list">
            {task.runs.map((run) => (
              <li key={run.id}>
                <a
                  href={`/ai-agents/runs/${run.id}`}
                  data-testid={`operator-task-run-${run.id}`}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/50"
                >
                  <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
                  <span>{run.status}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
