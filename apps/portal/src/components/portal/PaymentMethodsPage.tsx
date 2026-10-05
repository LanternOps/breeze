import { useEffect, useState, type ReactNode } from 'react';
import { formatMonthYear, type AutopayEnrollmentView, type AutopayMethodView } from '@breeze/shared';
import { apiGet, apiPost } from '@/lib/api';
import { withBase } from '@/lib/basePath';
import { longDate } from '@/lib/format';
import { methodInSentence, savedMethodLabel, type AutopayPortalPage } from '@/lib/autopay';
import { cn } from '@/lib/utils';
import { BTN_BLOCK, BTN_PRIMARY, BTN_SECONDARY, LINK, Notice, PageHeader, StatusMark, TH, type MarkTone } from './ui';
import AutopaySetupPage from './AutopaySetupPage';
import { StopAutopayConfirm } from './autopay/StopAutopayConfirm';

type View = 'summary' | 'setup' | 'stop';
type Summary = { tone: MarkTone; label: string; lines: ReactNode[]; attention?: string;
  update?: { label: string; primary: boolean } | null };

function expiringSoon(method: AutopayMethodView): boolean {
  if (method.type !== 'card' || !method.cardExpMonth || !method.cardExpYear) return false;
  const end = Date.UTC(method.cardExpYear, method.cardExpMonth, 1);
  return end - Date.now() <= 30 * 86_400_000;
}

