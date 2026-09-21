import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { resendSendMock, createTransportMock, smtpSendMailMock, fetchMock, captureExceptionMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(),
  createTransportMock: vi.fn(),
  smtpSendMailMock: vi.fn(),
  fetchMock: vi.fn(),
  captureExceptionMock: vi.fn()
}));

vi.mock('./sentry', () => ({ captureException: captureExceptionMock, captureMessage: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class MockResend {
    emails = {
      send: resendSendMock
    };
  }
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: createTransportMock
  },
  createTransport: createTransportMock
}));

const originalEnv = { ...process.env };

function resetEmailEnv() {
  delete process.env.EMAIL_PROVIDER;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
  delete process.env.SMTP_SECURE;
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_DOMAIN;
  delete process.env.MAILGUN_BASE_URL;
  delete process.env.MAILGUN_FROM;
  delete process.env.SMTP_TIMEOUT_MS;
  delete process.env.MAILGUN_TIMEOUT_MS;
}

describe('email service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    resetEmailEnv();

    resendSendMock.mockResolvedValue({ id: 'resend-1' });
    smtpSendMailMock.mockResolvedValue({ messageId: 'smtp-1' });
    createTransportMock.mockReturnValue({
      sendMail: smtpSendMailMock
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('ok')
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
  });

  it('uses Resend in auto mode when resend config is present', async () => {
    process.env.RESEND_API_KEY = 're_test_123';
    process.env.EMAIL_FROM = 'noreply@example.com';

    const { getEmailService } = await import('./email');
    const service = getEmailService();

    expect(service).not.toBeNull();
    await service!.sendEmail({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Hello</p>',
      purpose: 'ops.alert'
    });

    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('uses SMTP when EMAIL_PROVIDER is smtp', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_FROM = 'smtp-from@example.com';
    process.env.SMTP_USER = 'smtp-user';
    process.env.SMTP_PASS = 'smtp-pass';

    const { getEmailService } = await import('./email');
    const service = getEmailService();

    expect(service).not.toBeNull();
    await service!.sendEmail({
      to: ['user@example.com'],
      subject: 'SMTP Test',
      html: '<p>Hello SMTP</p>',
      replyTo: 'help@example.com',
      purpose: 'ops.alert'
    });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      // #3905 — the transport is bounded; see the deadlines describe block.
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 30_000,
      auth: {
        user: 'smtp-user',
        pass: 'smtp-pass'
      }
    });
    expect(smtpSendMailMock).toHaveBeenCalledWith({
      from: 'smtp-from@example.com',
      to: ['user@example.com'],
      subject: 'SMTP Test',
      html: '<p>Hello SMTP</p>',
      text: undefined,
      replyTo: 'help@example.com'
    });
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it('falls back to SMTP in auto mode when resend is not configured', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.EMAIL_FROM = 'fallback-from@example.com';

    const { getEmailService } = await import('./email');
    const service = getEmailService();

    expect(service).not.toBeNull();
    await service!.sendEmail({
      to: 'user@example.com',
      subject: 'Auto SMTP',
      html: '<p>Auto SMTP</p>',
      purpose: 'ops.alert'
    });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(smtpSendMailMock).toHaveBeenCalledWith({
      from: 'fallback-from@example.com',
      to: 'user@example.com',
      subject: 'Auto SMTP',
      html: '<p>Auto SMTP</p>',
      text: undefined,
      replyTo: undefined
    });
  });

  it('returns null when SMTP credentials are partially configured', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'smtp-from@example.com';
    process.env.SMTP_USER = 'smtp-user';
    delete process.env.SMTP_PASS;

    const { getEmailService } = await import('./email');
    const service = getEmailService();

    expect(service).toBeNull();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('uses Mailgun when EMAIL_PROVIDER is mailgun', async () => {
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'mg-key-123';
    process.env.MAILGUN_DOMAIN = 'mg.example.com';
    process.env.MAILGUN_FROM = 'mailgun-from@example.com';
    process.env.MAILGUN_BASE_URL = 'https://api.eu.mailgun.net/';

    const { getEmailService } = await import('./email');
    const service = getEmailService();

    expect(service).not.toBeNull();
    await service!.sendEmail({
      to: ['a@example.com', 'b@example.com'],
      subject: 'Mailgun Test',
      html: '<p>Hello Mailgun</p>',
      text: 'Hello Mailgun',
      replyTo: ['support@example.com', 'help@example.com'],
      purpose: 'ops.alert'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
    expect(options?.method).toBe('POST');
    expect(options?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded'
    });
    expect(String((options?.headers as Record<string, string>).Authorization)).toContain('Basic ');

    const body = new URLSearchParams(String(options?.body ?? ''));
    expect(body.get('from')).toBe('mailgun-from@example.com');
    expect(body.get('subject')).toBe('Mailgun Test');
    expect(body.get('html')).toBe('<p>Hello Mailgun</p>');
    expect(body.get('text')).toBe('Hello Mailgun');
    expect(body.getAll('to')).toEqual(['a@example.com', 'b@example.com']);
    expect(body.getAll('h:Reply-To')).toEqual(['support@example.com', 'help@example.com']);
  });

  it('sendEmailChanged notifies the old address with a security notice', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'smtp-from@example.com';

    const { getEmailService } = await import('./email');
    const service = getEmailService();

    expect(service).not.toBeNull();
    await service!.sendEmailChanged({
      to: 'old@example.com',
      name: 'Jane Operator',
      newEmail: 'new@example.com'
    });

    expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
    const sent = smtpSendMailMock.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(sent.to).toBe('old@example.com');
    expect(sent.subject).toMatch(/email was changed/i);
    // The new address appears in both HTML and text bodies.
    expect(sent.html).toContain('new@example.com');
    expect(sent.text).toContain('new@example.com');
    // Security-notice tone: tells the user what to do if it wasn't them.
    expect(sent.text).toMatch(/did not make this change/i);
    expect(sent.html).toMatch(/did not make this change/i);
  });

  it('sendEmailChanged tolerates a null name', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'smtp-from@example.com';

    const { getEmailService } = await import('./email');
    const service = getEmailService();

    await service!.sendEmailChanged({
      to: 'old@example.com',
      name: null,
      newEmail: 'new@example.com'
    });

    expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
    const sent = smtpSendMailMock.mock.calls[0]![0] as { text: string };
    // Falls back to the generic greeting rather than crashing on null.
    expect(sent.text).toContain('Hi there,');
  });

  it('falls back to Mailgun in auto mode when resend and smtp are not configured', async () => {
    process.env.MAILGUN_API_KEY = 'mg-key-123';
    process.env.MAILGUN_DOMAIN = 'mg.example.com';
    process.env.EMAIL_FROM = 'fallback@example.com';

    const { getEmailService } = await import('./email');
    const service = getEmailService();

    expect(service).not.toBeNull();
    await service!.sendEmail({
      to: 'user@example.com',
      subject: 'Auto Mailgun',
      html: '<p>Auto Mailgun</p>',
      purpose: 'ops.alert'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
  });
});

describe('buildInvoiceTemplate', () => {
  const base = {
    invoiceNumber: 'INV-0001',
    partnerName: 'Acme MSP',
    total: '$10,000.00',
    dueDate: '2026-09-01',
    portalUrl: 'https://portal.example.com/invoices/i1',
  };

  it('renders "Amount due now" equal to the total when there is no deposit', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate(base);
    expect(t.html).toContain('Amount due now');
    expect(t.html).toContain('$10,000.00');
    expect(t.text).toContain('Amount due now: $10,000.00 by 2026-09-01.');
  });

  it('renders "Amount due now" + "Paid to date" when deposit params are present', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate({ ...base, amountDueNow: '$7,000.00', amountPaid: '$3,000.00' });
    expect(t.html).toContain('Amount due now');
    expect(t.html).toContain('$7,000.00');
    expect(t.html).toContain('Paid to date');
    expect(t.html).toContain('$3,000.00');
    expect(t.text).toContain('Amount due now: $7,000.00 by 2026-09-01.');
    expect(t.text).toContain('Paid to date: $3,000.00 of $10,000.00.');
  });

  it('omits the "Paid to date" line when amountPaid is not supplied', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate({ ...base, amountDueNow: '$10,000.00' });
    expect(t.html).not.toContain('Paid to date');
    expect(t.text).not.toContain('Paid to date');
  });

  it('uses a saved subject and fills the invoice fields', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate({
      ...base,
      custom: {
        subject: 'Please pay {{invoice_number}} by {{due_date}} ({{total}})',
        heading: null,
        buttonLabel: null,
        html: null,
      },
    });
    expect(t.subject).toBe('Please pay INV-0001 by 2026-09-01 ($10,000.00)');
  });

  it('a subject typed in the send box wins over the saved template subject', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate({
      ...base,
      subject: 'Copy of INV-0001',
      custom: {
        subject: 'Saved {{invoice_number}}',
        heading: null,
        buttonLabel: null,
        html: null,
      },
    });
    expect(t.subject).toBe('Copy of INV-0001');
  });

  it('null custom keeps current wording and the server pay URL', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate({ ...base, custom: null });
    expect(t.html).toContain('Hi there,');
    expect(t.html).toContain('has sent you invoice');
    expect(t.html).toContain('INV-0001');
    expect(t.html).toContain('Amount due now');
    expect(t.html).toContain('A PDF copy is attached to this email.');
    expect(t.html).toContain('no sign-in needed');
    expect(t.html).toContain('View invoice');
    expect(t.html).toContain(`href="${base.portalUrl}"`);
    expect(t.text).toContain(base.portalUrl);
  });

  it('uses View & pay invoice when payment is enabled', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate({ ...base, payEnabled: true });
    expect(t.html).toContain('View &amp; pay invoice');
    expect(t.html).not.toContain('>View invoice<');
  });

  it('does not duplicate catalog PDF and amount-due lines on custom html', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const { emailTemplateFieldDefaults } = await import('@breeze/shared');
    const t = buildInvoiceTemplate({
      ...base,
      custom: {
        subject: null,
        heading: null,
        buttonLabel: null,
        html: emailTemplateFieldDefaults('invoice_send').html.replace('Hi there', 'Hello'),
      },
    });
    expect(t.html.match(/A PDF copy is attached to this email\./g)).toHaveLength(1);
    expect(t.html.match(/Amount due now:/g)).toHaveLength(1);
    expect(t.html.match(/no sign-in needed/g)).toHaveLength(1);
  });

  it('custom html substitutes invoice_number and keeps the server pay URL', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate({
      ...base,
      custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Invoice {{invoice_number}} is due.</p>' },
    });
    expect(t.html).toContain('Invoice INV-0001 is due.');
    expect(t.html).toContain(`href="${base.portalUrl}"`);
    expect(t.html).not.toContain('{{invoice_number}}');
  });

  it('strips javascript: from a custom href using invoice_number', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate({
      ...base,
      invoiceNumber: 'javascript:alert(1)',
      custom: {
        subject: 'Invoice',
        heading: 'Invoice',
        buttonLabel: null,
        html: '<a href="{{invoice_number}}">x</a>',
      },
    });
    expect(t.html).not.toMatch(/href\s*=\s*["']javascript:/i);
    expect(t.html).toContain(`href="${base.portalUrl}"`);
    expect(t.html).toContain('<a>x</a>');
  });

  it('keeps the per-send note and signature around custom html', async () => {
    const { buildInvoiceTemplate } = await import('./email');
    const t = buildInvoiceTemplate({
      ...base,
      message: 'Pay when you can.',
      signature: 'Billing',
      custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Custom {{invoice_number}}</p>' },
    });
    expect(t.html).toContain('Custom INV-0001');
    expect(t.html).toContain('Pay when you can.');
    expect(t.html).toContain('Billing');
    expect(t.html).toContain(`href="${base.portalUrl}"`);
  });
});

