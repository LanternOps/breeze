import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { QUOTE_ACCEPT_ON_BEHALF_METHODS, type QuoteAcceptOnBehalfMethod } from '@breeze/shared';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { fetchWithAuth } from '../../../stores/auth';
import { acceptQuoteOnBehalf } from '../../../lib/api/quotes';
import { Dialog } from '../../shared/Dialog';
import { type Quote, type QuoteLine, formatMoney } from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

/** Parses the variable names out of a 422 CONTRACT_VARIABLES_UNRESOLVED message
 *  ("Contract variables unresolved: a, b") — the same message shape
 *  `assertQuoteSendGates` (`quoteLifecycle.ts`) has always thrown for both a
 *  real Send and this accept-on-behalf path (#6637).
 *
 *  Unlike `QuoteEditor`'s `unresolvedNamesFromMessage` (which filters a
 *  known-variable list gathered from the template being attached, because
 *  that call site has one to hand), this dialog has no such list — the
 *  message IS the only source of the names — so it parses the suffix
 *  directly instead of duplicating that filtering approach for no reason.
 *
 *  This depends on the RAW server message reaching the `friendly` hook below
 *  unmangled. `runAction` overwrites `message` with an `errors:<CODE>` i18n
 *  translation BEFORE calling `friendly()`, whenever such a key exists — so
 *  if `errors:CONTRACT_VARIABLES_UNRESOLVED` is ever added to a locale (e.g.
 *  for some other caller of that code), this parser would silently stop
 *  finding the marker and fall back to the generic copy, losing the
 *  variable-name list with no error anywhere. Don't add that key without
 *  updating this parser too. */
function unresolvedVariableNamesFromMessage(message: string): string[] {
  const marker = 'Contract variables unresolved: ';
  const idx = message.indexOf(marker);
  if (idx === -1) return [];
  return message.slice(idx + marker.length).split(',').map((s) => s.trim()).filter(Boolean);
}

interface Props {
  open: boolean;
  onClose: () => void;
  quote: Quote;
  lines: QuoteLine[];
  /** Addresses the quote was sent to, oldest first. Used ONLY to prefill the
   *  optional email field — never to invent a signer name. */
  recipients: string[];
  /** Called after a successful accept, so the workspace can reload and switch
   *  to the converted view. Never called on failure. */
  onAccepted: () => void;
}

/** Records a customer's acceptance that arrived outside the portal — verbally,
 *  by email, or on a purchase order.
 *
 *  This is not a "mark as accepted" flag: it runs the same conversion the
 *  customer's own click runs, so the invoice is numbered and issued the moment
 *  the tech confirms, recurring lines become draft contracts, and the partner's
 *  auto-email setting may put the invoice in the customer's inbox. There is no
 *  undo. The dialog therefore states each of those consequences BEFORE the
 *  click, and refuses to record the acceptance without a reference — a record
 *  with no evidence behind it is a claim, not a record.
 *
 *  Its own file: QuoteActions.tsx is already 1551 lines, and this surface has a
 *  fetch, a form and five conditional consequences of its own. */
