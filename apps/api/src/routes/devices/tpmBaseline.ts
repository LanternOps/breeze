/**
 * A device's TPM key baseline (#8318 wave T2, spec §12.2).
 *
 *   GET  /devices/:id/tpm-baseline            what the device's key state is:
 *                                             attested, when, and a held key
 *                                             change with the version to review
 *                                             it by. Never a key hash.
 *   POST /devices/:id/tpm-baseline/mismatch   accept or dismiss the held key
 *                                             change (services/tpmBaseline)
 *
 * The GET needs only devices:read and the device's org and site. The POST has
 * the reattach gates (§8): partner scope, an interactive session,
 * devices:write + devices:delete, a satisfied MFA session, then the reattach
 * access rule on that device in the service; `accept` also needs a
 * `device_tpm_baseline_accept` step-up (POST /auth/mfa/step-up) bound to
 * { deviceId, baselineVersion } while two-factor authentication is on.
 *
 * The POST is a self-managed DB context route (selfManagedDbContextRoutes.ts):
 * its system transaction consumes the step-up grant (Redis) under the device
 * row lock, and under the ambient request transaction it would pin a second
 * pooled connection (#1105).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  authMiddleware,
  requireInteractiveSession,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { getUserEpochs } from '../../services/authEpochs';
import { buildAuditLogParams } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { refusalBody } from '../../services/deviceReattach/errors';
import { detectAfterKeyBaseline } from '../../services/reinstallCandidates';
import {
  readTpmBaselineView,
  reviewTpmKeyMismatch,
  TPM_BASELINE_VERSION_PATTERN,
  type TpmReviewStepUp,
} from '../../services/tpmBaseline';
import { ENABLE_2FA } from '../auth/schemas';
import { canAccessDeviceSite, getDeviceWithOrgCheck } from './helpers';

export const tpmBaselineRoutes = new Hono();

tpmBaselineRoutes.use('*', authMiddleware);

const deviceParamSchema = z.object({ id: z.string().uuid() });

export const tpmMismatchBodySchema = z.object({
  action: z.enum(['accept', 'dismiss']),
  // The `mismatch.version` the GET returned for the hold being reviewed.
  version: z.string().regex(TPM_BASELINE_VERSION_PATTERN),
  // Single-use `device_tpm_baseline_accept` grant, for `accept`. Optional in
  // the schema so a missing grant answers the same 403 as a stale one.
  stepUpGrant: z.string().uuid().optional(),
}).strict();

tpmBaselineRoutes.get(
  '/:id/tpm-baseline',
  requireScope('organization', 'partner'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const device = await getDeviceWithOrgCheck(c.req.valid('param').id, auth);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    return c.json(await readTpmBaselineView(device.id));
  },
);

tpmBaselineRoutes.post(
  '/:id/tpm-baseline/mismatch',
  requireScope('partner'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  zValidator('param', deviceParamSchema),
  zValidator('json', tpmMismatchBodySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const deviceId = c.req.valid('param').id.toLowerCase();
    const body = c.req.valid('json');
    const permissions = c.get('permissions') as UserPermissions | undefined;

    let stepUp: TpmReviewStepUp = { kind: 'not_required' };
    if (ENABLE_2FA && body.action === 'accept') {
      const epochs = await getUserEpochs(auth.user.id);
      const sid = auth.token?.sid;
      if (!epochs || !sid) return c.json({ error: 'Service temporarily unavailable' }, 503);
      stepUp = {
        kind: 'grant',
        grantId: body.stepUpGrant ?? null,
        auth,
        binding: { authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch, sid },
      };
    }

    let result: Awaited<ReturnType<typeof reviewTpmKeyMismatch>>;
    try {
      result = await reviewTpmKeyMismatch({
        actor: { userId: auth.user.id },
        deviceId,
        action: body.action,
        version: body.version,
        canAccessSite: (siteId) => canAccessDeviceSite({ siteId }, permissions),
        stepUp,
        audit: (action, orgId) => buildAuditLogParams(c, {
          orgId,
          action,
          resourceType: 'device',
          resourceId: deviceId,
          actorType: 'user',
          actorId: auth.user.id,
          result: 'success',
          // No key hash: the decision and whether a step-up was spent.
          details: { stepUp: stepUp.kind },
        }),
      });
    } catch (err) {
      console.error(`[tpmBaseline] review of ${deviceId} failed:`, err);
      captureException(err, c);
      return c.json({ error: 'Failed to review the TPM key change' }, 500);
    }
    if (!result.ok) return c.json(refusalBody(result), result.status);
    // The accepted key may name the record this install is a reinstall of.
    if (result.action === 'accept') void detectAfterKeyBaseline(deviceId);
    // The client re-reads GET /tpm-baseline: no read here, outside every DB context.
    return c.json({ action: result.action });
  },
);
