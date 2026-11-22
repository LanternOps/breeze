import { describe, it, expect, vi, beforeEach } from 'vitest';

// Rows served per table marker; `fail` makes the next select throw.
const { state } = vi.hoisted(() => ({
  state: {
    rows: {} as Record<string, unknown[]>,
    fail: false,
    queried: [] as string[],
  },
}));

vi.mock('../../db', () => {
  function select() {
    let table = 'unknown';
    const chain = {
      from(t: { __t?: string }) { table = t.__t ?? 'unknown'; return chain; },
      where() { return chain; },
      limit() {
        state.queried.push(table);
        if (state.fail) return Promise.reject(new Error('db down'));
        return Promise.resolve(state.rows[table] ?? []);
      },
    };
    return chain;
  }
  return {
    db: { select: vi.fn(select) },
    withDbTransactionIfHeld: <T,>(fn: () => Promise<T>) => fn(),
  };
});
vi.mock('../../db/schema', () => ({
  partners: { __t: 'partners', id: 'id', slug: 'slug', inboundLocalPart: 'inboundLocalPart', settings: 'settings' },
  partnerInboundDomains: { __t: 'partner_inbound_domains', domain: 'domain' },
  ticketMailboxConnections: { __t: 'ticket_mailbox_connections', mailboxAddress: 'mailboxAddress' },
}));
vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import { guardedReplyTo } from './replyToGuard';
import type { NormalizedInboundEmail } from './types';

function email(replyTo: string | undefined, overrides: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
  return {
    provider: 'mailgun',
    providerMessageId: '<m-1@forms.example>',
    to: 'acme@tickets.example.com',
    from: 'no-reply@forms.example',
    subject: 'Contact form',
    text: 'Please call me.',
    attachments: [],
    raw: {},
    ...(replyTo ? { replyTo } : {}),
    ...overrides,
  };
}

beforeEach(() => {
  state.rows = { partners: [{ slug: 'acme', inboundLocalPart: null, settings: {} }] };
  state.fail = false;
  state.queried = [];
  captureExceptionMock.mockReset();
});

describe('guardedReplyTo (ingest loop guard, email-first replies W1)', () => {
  it('keeps a customer Reply-To', async () => {
    await expect(guardedReplyTo(email('jane@customer.example'), 'p-1')).resolves.toBe('jane@customer.example');
  });

  it('no Reply-To: nothing to store, no query', async () => {
    await expect(guardedReplyTo(email(undefined), 'p-1')).resolves.toBeUndefined();
    expect(state.queried).toEqual([]);
  });

  it('drops a Reply-To equal to the recipient or the sender', async () => {
    await expect(guardedReplyTo(email('acme@tickets.example.com', { to: 'acme@tickets.example.com' }), 'p-1')).resolves.toBeUndefined();
    await expect(guardedReplyTo(email('no-reply@forms.example'), 'p-1')).resolves.toBeUndefined();
  });

  it('drops a Reply-To on the platform inbound domain (any partner)', async () => {
    await expect(guardedReplyTo(email('other-partner@tickets.example.com'), 'p-1')).resolves.toBeUndefined();
  });

  it("drops a Reply-To equal to the partner's configured inbound address", async () => {
    state.rows.partners = [{ slug: 'acme', inboundLocalPart: null, settings: { ticketing: { inbound: { address: 'Help@Acme-MSP.example' } } } }];
    await expect(guardedReplyTo(email('help@acme-msp.example'), 'p-1')).resolves.toBeUndefined();
  });

  it('drops a Reply-To on a partner inbound domain', async () => {
    state.rows.partner_inbound_domains = [{ domain: 'inbound.acme-msp.example' }];
    await expect(guardedReplyTo(email('help@inbound.acme-msp.example'), 'p-1')).resolves.toBeUndefined();
  });

  it('Reply-To equal to the connected mailbox is not stored', async () => {
    state.rows.ticket_mailbox_connections = [{ id: 'conn-1' }];
    await expect(guardedReplyTo(email('support@acme-msp.example'), 'p-1')).resolves.toBeUndefined();
  });

  it('fails closed to no Reply-To (From is used) when the lookup errors', async () => {
    state.fail = true;
    await expect(guardedReplyTo(email('jane@customer.example'), 'p-1')).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
