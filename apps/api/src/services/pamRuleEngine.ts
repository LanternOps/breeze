/**
 * PAM-native rule engine (#1163).
 *
 * Pure matcher over `pam_rules` rows for an elevation candidate. Consulted
 * by ingest (routes/agents/elevationRequests.ts) AFTER the software-policy
 * bridge (services/pamBridge.ts) returns no binding verdict. Same contract
 * as the bridge: verdict in, side-effect-free verdict out — the caller does
 * all inserts/audits/events.
 *
 * Matching semantics
 * ------------------
 * - Rules are evaluated in (priority ASC, createdAt ASC, id ASC) order;
 *   the FIRST enabled rule whose criteria all match wins.
 * - All provided criteria on a rule are ANDed. A rule with no criteria at
 *   all matches nothing (the API layer rejects creating those, but the
 *   engine guards anyway — a criteria-less rule must never become a
 *   tenant-wide auto_approve).
 * - signer / user: exact, case-insensitive.
 * - hash: exact, case-insensitive (sha256 hex).
 * - path / parent image: Windows-style case-insensitive glob via
 *   pamBridge.matchPathGlob (shared semantics — `*` is single-segment,
 *   `**` crosses segments).
 * - ad_group: matches only when the caller supplies the subject's group
 *   list (the uac_intercept ingest payload doesn't today, so ad_group
 *   rules simply never match that flow until the agent ships groups).
 * - time_window: "HH:MM"–"HH:MM" with optional days[0-6] in the window's
 *   timezone (default UTC). Overnight windows (start > end) wrap midnight.
 * - tool_name / risk_tier (Phase 1 helper governance): exact tool-name
 *   (case-insensitive) and exact tier match for ai_tool_action candidates;
 *   evaluated via evaluatePamToolActionRules, which only considers rules
 *   carrying a tool-action criterion.
 */
import type { PamRule, PamRuleNegateKey, PamRuleTimeWindow } from '../db/schema/pam';
import { matchPathGlob } from './pamBridge';

export interface PamRuleCandidate {
  /** Absent for ai_tool_action candidates. */
  targetExecutablePath?: string;
  targetExecutableHash?: string;
  targetExecutableSigner?: string;
  subjectUsername: string;
  parentImage?: string;
  /** Launched process command line, when the agent captured it. */
  commandLine?: string;
  /** AD/local group names of the subject, when known. */
  subjectAdGroups?: string[];
  /** ai_tool_action candidates: bare tool name (no mcp__ prefix). */
  toolName?: string;
  /** ai_tool_action candidates: guardrail tier (2–3 today). */
  riskTier?: number;
  /** Evaluation instant; injectable for tests. Defaults to now. */
  at?: Date;
}

export interface PamRuleMatch {
  ruleId: string;
  ruleName: string;
  verdict: PamRule['verdict'];
  approvalDurationMinutes: number | null;
}

const eqCi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Resolved signer groups: groupId → member signer patterns. The caller
 * (ingest / preview) fetches the org's referenced pam_signer_groups and passes
 * this map so the pure engine can evaluate matchSignerGroupId without DB access.
 * A rule whose group is absent from the map (or has no members) fails closed.
 */
export type SignerGroupResolver = ReadonlyMap<string, readonly string[]>;

// A time window NARROWS a rule; it is not an identifying criterion on its
// own. A rule whose only "criterion" is a time window would match every
// elevation in the org while active — catastrophic for verdict=auto_approve.
// The API layer rejects creating such rules; the engine refuses them too.
function hasAnyCriteria(rule: PamRule): boolean {
  return Boolean(
    rule.matchSigner ||
      rule.matchSignerGroupId ||
      rule.matchHash ||
      rule.matchPathGlob ||
      rule.matchParentImage ||
      rule.matchCommandLine ||
      rule.matchUser ||
      rule.matchAdGroup ||
      rule.matchToolName ||
      rule.matchRiskTier != null,
  );
}

/**
 * A rule is tool-action-shaped when it carries a tool-action criterion
 * (Phase 1 helper governance). Tool-action evaluation only considers these
 * rules; the API layer rejects mixing them with executable criteria.
 */
export function hasToolActionCriterion(
  rule: Pick<PamRule, 'matchToolName' | 'matchRiskTier'>,
): boolean {
  return Boolean(rule.matchToolName) || rule.matchRiskTier != null;
}

/** Exported for tests. */
export function isWithinTimeWindow(window: PamRuleTimeWindow, at: Date): boolean {
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };
  const start = parse(window.start);
  const end = parse(window.end);
  if (start === null || end === null) return false; // malformed → never active

  // Resolve weekday + minutes in the window's timezone (default UTC).
  let weekday: number;
  let minutes: number;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: window.timezone ?? 'UTC',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    weekday = dayNames.indexOf(get('weekday'));
    // 'hour' can render as "24" for midnight in some ICU versions; normalize.
    minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  } catch {
    return false; // bad timezone string → never active
  }
  if (weekday < 0 || Number.isNaN(minutes)) return false;

  if (window.days && window.days.length > 0 && !window.days.includes(weekday)) {
    return false;
  }
  // Overnight windows (e.g. 22:00–06:00) wrap midnight.
  return start <= end
    ? minutes >= start && minutes <= end
    : minutes >= start || minutes <= end;
}

