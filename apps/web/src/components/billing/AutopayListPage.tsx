import { autopayReasonKey } from './autopayReason';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { handleActionError } from '../../lib/runAction';
import { readAutopay, mutateAutopay, methodLabel, skippedAutopayReason, type AutopayRow } from './autopayClient';
import { autopayButton } from './autopayUi';
import { PageHeader } from '../shared/PageHeader';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';
type Variant = 'row' | 'card';
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
  // Desktop row and phone card render the same facts and actions; card test ids carry "autopay-card-".
  const id = (variant: Variant, base: string) => variant === 'card' ? base.replace(/^autopay-/, 'autopay-card-') : base;
  const deliveryFailed = (row: AutopayRow) => row.requestNoticeStatus === 'failed' || row.requestNoticeStatus === 'handler_failed';
  const renderSelect = (row: AutopayRow, variant: Variant) => <input type="checkbox" aria-label={t('autopay.selectClient', { name: row.orgName })}
    data-testid={id(variant, `autopay-select-${row.orgId}`)} className="h-4 w-4"
    checked={selected.includes(row.orgId)} disabled={busy || row.enrollment?.status === 'active'}
    onChange={e => setSelected(current => e.target.checked ? [...current, row.orgId] : current.filter(orgId => orgId !== row.orgId))} />;
  const renderClient = (row: AutopayRow, variant: Variant) => <a data-testid={id(variant, `autopay-client-${row.orgId}`)}
    href={`/organizations/${row.orgId}#billing`} className="font-medium text-primary hover:underline">{row.orgName}</a>;
  const renderStatus = (row: AutopayRow, variant: Variant) => <>
    <span>{t(/* i18n-dynamic */ `autopay.status.${row.status}`)}</span>
    {deliveryFailed(row) && <p role="alert" data-testid={id(variant, `autopay-delivery-${row.orgId}`)} className="mt-1 text-amber-800 dark:text-amber-200">{t('autopay.requestDeliveryFailed')}</p>}
  </>;
  const renderResend = (row: AutopayRow, variant: Variant) => deliveryFailed(row) &&
    <button type="button" data-testid={id(variant, `autopay-resend-${row.orgId}`)} className={autopayButton.secondary} disabled={busy} onClick={() => void send([row.orgId])}>{t('autopay.resend')}</button>;
  const renderLastCharge = (row: AutopayRow) => row.lastCharge
    ? t(/* i18n-dynamic */ `autopay.attemptStates.${row.lastCharge.state}`, { defaultValue: row.lastCharge.state }) : t('autopay.noCharge');
  const renderAttention = (row: AutopayRow, variant: Variant) => row.awaitingNotice && row.awaitingNotice.count > 0 &&
    <a data-testid={variant === 'card' ? `autopay-card-notice-stuck-${row.orgId}` : 'autopay-notice-stuck'} href={`/billing/invoices/${row.awaitingNotice.invoiceId}`} className="text-primary hover:underline">
      <span>{t('autopay.noticeStuck')}</span>{row.awaitingNotice.reason && <>: {t(/* i18n-dynamic */ autopayReasonKey(row.awaitingNotice.reason),{nsSeparator:false})}</>}
    </a>;
  const th = 'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground';
  return <div data-testid="autopay-list" className="space-y-4">
    <PageHeader title={t('autopay.title')} headingTestId="autopay-heading"
      actions={<button type="button" data-testid="autopay-bulk-send" className={autopayButton.primary} disabled={busy || selected.length === 0} onClick={() => void send(selected)}>{t('autopay.request')}</button>} />
    {!dismissed && unasked.length > 0 && <aside data-testid="autopay-unasked" className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm">{t('autopay.unasked', { count: unasked.length })}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="autopay-send-now" className={autopayButton.primary} disabled={busy} onClick={() => void send(unasked.map(row => row.orgId))}>{t('autopay.sendNow')}</button>
        <button type="button" data-testid="autopay-dismiss" className={autopayButton.secondary} onClick={() => setDismissed(true)}>{t('autopay.dismiss')}</button>
      </div></aside>}
    {result && <section data-testid="autopay-bulk-result" role={result.skipped.length?'alert':'status'} className={`space-y-1 text-sm ${result.skipped.length?'text-amber-800 dark:text-amber-200':''}`}><p>{t('autopay.requestedCount', { count: result.requested.length })}</p>
      {result.skipped.map(item => <p key={item.orgId}>{rows.find(row => row.orgId === item.orgId)?.orgName ?? item.orgId}: {skippedAutopayReason(item.reason)}</p>)}</section>}
    {rows.length === 0 ? <p data-testid="autopay-empty" className="text-sm text-muted-foreground">{t('autopay.empty')}</p> : <ResponsiveTable
      table={<table data-testid="autopay-table" className="min-w-full divide-y text-sm">
        <thead className="bg-muted/40"><tr><th className={th}>{t('autopay.select')}</th><th className={th}>{t('autopay.client')}</th><th className={th}>{t('autopay.statusLabel')}</th>
          <th className={th}>{t('autopay.method')}</th><th className={th}>{t('autopay.lastCharge')}</th><th className={th}>{t('autopay.attention')}</th></tr></thead>
        <tbody className="divide-y">{rows.map(row => <tr data-testid={`autopay-row-${row.orgId}`} key={row.orgId} className="align-top">
          <td className="px-4 py-3">{renderSelect(row, 'row')}</td>
          <td className="px-4 py-3">{renderClient(row, 'row')}</td>
          <td className="px-4 py-3">{renderStatus(row, 'row')}{deliveryFailed(row) && <div className="mt-2">{renderResend(row, 'row')}</div>}</td>
          <td className="px-4 py-3">{methodLabel(row.method)}</td>
          <td className="px-4 py-3" data-testid="autopay-last-charge">{renderLastCharge(row)}</td>
          <td className="px-4 py-3">{renderAttention(row, 'row')}</td>
        </tr>)}</tbody></table>}
      cards={rows.map(row => <DataCard key={row.orgId}><div data-testid={`autopay-card-${row.orgId}`}>
        <div className="flex items-start gap-3">{renderSelect(row, 'card')}<div className="min-w-0 break-words">{renderClient(row, 'card')}</div></div>
        <div className="mt-3 space-y-2 border-t pt-3">
          <CardField label={t('autopay.statusLabel')}>{renderStatus(row, 'card')}</CardField>
          <CardField label={t('autopay.method')}>{methodLabel(row.method)}</CardField>
          <CardField label={t('autopay.lastCharge')}>{renderLastCharge(row)}</CardField>
          {row.awaitingNotice && row.awaitingNotice.count > 0 && <CardField label={t('autopay.attention')}>{renderAttention(row, 'card')}</CardField>}
        </div>
        {deliveryFailed(row) && <CardActions className="flex justify-end">{renderResend(row, 'card')}</CardActions>}
      </div></DataCard>)} />}
  </div>;
}
