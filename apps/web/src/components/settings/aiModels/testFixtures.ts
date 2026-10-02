import type { AiModelsSnapshotDto } from '@breeze/shared';

export const CONN = '11111111-1111-4111-8111-111111111111';

export function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

export const SNAPSHOT: AiModelsSnapshotDto = {
  partner: { residencyRequired: false, plan: 'pro', hosted: true },
  connections: [
    { id: null, kind: 'platform', name: 'Breeze platform', status: 'platform', lastError: null, keyLast4: null, inferenceGeo: null, effectiveInferenceGeo: null, inferenceGeoSource: 'provider_default',
      supportedInferenceGeos: ['eu', 'us'], catalogEntryId: null, catalogName: null, configVersion: null, verifiedAt: null,
      lastDiscoveredAt: null, discoveryError: null, funding: 'platform', baseUrl: null, managedBy: null },
    { id: CONN, kind: 'anthropic_byok', name: 'Anthropic', status: 'active', lastError: null, keyLast4: '7890', inferenceGeo: null, effectiveInferenceGeo: null, inferenceGeoSource: 'provider_default',
      supportedInferenceGeos: ['eu'], catalogEntryId: null, catalogName: null, configVersion: 2, verifiedAt: '2026-10-01T00:00:00.000Z',
      lastDiscoveredAt: null, discoveryError: null, funding: 'partner_key', baseUrl: null, managedBy: null },
  ],
  offerings: [], defaults: [], catalog: [], catalogEnabled: false,
};

export const GW = '44444444-4444-4444-8444-444444444444';

export const GATEWAY_CONNECTION: AiModelsSnapshotDto['connections'][number] = {
  id: GW, kind: 'openai_compatible', name: 'Office vLLM', status: 'active', lastError: null, keyLast4: '1234', inferenceGeo: null,
  effectiveInferenceGeo: null, inferenceGeoSource: 'provider_default', supportedInferenceGeos: [], catalogEntryId: null, catalogName: null,
  configVersion: 3, verifiedAt: null, lastDiscoveredAt: null, discoveryError: null, funding: 'partner_key',
  baseUrl: 'https://llm.example.com/v1', managedBy: null,
};
