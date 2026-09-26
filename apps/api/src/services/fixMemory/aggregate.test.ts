import { describe, expect, it } from 'vitest';
import type { FixCountedResult, FixVote } from '@breeze/shared';
import { effectiveResult, fixIdentityFor, fixKindForScript, isProven, replayAggregate, resolveFixOwner, type CountedAttempt } from './aggregate';

const seq = (...results: Array<FixCountedResult | [FixCountedResult, FixVote]>): CountedAttempt[] =>
  results.map((r, i) => ({
    result: Array.isArray(r) ? r[0] : r,
    vote: Array.isArray(r) ? r[1] : null,
    terminalAt: new Date(Date.UTC(2026, 10, 1, 0, i)),
  }));

describe('effectiveResult', () => {
  it.each([
    ['verified', null, 'verified'], ['verified', 'up', 'verified'], ['verified', 'down', 'failed'],
    ['failed', null, 'failed'], ['failed', 'up', 'failed'], ['recurred', null, 'recurred'],
    ['inconclusive', null, null], ['inconclusive', 'up', null], ['inconclusive', 'down', 'failed'],
    ['cancelled', 'down', null], ['pending', null, null], ['awaiting_recovery', 'down', null], ['holding', null, null],
  ] as const)('%s + %s → %s', (state, vote, expected) => {
    expect(effectiveResult(state, vote)).toBe(expected);
  });
});

describe('replayAggregate + isProven', () => {
  const proven = (s: ReturnType<typeof replayAggregate>) =>
    isProven({ status: s.status, stale: false, verifiedCount: s.verifiedCount, rollingSuccessRate: s.rollingSuccessRate, recentOutcomes: s.recentOutcomes });

  it('3 verified is proven; 2 is not', () => {
    expect(proven(replayAggregate(seq('verified', 'verified')))).toBe(false);
    const s = replayAggregate(seq('verified', 'verified', 'verified'));
    expect(s).toMatchObject({ attempts: 3, verifiedCount: 3, rollingSuccessRate: 1, status: 'active' });
    expect(proven(s)).toBe(true);
  });

  it('a 👍 alone never proves anything', () => {
    expect(proven(replayAggregate(seq(['verified', 'up'], ['verified', 'up'])))).toBe(false);
  });

  it('two consecutive failures demote; three verified in a row lift it', () => {
    const demoted = replayAggregate(seq('verified', 'verified', 'verified', 'failed', 'failed'));
    expect(demoted.status).toBe('demoted');
    expect(proven(demoted)).toBe(false);
    const lifted = replayAggregate(seq('verified', 'verified', 'verified', 'failed', 'failed', 'verified', 'verified', 'verified'));
    expect(lifted.status).toBe('active');
    expect(lifted.consecutiveVerified).toBe(3);
    expect(lifted.rollingSuccessRate).toBeCloseTo(6 / 8);
    expect(proven(lifted)).toBe(false); // 0.75 < 0.8
  });

  it('a recurrence demotes immediately and blocks proof while it is in the last 3', () => {
    const s = replayAggregate(seq('verified', 'verified', 'verified', 'verified', 'recurred'));
    expect(s.status).toBe('demoted');
    const after = replayAggregate(seq('verified', 'verified', 'verified', 'verified', 'recurred', 'verified', 'verified', 'verified'));
    expect(after.status).toBe('active');
    expect(after.recentOutcomes.slice(0, 3)).toEqual(['verified', 'verified', 'verified']);
    expect(proven(after)).toBe(true); // 7/8 = 0.875
  });

  it('rolling rate only considers the last 20 counted attempts', () => {
    const s = replayAggregate(seq(...Array(10).fill('failed'), ...Array(20).fill('verified')));
    expect(s.recentOutcomes).toHaveLength(20);
    expect(s.rollingSuccessRate).toBe(1);
    expect(s.attempts).toBe(30);
  });

  it('replay is order-independent of input order (sorted by terminalAt)', () => {
    const a = seq('verified', 'failed', 'failed');
    expect(replayAggregate([...a].reverse())).toEqual(replayAggregate(a));
  });

  it('stale or retired is never proven', () => {
    const s = replayAggregate(seq('verified', 'verified', 'verified'));
    expect(isProven({ ...s, stale: true })).toBe(false);
    expect(isProven({ ...s, status: 'retired', stale: false })).toBe(false);
  });
});

describe('owner + identity', () => {
  const attempt = { orgId: 'org-a', partnerId: 'p-1' };
  it.each([
    [{ isSystem: true, orgId: null, partnerId: null }, { orgId: null, partnerId: 'p-1' }],
    [{ isSystem: false, orgId: null, partnerId: 'p-1' }, { orgId: null, partnerId: 'p-1' }],
    [{ isSystem: false, orgId: 'org-a', partnerId: 'p-1' }, { orgId: 'org-a', partnerId: null }],
    [{ isSystem: false, orgId: 'org-b', partnerId: 'p-1' }, null],
    [{ isSystem: false, orgId: null, partnerId: 'p-2' }, null],
  ])('script %o → %o', (script, owner) => {
    expect(resolveFixOwner({ fixKind: fixKindForScript(script), script, playbook: null, instructionsRef: null }, attempt)).toEqual(owner);
  });

  it('manual steps only aggregate with a reviewed instructions ref', () => {
    expect(resolveFixOwner({ fixKind: 'manual_steps', script: null, playbook: null, instructionsRef: null }, attempt)).toBeNull();
    expect(resolveFixOwner({ fixKind: 'manual_steps', script: null, playbook: null, instructionsRef: 'generic/clear-spooler' }, attempt))
      .toEqual({ orgId: null, partnerId: 'p-1' });
  });

  it('identity pins the script VERSION', () => {
    expect(fixIdentityFor({ fixKind: 'org_script', scriptVersionId: 'v-9' })).toBe('script_version:v-9');
    expect(fixIdentityFor({ fixKind: 'org_script', scriptVersionId: null })).toBeNull();
    expect(fixIdentityFor({ fixKind: 'builtin_action', builtinAction: 'reboot' })).toBe('builtin:reboot');
  });
});
