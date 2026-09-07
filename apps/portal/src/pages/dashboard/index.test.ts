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
