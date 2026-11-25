/**
 * Holding-area deploy keys — full-partner-admin surface (#8318 wave D-1,
 * spec 2026-10-12 §10). Mounted by routes/preAssignment.ts under
 * /pre-assignment/deploy-keys, behind its authMiddleware:
 *
 *   GET  /pre-assignment/deploy-keys              keys of one partner (never the hash)
 *   POST /pre-assignment/deploy-keys              mint (plaintext returned once)
 *   POST /pre-assignment/deploy-keys/:deployKeyId/rotate  mint a successor (plaintext returned once)
 *   POST /pre-assignment/deploy-keys/:deployKeyId/revoke  revoke + expire everything the key parked
 *
 * Same gates as every pre-assignment route (routes/preAssignmentShared.ts):
 * partner or system scope, an interactive user session, devices:write +
 * organizations:write, an MFA-assured session, and
 * canManagePartnerWidePolicies. System scope names the partner with
 * `?partnerId=`.
 *
 * Mint and rotate open a way for devices to enroll, so while two-factor
 * authentication is enabled each needs a single-use step-up grant:
 * `deploy_key_mint` bound to { partnerId, imageLabel }, `deploy_key_rotate`
 * bound to { partnerId, deployKeyId }. Revoke only closes and needs none.
 *
 * Self-managed DB context routes (middleware/selfManagedDbContextRoutes.ts):
 * the handlers hold no request transaction; the service
 * (services/deployKeys/manage.ts) opens its own system contexts and the audit
 * writer its own. Audit rows never carry the hash or the plaintext.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import type { AuthContext } from '../middleware/auth';
import { deployKeyMintResourceDigest, deployKeyRotateResourceDigest } from '../services/mfaStepUpGrant';
import { captureException } from '../services/sentry';
import { writeAuditEvent } from '../services/auditEvents';
import {
  listDeployKeys,
  mintDeployKey,
  revokeDeployKey,
  rotateDeployKey,
  type DeployKeyRefusal,
  type DeployKeyRefusalCode,
  type DeployKeyStepUp,
  type DeployKeyView,
} from '../services/deployKeys/manage';
import { mintDeployKeyBodySchema, rotateDeployKeyBodySchema } from '../services/deployKeys/schemas';
import {
  checkStepUp,
  partnerQuerySchema,
  preAssignmentGates as gates,
  resolvePartner,
  STEP_UP_REQUIRED_BODY,
} from './preAssignmentShared';

export const preAssignmentDeployKeyRoutes = new Hono();

const REFUSAL_STATUS: Record<DeployKeyRefusalCode, 403 | 404 | 409> = {
  PARTNER_WIDE_WRITE_DENIED: 403,
  PARTNER_NOT_FOUND: 404,
  DEPLOY_KEY_NOT_ELIGIBLE: 409,
  ACTIVE_KEY_LIMIT_REACHED: 409,
  DEPLOY_KEY_NOT_FOUND: 404,
  DEPLOY_KEY_REVOKED: 409,
  STEP_UP_REQUIRED: 403,
};

const PLAINTEXT_NOTICE = 'This is the only time the deploy key is shown. Store it in the image now; it cannot be retrieved later.';

const idParam = z.object({ deployKeyId: z.string().uuid() });

function refusalResponse(c: Context, refusal: DeployKeyRefusal): Response {
  if (refusal.code === 'STEP_UP_REQUIRED') return c.json(STEP_UP_REQUIRED_BODY, 403);
  return c.json(
    { error: refusal.message, code: refusal.code, ...(refusal.reason ? { reason: refusal.reason } : {}) },
    REFUSAL_STATUS[refusal.code],
  );
}

/** Audit details for a key: what it is and what it allows, never the hash. */
function auditKeyDetails(key: DeployKeyView) {
  return {
    deployKeyId: key.id,
    name: key.name,
    imageLabel: key.imageLabel,
    expiresAt: key.expiresAt.toISOString(),
    maxUsage: key.maxUsage,
    maxParked: key.maxParked,
    sourceCidrs: key.sourceCidrs,
    rotatedFromId: key.rotatedFromId,
  };
}

function stepUpFor(grantId: string | undefined, binding: DeployKeyStepUp['binding'] | null): DeployKeyStepUp | null {
  return binding ? { grantId: grantId!, binding } : null;
}

function audit(
  c: Context,
  auth: AuthContext,
  partnerId: string,
  action: string,
  details: Record<string, unknown>,
  result: 'success' | 'failure' = 'success',
) {
  writeAuditEvent(c, {
    orgId: null,
    action,
    resourceType: 'partner_deploy_key',
    resourceId: typeof details.deployKeyId === 'string' ? details.deployKeyId : partnerId,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    details: { partnerId, ...details },
    result,
  });
}

preAssignmentDeployKeyRoutes.get('/', ...gates, zValidator('query', partnerQuerySchema), async (c) => {
  const auth = c.get('auth');
  const partner = resolvePartner(c, auth, c.req.valid('query').partnerId);
  if (!partner.ok) return partner.response;
  const listed = await listDeployKeys({ auth, partnerId: partner.partnerId });
  if (!listed.ok) return refusalResponse(c, listed);
  return c.json({ deployKeys: listed.keys });
});

