/**
 * Patch Approval Evaluator
 *
 * Single approval/filtering gate for patch job execution. For each device it
 * resolves the set of pending patches a job is allowed to install, covering:
 *  - manual approvals (partner-wide or ring-scoped)
 *  - ring category rules (exact OS category match; terminal on match)
 *  - ring-level auto-approve (enabled + severities + deferral window) — #1317
 *  - ring-less policy-level auto-approve (severity list + deferral window)
 *  - policy source filtering ('os' vs 'third_party', ...)
 *  - per-app block/pin rules
 *
 * Manual per-device installs do NOT pass through this evaluator.
 */

import { db } from '../db';
import { devicePatches, patches, patchApprovals, organizations, OUTSTANDING_DEVICE_PATCH_STATUSES } from '../db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { captureException } from './sentry';

// ============================================
// Types
// ============================================

export interface CategoryRule {
  category: string;
  autoApprove: boolean;
  /** Severity allowlist — the canonical field name the route/UI write (updateRings.ts categoryRuleSchema). */
  autoApproveSeverities?: string[];
  /** @deprecated Legacy stored alias for autoApproveSeverities (rows/snapshots written before 2026-08). Read-only. */
  severityFilter?: string[];
  /** Opt-in: also auto-approve patches with no severity rating (#3758). Default false (fail-closed). */
  autoApproveUnrated?: boolean;
  deferralDaysOverride?: number | null;
}

/**
 * Policy-level auto-approve (ring-less path). Empty severities while enabled =
 * approve none (fail-closed). The ring auto-approve path is now fail-closed the
 * same way (see evaluatePatchApproval Priority 3), so the two paths share the
 * "enabled but no severities means approve nothing" invariant.
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
  /**
   * The partner that owns the ring referenced by ringId. Used to guard against
   * a config policy that links a ring from another partner (featurePolicyId is
   * an unconstrained uuid). If ringPartnerId !== device-org's partner, the ring
   * is ignored (treated as ringId = null).
   */
  ringPartnerId?: string | null;
  categoryRules: CategoryRule[];
  autoApprove: unknown;
  deferralDays: number;
  /**
   * Ring category allowlist (include). Empty/absent = no include restriction.
   * API/AI-only field (the web UI uses categoryRules); see isCategoryAllowed (#2117).
   */
  categories?: string[];
  /**
   * Ring category denylist (exclude). Empty/absent = no exclusions.
   * API/AI-only field (the web UI uses categoryRules); see isCategoryAllowed (#2117).
   */
  excludeCategories?: string[];
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

// 'ring_auto_approve' is the #1317 ring-owned auto-approval reason (enabled +
// severities + deferral). The historical 'legacy_auto_approve' name is kept as
// an alias so already-stored job rows / callers reading this string still work.
export type ApprovalReason =
  | 'manual'
  | 'category_rule'
  | 'ring_auto_approve'
  | 'legacy_auto_approve'
  | 'policy_auto_approve';

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

/**
 * Reconcile category synonyms so ring category rules match the agent's emitted
 * `patches.category`. The Windows agent emits 'definitions' (plural, see
 * classifyWindowsUpdateCategory), while older ring rules / the ring UI stored
 * 'definition' (singular) — without this they never matched and the toggle was
 * dead. Applied to BOTH the stored rule keys and the patch category at lookup,
 * so legacy 'definition' rules and new 'definitions' rules both work. Keep in
 * sync with the agent classifier and the Update Ring category options
 * (apps/web/src/components/patches/UpdateRingForm.tsx).
 */
export function canonicalizePatchCategory(category: string): string {
  const c = category.toLowerCase();
  if (c === 'definition') return 'definitions';
  return c;
}

/** Canonicalize + dedupe a ring category list into a lookup set, dropping blanks. */
function normalizeCategorySet(list: string[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const c of list ?? []) {
    if (typeof c === 'string' && c.trim().length > 0) set.add(canonicalizePatchCategory(c.trim()));
  }
  return set;
}

