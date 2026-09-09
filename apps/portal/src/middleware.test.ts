import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const middlewareSource = readFileSync(new URL('./middleware.ts', import.meta.url), 'utf8');

/**
 * The `/login`-while-already-signed-in redirect guard used to pick a landing
 * page purely from branding, so a disabled portal user hitting `/login` (or
 * being redirected there) bounced straight to `/quotes` — the one page no
 * visibility flag can turn off — where it 403'd all over again with no
 * explanation (sweep 2026-09-08 G5-6). It must check account status FIRST.
 *
 * Source-inspection test, matching the existing convention for this file's
 * class of behavior (see pages/dashboard/index.test.ts) — `defineMiddleware`
 * has no lightweight unit-test harness in this repo yet.
 */
describe('portal middleware — authenticated landing (sweep 2026-09-08 G5-6)', () => {
  it('resolves the post-login landing through the account-status-aware helper', () => {
    expect(middlewareSource).toContain('loadPortalBrandingWithStatus');
    expect(middlewareSource).toContain('resolveAuthenticatedLanding');
  });

  it('no longer computes the landing from branding alone', () => {
    expect(middlewareSource).not.toContain('portalLandingPath(await loadPortalBranding(request))');
  });
});
