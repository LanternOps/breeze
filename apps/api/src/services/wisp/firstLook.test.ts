/**
 * #10402 — the pure half of the first-look post: when the onboarding batch
 * counts as done, and what the post says. The orchestration against real rows
 * (exactly one post, the counts, the re-sweep) is
 * __tests__/integration/wispFirstLook.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  couldntLookDedupeKey,
  FIRST_LOOK_GRACE_MS,
  firstLookBatchDone,
  firstLookDedupeKey,
  firstLookFailureCategory,
  firstLookRetry,
  renderCouldntLookPost,
  renderFirstLookPost,
  summarizeFirstLookFailures,
  summarizeWatchGaps,
  type FirstLookFailureSummary,
} from './firstLook';

const CREATED = new Date('2027-01-22T10:00:00Z');
const soon = new Date(CREATED.getTime() + 60_000);
const late = new Date(CREATED.getTime() + FIRST_LOOK_GRACE_MS);

describe('firstLookDedupeKey', () => {
  it('is per grant', () => {
    expect(firstLookDedupeKey('g1')).toBe('wisp.first_look:g1');
  });
});

describe('firstLookBatchDone', () => {
  it('is done as soon as every org of the batch settled', () => {
    expect(firstLookBatchDone({ batchOrgIds: ['a', 'b'], settledOrgIds: new Set(['a', 'b']), grantCreatedAt: CREATED, now: soon })).toBe(true);
  });

  it('waits for an unsettled org inside the grace period', () => {
    expect(firstLookBatchDone({ batchOrgIds: ['a', 'b'], settledOrgIds: new Set(['a']), grantCreatedAt: CREATED, now: soon })).toBe(false);
  });

  it('an org that never got a run (admission skipped) stops holding the post at the grace limit', () => {
    expect(firstLookBatchDone({ batchOrgIds: ['a', 'b'], settledOrgIds: new Set(['a']), grantCreatedAt: CREATED, now: late })).toBe(true);
  });

  it('an empty batch is not done early', () => {
    expect(firstLookBatchDone({ batchOrgIds: [], settledOrgIds: new Set(), grantCreatedAt: CREATED, now: soon })).toBe(false);
  });
});

describe('summarizeWatchGaps', () => {
  const check = (watchKind: string, serviceable: boolean) => ({ watchKind, serviceable, reason: serviceable ? null : 'x' }) as never;
  const org = (orgId: string, checks: never[]) => ({ orgId, orgName: orgId, checks, missingIntegrations: [] });

  it('counts orgs per topic, the two ticket kinds as one, most affected first', () => {
    expect(summarizeWatchGaps([
      org('a', [check('backup_health', false), check('ticket_waiting', false), check('ticket_cluster', false), check('custom_query', true)]),
      org('b', [check('backup_health', false), check('security_findings', true)]),
    ])).toEqual([{ label: 'backups', orgCount: 2 }, { label: 'tickets', orgCount: 1 }]);
  });
});

describe('renderFirstLookPost', () => {
  const base = {
    totalOrgs: 23, lookedAtOrgs: 10, unfinishedOrgs: 0, stillQueuedOrgs: 13, restrictedOrgs: 0,
    concerns: { high: 1, medium: 3, low: 8, info: 0 }, watchGaps: [{ label: 'backups', orgCount: 4 }, { label: 'patch compliance', orgCount: 1 }],
  };

  it('says orgs looked at, still queued, concerns by severity and what cannot be watched', () => {
    const { title, body } = renderFirstLookPost(base);
    expect(title).toBe('First look done: 10 of 23 organizations');
    expect(body).toContain('I looked at 10 of your 23 organizations.');
    expect(body).toContain('13 more are still queued for my regular checks.');
    expect(body).toContain('Open concerns: 1 high, 3 medium, 8 low.');
    expect(body).toContain("What I can't watch yet: backups in 4 organizations; patch compliance in 1 organization.");
  });

  it('one org, nothing queued, nothing open, no gaps', () => {
    const { title, body } = renderFirstLookPost({
      ...base, totalOrgs: 1, lookedAtOrgs: 1, stillQueuedOrgs: 0, concerns: { high: 0, medium: 0, low: 0, info: 0 }, watchGaps: [],
    });
    expect(title).toBe('First look done: 1 of 1 organization');
    expect(body).toContain('I looked at your 1 organization.');
    expect(body).toContain('No open concerns so far.');
    expect(body).not.toContain('queued');
    expect(body).not.toContain("can't watch");
  });

  it('names unfinished orgs and orgs reached only through some sites', () => {
    const { body } = renderFirstLookPost({ ...base, lookedAtOrgs: 9, unfinishedOrgs: 1, restrictedOrgs: 2 });
    expect(body).toContain('I could not finish 1 organization; my regular checks try again.');
    expect(body).toContain('2 organizations you reach only through some of their sites');
  });

  it('an unread inventory says so instead of implying there are no gaps, and still names restricted orgs', () => {
    const unread = renderFirstLookPost({ ...base, watchGaps: null }).body;
    expect(unread).toContain("I couldn't check what I can't watch yet.");
    expect(unread).not.toContain('What I can\'t watch yet:');
    const restricted = renderFirstLookPost({ ...base, watchGaps: null, restrictedOrgs: 2 }).body;
    expect(restricted).toContain("I couldn't check what I can't watch yet.");
    expect(restricted).toContain('2 organizations you reach only through some of their sites');
  });

  it('a singular queued org reads as one', () => {
    expect(renderFirstLookPost({ ...base, totalOrgs: 11, stillQueuedOrgs: 1 }).body).toContain('1 more is still queued');
  });
});

describe('couldntLookDedupeKey (#11145)', () => {
  it('is per grant and can never collide with the first look key the sweep and the post look for', () => {
    expect(couldntLookDedupeKey('g1')).toBe('wisp.first_look_failed:g1');
    expect(couldntLookDedupeKey('g1').startsWith(firstLookDedupeKey(''))).toBe(false);
  });
});

describe('firstLookFailureCategory (#11145)', () => {
  it.each([
    ['failed', 'llm_unavailable', 'model_unavailable'],
    ['failed', 'sdk_error', 'model_unavailable'],
    ['failed', 'sdk_output_error', 'model_unavailable'],
    ['blocked', 'model_unavailable', 'model_unavailable'],
    ['blocked', 'model_refused', 'model_unavailable'],
    ['failed', 'org_budget_exceeded', 'budget'],
    ['failed', 'budget_exceeded', 'budget'],
    ['skipped', 'policy_revoked_before_start', 'not_admitted'],
    ['skipped', 'trigger_filter_mismatch', 'not_admitted'],
    ['cancelled', null, 'not_admitted'],
    ['failed', 'stalled', 'internal'],
    ['failed', 'enqueue_failed', 'internal'],
    ['failed', 'run_failed', 'internal'],
    ['failed', 'wall_clock_exceeded', 'model_unavailable'],
    ['failed', 'max_turns_exceeded', 'model_unavailable'],
    ['expired', null, 'internal'],
    // Unknown and hostile-looking codes fall through: a code is a label to classify, never text to show.
    ['failed', 'provider said: 401 sk-ant-secret', 'internal'],
    ['failed', 'constructor', 'internal'],
    ['failed', null, 'internal'],
  ])('%s / %s → %s', (status, errorCode, expected) => {
    expect(firstLookFailureCategory({ status, errorCode })).toBe(expected);
  });
});

describe('summarizeFirstLookFailures (#11145)', () => {
  const none = { noAgentOrgIds: new Set<string>(), grantBudgetExhausted: false };
  const run = (status: string, errorCode: string | null) => ({ status, errorCode });

  it('counts each org once under its most actionable cause, biggest first', () => {
    expect(summarizeFirstLookFailures(['a', 'b', 'c', 'd'], new Map([
      ['a', [run('failed', 'sdk_error'), run('failed', 'stalled')]],
      ['b', [run('failed', 'llm_unavailable')]],
      ['c', [run('failed', 'org_budget_exceeded'), run('failed', 'sdk_error')]],
      ['d', [run('failed', 'sdk_output_error')]],
    ]), none)).toEqual([
      { category: 'model_unavailable', orgCount: 3 },
      { category: 'budget', orgCount: 1 },
    ]);
  });

  it('an org that never got a run: admission refused, unless the budget or a missing agent says why', () => {
    expect(summarizeFirstLookFailures(['a'], new Map(), none)).toEqual([{ category: 'not_admitted', orgCount: 1 }]);
    expect(summarizeFirstLookFailures(['a'], new Map(), { ...none, noAgentOrgIds: new Set(['a']) })).toEqual([{ category: 'no_agent', orgCount: 1 }]);
    expect(summarizeFirstLookFailures(['a'], new Map(), { noAgentOrgIds: new Set(['a']), grantBudgetExhausted: true })).toEqual([{ category: 'budget', orgCount: 1 }]);
  });

  it('a spent budget does not rewrite why a run that did start failed', () => {
    expect(summarizeFirstLookFailures(['a'], new Map([['a', [run('failed', 'sdk_error')]]]), { ...none, grantBudgetExhausted: true }))
      .toEqual([{ category: 'model_unavailable', orgCount: 1 }]);
  });
});

describe('firstLookRetry (#11145)', () => {
  const now = new Date('2027-01-22T10:00:00Z');
  it('a spent budget retries when the UTC day rolls, not on a tick that would skip', () => {
    expect(firstLookRetry({ grantBudgetExhausted: true, lastFloorTickAt: now, floorTickMinutes: 30, now }))
      .toEqual({ kind: 'budget_reset', at: new Date('2027-01-23T00:00:00Z') });
  });
  it('otherwise the next floor tick: the last one plus the cadence', () => {
    expect(firstLookRetry({ grantBudgetExhausted: false, lastFloorTickAt: new Date('2027-01-22T09:50:00Z'), floorTickMinutes: 30, now }))
      .toEqual({ kind: 'next_check', at: new Date('2027-01-22T10:20:00Z') });
  });
  it('a tick already due (or none yet) waits for the scheduler, never a time in the past', () => {
    const scheduler = { kind: 'next_check', at: new Date('2027-01-22T10:05:00Z') };
    expect(firstLookRetry({ grantBudgetExhausted: false, lastFloorTickAt: new Date('2027-01-22T08:00:00Z'), floorTickMinutes: 30, now })).toEqual(scheduler);
    expect(firstLookRetry({ grantBudgetExhausted: false, lastFloorTickAt: null, floorTickMinutes: 30, now })).toEqual(scheduler);
  });
});

describe('renderCouldntLookPost (#11145)', () => {
  const base = {
    totalOrgs: 12,
    attemptedOrgs: 10,
    reasons: [{ category: 'model_unavailable', orgCount: 8 }, { category: 'internal', orgCount: 2 }] as FirstLookFailureSummary[],
    retry: { kind: 'next_check', at: new Date('2027-01-22T14:30:00Z') } as const,
    timezone: 'UTC',
  };

  it('says what was attempted, why by category, and when it retries', () => {
    const { title, body } = renderCouldntLookPost(base);
    expect(title).toBe("I couldn't look yet: 0 of 12 organizations");
    expect(body).toContain("I tried to look at 10 of your 12 organizations and couldn't finish any of them, so I have no findings yet.");
    expect(body).toContain("The AI model wasn't available or couldn't finish for 8 organizations.");
    expect(body).toContain('Something went wrong on my side for 2 organizations.');
    expect(body).toContain("I'll try again around Jan 22, 14:30 UTC on my regular checks, one organization at a time, and post what I find.");
  });

  it('never claims a look happened', () => {
    const { title, body } = renderCouldntLookPost(base);
    expect(`${title} ${body}`).not.toMatch(/first look done|I looked at|open concerns/i);
  });

  it('every org attempted reads without "of your", and one org reads as singular', () => {
    const { title, body } = renderCouldntLookPost({ ...base, totalOrgs: 1, attemptedOrgs: 1, reasons: [{ category: 'not_admitted', orgCount: 1 }] });
    expect(title).toBe("I couldn't look yet: 0 of 1 organization");
    expect(body).toContain("I tried to look at your 1 organization and couldn't finish it, so I have no findings yet.");
    expect(body).toContain("My check wasn't allowed to start for 1 organization: an AI limit or policy refused it.");
  });

  it("a spent budget says when it resets and points at the budget, in the grantor's zone", () => {
    const { body } = renderCouldntLookPost({
      ...base,
      reasons: [{ category: 'budget', orgCount: 10 }],
      retry: { kind: 'budget_reset', at: new Date('2027-01-23T00:00:00Z') },
      timezone: 'America/Denver',
    });
    expect(body).toContain('An AI budget limit stopped me for 10 organizations.');
    expect(body).toContain("I'll try again on my regular checks once the daily budget resets at Jan 22, 17:00 America/Denver.");
  });

  it('a missing Triage agent says where to fix it', () => {
    const { body } = renderCouldntLookPost({ ...base, reasons: [{ category: 'no_agent', orgCount: 10 }] });
    expect(body).toContain('10 organizations have no Triage agent switched on. You can set one up under Settings → AI Agents.');
  });

  it('a zone this server cannot format falls back to UTC instead of failing the post', () => {
    expect(renderCouldntLookPost({ ...base, timezone: 'Not/AZone' }).body).toContain('around Jan 22, 14:30 UTC');
  });
});
