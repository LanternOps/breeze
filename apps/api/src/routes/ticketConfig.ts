import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, requireScope, requirePermission } from '../middleware/auth';
import type { AuthContext } from '../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../services/permissions';
import {
  createTicketStatusSchema, updateTicketStatusSchema, reorderTicketStatusesSchema,
  prioritySettingsSchema
} from '@breeze/shared';
import {
  getTicketConfig, createTicketStatus, updateTicketStatus, reorderTicketStatuses,
  upsertPrioritySettings, TicketConfigServiceError
} from '../services/ticketConfigService';

export const ticketConfigRoutes = new Hono();

// Hub auth (ticketCategories.ts pattern): requireScope/requirePermission below
// depend on c.get('auth') being populated.
ticketConfigRoutes.use('*', authMiddleware);

const idParam = z.object({ id: z.string().uuid() });

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TicketConfigServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

// Ticket configuration is partner-scoped: every status/priority row keys on
// partner_id. The caller must carry a partnerId (partner scope always does;
// system callers must too, since there's no global config). Mutating config is
// an admin action — v1 admin proxy (mirrors timeEntries' manageAll): platform
// admins or wildcard-permission roles only.
function requirePartnerId(c: { get: (k: 'auth') => unknown; json: (b: unknown, s: number) => Response }): string | Response {
  const auth = c.get('auth') as AuthContext;
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
  return auth.partnerId;
}

// Middleware version of the admin check — runs after writePerm (which populates
// c.get('permissions')) and gates mutating routes so a non-admin gets a clear
// admin-403 rather than a generic permission-denied message.
const adminMiddleware = async (c: Context, next: Next) => {
  const auth = c.get('auth') as AuthContext;
  const perms = c.get('permissions') as UserPermissions | undefined;
  const isAdmin = auth.user.isPlatformAdmin || (perms ? hasPermission(perms, '*', '*') : false);
  if (!isAdmin) return c.json({ error: 'Managing ticket configuration requires an admin role' }, 403);
  return next();
};

// GET / — full partner ticketing config (statuses + priority settings).
ticketConfigRoutes.get('/', scopes, readPerm, async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  const data = await getTicketConfig(partnerId);
  return c.json({ data });
});

// Literal paths BEFORE /:id (Hono matching is registration-ordered).

ticketConfigRoutes.post('/statuses/reorder', scopes, writePerm, adminMiddleware, zValidator('json', reorderTicketStatusesSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const { ids } = c.req.valid('json');
    const result = await reorderTicketStatuses(partnerId, ids);
    return c.json({ data: result });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketConfigRoutes.post('/statuses', scopes, writePerm, adminMiddleware, zValidator('json', createTicketStatusSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const row = await createTicketStatus(partnerId, c.req.valid('json'));
    return c.json({ data: row }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketConfigRoutes.patch('/statuses/:id', scopes, writePerm, adminMiddleware, zValidator('param', idParam), zValidator('json', updateTicketStatusSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const { id } = c.req.valid('param');
    const row = await updateTicketStatus(partnerId, id, c.req.valid('json'));
    return c.json({ data: row });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketConfigRoutes.put('/priorities', scopes, writePerm, adminMiddleware, zValidator('json', prioritySettingsSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const priorities = await upsertPrioritySettings(partnerId, c.req.valid('json'));
    return c.json({ data: { priorities } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});