/** One summary per state: status mark, the facts, an attention line, and which action applies. */
function summarize(data: AutopayPortalPage, msp: string): Summary {
  const enrollment: AutopayEnrollmentView | null = data.enrollment;
  const method = data.method;
  const status = enrollment?.status;
  const canUpdate = !data.stopOnly && (status === 'active' || status === 'requested');
  const reason = status === 'cancelled' ? null : enrollment?.needsAttentionReason ?? null;
  const methodLines: ReactNode[] = [];
  if (method) {
    methodLines.push(<p key="method" className="text-base font-semibold text-foreground" data-testid="autopay-saved-method">{savedMethodLabel(method)}</p>);
    // The bank's own name as Stripe reports it, shown as a quiet second line.
    const bankName = method.type === 'us_bank_account' ? method.bankName : null;
    if (bankName) methodLines.push(<p key="bank" className="text-sm text-muted-foreground">{bankName}</p>);
    const expiry = formatMonthYear(method.cardExpMonth, method.cardExpYear);
    if (expiry) {
      methodLines.push(expiringSoon(method)
        ? <p key="exp" className="text-sm font-medium text-warning-on-tint">{`Expires ${expiry}: update it soon`}</p>
        : <p key="exp" className="text-sm text-muted-foreground">{`Expires ${expiry}`}</p>);
    }
  }
  if (!enrollment) {
    return { tone: 'neutral', label: 'Not set up', update: null, lines: [
      <p key="a">{`${msp} hasn't set up automatic payments for your account. You can pay each invoice from its email or from `}<a className={LINK} href={withBase('/invoices')}>Invoices</a>.</p>,
      <p key="b" className="text-muted-foreground">{`Want automatic payments? Ask ${msp} to send you a setup link.`}</p>] };
  }
  if (status === 'cancelled') {
    const when = enrollment.cancelledAt ? ` on ${longDate(enrollment.cancelledAt)}` : '';
    return { tone: 'neutral', label: 'Off', update: null, lines: [
      <p key="a">{enrollment.cancelSource === 'client' ? `You stopped automatic payments${when}.`
        : enrollment.cancelSource === 'msp' ? `${msp} turned off automatic payments${when}.` : `Automatic payments are off${when ? ` since ${longDate(enrollment.cancelledAt)}` : ''}.`}</p>,
      <p key="b" className="text-muted-foreground">{`To turn them back on, ask ${msp} to send you a new setup link.`}</p>] };
  }
  if (reason === 'stripe_account_changed' || reason === 'key_missing_permissions') {
    return { tone: 'neutral', label: 'On hold', update: null, lines: methodLines,
      attention: `${msp} is updating its payment settings, so automatic payments are on hold. You don't need to do anything. Please pay invoices from their emails meanwhile.` };
  }
  if (reason === 'method_unusable' || reason === 'verification_failed') {
    const what = reason === 'verification_failed'
      ? `We couldn't verify your ${method ? methodInSentence(savedMethodLabel(method)) : 'bank account'}. Add it again, or choose a card.`
      : 'This payment method can\'t be charged any more. Add a new card or bank account so future invoices can be paid automatically. Invoices due meanwhile need to be paid from their emails.';
    return { tone: 'warning', label: 'Needs attention', lines: method?.status === 'unusable' || reason === 'verification_failed' ? methodLines : [],
      attention: canUpdate ? what : `${what.split('. ')[0]}. Contact ${msp} to update it.`,
      update: canUpdate ? { label: 'Update payment method', primary: true } : null };
  }
  if (status === 'paused') {
    const when = enrollment.pausedAt ? ` on ${longDate(enrollment.pausedAt)}` : '';
    return { tone: 'neutral', label: 'Paused', update: null, lines: [...methodLines,
      <p key="p">{`${msp} paused automatic payments${when}. Nothing is charged automatically while they're paused. Please pay invoices from their emails or from Invoices.`}</p>] };
  }
  if (status === 'requested' && !method) {
    return { tone: 'warning', label: 'Waiting for you', lines: [
      <p key="a">{`${msp} asked you to set up automatic payments. Choose a bank account or card, and future invoices are paid on schedule.`}</p>],
      update: canUpdate ? { label: 'Set up automatic payments', primary: true } : null };
  }
  if (method?.status === 'pending_verification') {
    return { tone: 'warning', label: 'Verify your bank', lines: [...methodLines,
      <p key="v">Stripe will email you instructions to verify this account, usually within 1–2 business days. No automatic payments are made until it's verified. You can still pay any invoice from its email.</p>],
      update: canUpdate ? { label: 'Use a different method', primary: false } : null };
  }
  return { tone: 'success', label: 'On', lines: [...methodLines,
    ...(enrollment.effectiveFrom ? [<p key="since" className="text-sm text-muted-foreground">{`On since ${longDate(enrollment.effectiveFrom)}`}</p>] : []),
    <p key="notice">We email you the amount and date before each payment.</p>,
    ...(data.stopOnly ? [<p key="off" className="text-muted-foreground">Changing your payment method isn't available right now.</p>] : [])],
    update: canUpdate ? { label: 'Change payment method', primary: false } : null };
}

/**
 * Portal Payment methods: whether automatic payments are on, with what, and the one
 * action that applies (set up, change, update, or stop). Inline forms, no modals.
 * Renders inside PortalLayout's <main> and sheet, so it never renders its own.
 */
export default function PaymentMethodsPage() {
  const [data, setData] = useState<AutopayPortalPage | null>(null);
  const [error, setError] = useState(false);
  const [view, setView] = useState<View>('summary');
  const [refresh, setRefresh] = useState(0);
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    let current = true;
    void apiGet<AutopayPortalPage>('/portal/payment-methods').then(result => {
      if (!current) return;
      if (result.data) { setData(result.data); setError(false); } else if (!stopped) setError(true);
    }).catch(() => { if (current && !stopped) setError(true); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const msp = data?.partnerName || 'Your service provider';
  const header = <PageHeader title="Payment methods" lede={`How ${data?.partnerName || 'your service provider'} collects payment for your invoices.`} />;
  if (error && !data) {
    return <div data-testid="autopay-payment-methods-page">{header}
      <Notice tone="destructive" title="We couldn't load your payment details." data-testid="autopay-payment-methods-error"
        action={<button type="button" className={BTN_SECONDARY} onClick={() => window.location.reload()}>Refresh</button>}>
        <p>Please refresh in a moment. Nothing about your payments has changed.</p>
      </Notice>
    </div>;
  }
  if (!data) return <div>{header}<p className="text-sm text-muted-foreground" aria-busy="true">Loading your payment details…</p></div>;

  const summary = summarize(data, msp);
  const status = data.enrollment?.status;
  const canStop = !!data.enrollment && status !== 'cancelled' && !(status === 'requested' && !data.method);
  const stop = async () => {
    const result = await apiPost('/portal/autopay/stop', {}, { redirectOnUnauthorized: true });
    if (!result.data || result.error || (result.statusCode ?? 200) >= 400) return false;
    setStopped(true); setView('summary');
    setData(prev => prev && { ...prev, enrollment: prev.enrollment && { ...prev.enrollment, status: 'cancelled', cancelSource: 'client', cancelledAt: new Date().toISOString() }, method: null });
    if (!data.stopOnly) setRefresh(value => value + 1);
    return true;
  };

  return (
    <div className="space-y-6" data-testid="autopay-payment-methods">
      {header}
      {stopped && (
        <Notice tone="neutral" title="Automatic payments are off." data-testid="autopay-stop-feedback">
          <p>We're emailing you a confirmation. If a bank payment had already started, it may still complete.</p>
        </Notice>
      )}
      {view === 'setup' && !data.stopOnly ? <AutopaySetupPage portal onCancel={() => setView('summary')} />
        : view === 'stop' ? <StopAutopayConfirm partnerName={data.partnerName} enrollment={data.enrollment} method={data.method}
          onStop={stop} onKeep={() => setView('summary')} headingLevel={2} />
        : <section aria-labelledby="autopay-section" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-2.5">
            <h2 id="autopay-section" className={cn(TH, 'p-0')}>Automatic payments</h2>
            <StatusMark tone={summary.tone} data-testid="autopay-status">{summary.label}</StatusMark>
          </div>
          <div className="space-y-4 sm:flex sm:items-start sm:justify-between sm:gap-8 sm:space-y-0">
            <div className="min-w-0 space-y-1.5 text-sm leading-relaxed text-foreground/85">
              {summary.lines}
              {summary.attention && (
                <p role="status" data-testid="autopay-needs-attention"
                  className={cn('pt-1 font-medium', summary.tone === 'warning' ? 'text-warning-on-tint' : 'text-foreground')}>{summary.attention}</p>
              )}
            </div>
            {summary.update && (
              <button type="button" data-testid="autopay-update-method" onClick={() => setView('setup')}
                className={cn(summary.update.primary ? BTN_PRIMARY : BTN_SECONDARY, BTN_BLOCK, 'shrink-0')}>
                {summary.update.label}
              </button>
            )}
          </div>
          {canStop && (
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border/70 pt-3 text-sm">
              <button type="button" className={LINK} data-testid="autopay-portal-stop" onClick={() => setView('stop')}>Stop automatic payments</button>
              <span className="text-muted-foreground">Future invoices won't be charged automatically.</span>
            </div>
          )}
        </section>}
    </div>
  );
}
