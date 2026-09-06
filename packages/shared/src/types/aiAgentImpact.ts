/**
 * Phase 2 wave P2-6 (#4193) — the "AI operations impact" reporting surface.
 * Reads `ai_agent_impact_daily`, a per-org/per-day rollup of AI-agent outcome
 * counters, and turns it into an estimated-time-saved dashboard plus a PDF
 * export. Everything here is a DERIVED estimate, never a measured fact —
 * see `estimateSecondsSaved`'s docstring — and the DTO never carries
 * model-authored text (run summaries, verdict rationale, ticket text, intent
 * `reason`, or tool arguments): see the plan's "Leak rules".
 */

export const AI_AGENT_IMPACT_WINDOWS = [7, 30, 90] as const;
export type AiAgentImpactWindow = (typeof AI_AGENT_IMPACT_WINDOWS)[number];

/** Camel-case DTO keys, in the column order of `ai_agent_impact_daily`. */
export const AI_AGENT_IMPACT_COUNTER_KEYS = [
  'alertsJudged', 'noiseFlagged', 'suppressionsApplied', 'ticketsTriaged', 'draftsSent',
  'fixesProposed', 'fixesExecuted', 'fixWatchesHeld', 'fixWatchesRecurred', 'narrativesDelivered',
] as const;
export type AiAgentImpactCounterKey = (typeof AI_AGENT_IMPACT_COUNTER_KEYS)[number];
export type AiAgentImpactCounters = Record<AiAgentImpactCounterKey, number>;

/**
 * Seconds of human time one outcome is credited with. Six priced outcomes;
 * the other four counters (suppressions, proposals, both watch states) are
 * reported but deliberately unpriced — they are funnel/quality signal, not
 * saved time.
 */
export interface ImpactWeights {
  alertJudged: number;
  noiseFlagged: number;
  ticketTriaged: number;
  draftSent: number;
  fixExecuted: number;
  narrativeDelivered: number;
}
export type ImpactWeightOverrides = Partial<ImpactWeights>;
export const IMPACT_WEIGHT_KEYS = [
  'alertJudged', 'noiseFlagged', 'ticketTriaged', 'draftSent', 'fixExecuted', 'narrativeDelivered',
] as const;
export const IMPACT_WEIGHT_MAX_SECONDS = 86_400;
export const DEFAULT_IMPACT_WEIGHTS: Readonly<ImpactWeights> = Object.freeze({
  alertJudged: 90, noiseFlagged: 240, ticketTriaged: 360, draftSent: 300,
  fixExecuted: 900, narrativeDelivered: 1800,
});

/** The counter each priced weight is multiplied against, in `estimateSecondsSaved`. */
const IMPACT_WEIGHT_COUNTER: Record<(typeof IMPACT_WEIGHT_KEYS)[number], AiAgentImpactCounterKey> = {
  alertJudged: 'alertsJudged',
  noiseFlagged: 'noiseFlagged',
  ticketTriaged: 'ticketsTriaged',
  draftSent: 'draftsSent',
  fixExecuted: 'fixesExecuted',
  narrativeDelivered: 'narrativesDelivered',
};

function isValidWeightValue(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= IMPACT_WEIGHT_MAX_SECONDS;
}

/**
 * The stored overrides, normalized: unknown keys dropped, out-of-range
 * dropped. Returns null when nothing valid survives (equivalent to "no
 * overrides"). Tolerates null/undefined/garbage — `stored` is an
 * operator-editable jsonb column, so this is the boundary that keeps a
 * malformed row from ever reaching a caller as anything but "use defaults".
 */
export function normalizeImpactWeightOverrides(stored: unknown): ImpactWeightOverrides | null {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const source = stored as Record<string, unknown>;
  const result: ImpactWeightOverrides = {};
  let any = false;
  for (const key of IMPACT_WEIGHT_KEYS) {
    const value = source[key];
    if (isValidWeightValue(value)) {
      result[key] = value;
      any = true;
    }
  }
  return any ? result : null;
}

