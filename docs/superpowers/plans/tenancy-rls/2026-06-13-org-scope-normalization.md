# Org-Scope Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make catalog scope an explicit, visible property of each record (partner-wide / org-specific / system), make the org selector page-aware, close the RLS gap that partner-wide (`org_id NULL`) records open, and make scope legible + safe at the point of action (page-header scope indicator, record scope badges, and scope-naming confirmations on fleet actions) — without new architecture or a nav re-org.

**Architecture:** A new `partner_id` axis + dual-axis RLS on the catalog tables (`scripts`, `script_categories`, `script_tags`, `alert_templates`) so "available to all my orgs" is tenant-safe. A single `routeScope` map in the web app drives a page-aware org-id provider (global routes inject no `orgId`; scoped routes inject the selected org), replacing the Current/All pill. Patch approvals/compliance derive their org from the selected update ring (backend logic preserved from the prior branch work).

**Tech Stack:** Hono + Drizzle + Postgres RLS (API), hand-written idempotent SQL migrations, Vitest (API unit + RLS integration), Astro + React islands + Zustand (web), Vitest + jsdom (web).

**Spec:** `docs/superpowers/specs/tenancy-rls/2026-06-13-org-scope-normalization-design.md`

**Env note:** prefix Node commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (repo pins Node 22.20.0; default Node breaks pnpm engine-strict).

---

## File structure

**API — created:**
- `apps/api/migrations/2026-06-13-catalog-partner-axis-rls.sql` — add `partner_id`, backfill, dual-axis RLS on the four catalog tables.

**API — modified:**
- `apps/api/src/db/schema/scripts.ts` — add `partnerId` to `scripts`, `scriptCategories`, `scriptTags`.
- `apps/api/src/db/schema/alerts.ts` — add `partnerId` to `alertTemplates`.
- `apps/api/src/routes/scripts.ts` — partner-wide create; list union (org ∪ partner ∪ system); edit/delete guard.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — allowlist the four tables; add functional cross-partner forge test.
- `apps/api/src/routes/scripts.test.ts` — list/create/guard unit tests.

**Web — created:**
- `apps/web/src/lib/routeScope.ts` — single source of truth for global vs scoped routes.
- `apps/web/src/lib/routeScope.test.ts` — unit tests.
- `apps/web/src/components/shared/ScopeBadge.tsx` (+ test) — record audience badge (partner-wide / org / system).
- `apps/web/src/components/layout/PageScopeIndicator.tsx` (+ test) — page-header scope affordance.
- `apps/web/src/lib/scopeConfirmMessage.ts` (+ test) — scope-naming message for fleet-action confirmations.

**Web — modified:**
- `apps/web/src/stores/orgStore.ts` — remove `orgScope`; page-aware provider.
- `apps/web/src/components/layout/OrgSwitcher.tsx` — remove `OrgScopePill`; fold "All Organizations" into the dropdown; page-aware display.
- `apps/web/src/components/layout/OrgSwitcher.test.tsx` — drop pill tests; add dropdown/page-aware tests.
- `apps/web/src/components/scripts/ScriptForm.tsx` + `ScriptEditPage.tsx` — "Available to" picker on create.

**Preserved from prior branch work (not rewritten):** `apps/api/src/routes/patches/*`, `apps/api/src/routes/updateRings.ts` and their tests (ring-org resolution).

---

## Phase 0 — Reset working tree to a clean, deterministic baseline

### Task 0: Preserve Codex changes, reset web, keep backend ring-resolution

**Files:** none created; git operations only.

- [ ] **Step 1: Confirm the current dirty state**

Run: `cd /Users/toddhebebrand/breeze && git status --short | wc -l && git branch --show-current`
Expected: ~33 modified files; branch `fix/org-scope-normalization`.

- [ ] **Step 2: Preserve everything to a stash (full backup, retrievable)**

```bash
git stash push -u -m "codex-org-scope-wip-2026-06-13"
git stash list   # confirm stash@{0} exists
git status --short   # expected: clean (working tree now == HEAD)
```

- [ ] **Step 3: Restore ONLY the backend ring-resolution files from the stash**

```bash
git checkout stash@{0} -- \
  apps/api/src/routes/patches \
  apps/api/src/routes/updateRings.ts \
  apps/api/src/routes/updateRings_list_create.test.ts \
  apps/api/src/routes/updateRings_patches_compliance_scope.test.ts
git status --short
```
Expected: only the `apps/api/src/routes/patches/*` and `updateRings*` files show as modified; all web files and schemas are back at HEAD.

- [ ] **Step 4: Sanity-check the kept backend compiles**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec tsc --noEmit 2>&1 | tail -20`
Expected: no NEW errors in `patches/` or `updateRings.ts` (pre-existing errors in `agents.test.ts`/`apiKeyAuth.test.ts` are known and acceptable).

- [ ] **Step 5: Commit the preserved backend as the starting point**

```bash
git add apps/api/src/routes/patches apps/api/src/routes/updateRings.ts \
  apps/api/src/routes/updateRings_list_create.test.ts \
  apps/api/src/routes/updateRings_patches_compliance_scope.test.ts
git commit -m "refactor(patches): derive approval/compliance org from selected ring

Preserved ring-org resolution from prior branch work; the shell org
selector no longer narrows patch surfaces (they are global)."
```

> The stash remains as a backup of the discarded web approach. Do not drop it until the feature is merged.

---

## Phase 1 — Page-aware org selector (replaces the Current/All pill)

### Task 1: `routeScope` map + tests

**Files:**
- Create: `apps/web/src/lib/routeScope.ts`
- Test: `apps/web/src/lib/routeScope.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/lib/routeScope.test.ts
import { describe, it, expect } from 'vitest';
import { isGlobalScopeRoute } from './routeScope';

