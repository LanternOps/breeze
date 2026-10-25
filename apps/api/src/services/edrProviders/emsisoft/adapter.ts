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
    detectionStatusModel: 'reread_open_on_inventory', // Open Decision 2 (Gate B: (c)): incidents have no change cursor and no closed state
    actions: [], // PR-B
    endpointIdentifiers: ['hostname', 'fqdn'], // no mac / serial -> strict matching (A3); ip is never an identifier
    installer: 'none', // W06
    requestBudget: { perSecond: 2, perMinute: 60 }, // undocumented vendor limit: conservative, revisit after A11
    defaultIntervals: { detectionsMinutes: 15, inventoryMinutes: 60 },
    maxActionTargets: 1,
    firstSyncLookbackDays: 30,
    tenantFetchConcurrency: 1,
    // Columns only the per-device detail call fills; the device list never overwrites them.
    detailOwnedFields: ['fqdn', 'ipAddresses', 'osPlatform', 'osName', 'endpointType', 'online', 'health', 'agentVersion'],
    // inventory: device pages (~2) + up to DETAIL_ENRICH_PER_RUN (50) details + re-read (<= 20)
    // detection: incident pages (~1) + device-name pages for attribution (~2)
    estimatedCalls: { perTenantDetection: 3, perTenantInventory: 72, perConnectionOverhead: 2 },
    rereadOpenPerRun: 20,
  },
  testConnection: async () => notImplemented(),
  listTenants: async () => notImplemented(),
  listEndpoints: async () => notImplemented(),
  listDetections: async () => notImplemented(),
  rereadDetectionStatus: async () => notImplemented(),
};
