import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { alertTemplates } from '../../db/schema';
import { eq, and, or, ilike, desc, inArray, isNull } from 'drizzle-orm';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { listTemplatesSchema, createTemplateSchema, updateTemplateSchema } from './schemas';
import { parseBoolean } from './helpers';
import { getPagination } from '../../utils/pagination';
import { PERMISSIONS } from '../../services/permissions';
import { retiredConditionTypeError } from '../../services/alertConditions';

export const templateRoutes = new Hono();

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

// Whether this caller may edit/delete an existing template row. Partner-wide
// rows belong to the MSP and are read-only for org scope; built-in rows are
// read-only for everyone (only seeding creates them). Caller is the AuthContext.
export function canWriteTemplate(
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'canAccessOrg'>,
  row: { orgId: string | null; partnerId: string | null; isBuiltIn: boolean },
): { ok: true } | { ok: false; status: 403 | 404; error: string } {
  if (row.isBuiltIn) return { ok: false, status: 403, error: 'Built-in templates cannot be modified' };
  if (auth.scope === 'system') return { ok: true };
  // Partner-wide record (org_id NULL, partner_id set).
  if (row.orgId === null && row.partnerId !== null) {
    if (auth.scope === 'organization') {
      return { ok: false, status: 403, error: 'This template is shared across your organization and is read-only here' };
    }
    if (row.partnerId === auth.partnerId) return { ok: true };
    return { ok: false, status: 404, error: 'Template not found' };
  }
  // Org-specific record: caller must be able to access that org.
  if (row.orgId !== null && auth.canAccessOrg(row.orgId)) return { ok: true };
  return { ok: false, status: 404, error: 'Template not found' };
}

templateRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
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
  zValidator('json', createTemplateSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const data = c.req.valid('json');

      // #2948 — template conditions are the evaluator's fallback when a rule
      // carries no override, so a retired type is just as dead here. The
      // editor nests its triggers under `conditions.triggers`, which the walk
      // in retiredConditionTypeError descends into.
      const createConditionTypeError = retiredConditionTypeError(data.conditions);
      if (createConditionTypeError) {
        return c.json({ error: createConditionTypeError }, 400);
      }

      // Resolve org/partner axes from scope + the requested availability,
      // mirroring Scripts (#1357). EXACTLY ONE axis is set: an org-owned
      // template is (org_id set, partner_id NULL), a partner-wide template is
      // (org_id NULL, partner_id set). The old code denormalized partner_id
      // onto org rows "for RLS consistency"; that shape is what made the
      // partner-wide read predicate leak across orgs (security review
      // 2026-08-16 §1.5) and is now rejected by
      // alert_templates_one_owner_chk.
      let orgId: string | null = data.orgId ?? null;
      let partnerId: string | null = null;

      if (auth.scope === 'organization') {
        if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
        orgId = auth.orgId;
        partnerId = null;
      } else if (auth.scope === 'partner') {
        if (data.availability === 'partner') {
          orgId = null;
          partnerId = auth.partnerId ?? null;
          if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
        } else {
          if (!orgId) {
            const single = auth.accessibleOrgIds?.[0];
            if (auth.accessibleOrgIds?.length === 1 && single) {
              orgId = single;
            } else {
              return c.json({ error: 'orgId is required when the partner has multiple organizations' }, 400);
            }
          }
          if (!auth.canAccessOrg(orgId)) {
            return c.json({ error: 'Access to this organization denied' }, 403);
          }
          // Org-owned row: the partner axis stays NULL (see the XOR note above).
          partnerId = null;
        }
      }
      // System scope: orgId from the request body (may be null), no partner axis.

      const targets = data.targets && Object.keys(data.targets).length > 0
        ? data.targets
        : { scope: 'organization' };

      const [template] = await db
        .insert(alertTemplates)
        .values({
          orgId,
          partnerId,
          name: data.name.trim(),
          description: data.description,
          category: data.category ?? 'Custom',
          conditions: data.conditions ?? {},
          severity: data.severity,
          titleTemplate: `{{deviceName}}: ${data.name.trim()}`,
          messageTemplate: `Alert triggered: ${data.name.trim()} on {{deviceName}} ({{hostname}}).`,
          targets,
          cooldownMinutes: data.defaultCooldownMinutes ?? 15,
          isBuiltIn: false,
        })
        .returning();

      if (!template) {
        return c.json({ error: 'Failed to create template' }, 500);
      }

      writeRouteAudit(c, {
        orgId: template.orgId ?? auth.orgId ?? null,
        action: 'alert_template.create',
        resourceType: 'alert_template',
        resourceId: template.id,
        resourceName: template.name,
        details: {
          category: template.category,
          severity: template.severity,
          availability: template.orgId === null && template.partnerId !== null ? 'partner' : 'org',
        },
      });
      return c.json({ data: template }, 201);
    } catch {
      return c.json({ error: 'Failed to create template' }, 500);
    }
  }
);

templateRoutes.get(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
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
  zValidator('json', updateTemplateSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const templateId = c.req.param('id')!;
      const updates = c.req.valid('json');

      const [existing] = await db
        .select()
        .from(alertTemplates)
        .where(eq(alertTemplates.id, templateId))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Template not found' }, 404);
      }

      const writable = canWriteTemplate(auth, existing);
      if (!writable.ok) {
        return c.json({ error: writable.error }, writable.status);
      }

      const updateConditionTypeError = retiredConditionTypeError(updates.conditions);
      if (updateConditionTypeError) {
        return c.json({ error: updateConditionTypeError }, 400);
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }

      const setValues: Record<string, unknown> = { updatedAt: new Date() };
      if (updates.name !== undefined) setValues.name = updates.name.trim();
      if (updates.description !== undefined) setValues.description = updates.description;
      if (updates.category !== undefined) setValues.category = updates.category;
      if (updates.severity !== undefined) setValues.severity = updates.severity;
      if (updates.conditions !== undefined) setValues.conditions = updates.conditions;
      if (updates.targets !== undefined) setValues.targets = updates.targets;
      if (updates.defaultCooldownMinutes !== undefined) setValues.cooldownMinutes = updates.defaultCooldownMinutes;

      const [updated] = await db
        .update(alertTemplates)
        .set(setValues)
        .where(eq(alertTemplates.id, templateId))
        .returning();

      writeRouteAudit(c, {
        orgId: existing.orgId ?? auth.orgId ?? null,
        action: 'alert_template.update',
        resourceType: 'alert_template',
        resourceId: templateId,
        resourceName: updated?.name ?? existing.name,
        details: { updatedFields: Object.keys(updates) },
      });
      return c.json({ data: updated });
    } catch {
      return c.json({ error: 'Failed to update template' }, 500);
    }
  }
);

templateRoutes.delete(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    try {
      const auth = c.get('auth');
      const templateId = c.req.param('id')!;

      const [existing] = await db
        .select()
        .from(alertTemplates)
        .where(eq(alertTemplates.id, templateId))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Template not found' }, 404);
      }

      const writable = canWriteTemplate(auth, existing);
      if (!writable.ok) {
        return c.json({ error: writable.error }, writable.status);
      }

      await db
        .delete(alertTemplates)
        .where(eq(alertTemplates.id, templateId));

      writeRouteAudit(c, {
        orgId: existing.orgId ?? auth.orgId ?? null,
        action: 'alert_template.delete',
        resourceType: 'alert_template',
        resourceId: existing.id,
        resourceName: existing.name,
      });
      return c.json({ data: { id: templateId, deleted: true } });
    } catch {
      return c.json({ error: 'Failed to delete template' }, 500);
    }
  }
);
