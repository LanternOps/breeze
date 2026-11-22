import { useCallback, useEffect, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { approvalFriendly } from '../../lib/ticketApproval';
import { Dialog } from '../shared/Dialog';
import type { MoveBlockedDetails, OrgOption } from './ticketWorkbenchTypes';

const TITLE_ID = 'ticket-move-org-title';

interface Props {
  open: boolean;
  onClose: () => void;
  ticketId: string;
  currentOrgId: string;
  orgs: OrgOption[];
  /** Fired after a successful move so the host reconciles the ticket. */
  onMoved: () => void;
}

/**
 * "Move to another org…" from the More menu. The 409
 * TICKET_MOVE_CURRENCY_BLOCKED guidance renders inside the dialog, and "move
 * anyway" is gated on an explicit checkbox (spec §7: bill first, or
 * deliberately accept).
 */
export default function TicketMoveOrgDialog({ open, onClose, ticketId, currentOrgId, orgs, onMoved }: Props) {
  const { t } = useTranslation('tickets');
  const [moveOrgTargetId, setMoveOrgTargetId] = useState('');
  const [moveBlocked, setMoveBlocked] = useState<MoveBlockedDetails | null>(null);
  const [acceptCurrency, setAcceptCurrency] = useState(false);
  const [moving, setMoving] = useState(false);

  // Every open starts clean.
  useEffect(() => {
    if (!open) return;
    setMoveOrgTargetId('');
    setMoveBlocked(null);
    setAcceptCurrency(false);
  }, [open]);

  // Returns true on success so the caller decides whether to close. A 409
  // TICKET_MOVE_CURRENCY_BLOCKED keeps it open with guidance; every other
  // ActionError was already toasted by runAction.
  const handleMoveOrg = useCallback(async (
    targetOrgId: string,
    opts: { acceptCurrencyMismatch?: boolean } = {}
  ): Promise<boolean> => {
    setMoving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/move-org`, {
          method: 'POST',
          body: JSON.stringify({ orgId: targetOrgId, ...(opts.acceptCurrencyMismatch ? { acceptCurrencyMismatch: true } : {}) })
        }),
        errorFallback: t('ticketWorkbench.move.failed'),
        // APPROVAL_REQUEST_PENDING: a request is waiting on the customer (#8196).
        friendly: approvalFriendly(t),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      setMoveBlocked(null);
      setAcceptCurrency(false);
      onMoved();
      return true;
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      if (err.code === 'TICKET_MOVE_CURRENCY_BLOCKED') {
        const details = (err.body as { details?: MoveBlockedDetails } | undefined)?.details;
        if (details) setMoveBlocked(details);
      }
      return false;
    } finally {
      setMoving(false);
    }
  }, [ticketId, onMoved, t]);

  const cancel = () => { setMoveBlocked(null); setAcceptCurrency(false); onClose(); };

  return (
    <Dialog open={open} onClose={moving ? () => {} : cancel} title={t('ticketWorkbench.move.label')} labelledBy={TITLE_ID} maxWidth="md" className="p-5">
      <div className="space-y-3" data-testid="ticket-workbench-move-org-form">
        <h2 id={TITLE_ID} className="text-base font-semibold">{t('ticketWorkbench.move.label')}</h2>
        <label className="sr-only" htmlFor="move-org-select">{t('ticketWorkbench.move.label')}</label>
        <select
          id="move-org-select"
          data-testid="ticket-workbench-move-org-select"
          value={moveOrgTargetId}
          onChange={(e) => { setMoveOrgTargetId(e.target.value); setMoveBlocked(null); setAcceptCurrency(false); }}
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">{t('ticketWorkbench.move.selectOrganization')}</option>
          {orgs.filter((o) => o.id !== currentOrgId).map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        {moveBlocked && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm" role="status">
            <p data-testid="ticket-move-blocked-currency">
              {t('ticketWorkbench.move.blockedCurrency', {
                timeCount: moveBlocked.unbilledTimeEntries,
                partCount: moveBlocked.unbilledParts,
                sourceCurrency: moveBlocked.sourceCurrency,
                targetCurrency: moveBlocked.targetCurrency,
                targetOrg: orgs.find((o) => o.id === moveOrgTargetId)?.name ?? moveOrgTargetId,
              })}
            </p>
            <label className="mt-1.5 flex items-start gap-2">
              <input
                type="checkbox"
                data-testid="ticket-move-accept-currency"
                checked={acceptCurrency}
                onChange={(e) => setAcceptCurrency(e.target.checked)}
                className="mt-0.5"
              />
              <span>{t('ticketWorkbench.move.acceptCurrency', { sourceCurrency: moveBlocked.sourceCurrency })}</span>
            </label>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="ticket-workbench-move-org-cancel"
            onClick={cancel}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            data-testid="ticket-workbench-move-org-confirm"
            disabled={!moveOrgTargetId || moving}
            onClick={() => {
              if (!moveOrgTargetId) return;
              // Close only on success — the 409 guidance renders inside this form.
              void handleMoveOrg(moveOrgTargetId).then((ok) => { if (ok) onClose(); });
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {t('ticketWorkbench.move.confirm')}
          </button>
          {moveBlocked && (
            <button
              type="button"
              data-testid="ticket-workbench-move-org-accept"
              disabled={!acceptCurrency || moving || !moveOrgTargetId}
              onClick={() => {
                if (!moveOrgTargetId) return;
                void handleMoveOrg(moveOrgTargetId, { acceptCurrencyMismatch: true }).then((ok) => { if (ok) onClose(); });
              }}
              className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground disabled:opacity-50"
            >
              {t('ticketWorkbench.move.moveAnyway')}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
