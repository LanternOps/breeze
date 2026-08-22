import { isSupportedLocale, type SupportedLocale } from '@breeze/shared';

/** Partner language → document render locale. Single source for the stamp at
 *  issue/send AND the render-time fallback for unstamped (draft/legacy) rows. */
export function resolvePartnerDocumentLocale(partner: { settings?: unknown } | null | undefined): SupportedLocale {
  const language = (partner?.settings as { language?: unknown } | null | undefined)?.language;
  return isSupportedLocale(language) ? language : 'en';
}
