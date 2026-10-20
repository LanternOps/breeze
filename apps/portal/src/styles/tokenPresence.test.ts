import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_HOST_TOKENS } from '@breeze/document-ui';

const CSS = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector: RegExp): string {
  const m = new RegExp(`${selector.source}\\s*\\{([^{}]*)\\}`).exec(NO_COMMENTS);
  if (!m) throw new Error(`block ${selector} not found`);
  return m[1];
}

describe('portal hosts the tokens @breeze/document-ui reads', () => {
  it.each(DOCUMENT_HOST_TOKENS)('light :root declares --%s', (token) => {
    expect(block(/@layer base \{\s*:root/)).toMatch(new RegExp(`--${token}:\\s*[^;]+;`));
  });

  it.each(['ink', 'oxblood', 'navy', 'plum', 'bronze', 'teal', 'forest'])(
    'chrome accent %s declares the document tokens',
    (key) => {
      const light = block(new RegExp(`:root\\[data-accent='${key}'\\]`));
      for (const token of DOCUMENT_HOST_TOKENS) expect(light, token).toMatch(new RegExp(`--${token}:`));
    },
  );

  it('imports document.css above tailwindcss and scans the package sources', () => {
    const doc = CSS.indexOf("@import '@breeze/document-ui/document.css';");
    const tw = CSS.indexOf("@import 'tailwindcss';");
    expect(doc).toBeGreaterThan(-1);
    expect(doc).toBeLessThan(tw);
    expect(CSS).toContain("@source '../../../../packages/document-ui/src/**/*.{ts,tsx}';");
  });
});
