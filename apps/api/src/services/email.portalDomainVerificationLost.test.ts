import { describe, expect, it, vi } from 'vitest';

vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { buildPortalDomainVerificationLostTemplate, type PortalDomainVerificationLostReason } from './email';

/**
 * Portal registration W5 (#11382): the notice Breeze sends a partner's active
 * admins when a customer org's domain stops being verified. Platform mail.
 */
describe('buildPortalDomainVerificationLostTemplate', () => {
  const base = {
    to: ['admin@msp.test'],
    partnerName: 'Acme MSP',
    orgName: 'Contoso',
    domain: 'contoso.test',
    reason: 'record_missing' as PortalDomainVerificationLostReason,
  };

  const SENTENCES: Record<PortalDomainVerificationLostReason, string> = {
    record_missing: 'the DNS verification record was not found on two consecutive daily checks',
    not_in_directory: "the domain is no longer a verified domain in the customer's Microsoft 365 or Google Workspace directory",
    tenant_not_proven: "the organization's Microsoft Entra tenant is no longer proven",
    connection_missing: 'the Microsoft 365 or Google Workspace connection used to verify it was removed',
    stale: 'it could not be re-checked for 7 days',
    displaced: "another organization proved control of the domain while this organization's evidence no longer checked out",
  };

  it('puts the domain in the subject and names org, domain and consequence in both arms', () => {
    const t = buildPortalDomainVerificationLostTemplate(base);
    expect(t.subject).toBe('Domain verification lost: contoso.test');
    for (const body of [t.html, t.text]) {
      expect(body).toContain('contoso.test');
      expect(body).toContain('Contoso');
      expect(body).toContain('Acme MSP');
      expect(body).toContain('self-registration');
      expect(body).toContain('Google sign-in');
      expect(body).toContain('Organization › Domains');
    }
  });

  it.each(Object.entries(SENTENCES))('renders its own sentence for %s', (reason, sentence) => {
    const t = buildPortalDomainVerificationLostTemplate({ ...base, reason: reason as PortalDomainVerificationLostReason });
    expect(t.text).toContain(sentence);
    expect(t.html).toContain(sentence.replace(/'/g, '&#39;'));
    for (const [other, s] of Object.entries(SENTENCES)) {
      if (other !== reason) expect(t.text).not.toContain(s);
    }
  });

  it('escapes every interpolated value in the html', () => {
    const t = buildPortalDomainVerificationLostTemplate({
      ...base,
      orgName: '<b>Evil</b> & Co',
      partnerName: '<script>x</script>',
      domain: '<i>d</i>.test',
    });
    expect(t.html).not.toContain('<b>Evil</b>');
    expect(t.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
    expect(t.html).not.toContain('<script>x</script>');
    expect(t.html).not.toContain('<i>d</i>');
  });

  it('text arm contains no HTML', () => {
    const t = buildPortalDomainVerificationLostTemplate(base);
    expect(t.text).not.toMatch(/<[a-z/][^>]*>/i);
  });
});
