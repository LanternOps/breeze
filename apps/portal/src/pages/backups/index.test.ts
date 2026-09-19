import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');

describe('backups page visibility gate', () => {
  it('bounces a page the MSP switched off instead of reporting a load failure', () => {
    // #4932 — "We couldn't load your backups just now. Your IT team can help."
    // tells the customer something broke when the MSP simply turned Backups off.
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
  });

  it('reads the gate off the two backups calls only', () => {
    expect(pageSource).toMatch(/isPortalPageDisabled\(overview, devices\)/);
  });

  it('never lets the ride-along dashboard call switch this page off', () => {
    // The dashboard is fetched only for `timezone`; it sits behind its own gate.
    // An org with Backups on and Dashboard off must keep its backups page — so
    // the dashboard response cannot be part of the disabled check.
    expect(pageSource).not.toMatch(/isPortalPageDisabled\([^)]*dashboard/);
  });
});
