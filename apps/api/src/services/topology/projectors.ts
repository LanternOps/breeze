import { projectBaselineTopology } from './baselineProjector';
import { projectPhysicalTopology } from './physicalProjector';
import { isPhysicalTopologySection, type OsTopologySnapshot } from './collectionTypes';
import type { TopologyProjectionInput } from './reconciliationTypes';
/** Dispatches by typed source family (D15.4): physical families (adjacency and
 * UniFi) to the physical projector, OS context to the M1 baseline projector. */
export function projectTopology(input:TopologyProjectionInput){
  if (isPhysicalTopologySection(input.snapshot.section)) return projectPhysicalTopology(input);
  if (!input.originNodeId) throw new Error('Topology producer inventory is not published');
  return projectBaselineTopology({...input,snapshot:input.snapshot as OsTopologySnapshot,originNodeId:input.originNodeId});
}
