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
 */
import type { PamRule, PamRuleTimeWindow } from '../db/schema/pam';
import { matchPathGlob } from './pamBridge';

export interface PamRuleCandidate {
  targetExecutablePath: string;
  targetExecutableHash?: string;
  targetExecutableSigner?: string;
  subjectUsername: string;
  parentImage?: string;
  /** AD/local group names of the subject, when known. */
  subjectAdGroups?: string[];
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

// A time window NARROWS a rule; it is not an identifying criterion on its
// own. A rule whose only "criterion" is a time window would match every
// elevation in the org while active — catastrophic for verdict=auto_approve.
// The API layer rejects creating such rules; the engine refuses them too.
function hasAnyCriteria(rule: PamRule): boolean {
  return Boolean(
    rule.matchSigner ||
      rule.matchHash ||
      rule.matchPathGlob ||
      rule.matchParentImage ||
      rule.matchUser ||
      rule.matchAdGroup,
  );
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

function ruleMatches(rule: PamRule, candidate: PamRuleCandidate): boolean {
  if (!hasAnyCriteria(rule)) return false;

  if (rule.matchHash) {
    if (!candidate.targetExecutableHash) return false;
    if (!eqCi(rule.matchHash, candidate.targetExecutableHash)) return false;
  }
  if (rule.matchSigner) {
    if (!candidate.targetExecutableSigner) return false;
    if (!eqCi(rule.matchSigner, candidate.targetExecutableSigner)) return false;
  }
  if (rule.matchPathGlob) {
    if (!matchPathGlob(rule.matchPathGlob, candidate.targetExecutablePath)) return false;
  }
  if (rule.matchParentImage) {
    if (!candidate.parentImage) return false;
    if (!matchPathGlob(rule.matchParentImage, candidate.parentImage)) return false;
  }
  if (rule.matchUser) {
    if (!eqCi(rule.matchUser, candidate.subjectUsername)) return false;
  }
  if (rule.matchAdGroup) {
    const groups = candidate.subjectAdGroups ?? [];
    if (!groups.some((g) => eqCi(g, rule.matchAdGroup!))) return false;
  }
  if (rule.timeWindow) {
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
    if (ruleMatches(rule, candidate)) {
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
