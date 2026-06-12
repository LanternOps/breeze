import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import {
  createTimeEntrySchema, updateTimeEntrySchema, startTimerSchema, stopTimerSchema,
  listTimeEntriesQuerySchema, bulkApproveSchema, timesheetQuerySchema
} from '@breeze/shared';

const idParam = z.object({ id: z.string().uuid() });
import {
  createTimeEntry, startTimer, stopTimer, updateTimeEntry, deleteTimeEntry,
  approveTimeEntries, listTimeEntries, getRunningTimer, getTimesheet,
  TimeEntryServiceError, type TimeEntryActor
} from '../../services/timeEntryService';

export const timeEntriesApiRoutes = new Hono();

// Internal-only surface (spec D4): partner/system scope only. time_entries has
// no org-axis RLS policy, so org-scope DB contexts could not read it anyway.
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TIME_ENTRIES_READ.resource, PERMISSIONS.TIME_ENTRIES_READ.action);
const writePerm = requirePermission(PERMISSIONS.TIME_ENTRIES_WRITE.resource, PERMISSIONS.TIME_ENTRIES_WRITE.action);

type Ctx = { get: (k: 'auth' | 'permissions') => unknown };

export function timeActorFrom(c: Ctx): TimeEntryActor {
  const auth = c.get('auth') as AuthContext;
  const perms = c.get('permissions') as UserPermissions | undefined;
  return {
    userId: auth.user.id,
    name: auth.user.name,
    email: auth.user.email,
    partnerId: auth.partnerId,
    // v1 admin proxy (plan decision): wildcard-permission roles approve + manage others
    manageAll: auth.user.isPlatformAdmin || (perms ? hasPermission(perms, '*', '*') : false)
  };
}

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TimeEntryServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

// Literal paths BEFORE /:id (Hono matching is registration-ordered).

timeEntriesApiRoutes.get('/running', scopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const entry = await getRunningTimer(auth.user.id);
  return c.json({ data: entry });
});

timeEntriesApiRoutes.post('/start', scopes, writePerm, zValidator('json', startTimerSchema), async (c) => {
  try {
    const entry = await startTimer(c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: entry }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.post('/stop', scopes, writePerm, zValidator('json', stopTimerSchema), async (c) => {
  try {
    const entry = await stopTimer(c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: entry });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.post('/bulk-approve', scopes, writePerm, zValidator('json', bulkApproveSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const result = await approveTimeEntries(body.ids, body.approve, timeActorFrom(c));
    return c.json({ data: { ...result, total: body.ids.length } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.get('/timesheet', scopes, readPerm, async (c) => {
  const actor = timeActorFrom(c);
  const rawQuery = c.req.query();

  // Auth check BEFORE schema validation: a non-admin requesting another user's
  // timesheet gets 403, not 400 (even if the userId isn't a valid UUID).
  const requestedUserId = rawQuery.userId;
  if (requestedUserId && requestedUserId !== actor.userId && !actor.manageAll) {
    return c.json({ error: 'Viewing other timesheets requires an admin role' }, 403);
  }

  const parsed = timesheetQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }
  const q = parsed.data;
  const targetUserId = q.userId ?? actor.userId;
  const timesheet = await getTimesheet(targetUserId, q.weekStart);
  return c.json({ data: timesheet });
});

timeEntriesApiRoutes.get('/', scopes, readPerm, async (c) => {
  const actor = timeActorFrom(c);
  const rawQuery = c.req.query();

  // D5: non-admins see only their own entries. Parse userId separately and
  // outside the schema (schema validates uuid format; admins may pass any string
  // as a forwarded id; non-admins always get self regardless of what they pass).
  const { userId: _rawUserId, ...restQuery } = rawQuery;
  const parsed = listTimeEntriesQuerySchema.omit({ userId: true }).safeParse(restQuery);
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }
  const q = parsed.data;
  const userId = actor.manageAll ? (_rawUserId || undefined) : actor.userId;
  const filters = { ...q, userId };
  const { entries, total } = await listTimeEntries(filters);
  return c.json({ data: entries, total, limit: q.limit, offset: q.offset });
});

timeEntriesApiRoutes.post('/', scopes, writePerm, zValidator('json', createTimeEntrySchema), async (c) => {
  try {
    const entry = await createTimeEntry(c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: entry }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateTimeEntrySchema), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const entry = await updateTimeEntry(id, c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: entry });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    await deleteTimeEntry(id, timeActorFrom(c));
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});
