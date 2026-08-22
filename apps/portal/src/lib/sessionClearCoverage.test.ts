import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearPortalSessionCookie, redirectToLoginAfter401, PORTAL_SESSION_COOKIE_NAME } from './session';
import { BASE_PATH, withBase } from './basePath';

// vitest runs without Astro's BASE_URL, so BASE_PATH is '' here and '/portal' in
// the app. Building both sides through BASE_PATH/withBase keeps the contract
// under test (strip the base from `next`, prefix it on /login) honest in both.

/**
 * Contract test: a page that answers an API 401 with a redirect MUST go through
 * redirectToLoginAfter401, which clears the stale session cookie and carries
 * `?next=` back to the page.
 *
 * Without the cookie clear, a cookie that outlives its server session traps the
 * customer in /login ↔ /quotes forever (ERR_TOO_MANY_REDIRECTS — a lockout, not
 * a degraded page). Without `next`, an emailed invoice link with an expired
 * cookie lands on /quotes after sign-in. Both shipped once; nine pages carry
 * the block by hand, so the tenth is the one this test is for.
 */

const PAGES = fileURLToPath(new URL('../pages', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return entry.endsWith('.astro') ? [full] : [];
  });
}

describe('401 handling in portal pages', () => {
  it('every page that redirects on a 401 goes through redirectToLoginAfter401', () => {
    const violations: string[] = [];
    for (const file of walk(PAGES)) {
      const src = readFileSync(file, 'utf8');
      const blocks = src.matchAll(/statusCode === 401\)\s*\{([\s\S]*?)\n\}/g);
      for (const m of blocks) {
        const body = m[1];
        // quote/[token].astro deliberately renders instead of redirecting.
        if (!/Astro\.redirect|redirectToLoginAfter401/.test(body)) continue;
        if (!/redirectToLoginAfter401\(Astro\)/.test(body)) {
          violations.push(relative(PAGES, file));
        }
      }
    }
    expect(violations, 'pages redirecting on 401 without clearing the cookie + next').toEqual([]);
  });
});

describe('redirectToLoginAfter401', () => {
  it('clearPortalSessionCookie deletes the API cookie at path=/', () => {
    const del = vi.fn();
    clearPortalSessionCookie({ delete: del });
    expect(del).toHaveBeenCalledWith(PORTAL_SESSION_COOKIE_NAME, { path: '/' });
  });

  it('clears the cookie and carries the deep link (incl. query) as next', () => {
    const del = vi.fn();
    const redirect = vi.fn((p: string) => new Response(null, { status: 302, headers: { location: p } }));
    redirectToLoginAfter401({
      cookies: { delete: del },
      url: new URL(`http://portal.test${BASE_PATH}/invoices/abc?paid=1&session_id=cs_1`),
      redirect,
    });
    expect(del).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(
      withBase('/login?next=' + encodeURIComponent('/invoices/abc?paid=1&session_id=cs_1')),
      302
    );
  });

  it('sends the default landing and root to a bare /login', () => {
    const redirect = vi.fn((p: string) => new Response(null, { status: 302, headers: { location: p } }));
    redirectToLoginAfter401({ cookies: { delete: vi.fn() }, url: new URL(`http://portal.test${BASE_PATH}/quotes`), redirect });
    expect(redirect).toHaveBeenCalledWith(withBase('/login'), 302);
  });
});
