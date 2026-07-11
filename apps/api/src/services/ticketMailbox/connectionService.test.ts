import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks, contextMocks } = vi.hoisted(() => ({
  dbMocks: {
    selectResults: [] as unknown[][],
    insertResults: [] as unknown[][],
    updateResults: [] as unknown[][],
    selectedFields: [] as Array<Record<string, unknown> | undefined>,
    insertedValues: [] as Record<string, unknown>[],
    conflictUpdates: [] as Record<string, unknown>[],
    updatedValues: [] as Record<string, unknown>[],
    updateWheres: [] as unknown[],
    innerJoins: [] as Array<{ table: unknown; condition: unknown }>,
    transactionCalls: [] as string[],
    transaction: vi.fn(),
  },
  contextMocks: {
    runOutside: vi.fn(<T>(fn: () => T) => fn()),
    withSystem: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  },
}));

vi.mock('../../db', () => {
  const select = vi.fn((fields?: Record<string, unknown>) => {
    dbMocks.selectedFields.push(fields);
    return {
      from: vi.fn(() => {
        const finish = () => dbMocks.selectResults.shift() ?? [];
        const joined = {
          where: vi.fn(async () => finish()),
        };
        return {
          where: vi.fn(() => ({
            limit: vi.fn(async () => finish()),
            then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(finish()).then(resolve),
          })),
          innerJoin: vi.fn((table: unknown, condition: unknown) => {
            dbMocks.innerJoins.push({ table, condition });
            return joined;
          }),
        };
      }),
    };
  });

  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      dbMocks.insertedValues.push(values);
      return {
        onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, unknown> }) => {
          dbMocks.conflictUpdates.push(set);
          return { returning: vi.fn(async () => dbMocks.insertResults.shift() ?? []) };
        }),
        onConflictDoNothing: vi.fn(() => {
          dbMocks.transactionCalls.push('claim-or-verify-global-tenant');
          return { returning: vi.fn(async () => dbMocks.insertResults.shift() ?? []) };
        }),
      };
    }),
  }));

  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      dbMocks.updatedValues.push(values);
      return {
        where: vi.fn((condition: unknown) => {
          dbMocks.updateWheres.push(condition);
          dbMocks.transactionCalls.push('mark-connected');
          const rows = dbMocks.updateResults.shift() ?? [];
          return {
            returning: vi.fn(async () => rows),
            then: (resolve: (value: undefined) => unknown) => Promise.resolve(undefined).then(resolve),
          };
        }),
      };
    }),
  }));

  const dbInner = { select, insert, update };
  const txInner = {
    ...dbInner,
    select: vi.fn((fields?: Record<string, unknown>) => {
      dbMocks.transactionCalls.push('bind-same-partner-connection');
      return select(fields);
    }),
  };
  dbMocks.transaction.mockImplementation(async (fn: (tx: typeof txInner) => Promise<unknown>) => fn(txInner));

  return {
    db: { ...dbInner, transaction: dbMocks.transaction },
    runOutsideDbContext: contextMocks.runOutside,
    withSystemDbAccessContext: contextMocks.withSystem,
  };
});

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
    eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })),
  };
});

