import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { db } from '../db';
import { createTimeEntrySchema, startTimerSchema, updateTimeEntrySchema } from '@breeze/shared';

const { dbMocks, emitMock, workTypeMocks, cardMocks, sentryMocks } = vi.hoisted(() => {
  const dbMocks = {
    // queue of results for successive db.select()...where()/limit() terminals
    selectResults: [] as unknown[][],
    // Projection objects handed to db.select(), so a test can assert on the
    // SQL fragments a reader builds (COALESCE vs. bare duration_minutes).
    selectArgs: [] as Array<Record<string, unknown> | undefined>,
    insertResult: [] as unknown[],
    // Per-call insert results (shifted before falling back to insertResult) —
    // lets a test give the first timeEntries insert a conflict (empty array via
    // onConflictDoNothing) and the retry a success row.
    insertResultsQueue: [] as unknown[][],
    insertErrors: [] as unknown[],
    updateResult: [] as unknown[],
    // Per-call update rejections (shifted before updateResult is resolved) —
    // lets a test make one UPDATE ... RETURNING raise a postgres error.
    updateErrors: [] as unknown[],
    insertedValues: [] as Record<string, unknown>[],
    updateSetArgs: [] as Record<string, unknown>[],
    whereArgs: [] as unknown[],
    onConflictDoNothingCalls: 0,
    forUpdateCalls: 0,
    deleteError: null as Error | null,
    deleteResult: [] as unknown[],
    deleteCalls: 0,
  };
  type WorkTypeRow = { id: string; partnerId: string; name: string; isActive: boolean };
  const workTypeMocks = {
    getActiveWorkType: vi.fn<(id: string, partnerId: string) => Promise<WorkTypeRow | null>>(
      async (id: string) => ({ id, partnerId: 'p-1', name: 'Remote', isActive: true }),
    ),
  };
  return { dbMocks, emitMock: vi.fn(), workTypeMocks, cardMocks: { loadCardsForOrg: vi.fn() },
    sentryMocks: { captureException: vi.fn() } };
});

vi.mock('./billingProfileService', () => ({ loadCardsForOrg: cardMocks.loadCardsForOrg }));

vi.mock('./timeEntryEvents', () => ({ emitTimeEntryEvent: emitMock }));

// #6463: the drift guard REPORTS through captureException (handleServiceError
// answers the request, so app.onError never sees the error). Mocked so the
// report is assertable; the real one is a no-op without a DSN.
vi.mock('./sentry', () => ({ captureException: sentryMocks.captureException }));

// Work-type existence is a PRE-WRITE gate (see getActiveWorkType): validating
// it through the real service would consume the shared db-mock select queue and
// silently reorder every other fixture in this file, so it is mocked here and
// covered directly in workTypeService.test.ts.
vi.mock('./workTypeService', () => ({
  getActiveWorkType: (id: string, partnerId: string) => workTypeMocks.getActiveWorkType(id, partnerId),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: vi.fn(() => {
        dbMocks.selectArgs.push(projection);
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
        return { where: vi.fn(() => ({ returning: vi.fn(() => {
          const err = dbMocks.updateErrors.shift();
          if (err) return Promise.reject(err);
          return Promise.resolve(dbMocks.updateResult);
        }) })) };
      })
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => {
        dbMocks.deleteCalls += 1;
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
    source: 'source', workTypeId: 'workTypeId',
    billingProfileId: 'billingProfileId', coverage: 'coverage', billingOverridden: 'billingOverridden',
    minimumMinutes: 'minimumMinutes', roundingIncrementMinutes: 'roundingIncrementMinutes',
    billableMinutes: 'billableMinutes',
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
  ticketCategories: { id: 'id', partnerId: 'partnerId', defaultWorkTypeId: 'defaultWorkTypeId' },
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
  deleteTicketPart,
  getTimesheet, getTicketBillingSummary, listBillables, entryOrgAllowed,
  resolveAndLockOrgLink, readTimeEntryById, getTicketTimeEntryDefaults
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
const ACTOR = { userId: 'u-1', name: 'Tess', partnerId: 'p-1', manageAll: false, manageBilling: false, accessibleOrgIds: null as string[] | null };
const ADMIN = { ...ACTOR, userId: 'u-admin', manageAll: true, manageBilling: true };
const BILLING_MANAGER = { ...ACTOR, manageBilling: true };
const mockCard = (baseHourlyRate: string | null = null, currencyCode = 'USD', baseCoverage = 'billable') => ({
  id: 'profile-1', currencyCode, baseCoverage, baseHourlyRate, baseMinimumMinutes: null, roundingIncrementMinutes: null, rules: [],
});

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.selectArgs.length = 0;
  dbMocks.insertedValues.length = 0;
  dbMocks.updateSetArgs.length = 0;
  dbMocks.insertErrors.length = 0;
  dbMocks.updateErrors.length = 0;
  dbMocks.insertResultsQueue.length = 0;
  dbMocks.whereArgs.length = 0;
  dbMocks.insertResult = [];
  dbMocks.updateResult = [];
  dbMocks.onConflictDoNothingCalls = 0;
  dbMocks.forUpdateCalls = 0;
  dbMocks.deleteError = null;
  dbMocks.deleteResult = [];
  dbMocks.deleteCalls = 0;
  emitMock.mockClear();
  cardMocks.loadCardsForOrg.mockReset().mockResolvedValue({ assignedCard: null, partnerDefaultCard: mockCard() });
  workTypeMocks.getActiveWorkType.mockClear();
});

describe('computeDurationMinutes', () => {
  it('floors to whole minutes', () => {
    expect(computeDurationMinutes(new Date('2026-06-11T09:00:00Z'), new Date('2026-06-11T09:30:59Z'))).toBe(30);
    expect(computeDurationMinutes(new Date('2026-06-11T09:00:00Z'), new Date('2026-06-11T09:00:30Z'))).toBe(0);
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

  it('resolves billable + rate from the partner card and denormalizes org_id', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: null, partnerDefaultCard: mockCard('125.00', 'USD', 'billable') });
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
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

  it('match-or-skip: a card in another currency is skipped (billable, no rate)', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'EUR' }]); // org (system read)
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: null, partnerDefaultCard: mockCard('125.00', 'USD', 'billable') });
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
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

  it('a manager can mark work non-billable without retaining money', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: null, partnerDefaultCard: mockCard('125.00', 'USD', 'billable') });
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.insertResult = [{ id: 'te-1' }];
    await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z'), isBillable: false },
      BILLING_MANAGER
    );
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.isBillable).toBe(false);
    expect(vals.hourlyRate).toBeNull();
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

  it('startTimer with ticket uses the assigned org profile', async () => {
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: mockCard('150.00', 'USD', 'billable'), partnerDefaultCard: mockCard() });
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
    dbMocks.selectResults.push([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    dbMocks.selectResults.push([{ id: 't-1', orgId: 'o-1' }]); // ticket lock row (FOR UPDATE)
    dbMocks.updateResult = []; // no running timer to stop
    dbMocks.insertResult = [{ id: 'te-timer', endedAt: null }];
    await startTimer({ ticketId: 't-1' }, ACTOR);
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.isBillable).toBe(true);
    expect(vals.hourlyRate).toBe('150.00');
  });

  it.each([{}, { isBillable: true }])('stopTimer errors with NO_RUNNING_TIMER for %j when nothing is running', async input => {
    dbMocks.updateResult = []; // CAS update matched no rows
    await expect(stopTimer(input, ACTOR)).rejects.toMatchObject({ code: 'NO_RUNNING_TIMER', status: 404 });
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
  it.each(['not_billed', 'no_charge', 'contract'] as const)(
    'owner deletes an own unapproved %s entry and emits its userId',
    async (billingStatus) => {
      dbMocks.selectResults.push([{
        id: 'te-1', userId: 'u-1', isApproved: false, partnerId: 'p-1',
        ticketId: null, billingStatus,
      }]);
      await deleteTimeEntry('te-1', ACTOR);
      expect(dbMocks.deleteCalls).toBe(1);
      expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
        type: 'time_entry.deleted',
        payload: expect.objectContaining({ userId: 'u-1' })
      }));
    },
  );

  it('409s before delete, feed, audit, or lifecycle event when the locked entry is billed', async () => {
    const recordAuditMutation = vi.fn();
    dbMocks.selectResults.push([{
      id: 'te-billed', orgId: 'o-1', userId: 'u-1', isApproved: false,
      partnerId: 'p-1', ticketId: 't-1', durationMinutes: 30,
      billingStatus: 'billed',
    }]);

    await expect(deleteTimeEntry('te-billed', { ...ACTOR, recordAuditMutation }))
      .rejects.toMatchObject({ code: 'ENTRY_BILLED', status: 409 });

    expect(dbMocks.deleteCalls).toBe(0);
    expect(dbMocks.insertedValues).toHaveLength(0);
    expect(recordAuditMutation).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
    expect(dbMocks.forUpdateCalls).toBe(1);
  });
});

