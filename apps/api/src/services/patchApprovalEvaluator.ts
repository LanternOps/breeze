/**
 * Patch Approval Evaluator
 *
 * Single approval/filtering gate for patch job execution. For each device it
 * resolves the set of pending patches a job is allowed to install, covering:
 *  - manual approvals (org-wide or ring-scoped)
 *  - ring category rules (including the virtual 'third_party_app' category)
 *  - legacy ring-level auto-approve
 *  - ring-less policy-level auto-approve (severity list + deferral window)
 *  - policy source filtering ('os' vs 'third_party', ...)
 *  - per-app block/pin rules
 *
 * Manual per-device installs do NOT pass through this evaluator.
 */

import { db } from '../db';
import { devicePatches, patches, patchApprovals, OUTSTANDING_DEVICE_PATCH_STATUSES } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';

// ============================================
// Types
// ============================================

export interface CategoryRule {
  category: string;
  autoApprove: boolean;
  severityFilter?: string[];
  deferralDaysOverride?: number;
}

/**
 * Policy-level auto-approve (ring-less path). Note the inverted
 * empty-severities semantics vs legacy ring auto-approve: legacy empty
 * severities = approve all; policy-level empty severities = approve none
 * (fail-closed).
 */
export interface PolicyAutoApproveConfig {
  enabled: boolean;
  severities: string[];
  deferralDays: number;
}

export type PolicyAppRule =
  | { source: string; packageId: string; action: 'block' }
  | { source: string; packageId: string; action: 'pin'; pinnedVersion: string };

export type AppRuleVerdict = 'allowed' | 'blocked' | 'held';

/**
 * Evaluator input. Carries both ring-level config and policy-level config:
 * sources, app rules, and ring-less auto-approve.
 */
export interface ApprovalEvaluationConfig {
  ringId: string | null;
  categoryRules: CategoryRule[];
  autoApprove: unknown;
  deferralDays: number;
  /** Policy-level source selections ('os', 'third_party', ...). Absent/empty = no filtering (legacy). */
  sources?: string[];
  /** Policy-level auto-approve, consulted only when ringId is null. Absent means disabled. */
  policyAutoApprove?: PolicyAutoApproveConfig;
  /**
   * Policy-level per-app block/pin rules. Applied to every job approval path;
   * manual per-device installs do not pass through this evaluator.
   */
  apps?: PolicyAppRule[];
}

/** @deprecated Use ApprovalEvaluationConfig — kept for existing importers. */
export type RingConfig = ApprovalEvaluationConfig;

export type ApprovalReason = 'manual' | 'category_rule' | 'legacy_auto_approve' | 'policy_auto_approve';

export interface ApprovedPatch {
  patchId: string;
  devicePatchId: string;
  externalId: string;
  title: string;
  category: string | null;
  severity: string | null;
  requiresReboot: boolean;
  approvalReason: ApprovalReason;
}

// ============================================
// Policy-source → patch-source mapping
// ============================================

/** patches.source values that count as OS updates. Keep in sync with patchSourceEnum (db/schema/patches.ts). */
const OS_PATCH_SOURCES = ['microsoft', 'apple', 'linux'] as const;
/** patches.source values that count as third-party application updates. Keep in sync with patchSourceEnum (db/schema/patches.ts). */
export const THIRD_PARTY_PATCH_SOURCES = ['third_party', 'custom'] as const;

/**
 * Expand policy-level source selections ('os', 'third_party', ...) into the
 * set of patches.source values they allow. Returns null when no filtering
 * should be applied (legacy jobs created before sources were enforced).
 * 'firmware' / 'drivers' have no patch provider yet and expand to nothing.
 */
