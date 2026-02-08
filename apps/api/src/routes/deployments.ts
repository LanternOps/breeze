import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { deployments, deploymentDevices, devices } from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import {
  initializeDeployment,
  getDeploymentProgress,
  pauseDeployment,
  resumeDeployment,
  cancelDeployment,
  incrementRetryCount
} from '../services/deploymentEngine';
import { writeRouteAudit } from '../services/auditEvents';

export const deploymentRoutes = new Hono();

// ============================================
// Types
// ============================================

type DeploymentResponse = {
  id: string;
  orgId: string;
  name: string;
  type: string;
  payload: unknown;
  targetType: string;
  targetConfig: unknown;
  schedule: unknown;
  rolloutConfig: unknown;
  status: string;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type DeploymentDeviceResponse = {
  id: string;
  deploymentId: string;
  deviceId: string;
  deviceHostname: string | null;
  deviceDisplayName: string | null;
  batchNumber: number | null;
  status: string;
  retryCount: number;
  maxRetries: number;
  startedAt: string | null;
  completedAt: string | null;
  result: unknown;
};

// ============================================
// Validation Schemas
// ============================================

const listDeploymentsQuerySchema = z.object({
  status: z.enum(['draft', 'pending', 'downloading', 'installing', 'completed', 'failed', 'cancelled', 'rollback']).optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const rolloutConfigSchema = z.object({
  type: z.enum(['immediate', 'staggered']),
  staggered: z.object({
    batchSize: z.union([z.number().int().min(1), z.string()]),
    batchDelayMinutes: z.number().int().min(0),
    pauseOnFailureCount: z.number().int().min(1).optional(),
    pauseOnFailurePercent: z.number().min(0).max(100).optional()
  }).optional(),
  respectMaintenanceWindows: z.boolean().default(false),
  retryConfig: z.object({
    maxRetries: z.number().int().min(0).max(10).default(3),
    backoffMinutes: z.array(z.number().int().min(1)).default([5, 15, 60])
  }).optional()
});

const targetConfigSchema = z.object({
  type: z.enum(['devices', 'groups', 'filter', 'all']),
  deviceIds: z.array(z.string().uuid()).optional(),
  groupIds: z.array(z.string().uuid()).optional(),
  filter: z.any().optional()
});

const scheduleSchema = z.object({
  type: z.enum(['immediate', 'scheduled', 'maintenance_window']),
  scheduledAt: z.string().datetime().optional(),
  maintenanceWindowId: z.string().uuid().optional()
}).optional();

const createDeploymentSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  type: z.string().min(1).max(50),
  payload: z.record(z.unknown()),
  targetType: z.enum(['devices', 'groups', 'filter', 'all']),
  targetConfig: targetConfigSchema,
  schedule: scheduleSchema,
  rolloutConfig: rolloutConfigSchema
});

const updateDeploymentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.string().min(1).max(50).optional(),
  payload: z.record(z.unknown()).optional(),
  targetType: z.enum(['devices', 'groups', 'filter', 'all']).optional(),
  targetConfig: targetConfigSchema.optional(),
  schedule: scheduleSchema,
  rolloutConfig: rolloutConfigSchema.optional()
});

const idParamSchema = z.object({
  id: z.string().uuid()
});

const deviceRetryParamSchema = z.object({
  id: z.string().uuid(),
  deviceId: z.string().uuid()
});

const listDevicesQuerySchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']).optional(),
  batchNumber: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

// ============================================
// Middleware
// ============================================

deploymentRoutes.use('*', authMiddleware);

// ============================================
// Helper Functions
// ============================================

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
): Promise<boolean> {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  return true; // system scope
}

async function getOrgIdsForAuth(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds'>
): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    return auth.accessibleOrgIds ?? [];
  }

  return null; // system scope - no restriction
}