export default function AcceptOnBehalfDialog({ open, onClose, quote, lines, recipients, onAccepted }: Props) {
  const { t } = useTranslation('billing');
  const [method, setMethod] = useState<QuoteAcceptOnBehalfMethod>('verbal');
  const [reference, setReference] = useState('');
  // Prefilled from the quote's bill-to name — the company the proposal is
  // addressed to. Deliberately NOT derived from recipients[0]: a mailbox prefix
  // ("ap", "accounts") is not a person, and this field is evidence.
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Whether accepting will email the invoice to the customer. `null` = not
  // known yet (the lookup is in flight or failed), which renders no promise at
  // all — the honest answer while we don't know.
  const [autoEmail, setAutoEmail] = useState<boolean | null>(null);

  // Reset to the quote's own values each time the dialog opens, so a cancelled
  // attempt doesn't leave last time's reference sitting in the field.
  useEffect(() => {
    if (!open) return;
    setMethod('verbal');
    setReference('');
    setSignerName(quote.billToName ?? '');
    setSignerEmail(recipients[0] ?? '');
    setSubmitting(false);
    // Back to "not known yet" — a reopen must not show last time's email
    // promise for the moments before the refetch lands.
    setAutoEmail(null);
  }, [open, quote.billToName, recipients]);

  // The partner's auto-email setting, read on open from the same endpoint the
  // partner billing settings page uses. Treated as ON unless the response says
  // `false`, matching the server's own `!== false` default.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth('/orgs/partners/me');
        if (!res.ok) return;
        const p = (await res.json()) as { autoEmailInvoiceOnQuoteAccept?: boolean };
        if (!cancelled) setAutoEmail(p.autoEmailInvoiceOnQuoteAccept !== false);
      } catch {
        // Display-only: a failed lookup must not block recording the
        // acceptance. We simply promise nothing about the email.
        if (!cancelled) setAutoEmail(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const currency = quote.currencyCode ?? 'USD';
  const invoiceAmount = formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency);
  const hasRecurring = lines.some((l) => l.recurrence !== 'one_time');
  const ready = reference.trim().length > 0 && signerName.trim().length > 0;

  const submit = useCallback(async () => {
    if (submitting || !ready) return;
    setSubmitting(true);
    try {
      await runAction({
        request: () => acceptQuoteOnBehalf(quote.id, {
          method,
          reference: reference.trim(),
          signerName: signerName.trim(),
          signerEmail: signerEmail.trim() || null,
        }),
        errorFallback: t('quotes.actions.acceptOnBehalf.error'),
        // Accepting a draft on behalf runs the same send-time gates as a real
        // Send (`assertQuoteSendGates`), so the exact same two codes can come
        // back here: 422 CONTRACT_VARIABLES_UNRESOLVED and 409 DEPOSIT_INVALID
        // (#6637). Without this, the dialog showed the server's raw English
        // message verbatim — untranslated and, for the deposit case, phrased
        // for a developer ("Cannot accept: …"). Both point the tech back at
        // the quote editor, which is already visible on this same page once
        // the dialog closes.
        friendly: (code, message) => {
          if (code === 'CONTRACT_VARIABLES_UNRESOLVED') {
            const names = unresolvedVariableNamesFromMessage(message);
            return names.length > 0
              ? t('quotes.actions.acceptOnBehalf.errorContractVariablesUnresolved', { names: names.join(', ') })
              : t('quotes.actions.acceptOnBehalf.errorContractVariablesUnresolvedGeneric');
          }
          if (code === 'DEPOSIT_INVALID') return t('quotes.actions.acceptOnBehalf.errorDepositInvalid');
          return undefined;
        },
        // `invoiceNumber` is the number the ACCEPT allocated. Never
        // `quote.quoteNumber`: that is the quote's own number, and naming it in
        // "Invoice … issued" tells the tech a document exists that does not.
        parseSuccess: (data) => (data as { data: { invoiceId: string; invoiceNumber: string | null } }).data,
        // A recurring-only quote leaves the invoice in draft with no number
        // allocated, so there is no number to name — say what actually happened
        // rather than printing a blank where a number belongs.
        successMessage: (data) => (data.invoiceNumber
          ? t('quotes.actions.acceptOnBehalf.success', { number: data.invoiceNumber })
          : t('quotes.actions.acceptOnBehalf.successDraftInvoice')),
        onUnauthorized: UNAUTHORIZED,
      });
      onAccepted();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('quotes.actions.acceptOnBehalf.error') });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, ready, quote.id, method, reference, signerName, signerEmail, onAccepted, t]);

  return (
    <Dialog
      open={open}
      onClose={() => { if (!submitting) onClose(); }}
      title={t('quotes.actions.acceptOnBehalf.title')}
      labelledBy="quote-accept-on-behalf-title"
      maxWidth="md"
      className="p-6"
    >
      <h3 id="quote-accept-on-behalf-title" className="text-base font-semibold text-foreground">
        {t('quotes.actions.acceptOnBehalf.title')}
      </h3>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            {t('quotes.actions.acceptOnBehalf.methodLabel')}
          </span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as QuoteAcceptOnBehalfMethod)}
            disabled={submitting}
            data-testid="accept-on-behalf-method"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          >
            {/* Straight off the shared tuple the API validates against, so the
                picker cannot drift into a 400 the tech can't diagnose. */}
            {QUOTE_ACCEPT_ON_BEHALF_METHODS.map((m) => (
              // i18n-dynamic: the key is built from the shared enum member.
              <option key={m} value={m}>{t(/* i18n-dynamic */ `quotes.actions.acceptOnBehalf.method.${m}`)}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            {t('quotes.actions.acceptOnBehalf.referenceLabel')}
          </span>
          <input
            type="text"
            value={reference}
            maxLength={500}
            onChange={(e) => setReference(e.target.value)}
            disabled={submitting}
            data-testid="accept-on-behalf-reference"
            aria-describedby="accept-on-behalf-reference-help"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          <span id="accept-on-behalf-reference-help" className="mt-1 block text-xs text-muted-foreground">
            {t('quotes.actions.acceptOnBehalf.referenceHelp')}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            {t('quotes.actions.acceptOnBehalf.signerNameLabel')}
          </span>
          <input
            type="text"
            value={signerName}
            maxLength={255}
            onChange={(e) => setSignerName(e.target.value)}
            disabled={submitting}
            data-testid="accept-on-behalf-signer-name"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            {t('quotes.actions.acceptOnBehalf.signerEmailLabel')}
          </span>
          <input
            type="email"
            value={signerEmail}
            maxLength={255}
            onChange={(e) => setSignerEmail(e.target.value)}
            disabled={submitting}
            data-testid="accept-on-behalf-signer-email"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </label>
      </div>

      {/* What is about to happen, in the order it happens. Always visible —
          this is the dialog's reason to exist, not a detail behind a toggle. */}
      <ul className="mt-4 space-y-1 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="accept-on-behalf-consequences">
        <li data-testid="accept-on-behalf-consequence-invoice">
          {t('quotes.actions.acceptOnBehalf.consequenceInvoice', { amount: invoiceAmount })}
        </li>
        {hasRecurring && (
          <li data-testid="accept-on-behalf-consequence-contracts">
            {t('quotes.actions.acceptOnBehalf.consequenceContracts')}
          </li>
        )}
        {autoEmail === true && (
          <li data-testid="accept-on-behalf-consequence-email">
            {t('quotes.actions.acceptOnBehalf.consequenceEmail')}
          </li>
        )}
        {/* A draft was never sent, so the customer has never seen the document
            this invoice is for. That is the one consequence voiding the invoice
            does not undo. */}
        {quote.status === 'draft' && (
          <li className="font-medium text-warning-foreground dark:text-warning" data-testid="accept-on-behalf-draft-warning">
            {t('quotes.actions.acceptOnBehalf.consequenceDraft')}
          </li>
        )}
      </ul>

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
          data-testid="accept-on-behalf-submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {t('quotes.actions.acceptOnBehalf.submit')}
        </button>
      </div>
    </Dialog>
  );
}
