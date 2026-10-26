import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...args: unknown[]) => coreRequest(...args) }));

import {
  dismissWispConcern,
  getWispActivity,
  getWispHome,
  getWispThread,
  listWispConcerns,
  normalizeConcern,
  pauseWispGrant,
  resumeWispGrant,
  sendWispConcernFeedback,
  snoozeWispConcern,
} from './wisp';

beforeEach(() => {
  coreRequest.mockReset();
});

const POST_JSON = { 'Content-Type': 'application/json' };

describe('normalizeConcern', () => {
  it('returns null without a string id and summary', () => {
    expect(normalizeConcern({ id: 'c1' })).toBeNull();
    expect(normalizeConcern({ summary: 's' })).toBeNull();
    expect(normalizeConcern({ id: '', summary: 's' })).toBeNull();
    expect(normalizeConcern(null)).toBeNull();
    expect(normalizeConcern('x')).toBeNull();
  });

  it('defaults unknown severity/status and missing optional fields', () => {
    expect(
      normalizeConcern({
        id: 'c1', summary: 's', severity: 'weird', status: 'odd', orgId: 'o1',
        subject: { kind: 'ticket', id: 't' },
      })
    ).toMatchObject({
      id: 'c1', orgId: 'o1', status: 'open', severity: 'info', approvalIntentId: null,
      recipient: null, snoozedUntil: null, updatedAt: '', subject: { kind: 'ticket', id: 't' },
    });
  });

  it('falls back to an unknown subject and null orgId', () => {
    const c = normalizeConcern({ id: 'c1', summary: 's', orgId: 5, subject: { kind: 1 } });
    expect(c?.subject).toEqual({ kind: 'unknown', id: '' });
    expect(c?.orgId).toBeNull();
  });

  it('lifts recipient.snoozedUntil and carries nudgeCount/feedback', () => {
    const c = normalizeConcern({
      id: 'c1', summary: 's', status: 'snoozed', severity: 'high', snoozedUntil: 'top',
      recipient: { nudgeCount: 3, snoozedUntil: '2026-10-20T09:00:00.000Z', feedback: 'useful' },
    });
    expect(c?.snoozedUntil).toBe('2026-10-20T09:00:00.000Z');
    expect(c?.recipient).toEqual({
      nudgeCount: 3, snoozedUntil: '2026-10-20T09:00:00.000Z', feedback: 'useful',
    });
  });

  it('uses top-level snoozedUntil when no recipient value, and sanitises recipient fields', () => {
    const c = normalizeConcern({
      id: 'c1', summary: 's', snoozedUntil: 'top',
      recipient: { nudgeCount: -1, feedback: 'bogus' },
    });
    expect(c?.snoozedUntil).toBe('top');
    expect(c?.recipient).toEqual({ nudgeCount: 0, snoozedUntil: null, feedback: null });
  });
});

