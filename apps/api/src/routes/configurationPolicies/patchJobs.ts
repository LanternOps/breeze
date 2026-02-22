import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { db } from '../../db';
import {
  configPolicyFeatureLinks,
  patchPolicies,
  patchJobs,
  devices,
} from '../../db/schema';
import { checkDeviceMaintenanceWindow } from '../../services/featureConfigResolver';
import { getConfigPolicy } from '../../services/configurationPolicy';
import { enqueuePatchJob } from '../../jobs/patchJobExecutor';

export const patchJobRoutes = new Hono();

// ============================================
// Validation Schemas
// ============================================

const configPolicyIdParamSchema = z.object({
  id: z.string().uuid(),
});

const createPatchJobFromConfigPolicySchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1).max(500),
  name: z.string().min(1).max(255).optional(),
  scheduledAt: z.string().datetime().optional(),
});

// ============================================
// Helper: Load patch settings for a configuration policy
// ============================================

type PatchDeploymentSettings = {
  scheduleFrequency: string;
  scheduleTime: string;
  scheduleDayOfWeek?: string;
  scheduleDayOfMonth?: number;
  rebootPolicy: string;
};

type ResolvedPatchConfig = {
  ringId: string | null;
  ringName: string | null;
  categoryRules: unknown[];
  autoApprove: unknown;
  deployment: PatchDeploymentSettings;
};

async function loadConfigPolicyPatchSettings(configPolicyId: string): Promise<ResolvedPatchConfig | null> {
  // 1. Find the feature link for the patch feature type
  const [featureLink] = await db
    .select()
    .from(configPolicyFeatureLinks)
    .where(
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configPolicyId),
        eq(configPolicyFeatureLinks.featureType, 'patch')
      )
    )
    .limit(1);

  if (!featureLink) return null;

  // 2. Extract deployment settings (schedule + reboot) from inlineSettings
  const inline = (featureLink.inlineSettings ?? {}) as Record<string, unknown>;
  const deployment: PatchDeploymentSettings = {
    scheduleFrequency: (inline.scheduleFrequency as string) ?? 'weekly',
    scheduleTime: (inline.scheduleTime as string) ?? '02:00',
    scheduleDayOfWeek: (inline.scheduleDayOfWeek as string) ?? 'sun',
    scheduleDayOfMonth: (inline.scheduleDayOfMonth as number) ?? 1,
    rebootPolicy: (inline.rebootPolicy as string) ?? 'if_required',
  };

  // 3. If linked to an Update Ring, load approval rules from the ring
  if (featureLink.featurePolicyId) {
    const [ring] = await db
      .select({
        id: patchPolicies.id,
        name: patchPolicies.name,
        categoryRules: patchPolicies.categoryRules,
        autoApprove: patchPolicies.autoApprove,
      })
      .from(patchPolicies)
      .where(eq(patchPolicies.id, featureLink.featurePolicyId))
      .limit(1);

    if (ring) {
      return {
        ringId: ring.id,
        ringName: ring.name,
        categoryRules: Array.isArray(ring.categoryRules) ? ring.categoryRules : [],
        autoApprove: ring.autoApprove,
        deployment,
      };
    }
  }

  // 4. No ring linked — manual approvals only
  return {
    ringId: null,
    ringName: null,
    categoryRules: [],
    autoApprove: {},
    deployment,
  };
}

// ============================================
// Routes
// ============================================

/**
 * POST /:id/patch-job
 *
 * Creates a patch deployment job based on the patch settings from a configuration policy.
 * For each target device, resolves the effective patch config via the hierarchy and
 * creates a patchJobs record with the configPolicyId set.
 *
 * The resolved settings (sources, autoApprove, scheduleFrequency, rebootPolicy, etc.)
 * are stored in the job's patches/targets JSONB fields for the worker to consume.
 */
