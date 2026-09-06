import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('keeps the allowlist honest — no entry that stopped calling a gated method', () => {
    const stale = [...HANDLES_GATE_ELSEWHERE].filter((path) => {
      const page = pages.find((candidate) => candidate.path === path);
      return !page || gatedMethodsIn(page.source).length === 0;
    });
    expect(stale, 'remove these from HANDLES_GATE_ELSEWHERE').toEqual([]);
  });
});
