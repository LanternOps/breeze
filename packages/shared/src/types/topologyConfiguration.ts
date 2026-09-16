import type { z } from 'zod';
import type { topologyConfigurationSchema, topologyTargetDefinitionSchema, topologyPolicyDefinitionSchema } from '../validators/topologyConfiguration';

export type TopologyConfigurationPayload = z.infer<typeof topologyConfigurationSchema>;
export type TopologyTargetDefinition = z.infer<typeof topologyTargetDefinitionSchema>;
export type TopologyPolicyDefinition = z.infer<typeof topologyPolicyDefinitionSchema>;
