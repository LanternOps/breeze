import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');

describe('dashboard page failure state', () => {
  it('never prints the raw server error to the customer', () => {
    // A customer once read "Internal Server Error" as body text here.
    expect(pageSource).not.toContain('{response.error}');
  });

  it('hands the failure to the concierge error notice with the support contact', () => {
    expect(pageSource).toContain('DashboardUnavailable');
    expect(pageSource).toContain('loadPortalBranding');
    expect(pageSource).toContain('supportEmail');
  });
});

describe('dashboard page visibility gate', () => {
  it('bounces a dashboard the MSP switched off instead of reporting a load failure', () => {
    // #4932 — DashboardUnavailable is the concierge state for a page that
    // SHOULD have loaded. A gate 403 is the org never having turned the
    // dashboard on, which is not a problem for the customer to escalate.
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
  });

  it('decides before paying for the support-address round trip', () => {
    // The branding fetch exists only to explain a failure; a bounced page has
    // nothing to explain, so the gate check has to come first.
    expect(pageSource.indexOf('redirectToPortalHomeAfterDisabled(Astro)')).toBeLessThan(
      pageSource.indexOf('loadPortalBranding(Astro.request)'),
    );
  });

  it('cannot bounce to itself', () => {
    // The dashboard is the landing page whenever enableDashboard is on, so a
    // "redirect to the landing page" rule would loop here. The shared target is
    // a page no visibility flag can switch off (lib/visibilityGate.ts).
    expect(pageSource).not.toMatch(/redirect\([^)]*\/dashboard/);
  });
});

describe('dashboard page agreements card', () => {
  it('starts the agreements read alongside the dashboard read and never lets it fail the page', () => {
    expect(pageSource).toContain('portalApi.getAgreements');
    expect(pageSource.indexOf('agreementsPromise')).toBeLessThan(pageSource.indexOf('portalApi.getDashboard'));
    // Never rejects (a catch that resolves to []), and a failure is traced.
    expect(pageSource).toMatch(/\.catch\(\(err: unknown\) => \{[\s\S]*?return \[\];/);
    expect(pageSource).toContain("console.warn('[portal] dashboard agreements read");
  });

  it('hands the agreements read to DashboardTiles, which places the card under the heading (success branch only)', () => {
    // DashboardTiles renders the card between the page heading and the tiles and
    // counts signable agreements in its awaiting-you line (DashboardTiles.test.tsx).
    expect(pageSource).toContain('<DashboardTiles dashboard={response.data} agreements={agreements} />');
    expect(pageSource).not.toContain('<AgreementsAwaitingSignature');
  });
});
