import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, MoreHorizontal } from 'lucide-react';
import '../../../lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../../lib/runAction';
import { useMenuKeyboard } from '../shared/menuKeyboard';
import { scheduleQuoteSend, cancelScheduledSend } from '../../../lib/api/quotes';
import { showToast } from '../../shared/Toast';
import { usePermissions } from '../../../lib/permissions';
import { useOrgStore } from '../../../stores/orgStore';
import { fetchWithAuth } from '../../../stores/auth';
import { getJwtClaims } from '../../../lib/authScope';
import { isValidEmail } from '@/lib/email';
import { cloneQuote, deleteQuote, sendQuote, type SendQuoteOptions, type QuoteSendEmailReason } from '../../../lib/api/quotes';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { Dialog } from '../../shared/Dialog';
import { computeQuoteProfit, type QuoteProfit } from '@breeze/shared';
import { useQuotePdfDownload } from './useQuoteImage';
import { type Quote, type QuoteDetail as QuoteDetailData, formatMoney } from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

type TFunction = ReturnType<typeof useTranslation>['t'];

/** The honest "marked Sent but no email was delivered" copy for a persisted
 *  email-failure reason. Shared by the post-flip toast below and the
 *  persistent banner — unknown codes fall back to the generic send-failed
 *  copy so a new server-side reason never renders blank. */
function sendEmailWarningMessage(t: TFunction, reason: QuoteSendEmailReason | string, orgName: string): string {
  const warnByReason: Record<QuoteSendEmailReason, string> = {
    no_billing_contact: t('quotes.actions.sendEmailWarning.noBillingContact', { orgName }),
    no_email_service: t('quotes.actions.sendEmailWarning.noEmailService'),
    pdf_render_failed: t('quotes.actions.sendEmailWarning.pdfRenderFailed'),
    send_failed: t('quotes.actions.sendEmailWarning.sendFailed'),
    // Draft-only code; unreachable on a sent quote, mapped for exhaustiveness.
    schedule_failed: t('quotes.actions.sendEmailWarning.sendFailed'),
  };
  return warnByReason[reason as QuoteSendEmailReason] ?? warnByReason.send_failed;
}

/** Persistent send-outcome banners. The toast-only surfacing race-depends on
 *  the user watching the draft→sent flip live; these render from persisted
 *  state so the outcome survives a reload or a return visit:
 *  - DRAFT with a failure marker (and no live schedule): the scheduled send
 *    was rejected at fire time — the proposal was never sent.
 *  - SENT with a failure marker: the send committed but no email went out.
 *    Once the customer has viewed/accepted, the banner retires — they
 *    evidently received it.
 *  Rendered by QuoteDetail (detail tab) AND QuoteWorkspace (other tabs) —
 *  drafts open on the Editor tab, so a detail-only banner would be invisible
 *  on the default path for exactly the state it exists to surface. */
