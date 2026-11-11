import { useCallback, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { formatMoney } from '../billing/shared/format';
import type { AssembleInvoiceResponse, BlockedCurrencyGroup, MissingRateEntry } from './ticketWorkbenchTypes';

const TITLE_ID = 'ticket-invoice-blocked-title';

/**
 * "Create invoice" for the Time & billing section. Assembles a draft invoice
 * from this ticket's billable work, then jumps to it. When rows are left out
 * (another currency, no rate) the recovery controls open in a dialog instead
 * of stacking above the conversation (#3776).
 */
export default function TicketInvoiceAction({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation('tickets');
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  // Multi-currency (#3776): 409 ALL_BLOCKED_BY_CURRENCY groups from the last
  // create-invoice attempt — each becomes an "assemble in <code>" shortcut.
  const [invoiceBlocked, setInvoiceBlocked] = useState<BlockedCurrencyGroup[]>([]);
  const [invoiceMissingRate, setInvoiceMissingRate] = useState<MissingRateEntry[]>([]);
  // Set on a partial success: the draft that WAS created while rows were left
  // out. We stay on the ticket so the left-out rows are visible; this links to it.
  const [partialInvoiceId, setPartialInvoiceId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // `currencyCode` is the explicit old-currency path (#3776): the endpoint is
  // body-less, so the override travels as a query param.
  const createInvoice = useCallback(async (currencyCode?: string) => {
    if (creatingInvoice) return;
    setCreatingInvoice(true);
    setInvoiceBlocked([]);
    setInvoiceMissingRate([]);
    setPartialInvoiceId(null);
    setDismissed(false);
    const path = currencyCode
      ? `/tickets/${ticketId}/invoice?currencyCode=${encodeURIComponent(currencyCode)}`
      : `/tickets/${ticketId}/invoice`;
    try {
      const result = await runAction<AssembleInvoiceResponse>({
        request: () => fetchWithAuth(path, { method: 'POST' }),
        errorFallback: t('ticketWorkbench.invoice.createFailed'),
        successMessage: t('ticketWorkbench.invoice.created'),
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true })
      });
      const newId = result?.data?.invoice?.id;
      const blocked = result?.data?.blockedByCurrency ?? [];
      const missing = result?.data?.missingRate ?? [];
      // Entries inside a block-hours window are held until the block period closes (#4547).
      const held = result?.data?.heldForHourBlock;
      if (held && held.count > 0) {
        showToast({ type: 'warning', message: t('ticketWorkbench.invoice.heldForHourBlock', { count: held.count, hours: Number(Number(held.hours).toFixed(2)) }) });
      }
      if (blocked.length === 0 && missing.length === 0) {
        if (newId) void navigateTo(`/billing/invoices/${newId}`);
        return;
      }
      // Partial success (review #3): the draft exists, but rows in another
      // currency and/or without a rate were left out. Navigating now would hide
      // that — stay here, show the same recovery controls as the all-blocked
      // path, and link to the draft instead.
      setInvoiceBlocked(blocked);
      setInvoiceMissingRate(missing);
      setPartialInvoiceId(newId ?? null);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      // Already toasted by runAction; offer the per-currency shortcuts and
      // list the rate-less entries. ALL_BLOCKED_BY_CURRENCY details also carry
      // missingRate; ALL_MISSING_RATE carries only missingRate.
      if (err.code === 'ALL_BLOCKED_BY_CURRENCY' || err.code === 'ALL_MISSING_RATE') {
        const details = (err.body as { details?: { blockedByCurrency?: BlockedCurrencyGroup[]; missingRate?: MissingRateEntry[] } } | undefined)?.details;
        setInvoiceBlocked(details?.blockedByCurrency ?? []);
        setInvoiceMissingRate(details?.missingRate ?? []);
      }
      if (err.code === 'NOTHING_TO_INVOICE') {
        // runAction already toasted the server's message; add WHY when the work is merely held for a block.
        const held = (err.body as { details?: { heldForHourBlock?: { count: number; hours: number } } } | undefined)?.details?.heldForHourBlock;
        if (held && held.count > 0) {
          showToast({ type: 'warning', message: t('ticketWorkbench.invoice.heldForHourBlock', { count: held.count, hours: Number(Number(held.hours).toFixed(2)) }) });
        }
      }
    } finally {
      setCreatingInvoice(false);
    }
  }, [ticketId, creatingInvoice, t]);

  const blockedOpen = !dismissed && (invoiceBlocked.length > 0 || invoiceMissingRate.length > 0);

  return (
    <>
      <button
        type="button"
        onClick={() => void createInvoice()}
        disabled={creatingInvoice}
        className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        data-testid="ticket-workbench-create-invoice"
      >
        {creatingInvoice ? t('ticketWorkbench.invoice.creating') : t('ticketWorkbench.invoice.create')}
      </button>
      <Dialog open={blockedOpen} onClose={() => setDismissed(true)} title={t('ticketFocus.invoiceDialogTitle')} labelledBy={TITLE_ID} maxWidth="md" className="p-5">
        <div className="space-y-3 text-sm" data-testid="ticket-invoice-blocked" role="status">
          <h2 id={TITLE_ID} className="text-base font-semibold">{t('ticketFocus.invoiceDialogTitle')}</h2>
          {partialInvoiceId ? (
            <p>
              {t('ticketWorkbench.invoice.partialLeftOut')}{' '}
              <a href={`/billing/invoices/${partialInvoiceId}`} className="font-medium text-primary-ink underline" data-testid="ticket-invoice-open-draft">
                {t('ticketWorkbench.invoice.openDraft')}
              </a>
            </p>
          ) : invoiceBlocked.length > 0 ? (
            <p>{t('ticketWorkbench.invoice.allBlockedByCurrency')}</p>
          ) : (
            <p>{t('ticketWorkbench.invoice.allMissingRate')}</p>
          )}
          {invoiceBlocked.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {invoiceBlocked.map((g) => (
                <button
                  key={g.currencyCode}
                  type="button"
                  disabled={creatingInvoice}
                  onClick={() => void createInvoice(g.currencyCode)}
                  data-testid={`ticket-assemble-in-${g.currencyCode}`}
                  className="rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                >
                  {t('ticketWorkbench.invoice.assembleIn', { code: g.currencyCode, count: g.count, amount: formatMoney(g.amount, g.currencyCode) })}
                </button>
              ))}
            </div>
          )}
          {invoiceMissingRate.length > 0 && (
            <div data-testid="ticket-invoice-missing-rate">
              <p className="font-medium">{t('ticketWorkbench.invoice.missingRateHeading')}</p>
              <ul className="mt-1 list-disc pl-4">
                {invoiceMissingRate.map((m) => (
                  <li key={m.timeEntryId} data-testid={`ticket-invoice-missing-rate-${m.timeEntryId}`}>
                    {t('ticketWorkbench.invoice.missingRateEntry', { description: m.description, hours: m.hours })}
                  </li>
                ))}
              </ul>
              <a href="/timesheet" className="mt-1 inline-block font-medium text-primary-ink underline" data-testid="ticket-invoice-set-rate">
                {t('ticketWorkbench.invoice.setRate')}
              </a>
            </div>
          )}
          <div className="flex justify-end">
            <button type="button" onClick={() => setDismissed(true)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="ticket-invoice-blocked-close">
              {t('common:actions.close')}
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
