/**
 * Patch Approval Evaluator
 *
 * Determines which patches to install on a device given the ring's approval rules.
 * Checks manual approvals, category-based auto-approval rules, and legacy ring-level auto-approve.
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

export interface PolicyAutoApproveConfig {
  enabled: boolean;
  severities: string[];
  deferralDays: number;
}

export interface PolicyAppRule {
  source: string;
  packageId: string;
  action: 'block' | 'pin';
  pinnedVersion?: string;
}

export type AppRuleVerdict = 'allowed' | 'blocked' | 'held';

/**
 * Evaluator input. Despite the name this now carries both ring-level config
 * and policy-level config: sources, app rules, and ring-less auto-approve.
 */
export interface RingConfig {
  ringId: string | null;
  categoryRules: CategoryRule[];
  autoApprove: unknown;
  deferralDays: number;
  /** Policy-level source selections ('os', 'third_party', ...). Absent/empty = no filtering (legacy). */
  sources?: string[];
  /** Policy-level auto-approve, consulted only when ringId is null. Absent means disabled. */
  policyAutoApprove?: PolicyAutoApproveConfig;
  /** Policy-level per-app block/pin rules. Applied to every job approval path. */
  apps?: PolicyAppRule[];
}

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
const THIRD_PARTY_PATCH_SOURCES = ['third_party', 'custom'] as const;

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
 * non-numeric segments lexicographically, and missing segments count as 0.
 */
export function comparePatchVersions(
  a: string | null | undefined,
  b: string | null | undefined
): number | null {
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

    const cmp = x.localeCompare(y);
    if (cmp !== 0) return cmp < 0 ? -1 : 1;
  }

  return 0;
}

/** Key app rules by source + lowercased packageId for O(1) candidate lookup. */
export function buildAppRuleMap(apps: PolicyAppRule[] | undefined): Map<string, PolicyAppRule> {
  const map = new Map<string, PolicyAppRule>();
  for (const rule of apps ?? []) {
    map.set(`${rule.source}|${rule.packageId.toLowerCase()}`, rule);
  }
  return map;
}

/**
 * Verdict for one candidate patch against the policy's app rules.
 * 'held' means a pin was exceeded, or the version cannot be proven within pin.
 */
export function evaluateAppRule(
  patch: { source: string; packageId: string | null; version: string | null },
  rules: Map<string, PolicyAppRule>
): AppRuleVerdict {
  if (rules.size === 0 || !patch.packageId) return 'allowed';
  const rule = rules.get(`${patch.source}|${patch.packageId.toLowerCase()}`);
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
  ringConfig: RingConfig
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

  const appRuleMap = buildAppRuleMap(ringConfig.apps);
  const finalCandidates = appRuleMap.size > 0
    ? candidatePatches.filter((p) => {
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

type ApprovalReason = 'manual' | 'category_rule' | 'legacy_auto_approve' | 'policy_auto_approve';

function evaluatePatchApproval(
  patch: PatchCandidate,
  ringConfig: RingConfig,
  manualApprovalSet: Set<string>,
  categoryRuleMap: Map<string, CategoryRule>,
  legacyAutoApprove: LegacyAutoApproveConfig,
  now: Date
): ApprovalReason | null {
  // Priority 1: Manual approval
  if (manualApprovalSet.has(patch.patchId)) {
    return 'manual';
  }

  // No ring linked: manual approvals plus policy-level auto-approve. Linked
  // rings take absolute precedence, so policyAutoApprove is ignored above.
  if (!ringConfig.ringId) {
    const pa = ringConfig.policyAutoApprove;
    if (pa?.enabled && patch.severity && pa.severities.includes(patch.severity)) {
      if (pa.deferralDays > 0 && patch.releaseDate) {
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