describe('deleteTicketPart', () => {
  it('409s before delete when the locked part is billed', async () => {
    dbMocks.selectResults.push([{
      id: 'part-billed', billingStatus: 'billed', currencyCode: 'USD',
    }]);

    await expect(deleteTicketPart('part-billed', ACTOR))
      .rejects.toMatchObject({ code: 'PART_BILLED', status: 409 });

    expect(dbMocks.deleteCalls).toBe(0);
    expect(dbMocks.forUpdateCalls).toBe(1);
  });

  it.each(['not_billed', 'no_charge', 'contract'] as const)(
    'allows deletion after locked re-read when status is %s',
    async (billingStatus) => {
      dbMocks.selectResults.push([{
        id: `part-${billingStatus}`, billingStatus, currencyCode: 'USD',
      }]);
      dbMocks.deleteResult = [{ id: `part-${billingStatus}` }];

      await deleteTicketPart(`part-${billingStatus}`, ACTOR);

      expect(dbMocks.deleteCalls).toBe(1);
      expect(dbMocks.forUpdateCalls).toBe(1);
    },
  );

  // #6589 — same zero-row race class as #6568/#6588, on the delete path.
  it('rejects with 409 PART_DELETE_LOST when DELETE RETURNING yields no row, instead of reporting success', async () => {
    dbMocks.selectResults.push([{
      id: 'part-raced', billingStatus: 'not_billed', currencyCode: 'USD',
    }]);
    dbMocks.deleteResult = [];

    await expect(deleteTicketPart('part-raced', ACTOR))
      .rejects.toMatchObject({ status: 409, code: 'PART_DELETE_LOST' });

    expect(dbMocks.deleteCalls).toBe(1);
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

  it('rejects with 409 ENTRY_UPDATE_LOST when UPDATE RETURNING yields no mutated row, instead of echoing the stale row', async () => {
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

    await expect(updateTimeEntry('te-raced', { description: 'lost race' }, update.actor))
      .rejects.toMatchObject({ status: 409, code: 'ENTRY_UPDATE_LOST' });

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
  it('denormalizes org_id and defaults billable from the resolved profile', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]); // org (system read)
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: null, partnerDefaultCard: mockCard(null, 'USD', 'non_billable') });
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
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
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: null, partnerDefaultCard: mockCard(null, 'USD', 'billable') });
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
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

describe('routine billed-state admission', () => {
  const range = {
    startedAt: new Date('2026-06-11T09:00:00Z'),
    endedAt: new Date('2026-06-11T09:30:00Z'),
  };

  it('rejects billed on time-entry creation before any database work', async () => {
    await expect(createTimeEntry(
      { ...range, billingStatus: 'billed' } as never,
      ACTOR,
    )).rejects.toMatchObject({ code: 'BILLING_STATUS_RESERVED', status: 409 });
    expect(dbMocks.insertedValues).toHaveLength(0);
    expect(dbMocks.selectResults).toHaveLength(0);
  });

  it('rejects a direct transition to billed before locking or updating the entry', async () => {
    await expect(updateTimeEntry(
      'te-1',
      { billingStatus: 'billed' } as never,
      ACTOR,
    )).rejects.toMatchObject({ code: 'BILLING_STATUS_RESERVED', status: 409 });
    expect(dbMocks.forUpdateCalls).toBe(0);
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });

  it('rejects billed on part creation before ticket lookup or insert', async () => {
    await expect(addTicketPart(
      't-1',
      { description: 'SSD', quantity: 1, billingStatus: 'billed' } as never,
      ACTOR,
    )).rejects.toMatchObject({ code: 'BILLING_STATUS_RESERVED', status: 409 });
    expect(dbMocks.forUpdateCalls).toBe(0);
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('rejects a direct transition to billed before locking or updating the part', async () => {
    await expect(updateTicketPart(
      'part-1',
      { billingStatus: 'billed' } as never,
      ACTOR,
    )).rejects.toMatchObject({ code: 'BILLING_STATUS_RESERVED', status: 409 });
    expect(dbMocks.forUpdateCalls).toBe(0);
    expect(dbMocks.updateSetArgs).toHaveLength(0);
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
      time: { totalMinutes: 0, billableMinutes: 0, includedMinutes: 0, billableAmounts: [] },
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
    // The corrupt time row (`not_billed`, unresolvable rate) is a missingRate
    // gap, not a fabricated $0.00 line (#6461). The corrupt part row has no
    // such concept (ticket_parts.unit_price is NOT NULL) and keeps its
    // defensive '0.00' fallback.
    expect(result.rows[0]).toMatchObject({ kind: 'time', amount: null, missingRate: true });
    expect(result.rows[1]).toMatchObject({ kind: 'part', amount: '0.00', missingRate: false });
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
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: null, partnerDefaultCard: mockCard('125.00', currencyCode, 'billable') });
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
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
    await createTimeEntry({ ...RANGE, isBillable: true, hourlyRate: 80 }, BILLING_MANAGER);
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
    // Card rate 125.50 stamped JPY: the ordinary create path already
    // rejects this, startTimer must not be the way around it.
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'JPY' }]);
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: null, partnerDefaultCard: mockCard('125.50', 'JPY', 'billable') });
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
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
    durationMinutes: 30, isApproved: false, isBillable: true, billingStatus: 'not_billed', currencyCode: 'EUR', hourlyRate: '100.00'
  };

  it('(d) a rate edit never restamps an already-stamped entry', async () => {
    dbMocks.selectResults.push([stamped]);
    dbMocks.updateResult = [stamped];
    await updateTimeEntry('te-1', { hourlyRate: 200 }, BILLING_MANAGER);
    expect(dbMocks.updateSetArgs[0]!).not.toHaveProperty('currencyCode');
    expect(dbMocks.updateSetArgs[0]!.hourlyRate).toBe('200.00');
    expect(dbMocks.forUpdateCalls).toBe(1); // entry read FOR UPDATE
  });

  it('(d2) first money on a standalone entry stamps the partner currency', async () => {
    dbMocks.selectResults.push([{ ...stamped, orgId: null, ticketId: null, currencyCode: null, hourlyRate: null }]);
    dbMocks.selectResults.push([{ currencyCode: 'CAD' }]); // partners read
    dbMocks.updateResult = [stamped];
    await updateTimeEntry('te-1', { hourlyRate: 90 }, BILLING_MANAGER);
    expect(dbMocks.updateSetArgs[0]!.currencyCode).toBe('CAD');
    expect(dbMocks.selectResults).toHaveLength(0);
  });

  it('(d3) first money sent together with an explicit ticketId: null still stamps the partner currency', async () => {
    // `{ ticketId: null, hourlyRate }` on a moneyless standalone entry ends standalone
    // with money — without the stamp the DB CHECK (currency_required_when_rate) fires.
    dbMocks.selectResults.push([{ ...stamped, orgId: null, ticketId: null, currencyCode: null, hourlyRate: null }]);
    dbMocks.selectResults.push([{ currencyCode: 'CAD' }]); // partners read
    dbMocks.updateResult = [stamped];
    await updateTimeEntry('te-1', { ticketId: null, hourlyRate: 90 }, BILLING_MANAGER);
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
    await expect(updateTimeEntry('te-1', { hourlyRate: 200 }, BILLING_MANAGER))
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

describe('updateTicketPart zero-row race (#6568)', () => {
  it('rejects with 409 PART_UPDATE_LOST when UPDATE RETURNING yields no mutated row, instead of echoing the stale part', async () => {
    dbMocks.selectResults.push([{ id: 'part-1', billingStatus: 'not_billed', currencyCode: 'USD' }]);
    dbMocks.updateResult = [];

    await expect(updateTicketPart('part-1', { description: 'lost race' }, ACTOR))
      .rejects.toMatchObject({ status: 409, code: 'PART_UPDATE_LOST' });
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
    await expect(createTimeEntry({ ticketId: 't-1', ...span, hourlyRate: 100.5 }, BILLING_MANAGER))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('createTimeEntry accepts a whole-unit rate under a JPY ticket org', async () => {
    queueJpyLink();
    dbMocks.insertResult = [{ id: 'te-1' }];
    await createTimeEntry({ ticketId: 't-1', ...span, hourlyRate: 100 }, BILLING_MANAGER);
    expect(dbMocks.insertedValues[0]!.hourlyRate).toBe('100.00');
    expect(dbMocks.insertedValues[0]!.currencyCode).toBe('JPY');
  });

  it('createTimeEntry leaves a 2-decimal currency unchanged — 100.50 EUR is accepted', async () => {
    queueJpyLink('EUR');
    dbMocks.insertResult = [{ id: 'te-1' }];
    await createTimeEntry({ ticketId: 't-1', ...span, hourlyRate: 100.5 }, BILLING_MANAGER);
    expect(dbMocks.insertedValues[0]!.hourlyRate).toBe('100.50');
  });

  it('updateTimeEntry rejects a rate edit that is fractional in the entry\'s own snapshot', async () => {
    dbMocks.selectResults.push([{
      id: 'te-1', partnerId: 'p-1', orgId: 'o-1', ticketId: 't-1', userId: 'u-1',
      ...span, durationMinutes: 60, isApproved: false, billingStatus: 'not_billed',
      currencyCode: 'JPY', hourlyRate: '100.00', isBillable: true,
    }]);
    await expect(updateTimeEntry('te-1', { hourlyRate: 100.5 }, BILLING_MANAGER))
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
      BILLING_MANAGER,
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
    await expect(resolveAndLockOrgLink('o9', { userId: 'u1', partnerId: 'p-1', manageAll: false, manageBilling: false, accessibleOrgIds: ['o1'] }))
      .rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
  it('denies an org of another partner with ORG_DENIED', async () => {
    dbMocks.selectResults.push([{ id: 'o2', partnerId: 'p-other' }]);
    await expect(resolveAndLockOrgLink('o2', { userId: 'u1', partnerId: 'p-1', manageAll: false, manageBilling: false, accessibleOrgIds: null }))
      .rejects.toMatchObject({ code: 'ORG_DENIED' });
  });
  it('denies an org RLS hides entirely (no row) with ORG_DENIED', async () => {
    dbMocks.selectResults.push([]);
    await expect(resolveAndLockOrgLink('o2', { userId: 'u1', partnerId: 'p-1', manageAll: false, manageBilling: false, accessibleOrgIds: null }))
      .rejects.toMatchObject({ code: 'ORG_DENIED' });
  });
  it('locks the org FOR SHARE and returns its currency', async () => {
    dbMocks.selectResults.push([{ id: 'o1', partnerId: 'p-1' }], [{ currencyCode: 'EUR' }]);
    const before = dbMocks.forUpdateCalls;
    await expect(resolveAndLockOrgLink('o1', { userId: 'u1', partnerId: 'p-1', manageAll: false, manageBilling: false, accessibleOrgIds: null }))
      .resolves.toEqual({ orgId: 'o1', currencyCode: 'EUR' });
    // The harness counts .for('share') and .for('update') alike.
    expect(dbMocks.forUpdateCalls).toBe(before + 1);
  });
});

// #5321: the ticket quick-add ("Log time") had no rate field and no way to see
// what the server WOULD stamp, so a billable entry could be created with a NULL
// rate and only fail much later at invoice assembly (ALL_MISSING_RATE 409).
// These defaults are what the quick-add prefills and warns from.
describe('getTicketTimeEntryDefaults (#5321)', () => {
  const ACTOR_D = {
    userId: 'u-1', name: 'Tech', email: 't@example.com', partnerId: 'p-1',
    accessibleOrgIds: null as string[] | null, manageAll: false, manageBilling: false,
  };

  beforeEach(() => {
    dbMocks.selectResults = [];
  });

  it('returns the assigned profile rate, org currency and billable default', async () => {
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: mockCard('150.00', 'USD', 'billable'), partnerDefaultCard: mockCard() });
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]);
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
    await expect(getTicketTimeEntryDefaults('t-1', ACTOR_D)).resolves.toMatchObject({
      hourlyRate: '150.00', currencyCode: 'USD', isBillable: true,
    });
  });

  it('reports hourlyRate null when nothing upstream carries a rate in the org currency', async () => {
    // Assigned card is CAD, org bills in USD and the USD default has no rate. This is exactly the state that made
    // "Create invoice" 409 for every quick-added entry.
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: mockCard('150.00', 'CAD', 'billable'), partnerDefaultCard: mockCard() });
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]);
    dbMocks.selectResults.push([{ defaultWorkTypeId: null }]);
    await expect(getTicketTimeEntryDefaults('t-1', ACTOR_D)).resolves.toMatchObject({
      hourlyRate: null, currencyCode: 'USD', isBillable: true,
    });
  });

  it('refuses a ticket outside the caller org allowlist', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-OTHER', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }]);
    await expect(getTicketTimeEntryDefaults('t-1', { ...ACTOR_D, accessibleOrgIds: ['o-1'] }))
      .rejects.toMatchObject({ status: 404, code: 'TICKET_ORG_DENIED' });
  });
});

