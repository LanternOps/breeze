import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');
const listSource = readFileSync(
  new URL('../../components/portal/ReportRunList.tsx', import.meta.url),
  'utf8',
);

describe('reports page structure', () => {
  it('authors no heading of its own — the h1 belongs to ReportRunList', () => {
    // Structural guard: a hand-rolled h2/h3 here would land above the
    // component's own h1 and break the outline the shared EmptyState assumes.
    expect(pageSource).not.toMatch(/<h[1-6]\b/);
    expect(listSource).toMatch(/<PageHeader\s+title="Reports"/);
  });

  it('speaks of the customer machines, not their "environment"', () => {
    expect(listSource).toContain(
      'Generate and download a current summary of your machines.',
    );
    expect(listSource).not.toContain('your environment');
  });

  it('offers both generate actions as peers', () => {
    // A false primary made the security summary look like the page's one act.
    expect(listSource).not.toContain('BTN_PRIMARY');
    expect(listSource).toContain("'Generate security summary'");
  });
});

describe('reports page hardware lifecycle card (W02)', () => {
  it('loads branding and gates the card on enableLifecycle', () => {
    expect(pageSource).toContain('loadPortalBranding(Astro.request)');
    expect(pageSource).toMatch(/branding\.enableLifecycle/);
  });

  it('hands ReportRunList the lifecycle link (devices tab, or the standalone page when Self-service is off)', () => {
    // The link renders INSIDE ReportRunList, under the page title, as a ruled
    // row — a boxed card above the H1 read as a banner and put the page's
    // name second. /reports/lifecycle stays for orgs whose /devices bounces
    // home (#4932, #5880).
    expect(pageSource).toMatch(/lifecycleHref=\{[\s\S]*withBase\([^)]*'\/devices#lifecycle'[^)]*'\/reports\/lifecycle'\)/);
    expect(pageSource).toMatch(/branding\.enableSelfService !== false/);
    expect(pageSource).toMatch(/branding\.enableLifecycle/);
    expect(pageSource).not.toContain('data-testid="reports-lifecycle-card"');
  });
});

describe('reports page visibility gate', () => {
  it('bounces through the shared helper', () => {
    expect(pageSource).toContain('isPortalPageDisabled(response)');
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
  });

  it('no longer bounces to a page a toggle can switch off', () => {
    // This page was the only one that handled its gate, and it sent the customer
    // to /devices — itself gated on Self-service. With both off, one deliberate
    // switch-off became two hops ending in a "couldn't load your devices" error
    // (#4932). Every gated page now shares one never-gated target.
    expect(pageSource).not.toContain("withBase('/devices')");
  });
});
