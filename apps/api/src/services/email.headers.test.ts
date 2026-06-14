import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resendSendMock, smtpSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn().mockResolvedValue({ error: null }),
  smtpSendMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('resend', () => ({
  Resend: class MockResend {
    emails = { send: resendSendMock };
  },
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: smtpSendMock })) },
}));

describe('SendEmailParams.headers — Resend', () => {
  beforeEach(() => {
    vi.resetModules();
    resendSendMock.mockClear();
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'support@example.com';
  });

  it('passes custom headers to resend.emails.send', async () => {
    const { EmailService } = await import('./email');
    const svc = new EmailService();
    await svc.sendEmail({
      to: 'jane@x.com',
      subject: '[T-2026-0001] Re: printer',
      html: '<p>hi</p>',
      headers: { 'In-Reply-To': '<ticket-t1@tickets.example.com>', 'Auto-Submitted': 'auto-replied' },
    });
    const arg = resendSendMock.mock.calls[0]![0];
    expect(arg.headers).toEqual({
      'In-Reply-To': '<ticket-t1@tickets.example.com>',
      'Auto-Submitted': 'auto-replied',
    });
  });
});

describe('SendEmailParams.headers — SMTP', () => {
  beforeEach(() => {
    vi.resetModules();
    smtpSendMock.mockClear();
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'localhost';
    process.env.SMTP_FROM = 'support@example.com';
    delete process.env.RESEND_API_KEY;
  });

  it('merges custom headers into nodemailer mailOptions', async () => {
    const { EmailService } = await import('./email');
    const svc = new EmailService();
    await svc.sendEmail({
      to: 'jane@x.com',
      subject: 's',
      html: '<p>hi</p>',
      headers: { 'Message-ID': '<m@x>', References: '<a> <b>' },
    });
    const arg = smtpSendMock.mock.calls[0]![0];
    expect(arg.headers).toEqual({ 'Message-ID': '<m@x>', References: '<a> <b>' });
  });
});

describe('SendEmailParams.headers — Mailgun', () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'key-test';
    process.env.MAILGUN_DOMAIN = 'mg.example.com';
    process.env.MAILGUN_FROM = 'support@example.com';
    process.env.EMAIL_FROM = 'support@example.com';
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
  });

  it('emits each custom header as an h:Header-Name form field', async () => {
    const { EmailService } = await import('./email');
    const svc = new EmailService();
    await svc.sendEmail({
      to: 'jane@x.com',
      subject: 's',
      html: '<p>hi</p>',
      headers: { 'Message-ID': '<m@x>', 'In-Reply-To': '<a@x>', 'Auto-Submitted': 'auto-replied' },
    });
    const body = fetchMock.mock.calls[0]![1].body as string;
    const params = new URLSearchParams(body);
    expect(params.get('h:Message-ID')).toBe('<m@x>');
    expect(params.get('h:In-Reply-To')).toBe('<a@x>');
    expect(params.get('h:Auto-Submitted')).toBe('auto-replied');
  });
});
