import { useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '../../lib/permissions';
import { runAction, handleActionError } from '../../lib/runAction';
import { approvalFriendly } from '../../lib/ticketApproval';
import { broadcastBillingChanged } from '../../lib/timerActions';
import { ConfirmDialog } from '../shared/ConfirmDialog';

/** True for time held until the customer approves it (#8196). */
export const isAwaitingApproval = (e: { billingStatus?: string | null }) => e.billingStatus === 'awaiting_approval';

export function AwaitingApprovalChip({ entryId, className = '' }: { entryId: string; className?: string }) {
  const { t } = useTranslation('tickets');
  return (
    <span
      className={`rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 ${className}`}
      data-testid={`time-entry-awaiting-approval-${entryId}`}
    >
      {t('ticketApproval.held.chip')}
    </span>
  );
}

/**
 * Write off a held entry (time_entries:manage_billing): marks it no charge.
 * Renders nothing without the permission. The server only allows it once the
 * entry's request was denied, expired or cancelled (409 ENTRY_NOT_RESOLVABLE).
 */
export function WriteOffHeldButton({ entryId, onDone, className = '' }: { entryId: string; onDone?: () => void; className?: string }) {
  const { t } = useTranslation('tickets');
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!can('time_entries', 'manage_billing')) return null;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/time-entries/${encodeURIComponent(entryId)}/write-off-held`, { method: 'POST' }),
        errorFallback: t('ticketApproval.held.writeOffFailed'),
        successMessage: t('ticketApproval.held.writtenOff'),
        friendly: approvalFriendly(t),
      });
      setOpen(false);
      broadcastBillingChanged();
      onDone?.();
    } catch (err) {
      handleActionError(err, t('ticketApproval.held.writeOffFailed'));
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded-md border px-2 py-1 text-xs hover:bg-muted ${className}`}
        data-testid={`time-entry-write-off-${entryId}`}
      >
        {t('ticketApproval.held.writeOff')}
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => { if (!busy) setOpen(false); }}
        onConfirm={() => void confirm()}
        title={t('ticketApproval.held.writeOffTitle')}
        message={t('ticketApproval.held.writeOffMessage')}
        confirmLabel={t('ticketApproval.held.writeOff')}
        variant="warning"
        isLoading={busy}
        confirmTestId={`time-entry-write-off-confirm-${entryId}`}
        dialogTestId={`time-entry-write-off-dialog-${entryId}`}
      />
    </>
  );
}
