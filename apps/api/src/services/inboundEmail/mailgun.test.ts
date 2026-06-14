import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Hoist a controllable getConfig mock so individual tests can override the key.
const { getConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(() => ({ MAILGUN_INBOUND_SIGNING_KEY: 'test-signing-key' as string | undefined }))
}));

vi.mock('../../config/validate', () => ({ getConfig: getConfigMock }));

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

  beforeEach(() => {
    // Reset to the default signed-key config before each test.
    getConfigMock.mockReturnValue({ MAILGUN_INBOUND_SIGNING_KEY: 'test-signing-key' });
  });

  it('accepts a valid signature with a current timestamp', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000)), token = 'abc';
    const ok = await provider.verify(reqWith({ timestamp, token, signature: sign(timestamp, token) }));
    expect(ok).toBe(true);
  });
  it('rejects a tampered signature', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const ok = await provider.verify(reqWith({ timestamp, token: 'abc', signature: 'deadbeef' }));
    expect(ok).toBe(false);
  });
  it('rejects when signing fields are absent', async () => {
    expect(await provider.verify(reqWith({}))).toBe(false);
  });
  it('rejects a correctly-signed but stale timestamp (replay guard)', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 4000), token = 'abc';
    const ok = await provider.verify(reqWith({ timestamp, token, signature: sign(timestamp, token) }));
    expect(ok).toBe(false);
  });

  // TEST 5a — missing signing key: verify returns false (fail-closed-when-unconfigured).
  it('rejects (false) when MAILGUN_INBOUND_SIGNING_KEY is not configured', async () => {
    // Simulate the env var being absent — the key is undefined.
    getConfigMock.mockReturnValue({ MAILGUN_INBOUND_SIGNING_KEY: undefined });

    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = 'abc';
    // Build a correct signature using the key we know (even though the server has no key).
    const validSig = sign(timestamp, token);

    // Must return false — no key configured → fail closed even with a "correct" signature.
    const ok = await provider.verify(reqWith({ timestamp, token, signature: validSig }));
    expect(ok).toBe(false);
  });

  // TEST 5b — non-numeric timestamp: the Number.isFinite guard rejects it.
  it('rejects a non-numeric timestamp (Number.isFinite guard)', async () => {
    const timestamp = 'abc'; // non-numeric — passes Number() = NaN, Number.isFinite = false
    const token = 'xyz';
    // Build the HMAC over this non-numeric timestamp so the signature check passes
    // and only the isFinite guard is the rejection cause.
    const validSigOverNonNumeric = sign(timestamp, token);

    const ok = await provider.verify(reqWith({ timestamp, token, signature: validSigOverNonNumeric }));
    expect(ok).toBe(false);
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

  it('derives a STABLE providerMessageId fallback across retries when Message-Id is absent', async () => {
    // Same envelope, different signing `timestamp` (provider retry), no Message-Id.
    const base = {
      recipient: 'acme@tickets.example.com',
      sender: 'jane@customer.com',
      from: 'Jane Doe <jane@customer.com>',
      subject: 'printer down',
      'stripped-text': 'It is broken.'
    };
    const n1 = await provider.parse({ parseBody: async () => ({ ...base, timestamp: '1700000000' }) } as any);
    const n2 = await provider.parse({ parseBody: async () => ({ ...base, timestamp: '1700009999' }) } as any);
    expect(n1.providerMessageId).toMatch(/^sha256:/);
    expect(n1.providerMessageId).toBe(n2.providerMessageId); // stable across retries -> dedup works
  });
});
