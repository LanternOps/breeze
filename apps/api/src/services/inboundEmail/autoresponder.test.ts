import { describe, it, expect, vi, beforeEach } from 'vitest';

const { emitMock, rateLimiterMock, getRedisMock, captureExceptionMock, partnerSettingsRows, dbSelectThrows } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  rateLimiterMock: vi.fn().mockResolvedValue({ allowed: true, remaining: 0, resetAt: new Date() }),
  getRedisMock: vi.fn(() => ({})),
  captureExceptionMock: vi.fn(),
  partnerSettingsRows: { value: [{ settings: {} }] as Array<{ settings: unknown }> },
  // When true, the settings-lookup chain rejects (simulates a transient DB error /
  // aborted tx) so the FIX 1 guard's fail-closed path can be exercised.
  dbSelectThrows: { value: false },
}));

vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
vi.mock('../ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('../rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../redis', () => ({ getRedis: getRedisMock }));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            dbSelectThrows.value
              ? Promise.reject(new Error('settings lookup failed (aborted tx)'))
              : Promise.resolve(partnerSettingsRows.value),
        }),
      }),
    }),
  },
}));
vi.mock('../../db/schema', () => ({ partners: { id: 'id', settings: 'settings' } }));

import { maybeSendAutoresponse } from './autoresponder';
import type { NormalizedInboundEmail } from './types';

const ticket = { id: 't-1', orgId: 'o-1', partnerId: 'p-1', internalNumber: 'T-2026-0001', subject: 'printer' };
function n(over: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
  return { provider: 'mailgun', providerMessageId: 'm', to: 'acme@tickets.example.com', from: 'jane@x.com', subject: 's', text: 't', attachments: [], raw: {}, ...over };
}

beforeEach(() => {
  emitMock.mockClear(); rateLimiterMock.mockClear(); getRedisMock.mockClear(); captureExceptionMock.mockClear();
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 0, resetAt: new Date() });
  getRedisMock.mockReturnValue({});
  partnerSettingsRows.value = [{ settings: {} }];
  dbSelectThrows.value = false;
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

  it('fails CLOSED (suppresses the autoresponse) when the Redis cap throws — never poisons the work tx', async () => {
    // The cap check runs inside processInboundEmail's system-context transaction. A
    // Redis error must SUPPRESS the autoresponse, never propagate into the tx.
    rateLimiterMock.mockRejectedValue(new Error('redis down'));
    await expect(maybeSendAutoresponse(n(), 'p-1', ticket)).resolves.toBeUndefined();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('fails CLOSED (suppresses) when the autoresponderEnabled settings read throws — never rolls back ticket creation (FIX 1)', async () => {
    // autoresponderEnabled() runs INSIDE processInboundEmail's work transaction. A
    // transient settings-lookup error (or an already-aborted tx) must SUPPRESS the
    // autoresponse, not propagate up through createFromEmail and roll back the
    // just-created ticket. The guarded read returns false (disabled) on any throw.
    dbSelectThrows.value = true;
    await expect(maybeSendAutoresponse(n(), 'p-1', ticket)).resolves.toBeUndefined();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('keys the per-sender cap on the LOWERCASED sender (case-variant senders share one budget)', async () => {
    // First send (mixed-case) consumes the budget; the cap key is lowercased so the
    // second send (different case, same address) hits the SAME Redis key.
    await maybeSendAutoresponse(n({ from: 'Jane@X.com' }), 'p-1', ticket);
    expect(rateLimiterMock).toHaveBeenLastCalledWith(expect.anything(), 'autoresponse:jane@x.com', 1, 86400);

    // Simulate the cap now being full for that key — the second variant is suppressed.
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    emitMock.mockClear();
    await maybeSendAutoresponse(n({ from: 'JANE@x.COM' }), 'p-1', ticket);
    expect(rateLimiterMock).toHaveBeenLastCalledWith(expect.anything(), 'autoresponse:jane@x.com', 1, 86400);
    expect(emitMock).not.toHaveBeenCalled();
  });
});
