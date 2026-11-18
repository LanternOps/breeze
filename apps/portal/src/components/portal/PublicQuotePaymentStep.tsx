import { useState } from 'react';
import { portalApi, type PublicQuotePayment } from '@/lib/api';
import { money } from '@/lib/format';
import { replaceLocation } from '@/lib/replaceLocation';
import { runAction } from '@/lib/runAction';
import { BTN_PRIMARY } from './ui';

/**
 * #3740: payment as a real step after acceptance, not a footnote under a
 * success banner. Shown on the public quote page right after an accept that had
 * no invoice page to land on, and on any later visit to an accepted quote's
 * link — the API lets that link (even once spent by the accept) reach this
 * quote's invoice payment and nothing else. Rendered only when something is
 * payable online; the server re-checks every payment guard on Pay.
 */
export function PublicQuotePaymentStep({ token, payment }: { token: string; payment: PublicQuotePayment }) {
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const amount = money(payment.amount, payment.currencyCode);

  const pay = async () => {
    if (paying) return;
    setPaying(true);
    setPayError(null);
    const result = await runAction({
      request: () => portalApi.payPublicQuote(token),
      onOutcome: (message, error) => { if (error) setPayError(message); },
      successMessage: 'Opening secure checkout…',
      errorFallback: 'Could not start payment. Please try again.',
      validate: (value) => typeof value.data?.url === 'string' && value.data.url.startsWith('https://checkout.stripe.com/'),
    });
    // replace, not assign: Stripe's success and cancel both return to the
    // invoice's durable page, so back must not land on this step again.
    if (result) replaceLocation(result.data.url);
    else setPaying(false);
  };

  return (
    <div data-testid="public-quote-payment-step" className="space-y-3 rounded-md border-2 border-primary bg-card p-5 text-card-foreground">
      <p className="text-base font-semibold">Acceptance recorded — one more step</p>
      <p className="text-sm">
        Payment of <strong>{amount}</strong>{payment.isDeposit ? ' (deposit)' : ''} is due
        {payment.invoiceNumber ? ` on invoice ${payment.invoiceNumber}` : ''}.
      </p>
      <button
        type="button"
        data-testid="public-quote-pay-now"
        onClick={() => void pay()}
        disabled={paying}
        className={BTN_PRIMARY}
      >
        {paying ? 'Opening secure checkout…' : (payment.isDeposit ? `Pay deposit ${amount}` : `Pay ${amount}`)}
      </button>
      {payError && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint">{payError}</p>
      )}
    </div>
  );
}
