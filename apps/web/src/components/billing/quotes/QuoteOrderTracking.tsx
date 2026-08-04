// Fulfillment tracking for a won quote: the "Mark ordered" dialog that records a
// real-world purchase order against selected quote lines, plus the compact
// allocation rows that sit under each covered line in QuoteOrderBreakdown and
// carry the receive / cancel actions.
//
// Everything here is gated on `quotes:fulfill` (a permission distinct from
// quotes:write) at BOTH ends: the caller decides whether to render the controls,
// and every route re-checks server-side.
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { fromCents, toCents } from '@breeze/shared';
import { Dialog } from '../../shared/Dialog';
import { handleActionError, runAction } from '../../../lib/runAction';
import { createQuoteOrder, updateQuoteOrderLine } from '../../../lib/api/quotes';
import { formatDate, formatQuantity, procurementSourceLabel, type QuoteOrderLine } from './quoteTypes';

/** A quote line the tech has selected to order, with the quantity that is not
 *  yet covered by an active (non-cancelled) allocation. */
export interface QuoteOrderCandidate {
  lineId: string;
  /** Display title — the same `lineTitle(l)` the breakdown row shows. */
  title: string;
  /** Unordered remainder as a 2dp decimal string ('2.00'). */
  remainder: string;
  procurementSource: string | null;
}

/** Remaining, not-yet-ordered quantity for a line: its quote quantity minus
 *  every ACTIVE allocation against it (cancelled allocations free their
 *  quantity back up). Never negative — an over-ordered line reads as 0 rather
 *  than proposing a negative default. */
export function unorderedRemainder(quantity: string, allocations: QuoteOrderLine[]): string {
  const ordered = allocations
    .filter((a) => !a.cancelledAt)
    .reduce((sum, a) => sum + toCents(a.orderedQty), 0);
  return fromCents(Math.max(0, toCents(quantity) - ordered));
}

/** Shared vendor label for a selection: the one procurement source every
 *  candidate carries, or null when the selection is mixed / sourceless. A mixed
 *  selection deliberately prefills nothing rather than guessing a vendor onto a
 *  purchase order. */
function commonSource(candidates: QuoteOrderCandidate[]): string | null {
  const first = candidates[0]?.procurementSource ?? null;
  if (!first) return null;
  return candidates.every((c) => c.procurementSource === first) ? first : null;
}

const INPUT_CLASS =
  'w-full rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * "Mark ordered" dialog. Mount it only while open (the caller conditionally
 * renders it) — the per-session state, including the idempotency key, is
 * initialised at mount so every open is a fresh order attempt.
 */
