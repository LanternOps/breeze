import { describe, expect, it, vi } from 'vitest';
import { MAIL_PURPOSES, mailPurposePolicy } from './emailDomains/mailPurposes';

vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import {
  EmailService,
  buildPortalSelfRegistrationLinkTemplate,
  buildPortalSelfRegistrationExistingAccountTemplate,
} from './email';

/**
 * Portal registration W6 (#11383): the two mails of the self-registration
 * flow. Neither carries any requester-typed text — there is deliberately no
 * `name` parameter.
 */
const PARTNER_ID = '11111111-1111-1111-1111-111111111111';
const verifyBase = {
  to: 'person@example.com',
  verifyUrl: 'https://portal.example.com/register/verify?token=abc',
  orgName: 'Acme Co',
  partnerId: PARTNER_ID,
  partnerName: 'Acme MSP',
};
const existingBase = {
  to: 'person@example.com',
  loginUrl: 'https://portal.example.com/login',
  forgotPasswordUrl: 'https://portal.example.com/forgot-password',
  orgName: 'Acme Co',
  partnerId: PARTNER_ID,
  partnerName: 'Acme MSP',
};

describe('portal self-registration emails', () => {
  it('the verify email carries the link, the org name and the ignore line, and no requester-supplied text', () => {
    const t = buildPortalSelfRegistrationLinkTemplate(verifyBase);
    expect(t.subject).toBe("Confirm your request for access to Acme Co's portal");
    for (const body of [t.html, t.text]) {
      expect(body).toContain('Acme Co');
      expect(body).toContain('verify?token=abc');
      expect(body).toContain('30 minutes');
      expect(body).toContain('Confirm my request');
    }
    expect(t.text).toContain("If you didn't ask for this, ignore this email.");
    expect(t.html).toContain('If you didn&#39;t ask for this, ignore this email.');
    // Nothing the requester typed can reach the mail: the params have no name.
    expect(Object.keys(verifyBase)).not.toContain('name');
    const evil = buildPortalSelfRegistrationLinkTemplate({ ...verifyBase, orgName: '<b>Acme & Co</b>' });
    expect(evil.html).not.toContain('<b>Acme');
    expect(evil.html).toContain('&lt;b&gt;Acme &amp; Co&lt;/b&gt;');
  });

  it('the existing-account email links to sign in and forgot password', () => {
    const t = buildPortalSelfRegistrationExistingAccountTemplate(existingBase);
    expect(t.subject).toBe("You already have an account for Acme Co's portal");
    for (const body of [t.html, t.text]) {
      expect(body).toContain('https://portal.example.com/login');
      expect(body).toContain('https://portal.example.com/forgot-password');
      expect(body).toContain('Microsoft');
      expect(body).toContain('contact your IT provider');
    }
    const evil = buildPortalSelfRegistrationExistingAccountTemplate({ ...existingBase, orgName: '<i>x</i>' });
    expect(evil.html).not.toContain('<i>x</i>');
  });

  it('both use the partner lane with the org partner as sender', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'no-reply@example.com';
    const svc = new EmailService();
    const spy = vi.spyOn(svc, 'sendEmail').mockResolvedValue(undefined as never);
    await svc.sendPortalSelfRegistrationLink(verifyBase);
    await svc.sendPortalSelfRegistrationExistingAccount(existingBase);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      purpose: 'portal.self_registration.verify', partnerId: PARTNER_ID, partnerName: 'Acme MSP', to: 'person@example.com',
    });
    expect(spy.mock.calls[1]![0]).toMatchObject({
      purpose: 'portal.self_registration.existing_account', partnerId: PARTNER_ID, partnerName: 'Acme MSP',
    });
  });

  it('mail purposes register both self_registration purposes on the partner/support lane', () => {
    for (const p of ['portal.self_registration.verify', 'portal.self_registration.existing_account'] as const) {
      expect(MAIL_PURPOSES).toHaveProperty(p);
      expect(mailPurposePolicy(p)).toEqual({ lane: 'partner', stream: 'support', fallbackFrom: 'partner_display_name' });
    }
  });
});
