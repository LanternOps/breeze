import type { z } from 'zod';
import type { networkContextV1Schema, networkContextFullSchema, networkContextUnchangedSchema, topologyContextSectionSchema, topologyInterfaceRowSchema, topologyRouteRowSchema, topologyRuleRowSchema, topologyResolverRowSchema, topologyNeighborRowSchema, topologyAddressRowSchema, topologyNextHopSchema } from '../validators/topologyCollection';

export type NetworkContextV1 = z.infer<typeof networkContextV1Schema>;
export type NetworkContextFull = z.infer<typeof networkContextFullSchema>;
export type NetworkContextUnchanged = z.infer<typeof networkContextUnchangedSchema>;
export type TopologyContextSection = z.infer<typeof topologyContextSectionSchema>;
export type TopologyInterfaceRow = z.infer<typeof topologyInterfaceRowSchema>;
export type TopologyRouteRow = z.infer<typeof topologyRouteRowSchema>;
export type TopologyRuleRow = z.infer<typeof topologyRuleRowSchema>;
export type TopologyResolverRow = z.infer<typeof topologyResolverRowSchema>;
export type TopologyNeighborRow = z.infer<typeof topologyNeighborRowSchema>;
export type TopologyAddressRow = z.infer<typeof topologyAddressRowSchema>;
export type TopologyNextHop = z.infer<typeof topologyNextHopSchema>;
