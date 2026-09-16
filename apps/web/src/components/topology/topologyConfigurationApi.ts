import { topologySiteSettingsSchema, topologyTemplateOptionsSchema, topologyTemplatePreviewRequestSchema, topologySiteSettingsPatchSchema } from '@breeze/shared/validators/topologyConfiguration';
import type { TopologyTemplatePreviewRequest } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { topologyRead } from './topologyApi';
export const topologyConfigurationApi = {
  settings: (siteId: string, signal?: AbortSignal) => topologyRead(`/topology/sites/${siteId}/settings`, topologySiteSettingsSchema, signal),
  options: (siteId: string, cursor?: string, signal?: AbortSignal) => topologyRead(`/topology/sites/${siteId}/template-options${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, topologyTemplateOptionsSchema, signal),
  previewResponse: (request: TopologyTemplatePreviewRequest) => fetchWithAuth('/topology/template-applications/preview', { method: 'POST', body: JSON.stringify(topologyTemplatePreviewRequestSchema.parse(request)) }),
  applyResponse: (token: string, idempotencyKey: string) => fetchWithAuth('/topology/template-applications', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ token }) }),
  saveResponse: (siteId: string, request: unknown) => fetchWithAuth(`/topology/sites/${siteId}/settings`, { method: 'PATCH', body: JSON.stringify(topologySiteSettingsPatchSchema.parse(request)) }),
};
