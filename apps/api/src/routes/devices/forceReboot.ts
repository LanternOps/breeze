import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db, runAfterDbContextCommit, withDbTransaction } from '../../db';
import {
  authMiddleware,
  requireInteractiveSession,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { canAccessDeviceSite, getDeviceWithOrgCheck } from './helpers';
import {
  consumeStepUpGrant,
  forceRebootResourceDigest,
  validateStepUpGrant,
  type StepUpGrantBinding,
} from '../../services/mfaStepUpGrant';
import { getUserEpochs } from '../../services/authEpochs';
import { lockActorAssurance } from '../../services/stepUpActorAssurance';
import { ENABLE_2FA } from '../auth/schemas';
import { writeRouteAudit } from '../../services/auditEvents';
import { dispatchDeviceCommand } from '../../services/dispatchDeviceCommand';
import { assertDeviceExecuteAllowed, TrustDeniedError } from '../../services/partnerTrust.commands';
import { trustDenyBody, type TrustDenyCode } from '../../services/partnerTrust';
import { CommandTypes } from '../../services/commandTypes';
import {
  MIN_AGENT_VERSION_FORCE_REBOOT,
  agentSupportsForceReboot,
  forceRebootArgv,
  forceRebootOfflinePolicy,
  type ForceRebootOs,
} from '../../services/forceReboot';

export const forceRebootRoutes = new Hono();

forceRebootRoutes.use('*', authMiddleware);

const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;
const DEVICE_OFFLINE_BODY = {
  error: 'The device is not online. A force reboot is only sent to a device that is online now.',
  code: 'DEVICE_OFFLINE',
} as const;

/** Thrown inside the savepoint so it rolls back (queued row included) as a refusal, not a failure. */
class ForceRebootStepUpConsumedError extends Error {}
/** Thrown inside the savepoint when the device is no longer online: the queued row is dropped. */
class ForceRebootDeviceOfflineError extends Error {}

const forceRebootSchema = z.object({
  // Single-use `device_force_reboot` grant from POST /auth/mfa/step-up, bound
  // to { deviceId }. Optional in the schema so a missing grant answers the
  // same 403 as a stale one; required whenever 2FA is enabled.
  stepUpGrant: z.string().uuid().optional(),
}).strict();

/**
 * POST /devices/:id/force-reboot — "Force reboot now" (#8729).
 *
 * An immediate reboot that force-closes running apps (`shutdown /r /f /t 0` on
 * Windows; on macOS and Linux `shutdown -r` does not wait on apps, so force
 * changes nothing there). Plain Reboot is unchanged and keeps its own route.
 *
 * This is the ONLY way to queue `force_reboot`
 * (__tests__/forceRebootExposure.contract.test.ts): the generic single and
 * bulk command routes, AI tools, MCP, mobile, fix-memory and fleet findings
 * cannot. A force-close of unsaved work stays a human, step-up action:
 *   - interactive user session (API keys, MCP grants and AI agents refused,
 *     whatever the 2FA setting), devices:execute, satisfied MFA;
 *   - a single-use `device_force_reboot` grant bound to THIS device.
 *
 * Order: the device checks (agent version, online, OS, partner trust) run
 * before the step-up is even asked for, and every check that can refuse, the
 * enqueue seam's own included, runs BEFORE the grant is consumed, so a refusal leaves it unspent and the
 * technician can retry without a second factor prompt. In one savepoint the
 * actor's assurance is locked, the command is queued through the normal
 * enqueue seam (so the power-state barrier still holds it behind in-flight
 * work, and the 15-minute live_only window expires it rather than letting it
 * fire late), and the grant is consumed last; a failed consume rolls the row
 * back.
 */
forceRebootRoutes.post(
  '/:id/force-reboot',
  requireScope('organization', 'partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', forceRebootSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const deviceId = c.req.param('id')!;
    const { stepUpGrant } = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
    }

    // Everything below that can refuse the DEVICE runs before the step-up
    // check, so the technician hears "agent too old", "not online" or a trust
    // denial on the first submit, before being asked for a factor.
    //
    // An agent that predates force_reboot would answer "unknown command type".
    // Unknown, empty and unparseable versions fail closed.
    if (!agentSupportsForceReboot(device.agentVersion)) {
      return c.json({
        error: `This device's agent is too old for a force reboot. Update the agent to ${MIN_AGENT_VERSION_FORCE_REBOOT} or later.`,
        code: 'AGENT_UPGRADE_REQUIRED',
        agentVersion: device.agentVersion ?? null,
        minAgentVersion: MIN_AGENT_VERSION_FORCE_REBOOT,
      }, 409);
    }

    // "Now" means now: never queue a force-close for a device that is not
    // online. Same definition of online as the enqueue seam
    // (services/dispatchDeviceCommand.ts), so a device in maintenance mode is
    // refused too; end maintenance first.
    if (device.status !== 'online') {
      return c.json(DEVICE_OFFLINE_BODY, 409);
    }

    const argv = forceRebootArgv(device.osType as ForceRebootOs);
    if (!argv) {
      return c.json({ error: `Force reboot is not supported on ${device.osType}` }, 400);
    }

    try {
      await assertDeviceExecuteAllowed(deviceId, CommandTypes.FORCE_REBOOT, auth.user.id);
    } catch (error) {
      if (!(error instanceof TrustDeniedError)) throw error;
      return c.json(trustDenyBody({
        allow: false,
        code: error.code,
        capability: 'device_execute',
        reason: error.reason,
      }, false), 403);
    }

    // Step-up: validate now (non-consuming), consume only after the command is
    // queued (below). Missing, stale and mismatched grants are ONE response:
    // telling them apart would be a probing oracle for the binding.
    let grantBinding: StepUpGrantBinding | null = null;
    if (ENABLE_2FA) {
      const epochs = await getUserEpochs(auth.user.id);
      const sid = auth.token?.sid;
      if (!epochs || !sid) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
      grantBinding = {
        userId: auth.user.id,
        operation: 'device_force_reboot',
        authEpoch: epochs.authEpoch,
        mfaEpoch: epochs.mfaEpoch,
        sid,
        resourceDigest: forceRebootResourceDigest({ deviceId }),
      };
      if (!stepUpGrant || !(await validateStepUpGrant(stepUpGrant, grantBinding))) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
    }

    // One savepoint, in this order: lock the actor's assurance (SHARE on the
    // users row, held until commit), queue the row, THEN consume the grant.
    //   - The grant is a Redis GETDEL, outside Postgres, so a rollback cannot
    //     un-spend it. Consuming last is what keeps it unspent when the enqueue
    //     seam refuses (trust, a parked device) or the device is no longer
    //     online (below).
    //   - A consume that fails (replayed or revoked grant) throws, and the
    //     savepoint rolls the queued row back: no command without a spent grant.
    //   - The actor lock covers the insert, so a session revoke or MFA reset
    //     cannot land between the check and the row existing.
    // deferDelivery: the socket push runs only after the request commits.
    let res: Awaited<ReturnType<typeof dispatchDeviceCommand>>;
    try {
      res = await withDbTransaction(async () => {
        if (grantBinding && !(await lockActorAssurance(db, auth, grantBinding))) {
          throw new ForceRebootStepUpConsumedError();
        }
        const dispatched = await dispatchDeviceCommand({
          deviceId,
          type: CommandTypes.FORCE_REBOOT,
          // The agent derives the argv itself (ForceRebootArgv); nothing to carry.
          payload: {},
          userId: auth.user.id,
          deferDelivery: true,
          // live_only, but never longer than 15 minutes (services/forceReboot.ts).
          offlinePolicy: forceRebootOfflinePolicy(),
        });
        if (!dispatched.ok) return dispatched;
        // The device went offline between the check above and the seam's own
        // read. force_reboot is a live_only QUEUE type, so the seam would keep
        // the row for 15 minutes rather than refuse; "now" means now, so throw
        // and let the savepoint drop the row instead.
        if (dispatched.delivery === 'queued_offline') throw new ForceRebootDeviceOfflineError();
        if (grantBinding && !(await consumeStepUpGrant(stepUpGrant!, grantBinding))) {
          throw new ForceRebootStepUpConsumedError();
        }
        return dispatched;
      });
    } catch (error) {
      if (error instanceof ForceRebootStepUpConsumedError) return c.json(STEP_UP_REQUIRED_BODY, 403);
      if (error instanceof ForceRebootDeviceOfflineError) return c.json(DEVICE_OFFLINE_BODY, 409);
      throw error;
    }
    if (!res.ok) {
      if (res.code === 'device_offline') return c.json(DEVICE_OFFLINE_BODY, 409);
      if (res.code === 'device_pending_assignment') return c.json({ error: res.error, code: res.code }, 409);
      if (res.code === 'device_decommissioned') {
        return c.json({ error: 'Cannot send commands to a decommissioned device' }, 400);
      }
      if (res.code === 'device_not_found') return c.json({ error: 'Device not found' }, 404);
      if (res.code === 'trust_denied' && res.trust) {
        return c.json(trustDenyBody({
          allow: false,
          code: res.error as TrustDenyCode,
          capability: 'device_execute',
          reason: res.trust.reason,
        }, false), 403);
      }
      return c.json({ error: res.error }, 500);
    }
    const command = res.command;

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: `agent.command.${CommandTypes.FORCE_REBOOT}`,
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        commandId: command.id,
        type: CommandTypes.FORCE_REBOOT,
        force: true,
        osType: device.osType,
        argv,
        stepUp: grantBinding ? 'device_force_reboot' : 'not_required',
        delivery: res.delivery,
      },
    });

    if (res.deliver) {
      const deliver = res.deliver;
      runAfterDbContextCommit('devices.forceReboot.deliver', async () => {
        await deliver();
      });
    }

    return c.json({
      id: command.id,
      deviceId: command.deviceId,
      type: command.type,
      status: command.status,
      createdAt: command.createdAt,
      delivery: res.delivery,
      deliverBy: res.deliverBy,
      argv,
    }, 201);
  },
);
