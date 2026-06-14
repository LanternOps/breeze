import { describe, it, expect, vi, beforeEach } from 'vitest';

const { emitMock, rateLimiterMock, getRedisMock, partnerSettingsRows } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  rateLimiterMock: vi.fn().mockResolvedValue({ allowed: true, remaining: 0, resetAt: new Date() }),
  getRedisMock: vi.fn(() => ({})),
  partnerSettingsRows: { value: [{ settings: {} }] as Array<{ settings: unknown }> },
}));

vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
vi.mock('../ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('../rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../redis', () => ({ getRedis: getRedisMock }));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(partnerSettingsRows.value) }) }) }) },
}));
vi.mock('../../db/schema', () => ({ partners: { id: 'id', settings: 'settings' } }));

import { maybeSendAutoresponse } from './autoresponder';
import type { NormalizedInboundEmail } from './types';

const ticket = { id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer' };
function n(over: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
  return { provider: 'mailgun', providerMessageId: 'm', to: 'acme@tickets.example.com', from: 'jane@x.com', subject: 's', text: 't', attachments: [], raw: {}, ...over };
}

beforeEach(() => {
  emitMock.mockClear(); rateLimiterMock.mockClear(); getRedisMock.mockClear();
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 0, resetAt: new Date() });
  getRedisMock.mockReturnValue({});
  partnerSettingsRows.value = [{ settings: {} }];
});

describe('maybeSendAutoresponse', () => {
  it('emits a ticket.autoresponse event for an accepted human sender (default enabled)', async () => {
    await maybeSendAutoresponse(n(), 'p-1', ticket);
    expect(emitMock).toHaveBeenCalledTimes(1);
    const ev = emitMock.mock.calls[0]![0];
    expect(ev.type).toBe('ticket.autoresponse');
    expect(ev.ticketId).toBe('t-1');
    expect(ev.orgId).toBe('o-1');
    expect(ev.partnerId).toBe('p-1');
    expect(ev.payload.to).toBe('jane@x.com');
    expect(ev.payload.internalNumber).toBe('T-2026-0001');
    expect(ev.payload.subject).toBe('printer');
  });

  it('THROWS on a partner mismatch (spec §6 write-boundary re-assertion) and never emits', async () => {
    await expect(maybeSendAutoresponse(n(), 'p-OTHER', ticket)).rejects.toThrow(/partner mismatch/);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('suppresses on a loop-prevention rule (Auto-Submitted)', async () => {
    await maybeSendAutoresponse(n({ autoSubmitted: 'auto-replied' }), 'p-1', ticket);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('does not emit when autoresponderEnabled is false in partner settings', async () => {
    partnerSettingsRows.value = [{ settings: { ticketing: { inbound: { autoresponderEnabled: false } } } }];
    await maybeSendAutoresponse(n(), 'p-1', ticket);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('respects the per-sender Redis cap (denied → no emit)', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    await maybeSendAutoresponse(n(), 'p-1', ticket);
    expect(emitMock).not.toHaveBeenCalled();
    expect(rateLimiterMock).toHaveBeenCalledWith(expect.anything(), 'autoresponse:jane@x.com', 1, 86400);
  });

  it('FAILS OPEN to no-autoresponse when the Redis cap throws (must never poison the work tx)', async () => {
    // The cap check runs inside processInboundEmail's system-context transaction. A
    // Redis error must SUPPRESS the autoresponse, never propagate into the tx.
    rateLimiterMock.mockRejectedValue(new Error('redis down'));
    await expect(maybeSendAutoresponse(n(), 'p-1', ticket)).resolves.toBeUndefined();
    expect(emitMock).not.toHaveBeenCalled();
  });
});
