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
 *  - W07 R2b: a task with MORE than one approval (onboarding approves its
 *    account creation, then its licences and groups) renders each approval as
 *    a labelled stage block, oldest first. A creation approval that ran and
 *    was then followed by the next stage is `superseded` in the data; it stays
 *    visible and says it was followed, not replaced. A one-approval task
 *    renders exactly as R1 shipped it (snapshot-pinned).
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

/** The onboarding stage an approval is, read off its own effects. Null for any other recipe. */
type StageKind = 'creation' | 'provision' | null;
const CREATE_TOOLS = new Set(['m365_create_user']);
const PROVISION_TOOLS = new Set([
  'm365_assign_license', 'm365_add_to_group', 'google_move_ou', 'google_assign_license', 'google_add_to_group',
]);
function stageKind(rev: AiOperatorPlanApprovalDto): StageKind {
  if (rev.effects.some((e) => CREATE_TOOLS.has(e.toolName))) return 'creation';
  if (rev.effects.length > 0 && rev.effects.every((e) => PROVISION_TOOLS.has(e.toolName))) return 'provision';
  return null;
}

function Revision({ rev, stage }: { rev: AiOperatorPlanApprovalDto; stage?: StageKind }) {
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
        // A creation approval that was approved and then moved on to the next
        // stage was not replaced: what it approved ran.
        stage === 'creation' && rev.approvedAt !== null
          ? <p className="text-xs text-muted-foreground">{t('taskPanels.plan.followedBy', { n: rev.supersededByRevision })}</p>
          : <p className="text-xs text-muted-foreground">{t('taskPanels.plan.supersededBy', { n: rev.supersededByRevision })}</p>
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
  const ordered = [...plan].sort((a, b) => a.planRevision - b.planRevision);
  if (ordered.length === 1) {
    return (
      <div data-testid="task-plan" className="space-y-4">
        {ordered.map((rev) => <Revision key={rev.id} rev={rev} />)}
      </div>
    );
  }
  return (
    <div data-testid="task-plan" className="space-y-4">
      {ordered.map((rev, i) => {
        const kind = stageKind(rev);
        return (
          <div key={rev.id} data-testid={`task-plan-stage-${rev.planRevision}`} className="space-y-2">
            <h4 className="text-sm font-semibold">
              {t('taskPanels.planStage', { n: i + 1 })}
              {kind === 'creation' && <span className="font-normal text-muted-foreground"> · {t('taskPanels.plan.stageCreation')}</span>}
              {kind === 'provision' && <span className="font-normal text-muted-foreground"> · {t('taskPanels.plan.stageProvision')}</span>}
            </h4>
            <Revision rev={rev} stage={kind} />
          </div>
        );
      })}
    </div>
  );
}
