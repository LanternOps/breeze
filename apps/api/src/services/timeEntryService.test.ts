import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inspect } from 'node:util';

const { dbMocks, emitMock, configMocks } = vi.hoisted(() => {
  const dbMocks = {
    // queue of results for successive db.select()...where()/limit() terminals
    selectResults: [] as unknown[][],
    insertResult: [] as unknown[],
    // Per-call insert results (shifted before falling back to insertResult) —
    // lets a test give the first timeEntries insert a conflict (empty array via
    // onConflictDoNothing) and the retry a success row.
    insertResultsQueue: [] as unknown[][],
    insertErrors: [] as unknown[],
    updateResult: [] as unknown[],
    insertedValues: [] as Record<string, unknown>[],
    updateSetArgs: [] as Record<string, unknown>[],
    whereArgs: [] as unknown[],
    onConflictDoNothingCalls: 0,
    forUpdateCalls: 0,
    deleteError: null as Error | null,
    deleteResult: [] as unknown[],
  };
  const configMocks = {
    getOrgBillingDefaults: vi.fn().mockResolvedValue(null),
  };
  return { dbMocks, emitMock: vi.fn(), configMocks };
});

vi.mock('./timeEntryEvents', () => ({ emitTimeEntryEvent: emitMock }));

vi.mock('./ticketConfigService', () => ({
  getOrgBillingDefaults: (...args: unknown[]) => configMocks.getOrgBillingDefaults(...args),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const chain: any = {
          leftJoin: vi.fn(() => chain),
          where: vi.fn((arg: unknown) => {
            dbMocks.whereArgs.push(arg);
            const result = dbMocks.selectResults.shift() ?? [];
            // `.for('update')` is valid after `.limit()` and directly after
            // `.where()`; it resolves the result already shifted above so one
            // queued row serves one locked select. forUpdateCalls counts locks.
            const lockable = () => ({
              then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
                Promise.resolve(result).then(res, rej),
              for: vi.fn(() => { dbMocks.forUpdateCalls += 1; return Promise.resolve(result); })
            });
            const terminal: any = {
              limit: vi.fn(() => lockable()),
              for: vi.fn(() => { dbMocks.forUpdateCalls += 1; return Promise.resolve(result); }),
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({ offset: vi.fn(() => Promise.resolve(result)) })),
                then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
                  Promise.resolve(result).then(res, rej)
              })),
              groupBy: vi.fn(() => ({
                orderBy: vi.fn(() => Promise.resolve(result))
              })),
              then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
                Promise.resolve(result).then(res, rej)
            };
            return terminal;
          })
        };
        return chain;
      })
    })),
    insert: vi.fn(() => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.insertedValues.push(vals);
        const returning = vi.fn(() => {
          const err = dbMocks.insertErrors.shift();
          if (err) return Promise.reject(err);
          const queued = dbMocks.insertResultsQueue.shift();
          return Promise.resolve(queued ?? dbMocks.insertResult);
        });
        return {
          returning,
          // startTimer suppresses the one-running-timer conflict at the
          // statement level (#2189): zero returned rows = lost the race.
          onConflictDoNothing: vi.fn(() => {
            dbMocks.onConflictDoNothingCalls += 1;
            return { returning };
          })
        };
      })
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.updateSetArgs.push(vals);
        return { where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(dbMocks.updateResult)) })) };
      })
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => {
        const terminal = dbMocks.deleteError
          ? Promise.reject(dbMocks.deleteError)
          : Promise.resolve();
        return Object.assign(terminal, {
          returning: vi.fn(() => dbMocks.deleteError
            ? Promise.reject(dbMocks.deleteError)
            : Promise.resolve(dbMocks.deleteResult)),
        });
      }),
    }))
  }
}));

vi.mock('../db/schema', () => ({
  timeEntries: {
    id: 'id', partnerId: 'partnerId', orgId: 'orgId', ticketId: 'ticketId',
    userId: 'userId', startedAt: 'startedAt', endedAt: 'endedAt',
    durationMinutes: 'durationMinutes', description: 'description',
    isBillable: 'isBillable', hourlyRate: 'hourlyRate', currencyCode: 'currencyCode', billingStatus: 'billingStatus',
    source: 'source',
    isApproved: 'isApproved', approvedBy: 'approvedBy', approvedAt: 'approvedAt',
    createdAt: 'createdAt', updatedAt: 'updatedAt'
  },
  ticketParts: {
    id: 'id', ticketId: 'ticketId', orgId: 'orgId', description: 'description',
    partNumber: 'partNumber', vendor: 'vendor', quantity: 'quantity', unitPrice: 'unitPrice', currencyCode: 'currencyCode',
    costBasis: 'costBasis', isBillable: 'isBillable', billingStatus: 'billingStatus',
    addedBy: 'addedBy', notes: 'notes', createdAt: 'createdAt', updatedAt: 'updatedAt'
  },
  tickets: { id: 'id', partnerId: 'partnerId', orgId: 'orgId', categoryId: 'categoryId', internalNumber: 'internalNumber', subject: 'subject' },
  ticketCategories: { id: 'id', partnerId: 'partnerId', defaultBillable: 'defaultBillable', defaultHourlyRate: 'defaultHourlyRate', rateCurrency: 'rateCurrency' },
  organizations: { id: 'id', partnerId: 'partnerId', name: 'name', currencyCode: 'currencyCode' },
  partners: { id: 'id', currencyCode: 'currencyCode' },
  users: { id: 'id', name: 'name' },
  ticketComments: {
    id: 'id', ticketId: 'ticketId', userId: 'userId', authorName: 'authorName',
    authorType: 'authorType', commentType: 'commentType', content: 'content',
    isPublic: 'isPublic', oldValue: 'oldValue', newValue: 'newValue', createdAt: 'createdAt'
  }
}));

import {
  computeDurationMinutes, createTimeEntry, startTimer, stopTimer,
  updateTimeEntry, deleteTimeEntry, approveTimeEntries, addTicketPart, updateTicketPart,
  getTimesheet, getTicketBillingSummary, listBillables, entryOrgAllowed, resolveDefaultRate,
  resolveAndLockOrgLink, readTimeEntryById
} from './timeEntryService';

describe('entryOrgAllowed (security review #1: time_entries org-axis allowlist)', () => {
  it('system scope (accessibleOrgIds null) sees every entry', () => {
    expect(entryOrgAllowed({ orgId: 'o-1' }, null)).toBe(true);
    expect(entryOrgAllowed({ orgId: null }, null)).toBe(true);
  });

  it('confines partner scope to its granted orgs (the cross-org leak)', () => {
    // orgAccess='selected' admin granted only o-1: an o-9 entry under the same
    // partner must look "not found" even though partner-axis RLS would return it.
    expect(entryOrgAllowed({ orgId: 'o-1' }, ['o-1', 'o-2'])).toBe(true);
    expect(entryOrgAllowed({ orgId: 'o-9' }, ['o-1', 'o-2'])).toBe(false);
  });

  it('null-org (unlinked) entries carry no org to leak and stay in scope', () => {
    expect(entryOrgAllowed({ orgId: null }, ['o-1'])).toBe(true);
    expect(entryOrgAllowed({ orgId: null }, [])).toBe(true);
  });

  it('empty allowlist denies every org-bound entry', () => {
    expect(entryOrgAllowed({ orgId: 'o-1' }, [])).toBe(false);
  });
});

// accessibleOrgIds null = unrestricted within partner (orgAccess='all' / system).
// Existing fixtures use 'o-1'/'o-9' etc., so null keeps prior tests passing.
const ACTOR = { userId: 'u-1', name: 'Tess', partnerId: 'p-1', manageAll: false, accessibleOrgIds: null as string[] | null };
const ADMIN = { ...ACTOR, userId: 'u-admin', manageAll: true };

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.insertedValues.length = 0;
  dbMocks.updateSetArgs.length = 0;
  dbMocks.insertErrors.length = 0;
  dbMocks.insertResultsQueue.length = 0;
  dbMocks.whereArgs.length = 0;
  dbMocks.insertResult = [];
  dbMocks.updateResult = [];
  dbMocks.onConflictDoNothingCalls = 0;
  dbMocks.forUpdateCalls = 0;
  dbMocks.deleteError = null;
  dbMocks.deleteResult = [];
  emitMock.mockClear();
  configMocks.getOrgBillingDefaults.mockResolvedValue(null);
});

describe('computeDurationMinutes', () => {
  it('floors to whole minutes', () => {
    expect(computeDurationMinutes(new Date('2026-06-11T09:00:00Z'), new Date('2026-06-11T09:30:59Z'))).toBe(30);
    expect(computeDurationMinutes(new Date('2026-06-11T09:00:00Z'), new Date('2026-06-11T09:00:30Z'))).toBe(0);
  });
});

describe('resolveDefaultRate (spec §1.6 / §7 match-or-skip)', () => {
  it('org setting applies when entered under the org currency', () => {
    expect(resolveDefaultRate('USD', { defaultHourlyRate: '150.00', rateCurrency: 'USD' }, { defaultHourlyRate: '125.00', rateCurrency: 'USD' })).toBe('150.00');
  });

  it('skips a wrong-currency org setting and falls to a matching category', () => {
    expect(resolveDefaultRate('EUR', { defaultHourlyRate: '150.00', rateCurrency: 'USD' }, { defaultHourlyRate: '125.00', rateCurrency: 'EUR' })).toBe('125.00');
  });

  it('returns null when neither default matches — never a wrong-currency number', () => {
    expect(resolveDefaultRate('EUR', { defaultHourlyRate: '150.00', rateCurrency: 'USD' }, { defaultHourlyRate: '125.00', rateCurrency: 'USD' })).toBeNull();
  });

  it('org setting with a null rate defers to a matching category', () => {
    expect(resolveDefaultRate('USD', { defaultHourlyRate: null, rateCurrency: 'USD' }, { defaultHourlyRate: '75.00', rateCurrency: 'USD' })).toBe('75.00');
  });

  it('no org setting + category with no stamped currency yields null', () => {
    expect(resolveDefaultRate('USD', null, { defaultHourlyRate: '75.00', rateCurrency: null })).toBeNull();
    expect(resolveDefaultRate('USD', null, null)).toBeNull();
  });
});

