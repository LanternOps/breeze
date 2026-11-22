/** Additive software-policy coverage used by Inventory and the policy detail UI. */
import { resolveSoftwarePolicyCoverage } from './featureConfigResolver';

/** Retained for clients handling errors returned by earlier server versions. */
export const SOFTWARE_POLICY_WOULD_NOT_APPLY = 'SOFTWARE_POLICY_WOULD_NOT_APPLY';

export interface SoftwarePolicyCompetitor {
  /** Null when the winning link names no software policy. */
  policyId: string | null;
  /** Null when the caller cannot read the row (RLS) or it has no policy. */
  name: string | null;
  mode: string | null;
  /** True for a partner-owned (org_id NULL) software policy. */
  partnerWide: boolean;
  configPolicyId: string;
  configPolicyName: string | null;
  deviceCount: number;
}

export interface SoftwarePolicyCoverageSummary {
  /** Devices that hold an assignment carrying this policy. */
  assignedDeviceCount: number;
  /** Devices this policy actually governs. */
  appliesToDeviceCount: number;
  /** Kept for compatibility; additive software policies are never overridden. */
  overriddenBy: SoftwarePolicyCompetitor[];
}

/** Backs GET /software-policies/:id/coverage. */
export async function getSoftwarePolicyCoverage(
  softwarePolicyId: string,
  opts: { restrictToDeviceIds?: readonly string[] } = {},
): Promise<SoftwarePolicyCoverageSummary> {
  const coverage = await resolveSoftwarePolicyCoverage(softwarePolicyId, opts);
  return {
    assignedDeviceCount: coverage.candidateDeviceIds.length,
    appliesToDeviceCount: coverage.appliesToDeviceIds.length,
    overriddenBy: [],
  };
}

export type DefaultListPlacement =
  | { ok: true; /** Kept for compatibility; additive software policies never displace one another. */ overrides: SoftwarePolicyCompetitor[] }
  | { ok: false; body: Record<string, unknown> };

/**
 * Default Allowlist and Default Blocklist assignments add policies. Neither can
 * displace the other or a partner-wide policy, even before devices enroll.
 * Keep the placement API for callers, with no destructive override warning.
 */
export async function checkDefaultListPlacement(_params: {
  orgId: string;
  mode: 'allowlist' | 'blocklist';
  policyName: string;
  configPolicyName: string;
}): Promise<DefaultListPlacement> {
  return { ok: true, overrides: [] };
}
