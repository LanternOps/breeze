import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  FLOW_LIMIT_CEILINGS,
  FLOW_LIMIT_DEFAULTS,
  FLOW_LIMIT_KEYS,
  flowLimitsSettingsSchema,
  flowLimitsUpdateSchema,
  type FlowLimitKey,
  type FlowLimitsDto,
  type FlowLimitsUpdate,
  type FlowLimitsViewDto,
  type FlowLimitsWriteError,
} from '@breeze/shared';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, partners } from '../db/schema';
import { hasSatisfiedMfa, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { zValidator } from '../lib/validation';
import { createAuditLogAsync } from '../services/auditService';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { computeFlowLimits } from '../services/flows/flowLimits';

/**
 * Flow limits (Tool Catalog W05 #5220, plan Decision 15 / Task D3): the one
 * home of the monthly run caps and the per-run AI token ceiling.
 *
 *   GET /api/v1/flows/limits[?orgId=]   one level's stored values + what resolves
 *   PUT /api/v1/flows/limits            { orgId?, limits: { <key>: n | null } }
 *
 * Levels: the partner default (no `orgId`; `automations.write` + MFA +
 * `canManagePartnerWidePolicies`) and an org override that may only LOWER the
 * partner's value — a stated partner-ceiling exception to settings rule 3,
 * refused here (`limit_above_partner_ceiling`), not only in the client. The
 * resolver (`resolveFlowLimits` → `computeFlowLimits`) also ignores a stored
 * org value above the ceiling, so a later partner lowering wins at once.
 *
 * Every write is one path-level jsonb update of `settings.flows.<key>`, so no
 * other settings key is read or rewritten (the connectionHealthSettings.ts
 * pattern). Org writes are partner/system scope, like every other org settings
 * write (`PATCH /orgs/organizations/:id`); an org-scope caller reads only.
 *
 * Registered on `flowsRoutes` (which owns auth, the FLOWS_ENABLED switch and
 * `automations.read`) before `/:id`, so `/limits` never reaches the uuid param.
 */

const ACTION = 'flows.limits.updated';
const querySchema = z.object({ orgId: z.string().uuid().optional() });

type Stored = Record<FlowLimitKey, number | null>;
type Changes = FlowLimitsUpdate['limits'];

const STATUS: Record<FlowLimitsWriteError, 400 | 403 | 404 | 422> = {
  org_not_found: 404,
  partner_required: 400,
  partner_not_found: 404,
  partner_scope_required: 403,
  partner_wide_forbidden: 403,
  org_scope_read_only: 403,
  limit_above_partner_ceiling: 422,
};

function fail(c: Context, error: FlowLimitsWriteError, extra: Record<string, unknown> = {}) {
  return c.json({ error, ...extra }, STATUS[error]);
}

/**
 * Sets (number) or removes (null) each named key inside `settings.flows`,
 * creating the block when absent and replacing a malformed (non-object) value.
 * Keys come from FLOW_LIMIT_KEYS only and reach SQL as bound parameters.
 */
export function flowLimitsSettingsUpdate(column: SQL | unknown, changes: Changes): SQL {
  const base = sql`CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END`;
  let next: SQL = sql`CASE WHEN jsonb_typeof(${column}->'flows') = 'object' THEN ${column}->'flows' ELSE '{}'::jsonb END`;
  for (const key of FLOW_LIMIT_KEYS) {
    if (!Object.hasOwn(changes, key)) continue;
    const value = changes[key];
    if (value === undefined) continue;
    next = value === null
      ? sql`(${next}) - ${key}::text`
      : sql`(${next}) || jsonb_build_object(${key}::text, ${value}::int)`;
  }
  return sql`jsonb_set(${base}, '{flows}', ${next}, true)`;
}

/**
 * What one level stores. An invalid stored value reads as not set, as the
 * resolver treats it; an org value above the partner ceiling stays visible
 * (stored, not in effect — `limits.source` says which applies).
 */
function storedAt(settings: unknown): Stored {
  const block = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).flows : undefined;
  const out = {} as Stored;
  for (const key of FLOW_LIMIT_KEYS) {
    const raw = block && typeof block === 'object' && !Array.isArray(block) ? (block as Record<string, unknown>)[key] : undefined;
    const parsed = flowLimitsSettingsSchema.shape[key].safeParse(raw);
    out[key] = parsed.success && parsed.data !== undefined ? parsed.data : null;
  }
  return out;
}

