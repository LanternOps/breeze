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
  /** Physical families only (D3): the authorized target and trusted identity inputs. */
  physical?:PhysicalProjectionContext;
};
export type PhysicalProjectionContext = {
  /** Server-derived authority key the source context is namespaced under. */
  authorityKey:string;
  /** Node bound to the authorized target's scoped asset; null projects onto a scoped unbound target node. */
  subjectNodeId:string|null;
  /** Agent-reported NIC MACs of bound managed devices (trusted MAC identity, D16). */
  deviceMacs:{nodeId:string;mac:string}[];
  /** Breeze device id -> its current inventory node (UniFi endpoint binding, D16). */
  deviceNodes?:Record<string,string>;
  /** UniFi endpointKey -> Breeze device id, from the site's retained device/client
   * list rows (unambiguous only). Lets a client's UPLINK endpoint reach the
   * inventory node its own device-list row was bound to. */
  unifiEndpointDevices?:Record<string,string>;
  /** Targets' own LLDP chassis ids, attributed to their subject nodes (trusted self-report). */
  chassisIds?:{nodeId:string;id:{subtype:string;value:string}}[];
};
export type BaselineProjectionInput = TopologyProjectionInput & { snapshot:OsTopologySnapshot; originNodeId:string };
export type TopologyProjectionDelta = {
  nodes:NodePublication[]; relationships:RelationshipPublication[]; bindings:BindingPublication[];
  interfaces:InterfacePublication[]; observations:ObservationPublication[]; support:SupportPublication[];
};
export type CollectionPublication = TopologyProjectionDelta & {
  consumedRuns:string[]; checkpoints:{sourceId:string;epoch:string;sequence:string;digest:string;baseline:Record<string,unknown>}[];
  consumedMisses:{sourceId:string;generation:string}[];
  /** Physical re-resolution (D15.2): support keys moved away, pending lifecycle and
   * observation references to remap, and relationship ids whose identity was rekeyed. */
  supportDeletes:{sourceId:string;relationshipId:string}[];
  lifecycleRemaps:{sourceId:string;from:string;to:string}[];
  observationRemaps:{sourceId:string;from:string;to:string}[];
  rekeyed:string[];
  /** Identity revision this publication resolved through, when the pass ran. */
  identityResolvedThrough?:bigint;
};
export type CollectionEvent = {revision:bigint;source:CollectionSource} & ({kind:'snapshot';run:CollectionRun}|{kind:'miss';miss:PendingTopologyMiss}|{kind:'lifecycle';change:PendingTopologyLifecycle});
export const emptyProjection = ():TopologyProjectionDelta=>({nodes:[],relationships:[],bindings:[],interfaces:[],observations:[],support:[]});
