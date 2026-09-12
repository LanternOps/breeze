import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTAL_GATED_PAGES } from './visibilityGate';
import { requiresAccountStatusGuard } from './protectedPaths';

/**
 * Contract test: a portal page whose data comes from behind a visibility gate
 * MUST branch on the gate's 403 code in its frontmatter instead of falling
 * through to its generic "we couldn't load this" copy.
 *
 * Without the branch, an MSP switching a toggle off in Settings → Organizations
 * → Customer Portal hands the customer a page that reads as a transient failure
 * and invites a support ticket about a switch that was deliberate (#4932). Only
 * /reports got the branch; Security, Backups, Dashboard, Devices and Equipment
 * all shipped the misleading copy, and nothing in review caught the fifth one.
 *
 * Frontmatter, not the template: the answer to a switched-off page is a 302 the
 * server returns before it renders anything, so a check written into the markup
 * would still ship the page shell. The API side is already fail-closed and
 * unit-tested (apps/api/src/routes/portal/featureFlags.test.ts) — this guards
 * the half that renders. sessionClearCoverage.test.ts is the same idea for 401s.
 */

const PAGES = fileURLToPath(new URL('../pages', import.meta.url));

/** portalApi methods that sit behind a visibility/feature gate, and the 403
 *  code the gate answers with (apps/api/src/routes/portal/index.ts). */
const GATED_API_METHODS: Record<string, string> = {
  getDashboard: 'PORTAL_DASHBOARD_DISABLED',
  getSecurityOverview: 'PORTAL_SECURITY_DISABLED',
  getSecurityDevices: 'PORTAL_SECURITY_DISABLED',
  getBackupOverview: 'PORTAL_BACKUPS_DISABLED',
  getBackupDevices: 'PORTAL_BACKUPS_DISABLED',
  getReportRuns: 'PORTAL_REPORTS_DISABLED',
  getSupportUsage: 'PORTAL_SUPPORT_USAGE_DISABLED',
  getDevices: 'PORTAL_SELF_SERVICE_DISABLED',
  getAssets: 'PORTAL_ASSET_CHECKOUT_DISABLED',
  getTickets: 'PORTAL_TICKETS_DISABLED',
  getTicket: 'PORTAL_TICKETS_DISABLED',
  getTicketForms: 'PORTAL_TICKETS_DISABLED',
  getService: 'PORTAL_SERVICE_DISABLED',
  getServiceOccurrences: 'PORTAL_SERVICE_DISABLED',
  getDocuments: 'PORTAL_DOCUMENTS_DISABLED',
};

/**
 * Pages that handle their gate deliberately in some other sanctioned way. Each
 * entry is a decision, not a gap — say which one.
 *
 * - tickets/index.astro: a switched-off Support page is not a dead page. It
 *   keeps its title and explains that request submission is closed while still
 *   showing the support-usage panel when that flag is on; the decision lives in
 *   lib/ticketsPage.ts and is unit-tested by ticketsPage.test.ts.
 */
const HANDLES_GATE_ELSEWHERE = new Set(['tickets/index.astro']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return entry.endsWith('.astro') ? [full] : [];
  });
}

/** The server-run frontmatter of an Astro page (undefined if it has none). */
function frontmatterOf(source: string): string | undefined {
  return source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
}

function gatedMethodsIn(source: string): string[] {
  return Object.keys(GATED_API_METHODS).filter((method) =>
    new RegExp(`portalApi\\.${method}\\b`).test(source),
  );
}

