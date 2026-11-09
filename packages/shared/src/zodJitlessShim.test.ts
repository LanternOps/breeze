import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

describe('zod jitless shim (#9972)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sets jitless in a browser-like runtime and keeps the zod API', async () => {
    vi.stubGlobal('document', {});
    vi.resetModules();
    const { z: realZ } = await import('zod/v4');
    realZ.config({ jitless: false });
    const shim = await import('./zodJitlessShim');
    expect(realZ.config().jitless).toBe(true);
    expect(shim.z.object({ a: shim.z.string() }).parse({ a: 'x' })).toEqual({ a: 'x' });
    expect(shim.default).toBe(shim.z);
    expect(typeof shim.ZodError).toBe('function');
  });

  it('leaves the JIT parser on for server runtimes', async () => {
    vi.resetModules();
    const { z: realZ } = await import('zod/v4');
    realZ.config({ jitless: false });
    await import('./zodJitlessShim');
    expect(realZ.config().jitless).toBe(false);
  });

  it.each(['apps/web/astro.config.mjs', 'apps/portal/astro.config.mjs'])(
    '%s aliases bare zod to the shim for every browser entry',
    (rel) => {
      const src = read(rel);
      expect(src).toContain('zodJitlessAlias');
      expect(src).toMatch(/alias[\s\S]*zodJitlessAlias|zodJitlessAlias[\s\S]*alias/);
    }
  );

  it('the alias is exact-match so zod subpaths (used by the shim itself) are not rewritten', async () => {
    // @ts-expect-error plain .mjs consumed by astro configs, no typings
    const { zodJitlessAlias } = await import('../zodJitlessAlias.mjs');
    expect(zodJitlessAlias.find.test('zod')).toBe(true);
    expect(zodJitlessAlias.find.test('zod/v4')).toBe(false);
    expect(zodJitlessAlias.replacement).toMatch(/zodJitlessShim\.ts$/);
  });
});
