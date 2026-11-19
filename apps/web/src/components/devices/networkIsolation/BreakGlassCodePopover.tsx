import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { formatDateTime } from '../../../lib/dateTimeFormat';
import ReleaseTokenTab from './ReleaseTokenTab';
import '../../../lib/i18n';

interface Codes { current: string; next: string; currentValidUntil: string }
interface Props { deviceId: string; isolationId: string; generation?: number; releaseTokenAvailable?: boolean; codesDisabled?: boolean }

/** Codes are deliberately fetched only by the explicit, audited view action. */
export default function BreakGlassCodePopover({ deviceId, isolationId, generation, releaseTokenAvailable, codesDisabled }: Props) {
  const { t } = useTranslation('devices');
  const [tab, setTab] = useState<'code' | 'token'>('code');
  const [codes, setCodes] = useState<Codes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    setCodes(null); setError(false); setBusy(false);
    return () => { request.current += 1; };
  }, [deviceId, isolationId, generation]);
  useEffect(() => {
    if (!codes) return;
    // Never refresh an audited code view automatically. Require a fresh click.
    const remaining = new Date(codes.currentValidUntil).getTime() - Date.now();
    const timer = setTimeout(() => setCodes(null), Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [codes]);
  async function toggle() {
    if (busy) return;
    if (codes) { setCodes(null); return; }
    const currentRequest = ++request.current;
    setBusy(true); setError(false);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/network-isolation/${isolationId}/break-glass-code`);
      if (!response.ok) throw new Error('code_unavailable');
      const result: Codes = await response.json();
      if (!result.current || !result.next || !Number.isFinite(new Date(result.currentValidUntil).getTime())) throw new Error('invalid_codes');
      if (request.current === currentRequest) setCodes(result);
    } catch {
      if (request.current === currentRequest) setError(true);
    } finally {
      if (request.current === currentRequest) setBusy(false);
    }
  }
  const tokenTab = <ReleaseTokenTab deviceId={deviceId} isolationId={isolationId} generation={generation} />;
  if (codesDisabled) {
    return <div className="relative space-y-2 text-sm">
      <p data-testid="isolation-codes-disabled-note" className="text-xs text-muted-foreground">{t('networkIsolation.codesDisabledNote')}</p>
      {tokenTab}
    </div>;
  }
  const codeView = <>
    <button type="button" data-testid="isolation-show-code" disabled={busy} aria-expanded={Boolean(codes)} onClick={() => void toggle()} className="rounded-md border px-3 py-1.5 hover:bg-muted disabled:opacity-50">
      {busy ? t('common:states.loading') : t(/* i18n-dynamic */ codes ? 'networkIsolation.hideCode' : 'networkIsolation.showCode')}
    </button>
    {error && <p role="alert" className="mt-2 text-destructive">{t('networkIsolation.codeError')}</p>}
    {codes && <div className="mt-2 space-y-2 rounded-md border bg-background p-3" data-testid="isolation-codes">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <dt>{t('networkIsolation.codeCurrent')}</dt><dd className="font-mono select-all">{codes.current}</dd>
        <dt>{t('networkIsolation.codeNext')}</dt><dd className="font-mono select-all">{codes.next}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">{t('networkIsolation.codeValidUntil', { date: formatDateTime(codes.currentValidUntil) })}</p>
    </div>}
  </>;
  if (!releaseTokenAvailable) return <div className="relative text-sm">{codeView}</div>;
  return <div className="relative space-y-2 text-sm">
    <div role="tablist" className="flex gap-1">
      <button type="button" role="tab" data-testid="isolation-tab-code" aria-selected={tab === 'code'} onClick={() => setTab('code')} className={`rounded-md border px-3 py-1 text-xs ${tab === 'code' ? 'bg-muted font-medium' : 'hover:bg-muted'}`}>{t('networkIsolation.tabCode')}</button>
      <button type="button" role="tab" data-testid="isolation-tab-token" aria-selected={tab === 'token'} onClick={() => setTab('token')} className={`rounded-md border px-3 py-1 text-xs ${tab === 'token' ? 'bg-muted font-medium' : 'hover:bg-muted'}`}>{t('networkIsolation.tabToken')}</button>
    </div>
    {tab === 'code' ? <div>{codeView}</div> : tokenTab}
  </div>;
}
