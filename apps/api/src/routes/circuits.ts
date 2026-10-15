/**
 * Circuits API. Spec §7.2 (site-scoped technicians), §8.3 (circuit writes) and
 * §8.4 (read DTO).
 *
 * GET    /circuits                         ?limit&cursor
 * POST   /circuits
 * GET    /circuits/:id
 * PATCH  /circuits/:id
 * DELETE /circuits/:id
 * PUT    /circuits/:id/termination        { interfaceId }
 * DELETE /circuits/:id/termination
 * PUT    /circuits/:id/served-sites       { siteIds }
 *
 * Site rule (spec §7.2): a circuit with a current termination is visible through
 * its primary site; a circuit without one is visible to a restricted caller only
 * through an accessible served site. A circuit the caller cannot see is reported
 * as not found, and served-site names are returned only for accessible sites.
 * Writes require topology write access to the current primary site when assigned,
 * plus every site being added or removed. A restricted caller who lacks access to
 * a site involved in the write gets a generic 403 that names no site.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { db } from '../db';
import { circuits as circuitsTable, topologyInterfaces } from '../db/schema';
import { PERMISSIONS, getUserPermissions, type UserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { requireTopologySiteAccess, TopologyError } from '../services/topology/access';
import {
  CircuitError,
  circuitCreateBodySchema,
  circuitDeleteSiteIds,
  circuitListQuerySchema,
  circuitPatchSchema,
  circuitPrimarySiteIds,
  circuitWriteSiteIds,
  canSeeCircuit,
  clearCircuitTermination,
  createCircuit,
  deleteCircuit,
  getCircuitDto,
  listCircuitDtos,
  redactCircuitDto,
  servedSitesBodySchema,
  setCircuitServedSites,
  setCircuitTermination,
  terminationBodySchema,
  updateCircuit,
  type CircuitDto,
  type CircuitSiteScope,
} from '../services/circuits';
import type { Context } from 'hono';

export const circuitRoutes = new Hono();

circuitRoutes.use('*', authMiddleware);

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireDevicesWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
const scopes = requireScope('organization', 'partner', 'system');

/** The caller's live permissions, resolved the same way the topology routes do. */
async function resolvePermissions(c: Context): Promise<UserPermissions> {
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
  return permissions;
}

/**
 * The sites the caller may reach: the token ceiling (`auth.allowedSiteIds`)
 * intersected with the live permission allowlist (`permissions.allowedSiteIds`).
 * `null` is unrestricted; a malformed allowlist fails closed to no sites.
 */
async function resolveSiteScope(c: Context): Promise<CircuitSiteScope> {
  const auth = c.get('auth') as AuthContext;
  const permissions = await resolvePermissions(c);
  const lists = [auth.allowedSiteIds, permissions.allowedSiteIds].filter((l) => l !== undefined);
  if (lists.length === 0) return { allowedSiteIds: null };
  let allowed: string[] | null = null;
  for (const list of lists) {
    const ids: string[] = Array.isArray(list) ? list : [];
    allowed = allowed === null ? [...ids] : allowed.filter((id) => ids.includes(id));
  }
  return { allowedSiteIds: allowed };
}

/** Topology write access to one site, using the same boundary as the topology routes. */
async function assertTopologySiteWrite(c: Context, siteId: string): Promise<void> {
  const auth = c.get('auth') as AuthContext;
  const permissions = await resolvePermissions(c);
  await requireTopologySiteAccess(auth, permissions, siteId, 'write');
}

/**
 * Write access to sites the caller did not name (the circuit's own primary,
 * served or removed sites). A failure is a generic 403 that does not say which
 * site denied it.
 */
async function assertCircuitSitesWritable(c: Context, siteIds: string[]): Promise<void> {
  for (const siteId of new Set(siteIds)) {
    try {
      await assertTopologySiteWrite(c, siteId);
    } catch (err) {
      if (err instanceof TopologyError) throw new CircuitError('Circuit write not permitted', 'CIRCUIT_SITE_FORBIDDEN', 403);
      throw err;
    }
  }
}

/** Loads a circuit only when the caller may see it; otherwise it is reported as not found. */
async function loadVisibleCircuit(c: Context, id: string): Promise<{ circuit: CircuitDto; scope: CircuitSiteScope } | null> {
  const auth = c.get('auth') as AuthContext;
  const scope = await resolveSiteScope(c);
  const circuit = await getCircuitDto(id);
  if (!circuit || !auth.canAccessOrg(circuit.orgId) || !canSeeCircuit(circuit, scope)) return null;
  return { circuit, scope };
}

function handleError(c: Context, err: unknown) {
  if (err instanceof CircuitError) return c.json({ error: err.message, code: err.code }, err.status);
  if (err instanceof TopologyError) return c.json({ error: err.message, code: err.code }, err.status as 403);
  throw err;
}

