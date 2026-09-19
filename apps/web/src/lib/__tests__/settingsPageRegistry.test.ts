import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(__dirname, '../..');
const SETTINGS_PAGES_DIR = join(WEB_SRC, 'pages/settings');
const SIDEBAR_PATH = join(WEB_SRC, 'components/layout/Sidebar.tsx');
// There is no standalone `SettingsIndexPage.tsx` component in this codebase —
// the settings landing page's links live directly in `pages/settings/index.astro`.
// The account-menu links (profile/api-keys/partner-service-principals) live in
// the header dropdown, not the Settings sidebar section. Both are legitimate,
// pre-existing reachability sources this guard must also recognize.
const SETTINGS_INDEX_PATH = join(WEB_SRC, 'pages/settings/index.astro');
const HEADER_PATH = join(WEB_SRC, 'components/layout/Header.tsx');

// Every entry here is a filed, justified exception — not a place to silence a
// new orphan. Add an entry only with a one-line reason.
const ALLOWLIST: Record<string, string> = {
  // Base org settings route; children are linked from the org list, not the sidebar.
  'organizations/[id].astro': 'dynamic org detail route, reached from /organizations',
  'organizations/index.astro': 'listed directly in the Settings sidebar as Organizations',
  // The settings landing page itself — reached by navigating to /settings,
  // not by a link *inside* Sidebar/index/Header (self-referential).
  'index.astro': 'the settings index/landing page itself, not a link target',
  // Reached from the Alerts feature (AlertTemplateList.tsx breadcrumb/nav), not
  // from the Settings nav surfaces this guard scans — pre-existing, out of
  // scope for the billing/ticketing settings consolidation wave.
  'alert-templates/index.astro': 'reached via the Alerts feature (AlertTemplateList.tsx), not Settings nav',
  'alert-templates/[id].astro': 'reached via the Alerts feature (AlertTemplateEditor.tsx), not Settings nav',
};

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else if (entry.endsWith('.astro')) out.push(relative(base, full));
  }
  return out;
}

function isRedirectOnly(fullPath: string): boolean {
  const src = readFileSync(fullPath, 'utf-8');
  return /Astro\.redirect\(/.test(src);
}

describe('every pages/settings/** page is reachable (M9)', () => {
  const sidebarSrc = readFileSync(SIDEBAR_PATH, 'utf-8');
  const settingsIndexSrc = readFileSync(SETTINGS_INDEX_PATH, 'utf-8');
  const headerSrc = readFileSync(HEADER_PATH, 'utf-8');

  const pages = walk(SETTINGS_PAGES_DIR);

  it.each(pages)('%s is linked, redirected, or allowlisted', (relPath) => {
    if (ALLOWLIST[relPath]) return; // documented exception
    const fullPath = join(SETTINGS_PAGES_DIR, relPath);
    if (isRedirectOnly(fullPath)) return; // (c) redirect

    // Route as it would appear in an href: strip the trailing /index.astro or
    // a bare top-level index.astro, or the .astro extension, and any dynamic segment.
    const routeSuffix = relPath
      .replace(/(^|\/)index\.astro$/, '')
      .replace(/\.astro$/, '')
      .replace(/\[[^\]]+\]/g, '');
    const routeFragment = `/settings/${routeSuffix}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');

    const inSidebar = sidebarSrc.includes(routeFragment);
    const inIndex = settingsIndexSrc.includes(routeFragment);
    const inHeader = headerSrc.includes(routeFragment);
    expect(
      inSidebar || inIndex || inHeader,
      `${relPath} (route ~ "${routeFragment}") is not in Sidebar.tsx, not in ` +
        `pages/settings/index.astro, not in Header.tsx, not a redirect, and not ` +
        `in the ALLOWLIST above. Add a nav entry, a redirect, or a justified ` +
        `allowlist line.`
    ).toBe(true);
  });
});
