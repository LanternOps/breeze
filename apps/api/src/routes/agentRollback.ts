import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  isInteractiveUserSession,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../middleware/auth';
import {
  AgentRollbackValidationError,
  createAgentRollbackDirective,
} from '../services/agentRollback';
import { getUserEpochs } from '../services/authEpochs';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import {
  canAccessDeviceSite,
  getDeviceWithOrgCheck,
} from './devices/helpers';

const requestSchema = z.object({
  targetVersion: z.string().min(1).max(20),
  reason: z.string().trim().min(1).max(1000),
  stepUpGrant: z.string().uuid(),
}).strict();

type RollbackDevice = NonNullable<Awaited<ReturnType<typeof getDeviceWithOrgCheck>>>;

export const agentRollbackRoutes = new Hono();
agentRollbackRoutes.use('*', authMiddleware);

agentRollbackRoutes.post(
  '/:id/agent-rollback',
  requireScope('organization', 'partner'),
  async (c, next) => {
    const auth = c.get('auth') as AuthContext;
    if (!isInteractiveUserSession(auth)) {
      return c.json({ error: 'Interactive user session required' }, 403);
    }
    const device = await getDeviceWithOrgCheck(c.req.param('id')!, auth);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    c.set('rollbackDevice' as never, device as never);
    return next();
  },
  requirePermission(
    PERMISSIONS.AGENT_ROLLBACK_CREATE.resource,
    PERMISSIONS.AGENT_ROLLBACK_CREATE.action,
  ),
  async (c, next) => {
    const device = c.get('rollbackDevice' as never) as RollbackDevice;
    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (!canAccessDeviceSite(device, permissions)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    return next();
  },
  requireMfa(),
  zValidator('json', requestSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    const epochs = await getUserEpochs(auth.user.id);
    const sid = auth.token?.sid;
    if (!epochs || !sid) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
    try {
      const directive = await createAgentRollbackDirective({
        deviceId: c.req.param('id')!,
        targetVersion: body.targetVersion,
        reason: body.reason,
        authorizedBy: auth.user.id,
        stepUpGrantId: body.stepUpGrant,
        authEpoch: epochs.authEpoch,
        mfaEpoch: epochs.mfaEpoch,
        sid,
      });
      return c.json({ directive }, 202);
    } catch (error) {
      if (!(error instanceof AgentRollbackValidationError)) throw error;
      if (/step-up grant/i.test(error.message)) {
        return c.json({ error: 'Rollback authorization is missing, stale, or does not match' }, 403);
      }
      if (/active rollback|state changed/i.test(error.message)) {
        return c.json({ error: error.message }, 409);
      }
      return c.json({ error: error.message }, 400);
    }
  },
);
