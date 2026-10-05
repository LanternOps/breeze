import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '../../lib/runAction';
import { formatDateTime } from '../../lib/dateTimeFormat';
import { readAutopay, mutateAutopay, methodLabel, needsAttentionReason, skippedAutopayReason, type AutopayRow } from './autopayClient';
const actionResults = { pause: 'autopay.result.paused', resume: 'autopay.result.resumed', turn_off: 'autopay.result.turnedOff' } as const;
const primaryButton = 'rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50';
const secondaryButton = 'rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50';
export default function OrgAutopayCard({ orgId }: { orgId: string }) {
  // A new organization gets fresh state, including confirmations and action results.
  return <OrgAutopayCardContent key={orgId} orgId={orgId} />;
}
function OrgAutopayCardContent({ orgId }: { orgId: string }) {
  const generation = useRef(0);
  const { t } = useTranslation('billing');
  const [row, setRow] = useState<AutopayRow | null>(null); const [error, setError] = useState(false);
  const [recipient, setRecipient] = useState(''); const [busy, setBusy] = useState(false);
  const [warning,setWarning]=useState(false);
  const [off, setOff] = useState(false); const [result, setResult] = useState('');
  const load = useCallback(async () => {
    const current = generation.current;
    try {
      const next = await readAutopay<AutopayRow>(`/orgs/${orgId}/autopay`);
      if (current !== generation.current) return;
      setRow(next); setError(false);
    } catch {
      if (current === generation.current) setError(true);
    }
  }, [orgId]);
  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);
  async function act(action: 'request' | 'pause' | 'resume' | 'turn_off') {
    if (busy) return; setBusy(true);
    const current = generation.current;
    try {
      if (action === 'request') {
        const sentTo = t('autopay.requestSentTo', { email: recipient.trim() || row?.billingContact?.email?.trim() || '' });
        const response = await mutateAutopay<{ requested: string[]; skipped: { orgId: string; reason: string }[] }>(
          '/billing/autopay/requests', { orgIds: [orgId], ...(recipient.trim() ? { recipientOverride: recipient.trim() } : {}) }, 'POST', sentTo);
        if (current !== generation.current) return;
        setWarning(response.skipped.length>0);
        setResult(response.skipped.map(item => skippedAutopayReason(item.reason)).join(', ') || sentTo);
      } else {
        const done = t(/* i18n-dynamic */ actionResults[action]);
        await mutateAutopay(`/orgs/${orgId}/autopay`, { action }, 'PATCH', done);
        if (current !== generation.current) return;
        setWarning(false);setResult(done);
      }
      setOff(false); await load();
    } catch (e) {
      if (current === generation.current) handleActionError(e, t('autopay.error'));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  if (error) return <p data-testid="autopay-org-error" role="alert">{t('autopay.error')}</p>;
  if (!row) return <p>{t('autopay.loading')}</p>;
  const requested = row.status === 'requested'; const active = row.enrollment?.status === 'active';
  const canRequest = !active && row.enrollment?.status !== 'paused';
  const email = recipient.trim() || row.billingContact?.email || '';
  const effectiveFrom = row.enrollment?.effectiveFrom;
  return <section data-testid="autopay-org-card" className="space-y-3 rounded-lg border bg-card p-6">
    <h2 className="text-lg font-semibold">{t('autopay.enrollmentTitle')}</h2>
    <p data-testid="autopay-status" className="text-sm font-medium">{t(/* i18n-dynamic */ `autopay.status.${row.status}`)}</p>
    {(row.requestNoticeStatus==='failed'||row.requestNoticeStatus==='handler_failed')&&<p role="alert" data-testid="autopay-request-delivery" className="text-sm text-amber-800 dark:text-amber-200">{t('autopay.requestDeliveryFailed')}</p>}
    {row.method && <p className="text-sm">{methodLabel(row.method)}</p>}
    {row.method?.status === 'pending_verification' && <p className="text-sm">{t('autopay.pending')}</p>}
    {effectiveFrom && <p data-testid="autopay-effective" className="text-sm text-muted-foreground">
      {t('autopay.effective', { date: formatDateTime(effectiveFrom, { dateStyle: 'medium', timeStyle: 'short' }) })}</p>}
    {row.enrollment?.needsAttentionReason && <p role="alert" data-testid="autopay-attention-reason" className="text-sm text-amber-800 dark:text-amber-200">
      {needsAttentionReason(row.enrollment.needsAttentionReason)}</p>}
    {!row.stripeReadiness?.ready && <p role="alert" data-testid="autopay-stripe-not-ready" className="text-sm text-amber-800 dark:text-amber-200">{t('autopay.stripeNotReady', {permissions:row.stripeReadiness?.missing.join(', ') || t('autopay.stripeDisconnected')})}</p>}
    {canRequest && <label className="block text-sm font-medium">{t('autopay.recipient')}<input data-testid="autopay-recipient" type="email" value={recipient}
      className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm font-normal"
      placeholder={row.billingContact?.email ?? ''} onChange={e => setRecipient(e.target.value)} /></label>}
    <div className="flex flex-wrap gap-2">
      {canRequest && <button type="button" data-testid="autopay-request" className={primaryButton} disabled={busy || !row.stripeReadiness?.ready || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={() => void act('request')}>
        {t(/* i18n-dynamic */ requested ? 'autopay.resend' : 'autopay.request')}</button>}
      {active && <button type="button" data-testid="autopay-pause" className={secondaryButton} disabled={busy} onClick={() => void act('pause')}>{t('autopay.pause')}</button>}
      {row.enrollment?.status === 'paused' && <button type="button" data-testid="autopay-resume" className={primaryButton} disabled={busy} onClick={() => void act('resume')}>{t('autopay.resume')}</button>}
      {row.enrollment && row.enrollment.status !== 'cancelled' && <button type="button" data-testid="autopay-turn-off" className={secondaryButton} disabled={busy} onClick={() => setOff(true)}>{t('autopay.turnOff')}</button>}
    </div>
    {off && <div data-testid="autopay-off-confirm" className="space-y-2 rounded-md border p-3"><p className="text-sm">{t('autopay.processingWarning')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="autopay-off-confirm-submit" className="rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={() => void act('turn_off')}>{t('autopay.turnOff')}</button>
        <button type="button" data-testid="autopay-off-cancel" className={secondaryButton} onClick={() => setOff(false)}>{t('autopay.cancel')}</button>
      </div></div>}
    {result && <p role={warning?'alert':'status'} className={warning?'text-sm text-amber-800 dark:text-amber-200':'text-sm'} data-testid="autopay-org-result">{result}</p>}
  </section>;
}
