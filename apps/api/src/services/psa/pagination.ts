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

import type { PSACompany, PSACompanyList } from './types';

/** Items per upstream request. 100 is the max (or default max) on every adapter. */
export const PSA_COMPANY_PAGE_SIZE = 100;

/**
 * Belt-and-braces bound on loop iterations.
 *
 * Sized so a provider that clamps our 100-row request down to ~30 can still
 * reach the 1000-item cap (1000/30 ≈ 34 pages) rather than silently stopping a
 * third of the way in. `PSA_PAGE_WALK_BUDGET_MS` is the real bound on how long
 * a walk can run; this one only stops a pathological empty-page cursor loop.
 */
export const MAX_PSA_PAGES = 40;

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

/**
 * A cursor URL from a PSA response body did not belong to the connection's host.
 *
 * Carries the provider so the message can name it: the same refusal reaches
 * users from both Autotask and Zendesk, and a message that guesses the wrong
 * vendor sends them looking in the wrong place.
 */
export class PsaCursorOriginError extends Error {
  readonly provider: string;
  readonly cursorOrigin: string;
  readonly expectedOrigin: string;

  constructor(provider: string, cursorOrigin: string, expectedOrigin: string) {
    super(
      `${provider} pagination cursor rejected: the response pointed at ${cursorOrigin}, ` +
      `but this connection is pinned to ${expectedOrigin}. Refused before sending credentials.`
    );
    this.name = 'PsaCursorOriginError';
    this.provider = provider;
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
export function pinCursorToBase(cursorUrl: string, baseUrl: string, provider = 'PSA'): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new PsaCursorOriginError(provider, '<unparseable cursor>', String(baseUrl));
  }

  let cursor: URL;
  try {
    // Resolved against the base so a relative cursor is legal and lands on-origin.
    cursor = new URL(cursorUrl, base);
  } catch {
    throw new PsaCursorOriginError(provider, '<unparseable cursor>', base.origin);
  }

  if (cursor.origin !== base.origin) {
    throw new PsaCursorOriginError(provider, cursor.origin, base.origin);
  }

  // Rebuild on the STORED origin rather than handing back the PSA's string, so
  // the value that reaches psaFetch cannot carry userinfo, an alternate default
  // port, or any other origin-adjacent trickery from the response body.
  return `${base.origin}${cursor.pathname}${cursor.search}`;
}

/**
 * A company as it comes off untyped PSA JSON, before validation.
 *
 * Adapters normalise their vendor-specific field names (`companyName`,
 * `sys_id`, …) into this shape and hand it to `toCompanyList`, which is the one
 * place that decides what counts as usable.
 */
export interface RawCompanyRecord {
  id?: unknown;
  name?: unknown;
}

/** `123` / `"abc"` → a non-empty string id; anything else → null. */
function coerceCompanyId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * Validate a walked page of raw records into the public company list.
 *
 * ONE malformed record must not fail the whole import. The adapter types are
 * aspirational — every field comes off untyped JSON, and a single company with
 * a null `name` used to throw inside the walk and 502 an entire preview, which
 * an MSP has no way to fix from their side. Unusable records are skipped and
 * COUNTED, so the number surfaces in the preview response the same way
 * `truncated` does rather than vanishing.
 */
export function toCompanyList(result: PsaCollectResult<RawCompanyRecord>): PSACompanyList {
  const companies: PSACompany[] = [];
  let malformed = 0;

  for (const raw of result.items) {
    const id = coerceCompanyId(raw?.id);
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (!id || name.length === 0) {
      malformed++;
      continue;
    }
    companies.push({ id, name, externalId: id });
  }

  return {
    companies,
    truncated: result.truncated,
    ...(result.truncationReason ? { truncationReason: result.truncationReason } : {}),
    alreadyLinked: result.filtered,
    malformed
  };
}

export interface PsaPage<T> {
  /** Records KEPT from this page (post-filter). Only these count toward the cap. */
  items: T[];
  /**
   * Records the PSA actually returned on this page, BEFORE filtering.
   *
   * Termination keys on this, not on `items.length`: when every company on a
   * page is skipped as already-linked, the page is full upstream but empty to
   * us, and stopping there would hide every company behind it — the exact bug
   * that made a PSA larger than the cap unimportable.
   */
  rawCount: number;
  /**
   * Opaque token for the next request, or null when the walk is finished.
   * Cursor providers pass the (already origin-pinned) next URL; page/offset
   * providers pass their own next page number or offset.
   */
  next: string | null;
}

/**
 * Build a page result, dropping companies already linked to this provider.
 *
 * Records with an unusable id are deliberately KEPT so `toCompanyList` can
 * count them as malformed rather than silently conflating "broken record" with
 * "already imported".
 */
export function companyPage(
  raw: RawCompanyRecord[],
  next: string | null,
  skipExternalIds?: ReadonlySet<string>
): PsaPage<RawCompanyRecord> {
  const items = skipExternalIds
    ? raw.filter((record) => {
        const id = coerceCompanyId(record?.id);
        return id === null || !skipExternalIds.has(id);
      })
    : raw;

  return { items, rawCount: raw.length, next };
}

/**
 * WHY the walk stopped short. The UI wording differs sharply between these —
 * "we only took the first 1000 of your companies" is wrong and alarming when
 * the real cause was a slow PSA clipping us at 240.
 */
export type PsaTruncationReason = 'cap' | 'time-budget' | 'page-guard';

export interface PsaCollectResult<T> {
  items: T[];
  /** True when the cap, the time budget, or the page guard stopped the walk. */
  truncated: boolean;
  /** Set iff `truncated`. */
  truncationReason?: PsaTruncationReason;
  /** Records dropped by the page filter (already linked to this provider). */
  filtered: number;
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
  let filtered = 0;

  for (let page = 0; page < MAX_PSA_PAGES; page++) {
    const { items: pageItems, rawCount, next } = await fetchPage(cursor);
    items.push(...pageItems);
    filtered += Math.max(0, rawCount - pageItems.length);

    // STRICTLY greater, not >=. The page/offset providers cannot report "there
    // is another page"; they infer it, so a partner holding EXACTLY `limit`
    // companies would otherwise be reported as truncated on a complete import —
    // a false alarm telling the tech that companies were dropped when none
    // were. Reading one page past the cap disambiguates: either it yields more
    // (genuinely truncated) or it comes back empty.
    if (items.length > limit) {
      return { items: items.slice(0, limit), truncated: true, truncationReason: 'cap', filtered };
    }

    // ONLY an empty page ends the walk. A SHORT page must not: providers
    // silently clamp `per_page` below what we ask for (Freshservice caps at
    // 100, some plans lower), and treating "fewer rows than requested" as
    // end-of-list stopped after one page and reported `truncated: false` — the
    // tech saw 30 companies with no warning and believed the PSA was fully
    // onboarded. Costs one extra request per walk; correctness is worth it.
    if (!next || rawCount === 0) {
      return { items, truncated: false, filtered };
    }

    if (Date.now() - startedAt >= budgetMs) {
      return { items: items.slice(0, limit), truncated: true, truncationReason: 'time-budget', filtered };
    }

    cursor = next;
  }

  return { items: items.slice(0, limit), truncated: true, truncationReason: 'page-guard', filtered };
}
