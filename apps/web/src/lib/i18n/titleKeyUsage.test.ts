// Guards the `titleKey="..."` contract between `.astro` pages/layouts and
// `locales/en/pages.json`. `tServer` falls back silently to the raw key (or
// to English) when a lookup misses, so a typo'd or renamed titleKey would
// otherwise render literal dot-path text in the page title with no test
// failure anywhere else — this is the missing-key check for that path.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const webSrcDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
const enPagesPath = join(webSrcDir, 'locales/en/pages.json');

function* walkAstroFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walkAstroFiles(path);
    } else if (entry.endsWith('.astro')) {
      yield path;
    }
  }
}

function flattenKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of flattenKeys(value as Record<string, unknown>, path)) keys.add(nested);
    } else {
      keys.add(path);
    }
  }
  return keys;
}

describe('titleKey usage', () => {
  it('every titleKey="..." in .astro pages/layouts resolves in en/pages.json', () => {
    const enKeys = flattenKeys(JSON.parse(readFileSync(enPagesPath, 'utf8')));
    const problems: string[] = [];

    for (const dir of ['pages', 'layouts']) {
      for (const file of walkAstroFiles(join(webSrcDir, dir))) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/titleKey="([^"]+)"/g)) {
          const key = match[1];
          if (!enKeys.has(key)) {
            problems.push(`${file}: titleKey="${key}" has no matching entry in locales/en/pages.json`);
          }
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });
});
