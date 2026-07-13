import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const translatedLocales = ['pt-BR', 'es-419', 'fr-FR', 'de-DE'] as const;

function flatten(
  obj: Record<string, unknown>,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      flatten(value as Record<string, unknown>, path, out);
    } else {
      out.set(path, String(value));
    }
  }
  return out;
}

function readLocale(locale: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const file of readdirSync(join(localesDir, locale)).filter((name) =>
    name.endsWith('.json'),
  )) {
    const values = flatten(
      JSON.parse(readFileSync(join(localesDir, locale, file), 'utf8')),
    );
    for (const [key, value] of values) {
      result.set(`${file}:${key}`, value);
    }
  }
  return result;
}

describe('translation coverage', () => {
  const english = readLocale('en');

  for (const locale of translatedLocales) {
    it(`${locale} is not an English catalog copy`, () => {
      const translated = readLocale(locale);
      const duplicates = [...english].filter(
        ([key, value]) => translated.get(key) === value,
      );

      expect(
        duplicates.length / english.size,
        duplicates
          .slice(0, 25)
          .map(([key]) => key)
          .join('\n'),
      ).toBeLessThan(0.2);
    });
  }
});
