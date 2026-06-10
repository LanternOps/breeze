/**
 * PAM-native rule engine unit tests (#1163). Pure matcher — no DB.
 */
import { describe, expect, it } from 'vitest';
import type { PamRule } from '../db/schema/pam';
import { evaluatePamRules, isWithinTimeWindow, type PamRuleCandidate } from './pamRuleEngine';

let seq = 0;
function rule(overrides: Partial<PamRule>): PamRule {
  seq += 1;
  return {
    id: overrides.id ?? `rule-${seq}`,
    orgId: 'org-1',
    siteId: null,
    name: overrides.name ?? `rule ${seq}`,
    description: null,
    enabled: true,
    priority: 100,
    matchSigner: null,
    matchHash: null,
    matchPathGlob: null,
    matchParentImage: null,
    matchUser: null,
    matchAdGroup: null,
    timeWindow: null,
    verdict: 'require_approval',
    approvalDurationMinutes: null,
    createdByUserId: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  } as PamRule;
}

const candidate: PamRuleCandidate = {
  targetExecutablePath: 'C:\\Program Files\\Vendor\\tool.exe',
  targetExecutableHash: 'a'.repeat(64),
  targetExecutableSigner: 'Vendor Inc.',
  subjectUsername: 'CORP\\alice',
  parentImage: 'C:\\Windows\\explorer.exe',
};

describe('evaluatePamRules', () => {
  it('returns null when no rules', () => {
    expect(evaluatePamRules([], candidate)).toBeNull();
  });

  it('matches on exact hash, case-insensitive', () => {
    const r = rule({ matchHash: 'A'.repeat(64), verdict: 'auto_approve' });
    expect(evaluatePamRules([r], candidate)?.verdict).toBe('auto_approve');
  });

  it('matches signer case-insensitively', () => {
    const r = rule({ matchSigner: 'vendor inc.', verdict: 'auto_deny' });
    expect(evaluatePamRules([r], candidate)?.verdict).toBe('auto_deny');
  });

  it('matches path via windows-style glob (* stays in segment, ** crosses)', () => {
    const single = rule({ matchPathGlob: 'C:\\Program Files\\Vendor\\*.exe' });
    const cross = rule({ matchPathGlob: 'C:\\Program Files\\**' });
    const noCross = rule({ matchPathGlob: 'C:\\*' });
    expect(evaluatePamRules([single], candidate)).not.toBeNull();
    expect(evaluatePamRules([cross], candidate)).not.toBeNull();
    expect(evaluatePamRules([noCross], candidate)).toBeNull();
  });

  it('matches parent image via glob', () => {
    const r = rule({ matchParentImage: 'C:\\Windows\\*.exe' });
    expect(evaluatePamRules([r], candidate)).not.toBeNull();
    expect(
      evaluatePamRules([r], { ...candidate, parentImage: undefined }),
    ).toBeNull();
  });

  it('ANDs multiple criteria — all must match', () => {
    const both = rule({
      matchSigner: 'Vendor Inc.',
      matchPathGlob: 'C:\\Program Files\\**',
    });
    const oneWrong = rule({
      matchSigner: 'Vendor Inc.',
      matchPathGlob: 'D:\\**',
    });
    expect(evaluatePamRules([both], candidate)).not.toBeNull();
    expect(evaluatePamRules([oneWrong], candidate)).toBeNull();
  });

  it('a rule with no criteria never matches (no tenant-wide auto_approve)', () => {
    const empty = rule({ verdict: 'auto_approve' });
    expect(evaluatePamRules([empty], candidate)).toBeNull();
  });

  it('skips disabled rules', () => {
    const r = rule({ matchSigner: 'Vendor Inc.', enabled: false });
    expect(evaluatePamRules([r], candidate)).toBeNull();
  });

  it('hash criterion requires a hash on the candidate', () => {
    const r = rule({ matchHash: 'b'.repeat(64) });
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutableHash: undefined }),
    ).toBeNull();
  });

  it('ad_group rules only match when groups are supplied', () => {
    const r = rule({ matchAdGroup: 'Helpdesk' });
    expect(evaluatePamRules([r], candidate)).toBeNull();
    expect(
      evaluatePamRules([r], { ...candidate, subjectAdGroups: ['HELPDESK'] }),
    ).not.toBeNull();
  });

  it('lowest priority number wins; ties break by createdAt then id', () => {
    const low = rule({
      id: 'low',
      priority: 10,
      matchSigner: 'Vendor Inc.',
      verdict: 'auto_deny',
    });
    const high = rule({
      id: 'high',
      priority: 200,
      matchSigner: 'Vendor Inc.',
      verdict: 'auto_approve',
    });
    // Order given shouldn't matter.
    expect(evaluatePamRules([high, low], candidate)?.ruleId).toBe('low');

    const older = rule({
      id: 'older',
      priority: 50,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      matchSigner: 'Vendor Inc.',
    });
    const newer = rule({
      id: 'newer',
      priority: 50,
      createdAt: new Date('2026-05-01T00:00:00Z'),
      matchSigner: 'Vendor Inc.',
    });
    expect(evaluatePamRules([newer, older], candidate)?.ruleId).toBe('older');
  });

  it('first matching rule wins even if a later rule also matches', () => {
    const ignore = rule({
      priority: 1,
      matchPathGlob: 'C:\\Program Files\\**',
      verdict: 'ignore',
    });
    const deny = rule({
      priority: 2,
      matchSigner: 'Vendor Inc.',
      verdict: 'auto_deny',
    });
    expect(evaluatePamRules([deny, ignore], candidate)?.verdict).toBe('ignore');
  });

  it('returns approvalDurationMinutes from the matched rule', () => {
    const r = rule({
      matchSigner: 'Vendor Inc.',
      verdict: 'auto_approve',
      approvalDurationMinutes: 30,
    });
    expect(evaluatePamRules([r], candidate)?.approvalDurationMinutes).toBe(30);
  });
});

