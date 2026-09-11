import { Hono } from 'hono';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { PERMISSIONS } from '../../services/permissions';
import { contractLinesCoveringDevice, DeviceCoverageError } from '../../services/deviceCoverage';

export const billingRoutes = new Hono();

billingRoutes.use('*', authMiddleware);

// GET /devices/:id/billing — which active contract lines bill this device (#3205 W06).
// Gated on devices:read AND contracts:read: contract_lines.description is
// operator-authored free text that routinely carries the rate, so this is
// billing data wearing a device URL. requireScope matches every contracts read
// route (routes/contracts/contracts.ts:16) — organization-scoped users cannot
// read contract data anywhere today, and this route is not the exception.
// API keys are excluded by construction: API_KEY_SCOPE_POLICIES
// (services/apiKeyScopes.ts:3-34) has no contracts:read scope to grant.
billingRoutes.get(
  '/:id/billing',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    // The ONLY site-axis gate (the allowlist lives in the permissions context,
    // not in accessibleOrgIds). The service re-checks the org for non-route callers.
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      // One 404 body shape for BOTH sources (here and the service's own org
      // check). Sibling device routes return a bare { error }; a client that
      // must branch on `code` for the 500 should not also branch on shape here.
      return c.json({ error: 'Device not found', code: 'DEVICE_NOT_FOUND' }, 404);
    }

    try {
      const data = await contractLinesCoveringDevice(deviceId, { accessibleOrgIds: auth.accessibleOrgIds });
      return c.json({ data });
    } catch (err) {
      // A group we cannot evaluate is an ERROR, never an empty list (#3205 W02
      // decision 3): reporting "not billed" for an unevaluable group is the
      // silent zero this feature exists to prevent. No error path returns `lines`.
      if (err instanceof DeviceCoverageError) {
        return c.json(
          { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
          err.status,
        );
      }
      throw err;
    }
  },
);
