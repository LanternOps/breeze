import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { exitCodeSeverityMappingSchema } from '@breeze/shared';
import { and, eq, sql, desc, like, inArray, or, isNull } from 'drizzle-orm';
import { escapeLike } from '../utils/sql';
import { db } from '../db';
import {
  scripts,
  scriptExecutions,
  devices,
  deviceCommands,
  automationPolicies,
  patchPolicies,
  configPolicyComplianceRules,
  configPolicyFeatureLinks,
  configurationPolicies
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { executeScriptOnDevices } from '../services/scriptExecution';

export const scriptRoutes = new Hono();

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function ensureOrgAccess(orgId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  return auth.canAccessOrg(orgId);
}

async function getScriptWithOrgCheck(scriptId: string, auth: { canAccessOrg: (orgId: string) => boolean }) {
  const [script] = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.id, scriptId), isNull(scripts.deletedAt)))
    .limit(1);

  if (!script) {
    return null;
  }

  // System scripts are accessible to all
  if (script.isSystem) {
    return script;
  }

  // Check org access for non-system scripts
  if (script.orgId) {
    const hasAccess = ensureOrgAccess(script.orgId, auth);
    if (!hasAccess) {
      return null;
    }
  }

  return script;
}

function resolveScriptAuditOrgId(
  auth: { orgId: string | null },
  scriptOrgId?: string | null,
  deviceOrgId?: string | null
): string | null {
  return scriptOrgId ?? deviceOrgId ?? auth.orgId ?? null;
}

type RescopeAuth = {
  scope: string;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
};

type RescopeTarget = { orgId: string | null; partnerId: string | null };
type RescopeError = { error: string; status: 400 | 403 };

function isRescopeError(r: RescopeTarget | RescopeError): r is RescopeError {
  return 'error' in r;
}

/**
 * Resolve the requested target scope for a script re-scope on edit (issue
 * #1734). Returns the `{ orgId, partnerId }` to persist, or a typed error.
 *
 * Tenancy rules (mirror the create path at the POST handler):
 * - Only partner-scope callers may re-scope. Org-scope callers can't move a
 *   script across orgs or promote it partner-wide — they may only edit their
 *   own org's scripts in place, so re-scope fields are rejected (403).
 * - `availability: 'partner'` → partner-wide ("All Orgs"): org_id NULL,
 *   partner_id = caller's partner. Never `is_system` (that stays seed-only).
 * - `availability: 'org'` → a single org the caller can access; denied
 *   otherwise. partner_id stays denormalized for RLS.
 * The RLS UPDATE WITH CHECK (`breeze_has_org_access(org_id) OR
 * breeze_has_partner_access(partner_id)`) is the backstop — a forged target
 * the caller can't reach fails there with no row written.
 */
function resolveRescopeTarget(
  auth: RescopeAuth,
  availability: 'org' | 'partner',
  requestedOrgId: string | null | undefined,
  currentScope: { orgId: string | null; partnerId: string | null }
): RescopeTarget | RescopeError {
  if (auth.scope !== 'partner') {
    return { error: 'Only partner-scope users can change a script\'s scope', status: 403 };
  }
  const partnerId = auth.partnerId;
  if (!partnerId) {
    return { error: 'Partner context required', status: 403 };
  }
  // The script must already belong to this partner — never re-scope a row
  // from another partner or a system row through this path.
  if (currentScope.partnerId !== partnerId) {
    return { error: 'This script is not owned by your partner and cannot be re-scoped', status: 403 };
  }

  if (availability === 'partner') {
    return { orgId: null, partnerId };
  }

  // availability === 'org': a single specific org the caller can access.
  if (!requestedOrgId) {
    return { error: 'orgId is required to scope a script to a specific organization', status: 400 };
  }
  if (!auth.canAccessOrg(requestedOrgId)) {
    return { error: 'Access to this organization denied', status: 403 };
  }
  return { orgId: requestedOrgId, partnerId };
}