describe('isGlobalScopeRoute', () => {
  it('treats the script library, new, and detail routes as global', () => {
    expect(isGlobalScopeRoute('/scripts')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/new')).toBe(true);
    expect(isGlobalScopeRoute('/scripts/abc-123')).toBe(true);
  });

  it('treats patch surfaces as global (org comes from the ring)', () => {
    expect(isGlobalScopeRoute('/patches')).toBe(true);
    expect(isGlobalScopeRoute('/patches/anything')).toBe(true);
  });

  it('treats alert templates as global', () => {
    expect(isGlobalScopeRoute('/alert-templates')).toBe(true);
  });

  it('treats script execution history as org-scoped (exception)', () => {
    expect(isGlobalScopeRoute('/scripts/executions')).toBe(false);
  });

  it('treats device/state routes as scoped', () => {
    expect(isGlobalScopeRoute('/')).toBe(false);
    expect(isGlobalScopeRoute('/devices')).toBe(false);
    expect(isGlobalScopeRoute('/alerts')).toBe(false);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/lib/routeScope.test.ts`
Expected: FAIL — `Cannot find module './routeScope'`.

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/lib/routeScope.ts
//
// Single source of truth for which routes are partner-wide ("global") catalog
// surfaces vs per-org ("scoped") state surfaces. Global routes ignore the org
// selector entirely: fetchWithAuth omits the orgId param and the selector
// renders "All Organizations". To classify a new page, add its pattern here —
// no other file needs to change.

const GLOBAL_ROUTE_PATTERNS: RegExp[] = [
  /^\/scripts(\/.*)?$/, // script library / new / detail+edit
  /^\/patches(\/.*)?$/, // approvals + compliance derive org from the selected ring
  /^\/alert-templates(\/.*)?$/,
];

// Routes that share a global prefix but are genuinely per-org state.
const SCOPED_EXCEPTIONS: RegExp[] = [
  /^\/scripts\/executions(\/.*)?$/, // execution history is device/org state
];

export function isGlobalScopeRoute(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (SCOPED_EXCEPTIONS.some((re) => re.test(normalized))) return false;
  return GLOBAL_ROUTE_PATTERNS.some((re) => re.test(normalized));
}
```

- [ ] **Step 4: Verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/lib/routeScope.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the executions route path is correct**

Run: `cd /Users/toddhebebrand/breeze && ls apps/web/src/pages/scripts/ && grep -rn "ScriptExecutionsPage" apps/web/src/pages/`
If the executions page is NOT at `/scripts/executions`, update the `SCOPED_EXCEPTIONS` regex (and the test) to its real path. If executions live under a different top-level route entirely (e.g. `/scripts` tab via hash), no exception is needed — remove it and its test.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/routeScope.ts apps/web/src/lib/routeScope.test.ts
git commit -m "feat(web): routeScope map — single source of truth for global vs org-scoped pages"
```

### Task 2: Make the org-id provider page-aware; remove `orgScope`

**Files:**
- Modify: `apps/web/src/stores/orgStore.ts`

- [ ] **Step 1: Update the provider registration (bottom of file, ~lines 246-250)**

Replace the existing `registerOrgIdProvider(...)` call:

```typescript
// BEFORE
registerOrgIdProvider(() =>
  useOrgStore.getState().orgScope === 'all'
    ? null
    : useOrgStore.getState().currentOrgId
);
```

with:

```typescript
import { isGlobalScopeRoute } from '../lib/routeScope';

// Page-aware org scoping: on a global (catalog) route the selector does not
// apply, so inject no orgId; on a scoped route inject the selected org. The
// pathname is read at call time so it tracks Astro client-side navigation.
registerOrgIdProvider(() => {
  if (typeof window !== 'undefined' && isGlobalScopeRoute(window.location.pathname)) {
    return null;
  }
  return useOrgStore.getState().currentOrgId;
});
```

(Place the `import` with the other imports at the top of the file.)

- [ ] **Step 2: Remove the `orgScope` concept from the store**

In `apps/web/src/stores/orgStore.ts`:
- Delete the `export type OrgScope = 'current' | 'all';` line.
- Remove `orgScope: OrgScope;` from the `OrgState` interface and `setOrgScope: (scope: OrgScope) => void;`.
- Remove `orgScope: 'current',` from the initial state and the entire `setOrgScope` action implementation.
- Remove `orgScope: state.orgScope` from the `partialize` object.

- [ ] **Step 3: Verify the store still type-checks (will reveal remaining `orgScope` references)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec tsc --noEmit 2>&1 | grep -i "orgScope\|OrgScope" | head`
Expected: errors ONLY in `OrgSwitcher.tsx` (handled in Task 3). If any other file references `orgScope`/`setOrgScope`/`OrgScope`, note it for cleanup in Task 3's step.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/stores/orgStore.ts
git commit -m "feat(web): page-aware org-id provider; drop orgScope toggle state"
```

### Task 3: Remove the pill; fold "All Organizations" into the dropdown

**Files:**
- Modify: `apps/web/src/components/layout/OrgSwitcher.tsx`
- Test: `apps/web/src/components/layout/OrgSwitcher.test.tsx`

- [ ] **Step 1: Write/adjust the failing test**

Replace the pill-centric tests in `OrgSwitcher.test.tsx` with behavior tests for the unified control. Add:

```typescript
it('renders an "All Organizations" item at the top of the dropdown', async () => {
  // render OrgSwitcher with >1 org in the store (reuse existing render helper)
  // open the dropdown
  const allItem = await screen.findByTestId('org-option-all');
  expect(allItem).toBeInTheDocument();
  expect(allItem).toHaveTextContent(/all organizations/i);
});

it('does not render the legacy scope pill', () => {
  expect(screen.queryByTestId('org-scope-pill')).not.toBeInTheDocument();
});

it('shows "All Organizations" as the trigger label on a global route', () => {
  // set window.location.pathname to /scripts before render
  expect(screen.getByTestId('org-switcher-label')).toHaveTextContent(/all organizations/i);
});
```

Match the existing test file's render helpers and store-seeding pattern (read the current file first). Keep any unrelated existing passing tests.

- [ ] **Step 2: Verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/layout/OrgSwitcher.test.tsx`
Expected: FAIL — pill still present / no `org-option-all` item.

- [ ] **Step 3: Delete the `OrgScopePill` component and its render site**

In `OrgSwitcher.tsx`:
- Delete the entire `function OrgScopePill() { ... }` (HEAD ~line 175) and its `<OrgScopePill />` usage (~line 362).
- Remove now-unused imports (`Globe`, `Loader2` if only used there, `stashSwitchToast`/`waitForPendingRefresh` if only the pill used them — verify with grep before removing).

- [ ] **Step 4: Add a page-aware pathname hook and fold "All Organizations" into the trigger + dropdown**

Add near the top of the component module:

```typescript
function useCurrentPathname(): string {
  const [pathname, setPathname] = useState(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname
  );
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    document.addEventListener('astro:after-swap', update);
    window.addEventListener('popstate', update);
    return () => {
      document.removeEventListener('astro:after-swap', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return pathname;
}
```

Inside the `OrgSwitcher` component, replace the `orgScope`-based display logic (HEAD ~line 352) with route-aware logic:

```typescript
import { isGlobalScopeRoute } from '../../lib/routeScope';

const pathname = useCurrentPathname();
const isGlobalRoute = isGlobalScopeRoute(pathname);

// On a global (catalog) route the selector never narrows — show the
// partner-wide label. Otherwise reflect the chosen org/site.
const displayText = isGlobalRoute
  ? 'All Organizations'
  : currentOrg
    ? currentSite
      ? `${currentOrg.name} / ${currentSite.name}`
      : currentOrg.name
    : 'Select Organization';
```

Give the trigger label `data-testid="org-switcher-label"`. In the dropdown list, add a top item BEFORE the org list:

```tsx
<button
  type="button"
  data-testid="org-option-all"
  onClick={() => {
    useOrgStore.getState().setOrganization('');      // clear selection => "all"
    const redirect = getOrgSwitchRedirect(window.location.pathname);
    if (redirect) window.location.href = redirect; else window.location.reload();
  }}
  className={cn('w-full px-3 py-2 text-left text-sm hover:bg-muted', !currentOrgId && 'font-medium')}
>
  All Organizations
</button>
```

> `setOrganization('')` must clear `currentOrgId` to `null`. If the current `setOrganization` does not handle an empty string, add a guard so `''` clears the selection (and clears `currentSiteId`). Verify by reading the action.

- [ ] **Step 5: De-emphasise the selector visually on global routes (optional polish)**

When `isGlobalRoute` is true, you may keep the dropdown interactive (so the user can pre-pick an org for navigation) but render the trigger with `opacity-70` and a title "This page shows all organizations". Do not disable it.

- [ ] **Step 6: Run tests and type-check**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/layout/OrgSwitcher.test.tsx
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec tsc --noEmit 2>&1 | grep -i "orgScope\|OrgScope\|OrgSwitcher" | head
```
Expected: tests PASS; no remaining `orgScope` type errors anywhere.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/layout/OrgSwitcher.tsx apps/web/src/components/layout/OrgSwitcher.test.tsx
git commit -m "feat(web): unify org selector — All Organizations in dropdown, remove scope pill"
```

> **Phase 1 checkpoint:** the selector is page-aware and pill-free. Catalog pages (`/scripts`, `/patches`) no longer narrow; device pages still honor the selection. This is independently shippable.

---

## Phase 2 — Partner-axis schema + dual-axis RLS (closes the gap)

### Task 4: Add `partnerId` to the catalog schema definitions

**Files:**
- Modify: `apps/api/src/db/schema/scripts.ts`
- Modify: `apps/api/src/db/schema/alerts.ts`

- [ ] **Step 1: Add `partnerId` to `scripts`, `scriptCategories`, `scriptTags`**

In `apps/api/src/db/schema/scripts.ts`, add to each of the three table definitions (next to the existing `orgId` column):

```typescript
  partnerId: uuid('partner_id').references(() => partners.id),
```

Add the import if missing: `import { partners } from './orgs';` (verify the partners table export path — it is `apps/api/src/db/schema/orgs.ts`). Add a partner index to `scriptCategories`/`scriptTags` index blocks if other tables in the file index `partnerId`; otherwise leave indexes as-is.

- [ ] **Step 2: Add `partnerId` to `alertTemplates`**

In `apps/api/src/db/schema/alerts.ts`, add next to `orgId` in the `alertTemplates` table:

```typescript
  partnerId: uuid('partner_id').references(() => organizations.id),
```

Wait — reference `partners`, not `organizations`. Add `import { partners } from './orgs';` (the file already imports `organizations` from `./orgs`; extend the import: `import { organizations, partners } from './orgs';`) and use:

```typescript
  partnerId: uuid('partner_id').references(() => partners.id),
```

- [ ] **Step 3: Type-check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec tsc --noEmit 2>&1 | grep -iE "scripts.ts|alerts.ts|partner" | head`
Expected: no new errors referencing these files.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/scripts.ts apps/api/src/db/schema/alerts.ts
git commit -m "feat(db): add partner_id to scripts/script_categories/script_tags/alert_templates"
```

### Task 5: Write the migration (column + backfill + dual-axis RLS)

**Files:**
- Create: `apps/api/migrations/2026-06-13-catalog-partner-axis-rls.sql`

- [ ] **Step 1: Enumerate existing RLS policy names on the four tables (so we DROP the right ones)**

Run (requires local DB up):
```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c \
"SELECT tablename, polname FROM pg_policies WHERE tablename IN ('scripts','script_categories','script_tags','alert_templates') ORDER BY 1,2;"
```
Note the exact policy names. The migration below `DROP POLICY IF EXISTS` the conventional names (`breeze_org_isolation_*`); if your DB shows different names (e.g. `breeze_scripts_*`), add `DROP POLICY IF EXISTS <name> ...` lines for them too. `IF EXISTS` makes extra drops harmless.

- [ ] **Step 2: Write the migration**

```sql
-- 2026-06-13-catalog-partner-axis-rls.sql
-- Catalog tables (scripts, script_categories, script_tags, alert_templates)
-- gain a partner_id axis so a record can be "available to all my orgs"
-- (org_id NULL, partner_id set) while staying tenant-isolated. Without
-- partner_id an org_id-NULL row is invisible to its owner AND visible across
-- partners (breeze_has_org_access(NULL)=FALSE) — the custom_field_definitions
-- trap (2026-06-11-i). Convert each table to a dual-axis policy:
--   org access OR partner access [OR system flag, where the table has one].
-- scripts -> is_system; alert_templates -> is_built_in;
-- script_categories/script_tags -> no system flag.
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS, recreate.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file in a transaction).

-- ============================================================
-- 1. Columns
-- ============================================================
ALTER TABLE scripts            ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE script_categories  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE script_tags        ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
ALTER TABLE alert_templates    ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

-- ============================================================
-- 2. Backfill partner_id from the owning org for org-specific rows.
--    System/built-in rows (org_id NULL) keep partner_id NULL.
--    Log counts for the forensic trail (even when 0).
-- ============================================================
DO $$
DECLARE n integer;
BEGIN
  UPDATE scripts s SET partner_id = o.partner_id
    FROM organizations o WHERE s.org_id = o.id AND s.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'backfilled partner_id on % scripts row(s)', n;

  UPDATE script_categories s SET partner_id = o.partner_id
    FROM organizations o WHERE s.org_id = o.id AND s.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'backfilled partner_id on % script_categories row(s)', n;

  UPDATE script_tags s SET partner_id = o.partner_id
    FROM organizations o WHERE s.org_id = o.id AND s.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'backfilled partner_id on % script_tags row(s)', n;

  UPDATE alert_templates s SET partner_id = o.partner_id
    FROM organizations o WHERE s.org_id = o.id AND s.partner_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING 'backfilled partner_id on % alert_templates row(s)', n;
END $$;

-- ============================================================
-- 3. Dual-axis policies. Drop prior org-only policies, recreate.
--    (Add DROP lines for any extra policy names found in Task 5 Step 1.)
-- ============================================================

-- scripts (has is_system)
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.scripts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.scripts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.scripts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.scripts;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.scripts;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.scripts;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.scripts;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.scripts;
ALTER TABLE public.scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scripts FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_dual_axis_select ON public.scripts FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_system);
CREATE POLICY breeze_dual_axis_insert ON public.scripts FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_system);
CREATE POLICY breeze_dual_axis_update ON public.scripts FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_system)
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_system);
CREATE POLICY breeze_dual_axis_delete ON public.scripts FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_system);

-- alert_templates (has is_built_in)
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.alert_templates;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.alert_templates;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.alert_templates;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.alert_templates;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.alert_templates;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.alert_templates;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.alert_templates;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.alert_templates;
ALTER TABLE public.alert_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_dual_axis_select ON public.alert_templates FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_built_in);
CREATE POLICY breeze_dual_axis_insert ON public.alert_templates FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_built_in);
CREATE POLICY breeze_dual_axis_update ON public.alert_templates FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_built_in)
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_built_in);
CREATE POLICY breeze_dual_axis_delete ON public.alert_templates FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id) OR is_built_in);

-- script_categories (no system flag)
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.script_categories;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.script_categories;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_categories;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_categories;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.script_categories;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.script_categories;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.script_categories;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.script_categories;
ALTER TABLE public.script_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.script_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_dual_axis_select ON public.script_categories FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_insert ON public.script_categories FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON public.script_categories FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON public.script_categories FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));

-- script_tags (no system flag)
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.script_tags;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.script_tags;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_tags;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_tags;
DROP POLICY IF EXISTS breeze_dual_axis_select ON public.script_tags;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON public.script_tags;
DROP POLICY IF EXISTS breeze_dual_axis_update ON public.script_tags;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON public.script_tags;
ALTER TABLE public.script_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.script_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY breeze_dual_axis_select ON public.script_tags FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_insert ON public.script_tags FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON public.script_tags FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON public.script_tags FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 3: Apply the migration and verify no drift**

Migrations apply via `autoMigrate` on API boot. First confirm the entrypoint:
```bash
cd /Users/toddhebebrand/breeze && grep -rn "autoMigrate(" apps/api/src --include=*.ts | grep -v test | head
```
Then apply by booting the API once (it runs pending migrations on startup) and watching for the `RAISE WARNING` backfill lines, or invoke whatever script that grep reveals:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api dev 2>&1 | grep -iE "backfilled|2026-06-13-catalog|migration" &
# stop after migrations apply (ctrl-C), then:
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```
Expected: the four `backfilled partner_id on N <table> row(s)` warnings appear; `db:check-drift` reports no drift.

- [ ] **Step 4: Verify idempotency (re-apply is a no-op)**

Re-run the migrate command. Expected: file is skipped (already in `breeze_migrations`) OR re-applies cleanly with no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-13-catalog-partner-axis-rls.sql
git commit -m "feat(db): dual-axis RLS + partner_id backfill for catalog tables"
```

### Task 6: RLS contract allowlist + functional cross-partner forge test

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

- [ ] **Step 1: Add the four tables to `PARTNER_TENANT_TABLES`**

In the `PARTNER_TENANT_TABLES` Map (~line 96), add:

```typescript
  ['scripts', 'partner_id'],
  ['script_categories', 'partner_id'],
  ['script_tags', 'partner_id'],
  ['alert_templates', 'partner_id'],
```

- [ ] **Step 2: Add a functional cross-partner forge test (the dual-axis blind-spot guard)**

Append a new `describe` block modeled on the existing `approval_requests` forge test. It seeds two partners (A, B) and asserts: (a) a partner-wide script created under partner A's context is visible to A, (b) invisible to B, (c) B cannot INSERT a partner-wide script forging A's `partner_id` (rejected by WITH CHECK).

```typescript
describe('scripts RLS — partner-wide cross-partner forge enforcement (dual-axis)', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let partnerAId: string;
  let partnerBId: string;
  let scriptAId: string | null = null;

  async function ensureFixtures(): Promise<void> {
    if (partnerAId) return;
    await withSystemDbAccessContext(async () => {
      const seeded = await db.insert(partners).values([
        { name: `RLS Scripts A ${runSuffix}`, slug: `rls-scripts-a-${runSuffix}`, type: 'msp', plan: 'pro', status: 'active' },
        { name: `RLS Scripts B ${runSuffix}`, slug: `rls-scripts-b-${runSuffix}`, type: 'msp', plan: 'pro', status: 'active' },
      ]).returning({ id: partners.id });
      partnerAId = seeded[0]!.id;
      partnerBId = seeded[1]!.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      if (scriptAId) await db.delete(scripts).where(eq(scripts.id, scriptAId!));
      if (partnerAId) await db.delete(partners).where(eq(partners.id, partnerAId));
      if (partnerBId) await db.delete(partners).where(eq(partners.id, partnerBId));
    });
  });

  function partnerContext(partnerId: string) {
    return { scope: 'partner' as const, orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId: null };
  }

  it('partner A can INSERT and SELECT a partner-wide (org_id NULL) script', async () => {
    await ensureFixtures();
    const inserted = await withDbAccessContext(partnerContext(partnerAId), async () =>
      db.insert(scripts).values({
        orgId: null, partnerId: partnerAId, name: `forge-${runSuffix}`,
        osTypes: ['windows'], language: 'powershell', content: 'echo hi',
      }).returning({ id: scripts.id })
    );
    expect(inserted).toHaveLength(1);
    scriptAId = inserted[0]!.id;

    const visibleToA = await withDbAccessContext(partnerContext(partnerAId), async () =>
      db.select({ id: scripts.id }).from(scripts).where(eq(scripts.id, scriptAId!))
    );
    expect(visibleToA.map((r) => r.id)).toEqual([scriptAId]);
  });

  it('partner B cannot SELECT partner A\'s partner-wide script', async () => {
    await ensureFixtures();
    if (!scriptAId) throw new Error('seed test must run first');
    const visibleToB = await withDbAccessContext(partnerContext(partnerBId), async () =>
      db.select({ id: scripts.id }).from(scripts).where(eq(scripts.id, scriptAId!))
    );
    expect(visibleToB).toEqual([]);
  });

  it('partner B INSERT forging partner A\'s partner_id is rejected by WITH CHECK', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(partnerContext(partnerBId), async () =>
        db.insert(scripts).values({
          orgId: null, partnerId: partnerAId, name: `forge-x-${runSuffix}`,
          osTypes: ['windows'], language: 'powershell', content: 'echo x',
        })
      );
    } catch (err) { caught = err; }
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "scripts"/);
  });
});
```

Ensure `scripts`, `partners`, `withDbAccessContext`, `withSystemDbAccessContext`, `eq` are imported in the test file (the approval test already imports most; add `scripts`).

- [ ] **Step 3: Run the RLS suite (needs real DB)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run -c vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: PASS — contract test accepts the four new partner tables; the three forge assertions pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(rls): allowlist catalog partner tables + cross-partner forge test for scripts"
```

