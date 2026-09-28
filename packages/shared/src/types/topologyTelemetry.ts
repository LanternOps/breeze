import type { z } from 'zod';
import type {
  topologyInterfaceHistoryEpochSchema, topologyInterfaceHistoryQuerySchema, topologyInterfaceHistoryResponseSchema, topologyInterfaceHistorySeriesSchema,
  topologyInterfaceMeasurementSchema, topologyLinkHealthResponseSchema,
  topologyInterfaceMetricEnvelopeV1Schema, topologyInterfacePollCommandV1Schema, topologyInterfaceSampleV1Schema,
} from '../validators/topologyTelemetry';

/** One interface's readings at one instant; counters are uint64 decimal strings, null = not measured (see `unavailable`). */
export type TopologyInterfaceSampleV1 = z.infer<typeof topologyInterfaceSampleV1Schema>;
/** One bounded `if_metrics` batch from one authorized telemetry source. Scope is never on the wire. */
export type TopologyInterfaceMetricEnvelopeV1 = z.infer<typeof topologyInterfaceMetricEnvelopeV1Schema>;
export type TopologyInterfaceHistoryQuery = z.infer<typeof topologyInterfaceHistoryQuerySchema>;
export type TopologyInterfaceHistorySeries = z.infer<typeof topologyInterfaceHistorySeriesSchema>;
export type TopologyInterfaceHistoryResponse = z.infer<typeof topologyInterfaceHistoryResponseSchema>;
export type TopologyInterfaceHistoryEpoch = z.infer<typeof topologyInterfaceHistoryEpochSchema>;
/** One endpoint interface's current measurement assessment. */
export type TopologyInterfaceMeasurement = z.infer<typeof topologyInterfaceMeasurementSchema>;
export type TopologyLinkHealthResponse = z.infer<typeof topologyLinkHealthResponseSchema>;
/** Server-built `topology_interface_poll` command payload (see the validator for the contract). */
export type TopologyInterfacePollCommandV1 = z.infer<typeof topologyInterfacePollCommandV1Schema>;
