import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useHashState } from '../../lib/useHashState';
import { parseTopologyHash, writeTopologyHash } from './topologyHash';
import { topologyApi, topologyNodeListSchema, topologyRead, type TopologySettings } from './topologyApi';
const TopologyExplorer = lazy(() => import('./TopologyExplorer'));
export default function TopologyEntry({ siteId, sites = [], deviceId, assetId, legacy }: {
  siteId?: string | null; sites?: { id: string; name: string }[]; deviceId?: string; assetId?: string; legacy?: ReactNode;
}) {
  const { t } = useTranslation('topology');
  const [hashSite, setHashSite] = useHashState<string | undefined>(undefined, (hash) => parseTopologyHash(hash)?.siteId);
  const selectedSite = siteId ?? (sites.some((site) => site.id === hashSite) ? hashSite : sites.length === 1 ? sites[0].id : undefined);
  const [settings, setSettings] = useState<TopologySettings>(), [focus, setFocus] = useState<string>(), [error, setError] = useState<string>(), [bindingResolved, setBindingResolved] = useState(false);
  useEffect(() => {
    setSettings(undefined); setFocus(undefined); setError(undefined); setBindingResolved(false);
    if (!selectedSite) return;
    const controller = new AbortController();
    void topologyApi.settings(selectedSite, controller.signal).then(async (value) => {
      if (controller.signal.aborted) return;
      setSettings(value);
      if (value.capabilities.ui.available && (deviceId || assetId)) {
        const query = new URLSearchParams(deviceId ? { deviceId } : { assetId: assetId! });
        const result = await topologyRead(`/topology/sites/${selectedSite}/nodes?${query}`, topologyNodeListSchema, controller.signal);
        if (!controller.signal.aborted) setFocus(result.nodes[0]?.id);
      }
      if (!controller.signal.aborted) setBindingResolved(true);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('loadFailed')); });
    return () => controller.abort();
  }, [selectedSite, deviceId, assetId]);
  return <div className="space-y-4" data-testid="topology-entry">
    {!siteId && <label className="block text-sm">{t('site')}<select data-testid="topology-site" className="ml-3 rounded border bg-background p-2" value={selectedSite ?? ''} onChange={(event) => { setHashSite(event.target.value); writeTopologyHash({ siteId: event.target.value, view: 'overview', search: '' }); }}><option value="">{t('chooseSite')}</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>}
    {!selectedSite && <p className="text-sm text-muted-foreground">{t('chooseSiteExplanation')}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {selectedSite && !settings && !error && <p role="status">{t('loading')}</p>}
    {settings && !settings.capabilities.ui.available && (legacy ?? <p>{t('disabled')} · {settings.capabilities.ui.reason}</p>)}
    {settings?.capabilities.ui.available && bindingResolved && selectedSite && <Suspense fallback={<p role="status">{t('loading')}</p>}><TopologyExplorer key={`${selectedSite}/${focus ?? ''}`} siteId={selectedSite} focusNodeId={focus} settings={settings} /></Suspense>}
  </div>;
}
