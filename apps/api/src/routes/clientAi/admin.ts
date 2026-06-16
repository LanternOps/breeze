import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { clientAiOrgPolicies, clientAiTenantMappings } from '../../db/schema/clientAi';
import { partners } from '../../db/schema/orgs';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { CLIENT_AI_ENTRA_CLIENT_ID } from '../../config/env';
import { resolveScopedOrgId } from '../c2c/helpers';
import { getOrgPolicy } from '../../services/clientAiPolicy';
import { putPolicySchema, putTenantMappingSchema } from './schemas';
import { clientAiAdminOrgRoutes } from './adminOrgs';
import { clientAiAdminSessionRoutes } from './adminSessions';
import { clientAiAdminUsageRoutes } from './adminUsage';
import { clientAiAdminTemplateRoutes } from './adminTemplates';

/**
 * MSP-facing admin surface for Breeze AI for Office (spec §9, consumed by the
 * Plan-4 dashboard): tenant mapping + per-org policy. Mirrors routes/m365.ts:
 * group authMiddleware, feature 404 gate, ORGS_READ/ORGS_WRITE permissions,
 * MFA on the isolation-critical mapping mutations, writeRouteAudit on writes.
 *
 * Org access: resolveScopedOrgId(auth, :orgId) returns null when the caller
 * cannot access the org → respond 404 (never reveal cross-tenant existence).
 */

export const clientAiAdminRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);
const requireOrgsWrite = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action
);

clientAiAdminRoutes.use('*', authMiddleware);

// Whole group is dark unless the add-in app registration is configured.
// Secondary defense-in-depth: a partner whose AI for Office entitlement is
// disabled cannot reach the admin config surface. System callers (no partnerId)
// are not partner-scoped and pass this layer unconditionally.
clientAiAdminRoutes.use('*', async (c, next) => {
  if (!CLIENT_AI_ENTRA_CLIENT_ID) {
    return c.json({ error: 'Breeze AI for Office is not enabled' }, 404);
  }
  const auth = c.get('auth');
  if (auth?.partnerId) {
    const [partner] = await db
      .select({ aiForOfficeEnabled: partners.aiForOfficeEnabled })
      .from(partners)
      .where(eq(partners.id, auth.partnerId))
      .limit(1);
    if (!partner?.aiForOfficeEnabled) {
      return c.json({ error: 'Breeze AI for Office is not enabled' }, 404);
    }
  }
  await next();
});

function toMappingResponse(row: typeof clientAiTenantMappings.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    entraTenantId: row.entraTenantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Tenant mapping ────────────────────────────────────────────────────────────

clientAiAdminRoutes.get('/orgs/:orgId/tenant-mapping', requireOrgsRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));
  if (!orgId) return c.json({ error: 'Organization not found' }, 404);

  const [row] = await db
    .select()
    .from(clientAiTenantMappings)
    .where(eq(clientAiTenantMappings.orgId, orgId))
    .limit(1);

  return c.json({ mapping: row ? toMappingResponse(row) : null });
});

clientAiAdminRoutes.put(
  '/orgs/:orgId/tenant-mapping',
  requireOrgsWrite,
  requireMfa(),
  zValidator('json', putTenantMappingSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));
    if (!orgId) return c.json({ error: 'Organization not found' }, 404);

    const { entraTenantId } = c.req.valid('json');
    const now = new Date();

    let row: typeof clientAiTenantMappings.$inferSelect | undefined;
    try {
      [row] = await db
        .insert(clientAiTenantMappings)
        .values({
          orgId,
          entraTenantId: entraTenantId.toLowerCase(),
          createdBy: auth.user?.id ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: clientAiTenantMappings.orgId,
          set: { entraTenantId: entraTenantId.toLowerCase(), updatedAt: now },
        })
        .returning();
    } catch (err) {
      // client_ai_tenant_mappings_tenant_uniq: the tenant is already mapped to
      // a DIFFERENT org. Deliberately opaque — do not reveal which org.
      if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
        return c.json({ error: 'tenant_already_mapped' }, 409);
      }
      throw err;
    }

    if (!row) return c.json({ error: 'Failed to save tenant mapping' }, 500);

    writeRouteAudit(c, {
      orgId,
      action: 'client_ai.tenant_mapping.upsert',
      resourceType: 'client_ai_tenant_mapping',
      resourceId: row.id,
      resourceName: row.entraTenantId,
      details: { entraTenantId: row.entraTenantId },
    });

    return c.json({ mapping: toMappingResponse(row) });
  }
);

