/**
 * Reattach a reinstalled machine to its existing device record (#8318 wave
 * 2-2, spec docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §7.3, §8, §9).
 *
 *   GET  /devices/:id/reinstall-candidates   the dialog's read: ranked targets
 *                                            for this source, as the caller may
 *                                            see them (services/reinstallCandidates/viewer.ts)
 *   POST /devices/:id/reattach               request the reattach of source :id
 *                                            onto `targetDeviceId`
 *
 * The POST only CREATES the intent (`requested`). The rest is the bounded
 * rebind of wave 1b: the source's agent receives a signed directive, stages
 * its own new credentials (phase 1) and confirms (phase 2), and confirm is the
 * authoritative check of everything below (§6.4).
 *
 * Gates of the POST (§8 "Gates"): partner scope only (a customer-org user
 * never reattaches), an interactive user session (API keys, MCP grants and AI
 * agents refused), devices:write + devices:delete, a satisfied MFA session,
 * then the §8 access rule, every §8 refusal and the typed confirmations in
 * services/deviceReattach/requestIntent.ts, under the partner's holding-area
 * lock and both device row locks. While two-factor authentication is enabled
 * the request needs a `device_reattach` step-up grant (POST /auth/mfa/step-up)
 * bound to { sourceDeviceId, targetDeviceId, targetAgentId, targetIncarnation,
 * evidenceLevel, restoreDecommissioned } — the last four as the candidates
 * read returned them — consumed in the creating transaction after every
 * refusal, so a refusal never burns it.
 *
 * Both routes are self-managed DB context routes
 * (middleware/selfManagedDbContextRoutes.ts): the request path reads Redis
 * (liveness, the grant) and opens system transactions of its own; under the
 * ambient request transaction every one of them would pin a second pooled
 * connection (#1105).
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
import { PERMISSIONS } from '../../services/permissions';
import { getUserEpochs } from '../../services/authEpochs';
import { ENABLE_2FA } from '../auth/schemas';
import { captureException } from '../../services/sentry';
import { requestDeviceReattach } from '../../services/deviceReattach/requestIntent';
import { refusalBody } from '../../services/deviceReattach/errors';
import { readReinstallCandidatesForViewer } from '../../services/reinstallCandidates/viewer';

export const reattachRoutes = new Hono();

reattachRoutes.use('*', authMiddleware);

const sourceParamSchema = z.object({ id: z.string().uuid() });

/**
 * The body of §8. `evidenceLevel` is not a field: the server decides it, and
 * until TPM evidence ships (wave T2) every reattach is `hint`, which needs the
 * target's name typed in `confirmTargetName`.
 */
export const reattachBodySchema = z.object({
  targetDeviceId: z.string().uuid(),
  // The technician confirmed out of band that the new install runs on the
  // machine the existing record describes: every identifier shown is reported
  // by the device itself.
  possessionConfirmed: z.literal(true),
  confirmTargetName: z.string().max(255).optional(),
  restoreDecommissioned: z.boolean().default(false),
  acknowledgeOsChange: z.boolean().default(false),
  // Single-use `device_reattach` grant. Optional in the schema so a missing
  // grant answers the same 403 as a stale one, after every other refusal.
  stepUpGrant: z.string().uuid().optional(),
}).strict();

reattachRoutes.get(
  '/:id/reinstall-candidates',
  requireScope('organization', 'partner'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', sourceParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    let view: Awaited<ReturnType<typeof readReinstallCandidatesForViewer>>;
    try {
      view = await readReinstallCandidatesForViewer({ sourceDeviceId: id.toLowerCase(), viewer: auth });
    } catch (err) {
      console.error(`[reattach] candidates read for ${id} failed:`, err);
      captureException(err, c);
      return c.json({ error: 'Failed to read reinstall candidates' }, 500);
    }
    if (!view) return c.json({ error: 'Device not found' }, 404);
    return c.json(view);
  },
);

reattachRoutes.post(
  '/:id/reattach',
  requireScope('partner'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  zValidator('param', sourceParamSchema),
  zValidator('json', reattachBodySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const sourceDeviceId = c.req.valid('param').id.toLowerCase();
    const body = c.req.valid('json');

    let stepUp: Parameters<typeof requestDeviceReattach>[0]['stepUp'] = null;
    if (ENABLE_2FA) {
      const epochs = await getUserEpochs(auth.user.id);
      const sid = auth.token?.sid;
      if (!epochs || !sid) return c.json({ error: 'Service temporarily unavailable' }, 503);
      stepUp = {
        grantId: body.stepUpGrant ?? null,
        auth,
        binding: { authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch, sid },
      };
    }

    let result: Awaited<ReturnType<typeof requestDeviceReattach>>;
    try {
      result = await requestDeviceReattach({
        actor: { userId: auth.user.id },
        sourceDeviceId,
        targetDeviceId: body.targetDeviceId.toLowerCase(),
        evidenceLevel: 'hint',
        restoreDecommissioned: body.restoreDecommissioned,
        acknowledgeOsChange: body.acknowledgeOsChange,
        confirmTargetName: body.confirmTargetName ?? null,
        stepUp,
      });
    } catch (err) {
      console.error(`[reattach] request for source ${sourceDeviceId} failed:`, err);
      captureException(err, c);
      return c.json({ error: 'Failed to request the reattach' }, 500);
    }

    if (!result.ok) return c.json(refusalBody(result), result.status);
    const { intent } = result;
    return c.json({
      intent: {
        id: intent.id,
        state: intent.state,
        sourceDeviceId: intent.sourceDeviceId,
        targetDeviceId: intent.targetDeviceId,
        evidenceLevel: intent.evidenceLevel,
        restoreDecommissioned: intent.restoreDecommissioned,
        requestedAt: intent.requestedAt.toISOString(),
        expiresAt: intent.expiresAt.toISOString(),
      },
    }, 202);
  },
);