/**
 * Merge a stored partial override object onto the frozen defaults. Tolerates
 * null/undefined/garbage (an operator-editable jsonb column): any key that
 * is not a finite integer in [0, IMPACT_WEIGHT_MAX_SECONDS] falls back to
 * its default.
 */
export function resolveImpactWeights(stored: unknown): ImpactWeights {
  const overrides = normalizeImpactWeightOverrides(stored);
  return overrides ? { ...DEFAULT_IMPACT_WEIGHTS, ...overrides } : { ...DEFAULT_IMPACT_WEIGHTS };
}

/**
 * Read-time estimate. Only the six priced counters contribute — the other
 * four (`suppressionsApplied`, `fixesProposed`, `fixWatchesHeld`,
 * `fixWatchesRecurred`) are deliberately excluded, see `ImpactWeights`'s
 * docstring. This is an ESTIMATE, not a measurement: label it "Estimated
 * time saved" on every surface, never "time saved".
 */
export function estimateSecondsSaved(counters: AiAgentImpactCounters, weights: ImpactWeights): number {
  let total = 0;
  for (const weightKey of IMPACT_WEIGHT_KEYS) {
    total += counters[IMPACT_WEIGHT_COUNTER[weightKey]] * weights[weightKey];
  }
  return total;
}

export const AI_AGENT_IMPACT_DTO_SCHEMA_VERSION = 1 as const;
export const AI_AGENT_IMPACT_BY_ORG_LIMIT = 50;
export const AI_AGENT_IMPACT_REBUILD_MAX_ORGS = 200;
export const AI_AGENT_IMPACT_REBUILD_DAYS = 90;

export interface AiAgentImpactTotalsDto extends AiAgentImpactCounters {
  estSecondsSaved: number;
  llmCents: number;
}
export interface AiAgentImpactBucketDto extends AiAgentImpactTotalsDto {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
}
export interface AiAgentImpactOrgRowDto extends AiAgentImpactTotalsDto {
  orgId: string;
  orgName: string;
}
export interface AiAgentImpactDto {
  schemaVersion: typeof AI_AGENT_IMPACT_DTO_SCHEMA_VERSION;
  window: AiAgentImpactWindow;
  /** Last COMPLETE UTC day covered, `YYYY-MM-DD`. Never the current UTC day. */
  through: string;
  /**
   * MIN(rebuilt_at) over the included buckets — the conservative freshness
   * answer. ISO-8601, or null when the window holds no rows at all.
   */
  rebuiltAt: string | null;
  totals: AiAgentImpactTotalsDto;
  series: AiAgentImpactBucketDto[];
  /**
   * Partner scope only; empty for organization and system scope. Top
   * AI_AGENT_IMPACT_BY_ORG_LIMIT rows by estSecondsSaved, descending.
   */
  byOrg: AiAgentImpactOrgRowDto[];
  byOrgTruncated: boolean;
  /**
   * LIVE verdict rows (`superseded_by IS NULL`) whose `feedback_at` falls in
   * the window. `rate = up / (up + down)`, null when both are zero.
   * Labelled "positive feedback rate" in every surface — never "precision".
   */
  positiveFeedback: { up: number; down: number; rate: number | null };
  /**
   * `(org, agent, op_key)` tuples in `ai_agent_graduation` state `eligible`
   * over the same accessible-org set as `totals` — "operations ready to be
   * promoted to pre-authorized execution". Refreshed by the daily graduation
   * pass and by every graduation read, so it may lag the graduation panel by
   * one pass; surface it as a LINK to that panel, never as a list.
   * `number | null` only so an older API behind a newer web build still
   * renders — v1 always returns a number.
   */
  promoteEligibleCount: number | null;
  weights: { effective: ImpactWeights; overrides: ImpactWeightOverrides | null };
  canEditWeights: boolean;
}