function getAllowedSiteIds(c: { get: (key: string) => unknown }): string[] | undefined {
  return (c.get('permissions') as UserPermissions | undefined)?.allowedSiteIds;
}

function canAccessDeviceSite(siteId: string | null | undefined, userPerms: UserPermissions | undefined): boolean {
  if (!userPerms?.allowedSiteIds) return true;
  return typeof siteId === 'string' && canAccessSite(userPerms, siteId);
}

// Validation schemas
const listScriptsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().guid().optional(),
  category: z.string().optional(),
  osType: z.enum(['windows', 'macos', 'linux']).optional(),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
  search: z.string().optional(),
  includeSystem: z.string().optional() // 'true' to include system scripts
});

// Feature #3 (severity-by-exit-code): the wire-format schema for the
// exit-code → AlertSeverity map. Defined in @breeze/shared so the UI form,
// the route handler, and tests all import the same shape. Runtime severity
// derivation lives in services/scriptSeverity.ts.

const createScriptSchema = z.object({
  orgId: z.string().guid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  category: z.string().max(100).optional(),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).min(1),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']),
  content: z.string().min(1),
  parameters: z.any().optional(),
  // Max 3600: the agent executor clamps script timeouts to 1 hour
  // (agent/internal/remote/executor/executor.go MaxTimeout) — accepting more
  // at intake is silent false configurability (#2398).
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  runAs: z.enum(['system', 'user', 'elevated']).default('system'),
  isSystem: z.boolean().optional(),
  exitCodeSeverityMapping: exitCodeSeverityMappingSchema.nullable().optional(),
  availability: z.enum(['org', 'partner']).optional()
});

const updateScriptSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  category: z.string().max(100).optional(),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).min(1).optional(),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
  content: z.string().min(1).optional(),
  parameters: z.any().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  runAs: z.enum(['system', 'user', 'elevated']).optional(),
  exitCodeSeverityMapping: exitCodeSeverityMappingSchema.nullable().optional(),
  // Re-scope on edit (issue #1734). Mirrors the create-time "Available to"
  // control: 'org' = a single specific org, 'partner' = partner-wide ("All
  // Orgs"). When `availability` is present the PUT handler re-scopes the row.
  // `isSystem` is intentionally NOT accepted here — promotion to a global
  // system row stays system-scope-seed-only (the Discussion #633 write hole).
  availability: z.enum(['org', 'partner']).optional(),
  orgId: z.string().guid().nullable().optional()
});

const executeScriptSchema = z.object({
  deviceIds: z.array(z.string().guid()).min(1),
  parameters: z.record(z.string(), z.any()).refine(
    (val) => JSON.stringify(val).length <= 65536,
    { message: 'Object too large (max 64KB)' }
  ).optional(),
  triggerType: z.enum(['manual', 'scheduled', 'alert', 'policy']).optional(),
  runAs: z.enum(['system', 'user']).optional()
});

const listExecutionsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['pending', 'queued', 'running', 'completed', 'failed', 'timeout', 'cancelled']).optional(),
  deviceId: z.string().guid().optional()
});

const scriptIdParamSchema = z.object({ id: z.string().guid() });

// Apply auth middleware to all routes
scriptRoutes.use('*', authMiddleware);

