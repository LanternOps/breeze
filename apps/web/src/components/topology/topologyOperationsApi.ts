import { z } from 'zod';
import { topologyChangePageSchema, topologyImpactResponseSchema } from '@breeze/shared/validators/topologyInvestigation';
import {
  topologyMonitoringStatusSchema, topologyPolicyArmStateSchema, topologyTelemetryArmSchema,
} from '@breeze/shared/validators/topologyMonitoring';
import { topologyPolicyDefinitionSchema } from '@breeze/shared/validators/topologyConfiguration';
import { topologyRead } from './topologyApi';

/**
 * M3 operational reads and human-only arming writes (Task 11).
 *
 * Every read here is passive on the server: impact, change history, monitoring
 * status and policy listing never probe, poll or queue a command. The human-only
 * arming writes live inline in their panels, each inside `runAction`.
 */
export const topologySitePath = (siteId: string) => `/topology/sites/${encodeURIComponent(siteId)}`;

/** The stored site policy row as the policies list serves it; only the fields the UI reads are validated. */
export const topologyPolicyRowSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1).max(64),
  revision: z.string().regex(/^(0|[1-9]\d*)$/),
  enabled: z.boolean(),
  activationIntent: z.boolean().optional(),
  blockedReason: z.string().nullable().optional(),
  subjectNodeId: z.string().uuid().nullable().optional(),
  subjectRelationshipId: z.string().uuid().nullable().optional(),
  definition: topologyPolicyDefinitionSchema,
});
export type TopologyPolicyRow = z.infer<typeof topologyPolicyRowSchema>;
const policyListSchema = z.object({ items: z.array(topologyPolicyRowSchema).max(200), nextCursor: z.string().nullable() });

/** Same-site discovery profiles that could lend SNMP credentials to a telemetry arm. */
const discoveryProfileSchema = z.object({
  id: z.string().uuid(), siteId: z.string().uuid().nullable(), name: z.string(), enabled: z.boolean(), methods: z.array(z.string()).nullable().optional(),
});
export type TopologyCredentialProfile = z.infer<typeof discoveryProfileSchema>;
const discoveryProfileListSchema = z.object({ data: z.array(discoveryProfileSchema) });

/** Same-site managed devices (agents) that could poll a switch; the arm route re-checks eligibility. */
const siteDeviceSchema = z.object({ id: z.string().uuid(), hostname: z.string().nullable().optional(), displayName: z.string().nullable().optional(), status: z.string().nullable().optional() });
const siteDeviceListSchema = z.union([z.object({ data: z.array(siteDeviceSchema) }), z.object({ devices: z.array(siteDeviceSchema) })]);
export type TopologySiteAgent = { deviceId: string; label: string };

export type ImpactSubject = { kind: 'node' | 'relationship'; id: string };

export const topologyOperationsApi = {
  monitoring: (siteId: string, signal?: AbortSignal) => topologyRead(`${topologySitePath(siteId)}/monitoring`, topologyMonitoringStatusSchema, signal),
  policies: (siteId: string, signal?: AbortSignal) => topologyRead(`${topologySitePath(siteId)}/policies?limit=200`, policyListSchema, signal),
  impact: (siteId: string, subject: ImpactSubject, graphRevision: string | undefined, windowMinutes: number, signal?: AbortSignal) =>
    topologyRead(`${topologySitePath(siteId)}/impact?${new URLSearchParams({ subjectKind: subject.kind, subjectId: subject.id, windowMinutes: String(windowMinutes),
      ...(graphRevision ? { graphRevision } : {}) })}`, topologyImpactResponseSchema, signal),
  changes: (siteId: string, window: { since: string; until: string }, cursor?: string, signal?: AbortSignal) =>
    topologyRead(`${topologySitePath(siteId)}/changes?${new URLSearchParams({ since: window.since, until: window.until, limit: '50', ...(cursor ? { cursor } : {}) })}`, topologyChangePageSchema, signal),
  siteAgents: async (siteId: string, signal?: AbortSignal): Promise<TopologySiteAgent[]> => {
    const body = await topologyRead(`/devices?${new URLSearchParams({ siteId, limit: '100' })}`, siteDeviceListSchema, signal);
    return ('data' in body ? body.data : body.devices).map((device) => ({ deviceId: device.id, label: device.displayName || device.hostname || device.id }));
  },
  credentialProfiles: async (siteId: string, signal?: AbortSignal) =>
    (await topologyRead('/discovery/profiles', discoveryProfileListSchema, signal)).data
      .filter((profile) => profile.siteId === siteId && profile.enabled && (profile.methods ?? []).includes('snmp')),
};
export const parsePolicyArmState = (data: unknown) => topologyPolicyArmStateSchema.parse(data);
export const parseTelemetryArm = (data: unknown) => topologyTelemetryArmSchema.parse(data);

/** Samples per day an arm would store: one sample per interface per interval (an estimate; the server enforces quotas). */
export function telemetrySamplesPerDay(interfaceCount: number, intervalSeconds: number): number {
  return interfaceCount * Math.floor(86_400 / intervalSeconds);
}
/** Scheduled runs per day for one policy across its contexts and families (before jitter). */
export function policyRunsPerDay(intervalSeconds: number, contexts: number, families: number): number {
  return Math.floor(86_400 / intervalSeconds) * Math.max(1, contexts) * Math.max(1, families);
}