function toDto(partnerSettings: unknown, orgSettings: unknown | null): FlowLimitsDto {
  const { source, partnerCeiling, ...effective } = computeFlowLimits(partnerSettings, orgSettings);
  return { effective: effective as FlowLimitsDto['effective'], source, partnerCeiling };
}

function canWrite(auth: AuthContext, perms: UserPermissions | undefined): boolean {
  return !!perms
    && hasPermission(perms, PERMISSIONS.AUTOMATIONS_WRITE.resource, PERMISSIONS.AUTOMATIONS_WRITE.action)
    && hasSatisfiedMfa(auth);
}

type Target =
  | { ok: true; level: 'partner'; partnerId: string; orgId: null; orgSettings: null }
  | { ok: true; level: 'org'; partnerId: string; orgId: string; orgSettings: unknown }
  | { ok: false; error: FlowLimitsWriteError };

/** Resolves the level a request addresses; the org is read in the caller's RLS context. */
async function resolveTarget(auth: AuthContext, orgId: string | undefined): Promise<Target> {
  const targetOrg = orgId ?? (auth.scope === 'organization' ? auth.orgId ?? undefined : undefined);
  if (!targetOrg) {
    if (!auth.partnerId) return { ok: false, error: 'partner_required' };
    return { ok: true, level: 'partner', partnerId: auth.partnerId, orgId: null, orgSettings: null };
  }
  if (!auth.canAccessOrg(targetOrg)) return { ok: false, error: 'org_not_found' };
  const [org] = await db
    .select({ settings: organizations.settings, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, targetOrg))
    .limit(1);
  if (!org || (auth.scope !== 'system' && auth.partnerId && org.partnerId !== auth.partnerId)) {
    return { ok: false, error: 'org_not_found' };
  }
  return { ok: true, level: 'org', partnerId: org.partnerId, orgId: targetOrg, orgSettings: org.settings ?? {} };
}

/**
 * The partner's settings, or `undefined` when the row is not visible. Callers
 * refuse on `undefined`: reading it as "no settings" would make the platform
 * defaults the org ceiling and let an org be saved above a lowered partner value.
 */
async function readPartnerSettings(partnerId: string): Promise<unknown | undefined> {
  // Partner-axis row, pinned to a partner id derived from the caller or an access-checked org.
  const [partner] = await readWithPartnerAxisVisibility(() =>
    db.select({ settings: partners.settings }).from(partners).where(eq(partners.id, partnerId)).limit(1),
  );
  if (!partner) {
    console.warn(`[flows] flow limits: partner ${partnerId} is not visible; refusing instead of using defaults`);
    return undefined;
  }
  return partner.settings ?? null;
}

function viewOf(
  target: Extract<Target, { ok: true }>,
  partnerSettings: unknown,
  canManage: boolean,
): FlowLimitsViewDto {
  return {
    level: target.level,
    partnerId: target.partnerId,
    orgId: target.orgId,
    stored: storedAt(target.level === 'partner' ? partnerSettings : target.orgSettings),
    limits: toDto(partnerSettings, target.level === 'partner' ? null : target.orgSettings),
    defaults: { ...FLOW_LIMIT_DEFAULTS },
    ceilings: { ...FLOW_LIMIT_CEILINGS },
    canManage,
  };
}

/** Who may write the addressed level (the same rules the PUT enforces). */
function levelWritable(auth: AuthContext, level: 'partner' | 'org'): FlowLimitsWriteError | null {
  if (level === 'partner') {
    if (auth.scope !== 'partner' || !auth.partnerId) return 'partner_scope_required';
    if (!canManagePartnerWidePolicies(auth)) return 'partner_wide_forbidden';
    return null;
  }
  return auth.scope === 'organization' ? 'org_scope_read_only' : null;
}