---

## Phase 3 — Scripts route: partner-wide create, list union, edit guard

### Task 7: List union (org ∪ partner-wide ∪ system)

**Files:**
- Modify: `apps/api/src/routes/scripts.ts` (GET `/` handler, ~lines 150-275)
- Test: `apps/api/src/routes/scripts.test.ts`

- [ ] **Step 1: Write the failing test**

In `scripts.test.ts`, add cases (follow the file's existing Drizzle-mock + auth-context harness — read it first):
- partner user list includes rows where `partner_id = auth.partnerId` (org_id NULL), plus accessible-org rows, plus `is_system`.
- org user list includes their org's rows + their partner's partner-wide rows + system.

- [ ] **Step 2: Verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run src/routes/scripts.test.ts`
Expected: FAIL (partner-wide rows not yet in the union).

- [ ] **Step 3: Add the partner-wide branch to each scope's conditions**

In the `organization` scope branch, replace the org/system condition with one that also matches the partner's partner-wide rows:

```typescript
if (auth.scope === 'organization') {
  if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
  const ors = [eq(scripts.orgId, auth.orgId)];
  if (auth.partnerId) ors.push(eq(scripts.partnerId, auth.partnerId));
  if (query.includeSystem === 'true') ors.push(eq(scripts.isSystem, true));
  conditions.push(or(...ors) as ReturnType<typeof eq>);
}
```

In the `partner` scope branch, when no specific `query.orgId` is given, union accessible orgs + partner-wide + (optional) system:

```typescript
} else if (auth.scope === 'partner') {
  if (query.orgId) {
    if (!ensureOrgAccess(query.orgId, auth)) return c.json({ error: 'Access to this organization denied' }, 403);
    const ors = [eq(scripts.orgId, query.orgId)];
    if (auth.partnerId) ors.push(eq(scripts.partnerId, auth.partnerId));
    if (query.includeSystem === 'true') ors.push(eq(scripts.isSystem, true));
    conditions.push(or(...ors) as ReturnType<typeof eq>);
  } else {
    const orgIds = auth.accessibleOrgIds ?? [];
    const ors: ReturnType<typeof eq>[] = [];
    if (orgIds.length > 0) ors.push(inArray(scripts.orgId, orgIds) as ReturnType<typeof eq>);
    if (auth.partnerId) ors.push(eq(scripts.partnerId, auth.partnerId) as ReturnType<typeof eq>);
    if (query.includeSystem === 'true') ors.push(eq(scripts.isSystem, true) as ReturnType<typeof eq>);
    if (ors.length === 0) return c.json({ data: [], pagination: { page, limit, total: 0 } });
    conditions.push(or(...ors) as ReturnType<typeof eq>);
  }
}
```

(`system` scope branch unchanged.) Verify `auth.partnerId` exists on the auth context (read the auth middleware / `c.get('auth')` type). If the property is named differently, use that name.

- [ ] **Step 4: Verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run src/routes/scripts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/scripts.ts apps/api/src/routes/scripts.test.ts
git commit -m "feat(api): scripts list unions org + partner-wide + system records"
```

