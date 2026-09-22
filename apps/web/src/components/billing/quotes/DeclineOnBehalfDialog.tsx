import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { QUOTE_ACCEPT_ON_BEHALF_METHODS, type QuoteAcceptOnBehalfMethod } from '@breeze/shared';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { declineQuoteOnBehalf } from '../../../lib/api/quotes';
import { Dialog } from '../../shared/Dialog';
import type { Quote } from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  open: boolean;
  onClose: () => void;
  quote: Quote;
  /** Called after a successful decline so the workspace reloads. Never called
   *  on failure. */
  onDeclined: () => void;
}

/** Records a customer's decline that arrived outside the portal (#6634) — the
 *  twin of AcceptOnBehalfDialog, without the conversion: the quote is marked
 *  declined and nothing else is created.
 *
 *  Same evidence rule as the accept: no record without a reference. The reason
 *  is the customer's own words and is optional. The how/reference pair is kept
 *  in the audit log, not on the quote. */
export default function DeclineOnBehalfDialog({ open, onClose, quote, onDeclined }: Props) {
  const { t } = useTranslation('billing');
  const [method, setMethod] = useState<QuoteAcceptOnBehalfMethod>('verbal');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Fresh form on each open, so a cancelled attempt leaves nothing behind.
  useEffect(() => {
    if (!open) return;
    setMethod('verbal');
    setReference('');
    setReason('');
    setSubmitting(false);
  }, [open]);

  const ready = reference.trim().length > 0;

  const submit = useCallback(async () => {
    if (submitting || !ready) return;
    setSubmitting(true);
    try {
      const trimmedReason = reason.trim();
      await runAction({
        request: () => declineQuoteOnBehalf(quote.id, {
          method,
          reference: reference.trim(),
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        }),
        errorFallback: t('quotes.actions.declineOnBehalf.error'),
        successMessage: t('quotes.actions.declineOnBehalf.success'),
        onUnauthorized: UNAUTHORIZED,
      });
      onDeclined();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('quotes.actions.declineOnBehalf.error') });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, ready, quote.id, method, reference, reason, onDeclined, t]);

  return (
    <Dialog
      open={open}
      onClose={() => { if (!submitting) onClose(); }}
      title={t('quotes.actions.declineOnBehalf.title')}
      labelledBy="quote-decline-on-behalf-title"
      maxWidth="md"
      className="p-6"
    >
      <h3 id="quote-decline-on-behalf-title" className="text-base font-semibold text-foreground">
        {t('quotes.actions.declineOnBehalf.title')}
      </h3>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            {t('quotes.actions.declineOnBehalf.methodLabel')}
          </span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as QuoteAcceptOnBehalfMethod)}
            disabled={submitting}
            data-testid="decline-on-behalf-method"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          >
            {/* The same shared tuple the API validates against; the option
                labels are the accept dialog's, since the list is one list. */}
            {QUOTE_ACCEPT_ON_BEHALF_METHODS.map((m) => (
              // i18n-dynamic: the key is built from the shared enum member.
              <option key={m} value={m}>{t(/* i18n-dynamic */ `quotes.actions.acceptOnBehalf.method.${m}`)}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            {t('quotes.actions.declineOnBehalf.referenceLabel')}
          </span>
          <input
            type="text"
            value={reference}
            maxLength={500}
            onChange={(e) => setReference(e.target.value)}
            disabled={submitting}
            data-testid="decline-on-behalf-reference"
            aria-describedby="decline-on-behalf-reference-help"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          <span id="decline-on-behalf-reference-help" className="mt-1 block text-xs text-muted-foreground">
            {t('quotes.actions.declineOnBehalf.referenceHelp')}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            {t('quotes.actions.declineOnBehalf.reasonLabel')}
          </span>
          <textarea
            value={reason}
            maxLength={5000}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            data-testid="decline-on-behalf-reason"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </label>
      </div>

      <p className="mt-4 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="decline-on-behalf-consequence">
        {t('quotes.actions.declineOnBehalf.consequence')}
      </p>

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {t('common:actions.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !ready}
          data-testid="decline-on-behalf-submit"
          className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
        >
          {t('quotes.actions.declineOnBehalf.submit')}
        </button>
      </div>
    </Dialog>
  );
}