// #3905 — the send transports had no client-side deadline at all. Nodemailer's
// SMTP defaults let a silently-dropping mail server hold the socket for ten
// minutes, and the Mailgun fetches passed no AbortSignal, so they could hang
// forever. Both are now bounded, because a quote/invoice send that never
// returns is a leaked worker (and, before the deferred-send fix, a leaked
// pooled Postgres connection and a customer-facing row lock).
describe('email transport deadlines (#3905)', () => {
  const originalEnvSnapshot = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnvSnapshot };
    resetEmailEnv();
    smtpSendMailMock.mockResolvedValue({ messageId: 'smtp-1' });
    createTransportMock.mockReturnValue({ sendMail: smtpSendMailMock });
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue('ok') });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  function smtpEnv() {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = 'noreply@example.com';
  }

  function mailgunEnv() {
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'key-test';
    process.env.MAILGUN_DOMAIN = 'mg.example.com';
    process.env.MAILGUN_FROM = 'noreply@example.com';
  }

  it('bounds the SMTP transport with connection, greeting and socket deadlines', async () => {
    smtpEnv();
    const { getEmailService } = await import('./email');
    expect(getEmailService()).not.toBeNull();

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    const opts = createTransportMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.connectionTimeout).toBe(30_000);
    expect(opts.greetingTimeout).toBe(30_000);
    expect(opts.socketTimeout).toBe(30_000);
  });

  it('honours SMTP_TIMEOUT_MS for all three SMTP deadlines', async () => {
    smtpEnv();
    process.env.SMTP_TIMEOUT_MS = '5000';
    const { getEmailService } = await import('./email');
    expect(getEmailService()).not.toBeNull();

    const opts = createTransportMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.connectionTimeout).toBe(5_000);
    expect(opts.greetingTimeout).toBe(5_000);
    expect(opts.socketTimeout).toBe(5_000);
  });

  it('rejects a non-numeric or out-of-range SMTP_TIMEOUT_MS instead of silently defaulting', async () => {
    smtpEnv();
    process.env.SMTP_TIMEOUT_MS = 'soon';
    const { getEmailService } = await import('./email');
    // getEmailService swallows a config error into a null service + warning;
    // the point is that it does NOT boot with an unbounded transport.
    expect(getEmailService()).toBeNull();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('passes an AbortSignal on the Mailgun form-data (attachment) send', async () => {
    mailgunEnv();
    const { getEmailService } = await import('./email');
    const service = getEmailService();
    await service!.sendEmail({
      to: 'user@example.com',
      subject: 'Proposal',
      html: '<p>hi</p>',
      attachments: [{ filename: 'q.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' }],
      purpose: 'ops.alert',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes an AbortSignal on the Mailgun urlencoded (no-attachment) send', async () => {
    mailgunEnv();
    const { getEmailService } = await import('./email');
    const service = getEmailService();
    await service!.sendEmail({ to: 'user@example.com', subject: 'Proposal', html: '<p>hi</p>', purpose: 'ops.alert' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a MALFORMED email env value to Sentry, because it silently disables all outbound mail', async () => {
    // getEmailService caches `unavailable` for the life of the process, so a
    // typo here stops password resets, invites, quotes and alerts alike with
    // nothing but a log line. A typo is an incident.
    smtpEnv();
    process.env.SMTP_TIMEOUT_MS = '30s';
    const { getEmailService } = await import('./email');

    expect(getEmailService()).toBeNull();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0]![0]).toMatchObject({
      name: 'EmailConfigValueError',
      message: expect.stringContaining('SMTP_TIMEOUT_MS'),
    });
  });

  it('does NOT report merely-unconfigured email to Sentry — self-hosting without email is supported', async () => {
    // No provider env at all. This must stay log-only, or every self-hosted
    // install that does not use email floods the operator's Sentry.
    const { getEmailService } = await import('./email');

    expect(getEmailService()).toBeNull();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('surfaces a Mailgun timeout as a named, actionable error rather than a bare AbortError', async () => {
    mailgunEnv();
    process.env.MAILGUN_TIMEOUT_MS = '1000';
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    );
    const { getEmailService } = await import('./email');
    const service = getEmailService();

    await expect(
      service!.sendEmail({ to: 'user@example.com', subject: 'Proposal', html: '<p>hi</p>', purpose: 'ops.alert' }),
    ).rejects.toThrow(/Mailgun request timed out after 1000ms/);
  });
});

/**
 * The partner lane, end-to-end through the REAL resolveSender and the REAL
 * sendOnPartnerLane. Only the database lookup, the config reader, the cap and
 * the provider registry are mocked — everything between `sendEmail` and the
 * transport is production code, which is what makes the failure-semantics
 * assertions below worth having.
 */
describe('email service — the partner lane (spec §8.3, §8.4)', () => {
  const laneSend = vi.fn();
  const lookup = vi.fn();
  const cap = vi.fn();

  vi.doMock('./emailDomains/config', () => ({
    isPartnerLaneConfigured: () => true,
    getEmailDomainsConfig: () => ({ dailySendCap: 0, partnerAllowlist: [] }),
  }));
  vi.doMock('./emailDomains/partnerLaneLookup', () => ({ lookupPartnerLaneIdentity: lookup }));
  vi.doMock('./emailDomains/sendCap', () => ({ tryCountPartnerLaneSend: cap }));
  vi.doMock('./emailDomains/providerRegistry', () => ({
    getEmailDomainProvider: () => ({ id: 'resend', verifiesByDns: true, send: laneSend }),
  }));
  vi.doMock('../jobs/sendingDomainsWorker', () => ({ enqueueSyncDomain: vi.fn(async () => undefined) }));
  vi.doMock('./opsAlerts', () => ({ sendOpsAlert: vi.fn(async () => true), isOpsAlertingConfigured: () => false }));

  const PARTNER = '11111111-1111-1111-1111-111111111111';
  const IDENTITY = {
    ok: true as const, partnerName: 'Acme MSP', localPart: 'support', displayName: 'Acme Support',
    replyTo: 'help@acme.test', domainId: 'd1', domain: 'mail.acme.test',
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    resetEmailEnv();
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_test_123';
    process.env.EMAIL_FROM = 'Breeze <no-reply@2breeze.app>';
    resendSendMock.mockResolvedValue({ id: 'resend-1' });
    laneSend.mockResolvedValue({ providerMessageId: 'partner-1' });
    lookup.mockResolvedValue(IDENTITY);
    cap.mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function service() {
    const { getEmailService } = await import('./email');
    return getEmailService()!;
  }

  const BASE = {
    to: 'customer@example.test',
    subject: 'Invoice INV-1',
    html: '<p>hi</p>',
  } as const;

  it('sends a partner-lane purpose through the provider, not the platform transport', async () => {
    await (await service()).sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER, partnerName: 'Acme MSP' });
    expect(laneSend).toHaveBeenCalledTimes(1);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(laneSend.mock.calls[0]![0].from).toBe('"Acme Support" <support@mail.acme.test>');
  });

  it('applies the Reply-To precedence: call site, then identity, then none', async () => {
    const svc = await service();
    await svc.sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER, replyTo: 'accounts@acmemsp.example' });
    expect(laneSend.mock.calls[0]![0].replyTo).toBe('accounts@acmemsp.example');

    laneSend.mockClear();
    await svc.sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER });
    expect(laneSend.mock.calls[0]![0].replyTo).toBe('help@acme.test');

    laneSend.mockClear();
    lookup.mockResolvedValue({ ...IDENTITY, replyTo: null });
    await svc.sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER });
    expect(laneSend.mock.calls[0]![0].replyTo).toBeUndefined();
  });

  it('a platform purpose never reaches the partner lane, whatever the registry says', async () => {
    await (await service()).sendEmail({ ...BASE, purpose: 'auth.password_reset' });
    expect(laneSend).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(resendSendMock.mock.calls[0]![0].from).toBe('Breeze <no-reply@2breeze.app>');
  });

  it.each([
    ['domain_unusable', '"Acme MSP" <no-reply@2breeze.app>'],
    ['lane_unavailable', '"Acme MSP" <no-reply@2breeze.app>'],
  ] as const)('falls back to the platform lane on %s, with the purpose fallback From', async (kind, expectedFrom) => {
    const { PartnerLaneSendFailure } = await import('./emailDomains/provider');
    laneSend.mockRejectedValue(new PartnerLaneSendFailure({ kind }));
    await (await service()).sendEmail({
      ...BASE, purpose: 'invoice.sent', partnerId: PARTNER, partnerName: 'Acme MSP',
      headers: { 'Message-ID': '<m@x>' },
    });
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const fallback = resendSendMock.mock.calls[0]![0];
    expect(fallback.from).toBe(expectedFrom);
    // Spec §8.4: the fallback carries NEITHER the outbound marker NOR any
    // partner tag. A platform-lane message wearing X-Breeze-Outbound would be
    // dropped by our own inbound pipeline if it ever came back.
    expect(fallback.headers).toEqual({ 'Message-ID': '<m@x>' });
    expect(fallback.headers['X-Breeze-Outbound']).toBeUndefined();
  });

  it('the fallback uses the CALL SITE Reply-To, not the identity default', async () => {
    const { PartnerLaneSendFailure } = await import('./emailDomains/provider');
    laneSend.mockRejectedValue(new PartnerLaneSendFailure({ kind: 'domain_unusable' }));
    await (await service()).sendEmail({ ...BASE, purpose: 'ticket.customer_notification', partnerId: PARTNER });
    // help@acme.test is on the domain that just refused us; routing replies
    // there would compound the failure.
    expect(resendSendMock.mock.calls[0]![0].replyTo).toBeUndefined();
  });

  it.each(['message_rejected', 'ambiguous'] as const)('rethrows %s and NEVER touches the second lane', async (kind) => {
    const { PartnerLaneSendFailure } = await import('./emailDomains/provider');
    laneSend.mockRejectedValue(new PartnerLaneSendFailure({ kind, detail: 'd' }));
    await expect((await service()).sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER }))
      .rejects.toBeInstanceOf(PartnerLaneSendFailure);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it('rethrows an unknown exception from the adapter and never falls back', async () => {
    laneSend.mockRejectedValue(new TypeError('adapter blew up'));
    await expect((await service()).sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER }))
      .rejects.toThrow('adapter blew up');
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it('a partner-lane purpose with partnerId: null is a plain platform send', async () => {
    await (await service()).sendEmail({ ...BASE, purpose: 'report.delivery', partnerId: null });
    expect(laneSend).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(resendSendMock.mock.calls[0]![0].from).toBe('Breeze <no-reply@2breeze.app>');
  });

  it('an over-cap send goes out on the platform lane, exactly once', async () => {
    cap.mockResolvedValue(false);
    await (await service()).sendEmail({ ...BASE, purpose: 'invoice.sent', partnerId: PARTNER, partnerName: 'Acme MSP' });
    expect(laneSend).not.toHaveBeenCalled();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock.mock.calls[0]![0].from).toBe('"Acme MSP" <no-reply@2breeze.app>');
  });
});
