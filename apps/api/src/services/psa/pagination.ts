/**
 * PSA pagination primitives.
 *
 * Two separate jobs live here:
 *
 * 1. `collectPaginated` — a provider-agnostic page walk with a hard item cap, so
 *    `getCompanies()` returns every company an MSP actually has instead of the
 *    first page. Every adapter drives its own native mechanism (page number,
 *    offset, or an opaque cursor) through the same loop and gets identical
 *    cap/`truncated` semantics.
 *
 * 2. `pinCursorToBase` — the SSRF guard for the cursor-style providers.
 *    Autotask's `pageDetails.nextPageUrl` and Zendesk's `next_page` are ABSOLUTE
 *    URLs that come out of the PSA's own response body, i.e. they are
 *    attacker-influenced whenever the PSA is compromised, malicious, or merely
 *    misconfigured. Every adapter's `request()` attaches the connection's
 *    credentials, and `psaFetch` re-validates SSRF-safety per URL but enforces
 *    NOTHING about WHICH host — so blindly following a body-supplied URL forwards
 *    PSA credentials to an arbitrary host. On self-hosted deployments
 *    `psaAllowsPrivateNetwork()` additionally permits RFC1918 targets, which
 *    turns it into a genuine credentialed SSRF against the customer's LAN.
 *
 *    Fix: a cursor is only ever followed when its origin equals the origin of the
 *    connection's STORED baseUrl, and the URL we actually dial is rebuilt from
 *    that stored origin. Mismatch is a hard refusal (`PsaCursorOriginError`) —
 *    never a silent skip, because a silently-dropped page is indistinguishable
 *    from "no more companies" and would truncate the import instead.
 */

/** Items per upstream request. 100 is the max (or default max) on every adapter. */
export const PSA_COMPANY_PAGE_SIZE = 100;

/**
 * Belt-and-braces bound on loop iterations. The item cap normally stops the walk
 * long before this (1000 items / 100 per page = 11 requests); this only fires if
 * a PSA hands back tiny-or-empty pages with a forever-advancing cursor.
 */
export const MAX_PSA_PAGES = 15;

/**
 * Wall-clock budget for one whole page walk.
 *
 * `DEFAULT_PSA_TIMEOUT_MS` in http.ts is PER REQUEST, so the page count alone
 * would permit MAX_PSA_PAGES × 20s of server-side work for a single preview
 * against a slow, tenant-controlled host — long past any proxy timeout, with the
 * client gone and the worker still dialing. Checked between pages, so the true
 * worst case is this budget plus one request timeout.
 *
 * Exceeding it ends the walk as `truncated`, which is honest: some companies
 * were not read. It is never an error — a partner with a slow PSA should still
 * get the companies we did manage to fetch.
 */
export const PSA_PAGE_WALK_BUDGET_MS = 60_000;

/** A cursor URL from a PSA response body did not belong to the connection's host. */
export class PsaCursorOriginError extends Error {
  readonly cursorOrigin: string;
  readonly expectedOrigin: string;

  constructor(cursorOrigin: string, expectedOrigin: string) {
    super(
      `PSA pagination cursor rejected: response pointed at ${cursorOrigin}, ` +
      `but this connection is pinned to ${expectedOrigin}`
    );
    this.name = 'PsaCursorOriginError';
    this.cursorOrigin = cursorOrigin;
    this.expectedOrigin = expectedOrigin;
  }
}

/**
 * Validate a body-supplied pagination cursor against the connection's stored
 * baseUrl and return an absolute URL rebuilt on that stored ORIGIN.
 *
 * Origin (scheme + host + port) is the pinned unit, not the full base path: a
 * PSA legitimately returns cursors rooted at `/`, above whatever sub-path the
 * stored baseUrl carries (`…/atservicesrest`), so pinning the path would break
 * real pagination. The PSA-chosen path and query are preserved verbatim; only
 * the host it is dialed against is ours.
 *
 * Throws `PsaCursorOriginError` for an unparseable cursor or any origin
 * mismatch — including a redirect to cloud metadata (169.254.169.254) or an
 * attacker-controlled public host. Credentials are therefore never attached to
 * a request the PSA steered off-origin.
 */
export function pinCursorToBase(cursorUrl: string, baseUrl: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new PsaCursorOriginError('<unparseable cursor>', String(baseUrl));
  }

  let cursor: URL;
  try {
    // Resolved against the base so a relative cursor is legal and lands on-origin.
    cursor = new URL(cursorUrl, base);
  } catch {
    throw new PsaCursorOriginError('<unparseable cursor>', base.origin);
  }

  if (cursor.origin !== base.origin) {
    throw new PsaCursorOriginError(cursor.origin, base.origin);
  }

  // Rebuild on the STORED origin rather than handing back the PSA's string, so
  // the value that reaches psaFetch cannot carry userinfo, an alternate default
  // port, or any other origin-adjacent trickery from the response body.
  return `${base.origin}${cursor.pathname}${cursor.search}`;
}

export interface PsaPage<T> {
  items: T[];
  /**
   * Opaque token for the next request, or null when the walk is finished.
   * Cursor providers pass the (already origin-pinned) next URL; page/offset
   * providers pass their own next page number or offset.
   */
  next: string | null;
}

export interface PsaCollectResult<T> {
  items: T[];
  /** True when `limit` (or the page guard) stopped the walk with more upstream. */
  truncated: boolean;
}

/**
 * Walk a provider's pages until `limit` items are collected or the pages run out.
 *
 * `truncated` is the load-bearing output: silently importing the first 1000 of an
 * MSP's 1500 companies is exactly the duplicate-tenant trap the external link
 * table exists to prevent, so the caller must be able to tell a complete list
 * from a clipped one.
 */
export async function collectPaginated<T>(
  limit: number,
  fetchPage: (cursor: string | null) => Promise<PsaPage<T>>,
  budgetMs: number = PSA_PAGE_WALK_BUDGET_MS
): Promise<PsaCollectResult<T>> {
  const items: T[] = [];
  const startedAt = Date.now();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PSA_PAGES; page++) {
    const { items: pageItems, next } = await fetchPage(cursor);
    items.push(...pageItems);

    // STRICTLY greater, not >=. The page/offset providers cannot report "there
    // is another page"; they infer it from a full page, so a partner holding
    // EXACTLY `limit` companies would otherwise be reported as truncated on a
    // complete import — a false alarm telling the tech that companies were
    // dropped when none were. Reading one page past the cap disambiguates:
    // either it yields more (genuinely truncated) or it comes back empty.
    if (items.length > limit) {
      return { items: items.slice(0, limit), truncated: true };
    }

    // An empty page terminates the walk even if the provider keeps offering a
    // cursor — otherwise a broken PSA spins until MAX_PSA_PAGES.
    if (!next || pageItems.length === 0) {
      return { items, truncated: false };
    }

    if (Date.now() - startedAt >= budgetMs) {
      return { items: items.slice(0, limit), truncated: true };
    }

    cursor = next;
  }

  return { items: items.slice(0, limit), truncated: true };
}