export function QuoteSendOutcomeBanners({ quote, orgName }: { quote: Quote; orgName: string }) {
  const { t } = useTranslation('billing');
  const reason = quote.sendEmailReason;
  if (!reason) return null;
  // Draft guard: a live (future) schedule means the user already retried; the
  // server clears the marker on re-schedule, so this is belt-and-braces
  // against a stale detail payload.
  const scheduleLive =
    quote.sendScheduledAt != null && new Date(quote.sendScheduledAt).getTime() > Date.now();
  const banner =
    quote.status === 'draft' && !scheduleLive
      ? {
          testId: 'quote-schedule-send-failed-banner',
          tone: 'border-destructive/40 bg-destructive/10 text-destructive',
          message: t('quotes.detail.scheduledSendFailed'),
        }
      : quote.status === 'sent'
        ? {
            testId: 'quote-email-not-delivered-banner',
            tone: 'border-warning/40 bg-warning/10 text-warning-foreground dark:text-warning',
            message: sendEmailWarningMessage(t, reason, orgName),
          }
        : null;
  if (!banner) return null;
  return (
    <div
      role="alert"
      data-testid={banner.testId}
      className={`flex items-start gap-2 rounded-md border p-3 text-sm ${banner.tone}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{banner.message}</span>
    </div>
  );
}

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
  const { quote, lines } = detail;
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
  // A Send click that lands while edits are settling queues the composer to
  // open on quiescence (see the header Send onClick).
  const [openWhenQuiet, setOpenWhenQuiet] = useState(false);

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

  // A quote with no customer-visible LINE ITEMS can't be sent. Gating on
  // blocks was defeatable: one empty pricing table (or a lone heading block)
  // armed Send on a $0.00, item-less quote — the exact embarrassment the
  // empty-hint exists to prevent, on the highest-stakes action.
  const isEmpty = !lines.some((l) => l.customerVisible);
  // A sendable-but-$0 quote (e.g. every line priced at zero) is almost always
  // a mistake — the composer shows an explicit warning rather than blocking.
  const zeroTotal = !isEmpty && Number(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal) === 0 && Number(quote.total) === 0;
  const isDraft = quote.status === 'draft';
  // Deposit configured → the composer must warn when Stripe isn't connected,
  // since the customer would have no way to actually pay that deposit online.
  const hasDeposit = Boolean(quote.depositType && quote.depositType !== 'none');

  // Soft send-time warning (Task 3 UX pass): an incomplete profit estimate
  // shouldn't block Send — a tech may not know every cost yet — but it should
  // be visible at the one moment before the quote goes irreversible. Gated on
  // margin visibility, same as MarginPanel: an org-scoped/read-only-cost user
  // must never see this notice imply a permission they don't have.
  const canSeeMargin = can('quotes', 'read');
  const profit = useMemo<QuoteProfit>(
    () => computeQuoteProfit(lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxable: l.taxable,
      customerVisible: l.customerVisible,
      recurrence: l.recurrence,
      unitCost: l.unitCost,
    }))),
    [lines],
  );

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

  useEffect(() => {
    if (!openWhenQuiet || savePending) return;
    setOpenWhenQuiet(false);
    openSend();
  }, [openWhenQuiet, savePending, openSend]);

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

  // Set when a Send click finds no valid recipients — renders the inline
  // reason under the To field (the same visible-reason pattern the header
  // button uses) instead of a silently dead disabled button.
  const [toMissing, setToMissing] = useState(false);
  const toInputRef = useRef<HTMLInputElement>(null);

  const send = useCallback(async () => {
    if (sending) return;
    // The prerequisite IS the click's job: no valid recipients → focus the To
    // field and say why, rather than sitting disabled with no explanation.
    if (!composerValid) {
      setToMissing(toParsed.emails.length === 0 && !toError);
      toInputRef.current?.focus();
      return;
    }
    setToMissing(false);
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
      // Undo-send window: the composer confirm SCHEDULES the dispatch ~30s out
      // rather than emailing immediately — the quote stays a draft with the
      // window stamped, and the header offers Undo until it fires. The real
      // send (and its emailed:false honesty path) runs in the worker.
      await runAction<{ data?: { sendScheduledAt?: string } }>({
        request: () => scheduleQuoteSend(quote.id, opts),
        errorFallback: t('quotes.actions.sendError'),
        onUnauthorized: UNAUTHORIZED,
      });
      setSendOpen(false);
      setSendMessage('');
      refresh();
      showToast({ message: t('quotes.actions.sendScheduled', { orgName }), type: 'success' });
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
  // ---- undo-send window state ---------------------------------------------
  // A future sendScheduledAt on a draft = a live undo window. The countdown is
  // client-side; at zero we poll the detail until the worker's status flip
  // (draft→sent) lands. A PAST sendScheduledAt on a still-draft quote means
  // the job was lost or rejected at fire time — treated as "not scheduled",
  // which quietly restores the normal Send button.
  const scheduledAtMs = quote.sendScheduledAt ? new Date(quote.sendScheduledAt).getTime() : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scheduleLive = isDraft && scheduledAtMs != null && scheduledAtMs > nowMs;
  useEffect(() => {
    if (!isDraft || scheduledAtMs == null) return;
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [isDraft, scheduledAtMs]);
  // At window end, re-pull every 2.5s until the flip lands. BullMQ promotes
  // delayed jobs on a ~5s scan, so the flip routinely lands 5-10s AFTER the
  // nominal fire time — a short fixed retry burst misses it (verified live).
  // The effect is keyed on the stable boolean (not nowMs/refresh) so the 1s
  // ticker and detail reloads can't cancel the interval mid-poll; the flip
  // turns windowElapsed false, which is what cleans it up. Bounded at 12
  // polls (~30s) in case the job was lost and no flip ever comes.
  const windowElapsed = isDraft && scheduledAtMs != null && scheduledAtMs <= nowMs;
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  const firedRef = useRef(false);
  useEffect(() => {
    if (!windowElapsed) { firedRef.current = false; return; }
    if (firedRef.current) return;
    firedRef.current = true;
    refreshRef.current();
    let polls = 0;
    const iv = setInterval(() => {
      if (++polls > 12) { clearInterval(iv); return; }
      refreshRef.current();
    }, 2500);
    return () => clearInterval(iv);
  }, [windowElapsed]);
  // Post-flip honesty: the worker persisted the email outcome; when the
  // countdown's reload lands the draft→sent flip, surface the same honest
  // success/warning the synchronous send used to toast directly.
  const prevStatusRef = useRef(quote.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = quote.status;
    if (prev !== 'draft' || quote.status !== 'sent') return;
    const reason = quote.sendEmailReason;
    if (reason) {
      showToast({ message: sendEmailWarningMessage(t, reason, orgName), type: 'warning' });
    } else {
      showToast({ message: t('quotes.actions.sendSuccess', { orgName }), type: 'success' });
    }
  }, [quote.status, quote.sendEmailReason, orgName, t]);

  const [undoing, setUndoing] = useState(false);
  const undoSend = useCallback(async () => {
    if (undoing) return;
    setUndoing(true);
    try {
      const result = await runAction<{ data?: { canceled?: boolean } }>({
        request: () => cancelScheduledSend(quote.id),
        errorFallback: t('quotes.actions.undoError'),
        onUnauthorized: UNAUTHORIZED,
      });
      showToast(result?.data?.canceled
        ? { message: t('quotes.actions.undoSuccess'), type: 'success' }
        : { message: t('quotes.actions.undoTooLate'), type: 'warning' });
      refresh();
    } catch (err) {
      handleActionError(err, t('quotes.actions.undoError'));
    } finally {
      setUndoing(false);
    }
  }, [undoing, quote.id, refresh, t]);

  // justify-end matters: the full-basis reason hints stretch this container
  // to full width, and without it the buttons drift LEFT whenever a hint shows.
  const layout = header ? 'flex flex-wrap items-center justify-end gap-2' : 'space-y-2';
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
        {/* Send a draft proposal: emails the customer's billing contact with
            the PDF + a public accept link, and flips draft→sent. (The quote
            number already exists — it's minted at creation, by contract.)
            Gated on quotes:send; only a draft can be sent. An empty quote can't. */}
        {canSend && scheduleLive && (
          <>
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm font-medium text-warning-foreground dark:text-warning"
              data-testid="quote-send-countdown"
              role="status"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('quotes.actions.sendingIn', { seconds: Math.max(0, Math.ceil(((scheduledAtMs ?? 0) - nowMs) / 1000)) })}
            </span>
            <button
              type="button"
              onClick={() => void undoSend()}
              disabled={undoing}
              data-testid="quote-send-undo"
              className={`${btnBase} border font-medium hover:bg-muted disabled:opacity-50`}
            >
              {t('quotes.actions.undoSend')}
            </button>
          </>
        )}
        {canSend && !scheduleLive && (
          <button
            type="button"
            onClick={() => {
              // During savePending the click's job is the prerequisite: the
              // click itself blurs the dirty field (starting its save); queue
              // the composer to open the moment the editor goes quiescent —
              // one click to the money moment, never a dead one.
              if (savePending) { setOpenWhenQuiet(true); return; }
              openSend();
            }}
            disabled={sending || isEmpty}
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
            className={`${btnBase} relative bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50`}
          >
            {/* Overlay spinner: while edits settle (or a send is in flight) the
                label fades under a dead-centered spinner. The label always
                defines the button's size and sits truly centered — the earlier
                reserved-slot approach kept the width stable but left the text
                permanently off-center. */}
            {(sending || savePending) && (
              <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin" aria-hidden="true" />
            )}
            <span className={sending || savePending ? 'opacity-30' : ''}>
              {t('quotes.actions.sendProposal')}
            </span>
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
        {zeroTotal && (
          <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning-foreground dark:text-warning" data-testid="quote-send-zero-warning">
            {t('quotes.actions.sendConfirm.zeroTotalWarning')}
          </p>
        )}
        {/* Non-blocking: an incomplete profit estimate never disables Send (a
            tech may genuinely not know every cost yet) — it's a heads-up, not a
            gate. Reuses MarginPanel's own copy (billingUi.margin.missingCost) so
            the wording can't drift between the rail and this dialog. */}
        {canSeeMargin && profit.linesMissingCost > 0 && (
          <p className="mt-2 flex items-start gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning-foreground dark:text-warning" data-testid="quote-send-missing-cost-notice">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            <span>{t('billingUi.margin.missingCost', { count: profit.linesMissingCost })}</span>
          </p>
        )}

        {/* Envelope fields: label-left rows in one bordered box, like a mail client. */}
        <div className="mt-4 divide-y rounded-md border">
          <div className="flex items-center gap-2 px-3">
            <label htmlFor="quote-send-to" className="w-16 shrink-0 text-sm text-muted-foreground">
              {t('quotes.actions.sendConfirm.toLabel')}
            </label>
            <input
              ref={toInputRef}
              id="quote-send-to"
              type="text"
              value={sendTo}
              onChange={(e) => { setSendTo(e.target.value); setToMissing(false); }}
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
          <p id="quote-send-to-error" className="mt-1 text-xs text-destructive" data-testid="quote-send-to-error">{toError}</p>
        )}
        {toMissing && !toError && (
          <p id="quote-send-to-missing" className="mt-1 text-xs text-destructive" data-testid="quote-send-to-missing">
            {t('quotes.actions.sendConfirm.recipientRequired')}
          </p>
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
            className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground dark:text-warning"
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
            disabled={sending}
            aria-describedby={toMissing ? 'quote-send-to-missing' : toError ? 'quote-send-to-error' : undefined}
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
