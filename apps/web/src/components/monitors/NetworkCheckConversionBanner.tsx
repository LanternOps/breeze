import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { conversionFriendly, conversionPaths, retireBody } from '../monitoring/conversion/conversionApi';
import ConversionLedger from '../monitoring/conversion/ConversionLedger';

type Item = { sourceId: string; name: string; outcome: 'convertible' | 'unconvertible'; reason?: string; notes: string[]; openAlerts: number };
type Preview = { orgId: string; previewHash: string; blockedBy?: 'prerequisite_missing'; items: Item[] };

export default function NetworkCheckConversionBanner({ orgId, onConverted }: { orgId: string; onConverted: () => void }) {
  const { t } = useTranslation(['common', 'monitoring']);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ledgerRevision, setLedgerRevision] = useState(0);
  const generation = useRef(0);
  const acting = useRef(false);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(false);
    setPreview(null);
    try {
      const response = await fetchWithAuth(`/monitor-definitions/conversion/network-checks?orgId=${encodeURIComponent(orgId)}`);
      if (!response.ok) throw new Error('preview_failed');
      const next = await response.json() as Preview;
      if (current === generation.current) setPreview(next);
    } catch {
      if (current === generation.current) setError(true);
    }
  }, [orgId]);
  useEffect(() => {
    setOpen(false);
    void load();
    return () => { generation.current++; };
  }, [load]);

  const convertible = preview?.items.filter(item => item.outcome === 'convertible') ?? [];
  const refresh = async () => {
    setLedgerRevision(value => value + 1);
    onConverted();
    await load();
  };
  const handleFailure = (err: unknown, fallback: string) => {
    if (err instanceof ActionError && err.status === 401) return;
    if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
    void load();
  };
  const convert = async () => {
    if (!preview || preview.blockedBy || acting.current || convertible.length === 0) return;
    acting.current = true;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/monitor-definitions/conversion/network-checks/convert', {
          method: 'POST', body: JSON.stringify({ orgId, previewHash: preview.previewHash }),
        }),
        friendly: conversionFriendly,
        successMessage: t('longTail.monitors.NetworkCheckConversionBanner.converted', { count: convertible.length }),
        errorFallback: t('longTail.monitors.NetworkCheckConversionBanner.failed'),
      });
      setOpen(false);
      await refresh();
    } catch (err) {
      handleFailure(err, t('longTail.monitors.NetworkCheckConversionBanner.failed'));
    } finally { acting.current = false; setBusy(false); }
  };
  const retire = async (item: Item) => {
    if (!preview || preview.blockedBy || acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(conversionPaths.retire(), {
          method: 'POST', body: JSON.stringify(retireBody('network_monitors', item.sourceId, 'operator')),
        }),
        friendly: conversionFriendly,
        successMessage: t('monitoring:conversion.retired', { name: item.name }),
        errorFallback: t('monitoring:conversion.errors.retire'),
      });
      await refresh();
    } catch (err) {
      handleFailure(err, t('monitoring:conversion.errors.retire'));
    } finally { acting.current = false; setBusy(false); }
  };

  return <>
    {error && <div role="alert" data-testid="network-check-conversion-error" className="rounded-md border border-destructive/40 p-3 text-sm">
      {t('monitoring:conversion.errors.preview')}
      <button type="button" onClick={() => void load()} className="ml-2 underline">{t('common:actions.retry')}</button>
    </div>}
    {preview?.blockedBy && <p role="alert" data-testid="network-check-conversion-blocked">{t('monitoring:conversion.blocked.prerequisite_missing')}</p>}
    {preview && !preview.blockedBy && preview.items.length > 0 && <div data-testid="network-check-conversion-banner" className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
      <span>{t('longTail.monitors.NetworkCheckConversionBanner.pending', { count: preview.items.length })}</span>
      <button type="button" data-testid="network-check-conversion-review" onClick={() => setOpen(true)} className="rounded-md border px-3 py-1.5 font-medium hover:bg-muted">{t('longTail.monitors.NetworkCheckConversionBanner.review')}</button>
      <Dialog open={open} onClose={() => { if (!busy) setOpen(false); }} title={t('longTail.monitors.NetworkCheckConversionBanner.title')} maxWidth="2xl" className="p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('longTail.monitors.NetworkCheckConversionBanner.title')}</h2>
        <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">
          {preview.items.map(item => <li key={item.sourceId} data-testid={`network-check-conversion-item-${item.outcome}`} className="rounded-md border px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{item.name}</span>
              <span className={item.outcome === 'convertible' ? 'text-success' : 'text-destructive'}>{t(/* i18n-dynamic */ `longTail.monitors.NetworkCheckConversionBanner.outcome.${item.outcome}`)}</span>
            </div>
            {item.reason && <p className="mt-1 break-words text-xs text-destructive">{item.reason}</p>}
            {item.notes.map((note, index) => <p key={index} className="mt-1 text-xs text-muted-foreground">{note}</p>)}
            <button type="button" data-testid={`network-check-retire-${item.sourceId}`} disabled={busy} onClick={() => void retire(item)} className="mt-2 rounded-md border px-3 py-1.5 hover:bg-muted disabled:opacity-60">{t('monitoring:conversion.retire')}</button>
          </li>)}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => setOpen(false)} className="h-9 rounded-md border px-4 text-sm">{t('common:actions.cancel')}</button>
          <button type="button" data-testid="network-check-conversion-confirm" disabled={busy || convertible.length === 0} onClick={() => void convert()} className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60">{t('longTail.monitors.NetworkCheckConversionBanner.convert', { count: convertible.length })}</button>
        </div>
      </Dialog>
    </div>}
    <ConversionLedger orgId={orgId} revision={ledgerRevision} onChanged={() => void refresh()} />
  </>;
}
