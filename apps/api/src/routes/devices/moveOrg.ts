import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, sites, organizations } from '../../db/schema';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  getDeviceWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
  stripSensitiveDeviceFields,
} from './helpers';
import { moveOrgSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';
import { DEVICE_ORG_DENORMALIZED_TABLES, DEVICE_SITE_DENORMALIZED_TABLES } from './core';
import { disconnectAgent } from '../agentWs';

export const moveOrgRoutes = new Hono();

moveOrgRoutes.use('*', authMiddleware);

/**
 * POST /devices/:id/move-org
 *
 * Move a device between organizations (and into a site within the target org)
 * without uninstalling/reinstalling the agent. The agent re-resolves its
 * `org_id` from `devices.org_id` on every heartbeat / WS handshake, so the
 * column flip is sufficient to relocate the agent at runtime.
 *
 * The route is gated on:
 *   - scope ∈ {partner, system} — cross-org capability requires at minimum
 *     partner reach. Single-org callers can't see two orgs at once and
 *     therefore can't legitimately move between them.
 *   - devices:write AND organizations:write — relocating a device is both
 *     a device mutation and an org-membership mutation.
 *   - MFA — destructive cross-tenant change.
 *
 * Cross-partner moves are rejected even for partner-scoped callers; only
 * system scope can move a device across partner boundaries.
 *
 * RLS hazard: 64 device-scoped tables denormalize `org_id` for RLS perf
 * (see DEVICE_ORG_DENORMALIZED_TABLES). All of them MUST be rewritten in
 * the same transaction or pre-existing rows for this device will be
 * visible only to the OLD org and invisible to the NEW one. Tables that
 * denormalize org_id but have no device_id column (CUSTOM_ORG_REWRITE_TABLES,
 * currently ticket_alert_links) get dedicated rewrites in the same
 * transaction.
 *
 * Audit: writes ONE audit row per org (source + target) so the move shows
 * up in both audit feeds.
 */
moveOrgRoutes.post(
  '/:id/move-org',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', moveOrgSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { orgId: targetOrgId, siteId: targetSiteId } = c.req.valid('json');

    // Source-side access check via the standard chokepoint.
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const sourceOrgId = device.orgId;

    if (targetOrgId === sourceOrgId) {
      return c.json(
        { error: 'Target organization is the same as the source. Use PATCH /devices/:id to change site.' },
        400,
      );
    }

    // Target-side access check.
    if (!auth.canAccessOrg(targetOrgId)) {
      return c.json({ error: 'Access to target organization denied' }, 403);
    }

    // Look up both orgs to enforce cross-partner policy.
    const orgRows = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(sql`${organizations.id} IN (${sourceOrgId}::uuid, ${targetOrgId}::uuid)`);

    const sourceOrg = orgRows.find((r) => r.id === sourceOrgId);
    const targetOrg = orgRows.find((r) => r.id === targetOrgId);

    if (!targetOrg) {
      return c.json({ error: 'Target organization not found' }, 404);
    }
    if (!sourceOrg) {
      // Defensive — device.orgId failed FK invariants. Treat as 500-class.
      return c.json({ error: 'Source organization not found' }, 500);
    }
    if (sourceOrg.partnerId !== targetOrg.partnerId && auth.scope !== 'system') {
      return c.json(
        { error: 'Cross-partner moves require system scope' },
        403,
      );
    }

    // Target site must belong to the target org.
    const [targetSite] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, targetSiteId), eq(sites.orgId, targetOrgId)))
      .limit(1);

    if (!targetSite) {
      return c.json(
        { error: 'Target site not found or does not belong to the target organization' },
        400,
      );
    }

    // ----------- the actual move -----------
    let updated: typeof devices.$inferSelect | undefined;
    try {
      await db.transaction(async (tx) => {
        // Flip the device row first so any concurrent agent heartbeat
        // after this point resolves the new org_id.
        const [row] = await tx
          .update(devices)
          .set({
            orgId: targetOrgId,
            siteId: targetSiteId,
            updatedAt: new Date(),
          })
          .where(eq(devices.id, deviceId))
          .returning();
        updated = row;

        // Rewrite the denormalized org_id on every device-scoped table.
        // Skipping any of these strands pre-existing rows under RLS.
        for (const table of DEVICE_ORG_DENORMALIZED_TABLES) {
          await tx.execute(
            sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid WHERE device_id = ${deviceId}::uuid`,
          );
        }

        // ticket_alert_links denormalizes org_id for RLS but has no
        // device_id column, so the generic loop above can't reach it —
        // rewrite via the alert join instead. Excluded from
        // DEVICE_ORG_DENORMALIZED_TABLES; tracked in
        // CUSTOM_ORG_REWRITE_TABLES (core.ts).
        await tx.execute(
          sql`UPDATE ${sql.identifier('ticket_alert_links')} SET org_id = ${targetOrgId}::uuid WHERE alert_id IN (SELECT id FROM alerts WHERE device_id = ${deviceId}::uuid)`,
        );

        // Rewrite denormalized site_id on every device-scoped table that has
        // one (currently elevation_requests — see DEVICE_SITE_DENORMALIZED_TABLES
        // in core.ts). Skipping any of these strands rows under the OLD
        // site_id. PATCH /devices/:id (core.ts) performs the same propagation
        // for same-org site changes; keep both loops in lockstep.
        for (const table of DEVICE_SITE_DENORMALIZED_TABLES) {
          await tx.execute(
            sql`UPDATE ${sql.identifier(table)} SET site_id = ${targetSiteId}::uuid WHERE device_id = ${deviceId}::uuid`,
          );
        }
      });
    } catch (err) {
      console.error(`[devices.moveOrg] failed for ${deviceId}:`, err);
      // Best-effort audit on the failed cross-tenant move — a rolled-back
      // attempt is security-relevant. Source-org row only since target
      // never committed.
      writeRouteAudit(c, {
        orgId: sourceOrgId,
        action: 'device.move_org.failed',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname,
        details: { sourceOrgId, targetOrgId, sourceSiteId: device.siteId, targetSiteId, error: String(err) },
      });
      return c.json({ error: 'Failed to move device between organizations' }, 500);
    }

    // Force-close any active WS so the agent reconnects with a fresh
    // handshake on the new org_id. Without this, createAgentWsHandlers
    // (agentWs.ts:1411) closes over the SOURCE-org preValidatedAgent for
    // the lifetime of the connection — every subsequent runWithAgentDbAccess
    // (status, IP history, event publish, command result) writes telemetry
    // under the OLD org's RLS context until the agent eventually reconnects.
    if (updated?.agentId) {
      disconnectAgent(updated.agentId, 4040, 'device moved to a different organization, reconnecting');
    }

    // Audit on BOTH orgs so the move shows up in source and target feeds.
    const auditDetails = {
      deviceId,
      sourceOrgId,
      targetOrgId,
      sourceSiteId: device.siteId,
      targetSiteId,
    } as const;

    writeRouteAudit(c, {
      orgId: sourceOrgId,
      action: 'device.move_org.source',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: updated?.hostname ?? device.hostname,
      details: auditDetails,
    });
    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'device.move_org.target',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: updated?.hostname ?? device.hostname,
      details: auditDetails,
    });

    return c.json({
      success: true,
      device: updated ? stripSensitiveDeviceFields(updated) : null,
    });
  },
);