// GET /scripts - List scripts with filters
scriptRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_READ.resource, PERMISSIONS.SCRIPTS_READ.action),
  zValidator('query', listScriptsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Exclude soft-deleted scripts
    conditions.push(isNull(scripts.deletedAt) as ReturnType<typeof eq>);

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      // Include org scripts, partner-wide scripts, and (optionally) system scripts
      const ors = [eq(scripts.orgId, auth.orgId)];
      if (auth.partnerId) ors.push(eq(scripts.partnerId, auth.partnerId));
      if (query.includeSystem === 'true') ors.push(eq(scripts.isSystem, true));
      conditions.push(or(...ors) as ReturnType<typeof eq>);
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        const ors = [eq(scripts.orgId, query.orgId)];
        if (auth.partnerId) ors.push(eq(scripts.partnerId, auth.partnerId));
        if (query.includeSystem === 'true') ors.push(eq(scripts.isSystem, true));
        conditions.push(or(...ors) as ReturnType<typeof eq>);
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        const ors: ReturnType<typeof eq>[] = [];
        if (orgIds.length > 0) ors.push(inArray(scripts.orgId, orgIds) as ReturnType<typeof eq>);
        if (auth.partnerId) ors.push(eq(scripts.partnerId, auth.partnerId) as ReturnType<typeof eq>);
        if (query.includeSystem === 'true') ors.push(eq(scripts.isSystem, true) as ReturnType<typeof eq>);
        if (ors.length === 0) return c.json({ data: [], pagination: { page, limit, total: 0 } });
        conditions.push(or(...ors) as ReturnType<typeof eq>);
      }
    } else if (auth.scope === 'system') {
      if (query.orgId) {
        conditions.push(eq(scripts.orgId, query.orgId));
      }
      // System scope sees everything, no additional filter needed
    }

    // Additional filters
    if (query.category) {
      conditions.push(eq(scripts.category, query.category));
    }

    if (query.language) {
      conditions.push(eq(scripts.language, query.language));
    }

    if (query.osType) {
      // Check if osType is in the osTypes array
      conditions.push(sql`${sql.param(query.osType)} = ANY(${scripts.osTypes})` as ReturnType<typeof eq>);
    }

    if (query.search) {
      conditions.push(
        or(
          like(scripts.name, `%${escapeLike(query.search)}%`),
          like(scripts.description, `%${escapeLike(query.search)}%`)
        ) as ReturnType<typeof eq>
      );
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(scripts)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get scripts
    const scriptList = await db
      .select()
      .from(scripts)
      .where(whereCondition)
      .orderBy(desc(scripts.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: scriptList,
      pagination: { page, limit, total }
    });
  }
);

// GET /scripts/system-library - List system scripts available to import
scriptRoutes.get(
  '/system-library',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_READ.resource, PERMISSIONS.SCRIPTS_READ.action),
  async (c) => {
    const systemScripts = await db
      .select({
        id: scripts.id,
        name: scripts.name,
        description: scripts.description,
        category: scripts.category,
        osTypes: scripts.osTypes,
        language: scripts.language,
      })
      .from(scripts)
      .where(and(eq(scripts.isSystem, true), isNull(scripts.deletedAt)))
      .orderBy(scripts.category, scripts.name);

    return c.json({ data: systemScripts });
  }
);

// POST /scripts/import/:id - Clone a system script into the caller's org
scriptRoutes.post(
  '/import/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requireMfa(),
  zValidator('param', scriptIdParamSchema),
  zValidator('json', z.object({ orgId: z.string().guid().optional() })),
  async (c) => {
    const auth = c.get('auth');
    const { id: sourceId } = c.req.valid('param');
    const body = c.req.valid('json');

    // Fetch the system script
    const [source] = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.id, sourceId), eq(scripts.isSystem, true), isNull(scripts.deletedAt)))
      .limit(1);

    if (!source) {
      return c.json({ error: 'System script not found' }, 404);
    }

    // Determine target orgId
    let orgId: string | null = null;
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (body.orgId) {
        const hasAccess = ensureOrgAccess(body.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgId = body.orgId;
      } else if (auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
        const onlyOrgId = auth.accessibleOrgIds[0];
        if (onlyOrgId) {
          orgId = onlyOrgId;
        }
      } else {
        return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
      }
    } else if (auth.scope === 'system') {
      orgId = body.orgId ?? null;
    }

    if (!orgId) {
      return c.json({ error: 'Target organization required' }, 400);
    }

    // Check if already imported (same name + org)
    const [existing] = await db
      .select({ id: scripts.id })
      .from(scripts)
      .where(and(eq(scripts.orgId, orgId), eq(scripts.name, source.name), isNull(scripts.deletedAt)))
      .limit(1);

    if (existing) {
      return c.json({ error: 'A script with this name already exists in your organization' }, 409);
    }

    // Clone into the org
    const [cloned] = await db
      .insert(scripts)
      .values({
        orgId,
        name: source.name,
        description: source.description,
        category: source.category,
        osTypes: source.osTypes,
        language: source.language,
        content: source.content,
        parameters: source.parameters,
        timeoutSeconds: source.timeoutSeconds,
        runAs: source.runAs,
        isSystem: false,
        version: 1,
        createdBy: auth.user.id,
      })
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'script.import',
      resourceType: 'script',
      resourceId: cloned?.id,
      resourceName: cloned?.name,
      details: {
        sourceScriptId: sourceId,
        sourceScriptName: source.name
      }
    });

    return c.json(cloned, 201);
  }
);

