import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { db } from '../../db';
import {
  configurationPolicies,
  monitorDefinitions,
  monitorDeviceState,
  monitorEpisodes,
} from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { resolveMonitorsForDevice } from '../../services/monitors/monitorResolver';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

/**
 * GET /devices/:id/monitors — the device page's Monitoring tab (#6371, W05c2
 * Task 10): every monitor that effectively applies to this device, joined to
 * its per-device operational state and open episode.
 *
 * Read-only and device-scoped. Runs under the request's own
 * `withDbAccessContext` (set by `authMiddleware`) — no system escalation — so
 * RLS bounds every read: an org token sees its org-owned monitors/policies and
 * its partner's partner-wide ones through their SELECT-only partner branches.
 * The site axis is not defended by RLS, so the device passes the canonical
 * org + site gate before anything else is read.
 */
export const deviceMonitorsRoutes = new Hono();

deviceMonitorsRoutes.use('*', authMiddleware);

deviceMonitorsRoutes.get(
  '/:id/monitors',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', z.object({ id: z.string().uuid() })),
  async (c) => {
    const { id } = c.req.valid('param');
    const device = await getDeviceWithOrgAndSiteCheck(c, id, c.get('auth'));
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    const resolution = await resolveMonitorsForDevice(id);
    // Raced a delete/org move between the gate above and resolution (#5677):
    // report the device as gone rather than a fabricated "no monitors apply".
    if (resolution.kind === 'device_missing') return c.json({ error: 'Device not found' }, 404);
    if (resolution.monitors.length === 0) return c.json({ data: [] });

    const monitorIds = resolution.monitors.map((m) => m.monitorId);
    const rows = await db
      .select({ definition: monitorDefinitions, state: monitorDeviceState, episode: monitorEpisodes })
      .from(monitorDefinitions)
      .leftJoin(
        monitorDeviceState,
        and(
          eq(monitorDeviceState.monitorId, monitorDefinitions.id),
          eq(monitorDeviceState.deviceId, id),
          eq(monitorDeviceState.orgId, device.orgId),
        ),
      )
      .leftJoin(
        monitorEpisodes,
        and(
          eq(monitorEpisodes.monitorId, monitorDefinitions.id),
          eq(monitorEpisodes.deviceId, id),
          eq(monitorEpisodes.orgId, device.orgId),
          // At most one open episode per (monitor, device):
          // monitor_episodes_open_uidx.
          isNull(monitorEpisodes.endedAt),
        ),
      )
      .where(inArray(monitorDefinitions.id, monitorIds));

    const policyIds = [...new Set(resolution.monitors.map((m) => m.sourcePolicyId))];
    const policies = await db
      .select({ id: configurationPolicies.id, name: configurationPolicies.name })
      .from(configurationPolicies)
      .where(inArray(configurationPolicies.id, policyIds));

    const byId = new Map(rows.map((row) => [row.definition.id, row]));
    const policyNames = new Map(policies.map((policy) => [policy.id, policy.name]));

    return c.json({
      data: resolution.monitors.flatMap((match) => {
        const row = byId.get(match.monitorId);
        // A resolved attachment whose definition is not readable under this
        // context is omitted rather than rendered with a fabricated name.
        if (!row) return [];
        return [
          {
            monitorId: match.monitorId,
            name: row.definition.name,
            kind: row.definition.kind,
            // A disabled winning attachment stays visible, as disabled.
            enabled: match.enabled && row.definition.enabled,
            overrides: match.overrides,
            sourcePolicyId: match.sourcePolicyId,
            sourcePolicyName: policyNames.get(match.sourcePolicyId) ?? null,
            sourceLevel: match.sourceLevel,
            inheritedFromParent: match.inheritedFromParent,
            lastState: row.state?.lastState ?? 'unknown',
            lastEvaluatedAt: row.state?.lastEvaluatedAt ?? null,
            openEpisode: row.episode
              ? { id: row.episode.id, startedAt: row.episode.startedAt, alertId: row.episode.alertId }
              : null,
            escalatedAt: row.state?.escalatedAt ?? null,
            escalationAlertId: row.state?.escalationAlertId ?? null,
            responsesPaused: row.state?.responsesPaused ?? false,
          },
        ];
      }),
    });
  },
);