describe('workTypeId stamping', () => {
  const callerWorkType = '11111111-1111-4111-8111-111111111111';
  const categoryWorkType = '22222222-2222-4222-8222-222222222222';
  const span = {
    startedAt: new Date('2026-06-11T09:00:00Z'),
    endedAt: new Date('2026-06-11T09:30:00Z'),
  };

  describe.each(['create', 'start'] as const)('%s', (operation) => {
    it.each([
      { name: 'explicit work type wins over category', ticket: true, input: { workTypeId: callerWorkType }, expected: callerWorkType },
      { name: 'omission uses category default', ticket: true, input: {}, expected: categoryWorkType },
      { name: 'explicit null clears category default', ticket: true, input: { workTypeId: null }, expected: null },
      { name: 'standalone omission stays null', ticket: false, input: {}, expected: null },
      { name: 'standalone explicit work type is retained', ticket: false, input: { workTypeId: callerWorkType }, expected: callerWorkType },
    ])('$name', async ({ ticket, input, expected }) => {
      if (ticket) {
        dbMocks.selectResults.push(
          [{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }],
          [{ partnerId: 'p-1', currencyCode: 'USD' }],
          [{ defaultWorkTypeId: categoryWorkType, defaultWorkTypeIsActive: true }],
          [{ currencyCode: 'USD' }],
          [{ id: 't-1', orgId: 'o-1' }],
        );
      }
      dbMocks.insertResult = [{ id: 'te-1', workTypeId: expected }];
      const recordAuditMutation = vi.fn();
      const actor = { ...ACTOR, recordAuditMutation };
      const body = { ...input, ...(ticket ? { ticketId: 't-1' } : {}) };
      if (operation === 'create') await createTimeEntry({ ...span, ...body }, actor);
      else await startTimer(body, actor);

      expect(dbMocks.insertedValues[0]).toMatchObject({ workTypeId: expected });
      expect(dbMocks.selectResults).toHaveLength(0);
      expect(recordAuditMutation).toHaveBeenCalledWith(expect.objectContaining({ workTypeId: expected }));
    });
  });

  it.each(['not_billed'])('updates and clears work types on %s entries with audit tracking', async (billingStatus) => {
    for (const workTypeId of [callerWorkType, null]) {
      const entry = { id: 'te-1', partnerId: 'p-1', orgId: null, ticketId: null, userId: ACTOR.userId,
        ...span, isApproved: false, billingStatus, workTypeId: categoryWorkType };
      dbMocks.selectResults.push([entry]);
      dbMocks.updateResult = [{ ...entry, workTypeId }];
      const recordAuditMutation = vi.fn();
      await updateTimeEntry('te-1', { workTypeId }, { ...ACTOR, recordAuditMutation });
      expect(dbMocks.updateSetArgs.at(-1)).toMatchObject({ workTypeId, isApproved: false });
      expect(emitMock).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { changed: expect.arrayContaining(['workTypeId']) } }));
      expect(recordAuditMutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'time_entry.updated', workTypeId }));
    }
  });

  it.each([
    { name: 'create', schema: createTimeEntrySchema, body: span },
    { name: 'start', schema: startTimerSchema, body: {} },
    { name: 'update', schema: updateTimeEntrySchema, body: { description: 'edited' } },
  ])('$name schema preserves work type and validates UUIDs', ({ schema, body }) => {
    for (const workTypeId of [callerWorkType, null]) {
      expect(schema.parse({ ...body, workTypeId })).toHaveProperty('workTypeId', workTypeId);
    }
    expect(schema.parse(body)).not.toHaveProperty('workTypeId');
    expect(schema.safeParse({ ...body, workTypeId: 'invalid' }).success).toBe(false);
  });
});

it('timesheet selects billing stamps and the archived-capable work type label', async () => {
  vi.mocked(db.select).mockClear();
  dbMocks.selectResults = [[]];
  await getTimesheet('u-1', new Date('2026-06-08T00:00:00Z'));
  expect(db.select).toHaveBeenCalledWith(expect.objectContaining({
    workTypeId: 'workTypeId',
    billingProfileId: 'billingProfileId', coverage: 'coverage', billingOverridden: 'billingOverridden',
    minimumMinutes: 'minimumMinutes', roundingIncrementMinutes: 'roundingIncrementMinutes',
    workType: expect.anything(),
  }));
});

