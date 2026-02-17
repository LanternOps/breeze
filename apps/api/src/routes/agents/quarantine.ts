import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { authMiddleware, requirePermission } from '../../middleware/auth';
import { writeAuditEvent } from '../../services/auditEvents';
import { issueMtlsCertForDevice } from './helpers';

export const quarantineRoutes = new Hono();

// GET /api/v1/agents/quarantined — list quarantined devices in org
quarantineRoutes.get('/quarantined', authMiddleware, requirePermission('devices', 'read'), async (c) => {
  const auth = c.get('auth') as { orgId?: string; orgCondition?: (col: any) => any };

  const rows = await db
    .select({
      id: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      osType: devices.osType,
      quarantinedAt: devices.quarantinedAt,
      quarantinedReason: devices.quarantinedReason,
    })
    .from(devices)
    .where(
      and(
        eq(devices.status, 'quarantined'),
        auth.orgCondition ? auth.orgCondition(devices.orgId) : undefined
      )
    )
    .orderBy(desc(devices.quarantinedAt))
    .limit(100);

  return c.json({ devices: rows });
});

// POST /api/v1/agents/:id/approve — approve quarantined device
quarantineRoutes.post('/:id/approve', authMiddleware, requirePermission('devices', 'write'), async (c) => {
  const deviceId = c.req.param('id');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (auth.canAccessOrg && !auth.canAccessOrg(device.orgId)) {
    return c.json({ error: 'Not authorized' }, 403);
  }

  if (device.status !== 'quarantined') {
    return c.json({ error: 'Device is not quarantined' }, 400);
  }

  const mtlsCert = await issueMtlsCertForDevice(device.id, device.orgId);

  await db
    .update(devices)
    .set({
      status: 'online',
      quarantinedAt: null,
      quarantinedReason: null,
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'user',
    actorId: auth.user?.id ?? 'unknown',
    action: 'admin.device.approve',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
    details: { mtlsCertIssued: mtlsCert !== null },
  });

  return c.json({
    success: true,
    mtls: mtlsCert,
  });
});

// POST /api/v1/agents/:id/deny — deny quarantined device
quarantineRoutes.post('/:id/deny', authMiddleware, requirePermission('devices', 'write'), async (c) => {
  const deviceId = c.req.param('id');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (auth.canAccessOrg && !auth.canAccessOrg(device.orgId)) {
    return c.json({ error: 'Not authorized' }, 403);
  }

  if (device.status !== 'quarantined') {
    return c.json({ error: 'Device is not quarantined' }, 400);
  }

  await db
    .update(devices)
    .set({
      status: 'decommissioned',
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'user',
    actorId: auth.user?.id ?? 'unknown',
    action: 'admin.device.deny',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
  });

  return c.json({ success: true });
});
