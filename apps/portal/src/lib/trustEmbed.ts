// Trust Center W03a (#8771): the framable embed card at /trust/embed/<partner>[/<org>]. SSR reads the same small
// card endpoint the full page uses (DB-free on a miss, exempt from the IP limiter); the card carries the page's LIVE
// iframe allowlist as `frameAncestors`, which the page hands to the middleware via Astro.locals.trustEmbedOrigins.
import { normalizeEmbedOrigin } from '@breeze/shared';
import { apiGet, type ApiRequestConfig, type TrustCard } from './api';
import { publicServerApiConfig } from './server';
import { withBase } from './basePath';
import { publicOriginFor } from './publicOrigin';
import { pickTrustCopy } from '../components/trust/trustCopy';
import { pageCopy } from '../components/trust/copy/pageCopy';
import { cardMeta } from '../components/trust/trustPageFormat';

export interface TrustEmbedCard extends TrustCard {
  /** Exact https origins allowed to frame this card; [] = embedding disabled (the page answers 404). */
  frameAncestors: string[];
}

/**
 * The card, or null for anything but a loaded 200 (404, 503, network error, timeout). Never throws. A failure other
 * than a 404 is logged: the embed answers 404 either way (fail closed), so the log is the only trace of an outage.
 */
export async function getTrustEmbedCard(partnerSlug: string, orgSlug: string | null, config: ApiRequestConfig = {}): Promise<TrustEmbedCard | null> {
  const path = `/trust/card/${encodeURIComponent(partnerSlug)}${orgSlug ? `/${encodeURIComponent(orgSlug)}` : ''}`;
  const res = await apiGet<{ data: TrustCard & { frameAncestors?: unknown } }>(path, { redirectOnUnauthorized: false, ...config });
  if (res.statusCode !== 200 || !res.data?.data) {
    if (res.statusCode !== 404) {
      console.warn('[trust-embed] card fetch failed; answering 404', { path, status: res.statusCode ?? null, error: res.error ?? null });
    }
    return null;
  }
  const card = res.data.data;
  // Defence in depth: only values that are their own normalization survive (the CSP helper would refuse the rest).
  const raw = Array.isArray(card.frameAncestors) ? card.frameAncestors : [];
  const frameAncestors = raw.filter((o): o is string => typeof o === 'string' && normalizeEmbedOrigin(o) === o);
  if (frameAncestors.length !== raw.length) {
    console.warn('[trust-embed] dropped allowlist entries that are not normalized https origins', { path, dropped: raw.length - frameAncestors.length });
  }
  return { ...card, frameAncestors };
}

/**
 * The embed card's locale-resolved strings (#9257): `lang`, <title> and copy follow the page's frozen locale
 * (card.locale) from the same pageCopy the full page uses; an unknown locale gets English.
 */
export function embedCardView(card: TrustEmbedCard) {
  const meta = cardMeta(card);
  const t = pickTrustCopy(pageCopy, card.locale);
  return {
    lang: meta.lang,
    title: meta.title,
    badge: t.embedBadge,
    summary: t.embedSummary(card.controlsShown, card.catalogTotal, card.controlsMet),
    lastVerified: t.embedLastVerified,
    paused: t.embedPaused,
    viewFull: t.embedViewFull,
  };
}

/** Base-relative path of the full trust page an embed links to. */
export function trustEmbedFullPagePath(partnerSlug: string, orgSlug: string | null): string {
  return orgSlug === null ? `/trust/${partnerSlug}` : `/trust/${partnerSlug}/${orgSlug}`;
}

/**
 * Everything an embed page's frontmatter does, in one testable place: fetch the card (3 s bound, as W1), and for a
 * loaded card with a non-empty allowlist hand the origins to the middleware through `locals.trustEmbedOrigins`.
 * null → the page answers 404 (frame-ancestors 'none', DENY, no-store).
 */
export async function loadTrustEmbedPage(
  ctx: { request: Request; url: URL; locals: { trustEmbedOrigins?: string[] } },
  partnerSlug: string,
  orgSlug: string | null,
): Promise<{ card: TrustEmbedCard; fullPageUrl: string } | null> {
  const card = await getTrustEmbedCard(partnerSlug, orgSlug, { ...publicServerApiConfig(ctx.request), timeoutMs: 3000 });
  if (!card || card.frameAncestors.length === 0) return null;
  ctx.locals.trustEmbedOrigins = card.frameAncestors;
  const fullPageUrl = new URL(withBase(trustEmbedFullPagePath(partnerSlug, orgSlug)), publicOriginFor(ctx.request, ctx.url)).toString();
  return { card, fullPageUrl };
}
