import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { createTicketFormSchema, updateTicketFormSchema } from '@breeze/shared';
import { db } from '../../db';
import { organizations, ticketForms } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { PERMISSIONS } from '../../services/permissions';
import {
  getTicketFormOrgLinkMap,
  listTicketFormsForOrg,
  syncTicketFormOrgLinks,
  TicketFormError
} from '../../services/ticketFormService';
import { assertCategoryInPartner, TicketServiceError } from '../../services/ticketService';

const VISIBLE_ORG_IDS_SCOPE_ERROR = 'visibleOrgIds is only valid on partner-wide forms';

/**
 * The persisted allowlist state is exactly two values (spec ruling, Task 2/3
 * review): null/absent = visible to every org under the partner, or a
 * non-empty array = the allowlist. An empty array is meaningless — "no link
 * rows" already means visible-to-all — so routes normalize it to null before
 * ever reaching syncTicketFormOrgLinks.
 */
function normalizeVisibleOrgIds(v: string[] | null | undefined): string[] | null {
  return v && v.length > 0 ? v : null;
}

export const ticketFormRoutes = new Hono();

// Root-mounted router (absolute paths): authMiddleware must lead EACH route's
// middleware chain — a router-level .use('*') here would attach auth to every
// sibling api route, including public ones (the #1383 footgun documented in
// ticketResponseTemplates.ts / externalServices.ts / invoices/settings.ts).
const requireTicketRead = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const requireTicketWrite = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);
const scopes = requireScope('organization', 'partner', 'system');

const availableQuerySchema = z.object({ orgId: z.string().guid() });
const idParamSchema = z.object({ id: z.string().guid() });

// TicketServiceError carries its own HTTP status (assertCategoryInPartner throws
// 400/404/500 depending on the failure), so this must not hardcode a single
// status code. ticketsRoutes exports an identical helper, but importing it here
// would pull in the whole ticketsRoutes module for one tiny function — so we
// duplicate the mapping locally instead. (ticketPartsRoutes has its own copy too,
// mapping a different error type, TimeEntryServiceError.)
function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TicketServiceError || err instanceof TicketFormError) {
    return c.json({ error: err.message }, err.status);
  }
  throw err;
}

// Dual-axis app-layer read condition (mirrors softwarePolicyAccessCondition,
// #2126): org rows the caller can reach OR the caller's own partner's
// partner-wide rows. RLS is STRICTER — org tokens never see partner rows —
// so the partner branch is gated on partner scope to keep app and DB agreeing.
function ticketFormAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(ticketForms.orgId);
  if (!orgCond) return undefined; // system scope
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${ticketForms.orgId} IS NULL AND ${ticketForms.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

/**
 * Fetch a mutation target with the caller's access condition ANDed in —
 * app-layer defense-in-depth mirroring getPolicyWithAccess in
 * softwarePolicies.ts. RLS is the primary tenant boundary, but the app layer
 * must not rely on it alone: without this, a caller naming another tenant's
 * org-owned form by id would pass the partner-wide gate (orgId non-null) and
 * reach the mutation. A row outside the caller's tenancy 404s here instead.
 */
async function getFormWithAccess(formId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(ticketForms.id, formId)];
  const accessCondition = ticketFormAccessCondition(auth);
  if (accessCondition) conditions.push(accessCondition);
  const rows = await db
    .select()
    .from(ticketForms)
    .where(and(...conditions))
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve the partner a category must belong to, for either ownership axis. */
async function resolveEffectivePartnerId(owner: { orgId: string | null; partnerId: string | null }): Promise<string | null> {
  if (owner.orgId === null) return owner.partnerId;
  const orgRows = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, owner.orgId))
    .limit(1);
  return orgRows[0]?.partnerId ?? null;
}

