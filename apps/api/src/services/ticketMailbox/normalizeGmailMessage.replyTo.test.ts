import { describe, it, expect } from 'vitest';
import type { gmail_v1 } from '@googleapis/gmail';
import { normalizeGmailMessage } from './normalizeGmailMessage';

// Email-first replies W1 (Refs #8758): Gmail's Reply-To header, every instance.
const SUB = '104729382910';
const MAILBOX = 'help@example.com';

function message(headers: gmail_v1.Schema$MessagePartHeader[]): gmail_v1.Schema$Message {
  return {
    id: 'gmsg-1',
    threadId: 'gthread-1',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Return-Path', value: '<bounce@forms.example>' },
        { name: 'From', value: 'Web Form <no-reply@forms.example>' },
        ...headers,
      ],
      body: { data: Buffer.from('Please call me.', 'utf8').toString('base64url') },
    },
  };
}

describe('normalizeGmailMessage Reply-To', () => {
  it('parses a single Reply-To', () => {
    const n = normalizeGmailMessage(message([{ name: 'Reply-To', value: 'Jane <Jane@Customer.Example>' }]), 'p', MAILBOX, SUB);
    expect(n.replyTo).toBe('jane@customer.example');
    // From stays the identity.
    expect(n.from).toBe('no-reply@forms.example');
  });

  it('ignores a multi-address Reply-To', () => {
    const n = normalizeGmailMessage(message([{ name: 'Reply-To', value: 'a@customer.example, b@customer.example' }]), 'p', MAILBOX, SUB);
    expect(n.replyTo).toBeUndefined();
  });

  it('ignores a second Reply-To header', () => {
    const n = normalizeGmailMessage(message([
      { name: 'Reply-To', value: 'a@customer.example' },
      { name: 'reply-to', value: 'b@customer.example' },
    ]), 'p', MAILBOX, SUB);
    expect(n.replyTo).toBeUndefined();
  });

  it('ignores a malformed Reply-To', () => {
    const n = normalizeGmailMessage(message([{ name: 'Reply-To', value: 'jane@' }]), 'p', MAILBOX, SUB);
    expect(n.replyTo).toBeUndefined();
  });

  it('ignores a Reply-To equal to the connected mailbox (loop guard)', () => {
    const n = normalizeGmailMessage(message([{ name: 'Reply-To', value: MAILBOX.toUpperCase() }]), 'p', MAILBOX, SUB);
    expect(n.replyTo).toBeUndefined();
  });

  it('has no Reply-To when the header is absent', () => {
    expect(normalizeGmailMessage(message([]), 'p', MAILBOX, SUB).replyTo).toBeUndefined();
  });
});
