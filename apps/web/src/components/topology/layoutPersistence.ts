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
  private loaded = false;
  /**
   * Adopts the shared layout. Skipped while there are unsaved user changes, and when this revision is
   * already loaded: re-measuring (a device appears, an expansion) must not throw away the automatic
   * layout of tiles that are already placed, now that it no longer marks the draft dirty (#7880).
   */
  load(revision: string, positions: Position[]) {
    if (this.dirty || (this.loaded && revision === this.revision)) return;
    this.loaded = true;
    this.revision = revision; this.published = new Map(positions.map((p) => [p.nodeId, p]));
    this.positions = new Map(positions.map((p) => [p.nodeId, p]));
  }
  preview(positions: LayoutPosition[]) { this.positions = new Map(positions.map((p) => [p.nodeId, p])); this.dirty = true; }
  /**
   * Takes a layout result into the draft (#7880).
   * - Only a user action (Arrange, Reflow, Use grouped layout, a drag) makes the draft dirty. The
   *   automatic arrangement on load or resize does not, and never clears an existing unsaved change.
   * - Revised Q3: a pinned card member is drawn in the card grid, but its saved pin is kept as it is.
   *   It is never rewritten to the grid spot, so it still applies in views without grouping.
   */
  applyLayout(positions: LayoutPosition[], { cardMembers, userAction }: { cardMembers: ReadonlySet<string>; userAction: boolean }) {
    const previous = this.positions;
    this.positions = new Map(positions.map((p) => {
      const saved = previous.get(p.nodeId);
      return [p.nodeId, saved?.pinned && cardMembers.has(p.nodeId) ? saved : p];
    }));
    if (userAction) this.dirty = true;
  }
  accept(result: LayoutWriteResult) {
    for (const position of result.positions) { this.published.set(position.nodeId, position); this.positions.set(position.nodeId, position); }
    this.revision = result.layoutRevision; this.dirty = false;
  }
}
