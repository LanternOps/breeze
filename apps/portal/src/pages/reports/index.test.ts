import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');
const listSource = readFileSync(
  new URL('../../components/portal/ReportRunList.tsx', import.meta.url),
  'utf8',
);

describe('reports page structure', () => {
  it('authors no heading of its own — the h1 belongs to ReportRunList', () => {
    // Structural guard: a hand-rolled h2/h3 here would land above the
    // component's own h1 and break the outline the shared EmptyState assumes.
    expect(pageSource).not.toMatch(/<h[1-6]\b/);
    expect(listSource).toMatch(/<PageHeader\s+title="Reports"/);
  });

  it('speaks of the customer machines, not their "environment"', () => {
    expect(listSource).toContain(
      'Generate and download a current summary of your machines.',
    );
    expect(listSource).not.toContain('your environment');
  });

  it('offers both generate actions as peers', () => {
    // A false primary made the security summary look like the page's one act.
    expect(listSource).not.toContain('BTN_PRIMARY');
    expect(listSource).toContain("'Generate security summary'");
  });
});
