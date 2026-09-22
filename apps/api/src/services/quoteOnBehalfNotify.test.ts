import { describe, it, expect, vi, beforeEach } from 'vitest';

// Queue-driven db chain: every awaited query shifts the next staged row set.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

const sendEmail = vi.fn();
const getEmailService = vi.fn(() => ({ sendEmail }));
vi.mock('./email', async (importActual) => ({
  ...(await importActual<typeof import('./email')>()),
  getEmailService: () => getEmailService(),
}));

const captureException = vi.fn();
vi.mock('./sentry', () => ({ captureException: (e: unknown) => captureException(e) }));

import { db } from '../db';
import {
  notifyCustomerOfOnBehalfAcceptance,
  buildOnBehalfAcceptanceTemplate,
} from './quoteOnBehalfNotify';

const QUOTE = {
  id: 'q1', orgId: 'o1', partnerId: 'p1', quoteNumber: 'Q-1001',
  acceptedAt: new Date('2026-09-22T15:00:00Z'),
};
const PARTNER_ON = {
  notify: true, name: 'Acme MSP', billingEmail: 'billing@acme.example', emailSignature: 'The Acme team',
};

function res(overrides: Record<string, unknown> = {}) {
  return {
    quote: QUOTE, invoiceIssued: true, invoiceNumber: 'INV-0042', origin: 'on_behalf' as const,
    ...overrides,
  } as Parameters<typeof notifyCustomerOfOnBehalfAcceptance>[0];
}

describe('notifyCustomerOfOnBehalfAcceptance (#6635)', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    getEmailService.mockImplementation(() => ({ sendEmail }));
    sendEmail.mockResolvedValue(undefined);
  });

  it('never fires for a customer-origin accept — not even a partner read', async () => {
    const out = await notifyCustomerOfOnBehalfAcceptance(res({ origin: 'customer' }));
    expect(out).toEqual({ sent: false, reason: 'not_on_behalf' });
    expect((db as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not send when the partner setting is off (the default)', async () => {
    queueResult([{ ...PARTNER_ON, notify: false }]);
    const out = await notifyCustomerOfOnBehalfAcceptance(res());
    expect(out).toEqual({ sent: false, reason: 'disabled' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends to the quote recipients, partner-branded, when on + on_behalf', async () => {
    queueResult([PARTNER_ON]);
    queueResult([{ email: ' Pat@Customer.example ' }, { email: 'pat@customer.example' }, { email: 'ops@customer.example' }]);
    const out = await notifyCustomerOfOnBehalfAcceptance(res());
    expect(out).toEqual({ sent: true, recipients: ['pat@customer.example', 'ops@customer.example'] });
    expect(sendEmail).toHaveBeenCalledOnce();
    const msg = sendEmail.mock.calls[0]![0];
    expect(msg).toMatchObject({
      to: ['pat@customer.example', 'ops@customer.example'],
      purpose: 'quote.sent',
      partnerId: 'p1',
      partnerName: 'Acme MSP',
      replyTo: 'billing@acme.example',
      subject: 'Your acceptance of Q-1001 was recorded',
    });
    for (const body of [msg.html, msg.text]) {
      expect(body).toContain('Acme MSP');
      expect(body).toContain('Q-1001');
      expect(body).toContain('September 22, 2026');
      expect(body).toContain('INV-0042');
      expect(body).toContain('If this is wrong, reply to this email.');
    }
  });

  it('falls back to the org billing contact when the quote has no recipients', async () => {
    queueResult([PARTNER_ON]);
    queueResult([]);
    queueResult([{ billingContact: { email: 'ap@customer.example' } }]);
    const out = await notifyCustomerOfOnBehalfAcceptance(res());
    expect(out).toEqual({ sent: true, recipients: ['ap@customer.example'] });
    expect(sendEmail.mock.calls[0]![0].to).toEqual(['ap@customer.example']);
  });

  it('skips with a logged reason when no recipient is known', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queueResult([PARTNER_ON]);
    queueResult([]);
    queueResult([{ billingContact: null }]);
    const out = await notifyCustomerOfOnBehalfAcceptance(res());
    expect(out).toEqual({ sent: false, reason: 'no_recipients' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => c.join(' ').includes('reason=no_recipients'))).toBe(true);
    warn.mockRestore();
  });

  it('skips when no email service is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getEmailService.mockImplementation(() => null as never);
    queueResult([PARTNER_ON]);
    queueResult([{ email: 'pat@customer.example' }]);
    const out = await notifyCustomerOfOnBehalfAcceptance(res());
    expect(out).toEqual({ sent: false, reason: 'no_email_service' });
    warn.mockRestore();
  });

  it('swallows a transport failure (the accept is already committed) and captures it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queueResult([PARTNER_ON]);
    queueResult([{ email: 'pat@customer.example' }]);
    sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    const out = await notifyCustomerOfOnBehalfAcceptance(res());
    expect(out).toEqual({ sent: false, reason: 'send_failed' });
    expect(captureException).toHaveBeenCalledOnce();
    err.mockRestore();
  });
});

describe('buildOnBehalfAcceptanceTemplate (#6635)', () => {
  it('omits the invoice line when no invoice was issued', () => {
    const t = buildOnBehalfAcceptanceTemplate({
      partnerName: 'Acme MSP', quoteNumber: 'Q-1001', acceptedDate: 'September 22, 2026', invoiceNumber: null,
    });
    expect(t.subject).toBe('Your acceptance of Q-1001 was recorded');
    expect(t.text).not.toMatch(/invoice/i);
    expect(t.html).not.toMatch(/invoice/i);
  });

  it('escapes the partner name and quote number in the HTML', () => {
    const t = buildOnBehalfAcceptanceTemplate({
      partnerName: '<b>Evil</b>', quoteNumber: 'Q-<1>', acceptedDate: 'September 22, 2026', invoiceNumber: null,
    });
    expect(t.html).not.toContain('<b>Evil</b>');
    expect(t.html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });
});