describe('createTimeEntry', () => {
  it('rejects a ticket from another partner', async () => {
    // 1st system read: the ticket
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-OTHER', orgId: 'o-1', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-OTHER', currencyCode: 'USD' }]); // org (system read)
    await expect(createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      ACTOR
    )).rejects.toMatchObject({ code: 'TICKET_WRONG_PARTNER', status: 400 });
  });

  it('defaults billable + rate from the ticket category (D2) and denormalizes org_id', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00', rateCurrency: 'USD' }]);
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'te-1', partnerId: 'p-1', ticketId: 't-1', userId: 'u-1', durationMinutes: 30, isBillable: true }];
    const entry = await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      ACTOR
    );
    expect(entry.id).toBe('te-1');
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.orgId).toBe('o-1');
    expect(vals.isBillable).toBe(true);
    expect(vals.hourlyRate).toBe('125.00');
    expect(vals.durationMinutes).toBe(30);
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'time_entry.created' }));
  });

  it('match-or-skip: a category rate entered in another currency is skipped (billable, no rate)', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'EUR' }]); // org (system read)
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00', rateCurrency: 'USD' }]);
    dbMocks.selectResults.push([{ currencyCode: 'EUR' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'te-1', partnerId: 'p-1', ticketId: 't-1', userId: 'u-1', durationMinutes: 30, isBillable: true }];
    await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      ACTOR
    );
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.hourlyRate).toBeNull();
    expect(vals.isBillable).toBe(true); // billable without a rate is allowed
  });

  it('explicit isBillable/hourlyRate override category defaults', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00', rateCurrency: 'USD' }]);
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'te-1' }];
    await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z'), isBillable: false, hourlyRate: 80 },
      ACTOR
    );
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.isBillable).toBe(false);
    expect(vals.hourlyRate).toBe('80.00');
  });

  it('non-ticket entry: org null, rate null, not billable by default', async () => {
    dbMocks.insertResult = [{ id: 'te-2' }];
    await createTimeEntry(
      { startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T10:00:00Z'), description: 'internal maintenance' },
      ACTOR
    );
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.orgId).toBeNull();
    expect(vals.ticketId).toBeNull();
    expect(vals.hourlyRate).toBeNull();
    expect(vals.isBillable).toBe(false);
    expect(vals.durationMinutes).toBe(60);
  });

  it('requires a resolvable partner', async () => {
    await expect(createTimeEntry(
      { startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T10:00:00Z') },
      { ...ACTOR, partnerId: null }
    )).rejects.toMatchObject({ code: 'PARTNER_UNRESOLVABLE' });
  });

  it('rejects endedAt before startedAt at the service boundary', async () => {
    await expect(createTimeEntry(
      { startedAt: new Date('2026-06-11T10:00:00Z'), endedAt: new Date('2026-06-11T09:00:00Z') },
      ACTOR
    )).rejects.toMatchObject({ code: 'INVALID_RANGE', status: 400 });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('resolves a legacy ticket partner through its organization fallback', async () => {
    dbMocks.selectResults.push([{ id: 't-legacy', partnerId: null, orgId: 'o-1', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-legacy', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'te-legacy', partnerId: 'p-1', ticketId: 't-legacy', userId: 'u-1', durationMinutes: 15, isBillable: false }];
    await createTimeEntry(
      { ticketId: 't-legacy', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:15:00Z') },
      ACTOR
    );
    expect(dbMocks.insertedValues[0]!.partnerId).toBe('p-1');
  });

  // ── D6: org billing defaults ─────────────────────────────────────────────
  describe('D6 org billing defaults', () => {
    it('(a) org defaults win over category defaults when both are present', async () => {
      // org: rate=150, billable=true; category: rate=100, billable=false → org wins
      configMocks.getOrgBillingDefaults.mockResolvedValue({ defaultHourlyRate: '150.00', rateCurrency: 'USD', defaultBillable: true });
      dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
      dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
      dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: false, defaultHourlyRate: '100.00', rateCurrency: 'USD' }]);
      dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
      dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
      dbMocks.insertResult = [{ id: 'te-d6a', partnerId: 'p-1', ticketId: 't-1', userId: 'u-1', durationMinutes: 30, isBillable: true }];
      await createTimeEntry(
        { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
        ACTOR
      );
      const vals = dbMocks.insertedValues[0]!;
      expect(vals.isBillable).toBe(true);
      expect(vals.hourlyRate).toBe('150.00');
    });

    it('(b) org row exists but both fields null → category values win', async () => {
      // org row present with nulls; category has defaults → category wins
      configMocks.getOrgBillingDefaults.mockResolvedValue({ defaultHourlyRate: null, rateCurrency: 'USD', defaultBillable: null });
      dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
      dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
      dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '75.00', rateCurrency: 'USD' }]);
      dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
      dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
      dbMocks.insertResult = [{ id: 'te-d6b' }];
      await createTimeEntry(
        { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
        ACTOR
      );
      const vals = dbMocks.insertedValues[0]!;
      expect(vals.isBillable).toBe(true);
      expect(vals.hourlyRate).toBe('75.00');
    });

    it('(c) no org row → category values apply (existing behavior not regressed)', async () => {
      // configMocks.getOrgBillingDefaults returns null (default in beforeEach)
      dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
      dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
      dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00', rateCurrency: 'USD' }]);
      dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
      dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
      dbMocks.insertResult = [{ id: 'te-d6c' }];
      await createTimeEntry(
        { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
        ACTOR
      );
      const vals = dbMocks.insertedValues[0]!;
      expect(vals.isBillable).toBe(true);
      expect(vals.hourlyRate).toBe('125.00');
    });

    it('(d) explicit input override wins over org AND category defaults', async () => {
      configMocks.getOrgBillingDefaults.mockResolvedValue({ defaultHourlyRate: '150.00', rateCurrency: 'USD', defaultBillable: true });
      dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
      dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
      dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '100.00', rateCurrency: 'USD' }]);
      dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
      dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
      dbMocks.insertResult = [{ id: 'te-d6d' }];
      await createTimeEntry(
        { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z'), isBillable: false, hourlyRate: 200 },
        ACTOR
      );
      const vals = dbMocks.insertedValues[0]!;
      expect(vals.isBillable).toBe(false);
      expect(vals.hourlyRate).toBe('200.00');
    });

    it('(e) match-or-skip: org setting entered in CAD is skipped for a USD org; matching category applies', async () => {
      configMocks.getOrgBillingDefaults.mockResolvedValue({ defaultHourlyRate: '150.00', rateCurrency: 'CAD', defaultBillable: true });
      dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
      dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
      dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: false, defaultHourlyRate: '125.00', rateCurrency: 'USD' }]);
      dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
      dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
      dbMocks.insertResult = [{ id: 'te-d6e' }];
      await createTimeEntry(
        { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
        ACTOR
      );
      const vals = dbMocks.insertedValues[0]!;
      // defaultBillable is non-monetary: the org setting still wins there.
      expect(vals.isBillable).toBe(true);
      expect(vals.hourlyRate).toBe('125.00');
    });
  });
});

