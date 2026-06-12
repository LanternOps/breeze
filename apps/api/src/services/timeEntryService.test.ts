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
    }))
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