export function buildAllowedPatchSources(sources: string[] | undefined): Set<string> | null {
  if (!sources || sources.length === 0) return null;

  const allowed = new Set<string>();
  for (const source of sources) {
    switch (source) {
      case 'os':
        for (const s of OS_PATCH_SOURCES) allowed.add(s);
        break;
      case 'third_party':
        for (const s of THIRD_PARTY_PATCH_SOURCES) allowed.add(s);
        break;
      case 'microsoft':
      case 'apple':
      case 'linux':
      case 'custom':
        allowed.add(source);
        break;
      // 'firmware', 'drivers': no patch provider exists — expand to nothing
    }
  }
  return allowed;
}

export function isThirdPartyPatchSource(source: string | null | undefined): boolean {
  return (THIRD_PARTY_PATCH_SOURCES as readonly string[]).includes(source ?? '');
}

// ============================================
// Per-app rules (block / pin)
// ============================================

/**
 * Tolerant version comparison for winget/homebrew-style versions, not strict
 * semver. Splits on common separators; numeric segments compare numerically,
 * non-numeric segments by codepoint, and missing segments count as 0.
 *
 * Returns null when either side is blank/missing; callers must treat null as
 * "cannot prove within pin" (hold), never as allowed.
 */
export function comparePatchVersions(
  a: string | null | undefined,
  b: string | null | undefined
): -1 | 0 | 1 | null {
  const av = (a ?? '').trim();
  const bv = (b ?? '').trim();
  if (!av || !bv) return null;

  const as = av.split(/[.\-+_]/);
  const bs = bv.split(/[.\-+_]/);
  const len = Math.max(as.length, bs.length);

  for (let i = 0; i < len; i++) {
    const x = as[i] ?? '0';
    const y = bs[i] ?? '0';
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);

    if (xNum && yNum) {
      const diff = parseInt(x, 10) - parseInt(y, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }

    // Deterministic codepoint comparison (locale-independent).
    if (x !== y) return x < y ? -1 : 1;
  }

  return 0;
}

/**
 * Canonical lookup key for app rules. The UI presents 'third_party' and
 * 'custom' patch sources as one bucket (manual UI entries hardcode
 * 'third_party'), so both collapse to a canonical 'third_party' key; other
 * sources keep their own key.
 */
export function appRuleKey(source: string, packageId: string): string {
  const bucket = isThirdPartyPatchSource(source) ? 'third_party' : source;
  return `${bucket}|${packageId.toLowerCase()}`;
}

/**
 * Key app rules by canonical source bucket + lowercased packageId for O(1)
 * candidate lookup. Last-wins on duplicate keys is acceptable because the Zod
 * schema rejects duplicates upstream.
 */
export function buildAppRuleMap(apps: PolicyAppRule[] | undefined): Map<string, PolicyAppRule> {
  const map = new Map<string, PolicyAppRule>();
  for (const rule of apps ?? []) {
    map.set(appRuleKey(rule.source, rule.packageId), rule);
  }
  return map;
}

export type AppRuleMap = ReturnType<typeof buildAppRuleMap>;

/**
 * Verdict for one candidate patch against the policy's app rules.
 * 'held' means a pin was exceeded, or the version cannot be proven within pin.
 */
export function evaluateAppRule(
  patch: { source: string; packageId: string | null; version: string | null },
  rules: AppRuleMap
): AppRuleVerdict {
  if (rules.size === 0 || !patch.packageId) return 'allowed';
  const rule = rules.get(appRuleKey(patch.source, patch.packageId));
  if (!rule) return 'allowed';
  if (rule.action === 'block') return 'blocked';

  const cmp = comparePatchVersions(patch.version, rule.pinnedVersion);
  if (cmp === null) return 'held';
  return cmp > 0 ? 'held' : 'allowed';
}

// ============================================
// Main evaluator
// ============================================

