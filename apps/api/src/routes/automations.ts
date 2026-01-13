import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  automations,
  automationRuns,
  policies,
  policyCompliance,
  organizations,
  devices,
  scripts
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const automationRoutes = new Hono();

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

async function getAutomationWithOrgCheck(automationId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [automation] = await db
    .select()
    .from(automations)
    .where(eq(automations.id, automationId))
    .limit(1);

  if (!automation) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(automation.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return automation;
}

async function getPolicyWithOrgCheck(policyId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.id, policyId))
    .limit(1);

  if (!policy) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(policy.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return policy;
}

// Validation schemas

// Automations schemas
const listAutomationsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enabled: z.enum(['true', 'false']).optional()
});

const createAutomationSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  trigger: z.any(), // JSONB for trigger configuration
  conditions: z.any().optional(), // JSONB for conditions
  actions: z.any(), // JSONB for actions
  onFailure: z.enum(['stop', 'continue', 'notify']).default('stop'),
  notificationTargets: z.any().optional() // JSONB for notification targets
});

const updateAutomationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  trigger: z.any().optional(),
  conditions: z.any().optional(),
  actions: z.any().optional(),
  onFailure: z.enum(['stop', 'continue', 'notify']).optional(),
  notificationTargets: z.any().optional()
});

// Policies schemas
const listPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
  enabled: z.enum(['true', 'false']).optional()
});

const createPolicySchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  targets: z.any(), // JSONB for target configuration
  rules: z.any(), // JSONB for rules
  enforcement: z.enum(['monitor', 'warn', 'enforce']).default('monitor'),
  checkIntervalMinutes: z.number().int().min(5).max(10080).default(60), // 5 min to 1 week
  remediationScriptId: z.string().uuid().optional()
});

const updatePolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  targets: z.any().optional(),
  rules: z.any().optional(),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
  checkIntervalMinutes: z.number().int().min(5).max(10080).optional(),
  remediationScriptId: z.string().uuid().nullable().optional()
});

const listComplianceSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['compliant', 'non_compliant', 'pending', 'error']).optional()
});

// Apply auth middleware to all routes
automationRoutes.use('*', authMiddleware);

// ============================================
// AUTOMATIONS ENDPOINTS
// ============================================

// GET /automations - List automations with pagination
automationRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listAutomationsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(automations.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(automations.orgId, query.orgId));
      } else {
        // Get automations from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(automations.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(automations.orgId, query.orgId));
    }

    // Additional filters
    if (query.enabled !== undefined) {
      conditions.push(eq(automations.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automations)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get automations
    const automationsList = await db
      .select()
      .from(automations)
      .where(whereCondition)
      .orderBy(desc(automations.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: automationsList,
      pagination: { page, limit, total }
    });
  }
);

// GET /automations/runs/:runId - Get specific run details (must be before /:id to avoid conflict)
automationRoutes.get(
  '/runs/:runId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const runId = c.req.param('runId');

    // Get the run
    const [run] = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))
      .limit(1);

    if (!run) {
      return c.json({ error: 'Automation run not found' }, 404);
    }

    // Verify access to parent automation
    const automation = await getAutomationWithOrgCheck(run.automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation run not found' }, 404);
    }

    return c.json({
      ...run,
      automation: {
        id: automation.id,
        name: automation.name,
        orgId: automation.orgId
      }
    });
  }
);

// GET /automations/:id - Get single automation with run history
automationRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');

    // Skip if this is a route like /automations/runs or /automations/policies
    if (['runs', 'policies'].includes(automationId)) {
      return c.notFound();
    }

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    // Get recent run history
    const recentRuns = await db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(desc(automationRuns.startedAt))
      .limit(10);

    // Get run statistics
    const runStats = await db
      .select({
        totalRuns: sql<number>`count(*)`,
        completedRuns: sql<number>`count(*) filter (where ${automationRuns.status} = 'completed')`,
        failedRuns: sql<number>`count(*) filter (where ${automationRuns.status} = 'failed')`,
        partialRuns: sql<number>`count(*) filter (where ${automationRuns.status} = 'partial')`
      })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId));

    return c.json({
      ...automation,
      recentRuns,
      statistics: {
        totalRuns: Number(runStats[0]?.totalRuns ?? 0),
        completedRuns: Number(runStats[0]?.completedRuns ?? 0),
        failedRuns: Number(runStats[0]?.failedRuns ?? 0),
        partialRuns: Number(runStats[0]?.partialRuns ?? 0)
      }
    });
  }
);

