import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * services/wisp/partnerNudgeSettings.ts — the partner's urgent-capable
 * severities. The write is partner-wide state, so the service itself refuses a
 * caller without canManagePartnerWidePolicies (epic #2135) before touching the
 * database, whatever the route did.
 */
const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const inserts: Array<{ table: unknown; values: unknown; conflict?: { target: unknown; set: Record<string, unknown> } }> = [];
  const selectChain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit']) p[m] = vi.fn(() => p);
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
  return { results, inserts, db: { select: vi.fn(() => selectChain()), insert: vi.fn((t: unknown) => insertChain(t)) } };
});

vi.mock('../../db', () => ({ db: h.db }));

import { wispPartnerNudgeSettings } from '../../db/schema/wispNudgePreferences';
import { PartnerWideWriteDeniedError } from '../partnerWideAccess';
import { loadUrgentCapableSeverities, upsertUrgentCapableSeverities } from './partnerNudgeSettings';

const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '11111111-1111-4111-8111-111111111111';
const auth = (partnerOrgAccess: 'all' | 'selected') =>
  ({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess, user: { id: USER } }) as never;

beforeEach(() => {
  h.results.length = 0;
  h.inserts.length = 0;
  vi.clearAllMocks();
});

describe('loadUrgentCapableSeverities', () => {
  it('a missing row is none; stored garbage is dropped', async () => {
    await expect(loadUrgentCapableSeverities(PARTNER)).resolves.toEqual([]);
    h.results.push([{ urgentCapableSeverities: ['high', 'critical', 'medium'] }]);
    await expect(loadUrgentCapableSeverities(PARTNER)).resolves.toEqual(['high', 'medium']);
  });
});

describe('upsertUrgentCapableSeverities', () => {
  it('a partner user WITHOUT full partner org access is refused before any write', async () => {
    await expect(upsertUrgentCapableSeverities(auth('selected'), ['high'])).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(h.db.insert).not.toHaveBeenCalled();
  });

  it('a partner admin upserts on its own partner_id, de-duplicated, recording who changed it', async () => {
    h.results.push([{ urgentCapableSeverities: ['high'] }]);
    await expect(upsertUrgentCapableSeverities(auth('all'), ['high', 'high'])).resolves.toEqual(['high']);
    const [ins] = h.inserts;
    expect(ins!.table).toBe(wispPartnerNudgeSettings);
    expect(ins!.values).toMatchObject({ partnerId: PARTNER, urgentCapableSeverities: ['high'], updatedByUserId: USER });
    expect(ins!.conflict!.target).toBe(wispPartnerNudgeSettings.partnerId);
  });
});
