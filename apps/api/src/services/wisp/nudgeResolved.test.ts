/**
 * #11427 — services/wisp/nudgeResolved.ts: when a concern Wisp nudged someone
 * about is resolved, each nudged thread gets ONE `nudge_resolved` follow-up via
 * notifyUser. Drizzle is a FIFO select fake (concern row, then nudge-thread
 * rows); the ceiling, the concern visibility read and notifyUser are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy']) p[m] = vi.fn(() => p);
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  class GrantInactiveError extends Error {
    constructor(public readonly grantId: string, public readonly status: string, detail?: string, public readonly kind: string = 'inactive') {
      super(detail ?? 'inactive');
    }
  }
  return {
    results,
    db: { select: vi.fn(() => chain()) },
    wispEnabled: vi.fn(() => true),
    resolveGrantCeiling: vi.fn(),
    getConcernForCeiling: vi.fn(),
    notifyUser: vi.fn(),
    captureException: vi.fn(),
    GrantInactiveError,
  };
});

vi.mock('../../db', () => ({ db: h.db }));
vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled }));
vi.mock('./grantAuthority', () => ({
  inSystemContext: (fn: () => Promise<unknown>) => fn(),
  resolveGrantCeiling: h.resolveGrantCeiling,
  GrantInactiveError: h.GrantInactiveError,
}));
vi.mock('./concerns', () => ({ getConcernForCeiling: h.getConcernForCeiling }));
vi.mock('./notifyUser', () => ({ notifyUser: h.notifyUser }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));

import { buildNudgeResolvedText, notifyNudgeResolved } from './nudgeResolved';

const C1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const concernRow = {
  id: C1, partnerId: 'p1', orgId: 'o1', status: 'resolved', resolvedByUserId: null,
  summary: 'SAM23 has a pending reboot', outcome: 'The pending-reboot alert resolved at 12:10Z, so the device restarted. Nothing else changed.',
};
const thread = (o: Record<string, unknown> = {}) => ({
  threadId: 't1', grantId: 'g1', grantorUserId: 'u1', currentRevisionId: 'r1', dismissedAt: null, ...o,
});
const queue = (...rows: unknown[][]) => { h.results.push(...rows); };

beforeEach(() => {
  h.results.length = 0;
  vi.clearAllMocks();
  h.wispEnabled.mockReturnValue(true);
  h.resolveGrantCeiling.mockImplementation(async (grantId: string) => ({ grantId }));
  h.getConcernForCeiling.mockResolvedValue({ id: C1 });
  h.notifyUser.mockResolvedValue({ inApp: true, pushed: 0, suppressed: null });
});

describe('buildNudgeResolvedText', () => {
  it('"<subject> — <outcome in one sentence>; no action needed."', () => {
    expect(buildNudgeResolvedText(concernRow)).toEqual({
      title: 'Resolved: SAM23 has a pending reboot',
      body: 'SAM23 has a pending reboot — the pending-reboot alert resolved at 12:10Z, so the device restarted; no action needed.',
    });
  });

  it('turns machine outcomes into words', () => {
    expect(buildNudgeResolvedText({ summary: 'X', outcome: 'alert_resolved' }).body).toBe('X — the alert behind it resolved; no action needed.');
    expect(buildNudgeResolvedText({ summary: 'X', outcome: 'subject_gone' }).body).toBe('X — what it was about no longer exists; no action needed.');
    expect(buildNudgeResolvedText({ summary: 'X', outcome: 'some_new_code' }).body).toBe('X — some new code; no action needed.');
  });

  it('keeps an acronym capitalised, single-lines the outcome and clips a long summary', () => {
    expect(buildNudgeResolvedText({ summary: 'X', outcome: 'SSD replaced\nby the tech' }).body).toBe('X — SSD replaced by the tech; no action needed.');
    const long = 'a'.repeat(200);
    const { title, body } = buildNudgeResolvedText({ summary: long, outcome: 'fixed' });
    expect([...title].length).toBeLessThanOrEqual('Resolved: '.length + 80);
    expect(body.startsWith(`${'a'.repeat(79)}…`)).toBe(true);
  });

  it('an empty outcome still reads as a sentence', () => {
    expect(buildNudgeResolvedText({ summary: 'X', outcome: null }).body).toBe('X — it was resolved; no action needed.');
  });
});

describe('notifyNudgeResolved', () => {
  it('sends one nudge_resolved to the grantor of the nudged thread, through notifyUser', async () => {
    queue([concernRow], [thread()]);
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 1, sent: 1 });
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith('g1', 'r1');
    expect(h.getConcernForCeiling).toHaveBeenCalledWith({ grantId: 'g1' }, C1);
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
    expect(h.notifyUser).toHaveBeenCalledWith({
      userId: 'u1', category: 'wisp_nudge', kind: 'nudge_resolved', concernId: C1, threadId: 't1', grantId: 'g1',
      deepLink: `breeze://wisp/thread/t1?concern=${C1}`,
      ...buildNudgeResolvedText(concernRow),
    });
  });

  it('a concern nobody was nudged about sends nothing', async () => {
    queue([concernRow], []);
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 0, sent: 0 });
    expect(h.notifyUser).not.toHaveBeenCalled();
  });

  it('one follow-up per thread even when the thread carried several nudges; one per thread across grants', async () => {
    queue([concernRow], [thread(), thread(), thread({ threadId: 't2', grantId: 'g2', grantorUserId: 'u2', currentRevisionId: 'r2' })]);
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 2, sent: 2 });
    expect(h.notifyUser.mock.calls.map(([p]) => [p.threadId, p.userId])).toEqual([['t1', 'u1'], ['t2', 'u2']]);
  });

  it('a missing or not-resolved concern sends nothing and reads no threads', async () => {
    queue([]);
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 0, sent: 0 });
    queue([{ ...concernRow, status: 'open' }]);
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 0, sent: 0 });
    expect(h.db.select).toHaveBeenCalledTimes(2);
    expect(h.notifyUser).not.toHaveBeenCalled();
  });

  it('skips the person who resolved it themselves and a recipient who dismissed it', async () => {
    queue([{ ...concernRow, resolvedByUserId: 'u1' }], [
      thread(),
      thread({ threadId: 't2', grantId: 'g2', grantorUserId: 'u2', dismissedAt: new Date() }),
      thread({ threadId: 't3', grantId: 'g3', grantorUserId: 'u3', currentRevisionId: 'r3' }),
    ]);
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 3, sent: 1 });
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
    expect(h.notifyUser).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't3', userId: 'u3' }));
  });

  it("re-checks the grant's live ceiling: an inactive grant or a concern it can no longer see gets nothing", async () => {
    queue([concernRow], [
      thread(),
      thread({ threadId: 't2', grantId: 'g2', grantorUserId: 'u2', currentRevisionId: 'r2' }),
      thread({ threadId: 't3', grantId: 'g3', grantorUserId: 'u3', currentRevisionId: null }),
    ]);
    h.resolveGrantCeiling.mockImplementation(async (grantId: string) => {
      if (grantId === 'g1') throw new h.GrantInactiveError('g1', 'paused');
      return { grantId };
    });
    h.getConcernForCeiling.mockResolvedValue(null);
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 3, sent: 0 });
    expect(h.notifyUser).not.toHaveBeenCalled();
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('one failing delivery is reported and never stops the next; nothing throws', async () => {
    queue([concernRow], [thread(), thread({ threadId: 't2', grantId: 'g2', grantorUserId: 'u2', currentRevisionId: 'r2' })]);
    h.notifyUser.mockRejectedValueOnce(new Error('db down'));
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 2, sent: 1 });
    expect(h.notifyUser).toHaveBeenCalledTimes(2);
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('a delivery that wrote nothing (dedupe hit, or the resolve is not committed yet) is not counted as sent', async () => {
    queue([concernRow], [thread()]);
    h.notifyUser.mockResolvedValue({ inApp: false, pushed: 0, suppressed: 'backoff' });
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 1, sent: 0 });
  });

  it('dark while Wisp is disabled', async () => {
    h.wispEnabled.mockReturnValue(false);
    await expect(notifyNudgeResolved(C1)).resolves.toEqual({ recipients: 0, sent: 0 });
    expect(h.db.select).not.toHaveBeenCalled();
  });
});
