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
    // Predicates passed to .where() on select() and update() terminals. The
    // mocked drizzle operators (and/eq/inArray below) build plain JSON sentinels,
    // so tests can introspect that a query actually filters on partnerId/parseStatus
    // — not merely that an empty result was seeded.
    whereArgs: [] as unknown[],
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
          where: vi.fn((predicate: unknown) => {
            dbMocks.whereArgs.push(predicate);
            const r = result();
            const orderByResult: any = Object.assign(
              // orderBy is awaitable on its own (statuses select terminates here)…
              Promise.resolve(r),
              // …and also exposes .limit().offset() for the paginated queue read.
              { limit: vi.fn(() => ({ offset: vi.fn(() => Promise.resolve(r)) })) },
            );
            return {
              limit: vi.fn(() => Promise.resolve(r)),
              orderBy: vi.fn(() => orderByResult),
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
        const where = (predicate?: unknown) => {
          dbMocks.whereArgs.push(predicate);
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

// Mock the drizzle-orm comparison operators so .where() predicates are plain,
// introspectable JSON sentinels. The schema mock below uses string column names
// (e.g. ticketEmailInbound.partnerId === 'partnerId'), so eq('partnerId', 'p-1')
// becomes { __op: 'eq', column: 'partnerId', value: 'p-1' }. and(...) nests the
// children so a test can assert a query references a given column. Everything
// else (asc/desc/count/sql) is preserved from the real module.
vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: vi.fn((...conds: unknown[]) => ({ __op: 'and', conds })),
    eq: vi.fn((column: unknown, value: unknown) => ({ __op: 'eq', column, value })),
    inArray: vi.fn((column: unknown, values: unknown) => ({ __op: 'inArray', column, values })),
  };
});

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
  partners: {
    id: 'id', slug: 'slug', settings: 'settings',
  },
  ticketEmailInbound: {
    id: 'id', partnerId: 'partnerId', fromAddress: 'fromAddress', toAddress: 'toAddress',
    subject: 'subject', parseStatus: 'parseStatus', error: 'error', ticketId: 'ticketId',
    raw: 'raw', createdAt: 'createdAt',
  },
  organizations: {
    id: 'id', partnerId: 'partnerId',
  },
}));

// ticketStatusEnum is read at module load for CoreTicketStatus type/values.
vi.mock('../db/schema/portal', () => ({
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
}));

// getConfig() is read in getTicketConfig's inbound block to resolve the platform
// inbound domain; toggle it per-case via configRef.
const { configRef } = vi.hoisted(() => ({ configRef: { current: { TICKETS_INBOUND_DOMAIN: 'tickets.example.com' as string | undefined } } }));
vi.mock('../config/validate', () => ({ getConfig: () => configRef.current }));

// createTicket lives in ./ticketService — mock it so convert doesn't hit the
// real ticket-creation service (DB inserts, event emission, SLA resolution).
const { createTicketMock } = vi.hoisted(() => ({ createTicketMock: vi.fn() }));
vi.mock('./ticketService', async () => {
  const actual = await vi.importActual<typeof import('./ticketService')>('./ticketService');
  return { ...actual, createTicket: createTicketMock };
});

import {
  getTicketConfig, createTicketStatus, updateTicketStatus, reorderTicketStatuses,
  upsertPrioritySettings, upsertOrgTicketSettings, getOrgTicketSettings,
  TicketConfigServiceError, findStatusByName, listActiveStatusNames,
  listEmailInboundQueue, convertEmailInbound, dismissEmailInbound,
} from './ticketConfigService';

const PARTNER = 'p-1';
const ORG = 'o-1';
const STATUS_ID = 's-1';

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.insertedValues.length = 0;
  dbMocks.conflictArgs.length = 0;
  dbMocks.updateSetArgs.length = 0;
  dbMocks.whereArgs.length = 0;
  dbMocks.insertErrors.length = 0;
  dbMocks.insertResult = [];
  dbMocks.updateResult = [];
});

