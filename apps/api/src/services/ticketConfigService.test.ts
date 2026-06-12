import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: {
    // FIFO queue of results for successive db.select()...(where|orderBy|limit) terminals
    selectResults: [] as unknown[][],
    insertResult: [] as unknown[],
    insertErrors: [] as unknown[],
    updateResult: [] as unknown[],
    insertedValues: [] as Record<string, unknown>[],
    conflictArgs: [] as Record<string, unknown>[],
    updateSetArgs: [] as Record<string, unknown>[],
  },
}));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const result = () => dbMocks.selectResults.shift() ?? [];
        const chain: any = {
          where: vi.fn(() => {
            const r = result();
            return {
              limit: vi.fn(() => Promise.resolve(r)),
              orderBy: vi.fn(() => Promise.resolve(r)),
              then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
                Promise.resolve(r).then(res, rej),
            };
          }),
        };
        return chain;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.insertedValues.push(vals);
        const returning = () => {
          const err = dbMocks.insertErrors.shift();
          if (err) return Promise.reject(err);
          return Promise.resolve(dbMocks.insertResult);
        };
        return {
          returning: vi.fn(returning),
          onConflictDoUpdate: vi.fn((arg: Record<string, unknown>) => {
            dbMocks.conflictArgs.push(arg);
            // priority upsert has no .returning(); make the chain awaitable AND
            // expose .returning() for the org-settings path.
            const thenable: any = {
              returning: vi.fn(returning),
              then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) => {
                const e = dbMocks.insertErrors.shift();
                if (e) return Promise.reject(e).then(res, rej);
                return Promise.resolve(dbMocks.insertResult).then(res, rej);
              },
            };
            return thenable;
          }),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.updateSetArgs.push(vals);
        const where = () => {
          const thenable: any = {
            returning: vi.fn(() => Promise.resolve(dbMocks.updateResult)),
            then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
              Promise.resolve(dbMocks.updateResult).then(res, rej),
          };
          return thenable;
        };
        return { where: vi.fn(where) };
      }),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  ticketStatuses: {
    id: 'id', partnerId: 'partnerId', name: 'name', coreStatus: 'coreStatus',
    color: 'color', sortOrder: 'sortOrder', isSystem: 'isSystem', isActive: 'isActive',
    updatedAt: 'updatedAt',
  },
  ticketPrioritySettings: {
    id: 'id', partnerId: 'partnerId', priority: 'priority', label: 'label',
    responseSlaMinutes: 'responseSlaMinutes', resolutionSlaMinutes: 'resolutionSlaMinutes',
    updatedAt: 'updatedAt',
  },
  orgTicketSettings: {
    id: 'id', orgId: 'orgId', slaOverrides: 'slaOverrides',
    defaultHourlyRate: 'defaultHourlyRate', defaultBillable: 'defaultBillable',
    updatedAt: 'updatedAt',
  },
}));

// ticketStatusEnum is read at module load for CoreTicketStatus type/values.
vi.mock('../db/schema/portal', () => ({
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
}));

import {
  getTicketConfig, createTicketStatus, updateTicketStatus, reorderTicketStatuses,
  upsertPrioritySettings, upsertOrgTicketSettings, getOrgTicketSettings,
  TicketConfigServiceError, findStatusByName, listActiveStatusNames,
} from './ticketConfigService';

const PARTNER = 'p-1';
const ORG = 'o-1';
const STATUS_ID = 's-1';

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.insertedValues.length = 0;
  dbMocks.conflictArgs.length = 0;
  dbMocks.updateSetArgs.length = 0;
  dbMocks.insertErrors.length = 0;
  dbMocks.insertResult = [];
  dbMocks.updateResult = [];
});

describe('getTicketConfig', () => {
  it('merges priority defaults for unset priorities', async () => {
    dbMocks.selectResults.push([{ id: 's-1', name: 'New', coreStatus: 'new', color: null, sortOrder: 0, isSystem: true, isActive: true }]); // statuses
    dbMocks.selectResults.push([{ priority: 'high', label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 120 }]); // priorities
    const cfg = await getTicketConfig(PARTNER);
    expect(cfg.statuses).toHaveLength(1);
    expect(cfg.priorities.high).toEqual({ label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 120 });
    expect(cfg.priorities.low).toEqual({ label: null, responseSlaMinutes: null, resolutionSlaMinutes: null });
    expect(cfg.priorities.normal).toEqual({ label: null, responseSlaMinutes: null, resolutionSlaMinutes: null });
    expect(cfg.priorities.urgent).toEqual({ label: null, responseSlaMinutes: null, resolutionSlaMinutes: null });
  });
});

