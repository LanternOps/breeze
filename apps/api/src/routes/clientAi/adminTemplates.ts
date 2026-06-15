import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { clientAiPromptTemplates } from '../../db/schema/clientAi';
import { organizations } from '../../db/schema/orgs';
import { requirePermission } from '../../middleware/auth';
import { normalizeTemplateHosts } from '../../services/clientAiHosts';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from '../c2c/helpers';
import { templateBodySchema, templateUpdateSchema, templateListQuerySchema } from './schemas';

/**
 * AI for Office — prompt-template manager (spec §9.5, §10).
 *
 * client_ai_prompt_templates is dual-axis: org rows (org_id set, partner_id
 * NULL) and partner-wide rows (org_id NULL, partner_id set). Partner-wide
 * writes REQUIRE a partner/system caller carrying partnerId; org-scope
 * callers get a clean 403 partner_scope_required instead of bubbling the RLS
 * 42501 — the exact custom_field_definitions failure mode (2026-06-11-i).
 * The end-to-end breeze_app proof for the partner-axis write path lives in
 * __tests__/integration/client-ai-template-routes.integration.test.ts (Task 7).
 *
 * Scope is immutable after create (templateUpdateSchema has no orgId) — move
 * a template by delete + recreate. Keeps the dual-axis invariants trivial.
 */

export const clientAiAdminTemplateRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);
const requireOrgsWrite = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action
);

type TemplateAuth = {
  scope: 'system' | 'partner' | 'organization';
  partnerId: string | null;
  user?: { id: string };
};

const templateSelection = {
  id: clientAiPromptTemplates.id,
  orgId: clientAiPromptTemplates.orgId,
  partnerId: clientAiPromptTemplates.partnerId,
  orgName: organizations.name,
  name: clientAiPromptTemplates.name,
  description: clientAiPromptTemplates.description,
  promptBody: clientAiPromptTemplates.promptBody,
  category: clientAiPromptTemplates.category,
  hosts: clientAiPromptTemplates.hosts,
  createdAt: clientAiPromptTemplates.createdAt,
  updatedAt: clientAiPromptTemplates.updatedAt,
};

// ── GET /templates ────────────────────────────────────────────────────────────
clientAiAdminTemplateRoutes.get(
  '/templates',
  requireOrgsRead,
  zValidator('query', templateListQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const q = c.req.valid('query');

    if (q.orgId && !resolveScopedOrgId(auth, q.orgId)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    // RLS bounds visibility (own partner rows + accessible-org rows); the
    // optional filters narrow within that.
    let rows = await db
      .select(templateSelection)
      .from(clientAiPromptTemplates)
      .leftJoin(organizations, eq(clientAiPromptTemplates.orgId, organizations.id))
      .orderBy(asc(clientAiPromptTemplates.name));

    if (q.orgId) rows = rows.filter((r) => r.orgId === q.orgId);
    if (q.scope === 'partner') rows = rows.filter((r) => r.orgId === null);
    if (q.scope === 'org') rows = rows.filter((r) => r.orgId !== null);

    return c.json({ data: rows });
  }
);

// ── POST /templates ───────────────────────────────────────────────────────────
clientAiAdminTemplateRoutes.post(
  '/templates',
  requireOrgsWrite,
  zValidator('json', templateBodySchema),
  async (c) => {
    const auth = c.get('auth') as TemplateAuth & Parameters<typeof resolveScopedOrgId>[0];
    const body = c.req.valid('json');
    const targetOrgId = body.orgId ?? null;

    let values: typeof clientAiPromptTemplates.$inferInsert;
    if (targetOrgId) {
      const orgId = resolveScopedOrgId(auth, targetOrgId);
      if (!orgId) return c.json({ error: 'Organization not found' }, 404);
      values = {
        orgId,
        partnerId: null,
        name: body.name,
        description: body.description ?? null,
        promptBody: body.promptBody,
        category: body.category ?? null,
        hosts: normalizeTemplateHosts(body.hosts),
        createdBy: auth.user?.id ?? null,
      };
    } else {
      // Partner-wide row: org_id NULL + partner_id set. Gate BEFORE the
      // insert so org-scope callers see 403, not an RLS 42501 surprise.
      if (auth.scope === 'organization' || !auth.partnerId) {
        return c.json({ error: 'partner_scope_required' }, 403);
      }
      values = {
        orgId: null,
        partnerId: auth.partnerId,
        name: body.name,
        description: body.description ?? null,
        promptBody: body.promptBody,
        category: body.category ?? null,
        hosts: normalizeTemplateHosts(body.hosts),
        createdBy: auth.user?.id ?? null,
      };
    }

    const [row] = await db.insert(clientAiPromptTemplates).values(values).returning();
    if (!row) return c.json({ error: 'Failed to create template' }, 500);

    writeRouteAudit(c, {
      orgId: row.orgId ?? null,
      action: 'client_ai.template.create',
      resourceType: 'client_ai_prompt_template',
      resourceId: row.id,
      resourceName: row.name,
      details: { scope: row.orgId ? 'org' : 'partner' },
    });

    return c.json({ template: row }, 201);
  }
);

// ── PUT /templates/:id ────────────────────────────────────────────────────────
clientAiAdminTemplateRoutes.put(
  '/templates/:id',
  requireOrgsWrite,
  zValidator('json', templateUpdateSchema),
  async (c) => {
    const id = c.req.param('id')!;
    const body = c.req.valid('json');

    // RLS scopes the read: a row outside the caller's tenancy is a plain 404.
    const [existing] = await db
      .select(templateSelection)
      .from(clientAiPromptTemplates)
      .leftJoin(organizations, eq(clientAiPromptTemplates.orgId, organizations.id))
      .where(eq(clientAiPromptTemplates.id, id))
      .limit(1);
    if (!existing) return c.json({ error: 'Template not found' }, 404);

    const set: Partial<typeof clientAiPromptTemplates.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description ?? null;
    if (body.promptBody !== undefined) set.promptBody = body.promptBody;
    if (body.category !== undefined) set.category = body.category ?? null;
    if (body.hosts !== undefined) set.hosts = normalizeTemplateHosts(body.hosts);

    const [row] = await db
      .update(clientAiPromptTemplates)
      .set(set)
      .where(eq(clientAiPromptTemplates.id, id))
      .returning();
    if (!row) return c.json({ error: 'Template not found' }, 404);

    writeRouteAudit(c, {
      orgId: row.orgId ?? null,
      action: 'client_ai.template.update',
      resourceType: 'client_ai_prompt_template',
      resourceId: id,
      resourceName: row.name,
      details: { changedKeys: Object.keys(set).filter((k) => k !== 'updatedAt') },
    });

    return c.json({ template: row });
  }
);

// ── DELETE /templates/:id ─────────────────────────────────────────────────────
clientAiAdminTemplateRoutes.delete('/templates/:id', requireOrgsWrite, async (c) => {
  const id = c.req.param('id')!;

  const [row] = await db
    .delete(clientAiPromptTemplates)
    .where(eq(clientAiPromptTemplates.id, id))
    .returning();
  if (!row) return c.json({ error: 'Template not found' }, 404);

  writeRouteAudit(c, {
    orgId: row.orgId ?? null,
    action: 'client_ai.template.delete',
    resourceType: 'client_ai_prompt_template',
    resourceId: id,
    resourceName: row.name,
  });

  return c.json({ success: true });
});
