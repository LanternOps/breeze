import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { resendSendMock, createTransportMock, smtpSendMailMock, fetchMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(),
  createTransportMock: vi.fn(),
  smtpSendMailMock: vi.fn(),
  fetchMock: vi.fn()
}));

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
      html: '<p>Hello</p>'
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
      replyTo: 'help@example.com'
    });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
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
      html: '<p>Auto SMTP</p>'
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
      replyTo: ['support@example.com', 'help@example.com']
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
      html: '<p>Auto Mailgun</p>'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
  });
});