describe('createTicketStatus', () => {
  it('inserts a non-system active row', async () => {
    dbMocks.insertResult = [{ id: 's-9', name: 'Triage' }];
    const row = await createTicketStatus(PARTNER, { name: 'Triage', coreStatus: 'open' });
    expect(row).toEqual({ id: 's-9', name: 'Triage' });
    const vals = dbMocks.insertedValues[0]!;
    expect(vals).toMatchObject({ partnerId: PARTNER, name: 'Triage', coreStatus: 'open', sortOrder: 0, isSystem: false, isActive: true, color: null });
  });

  it('maps a 23505 unique violation to STATUS_NAME_TAKEN 409', async () => {
    dbMocks.insertErrors.push(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(createTicketStatus(PARTNER, { name: 'New', coreStatus: 'new' }))
      .rejects.toMatchObject({ status: 409, code: 'STATUS_NAME_TAKEN' });
  });

  it('maps a constraint-name violation to STATUS_NAME_TAKEN', async () => {
    dbMocks.insertErrors.push(new Error('violates ticket_statuses_partner_name_uq'));
    await expect(createTicketStatus(PARTNER, { name: 'New', coreStatus: 'new' }))
      .rejects.toMatchObject({ code: 'STATUS_NAME_TAKEN' });
  });

  it('does NOT map a 23505 on a different constraint to STATUS_NAME_TAKEN', async () => {
    // A 23505 on ticket_statuses_partner_core_status_system_uq is unrelated to name
    // uniqueness and must be rethrown as-is (not mapped to STATUS_NAME_TAKEN).
    const err = Object.assign(new Error('dup key'), {
      code: '23505',
      constraint: 'ticket_statuses_partner_core_status_system_uq',
    });
    dbMocks.insertErrors.push(err);
    await expect(createTicketStatus(PARTNER, { name: 'New', coreStatus: 'new' }))
      .rejects.toSatisfy((e: unknown) => !(e instanceof TicketConfigServiceError));
  });
});

describe('updateTicketStatus', () => {
  it('throws STATUS_NOT_FOUND when no row belongs to the partner', async () => {
    dbMocks.selectResults.push([]); // load
    await expect(updateTicketStatus(PARTNER, STATUS_ID, { name: 'X' }))
      .rejects.toMatchObject({ status: 404, code: 'STATUS_NOT_FOUND' });
  });

  it('rejects remapping a system row coreStatus (SYSTEM_STATUS_IMMUTABLE)', async () => {
    dbMocks.selectResults.push([{ id: STATUS_ID, coreStatus: 'new', isSystem: true }]);
    await expect(updateTicketStatus(PARTNER, STATUS_ID, { coreStatus: 'closed' }))
      .rejects.toMatchObject({ status: 400, code: 'SYSTEM_STATUS_IMMUTABLE' });
  });

  it('rejects deactivating a system row (SYSTEM_STATUS_REQUIRED)', async () => {
    dbMocks.selectResults.push([{ id: STATUS_ID, coreStatus: 'new', isSystem: true }]);
    await expect(updateTicketStatus(PARTNER, STATUS_ID, { isActive: false }))
      .rejects.toMatchObject({ status: 400, code: 'SYSTEM_STATUS_REQUIRED' });
  });

  it('allows renaming + recoloring a system row (same coreStatus is fine)', async () => {
    dbMocks.selectResults.push([{ id: STATUS_ID, coreStatus: 'new', isSystem: true }]);
    dbMocks.updateResult = [{ id: STATUS_ID, name: 'Brand New' }];
    const row = await updateTicketStatus(PARTNER, STATUS_ID, { name: 'Brand New', color: '#112233', coreStatus: 'new' });
    expect(row).toEqual({ id: STATUS_ID, name: 'Brand New' });
    const patch = dbMocks.updateSetArgs[0]!;
    expect(patch).toMatchObject({ name: 'Brand New', color: '#112233' });
    expect(patch.updatedAt).toBeInstanceOf(Date);
  });

  it('allows deactivating a non-system row', async () => {
    dbMocks.selectResults.push([{ id: STATUS_ID, coreStatus: 'open', isSystem: false }]);
    dbMocks.updateResult = [{ id: STATUS_ID, isActive: false }];
    const row = await updateTicketStatus(PARTNER, STATUS_ID, { isActive: false });
    expect(row).toEqual({ id: STATUS_ID, isActive: false });
    expect(dbMocks.updateSetArgs[0]!).toMatchObject({ isActive: false });
  });

  it('maps a name unique violation on update to STATUS_NAME_TAKEN', async () => {
    dbMocks.selectResults.push([{ id: STATUS_ID, coreStatus: 'open', isSystem: false }]);
    dbMocks.updateResult = []; // unused; error path
    // force the update returning to reject
    const { db } = await import('../db');
    vi.mocked(db.update).mockImplementationOnce(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.reject(Object.assign(new Error('dup'), { code: '23505' }))),
        })),
      })),
    }) as any);
    await expect(updateTicketStatus(PARTNER, STATUS_ID, { name: 'New' }))
      .rejects.toMatchObject({ code: 'STATUS_NAME_TAKEN', status: 409 });
  });

  it('throws STATUS_NOT_FOUND 404 when the UPDATE affects no rows (TOCTOU guard)', async () => {
    // Row exists at load time but is deleted before the UPDATE executes.
    dbMocks.selectResults.push([{ id: STATUS_ID, coreStatus: 'open', isSystem: false }]);
    dbMocks.updateResult = []; // UPDATE returns empty — row was deleted between SELECT and UPDATE
    await expect(updateTicketStatus(PARTNER, STATUS_ID, { name: 'X' }))
      .rejects.toMatchObject({ status: 404, code: 'STATUS_NOT_FOUND' });
  });
});

