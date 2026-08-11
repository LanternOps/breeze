import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const translatedLocales = ['pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT'] as const;

function catalog(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localesDir, locale, `${namespace}.json`), 'utf8'));
}

function valueAt(source: Record<string, unknown>, path: string): string {
  const value = path.split('.').reduce<unknown>((current, segment) =>
    typeof current === 'object' && current !== null
      ? (current as Record<string, unknown>)[segment]
      : undefined, source);
  expect(typeof value, path).toBe('string');
  return value as string;
}

describe('product terminology quality', () => {
  it('translates network switches as devices rather than actions or electrical switches', () => {
    const expected = {
      'pt-BR': 'Switch',
      'es-419': 'Conmutador',
      'fr-FR': 'Commutateur',
      'fr-CA': 'Commutateur',
      'de-DE': 'Netzwerk-Switch',
      'it-IT': 'Switch',
    } as const;

    for (const locale of translatedLocales) {
      expect(valueAt(catalog(locale, 'devices'), 'deviceList.roles.switch')).toBe(expected[locale]);
      expect(valueAt(catalog(locale, 'discovery'), 'assetTypes.switch')).toBe(expected[locale]);
    }
  });

  it('keeps reviewed false friends and malformed machine translations out of catalogs', () => {
    const forbidden = {
      'pt-BR': [/\bvoce\b(?!@)/i, /\besta ativa\b/i, /\bcomecar\b/i, /teste de fumaça/i],
      'es-419': [/conocimientos impulsados/i, /AI-ayuda impulsada/i],
      'fr-FR': [/\bpostuler\b/i, /\bsubventions?\b/i, /test de fumée/i, /oscilloire/i],
      'fr-CA': [/\bpostuler\b/i, /\bsubventions?\b/i, /test de fumée/i, /oscilloire/i],
      'de-DE': [/\bHauptschalter\b/i, /\bKernschalter\b/i],
      'it-IT': [/\bpotrài\b/i],
    } as const;

    for (const locale of translatedLocales) {
      const localeDir = join(localesDir, locale);
      const text = readdirSync(localeDir)
        .filter(file => file.endsWith('.json'))
        .map(file => readFileSync(join(localeDir, file), 'utf8'))
        .join('\n');
      for (const pattern of forbidden[locale]) {
        expect(text, `${locale}: ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
