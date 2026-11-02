import { describe, expect, it } from 'vitest';
import { i18n, loadLocale } from './index';

// #10078: the IOC sweep progress label counts each terminal child state
// separately ("2 of 2 devices finished · 1 completed · 1 cancelled"), so every
// count needs `_one`/`_other` in every locale.
const LEAVES = ['finished', 'completed', 'timedOut', 'failed', 'cancelled', 'expired'] as const;
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'] as const;

describe('sweeps.progress plurals', () => {
  it.each(LOCALES)('%s has _one and _other forms for every progress count', async (locale) => {
    await loadLocale(locale);
    const bundle = i18n.getResourceBundle(locale, 'security') as {
      sweeps: { progress: Record<string, string>; panel: Record<string, unknown> };
    };
    const progress = bundle.sweeps.progress;
    for (const leaf of LEAVES) {
      expect(progress[`${leaf}_one`], `${locale} ${leaf}_one`).toContain('{{count}}');
      expect(progress[`${leaf}_other`], `${locale} ${leaf}_other`).toContain('{{count}}');
    }
    expect(progress.finished_one).toContain('{{finished}}');
    expect(progress.finished_other).toContain('{{finished}}');
    expect(progress.label, `${locale} stale "devices done" label`).toBeUndefined();
    expect(bundle.sweeps.panel.running, `${locale} panel.running`).toContain('{{running}}');
  });
});
