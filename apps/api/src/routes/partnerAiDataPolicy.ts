import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { aiDataPolicies, AI_DEVICE_FILE_READ_LEVELS, organizations } from '../db/schema';
import { authMiddleware, hasSatisfiedMfa, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { zValidator } from '../lib/validation';
import { getUserPermissions, hasPermission, PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { createAuditLogAsync } from '../services/auditService';
import { AI_DATA_POLICY_DEFAULTS, transcriptPreviewDaysSchema } from '../services/aiDataPolicy';
import {
  AI_TRANSCRIPT_RETENTION_ENFORCE,
  countTranscriptPreview,
  technicianStubPredicate,
  transcriptCutoffIso,
  TRANSCRIPT_PREVIEW_CAP,
} from '../services/aiTranscriptRetentionPredicates';

/**
 * AI data policy (#8852 W1): the PARTNER default half of `ai_data_policies`.
 * Writes are gated on `canManagePartnerWidePolicies` (#2135), `ai_agents:write`
 * and a satisfied MFA claim. A NULL column means "no opinion" (device-file level
 * falls to the built-in default; retention NULL on a partner row = keep forever).
 */
export const aiDataPolicyBodySchema = z.object({
  deviceFileReadLevel: z.enum(AI_DEVICE_FILE_READ_LEVELS).nullable().optional(),
  toolOutputRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  /** Technician-AI transcript window (#4342 W4); same semantics as `toolOutputRetentionDays`. */
  transcriptRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
}).strict();

export function toAiDataPolicyDto(row: typeof aiDataPolicies.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    partnerId: row.partnerId,
    deviceFileReadLevel: row.deviceFileReadLevel,
    toolOutputRetentionDays: row.toolOutputRetentionDays,
    transcriptRetentionDays: row.transcriptRetentionDays,
    updatedAt: row.updatedAt,
  };
}

/**
 * Whether a PUT from this caller would pass every gate it enforces:
 * `canManagePartnerWidePolicies`, `ai_agents:write` and a satisfied MFA claim.
 * The GET reports this as `canManage` so the card is read-only exactly when a
 * save would 403. The GET carries no `requirePermission` (reads stay open to
 * the partner scope), so permissions are resolved here the same way
 * `requirePermission` does; none resolved = false.
 */
async function callerCanManage(auth: AuthContext): Promise<boolean> {
  if (!canManagePartnerWidePolicies(auth) || !hasSatisfiedMfa(auth)) return false;
  const perms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
    scope: auth.scope,
  });
  return !!perms && hasPermission(perms, PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action);
}

export const partnerAiDataPolicyRoutes = new Hono();
partnerAiDataPolicyRoutes.use('*', authMiddleware);
partnerAiDataPolicyRoutes.use('*', requireScope('partner', 'system'));

partnerAiDataPolicyRoutes.get('/', async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
  const [row] = await db
    .select()
    .from(aiDataPolicies)
    .where(and(isNull(aiDataPolicies.orgId), eq(aiDataPolicies.partnerId, auth.partnerId)))
    .limit(1);
  return c.json({
    policy: row ? toAiDataPolicyDto(row) : null,
    canManage: await callerCanManage(auth),
    defaults: AI_DATA_POLICY_DEFAULTS,
  });
});

/**
 * Preview of the PARTNER transcript window (#4342 W4): how many technician
 * sessions across the partner's orgs are past window N today. An org whose own
 * row is tighter than N keeps its own window, so it is skipped; an org row
 * that is NULL or >= N is governed by N (an org can only tighten). Request
 * path only: the org list, the org rows and every count run under the
 * caller's RLS context, never a system escape, so a restricted partner token
 * counts only the orgs it can see. Sequential, never `Promise.all`: one
 * request transaction. Summing stops at `TRANSCRIPT_PREVIEW_CAP` (`capped`;
 * the card labels the figure "up to").
 */
partnerAiDataPolicyRoutes.get(
  '/transcript-retention-preview',
  zValidator('query', z.object({ days: transcriptPreviewDaysSchema })),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
    const { days } = c.req.valid('query');
    const now = new Date();
    const cutoffIso = transcriptCutoffIso(days, now);

    const orgConditions: SQL[] = [eq(organizations.partnerId, auth.partnerId), isNull(organizations.deletedAt)];
    const scoped = auth.orgCondition?.(organizations.id);
    if (scoped) orgConditions.push(scoped);
    const orgRows = await db.select({ id: organizations.id }).from(organizations).where(and(...orgConditions));
    const orgIds = orgRows.map((row) => row.id);
    if (orgIds.length === 0) return c.json({ eligible: 0, capped: false, enforced: AI_TRANSCRIPT_RETENTION_ENFORCE });

    const orgPolicyRows = await db
      .select({ orgId: aiDataPolicies.orgId, transcriptRetentionDays: aiDataPolicies.transcriptRetentionDays })
      .from(aiDataPolicies)
      .where(inArray(aiDataPolicies.orgId, orgIds));
    const tighter = new Set(
      orgPolicyRows
        .filter((row) => row.orgId !== null && row.transcriptRetentionDays !== null && row.transcriptRetentionDays < days)
        .map((row) => row.orgId as string),
    );

    let eligible = 0;
    let capped = false;
    for (const orgId of orgIds) {
      if (tighter.has(orgId)) continue;
      const result = await countTranscriptPreview(technicianStubPredicate(orgId, cutoffIso, now), TRANSCRIPT_PREVIEW_CAP - eligible);
      eligible += result.eligible;
      if (result.capped) {
        capped = true;
        break;
      }
    }
    return c.json({ eligible, capped, enforced: AI_TRANSCRIPT_RETENTION_ENFORCE });
  },
);

partnerAiDataPolicyRoutes.put(
  '/',
  requirePermission(PERMISSIONS.AI_AGENTS_WRITE.resource, PERMISSIONS.AI_AGENTS_WRITE.action),
  requireMfa(),
  zValidator('json', aiDataPolicyBodySchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
    if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const body = c.req.valid('json');
    const now = new Date();
    const [row] = await db
      .insert(aiDataPolicies)
      .values({
        partnerId: auth.partnerId,
        orgId: null,
        createdBy: auth.user.id,
        // A partner row with NULL retention means keep-forever, so a first save
        // that omits the key must seed the built-in default rather than NULL.
        // An explicit null still stores NULL; the conflict `set` below leaves
        // an existing row's retention alone unless the body carries the key.
        ...('toolOutputRetentionDays' in body ? {} : { toolOutputRetentionDays: AI_DATA_POLICY_DEFAULTS.toolOutputRetentionDays }),
        ...('transcriptRetentionDays' in body ? {} : { transcriptRetentionDays: AI_DATA_POLICY_DEFAULTS.transcriptRetentionDays }),
        ...body,
      })
      .onConflictDoUpdate({ target: aiDataPolicies.partnerId, set: { ...body, updatedAt: now } })
      .returning();
    if (!row) return c.json({ error: 'Failed to save AI data policy' }, 500);
    await createAuditLogAsync({
      orgId: null,
      partnerId: auth.partnerId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'ai.data_policy.updated',
      resourceType: 'ai_data_policies',
      resourceId: row.id,
      details: { level: 'partner', ...body },
      result: 'success',
      initiatedBy: 'manual',
    });
    return c.json({ policy: toAiDataPolicyDto(row) });
  },
);
