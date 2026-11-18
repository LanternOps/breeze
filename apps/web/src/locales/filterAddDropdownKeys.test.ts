import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FILTER_FIELDS } from '../components/filters/filterFields';

const here = dirname(fileURLToPath(import.meta.url));
const locales = readdirSync(here, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

describe('devices:filterAddDropdown.fields covers every filter field', () => {
  it('finds all 8 locales', () => {
    expect(locales).toHaveLength(8);
  });

  for (const locale of locales) {
    it(`${locale} has a translation for every non-custom filter field`, () => {
      const json = JSON.parse(readFileSync(join(here, locale, 'devices.json'), 'utf8'));
      const missing = FILTER_FIELDS.filter((f) => typeof resolve(json.filterAddDropdown?.fields, f.key) !== 'string').map((f) => f.key);
      expect(missing).toEqual([]);
    });
  }
});
