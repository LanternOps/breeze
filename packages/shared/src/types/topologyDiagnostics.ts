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

import type { topologyTraceHopSchema, topologyTraceDetailsSchema, topologyTraceRequestOptionsSchema } from '../validators/topologyDiagnostics';
export type TopologyTraceHop = z.infer<typeof topologyTraceHopSchema>;
export type TopologyTraceDetails = z.infer<typeof topologyTraceDetailsSchema>;
export type TopologyTraceRequestOptions = z.infer<typeof topologyTraceRequestOptionsSchema>;

/**
 * Read model for one traced step. `kind` is deliberately distinct from any
 * topology relationship path: a routed trace is observed ICMP evidence from one
 * origin at one moment, not discovered topology, and is never materialized.
 */
export type TopologyTraceView = {
  kind: 'observed_routed_path';
  stepId: string;
  state: TopologyDiagnosticStep['state'] | null;
  reason: string | null;
  requestedMethod: 'trace';
  actualMethod: string | null;
  protocol: TopologyTraceDetails['protocol'] | null;
  origin: { deviceId: string; agentId: string; contextKey: string | null; interfaceId: string | null; localAddress: string | null; sourceId: string };
  destination: { destinationId: string | null; address: string | null; family: 'ipv4' | 'ipv6' | null };
  attributionQuality: 'observed' | 'requested_unverified' | 'unknown';
  routeChanged: boolean;
  destinationReached: boolean;
  maxHops: number;
  probesPerHop: number;
  hops: Array<{
    ttl: number;
    responders: Array<{ address: string; attempts: number[]; rttMs: Array<number | null>; outcome: 'reply' | 'unreachable'; attributionQuality: TopologyTraceHop['attributionQuality'] }>;
    gaps: Array<{ attempt: number; outcome: 'timeout' | 'unsupported' | 'unreachable' }>;
    alternatives: boolean;
  }>;
  truncated: boolean;
  hopsOmitted: number;
};