### Task 8: Partner-wide create + edit/delete guard

**Files:**
- Modify: `apps/api/src/routes/scripts.ts` (POST `/`, PUT `/:id`, DELETE `/:id`)
- Modify: the create Zod schema (find `createScriptSchema`)
- Test: `apps/api/src/routes/scripts.test.ts`

- [ ] **Step 1: Write the failing tests**

- partner user with `availability: 'partner'` creates a script with `org_id NULL`, `partner_id = auth.partnerId`.
- partner user with `availability: 'org'` + `orgId` creates an org-specific script (existing behavior).
- org user editing a partner-wide script (org_id NULL, partner_id set) → 403.

- [ ] **Step 2: Verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run src/routes/scripts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `availability` to `createScriptSchema`**

Locate `createScriptSchema` (top of `scripts.ts` or a shared validators file). Add:

```typescript
  availability: z.enum(['org', 'partner']).optional(),
```

- [ ] **Step 4: Set org_id/partner_id in the POST handler**

Replace the org-resolution block in POST `/` so partner users can create partner-wide scripts:

```typescript
let orgId: string | null = data.orgId ?? null;
let partnerId: string | null = null;

if (auth.scope === 'organization') {
  if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
  orgId = auth.orgId;
  partnerId = auth.partnerId ?? null; // denormalized for RLS
} else if (auth.scope === 'partner') {
  if (data.availability === 'partner') {
    orgId = null;
    partnerId = auth.partnerId ?? null;
    if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
  } else {
    if (!orgId) {
      const singleOrg = auth.accessibleOrgIds?.[0];
      if (auth.accessibleOrgIds?.length === 1 && singleOrg) orgId = singleOrg;
      else return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
    }
    if (!ensureOrgAccess(orgId, auth)) return c.json({ error: 'Access to this organization denied' }, 403);
    partnerId = auth.partnerId ?? null;
  }
}
// system scope: unchanged (may create system scripts)

const isSystem = auth.scope === 'system' ? (data.isSystem ?? false) : false;
```

