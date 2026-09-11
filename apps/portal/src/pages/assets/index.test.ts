import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');

describe('equipment page asset-checkout gate', () => {
  it('bounces a page the MSP switched off instead of reporting a load failure', () => {
    // #4932 — AssetList prints `error` verbatim, so a gated request used to
    // show the customer the API's own words: "Asset checkout is not enabled for
    // this portal". That is our internal copy, not theirs.
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
    expect(pageSource).toContain('isPortalPageDisabled(response)');
  });
});