describe('org-axis ticket gate (orgAccess=selected)', () => {
  // A partner user granted only org o-1 must not write onto a ticket in o-OTHER,
  // even though both orgs share the same partner (p-1). The ticket is read under
  // system scope, so the org-axis allowlist is the only thing standing between
  // the caller and a cross-org ticket write + feed comment.
  const SELECTED = { ...ACTOR, accessibleOrgIds: ['o-1'] as string[] | null };

  it('createTimeEntry rejects a same-partner ticket in a non-granted org (404 TICKET_ORG_DENIED)', async () => {
    dbMocks.selectResults.push([{ id: 't-x', partnerId: 'p-1', orgId: 'o-OTHER', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    await expect(createTimeEntry(
      { ticketId: 't-x', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      SELECTED
    )).rejects.toMatchObject({ code: 'TICKET_ORG_DENIED', status: 404 });
    // No time-entry insert and no feed comment for the denied org.
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('createTimeEntry allows a ticket in a granted org', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'te-ok', partnerId: 'p-1', ticketId: 't-1', userId: 'u-1', durationMinutes: 30, isBillable: false }];
    const entry = await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      SELECTED
    );
    expect(entry.id).toBe('te-ok');
    expect(dbMocks.insertedValues[0]!.orgId).toBe('o-1');
  });

  it('startTimer rejects a same-partner ticket in a non-granted org', async () => {
    dbMocks.selectResults.push([{ id: 't-x', partnerId: 'p-1', orgId: 'o-OTHER', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    await expect(startTimer({ ticketId: 't-x' }, SELECTED))
      .rejects.toMatchObject({ code: 'TICKET_ORG_DENIED', status: 404 });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('updateTimeEntry rejects relinking to a ticket in a non-granted org', async () => {
    // The target ticket is resolved (and gated) before the entry is ever read.
    dbMocks.selectResults.push([{ id: 't-x', partnerId: 'p-1', orgId: 'o-OTHER', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    await expect(updateTimeEntry('te-1', { ticketId: 't-x' }, SELECTED))
      .rejects.toMatchObject({ code: 'TICKET_ORG_DENIED', status: 404 });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });

  it('addTicketPart rejects a same-partner ticket in a non-granted org', async () => {
    dbMocks.selectResults.push([{ id: 't-x', partnerId: 'p-1', orgId: 'o-OTHER', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    await expect(addTicketPart('t-x', { description: 'SSD', quantity: 1, unitPrice: 100 }, SELECTED))
      .rejects.toMatchObject({ code: 'TICKET_ORG_DENIED', status: 404 });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('system scope (accessibleOrgIds null) is unrestricted across orgs', async () => {
    dbMocks.selectResults.push([{ id: 't-sys', partnerId: 'p-1', orgId: 'o-OTHER', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-sys', orgId: 'o-OTHER' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'te-sys', partnerId: 'p-1', ticketId: 't-sys', userId: 'u-admin', durationMinutes: 30, isBillable: false }];
    const entry = await createTimeEntry(
      { ticketId: 't-sys', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      { ...ADMIN, partnerId: null, accessibleOrgIds: null }
    );
    expect(entry.id).toBe('te-sys');
  });
});

describe('startTimer / stopTimer', () => {
  it('startTimer stops the running entry first (D3) then inserts a running row', async () => {
    // update(...).returning() = the previously-running entry being stopped
    dbMocks.updateResult = [{ id: 'te-old', startedAt: new Date('2026-06-11T08:00:00Z') }];
    dbMocks.insertResult = [{ id: 'te-new', endedAt: null }];
    const entry = await startTimer({ description: 'on it' }, ACTOR);
    expect(entry.id).toBe('te-new');
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.endedAt).toBeNull();
    expect(vals.durationMinutes).toBeNull();
  });

  it('D6 (a) startTimer with ticket uses org billing defaults when org row present', async () => {
    configMocks.getOrgBillingDefaults.mockResolvedValue({ defaultHourlyRate: '150.00', rateCurrency: 'USD', defaultBillable: true });
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: false, defaultHourlyRate: '100.00', rateCurrency: 'USD' }]);
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.updateResult = []; // no running timer to stop
    dbMocks.insertResult = [{ id: 'te-timer', endedAt: null }];
    await startTimer({ ticketId: 't-1' }, ACTOR);
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.isBillable).toBe(true);
    expect(vals.hourlyRate).toBe('150.00');
  });

  it('stopTimer errors with NO_RUNNING_TIMER when nothing is running', async () => {
    dbMocks.updateResult = []; // CAS update matched no rows
    await expect(stopTimer({}, ACTOR)).rejects.toMatchObject({ code: 'NO_RUNNING_TIMER', status: 404 });
  });

  // #2189 regression block: the one-running-timer conflict must NEVER raise a
  // statement error. The old catch-and-retry design let the 23505 abort the
  // surrounding withDbAccessContext transaction — the in-transaction retry then
  // died with 25P02 (not a unique violation), so the intended 409 at the end of
  // startTimer was unreachable, and postgres.js re-threw the raw error at
  // commit anyway. startTimer now suppresses the conflict with ON CONFLICT DO
  // NOTHING: zero returned rows = lost the race, no error object ever exists.
  it('startTimer routes the running-timer insert through onConflictDoNothing', async () => {
    dbMocks.updateResult = []; // no running timer to stop
    dbMocks.insertResult = [{ id: 'te-new', endedAt: null }];
    await startTimer({ description: 'plain start' }, ACTOR);
    expect(dbMocks.onConflictDoNothingCalls).toBe(1);
  });

  it('converts a persistent running-timer conflict into the typed 409 (no statement ever raises)', async () => {
    dbMocks.updateResult = []; // nothing visible to auto-stop (e.g. an RLS-hidden running entry)
    dbMocks.insertResultsQueue.push([], []); // both attempts lose the race → zero rows
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(startTimer({ description: 'race' }, ACTOR))
        .rejects.toMatchObject({ name: 'TimeEntryServiceError', code: 'ENTRY_RUNNING', status: 409 });
      expect(consoleSpy).toHaveBeenCalledWith('[timeEntryService.startTimer] running-timer conflict, retrying once');
    } finally {
      consoleSpy.mockRestore();
    }
    // Exactly two attempts: the initial insert plus one retry (each preceded by
    // an auto-stop CAS update).
    expect(dbMocks.insertedValues).toHaveLength(2);
    expect(dbMocks.updateSetArgs).toHaveLength(2);
  });

  it('retries once and succeeds when only the first insert loses the running-timer race', async () => {
    dbMocks.updateResult = []; // no running timer to stop
    dbMocks.insertResultsQueue.push([], [{ id: 'te-retry', endedAt: null }]);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(startTimer({ description: 'race' }, ACTOR)).resolves.toMatchObject({ id: 'te-retry' });
    } finally {
      consoleSpy.mockRestore();
    }
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'time_entry.created', timeEntryId: 'te-retry' }));
  });
});

describe('updateTimeEntry — own-vs-all + approval semantics (D5)', () => {
  const baseEntry = {
    id: 'te-1', partnerId: 'p-1', orgId: null, ticketId: null, userId: 'u-1',
    startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z'),
    durationMinutes: 30, isApproved: false
  };

  it("403s when a non-admin edits someone else's entry", async () => {
    dbMocks.selectResults.push([{ ...baseEntry, userId: 'u-OTHER' }]);
    await expect(updateTimeEntry('te-1', { description: 'x' }, ACTOR))
      .rejects.toMatchObject({ code: 'NOT_OWN_ENTRY', status: 403 });
  });

  it('403s when a non-admin edits an approved entry', async () => {
    dbMocks.selectResults.push([{ ...baseEntry, isApproved: true }]);
    await expect(updateTimeEntry('te-1', { description: 'x' }, ACTOR))
      .rejects.toMatchObject({ code: 'APPROVED_IMMUTABLE', status: 403 });
  });

  it('any edit clears approval (even by an approver)', async () => {
    dbMocks.selectResults.push([{ ...baseEntry, isApproved: true }]);
    dbMocks.updateResult = [{ ...baseEntry, description: 'fixed' }];
    await updateTimeEntry('te-1', { description: 'fixed' }, ADMIN);
    const setArgs = dbMocks.updateSetArgs.at(-1)!;
    expect(setArgs.isApproved).toBe(false);
    expect(setArgs.approvedBy).toBeNull();
    expect(setArgs.approvedAt).toBeNull();
  });

  it('recomputes duration when the range changes', async () => {
    dbMocks.selectResults.push([baseEntry]);
    dbMocks.updateResult = [baseEntry];
    await updateTimeEntry('te-1', { endedAt: new Date('2026-06-11T10:00:00Z') }, ACTOR);
    expect(dbMocks.updateSetArgs.at(-1)!.durationMinutes).toBe(60);
  });

  it('rejects an update producing endedAt <= startedAt', async () => {
    dbMocks.selectResults.push([baseEntry]);
    await expect(updateTimeEntry('te-1', { endedAt: new Date('2026-06-11T08:00:00Z') }, ACTOR))
      .rejects.toMatchObject({ code: 'INVALID_RANGE' });
  });

  it('relinking to a ticket re-validates partner and re-denormalizes org', async () => {
    // Lock order: target ticket resolve + lock first, then the entry FOR UPDATE.
    dbMocks.selectResults.push([{ id: 't-9', partnerId: 'p-1', orgId: 'o-9', categoryId: null }]); // ticket (system read)
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-9', orgId: 'o-9' }]); // ticket lock row (FOR UPDATE)
    dbMocks.selectResults.push([baseEntry]); // the entry
    dbMocks.updateResult = [baseEntry];
    await updateTimeEntry('te-1', { ticketId: 't-9' }, ACTOR);
    const setArgs = dbMocks.updateSetArgs.at(-1)!;
    expect(setArgs.ticketId).toBe('t-9');
    expect(setArgs.orgId).toBe('o-9');
  });

  it('rejects system-scope relinks that would cross the entry partner boundary', async () => {
    dbMocks.selectResults.push([{ id: 't-cross', partnerId: 'p-OTHER', orgId: 'o-other', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-OTHER', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-cross', orgId: 'o-other' }]); // ticket lock row (FOR UPDATE)
    dbMocks.selectResults.push([baseEntry]);
    await expect(updateTimeEntry(
      'te-1',
      { ticketId: 't-cross' },
      { ...ADMIN, partnerId: null }
    )).rejects.toMatchObject({ code: 'TICKET_WRONG_PARTNER', status: 400 });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });

  it('detaches ticket when ticketId null: set ticketId null and orgId null', async () => {
    dbMocks.selectResults.push([{ ...baseEntry, ticketId: 't-5', orgId: 'o-5' }]);
    dbMocks.updateResult = [{ ...baseEntry, ticketId: null, orgId: null }];
    await updateTimeEntry('te-1', { ticketId: null }, ACTOR);
    const setArgs = dbMocks.updateSetArgs.at(-1)!;
    expect(setArgs.ticketId).toBeNull();
    expect(setArgs.orgId).toBeNull();
  });
});

describe('deleteTimeEntry', () => {
  it("403s for someone else's entry without manageAll", async () => {
    dbMocks.selectResults.push([{ id: 'te-1', userId: 'u-OTHER', isApproved: false, partnerId: 'p-1', ticketId: null }]);
    await expect(deleteTimeEntry('te-1', ACTOR)).rejects.toMatchObject({ code: 'NOT_OWN_ENTRY' });
  });
  it('403s for an approved entry without manageAll', async () => {
    dbMocks.selectResults.push([{ id: 'te-1', userId: 'u-1', isApproved: true, partnerId: 'p-1', ticketId: null }]);
    await expect(deleteTimeEntry('te-1', ACTOR)).rejects.toMatchObject({ code: 'APPROVED_IMMUTABLE' });
  });
  it('owner deletes own unapproved entry: emits deleted event with entry userId', async () => {
    dbMocks.selectResults.push([{ id: 'te-1', userId: 'u-1', isApproved: false, partnerId: 'p-1', ticketId: null }]);
    await deleteTimeEntry('te-1', ACTOR);
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'time_entry.deleted',
      payload: expect.objectContaining({ userId: 'u-1' })
    }));
  });
});

describe('approveTimeEntries', () => {
  it('requires manageAll', async () => {
    await expect(approveTimeEntries(['te-1'], true, ACTOR)).rejects.toMatchObject({ code: 'ADMIN_REQUIRED', status: 403 });
  });

  it('skips running and missing entries with reasons', async () => {
    dbMocks.selectResults.push([
      { id: 'te-1', endedAt: new Date(), partnerId: 'p-1', ticketId: null },
      { id: 'te-2', endedAt: null, partnerId: 'p-1', ticketId: null } // running
    ]); // te-3 missing
    dbMocks.updateResult = [{ id: 'te-1', partnerId: 'p-1', ticketId: null }];
    const result = await approveTimeEntries(['te-1', 'te-2', 'te-3'], true, ADMIN);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.skippedReasons).toEqual({ ENTRY_RUNNING: 1, ENTRY_NOT_FOUND: 1 });
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'time_entry.approved' }));
  });

  it('unapprove path: nulls out approval fields and does NOT emit approved event', async () => {
    dbMocks.selectResults.push([
      { id: 'te-1', endedAt: new Date(), partnerId: 'p-1', ticketId: null }
    ]);
    dbMocks.updateResult = [{ id: 'te-1', partnerId: 'p-1', ticketId: null }];
    const result = await approveTimeEntries(['te-1'], false, ADMIN);
    expect(result.updated).toBe(1);
    const setArgs = dbMocks.updateSetArgs.at(-1)!;
    expect(setArgs.isApproved).toBe(false);
    expect(setArgs.approvedBy).toBeNull();
    expect(setArgs.approvedAt).toBeNull();
    expect(emitMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'time_entry.approved' }));
  });
});

