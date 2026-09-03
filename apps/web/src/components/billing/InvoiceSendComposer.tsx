import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { getJwtClaims } from '../../lib/authScope';
import { Dialog } from '../shared/Dialog';
import { parseAddressList, MAX_RECIPIENTS } from './shared/addressList';

/** The composed envelope, shaped for `POST /invoices/:id/{send,resend}`. Only
 *  non-default fields are populated, so the server's own defaults (billing
 *  contact, standard subject, PDF attached) stay in play for anything the
 *  sender left alone. */
export interface ComposedInvoiceEmail {
  to: string[];
  cc?: string[];
  subject?: string;
  message?: string;
  includePdf?: boolean;
  includeDeviceAppendix?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** True while the parent's request is in flight — disables every field. */
  sending: boolean;
  /** Fired with the composed envelope once To validates. The parent owns the
   *  request and closes the dialog on success. */
  onSend: (opts: ComposedInvoiceEmail) => void;
  /** Drives the billing-contact prefill and the "fix it here" deep link. */
  orgId: string;
  invoiceNumber: string | null;
  title: string;
  /** One-line summary above the envelope fields (who / how much). */
  intro: string;
  confirmLabel: string;
  /** Label while `sending` — e.g. "Re-sending…". */
  sendingLabel: string;
  /** Draft-time partner default. Issued composers never expose an override. */
  partnerDeviceAppendix?: boolean;
  /** Allows the draft Issue & Send flow to retain its established action id. */
  confirmTestId?: string;
}

/**
 * The invoice customer-email composer — a lightweight mail-client dialog for
 * the re-send action, mirroring the quote composer (QuoteActions.tsx) field for
 * field so a tech who has sent a proposal already knows this dialog.
 *
 * To is prefilled from the org's billing contact (best-effort; the dialog never
 * submits an empty To), Subject left blank means the server default, and the
 * partner's signature is previewed here but appended server-side.
 *
 * Deliberately NOT shared with QuoteActions' inline composer: that one carries
 * quote-only concerns (zero-total warning, missing-cost notice, deposit/Stripe
 * warnings, the schedule-vs-resend fork) which have no invoice meaning, and
 * unifying them would mean threading half a dozen quote-shaped slots through
 * this component. The two share what actually must not drift — the address
 * grammar and recipient cap (shared/addressList.ts) and the server schema.
 */
