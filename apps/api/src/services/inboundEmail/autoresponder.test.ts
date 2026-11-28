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
  withDbTransaction: (fn: () => unknown) => fn(),
  withDbTransactionIfHeld: (fn: () => unknown) => fn(),
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

  // Email-first replies W1: the guarded Reply-To (ingest cleared any own address)
  // is where the acknowledgement goes. Suppression and the cap apply to the
  // sender (From) AND to that recipient, so a Reply-To can only narrow who is
  // acknowledged, never aim acknowledgements at a third party past the cap.
  it('autoresponse goes to the Reply-To', async () => {
    await maybeSendAutoresponse(n({ replyTo: 'jane.home@customer.example' }), 'p-1', ticket);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]![0].payload.to).toBe('jane.home@customer.example');
    expect(rateLimiterMock.mock.calls.map((c) => c[1])).toEqual([
      'autoresponse:p-1:jane@x.com',
      'autoresponse:p-1:jane.home@customer.example',
    ]);
  });

  it('suppresses when the Reply-To recipient is capped, even if the sender is not', async () => {
    rateLimiterMock
      .mockResolvedValueOnce({ allowed: true, remaining: 1, resetAt: new Date() })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
    await maybeSendAutoresponse(n({ replyTo: 'victim@elsewhere.example' }), 'p-1', ticket);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('suppresses when the Reply-To recipient is a system address', async () => {
    await maybeSendAutoresponse(n({ replyTo: 'no-reply@forms.example' }), 'p-1', ticket);
    expect(emitMock).not.toHaveBeenCalled();
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
    expect(rateLimiterMock).toHaveBeenCalledWith(expect.anything(), 'autoresponse:p-1:jane@x.com', 5, 3600);
  });

  it('fails CLOSED (suppresses the autoresponse) when the Redis cap throws — never poisons the work tx', async () => {
    // The cap check runs inside processInboundEmail's system-context transaction. A
    // Redis error must SUPPRESS the autoresponse, never propagate into the tx.
    rateLimiterMock.mockRejectedValue(new Error('redis down'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await expect(maybeSendAutoresponse(n(), 'p-1', ticket)).resolves.toBeUndefined();
      expect(emitMock).not.toHaveBeenCalled();
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith('[InboundEmail] autoresponse suppressed', expect.objectContaining({ reason: 'rate-capped' }));
    } finally {
      infoSpy.mockRestore();
    }
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
    expect(rateLimiterMock).toHaveBeenLastCalledWith(expect.anything(), 'autoresponse:p-1:jane@x.com', 5, 3600);

    // Simulate the cap now being full for that key — the second variant is suppressed.
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    emitMock.mockClear();
    await maybeSendAutoresponse(n({ from: 'JANE@x.COM' }), 'p-1', ticket);
    expect(rateLimiterMock).toHaveBeenLastCalledWith(expect.anything(), 'autoresponse:p-1:jane@x.com', 5, 3600);
    expect(emitMock).not.toHaveBeenCalled();
  });
});

// #12201 — behavioural cap tests. An in-memory sliding-window stand-in for
// rateLimiter that honours the key, limit and window the autoresponder passes,
// so these assertions discriminate on the key shape AND the configured limit
// rather than on a canned allowed/denied answer.
describe('maybeSendAutoresponse — per-sender, per-partner cap (#12201)', () => {
  let hits: Map<string, number[]>;
  let now: number;

  const ticketFor = (partnerId: string, id: string) => ({ ...ticket, id, partnerId });

  beforeEach(() => {
    hits = new Map();
    now = Date.UTC(2026, 10, 18, 12, 0, 0);
    rateLimiterMock.mockImplementation(async (_redis: unknown, key: string, limit: number, windowSeconds: number) => {
      const windowStart = now - windowSeconds * 1000;
      const kept = (hits.get(key) ?? []).filter((t) => t > windowStart);
      kept.push(now);
      hits.set(key, kept);
      return { allowed: kept.length <= limit, remaining: Math.max(0, limit - kept.length), resetAt: new Date(now + windowSeconds * 1000) };
    });
  });

  it('acknowledges two tickets from the same sender a few minutes apart (same partner)', async () => {
    await maybeSendAutoresponse(n(), 'p-1', ticketFor('p-1', 't-a'));
    now += 20 * 60 * 1000; // 20 minutes later — the reported case
    await maybeSendAutoresponse(n(), 'p-1', ticketFor('p-1', 't-b'));
    expect(emitMock.mock.calls.map((c) => c[0].ticketId)).toEqual(['t-a', 't-b']);
  });

  it('keeps independent counters per partner — the same sender is acknowledged by each partner', async () => {
    // Exhaust partner p-1's budget for this sender…
    for (let i = 0; i < 5; i += 1) {
      await maybeSendAutoresponse(n(), 'p-1', ticketFor('p-1', `t-p1-${i}`));
    }
    emitMock.mockClear();
    // …a different partner's mailbox still acknowledges the same sender.
    await maybeSendAutoresponse(n({ from: 'JANE@x.com' }), 'p-2', ticketFor('p-2', 't-p2'));
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]![0].partnerId).toBe('p-2');
  });

  it('suppresses the 6th autoresponse within the hour for the same sender + partner (reason rate-capped)', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      for (let i = 0; i < 6; i += 1) {
        await maybeSendAutoresponse(n(), 'p-1', ticketFor('p-1', `t-${i}`));
        now += 5 * 60 * 1000; // 6 sends over 25 minutes
      }
      expect(emitMock.mock.calls.map((c) => c[0].ticketId)).toEqual(['t-0', 't-1', 't-2', 't-3', 't-4']);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith('[InboundEmail] autoresponse suppressed', expect.objectContaining({ reason: 'rate-capped', ticketId: 't-5' }));
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('acknowledges again once the hour window has slid past the burst', async () => {
    for (let i = 0; i < 6; i += 1) {
      await maybeSendAutoresponse(n(), 'p-1', ticketFor('p-1', `t-${i}`));
    }
    expect(emitMock).toHaveBeenCalledTimes(5);
    emitMock.mockClear();
    now += 61 * 60 * 1000;
    await maybeSendAutoresponse(n(), 'p-1', ticketFor('p-1', 't-later'));
    expect(emitMock).toHaveBeenCalledTimes(1);
  });
});
