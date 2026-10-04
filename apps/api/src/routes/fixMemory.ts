/**
 * AI Suggested Fixes W2 — the Fix memory list (AI area) and reviewed steps.
 * Data, not settings (spec): no settings-audit registration. Every read runs
 * under the caller's RLS; fix_memory's dual-axis policies + SELECT branch
 * decide visibility, and org-private rows never cross orgs.
 */
import { Hono } from 'hono';
import { and, desc, eq, isNull, isNotNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { FIX_KINDS, FIX_MEMORY_STATUSES, reviewedInstructionsSchema } from '@breeze/shared';
import { db } from '../db';
import { fixInstructions, fixMemory, fixOutcomes, playbookDefinitions, scripts } from '../db/schema';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { listReviewedInstructions, retireReviewedInstructions, saveReviewedInstructions } from '../services/fixMemory/instructions';
import { retireFixMemory } from '../services/fixMemory/store';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { PERMISSIONS } from '../services/permissions';

export const fixMemoryRoutes = new Hono();
fixMemoryRoutes.use('*', authMiddleware);

const os = z.enum(['windows', 'macos', 'linux']);
const listQuery = z.object({
  osType: os.optional(),
  fixKind: z.enum(FIX_KINDS).optional(),
  status: z.enum(FIX_MEMORY_STATUSES).optional(),
  scope: z.enum(['all_clients', 'this_client']).optional(),
  condition: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const BUILTIN_LABEL: Record<string, string> = { reboot: 'Reboot', restart_service: 'Restart service', kill_process: 'Kill process', disk_cleanup: 'Disk cleanup' };

/** A visible contributing attempt's condition token; null when the caller can see none. */
export const conditionSql = sql<string | null>`(
  SELECT fo.signature_facets->>'condition' FROM ${fixOutcomes} fo
  WHERE (fo.partner_id = ${fixMemory.partnerId} OR fo.org_id = ${fixMemory.orgId})
    AND fo.signature_key = ${fixMemory.signatureKey} AND fo.fix_identity = ${fixMemory.fixIdentity}
  LIMIT 1)`;

fixMemoryRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action),
  zValidator('query', listQuery),
  async (c) => {
    const q = c.req.valid('query');
    const conds: SQL[] = [];
    if (q.osType) conds.push(eq(fixMemory.osType, q.osType));
    if (q.fixKind) conds.push(eq(fixMemory.fixKind, q.fixKind));
    if (q.status) conds.push(eq(fixMemory.status, q.status));
    if (q.scope === 'all_clients') conds.push(isNull(fixMemory.orgId));
    if (q.scope === 'this_client') conds.push(isNotNull(fixMemory.orgId));
    if (q.condition) conds.push(sql`${conditionSql} ILIKE ${`%${q.condition}%`}`);
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select({
      id: fixMemory.id, orgId: fixMemory.orgId, partnerId: fixMemory.partnerId, fixKind: fixMemory.fixKind,
      builtinAction: fixMemory.builtinAction, scriptName: scripts.name, instructionsTitle: fixInstructions.title, playbookName: playbookDefinitions.name,
      osType: fixMemory.osType, attempts: fixMemory.attempts, verifiedCount: fixMemory.verifiedCount, failedCount: fixMemory.failedCount,
      recurredCount: fixMemory.recurredCount, rollingSuccessRate: fixMemory.rollingSuccessRate, status: fixMemory.status,
      staleSince: fixMemory.staleSince, lastVerifiedAt: fixMemory.lastVerifiedAt, signatureKey: fixMemory.signatureKey, condition: conditionSql,
    }).from(fixMemory)
      .leftJoin(scripts, eq(scripts.id, fixMemory.scriptId))
      .leftJoin(playbookDefinitions, eq(playbookDefinitions.id, fixMemory.playbookId))
      .leftJoin(fixInstructions, eq(sql`${fixInstructions.id}::text`, fixMemory.instructionsRef))
      .where(where)
      .orderBy(desc(fixMemory.lastVerifiedAt), desc(fixMemory.id))
      .limit(q.limit).offset(q.offset);
    const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(fixMemory).where(where);
    return c.json({
      data: rows.map((r) => ({
        id: r.id, scope: r.orgId ? 'this_client' : 'all_clients', orgId: r.orgId, fixKind: r.fixKind,
        label: r.scriptName ?? r.instructionsTitle ?? r.playbookName ?? (r.builtinAction ? BUILTIN_LABEL[r.builtinAction] ?? r.builtinAction : r.fixKind),
        osType: r.osType, attempts: r.attempts, verified: r.verifiedCount, failed: r.failedCount, recurred: r.recurredCount,
        successRate: Number(r.rollingSuccessRate), status: r.status, stale: r.staleSince !== null,
        lastVerifiedAt: r.lastVerifiedAt?.toISOString() ?? null, condition: r.condition, signatureKeyPrefix: r.signatureKey.slice(0, 8),
      })),
      total: count?.total ?? 0,
    });
  },
);

fixMemoryRoutes.post(
  '/:id/retire',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action),
  requireMfa(),
  zValidator('param', z.object({ id: z.string().uuid() })),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const [row] = await db.select({ id: fixMemory.id, orgId: fixMemory.orgId, partnerId: fixMemory.partnerId }).from(fixMemory).where(eq(fixMemory.id, id)).limit(1);
    if (!row) return c.json({ error: 'Fix memory entry not found' }, 404);
    if (row.orgId === null ? !canManagePartnerWidePolicies(auth) : !auth.canAccessOrg(row.orgId)) {
      return c.json({ error: row.orgId === null ? PARTNER_WIDE_WRITE_DENIED_MESSAGE : 'Access denied' }, 403);
    }
    // Runs in this request's transaction (RLS-bounded); the identity advisory lock lives until it ends.
    const result = await retireFixMemory({ id, userId: auth.user.id });
    if (result === 'not_found') return c.json({ error: 'Fix memory entry not found' }, 404);
    writeRouteAudit(c, { orgId: row.orgId, action: 'fix_memory.retire', resourceType: 'fix_memory', resourceId: id, details: { scope: row.orgId ? 'this_client' : 'all_clients', changed: result === 'retired' } });
    return c.json({ data: { id, status: 'retired', changed: result === 'retired' } });
  },
);

