import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { usePdfDownload } from './shared/usePdfDownload';
import InvoiceSendComposer, { type ComposedInvoiceEmail } from './InvoiceSendComposer';
import { type InvoiceDetail as InvoiceDetailData, formatMoney } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

/** An Issue click parked until the editor goes quiet. `atFailureNonce` is the
 *  failure count observed at click time; any change to it means a save failed
 *  while we were waiting, so the queue cancels instead of firing. Holding it in
 *  the queue makes that a data comparison rather than a dependency on the order
 *  two effects observe two props. */
type QueuedIssue = { kind: 'issue' | 'issueSend'; atFailureNonce: number };

interface Props {
  detail: InvoiceDetailData;
  onChanged?: () => void;
  /**
   * 'rail' — the stacked, full-width treatment inside the Detail summary column.
   * 'header' — the compact, inline treatment in the workspace header so the
   * primary money-actions (Issue / Issue & Send) are reachable from any tab, not
   * buried inside the Editor tab. The two never render at once: the workspace
   * passes `actionsInHeader` to InvoiceDetail, which suppresses its rail copy
   * when the header owns the actions (mirrors QuoteActions).
   */
  variant: 'rail' | 'header';
  /** True while the editor has work genuinely IN FLIGHT — an open mutation or a
   *  deferred line deletion awaiting its undo window. Issue must not race it: it
   *  would snapshot and number an invoice that's missing the user's just-typed
   *  edit. This state resolves on its own, so a click queues and waits. */
  savePending?: boolean;
  /** Translated label of a field holding an edit that is dirty with NOTHING in
   *  flight — its save failed, or never fired. Waiting cannot clear this, so
   *  Issue refuses and names the field rather than queueing behind a save that
   *  is never coming. Null when everything is clean or genuinely saving. */
  unsavedFieldLabel?: string | null;
  /** Bumped by the workspace on every editor save FAILURE. A failure can still
   *  produce "quiescence" (restored rows / cleared in-flight keys), so a
   *  queued Issue must cancel on this signal rather than fire. */
  saveFailureNonce?: number;
  /** Called when Issue is clicked while savePending — lets the workspace flush
   *  the editor's deferred deletions (undo grace window) immediately, so the
   *  held Issue fires as soon as the DELETE lands (mirrors onSendWhilePending). */
  onIssueWhilePending?: () => void;
}

/**
 * The invoice's primary actions — Issue, Issue & Send (the irreversible
 * money-moment), Download PDF, Delete draft — with their confirm dialogs.
 * Single source (the QuoteActions pattern) so the Detail rail and the workspace
 * header can't drift in behavior or copy; the data-testids are stable across
 * both variants. Void stays in InvoiceDetail: its written-reason dialog shares
 * the detail view's busy state with the payment mutations and belongs with the
 * issued-lifecycle rail, not the header.
 */
