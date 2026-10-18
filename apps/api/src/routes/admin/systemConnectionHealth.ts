/**
 * System → connection health job status (connection health W4, spec §8).
 *
 *   GET /api/v1/admin/system/connection-health   { data: ConnectionHealthJobStatus }
 *
 * Whether the reconciler and the daily digest are alive, and each health
 * kind's last success and failure streak, so a dead job is visible without
 * reading BullMQ. Platform-admin only because it is mounted under
 * `adminRoutes` (platformAdminMiddleware gates every request). Read-only: GET
 * is the only verb. Redis only, no DB; a Redis outage is reported in the body
 * (`redis: 'unavailable'`), never a 500. No tenant data: kind names and
 * timestamps only.
 */
import { Hono } from 'hono';
import { readConnectionHealthJobStatus, type HeartbeatRedis } from '../../services/connectionHealth/heartbeat';
import { HEALTH_SOURCES } from '../../services/connectionHealth/sources';
import { getRedis } from '../../services/redis';

export const systemConnectionHealthAdminRoutes = new Hono();

systemConnectionHealthAdminRoutes.get('/connection-health', async (c) => {
  c.header('Cache-Control', 'no-store');
  let redis: HeartbeatRedis | null = null;
  try {
    redis = getRedis() as unknown as HeartbeatRedis | null;
  } catch {
    redis = null;
  }
  const kinds = HEALTH_SOURCES.map((s) => ({ kind: s.kind, intervalMinutes: s.intervalMinutes }));
  return c.json({ data: await readConnectionHealthJobStatus(redis, kinds, new Date()) });
});
