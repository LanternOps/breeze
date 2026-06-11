/**
 * PAM Track 2 — Software-Policy Bridge
 * =====================================
 *
 * Pure lookup function consulted by the future PAM elevation-request handler.
 * Given a UAC-intercept candidate (an executable the agent saw a user try to
 * launch elevated), return whether the device's winning software_policy
 * (resolved via the existing config-policy hierarchy) matches the executable
 * on hash / signer / publisher / path, and whether the policy mode says we
 * should silently auto-elevate (allowlist) or auto-deny (blocklist).
 *
 * Out of scope (handled by the caller, not the bridge):
 *   - Inserting the elevation_requests row
 *   - Writing the elevation_audit row
 *   - Pushing rules to the agent for offline-cache use
 *   - Any UI / notification side effects
 *
 * The bridge is a PURE LOOKUP. Verdict in, side-effect-free verdict out.
 * The caller stores `verdict.policyId` in
 * `elevation_requests.software_policy_match_id` (Track 1 schema).
 *
 * Tenancy
 * -------
 * Runs through `withDbAccessContext` so the policy table query is RLS-scoped
 * exactly like every other lookup. Partner-scope callers will only see
 * policies for orgs the partner owns. Org-scope callers see only their own
 * org. The bridge takes the org_id as a parameter for explicit safety
 * (caller must already know it from the device row), but the DB context
 * is the actual enforcement.
 *
 * Match precedence (highest-confidence wins)
 * ------------------------------------------
 *   1. hash       — sha256 of the executable, exact match
 *   2. signer     — Authenticode signer CN, exact case-insensitive
 *   3. publisher  — Publisher field from the file's version info, exact CI
 *   4. path       — glob match against target_executable_path (case-insens.
 *                   on Windows-style paths)
 *
 * Reasoning: hash uniquely identifies an exact binary; signer cryptographically
 * identifies the producer; publisher is metadata that can be spoofed but is
 * still stronger than a path; path is weakest (renamed binaries, %TEMP%
 * payloads, etc).
 *
 * Mode tie-breaker (when allowlist AND blocklist policies both match)
 * -------------------------------------------------------------------
 * Because `resolveSoftwarePolicyForDevice` returns the SINGLE winning policy
 * per device (the existing config-policy resolver's closest-wins semantics),
 * there is at most one policy in scope for a given device at any moment.
 * `matchPoliciesAgainst` still accepts a list so tests can exercise the
 * tie-breaker logic and so future "all matching policies" semantics can be
 * plugged in without touching the matcher: blocklist beats allowlist, audit
 * is reported via `auditMatches` only.
 *
 * OS scoping
 * ----------
 * OS scoping is enforced at policy-ASSIGNMENT time via
 * `configPolicyAssignments.osFilter` (varchar[]), not per-rule. The bridge
 * does not need a per-rule `os` field — by the time `resolveSoftware-
 * PolicyForDevice` hands us a policy, the assignment-side OS filter has
 * already excluded mismatches.
 *
 * Rules shape
 * -----------
 * The bridge reads `softwarePolicies.rules.executable[]` (a parallel array
 * to the inventory matcher's `rules.software[]`). See
 * `SoftwarePolicyExecutableRule` in apps/api/src/db/schema/softwarePolicies.ts.
 * The inventory matcher continues to ignore `executable[]`, and the bridge
 * ignores `software[]`.
 */

import { eq } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbAccessContext, type DbAccessContext } from '../db';
import {
  softwarePolicies,
  type SoftwarePolicyExecutableRule,
  type SoftwarePolicyRulesDefinition,
} from '../db/schema';
import { resolveSoftwarePolicyForDevice } from './featureConfigResolver';

// ============================================================
// Types
// ============================================================

export type PamBridgeMatchedField = 'hash' | 'signer' | 'publisher' | 'path';
export type PamBridgeVerdictMode = 'allowlist' | 'blocklist';

export interface PamBridgeInput {
  /** Org the device belongs to. Caller must pass the device's org_id. */
  orgId: string;
  /** Device the elevation request is firing on. */
  deviceId: string;
  /** Absolute path the agent observed. Required for `uac_intercept` flow. */
  targetExecutablePath: string;
  /** sha256 lowercase hex; undefined if agent couldn't compute one. */
  targetExecutableHash?: string;
  /** Authenticode signer CN (e.g. "Adobe Inc."). Undefined if unsigned. */
  targetExecutableSigner?: string;
  /** Publisher field from version-info (e.g. "Adobe Systems Incorporated"). */
  targetPublisher?: string;
}

export interface PamBridgeAuditMatch {
  policyId: string;
  ruleName: string;
  matchedField: PamBridgeMatchedField;
}

