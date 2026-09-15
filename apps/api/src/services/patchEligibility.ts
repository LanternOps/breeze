/**
 * Patch install eligibility — the ONE database-facing gate for "may this
 * patch go on this device right now" (AI patch agent W02, #5748).
 *
 * Three entry points, one decision:
 *
 *  - `evaluatePatchInstallEligibility` — the core. Takes an
 *    `ApprovalEvaluationConfig` the CALLER already holds (the job executor's
 *    frozen snapshot, or the live one resolved below) and issues the same
 *    three reads `resolveApprovedPatchesForDevice` has always issued: org →
 *    partner, outstanding `device_patches ⋈ patches` pinned to the org, the
 *    partner's manual approvals. Every candidate ends in `eligible` or in
 *    `ineligible` WITH a reason.
 *  - `resolveApprovedPatchesForDevice` — the job executor's entry point
 *    (`jobs/patchJobExecutor.ts`), a thin adapter that keeps its exact
 *    `ApprovedPatch[]` shape and ordering. Superseded patches are NOT excluded
 *    here (parity with the pre-extraction evaluator; recorded as a follow-up).
 *  - `resolvePatchInstallEligibility` — the LIVE composition the AI path
 *    (`aiAgents/patchPlan.ts`) and the release-time effect digest
 *    (`actionIntents/effectDigest.ts` `manage_patches:install`) share: device
 *    ∈ org → the device's CURRENT effective patch policy and ring → the core,
 *    with superseded patches excluded. What the approver saw and what the
 *    release re-checks are, by construction, the same function.
 *
 * Read-only. This module never writes.
 *
 * PRECONDITION for the live path: the caller runs in a system DB context
 * (`resolvePatchPolicyReference` reads the partner-axis `patch_policies`
 * through `readWithPartnerAxisVisibility`, which is a pass-through there and
 * an escape — a second pooled connection — anywhere else). All three callers
 * (the run finalizer, `createActionIntent`'s transaction, the release worker)
 * already are.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PatchIneligibleReason } from '@breeze/shared';
import { db } from '../db';
import {
  devicePatches, devices, organizations, patchApprovals, patches, patchPolicies,
  OUTSTANDING_DEVICE_PATCH_STATUSES,
} from '../db/schema';
import { loadPolicyLocalPatchConfig } from './configPolicyPatching';
import { resolvePatchConfigDetailsForDevice } from './featureConfigResolver';
import { captureException } from './sentry';
import {
  buildAllowedPatchSources,
  buildAppRuleMap,
  canonicalizePatchCategory,
  decidePatchApproval,
  evaluateAppRule,
  isCategoryAllowed,
  isThirdPartyPatchSource,
  parseRingAutoApprove,
  type ApprovalEvaluationConfig,
  type ApprovalReason,
  type ApprovedPatch,
  type CategoryRule,
  type PolicyAppRule,
} from './patchApprovalEvaluator';

export type { PatchIneligibleReason };

export interface PatchEligibleEntry {
  patchId: string;
  devicePatchId: string;
  externalId: string;
  title: string;
  category: string | null;
  severity: string | null;
  requiresReboot: boolean;
  approvalReason: ApprovalReason;
}

export interface PatchInstallEligibility {
  eligible: PatchEligibleEntry[];
  ineligible: Array<{ patchId: string; reason: PatchIneligibleReason }>;
  /** The ring the decision was made against, after the cross-partner guard. */
  ringId: string | null;
  /** ISO — when this verdict was computed. */
  resolvedAt: string;
}

// Built lazily, not at module scope: effectDigest.ts imports this module, so
// every unit suite that mocks '../db/schema' without this export would
// otherwise fail at import time.
const isOutstanding = (status: string): boolean => (OUTSTANDING_DEVICE_PATCH_STATUSES as readonly string[]).includes(status);

