/**
 * Pre-assignment holding area — full-partner-admin surface.
 *
 *   GET  /pre-assignment/devices                parked devices of one partner
 *   POST /pre-assignment/devices/:id/assign     assign one to an org + site
 *   POST /pre-assignment/devices/assign-bulk    assign a batch (1..50)
 *   POST /pre-assignment/switch                 per-partner deploy-key enrollment switch
 *   POST /pre-assignment/deploy-keys/:deployKeyId/expire-devices
 *                                               expire every still-parked device one key parked
 *
 * Every route requires partner or system scope, an interactive user session,
 * devices:write + organizations:write, an MFA-assured session, and
 * canManagePartnerWidePolicies (a partner user with org_access 'all', or
 * system scope). System scope names the partner explicitly with `?partnerId=`
 * and gets the same audit events; there is no other cross-partner path.
 *
 * All of them are self-managed DB context routes
 * (middleware/selfManagedDbContextRoutes.ts): the handlers hold no request
 * transaction; the service, the list read and the audit writer each open and
 * close their own.
 *
 * Assignment never goes through POST /devices/:id/move-org: it runs its own
 * transaction (services/unassignedPool/assignParkedDevice.ts) over the shared
 * move engine. While two-factor authentication is enabled, each request needs a
 * single-use step-up grant bound to exactly what is being assigned.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  requireInteractiveSession,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import {
  parkedAssignResourceDigest,
  parkedBulkAssignResourceDigest,
  preAssignmentEnableResourceDigest,
  validateStepUpGrant,
  type StepUpGrantBinding,
  type StepUpOperation,
} from '../services/mfaStepUpGrant';
import { getUserEpochs } from '../services/authEpochs';
import { ENABLE_2FA } from './auth/schemas';
import {
  assignParkedDevice,
  assignParkedDevicesBulk,
  type ParkedAssignRefusalCode,
} from '../services/unassignedPool/assignParkedDevice';
import { listParkedDevices } from '../services/unassignedPool/parkedDeviceReads';
import { PARKED_ASSIGN_MAX_BULK_ITEMS } from '../services/unassignedPool/limits';
import { captureException } from '../services/sentry';
import { writeAuditEvent } from '../services/auditEvents';
import {
  expireDevicesParkedByDeployKey,
  setDeployKeyEnrollmentSwitch,
} from '../services/unassignedPool/incidentActions';

export const preAssignmentRoutes = new Hono();

preAssignmentRoutes.use('*', authMiddleware);

const gates = [
  requireScope('partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
] as const;

/** A lost lock race is retried by the client after this long. */
const ASSIGNMENT_BUSY_RETRY_AFTER_SECONDS = 2;

const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;

/** Fields in the list response that the device reported about itself. */
const DEVICE_REPORTED_FIELDS = [
  'hostname',
  'osType',
  'osVersion',
  'agentVersion',
  'serialNumber',
  'manufacturer',
  'model',
  'primaryMacAddress',
] as const;

const partnerQuerySchema = z.object({ partnerId: z.string().uuid().optional() });

// Ids use .uuid() to match the step-up mint schema exactly
// (routes/auth/schemas.ts parkedAssignStepUpResource): anything this route
// accepts is something a grant can be minted for.
const assignSchema = z.object({
  orgId: z.string().uuid(),
  siteId: z.string().uuid(),
  stepUpGrant: z.string().uuid().optional(),
  // The operator confirmed out of band that this machine belongs to this
  // customer: hostname, serial and MAC are reported by the device itself.
  possessionConfirmed: z.literal(true),
  acceptIdentityCollision: z.boolean().optional(),
});

const bulkAssignSchema = z.object({
  items: z
    .array(z.object({ deviceId: z.string().uuid(), orgId: z.string().uuid(), siteId: z.string().uuid() }))
    .min(1)
    .max(PARKED_ASSIGN_MAX_BULK_ITEMS)
    .refine((items) => new Set(items.map((i) => i.deviceId)).size === items.length, {
      message: 'Each device may appear once per batch',
    }),
  stepUpGrant: z.string().uuid().optional(),
  possessionConfirmed: z.literal(true),
});

const REFUSAL_STATUS: Record<ParkedAssignRefusalCode, 400 | 403 | 404 | 409 | 500> = {
  PARTNER_WIDE_WRITE_DENIED: 403,
  DEVICE_NOT_FOUND: 404,
  DEVICE_NOT_PARKED: 409,
  DEVICE_NOT_ASSIGNABLE: 409,
  DEVICE_PARKING_EXPIRED: 409,
  TARGET_ORG_INVALID: 400,
  TARGET_SITE_INVALID: 400,
  DEVICE_IDENTITY_COLLISION: 409,
  PARTNER_DEVICE_LIMIT_REACHED: 409,
  STEP_UP_REQUIRED: 403,
  POOL_MEMBERSHIP_REFUSED: 409,
  TICKET_MOVE_CURRENCY_BLOCKED: 409,
  HOUR_BLOCK_DRAWN_TIME: 409,
  PAM_DEVICE_MOVE_BLOCKED: 409,
  DELIVERABLE_TICKET_PINNED: 409,
  ASSIGNMENT_BUSY: 409,
  ASSIGNMENT_FAILED: 500,
};