// GET /scripts/:id - Get single script by ID
scriptRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_READ.resource, PERMISSIONS.SCRIPTS_READ.action),
  zValidator('param', scriptIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: scriptId } = c.req.valid('param');

    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) {
      return c.json({ error: 'Script not found' }, 404);
    }

    return c.json(script);
  }
);

// POST /scripts - Create new script
scriptRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requireMfa(),
  zValidator('json', createScriptSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId and partnerId
    let orgId: string | null = data.orgId ?? null;
    let partnerId: string | null = null;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
      partnerId = auth.partnerId ?? null; // denormalized for RLS
    } else if (auth.scope === 'partner') {
      if (data.availability === 'partner') {
        orgId = null;
        partnerId = auth.partnerId ?? null;
        if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
      } else {
        if (!orgId) {
          const singleOrg = auth.accessibleOrgIds?.[0];
          if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
            orgId = singleOrg;
          } else {
            return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
          }
        }
        if (!ensureOrgAccess(orgId!, auth)) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        partnerId = auth.partnerId ?? null;
      }
    }
    // System scope can create system scripts without orgId or specify any orgId

    // Only system scope can create system scripts
    const isSystem = auth.scope === 'system' ? (data.isSystem ?? false) : false;

    const [script] = await db
      .insert(scripts)
      .values({
        orgId: isSystem && !orgId ? null : orgId,
        partnerId,
        name: data.name,
        description: data.description,
        category: data.category,
        osTypes: data.osTypes,
        language: data.language,
        content: data.content,
        parameters: data.parameters,
        timeoutSeconds: data.timeoutSeconds,
        runAs: data.runAs,
        isSystem,
        version: 1,
        exitCodeSeverityMapping: data.exitCodeSeverityMapping ?? null,
        createdBy: auth.user.id
      })
      .returning();

    writeRouteAudit(c, {
      orgId: resolveScriptAuditOrgId(auth, script?.orgId ?? null),
      action: 'script.create',
      resourceType: 'script',
      resourceId: script?.id,
      resourceName: script?.name,
      details: {
        osTypes: script?.osTypes,
        language: script?.language,
        isSystem: script?.isSystem
      }
    });

    return c.json(script, 201);
  }
);

