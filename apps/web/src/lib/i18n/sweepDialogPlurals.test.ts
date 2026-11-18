import { describe, expect, it } from 'vitest';
import { i18n, loadLocale } from './index';

// #10080: "1 devices in 1 organizations", "Sweep 1 devices". Every locale must
// resolve the sweep dialog counts through its own _one/_other forms.
const PLURAL_KEYS = [
  'sweeps.dialog.counts.devices',
  'sweeps.dialog.counts.orgs',
  'sweeps.dialog.confirm',
  'sweeps.skipReasons.agent_too_old',
  'sweeps.skipReasons.busy_same_sweep',
  'sweeps.skipReasons.rule_set_not_eligible',
] as const;

const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'] as const;
// Turkish keeps the noun singular after a numeral, so its two forms are equal.
const SAME_FORM_LOCALES = new Set(['tr-TR']);

describe('IOC sweep dialog plurals', () => {
  it.each(LOCALES)('%s resolves a singular and a plural form for every count key', async (locale) => {
    await loadLocale(locale);
    const t = i18n.getFixedT(locale, 'security');
    for (const key of PLURAL_KEYS) {
      const one = t(key, { count: 1 });
      const two = t(key, { count: 2 });
      expect(one, `${locale} ${key} one`).toContain('1');
      expect(two, `${locale} ${key} other`).toContain('2');
      expect(one, `${locale} ${key} resolved`).not.toContain(key);
      if (!SAME_FORM_LOCALES.has(locale)) {
        expect(one.replace('1', '#'), `${locale} ${key} distinct forms`).not.toBe(two.replace('2', '#'));
      }
    }
  }, 60_000);

  it.each(LOCALES)('%s composes the preview and confirm sentences from the count fragments', async (locale) => {
    await loadLocale(locale);
    const t = i18n.getFixedT(locale, 'security');
    const devices = t('sweeps.dialog.counts.devices', { count: 1 });
    const orgs = t('sweeps.dialog.counts.orgs', { count: 1 });
    const targeted = t('sweeps.dialog.preview.targeted', { devices, orgs });
    const summary = t('sweeps.dialog.confirmSummary', { count: 1, devices, orgs });
    for (const text of [targeted, summary]) {
      expect(text).toContain(devices);
      expect(text).toContain(orgs);
      expect(text).not.toMatch(/{{|sweeps\./);
    }
  }, 60_000);

  it('English reads naturally in the singular', async () => {
    await loadLocale('en');
    const t = i18n.getFixedT('en', 'security');
    expect(t('sweeps.dialog.confirm', { count: 1 })).toBe('Sweep 1 device');
    expect(t('sweeps.skipReasons.agent_too_old', { count: 1 })).toBe('1 device with an agent that is too old');
  });
});
