import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');
const componentSource = readFileSync(
  new URL('../../components/portal/ServiceScorecard.tsx', import.meta.url), 'utf8');

describe('service page visibility gate', () => {
  it('bounces a page the MSP switched off instead of reporting a load failure', () => {
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
  });
  it('redirects on 401 before rendering', () => {
    expect(pageSource).toContain('redirectToLoginAfter401(Astro)');
  });
});

describe('service page fetch states', () => {
  it('never prints a raw transport error at the customer', () => {
    expect(pageSource).not.toMatch(/\{response\.error\}/);
  });
  it('names the recovery in the failure copy and keeps the page title', () => {
    expect(pageSource).toContain('data-testid="portal-service-error"');
    expect(pageSource).toContain("We couldn't load your service summary just now. Your IT team can help.");
    expect(pageSource).toMatch(/<PageHeader\s+title="Service"/);
  });
});

describe('service scorecard publication rules', () => {
  it('renders no ticket anywhere', () => {
    // Spec D10 belongs to the read model, but a component that invented a
    // "View ticket" link would defeat it — assert the component source too.
    expect(componentSource).not.toMatch(/ticket/i);
  });
  it('states plainly when the MSP holds the artifact', () => {
    expect(componentSource).toContain('held_by_msp');
    expect(componentSource).toContain('Delivered (artifact held by your IT team)');
  });
  it('gives every list, row and download a testid', () => {
    for (const id of [
      'portal-service-groups', 'portal-service-key-dates', 'portal-service-empty',
    ]) expect(componentSource).toContain(`data-testid="${id}"`);
    expect(componentSource).toMatch(/data-testid=\{`portal-service-row-\$\{/);
    expect(componentSource).toMatch(/data-testid=\{`portal-service-occurrence-row-\$\{/);
  });
});