export interface PamBridgeVerdict {
  /** null when no allow/block policy matched. Audit-only hits still go in
   *  `auditMatches`. */
  match: PamBridgeVerdictMode | null;
  policyId?: string;
  /** Rule index within `softwarePolicies.rules.executable[]`, for traceability. */
  ruleIndex?: number;
  /** The literal `name` of the matched rule (handy for UI / audit text). */
  ruleName?: string;
  matchedField?: PamBridgeMatchedField;
  /** All audit-mode policies that ALSO matched this binary. The caller
   *  records these to elevation_audit with event_type='evidence_attached'
   *  but the verdict itself is unaffected. */
  auditMatches: PamBridgeAuditMatch[];
}

// ============================================================
// Public API
// ============================================================

/**
 * Evaluate a UAC-intercept candidate against the device's active software
 * policy. MUST be called inside a `withDbAccessContext` scope — wrap the
 * call site, not this function, so the caller's auth context is preserved.
 *
 * Returns the highest-confidence binding verdict, or `{match: null}` if no
 * allow/block policy matched. `auditMatches` lists audit-mode hits regardless
 * of verdict.
 */
export async function evaluatePamBridge(
  input: PamBridgeInput
): Promise<PamBridgeVerdict> {
  // RLS context guard. Without an active withDbAccessContext, the
  // softwarePolicies query below would fall through to the bare pool
  // (unprivileged `breeze_app`, no `breeze.scope` / `breeze.org_id` GUC),
  // RLS would deny, and the bridge would silently return {match: null} —
  // effectively skipping the blocklist auto-deny. Fail loud instead.
  if (!hasDbAccessContext()) {
    throw new Error(
      'evaluatePamBridge: no active DB access context. Wrap the call in withDbAccessContext (request path) or evaluatePamBridgeWithContext / withSystemDbAccessContext (background path).'
    );
  }
  const policies = await loadActivePoliciesForDevice(input.deviceId);
  return matchPoliciesAgainst(input, policies);
}

/**
 * Convenience wrapper that opens a system-scoped DB context for use by the
 * agent WS path (where the request isn't tied to a Breeze user). Mirrors the
 * pattern in softwareComplianceWorker.ts:26-34.
 *
 * Prefer `evaluatePamBridge` from request paths so the user's auth context
 * is honored.
 */
export async function evaluatePamBridgeWithContext(
  context: DbAccessContext,
  input: PamBridgeInput
): Promise<PamBridgeVerdict> {
  return withDbAccessContext(context, () => evaluatePamBridge(input));
}

// ============================================================
// Internals — exported only for the test file
// ============================================================

/**
 * Pure matcher: given a candidate and a fully-loaded policy list, compute
 * the verdict. Exported so tests can drive it without a DB.
 *
 * Production today passes 0 or 1 policy (the winner from
 * `resolveSoftwarePolicyForDevice`). The matcher tolerates an N-element list
 * so the precedence / mode-tie-breaker logic stays exercised by unit tests
 * and can be reused if the resolver ever returns multiple policies.
 */
export function matchPoliciesAgainst(
  input: PamBridgeInput,
  policies: LoadedPolicy[]
): PamBridgeVerdict {
  type Hit = {
    policy: LoadedPolicy;
    ruleIndex: number;
    rule: SoftwarePolicyExecutableRule;
    field: PamBridgeMatchedField;
  };

  const allowHits: Hit[] = [];
  const blockHits: Hit[] = [];
  const auditHits: Hit[] = [];

  for (const policy of policies) {
    const rules = policy.rules?.executable ?? [];
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      if (!rule) continue;
      const field = matchRule(input, rule);
      if (!field) continue;

      const hit: Hit = { policy, ruleIndex: i, rule, field };
      if (policy.mode === 'allowlist') allowHits.push(hit);
      else if (policy.mode === 'blocklist') blockHits.push(hit);
      else if (policy.mode === 'audit') auditHits.push(hit);
    }
  }

  const auditMatches: PamBridgeAuditMatch[] = auditHits.map((h) => ({
    policyId: h.policy.id,
    ruleName: h.rule.name,
    matchedField: h.field,
  }));

  // Tie-breaker: blocklist beats allowlist (safety default).
  const binding = pickStrongestHit(blockHits) ?? pickStrongestHit(allowHits);
  if (!binding) {
    return { match: null, auditMatches };
  }

  return {
    match: binding.policy.mode === 'blocklist' ? 'blocklist' : 'allowlist',
    policyId: binding.policy.id,
    ruleIndex: binding.ruleIndex,
    ruleName: binding.rule.name,
    matchedField: binding.field,
    auditMatches,
  };
}

const FIELD_PRECEDENCE: Record<PamBridgeMatchedField, number> = {
  hash: 0,
  signer: 1,
  publisher: 2,
  path: 3,
};

