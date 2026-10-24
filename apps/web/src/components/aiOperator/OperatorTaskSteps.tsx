/**
 * The task's step rows, in the order they started (Operator Recipe Library
 * W06 R1b, spec §6.3). Renders exactly what the server recorded: one row per
 * step attempt, no rows invented for phases. In particular `effects` is ONE
 * row (Todd D1 = A) whose waiting reason follows the task — approval, then the
 * maintenance window, then executing.
 */
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { AiOperatorTaskDto, AiOperatorTaskStepDto, AiOperatorWaitReason } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { cn } from '@/lib/utils';

type T = ReturnType<typeof useTranslation>['t'];

export interface OperatorTaskStepsProps {
  task: Pick<AiOperatorTaskDto, 'steps' | 'targets' | 'currentStepKey' | 'waitReason' | 'state'>;
}

function stepKeyLabel(t: T, key: string): string {
  switch (key) {
    case 'intake': return t('taskPanels.steps.stepKey.intake');
    case 'confirm_identity': return t('taskPanels.steps.stepKey.confirmIdentity');
    case 'discover': return t('taskPanels.steps.stepKey.discover');
    case 'review': return t('taskPanels.steps.stepKey.review');
    case 'effects': return t('taskPanels.steps.stepKey.effects');
    case 'manual_work': return t('taskPanels.steps.stepKey.manualWork');
    case 'verify_outcome': return t('taskPanels.steps.stepKey.verifyOutcome');
    case 'document': return t('taskPanels.steps.stepKey.document');
    default: return key;
  }
}

function kindLabel(t: T, kind: AiOperatorTaskStepDto['stepKind']): string {
  switch (kind) {
    case 'reason': return t('taskPanels.steps.kind.reason');
    case 'effect': return t('taskPanels.steps.kind.effect');
    case 'probe': return t('taskPanels.steps.kind.probe');
    case 'wait': return t('taskPanels.steps.kind.wait');
    case 'human_work': return t('taskPanels.steps.kind.humanWork');
    case 'document': return t('taskPanels.steps.kind.document');
    default: return kind;
  }
}

function stateLabel(t: T, state: AiOperatorTaskStepDto['state']): string {
  switch (state) {
    case 'pending': return t('taskPanels.steps.state.pending');
    case 'running': return t('taskPanels.steps.state.running');
    case 'waiting': return t('taskPanels.steps.state.waiting');
    case 'succeeded': return t('taskPanels.steps.state.succeeded');
    case 'failed': return t('taskPanels.steps.state.failed');
    case 'skipped': return t('taskPanels.steps.state.skipped');
    default: return state;
  }
}

function waitReasonWords(t: T, reason: AiOperatorWaitReason): string {
  switch (reason) {
    case 'approval': return t('taskPanels.steps.waitingApproval');
    case 'maintenance_window': return t('taskPanels.steps.waitingMaintenanceWindow');
    case 'execution': return t('taskPanels.steps.waitingExecution');
    case 'information': return t('taskPanels.steps.waitingOther', { reason: t('operatorTaskDetail.waitReason.information') });
    case 'device': return t('taskPanels.steps.waitingOther', { reason: t('operatorTaskDetail.waitReason.device') });
    case 'verification_window': return t('taskPanels.steps.waitingOther', { reason: t('operatorTaskDetail.waitReason.verificationWindow') });
    default: return t('taskPanels.steps.waitingOther', { reason });
  }
}

const isHumanWork = (s: AiOperatorTaskStepDto) => s.stepKind === 'human_work' || s.dependency?.kind === 'user_answer';

export default function OperatorTaskSteps({ task }: OperatorTaskStepsProps) {
  const { t } = useTranslation('aiOperator');
  if (task.steps.length === 0) {
    return <p data-testid="task-steps-empty" className="text-sm text-muted-foreground">{t('taskPanels.steps.empty')}</p>;
  }

  // The checklist ticket a human_work step's item lives on (E3 attaches it as a ticket target).
  const ticket = task.targets.find((x) => x.targetKind === 'ticket' && x.ticketId && !x.detachedAt) ?? null;

  const ordered = [...task.steps].sort((a, b) => {
    const ta = a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY;
    const tb = b.startedAt ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY;
    return ta - tb || a.attemptOrdinal - b.attemptOrdinal;
  });
  const groups: Array<{ stepKey: string; rows: AiOperatorTaskStepDto[] }> = [];
  for (const row of ordered) {
    const g = groups.find((x) => x.stepKey === row.stepKey);
    if (g) g.rows.push(row);
    else groups.push({ stepKey: row.stepKey, rows: [row] });
  }

  return (
    <ol data-testid="task-steps" className="space-y-2">
      {groups.map(({ stepKey, rows }) => {
        const current = stepKey === task.currentStepKey;
        return (
          <li
            key={stepKey}
            data-testid={`task-step-${stepKey}`}
            aria-current={current ? 'step' : undefined}
            className={cn('rounded-md border p-3', current && 'border-primary bg-primary/5')}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{stepKeyLabel(t, stepKey)}</span>
              <span className="text-xs text-muted-foreground">{kindLabel(t, rows[0]!.stepKind)}</span>
              {current && <span className="text-xs font-medium text-primary">{t('taskPanels.steps.current')}</span>}
            </div>
            <ul className="mt-2 space-y-2">
              {rows.map((row) => {
                const waiting = row.state === 'waiting';
                const human = isHumanWork(row);
                return (
                  <li key={row.id} data-testid={`task-step-${stepKey}-${row.attemptOrdinal}`} className="text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs">{stateLabel(t, row.state)}</span>
                      {row.startedAt && <span className="text-xs text-muted-foreground">{t('taskPanels.steps.started', { time: formatDateTime(row.startedAt) })}</span>}
                      {row.settledAt && <span className="text-xs text-muted-foreground">{t('taskPanels.steps.settled', { time: formatDateTime(row.settledAt) })}</span>}
                    </div>
                    {waiting && human && (
                      <p className="mt-1">
                        {t('taskPanels.steps.waitingHumanWork')}{' '}
                        {ticket && (
                          <a href={`/tickets/${ticket.ticketId}`} className="font-medium text-primary underline">
                            {t('taskPanels.steps.openTicket')}
                          </a>
                        )}
                      </p>
                    )}
                    {waiting && !human && current && task.waitReason && (
                      <p className="mt-1">{waitReasonWords(t, task.waitReason)}</p>
                    )}
                    {/* The server's bounded detail, verbatim — e.g. the checklist item, or who completed it. */}
                    {row.detail && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{row.detail}</p>}
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
