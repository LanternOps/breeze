/**
 * Patch Approval Evaluator
 *
 * Determines which patches to install on a device given the ring's approval rules.
 * Checks manual approvals, category-based auto-approval rules, and legacy ring-level auto-approve.
 */

import { db } from '../db';
import { devicePatches, patches, patchApprovals } from '../db/schema';
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
// Main evaluator
// ============================================

export async function resolveApprovedPatchesForDevice(
  deviceId: string,
  orgId: string,
  ringConfig: RingConfig
): Promise<ApprovedPatch[]> {
  // 1. Query devicePatches with status pending or missing, joined with patch details
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
    })
    .from(devicePatches)
    .innerJoin(patches, eq(devicePatches.patchId, patches.id))
    .where(
      and(
        eq(devicePatches.deviceId, deviceId),
        inArray(devicePatches.status, ['pending', 'missing'])
      )
    );

  if (pendingPatches.length === 0) return [];

  // 2. Load manual approvals for this org (optionally scoped to ring)
  const patchIds = pendingPatches.map((p) => p.patchId);
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

  for (const patch of pendingPatches) {
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

  // Priority 2: Category rule
  if (patch.category) {
    const rule = categoryRuleMap.get(patch.category.toLowerCase());
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
