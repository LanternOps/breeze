import { afterEach, describe, expect, it } from 'vitest';
import { i18n, loadLocale } from './index';

// #4936: the bulk maintenance toast read "1 devices put into maintenance mode".
// `devicesPage.toasts.bulkMaintenanceSuccess` was a single string with a
// hard-coded plural noun, so i18next had no singular form to select even though
// the call site already passes `count`. The fix is `_one`/`_other` plural keys
// in every locale — the same shape as `alertsPage.alertsBulkActioned`, which
// also interpolates a verb-ish token alongside `count`.
const KEY = 'devices:devicesPage.toasts.bulkMaintenanceSuccess';
const BASE = 'bulkMaintenanceSuccess';

// Every catalog the locale-parity contract requires (localeParity.test.ts).
const LOCALES = [
  'en',
  'de-DE',
  'es-419',
  'fr-CA',
  'fr-FR',
  'it-IT',
  'pt-BR',
  'tr-TR',
] as const;

type Toasts = Record<string, string>;

function toastsFor(locale: string): Toasts {
  const bundle = i18n.getResourceBundle(locale, 'devices') as
    | { devicesPage?: { toasts?: Toasts } }
    | undefined;
  return bundle?.devicesPage?.toasts ?? {};
}

describe('bulk maintenance toast pluralisation (#4936)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it.each(LOCALES)(
    '%s resolves a real singular form instead of falling back to the plural-only base key',
    async (locale) => {
      await loadLocale(locale);
      await i18n.changeLanguage(locale);
      const toasts = toastsFor(locale);

      expect(typeof toasts[`${BASE}_one`], `${locale} _one`).toBe('string');
      expect(typeof toasts[`${BASE}_other`], `${locale} _other`).toBe('string');

      const one = i18n.t(KEY, { count: 1, verb: 'VERB' });
      const other = i18n.t(KEY, { count: 3, verb: 'VERB' });

      // The symptom, restated as an assertion. A missing `_one` does not throw
      // or render a raw key — i18next silently falls back to the base string and
      // interpolates the digit into it, producing "1 devices …". So the singular
      // form must differ from the base string with the same values substituted.
      const baseWithOne = toasts[BASE]!
        .replace('{{count}}', '1')
        .replace('{{verb}}', 'VERB');
      expect(one, `${locale}: count=1 still renders the base key`).not.toBe(baseWithOne);

      expect(one).not.toBe(other);
      expect(one).toContain('1');
      expect(other).toContain('3');
      // `{{verb}}` carries enter-vs-exit, so both forms must still interpolate
      // it (localeParity enforces the same token multiset in every locale).
      expect(one).toContain('VERB');
      expect(other).toContain('VERB');
      expect(one).not.toContain('{{');
      expect(other).not.toContain('{{');
    },
  );

  it('reads "1 device put into maintenance mode" in English, not "1 devices"', async () => {
    await i18n.changeLanguage('en');

    expect(i18n.t(KEY, { count: 1, verb: 'put into' })).toBe(
      '1 device put into maintenance mode',
    );
    expect(i18n.t(KEY, { count: 1, verb: 'taken out of' })).toBe(
      '1 device taken out of maintenance mode',
    );
    expect(i18n.t(KEY, { count: 2, verb: 'put into' })).toBe(
      '2 devices put into maintenance mode',
    );
  });

  it('keeps the plural form for every non-singular count', async () => {
    await i18n.changeLanguage('en');

    // 0 is `_other` in every CLDR rule set these locales use; a `_zero` key was
    // deliberately not added because "0 devices put into maintenance mode" is
    // already correct and the caller never toasts on an empty batch.
    expect(i18n.t(KEY, { count: 0, verb: 'put into' })).toBe(
      '0 devices put into maintenance mode',
    );
    expect(i18n.t(KEY, { count: 250, verb: 'put into' })).toBe(
      '250 devices put into maintenance mode',
    );
  });
});
