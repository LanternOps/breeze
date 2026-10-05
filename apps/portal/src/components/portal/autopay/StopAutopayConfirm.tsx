import { useRef, useState } from 'react';
import type { AutopayEnrollmentView, AutopayMethodView } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { savedMethodLabel } from '@/lib/autopay';
import { BTN_BLOCK, BTN_DANGER, BTN_SECONDARY, Notice, StatusMark } from '../ui';
import { SummaryList } from './SummaryList';

/**
 * "Stop automatic payments to {MSP}?": what stopping does, said once, with the
 * method being removed. Shared by the emailed stop link and the portal. The parent
 * performs the stop (onStop resolves true when it succeeded) and shows the outcome.
 */
export function StopAutopayConfirm({ partnerName, enrollment, method, onStop, onKeep, headingLevel = 1 }: {
  partnerName: string; enrollment: AutopayEnrollmentView | null; method: AutopayMethodView | null;
  onStop: () => Promise<boolean>; onKeep: () => void; headingLevel?: 1 | 2;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const H = headingLevel === 1 ? 'h1' : 'h2';
  const paused = enrollment?.status === 'paused';
  const bank = method?.type === 'us_bank_account';
  const msp = partnerName || 'your service provider';
  async function stop() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setFailed(false);
    const ok = await onStop().catch(() => false);
    inFlight.current = false; setBusy(false);
    if (!ok) setFailed(true);
  }
  return (
    <div className="space-y-5" data-testid="autopay-stop-confirm">
      {paused && <StatusMark tone="neutral">Paused</StatusMark>}
      <H className={cn('font-display font-semibold leading-tight tracking-tight text-foreground', headingLevel === 1 ? 'text-[1.75rem]' : 'text-xl')}>
        Stop automatic payments to {msp}?
      </H>
      {paused && <p className="text-sm leading-relaxed text-foreground/85">{`${partnerName || 'Your service provider'} has already paused your automatic payments. Stopping turns them off completely.`}</p>}
      {method && <SummaryList rows={[{ label: 'Payment method', value: savedMethodLabel(method) }]} />}
      <div className="space-y-2 text-sm leading-relaxed text-foreground/85">
        <p className="font-semibold text-foreground">If you stop:</p>
        <ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
          <li>Future invoices won't be charged automatically.</li>
          <li>Invoices already scheduled won't be charged. Please pay them from their emails.</li>
          {method && <li>{bank ? 'Your saved bank account will be removed.' : 'Your saved card will be removed.'}</li>}
          <li>A payment that has already started can't be stopped.{bank ? ' Bank payments that have started can take a few business days to finish.' : ''}</li>
        </ul>
        <p className="text-muted-foreground">{`To turn automatic payments back on later, ask ${msp} to send you a new setup link.`}</p>
      </div>
      {failed && (
        <Notice tone="destructive" title="We couldn't stop automatic payments">
          <p>{`Please try again. If it keeps happening, email ${msp}, and they can turn them off for you.`}</p>
        </Notice>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="button" className={cn(BTN_DANGER, BTN_BLOCK)} disabled={busy} onClick={() => void stop()} data-testid="autopay-stop-submit">
          {busy ? 'Stopping…' : 'Stop automatic payments'}
        </button>
        <button type="button" className={cn(BTN_SECONDARY, BTN_BLOCK)} disabled={busy} onClick={onKeep} data-testid="autopay-stop-keep">
          {paused ? 'Keep them paused' : 'Keep them on'}
        </button>
      </div>
    </div>
  );
}

export default StopAutopayConfirm;
