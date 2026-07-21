# AI for Office — per-partner entitlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI for Office a per-partner entitlement the platform operator controls (off by default), enforced at the session-minting exchange so a non-enabled partner can incur no AI spend; retire the global build-time nav flag.

**Architecture:** Add `partners.ai_for_office_enabled` (boolean, default false), settable only via the system-scope partner PATCH (and SQL). Gate the runtime `/client-ai/auth/exchange` on it (primary cost gate) by joining the flag into the existing tenant-mapping lookup; gate the `/client-ai/admin` group on it secondarily. The web nav reads the flag from `/orgs/partners/me` (already fetched) and gates the item at runtime. Remove the `PUBLIC_ENABLE_AI_FOR_OFFICE` build flag.

**Tech Stack:** Hono + Drizzle (API), Postgres (hand-written idempotent migration), Astro + React + Zustand (web), Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-06-15-ai-for-office-partner-entitlement-design.md`

---

## File structure

- `apps/api/src/db/schema/orgs.ts` — add the `aiForOfficeEnabled` column to `partners`.
- `apps/api/migrations/2026-06-17-partners-ai-for-office-enabled.sql` — new idempotent migration (date sorts after the latest, `2026-06-16-stripe-payments.sql`).
- `apps/api/src/routes/clientAi/auth.ts` — join + partner gate in `/auth/exchange` (primary).
- `apps/api/src/routes/clientAi/auth.test.ts` — extend harness + disabled-partner test.
- `apps/api/src/routes/clientAi/admin.ts` — partner gate in the group middleware (secondary).
- `apps/api/src/routes/clientAi/admin.test.ts` — extend harness + disabled-partner test.
- `apps/api/src/routes/orgs.ts` — add `aiForOfficeEnabled` to `updatePartnerSchema`.
- `apps/web/src/components/layout/Sidebar.tsx` — runtime partner-flag nav gate; drop `featureEnabled`/build-flag use.
- `apps/web/src/components/layout/Sidebar.featuregate.test.tsx` — rewrite to drive the runtime partner flag.
- `apps/web/src/lib/featureFlags.ts`, `apps/web/src/env.d.ts`, `apps/web/Dockerfile`, `docker/Dockerfile.web` — remove `PUBLIC_ENABLE_AI_FOR_OFFICE`.

Run all API commands from `apps/api`, web commands from `apps/web`, prefixed with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.

---

## Task 1: Add the `aiForOfficeEnabled` column to the partners schema + migration

**Files:**
- Modify: `apps/api/src/db/schema/orgs.ts` (partners table, ends at the `invoiceFooter` line ~41)
- Create: `apps/api/migrations/2026-06-17-partners-ai-for-office-enabled.sql`

- [ ] **Step 1: Add the column to the Drizzle schema**

In `apps/api/src/db/schema/orgs.ts`, inside the `partners = pgTable('partners', { … })` definition, add this line immediately after `invoiceFooter: text('invoice_footer'),`:

```ts
  // AI for Office is a per-partner entitlement the platform operator grants
  // (off by default). The session-minting exchange and the /client-ai/admin
  // surface gate on this; it is NOT in settings JSONB because that is
  // partner-writable and the partner must not be able to self-enable.
  aiForOfficeEnabled: boolean('ai_for_office_enabled').notNull().default(false),
```

(`boolean` is already imported at the top of the file.)

- [ ] **Step 2: Write the idempotent migration**

Create `apps/api/migrations/2026-06-17-partners-ai-for-office-enabled.sql`:

```sql
-- Per-partner AI for Office entitlement (operator-granted, off by default).
-- The partner table already has partner-axis RLS; a non-tenant-key column
-- inherits the existing row policies, so no policy change is needed.
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS ai_for_office_enabled boolean NOT NULL DEFAULT false;
```

- [ ] **Step 3: Verify schema matches migrations (no drift)**

Run from repo root:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```
Expected: no drift reported (schema column matches the migration). If the local DB is unavailable, instead confirm by inspection that the snake_case column name and type match between the schema line and the SQL.

