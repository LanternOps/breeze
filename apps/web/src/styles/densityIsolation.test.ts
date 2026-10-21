// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The document paper is a customer-facing page; the technician's density
 * preference (`data-density` on <html>) must never reshape it. Every density
 * rule that reaches into <main> carries a suffix that makes it unable to
 * match the document root or anything inside it (spec §3.5).
 */
const CSS = readFileSync(join(import.meta.dirname, 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const EXCLUSION = ':not([data-document-root], [data-document-root] *)';

/** Split a selector list on commas that are not inside parentheses. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function densitySelectors(mode: string): string[] {
  const out: string[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const sel of splitTopLevel(m[1])) {
      if (sel.includes(`[data-density='${mode}']`)) out.push(sel);
    }
  }
  return out;
}

describe('density rules never reach the document paper', () => {
  it('finds the density rules it guards', () => {
    expect(densitySelectors('compact').length).toBeGreaterThan(10);
    expect(densitySelectors('dense').length).toBeGreaterThan(10);
  });

  it.each(['compact', 'dense'])('%s: every selector carries the document-root exclusion', (mode) => {
    const offenders = densitySelectors(mode).filter((s) => !s.endsWith(EXCLUSION));
    expect(offenders).toEqual([]);
  });

  it.each(['compact', 'dense'])('%s: no selector matches the document root or its descendants', (mode) => {
    document.body.innerHTML = `<div data-density="${mode}"><main class="flex-1"><article data-document-root class="p-8 px-8 py-8 gap-6 space-y-6 mt-6 mb-6"><p class="p-8 px-6 py-6 gap-6 mt-6 mb-6"></p><div class="space-y-6"><span class="p-4"></span><span class="p-4"></span></div></article></main></div>`;
    const els = [...document.querySelectorAll('[data-document-root], [data-document-root] *')];
    expect(els.length).toBeGreaterThan(3);
    // Control: the same markup WITHOUT the root attribute is reshaped, so the
    // assertion below can fail (it is not vacuously true).
    const control = document.createElement('div');
    control.innerHTML = '<div data-density="' + mode + '"><main class="flex-1"><p class="p-8"></p></main></div>';
    document.body.appendChild(control);
    const controlP = control.querySelector('p')!;
    expect(densitySelectors(mode).some((s) => controlP.matches(s))).toBe(true);
    for (const el of els) {
      for (const sel of densitySelectors(mode)) {
        expect(el.matches(sel), `${sel} matched <${el.tagName.toLowerCase()} class="${el.className}">`).toBe(false);
      }
    }
  });
});