describe('workTypeId validation (finding 1: unvalidated id -> composite FK 23503 -> raw 500)', () => {
  const unknownWorkType = '99999999-9999-4999-8999-999999999999';
  const span = {
    startedAt: new Date('2026-06-11T09:00:00Z'),
    endedAt: new Date('2026-06-11T09:30:00Z'),
  };

  beforeEach(() => {
    workTypeMocks.getActiveWorkType.mockReset();
    // Default across this file: any supplied id resolves. Each case below
    // overrides it to return null (unknown id, ARCHIVED row, or other partner --
    // getActiveWorkType collapses all three to the same miss).
    workTypeMocks.getActiveWorkType.mockImplementation(async (id: string) => ({ id, partnerId: 'p-1', name: 'Remote', isActive: true }));
  });

  it('createTimeEntry rejects an unusable work type with 400 WORK_TYPE_NOT_FOUND', async () => {
    workTypeMocks.getActiveWorkType.mockResolvedValue(null);
    dbMocks.insertResult = [{ id: 'te-1' }];
    await expect(createTimeEntry({ ...span, workTypeId: unknownWorkType }, ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'WORK_TYPE_NOT_FOUND' });
    // The insert must never have been attempted: a 23503 would have aborted the
    // request transaction and this 400 would be unreachable.
    expect(dbMocks.insertedValues).toHaveLength(0);
    expect(workTypeMocks.getActiveWorkType).toHaveBeenCalledWith(unknownWorkType, 'p-1');
  });

  it('startTimer rejects an unusable work type with 400 WORK_TYPE_NOT_FOUND', async () => {
    workTypeMocks.getActiveWorkType.mockResolvedValue(null);
    await expect(startTimer({ workTypeId: unknownWorkType }, ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'WORK_TYPE_NOT_FOUND' });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('updateTimeEntry rejects an unusable work type with 400 WORK_TYPE_NOT_FOUND', async () => {
    workTypeMocks.getActiveWorkType.mockResolvedValue(null);
    dbMocks.selectResults.push([{ id: 'te-1', partnerId: 'p-1', orgId: null, ticketId: null,
      userId: ACTOR.userId, ...span, isApproved: false, billingStatus: 'not_billed', workTypeId: null }]);
    await expect(updateTimeEntry('te-1', { workTypeId: unknownWorkType }, ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'WORK_TYPE_NOT_FOUND' });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });

  it('CONTROL: an explicit NULL work type is never looked up (clearing must not 400)', async () => {
    workTypeMocks.getActiveWorkType.mockResolvedValue(null);
    dbMocks.insertResult = [{ id: 'te-1', workTypeId: null }];
    await createTimeEntry({ ...span, workTypeId: null }, ACTOR);
    expect(workTypeMocks.getActiveWorkType).not.toHaveBeenCalled();
    expect(dbMocks.insertedValues[0]).toMatchObject({ workTypeId: null });
  });

  it('CONTROL: the server-side CATEGORY default is not re-validated (retired categories keep supplying it)', async () => {
    workTypeMocks.getActiveWorkType.mockResolvedValue(null);
    const categoryWorkType = '22222222-2222-4222-8222-222222222222';
    dbMocks.selectResults.push(
      [{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }],
      [{ partnerId: 'p-1', currencyCode: 'USD' }],
      [{ defaultWorkTypeId: categoryWorkType, defaultWorkTypeIsActive: true }],
      [{ currencyCode: 'USD' }],
      [{ id: 't-1', orgId: 'o-1' }],
    );
    dbMocks.insertResult = [{ id: 'te-1', workTypeId: categoryWorkType }];
    await createTimeEntry({ ...span, ticketId: 't-1' }, ACTOR);
    expect(workTypeMocks.getActiveWorkType).not.toHaveBeenCalled();
    expect(dbMocks.insertedValues[0]).toMatchObject({ workTypeId: categoryWorkType });
  });
});

describe('category defaults retain converted inactive work types', () => {
  const categoryWorkType = '22222222-2222-4222-8222-222222222222';
  const span = {
    startedAt: new Date('2026-06-11T09:00:00Z'),
    endedAt: new Date('2026-06-11T09:30:00Z'),
  };

  const seedTicket = (defaultWorkTypeIsActive: boolean | null) => dbMocks.selectResults.push(
    [{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }],
    [{ partnerId: 'p-1', currencyCode: 'USD' }],
    [{ defaultWorkTypeId: categoryWorkType, defaultWorkTypeIsActive }],
    [{ currencyCode: 'USD' }],
    [{ id: 't-1', orgId: 'o-1' }],
  );

  it('CONTROL: an ACTIVE category default is still stamped', async () => {
    seedTicket(true);
    dbMocks.insertResult = [{ id: 'te-1', workTypeId: categoryWorkType }];
    await createTimeEntry({ ...span, ticketId: 't-1' }, ACTOR);
    expect(dbMocks.insertedValues[0]).toMatchObject({ workTypeId: categoryWorkType });
  });

  it('an INACTIVE category default remains the server default', async () => {
    seedTicket(false);
    dbMocks.insertResult = [{ id: 'te-1', workTypeId: categoryWorkType }];
    await createTimeEntry({ ...span, ticketId: 't-1' }, ACTOR);
    expect(dbMocks.insertedValues[0]).toMatchObject({ workTypeId: categoryWorkType });
  });

  it('a category with NO default work type stamps null', async () => {
    dbMocks.selectResults.push(
      [{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }],
      [{ partnerId: 'p-1', currencyCode: 'USD' }],
      [{ defaultWorkTypeId: null, defaultWorkTypeIsActive: null }],
      [{ currencyCode: 'USD' }],
      [{ id: 't-1', orgId: 'o-1' }],
    );
    dbMocks.insertResult = [{ id: 'te-1', workTypeId: null }];
    await createTimeEntry({ ...span, ticketId: 't-1' }, ACTOR);
    expect(dbMocks.insertedValues[0]).toMatchObject({ workTypeId: null });
  });
});

describe('billing profile stamps and service override gate', () => {
  const span = { startedAt: new Date('2026-09-19T09:00:00Z'), endedAt: new Date('2026-09-19T10:00:00Z') };
  const tech = { ...ACTOR, manageBilling: false };
  const manager = { ...tech, manageBilling: true };
  const card = { id: 'profile-1', currencyCode: 'USD', baseCoverage: 'billable', baseHourlyRate: '225.00',
    baseMinimumMinutes: 30, roundingIncrementMinutes: 15, rules: [
      { workTypeId: 'retired', coverage: 'billable', hourlyRate: '175.00', minimumMinutes: 60 },
      { workTypeId: 'included', coverage: 'included', hourlyRate: null, minimumMinutes: null },
      { workTypeId: 'internal', coverage: 'non_billable', hourlyRate: null, minimumMinutes: null },
    ] };
  const seedLink = (defaultWorkTypeId: string | null = null, ticketId = 't-1', orgId = 'o-1') => {
    dbMocks.selectResults.push(
      [{ id: ticketId, partnerId: 'p-1', orgId, categoryId: 'cat-1' }],
      [{ partnerId: 'p-1', currencyCode: 'USD' }],
      [{ defaultWorkTypeId, defaultWorkTypeIsActive: false }],
      [{ currencyCode: 'USD' }], [{ id: ticketId, orgId }],
    );
  };
  const entry = { id: 'te-1', partnerId: 'p-1', orgId: 'o-1', ticketId: 't-1', userId: ACTOR.userId,
    ...span, isApproved: false, currencyCode: 'USD', workTypeId: null, billingProfileId: 'old-profile',
    coverage: 'billable', isBillable: true, hourlyRate: '100.00', minimumMinutes: null,
    roundingIncrementMinutes: null, billingStatus: 'not_billed', billingOverridden: false };
  beforeEach(() => {
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: card, partnerDefaultCard: null });
    dbMocks.insertResult = [{ id: 'te-1' }];
    workTypeMocks.getActiveWorkType.mockImplementation(async id => ({ id, partnerId: 'p-1', name: id, isActive: true }));
  });
  it.each(['create', 'timer'])('%s stamps the whole resolved rule and currency', async mode => {
    seedLink();
    if (mode === 'create') await createTimeEntry({ ticketId: 't-1', ...span }, tech);
    else await startTimer({ ticketId: 't-1' }, tech);
    expect(dbMocks.insertedValues[0]).toMatchObject({ billingProfileId: 'profile-1', coverage: 'billable',
      hourlyRate: '225.00', minimumMinutes: 30, roundingIncrementMinutes: 15, workTypeId: null,
      currencyCode: 'USD', isBillable: true, billingStatus: 'not_billed', billingOverridden: false });
  });
  it('omitted workTypeId prices by an INACTIVE category default', async () => {
    seedLink('retired');
    workTypeMocks.getActiveWorkType.mockResolvedValue(null);
    await createTimeEntry({ ticketId: 't-1', ...span }, tech);
    expect(dbMocks.insertedValues[0]).toMatchObject({ workTypeId: 'retired', hourlyRate: '175.00', minimumMinutes: 60 });
    expect(workTypeMocks.getActiveWorkType).not.toHaveBeenCalled();
  });
  it('explicitly picking that inactive type is rejected before writing', async () => {
    seedLink('retired');
    workTypeMocks.getActiveWorkType.mockResolvedValue(null);
    await expect(createTimeEntry({ ticketId: 't-1', workTypeId: 'retired', ...span }, tech))
      .rejects.toMatchObject({ status: 400, code: 'WORK_TYPE_NOT_FOUND' });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });
  it.each(['included', 'internal'])('%s has no money or minimum', async workTypeId => {
    seedLink();
    await createTimeEntry({ ticketId: 't-1', workTypeId, ...span }, tech);
    expect(dbMocks.insertedValues[0]).toMatchObject({ coverage: workTypeId === 'included' ? 'included' : 'non_billable',
      hourlyRate: null, minimumMinutes: null, isBillable: workTypeId === 'included',
      billingStatus: workTypeId === 'included' ? 'contract' : 'not_billed' });
  });
  it('org-linked suggestions resolve even without a ticket', async () => {
    await createTimeEntry(span, tech, { source: 'remote_session', orgLink: { orgId: 'o-1', currencyCode: 'USD' } });
    expect(cardMocks.loadCardsForOrg).toHaveBeenCalledWith('o-1', 'p-1', 'USD');
    expect(dbMocks.insertedValues[0]).toMatchObject({ hourlyRate: '225.00', billingProfileId: 'profile-1' });
  });
  it.each([{ hourlyRate: 230 }, { minimumMinutes: 60 }, { billingStatus: 'contract' as const }])('rejects off-card %j without permission', async override => {
    seedLink();
    await expect(createTimeEntry({ ticketId: 't-1', ...span, ...override }, tech)).rejects.toMatchObject({ status: 403 });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });
  it('numeric echo is allowed without marking an override', async () => {
    seedLink();
    await createTimeEntry({ ticketId: 't-1', ...span, hourlyRate: 225, minimumMinutes: 30 }, tech);
    expect(dbMocks.insertedValues[0]).toMatchObject({ hourlyRate: '225.00', billingOverridden: false });
  });
  it('a billing manager can override and it is marked', async () => {
    seedLink();
    await createTimeEntry({ ticketId: 't-1', ...span, hourlyRate: 230 }, manager);
    expect(dbMocks.insertedValues[0]).toMatchObject({ hourlyRate: '230.00', billingOverridden: true });
  });
  it('isBillable overrides require billing permission on create', async () => {
    seedLink();
    await expect(createTimeEntry({ ticketId: 't-1', ...span, isBillable: false }, tech))
      .rejects.toMatchObject({ status: 403, code: 'MANAGE_BILLING_REQUIRED' });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });
  it('changing work type re-prices an unbilled entry and clears approval', async () => {
    dbMocks.selectResults.push([entry]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { workTypeId: 'included' }, tech);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ workTypeId: 'included', billingProfileId: 'profile-1',
      coverage: 'included', hourlyRate: null, billingStatus: 'contract', isApproved: false, approvedBy: null, approvedAt: null });
  });
  it('relink prices the new org card and applies its category default', async () => {
    seedLink('retired', 't-2', 'o-2');
    dbMocks.selectResults.push([entry]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { ticketId: 't-2' }, tech);
    expect(cardMocks.loadCardsForOrg).toHaveBeenCalledWith('o-2', 'p-1', 'USD');
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ ticketId: 't-2', orgId: 'o-2', hourlyRate: '175.00', workTypeId: 'retired' });
  });
  it('an overridden entry retains its terms on a work type edit', async () => {
    dbMocks.selectResults.push([{ ...entry, billingOverridden: true }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { workTypeId: 'included' }, tech);
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('hourlyRate');
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('coverage');
  });
  it('ordinary edits never load current cards or rewrite stamps', async () => {
    dbMocks.selectResults.push([entry]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { description: 'Corrected' }, tech);
    expect(cardMocks.loadCardsForOrg).not.toHaveBeenCalled();
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('hourlyRate');
  });
  it('reset requires billing permission', async () => {
    dbMocks.selectResults.push([{ ...entry, billingOverridden: true }]);
    await expect(updateTimeEntry('te-1', { resetBilling: true }, tech)).rejects.toMatchObject({ status: 403 });
  });
  it('reset replaces all stamps and clears the override', async () => {
    dbMocks.selectResults.push([{ ...entry, billingOverridden: true }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { resetBilling: true }, manager);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ hourlyRate: '225.00', minimumMinutes: 30,
      roundingIncrementMinutes: 15, billingProfileId: 'profile-1', billingOverridden: false });
  });
  it.each([{ hourlyRate: 230 }, { minimumMinutes: 60 }, { billingStatus: 'contract' as const }])('update rejects off-stamp %j without permission', async override => {
    dbMocks.selectResults.push([entry]);
    await expect(updateTimeEntry('te-1', override, tech)).rejects.toMatchObject({ status: 403, code: 'MANAGE_BILLING_REQUIRED' });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });
  it('echoes the existing stamp after a card edit without re-pricing', async () => {
    dbMocks.selectResults.push([entry]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { hourlyRate: 100 }, tech);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ hourlyRate: '100.00', billingOverridden: false });
    expect(cardMocks.loadCardsForOrg).not.toHaveBeenCalled();
  });
  it.each(['create', 'update'] as const)('%s normalizes a contract-only override to included with no money', async mode => {
    if (mode === 'create') {
      seedLink();
      await createTimeEntry({ ticketId: 't-1', ...span, billingStatus: 'contract' }, manager);
    } else {
      dbMocks.selectResults.push([{ ...entry, minimumMinutes: 30 }]);
      dbMocks.updateResult = [entry];
      await updateTimeEntry('te-1', { billingStatus: 'contract' }, manager);
    }
    const stamp = mode === 'create' ? dbMocks.insertedValues[0] : dbMocks.updateSetArgs[0];
    expect(stamp).toMatchObject({ coverage: 'included', billingStatus: 'contract',
      hourlyRate: null, minimumMinutes: null, isBillable: true, billingOverridden: true });
  });
  it('a manager bills formerly included work by marking it out of scope', async () => {
    dbMocks.selectResults.push([{ ...entry, coverage: 'included', hourlyRate: null, billingStatus: 'contract' }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { hourlyRate: 300 }, manager);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ hourlyRate: '300.00', billingStatus: 'not_billed',
      coverage: 'billable', billingOverridden: true });
  });
  it.each([null, '50.00', '75.00'])('persists an explicit standalone rate over %s and marks it billable', async hourlyRate => {
    dbMocks.selectResults.push([{ ...entry, orgId: null, ticketId: null, billingProfileId: null,
      coverage: 'non_billable', isBillable: false, hourlyRate }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { hourlyRate: 75 }, manager);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ hourlyRate: '75.00', coverage: 'billable',
      isBillable: true, billingStatus: 'not_billed', billingOverridden: true });
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('currencyCode');
    expect(cardMocks.loadCardsForOrg).not.toHaveBeenCalled();
  });
  it('rejects explicit money together with non-billable instead of dropping the rate', async () => {
    dbMocks.selectResults.push([{ ...entry, orgId: null, ticketId: null, isBillable: false, hourlyRate: null }]);
    await expect(updateTimeEntry('te-1', { hourlyRate: 75, isBillable: false }, manager))
      .rejects.toMatchObject({ status: 400, code: 'RATE_REQUIRES_BILLABLE' });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });
  it.each([
    { mode: 'stop', isBillable: true }, { mode: 'stop', isBillable: false },
    { mode: 'update', isBillable: true }, { mode: 'update', isBillable: false },
  ])('$mode forbids a technician override from billable=$isBillable before writing', async ({ mode, isBillable }) => {
    dbMocks.selectResults.push([{ ...entry, endedAt: null, isBillable,
      coverage: isBillable ? 'billable' : 'non_billable' }]);
    const operation = mode === 'stop' ? stopTimer({ isBillable: !isBillable }, tech)
      : updateTimeEntry('te-1', { endedAt: span.endedAt, isBillable: !isBillable }, tech);
    await expect(operation).rejects.toMatchObject({ status: 403, code: 'MANAGE_BILLING_REQUIRED' });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });
  it.each([
    { coverage: 'billable', isBillable: true, hourlyRate: '100.00', next: false },
    { coverage: 'included', isBillable: true, hourlyRate: null, next: false },
    { coverage: 'non_billable', isBillable: false, hourlyRate: null, next: true },
  ])('timer stop reconciles a manager override from $coverage', async row => {
    dbMocks.selectResults.push([{ ...entry, ...row, endedAt: null,
      billingStatus: row.coverage === 'included' ? 'contract' : 'not_billed' }]);
    dbMocks.updateResult = [entry];
    await stopTimer({ isBillable: row.next }, manager);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ isBillable: row.next,
      coverage: row.next ? 'billable' : 'non_billable', billingOverridden: true,
      billingStatus: 'not_billed', hourlyRate: null, minimumMinutes: null,
      endedAt: expect.any(Date) });
    expect(cardMocks.loadCardsForOrg).not.toHaveBeenCalled();
    expect(dbMocks.forUpdateCalls).toBe(1);
  });
  it('timer billable echo preserves included coverage without requiring permission or marking override', async () => {
    dbMocks.selectResults.push([{ ...entry, coverage: 'included', hourlyRate: null, billingStatus: 'contract', endedAt: null }]);
    dbMocks.updateResult = [entry];
    await stopTimer({ isBillable: true }, tech);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ coverage: 'included', isBillable: true,
      billingStatus: 'contract', hourlyRate: null, billingOverridden: false });
  });
  it('timer stop and mobile endedAt replay preserve the start stamp', async () => {
    dbMocks.updateResult = [entry];
    await stopTimer({}, tech);
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('hourlyRate');
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('coverage');
    dbMocks.selectResults.push([entry]);
    await updateTimeEntry('te-1', { endedAt: span.endedAt }, tech);
    expect(dbMocks.updateSetArgs[1]).not.toHaveProperty('hourlyRate');
    expect(dbMocks.updateSetArgs[1]).not.toHaveProperty('coverage');
    expect(cardMocks.loadCardsForOrg).not.toHaveBeenCalled();
  });
  it.each(['workTypeId', 'minimumMinutes', 'resetBilling', 'billingProfileId', 'coverage', 'roundingIncrementMinutes', 'billingOverridden'])('billed entry locks %s even for managers', async field => {
    dbMocks.selectResults.push([{ ...entry, billingStatus: 'billed' }]);
    await expect(updateTimeEntry('te-1', { [field]: field === 'resetBilling' ? true : null }, manager))
      .rejects.toMatchObject({ status: 409, code: 'ENTRY_BILLED' });
  });
});

