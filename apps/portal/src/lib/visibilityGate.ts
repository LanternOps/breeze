import { withBase } from './basePath';

/**
 * The 403 codes the API's portal gates answer with when an MSP has switched a
 * page off (apps/api/src/routes/portal/featureFlags.ts, plus the tickets gate in
 * routes/portal/tickets.ts). Read as one class: each is a deliberate
 * configuration decision, NOT a load failure, so none of them may reach a page's
 * "we couldn't load this just now" copy (#4932).
 *
 * Five are the strict fail-closed visibility flags of #4562; three are the older
 * fail-open feature gates of #2345. visibilityGate.test.ts asserts this list
 * still covers every code the API can emit.
 */
export const PORTAL_DISABLED_CODES = [
  'PORTAL_DASHBOARD_DISABLED',
  'PORTAL_SECURITY_DISABLED',
  'PORTAL_BACKUPS_DISABLED',
  'PORTAL_REPORTS_DISABLED',
  'PORTAL_SUPPORT_USAGE_DISABLED',
  'PORTAL_TICKETS_DISABLED',
  'PORTAL_SELF_SERVICE_DISABLED',
  'PORTAL_ASSET_CHECKOUT_DISABLED',
  // Service deliverables W04 (#5573): two more strict fail-closed flags.
  'PORTAL_SERVICE_DISABLED',
  'PORTAL_DOCUMENTS_DISABLED',
] as const;

const DISABLED_CODE_SET: ReadonlySet<string> = new Set(PORTAL_DISABLED_CODES);

/** Every portal page a toggle can switch off. Kept next to the target below so
 *  the "never bounce to a gated page" invariant is checkable, not hoped for. */
export const PORTAL_GATED_PAGES = [
  '/dashboard',
  '/security',
  '/backups',
  '/reports',
  '/devices',
  '/assets',
  '/tickets',
  '/service',
  '/documents',
] as const;

/**
 * Where a switched-off page sends the customer.
 *
 * `/quotes` (Proposals) is the one signed-in page no visibility flag can turn
 * off — the API mounts auth but no gate on `/quotes/*`, `/invoices/*` and
 * `/profile/*` (apps/api/src/routes/portal/index.ts), and a portal customer
 * comes to read a proposal or pay a bill. It is also where the middleware
 * already sends a signed-in customer whose org has not turned the dashboard on
 * (lib/landing.ts) and the DEFAULT_LANDING in lib/session.ts.
 *
 * A fixed target is what makes a redirect loop structurally impossible. "Bounce
 * to the landing page" is not: the dashboard IS the landing page when
 * enableDashboard is on, so that rule loops the moment the branding read and the
 * API gate disagree.
 */
export const PORTAL_UNGATED_HOME = '/quotes';

/** The shape of a portalApi response this module reads. */
interface PortalResponseState {
  statusCode?: number;
  code?: string;
}

/** The slice of Astro's global a page hands us to bounce a switched-off page. */
interface RedirectContext {
  redirect: (path: string, status?: 301 | 302 | 303 | 307 | 308) => Response;
}

/**
 * True when any of a page's calls was refused because the MSP switched that page
 * off. Pass only the calls the page's OWN gate covers: /backups also fetches the
 * dashboard for its timezone, and an org with Backups on but Dashboard off must
 * keep its backups page — so that ride-along response stays out of the check.
 *
 * A 403 without one of these codes is a real refusal (portalAuthMiddleware
 * answers "Account is not active" / "Organization is not available" as a bare
 * 403) and must still render inline.
 *
 * Not every code here means the whole PAGE is off, which is why /tickets keeps
 * its own decision in lib/ticketsPage.ts: there, PORTAL_SUPPORT_USAGE_DISABLED
 * hides one panel and PORTAL_TICKETS_DISABLED alone still renders a page worth
 * reading.
 */
export function isPortalPageDisabled(...responses: PortalResponseState[]): boolean {
  return responses.some(
    (response) =>
      response.statusCode === 403 &&
      response.code !== undefined &&
      DISABLED_CODE_SET.has(response.code),
  );
}

/**
 * The one way a gated portal page answers a visibility 403: bounce to
 * PORTAL_UNGATED_HOME rather than render a shell whose every block is an error
 * notice about a load that was never attempted.
 *
 * Every page fed by a gated portalApi method must call this (or name its gate
 * code and render its own "not available" state); disabledPageCoverage.test.ts
 * enforces it the way sessionClearCoverage.test.ts enforces
 * redirectToLoginAfter401.
 */
export function redirectToPortalHomeAfterDisabled(ctx: RedirectContext): Response {
  return ctx.redirect(withBase(PORTAL_UNGATED_HOME), 302);
}
