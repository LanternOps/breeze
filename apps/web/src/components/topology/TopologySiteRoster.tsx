import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PresenceAssignedEntry, PresenceResponse } from '@breeze/shared';
import type { RosterNetwork } from './renderProjection';
import type { TopologySelection } from './topologyPresentation';
import { formatRelativeTime, formatTime } from '../../lib/dateTimeFormat';
import SiteMoveSuggestion from './SiteMoveSuggestion';

/**
 * The viewed site's devices that are not on its networks, in up to three sections (site location W1/W2, spec S§4.3):
 * "Observed at other sites", "Other / unidentified networks" (W01's undeclared networks plus devices on unrecognized networks)
 * and "Location unknown". Collapsed by default; each device opens in the inspector. It names a site only when the API sent
 * that site (a match the viewer may not see arrives as an unrecognized entry with no reason), and never says how far away anything is.
 */
export default function TopologySiteRoster({ siteName, roster, nodesById, onSelect, presence, deviceNodeIds, canMoveDevices = false, onPresenceChanged }: {
  siteName: string; roster: RosterNetwork[]; nodesById: ReadonlyMap<string, { label: string }>; onSelect: (selection: TopologySelection) => void;
  /** Cross-site presence of this site's assigned devices; absent until it loads (or when it fails), then only W01's networks are listed. */
  presence?: PresenceResponse | null;
  /** Breeze device id -> the node this map draws for it, so an entry can open the inspector. */
  deviceNodeIds?: ReadonlyMap<string, string>;
  /** W3: devices:write, for "Move to <site>" / "Keep at <site>" on a wrong-site suggestion. */
  canMoveDevices?: boolean;
  /** W3: refetch presence after a suggestion action. */
  onPresenceChanged?: () => void;
}) {
  const { t, i18n } = useTranslation('topology');
  const [open, setOpen] = useState(false);
  const bodyId = useId(), observedId = useId(), otherId = useId(), unknownId = useId();
  const entries = [...new Map((presence?.assigned ?? []).filter((entry) => entry.state !== 'home').map((entry) => [entry.deviceId, entry])).values()];
  if (!roster.length && !entries.length) return null;
  const observed = entries.filter((entry) => entry.state === 'visiting');
  const unknown = entries.filter((entry) => entry.state === 'stale' || entry.state === 'unknown');
  const other = entries.filter((entry) => entry.state === 'unrecognized' || entry.state === 'ambiguous');
  const rosterDevices = new Set(roster.flatMap((network) => network.memberNodeIds));
  const deviceKey = (entry: PresenceAssignedEntry) => deviceNodeIds?.get(entry.deviceId) ?? entry.deviceId;
  const deviceCount = new Set([...rosterDevices, ...entries.map(deviceKey)]).size;
  const otherCount = new Set([...rosterDevices, ...other.map(deviceKey)]).size;
  const Chevron = open ? ChevronDown : ChevronRight;
  const visibleSite = (entry: PresenceAssignedEntry) => entry.matchedSite?.name ?? (entry.declaringSites?.length === 1 ? entry.declaringSites[0]!.name : null);
  const names = (sites: { name: string }[]) => {
    try { return new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' }).format(sites.map((site) => site.name)); } catch { return sites.map((site) => site.name).join(', '); }
  };
  /** Hints exist only for the reasons the spec lists, and only when the site they name was sent. */
  const hint = (entry: PresenceAssignedEntry): string | null => {
    const site = visibleSite(entry);
    switch (entry.reason) {
      case 'declared_unconfirmed': return site ? t('grouped.crossSite.hint.declaredUnconfirmed', { site }) : null;
      case 'consumer_uncorroborated': return site ? t('grouped.crossSite.hint.consumerUncorroborated', { site }) : null;
      case 'gateway_mismatch': return site ? t('grouped.crossSite.hint.gatewayMismatch', { site }) : null;
      case 'own_gateway_mismatch': return entry.network ? t('grouped.crossSite.hint.ownGatewayMismatch', { site: siteName, gateway: entry.network.gatewayAddress }) : null;
      default: return null;
    }
  };
  const device = (entry: PresenceAssignedEntry) => {
    const nodeId = deviceNodeIds?.get(entry.deviceId);
    return nodeId
      ? <button type="button" className="rounded border px-2 py-1 text-xs text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onClick={() => onSelect({ kind: 'node', id: nodeId })}>{entry.label}</button>
      : <span className="text-xs font-medium">{entry.label}</span>;
  };
  const line = (entry: PresenceAssignedEntry): { text: string; hint: string | null } => {
    if (entry.state === 'visiting') {
      const site = entry.matchedSite?.name ?? '';
      const prefix = entry.network?.prefix ?? '';
      const time = entry.observedAt ? formatTime(entry.observedAt, { hour: '2-digit', minute: '2-digit' }) : null;
      return { text: time ? t('grouped.crossSite.observedEntry', { site, prefix, time }) : t('grouped.crossSite.observedEntryNoTime', { site, prefix }), hint: null };
    }
    if (entry.state === 'stale' || entry.state === 'unknown') {
      const current = entry.reason === 'not_current' || entry.reason === 'coverage_limited' || !entry.network || !entry.observedAt;
      return { text: current ? t('grouped.crossSite.locationNotCurrent')
        : t('grouped.crossSite.lastReported', { prefix: entry.network!.prefix, gateway: entry.network!.gatewayAddress, when: formatRelativeTime(entry.observedAt) }), hint: null };
    }
    // An ambiguous device is named only when the viewer sees every declaring site (the API sends null otherwise).
    if (entry.state === 'ambiguous' && entry.declaringSites && entry.declaringSites.length > 1) return { text: t('grouped.crossSite.ambiguousEntry', { sites: names(entry.declaringSites) }), hint: null };
    return { text: entry.network ? t('grouped.crossSite.unrecognizedEntry', { prefix: entry.network.prefix, gateway: entry.network.gatewayAddress }) : t('grouped.crossSite.unrecognizedEntryNoNetwork'), hint: hint(entry) };
  };
  const list = (rows: PresenceAssignedEntry[]) => <ul className="mt-1 space-y-1.5">{rows.map((entry) => {
    const detail = line(entry);
    return <li key={entry.deviceId} data-testid="topology-roster-device">{device(entry)}
      <p className="text-xs text-muted-foreground">{detail.text}</p>{detail.hint && <p className="text-xs text-muted-foreground">{detail.hint}</p>}
      {presence && (entry.suggestion || entry.siteAssignmentConfirmedAt) && <SiteMoveSuggestion deviceId={entry.deviceId} deviceName={entry.label}
        assignedSite={{ id: presence.siteId, name: siteName }} prefix={entry.network?.prefix ?? null} suggestion={entry.suggestion}
        confirmedAt={entry.siteAssignmentConfirmedAt} canMove={canMoveDevices} onChanged={() => onPresenceChanged?.()} />}</li>;
  })}</ul>;
  return <section data-testid="topology-site-roster" className="rounded-md border bg-card text-sm">
    <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}
      className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
      <Chevron className="h-4 w-4" aria-hidden="true" />{t('grouped.crossSite.rosterToggle', { count: deviceCount })}
    </button>
    {open && <div id={bodyId} className="space-y-4 border-t px-3 py-3">
      {observed.length > 0 && <section aria-labelledby={observedId} data-testid="topology-roster-observed">
        <h4 id={observedId} className="font-medium">{t('grouped.crossSite.observedHeading', { count: observed.length })}</h4>{list(observed)}</section>}
      {(roster.length > 0 || other.length > 0) && <section aria-labelledby={otherId} data-testid="topology-roster-other">
        <h4 id={otherId} className="font-medium">{t('grouped.rosterHeading', { count: otherCount })}</h4>
        <div className="mt-2 space-y-3">
          {roster.map((network) => <div key={network.groupId} data-testid="topology-roster-network">
            <p className="font-medium">{network.prefix
              ? (network.gatewayAddresses.length ? t('grouped.rosterNetworkVia', { prefix: network.prefix, gateways: network.gatewayAddresses.join(', ') }) : network.prefix)
              : t('grouped.rosterUnidentified')}</p>
            {network.kind === 'undeclared' && <p className="text-xs text-muted-foreground">{t('grouped.notDeclared', { site: siteName })}</p>}
            <ul className="mt-1 flex flex-wrap gap-1.5">{network.memberNodeIds.map((nodeId) => <li key={nodeId}>
              <button type="button" className="rounded border px-2 py-1 text-xs text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => onSelect({ kind: 'node', id: nodeId })}>{nodesById.get(nodeId)?.label ?? t('outsideProjection')}</button></li>)}</ul>
          </div>)}
          {other.length > 0 && list(other)}
        </div>
      </section>}
      {unknown.length > 0 && <section aria-labelledby={unknownId} data-testid="topology-roster-unknown">
        <h4 id={unknownId} className="font-medium">{t('grouped.crossSite.unknownHeading', { count: unknown.length })}</h4>{list(unknown)}</section>}
    </div>}
  </section>;
}