type PartnerResolution = { ok: true; partnerId: string } | { ok: false; response: Response };

/**
 * The partner whose holding area this request acts on. Partner callers act on
 * their own partner only; system callers must name one.
 */
function resolvePartner(c: Context, auth: AuthContext, requested: string | undefined): PartnerResolution {
  if (!canManagePartnerWidePolicies(auth)) {
    return { ok: false, response: c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403) };
  }
  if (auth.scope === 'system') {
    if (!requested) {
      return { ok: false, response: c.json({ error: 'partnerId is required for system scope' }, 400) };
    }
    return { ok: true, partnerId: requested };
  }
  if (!auth.partnerId || (requested && requested !== auth.partnerId)) {
    return { ok: false, response: c.json({ error: 'Access to this partner denied' }, 403) };
  }
  return { ok: true, partnerId: auth.partnerId };
}

/**
 * Builds and validates the step-up binding. Returns null with 2FA off, the
 * binding when the grant validates, or a 403/503 response.
 */
async function checkStepUp(
  c: Context,
  auth: AuthContext,
  operation: Extract<StepUpOperation, 'parked_device_assign' | 'parked_device_assign_bulk' | 'pre_assignment_enable'>,
  resourceDigest: string,
  grantId: string | undefined,
): Promise<{ binding: StepUpGrantBinding | null } | { response: Response }> {
  if (!ENABLE_2FA) return { binding: null };
  const epochs = await getUserEpochs(auth.user.id);
  const sid = auth.token?.sid;
  if (!epochs || !sid) return { response: c.json({ error: 'Service temporarily unavailable' }, 503) };
  const binding: StepUpGrantBinding = {
    userId: auth.user.id,
    operation,
    authEpoch: epochs.authEpoch,
    mfaEpoch: epochs.mfaEpoch,
    sid,
    resourceDigest,
  };
  // Missing, stale and mismatched grants are one response on purpose.
  if (!grantId || !(await validateStepUpGrant(grantId, binding))) {
    return { response: c.json(STEP_UP_REQUIRED_BODY, 403) };
  }
  return { binding };
}

preAssignmentRoutes.get('/devices', ...gates, zValidator('query', partnerQuerySchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartner(c, auth, c.req.valid('query').partnerId);
  if (!partner.ok) return partner.response;
  const parked = await listParkedDevices(partner.partnerId);
  return c.json({
    devices: parked,
    deviceReportedFields: DEVICE_REPORTED_FIELDS,
    notice: 'Identity fields are reported by the device and are not verified. Confirm ownership out of band before assigning.',
  });
});

preAssignmentRoutes.post(
  '/devices/assign-bulk',
  ...gates,
  zValidator('query', partnerQuerySchema),
  zValidator('json', bulkAssignSchema),
  async (c) => {
    const auth = c.get('auth');
    const partner = resolvePartner(c, auth, c.req.valid('query').partnerId);
    if (!partner.ok) return partner.response;
    const body = c.req.valid('json');
    const items = body.items.map((i) => ({ deviceId: i.deviceId, targetOrgId: i.orgId, targetSiteId: i.siteId }));

    const stepUp = await checkStepUp(c, auth, 'parked_device_assign_bulk', parkedBulkAssignResourceDigest(items), body.stepUpGrant);
    if ('response' in stepUp) return stepUp.response;

    let outcome: Awaited<ReturnType<typeof assignParkedDevicesBulk>>;
    try {
      outcome = await assignParkedDevicesBulk({
        actor: { auth, partnerId: partner.partnerId, allowedSiteIds: auth.allowedSiteIds },
        items,
        stepUp: stepUp.binding ? { grantId: body.stepUpGrant!, binding: stepUp.binding } : null,
        audit: c,
      });
    } catch (err) {
      console.error('[preAssignment] bulk assignment failed:', err);
      captureException(err, c);
      return c.json({ error: 'Failed to assign devices' }, 500);
    }
    if (!outcome.ok) {
      return outcome.code === 'STEP_UP_REQUIRED'
        ? c.json(STEP_UP_REQUIRED_BODY, 403)
        : c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }
    return c.json({
      results: outcome.results.map((r) => (r.ok ? { deviceId: r.deviceId, ok: true } : { deviceId: r.deviceId, ok: false, code: r.code })),
    });
  },
);