describe('time-entry audit mutation recording', () => {
  function actorWithRecorder() {
    const recordAuditMutation = vi.fn();
    return {
      actor: { ...ACTOR, recordAuditMutation },
      recordAuditMutation,
    };
  }

  it('records create from the returned row, including its exact organization', async () => {
    const { actor, recordAuditMutation } = actorWithRecorder();
    dbMocks.selectResults.push([
      { id: 't-1', partnerId: 'p-1', orgId: 'o-create', categoryId: null },
    ]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-create' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{
      id: 'te-create',
      orgId: 'o-create',
      partnerId: 'p-1',
      ticketId: 't-1',
      userId: 'u-1',
      durationMinutes: 30,
      isBillable: false,
    }];

    await createTimeEntry(
      {
        ticketId: 't-1',
        startedAt: new Date('2026-06-11T09:00:00Z'),
        endedAt: new Date('2026-06-11T09:30:00Z'),
      },
      actor,
    );

    expect(recordAuditMutation).toHaveBeenCalledWith({
      action: 'time_entry.created',
      entryId: 'te-create',
      orgId: 'o-create',
    });
  });

  it('records both the auto-stopped row and the newly started row', async () => {
    const { actor, recordAuditMutation } = actorWithRecorder();
    dbMocks.updateResult = [{
      id: 'te-previous',
      orgId: 'o-previous',
      partnerId: 'p-1',
      ticketId: null,
      durationMinutes: 15,
      isBillable: false,
    }];
    dbMocks.insertResult = [{
      id: 'te-started',
      orgId: null,
      partnerId: 'p-1',
      ticketId: null,
      endedAt: null,
      isBillable: false,
    }];

    await startTimer({ description: 'next task' }, actor);

    expect(recordAuditMutation.mock.calls.map(([mutation]) => mutation)).toEqual([
      {
        action: 'time_entry.stopped',
        entryId: 'te-previous',
        orgId: 'o-previous',
      },
      {
        action: 'time_entry.started',
        entryId: 'te-started',
        orgId: null,
      },
    ]);
  });

  it('records stop and update from their returned rows', async () => {
    const stop = actorWithRecorder();
    dbMocks.updateResult = [{
      id: 'te-stop',
      orgId: 'o-stop',
      partnerId: 'p-1',
      ticketId: null,
      durationMinutes: 20,
      isBillable: false,
    }];
    await stopTimer({}, stop.actor);
    expect(stop.recordAuditMutation).toHaveBeenCalledWith({
      action: 'time_entry.stopped',
      entryId: 'te-stop',
      orgId: 'o-stop',
    });

    const update = actorWithRecorder();
    const existing = {
      id: 'te-update',
      orgId: 'o-before',
      partnerId: 'p-1',
      ticketId: null,
      userId: 'u-1',
      startedAt: new Date('2026-06-11T09:00:00Z'),
      endedAt: new Date('2026-06-11T09:30:00Z'),
      durationMinutes: 30,
      isApproved: false,
    };
    dbMocks.selectResults.push([existing]);
    dbMocks.updateResult = [{ ...existing, orgId: 'o-after', description: 'updated' }];
    await updateTimeEntry('te-update', { description: 'updated' }, update.actor);
    expect(update.recordAuditMutation).toHaveBeenCalledWith({
      action: 'time_entry.updated',
      entryId: 'te-update',
      orgId: 'o-after',
    });
  });

  it('does not record an update when UPDATE RETURNING yields no mutated row', async () => {
    const update = actorWithRecorder();
    const existing = {
      id: 'te-raced',
      orgId: 'o-before',
      partnerId: 'p-1',
      ticketId: null,
      userId: 'u-1',
      startedAt: new Date('2026-06-11T09:00:00Z'),
      endedAt: new Date('2026-06-11T09:30:00Z'),
      durationMinutes: 30,
      isApproved: false,
    };
    dbMocks.selectResults.push([existing]);
    dbMocks.updateResult = [];

    await updateTimeEntry('te-raced', { description: 'lost race' }, update.actor);

    expect(update.recordAuditMutation).not.toHaveBeenCalled();
  });

  it('records delete only after the authorized database deletion succeeds', async () => {
    const success = actorWithRecorder();
    dbMocks.selectResults.push([{
      id: 'te-delete',
      orgId: null,
      userId: 'u-1',
      isApproved: false,
      partnerId: 'p-1',
      ticketId: null,
      durationMinutes: 10,
    }]);
    dbMocks.deleteResult = [{ id: 'te-delete', orgId: null }];
    await deleteTimeEntry('te-delete', success.actor);
    expect(success.recordAuditMutation).toHaveBeenCalledWith({
      action: 'time_entry.deleted',
      entryId: 'te-delete',
      orgId: null,
    });

    const failed = actorWithRecorder();
    dbMocks.selectResults.push([{
      id: 'te-failed',
      orgId: 'o-failed',
      userId: 'u-1',
      isApproved: false,
      partnerId: 'p-1',
      ticketId: null,
      durationMinutes: 10,
    }]);
    dbMocks.deleteError = new Error('delete failed');
    await expect(deleteTimeEntry('te-failed', failed.actor)).rejects.toThrow(
      'delete failed',
    );
    expect(failed.recordAuditMutation).not.toHaveBeenCalled();
  });

  it('does not record delete when a concurrent delete leaves no returned row', async () => {
    const raced = actorWithRecorder();
    dbMocks.selectResults.push([{
      id: 'te-raced-delete',
      orgId: 'o-raced',
      userId: 'u-1',
      isApproved: false,
      partnerId: 'p-1',
      ticketId: null,
      durationMinutes: 10,
    }]);
    dbMocks.deleteResult = [];

    await deleteTimeEntry('te-raced-delete', raced.actor);

    expect(raced.recordAuditMutation).not.toHaveBeenCalled();
  });

  it('records only returned mixed-org bulk rows, preserving a NULL partner-level org', async () => {
    const approved = actorWithRecorder();
    approved.actor.manageAll = true;
    dbMocks.selectResults.push([
      { id: 'te-a', endedAt: new Date(), partnerId: 'p-1', ticketId: null },
      { id: 'te-b', endedAt: new Date(), partnerId: 'p-1', ticketId: null },
      { id: 'te-null', endedAt: new Date(), partnerId: 'p-1', ticketId: null },
    ]);
    dbMocks.updateResult = [
      { id: 'te-a', orgId: 'o-a', partnerId: 'p-1', ticketId: null },
      { id: 'te-b', orgId: 'o-b', partnerId: 'p-1', ticketId: null },
      { id: 'te-null', orgId: null, partnerId: 'p-1', ticketId: null },
    ];

    const result = await approveTimeEntries(
      ['te-a', 'te-b', 'te-null', 'te-skipped'],
      true,
      approved.actor,
    );

    expect(result).toMatchObject({ updated: 3, skipped: 1 });
    expect(
      approved.recordAuditMutation.mock.calls.map(([mutation]) => mutation),
    ).toEqual([
      { action: 'time_entry.approved', entryId: 'te-a', orgId: 'o-a' },
      { action: 'time_entry.approved', entryId: 'te-b', orgId: 'o-b' },
      { action: 'time_entry.approved', entryId: 'te-null', orgId: null },
    ]);

    const unapproved = actorWithRecorder();
    unapproved.actor.manageAll = true;
    dbMocks.selectResults.push([
      { id: 'te-a', endedAt: new Date(), partnerId: 'p-1', ticketId: null },
    ]);
    dbMocks.updateResult = [
      { id: 'te-a', orgId: 'o-a', partnerId: 'p-1', ticketId: null },
    ];
    await approveTimeEntries(['te-a'], false, unapproved.actor);
    expect(unapproved.recordAuditMutation).toHaveBeenCalledWith({
      action: 'time_entry.unapproved',
      entryId: 'te-a',
      orgId: 'o-a',
    });
  });
});