export function QuoteOrderTrackingDialog({
  open,
  quoteId,
  candidates,
  onClose,
  onChanged,
}: {
  open: boolean;
  quoteId: string;
  /** The selected lines. Lines with nothing left to order are filtered out by
   *  the caller; an empty list renders the empty state with submit disabled. */
  candidates: QuoteOrderCandidate[];
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { t } = useTranslation('billing');
  const headingId = useId();
  const fieldId = useId();
  const source = useMemo(() => commonSource(candidates), [candidates]);
  // Captured once at mount: the candidate list is recomputed by the parent on
  // every render, and re-deriving the defaults from it would stomp on whatever
  // the user has typed.
  const [rows] = useState(() => candidates);
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(candidates.map((c) => [c.lineId, c.remainder])),
  );
  // Prefilled from the selection's shared distributor; a mixed selection starts
  // blank rather than guessing a vendor onto a real purchase order.
  const [vendorName, setVendorName] = useState(() => (source ? procurementSourceLabel(source) : ''));
  const [orderRef, setOrderRef] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [eta, setEta] = useState('');
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  // A ref, not the `pending` state: a second click can land in the same tick as
  // the first, before React has re-rendered the disabled button.
  const pendingRef = useRef(false);
  // The idempotency key for THIS attempt-session. Minted once at mount so a
  // double-submit (or a retry after a network blip) dedupes server-side into
  // one order instead of creating two.
  const clientRequestId = useRef(crypto.randomUUID());

  const parsedLines = useMemo(
    () => rows.map((r) => ({ quoteLineId: r.lineId, orderedQty: Number(qty[r.lineId]) })),
    [rows, qty],
  );
  const valid =
    parsedLines.length > 0 &&
    parsedLines.every((l) => Number.isFinite(l.orderedQty) && l.orderedQty > 0);

  const handleSubmit = useCallback(async () => {
    if (pendingRef.current || !valid) return;
    pendingRef.current = true;
    setPending(true);
    const vendor = vendorName.trim();
    const ref = orderRef.trim();
    const tracking = trackingNumber.trim();
    const note = notes.trim();
    try {
      await runAction({
        request: () =>
          createQuoteOrder(quoteId, {
            clientRequestId: clientRequestId.current,
            ...(source ? { procurementSource: source } : {}),
            ...(vendor ? { vendorName: vendor } : {}),
            ...(ref ? { orderRef: ref } : {}),
            ...(tracking ? { trackingNumber: tracking } : {}),
            ...(eta ? { eta } : {}),
            ...(note ? { notes: note } : {}),
            lines: parsedLines,
          }),
        errorFallback: t('quotes.detail.orderBreakdown.fulfillment.dialog.error'),
        successMessage: t('quotes.detail.orderBreakdown.fulfillment.dialog.success'),
      });
      onChanged?.();
      onClose();
    } catch (err) {
      handleActionError(err, t('quotes.detail.orderBreakdown.fulfillment.dialog.error'));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [valid, vendorName, orderRef, trackingNumber, notes, eta, source, parsedLines, quoteId, t, onChanged, onClose]);

  if (!open) return null;

  return (
    <Dialog open onClose={onClose} title={t('quotes.detail.orderBreakdown.fulfillment.dialog.title')} labelledBy={headingId} maxWidth="lg" className="p-4">
      <form
        data-testid="quote-order-tracking"
        onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }}
      >
        <h2 id={headingId} className="text-sm font-semibold">
          {t('quotes.detail.orderBreakdown.fulfillment.dialog.title')}
        </h2>

        {rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground" data-testid="quote-order-tracking-empty">
            {t('quotes.detail.orderBreakdown.fulfillment.dialog.empty')}
          </p>
        ) : (
          <ul className="mt-3 space-y-2 border-b pb-3">
            {rows.map((r) => (
              <li key={r.lineId} className="flex items-center justify-between gap-3">
                <label htmlFor={`${fieldId}-qty-${r.lineId}`} className="min-w-0 flex-1 truncate text-sm">
                  {r.title}
                </label>
                <input
                  id={`${fieldId}-qty-${r.lineId}`}
                  data-testid={`quote-order-tracking-qty-${r.lineId}`}
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  aria-label={t('quotes.detail.orderBreakdown.fulfillment.dialog.qtyAria', { item: r.title })}
                  className={`${INPUT_CLASS} w-24 text-right tabular-nums`}
                  value={qty[r.lineId] ?? ''}
                  onChange={(e) => setQty((prev) => ({ ...prev, [r.lineId]: e.target.value }))}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field id={`${fieldId}-vendor`} label={t('quotes.detail.orderBreakdown.fulfillment.dialog.vendor')}>
            <input
              id={`${fieldId}-vendor`}
              data-testid="quote-order-tracking-vendor"
              className={INPUT_CLASS}
              maxLength={255}
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
            />
          </Field>
          <Field id={`${fieldId}-ref`} label={t('quotes.detail.orderBreakdown.fulfillment.dialog.orderRef')}>
            <input
              id={`${fieldId}-ref`}
              data-testid="quote-order-tracking-order-ref"
              className={INPUT_CLASS}
              maxLength={120}
              value={orderRef}
              onChange={(e) => setOrderRef(e.target.value)}
            />
          </Field>
          <Field id={`${fieldId}-tracking`} label={t('quotes.detail.orderBreakdown.fulfillment.dialog.tracking')}>
            <input
              id={`${fieldId}-tracking`}
              data-testid="quote-order-tracking-tracking"
              className={INPUT_CLASS}
              maxLength={120}
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
            />
          </Field>
          <Field id={`${fieldId}-eta`} label={t('quotes.detail.orderBreakdown.fulfillment.dialog.eta')}>
            <input
              id={`${fieldId}-eta`}
              data-testid="quote-order-tracking-eta"
              type="date"
              className={INPUT_CLASS}
              value={eta}
              onChange={(e) => setEta(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field id={`${fieldId}-notes`} label={t('quotes.detail.orderBreakdown.fulfillment.dialog.notes')}>
              <textarea
                id={`${fieldId}-notes`}
                data-testid="quote-order-tracking-notes"
                rows={2}
                maxLength={2000}
                className={INPUT_CLASS}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            data-testid="quote-order-tracking-cancel"
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t('quotes.detail.orderBreakdown.fulfillment.dialog.cancel')}
          </button>
          <button
            type="submit"
            disabled={!valid || pending}
            data-testid="quote-order-tracking-submit"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t('quotes.detail.orderBreakdown.fulfillment.dialog.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

/**
 * One allocation under its quote line in the breakdown table: what was ordered,
 * what has arrived, and the receive / cancel actions. Deliberately a single
 * full-width row rather than a nested table — this is an annotation on the line
 * above it, not a second grid.
 */
export function QuoteOrderAllocationRow({
  quoteId,
  allocation,
  vendorLabel,
  orderRef,
  colSpan,
  canFulfill,
  onChanged,
}: {
  quoteId: string;
  allocation: QuoteOrderLine;
  /** Display name of the owning order's vendor (already label-mapped). */
  vendorLabel: string | null;
  orderRef: string | null;
  colSpan: number;
  canFulfill: boolean;
  onChanged?: () => void;
}) {
  const { t } = useTranslation('billing');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const cancelled = Boolean(allocation.cancelledAt);
  const fullyReceived = toCents(allocation.receivedQty) >= toCents(allocation.orderedQty);

  const patch = useCallback(
    async (body: { receivedQty?: number; cancelled?: boolean }, errorFallback: string, successMessage: string) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      try {
        await runAction({
          request: () => updateQuoteOrderLine(quoteId, allocation.orderId, allocation.id, body),
          errorFallback,
          successMessage,
        });
        onChanged?.();
      } catch (err) {
        handleActionError(err, errorFallback);
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [quoteId, allocation.orderId, allocation.id, onChanged],
  );

  return (
    <tr className="border-t border-dashed" data-testid={`quote-order-breakdown-allocation-${allocation.id}`}>
      <td colSpan={colSpan} className="px-3 py-1.5">
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs ${cancelled ? 'text-muted-foreground line-through' : 'text-muted-foreground'}`}>
          <span className="font-medium text-foreground">
            {t('quotes.detail.orderBreakdown.fulfillment.allocation.ordered', {
              qty: formatQuantity(allocation.orderedQty),
            })}
          </span>
          {vendorLabel && <span>{vendorLabel}</span>}
          {orderRef && <span className="tabular-nums">{orderRef}</span>}
          <span className="tabular-nums">
            {t('quotes.detail.orderBreakdown.fulfillment.allocation.received', {
              qty: formatQuantity(allocation.receivedQty),
            })}
          </span>
          {allocation.trackingNumber && (
            <span className="tabular-nums">
              {t('quotes.detail.orderBreakdown.fulfillment.allocation.tracking', { number: allocation.trackingNumber })}
            </span>
          )}
          {allocation.eta && (
            <span className="tabular-nums">
              {t('quotes.detail.orderBreakdown.fulfillment.allocation.eta', { date: formatDate(allocation.eta) })}
            </span>
          )}
          {cancelled && (
            <span className="font-medium">
              {t('quotes.detail.orderBreakdown.fulfillment.allocation.cancelled')}
            </span>
          )}
          {canFulfill && !cancelled && (
            <span className="ml-auto flex items-center gap-2">
              {!fullyReceived && (
                <button
                  type="button"
                  disabled={pending}
                  data-testid={`quote-order-breakdown-receive-${allocation.id}`}
                  onClick={() => void patch(
                    { receivedQty: Number(allocation.orderedQty) },
                    t('quotes.detail.orderBreakdown.fulfillment.receiveError'),
                    t('quotes.detail.orderBreakdown.fulfillment.receiveSuccess'),
                  )}
                  className="rounded-md border px-2 py-0.5 font-medium text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {t('quotes.detail.orderBreakdown.fulfillment.receive')}
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                data-testid={`quote-order-breakdown-cancel-${allocation.id}`}
                onClick={() => void patch(
                  { cancelled: true },
                  t('quotes.detail.orderBreakdown.fulfillment.cancelError'),
                  t('quotes.detail.orderBreakdown.fulfillment.cancelSuccess'),
                )}
                className="rounded-md border px-2 py-0.5 font-medium text-foreground hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {t('quotes.detail.orderBreakdown.fulfillment.cancel')}
              </button>
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

export default QuoteOrderTrackingDialog;