// POST /automations - Create automation
automationRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createAutomationSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [automation] = await db
      .insert(automations)
      .values({
        orgId: orgId!,
        name: data.name,
        description: data.description,
        enabled: data.enabled,
        trigger: data.trigger,
        conditions: data.conditions,
        actions: data.actions,
        onFailure: data.onFailure,
        notificationTargets: data.notificationTargets,
        createdBy: auth.user.id
      })
      .returning();

    return c.json(automation, 201);
  }
);

// PUT /automations/:id - Update automation
automationRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateAutomationSchema),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.trigger !== undefined) updates.trigger = data.trigger;
    if (data.conditions !== undefined) updates.conditions = data.conditions;
    if (data.actions !== undefined) updates.actions = data.actions;
    if (data.onFailure !== undefined) updates.onFailure = data.onFailure;
    if (data.notificationTargets !== undefined) updates.notificationTargets = data.notificationTargets;

    const [updated] = await db
      .update(automations)
      .set(updates)
      .where(eq(automations.id, automationId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /automations/:id - Delete automation
automationRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    // Check for running automation runs
    const runningRuns = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.status, 'running')
        )
      );

    const runningCount = Number(runningRuns[0]?.count ?? 0);
    if (runningCount > 0) {
      return c.json({
        error: 'Cannot delete automation with running executions',
        runningExecutions: runningCount
      }, 409);
    }

    // Delete associated runs first
    await db
      .delete(automationRuns)
      .where(eq(automationRuns.automationId, automationId));

    // Delete automation
    await db
      .delete(automations)
      .where(eq(automations.id, automationId));

    return c.json({ success: true });
  }
);

// POST /automations/:id/trigger - Manually trigger automation
automationRoutes.post(
  '/:id/trigger',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    if (!automation.enabled) {
      return c.json({ error: 'Cannot trigger disabled automation' }, 400);
    }

    // Get target devices based on automation conditions
    const targets = automation.trigger as Record<string, unknown>;
    let targetDeviceIds: string[] = [];

    // Simple device targeting logic - in production would be more sophisticated
    if (targets?.deviceIds && Array.isArray(targets.deviceIds)) {
      targetDeviceIds = targets.deviceIds;
    } else {
      // Get all devices for the org
      const orgDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.orgId, automation.orgId));
      targetDeviceIds = orgDevices.map(d => d.id);
    }

    // Create automation run
    const [run] = await db
      .insert(automationRuns)
      .values({
        automationId,
        triggeredBy: `manual:${auth.user.id}`,
        status: 'running',
        devicesTargeted: targetDeviceIds.length,
        devicesSucceeded: 0,
        devicesFailed: 0,
        logs: [{
          timestamp: new Date().toISOString(),
          level: 'info',
          message: `Automation triggered manually by user ${auth.user.id}`
        }]
      })
      .returning();

    if (!run) {
      return c.json({ error: 'Failed to create automation run' }, 500);
    }

    // Update automation run count and last run time
    await db
      .update(automations)
      .set({
        runCount: automation.runCount + 1,
        lastRunAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(automations.id, automationId));

    // In production, this would queue the actual automation execution
    // For now, simulate completion
    setTimeout(async () => {
      try {
        await db
          .update(automationRuns)
          .set({
            status: 'completed',
            devicesSucceeded: targetDeviceIds.length,
            completedAt: new Date(),
            logs: [
              ...(run.logs as Array<{ timestamp: string; level: string; message: string }>),
              {
                timestamp: new Date().toISOString(),
                level: 'info',
                message: 'Automation completed successfully'
              }
            ]
          })
          .where(eq(automationRuns.id, run.id));
      } catch {
        // Ignore errors in background task
      }
    }, 1000);

    return c.json({
      message: 'Automation triggered',
      run: {
        id: run.id,
        status: run.status,
        devicesTargeted: run.devicesTargeted,
        startedAt: run.startedAt
      }
    });
  }
);