describe('addTicketPart', () => {
  it('denormalizes org_id and defaults billable from category', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: false, defaultHourlyRate: null, rateCurrency: null }]);
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'part-1' }];
    await addTicketPart('t-1', { description: 'SSD 1TB', quantity: 1, unitPrice: 120 }, ACTOR);
    const vals = dbMocks.insertedValues.at(-1)!;
    expect(vals.orgId).toBe('o-1');
    expect(vals.isBillable).toBe(false);
    expect(vals.unitPrice).toBe('120.00');
  });

  it('sets addedBy from actor, defaults billingStatus to not_billed, and preserves null costBasis', async () => {
    dbMocks.selectResults.push([{ id: 't-2', partnerId: 'p-1', orgId: 'o-2', categoryId: 'cat-2' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ id: 'cat-2', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: null, rateCurrency: null }]);
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-2', orgId: 'o-2' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'part-2' }];
    await addTicketPart('t-2', { description: 'RAM 32GB', quantity: 2, unitPrice: 60 }, ACTOR);
    const vals = dbMocks.insertedValues.at(-1)!;
    expect(vals.addedBy).toBe('u-1');
    expect(vals.billingStatus).toBe('not_billed');
    expect(vals.costBasis).toBeNull();
  });

  it('fails loudly if insert returning yields no part row', async () => {
    dbMocks.selectResults.push([{ id: 't-3', partnerId: 'p-1', orgId: 'o-3', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-3', orgId: 'o-3' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [];
    await expect(addTicketPart('t-3', { description: 'Cable', quantity: 1, unitPrice: 5 }, ACTOR))
      .rejects.toThrow('Failed to create ticket part');
  });
});

describe('query helpers', () => {
  it('getTimesheet buckets seven days and totals billable minutes', async () => {
    dbMocks.selectResults.push([
      {
        id: 'te-1',
        startedAt: new Date('2026-06-08T10:00:00Z'),
        durationMinutes: 30,
        isBillable: true
      },
      {
        id: 'te-2',
        startedAt: new Date('2026-06-09T10:00:00Z'),
        durationMinutes: 45,
        isBillable: false
      }
    ]);
    const result = await getTimesheet('u-1', new Date('2026-06-08T00:00:00Z'));
    expect(result.weekStart).toBe('2026-06-08');
    expect(result.days).toHaveLength(7);
    expect(result.days[0]!.entries.map((e: any) => e.id)).toEqual(['te-1']);
    expect(result.totals).toEqual({ totalMinutes: 75, billableMinutes: 30, billableAmounts: [] });
  });

  it('getTimesheet groups billable labor by currency in first-seen order', async () => {
    dbMocks.selectResults.push([
      {
        id: 'te-eur-1',
        startedAt: new Date('2026-06-08T09:00:00Z'),
        durationMinutes: 60,
        isBillable: true,
        hourlyRate: '100.00',
        currencyCode: 'EUR'
      },
      {
        id: 'te-eur-2',
        startedAt: new Date('2026-06-08T10:00:00Z'),
        durationMinutes: 30,
        isBillable: true,
        hourlyRate: '100.00',
        currencyCode: 'EUR'
      },
      {
        id: 'te-usd',
        startedAt: new Date('2026-06-09T09:00:00Z'),
        durationMinutes: 60,
        isBillable: true,
        hourlyRate: '50.00',
        currencyCode: 'USD'
      },
      {
        id: 'te-non-billable',
        startedAt: new Date('2026-06-09T10:00:00Z'),
        durationMinutes: 60,
        isBillable: false,
        hourlyRate: '1000.00',
        currencyCode: 'EUR'
      }
    ]);

    const result = await getTimesheet('u-1', new Date('2026-06-08T00:00:00Z'));

    expect(result.totals.billableAmounts).toEqual([
      { currencyCode: 'EUR', amount: '150.00' },
      { currencyCode: 'USD', amount: '50.00' }
    ]);
  });

  it('getTimesheet rounds quantity x rate ties half-up in exact decimal (review #2)', async () => {
    // 1 min at 7.25/h → 0.02 h × 7.25 = 0.145 → 0.15 per row. The double product is
    // 0.14499999999999999, which Math.floor(n*100+0.5) turned into 0.14 while the
    // SQL ticket summary said 0.15. Three rows = 0.45.
    const row = (id: string) => ({
      id, startedAt: new Date('2026-06-08T09:00:00Z'), durationMinutes: 1,
      isBillable: true, hourlyRate: '7.25', currencyCode: 'USD'
    });
    dbMocks.selectResults.push([row('a'), row('b'), row('c')]);

    const result = await getTimesheet('u-1', new Date('2026-06-08T00:00:00Z'));

    expect(result.totals.billableAmounts).toEqual([{ currencyCode: 'USD', amount: '0.45' }]);
  });

  it('getTimesheet rounds labor hours to two decimals before currency rounding', async () => {
    dbMocks.selectResults.push([{
      id: 'te-jpy',
      startedAt: new Date('2026-06-08T09:00:00Z'),
      durationMinutes: 20,
      isBillable: true,
      hourlyRate: '1000.00',
      currencyCode: 'JPY'
    }]);

    const result = await getTimesheet('u-1', new Date('2026-06-08T00:00:00Z'));

    expect(result.totals.billableAmounts).toEqual([
      { currencyCode: 'JPY', amount: '330.00' }
    ]);
  });

  it('getTimesheet rounds each row at the currency minor unit before summing (sum of invoice lines, not a rounded sum)', async () => {
    // 0.33 h × 100.50 = 33.165 → 33.17 per row; three rows = 99.51. Rounding the
    // raw sum (99.495) would give 99.50 — a cent off the three invoice lines.
    const row = (id: string) => ({
      id, startedAt: new Date('2026-06-08T09:00:00Z'), durationMinutes: 20,
      isBillable: true, hourlyRate: '100.50', currencyCode: 'USD'
    });
    dbMocks.selectResults.push([row('a'), row('b'), row('c')]);

    const result = await getTimesheet('u-1', new Date('2026-06-08T00:00:00Z'));

    expect(result.totals.billableAmounts).toEqual([{ currencyCode: 'USD', amount: '99.51' }]);
  });

  it('getTicketBillingSummary returns per-currency aggregate rows', async () => {
    dbMocks.selectResults.push([{ totalMinutes: 90, billableMinutes: 60 }]);
    dbMocks.selectResults.push([
      { currencyCode: 'EUR', amount: '100.00' },
      { currencyCode: 'USD', amount: '25.00' }
    ]);
    dbMocks.selectResults.push([{ partsCount: 2 }]);
    dbMocks.selectResults.push([{ currencyCode: 'EUR', amount: '40.00' }]);
    const result = await getTicketBillingSummary('t-1');
    expect(result).toEqual({
      time: {
        totalMinutes: 90,
        billableMinutes: 60,
        billableAmounts: [
          { currencyCode: 'EUR', amount: '100.00' },
          { currencyCode: 'USD', amount: '25.00' }
        ]
      },
      parts: {
        partsCount: 2,
        billableTotals: [{ currencyCode: 'EUR', amount: '40.00' }]
      }
    });
  });

  it('getTicketBillingSummary returns zero defaults and empty currency totals', async () => {
    dbMocks.selectResults.push([], [], [], []);

    const result = await getTicketBillingSummary('t-1');

    expect(result).toEqual({
      time: { totalMinutes: 0, billableMinutes: 0, billableAmounts: [] },
      parts: { partsCount: 0, billableTotals: [] }
    });
  });

  it('listBillables combines time and parts in date order', async () => {
    dbMocks.selectResults.push([
      {
        date: new Date('2026-06-10T11:00:00Z'),
        orgName: 'Acme',
        ticketNumber: 'T-1',
        description: 'labor',
        technician: 'Tess',
        minutes: 30,
        rate: '100.00',
        currencyCode: 'EUR',
        billingStatus: 'not_billed',
        isApproved: true
      }
    ]);
    dbMocks.selectResults.push([
      {
        date: new Date('2026-06-10T12:00:00Z'),
        orgName: 'Acme',
        ticketNumber: 'T-1',
        description: 'SSD',
        technician: 'Tess',
        quantity: '2.00',
        unitPrice: '10.00',
        currencyCode: 'USD',
        billingStatus: 'not_billed'
      }
    ]);
    const result = await listBillables(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T00:00:00Z'));
    expect(result.rows.map((r) => r.kind)).toEqual(['time', 'part']);
    expect(result.rows[0]).toMatchObject({
      kind: 'time', quantity: '0.50', amount: '50.00', currencyCode: 'EUR', isApproved: true
    });
    expect(result.rows[1]).toMatchObject({
      kind: 'part', amount: '20.00', currencyCode: 'USD', isApproved: null
    });
    expect(result.totalsByCurrency).toEqual([
      { currencyCode: 'EUR', amount: '50.00' },
      { currencyCode: 'USD', amount: '20.00' }
    ]);
  });

  it('listBillables rounds hours to two decimals before currency-aware labor amounts', async () => {
    dbMocks.selectResults.push([
      {
        date: new Date('2026-06-10T12:00:00Z'),
        orgName: 'Acme',
        ticketNumber: 'T-1',
        description: 'labor',
        technician: 'Tess',
        minutes: 20,
        rate: '1000.00',
        currencyCode: 'JPY',
        billingStatus: 'not_billed',
        isApproved: true
      }
    ]);
    dbMocks.selectResults.push([]);

    const result = await listBillables(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T00:00:00Z'));

    expect(result.rows[0]).toMatchObject({ quantity: '0.33', amount: '330.00', currencyCode: 'JPY' });
    expect(result.totalsByCurrency).toEqual([{ currencyCode: 'JPY', amount: '330.00' }]);
  });

  it('listBillables excludes running timers from billable time rows', async () => {
    dbMocks.selectResults.push([]);
    dbMocks.selectResults.push([]);
    const result = await listBillables(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T00:00:00Z'));
    expect(result).toEqual({ rows: [], totalsByCurrency: [] });
    expect(inspect(dbMocks.whereArgs[0], { depth: 10 })).toContain('endedAt');
  });

  it('listBillables does not emit NaN amounts for corrupt numeric DB strings', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMocks.selectResults.push([
      {
        date: new Date('2026-06-10T12:00:00Z'),
        orgName: 'Acme',
        ticketNumber: 'T-1',
        description: 'labor',
        technician: 'Tess',
        minutes: 30,
        rate: 'not-a-rate',
        currencyCode: null,
        billingStatus: 'not_billed',
        isApproved: false
      }
    ]);
    dbMocks.selectResults.push([
      {
        date: new Date('2026-06-10T13:00:00Z'),
        orgName: 'Acme',
        ticketNumber: 'T-1',
        description: 'SSD',
        technician: 'Tess',
        quantity: 'bad-qty',
        unitPrice: '50.00',
        currencyCode: 'USD',
        billingStatus: 'not_billed'
      }
    ]);
    const result = await listBillables(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T00:00:00Z'));
    expect(result.rows.map((r) => r.amount)).toEqual(['0.00', '0.00']);
    expect(result.rows.map((r) => r.amount)).not.toContain('NaN');
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});

describe('time_entry feed comments', () => {
  it('createTimeEntry with ticketId inserts a ticketComments row (logged, billable suffix)', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'te-1', partnerId: 'p-1', ticketId: 't-1', userId: 'u-1', durationMinutes: 45, isBillable: true }];
    await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:45:00Z'), isBillable: true },
      ACTOR
    );
    // Two inserts: first is timeEntries, second is ticketComments
    expect(dbMocks.insertedValues).toHaveLength(2);
    const commentVals = dbMocks.insertedValues[1]!;
    expect(commentVals.ticketId).toBe('t-1');
    expect(commentVals.commentType).toBe('time_entry');
    expect(commentVals.isPublic).toBe(false);
    expect(commentVals.authorType).toBe('internal');
    expect(String(commentVals.content)).toContain('logged 45m');
    expect(String(commentVals.content)).toContain('(billable)');
  });

  it('createTimeEntry WITHOUT ticketId does not insert a ticketComments row', async () => {
    dbMocks.insertResult = [{ id: 'te-2', partnerId: 'p-1', ticketId: null, userId: 'u-1', durationMinutes: 60, isBillable: false }];
    await createTimeEntry(
      { startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T10:00:00Z') },
      ACTOR
    );
    // Only the timeEntries insert — no ticketComments insert
    expect(dbMocks.insertedValues).toHaveLength(1);
  });

  it('stopTimer on a ticket-linked entry inserts a ticketComments row with logged wording and correct duration', async () => {
    // stopRunningEntry does an UPDATE; the returned row has ticketId + durationMinutes
    dbMocks.updateResult = [{ id: 'te-3', partnerId: 'p-1', ticketId: 't-2', userId: 'u-1', durationMinutes: 90, isBillable: false }];
    await stopTimer({}, ACTOR);
    const commentVals = dbMocks.insertedValues[0]!;
    expect(commentVals.ticketId).toBe('t-2');
    expect(commentVals.commentType).toBe('time_entry');
    expect(commentVals.isPublic).toBe(false);
    expect(String(commentVals.content)).toContain('logged 1h 30m');
    expect(String(commentVals.content)).not.toContain('(billable)');
  });

  it('startTimer auto-stops a ticket-linked entry and inserts a ticketComments row for the stopped entry', async () => {
    // updateResult = the auto-stopped previous entry (ticket-linked, 60m, billable)
    dbMocks.updateResult = [{ id: 'te-prev', partnerId: 'p-1', ticketId: 't-X', userId: 'u-1', durationMinutes: 60, isBillable: true }];
    // insertResult = the new running timer (no ticket, non-billable)
    dbMocks.insertResult = [{ id: 'te-next', partnerId: 'p-1', ticketId: null, userId: 'u-1', endedAt: null, durationMinutes: null, isBillable: false }];
    await startTimer({ description: 'next task' }, ACTOR);
    // Two inserts: first is ticketComments for the auto-stopped entry, second is the new timeEntries row
    const feedComment = dbMocks.insertedValues.find((v) => v.commentType === 'time_entry');
    expect(feedComment).toBeDefined();
    expect(feedComment!.ticketId).toBe('t-X');
    expect(feedComment!.commentType).toBe('time_entry');
    expect(feedComment!.isPublic).toBe(false);
    expect(String(feedComment!.content)).toContain('1h');
    expect(String(feedComment!.content)).toContain('(billable)');
  });

  it('deleteTimeEntry on a ticket-linked entry inserts a ticketComments row with removed wording', async () => {
    dbMocks.selectResults.push([{ id: 'te-4', userId: 'u-1', isApproved: false, partnerId: 'p-1', ticketId: 't-3', durationMinutes: 45 }]);
    await deleteTimeEntry('te-4', ACTOR);
    const commentVals = dbMocks.insertedValues[0]!;
    expect(commentVals.ticketId).toBe('t-3');
    expect(commentVals.commentType).toBe('time_entry');
    expect(commentVals.isPublic).toBe(false);
    expect(String(commentVals.content)).toContain('removed a');
    expect(String(commentVals.content)).toContain('45m');
  });

  it('deleting a running (null-duration) entry produces "removed a time entry" with no duration', async () => {
    dbMocks.selectResults.push([{ id: 'te-5', userId: 'u-1', isApproved: false, partnerId: 'p-1', ticketId: 't-4', durationMinutes: null }]);
    await deleteTimeEntry('te-5', ACTOR);
    const commentVals = dbMocks.insertedValues[0]!;
    expect(String(commentVals.content)).toBe('Tess removed a time entry');
  });

  it('a feed-comment insert failure does not reject createTimeEntry and the event is still emitted', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'te-6', partnerId: 'p-1', ticketId: 't-1', userId: 'u-1', durationMinutes: 30, isBillable: false }];
    // Make the ticketComments insert fail (first insert uses insertResult, second rejects).
    // We push null for the timeEntries returning() call (null is falsy → falls through to insertResult),
    // then the actual error for the ticketComments returning() call.
    const feedError = new Error('DB connection lost');
    dbMocks.insertErrors.push(null as unknown as Error, feedError);
    // createTimeEntry must not reject even though the feed comment insert fails;
    // if it rejects this line itself will throw and the test fails appropriately.
    const entry = await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      ACTOR
    );
    expect(entry.id).toBe('te-6');
    // Event must still be emitted after the swallowed feed-comment failure
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'time_entry.created' }));
    // Both values() calls were made (timeEntries + ticketComments) confirming the insert was attempted
    expect(dbMocks.insertedValues).toHaveLength(2);
    expect(dbMocks.insertedValues[0]!.billingStatus).toBe('not_billed'); // timeEntries row
    expect(dbMocks.insertedValues[1]!.commentType).toBe('time_entry'); // ticketComments row attempted
  });
});

