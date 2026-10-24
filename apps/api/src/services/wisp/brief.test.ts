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
vi.mock('./threads', () => ({ getOrCreateThread: h.getOrCreateThread }));
vi.mock('./notifyUser', () => ({ notifyUser: h.notifyUser }));
vi.mock('./nudgePreferences', () => ({ loadNudgeBookkeeping: h.loadNudgeBookkeeping, markBriefSent: h.markBriefSent }));
vi.mock('./nudgeLinks', () => ({ mobileDeepLink: (threadId: string) => `breeze://wisp/thread/${threadId}` }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wispEnabled: () => h.wispEnabled(),
}));

import { GrantInactiveError } from './grantAuthority';
import { briefDue, buildBrief, runMorningBriefs } from './brief';

const GRANT = '00000000-0000-4000-8000-000000000a01';
const GRANT_2 = '00000000-0000-4000-8000-000000000a02';
const GRANT_3 = '00000000-0000-4000-8000-000000000a03';
const REVISION = '00000000-0000-4000-8000-000000000a09';
const PARTNER = '00000000-0000-4000-8000-000000000b01';
const USER = '00000000-0000-4000-8000-000000000c01';
const USER_2 = '00000000-0000-4000-8000-000000000c02';
const USER_3 = '00000000-0000-4000-8000-000000000c03';
const ORG = '00000000-0000-4000-8000-000000000d01';
const THREAD = '00000000-0000-4000-8000-000000000e01';

const CEILING = { grantId: GRANT, revisionId: REVISION, partnerId: PARTNER, grantorUserId: USER, status: 'active' };

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
  h.spendSummary.mockResolvedValue({ spentTodayCents: 0, budgetCentsPerDay: 200, budgetResetsAt: new Date() });
  h.listWatches.mockResolvedValue([]);
  h.listActivity.mockResolvedValue({ items: [], nextCursor: null });
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
    expect(h.selects).toEqual([{ table: 'wisp_grants', system: true }]);
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
    h.spendSummary.mockResolvedValue({ spentTodayCents: 0, budgetCentsPerDay: 200, budgetResetsAt: NOW });
    const brief = await buildBrief(GRANT, NOW);
    expect(brief.title).toBe('Good morning — nothing needs you');
    expect(brief.body).toBe('Nothing needs you right now.');
    expect(brief.sections.map((s) => s.heading)).toEqual(['Spend']);
    expect(brief.sections[0]!.lines).toEqual(['0¢ of 200¢ today']);
  });

  it('counts needs-you and open concerns, truncates the body to 3 highest-severity summaries', async () => {
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
    expect(brief.title).toBe('Good morning — 2 need you, 5 open');
    const parts = brief.body.split(' · ');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(`${long.slice(0, 39)}…`);
    expect([...parts[0]!].length).toBe(40);
    // snoozed concerns stay out of the lock-screen body
    expect(parts.slice(1)).toEqual(['Patch window missed', 'Low thing']);
    const needs = brief.sections.find((s) => s.heading === 'Needs you');
    expect(needs?.lines).toEqual([long, 'Snoozed high']);
    const open = brief.sections.find((s) => s.heading === 'Open concerns');
    expect(open?.lines).toEqual(['high: 2', 'medium: 1', 'low: 1', 'info: 1']);
  });

  it('reports overnight activity since the given time, spend and watching with readiness gaps', async () => {
    h.selectQueue.wisp_grants = [[{ currentRevisionId: REVISION, status: 'active' }]];
    const since = new Date('2026-10-23T12:00:00Z');
    h.listActivity.mockResolvedValue({
      items: [
        activity('assessment', '2026-10-24T03:00:00Z'),
        activity('assessment', '2026-10-24T02:00:00Z'),
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
        concern({ severity: 'info', subject: { kind: 'org', id: ORG }, signature: `readiness:${ORG}`, evidence: { readiness: { checks: [] } } }),
        concern({ severity: 'info', subject: { kind: 'org', id: ORG }, evidence: {} }),
      ]));
    h.spendSummary.mockResolvedValue({ spentTodayCents: 42, budgetCentsPerDay: 200, budgetResetsAt: NOW });
    h.listWatches.mockResolvedValue([{ status: 'active' }, { status: 'active' }, { status: 'stopped' }]);

    const brief = await buildBrief(GRANT, NOW, { since });
    const byHeading = Object.fromEntries(brief.sections.map((s) => [s.heading, s.lines]));
    expect(byHeading.Overnight).toEqual(['2 assessments run', '1 specialist launched', '1 concern resolved']);
    expect(byHeading.Spend).toEqual(['42¢ of 200¢ today']);
    expect(byHeading.Watching).toEqual(['2 active watches', '1 readiness gap']);
    expect(h.listActivity).toHaveBeenCalledWith(CEILING, { limit: 100 });
    expect(h.spendSummary).toHaveBeenCalledWith(GRANT, NOW);
  });
});

// ---------------------------------------------------------------------------
// runMorningBriefs
// ---------------------------------------------------------------------------

describe('runMorningBriefs', () => {
  const NOW = new Date('2026-10-24T12:30:00Z'); // 08:30 EDT

  /** Every buildBrief call reads the grant row again. */
  function queueSweep(grants: Array<Record<string, unknown>>, devices: Array<{ userId: string; timezone: string | null }> = []) {
    h.selectQueue.wisp_grants = [grants, ...Array.from({ length: 10 }, () => [{ currentRevisionId: REVISION, status: 'active' }])];
    h.selectQueue.mobile_devices = [devices];
  }

  it('is dark while wispEnabled() is false: no read, no brief', async () => {
    h.wispEnabled.mockReturnValueOnce(false);
    queueSweep([grantRow()]);
    await expect(runMorningBriefs(NOW)).resolves.toEqual({ due: 0, sent: 0, suppressed: 0 });
    expect(h.selects).toHaveLength(0);
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
      briefSections: [{ heading: 'Spend', lines: ['0¢ of 200¢ today'] }],
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

  it('marks the brief sent only when it was delivered somewhere', async () => {
    queueSweep([grantRow(), grantRow({ id: GRANT_2, grantorUserId: USER_2 }), grantRow({ id: GRANT_3, grantorUserId: USER_3 })]);
    h.notifyUser
      .mockResolvedValueOnce({ inApp: false, pushed: 0, suppressed: 'prefs' })
      .mockResolvedValueOnce({ inApp: false, pushed: 2, suppressed: null })
      .mockResolvedValueOnce({ inApp: true, pushed: 0, suppressed: null });
    const res = await runMorningBriefs(NOW);
    expect(res).toEqual({ due: 3, sent: 2, suppressed: 1 });
    expect(h.markBriefSent.mock.calls.map((c) => c[0])).toEqual([USER_2, USER_3]);
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
