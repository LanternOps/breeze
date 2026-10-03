export const LAYOUT_VERSION = 'elk-layered-0.12.0-v4-grouped';
export type LayoutPosition = { nodeId: string; x: number; y: number; pinned: boolean };
/**
 * `role` 'group' / 'unidentified' marks a grouped-overview card: its size is computed
 * by the layout from its members (`groupId`), and it never receives a position of its
 * own (the canvas derives a compound parent from its children). `rank`, then `address`
 * (numeric IP order), then `name` order members inside a card.
 */
export type LayoutBox = { id: string; width: number; height: number; role: string; groupId?: string; rank?: number; address?: string; name?: string };
export type LayoutFence = {
  requestId: string;
  graphRevision: string;
  layoutRevision: string;
  measurementRevision: string;
  algorithmVersion: string;
};
export type LayoutRequest = LayoutFence & {
  nodes: LayoutBox[];
  /** Physical edges carry their interface IDs as ports; parallel cables keep distinct IDs (M2). */
  edges: { id: string; source: string; target: string; sourcePort?: string; targetPort?: string }[];
  positions: LayoutPosition[];
  mode: 'incremental' | 'reflow';
};
export type LayoutResult = LayoutFence & { positions: LayoutPosition[]; warning?: 'layout_fallback' | 'pinned_overlap' };
export const sameLayoutFence = (a: LayoutFence, b: LayoutFence) =>
  a.requestId === b.requestId && a.graphRevision === b.graphRevision && a.layoutRevision === b.layoutRevision
  && a.measurementRevision === b.measurementRevision && a.algorithmVersion === b.algorithmVersion;
