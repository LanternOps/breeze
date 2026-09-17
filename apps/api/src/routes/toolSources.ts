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
  createToolSourceSchemaWithHttp,
  patchToolSourceToolSchema,
  qualifiedToolName,
  testToolCallSchema,
  updateToolSourceSchema,
  updateToolSourceSchemaWithHttp,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { toolSourcesAllowPrivateEgress, toolSourcesEnabled } from '../config/env';
import { authMiddleware, requireMfa, requirePermission, requireScope, withAuthDbAccessContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { enqueueToolSourceDiscovery } from '../jobs/toolSourceDiscoveryWorker';
import { resolveTenantToolByName } from '../services/toolSources/resolver';
import { executeTenantToolDetailed } from '../services/toolSources/execute';
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

// Select per request: a lazy Zod schema caches its first resolved schema.
function toolSourceValidator<T extends z.ZodType>(httpsSchema: T, httpSchema: T) {
  const validate = zValidator('json', httpsSchema);
  const middleware: typeof validate = (c, next) =>
    zValidator('json', toolSourcesAllowPrivateEgress() ? httpSchema : httpsSchema)(c, next);
  return middleware;
}

toolSourcesRoutes.post(
  '/',
  requireToolSourcesWrite,
  requireMfa(),
  toolSourceValidator(createToolSourceSchema, createToolSourceSchemaWithHttp),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    const result = await withAuthDbAccessContext(auth, async () => {
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

      writeRouteAudit(c, {
        orgId: row.orgId,
        action: 'tool_source.created',
        resourceType: 'tool_source',
        resourceId: row.id,
        resourceName: row.name,
        details: { kind: row.kind, authKind: row.authKind, ownerScope: payload.ownerScope ?? 'organization' },
      });
      return row;
    });
    if (result instanceof Response) return result;
    const row = result;
    try {
      await enqueueToolSourceDiscovery(row.id);
    } catch {
      const source = toToolSourceDto(row);
      return c.json({ success: true, source, data: source, warning: 'discovery_not_queued' }, 202);
    }

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
  toolSourceValidator(updateToolSourceSchema, updateToolSourceSchemaWithHttp),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const result = await withAuthDbAccessContext(auth, async () => {
      const existing = await getToolSourceWithAccess(auth, id);
      if (!existing) return c.json({ error: 'Tool source not found' }, 404);

      if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }

      const { row, discoveryTriggered } = await updateToolSourceRow(existing, payload);

      writeRouteAudit(c, {
        orgId: row.orgId,
        action: 'tool_source.updated',
        resourceType: 'tool_source',
        resourceId: row.id,
        resourceName: row.name,
        details: { updatedFields: Object.keys(payload), discoveryTriggered },
      });
      return { row, discoveryTriggered };
    });
    if (result instanceof Response) return result;
    const { row, discoveryTriggered } = result;
    if (discoveryTriggered) {
      try {
        await enqueueToolSourceDiscovery(row.id);
      } catch {
        const source = toToolSourceDto(row);
        return c.json({ success: true, source, data: source, warning: 'discovery_not_queued' }, 202);
      }
    }

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

    const result = await withAuthDbAccessContext(auth, async () => {
      const existing = await getToolSourceWithAccess(auth, id);
      if (!existing) return c.json({ error: 'Tool source not found' }, 404);

      if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }


      writeRouteAudit(c, {
        orgId: existing.orgId,
        action: 'tool_source.discover',
        resourceType: 'tool_source',
        resourceId: existing.id,
        resourceName: existing.name,
      });
      return existing;
    });
    if (result instanceof Response) return result;
    try {
      await enqueueToolSourceDiscovery(result.id);
    } catch {
      return c.json({ success: true, source: toToolSourceDto(result), data: { queued: false }, warning: 'discovery_not_queued' }, 202);
    }

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

    // `source.orgId` is the validated request org — `getSourceAndToolWithAccess`
    // above already confirmed `auth` can access this source (org-owned or
    // partner-wide) — passed as `targetOrgId` so a partner-scoped session
    // resolving an org-owned source's tool doesn't fall through to only the
    // partner-wide branch (#6023). `null` (partner-wide source) is a no-op.
    const qualifiedName = qualifiedToolName(source.slug, tool.name);
    const descriptor = await resolveTenantToolByName(auth, qualifiedName, source.orgId);
    if (!descriptor) {
      // #6102: `getSourceAndToolWithAccess` above already ran the tenant/access
      // check (source access + tool existence, independent of health) — this
      // is purely a health DISTINCTION on top of that, never a substitute for
      // it. A tool a caller genuinely can't see or that's disabled/removed
      // still falls through to the identical generic 404 below (no existence
      // oracle). Only when the tool is enabled, not removed, and the only
      // reason `resolveTenantToolByName` returned null is the source's own
      // `status` do we surface the distinct, actionable 503 — safe to include
      // `lastError` here because this route is already gated on
      // `requireToolSourcesRead`, the same permission that lets this caller
      // read `lastError` off `GET /tool-sources/:id`.
      if (tool.enabled && tool.removedAt === null && source.status !== 'active') {
        return c.json(
          {
            error: `Tool source "${source.name}" is not active (status: ${source.status})`,
            code: 'tool_source_unavailable',
            sourceStatus: source.status,
            lastError: source.lastError,
          },
          503,
        );
      }
      return c.json({ error: 'Tool is not currently available' }, 404);
    }

    const start = Date.now();
    // Detailed form: a test call that FAILED must not read as a success. The
    // web client uses `runAction`, which treats an HTTP-200 body carrying
    // `success: false` as a failure (CLAUDE.md, "Web Mutation Handlers") — a
    // bare 200 with the failure text buried in `result` would surface as
    // "Test call succeeded" in the UI that lands in PR C.
    const { isError, text } = await executeTenantToolDetailed(descriptor, input, auth, {
      surface: 'test',
      orgId: source.orgId,
    });
    const durationMs = Date.now() - start;

    return c.json({
      success: !isError,
      data: { result: isError ? JSON.stringify({ error: text }) : text, isError, durationMs },
    });
  },
);
