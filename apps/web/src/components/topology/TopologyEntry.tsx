import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useHashState } from '../../lib/useHashState';
import { formatTopologyHash, parseTopologyHash, writeTopologyHash } from './topologyHash';
import { topologyApi, topologyNodeListSchema, topologyRead, TopologyReadError, type TopologySettings } from './topologyApi';
import { clearTopologyPrefetch, prefetchTopologyGraph, prefetchTopologySettings, takePrefetchedSettings } from './topologyPrefetch';
import TopologyEmptyState from './TopologyEmptyState';
const loadExplorer = () => import('./TopologyExplorer');
const TopologyExplorer = lazy(loadExplorer);
/** A `#topology/site/<id>` link to a site missing from this organization's list (#7880). */
type LinkedSite = 'checking' | 'switching' | 'sameOrg' | 'missing' | 'failed';
/**
 * The organization selector, passed by a caller that lists `sites` (DiscoveryPage). Passed in rather
 * than read from the org store so this component stays free of store wiring for site-bound callers.
 */
export type TopologyOrganization = { currentOrgId: string | null; selectOrganization: (orgId: string) => void };
export default function TopologyEntry({ siteId, sites = [], deviceId, assetId, legacy, organization }: {
  siteId?: string | null; sites?: { id: string; name: string }[]; deviceId?: string; assetId?: string; legacy?: ReactNode; organization?: TopologyOrganization;
}) {
  const { t } = useTranslation('topology');
  const [hashSite, setHashSite] = useHashState<string | undefined>(undefined, (hash) => parseTopologyHash(hash)?.siteId);
  // A linked site is shown only once this organization's list contains it: never fall back to another site (#7880).
  const linkedSite = !siteId && hashSite && !sites.some((site) => site.id === hashSite) ? hashSite : undefined;
  const selectedSite = siteId ?? (hashSite ? (linkedSite ? undefined : hashSite) : sites.length === 1 ? sites[0].id : undefined);
  const currentOrgId = organization?.currentOrgId ?? null;
  const organizationRef = useRef(organization); organizationRef.current = organization;
  const [linked, setLinked] = useState<LinkedSite>();
  /**
   * The organization the site the hash names belongs with: the org its owner lookup started in, then the owner
   * the lookup returned, or the current org when its list contains the site (the store empties `sites` in the
   * same update that changes the org, so a non-empty list belongs to `currentOrgId`). A link is applied once
   * (#8113): when the selector later moves away from this organization, that was the user (the header switcher
   * re-navigates the page, applyOrgSwitch), so the link is dropped instead of re-resolved and switched back.
   * A lookup that started with no org selected yet (fresh session) is not pinned: the store selecting its first
   * org is not a user switch.
   */
  const linkOwner = useRef<{ siteId: string; orgId: string | null } | undefined>(undefined);
  if (!siteId && hashSite && currentOrgId && sites.some((site) => site.id === hashSite)) linkOwner.current = { siteId: hashSite, orgId: currentOrgId };
  useEffect(() => clearTopologyPrefetch, [currentOrgId]);
  const [settings, setSettings] = useState<TopologySettings>(), [focus, setFocus] = useState<string>(), [error, setError] = useState<string>(), [bindingResolved, setBindingResolved] = useState(false);
  useEffect(() => {
    setLinked(undefined);
    if (!linkedSite) return;
    const known = linkOwner.current;
    if (known?.siteId === linkedSite && known.orgId !== null && known.orgId !== currentOrgId) {
      // The user switched organization after the link was applied: the explicit switch wins (#8113). Moving the
      // selector back here is the snap-back. Drop the site from the hash (no history entry: Back must not
      // re-open the link either) and keep the view, so the new organization's sites load as usual.
      linkOwner.current = undefined;
      const view = parseTopologyHash(window.location.hash)?.view ?? 'overview';
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${formatTopologyHash({ view, search: '' })}`);
      setHashSite(undefined);
      return;
    }
    void loadExplorer().catch(() => undefined);
    const controller = new AbortController();
    // Pinned before the answer arrives: a switch while the lookup is in flight is the user's too (#8113 review).
    if (organizationRef.current) linkOwner.current = { siteId: linkedSite, orgId: currentOrgId };
    setLinked('checking');
    // Follows the org-switch convention of the devices deep link (orgHash.ts): the server checks
    // access to the owning org, and only then does the selector move to it.
    void topologyApi.siteOwner(linkedSite, controller.signal).then((owner) => {
      if (controller.signal.aborted) return;
      const org = organizationRef.current;
      if (org) linkOwner.current = { siteId: linkedSite, orgId: owner.orgId };
      if (owner.orgId === (org?.currentOrgId ?? null)) {
        // Usually the org's site list is just still loading: start this site's reads so they overlap it.
        // Nothing renders until the list contains the site.
        prefetchTopologySettings(linkedSite); prefetchTopologyGraph(linkedSite);
        setLinked('sameOrg'); return;
      }
      // Without a selector to move, a site owned by another organization cannot be shown here.
      if (!org) { setLinked('missing'); return; }
      org.selectOrganization(owner.orgId); setLinked('switching');
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      // Only "no such site / no access" means not in this organization; anything else is a load failure.
      setLinked(cause instanceof TopologyReadError && [403, 404].includes(cause.status) ? 'missing' : 'failed');
    });
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
  // The site select lives in ONE place for the entry's whole life: the entry's own toolbar row. The
  // explorer fills the rest of that row through a portal into `toolbarSlot`. Moving the select into the
  // explorer remounted it on every site change (the explorer unmounts while the new site loads), which
  // dropped keyboard focus to <body>.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  return <div className={siteId ? 'space-y-4' : 'space-y-3'} data-testid="topology-entry">
    {!siteId && <div data-testid="topology-entry-toolbar" className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm text-muted-foreground">{t('site')}<select data-testid="topology-site" className="h-9 rounded-md border bg-background px-2 text-sm text-foreground" value={selectedSite ?? ''} onChange={(event) => { setHashSite(event.target.value); writeTopologyHash({ siteId: event.target.value, view: 'overview', search: '' }); }}><option value="">{t('chooseSite')}</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      <div ref={setToolbarSlot} className="contents" />
    </div>}
    {notInOrganization && <p role="alert" data-testid="topology-site-not-in-org" className="text-sm">{t('siteNotInOrganization')}</p>}
    {linked === 'failed' && <p role="alert" data-testid="topology-site-lookup-failed" className="text-destructive">{t('loadFailed')}</p>}
    {linked && linked !== 'failed' && !notInOrganization && <p role="status">{t('loading')}</p>}
    {!selectedSite && !linked && <p className="text-sm text-muted-foreground">{t('chooseSiteExplanation')}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {selectedSite && !settings && !error && <p role="status">{t('loading')}</p>}
    {settings && !settings.capabilities.ui.available && (legacy ?? <TopologyEmptyState reason={settings.capabilities.ui.reason} />)}
    {settings?.capabilities.ui.available && bindingResolved && selectedSite && (siteId || toolbarSlot) && <Suspense fallback={<p role="status">{t('loading')}</p>}><TopologyExplorer key={`${selectedSite}/${focus ?? ''}`} siteId={selectedSite} siteName={sites.find((site) => site.id === selectedSite)?.name} focusNodeId={focus} settings={settings} toolbarSlot={siteId ? undefined : toolbarSlot ?? undefined} /></Suspense>}
  </div>;
}
