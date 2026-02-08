import { Hono } from 'hono';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizations, devices } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const partnerRoutes = new Hono();

partnerRoutes.use('*', authMiddleware);

partnerRoutes.get('/dashboard', requireScope('partner', 'system'), async (c) => {
  const auth = c.get('auth');

  let orgIds: string[] | null = null;

  if (auth.scope === 'partner') {
    orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return c.json({ data: [] });
    }
  } else if (auth.scope === 'system') {
    const queryOrgId = c.req.query('orgId');
    if (queryOrgId) {
      orgIds = [queryOrgId];
    }
  }

  const orgConditions = [isNull(organizations.deletedAt)];
  if (orgIds) {
    orgConditions.push(inArray(organizations.id, orgIds));
  }

  const orgRows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      status: organizations.status
    })
    .from(organizations)
    .where(and(...orgConditions))
    .orderBy(organizations.name);

  if (orgRows.length === 0) {
    return c.json({ data: [] });
  }

  const orgIdList = orgRows.map((org) => org.id);
  const deviceRows = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      status: devices.status,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .where(inArray(devices.orgId, orgIdList));

  const devicesByOrg = new Map<string, Array<{
    id: string;
    name: string;
    status: string;
    alertCount: number;
    compliance: number;
    lastSeen: string;
  }>>();

  for (const row of deviceRows) {
    const list = devicesByOrg.get(row.orgId) ?? [];
    list.push({
      id: row.id,
      name: row.hostname,
      status: row.status,
      alertCount: 0,
      compliance: 100,
      lastSeen: row.lastSeenAt ? row.lastSeenAt.toISOString() : new Date(0).toISOString(),
    });
    devicesByOrg.set(row.orgId, list);
  }

  const data = orgRows.map((org) => {
    const orgDevices = devicesByOrg.get(org.id) ?? [];
    return {
      id: org.id,
      name: org.name,
      status: org.status,
      deviceCount: orgDevices.length,
      alertCount: 0,
      compliance: 100,
      mrr: 0,
      devices: orgDevices
    };
  });

  return c.json({ data });
});
