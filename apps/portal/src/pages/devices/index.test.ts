import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');

describe('devices page self-service gate', () => {
  it('bounces a list the MSP switched off instead of reporting a load failure', () => {
    // #4932 — /portal/devices is gated on Self-service, and DeviceList answers
    // any error with "We couldn't load your devices just now. Your IT team can
    // help." That is the wrong answer to a deliberate switch-off.
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
    expect(pageSource).toContain('isPortalPageDisabled(response)');
  });

  it('still hands a genuine load failure to the list to explain', () => {
    // The gate branch must not swallow the transport-error path: a 500 or a
    // network failure is still the customer's page failing, and the list has
    // the copy for it.
    expect(pageSource).toMatch(/<DeviceList[\s\S]*error=\{response\.error\}/);
  });
});