describe('listWispConcerns', () => {
  it('asks with the exact URL, normalises and drops bad rows', async () => {
    coreRequest.mockResolvedValue({ concerns: [{ id: 'c1', summary: 's' }, { id: 'bad' }, null] });
    const out = await listWispConcerns('g1');
    expect(coreRequest).toHaveBeenCalledWith(
      '/wisp/concerns?grantId=g1&status=open,snoozed,resolved,dismissed'
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('c1');
  });

  it('throws on a non-array body so the screen shows its load error instead of an empty, healthy list', async () => {
    coreRequest.mockResolvedValue({ concerns: 'nope' });
    await expect(listWispConcerns('g1')).rejects.toThrow(/malformed/);
    coreRequest.mockResolvedValue(undefined);
    await expect(listWispConcerns('g1')).rejects.toThrow(/malformed/);
  });

  it('an empty array is a healthy empty list', async () => {
    coreRequest.mockResolvedValue({ concerns: [] });
    await expect(listWispConcerns('g1')).resolves.toEqual([]);
  });
});

describe('getWispThread', () => {
  it('unwraps { data: { thread, grant } } and nulls missing spend fields', async () => {
    coreRequest.mockResolvedValue({
      data: {
        thread: { id: 't/1', grantId: 'g1', summary: 'sum', summaryUpdatedAt: null },
        grant: { id: 'g1', status: 'active', orgId: null, expiresAt: '2026-11-01T00:00:00Z' },
      },
    });
    const t = await getWispThread('t/1');
    expect(coreRequest).toHaveBeenCalledWith('/wisp/thread/t%2F1');
    expect(t).toEqual({
      id: 't/1', grantId: 'g1', summary: 'sum', summaryUpdatedAt: null,
      grant: {
        id: 'g1', status: 'active', orgId: null, expiresAt: '2026-11-01T00:00:00Z',
        pausedReason: null, budgetCentsPerDay: null, spentTodayCents: null, budgetResetsAt: null,
      },
    });
  });

  it('carries spend fields and fails closed on an unknown grant status', async () => {
    coreRequest.mockResolvedValue({
      data: {
        thread: { id: 't1', grantId: 'g1', summary: 's', summaryUpdatedAt: 'x' },
        grant: {
          id: 'g1', status: 'mystery', orgId: 'o1', expiresAt: 'e', pausedReason: 'budget',
          budgetCentsPerDay: 500, spentTodayCents: 120, budgetResetsAt: 'r',
        },
      },
    });
    const t = await getWispThread('t1');
    expect(t.grant.status).toBe('expired');
    expect(t.grant).toMatchObject({
      budgetCentsPerDay: 500, spentTodayCents: 120, budgetResetsAt: 'r', pausedReason: 'budget',
    });
  });

  it('throws on a payload without data.grant or data.thread', async () => {
    coreRequest.mockResolvedValue({ data: { thread: { id: 't1' } } });
    await expect(getWispThread('t1')).rejects.toThrow('wisp thread payload malformed');
    coreRequest.mockResolvedValue({ data: { grant: { id: 'g' } } });
    await expect(getWispThread('t1')).rejects.toThrow('wisp thread payload malformed');
  });
});

describe('concern actions', () => {
  it('snooze POSTs grantId + until', async () => {
    coreRequest.mockResolvedValue({});
    await snoozeWispConcern('c1', 'g1', '2026-10-20T09:00:00.000Z');
    expect(coreRequest).toHaveBeenCalledWith('/wisp/concerns/c1/snooze', {
      method: 'POST', headers: POST_JSON,
      body: JSON.stringify({ grantId: 'g1', until: '2026-10-20T09:00:00.000Z' }),
    });
  });

  it('dismiss POSTs grantId', async () => {
    coreRequest.mockResolvedValue({});
    await dismissWispConcern('c1', 'g1');
    expect(coreRequest).toHaveBeenCalledWith('/wisp/concerns/c1/dismiss', {
      method: 'POST', headers: POST_JSON, body: JSON.stringify({ grantId: 'g1' }),
    });
  });

  it('feedback omits note when absent/empty and returns the normalised recipient', async () => {
    coreRequest.mockResolvedValue({
      data: { recipient: { nudgeCount: 1, snoozedUntil: null, feedback: 'not_useful' } },
    });
    const r = await sendWispConcernFeedback('c1', 'g1', { useful: false });
    expect(coreRequest).toHaveBeenCalledWith('/wisp/concerns/c1/feedback', {
      method: 'POST', headers: POST_JSON, body: JSON.stringify({ grantId: 'g1', useful: false }),
    });
    expect(r).toEqual({ nudgeCount: 1, snoozedUntil: null, feedback: 'not_useful' });

    await sendWispConcernFeedback('c1', 'g1', { useful: true, note: '' });
    expect(JSON.parse(coreRequest.mock.calls[1][1].body)).toEqual({ grantId: 'g1', useful: true });

    await sendWispConcernFeedback('c1', 'g1', { useful: true, note: 'nice' });
    expect(JSON.parse(coreRequest.mock.calls[2][1].body)).toEqual({
      grantId: 'g1', useful: true, note: 'nice',
    });
  });

  it('feedback returns null when the server sends no recipient', async () => {
    coreRequest.mockResolvedValue({ data: {} });
    await expect(sendWispConcernFeedback('c1', 'g1', { useful: true })).resolves.toBeNull();
  });
});

describe('getWispActivity', () => {
  it('defaults limit to 20, encodes the cursor, normalises items, current null when absent', async () => {
    coreRequest.mockResolvedValue({
      data: {
        items: [
          { at: 'a', kind: 'brief', orgId: null, title: 'Brief', detail: null, href: null, costCents: null },
          { at: 'b', kind: 'nope', title: 'x' },
          { kind: 'brief', title: 'no at' },
          { at: 'c', kind: 'nudge', title: 'N', orgId: 'o1', detail: 'd', href: '/h', costCents: 3 },
        ],
        nextCursor: 'n/1',
      },
    });
    const page = await getWispActivity('t1');
    expect(coreRequest).toHaveBeenCalledWith('/wisp/thread/t1/activity?limit=20');
    expect(page.items.map((i) => i.title)).toEqual(['Brief', 'N']);
    expect(page.items[1]).toEqual({
      at: 'c', kind: 'nudge', orgId: 'o1', title: 'N', detail: 'd', href: '/h', costCents: 3,
    });
    expect(page.nextCursor).toBe('n/1');
    expect(page.current).toBeNull();

    await getWispActivity('t1', { limit: 5, cursor: 'a b/c' });
    expect(coreRequest).toHaveBeenLastCalledWith(
      '/wisp/thread/t1/activity?limit=5&cursor=a%20b%2Fc'
    );
  });

  it('parses current and drops it without a startedAt', async () => {
    coreRequest.mockResolvedValue({
      data: { items: [], nextCursor: null, current: { orgId: 'o1', orgName: 'Acme', startedAt: 's' } },
    });
    expect((await getWispActivity('t1')).current).toEqual({
      orgId: 'o1', orgName: 'Acme', startedAt: 's',
    });
    coreRequest.mockResolvedValue({ data: { items: [], current: { orgId: 'o1' } } });
    expect((await getWispActivity('t1')).current).toBeNull();
  });
});

describe('grant pause/resume', () => {
  it('pause POSTs without a body and returns status + pausedReason from the top-level DTO', async () => {
    coreRequest.mockResolvedValue({ id: 'g1', status: 'paused', pausedReason: 'user' });
    await expect(pauseWispGrant('g1')).resolves.toEqual({ status: 'paused', pausedReason: 'user' });
    expect(coreRequest).toHaveBeenCalledWith('/wisp/grants/g1/pause', { method: 'POST' });
  });

  it('resume POSTs and fails closed on an unknown status', async () => {
    coreRequest.mockResolvedValue({ id: 'g1', status: 'active', pausedReason: null });
    await expect(resumeWispGrant('g1')).resolves.toEqual({ status: 'active', pausedReason: null });
    expect(coreRequest).toHaveBeenCalledWith('/wisp/grants/g1/resume', { method: 'POST' });
    coreRequest.mockResolvedValue({ id: 'g1', status: '???' });
    await expect(resumeWispGrant('g1')).resolves.toEqual({ status: 'expired', pausedReason: null });
  });
});

describe('getWispHome (W08)', () => {
  it('GETs /wisp/home for the grant and unwraps a { data } envelope', async () => {
    coreRequest.mockResolvedValue({ data: { brief: null, links: [] } });
    await expect(getWispHome('g 1')).resolves.toEqual({ brief: null, links: [] });
    expect(coreRequest).toHaveBeenCalledWith('/wisp/home?grantId=g%201');
  });

  it('accepts an unwrapped body', async () => {
    coreRequest.mockResolvedValue({ brief: null, links: [] });
    await expect(getWispHome('g1')).resolves.toEqual({ brief: null, links: [] });
  });

  it('throws on a non-object body so the screen hides the sections instead of drawing an empty home', async () => {
    coreRequest.mockResolvedValue(null);
    await expect(getWispHome('g1')).rejects.toThrow(/malformed/);
    // A `data` envelope whose payload is not a record is drift, not an empty home.
    coreRequest.mockResolvedValue({ data: null });
    await expect(getWispHome('g1')).rejects.toThrow(/malformed/);
    coreRequest.mockResolvedValue({ data: [] });
    await expect(getWispHome('g1')).rejects.toThrow(/malformed/);
    coreRequest.mockResolvedValue([]);
    await expect(getWispHome('g1')).rejects.toThrow(/malformed/);
  });
});
