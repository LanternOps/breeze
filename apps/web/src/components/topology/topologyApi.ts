import { z } from 'zod';
import { graphNodeSchema, graphRelationshipSchema, graphResponseSchema, relationshipDetailResponseSchema, relationshipEvidenceResponseSchema, topologyViewSchema } from '@breeze/shared/validators/topology';
import { topologyInterfaceHistoryResponseSchema, topologyLinkHealthResponseSchema } from '@breeze/shared/validators/topologyTelemetry';
import type { TopologyInterfaceHistoryQuery } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
const capability = z.object({ available: z.boolean(), reason: z.string().nullable() });
export const topologySettingsSchema = z.object({
  siteId: z.string().uuid(), settingsRevision: z.string(),
  capabilities: z.object({ ui: capability, diagnostics: capability, physical: capability, collection: capability,
    /** M3 (optional for pre-M3 servers): port measurement and recurring monitoring. Absent = unavailable. */
    interfaceHealth: capability.optional(), recurringMonitoring: capability.optional(),
    /** M4 (optional for pre-M4 servers): flags + provider + org AI policy (M4-D4). Absent = unavailable. */
    ai: capability.optional() }),
  /** Per-site authority (execute/configure + satisfied MFA). The graph projection does not compute these. */
  permissions: z.object({ canEdit: z.boolean(), canDiagnose: z.boolean(), canConfigureMonitoring: z.boolean() }).optional(),
});
export type TopologySettings = z.infer<typeof topologySettingsSchema>;
export class TopologyReadError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function topologyRead<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetchWithAuth(path, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
    const message = response.status === 403 ? 'Access to this topology is denied'
      : typeof body?.code === 'string' && body.code === 'target_not_configured' ? 'Target not configured'
      : typeof body?.error === 'string' ? body.error : 'Unable to load topology';
    throw new TopologyReadError(message, response.status);
  }
  return schema.parse(await response.json());
}
export const topologyHealthSchema = z.object({
  siteId: z.string().uuid(), graphRevision: z.string(), healthRevision: z.string(),
  nodes: z.array(z.object({ id: z.string().uuid(), health: graphNodeSchema.shape.health })),
  relationships: z.array(z.object({ id: z.string().uuid(), health: graphRelationshipSchema.shape.health })),
});
export const topologyNodeListSchema = z.object({ siteId: z.string().uuid(), graphRevision: z.string(), total: z.number(), nodes: z.array(graphNodeSchema), cursor: z.string().nullable() });
/**
 * Hidden connections of one view: GET /topology/sites/:siteId/exclusions?view=
 * (M2 D17). Mirrors the API's `ViewExclusionPage` from
 * services/topology/exclusions.ts `listViewExclusions`; the list carries only
 * ACTIVE exclusions, so a revoked row is a contract violation, not a hidden one.
 */
const hiddenConnectionSchema = z.object({
  id: z.string().uuid(), relationshipId: z.string().uuid(), view: topologyViewSchema,
  reason: z.string().min(1).max(500), active: z.literal(true), createdAt: z.string().datetime({ offset: true }),
  createdBy: z.string().uuid().nullable(), revokedAt: z.null(), revokedBy: z.null(),
  relationship: z.object({
    id: z.string().uuid(), kind: z.string(), sourceNodeId: z.string().uuid(), targetNodeId: z.string().uuid(),
    sourceInterfaceId: z.string().uuid().nullable(), targetInterfaceId: z.string().uuid().nullable(),
    evidenceClass: z.string(), lifecycle: z.string(),
  }),
});
export type HiddenConnection = z.infer<typeof hiddenConnectionSchema>;
export const topologyExclusionListSchema = z.object({
  view: topologyViewSchema, graphRevision: z.string().regex(/^(0|[1-9]\d*)$/),
  items: z.array(hiddenConnectionSchema).max(200), nextCursor: z.string().nullable(),
}).transform((body) => ({ view: body.view, graphRevision: body.graphRevision, items: body.items, cursor: body.nextCursor }));
const site = (siteId: string) => `/topology/sites/${encodeURIComponent(siteId)}`;
export const topologyApi = {
  relationship: (siteId: string, relationshipId: string, signal?: AbortSignal) =>
    topologyRead(`${site(siteId)}/relationships/${encodeURIComponent(relationshipId)}`, relationshipDetailResponseSchema, signal),
  evidence: (siteId: string, relationshipId: string, cursor?: string, signal?: AbortSignal) =>
    topologyRead(`${site(siteId)}/relationships/${encodeURIComponent(relationshipId)}/evidence?${new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) })}`, relationshipEvidenceResponseSchema, signal),
  exclusions: (siteId: string, view: string, cursor?: string, signal?: AbortSignal) =>
    topologyRead(`${site(siteId)}/exclusions?${new URLSearchParams({ view, limit: '100', ...(cursor ? { cursor } : {}) })}`, topologyExclusionListSchema, signal),
  graph: (siteId: string, query: URLSearchParams, signal?: AbortSignal) => topologyRead(`/topology/sites/${encodeURIComponent(siteId)}/graph?${query}`, graphResponseSchema, signal),
  settings: (siteId: string, signal?: AbortSignal) => topologyRead(`/topology/sites/${encodeURIComponent(siteId)}/settings`, topologySettingsSchema, signal),
  /** Bounded port history (M3 Task 6). A read never polls; the server picks the bucketing. */
  interfaceHistory: (siteId: string, interfaceId: string, query: InterfaceHistoryParams, signal?: AbortSignal) =>
    topologyRead(`${site(siteId)}/interfaces/${encodeURIComponent(interfaceId)}/history?${interfaceHistoryParams(query)}`, topologyInterfaceHistoryResponseSchema, signal),
  /** Current link health with each endpoint port's own measurement (M3 Task 6). */
  linkHealth: (siteId: string, relationshipId: string, signal?: AbortSignal) =>
    topologyRead(`${site(siteId)}/relationships/${encodeURIComponent(relationshipId)}/health`, topologyLinkHealthResponseSchema, signal),
};
export type InterfaceHistoryParams = Pick<TopologyInterfaceHistoryQuery, 'series' | 'from' | 'to'> & Partial<Pick<TopologyInterfaceHistoryQuery, 'resolution' | 'maxBuckets'>>;
export function interfaceHistoryParams(query: InterfaceHistoryParams): URLSearchParams {
  return new URLSearchParams({ series: query.series.join(','), from: query.from, to: query.to,
    ...(query.resolution ? { resolution: query.resolution } : {}), ...(query.maxBuckets ? { maxBuckets: String(query.maxBuckets) } : {}) });
}