/**
 * Decide whether a patch survives the ring's include/exclude category filter.
 *
 * `categories` (include allowlist) and `excludeCategories` (exclude denylist)
 * are API/AI-only ring fields (the web UI drives categoryRules instead). Until
 * #2117 they were stored but had NO consumer in the approval/job path, so
 * excluding a category did nothing at approval time. Both only narrow the
 * candidate set (fail-safe: they never widen install scope), applied alongside
 * source and app-rule filtering before approval.
 *
 * Categories are canonicalized on both sides so 'definition'/'definitions'
 * reconcile, consistent with categoryRule matching. Semantics:
 *  - excludeCategories: a patch whose category is in it is dropped. A
 *    null-category patch cannot be in the set, so it is never excluded.
 *  - categories (allowlist): when non-empty, only patches whose category is in
 *    it survive. A null-category patch matches no allowlist entry, so an active
 *    allowlist drops it — the same fail-closed narrowing posture as the other
 *    gates (a patch that can't prove it belongs is not auto-installed).
 *  - both empty/absent: no filtering (legacy jobs).
 * Exclude wins over include if a category is (mis)configured in both.
 */
export function isCategoryAllowed(
  category: string | null,
  categories: string[] | undefined,
  excludeCategories: string[] | undefined
): boolean {
  const include = normalizeCategorySet(categories);
  const exclude = normalizeCategorySet(excludeCategories);
  if (include.size === 0 && exclude.size === 0) return true;

  const canon = category ? canonicalizePatchCategory(category) : null;

  if (canon !== null && exclude.has(canon)) return false;
  if (include.size > 0) return canon !== null && include.has(canon);
  return true;
}

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

/**
 * True when a patch carries no usable severity signal: `severity` is
 * NULL/empty, or the DB's explicit `'unknown'` sentinel value. Both must be
 * treated identically by every auto-approve severity gate (#3758) — treating
 * only NULL as "unrated" left 'unknown'-severity patches falling through a
 * *different* code path that happened to reach the same fail-closed outcome,
 * which is fragile (see the two guards below).
 */
