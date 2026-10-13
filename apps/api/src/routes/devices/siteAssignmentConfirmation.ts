import { Hono, type Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

/**
 * "Keep at <site>" (topology site location W3, #7887; spec S§11, S§8 R5).
 *
 *   PUT    /devices/:id/site-assignment-confirmation  -> { confirmedAt }        (suggestions off)
 *   DELETE /devices/:id/site-assignment-confirmation  -> { confirmedAt: null }  ("Turn on")
 *
 * Both need devices:write, MFA and the device's own site (getDeviceWithOrgAndSiteCheck). The actor is recorded only
 * in the audit log. The write touches site_assignment_confirmed_at alone, guarded on the site read at the access
 * check: a device that moved in between gets 409 rather than a confirmation of a site the technician never saw.
 * Dismissing a suggestion never moves anything and never writes site_id. The confirmation is cleared centrally by the
 * breeze_devices_site_assignment_confirmation_reset trigger when the device's site or org changes; it has no expiry
 * (owner decision Q2).
 */
export const siteAssignmentConfirmationRoutes = new Hono();

async function setConfirmation(c: Context, confirmed: boolean) {
  const auth = c.get('auth');
  const deviceId = c.req.param('id')!;
  const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
  if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
  if (!device) return c.json({ error: 'Device not found' }, 404);

  const [row] = await db
    .update(devices)
    .set({ siteAssignmentConfirmedAt: confirmed ? sql`now()` : null })
    .where(and(eq(devices.id, device.id), eq(devices.siteId, device.siteId)))
    .returning({ confirmedAt: devices.siteAssignmentConfirmedAt });
  if (!row) return c.json({ error: 'device_site_changed' as const }, 409);
  // Re-evaluate the org soon (the worker's 30 s debounce) rather than at the hourly pass: "Keep at" clears the stored
  // suggestion, and "Turn on" brings an eligible one back, within a minute or so. Same RLS context; only an existing
  // state row is touched (an org never evaluated has no suggestions to change). Keeps the first dirty_at stamp.
  await db.execute(sql`UPDATE topology_org_presence_state SET dirty_at = coalesce(dirty_at, now()), dirty_seq = dirty_seq + 1, updated_at = now()
    WHERE org_id = ${device.orgId}::uuid`);

  writeRouteAudit(c, {
    orgId: device.orgId,
    action: confirmed ? 'device.site_assignment_confirmed' : 'device.site_assignment_unconfirmed',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname ?? device.displayName ?? undefined,
    details: { siteId: device.siteId },
  });
  return c.json({ confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null });
}

siteAssignmentConfirmationRoutes.put(
  '/:id/site-assignment-confirmation',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  (c) => setConfirmation(c, true),
);

siteAssignmentConfirmationRoutes.delete(
  '/:id/site-assignment-confirmation',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  (c) => setConfirmation(c, false),
);
