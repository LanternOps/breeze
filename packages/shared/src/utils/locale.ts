import type { SupportedLocale } from '../types';

/** Runtime twin of the SupportedLocale union (types/index.ts) — the single
 *  source for validators and the document-locale default (#3777). */
export const SUPPORTED_LOCALES = ['en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'tr-TR'] as const satisfies readonly SupportedLocale[];

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
