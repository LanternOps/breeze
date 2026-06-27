import { useCallback, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../../lib/runAction';
import { usePermissions } from '../../../lib/permissions';
import { useOrgStore } from '../../../stores/orgStore';
import { deleteQuote, quotePdfUrl, sendQuote } from '../../../lib/api/quotes';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { RecurringBillingNote } from '../billingUi';
import {
  type QuoteDetail as QuoteDetailData,
  type QuoteBlock,
  type QuoteLine,
  STATUS_COLORS,
  statusLabel,
  formatDate,
  formatMoney,
  formatRecurrence,
  sellerLines,
} from './quoteTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: QuoteDetailData;
  // The parent reloads the quote when an action mutates it (e.g. send flips the
  // status draft→sent and stamps sentAt). Phase 1 had no detail-view mutations;
  // Phase 2's Send button uses it.
  onChanged?: () => void;
}

export default function QuoteDetail({ detail, onChanged }: Props) {
  const { can } = usePermissions();
  const organizations = useOrgStore((s) => s.organizations);
  const { quote, blocks, lines } = detail;
  const currency = quote.currencyCode;

  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const refresh = useCallback(() => onChanged?.(), [onChanged]);

  // Sending emails the customer and is irreversible, so it goes through a
  // confirm step — and an empty quote (no blocks, no lines) can't be sent at all.
  const isEmpty = blocks.length === 0 && lines.length === 0;

  const send = useCallback(async () => {
    if (sending) return;
    setSending(true);
    try {
      await runAction({
        request: () => sendQuote(quote.id),
        errorFallback: 'Could not send the proposal.',
        successMessage: 'Proposal sent',
        onUnauthorized: UNAUTHORIZED,
      });
      setSendOpen(false);
      refresh();
    } catch (err) {
      handleActionError(err, 'Could not send the proposal.');
    } finally {
      setSending(false);
    }
  }, [sending, quote.id, refresh]);

  const remove = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await runAction({
        request: () => deleteQuote(quote.id),
        errorFallback: 'Could not delete the draft.',
        successMessage: 'Draft deleted',
        onUnauthorized: UNAUTHORIZED,
      });
      setDelOpen(false);
      void navigateTo('/billing/quotes');
    } catch (err) {
      handleActionError(err, 'Could not delete the draft.');
    } finally {
      setDeleting(false);
    }
  }, [deleting, quote.id]);

  const sortedBlocks = useMemo(
    () => [...blocks].sort((a, b) => a.sortOrder - b.sortOrder),
    [blocks],
  );

  const linesForBlock = useCallback(
    (blockId: string | null) =>
      lines
        .filter((l) => l.blockId === blockId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [lines],
  );

  // Lines not attached to any block (direct/unsectioned lines) render in a trailing
  // table so nothing is dropped from the view.
  const looseLines = useMemo(() => linesForBlock(null), [linesForBlock]);

  const downloadPdf = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetchWithAuth(quotePdfUrl(quote.id));
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) { handleActionError(new Error('pdf'), 'Could not download the quote PDF.'); return; }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${quote.quoteNumber ?? `quote-${quote.id}`}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      handleActionError(err, 'Could not download the quote PDF.');
    } finally {
      setBusy(false);
    }
  }, [busy, quote.id, quote.quoteNumber]);

  const hasRecurring =
    Number(quote.monthlyRecurringTotal) > 0 || Number(quote.annualRecurringTotal) > 0;

  // Customer label: prefer the explicit bill-to name; otherwise resolve the real
  // organization name from the client-side org list (same source the org switcher
  // renders). Fall back to the UUID prefix only when neither is available (e.g.
  // the quote's org isn't in the currently-loaded list, such as All-orgs scope).
  // Use truthiness after trim, not `??`: the bill-to validator allows an empty
  // string, and a blank/whitespace billToName would otherwise render an empty
  // Customer cell — the same "unfinished header" symptom (#1712) via a different
  // input.
  const orgName = useMemo(() => {
    const billTo = quote.billToName?.trim();
    if (billTo) return billTo;
    const resolved = organizations.find((o) => o.id === quote.orgId)?.name?.trim();
    if (resolved) return resolved;
    return quote.orgId.slice(0, 8);
  }, [quote.billToName, quote.orgId, organizations]);

  return (
    <div className="space-y-6" data-testid="quote-detail">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── rendered blocks + lines ───────────────────────────────────── */}
        <div className="space-y-4">
          {sortedBlocks.length === 0 && looseLines.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-card p-8 text-center" data-testid="quote-detail-empty">
              <p className="text-sm text-muted-foreground">This quote has no content yet.</p>
              {quote.status === 'draft' && can('quotes', 'write') && (
                <button
                  type="button"
                  onClick={() => { if (typeof window !== 'undefined') window.location.hash = '#editor'; }}
                  data-testid="quote-detail-empty-edit"
                  className="mt-3 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Add content in the Editor
                </button>
              )}
            </div>
          ) : (
            sortedBlocks.map((block) => (
              <BlockView
                key={block.id}
                block={block}
                lines={linesForBlock(block.id)}
                currency={currency}
              />
            ))
          )}

          {looseLines.length > 0 && (
            <LineTable lines={looseLines} currency={currency} label="Other items" testId="quote-detail-loose-lines" />
          )}
        </div>

        {/* ── summary + actions ─────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="quote-detail-summary">
            <div className="mb-3 flex items-center justify-between">
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[quote.status]}`}
                data-testid="quote-detail-status"
                aria-label={`Status: ${statusLabel(quote)}`}
              >
                {statusLabel(quote)}
              </span>
              {quote.expiryDate && (
                <span className="text-xs text-muted-foreground">Expires {formatDate(quote.expiryDate)}</span>
              )}
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Customer</dt><dd className="text-right" data-testid="quote-detail-customer">{orgName}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Issued</dt><dd>{formatDate(quote.issueDate)}</dd></div>
              {(!quote.issueDate || formatDate(quote.issueDate) !== formatDate(quote.createdAt)) && (
                <div className="flex justify-between"><dt className="text-muted-foreground">Created</dt><dd>{formatDate(quote.createdAt)}</dd></div>
              )}
            </dl>
          </div>

          {/* Recurring + totals summary */}
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="quote-detail-totals">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Totals</h3>
            <dl className="space-y-1 text-sm tabular-nums">
              <div className="flex justify-between"><dt className="text-muted-foreground">One-time</dt><dd>{formatMoney(quote.oneTimeTotal, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Monthly</dt><dd>{formatMoney(quote.monthlyRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/mo</span></dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Annual</dt><dd>{formatMoney(quote.annualRecurringTotal, currency)}<span className="text-xs text-muted-foreground">/yr</span></dd></div>
              {Number(quote.taxTotal) > 0 && (
                <div className="flex justify-between"><dt className="text-muted-foreground">Tax</dt><dd>{formatMoney(quote.taxTotal, currency)}</dd></div>
              )}
            </dl>
            <div className="mt-3 flex items-end justify-between gap-2 border-t pt-3">
              <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Due on acceptance</span>
              <span className="min-w-0 break-words text-right text-2xl font-semibold tabular-nums" data-testid="quote-detail-due-on-acceptance">{formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency)}</span>
            </div>
            {hasRecurring && (
              <>
                <div className="mt-2 flex justify-between text-sm tabular-nums">
                  <span className="text-muted-foreground">First-period total (incl. recurring)</span>
                  <span className="font-medium" data-testid="quote-detail-first-period">{formatMoney(quote.total, currency)}</span>
                </div>
                <RecurringBillingNote className="mt-2" />
              </>
            )}
          </div>

          {/* Seller From block */}
          {quote.sellerSnapshot && (
            <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="quote-detail-from">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">From</h3>
              <div className="space-y-0.5 text-sm">
                {quote.sellerSnapshot.name && (
                  <p className="font-medium" data-testid="quote-detail-from-name">{quote.sellerSnapshot.name}</p>
                )}
                {sellerLines(quote.sellerSnapshot.address).map((line, i) => (
                  <p key={i} className="text-muted-foreground">{line}</p>
                ))}
                {quote.sellerSnapshot.phone && (
                  <p className="text-muted-foreground" data-testid="quote-detail-from-phone">{quote.sellerSnapshot.phone}</p>
                )}
                {quote.sellerSnapshot.email && (
                  <p className="text-muted-foreground" data-testid="quote-detail-from-email">{quote.sellerSnapshot.email}</p>
                )}
                {quote.sellerSnapshot.website && (
                  <p className="text-muted-foreground" data-testid="quote-detail-from-website">{quote.sellerSnapshot.website}</p>
                )}
              </div>
            </div>
          )}

          {/* Terms & Conditions */}
          {quote.termsAndConditions && (
            <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="quote-detail-terms">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Terms & Conditions</h3>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{quote.termsAndConditions}</p>
            </div>
          )}

          {/* Actions — the primary action leads. On a draft that's "Send proposal"
              (the irreversible money-moment); on an issued quote only "Download PDF"
              remains, as a secondary affordance. */}
          <div className="space-y-2">
            {/* Send a draft proposal: issues a number, emails the customer's billing
                contact with the PDF + a public accept link, and flips draft→sent.
                Gated on quotes:send. Only a draft can be sent — once sent, the
                button drops out (the status pill above reflects the new state). The
                click opens a confirm step; an empty quote can't be sent. */}
            {can('quotes', 'send') && quote.status === 'draft' && (
              <>
                <button
                  type="button"
                  onClick={() => setSendOpen(true)}
                  disabled={sending || isEmpty}
                  title={isEmpty ? 'Add at least one item before sending.' : undefined}
                  data-testid="quote-send"
                  className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {sending ? 'Sending…' : 'Send proposal'}
                </button>
                {isEmpty && (
                  <p className="text-center text-xs text-muted-foreground" data-testid="quote-send-empty-hint">
                    Add at least one item before sending.
                  </p>
                )}
              </>
            )}
            {/* PDF download is a read affordance — quotes has no dedicated export
                action, so it's gated on quotes:read (visible to anyone who can view
                the quote). Secondary to the send action. */}
            {can('quotes', 'read') && (
              <button
                type="button"
                onClick={() => void downloadPdf()}
                disabled={busy}
                data-testid="quote-download-pdf"
                className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Download PDF
              </button>
            )}
            {can('quotes', 'write') && quote.status === 'draft' && (
              <button
                type="button"
                onClick={() => setDelOpen(true)}
                data-testid="quote-delete-open"
                className="inline-flex w-full items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
              >
                Delete draft
              </button>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        onConfirm={() => void send()}
        isLoading={sending}
        variant="warning"
        title="Send this proposal?"
        message={`We'll email this proposal to ${orgName} and mark it Sent — ${formatMoney(quote.dueOnAcceptanceTotal ?? quote.oneTimeTotal, currency)} due on acceptance. This can't be undone.`}
        confirmLabel="Send proposal"
        confirmTestId="quote-send-confirm"
      />
      <ConfirmDialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        onConfirm={() => void remove()}
        isLoading={deleting}
        title="Delete draft quote"
        message="This permanently deletes the draft quote. This cannot be undone."
        confirmLabel="Delete draft"
        confirmTestId="quote-delete-confirm"
      />
    </div>
  );
}

function BlockView({ block, lines, currency }: { block: QuoteBlock; lines: QuoteLine[]; currency: string }) {
  const heading = (block.content?.text as string | undefined) ?? '';
  const html = (block.content?.html as string | undefined) ?? '';
  const tableLabel = (block.content?.label as string | undefined) ?? '';
  const caption = (block.content?.caption as string | undefined) ?? '';

  if (block.blockType === 'heading') {
    return <h2 className="text-lg font-semibold" data-testid={`quote-detail-block-${block.id}`}>{heading}</h2>;
  }
  if (block.blockType === 'rich_text') {
    return (
      <p className="whitespace-pre-wrap text-sm text-foreground" data-testid={`quote-detail-block-${block.id}`}>{html}</p>
    );
  }
  if (block.blockType === 'image') {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground" data-testid={`quote-detail-block-${block.id}`}>
        Image{caption ? ` — ${caption}` : ''} (rendered in the PDF).
      </div>
    );
  }
  // line_items
  return (
    <div data-testid={`quote-detail-block-${block.id}`}>
      <LineTable lines={lines} currency={currency} label={tableLabel || 'Pricing'} testId={`quote-detail-lines-${block.id}`} />
    </div>
  );
}

function LineTable({ lines, currency, label, testId }: { lines: QuoteLine[]; currency: string; label: string; testId: string }) {
  return (
    <div className="rounded-lg border bg-card shadow-sm">
      {label && (
        <h3 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      )}
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">Description</th>
            <th className="px-3 py-2 text-right font-medium">Qty</th>
            <th className="px-3 py-2 text-right font-medium">Unit</th>
            <th className="px-3 py-2 font-medium">Recurrence</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">No lines.</td>
            </tr>
          ) : (
            lines.map((l) => (
              <tr key={l.id} className="border-t" data-testid={`quote-detail-line-${l.id}`}>
                <td className="px-3 py-2">{l.description}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.unitPrice, currency)}</td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {formatRecurrence(l.recurrence)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.lineTotal, currency)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
