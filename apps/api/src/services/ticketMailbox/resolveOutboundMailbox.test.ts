import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockConnectionJoin,
  mockUnjoinedConnections,
  mockInboundRows,
  mockInboundSelect,
  mockConnectionJoins,
  mockConnectionWheres,
} = vi.hoisted(() => ({
  mockConnectionJoin: vi.fn(),
  mockUnjoinedConnections: vi.fn(),
  mockInboundRows: vi.fn(),
  mockInboundSelect: vi.fn(),
  mockConnectionJoins: [] as Array<{ table: unknown; condition: unknown }>,
  mockConnectionWheres: [] as unknown[],
}));

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
    eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })),
  };
});

vi.mock('../../db', () => ({
  db: {
    select: (selection: Record<string, unknown>) => {
      if ('tenantId' in selection) {
        return {
          from: () => ({
            // The unjoined path represents the vulnerable behavior: a connected
            // row exists even though no verified ownership row matches it.
            where: (condition: unknown) => ({
              limit: async () => {
                mockConnectionWheres.push(condition);
                return mockUnjoinedConnections();
              },
            }),
            innerJoin: (table: unknown, condition: unknown) => ({
              where: (whereCondition: unknown) => ({
                limit: async () => {
                  mockConnectionJoins.push({ table, condition });
                  mockConnectionWheres.push(whereCondition);
                  return mockConnectionJoin();
                },
              }),
            }),
          }),
        };
      }

      mockInboundSelect();
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => mockInboundRows() }),
          }),
        }),
      };
    },
  },
}));

import { resolveOutboundMailbox } from './resolveOutboundMailbox';
import {
  ticketMailboxConnections,
  ticketMailboxTenantOwnerships,
} from '../../db/schema/ticketMailbox';

describe('resolveOutboundMailbox', () => {
  const verifiedConnection = { tenantId: 'ten', mailboxAddress: 'support@a.com' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionJoin.mockResolvedValue([verifiedConnection]);
    mockUnjoinedConnections.mockResolvedValue([verifiedConnection]);
    mockInboundRows.mockResolvedValue([]);
    mockConnectionJoins.length = 0;
    mockConnectionWheres.length = 0;
  });

  it('returns null when the partner has no connected mailbox', async () => {
    mockConnectionJoin.mockResolvedValue([]);
    mockUnjoinedConnections.mockResolvedValue([]);
    expect(await resolveOutboundMailbox('t1', 'p1')).toBeNull();
  });

  it('returns null without querying inbound mail when ownership is unverified', async () => {
    mockConnectionJoin.mockResolvedValue([]);

    expect(await resolveOutboundMailbox('t1', 'p1')).toBeNull();
    expect(mockInboundSelect).not.toHaveBeenCalled();
  });

  it('requires same-tenant, same-partner ownership and a connected row for the requested partner', async () => {
    await resolveOutboundMailbox('t1', 'p1');

    expect(mockConnectionJoins).toEqual([{
      table: ticketMailboxTenantOwnerships,
      condition: {
        op: 'and',
        conditions: [
          { op: 'eq', column: ticketMailboxTenantOwnerships.tenantId, value: ticketMailboxConnections.tenantId },
          { op: 'eq', column: ticketMailboxTenantOwnerships.partnerId, value: ticketMailboxConnections.partnerId },
        ],
      },
    }]);
    expect(mockConnectionWheres).toEqual([{
      op: 'and',
      conditions: [
        { op: 'eq', column: ticketMailboxConnections.partnerId, value: 'p1' },
        { op: 'eq', column: ticketMailboxConnections.status, value: 'connected' },
      ],
    }]);
  });

  it('returns mailbox + originalMessageId from the latest m365 inbound row', async () => {
    mockInboundRows.mockResolvedValue([{ providerMessageId: 'graph-77' }]);
    const r = await resolveOutboundMailbox('t1', 'p1');
    expect(r).toEqual({ tenantId: 'ten', mailbox: 'support@a.com', originalMessageId: 'graph-77' });
  });

  it('returns originalMessageId null when no m365 inbound row exists', async () => {
    const r = await resolveOutboundMailbox('t1', 'p1');
    expect(r?.originalMessageId).toBeNull();
  });

  it('returns null when partnerId is null', async () => {
    expect(await resolveOutboundMailbox('t1', null)).toBeNull();
  });
});
