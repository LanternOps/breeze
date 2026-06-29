import { describe, it, expect, vi, beforeEach } from 'vitest';

const connRows = vi.fn();
const inboundRows = vi.fn();
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => connRows(),
          orderBy: () => ({ limit: async () => inboundRows() }),
        }),
      }),
    }),
  },
}));

import { resolveOutboundMailbox } from './resolveOutboundMailbox';

describe('resolveOutboundMailbox', () => {
  beforeEach(() => { connRows.mockReset(); inboundRows.mockReset(); });

  it('returns null when the partner has no connected mailbox', async () => {
    connRows.mockResolvedValue([]);
    expect(await resolveOutboundMailbox('t1', 'p1')).toBeNull();
  });

  it('returns mailbox + originalMessageId from the latest m365 inbound row', async () => {
    connRows.mockResolvedValue([{ tenantId: 'ten', mailboxAddress: 'support@a.com' }]);
    inboundRows.mockResolvedValue([{ providerMessageId: 'graph-77' }]);
    const r = await resolveOutboundMailbox('t1', 'p1');
    expect(r).toEqual({ tenantId: 'ten', mailbox: 'support@a.com', originalMessageId: 'graph-77' });
  });

  it('returns originalMessageId null when no m365 inbound row exists', async () => {
    connRows.mockResolvedValue([{ tenantId: 'ten', mailboxAddress: 'support@a.com' }]);
    inboundRows.mockResolvedValue([]);
    const r = await resolveOutboundMailbox('t1', 'p1');
    expect(r?.originalMessageId).toBeNull();
  });

  it('returns null when partnerId is null', async () => {
    expect(await resolveOutboundMailbox('t1', null)).toBeNull();
  });
});
