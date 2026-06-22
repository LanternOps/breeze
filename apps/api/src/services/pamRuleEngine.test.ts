/**
 * PAM-native rule engine unit tests (#1163). Pure matcher — no DB.
 */
import { describe, expect, it } from 'vitest';
import type { PamRule } from '../db/schema/pam';
import {
  evaluatePamRules,
  evaluatePamToolActionRules,
  isWithinTimeWindow,
  type PamRuleCandidate,
} from './pamRuleEngine';

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
    matchSignerGroupId: null,
    matchHash: null,
    matchPathGlob: null,
    matchParentImage: null,
    matchCommandLine: null,
    matchUser: null,
    matchAdGroup: null,
    matchToolName: null,
    matchRiskTier: null,
    matchNegate: null,
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

describe('tool-action rules (Phase 1 helper governance)', () => {
  const toolCandidate: PamRuleCandidate = {
    toolName: 'manage_services',
    riskTier: 2,
    subjectUsername: 'HOST-01',
  };

  it('matches on tool name, case-insensitive', () => {
    const r = rule({ matchToolName: 'Manage_Services', verdict: 'auto_approve' });
    expect(evaluatePamToolActionRules([r], toolCandidate)?.verdict).toBe('auto_approve');
  });

  it('does not match a different tool name', () => {
    const r = rule({ matchToolName: 'execute_command', verdict: 'auto_approve' });
    expect(evaluatePamToolActionRules([r], toolCandidate)).toBeNull();
  });

  it('matches risk tier exactly', () => {
    expect(
      evaluatePamToolActionRules([rule({ matchRiskTier: 2, verdict: 'auto_deny' })], toolCandidate)
        ?.verdict,
    ).toBe('auto_deny');
    expect(
      evaluatePamToolActionRules([rule({ matchRiskTier: 3, verdict: 'auto_deny' })], toolCandidate),
    ).toBeNull();
  });

  it('ANDs tool criteria with user and time window', () => {
    const r = rule({
      matchToolName: 'manage_services',
      matchUser: 'host-01',
      timeWindow: { start: '00:00', end: '23:59' },
      verdict: 'auto_approve',
    });
    expect(
      evaluatePamToolActionRules([r], { ...toolCandidate, at: new Date() })?.verdict,
    ).toBe('auto_approve');
    expect(
      evaluatePamToolActionRules([r], {
        ...toolCandidate,
        subjectUsername: 'other',
        at: new Date(),
      }),
    ).toBeNull();
  });

  it('a matchUser-only rule never matches tool actions (no tool-action criterion)', () => {
    const r = rule({ matchUser: 'host-01', verdict: 'auto_approve' });
    expect(evaluatePamToolActionRules([r], toolCandidate)).toBeNull();
  });

  it('an executable rule never matches tool actions', () => {
    const r = rule({ matchHash: 'a'.repeat(64), verdict: 'auto_approve' });
    expect(evaluatePamToolActionRules([r], toolCandidate)).toBeNull();
  });

  it('a tool-action rule never matches an executable candidate via evaluatePamRules', () => {
    const r = rule({ matchToolName: 'manage_services', verdict: 'auto_approve' });
    expect(
      evaluatePamRules([r], {
        targetExecutablePath: 'C:\\x.exe',
        subjectUsername: 'alice',
      }),
    ).toBeNull();
  });

  it('criteria-less rules still match nothing', () => {
    expect(evaluatePamToolActionRules([rule({ verdict: 'auto_approve' })], toolCandidate)).toBeNull();
  });

  it('matchPathGlob fails closed when candidate has no executable path', () => {
    const r = rule({ matchPathGlob: '**', verdict: 'auto_approve' });
    expect(
      evaluatePamRules([r], { subjectUsername: 'a', toolName: 't' }),
    ).toBeNull();
  });

  it('priority ordering applies across tool-action rules', () => {
    const deny = rule({ matchToolName: 'manage_services', verdict: 'auto_deny', priority: 10 });
    const approve = rule({ matchToolName: 'manage_services', verdict: 'auto_approve', priority: 20 });
    expect(evaluatePamToolActionRules([approve, deny], toolCandidate)?.verdict).toBe('auto_deny');
  });
});