async function getDeploymentWithAccess(
  deploymentId: string,
  auth: { scope: string; partnerId: string | null; orgId: string | null }
) {
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  if (!deployment) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(deployment.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return deployment;
}

function mapDeploymentRow(deployment: typeof deployments.$inferSelect): DeploymentResponse {
  return {
    id: deployment.id,
    orgId: deployment.orgId,
    name: deployment.name,
    type: deployment.type,
    payload: deployment.payload,
    targetType: deployment.targetType,
    targetConfig: deployment.targetConfig,
    schedule: deployment.schedule,
    rolloutConfig: deployment.rolloutConfig,
    status: deployment.status,
    createdBy: deployment.createdBy,
    createdAt: deployment.createdAt.toISOString(),
    startedAt: deployment.startedAt?.toISOString() ?? null,
    completedAt: deployment.completedAt?.toISOString() ?? null
  };
}

// ============================================
// Routes
// ============================================

// GET / - List deployments (paginated, filterable by status, type)
deploymentRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDeploymentsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgIds = await getOrgIdsForAuth(auth);
    if (auth.scope !== 'system' && (!orgIds || orgIds.length === 0)) {
      return c.json({ data: [], total: 0, limit: query.limit, offset: query.offset });
    }

    const conditions = [] as ReturnType<typeof eq>[];
    if (orgIds) {
      conditions.push(inArray(deployments.orgId, orgIds));
    }
    if (query.status) {
      conditions.push(eq(deployments.status, query.status));
    }
    if (query.type) {
      conditions.push(eq(deployments.type, query.type));
    }

    const whereCondition = conditions.length ? and(...conditions) : undefined;

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(deployments)
      .where(whereCondition);

    const total = Number(countResult?.count ?? 0);

    // Get paginated results
    const results = await db
      .select()
      .from(deployments)
      .where(whereCondition)
      .orderBy(desc(deployments.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const data = results.map(mapDeploymentRow);

    return c.json({ data, total, limit: query.limit, offset: query.offset });
  }
);

// POST / - Create a new deployment (starts in 'draft' status)
deploymentRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createDeploymentSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    let orgId = payload.orgId;
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

    const [deployment] = await db
      .insert(deployments)
      .values({
        orgId: orgId!,
        name: payload.name,
        type: payload.type,
        payload: payload.payload,
        targetType: payload.targetType,
        targetConfig: payload.targetConfig,
        schedule: payload.schedule ?? null,
        rolloutConfig: payload.rolloutConfig,
        status: 'draft',
        createdBy: auth.user.id
      })
      .returning();

    if (!deployment) {
      return c.json({ error: 'Failed to create deployment' }, 500);
    }

    writeRouteAudit(c, {
      orgId: deployment.orgId,
      action: 'deployment.create',
      resourceType: 'deployment',
      resourceId: deployment.id,
      resourceName: deployment.name,
      details: {
        type: deployment.type,
        targetType: deployment.targetType
      }
    });

    return c.json({ data: mapDeploymentRow(deployment) }, 201);
  }
);

// GET /:id - Get deployment by ID with progress
deploymentRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    // Get progress if deployment has been initialized
    let progress = null;
    if (deployment.status !== 'draft') {
      try {
        progress = await getDeploymentProgress(id);
      } catch {
        // Deployment may not have devices yet
      }
    }

    return c.json({
      data: {
        ...mapDeploymentRow(deployment),
        progress
      }
    });
  }
);

// PUT /:id - Update deployment (only if in draft status)
deploymentRoutes.put(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  zValidator('json', updateDeploymentSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    if (deployment.status !== 'draft') {
      return c.json({ error: 'Only deployments in draft status can be updated' }, 400);
    }

    const updates: Record<string, unknown> = {};
    if (payload.name !== undefined) updates.name = payload.name;
    if (payload.type !== undefined) updates.type = payload.type;
    if (payload.payload !== undefined) updates.payload = payload.payload;
    if (payload.targetType !== undefined) updates.targetType = payload.targetType;
    if (payload.targetConfig !== undefined) updates.targetConfig = payload.targetConfig;
    if (payload.schedule !== undefined) updates.schedule = payload.schedule;
    if (payload.rolloutConfig !== undefined) updates.rolloutConfig = payload.rolloutConfig;

    if (Object.keys(updates).length === 0) {
      return c.json({ data: mapDeploymentRow(deployment) });
    }

    const [updated] = await db
      .update(deployments)
      .set(updates)
      .where(eq(deployments.id, id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update deployment' }, 500);
    }

    writeRouteAudit(c, {
      orgId: deployment.orgId,
      action: 'deployment.update',
      resourceType: 'deployment',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        changedFields: Object.keys(payload)
      }
    });

    return c.json({ data: mapDeploymentRow(updated) });
  }
);

// DELETE /:id - Delete deployment (only if in draft status)
deploymentRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    if (deployment.status !== 'draft') {
      return c.json({ error: 'Only deployments in draft status can be deleted' }, 400);
    }

    // Delete any deployment devices (shouldn't exist in draft, but be safe)
    await db.delete(deploymentDevices).where(eq(deploymentDevices.deploymentId, id));

    // Delete the deployment
    await db.delete(deployments).where(eq(deployments.id, id));

    writeRouteAudit(c, {
      orgId: deployment.orgId,
      action: 'deployment.delete',
      resourceType: 'deployment',
      resourceId: deployment.id,
      resourceName: deployment.name
    });

    return c.json({ data: mapDeploymentRow(deployment) });
  }
);

