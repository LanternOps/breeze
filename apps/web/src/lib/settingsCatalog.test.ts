import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../components/extensions/useExtensionNavigation', () => ({ useExtensionNavigation: () => [] }));
vi.mock('../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(() => undefined, { getState: () => ({ tokens: null }) }),
}));

import { SETTINGS_CATALOG, SETTINGS_GROUPS, SIDEBAR_SETTINGS_IDS } from './settingsCatalog';
import { isNavGateVisible, type NavGateContext } from './navGates';
import { navSections, topLevelNav } from '../components/layout/Sidebar';

import common from '../locales/en/common.json';
import pages from '../locales/en/pages.json';
import settings from '../locales/en/settings.json';

const NS: Record<string, unknown> = { common, pages, settings };
function resolves(key: string): boolean {
  const [ns, path] = key.includes(':') ? key.split(':') : ['common', key];
  return typeof path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], NS[ns]) === 'string';
}

const here = dirname(fileURLToPath(import.meta.url));
const PAGES = join(here, '../pages/settings');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full) : e.endsWith('.astro') ? [relative(PAGES, full)] : [];
  });
}

const settingsItems = () => navSections.find((s) => s.id === 'settings')!.items;

describe('settings catalogue (#6220)', () => {
  it('lists AI Providers & Models in the AI group, deep-linking the partner tab', () => {
    expect(SETTINGS_CATALOG.find((e) => e.id === 'ai-models')).toMatchObject({
      group: 'ai',
      href: '/settings/partner#ai-provider',
      labelKey: 'nav.aiProvidersModels',
      partnerScopeOnly: true,
    });
  });

  it('has unique ids and hrefs, and only known groups', () => {
    const ids = SETTINGS_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hrefs = SETTINGS_CATALOG.map((e) => e.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const e of SETTINGS_CATALOG) expect(SETTINGS_GROUPS).toContain(e.group);
  });

  it('every label/description/group key resolves in the English catalogue', () => {
    const keys = SETTINGS_CATALOG.flatMap((e) => [e.labelKey, ...(e.descriptionKey ? [e.descriptionKey] : [])]);
    keys.push(...SETTINGS_GROUPS.map((g) => `pages:settingsIndex.groups.${g}`));
    expect(keys.filter((k) => !resolves(k))).toEqual([]);
  });

  it('lists every non-redirect page under pages/settings', () => {
    const hrefs = new Set(SETTINGS_CATALOG.map((e) => e.href.split('#')[0]));
    const missing = walk(PAGES)
      .filter((p) => !readFileSync(join(PAGES, p), 'utf-8').includes('Astro.redirect('))
      .filter((p) => !/\[[^\]]+\]/.test(p) && p !== 'index.astro' && !p.startsWith('system/') && !p.startsWith('tool-sources/'))
      .map((p) => '/settings/' + p.replace(/\.astro$/, '').replace(/\/index$/, ''))
      .filter((route) => !hrefs.has(route));
    expect(missing).toEqual([]);
  });

  it('sidebar Settings is trimmed to the daily-use items plus More settings', () => {
    expect(settingsItems().map((i) => i.href)).toEqual([
      '/settings/partner',
      '/settings/billing',
      '/settings/ticketing',
      '/settings/users',
      '/integrations',
      '/settings/ai',
      '/settings',
    ]);
    const more = settingsItems().at(-1)!;
    expect(more.labelKey).toBe('nav.moreSettings');
    expect(more.requiredPermission).toBeUndefined();
    expect(more.partnerScopeOnly).toBeUndefined();
  });

  it('every sidebar entry is a catalogue entry with identical gates (never disagree)', () => {
    const catalogByHref = new Map(SETTINGS_CATALOG.map((e) => [e.href, e]));
    const gate = (x: Record<string, unknown>) => ({
      p: x.partnerScopeOnly, r: x.requiredPermission, t: x.requiresToolSources, m: x.requiresModule, a: x.platformAdminOnly,
    });
    for (const item of settingsItems().filter((i) => i.href !== '/settings')) {
      const entry = catalogByHref.get(item.href);
      expect(entry, `${item.href} missing from catalogue`).toBeDefined();
      expect(gate(item as unknown as Record<string, unknown>)).toEqual(gate(entry as unknown as Record<string, unknown>));
      expect(SIDEBAR_SETTINGS_IDS).toContain(entry!.id);
    }
  });

  it('catalogue gates match every other sidebar item that links to the same href', () => {
    const gate = (x: Record<string, unknown>) => ({
      p: x.partnerScopeOnly, r: x.requiredPermission, t: x.requiresToolSources, m: x.requiresModule, a: x.platformAdminOnly,
    });
    const byHref = new Map(SETTINGS_CATALOG.map((e) => [e.href, e]));
    const all = [...navSections.flatMap((sec) => sec.items), ...topLevelNav].filter((i) => byHref.has(i.href));
    expect(all.length).toBeGreaterThan(5);
    for (const item of all) {
      expect(gate(item as unknown as Record<string, unknown>), item.href).toEqual(
        gate(byHref.get(item.href) as unknown as Record<string, unknown>),
      );
    }
  });

  it('carries every item the issue moves out of the sidebar', () => {
    const hrefs = SETTINGS_CATALOG.map((e) => e.href);
    for (const h of [
      '/settings/roles', '/settings/sso', '/settings/access-reviews', '/settings/enrollment-keys',
      '/settings/custom-fields', '/settings/variables', '/settings/filters',
    ]) expect(hrefs).toContain(h);
  });

  // W04 (#10135): Settings → AI is a hub page, reached from the sidebar only.
  it('the Settings → AI hub is a sidebar-only entry gated on ai_sessions:use', () => {
    expect(SETTINGS_CATALOG.find((e) => e.id === 'ai')).toMatchObject({
      name: 'AI',
      labelKey: 'nav.sectionAi',
      href: '/settings/ai',
      group: 'ai',
      sidebarOnly: true,
      requiredPermission: { resource: 'ai_sessions', action: 'use' },
    });
    expect(SIDEBAR_SETTINGS_IDS.indexOf('ai')).toBe(SIDEBAR_SETTINGS_IDS.indexOf('integrations') + 1);
    // Only the hub is sidebar-only; every real settings screen still gets a card.
    expect(SETTINGS_CATALOG.filter((e) => e.sidebarOnly).map((e) => e.id)).toEqual(['ai']);
  });

  it('lists Knowledge sources in the AI group, shown only when the workspace extension is loaded', () => {
    const entry = SETTINGS_CATALOG.find((e) => e.id === 'knowledge-sources');
    expect(entry).toMatchObject({
      name: 'Knowledge sources',
      labelKey: 'nav.aiKnowledgeSources',
      href: '/extensions/workspace/sources',
      group: 'ai',
      requiresExtension: 'workspace',
    });
    const ctx: NavGateContext = {
      isPlatformAdmin: false,
      permissions: [{ resource: '*', action: '*' }] as unknown as NavGateContext['permissions'],
      getScope: () => 'partner',
      toolSourcesEnabled: true,
      aiForOfficeEnabled: true,
      wispEnabled: true,
      serviceManagementMode: 'native',
    };
    expect(isNavGateVisible(entry!, ctx)).toBe(false); // registry not read ⇒ hidden
    expect(isNavGateVisible(entry!, { ...ctx, loadedExtensions: [] })).toBe(false);
    expect(isNavGateVisible(entry!, { ...ctx, loadedExtensions: ['other-ext'] })).toBe(false);
    expect(isNavGateVisible(entry!, { ...ctx, loadedExtensions: ['other-ext', 'workspace'] })).toBe(true);
  });
});
