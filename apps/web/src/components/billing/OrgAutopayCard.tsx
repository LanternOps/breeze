import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '../../lib/runAction';
import { readAutopay, mutateAutopay, methodLabel, type AutopayRow } from './autopayClient';
export default function OrgAutopayCard({ orgId }: { orgId: string }) {
  const { t } = useTranslation('billing');
  const [row, setRow] = useState<AutopayRow | null>(null); const [error, setError] = useState(false);
  const [recipient, setRecipient] = useState(''); const [busy, setBusy] = useState(false);
  const [off, setOff] = useState(false); const [result, setResult] = useState('');
  const load = useCallback(async () => { try { setRow(await readAutopay(`/orgs/${orgId}/autopay`)); setError(false); }
    catch { setError(true); } }, [orgId]);
  useEffect(() => { setRow(null); setRecipient(''); void load(); }, [load]);
  async function act(action: 'request' | 'pause' | 'resume' | 'turn_off') {
    if (busy) return; setBusy(true);
    try {
      if (action === 'request') {
        const response = await mutateAutopay<{ requested: string[]; skipped: { orgId: string; reason: string }[] }>(
          '/billing/autopay/requests', { orgIds: [orgId], ...(recipient.trim() ? { recipientOverride: recipient.trim() } : {}) });
        setResult(response.skipped.map(item => item.reason).join(', ') || t('autopay.done'));
      } else { await mutateAutopay(`/orgs/${orgId}/autopay`, { action }, 'PATCH'); setResult(t('autopay.done')); }
      setOff(false); await load();
    } catch (e) { handleActionError(e, t('autopay.error')); } finally { setBusy(false); }
  }
  if (error) return <p data-testid="autopay-org-error" role="alert">{t('autopay.error')}</p>;
  if (!row) return <p>{t('autopay.loading')}</p>;
  const requested = row.status === 'requested'; const active = row.enrollment?.status === 'active';
  const canRequest = !active && row.enrollment?.status !== 'paused';
  const email = recipient.trim() || row.billingContact?.email || '';
  return <section data-testid="autopay-org-card" className="rounded-lg border bg-card p-6 space-y-3">
    <h2>{t('autopay.title')}</h2><p data-testid="autopay-status">{t(/* i18n-dynamic */ `autopay.status.${row.status}`)}</p>
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
    {result && <p role="status" data-testid="autopay-org-result">{result}</p>}
  </section>;
}
