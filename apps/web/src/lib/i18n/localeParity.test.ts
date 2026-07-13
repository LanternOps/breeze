import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, path)
      : [path];
  });
}

function flattenValues(
  obj: Record<string, unknown>,
  prefix = '',
  result = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      flattenValues(value as Record<string, unknown>, path, result);
    } else {
      result.set(path, String(value));
    }
  }
  return result;
}

function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)]
    .map((match) => match[1])
    .sort();
}

function readNamespaces(locale: string): Map<string, string[]> {
  const dir = join(localesDir, locale);
  return new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => [
        file,
        flattenKeys(JSON.parse(readFileSync(join(dir, file), 'utf8'))).sort(),
      ])
  );
}

function readNamespaceValues(locale: string): Map<string, Map<string, string>> {
  const dir = join(localesDir, locale);
  return new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => [
        file,
        flattenValues(JSON.parse(readFileSync(join(dir, file), 'utf8'))),
      ]),
  );
}

describe('locale parity', () => {
  const locales = readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const reference = readNamespaces('en');
  const referenceValues = readNamespaceValues('en');

  it('contains every supported locale catalog', () => {
    expect(locales).toEqual(
      expect.arrayContaining(['en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE']),
    );
  });

  for (const locale of locales.filter((value) => value !== 'en')) {
    it(`${locale} matches en namespace files and keys exactly`, () => {
      const target = readNamespaces(locale);
      expect([...target.keys()].sort()).toEqual([...reference.keys()].sort());
      for (const [namespace, keys] of reference) {
        expect(target.get(namespace), `namespace ${namespace}`).toEqual(keys);
      }
    });

    it(`${locale} preserves interpolation variables`, () => {
      const targetValues = readNamespaceValues(locale);
      for (const [namespace, values] of referenceValues) {
        for (const [key, english] of values) {
          expect(
            interpolationTokens(targetValues.get(namespace)?.get(key) ?? ''),
            `${namespace}:${key}`,
          ).toEqual(interpolationTokens(english));
        }
      }
    });
  }
});
