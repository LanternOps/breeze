import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { securityStatusIngestSchema } from './schemas';
import { upsertSecurityStatusForDevice } from './helpers';
import type { AgentContext } from './helpers';

export const securityRoutes = new Hono();

// Submit device security status
securityRoutes.put('/:id/security/status', zValidator('json', securityStatusIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as AgentContext | undefined;

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

// Submit management posture
const managementPostureIngestSchema = z.object({
  collectedAt: z.string().datetime(),
  scanDurationMs: z.number().int().nonnegative(),
  categories: z.record(
    z.enum(['mdm', 'rmm', 'remoteAccess', 'endpointSecurity',
            'policyEngine', 'backup', 'identityMfa', 'siem',
            'dnsFiltering', 'zeroTrustVpn', 'patchManagement']),
    z.array(z.object({
      name: z.string(),
      version: z.string().optional(),
      status: z.enum(['active', 'installed', 'unknown']),
      serviceName: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }))
  ),
  identity: z.object({
    joinType: z.enum(['hybrid_azure_ad', 'azure_ad', 'on_prem_ad', 'workplace', 'none']),
    azureAdJoined: z.boolean(),
    domainJoined: z.boolean(),
    workplaceJoined: z.boolean(),
    domainName: z.string().optional(),
    tenantId: z.string().optional(),
    mdmUrl: z.string().optional(),
    source: z.string(),
  }),
  errors: z.array(z.string()).optional(),
});

securityRoutes.put('/:id/management/posture', zValidator('json', managementPostureIngestSchema), async (c) => {
  const agentId = c.req.param('id');
  const payload = c.req.valid('json');
  const agent = c.get('agent') as AgentContext | undefined;

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
