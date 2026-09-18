import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawEmailMessage } from './email';

/**
 * `deliverRaw` must hand its caller the STRUCTURE of a transport failure —
 * which transport, which status code, nodemailer's SMTP reply — while keeping
 * `.message` byte-for-byte what it has always been.
 *
 * The text is load-bearing in three live places:
 *   services/reportNarrativeDelivery.ts:138  /^Resend error:/i
 *   services/reportNarrativeDelivery.ts:145  /^Mailgun API error \((?:408|429)\)/i
 *   services/reportNarrativeDelivery.ts:146  /^Mailgun API error \(4\d\d\)/i
 * A "nicer" message here silently reclassifies every narrative-delivery
 * failure, so these assertions pin the exact strings, not a shape.
 */

const { resendSendMock, createTransportMock, smtpSendMailMock, fetchMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(),
  createTransportMock: vi.fn(),
  smtpSendMailMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('resend', () => ({ Resend: class MockResend { emails = { send: resendSendMock }; } }));
vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

const originalEnv = { ...process.env };
const MESSAGE: RawEmailMessage = {
  from: 'Breeze <no-reply@2breeze.app>',
  to: 'customer@example.test',
  subject: 's',
  html: '<p>h</p>',
};

function resetEmailEnv() {
  for (const key of [
    'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER',
    'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE', 'MAILGUN_API_KEY', 'MAILGUN_DOMAIN',
    'MAILGUN_BASE_URL', 'MAILGUN_FROM', 'SMTP_TIMEOUT_MS', 'MAILGUN_TIMEOUT_MS',
  ]) delete process.env[key];
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnv };
  resetEmailEnv();
  createTransportMock.mockReturnValue({ sendMail: smtpSendMailMock });
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
});

async function service() {
  const { EmailService } = await import('./email');
  return new EmailService();
}

describe('EmailTransportError — Resend', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'Breeze <no-reply@2breeze.app>';
  });

  it('keeps the message byte-identical and carries the provider error name and status', async () => {
    resendSendMock.mockResolvedValue({
      error: { name: 'validation_error', message: 'The acme.test domain is not verified.', statusCode: 403 },
    });
    const { EmailTransportError } = await import('./email');
    const svc = await service();
    const raised = await svc.deliverRaw(MESSAGE).catch((e: unknown) => e);
    expect(raised).toBeInstanceOf(EmailTransportError);
    expect((raised as Error).message).toBe('Resend error: The acme.test domain is not verified.');
    expect(raised).toMatchObject({
      transport: 'resend', providerErrorName: 'validation_error', statusCode: 403,
    });
  });

  it('omits the optional fields the SDK did not report', async () => {
    resendSendMock.mockResolvedValue({ error: { message: 'boom' } });
    const svc = await service();
    const raised = (await svc.deliverRaw(MESSAGE).catch((e: unknown) => e)) as Record<string, unknown>;
    expect((raised as unknown as Error).message).toBe('Resend error: boom');
    expect(raised.transport).toBe('resend');
    expect(raised.statusCode).toBeUndefined();
    expect(raised.providerErrorName).toBeUndefined();
  });
});

describe('EmailTransportError — SMTP', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.EMAIL_FROM = 'Breeze <no-reply@2breeze.app>';
  });

  it('carries nodemailer responseCode and response, and preserves the original message and cause', async () => {
    const nodemailerError = Object.assign(new Error('Message failed: 550 5.7.60 SMTP; Client does not have permissions to send as this sender'), {
      responseCode: 550,
      response: '550 5.7.60 SMTP; Client does not have permissions to send as this sender',
    });
    smtpSendMailMock.mockRejectedValue(nodemailerError);
    const { EmailTransportError } = await import('./email');
    const svc = await service();
    const raised = await svc.deliverRaw(MESSAGE).catch((e: unknown) => e);
    expect(raised).toBeInstanceOf(EmailTransportError);
    // Byte-identical to what nodemailer threw: an SMTP failure has never been
    // rewritten by this service and must not start being.
    expect((raised as Error).message).toBe(nodemailerError.message);
    expect((raised as { cause?: unknown }).cause).toBe(nodemailerError);
    expect(raised).toMatchObject({
      transport: 'smtp', smtpResponseCode: 550,
      smtpResponse: '550 5.7.60 SMTP; Client does not have permissions to send as this sender',
    });
  });

  it('leaves smtpResponseCode undefined when nodemailer reports responseCode: false', async () => {
    // nodemailer sets responseCode to `false` when the reply had no leading
    // digits, so a truthiness check on the far side would misread it.
    smtpSendMailMock.mockRejectedValue(Object.assign(new Error('connection closed'), { responseCode: false }));
    const svc = await service();
    const raised = (await svc.deliverRaw(MESSAGE).catch((e: unknown) => e)) as Record<string, unknown>;
    expect(raised.transport).toBe('smtp');
    expect(raised.smtpResponseCode).toBeUndefined();
    expect((raised as unknown as Error).message).toBe('connection closed');
  });

  it('wraps a non-Error rejection without inventing text', async () => {
    smtpSendMailMock.mockRejectedValue('socket hang up');
    const svc = await service();
    const raised = (await svc.deliverRaw(MESSAGE).catch((e: unknown) => e)) as Error;
    expect(raised.message).toBe('socket hang up');
  });
});

describe('EmailTransportError — Mailgun', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'mg-key';
    process.env.MAILGUN_DOMAIN = 'mg.example.test';
    process.env.EMAIL_FROM = 'Breeze <no-reply@2breeze.app>';
  });

  it('keeps the exact "Mailgun API error (<status>): <body>" text and carries the status', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 403,
      text: vi.fn().mockResolvedValue('{"message":"The domain is not verified. Please verify your domain."}'),
    });
    const { EmailTransportError } = await import('./email');
    const svc = await service();
    const raised = await svc.deliverRaw(MESSAGE).catch((e: unknown) => e);
    expect(raised).toBeInstanceOf(EmailTransportError);
    expect((raised as Error).message)
      .toBe('Mailgun API error (403): {"message":"The domain is not verified. Please verify your domain."}');
    expect(raised).toMatchObject({ transport: 'mailgun', statusCode: 403 });
  });

  it('keeps the no-body form and the 429 form that reportNarrativeDelivery matches on', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: vi.fn().mockResolvedValue('') });
    const svc = await service();
    const raised = (await svc.deliverRaw(MESSAGE).catch((e: unknown) => e)) as Error;
    expect(raised.message).toBe('Mailgun API error (429)');
    expect(/^Mailgun API error \((?:408|429)\)/i.test(raised.message)).toBe(true);
  });
});
