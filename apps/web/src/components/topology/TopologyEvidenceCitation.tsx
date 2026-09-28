import { useTranslation } from 'react-i18next';
import type { GraphResponse, TopologyAiCitation } from '@breeze/shared';

export type TopologyEvidenceTarget = { kind: 'node' | 'relationship'; id: string };

/**
 * Name of a citation's inspector target from the viewer's OWN authorized graph
 * read. Nothing the model or the explanation supplies is ever used as a name;
 * a target outside that graph has no name here.
 */
export function citationTargetName(graph: GraphResponse, target: TopologyEvidenceTarget | null): string | null {
  if (!target) return null;
  const label = (nodeId: string) => graph.nodes.find((node) => node.id === nodeId)?.label ?? null;
  if (target.kind === 'node') return label(target.id);
  const relationship = graph.relationships.find((item) => item.id === target.id);
  if (!relationship) return null;
  const source = label(relationship.sourceNodeId), destination = label(relationship.targetNodeId);
  return source && destination ? `${source} ↔ ${destination}` : null;
}

/**
 * One cited evidence record (M4 Task 5). The link opens the SERVER-VALIDATED
 * inspector target in the ordinary inspector (which re-reads it under current
 * site access) — no model-supplied href is ever rendered. A citation whose
 * target is not in the viewer's current graph shows as expired detail.
 */
export default function TopologyEvidenceCitation({ citation, index, graph, onSelect }: {
  citation: TopologyAiCitation; index: number; graph: GraphResponse; onSelect: (target: TopologyEvidenceTarget) => void;
}) {
  const { t } = useTranslation('topology');
  const target = citation.inspectorTarget;
  const name = citationTargetName(graph, target);
  const kind = t(/* i18n-dynamic */ `ai.citation.resource.${citation.resourceType}`);
  const when = citation.observedAt ? t('ai.citation.observed', { time: new Date(citation.observedAt).toLocaleString() }) : t('ai.citation.notObserved');
  const label = t('ai.citation.label', { n: index + 1 });
  if (!target || !name) {
    return <span data-testid={`topology-evidence-citation-${index}`} className="inline-flex flex-wrap items-center gap-1 rounded border border-dashed px-2 py-0.5 text-xs text-muted-foreground">
      <span>{label} · {kind}</span>
      <span data-testid="topology-evidence-citation-expired">{t('ai.citation.expired')}</span>
    </span>;
  }
  return <button type="button" data-testid={`topology-evidence-citation-${index}`}
    className="inline-flex flex-wrap items-center gap-1 rounded border px-2 py-0.5 text-left text-xs text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    aria-label={`${label}: ${kind} ${name}, ${when}`} onClick={() => onSelect(target)}>
    <span className="font-medium">{label}</span><span>· {kind} · {name}</span><span className="text-muted-foreground">· {when}</span>
  </button>;
}
