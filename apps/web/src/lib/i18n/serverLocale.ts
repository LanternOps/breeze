// Server-side locale negotiation for the SSR shell.
//
// Deliberately pure and dependency-free: the Astro middleware runs on every
// request (including non-HTML ones) and must not pull in the client i18next
// singleton or anything that touches `document`/`localStorage`.
//
// Precedence, highest first:
//   1. the explicit `breeze.locale` cookie (mirror of the user's stored
//      preference — see `writeLocalePreference` in ../appearance.ts),
//   2. the request's `Accept-Language` header (browser-detected only),
//   3. `undefined`, which every caller renders as `en`.
//
// The header is read per request and NEVER written back into the cookie: the
// cookie means "the user chose this", and a heuristic must not be able to
// masquerade as a choice. Hydration then resolves the client preference the
// same way (readLocalePreference -> partner default -> detectBrowserLocale),
// so the first paint and the hydrated tree agree for the common cases.
import { isSupportedLocale, SUPPORTED_LOCALES, type SupportedLocale } from '@breeze/shared';

/** Guards against a pathological header; browsers send a handful of tags. */
const MAX_ACCEPT_LANGUAGE_ENTRIES = 20;

interface AcceptLanguageEntry {
  tag: string;
  quality: number;
}

/**
 * Parses an `Accept-Language` header into its tags ordered by descending
 * quality. Entries with `q=0` ("not acceptable") and the `*` wildcard are
 * dropped. A malformed `q=` parameter (not a valid number) does not drop the
 * entry — it simply fails to override the default, so the tag is kept at
 * quality 1, its highest priority. Ties keep source order, which is what
 * browsers use to express preference among equal-quality tags.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (typeof header !== 'string' || header.trim() === '') return [];

  const entries: AcceptLanguageEntry[] = [];
  for (const part of header.split(',').slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES)) {
    const [rawTag, ...params] = part.split(';');
    const tag = rawTag.trim();
    if (tag === '' || tag === '*') continue;
    // A tag is `alphanum(-alphanum)*`; anything else is malformed input we
    // should not try to interpret.
    if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(tag)) continue;

    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i.exec(param);
      if (match) quality = Number.parseFloat(match[1]);
    }
    if (!Number.isFinite(quality) || quality <= 0) continue;

    entries.push({ tag, quality });
  }

  // `Array.prototype.sort` is stable, so equal-quality tags keep header order.
  return entries.sort((a, b) => b.quality - a.quality).map((entry) => entry.tag);
}

/**
 * Resolves the first `Accept-Language` tag that maps onto a supported locale.
 *
 * Matching mirrors `detectBrowserLocale` in ../appearance.ts exactly — per tag,
 * an exact case-insensitive match first, then a base-language match
 * (`pt-PT` -> `pt-BR`, `es-MX` -> `es-419`, `fr-BE` -> `fr-FR`) — so the
 * server-rendered shell and the hydrated client agree instead of flipping
 * language on hydration.
 */
export function resolveLocaleFromAcceptLanguage(
  header: string | null | undefined,
): SupportedLocale | undefined {
  for (const tag of parseAcceptLanguage(header)) {
    const exact = SUPPORTED_LOCALES.find(
      (option) => option.toLowerCase() === tag.toLowerCase(),
    );
    if (exact) return exact;

    const base = SUPPORTED_LOCALES.find(
      (option) => option.split('-')[0].toLowerCase() === tag.split('-')[0].toLowerCase(),
    );
    if (base) return base;
  }
  return undefined;
}

/** Validates the raw `breeze.locale` cookie value. */
export function resolveLocaleFromCookie(value: string | undefined): SupportedLocale | undefined {
  return isSupportedLocale(value) ? value : undefined;
}

/**
 * The single entry point the middleware uses: explicit choice wins, browser
 * detection is the fallback, and `undefined` means "render the default".
 */
export function resolveServerLocale(input: {
  cookieValue?: string;
  acceptLanguage?: string | null;
}): SupportedLocale | undefined {
  return (
    resolveLocaleFromCookie(input.cookieValue)
    ?? resolveLocaleFromAcceptLanguage(input.acceptLanguage)
  );
}
