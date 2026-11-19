import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  selectCalls: 0,
  resolveMx: vi.fn(),
  redisStore: new Map<string, string>(),
}));

function queryChain(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy', 'innerJoin']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return chain;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => queryChain(mocks.queryResults[mocks.selectCalls++] ?? [])),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('node:dns', () => ({ promises: { resolveMx: mocks.resolveMx } }));

const redis = {
  set: vi.fn(async (key: string, value: string) => { mocks.redisStore.set(key, value); return 'OK'; }),
  get: vi.fn(async (key: string) => mocks.redisStore.get(key) ?? null),
  eval: vi.fn(async (_script: string, _keys: number, key: string) => {
    if (mocks.redisStore.get(key) !== 'active') return 0;
    mocks.redisStore.set(key, 'used');
    return 1;
  }),
};

vi.mock('./redis', () => ({ getRedis: vi.fn(() => redis) }));
vi.mock('./opsAlerts', async (orig) => ({ ...(await orig<typeof import('./opsAlerts')>()), sendOpsAlert: vi.fn(async () => true) }));

import { opsText, sendOpsAlert } from './opsAlerts';
import {
  buildEvidenceCard,
  consumeTrustActionToken,
  mintTrustActionToken,
  renderEvidenceCardSummary,
  type EvidenceCard,
  sendEvidenceCard,
  verifyTrustActionToken,
} from './partnerTrustEvidenceCard';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const HOSTILE = '[click](http://evil.example) `x`\n@everyone';
const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';

describe('partner trust action tokens', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.redisStore.clear();
    process.env.JWT_SECRET = 'test-trust-action-secret-at-least-32-characters';
  });

  it('round-trips a signed token and enforces operator binding and single use', async () => {
    const token = mintTrustActionToken(PARTNER_ID, 'approve', OPERATOR_ID);
    await vi.waitFor(() => expect(mocks.redisStore.size).toBe(1));
    const payload = await verifyTrustActionToken(token, OPERATOR_ID);
    expect(payload).toMatchObject({ partnerId: PARTNER_ID, action: 'approve', operatorUserId: OPERATOR_ID });
    expect(await verifyTrustActionToken(token, '33333333-3333-4333-8333-333333333333')).toBeNull();
    expect(await consumeTrustActionToken(payload!.jti)).toBe(true);
    expect(await verifyTrustActionToken(token, OPERATOR_ID)).toBeNull();
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
    const token = mintTrustActionToken(PARTNER_ID, 'suspend', OPERATOR_ID);
    await Promise.resolve();
    vi.setSystemTime(new Date('2026-09-03T12:00:01Z'));
    expect(await verifyTrustActionToken(token, OPERATOR_ID)).toBeNull();
  });
});

