import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../../config/validate', () => ({ getConfig: () => ({ MAILGUN_INBOUND_SIGNING_KEY: 'test-signing-key' }) }));

import { MailgunInboundProvider } from './mailgun';

const SIGNING_KEY = 'test-signing-key';
const sign = (timestamp: string, token: string) =>
  createHmac('sha256', SIGNING_KEY).update(timestamp + token).digest('hex');

// Minimal HonoRequest stub exposing parseBody()
function reqWith(fields: Record<string, string>) {
  return { parseBody: async () => fields } as unknown as import('hono').HonoRequest;
}

describe('MailgunInboundProvider.verify', () => {
  const provider = new MailgunInboundProvider();
  it('accepts a valid signature', async () => {
    const timestamp = '1700000000', token = 'abc';
    const ok = await provider.verify(reqWith({ timestamp, token, signature: sign(timestamp, token) }));
    expect(ok).toBe(true);
  });
  it('rejects a tampered signature', async () => {
    const ok = await provider.verify(reqWith({ timestamp: '1700000000', token: 'abc', signature: 'deadbeef' }));
    expect(ok).toBe(false);
  });
  it('rejects when signing fields are absent', async () => {
    expect(await provider.verify(reqWith({}))).toBe(false);
  });
});

describe('MailgunInboundProvider.parse', () => {
  const provider = new MailgunInboundProvider();
  const fields = {
    recipient: 'acme@tickets.example.com',
    sender: 'jane@customer.com',
    from: 'Jane Doe <jane@customer.com>',
    subject: 'Re: [T-2026-0001] printer down',
    'body-plain': 'It is still broken.\n> previous quoted text',
    'stripped-text': 'It is still broken.',
    'Message-Id': '<msg-2@customer.com>',
    'In-Reply-To': '<msg-1@tickets.example.com>',
    'References': '<msg-0@x> <msg-1@tickets.example.com>',
    'message-headers': '[["Auto-Submitted","no"]]'
  };
  it('maps recipient/sender/subject and prefers stripped-text', async () => {
    const n = await provider.parse({ parseBody: async () => fields } as any);
    expect(n.to).toBe('acme@tickets.example.com');
    expect(n.from).toBe('jane@customer.com');
    expect(n.fromName).toBe('Jane Doe');
    expect(n.subject).toContain('T-2026-0001');
    expect(n.text).toBe('It is still broken.'); // stripped-text wins over body-plain
    expect(n.references).toEqual(['<msg-0@x>', '<msg-1@tickets.example.com>']);
    expect(n.providerMessageId).toBe('<msg-2@customer.com>');
  });
});
