import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = dirname(fileURLToPath(import.meta.url));

function tabSection(locale: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(localesDir, locale, 'devices.json'), 'utf8')) as Record<string, unknown>;
  return (raw.deviceFilesystemTab ?? {}) as Record<string, unknown>;
}

const locales = readdirSync(localesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe('deviceFilesystemTab locale hygiene', () => {
  it('covers all eight locales', () => {
    expect(locales.length).toBe(8);
  });

  for (const locale of locales) {
    it(`${locale} carries no internal ticket id and no punctuation-only key`, () => {
      const section = tabSection(locale);
      // The tab heading shipped as "BE-1: Disk Cleanup Intelligence" and the
      // empty state as "...to collect BE-1 data" in every locale.
      expect(section).not.toHaveProperty('be1DiskCleanupIntelligence');
      // `text: ">="` is not a translatable string; it is an operator rendered
      // through the translation layer, which every translator then had to copy.
      expect(section).not.toHaveProperty('text');
      expect(section).toHaveProperty('title');
      for (const [key, value] of Object.entries(section)) {
        if (typeof value !== 'string') continue;
        expect(`${locale}.${key}: ${value}`).not.toContain('BE-1');
      }
    });
  }
});