// PUT /scripts/:id - Update script (increment version on content change)
scriptRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action),
  requireMfa(),
  zValidator('param', scriptIdParamSchema),
  zValidator('json', updateScriptSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: scriptId } = c.req.valid('param');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) {
      return c.json({ error: 'Script not found' }, 404);
    }

    // Partner-wide records belong to the MSP: only partner/system scope may edit.
    if (script.orgId === null && script.partnerId !== null && auth.scope === 'organization') {
      return c.json({ error: 'This script is shared across your organization and is read-only here' }, 403);
    }
    // Cannot edit system scripts unless system scope
    if (script.isSystem && auth.scope !== 'system') {
      return c.json({ error: 'System scripts are read-only' }, 403);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    // Re-scope on edit (issue #1734). Only applied when `availability` is sent;
    // a plain content/metadata edit never touches org/partner. System scripts
    // never get re-scoped here (the system read-only guard above already 403s
    // non-system callers, and `availability` is the only path that writes
    // org/partner — `isSystem` is not accepted by the schema, so the #633 hole
    // stays closed).
    if (data.availability !== undefined) {
      const target = resolveRescopeTarget(
        auth,
        data.availability,
        data.orgId,
        { orgId: script.orgId, partnerId: script.partnerId }
      );
      if (isRescopeError(target)) {
        return c.json({ error: target.error }, target.status);
      }

      const scopeChanged = target.orgId !== script.orgId;
      if (scopeChanged) {
        // Narrowing = the script stops covering an org it covered before
        // (partner-wide → one org, or org A → org B). Block while live policy
        // references exist so we never leave a dangling cross-org reference
        // (issue #1734 open question — block, don't silently detach/cascade).
        const widening = target.orgId === null; // → partner-wide covers all orgs
        if (!widening) {
          // These counts run on the caller's request RLS context. The caller is
          // always partner-scope here (resolveRescopeTarget enforces it), and
          // all three reference tables resolve to a direct `org_id` (RLS shape
          // 1) reachable via the partner short-circuit in breeze_has_org_access
          // — so the partner sees references across ALL their orgs and the count
          // can't silently under-report for the partner's own rows. A future
          // RLS change on these tables would weaken this guard; keep them
          // partner-visible. These cover every non-self-healing `scripts.id` FK
          // (remediation_suggestions is onDelete:set null, so it self-heals).
          const [autoRef] = await db
            .select({ count: sql<number>`count(*)` })
            .from(automationPolicies)
            .where(eq(automationPolicies.remediationScriptId, scriptId));
          const [patchRef] = await db
            .select({ count: sql<number>`count(*)` })
            .from(patchPolicies)
            .where(
              or(
                eq(patchPolicies.preInstallScript, scriptId),
                eq(patchPolicies.postInstallScript, scriptId)
              )
            );
          // config_policy_compliance_rules has no direct org_id — join through
          // its feature link to the parent configuration_policies (org_id) so
          // the count is RLS-scoped to the partner's orgs.
          const [complianceRef] = await db
            .select({ count: sql<number>`count(*)` })
            .from(configPolicyComplianceRules)
            .innerJoin(
              configPolicyFeatureLinks,
              eq(configPolicyComplianceRules.featureLinkId, configPolicyFeatureLinks.id)
            )
            .innerJoin(
              configurationPolicies,
              eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id)
            )
            .where(eq(configPolicyComplianceRules.remediationScriptId, scriptId));
          const referenceCount =
            Number(autoRef?.count ?? 0) +
            Number(patchRef?.count ?? 0) +
            Number(complianceRef?.count ?? 0);
          if (referenceCount > 0) {
            return c.json(
              {
                error:
                  'Cannot narrow this script\'s scope while it is referenced by automation, patch, or configuration policies. Detach those references first, or promote it to All Orgs instead.',
                referencingPolicies: referenceCount
              },
              409
            );
          }
        }
      }

      updates.orgId = target.orgId;
      updates.partnerId = target.partnerId;
    }

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.category !== undefined) updates.category = data.category;
    if (data.osTypes !== undefined) updates.osTypes = data.osTypes;
    if (data.language !== undefined) updates.language = data.language;
    if (data.parameters !== undefined) updates.parameters = data.parameters;
    if (data.timeoutSeconds !== undefined) updates.timeoutSeconds = data.timeoutSeconds;
    if (data.runAs !== undefined) updates.runAs = data.runAs;
    if (data.exitCodeSeverityMapping !== undefined) updates.exitCodeSeverityMapping = data.exitCodeSeverityMapping;

    // Increment version if content changes
    if (data.content !== undefined && data.content !== script.content) {
      updates.content = data.content;
      updates.version = script.version + 1;
    }

    const [updated] = await db
      .update(scripts)
      .set(updates)
      .where(eq(scripts.id, scriptId))
      .returning();

    // The row was read+authorized above, but RLS (USING) or a concurrent
    // soft-delete can still leave the UPDATE matching 0 rows. Without this
    // guard the handler would write a fabricated `script.update` audit (a
    // scopeChange to null/null that never happened) and return HTTP 200 with a
    // null body, which the web layer toasts as success — a silent failure.
    if (!updated) {
      return c.json({ error: 'Script not found or no longer writable' }, 404);
    }

    writeRouteAudit(c, {
      orgId: resolveScriptAuditOrgId(auth, script.orgId),
      action: 'script.update',
      resourceType: 'script',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        changedFields: Object.keys(data),
        newVersion: updated.version,
        // Forensic trail for scope changes (issue #1734): record the old and
        // new scope so a re-scope is auditable.
        ...(data.availability !== undefined
          ? {
              scopeChange: {
                from: { orgId: script.orgId, partnerId: script.partnerId },
                to: { orgId: updated.orgId ?? null, partnerId: updated.partnerId ?? null }
              }
            }
          : {})
      }
    });

    return c.json(updated);
  }
);

