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
import { resolvePatchConfigForDevice } from '../../services/featureConfigResolver';
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

    // 4. For each accessible device, resolve the effective patch config
    //    (the hierarchy may override settings for specific devices)
    const devicePatchConfigs: Array<{
      deviceId: string;
      orgId: string;
      hostname: string | null;
      resolvedSettings: typeof configPolicyPatchSettings.$inferSelect;
    }> = [];

    for (const device of accessibleDevices) {
      const resolved = await resolvePatchConfigForDevice(device.id);
      // If the device has no resolved config, fall back to the policy-level settings
      devicePatchConfigs.push({
        deviceId: device.id,
        orgId: device.orgId,
        hostname: device.hostname,
        resolvedSettings: resolved ?? patchSettings,
      });
    }

    // 5. Group devices by orgId to create per-org patch jobs
    const orgGroups = new Map<string, typeof devicePatchConfigs>();
    for (const config of devicePatchConfigs) {
      const existing = orgGroups.get(config.orgId) ?? [];
      existing.push(config);
      orgGroups.set(config.orgId, existing);
    }

    // 6. Create patch jobs (one per org for proper org scoping)
    const createdJobs: Array<{ jobId: string; orgId: string; deviceCount: number }> = [];

    for (const [orgId, orgDevices] of orgGroups) {
      // Use the first device's resolved settings as representative
      // (in practice, all devices in same org under same config policy will have same settings)
      const representativeSettings = orgDevices[0]!.resolvedSettings;

      const jobName = data.name ?? `Config Policy Patch Job - ${policy.name}`;

      const [job] = await db
        .insert(patchJobs)
        .values({
          orgId,
          policyId: null, // Not a legacy patch policy
          configPolicyId: patchSettings.id,
          name: jobName,
          patches: {
            sources: representativeSettings.sources,
            autoApprove: representativeSettings.autoApprove,
            autoApproveSeverities: representativeSettings.autoApproveSeverities,
            rebootPolicy: representativeSettings.rebootPolicy,
            scheduleFrequency: representativeSettings.scheduleFrequency,
            scheduleTime: representativeSettings.scheduleTime,
            scheduleDayOfWeek: representativeSettings.scheduleDayOfWeek,
            scheduleDayOfMonth: representativeSettings.scheduleDayOfMonth,
          },
          targets: {
            deviceIds: orgDevices.map((d) => d.deviceId),
            configPolicyId,
            configPolicyName: policy.name,
          },
          status: data.scheduledAt ? 'scheduled' : 'scheduled',
          scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : new Date(),
          devicesTotal: orgDevices.length,
          devicesPending: orgDevices.length,
          createdBy: auth.user.id,
        })
        .returning();

      if (job) {
        createdJobs.push({
          jobId: job.id,
          orgId,
          deviceCount: orgDevices.length,
        });
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
        totalDevices: accessibleDevices.length,
        jobs: createdJobs,
        patchSettingsId: patchSettings.id,
        sources: patchSettings.sources,
        autoApprove: patchSettings.autoApprove,
        rebootPolicy: patchSettings.rebootPolicy,
        scheduleFrequency: patchSettings.scheduleFrequency,
        missingDeviceIds,
        inaccessibleDeviceIds,
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
      totalDevices: accessibleDevices.length,
      skipped: {
        missingDeviceIds,
        inaccessibleDeviceIds,
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
 * POST /:id/resolve-patch-config/:deviceId
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
