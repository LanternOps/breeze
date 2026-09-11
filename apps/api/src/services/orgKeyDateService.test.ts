import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (same pattern as contractService.test.ts):
// every builder method returns the same chain; a query resolves when awaited,
// yielding the next queued result in call order.
type QueuedQuery = { rows: unknown[] } | { error: unknown };
const results: QueuedQuery[] = [];
function queueResult(rows: unknown[]) { results.push({ rows }); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'innerJoin', 'leftJoin', 'execute'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const result = results.shift() ?? { rows: [] };
      return 'error' in result ? reject(result.error) : resolve(result.rows);
    };
    return chain;
  };
  return { db: makeChain() };
});

// serviceDeliverableService is authored concurrently (Task 8); the suite stays
// self-contained by supplying the error class shape it will export.
vi.mock('./serviceDeliverableService', () => ({
  DeliverableServiceError: class extends Error {
    status: number; code: string; details?: unknown;
    constructor(m: string, status: number, code: string, details?: unknown) {
      super(m); this.status = status; this.code = code; this.details = details;
    }
  },
}));

import * as svc from './orgKeyDateService';
import { db } from '../db';

type Spy = { mock: { calls: unknown[][] } };
type Chain = { select: Spy; insert: Spy; values: Spy; update: Spy; set: Spy; delete: Spy; where: Spy };
const chain = db as unknown as Chain;
const nthArg = (spy: Spy, call: number): unknown => spy.mock.calls[call]?.[0];

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

function todayISO(): string { return new Date().toISOString().slice(0, 10); }

/** Depth-first over a drizzle SQL tree collecting every bound Param value
 *  (Param.value is the literal handed to the driver; string arrays bound via
 *  notInArray arrive as nested Param nodes). Tables/columns are skipped so the
 *  walk never loops through the circular column→table references. */
function collectBoundValues(node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (node === null || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  const rec = node as Record<string, unknown>;
  if (rec.constructor?.name === 'Param') {
    const v = rec.value;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x);
    return out;
  }
  if (rec.constructor?.name === 'PgTable' || 'table' in rec) return out;
  for (const child of Array.isArray(node) ? node : Object.values(rec)) collectBoundValues(child, out, seen);
  return out;
}
function shiftISO(days: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}

