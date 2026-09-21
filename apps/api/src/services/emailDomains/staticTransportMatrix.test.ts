import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spec §14, "Transport matrix for `static`" — the self-hosted acceptance test.
 *
 * Everything between sendEmail and the wire is production code: the real
 * resolver, the real sendOnPartnerLane, the real registry, the real `static`
 * adapter and the real deliverRaw transport bodies. Only the identity lookup
 * (a database read) and the sockets are mocked.
 *
 * The second half is the one that matters most for a self-hoster: an operator
 * who lists a domain the relay will not actually send as (Microsoft 365 SendAs
 * rights revoked, Postfix sender maps edited) must see the invoice arrive from
 * EMAIL_FROM, not vanish (spec §13, "`static`: the relay refuses the custom
 * sender").
 */

const { resendSendMock, createTransportMock, smtpSendMailMock, fetchMock, lookupMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(),
  createTransportMock: vi.fn(),
  smtpSendMailMock: vi.fn(),
  fetchMock: vi.fn(),
  lookupMock: vi.fn(),
}));

vi.mock('../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('resend', () => ({ Resend: class MockResend { emails = { send: resendSendMock }; } }));
vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));
vi.mock('./partnerLaneLookup', () => ({ lookupPartnerLaneIdentity: lookupMock }));
vi.mock('../../jobs/sendingDomainsWorker', () => ({ enqueueSyncDomain: vi.fn(async () => undefined) }));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: vi.fn(async () => true), isOpsAlertingConfigured: () => false }));

const PARTNER = '11111111-1111-1111-1111-111111111111';
const DEFAULT_FROM = '"Acme IT" <helpdesk@acme.test>';
const PARTNER_FROM = '"Acme Billing" <billing@acme.test>';

const IDENTITY = {
  ok: true as const, partnerName: 'Acme MSP', localPart: 'billing', displayName: 'Acme Billing',
  replyTo: null, domainId: 'd1', domain: 'acme.test',
};

const originalEnv = { ...process.env };

function resetEmailEnv() {
  for (const key of [
    'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER',
    'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'MAILGUN_API_KEY', 'MAILGUN_DOMAIN',
    'MAILGUN_BASE_URL', 'MAILGUN_FROM', 'SMTP_TIMEOUT_MS', 'MAILGUN_TIMEOUT_MS',
    'EMAIL_DOMAINS_PROVIDER', 'EMAIL_DOMAINS_STATIC_ALLOWED', 'EMAIL_DOMAINS_DAILY_SEND_CAP',
    'EMAIL_DOMAINS_PARTNER_ALLOWLIST', 'IS_HOSTED',
  ]) delete process.env[key];
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  resetEmailEnv();
  // The operator's attestation: this relay may send as acme.test. `static` is
  // self-hosted only, so IS_HOSTED stays unset.
  process.env.EMAIL_DOMAINS_PROVIDER = 'static';
  process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'acme.test';
  process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = '0';
  process.env.EMAIL_FROM = DEFAULT_FROM;
  lookupMock.mockResolvedValue(IDENTITY);
  resendSendMock.mockResolvedValue({ error: null });
  smtpSendMailMock.mockResolvedValue({ messageId: 'smtp-1' });
  createTransportMock.mockReturnValue({ sendMail: smtpSendMailMock });
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue('ok') });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { resetEmailDomainProviderForTests } = await import('./providerRegistry');
  resetEmailDomainProviderForTests();
});

afterAll(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
});

async function service() {
  const { getEmailService } = await import('../email');
  return getEmailService()!;
}

const MESSAGE = {
  to: 'ap@customer.test',
  subject: 'Invoice INV-2026-0007',
  html: '<p>Your invoice is attached.</p>',
  text: 'Your invoice is attached.',
} as const;

async function sendInvoice() {
  await (await service()).sendEmail({
    ...MESSAGE, purpose: 'invoice.sent', partnerId: PARTNER, partnerName: 'Acme MSP',
  });
}

