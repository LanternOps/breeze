import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BASE_PATH, withBase } from './basePath';
import {
  PORTAL_DISABLED_CODES,
  PORTAL_GATED_PAGES,
  PORTAL_UNGATED_HOME,
  isPortalPageDisabled,
  redirectToPortalHomeAfterDisabled,
} from './visibilityGate';

// vitest runs without Astro's BASE_URL, so BASE_PATH is '' here and '/portal' in
// the app. Building both sides through withBase keeps the contract honest in both.

/** The strict fail-closed visibility gates (#4562) and the fail-open feature
 *  gates (#2345) — every one of them means "the MSP switched this page off". */
const GATE_CODES = [
  'PORTAL_DASHBOARD_DISABLED',
  'PORTAL_SECURITY_DISABLED',
  'PORTAL_BACKUPS_DISABLED',
  'PORTAL_REPORTS_DISABLED',
  'PORTAL_SUPPORT_USAGE_DISABLED',
  'PORTAL_TICKETS_DISABLED',
  'PORTAL_SELF_SERVICE_DISABLED',
  'PORTAL_ASSET_CHECKOUT_DISABLED',
  'PORTAL_SERVICE_DISABLED',
  'PORTAL_DOCUMENTS_DISABLED',
];

describe('isPortalPageDisabled', () => {
  it.each(GATE_CODES)('reads a 403 %s as the page being switched off', (code) => {
    expect(isPortalPageDisabled({ statusCode: 403, code })).toBe(true);
  });

  it('is true when any of a page\'s parallel calls was refused by a gate', () => {
    // /security fans out two calls behind the same gate; either one answering
    // 403 means the page is off.
    expect(isPortalPageDisabled(
      { statusCode: 403, code: 'PORTAL_SECURITY_DISABLED' },
      { statusCode: 200 },
    )).toBe(true);
    expect(isPortalPageDisabled(
      { statusCode: 200 },
      { statusCode: 403, code: 'PORTAL_SECURITY_DISABLED' },
    )).toBe(true);
  });

  it('leaves the 403s that are NOT a switched-off page alone', () => {
    // portalAuthMiddleware answers "Account is not active" / "Organization is
    // not available" as a bare 403 with no code — a real refusal the customer
    // must still be told about, not silently bounced away.
    expect(isPortalPageDisabled({ statusCode: 403 })).toBe(false);
    expect(isPortalPageDisabled({ statusCode: 403, code: 'CSRF_FAILED' })).toBe(false);
  });

  it('is false for every outcome that is a load problem, not a policy one', () => {
    expect(isPortalPageDisabled({ statusCode: 200 })).toBe(false);
    expect(isPortalPageDisabled({ statusCode: 500, code: 'PORTAL_SECURITY_DISABLED' })).toBe(false);
    expect(isPortalPageDisabled({ statusCode: 404, code: 'PORTAL_SECURITY_DISABLED' })).toBe(false);
    // apiRequest's network-error catch returns a bare { error } — no status, no code.
    expect(isPortalPageDisabled({})).toBe(false);
  });

  it('is false when there are no responses at all', () => {
    expect(isPortalPageDisabled()).toBe(false);
  });
});

describe('redirectToPortalHomeAfterDisabled', () => {
  it('bounces to the ungated home, based and a 302', () => {
    const redirect = vi.fn((p: string) => new Response(null, { status: 302, headers: { location: p } }));
    const response = redirectToPortalHomeAfterDisabled({ redirect });
    expect(redirect).toHaveBeenCalledWith(withBase(PORTAL_UNGATED_HOME), 302);
    expect(response.headers.get('location')).toBe(`${BASE_PATH}${PORTAL_UNGATED_HOME}`);
  });

  it('never targets a page a visibility flag can switch off', () => {
    // A gated target turns one deliberate switch-off into a redirect chain —
    // or a loop, the moment the page it points at is the page that bounced.
    expect(PORTAL_GATED_PAGES).not.toContain(PORTAL_UNGATED_HOME);
    expect(PORTAL_UNGATED_HOME).toBe('/quotes');
  });
});

describe('gate-code parity with the API', () => {
  const apiSources = [
    '../../../api/src/routes/portal/featureFlags.ts',
    '../../../api/src/routes/portal/tickets.ts',
  ].map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8'));

  it('knows every PORTAL_*_DISABLED code the API can answer with', () => {
    const emitted = new Set(
      apiSources.flatMap((src) => [...src.matchAll(/'(PORTAL_[A-Z_]+_DISABLED)'/g)].map((m) => m[1])),
    );
    // Guard the guard: if this ever reads zero codes the API moved and the
    // assertion below passed vacuously.
    expect(emitted.size).toBeGreaterThan(0);
    const known: readonly string[] = PORTAL_DISABLED_CODES;
    expect([...emitted].filter((code) => !known.includes(code))).toEqual([]);
  });
});