// DELETE /scripts/:id - Soft delete (check for active executions first)
scriptRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_DELETE.resource, PERMISSIONS.SCRIPTS_DELETE.action),
  requireMfa(),
  zValidator('param', scriptIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: scriptId } = c.req.valid('param');

    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) {
      return c.json({ error: 'Script not found' }, 404);
    }

    // Partner-wide records belong to the MSP: only partner/system scope may delete.
    if (script.orgId === null && script.partnerId !== null && auth.scope === 'organization') {
      return c.json({ error: 'This script is shared across your organization and is read-only here' }, 403);
    }
    // Cannot delete system scripts unless system scope
    if (script.isSystem && auth.scope !== 'system') {
      return c.json({ error: 'System scripts are read-only' }, 403);
    }

    // Check for active executions
    const activeStatuses = ['pending', 'queued', 'running'] as const;
    const activeExecutions = await db
      .select({ count: sql<number>`count(*)` })
      .from(scriptExecutions)
      .where(
        and(
          eq(scriptExecutions.scriptId, scriptId),
          inArray(scriptExecutions.status, [...activeStatuses])
        )
      );

    const activeCount = Number(activeExecutions[0]?.count ?? 0);
    if (activeCount > 0) {
      return c.json({
        error: 'Cannot delete script with active executions',
        activeExecutions: activeCount
      }, 409);
    }

    // Soft delete: a hard `DELETE` throws an FK violation once the script has
    // any execution history (script_executions / batches reference it), so we
    // stamp deletedAt instead. Script listing/lookup paths filter
    // `deletedAt IS NULL` to hide it; execution-history joins intentionally do
    // not, so past runs still show the script name. The `isNull` guard in the
    // WHERE makes a concurrent re-delete a genuine no-op the row-count catches.
    const [deleted] = await db
      .update(scripts)
      .set({ deletedAt: new Date() })
      .where(and(eq(scripts.id, scriptId), isNull(scripts.deletedAt)))
      .returning({ id: scripts.id });

    if (!deleted) {
      // Lost a race with a concurrent delete; surface it instead of a false success.
      return c.json({ error: 'Script not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: resolveScriptAuditOrgId(auth, script.orgId),
      action: 'script.delete',
      resourceType: 'script',
      resourceId: script.id,
      resourceName: script.name
    });

    return c.json({ success: true });
  }
);