/** The core: config injected, three reads, a reason for every exclusion. */
export async function evaluatePatchInstallEligibility(args: {
  deviceId: string;
  orgId: string;
  config: ApprovalEvaluationConfig;
  /** Undefined = every outstanding patch on the device. */
  patchIds?: string[];
  /** The AI path passes true; the job executor keeps its historical behaviour. */
  excludeSuperseded?: boolean;
}): Promise<PatchInstallEligibility> {
  const { deviceId, orgId } = args;
  const requested = args.patchIds ? [...new Set(args.patchIds)] : null;
  const resolvedAt = new Date().toISOString();
  const eligible: PatchEligibleEntry[] = [];
  const ineligible: Array<{ patchId: string; reason: PatchIneligibleReason }> = [];
  const deny = (patchId: string, reason: PatchIneligibleReason) => { ineligible.push({ patchId, reason }); };

  // Resolve the device-org's partner. Approvals are partner-scoped; an org
  // without a partner cannot have approvals — and cannot have a ring either.
  const [orgRow] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId = orgRow?.partnerId ?? null;
  if (!partnerId) {
    for (const id of requested ?? []) deny(id, 'not_outstanding');
    return { eligible, ineligible, ringId: null, resolvedAt };
  }

  // Cross-partner ring guard: a config policy could reference a ring owned by
  // a different partner (featurePolicyId is an unconstrained uuid). If the
  // ring's partner != this device-org's partner, treat it as no ring.
  let ringConfig = args.config;
  if (ringConfig.ringId && ringConfig.ringPartnerId && ringConfig.ringPartnerId !== partnerId) {
    ringConfig = { ...ringConfig, ringId: null };
  }

  // 1. The device's device_patches rows joined with patch details, pinned to
  //    the ORG (the tenant boundary — a device id alone is not one). With a
  //    requested id list every listed row is read regardless of status so a
  //    non-outstanding one can be named as such; without one only outstanding
  //    rows are read. 'missing' is a stale tombstone (see
  //    OUTSTANDING_DEVICE_PATCH_STATUSES); automation must never install it.
  const rows = await db
    .select({
      devicePatchId: devicePatches.id,
      patchId: devicePatches.patchId,
      status: devicePatches.status,
      externalId: patches.externalId,
      title: patches.title,
      category: patches.category,
      severity: patches.severity,
      releaseDate: patches.releaseDate,
      requiresReboot: patches.requiresReboot,
      source: patches.source,
      packageId: patches.packageId,
      supersededBy: patches.supersededBy,
      // Pins use THIS device's observed version, so another tenant's agent cannot move the global version out from under a pin.
      version: sql<string | null>`COALESCE(${devicePatches.availableVersion}, ${patches.version})`,
      // First-seen timestamp for this device+patch. Third-party entries have no
      // vendor releaseDate, so deferral windows anchor on when we first saw the
      // patch instead of failing closed (#2218).
      firstSeenAt: devicePatches.createdAt,
    })
    .from(devicePatches)
    .innerJoin(patches, eq(devicePatches.patchId, patches.id))
    .where(
      and(
        eq(devicePatches.deviceId, deviceId),
        eq(devicePatches.orgId, orgId),
        requested
          ? inArray(devicePatches.patchId, requested)
          : inArray(devicePatches.status, [...OUTSTANDING_DEVICE_PATCH_STATUSES])
      )
    );

  const seen = new Set<string>();
  const pendingPatches: typeof rows = [];
  const requestedSet = requested ? new Set(requested) : null;
  for (const row of rows) {
    // Belt and braces over the query's own inArray: never widen past the ask.
    if (requestedSet && !requestedSet.has(row.patchId)) continue;
    seen.add(row.patchId);
    // Without a requested list the query itself is status-filtered; with one,
    // every listed row came back and its status decides.
    if (requested && !isOutstanding(row.status)) { deny(row.patchId, 'not_outstanding'); continue; }
    if (args.excludeSuperseded && row.supersededBy) { deny(row.patchId, 'superseded'); continue; }
    pendingPatches.push(row);
  }
  for (const id of requested ?? []) if (!seen.has(id)) deny(id, 'not_outstanding');

  if (pendingPatches.length === 0) return { eligible, ineligible, ringId: ringConfig.ringId, resolvedAt };

  // Apply policy-level source filtering ('os' vs 'third_party' etc.).
  const allowedSources = buildAllowedPatchSources(ringConfig.sources);
  const candidatePatches = allowedSources
    ? pendingPatches.filter((p) => {
      if (allowedSources.has(p.source)) return true;
      deny(p.patchId, 'blocked_by_source');
      return false;
    })
    : pendingPatches;

  if (candidatePatches.length === 0) {
    console.warn(
      `[PatchApproval] device ${deviceId}: all ${pendingPatches.length} pending patches excluded by policy sources [${(ringConfig.sources ?? []).join(', ')}]`
    );
    return { eligible, ineligible, ringId: ringConfig.ringId, resolvedAt };
  }

  // Ring category include/exclude filtering (#2117). These stored ring arrays
  // previously had no approval-path consumer, so excluding a category did
  // nothing. Like source and app-rule filtering they only narrow the candidate
  // set — so, consistently with those gates, they also override an explicit
  // manual approval (an excluded category is never installed).
  const hasCategoryFilter =
    (ringConfig.categories?.length ?? 0) > 0 || (ringConfig.excludeCategories?.length ?? 0) > 0;
  const categoryFiltered = hasCategoryFilter
    ? candidatePatches.filter((p) => {
      if (isCategoryAllowed(p.category, ringConfig.categories, ringConfig.excludeCategories)) {
        return true;
      }
      console.warn(
        `[PatchApproval] device ${deviceId}: patch ${p.patchId} (category=${p.category ?? 'null'}) excluded by ring category filter (include=[${(ringConfig.categories ?? []).join(', ')}] exclude=[${(ringConfig.excludeCategories ?? []).join(', ')}])`
      );
      deny(p.patchId, 'blocked_by_category');
      return false;
    })
    : candidatePatches;

  if (categoryFiltered.length === 0) return { eligible, ineligible, ringId: ringConfig.ringId, resolvedAt };

  // App rules filter before manual approvals are loaded — a policy block/pin
  // overrides even an explicit manual approval in the job flow; manual
  // per-device installs bypass this evaluator entirely.
  const appRuleMap = buildAppRuleMap(ringConfig.apps);
  const finalCandidates = appRuleMap.size > 0
    ? categoryFiltered.filter((p) => {
      if (!p.packageId && isThirdPartyPatchSource(p.source)) {
        // Deliberate allow-with-warn: holding every unidentified third-party
        // patch because one unrelated app is pinned/blocked would be
        // disproportionate.
        console.warn(
          `[PatchApproval] device ${deviceId}: patch ${p.patchId} (${p.source}) cannot be matched against app rules — missing packageId`
        );
        return true;
      }
      const verdict = evaluateAppRule(p, appRuleMap);
      if (verdict !== 'allowed') {
        console.warn(
          `[PatchApproval] device ${deviceId}: patch ${p.patchId} (${p.source}/${p.packageId ?? '?'} v${p.version ?? '?'}) excluded by app rule (${verdict})`
        );
        deny(p.patchId, 'blocked_by_app_rule');
        return false;
      }
      return true;
    })
    : categoryFiltered;

  if (finalCandidates.length === 0) return { eligible, ineligible, ringId: ringConfig.ringId, resolvedAt };

  // 2. Load manual approvals for this partner (optionally scoped to ring).
  //    partner-wide (ring_id NULL) AND ring-specific rows are both returned.
  const patchIds = finalCandidates.map((p) => p.patchId);
  const manualApprovals = await db
    .select({
      patchId: patchApprovals.patchId,
      status: patchApprovals.status,
      ringId: patchApprovals.ringId,
    })
    .from(patchApprovals)
    .where(
      and(
        eq(patchApprovals.partnerId, partnerId),
        inArray(patchApprovals.patchId, patchIds),
        eq(patchApprovals.status, 'approved')
      )
    );

  // Index manual approvals by patchId for fast lookup
  const manualApprovalSet = new Set<string>();
  for (const approval of manualApprovals) {
    // Ring-scoped approval: match if ringId matches, or approval is partner-wide (null ringId)
    if (approval.ringId === ringConfig.ringId || approval.ringId === null) {
      manualApprovalSet.add(approval.patchId);
    }
  }

  // 3. Build category rules index
  const categoryRules = Array.isArray(ringConfig.categoryRules) ? ringConfig.categoryRules : [];
  const categoryRuleMap = new Map<string, CategoryRule>();
  for (const rule of categoryRules) {
    if (rule.category) {
      categoryRuleMap.set(canonicalizePatchCategory(rule.category), rule);
    }
  }

  // 4. Parse ring-level auto-approve config (#1317): enabled + severities +
  //    deferral. Backward-compatible with the legacy boolean / no-deferral shapes.
  const ringAutoApprove = parseRingAutoApprove(
    ringConfig.autoApprove,
    ringConfig.ringId ? `ring ${ringConfig.ringId}` : undefined
  );

  const now = new Date();
  for (const patch of finalCandidates) {
    const decision = decidePatchApproval(patch, ringConfig, manualApprovalSet, categoryRuleMap, ringAutoApprove, now);
    if ('approved' in decision) {
      eligible.push({
        patchId: patch.patchId,
        devicePatchId: patch.devicePatchId,
        externalId: patch.externalId,
        title: patch.title,
        category: patch.category,
        severity: patch.severity,
        requiresReboot: patch.requiresReboot,
        approvalReason: decision.approved,
      });
    } else {
      deny(patch.patchId, decision.denied);
    }
  }

  return { eligible, ineligible, ringId: ringConfig.ringId, resolvedAt };
}

