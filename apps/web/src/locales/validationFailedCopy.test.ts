import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// #8369: `errors:VALIDATION_FAILED` is the generic headline runAction shows on
// every field-level 400, app-wide. Most forms never map the API's field errors
// back onto inputs, so copy that promises "highlighted" fields points the user
// at nothing. This pins that no shipped locale makes that promise.
const dir = dirname(fileURLToPath(import.meta.url));
const locales = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// "highlight" in each shipped language (de, es, fr, it, pt, tr).
const HIGHLIGHT_WORDS = [
  'highlight', 'markiert', 'hervorgehoben', 'resaltad', 'destacad', 'surlign', 'mis en évidence',
  'evidenziat', 'vurgulan', 'işaretlen',
];

describe('errors:VALIDATION_FAILED copy (#8369)', () => {
  it('ships in every locale folder', () => {
    expect(locales.length).toBeGreaterThanOrEqual(8);
  });

  it('en copy is the wording runAction.test.ts stubs', () => {
    const en = JSON.parse(readFileSync(join(dir, 'en', 'errors.json'), 'utf8')) as Record<string, string>;
    expect(en.VALIDATION_FAILED).toBe('Fix the invalid values and try again');
  });

  it.each(locales)('%s does not promise highlighted fields', (locale) => {
    const errors = JSON.parse(readFileSync(join(dir, locale, 'errors.json'), 'utf8')) as Record<string, string>;
    const copy = errors.VALIDATION_FAILED;
    expect(typeof copy).toBe('string');
    expect(copy.length).toBeGreaterThan(0);
    const lower = copy.toLocaleLowerCase();
    for (const word of HIGHLIGHT_WORDS) expect(lower, `${locale}: "${copy}"`).not.toContain(word);
  });
});
