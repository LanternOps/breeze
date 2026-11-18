/**
 * The task's event timeline (Operator Recipe Library W06 R1b): newest last,
 * with the actor kind and the server's bounded detail verbatim.
 *
 * The server sends at most its newest 500 events, ascending. This shows the
 * most recent 200 of them; "show all" reveals the rest of what was fetched,
 * and when the server's cap was reached the panel says so in words.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { AiOperatorTaskEventDto } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';

/** `GET /tasks/:id` events cap (the route's `.limit(500)`). */
export const SERVER_EVENT_CAP = 500;
export const EVENTS_SHOWN = 200;

type T = ReturnType<typeof useTranslation>['t'];

function actorLabel(t: T, a: AiOperatorTaskEventDto['actorKind']): string {
  switch (a) {
    case 'coordinator': return t('taskPanels.events.actor.coordinator');
    case 'reconciler': return t('taskPanels.events.actor.reconciler');
    case 'user': return t('taskPanels.events.actor.user');
    case 'agent': return t('taskPanels.events.actor.agent');
    case 'system': return t('taskPanels.events.actor.system');
    default: return a;
  }
}

function typeLabel(t: T, e: AiOperatorTaskEventDto['eventType']): string {
  switch (e) {
    case 'task_admitted': return t('taskPanels.events.type.taskAdmitted');
    case 'lease_claimed': return t('taskPanels.events.type.leaseClaimed');
    case 'step_opened': return t('taskPanels.events.type.stepOpened');
    case 'step_settled': return t('taskPanels.events.type.stepSettled');
    case 'wait_entered': return t('taskPanels.events.type.waitEntered');
    case 'wait_resolved': return t('taskPanels.events.type.waitResolved');
    case 'target_attached': return t('taskPanels.events.type.targetAttached');
    case 'target_detached': return t('taskPanels.events.type.targetDetached');
    case 'target_account_frozen': return t('taskPanels.events.type.targetAccountFrozen');
    case 'operation_reserved': return t('taskPanels.events.type.operationReserved');
    case 'operation_settled': return t('taskPanels.events.type.operationSettled');
    case 'verification_recorded': return t('taskPanels.events.type.verificationRecorded');
    case 'plan_revision_bumped': return t('taskPanels.events.type.planRevisionBumped');
    case 'human_work_unticked': return t('taskPanels.events.type.humanWorkUnticked');
    case 'task_settled': return t('taskPanels.events.type.taskSettled');
    default: return e;
  }
}

export default function OperatorTaskEvents({ events }: { events: AiOperatorTaskEventDto[] }) {
  const { t } = useTranslation('aiOperator');
  const [showAll, setShowAll] = useState(false);
  if (events.length === 0) {
    return <p data-testid="task-events-empty" className="text-sm text-muted-foreground">{t('taskPanels.events.empty')}</p>;
  }
  const ordered = [...events].sort((a, b) => a.transitionSeq - b.transitionSeq);
  const hidden = showAll ? 0 : Math.max(0, ordered.length - EVENTS_SHOWN);
  const visible = ordered.slice(hidden);

  return (
    <div className="space-y-2">
      {events.length >= SERVER_EVENT_CAP && (
        <p data-testid="task-events-capped" className="text-xs text-muted-foreground">
          {t('taskPanels.events.capped', { count: SERVER_EVENT_CAP })}
        </p>
      )}
      {ordered.length > EVENTS_SHOWN && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {hidden > 0 && <span data-testid="task-events-hidden">{t('taskPanels.events.hiddenOlder', { count: hidden })}</span>}
          <button
            type="button"
            data-testid="task-events-show-all"
            onClick={() => setShowAll((s) => !s)}
            className="underline"
          >
            {showAll
              ? t('taskPanels.events.showRecent', { count: EVENTS_SHOWN })
              : t('taskPanels.events.showAll', { count: ordered.length })}
          </button>
        </div>
      )}
      <ol data-testid="task-events" className="divide-y rounded-md border">
        {visible.map((e) => (
          <li key={e.id} data-testid={`task-event-${e.transitionSeq}`} className="px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{e.transitionSeq}</span>
              <span className="font-medium">{typeLabel(t, e.eventType)}</span>
              <span className="text-xs text-muted-foreground">{actorLabel(t, e.actorKind)}</span>
              {e.stepKey && <span className="font-mono text-xs text-muted-foreground">{e.stepKey}</span>}
              <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</span>
            </div>
            {e.detail && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{e.detail}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
