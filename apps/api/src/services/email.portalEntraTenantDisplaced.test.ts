import { describe, expect, it, vi } from 'vitest';

vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { buildPortalEntraTenantDisplacedTemplate } from './email';

/**
 * Portal registration W4 (#11381, plan D7): the notice Breeze sends the
 * displaced partner's active admins after another org proved the tenant their
 * customer org was mapped to. Platform mail to MSP staff, Breeze-branded.
 */
describe('buildPortalEntraTenantDisplacedTemplate', () => {
  const base = {
    to: ['admin@msp.test'],
    partnerName: 'Acme MSP',
    orgName: 'Contoso',
    tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  };

  it('names the org and the tenant, and says what stopped working, in both arms', () => {
    const t = buildPortalEntraTenantDisplacedTemplate(base);
    expect(t.subject).toBe('Microsoft tenant link removed from Contoso');
    for (const body of [t.html, t.text]) {
      expect(body).toContain('Contoso');
      expect(body).toContain('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      expect(body).toContain('Microsoft sign-in');
      expect(body).toContain('Acme MSP');
    }
    // A notice, not a call to action: no button, no link.
    expect(t.html).not.toMatch(/<a href=/);
  });

  it('never names the org that proved the tenant', () => {
    const t = buildPortalEntraTenantDisplacedTemplate(base);
    expect(t.html).toContain('another organization');
    expect(t.text).toContain('another organization');
  });

  it('escapes every interpolated value in the html', () => {
    const t = buildPortalEntraTenantDisplacedTemplate({
      ...base,
      orgName: '<b>Evil</b> & Co',
      partnerName: '<script>x</script>',
    });
    expect(t.html).not.toContain('<b>Evil</b>');
    expect(t.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
    expect(t.html).not.toContain('<script>x</script>');
  });
});
