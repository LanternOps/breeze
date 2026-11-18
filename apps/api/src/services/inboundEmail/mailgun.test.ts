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
    expect(n.references).toEqual(['<msg-0@x>', '<msg-1@tickets.example.com>']);
    expect(n.providerMessageId).toBe('<msg-2@customer.com>');
  });

  // Staff-forward routing runs only for connected Gmail mailboxes: Mailgun's
  // body-plain may be its own text rendering of HTML, so it is never scanned,
  // even for a staff sender whose plain-text forward carries the marker.
  it.each([
    ['text/plain; charset=UTF-8'],
    ['multipart/alternative; boundary="b1"'],
    ['text/html; charset=UTF-8'],
  ])('never exposes forwardScanText (top-level %s, staff sender, forward marker)', async (contentType) => {
    const forward = 'See below.\n\n---------- Forwarded message ---------\nFrom: Jane <jane@client.example>\nDate: Sun, Sep 20, 2026\nSubject: Printer\n\nBroken.';
    const n = await provider.parse({ parseBody: async () => ({
      ...fields, sender: 'tech@msp.example', from: 'Tech <tech@msp.example>',
      'body-plain': forward, 'stripped-text': 'See below.',
      'message-headers': JSON.stringify([['Content-Type', contentType]]),
    }) } as any);
    expect(n.forwardScanText).toBeUndefined();
  });

  // The From display name comes from the RFC 5322 mailbox, never from an address
  // that merely appears inside a quoted display name or a comment.
  it.each([
    ['a quoted display name containing an address', '"Tech <tech@msp.example>" <attacker@evil.example>', 'Tech <tech@msp.example>'],
    ['a comment containing an address', 'attacker@evil.example (Tech <tech@msp.example>)', 'Tech <tech@msp.example>'],
    ['a normal display name', 'Tech <tech@msp.example>', 'Tech'],
    ['a bare address', 'tech@msp.example', undefined],
    ['a quoted display name with escapes and a comma', '"Doe, \\"Tech\\"" <tech@msp.example>', 'Doe, "Tech"'],
  ])('reads the display name for %s', async (_label, from, name) => {
    const { sender: _omit, ...withoutSender } = fields;
    const n = await provider.parse({ parseBody: async () => ({ ...withoutSender, from }) } as any);
    expect(n.fromName).toBe(name);
  });

  it('routes by the From mailbox when there is no envelope sender, never a display-name address', async () => {
    const { sender: _omit, ...withoutSender } = fields;
    const quoted = await provider.parse({ parseBody: async () => ({ ...withoutSender, from: '"Tech <tech@msp.example>" <attacker@evil.example>' }) } as any);
    expect(quoted.from).toBe('attacker@evil.example');
    const plain = await provider.parse({ parseBody: async () => withoutSender } as any);
    expect(plain.from).toBe('jane@customer.com');
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

// The DMARC verdict is computed over the RFC 5322 From header's domain, so the
// pipeline's sender identity must be that From mailbox. The envelope sender
// (MAIL FROM, Mailgun's `sender` field) is kept separately for loop handling only.
describe('MailgunInboundProvider.parse — sender identity', () => {
  const provider = new MailgunInboundProvider();
  const headers = (...ar: string[]) => JSON.stringify(ar.map((v) => ['Authentication-Results', v]));
  const base = {
    recipient: 'acme@tickets.example.com',
    sender: 'jane@customer.com',
    from: 'Mallory <mallory@sender.example>',
    subject: 'hello',
    'stripped-text': 'body',
    'Message-Id': '<m-1@sender.example>',
    'message-headers': headers('mxa.mailgun.org; dmarc=pass (p=REJECT) header.from=sender.example'),
  };
  const parse = (fields: Record<string, string>) => provider.parse({ parseBody: async () => fields } as any);

  it('takes the sender address from the From header, not the envelope sender', async () => {
    const n = await parse(base);
    expect(n.from).toBe('mallory@sender.example');
    expect(n.envelopeFrom).toBe('jane@customer.com');
  });

  it('records the From domain the DMARC pass is for', async () => {
    const n = await parse(base);
    expect(n.senderAuth!.verified).toBe(true);
    expect(n.senderAuth!.authenticatedDomain).toBe('sender.example');
  });

  it('uses the From domain when the DMARC clause names no header.from', async () => {
    const n = await parse({ ...base, 'message-headers': headers('mxa.mailgun.org; dmarc=pass') });
    expect(n.senderAuth!.authenticatedDomain).toBe('sender.example');
  });

  it('records no authenticated domain when the DMARC pass names a different header.from', async () => {
    const n = await parse({ ...base, 'message-headers': headers('mxa.mailgun.org; dmarc=pass header.from=customer.com') });
    expect(n.senderAuth!.authenticatedDomain).toBeNull();
  });

  it('records no authenticated domain when the From header holds more than one mailbox', async () => {
    const n = await parse({ ...base, from: 'mallory@sender.example, jane@customer.com' });
    expect(n.senderAuth!.authenticatedDomain).toBeNull();
  });

  it.each([
    ['two bare addresses', 'jane@customer.com mallory@sender.example'],
    ['two angle addresses', '"x" <jane@customer.com> <mallory@sender.example>'],
  ])('records no authenticated domain for a From header with %s and no header.from', async (_label, from) => {
    const n = await parse({ ...base, from, 'message-headers': headers('mxa.mailgun.org; dmarc=pass') });
    expect(n.senderAuth!.authenticatedDomain).toBeNull();
  });

  it('records no authenticated domain when DMARC did not pass', async () => {
    const n = await parse({ ...base, 'message-headers': headers('mxa.mailgun.org; dmarc=fail header.from=sender.example') });
    expect(n.senderAuth!.verified).toBe(false);
    expect(n.senderAuth!.authenticatedDomain).toBeUndefined();
  });

  it('checks the From header when a second trusted stamp names header.from', async () => {
    const n = await parse({
      ...base,
      from: 'x@other.example <jane@customer.com>',
      'message-headers': headers('mxa.mailgun.org; dmarc=pass', 'mxb.mailgun.org; dmarc=pass header.from=customer.com'),
    });
    expect(n.senderAuth!.authenticatedDomain).toBeNull();
  });

  it('records no authenticated domain when message-headers holds more than one From', async () => {
    const n = await parse({
      ...base,
      from: 'Jane <jane@customer.com>',
      'message-headers': JSON.stringify([
        ['From', 'x@other.example'], ['From', 'Jane <jane@customer.com>'],
        ['Authentication-Results', 'mxa.mailgun.org; dmarc=pass'],
      ]),
    });
    expect(n.senderAuth!.authenticatedDomain).toBeNull();
  });

  it('records no authenticated domain when the message-headers From is on another domain', async () => {
    const n = await parse({
      ...base,
      from: 'Jane <jane@customer.com>',
      'message-headers': JSON.stringify([['From', 'x@other.example'], ['Authentication-Results', 'mxa.mailgun.org; dmarc=pass']]),
    });
    expect(n.senderAuth!.authenticatedDomain).toBeNull();
  });

  it('records no authenticated domain for two message-headers From on the same domain', async () => {
    const n = await parse({
      ...base,
      'message-headers': JSON.stringify([
        ['From', 'Mallory <mallory@sender.example>'], ['From', 'mallory@sender.example'],
        ['Authentication-Results', 'mxa.mailgun.org; dmarc=pass'],
      ]),
    });
    expect(n.senderAuth!.authenticatedDomain).toBeNull();
  });

  it('records no authenticated domain when a message-headers From value is not a string', async () => {
    const n = await parse({
      ...base,
      'message-headers': JSON.stringify([['From', 42], ['Authentication-Results', 'mxa.mailgun.org; dmarc=pass']]),
    });
    expect(n.senderAuth!.authenticatedDomain).toBeNull();
  });

  it('binds when the message-headers From agrees with the form', async () => {
    const n = await parse({
      ...base,
      'message-headers': JSON.stringify([['From', 'Mallory <mallory@sender.example>'], ['Authentication-Results', 'mxa.mailgun.org; dmarc=pass']]),
    });
    expect(n.senderAuth!.authenticatedDomain).toBe('sender.example');
  });

  it.each([
    ['inside a quoted smtp.mailfrom', 'mxa.mailgun.org; spf=pass smtp.mailfrom="dmarc=pass"@other.example; dmarc=fail header.from=sender.example'],
    ['opened by a quoted ; and (', 'mxa.mailgun.org; spf=pass smtp.mailfrom="a; dmarc=pass header.from=sender.example; ("@other.example; dmarc=fail header.from=sender.example'],
    ['inside a comment', 'mxa.mailgun.org; spf=pass (dmarc=pass) smtp.mailfrom=a@other.example; dmarc=fail header.from=sender.example'],
  ])('does not read a dmarc=pass %s', async (_label, ar) => {
    const n = await parse({ ...base, 'message-headers': headers(ar) });
    expect(n.senderAuth!.verified).toBe(false);
  });

  it('verifies a stamp in Mailgun\'s usual format', async () => {
    const n = await parse({ ...base, 'message-headers': headers(
      'mxa.mailgun.org; dkim=pass header.i=@sender.example header.s=s1 header.b=AbCd; '
      + 'spf=pass (mxa.mailgun.org: domain of bounce@sender.example designates 192.0.2.7 as permitted sender) smtp.mailfrom=bounce@sender.example; '
      + 'dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=sender.example',
    ) });
    expect(n.senderAuth).toMatchObject({ verified: true, authenticatedDomain: 'sender.example' });
  });

  it('is not verified when the envelope sender echoed in a comment holds ) ; ( and dmarc=pass', async () => {
    const local = '"x)smtp.mailfrom=a; dmarc=pass header.from=sender.example; (y"';
    const n = await parse({ ...base, 'message-headers': headers(
      `mxa.mailgun.org; spf=pass (mxa.mailgun.org: domain of ${local}@other.example designates 192.0.2.7 as permitted sender) `
      + `smtp.mailfrom=${local}@other.example; dmarc=fail (p=REJECT) header.from=sender.example`,
    ) });
    expect(n.senderAuth!.verified).toBe(false);
  });

  it('is not verified for the no-DMARC-record shape, with or without the envelope sender', async () => {
    const env = '"a);dmarc=pass header.from=sender.example;(b"@other.example';
    const ar = `mxa.mailgun.org; spf=pass (mxa.mailgun.org: domain of ${env} designates 192.0.2.7 as permitted sender) smtp.mailfrom=${env}`;
    expect((await parse({ ...base, sender: env, 'message-headers': headers(ar) })).senderAuth!.verified).toBe(false);
    const { sender: _s, ...noSender } = base;
    expect((await parse({ ...noSender, 'message-headers': headers(ar) })).senderAuth!.verified).toBe(false);
  });

  it('reads no stamp when Mailgun sent no envelope sender', async () => {
    const { sender: _s, ...noSender } = base;
    const n = await parse({ ...noSender, 'message-headers': headers('mxa.mailgun.org; dmarc=pass header.from=sender.example') });
    expect(n.senderAuth!.verified).toBe(false);
    expect(n.senderAuthConsulted).toBe('envelope sender cannot be read unambiguously');
  });

  it('reads stamps for a null envelope sender', async () => {
    const n = await parse({ ...base, sender: '', 'message-headers': headers('mxa.mailgun.org; dmarc=pass header.from=sender.example') });
    expect(n.senderAuth!.verified).toBe(true);
  });

  it('reads no stamp when a DKIM-Signature identity cannot be read unambiguously', async () => {
    const n = await parse({ ...base, 'message-headers': JSON.stringify([
      ['DKIM-Signature', 'v=1; a=rsa-sha256; d=other.example; s=s1; i=a=3Bdmarc=3Dpass@other.example; bh=x; b=y'],
      ['Authentication-Results', 'mxa.mailgun.org; dmarc=pass header.from=sender.example'],
    ]) });
    expect(n.senderAuth!.verified).toBe(false);
    expect(n.senderAuthConsulted).toBe('signature identity cannot be read unambiguously');
  });

  it('reads no stamp when the envelope sender cannot be read unambiguously', async () => {
    const n = await parse({ ...base, sender: 'a(b@other.example', 'message-headers': headers('mxa.mailgun.org; dmarc=pass header.from=sender.example') });
    expect(n.senderAuth!.verified).toBe(false);
    expect(n.senderAuthConsulted).toBe('envelope sender cannot be read unambiguously');
  });

  it('is not verified when any Authentication-Results header cannot be split', async () => {
    const n = await parse({ ...base, 'message-headers': headers(
      'other.example (unterminated; dmarc=pass header.from=sender.example',
      'mxa.mailgun.org; dmarc=pass header.from=sender.example',
    ) });
    expect(n.senderAuth!.verified).toBe(false);
  });

  it('is not verified when a trusted stamp cannot be read, whatever a sibling stamp says', async () => {
    const n = await parse({ ...base, 'message-headers': headers(
      'mxa.mailgun.org; spf=pass smtp.mailfrom="unterminated@other.example; dmarc=fail header.from=sender.example',
      'mxb.mailgun.org; dmarc=pass header.from=sender.example',
    ) });
    expect(n.senderAuth!.verified).toBe(false);
  });

  it('is not verified when one trusted stamp holds both a passing and a failing DMARC clause', async () => {
    const n = await parse({ ...base, 'message-headers': headers('mxa.mailgun.org; dmarc=pass header.from=sender.example; dmarc=fail header.from=sender.example') });
    expect(n.senderAuth!.verified).toBe(false);
  });

  it('keeps the no-Message-Id dedup key on the envelope sender', async () => {
    const { 'Message-Id': _omit, ...noId } = base;
    const a = await parse(noId);
    const b = await parse({ ...noId, from: 'Other <other@sender.example>' });
    expect(a.providerMessageId).toBe(b.providerMessageId);
  });
});