// Recursively flatten a predicate sentinel (eq/inArray/and) into its leaf clauses.
function flattenPredicate(p: unknown): Array<{ __op: string; column?: unknown; value?: unknown; values?: unknown }> {
  if (!p || typeof p !== 'object') return [];
  const node = p as { __op?: string; conds?: unknown[]; column?: unknown; value?: unknown; values?: unknown };
  if (node.__op === 'and') return (node.conds ?? []).flatMap(flattenPredicate);
  if (node.__op) return [node as { __op: string }];
  return [];
}

// Does any captured .where() predicate filter on the given column?
function whereHasColumn(predicate: unknown, column: string): boolean {
  return flattenPredicate(predicate).some((c) => c.column === column);
}

// Does any captured .where() predicate carry an inArray filter on the column
// against exactly the given value set (order-independent)?
function whereHasInArray(predicate: unknown, column: string, expected: string[]): boolean {
  return flattenPredicate(predicate).some(
    (c) =>
      c.__op === 'inArray' &&
      c.column === column &&
      Array.isArray(c.values) &&
      (c.values as unknown[]).length === expected.length &&
      expected.every((v) => (c.values as unknown[]).includes(v)),
  );
}

describe('getTicketConfig', () => {
  it('merges priority defaults for unset priorities', async () => {
    dbMocks.selectResults.push([{ id: 's-1', name: 'New', coreStatus: 'new', color: null, sortOrder: 0, isSystem: true, isActive: true }]); // (1) statuses
    dbMocks.selectResults.push([{ priority: 'high', label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 120 }]); // (2) priorities
    dbMocks.selectResults.push([{ slug: 'acme', settings: {} }]); // (3) partners row (new — keeps the FIFO aligned)
    const cfg = await getTicketConfig(PARTNER);
    expect(cfg.statuses).toHaveLength(1);
    expect(cfg.priorities.high).toEqual({ label: 'High', responseSlaMinutes: 30, resolutionSlaMinutes: 120 });
    expect(cfg.priorities.low).toEqual({ label: null, responseSlaMinutes: null, resolutionSlaMinutes: null });
    expect(cfg.priorities.normal).toEqual({ label: null, responseSlaMinutes: null, resolutionSlaMinutes: null });
    expect(cfg.priorities.urgent).toEqual({ label: null, responseSlaMinutes: null, resolutionSlaMinutes: null });
  });
});