export async function resolveApprovedPatchesForDevice(
  deviceId: string,
  orgId: string,
  ringConfig: ApprovalEvaluationConfig
): Promise<ApprovedPatch[]> {
  // 1. Query outstanding (needs-install) devicePatches, joined with patch details.
  //    Only 'pending' is outstanding — 'missing' is a stale tombstone (see
  //    OUTSTANDING_DEVICE_PATCH_STATUSES); automation must never try to install it.
  const pendingPatches = await db
    .select({
      devicePatchId: devicePatches.id,
      patchId: devicePatches.patchId,
      externalId: patches.externalId,
      title: patches.title,
      category: patches.category,
      severity: patches.severity,
      releaseDate: patches.releaseDate,
      requiresReboot: patches.requiresReboot,
      source: patches.source,
      packageId: patches.packageId,
      version: patches.version,
    })
    .from(devicePatches)
    .innerJoin(patches, eq(devicePatches.patchId, patches.id))
    .where(
      and(
        eq(devicePatches.deviceId, deviceId),
        inArray(devicePatches.status, [...OUTSTANDING_DEVICE_PATCH_STATUSES])
      )
    );

  if (pendingPatches.length === 0) return [];

  // Apply policy-level source filtering ('os' vs 'third_party' etc.).
  const allowedSources = buildAllowedPatchSources(ringConfig.sources);
  const candidatePatches = allowedSources
    ? pendingPatches.filter((p) => allowedSources.has(p.source))
    : pendingPatches;

  if (candidatePatches.length === 0) {
    console.warn(
      `[PatchApproval] device ${deviceId}: all ${pendingPatches.length} pending patches excluded by policy sources [${(ringConfig.sources ?? []).join(', ')}]`
    );
    return [];
  }

  // App rules filter before manual approvals are loaded — a policy block/pin
  // overrides even an explicit manual approval in the job flow; manual
  // per-device installs bypass this evaluator entirely.
  const appRuleMap = buildAppRuleMap(ringConfig.apps);
  const finalCandidates = appRuleMap.size > 0
    ? candidatePatches.filter((p) => {
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
          return false;
        }
        return true;
      })
    : candidatePatches;

  if (finalCandidates.length === 0) return [];

  // 2. Load manual approvals for this org (optionally scoped to ring)
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
        eq(patchApprovals.orgId, orgId),
        inArray(patchApprovals.patchId, patchIds),
        eq(patchApprovals.status, 'approved')
      )
    );

  // Index manual approvals by patchId for fast lookup
  const manualApprovalSet = new Set<string>();
  for (const approval of manualApprovals) {
    // Ring-scoped approval: match if ringId matches or approval is org-wide (null ringId)
    if (approval.ringId === ringConfig.ringId || approval.ringId === null) {
      manualApprovalSet.add(approval.patchId);
    }
  }

  // 3. Build category rules index
  const categoryRules = Array.isArray(ringConfig.categoryRules) ? ringConfig.categoryRules : [];
  const categoryRuleMap = new Map<string, CategoryRule>();
  for (const rule of categoryRules) {
    if (rule.category) {
      categoryRuleMap.set(rule.category.toLowerCase(), rule);
    }
  }

  // 4. Parse legacy auto-approve config
  const legacyAutoApprove = parseLegacyAutoApprove(ringConfig.autoApprove);

  const now = new Date();
  const approved: ApprovedPatch[] = [];

  for (const patch of finalCandidates) {
    const reason = evaluatePatchApproval(
      patch,
      ringConfig,
      manualApprovalSet,
      categoryRuleMap,
      legacyAutoApprove,
      now
    );

    if (reason) {
      approved.push({
        patchId: patch.patchId,
        devicePatchId: patch.devicePatchId,
        externalId: patch.externalId,
        title: patch.title,
        category: patch.category,
        severity: patch.severity,
        requiresReboot: patch.requiresReboot,
        approvalReason: reason,
      });
    }
  }

  return approved;
}

// ============================================
// Helpers
// ============================================

interface PatchCandidate {
  patchId: string;
  category: string | null;
  severity: string | null;
  releaseDate: string | null;
  source: string;
  packageId: string | null;
  version: string | null;
}