describe('billable_minutes write paths (#4628 W03)', () => {
  const span = { startedAt: new Date('2026-03-03T09:00:00Z'), endedAt: new Date('2026-03-03T09:20:00Z') };
  const tech = { ...ACTOR, manageBilling: false };
  const card = (baseMinimumMinutes: number | null, roundingIncrementMinutes: number | null) => ({
    id: 'profile-1', currencyCode: 'USD', baseCoverage: 'billable', baseHourlyRate: '225.00',
    baseMinimumMinutes, roundingIncrementMinutes, rules: [],
  });
  const seedLink = (ticketId = 't-1', orgId = 'o-1') => {
    dbMocks.selectResults.push(
      [{ id: ticketId, partnerId: 'p-1', orgId, categoryId: 'cat-1' }],
      [{ partnerId: 'p-1', currencyCode: 'USD' }],
      [{ defaultWorkTypeId: null, defaultWorkTypeIsActive: false }],
      [{ currencyCode: 'USD' }], [{ id: ticketId, orgId }],
    );
  };
  beforeEach(() => { dbMocks.insertResult = [{ id: 'te-1' }]; });

  describe('create and timer start', () => {
    it('createTimeEntry stamps billable_minutes from the resolved minimum and increment', async () => {
      cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: card(60, 15), partnerDefaultCard: null });
      seedLink();
      // 20 worked minutes against a 60-minute minimum bills an hour.
      await createTimeEntry({ ticketId: 't-1', ...span }, tech);
      expect(dbMocks.insertedValues[0]).toMatchObject({ durationMinutes: 20, billableMinutes: 60 });
    });

    it('createTimeEntry rounds up to the card increment when there is no minimum', async () => {
      cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: card(null, 15), partnerDefaultCard: null });
      seedLink();
      await createTimeEntry({ ticketId: 't-1', startedAt: span.startedAt, endedAt: new Date('2026-03-03T09:31:00Z') }, tech);
      expect(dbMocks.insertedValues[0]).toMatchObject({ durationMinutes: 31, billableMinutes: 45 });
    });

    it('createTimeEntry with no card terms stamps billable_minutes equal to the duration', async () => {
      cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: card(null, null), partnerDefaultCard: null });
      seedLink();
      await createTimeEntry({ ticketId: 't-1', startedAt: span.startedAt, endedAt: new Date('2026-03-03T09:37:00Z') }, tech);
      expect(dbMocks.insertedValues[0]).toMatchObject({ durationMinutes: 37, billableMinutes: 37 });
    });

    it('a manager-overridden minimum drives the stamp, not the card minimum', async () => {
      cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: card(30, null), partnerDefaultCard: null });
      seedLink();
      await createTimeEntry({ ticketId: 't-1', ...span, minimumMinutes: 90 }, { ...tech, manageBilling: true });
      expect(dbMocks.insertedValues[0]).toMatchObject({ minimumMinutes: 90, billableMinutes: 90 });
    });

    it('startTimer leaves billable_minutes NULL — an unfinished entry has no billable quantity', async () => {
      cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: card(60, 15), partnerDefaultCard: null });
      seedLink();
      await startTimer({ ticketId: 't-1' }, tech);
      expect(dbMocks.insertedValues[0]!.durationMinutes).toBeNull();
      expect(dbMocks.insertedValues[0]!.billableMinutes).toBeNull();
    });
  });
});

