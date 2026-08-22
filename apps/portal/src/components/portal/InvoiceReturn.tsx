import { useEffect, useState } from 'react';
import { portalApi } from '@/lib/api';

/**
 * The Stripe-Checkout return trampoline for PUBLIC invoice payments.
 *
 * The checkout return urls deliberately carry only the session id (never the
 * durable bearer token — it must not reach Stripe's logs), so this page:
 *  1. POSTs /invoices/public/settle-return {sessionId} — settles idempotently
 *     and gets back the invoice's canonical public url;
 *  2. location.replace()s onto that page with ?paid=1 / ?pending=1 so the
 *     invoice view shows the right banner (replace: a back-press must not
 *     re-run the trampoline).
 * If the exchange fails (stale session, API hiccup) the customer is told to
 * use the link in their email — never a login wall.
 */
export function InvoiceReturn() {
  const [failed, setFailed] = useState(false);
  const [canceled, setCanceled] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    const wasCanceled = params.get('canceled') === '1';
    setCanceled(wasCanceled);
    if (!sessionId) { setFailed(true); return; }

    let cancelled = false;
    void portalApi.settlePublicReturn(sessionId)
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data;
        if (!data?.publicUrl) { setFailed(true); return; }
        const url = new URL(data.publicUrl);
        if (!wasCanceled) url.searchParams.set(data.settled ? 'paid' : 'pending', '1');
        window.location.replace(url.toString());
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  if (failed) {
    return (
      <div data-testid="invoice-return-failed" className="mx-auto max-w-lg p-8 text-center text-sm text-muted-foreground">
        {canceled
          ? 'Payment was not completed. You can return to your invoice using the link in your email.'
          : 'We could not confirm this payment session. Your invoice is still available via the link in your email — if you completed payment, it will be applied automatically within a few minutes.'}
      </div>
    );
  }
  return (
    <div data-testid="invoice-return-working" className="mx-auto max-w-lg p-8 text-center text-sm text-muted-foreground">
      {canceled ? 'Returning to your invoice…' : 'Confirming your payment…'}
    </div>
  );
}

export default InvoiceReturn;