- [ ] **Step 4: Verify migration ordering test stays green**

Run from `apps/api`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/db/autoMigrate.test.ts
```
Expected: PASS (the new filename `2026-06-17-…` sorts after `2026-06-16-stripe-payments.sql`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/orgs.ts apps/api/migrations/2026-06-17-partners-ai-for-office-enabled.sql
git commit -m "feat(db): add partners.ai_for_office_enabled (per-partner AI for Office entitlement)"
```

---

## Task 2: Gate the session-minting exchange on the partner flag (primary cost gate)

**Files:**
- Modify: `apps/api/src/routes/clientAi/auth.ts` (imports; the mapping lookup inside the `withSystemDbAccessContext` block, ~line 130)
- Test: `apps/api/src/routes/clientAi/auth.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/clientAi/auth.test.ts`, first extend the shared `MAPPING_ROW` constant (currently `{ id, orgId: ORG_ID, entraTenantId: TID }`) so every existing happy-path test still passes the new gate — add the joined field:

```ts
const MAPPING_ROW = { id: 'a1a1a1a1-1111-4222-8333-444455556666', orgId: ORG_ID, entraTenantId: TID, partnerEnabled: true };
```

Then add a new test (place it next to the existing `disabled`/policy tests):

```ts
it('403s with partner_not_enabled when the org\'s partner has AI for Office disabled', async () => {
  setupDb({ mapping: { ...MAPPING_ROW, partnerEnabled: false }, user: USER_ROW });
  verifyMock.mockResolvedValue({ tid: TID, oid: 'oid-1', email: 'u@example.com', name: 'U' });

  const res = await buildApp().request('/client-ai/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: 'tok' }),
  });

  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe('disabled');
  expect(writeAuditEventMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ result: 'denied', orgId: ORG_ID }),
  );
});
```

