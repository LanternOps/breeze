import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');

describe('quotes page account-disabled state (sweep 2026-09-08 G5-6)', () => {
  it('redirects to the account-disabled page instead of rendering the generic failure', () => {
    // A disabled portal user used to hit /quotes (the fixed post-login
    // landing page) and see the bare "Account is not active" string rendered
    // straight through QuoteList's error prop, like a load failure. It is
    // not one — bounce, the same way the visibility gates do.
    expect(pageSource).toContain('isAccountDisabledResponse');
    expect(pageSource).toContain('redirectToAccountDisabled(Astro)');
  });

  it('decides before handing anything to QuoteList', () => {
    expect(pageSource.indexOf('redirectToAccountDisabled(Astro)')).toBeLessThan(
      pageSource.indexOf('<QuoteList'),
    );
  });
});
