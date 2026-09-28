import type { z } from 'zod';
import type {
  topologyChangePageSchema, topologyChangeSchema, topologyChangesQuerySchema, topologyImpactQuerySchema, topologyImpactResponseSchema,
} from '../validators/topologyInvestigation';

/** Bounded incident-impact query (M3 Task 10). */
export type TopologyImpactQuery = z.infer<typeof topologyImpactQuerySchema>;
/** Cautious, cited impact: measured failures vs possible dependencies, with uncertainty labelled. */
export type TopologyImpactResponse = z.infer<typeof topologyImpactResponseSchema>;
export type TopologyChangesQuery = z.infer<typeof topologyChangesQuerySchema>;
export type TopologyChange = z.infer<typeof topologyChangeSchema>;
export type TopologyChangePage = z.infer<typeof topologyChangePageSchema>;
