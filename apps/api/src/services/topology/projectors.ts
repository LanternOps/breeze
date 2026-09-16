import { projectBaselineTopology } from './baselineProjector';
import type { TopologyProjectionInput } from './reconciliationTypes';
export const projectTopology = (input:TopologyProjectionInput)=>projectBaselineTopology(input);
