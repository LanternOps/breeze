import { useRef, useState, type ReactNode } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ActionMenu, type ActionMenuItem } from '../shared/ActionMenu';
import { EntityLink } from '@/components/shared/EntityLink';
import { activeStatusesByCore, type TicketConfig } from '../../lib/ticketConfigApi';
import SlaChip from './SlaChip';
import { nameInitials, NEUTRAL_CHIP_TEXT, statusConfig, priorityConfig, ticketDisplayNumber, type TicketDetail, type TicketPriority, type TicketStatus } from './ticketConfig';
import { PRIORITY_OPTIONS, STATUS_OPTIONS, translatedPriorityLabel, type UserOption } from './ticketWorkbenchTypes';

interface Props {
  ticket: TicketDetail;
  config: TicketConfig | null;
  /** null = picker hidden (no USERS_READ); degrade to a label + unassign-only button. */
  assignees: UserOption[] | null;
  merged: boolean;
  canEdit: boolean;
  canManage: boolean;
  /** Value the status select shows (the open resolve/pending form's target, else the ticket's). */
  statusValue: string;
  statusColor: string | null;
  onStatusChange: (status: TicketStatus) => void;
  onCustomStatusChange: (statusId: string) => void;
  onPriorityChange: (priority: TicketPriority) => void;
  onAssign: (assigneeId: string | null) => void;
  onSubjectSave: (subject: string) => void;
  onOpenMove: () => void;
  onOpenMerge: () => void;
  onOpenDelete: () => void;
  /** Below the meta line: the narrow-width endpoint line. */
  metaExtra?: ReactNode;
}

const SELECT = 'h-8 min-w-0 rounded-md border bg-background px-2 py-1 text-xs font-medium leading-tight';

/** The subject heading's id: the queue host moves keyboard focus here when it
 *  opens a ticket or steps to another (the board row that had it is hidden). */
export const TICKET_FOCUS_SUBJECT_ID = 'ticket-focus-subject';

/**
 * Focus header: who and what (number, subject, org · requester), then the
 * three triage controls inline. Everything rarer lives in More.
 */
