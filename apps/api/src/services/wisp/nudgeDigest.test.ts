import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWispNudgePrefs } from '@breeze/shared';

/**
 * services/wisp/nudgeDigest.ts — the digest sweep (W06a Task 5; w00 A28).
 * `db` is a chain fake whose select resolves queued rows; notifyUser, the
 * bookkeeping, the grant ceiling and the concern list are mocked.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'limit', 'orderBy', 'groupBy', 'from', 'where']) p[m] = vi.fn(() => p);
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  class GrantInactiveError extends Error {
    constructor(public readonly kind: 'paused' | 'ended' | 'corrupt') { super(kind); }
  }
  return {
    results,
    enabled: true,
    db: { select: vi.fn(() => chain()) },
    inSystemContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    resolveGrantCeiling: vi.fn(),
    listConcernsForCeiling: vi.fn(),
    notifyUser: vi.fn(),
    loadNudgeBookkeeping: vi.fn(),
    markDigestSent: vi.fn(),
    captureException: vi.fn(),
    GrantInactiveError,
  };
});

vi.mock('../../db', () => ({ db: h.db }));
vi.mock('../../config/env', () => ({ wispEnabled: () => h.enabled }));
vi.mock('../sentry', () => ({ captureException: (...a: unknown[]) => h.captureException(...a) }));
vi.mock('./grantAuthority', () => ({
  inSystemContext: h.inSystemContext,
  resolveGrantCeiling: (...a: unknown[]) => h.resolveGrantCeiling(...a),
  GrantInactiveError: h.GrantInactiveError,
}));
vi.mock('./concerns', () => ({ listConcernsForCeiling: (...a: unknown[]) => h.listConcernsForCeiling(...a) }));
vi.mock('./notifyUser', () => ({ notifyUser: (...a: unknown[]) => h.notifyUser(...a) }));
vi.mock('./nudgePreferences', () => ({
  loadNudgeBookkeeping: (...a: unknown[]) => h.loadNudgeBookkeeping(...a),
  markDigestSent: (...a: unknown[]) => h.markDigestSent(...a),
}));

import { buildDigestText, digestDue, runNudgeDigest, selectDigestCandidates } from './nudgeDigest';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const MIN = 60_000;
const prefs = resolveWispNudgePrefs(null);

function row(grant: string, concern: string, extra: Record<string, unknown> = {}) {
  return {
    grantId: grant, threadId: `t-${grant}`, userId: `u-${grant}`, partnerId: 'p1', currentRevisionId: `r-${grant}`,
    concernId: concern, summary: `summary ${concern}`, severity: 'medium', ...extra,
  };
}

beforeEach(() => {
  h.results.length = 0;
  h.enabled = true;
  for (const f of [h.resolveGrantCeiling, h.listConcernsForCeiling, h.notifyUser, h.loadNudgeBookkeeping, h.markDigestSent, h.captureException, h.db.select]) f.mockClear();
  h.resolveGrantCeiling.mockImplementation(async (g: string) => ({ grantId: g }));
  h.listConcernsForCeiling.mockImplementation(async () => [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }]);
  h.loadNudgeBookkeeping.mockImplementation(async () => new Map());
  h.notifyUser.mockImplementation(async () => ({ inApp: true, pushed: 1, suppressed: null }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('digestDue', () => {
  it('is due when never sent', () => expect(digestDue(prefs, null, NOW)).toBe(true));
  it('is not due 239 minutes after the last digest at cadence 240', () => {
    const p = { ...prefs, digestCadenceMinutes: 240 };
    expect(digestDue(p, new Date(NOW.getTime() - 239 * MIN), NOW)).toBe(false);
  });
  it('is due exactly at the cadence', () => {
    const p = { ...prefs, digestCadenceMinutes: 240 };
    expect(digestDue(p, new Date(NOW.getTime() - 240 * MIN), NOW)).toBe(true);
  });
});

describe('buildDigestText', () => {
  it('uses the singular title for one concern', () => {
    expect(buildDigestText([{ id: 'a', summary: 's', severity: 'low' }]).title).toBe('Wisp: 1 concern waiting');
  });
  it('lists at most 3 summaries, highest severity first', () => {
    const cs = (['info', 'low', 'high', 'medium', 'high'] as const).map((severity, i) => ({ id: `c${i}`, summary: `${severity}-${i}`, severity }));
    const { title, body } = buildDigestText(cs);
    expect(title).toBe('Wisp: 5 concerns waiting');
    const parts = body.split(' · ');
    expect(parts).toHaveLength(3);
    expect(parts).toEqual(['high-2', 'high-4', 'medium-3']);
  });
  it('cuts a 90-char summary to 40 code points ending in an ellipsis', () => {
    const { body } = buildDigestText([{ id: 'a', summary: '😀'.repeat(90), severity: 'low' }]);
    const cps = [...body];
    expect(cps).toHaveLength(40);
    expect(cps[39]).toBe('…');
  });
});

describe('selectDigestCandidates', () => {
  it('groups rows by grant and keeps grants with at least two concerns', async () => {
    h.results.push([row('g1', 'c1'), row('g1', 'c2'), row('g2', 'c3')]);
    const out = await selectDigestCandidates(NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ grantId: 'g1', threadId: 't-g1', userId: 'u-g1', partnerId: 'p1', currentRevisionId: 'r-g1' });
    expect(out[0]!.concerns.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(h.db.select).toHaveBeenCalledTimes(1);
  });
});

describe('runNudgeDigest', () => {
  const two = (g: string, a: string, b: string) => [row(g, a), row(g, b)];

  it('returns zeros without selecting while Wisp is off', async () => {
    h.enabled = false;
    expect(await runNudgeDigest(NOW)).toEqual({ candidates: 0, sent: 0, suppressed: 0 });
    expect(h.db.select).not.toHaveBeenCalled();
  });

  it('sends only to the due candidate and stamps only the delivered one', async () => {
    h.results.push([...two('g1', 'c1', 'c2'), ...two('g2', 'c3', 'c4')]);
    h.loadNudgeBookkeeping.mockImplementation(async () => new Map([
      ['u-g2', { prefs, lastDigestAt: new Date(NOW.getTime() - 5 * MIN), lastBriefAt: null }],
    ]));
    const r = await runNudgeDigest(NOW);
    expect(r).toEqual({ candidates: 2, sent: 1, suppressed: 0 });
    expect(h.loadNudgeBookkeeping).toHaveBeenCalledTimes(1);
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
    expect(h.notifyUser.mock.calls[0]![0]).toMatchObject({
      userId: 'u-g1', category: 'wisp_nudge', kind: 'digest', concernId: null,
      threadId: 't-g1', grantId: 'g1', deepLink: 'breeze://wisp/thread/t-g1', title: 'Wisp: 2 concerns waiting',
    });
    expect(h.markDigestSent).toHaveBeenCalledTimes(1);
    expect(h.markDigestSent).toHaveBeenCalledWith('u-g1', 'p1', NOW);
  });

  it('counts a suppressed result and does not stamp', async () => {
    h.results.push(two('g1', 'c1', 'c2'));
    h.notifyUser.mockImplementation(async () => ({ inApp: false, pushed: 0, suppressed: 'prefs' }));
    expect(await runNudgeDigest(NOW)).toEqual({ candidates: 1, sent: 0, suppressed: 1 });
    expect(h.markDigestSent).not.toHaveBeenCalled();
  });

  it('skips a candidate whose live ceiling no longer covers one of its two concerns', async () => {
    h.results.push(two('g1', 'c1', 'cX'));
    const r = await runNudgeDigest(NOW);
    expect(h.listConcernsForCeiling).toHaveBeenCalledWith({ grantId: 'g1' }, { status: ['open'] });
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith('g1', 'r-g1');
    expect(h.notifyUser).not.toHaveBeenCalled();
    expect(r).toEqual({ candidates: 1, sent: 0, suppressed: 0 });
  });

  it('skips an inactive grant quietly and captures a corrupt one', async () => {
    h.results.push([...two('g1', 'c1', 'c2'), ...two('g2', 'c3', 'c4'), ...two('g3', 'c1', 'c2')]);
    h.resolveGrantCeiling.mockImplementation(async (g: string) => {
      if (g === 'g1') throw new h.GrantInactiveError('paused');
      if (g === 'g2') throw new h.GrantInactiveError('corrupt');
      return { grantId: g };
    });
    const r = await runNudgeDigest(NOW);
    expect(r.sent).toBe(1);
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
  });

  it('a failing candidate does not stop the sweep', async () => {
    h.results.push([...two('g1', 'c1', 'c2'), ...two('g2', 'c3', 'c4')]);
    h.notifyUser.mockImplementationOnce(async () => { throw new Error('boom'); });
    const r = await runNudgeDigest(NOW);
    expect(r).toEqual({ candidates: 2, sent: 1, suppressed: 0 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});
