import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { db } from '../../db';
import { devices, pamActuations } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { insertQueuedCommandInTransaction } from '../../services/commandQueueInsert';
import { CommandTypes } from '../../services/commandTypes';
import { writeRouteAudit } from '../../services/auditEvents';
import { assertDeviceExecuteAllowed, TrustDeniedError } from '../../services/partnerTrust.commands';
import { trustDenyBody } from '../../services/partnerTrust';
import { ParkedDeviceCommandRefusedError } from '../../services/unassignedPool/deliveryEligibility';
import { canAccessDeviceSite, getDeviceWithOrgCheck } from './helpers';

export const pamReconciliationRoutes = new Hono();

// Route-scoped middleware: do not attach auth to sibling device routers.
pamReconciliationRoutes.post(
  '/:id/pam-reconciliation/reset',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission('pam', 'approve'),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', z.object({ reason: z.string().trim().min(1).max(2000) }).strict()),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    if (!z.string().guid().safeParse(deviceId).success) {
      return c.json({ error: 'Invalid device id' }, 400);
    }
    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.osType !== 'windows' || device.status === 'decommissioned') {
      return c.json({ error: 'PAM reconciliation requires an enrolled Windows device' }, 400);
    }

    if (device.pamReconciliationResetProtocolVersion !== 1) {
      return c.json({ error: 'Agent does not support PAM reconciliation reset', code: 'pam_reconciliation_reset_unsupported' }, 409);
    }

    let result;
    try {
      await assertDeviceExecuteAllowed(deviceId, CommandTypes.PAM_RECONCILE_V2, auth.user.id);
      result = await db.transaction(async (tx) => {
        // Recheck ownership inside the transaction so an org move cannot queue
        // a recovery request under the old tenant. The agent checks it again.
        const [owned] = await tx.select({ id: devices.id, siteId: devices.siteId, status: devices.status, osType: devices.osType, pamReconciliationResetProtocolVersion: devices.pamReconciliationResetProtocolVersion }).from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.orgId, device.orgId))).for('update');
        if (!owned) return { kind: 'not_found' as const };
        if (!canAccessDeviceSite(owned, c.get('permissions') as UserPermissions | undefined)) {
          return { kind: 'forbidden' as const };
        }
        if (owned.osType !== 'windows' || owned.status === 'decommissioned') return { kind: 'invalid' as const };
        if (owned.pamReconciliationResetProtocolVersion !== 1) return { kind: 'unsupported' as const };
        const [active] = await tx.select({ id: pamActuations.id }).from(pamActuations)
          .where(and(eq(pamActuations.deviceId, deviceId), eq(pamActuations.orgId, device.orgId),
            eq(pamActuations.desiredState, 'active'))).limit(1);
        if (active) return { kind: 'active' as const };
        const command = await insertQueuedCommandInTransaction(tx, {
          id: randomUUID(), deviceId, type: CommandTypes.PAM_RECONCILE_V2,
          payload: { protocolVersion: 1, deviceId, orgId: device.orgId },
          createdBy: auth.user.id,
        });
        return { kind: 'queued' as const, command };
      });
    } catch (error) {
      if (error instanceof ParkedDeviceCommandRefusedError) {
        return c.json({ error: error.message, code: error.code }, 409);
      }
      if (error instanceof TrustDeniedError) {
        return c.json(trustDenyBody({
          allow: false, code: error.code, capability: 'device_execute', reason: error.reason,
        }, false), 403);
      }
      throw error;
    }
    if (result.kind === 'not_found') return c.json({ error: 'Device not found' }, 404);
    if (result.kind === 'forbidden') return c.json({ error: 'Access to this site denied' }, 403);
    if (result.kind === 'invalid') return c.json({ error: 'PAM reconciliation requires an enrolled Windows device' }, 400);
    if (result.kind === 'unsupported') return c.json({ error: 'Agent does not support PAM reconciliation reset', code: 'pam_reconciliation_reset_unsupported' }, 409);
    if (result.kind === 'active') {
      return c.json({ error: 'Revoke or expire active PAM elevations before resetting reconciliation' }, 409);
    }
    writeRouteAudit(c, {
      orgId: device.orgId, action: 'device.pam_reconciliation_reset', resourceType: 'device',
      resourceId: deviceId, resourceName: device.hostname,
      details: { reason: c.req.valid('json').reason, commandId: result.command.id },
    });
    // A reset requests fresh independent verification. It never deletes the
    // ledger or outbox, and an unreadable/unknown state remains unavailable.
    return c.json({ success: true, commandId: result.command.id, commandStatus: result.command.status }, 202);
  },
);