/**
 * The job executor's entry point (`jobs/patchJobExecutor.ts`). A thin adapter
 * over `evaluatePatchInstallEligibility` that preserves the exact
 * `ApprovedPatch[]` shape and candidate ordering the executor has always
 * consumed. Superseded patches are deliberately NOT excluded on this path.
 */
export async function resolveApprovedPatchesForDevice(
  deviceId: string,
  orgId: string,
  ringConfig: ApprovalEvaluationConfig
): Promise<ApprovedPatch[]> {
  const verdict = await evaluatePatchInstallEligibility({ deviceId, orgId, config: ringConfig });
  return verdict.eligible.map((e) => ({
    patchId: e.patchId,
    devicePatchId: e.devicePatchId,
    externalId: e.externalId,
    title: e.title,
    category: e.category,
    severity: e.severity,
    requiresReboot: e.requiresReboot,
    approvalReason: e.approvalReason,
  }));
}

// Strict shape for one stored ring categoryRules entry — the same shape the
// job executor validates its snapshot with. severityFilter is the legacy
// stored alias for autoApproveSeverities (pre-2026-08 rows), both read-only.
const storedCategoryRuleSchema = z.object({
  category: z.string().min(1),
  autoApprove: z.boolean(),
  autoApproveSeverities: z.array(z.string()).optional(),
  severityFilter: z.array(z.string()).optional(),
  deferralDaysOverride: z.number().int().min(0).nullable().optional(),
});

