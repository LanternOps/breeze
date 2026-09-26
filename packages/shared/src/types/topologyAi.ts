import type { z } from 'zod';
import type {
  topologyAiCitationSchema, topologyAiExplanationSchema, topologyAiFindingSchema, topologyAiModelOutputSchema, topologyAiNextCheckSchema, topologyAiSelectionSchema,
} from '../validators/topologyAi';

/** The IDs an "Explain this" investigation starts from (M4 #6000). */
export type TopologyAiSelection = z.infer<typeof topologyAiSelectionSchema>;
export type TopologyAiFinding = z.infer<typeof topologyAiFindingSchema>;
export type TopologyAiNextCheck = z.infer<typeof topologyAiNextCheckSchema>;
export type TopologyAiCitation = z.infer<typeof topologyAiCitationSchema>;
/** A server-validated, cited, structured answer — the only topology AI output a client ever sees. */
export type TopologyAiExplanation = z.infer<typeof topologyAiExplanationSchema>;
export type TopologyAiModelOutput = z.infer<typeof topologyAiModelOutputSchema>;
