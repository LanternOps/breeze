/**
 * Wisp W06 Task 13 — the deterministic morning brief (w00 A28). `briefDue` is
 * pure; `buildBrief` / `runMorningBriefs` run against a Drizzle select recorder
 * (answers per table name) with every W05/W06 collaborator mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem, Concern, WispNudgePreferences } from '@breeze/shared';
import { resolveWispNudgePrefs } from '@breeze/shared';

const h = vi.hoisted(() => ({
  state: { inSystem: false },
  selects: [] as Array<{ table: string; system: boolean }>,
  selectQueue: {} as Record<string, unknown[][]>,
  resolveGrantCeiling: vi.fn(),
  listConcernsForCeiling: vi.fn(),
  spendSummary: vi.fn(),
  listWatches: vi.fn(),
  listActivity: vi.fn(),
  createEntityResolver: vi.fn(),
  resolveEntity: vi.fn(),
  getOrCreateThread: vi.fn(),
  notifyUser: vi.fn(),
  loadNudgeBookkeeping: vi.fn(),
  markBriefSent: vi.fn(),
  captureException: vi.fn(),
  wispEnabled: vi.fn(() => true),
}));

vi.mock('../../db', async () => {
  const { getTableName: tableName } = await import('drizzle-orm');
  const select = vi.fn(() => {
    const entry = { table: '', system: h.state.inSystem };
    h.selects.push(entry);
    const chain: Record<string, unknown> = {};
    chain.from = (t: Parameters<typeof tableName>[0]) => { entry.table = tableName(t); return chain; };
    for (const m of ['where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(h.selectQueue[entry.table]?.shift() ?? []).then(res, rej);
    return chain;
  });
  return { db: { select } };
});
vi.mock('./grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./grantAuthority')>()),
  resolveGrantCeiling: h.resolveGrantCeiling,
  inSystemContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.state.inSystem = true;
    try { return await fn(); } finally { h.state.inSystem = false; }
  }),
}));
vi.mock('./concerns', () => ({ listConcernsForCeiling: h.listConcernsForCeiling }));
vi.mock('./budget', () => ({ spendSummary: h.spendSummary }));
vi.mock('./watches', () => ({ listWatches: h.listWatches }));
vi.mock('./activity', () => ({ listActivity: h.listActivity }));
vi.mock('./entityRefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./entityRefs')>()),
  createEntityResolver: h.createEntityResolver,
}));
vi.mock('./threads', () => ({ getOrCreateThread: h.getOrCreateThread }));
vi.mock('./notifyUser', () => ({ notifyUser: h.notifyUser }));
vi.mock('./nudgePreferences', async (importOriginal) => ({
  // The two zone reads stay real: they run on the recorded `db` select chain, table by table.
  ...(await importOriginal<typeof import('./nudgePreferences')>()),
  loadNudgeBookkeeping: h.loadNudgeBookkeeping,
  markBriefSent: h.markBriefSent,
}));
vi.mock('./nudgeLinks', () => ({ mobileDeepLink: (threadId: string) => `breeze://wisp/thread/${threadId}` }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wispEnabled: () => h.wispEnabled(),
}));

import { GrantInactiveError } from './grantAuthority';
import { briefDue, briefScheduleFor, buildBrief, runMorningBriefs } from './brief';

const GRANT = '00000000-0000-4000-8000-000000000a01';
const GRANT_2 = '00000000-0000-4000-8000-000000000a02';
const GRANT_3 = '00000000-0000-4000-8000-000000000a03';
const REVISION = '00000000-0000-4000-8000-000000000a09';
const PARTNER = '00000000-0000-4000-8000-000000000b01';
const USER = '00000000-0000-4000-8000-000000000c01';
const USER_2 = '00000000-0000-4000-8000-000000000c02';
const USER_3 = '00000000-0000-4000-8000-000000000c03';
const ORG = '00000000-0000-4000-8000-000000000d01';
const ORG2 = '00000000-0000-4000-8000-000000000d02';
const THREAD = '00000000-0000-4000-8000-000000000e01';

const CEILING = {
  grantId: GRANT, revisionId: REVISION, partnerId: PARTNER, grantorUserId: USER, status: 'active',
  orgIds: new Set([ORG, ORG2]), siteIds: null, orgTerms: new Map(),
};

let seq = 0;
function concern(over: Partial<Concern> = {}): Concern {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    partnerId: PARTNER,
    orgId: ORG,
    subject: { kind: 'device', id: ORG },
    summary: `Concern ${seq}`,
    severity: 'medium',
    status: 'open',
    evidence: {},
    outcome: null,
    signature: null,
    childConcernIds: [],
    approvalIntentId: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    resolvedAt: null,
    ...over,
  };
}

function activity(kind: ActivityItem['kind'], at: string): ActivityItem {
  seq += 1;
  return { id: `a-${seq}`, at, kind, orgId: ORG, title: kind, detail: null, href: null, costCents: null };
}

function grantRow(over: Record<string, unknown> = {}) {
  return { id: GRANT, partnerId: PARTNER, grantorUserId: USER, status: 'active', pausedReason: null, ...over };
}

const prefs = (over: Partial<WispNudgePreferences> = {}): WispNudgePreferences => ({ ...resolveWispNudgePrefs(null), ...over });

beforeEach(() => {
  vi.clearAllMocks();
  h.selects.length = 0;
  h.selectQueue = {};
  seq = 0;
  h.resolveGrantCeiling.mockResolvedValue(CEILING);
  h.listConcernsForCeiling.mockResolvedValue([]);
  h.spendSummary.mockResolvedValue({ spentTodayCents: 0, backgroundCents: 0, chatCents: 0, budgetCentsPerDay: 200, budgetResetsAt: new Date() });
  h.listWatches.mockResolvedValue([]);
  h.listActivity.mockResolvedValue({ items: [], nextCursor: null });
  h.createEntityResolver.mockImplementation(() => h.resolveEntity);
  h.resolveEntity.mockResolvedValue({ reason: 'not_found' });
  h.getOrCreateThread.mockResolvedValue({ id: THREAD, grantId: GRANT });
  h.notifyUser.mockResolvedValue({ inApp: true, pushed: 1, suppressed: null });
  h.loadNudgeBookkeeping.mockResolvedValue(new Map());
  h.markBriefSent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// briefDue
// ---------------------------------------------------------------------------

describe('briefDue', () => {
  const at = (iso: string) => new Date(iso);
  const p = (briefTimeLocal: string | null, briefTimezone: string | null = null) => ({ briefTimeLocal, briefTimezone });

  it('is never due when the brief is off, but still reports the local date', () => {
    expect(briefDue(p(null), null, at('2026-10-24T15:00:00Z'), 'UTC')).toEqual({ due: false, localDate: '2026-10-24' });
  });

  it('is not due before the brief time and due exactly at it', () => {
    expect(briefDue(p('08:00'), null, at('2026-10-24T07:59:59Z'), 'UTC').due).toBe(false);
    expect(briefDue(p('08:00'), null, at('2026-10-24T08:00:00Z'), 'UTC')).toEqual({ due: true, localDate: '2026-10-24' });
  });

  it('prefers the preference timezone over the fallback', () => {
    // 13:00Z = 09:00 EDT, 06:00 PDT
    expect(briefDue(p('08:00', 'America/New_York'), null, at('2026-10-24T13:00:00Z'), 'America/Los_Angeles').due).toBe(true);
    expect(briefDue(p('08:00', null), null, at('2026-10-24T13:00:00Z'), 'America/Los_Angeles').due).toBe(false);
  });

  it('falls back to UTC for an invalid timezone', () => {
    expect(briefDue(p('08:00', 'Not/AZone'), null, at('2026-10-24T08:00:00Z'), 'Also/Bad')).toEqual({ due: true, localDate: '2026-10-24' });
  });

  it('is not due twice the same local day', () => {
    const sentAt = at('2026-10-24T12:05:00Z'); // 08:05 EDT
    expect(briefDue(p('08:00', 'America/New_York'), sentAt, at('2026-10-24T20:00:00Z'), 'UTC').due).toBe(false);
    // 03:30Z on the 25th is still the 24th in New York
    expect(briefDue(p('08:00', 'America/New_York'), sentAt, at('2026-10-25T03:30:00Z'), 'UTC')).toEqual({ due: false, localDate: '2026-10-24' });
    expect(briefDue(p('08:00', 'America/New_York'), sentAt, at('2026-10-25T12:00:00Z'), 'UTC')).toEqual({ due: true, localDate: '2026-10-25' });
  });

  it('handles the midnight edge: 23:59 local vs 00:01 the next local day', () => {
    const tz = 'America/Los_Angeles'; // PDT, UTC-7
    const lastAt2359 = at('2026-10-24T06:59:00Z'); // 2026-10-23 23:59 PDT
    expect(briefDue(p('00:00', tz), lastAt2359, at('2026-10-24T06:59:30Z'), 'UTC')).toEqual({ due: false, localDate: '2026-10-23' });
    expect(briefDue(p('00:00', tz), lastAt2359, at('2026-10-24T07:01:00Z'), 'UTC')).toEqual({ due: true, localDate: '2026-10-24' });
  });

  it('follows the fall-back DST boundary (America/New_York, 2026-11-01)', () => {
    const tz = 'America/New_York';
    // 12:00Z on Nov 1 is 07:00 EST (it would have been 08:00 EDT the day before)
    expect(briefDue(p('08:00', tz), at('2026-10-31T12:00:00Z'), at('2026-11-01T12:00:00Z'), 'UTC')).toEqual({ due: false, localDate: '2026-11-01' });
    expect(briefDue(p('08:00', tz), at('2026-10-31T12:00:00Z'), at('2026-11-01T13:00:00Z'), 'UTC')).toEqual({ due: true, localDate: '2026-11-01' });
  });

  // #11287: a grant created after today's brief time waits for the next one,
  // not the next sweep ("Good morning" minutes after the grant, hours from 08:00).
  describe('a new grant (#11287)', () => {
    it('created after today\'s brief time: not due today, due at the next brief time', () => {
      const created = at('2026-10-24T14:00:00Z');
      expect(briefDue(p('08:00'), null, at('2026-10-24T14:05:00Z'), 'UTC', created)).toEqual({ due: false, localDate: '2026-10-24' });
      expect(briefDue(p('08:00'), null, at('2026-10-25T07:59:00Z'), 'UTC', created).due).toBe(false);
      expect(briefDue(p('08:00'), null, at('2026-10-25T08:00:00Z'), 'UTC', created)).toEqual({ due: true, localDate: '2026-10-25' });
    });

    it('created before today\'s brief time: due at it', () => {
      expect(briefDue(p('08:00'), null, at('2026-10-24T08:00:00Z'), 'UTC', at('2026-10-24T07:00:00Z')).due).toBe(true);
    });

    it('a brief from an earlier grant does not make a grant created after the brief time due', () => {
      expect(briefDue(p('08:00'), at('2026-10-20T08:00:00Z'), at('2026-10-24T14:05:00Z'), 'UTC', at('2026-10-24T14:00:00Z')).due).toBe(false);
    });

    it('judges "after the brief time" in the brief\'s zone', () => {
      // 13:00Z = 09:00 EDT: created after 08:00 New York time, so not due that day there.
      expect(briefDue(p('08:00', 'America/New_York'), null, at('2026-10-24T13:05:00Z'), 'UTC', at('2026-10-24T13:00:00Z')).due).toBe(false);
      // 11:00Z = 07:00 EDT: created before it, so due at 08:00 EDT.
      expect(briefDue(p('08:00', 'America/New_York'), null, at('2026-10-24T12:00:00Z'), 'UTC', at('2026-10-24T11:00:00Z')).due).toBe(true);
    });
  });

  it('follows the spring-forward DST boundary (America/New_York, 2026-03-08)', () => {
    const tz = 'America/New_York';
    // 08:00 EDT = 12:00Z after the jump (it was 13:00Z the day before)
    expect(briefDue(p('08:00', tz), at('2026-03-07T13:00:00Z'), at('2026-03-08T11:59:00Z'), 'UTC').due).toBe(false);
    expect(briefDue(p('08:00', tz), at('2026-03-07T13:00:00Z'), at('2026-03-08T12:00:00Z'), 'UTC')).toEqual({ due: true, localDate: '2026-03-08' });
    // 02:30 does not exist that day; at 03:00 EDT (07:00Z) the wall clock is past it
    expect(briefDue(p('02:30', tz), at('2026-03-07T08:00:00Z'), at('2026-03-08T07:00:00Z'), 'UTC').due).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildBrief
// ---------------------------------------------------------------------------

describe('buildBrief', () => {
  const NOW = new Date('2026-10-24T12:00:00Z');

  it('resolves the live ceiling from the grant row in system context', async () => {
    h.selectQueue.wisp_grants = [[{ currentRevisionId: REVISION, status: 'active' }]];
    await buildBrief(GRANT, NOW);
    // #11428: the overnight assessment counts read ai_agent_runs, also in system context.
    expect(h.selects).toEqual([{ table: 'wisp_grants', system: true }, { table: 'ai_agent_runs', system: true }]);
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(GRANT, REVISION);
    expect(h.listConcernsForCeiling).toHaveBeenCalledWith(CEILING, expect.objectContaining({ status: ['open', 'snoozed'] }));
  });

  it('throws GrantInactiveError when the grant has no pinned revision', async () => {
    h.selectQueue.wisp_grants = [[{ currentRevisionId: null, status: 'active' }]];
    await expect(buildBrief(GRANT, NOW)).rejects.toBeInstanceOf(GrantInactiveError);
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('with 0 concerns says nothing needs you and omits empty sections', async () => {
    h.selectQueue.wisp_grants = [[{ currentRevisionId: REVISION, status: 'active' }]];
    h.spendSummary.mockResolvedValue({ spentTodayCents: 0, backgroundCents: 0, chatCents: 0, budgetCentsPerDay: 200, budgetResetsAt: NOW });
    const brief = await buildBrief(GRANT, NOW);
    expect(brief.title).toBe('Good morning — nothing needs you');
    expect(brief.body).toBe('Nothing needs you right now.');
    expect(brief.sections.map((s) => s.heading)).toEqual(['Spend']);
    expect(brief.sections[0]!.lines).toEqual(['$0.00 of $2.00 today (background $0.00 · chat $0.00)']);
  });

  it('counts needs-you and open concerns; the body is the 3 most urgent open items, snoozed left out', async () => {
    h.selectQueue.wisp_grants = [[{ currentRevisionId: REVISION, status: 'active' }]];
    const long = 'Backups on the accounting server failed three nights in a row';
    h.listConcernsForCeiling.mockImplementation(async (_c: unknown, f: { status: string[] }) => (f.status.includes('resolved') ? [] : [
      concern({ severity: 'low', summary: 'Low thing' }),
      concern({ severity: 'high', summary: long, approvalIntentId: 'intent-1' }),
      concern({ severity: 'medium', summary: 'Patch window missed' }),
      concern({ severity: 'info', summary: 'Info thing' }),
      concern({ severity: 'high', summary: 'Snoozed high', status: 'snoozed', approvalIntentId: 'intent-2' }),
    ]));
    const brief = await buildBrief(GRANT, NOW);
    // Needs you: both approval cards (one snoozed). Open: the four that are not snoozed.
    expect(brief.title).toBe('Good morning — 2 need you, 4 open');
    // A 62-character summary now fits whole (#11428); snoozed concerns stay out of the lock-screen body.
    expect(brief.body.split(' · ')).toEqual([long, 'Patch window missed', 'Low thing']);
    const needs = brief.sections.find((s) => s.heading === 'Needs you');
    expect(needs?.lines).toEqual([long, 'Snoozed high']);
    const open = brief.sections.find((s) => s.heading === 'Open concerns');
    expect(open?.lines).toEqual(['high: 1', 'medium: 1', 'low: 1', 'info: 1']);
  });

  describe('#11428: who needs you, what is open, and what the body says', () => {
    const live = (rows: Concern[]) => h.listConcernsForCeiling.mockImplementation(
      async (_c: unknown, f: { status: string[] }) => (f.status.includes('resolved') ? [] : rows),
    );
    const readiness = (orgId: string) => concern({
      severity: 'info', subject: { kind: 'readiness', id: orgId }, signature: `readiness:${orgId}`, evidence: { readiness: { checks: [] } },
    });
    const resolved = (label: string) => ({ ref: { kind: 'device', id: ORG, orgId: ORG }, orgId: ORG, status: null, href: '/x', label });
    beforeEach(() => {
      h.selectQueue.wisp_grants = [[{ currentRevisionId: REVISION, status: 'active' }]];
    });

    it('two open HIGH concerns and no approval card: "2 need you"', async () => {
      live([
        concern({ severity: 'high', summary: 'No successful backup since July.' }),
        concern({ severity: 'high', summary: 'The maintenance window has no start time.' }),
        concern({ severity: 'medium', summary: 'Disk is filling up.' }),
      ]);
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.title).toBe('Good morning — 2 need you, 3 open');
      expect(brief.sections.find((s) => s.heading === 'Needs you')?.lines)
        .toEqual(['No successful backup since July.', 'The maintenance window has no start time.']);
    });

    it('a snoozed HIGH concern with no approval card does not need you', async () => {
      live([concern({ severity: 'high', status: 'snoozed', summary: 'Snoozed high' })]);
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.title).toBe('Good morning — nothing needs you');
      expect(brief.sections.find((s) => s.heading === 'Needs you')).toBeUndefined();
    });

    it('a readiness note is not an open concern, but still counts as a readiness gap', async () => {
      live([readiness(ORG), readiness(ORG2), concern({ severity: 'medium', summary: 'Patch window missed.' })]);
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.title).toBe('Good morning — 0 need you, 1 open');
      expect(brief.body).toBe('Patch window missed');
      expect(brief.sections.find((s) => s.heading === 'Open concerns')?.lines).toEqual(['medium: 1']);
      expect(brief.sections.find((s) => s.heading === 'Watching')?.lines).toEqual(['2 readiness gaps']);
    });

    it('only a snoozed concern with an approval card waiting: the body does not say nothing needs you', async () => {
      live([concern({ severity: 'medium', status: 'snoozed', approvalIntentId: 'intent-3', summary: 'Restart the print spooler?' })]);
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.title).toBe('Good morning — 1 need you, 0 open');
      expect(brief.body).toBe('Open Wisp to review.');
    });

    it('only readiness notes and snoozed concerns: nothing needs you', async () => {
      live([readiness(ORG), concern({ severity: 'low', status: 'snoozed' })]);
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.title).toBe('Good morning — nothing needs you');
      expect(brief.body).toBe('Nothing needs you right now.');
    });

    // #11426: the brief prefers a same-org rollup parent over its device children.
    it('counts a rollup parent once and folds its device children under it', async () => {
      const kids = [1, 2, 3].map((n) => concern({ severity: n === 2 ? 'high' : 'low', summary: `Phantom incident event ${n}` }));
      const parent = concern({
        subject: { kind: 'incident', id: '00000000-0000-4000-8000-0000000000ff' },
        severity: 'high', summary: '3 devices: phantom incident event', signature: `${ORG}:phantom_incident_event`,
        evidence: { rollup: 'device_pattern', pattern: 'phantom_incident_event', deviceCount: 3 },
        childConcernIds: kids.map((k) => k.id),
      });
      live([...kids, parent, concern({ severity: 'medium', summary: 'Disk is filling up.' })]);
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.title).toBe('Good morning — 1 need you, 2 open');
      expect(brief.body.split(' · ')).toEqual(['3 devices: phantom incident event', 'Disk is filling up']);
      expect(brief.sections.find((s) => s.heading === 'Needs you')?.lines).toEqual(['3 devices: phantom incident event']);
      expect(brief.sections.find((s) => s.heading === 'Open concerns')?.lines).toEqual(['high: 1', 'medium: 1']);
    });

    it('a snoozed rollup parent folds nothing: its live children count on their own', async () => {
      const kid = concern({ severity: 'high', summary: 'Phantom incident event' });
      const parent = concern({
        subject: { kind: 'incident', id: '00000000-0000-4000-8000-0000000000fd' }, severity: 'high', status: 'snoozed',
        summary: '3 devices: phantom incident event', evidence: { rollup: 'device_pattern' }, childConcernIds: [kid.id],
      });
      live([kid, parent]);
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.title).toBe('Good morning — 1 need you, 1 open');
      expect(brief.body).toBe('Phantom incident event');
    });

    it('a folded child with an approval card waiting still needs you', async () => {
      const kid = concern({ severity: 'low', approvalIntentId: 'intent-7', summary: 'Restart the agent?' });
      const parent = concern({
        subject: { kind: 'incident', id: '00000000-0000-4000-8000-0000000000fe' }, severity: 'low',
        summary: '3 devices: phantom incident event', evidence: { rollup: 'device_pattern' }, childConcernIds: [kid.id],
      });
      live([kid, parent]);
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.title).toBe('Good morning — 1 need you, 1 open');
      expect(brief.sections.find((s) => s.heading === 'Needs you')?.lines).toEqual(['Restart the agent?']);
    });

    it('a 120-character summary is cut at a word boundary within 90 characters, not 39 + "…"', async () => {
      const summary = 'Backups on the accounting server have failed every night since the first of July and nobody has looked at them since now';
      expect(summary).toHaveLength(120);
      live([concern({ severity: 'high', summary })]);
      const { body } = await buildBrief(GRANT, NOW);
      expect(body).toBe('Backups on the accounting server have failed every night since the first of July and…');
      expect([...body].length).toBeLessThanOrEqual(90);
    });

    it('a summary that fills the cut exactly up to a space keeps its last word', async () => {
      // 89 characters, then a space: no word is broken, so none is dropped.
      const head = 'Backups on the accounting server failed every night since July first and the odd cause is';
      expect(head).toHaveLength(89);
      live([concern({ severity: 'high', summary: `${head} unknown to everyone involved so far` })]);
      expect((await buildBrief(GRANT, NOW)).body).toBe(`${head}…`);
    });

    it('the body fits the 120-character push clip with whole items, most urgent first', async () => {
      // 75 + " · " + 71 = 149: the second item would be cut mid-word by the push clip, so it is left out.
      const a = 'Backups on the file server have failed three nights in a row with one error';
      live([
        concern({ severity: 'high', summary: a, updatedAt: '2026-10-23T03:00:00.000Z' }),
        concern({ severity: 'high', summary: 'The print spooler on the front desk PC keeps crashing every morning now', updatedAt: '2026-10-23T02:00:00.000Z' }),
        concern({ severity: 'medium', summary: 'Disk C: on the accounting laptop is ninety-seven percent full' }),
      ]);
      expect((await buildBrief(GRANT, NOW)).body).toBe(a);

      h.selectQueue.wisp_grants = [[{ currentRevisionId: REVISION, status: 'active' }]];
      // 34 + 3 + 39 = 76 fits; adding 3 + 28 makes 107, which fits too.
      live([
        concern({ severity: 'high', summary: 'Patch window missed on six devices', updatedAt: '2026-10-23T03:00:00.000Z' }),
        concern({ severity: 'high', summary: 'Antivirus definitions are four days old', updatedAt: '2026-10-23T02:00:00.000Z' }),
        concern({ severity: 'high', summary: 'Two admins share one account', updatedAt: '2026-10-23T01:00:00.000Z' }),
      ]);
      expect((await buildBrief(GRANT, NOW)).body)
        .toBe('Patch window missed on six devices · Antivirus definitions are four days old · Two admins share one account');
    });

    it('a first item too long for the push on its own is cut at a word to fit it', async () => {
      const label = 'SYNTHETIC-DAIRY-RECEPTION-PC-00012345';
      live([concern({ severity: 'high', subject: { kind: 'device', id: ORG }, summary: 'Backups on the accounting server have failed every night since the first of July and nobody has looked at them since now' })]);
      h.resolveEntity.mockResolvedValue(resolved(label));
      const { body } = await buildBrief(GRANT, NOW);
      expect(body).toBe(`${label}: Backups on the accounting server have failed every night since the first of July…`);
      expect([...body].length).toBeLessThanOrEqual(120);
    });

    it('a single word longer than half the room is cut where it falls', async () => {
      live([concern({ severity: 'high', summary: `Path ${'x'.repeat(100)} is unreadable` })]);
      expect((await buildBrief(GRANT, NOW)).body).toBe(`Path ${'x'.repeat(84)}…`);
    });

    it('a cut that lands after a comma drops the comma before the ellipsis', async () => {
      live([concern({ severity: 'high', summary: 'Backups on the accounting server have failed every night since the first of July, unbelievablyunrecoverable errors since' })]);
      expect((await buildBrief(GRANT, NOW)).body).toBe('Backups on the accounting server have failed every night since the first of July…');
    });

    it('a subject name longer than 40 characters is cut to 40', async () => {
      live([concern({ severity: 'high', subject: { kind: 'device', id: ORG }, summary: 'Disk full.' })]);
      h.resolveEntity.mockResolvedValue(resolved('SYNTHETIC-WORKSTATION-WITH-A-VERY-LONG-NAME-0001'));
      expect((await buildBrief(GRANT, NOW)).body).toBe('SYNTHETIC-WORKSTATION-WITH-A-VERY-LONG…: Disk full');
    });

    it('a "?" or "!" ends the first sentence, and line breaks read as spaces', async () => {
      live([
        concern({ severity: 'high', summary: 'Is the backup\nvault still mounted? It went quiet.', updatedAt: '2026-10-23T02:00:00.000Z' }),
        concern({ severity: 'high', summary: 'Ransomware canary tripped! Isolate now.', updatedAt: '2026-10-23T01:00:00.000Z' }),
      ]);
      expect((await buildBrief(GRANT, NOW)).body).toBe('Is the backup vault still mounted? · Ransomware canary tripped!');
    });

    it('takes the first sentence of the summary only', async () => {
      live([concern({ severity: 'high', summary: 'Cove backup has not succeeded since 2026-07-01. The last 41 jobs failed.' })]);
      expect((await buildBrief(GRANT, NOW)).body).toBe('Cove backup has not succeeded since 2026-07-01');
    });

    it('a decimal point does not end the first sentence', async () => {
      live([concern({ severity: 'high', summary: 'Agent v0.127.0 crashed twice overnight. Restarted.' })]);
      expect((await buildBrief(GRANT, NOW)).body).toBe('Agent v0.127.0 crashed twice overnight');
    });

    it('orders the body HIGH first, then newest first, and keeps 3 items', async () => {
      live([
        concern({ severity: 'medium', summary: 'Medium new', updatedAt: '2026-10-24T09:00:00.000Z' }),
        concern({ severity: 'high', summary: 'High old', updatedAt: '2026-10-20T00:00:00.000Z' }),
        concern({ severity: 'medium', summary: 'Medium old', updatedAt: '2026-10-21T00:00:00.000Z' }),
        concern({ severity: 'high', summary: 'High new', updatedAt: '2026-10-23T00:00:00.000Z' }),
      ]);
      expect((await buildBrief(GRANT, NOW)).body.split(' · ')).toEqual(['High new', 'High old', 'Medium new']);
    });

    it('leads an item with the subject name the ceiling resolves for a device or org subject', async () => {
      live([
        concern({ severity: 'high', subject: { kind: 'device', id: ORG }, summary: 'No successful Cove backup since July 1.' }),
        concern({ severity: 'medium', subject: { kind: 'org', id: ORG2 }, summary: 'Two admins share one account.' }),
      ]);
      h.resolveEntity.mockImplementation(async (ref: { kind: string }) => resolved(ref.kind === 'device' ? 'FRONT-DESK-01' : 'Synthetic Dairy'));
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.body).toBe('FRONT-DESK-01: No successful Cove backup since July 1 · Synthetic Dairy: Two admins share one account');
      expect(h.createEntityResolver).toHaveBeenCalledWith({ ceiling: CEILING });
      expect(h.resolveEntity.mock.calls.map((c) => c[0])).toEqual([{ kind: 'device', id: ORG }, { kind: 'organization', id: ORG2 }]);
    });

    it('does not repeat the subject name when the summary already starts with it', async () => {
      live([concern({ severity: 'high', subject: { kind: 'device', id: ORG }, summary: 'front-desk-01 has had no successful backup since July 1.' })]);
      h.resolveEntity.mockResolvedValue(resolved('FRONT-DESK-01'));
      expect((await buildBrief(GRANT, NOW)).body).toBe('front-desk-01 has had no successful backup since July 1');
    });

    it('a summary that opens with a longer name (web-10) still gets the subject name (web-1)', async () => {
      live([concern({ severity: 'high', subject: { kind: 'device', id: ORG }, summary: 'web-10 answers for web-1 while it reboots.' })]);
      h.resolveEntity.mockResolvedValue(resolved('web-1'));
      expect((await buildBrief(GRANT, NOW)).body).toBe('web-1: web-10 answers for web-1 while it reboots');
    });

    it('resolves names for the body items only, not every open concern', async () => {
      live([1, 2, 3, 4, 5].map((n) => concern({
        severity: 'high', subject: { kind: 'device', id: ORG }, summary: `Device problem ${n}.`, updatedAt: `2026-10-23T0${n}:00:00.000Z`,
      })));
      h.resolveEntity.mockResolvedValue(resolved('PC'));
      await buildBrief(GRANT, NOW);
      expect(h.resolveEntity).toHaveBeenCalledTimes(3);
    });

    it('never resolves a free-text subject (a ticket title stays off the lock screen)', async () => {
      live([concern({ severity: 'high', subject: { kind: 'ticket', id: ORG }, summary: 'Printer ticket waiting three days.' })]);
      expect((await buildBrief(GRANT, NOW)).body).toBe('Printer ticket waiting three days');
      expect(h.resolveEntity).not.toHaveBeenCalled();
    });

    it('a subject the ceiling refuses, or a failed label read, leaves the item without a name', async () => {
      live([
        concern({ severity: 'high', subject: { kind: 'device', id: ORG }, summary: 'Refused device.', updatedAt: '2026-10-23T02:00:00.000Z' }),
        concern({ severity: 'high', subject: { kind: 'device', id: ORG2 }, summary: 'Broken read.', updatedAt: '2026-10-23T01:00:00.000Z' }),
      ]);
      const boom = new Error('label read failed');
      h.resolveEntity.mockResolvedValueOnce({ reason: 'outside_ceiling' }).mockRejectedValueOnce(boom);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const brief = await buildBrief(GRANT, NOW);
        expect(brief.body).toBe('Refused device · Broken read');
        expect(h.captureException).toHaveBeenCalledTimes(1);
        expect(h.captureException).toHaveBeenCalledWith(boom, undefined, expect.objectContaining({ grantId: GRANT, area: 'wisp_brief' }));
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('reports overnight activity since the given time, spend and watching with readiness gaps', async () => {
    h.selectQueue.wisp_grants = [[{ currentRevisionId: REVISION, status: 'active' }]];
    h.selectQueue.ai_agent_runs = [[{ ran: 2, skipped: 0 }]];
    const since = new Date('2026-10-23T12:00:00Z');
    h.listActivity.mockResolvedValue({
      items: [
        // #11428: assessments are counted from ai_agent_runs, not from this capped feed.
        activity('assessment', '2026-10-24T03:00:00Z'),
        activity('specialist', '2026-10-24T01:00:00Z'),
        activity('nudge', '2026-10-24T01:00:00Z'),
        activity('assessment', '2026-10-23T11:00:00Z'), // before the last brief
      ],
      nextCursor: null,
    });
    h.listConcernsForCeiling.mockImplementation(async (_c: unknown, f: { status: string[] }) => (f.status.includes('resolved')
      ? [
        concern({ status: 'resolved', resolvedAt: '2026-10-24T04:00:00Z' }),
        concern({ status: 'resolved', resolvedAt: '2026-10-22T04:00:00Z' }),
      ]
      : [
        concern({ severity: 'info', subject: { kind: 'readiness', id: ORG }, signature: `readiness:${ORG}`, evidence: { readiness: { checks: [] } } }),
        concern({ severity: 'info', subject: { kind: 'org', id: ORG }, evidence: {} }),
        concern({ severity: 'info', subject: { kind: 'readiness', id: ORG2 }, signature: `readiness:${ORG2}`, evidence: { readiness: { checks: [] } } }),
        // #10386: an org-level concern is never a readiness gap, whatever its evidence says.
        concern({ severity: 'high', subject: { kind: 'org', id: ORG }, evidence: { readiness: { checks: [] } } }),
      ]));
    h.spendSummary.mockResolvedValue({ spentTodayCents: 200, backgroundCents: 30, chatCents: 170, budgetCentsPerDay: 500, budgetResetsAt: NOW });
    h.listWatches.mockResolvedValue([{ status: 'active' }, { status: 'active' }, { status: 'stopped' }]);

    const brief = await buildBrief(GRANT, NOW, { since });
    const byHeading = Object.fromEntries(brief.sections.map((s) => [s.heading, s.lines]));
    expect(byHeading.Overnight).toEqual(['2 assessments run', '1 specialist launched', '1 concern resolved']);
    expect(byHeading.Spend).toEqual(['$2.00 of $5.00 today (background $0.30 · chat $1.70)']);
    expect(byHeading.Watching).toEqual(['2 active watches', '2 readiness gaps']);
    expect(h.listActivity).toHaveBeenCalledWith(CEILING, { limit: 100 });
    expect(h.spendSummary).toHaveBeenCalledWith(GRANT, NOW);
  });

  describe('#11428: assessments skipped because nothing changed (#11423)', () => {
    beforeEach(() => {
      h.selectQueue.wisp_grants = [[{ currentRevisionId: REVISION, status: 'active' }]];
    });

    it('adds a skipped line beside the assessments that ran', async () => {
      h.selectQueue.ai_agent_runs = [[{ ran: 3, skipped: 41 }]];
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.sections.find((s) => s.heading === 'Overnight')?.lines)
        .toEqual(['3 assessments run', '41 assessments skipped — nothing had changed']);
    });

    it('one skip reads in the singular, with no ran line when none ran', async () => {
      h.selectQueue.ai_agent_runs = [[{ ran: 0, skipped: 1 }]];
      const brief = await buildBrief(GRANT, NOW);
      expect(brief.sections.find((s) => s.heading === 'Overnight')?.lines).toEqual(['1 assessment skipped — nothing had changed']);
    });

    it('tolerates zero and an absent row: no skipped line, no Overnight section', async () => {
      h.selectQueue.ai_agent_runs = [[{ ran: 0, skipped: 0 }]];
      expect((await buildBrief(GRANT, NOW)).sections.map((s) => s.heading)).toEqual(['Spend']);
      h.selectQueue.wisp_grants = [[{ currentRevisionId: REVISION, status: 'active' }]];
      h.selectQueue.ai_agent_runs = [[]];
      expect((await buildBrief(GRANT, NOW)).sections.map((s) => s.heading)).toEqual(['Spend']);
    });

    it('orgs each restricted to sites by their own term read no runs either', async () => {
      const sites = { siteIds: new Set(['00000000-0000-4000-8000-000000000f01']) };
      h.resolveGrantCeiling.mockResolvedValue({ ...CEILING, orgTerms: new Map([[ORG, sites], [ORG2, sites]]) });
      h.selectQueue.ai_agent_runs = [[{ ran: 9, skipped: 9 }]];
      const brief = await buildBrief(GRANT, NOW);
      expect(h.selects.some((s) => s.table === 'ai_agent_runs')).toBe(false);
      expect(brief.sections.find((s) => s.heading === 'Overnight')).toBeUndefined();
    });

    it('a site-restricted ceiling (no org-level reach) reads no runs', async () => {
      h.resolveGrantCeiling.mockResolvedValue({ ...CEILING, siteIds: new Set(['00000000-0000-4000-8000-000000000f01']) });
      h.selectQueue.ai_agent_runs = [[{ ran: 9, skipped: 9 }]];
      const brief = await buildBrief(GRANT, NOW);
      expect(h.selects.some((s) => s.table === 'ai_agent_runs')).toBe(false);
      expect(brief.sections.find((s) => s.heading === 'Overnight')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// runMorningBriefs
// ---------------------------------------------------------------------------

describe('briefScheduleFor (#10391)', () => {
  it('the preference time and zone win; no device read when the preference names a zone', async () => {
    h.loadNudgeBookkeeping.mockResolvedValueOnce(new Map([[USER, { prefs: prefs({ briefTimeLocal: '07:15', briefTimezone: 'Europe/Berlin' }), lastDigestAt: null, lastBriefAt: null }]]));
    await expect(briefScheduleFor(USER)).resolves.toEqual({ timeLocal: '07:15', timezone: 'Europe/Berlin' });
    expect(h.selects.some((s) => s.table === 'mobile_devices')).toBe(false);
  });

  it('falls back to the oldest device zone (system context), else UTC, as the sweep does', async () => {
    h.selectQueue.mobile_devices = [[{ userId: USER, timezone: 'America/Los_Angeles' }], []];
    await expect(briefScheduleFor(USER)).resolves.toEqual({ timeLocal: resolveWispNudgePrefs(null).briefTimeLocal, timezone: 'America/Los_Angeles' });
    expect(h.selects.find((s) => s.table === 'mobile_devices')?.system).toBe(true);
    await expect(briefScheduleFor(USER)).resolves.toMatchObject({ timezone: 'UTC' });
  });

  it('briefs off (null time) reads as off, and an unknown zone as UTC', async () => {
    h.loadNudgeBookkeeping.mockResolvedValueOnce(new Map([[USER, { prefs: prefs({ briefTimeLocal: null, briefTimezone: 'Not/AZone' }), lastDigestAt: null, lastBriefAt: null }]]));
    await expect(briefScheduleFor(USER)).resolves.toEqual({ timeLocal: null, timezone: 'UTC' });
  });
});

describe('runMorningBriefs', () => {
  const NOW = new Date('2026-10-24T12:30:00Z'); // 08:30 EDT

  /** Every buildBrief call reads the grant row again. */
  function queueSweep(
    grants: Array<Record<string, unknown>>,
    devices: Array<{ userId: string; timezone: string | null }> = [],
    partners: Array<{ id: string; timezone: string }> = [],
  ) {
    h.selectQueue.wisp_grants = [grants, ...Array.from({ length: 10 }, () => [{ currentRevisionId: REVISION, status: 'active' }])];
    h.selectQueue.mobile_devices = [devices];
    h.selectQueue.partners = [partners];
  }

  describe('the fallback zone with no chosen preference (#10402)', () => {
    // 12:30Z = 05:30 PDT (not due), 06:30 MDT (not due), 08:30 EDT (due), 12:30 UTC (due).
    const book = (browserTimezone: string | null) => new Map([[USER, { prefs: prefs(), lastDigestAt: null, lastBriefAt: null, browserTimezone }]]);

    it('a browser zone beats the partner zone', async () => {
      queueSweep([grantRow()], [], [{ id: PARTNER, timezone: 'America/New_York' }]);
      h.loadNudgeBookkeeping.mockResolvedValue(book('America/Denver'));
      await expect(runMorningBriefs(NOW)).resolves.toEqual({ due: 0, sent: 0, suppressed: 0 });
    });

    it('a phone zone beats the browser zone', async () => {
      queueSweep([grantRow()], [{ userId: USER, timezone: 'America/New_York' }], []);
      h.loadNudgeBookkeeping.mockResolvedValue(book('America/Denver'));
      await expect(runMorningBriefs(NOW)).resolves.toEqual({ due: 1, sent: 1, suppressed: 0 });
    });

    it('with no phone and no browser the partner zone decides, not UTC', async () => {
      queueSweep([grantRow()], [], [{ id: PARTNER, timezone: 'America/Los_Angeles' }]);
      await expect(runMorningBriefs(NOW)).resolves.toEqual({ due: 0, sent: 0, suppressed: 0 });
      expect(h.notifyUser).not.toHaveBeenCalled();
    });

    it('with nothing known it is UTC', async () => {
      queueSweep([grantRow()], [], []);
      await expect(runMorningBriefs(NOW)).resolves.toEqual({ due: 1, sent: 1, suppressed: 0 });
    });
  });

  it('is dark while wispEnabled() is false: no read, no brief', async () => {
    h.wispEnabled.mockReturnValueOnce(false);
    queueSweep([grantRow()]);
    await expect(runMorningBriefs(NOW)).resolves.toEqual({ due: 0, sent: 0, suppressed: 0 });
    expect(h.selects).toHaveLength(0);
    expect(h.notifyUser).not.toHaveBeenCalled();
  });

  it('#11287: a grant created minutes ago, after today\'s brief time, gets no brief yet', async () => {
    h.loadNudgeBookkeeping.mockResolvedValue(new Map([[USER, { prefs: prefs({ briefTimezone: 'America/New_York' }), lastDigestAt: null, lastBriefAt: null }]]));
    queueSweep([grantRow({ createdAt: new Date('2026-10-24T12:25:00Z') })]); // 08:25 EDT, after 08:00
    await expect(runMorningBriefs(NOW)).resolves.toEqual({ due: 0, sent: 0, suppressed: 0 });
    expect(h.notifyUser).not.toHaveBeenCalled();
  });

  it('sends one brief per local day across two sweeps (lastBriefAt from the first sweep)', async () => {
    const store = new Map<string, Date>();
    h.loadNudgeBookkeeping.mockImplementation(async (ids: string[]) => new Map(ids.filter((id) => store.has(id)).map((id) => [
      id, { prefs: prefs({ briefTimezone: 'America/New_York' }), lastDigestAt: null, lastBriefAt: store.get(id)! },
    ])));
    h.markBriefSent.mockImplementation(async (userId: string, _p: string, at: Date) => { store.set(userId, at); });

    queueSweep([grantRow()]);
    const first = await runMorningBriefs(NOW);
    queueSweep([grantRow()]);
    const second = await runMorningBriefs(new Date('2026-10-24T13:15:00Z'));

    expect(first).toEqual({ due: 1, sent: 1, suppressed: 0 });
    expect(second).toEqual({ due: 0, sent: 0, suppressed: 0 });
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
    expect(h.markBriefSent).toHaveBeenCalledWith(USER, PARTNER, NOW);
  });

  it('builds the notifyUser payload outside any DB context with the brief date as the dedupe key', async () => {
    queueSweep([grantRow()]);
    let inSystemAtNotify: boolean | null = null;
    h.notifyUser.mockImplementation(async () => { inSystemAtNotify = h.state.inSystem; return { inApp: true, pushed: 0, suppressed: null }; });
    await runMorningBriefs(new Date('2026-10-24T08:30:00Z'));
    expect(inSystemAtNotify).toBe(false);
    expect(h.notifyUser).toHaveBeenCalledWith({
      userId: USER,
      category: 'wisp_nudge',
      kind: 'brief',
      concernId: null,
      threadId: THREAD,
      grantId: GRANT,
      deepLink: `breeze://wisp/thread/${THREAD}`,
      title: 'Good morning — nothing needs you',
      body: 'Nothing needs you right now.',
      briefLocalDate: '2026-10-24',
      briefSections: [{ heading: 'Spend', lines: ['$0.00 of $2.00 today (background $0.00 · chat $0.00)'] }],
    });
    expect(h.loadNudgeBookkeeping).toHaveBeenCalledTimes(1);
  });

  it('uses the grantor’s oldest device timezone as the fallback, else UTC', async () => {
    // 12:30Z = 05:30 PDT (not due), 12:30 UTC (due)
    queueSweep(
      [grantRow(), grantRow({ id: GRANT_2, grantorUserId: USER_2 })],
      [{ userId: USER, timezone: 'America/Los_Angeles' }, { userId: USER, timezone: 'Europe/Berlin' }],
    );
    const res = await runMorningBriefs(NOW);
    expect(res).toEqual({ due: 1, sent: 1, suppressed: 0 });
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
    expect(h.notifyUser.mock.calls[0]![0].userId).toBe(USER_2);
    expect(h.loadNudgeBookkeeping).toHaveBeenCalledWith([USER, USER_2]);
  });

  it('gives a user-paused grant no brief', async () => {
    queueSweep([grantRow({ status: 'paused', pausedReason: 'user_paused' })]);
    const res = await runMorningBriefs(NOW);
    expect(h.notifyUser).not.toHaveBeenCalled();
    expect(res).toEqual({ due: 0, sent: 0, suppressed: 0 });
  });

  it('gives a system-paused grant a one-line brief naming the reason', async () => {
    queueSweep([grantRow({ status: 'paused', pausedReason: 'budget_exhausted' })]);
    const res = await runMorningBriefs(NOW);
    expect(res).toEqual({ due: 1, sent: 1, suppressed: 0 });
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
    const payload = h.notifyUser.mock.calls[0]![0];
    expect(payload.title).toBe('Wisp is paused');
    expect(payload.body).toMatch(/budget/i);
    expect(payload.briefSections).toEqual([]);
    expect(payload.kind).toBe('brief');
  });

  it('stamps the day consumed whenever notifyUser returned (delivered, deduped or suppressed by prefs) — no rebuild every sweep', async () => {
    queueSweep([grantRow(), grantRow({ id: GRANT_2, grantorUserId: USER_2 }), grantRow({ id: GRANT_3, grantorUserId: USER_3 })]);
    h.notifyUser
      .mockResolvedValueOnce({ inApp: false, pushed: 0, suppressed: 'prefs' })
      .mockResolvedValueOnce({ inApp: false, pushed: 2, suppressed: null })
      .mockResolvedValueOnce({ inApp: true, pushed: 0, suppressed: null });
    const res = await runMorningBriefs(NOW);
    expect(res).toEqual({ due: 3, sent: 2, suppressed: 1 });
    expect(h.markBriefSent.mock.calls.map((c) => c[0])).toEqual([USER, USER_2, USER_3]);
  });

  it('skips a user whose brief is off', async () => {
    h.loadNudgeBookkeeping.mockResolvedValue(new Map([[USER, { prefs: prefs({ briefTimeLocal: null }), lastDigestAt: null, lastBriefAt: null }]]));
    queueSweep([grantRow()]);
    expect(await runMorningBriefs(NOW)).toEqual({ due: 0, sent: 0, suppressed: 0 });
    expect(h.getOrCreateThread).not.toHaveBeenCalled();
  });

  it('catches a per-grant failure, captures it, and keeps sweeping', async () => {
    queueSweep([grantRow(), grantRow({ id: GRANT_2, grantorUserId: USER_2 })]);
    const boom = new Error('thread table on fire');
    h.getOrCreateThread.mockRejectedValueOnce(boom);
    const res = await runMorningBriefs(NOW);
    expect(res).toEqual({ due: 2, sent: 1, suppressed: 0 });
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, expect.objectContaining({ grantId: GRANT }));
    expect(h.notifyUser.mock.calls[0]![0].grantId).toBe(GRANT_2);
  });
});
