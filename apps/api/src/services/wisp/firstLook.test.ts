/**
 * #10402 — the pure half of the first-look post: when the onboarding batch
 * counts as done, and what the post says. The orchestration against real rows
 * (exactly one post, the counts, the re-sweep) is
 * __tests__/integration/wispFirstLook.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { FIRST_LOOK_GRACE_MS, firstLookBatchDone, firstLookDedupeKey, renderFirstLookPost, summarizeWatchGaps } from './firstLook';

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
