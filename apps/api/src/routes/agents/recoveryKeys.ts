import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { recoveryKeysIngestSchema } from './schemas';
import { escrowRecoveryKeys } from '../../services/recoveryKeyEscrow';
import { requireAgentRole } from '../../middleware/requireAgentRole';

export const agentRecoveryKeysRoutes = new Hono();
// Recovery-key escrow is the main agent's job; reject watchdog-role tokens so
// a weaker credential can't plant or overwrite escrowed key material.
agentRecoveryKeysRoutes.use('*', requireAgentRole);

agentRecoveryKeysRoutes.put('/:id/security/recovery-keys', zValidator('json', recoveryKeysIngestSchema), async (c) => {
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

  const stats = await escrowRecoveryKeys(device.id, device.orgId, payload.source, payload.keys);

  // Counts only — recovery-key material must never reach the audit trail.
  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.recovery_keys.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      source: payload.source,
      inserted: stats.inserted,
      superseded: stats.superseded,
      unchanged: stats.unchanged,
    },
  });

  return c.json({ success: true, stats });
});
