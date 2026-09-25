import type { TopologyScope } from '@breeze/shared';
import type { topologyCollectionRuns, topologyCollectionSources, topologyInterfaces, topologyObservations, topologyRelationshipSupport } from '../../db/schema';
import type { NodePublication, RelationshipPublication, BindingPublication } from './publish';
import type { NormalizedTopologySnapshot, OsTopologySnapshot, PendingTopologyMiss, PendingTopologyLifecycle } from './collectionTypes';
export type CollectionSource = typeof topologyCollectionSources.$inferSelect;
export type CollectionRun = typeof topologyCollectionRuns.$inferSelect;
export type InterfacePublication = typeof topologyInterfaces.$inferInsert & {id:string};
export type ObservationPublication = typeof topologyObservations.$inferInsert & {id:string};
export type SupportPublication = typeof topologyRelationshipSupport.$inferInsert;
export type TopologyProjectionInput = {
  scope:TopologyScope; source:CollectionSource; run:CollectionRun; snapshot:NormalizedTopologySnapshot;
  /** The reporting device's node. Required for OS context; physical families
   * resolve their subject per row (D3), so it may be null for them. */
  originNodeId:string|null; nodes:NodePublication[]; relationships:RelationshipPublication[]; interfaces:InterfacePublication[];
};
export type BaselineProjectionInput = TopologyProjectionInput & { snapshot:OsTopologySnapshot; originNodeId:string };
export type TopologyProjectionDelta = {
  nodes:NodePublication[]; relationships:RelationshipPublication[]; bindings:BindingPublication[];
  interfaces:InterfacePublication[]; observations:ObservationPublication[]; support:SupportPublication[];
};
export type CollectionPublication = TopologyProjectionDelta & {
  consumedRuns:string[]; checkpoints:{sourceId:string;epoch:string;sequence:string;digest:string;baseline:Record<string,unknown>}[];
  consumedMisses:{sourceId:string;generation:string}[];
};
export type CollectionEvent = {revision:bigint;source:CollectionSource} & ({kind:'snapshot';run:CollectionRun}|{kind:'miss';miss:PendingTopologyMiss}|{kind:'lifecycle';change:PendingTopologyLifecycle});
export const emptyProjection = ():TopologyProjectionDelta=>({nodes:[],relationships:[],bindings:[],interfaces:[],observations:[],support:[]});