describe('getTicketConfig inbound block', () => {
  beforeEach(() => { configRef.current.TICKETS_INBOUND_DOMAIN = 'tickets.example.com'; });

  function enqueueForInbound(partnerRow: unknown) {
    dbMocks.selectResults.push([]); // (1) statuses
    dbMocks.selectResults.push([]); // (2) priorities
    dbMocks.selectResults.push([partnerRow]); // (3) partners row
  }

  it('derives the platform inbound address from slug when no override', async () => {
    enqueueForInbound({ slug: 'acme', settings: { ticketing: { inbound: { enabled: true, autoresponderEnabled: false } } } });
    const cfg = await getTicketConfig('p-1');
    expect(cfg.inbound.enabled).toBe(true);
    expect(cfg.inbound.address).toBe('acme@tickets.example.com');
    expect(cfg.inbound.addressOverride).toBeNull();
    expect(cfg.inbound.autoresponderEnabled).toBe(false);
    expect(cfg.inbound.slug).toBe('acme');
    expect(cfg.inbound.domainConfigured).toBe(true);
  });
  it('prefers an explicit address override (self-hosted) and exposes it as addressOverride', async () => {
    enqueueForInbound({ slug: 'acme', settings: { ticketing: { inbound: { address: 'support@tickets.acme.com' } } } });
    const cfg = await getTicketConfig('p-1');
    expect(cfg.inbound.address).toBe('support@tickets.acme.com');
    expect(cfg.inbound.addressOverride).toBe('support@tickets.acme.com');
  });
  it('defaults enabled=false, autoresponderEnabled=true, addressOverride=null when config absent', async () => {
    enqueueForInbound({ slug: 'acme', settings: {} });
    const cfg = await getTicketConfig('p-1');
    expect(cfg.inbound.enabled).toBe(false);
    expect(cfg.inbound.autoresponderEnabled).toBe(true);
    expect(cfg.inbound.defaultTriageOrgId).toBeNull();
    expect(cfg.inbound.addressOverride).toBeNull();
  });
  it('reports domainConfigured=false and empty address when TICKETS_INBOUND_DOMAIN is unset', async () => {
    configRef.current.TICKETS_INBOUND_DOMAIN = undefined;
    enqueueForInbound({ slug: 'acme', settings: {} });
    const cfg = await getTicketConfig('p-1');
    expect(cfg.inbound.domainConfigured).toBe(false);
    expect(cfg.inbound.address).toBe('');
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
    dbMocks.insertErrors.push(Object.assign(new Error('dup'), { code: '23505', constraint: 'ticket_statuses_partner_name_uq' }));
    await expect(createTicketStatus(PARTNER, { name: 'New', coreStatus: 'new' }))
      .rejects.toMatchObject({ status: 409, code: 'STATUS_NAME_TAKEN' });
  });

  it('maps a constraint-name violation surfaced only in the message to STATUS_NAME_TAKEN', async () => {
    // postgres.js sets code 23505 but some wrappers drop the discrete .constraint
    // field — the helper then falls back to scanning the message.
    dbMocks.insertErrors.push(Object.assign(new Error('violates unique constraint "ticket_statuses_partner_name_uq"'), { code: '23505' }));
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
          returning: vi.fn(() => Promise.reject(Object.assign(new Error('dup'), { code: '23505', constraint: 'ticket_statuses_partner_name_uq' }))),
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

// ── listEmailInboundQueue ─────────────────────────────────────────────────

describe('listEmailInboundQueue', () => {
  it('returns quarantined+failed rows scoped to the partner with pagination', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', fromAddress: 'jane@x.com', toAddress: 'acme@tickets.example.com', subject: 'printer', parseStatus: 'quarantined', error: null, ticketId: null, createdAt: new Date('2026-06-13T00:00:00Z') }]); // rows
    dbMocks.selectResults.push([{ total: 1 }]); // count
    const res = await listEmailInboundQueue('p-1', { page: 1, limit: 50 });
    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.parseStatus).toBe('quarantined');
    expect(res.pagination).toEqual({ page: 1, limit: 50, total: 1 });
    // The query filters on partnerId AND limits parseStatus to exactly the two
    // review statuses — a widened filter (e.g. dropping the inArray) would fail.
    expect(whereHasColumn(dbMocks.whereArgs[0], 'partnerId')).toBe(true);
    expect(whereHasInArray(dbMocks.whereArgs[0], 'parseStatus', ['quarantined', 'failed'])).toBe(true);
  });
  it('caps limit at 100 and floors page at 1', async () => {
    dbMocks.selectResults.push([]); // rows
    dbMocks.selectResults.push([{ total: 0 }]); // count
    const res = await listEmailInboundQueue('p-1', { page: 0, limit: 9999 });
    expect(res.pagination.limit).toBe(100);
    expect(res.pagination.page).toBe(1);
  });
});

// ── convertEmailInbound / dismissEmailInbound ─────────────────────────────

const ACTOR = { userId: 'admin-u-1', name: 'Ada Admin' };

describe('convertEmailInbound', () => {
  beforeEach(() => createTicketMock.mockReset());

  it('creates a source:email ticket for the chosen org and links the row', async () => {
    // raw is the UNTRANSFORMED Mailgun form body: stripped-text + full From header.
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: 'jane@x.com', subject: 'printer', toAddress: 'acme@tickets.example.com', raw: { 'stripped-text': 'help me', from: '"Jane Doe" <jane@x.com>', sender: 'jane@x.com' } }]); // row read
    dbMocks.selectResults.push([{ id: 'o-1' }]); // org guard read
    dbMocks.updateResult = [{ id: 'r-1', fromAddress: 'jane@x.com', toAddress: 'acme@tickets.example.com', subject: 'printer', parseStatus: 'created', error: null, ticketId: 't-9', createdAt: new Date() }];
    createTicketMock.mockResolvedValue({ id: 't-9', internalNumber: 'T-2026-0007' });
    const row = await convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR);
    // Body comes from stripped-text and the submitter name is parsed from the
    // From header — NOT the non-existent raw.text / raw.fromName keys.
    expect(createTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'o-1', source: 'email', submitterEmail: 'jane@x.com', description: 'help me', submitterName: 'Jane Doe' }),
      ACTOR,
    );
    expect(row.ticketId).toBe('t-9');
    expect(row.parseStatus).toBe('created');
  });
  it('falls back to body-plain when stripped-text is absent', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: 'jane@x.com', subject: 'printer', toAddress: 'acme@tickets.example.com', raw: { 'body-plain': 'plain body only', from: 'jane@x.com' } }]);
    dbMocks.selectResults.push([{ id: 'o-1' }]);
    dbMocks.updateResult = [{ id: 'r-1', fromAddress: 'jane@x.com', toAddress: null, subject: 'printer', parseStatus: 'created', error: null, ticketId: 't-9', createdAt: new Date() }];
    createTicketMock.mockResolvedValue({ id: 't-9' });
    await convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR);
    // bare-address From header yields no display name → undefined.
    expect(createTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'plain body only', submitterName: undefined }),
      ACTOR,
    );
  });
  it('claims the row out of the review state BEFORE creating the ticket (claim-first ordering)', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: 'jane@x.com', subject: 'printer', toAddress: 'acme@tickets.example.com', raw: { 'stripped-text': 'help' } }]);
    dbMocks.selectResults.push([{ id: 'o-1' }]);
    dbMocks.updateResult = [{ id: 'r-1', fromAddress: 'jane@x.com', toAddress: null, subject: 'printer', parseStatus: 'created', error: null, ticketId: 't-9', createdAt: new Date() }];
    createTicketMock.mockResolvedValue({ id: 't-9' });
    await convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR);
    // First UPDATE is the claim: set parse_status='created', gated on the row
    // still being in a review status (quarantined/failed) and scoped to the partner.
    expect(dbMocks.updateSetArgs[0]).toEqual({ parseStatus: 'created' });
    const claimWhere = dbMocks.whereArgs.find((p) => whereHasInArray(p, 'parseStatus', ['quarantined', 'failed']));
    expect(claimWhere).toBeDefined();
    expect(whereHasColumn(claimWhere, 'partnerId')).toBe(true);
    // Second UPDATE links the ticket id.
    expect(dbMocks.updateSetArgs[1]).toEqual({ ticketId: 't-9' });
  });
  it('does NOT create a ticket when the claim UPDATE races to zero rows (raced dismiss)', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: 'jane@x.com', subject: 'printer', toAddress: 'acme@tickets.example.com', raw: { 'stripped-text': 'help' } }]);
    dbMocks.selectResults.push([{ id: 'o-1' }]);
    dbMocks.updateResult = []; // claim UPDATE affects 0 rows — a concurrent dismiss won the race
    await expect(convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR)).rejects.toMatchObject({ code: 'INBOUND_ROW_NOT_FOUND', status: 404 });
    // Critical: no ticket was created — the lost race never orphans a ticket.
    expect(createTicketMock).not.toHaveBeenCalled();
  });
  it('propagates a createTicket rejection without leaving the row half-updated', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: 'jane@x.com', subject: 'printer', toAddress: 'acme@tickets.example.com', raw: { 'stripped-text': 'help' } }]);
    dbMocks.selectResults.push([{ id: 'o-1' }]);
    dbMocks.updateResult = [{ id: 'r-1', fromAddress: 'jane@x.com', toAddress: null, subject: 'printer', parseStatus: 'created', error: null, ticketId: null, createdAt: new Date() }];
    createTicketMock.mockRejectedValueOnce(new Error('ticket service boom'));
    // The error propagates (non-service error) so handleServiceError rethrows and
    // the request transaction rolls the claim back. Convert must reject.
    await expect(convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR)).rejects.toThrow('ticket service boom');
    // Only the claim UPDATE ran; the ticket-link UPDATE never fired.
    expect(dbMocks.updateSetArgs).toHaveLength(1);
    expect(dbMocks.updateSetArgs[0]).toEqual({ parseStatus: 'created' });
  });
  it('throws INBOUND_ROW_NOT_FOUND when the row is not under this partner', async () => {
    dbMocks.selectResults.push([]); // scoped row read → []
    await expect(convertEmailInbound('p-1', 'r-x', 'o-1', ACTOR)).rejects.toMatchObject({ code: 'INBOUND_ROW_NOT_FOUND' });
    expect(createTicketMock).not.toHaveBeenCalled();
    // The row read filtered on partnerId (defense-in-depth atop partner-axis RLS).
    expect(whereHasColumn(dbMocks.whereArgs[0], 'partnerId')).toBe(true);
  });
  it('throws INBOUND_ROW_ALREADY_RESOLVED for a non-queue row (idempotency)', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'created' }]);
    await expect(convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR)).rejects.toMatchObject({ code: 'INBOUND_ROW_ALREADY_RESOLVED' });
    expect(createTicketMock).not.toHaveBeenCalled();
  });
  it('throws INBOUND_ROW_NO_SENDER when the row has no from address', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: null, subject: 'x', toAddress: 'acme@tickets.example.com', raw: {} }]);
    dbMocks.selectResults.push([{ id: 'o-1' }]); // org guard (still read before the sender check; order tolerant)
    await expect(convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR)).rejects.toMatchObject({ code: 'INBOUND_ROW_NO_SENDER' });
    expect(createTicketMock).not.toHaveBeenCalled();
  });
  it('throws INBOUND_ROW_NO_SENDER for a whitespace-only from address', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: '   ', subject: 'x', toAddress: 'acme@tickets.example.com', raw: {} }]);
    dbMocks.selectResults.push([{ id: 'o-1' }]); // org guard
    await expect(convertEmailInbound('p-1', 'r-1', 'o-1', ACTOR)).rejects.toMatchObject({ code: 'INBOUND_ROW_NO_SENDER', status: 400 });
    expect(createTicketMock).not.toHaveBeenCalled();
  });
  it('throws ORG_NOT_ACCESSIBLE when the chosen org is not under the partner', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'quarantined', fromAddress: 'jane@x.com', subject: 'x', toAddress: 'acme@tickets.example.com', raw: {} }]);
    dbMocks.selectResults.push([]); // org guard read → []
    await expect(convertEmailInbound('p-1', 'r-1', 'o-other', ACTOR)).rejects.toMatchObject({ code: 'ORG_NOT_ACCESSIBLE' });
    expect(createTicketMock).not.toHaveBeenCalled();
  });
});

