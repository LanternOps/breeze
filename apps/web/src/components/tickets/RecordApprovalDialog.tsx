import { useEffect, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { approvalFriendly, formatApprovalAsk, type ApprovalRequest, type DecisionMethod } from '../../lib/ticketApproval';
import { Dialog } from '../shared/Dialog';

type Decision = 'approved' | 'denied';

export type RecordableRequest = Pick<
  ApprovalRequest,
  'id' | 'revision' | 'trigger' | 'requestedExtensionMinutes' | 'requestedExtensionAmount' | 'currencyCode'
>;

const METHODS: Array<{ value: DecisionMethod; labelKey: string }> = [
  { value: 'verbal', labelKey: 'verbal' },
  { value: 'email', labelKey: 'email' },
  { value: 'signed_document', labelKey: 'signedDocument' },
  { value: 'other', labelKey: 'other' },
];

/** Codes meaning the request moved on while the dialog was open: close and reload. */
const STALE_CODES = new Set(['REQUEST_CHANGED', 'REQUEST_NOT_PENDING', 'REQUEST_EXPIRED']);

interface Props {
  open: boolean;
  request: RecordableRequest;
  onClose: () => void;
  /** Called after the decision landed, or when the request turned out stale; the host reloads. */
  onRecorded: () => void;
}

/**
 * Staff records the customer's decision on their behalf (tickets:record_approval,
 * enforced server-side). The body carries the revision the staff member SAW so
 * the server can refuse a decision on a request that was re-asked meanwhile, and
 * never an actor field: the server stamps who recorded it.
 */
export default function RecordApprovalDialog({ open, request, onClose, onRecorded }: Props) {
  const { t } = useTranslation('tickets');
  const [decision, setDecision] = useState<Decision>('approved');
  const [method, setMethod] = useState<DecisionMethod>('verbal');
  const [reference, setReference] = useState('');
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDecision('approved');
    setMethod('verbal');
    setReference('');
    setSignerName('');
    setSignerEmail('');
    setNote('');
    setBusy(false);
  }, [open, request.id, request.revision]);

  const valid = reference.trim() !== '' && signerName.trim() !== '';

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-approval-requests/${encodeURIComponent(request.id)}/decide-on-behalf`, {
          method: 'POST',
          body: JSON.stringify({
            decision,
            revision: request.revision,
            method,
            reference: reference.trim(),
            signerName: signerName.trim(),
            ...(signerEmail.trim() ? { signerEmail: signerEmail.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          }),
        }),
        errorFallback: t('ticketApproval.record.failed'),
        successMessage: t('ticketApproval.record.recorded'),
        friendly: approvalFriendly(t),
      });
      onRecorded();
      onClose();
    } catch (err) {
      handleActionError(err, t('ticketApproval.record.failed'));
      if (err instanceof ActionError && err.code && STALE_CODES.has(err.code)) {
        onRecorded();
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  const ask = formatApprovalAsk(request);
  const inputClass = 'w-full rounded-md border bg-background px-2 py-1.5 text-sm';

  return (
    <Dialog open={open} onClose={onClose} title={t('ticketApproval.record.title')} maxWidth="md" className="p-6">
      <div data-testid="record-approval-dialog" className="space-y-3">
        <h2 className="text-base font-semibold">{t('ticketApproval.record.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('ticketApproval.record.intro')}</p>
        <p className="text-xs text-muted-foreground" data-testid="record-approval-target">
          {t('ticketApproval.record.target', { revision: request.revision, ask })}
        </p>

        <fieldset className="flex gap-4 text-sm">
          <legend className="mb-1 text-xs text-muted-foreground">{t('ticketApproval.record.decision')}</legend>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="record-approval-decision" checked={decision === 'approved'} onChange={() => setDecision('approved')} data-testid="record-approval-decision-approved" />
            {t('ticketApproval.record.approve')}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="record-approval-decision" checked={decision === 'denied'} onChange={() => setDecision('denied')} data-testid="record-approval-decision-denied" />
            {t('ticketApproval.record.deny')}
          </label>
        </fieldset>

        <label className="block text-xs text-muted-foreground">
          {t('ticketApproval.record.method')}
          <select value={method} onChange={(e) => setMethod(e.target.value as DecisionMethod)} className={`${inputClass} mt-1`} data-testid="record-approval-method">
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>{t(/* i18n-dynamic */ `ticketApproval.panel.method.${m.labelKey}`)}</option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-muted-foreground">
          {t('ticketApproval.record.reference')}
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t('ticketApproval.record.referencePlaceholder')} required className={`${inputClass} mt-1`} data-testid="record-approval-reference" />
        </label>

        <label className="block text-xs text-muted-foreground">
          {t('ticketApproval.record.signerName')}
          <input type="text" value={signerName} onChange={(e) => setSignerName(e.target.value)} required className={`${inputClass} mt-1`} data-testid="record-approval-signer-name" />
        </label>

        <label className="block text-xs text-muted-foreground">
          {t('ticketApproval.record.signerEmail')}
          <input type="email" value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} className={`${inputClass} mt-1`} data-testid="record-approval-signer-email" />
        </label>

        <label className="block text-xs text-muted-foreground">
          {t('ticketApproval.record.note')}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`${inputClass} mt-1`} data-testid="record-approval-note" />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="record-approval-cancel">
            {t('common:actions.cancel')}
          </button>
          <button type="button" onClick={() => void submit()} disabled={!valid || busy} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" data-testid="record-approval-submit">
            {busy ? t('common:states.saving') : t('ticketApproval.record.submit')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
