/**
 * `get_device_billing` (full-control W14, #6784, t1): the AI twin of
 * GET /devices/:id/billing (routes/devices/billing.ts) — which active contract
 * lines bill one device — through the same service (deviceCoverage.ts).
 *
 * REST parity: partner or system scope, devices:read AND contracts:read
 * (contract-line descriptions routinely carry the rate; TOOL_EXTRA_PERMISSIONS),
 * the central device gate (`deviceArgs` + `verifyDeviceAccess`: org, site,
 * exact device). A group that cannot be evaluated is an ERROR, never an empty
 * list (#3205 W02 decision 3).
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { DeviceCoverageError, contractLinesCoveringDevice } from './deviceCoverage';
import { bounded, jsonError, thrown } from './aiToolsSoftwareShared';

function scopeRefusal(auth: AuthContext): string | null {
  if (auth.scope === 'system' || (auth.scope === 'partner' && auth.partnerId)) return null;
  return jsonError('Device billing needs a partner-scoped session; organization-scoped callers cannot read contract data anywhere', 'PARTNER_SCOPE_REQUIRED');
}

export function registerDeviceBillingTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('get_device_billing', {
    tier: 1,
    domain: 'billing',
    searchHint: 'which contract lines bill one device, or why it is not billed',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'get_device_billing',
      description: 'Which active contract lines bill one device (per-device, role or group lines), or why it is not billable. Prices use each contract currencyCode.',
      input_schema: {
        type: 'object' as const,
        properties: { deviceId: { type: 'string', description: 'Device UUID' } },
        required: ['deviceId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const refusal = scopeRefusal(auth);
      if (refusal) return refusal;
      if (typeof input.deviceId !== 'string') return jsonError('deviceId is required', 'VALIDATION_ERROR');
      try {
        const access = await verifyDeviceAccess(input.deviceId, auth);
        if ('error' in access) return jsonError(access.error, 'NOT_FOUND');
        const billing = await contractLinesCoveringDevice(input.deviceId, { accessibleOrgIds: auth.accessibleOrgIds });
        return bounded({ billing });
      } catch (error) {
        if (error instanceof DeviceCoverageError) {
          return JSON.stringify({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
        }
        return thrown('get_device_billing', error);
      }
    },
  });
}
