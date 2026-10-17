// Trust Center W03a (#8771): the framable embed card at /trust/embed/<partner>[/<org>]. SSR reads the same small
// card endpoint the full page uses (DB-free on a miss, exempt from the IP limiter); the card carries the page's LIVE
// iframe allowlist as `frameAncestors`, which the page hands to the middleware via Astro.locals.trustEmbedOrigins.
import { normalizeEmbedOrigin } from '@breeze/shared';
import { apiGet, type ApiRequestConfig, type TrustCard } from './api';

export interface TrustEmbedCard extends TrustCard {
  /** Exact https origins allowed to frame this card; [] = embedding disabled (the page answers 404). */
  frameAncestors: string[];
}

/** The card, or null for anything but a loaded 200 (404, 503, network error, timeout). Never throws. */
export async function getTrustEmbedCard(partnerSlug: string, orgSlug: string | null, config: ApiRequestConfig = {}): Promise<TrustEmbedCard | null> {
  const path = `/trust/card/${encodeURIComponent(partnerSlug)}${orgSlug ? `/${encodeURIComponent(orgSlug)}` : ''}`;
  const res = await apiGet<{ data: TrustCard & { frameAncestors?: unknown } }>(path, { redirectOnUnauthorized: false, ...config });
  if (res.statusCode !== 200 || !res.data?.data) return null;
  const card = res.data.data;
  // Defence in depth: only values that are their own normalization survive (the CSP helper would refuse the rest).
  const frameAncestors = Array.isArray(card.frameAncestors)
    ? card.frameAncestors.filter((o): o is string => typeof o === 'string' && normalizeEmbedOrigin(o) === o)
    : [];
  return { ...card, frameAncestors };
}

/** Base-relative path of the full trust page an embed links to. */
export function trustEmbedFullPagePath(partnerSlug: string, orgSlug: string | null): string {
  return orgSlug === null ? `/trust/${partnerSlug}` : `/trust/${partnerSlug}/${orgSlug}`;
}