Then in the `.insert(scripts).values({ ... })` object, set `orgId: isSystem && !orgId ? null : orgId,` (unchanged) and add `partnerId,`.

- [ ] **Step 5: Add the edit/delete guard**

In PUT `/:id` and DELETE `/:id` handlers (read the file to find them), after loading the target `script`, add before mutating:

```typescript
// Partner-wide records belong to the MSP: only partner/system scope may edit/delete.
if (script.orgId === null && script.partnerId !== null && auth.scope === 'organization') {
  return c.json({ error: 'This script is shared across your organization and is read-only here' }, 403);
}
if (script.isSystem && auth.scope !== 'system') {
  return c.json({ error: 'System scripts are read-only' }, 403);
}
```

- [ ] **Step 6: Verify tests pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run src/routes/scripts.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/scripts.ts apps/api/src/routes/scripts.test.ts
git commit -m "feat(api): partner-wide script create + org-user read-only guard on shared scripts"
```

---

## Phase 4 — Scripts create UI: "Available to" picker

### Task 9: Add the availability picker to the script create form

**Files:**
- Modify: `apps/web/src/components/scripts/ScriptForm.tsx`
- Modify: `apps/web/src/components/scripts/ScriptEditPage.tsx`
- Modify: the form schema/type (`ScriptFormSchema.ts`)

- [ ] **Step 1: Add `availability` to the form values type/schema**

In `ScriptFormSchema.ts`, add `availability?: 'org' | 'partner'` to the form values type and (if zod) the schema, defaulting to `'partner'` for new scripts.

- [ ] **Step 2: Render the picker (only for partner-scope users creating a new script)**

In `ScriptForm.tsx`, when `isNew` and the current user is partner-scope with >1 accessible org (read `useAuthStore`/`useOrgStore`), render:

```tsx
<fieldset className="space-y-2">
  <legend className="text-sm font-medium">Available to</legend>
  <label className="flex items-center gap-2 text-sm">
    <input type="radio" value="partner" {...register('availability')} defaultChecked /> All my organizations
  </label>
  <label className="flex items-center gap-2 text-sm">
    <input type="radio" value="org" {...register('availability')} /> A specific organization
  </label>
  {/* when 'org' selected, show the existing org picker bound to `orgId` */}
