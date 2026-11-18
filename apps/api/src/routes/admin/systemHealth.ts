/**
 * System → Health: shared background-processing observations (spec
 * 2026-10-30-system-health-admin-design §6).
 *
 *   GET /api/v1/admin/system/health   { data: SystemHealthReport }
 *
 * Platform-admin only because it is mounted under `adminRoutes`
 * (platformAdminMiddleware gates every request). GET is the only verb. Redis
 * and BullMQ only; a dependency failure is reported per observation, never as
 * a 500. No tenant data, no queue payloads, no raw error text.
 */
import { Hono } from 'hono';
import type { HeartbeatRedis } from '../../services/connectionHealth/heartbeat';
import { HEALTH_SOURCES } from '../../services/connectionHealth/sources';
import { buildSystemHealthReport } from '../../services/systemHealth/backgroundWork';
import { getRedis } from '../../services/redis';

export const systemHealthAdminRoutes = new Hono();

systemHealthAdminRoutes.get('/health', async (c) => {
  c.header('Cache-Control', 'no-store');
  let redis: HeartbeatRedis | null = null;
  try {
    redis = getRedis() as unknown as HeartbeatRedis | null;
  } catch {
    redis = null;
  }
  const kinds = HEALTH_SOURCES.map((s) => ({ kind: s.kind, intervalMinutes: s.intervalMinutes }));
  return c.json({ data: await buildSystemHealthReport({ redis, kinds, now: new Date() }) });
});
