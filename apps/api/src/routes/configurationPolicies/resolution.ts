import type { Context } from 'hono';
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq, inArray } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { db } from '../../db';
import { configurationPolicies, devices } from '../../db/schema';
import {
  resolveEffectiveConfig,
  previewEffectiveConfig,
  type EffectiveConfiguration,
} from '../../services/configurationPolicy';
import { getPolicyBaselineDefaults } from '../../services/policyBaselineDefaults';
import { diffSchema, deviceIdParamSchema } from './schemas';

export const resolutionRoutes = new Hono();
const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

/**
 * Site-scope gate: partner-scope users restricted via `allowedSiteIds` must
 * not resolve config for devices in sites they cannot access. RLS does not
 * defend the site axis — mirrors PR #864/#868 (SP2 launch-readiness sweep).
 * Returns true when access is granted, false when denied.
 */
async function canAccessDeviceSite(c: Context, deviceId: string): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  const [device] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return { ok: false, status: 404 };
  const userPerms = c.get('permissions') as UserPermissions | undefined;
  if (userPerms?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId))) {
    return { ok: false, status: 403 };
  }
  return { ok: true };
}

export type PolicyOwner = 'organization' | 'partner';

/**
 * Who owns each policy the effective config names (#12306 W01a, plan D4), so
 * the web links a policy only where the caller can open it.
 *
 * Keys are every winning `sourcePolicyId` and every chain `policyId`, minus the
 * synthesized Breeze Defaults layer (`'default'` level; its sentinel id is not a
 * uuid and would break the IN list). One select on the ambient `db`, so it runs
 * in the caller's own request context: an id that context cannot read gets no
 * key, and the web then treats the owner as unknown and does not link. For an
 * org-scope caller that is every partner-owned policy, since RLS hides those
 * rows from org contexts. Built here, after the resolver, so
 * `resolveEffectiveConfig` and its AI callers keep their output.
 */
async function loadPolicyOwners(result: EffectiveConfiguration): Promise<Record<string, PolicyOwner>> {
  const ids = new Set<string>();
  for (const feature of Object.values(result.features)) {
    if (feature.sourceLevel !== 'default') ids.add(feature.sourcePolicyId);
  }
  for (const entry of result.inheritanceChain) {
    if (entry.level !== 'default') ids.add(entry.policyId);
  }

  const owners: Record<string, PolicyOwner> = {};
  if (ids.size === 0) return owners;

  const rows = await db
    .select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId })
    .from(configurationPolicies)
    .where(inArray(configurationPolicies.id, [...ids]));
  for (const row of rows) {
    if (!ids.has(row.id)) continue;
    owners[row.id] = row.orgId === null ? 'partner' : 'organization';
  }
  return owners;
}

// GET /baseline — static "Breeze Defaults" registry (read-only, no tenant data)
resolutionRoutes.get(
  '/baseline',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  (c) => c.json({ features: getPolicyBaselineDefaults() })
);

// GET /effective/:deviceId — resolve effective configuration
resolutionRoutes.get(
  '/effective/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { deviceId } = c.req.valid('param');

    const access = await canAccessDeviceSite(c, deviceId);
    if (!access.ok) {
      if (access.status === 403) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await resolveEffectiveConfig(deviceId, auth, { includeBaseline: true });
    if (!result) return c.json({ error: 'Device not found or access denied' }, 404);

    const policyOwners = await loadPolicyOwners(result);
    return c.json({ ...result, policyOwners });
  }
);

// POST /effective/:deviceId/diff — preview changes
resolutionRoutes.post(
  '/effective/:deviceId/diff',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', deviceIdParamSchema),
  zValidator('json', diffSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { deviceId } = c.req.valid('param');
    const changes = c.req.valid('json');

    const access = await canAccessDeviceSite(c, deviceId);
    if (!access.ok) {
      if (access.status === 403) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await previewEffectiveConfig(deviceId, changes, auth);
    if (!result) return c.json({ error: 'Device not found or access denied' }, 404);

    return c.json(result);
  }
);
