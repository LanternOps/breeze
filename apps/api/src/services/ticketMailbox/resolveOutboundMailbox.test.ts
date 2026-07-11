import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockConnectionJoin,
  mockUnjoinedConnections,
  mockInboundRows,
  mockInboundSelect,
} = vi.hoisted(() => ({
  mockConnectionJoin: vi.fn(),
  mockUnjoinedConnections: vi.fn(),
  mockInboundRows: vi.fn(),
  mockInboundSelect: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: (selection: Record<string, unknown>) => {
      if ('tenantId' in selection) {
        return {
          from: () => ({
            // The unjoined path represents the vulnerable behavior: a connected
            // row exists even though no verified ownership row matches it.
            where: () => ({ limit: async () => mockUnjoinedConnections() }),
            innerJoin: () => ({
              where: () => ({ limit: async () => mockConnectionJoin() }),
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

describe('resolveOutboundMailbox', () => {
  const verifiedConnection = { tenantId: 'ten', mailboxAddress: 'support@a.com' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionJoin.mockResolvedValue([verifiedConnection]);
    mockUnjoinedConnections.mockResolvedValue([verifiedConnection]);
    mockInboundRows.mockResolvedValue([]);
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
