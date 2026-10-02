import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '../../lib/runAction';
import { readAutopay, mutateAutopay, methodLabel, skippedAutopayReason, type AutopayRow } from './autopayClient';
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
        const response = await mutateAutopay<{ requested: string[]; skipped: { orgId: string; reason: string }[] }>(
          '/billing/autopay/requests', { orgIds: [orgId], ...(recipient.trim() ? { recipientOverride: recipient.trim() } : {}) });
        if (current !== generation.current) return;
        setWarning(response.skipped.length>0);
        setResult(response.skipped.map(item => skippedAutopayReason(item.reason)).join(', ') || t('autopay.done'));
      } else {
        await mutateAutopay(`/orgs/${orgId}/autopay`, { action }, 'PATCH');
        if (current !== generation.current) return;
        setWarning(false);setResult(t('autopay.done'));
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
  return <section data-testid="autopay-org-card" className="rounded-lg border bg-card p-6 space-y-3">
    <h2>{t('autopay.title')}</h2><p data-testid="autopay-status">{t(/* i18n-dynamic */ `autopay.status.${row.status}`)}</p>
    {(row.requestNoticeStatus==='failed'||row.requestNoticeStatus==='handler_failed')&&<p role="alert" data-testid="autopay-request-delivery" className="text-amber-800 dark:text-amber-200">{t('autopay.requestDeliveryFailed')}</p>}
    <p>{methodLabel(row.method)}</p>
    {row.method?.status === 'pending_verification' && <p>{t('autopay.pending')}</p>}
    <p>{t('autopay.effective', { date: row.enrollment?.effectiveFrom ?? '—' })}</p>
    {row.enrollment?.needsAttentionReason && <p role="alert">{row.enrollment.needsAttentionReason}</p>}
    {!row.stripeReadiness?.ready && <p role="alert" data-testid="autopay-stripe-not-ready">{t('autopay.stripeNotReady', {permissions:row.stripeReadiness?.missing.join(', ') || t('autopay.stripeDisconnected')})}</p>}
    {canRequest && <><label>{t('autopay.recipient')}<input data-testid="autopay-recipient" type="email" value={recipient}
      placeholder={row.billingContact?.email ?? ''} onChange={e => setRecipient(e.target.value)} /></label>
      <button data-testid="autopay-request" disabled={busy || !row.stripeReadiness?.ready || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={() => void act('request')}>
        {t(/* i18n-dynamic */ requested ? 'autopay.resend' : 'autopay.request')}</button></>}
    {active && <button data-testid="autopay-pause" disabled={busy} onClick={() => void act('pause')}>{t('autopay.pause')}</button>}
    {row.enrollment?.status === 'paused' && <button data-testid="autopay-resume" disabled={busy} onClick={() => void act('resume')}>{t('autopay.resume')}</button>}
    {row.enrollment && row.enrollment.status !== 'cancelled' && <button data-testid="autopay-turn-off" disabled={busy} onClick={() => setOff(true)}>{t('autopay.turnOff')}</button>}
    {off && <div data-testid="autopay-off-confirm"><p>{t('autopay.processingWarning')}</p>
      <button data-testid="autopay-off-confirm-submit" disabled={busy} onClick={() => void act('turn_off')}>{t('autopay.turnOff')}</button>
      <button data-testid="autopay-off-cancel" onClick={() => setOff(false)}>{t('autopay.cancel')}</button></div>}
    {result && <p role={warning?'alert':'status'} className={warning?'text-amber-800 dark:text-amber-200':undefined} data-testid="autopay-org-result">{result}</p>}
  </section>;
}