patchJobRoutes.post(
  '/:id/patch-job',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', configPolicyIdParamSchema),
  zValidator('json', createPatchJobFromConfigPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: configPolicyId } = c.req.valid('param');
    const data = c.req.valid('json');

    // 1. Verify the configuration policy exists and user has access
    const policy = await getConfigPolicy(configPolicyId, auth);
    if (!policy) {
      return c.json({ error: 'Configuration policy not found' }, 404);
    }

    if (policy.status !== 'active') {
      return c.json({ error: 'Configuration policy is not active' }, 400);
    }

    // 2. Verify the policy has a patch feature link with settings
    const patchSettings = await loadConfigPolicyPatchSettings(configPolicyId);
    if (!patchSettings) {
      return c.json({ error: 'Configuration policy does not have patch settings configured' }, 400);
    }

    // 3. Verify the target devices exist and user has access
    const targetDevices = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        hostname: devices.hostname,
      })
      .from(devices)
      .where(inArray(devices.id, data.deviceIds));

    const foundDeviceIds = new Set(targetDevices.map((d) => d.id));
    const missingDeviceIds = data.deviceIds.filter((id) => !foundDeviceIds.has(id));
    const accessibleDevices = targetDevices.filter((d) => auth.canAccessOrg(d.orgId));
    const inaccessibleDeviceIds = targetDevices
      .filter((d) => !auth.canAccessOrg(d.orgId))
      .map((d) => d.id);

    if (accessibleDevices.length === 0) {
      return c.json({
        error: 'No accessible devices found for patch job',
        skipped: { missingDeviceIds, inaccessibleDeviceIds },
      }, 404);
    }

    // 4. For each accessible device, check maintenance window and resolve the effective patch config
    //    (the hierarchy may override settings for specific devices)
    const devicePatchConfigs: Array<{
      deviceId: string;
      orgId: string;
    }> = [];

    const maintenanceSuppressedDeviceIds: string[] = [];

    for (const device of accessibleDevices) {
      const maintenanceStatus = await checkDeviceMaintenanceWindow(device.id);
      if (maintenanceStatus.active && maintenanceStatus.suppressPatching) {
        maintenanceSuppressedDeviceIds.push(device.id);
        continue;
      }

      devicePatchConfigs.push({
        deviceId: device.id,
        orgId: device.orgId,
      });
    }

    if (devicePatchConfigs.length === 0) {
      return c.json({
        error: 'All devices are currently in a maintenance window with patching suppressed',
        skipped: { missingDeviceIds, inaccessibleDeviceIds, maintenanceSuppressedDeviceIds },
      }, 409);
    }

    // 5. Group devices by org
    const orgGroups = new Map<string, string[]>();
    for (const config of devicePatchConfigs) {
      const existing = orgGroups.get(config.orgId) ?? [];
      existing.push(config.deviceId);
      orgGroups.set(config.orgId, existing);
    }

    // 6. Create patch jobs (one per org)
    const createdJobs: Array<{ jobId: string; orgId: string; deviceCount: number }> = [];

    for (const [orgId, deviceIds] of orgGroups) {
      const jobName = data.name ?? `Config Policy Patch Job - ${policy.name}`;

      const [job] = await db
        .insert(patchJobs)
        .values({
          orgId,
          policyId: null,
          configPolicyId,
          ringId: patchSettings.ringId,
          name: jobName,
          patches: {
            ringId: patchSettings.ringId,
            ringName: patchSettings.ringName,
            categoryRules: patchSettings.categoryRules,
            autoApprove: patchSettings.autoApprove,
          },
          targets: {
            deviceIds,
            configPolicyId,
            configPolicyName: policy.name,
            deployment: patchSettings.deployment,
          },
          status: 'scheduled',
          scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : new Date(),
          devicesTotal: deviceIds.length,
          devicesPending: deviceIds.length,
          createdBy: auth.user.id,
        })
        .returning();

      if (job) {
        createdJobs.push({
          jobId: job.id,
          orgId,
          deviceCount: deviceIds.length,
        });

        // Enqueue for execution — delay if scheduledAt is in the future
        const delayMs = data.scheduledAt
          ? Math.max(0, new Date(data.scheduledAt).getTime() - Date.now())
          : 0;
        enqueuePatchJob(job.id, delayMs || undefined).catch((err) =>
          console.error(`[PatchJobs] Failed to enqueue job ${job.id}:`, err)
        );
      }
    }

    // 7. Audit log
    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'config_policy.patch_job.create',
      resourceType: 'configuration_policy',
      resourceId: configPolicyId,
      resourceName: policy.name,
      details: {
        jobCount: createdJobs.length,
        totalDevices: devicePatchConfigs.length,
        jobs: createdJobs,
        ringId: patchSettings.ringId,
        ringName: patchSettings.ringName,
        deployment: patchSettings.deployment,
        missingDeviceIds,
        inaccessibleDeviceIds,
        maintenanceSuppressedDeviceIds,
      },
    });

    return c.json({
      success: true,
      configPolicyId,
      configPolicyName: policy.name,
      approvalRing: {
        ringId: patchSettings.ringId,
        ringName: patchSettings.ringName,
        categoryRules: patchSettings.categoryRules,
      },
      deployment: patchSettings.deployment,
      jobs: createdJobs,
      totalDevices: devicePatchConfigs.length,
      skipped: {
        missingDeviceIds,
        inaccessibleDeviceIds,
        maintenanceSuppressedDeviceIds,
      },
    }, 201);
  }
);

