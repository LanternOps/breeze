import { describe, expect, it, vi } from 'vitest';

vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { buildPortalDirectoryHeldTemplate } from './email';

/**
 * Portal registration W8 (#11385, plan D12): the notice Breeze sends a
 * partner's active admins when a directory deprovisioning run is held for
 * their approval. Platform mail. It names the org, the directory and the
 * count, links to the org's Portal tab, and lists no people.
 */
describe('buildPortalDirectoryHeldTemplate', () => {
  const base = {
    to: ['admin@msp.test'],
    partnerName: 'Acme MSP',
    orgName: 'Contoso',
    source: 'entra' as const,
    affected: 4,
    portalTabUrl: 'https://app.example.com/settings/organizations/0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01#portal',
  };

  it('the held email names the org, directory and count, links to the Portal tab, and lists no people', () => {
    const t = buildPortalDirectoryHeldTemplate(base);
    expect(t.subject).toBe('Portal sign-ins held for your review: Contoso');
    for (const body of [t.html, t.text]) {
      expect(body).toContain('Contoso');
      expect(body).toContain('Microsoft Entra');
      expect(body).toContain('4 portal accounts');
      expect(body).toContain('Acme MSP');
      expect(body).toContain(base.portalTabUrl);
    }
    // Lists no people: nothing but the count describes who is affected.
    expect(t.text).not.toMatch(/@(?!msp\.test)/);
    expect(t.html).not.toMatch(/mailto:/);
  });

  it('names Google Workspace for a google run and uses the singular for one account', () => {
    const t = buildPortalDirectoryHeldTemplate({ ...base, source: 'google', affected: 1 });
    expect(t.text).toContain('Google Workspace');
    expect(t.text).toContain('1 portal account ');
    expect(t.text).not.toContain('Microsoft Entra');
  });

  it('without a dashboard URL the text says where to go and the html has no button', () => {
    const t = buildPortalDirectoryHeldTemplate({ ...base, portalTabUrl: null });
    expect(t.text).toContain('Settings › Organizations › Contoso › Portal');
    expect(t.html).not.toContain('href="https://app.example.com');
  });

  it('escapes every interpolated value in the html', () => {
    const t = buildPortalDirectoryHeldTemplate({ ...base, orgName: '<b>Evil</b> & Co', partnerName: '<script>x</script>' });
    expect(t.html).not.toContain('<b>Evil</b>');
    expect(t.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
    expect(t.html).not.toContain('<script>x</script>');
  });

  it('text arm contains no HTML', () => {
    const t = buildPortalDirectoryHeldTemplate(base);
    expect(t.text).not.toMatch(/<[a-z/][^>]*>/i);
  });
});