describe('command-line matching', () => {
  const printerCandidate: PamRuleCandidate = {
    targetExecutablePath: 'C:\\Windows\\System32\\rundll32.exe',
    targetExecutableSigner: 'Microsoft Windows',
    subjectUsername: 'CORP\\alice',
    commandLine: 'rundll32.exe printui.dll,PrintUIEntry /il',
  };

  it('matches a case-insensitive substring of the command line', () => {
    const r = rule({ matchCommandLine: 'printui.dll,PrintUIEntry', verdict: 'auto_approve' });
    expect(evaluatePamRules([r], printerCandidate)?.verdict).toBe('auto_approve');
  });

  it('does not match when the substring is absent', () => {
    const r = rule({ matchCommandLine: 'KeyboardLayout', verdict: 'auto_approve' });
    expect(evaluatePamRules([r], printerCandidate)).toBeNull();
  });

  it('fails closed when the candidate carries no command line', () => {
    const r = rule({ matchCommandLine: 'printui', verdict: 'auto_approve' });
    expect(evaluatePamRules([r], candidate)).toBeNull();
  });

  it('ANDs with a path glob (both must hold)', () => {
    const r = rule({
      matchPathGlob: 'C:\\Windows\\System32\\rundll32.exe',
      matchCommandLine: 'printui.dll,PrintUIEntry',
      verdict: 'auto_approve',
    });
    expect(evaluatePamRules([r], printerCandidate)).not.toBeNull();
    // Same rule, command line that doesn't contain the substring → no match.
    expect(
      evaluatePamRules([r], { ...printerCandidate, commandLine: 'rundll32.exe shell32.dll,Control_RunDLL' }),
    ).toBeNull();
  });
});

describe('rule negation (match_negate)', () => {
  it('inverts a path-glob criterion: matches when the path does NOT match', () => {
    const r = rule({
      matchPathGlob: 'C:\\Program Files\\Vendor\\**',
      matchNegate: ['pathGlob'],
      verdict: 'auto_deny',
    });
    // candidate's path IS under Vendor → negated criterion fails → no match.
    expect(evaluatePamRules([r], candidate)).toBeNull();
    // a path outside Vendor → negated criterion holds → match.
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutablePath: 'C:\\Temp\\evil.exe' })?.verdict,
    ).toBe('auto_deny');
  });

  it('inverts a signer criterion combined (ANDed) with a positive path criterion', () => {
    const r = rule({
      matchPathGlob: 'C:\\Program Files\\Vendor\\**',
      matchSigner: 'Evil Corp',
      matchNegate: ['signer'],
      verdict: 'auto_approve',
    });
    // path matches AND signer is NOT "Evil Corp" → match.
    expect(evaluatePamRules([r], candidate)?.verdict).toBe('auto_approve');
    // signer IS "Evil Corp" → negated signer fails → no match.
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutableSigner: 'Evil Corp' }),
    ).toBeNull();
  });

  it('negation fails closed when the candidate field is absent (never over-grants)', () => {
    const r = rule({
      matchSigner: 'Evil Corp',
      matchNegate: ['signer'],
      verdict: 'auto_approve',
    });
    // unsigned binary (no signer) → absent data never satisfies a criterion,
    // even a negated one → no match.
    const unsigned: PamRuleCandidate = {
      targetExecutablePath: 'C:\\Temp\\unsigned.exe',
      subjectUsername: 'CORP\\alice',
    };
    expect(evaluatePamRules([r], unsigned)).toBeNull();
  });

  it('inverts a command-line criterion', () => {
    const r = rule({
      matchPathGlob: '**',
      matchCommandLine: '--uninstall',
      matchNegate: ['commandLine'],
      verdict: 'auto_approve',
    });
    const installing: PamRuleCandidate = {
      targetExecutablePath: 'C:\\App\\setup.exe',
      subjectUsername: 'CORP\\alice',
      commandLine: 'setup.exe --install',
    };
    const uninstalling: PamRuleCandidate = { ...installing, commandLine: 'setup.exe --uninstall' };
    expect(evaluatePamRules([r], installing)?.verdict).toBe('auto_approve');
    expect(evaluatePamRules([r], uninstalling)).toBeNull();
  });
});

