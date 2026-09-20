// apps/api/src/routes/billingProfiles.ts
/**
 * Rate cards: work types today, billing profiles in W02 (#4628).
 *
 * ONE route file for both, because they are ONE screen -- Settings → Billing →
 * Rates, whose rows are profiles and whose columns are work types (spec §6/§7).
 * W02 adds profile CRUD, PUT /:id/rows and POST /:id/clone HERE; do not create
 * a second file.
 *
 * Partner scope only. An org-scoped token gets 403, not an empty list: the
 * tenancy argument in spec §4.1 rests on org tokens having no read path to
 * rates at all.
 */
import { Hono, type Context } from 'hono';
import { authMiddleware, requireScope, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { createWorkTypeSchema, updateWorkTypeSchema } from '@breeze/shared';
import {
  listWorkTypes, createWorkType, updateWorkType, archiveWorkType, WorkTypeServiceError,
} from '../services/workTypeService';
import {
  canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE, PartnerWideWriteDeniedError,
} from '../services/partnerWideAccess';

const app = new Hono();

app.use('*', authMiddleware);
app.use('*', requireScope('partner'));

const readPerm = requirePermission(PERMISSIONS.BILLING_PROFILES_READ.resource, PERMISSIONS.BILLING_PROFILES_READ.action);
const writePerm = requirePermission(PERMISSIONS.BILLING_PROFILES_WRITE.resource, PERMISSIONS.BILLING_PROFILES_WRITE.action);

function fail(c: Context, err: unknown) {
  if (err instanceof WorkTypeServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400);
  }
  if (err instanceof PartnerWideWriteDeniedError) {
    return c.json({ error: err.message }, 403);
  }
  throw err;
}

// Work types are partner-wide config (epic #2135). Reads need only the
// permission; every write ALSO needs full partner org access -- a 'selected'
// partner user must not reshape every org's pickers. Same gate in the service.
const partnerWideWrite = async (c: Context, next: () => Promise<void>) => {
  if (!canManagePartnerWidePolicies(c.get('auth'))) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  await next();
};

app.get('/work-types', readPerm, async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
  const includeInactive = c.req.query('includeInactive') === 'true';
  const rows = await listWorkTypes(auth.partnerId, { includeInactive });
  return c.json({ workTypes: rows });
});

app.post('/work-types', writePerm, partnerWideWrite, async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
  const parsed = createWorkTypeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid work type', issues: parsed.error.issues }, 400);
  try {
    return c.json({ workType: await createWorkType(auth, auth.partnerId, parsed.data) }, 201);
  } catch (err) { return fail(c, err); }
});

app.patch('/work-types/:id', writePerm, partnerWideWrite, async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
  const parsed = updateWorkTypeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid work type', issues: parsed.error.issues }, 400);
  try {
    return c.json({ workType: await updateWorkType(auth, c.req.param('id')!, auth.partnerId, parsed.data) });
  } catch (err) { return fail(c, err); }
});

// ARCHIVES. A work type is stamped on historical time entries; removing one
// would raise 23503 against the NO ACTION FK, and a SET NULL "fix" would
// rewrite billing history. The response carries isActive:false so the UI can
// say "archived" rather than "deleted", and clearedCategoryCount so it can say
// how many ticket categories just lost it as their default (the service clears
// those in the same transaction — otherwise the server would keep stamping a
// work type the picker no longer offers).
app.delete('/work-types/:id', writePerm, partnerWideWrite, async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
  try {
    const { workType, clearedCategoryCount } = await archiveWorkType(auth, c.req.param('id')!, auth.partnerId);
    return c.json({ workType, clearedCategoryCount });
  } catch (err) { return fail(c, err); }
});

export const billingProfilesRoutes = app;
export default app;
