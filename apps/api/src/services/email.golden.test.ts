import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIL_PURPOSES } from './emailDomains/mailPurposes';
import type { SendEmailBase, SendEmailParams } from './email';

/**
 * W01 acceptance criterion (spec §14, §15): for EVERY purpose, the rendered
 * From, Reply-To, recipients and headers equal what the send site produced
 * before the sender contract landed, under EVERY EMAIL_PROVIDER. This is the
 * "upgrade changes nothing" guarantee in code — and the one test that a
 * self-hoster's mail silently changing would have to break first.
 *
 * Nothing here asserts a partner-lane send: in W01 there is no partner lane,
 * so every purpose resolves to the platform sender. W04 adds partner-lane
 * cases beside these; these rows must keep passing unchanged.
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

const DEFAULT_FROM = 'Breeze <no-reply@2breeze.app>';
const BRANDED_FROM = '"Acme MSP via Breeze" <no-reply@2breeze.app>';
const PARTNER_ID = '11111111-1111-1111-1111-111111111111';

const MESSAGE: SendEmailBase = {
  to: ['customer@example.test', 'second@example.test'],
  cc: ['cc@example.test'],
  subject: 'Golden subject',
  html: '<p>golden</p>',
  text: 'golden',
  replyTo: 'reply@example.test',
  headers: { 'Message-ID': '<ticket-t1@tickets.example.test>', 'Auto-Submitted': 'auto-replied' },
};

const GOLDEN: Array<{ name: string; params: SendEmailParams; expectedFrom: string }> = [
  { name: 'auth.password_reset', params: { ...MESSAGE, purpose: 'auth.password_reset' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.email_verification', params: { ...MESSAGE, purpose: 'auth.email_verification' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.email_change_verify', params: { ...MESSAGE, purpose: 'auth.email_change_verify' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.email_changed', params: { ...MESSAGE, purpose: 'auth.email_changed' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.signup_existing_account', params: { ...MESSAGE, purpose: 'auth.signup_existing_account' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.staff_invite', params: { ...MESSAGE, purpose: 'auth.staff_invite' }, expectedFrom: DEFAULT_FROM },
  { name: 'auth.account_locked', params: { ...MESSAGE, purpose: 'auth.account_locked' }, expectedFrom: DEFAULT_FROM },
  { name: 'security.mfa_enrollment', params: { ...MESSAGE, purpose: 'security.mfa_enrollment' }, expectedFrom: DEFAULT_FROM },
  // Caller verification (#6354): a rejected caller notifies the org's security
  // reviewers. Platform lane like every other security notice.
  { name: 'security.caller_rejection', params: { ...MESSAGE, purpose: 'security.caller_rejection' }, expectedFrom: DEFAULT_FROM },
  { name: 'account.deletion_requested', params: { ...MESSAGE, purpose: 'account.deletion_requested' }, expectedFrom: DEFAULT_FROM },
  { name: 'account.deletion_declined', params: { ...MESSAGE, purpose: 'account.deletion_declined' }, expectedFrom: DEFAULT_FROM },
  { name: 'account.purge_warning', params: { ...MESSAGE, purpose: 'account.purge_warning' }, expectedFrom: DEFAULT_FROM },
  { name: 'ops.alert', params: { ...MESSAGE, purpose: 'ops.alert' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.ai_budget_alert', params: { ...MESSAGE, purpose: 'staff.ai_budget_alert' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.contract_renewal', params: { ...MESSAGE, purpose: 'staff.contract_renewal' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.quote_outcome', params: { ...MESSAGE, purpose: 'staff.quote_outcome' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.alert_notification', params: { ...MESSAGE, purpose: 'staff.alert_notification' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.workspace_drift_report', params: { ...MESSAGE, purpose: 'staff.workspace_drift_report' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.report_failure', params: { ...MESSAGE, purpose: 'staff.report_failure' }, expectedFrom: DEFAULT_FROM },
  { name: 'staff.sending_domain_status', params: { ...MESSAGE, purpose: 'staff.sending_domain_status' }, expectedFrom: DEFAULT_FROM },
  { name: 'deployment.invite', params: { ...MESSAGE, purpose: 'deployment.invite' }, expectedFrom: DEFAULT_FROM },
  { name: 'ticket.staff_notification', params: { ...MESSAGE, purpose: 'ticket.staff_notification' }, expectedFrom: DEFAULT_FROM },
  { name: 'ticket.customer_notification (with partner)', params: { ...MESSAGE, purpose: 'ticket.customer_notification', partnerId: PARTNER_ID }, expectedFrom: DEFAULT_FROM },
  { name: 'ticket.customer_notification (no partner)', params: { ...MESSAGE, purpose: 'ticket.customer_notification', partnerId: null }, expectedFrom: DEFAULT_FROM },
  { name: 'portal.invite', params: { ...MESSAGE, purpose: 'portal.invite', partnerId: PARTNER_ID }, expectedFrom: DEFAULT_FROM },
  { name: 'portal.password_reset', params: { ...MESSAGE, purpose: 'portal.password_reset', partnerId: null }, expectedFrom: DEFAULT_FROM },
  { name: 'report.delivery', params: { ...MESSAGE, purpose: 'report.delivery', partnerId: null }, expectedFrom: DEFAULT_FROM },
  { name: 'quote.sent (partner named)', params: { ...MESSAGE, purpose: 'quote.sent', partnerId: PARTNER_ID, partnerName: 'Acme MSP' }, expectedFrom: BRANDED_FROM },
  { name: 'quote.sent (no partner name)', params: { ...MESSAGE, purpose: 'quote.sent', partnerId: PARTNER_ID, partnerName: null }, expectedFrom: DEFAULT_FROM },
  { name: 'invoice.sent (partner named)', params: { ...MESSAGE, purpose: 'invoice.sent', partnerId: PARTNER_ID, partnerName: 'Acme MSP' }, expectedFrom: BRANDED_FROM },
  { name: 'invoice.sent (no partner name)', params: { ...MESSAGE, purpose: 'invoice.sent', partnerId: PARTNER_ID, partnerName: null }, expectedFrom: DEFAULT_FROM },
];

// GOLDEN is hand-written, so a purpose added to the registry with no matching
// row would silently go untested. Assert the coverage both ways: every
// registry purpose has at least one golden row, and no golden row names a
// purpose the registry doesn't have.
describe('GOLDEN covers exactly the registry (no purpose silently untested)', () => {
  it('the set of purposes exercised equals the set of registered purposes', () => {
    const goldenPurposes = new Set(GOLDEN.map((row) => row.params.purpose));
    const registryPurposes = new Set(Object.keys(MAIL_PURPOSES));
    expect(goldenPurposes).toEqual(registryPurposes);
  });
});

const originalEnv = { ...process.env };

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
  resendSendMock.mockResolvedValue({ error: null });
  smtpSendMailMock.mockResolvedValue({ messageId: 'smtp-1' });
  createTransportMock.mockReturnValue({ sendMail: smtpSendMailMock });
  fetchMock.mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue('ok') });
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

describe('golden: every purpose renders today\'s envelope on EMAIL_PROVIDER=resend', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  for (const row of GOLDEN) {
    it(row.name, async () => {
      await (await service()).sendEmail(row.params);
      expect(resendSendMock).toHaveBeenCalledTimes(1);
      const arg = resendSendMock.mock.calls[0]![0];
      expect(arg.from).toBe(row.expectedFrom);
      expect(arg.to).toEqual(MESSAGE.to);
      expect(arg.cc).toEqual(MESSAGE.cc);
      expect(arg.subject).toBe(MESSAGE.subject);
      expect(arg.html).toBe(MESSAGE.html);
      expect(arg.text).toBe(MESSAGE.text);
      expect(arg.replyTo).toBe(MESSAGE.replyTo);
      expect(arg.headers).toEqual(MESSAGE.headers);
      expect(arg.attachments).toBeUndefined();
    });
  }
});

describe('golden: every purpose renders today\'s envelope on EMAIL_PROVIDER=smtp', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  for (const row of GOLDEN) {
    it(row.name, async () => {
      await (await service()).sendEmail(row.params);
      expect(smtpSendMailMock).toHaveBeenCalledTimes(1);
      const arg = smtpSendMailMock.mock.calls[0]![0];
      expect(arg.from).toBe(row.expectedFrom);
      expect(arg.to).toEqual(MESSAGE.to);
      expect(arg.cc).toEqual(MESSAGE.cc);
      expect(arg.subject).toBe(MESSAGE.subject);
      expect(arg.replyTo).toBe(MESSAGE.replyTo);
      // Threading headers are lifted into nodemailer's dedicated options so it
      // does not ALSO auto-generate a second Message-Id.
      expect(arg.messageId).toBe('<ticket-t1@tickets.example.test>');
      expect(arg.inReplyTo).toBeUndefined();
      expect(arg.references).toBeUndefined();
      expect(arg.headers).toEqual({ 'Auto-Submitted': 'auto-replied' });
    });
  }
});

describe('golden: every purpose renders today\'s envelope on EMAIL_PROVIDER=mailgun', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'mailgun';
    process.env.MAILGUN_API_KEY = 'mg-key';
    process.env.MAILGUN_DOMAIN = 'mg.example.test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  for (const row of GOLDEN) {
    it(row.name, async () => {
      await (await service()).sendEmail(row.params);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = new URLSearchParams(String(fetchMock.mock.calls[0]![1].body ?? ''));
      expect(body.get('from')).toBe(row.expectedFrom);
      expect(body.getAll('to')).toEqual(MESSAGE.to);
      expect(body.get('subject')).toBe(MESSAGE.subject);
      expect(body.get('html')).toBe(MESSAGE.html);
      expect(body.get('text')).toBe(MESSAGE.text);
      expect(body.getAll('h:Reply-To')).toEqual([MESSAGE.replyTo]);
      expect(body.get('h:Message-ID')).toBe('<ticket-t1@tickets.example.test>');
      expect(body.get('h:Auto-Submitted')).toBe('auto-replied');
      // PINNED AS-IS, not fixed (plan index amendment 6): sendEmail's Mailgun
      // branch has never passed `cc` through to sendViaMailgun, which does
      // support it. Fixing that changes what recipients see, so it is a
      // separate issue, not part of a byte-identical wave.
      expect(body.getAll('cc')).toEqual([]);
    });
  }
});

describe('named helpers carry their purpose to the transport (spec §8.1)', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  it('sendPasswordReset carries the auth purpose for staff', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendPasswordReset({ to: 'admin@msp.test', resetUrl: 'https://app.test/r', purpose: 'auth.password_reset' });
    expect(spy.mock.calls[0]![0]).toMatchObject({ purpose: 'auth.password_reset' });
    expect(resendSendMock.mock.calls[0]![0].from).toBe(DEFAULT_FROM);
  });

  it('sendPasswordReset carries the portal purpose and partner for a portal user', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendPasswordReset({
      to: 'buyer@customer.test', resetUrl: 'https://portal.test/r',
      purpose: 'portal.password_reset', partnerId: PARTNER_ID,
    });
    expect(spy.mock.calls[0]![0]).toMatchObject({ purpose: 'portal.password_reset', partnerId: PARTNER_ID });
  });

  it('sendVerificationEmail carries whichever verification purpose it was given', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendVerificationEmail({ to: 'a@msp.test', verificationUrl: 'https://app.test/v', purpose: 'auth.email_change_verify' });
    expect(spy.mock.calls[0]![0]).toMatchObject({ purpose: 'auth.email_change_verify' });
  });

  it('sendPortalInvite is a partner-stream send carrying the partner', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendPortalInvite({ to: 'buyer@customer.test', inviteUrl: 'https://portal.test/i', partnerId: PARTNER_ID });
    expect(spy.mock.calls[0]![0]).toMatchObject({ purpose: 'portal.invite', partnerId: PARTNER_ID });
  });

  it('the single-audience helpers hard-code their purpose', async () => {
    const svc = await service();
    const spy = vi.spyOn(svc, 'sendEmail');
    await svc.sendInvite({ to: 'new@msp.test', inviteUrl: 'https://app.test/i' });
    await svc.sendAccountLocked({ to: 'a@msp.test', resetUrl: 'https://app.test/r', lockoutMinutes: 15 });
    await svc.sendEmailChanged({ to: 'old@msp.test', newEmail: 'new@msp.test' });
    await svc.sendSignupAttemptOnExistingAccount({ to: 'a@msp.test' });
    await svc.sendAlertNotification({ to: 'a@msp.test', alertName: 'Disk', severity: 'high', summary: 'full' });
    expect(spy.mock.calls.map((c) => c[0].purpose)).toEqual([
      'auth.staff_invite',
      'auth.account_locked',
      'auth.email_changed',
      'auth.signup_existing_account',
      'staff.alert_notification',
    ]);
  });
});

describe('the sender contract is compile-enforced (spec G5)', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = DEFAULT_FROM;
  });

  it('rejects an unclassified send and a raw from at the type level', async () => {
    const svc = await service();
    // @ts-expect-error — no `purpose`: every send must declare what it is.
    await expect(svc.sendEmail({ to: 'a@b.test', subject: 's', html: '<p>h</p>' })).resolves.toBeUndefined();
    await expect(svc.sendEmail({
      to: 'a@b.test', subject: 's', html: '<p>h</p>', purpose: 'ops.alert',
      // @ts-expect-error — the raw `from` is gone; the registry decides it.
      from: 'spoof@evil.test',
    })).resolves.toBeUndefined();
    // A platform purpose cannot smuggle a partner in.
    // @ts-expect-error — partnerId is `never` on the platform branch.
    await expect(svc.sendEmail({
      to: 'a@b.test', subject: 's', html: '<p>h</p>', purpose: 'ops.alert',
      partnerId: PARTNER_ID,
    })).resolves.toBeUndefined();
    // A partner purpose MUST state its partner, even when that is null.
    // @ts-expect-error — missing required `partnerId`.
    await expect(svc.sendEmail({ to: 'a@b.test', subject: 's', html: '<p>h</p>', purpose: 'quote.sent' })).resolves.toBeUndefined();
  });

  it('EmailService no longer exposes fromWithDisplayName', async () => {
    const svc = await service();
    expect((svc as unknown as Record<string, unknown>).fromWithDisplayName).toBeUndefined();
  });
});
