/**
 * Locale parity test for the API-side i18n locale tree.
 *
 * Rules (mirrored from apps/web/src/lib/i18n/localeParity.test.ts):
 * - Every key present in `en/<ns>.json` must also be present in every other
 *   locale's `<ns>.json` with the same key path.
 * - Every non-English value must be a string (same type as the English leaf).
 * - Interpolation tokens ({{var}}) must match between English and every
 *   translation — a missing token causes silent omission in the final string.
 * - English source files must contain only string leaf values (no raw objects).
 *
 * When adding a new locale, create the three namespace files under
 * `locales/<locale>/` and list the locale in `NON_ENGLISH_LOCALES` below.
 * The test runner will automatically enforce key/token parity for the new tree.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), 'locales');

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, path)
      : [path];
  });
}

type LeafValues = Map<string, unknown>;

function flattenValues(
  obj: Record<string, unknown>,
  prefix = '',
  result: LeafValues = new Map(),
): LeafValues {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenValues(value as Record<string, unknown>, path, result);
    } else {
      result.set(path, value);
    }
  }
  return result;
}

function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)]
    .map((match) => match[1])
    .sort();
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const enDir = join(localesDir, 'en');
const namespaces = readdirSync(enDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''));

const nonEnglishLocales = readdirSync(localesDir).filter((l) => l !== 'en');

describe('API locale parity', () => {
  for (const ns of namespaces) {
    describe(`namespace: ${ns}`, () => {
      const enPath = join(enDir, `${ns}.json`);
      const enData = readJson(enPath);
      const enValues = flattenValues(enData);

      it(`en/${ns}.json has only string leaf values`, () => {
        const nonString = [...enValues.entries()].filter(([, v]) => typeof v !== 'string');
        expect(nonString, `Non-string leaves: ${nonString.map(([k]) => k).join(', ')}`).toHaveLength(0);
      });

      for (const locale of nonEnglishLocales) {
        const translatedPath = join(localesDir, locale, `${ns}.json`);

        it(`${locale}/${ns}.json exists`, () => {
          expect(() => readJson(translatedPath)).not.toThrow();
        });

        it(`${locale}/${ns}.json has all keys from en`, () => {
          const data = readJson(translatedPath);
          const translatedValues = flattenValues(data);
          const enKeys = flattenKeys(enData);
          const missing = enKeys.filter((k) => !translatedValues.has(k));
          expect(missing, `Missing keys: ${missing.join(', ')}`).toHaveLength(0);
        });

        it(`${locale}/${ns}.json has no extra keys not in en`, () => {
          const data = readJson(translatedPath);
          const enKeys = new Set(flattenKeys(enData));
          const extra = flattenKeys(data).filter((k) => !enKeys.has(k));
          expect(extra, `Extra keys: ${extra.join(', ')}`).toHaveLength(0);
        });

        it(`${locale}/${ns}.json interpolation tokens match en`, () => {
          const data = readJson(translatedPath);
          const translatedValues = flattenValues(data);
          const tokenErrors: string[] = [];
          for (const [key, enValue] of enValues) {
            if (typeof enValue !== 'string') continue;
            const translated = translatedValues.get(key);
            if (typeof translated !== 'string') continue;
            const enTokens = interpolationTokens(enValue);
            const trTokens = interpolationTokens(translated);
            if (JSON.stringify(enTokens) !== JSON.stringify(trTokens)) {
              tokenErrors.push(
                `${key}: en=[${enTokens.join(',')}] ${locale}=[${trTokens.join(',')}]`,
              );
            }
          }
          expect(tokenErrors, tokenErrors.join('\n')).toHaveLength(0);
        });
      }
    });
  }
});
