import { describe, expect, it } from 'vitest';
import { i18n, loadLocale } from './index';

// #9646: "1 profiles configured" / "1 baselines configured" — single strings
// with a hard-coded plural noun. Both need `_one`/`_other` in every locale.
const KEYS = [
  'discovery:discoveryProfileList.configuredCount',
  'discovery:networkBaselinesPanel.configuredCount',
] as const;

const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'] as const;

describe('discovery configuredCount plurals', () => {
  it.each(KEYS)('%s has _one and _other forms in every locale', async (key) => {
    for (const locale of LOCALES) {
      await loadLocale(locale);
      const bundle = i18n.getResourceBundle(locale, 'discovery') as Record<string, Record<string, string>>;
      const [, path] = key.split(':');
      const [group, leaf] = path.split('.');
      expect(bundle[group][`${leaf}_one`], `${locale} _one`).toContain('{{count}}');
      expect(bundle[group][`${leaf}_other`], `${locale} _other`).toContain('{{count}}');
    }
  });

  it('English singular reads naturally', async () => {
    await loadLocale('en');
    const t = i18n.getFixedT('en');
    expect(t(KEYS[0], { count: 1 })).toBe('1 profile configured');
    expect(t(KEYS[1], { count: 1 })).toBe('1 baseline configured');
    expect(t(KEYS[0], { count: 3 })).toBe('3 profiles configured');
  });
});
