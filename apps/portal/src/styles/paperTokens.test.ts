import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * V-7 (visual QA 2026-10-05): documents are white paper in every theme, so in dark
 * mode the paper must not inherit the dark palette's light-on-dark accents (the mint
 * Balance-due figure measured 2.09:1 on white). The paper pins every token it paints
 * with to the LIGHT values; the chrome accent's light primary reaches it through
 * `--paper-primary`, which only the light blocks declare.
 */
const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');

function block(selector: RegExp): Map<string, string> {
  const m = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!m) throw new Error(`block ${selector} not found`);
  return new Map([...m[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map(d => [d[1], d[2].trim()]));
}

const LIGHT = block(/@layer base \{\s*\/\*[\s\S]*?\*\/\s*:root/);
const PAPER = block(/\n\[data-doc-theme\]/);

describe('document paper tokens stay light in dark mode', () => {
  it('the paper paints its accent from the light primary', () => {
    for (const token of ['primary', 'primary-on-tint', 'ring']) expect(PAPER.get(token), token).toBe('var(--paper-primary)');
    expect(PAPER.get('primary-foreground')).toBe(LIGHT.get('primary-foreground'));
    expect(LIGHT.get('paper-primary')).toBe(LIGHT.get('primary'));
  });
  it('status chips and washes on the paper use the light values', () => {
    for (const token of ['success', 'success-on-tint', 'warning', 'warning-on-tint', 'destructive', 'destructive-on-tint',
      'secondary', 'secondary-foreground', 'accent', 'accent-foreground', 'input']) {
      expect(PAPER.get(token), token).toBe(LIGHT.get(token));
    }
  });
  it.each(['ink', 'oxblood', 'navy', 'plum', 'bronze', 'teal', 'forest'])('chrome accent %s: the paper keeps its light primary', key => {
    const light = block(new RegExp(`:root\\[data-accent='${key}'\\]`));
    expect(light.get('paper-primary')).toBe(light.get('primary'));
    for (const dark of [new RegExp(`\\.dark\\[data-accent='${key}'\\]`), new RegExp(`:root\\[data-accent='${key}'\\]:not\\(\\.light\\)`)]) {
      expect(block(dark).has('paper-primary'), String(dark)).toBe(false);
    }
  });
});