export default function TicketFocusHeader({
  ticket, config, assignees, merged, canEdit, canManage, statusValue, statusColor,
  onStatusChange, onCustomStatusChange, onPriorityChange, onAssign, onSubjectSave, onOpenMove, onOpenMerge, onOpenDelete, metaExtra,
}: Props) {
  const { t } = useTranslation('tickets');
  // Subject is a heading at rest; the pencil swaps in an input. `committedRef`
  // makes commit idempotent: Enter commits and leaves edit mode, and the blur
  // that follows (unmount or explicit) must not PATCH the same value twice.
  const [editingSubject, setEditingSubject] = useState(false);
  const committedRef = useRef(false);
  const closed = ticket.status === 'resolved' || ticket.status === 'closed';
  const requester = ticket.submitterName ?? ticket.submitterEmail;
  const assigneeLabel = ticket.assignedTo
    ? (assignees?.find((u) => u.id === ticket.assignedTo)?.name || ticket.assigneeName || t('ticketWorkbench.mspStaff'))
    : t('ticketWorkbench.unassigned');

  const commitSubject = (raw: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    setEditingSubject(false);
    const next = raw.trim();
    if (!next || next === ticket.subject) return;
    onSubjectSave(next);
  };
  const cancelSubjectEdit = () => {
    committedRef.current = true;
    setEditingSubject(false);
  };

  const moreItems: ActionMenuItem[] = [
    ...(!merged ? [{ id: 'move', label: t('ticketWorkbench.move.open'), onSelect: onOpenMove, testId: 'ticket-workbench-move-org' }] : []),
    ...(canEdit ? [{ id: 'merge', label: t('ticketWorkbench.merge.open'), onSelect: onOpenMerge, testId: 'ticket-merge-open' }] : []),
    ...(canManage && !merged
      ? [{ id: 'delete', label: t('common:actions.delete'), onSelect: onOpenDelete, tone: 'destructive' as const, separatorBefore: true, testId: 'ticket-delete-button' }]
      : []),
  ];

  return (
    <header className="border-b px-4 py-3" data-testid="ticket-focus-header">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-80">
          <div className="flex min-w-0 items-start gap-2">
            <span className="shrink-0 pt-1 font-mono text-sm text-muted-foreground" data-testid="ticket-workbench-number">{ticketDisplayNumber(ticket)}</span>
            {editingSubject ? (
              <input
                type="text"
                defaultValue={ticket.subject}
                autoFocus
                className="-my-0.5 min-w-0 flex-1 rounded-md border bg-background px-1.5 py-0.5 text-lg font-semibold outline-hidden focus:ring-1 focus:ring-ring"
                data-testid="ticket-workbench-subject-edit"
                aria-label={t('ticketWorkbench.ticketSubject')}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => commitSubject(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitSubject(e.currentTarget.value);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    // The page's Esc means "back to the queue"; here it only cancels the edit.
                    e.stopPropagation();
                    cancelSubjectEdit();
                  }
                }}
              />
            ) : (
              <>
                <h2
                  id={TICKET_FOCUS_SUBJECT_ID}
                  tabIndex={-1}
                  className={cn('min-w-0 line-clamp-2 break-words text-lg font-semibold leading-snug focus:outline-none', closed && 'text-muted-foreground')}
                  title={ticket.subject}
                  data-testid="ticket-workbench-subject"
                >
                  {ticket.subject}
                </h2>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => { committedRef.current = false; setEditingSubject(true); }}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                    aria-label={t('ticketWorkbench.subjectEditButton')}
                    title={t('ticketWorkbench.subjectEditButton')}
                    data-testid="ticket-workbench-subject-edit-btn"
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </>
            )}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="ticket-workbench-meta">
            <EntityLink kind="org" id={ticket.orgId} name={ticket.orgName ?? ''} tone="muted" className="min-w-0 max-w-[50%] shrink" />
            {requester && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate">{requester}</span>
              </>
            )}
          </p>
        </div>

        {/* Status and its live SLA lead. On a phone the native selects get
            fixed widths (they size to their widest option otherwise) and the
            assignee is an avatar, so the row holds Status, SLA, Priority,
            assignee and More. */}
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {statusColor && (
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor }} />
            )}
            {config ? (
              // Config path: optgroup per core state with the active custom
              // statuses (option value = row id).
              <select
                value={statusValue}
                onChange={(e) => onCustomStatusChange(e.target.value)}
                disabled={merged}
                className={cn(SELECT, 'max-sm:w-[5.5rem]', statusConfig[ticket.status].color)}
                data-testid="ticket-workbench-status"
                aria-label={t('common:labels.status')}
              >
                {activeStatusesByCore(config).map(({ coreStatus, statuses }) =>
                  statuses.length > 0 ? (
                    <optgroup key={coreStatus} label={t(/* i18n-dynamic */ `ticketWorkbench.status.${coreStatus}`)}>
                      {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </optgroup>
                  ) : null
                )}
              </select>
            ) : (
              <select
                value={statusValue}
                onChange={(e) => onStatusChange(e.target.value as TicketStatus)}
                disabled={merged}
                className={cn(SELECT, 'max-sm:w-[5.5rem]', statusConfig[ticket.status].color)}
                data-testid="ticket-workbench-status"
                aria-label={t('common:labels.status')}
              >
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{t(/* i18n-dynamic */ `ticketWorkbench.status.${s}`)}</option>)}
              </select>
            )}
            {/* The worst live SLA, at every width (no SLA: nothing). */}
            <span className="inline-flex empty:hidden" data-testid="ticket-workbench-sla"><SlaChip ticket={ticket} /></span>
          </span>
          <select
            value={ticket.priority}
            onChange={(e) => onPriorityChange(e.target.value as TicketPriority)}
            className={cn(SELECT, 'max-sm:w-[4.75rem]', priorityConfig[ticket.priority].color)}
            disabled={merged}
            data-testid="ticket-workbench-priority"
            aria-label={t('ticketWorkbench.priorityLabel')}
          >
            {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{translatedPriorityLabel(config, p, t)}</option>)}
          </select>
          {assignees !== null ? (
            // Below 640px the assignee is an initials avatar on the Status row:
            // the same select lies invisible over it (tap opens the native
            // picker); from sm up it is the plain select.
            <span className="relative inline-flex shrink-0 rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring sm:contents" title={assigneeLabel}>
              <span
                aria-hidden="true"
                data-testid="ticket-workbench-assignee-avatar"
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold sm:hidden',
                  ticket.assignedTo ? `bg-muted ${NEUTRAL_CHIP_TEXT}` : 'border border-dashed border-muted-foreground/60'
                )}
              >
                {ticket.assignedTo ? nameInitials(assigneeLabel) : ''}
              </span>
            <select
              value={ticket.assignedTo ?? ''}
              onChange={(e) => onAssign(e.target.value || null)}
              className={cn(SELECT, 'absolute inset-0 h-8 w-8 cursor-pointer font-normal text-foreground opacity-0 disabled:cursor-not-allowed sm:static sm:w-auto sm:max-w-[180px] sm:opacity-100')}
              disabled={merged}
              data-testid="ticket-workbench-assignee"
              aria-label={t('ticketWorkbench.assignee')}
            >
              <option value="">{t('ticketWorkbench.unassigned')}</option>
              {ticket.assignedTo && !assignees.some((u) => u.id === ticket.assignedTo) && (
                // Assignee exists but is RLS-invisible to this caller (partner staff seen
                // from org scope) — show a redacted label instead of pretending unassigned.
                <option value={ticket.assignedTo}>{ticket.assigneeName ?? t('ticketWorkbench.mspStaff')}</option>
              )}
              {assignees.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
            </span>
          ) : ticket.assignedTo ? (
            <button
              type="button"
              onClick={() => onAssign(null)}
              className="h-8 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
              disabled={merged}
              data-testid="ticket-workbench-unassign"
            >
              {t('ticketWorkbench.assigneeValue', { assignee: ticket.assigneeName ?? t('ticketWorkbench.mspStaff') })}
            </button>
          ) : (
            <span className="inline-flex h-8 items-center rounded-md border px-2 text-xs text-muted-foreground" data-testid="ticket-workbench-unassigned">{t('ticketWorkbench.unassigned')}</span>
          )}
          <ActionMenu
            label={t('ticketFocus.more')}
            items={moreItems}
            testId="ticket-workbench-more"
            triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          />
        </div>
        {/* Its own full-width row, so the line is never squeezed beside the controls. */}
        {metaExtra && <div className="w-full basis-full">{metaExtra}</div>}
      </div>
    </header>
  );
}