vi.mock('./mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { ticketMailboxConnections, ticketMailboxTenantOwnerships } from '../../db/schema/ticketMailbox';
import {
  bindVerifiedTenant,
  createPendingConnection,
  listConnectedMailboxes,
  listMailboxConnections,
  probeMailbox,
  setConnectionStatus,
} from './connectionService';

const CONNECTION_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const TENANT_ID_UPPER = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const TENANT_ID = TENANT_ID_UPPER.toLowerCase();
const MICROSOFT_OID_UPPER = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const MICROSOFT_OID = MICROSOFT_OID_UPPER.toLowerCase();
const USER_ID = '44444444-4444-4444-8444-444444444444';

const fullRow = {
  id: CONNECTION_ID,
  partnerId: PARTNER_ID,
  tenantId: TENANT_ID,
  mailboxAddress: 'support@example.com',
  displayName: 'Support',
  status: 'connected',
  deltaLink: 'secret-cursor',
  strictSenderAuth: false,
  lastPolledAt: new Date('2026-07-11T10:00:00.000Z'),
  lastMessageAt: new Date('2026-07-11T09:00:00.000Z'),
  lastError: 'legacy error',
  createdBy: USER_ID,
  createdAt: new Date('2026-07-10T10:00:00.000Z'),
  updatedAt: new Date('2026-07-11T10:00:00.000Z'),
};

describe('ticket mailbox connection service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    dbMocks.insertResults.length = 0;
    dbMocks.updateResults.length = 0;
    dbMocks.selectedFields.length = 0;
    dbMocks.insertedValues.length = 0;
    dbMocks.conflictUpdates.length = 0;
    dbMocks.updatedValues.length = 0;
    dbMocks.updateWheres.length = 0;
    dbMocks.innerJoins.length = 0;
    dbMocks.transactionCalls.length = 0;
    fetchMock.mockReset();
  });

  it('clears all stale tenant, cursor, error, polling, and message state on reconnect', async () => {
    dbMocks.insertResults.push([{ ...fullRow, status: 'pending_consent', tenantId: null }]);

    await createPendingConnection({
      partnerId: PARTNER_ID,
      mailboxAddress: ' Support@Example.com ',
      displayName: 'Support desk',
      createdBy: USER_ID,
    });

    expect(dbMocks.conflictUpdates[0]).toMatchObject({
      status: 'pending_consent',
      tenantId: null,
      deltaLink: null,
      lastError: null,
      lastPolledAt: null,
      lastMessageAt: null,
    });
  });

  it('atomically confirms ownership, binds the same-partner connection, and activates it', async () => {
    dbMocks.insertResults.push([]);
    dbMocks.selectResults.push([{ partnerId: PARTNER_ID }]);
    dbMocks.updateResults.push([{ id: CONNECTION_ID }]);

    await bindVerifiedTenant(CONNECTION_ID, PARTNER_ID, TENANT_ID_UPPER, {
      microsoftOid: MICROSOFT_OID_UPPER,
      breezeUserId: USER_ID,
    });

    expect(dbMocks.transaction).toHaveBeenCalledOnce();
    expect(dbMocks.transactionCalls).toEqual([
      'claim-or-verify-global-tenant',
      'bind-same-partner-connection',
      'mark-connected',
    ]);
    expect(dbMocks.insertedValues[0]).toEqual({
      tenantId: TENANT_ID,
      partnerId: PARTNER_ID,
      verifiedBy: USER_ID,
      verifiedMicrosoftOid: MICROSOFT_OID,
    });
    expect(dbMocks.updatedValues[0]).toMatchObject({
      tenantId: TENANT_ID,
      status: 'connected',
      lastError: null,
    });
    expect(dbMocks.updateWheres[0]).toEqual({
      op: 'and',
      conditions: [
        { op: 'eq', column: ticketMailboxConnections.id, value: CONNECTION_ID },
        { op: 'eq', column: ticketMailboxConnections.partnerId, value: PARTNER_ID },
        { op: 'eq', column: ticketMailboxConnections.status, value: 'pending_consent' },
      ],
    });
  });

  it('rejects a globally claimed tenant owned by another partner', async () => {
    dbMocks.insertResults.push([]);
    dbMocks.selectResults.push([{ partnerId: OTHER_PARTNER_ID }]);

    await expect(bindVerifiedTenant(CONNECTION_ID, PARTNER_ID, TENANT_ID, {
      microsoftOid: MICROSOFT_OID,
      breezeUserId: null,
    })).rejects.toThrow(/another partner/i);

    expect(dbMocks.updatedValues).toHaveLength(0);
  });

  it('fails closed when the pending same-partner connection does not exist', async () => {
    dbMocks.insertResults.push([{ partnerId: PARTNER_ID }]);
    dbMocks.selectResults.push([{ partnerId: PARTNER_ID }]);
    dbMocks.updateResults.push([]);

    await expect(bindVerifiedTenant(CONNECTION_ID, PARTNER_ID, TENANT_ID, {
      microsoftOid: MICROSOFT_OID,
      breezeUserId: USER_ID,
    })).rejects.toThrow(/pending mailbox connection/i);
  });

  it('prevents the generic status setter from activating a connection', async () => {
    await expect(setConnectionStatus(CONNECTION_ID, PARTNER_ID, 'connected', null))
      .rejects.toThrow(/bindVerifiedTenant/);
    expect(dbMocks.updatedValues).toHaveLength(0);
  });

  it('returns an exact public list DTO with no tenant or processing internals', async () => {
    const publicRow = {
      id: CONNECTION_ID,
      mailboxAddress: 'support@example.com',
      displayName: 'Support',
      status: 'connected',
      lastPolledAt: fullRow.lastPolledAt,
      lastMessageAt: fullRow.lastMessageAt,
    };
    dbMocks.selectResults.push([publicRow]);

    const result = await listMailboxConnections(PARTNER_ID);

    expect(result).toEqual([publicRow]);
    expect(Object.keys(result[0]!)).toEqual([
      'id', 'mailboxAddress', 'displayName', 'status', 'lastPolledAt', 'lastMessageAt',
    ]);
    expect(Object.keys(dbMocks.selectedFields[0] ?? {})).toEqual([
      'id', 'mailboxAddress', 'displayName', 'status', 'lastPolledAt', 'lastMessageAt',
    ]);
  });

  it('only lists active mailboxes whose tenant ownership matches both tenant and partner', async () => {
    const connectedRow = {
      id: CONNECTION_ID,
      partnerId: PARTNER_ID,
      tenantId: TENANT_ID,
      mailboxAddress: 'support@example.com',
      deltaLink: 'secret-cursor',
    };
    dbMocks.selectResults.push([connectedRow]);

    await expect(listConnectedMailboxes()).resolves.toEqual([connectedRow]);

    expect(dbMocks.innerJoins).toEqual([{
      table: ticketMailboxTenantOwnerships,
      condition: {
        op: 'and',
        conditions: [
          { op: 'eq', column: ticketMailboxConnections.tenantId, value: ticketMailboxTenantOwnerships.tenantId },
          { op: 'eq', column: ticketMailboxConnections.partnerId, value: ticketMailboxTenantOwnerships.partnerId },
        ],
      },
    }]);
    expect(Object.keys(dbMocks.selectedFields[0] ?? {})).toEqual([
      'id', 'partnerId', 'tenantId', 'mailboxAddress', 'deltaLink',
    ]);
    expect(contextMocks.runOutside).toHaveBeenCalledOnce();
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
  });
});

describe('probeMailbox', () => {
  beforeEach(() => fetchMock.mockReset());

  it('returns ok on a 200 from the mailbox messages endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ value: [] }) });
    const r = await probeMailbox(TENANT_ID, 'support@a.com');
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/users/support%40a.com/messages?%24top=1'),
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('returns an error string on 403 (access policy not scoped)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'denied' });
    const r = await probeMailbox(TENANT_ID, 'support@a.com');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/403/);
  });
});
