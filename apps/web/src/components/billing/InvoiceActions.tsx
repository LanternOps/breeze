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
import { type InvoiceDetail as InvoiceDetailData, formatMoney } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

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
  /** True while the editor has in-flight saves, dirty blur-to-save fields, or
   *  deferred line deletions awaiting their undo window. Issue must not race a
   *  pending save: it would snapshot and number an invoice that's missing the
   *  user's just-typed edit (mirrors QuoteActions.savePending). */
  savePending?: boolean;
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
export default function InvoiceActions({ detail, onChanged, variant, savePending = false, saveFailureNonce = 0, onIssueWhilePending }: Props) {
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
  const [queuedWhenQuiet, setQueuedWhenQuiet] = useState<null | 'issue' | 'issueSend'>(null);
  const refresh = useCallback(() => onChanged?.(), [onChanged]);

  const isDraft = invoice.status === 'draft';
  // An invoice with no customer-visible line can't be issued.
  const hasVisibleLines = lines.some((l) => l.customerVisible);

  const issue = useCallback(async (alsoSend: boolean) => {
    if (issuing) return;
    setIssuing(true);
    try {
      // Issue first; on success optionally send.
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}/issue`, { method: 'POST' }),
        errorFallback: t('invoiceActions.issueError'),
        successMessage: alsoSend ? undefined : t('invoiceActions.issueSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      if (alsoSend) {
        // /send is honest about whether an email actually went out. The invoice
        // is issued either way; only claim "sent" when an email was dispatched,
        // otherwise warn so the operator knows nothing was emailed. We suppress
        // runAction's own success toast and post-process the result ourselves.
        const result = await runAction<{ data: { emailed: boolean } }>({
          request: () => fetchWithAuth(`/invoices/${invoice.id}/send`, { method: 'POST' }),
          errorFallback: t('invoiceActions.issueSendError'),
          onUnauthorized: UNAUTHORIZED,
        });
        if (result?.data?.emailed) {
          showToast({ type: 'success', message: t('invoiceActions.issueSentSuccess') });
        } else {
          showToast({ type: 'warning', message: t('invoiceActions.issueNoEmailWarning') });
        }
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

  // Cancel a queued Issue the moment a save FAILS. This must run BEFORE the
  // quiescence effect below (effects run in definition order): a failed
  // delete-flush restores its rows and a failed line blur-save clears its
  // in-flight key, both of which read as "quiet" — firing then would issue an
  // invoice that contradicts what the user last saw on screen.
  const seenFailureNonce = useRef(saveFailureNonce);
  useEffect(() => {
    if (saveFailureNonce === seenFailureNonce.current) return;
    seenFailureNonce.current = saveFailureNonce;
    if (!queuedWhenQuiet) return;
    setQueuedWhenQuiet(null);
    showToast({ type: 'error', message: t('invoiceActions.issueCanceledSaveFailed') });
  }, [saveFailureNonce, queuedWhenQuiet, t]);

  // Fire the queued Issue action once the editor reports quiescence. Plain
  // Issue runs directly (it's reversible via Void); Issue & Send opens its
  // confirm dialog — the user still confirms the email before anything sends.
  useEffect(() => {
    if (!queuedWhenQuiet || savePending) return;
    const queued = queuedWhenQuiet;
    setQueuedWhenQuiet(null);
    if (queued === 'issue') void issue(false);
    else setIssueSendOpen(true);
  }, [queuedWhenQuiet, savePending, issue]);

  // Slow-save backstop: with failures handled by the nonce above, the only way
  // a queue waits this long is a save that is genuinely still in flight (or a
  // pending-state bug). Drop the queued action after a bounded wait with an
  // honest "still saving" explanation — never claim a failure we didn't see.
  // Cleared automatically when quiescence fires the queue.
  useEffect(() => {
    if (!queuedWhenQuiet) return;
    const timer = setTimeout(() => {
      setQueuedWhenQuiet(null);
      showToast({ type: 'warning', message: t('invoiceActions.issueCanceledStillSaving') });
    }, 15_000);
    return () => clearTimeout(timer);
  }, [queuedWhenQuiet, t]);

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

  // Nothing to show (e.g. a viewer on an issued invoice) — render no empty container.
  if (!canIssue && !canDownload && !canDelete) return null;

  const issueDisabled = issuing || !hasVisibleLines;

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
                if (savePending) { onIssueWhilePending?.(); setQueuedWhenQuiet('issue'); return; }
                void issue(false);
              }}
              disabled={issueDisabled}
              aria-describedby={
                !hasVisibleLines ? `invoice-no-visible-hint-${variant}`
                  : savePending ? `invoice-issue-saving-hint-${variant}`
                  : undefined
              }
              title={
                !hasVisibleLines ? t('invoiceActions.noVisibleLineHint')
                  : savePending ? t('invoiceActions.savingTitle')
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
              {(issuing || queuedWhenQuiet !== null) && (
                <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin" aria-hidden="true" />
              )}
              <span className={issuing || queuedWhenQuiet !== null ? 'opacity-30' : ''}>
                {issuing ? t('invoiceActions.issuing') : t('invoiceActions.issue')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (savePending) { onIssueWhilePending?.(); setQueuedWhenQuiet('issueSend'); return; }
                setIssueSendOpen(true);
              }}
              disabled={issueDisabled}
              aria-describedby={
                !hasVisibleLines ? `invoice-no-visible-hint-${variant}`
                  : savePending ? `invoice-issue-saving-hint-${variant}`
                  : undefined
              }
              title={
                !hasVisibleLines ? t('invoiceActions.noVisibleLineHint')
                  : savePending ? t('invoiceActions.savingTitle')
                  : undefined
              }
              data-testid="invoice-issue-send"
              className={`${btnBase} relative bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50`}
            >
              {/* Overlay spinner while a queued click settles or the issue is in
                  flight; the label always defines the button's size (mirrors the
                  quote Send button). See the spinner note on plain Issue above. */}
              {(issuing || queuedWhenQuiet !== null) && (
                <Loader2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-spin" aria-hidden="true" />
              )}
              <span className={issuing || queuedWhenQuiet !== null ? 'opacity-30' : ''}>
                {issuing ? t('invoiceActions.issuing') : t('invoiceActions.issueAndSend')}
              </span>
            </button>
          </>
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
        {canIssue && hasVisibleLines && savePending && (
          // Same placement rules as the no-visible-lines hint above: the user must
          // be able to SEE why the money-buttons are held, not just hover for it.
          <p
            id={`invoice-issue-saving-hint-${variant}`}
            data-testid="invoice-issue-saving-hint"
            className={header ? 'basis-full text-xs text-muted-foreground text-right' : 'text-center text-xs text-muted-foreground'}
          >
            {t('invoiceActions.savingHint')}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={issueSendOpen}
        onClose={() => setIssueSendOpen(false)}
        onConfirm={() => void issue(true)}
        isLoading={issuing}
        variant="warning"
        title={t('invoiceActions.issueSendConfirm.title')}
        message={t('invoiceActions.issueSendConfirm.message', {
          customer: invoice.billToName ?? t('invoiceActions.issueSendConfirm.customerFallback'),
          amount: formatMoney(invoice.total, currency),
        })}
        confirmLabel={t('invoiceActions.issueAndSend')}
        confirmTestId="invoice-issue-send-confirm"
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
