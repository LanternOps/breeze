import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_HOST_TOKENS } from '@breeze/document-ui';

const CSS = readFileSync(join(import.meta.dirname, 'globals.css'), 'utf8');
const NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first plain `:root { … }` whose body declares --primary: the light theme. */
function lightRoot(): string {
  for (const m of NO_COMMENTS.matchAll(/\n\s*:root\s*\{([^{}]*)\}/g)) {
    if (/--primary:/.test(m[1])) return m[1];
  }
  throw new Error('light :root block not found');
}

describe('web hosts the tokens @breeze/document-ui reads', () => {
  it.each(DOCUMENT_HOST_TOKENS)('light :root declares --%s', (token) => {
    expect(lightRoot()).toMatch(new RegExp(`--${token}:\\s*[^;]+;`));
  });

  it('--paper-primary equals the light --primary', () => {
    const root = lightRoot();
    const primary = /--primary:\s*([^;]+);/.exec(root)![1].trim();
    expect(/--paper-primary:\s*([^;]+);/.exec(root)![1].trim()).toBe(primary);
  });

  it('imports document.css above tailwindcss and scans the package sources', () => {
    const doc = CSS.indexOf("@import '@breeze/document-ui/document.css';");
    const tw = CSS.indexOf("@import 'tailwindcss';");
    expect(doc).toBeGreaterThan(-1);
    expect(doc).toBeLessThan(tw);
    expect(CSS).toContain("@source '../../../../packages/document-ui/src/**/*.{ts,tsx}';");
  });
});
