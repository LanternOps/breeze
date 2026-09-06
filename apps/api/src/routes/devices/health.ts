import type { AgentHealthObservation } from '@breeze/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db';
import { agentHealthObservations, deviceAgentHealthLatest } from '../../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const healthRoutes = new Hono();

healthRoutes.use('*', authMiddleware);

healthRoutes.get(
  '/:id/health',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const deviceId = c.req.param('id')!;
    try {
      const auth = c.get('auth');
      const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
      if (device === SITE_ACCESS_DENIED) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      if (!device) {
        return c.json({ error: 'Device not found' }, 404);
      }

      const [row] = await db
        .select({
          schemaVersion: agentHealthObservations.schemaVersion,
          agentVersion: agentHealthObservations.agentVersion,
          overall: agentHealthObservations.overall,
          metricsAvailable: agentHealthObservations.metricsAvailable,
          components: agentHealthObservations.components,
          observedAt: agentHealthObservations.observedAt,
          receivedAt: deviceAgentHealthLatest.receivedAt,
        })
        .from(deviceAgentHealthLatest)
        .innerJoin(
          agentHealthObservations,
          and(
            eq(agentHealthObservations.id, deviceAgentHealthLatest.observationId),
            eq(agentHealthObservations.deviceId, deviceAgentHealthLatest.deviceId),
            eq(agentHealthObservations.orgId, deviceAgentHealthLatest.orgId),
          ),
        )
        .where(and(
          eq(deviceAgentHealthLatest.deviceId, device.id),
          eq(deviceAgentHealthLatest.orgId, device.orgId),
        ))
        .limit(1);

      if (!row || row.schemaVersion !== 1) {
        return c.json({ status: 'unknown' as const, observation: null });
      }

      const observation: AgentHealthObservation = {
        schemaVersion: 1,
        deviceId: device.id,
        agentVersion: row.agentVersion,
        overall: row.overall,
        metricsAvailable: row.metricsAvailable,
        components: row.components,
        observedAt: row.observedAt.toISOString(),
      };

      return c.json({
        status: 'known' as const,
        observation,
        receivedAt: row.receivedAt.toISOString(),
      });
    } catch (err) {
      console.error(`[DeviceHealth] GET failed for device ${deviceId}:`, err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  },
);
