/**
 * #3128 boot-time PAM rule tier-drift report. Drizzle-mocked; the drift
 * predicate itself is exercised against the REAL guardrail tables (not mocked)
 * so a future tier re-classification changes what this suite sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The drift predicate deliberately pulls the REAL guardrail tier tables (via
// aiGuardrails -> aiTools), so a future tier re-classification changes what
// this suite sees. That transitive graph reaches modules which read other
// `../db` exports at import time, hence the wider stub surface here.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withResolvedDbAccessContext: vi.fn(),
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  hasDbAccessContext: () => true,
  getCurrentDbAccessContext: () => undefined,
  assertInTransaction: () => {},
  assertOutsideHeldDbContext: () => {},
  systemDbAccessContext: () => ({ scope: 'system' }),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system' },
}));

const sentryMocks = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('./sentry', () => ({ captureMessage: sentryMocks.captureMessage }));

import { db } from '../db';
import { reportStalePamRuleTiers } from './pamRuleTierDriftCheck';

type Row = {
  id: string;
  orgId: string;
  name: string;
  matchToolName: string | null;
  matchRiskTier: number | null;
  matchNegate?: string[] | null;
};

function mockRules(rows: Row[]): void {
  (db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('reportStalePamRuleTiers', () => {
  it('reports a rule pinned to a tier its tool can no longer resolve to', async () => {
    mockRules([
      { id: 'rule-dead', orgId: 'org-1', name: 'dead', matchToolName: 'execute_command', matchRiskTier: 1 },
    ]);

    const result = await reportStalePamRuleTiers();

    expect(result.scanned).toBe(1);
    expect(result.stale.map((s) => s.id)).toEqual(['rule-dead']);
    expect(result.stale[0]!.validTiers).toEqual([2, 3]);
  });

  it('does NOT report the #3128 rule itself — narrowed is not dead', async () => {
    // execute_command + tier 3 still covers file_read/kill_process.
    mockRules([
      { id: 'rule-ok', orgId: 'org-1', name: 'ok', matchToolName: 'execute_command', matchRiskTier: 3 },
    ]);

    const result = await reportStalePamRuleTiers();

    expect(result.stale).toEqual([]);
    expect(sentryMocks.captureMessage).not.toHaveBeenCalled();
  });

  it('logs the offending rule ids and raises one Sentry event when drift exists', async () => {
    mockRules([
      { id: 'rule-a', orgId: 'org-1', name: 'a', matchToolName: 'execute_command', matchRiskTier: 4 },
      { id: 'rule-b', orgId: 'org-2', name: 'b', matchToolName: null, matchRiskTier: 0 },
    ]);

    const result = await reportStalePamRuleTiers();

    expect(result.stale).toHaveLength(2);
    const warned = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
    expect(warned).toContain('rule-a');
    expect(warned).toContain('rule-b');

    expect(sentryMocks.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureMessage.mock.calls[0]![1]).toMatchObject({
      eventCode: 'pam_rule_risk_tier_unreachable',
      level: 'warning',
    });
  });

  it('does not report a rule whose tier criterion is NEGATED', async () => {
    // matchNegate:['riskTier'] means "tier is NOT 1" — an unreachable value
    // there excludes nothing, so the rule still matches and is not stale.
    // Regression guard: the scan must SELECT match_negate to know this.
    mockRules([
      {
        id: 'rule-negated',
        orgId: 'org-1',
        name: 'not tier 1',
        matchToolName: 'execute_command',
        matchRiskTier: 1,
        matchNegate: ['riskTier'],
      },
    ]);

    const result = await reportStalePamRuleTiers();

    expect(result.stale).toEqual([]);
    expect(sentryMocks.captureMessage).not.toHaveBeenCalled();
    // The Drizzle mock returns whatever rows the test supplies regardless of
    // the projection, so assert the projection DIRECTLY — otherwise dropping
    // match_negate from the SELECT would leave this suite green while the real
    // scan flagged every negated-tier rule.
    expect(vi.mocked(db.select).mock.calls[0]![0]).toHaveProperty('matchNegate');
  });

  it('stays quiet and raises nothing when every rule is healthy', async () => {
    mockRules([
      { id: 'r1', orgId: 'org-1', name: 'r1', matchToolName: 'manage_services', matchRiskTier: 3 },
    ]);

    const result = await reportStalePamRuleTiers();

    expect(result.stale).toEqual([]);
    expect(sentryMocks.captureMessage).not.toHaveBeenCalled();
  });

  it('never throws — a boot-time report must not be able to abort startup', async () => {
    (db.select as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('database is on fire');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(reportStalePamRuleTiers()).resolves.toEqual({ scanned: 0, stale: [] });
  });
});