fixMemoryRoutes.get(
  '/instructions',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', z.object({ osType: os.optional() })),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.partnerId) return c.json({ data: [] });
    const { osType } = c.req.valid('query');
    const rows = await listReviewedInstructions({ partnerId: auth.partnerId, ...(osType ? { osType } : {}) });
    return c.json({ data: rows.map((r) => ({ id: r.id, title: r.title, steps: r.steps, osType: r.osType, reviewedAt: r.reviewedAt.toISOString() })) });
  },
);

fixMemoryRoutes.post(
  '/instructions',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requireMfa(),
  zValidator('json', reviewedInstructionsSchema.extend({ fromSuggestionId: z.string().uuid().optional() })),
  async (c) => {
    const auth = c.get('auth');
    if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const body = c.req.valid('json');
    const row = await saveReviewedInstructions({ partnerId: auth.partnerId, reviewedBy: auth.user.id, title: body.title, steps: body.steps, osType: body.osType });
    writeRouteAudit(c, { orgId: null, action: 'fix_memory.instructions.save', resourceType: 'fix_instructions', resourceId: row.id, resourceName: row.title, details: { fromSuggestionId: body.fromSuggestionId ?? null, steps: row.steps.length } });
    return c.json({ data: row }, 201);
  },
);

fixMemoryRoutes.post(
  '/instructions/:id/retire',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requireMfa(),
  zValidator('param', z.object({ id: z.string().uuid() })),
  async (c) => {
    const auth = c.get('auth');
    if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const { id } = c.req.valid('param');
    if (!(await retireReviewedInstructions({ id, partnerId: auth.partnerId }))) return c.json({ error: 'Reviewed steps not found' }, 404);
    writeRouteAudit(c, { orgId: null, action: 'fix_memory.instructions.retire', resourceType: 'fix_instructions', resourceId: id });
    return c.json({ data: { id, retired: true } });
  },
);
