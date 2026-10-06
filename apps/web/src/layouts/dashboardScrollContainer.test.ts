import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('dashboard layout scroll container', () => {
  // <main> is the only scroller in the h-screen shell. If it is not a containing
  // block, any position:absolute descendant without a positioned ancestor (every
  // `sr-only` label) resolves against the viewport, so one below the fold makes the
  // document taller than the window: the whole shell, sidebar included, scrolls
  // and the bottom of the page is cut off.
  it('makes <main> the containing block for absolutely positioned content', () => {
    const source = readFileSync(join(process.cwd(), 'src/layouts/DashboardLayout.astro'), 'utf8');
    const main = source.match(/<main class="([^"]*)"/);

    expect(main).not.toBeNull();
    expect(main![1].split(/\s+/)).toEqual(expect.arrayContaining(['relative', 'overflow-y-auto']));
  });
});
