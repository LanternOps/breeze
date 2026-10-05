import { useRef, useState } from 'react';
import type { ApiResponse, AutopayConfirmationRelease } from '@/lib/api';
import { runAction } from '@/lib/runAction';
import { money } from '@/lib/money';
import { cn } from '@/lib/utils';
import { BTN_BLOCK, BTN_PRIMARY, Notice } from './ui';

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
 * On `released` the parent takes over (it shows the released state and Pay).
 */
export function AutopayConfirmationNotice({ amount, currency, release, onReleased }: {
  amount: string; currency: string;
  release: () => Promise<ApiResponse<AutopayConfirmationRelease>>;
  onReleased: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [settled, setSettled] = useState(false);
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current || settled) return;
    inFlight.current = true; setBusy(true);
    const result = await runAction<AutopayConfirmationRelease>({
      request: release,
      onOutcome: (text, error) => { if (error) setMessage({ text, error }); },
      successMessage: 'Automatic payment canceled.',
      errorFallback: "We couldn't cancel the automatic payment. Try again in a moment.",
      validate: value => ['released', 'processing', 'paid', 'not_needed'].includes(value?.outcome),
    });
    inFlight.current = false; setBusy(false);
    if (!result) return;
    setSettled(true);
    if (result.outcome === 'released') { await onReleased(); return; }
    setMessage({ text: RESULT_TEXT[result.outcome], error: false });
  };
  return (
    <Notice tone="warning" title="Your bank needs you to confirm this payment" data-testid="autopay-confirmation-notice"
      action={!settled && (
        <button type="button" onClick={() => void submit()} disabled={busy} data-testid="autopay-confirmation-continue" className={cn(BTN_PRIMARY, BTN_BLOCK)}>
          {busy ? 'Canceling the automatic payment…' : 'Continue to payment'}
        </button>
      )}>
      {!settled && (
        <p>{`The automatic payment of ${money(amount, currency)} can't finish until your bank confirms it. Nothing has been charged yet. Continue to cancel that attempt and pay now; your bank will ask you to confirm.`}</p>
      )}
      {message && <p role={message.error ? 'alert' : undefined} data-testid="autopay-confirmation-result">{message.text}</p>}
    </Notice>
  );
}

export default AutopayConfirmationNotice;