preAssignmentDeployKeyRoutes.post(
  '/',
  ...gates,
  zValidator('query', partnerQuerySchema),
  zValidator('json', mintDeployKeyBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const partner = resolvePartner(c, auth, c.req.valid('query').partnerId);
    if (!partner.ok) return partner.response;
    const body = c.req.valid('json');

    const stepUp = await checkStepUp(
      c,
      auth,
      'deploy_key_mint',
      deployKeyMintResourceDigest({ partnerId: partner.partnerId, imageLabel: body.imageLabel }),
      body.stepUpGrant,
    );
    if ('response' in stepUp) return stepUp.response;

    let result: Awaited<ReturnType<typeof mintDeployKey>>;
    try {
      result = await mintDeployKey({
        actor: { auth, partnerId: partner.partnerId },
        key: {
          name: body.name,
          imageLabel: body.imageLabel,
          expiresInDays: body.expiresInDays,
          maxUsage: body.maxUsage,
          maxParked: body.maxParked,
          sourceCidrs: body.sourceCidrs ?? null,
        },
        stepUp: stepUpFor(body.stepUpGrant, stepUp.binding),
      });
    } catch (err) {
      console.error('[preAssignment] deploy key mint failed:', err);
      captureException(err, c);
      return c.json({ error: 'Failed to mint deploy key' }, 500);
    }
    if (!result.ok) return refusalResponse(c, result);

    audit(c, auth, partner.partnerId, 'partner.deploy_key.mint', {
      ...auditKeyDetails(result.key),
      stepUp: stepUp.binding ? 'grant' : 'disabled_2fa',
    });
    return c.json({ deployKey: result.key, key: result.plaintextKey, notice: PLAINTEXT_NOTICE }, 201);
  },
);

preAssignmentDeployKeyRoutes.post(
  '/:deployKeyId/rotate',
  ...gates,
  zValidator('param', idParam),
  zValidator('query', partnerQuerySchema),
  zValidator('json', rotateDeployKeyBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const partner = resolvePartner(c, auth, c.req.valid('query').partnerId);
    if (!partner.ok) return partner.response;
    const { deployKeyId } = c.req.valid('param');
    const body = c.req.valid('json');

    const stepUp = await checkStepUp(
      c,
      auth,
      'deploy_key_rotate',
      deployKeyRotateResourceDigest({ partnerId: partner.partnerId, deployKeyId }),
      body.stepUpGrant,
    );
    if ('response' in stepUp) return stepUp.response;

    let result: Awaited<ReturnType<typeof rotateDeployKey>>;
    try {
      result = await rotateDeployKey({
        actor: { auth, partnerId: partner.partnerId },
        deployKeyId,
        key: {
          expiresInDays: body.expiresInDays,
          name: body.name,
          maxUsage: body.maxUsage,
          maxParked: body.maxParked,
          sourceCidrs: body.sourceCidrs,
        },
        stepUp: stepUpFor(body.stepUpGrant, stepUp.binding),
      });
    } catch (err) {
      console.error(`[preAssignment] deploy key ${deployKeyId} rotation failed:`, err);
      captureException(err, c);
      return c.json({ error: 'Failed to rotate deploy key' }, 500);
    }
    if (!result.ok) return refusalResponse(c, result);

    audit(c, auth, partner.partnerId, 'partner.deploy_key.rotate', {
      ...auditKeyDetails(result.key),
      stepUp: stepUp.binding ? 'grant' : 'disabled_2fa',
    });
    return c.json(
      { deployKey: result.key, rotatedFrom: result.rotatedFrom, key: result.plaintextKey, notice: PLAINTEXT_NOTICE },
      201,
    );
  },
);

preAssignmentDeployKeyRoutes.post(
  '/:deployKeyId/revoke',
  ...gates,
  zValidator('param', idParam),
  zValidator('query', partnerQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const partner = resolvePartner(c, auth, c.req.valid('query').partnerId);
    if (!partner.ok) return partner.response;
    const { deployKeyId } = c.req.valid('param');

    let result: Awaited<ReturnType<typeof revokeDeployKey>>;
    try {
      result = await revokeDeployKey({ actor: { auth, partnerId: partner.partnerId }, deployKeyId });
    } catch (err) {
      console.error(`[preAssignment] deploy key ${deployKeyId} revocation failed:`, err);
      captureException(err, c);
      // The key may already be revoked; repeating the request re-runs the expiry.
      return c.json({ error: 'Failed to revoke deploy key; retry to finish expiring its parked devices' }, 500);
    }
    if (!result.ok) return refusalResponse(c, result);

    audit(
      c,
      auth,
      partner.partnerId,
      'partner.deploy_key.revoke',
      {
        deployKeyId: result.key.id,
        name: result.key.name,
        imageLabel: result.key.imageLabel,
        alreadyRevoked: result.alreadyRevoked,
        ...result.expiry,
      },
      result.expiry.failed > 0 ? 'failure' : 'success',
    );
    return c.json({ deployKey: result.key, alreadyRevoked: result.alreadyRevoked, expiry: result.expiry });
  },
);
