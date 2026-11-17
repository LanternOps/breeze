import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #12053: the Software Library and the Third-Party Package Catalog each say
// what they are and are not, in every locale.
const here = dirname(fileURLToPath(import.meta.url));
const locales = readdirSync(here, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const read = (locale: string, file: string) =>
  JSON.parse(readFileSync(join(here, locale, file), 'utf8'));

describe('software scope copy (#12053)', () => {
  it('covers all 8 locales', () => expect(locales).toHaveLength(8));
  for (const locale of locales) {
    it(`${locale} has the library and catalog scope notes`, () => {
      const lib = read(locale, 'policies.json').software.softwareCatalog.libraryScopeNote;
      const cat = read(locale, 'admin.json').admin.thirdPartyCatalog.scopeNote;
      expect(typeof lib).toBe('string');
      expect(lib.length).toBeGreaterThan(40);
      expect(typeof cat).toBe('string');
      expect(cat.length).toBeGreaterThan(40);
    });
  }
});
