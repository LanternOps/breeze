import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { securityStatusIngestSchema, managementPostureIngestSchema } from './schemas';
import { upsertSecurityStatusForDevice } from './helpers';

export const agentSecurityRoutes = new Hono();

agentSecurityRoutes.put('/:id/security/status', zValidator('json', securityStatusIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  await upsertSecurityStatusForDevice(device.id, payload);
  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.security_status.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      provider: payload.provider ?? null,
      threatCount: payload.threatCount ?? null,
    },
  });
  return c.json({ success: true });
});

agentSecurityRoutes.put('/:id/management/posture', zValidator('json', managementPostureIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  try {
    await db
      .update(devices)
      .set({
        managementPosture: payload,
        updatedAt: new Date(),
      })
      .where(eq(devices.id, device.id));
  } catch (err) {
    console.error('[agents] management posture DB update failed:', { agentId, deviceId: device.id, error: err });
    return c.json({ error: 'Failed to save management posture' }, 500);
  }

  try {
    writeAuditEvent(c, {
      orgId: agent?.orgId ?? device.orgId,
      actorType: 'agent',
      actorId: agent?.agentId ?? agentId,
      action: 'agent.management_posture.submit',
      resourceType: 'device',
      resourceId: device.id,
    });
  } catch (auditErr) {
    console.error('[agents] audit event write failed for posture submit:', auditErr);
  }

  return c.json({ success: true });
});