function ruleMatches(
  rule: PamRule,
  candidate: PamRuleCandidate,
  signerGroups?: SignerGroupResolver,
): boolean {
  if (!hasAnyCriteria(rule)) return false;

  const negate = new Set<PamRuleNegateKey>(rule.matchNegate ?? []);
  // A criterion is satisfied when its candidate data is PRESENT and the
  // comparison holds (or, for a negated criterion, fails to hold). Absent
  // candidate data NEVER satisfies a criterion — negation can't accidentally
  // turn missing data into a tenant-wide grant.
  const satisfied = (key: PamRuleNegateKey, present: boolean, positive: boolean): boolean => {
    if (!present) return false;
    return negate.has(key) ? !positive : positive;
  };

  if (rule.matchHash) {
    const present = candidate.targetExecutableHash != null;
    const positive = present && eqCi(rule.matchHash, candidate.targetExecutableHash!);
    if (!satisfied('hash', present, positive)) return false;
  }
  if (rule.matchSigner) {
    const present = candidate.targetExecutableSigner != null;
    const positive = present && eqCi(rule.matchSigner, candidate.targetExecutableSigner!);
    if (!satisfied('signer', present, positive)) return false;
  }
  if (rule.matchSignerGroupId) {
    // Match the candidate signer against ANY member of the resolved group.
    // Unresolvable (group missing from the map or empty) or no candidate signer
    // → not present → fails closed, even when negated.
    const members = signerGroups?.get(rule.matchSignerGroupId);
    const present =
      candidate.targetExecutableSigner != null && members != null && members.length > 0;
    const positive =
      present && members!.some((s) => eqCi(s, candidate.targetExecutableSigner!));
    if (!satisfied('signerGroup', present, positive)) return false;
  }
  if (rule.matchPathGlob) {
    const present = candidate.targetExecutablePath != null;
    const positive = present && matchPathGlob(rule.matchPathGlob, candidate.targetExecutablePath!);
    if (!satisfied('pathGlob', present, positive)) return false;
  }
  if (rule.matchParentImage) {
    const present = candidate.parentImage != null;
    const positive = present && matchPathGlob(rule.matchParentImage, candidate.parentImage!);
    if (!satisfied('parentImage', present, positive)) return false;
  }
  if (rule.matchCommandLine) {
    const present = candidate.commandLine != null;
    const positive =
      present && candidate.commandLine!.toLowerCase().includes(rule.matchCommandLine.toLowerCase());
    if (!satisfied('commandLine', present, positive)) return false;
  }
  if (rule.matchUser) {
    // subjectUsername is always present on a candidate.
    const positive = eqCi(rule.matchUser, candidate.subjectUsername);
    if (!satisfied('user', true, positive)) return false;
  }
  if (rule.matchAdGroup) {
    const present = candidate.subjectAdGroups !== undefined;
    const positive =
      present && candidate.subjectAdGroups!.some((g) => eqCi(g, rule.matchAdGroup!));
    if (!satisfied('adGroup', present, positive)) return false;
  }
  if (rule.matchToolName) {
    const present = candidate.toolName != null;
    const positive = present && eqCi(rule.matchToolName, candidate.toolName!);
    if (!satisfied('toolName', present, positive)) return false;
  }
  if (rule.matchRiskTier != null) {
    const present = candidate.riskTier != null;
    const positive = present && rule.matchRiskTier === candidate.riskTier;
    if (!satisfied('riskTier', present, positive)) return false;
  }
  if (rule.timeWindow) {
    // A time window NARROWS; it is never negated.
    if (!isWithinTimeWindow(rule.timeWindow, candidate.at ?? new Date())) return false;
  }
  return true;
}

/**
 * Evaluate a candidate against a pre-fetched, RLS-scoped list of rules.
 * Returns the first matching enabled rule in priority order, or null.
 * The caller fetches rules (org-scoped, optionally site-narrowed) — this
 * function is pure so tests and the offline-cache sync can reuse it.
 */
export function evaluatePamRules(
  rules: PamRule[],
  candidate: PamRuleCandidate,
  signerGroups?: SignerGroupResolver,
): PamRuleMatch | null {
  const ordered = [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const at = a.createdAt?.getTime() ?? 0;
    const bt = b.createdAt?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });
  for (const rule of ordered) {
    if (!rule.enabled) continue;
    if (ruleMatches(rule, candidate, signerGroups)) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        verdict: rule.verdict,
        approvalDurationMinutes: rule.approvalDurationMinutes ?? null,
      };
    }
  }
  return null;
}

/**
 * Evaluate an ai_tool_action candidate (Phase 1 helper governance). Only
 * rules carrying at least one tool-action criterion participate — a
 * pre-existing user-only or executable rule must never govern Helper tool
 * actions (e.g. a matchUser-only UAC rule with verdict=auto_approve).
 */
export function evaluatePamToolActionRules(
  rules: PamRule[],
  candidate: PamRuleCandidate,
): PamRuleMatch | null {
  return evaluatePamRules(rules.filter(hasToolActionCriterion), candidate);
}
