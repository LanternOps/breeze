import { describe, expect, it } from 'vitest';
import {
  ALERT_RESOLUTION_REASONS,
  FIX_COUNTED_RESULTS,
  FIX_OUTCOME_ACTIVE_STATES,
  FIX_OUTCOME_STATES,
  FIX_OUTCOME_TERMINAL_STATES,
  FIX_OUTCOME_WINDOWS,
  FIX_PROOF_RULES,
  FIX_SIGNATURE_VERSION,
  FIX_TELEMETRY_FRESHNESS,
  REMEDIATION_SUGGESTION_ORIGINS,
  isFixOutcomeTerminal,
} from './index';

describe('fix memory constants', () => {
  it('pins the spec proof-rule defaults', () => {
    expect(FIX_PROOF_RULES).toEqual({
      minVerified: 3,
      minSuccessRate: 0.8,
      rollingWindow: 20,
      noRecurrenceInLast: 3,
      demoteAfterConsecutiveFailures: 2,
      liftDemotionAfterConsecutiveVerified: 3,
    });
    expect(Object.isFrozen(FIX_PROOF_RULES)).toBe(true);
  });

  it('pins the watch windows and the freshness probe', () => {
    expect(FIX_OUTCOME_WINDOWS).toEqual({ pendingTimeoutHours: 24, recoveryTimeoutHours: 24, holdHours: 24 });
    expect(FIX_TELEMETRY_FRESHNESS).toEqual({ bucketMinutes: 30, minCoverage: 0.8, maxHeartbeatAgeMinutes: 30 });
    expect(FIX_SIGNATURE_VERSION).toBe(1);
  });

  it('active and terminal states partition the state set exactly', () => {
    const union = [...FIX_OUTCOME_ACTIVE_STATES, ...FIX_OUTCOME_TERMINAL_STATES].sort();
    expect(union).toEqual([...FIX_OUTCOME_STATES].sort());
    for (const s of FIX_OUTCOME_ACTIVE_STATES) expect(isFixOutcomeTerminal(s)).toBe(false);
    for (const s of FIX_OUTCOME_TERMINAL_STATES) expect(isFixOutcomeTerminal(s)).toBe(true);
  });

  it('counted results are a subset of terminal states and exclude inconclusive/cancelled', () => {
    for (const r of FIX_COUNTED_RESULTS) expect(FIX_OUTCOME_TERMINAL_STATES).toContain(r);
    expect(FIX_COUNTED_RESULTS).not.toContain('inconclusive');
    expect(FIX_COUNTED_RESULTS).not.toContain('cancelled');
  });

  it('keeps catalog_match as an origin (the column default) and condition_cleared as a reason', () => {
    expect(REMEDIATION_SUGGESTION_ORIGINS).toContain('catalog_match');
    expect(ALERT_RESOLUTION_REASONS).toContain('condition_cleared');
  });
});