function pickStrongestHit<T extends { field: PamBridgeMatchedField; policy: { priority: number } }>(
  hits: T[]
): T | null {
  if (hits.length === 0) return null;
  let best = hits[0]!;
  for (let i = 1; i < hits.length; i += 1) {
    const candidate = hits[i]!;
    if (FIELD_PRECEDENCE[candidate.field] < FIELD_PRECEDENCE[best.field]) {
      best = candidate;
      continue;
    }
    if (FIELD_PRECEDENCE[candidate.field] === FIELD_PRECEDENCE[best.field]) {
      // Same field strength → higher numeric priority wins. (See
      // softwarePolicies.priority: integer default 50, higher = more important.)
      if (candidate.policy.priority > best.policy.priority) {
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * One-rule matcher. Returns the matched field (highest precedence checked
 * first), or null. Pure function — no I/O.
 */
function matchRule(
  input: PamBridgeInput,
  rule: SoftwarePolicyExecutableRule
): PamBridgeMatchedField | null {
  // 1. hash (strongest)
  if (rule.sha256 && input.targetExecutableHash) {
    if (rule.sha256.toLowerCase() === input.targetExecutableHash.toLowerCase()) {
      return 'hash';
    }
  }
  // 2. signer
  if (rule.signer && input.targetExecutableSigner) {
    if (rule.signer.trim().toLowerCase() === input.targetExecutableSigner.trim().toLowerCase()) {
      return 'signer';
    }
  }
  // 3. publisher
  if (rule.publisher && input.targetPublisher) {
    if (rule.publisher.trim().toLowerCase() === input.targetPublisher.trim().toLowerCase()) {
      return 'publisher';
    }
  }
  // 4. path glob (weakest)
  if (rule.pathGlob && input.targetExecutablePath) {
    if (matchPathGlob(rule.pathGlob, input.targetExecutablePath)) {
      return 'path';
    }
  }
  return null;
}

/**
 * Windows-style case-insensitive glob: `*` matches anything except path
 * separator, `**` matches anything including separators. Normalizes both
 * sides to forward slashes before comparison.
 *
 * Mirrors the wildcard handling in softwarePolicyService.matchesSoftwareRule
 * (softwarePolicyService.ts:185-214) but extended for `**` since PAM rules
 * commonly say `C:\Program Files\Adobe\**\*.exe`.
 */
export function matchPathGlob(glob: string, path: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const target = norm(path);
  // Use a NUL sentinel for `**` so a literal space in the glob (e.g. the
  // `Program Files` segment of every Windows install path) can never be
  // misinterpreted as the wildcard placeholder. A printable placeholder
  // here is a security bug: a blocklist rule for `C:\Program Files\Evil.exe`
  // would otherwise produce regex `^c:/program.*files/evil\.exe$` and match
  // attacker-controlled non-default install paths like `c:/programXfilesY/`.
  const escaped = norm(glob)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')   // escape regex metas (space NOT included — good)
    .replace(/\*\*/g, '\x00')                  // ** → NUL sentinel
    .replace(/\*/g, '[^/]*')                   // * → single-segment wildcard
    .replace(/\x00/g, '.*');                   // sentinel → real .*
  const re = new RegExp(`^${escaped}$`);
  return re.test(target);
}

// ============================================================
// DB load — narrowed slice of softwarePolicies for the bridge
// ============================================================

export type LoadedPolicy = {
  id: string;
  mode: typeof softwarePolicies.$inferSelect.mode;
  priority: number;
  rules: SoftwarePolicyRulesDefinition;
};

/**
 * Load the device's currently winning software policy via the existing
 * config-policy hierarchy resolver. Returns a 0- or 1-element array (the
 * resolver picks the single closest-wins policy across all 5 assignment
 * levels: partner / organization / site / device_group / device).
 *
 * Caller is expected to have already established a `withDbAccessContext`
 * scope. RLS enforces visibility on the policy row fetch.
 */
export async function loadActivePoliciesForDevice(
  deviceId: string
): Promise<LoadedPolicy[]> {
  const winningPolicyId = await resolveSoftwarePolicyForDevice(deviceId);
  if (!winningPolicyId) return [];

  const rows = await db
    .select({
      id: softwarePolicies.id,
      mode: softwarePolicies.mode,
      priority: softwarePolicies.priority,
      rules: softwarePolicies.rules,
      isActive: softwarePolicies.isActive,
    })
    .from(softwarePolicies)
    .where(eq(softwarePolicies.id, winningPolicyId))
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) return [];

  return [
    {
      id: row.id,
      mode: row.mode,
      priority: row.priority,
      rules: row.rules as SoftwarePolicyRulesDefinition,
    },
  ];
}