export function registerFlowLimitsRoutes(app: Hono): void {
  app.get(
    '/limits',
    requireScope('organization', 'partner', 'system'),
    requirePermission(PERMISSIONS.AUTOMATIONS_READ.resource, PERMISSIONS.AUTOMATIONS_READ.action),
    zValidator('query', querySchema),
    async (c) => {
      const auth = c.get('auth');
      const target = await resolveTarget(auth, c.req.valid('query').orgId);
      if (!target.ok) return fail(c, target.error);
      const partnerSettings = await readPartnerSettings(target.partnerId);
      if (partnerSettings === undefined) return fail(c, 'partner_not_found');
      const canManage = canWrite(auth, c.get('permissions')) && levelWritable(auth, target.level) === null;
      return c.json(viewOf(target, partnerSettings, canManage));
    },
  );

  app.put(
    '/limits',
    requireScope('organization', 'partner', 'system'),
    requirePermission(PERMISSIONS.AUTOMATIONS_WRITE.resource, PERMISSIONS.AUTOMATIONS_WRITE.action),
    requireMfa(),
    zValidator('json', flowLimitsUpdateSchema),
    async (c) => {
      const auth = c.get('auth');
      const body = c.req.valid('json');
      // An org-scope caller never writes, whichever level it names.
      if (auth.scope === 'organization') return fail(c, 'org_scope_read_only');
      const target = await resolveTarget(auth, body.orgId);
      if (!target.ok) return fail(c, target.error);
      const refused = levelWritable(auth, target.level);
      if (refused) return fail(c, refused);

      const partnerSettings = await readPartnerSettings(target.partnerId);
      if (partnerSettings === undefined) return fail(c, 'partner_not_found');
      // RETURNING settings: the response is built from what was written. A
      // re-read would go through readWithPartnerAxisVisibility's separate
      // system context, which cannot see this request's uncommitted UPDATE.
      let rows: Array<{ id: string; settings: unknown }>;
      if (target.level === 'org') {
        // Lower-only: every value set must be ≤ the partner's effective value.
        const ceiling = computeFlowLimits(partnerSettings, null);
        for (const key of FLOW_LIMIT_KEYS) {
          const value = body.limits[key];
          if (typeof value === 'number' && value > ceiling[key]) {
            return fail(c, 'limit_above_partner_ceiling', { field: key, ceiling: ceiling[key] });
          }
        }
        rows = await db
          .update(organizations)
          .set({ settings: flowLimitsSettingsUpdate(organizations.settings, body.limits), updatedAt: new Date() })
          .where(and(eq(organizations.id, target.orgId), eq(organizations.partnerId, target.partnerId)))
          .returning({ id: organizations.id, settings: organizations.settings });
      } else {
        rows = await db
          .update(partners)
          .set({ settings: flowLimitsSettingsUpdate(partners.settings, body.limits), updatedAt: new Date() })
          .where(eq(partners.id, target.partnerId))
          .returning({ id: partners.id, settings: partners.settings });
      }
      if (rows.length === 0) return fail(c, target.level === 'org' ? 'org_not_found' : 'partner_required');

      await createAuditLogAsync({
        orgId: target.orgId,
        partnerId: target.partnerId,
        actorType: 'user',
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: ACTION,
        resourceType: target.level === 'org' ? 'organization' : 'partner',
        resourceId: target.orgId ?? target.partnerId,
        details: { level: target.level === 'org' ? 'organization' : 'partner', limits: body.limits },
        result: 'success',
        initiatedBy: 'manual',
      });

      const written = rows[0]!.settings ?? {};
      return c.json(target.level === 'org'
        ? viewOf({ ...target, orgSettings: written }, partnerSettings, true)
        : viewOf(target, written, true));
    },
  );
}