preAssignmentRoutes.post(
  '/devices/:id/assign',
  ...gates,
  zValidator('param', z.object({ id: z.string().uuid() })),
  zValidator('query', partnerQuerySchema),
  zValidator('json', assignSchema),
  async (c) => {
    const auth = c.get('auth');
    const partner = resolvePartner(c, auth, c.req.valid('query').partnerId);
    if (!partner.ok) return partner.response;
    const { id: deviceId } = c.req.valid('param');
    const body = c.req.valid('json');
    const item = {
      deviceId,
      targetOrgId: body.orgId,
      targetSiteId: body.siteId,
      acceptIdentityCollision: body.acceptIdentityCollision === true,
    };

    const stepUp = await checkStepUp(
      c,
      auth,
      'parked_device_assign',
      parkedAssignResourceDigest({ deviceId, targetOrgId: body.orgId, targetSiteId: body.siteId }),
      body.stepUpGrant,
    );
    if ('response' in stepUp) return stepUp.response;

    let result: Awaited<ReturnType<typeof assignParkedDevice>>;
    try {
      result = await assignParkedDevice({
        actor: { auth, partnerId: partner.partnerId, allowedSiteIds: auth.allowedSiteIds },
        item,
        stepUp: stepUp.binding ? { grantId: body.stepUpGrant!, binding: stepUp.binding } : null,
        audit: c,
      });
    } catch (err) {
      console.error(`[preAssignment] assignment of ${deviceId} failed:`, err);
      captureException(err, c);
      return c.json({ error: 'Failed to assign device' }, 500);
    }

    if (!result.ok) {
      if (result.code === 'STEP_UP_REQUIRED') return c.json(STEP_UP_REQUIRED_BODY, 403);
      if (result.code === 'ASSIGNMENT_BUSY') c.header('Retry-After', String(ASSIGNMENT_BUSY_RETRY_AFTER_SECONDS));
      return c.json(
        {
          error: result.message,
          code: result.code,
          ...(result.collidingDeviceIds ? { collidingDeviceIds: result.collidingDeviceIds } : {}),
        },
        REFUSAL_STATUS[result.code],
      );
    }
    return c.json({ success: true, deviceId, orgId: result.targetOrgId, siteId: result.targetSiteId });
  },
);

// ---------------------------------------------------------------------------
// Incident actions. The switch stops deploy-key enrollment for this partner
// (the platform flag PRE_ASSIGNMENT_ENROLLMENT_ENABLED stops it everywhere);
// expire-devices removes what one key already parked.
// ---------------------------------------------------------------------------

preAssignmentRoutes.post(
  '/switch',
  ...gates,
  zValidator('query', partnerQuerySchema),
  zValidator('json', z.object({ enabled: z.boolean(), stepUpGrant: z.string().uuid().optional() })),
  async (c) => {
    const auth = c.get('auth');
    const partner = resolvePartner(c, auth, c.req.valid('query').partnerId);
    if (!partner.ok) return partner.response;
    const { enabled, stepUpGrant } = c.req.valid('json');

    // Turning deploy-key enrollment ON opens a new way for devices to enroll,
    // so (while two-factor authentication is enabled) it needs a single-use
    // step-up grant bound to this partner, consumed inside the switch's own
    // transaction. Turning it OFF is the kill switch: instant, no step-up.
    let stepUp: { grantId: string; binding: StepUpGrantBinding; auth: AuthContext } | null = null;
    if (enabled) {
      const checked = await checkStepUp(
        c,
        auth,
        'pre_assignment_enable',
        preAssignmentEnableResourceDigest({ partnerId: partner.partnerId }),
        stepUpGrant,
      );
      if ('response' in checked) return checked.response;
      if (checked.binding) stepUp = { grantId: stepUpGrant!, binding: checked.binding, auth };
    }

    const updated = await setDeployKeyEnrollmentSwitch({ partnerId: partner.partnerId, enabled, stepUp });
    if (updated === 'STEP_UP_REQUIRED') return c.json(STEP_UP_REQUIRED_BODY, 403);
    if (!updated) return c.json({ error: 'Partner not found' }, 404);
    writeAuditEvent(c, {
      orgId: null,
      action: 'partner.pre_assignment_switch.update',
      resourceType: 'partner',
      resourceId: partner.partnerId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      details: {
        partnerId: partner.partnerId,
        enabled: updated.enabled,
        previous: updated.previous,
        ...(enabled ? { stepUp: stepUp ? 'grant' : 'disabled_2fa' } : {}),
      },
    });
    return c.json({ enabled: updated.enabled, previous: updated.previous });
  },
);

preAssignmentRoutes.post(
  '/deploy-keys/:deployKeyId/expire-devices',
  ...gates,
  zValidator('param', z.object({ deployKeyId: z.string().uuid() })),
  zValidator('query', partnerQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const partner = resolvePartner(c, auth, c.req.valid('query').partnerId);
    if (!partner.ok) return partner.response;
    const { deployKeyId } = c.req.valid('param');
    let result: Awaited<ReturnType<typeof expireDevicesParkedByDeployKey>>;
    try {
      result = await expireDevicesParkedByDeployKey({ partnerId: partner.partnerId, deployKeyId, actorUserId: auth.user.id });
    } catch (err) {
      console.error(`[preAssignment] expire-devices for deploy key ${deployKeyId} failed:`, err);
      captureException(err, c);
      return c.json({ error: 'Failed to expire devices' }, 500);
    }
    writeAuditEvent(c, {
      orgId: null,
      action: 'partner.pre_assignment.expire_devices_by_key',
      resourceType: 'partner',
      resourceId: partner.partnerId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      details: { partnerId: partner.partnerId, deployKeyId, ...result },
      result: result.failed > 0 ? 'failure' : 'success',
    });
    return c.json(result);
  },
);
