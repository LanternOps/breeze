import { useTranslation } from 'react-i18next';
import type { GraphNode, GraphResponse, PresentationNode } from '@breeze/shared';

const when = (value: string | null) => value ? new Date(value).toLocaleString() : null;
type GroupMember = NonNullable<PresentationNode['group']>['members'][number];

/** Why a member sits in a card it does not report: a cache mapping (#7816), never "verified". */
function NeighborSeenNote({ member }: { member: GroupMember }) {
  const { t } = useTranslation('topology');
  const neighbor = member.neighbor;
  if (member.placement !== 'neighbor_seen' || !neighbor) return null;
  const qualifier = neighbor.state === 'permanent' ? t('grouped.neighborState.permanent') : neighbor.state === 'unknown' ? t('grouped.neighborState.unknown') : null;
  return <span data-testid="topology-neighbor-seen" className="block text-xs text-muted-foreground">
    {t('grouped.neighborSeenNote', { observer: neighbor.observerLabel, when: when(neighbor.confirmedAt) })}{qualifier ? ` ${qualifier}` : ''}
  </span>;
}

const groupsOf = (graph: GraphResponse, nodeId: string) => graph.presentation.nodes.filter((node) => node.group?.members.some((member) => member.nodeId === nodeId));

/** What the device is, before how we know it: name, type, addresses, vendor, OS, presence, network. */
export function NodeIdentity({ graph, node, onSelectNode }: { graph: GraphResponse; node: GraphNode; onSelectNode?: (id: string) => void }) {
  const { t } = useTranslation('topology');
  const inventory = node.inventory!;
  const presence = inventory.presence;
  const presenceText = presence.source === 'agent'
    ? t(/* i18n-dynamic */ `grouped.presence.agent.${presence.state}`)
    : t(/* i18n-dynamic */ `grouped.presence.scan.${presence.state}`);
  const seen = when(presence.lastSeenAt);
  const routes = graph.relationships.filter((edge) => edge.kind === 'default_route' && edge.sourceNodeId === node.id)
    .map((edge) => graph.nodes.find((candidate) => candidate.id === edge.targetNodeId)?.label).filter(Boolean);
  const rows: [string, string | null][] = [
    [t('grouped.type'), inventory.type?.replaceAll('_', ' ') ?? node.kind],
    [t('grouped.addresses'), inventory.addresses.join(', ') || null],
    [t('grouped.mac'), inventory.mac],
    [t('grouped.vendor'), [inventory.vendor, inventory.model].filter(Boolean).join(' ') || null],
    [t('grouped.os'), inventory.os],
    [t('grouped.gateway'), [...new Set(routes)].join(', ') || null],
  ];
  const groups = groupsOf(graph, node.id).filter((group) => group.group!.kind === 'network');
  return <div data-testid="topology-identity" className="space-y-3 text-sm">
    <p className="text-muted-foreground" data-testid="topology-presence">{presenceText}{seen ? ` · ${t('grouped.lastSeen', { when: seen })}` : ''}</p>
    <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
      {rows.filter(([, value]) => value).map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}
    </dl>
    {groups.length > 0 && <div><p className="font-medium">{t('grouped.networks')}</p><ul className="mt-1 space-y-1">{groups.map((group) => {
      const member = group.group!.members.find((m) => m.nodeId === node.id)!;
      return <li key={group.id}><button className="text-left text-primary underline underline-offset-4" onClick={() => onSelectNode?.(group.id)}>{group.label}</button>
        {member.placement === 'address_match' && <span className="block text-xs text-muted-foreground">{t('grouped.addressMatchNote')}</span>}
        <NeighborSeenNote member={member} />
        {member.stale && <span className="block text-xs text-muted-foreground">{t('grouped.staleMembership')}</span>}</li>;
    })}</ul></div>}
  </div>;
}