export default function InvoiceActions({ detail, onChanged, variant, savePending = false, unsavedFieldLabel = null, saveFailureNonce = 0, onIssueWhilePending }: Props) {
  const { t } = useTranslation('billing');
  const { can } = usePermissions();
  const { invoice, lines } = detail;
  const currency = invoice.currencyCode;

  const { download: downloadPdf, downloading } = usePdfDownload({
    path: `/invoices/${invoice.id}/pdf`,
    filename: `${invoice.invoiceNumber ?? `invoice-${invoice.id}`}.pdf`,
    errorMessage: t('invoiceActions.downloadPdfError'),
  });

  // Distinct in-flight flag so the Issue buttons can show an unambiguous
  // "Issuing…" label. Without it the disabled-but-still-"Issue" button + a
  // still-"Draft" header during the POST reads as "done but stuck" (#1418).
  const [issuing, setIssuing] = useState(false);
  // Issue-and-send emails the customer and can't be undone, so it goes through a
  // confirm step (plain Issue stays direct — it's reversible via Void).
  const [issueSendOpen, setIssueSendOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // During savePending an Issue click's job is the prerequisite: the click
  // itself blurs the dirty field (starting its save), so the action is queued
  // to fire the moment the editor goes quiescent — one click to the money
  // moment, never a dead one (the quote editor's Send contract).
  //
  // The queue CAPTURES the failure nonce it was created at. "Has a save failed
  // since I clicked?" is then a question about data this component holds, not
  // about the order in which two effects happen to observe two independently
  // updated props.
  const [queued, setQueued] = useState<QueuedIssue | null>(null);
  // Re-send composer. Distinct from `issuing`: a re-send touches no invoice
  // state, so it never queues behind the editor and never confirms — the
  // composer IS the confirmation.
  const [resendOpen, setResendOpen] = useState(false);
  const [resending, setResending] = useState(false);
  const [copyingLink, setCopyingLink] = useState(false);
  const [partnerDeviceAppendix, setPartnerDeviceAppendix] = useState(false);
  const partnerDeviceAppendixLoaded = useRef(false);
  const refresh = useCallback(() => onChanged?.(), [onChanged]);

  const isDraft = invoice.status === 'draft';
  // An invoice with no customer-visible line can't be issued.
  const hasVisibleLines = lines.some((l) => l.customerVisible);

  // The appendix override is draft-only. Resolve the partner default before
  // opening the composer so a late read can never reset fields the operator has
  // already started editing. A failed support read degrades to the server's
  // false default; the send itself remains fully usable.
  const openIssueSendComposer = useCallback(async () => {
    if (!partnerDeviceAppendixLoaded.current) {
      try {
        const response = await fetchWithAuth('/orgs/partners/me');
        if (response.ok) {
          const partner = (await response.json()) as { invoiceDeviceAppendix?: boolean };
          setPartnerDeviceAppendix(partner.invoiceDeviceAppendix === true);
        }
      } catch { /* keep the safe false default */ }
      partnerDeviceAppendixLoaded.current = true;
    }
    setIssueSendOpen(true);
  }, []);

  const issue = useCallback(async (alsoSend: boolean, opts?: ComposedInvoiceEmail) => {
    if (issuing) return;
    setIssuing(true);
    try {
      if (alsoSend) {
        // /send owns draft issue + email as one lifecycle action. In particular,
        // it persists includeDeviceAppendix while the invoice is still a draft,
        // before issue freezes the PDF evidence choice.
        const result = await runAction<{ data: { emailed: boolean } }>({
          request: () => fetchWithAuth(`/invoices/${invoice.id}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts ?? {}),
          }),
          errorFallback: t('invoiceActions.issueSendError'),
          onUnauthorized: UNAUTHORIZED,
        });
        if (result?.data?.emailed) {
          showToast({ type: 'success', message: t('invoiceActions.issueSentSuccess') });
        } else {
          showToast({ type: 'warning', message: t('invoiceActions.issueNoEmailWarning') });
        }
      } else {
        await runAction({
          request: () => fetchWithAuth(`/invoices/${invoice.id}/issue`, { method: 'POST' }),
          errorFallback: t('invoiceActions.issueError'),
          successMessage: t('invoiceActions.issueSuccess'),
          onUnauthorized: UNAUTHORIZED,
        });
      }
    } catch (err) {
      handleActionError(err, t('invoiceActions.issueError'));
    } finally {
      // Always refresh: if issue succeeded but send threw, we still need to leave
      // the draft editor so a second click doesn't re-issue and hit 409 NOT_A_DRAFT.
      refresh();
      setIssuing(false);
      setIssueSendOpen(false);
    }
  }, [issuing, invoice.id, refresh, t]);

  // Refuse a click (or a queued click reaching quiescence) that can only ever
  // wait on a save that isn't coming — name the field instead. Hoisted above
  // the queue effect so both the immediate-click refusal and the queue's
  // re-check share one toast/message.
  const refuseForUnsaved = useCallback(() => {
    showToast({ type: 'warning', message: t('invoiceActions.issueBlockedUnsaved', { field: unsavedFieldLabel }) });
  }, [unsavedFieldLabel, t]);

  // One effect resolves the queue, in strict priority: failed → cancel;
  // still working → keep waiting; preconditions lapsed → refuse; otherwise fire.
  //
  // Cancelling on a CHANGED nonce (rather than on a separately-ordered effect)
  // is what makes this safe. A failed delete-flush restores its rows and a
  // failed line blur-save clears its in-flight key, so both read as "quiet" —
  // firing then would issue an invoice contradicting what the user last saw.
  // The previous shape split this across two effects and relied on `savePending`
  // arriving one commit after the nonce (the editor reports it through an
  // effect). That happened to hold, but nothing stated it: deriving the pending
  // signal synchronously would have silently armed a same-commit race on an
  // irreversible money action.
  useEffect(() => {
    if (!queued) return;
    if (saveFailureNonce !== queued.atFailureNonce) {
      setQueued(null);
      showToast({ type: 'error', message: t('invoiceActions.issueCanceledSaveFailed') });
      return;
    }
    if (savePending) return;
    setQueued(null);
    // The unsaved-field refusal is re-checked here too: the click gate tests
    // savePending FIRST, so a click during a deferred delete queues even while
    // an earlier failed save (nonce already captured at click time — no new
    // bump is coming) keeps a field dirty. Quiescence cannot clear that field,
    // so firing would issue the invoice at the pre-edit money. Refuse and name
    // the field, exactly as an immediate click would have.
    if (unsavedFieldLabel) {
      refuseForUnsaved();
      return;
    }
    // The button's own gate is re-checked here: the queue can outlive it. The
    // last customer-visible line may have been sitting in its undo window, and
    // the flush this very click triggered is what deleted it for good.
    if (!hasVisibleLines) {
      showToast({ type: 'warning', message: t('invoiceActions.noVisibleLineHint') });
      return;
    }
    // Plain Issue runs directly (it's reversible via Void); Issue & Send opens
    // its confirm dialog — the user still confirms the email before it sends.
    if (queued.kind === 'issue') void issue(false);
    else void openIssueSendComposer();
  }, [queued, saveFailureNonce, savePending, unsavedFieldLabel, refuseForUnsaved, hasVisibleLines, issue, openIssueSendComposer, t]);

  // Slow-save backstop: with failures handled above, the only way a queue waits
  // this long is a save that is genuinely still in flight (or a pending-state
  // bug). Drop the queued action after a bounded wait with an honest "still
  // saving" explanation — never claim a failure we didn't see. Cleared
  // automatically when the effect above fires or cancels the queue.
  useEffect(() => {
    if (!queued) return;
    const timer = setTimeout(() => {
      setQueued(null);
      showToast({ type: 'warning', message: t('invoiceActions.issueCanceledStillSaving') });
    }, 15_000);
    return () => clearTimeout(timer);
  }, [queued, t]);

  // Whether this invoice has ever been emailed. `issueInvoice` deliberately
  // leaves sent_at null (a plain Issue reads "Issued", not "Sent"), so the first
  // email after a bare Issue is a genuine SEND — /send stamps sent_at and emits
  // the invoice.sent lifecycle event. Every email after that is a RE-send, and
  // /resend deliberately writes nothing: sent_at, the number and the issue-time
  // snapshots stay pinned so our record and the customer's copy keep describing
  // the same document.
  const neverEmailed = invoice.sentAt == null;
  // A part-paid invoice reads as "Request payment", not "Re-send" — the tech is
  // chasing a balance, not resupplying a copy. Label only; the endpoint is
  // decided by neverEmailed above.
  const partiallyPaid = Number(invoice.amountPaid) > 0 && Number(invoice.balance) > 0;
  const resendLabel = partiallyPaid
    ? t('invoiceDetail.requestPayment.requestPayment')
    : neverEmailed
      ? t('invoiceDetail.requestPayment.sendInvoice')
      : t('invoiceActions.resend');

  // Shared by both composer intros. Spelled out per-key at the call sites (not
  // via a computed key) so the key-usage scanner can still resolve them.
  const composerIntroValues = {
    customer: invoice.billToName ?? t('invoiceActions.issueSendConfirm.customerFallback'),
    amount: formatMoney(invoice.total, currency),
  };

  const resend = useCallback(async (opts: ComposedInvoiceEmail) => {
    if (resending) return;
    setResending(true);
    try {
      // Suppress runAction's success toast: a 200 does NOT mean an email went
      // out. Both routes swallow delivery failures into `reason`, so the
      // outcome is post-processed below — `emailed !== true` (not `=== false`)
      // so an unexpected response shape can't be read as success.
      const result = await runAction<{ data?: { emailed?: boolean } }>({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/${neverEmailed ? 'send' : 'resend'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts),
        }),
        errorFallback: t('invoiceDetail.requestPayment.sendError'),
        onUnauthorized: UNAUTHORIZED,
      });
      setResendOpen(false);
      // A first send stamps sent_at (which flips this very button's label), and
      // even a re-send may reveal other stale detail — reconcile either way.
      refresh();
      if (result?.data?.emailed !== true) {
        showToast({ type: 'warning', message: t('invoiceDetail.requestPayment.noEmailWarning') });
      } else {
        showToast({
          type: 'success',
          message: partiallyPaid
            ? t('invoiceDetail.requestPayment.paymentRequestSent')
            : neverEmailed
              ? t('invoiceDetail.requestPayment.invoiceSent')
              : t('invoiceActions.resendSuccess'),
        });
      }
    } catch (err) {
      // Leave the composer open on a failure so the typed recipients and note
      // survive for a retry.
      handleActionError(err, t('invoiceDetail.requestPayment.sendError'));
    } finally {
      setResending(false);
    }
  }, [resending, invoice.id, neverEmailed, partiallyPaid, refresh, t]);

  // Copy the customer-facing DURABLE view-and-pay link without emailing
  // anything — for pasting into a chat/SMS/reply by hand. Mirrors the quote's
  // "Copy share link". The GET mints-or-reproduces, so repeated copies (and the
  // emailed CTA) all hand out the SAME url — unlike the old one-shot Stripe
  // checkout copy, which expired in ~24h and showed no invoice.
  const copyInvoiceLink = useCallback(async () => {
    if (copyingLink) return;
    setCopyingLink(true);
    try {
      const result = await runAction<{ data?: { url?: string } }>({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/public-link`),
        errorFallback: t('invoiceDetail.payments.linkError'),
        onUnauthorized: UNAUTHORIZED,
      });
      const url = result?.data?.url;
      if (!url) {
        // A 200 with no link is a server-side surprise, not something the user
        // can paste — say so rather than silently writing "undefined".
        showToast({ type: 'error', message: t('invoiceDetail.payments.noLinkReturned') });
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Clipboard denied (insecure origin / permissions policy). Surface the
        // URL in a long-lived toast so it can be selected by hand — a silent
        // no-op here reads as a dead button. (A window.prompt would block every
        // subsequent interaction on the page.)
        showToast({
          type: 'warning',
          message: t('invoiceActions.paymentLinkCopyFailed', { url }),
          duration: 15000,
        });
        return;
      }
      showToast({ type: 'success', message: t('invoiceDetail.payments.linkCopied') });
    } catch (err) {
      handleActionError(err, t('invoiceDetail.payments.linkError'));
    } finally {
      setCopyingLink(false);
    }
  }, [copyingLink, invoice.id, t]);

  const remove = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}`, { method: 'DELETE' }),
        errorFallback: t('invoiceActions.deleteError'),
        successMessage: t('invoiceActions.deleteSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      setDelOpen(false);
      void navigateTo('/billing/invoices');
    } catch (err) {
      handleActionError(err, t('invoiceActions.deleteError'));
    } finally {
      setDeleting(false);
    }
  }, [deleting, invoice.id, t]);

  const header = variant === 'header';
  // Rail buttons stretch full-width and stack; header buttons size to content and
  // sit in a row. The class fragments below are the only thing the variant changes.
  const layout = header ? 'flex flex-wrap items-center justify-end gap-2' : 'space-y-2';
  const btnBase = header
    ? 'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium'
    : 'inline-flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium';

  const canIssue = can('invoices', 'send') && isDraft;
  const canDownload = can('invoices', 'export');
  const canDelete = can('invoices', 'write') && isDraft;
  // Re-send is the counterpart of Issue & Send on a live invoice: available
  // once there is an issued document to re-mail, and refused on a void one
  // (never re-mail a demand we already cancelled). Matches the server's own
  // gate in resendInvoiceEmail — a PAID invoice IS re-sendable, because "send
  // me a copy for our records" is the commonest reason a customer asks.
  // A paid-but-never-emailed invoice is excluded: the button would run the
  // FIRST-send path (/send), which the server now refuses on 'paid' — there is
  // no sensible "Send invoice" for a settled document that was never emailed.
  // A paid invoice that WAS emailed keeps Re-send ("copy for our records").
  const canResend = can('invoices', 'send') && !isDraft && invoice.status !== 'void'
    && !(invoice.status === 'paid' && invoice.sentAt == null);
  // The payment link is only meaningful while money is still owed, and only
  // exists when the partner's Stripe is connected. Mirrors the gate the
  // payments card uses for the record-payment form.
  // The durable public view-and-pay link (2026-08-21 spec §9). Unlike the old
  // one-shot Stripe checkout copy this needs no Stripe connection (the page
  // itself degrades to view+PDF) and stays useful on a PAID invoice ("here's
  // your receipt"); only drafts (no link exists) and void are excluded.
  const canCopyInvoiceLink =
    can('invoices', 'send') &&
    !isDraft &&
    invoice.status !== 'void';

  // Nothing to show (e.g. a viewer on an issued invoice) — render no empty container.
  if (!canIssue && !canDownload && !canDelete && !canResend && !canCopyInvoiceLink) return null;

  const issueDisabled = issuing || !hasVisibleLines;
  // Why the money-buttons are held, if they are. 'saving' resolves on its own
  // and a click queues behind it; 'unsaved' never will, so a click refuses and
  // names the field. Order matters: a field mid-save is dirty AND in flight.
  const heldReason: 'saving' | 'unsaved' | null = savePending ? 'saving' : unsavedFieldLabel ? 'unsaved' : null;
  const heldHintId = `invoice-issue-held-hint-${variant}`;

  return (
    <>
      <div className={layout} data-testid={`invoice-actions-${variant}`}>
        {/* Issuing assigns a number and flips draft→sent; Issue & Send also emails
            the customer's billing contact. Gated on invoices:send; drafts only;
            an invoice with no customer-visible line can't be issued. */}
        {canIssue && (
          <>
            <button
              type="button"
              onClick={() => {
                if (savePending) { onIssueWhilePending?.(); setQueued({ kind: 'issue', atFailureNonce: saveFailureNonce }); return; }
                if (unsavedFieldLabel) { refuseForUnsaved(); return; }
                void issue(false);
              }}
              disabled={issueDisabled}
              aria-describedby={
                !hasVisibleLines ? `invoice-no-visible-hint-${variant}`
                  : heldReason ? heldHintId
                  : undefined
              }
              title={
                !hasVisibleLines ? t('invoiceActions.noVisibleLineHint')
                  : heldReason === 'saving' ? t('invoiceActions.savingTitle')
                  : heldReason === 'unsaved' ? t('invoiceActions.unsavedTitle', { field: unsavedFieldLabel })
                  : undefined
              }
              data-testid="invoice-issue"
              className={`${btnBase} relative border hover:bg-muted disabled:opacity-50`}
            >
              {/* Spinner = a promise of forthcoming completion, so it renders
                  only while something WILL complete: an in-flight issue or a
                  queued click awaiting quiescence. Plain savePending (a dirty
                  field, maybe one whose save failed and stays dirty by design)
                  gets the static hint below, never an infinite spinner. */}
              {(issuing || queued !== null) && (
                <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin" aria-hidden="true" />
              )}
              <span className={issuing || queued !== null ? 'opacity-30' : ''}>
                {issuing ? t('invoiceActions.issuing') : t('invoiceActions.issue')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (savePending) { onIssueWhilePending?.(); setQueued({ kind: 'issueSend', atFailureNonce: saveFailureNonce }); return; }
                if (unsavedFieldLabel) { refuseForUnsaved(); return; }
                void openIssueSendComposer();
              }}
              disabled={issueDisabled}
              aria-describedby={
                !hasVisibleLines ? `invoice-no-visible-hint-${variant}`
                  : heldReason ? heldHintId
                  : undefined
              }
              title={
                !hasVisibleLines ? t('invoiceActions.noVisibleLineHint')
                  : heldReason === 'saving' ? t('invoiceActions.savingTitle')
                  : heldReason === 'unsaved' ? t('invoiceActions.unsavedTitle', { field: unsavedFieldLabel })
                  : undefined
              }
              data-testid="invoice-issue-send"
              className={`${btnBase} relative bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50`}
            >
              {/* Overlay spinner while a queued click settles or the issue is in
                  flight; the label always defines the button's size (mirrors the
                  quote Send button). See the spinner note on plain Issue above. */}
              {(issuing || queued !== null) && (
                <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin" aria-hidden="true" />
              )}
              <span className={issuing || queued !== null ? 'opacity-30' : ''}>
                {issuing ? t('invoiceActions.issuing') : t('invoiceActions.issueAndSend')}
              </span>
            </button>
          </>
        )}
        {/* The email action on a live invoice — the slot Issue occupies on a
            draft. Reads "Send invoice" before the first email, "Request payment"
            once the customer has part-paid, and "Re-send" otherwise; it opens
            the same style of composer the quote re-send uses, prefilled from the
            org's billing contact. */}
        {canResend && (
          <button
            type="button"
            onClick={() => setResendOpen(true)}
            disabled={resending}
            data-testid="invoice-resend"
            className={`${btnBase} border hover:bg-muted disabled:opacity-50`}
          >
            {resendLabel}
          </button>
        )}
        {canCopyInvoiceLink && (
          <button
            type="button"
            onClick={() => void copyInvoiceLink()}
            disabled={copyingLink}
            data-testid="invoice-pay-link"
            title={t('invoiceActions.copyInvoiceLinkTitle')}
            className={`${btnBase} border hover:bg-muted disabled:opacity-50`}
          >
            {copyingLink ? t('invoiceActions.copyingPaymentLink') : t('invoiceActions.copyInvoiceLink')}
          </button>
        )}
        {/* PDF download is gated on the dedicated invoices:export permission. */}
        {canDownload && (
          <button
            type="button"
            onClick={() => void downloadPdf()}
            disabled={downloading}
            data-testid="invoice-download-pdf"
            className={`${btnBase} border hover:bg-muted disabled:opacity-50`}
          >
            {downloading ? t('invoiceActions.preparing') : t('invoiceActions.downloadPdf')}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => setDelOpen(true)}
            data-testid="invoice-delete-open"
            className={`${btnBase} border border-destructive/40 text-destructive hover:bg-destructive/10`}
          >
            {t('invoiceActions.deleteDraft')}
          </button>
        )}
        {canIssue && !hasVisibleLines && (
          // Visible in BOTH variants — a sighted keyboard user needs to see WHY the
          // highest-stakes buttons are disabled. Rendered LAST so in the header row
          // it wraps onto its own line BELOW the whole action cluster (never inline
          // between buttons), right-aligned under the right-aligned buttons.
          <p
            id={`invoice-no-visible-hint-${variant}`}
            data-testid="invoice-no-visible-hint"
            className={header ? 'basis-full text-xs text-muted-foreground text-right' : 'text-center text-xs text-muted-foreground'}
          >
            {t('invoiceActions.noVisibleLineHint')}
          </p>
        )}
        {canIssue && hasVisibleLines && heldReason && (
          // Same placement rules as the no-visible-lines hint above: the user must
          // be able to SEE why the money-buttons are held, not just hover for it.
          // The two reasons get different copy and different testids — telling a
          // user "Saving changes…" about a field that already failed to save is
          // advice they can follow forever without getting anywhere.
          <p
            id={heldHintId}
            data-testid={heldReason === 'saving' ? 'invoice-issue-saving-hint' : 'invoice-issue-unsaved-hint'}
            className={header ? 'basis-full text-xs text-muted-foreground text-right' : 'text-center text-xs text-muted-foreground'}
          >
            {heldReason === 'saving'
              ? t('invoiceActions.savingHint')
              : t('invoiceActions.unsavedHint', { field: unsavedFieldLabel })}
          </p>
        )}
      </div>

      <InvoiceSendComposer
        open={isDraft ? issueSendOpen : resendOpen}
        onClose={() => isDraft ? setIssueSendOpen(false) : setResendOpen(false)}
        sending={isDraft ? issuing : resending}
        onSend={(opts) => isDraft ? void issue(true, opts) : void resend(opts)}
        orgId={invoice.orgId}
        invoiceNumber={invoice.invoiceNumber}
        title={isDraft
          ? t('invoiceActions.issueSendConfirm.title')
          : neverEmailed ? t('invoiceActions.sendConfirm.title') : t('invoiceActions.resendConfirm.title')}
        intro={isDraft
          ? t('invoiceActions.issueSendConfirm.message', composerIntroValues)
          : neverEmailed
          ? t('invoiceActions.sendConfirm.message', composerIntroValues)
          : t('invoiceActions.resendConfirm.message', composerIntroValues)}
        confirmLabel={isDraft ? t('invoiceActions.issueAndSend') : resendLabel}
        sendingLabel={isDraft ? t('invoiceActions.issuing') : t('invoiceActions.resending')}
        partnerDeviceAppendix={partnerDeviceAppendix}
        confirmTestId={isDraft ? 'invoice-issue-send-confirm' : 'invoice-send-confirm'}
      />
      <ConfirmDialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        onConfirm={() => void remove()}
        isLoading={deleting}
        title={t('invoiceActions.deleteConfirm.title')}
        message={t('invoiceActions.deleteConfirm.message')}
        confirmLabel={t('invoiceActions.deleteDraft')}
        confirmTestId="invoice-delete-confirm"
      />
    </>
  );
}
