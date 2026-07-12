import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { db } from '../../db';
import { securityPolicies } from '../../db/schema';
import { requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import {
  listPoliciesQuerySchema,
  createPolicySchema,
  updatePolicySchema,
  policyIdParamSchema
} from './schemas';
import { getPolicyOrgId } from './helpers';

export const policiesRoutes = new Hono();

// Dual-axis access condition (#2127): org-owned rows the caller can reach OR
// partner-wide rows (org_id NULL) owned by the caller's own partner. This
// app-layer condition keeps partner-owned templates visible to reads that
// filter by auth.orgCondition (which would otherwise exclude org_id IS NULL
// rows). RLS is STRICTER, not identical: breeze_has_partner_access only passes
// for partner-scope callers, so the branch is gated on partner scope to keep
// app and DB in agreement. Mirrors softwarePolicyAccessCondition (#2126).
function securityPolicyAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(securityPolicies.orgId);
  // System scope: no filter on either axis.
  if (!orgCond) return undefined;
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${securityPolicies.orgId} IS NULL AND ${securityPolicies.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

policiesRoutes.get(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions = [];
    const accessCondition = securityPolicyAccessCondition(auth);
    if (accessCondition) conditions.push(accessCondition);

    const rows = await db
      .select()
      .from(securityPolicies)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(securityPolicies.createdAt));

    let policies = rows.map((row) => {
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        // null orgId = partner-wide ("All organizations") template (#2127)
        orgId: row.orgId,
        partnerId: row.partnerId,
        name: row.name,
        description: typeof settings.description === 'string' ? settings.description : undefined,
        providerId: typeof settings.providerId === 'string' ? settings.providerId : undefined,
        scanSchedule: (typeof settings.scanSchedule === 'string' ? settings.scanSchedule : 'weekly') as 'daily' | 'weekly' | 'monthly' | 'manual',
        realTimeProtection: typeof settings.realTimeProtection === 'boolean' ? settings.realTimeProtection : true,
        autoQuarantine: typeof settings.autoQuarantine === 'boolean' ? settings.autoQuarantine : true,
        severityThreshold: (typeof settings.severityThreshold === 'string' ? settings.severityThreshold : 'medium') as 'low' | 'medium' | 'high' | 'critical',
        exclusions: Array.isArray(settings.exclusions) ? settings.exclusions.filter((value): value is string => typeof value === 'string') : [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.createdAt.toISOString()
      };
    });

    if (query.providerId) {
      policies = policies.filter((policy) => policy.providerId === query.providerId);
    }

    if (query.scanSchedule) {
      policies = policies.filter((policy) => policy.scanSchedule === query.scanSchedule);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      policies = policies.filter((policy) => {
        return (
          policy.name.toLowerCase().includes(term) ||
          policy.description?.toLowerCase().includes(term)
        );
      });
    }

    return c.json({ data: policies });
  }
);

policiesRoutes.post(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  // requireScope only checks tenancy tier, not role. Security policies are
  // device-security settings (AV scan schedule, real-time protection,
  // auto-quarantine, exclusions), so mutating them requires a device-write
  // permission — matches sensitiveData policy writes (DEVICES_WRITE).
  requirePermission('devices', 'write'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    // Ownership axis (#2127). Partner-wide templates apply to devices in ALL
    // orgs under the partner, so creation is gated on the partner-wide
    // capability — same gate as software/config policies. The partner is
    // ALWAYS derived from the caller's own token.
    let owner: { orgId: string | null; partnerId: string | null };
    if (payload.ownerScope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner-wide security policies require partner scope' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: 'Partner-wide security policies require full partner org access (orgAccess must be "all")' }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgId = getPolicyOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'Unable to determine target organization for policy creation' }, 400);
      }
      owner = { orgId, partnerId: null };
    }

    const [policy] = await db
      .insert(securityPolicies)
      .values({
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        name: payload.name,
        settings: {
          description: payload.description,
          providerId: payload.providerId,
          scanSchedule: payload.scanSchedule,
          realTimeProtection: payload.realTimeProtection,
          autoQuarantine: payload.autoQuarantine,
          severityThreshold: payload.severityThreshold,
          exclusions: payload.exclusions
        }
      })
      .returning();
    if (!policy) {
      return c.json({ error: 'Failed to create policy' }, 500);
    }

    return c.json({ data: {
      id: policy.id,
      orgId: policy.orgId,
      partnerId: policy.partnerId,
      name: policy.name,
      description: payload.description,
      providerId: payload.providerId,
      scanSchedule: payload.scanSchedule,
      realTimeProtection: payload.realTimeProtection,
      autoQuarantine: payload.autoQuarantine,
      severityThreshold: payload.severityThreshold,
      exclusions: payload.exclusions,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.createdAt.toISOString()
    } }, 201);
  }
);

policiesRoutes.put(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  // Device-security config mutation requires device-write (see POST /policies).
  requirePermission('devices', 'write'),
  zValidator('param', policyIdParamSchema),
  zValidator('json', updatePolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const conditions: SQL[] = [eq(securityPolicies.id, id)];
    const accessCondition = securityPolicyAccessCondition(auth);
    if (accessCondition) conditions.push(accessCondition);

    const [existing] = await db
      .select()
      .from(securityPolicies)
      .where(and(...conditions))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // Partner-wide templates are READABLE by any member of the partner but
    // administrable only with the partner-wide capability — editing the AV/EDR
    // baseline changes enforcement across every org under the partner.
    if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const existingSettings = (existing.settings ?? {}) as Record<string, unknown>;
    const nextSettings = {
      ...existingSettings,
      ...payload
    };

    const [updated] = await db
      .update(securityPolicies)
      .set({
        name: payload.name ?? existing.name,
        settings: nextSettings
      })
      .where(eq(securityPolicies.id, id))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to update policy' }, 500);
    }

    return c.json({ data: {
      id: updated.id,
      name: updated.name,
      description: typeof nextSettings.description === 'string' ? nextSettings.description : undefined,
      providerId: typeof nextSettings.providerId === 'string' ? nextSettings.providerId : undefined,
      scanSchedule: (typeof nextSettings.scanSchedule === 'string' ? nextSettings.scanSchedule : 'weekly') as 'daily' | 'weekly' | 'monthly' | 'manual',
      realTimeProtection: typeof nextSettings.realTimeProtection === 'boolean' ? nextSettings.realTimeProtection : true,
      autoQuarantine: typeof nextSettings.autoQuarantine === 'boolean' ? nextSettings.autoQuarantine : true,
      severityThreshold: (typeof nextSettings.severityThreshold === 'string' ? nextSettings.severityThreshold : 'medium') as 'low' | 'medium' | 'high' | 'critical',
      exclusions: Array.isArray(nextSettings.exclusions) ? nextSettings.exclusions.filter((value): value is string => typeof value === 'string') : [],
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.createdAt.toISOString()
    } });
  }
);
