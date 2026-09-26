import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';

export type NetworkAsset = {
  id: string;
  label: string | null;
  hostname: string | null;
  ipAddress: string | null;
};

export function bindNetworkAsset(condition: Record<string, unknown>, asset: NetworkAsset | null): Record<string, unknown> {
  const { assetId: _old, ...rest } = condition;
  // Keep API-only options such as headers and packetSize when changing binding.
  return asset ? { ...rest, assetId: asset.id, target: asset.ipAddress ?? asset.hostname ?? rest.target } : rest;
}

export default function NetworkCheckAssetBinding({ orgId, assetId, onSelect }: {
  orgId: string | null;
  assetId: string | null;
  onSelect: (asset: NetworkAsset | null) => void;
}) {
  const { t } = useTranslation('monitoring');
  const [assets, setAssets] = useState<NetworkAsset[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setAssets([]);
    setStatus('loading');
    if (!orgId) { setStatus('ready'); return; }
    void (async () => {
      try {
        const res = await fetchWithAuth(`/discovery/assets?orgId=${encodeURIComponent(orgId)}`);
        if (!res.ok) throw new Error('asset_read_failed');
        const body = await res.json();
        if (!Array.isArray(body.data)) throw new Error('asset_response_invalid');
        if (!cancelled) { setAssets(body.data); setStatus('ready'); }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, attempt]);

  return <div data-testid="network-check-asset-binding" className="space-y-2">
    <label htmlFor="network-check-asset-picker" className="text-sm font-medium">{t('editor.networkCheckAsset.label')}</label>
    <select id="network-check-asset-picker" data-testid="network-check-asset-picker"
      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
      value={assetId ?? ''} disabled={!orgId || status !== 'ready'}
      onChange={e => onSelect(assets.find(a => a.id === e.target.value) ?? null)}>
      <option value="">{t('editor.networkCheckAsset.unbound')}</option>
      {assetId && !assets.some(a => a.id === assetId) && <option value={assetId}>{assetId}</option>}
      {assets.map(a => <option key={a.id} value={a.id}>{a.label ?? a.hostname ?? a.ipAddress ?? a.id}</option>)}
    </select>
    {status === 'error' && <p role="alert" className="text-sm text-destructive">{t('editor.networkCheckAsset.failed')}{' '}
      <button type="button" className="underline" onClick={() => setAttempt(v => v + 1)}>{t('common:actions.retry')}</button>
    </p>}
    {!orgId && <p className="text-sm text-muted-foreground">{t('editor.networkCheckAsset.orgRequired')}</p>}
  </div>;
}
