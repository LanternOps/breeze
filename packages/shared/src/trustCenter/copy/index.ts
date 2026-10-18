// Per-locale control, category, crosswalk-label and status copy for the public trust page and the editor
// (spec §19 item 31). Typed modules, no i18n runtime: `Record<SupportedLocale, TrustCatalogCopy>` makes the
// compiler refuse a locale that lacks a key, and copy.test.ts refuses untranslated values.
import { SUPPORTED_LOCALES } from '../../utils/locale';
import type { SupportedLocale } from '../../types';
import { en } from './en';
import { ptBR } from './pt-BR';
import { es419 } from './es-419';
import { frFR } from './fr-FR';
import { frCA } from './fr-CA';
import { deDE } from './de-DE';
import { itIT } from './it-IT';
import { trTR } from './tr-TR';
import type { TrustCatalogCopy } from './types';

export type { TrustCatalogCopy } from './types';

export const TRUST_CATALOG_COPY: Record<SupportedLocale, TrustCatalogCopy> = {
  en, 'pt-BR': ptBR, 'es-419': es419, 'fr-FR': frFR, 'fr-CA': frCA, 'de-DE': deDE, 'it-IT': itIT, 'tr-TR': trTR,
};

/** The catalog copy for `locale`; an unknown, null or undefined locale gets English. */
export function trustCopyFor(locale: string | null | undefined): TrustCatalogCopy {
  return typeof locale === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(locale)
    ? TRUST_CATALOG_COPY[locale as SupportedLocale]
    : TRUST_CATALOG_COPY.en;
}
