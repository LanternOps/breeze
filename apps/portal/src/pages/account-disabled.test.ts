import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./account-disabled.astro', import.meta.url), 'utf8');

/**
 * The page a disabled portal user lands on instead of the generic outage
 * copy (sweep 2026-09-08 G5-6). `PortalLayout` is reused deliberately: its
 * header already wires the tested `data-portal-logout` sign-out button, so a
 * disabled user always has a working way out of the app from here.
 */
describe('account-disabled page', () => {
  it('uses PortalLayout so the header sign-out control is present', () => {
    expect(pageSource).toContain('PortalLayout');
  });

  it('states plainly that access was disabled and to contact IT', () => {
    expect(pageSource).toContain('Your portal access has been disabled');
    expect(pageSource).toContain('Contact your IT provider');
  });
});
