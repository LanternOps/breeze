import { useCallback, useState } from 'react';
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
export default function InvoiceActions({ detail, onChanged, variant }: Props) {
  const { can } = usePermissions();
  const { invoice, lines } = detail;
  const currency = invoice.currencyCode;

  const { download: downloadPdf, downloading } = usePdfDownload({
    path: `/invoices/${invoice.id}/pdf`,
    filename: `${invoice.invoiceNumber ?? `invoice-${invoice.id}`}.pdf`,
    errorMessage: 'Could not download the invoice PDF.',
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
        errorFallback: 'Could not issue invoice.',
        successMessage: alsoSend ? undefined : 'Invoice issued',
        onUnauthorized: UNAUTHORIZED,
      });
      if (alsoSend) {
        // /send is honest about whether an email actually went out. The invoice
        // is issued either way; only claim "sent" when an email was dispatched,
        // otherwise warn so the operator knows nothing was emailed. We suppress
        // runAction's own success toast and post-process the result ourselves.
        const result = await runAction<{ data: { emailed: boolean } }>({
          request: () => fetchWithAuth(`/invoices/${invoice.id}/send`, { method: 'POST' }),
          errorFallback: 'Invoice issued, but sending failed.',
          onUnauthorized: UNAUTHORIZED,
        });
        if (result?.data?.emailed) {
          showToast({ type: 'success', message: 'Invoice issued and sent' });
        } else {
          showToast({ type: 'warning', message: 'Invoice issued — but no email was sent (no billing contact / email not configured)' });
        }
      }
    } catch (err) {
      handleActionError(err, 'Could not issue invoice.');
    } finally {
      // Always refresh: if issue succeeded but send threw, we still need to leave
      // the draft editor so a second click doesn't re-issue and hit 409 NOT_A_DRAFT.
      refresh();
      setIssuing(false);
      setIssueSendOpen(false);
    }
  }, [issuing, invoice.id, refresh]);

  const remove = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/invoices/${invoice.id}`, { method: 'DELETE' }),
        errorFallback: 'Could not delete the draft.',
        successMessage: 'Draft deleted',
        onUnauthorized: UNAUTHORIZED,
      });
      setDelOpen(false);
      void navigateTo('/billing/invoices');
    } catch (err) {
      handleActionError(err, 'Could not delete the draft.');
    } finally {
      setDeleting(false);
    }
  }, [deleting, invoice.id]);

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
              onClick={() => void issue(false)}
              disabled={issueDisabled}
              aria-describedby={!hasVisibleLines ? `invoice-no-visible-hint-${variant}` : undefined}
              title={!hasVisibleLines ? 'Add at least one customer-visible line to issue.' : undefined}
              data-testid="invoice-issue"
              className={`${btnBase} border hover:bg-muted disabled:opacity-50`}
            >
              {issuing ? 'Issuing…' : 'Issue'}
            </button>
            <button
              type="button"
              onClick={() => setIssueSendOpen(true)}
              disabled={issueDisabled}
              aria-describedby={!hasVisibleLines ? `invoice-no-visible-hint-${variant}` : undefined}
              title={!hasVisibleLines ? 'Add at least one customer-visible line to issue.' : undefined}
              data-testid="invoice-issue-send"
              className={`${btnBase} bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50`}
            >
              {issuing ? 'Issuing…' : 'Issue & Send'}
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
            {downloading ? 'Preparing…' : 'Download PDF'}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => setDelOpen(true)}
            data-testid="invoice-delete-open"
            className={`${btnBase} border border-destructive/40 text-destructive hover:bg-destructive/10`}
          >
            Delete draft
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
            Add at least one customer-visible line to issue.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={issueSendOpen}
        onClose={() => setIssueSendOpen(false)}
        onConfirm={() => void issue(true)}
        isLoading={issuing}
        variant="warning"
        title="Issue and send this invoice?"
        message={`This issues the invoice and emails it to ${invoice.billToName ?? 'the customer'} for ${formatMoney(invoice.total, currency)}. This can't be undone.`}
        confirmLabel="Issue & Send"
        confirmTestId="invoice-issue-send-confirm"
      />
      <ConfirmDialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        onConfirm={() => void remove()}
        isLoading={deleting}
        title="Delete draft invoice"
        message="This permanently deletes the draft invoice. This cannot be undone."
        confirmLabel="Delete draft"
        confirmTestId="invoice-delete-confirm"
      />
    </>
  );
}
