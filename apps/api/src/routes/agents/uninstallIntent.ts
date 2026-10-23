import { Hono } from 'hono';
import { db } from '../../db';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { staleAgentCredentialRejection } from '../../middleware/agentAuthRejection';
import { ownDeviceRowChangedHands, updateOwnDeviceRow } from '../../services/agentOwnDeviceRow';

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

  // Main-agent-only: a watchdog or helper credential has no business timing
  // out the device's decommission reaper (heartbeat.ts / offlineDetector.ts
  // above). Checked here rather than via the shared requireAgentRole
  // middleware so a missing context still 401s instead of collapsing into
  // the same 403 as a wrong-role one.
  if (agent.role !== 'agent') {
    return c.json({ error: 'This endpoint requires the agent credential' }, 403);
  }

  // #8318 §6.4: bound to the authenticated id + agent_id; an uninstaller of a
  // superseded install cannot stamp the row a reattach handed to a new one.
  const stamped = await updateOwnDeviceRow(db, agent, { uninstallIntentAt: new Date() });

  // Nothing was stamped, so nothing is acknowledged: a row that changed hands
  // after auth gets the stale-credential 401 the beats give; a row that is
  // gone (the write has no other predicate) gets 404. The uninstaller ignores
  // the answer either way.
  if (stamped.length === 0) {
    if (await ownDeviceRowChangedHands(db, agent)) {
      console.warn('[agents] stale uninstall-intent: the device row changed hands after auth; refusing it', {
        deviceId: agent.deviceId,
        agentId: agent.agentId,
      });
      throw staleAgentCredentialRejection();
    }
    return c.json({ error: 'Device not found' }, 404);
  }

  return c.json({ acknowledged: true });
});
