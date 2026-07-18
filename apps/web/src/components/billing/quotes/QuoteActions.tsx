import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, MoreHorizontal } from 'lucide-react';
import '../../../lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../../lib/runAction';
import { useMenuKeyboard } from '../shared/menuKeyboard';
import { showToast } from '../../shared/Toast';
import { usePermissions } from '../../../lib/permissions';
import { useOrgStore } from '../../../stores/orgStore';
import { fetchWithAuth } from '../../../stores/auth';
import { getJwtClaims } from '../../../lib/authScope';
import { isValidEmail } from '@/lib/email';
import { cloneQuote, deleteQuote, sendQuote, type SendQuoteOptions, type QuoteSendEmailReason } from '../../../lib/api/quotes';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { Dialog } from '../../shared/Dialog';
import { useQuotePdfDownload } from './useQuoteImage';
import { type QuoteDetail as QuoteDetailData, formatMoney } from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

/** Mirrors the send route's `.max(10)` on both `to` and `cc`. */
const MAX_RECIPIENTS = 10;

/** Split a comma/semicolon/newline-separated address list into valid + invalid
 *  entries (case-insensitively deduped, first-seen order kept). The server
 *  re-validates every address; this only powers the pre-submit UX guard. */
function parseAddressList(raw: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\n]+/)) {
    const addr = part.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (isValidEmail(addr) ? emails : invalid).push(addr);
  }
  return { emails, invalid };
}

interface Props {
  detail: QuoteDetailData;
  onChanged?: () => void;
  /**
   * 'rail' — the stacked, full-width treatment inside the Detail summary column.
   * 'header' — the compact, inline treatment in the workspace header so the
   * primary money-action (Send) is reachable from any tab, not buried in Detail.
   * The two never render at once: the workspace passes `actionsInHeader` to
   * QuoteDetail, which suppresses its rail copy when the header owns the actions.
   */
  variant: 'rail' | 'header';
  /** True while the editor still has an in-flight save or a dirty field. Send is
   *  held (with a "Saving changes…" hint) until the quote is quiescent, so the
   *  confirm dialog can't quote a stale total or race a blur-save server-side. */
  savePending?: boolean;
}

/**
 * The quote's primary actions — Send proposal (the irreversible money-moment),
 * Download PDF, Delete draft — with their confirm dialogs. Single source so the
 * Detail rail and the workspace header can't drift in behavior or copy; the
 * data-testids are stable across both variants.
 */