describe('reorderTicketStatuses', () => {
  it('assigns sortOrder=index and skips ids that do not belong to the partner', async () => {
    // ownership query returns only s-1 and s-3 (s-2 belongs to another partner)
    dbMocks.selectResults.push([{ id: 's-1' }, { id: 's-3' }]);
    const res = await reorderTicketStatuses(PARTNER, ['s-1', 's-2', 's-3']);
    expect(res).toEqual({ updated: 2 });
    // two updates fired, with sortOrder 0 and 2 (index positions of the owned ids)
    expect(dbMocks.updateSetArgs).toHaveLength(2);
    expect(dbMocks.updateSetArgs[0]!).toMatchObject({ sortOrder: 0 });
    expect(dbMocks.updateSetArgs[1]!).toMatchObject({ sortOrder: 2 });
  });
});

describe('upsertPrioritySettings', () => {
  it('upserts each provided priority via onConflictDoUpdate on (partnerId, priority)', async () => {
    // re-read at end:
    dbMocks.selectResults.push([{ priority: 'high', label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 90 }]);
    const result = await upsertPrioritySettings(PARTNER, {
      priorities: {
        high: { label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 90 },
        urgent: { responseSlaMinutes: 15 },
      },
    });
    expect(dbMocks.conflictArgs).toHaveLength(2);
    expect(dbMocks.conflictArgs[0]!.target).toEqual(['partnerId', 'priority']);
    expect(result.high).toEqual({ label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 90 });
    // urgent only set responseSlaMinutes; label not provided => not in set patch
    expect(dbMocks.conflictArgs[1]!.set).not.toHaveProperty('label');
    expect(dbMocks.conflictArgs[1]!.set).toMatchObject({ responseSlaMinutes: 15 });
  });
});

describe('getOrgTicketSettings', () => {
  it('returns defaults when no row exists', async () => {
    dbMocks.selectResults.push([]);
    const res = await getOrgTicketSettings(ORG);
    expect(res).toEqual({ orgId: ORG, slaOverrides: {}, defaultHourlyRate: null, defaultBillable: null });
  });
});

