import { legacyAlertingGone } from '../legacyAlertingGone';
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { alertTemplates } from '../../db/schema';
import { eq, and, or, ilike, desc, inArray, isNull } from 'drizzle-orm';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { listTemplatesSchema } from './schemas';
import { parseBoolean } from './helpers';
import { getPagination } from '../../utils/pagination';
import { PERMISSIONS } from '../../services/permissions';

export const templateRoutes = new Hono();

const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

// Partner-wide means `partner_id = X AND org_id IS NULL` — NEVER a bare
// `partner_id = X`. Security review 2026-08-16 §1.5 (CRITICAL): org-owned rows
// used to be written with BOTH axes populated (the create path denormalized
// partner_id onto org rows), so `eq(partnerId, auth.partnerId)` sitting next to
// `inArray(orgId, accessibleOrgIds)` in an OR selected EVERY template under the
// partner and voided the org restriction beside it. For a partner-scope caller
// with orgAccess 'selected'/'none' that was a real cross-org read: partner-axis
// RLS is flat, so the database did not catch it. The `org_id IS NULL` conjunct
// below is the fix; `alert_templates_one_owner_chk` (migration
// 2026-08-25-alert-templates-one-owner) stops the both-axes shape recurring.
const partnerWideCondition = (partnerId: string) =>
  and(eq(alertTemplates.partnerId, partnerId), isNull(alertTemplates.orgId)) as ReturnType<typeof eq>;

// Same class of bug on the OTHER global disjunct, found reviewing the §1.5 fix:
// `is_built_in = true` is not by itself a global marker. policyAlertBridge
// (`ensureTemplate`) auto-creates an ORG-OWNED row with isBuiltIn true, so a
// bare `is_built_in` disjunct hands every org's policy-compliance template to
// every other caller. A genuinely global built-in has no owner; org-owned
// built-ins remain visible to their own org through the org disjunct.
export const globalBuiltInCondition = () =>
  and(eq(alertTemplates.isBuiltIn, true), isNull(alertTemplates.orgId)) as ReturnType<typeof eq>;

// Visibility predicate mirroring the Scripts dual-axis union (#1357/#1425): a
// caller sees built-in templates (global) ∪ their org's custom templates ∪
// partner-wide templates owned by their partner. Partner scope spans every org
// it can access; system scope sees everything (returns undefined → no filter).
// RLS on alert_templates is the real boundary; this just shapes which of the
// visible rows to return. Returns a 403 sentinel string when org scope lacks an
// org context.
//
// The org-scope partner-wide branch is deliberate and NOT the generic
// "partner-wide reads must be gated on scope === 'partner'" case: alert_templates
// is one of four catalog tables whose RLS carries an explicit
// `(org_id IS NULL AND partner_id = breeze_current_partner_id())` SELECT branch
// (2026-06-13-catalog-partner-read-branch), and org-scope sessions are given
// currentPartnerId precisely so they can read their MSP's shared templates
// read-only (bearerTokenAuth.ts, MCP-OAUTH-06). App layer and RLS agree here.
export function templateScopeCondition(auth: AuthContext): ReturnType<typeof or> | 'no-org-context' | undefined {
  if (auth.scope === 'system') return undefined;
  if (auth.scope === 'organization') {
    if (!auth.orgId) return 'no-org-context';
    const ors: ReturnType<typeof eq>[] = [
      globalBuiltInCondition(),
      eq(alertTemplates.orgId, auth.orgId),
    ];
    if (auth.partnerId) ors.push(partnerWideCondition(auth.partnerId));
    return or(...ors);
  }
  // partner scope
  const orgIds = auth.accessibleOrgIds ?? [];
  const ors: ReturnType<typeof eq>[] = [globalBuiltInCondition()];
  if (orgIds.length > 0) ors.push(inArray(alertTemplates.orgId, orgIds) as ReturnType<typeof eq>);
  if (auth.partnerId) ors.push(partnerWideCondition(auth.partnerId));
  return or(...ors);
}

templateRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('query', listTemplatesSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const query = c.req.valid('query');

      const scopeCondition = templateScopeCondition(auth);
      if (scopeCondition === 'no-org-context') {
        return c.json({ error: 'Organization context required' }, 403);
      }

      const conditions: ReturnType<typeof eq>[] = [];

      const builtInFlag = parseBoolean(query.builtIn);
      if (builtInFlag !== undefined) {
        conditions.push(eq(alertTemplates.isBuiltIn, builtInFlag));
      }

      if (query.severity) {
        conditions.push(eq(alertTemplates.severity, query.severity));
      }

      if (query.search) {
        const search = `%${query.search}%`;
        conditions.push(
          or(
            ilike(alertTemplates.name, search),
            ilike(alertTemplates.description, search)
          )!
        );
      }

      const allConditions = scopeCondition
        ? [scopeCondition as ReturnType<typeof eq>, ...conditions]
        : conditions;

      const rows = await db
        .select()
        .from(alertTemplates)
        .where(allConditions.length > 0 ? and(...allConditions) : undefined)
        .orderBy(desc(alertTemplates.isBuiltIn), alertTemplates.name);

      const { page, limit, offset } = getPagination(query);
      return c.json({
        data: rows.slice(offset, offset + limit),
        page,
        limit,
        total: rows.length
      });
    } catch {
      return c.json({ error: 'Failed to list templates' }, 500);
    }
  }
);

templateRoutes.get(
  '/templates/built-in',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('query', listTemplatesSchema),
  async (c) => {
    try {
      const query = c.req.valid('query');
      // Only genuinely global built-ins — an org-owned is_built_in row
      // (policyAlertBridge) must not surface on this unscoped endpoint.
      const conditions: ReturnType<typeof eq>[] = [
        globalBuiltInCondition()
      ];

      if (query.severity) {
        conditions.push(eq(alertTemplates.severity, query.severity));
      }

      if (query.search) {
        const search = `%${query.search}%`;
        conditions.push(
          or(
            ilike(alertTemplates.name, search),
            ilike(alertTemplates.description, search)
          )!
        );
      }

      const rows = await db
        .select()
        .from(alertTemplates)
        .where(and(...conditions))
        .orderBy(alertTemplates.name);

      const { page, limit, offset } = getPagination(query);
      return c.json({
        data: rows.slice(offset, offset + limit),
        page,
        limit,
        total: rows.length
      });
    } catch {
      return c.json({ error: 'Failed to list built-in templates' }, 500);
    }
  }
);

templateRoutes.post(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  legacyAlertingGone
);

templateRoutes.get(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  async (c) => {
    try {
      const auth = c.get('auth');
      const scopeCondition = templateScopeCondition(auth);
      if (scopeCondition === 'no-org-context') {
        return c.json({ error: 'Organization context required' }, 403);
      }

      const templateId = c.req.param('id')!;
      const idCondition = eq(alertTemplates.id, templateId);
      const [template] = await db
        .select()
        .from(alertTemplates)
        .where(scopeCondition ? and(idCondition, scopeCondition as ReturnType<typeof eq>) : idCondition)
        .limit(1);

      if (!template) {
        return c.json({ error: 'Template not found' }, 404);
      }

      return c.json({ data: template });
    } catch {
      return c.json({ error: 'Failed to fetch template' }, 500);
    }
  }
);

templateRoutes.patch(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  legacyAlertingGone
);

templateRoutes.delete(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  legacyAlertingGone
);
