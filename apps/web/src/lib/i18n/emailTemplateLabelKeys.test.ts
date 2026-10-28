// Guard for #9953: every built-in email template's display name comes from
// settings.json `emailTemplates.labels.<id>` in all 8 locales. Template ids are
// the stable catalog in packages/shared/src/utils/emailTemplates.ts — adding an
// id there without a label in every locale fails this test instead of quietly
// rendering the English fallback in the Email templates settings tab.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMAIL_TEMPLATE_IDS, emailTemplateLabel } from '@breeze/shared';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;

function labels(locale: string): Record<string, unknown> {
  const catalog = JSON.parse(readFileSync(join(localesDir, locale, 'settings.json'), 'utf8')) as {
    emailTemplates?: { labels?: Record<string, unknown> };
  };
  return catalog.emailTemplates?.labels ?? {};
}

describe('email template label keys (#9953)', () => {
  const en = labels('en');

  it.each(LOCALES)('%s has a non-empty label for every built-in template id', (locale) => {
    const catalog = labels(locale);
    const missing = EMAIL_TEMPLATE_IDS.filter((id) => {
      const value = catalog[id];
      return typeof value !== 'string' || value.trim() === '';
    });
    expect(missing, `${locale} settings.json emailTemplates.labels`).toEqual([]);
  });

  it.each(LOCALES)('%s has no label for an id outside the catalog', (locale) => {
    const known = new Set<string>(EMAIL_TEMPLATE_IDS);
    expect(Object.keys(labels(locale)).filter((key) => !known.has(key))).toEqual([]);
  });

  it('en labels match the shared English catalog used as the render fallback', () => {
    for (const id of EMAIL_TEMPLATE_IDS) {
      expect(en[id], id).toBe(emailTemplateLabel(id));
    }
  });

  it.each(LOCALES.filter((locale) => locale !== 'en'))('%s labels are translated, not English copies', (locale) => {
    const catalog = labels(locale);
    const english = EMAIL_TEMPLATE_IDS.filter((id) => catalog[id] === en[id]);
    expect(english, `${locale} labels identical to en`).toEqual([]);
  });
});
