import { useTranslation } from 'react-i18next';
import type { GraphResponse } from '@breeze/shared';
import type { TopologySelection } from './topologyPresentation';
import { topologyHealthLabel } from './topologyPresentation';
import type { HiddenConnection } from './topologyApi';
const RELATIONSHIP_KINDS = new Set(['physical_link', 'attachment', 'network_member', 'default_route', 'egress_path']);
export default function TopologyList({ graph, onSelect, search = '', hidden }: {
  graph: GraphResponse; onSelect: (selection: TopologySelection) => void; search?: string;
  /** Connections hidden from this view (D17): listed with their reason and restorable by editors. */
  hidden?: { items: HiddenConnection[]; canEdit: boolean; onRestore: (item: HiddenConnection) => void; error?: string };
}) {
  const { t } = useTranslation('topology');
  const edgeLabel = (edge: GraphResponse['relationships'][number] | GraphResponse['presentation']['edges'][number]) => edge.meaning === 'schematic' ? t('notIdentified')
    : 'kind' in edge && RELATIONSHIP_KINDS.has(edge.kind) ? t(/* i18n-dynamic */ `physicalView.meaning.${edge.kind}`) : edge.meaning;
  const nodes = [...graph.nodes, ...graph.presentation.nodes].filter((node) => node.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const labels = new Map([...graph.nodes, ...graph.presentation.nodes].map((node) => [node.id, node.label]));
  return <div className="max-h-[34rem] overflow-auto" data-testid="topology-list">
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{t('devicesAndNetworks')}</caption>
      <thead className="sticky top-0 bg-muted"><tr><th className="p-3">{t('name')}</th><th className="p-3">{t('role')}</th><th className="p-3">{t('health')}</th></tr></thead>
      <tbody>{nodes.map((node) => <tr key={node.id} data-testid={`topology-node-kind-${'kind' in node ? node.kind : 'schematic'}`} className="border-t"><td className="p-3"><button className="text-left text-primary underline underline-offset-4 focus-visible:outline" data-testid={`topology-node-${node.id}`} onClick={() => onSelect({ kind: 'node', id: node.id })}>{node.label}</button></td><td className="p-3">{node.role ?? ('kind' in node ? node.kind : t('schematic'))}</td><td className="p-3">{'health' in node ? t(/* i18n-dynamic */ `healthStatus.${node.health.status}`, { defaultValue: topologyHealthLabel(node.health.status, node.health.reasons) }) : t('notIdentified')}</td></tr>)}</tbody>
    </table>
    <table className="mt-6 w-full text-left text-sm">
      <caption className="p-3 text-left font-medium">{t('connections')}</caption>
      <thead className="bg-muted"><tr><th className="p-3">{t('relationship')}</th><th className="p-3">{t('from')}</th><th className="p-3">{t('to')}</th></tr></thead>
      <tbody>{[...graph.relationships, ...graph.presentation.edges].map((edge) => <tr key={edge.id} data-testid={`topology-relationship-kind-${'kind' in edge ? edge.kind : 'schematic'}`} className="border-t"><td className="p-3"><button data-testid={`topology-edge-${edge.id}`} className="text-left text-primary underline underline-offset-4 focus-visible:outline" onClick={() => onSelect({ kind: 'edge', id: edge.id })}>{edgeLabel(edge)}</button>
        {'kind' in edge && (edge.kind === 'physical_link' || edge.kind === 'attachment') && <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ `physicalView.directness.${edge.directness ?? 'unknown'}`)}</span>}</td><td data-testid={`topology-edge-${edge.id}-from`} className="p-3">{labels.get(edge.sourceNodeId) ?? t('outsideProjection')}</td><td data-testid={`topology-edge-${edge.id}-to`} className="p-3">{labels.get(edge.targetNodeId) ?? t('outsideProjection')}</td></tr>)}</tbody>
    </table>
    {hidden && (hidden.items.length > 0 || hidden.error) && <table data-testid="topology-hidden" className="mt-6 w-full text-left text-sm">
      <caption className="p-3 text-left font-medium">{t('exclusions.hiddenSection', { count: hidden.items.length })}</caption>
      <thead className="bg-muted"><tr><th className="p-3">{t('relationship')}</th><th className="p-3">{t('exclusions.hiddenReason')}</th><th className="p-3"><span className="sr-only">{t('exclusions.restore')}</span></th></tr></thead>
      <tbody>{hidden.error && <tr><td colSpan={3} role="alert" className="p-3">{hidden.error}</td></tr>}
        {hidden.items.map((item) => <tr key={item.id} data-testid={`topology-hidden-${item.id}`} className="border-t">
          <td className="p-3"><button className="text-left text-primary underline underline-offset-4 focus-visible:outline" onClick={() => onSelect({ kind: 'edge', id: item.relationshipId })}>{t('exclusions.unknownConnection', { id: item.relationshipId.slice(0, 8) })}</button></td>
          <td className="break-words p-3">{item.reason}</td>
          <td className="p-3">{hidden.canEdit && <button data-testid={`topology-restore-${item.id}`} className="rounded border px-3 py-1" onClick={() => hidden.onRestore(item)}>{t('exclusions.restore')}</button>}</td>
        </tr>)}</tbody>
    </table>}
  </div>;
}
