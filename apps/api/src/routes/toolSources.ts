/**
 * `/api/v1/tool-sources` — Task A9 (spec 2026-09-07 §5/§8, plan
 * docs/superpowers/plans/ai-mcp/2026-09-07-tool-catalog-w1-tool-sources-mcp.md).
 *
 * CRUD + discovery + per-tool tier/enable administration for BYO MCP tool
 * sources, plus a Tier-1-only "test call" route. All persistence/business
 * logic lives in `services/toolSources/service.ts`; this file is permission
 * gating, validation, and wiring.
 *
 * Dark-shipped behind `TOOL_SOURCES_ENABLED` — the whole router 404s when the
 * flag is off (first `use('*')`), so the route's existence isn't leaked via a
 * 401/403 while the feature is dark.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  bulkEnableToolsSchema,
  createToolSourceSchema,
  patchToolSourceToolSchema,
  qualifiedToolName,
  testToolCallSchema,
  updateToolSourceSchema,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { toolSourcesEnabled } from '../config/env';
import { authMiddleware, requireMfa, requirePermission, requireScope, withAuthDbAccessContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { enqueueToolSourceDiscovery } from '../jobs/toolSourceDiscoveryWorker';
import { resolveTenantToolByName } from '../services/toolSources/resolver';
import { executeTenantTool } from '../services/toolSources/execute';
import {
  bulkToolsAction,
  createToolSourceRow,
  deleteToolSourceRow,
  getSourceAndToolWithAccess,
  getSourceTool,
  getToolCountsForSources,
  getToolSourceWithAccess,
  listSourceTools,
  listToolSources,
  patchSourceTool,
  resolveToolSourceOwner,
  slugShadowsPartnerSource,
  toToolSourceDto,
  updateToolSourceRow,
} from '../services/toolSources/service';

export const toolSourcesRoutes = new Hono();

const requireToolSourcesRead = requirePermission(PERMISSIONS.TOOL_SOURCES_READ.resource, PERMISSIONS.TOOL_SOURCES_READ.action);
const requireToolSourcesWrite = requirePermission(PERMISSIONS.TOOL_SOURCES_WRITE.resource, PERMISSIONS.TOOL_SOURCES_WRITE.action);
const requireExternalToolsUse = requirePermission(PERMISSIONS.EXTERNAL_TOOLS_USE.resource, PERMISSIONS.EXTERNAL_TOOLS_USE.action);

toolSourcesRoutes.use('*', authMiddleware);
toolSourcesRoutes.use('*', requireScope('organization', 'partner', 'system'));
toolSourcesRoutes.use('*', async (c, next) => {
  if (!toolSourcesEnabled()) return c.json({ error: 'Not found' }, 404);
  await next();
});

const idParamSchema = z.object({ id: z.string().uuid() });
const toolIdParamSchema = z.object({ id: z.string().uuid(), toolId: z.string().uuid() });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const toolsQuerySchema = z.object({ includeRemoved: z.enum(['true', 'false']).optional() });

toolSourcesRoutes.get(
  '/',
  requireToolSourcesRead,
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { limit = 50, offset = 0 } = c.req.valid('query');

    const result = await listToolSources(auth, { limit, offset });
    return c.json(result);
  },
);

toolSourcesRoutes.post(
  '/',
  requireToolSourcesWrite,
  requireMfa(),
  zValidator('json', createToolSourceSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    const ownerResult = await resolveToolSourceOwner(auth, { ownerScope: payload.ownerScope, orgId: payload.orgId });
    if ('error' in ownerResult) {
      return c.json({ error: ownerResult.error }, ownerResult.status as 400 | 403);
    }
    const { owner } = ownerResult;

    if (owner.orgId) {
      const shadows = await slugShadowsPartnerSource(owner.orgId, payload.slug);
      if (shadows) {
        return c.json(
          { error: 'This slug is already used by a partner-wide tool source', code: 'slug_shadows_partner_source' },
          409,
        );
      }
    }

    const row = await createToolSourceRow(owner, payload, auth.user.id);
    await enqueueToolSourceDiscovery(row.id);

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'tool_source.created',
      resourceType: 'tool_source',
      resourceId: row.id,
      resourceName: row.name,
      details: { kind: row.kind, authKind: row.authKind, ownerScope: payload.ownerScope ?? 'organization' },
    });

    return c.json({ data: toToolSourceDto(row) }, 201);
  },
);

toolSourcesRoutes.get(
  '/:id',
  requireToolSourcesRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const row = await getToolSourceWithAccess(auth, id);
    if (!row) return c.json({ error: 'Tool source not found' }, 404);

    const counts = await getToolCountsForSources([row.id]);
    return c.json({ data: toToolSourceDto(row, counts.get(row.id)) });
  },
);

toolSourcesRoutes.patch(
  '/:id',
  requireToolSourcesWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', updateToolSourceSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const existing = await getToolSourceWithAccess(auth, id);
    if (!existing) return c.json({ error: 'Tool source not found' }, 404);

    if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const { row, discoveryTriggered } = await updateToolSourceRow(existing, payload);
    if (discoveryTriggered) await enqueueToolSourceDiscovery(row.id);

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'tool_source.updated',
      resourceType: 'tool_source',
      resourceId: row.id,
      resourceName: row.name,
      details: { updatedFields: Object.keys(payload), discoveryTriggered },
    });

    return c.json({ data: toToolSourceDto(row) });
  },
);

toolSourcesRoutes.delete(
  '/:id',
  requireToolSourcesWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const existing = await getToolSourceWithAccess(auth, id);
    if (!existing) return c.json({ error: 'Tool source not found' }, 404);

    if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    await deleteToolSourceRow(existing.id);

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'tool_source.deleted',
      resourceType: 'tool_source',
      resourceId: existing.id,
      resourceName: existing.name,
    });

    return c.json({ success: true, id: existing.id });
  },
);

toolSourcesRoutes.post(
  '/:id/discover',
  requireToolSourcesWrite,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const existing = await getToolSourceWithAccess(auth, id);
    if (!existing) return c.json({ error: 'Tool source not found' }, 404);

    if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    await enqueueToolSourceDiscovery(existing.id);

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'tool_source.discover',
      resourceType: 'tool_source',
      resourceId: existing.id,
      resourceName: existing.name,
    });

    return c.json({ data: { queued: true } }, 202);
  },
);

toolSourcesRoutes.get(
  '/:id/tools',
  requireToolSourcesRead,
  zValidator('param', idParamSchema),
  zValidator('query', toolsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const existing = await getToolSourceWithAccess(auth, id);
    if (!existing) return c.json({ error: 'Tool source not found' }, 404);

    const { includeRemoved } = c.req.valid('query');
    const rows = await listSourceTools(existing.id, { includeRemoved: includeRemoved === 'true' });
    return c.json({ data: rows });
  },
);

toolSourcesRoutes.patch(
  '/:id/tools/:toolId',
  requireToolSourcesWrite,
  requireMfa(),
  zValidator('param', toolIdParamSchema),
  zValidator('json', patchToolSourceToolSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id, toolId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const existing = await getToolSourceWithAccess(auth, id);
    if (!existing) return c.json({ error: 'Tool source not found' }, 404);

    if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const tool = await getSourceTool(id, toolId);
    if (!tool) return c.json({ error: 'Tool not found' }, 404);

    const outcome = await patchSourceTool(tool, payload);
    if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status as 422 | 500);

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'tool_source_tool.updated',
      resourceType: 'tool_source_tool',
      resourceId: toolId,
      resourceName: outcome.row.qualifiedName,
      details: { oldTier: outcome.oldTier, newTier: outcome.row.tier, enabled: outcome.row.enabled },
    });

    return c.json({ data: outcome.row });
  },
);

toolSourcesRoutes.post(
  '/:id/tools/bulk',
  requireToolSourcesWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', bulkEnableToolsSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const { mode } = c.req.valid('json');

    const existing = await getToolSourceWithAccess(auth, id);
    if (!existing) return c.json({ error: 'Tool source not found' }, 404);

    if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const updated = await bulkToolsAction(existing.id, mode);

    writeRouteAudit(c, {
      orgId: existing.orgId,
      action: 'tool_source_tool.bulk_updated',
      resourceType: 'tool_source',
      resourceId: existing.id,
      resourceName: existing.name,
      details: { mode, updated },
    });

    return c.json({ data: { mode, updated } });
  },
);

// Self-managed DB context (middleware/selfManagedDbContextRoutes.ts) — the
// dispatch below runs a real outbound MCP call via executeTenantTool, so the
// lookup here opens its own short `withAuthDbAccessContext` block rather than
// inheriting one held across that network round trip (#1105); resolver.ts /
// execute.ts manage their own short system-scoped contexts around the call.
toolSourcesRoutes.post(
  '/:id/tools/:toolId/test',
  requireToolSourcesRead,
  requireExternalToolsUse,
  zValidator('param', toolIdParamSchema),
  zValidator('json', testToolCallSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id, toolId } = c.req.valid('param');
    const { input } = c.req.valid('json');

    const found = await withAuthDbAccessContext(auth, () => getSourceAndToolWithAccess(auth, id, toolId));
    if (!found) return c.json({ error: 'Tool not found' }, 404);
    const { source, tool } = found;

    if (tool.tier !== 1) {
      return c.json({ error: 'Only Tier 1 (read-only) tools can be test-called from this route' }, 403);
    }

    const qualifiedName = qualifiedToolName(source.slug, tool.name);
    const descriptor = await resolveTenantToolByName(auth, qualifiedName);
    if (!descriptor) return c.json({ error: 'Tool is not currently available' }, 404);

    const start = Date.now();
    const result = await executeTenantTool(descriptor, input, auth, { surface: 'test' });
    const durationMs = Date.now() - start;

    return c.json({ data: { result, durationMs } });
  },
);