// GET /automations/:id/runs - Get run history for automation
automationRoutes.get(
  '/:id/runs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    status: z.enum(['running', 'completed', 'failed', 'partial']).optional()
  })),
  async (c) => {
    const auth = c.get('auth');
    const automationId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const automation = await getAutomationWithOrgCheck(automationId, auth);
    if (!automation) {
      return c.json({ error: 'Automation not found' }, 404);
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [eq(automationRuns.automationId, automationId)];

    if (query.status) {
      conditions.push(eq(automationRuns.status, query.status));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(automationRuns)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get runs
    const runsList = await db
      .select()
      .from(automationRuns)
      .where(whereCondition)
      .orderBy(desc(automationRuns.startedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: runsList,
      pagination: { page, limit, total }
    });
  }
);

// ============================================
// POLICIES ENDPOINTS
// ============================================

// GET /policies - List policies with pagination
automationRoutes.get(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(policies.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(policies.orgId, query.orgId));
      } else {
        // Get policies from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(policies.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(policies.orgId, query.orgId));
    }

    // Additional filters
    if (query.enforcement) {
      conditions.push(eq(policies.enforcement, query.enforcement));
    }

    if (query.enabled !== undefined) {
      conditions.push(eq(policies.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(policies)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get policies
    const policiesList = await db
      .select()
      .from(policies)
      .where(whereCondition)
      .orderBy(desc(policies.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: policiesList,
      pagination: { page, limit, total }
    });
  }
);

// GET /policies/compliance/summary - Overall compliance dashboard data
automationRoutes.get(
  '/policies/compliance/summary',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.query();

    // Build org filter based on scope
    let orgIds: string[] = [];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgIds = [auth.orgId];
    } else if (auth.scope === 'partner') {
      if (orgId) {
        const hasAccess = await ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgIds = [orgId];
      } else {
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));
        orgIds = partnerOrgs.map(o => o.id);
      }
    } else if (auth.scope === 'system' && orgId) {
      orgIds = [orgId];
    }

    if (orgIds.length === 0 && auth.scope !== 'system') {
      return c.json({
        totalPolicies: 0,
        enabledPolicies: 0,
        byEnforcement: { monitor: 0, warn: 0, enforce: 0 },
        complianceOverview: {
          compliant: 0,
          non_compliant: 0,
          pending: 0,
          error: 0
        },
        complianceRate: 0
      });
    }

    // Get policy counts
    const policyCondition = orgIds.length > 0 ? inArray(policies.orgId, orgIds) : undefined;

    const policyCounts = await db
      .select({
        total: sql<number>`count(*)`,
        enabled: sql<number>`count(*) filter (where ${policies.enabled} = true)`
      })
      .from(policies)
      .where(policyCondition);

    // Get enforcement breakdown
    const enforcementCounts = await db
      .select({
        enforcement: policies.enforcement,
        count: sql<number>`count(*)`
      })
      .from(policies)
      .where(policyCondition)
      .groupBy(policies.enforcement);

    // Get compliance status counts
    const policyIds = await db
      .select({ id: policies.id })
      .from(policies)
      .where(policyCondition);

    const policyIdList = policyIds.map(p => p.id);

    let complianceCounts: Array<{ status: string; count: number }> = [];
    if (policyIdList.length > 0) {
      complianceCounts = await db
        .select({
          status: policyCompliance.status,
          count: sql<number>`count(*)`
        })
        .from(policyCompliance)
        .where(inArray(policyCompliance.policyId, policyIdList))
        .groupBy(policyCompliance.status);
    }

    // Format response
    const byEnforcement = { monitor: 0, warn: 0, enforce: 0 };
    for (const row of enforcementCounts) {
      byEnforcement[row.enforcement as keyof typeof byEnforcement] = Number(row.count);
    }

    const complianceOverview = {
      compliant: 0,
      non_compliant: 0,
      pending: 0,
      error: 0
    };
    let totalComplianceRecords = 0;
    for (const row of complianceCounts) {
      const count = Number(row.count);
      totalComplianceRecords += count;
      if (row.status === 'compliant') complianceOverview.compliant = count;
      else if (row.status === 'non_compliant') complianceOverview.non_compliant = count;
      else if (row.status === 'pending') complianceOverview.pending = count;
      else if (row.status === 'error') complianceOverview.error = count;
    }

    const complianceRate = totalComplianceRecords > 0
      ? Math.round((complianceOverview.compliant / totalComplianceRecords) * 100)
      : 0;

    return c.json({
      totalPolicies: Number(policyCounts[0]?.total ?? 0),
      enabledPolicies: Number(policyCounts[0]?.enabled ?? 0),
      byEnforcement,
      complianceOverview,
      complianceRate
    });
  }
);

