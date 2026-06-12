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

export interface RingConfig {
  ringId: string | null;
  categoryRules: CategoryRule[];
  autoApprove: unknown;
  deferralDays: number;
  /** Policy-level source selections ('os', 'third_party', ...). Absent/empty = no filtering (legacy). */
  sources?: string[];
}

export interface ApprovedPatch {
  patchId: string;
  devicePatchId: string;
  externalId: string;
  title: string;
  category: string | null;
  severity: string | null;
  requiresReboot: boolean;
  approvalReason: 'manual' | 'category_rule' | 'legacy_auto_approve';
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

  // 2. Load manual approvals for this org (optionally scoped to ring)
  const patchIds = candidatePatches.map((p) => p.patchId);
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

  for (const patch of candidatePatches) {
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
}

function evaluatePatchApproval(
  patch: PatchCandidate,
  ringConfig: RingConfig,
  manualApprovalSet: Set<string>,
  categoryRuleMap: Map<string, CategoryRule>,
  legacyAutoApprove: LegacyAutoApproveConfig,
  now: Date
): 'manual' | 'category_rule' | 'legacy_auto_approve' | null {
  // Priority 1: Manual approval
  if (manualApprovalSet.has(patch.patchId)) {
    return 'manual';
  }

  // If no ring linked, only manual approvals count
  if (!ringConfig.ringId) {
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