/**
 * Coerce a ring's stored `category_rules` jsonb to typed rules, with the
 * executor's fail-closed posture: a rule with a usable category but a bad
 * shape becomes an explicit deny (what the evaluator's `!rule.autoApprove`
 * does), a rule with no usable category is dropped.
 */
function coerceCategoryRules(raw: unknown[], ringId: string): CategoryRule[] {
  const rules: CategoryRule[] = [];
  for (const entry of raw) {
    const parsed = storedCategoryRuleSchema.safeParse(entry);
    if (parsed.success) { rules.push(parsed.data); continue; }
    const e = entry as { category?: unknown } | null;
    if (e !== null && typeof e === 'object' && typeof e.category === 'string' && e.category.length > 0) {
      console.warn(`[patchEligibility] ring ${ringId}: coercing malformed category rule to deny (fail-closed)`);
      rules.push({ category: e.category, autoApprove: false });
    } else {
      console.warn(`[patchEligibility] ring ${ringId}: dropping malformed category rule with unusable category`);
    }
  }
  return rules;
}

/** Manual approvals only: the config for a device with no patch policy at all. */
const NO_POLICY_CONFIG: ApprovalEvaluationConfig = { ringId: null, categoryRules: [], autoApprove: {}, deferralDays: 0 };

/**
 * The device's CURRENT effective patch config, resolved through the same
 * hierarchy the scheduler uses (`resolvePatchConfigDetailsForDevice` →
 * `loadPolicyLocalPatchConfig`), in the shape the evaluator takes. No policy
 * → manual approvals only. An invalid ring reference → no ring, but the
 * policy's own sources / app rules still apply.
 */
