import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMocks, emitMock } = vi.hoisted(() => {
  const dbMocks = {
    // queue of results for successive db.select()...where()/limit() terminals
    selectResults: [] as unknown[][],
    insertResult: [] as unknown[],
    updateResult: [] as unknown[],
    insertedValues: [] as Record<string, unknown>[],
    updateSetArgs: [] as Record<string, unknown>[]
  };
  return { dbMocks, emitMock: vi.fn() };
});

vi.mock('./timeEntryEvents', () => ({ emitTimeEntryEvent: emitMock }));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const result = dbMocks.selectResults.shift() ?? [];
          return {
            limit: vi.fn(() => Promise.resolve(result)),
            orderBy: vi.fn(() => Promise.resolve(result)),
            then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
              Promise.resolve(result).then(res, rej)
          };
        }),
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => {
            const result = dbMocks.selectResults.shift() ?? [];
            return {
              limit: vi.fn(() => Promise.resolve(result)),
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({ offset: vi.fn(() => Promise.resolve(result)) }))
              })),
              then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
                Promise.resolve(result).then(res, rej)
            };
          })
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.insertedValues.push(vals);
        return { returning: vi.fn(() => Promise.resolve(dbMocks.insertResult)) };
      })
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.updateSetArgs.push(vals);
        return { where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(dbMocks.updateResult)) })) };
      })
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }))
  }
}));

vi.mock('../db/schema', () => ({
  timeEntries: {
    id: 'id', partnerId: 'partnerId', orgId: 'orgId', ticketId: 'ticketId',
    userId: 'userId', startedAt: 'startedAt', endedAt: 'endedAt',
    durationMinutes: 'durationMinutes', description: 'description',
    isBillable: 'isBillable', hourlyRate: 'hourlyRate', billingStatus: 'billingStatus',
    isApproved: 'isApproved', approvedBy: 'approvedBy', approvedAt: 'approvedAt',
    createdAt: 'createdAt', updatedAt: 'updatedAt'
  },
  ticketParts: {
    id: 'id', ticketId: 'ticketId', orgId: 'orgId', description: 'description',
    quantity: 'quantity', unitPrice: 'unitPrice', costBasis: 'costBasis',
    isBillable: 'isBillable', billingStatus: 'billingStatus', addedBy: 'addedBy'
  },
  tickets: { id: 'id', partnerId: 'partnerId', orgId: 'orgId', categoryId: 'categoryId', internalNumber: 'internalNumber', subject: 'subject' },
  ticketCategories: { id: 'id', partnerId: 'partnerId', defaultBillable: 'defaultBillable', defaultHourlyRate: 'defaultHourlyRate' },
  organizations: { id: 'id', partnerId: 'partnerId', name: 'name' },
  users: { id: 'id', name: 'name' }
}));

import {
  computeDurationMinutes, createTimeEntry, startTimer, stopTimer,
  updateTimeEntry, deleteTimeEntry, approveTimeEntries, addTicketPart,
  TimeEntryServiceError
} from './timeEntryService';

const ACTOR = { userId: 'u-1', name: 'Tess', partnerId: 'p-1', manageAll: false };
const ADMIN = { ...ACTOR, userId: 'u-admin', manageAll: true };

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.insertedValues.length = 0;
  dbMocks.updateSetArgs.length = 0;
  dbMocks.insertResult = [];
  dbMocks.updateResult = [];
  emitMock.mockClear();
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
    await expect(createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      ACTOR
    )).rejects.toMatchObject({ code: 'TICKET_WRONG_PARTNER', status: 400 });
  });

  it('defaults billable + rate from the ticket category (D2) and denormalizes org_id', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00' }]);
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

  it('explicit isBillable/hourlyRate override category defaults', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00' }]);
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

  it('stopTimer errors with NO_RUNNING_TIMER when nothing is running', async () => {
    dbMocks.updateResult = []; // CAS update matched no rows
    await expect(stopTimer({}, ACTOR)).rejects.toMatchObject({ code: 'NO_RUNNING_TIMER', status: 404 });
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
    dbMocks.selectResults.push([baseEntry]); // the entry
    dbMocks.selectResults.push([{ id: 't-9', partnerId: 'p-1', orgId: 'o-9', categoryId: null }]); // ticket (system read)
    dbMocks.updateResult = [baseEntry];
    await updateTimeEntry('te-1', { ticketId: 't-9' }, ACTOR);
    const setArgs = dbMocks.updateSetArgs.at(-1)!;
    expect(setArgs.ticketId).toBe('t-9');
    expect(setArgs.orgId).toBe('o-9');
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

describe('addTicketPart', () => {
  it('denormalizes org_id and defaults billable from category', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: false, defaultHourlyRate: null }]);
    dbMocks.insertResult = [{ id: 'part-1' }];
    await addTicketPart('t-1', { description: 'SSD 1TB', quantity: 1, unitPrice: 120 }, ACTOR);
    const vals = dbMocks.insertedValues.at(-1)!;
    expect(vals.orgId).toBe('o-1');
    expect(vals.isBillable).toBe(false);
    expect(vals.unitPrice).toBe('120.00');
  });

  it('sets addedBy from actor, defaults billingStatus to not_billed, and preserves null costBasis', async () => {
    dbMocks.selectResults.push([{ id: 't-2', partnerId: 'p-1', orgId: 'o-2', categoryId: 'cat-2' }]);
    dbMocks.selectResults.push([{ id: 'cat-2', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: null }]);
    dbMocks.insertResult = [{ id: 'part-2' }];
    await addTicketPart('t-2', { description: 'RAM 32GB', quantity: 2, unitPrice: 60 }, ACTOR);
    const vals = dbMocks.insertedValues.at(-1)!;
    expect(vals.addedBy).toBe('u-1');
    expect(vals.billingStatus).toBe('not_billed');
    expect(vals.costBasis).toBeNull();
  });
});