describe('signer group matching (matchSignerGroupId)', () => {
  const GROUP_ID = '11111111-1111-1111-1111-111111111111';
  const groups = new Map<string, readonly string[]>([
    [GROUP_ID, ['Intuit Inc.', 'Microsoft Corporation', 'TeamViewer GmbH']],
  ]);

  it('matches when the candidate signer is any member of the group', () => {
    const r = rule({ matchSignerGroupId: GROUP_ID, verdict: 'auto_approve' });
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutableSigner: 'Microsoft Corporation' }, groups)
        ?.verdict,
    ).toBe('auto_approve');
    // case-insensitive
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutableSigner: 'intuit inc.' }, groups),
    ).not.toBeNull();
  });

  it('does not match a signer outside the group', () => {
    const r = rule({ matchSignerGroupId: GROUP_ID, verdict: 'auto_approve' });
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutableSigner: 'Evil Corp' }, groups),
    ).toBeNull();
  });

  it('fails closed when the group is not provided to the engine', () => {
    const r = rule({ matchSignerGroupId: GROUP_ID, verdict: 'auto_approve' });
    // no resolver passed → unresolvable → no match
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutableSigner: 'Intuit Inc.' }),
    ).toBeNull();
    // empty group → no match
    const empty = new Map<string, readonly string[]>([[GROUP_ID, []]]);
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutableSigner: 'Intuit Inc.' }, empty),
    ).toBeNull();
  });

  it('fails closed when the candidate has no signer', () => {
    const r = rule({ matchSignerGroupId: GROUP_ID, verdict: 'auto_approve' });
    expect(
      evaluatePamRules([r], { subjectUsername: 'CORP\\x', targetExecutablePath: 'C:\\a.exe' }, groups),
    ).toBeNull();
  });

  it('ANDs with other criteria', () => {
    const r = rule({
      matchSignerGroupId: GROUP_ID,
      matchPathGlob: 'C:\\Program Files\\**',
      verdict: 'auto_approve',
    });
    expect(
      evaluatePamRules(
        [r],
        {
          ...candidate,
          targetExecutableSigner: 'TeamViewer GmbH',
          targetExecutablePath: 'C:\\Program Files\\TeamViewer\\tv.exe',
        },
        groups,
      ),
    ).not.toBeNull();
    // signer in group but path doesn't match → no match
    expect(
      evaluatePamRules(
        [r],
        { ...candidate, targetExecutableSigner: 'TeamViewer GmbH', targetExecutablePath: 'C:\\Temp\\tv.exe' },
        groups,
      ),
    ).toBeNull();
  });

  it('inverts via negation (signer NOT in the group)', () => {
    const r = rule({
      matchPathGlob: 'C:\\**',
      matchSignerGroupId: GROUP_ID,
      matchNegate: ['signerGroup'],
      verdict: 'auto_deny',
    });
    // signer is a member → negated criterion fails → no match
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutableSigner: 'Intuit Inc.', targetExecutablePath: 'C:\\a.exe' }, groups),
    ).toBeNull();
    // signer not a member → negated criterion holds → match
    expect(
      evaluatePamRules([r], { ...candidate, targetExecutableSigner: 'Random LLC', targetExecutablePath: 'C:\\a.exe' }, groups)
        ?.verdict,
    ).toBe('auto_deny');
  });
});