clientAiAdminRoutes.delete(
  '/orgs/:orgId/tenant-mapping',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));
    if (!orgId) return c.json({ error: 'Organization not found' }, 404);

    const [row] = await db
      .delete(clientAiTenantMappings)
      .where(eq(clientAiTenantMappings.orgId, orgId))
      .returning();

    if (row) {
      writeRouteAudit(c, {
        orgId,
        action: 'client_ai.tenant_mapping.delete',
        resourceType: 'client_ai_tenant_mapping',
        resourceId: row.id,
        resourceName: row.entraTenantId,
      });
    }

    return c.json({ mapping: null });
  }
);

// ── Policy ────────────────────────────────────────────────────────────────────

clientAiAdminRoutes.get('/orgs/:orgId/policy', requireOrgsRead, async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));
  if (!orgId) return c.json({ error: 'Organization not found' }, 404);

  const policy = await getOrgPolicy(orgId);
  return c.json({ policy });
});

clientAiAdminRoutes.put(
  '/orgs/:orgId/policy',
  requireOrgsWrite,
  zValidator('json', putPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));
    if (!orgId) return c.json({ error: 'Organization not found' }, 404);

    const body = c.req.valid('json');
    const now = new Date();

    // Only persist the knobs the caller provided; DB defaults fill the rest on
    // first insert, existing values survive on update.
    const set: Partial<typeof clientAiOrgPolicies.$inferInsert> = { updatedAt: now };
    if (body.enabled !== undefined) set.enabled = body.enabled;
    if (body.userAccess !== undefined) set.userAccess = body.userAccess;
    if (body.selectedUserIds !== undefined) set.selectedUserIds = body.selectedUserIds;
    if (body.allowedProviders !== undefined) set.allowedProviders = body.allowedProviders;
    if (body.allowedModels !== undefined) set.allowedModels = body.allowedModels;
    if (body.writeMode !== undefined) set.writeMode = body.writeMode;
    if (body.writeApproval !== undefined) set.writeApproval = body.writeApproval;
    if (body.dlpConfig !== undefined) set.dlpConfig = body.dlpConfig;
    if (body.dailyBudgetCents !== undefined) set.dailyBudgetCents = body.dailyBudgetCents;
    if (body.monthlyBudgetCents !== undefined) set.monthlyBudgetCents = body.monthlyBudgetCents;
    if (body.perUserMessagesPerMinute !== undefined)
      set.perUserMessagesPerMinute = body.perUserMessagesPerMinute;
    if (body.orgMessagesPerHour !== undefined) set.orgMessagesPerHour = body.orgMessagesPerHour;
    if (body.retentionDays !== undefined) set.retentionDays = body.retentionDays;
    if (body.branding !== undefined) set.branding = body.branding;

    await db
      .insert(clientAiOrgPolicies)
      .values({ orgId, ...set })
      .onConflictDoUpdate({ target: clientAiOrgPolicies.orgId, set })
      .returning();

    const changedKeys = Object.keys(set).filter((k) => k !== 'updatedAt');
    writeRouteAudit(c, {
      orgId,
      action: 'client_ai.policy.update',
      resourceType: 'client_ai_org_policy',
      details: { changedKeys },
    });

    const policy = await getOrgPolicy(orgId);
    return c.json({ policy });
  }
);

// ── Plan-4 dashboard sub-routers (inherit group auth + dark-gate above) ──────
clientAiAdminRoutes.route('/', clientAiAdminOrgRoutes);
clientAiAdminRoutes.route('/', clientAiAdminSessionRoutes);
clientAiAdminRoutes.route('/', clientAiAdminUsageRoutes);
clientAiAdminRoutes.route('/', clientAiAdminTemplateRoutes);
