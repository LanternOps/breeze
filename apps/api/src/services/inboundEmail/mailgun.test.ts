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

  it('reads Mailgun SPF/DKIM/DMARC verdicts and marks an aligned-pass sender verified', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'X-Mailgun-Spf': 'Pass',
      'message-headers': JSON.stringify([
        ['Auto-Submitted', 'no'],
        ['Authentication-Results', 'mx.mailgun.org; dkim=pass header.d=customer.com; dmarc=pass'],
      ])
    }) } as any);
    expect(n.senderAuth).toBeDefined();
    expect(n.senderAuth!.spf).toBe('pass');
    expect(n.senderAuth!.dkim).toBe('pass');
    expect(n.senderAuth!.dmarc).toBe('pass');
    expect(n.senderAuth!.verified).toBe(true);
  });

  it('marks a sender NOT verified when SPF fails and there is no DMARC pass', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'X-Mailgun-Spf': 'Fail',
      'message-headers': JSON.stringify([
        ['Authentication-Results', 'mx.mailgun.org; dkim=fail; dmarc=fail'],
      ])
    }) } as any);
    expect(n.senderAuth!.verified).toBe(false);
  });

  it('verifies on a DMARC pass even when SPF/DKIM are not both present', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'X-Mailgun-Spf': 'Neutral',
      'message-headers': JSON.stringify([
        ['Authentication-Results', 'mx.mailgun.org; dmarc=pass policy.published-domain-policy=reject'],
      ])
    }) } as any);
    expect(n.senderAuth!.dmarc).toBe('pass');
    expect(n.senderAuth!.verified).toBe(true);
  });

  // Mailgun's standard inbound MX hosts are mxa/mxb.mailgun.org (US) and
  // mxa/mxb.eu.mailgun.org (EU) — NOT the bare `mx.mailgun.org`. A genuine verdict
  // stamped under any of these must be trusted (issue: inbound DMARC-pass quarantined).
  it.each([
    'mxa.mailgun.org',
    'mxb.mailgun.org',
    'mxa.eu.mailgun.org',
    'mxb.eu.mailgun.org',
  ])('trusts a DMARC pass stamped by Mailgun receiving host %s', async (authservId) => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': JSON.stringify([
        ['Authentication-Results', `${authservId}; dkim=pass header.d=customer.com; dmarc=pass`],
      ])
    }) } as any);
    expect(n.senderAuth!.dmarc).toBe('pass');
    expect(n.senderAuth!.verified).toBe(true);
  });

  // M365 → Mailgun relays carry TWO Authentication-Results headers: M365 stamps its own
  // (foreign authserv-id) and Mailgun stamps its own. We must scan ALL A-R headers for the
  // Mailgun-authoritative one, not just the first — RFC 8601 guarantees Mailgun strips any
  // inbound A-R bearing its own authserv-id, so only its genuine header survives.
  it('finds the Mailgun verdict when an M365 Authentication-Results header precedes it', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': JSON.stringify([
        ['Authentication-Results', 'protection.outlook.com; dmarc=none; spf=fail'],
        ['Authentication-Results', 'mxa.mailgun.org; dkim=pass header.d=customer.com; dmarc=pass'],
      ])
    }) } as any);
    expect(n.senderAuth!.dmarc).toBe('pass');
    expect(n.senderAuth!.verified).toBe(true);
  });

  it('does NOT trust a mailgun.org-lookalike authserv-id', async () => {
    // `evilmailgun.org` and `mailgun.org.attacker.com` are NOT subdomains of mailgun.org;
    // the label-boundary check must reject both.
    for (const forged of ['evilmailgun.org', 'mailgun.org.attacker.com', 'notmailgun.org']) {
      const n = await provider.parse({ parseBody: async () => ({
        ...fields,
        'message-headers': JSON.stringify([
          ['Authentication-Results', `${forged}; dmarc=pass; spf=pass; dkim=pass`],
        ])
      }) } as any);
      expect(n.senderAuth!.verified).toBe(false);
    }
  });

  // Sibling-host forgery: RFC 8601 only guarantees Mailgun strips inbound A-R headers bearing
  // the RECEIVING instance's own authserv-id. A message relayed through mxa is NOT guaranteed
  // to have a forged `mxb.mailgun.org` header stripped. If the attacker positions that forged
  // DMARC=pass header before the genuine mxa DMARC=fail verdict, first-match selection would
  // wrongly verify a spoofed sender. We must fail closed when trusted verdicts disagree.
  it('does NOT verify when a forged sibling-host DMARC pass conflicts with a genuine DMARC fail', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': JSON.stringify([
        ['Authentication-Results', 'mxb.mailgun.org; dmarc=pass'], // attacker-embedded, not stripped by mxa
        ['Authentication-Results', 'mxa.mailgun.org; dkim=fail; dmarc=fail'], // genuine receiving-host verdict
      ])
    }) } as any);
    expect(n.senderAuth!.verified).toBe(false);
  });

  // Two genuine-looking Mailgun headers that AGREE on pass stay verified (e.g. benign duplication).
  it('verifies when multiple Mailgun-authoritative headers all report DMARC pass', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': JSON.stringify([
        ['Authentication-Results', 'mxa.mailgun.org; dmarc=pass'],
        ['Authentication-Results', 'mxb.mailgun.org; dmarc=pass'],
      ])
    }) } as any);
    expect(n.senderAuth!.verified).toBe(true);
  });

  it('does NOT trust a forged Authentication-Results header with a foreign authserv-id', async () => {
    // An external sender stuffs their own Authentication-Results header claiming a
    // DMARC/SPF/DKIM pass. The authserv-id ("evil.example") is NOT Mailgun's receiving
    // host, and there is no genuine Mailgun-authoritative verdict (no X-Mailgun-* field,
    // no mx.mailgun.org Authentication-Results). The forged header must be ignored, so
    // the sender stays unverified -> quarantined.
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': JSON.stringify([
        ['Authentication-Results', 'evil.example; dmarc=pass; spf=pass; dkim=pass'],
      ])
    }) } as any);
    expect(n.senderAuth!.dmarc).not.toBe('pass');
    expect(n.senderAuth!.verified).toBe(false);
  });

  it('treats absent verdicts as NOT verified (fail closed)', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      recipient: 'acme@tickets.example.com',
      sender: 'jane@customer.com',
      from: 'Jane Doe <jane@customer.com>',
      subject: 'no auth headers',
      'stripped-text': 'hi'
    }) } as any);
    expect(n.senderAuth!.verified).toBe(false);
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
