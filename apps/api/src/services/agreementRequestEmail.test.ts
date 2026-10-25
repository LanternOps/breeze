import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendEmailMock, getEmailServiceMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn(), getEmailServiceMock: vi.fn() }));
vi.mock('./email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./email')>()),
  getEmailService: getEmailServiceMock,
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { buildAgreementRequestTemplate, deliverAgreementRequestEmail, type AgreementRequestDelivery } from './agreementRequestEmail';
import { MAIL_PURPOSES } from './emailDomains/mailPurposes';
import { captureException } from './sentry';

const URL = 'https://portal.example.com/agreement/tok%2Ben';

const base = {
  agreementName: 'Business Associate Agreement',
  partnerName: 'Acme MSP',
  orgName: 'Example Clinic',
  expiryDate: 'February 1, 2027',
  signingUrl: URL,
};

describe('buildAgreementRequestTemplate', () => {
  it('renders the catalog defaults through renderPartnerEmail with the signing URL as the CTA', () => {
    const t = buildAgreementRequestTemplate(base);
    expect(t.subject).toBe('Please sign: Business Associate Agreement from Acme MSP');
    expect(t.html).toContain('Business Associate Agreement');
    expect(t.html).toContain('Example Clinic');
    expect(t.html).toContain('February 1, 2027');
    expect(t.html).toContain(`href="${URL}"`);
    expect(t.html).toContain('Review &amp; sign');
    expect(t.text).toContain(`Review & sign: ${URL}`);
    // An agreement request never carries a price or an attachment promise.
    expect(`${t.html}${t.text}`).not.toMatch(/total|attached|\$\d/i);
  });

  it('a partner override wins (subject, heading, button, body)', () => {
    const t = buildAgreementRequestTemplate({
      ...base,
      custom: { subject: 'Sign {{agreement_name}} please', heading: 'Hi {{org_name}}', buttonLabel: 'Open it', html: '<p>Custom for {{org_name}}.</p><p>{{cta_button}}</p>' },
    });
    expect(t.subject).toBe('Sign Business Associate Agreement please');
    expect(t.html).toContain('Hi Example Clinic');
    expect(t.html).toContain('Custom for Example Clinic.');
    expect(t.html).toContain('Open it');
    expect(t.html).toContain(`href="${URL}"`);
  });

  it('escapes the cover message (above the CTA) and the signature', () => {
    const t = buildAgreementRequestTemplate({ ...base, coverMessage: 'Please sign <script>x</script>\nby Friday', signature: 'Thanks,\n<b>Acme</b>' });
    expect(t.html).toContain('Please sign &lt;script&gt;x&lt;/script&gt;<br>by Friday');
    expect(t.html).not.toContain('<script>x');
    expect(t.html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
    expect(t.html.indexOf('Please sign &lt;script')).toBeLessThan(t.html.indexOf(`href="${URL}"`));
    expect(t.text).toContain('Please sign <script>x</script>\nby Friday');
  });

  it('blank org name / expiry fall back to "you" and drop the validity line', () => {
    const t = buildAgreementRequestTemplate({ ...base, orgName: null, expiryDate: '' });
    expect(t.html).toContain('has sent you an agreement');
    expect(t.html).not.toContain('valid until');
  });
});

describe('deliverAgreementRequestEmail', () => {
  const delivery: AgreementRequestDelivery = {
    requestId: 'req-1',
    recipients: ['ops@example.com', 'dana@example.com'],
    partnerId: 'p1',
    partnerName: 'Acme MSP',
    partnerReplyTo: ' billing@example.com ',
    partnerSignature: null,
    partnerSettings: {},
    agreementName: 'BAA',
    orgName: 'Example Clinic',
    expiresAt: new Date('2027-02-01T12:00:00.000Z'),
    coverMessage: null,
    signingUrl: URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
    sendEmailMock.mockResolvedValue(undefined);
  });

  it('sends to the request recipients on agreement.sent (partner lane) with the partner envelope and no attachment', async () => {
    expect(await deliverAgreementRequestEmail(delivery)).toEqual({ emailed: true });
    const env = sendEmailMock.mock.calls[0]![0];
    expect(env.to).toEqual(['ops@example.com', 'dana@example.com']);
    expect(env.purpose).toBe('agreement.sent');
    expect(MAIL_PURPOSES['agreement.sent']).toEqual({ lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' });
    expect(env.partnerId).toBe('p1');
    expect(env.partnerName).toBe('Acme MSP');
    expect(env.replyTo).toBe('billing@example.com');
    expect(env.attachments).toBeUndefined();
    expect(env.html).toContain('February 1, 2027');
  });

  it('uses the partner\'s saved agreement_request_send override', async () => {
    await deliverAgreementRequestEmail({ ...delivery, partnerSettings: { emailTemplates: { agreement_request_send: { subject: 'Custom {{agreement_name}}' } } } });
    expect(sendEmailMock.mock.calls[0]![0].subject).toBe('Custom BAA');
  });

  it('no email service → emailed:false no_email_service, nothing thrown', async () => {
    getEmailServiceMock.mockReturnValue(null);
    expect(await deliverAgreementRequestEmail(delivery)).toEqual({ emailed: false, emailReason: 'no_email_service' });
  });

  it('no recipients → emailed:false no_recipients', async () => {
    expect(await deliverAgreementRequestEmail({ ...delivery, recipients: [] })).toEqual({ emailed: false, emailReason: 'no_recipients' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('a transport failure → emailed:false send_failed, captured, never rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmailMock.mockRejectedValue(new Error('smtp down'));
    expect(await deliverAgreementRequestEmail(delivery)).toEqual({ emailed: false, emailReason: 'send_failed' });
    expect(captureException).toHaveBeenCalled();
    err.mockRestore();
  });
});
