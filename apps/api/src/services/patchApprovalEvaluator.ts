/**
 * Patch Approval Evaluator
 *
 * Single approval/filtering gate for patch job execution. For each device it
 * resolves the set of pending patches a job is allowed to install, covering:
 *  - manual approvals (partner-wide or ring-scoped)
 *  - ring category rules (including the virtual 'third_party_app' category)
 *  - ring-level auto-approve (enabled + severities + deferral window) — #1317
 *  - ring-less policy-level auto-approve (severity list + deferral window)
 *  - policy source filtering ('os' vs 'third_party', ...)
 *  - per-app block/pin rules
 *
 * Manual per-device installs do NOT pass through this evaluator.
 */

import { db } from '../db';
import { devicePatches, patches, patchApprovals, organizations, OUTSTANDING_DEVICE_PATCH_STATUSES } from '../db/schema';
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
      version: patches.version,
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
  const ringAutoApprove = parseRingAutoApprove(ringConfig.autoApprove);

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

  // Priority 2: Category rule.
  // 'third_party_app' is a virtual category — agents report inconsistent
  // category strings for app updates (application/homebrew/homebrew-cask/...),
  // so it matches by patch source instead. An exact category rule wins.
  let rule = patch.category ? categoryRuleMap.get(canonicalizePatchCategory(patch.category)) : undefined;
  if (!rule && isThirdPartyPatchSource(patch.source)) {
    rule = categoryRuleMap.get('third_party_app');
  }
  if (rule && rule.autoApprove) {
    // Check severity filter. When a non-empty filter is set, a patch whose
    // severity is null cannot satisfy it and must NOT auto-approve — same
    // fail-closed posture as the policy and ring paths. (Previously a
    // null-severity patch short-circuited the filter and fell through.)
    if (rule.severityFilter && rule.severityFilter.length > 0) {
      if (!patch.severity || !rule.severityFilter.includes(patch.severity)) {
        return null; // Severity null, or not in allowed list
      }
    }

    // Check deferral period
    const deferralDays = rule.deferralDaysOverride ?? ringConfig.deferralDays;
    if (isHeldByDeferral(patch, deferralDays, now, 'category')) {
      return null;
    }

    return 'category_rule';
  }

  // Priority 3: Ring-level auto-approve (#1317). The ring now owns approval, so
  // this honors the configured severities AND a deferral window (held, not
  // approved, until the patch ages past it) — consistent with the policy-level
  // and category deferral semantics.
  //
  // FAIL-CLOSED at the read boundary (mirrors the write-side Zod refinement in
  // ringAutoApproveSchema): auto-approval requires an explicit, non-empty
  // severity set AND a patch severity that is in it. We must NOT trust that the
  // stored row went through the route schema — the manage_update_rings AI tool
  // and legacy boolean `true` rows can both produce `enabled` with empty
  // severities, which previously fell through and auto-approved EVERY pending
  // patch (auto-approve-all). A null-severity patch likewise never auto-approves
  // under a restricted list, matching the policy path above.
  if (ringAutoApprove.enabled) {
    if (ringAutoApprove.severities.length === 0) {
      // Enabled but no severities selected = approve nothing (fail-closed).
      return null;
    }
    // Third-party severity exemption (#2218): winget/chocolatey/homebrew
    // updates have no vendor severity concept — the agent/API ingest them with
    // severity='unknown' — so requiring membership in the ring's severity set
    // made third-party auto-approval dead configuration. When the policy has
    // EXPLICITLY opted into third-party sources ('third_party' in sources; the
    // default is ['os']) and this candidate is a third-party patch, skip the
    // severity MEMBERSHIP check only. Everything else stays fail-closed: the
    // empty-severities kill-switch above still approves nothing (a malformed
    // `{ enabled: true }` row stays inert), OS patches keep full severity
    // gating, and the source, category, app-rule, and deferral gates all still
    // apply to third-party candidates.
    // NOTE: this reads the RAW policy sources array for the literal
    // 'third_party' selection, while isThirdPartyPatchSource matches the
    // expanded patch-source bucket ('third_party' | 'custom'). The two stay in
    // lockstep because buildAllowedPatchSources only admits 'custom' rows via
    // the 'third_party' selection (or an explicit 'custom' entry) — if that
    // expansion table ever changes, revisit this line too.
    const severityExempt =
      isThirdPartyPatchSource(patch.source) &&
      (ringConfig.sources ?? []).includes('third_party');
    if (
      !severityExempt &&
      (!patch.severity || !ringAutoApprove.severities.includes(patch.severity))
    ) {
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
  /**
   * Deferral window in days for the ring auto-approve gate (#1317). 0 = no
   * deferral. A patch whose release date is within this window is held, not
   * approved, mirroring the policy-level / category deferral semantics.
   */
  deferralDays: number;
}

/**
 * Parse a ring's `autoApprove` JSONB into a typed config. Tolerant of every
 * historical shape so already-stored rings keep working after #1317:
 *  - boolean `true`  → enabled, EMPTY severity set, no deferral
 *  - `{ enabled: true, severities: [...] }` (no deferralDays) → deferral 0
 *  - `{ enabled: true, severities: [...], deferralDays: N }` → typed shape
 * Anything else (missing, `{}`, malformed) fails closed to disabled.
 *
 * NOTE: this parser is deliberately permissive about SHAPE but the approval
 * decision is fail-closed about MEANING. `enabled` with an empty severity set
 * (the legacy boolean `true`, an AI-tool-written `{ enabled: true }`, etc.)
 * auto-approves NOTHING — evaluatePatchApproval requires a non-empty severity
 * set before it will return 'ring_auto_approve'. This matches the write-side
 * Zod refinement (ringAutoApproveSchema) so the read path cannot become more
 * permissive than the writer, regardless of who wrote the row.
 */
function parseRingAutoApprove(autoApprove: unknown): RingAutoApproveConfig {
  // Boolean `true` shorthand: enabled but no explicit severities. Because the
  // read boundary fails closed on an empty severity set, this approves nothing.
  if (autoApprove === true) {
    return { enabled: true, severities: [], deferralDays: 0 };
  }

  if (!autoApprove || typeof autoApprove !== 'object') {
    return { enabled: false, severities: [], deferralDays: 0 };
  }

  const config = autoApprove as Record<string, unknown>;

  if (config.enabled === true) {
    const severities = Array.isArray(config.severities)
      ? config.severities.filter((s): s is string => typeof s === 'string')
      : [];
    const rawDeferral = config.deferralDays;
    const deferralDays =
      typeof rawDeferral === 'number' && Number.isInteger(rawDeferral) && rawDeferral > 0
        ? rawDeferral
        : 0;
    return { enabled: true, severities, deferralDays };
  }

  return { enabled: false, severities: [], deferralDays: 0 };
}
