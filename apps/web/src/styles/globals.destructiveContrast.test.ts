import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'globals.css'), 'utf8');

/** #7511: destructive outline/ghost buttons (text-destructive on card/background) failed WCAG AA. */
function block(selector: RegExp): string {
  const m = css.match(selector);
  if (!m || m.index === undefined) throw new Error(`block not found: ${selector}`);
  const start = css.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  throw new Error('unbalanced');
}

type Hsl = [number, number, number];

function token(b: string, name: string): Hsl {
  const m = b.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%`));
  if (!m) throw new Error(`token --${name} not found`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function rgb([h, sPct, lPct]: Hsl): number[] {
  const s = sPct / 100;
  const l = lPct / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function lum(c: number[]): number {
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: Hsl, b: Hsl): number {
  const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const themes: Record<string, string> = {
  light: block(/^\s*:root\s*\{\s*$/m),
  dark: block(/^\s*\.dark\s*\{\s*$/m),
};

describe('destructive text contrast (WCAG AA 4.5:1)', () => {
  for (const [name, b] of Object.entries(themes)) {
    it(`${name}: --destructive as text clears 4.5:1 on card and background`, () => {
      const fg = token(b, 'destructive');
      expect(ratio(fg, token(b, 'card'))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(fg, token(b, 'background'))).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: --destructive fill keeps its label at 4.5:1`, () => {
      expect(ratio(token(b, 'destructive'), token(b, 'destructive-foreground'))).toBeGreaterThanOrEqual(4.5);
    });
  }

});
