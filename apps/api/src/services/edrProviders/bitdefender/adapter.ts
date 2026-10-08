import { z } from 'zod';
import type { EdrProviderAdapter } from '../types';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

/** STUB — replaced by the real GravityZone adapter in Task 12. */
export const bitdefenderAdapter: EdrProviderAdapter = {
  key: 'bitdefender',
  label: 'Bitdefender GravityZone',
  credentialsSchema: z.object({ apiKey: z.string().trim().min(16).max(512) }).strict(),
  credentialFields: [{ name: 'apiKey', label: 'API key', secret: true, required: true }],
  baseUrlPolicy: { required: true, pathPrefix: '/api' },
  hostAllowlist: ['.gravityzone.bitdefender.com'],
  capabilities: {
    tenantModel: 'partner',
    perTenantHost: false,
    detectionDelivery: 'poll',
    detectionStatusModel: 'reread_open_on_inventory',
    actions: [],
    endpointIdentifiers: ['hostname', 'fqdn', 'mac', 'ip'],
    installer: 'none',
    requestBudget: { perSecond: 10 },
    operationBudgets: {
      inventory: { perSecond: 5 },
      companies: { perSecond: 5 },
      incidents: { perMinute: 10 },
    },
    defaultIntervals: { detectionsMinutes: 10, inventoryMinutes: 60 },
    maxActionTargets: 0,
    firstSyncLookbackDays: 30,
    tenantFetchConcurrency: 4,
  },
  testConnection: async () => notImplemented(),
  listTenants: async () => notImplemented(),
  listEndpoints: async () => notImplemented(),
  listDetections: async () => notImplemented(),
};
