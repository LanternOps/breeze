import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #9031 leftovers from the app-shell critique: the sidebar must not animate
// its width (a layout transition that fires on every page), and the help
// panel header must not render as a card inside the panel card.
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('app shell chrome motion and nesting (#9031)', () => {
  it('sidebar shell transitions shadow only, never width/all', () => {
    const src = read('Sidebar.tsx');
    expect(src).not.toMatch(/transition-all/);
    expect(src).toMatch(/'flex h-full flex-col border-r bg-card transition-shadow duration-200'/);
  });

  it('help panel header is a divider row, not a nested card', () => {
    const src = read('../help/HelpPanel.tsx');
    expect(src).not.toMatch(/border-b bg-card px-4 py-3/);
    expect(src).toMatch(/flex items-center justify-between border-b px-4 py-3/);
  });
});