describe('dismissEmailInbound', () => {
  it("sets parse_status='ignored' scoped to (id, partnerId)", async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'failed' }]); // row read
    dbMocks.updateResult = [{ id: 'r-1', fromAddress: null, toAddress: null, subject: null, parseStatus: 'ignored', error: null, ticketId: null, createdAt: new Date() }];
    const row = await dismissEmailInbound('p-1', 'r-1');
    expect(row.parseStatus).toBe('ignored');
    // Both the read and the UPDATE filter on partnerId (the tenant boundary).
    expect(dbMocks.whereArgs.every((p) => whereHasColumn(p, 'partnerId'))).toBe(true);
    expect(dbMocks.whereArgs.length).toBeGreaterThanOrEqual(2);
  });
  it('throws INBOUND_ROW_NOT_FOUND for a foreign-partner row', async () => {
    dbMocks.selectResults.push([]); // scoped read returns []
    await expect(dismissEmailInbound('p-1', 'r-x')).rejects.toMatchObject({ code: 'INBOUND_ROW_NOT_FOUND' });
    // The read that returned [] actually filtered on partnerId — it isn't NOT_FOUND
    // merely because an empty result was seeded.
    expect(whereHasColumn(dbMocks.whereArgs[0], 'partnerId')).toBe(true);
  });
  it('throws INBOUND_ROW_ALREADY_RESOLVED for an already-ignored row', async () => {
    dbMocks.selectResults.push([{ id: 'r-1', partnerId: 'p-1', parseStatus: 'ignored' }]);
    await expect(dismissEmailInbound('p-1', 'r-1')).rejects.toMatchObject({ code: 'INBOUND_ROW_ALREADY_RESOLVED' });
  });
});
