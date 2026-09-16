import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./lifecycle.astro', import.meta.url), 'utf8');

describe('lifecycle page structure', () => {
  it('fetches through the gated portalApi method', () => {
    expect(pageSource).toContain('portalApi.getHardwareLifecycleLatest(');
  });

  it('mounts LifecyclePage with the fetched run and summary', () => {
    expect(pageSource).toMatch(/<LifecyclePage[^>]*initialRun={run}/);
    expect(pageSource).toMatch(/<LifecyclePage[^>]*initialSummary={summary}/);
  });

  it('threads the response contact into the hydrated page', () => {
    expect(pageSource).toContain('response.data?.contact ?? null');
    expect(pageSource).toMatch(/<LifecyclePage[^>]*initialContact={contact}/);
  });

  // #5880: the Computer-cell link must not be rendered for orgs with
  // self-service off, so the flag has to reach LifecyclePage from the DTO.
  it('threads the DTO\'s enableSelfService flag through to LifecyclePage', () => {
    expect(pageSource).toMatch(/<LifecyclePage[^>]*enableSelfService={enableSelfService}/);
    expect(pageSource).toContain('response.data?.enableSelfService ?? false');
  });
});

describe('lifecycle page visibility gate', () => {
  it('redirects to login on a 401', () => {
    expect(pageSource).toContain('redirectToLoginAfter401(Astro)');
    expect(pageSource).toContain("response.statusCode === 401");
  });

  it('bounces through the shared disabled-page helper for both PORTAL_REPORTS_DISABLED and PORTAL_LIFECYCLE_DISABLED', () => {
    // isPortalPageDisabled checks every code in PORTAL_DISABLED_CODES, which
    // already includes PORTAL_LIFECYCLE_DISABLED — this page needs no
    // code-specific branch, matching disabledPageCoverage.test.ts's contract.
    expect(pageSource).toContain('isPortalPageDisabled(response)');
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
  });

  it('treats a not-yet-generated run as data, not a redirect', () => {
    // PORTAL_REPORT_NOT_GENERATED (404) must fall through to the empty state:
    // no branch on statusCode === 404, just a null-safe read of response.data.
    expect(pageSource).not.toMatch(/statusCode === 404/);
    expect(pageSource).toContain('response.data?.run ?? null');
    expect(pageSource).toContain('response.data?.summary ?? null');
  });
});
