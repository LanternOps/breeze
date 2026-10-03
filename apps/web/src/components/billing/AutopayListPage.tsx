import { autopayReasonKey } from './autopayReason';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '../../lib/runAction';
import { readAutopay, mutateAutopay, methodLabel, skippedAutopayReason, type AutopayRow } from './autopayClient';
export default function AutopayListPage() {
  const { t } = useTranslation('billing');
  const [rows, setRows] = useState<AutopayRow[]>([]); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false); const [selected, setSelected] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ requested: string[]; skipped: { orgId: string; reason: string }[] } | null>(null);
  const load = useCallback(async () => {
    try { const response = await readAutopay<{ data: AutopayRow[] }>('/billing/autopay'); setRows(response.data); setError(false); }
    catch { setError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function send(ids: string[]) {
    if (busy || !ids.length) return; setBusy(true);
    try { setResult(await mutateAutopay('/billing/autopay/requests', { orgIds: ids })); setSelected([]); await load(); }
    catch (e) { handleActionError(e, t('autopay.error')); } finally { setBusy(false); }
  }
  if (loading) return <p>{t('autopay.loading')}</p>;
  if (error) return <p data-testid="autopay-list-error" role="alert">{t('autopay.error')}</p>;
  const unasked = rows.filter(row => row.status === 'not_requested');
  return <main data-testid="autopay-list" className="space-y-4">
    <h1 data-testid="autopay-heading">{t('autopay.title')}</h1>
    {!dismissed && unasked.length > 0 && <aside data-testid="autopay-unasked"><p>{t('autopay.unasked', { count: unasked.length })}</p>
      <button data-testid="autopay-send-now" disabled={busy} onClick={() => void send(unasked.map(row => row.orgId))}>{t('autopay.sendNow')}</button>
      <button data-testid="autopay-dismiss" onClick={() => setDismissed(true)}>{t('autopay.dismiss')}</button></aside>}
    <button data-testid="autopay-bulk-send" disabled={busy || selected.length === 0} onClick={() => void send(selected)}>{t('autopay.request')}</button>
    <table data-testid="autopay-table"><thead><tr><th>{t('autopay.select')}</th><th>{t('autopay.client')}</th><th>{t('autopay.statusLabel')}</th><th>{t('autopay.method')}</th><th>{t('autopay.lastCharge')}</th><th>{t('autopay.attention')}</th></tr></thead>
      <tbody>{rows.map(row => <tr data-testid={`autopay-row-${row.orgId}`} key={row.orgId}>
        <td><input type="checkbox" aria-label={t('autopay.selectClient', { name: row.orgName })} data-testid={`autopay-select-${row.orgId}`}
          checked={selected.includes(row.orgId)} disabled={busy || row.enrollment?.status === 'active'}
          onChange={e => setSelected(current => e.target.checked ? [...current, row.orgId] : current.filter(id => id !== row.orgId))} /></td>
        <td><a data-testid={`autopay-client-${row.orgId}`} href={`/organizations/${row.orgId}#billing`}>{row.orgName}</a></td>
        <td>{t(/* i18n-dynamic */ `autopay.status.${row.status}`)}{(row.requestNoticeStatus==='failed'||row.requestNoticeStatus==='handler_failed')&&<div><p role="alert" data-testid={`autopay-delivery-${row.orgId}`} className="text-amber-800 dark:text-amber-200">{t('autopay.requestDeliveryFailed')}</p><button data-testid={`autopay-resend-${row.orgId}`} disabled={busy} onClick={()=>void send([row.orgId])}>{t('autopay.resend')}</button></div>}</td><td>{methodLabel(row.method)}</td>
        <td data-testid="autopay-last-charge">{row.lastCharge ? t(/* i18n-dynamic */ `autopay.attemptStates.${row.lastCharge.state}`, {defaultValue:row.lastCharge.state}) : t('autopay.noCharge')}</td>
        <td>{row.awaitingNotice && row.awaitingNotice.count > 0 && <a data-testid="autopay-notice-stuck" href={`/billing/invoices/${row.awaitingNotice.invoiceId}`}>
          <span>{t('autopay.noticeStuck')}</span>{row.awaitingNotice.reason && <>: {t(/* i18n-dynamic */ autopayReasonKey(row.awaitingNotice.reason),{nsSeparator:false})}</>}
        </a>}</td></tr>)}</tbody></table>
    {rows.length === 0 && <p data-testid="autopay-empty">{t('autopay.empty')}</p>}
    {result && <section data-testid="autopay-bulk-result" role={result.skipped.length?'alert':'status'} className={result.skipped.length?'text-amber-800 dark:text-amber-200':undefined}><p>{t('autopay.requestedCount', { count: result.requested.length })}</p>
      {result.skipped.map(item => <p key={item.orgId}>{rows.find(row => row.orgId === item.orgId)?.orgName ?? item.orgId}: {skippedAutopayReason(item.reason)}</p>)}</section>}
  </main>;
}