// POST /:id/initialize - Initialize deployment (resolve targets, create device records)
deploymentRoutes.post(
  '/:id/initialize',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    if (deployment.status !== 'draft') {
      return c.json({ error: 'Deployment must be in draft status to initialize' }, 400);
    }

    const result = await initializeDeployment(id);

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    // Fetch updated deployment
    const [updated] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id))
      .limit(1);

    writeRouteAudit(c, {
      orgId: deployment.orgId,
      action: 'deployment.initialize',
      resourceType: 'deployment',
      resourceId: deployment.id,
      resourceName: deployment.name,
      details: {
        deviceCount: result.deviceCount
      }
    });

    return c.json({
      data: {
        ...mapDeploymentRow(updated!),
        deviceCount: result.deviceCount
      }
    });
  }
);

// POST /:id/start - Start deployment execution
deploymentRoutes.post(
  '/:id/start',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    if (deployment.status !== 'pending') {
      return c.json({ error: 'Deployment must be in pending status to start (initialize first)' }, 400);
    }

    // Update status to running
    const [updated] = await db
      .update(deployments)
      .set({
        status: 'downloading', // First phase
        startedAt: new Date()
      })
      .where(eq(deployments.id, id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to start deployment' }, 500);
    }

    writeRouteAudit(c, {
      orgId: deployment.orgId,
      action: 'deployment.start',
      resourceType: 'deployment',
      resourceId: updated.id,
      resourceName: updated.name
    });

    // Get initial progress
    const progress = await getDeploymentProgress(id);

    return c.json({
      data: {
        ...mapDeploymentRow(updated),
        progress
      }
    });
  }
);

// POST /:id/pause - Pause a running deployment
deploymentRoutes.post(
  '/:id/pause',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    // Check if deployment is in a pausable state
    const pausableStatuses = ['downloading', 'installing'];
    if (!pausableStatuses.includes(deployment.status)) {
      return c.json({ error: 'Deployment is not in a running state' }, 400);
    }

    await pauseDeployment(id);

    // Fetch updated deployment
    const [updated] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id))
      .limit(1);

    writeRouteAudit(c, {
      orgId: deployment.orgId,
      action: 'deployment.pause',
      resourceType: 'deployment',
      resourceId: deployment.id,
      resourceName: deployment.name
    });

    const progress = await getDeploymentProgress(id);

    return c.json({
      data: {
        ...mapDeploymentRow(updated!),
        progress
      }
    });
  }
);

// POST /:id/resume - Resume a paused deployment
deploymentRoutes.post(
  '/:id/resume',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    // The deploymentEngine uses 'paused' status for pause/resume
    // but the schema has different statuses - need to handle both
    if (deployment.status !== 'pending') {
      return c.json({ error: 'Deployment is not paused' }, 400);
    }

    await resumeDeployment(id);

    // Fetch updated deployment
    const [updated] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id))
      .limit(1);

    writeRouteAudit(c, {
      orgId: deployment.orgId,
      action: 'deployment.resume',
      resourceType: 'deployment',
      resourceId: deployment.id,
      resourceName: deployment.name
    });

    const progress = await getDeploymentProgress(id);

    return c.json({
      data: {
        ...mapDeploymentRow(updated!),
        progress
      }
    });
  }
);

// POST /:id/cancel - Cancel a deployment
deploymentRoutes.post(
  '/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    // Can cancel from various states (not draft, not already completed/cancelled)
    const nonCancellableStatuses = ['draft', 'completed', 'cancelled'];
    if (nonCancellableStatuses.includes(deployment.status)) {
      return c.json({ error: `Cannot cancel deployment in ${deployment.status} status` }, 400);
    }

    await cancelDeployment(id);

    // Fetch updated deployment
    const [updated] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id))
      .limit(1);

    writeRouteAudit(c, {
      orgId: deployment.orgId,
      action: 'deployment.cancel',
      resourceType: 'deployment',
      resourceId: deployment.id,
      resourceName: deployment.name
    });

    let progress = null;
    try {
      progress = await getDeploymentProgress(id);
    } catch {
      // May not have devices
    }

    return c.json({
      data: {
        ...mapDeploymentRow(updated!),
        progress
      }
    });
  }
);

