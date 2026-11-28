import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockConnectionJoin,
  mockInboundRows,
  mockInboundSelect,
  mockConnectionJoins,
  mockConnectionWheres,
  mockInboundWheres,
} = vi.hoisted(() => ({
  mockConnectionJoin: vi.fn(),
  mockInboundRows: vi.fn(),
  mockInboundSelect: vi.fn(),
  mockConnectionJoins: [] as Array<{ table: unknown; condition: unknown }>,
  mockConnectionWheres: [] as unknown[],
  mockInboundWheres: [] as unknown[],
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
        // Connections are only ever read through the tenant-ownership join: a
        // connected row with no verified ownership row must never resolve.
        return {
          from: () => ({
            innerJoin: (table: unknown, condition: unknown) => ({
              where: (whereCondition: unknown) => ({
                orderBy: () => ({
                  limit: async () => {
                    mockConnectionJoins.push({ table, condition });
                    mockConnectionWheres.push(whereCondition);
                    return mockConnectionJoin();
                  },
                }),
              }),
            }),
          }),
        };
      }

      mockInboundSelect();
      return {
        from: () => ({
          where: (whereCondition: unknown) => ({
            orderBy: () => ({
              limit: async () => {
                mockInboundWheres.push(whereCondition);
                return mockInboundRows();
              },
            }),
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
import { ticketEmailInbound } from '../../db/schema/emailInbound';

describe('resolveOutboundMailbox', () => {
  const supportA = { tenantId: 'ten', mailboxAddress: 'support@a.com' };
  const helpdeskA = { tenantId: 'ten', mailboxAddress: 'helpdesk@a.com' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionJoin.mockResolvedValue([supportA]);
    mockInboundRows.mockResolvedValue([]);
    mockConnectionJoins.length = 0;
    mockConnectionWheres.length = 0;
    mockInboundWheres.length = 0;
  });

  it('returns null when the partner has no connected mailbox', async () => {
    mockConnectionJoin.mockResolvedValue([]);
    expect(await resolveOutboundMailbox('t1', 'p1')).toBeNull();
  });

  it('returns null without querying inbound mail when ownership is unverified', async () => {
    mockConnectionJoin.mockResolvedValue([]);

    expect(await resolveOutboundMailbox('t1', 'p1')).toBeNull();
    expect(mockInboundSelect).not.toHaveBeenCalled();
  });

  it('gmail-only partner resolves no graph mailbox', async () => {
    // Decision 9: a Gmail connection has no ticket_mailbox_tenant_ownerships row,
    // so the ownership inner join returns nothing for a Gmail-only partner.
    mockConnectionJoin.mockResolvedValue([]);
    expect(await resolveOutboundMailbox('t1', 'p1')).toBeNull();
    expect(mockConnectionJoins).toHaveLength(1);
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

  it("reads only this ticket's m365 inbound rows under the same partner", async () => {
    await resolveOutboundMailbox('t1', 'p1');
    expect(mockInboundWheres).toEqual([{
      op: 'and',
      conditions: [
        { op: 'eq', column: ticketEmailInbound.ticketId, value: 't1' },
        { op: 'eq', column: ticketEmailInbound.partnerId, value: 'p1' },
        { op: 'eq', column: ticketEmailInbound.provider, value: 'm365' },
      ],
    }]);
  });

  it('returns mailbox + originalMessageId from the latest m365 inbound row', async () => {
    mockInboundRows.mockResolvedValue([{ providerMessageId: 'graph-77', toAddress: 'support@a.com' }]);
    const r = await resolveOutboundMailbox('t1', 'p1');
    expect(r).toEqual({ tenantId: 'ten', mailbox: 'support@a.com', originalMessageId: 'graph-77' });
  });

  it('two connections: picks the mailbox that ingested the ticket', async () => {
    mockConnectionJoin.mockResolvedValue([supportA, helpdeskA]);
    mockInboundRows.mockResolvedValue([{ providerMessageId: 'graph-88', toAddress: 'HelpDesk@A.com' }]);
    const r = await resolveOutboundMailbox('t1', 'p1');
    expect(r).toEqual({ tenantId: 'ten', mailbox: 'helpdesk@a.com', originalMessageId: 'graph-88' });
  });

  it('receiving mailbox disconnected: returns null', async () => {
    // The ticket came in through helpdesk@, which is no longer connected. Another
    // mailbox is, but it must not reply on a message that lives in helpdesk@.
    mockConnectionJoin.mockResolvedValue([supportA]);
    mockInboundRows.mockResolvedValue([{ providerMessageId: 'graph-88', toAddress: 'helpdesk@a.com' }]);
    expect(await resolveOutboundMailbox('t1', 'p1')).toBeNull();
  });

  it('receiving mailbox unknown (no to_address on the row): returns null', async () => {
    mockInboundRows.mockResolvedValue([{ providerMessageId: 'graph-88', toAddress: null }]);
    expect(await resolveOutboundMailbox('t1', 'p1')).toBeNull();
  });

  it('returns originalMessageId null when no m365 inbound row exists', async () => {
    const r = await resolveOutboundMailbox('t1', 'p1');
    expect(r).toEqual({ tenantId: 'ten', mailbox: 'support@a.com', originalMessageId: null });
  });

  it('no inbound row + two connections: oldest connection, no thread', async () => {
    // The query orders connections by created_at, id; the first row is the oldest.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockConnectionJoin.mockResolvedValue([helpdeskA, supportA]);
    const r = await resolveOutboundMailbox('t1', 'p-two');
    expect(r).toEqual({ tenantId: 'ten', mailbox: 'helpdesk@a.com', originalMessageId: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('2');
    warn.mockRestore();
  });

  it('returns null when partnerId is null', async () => {
    expect(await resolveOutboundMailbox('t1', null)).toBeNull();
  });
});