(If the existing happy-path tests build the exchange request through a local helper, mirror that helper instead of the inline `buildApp().request(...)` above — match the file's established call style.)

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/api`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/clientAi/auth.test.ts -t "partner_not_enabled"
```
Expected: FAIL — currently the exchange ignores the partner flag, so the request proceeds past the gate (not a 403 `disabled`).

- [ ] **Step 3: Implement the gate (join the flag into the mapping lookup)**

In `apps/api/src/routes/clientAi/auth.ts`, add the schema imports near the existing imports:

```ts
import { organizations, partners } from '../../db/schema/orgs';
```

Replace the existing mapping lookup (currently `const [mapping] = await db.select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.entraTenantId, claims.tid)).limit(1);`) with a projected join that also reads the partner flag:

```ts
    const [mapping] = await db
      .select({
        orgId: clientAiTenantMappings.orgId,
        partnerEnabled: partners.aiForOfficeEnabled,
      })
      .from(clientAiTenantMappings)
      .innerJoin(organizations, eq(organizations.id, clientAiTenantMappings.orgId))
      .innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(clientAiTenantMappings.entraTenantId, claims.tid))
      .limit(1);

    if (!mapping) {
      return {
        denied: {
          status: 404,
          error: 'tenant_not_provisioned',
          orgId: null,
          details: { reason: 'tenant_not_provisioned', tid: claims.tid },
        },
      };
    }

    // Per-partner entitlement gate (the cost gate): no enabled partner ⇒ no
    // session ⇒ no AI spend. Sits above the per-org policy.enabled check below.
    if (!mapping.partnerEnabled) {
      return {
        denied: {
          status: 403,
          error: 'disabled',
          orgId: mapping.orgId,
          details: { reason: 'partner_not_enabled', tid: claims.tid, oid: claims.oid },
        },
      };
    }
```

Leave the rest of the block unchanged — `mapping.orgId` is the only mapping field used downstream (`getOrgPolicy(mapping.orgId)`, the portalUsers insert), and the projected select still provides it.

- [ ] **Step 4: Run the new test + the full auth suite**

Run from `apps/api`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/clientAi/auth.test.ts
```
Expected: PASS — the new test passes (403), and every existing test passes because `MAPPING_ROW.partnerEnabled = true`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clientAi/auth.ts apps/api/src/routes/clientAi/auth.test.ts
git commit -m "feat(client-ai): gate session exchange on per-partner AI for Office entitlement"
```

---

## Task 3: Gate the /client-ai/admin group on the partner flag (config defense-in-depth)

**Files:**
- Modify: `apps/api/src/routes/clientAi/admin.ts` (imports; the `clientAiAdminRoutes.use('*', …)` dark-gate, ~line 42)
- Test: `apps/api/src/routes/clientAi/admin.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/clientAi/admin.test.ts`, extend the shared `MAPPING_ROW` (used as the default `selectChain` row) so the new gate passes by default — add the field the gate reads:

```ts
const MAPPING_ROW = {
  id: 'a1a1a1a1-1111-4222-8333-444455556666',
  orgId: ORG_ID,
  entraTenantId: TID,
  createdAt: new Date(),
  updatedAt: new Date(),
  aiForOfficeEnabled: true,
};
```

Add a new test (top of the file's describe, after the unauth test):

```ts
it('404s when the caller partner has AI for Office disabled', async () => {
  dbSelectMock.mockImplementation(() => selectChain([{ aiForOfficeEnabled: false }]));
  const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
    headers: AUTHED,
  });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/api`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/clientAi/admin.test.ts -t "AI for Office disabled"
```
Expected: FAIL — the group currently has no partner gate, so a disabled partner reaches the route (not 404 at the gate).

- [ ] **Step 3: Implement the partner gate in the group middleware**

In `apps/api/src/routes/clientAi/admin.ts`, add imports:

```ts
import { partners } from '../../db/schema/orgs';
```

(`db` and `eq` are already imported.) Replace the existing dark-gate middleware:

```ts
clientAiAdminRoutes.use('*', async (c, next) => {
  if (!CLIENT_AI_ENTRA_CLIENT_ID) {
    return c.json({ error: 'Breeze AI for Office is not enabled' }, 404);
  }
  await next();
});
```

with one that also checks the caller partner's entitlement:

```ts
clientAiAdminRoutes.use('*', async (c, next) => {
  if (!CLIENT_AI_ENTRA_CLIENT_ID) {
    return c.json({ error: 'Breeze AI for Office is not enabled' }, 404);
  }
  // A non-enabled partner's MSP admin can't configure AI for Office. System
  // callers (no partnerId) pass this layer — they aren't partner-scoped.
  const auth = c.get('auth');
  if (auth?.partnerId) {
    const [partner] = await db
      .select({ aiForOfficeEnabled: partners.aiForOfficeEnabled })
      .from(partners)
      .where(eq(partners.id, auth.partnerId))
      .limit(1);
    if (!partner?.aiForOfficeEnabled) {
      return c.json({ error: 'Breeze AI for Office is not enabled' }, 404);
    }
  }
  await next();
});
```

- [ ] **Step 4: Run the admin suite**

Run from `apps/api`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/clientAi/admin.test.ts
```
Expected: PASS — the new disabled test 404s, and existing tests pass because the default `selectChain([MAPPING_ROW])` now returns `aiForOfficeEnabled: true` for the gate's first select.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clientAi/admin.ts apps/api/src/routes/clientAi/admin.test.ts
git commit -m "feat(client-ai): gate admin surface on per-partner AI for Office entitlement"
```

---

## Task 4: Allow the operator to set the flag via the system-scope partner PATCH

**Files:**
- Modify: `apps/api/src/routes/orgs.ts` (`updatePartnerSchema`, ~line 68)

- [ ] **Step 1: Add the field to `updatePartnerSchema`**

In `apps/api/src/routes/orgs.ts`, extend `updatePartnerSchema`:

```ts
const updatePartnerSchema = createPartnerSchema.partial().extend({
  status: z.enum(['pending', 'active', 'suspended', 'churned']).optional(),
  // Operator-only per-partner AI for Office entitlement. Settable here (system
  // scope) but NOT on /partners/me (partner scope) — partners can't self-enable.
  aiForOfficeEnabled: z.boolean().optional(),
  settings: z.any().optional().refine(settingsAllowlistEntriesValid, {
    message: 'Each IP allowlist entry must be a valid IP address or CIDR range',
  }),
});
```

No handler change is needed: `PATCH /partners/:id` builds `updates = { ...data, updatedAt }` and calls `.set(updates)`, so a validated `aiForOfficeEnabled` maps to the Drizzle column automatically, and the existing `partner.update` audit event records it in `changedFields`. The partner-scope `updatePartnerSettingsSchema` is untouched, so `/partners/me` cannot set it.

- [ ] **Step 2: Typecheck the API**

Run from `apps/api`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: exit 0 (the new optional boolean is consistent with the Drizzle column type).

- [ ] **Step 3: Add a focused route test**

Locate the existing system-scope `PATCH /partners/:id` test (search `apps/api/src/routes/orgs.test.ts` for `partners/` PATCH cases). Mirror the nearest passing update test and add one asserting the field round-trips. Concretely, add a test that issues `PATCH /partners/<id>` with `{ aiForOfficeEnabled: true }` and asserts the response/`db.update` receives `aiForOfficeEnabled: true`. Match the file's existing mock/seed style (do not invent a new harness). If `orgs.test.ts` is a mocked-`db` unit test, assert the `.set(...)` argument contains `aiForOfficeEnabled: true`; if it is a real-DB integration test, re-read the row and assert the column is `true`.

If no `PATCH /partners/:id` test file/section exists, skip adding one here — the field is exercised end-to-end by Task 2/3 gates and the schema typecheck — and note the skip in the commit message.

- [ ] **Step 4: Run the orgs route tests (if present)**

Run from `apps/api`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/orgs.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(api): allow system-scope PATCH /partners/:id to set aiForOfficeEnabled"
```

---

## Task 5: Gate the web nav on the runtime partner flag; drop the build-flag mechanism

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx`
- Test: `apps/web/src/components/layout/Sidebar.featuregate.test.tsx` (rewrite)

- [ ] **Step 1: Rewrite the test to drive the runtime partner flag**

Replace `apps/web/src/components/layout/Sidebar.featuregate.test.tsx` entirely with a version that mocks `/orgs/partners/me` (the partner fetch the Sidebar already does) and asserts the nav item shows only when `aiForOfficeEnabled` is true. The partner fetch is async, so assertions use `findBy`/`waitFor`.

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partner fetch drives the AI-for-Office nav gate at runtime.
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (s: { user: { isPlatformAdmin: boolean } }) => unknown) =>
      selector({ user: { isPlatformAdmin: false } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: () => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() }),
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

function mockPartner(aiForOfficeEnabled: boolean) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/orgs/partners/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ name: 'Acme MSP', aiForOfficeEnabled, settings: {} }),
      } as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(), onchange: null,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => vi.clearAllMocks());

describe('Sidebar — AI for Office per-partner gate', () => {
  it('shows the AI for Office nav item when the partner is enabled', async () => {
    mockPartner(true);
    const { container } = render(<Sidebar currentPath="/ai-for-office" />);
    await waitFor(() =>
      expect(container.querySelector('a[href="/ai-for-office"]')).not.toBeNull(),
    );
  });

  it('hides the AI for Office nav item when the partner is not enabled', async () => {
    mockPartner(false);
    const { container } = render(<Sidebar currentPath="/ai-for-office" />);
    // Fleet (same section, no gate) confirms the section rendered; AI item absent.
    await waitFor(() => expect(container.querySelector('a[href="/fleet"]')).not.toBeNull());
    expect(container.querySelector('a[href="/ai-for-office"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/web`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/layout/Sidebar.featuregate.test.tsx
```
Expected: FAIL — the nav still gates on the build-time `featureEnabled`/`ENABLE_AI_FOR_OFFICE`, not the partner fetch, so the "enabled" case won't show the item.

- [ ] **Step 3: Implement the runtime gate in Sidebar**

In `apps/web/src/components/layout/Sidebar.tsx`:

(a) Remove the build-flag import (line ~50): delete `import { ENABLE_AI_FOR_OFFICE } from '../../lib/featureFlags';`.

(b) Replace the `featureEnabled` NavItem field with an AI-for-Office marker. Change the type member (line ~95-97) from:

```ts
  // feature flag (e.g. ENABLE_AI_FOR_OFFICE). Undefined means always shown.
  featureEnabled?: boolean;
```
to:
```ts
  // Shown only when the current partner has AI for Office enabled (runtime flag
  // from /orgs/partners/me). Undefined means not gated on the partner flag.
  requiresAiForOffice?: boolean;
```

(c) Change the nav item (line ~133) from:
```ts
      { name: 'AI for Office', href: '/ai-for-office', icon: FileSpreadsheet, partnerScopeOnly: true, featureEnabled: ENABLE_AI_FOR_OFFICE },
```
to:
```ts
      { name: 'AI for Office', href: '/ai-for-office', icon: FileSpreadsheet, partnerScopeOnly: true, requiresAiForOffice: true },
```

(d) Add state for the flag near `brandName`/`brandLogoUrl` (line ~304):
```ts
  const [aiForOfficeEnabled, setAiForOfficeEnabled] = useState(false);
```

(e) In the partner-branding `useEffect` (the `fetchWithAuth('/orgs/partners/me')` block, ~line 338), widen the parsed type and set the flag. Change the `.then((r) => …)` return type annotation to include the field and set it in the next `.then`:
```ts
        return r.json() as Promise<{ name?: string; aiForOfficeEnabled?: boolean; settings?: { branding?: { logoUrl?: string } } }>;
```
```ts
      .then((data) => {
        if (cancelled || !data) return;
        setBrandName(data.name ?? null);
        setBrandLogoUrl(data.settings?.branding?.logoUrl ?? null);
        setAiForOfficeEnabled(data.aiForOfficeEnabled === true);
      })
```

(f) Replace the gate in `renderNavItem` (line ~450). Change:
```ts
    if (item.featureEnabled === false) return null;
```
to:
```ts
    if (item.requiresAiForOffice && !aiForOfficeEnabled) return null;
```

- [ ] **Step 4: Run the test to verify it passes**

Run from `apps/web`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/layout/Sidebar.featuregate.test.tsx
```
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.featuregate.test.tsx
git commit -m "feat(web): gate AI for Office nav on the per-partner entitlement (runtime)"
```

---

## Task 6: Remove the retired build-time flag and its plumbing

**Files:**
- Modify: `apps/web/src/lib/featureFlags.ts`
- Modify: `apps/web/src/env.d.ts`
- Modify: `apps/web/Dockerfile`
- Modify: `docker/Dockerfile.web`

- [ ] **Step 1: Remove the flag constant**

In `apps/web/src/lib/featureFlags.ts`, delete the entire `ENABLE_AI_FOR_OFFICE` block:

```ts
// Breeze AI for Office (Excel/Word/etc. add-in admin surface). Off by default.
// This flag controls only the left-nav entry's visibility (combined with the
// existing partner-scope check). The admin pages behind it stay dark until the
// API has CLIENT_AI_ENTRA_CLIENT_ID set, which 404s the /client-ai/admin group
// server-side — a separate, deeper gate, not what this flag does.
export const ENABLE_AI_FOR_OFFICE = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_AI_FOR_OFFICE,
  false
);
```

Leave `ENABLE_ENDPOINT_AV_FEATURES` and `ENABLE_NETWORK_DEVICES_IN_LIST` intact.

- [ ] **Step 2: Remove the env typing**

In `apps/web/src/env.d.ts`, delete the line:
```ts
  readonly PUBLIC_ENABLE_AI_FOR_OFFICE?: string;
```

- [ ] **Step 3: Remove the Dockerfile build args**

In `apps/web/Dockerfile`, delete:
```dockerfile
ARG PUBLIC_ENABLE_AI_FOR_OFFICE=
ENV PUBLIC_ENABLE_AI_FOR_OFFICE=${PUBLIC_ENABLE_AI_FOR_OFFICE}
```
and update the shared comment `# Build-time UI feature flags (empty → off; …)` if it now refers only to the network flag (leave the network-flag ARG/ENV).

In `docker/Dockerfile.web`, delete:
```dockerfile
ARG PUBLIC_ENABLE_AI_FOR_OFFICE=""
ENV PUBLIC_ENABLE_AI_FOR_OFFICE=${PUBLIC_ENABLE_AI_FOR_OFFICE}
```

- [ ] **Step 4: Confirm no remaining references**

Run from repo root:
```bash
grep -rn "PUBLIC_ENABLE_AI_FOR_OFFICE\|ENABLE_AI_FOR_OFFICE" apps/web docker apps/api || echo "no references remain"
```
Expected: `no references remain`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/featureFlags.ts apps/web/src/env.d.ts apps/web/Dockerfile docker/Dockerfile.web
git commit -m "chore(web): remove retired PUBLIC_ENABLE_AI_FOR_OFFICE build flag (replaced by per-partner entitlement)"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: API typecheck**

Run from `apps/api`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 2: Web typecheck**

Run from `apps/web`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Targeted test run (changed areas)**

Run from `apps/api`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/clientAi/auth.test.ts src/routes/clientAi/admin.test.ts src/routes/orgs.test.ts src/db/autoMigrate.test.ts
```
Run from `apps/web`:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/layout/
```
Expected: all PASS.

- [ ] **Step 4: Lint changed files**

From repo root (or per-app), run eslint over the changed TS files:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx eslint src/routes/clientAi/auth.ts src/routes/clientAi/admin.ts src/routes/orgs.ts src/db/schema/orgs.ts
cd ../web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx eslint src/components/layout/Sidebar.tsx src/lib/featureFlags.ts
```
Expected: clean (exit 0).

- [ ] **Step 5: Final commit (if lint/typecheck required tweaks)**

```bash
git add -A
git commit -m "chore: typecheck + lint fixes for per-partner AI for Office entitlement"
```

---

## Self-review notes (resolved)

- **Spec coverage:** column (T1) · exchange cost gate (T2) · admin defense-in-depth gate (T3) · operator set path (T4) · web runtime nav gate (T5) · retire build flag (T6) · verify (T7). All spec sections mapped.
- **Type consistency:** column property `aiForOfficeEnabled` ↔ SQL `ai_for_office_enabled` ↔ zod `aiForOfficeEnabled` ↔ exchange projection field `partnerEnabled` (local alias, intentional) ↔ admin projection `aiForOfficeEnabled` ↔ web state `aiForOfficeEnabled` / NavItem `requiresAiForOffice`. Names are consistent within each layer; the exchange's `partnerEnabled` alias is local to that one query and its test row.
- **Migration ordering:** `2026-06-17-…` sorts after `2026-06-16-stripe-payments.sql`; autoMigrate ordering test covers it (T1 S4).
- **No partner-self-enable:** field added only to `updatePartnerSchema` (system scope), never `updatePartnerSettingsSchema` (partner scope). Verified in T4.
