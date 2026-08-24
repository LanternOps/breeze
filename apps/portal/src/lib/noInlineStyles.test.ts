import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract test: the portal must not use inline `style` attributes.
 *
 * `lib/csp.ts` sets `style-src-attr 'none'` on every production response, so a
 * `style={{...}}` attribute is silently REFUSED in production. Local dev drops
 * the CSP header entirely, which is why fifteen of them shipped: the partner
 * brand accent, the document eyebrow, the hero currency figures on both the
 * proposal and the invoice, author-set image widths, author-set table column
 * alignment, and the cursive signature preview all rendered correctly on every
 * developer's machine and were broken for every customer.
 *
 * Nothing in the type system or the unit tests catches this — the component
 * reads perfectly. The only signals are a CSP console error in a production
 * build, or this test.
 *
 * Runtime-valued styling belongs in one of two places instead:
 *  - a utility class in globals.css (`.doc-accent-*`, `.signature-preview`), or
 *  - the nonced `<style>` element the layouts emit (see lib/docAccent.ts) when
 *    the value genuinely varies per request.
 * A presentational HTML attribute (`width`, `height`) is also fine — those are
 * not style attributes and CSP does not cover them.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === 'node_modules') return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(tsx|astro)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('no inline style attributes (production CSP sets style-src-attr none)', () => {
  const files = walk(SRC);

  it('finds portal source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no component sets a style attribute', () => {
    const violations: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // JSX `style={...}` and plain HTML `style="..."`. Astro's `set:html`
          // and `is:inline` <style> ELEMENTS are fine — those are style-src-elem.
          // JSX `style={...}` and HTML `style="..."` — on the element's own line
          // (any tag case, so component tags count) OR as a Prettier-wrapped
          // attribute line of its own.
          if (/\bstyle=\{/.test(line) || /<[A-Za-z][^>]*\sstyle="/.test(line) || /^\s*style="/.test(line)) {
            violations.push(`${relative(SRC, file)}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(
      violations,
      `These are refused in production by style-src-attr 'none'.\n` +
        `Use a class in globals.css, the nonced <style> element (lib/docAccent.ts),\n` +
        `or a presentational attribute instead:\n${violations.join('\n')}`
    ).toEqual([]);
  });
});
