import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_CATALOG } from './settingsCatalog';
import { searchSettingsCatalog } from './settingsSearch';
import type { NavGateContext } from './navGates';

const ctx = (over: Partial<NavGateContext> = {}): NavGateContext => ({
  isPlatformAdmin: false,
  permissions: undefined,
  getScope: () => 'partner',
  toolSourcesEnabled: true,
  aiForOfficeEnabled: false,
  serviceManagementMode: 'native',
  ...over,
});

const allPerms = [{ resource: '*', action: '*' }] as unknown as NavGateContext['permissions'];

// Identity translator: the English fallback, like the catalogue's own defaults.
const translate = (_key: string, fallback: string) => fallback;

describe('searchSettingsCatalog (#8365)', () => {
  it.each([
    ['billing', 'billing'],
    ['enrollment', 'enrollment-keys'],
    ['custom fields', 'custom-fields'],
    ['api keys', 'api-keys'],
    ['sso', 'sso'],
  ])('finds "%s" -> %s from the catalogue', (q, id) => {
    const ids = searchSettingsCatalog(q, ctx({ permissions: allPerms }), translate).map((r) => r.id);
    expect(ids).toContain(id);
  });

  it('returns catalogue hrefs verbatim', () => {
    const [hit] = searchSettingsCatalog('enrollment', ctx({ permissions: allPerms }), translate);
    expect(hit!.href).toBe('/settings/enrollment-keys');
  });

  it('hides entries the user cannot see (same gate as the nav)', () => {
    const noPerms = ctx({ permissions: [] });
    expect(searchSettingsCatalog('enrollment', noPerms, translate)).toEqual([]);
    expect(searchSettingsCatalog('users', noPerms, translate).map((r) => r.id)).not.toContain('users');
  });

  it('hides partner-only entries for org-scoped users', () => {
    const org = ctx({ permissions: allPerms, getScope: () => 'organization' });
    expect(searchSettingsCatalog('billing', org, translate)).toEqual([]);
  });

  it('matches the translated title, not just the English name', () => {
    const t = (key: string, fallback: string) => (key === 'nav.billing' ? 'Facturación' : fallback);
    const ids = searchSettingsCatalog('factura', ctx({ permissions: allPerms }), t).map((r) => r.id);
    expect(ids).toContain('billing');
  });

  it('every catalogue entry is findable by its own name when visible', () => {
    const c = ctx({ permissions: allPerms, isPlatformAdmin: true });
    for (const e of SETTINGS_CATALOG) {
      const ids = searchSettingsCatalog(e.name, c, translate).map((r) => r.id);
      expect(ids, e.id).toContain(e.id);
    }
  });

  it('returns nothing for a blank query', () => {
    expect(searchSettingsCatalog('   ', ctx({ permissions: allPerms }), translate)).toEqual([]);
  });
});

// Carried over from the API's #6748 guard: a search hit must land on a page that
// exists (a redirect page still resolves), never a 404.
describe('catalogue hrefs resolve to real pages', () => {
  const PAGES = resolve(dirname(fileURLToPath(import.meta.url)), '../pages');
  const serving = (href: string): string | null => {
    const path = href.split(/[?#]/)[0]!.replace(/\/$/, '');
    for (const f of [`${PAGES}${path}.astro`, `${PAGES}${path}/index.astro`]) {
      if (existsSync(f)) return f;
    }
    return null;
  };
  it.each(SETTINGS_CATALOG.map((e) => [e.id, e.href] as const))('%s -> %s', (_id, href) => {
    expect(serving(href)).not.toBeNull();
  });
});
