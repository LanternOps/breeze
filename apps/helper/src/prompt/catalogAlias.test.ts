import { describe, expect, it } from 'vitest';

import negotiateSrc from '@prompt-catalog/negotiate?raw';
import sanitizeSrc from '@prompt-catalog/sanitize?raw';
import brandContrastSrc from '@breeze-brand-contrast?raw';

/*
 * #10190 plan P3: Assist reads packages/shared through a whitelist alias and
 * must never pull the zod-backed promptCatalog/index.ts barrel (or anything
 * else in @breeze/shared) into the Assist bundle.
 */

const sources = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('prompt catalog alias', () => {
  it('reaches only import-free shared files', () => {
    for (const [name, src] of Object.entries({ negotiateSrc, sanitizeSrc, brandContrastSrc })) {
      expect(src.length, name).toBeGreaterThan(100);
      expect(src, `${name} gained an import; Assist would bundle it`).not.toMatch(/^\s*import\s|\brequire\(|\bimport\(/m);
    }
  });

  it('does not resolve the barrel or any other promptCatalog file', async () => {
    for (const spec of ['@prompt-catalog', '@prompt-catalog/index', '@prompt-catalog/render', '@prompt-catalog/identity']) {
      await expect(import(/* @vite-ignore */ spec), spec).rejects.toThrow();
    }
  });

  it('no Assist source imports @breeze/shared or the catalog barrel', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    for (const [file, src] of Object.entries(sources)) {
      expect(src, file).not.toMatch(/from\s+['"]@breeze\/shared/);
      expect(src, file).not.toMatch(/from\s+['"]@prompt-catalog(\/index)?['"]/);
      // Only the whitelist alias reaches packages/shared, never a relative path.
      expect(src, file).not.toMatch(/(from\s+|import\()['"][^'"]*packages\/shared/);
    }
  });
});
