import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RosterNetwork } from './renderProjection';
import type { TopologySelection } from './topologyPresentation';

/**
 * Networks the map does not draw as site networks (site location W1): networks the site does not declare, and the
 * unidentified group. Collapsed by default; each device opens in the inspector. Says what is known (declared or not),
 * never how far away anything is.
 */
export default function TopologySiteRoster({ siteName, roster, nodesById, onSelect }: {
  siteName: string; roster: RosterNetwork[]; nodesById: ReadonlyMap<string, { label: string }>; onSelect: (selection: TopologySelection) => void;
}) {
  const { t } = useTranslation('topology');
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (!roster.length) return null;
  const deviceCount = new Set(roster.flatMap((network) => network.memberNodeIds)).size;
  const Chevron = open ? ChevronDown : ChevronRight;
  return <section data-testid="topology-site-roster" className="rounded-md border bg-card text-sm">
    <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}
      className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
      <Chevron className="h-4 w-4" aria-hidden="true" />{t('grouped.rosterHeading', { count: deviceCount })}
    </button>
    {open && <div id={bodyId} className="space-y-3 border-t px-3 py-3">
      {roster.map((network) => <div key={network.groupId} data-testid="topology-roster-network">
        <p className="font-medium">{network.prefix
          ? (network.gatewayAddresses.length ? t('grouped.rosterNetworkVia', { prefix: network.prefix, gateways: network.gatewayAddresses.join(', ') }) : network.prefix)
          : t('grouped.rosterUnidentified')}</p>
        {network.kind === 'undeclared' && <p className="text-xs text-muted-foreground">{t('grouped.notDeclared', { site: siteName })}</p>}
        <ul className="mt-1 flex flex-wrap gap-1.5">{network.memberNodeIds.map((nodeId) => <li key={nodeId}>
          <button type="button" className="rounded border px-2 py-1 text-xs text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => onSelect({ kind: 'node', id: nodeId })}>{nodesById.get(nodeId)?.label ?? t('outsideProjection')}</button></li>)}</ul>
      </div>)}
    </div>}
  </section>;
}
