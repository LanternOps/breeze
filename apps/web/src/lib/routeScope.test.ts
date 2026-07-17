import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getRouteScope, isGlobalScopeRoute, ROUTE_SCOPES } from './routeScope';

describe('isGlobalScopeRoute', () => {
  it('treats the script library, new, and detail routes as global', () => {
    expect(isGlobalScopeRoute('/scripts')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/new')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/abc-123')).toBe(true);
  });
  it('treats patch surfaces as org-scoped so the switcher applies (single-org actions need an explicit orgId)', () => {
    expect(isGlobalScopeRoute('/patches')).toBe(false);
    expect(isGlobalScopeRoute('/patches/anything')).toBe(false);
  });
  it('treats alert templates as global', () => {
    expect(isGlobalScopeRoute('/alert-templates')).toBe(true);
  });
  it('treats the settings alert-template catalog (list/new/edit) as global (#1425)', () => {
    expect(isGlobalScopeRoute('/settings/alert-templates')).toBe(true);
    expect(isGlobalScopeRoute('/settings/alert-templates/new')).toBe(true);
    expect(isGlobalScopeRoute('/settings/alert-templates/abc-123')).toBe(true);
  });
  it('treats script execution history as org-scoped (exception)', () => {
    // Execution history lives at /scripts/:id/executions (not /scripts/executions)
    expect(isGlobalScopeRoute('/scripts/abc-123/executions')).toBe(false);
  });
  it('treats device/state routes as scoped', () => {
    expect(isGlobalScopeRoute('/')).toBe(false);
    expect(isGlobalScopeRoute('/devices')).toBe(false);
    expect(isGlobalScopeRoute('/alerts')).toBe(false);
  });
});

describe('getRouteScope', () => {
  it('classifies the load-bearing kinds', () => {
    expect(getRouteScope('/')).toBe('org-or-all');
    expect(getRouteScope('/devices')).toBe('org-or-all');
    expect(getRouteScope('/patches')).toBe('org-or-all');
    expect(getRouteScope('/scripts/abc/executions')).toBe('org-or-all');
    expect(getRouteScope('/scripts')).toBe('catalog');
    expect(getRouteScope('/settings/alert-templates')).toBe('catalog');
    expect(getRouteScope('/discovery')).toBe('org-required');
    expect(getRouteScope('/monitoring')).toBe('org-required');
    expect(getRouteScope('/settings/organizations')).toBe('partner-settings');
    expect(getRouteScope('/settings/organizations/abc-123')).toBe('org-required');
    expect(getRouteScope('/settings/users')).toBe('partner-settings');
    expect(getRouteScope('/integrations')).toBe('partner-settings');
    expect(getRouteScope('/remote/terminal/dev-1')).toBe('device');
    expect(getRouteScope('/settings/profile')).toBe('self');
    expect(getRouteScope('/admin/quarantined')).toBe('platform');
    expect(getRouteScope('/login')).toBe('auth');
  });

  it('returns null for routes outside the registry', () => {
    expect(getRouteScope('/definitely-not-a-page')).toBeNull();
  });
});

// Contract: every real page in src/pages must classify to a kind. A new page
// that is not registered here fails this test — declare its scope in
// routeScope.ts (see the kind definitions there) instead of letting the page
// invent its own relationship with the org switcher.
describe('routeScope contract — every page is registered', () => {
  const pagesDir = join(__dirname, '..', 'pages');

  function collectAstroFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectAstroFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.astro')) out.push(full);
    }
    return out;
  }

  // src/pages/devices/[id].astro -> /devices/abc123 ; index.astro -> parent path
  function fileToRoute(file: string): string {
    let route = relative(pagesDir, file).split(sep).join('/');
    route = route.replace(/\.astro$/, '');
    route = route.replace(/(^|\/)index$/, '');
    route = route.replace(/\[[^\]]+\]/g, 'abc123');
    return `/${route}`.replace(/\/+$/, '') || '/';
  }

  const routes = collectAstroFiles(pagesDir).map((f) => ({ file: relative(pagesDir, f), route: fileToRoute(f) }));

  it('found the pages directory (sanity)', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it.each(routes)('$file ($route) has a declared scope', ({ route }) => {
    expect(getRouteScope(route)).not.toBeNull();
  });

  // Reachability / shadowing check: every ROUTE_SCOPES entry must be the FIRST
  // match for at least one real page — otherwise it is dead (matches nothing) or
  // shadowed (a broader prefix placed before it always wins), which is exactly
  // what a mis-ordered narrow exception looks like. Patterns that intentionally
  // cover routes with no static .astro page (client-routed, redirect stubs,
  // synthetic error pages) are allowlisted below with a reason.
  const PAGELESS_PATTERN_ALLOWLIST: Array<{ source: string; reason: string }> = [
    { source: /^\/account\/inactive$/.source, reason: 'suspended-account interstitial, not a static page' },
    { source: /^\/remote(\/.*)?$/.source, reason: 'remote surfaces are client-routed from device detail' },
    { source: /^\/(login|register|register-partner|forgot-password|reset-password|accept-invite|setup|auth|404|500)(\/.*)?$/.source, reason: 'auth flows + synthetic 404/500 error pages' },
    { source: /^\/oauth(\/.*)?$/.source, reason: 'OAuth callback routes are API-handled, not pages' },
    { source: /^\/alert-templates(\/.*)?$/.source, reason: 'legacy top-level catalog route (moved under /settings/alert-templates, #1425); kept for classifier back-compat — see the isGlobalScopeRoute test above' },
  ];
  const allowed = new Set(PAGELESS_PATTERN_ALLOWLIST.map((a) => a.source));

  it('every registry pattern is reachable (no dead or shadowed entries)', () => {
    const reached = new Set<number>();
    for (const { route } of routes) {
      const idx = ROUTE_SCOPES.findIndex(({ pattern }) => pattern.test(route.replace(/\/+$/, '') || '/'));
      if (idx >= 0) reached.add(idx);
    }
    const unreachable = ROUTE_SCOPES
      .map(({ pattern }, i) => ({ source: pattern.source, i }))
      .filter(({ source, i }) => !reached.has(i) && !allowed.has(source))
      .map(({ source }) => source);
    expect(unreachable).toEqual([]);
  });
});