export default function QuoteActions({ detail, onChanged, variant, savePending = false }: Props) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const organizations = useOrgStore((s) => s.organizations);
  const { quote, blocks, lines } = detail;
  const currency = quote.currencyCode;

  const { busy, downloadPdf } = useQuotePdfDownload(quote);
  const [sending, setSending] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendMessage, setSendMessage] = useState('');
  // Send composer fields. To/Cc are raw text inputs parsed on the fly
  // (parseAddressList splits on comma / semicolon / newline); Subject left blank
  // means "use the server default".
  const [sendTo, setSendTo] = useState('');
  const [sendCc, setSendCc] = useState('');
  const [ccOpen, setCcOpen] = useState(false);
  const [sendSubject, setSendSubject] = useState('');
  const [includePdf, setIncludePdf] = useState(true);
  // Partner-scope support data, loaded when the composer opens: the partner's
  // email signature (preview only — the server appends it) and Stripe-connect
  // status (drives the deposit-can't-be-paid warning). null = unknown/not loaded.
  const [signature, setSignature] = useState<string | null>(null);
  const [stripeStatus, setStripeStatus] = useState<'connected' | 'disconnected' | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneOrgId, setCloneOrgId] = useState(quote.orgId);
  const [cloneTitle, setCloneTitle] = useState('');
  // Header-variant overflow menu (Clone / Delete) so the header cluster stays a
  // stable two-buttons-plus-kebab instead of a wrapping four-button row.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  // Focus-on-open + arrow-key cycling for the menu items (Tab closes).
  const { listRef: menuListRef, onKeyDown: onMenuListKeyDown } = useMenuKeyboard(menuOpen, () => setMenuOpen(false));
  const refresh = useCallback(() => onChanged?.(), [onChanged]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    // Escape closes AND returns focus to the trigger — focus was moved into the
    // menu on open, so without the refocus it would drop to <body>.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenuOpen(false); menuTriggerRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // An empty quote (no blocks, no lines) can't be sent.
  const isEmpty = blocks.length === 0 && lines.length === 0;
  const isDraft = quote.status === 'draft';
  // Deposit configured → the composer must warn when Stripe isn't connected,
  // since the customer would have no way to actually pay that deposit online.
  const hasDeposit = Boolean(quote.depositType && quote.depositType !== 'none');

  const orgName = useMemo(() => {
    const billTo = quote.billToName?.trim();
    if (billTo) return billTo;
    const resolved = organizations.find((o) => o.id === quote.orgId)?.name?.trim();
    return resolved || quote.orgId.slice(0, 8);
  }, [quote.billToName, quote.orgId, organizations]);

  // Company choices for the clone dialog: the partner's org list, with the
  // quote's own org prepended if it isn't loaded (e.g. All-orgs scope) so the
  // select always has a valid default.
  const orgOptions = useMemo(() => {
    const sorted = [...organizations].sort((a, b) => a.name.localeCompare(b.name));
    if (!sorted.some((o) => o.id === quote.orgId)) {
      sorted.unshift({ id: quote.orgId, name: orgName } as (typeof sorted)[number]);
    }
    return sorted;
  }, [organizations, quote.orgId, orgName]);

  // Open the composer with fresh fields, then prefill/support-fetch in the
  // background. All three fetches are best-effort: the composer stays usable
  // (and the server keeps its own billing-contact fallback) when any fail.
  const openSend = useCallback(() => {
    setSendTo('');
    setSendCc('');
    setCcOpen(false);
    setSendSubject('');
    setIncludePdf(true);
    setSignature(null);
    setStripeStatus(null);
    setSendOpen(true);
    void (async () => {
      try {
        const res = await fetchWithAuth(`/orgs/organizations/${quote.orgId}`);
        if (!res.ok) return;
        const org = (await res.json()) as { billingContact?: { email?: string | null } | null };
        const email = org.billingContact?.email?.trim();
        // Functional update so a slow response never clobbers a typed address.
        if (email) setSendTo((cur) => cur || email);
      } catch { /* leave To empty — the user types the recipient */ }
    })();
    // Signature + Stripe status are partner-level support data. The endpoints
    // aren't scope-gated (they gate on permission + a non-null partnerId, not a
    // partner-vs-org token), but an org-scoped session has no partner context
    // worth previewing here — so gate the round-trips on partner scope
    // client-side (see lib/authScope.ts) rather than fire doomed/irrelevant GETs.
    if (getJwtClaims().scope === 'partner') {
      void (async () => {
        try {
          const res = await fetchWithAuth('/orgs/partners/me');
          if (!res.ok) return;
          const partner = (await res.json()) as { emailSignature?: string | null };
          setSignature(partner.emailSignature?.trim() || null);
        } catch { /* no preview — the server still appends the signature */ }
      })();
      void (async () => {
        try {
          const res = await fetchWithAuth('/partner/stripe-connect');
          if (!res.ok) return;
          const body = (await res.json()) as { status?: string };
          setStripeStatus(body.status === 'connected' ? 'connected' : 'disconnected');
        } catch { /* unknown status — show neither the warning nor the note */ }
      })();
    }
  }, [quote.orgId]);

  const closeSend = useCallback(() => {
    if (sending) return;
    setSendOpen(false);
    setSendMessage('');
  }, [sending]);

  const toParsed = useMemo(() => parseAddressList(sendTo), [sendTo]);
  const ccParsed = useMemo(() => parseAddressList(sendCc), [sendCc]);
  const toError =
    toParsed.invalid.length > 0
      ? t('quotes.actions.sendConfirm.invalidEmail', { addresses: toParsed.invalid.join(', ') })
      : toParsed.emails.length > MAX_RECIPIENTS
        ? t('quotes.actions.sendConfirm.tooManyRecipients', { max: MAX_RECIPIENTS })
        : null;
  const ccError =
    ccParsed.invalid.length > 0
      ? t('quotes.actions.sendConfirm.invalidEmail', { addresses: ccParsed.invalid.join(', ') })
      : ccParsed.emails.length > MAX_RECIPIENTS
        ? t('quotes.actions.sendConfirm.tooManyRecipients', { max: MAX_RECIPIENTS })
        : null;
  const composerValid = toParsed.emails.length > 0 && !toError && !ccError;

  const send = useCallback(async () => {
    if (sending || !composerValid) return;
    setSending(true);
    try {
      // The To list is always sent (the user saw and confirmed it); the other
      // fields are omitted when they'd just restate the server default.
      const opts: SendQuoteOptions = { to: toParsed.emails };
      if (ccParsed.emails.length > 0) opts.cc = ccParsed.emails;
      const subject = sendSubject.trim();
      if (subject) opts.subject = subject;
      const note = sendMessage.trim();
      if (note) opts.message = note;
      if (!includePdf) opts.includePdf = false;
      const result = await runAction<{ data?: { emailed?: boolean; emailReason?: QuoteSendEmailReason } }>({
        request: () => sendQuote(quote.id, opts),
        errorFallback: t('quotes.actions.sendError'),
        onUnauthorized: UNAUTHORIZED,
      });
      setSendOpen(false);
      setSendMessage('');
      refresh();
      if (result?.data?.emailed === false) {
        // The send committed but NO email went out (the API's email step is
        // best-effort) — a plain success toast here would hide that the
        // customer never received anything. Say so, with the why.
        const warnByReason: Record<QuoteSendEmailReason, string> = {
          no_billing_contact: t('quotes.actions.sendEmailWarning.noBillingContact', { orgName }),
          no_email_service: t('quotes.actions.sendEmailWarning.noEmailService'),
          pdf_render_failed: t('quotes.actions.sendEmailWarning.pdfRenderFailed'),
          send_failed: t('quotes.actions.sendEmailWarning.sendFailed'),
        };
        showToast({
          message: (result.data.emailReason && warnByReason[result.data.emailReason]) ?? warnByReason.send_failed,
          type: 'warning',
        });
      } else {
        // Tell the seller what happens next: the quote advances to Viewed and
        // Accepted on its own as the customer engages — no further action here.
        showToast({ message: t('quotes.actions.sendSuccess', { orgName }), type: 'success' });
      }
    } catch (err) {
      handleActionError(err, t('quotes.actions.sendError'));
    } finally {
      setSending(false);
    }
  }, [sending, composerValid, quote.id, toParsed, ccParsed, sendSubject, sendMessage, includePdf, orgName, refresh, t]);

  const remove = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await runAction({
        request: () => deleteQuote(quote.id),
        errorFallback: t('quotes.actions.deleteError'),
        successMessage: t('quotes.actions.deleteSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      setDelOpen(false);
      void navigateTo('/billing/quotes');
    } catch (err) {
      handleActionError(err, t('quotes.actions.deleteError'));
    } finally {
      setDeleting(false);
    }
  }, [deleting, quote.id, t]);

  // Prime the dialog with the current company and a "Clone of …" title the user
  // can overwrite. maxLength mirrors the API's 200-char title cap.
  const openClone = useCallback(() => {
    setMenuOpen(false);
    setCloneOrgId(quote.orgId);
    setCloneTitle(
      t('quotes.actions.cloneDialog.defaultTitle', {
        name: quote.title?.trim() || quote.quoteNumber || '',
      }).slice(0, 200),
    );
    setCloneOpen(true);
  }, [quote.orgId, quote.title, quote.quoteNumber, t]);

  const clone = useCallback(async () => {
    if (cloning || savePending) return;
    setCloning(true);
    try {
      // Always send the title — an emptied field means "untitled clone" (the API
      // nulls a blank), not "inherit the source title".
      const result = await runAction<{ data: { id: string } }>({
        request: () => cloneQuote(quote.id, { orgId: cloneOrgId, title: cloneTitle.trim() }),
        errorFallback: t('quotes.actions.cloneError'),
        successMessage: t('quotes.actions.cloneSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      setCloneOpen(false);
      if (result?.data?.id) void navigateTo(`/billing/quotes/${result.data.id}`);
    } catch (err) {
      handleActionError(err, t('quotes.actions.cloneError'));
    } finally {
      setCloning(false);
    }
  }, [cloning, quote.id, cloneOrgId, cloneTitle, savePending, t]);

  const header = variant === 'header';
  // Rail buttons stretch full-width and stack; header buttons size to content and
  // sit in a row. The class fragments below are the only thing the variant changes.
  const layout = header ? 'flex flex-wrap items-center gap-2' : 'space-y-2';
  const btnBase = header
    ? 'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium'
    : 'inline-flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium';

  const canSend = can('quotes', 'send') && isDraft;
  const canClone = can('quotes', 'write');
  const canDelete = can('quotes', 'write') && isDraft;

  // Nothing to show (e.g. a viewer on an issued quote) — render no empty container.
  if (!canSend && !can('quotes', 'read') && !canClone && !canDelete) return null;

  return (
    <>
      <div className={layout} data-testid={`quote-actions-${variant}`}>
        {/* Send a draft proposal: issues a number, emails the customer's billing
            contact with the PDF + a public accept link, and flips draft→sent.
            Gated on quotes:send; only a draft can be sent. An empty quote can't. */}
        {canSend && (
          <button
            type="button"
            onClick={openSend}
            disabled={sending || isEmpty || savePending}
            // Tie the disabled button to the visible hint below (rendered in both
            // variants) so AT announces the reason when the button takes focus.
            aria-describedby={
              isEmpty ? `quote-send-empty-hint-${variant}`
                : savePending ? `quote-send-saving-hint-${variant}`
                : undefined
            }
            title={
              isEmpty ? t('quotes.actions.emptyHint')
                : savePending ? t('quotes.actions.savingTitle')
                : undefined
            }
            data-testid="quote-send"
            className={`${btnBase} inline-flex items-center justify-center gap-1.5 bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50`}
          >
            {/* The label stays "Send proposal" while edits settle — a spinner
                marks the wait instead. Swapping the label to "Saving…" resized
                the button (shifting the sticky header cluster) and made the
                SEND button read as if a send were already in progress. The
                spinner's slot is always reserved (invisible at rest) so its
                appearance never shifts the cluster either. */}
            <Loader2 className={`h-3.5 w-3.5 ${sending || savePending ? 'animate-spin' : 'invisible'}`} aria-hidden="true" />
            {sending ? t('quotes.actions.sending') : t('quotes.actions.sendProposal')}
          </button>
        )}
        {/* In the rail the secondary actions stack as full-width buttons; in the
            header they fold into the kebab menu below so the cluster stays a
            stable Send + Download + ⋯ row that doesn't wrap awkwardly. */}
        {!header && canClone && (
          <button
            type="button"
            onClick={openClone}
            disabled={cloning || savePending}
            title={savePending ? t('quotes.actions.cloneSavingTitle') : undefined}
            data-testid="quote-clone"
            className={`${btnBase} border hover:bg-muted disabled:opacity-50`}
          >
            {cloning ? t('quotes.actions.cloning') : t('quotes.actions.cloneQuote')}
          </button>
        )}
        {/* PDF download is a read affordance (quotes has no dedicated export
            permission), so it's gated on quotes:read. */}
        {can('quotes', 'read') && (
          <button
            type="button"
            onClick={() => void downloadPdf()}
            disabled={busy}
            data-testid="quote-download-pdf"
            className={`${btnBase} border hover:bg-muted disabled:opacity-50`}
          >
            {t('quotes.actions.downloadPdf')}
          </button>
        )}
        {!header && canDelete && (
          <button
            type="button"
            onClick={() => setDelOpen(true)}
            data-testid="quote-delete-open"
            className={`${btnBase} border border-destructive/40 text-destructive hover:bg-destructive/10`}
          >
            {t('quotes.actions.deleteDraft')}
          </button>
        )}
        {header && (canClone || canDelete) && (
          <div className="relative" ref={menuRef}>
            <button
              ref={menuTriggerRef}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('quotes.actions.moreActions')}
              title={t('quotes.actions.moreActions')}
              data-testid="quote-actions-menu"
              className="inline-flex items-center justify-center rounded-md border px-2.5 py-2 text-sm font-medium hover:bg-muted"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div
                role="menu"
                ref={menuListRef}
                onKeyDown={onMenuListKeyDown}
                data-testid="quote-actions-menu-list"
                className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border bg-card py-1 shadow-lg"
              >
                {canClone && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={openClone}
                    disabled={cloning || savePending}
                    title={savePending ? t('quotes.actions.cloneSavingTitle') : undefined}
                    data-testid="quote-clone"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-hidden disabled:opacity-50"
                  >
                    {cloning ? t('quotes.actions.cloning') : t('quotes.actions.cloneQuote')}
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => { setMenuOpen(false); setDelOpen(true); }}
                    data-testid="quote-delete-open"
                    className="block w-full px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-hidden"
                  >
                    {t('quotes.actions.deleteDraft')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {canSend && isEmpty && (
          // Visible in BOTH variants — a sighted keyboard user (or anyone not
          // hovering for the title tooltip) needs to see WHY the highest-stakes
          // button is disabled. Rendered LAST so in the header row it takes a
          // full-width basis and wraps onto its own line BELOW the whole action
          // cluster (never inline between buttons, which would drag the cluster
          // into the page centre), right-aligned under the right-aligned buttons.
          <p
            id={`quote-send-empty-hint-${variant}`}
            data-testid="quote-send-empty-hint"
            className={header ? 'basis-full text-xs text-muted-foreground text-right' : 'text-center text-xs text-muted-foreground'}
          >
            {t('quotes.actions.emptyHint')}
          </p>
        )}
        {canSend && !isEmpty && savePending && (
          // Same placement rules as the empty-quote hint above: the user must be
          // able to SEE why the money-button is held, not just hover for it.
          <p
            id={`quote-send-saving-hint-${variant}`}
            data-testid="quote-send-saving-hint"
            className={header ? 'basis-full text-xs text-muted-foreground text-right' : 'text-center text-xs text-muted-foreground'}
          >
            {t('quotes.actions.savingHint')}
          </p>
        )}
      </div>

      {/* Send composer — a lightweight email-client dialog. To is prefilled from
          the org billing contact (best-effort; the server keeps its own fallback),
          Subject left blank means the server default, and the partner's email
          signature / Stripe-connect status are support data loaded only under a
          partner-scoped session (not because the endpoints reject org tokens). */}
      <Dialog
        open={sendOpen}
        onClose={closeSend}
        title={t('quotes.actions.sendConfirm.title')}
        labelledBy="quote-send-dialog-title"
        maxWidth="xl"
        className="p-6"
      >
        <h3 id="quote-send-dialog-title" className="text-base font-semibold text-foreground">
          {t('quotes.actions.sendConfirm.title')}
        </h3>
        {/* Send summary + irreversibility copy carried over from the old confirm step. */}
        <p className="mt-1 text-sm text-muted-foreground">
          {t('quotes.actions.sendConfirm.message', {
            orgName,
            amount: formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency),
          })}
        </p>

        {/* Envelope fields: label-left rows in one bordered box, like a mail client. */}
        <div className="mt-4 divide-y rounded-md border">
          <div className="flex items-center gap-2 px-3">
            <label htmlFor="quote-send-to" className="w-16 shrink-0 text-sm text-muted-foreground">
              {t('quotes.actions.sendConfirm.toLabel')}
            </label>
            <input
              id="quote-send-to"
              type="text"
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
              disabled={sending}
              placeholder={t('quotes.actions.sendConfirm.toPlaceholder')}
              aria-invalid={toError != null}
              data-testid="quote-send-to"
              className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm focus:outline-hidden disabled:opacity-60"
            />
            {!ccOpen && (
              <button
                type="button"
                onClick={() => setCcOpen(true)}
                data-testid="quote-send-cc-toggle"
                className="shrink-0 text-sm text-muted-foreground hover:text-foreground hover:underline"
              >
                {t('quotes.actions.sendConfirm.ccToggle')}
              </button>
            )}
          </div>
          {ccOpen && (
            <div className="flex items-center gap-2 px-3">
              <label htmlFor="quote-send-cc" className="w-16 shrink-0 text-sm text-muted-foreground">
                {t('quotes.actions.sendConfirm.ccLabel')}
              </label>
              <input
                id="quote-send-cc"
                type="text"
                value={sendCc}
                onChange={(e) => setSendCc(e.target.value)}
                disabled={sending}
                aria-invalid={ccError != null}
                data-testid="quote-send-cc"
                className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm focus:outline-hidden disabled:opacity-60"
              />
            </div>
          )}
          <div className="flex items-center gap-2 px-3">
            <label htmlFor="quote-send-subject" className="w-16 shrink-0 text-sm text-muted-foreground">
              {t('quotes.actions.sendConfirm.subjectLabel')}
            </label>
            <input
              id="quote-send-subject"
              type="text"
              value={sendSubject}
              maxLength={200}
              onChange={(e) => setSendSubject(e.target.value)}
              disabled={sending}
              // The placeholder mirrors the server default so leaving the field
              // blank is a visible, deliberate choice — not a missing subject.
              placeholder={
                quote.quoteNumber
                  ? t('quotes.actions.sendConfirm.subjectPlaceholder', { number: quote.quoteNumber })
                  : t('quotes.actions.sendConfirm.subjectPlaceholderNoNumber')
              }
              data-testid="quote-send-subject"
              className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm focus:outline-hidden disabled:opacity-60"
            />
          </div>
        </div>
        {toError && (
          <p className="mt-1 text-xs text-destructive" data-testid="quote-send-to-error">{toError}</p>
        )}
        {ccError && (
          <p className="mt-1 text-xs text-destructive" data-testid="quote-send-cc-error">{ccError}</p>
        )}

        <label className="mt-4 block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            {t('quotes.actions.sendConfirm.messageLabel')}
          </span>
          <textarea
            value={sendMessage}
            onChange={(e) => setSendMessage(e.target.value)}
            rows={3}
            maxLength={2000}
            disabled={sending}
            placeholder={t('quotes.actions.sendConfirm.messagePlaceholder')}
            data-testid="quote-send-message"
            className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
        </label>
        {signature && (
          <div className="mt-2 rounded-md bg-muted/50 px-3 py-2" data-testid="quote-send-signature-preview">
            <p className="text-xs font-medium text-muted-foreground">
              {t('quotes.actions.sendConfirm.signaturePreviewLabel')}
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
            data-testid="quote-send-include-pdf"
          />
          {t('quotes.actions.sendConfirm.includePdfLabel')}
        </label>

        {/* Payment visibility: a deposit the customer can't pay online is a loud
            warning; no-deposit-no-Stripe is only a muted heads-up. A null status
            (still loading / org scope / fetch failed) shows neither. */}
        {hasDeposit && stripeStatus === 'disconnected' && (
          <div
            className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
            data-testid="quote-send-payment-warning"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('quotes.actions.sendConfirm.paymentWarningDeposit')}</span>
          </div>
        )}
        {!hasDeposit && stripeStatus === 'disconnected' && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="quote-send-payment-note">
            {t('quotes.actions.sendConfirm.paymentNoteNoStripe')}
          </p>
        )}
        {stripeStatus === 'connected' && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="quote-send-payment-enabled">
            {t('quotes.actions.sendConfirm.paymentEnabled')}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={closeSend}
            disabled={sending}
            className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !composerValid}
            data-testid="quote-send-confirm"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {sending ? t('quotes.actions.sending') : t('quotes.actions.sendProposal')}
          </button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        onConfirm={() => void remove()}
        isLoading={deleting}
        title={t('quotes.actions.deleteConfirm.title')}
        message={t('quotes.actions.deleteConfirm.message')}
        confirmLabel={t('quotes.actions.deleteDraft')}
        confirmTestId="quote-delete-confirm"
      />
      {/* Clone dialog: pick the company the new draft is for (defaults to the
          source quote's company) and a title (defaults to "Clone of …"). */}
      <Dialog
        open={cloneOpen}
        onClose={() => { if (!cloning) setCloneOpen(false); }}
        title={t('quotes.actions.cloneDialog.title')}
        labelledBy="quote-clone-dialog-title"
        maxWidth="md"
        className="p-6"
      >
        <h3 id="quote-clone-dialog-title" className="text-base font-semibold text-foreground">
          {t('quotes.actions.cloneDialog.title')}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('quotes.actions.cloneDialog.message')}</p>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">
              {t('quotes.actions.cloneDialog.companyLabel')}
            </span>
            <select
              value={cloneOrgId}
              onChange={(e) => setCloneOrgId(e.target.value)}
              disabled={cloning}
              data-testid="quote-clone-org"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
            >
              {orgOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </label>
          {cloneOrgId !== quote.orgId && (
            <p className="text-xs text-muted-foreground" data-testid="quote-clone-retarget-hint">
              {t('quotes.actions.cloneDialog.retargetHint')}
            </p>
          )}
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-foreground">
              {t('quotes.actions.cloneDialog.titleLabel')}
            </span>
            <input
              type="text"
              value={cloneTitle}
              maxLength={200}
              onChange={(e) => setCloneTitle(e.target.value)}
              disabled={cloning}
              placeholder={t('quotes.editor.title.placeholder')}
              data-testid="quote-clone-title"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
            />
          </label>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setCloneOpen(false)}
            disabled={cloning}
            className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void clone()}
            disabled={cloning || savePending}
            data-testid="quote-clone-confirm"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {cloning ? t('quotes.actions.cloning') : t('quotes.actions.cloneDialog.confirm')}
          </button>
        </div>
      </Dialog>
    </>
  );
}
