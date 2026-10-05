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
    'message-headers': '[["Auto-Submitted","no"],["Content-Type","text/plain; charset=UTF-8"]]'
  };
  it('maps recipient/sender/subject and prefers stripped-text', async () => {
    const n = await provider.parse({ parseBody: async () => fields } as any);
    expect(n.to).toBe('acme@tickets.example.com');
    expect(n.from).toBe('jane@customer.com');
    expect(n.fromName).toBe('Jane Doe');
    expect(n.subject).toContain('T-2026-0001');
    expect(n.text).toBe('It is still broken.'); // stripped-text wins over body-plain
    // Staff-forward detection reads the unstripped plain body (quoted blocks kept).
    expect(n.forwardScanText).toBe('It is still broken.\n> previous quoted text');
    expect(n.references).toEqual(['<msg-0@x>', '<msg-1@tickets.example.com>']);
    expect(n.providerMessageId).toBe('<msg-2@customer.com>');
  });

  it('exposes no forwardScanText when the envelope sender differs from the visible From', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      sender: 'bounces+xyz@relay.example',
      from: 'Tech <tech@msp.example>',
    }) } as any);
    expect(n.from).toBe('bounces+xyz@relay.example');
    expect(n.forwardScanText).toBeUndefined();
    // Same address in both (case and display name aside): scanned as usual.
    const same = await provider.parse({ parseBody: async () => ({
      ...fields,
      sender: 'Tech@MSP.example',
      from: 'Tech <tech@msp.example>',
    }) } as any);
    expect(same.forwardScanText).toBe(fields['body-plain']);
  });

  // The envelope/From comparison must use the RFC 5322 mailbox, never an address
  // that merely appears inside a quoted display name or a comment.
  it.each([
    ['a quoted display name containing an address', '"Tech <tech@msp.example>" <attacker@evil.example>'],
    ['a comment containing an address', 'attacker@evil.example (Tech <tech@msp.example>)'],
    ['a quoted display name before a bare address', '"Tech <tech@msp.example>" attacker@evil.example'],
  ])('does not treat %s as the visible From', async (_label, from) => {
    const n = await provider.parse({ parseBody: async () => ({ ...fields, sender: 'tech@msp.example', from }) } as any);
    expect(n.forwardScanText).toBeUndefined();
    expect(n.fromName).not.toBe('Tech');
  });

  it('does not match when the visible From holds more than one mailbox', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields, sender: 'tech@msp.example', from: 'tech@msp.example, attacker@evil.example',
    }) } as any);
    expect(n.forwardScanText).toBeUndefined();
  });

  it.each([
    ['a normal display name', 'Tech <tech@msp.example>', 'Tech'],
    ['a bare address', 'tech@msp.example', undefined],
    ['a quoted display name with escapes and a comma', '"Doe, \\"Tech\\"" <tech@msp.example>', 'Doe, "Tech"'],
  ])('matches the envelope sender for %s', async (_label, from, name) => {
    const n = await provider.parse({ parseBody: async () => ({ ...fields, sender: 'tech@msp.example', from }) } as any);
    expect(n.from).toBe('tech@msp.example');
    expect(n.fromName).toBe(name);
    expect(n.forwardScanText).toBe(fields['body-plain']);
  });

  // Mailgun synthesizes body-plain from the HTML when a message has no text/plain
  // part, so its body-plain alone does not prove a provider-supplied plain body.
  it('exposes no forwardScanText for an HTML-only message (top-level text/html)', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields, 'message-headers': '[["Content-Type","text/html; charset=UTF-8"]]',
    }) } as any);
    expect(n.text).toBe('It is still broken.');
    expect(n.forwardScanText).toBeUndefined();
  });

  it('exposes no forwardScanText when the top-level Content-Type is unknown', async () => {
    for (const headers of [undefined, '[]', 'not json']) {
      const n = await provider.parse({ parseBody: async () => ({ ...fields, 'message-headers': headers }) } as any);
      expect(n.forwardScanText).toBeUndefined();
    }
  });

  it.each([
    'text/plain; charset=UTF-8',
    'multipart/alternative; boundary="b1"',
    'multipart/mixed; boundary="b2"',
  ])('exposes forwardScanText for a %s message', async (contentType) => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields, 'message-headers': JSON.stringify([['Content-Type', contentType]]),
    }) } as any);
    expect(n.forwardScanText).toBe(fields['body-plain']);
  });

  it('exposes no forwardScanText when the envelope sender is missing or null', async () => {
    const { sender: _omit, ...withoutSender } = fields;
    const missing = await provider.parse({ parseBody: async () => withoutSender } as any);
    expect(missing.from).toBe('jane@customer.com'); // routing still falls back to From
    expect(missing.forwardScanText).toBeUndefined();
    for (const nullSender of ['', '<>']) {
      const n = await provider.parse({ parseBody: async () => ({ ...fields, sender: nullSender }) } as any);
      expect(n.forwardScanText).toBeUndefined();
    }
  });

  it('reads a null Return-Path header as the bounce marker', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': '[["Return-Path","<>"]]'
    }) } as any);
    expect(n.returnPath).toBe('<>');
  });

  it('derives <> from a null envelope sender when the Return-Path header is absent', async () => {
    // A bounce/NDR uses a null SMTP MAIL FROM, which Mailgun surfaces as an empty
    // `sender` form field; with no Return-Path header this is the only bounce signal.
    const empty = await provider.parse({ parseBody: async () => ({
      ...fields, sender: '', 'message-headers': '[["Auto-Submitted","no"]]'
    }) } as any);
    expect(empty.returnPath).toBe('<>');
    const literal = await provider.parse({ parseBody: async () => ({
      ...fields, sender: '<>', 'message-headers': '[["Auto-Submitted","no"]]'
    }) } as any);
    expect(literal.returnPath).toBe('<>');
  });

  it('does NOT treat an ordinary envelope sender as a bounce', async () => {
    // Normal mail: real MAIL FROM, no Return-Path header -> returnPath undefined,
    // so ticketCreationLoopReason never suppresses it as a null-return-path bounce.
    const n = await provider.parse({ parseBody: async () => ({
      ...fields, 'message-headers': '[["Auto-Submitted","no"]]'
    }) } as any);
    expect(n.returnPath).toBeUndefined();
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

  // senderAuthDiagnostic distinguishes the SILENT-quarantine failure modes (no usable Mailgun
  // verdict) from an ordinary DMARC fail, so a Mailgun host/format change is observable instead
  // of looking like routine spam rejection.
  it('sets no diagnostic when a genuine Mailgun DMARC verdict was read (pass)', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': JSON.stringify([['Authentication-Results', 'mxa.mailgun.org; dmarc=pass']])
    }) } as any);
    expect(n.senderAuthDiagnostic).toBeUndefined();
  });

  it('sets no diagnostic on a genuine Mailgun DMARC fail (real verdict, not a gap)', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': JSON.stringify([['Authentication-Results', 'mxa.mailgun.org; dmarc=fail']])
    }) } as any);
    expect(n.senderAuthDiagnostic).toBeUndefined();
  });

  it('flags no-mailgun-authserv when no Mailgun-family Authentication-Results header is present', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': JSON.stringify([['Authentication-Results', 'protection.outlook.com; dmarc=pass']])
    }) } as any);
    expect(n.senderAuthDiagnostic).toBe('no-mailgun-authserv');
  });

  it('flags no-mailgun-authserv when message-headers is absent', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      recipient: 'acme@tickets.example.com', sender: 'jane@customer.com', subject: 'x', 'stripped-text': 'y'
    }) } as any);
    expect(n.senderAuthDiagnostic).toBe('no-mailgun-authserv');
  });

  it('flags headers-unparseable when message-headers is present but not valid JSON', async () => {
    const n = await provider.parse({ parseBody: async () => ({
      ...fields,
      'message-headers': '{not valid json'
    }) } as any);
    expect(n.senderAuthDiagnostic).toBe('headers-unparseable');
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
