import type { z } from 'zod';
import type { createTopologyDiagnosticSchema, topologyDiagnosticPlanSchema, topologyDiagnosticResultSchema, topologyDiagnosticRunSchema, topologyHealthSummarySchema, topologyDiagnosticCommandSchema, topologyDiagnosticStepSchema, topologyDiagnosticPlanStepSchema, topologyDiagnosticOriginSchema, topologyDiagnosticDestinationSchema } from '../validators/topologyDiagnostics';

export type CreateTopologyDiagnosticRequest = z.infer<typeof createTopologyDiagnosticSchema>;
export type TopologyDiagnosticPlan = z.infer<typeof topologyDiagnosticPlanSchema>;
export type TopologyDiagnosticResult = z.infer<typeof topologyDiagnosticResultSchema>;
export type TopologyDiagnosticRun = z.infer<typeof topologyDiagnosticRunSchema>;
export type TopologyHealthSummary = z.infer<typeof topologyHealthSummarySchema>;
export type TopologyDiagnosticCommand = z.infer<typeof topologyDiagnosticCommandSchema>;
export type TopologyDiagnosticStep = z.infer<typeof topologyDiagnosticStepSchema>;
export type TopologyDiagnosticPlanStep = z.infer<typeof topologyDiagnosticPlanStepSchema>;
export type TopologyDiagnosticOrigin = z.infer<typeof topologyDiagnosticOriginSchema>;
export type TopologyDiagnosticDestination = z.infer<typeof topologyDiagnosticDestinationSchema>;

import type { topologyOriginEligibilitySchema, topologyCollectorsResponseSchema } from '../validators/topologyDiagnostics';
export type TopologyOriginEligibility = z.infer<typeof topologyOriginEligibilitySchema>;
export type TopologyCollectorsResponse = z.infer<typeof topologyCollectorsResponseSchema>;
