import type { GraphResponse } from '@breeze/shared';
export type TopologySelection = { kind: 'node' | 'edge'; id: string };
export function selectedTopologyEntity(graph: GraphResponse, selection?: TopologySelection) {
  if (!selection) return undefined;
  return selection.kind === 'node'
    ? graph.nodes.find((node) => node.id === selection.id) ?? graph.presentation.nodes.find((node) => node.id === selection.id)
    : graph.relationships.find((edge) => edge.id === selection.id) ?? graph.presentation.edges.find((edge) => edge.id === selection.id);
}
export const isPresentation = (entity: object) => 'authority' in entity && entity.authority === false;
export function topologyHealthLabel(status: string, reasons: { code: string; message: string }[]) {
  // The API's vocabulary (diagnosticHealth.ts): `icmp_no_response`, not `no_icmp_response`.
  if (reasons.some((reason) => reason.code === 'icmp_no_response')) return 'No ICMP response';
  return ({ healthy: 'Healthy', degraded: 'Degraded', failed_check: 'Check failed', unknown: 'Not measured' })[status] ?? 'Not measured';
}
