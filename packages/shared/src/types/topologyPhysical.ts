import type { z } from 'zod';
import type {
  adjacencyFinalManifestSchema, adjacencyManifestScopeSchema, adjacencySectionSchema, adjacencyV2FullSchema, adjacencyV2Schema, adjacencyV2UnchangedSchema,
  cdpRowSchema, fdbRowSchema, lldpRowSchema, physicalInterfaceRowSchema, portRefSchema, typedIdSchema,
  unifiClientRowSchema, unifiDeviceDetailRowSchema, unifiDeviceRowSchema, unifiResourceSchema, unifiStatisticsRowSchema, unifiTopologyV1Schema,
} from '../validators/topologyPhysical';

export type PortRef = z.infer<typeof portRefSchema>;
export type TypedId = z.infer<typeof typedIdSchema>;
export type LldpRow = z.infer<typeof lldpRowSchema>;
export type CdpRow = z.infer<typeof cdpRowSchema>;
export type FdbRow = z.infer<typeof fdbRowSchema>;
export type PhysicalInterfaceRow = z.infer<typeof physicalInterfaceRowSchema>;
export type AdjacencySection = z.infer<typeof adjacencySectionSchema>;
export type AdjacencyManifestScope = z.infer<typeof adjacencyManifestScopeSchema>;
export type AdjacencyFinalManifest = z.infer<typeof adjacencyFinalManifestSchema>;
export type AdjacencyV2 = z.infer<typeof adjacencyV2Schema>;
export type AdjacencyV2Full = z.infer<typeof adjacencyV2FullSchema>;
export type AdjacencyV2Unchanged = z.infer<typeof adjacencyV2UnchangedSchema>;
export type UnifiDeviceRow = z.infer<typeof unifiDeviceRowSchema>;
export type UnifiClientRow = z.infer<typeof unifiClientRowSchema>;
export type UnifiDeviceDetailRow = z.infer<typeof unifiDeviceDetailRowSchema>;
export type UnifiStatisticsRow = z.infer<typeof unifiStatisticsRowSchema>;
export type UnifiResource = z.infer<typeof unifiResourceSchema>;
export type UnifiTopologyV1 = z.infer<typeof unifiTopologyV1Schema>;
