/**
 * AI Scorecard W04 (#5761, refs #4182) — the loaders' FAIL-LOUD contract.
 *
 * The dangerous failure mode for this feature is not a crash: it is a number
 * that renders confidently while being wrong, or an empty band that reads as
 * "your AI did nothing" when in truth the query never ran. Both coercion points
 * in `impactMeasuredSignals.ts` therefore throw rather than substituting a
 * plausible-looking value, and these tests pin that.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();

vi.mock('../../db', () => ({
  db: { execute: (...args: unknown[]) => execute(...args) },
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

const { loadAlertResolutionSignal, loadTechnicianMinutes } = await import('./impactMeasuredSignals');

const auth = { orgCondition: () => undefined } as never;
const window = { orgIds: ['org-1'], from: '2026-01-01', through: '2026-01-31', windowDays: 30 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeRows', () => {
  it('THROWS on a non-array result instead of reporting it as "no data"', async () => {
    // Returning [] here would surface as omitted: 'insufficient_data' -- telling
    // a partner their AI did nothing when the query never produced rows at all.
    execute.mockResolvedValue({ notAnArray: true });

    await expect(loadAlertResolutionSignal(auth, window)).rejects.toThrow(/non-array result/);
  });

  it('reports insufficient_data only for a genuinely empty result', async () => {
    execute.mockResolvedValue([]);

    await expect(loadAlertResolutionSignal(auth, window)).resolves.toMatchObject({
      cohorts: [],
      omitted: 'insufficient_data',
    });
  });
});

describe('toNumber', () => {
  it('THROWS on an unparseable outcome time instead of substituting a 0-minute resolution', async () => {
    // A fabricated 0 would drag the Kaplan-Meier curve toward "faster" and
    // nobody downstream could tell.
    execute.mockResolvedValue([
      { rule_id: 'rule-a', rule_name: 'Rule A', ai_touched: true, observed: true, minutes: 'not-a-number', has_followup: true },
    ]);

    await expect(loadAlertResolutionSignal(auth, window)).rejects.toThrow(/non-numeric value for "minutes"/);
  });

  it('THROWS on unparseable recorded minutes instead of substituting zero labour', async () => {
    execute.mockResolvedValue([
      { ticket_id: 't1', priority: 'high', category: 'billing', ai_touched: true, recorded_minutes: 'oops' },
    ]);

    await expect(loadTechnicianMinutes(auth, window)).rejects.toThrow(/non-numeric value for "recorded_minutes"/);
  });

  it('accepts the STRING numerics postgres.js returns for numeric expressions', async () => {
    execute.mockResolvedValue(
      Array.from({ length: 40 }, (_unused, i) => ({
        rule_id: 'rule-a',
        rule_name: 'Rule A',
        ai_touched: i % 2 === 0,
        observed: true,
        minutes: '30.5',
        has_followup: true,
      })),
    );

    const signal = await loadAlertResolutionSignal(auth, window);

    expect(signal.omitted).toBeNull();
    expect(signal.cohorts[0]!.aiTouched.n).toBe(20);
    expect(signal.cohorts[0]!.untouched.n).toBe(20);
  });
});

describe('signalFrom — omission reason vs. window length (#5879)', () => {
  // Rows with hasFollowup: false never reach a cohort (foldCohorts drops them),
  // so eligibleRows > 0 but followupRows stays 0 -- the shape that currently
  // produces 'insufficient_followup'.
  function notEnoughFollowupRows() {
    return Array.from({ length: 10 }, (_unused, i) => ({
      rule_id: 'rule-a',
      rule_name: 'Rule A',
      ai_touched: i % 2 === 0,
      observed: false,
      minutes: 5,
      has_followup: false,
    }));
  }

  it('reports insufficient_followup below the max window, where "try a longer window" has somewhere to go', async () => {
    execute.mockResolvedValue(notEnoughFollowupRows());

    await expect(loadAlertResolutionSignal(auth, { ...window, windowDays: 30 })).resolves.toMatchObject({
      cohorts: [],
      omitted: 'insufficient_followup',
    });
  });

  it('never tells the user to try a longer window AT the max window (90 days)', async () => {
    execute.mockResolvedValue(notEnoughFollowupRows());

    await expect(loadAlertResolutionSignal(auth, { ...window, windowDays: 90 })).resolves.toMatchObject({
      cohorts: [],
      omitted: 'insufficient_data',
    });
  });
});

describe('loadTechnicianMinutes coverage', () => {
  it('counts a NULL recorded_minutes as unlogged, not as zero labour', async () => {
    execute.mockResolvedValue([
      ...Array.from({ length: 20 }, (_u, i) => ({
        ticket_id: `a${i}`, priority: 'high', category: 'billing', ai_touched: true, recorded_minutes: '30',
      })),
      // One AI-touched ticket with no completed entry at all.
      { ticket_id: 'a-unlogged', priority: 'high', category: 'billing', ai_touched: true, recorded_minutes: null },
      ...Array.from({ length: 20 }, (_u, i) => ({
        ticket_id: `b${i}`, priority: 'high', category: 'billing', ai_touched: false, recorded_minutes: '40',
      })),
    ]);

    const result = await loadTechnicianMinutes(auth, window);

    const cohort = result.cohorts.find((c) => c.key === 'high|billing')!;
    expect(cohort.aiTouched.n).toBe(20);
    expect(cohort.aiTouched.medianRecordedMinutes).toBe(30);
    // The unlogged ticket lowers COVERAGE rather than pulling the median to 0.
    expect(result.loggingCoverage.aiTouched).toBeCloseTo(20 / 21, 5);
    expect(result.loggingCoverage.untouched).toBe(1);
  });
});
