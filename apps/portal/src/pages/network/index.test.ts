import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');

describe('network page structure', () => {
  it('fetches through portalApi.getNetworkOverview', () => {
    expect(pageSource).toContain('portalApi.getNetworkOverview(');
  });

  it('mounts NetworkOverview with the fetched overview', () => {
    expect(pageSource).toMatch(/<NetworkOverview[^>]*overview={response\.data}/);
  });
});

describe('network page visibility gate (#6640)', () => {
  it('redirects to login on a 401', () => {
    expect(pageSource).toContain('redirectToLoginAfter401(Astro)');
    expect(pageSource).toContain('response.statusCode === 401');
  });

  it('bounces through the shared disabled-page helper on dataStatus: not_enabled, since the endpoint answers 200 not a 403', () => {
    // GET /portal/network/overview always answers 200; a disabled flag comes
    // back as dataStatus: 'not_enabled' in the body, so isPortalPageDisabled
    // (which only understands 403 gate codes) cannot catch this — the page
    // must check the DTO directly.
    expect(pageSource).toContain("response.data?.dataStatus === 'not_enabled'");
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
  });

  it('never redirects a disabled page onto another gated page', () => {
    expect(pageSource).not.toMatch(
      /redirectToPortalHomeAfterDisabled[\s\S]{0,80}Astro\.redirect\(withBase\('\/(devices|tickets|assets|security|backups|reports|service|documents)/
    );
  });
});

describe('network page data states', () => {
  it('shows an error notice, not the empty state, when the fetch itself fails', () => {
    expect(pageSource).toContain('portal-network-error');
  });
});