describe('both stop paths land billable_minutes (#4628 W03)', () => {
  const span = { startedAt: new Date('2026-03-03T09:00:00Z'), endedAt: new Date('2026-03-03T09:20:00Z') };
  const tech = { ...ACTOR, manageBilling: false };
  const manager = { ...tech, manageBilling: true };
  const card = { id: 'profile-1', currencyCode: 'USD', baseCoverage: 'billable', baseHourlyRate: '225.00',
    baseMinimumMinutes: 60, roundingIncrementMinutes: 15, rules: [] };
  const entry = { id: 'te-1', partnerId: 'p-1', orgId: 'o-1', ticketId: 't-1', userId: ACTOR.userId,
    startedAt: span.startedAt, endedAt: span.endedAt, durationMinutes: 20, isApproved: false,
    currencyCode: 'USD', workTypeId: null, billingProfileId: 'profile-1', coverage: 'billable',
    isBillable: true, hourlyRate: '225.00', minimumMinutes: 60, roundingIncrementMinutes: 15,
    billingStatus: 'not_billed', billingOverridden: false };

  /** Flatten a drizzle SQL fragment into its literal text chunks. */
  const chunkText = (node: unknown): string => {
    if (node == null || typeof node !== 'object') return '';
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.queryChunks)) return (n.queryChunks as unknown[]).map(chunkText).join('');
    if (Array.isArray(n.value) && (n.value as unknown[]).every((v) => typeof v === 'string')) {
      return (n.value as string[]).join('');
    }
    return '';
  };
  /** Every real column the fragment references, by its SQL name. */
  const columnNames = (node: unknown): string[] => {
    if (node == null || typeof node !== 'object') return [];
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.queryChunks)) return (n.queryChunks as unknown[]).flatMap(columnNames);
    if (typeof n.name === 'string' && n.table !== undefined) return [n.name];
    return [];
  };

  beforeEach(() => { cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: card, partnerDefaultCard: null }); });

  it('stopRunningEntry (CAS) sets billable_minutes in the SAME statement, from an inlined duration expression', async () => {
    dbMocks.updateResult = [entry];
    await stopTimer({}, tech);
    const fragment = dbMocks.updateSetArgs[0]!.billableMinutes;
    const text = chunkText(fragment);
    expect(text).toContain('GREATEST');
    expect(text).toContain('CEIL');
    // The duration expression is INLINED. The CAS assigns duration_minutes in
    // this same UPDATE, so a column reference would read the OLD (NULL) value
    // and the CHECK would reject the row (23514).
    expect(text).toContain('FLOOR(EXTRACT(EPOCH');
    expect(columnNames(fragment)).not.toContain('duration_minutes');
    expect(columnNames(fragment)).toEqual(
      expect.arrayContaining(['minimum_minutes', 'rounding_increment_minutes'])
    );
  });

  it('a stop that OVERRIDES the terms computes from the override, not the stale columns', async () => {
    // The CAS evaluates SET expressions against the OLD row, but the CHECK
    // validates the NEW one. A manager stop that clears the minimum must not
    // leave billable_minutes derived from the minimum it just removed, or the
    // row is rejected with 23514.
    dbMocks.selectResults.push([{ ...entry, endedAt: null, durationMinutes: null }]);
    dbMocks.updateResult = [entry];
    await stopTimer({ isBillable: false }, manager);
    const set = dbMocks.updateSetArgs[0]!;
    expect(set.minimumMinutes).toBeNull();
    expect(set.billableMinutes).toBeDefined();
    expect(columnNames(set.billableMinutes)).not.toContain('minimum_minutes');
  });

  it('updateTimeEntry recomputes billable_minutes whenever it recomputes durationMinutes', async () => {
    dbMocks.selectResults.push([{ ...entry, endedAt: null, durationMinutes: null }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { endedAt: span.endedAt }, tech);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ durationMinutes: 20, billableMinutes: 60 });
  });

  it('updateTimeEntry does NOT touch billable_minutes when neither timestamp nor terms changed', async () => {
    dbMocks.selectResults.push([entry]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { description: 'typo fix' }, tech);
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('billableMinutes');
  });

  it('updateTimeEntry re-derives billable_minutes when a re-price changes the minimum', async () => {
    // Spec §3.7: an entry is re-priced when its own workTypeId changes.
    dbMocks.selectResults.push([{ ...entry, minimumMinutes: null, roundingIncrementMinutes: null }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { workTypeId: 'wt-onsite' }, tech);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ minimumMinutes: 60, billableMinutes: 60 });
  });

  it('a manager raising the minimum re-derives the billed quantity', async () => {
    dbMocks.selectResults.push([entry]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { minimumMinutes: 90 }, manager);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ minimumMinutes: 90, billableMinutes: 90 });
  });

  it('editing ONLY the hourly rate leaves a legacy entry\'s billed quantity alone (#6465)', async () => {
    // Pre-feature row: 3 minutes worked, W02 back-stamped the card's rounding
    // increment, billable_minutes NULL by design. A rate correction must not
    // restamp the invoice quantity 0.05h -> 0.25h behind the technician's back.
    dbMocks.selectResults.push([{
      ...entry, durationMinutes: 3, minimumMinutes: null, billableMinutes: null,
    }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { hourlyRate: 250 }, manager);
    expect(dbMocks.updateSetArgs[0]).toHaveProperty('hourlyRate', '250.00');
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('billableMinutes');
  });

  it('re-sending the SAME minimum is not a term change, so the billed quantity stays put (#6465)', async () => {
    dbMocks.selectResults.push([{ ...entry, durationMinutes: 3, billableMinutes: null }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { minimumMinutes: entry.minimumMinutes, hourlyRate: 250 }, manager);
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('billableMinutes');
  });

  it('clearing the minimum via isBillable:false still re-derives the billed quantity (#6465)', async () => {
    dbMocks.selectResults.push([{ ...entry, durationMinutes: 3 }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { isBillable: false }, manager);
    // 60-minute minimum gone, but the 15-minute increment still rounds 3 up.
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ minimumMinutes: null, billableMinutes: 15 });
  });

  it('a re-price that lands on the SAME terms does not restamp the billed quantity (#6465)', async () => {
    // The reprice branch writes minimumMinutes/roundingIncrementMinutes through
    // Object.assign(set, base) — a different write path from applyBillingInput's
    // spread. The value gate has to hold there too: this card resolves to the
    // terms the row already carries, so nothing should move.
    dbMocks.selectResults.push([{ ...entry, durationMinutes: 3, billableMinutes: null }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { workTypeId: 'wt-onsite' }, tech);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ minimumMinutes: 60, roundingIncrementMinutes: 15 });
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('billableMinutes');
  });

  it('an ALREADY-null minimum going non-billable is not a term change (#6465)', async () => {
    // applyBillingInput nulls the minimum for non-billable work, but it was
    // already null — coverage is not a card term, so the quantity stays put.
    dbMocks.selectResults.push([{
      ...entry, durationMinutes: 3, minimumMinutes: null, roundingIncrementMinutes: null,
    }]);
    dbMocks.updateResult = [entry];
    await updateTimeEntry('te-1', { isBillable: false }, manager);
    expect(dbMocks.updateSetArgs[0]).toMatchObject({ minimumMinutes: null });
    expect(dbMocks.updateSetArgs[0]).not.toHaveProperty('billableMinutes');
  });

  it('a billed entry cannot be re-timed, so its billed quantity can never move', async () => {
    dbMocks.selectResults.push([{ ...entry, billingStatus: 'billed' }]);
    await expect(updateTimeEntry('te-1', { endedAt: new Date('2026-03-03T10:20:00Z') }, manager))
      .rejects.toMatchObject({ code: 'ENTRY_BILLED', status: 409 });
    expect(dbMocks.updateSetArgs).toHaveLength(0);
  });
});