function evaluatePatchApproval(
  patch: PatchCandidate,
  ringConfig: ApprovalEvaluationConfig,
  manualApprovalSet: Set<string>,
  categoryRuleMap: Map<string, CategoryRule>,
  legacyAutoApprove: LegacyAutoApproveConfig,
  now: Date
): ApprovalReason | null {
  // Priority 1: Manual approval
  if (manualApprovalSet.has(patch.patchId)) {
    return 'manual';
  }

  // No ring linked: manual approvals plus policy-level auto-approve. When a
  // ring is linked this block is skipped entirely, so policyAutoApprove is
  // never consulted.
  if (!ringConfig.ringId) {
    const pa = ringConfig.policyAutoApprove;
    if (pa?.enabled && patch.severity && pa.severities.includes(patch.severity)) {
      if (pa.deferralDays > 0) {
        if (!patch.releaseDate) {
          // Fail closed: with a deferral window configured, a patch without a
          // release date cannot prove its age — hold it (consistent with the
          // pin rule's "can't prove version → held" posture).
          console.warn(
            `[PatchApproval] patch ${patch.patchId} held: policy deferral of ${pa.deferralDays} day(s) configured but the patch has no releaseDate, so it cannot prove its age`
          );
          return null;
        }
        const releaseDate = new Date(patch.releaseDate);
        const deferralEnd = new Date(releaseDate.getTime() + pa.deferralDays * 24 * 60 * 60 * 1000);
        if (deferralEnd > now) {
          return null;
        }
      }
      return 'policy_auto_approve';
    }
    return null;
  }

  // Priority 2: Category rule.
  // 'third_party_app' is a virtual category — agents report inconsistent
  // category strings for app updates (application/homebrew/homebrew-cask/...),
  // so it matches by patch source instead. An exact category rule wins.
  let rule = patch.category ? categoryRuleMap.get(patch.category.toLowerCase()) : undefined;
  if (!rule && isThirdPartyPatchSource(patch.source)) {
    rule = categoryRuleMap.get('third_party_app');
  }
  if (rule && rule.autoApprove) {
    // Check severity filter
    if (rule.severityFilter && rule.severityFilter.length > 0 && patch.severity) {
      if (!rule.severityFilter.includes(patch.severity)) {
        return null; // Severity not in allowed list
      }
    }

    // Check deferral period
    const deferralDays = rule.deferralDaysOverride ?? ringConfig.deferralDays;
    if (deferralDays > 0 && patch.releaseDate) {
      const releaseDate = new Date(patch.releaseDate);
      const deferralEnd = new Date(releaseDate.getTime() + deferralDays * 24 * 60 * 60 * 1000);
      if (deferralEnd > now) {
        return null; // Still in deferral period
      }
    }

    return 'category_rule';
  }

  // Priority 3: Legacy ring-level auto-approve
  if (legacyAutoApprove.enabled) {
    if (legacyAutoApprove.severities.length > 0 && patch.severity) {
      if (!legacyAutoApprove.severities.includes(patch.severity)) {
        return null;
      }
    }
    return 'legacy_auto_approve';
  }

  return null;
}

interface LegacyAutoApproveConfig {
  enabled: boolean;
  severities: string[];
}

function parseLegacyAutoApprove(autoApprove: unknown): LegacyAutoApproveConfig {
  // Support boolean true shorthand
  if (autoApprove === true) {
    return { enabled: true, severities: [] };
  }

  if (!autoApprove || typeof autoApprove !== 'object') {
    return { enabled: false, severities: [] };
  }

  const config = autoApprove as Record<string, unknown>;

  if (config.enabled === true) {
    const severities = Array.isArray(config.severities)
      ? config.severities.filter((s): s is string => typeof s === 'string')
      : [];
    return { enabled: true, severities };
  }

  return { enabled: false, severities: [] };
}