// POST /scripts/:id/execute - Execute script on specific devices
scriptRoutes.post(
  '/:id/execute',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  requireMfa(),
  zValidator('param', scriptIdParamSchema),
  zValidator('json', executeScriptSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: scriptId } = c.req.valid('param');
    const data = c.req.valid('json');

    const result = await executeScriptOnDevices({
      scriptId,
      deviceIds: data.deviceIds,
      parameters: data.parameters,
      triggerType: data.triggerType,
      runAs: data.runAs,
      auth,
      permissions: c.get('permissions') as UserPermissions | undefined,
    });

    if (!result.ok) {
      return c.json({
        error: result.error,
        maintenanceSuppressedDeviceIds: result.maintenanceSuppressedDeviceIds,
      }, result.status);
    }

    writeRouteAudit(c, {
      orgId: result.auditOrgId,
      action: 'script.execute',
      resourceType: 'script',
      resourceId: result.script.id,
      resourceName: result.script.name,
      details: {
        batchId: result.batchId,
        devicesTargeted: result.devicesTargeted,
        maintenanceSuppressedDeviceIds: result.maintenanceSuppressedDeviceIds,
        triggerType: result.triggerType,
        runAs: result.runAs,
      }
    });

    return c.json({
      batchId: result.batchId,
      scriptId,
      devicesTargeted: result.devicesTargeted,
      maintenanceSuppressedDeviceIds: result.maintenanceSuppressedDeviceIds.length > 0
        ? result.maintenanceSuppressedDeviceIds
        : undefined,
      executions: result.executions,
      status: result.status,
    }, 201);
  }
);

// GET /scripts/:id/executions - List executions for a script
scriptRoutes.get(
  '/:id/executions',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_READ.resource, PERMISSIONS.SCRIPTS_READ.action),
  zValidator('param', scriptIdParamSchema),
  zValidator('query', listExecutionsSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: scriptId } = c.req.valid('param');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const script = await getScriptWithOrgCheck(scriptId, auth);
    if (!script) {
      return c.json({ error: 'Script not found' }, 404);
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [eq(scriptExecutions.scriptId, scriptId)];

    if (query.status) {
      conditions.push(eq(scriptExecutions.status, query.status));
    }

    if (query.deviceId) {
      conditions.push(eq(scriptExecutions.deviceId, query.deviceId));
    }

    const whereCondition = and(...conditions);
    const allowedSiteIds = getAllowedSiteIds(c);

    if (allowedSiteIds?.length === 0) {
      return c.json({
        data: [],
        pagination: { page, limit, total: 0 }
      });
    }

    const siteRestrictedWhereCondition = allowedSiteIds
      ? and(whereCondition, inArray(devices.siteId, allowedSiteIds))
      : whereCondition;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(scriptExecutions)
      .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
      .where(siteRestrictedWhereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get executions with device info
    const executionList = await db
      .select({
        id: scriptExecutions.id,
        scriptId: scriptExecutions.scriptId,
        deviceId: scriptExecutions.deviceId,
        triggeredBy: scriptExecutions.triggeredBy,
        triggerType: scriptExecutions.triggerType,
        parameters: scriptExecutions.parameters,
        status: scriptExecutions.status,
        startedAt: scriptExecutions.startedAt,
        completedAt: scriptExecutions.completedAt,
        exitCode: scriptExecutions.exitCode,
        errorMessage: scriptExecutions.errorMessage,
        createdAt: scriptExecutions.createdAt,
        deviceHostname: devices.hostname,
        deviceOsType: devices.osType
      })
      .from(scriptExecutions)
      .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
      .where(siteRestrictedWhereCondition)
      .orderBy(desc(scriptExecutions.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: executionList,
      pagination: { page, limit, total }
    });
  }
);