describe('money readers read COALESCE(billable_minutes, duration_minutes) (#4628 W03)', () => {
  const FROM = new Date('2026-03-01T00:00:00Z');
  const TO = new Date('2026-03-31T00:00:00Z');
  const render = (fragment: unknown) => inspect(fragment, { depth: 12 });

  it('getTicketBillingSummary money SQL uses COALESCE, and totalMinutes stays actual', async () => {
    dbMocks.selectResults.push([], [], [], []);
    await getTicketBillingSummary('t-1');
    const aggregates = dbMocks.selectArgs[0] as Record<string, unknown>;
    const money = dbMocks.selectArgs[1] as Record<string, unknown>;
    expect(render(money.amount)).toContain('COALESCE');
    expect(render(money.amount)).toContain('billableMinutes');
    expect(render(aggregates.billableMinutes)).toContain('billableMinutes');
    // Utilization figure — actual minutes, never the billed quantity (§3.5).
    expect(render(aggregates.totalMinutes)).not.toContain('billableMinutes');
    // includedMinutes stays on ACTUAL minutes, matching the portal's
    // coveredByContract bucket. An included row CAN carry the card's rounding
    // increment, so a COALESCE here would move the number, not just tidy it.
    expect(render(aggregates.includedMinutes)).not.toContain('billableMinutes');
  });

  it('getTicketBillingSummary returns includedMinutes for contract-covered entries', async () => {
    dbMocks.selectResults.push([{ totalMinutes: 90, billableMinutes: 60, includedMinutes: 30 }], [], [{ partsCount: 0 }], []);
    const result = await getTicketBillingSummary('t-1');
    expect(result.time.includedMinutes).toBe(30);
  });

  it('an INCLUDED entry adds no money to the ticket summary', async () => {
    // coverage 'included' => billing_status 'contract', hourly_rate NULL, so
    // the hourly_rate IS NOT NULL predicate excludes it from the money query.
    dbMocks.selectResults.push([{ totalMinutes: 45, billableMinutes: 0, includedMinutes: 45 }], [], [{ partsCount: 0 }], []);
    const result = await getTicketBillingSummary('t-1');
    expect(result.time.billableAmounts).toEqual([]);
  });

  const billableRow = (over: Record<string, unknown>) => ({
    date: new Date('2026-03-03T09:00:00Z'), orgName: 'Acme', ticketNumber: 'T-1',
    description: 'On-site', technician: 'Pat', currencyCode: 'USD',
    billingStatus: 'not_billed', isApproved: true, ...over,
  });

  it('listBillables bills the MINIMUM, not the worked minutes', async () => {
    dbMocks.selectResults.push([billableRow({ minutes: 20, billableMinutes: 60, rate: '225.00' })], []);
    const { rows, totalsByCurrency } = await listBillables(FROM, TO);
    expect(rows[0]).toMatchObject({ quantity: '1.00', amount: '225.00' }); // 60 min, not 0.33
    expect(totalsByCurrency).toEqual([{ currencyCode: 'USD', amount: '225.00' }]);
  });

  it('listBillables falls back to duration_minutes on a pre-feature row', async () => {
    dbMocks.selectResults.push([billableRow({ minutes: 30, billableMinutes: null, rate: '100.00' })], []);
    const { rows } = await listBillables(FROM, TO);
    expect(rows[0]).toMatchObject({ quantity: '0.50', amount: '50.00' });
  });

  it('an INCLUDED entry appears in listBillables with no money', async () => {
    dbMocks.selectResults.push([billableRow({
      minutes: 45, billableMinutes: 45, rate: null, billingStatus: 'contract',
    })], []);
    const { rows, totalsByCurrency } = await listBillables(FROM, TO);
    expect(rows[0]).toMatchObject({ quantity: '0.75', amount: '0.00' });
    // Pre-existing behaviour, re-pinned here: a rate-less row still carries its
    // snapshot currency, so the currency appears with a ZERO total. It adds no
    // money, which is the §3.5 property; it is not absent from the list.
    expect(totalsByCurrency).toEqual([{ currencyCode: 'USD', amount: '0.00' }]);
  });

  // #6461: a `not_billed` time entry with no resolvable hourly rate is a genuine
  // assembly gap — the same row invoiceAssembly.partitionTimeEntries would route
  // to `missingRate` rather than throw on — and must never render as a real
  // $0.00 line or feed totalsByCurrency.
  it('a NOT_BILLED entry with no rate is a missingRate gap, not a $0.00 line', async () => {
    dbMocks.selectResults.push([billableRow({
      minutes: 30, billableMinutes: 30, rate: null, billingStatus: 'not_billed',
    })], []);
    const { rows, totalsByCurrency } = await listBillables(FROM, TO);
    expect(rows[0]).toMatchObject({ quantity: '0.50', amount: null, missingRate: true });
    // A gap contributes no money at all — not even a zero entry under its currency.
    expect(totalsByCurrency).toEqual([]);
  });

  it('a NO_CHARGE entry with no rate stays an intentional $0.00 line, not a gap', async () => {
    dbMocks.selectResults.push([billableRow({
      minutes: 30, billableMinutes: 30, rate: null, billingStatus: 'no_charge',
    })], []);
    const { rows, totalsByCurrency } = await listBillables(FROM, TO);
    expect(rows[0]).toMatchObject({ quantity: '0.50', amount: '0.00', missingRate: false });
    expect(totalsByCurrency).toEqual([{ currencyCode: 'USD', amount: '0.00' }]);
  });

  // listBillables (unlike partitionTimeEntries, which only ever sees
  // not_billed rows) sees every billing_status — including rows already
  // marked BILLED. A billed row that has lost/never had a resolvable rate
  // still has no amount to report or sum, so it is a gap too, not '0.00'.
  it('a BILLED entry with no rate is still a missingRate gap, not a $0.00 line', async () => {
    dbMocks.selectResults.push([billableRow({
      minutes: 30, billableMinutes: 30, rate: null, billingStatus: 'billed',
    })], []);
    const { rows, totalsByCurrency } = await listBillables(FROM, TO);
    expect(rows[0]).toMatchObject({ quantity: '0.50', amount: null, missingRate: true });
    expect(totalsByCurrency).toEqual([]);
  });

  it('the timesheet bills the minimum, reporting ACTUAL minutes for totalMinutes and the BILLED quantity for billableMinutes', async () => {
    dbMocks.selectResults.push([{
      id: 'te-1', startedAt: new Date('2026-03-03T09:00:00Z'),
      durationMinutes: 20, billableMinutes: 60,
      isBillable: true, hourlyRate: '225.00', currencyCode: 'USD',
    }]);
    const sheet = await getTimesheet('u-1', new Date('2026-03-02T00:00:00Z'));
    expect(sheet.totals.billableAmounts).toEqual([{ currencyCode: 'USD', amount: '225.00' }]);
    // Utilization is about time WORKED (§3.5).
    expect(sheet.totals.totalMinutes).toBe(20);
    expect(sheet.days[1]!.totalMinutes).toBe(20);
    // billableMinutes is the BILLED quantity (G2-1 fix) — matches the money loop.
    expect(sheet.totals.billableMinutes).toBe(60);
  });

  it('the timesheet selection carries billable_minutes to the client', async () => {
    dbMocks.selectResults.push([]);
    await getTimesheet('u-1', new Date('2026-03-02T00:00:00Z'));
    expect(dbMocks.selectArgs[0]).toHaveProperty('billableMinutes', 'billableMinutes');
  });

  it('an INCLUDED entry adds no money to the timesheet', async () => {
    dbMocks.selectResults.push([{
      id: 'te-1', startedAt: new Date('2026-03-03T09:00:00Z'),
      durationMinutes: 45, billableMinutes: 45,
      isBillable: true, hourlyRate: null, currencyCode: 'USD',
    }]);
    const sheet = await getTimesheet('u-1', new Date('2026-03-02T00:00:00Z'));
    expect(sheet.totals.billableAmounts).toEqual([]);
    expect(sheet.totals.billableMinutes).toBe(45);
  });

  it('the day/week billableMinutes aggregate sums the BILLED quantity, not actual duration (G2-1)', async () => {
    dbMocks.selectResults.push([
      {
        id: 'te-1', startedAt: new Date('2026-03-03T09:00:00Z'),
        durationMinutes: 10, billableMinutes: 30,
        isBillable: true, hourlyRate: null, currencyCode: 'USD',
      },
      {
        id: 'te-2', startedAt: new Date('2026-03-03T11:00:00Z'),
        durationMinutes: 40, billableMinutes: 45,
        isBillable: true, hourlyRate: null, currencyCode: 'USD',
      },
    ]);
    const sheet = await getTimesheet('u-1', new Date('2026-03-02T00:00:00Z'));
    // Utilization stays on actual minutes worked.
    expect(sheet.totals.totalMinutes).toBe(50);
    expect(sheet.days[1]!.totalMinutes).toBe(50);
    // Billed quantity: 30 + 45 = 75, matching the same COALESCE(billable_minutes,
    // duration_minutes) rule the money loop already uses — not 10 + 40 = 50.
    expect(sheet.totals.billableMinutes).toBe(75);
    expect(sheet.days[1]!.billableMinutes).toBe(75);
  });
});