export default function InvoiceSendComposer({
  open, onClose, sending, onSend, orgId, invoiceNumber, title, intro, confirmLabel, sendingLabel,
  partnerDeviceAppendix = false, confirmTestId = 'invoice-send-confirm',
}: Props) {
  const { t } = useTranslation('billing');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [ccOpen, setCcOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [includePdf, setIncludePdf] = useState(true);
  const [includeDeviceAppendix, setIncludeDeviceAppendix] = useState(partnerDeviceAppendix);
  const [signature, setSignature] = useState<string | null>(null);
  // Set when a Send click finds no valid recipient — an inline reason under the
  // To field beats a silently dead button.
  const [toMissing, setToMissing] = useState(false);
  // Set when the org lookup CONFIRMED there is no billing contact to prefill
  // from. A failed lookup stays silent: unknown is not absent, and claiming "no
  // billing contact" on a fetch error would be false.
  const [toPrefillMissing, setToPrefillMissing] = useState(false);
  const toInputRef = useRef<HTMLInputElement>(null);

  // Reset + prefill on every open, so a previous send can never leak into the
  // next one. Both fetches are best-effort: the dialog stays usable when either
  // fails (the user types the recipient — Send blocks on a valid To).
  useEffect(() => {
    if (!open) return;
    setTo(''); setCc(''); setCcOpen(false); setSubject(''); setMessage('');
    setIncludePdf(true); setIncludeDeviceAppendix(partnerDeviceAppendix);
    setSignature(null); setToMissing(false); setToPrefillMissing(false);
    let canceled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/orgs/organizations/${orgId}`);
        if (!res.ok || canceled) return;
        const org = (await res.json()) as { billingContact?: { email?: string | null } | null };
        const email = org.billingContact?.email?.trim();
        // Functional update so a slow response never clobbers a typed address.
        if (email) setTo((cur) => cur || email);
        else setToPrefillMissing(true);
      } catch { /* leave To empty — the user types the recipient */ }
    })();
    // The signature endpoint gates on permission + a non-null partnerId, but an
    // org-scoped session has no partner context worth previewing — skip the
    // round-trip rather than fire an irrelevant GET (mirrors QuoteActions).
    if (getJwtClaims().scope === 'partner') {
      void (async () => {
        try {
          const res = await fetchWithAuth('/orgs/partners/me');
          if (!res.ok || canceled) return;
          const partner = (await res.json()) as { emailSignature?: string | null };
          setSignature(partner.emailSignature?.trim() || null);
        } catch { /* no preview — the server still appends the signature */ }
      })();
    }
    return () => { canceled = true; };
  }, [open, orgId, partnerDeviceAppendix]);

  const toParsed = useMemo(() => parseAddressList(to), [to]);
  const ccParsed = useMemo(() => parseAddressList(cc), [cc]);
  const toError =
    toParsed.invalid.length > 0
      ? t('invoiceActions.composer.invalidEmail', { addresses: toParsed.invalid.join(', ') })
      : toParsed.emails.length > MAX_RECIPIENTS
        ? t('invoiceActions.composer.tooManyRecipients', { max: MAX_RECIPIENTS })
        : null;
  const ccError =
    ccParsed.invalid.length > 0
      ? t('invoiceActions.composer.invalidEmail', { addresses: ccParsed.invalid.join(', ') })
      : ccParsed.emails.length > MAX_RECIPIENTS
        ? t('invoiceActions.composer.tooManyRecipients', { max: MAX_RECIPIENTS })
        : null;
  const valid = toParsed.emails.length > 0 && !toError && !ccError;

  const submit = useCallback(() => {
    if (sending) return;
    // The prerequisite IS the click's job: no valid recipient → focus the To
    // field and say why, rather than sitting disabled with no explanation.
    if (!valid) {
      setToMissing(toParsed.emails.length === 0 && !toError);
      toInputRef.current?.focus();
      return;
    }
    setToMissing(false);
    // The To list always goes (the user saw and confirmed it); the rest is
    // omitted where it would just restate the server default.
    const opts: ComposedInvoiceEmail = { to: toParsed.emails };
    if (ccParsed.emails.length > 0) opts.cc = ccParsed.emails;
    const subj = subject.trim();
    if (subj) opts.subject = subj;
    const note = message.trim();
    if (note) opts.message = note;
    if (!includePdf) opts.includePdf = false;
    if (includeDeviceAppendix !== partnerDeviceAppendix) opts.includeDeviceAppendix = includeDeviceAppendix;
    onSend(opts);
  }, [sending, valid, toParsed, toError, ccParsed, subject, message, includePdf, includeDeviceAppendix, partnerDeviceAppendix, onSend]);

  return (
    <Dialog
      open={open}
      onClose={() => { if (!sending) onClose(); }}
      title={title}
      labelledBy="invoice-send-dialog-title"
      maxWidth="xl"
      className="p-6"
    >
      <h3 id="invoice-send-dialog-title" className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{intro}</p>

      {/* Envelope fields: label-left rows in one bordered box, like a mail client. */}
      <div className="mt-4 divide-y rounded-md border">
        <div className="flex items-center gap-2 px-3">
          <label htmlFor="invoice-send-to" className="w-16 shrink-0 text-sm text-muted-foreground">
            {t('invoiceActions.composer.toLabel')}
          </label>
          <input
            ref={toInputRef}
            id="invoice-send-to"
            type="text"
            value={to}
            onChange={(e) => { setTo(e.target.value); setToMissing(false); }}
            disabled={sending}
            placeholder={t('invoiceActions.composer.toPlaceholder')}
            aria-invalid={toError != null}
            data-testid="invoice-send-to"
            className="min-w-0 flex-1 rounded-sm border-0 bg-transparent py-2 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          {!ccOpen && (
            <button
              type="button"
              onClick={() => setCcOpen(true)}
              data-testid="invoice-send-cc-toggle"
              className="shrink-0 text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              {t('invoiceActions.composer.ccToggle')}
            </button>
          )}
        </div>
        {ccOpen && (
          <div className="flex items-center gap-2 px-3">
            <label htmlFor="invoice-send-cc" className="w-16 shrink-0 text-sm text-muted-foreground">
              {t('invoiceActions.composer.ccLabel')}
            </label>
            <input
              id="invoice-send-cc"
              type="text"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              disabled={sending}
              aria-invalid={ccError != null}
              data-testid="invoice-send-cc"
              className="min-w-0 flex-1 rounded-sm border-0 bg-transparent py-2 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
          </div>
        )}
        <div className="flex items-center gap-2 px-3">
          <label htmlFor="invoice-send-subject" className="w-16 shrink-0 text-sm text-muted-foreground">
            {t('invoiceActions.composer.subjectLabel')}
          </label>
          <input
            id="invoice-send-subject"
            type="text"
            value={subject}
            maxLength={200}
            onChange={(e) => setSubject(e.target.value)}
            disabled={sending}
            // The placeholder mirrors the server default so leaving the field
            // blank is a visible, deliberate choice — not a missing subject.
            placeholder={
              invoiceNumber
                ? t('invoiceActions.composer.subjectPlaceholder', { number: invoiceNumber })
                : t('invoiceActions.composer.subjectPlaceholderNoNumber')
            }
            data-testid="invoice-send-subject"
            className="min-w-0 flex-1 rounded-sm border-0 bg-transparent py-2 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
        </div>
      </div>
      {toPrefillMissing && toParsed.emails.length === 0 && !toError && (
        // The org lookup confirmed no billing contact exists — say WHY the To
        // field is empty and link the fix, instead of demanding an address from
        // memory. #billing, not the bare org route: OrgSettingsPage defaults to
        // General, so an undeep link lands on a page with no visible field.
        <p className="mt-1 text-xs text-muted-foreground" data-testid="invoice-send-to-no-contact">
          <Trans
            i18nKey="invoiceActions.composer.noBillingContactHint"
            t={t}
            components={{ orgLink: <a href={`/settings/organizations/${orgId}#billing`} className="underline hover:text-foreground" /> }}
          />
        </p>
      )}
      {toError && (
        <p id="invoice-send-to-error" className="mt-1 text-xs text-destructive" data-testid="invoice-send-to-error">{toError}</p>
      )}
      {toMissing && !toError && (
        <p id="invoice-send-to-missing" className="mt-1 text-xs text-destructive" data-testid="invoice-send-to-missing">
          {t('invoiceActions.composer.recipientRequired')}
        </p>
      )}
      {ccError && (
        <p className="mt-1 text-xs text-destructive" data-testid="invoice-send-cc-error">{ccError}</p>
      )}

      <label className="mt-4 block">
        <span className="mb-1 block text-sm font-medium text-foreground">
          {t('invoiceActions.composer.messageLabel')}
        </span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          maxLength={2000}
          disabled={sending}
          placeholder={t('invoiceActions.composer.messagePlaceholder')}
          data-testid="invoice-send-message"
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
        />
      </label>
      {signature && (
        <div className="mt-2 rounded-md bg-muted/50 px-3 py-2" data-testid="invoice-send-signature-preview">
          <p className="text-xs font-medium text-muted-foreground">
            {t('invoiceActions.composer.signaturePreviewLabel')}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{signature}</p>
        </div>
      )}

      <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={includePdf}
          onChange={(e) => setIncludePdf(e.target.checked)}
          disabled={sending}
          data-testid="invoice-send-include-pdf"
        />
        {t('invoiceActions.composer.includePdfLabel')}
      </label>
      {invoiceNumber === null && (
        <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={includeDeviceAppendix}
            onChange={(e) => setIncludeDeviceAppendix(e.target.checked)}
            disabled={sending}
            data-testid="invoice-send-include-device-appendix"
          />
          {t('invoiceActions.composer.includeDeviceAppendixLabel')}
        </label>
      )}

      {/* The email's CTA is the durable no-login view-and-pay link — say so, so
          the sender knows the customer won't hit a portal login. */}
      <p className="mt-2 text-xs text-muted-foreground" data-testid="invoice-send-paylink-note">
        {t('invoiceActions.composer.payLinkNote')}
      </p>

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={sending}
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {t('common:actions.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={sending}
          aria-describedby={toMissing ? 'invoice-send-to-missing' : toError ? 'invoice-send-to-error' : undefined}
          data-testid={confirmTestId}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {sending ? sendingLabel : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
