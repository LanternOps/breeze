import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Customer-facing copy must never leak an internal wave/ticket name like
// "W05c" / "W05d" — it reads as an internal artifact, not behavior, to a
// partner or org admin.
const localesDir = dirname(fileURLToPath(import.meta.url));

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(flattenStrings);
  }
  return [];
}

const locales = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('monitoring locale copy carries no internal wave name', () => {
  for (const locale of locales) {
    it(`${locale} monitoring.json has no W05 wave reference`, () => {
      const raw = JSON.parse(readFileSync(join(localesDir, locale, 'monitoring.json'), 'utf8'));
      const offenders = flattenStrings(raw).filter((value) => /\bW05[a-z]?\b/.test(value));
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  }
});
