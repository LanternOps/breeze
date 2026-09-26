import { z } from 'zod';
import { graphNodeSchema, graphRelationshipSchema, graphResponseSchema, relationshipDetailResponseSchema, relationshipEvidenceResponseSchema, topologyViewSchema } from '@breeze/shared/validators/topology';
import { fetchWithAuth } from '../../stores/auth';
const capability = z.object({ available: z.boolean(), reason: z.string().nullable() });
export const topologySettingsSchema = z.object({
  siteId: z.string().uuid(), settingsRevision: z.string(),
  capabilities: z.object({ ui: capability, diagnostics: capability, physical: capability, collection: capability }),
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
 * Hidden connections of one view (M2 D17, Task 8 route GET /topology/sites/:siteId/exclusions?view=).
 * TODO(M2 Task 8 integration): confirm the list key/cursor names against the
 * landed route and tighten this to its shared schema; both spellings are
 * accepted until then so the UI never silently shows "Hidden (0)".
 */
const hiddenConnectionSchema = z.object({
  id: z.string().uuid(), relationshipId: z.string().uuid(), view: topologyViewSchema,
  reason: z.string().min(1).max(500), createdAt: z.string().nullable().optional().transform((value) => value ?? null),
});
export type HiddenConnection = z.infer<typeof hiddenConnectionSchema>;
export const topologyExclusionListSchema = z.union([
  z.object({ exclusions: z.array(hiddenConnectionSchema), cursor: z.string().nullable().optional() }),
  z.object({ items: z.array(hiddenConnectionSchema), nextCursor: z.string().nullable().optional() }),
]).transform((body) => 'exclusions' in body
  ? { items: body.exclusions, cursor: body.cursor ?? null }
  : { items: body.items, cursor: body.nextCursor ?? null });
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
};
