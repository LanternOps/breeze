// Shared i18next instance for all React islands.
//
// Importing this module initializes i18next and registers it as react-i18next's
// default instance, so islands can use useTranslation() without a provider.
// SSR intentionally renders English; a stored client locale is applied during
// hydration. Cookie-based SSR locale selection is deferred beyond Phase 1.
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../../locales/en/common.json';
import ptBR from '../../locales/pt-BR/common.json';
import {
  readResolvedLocalePreference,
  subscribeLocale,
  writeLocalePreference,
  type LocalePreference,
} from '../appearance';

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources: {
      en: { common: en },
      'pt-BR': { common: ptBR },
    },
    lng: typeof window === 'undefined' ? 'en' : readResolvedLocalePreference(),
    fallbackLng: 'en',
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    // Bundled resources can initialize synchronously for the first render.
    initAsync: false,
    returnNull: false,
  });

  subscribeLocale((locale: LocalePreference) => {
    void i18next.changeLanguage(locale);
  });
}

export const i18n = i18next;

/** Persist the console language; the appearance subscriber switches i18next. */
export function setLocale(locale: LocalePreference): void {
  writeLocalePreference(locale);
}
