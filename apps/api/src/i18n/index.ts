/**
 * API-side i18n runtime (plain i18next, no React).
 *
 * Supports all locales listed in `SUPPORTED_LOCALES` (@breeze/shared).  Each
 * namespace is eagerly bundled from the co-located JSON files — the API builds
 * with tsup which handles JSON imports natively.
 *
 * Usage:
 *   import { tApi } from '../i18n';
 *   const subject = tApi('pt-BR', 'emails:invoice.subject', { invoiceNumber: '#42', partnerName: 'Acme' });
 *
 * Key design constraints:
 * - `changeLanguage` is **never** called after init — per-call translation uses
 *   `i18next.getFixedT(locale)`, which is concurrency-safe (workers rendering
 *   different locales in parallel cannot race).
 * - Fallback language is always `'en'` — a missing key in any other locale
 *   returns the English string rather than the key itself.
 */
import i18next from 'i18next';
import type { SupportedLocale } from '@breeze/shared';

// Locale files — eager static imports (tsup resolves JSON at build time).
import enEmails from './locales/en/emails.json';
import enPdf from './locales/en/pdf.json';
import enNotifications from './locales/en/notifications.json';
import ptBrEmails from './locales/pt-BR/emails.json';
import ptBrPdf from './locales/pt-BR/pdf.json';
import ptBrNotifications from './locales/pt-BR/notifications.json';

// Remaining SUPPORTED_LOCALES share the English bundle as fallback; add locale
// files here as translations become available.  The resource map below stays
// as the single source of what has been translated — do not add a locale here
// without also adding all three namespace files.
const resources = {
  en: {
    emails: enEmails,
    pdf: enPdf,
    notifications: enNotifications,
  },
  'pt-BR': {
    emails: ptBrEmails,
    pdf: ptBrPdf,
    notifications: ptBrNotifications,
  },
} as const;

// Initialise synchronously — resources are bundled, so no async loader needed.
i18next.init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'emails',
  ns: ['emails', 'pdf', 'notifications'],
  interpolation: {
    // Strings in this runtime are never rendered as HTML; escaping would
    // corrupt plain-text subjects and pdfkit text output.
    escapeValue: false,
  },
  // i18next prints warnings for missing keys by default; keep them visible so
  // locale gaps surface in server logs rather than silently returning key paths.
  missingKeyHandler: false,
});

/**
 * Translate `key` into `locale`, with optional interpolation variables.
 *
 * Namespace prefix is required in the key: `'emails:invoice.subject'`,
 * `'pdf:invoice.title'`, `'notifications:severity.critical'`.
 *
 * Falls back to English when the requested locale lacks the key.
 */
export function tApi(
  locale: SupportedLocale,
  key: string,
  vars?: Record<string, unknown>,
): string {
  return i18next.getFixedT(locale)(key, vars ?? {}) as string;
}

export { i18next };
