import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import type { AgentAuthContext } from '../../middleware/agentAuth';

export const uninstallIntentRoutes = new Hono();

/**
 * Task 5 (#2764) — the MSI/pkg/deb uninstaller's best-effort "I'm about to be
 * removed" signal, called by the uninstall custom action before secrets.yaml
 * is deleted (Task 6). Device-token authenticated via the parent router's
 * `/:id/*` -> agentAuthMiddleware wrapping (index.ts) — mounted at the same
 * `/:id/<action>` shape as every other agent route in this package
 * (heartbeat.ts, processSample.ts, unifiTelemetry.ts) even though, like
 * those, the write below keys off the token-resolved `agent.deviceId`, never
 * the `:id` path segment, so the caller cannot stamp any row but its own.
 *
 * The write is a plain timestamp; two other sanctioned writers close the
 * loop:
 *  - heartbeat.ts clears it unconditionally on every beat (a live heartbeat
 *    is proof the uninstall didn't happen, or this is a fresh reinstall of
 *    the same row) — self-healing, no operator action needed.
 *  - jobs/offlineDetector.ts's reaper decommissions the row once the stamp
 *    is older than UNINSTALL_INTENT_DECOMMISSION_HOURS (default 24) AND no
 *    heartbeat has landed since the stamp.
 *
 * Best-effort by design: the agent calls this on a short timeout and never
 * blocks or fails the uninstall on the response.
 */
uninstallIntentRoutes.post('/:id/uninstall-intent', async (c) => {
  const agent = c.get('agent') as AgentAuthContext | undefined;

  if (!agent?.deviceId) {
    return c.json({ error: 'Agent context not found' }, 401);
  }

  await db
    .update(devices)
    .set({ uninstallIntentAt: new Date() })
    .where(eq(devices.id, agent.deviceId));

  return c.json({ acknowledged: true });
});