describe('static + EMAIL_PROVIDER=resend', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test';
  });

  it('sends from the partner address, marked as our own outbound', async () => {
    await sendInvoice();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const sent = resendSendMock.mock.calls[0]![0];
    expect(sent.from).toBe(PARTNER_FROM);
    expect(sent.headers['X-Breeze-Outbound']).toBe('1');
  });

  it('falls back to EMAIL_FROM when the account refuses the sender', async () => {
    resendSendMock
      .mockResolvedValueOnce({ error: { name: 'validation_error', statusCode: 403, message: 'The acme.test domain is not verified.' } })
      .mockResolvedValueOnce({ error: null });
    await sendInvoice();
    expect(resendSendMock).toHaveBeenCalledTimes(2);
    const fallback = resendSendMock.mock.calls[1]![0];
    expect(fallback.from).toBe('"Acme MSP" <helpdesk@acme.test>');
    expect(fallback.headers?.['X-Breeze-Outbound']).toBeUndefined();
  });
});

describe('static + EMAIL_PROVIDER=smtp', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.acme.test';
  });

  it('sends from the partner address, marked as our own outbound', async () => {
    await sendInvoice();
    expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
    const sent = smtpSendMailMock.mock.calls[0]![0];
    expect(sent.from).toBe(PARTNER_FROM);
    expect(sent.headers['X-Breeze-Outbound']).toBe('1');
  });

  // The canonical self-hosted failure: Microsoft 365 SendAs rights revoked.
  it('falls back to EMAIL_FROM on 550 5.7.60', async () => {
    smtpSendMailMock
      .mockRejectedValueOnce(Object.assign(
        new Error('Message failed: 550 5.7.60 SMTP; Client does not have permissions to send as this sender'),
        { responseCode: 550, response: '550 5.7.60 SMTP; Client does not have permissions to send as this sender' },
      ))
      .mockResolvedValueOnce({ messageId: 'smtp-2' });
    await sendInvoice();
    expect(smtpSendMailMock).toHaveBeenCalledTimes(2);
    const fallback = smtpSendMailMock.mock.calls[1]![0];
    expect(fallback.from).toBe('"Acme MSP" <helpdesk@acme.test>');
    expect(fallback.headers?.['X-Breeze-Outbound']).toBeUndefined();
  });

  it('does NOT fall back on a recipient refusal — the message, not the domain, was wrong', async () => {
    smtpSendMailMock.mockRejectedValue(Object.assign(
      new Error('550 5.1.1 User unknown'),
      { responseCode: 550, response: '550 5.1.1 User unknown' },
    ));
    await expect(sendInvoice()).rejects.toThrow();
    expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on a transient 4xx — a deferral is ambiguous, never definitively unsent', async () => {
    smtpSendMailMock.mockRejectedValue(Object.assign(
      new Error('421 4.7.0 Try again later'),
      { responseCode: 421, response: '421 4.7.0 Try again later' },
    ));
    await expect(sendInvoice()).rejects.toThrow();
    expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
  });
});

describe('static + EMAIL_PROVIDER=mailgun', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'mg-key';
    process.env.MAILGUN_DOMAIN = 'mg.acme.test';
  });

  function bodyOf(callIndex: number) {
    return new URLSearchParams(String(fetchMock.mock.calls[callIndex]![1].body ?? ''));
  }

  it('sends from the partner address, marked as our own outbound', async () => {
    await sendInvoice();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).get('from')).toBe(PARTNER_FROM);
    expect(bodyOf(0).get('h:X-Breeze-Outbound')).toBe('1');
  });

  it('falls back to EMAIL_FROM when Mailgun refuses the sending domain', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 403, text: vi.fn().mockResolvedValue('{"message":"The domain is not verified. Please verify your domain."}') })
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue('ok') });
    await sendInvoice();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).get('from')).toBe('"Acme MSP" <helpdesk@acme.test>');
    expect(bodyOf(1).get('h:X-Breeze-Outbound')).toBeNull();
  });
});

describe('static with the domain delisted', () => {
  it('never reaches the partner lane at all when the operator removes the domain', async () => {
    // Spec §13: rows move to failed/provider_rejected on the next boot, but the
    // resolver is the immediate control — the identity's domain is no longer
    // sendable, so the message goes out on the platform lane.
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test';
    lookupMock.mockResolvedValue({ ok: false, reason: 'domain_not_sendable' });
    await sendInvoice();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock.mock.calls[0]![0].from).toBe('"Acme MSP" <helpdesk@acme.test>');
  });
});
