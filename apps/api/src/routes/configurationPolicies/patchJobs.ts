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
  configPolicyPatchSettings,
  patchJobs,
  devices,
} from '../../db/schema';
import { resolvePatchConfigForDevice, checkDeviceMaintenanceWindow } from '../../services/featureConfigResolver';
import { getConfigPolicy } from '../../services/configurationPolicy';

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

async function loadConfigPolicyPatchSettings(configPolicyId: string) {
  const [result] = await db
    .select({
      patchSettings: configPolicyPatchSettings,
      featureLinkId: configPolicyFeatureLinks.id,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configPolicyPatchSettings,
      eq(configPolicyPatchSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .where(
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configPolicyId),
        eq(configPolicyFeatureLinks.featureType, 'patch')
      )
    )
    .limit(1);

  return result?.patchSettings ?? null;
}

function getPatchSettingsSignature(settings: typeof configPolicyPatchSettings.$inferSelect): string {
  return JSON.stringify({
    sources: settings.sources,
    autoApprove: settings.autoApprove,
    autoApproveSeverities: settings.autoApproveSeverities ?? [],
    rebootPolicy: settings.rebootPolicy,
    scheduleFrequency: settings.scheduleFrequency,
    scheduleTime: settings.scheduleTime,
    scheduleDayOfWeek: settings.scheduleDayOfWeek ?? null,
    scheduleDayOfMonth: settings.scheduleDayOfMonth ?? null,
  });
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
      resolvedSettings: typeof configPolicyPatchSettings.$inferSelect;
    }> = [];

    const maintenanceSuppressedDeviceIds: string[] = [];

    for (const device of accessibleDevices) {
      // Check if patching is suppressed by a maintenance window
      const maintenanceStatus = await checkDeviceMaintenanceWindow(device.id);
      if (maintenanceStatus.active && maintenanceStatus.suppressPatching) {
        maintenanceSuppressedDeviceIds.push(device.id);
        continue;
      }

      const resolved = await resolvePatchConfigForDevice(device.id);
      // If the device has no resolved config, fall back to the policy-level settings
      devicePatchConfigs.push({
        deviceId: device.id,
        orgId: device.orgId,
        resolvedSettings: resolved ?? patchSettings,
      });
    }

    if (devicePatchConfigs.length === 0) {
      return c.json({
        error: 'All devices are currently in a maintenance window with patching suppressed',
        skipped: { missingDeviceIds, inaccessibleDeviceIds, maintenanceSuppressedDeviceIds },
      }, 409);
    }

    // 5. Group devices by org and resolved settings to avoid mixing
    // different effective patch configs into a single job.
    const orgGroups = new Map<
      string,
      Map<string, { settings: typeof configPolicyPatchSettings.$inferSelect; deviceIds: string[] }>
    >();
    for (const config of devicePatchConfigs) {
      const settingsKey = getPatchSettingsSignature(config.resolvedSettings);
      const settingsGroups = orgGroups.get(config.orgId) ?? new Map<string, { settings: typeof configPolicyPatchSettings.$inferSelect; deviceIds: string[] }>();
      const existing = settingsGroups.get(settingsKey);
      if (existing) {
        existing.deviceIds.push(config.deviceId);
      } else {
        settingsGroups.set(settingsKey, {
          settings: config.resolvedSettings,
          deviceIds: [config.deviceId],
        });
      }
      orgGroups.set(config.orgId, settingsGroups);
    }

    // 6. Create patch jobs (one per org/settings group for correct config fidelity)
    const createdJobs: Array<{ jobId: string; orgId: string; deviceCount: number }> = [];

    for (const [orgId, settingsGroups] of orgGroups) {
      for (const { settings, deviceIds } of settingsGroups.values()) {
        const jobName = data.name ?? `Config Policy Patch Job - ${policy.name}`;

        const [job] = await db
          .insert(patchJobs)
          .values({
            orgId,
            policyId: null, // Not a legacy patch policy
            configPolicyId,
            name: jobName,
            patches: {
              sources: settings.sources,
              autoApprove: settings.autoApprove,
              autoApproveSeverities: settings.autoApproveSeverities,
              rebootPolicy: settings.rebootPolicy,
              scheduleFrequency: settings.scheduleFrequency,
              scheduleTime: settings.scheduleTime,
              scheduleDayOfWeek: settings.scheduleDayOfWeek,
              scheduleDayOfMonth: settings.scheduleDayOfMonth,
            },
            targets: {
              deviceIds,
              configPolicyId,
              configPolicyName: policy.name,
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
        }
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
        patchSettingsId: patchSettings.id,
        sources: patchSettings.sources,
        autoApprove: patchSettings.autoApprove,
        rebootPolicy: patchSettings.rebootPolicy,
        scheduleFrequency: patchSettings.scheduleFrequency,
        missingDeviceIds,
        inaccessibleDeviceIds,
        maintenanceSuppressedDeviceIds,
      },
    });

    return c.json({
      success: true,
      configPolicyId,
      configPolicyName: policy.name,
      patchSettings: {
        sources: patchSettings.sources,
        autoApprove: patchSettings.autoApprove,
        autoApproveSeverities: patchSettings.autoApproveSeverities,
        scheduleFrequency: patchSettings.scheduleFrequency,
        scheduleTime: patchSettings.scheduleTime,
        scheduleDayOfWeek: patchSettings.scheduleDayOfWeek,
        scheduleDayOfMonth: patchSettings.scheduleDayOfMonth,
        rebootPolicy: patchSettings.rebootPolicy,
      },
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
      patchSettings: {
        id: patchSettings.id,
        sources: patchSettings.sources,
        autoApprove: patchSettings.autoApprove,
        autoApproveSeverities: patchSettings.autoApproveSeverities,
        scheduleFrequency: patchSettings.scheduleFrequency,
        scheduleTime: patchSettings.scheduleTime,
        scheduleDayOfWeek: patchSettings.scheduleDayOfWeek,
        scheduleDayOfMonth: patchSettings.scheduleDayOfMonth,
        rebootPolicy: patchSettings.rebootPolicy,
        createdAt: patchSettings.createdAt,
        updatedAt: patchSettings.updatedAt,
      },
    });
  }
);

/**
 * GET /:id/resolve-patch-config/:deviceId
 *
 * Resolves the effective patch configuration for a specific device through the
 * configuration policy hierarchy. Returns the winning patch settings row.
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

    const resolved = await resolvePatchConfigForDevice(deviceId);
    if (!resolved) {
      return c.json({
        configPolicyId,
        deviceId,
        resolved: null,
        message: 'No patch configuration found for this device in the policy hierarchy',
      });
    }

    return c.json({
      configPolicyId,
      deviceId,
      resolved: {
        id: resolved.id,
        sources: resolved.sources,
        autoApprove: resolved.autoApprove,
        autoApproveSeverities: resolved.autoApproveSeverities,
        scheduleFrequency: resolved.scheduleFrequency,
        scheduleTime: resolved.scheduleTime,
        scheduleDayOfWeek: resolved.scheduleDayOfWeek,
        scheduleDayOfMonth: resolved.scheduleDayOfMonth,
        rebootPolicy: resolved.rebootPolicy,
      },
    });
  }
);