describe('upsertOrgTicketSettings', () => {
  it('replaces slaOverrides wholesale and converts the rate to a string', async () => {
    dbMocks.insertResult = [{ slaOverrides: { high: { responseMinutes: 30 } }, defaultHourlyRate: '125.50', defaultBillable: true }];
    const res = await upsertOrgTicketSettings(ORG, {
      slaOverrides: { high: { responseMinutes: 30 } },
      defaultHourlyRate: 125.5,
      defaultBillable: true,
    });
    const vals = dbMocks.insertedValues[0]!;
    expect(vals.slaOverrides).toEqual({ high: { responseMinutes: 30 } });
    expect(vals.defaultHourlyRate).toBe('125.5');
    expect(vals.defaultBillable).toBe(true);
    const conflict = dbMocks.conflictArgs[0]!;
    expect(conflict.target).toBe('orgId');
    expect((conflict.set as Record<string, unknown>).slaOverrides).toEqual({ high: { responseMinutes: 30 } });
    expect((conflict.set as Record<string, unknown>).updatedAt).toBeInstanceOf(Date);
    expect(res).toEqual({ orgId: ORG, slaOverrides: { high: { responseMinutes: 30 } }, defaultHourlyRate: '125.50', defaultBillable: true });
  });

  it('passes null through for an explicitly cleared rate', async () => {
    dbMocks.insertResult = [{ slaOverrides: {}, defaultHourlyRate: null, defaultBillable: null }];
    await upsertOrgTicketSettings(ORG, { defaultHourlyRate: null });
    expect(dbMocks.insertedValues[0]!.defaultHourlyRate).toBeNull();
    // slaOverrides not provided => not in values
    expect(dbMocks.insertedValues[0]!).not.toHaveProperty('slaOverrides');
  });
});

describe('TicketConfigServiceError', () => {
  it('defaults to status 400', () => {
    const e = new TicketConfigServiceError('x');
    expect(e.status).toBe(400);
    expect(e.name).toBe('TicketConfigServiceError');
  });
});

// ── findStatusByName ──────────────────────────────────────────────────────

const ACTIVE_STATUS_ROWS = [
  { id: 's-1', partnerId: PARTNER, coreStatus: 'new' as const, name: 'New', isActive: true, isSystem: true },
  { id: 's-2', partnerId: PARTNER, coreStatus: 'open' as const, name: 'Waiting on vendor', isActive: true, isSystem: false },
  { id: 's-3', partnerId: PARTNER, coreStatus: 'pending' as const, name: 'Pending', isActive: true, isSystem: true },
];

describe('findStatusByName', () => {
  it('returns the matching row when the name exists (exact case)', async () => {
    dbMocks.selectResults.push(ACTIVE_STATUS_ROWS);
    const row = await findStatusByName(PARTNER, 'Waiting on vendor');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('s-2');
    expect(row!.coreStatus).toBe('open');
  });

  it('matches case-insensitively', async () => {
    dbMocks.selectResults.push(ACTIVE_STATUS_ROWS);
    const row = await findStatusByName(PARTNER, 'WAITING ON VENDOR');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('s-2');
  });

  it('returns null for an unknown name', async () => {
    dbMocks.selectResults.push(ACTIVE_STATUS_ROWS);
    const row = await findStatusByName(PARTNER, 'Nonexistent status');
    expect(row).toBeNull();
  });

  it('returns null when the partner has no active statuses', async () => {
    dbMocks.selectResults.push([]);
    const row = await findStatusByName(PARTNER, 'New');
    expect(row).toBeNull();
  });
});

// ── listActiveStatusNames ─────────────────────────────────────────────────

describe('listActiveStatusNames', () => {
  it('returns the names of all active rows', async () => {
    dbMocks.selectResults.push(ACTIVE_STATUS_ROWS.map((r) => ({ name: r.name })));
    const names = await listActiveStatusNames(PARTNER);
    expect(names).toEqual(['New', 'Waiting on vendor', 'Pending']);
  });

  it('returns an empty array when the partner has no active rows', async () => {
    dbMocks.selectResults.push([]);
    const names = await listActiveStatusNames(PARTNER);
    expect(names).toEqual([]);
  });
});
