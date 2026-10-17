import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// #9031: functional text in the app shell must not drop below the 11px floor,
// and the Cmd+K / kbd badges must clear 4.5:1.
const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf8');

describe('app shell 11px floor (#9031)', () => {
  it('Sidebar footer is not 10px and not dimmed with an opacity modifier', () => {
    const src = read('Sidebar.tsx');
    expect(src).not.toMatch(/text-\[10px\]/);
    expect(src).not.toMatch(/text-muted-foreground\/50/);
  });

  it('CommandPalette badges are not 10px and avoid muted-foreground on bg-muted', () => {
    const src = read('CommandPalette.tsx');
    expect(src).not.toMatch(/text-\[10px\]/);
    // text-muted-foreground on bg-muted measured 4.2:1 (light theme).
    // text-foreground/70 on bg-muted is ~8:1 light, ~8.5:1 dark.
    expect(src).not.toMatch(/bg-muted[^'"`]*text-muted-foreground/);
    expect(src).not.toMatch(/text-muted-foreground[^'"`]*bg-muted/);
  });
});