export async function resolveDevicePatchEvaluationConfig(deviceId: string): Promise<ApprovalEvaluationConfig> {
  const resolved = await resolvePatchConfigDetailsForDevice(deviceId);
  if (!resolved) return NO_POLICY_CONFIG;
  const policyLocal = await loadPolicyLocalPatchConfig(resolved.configPolicyId);
  if (!policyLocal) return NO_POLICY_CONFIG;

  const { settings, ring } = policyLocal;
  const ringId = ring.valid ? ring.ringId : null;
  const config: ApprovalEvaluationConfig = {
    ringId,
    ringPartnerId: null,
    categoryRules: ringId ? coerceCategoryRules(ring.categoryRules, ringId) : [],
    autoApprove: ringId ? ring.autoApprove : {},
    deferralDays: 0,
    categories: ringId ? ring.categories : undefined,
    excludeCategories: ringId ? ring.excludeCategories : undefined,
    sources: settings.sources,
    policyAutoApprove: {
      enabled: settings.autoApprove ?? false,
      severities: settings.autoApproveSeverities ?? [],
      deferralDays: settings.autoApproveDeferralDays ?? 0,
    },
    // Same normalisation the executor applies to its snapshot: strip the
    // display-only fields, and a pin without a version is a block.
    apps: (settings.apps ?? []).map((rule): PolicyAppRule =>
      rule.action === 'pin' && rule.pinnedVersion
        ? { source: rule.source, packageId: rule.packageId, action: 'pin', pinnedVersion: rule.pinnedVersion }
        : { source: rule.source, packageId: rule.packageId, action: 'block' }),
  };

  if (ringId) {
    // deferralDays and partnerId come off the ring row itself, exactly as the
    // executor threads them (jobs/patchJobExecutor.ts) — partnerId feeds the
    // cross-partner ring guard in the evaluator.
    const [ringRow] = await db
      .select({ deferralDays: patchPolicies.deferralDays, partnerId: patchPolicies.partnerId })
      .from(patchPolicies)
      .where(and(eq(patchPolicies.id, ringId), eq(patchPolicies.kind, 'ring')))
      .limit(1);
    if (ringRow) {
      config.deferralDays = ringRow.deferralDays;
      config.ringPartnerId = ringRow.partnerId;
    } else {
      // The ring resolved as valid a moment ago and is gone now (deleted
      // between the two reads). Keeping its category/auto-approve rules with
      // a zeroed deferral window would fail OPEN — the direction
      // `disabledForMalformedField` refuses. Fail closed: no ring, manual
      // approvals only, and say so.
      const message = `[patchEligibility] device ${deviceId}: ring ${ringId} vanished between resolution and read — treating as no ring (manual approvals only)`;
      console.warn(message);
      captureException(new Error(message));
      return { ...NO_POLICY_CONFIG, sources: config.sources, policyAutoApprove: config.policyAutoApprove, apps: config.apps };
    }
  }
  return config;
}

/**
 * The live gate: is each of these patches installable on this device RIGHT
 * NOW, under the policy and ring the device currently resolves to? Used to
 * build an install proposal (W02 Task 3) and re-run verbatim at release
 * (Task 4) so a patch deferred, superseded, blocked or un-approved in between
 * — or a device that changed ring or org — changes the verdict.
 */
export async function resolvePatchInstallEligibility(args: {
  deviceId: string;
  orgId: string;
  /** Undefined = every outstanding patch on the device. */
  patchIds?: string[];
}): Promise<PatchInstallEligibility> {
  const { deviceId, orgId } = args;
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  if (!device) {
    return {
      eligible: [],
      ineligible: [...new Set(args.patchIds ?? [])].map((patchId) => ({ patchId, reason: 'device_not_in_org' as const })),
      ringId: null,
      resolvedAt: new Date().toISOString(),
    };
  }
  const config = await resolveDevicePatchEvaluationConfig(deviceId);
  return evaluatePatchInstallEligibility({ deviceId, orgId, config, patchIds: args.patchIds, excludeSuperseded: true });
}
