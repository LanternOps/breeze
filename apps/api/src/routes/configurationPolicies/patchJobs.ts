import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { db } from '../../db';
import { patchJobs, devices } from '../../db/schema';
import {
  checkDeviceMaintenanceWindow,
  resolvePatchConfigDetailsForDevice,
} from '../../services/featureConfigResolver';
import { getConfigPolicy } from '../../services/configurationPolicy';
import {
  listPatchInventory,
  loadPolicyLocalPatchConfig,
  summarizePatchInventory,
  type PatchRingResolution,
} from '../../services/configPolicyPatching';
import { enqueuePatchJob } from '../../jobs/patchJobExecutor';
import { PERMISSIONS } from '../../services/permissions';

export const patchJobRoutes = new Hono();
const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requirePatchExecute = requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);

const configPolicyIdParamSchema = z.object({
  id: z.string().uuid(),
});

const resolvePatchConfigParamSchema = z.object({
  id: z.string().uuid(),
  deviceId: z.string().uuid(),
});

const createPatchJobFromConfigPolicySchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1).max(500),
  name: z.string().min(1).max(255).optional(),
  scheduledAt: z.string().datetime().optional(),
});

function buildApprovalRing(ring: PatchRingResolution) {
  return {
    classification: ring.classification,
    valid: ring.valid,
    ringId: ring.ringId,
    ringName: ring.ringName,
    categoryRules: ring.categoryRules,
    autoApprove: ring.autoApprove,
  };
}

patchJobRoutes.get(
  '/patch-inventory',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const inventory = await listPatchInventory(auth);
    const summary = summarizePatchInventory(inventory);
    return c.json({
      data: inventory,
      summary,
    });
  }
);