// ── Wave 4 (#3776) Task 7: currency snapshots under the ticket lock ─────────
// Queue order for a linked create/relink: ticket → org → [category] → ticket
// LOCK row (FOR UPDATE on the request tx). Standalone money: one partners read.
describe('currency snapshots (wave 4 / Task 7)', () => {
  const RANGE = { startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') };
  const queueLink = (currencyCode: string, lockOrgId = 'o-1') => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode }]);
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00', rateCurrency: currencyCode }]);
    dbMocks.selectResults.push([{ currencyCode }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: lockOrgId }]); // lock row
  };

  it('(a) ticket-linked create stamps the org currency and takes the ticket row lock', async () => {
    queueLink('EUR');
    dbMocks.insertResult = [{ id: 'te-1', partnerId: 'p-1', ticketId: 't-1', durationMinutes: 30, isBillable: true }];
    await createTimeEntry({ ticketId: 't-1', ...RANGE }, ACTOR);
    expect(dbMocks.insertedValues[0]!.currencyCode).toBe('EUR');
    expect(dbMocks.selectResults).toHaveLength(0); // all 5 queued selects consumed
    expect(dbMocks.forUpdateCalls).toBe(2); // org FOR SHARE barrier, then ticket FOR UPDATE (#3778)
  });

  it('(b) standalone create without a rate stamps no currency', async () => {
    dbMocks.insertResult = [{ id: 'te-2' }];
    await createTimeEntry({ ...RANGE }, ACTOR);
    expect(dbMocks.insertedValues[0]!.currencyCode).toBeNull();
    expect(dbMocks.forUpdateCalls).toBe(0);
  });

  it('(b2) standalone create with a rate stamps the partner currency', async () => {
    dbMocks.selectResults.push([{ currencyCode: 'CAD' }]); // partners read
    dbMocks.insertResult = [{ id: 'te-2' }];
    await createTimeEntry({ ...RANGE, hourlyRate: 80 }, ACTOR);
    expect(dbMocks.insertedValues[0]!.currencyCode).toBe('CAD');
    expect(dbMocks.insertedValues[0]!.hourlyRate).toBe('80.00');
    expect(dbMocks.selectResults).toHaveLength(0);
  });

  it('(c) startTimer with a ticket stamps the org currency', async () => {
    queueLink('EUR');
    dbMocks.insertResult = [{ id: 'te-3', ticketId: 't-1', isBillable: true }];
    await startTimer({ ticketId: 't-1' }, ACTOR);
    expect(dbMocks.insertedValues[0]!.currencyCode).toBe('EUR');
    expect(dbMocks.forUpdateCalls).toBe(2); // org FOR SHARE barrier, then ticket FOR UPDATE (#3778)
  });

  it('(c3) startTimer refuses a fractional default rate in a zero-decimal currency (wave-6 review)', async () => {
    // Category default 125.50 stamped JPY: the ordinary create path already
    // rejects this, startTimer must not be the way around it.
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'JPY' }]);
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.50', rateCurrency: 'JPY' }]);
    dbMocks.selectResults.push([{ currencyCode: 'JPY' }]); // org SHARE barrier
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // lock row
    await expect(startTimer({ ticketId: 't-1' }, ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('(c4) startTimer still accepts a two-decimal default in a two-decimal currency', async () => {
    queueLink('EUR');
    dbMocks.insertResult = [{ id: 'te-3b', ticketId: 't-1', isBillable: true }];
    await startTimer({ ticketId: 't-1' }, ACTOR);
    expect(dbMocks.insertedValues[0]!.hourlyRate).toBe('125.00');
    expect(dbMocks.insertedValues[0]!.currencyCode).toBe('EUR');
  });

  it('(c2) re-resolves under the lock when the ticket moved between resolve and lock', async () => {
    queueLink('USD', 'o-2'); // first resolution says o-1/USD, lock row says o-2
    dbMocks.selectResults.push([{ currencyCode: 'EUR' }]); // org SHARE barrier on the NEW org (#3778)
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-2', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'EUR' }]);
    dbMocks.insertResult = [{ id: 'te-4', ticketId: 't-1' }];
    await createTimeEntry({ ticketId: 't-1', ...RANGE }, ACTOR);
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.currencyCode).toBe('EUR');
    expect(vals.orgId).toBe('o-2');
    expect(dbMocks.selectResults).toHaveLength(0);
  });

  const stamped = {
    id: 'te-1', partnerId: 'p-1', orgId: 'o-1', ticketId: 't-1', userId: 'u-1',
    startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z'),
    durationMinutes: 30, isApproved: false, billingStatus: 'not_billed', currencyCode: 'EUR', hourlyRate: '100.00'
  };

  it('(d) a rate edit never restamps an already-stamped entry', async () => {
    dbMocks.selectResults.push([stamped]);
    dbMocks.updateResult = [stamped];
    await updateTimeEntry('te-1', { hourlyRate: 200 }, ACTOR);
    expect(dbMocks.updateSetArgs[0]!).not.toHaveProperty('currencyCode');
    expect(dbMocks.updateSetArgs[0]!.hourlyRate).toBe('200.00');
    expect(dbMocks.forUpdateCalls).toBe(1); // entry read FOR UPDATE
  });

  it('(d2) first money on a standalone entry stamps the partner currency', async () => {
    dbMocks.selectResults.push([{ ...stamped, orgId: null, ticketId: null, currencyCode: null, hourlyRate: null }]);
    dbMocks.selectResults.push([{ currencyCode: 'CAD' }]); // partners read
    dbMocks.updateResult = [stamped];
    await updateTimeEntry('te-1', { hourlyRate: 90 }, ACTOR);
    expect(dbMocks.updateSetArgs[0]!.currencyCode).toBe('CAD');
    expect(dbMocks.selectResults).toHaveLength(0);
  });

  it('(d3) first money sent together with an explicit ticketId: null still stamps the partner currency', async () => {
    // `{ ticketId: null, hourlyRate }` on a moneyless standalone entry ends standalone
    // with money — without the stamp the DB CHECK (currency_required_when_rate) fires.
    dbMocks.selectResults.push([{ ...stamped, orgId: null, ticketId: null, currencyCode: null, hourlyRate: null }]);
    dbMocks.selectResults.push([{ currencyCode: 'CAD' }]); // partners read
    dbMocks.updateResult = [stamped];
    await updateTimeEntry('te-1', { ticketId: null, hourlyRate: 90 }, ACTOR);
    const set = dbMocks.updateSetArgs[0]!;
    expect(set.currencyCode).toBe('CAD');
    expect(set.ticketId).toBeNull();
    expect(dbMocks.selectResults).toHaveLength(0);
  });

  it('(e) first attach of an unstamped standalone entry stamps the ticket org currency; lock precedes the entry read', async () => {
    queueLink('USD');
    dbMocks.selectResults.push([{ ...stamped, orgId: null, ticketId: null, currencyCode: null, hourlyRate: null }]);
    dbMocks.updateResult = [stamped];
    await updateTimeEntry('te-1', { ticketId: 't-1' }, ACTOR);
    const set = dbMocks.updateSetArgs[0]!;
    expect(set.currencyCode).toBe('USD');
    expect(set.ticketId).toBe('t-1');
    expect(set.orgId).toBe('o-1');
    expect(dbMocks.selectResults).toHaveLength(0);
    expect(dbMocks.forUpdateCalls).toBe(3); // org SHARE barrier, ticket lock, then entry lock
  });

  it('(f) relinking a stamped entry to an org in another currency rejects CURRENCY_MISMATCH 409', async () => {
    queueLink('USD');
    dbMocks.selectResults.push([stamped]); // EUR entry
    await expect(updateTimeEntry('te-1', { ticketId: 't-1' }, ACTOR))
      .rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', status: 409 });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });

  it('(g) detach leaves the snapshot untouched', async () => {
    dbMocks.selectResults.push([stamped]);
    dbMocks.updateResult = [stamped];
    await updateTimeEntry('te-1', { ticketId: null }, ACTOR);
    const set = dbMocks.updateSetArgs[0]!;
    expect(set).not.toHaveProperty('currencyCode');
    expect(set.ticketId).toBeNull();
    expect(dbMocks.forUpdateCalls).toBe(1);
  });

  it('(h) addTicketPart stamps the org currency under the ticket lock', async () => {
    queueLink('EUR');
    dbMocks.insertResult = [{ id: 'part-1' }];
    await addTicketPart('t-1', { description: 'SSD', quantity: 1, unitPrice: 120 }, ACTOR);
    expect(dbMocks.insertedValues[0]!.currencyCode).toBe('EUR');
    expect(dbMocks.forUpdateCalls).toBe(2); // org FOR SHARE barrier, then ticket FOR UPDATE (#3778)
  });

  it('(i) a part price edit never touches currencyCode and reads the part FOR UPDATE', async () => {
    dbMocks.selectResults.push([{ id: 'part-1', billingStatus: 'not_billed', currencyCode: 'EUR' }]);
    dbMocks.updateResult = [{ id: 'part-1' }];
    await updateTicketPart('part-1', { unitPrice: 5 }, ACTOR);
    expect(dbMocks.updateSetArgs[0]!).not.toHaveProperty('currencyCode');
    expect(dbMocks.updateSetArgs[0]!.unitPrice).toBe('5.00');
    expect(dbMocks.forUpdateCalls).toBe(1);
  });

  it('(j) monetary edit of a billed entry rejects ENTRY_BILLED 409 without updating', async () => {
    dbMocks.selectResults.push([{ ...stamped, billingStatus: 'billed' }]);
    await expect(updateTimeEntry('te-1', { hourlyRate: 200 }, ACTOR))
      .rejects.toMatchObject({ code: 'ENTRY_BILLED', status: 409 });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });

  it('(j2) description-only edit of a billed entry still goes through', async () => {
    dbMocks.selectResults.push([{ ...stamped, billingStatus: 'billed' }]);
    dbMocks.updateResult = [{ ...stamped, description: 'x' }];
    await updateTimeEntry('te-1', { description: 'x' }, ACTOR);
    expect(dbMocks.updateSetArgs).toHaveLength(1);
    expect(dbMocks.updateSetArgs[0]!.description).toBe('x');
  });

  it('(k) quantity edit of a billed part rejects PART_BILLED 409', async () => {
    dbMocks.selectResults.push([{ id: 'part-1', billingStatus: 'billed', currencyCode: 'EUR' }]);
    await expect(updateTicketPart('part-1', { quantity: 3 }, ACTOR))
      .rejects.toMatchObject({ code: 'PART_BILLED', status: 409 });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });
});

// Wave-6 release gate (W6-G4-2 / W6-G4-3): money persisted on a time entry or a
// ticket part must be representable in that row's OWN currency snapshot — a JPY
// org cannot end up holding a fractional-yen rate or part price.
describe('timeEntryService currency representability guard (W6-G4-2 / W6-G4-3)', () => {
  const queueJpyLink = (currencyCode = 'JPY') => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode }]);
    dbMocks.selectResults.push([{ currencyCode }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // lock row
  };
  const span = { startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T10:00:00Z') };

  it('createTimeEntry rejects a fractional hourly rate under a JPY ticket org', async () => {
    queueJpyLink();
    await expect(createTimeEntry({ ticketId: 't-1', ...span, hourlyRate: 100.5 }, ACTOR))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('createTimeEntry accepts a whole-unit rate under a JPY ticket org', async () => {
    queueJpyLink();
    dbMocks.insertResult = [{ id: 'te-1' }];
    await createTimeEntry({ ticketId: 't-1', ...span, hourlyRate: 100 }, ACTOR);
    expect(dbMocks.insertedValues[0]!.hourlyRate).toBe('100.00');
    expect(dbMocks.insertedValues[0]!.currencyCode).toBe('JPY');
  });

  it('createTimeEntry leaves a 2-decimal currency unchanged — 100.50 EUR is accepted', async () => {
    queueJpyLink('EUR');
    dbMocks.insertResult = [{ id: 'te-1' }];
    await createTimeEntry({ ticketId: 't-1', ...span, hourlyRate: 100.5 }, ACTOR);
    expect(dbMocks.insertedValues[0]!.hourlyRate).toBe('100.50');
  });

  it('updateTimeEntry rejects a rate edit that is fractional in the entry\'s own snapshot', async () => {
    dbMocks.selectResults.push([{
      id: 'te-1', partnerId: 'p-1', orgId: 'o-1', ticketId: 't-1', userId: 'u-1',
      ...span, durationMinutes: 60, isApproved: false, billingStatus: 'not_billed',
      currencyCode: 'JPY', hourlyRate: '100.00',
    }]);
    await expect(updateTimeEntry('te-1', { hourlyRate: 100.5 }, ACTOR))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });

  it('addTicketPart rejects a fractional unit price under a JPY ticket org', async () => {
    queueJpyLink();
    await expect(addTicketPart('t-1', { description: 'SSD', quantity: 1, unitPrice: 100.5 }, ACTOR))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('addTicketPart rejects a fractional JPY costBasis even when the price is whole', async () => {
    queueJpyLink();
    await expect(addTicketPart('t-1', { description: 'SSD', quantity: 1, unitPrice: 100, costBasis: 40.5 }, ACTOR))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('updateTicketPart rejects a price edit that is fractional in the part\'s own snapshot', async () => {
    dbMocks.selectResults.push([{ id: 'part-1', billingStatus: 'not_billed', currencyCode: 'JPY' }]);
    await expect(updateTicketPart('part-1', { unitPrice: 100.5 }, ACTOR))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });

  it('updateTicketPart accepts a whole-unit JPY price', async () => {
    dbMocks.selectResults.push([{ id: 'part-1', billingStatus: 'not_billed', currencyCode: 'JPY' }]);
    dbMocks.updateResult = [{ id: 'part-1' }];
    await updateTicketPart('part-1', { unitPrice: 100 }, ACTOR);
    expect(dbMocks.updateSetArgs[0]!.unitPrice).toBe('100.00');
  });
});

// ── W06 (#3900): server-stamped provenance ──────────────────────────────────
describe('provenance (W06 #3900)', () => {
  const auditActor = () => ({ ...ACTOR, recordAuditMutation: vi.fn() });

  it('POST-path createTimeEntry stamps source=manual by default', async () => {
    const actor = auditActor();
    dbMocks.insertResult = [{ id: 'e1', ticketId: null, durationMinutes: 30, isBillable: false, orgId: null, source: 'manual' }];
    await createTimeEntry({ startedAt: new Date('2026-08-29T09:00:00Z'), endedAt: new Date('2026-08-29T09:30:00Z') }, actor);
    expect(dbMocks.insertedValues[0]).toMatchObject({ source: 'manual' });
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'time_entry.created',
      payload: expect.objectContaining({ source: 'manual' }),
    }));
    expect(actor.recordAuditMutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'time_entry.created', source: 'manual' }));
  });

  it('startTimer stamps source=timer', async () => {
    const actor = auditActor();
    dbMocks.updateResult = [];   // no running entry to auto-stop
    dbMocks.insertResult = [{ id: 'e2', ticketId: null, isBillable: false, orgId: null, source: 'timer' }];
    await startTimer({}, actor);
    expect(dbMocks.insertedValues[0]).toMatchObject({ source: 'timer' });
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'time_entry.created',
      payload: expect.objectContaining({ source: 'timer' }),
    }));
  });

  it('internal provenance stamps remote_session and uses the org link for org/currency', async () => {
    dbMocks.insertResult = [{ id: 'e3', ticketId: null, durationMinutes: 38, isBillable: false, orgId: 'o1', source: 'remote_session' }];
    await createTimeEntry(
      { startedAt: new Date('2026-08-29T14:02:00Z'), endedAt: new Date('2026-08-29T14:40:00Z') },
      ACTOR,
      { source: 'remote_session', orgLink: { orgId: 'o1', currencyCode: 'EUR' } }
    );
    expect(dbMocks.insertedValues[0]).toMatchObject({ source: 'remote_session', orgId: 'o1', currencyCode: 'EUR' });
  });

  it('an org-linked create WITH a rate keeps the ORG currency — the partner fallback stays gated (review W06A)', async () => {
    // The confirm path forwards a technician-entered hourlyRate alongside the
    // org link, so this branch is reachable from POST /suggestions/confirm.
    // Queue a partners read returning USD: if the `currencyCode == null` guard
    // on the standalone-money fallback ever regresses, it is consumed and the
    // row lands org_id=<EUR org> with currency_code='USD' — money denominated
    // in a currency that customer never uses, then invoiced.
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // must NOT be consumed
    dbMocks.insertResult = [{ id: 'e6', ticketId: null, durationMinutes: 38, isBillable: false, orgId: 'o1', source: 'remote_session' }];
    await createTimeEntry(
      { startedAt: new Date('2026-08-29T14:02:00Z'), endedAt: new Date('2026-08-29T14:40:00Z'), hourlyRate: 90 },
      ACTOR,
      { source: 'remote_session', orgLink: { orgId: 'o1', currencyCode: 'EUR' } }
    );
    expect(dbMocks.insertedValues[0]).toMatchObject({ orgId: 'o1', currencyCode: 'EUR', hourlyRate: '90.00', source: 'remote_session' });
    expect(dbMocks.selectResults).toHaveLength(1); // getPartnerCurrency was never consulted
  });

  it('support_session provenance with no org link lands org_id NULL and currency NULL (D6)', async () => {
    dbMocks.insertResult = [{ id: 'e4', ticketId: null, durationMinutes: 10, isBillable: false, orgId: null, source: 'support_session' }];
    await createTimeEntry(
      { startedAt: new Date('2026-08-29T14:02:00Z'), endedAt: new Date('2026-08-29T14:12:00Z') },
      ACTOR,
      { source: 'support_session', orgLink: null }
    );
    expect(dbMocks.insertedValues[0]).toMatchObject({ source: 'support_session', orgId: null, currencyCode: null });
  });

  it('a ticket link wins over an org link (the ticket path is the locked, authoritative one)', async () => {
    // Same queue the existing "allows a ticket in a granted org" case uses:
    // ticket, org system read, org SHARE barrier, ticket lock row.
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-ticket', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]);
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]);
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-ticket' }]);
    dbMocks.insertResult = [{ id: 'e5', ticketId: 't-1', durationMinutes: 38, isBillable: false, orgId: 'o-ticket', source: 'remote_session' }];
    await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-08-29T14:02:00Z'), endedAt: new Date('2026-08-29T14:40:00Z') },
      ACTOR,
      { source: 'remote_session', orgLink: { orgId: 'o-session', currencyCode: 'EUR' } }
    );
    // insertedValues[0] is the time entry; [1] is the ticket feed comment.
    expect(dbMocks.insertedValues[0]).toMatchObject({ orgId: 'o-ticket', currencyCode: 'USD', source: 'remote_session' });
  });

  it('readTimeEntryById returns the same camelCase shape as createTimeEntry', async () => {
    dbMocks.selectResults.push([{ id: 'e9', durationMinutes: 38, isBillable: true, orgId: 'o1', source: 'remote_session' }]);
    await expect(readTimeEntryById('e9')).resolves.toMatchObject({ id: 'e9', durationMinutes: 38, source: 'remote_session' });
  });

  it('readTimeEntryById returns null when the row is invisible under RLS', async () => {
    dbMocks.selectResults.push([]);
    await expect(readTimeEntryById('gone')).resolves.toBeNull();
  });
});

