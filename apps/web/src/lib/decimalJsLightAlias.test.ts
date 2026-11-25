import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decimalJsLightAlias } from '../../decimalJsLightAlias.mjs';

// vitest runs from apps/web (same convention as src/middleware.test.ts).
const webRoot = process.cwd();

// Monaco's AMD loader (/monaco/vs/loader.js) leaves this on window, and
// <ClientRouter> keeps it there after leaving the editor page.
const amdDefine = () => {
  const define = vi.fn();
  return Object.assign(define, { amd: {} });
};

// Evaluates a UMD/CommonJS file the way a bundler's CJS wrapper does and
// returns what it exported.
function evaluateCjs(file: string, globals: Record<string, unknown>) {
  const module = { exports: {} as unknown };
  vm.runInNewContext(readFileSync(file, 'utf8'), { module, exports: module.exports, ...globals });
  return module.exports;
}

describe('decimal.js-light alias (recharts vs Monaco AMD loader)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('is exact-match and points at the ESM build', () => {
    expect(decimalJsLightAlias.find.test('decimal.js-light')).toBe(true);
    expect(decimalJsLightAlias.find.test('decimal.js-light/decimal.mjs')).toBe(false);
    expect(decimalJsLightAlias.replacement).toMatch(/decimal\.js-light[\\/]decimal\.mjs$/);
    expect(existsSync(decimalJsLightAlias.replacement)).toBe(true);
  });

  it('astro.config.mjs registers it in vite.resolve.alias', () => {
    // Drop line comments so a mention in a comment can't satisfy the check.
    const src = readFileSync(join(webRoot, 'astro.config.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/import \{ decimalJsLightAlias \}/);
    expect(src).toMatch(/resolve:\s*\{[\s\S]*?alias:\s*\[[\s\S]*?\bdecimalJsLightAlias\b[\s\S]*?\]/);
  });

  it('the package "browser" build is the UMD one that a global AMD define hijacks', () => {
    // Documents why the alias exists: without it Vite picks `browser` for the
    // client bundle, and with Monaco's `define` present nothing is exported.
    const pkgDir = dirname(decimalJsLightAlias.replacement);
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const umd = join(pkgDir, pkg.browser);

    const plain = evaluateCjs(umd, {}) as new (v: number) => { toString(): string };
    expect(new plain(1).toString()).toBe('1');

    const define = amdDefine();
    const hijacked = evaluateCjs(umd, { define });
    expect(define).toHaveBeenCalledOnce();
    expect(hijacked).toEqual({});
  });

  it('the ESM build still exports a working Decimal when an AMD define is present', async () => {
    const define = amdDefine();
    vi.stubGlobal('define', define);
    const mod = await import(/* @vite-ignore */ pathToFileURL(decimalJsLightAlias.replacement).href);
    const Decimal = mod.default;
    expect(new Decimal(10).sub(4).div(3).toString()).toBe('2');
    expect(define).not.toHaveBeenCalled();
  });
});