// GET /policies/:id - Get single policy with compliance summary
automationRoutes.get(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');

    // Skip if this is a route like /policies/compliance
    if (['compliance'].includes(policyId)) {
      return c.notFound();
    }

    const policy = await getPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // Get compliance summary
    const complianceSummary = await db
      .select({
        status: policyCompliance.status,
        count: sql<number>`count(*)`
      })
      .from(policyCompliance)
      .where(eq(policyCompliance.policyId, policyId))
      .groupBy(policyCompliance.status);

    // Get remediation script info if set
    let remediationScript = null;
    if (policy.remediationScriptId) {
      const [script] = await db
        .select({ id: scripts.id, name: scripts.name })
        .from(scripts)
        .where(eq(scripts.id, policy.remediationScriptId))
        .limit(1);
      remediationScript = script;
    }

    // Format compliance summary
    const compliance = {
      compliant: 0,
      non_compliant: 0,
      pending: 0,
      error: 0,
      total: 0
    };

    for (const row of complianceSummary) {
      const count = Number(row.count);
      compliance.total += count;
      if (row.status === 'compliant') compliance.compliant = count;
      else if (row.status === 'non_compliant') compliance.non_compliant = count;
      else if (row.status === 'pending') compliance.pending = count;
      else if (row.status === 'error') compliance.error = count;
    }

    return c.json({
      ...policy,
      remediationScript,
      compliance
    });
  }
);

// POST /policies - Create policy
automationRoutes.post(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    // Verify remediation script belongs to org if provided
    if (data.remediationScriptId) {
      const [script] = await db
        .select()
        .from(scripts)
        .where(
          and(
            eq(scripts.id, data.remediationScriptId),
            eq(scripts.orgId, orgId!)
          )
        )
        .limit(1);

      if (!script) {
        return c.json({ error: 'Remediation script not found or belongs to different organization' }, 400);
      }
    }

    const [policy] = await db
      .insert(policies)
      .values({
        orgId: orgId!,
        name: data.name,
        description: data.description,
        enabled: data.enabled,
        targets: data.targets,
        rules: data.rules,
        enforcement: data.enforcement,
        checkIntervalMinutes: data.checkIntervalMinutes,
        remediationScriptId: data.remediationScriptId,
        createdBy: auth.user.id
      })
      .returning();

    return c.json(policy, 201);
  }
);

