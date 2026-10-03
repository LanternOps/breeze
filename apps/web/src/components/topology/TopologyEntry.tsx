import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useHashState } from '../../lib/useHashState';
import { useOrgStore } from '../../stores/orgStore';
import { parseTopologyHash, writeTopologyHash } from './topologyHash';
import { topologyApi, topologyNodeListSchema, topologyRead, type TopologySettings } from './topologyApi';
import { clearTopologyPrefetch, prefetchTopologyGraph, prefetchTopologySettings, takePrefetchedSettings } from './topologyPrefetch';
import TopologyEmptyState from './TopologyEmptyState';
const loadExplorer = () => import('./TopologyExplorer');
const TopologyExplorer = lazy(loadExplorer);
/** A `#topology/site/<id>` link to a site missing from this organization's list (#7880). */
type LinkedSite = 'checking' | 'switching' | 'sameOrg' | 'missing';
export default function TopologyEntry({ siteId, sites = [], deviceId, assetId, legacy }: {
  siteId?: string | null; sites?: { id: string; name: string }[]; deviceId?: string; assetId?: string; legacy?: ReactNode;
}) {
  const { t } = useTranslation('topology');
  const [hashSite, setHashSite] = useHashState<string | undefined>(undefined, (hash) => parseTopologyHash(hash)?.siteId);
  // A linked site is shown only once this organization's list contains it: never fall back to another site (#7880).
  const linkedSite = !siteId && hashSite && !sites.some((site) => site.id === hashSite) ? hashSite : undefined;
  const selectedSite = siteId ?? (hashSite ? (linkedSite ? undefined : hashSite) : sites.length === 1 ? sites[0].id : undefined);
  const currentOrgId = useOrgStore((state) => state.currentOrgId);
  const [linked, setLinked] = useState<LinkedSite>();
  useEffect(() => clearTopologyPrefetch, [currentOrgId]);
  const [settings, setSettings] = useState<TopologySettings>(), [focus, setFocus] = useState<string>(), [error, setError] = useState<string>(), [bindingResolved, setBindingResolved] = useState(false);
  useEffect(() => {
    setLinked(undefined);
    if (!linkedSite) return;
    void loadExplorer().catch(() => undefined);
    const controller = new AbortController();
    setLinked('checking');
    // Follows the org-switch convention of the devices deep link (orgHash.ts): the server checks
    // access to the owning org, and only then does the selector move to it.
    void topologyApi.siteOwner(linkedSite, controller.signal).then((owner) => {
      if (controller.signal.aborted) return;
      const store = useOrgStore.getState();
      if (owner.orgId === store.currentOrgId) {
        // Usually the org's site list is just still loading: start this site's reads so they overlap it.
        // Nothing renders until the list contains the site.
        prefetchTopologySettings(linkedSite); prefetchTopologyGraph(linkedSite);
        setLinked('sameOrg'); return;
      }
      store.selectOrganization(owner.orgId); setLinked('switching');
    }).catch(() => { if (!controller.signal.aborted) setLinked('missing'); });
    return () => controller.abort();
  }, [linkedSite, currentOrgId]);
  useEffect(() => {
    setSettings(undefined); setFocus(undefined); setError(undefined); setBindingResolved(false);
    if (!selectedSite) return;
    // First commit: the hash is adopted by a layout effect whose re-render comes after this effect.
    // Do not start reads for the single-site fallback when the link names another site.
    const linkedNow = siteId ? undefined : parseTopologyHash(window.location.hash)?.siteId;
    if (linkedNow && linkedNow !== selectedSite) return;
    const controller = new AbortController();
    // Settings, the device/asset binding lookup, the first graph read and the explorer chunk are independent: start them together (#7880).
    const settingsRead = takePrefetchedSettings(selectedSite) ?? topologyApi.settings(selectedSite, controller.signal);
    const binding = deviceId || assetId
      ? topologyRead(`/topology/sites/${selectedSite}/nodes?${new URLSearchParams(deviceId ? { deviceId } : { assetId: assetId! })}`, topologyNodeListSchema, controller.signal)
      : undefined;
    binding?.catch(() => undefined); // Awaited below only when the explorer will use it.
    if (!binding) prefetchTopologyGraph(selectedSite);
    void loadExplorer().catch(() => undefined);
    void settingsRead.then(async (value) => {
      if (controller.signal.aborted) return;
      setSettings(value);
      if (value.capabilities.ui.available && binding) {
        const result = await binding;
        if (!controller.signal.aborted) setFocus(result.nodes[0]?.id);
      }
      if (!controller.signal.aborted) setBindingResolved(true);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('loadFailed')); });
    return () => controller.abort();
  }, [selectedSite, deviceId, assetId]);
  const notInOrganization = linked === 'missing' || (linked === 'sameOrg' && sites.length > 0);
  return <div className="space-y-4" data-testid="topology-entry">
    {!siteId && <label className="block text-sm">{t('site')}<select data-testid="topology-site" className="ml-3 rounded border bg-background p-2" value={selectedSite ?? ''} onChange={(event) => { setHashSite(event.target.value); writeTopologyHash({ siteId: event.target.value, view: 'overview', search: '' }); }}><option value="">{t('chooseSite')}</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>}
    {notInOrganization && <p role="alert" data-testid="topology-site-not-in-org" className="text-sm">{t('siteNotInOrganization')}</p>}
    {linked && !notInOrganization && <p role="status">{t('loading')}</p>}
    {!selectedSite && !linked && <p className="text-sm text-muted-foreground">{t('chooseSiteExplanation')}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {selectedSite && !settings && !error && <p role="status">{t('loading')}</p>}
    {settings && !settings.capabilities.ui.available && (legacy ?? <TopologyEmptyState reason={settings.capabilities.ui.reason} />)}
    {settings?.capabilities.ui.available && bindingResolved && selectedSite && <Suspense fallback={<p role="status">{t('loading')}</p>}><TopologyExplorer key={`${selectedSite}/${focus ?? ''}`} siteId={selectedSite} focusNodeId={focus} settings={settings} /></Suspense>}
  </div>;
}
