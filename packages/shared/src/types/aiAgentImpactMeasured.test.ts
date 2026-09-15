import { describe, expect, it } from 'vitest';

import {
  ALERT_EXPOSURE_AGE_MINUTES,
  ALERT_OUTCOME_HORIZON_HOURS,
  MEASURED_MAX_WINDOW_DAYS,
  MEASURED_MIN_COHORT_N,
  MEASURED_OMISSION_REASONS,
  TICKET_EXPOSURE_AGE_MINUTES,
  TICKET_RESPONSE_HORIZON_HOURS,
} from './aiAgentImpactMeasured';
import { impactMeasuredQuerySchema } from '../validators/aiAgentImpactMeasured';

describe('measured-impact cohort constants', () => {
  it('the cohort-formation age exceeds the scheduler delay before any AI analysis starts', () => {
    // apps/api/src/jobs/alertVerdictScheduler.ts -- UNGROUPED_VERDICT_DELAY_MINUTES = 10.
    // An alert must stay open and uncorrelated for 10 minutes before it gets its own
    // verdict run. If L <= that, the AI arm is systematically empty and the comparison
    // is vacuous. packages/shared must not import from apps/api, so the literal is
    // asserted here and the real cross-check lives in
    // apps/api/src/services/aiAgents/impactMeasured.contract.test.ts.
    expect(ALERT_EXPOSURE_AGE_MINUTES).toBeGreaterThan(10);
    expect(TICKET_EXPOSURE_AGE_MINUTES).toBeGreaterThan(10);
  });

  it('pins the display gate and the window cap', () => {
    expect(MEASURED_MIN_COHORT_N).toBe(20);
    expect(MEASURED_MAX_WINDOW_DAYS).toBe(90);
  });

  it('pins the outcome horizons', () => {
    expect(ALERT_OUTCOME_HORIZON_HOURS).toBe(24);
    expect(TICKET_RESPONSE_HORIZON_HOURS).toBe(4);
  });

  it('enumerates every omission reason the UI must be able to render', () => {
    expect([...MEASURED_OMISSION_REASONS].sort()).toEqual([
      'insufficient_authority',
      'insufficient_data',
      'insufficient_followup',
      'site_restricted',
    ]);
  });
});

describe('impactMeasuredQuerySchema', () => {
  it('accepts only the three P2-6 windows', () => {
    expect(impactMeasuredQuerySchema.safeParse({ window: 7 }).success).toBe(true);
    expect(impactMeasuredQuerySchema.safeParse({ window: 30 }).success).toBe(true);
    expect(impactMeasuredQuerySchema.safeParse({ window: 90 }).success).toBe(true);
    expect(impactMeasuredQuerySchema.safeParse({ window: 180 }).success).toBe(false);
  });

  it('coerces the query-string form of the window', () => {
    const parsed = impactMeasuredQuerySchema.safeParse({ window: '90' });
    expect(parsed.success && parsed.data.window).toBe(90);
  });

  it('rejects a client-supplied through -- the server owns the last complete UTC day', () => {
    expect(impactMeasuredQuerySchema.safeParse({ window: 30, through: '2026-01-01' }).success).toBe(false);
  });

  it('accepts the optional orgId that fetchWithAuth auto-injects', () => {
    const parsed = impactMeasuredQuerySchema.safeParse({
      window: 30,
      orgId: '00000000-0000-4000-8000-000000000001',
    });
    expect(parsed.success).toBe(true);
  });
});