ticketFormRoutes.get('/ticket-forms', authMiddleware, scopes, requireTicketRead, async (c) => {
  const auth = c.get('auth');
  const rows = await db
    .select()
    .from(ticketForms)
    .where(ticketFormAccessCondition(auth))
    .orderBy(asc(ticketForms.sortOrder), asc(ticketForms.name));
  // Management list only (NOT /available — pickers don't need the allowlist).
  const linkMap = await getTicketFormOrgLinkMap(rows.map((r) => r.id));
  const data = rows.map((r) => ({ ...r, visibleOrgIds: linkMap.get(r.id) ?? null }));
  return c.json({ data });
});

ticketFormRoutes.get(
  '/ticket-forms/available',
  authMiddleware,
  scopes,
  requireTicketRead,
  zValidator('query', availableQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.valid('query');
    // Access check BEFORE any fetch — this endpoint feeds the ticket-creation
    // picker and must not leak form existence for an org the caller can't see.
    if (!auth.canAccessOrg(orgId)) return c.json({ error: 'Access denied to this organization' }, 403);
    const orgRows = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const org = orgRows[0];
    if (!org) return c.json({ error: 'Organization not found' }, 404);
    const forms = await listTicketFormsForOrg({ id: org.id, partnerId: org.partnerId });
    return c.json({ data: forms });
  }
);

ticketFormRoutes.post(
  '/ticket-forms',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requireMfa(),
  zValidator('json', createTicketFormSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    // Fail fast, before any DB work: visibleOrgIds is only meaningful on a
    // partner-wide form (org-owned forms have no partner allowlist axis).
    if (payload.visibleOrgIds !== undefined && payload.ownerScope !== 'partner') {
      return c.json({ error: VISIBLE_ORG_IDS_SCOPE_ERROR }, 400);
    }

    // Ownership axis (Partner-Wide First, epic #2135, mirrors software
    // policies #2126). The partner is ALWAYS derived from the caller's own
    // token — a client-supplied partner id is NEVER trusted.
    let owner: { orgId: string | null; partnerId: string | null };
    if (payload.ownerScope === 'partner') {
      if (!auth.partnerId) return c.json({ error: 'Partner-wide forms require partner scope' }, 403);
      if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const requestedOrgId = payload.orgId ?? c.req.query('orgId') ?? undefined;
      if (auth.scope === 'organization') {
        if (!auth.orgId || (requestedOrgId && requestedOrgId !== auth.orgId)) {
          return c.json({ error: 'Organization context required' }, 403);
        }
        owner = { orgId: auth.orgId, partnerId: null };
      } else {
        if (!requestedOrgId || !auth.canAccessOrg(requestedOrgId)) {
          return c.json({ error: 'orgId is required and must be accessible' }, 400);
        }
        owner = { orgId: requestedOrgId, partnerId: null };
      }
    }

    if (payload.categoryId) {
      const effectivePartnerId = await resolveEffectivePartnerId(owner);
      try {
        await assertCategoryInPartner(payload.categoryId, effectivePartnerId);
      } catch (err) {
        return handleServiceError(c, err);
      }
    }

    const [row] = await db
      .insert(ticketForms)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: payload.name,
        description: payload.description ?? null,
        categoryId: payload.categoryId ?? null,
        fields: payload.fields,
        titleTemplate: payload.titleTemplate ?? null,
        descriptionIntro: payload.descriptionIntro ?? null,
        defaultPriority: payload.defaultPriority ?? null,
        defaultTags: payload.defaultTags,
        showInPortal: payload.showInPortal,
        isActive: payload.isActive,
        sortOrder: payload.sortOrder,
        createdBy: auth.user.id,
        version: 1
      })
      .returning();
    if (!row) return c.json({ error: 'Failed to create ticket form' }, 500);

    // Org-owned forms have no allowlist axis and were already rejected above
    // if visibleOrgIds was supplied; only partner-wide creates sync links.
    const normalizedVisibleOrgIds = normalizeVisibleOrgIds(payload.visibleOrgIds);
    if (payload.ownerScope === 'partner') {
      try {
        await syncTicketFormOrgLinks(row.id, normalizedVisibleOrgIds, auth.partnerId!);
      } catch (err) {
        // A failed sync (e.g. cross-partner org id) must not leave an
        // orphaned half-created form behind — delete it and surface the 400.
        await db.delete(ticketForms).where(eq(ticketForms.id, row.id));
        return handleServiceError(c, err);
      }
    }

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'ticket_form.create',
      resourceType: 'ticket_form',
      resourceId: row.id,
      resourceName: row.name,
      details: { formId: row.id, name: row.name, partnerWide: row.orgId === null }
    });

    return c.json({ data: { ...row, visibleOrgIds: normalizedVisibleOrgIds } }, 201);
  }
);