patchJobRoutes.post(
  '/:id/patch-job',
  requireScope('organization', 'partner', 'system'),
  requirePatchExecute,
  requireMfa(),
  zValidator('param', configPolicyIdParamSchema),
  zValidator('json', createPatchJobFromConfigPolicySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: configPolicyId } = c.req.valid('param');
    const data = c.req.valid('json');

    const policy = await getConfigPolicy(configPolicyId, auth);
    if (!policy) {
      return c.json({ error: 'Configuration policy not found' }, 404);
    }

    if (policy.status !== 'active') {
      return c.json({ error: 'Configuration policy is not active' }, 400);
    }

    const policyLocal = await loadPolicyLocalPatchConfig(configPolicyId);
    if (!policyLocal) {
      return c.json({ error: 'Configuration policy does not have patch settings configured' }, 400);
    }

    if (!policyLocal.ring.valid) {
      return c.json({
        error: 'Configuration policy references an invalid update ring',
        ringValidation: buildApprovalRing(policyLocal.ring),
      }, 400);
    }

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

    const maintenanceSuppressedDeviceIds: string[] = [];
    const devicePatchConfigs: Array<{ deviceId: string; orgId: string }> = [];

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

    const orgGroups = new Map<string, string[]>();
    for (const config of devicePatchConfigs) {
      const existing = orgGroups.get(config.orgId) ?? [];
      existing.push(config.deviceId);
      orgGroups.set(config.orgId, existing);
    }

    const createdJobs: Array<{ jobId: string; orgId: string; deviceCount: number }> = [];

    for (const [orgId, deviceIds] of orgGroups) {
      const jobName = data.name ?? `Config Policy Patch Job - ${policy.name}`;

      const [job] = await db
        .insert(patchJobs)
        .values({
          orgId,
          policyId: null,
          configPolicyId,
          ringId: policyLocal.ring.ringId,
          name: jobName,
          patches: {
            ringId: policyLocal.ring.ringId,
            ringName: policyLocal.ring.ringName,
            categoryRules: policyLocal.ring.categoryRules,
            autoApprove: policyLocal.ring.autoApprove,
            sources: policyLocal.settings.sources,
            ringValidation: {
              classification: policyLocal.ring.classification,
              valid: policyLocal.ring.valid,
            },
          },
          targets: {
            deviceIds,
            configPolicyId,
            configPolicyName: policy.name,
            deployment: policyLocal.settings,
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

        const delayMs = data.scheduledAt
          ? Math.max(0, new Date(data.scheduledAt).getTime() - Date.now())
          : 0;
        enqueuePatchJob(job.id, delayMs || undefined).catch((err) =>
          console.error(`[PatchJobs] Failed to enqueue job ${job.id}:`, err)
        );
      }
    }

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
        ringId: policyLocal.ring.ringId,
        ringName: policyLocal.ring.ringName,
        deployment: policyLocal.settings,
        missingDeviceIds,
        inaccessibleDeviceIds,
        maintenanceSuppressedDeviceIds,
      },
    });

    return c.json({
      success: true,
      configPolicyId,
      configPolicyName: policy.name,
      policyLocal: {
        configPolicyId: policyLocal.configPolicyId,
        configPolicyName: policyLocal.configPolicyName,
        featureLinkId: policyLocal.featureLinkId,
        featurePolicyId: policyLocal.featurePolicyId,
        settings: policyLocal.settings,
        approvalRing: buildApprovalRing(policyLocal.ring),
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

patchJobRoutes.get(
  '/:id/patch-settings',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', configPolicyIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: configPolicyId } = c.req.valid('param');

    const policy = await getConfigPolicy(configPolicyId, auth);
    if (!policy) {
      return c.json({ error: 'Configuration policy not found' }, 404);
    }

    const policyLocal = await loadPolicyLocalPatchConfig(configPolicyId);
    if (!policyLocal) {
      return c.json({ error: 'Configuration policy does not have patch settings configured' }, 404);
    }

    return c.json({
      configPolicyId,
      configPolicyName: policy.name,
      policyLocal: {
        configPolicyId: policyLocal.configPolicyId,
        configPolicyName: policyLocal.configPolicyName,
        featureLinkId: policyLocal.featureLinkId,
        featurePolicyId: policyLocal.featurePolicyId,
        settings: policyLocal.settings,
        approvalRing: buildApprovalRing(policyLocal.ring),
      },
    });
  }
);

patchJobRoutes.get(
  '/:id/resolve-patch-config/:deviceId',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  zValidator('param', resolvePatchConfigParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id: configPolicyId, deviceId } = c.req.valid('param');

    const policy = await getConfigPolicy(configPolicyId, auth);
    if (!policy) {
      return c.json({ error: 'Configuration policy not found' }, 404);
    }

    const [device] = await db
      .select({ orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!auth.canAccessOrg(device.orgId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const policyLocal = await loadPolicyLocalPatchConfig(configPolicyId);
    const effective = await resolvePatchConfigDetailsForDevice(deviceId);
    const effectivePolicyLocal =
      effective && effective.configPolicyId !== policyLocal?.configPolicyId
        ? await loadPolicyLocalPatchConfig(effective.configPolicyId)
        : policyLocal;

    return c.json({
      configPolicyId,
      deviceId,
      isWinning: effective?.configPolicyId === configPolicyId,
      resolvedTimezone: effective?.resolvedTimezone ?? 'UTC',
      policyLocal: policyLocal
        ? {
            configPolicyId: policyLocal.configPolicyId,
            configPolicyName: policyLocal.configPolicyName,
            featureLinkId: policyLocal.featureLinkId,
            featurePolicyId: policyLocal.featurePolicyId,
            settings: policyLocal.settings,
            approvalRing: buildApprovalRing(policyLocal.ring),
          }
        : null,
      effective: effective
        ? {
            configPolicyId: effective.configPolicyId,
            configPolicyName: effective.configPolicyName,
            featureLinkId: effective.featureLinkId,
            featurePolicyId: effective.featurePolicyId,
            assignment: {
              level: effective.assignmentLevel,
              targetId: effective.assignmentTargetId,
              priority: effective.assignmentPriority,
            },
            settings: {
              sources: effective.settings.sources,
              autoApprove: effective.settings.autoApprove,
              autoApproveSeverities: effective.settings.autoApproveSeverities ?? [],
              scheduleFrequency: effective.settings.scheduleFrequency,
              scheduleTime: effective.settings.scheduleTime,
              scheduleDayOfWeek: effective.settings.scheduleDayOfWeek,
              scheduleDayOfMonth: effective.settings.scheduleDayOfMonth,
              rebootPolicy: effective.settings.rebootPolicy,
            },
            approvalRing: effectivePolicyLocal
              ? buildApprovalRing(effectivePolicyLocal.ring)
              : null,
          }
        : null,
    });
  }
);
