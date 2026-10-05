import { useState } from 'react';
import type { ApiResponse, AutopayConfirmationRelease } from '@/lib/api';
import { runAction } from '@/lib/runAction';
import { money } from '@/lib/money';

const RESULT_TEXT: Record<Exclude<AutopayConfirmationRelease['outcome'], 'released'>, string> = {
  processing: "This payment is already processing and can't be stopped. You'll get a receipt when it completes.",
  paid: 'Payment received. Refresh to see it applied.',
  not_needed: 'This payment no longer needs confirmation. Refresh to see the latest status.',
};

/**
 * An automatic payment is waiting on the customer's bank (off-session 3DS).
 * It can never complete on its own, so the page must not say "no action
 * needed". Continuing cancels that payment (as the emailed confirm link does)
 * so the customer can pay on-session; their bank confirms during checkout.
 */
export function AutopayConfirmationNotice({ amount, currency, release, onReleased }: {
  amount: string; currency: string;
  release: () => Promise<ApiResponse<AutopayConfirmationRelease>>;
  onReleased: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [settled, setSettled] = useState(false);
  const submit = async () => {
    if (busy || settled) return;
    setBusy(true);
    const result = await runAction<AutopayConfirmationRelease>({
      request: release,
      onOutcome: (text, error) => { if (error) setMessage({ text, error }); },
      successMessage: 'Automatic payment canceled.',
      errorFallback: "We couldn't cancel the automatic payment. Try again in a moment.",
      validate: value => ['released', 'processing', 'paid', 'not_needed'].includes(value?.outcome),
    });
    setBusy(false);
    if (!result) return;
    setSettled(true);
    if (result.outcome === 'released') { await onReleased(); return; }
    setMessage({ text: RESULT_TEXT[result.outcome], error: false });
  };
  return (
    <div role="status" className="space-y-2 rounded-md bg-warning/10 p-3 text-sm text-warning-on-tint" data-testid="autopay-confirmation-notice">
      <p className="font-medium">Your bank needs you to confirm this payment</p>
      <p>
        The automatic payment of {money(amount, currency)} can't finish until your bank confirms it.
        Continue to cancel that attempt and pay securely now — your bank will ask you to confirm during checkout.
      </p>
      {message && (
        <p role={message.error ? 'alert' : undefined} data-testid="autopay-confirmation-result">{message.text}</p>
      )}
      {!settled && (
        <button type="button" onClick={() => void submit()} disabled={busy} data-testid="autopay-confirmation-continue"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {busy ? 'Canceling automatic payment…' : 'Continue to payment'}
        </button>
      )}
    </div>
  );
}

export default AutopayConfirmationNotice;
