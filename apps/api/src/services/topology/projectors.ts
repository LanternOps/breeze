import { projectBaselineTopology } from './baselineProjector';
import { isPhysicalTopologySection, type OsTopologySnapshot } from './collectionTypes';
import { emptyProjection, type TopologyProjectionInput } from './reconciliationTypes';
/** Dispatches by typed source family (D15.4). Physical families project nothing
 * until the physical projector (M2 Task 6) is registered here; their baselines
 * are still checkpointed so rowKey→relationship state starts empty and exact. */
export function projectTopology(input:TopologyProjectionInput){
  if (isPhysicalTopologySection(input.snapshot.section)) return emptyProjection();
  if (!input.originNodeId) throw new Error('Topology producer inventory is not published');
  return projectBaselineTopology({...input,snapshot:input.snapshot as OsTopologySnapshot,originNodeId:input.originNodeId});
}
