import { describe, it, expect, vi, beforeEach } from 'vitest';

// Direct unit tests for filterAlertsBySiteScope — the site-axis (sub-org) fail-safe
// that GET /alerts, the bulk endpoint, and correlation grouping all rely on. The
// security-critical branch is fail-CLOSED for a missing device: a row whose
// deviceId no longer resolves to a devices row is DROPPED for a site-restricted
// caller (it must not leak through as if it were org-wide). Uses the REAL
// siteAccessCheck from middleware/auth so this never drifts from a stale inline
// copy; the db device lookup is mocked the way the route tests mock it.

const { state, tables, dbMock } = vi.hoisted(() => {
  const tables = {
    devices: { id: 'devices.id', siteId: 'devices.siteId', orgId: 'devices.orgId' },
    tickets: { id: 'tickets.id', deviceId: 'tickets.deviceId' },
  };

  type Predicate = { op: string; col?: unknown; val?: unknown; vals?: unknown[]; args?: Predicate[] } | undefined;
  const columnKey = (col: unknown) => String(col).split('.').pop()!;
  const evalPredicate = (row: Record<string, unknown>, predicate: Predicate): boolean => {
    if (!predicate) return true;
    if (predicate.op === 'eq') return row[columnKey(predicate.col)] === predicate.val;
    if (predicate.op === 'inArray') return (predicate.vals ?? []).includes(row[columnKey(predicate.col)]);
    if (predicate.op === 'and') return (predicate.args ?? []).every((arg) => evalPredicate(row, arg));
    if (predicate.op === 'or') return (predicate.args ?? []).some((arg) => evalPredicate(row, arg));
    return true;
  };

  const state = { devices: [] as Array<Record<string, any>> };

  class SelectQuery {
    private predicate: Predicate;
    constructor(private projection?: Record<string, unknown>) {}
    where(predicate: Predicate) { this.predicate = predicate; return this; }
    then(resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) {
      return Promise.resolve(this.rows()).then(resolve, reject);
    }
    private rows() {
      const filtered = state.devices.filter((row) => evalPredicate(row, this.predicate));
      if (!this.projection) return filtered;
      return filtered.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(this.projection!)) out[key] = row[columnKey(this.projection![key])];
        return out;
      });
    }
  }

  const dbMock = {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: () => new SelectQuery(projection),
    })),
  };

  return { state, tables, dbMock };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
}));

vi.mock('../../db', () => ({ db: dbMock }));
vi.mock('../../db/schema', () => ({ devices: tables.devices, tickets: tables.tickets }));

// Pull the REAL siteAccessCheck so the predicate the helper applies can't drift.
vi.mock('../../middleware/auth', async () => ({
  siteAccessCheck: (await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth')).siteAccessCheck,
}));

import { filterAlertsBySiteScope } from './siteScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE_A = '5a5a5a5a-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = '5b5b5b5b-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE_A = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_B = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd';
const MISSING_DEVICE = 'deadbeef-0000-4000-8000-000000000000';

type AlertRow = { id: string; deviceId: string | null };

describe('filterAlertsBySiteScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.devices = [
      { id: DEVICE_A, siteId: SITE_A, orgId: ORG },
      { id: DEVICE_B, siteId: SITE_B, orgId: ORG },
    ];
  });

  it('DROPS a row whose device no longer exists for a site-restricted caller (fail-closed)', async () => {
    const rows: AlertRow[] = [{ id: 'alert-missing', deviceId: MISSING_DEVICE }];
    const out = await filterAlertsBySiteScope({ allowedSiteIds: [SITE_A], orgId: ORG }, rows);
    expect(out).toEqual([]);
  });

  it('KEEPS a deviceless (org-wide) alert for a site-restricted caller', async () => {
    const rows: AlertRow[] = [{ id: 'alert-orgwide', deviceId: null }];
    const out = await filterAlertsBySiteScope({ allowedSiteIds: [SITE_A], orgId: ORG }, rows);
    expect(out.map((r) => r.id)).toEqual(['alert-orgwide']);
  });

  it('KEEPS in-site device alerts and DROPS out-of-site ones for a site-restricted caller', async () => {
    const rows: AlertRow[] = [
      { id: 'alert-a', deviceId: DEVICE_A },
      { id: 'alert-b', deviceId: DEVICE_B },
    ];
    const out = await filterAlertsBySiteScope({ allowedSiteIds: [SITE_A], orgId: ORG }, rows);
    expect(out.map((r) => r.id)).toEqual(['alert-a']);
  });

  it('passes every row through unchanged for an unrestricted caller (allowedSiteIds undefined)', async () => {
    const rows: AlertRow[] = [
      { id: 'alert-a', deviceId: DEVICE_A },
      { id: 'alert-b', deviceId: DEVICE_B },
      { id: 'alert-orgwide', deviceId: null },
      { id: 'alert-missing', deviceId: MISSING_DEVICE },
    ];
    const out = await filterAlertsBySiteScope({ allowedSiteIds: undefined, orgId: ORG }, rows);
    expect(out).toBe(rows);
    // Unrestricted callers skip the device lookup entirely.
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('an empty allowlist keeps deviceless alerts but drops all device-bound ones', async () => {
    const rows: AlertRow[] = [
      { id: 'alert-a', deviceId: DEVICE_A },
      { id: 'alert-orgwide', deviceId: null },
    ];
    const out = await filterAlertsBySiteScope({ allowedSiteIds: [], orgId: ORG }, rows);
    expect(out.map((r) => r.id)).toEqual(['alert-orgwide']);
  });

  it('scopes the device lookup to auth.orgId (belt-and-suspenders) so a cross-org device never matches', async () => {
    // Same device id, but it belongs to a different org than the caller — must not
    // resolve to an in-site match even if its siteId is in the allowlist.
    state.devices = [{ id: DEVICE_A, siteId: SITE_A, orgId: 'other-org' }];
    const rows: AlertRow[] = [{ id: 'alert-a', deviceId: DEVICE_A }];
    const out = await filterAlertsBySiteScope({ allowedSiteIds: [SITE_A], orgId: ORG }, rows);
    expect(out).toEqual([]);
  });
});
