import { z } from 'zod';
import { EdrProviderRequestError, type EdrProviderAdapter } from '../types';
import { EMSISOFT_HOST_ALLOWLIST } from './client';

const credentialsSchema = z.object({ apiKey: z.string().trim().min(16).max(512) }).strict(); // [U] align min with a real key

const notImplemented = (): never => {
  throw new EdrProviderRequestError('Emsisoft adapter method not implemented', {
    code: 'not_implemented', reauth: false, scope: 'connection',
  });
};

export const emsisoftAdapter: EdrProviderAdapter = {
  key: 'emsisoft',
  label: 'Emsisoft',
  credentialsSchema,
  credentialFields: [{ name: 'apiKey', label: 'API key', secret: true, required: true }],
  baseUrlPolicy: null,
  hostAllowlist: EMSISOFT_HOST_ALLOWLIST,
  capabilities: {
    tenantModel: 'partner', // Open Decision 1 (Gate B: (a))
    perTenantHost: false,
    detectionDelivery: 'poll', // the vendor has no webhooks
    detectionStatusModel: 'delta_with_updates', // becomes 'reread_open_on_inventory' in A5
    actions: [], // PR-B
    endpointIdentifiers: ['hostname', 'fqdn'], // no mac / serial -> strict matching (A3); ip is never an identifier
    installer: 'none', // W06
    requestBudget: { perSecond: 2, perMinute: 60 }, // undocumented vendor limit: conservative, revisit after A11
    defaultIntervals: { detectionsMinutes: 15, inventoryMinutes: 60 },
    maxActionTargets: 1,
    firstSyncLookbackDays: 30,
    tenantFetchConcurrency: 1,
  },
  testConnection: async () => notImplemented(),
  listTenants: async () => notImplemented(),
  listEndpoints: async () => notImplemented(),
  listDetections: async () => notImplemented(),
};
