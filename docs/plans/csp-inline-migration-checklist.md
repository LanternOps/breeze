# CSP Inline Migration Checklist (Web + Portal)

Generated: 2026-02-21

## Scope
- `/Users/toddhebebrand/breeze/apps/web`
- `/Users/toddhebebrand/breeze/apps/portal`

## Current finding summary
- Inline `<script>` elements in source: **1**
- Inline `<style>` elements in source: **2**
- Inline style attributes / React style props: **75**
- Files with inline style props: **48**

Raw inventories:
- `/Users/toddhebebrand/breeze/docs/plans/csp-inline-script-elements.txt`
- `/Users/toddhebebrand/breeze/docs/plans/csp-inline-style-elements.txt`
- `/Users/toddhebebrand/breeze/docs/plans/csp-inline-style-attributes.txt`
- `/Users/toddhebebrand/breeze/docs/plans/csp-inline-style-attributes-by-file.txt`
- `/Users/toddhebebrand/breeze/docs/plans/csp-astro-runtime-inline-evidence.txt`

## Blocking items before strict CSP
These must be addressed before disabling `unsafe-inline` in production.

1. Source inline script:
- `/Users/toddhebebrand/breeze/apps/portal/src/pages/index.astro:12`

2. Source inline style elements:
- `/Users/toddhebebrand/breeze/apps/web/src/components/devices/DeviceCompare.tsx:476`
- `/Users/toddhebebrand/breeze/apps/web/src/components/reports/ReportBuilderPage.tsx:157`

3. Framework runtime inline bootstrap (Astro SSR):
- `/Users/toddhebebrand/breeze/apps/web/dist/server/chunks/astro/server_BmshY0cd.mjs:982`
- `/Users/toddhebebrand/breeze/apps/web/dist/server/chunks/astro/server_BmshY0cd.mjs:984`
- `/Users/toddhebebrand/breeze/apps/web/dist/server/chunks/astro/server_BmshY0cd.mjs:1861`

Note: even after removing source inline script/style, Astro SSR currently emits inline script/style for island bootstrapping, so strict CSP requires nonce/hash-aware integration for framework output.

## Highest-volume style-prop files
Prioritize these first to reduce most `style=` usage quickly:
- `/Users/toddhebebrand/breeze/apps/web/src/components/discovery/NetworkTopologyMap.tsx` (6)
- `/Users/toddhebebrand/breeze/apps/web/src/components/settings/BrandingEditor.tsx` (5)
- `/Users/toddhebebrand/breeze/apps/web/src/components/security/SecurityDashboard.tsx` (5)
- `/Users/toddhebebrand/breeze/apps/web/src/components/reports/DashboardWidgets.tsx` (4)
- `/Users/toddhebebrand/breeze/apps/web/src/components/reports/ReportBuilder.tsx` (3)

## Phased rollout

### Phase 0 (stability)
- [ ] Keep production working with:
  - `CSP_ALLOW_UNSAFE_INLINE_SCRIPT=true`
  - `CSP_ALLOW_UNSAFE_INLINE_STYLE=true`

### Phase 1 (source cleanup)
- [ ] Remove source inline `<script>` from `portal/index.astro`.
- [ ] Replace source inline `<style>` usages in `DeviceCompare.tsx` and report export HTML path.
- [ ] Refactor style props where possible to class/CSS variables.

### Phase 2 (framework compatibility)
- [ ] Implement nonce/hash support for Astro-generated inline bootstrap scripts/styles.
- [ ] Ensure CSP header uses those nonces/hashes on every response.
- [ ] Verify login and all `client:load` pages no longer trigger CSP violations.

### Phase 3 (tighten production policy)
- [ ] Turn off `CSP_ALLOW_UNSAFE_INLINE_SCRIPT` in production.
- [ ] Turn off `CSP_ALLOW_UNSAFE_INLINE_STYLE` in production.
- [ ] Monitor browser CSP reports and error logs for regressions.

## Acceptance criteria
- No browser console CSP violations on `/login` or portal login routes in production mode.
- No `unsafe-inline` in production CSP headers.
- All critical flows (auth, dashboard, reports, portal pages) load and hydrate correctly.
