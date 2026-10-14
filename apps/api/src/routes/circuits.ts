/**
 * Circuits API. Spec §8.3 (circuit writes) and §8.4 (read DTO).
 *
 * GET    /circuits
 * POST   /circuits
 * GET    /circuits/:id
 * PATCH  /circuits/:id
 * DELETE /circuits/:id
 * PUT    /circuits/:id/termination        { interfaceId }
 * DELETE /circuits/:id/termination
 * PUT    /circuits/:id/served-sites       { siteIds }
 *
 * Termination and served-site writes also require topology write access to each
 * affected site, so a technician cannot terminate a circuit on an interface at a
 * site they cannot write.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { db } from '../db';
import { topologyInterfaces } from '../db/schema';
import { PERMISSIONS, getUserPermissions, type UserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { requireTopologySiteAccess, TopologyError } from '../services/topology/access';
import {
  CircuitError,
  circuitBodySchema,
  circuitPatchSchema,
  clearCircuitTermination,
  createCircuit,
  deleteCircuit,
  getCircuitDto,
  listCircuitDtos,
  servedSitesBodySchema,
  setCircuitServedSites,
  setCircuitTermination,
  terminationBodySchema,
  updateCircuit,
} from '../services/circuits';
import type { Context } from 'hono';

export const circuitRoutes = new Hono();

circuitRoutes.use('*', authMiddleware);

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireDevicesWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
const scopes = requireScope('organization', 'partner', 'system');

/** Topology write access to one site, using the same boundary as the topology routes. */
export async function assertTopologySiteWrite(c: Context, siteId: string): Promise<void> {
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
  await requireTopologySiteAccess(auth, permissions, siteId, 'write');
}

function handleError(c: Context, err: unknown) {
  if (err instanceof CircuitError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof TopologyError) return c.json({ error: err.message, code: err.code }, err.status as 403);
  throw err;
}

circuitRoutes.get('/', scopes, requireDevicesRead, async (c) => {
  return c.json({ data: await listCircuitDtos() });
});

circuitRoutes.post('/', scopes, requireDevicesWrite, requireMfa(), zValidator('json', circuitBodySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const orgId = auth.orgId;
  if (!orgId) return c.json({ error: 'An organization context is required to create a circuit' }, 400);
  const dto = await createCircuit(orgId, c.req.valid('json'));
  writeRouteAudit(c, { orgId, action: 'circuit.create', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { after: dto } });
  return c.json(dto, 201);
});

circuitRoutes.get('/:id', scopes, requireDevicesRead, async (c) => {
  const dto = await getCircuitDto(c.req.param('id')!);
  if (!dto) return c.json({ error: 'Circuit not found' }, 404);
  return c.json(dto);
});

circuitRoutes.patch('/:id', scopes, requireDevicesWrite, requireMfa(), zValidator('json', circuitPatchSchema), async (c) => {
  try {
    const before = await getCircuitDto(c.req.param('id')!);
    if (!before) return c.json({ error: 'Circuit not found' }, 404);
    const dto = await updateCircuit(before.id, c.req.valid('json'));
    writeRouteAudit(c, { orgId: dto.orgId, action: 'circuit.update', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { before, after: dto } });
    return c.json(dto);
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.delete('/:id', scopes, requireDevicesWrite, requireMfa(), async (c) => {
  try {
    const before = await getCircuitDto(c.req.param('id')!);
    if (!before) return c.json({ error: 'Circuit not found' }, 404);
    await deleteCircuit(before.id);
    writeRouteAudit(c, { orgId: before.orgId, action: 'circuit.delete', resourceType: 'circuit', resourceId: before.id, resourceName: before.cid, details: { before } });
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.put('/:id/termination', scopes, requireDevicesWrite, requireMfa(), zValidator('json', terminationBodySchema), async (c) => {
  try {
    const circuit = await getCircuitDto(c.req.param('id')!);
    if (!circuit) return c.json({ error: 'Circuit not found' }, 404);
    const { interfaceId } = c.req.valid('json');
    const [iface] = await db.select({ siteId: topologyInterfaces.siteId }).from(topologyInterfaces).where(eq(topologyInterfaces.id, interfaceId)).limit(1);
    if (!iface) return c.json({ error: 'Interface not found', code: 'INTERFACE_NOT_FOUND' }, 404);
    await assertTopologySiteWrite(c, iface.siteId);
    const before = circuit.termination;
    const dto = await setCircuitTermination(circuit.id, interfaceId);
    writeRouteAudit(c, { orgId: dto.orgId, action: 'circuit.termination.set', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { before, after: dto.termination } });
    return c.json(dto);
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.delete('/:id/termination', scopes, requireDevicesWrite, requireMfa(), async (c) => {
  try {
    const circuit = await getCircuitDto(c.req.param('id')!);
    if (!circuit) return c.json({ error: 'Circuit not found' }, 404);
    if (circuit.termination) await assertTopologySiteWrite(c, circuit.termination.primarySite.id);
    const dto = await clearCircuitTermination(circuit.id);
    writeRouteAudit(c, { orgId: dto.orgId, action: 'circuit.termination.clear', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { before: circuit.termination } });
    return c.json(dto);
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.put('/:id/served-sites', scopes, requireDevicesWrite, requireMfa(), zValidator('json', servedSitesBodySchema), async (c) => {
  try {
    const circuit = await getCircuitDto(c.req.param('id')!);
    if (!circuit) return c.json({ error: 'Circuit not found' }, 404);
    const { siteIds } = c.req.valid('json');
    for (const siteId of new Set(siteIds)) {
      await assertTopologySiteWrite(c, siteId);
    }
    const before = circuit.additionalServedSites;
    const dto = await setCircuitServedSites(circuit.id, siteIds);
    writeRouteAudit(c, { orgId: dto.orgId, action: 'circuit.served_sites.set', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { before, after: dto.additionalServedSites } });
    return c.json(dto);
  } catch (err) {
    return handleError(c, err);
  }
});
