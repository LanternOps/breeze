// Portal Trust Center copy mechanism (spec §19 item 31; W02a seam). The public page has no i18next runtime:
// each section owns a typed per-locale copy module built with `defineTrustCopy`, and reads the page's frozen
// locale from `TrustLocaleContext`. Control/category/crosswalk copy lives in @breeze/shared trustCenter/copy
// (W02h). This file holds only the mechanism and the shared section props.
import { createContext, useContext } from 'react';
import { SUPPORTED_LOCALES, type SupportedLocale, type TrustPagePublicPayload } from '@breeze/shared';

/** Props every W2 public-page section receives from TrustPageView. */
export interface TrustSectionViewProps {
  payload: TrustPagePublicPayload;
  lastEvaluatedAt: string | null;
  preview: boolean;
  partnerSlug: string | null;
  orgSlug: string | null;
}

type CopyValue = string | ((...a: never[]) => string);

/** Identity at runtime; the type forces every locale to carry the same keys as each other. */
export function defineTrustCopy<T extends Record<string, CopyValue>>(copy: Record<SupportedLocale, T>): Record<SupportedLocale, T> {
  return copy;
}

const isSupported = (l: string | null | undefined): l is SupportedLocale =>
  typeof l === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(l);

/** The copy for `locale`; an unknown or missing locale gets English. */
export function pickTrustCopy<T>(copy: Record<SupportedLocale, T>, locale: string | null | undefined): T {
  return isSupported(locale) ? copy[locale] : copy.en;
}

/**
 * Test helper for every copy module: each locale must exist, carry exactly the English key set, and never hold
 * an empty string. Returns human-readable problems (empty = OK).
 */
export function copyParityProblems(copy: Record<string, Record<string, unknown>>): string[] {
  const problems: string[] = [];
  const en = copy.en;
  if (!en) return ['missing locale en'];
  const enKeys = Object.keys(en).sort();
  for (const locale of SUPPORTED_LOCALES) {
    const entry = copy[locale];
    if (!entry) { problems.push(`missing locale ${locale}`); continue; }
    const keys = Object.keys(entry).sort();
    for (const k of enKeys) if (!keys.includes(k)) problems.push(`${locale}: missing key ${k}`);
    for (const k of keys) if (!enKeys.includes(k)) problems.push(`${locale}: extra key ${k}`);
    for (const [k, v] of Object.entries(entry)) if (v === '') problems.push(`${locale}: empty string at ${k}`);
  }
  return problems;
}

/** The page's render locale, frozen at publish (payload.locale). TrustPageView provides it. */
export const TrustLocaleContext = createContext<SupportedLocale>('en');
export function useTrustLocale(): SupportedLocale {
  return useContext(TrustLocaleContext);
}

/** A calendar date in the page's locale (never a hard-coded 'en-US'). An unparseable value renders as ''. */
export function formatTrustDate(iso: string, locale: SupportedLocale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}
