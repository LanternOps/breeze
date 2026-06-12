import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inspect } from 'node:util';

const { dbMocks, emitMock, configMocks } = vi.hoisted(() => {
  const dbMocks = {
    // queue of results for successive db.select()...where()/limit() terminals
    selectResults: [] as unknown[][],
    insertResult: [] as unknown[],
    insertErrors: [] as unknown[],
    updateResult: [] as unknown[],
    insertedValues: [] as Record<string, unknown>[],
    updateSetArgs: [] as Record<string, unknown>[],
    whereArgs: [] as unknown[]
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
            const terminal: any = {
              limit: vi.fn(() => Promise.resolve(result)),
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({ offset: vi.fn(() => Promise.resolve(result)) })),
                then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
                  Promise.resolve(result).then(res, rej)
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
        return {
          returning: vi.fn(() => {
            const err = dbMocks.insertErrors.shift();
            if (err) return Promise.reject(err);
            return Promise.resolve(dbMocks.insertResult);
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
    partNumber: 'partNumber', vendor: 'vendor', quantity: 'quantity', unitPrice: 'unitPrice',
    costBasis: 'costBasis', isBillable: 'isBillable', billingStatus: 'billingStatus',
    addedBy: 'addedBy', notes: 'notes', createdAt: 'createdAt', updatedAt: 'updatedAt'
  },
  tickets: { id: 'id', partnerId: 'partnerId', orgId: 'orgId', categoryId: 'categoryId', internalNumber: 'internalNumber', subject: 'subject' },
  ticketCategories: { id: 'id', partnerId: 'partnerId', defaultBillable: 'defaultBillable', defaultHourlyRate: 'defaultHourlyRate' },
  organizations: { id: 'id', partnerId: 'partnerId', name: 'name' },
  users: { id: 'id', name: 'name' },
  ticketComments: {
    id: 'id', ticketId: 'ticketId', userId: 'userId', authorName: 'authorName',
    authorType: 'authorType', commentType: 'commentType', content: 'content',
    isPublic: 'isPublic', oldValue: 'oldValue', newValue: 'newValue', createdAt: 'createdAt'
  }
}));

import {
  computeDurationMinutes, createTimeEntry, startTimer, stopTimer,
  updateTimeEntry, deleteTimeEntry, approveTimeEntries, addTicketPart,
  getTimesheet, getTicketBillingSummary, listBillables
} from './timeEntryService';

const ACTOR = { userId: 'u-1', name: 'Tess', partnerId: 'p-1', manageAll: false };
const ADMIN = { ...ACTOR, userId: 'u-admin', manageAll: true };

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.insertedValues.length = 0;
  dbMocks.updateSetArgs.length = 0;
  dbMocks.insertErrors.length = 0;
  dbMocks.whereArgs.length = 0;
  dbMocks.insertResult = [];
  dbMocks.updateResult = [];
  emitMock.mockClear();
  configMocks.getOrgBillingDefaults.mockResolvedValue(null);
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

  it('rejects endedAt before startedAt at the service boundary', async () => {
    await expect(createTimeEntry(
      { startedAt: new Date('2026-06-11T10:00:00Z'), endedAt: new Date('2026-06-11T09:00:00Z') },
      ACTOR
    )).rejects.toMatchObject({ code: 'INVALID_RANGE', status: 400 });
    expect(dbMocks.insertedValues).toHaveLength(0);
  });

  it('resolves a legacy ticket partner through its organization fallback', async () => {
    dbMocks.selectResults.push([{ id: 't-legacy', partnerId: null, orgId: 'o-1', categoryId: null }]);
    dbMocks.selectResults.push([{ partnerId: 'p-1' }]);
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
      configMocks.getOrgBillingDefaults.mockResolvedValue({ defaultHourlyRate: '150.00', defaultBillable: true });
      dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
      dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: false, defaultHourlyRate: '100.00' }]);
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
      configMocks.getOrgBillingDefaults.mockResolvedValue({ defaultHourlyRate: null, defaultBillable: null });
      dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
      dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '75.00' }]);
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
      dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00' }]);
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
      configMocks.getOrgBillingDefaults.mockResolvedValue({ defaultHourlyRate: '150.00', defaultBillable: true });
      dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
      dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '100.00' }]);
      dbMocks.insertResult = [{ id: 'te-d6d' }];
      await createTimeEntry(
        { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z'), isBillable: false, hourlyRate: 200 },
        ACTOR
      );
      const vals = dbMocks.insertedValues[0]!;
      expect(vals.isBillable).toBe(false);
      expect(vals.hourlyRate).toBe('200.00');
    });
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
    configMocks.getOrgBillingDefaults.mockResolvedValue({ defaultHourlyRate: '150.00', defaultBillable: true });
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: false, defaultHourlyRate: '100.00' }]);
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

  it('converts a second running-timer unique violation into a 409 service error', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    dbMocks.insertErrors.push(uniqueViolation, uniqueViolation);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(startTimer({ description: 'race' }, ACTOR))
        .rejects.toMatchObject({ code: 'ENTRY_RUNNING', status: 409 });
      expect(consoleSpy).toHaveBeenCalledWith(
        '[timeEntryService.startTimer] unique violation, retrying once',
        uniqueViolation.message
      );
    } finally {
      consoleSpy.mockRestore();
    }
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

  it('rejects system-scope relinks that would cross the entry partner boundary', async () => {
    dbMocks.selectResults.push([baseEntry]);
    dbMocks.selectResults.push([{ id: 't-cross', partnerId: 'p-OTHER', orgId: 'o-other', categoryId: null }]);
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

  it('fails loudly if insert returning yields no part row', async () => {
    dbMocks.selectResults.push([{ id: 't-3', partnerId: 'p-1', orgId: 'o-3', categoryId: null }]);
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
    expect(result.totals).toEqual({ totalMinutes: 75, billableMinutes: 30 });
  });

  it('getTicketBillingSummary returns aggregate rows and zero defaults', async () => {
    dbMocks.selectResults.push([{ totalMinutes: 90, billableMinutes: 60, billableAmount: '125.00' }]);
    dbMocks.selectResults.push([]);
    const result = await getTicketBillingSummary('t-1');
    expect(result.time).toEqual({ totalMinutes: 90, billableMinutes: 60, billableAmount: '125.00' });
    expect(result.parts).toEqual({ partsCount: 0, billableTotal: '0.00' });
  });

  it('listBillables combines time and parts in date order', async () => {
    dbMocks.selectResults.push([
      {
        date: new Date('2026-06-10T12:00:00Z'),
        orgName: 'Acme',
        ticketNumber: 'T-1',
        description: 'labor',
        technician: 'Tess',
        minutes: 90,
        rate: '100.00',
        billingStatus: 'not_billed',
        isApproved: true
      }
    ]);
    dbMocks.selectResults.push([
      {
        date: new Date('2026-06-10T11:00:00Z'),
        orgName: 'Acme',
        ticketNumber: 'T-1',
        description: 'SSD',
        technician: 'Tess',
        quantity: '2.00',
        unitPrice: '50.00',
        billingStatus: 'not_billed'
      }
    ]);
    const rows = await listBillables(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T00:00:00Z'));
    expect(rows.map((r) => r.kind)).toEqual(['part', 'time']);
    expect(rows[0]).toMatchObject({ kind: 'part', amount: '100.00', isApproved: null });
    expect(rows[1]).toMatchObject({ kind: 'time', quantity: '1.50', amount: '150.00', isApproved: true });
  });

  it('listBillables excludes running timers from billable time rows', async () => {
    dbMocks.selectResults.push([]);
    dbMocks.selectResults.push([]);
    const rows = await listBillables(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T00:00:00Z'));
    expect(rows).toEqual([]);
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
        billingStatus: 'not_billed'
      }
    ]);
    const rows = await listBillables(new Date('2026-06-01T00:00:00Z'), new Date('2026-06-30T00:00:00Z'));
    expect(rows.map((r) => r.amount)).toEqual(['0.00', '0.00']);
    expect(rows.map((r) => r.amount)).not.toContain('NaN');
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    consoleSpy.mockRestore();
  });
});

describe('time_entry feed comments', () => {
  it('createTimeEntry with ticketId inserts a ticketComments row (logged, billable suffix)', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: null }]);
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
