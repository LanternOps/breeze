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
 * The subset of a loaded policy-local patch config the snapshot reads.
 *
 * The auto-approve fields and `apps` are optional here (unlike the
 * normalized `PatchInlineSettings`) because legacy rows stored before
 * those fields existed may surface settings without them — the `?? false`
 * / `?? []` / `?? 0` fallbacks mirror the schema defaults on purpose.
 */
export interface PatchesSnapshotInput {
  settings: Pick<PatchInlineSettings, 'sources'> &
    Partial<
      Pick<
        PatchInlineSettings,
        'autoApprove' | 'autoApproveSeverities' | 'autoApproveDeferralDays' | 'apps'
      >
    >;
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
  policyAutoApprove: {
    enabled: boolean;
    severities: PatchInlineSettings['autoApproveSeverities'];
    deferralDays: number;
  };
  apps: PatchInlineSettings['apps'];
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
    policyAutoApprove: {
      enabled: policyLocal.settings.autoApprove ?? false,
      severities: policyLocal.settings.autoApproveSeverities ?? [],
      deferralDays: policyLocal.settings.autoApproveDeferralDays ?? 0,
    },
    apps: policyLocal.settings.apps ?? [],
    ringValidation: {
      classification: policyLocal.ring.classification,
      valid: policyLocal.ring.valid,
    },
  };
}
