import { z } from 'zod';
import { graphNodeSchema, graphRelationshipSchema, graphResponseSchema } from '@breeze/shared/validators/topology';
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
export const topologyApi = {
  graph: (siteId: string, query: URLSearchParams, signal?: AbortSignal) => topologyRead(`/topology/sites/${encodeURIComponent(siteId)}/graph?${query}`, graphResponseSchema, signal),
  settings: (siteId: string, signal?: AbortSignal) => topologyRead(`/topology/sites/${encodeURIComponent(siteId)}/settings`, topologySettingsSchema, signal),
};
