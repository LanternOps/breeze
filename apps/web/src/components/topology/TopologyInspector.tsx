import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphResponse, RelationshipDetailResponse, RelationshipEvidenceResponse, TopologyView } from '@breeze/shared';
import { isPresentation, selectedTopologyEntity, type TopologySelection, topologyHealthLabel } from './topologyPresentation';
import { topologyApi } from './topologyApi';
import PhysicalEvidencePanel from './PhysicalEvidencePanel';
import RelationshipExclusionAction from './RelationshipExclusionAction';

/** Passive read of one relationship's detail and first evidence page. Never mutates. */
function useRelationshipDetail(siteId: string | undefined, relationshipId: string | undefined, refresh: number) {
  const [detail, setDetail] = useState<RelationshipDetailResponse | null>(null);
  const [evidence, setEvidence] = useState<RelationshipEvidenceResponse | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDetail(null); setEvidence(null); setError(undefined);
    if (!siteId || !relationshipId) return;
    const abort = new AbortController();
    void topologyApi.relationship(siteId, relationshipId, abort.signal).then((next) => {
      if (abort.signal.aborted) return;
      setDetail(next);
      return topologyApi.evidence(siteId, relationshipId, undefined, abort.signal).then((page) => { if (!abort.signal.aborted) setEvidence(page); });
    }).catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'error'); });
    return () => abort.abort();
  }, [siteId, relationshipId, refresh]);
  const loadMore = async () => {
    if (!siteId || !relationshipId || !evidence?.cursor) return;
    try {
      const next = await topologyApi.evidence(siteId, relationshipId, evidence.cursor);
      setEvidence({ ...next, observations: [...evidence.observations, ...next.observations], confirmations: evidence.confirmations });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'error'); }
  };
  return { detail, evidence, error, loadMore };
}

export default function TopologyInspector({ selection, graph, canDiagnose, onDiagnose, onClose, onExpand, onPin, pinned, siteId, view, onChanged }: {
  selection: TopologySelection; graph: GraphResponse; canDiagnose: boolean; onDiagnose: () => void; onClose: () => void;
  onExpand: (token: string) => void; onPin?: () => void; pinned?: boolean;
  /** With a site, an edge selection also reads its authorized detail/evidence (M2 D11) and offers exclusion (D17). */
  siteId?: string; view?: TopologyView; onChanged?: () => void;
}) {
  const { t } = useTranslation('topology'); const heading = useRef<HTMLHeadingElement>(null);
  const [refresh, setRefresh] = useState(0);
  const inGraph = selectedTopologyEntity(graph, selection);
  const canonicalEdge = selection.kind === 'edge' && (!inGraph || !isPresentation(inGraph));
  const { detail, evidence, error, loadMore } = useRelationshipDetail(siteId && canonicalEdge ? siteId : undefined, canonicalEdge ? selection.id : undefined, refresh);
  // A connection hidden from this view is not in the graph; its authorized detail still is.
  const entity = inGraph ?? detail?.relationship;
  useEffect(() => { heading.current?.focus(); }, [selection.id]);
  if (!entity) return null;
  const schematic = isPresentation(entity);
  return <aside data-testid="topology-inspector" className="min-w-0 space-y-4 border-t bg-card p-4 lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <div className="flex items-start justify-between gap-3"><h3 ref={heading} tabIndex={-1} className="break-words text-lg font-semibold">{'label' in entity ? entity.label : entity.meaning}</h3><button data-testid="topology-inspector-close" className="rounded border px-3 py-2" onClick={onClose}>{t('close')}</button></div>
    {schematic && <p>{t('schematicExplanation')}</p>}
    {'kind' in entity && <p className="text-sm text-muted-foreground">{entity.kind.replaceAll('_', ' ')}</p>}
    {'evidence' in entity && <dl className="space-y-3 text-sm">
      <div><dt className="font-medium">{t('evidence')}</dt><dd>{entity.evidence.classes.join(', ') || t('none')} · {entity.evidence.methods.join(', ') || t('none')}</dd></div>
      <div><dt className="font-medium">{t('freshness')}</dt><dd>{entity.freshness} · {entity.evidence.lastObservedAt ? new Date(entity.evidence.lastObservedAt).toLocaleString() : t('notObserved')}</dd></div>
      {'confidence' in entity && <div><dt className="font-medium">{t('confidence')}</dt><dd>{entity.confidence}</dd></div>}
      <div><dt className="font-medium">{t('health')}</dt><dd>{t(/* i18n-dynamic */ `healthStatus.${entity.health.status}`, { defaultValue: topologyHealthLabel(entity.health.status, entity.health.reasons) })}</dd><dd>{entity.health.coverage} · {entity.health.freshness}</dd></div>
      {entity.health.originNodeId && <div><dt className="font-medium">{t('measuredFrom')}</dt><dd>{graph.nodes.find((n) => n.id === entity.health.originNodeId)?.label ?? t('outsideProjection')}</dd></div>}
    </dl>}
    {'health' in entity && entity.health.reasons.map((reason) => <p key={reason.code} className="text-sm">{reason.message}</p>)}
    {'contributingRelationshipIds' in entity && entity.meaning === 'aggregate' && <div><h4 className="font-medium">{t('reportedBy')}</h4><ul className="list-inside list-disc text-sm">{entity.contributingRelationshipIds.map((id) => {
      const relationship = graph.relationships.find((r) => r.id === id);
      return <li key={id}>{graph.nodes.find((n) => n.id === relationship?.sourceNodeId)?.label ?? t('outsideProjection')}</li>;
    })}</ul></div>}
    {'bindings' in entity && entity.bindings.filter((binding) => binding.type !== 'manual_node').map((binding) => <a key={binding.id} className="block text-sm text-primary underline" href={binding.type === 'device' ? `/devices/${binding.referenceId}` : `/devices/network/${binding.referenceId}`}>{t('openInventory')}</a>)}
    {'memberCount' in entity && <p className="text-sm">{t('members', { count: entity.memberCount })}</p>}
    {'frontierToken' in entity && <button data-testid="topology-expand" className="rounded border px-3 py-2" onClick={() => onExpand(entity.frontierToken)}>{t('expand')}</button>}
    {'kind' in entity && 'directionality' in entity && siteId && <>
      <PhysicalEvidencePanel relationship={detail?.relationship ?? entity} detail={detail} evidence={evidence} onLoadMoreEvidence={() => void loadMore()} />
      {!detail && !error && <p role="status" className="text-sm text-muted-foreground">{t('physicalView.loadingDetail')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{t('physicalView.detailFailed')}</p>}
      {detail && view && <RelationshipExclusionAction siteId={siteId} relationshipId={entity.id} view={view} canEdit={graph.permissions.canEdit}
        exclusion={detail.exclusions.find((exclusion) => exclusion.view === view)} onChanged={() => { setRefresh((n) => n + 1); onChanged?.(); }} />}
    </>}
    {!schematic && <button data-testid="topology-diagnose" className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={!canDiagnose} onClick={onDiagnose}>{t('diagnose')}</button>}
    {!schematic && !canDiagnose && <p className="text-sm text-muted-foreground">{t('diagnosticsUnavailable')}</p>}
    {onPin && !schematic && selection.kind === 'node' && <button data-testid="topology-pin" className="ml-2 rounded border px-3 py-2" aria-pressed={pinned} onClick={onPin}>{pinned ? t('unpin') : t('pin')}</button>}
  </aside>;
}
