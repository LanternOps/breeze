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

  it('never redirects on dataStatus: no_data — that state renders the empty state, not a bounce', () => {
    // NetworkOverview.tsx handles 'no_data' as an in-page empty state. A future
    // edit could easily conflate the two given how similar the names read.
    expect(pageSource).not.toContain("dataStatus === 'no_data'");
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

describe('network page per-site health (CPEV-W2)', () => {
  it('fetches the summary as the fifth call of the shared Promise.all', () => {
    expect(pageSource).toContain('portalApi.getNetworkSiteHealth(config)');
    expect(pageSource).toMatch(
      /const \[response, assets, dashboard, siteList, siteHealth\] = await Promise\.all\(\[/
    );
  });

  it('mounts NetworkSiteHealth only when the summary data exists, server-rendered (no client: directive)', () => {
    expect(pageSource).toMatch(/siteHealth\.data && <NetworkSiteHealth health={siteHealth\.data} \/>/);
    expect(pageSource).not.toMatch(/<NetworkSiteHealth[^>]*client:/);
  });

  it('places the summary between the overview and the asset table', () => {
    const overview = pageSource.indexOf('<NetworkOverview');
    const health = pageSource.indexOf('<NetworkSiteHealth');
    const table = pageSource.indexOf('<NetworkAssetTable');
    expect(overview).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(overview);
    expect(table).toBeGreaterThan(health);
  });

  it('a summary failure only hides the section: it feeds neither the 401 redirect, the disabled bounce nor the error notice', () => {
    expect(pageSource).not.toContain('siteHealth.statusCode');
    expect(pageSource).not.toContain('siteHealth.error');
    expect(pageSource).not.toMatch(/siteHealth\.data\?\.dataStatus/);
    expect(pageSource).toContain('response.statusCode === 401 || assets.statusCode === 401');
    // Every line that decides a redirect reads only the overview and the list.
    const guards = pageSource.split('\n').filter((line) => /statusCode === 401|dataStatus === 'not_enabled'/.test(line));
    expect(guards.length).toBeGreaterThanOrEqual(2);
    for (const line of guards) expect(line).not.toContain('siteHealth');
  });
});