/** A grouped card or gateway tile: what it is, how it was grouped, who reported it, and its members. */
export function GroupSummary({ graph, group, onSelectNode }: { graph: GraphResponse; group: PresentationNode; onSelectNode?: (id: string) => void }) {
  const { t } = useTranslation('topology');
  const g = group.group!;
  const label = (id: string) => graph.nodes.find((node) => node.id === id)?.label ?? t('outsideProjection');
  const unverified = g.members.filter((member) => member.placement === 'address_match').length;
  const cacheSeen = g.members.filter((member) => member.placement === 'neighbor_seen').length;
  const macConflict = g.conflictBasis?.includes('gateway_mac') ?? false;
  const addressConflict = !g.conflictBasis?.length || g.conflictBasis.includes('gateway_address');
  if (g.kind === 'gateway') {
    // Each reporter's own canonical gateway stays selectable, so Diagnose runs from a real device and route.
    const reporters = g.canonicalNodeIds.flatMap((gatewayId) => graph.relationships
      .filter((edge) => edge.kind === 'default_route' && edge.targetNodeId === gatewayId)
      .map((edge) => ({ gatewayId, reporter: label(edge.sourceNodeId), freshness: edge.freshness })));
    // Inventory at the same address is a hint, never an identity merge (D:88: binding hardware to a gateway role needs evidence).
    const sameAddress = graph.nodes.filter((node) => g.address && node.inventory?.addresses.includes(g.address));
    return <div data-testid="topology-group-summary" className="space-y-3 text-sm">
      <p>{t('grouped.gatewayExplanation', { address: g.address, count: g.observerCount })}</p>
      {(g.gatewayMacs?.length ?? 0) > 0 && <ul data-testid="topology-gateway-macs" className="space-y-1 text-muted-foreground">{g.gatewayMacs!.map((entry) =>
        <li key={entry.mac}>{t('grouped.gatewayMac', { mac: entry.mac, count: entry.observerCount, when: when(entry.confirmedAt) })}</li>)}</ul>}
      {sameAddress.map((node) => <p key={node.id} data-testid="topology-gateway-address-match" className="text-muted-foreground">{t('grouped.gatewayAddressMatch')}{' '}
        <button className="text-primary underline underline-offset-4" onClick={() => onSelectNode?.(node.id)}>{[node.inventory?.vendor, node.inventory?.model].filter(Boolean).join(' ') || node.label}</button></p>)}
      <div><p className="font-medium">{t('grouped.reportedBy')}</p><ul className="mt-1 max-h-64 space-y-1 overflow-auto">{reporters.map((item) =>
        <li key={`${item.gatewayId}:${item.reporter}`}><button className="text-left text-primary underline underline-offset-4" onClick={() => onSelectNode?.(item.gatewayId)}>{item.reporter}</button>
          {item.freshness === 'stale' && <span className="ml-2 text-xs text-muted-foreground">{t('grouped.stale')}</span>}</li>)}</ul>
        <p className="mt-1 text-xs text-muted-foreground">{t('grouped.diagnoseHint')}</p></div>
    </div>;
  }
  return <div data-testid="topology-group-summary" className="space-y-3 text-sm">
    <p>{g.kind === 'unidentified' ? t('grouped.unidentifiedExplanation') : t('grouped.networkExplanation', { prefix: g.prefix, count: g.observerCount })}</p>
    {g.kind === 'network' && g.networkClass !== 'lan' && <p className="text-muted-foreground">{t(/* i18n-dynamic */ `grouped.class.${g.networkClass}`)}</p>}
    {g.gatewayAddresses.length > 0 && <p>{t('grouped.via', { gateways: g.gatewayAddresses.join(', ') })}</p>}
    {g.conflict && addressConflict && <p className="text-muted-foreground">{t('grouped.conflict')}</p>}
    {g.conflict && macConflict && <p className="text-muted-foreground">{t('grouped.conflictGatewayMac')}</p>}
    {unverified > 0 && <p className="text-muted-foreground">{t('grouped.addressMatchCount', { count: unverified })}</p>}
    {cacheSeen > 0 && <p className="text-muted-foreground">{t('grouped.neighborSeenCount', { count: cacheSeen })}</p>}
    {g.neighborCoverage === 'limited' && <p className="text-muted-foreground">{t('grouped.neighborCoverageLimited')}</p>}
    <div><p className="font-medium">{t('grouped.devices', { count: group.memberCount })}</p>
      <ul className="mt-1 max-h-72 space-y-1 overflow-auto">{[...g.members].sort((a, b) => label(a.nodeId).localeCompare(label(b.nodeId))).map((member) =>
        <li key={member.nodeId}><button className="text-left text-primary underline underline-offset-4" onClick={() => onSelectNode?.(member.nodeId)}>{label(member.nodeId)}</button>
          {member.placement === 'address_match' && <span className="ml-2 text-xs text-muted-foreground">{t('grouped.unverified')}</span>}
          {member.placement === 'neighbor_seen' && <span className="ml-2 text-xs text-muted-foreground">{t('grouped.neighborSeen')}</span>}
          {member.stale && <span className="ml-2 text-xs text-muted-foreground">{t('grouped.stale')}</span>}</li>)}</ul>
      {group.memberCount > g.members.length && <p className="mt-1 text-xs text-muted-foreground">{t('grouped.moreOutside', { count: group.memberCount - g.members.length })}</p>}
    </div>
  </div>;
}