describe('billable_minutes CHECK drift is a typed refusal, not an opaque 500 (#6463)', () => {
  const span = { startedAt: new Date('2026-03-03T09:00:00Z'), endedAt: new Date('2026-03-03T09:20:00Z') };
  const tech = { ...ACTOR, manageBilling: false };
  const card = { id: 'profile-1', currencyCode: 'USD', baseCoverage: 'billable', baseHourlyRate: '225.00',
    baseMinimumMinutes: 60, roundingIncrementMinutes: 15, rules: [] };
  const entry = { id: 'te-1', partnerId: 'p-1', orgId: 'o-1', ticketId: 't-1', userId: ACTOR.userId,
    startedAt: span.startedAt, endedAt: null, durationMinutes: null, isApproved: false,
    currencyCode: 'USD', workTypeId: null, billingProfileId: 'profile-1', coverage: 'billable',
    isBillable: true, hourlyRate: '225.00', minimumMinutes: 60, roundingIncrementMinutes: 15,
    billingStatus: 'not_billed', billingOverridden: false };

  /** The shape postgres.js raises for a CHECK violation. */
  /** The most recent error `checkViolation` handed the db mock. */
  let thrown: Error;
  const checkViolation = (constraint: string) => (thrown = Object.assign(
    new Error(`new row for relation "time_entries" violates check constraint "${constraint}"`),
    { code: '23514', constraint_name: constraint },
  ));
  const DRIFT = 'time_entries_billable_minutes_chk';

  const seedLink = (ticketId = 't-1', orgId = 'o-1') => {
    dbMocks.selectResults.push(
      [{ id: ticketId, partnerId: 'p-1', orgId, categoryId: 'cat-1' }],
      [{ partnerId: 'p-1', currencyCode: 'USD' }],
      [{ defaultWorkTypeId: null, defaultWorkTypeIsActive: false }],
      [{ currencyCode: 'USD' }], [{ id: ticketId, orgId }],
    );
  };

  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    cardMocks.loadCardsForOrg.mockResolvedValue({ assignedCard: card, partnerDefaultCard: null });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sentryMocks.captureException.mockClear();
  });
  afterEach(() => { errorSpy.mockRestore(); });

  it('createTimeEntry maps the drift to BILLABLE_MINUTES_DRIFT instead of leaking the raw 23514', async () => {
    seedLink();
    dbMocks.insertErrors.push(checkViolation(DRIFT));
    await expect(createTimeEntry({ ticketId: 't-1', ...span }, tech))
      .rejects.toMatchObject({ code: 'BILLABLE_MINUTES_DRIFT', status: 422 });
  });

  it('logs the entry context so the drift is diagnosable, not a bare postgres error in Sentry', async () => {
    seedLink();
    dbMocks.insertErrors.push(checkViolation(DRIFT));
    await expect(createTimeEntry({ ticketId: 't-1', ...span }, tech)).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('BILLABLE_MINUTES_DRIFT');
    // The three inputs the two representations disagree about.
    expect(logged).toContain('durationMinutes');
    expect(logged).toContain('minimumMinutes');
    expect(logged).toContain('roundingIncrementMinutes');
    // Tenant + actor identity: the first triage question on a multi-tenant drift.
    expect(logged).toContain(tech.userId);
    // The ORIGINAL error travels with the log — postgres's own message for a
    // CHECK on a computed expression is the most useful fact available.
    expect(errorSpy.mock.calls[0]).toContain(thrown);
  });

  it('REPORTS the drift to Sentry — handleServiceError answers the request, so app.onError never sees it', async () => {
    // Sentry.init installs no captureConsoleIntegration (services/sentry.ts),
    // and handleServiceError returns c.json(...) instead of rethrowing. Without
    // this call a real TS/SQL drift pages nobody.
    seedLink();
    dbMocks.insertErrors.push(checkViolation(DRIFT));
    await expect(createTimeEntry({ ticketId: 't-1', ...span }, tech)).rejects.toThrow();
    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
    const [reported, , tags] = sentryMocks.captureException.mock.calls[0]!;
    expect(reported).toBe(thrown);
    expect(tags).toMatchObject({
      service: 'timeEntryService',
      code: 'BILLABLE_MINUTES_DRIFT',
      op: 'createTimeEntry',
      userId: tech.userId,
    });
  });

  it('does NOT report a 23514 from a different constraint to Sentry', async () => {
    dbMocks.selectResults.push([entry]);
    dbMocks.updateErrors.push(checkViolation('time_entries_currency_required_when_org_chk'));
    await expect(updateTimeEntry('te-1', { endedAt: span.endedAt }, tech)).rejects.toThrow();
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });

  it('tells an updateTimeEntry caller the ENTRY survived — only this edit was refused', async () => {
    // create/stop lose the whole entry; an edit of an already-persisted row does
    // not, and a technician reads the message literally during an escalation.
    dbMocks.selectResults.push([entry]);
    dbMocks.updateErrors.push(checkViolation(DRIFT));
    const err = await updateTimeEntry('te-1', { endedAt: span.endedAt }, tech).catch((e) => e);
    expect(err.message).toContain('entry itself is unchanged');
  });

  it("stopTimer's CAS surfaces the drift with a message saying the stop was not recorded", async () => {
    dbMocks.updateErrors.push(checkViolation(DRIFT));
    await expect(stopTimer({}, tech)).rejects.toMatchObject({
      code: 'BILLABLE_MINUTES_DRIFT',
      status: 422,
      message: expect.stringContaining('not'),
    });
  });

  it('updateTimeEntry (mobile stop replay) surfaces the drift the same way', async () => {
    dbMocks.selectResults.push([entry]);
    dbMocks.updateErrors.push(checkViolation(DRIFT));
    await expect(updateTimeEntry('te-1', { endedAt: span.endedAt }, tech))
      .rejects.toMatchObject({ code: 'BILLABLE_MINUTES_DRIFT', status: 422 });
  });

  it('a 23514 on a DIFFERENT constraint is left alone — only the billable-minutes check is claimed', async () => {
    dbMocks.selectResults.push([entry]);
    dbMocks.updateErrors.push(checkViolation('time_entries_currency_required_when_org_chk'));
    await expect(updateTimeEntry('te-1', { endedAt: span.endedAt }, tech))
      .rejects.toMatchObject({ code: '23514', constraint_name: 'time_entries_currency_required_when_org_chk' });
  });

  it('the refusal is a 4xx so a mobile replay parks it instead of retrying a deterministic failure forever', async () => {
    // apps/mobile/src/services/timeEntryQueue.ts PERMANENT_STATUSES = {400,404,409,422}.
    // A 500 here would be read as transient and wedge every write queued behind it.
    dbMocks.selectResults.push([entry]);
    dbMocks.updateErrors.push(checkViolation(DRIFT));
    const err = await updateTimeEntry('te-1', { endedAt: span.endedAt }, tech).catch((e) => e);
    expect(err.status).toBe(422);
    expect([400, 404, 409, 422]).toContain(err.status);
  });
});