// PUT /policies/:id - Update policy
automationRoutes.put(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updatePolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const policy = await getPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // Verify remediation script if being updated
    if (data.remediationScriptId !== undefined && data.remediationScriptId !== null) {
      const [script] = await db
        .select()
        .from(scripts)
        .where(
          and(
            eq(scripts.id, data.remediationScriptId),
            eq(scripts.orgId, policy.orgId)
          )
        )
        .limit(1);

      if (!script) {
        return c.json({ error: 'Remediation script not found or belongs to different organization' }, 400);
      }
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.targets !== undefined) updates.targets = data.targets;
    if (data.rules !== undefined) updates.rules = data.rules;
    if (data.enforcement !== undefined) updates.enforcement = data.enforcement;
    if (data.checkIntervalMinutes !== undefined) updates.checkIntervalMinutes = data.checkIntervalMinutes;
    if (data.remediationScriptId !== undefined) updates.remediationScriptId = data.remediationScriptId;

    const [updated] = await db
      .update(policies)
      .set(updates)
      .where(eq(policies.id, policyId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /policies/:id - Delete policy
automationRoutes.delete(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');

    const policy = await getPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // Delete compliance records first
    await db
      .delete(policyCompliance)
      .where(eq(policyCompliance.policyId, policyId));

    // Delete policy
    await db
      .delete(policies)
      .where(eq(policies.id, policyId));

    return c.json({ success: true });
  }
);

// POST /policies/:id/evaluate - Force policy evaluation
automationRoutes.post(
  '/policies/:id/evaluate',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');

    const policy = await getPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (!policy.enabled) {
      return c.json({ error: 'Cannot evaluate disabled policy' }, 400);
    }

    // Get target devices based on policy targets
    const targets = policy.targets as Record<string, unknown>;
    let targetDevices: Array<{ id: string; hostname: string }> = [];

    // Simple device targeting logic
    if (targets?.deviceIds && Array.isArray(targets.deviceIds)) {
      targetDevices = await db
        .select({ id: devices.id, hostname: devices.hostname })
        .from(devices)
        .where(
          and(
            eq(devices.orgId, policy.orgId),
            inArray(devices.id, targets.deviceIds)
          )
        );
    } else {
      // Get all devices for the org
      targetDevices = await db
        .select({ id: devices.id, hostname: devices.hostname })
        .from(devices)
        .where(eq(devices.orgId, policy.orgId));
    }

    // Create or update compliance records
    const evaluationResults: Array<{
      deviceId: string;
      hostname: string;
      status: string;
      previousStatus: string | null;
    }> = [];

    for (const device of targetDevices) {
      // Check existing compliance record
      const [existing] = await db
        .select()
        .from(policyCompliance)
        .where(
          and(
            eq(policyCompliance.policyId, policyId),
            eq(policyCompliance.deviceId, device.id)
          )
        )
        .limit(1);

      // Simulate policy evaluation - in production would actually check rules
      const rules = policy.rules as Record<string, unknown>;
      const isCompliant = Math.random() > 0.3; // Simulation
      const newStatus = isCompliant ? 'compliant' : 'non_compliant';

      if (existing) {
        await db
          .update(policyCompliance)
          .set({
            status: newStatus,
            details: {
              evaluatedAt: new Date().toISOString(),
              rules: Object.keys(rules || {}),
              passed: isCompliant
            },
            lastCheckedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(policyCompliance.id, existing.id));

        evaluationResults.push({
          deviceId: device.id,
          hostname: device.hostname,
          status: newStatus,
          previousStatus: existing.status
        });
      } else {
        await db
          .insert(policyCompliance)
          .values({
            policyId,
            deviceId: device.id,
            status: newStatus,
            details: {
              evaluatedAt: new Date().toISOString(),
              rules: Object.keys(rules || {}),
              passed: isCompliant
            },
            lastCheckedAt: new Date()
          });

        evaluationResults.push({
          deviceId: device.id,
          hostname: device.hostname,
          status: newStatus,
          previousStatus: null
        });
      }
    }

    // Update policy last evaluated time
    await db
      .update(policies)
      .set({
        lastEvaluatedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(policies.id, policyId));

    return c.json({
      message: 'Policy evaluation completed',
      policyId,
      devicesEvaluated: targetDevices.length,
      results: evaluationResults,
      summary: {
        compliant: evaluationResults.filter(r => r.status === 'compliant').length,
        non_compliant: evaluationResults.filter(r => r.status === 'non_compliant').length
      },
      evaluatedAt: new Date().toISOString()
    });
  }
);

// GET /policies/:id/compliance - Get compliance status per device
automationRoutes.get(
  '/policies/:id/compliance',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listComplianceSchema),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const policy = await getPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [eq(policyCompliance.policyId, policyId)];

    if (query.status) {
      conditions.push(eq(policyCompliance.status, query.status));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(policyCompliance)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get compliance records with device info
    const complianceList = await db
      .select({
        id: policyCompliance.id,
        policyId: policyCompliance.policyId,
        deviceId: policyCompliance.deviceId,
        status: policyCompliance.status,
        details: policyCompliance.details,
        lastCheckedAt: policyCompliance.lastCheckedAt,
        remediationAttempts: policyCompliance.remediationAttempts,
        updatedAt: policyCompliance.updatedAt,
        deviceHostname: devices.hostname,
        deviceStatus: devices.status,
        deviceOsType: devices.osType
      })
      .from(policyCompliance)
      .leftJoin(devices, eq(policyCompliance.deviceId, devices.id))
      .where(whereCondition)
      .orderBy(desc(policyCompliance.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: complianceList,
      pagination: { page, limit, total }
    });
  }
);