</fieldset>
```

Single-org users and org-scope users: do not render the picker; the backend forces their org.

- [ ] **Step 3: Send `availability` in the create payload**

In `ScriptEditPage.tsx` `handleSubmit`, change the payload build (HEAD passes `orgId: currentOrgId`):

```typescript
const payload = isNew
  ? values.availability === 'partner'
    ? { ...values, availability: 'partner' }            // org_id resolved to NULL server-side
    : { ...values, availability: 'org', orgId: values.orgId ?? useOrgStore.getState().currentOrgId }
  : values;
```

Keep the create POST going to `/scripts`. (After Phase 1, `/scripts` is a global route so no `orgId` is auto-injected — the body's `availability`/`orgId` is authoritative. The `skipOrgIdInjection` flag is no longer needed; remove it from this call.)

- [ ] **Step 4: Type-check + run web tests**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec tsc --noEmit 2>&1 | grep -i "script" | head
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/scripts
```
Expected: no new errors; script component tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/scripts/
git commit -m "feat(web): 'Available to' picker — create partner-wide or org-specific scripts"
```

---

## Phase 5 — Verify patches surfaces under the new selector

### Task 10: Confirm patches are global and ring-org resolution holds

**Files:**
- Verify (and adjust if needed): `apps/web/src/components/patches/*`, `apps/api/src/routes/patches/*`, `updateRings.ts`

- [ ] **Step 1: Confirm `/patches` is classified global**

`isGlobalScopeRoute('/patches')` is already `true` (Task 1). Confirm `PatchesPage` no longer needs per-call `skipOrgIdInjection` — since `/patches` is a global route, the provider returns null and no `orgId` is injected. Remove any leftover `skipOrgIdInjection: true` in patch components that were re-introduced, relying on the route classification instead.

- [ ] **Step 2: Confirm approvals/compliance derive org from ring**

Read `apps/api/src/routes/patches/compliance.ts` and `approvals.ts` (preserved in Task 0). Confirm `effectiveOrgId` resolves from `ringId` → ring's `org_id` with an `auth.canAccessOrg` check, independent of any shell `orgId`.

- [ ] **Step 3: Run the kept backend tests**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run \
  src/routes/patches/approvals.test.ts src/routes/patches/compliance.test.ts \
  src/routes/updateRings_list_create.test.ts src/routes/updateRings_patches_compliance_scope.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit any adjustments**

```bash
git add -A && git commit -m "fix(web): patches rely on routeScope (no per-call org-skip)" || echo "no changes needed"
```

---

## Phase 6 — Full verification

### Task 11: Builds, focused suites, manual smoke

- [ ] **Step 1: Type-check both apps**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec tsc --noEmit
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec tsc --noEmit 2>&1 | grep -v "agents.test.ts\|apiKeyAuth.test.ts" | tail
```
Expected: clean except the two known pre-existing API test-file errors.

- [ ] **Step 2: Builds**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web build
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api build
```
Expected: both succeed.

- [ ] **Step 3: Focused suites (single-fork, per the parallel-flakiness note)**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/lib/routeScope.test.ts src/components/layout/OrgSwitcher.test.tsx src/components/scripts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run --poolOptions.forks.singleFork src/routes/scripts.test.ts src/routes/patches
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api exec vitest run -c vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: all PASS.

- [ ] **Step 4: Manual smoke as `breeze_app` (cross-partner insert must fail)**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
-- attempt an org-NULL partner-NULL script insert (should violate RLS):
-- INSERT INTO scripts (org_id, partner_id, name, os_types, language, content)
--   VALUES (NULL, NULL, 'x', ARRAY['windows'], 'powershell', 'echo');
-- Expected: ERROR: new row violates row-level security policy for table "scripts"
```

- [ ] **Step 5: Browser smoke**

Start dev (`PUBLIC_API_URL=http://localhost`), log in as a partner user with >1 org:
- `/scripts` shows "All Organizations" in the selector and lists scripts across all orgs + system. No scope pill.
- Create a script with "All my organizations" → it appears regardless of which org is later selected on a scoped page.
- Pick an org → `/devices` narrows; navigate to `/scripts` → selector flips to "All Organizations" automatically.
- `/patches` shows all rings; selecting a ring drives approvals/compliance.

- [ ] **Step 6: Final commit / branch ready**

```bash
git status   # clean
git log --oneline origin/main..HEAD   # review the phased commits
```

---

## Phase 7 — Scope legibility (badges + page-header affordance)

### Task 12: `ScopeBadge` component

**Files:**
- Create: `apps/web/src/components/shared/ScopeBadge.tsx`
- Test: `apps/web/src/components/shared/ScopeBadge.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/shared/ScopeBadge.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ScopeBadge } from './ScopeBadge';

describe('ScopeBadge', () => {
  it('renders Partner-wide for org-NULL + partner-set records', () => {
    render(<ScopeBadge orgId={null} partnerId="p1" isSystem={false} />);
    expect(screen.getByText(/partner-wide/i)).toBeInTheDocument();
  });
  it('renders System for system records', () => {
    render(<ScopeBadge orgId={null} partnerId={null} isSystem />);
    expect(screen.getByText(/system/i)).toBeInTheDocument();
  });
  it('renders the org name for org-scoped records', () => {
    render(<ScopeBadge orgId="o1" partnerId="p1" isSystem={false} orgName="Acme Corp" />);
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/shared/ScopeBadge.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/shared/ScopeBadge.tsx
import { Building2, Globe, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';

// One quiet badge that states a catalog record's audience. Calm, not loud —
// muted surface, brand accent only for the partner-wide case (the one a tech
// most needs to notice: "this is shared across all my customers").
export function ScopeBadge({
  orgId,
  partnerId,
  isSystem,
  orgName,
  className,
}: {
  orgId: string | null;
  partnerId: string | null;
  isSystem: boolean;
  orgName?: string;
  className?: string;
}) {
  let icon = <Building2 className="h-3 w-3" />;
  let label = orgName ?? 'Organization';
  let tone = 'bg-muted text-muted-foreground';

  if (isSystem) {
    icon = <Layers className="h-3 w-3" />;
    label = 'System';
  } else if (orgId === null && partnerId !== null) {
    icon = <Globe className="h-3 w-3" />;
    label = 'Partner-wide';
    tone = 'bg-primary/10 text-primary';
  }

  return (
    <span
      data-testid="scope-badge"
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tone, className)}
    >
      {icon}
      {label}
    </span>
  );
}
```

- [ ] **Step 4: Verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/shared/ScopeBadge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/shared/ScopeBadge.tsx apps/web/src/components/shared/ScopeBadge.test.tsx
git commit -m "feat(web): ScopeBadge — partner-wide / org / system record audience"
```

### Task 13: Wire `ScopeBadge` into the scripts list + edit header

**Files:**
- Modify: `apps/web/src/components/scripts/ScriptsPage.tsx` (list rows)
- Modify: `apps/web/src/components/scripts/ScriptEditPage.tsx` (detail/edit header)

- [ ] **Step 1: Render a `ScopeBadge` per script row**

In the scripts list row (read `ScriptsPage.tsx` to find the row render), add next to the script name:

```tsx
<ScopeBadge orgId={script.orgId} partnerId={script.partnerId} isSystem={script.isSystem}
  orgName={organizations.find((o) => o.id === script.orgId)?.name} />
```

(Import `ScopeBadge`; `organizations` is available via `useOrgStore` — add the selector if not already present. If the script type lacks `partnerId`, extend the script TS type to include it.)

- [ ] **Step 2: Render it in the edit/detail header**

In `ScriptEditPage.tsx`, when editing an existing script, show the same `ScopeBadge` next to the title so the audience stays visible.

- [ ] **Step 3: Verify + commit**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec tsc --noEmit 2>&1 | grep -i script | head
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/scripts
git add apps/web/src/components/scripts/
git commit -m "feat(web): show scope badge on script list rows and edit header"
```

### Task 14: `PageScopeIndicator` — page-header scope affordance

**Files:**
- Create: `apps/web/src/components/layout/PageScopeIndicator.tsx`
- Test: `apps/web/src/components/layout/PageScopeIndicator.test.tsx`
- Modify: page headers for `/scripts`, `/patches` (global) and `/devices` (scoped) as exemplars.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/layout/PageScopeIndicator.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { PageScopeIndicator } from './PageScopeIndicator';

describe('PageScopeIndicator', () => {
  it('says shared across all organizations on a global route', () => {
    render(<PageScopeIndicator pathname="/scripts" orgName="Acme Corp" />);
    expect(screen.getByText(/shared across all organizations/i)).toBeInTheDocument();
  });
  it('shows the active org on a scoped route', () => {
    render(<PageScopeIndicator pathname="/devices" orgName="Acme Corp" />);
    expect(screen.getByText(/acme corp/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/layout/PageScopeIndicator.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/layout/PageScopeIndicator.tsx
import { Globe, Building2 } from 'lucide-react';
import { isGlobalScopeRoute } from '../../lib/routeScope';

// Calm, page-level scope cue. Sits in the page header next to the title so the
// "whose data is this?" answer lives next to the content, not only in the
// far-away top-right switcher.
export function PageScopeIndicator({ pathname, orgName }: { pathname: string; orgName?: string | null }) {
  const global = isGlobalScopeRoute(pathname);
  return (
    <span
      data-testid="page-scope-indicator"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
    >
      {global ? <Globe className="h-3.5 w-3.5" /> : <Building2 className="h-3.5 w-3.5" />}
      {global ? 'Shared across all organizations' : (orgName ?? 'All organizations')}
    </span>
  );
}
```

- [ ] **Step 4: Verify it passes; wire into exemplar page headers**

Run the test (expect PASS). Then in `ScriptsPage.tsx`, `PatchesPage.tsx`, and `DevicesPage.tsx`, render `<PageScopeIndicator pathname={window.location.pathname} orgName={currentOrg?.name} />` near the page `<h1>` (read each to place it consistently; pull `currentOrg` from `useOrgStore`).

- [ ] **Step 5: Verify + commit**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/layout/PageScopeIndicator.test.tsx
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec tsc --noEmit 2>&1 | grep -iE "scripts|patches|devices" | head
git add apps/web/src/components/layout/PageScopeIndicator.tsx apps/web/src/components/layout/PageScopeIndicator.test.tsx apps/web/src/components/scripts/ScriptsPage.tsx apps/web/src/components/patches/PatchesPage.tsx apps/web/src/components/devices/DevicesPage.tsx
git commit -m "feat(web): page-header scope indicator (global vs active org)"
```

---

## Phase 8 — Scope-naming confirmations (P0 safety)

### Task 15: Scope-naming confirm helper

**Files:**
- Create: `apps/web/src/lib/scopeConfirmMessage.ts`
- Test: `apps/web/src/lib/scopeConfirmMessage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/lib/scopeConfirmMessage.test.ts
import { describe, it, expect } from 'vitest';
import { scopeConfirmMessage } from './scopeConfirmMessage';

describe('scopeConfirmMessage', () => {
  it('names a single org and device count', () => {
    expect(scopeConfirmMessage({ action: 'Install 12 patches', deviceCount: 142, orgNames: ['Acme Corp'] }))
      .toBe('Install 12 patches on 142 devices in Acme Corp?');
  });
  it('warns when the action spans multiple organizations', () => {
    expect(scopeConfirmMessage({ action: 'Scan for patches', deviceCount: 300, orgNames: ['Acme Corp', 'Globex', 'Initech'] }))
      .toBe('Scan for patches on 300 devices across 3 organizations (Acme Corp, Globex, Initech)?');
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/lib/scopeConfirmMessage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/lib/scopeConfirmMessage.ts
//
// Composes a confirmation message that always names the target scope and count,
// so a tech can never fire a fleet action without seeing WHO it hits. The
// multi-org phrasing is intentionally heavier — acting across customers should
// read as a bigger deal.
export function scopeConfirmMessage({
  action,
  deviceCount,
  orgNames,
}: {
  action: string;
  deviceCount: number;
  orgNames: string[];
}): string {
  const devices = `${deviceCount} device${deviceCount === 1 ? '' : 's'}`;
  if (orgNames.length <= 1) {
    const org = orgNames[0] ?? 'the selected organization';
    return `${action} on ${devices} in ${org}?`;
  }
  return `${action} on ${devices} across ${orgNames.length} organizations (${orgNames.join(', ')})?`;
}
```

- [ ] **Step 4: Verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/lib/scopeConfirmMessage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/scopeConfirmMessage.ts apps/web/src/lib/scopeConfirmMessage.test.ts
git commit -m "feat(web): scopeConfirmMessage — name target scope + count for fleet actions"
```

### Task 16: Gate destructive/fleet actions behind a scope-naming `ConfirmDialog`

**Files (action sites — read each before editing):**
- `apps/web/src/components/patches/useBulkActions.ts` — `/patches/scan`, `/devices/:id/patches/install`
- `apps/web/src/components/patches/PatchApprovalModal.tsx` — approve
- The script-run entry point (find via `grep -rn "/run\|runScript\|executeScript" apps/web/src/components/scripts apps/web/src/components/devices`)

- [ ] **Step 1: Write the failing test (one representative site)**

For the bulk patch install/scan flow, add a test asserting the action does NOT fire until the user confirms a dialog whose message contains the org name and device count (use the existing `useBulkActions.test.ts` harness; read it first).

- [ ] **Step 2: Verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/patches/useBulkActions.test.ts`
Expected: FAIL (action currently fires without a confirm).

- [ ] **Step 3: Implement at each site**

Pattern (using the existing `ConfirmDialog` + the helper from Task 15): hold the pending action in state, render `ConfirmDialog` with:

```tsx
<ConfirmDialog
  open={pending !== null}
  onClose={() => setPending(null)}
  onConfirm={() => { void runPendingAction(); }}
  title="Confirm fleet action"
  variant="warning"
  confirmLabel="Run"
  confirmTestId="confirm-fleet-action"
  message={scopeConfirmMessage({
    action: pending.action,             // e.g. 'Install 12 patches'
    deviceCount: pending.deviceCount,
    orgNames: pending.orgNames,         // derived from selected devices / ring org — NOT the shell selector
  })}
/>
```

Derive `orgNames` from the action's own targets (selected devices' orgs, or the ring's org for approvals). For patch approval, `action` = `Approve N patches`, `orgNames` = `[ring.orgName]`, `deviceCount` from the ring's target device count if available (else omit the count by passing the affected patch count phrasing — keep the org name mandatory).

- [ ] **Step 4: Verify the representative test passes; type-check**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec vitest run src/components/patches
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/web exec tsc --noEmit 2>&1 | grep -iE "patches|scripts" | head
```
Expected: PASS; no new type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/patches/ apps/web/src/components/scripts/
git commit -m "feat(web): scope-naming confirmations on patch/script/bulk fleet actions"
```

> **Phase 8 checkpoint (P0 safety):** no destructive or fleet-affecting action fires without a confirmation that names the target organization(s) and count.

---

## Deferred follow-up (explicitly out of this plan's route/UI scope)

**Alert Templates route + UI.** The migration (Task 5) adds `partner_id` + dual-axis RLS to
`alert_templates` **proactively** — so the table is tenant-safe and ready, and no second
migration is needed later. But the *route* changes (list union of org ∪ partner-wide ∪ system)
and the *create UI* ("Available to" picker) for alert templates are **not** built here. They
mirror Scripts Tasks 7–9 exactly (same dual-axis list union, same `availability` create field,
same org-user read-only guard) against `alert_templates`/the alert-templates route + form.

This is a deliberate scoping call to keep the plan tractable: Scripts is the surface that
drove the request, and shipping it end-to-end first proves the pattern. Alert Templates'
route/UI is a small, well-defined next plan reusing the same task shapes. If you want it in
this branch, append a Phase 7 that repeats Tasks 7–9 with `alert_templates` substituted.

## Notes for the executor

- **Pre-existing flakiness:** the full API `vitest run` fails ~7-9 unrelated files on a pristine tree; verify via the focused single-fork commands above and trust CI. Do not chase those.
- **RLS bound-param caveat:** these policies use direct column predicates (`org_id`, `partner_id`, system flag) — NOT nested EXISTS — so the postgres.js bound-param bug (script_execution_batches, #1016) does not apply.
- **Do not drop the Task 0 stash** until the branch is merged; it is the only copy of the discarded web approach.
- **Auth property names:** several steps assume `auth.partnerId` / `auth.accessibleOrgIds`. Confirm against the auth-middleware context type before relying on them; adjust names if they differ.
