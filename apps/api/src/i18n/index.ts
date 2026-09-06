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
import { captureMessage } from '../services/sentry';

// Locale files — eager static imports (tsup resolves JSON at build time).
import enEmails from './locales/en/emails.json';
import enPdf from './locales/en/pdf.json';
import enNotifications from './locales/en/notifications.json';
import ptBrEmails from './locales/pt-BR/emails.json';
import ptBrPdf from './locales/pt-BR/pdf.json';
import ptBrNotifications from './locales/pt-BR/notifications.json';

// Only `en` and `pt-BR` have bundles. The other six SUPPORTED_LOCALES
// ('es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'tr-TR') resolve as valid
// recipient locales but render the English bundle via `fallbackLng` — by
// design, so a recipient's preference is preserved end-to-end and takes effect
// the moment a bundle lands. `TRANSLATED_LOCALES` is the single source of what
// has actually been translated; do not add a locale here without all three
// namespace files (localeParity.test.ts enforces the file set).
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

/** Locales with a real bundle. Everything else in SUPPORTED_LOCALES renders English. */
export const TRANSLATED_LOCALES = Object.keys(resources) as ReadonlyArray<keyof typeof resources>;

// Dedupe per process so a hot send path cannot flood Sentry with one event per
// email; the local console line still fires every time in non-production.
const reportedMissingKeys = new Set<string>();

// Initialise synchronously — resources are bundled, so no async loader needed.
i18next.init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'emails',
  ns: ['emails', 'pdf', 'notifications'],
  initAsync: false,
  returnNull: false,
  saveMissing: true,
  // A typo'd key would otherwise ship the raw `ns:key` string as an email
  // subject with no signal anywhere — the parity suite checks en↔translations,
  // not code↔en. Telemetry must never break a translation lookup.
  missingKeyHandler: (lngs, ns, key) => {
    try {
      const dedupeKey = `${ns}:${key}`;
      if (reportedMissingKeys.has(dedupeKey)) return;
      reportedMissingKeys.add(dedupeKey);
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[i18n] missing key: ${dedupeKey} (${lngs.join(',')})`);
      }
      captureMessage('i18n missing key', {
        eventCode: 'i18n_missing_key',
        tags: { i18n_key: dedupeKey },
      });
    } catch {
      // never let telemetry break translation
    }
  },
  // An absent variable renders an empty slot silently ("Invoice  from Acme").
  missingInterpolationHandler: (text, value) => {
    try {
      const token = Array.isArray(value) ? String(value[1] ?? value[0]) : String(value);
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[i18n] missing interpolation value ${token} in "${text}"`);
      }
      captureMessage('i18n missing interpolation value', {
        eventCode: 'i18n_missing_interpolation',
      });
    } catch {
      // never let telemetry break translation
    }
    return '';
  },
  interpolation: {
    // Strings in this runtime are rendered as plain text (subjects, pdfkit
    // text, push bodies); escaping would corrupt them. This becomes UNSAFE the
    // moment a `tApi` result is inlined into an HTML email template with a
    // user-controlled variable — escape at that boundary (or pass
    // `interpolation.escapeValue: true` per call), do not flip this default.
    escapeValue: false,
  },
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
