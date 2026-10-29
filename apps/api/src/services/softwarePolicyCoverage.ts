/**
 * #9635 — which devices a software policy actually governs, and the guard that
 * keeps Inventory Approve / Deny from writing into a policy that governs none.
 *
 * A device follows ONE software policy: the winner of its config-policy
 * hierarchy (closest level, then lowest priority, then earliest assignment).
 * Approve and Deny each auto-create an org-level, priority-0 assignment, so the
 * second default list used to tie with the first and silently govern zero
 * devices. Both functions here read the real resolver
 * (resolveSoftwarePolicyWinnerForDevice / resolveSoftwarePolicyCoverage), so
 * what they report is what the compliance worker will do.
 *
 * Runs in the caller's DB context (RLS applies).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { configPolicyAssignments, configurationPolicies, devices, softwarePolicies } from '../db/schema';
import {
  compareByHierarchy,
  resolveSoftwarePolicyCoverage,
  resolveSoftwarePolicyWinnerForDevice,
  type SoftwarePolicyOverride,
} from './featureConfigResolver';

/** Stable error code: the write would go into a policy that governs no device. */
export const SOFTWARE_POLICY_WOULD_NOT_APPLY = 'SOFTWARE_POLICY_WOULD_NOT_APPLY';

/** A competing software policy, named for the operator. */
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
  /** Assigned devices another software policy wins, most devices first. */
  overriddenBy: SoftwarePolicyCompetitor[];
}

async function labelCompetitors(entries: SoftwarePolicyOverride[]): Promise<SoftwarePolicyCompetitor[]> {
  if (entries.length === 0) return [];
  const policyIds = entries.flatMap((e) => (e.softwarePolicyId ? [e.softwarePolicyId] : []));
  const configIds = Array.from(new Set(entries.map((e) => e.configPolicyId)));
  const policyRows = policyIds.length > 0
    ? await db
      .select({ id: softwarePolicies.id, name: softwarePolicies.name, mode: softwarePolicies.mode, orgId: softwarePolicies.orgId })
      .from(softwarePolicies)
      .where(inArray(softwarePolicies.id, policyIds))
    : [];
  const configRows = await db
    .select({ id: configurationPolicies.id, name: configurationPolicies.name })
    .from(configurationPolicies)
    .where(inArray(configurationPolicies.id, configIds));
  const policyById = new Map(policyRows.map((r) => [r.id, r]));
  const configById = new Map(configRows.map((r) => [r.id, r.name]));
  return entries.map((e) => {
    const policy = e.softwarePolicyId ? policyById.get(e.softwarePolicyId) : undefined;
    return {
      policyId: e.softwarePolicyId,
      name: policy?.name ?? null,
      mode: policy?.mode ?? null,
      partnerWide: policy ? policy.orgId === null : false,
      configPolicyId: e.configPolicyId,
      configPolicyName: configById.get(e.configPolicyId) ?? null,
      deviceCount: e.deviceCount,
    };
  });
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
    overriddenBy: await labelCompetitors(coverage.overriddenBy),
  };
}

export type DefaultListPlacement =
  | { ok: true; /** Software policies this write newly takes devices from. */ overrides: SoftwarePolicyCompetitor[] }
  | { ok: false; body: Record<string, unknown> };

function quoted(name: string | null): string {
  return name ? `"${name}"` : 'another software policy';
}

function describeCompetitor(c: SoftwarePolicyCompetitor): string {
  const scope = c.partnerWide ? 'partner-wide ' : '';
  const via = c.configPolicyName ? ` (configuration policy "${c.configPolicyName}")` : '';
  return `${scope}${quoted(c.name)}${via}`;
}

/**
 * Before Inventory Approve / Deny writes into the org's default list, ask the
 * real resolver whether that list would govern at least one of the org's
 * devices once its org-level assignment exists (an existing one keeps its
 * priority and age; a new one is priority 0, created now — so it loses every
 * tie). Refuses when it would govern none; otherwise returns the software
 * policies a NEW assignment takes devices from (e.g. a partner-wide policy the
 * org default now overrides), so the caller can say so.
 *
 * An org with no devices passes: there is nothing to evaluate yet.
 */