// GET /:id/devices - Get deployment devices with their status
deploymentRoutes.get(
  '/:id/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  zValidator('query', listDevicesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    const conditions = [eq(deploymentDevices.deploymentId, id)] as ReturnType<typeof eq>[];
    if (query.status) {
      conditions.push(eq(deploymentDevices.status, query.status));
    }
    if (query.batchNumber) {
      conditions.push(eq(deploymentDevices.batchNumber, query.batchNumber));
    }

    const whereCondition = and(...conditions);

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(deploymentDevices)
      .where(whereCondition);

    const total = Number(countResult?.count ?? 0);

    // Get paginated results with device info
    const results = await db
      .select({
        id: deploymentDevices.id,
        deploymentId: deploymentDevices.deploymentId,
        deviceId: deploymentDevices.deviceId,
        batchNumber: deploymentDevices.batchNumber,
        status: deploymentDevices.status,
        retryCount: deploymentDevices.retryCount,
        maxRetries: deploymentDevices.maxRetries,
        startedAt: deploymentDevices.startedAt,
        completedAt: deploymentDevices.completedAt,
        result: deploymentDevices.result,
        hostname: devices.hostname,
        displayName: devices.displayName
      })
      .from(deploymentDevices)
      .leftJoin(devices, eq(deploymentDevices.deviceId, devices.id))
      .where(whereCondition)
      .orderBy(deploymentDevices.batchNumber, deploymentDevices.status)
      .limit(query.limit)
      .offset(query.offset);

    const data: DeploymentDeviceResponse[] = results.map((row) => ({
      id: row.id,
      deploymentId: row.deploymentId,
      deviceId: row.deviceId,
      deviceHostname: row.hostname,
      deviceDisplayName: row.displayName,
      batchNumber: row.batchNumber,
      status: row.status,
      retryCount: row.retryCount,
      maxRetries: row.maxRetries,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      result: row.result
    }));

    return c.json({ data, total, limit: query.limit, offset: query.offset });
  }
);

// POST /:id/devices/:deviceId/retry - Retry a failed device
deploymentRoutes.post(
  '/:id/devices/:deviceId/retry',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceRetryParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id, deviceId } = c.req.valid('param');

    const deployment = await getDeploymentWithAccess(id, auth);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    // Verify the device is part of this deployment
    const [deploymentDevice] = await db
      .select()
      .from(deploymentDevices)
      .where(
        and(
          eq(deploymentDevices.deploymentId, id),
          eq(deploymentDevices.deviceId, deviceId)
        )
      )
      .limit(1);

    if (!deploymentDevice) {
      return c.json({ error: 'Device not found in this deployment' }, 404);
    }

    if (deploymentDevice.status !== 'failed') {
      return c.json({ error: 'Only failed devices can be retried' }, 400);
    }

    const result = await incrementRetryCount(id, deviceId);

    if (!result.canRetry) {
      return c.json({
        error: 'Maximum retry count exceeded',
        retryCount: result.retryCount,
        maxRetries: deploymentDevice.maxRetries
      }, 400);
    }

    // Fetch updated device record
    const [updated] = await db
      .select({
        id: deploymentDevices.id,
        deploymentId: deploymentDevices.deploymentId,
        deviceId: deploymentDevices.deviceId,
        batchNumber: deploymentDevices.batchNumber,
        status: deploymentDevices.status,
        retryCount: deploymentDevices.retryCount,
        maxRetries: deploymentDevices.maxRetries,
        startedAt: deploymentDevices.startedAt,
        completedAt: deploymentDevices.completedAt,
        result: deploymentDevices.result,
        hostname: devices.hostname,
        displayName: devices.displayName
      })
      .from(deploymentDevices)
      .leftJoin(devices, eq(deploymentDevices.deviceId, devices.id))
      .where(
        and(
          eq(deploymentDevices.deploymentId, id),
          eq(deploymentDevices.deviceId, deviceId)
        )
      )
      .limit(1);

    const response: DeploymentDeviceResponse = {
      id: updated!.id,
      deploymentId: updated!.deploymentId,
      deviceId: updated!.deviceId,
      deviceHostname: updated!.hostname,
      deviceDisplayName: updated!.displayName,
      batchNumber: updated!.batchNumber,
      status: updated!.status,
      retryCount: updated!.retryCount,
      maxRetries: updated!.maxRetries,
      startedAt: updated!.startedAt?.toISOString() ?? null,
      completedAt: updated!.completedAt?.toISOString() ?? null,
      result: updated!.result
    };

    writeRouteAudit(c, {
      orgId: deployment.orgId,
      action: 'deployment.device.retry',
      resourceType: 'deployment',
      resourceId: deployment.id,
      resourceName: deployment.name,
      details: {
        deviceId,
        retryCount: response.retryCount
      }
    });

    return c.json({ data: response });
  }
);