circuitRoutes.get('/', scopes, requireDevicesRead, zValidator('query', circuitListQuerySchema), async (c) => {
  try {
    const auth = c.get('auth') as AuthContext;
    const scope = await resolveSiteScope(c);
    const { limit, cursor } = c.req.valid('query');
    const page = await listCircuitDtos({ orgCondition: auth.orgCondition(circuitsTable.orgId), scope, limit, cursor });
    return c.json({ data: page.items, nextCursor: page.nextCursor });
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.post('/', scopes, requireDevicesWrite, requireMfa(), zValidator('json', circuitCreateBodySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { orgId: requestedOrgId, ...body } = c.req.valid('json');
  const orgId = requestedOrgId ?? auth.orgId;
  if (!orgId) return c.json({ error: 'orgId is required to create a circuit for this scope' }, 400);
  if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Access to this organization denied' }, 403);
  const dto = await createCircuit(orgId, body);
  writeRouteAudit(c, { orgId, action: 'circuit.create', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { after: dto } });
  return c.json(dto, 201);
});

circuitRoutes.get('/:id', scopes, requireDevicesRead, async (c) => {
  try {
    const found = await loadVisibleCircuit(c, c.req.param('id')!);
    if (!found) return c.json({ error: 'Circuit not found' }, 404);
    return c.json(redactCircuitDto(found.circuit, found.scope));
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.patch('/:id', scopes, requireDevicesWrite, requireMfa(), zValidator('json', circuitPatchSchema), async (c) => {
  try {
    const found = await loadVisibleCircuit(c, c.req.param('id')!);
    if (!found) return c.json({ error: 'Circuit not found' }, 404);
    const { circuit: before, scope } = found;
    await assertCircuitSitesWritable(c, circuitWriteSiteIds(before, scope));
    const dto = await updateCircuit(before.id, c.req.valid('json'));
    writeRouteAudit(c, { orgId: dto.orgId, action: 'circuit.update', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { before, after: dto } });
    return c.json(redactCircuitDto(dto, scope));
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.delete('/:id', scopes, requireDevicesWrite, requireMfa(), async (c) => {
  try {
    const found = await loadVisibleCircuit(c, c.req.param('id')!);
    if (!found) return c.json({ error: 'Circuit not found' }, 404);
    const { circuit: before } = found;
    await assertCircuitSitesWritable(c, circuitDeleteSiteIds(before));
    await deleteCircuit(before.id);
    writeRouteAudit(c, { orgId: before.orgId, action: 'circuit.delete', resourceType: 'circuit', resourceId: before.id, resourceName: before.cid, details: { before } });
    return c.json({ success: true });
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.put('/:id/termination', scopes, requireDevicesWrite, requireMfa(), zValidator('json', terminationBodySchema), async (c) => {
  try {
    const found = await loadVisibleCircuit(c, c.req.param('id')!);
    if (!found) return c.json({ error: 'Circuit not found' }, 404);
    const { circuit, scope } = found;
    const { interfaceId } = c.req.valid('json');
    const [iface] = await db.select({ siteId: topologyInterfaces.siteId }).from(topologyInterfaces).where(eq(topologyInterfaces.id, interfaceId)).limit(1);
    if (!iface) return c.json({ error: 'Interface not found', code: 'INTERFACE_NOT_FOUND' }, 404);
    await assertTopologySiteWrite(c, iface.siteId);
    await assertCircuitSitesWritable(c, circuitPrimarySiteIds(circuit));
    const before = circuit.termination;
    const dto = await setCircuitTermination(circuit.id, interfaceId);
    writeRouteAudit(c, { orgId: dto.orgId, action: 'circuit.termination.set', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { before, after: dto.termination } });
    return c.json(redactCircuitDto(dto, scope));
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.delete('/:id/termination', scopes, requireDevicesWrite, requireMfa(), async (c) => {
  try {
    const found = await loadVisibleCircuit(c, c.req.param('id')!);
    if (!found) return c.json({ error: 'Circuit not found' }, 404);
    const { circuit, scope } = found;
    await assertCircuitSitesWritable(c, circuitPrimarySiteIds(circuit));
    const dto = await clearCircuitTermination(circuit.id);
    writeRouteAudit(c, { orgId: dto.orgId, action: 'circuit.termination.clear', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { before: circuit.termination } });
    return c.json(redactCircuitDto(dto, scope));
  } catch (err) {
    return handleError(c, err);
  }
});

circuitRoutes.put('/:id/served-sites', scopes, requireDevicesWrite, requireMfa(), zValidator('json', servedSitesBodySchema), async (c) => {
  try {
    const found = await loadVisibleCircuit(c, c.req.param('id')!);
    if (!found) return c.json({ error: 'Circuit not found' }, 404);
    const { circuit, scope } = found;
    const { siteIds } = c.req.valid('json');
    const requested = new Set(siteIds);
    for (const siteId of requested) {
      await assertTopologySiteWrite(c, siteId);
    }
    const removed = circuit.additionalServedSites.map((s) => s.id).filter((id) => !requested.has(id));
    await assertCircuitSitesWritable(c, [...circuitPrimarySiteIds(circuit), ...removed]);
    const before = circuit.additionalServedSites;
    const dto = await setCircuitServedSites(circuit.id, siteIds);
    writeRouteAudit(c, { orgId: dto.orgId, action: 'circuit.served_sites.set', resourceType: 'circuit', resourceId: dto.id, resourceName: dto.cid, details: { before, after: dto.additionalServedSites } });
    return c.json(redactCircuitDto(dto, scope));
  } catch (err) {
    return handleError(c, err);
  }
});
