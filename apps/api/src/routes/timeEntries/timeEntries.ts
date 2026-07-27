import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import {
  createTimeEntrySchema, updateTimeEntrySchema, startTimerSchema, stopTimerSchema,
  listTimeEntriesQuerySchema, bulkApproveSchema, timesheetQuerySchema
} from '@breeze/shared';

const idParam = z.object({ id: z.string().guid() });
import {
  createTimeEntry, startTimer, stopTimer, updateTimeEntry, deleteTimeEntry,
  approveTimeEntries, listTimeEntries, getRunningTimer, getTimesheet,
  TimeEntryServiceError, type TimeEntryActor, type TimeEntryAuditMutation
} from '../../services/timeEntryService';
import { writeRouteAudit } from '../../services/auditEvents';

export const timeEntriesApiRoutes = new Hono();

// Internal-only surface (spec D4): partner/system scope only. time_entries has
// no org-axis RLS policy, so org-scope DB contexts could not read it anyway.
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TIME_ENTRIES_READ.resource, PERMISSIONS.TIME_ENTRIES_READ.action);
const writePerm = requirePermission(PERMISSIONS.TIME_ENTRIES_WRITE.resource, PERMISSIONS.TIME_ENTRIES_WRITE.action);

type Ctx = { get: (k: 'auth' | 'permissions') => unknown };

export function timeActorFrom(
  c: Ctx,
  recordAuditMutation?: (mutation: TimeEntryAuditMutation) => void,
): TimeEntryActor {
  const auth = c.get('auth') as AuthContext;
  const perms = c.get('permissions') as UserPermissions | undefined;
  return {
    userId: auth.user.id,
    name: auth.user.name,
    email: auth.user.email,
    partnerId: auth.partnerId,
    // Org-axis allowlist (null = system scope). Threaded so the service's
    // system-context ticket read is re-gated against the caller's granted orgs —
    // closes a cross-org ticket write for orgAccess='selected' partner users.
    accessibleOrgIds: auth.accessibleOrgIds,
    // v1 admin proxy (plan decision): wildcard-permission roles approve + manage others
    manageAll: auth.user.isPlatformAdmin || (perms ? hasPermission(perms, '*', '*') : false),
    recordAuditMutation,
  };
}

function timeEntryAuditCollector(c: Ctx): {
  actor: TimeEntryActor;
  mutations: TimeEntryAuditMutation[];
} {
  const mutations: TimeEntryAuditMutation[] = [];
  return {
    actor: timeActorFrom(c, (mutation) => mutations.push(mutation)),
    mutations,
  };
}

function safelyWriteTimeEntryAudit(
  c: Parameters<typeof writeRouteAudit>[0],
  event: Parameters<typeof writeRouteAudit>[1],
): void {
  try {
    writeRouteAudit(c, event);
  } catch {
    console.error('[timeEntries] failed to enqueue audit');
  }
}

function writeSimpleTimeEntryAudits(
  c: Parameters<typeof writeRouteAudit>[0],
  mutations: readonly TimeEntryAuditMutation[],
): void {
  for (const mutation of mutations) {
    safelyWriteTimeEntryAudit(c, {
      orgId: mutation.orgId,
      action: mutation.action,
      resourceType: 'time_entry',
      resourceId: mutation.entryId,
      details: { entryIds: [mutation.entryId], count: 1 },
    });
  }
}

function writeBulkTimeEntryAudits(
  c: Parameters<typeof writeRouteAudit>[0],
  mutations: readonly TimeEntryAuditMutation[],
): void {
  const groups: Array<{
    action: TimeEntryAuditMutation['action'];
    orgId: string | null;
    entryIds: string[];
  }> = [];

  for (const mutation of mutations) {
    let group = groups.find(
      (candidate) =>
        candidate.action === mutation.action
        && candidate.orgId === mutation.orgId,
    );
    if (!group) {
      group = {
        action: mutation.action,
        orgId: mutation.orgId,
        entryIds: [],
      };
      groups.push(group);
    }
    group.entryIds.push(mutation.entryId);
  }

  for (const group of groups) {
    safelyWriteTimeEntryAudit(c, {
      orgId: group.orgId,
      action: group.action,
      resourceType: 'time_entry',
      details: { entryIds: group.entryIds, count: group.entryIds.length },
    });
  }
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
    const audit = timeEntryAuditCollector(c);
    const entry = await startTimer(c.req.valid('json'), audit.actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    return c.json({ data: entry }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.post('/stop', scopes, writePerm, zValidator('json', stopTimerSchema), async (c) => {
  try {
    const audit = timeEntryAuditCollector(c);
    const entry = await stopTimer(c.req.valid('json'), audit.actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    return c.json({ data: entry });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.post('/bulk-approve', scopes, writePerm, zValidator('json', bulkApproveSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const audit = timeEntryAuditCollector(c);
    const result = await approveTimeEntries(body.ids, body.approve, audit.actor);
    writeBulkTimeEntryAudits(c, audit.mutations);
    return c.json({ data: { ...result, total: body.ids.length } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.get('/timesheet', scopes, readPerm, zValidator('query', timesheetQuerySchema), async (c) => {
  const q = c.req.valid('query');
  const actor = timeActorFrom(c);
  const targetUserId = q.userId ?? actor.userId;
  if (targetUserId !== actor.userId && !actor.manageAll) {
    return c.json({ error: 'Viewing other timesheets requires an admin role' }, 403);
  }
  const timesheet = await getTimesheet(targetUserId, q.weekStart, actor.accessibleOrgIds);
  return c.json({ data: timesheet });
});

timeEntriesApiRoutes.get('/', scopes, readPerm, zValidator('query', listTimeEntriesQuerySchema), async (c) => {
  const q = c.req.valid('query');
  const actor = timeActorFrom(c);
  // Guard: if the caller supplies an explicit orgId it must be in their
  // accessible set; otherwise they could bypass the accessibleOrgIds narrowing
  // in listConditions (supplying orgId skips the org-axis filter there).
  // Mirrors the pattern from tickets/export.ts:~25. (#sec-review-1)
  if (q.orgId && !c.get('auth').canAccessOrg(q.orgId)) {
    return c.json({ error: 'Access to this organization denied' }, 403);
  }
  // D5: non-admins see only their own entries through the standalone list.
  // Org-axis allowlist confines partner-scope admins to granted orgs (the
  // partner-axis time_entries RLS does not). (#sec-review-1)
  const filters = {
    ...q,
    userId: actor.manageAll ? q.userId : actor.userId,
    accessibleOrgIds: actor.accessibleOrgIds,
  };
  const { entries, total } = await listTimeEntries(filters);
  return c.json({ data: entries, total, limit: q.limit, offset: q.offset });
});

timeEntriesApiRoutes.post('/', scopes, writePerm, zValidator('json', createTimeEntrySchema), async (c) => {
  try {
    const audit = timeEntryAuditCollector(c);
    const entry = await createTimeEntry(c.req.valid('json'), audit.actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    return c.json({ data: entry }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateTimeEntrySchema), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const audit = timeEntryAuditCollector(c);
    const entry = await updateTimeEntry(id, c.req.valid('json'), audit.actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    return c.json({ data: entry });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const audit = timeEntryAuditCollector(c);
    await deleteTimeEntry(id, audit.actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});