ticketFormRoutes.put(
  '/ticket-forms/:id',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', updateTicketFormSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const row = await getFormWithAccess(id, auth);
    if (!row) return c.json({ error: 'Ticket form not found' }, 404);

    if (row.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    // visibleOrgIds is only meaningful on a partner-wide row (org-owned forms
    // have no partner allowlist axis).
    if (payload.visibleOrgIds !== undefined && row.orgId !== null) {
      return c.json({ error: VISIBLE_ORG_IDS_SCOPE_ERROR }, 400);
    }

    if (payload.categoryId) {
      const effectivePartnerId = await resolveEffectivePartnerId({ orgId: row.orgId, partnerId: row.partnerId });
      try {
        await assertCategoryInPartner(payload.categoryId, effectivePartnerId);
      } catch (err) {
        return handleServiceError(c, err);
      }
    }

    // undefined = links untouched; null/[] = clear (normalized); non-empty
    // array = replace. Run BEFORE the column update so a rejected sync (e.g.
    // cross-partner org id) leaves the form row completely unmodified.
    if (payload.visibleOrgIds !== undefined) {
      const normalized = normalizeVisibleOrgIds(payload.visibleOrgIds);
      try {
        await syncTicketFormOrgLinks(id, normalized, row.partnerId!);
      } catch (err) {
        return handleServiceError(c, err);
      }
    }

    // visibleOrgIds is not a ticket_forms column — strip it explicitly rather
    // than relying on drizzle to drop unknown keys from the .set() spread.
    const { visibleOrgIds, ...columns } = payload;

    // version identifies which field schema stored responses were validated
    // against and which template composed the subject, so it only bumps when
    // fields/titleTemplate change; presentation-only fields (isActive/sortOrder/
    // visibleOrgIds) don't bump.
    const bumpVersion = payload.fields !== undefined || payload.titleTemplate !== undefined;
    const [updated] = await db
      .update(ticketForms)
      .set({
        ...columns,
        ...(bumpVersion ? { version: row.version + 1 } : {}),
        updatedAt: new Date()
      })
      .where(eq(ticketForms.id, id))
      .returning();
    if (!updated) return c.json({ error: 'Failed to update ticket form' }, 500);

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'ticket_form.update',
      resourceType: 'ticket_form',
      resourceId: updated.id,
      resourceName: updated.name,
      details: { formId: updated.id, name: updated.name, partnerWide: updated.orgId === null }
    });

    return c.json({ data: updated });
  }
);

ticketFormRoutes.delete(
  '/ticket-forms/:id',
  authMiddleware,
  scopes,
  requireTicketWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const row = await getFormWithAccess(id, auth);
    if (!row) return c.json({ error: 'Ticket form not found' }, 404);

    if (row.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    // Hard delete per spec — existing tickets keep the rendered description +
    // jsonb intake snapshot, so no ticket history is lost.
    await db.delete(ticketForms).where(eq(ticketForms.id, id));

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'ticket_form.delete',
      resourceType: 'ticket_form',
      resourceId: row.id,
      resourceName: row.name,
      details: { formId: row.id, name: row.name, partnerWide: row.orgId === null }
    });

    return c.json({ success: true });
  }
);
