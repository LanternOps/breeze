import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { PACKAGE_PROBE_CLASS } from '@breeze/document-ui';
import { describe, expect, it } from 'vitest';

/**
 * Compiles this app's real globals.css the way @tailwindcss/vite does and
 * checks the emitted stylesheet carries (a) the package's document.css and
 * (b) a utility that only a `packages/document-ui` source file uses. (b) is
 * what proves the `@source` line reaches the workspace package: Tailwind v4
 * does not scan it on its own.
 */
const STYLES_DIR = import.meta.dirname;
const SRC_DIR = join(STYLES_DIR, '..');

async function buildAppCss(): Promise<string> {
  const css = readFileSync(join(STYLES_DIR, 'globals.css'), 'utf8');
  const compiler = await compile(css, { base: STYLES_DIR, onDependency: () => {} });
  const scanner = new Scanner({ sources: compiler.sources });
  return compiler.build(scanner.scan());
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(astro|tsx?|jsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe('built stylesheet', () => {
  it('carries document.css and package-only utilities', async () => {
    const css = await buildAppCss();
    expect(css).toContain('[data-document-root]');
    expect(css).toContain('.doc-accent-bg');
    expect(css).toMatch(/sm\\:px-\\\[3\\\.25rem\\\]/);
  }, 120_000);

  it('the probe class is package-only (otherwise the @source assertion proves nothing)', () => {
    const users = walk(SRC_DIR)
      .filter((f) => !f.endsWith('.build.test.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes(PACKAGE_PROBE_CLASS));
    expect(users).toEqual([]);
  });
});
