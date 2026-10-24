/**
 * Patch Job Snapshot Builder
 *
 * Builds the `patches` JSONB snapshot stored on patch jobs created from
 * configuration policies. Shared by the manual creation route
 * (routes/configurationPolicies/patchJobs.ts) and the scheduler
 * (jobs/patchSchedulerWorker.ts) so both production paths snapshot
 * byte-identical policy state for the approval evaluator.
 */

import type {
  PatchInlineSettings,
  PatchRingResolution,
} from './configPolicyPatching';

/**
 * The subset of a loaded policy-local patch config the snapshot reads. Only
 * the policy's sources: auto-approval and per-app rules are ring-owned
 * (#8186, #8188).
 */
export interface PatchesSnapshotInput {
  settings: Pick<PatchInlineSettings, 'sources'>;
  ring: PatchRingResolution;
}

export interface PatchesSnapshot {
  ringId: string | null;
  ringName: string | null;
  categoryRules: Record<string, unknown>[];
  /** Ring category include/exclude filters carried into the job snapshot (#2117). */
  categories: string[];
  excludeCategories: string[];
  autoApprove: Record<string, unknown> | boolean;
  sources: PatchInlineSettings['sources'];
  /**
   * The ring's per-app rules (#8184). Every supported executor reads this key.
   * The legacy `apps` mirror (and the inert `policyAutoApprove` block) are no
   * longer written (#8188); the executor still parses `apps` from frozen
   * snapshots so in-flight jobs keep their rules.
   */
  ringAppRules: PatchRingResolution['appRules'];
  ringValidation: {
    classification: PatchRingResolution['classification'];
    valid: boolean;
  };
}

export function buildPatchesSnapshot(policyLocal: PatchesSnapshotInput): PatchesSnapshot {
  return {
    ringId: policyLocal.ring.ringId,
    ringName: policyLocal.ring.ringName,
    categoryRules: policyLocal.ring.categoryRules,
    categories: policyLocal.ring.categories,
    excludeCategories: policyLocal.ring.excludeCategories,
    autoApprove: policyLocal.ring.autoApprove,
    sources: policyLocal.settings.sources,
    ringAppRules: policyLocal.ring.appRules,
    ringValidation: {
      classification: policyLocal.ring.classification,
      valid: policyLocal.ring.valid,
    },
  };
}
