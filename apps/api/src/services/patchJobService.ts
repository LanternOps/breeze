/**
 * Patch Job Service — Config Policy Integration
 *
 * Creates patch jobs from the new `configPolicyPatchSettings` table,
 * bypassing the legacy `patchPolicies` JSONB-based approach.
 */

import { db } from '../db';
import {
  patchJobs,
  configPolicyPatchSettings,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configurationPolicies,
} from '../db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { resolvePatchConfigForDevice, checkDeviceMaintenanceWindow } from './featureConfigResolver';

// ============================================
// Types
// ============================================

type PatchSettings = typeof configPolicyPatchSettings.$inferSelect;

export interface CreatePatchJobFromConfigPolicyResult {
  job: typeof patchJobs.$inferSelect;
}

// ============================================
// Helpers
// ============================================

function buildJobName(settings: PatchSettings): string {
  const freq = settings.scheduleFrequency ?? 'manual';
  const time = settings.scheduleTime ?? '';
  const label = freq.charAt(0).toUpperCase() + freq.slice(1);

  switch (freq) {
    case 'daily':
      return `${label} patch job @ ${time}`;
    case 'weekly':
      return `${label} patch job (${settings.scheduleDayOfWeek ?? 'sun'}) @ ${time}`;
    case 'monthly':
      return `${label} patch job (day ${settings.scheduleDayOfMonth ?? 1}) @ ${time}`;
    default:
      return `Patch job (${label})`;
  }
}

// ============================================
// Core: Create Patch Job From Config Policy
// ============================================

/**
 * Creates a `patchJobs` record driven by config policy patch settings
 * instead of the legacy `patchPolicies` table.
 *
 * - `policyId` is set to null (no legacy policy link).
 * - `configPolicyId` is set to the actual configuration policy ID
 *   (resolved via the feature link's `configPolicyId` column).
 * - Sources, schedule, etc. are taken directly from the typed columns.
 */
export async function createPatchJobFromConfigPolicy(
  deviceId: string,
  patchSettings: PatchSettings,
  orgId: string,
  configPolicyId: string
): Promise<CreatePatchJobFromConfigPolicyResult> {
  const name = buildJobName(patchSettings);

  const [job] = await db
    .insert(patchJobs)
    .values({
      orgId,
      policyId: null,
      configPolicyId,
      name,
      patches: {
        sources: patchSettings.sources,
        autoApprove: patchSettings.autoApprove,
        autoApproveSeverities: patchSettings.autoApproveSeverities,
        rebootPolicy: patchSettings.rebootPolicy,
      },
      targets: {
        deviceIds: [deviceId],
      },
      status: 'scheduled',
      scheduledAt: new Date(),
      devicesTotal: 1,
      devicesPending: 1,
    })
    .returning();

  if (!job) throw new Error('Failed to create patch job');
  return { job };
}

// ============================================
// Convenience: Resolve + Create in One Call
// ============================================

/**
 * Resolves the config-policy patch settings for a device via
 * the hierarchy, then creates a patch job if settings exist.
 *
 * Looks up the actual `configPolicyId` from the feature link
 * so the patch job references the configuration policy, not the
 * feature link.
 *
 * Returns `null` when no config policy patch settings apply to this device,
 * or when the device is in a maintenance window with patching suppressed.
 */
export async function createPatchJobForDeviceFromPolicy(
  deviceId: string,
  orgId: string
): Promise<CreatePatchJobFromConfigPolicyResult | null> {
  // Check if patching is suppressed by an active maintenance window
  const maintenanceStatus = await checkDeviceMaintenanceWindow(deviceId);
  if (maintenanceStatus.active && maintenanceStatus.suppressPatching) {
    return null;
  }

  const settings = await resolvePatchConfigForDevice(deviceId);
  if (!settings) return null;

  // Resolve the configPolicyId from the feature link
  const [featureLink] = await db
    .select({ configPolicyId: configPolicyFeatureLinks.configPolicyId })
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.id, settings.featureLinkId))
    .limit(1);

  if (!featureLink) return null;

  return createPatchJobFromConfigPolicy(deviceId, settings, orgId, featureLink.configPolicyId);
}

// ============================================
// Batch Scanner: Find All Due Patch Schedules
// ============================================

export interface ScheduledPatchSettingsWithTarget {
  patchSettings: PatchSettings;
  assignmentLevel: string;
  assignmentTargetId: string;
  policyId: string;
  policyName: string;
}

/**
 * Scans all active config policies that have patch feature links,
 * returning the patch settings with their assignment targets.
 *
 * FIXME: Not yet wired to a worker — needs a patch scheduler worker
 * to call this periodically and create patch jobs for due devices.
 */
export async function scanScheduledPatchSettings(): Promise<ScheduledPatchSettingsWithTarget[]> {
  const rows = await db
    .select({
      patchSettings: configPolicyPatchSettings,
      assignmentLevel: configPolicyAssignments.level,
      assignmentTargetId: configPolicyAssignments.targetId,
      policyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
    })
    .from(configPolicyPatchSettings)
    .innerJoin(
      configPolicyFeatureLinks,
      eq(configPolicyPatchSettings.featureLinkId, configPolicyFeatureLinks.id)
    )
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active')
      )
    )
    .innerJoin(
      configPolicyAssignments,
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id)
    )
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.targetId,
      asc(configPolicyPatchSettings.scheduleFrequency)
    );

  return rows;
}
