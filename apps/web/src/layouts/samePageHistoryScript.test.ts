import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// public/same-page-history.js must be the first popstate listener on window,
// ahead of Astro's router. The router is installed by the first page a session
// loads (often /login, which then soft-navigates in), and a head script that
// first runs after a soft swap registers behind it — so every layout that
// renders <ClientRouter /> loads the hook, before the router.
const LAYOUT_DIR = join(process.cwd(), 'src/layouts');
const routerLayouts = readdirSync(LAYOUT_DIR)
  .filter((name) => name.endsWith('.astro'))
  .filter((name) => readFileSync(join(LAYOUT_DIR, name), 'utf8').includes('<ClientRouter />'));

describe('same-page history hook in every ClientRouter layout', () => {
  it('finds the router layouts (not vacuous)', () => {
    expect(routerLayouts).toEqual(expect.arrayContaining(['Layout.astro', 'AuthLayout.astro', 'AuthShellBranded.astro', 'SetupLayout.astro']));
  });

  it.each(routerLayouts)('%s loads /same-page-history.js before <ClientRouter />', (name) => {
    const source = readFileSync(join(LAYOUT_DIR, name), 'utf8');
    expect(source).toContain('<script is:inline src="/same-page-history.js"></script>');
    expect(source.indexOf('src="/same-page-history.js"')).toBeLessThan(source.indexOf('<ClientRouter />'));
  });
});
