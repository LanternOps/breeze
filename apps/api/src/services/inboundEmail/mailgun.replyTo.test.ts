import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/validate', () => ({ getConfig: () => ({}) }));

import { normalizeMailgunForm } from './mailgun';

// Email-first replies W1 (Refs #8758): Mailgun's Reply-To is read from the
// message-headers JSON, every instance, so a duplicated header is visible.
describe('normalizeMailgunForm Reply-To', () => {
  const base = {
    recipient: 'acme@tickets.example.com',
    sender: 'bounce@forms.example',
    from: 'Web Form <no-reply@forms.example>',
    subject: 'Contact form',
    'stripped-text': 'Please call me.',
    'Message-Id': '<form-1@forms.example>',
  };
  const withHeaders = (headers: [string, string][]) => ({ ...base, 'message-headers': JSON.stringify(headers) });

  it('parses a single Reply-To', () => {
    const n = normalizeMailgunForm(withHeaders([['Reply-To', 'Jane <Jane@Customer.Example>']]));
    expect(n.replyTo).toBe('jane@customer.example');
    // From stays the identity.
    expect(n.from).toBe('no-reply@forms.example');
  });

  it('ignores a multi-address Reply-To', () => {
    expect(normalizeMailgunForm(withHeaders([['Reply-To', 'a@customer.example, b@customer.example']])).replyTo)
      .toBeUndefined();
  });

  it('ignores a second Reply-To header', () => {
    expect(normalizeMailgunForm(withHeaders([['Reply-To', 'a@customer.example'], ['reply-to', 'b@customer.example']])).replyTo)
      .toBeUndefined();
  });

  it('ignores a malformed Reply-To', () => {
    expect(normalizeMailgunForm(withHeaders([['Reply-To', 'not an address']])).replyTo).toBeUndefined();
  });

  it('ignores a Reply-To equal to the inbound recipient (loop guard)', () => {
    expect(normalizeMailgunForm(withHeaders([['Reply-To', 'ACME@tickets.example.com']])).replyTo).toBeUndefined();
  });

  it('has no Reply-To when message-headers is missing or unreadable', () => {
    expect(normalizeMailgunForm(base).replyTo).toBeUndefined();
    expect(normalizeMailgunForm({ ...base, 'message-headers': 'not json' }).replyTo).toBeUndefined();
  });
});
