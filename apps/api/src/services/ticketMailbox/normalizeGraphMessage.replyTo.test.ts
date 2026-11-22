import { describe, it, expect } from 'vitest';
import { normalizeGraphMessage } from './normalizeGraphMessage';
import type { GraphMessage } from './graphMailClient';

// Email-first replies W1 (Refs #8758): Graph's structured `replyTo` recipients.
const msg: GraphMessage = {
  id: 'AAA-graph-id',
  internetMessageId: '<abc@mail.x.com>',
  subject: 'Contact form',
  from: { emailAddress: { address: 'no-reply@forms.example', name: 'Web Form' } },
  toRecipients: [{ emailAddress: { address: 'support@a.com' } }],
  body: { contentType: 'text', content: 'Please call me.' },
  internetMessageHeaders: [],
};

describe('normalizeGraphMessage Reply-To', () => {
  it('parses a single Reply-To', () => {
    const n = normalizeGraphMessage(
      { ...msg, replyTo: [{ emailAddress: { address: 'Jane@Customer.Example', name: 'Jane' } }] },
      'partner-9', 'support@a.com',
    );
    expect(n.replyTo).toBe('jane@customer.example');
    // From stays the identity.
    expect(n.from).toBe('no-reply@forms.example');
  });

  it('ignores a multi-address Reply-To', () => {
    const n = normalizeGraphMessage(
      { ...msg, replyTo: [{ emailAddress: { address: 'a@customer.example' } }, { emailAddress: { address: 'b@customer.example' } }] },
      'partner-9', 'support@a.com',
    );
    expect(n.replyTo).toBeUndefined();
  });

  it('ignores a malformed Reply-To', () => {
    const n = normalizeGraphMessage(
      { ...msg, replyTo: [{ emailAddress: { address: 'not an address' } }] },
      'partner-9', 'support@a.com',
    );
    expect(n.replyTo).toBeUndefined();
  });

  it('ignores a Reply-To equal to the receiving mailbox (loop guard)', () => {
    const n = normalizeGraphMessage(
      { ...msg, replyTo: [{ emailAddress: { address: 'Support@A.com' } }] },
      'partner-9', 'support@a.com',
    );
    expect(n.replyTo).toBeUndefined();
  });

  // A mailbox connected before replyTo joined the delta $select keeps polling its
  // stored delta link, which carries the old $select: no `replyTo` property. The
  // Reply-To header (internetMessageHeaders was always selected) is the fallback.
  it('falls back to the Reply-To header when Graph omits the replyTo property', () => {
    const n = normalizeGraphMessage(
      { ...msg, internetMessageHeaders: [{ name: 'Reply-To', value: 'Jane <Jane@Customer.Example>' }] },
      'partner-9', 'support@a.com',
    );
    expect(n.replyTo).toBe('jane@customer.example');
  });

  it('header fallback: two Reply-To headers, a list, or the mailbox itself mean none', () => {
    const withHeaders = (values: string[]) => normalizeGraphMessage(
      { ...msg, internetMessageHeaders: values.map((value) => ({ name: 'Reply-To', value })) },
      'partner-9', 'support@a.com',
    ).replyTo;
    expect(withHeaders(['a@customer.example', 'b@customer.example'])).toBeUndefined();
    expect(withHeaders(['a@customer.example, b@customer.example'])).toBeUndefined();
    expect(withHeaders(['support@a.com'])).toBeUndefined();
  });

  it('the structured replyTo wins when Graph returns it, even empty', () => {
    const n = normalizeGraphMessage(
      { ...msg, replyTo: [], internetMessageHeaders: [{ name: 'Reply-To', value: 'jane@customer.example' }] },
      'partner-9', 'support@a.com',
    );
    expect(n.replyTo).toBeUndefined();
  });

  it('has no Reply-To when Graph reports none', () => {
    expect(normalizeGraphMessage({ ...msg, replyTo: [] }, 'partner-9', 'support@a.com').replyTo).toBeUndefined();
    expect(normalizeGraphMessage(msg, 'partner-9', 'support@a.com').replyTo).toBeUndefined();
  });
});