export function isUnratedSeverity(severity: string | null | undefined): boolean {
  return !severity || severity === 'unknown';
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
  // Resolve the device-org's partner. Approvals are partner-scoped; an org
  // without a partner cannot have approvals.
  const [orgRow] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId = orgRow?.partnerId ?? null;
  if (!partnerId) return []; // org without a partner cannot have approvals

  // Cross-partner ring guard: a config policy could reference a ring owned by
  // a different partner (featurePolicyId is an unconstrained uuid). If the
  // ring's partner != this device-org's partner, treat it as no ring.
  if (ringConfig.ringId && ringConfig.ringPartnerId && ringConfig.ringPartnerId !== partnerId) {
    ringConfig = { ...ringConfig, ringId: null };
  }

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
        return false;
      })
    : candidatePatches;

  if (categoryFiltered.length === 0) return [];

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
          return false;
        }
        return true;
      })
    : categoryFiltered;

  if (finalCandidates.length === 0) return [];

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
  const approved: ApprovedPatch[] = [];

  for (const patch of finalCandidates) {
    const reason = evaluatePatchApproval(
      patch,
      ringConfig,
      manualApprovalSet,
      categoryRuleMap,
      ringAutoApprove,
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
  /**
   * device_patches.createdAt — when this device first reported the patch as
   * pending. Deferral fallback anchor for third-party patches, which carry no
   * vendor releaseDate (#2218).
   */
  firstSeenAt?: Date | string | null;
}

function evaluatePatchApproval(
  patch: PatchCandidate,
  ringConfig: ApprovalEvaluationConfig,
  manualApprovalSet: Set<string>,
  categoryRuleMap: Map<string, CategoryRule>,
  ringAutoApprove: RingAutoApproveConfig,
  now: Date
): ApprovalReason | null {
  // Priority 1: Manual approval
  if (manualApprovalSet.has(patch.patchId)) {
    return 'manual';
  }

  // No ring linked → only manual approvals apply (partner-wide blanket handled above).
  if (!ringConfig.ringId) {
    return null;
  }

  // Priority 2: Category rule. The virtual 'third_party_app' category was
  // removed — third-party auto-approval is the ring-level thirdPartyApps
  // toggle (Priority 3); stored third_party_app rules were migrated to it by
  // the 2026-08-13 backfill. A literal category rule can still match a
  // third-party patch (winget emits e.g. 'application'), so an allow rule for
  // a third-party candidate additionally requires the same dual consent as
  // Priority 3 — otherwise a category rule would bypass both consent legs. A
  // matching rule is TERMINAL either way: autoApprove:false means "needs
  // manual approval" (the UI's words) and must not fall through to ring-level
  // auto-approve, including for third-party patches (a per-category manual
  // gate beats the ring-level 3P toggle).
  const rule = patch.category
    ? categoryRuleMap.get(canonicalizePatchCategory(patch.category))
    : undefined;
  if (rule) {
    if (!rule.autoApprove) {
      return null;
    }
    if (isThirdPartyPatchSource(patch.source)) {
      // Dual consent (same legs as Priority 3): the policy must opt into
      // third-party sources AND the ring's thirdPartyApps toggle must be on.
      if (
        !(ringConfig.sources ?? []).includes('third_party') ||
        !ringAutoApprove.thirdPartyApps
      ) {
        return null;
      }
    }
    // Severity allowlist. Canonical name is autoApproveSeverities (what the
    // route/UI write); severityFilter is honored as a legacy stored alias —
    // before 2026-08 the evaluator ONLY read severityFilter, which the writers
    // never produced, so chips were silently unenforced (fail-open).
    const severityAllowlist = rule.autoApproveSeverities ?? rule.severityFilter;
    if (severityAllowlist && severityAllowlist.length > 0) {
      if (isUnratedSeverity(patch.severity)) {
        if (!rule.autoApproveUnrated) {
          return null;
        }
      } else if (!severityAllowlist.includes(patch.severity as string)) {
        return null;
      }
    }
    const deferralDays = rule.deferralDaysOverride ?? ringConfig.deferralDays;
    if (isHeldByDeferral(patch, deferralDays, now, 'category')) {
      return null;
    }
    return 'category_rule';
  }

  // Priority 3: Ring-level auto-approve (#1317). Severity gates OS candidates;
  // third-party candidates are gated by the explicit thirdPartyApps toggle
  // (#2218 exemption replaced by spec 2026-08-04) under DUAL CONSENT:
  //  - the POLICY must have opted into third-party sources ('third_party' in
  //    the snapshotted sources; the default is ['os']). This stays even though
  //    buildAllowedPatchSources filters upstream, because ABSENT sources mean
  //    "no filtering" for legacy job snapshots — without this literal check, a
  //    legacy snapshot plus a permissive ring would silently widen to 3P.
  //  - the RING's autoApprove.thirdPartyApps must be true.
  // NOTE: the literal 'third_party' check is deliberately NARROWER than the
  // expanded patch-source bucket ('third_party'|'custom'): a policy whose
  // sources are ONLY ['custom'] passes buildAllowedPatchSources for
  // custom-source patches but does NOT grant ring-level 3P auto-approval —
  // those patches stay manual-only. Fail-closed asymmetry, kept intentionally;
  // if buildAllowedPatchSources' expansion table ever changes, revisit.
  if (ringAutoApprove.enabled) {
    if (isThirdPartyPatchSource(patch.source)) {
      if (!(ringConfig.sources ?? []).includes('third_party')) {
        return null;
      }
      if (!ringAutoApprove.thirdPartyApps) {
        return null;
      }
      const hold = ringAutoApprove.thirdPartyDeferralDays ?? ringAutoApprove.deferralDays;
      if (isHeldByDeferral(patch, hold, now, 'ring')) {
        return null;
      }
      return 'ring_auto_approve';
    }

    // OS path: unchanged fail-closed severity gating. Enabled with an empty
    // severity set approves no OS patches (legacy boolean `true` and malformed
    // `{enabled:true}` rows stay inert here).
    if (ringAutoApprove.severities.length === 0) {
      return null;
    }
    if (isUnratedSeverity(patch.severity)) {
      if (!ringAutoApprove.autoApproveUnrated) {
        return null;
      }
    } else if (!ringAutoApprove.severities.includes(patch.severity as string)) {
      return null;
    }
    if (isHeldByDeferral(patch, ringAutoApprove.deferralDays, now, 'ring')) {
      return null;
    }
    return 'ring_auto_approve';
  }

  return null;
}

function isHeldByDeferral(
  patch: PatchCandidate,
  deferralDays: number,
  now: Date,
  source: 'policy' | 'category' | 'ring'
): boolean {
  if (deferralDays <= 0) return false;

  // CAREFUL: new Date('garbage') is a truthy Invalid Date — validity is
  // decided by the Number.isNaN check below, never by `!ageAnchor` alone. A
  // present-but-unparseable releaseDate therefore does NOT fall through to the
  // first-seen fallback; it fails closed (with a log line naming the anchor).
  let anchorLabel = 'releaseDate';
  let ageAnchor: Date | null = patch.releaseDate ? new Date(patch.releaseDate) : null;

  if (!ageAnchor && isThirdPartyPatchSource(patch.source) && patch.firstSeenAt) {
    // Third-party fallback (#2218): winget/homebrew entries carry no vendor
    // releaseDate, so a configured deferral window used to hold them forever.
    // Anchor the window on when this device first reported the patch
    // (device_patches.createdAt) instead — a conservative proxy (never earlier
    // than the vendor release), so the patch is held at least as long as the
    // window intends. OS patches keep the fail-closed posture below.
    anchorLabel = 'first-seen (device_patches.createdAt)';
    ageAnchor = new Date(patch.firstSeenAt);
  }

  if (!ageAnchor || Number.isNaN(ageAnchor.getTime())) {
    // Fail closed: with a deferral window configured, a patch without a
    // release date (or usable first-seen fallback) cannot prove its age,
    // consistent with pin rules. The reason names which anchor failed so a
    // broken first-seen fallback (e.g. the column dropped from the select, a
    // malformed timestamp) is distinguishable in logs from the routine
    // "third-party patch has no releaseDate at all" case.
    const reason = ageAnchor
      ? `its ${anchorLabel} value is unparseable`
      : isThirdPartyPatchSource(patch.source)
        ? 'it has no releaseDate and no first-seen fallback timestamp'
        : 'it has no releaseDate';
    console.warn(
      `[PatchApproval] patch ${patch.patchId} held: ${source} deferral of ${deferralDays} day(s) configured but ${reason}, so it cannot prove its age`
    );
    return true;
  }

  const deferralEnd = new Date(ageAnchor.getTime() + deferralDays * 24 * 60 * 60 * 1000);
  return deferralEnd > now;
}

interface RingAutoApproveConfig {
  enabled: boolean;
  severities: string[];
  /** Deferral window (days) for OS ring auto-approve. 0 = no deferral. */
  deferralDays: number;
  /** Third-party source-level auto-approve toggle (dual consent with policy sources). */
  thirdPartyApps: boolean;
  /**
   * Third-party hold override; null = inherit deferralDays. Anchored on
   * releaseDate when present, first-seen otherwise (#2218).
   */
  thirdPartyDeferralDays: number | null;
  /** Opt-in: also auto-approve OS patches with no severity rating (#3758). Default false (fail-closed). */
  autoApproveUnrated: boolean;
}

const RECOGNIZED_RING_SEVERITIES = new Set(['critical', 'important', 'moderate', 'low']);

const DISABLED_RING_AUTO_APPROVE: RingAutoApproveConfig = {
  enabled: false,
  severities: [],
  deferralDays: 0,
  thirdPartyApps: false,
  thirdPartyDeferralDays: null,
  autoApproveUnrated: false,
};

/**
 * Parse a ring's `autoApprove` JSONB into a typed config. Tolerant of every
 * historical shape, but FAIL-CLOSED about meaning:
 *  - boolean `true` → enabled, no severities, no third-party → approves nothing
 *  - missing/`{}`/malformed → disabled
 *  - unrecognized severity strings are dropped (never writable through the
 *    schema, and matching them would defeat the thirdPartyApps derivation)
 *  - a PRESENT but invalid `deferralDays` or `thirdPartyDeferralDays` disables
 *    the row entirely — the old coerce turned a malformed hold into "no hold"
 *    (fail-open); disabling is loud (warn + Sentry) so the malformed row is
 *    findable instead of silently approving nothing
 *  - `thirdPartyApps` absent (pre-2026-08 rows and job snapshots frozen before
 *    the backfill): derived as `severities.length > 0`, which reproduces the
 *    old #2218 severity-exemption behavior for rows the write schema accepted,
 *    while keeping malformed `{enabled:true}` rows inert. Present non-boolean
 *    (AI-tool or hand-written rows) → false.
 *
 * `context` names the owning ring/job in the malformed-config logs.
 */
export function parseRingAutoApprove(autoApprove: unknown, context?: string): RingAutoApproveConfig {
  if (autoApprove === true) {
    return { ...DISABLED_RING_AUTO_APPROVE, enabled: true };
  }

  if (!autoApprove || typeof autoApprove !== 'object') {
    return DISABLED_RING_AUTO_APPROVE;
  }

  const config = autoApprove as Record<string, unknown>;
  if (config.enabled !== true) {
    return DISABLED_RING_AUTO_APPROVE;
  }

  const severities = Array.isArray(config.severities)
    ? config.severities.filter(
        (s): s is string => typeof s === 'string' && RECOGNIZED_RING_SEVERITIES.has(s)
      )
    : [];

  let deferralDays = 0;
  if (config.deferralDays !== undefined) {
    const raw = config.deferralDays;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      return disabledForMalformedField('deferralDays', raw, context);
    }
    deferralDays = raw;
  }

  const thirdPartyApps =
    'thirdPartyApps' in config ? config.thirdPartyApps === true : severities.length > 0;

  // Same fail-closed posture as deferralDays: null/absent = inherit, but a
  // present non-conforming value disables the row rather than silently
  // inheriting (often 0 = approve immediately, the fail-open direction).
  let thirdPartyDeferralDays: number | null = null;
  const rawTp = config.thirdPartyDeferralDays;
  if (rawTp !== undefined && rawTp !== null) {
    if (typeof rawTp !== 'number' || !Number.isInteger(rawTp) || rawTp < 0 || rawTp > 365) {
      return disabledForMalformedField('thirdPartyDeferralDays', rawTp, context);
    }
    thirdPartyDeferralDays = rawTp;
  }

  const autoApproveUnrated = config.autoApproveUnrated === true;

  return { enabled: true, severities, deferralDays, thirdPartyApps, thirdPartyDeferralDays, autoApproveUnrated };
}

/**
 * Malformed auto-approve config degrades to disabled (silently ENABLING
 * auto-approval is the dangerous direction) — but loudly, mirroring the
 * patchJobExecutor posture for malformed snapshot fields: a disabled-by-parse
 * ring otherwise strands its devices in no_approved_patches with nothing
 * pointing at the bad row.
 */
function disabledForMalformedField(
  field: string,
  value: unknown,
  context?: string
): RingAutoApproveConfig {
  const message = `[PatchApproval] ${context ?? 'ring auto-approve config'} has malformed autoApprove.${field}; treating ring auto-approve as disabled`;
  console.warn(`${message}:`, JSON.stringify(value));
  captureException(new Error(message));
  return DISABLED_RING_AUTO_APPROVE;
}
