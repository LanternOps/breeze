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

describe('locale parity', () => {
  const locales = readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const reference = readNamespaces('en');

  it('has at least en and pt-BR', () => {
    expect(locales).toEqual(expect.arrayContaining(['en', 'pt-BR']));
  });

  for (const locale of locales.filter((value) => value !== 'en')) {
    it(`${locale} matches en namespace files and keys exactly`, () => {
      const target = readNamespaces(locale);
      expect([...target.keys()].sort()).toEqual([...reference.keys()].sort());
      for (const [namespace, keys] of reference) {
        expect(target.get(namespace), `namespace ${namespace}`).toEqual(keys);
      }
    });
  }
});
