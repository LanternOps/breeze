import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WISP_NUDGE_PREFERENCE_DEFAULTS } from '@breeze/shared';

/**
 * services/wisp/nudgePreferences.ts — thin reads/upserts over
 * wisp_nudge_preferences / wisp_partner_nudge_settings. `db` is a chain fake:
 * each awaited select / insert…returning resolves the next queued result, and
 * every insert's values + conflict config are recorded. The real-DB proof
 * (RLS, CHECKs, upsert) is wispNudgePreferencesRls / wispNotifyUser
 * integration tests.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const inserts: Array<{ table: unknown; values: unknown; conflict?: { target: unknown; set: Record<string, unknown> } }> = [];
  const selectChain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'orderBy']) p[m] = vi.fn(() => p);
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  const insertChain = (table: unknown): Record<string, unknown> => {
    const rec: (typeof inserts)[number] = { table, values: undefined };
    inserts.push(rec);
    const p: Record<string, unknown> = {};
    p.values = vi.fn((v: unknown) => { rec.values = v; return p; });
    p.onConflictDoUpdate = vi.fn((c: { target: unknown; set: Record<string, unknown> }) => { rec.conflict = c; return p; });
    p.returning = vi.fn(() => p);
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(res, rej);
    return p;
  };
  return {
    results,
    inserts,
    db: { select: vi.fn(() => selectChain()), insert: vi.fn((t: unknown) => insertChain(t)) },
    inSystemContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../../db', () => ({ db: h.db }));
vi.mock('./grantAuthority', () => ({ inSystemContext: h.inSystemContext }));

import { wispNudgePreferences } from '../../db/schema/wispNudgePreferences';
import {
  loadNudgeBookkeeping,
  loadNudgePrefs,
  markBriefSent,
  markDigestSent,
  upsertNudgePrefs,
} from './nudgePreferences';

const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '11111111-1111-4111-8111-111111111111';

const storedRow = (o: Record<string, unknown> = {}) => ({
  userId: USER, partnerId: PARTNER, channels: { inApp: true, push: false }, quietOverride: 'urgent_only',
  digestCadenceMinutes: 60, lastDigestAt: null, briefTimeLocal: '07:00', briefTimezone: 'Europe/Berlin',
  lastBriefAt: null, proactivity: 'chatty', ...o,
});

beforeEach(() => {
  h.results.length = 0;
  h.inserts.length = 0;
  vi.clearAllMocks();
});

describe('loadNudgePrefs', () => {
  it('a missing row is the defaults and writes nothing', async () => {
    await expect(loadNudgePrefs(USER)).resolves.toEqual(WISP_NUDGE_PREFERENCE_DEFAULTS);
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it('a stored row resolves through resolveWispNudgePrefs', async () => {
    h.results.push([storedRow()]);
    await expect(loadNudgePrefs(USER)).resolves.toEqual({
      channels: { inApp: true, push: false }, quietOverride: 'urgent_only', digestCadenceMinutes: 60,
      briefTimeLocal: '07:00', briefTimezone: 'Europe/Berlin', proactivity: 'chatty',
    });
  });
});

describe('upsertNudgePrefs', () => {
  it('upserts on user_id with the auth-supplied ids and only the patched fields in the update set', async () => {
    h.results.push([storedRow({ quietOverride: 'never' })]);
    const out = await upsertNudgePrefs(USER, PARTNER, { quietOverride: 'never' });
    expect(out.quietOverride).toBe('never');
    const [ins] = h.inserts;
    expect(ins!.table).toBe(wispNudgePreferences);
    expect(ins!.values).toMatchObject({ userId: USER, partnerId: PARTNER, quietOverride: 'never' });
    expect(ins!.conflict!.target).toBe(wispNudgePreferences.userId);
    expect(Object.keys(ins!.conflict!.set).sort()).toEqual(['quietOverride', 'updatedAt']);
  });

  it('a null brief time (brief off) is written as null, not dropped', async () => {
    h.results.push([storedRow({ briefTimeLocal: null })]);
    const out = await upsertNudgePrefs(USER, PARTNER, { briefTimeLocal: null });
    expect(out.briefTimeLocal).toBeNull();
    expect(h.inserts[0]!.conflict!.set).toHaveProperty('briefTimeLocal', null);
  });
});

describe('bookkeeping (workers)', () => {
  it('markDigestSent / markBriefSent upsert the stamp in system context', async () => {
    const at = new Date('2026-10-24T08:00:00Z');
    await markDigestSent(USER, PARTNER, at);
    await markBriefSent(USER, PARTNER, at);
    expect(h.inSystemContext).toHaveBeenCalledTimes(2);
    expect(h.inserts[0]!.values).toMatchObject({ userId: USER, partnerId: PARTNER, lastDigestAt: at });
    expect(h.inserts[0]!.conflict!.set).toMatchObject({ lastDigestAt: at });
    expect(h.inserts[1]!.values).toMatchObject({ userId: USER, partnerId: PARTNER, lastBriefAt: at });
    expect(h.inserts[1]!.conflict!.set).toMatchObject({ lastBriefAt: at });
  });

  it('loadNudgeBookkeeping maps stored rows; no ids → no query', async () => {
    await expect(loadNudgeBookkeeping([])).resolves.toEqual(new Map());
    expect(h.db.select).not.toHaveBeenCalled();
    const last = new Date('2026-10-23T08:00:00Z');
    h.results.push([storedRow({ lastBriefAt: last })]);
    const m = await loadNudgeBookkeeping([USER]);
    expect(m.get(USER)).toEqual(expect.objectContaining({ lastBriefAt: last, lastDigestAt: null, prefs: expect.objectContaining({ proactivity: 'chatty' }) }));
  });
});
