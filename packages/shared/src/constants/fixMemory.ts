/**
 * Fix memory (AI Suggested Fixes W1). Every literal set below is mirrored 1:1
 * by a CHECK constraint in apps/api/migrations/2026-11-08-170000-fix-memory-tables.sql,
 * 2026-11-08-170100-remediation-suggestion-origin.sql or
 * 2026-11-08-170200-alert-resolution-reason.sql — edit both sides together;
 * apps/api/src/db/schema/fixMemory.registry.test.ts fails otherwise.
 *
 * Leaf module: no imports. The package root barrel is bundled into the browser.
 */
export const FIX_SIGNATURE_VERSION = 1 as const;

export const FIX_SIGNATURE_FAMILIES = ['alert', 'anomaly', 'correlation'] as const;
export type FixSignatureFamily = (typeof FIX_SIGNATURE_FAMILIES)[number];

/** Discriminators are extracted from STRUCTURED fields only, never free text. */
export const FIX_DISCRIMINATOR_KINDS = ['service', 'process', 'software', 'exit_code', 'kb', 'event_id'] as const;
export type FixDiscriminatorKind = (typeof FIX_DISCRIMINATOR_KINDS)[number];

export const FIX_KINDS = ['system_script', 'partner_script', 'org_script', 'builtin_action', 'playbook', 'manual_steps'] as const;
export type FixKind = (typeof FIX_KINDS)[number];

export const FIX_OUTCOME_STATES = [
  'pending', 'awaiting_recovery', 'holding',
  'verified', 'failed', 'recurred', 'inconclusive', 'cancelled',
] as const;
export type FixOutcomeState = (typeof FIX_OUTCOME_STATES)[number];

export const FIX_OUTCOME_ACTIVE_STATES = ['pending', 'awaiting_recovery', 'holding'] as const satisfies readonly FixOutcomeState[];
export const FIX_OUTCOME_TERMINAL_STATES = ['verified', 'failed', 'recurred', 'inconclusive', 'cancelled'] as const satisfies readonly FixOutcomeState[];

/** The only results that count as an attempt. inconclusive/cancelled never count. */
export const FIX_COUNTED_RESULTS = ['verified', 'failed', 'recurred'] as const;
export type FixCountedResult = (typeof FIX_COUNTED_RESULTS)[number];

export const FIX_MEMORY_STATUSES = ['active', 'demoted', 'retired'] as const;
export type FixMemoryStatus = (typeof FIX_MEMORY_STATUSES)[number];

export const FIX_VOTES = ['up', 'down'] as const;
export type FixVote = (typeof FIX_VOTES)[number];

export const REMEDIATION_SUGGESTION_ORIGINS = ['catalog_match', 'memory', 'ai_research'] as const;
export type RemediationSuggestionOrigin = (typeof REMEDIATION_SUGGESTION_ORIGINS)[number];

/**
 * Why an alert resolved. Only `condition_cleared` with `resolved_by IS NULL` is
 * objective recovery for the outcome watcher; NULL (unspecified) fails closed.
 */
export const ALERT_RESOLUTION_REASONS = ['condition_cleared', 'source_retired', 'expired', 'manual'] as const;
export type AlertResolutionReason = (typeof ALERT_RESOLUTION_REASONS)[number];

/** Spec "Proof rule" defaults. Tunables, not contracts — change here only. */
export const FIX_PROOF_RULES = Object.freeze({
  minVerified: 3,
  minSuccessRate: 0.8,
  rollingWindow: 20,
  noRecurrenceInLast: 3,
  demoteAfterConsecutiveFailures: 2,
  liftDemotionAfterConsecutiveVerified: 3,
} as const);

/** Spec "Outcome lifecycle" windows. */
export const FIX_OUTCOME_WINDOWS = Object.freeze({
  pendingTimeoutHours: 24,
  recoveryTimeoutHours: 24,
  holdHours: 24,
} as const);

/**
 * Telemetry freshness during the hold: the device heartbeat must be no older
 * than maxHeartbeatAgeMinutes at hold end, and at least minCoverage of the
 * bucketMinutes-wide buckets across the hold must contain a metric sample.
 */
export const FIX_TELEMETRY_FRESHNESS = Object.freeze({
  bucketMinutes: 30,
  minCoverage: 0.8,
  maxHeartbeatAgeMinutes: 30,
} as const);

export function isFixOutcomeTerminal(state: FixOutcomeState): boolean {
  return (FIX_OUTCOME_TERMINAL_STATES as readonly string[]).includes(state);
}
