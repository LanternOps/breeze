import { layoutPatchSchema, layoutWriteResultSchema, isLayoutPatchBodySizeAllowed } from '@breeze/shared/validators/topology';
import type { LayoutWriteResult, Position, TopologyView } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import type { LayoutPosition } from './layoutTypes';

export async function saveTopologyLayout(scope: { siteId: string }, view: TopologyView, expectedRevision: string, positions: LayoutPosition[]): Promise<LayoutWriteResult> {
  const body = JSON.stringify(layoutPatchSchema.parse({ expectedRevision, positions }));
  if (!isLayoutPatchBodySizeAllowed(new TextEncoder().encode(body).byteLength)) throw new Error('Layout exceeds the supported batch size');
  return runAction({
    request: () => fetchWithAuth(`/topology/sites/${encodeURIComponent(scope.siteId)}/layouts/${view}`, { method: 'PATCH', body }),
    errorFallback: 'Unable to save topology layout', successMessage: 'Topology layout saved',
    parseSuccess: (data) => layoutWriteResultSchema.parse(data),
  });
}

export class TopologyLayoutDraft {
  positions = new Map<string, LayoutPosition>();
  published = new Map<string, Position>();
  revision = '0';
  dirty = false;
  load(revision: string, positions: Position[]) {
    if (this.dirty) return;
    this.revision = revision; this.published = new Map(positions.map((p) => [p.nodeId, p]));
    this.positions = new Map(positions.map((p) => [p.nodeId, p]));
  }
  preview(positions: LayoutPosition[]) { this.positions = new Map(positions.map((p) => [p.nodeId, p])); this.dirty = true; }
  accept(result: LayoutWriteResult) {
    for (const position of result.positions) { this.published.set(position.nodeId, position); this.positions.set(position.nodeId, position); }
    this.revision = result.layoutRevision; this.dirty = false;
  }
}