describe('resolveAndLockOrgLink (W06 #3900)', () => {
  it('denies an org outside accessibleOrgIds with ORG_DENIED (403)', async () => {
    await expect(resolveAndLockOrgLink('o9', { userId: 'u1', partnerId: 'p-1', manageAll: false, accessibleOrgIds: ['o1'] }))
      .rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
  it('denies an org of another partner with ORG_DENIED', async () => {
    dbMocks.selectResults.push([{ id: 'o2', partnerId: 'p-other' }]);
    await expect(resolveAndLockOrgLink('o2', { userId: 'u1', partnerId: 'p-1', manageAll: false, accessibleOrgIds: null }))
      .rejects.toMatchObject({ code: 'ORG_DENIED' });
  });
  it('denies an org RLS hides entirely (no row) with ORG_DENIED', async () => {
    dbMocks.selectResults.push([]);
    await expect(resolveAndLockOrgLink('o2', { userId: 'u1', partnerId: 'p-1', manageAll: false, accessibleOrgIds: null }))
      .rejects.toMatchObject({ code: 'ORG_DENIED' });
  });
  it('locks the org FOR SHARE and returns its currency', async () => {
    dbMocks.selectResults.push([{ id: 'o1', partnerId: 'p-1' }], [{ currencyCode: 'EUR' }]);
    const before = dbMocks.forUpdateCalls;
    await expect(resolveAndLockOrgLink('o1', { userId: 'u1', partnerId: 'p-1', manageAll: false, accessibleOrgIds: null }))
      .resolves.toEqual({ orgId: 'o1', currencyCode: 'EUR' });
    // The harness counts .for('share') and .for('update') alike.
    expect(dbMocks.forUpdateCalls).toBe(before + 1);
  });
});