// GET /executions/:id - Get execution details with stdout/stderr
scriptRoutes.get(
  '/executions/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_READ.resource, PERMISSIONS.SCRIPTS_READ.action),
  zValidator('param', scriptIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: executionId } = c.req.valid('param');

    // Get execution with script and device info
    const [execution] = await db
      .select({
        id: scriptExecutions.id,
        scriptId: scriptExecutions.scriptId,
        deviceId: scriptExecutions.deviceId,
        triggeredBy: scriptExecutions.triggeredBy,
        triggerType: scriptExecutions.triggerType,
        parameters: scriptExecutions.parameters,
        status: scriptExecutions.status,
        startedAt: scriptExecutions.startedAt,
        completedAt: scriptExecutions.completedAt,
        exitCode: scriptExecutions.exitCode,
        stdout: scriptExecutions.stdout,
        stderr: scriptExecutions.stderr,
        errorMessage: scriptExecutions.errorMessage,
        createdAt: scriptExecutions.createdAt,
        scriptName: scripts.name,
        scriptLanguage: scripts.language,
        deviceHostname: devices.hostname,
        deviceOsType: devices.osType,
        deviceOrgId: devices.orgId,
        deviceSiteId: devices.siteId
      })
      .from(scriptExecutions)
      .leftJoin(scripts, eq(scriptExecutions.scriptId, scripts.id))
      .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
      .where(eq(scriptExecutions.id, executionId))
      .limit(1);

    if (!execution) {
      return c.json({ error: 'Execution not found' }, 404);
    }

    // Check access to the device's org
    if (execution.deviceOrgId) {
      const hasAccess = ensureOrgAccess(execution.deviceOrgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }
    if (!canAccessDeviceSite(execution.deviceSiteId, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    return c.json(execution);
  }
);

// POST /executions/:id/cancel - Cancel pending/running execution
scriptRoutes.post(
  '/executions/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action),
  requireMfa(),
  zValidator('param', scriptIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: executionId } = c.req.valid('param');

    // Get execution
    const [execution] = await db
      .select({
        id: scriptExecutions.id,
        status: scriptExecutions.status,
        deviceId: scriptExecutions.deviceId,
        deviceOrgId: devices.orgId,
        deviceSiteId: devices.siteId
      })
      .from(scriptExecutions)
      .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
      .where(eq(scriptExecutions.id, executionId))
      .limit(1);

    if (!execution) {
      return c.json({ error: 'Execution not found' }, 404);
    }

    // Check access
    if (execution.deviceOrgId) {
      const hasAccess = ensureOrgAccess(execution.deviceOrgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }
    if (!canAccessDeviceSite(execution.deviceSiteId, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    // Can only cancel pending, queued, or running executions
    const cancelableStatuses = ['pending', 'queued', 'running'];
    if (!cancelableStatuses.includes(execution.status)) {
      return c.json({
        error: 'Cannot cancel execution with status: ' + execution.status
      }, 400);
    }

    // Update execution status to cancelled
    const [updated] = await db
      .update(scriptExecutions)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        errorMessage: `Cancelled by user ${auth.user.email}`
      })
      .where(eq(scriptExecutions.id, executionId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to cancel execution' }, 500);
    }

    // Also cancel any pending device commands for this execution
    await db
      .update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        result: { cancelled: true, cancelledBy: auth.user.id }
      })
      .where(
        and(
          eq(deviceCommands.deviceId, execution.deviceId),
          eq(deviceCommands.status, 'pending'),
          sql`${deviceCommands.payload}->>'executionId' = ${executionId}`
        )
      );

    writeRouteAudit(c, {
      orgId: resolveScriptAuditOrgId(auth, null, execution.deviceOrgId ?? null),
      action: 'script.execution.cancel',
      resourceType: 'script_execution',
      resourceId: updated.id,
      details: {
        scriptExecutionId: executionId,
        deviceId: execution.deviceId,
        previousStatus: execution.status
      }
    });

    return c.json({
      success: true,
      execution: {
        id: updated.id,
        status: updated.status,
        completedAt: updated.completedAt
      }
    });
  }
);
