/**
 * IOC sweeps (#6263 W05-6): run pinned YARA rule sets against every eligible
 * device in a scope, watch progress, cancel.
 *
 *   POST /security/sweeps/preview           devices:execute — writes nothing
 *   POST /security/sweeps                   devices:execute — create (previewDigest echo)
 *   GET  /security/sweeps                   devices:read
 *   GET  /security/sweeps/groups/:groupId   devices:read
 *   GET  /security/sweeps/:id               devices:read
 *   POST /security/sweeps/:id/cancel        devices:execute
 *   POST /security/sweeps/groups/:groupId/cancel  devices:execute
 *
 * Create and the cancels are self-managed-context routes
 * (middleware/selfManagedDbContextRoutes.ts): the service runs the per-user
 * limiter before any DB context, takes its own caller-scoped transaction, and
 * writes audits and enqueues the pump after the commit. Preview and the reads
 * run in the request's context. Every read is ceiling-filtered by the service.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { SECURITY_SWEEP_STATES, securitySweepCreateSchema, securitySweepRequestSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { hasSatisfiedMfa, isInteractiveUserSession, requirePermission, requireScope } from '../../middleware/auth';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import {
  cancelSweep,
  cancelSweepGroup,
  createSweep,
  getSweep,
  getSweepGroup,
  listSweeps,
  previewSweep,
} from '../../services/securityScanSweeps';

export const sweepsRoutes = new Hono();

const idParam = z.object({ id: z.string().uuid() });
const groupParam = z.object({ groupId: z.string().uuid() });
const listQuery = z.object({
  state: z.enum(SECURITY_SWEEP_STATES).optional(),
  orgId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const ERROR_MESSAGES: Record<string, string> = {
  ORG_OUT_OF_SCOPE: 'One or more organizations are outside your access',
  SITE_OUT_OF_SCOPE: 'One or more sites are outside your access',
  DEVICE_OUT_OF_SCOPE: 'One or more devices are outside your access',
  RULE_SET_NOT_FOUND: 'Rule set not found',
  RULE_SET_NOT_PUBLISHED: 'Rule set is disabled or not published',
  SWEEP_TOO_LARGE: 'Too many devices for one sweep',
  PARTNER_GROUP_TARGET_UNSUPPORTED: 'Partner-wide device groups can only be targeted by partner configuration policies',
  NO_ELIGIBLE_DEVICES: 'No eligible devices in scope',
  SWEEP_SCOPE_CHANGED: 'The devices or rule sets changed since the preview; review the new preview',
  SWEEP_ALREADY_RUNNING: 'The same sweep is already running on these devices',
  TOO_MANY_ACTIVE_SWEEPS: 'Too many active sweeps in this organization',
  MFA_REQUIRED: 'Multi-factor authentication is required for a sweep of this size',
  RATE_LIMITED: 'Too many sweeps started; try again later',
};

type Failure = { status: 400 | 403 | 404 | 409 | 429; code: string; detail?: Record<string, unknown> };
const failure = (c: Context, f: Failure) =>
  c.json({ error: ERROR_MESSAGES[f.code] ?? f.code, code: f.code, ...(f.detail ? { detail: f.detail } : {}) }, f.status);

const requestMeta = (c: Context) => ({
  ipAddress: getTrustedClientIpOrUndefined(c),
  userAgent: c.req.header('user-agent') ?? undefined,
});

sweepsRoutes.post(
  '/sweeps/preview',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('json', securitySweepRequestSchema),
  async (c) => {
    const result = await previewSweep(c.get('auth'), c.req.valid('json'));
    if (!result.ok) return failure(c, result);
    return c.json({ data: result.preview });
  },
);

sweepsRoutes.post(
  '/sweeps',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('json', securitySweepCreateSchema),
  async (c) => {
    const auth = c.get('auth');
    const result = await createSweep(auth, c.req.valid('json'), {
      origin: isInteractiveUserSession(auth) ? 'web' : 'api',
      mfaSatisfied: hasSatisfiedMfa(auth),
      requestMeta: requestMeta(c),
    });
    if (!result.ok) return failure(c, result);
    return c.json({ data: { groupId: result.groupId, sweeps: result.sweeps } }, 201);
  },
);

sweepsRoutes.get(
  '/sweeps',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('query', listQuery),
  async (c) => {
    const result = await listSweeps(c.get('auth'), c.req.valid('query'));
    return c.json({ data: result.data, pagination: { page: result.page, limit: result.limit, total: result.total } });
  },
);

// Before '/sweeps/:id' so "groups" is never read as a sweep id.
sweepsRoutes.get(
  '/sweeps/groups/:groupId',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('param', groupParam),
  async (c) => {
    const group = await getSweepGroup(c.get('auth'), c.req.valid('param').groupId);
    if (!group) return c.json({ error: 'Sweep not found' }, 404);
    return c.json({ data: group });
  },
);

sweepsRoutes.get(
  '/sweeps/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'read'),
  zValidator('param', idParam),
  async (c) => {
    const sweep = await getSweep(c.get('auth'), c.req.valid('param').id);
    if (!sweep) return c.json({ error: 'Sweep not found' }, 404);
    return c.json({ data: sweep });
  },
);

sweepsRoutes.post(
  '/sweeps/groups/:groupId/cancel',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', groupParam),
  async (c) => {
    const result = await cancelSweepGroup(c.get('auth'), c.req.valid('param').groupId, { requestMeta: requestMeta(c) });
    if (!result.ok) return c.json({ error: result.status === 404 ? 'Sweep not found' : 'Permission denied' }, result.status);
    const { sweeps, cancelledQueued, cancelledUndelivered, stillRunning } = result;
    return c.json({ data: { sweeps, cancelledQueued, cancelledUndelivered, stillRunning } });
  },
);

sweepsRoutes.post(
  '/sweeps/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'execute'),
  zValidator('param', idParam),
  async (c) => {
    const result = await cancelSweep(c.get('auth'), c.req.valid('param').id, { requestMeta: requestMeta(c) });
    if (!result.ok) return c.json({ error: result.status === 404 ? 'Sweep not found' : 'Permission denied' }, result.status);
    // stillRunning: delivered scans finish on the agent (no cancel wire).
    const { sweeps, cancelledQueued, cancelledUndelivered, stillRunning } = result;
    return c.json({ data: { sweeps, cancelledQueued, cancelledUndelivered, stillRunning } });
  },
);