describe('orgKeyDateService', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  describe('org access', () => {
    it('listKeyDates on a foreign org → 404 NOT_FOUND without touching the db', async () => {
      await expect(svc.listKeyDates('org-other', actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.select.mock.calls).toHaveLength(0);
    });

    it('createKeyDate on a foreign org → 404 without touching the db', async () => {
      await expect(
        svc.createKeyDate('org-other', { label: 'x', kind: 'other', date: '2027-01-01', recursAnnually: false, portalVisible: false }, actor)
      ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.select.mock.calls).toHaveLength(0);
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('updateKeyDate / deleteKeyDate on a foreign org → 404 without touching the db', async () => {
      await expect(svc.updateKeyDate('org-other', 'k1', { label: 'y' }, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      await expect(svc.deleteKeyDate('org-other', 'k1', actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.update.mock.calls).toHaveLength(0);
      expect(chain.delete.mock.calls).toHaveLength(0);
    });

    it('accessibleOrgIds === null (partner-wide) is allowed', async () => {
      queueResult([]); // key dates
      queueResult([]); // contracts
      await expect(svc.listKeyDates('org1', { ...actor, accessibleOrgIds: null })).resolves.toEqual([]);
    });
  });

  describe('listKeyDates', () => {
    const keyDate = {
      id: 'k1', orgId: 'org1', label: 'Cyber insurance', kind: 'insurance_renewal', date: shiftISO(60),
      recursAnnually: true, remindDaysBefore: 30, ownerUserId: 'u9', remindedForDate: null, reminderTicketId: null,
      portalVisible: false, notes: 'broker: Acme', createdAt: new Date(), updatedAt: new Date(),
    };

    it('unions key dates with contract ends and sorts by date asc', async () => {
      queueResult([keyDate]);
      // Contract rows come back already filtered by the SQL; the service only maps them.
      queueResult([
        { id: 'c-late', name: 'MSA late', endDate: shiftISO(90) },
        { id: 'c-early', name: 'MSA early', endDate: shiftISO(10) },
      ]);

      const out = await svc.listKeyDates('org1', actor);

      expect(out.map((r) => r.id)).toEqual(['c-early', 'k1', 'c-late']);
      expect(out[0]).toEqual({
        source: 'contract_end', id: 'c-early', label: 'MSA early', kind: 'contract_end', date: shiftISO(10),
        recursAnnually: false, remindDaysBefore: null, ownerUserId: null, portalVisible: true, notes: null, contractId: 'c-early',
      });
      expect(out[1]).toEqual({
        source: 'key_date', id: 'k1', label: 'Cyber insurance', kind: 'insurance_renewal', date: shiftISO(60),
        recursAnnually: true, remindDaysBefore: 30, ownerUserId: 'u9', portalVisible: false, notes: 'broker: Acme', contractId: null,
      });
      // Both reads are org-filtered.
      expect(chain.where.mock.calls).toHaveLength(2);
    });

    it('excludes draft/cancelled and past-end contracts (SQL predicate) and skips the contract read when includeContractEnds=false', async () => {
      queueResult([keyDate]);
      queueResult([
        { id: 'c-draft', name: 'Draft', endDate: shiftISO(5), status: 'draft' },
        { id: 'c-cancelled', name: 'Cancelled', endDate: shiftISO(5), status: 'cancelled' },
        { id: 'c-past', name: 'Past', endDate: shiftISO(-1), status: 'active' },
        { id: 'c-ok', name: 'Active', endDate: shiftISO(5), status: 'active' },
        { id: 'c-nodate', name: 'No end', endDate: null, status: 'active' },
      ]);
      const withEnds = await svc.listKeyDates('org1', actor, { includeContractEnds: true });
      expect(withEnds.filter((r) => r.source === 'contract_end').map((r) => r.id)).toEqual(['c-ok']);

      // The predicate itself: status NOT IN (draft, cancelled), end_date >= today, end_date IS NOT NULL.
      // Assert on the BOUND values only (a walk over the SQL chunk tree that
      // ignored Param nodes would also match the enum's declared values).
      const bound = collectBoundValues(nthArg(chain.where, 1));
      expect(bound).toContain('org1');
      expect(bound).toContain('draft');
      expect(bound).toContain('cancelled');
      expect(bound).toContain(todayISO());

      results.length = 0; vi.clearAllMocks();
      queueResult([keyDate]);
      const noEnds = await svc.listKeyDates('org1', actor, { includeContractEnds: false });
      expect(noEnds.map((r) => r.source)).toEqual(['key_date']);
      expect(chain.select.mock.calls).toHaveLength(1);
    });
  });

  describe('createKeyDate', () => {
    const input = {
      label: 'SOC 2 audit', kind: 'audit' as const, date: '2027-03-15', recursAnnually: true,
      remindDaysBefore: 45, ownerUserId: 'u-owner', portalVisible: true, notes: null,
    };

    it('inserts with orgId and the full payload, returning the row', async () => {
      queueResult([{ partnerId: 'p1' }]);          // organizations
      queueResult([{ id: 'u-owner' }]);            // users (same partner)
      queueResult([{ id: 'k-new', orgId: 'org1', ...input }]); // insert … returning

      const row = await svc.createKeyDate('org1', input, actor);
      expect(row.id).toBe('k-new');
      expect(nthArg(chain.values, 0)).toEqual({
        orgId: 'org1', label: 'SOC 2 audit', kind: 'audit', date: '2027-03-15', recursAnnually: true,
        remindDaysBefore: 45, ownerUserId: 'u-owner', portalVisible: true, notes: null,
      });
    });

    it('foreign-partner owner → 400 OWNER_NOT_ALLOWED and no insert', async () => {
      queueResult([{ partnerId: 'p1' }]); // organizations
      queueResult([]);                    // users: none matching (id, partnerId)
      await expect(svc.createKeyDate('org1', input, actor)).rejects.toMatchObject({ status: 400, code: 'OWNER_NOT_ALLOWED' });
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('missing org → 404 NOT_FOUND', async () => {
      queueResult([]); // organizations
      await expect(svc.createKeyDate('org1', input, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('null owner skips the owner lookup', async () => {
      queueResult([{ id: 'k-new', orgId: 'org1' }]); // insert … returning
      await svc.createKeyDate('org1', { ...input, ownerUserId: null }, actor);
      expect(chain.select.mock.calls).toHaveLength(0);
      expect(nthArg(chain.values, 0)).toMatchObject({ ownerUserId: null, orgId: 'org1' });
    });
  });

  describe('updateKeyDate', () => {
    it('missing id → 404 NOT_FOUND', async () => {
      queueResult([]); // update … returning
      await expect(svc.updateKeyDate('org1', 'k-missing', { label: 'x' }, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('applies the patch and stamps updatedAt', async () => {
      queueResult([{ id: 'k1', orgId: 'org1', label: 'renamed' }]);
      const row = await svc.updateKeyDate('org1', 'k1', { label: 'renamed', remindDaysBefore: null }, actor);
      expect(row.label).toBe('renamed');
      const set = nthArg(chain.set, 0) as Record<string, unknown>;
      expect(set).toMatchObject({ label: 'renamed', remindDaysBefore: null });
      expect(set.updatedAt).toBeInstanceOf(Date);
      expect(chain.where.mock.calls).toHaveLength(1);
    });

    it('validates a new owner against the org partner', async () => {
      queueResult([{ partnerId: 'p1' }]);
      queueResult([]); // no user in partner
      await expect(svc.updateKeyDate('org1', 'k1', { ownerUserId: 'u-foreign' }, actor)).rejects.toMatchObject({ status: 400, code: 'OWNER_NOT_ALLOWED' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });
  });

  describe('deleteKeyDate', () => {
    it('missing id → 404 NOT_FOUND', async () => {
      queueResult([]); // delete … returning
      await expect(svc.deleteKeyDate('org1', 'k-missing', actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('resolves void when the row existed', async () => {
      queueResult([{ id: 'k1' }]);
      await expect(svc.deleteKeyDate('org1', 'k1', actor)).resolves.toBeUndefined();
      expect(chain.delete.mock.calls).toHaveLength(1);
      expect(chain.where.mock.calls).toHaveLength(1);
    });
  });
});
