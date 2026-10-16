import { useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '../../lib/permissions';
import { runAction, handleActionError } from '../../lib/runAction';
import {
  approvalFriendly,
  formatApprovalAsk,
  type ApprovalRequest,
  type ApprovalStatus,
  type ApprovalSummary,
} from '../../lib/ticketApproval';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import RecordApprovalDialog from './RecordApprovalDialog';

const STATUS_CLASS: Record<ApprovalStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-700',
  denied: 'bg-red-100 text-red-700',
  expired: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
};

const METHOD_KEY: Record<string, string> = {
  verbal: 'verbal',
  email: 'email',
  signed_document: 'signedDocument',
  other: 'other',
};

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

interface Props {
  summary: ApprovalSummary;
  /** Called after any mutation so the host reloads the summary and the time list. */
  onChanged: () => void;
}

export default function TicketApprovalsPanel({ summary, onChanged }: Props) {
  const { t } = useTranslation('tickets');
  const { can } = usePermissions();
  const canWrite = can('tickets', 'write');
  const canRecord = can('tickets', 'record_approval');
  const [cancelTarget, setCancelTarget] = useState<ApprovalRequest | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [recordTarget, setRecordTarget] = useState<ApprovalRequest | null>(null);
  const [reaskId, setReaskId] = useState<string | null>(null);
  const [reaskMessage, setReaskMessage] = useState('');
  const [reasking, setReasking] = useState(false);

  if (summary.requests.length === 0) return null;

  const confirmCancel = async () => {
    const target = cancelTarget;
    if (!target || cancelling) return;
    setCancelling(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-approval-requests/${encodeURIComponent(target.id)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
        errorFallback: t('ticketApproval.panel.cancelFailed'),
        successMessage: t('ticketApproval.panel.cancelled'),
        friendly: approvalFriendly(t),
      });
      setCancelTarget(null);
      onChanged();
    } catch (err) {
      handleActionError(err, t('ticketApproval.panel.cancelFailed'));
      setCancelTarget(null);
      onChanged(); // a 409 means the request moved on: show the real state
    } finally {
      setCancelling(false);
    }
  };

  const submitReask = async (r: ApprovalRequest) => {
    if (reasking) return;
    setReasking(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-approval-requests/${encodeURIComponent(r.id)}/reask`, {
          method: 'POST',
          body: JSON.stringify(reaskMessage.trim() ? { message: reaskMessage.trim() } : {}),
        }),
        errorFallback: t('ticketApproval.panel.reaskFailed'),
        successMessage: t('ticketApproval.panel.reasked'),
        friendly: approvalFriendly(t),
      });
      setReaskId(null);
      setReaskMessage('');
      onChanged();
    } catch (err) {
      handleActionError(err, t('ticketApproval.panel.reaskFailed'));
      onChanged();
    } finally {
      setReasking(false);
    }
  };

  const renderRecipients = (label: string, emails: string[], testId: string) => (
    <p className="text-[11px] text-muted-foreground" data-testid={testId}>
      <span className="font-medium">{label}:</span>{' '}
      {emails.length > 0 ? emails.join(', ') : t('ticketApproval.panel.noneListed')}
    </p>
  );

  return (
    <div className="mt-3 border-t pt-3" data-testid="ticket-approvals-panel">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('ticketApproval.panel.title')}</p>
      <ul className="mt-2 space-y-2">
        {summary.requests.map((r) => {
          const ask = formatApprovalAsk(r);
          const pending = r.status === 'pending';
          const canReask = ['denied', 'expired', 'cancelled'].includes(r.status) && r.heldEntryCount > 0;
          return (
            <li key={r.id} className="space-y-1 rounded-md border p-2 text-xs" data-testid={`approval-request-${r.id}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">
                  {r.trigger === 'budget' ? t('ticketApproval.request.triggerBudget') : t('ticketApproval.request.triggerAfterHours')}
                </span>
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[r.status]}`} data-testid={`approval-status-${r.id}`}>
                  {t(/* i18n-dynamic */ `ticketApproval.panel.status.${r.status}`)}
                </span>
                <span className="text-[10px] text-muted-foreground" data-testid={`approval-revision-${r.id}`}>
                  {t('ticketApproval.panel.revision', { n: r.revision })}
                </span>
              </div>
              {ask && <p data-testid={`approval-ask-${r.id}`}>{t('ticketApproval.panel.ask', { ask })}</p>}
              {r.coverageStartsAt && r.coverageEndsAt && (
                <p className="text-muted-foreground">
                  {t('ticketApproval.panel.window', { from: when(r.coverageStartsAt), to: when(r.coverageEndsAt) })}
                </p>
              )}
              {r.message && <p className="text-muted-foreground">{r.message}</p>}
              {pending && (
                <p className="text-muted-foreground" data-testid={`approval-expires-${r.id}`}>
                  {t('ticketApproval.panel.expires', { when: when(r.expiresAt) })}
                </p>
              )}
              {r.heldEntryCount > 0 && (
                <p className="text-muted-foreground">{t('ticketApproval.panel.heldEntries', { count: r.heldEntryCount })}</p>
              )}
              {renderRecipients(t('ticketApproval.panel.approvers'), r.approverEmails, `approval-approvers-${r.id}`)}
              {renderRecipients(t('ticketApproval.panel.notified'), r.notifyEmails, `approval-notified-${r.id}`)}
              {pending && r.approverEmails.length === 0 && (
                <p className="rounded bg-amber-50 px-1.5 py-1 text-amber-800" data-testid={`approval-no-approver-${r.id}`}>
                  {t('ticketApproval.panel.noApprover')}
                </p>
              )}
              {r.decisionOrigin && (
                <p className="text-muted-foreground" data-testid={`approval-decision-${r.id}`}>
                  {r.decisionOrigin === 'on_behalf'
                    ? t('ticketApproval.panel.decidedOnBehalf', {
                        user: r.decidedByUserName ?? '',
                        signer: r.signerName ?? '',
                        method: r.decisionMethod
                          ? t(/* i18n-dynamic */ `ticketApproval.panel.method.${METHOD_KEY[r.decisionMethod] ?? 'other'}`)
                          : '',
                        reference: r.decisionReference ?? '',
                      })
                    : t('ticketApproval.panel.decidedByCustomer', {
                        who: r.signerName ?? r.signerEmail ?? t('ticketApproval.panel.customerFallback'),
                      })}
                </p>
              )}

              {canWrite && (pending || canReask || (canRecord && pending)) && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {pending && (
                    <button type="button" onClick={() => setCancelTarget(r)} className="rounded-md border px-2 py-1 text-[11px] hover:bg-muted" data-testid={`approval-cancel-${r.id}`}>
                      {t('ticketApproval.panel.cancel')}
                    </button>
                  )}
                  {pending && canRecord && (
                    <button type="button" onClick={() => setRecordTarget(r)} className="rounded-md border px-2 py-1 text-[11px] hover:bg-muted" data-testid={`approval-record-${r.id}`}>
                      {t('ticketApproval.panel.record')}
                    </button>
                  )}
                  {canReask && (
                    <button type="button" onClick={() => { setReaskId(reaskId === r.id ? null : r.id); setReaskMessage(''); }} className="rounded-md border px-2 py-1 text-[11px] hover:bg-muted" data-testid={`approval-reask-${r.id}`}>
                      {t('ticketApproval.panel.reask')}
                    </button>
                  )}
                </div>
              )}
              {canWrite && canReask && reaskId === r.id && (
                <div className="space-y-1 pt-1" data-testid={`approval-reask-form-${r.id}`}>
                  <textarea
                    value={reaskMessage}
                    onChange={(e) => setReaskMessage(e.target.value)}
                    rows={2}
                    aria-label={t('ticketApproval.request.message')}
                    placeholder={t('ticketApproval.request.message')}
                    className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                    data-testid={`approval-reask-message-${r.id}`}
                  />
                  <button type="button" onClick={() => void submitReask(r)} disabled={reasking} className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50" data-testid={`approval-reask-submit-${r.id}`}>
                    {t('ticketApproval.panel.reaskSubmit')}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={cancelTarget !== null}
        onClose={() => { if (!cancelling) setCancelTarget(null); }}
        onConfirm={() => void confirmCancel()}
        title={t('ticketApproval.panel.cancelConfirmTitle')}
        message={t('ticketApproval.panel.cancelConfirmMessage')}
        confirmLabel={t('ticketApproval.panel.cancel')}
        variant="warning"
        isLoading={cancelling}
        confirmTestId="approval-cancel-confirm"
        dialogTestId="approval-cancel-dialog"
      />
      {recordTarget && (
        <RecordApprovalDialog
          open
          request={recordTarget}
          onClose={() => setRecordTarget(null)}
          onRecorded={onChanged}
        />
      )}
    </div>
  );
}
