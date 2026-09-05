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