describe('isWithinTimeWindow', () => {
  // 2026-06-09T15:30:00Z is a Tuesday.
  const tueAfternoonUtc = new Date('2026-06-09T15:30:00Z');

  it('inside a same-day window (UTC default)', () => {
    expect(isWithinTimeWindow({ start: '09:00', end: '17:00' }, tueAfternoonUtc)).toBe(true);
  });

  it('outside the window', () => {
    expect(isWithinTimeWindow({ start: '16:00', end: '17:00' }, tueAfternoonUtc)).toBe(false);
  });

  it('overnight window wraps midnight', () => {
    const lateUtc = new Date('2026-06-09T23:30:00Z');
    expect(isWithinTimeWindow({ start: '22:00', end: '06:00' }, lateUtc)).toBe(true);
    expect(isWithinTimeWindow({ start: '22:00', end: '06:00' }, tueAfternoonUtc)).toBe(false);
  });

  it('day-of-week restriction', () => {
    // Tuesday = 2
    expect(
      isWithinTimeWindow({ start: '09:00', end: '17:00', days: [2] }, tueAfternoonUtc),
    ).toBe(true);
    expect(
      isWithinTimeWindow({ start: '09:00', end: '17:00', days: [0, 6] }, tueAfternoonUtc),
    ).toBe(false);
  });

  it('timezone shifts the evaluation (15:30Z = 10:30 in Chicago)', () => {
    expect(
      isWithinTimeWindow(
        { start: '09:00', end: '11:00', timezone: 'America/Chicago' },
        tueAfternoonUtc,
      ),
    ).toBe(true);
    expect(
      isWithinTimeWindow(
        { start: '09:00', end: '11:00', timezone: 'UTC' },
        tueAfternoonUtc,
      ),
    ).toBe(false);
  });

  it('malformed times or timezone never activate the rule', () => {
    expect(isWithinTimeWindow({ start: '9am', end: '17:00' }, tueAfternoonUtc)).toBe(false);
    expect(isWithinTimeWindow({ start: '25:00', end: '26:00' }, tueAfternoonUtc)).toBe(false);
    expect(
      isWithinTimeWindow(
        { start: '09:00', end: '17:00', timezone: 'Not/AZone' },
        tueAfternoonUtc,
      ),
    ).toBe(false);
  });

  it('time-window-only rules still never match (no executable criterion)', () => {
    const r = rule({ timeWindow: { start: '00:00', end: '23:59' }, verdict: 'auto_approve' });
    expect(evaluatePamRules([r], candidate)).toBeNull();
  });
});
