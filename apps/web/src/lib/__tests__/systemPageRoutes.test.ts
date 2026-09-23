import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-level checks on the two .astro routes (the same approach as
// settingsPageRegistry.test.ts). They live here, not under src/pages, because
// Astro would serve a .ts file in src/pages as an endpoint.
const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('system page routes (W02)', () => {
  it('redirects the old Deprecations settings URL to the System page tab with a 301', () => {
    const src = readFileSync(join(WEB_SRC, 'pages/settings/system/deprecations.astro'), 'utf-8');
    expect(src).toContain("return Astro.redirect('/admin/system?tab=deprecations', 301);");
    expect(src).not.toMatch(/DeprecationsTab|SystemDeprecationsPage|DashboardLayout/);
  });

  it('serves /admin/system with its title key and the URL-driven initial tab', () => {
    const src = readFileSync(join(WEB_SRC, 'pages/admin/system.astro'), 'utf-8');
    expect(src).toContain('titleKey="titles.adminSystem"');
    expect(src).toContain("parseSystemTab(Astro.url.searchParams.get('tab'))");
    expect(src).toMatch(/<SystemPage client:load initialTab=\{initialTab\} \/>/);
  });
});