describe('buildEvidenceCard', () => {
  beforeEach(() => {
    mocks.selectCalls = 0;
    mocks.resolveMx.mockResolvedValue([{ exchange: 'mx.example.test', priority: 10 }]);
    mocks.queryResults = [
      [{
        id: PARTNER_ID,
        name: 'Fixture MSP',
        slug: 'fixture-msp',
        plan: 'pro',
        status: 'active',
        trustState: 'probation',
        signupIp: '198.51.100.10',
        signupIpClass: 'hosting',
        signupIpAsn: 64500,
        signupIpClassSource: 'offline',
        billingCardholderName: 'Alice Operator',
        billingCardFingerprint: 'fp_same',
        billingDistinctPaymentMethods: 4,
        billingFailedAttempts: 7,
        billingAddressRegion: 'CO',
      }],
      [{ name: 'Alice Operator', email: 'alice@example.test' }],
      [{ hostname: 'server-1', enrollmentIpClass: 'business', isVirtual: true, enrollmentIp: '203.0.113.5' }],
      [{ count: 6 }],
      // W06: the sending-domain read joins the same Promise.all, third, so it
      // takes the queue slot immediately after the denials count.
      [
        { domain: 'mail.acme.test', status: 'verified', verifiedAt: new Date('2026-09-01T00:00:00Z') },
        { domain: 'billing.acme.test', status: 'pending', verifiedAt: null },
      ],
      [{ id: '33333333-3333-4333-8333-333333333333', billingCardFingerprint: 'fp_same' }],
      [{ partnerId: '33333333-3333-4333-8333-333333333333', email: 'other@example.test' }],
    ];
  });

  it('builds all evidence fields in a system DB context and resolves MX', async () => {
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(card).toMatchObject({
      partner: { id: PARTNER_ID, name: 'Fixture MSP', slug: 'fixture-msp', plan: 'pro', status: 'active', trustState: 'probation' },
      signup: { ip: '198.51.100.10', ipClass: 'hosting', asn: 64500, source: 'offline' },
      emailDomain: { domain: 'example.test', ageDays: null, hasMx: true },
      identity: { userName: 'Alice Operator', cardholderName: 'Alice Operator', namesMatch: true },
      billing: { distinctPaymentMethods: 4, failedAttempts: 7, region: 'CO' },
      devices: [{ hostname: 'server-1', enrollmentIpClass: 'business', isVirtual: true, enrollmentIp: '203.0.113.5' }],
      denials24h: 6,
      matchedSuspendedAxes: ['billing_card_fingerprint', 'email_domain'],
    });
    expect(mocks.resolveMx).toHaveBeenCalledWith('example.test');
  });

  it('reports hasMx: null on a DNS error or timeout — distinct from a confirmed absence', async () => {
    mocks.resolveMx.mockRejectedValue(new Error('DNS lookup timed out'));
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(card.emailDomain.hasMx).toBeNull();
  });

  it('reports hasMx: false only for a confirmed empty MX result', async () => {
    mocks.resolveMx.mockResolvedValue([]);
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(card.emailDomain.hasMx).toBe(false);
  });

  it("lists the partner's sending domains with status and verification time", async () => {
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(card.sendingDomains).toEqual([
      { domain: 'mail.acme.test', status: 'verified', verifiedAt: '2026-09-01T00:00:00.000Z' },
      { domain: 'billing.acme.test', status: 'pending', verifiedAt: null },
    ]);
  });

  it('renders the sending domains into the ops-alert text', async () => {
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(renderEvidenceCardSummary(card)).toContain('mail.acme.test (verified)');
  });

  it('says "none" rather than omitting the line when the partner has no sending domain', async () => {
    mocks.queryResults[4] = [];
    const card = await buildEvidenceCard(PARTNER_ID);
    expect(card.sendingDomains).toEqual([]);
    expect(renderEvidenceCardSummary(card)).toContain('Sending domains: none');
  });

  it('escapes tenant-controlled card fields in the ops alert, but not in the email HTML', async () => {
    process.env.JWT_SECRET = 'test-trust-action-secret-at-least-32-characters';
    process.env.PUBLIC_APP_URL = 'https://app.example.test';
    (mocks.queryResults[0]![0] as { name: string }).name = HOSTILE;
    (mocks.queryResults[1]![0] as { name: string }).name = HOSTILE;
    (mocks.queryResults[2]![0] as { hostname: string }).hostname = HOSTILE;
    (mocks.queryResults[4]![0] as { domain: string }).domain = HOSTILE;
    mocks.queryResults.push([{ id: OPERATOR_ID, email: 'op@example.test' }]);
    vi.mocked(sendOpsAlert).mockClear();

    await sendEvidenceCard(PARTNER_ID, 'review_requested');

    const sent = vi.mocked(sendOpsAlert).mock.calls[0]![0];
    for (const text of [sent.title, sent.body]) {
      expect(text).not.toContain('](http');
      expect(text).not.toContain('`x`');
      expect(text).not.toContain('\n@everyone');
    }
    expect(sent.title).toContain(opsText(HOSTILE));
    expect(sent.body).toContain(opsText(HOSTILE));
    expect(sent.body).toContain('https://app.example.test/admin/trust/act?token=');
    // The email HTML escapes for HTML itself; it must not carry markdown backslashes.
    expect(sent.html).toContain('[click](http://evil.example)');
  });

  it.each([['LF', '\n'], ['CRLF', '\r\n'], ['U+2028', '\u2028'], ['U+2029', '\u2029'], ['NEL', '\u0085']])(
    'cannot forge a card field through a %s in tenant text (plain, markdown, HTML)',
    async (_name, nl) => {
      process.env.JWT_SECRET = 'test-trust-action-secret-at-least-32-characters';
      process.env.PUBLIC_APP_URL = 'https://app.example.test';
      const forged = `Acme${nl}Risk: none${nl}Verdict: approve`;
      (mocks.queryResults[0]![0] as { name: string; billingCardholderName: string }).name = forged;
      (mocks.queryResults[0]![0] as { billingCardholderName: string }).billingCardholderName = forged;
      (mocks.queryResults[1]![0] as { name: string }).name = forged;
      (mocks.queryResults[2]![0] as { hostname: string }).hostname = forged;
      (mocks.queryResults[4]![0] as { domain: string }).domain = forged;
      mocks.queryResults.push([{ id: OPERATOR_ID, email: 'op@example.test' }]);
      vi.mocked(sendOpsAlert).mockClear();

      await sendEvidenceCard(PARTNER_ID, 'review_requested');
      const sent = vi.mocked(sendOpsAlert).mock.calls[0]![0];
      const card: EvidenceCard = {
        partner: { id: PARTNER_ID, name: forged, slug: 's', plan: forged, status: forged, trustState: forged },
        signup: { ip: forged, ipClass: forged, asn: 1, source: forged },
        emailDomain: { domain: forged, ageDays: null, hasMx: true },
        identity: { userName: forged, userEmail: null, cardholderName: forged, namesMatch: null },
        billing: { distinctPaymentMethods: 1, failedAttempts: 1, region: null },
        devices: [{ hostname: forged, enrollmentIpClass: forged, isVirtual: false, enrollmentIp: forged }],
        sendingDomains: [{ domain: forged, status: forged, verifiedAt: null }],
        denials24h: 0,
        matchedSuspendedAxes: [],
      };

      const forgedLine = /^(Risk|Verdict):/m;
      const lineBreaks = /[\r\u2028\u2029\u0085]/;
      for (const text of [renderEvidenceCardSummary(card), sent.body, sent.title]) {
        expect(text).not.toMatch(forgedLine);
        expect(text).not.toMatch(lineBreaks);
        expect(text).toContain('Risk: none Verdict: approve');
      }
      // HTML: no raw line break in any cell, and the forged text sits inside
      // a single escaped <td>, not at the start of a row/line of its own.
      const cells = [...sent.html!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]!);
      expect(cells.length).toBeGreaterThan(5);
      for (const cell of cells) expect(cell).not.toMatch(/[\n\r\u2028\u2029\u0085]/);
      expect(sent.html).not.toMatch(forgedLine);
      expect(cells.some((c) => c.includes('Risk: none Verdict: approve'))).toBe(true);
      expect(sent.html).not.toContain('<pre>');
    },
  );

  it('HTML-escapes and length-caps tenant values in the email table', async () => {
    process.env.JWT_SECRET = 'test-trust-action-secret-at-least-32-characters';
    process.env.PUBLIC_APP_URL = 'https://app.example.test';
    (mocks.queryResults[0]![0] as { name: string }).name = `<script>alert(1)</script>${'x'.repeat(500)}`;
    mocks.queryResults.push([{ id: OPERATOR_ID, email: 'op@example.test' }]);
    vi.mocked(sendOpsAlert).mockClear();
    await sendEvidenceCard(PARTNER_ID, 'review_requested');
    const html = vi.mocked(sendOpsAlert).mock.calls[0]![0].html!;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('x'.repeat(200));
  });
});