export async function checkDefaultListPlacement(params: {
  orgId: string;
  mode: 'allowlist' | 'blocklist';
  policyName: string;
  configPolicyName: string;
}): Promise<DefaultListPlacement> {
  const { orgId, mode, policyName, configPolicyName } = params;

  const [existingPolicy] = await db
    .select({ id: softwarePolicies.id })
    .from(softwarePolicies)
    .where(and(
      eq(softwarePolicies.orgId, orgId),
      eq(softwarePolicies.name, policyName),
      eq(softwarePolicies.mode, mode),
      isNull(softwarePolicies.managedByLinkId),
    ))
    .limit(1);

  const [configPolicy] = await db
    .select({ id: configurationPolicies.id })
    .from(configurationPolicies)
    .where(and(
      eq(configurationPolicies.orgId, orgId),
      eq(configurationPolicies.name, configPolicyName),
      eq(configurationPolicies.status, 'active'),
    ))
    .limit(1);

  const [existingAssignment] = configPolicy
    ? await db
      .select({
        id: configPolicyAssignments.id,
        priority: configPolicyAssignments.priority,
        createdAt: configPolicyAssignments.createdAt,
      })
      .from(configPolicyAssignments)
      .where(and(
        eq(configPolicyAssignments.configPolicyId, configPolicy.id),
        eq(configPolicyAssignments.level, 'organization'),
        eq(configPolicyAssignments.targetId, orgId),
      ))
      .limit(1)
    : [];

  const orgDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)));
  if (orgDevices.length === 0) return { ok: true, overrides: [] };

  // The org-level assignment the write ends up relying on.
  const ours = {
    assignmentLevel: 'organization',
    assignmentPriority: existingAssignment?.priority ?? 0,
    assignmentCreatedAt: existingAssignment?.createdAt ?? new Date(),
  };
  // Once the assignment exists, whatever it overrides was overridden by an
  // earlier write: the first device it wins is enough.
  const established = Boolean(existingAssignment);

  let wins = 0;
  const losses = new Map<string | null, SoftwarePolicyOverride>();
  const displaced = new Map<string | null, SoftwarePolicyOverride>();
  const tally = (into: Map<string | null, SoftwarePolicyOverride>, w: { featurePolicyId: string | null; configPolicyId: string }) => {
    const entry = into.get(w.featurePolicyId);
    if (entry) entry.deviceCount += 1;
    else into.set(w.featurePolicyId, { softwarePolicyId: w.featurePolicyId, configPolicyId: w.configPolicyId, deviceCount: 1 });
  };

  const BATCH_SIZE = 50;
  for (let i = 0; i < orgDevices.length; i += BATCH_SIZE) {
    const batch = orgDevices.slice(i, i + BATCH_SIZE);
    const winners = await Promise.all(batch.map((d) => resolveSoftwarePolicyWinnerForDevice(d.id)));
    for (const winner of winners) {
      const alreadyOurs = winner !== null && (
        (existingAssignment !== undefined && winner.assignmentId === existingAssignment.id)
        || (existingPolicy !== undefined && winner.featurePolicyId === existingPolicy.id)
      );
      if (winner === null || alreadyOurs || compareByHierarchy(ours, winner) < 0) {
        wins += 1;
        if (winner !== null && !alreadyOurs) tally(displaced, winner);
      } else {
        tally(losses, winner);
      }
    }
    if (established && wins > 0) return { ok: true, overrides: [] };
  }

  if (wins > 0) {
    return { ok: true, overrides: established ? [] : await labelCompetitors(Array.from(displaced.values())) };
  }

  const winners = (await labelCompetitors(Array.from(losses.values()))).sort((a, b) => b.deviceCount - a.deviceCount);
  const sameMode = winners.every((w) => w.mode === mode);
  const primary = winners[0]!;
  const total = orgDevices.length;
  const names = winners.map(describeCompetitor).join(', ');
  const devicesText = total === 1 ? 'the 1 device' : `all ${total} devices`;
  const advice = sameMode && primary.name
    ? `To ${mode === 'allowlist' ? 'approve' : 'block'} this title, add it to "${primary.name}" in Software Policies instead.`
    : `To use "${policyName}", change or remove the assignment of ${primary.configPolicyName ? `configuration policy "${primary.configPolicyName}"` : 'the winning configuration policy'} in Configuration Policies, then try again.`;
  const error =
    `"${policyName}" would apply to no devices in this organization, so nothing was changed. `
    + `Each device follows one software policy, and ${names} wins on ${devicesText}. ${advice}`;

  return {
    ok: false,
    body: { error, code: SOFTWARE_POLICY_WOULD_NOT_APPLY, policyName, mode, sameMode, deviceCount: total, winners },
  };
}
