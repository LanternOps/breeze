/**
 * Interface role mutation (spec §8.2): PATCH /topology/interfaces/:id/role { role: 'wan' | null }.
 * Site write access is checked against the interface's own site, not a path param.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { topologyInterfaces } from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { CircuitError, interfaceRoleBodySchema, setInterfaceWanRole } from '../../services/circuits';
import { requireTopologySiteAccess, TopologyError } from '../../services/topology/access';
import { getUserPermissions, type UserPermissions } from '../../services/permissions';
import { requireMfa, type AuthContext } from '../../middleware/auth';

export const topologyInterfaceRoleRoutes = new Hono();

topologyInterfaceRoleRoutes.patch('/interfaces/:id/role', requireMfa(), zValidator('json', interfaceRoleBodySchema), async (c) => {
  try {
    const interfaceId = c.req.param('id')!;
    const [current] = await db
      .select({ id: topologyInterfaces.id, orgId: topologyInterfaces.orgId, siteId: topologyInterfaces.siteId, role: topologyInterfaces.role, name: topologyInterfaces.name })
      .from(topologyInterfaces)
      .where(eq(topologyInterfaces.id, interfaceId))
      .limit(1);
    if (!current) return c.json({ error: 'Interface not found', code: 'INTERFACE_NOT_FOUND' }, 404);

    const auth = c.get('auth') as AuthContext;
    let permissions = c.get('permissions') as UserPermissions | undefined;
    if (!permissions) {
      permissions = (await getUserPermissions(auth.user.id, {
        partnerId: auth.partnerId ?? undefined,
        orgId: auth.orgId ?? undefined,
        scope: auth.scope,
      })) ?? undefined;
    }
    if (!permissions) throw new TopologyError('topology_permission_denied', 403, 'Topology permission denied');
    await requireTopologySiteAccess(auth, permissions, current.siteId, 'write');
    const { role } = c.req.valid('json');
    const updated = await setInterfaceWanRole(interfaceId, role);

    writeRouteAudit(c, {
      orgId: current.orgId,
      action: 'topology.interface.role.update',
      resourceType: 'topology_interface',
      resourceId: current.id,
      resourceName: current.name ?? current.id,
      details: { before: { role: current.role }, after: { role: updated.role } },
    });
    return c.json({ id: updated.id, siteId: updated.siteId, role: updated.role });
  } catch (err) {
    if (err instanceof CircuitError) return c.json({ error: err.message, code: err.code }, err.status);
    if (err instanceof TopologyError) return c.json({ error: err.message, code: err.code }, err.status as 403);
    throw err;
  }
});