/**
 * GET /:id/patch-settings
 *
 * Returns the resolved patch settings for a configuration policy.
 * Useful for previewing what settings will be applied.
 */
patchJobRoutes.get(
  '/:id/patch-settings',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', configPolicyIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: configPolicyId } = c.req.valid('param');

    const policy = await getConfigPolicy(configPolicyId, auth);
    if (!policy) {
      return c.json({ error: 'Configuration policy not found' }, 404);
    }

    const patchSettings = await loadConfigPolicyPatchSettings(configPolicyId);
    if (!patchSettings) {
      return c.json({ error: 'Configuration policy does not have patch settings configured' }, 404);
    }

    return c.json({
      configPolicyId,
      configPolicyName: policy.name,
      approvalRing: {
        ringId: patchSettings.ringId,
        ringName: patchSettings.ringName,
        categoryRules: patchSettings.categoryRules,
        autoApprove: patchSettings.autoApprove,
      },
      deployment: patchSettings.deployment,
    });
  }
);

/**
 * GET /:id/resolve-patch-config/:deviceId
 *
 * Returns the effective patch configuration that this configuration policy
 * would apply to a specific device: approval ring settings + deployment schedule.
 */
patchJobRoutes.get(
  '/:id/resolve-patch-config/:deviceId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const configPolicyId = c.req.param('id');
    const deviceId = c.req.param('deviceId');

    if (!configPolicyId || !deviceId) {
      return c.json({ error: 'Missing required parameters' }, 400);
    }

    const policy = await getConfigPolicy(configPolicyId, auth);
    if (!policy) {
      return c.json({ error: 'Configuration policy not found' }, 404);
    }

    // Verify the caller has access to this device's org
    const [device] = await db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId)).limit(1);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (auth.scope === 'organization' && auth.orgId !== device.orgId) {
      return c.json({ error: 'Access denied' }, 403);
    }
    if (auth.scope === 'partner' && !auth.canAccessOrg(device.orgId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const resolved = await loadConfigPolicyPatchSettings(configPolicyId);
    if (!resolved) {
      return c.json({
        configPolicyId,
        deviceId,
        resolved: null,
        message: 'No patch configuration found for this configuration policy',
      });
    }

    return c.json({
      configPolicyId,
      deviceId,
      resolved: {
        approvalRing: {
          ringId: resolved.ringId,
          ringName: resolved.ringName,
          categoryRules: resolved.categoryRules,
          autoApprove: resolved.autoApprove,
        },
        deployment: resolved.deployment,
      },
    });
  }
);
