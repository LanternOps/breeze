// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_HOST_TOKENS } from '../tokens';

const CSS = readFileSync(fileURLToPath(new URL('../document.css', import.meta.url)), 'utf8');

function block(selector: RegExp): Map<string, string> {
  const m = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!m) throw new Error(`block ${selector} not found`);
  return new Map([...m[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map((d) => [d[1], d[2].trim()]));
}

const PAPER = block(/\n\[data-document-root\]/);
const ACCENT_TOKENS = ['primary', 'primary-on-tint', 'ring'];

it('the paper paints its accent from the host light primary, with a literal fallback', () => {
  for (const t of ACCENT_TOKENS) expect(PAPER.get(t), t).toBe('var(--paper-primary, 225 62% 48%)');
});

it('every other paper colour token is a literal HSL triplet', () => {
  const colours = [...PAPER].filter(([t]) => !ACCENT_TOKENS.includes(t) && !t.startsWith('doc-'));
  expect(colours.length).toBeGreaterThan(10);
  for (const [t, v] of colours) expect(v, t).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/);
});

it('every var() the paper block reads but does not set is a DOCUMENT_HOST_TOKENS entry', () => {
  const m = /\n\[data-document-root\]\s*\{([^}]*)\}/.exec(CSS)!;
  const read = new Set([...m[1].matchAll(/var\(--([a-z0-9-]+)\s*[,)]/gi)].map((d) => d[1]));
  const unset = [...read].filter((t) => !PAPER.has(t));
  expect(unset.sort()).toEqual([...DOCUMENT_HOST_TOKENS].sort());
});

it('owns the document fonts', () => {
  expect(PAPER.get('doc-font-sans')).toBeTruthy();
  expect(PAPER.get('doc-font-display')).toBeTruthy();
  expect(CSS).toContain('@fontsource/hanken-grotesk/400.css');
  expect(CSS).toContain('@fontsource/literata/500.css');
});

it('condensed rules are scoped under [data-document-root]', () => {
  expect(CSS).toMatch(/\[data-document-root\]\[data-doc-theme='condensed'\]/);
  expect(CSS).not.toMatch(/(^|\n)\[data-doc-theme/);
});

it('accent and signature classes stay global (used outside document roots)', () => {
  for (const c of ['doc-accent-bg', 'doc-accent-text', 'doc-accent-border', 'signature-preview']) {
    expect(CSS).toMatch(new RegExp(`(^|\\n)\\.${c}\\s*[{,]`));
  }
});