describe('visibility-gate handling in portal pages', () => {
  const pages = walk(PAGES).map((file) => ({
    path: relative(PAGES, file),
    source: readFileSync(file, 'utf8'),
  }));

  it('finds portal pages to scan', () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it('every page fed by a gated API method answers the gate 403 before it renders', () => {
    const violations: string[] = [];

    for (const { path, source } of pages) {
      const methods = gatedMethodsIn(source);
      if (methods.length === 0 || HANDLES_GATE_ELSEWHERE.has(path)) continue;

      const codes = [...new Set(methods.map((method) => GATED_API_METHODS[method]))];
      const frontmatter = frontmatterOf(source);

      // Sanctioned: bounce through the shared helper, or name the gate's code
      // explicitly (a page that renders its own "not available" state).
      const handled =
        frontmatter !== undefined &&
        (/redirectToPortalHomeAfterDisabled\(Astro\)/.test(frontmatter) ||
          codes.some((code) => frontmatter.includes(code)));

      if (!handled) {
        violations.push(
          `${path}  calls ${methods.map((m) => `portalApi.${m}`).join(', ')} ` +
            `but its frontmatter never checks ${codes.join(' / ')}`,
        );
      }
    }

    expect(
      violations,
      'A gate 403 means the MSP switched this page off — redirect through ' +
        'redirectToPortalHomeAfterDisabled instead of rendering a load failure:\n' +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('never redirects a disabled page onto another gated page', () => {
    // #4932 follow-up: a gate 403 that bounces to /devices (itself gated on
    // Self-service) becomes two hops when both are off. The "handled" check
    // above accepts any page that names its gate code, so a stale hardcoded
    // target passes it — assert the target directly.
    const gated = PORTAL_GATED_PAGES.map((page) => page.replace(/^\//, ''));
    const pattern = new RegExp(`Astro\\.redirect\\(withBase\\('/(?:${gated.join('|')})(?:/[^']*)?'\\)\\)`);
    const stale = pages
      .filter(({ source }) => gatedMethodsIn(source).length > 0)
      .filter(({ source }) => pattern.test(frontmatterOf(source) ?? ''))
      .map(({ path }) => path);
    expect(
      stale,
      'these pages answer a gate 403 by redirecting onto another gated page — use redirectToPortalHomeAfterDisabled',
    ).toEqual([]);
  });

  it('keeps the allowlist honest — no entry that stopped calling a gated method', () => {
    const stale = [...HANDLES_GATE_ELSEWHERE].filter((path) => {
      const page = pages.find((candidate) => candidate.path === path);
      return !page || gatedMethodsIn(page.source).length === 0;
    });
    expect(stale, 'remove these from HANDLES_GATE_ELSEWHERE').toEqual([]);
  });
});

/**
 * Contract test: every signed-in page is covered by the middleware's
 * account-status guard, so a disabled ACCOUNT never renders the API's raw
 * "Account is not active" string inline (#5320).
 *
 * The gate above is per-page (an MSP switched THIS page off); this one is
 * per-account and lives in the middleware — a new page area only has to be
 * added to PORTAL_PROTECTED_PREFIXES, and this test is what notices when it
 * isn't. That was the exact miss: /quotes carried a hand-rolled check and the
 * other nine signed-in areas carried nothing.
 */

/**
 * Pages that are deliberately reachable without a portal session — each is a
 * decision, not a gap.
 *
 * - login / forgot-password / reset-password / accept-invite: the auth wall
 *   itself. The middleware's authenticated-landing redirect already sends a
 *   signed-in disabled account off /login and /forgot-password.
 * - index.astro: pure redirect; resolveAuthenticatedLanding (lib/landing.ts)
 *   handles the disabled case there.
 * - account-disabled: the destination — guarding it would loop.
 * - quote/[token], invoice/[token], invoice/return: the URL token IS the
 *   capability; these documents are emailed to people who never sign in.
 */
const UNAUTHENTICATED_PAGES = new Set([
  'index.astro',
  'login.astro',
  'forgot-password.astro',
  'reset-password.astro',
  'accept-invite.astro',
  'account-disabled.astro',
  'quote/[token].astro',
  'invoice/[token].astro',
  'invoice/return.astro',
]);

/** src/pages-relative file → the route the middleware sees (base stripped). */
function routeOf(pagePath: string): string {
  const route = pagePath
    .replace(/\.astro$/, '')
    .replace(/\/index$/, '')
    .replace(/\[[^\]]+\]/g, 'token');
  return route === 'index' ? '/' : `/${route}`;
}

describe('account-disabled coverage in portal pages', () => {
  const pages = walk(PAGES).map((file) => relative(PAGES, file));

  it('every signed-in page sits behind the middleware account-status guard', () => {
    const unguarded = pages
      .filter((page) => !UNAUTHENTICATED_PAGES.has(page))
      .filter((page) => !requiresAccountStatusGuard(routeOf(page)));

    expect(
      unguarded,
      'add these page areas to PORTAL_PROTECTED_PREFIXES (lib/protectedPaths.ts) — ' +
        'without it a disabled account renders the API\'s raw "Account is not active" text:\n' +
        unguarded.join('\n'),
    ).toEqual([]);
  });

  it('keeps the unauthenticated allowlist honest — no entry for a page that no longer exists', () => {
    const stale = [...UNAUTHENTICATED_PAGES].filter((page) => !pages.includes(page));
    expect(stale, 'remove these from UNAUTHENTICATED_PAGES').toEqual([]);
  });
});
