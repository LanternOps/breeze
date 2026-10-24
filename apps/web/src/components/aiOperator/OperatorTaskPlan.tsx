/**
 * Every plan revision the task proposed (Operator Recipe Library W06 R1b,
 * spec §6.4) — the record an approver and an auditor read.
 *
 *  - A `superseded` revision is shown as superseded, never hidden: what was
 *    approved and then replaced is the audit story.
 *  - Effects are grouped by provider, in ordinal order, with the FROZEN target
 *    and principal labels exactly as approved. The ordinal is shown, because
 *    an approved plan IS the dispatch order.
 *  - A `null` operation state is "not started / unknown" — never success.
 */
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { AiOperatorPlanApprovalDto, AiOperatorPlanEffectDto } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { cn } from '@/lib/utils';
import { providerLabel } from './operatorTaskLabels';

type T = ReturnType<typeof useTranslation>['t'];

function approvalStateLabel(t: T, state: AiOperatorPlanApprovalDto['state']): string {
  switch (state) {
    case 'pending': return t('taskPanels.plan.state.pending');
    case 'approved': return t('taskPanels.plan.state.approved');
    case 'rejected': return t('taskPanels.plan.state.rejected');
    case 'expired': return t('taskPanels.plan.state.expired');
    case 'superseded': return t('taskPanels.plan.state.superseded');
    default: return state;
  }
}

function idempotencyLabel(t: T, c: AiOperatorPlanEffectDto['idempotencyClass']): string {
  switch (c) {
    case 'idempotent': return t('taskPanels.plan.idempotency.idempotent');
    case 'idempotent_by_probe': return t('taskPanels.plan.idempotency.idempotentByProbe');
    case 'non_idempotent': return t('taskPanels.plan.idempotency.nonIdempotent');
    default: return c;
  }
}

function operationLabel(t: T, s: AiOperatorPlanEffectDto['operationState']): string {
  switch (s) {
    case null: return t('taskPanels.plan.operation.none');
    case 'pending': return t('taskPanels.plan.operation.pending');
    case 'succeeded': return t('taskPanels.plan.operation.succeeded');
    case 'failed': return t('taskPanels.plan.operation.failed');
    case 'unknown': return t('taskPanels.plan.operation.unknown');
    case 'superseded': return t('taskPanels.plan.operation.superseded');
    default: return t('taskPanels.plan.operation.none');
  }
}

const STATE_CLASS: Record<AiOperatorPlanApprovalDto['state'], string> = {
  pending: 'border-warning/40 bg-warning/10 text-warning',
  approved: 'border-success/40 bg-success/10 text-success',
  rejected: 'border-destructive/40 bg-destructive/10 text-destructive',
  expired: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  superseded: 'border-muted-foreground/30 bg-muted text-muted-foreground',
};

function Revision({ rev }: { rev: AiOperatorPlanApprovalDto }) {
  const { t } = useTranslation('aiOperator');
  const ordered = [...rev.effects].sort((a, b) => a.ordinal - b.ordinal);
  const providers: AiOperatorPlanEffectDto['provider'][] = [];
  for (const e of ordered) if (!providers.includes(e.provider)) providers.push(e.provider);
  const superseded = rev.state === 'superseded';

  return (
    <section
      data-testid={`task-plan-revision-${rev.planRevision}`}
      className={cn('space-y-3 rounded-md border p-3', superseded && 'opacity-80')}
    >
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{t('taskPanels.plan.revision', { n: rev.planRevision })}</span>
        <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium', STATE_CLASS[rev.state])}>
          {approvalStateLabel(t, rev.state)}
        </span>
        <span className="text-xs text-muted-foreground">{t('taskPanels.plan.effectCount', { count: rev.effectCount })}</span>
        <span className="text-xs text-muted-foreground">
          {rev.approvedAt
            ? t('taskPanels.plan.approvedAt', { time: formatDateTime(rev.approvedAt) })
            : t('taskPanels.plan.proposedAt', { time: formatDateTime(rev.createdAt) })}
        </span>
      </header>
      {superseded && rev.supersededByRevision !== null && (
        <p className="text-xs text-muted-foreground">{t('taskPanels.plan.supersededBy', { n: rev.supersededByRevision })}</p>
      )}
      <p className="text-xs text-muted-foreground">{t('taskPanels.plan.orderNote')}</p>
      {providers.map((p) => (
        <div key={p} data-testid={`task-plan-provider-${p}`}>
          <h5 className="text-xs font-medium uppercase text-muted-foreground">{providerLabel(p)}</h5>
          <ul className="mt-1 space-y-2">
            {ordered.filter((e) => e.provider === p).map((e) => (
              <li key={e.ordinal} data-testid={`task-plan-effect-${e.ordinal}`} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-start gap-2">
                  <span className="font-mono text-xs text-muted-foreground">#{e.ordinal + 1}</span>
                  <span className="flex-1">{e.rendering}</span>
                  <span className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs">{operationLabel(t, e.operationState)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>{t('taskPanels.plan.target', { label: e.targetLabel })}</span>
                  {e.principalLabel && <span>{t('taskPanels.plan.principal', { label: e.principalLabel })}</span>}
                  <span>{idempotencyLabel(t, e.idempotencyClass)}</span>
                  {e.noop && <span>{t('taskPanels.plan.noop')}</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export default function OperatorTaskPlan({ plan }: { plan: AiOperatorPlanApprovalDto[] | undefined }) {
  const { t } = useTranslation('aiOperator');
  if (plan === undefined) {
    return <p data-testid="task-plan-unavailable" className="text-sm text-muted-foreground">{t('taskPanels.plan.unavailable')}</p>;
  }
  if (plan.length === 0) {
    return <p data-testid="task-plan-empty" className="text-sm text-muted-foreground">{t('taskPanels.plan.empty')}</p>;
  }
  return (
    <div data-testid="task-plan" className="space-y-4">
      {[...plan].sort((a, b) => a.planRevision - b.planRevision).map((rev) => <Revision key={rev.id} rev={rev} />)}
    </div>
  );
}
