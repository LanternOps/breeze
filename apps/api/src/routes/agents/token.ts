import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { writeAuditEvent } from '../../services/auditEvents';
import { generateApiKey } from './helpers';

export const tokenRoutes = new Hono();

tokenRoutes.post('/:id/rotate-token', async (c) => {
  const agentId = c.req.param('id');
  const agent = c.get('agent') as AgentAuthContext;

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      agentTokenHash: devices.agentTokenHash,
    })
    .from(devices)
    .where(
      and(
        eq(devices.id, agent.deviceId),
        eq(devices.agentId, agentId)
      )
    )
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const rotatedAt = new Date();
  const previousTokenExpiresAt = new Date(rotatedAt.getTime() + 5 * 60 * 1000);
  const authToken = generateApiKey();
  // Agent bearer tokens are high-entropy random values; we store only a SHA-256 hash and never persist
  // the plaintext token.
  // lgtm[js/insufficient-password-hash]
  const agentTokenHash = createHash('sha256').update(authToken).digest('hex');

  try {
    await db
      .update(devices)
      .set({
        previousTokenHash: device.agentTokenHash,
        previousTokenExpiresAt,
        agentTokenHash,
        tokenIssuedAt: rotatedAt,
        updatedAt: rotatedAt,
      })
      .where(eq(devices.id, device.id));
  } catch (error) {
    console.error('[agents] token rotation DB update failed:', {
      agentId,
      deviceId: device.id,
      error,
    });
    return c.json({ error: 'Failed to rotate agent token' }, 500);
  }

  try {
    writeAuditEvent(c, {
      orgId: agent.orgId,
      actorType: 'agent',
      actorId: agent.agentId,
      action: 'agent.token.rotate',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        rotatedAt: rotatedAt.toISOString(),
        previousTokenGracePeriodSeconds: 300,
      },
    });
  } catch (auditErr) {
    console.error('[agents] audit event write failed for token rotation:', auditErr);
  }

  return c.json(
    {
      authToken,
      rotatedAt: rotatedAt.toISOString(),
    },
    200
  );
});
