/**
 * Business-hours calendars (#8973 W4, spec §4.1, §4.2, §4.5, D12).
 * Mounted at /api/v1/business-calendars.
 *
 * Partner/system scope only (the ticket-config precedent): an org-scope token
 * reads calendars through the list_business_calendars AI tool, never edits
 * them. Every PARTNER-WIDE write is additionally gated in the service on
 * canManagePartnerWidePolicies (PartnerWideWriteDeniedError → 403); an
 * org-owned calendar needs canAccessOrg on its org. The org override is an
 * org setting (organizations:write), like PATCH /organizations/:id/ticket-settings.
 *
 * POST /:id/apply-revision is a self-managed DB-context route
 * (middleware/selfManagedDbContextRoutes.ts): it walks tickets in chunks, each
 * in its own short caller-scoped transaction, so no request transaction holds
 * thousands of ticket row locks.
 *
 * Writes stay human-only in v1 (spec §5.7): the only AI tool is the read-only
 * list_business_calendars.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import {
  ERROR_CODES,
  applyBusinessCalendarRevisionSchema,
  businessCalendarHolidaySchema,
  createBusinessCalendarSchema,
  listBusinessCalendarsQuerySchema,
  orgBusinessCalendarOverrideSchema,
  updateBusinessCalendarSchema,
} from '@breeze/shared';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { PartnerWideWriteDeniedError } from '../services/partnerWideAccess';
import {
  BusinessCalendarError,
  addHoliday,
  archiveCalendar,
  clearPartnerDefault,
  createCalendar,
  deleteCalendar,
  getCalendar,
  getResolvedCalendarForOrg,
  listCalendars,
  removeHoliday,
  setOrgCalendarOverride,
  setPartnerDefault,
  updateCalendar,
} from '../services/businessCalendars/service';
import { applyRevision, previewApplyRevision } from '../services/businessCalendars/applyRevision';

export const businessCalendarRoutes = new Hono();

businessCalendarRoutes.use('*', authMiddleware);

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);
const orgWritePerm = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

const idParam = z.object({ id: z.string().guid() });
const holidayParam = z.object({ id: z.string().guid(), holidayId: z.string().guid() });
const orgParam = z.object({ orgId: z.string().guid() });
const resolvedQuery = z.object({ orgId: z.string().guid() });
const archiveBody = z.object({ archived: z.boolean() });

function handleError(c: Context, err: unknown): Response {
  if (err instanceof BusinessCalendarError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof PartnerWideWriteDeniedError) {
    return c.json({ error: err.message, code: ERROR_CODES.ACCESS_DENIED }, 403);
  }
  throw err;
}

const authOf = (c: Context) => c.get('auth') as AuthContext;

function audit(c: Context, action: string, calendar: { id: string; orgId?: string | null; partnerId?: string | null; name?: string }, details: Record<string, unknown> = {}) {
  writeRouteAudit(c as never, {
    orgId: calendar.orgId ?? null,
    ...(calendar.orgId ? {} : { partnerId: calendar.partnerId ?? authOf(c).partnerId }),
    action,
    resourceType: 'business_calendar',
    resourceId: calendar.id,
    resourceName: calendar.name,
    details,
  });
}

// ---- reads (literal paths before /:id) --------------------------------------

businessCalendarRoutes.get('/', scopes, readPerm, zValidator('query', listBusinessCalendarsQuerySchema), async (c) => {
  try {
    const q = c.req.valid('query');
    const data = await listCalendars(authOf(c), { orgId: q.orgId, includeArchived: q.includeArchived === 'true' });
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

businessCalendarRoutes.get('/resolved', scopes, readPerm, zValidator('query', resolvedQuery), async (c) => {
  try {
    return c.json({ data: await getResolvedCalendarForOrg(authOf(c), c.req.valid('query').orgId) });
  } catch (err) {
    return handleError(c, err);
  }
});

// ---- partner default (literal) ------------------------------------------------

businessCalendarRoutes.delete('/default', scopes, writePerm, async (c) => {
  try {
    await clearPartnerDefault(authOf(c));
    writeRouteAudit(c as never, {
      orgId: null, partnerId: authOf(c).partnerId, action: 'business_calendar.clear_default', resourceType: 'business_calendar',
    });
    return c.json({ data: { cleared: true } });
  } catch (err) {
    return handleError(c, err);
  }
});

// ---- org override (literal) ---------------------------------------------------

businessCalendarRoutes.put('/orgs/:orgId/override', scopes, orgWritePerm, zValidator('param', orgParam), zValidator('json', orgBusinessCalendarOverrideSchema), async (c) => {
  try {
    const { orgId } = c.req.valid('param');
    const { calendarId } = c.req.valid('json');
    await setOrgCalendarOverride(authOf(c), orgId, calendarId);
    writeRouteAudit(c as never, {
      orgId, action: 'organization.business_calendar.update', resourceType: 'organization', resourceId: orgId,
      details: { businessCalendarId: calendarId },
    });
    return c.json({ data: await getResolvedCalendarForOrg(authOf(c), orgId) });
  } catch (err) {
    return handleError(c, err);
  }
});

// ---- calendars ----------------------------------------------------------------

businessCalendarRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try {
    return c.json({ data: await getCalendar(authOf(c), c.req.valid('param').id) });
  } catch (err) {
    return handleError(c, err);
  }
});

businessCalendarRoutes.post('/', scopes, writePerm, zValidator('json', createBusinessCalendarSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const data = await createCalendar(authOf(c), body);
    audit(c, 'business_calendar.create', data, { ownerScope: body.ownerScope, timezone: body.timezone, intervals: body.intervals.length });
    return c.json({ data }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

businessCalendarRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateBusinessCalendarSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const data = await updateCalendar(authOf(c), c.req.valid('param').id, body);
    audit(c, 'business_calendar.update', data, { changedFields: Object.keys(body), revisionCreated: data.revisionCreated });
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

businessCalendarRoutes.post('/:id/default', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try {
    const data = await setPartnerDefault(authOf(c), c.req.valid('param').id);
    audit(c, 'business_calendar.set_default', data);
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

businessCalendarRoutes.post('/:id/archive', scopes, writePerm, zValidator('param', idParam), zValidator('json', archiveBody), async (c) => {
  try {
    const { archived } = c.req.valid('json');
    const data = await archiveCalendar(authOf(c), c.req.valid('param').id, archived);
    audit(c, archived ? 'business_calendar.archive' : 'business_calendar.unarchive', data);
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

businessCalendarRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const owner = await deleteCalendar(authOf(c), id);
    audit(c, 'business_calendar.delete', owner);
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return handleError(c, err);
  }
});

businessCalendarRoutes.post('/:id/holidays', scopes, writePerm, zValidator('param', idParam), zValidator('json', businessCalendarHolidaySchema), async (c) => {
  try {
    const { id } = c.req.valid('param');
    const { calendar, ...data } = await addHoliday(authOf(c), id, c.req.valid('json'));
    audit(c, 'business_calendar.holiday.add', calendar, { date: data.holiday.date, recomputeQueued: data.recomputeQueued });
    return c.json({ data }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

businessCalendarRoutes.delete('/:id/holidays/:holidayId', scopes, writePerm, zValidator('param', holidayParam), async (c) => {
  try {
    const { id, holidayId } = c.req.valid('param');
    const { calendar, ...data } = await removeHoliday(authOf(c), id, holidayId);
    audit(c, 'business_calendar.holiday.remove', calendar, { holidayId, recomputeQueued: data.recomputeQueued });
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

// ---- D12 apply-revision -----------------------------------------------------

businessCalendarRoutes.get('/:id/apply-revision/preview', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try {
    return c.json({ data: await previewApplyRevision(authOf(c), c.req.valid('param').id) });
  } catch (err) {
    return handleError(c, err);
  }
});

// Self-managed (no ambient request transaction); the service audits the result.
businessCalendarRoutes.post('/:id/apply-revision', scopes, writePerm, zValidator('param', idParam), zValidator('json', applyBusinessCalendarRevisionSchema), async (c) => {
  try {
    const data = await applyRevision(authOf(c), c.req.valid('param').id, c.req.valid('json'));
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});
