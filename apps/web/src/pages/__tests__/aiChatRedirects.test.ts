import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(pagesDir, rel), 'utf-8');

// W05 of #10131 (#10136, spec §7, Review Focus 4): the full-page Breeze AI chat
// lives at /ai/chat. Its two old addresses are permanent redirects whose
// Location carries no fragment, so the browser keeps the request's own
// (`/wisp/chat#session=<id>` → `/ai/chat#session=<id>`). The fragment hop
// itself is a browser behaviour: e2e-tests/tests/wisp-home.spec.ts drives it.
describe('the Breeze AI chat page and its redirects', () => {
  it('/ai/chat is the multi-tab chat page, titled Breeze AI', () => {
    expect(existsSync(resolve(pagesDir, 'ai/chat.astro'))).toBe(true);
    const src = read('ai/chat.astro');
    expect(src).toMatch(/import WorkspacePage from ['"][./]+components\/workspace\/WorkspacePage['"]/);
    expect(src).toMatch(/<WorkspacePage client:load\s*\/>/);
    expect(src).toMatch(/titleKey="titles\.wispChat"/);
  });

  it.each(['wisp/chat.astro', 'workspace.astro'])('%s permanently redirects to /ai/chat without a fragment of its own', (page) => {
    const src = read(page);
    expect(src).toMatch(/return Astro\.redirect\('\/ai\/chat', 301\);/);
    expect(src).not.toMatch(/Astro\.redirect\([^)]*#/);
    // A redirect stub renders nothing else.
    expect(src).not.toMatch(/WorkspacePage/);
  });
});
