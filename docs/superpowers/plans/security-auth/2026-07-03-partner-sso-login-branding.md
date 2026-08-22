# Partner-Scope SSO + Login-Page Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP's own technicians SSO into the partner dashboard via a partner-axis `sso_providers` row, and let the login page show partner branding + a partner SSO button on single-partner (self-hosted) instances. Spec: `docs/superpowers/specs/2026-07-03-partner-sso-login-branding-design.md`. Refs #2183.

**Architecture:** Dual-axis extension of the existing org SSO subsystem per the epic #2135 playbook (`org_id XOR partner_id` on `sso_providers`), a new partner-only `partner_login_branding` table, a public `GET /auth/login-context` endpoint with a single-partner fast-path, and a prop/island-driven `AuthShellBranded`. The `jose`-based OIDC engine in `services/sso.ts` is reused unchanged.

**Tech Stack:** Hono + Drizzle + hand-written SQL migrations, `jose` (already present), Vitest (unit + real-DB integration configs), React islands in Astro.

## Global Constraints

- **No new auth libraries.** `jose` only; no MSAL, no openid-client. `services/sso.ts` engine is reused, not modified (only consumed).
- **Identity-first, NO JIT on the partner axis.** A partner-axis login NEVER creates a user. `defaultRoleId` on partner providers is validated + stored but NEVER applied at login in v1; users without a `partner_users` membership are rejected (`no_partner_access`) — never fall back to a default role (membershipless-user system-scope-token bug class).
- **Email auto-link keeps the org flow's safety conditions** (password set OR linked to a different provider → `sso_link_required` error, no auto-link). Password-holding users link via the authenticated self-service **Connect SSO** flow (Task 6); the `sso_link_required` error copy directs them there. Settled with Todd 2026-07-03 — this is now spec, not a deviation.
- **Break-glass preserved:** `enforceSSO` only suppresses password login for `status='active'` providers (`testing` never suppresses).
- **No `z.any()`** in any new/modified schema. `ssoConfig` is REMOVED from partner/org Zod schemas (Task 3).
- **Migration:** one file `apps/api/migrations/2026-07-03-sso-partner-axis-login-branding.sql`, idempotent, RLS in the same file, no inner `BEGIN;`/`COMMIT;`, never edit shipped migrations.
- **Partner id always derived from the caller's token, never the request body.** Partner-scope writes gated on `canManagePartnerWidePolicies(auth)` (`apps/api/src/services/partnerWideAccess.ts:25`).
- **Public SSO/auth endpoints run DB reads/writes inside `withSystemDbAccessContext`** (no request scope exists pre-auth; bare `db` silently returns 0 rows under RLS).
- **Tests:** unit `pnpm test --filter=@breeze/api`; real-DB integration `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>` (Postgres on :5433 via `docker compose -f docker-compose.test.yml up -d`). TRAP: a worktree missing the `.env.test` symlink makes RLS forge tests vacuously pass under a BYPASSRLS role — verify `apps/api/.env.test` exists and points at the test DB before trusting green forge tests.
- **PR text uses `Refs #2183`** (community issue — never `Closes`/`Fixes`).

---

### Task 1: Migration + Drizzle schema (dual-axis `sso_providers`, new `partner_login_branding`)

**Files:**
- Create: `apps/api/migrations/2026-07-03-sso-partner-axis-login-branding.sql`
- Modify: `apps/api/src/db/schema/sso.ts` (ssoProviders table, lines 9-59)
- Create: `apps/api/src/db/schema/partnerLoginBranding.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add export)

**Interfaces:**
- Produces: `ssoProviders.partnerId` (uuid, nullable) + nullable `ssoProviders.orgId`; `ssoSessions.linkUserId` (uuid, nullable — link-mode marker for Task 6); Drizzle table `partnerLoginBranding` with columns `partnerId` (PK), `logoUrl`, `accentColor`, `headline`, `createdAt`, `updatedAt`. All later tasks import these from `../db/schema`.

**Note:** the table is named `partner_login_branding`, not the spec's `partner_branding` — a deliberate rename because the web app already has a "Partner Branding" feature (`PartnerBrandingTab.tsx`, inheritable org-branding defaults) and a `partner_branding` table would collide semantically with it.

- [ ] **Step 1: Write the migration**

Model on `apps/api/migrations/2026-06-27-config-policies-partner-ownership.sql` (the playbook reference). Full content:

```sql
-- Partner-axis SSO providers + partner login branding (#2183, epic #2135 playbook).
--
-- sso_providers becomes dual-ownership: org-axis (org_id set, partner_id NULL —
-- the existing customer-org SSO shape) OR partner-axis (partner_id set, org_id
-- NULL — the MSP's own technician login). Exactly one axis per row (CHECK).
-- user_sso_identities is unchanged: it keys off provider_id, and the provider
-- row carries ownership. sso_sessions gains a nullable link_user_id: when set,
-- the session is a LINK-mode round-trip (an already-authenticated user
-- connecting their SSO identity) rather than a login. sso_verified_domains
-- stays org-only (it gates JIT, which partner-axis providers do not do in v1).
--
-- partner_login_branding is deliberately partner-ONLY (not dual-axis): org-level
-- login branding already exists as portal_branding.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, DROP POLICY IF EXISTS
-- then CREATE. No inner BEGIN/COMMIT (autoMigrate wraps each file).

-- ============================================
-- Step 1: sso_providers — add partner_id, relax org_id, exactly-one-axis
-- ============================================

ALTER TABLE sso_providers
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);

ALTER TABLE sso_providers
  ALTER COLUMN org_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sso_providers_one_owner_chk'
      AND conrelid = 'sso_providers'::regclass
  ) THEN
    ALTER TABLE sso_providers
      ADD CONSTRAINT sso_providers_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sso_providers_partner_id_idx
  ON sso_providers(partner_id);

-- Link-mode marker for the self-service Connect SSO flow: when set, the
-- callback links the verified identity to THIS user instead of logging in.
ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS link_user_id uuid REFERENCES users(id);

-- ============================================
-- Step 2: sso_providers RLS — dual-axis (org OR partner) + FORCE
-- ============================================

ALTER TABLE sso_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_providers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sso_providers_org_isolation ON sso_providers;
CREATE POLICY sso_providers_org_isolation
  ON sso_providers
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

-- ============================================
-- Step 3: partner_login_branding — table + partner-axis RLS + FORCE
-- ============================================

CREATE TABLE IF NOT EXISTS partner_login_branding (
  partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  logo_url text,
  accent_color varchar(7),
  headline varchar(120),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE partner_login_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_login_branding FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_login_branding_partner_isolation ON partner_login_branding;
CREATE POLICY partner_login_branding_partner_isolation
  ON partner_login_branding
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );
```

**IMPORTANT pre-existing-policy check:** before finalizing, run against a migrated local DB: `SELECT policyname FROM pg_policies WHERE tablename = 'sso_providers';` and add a `DROP POLICY IF EXISTS <name>` line for EVERY existing policy name found (they may be per-command `breeze_org_isolation_select/insert/update/delete` style, not the single name assumed above). The dual-axis CREATE must replace all org-only policies, whatever their names.

- [ ] **Step 2: Update Drizzle schema — `sso.ts`**

In `apps/api/src/db/schema/sso.ts`, add the partners import and change the ssoProviders header block:

```ts
import { organizations, partners } from './orgs';
```

```ts
// SSO Provider Configuration — dual ownership (#2183): org-axis (orgId set,
// partnerId NULL — customer-org SSO) XOR partner-axis (partnerId set, orgId
// NULL — the MSP's own technician login). Enforced by sso_providers_one_owner_chk.
export const ssoProviders = pgTable('sso_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
```

(Only `orgId` loses `.notNull()`; every other ssoProviders column is untouched.)

Also add to the `ssoSessions` table definition (after `redirectUrl`):

```ts
  // Link-mode marker (#2183 Connect SSO): when set, the callback links the
  // verified identity to this user instead of minting login tokens.
  linkUserId: uuid('link_user_id').references(() => users.id),
```

- [ ] **Step 3: Create `apps/api/src/db/schema/partnerLoginBranding.ts`**

```ts
import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './orgs';

// Login-page branding for the MSP's OWN technician login (#2183). Deliberately
// partner-only (no org axis): org/customer login branding already exists as
// portal_branding. One row per partner (PK = partner_id). RLS shape 3:
// breeze_has_partner_access(partner_id), FORCE — see the 2026-07-03 migration.
// NOT the same feature as the "Partner Branding" inheritable org-defaults tab.
export const partnerLoginBranding = pgTable('partner_login_branding', {
  partnerId: uuid('partner_id').primaryKey().references(() => partners.id, { onDelete: 'cascade' }),
  logoUrl: text('logo_url'),
  accentColor: varchar('accent_color', { length: 7 }),
  headline: varchar('headline', { length: 120 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

Add to `apps/api/src/db/schema/index.ts` following its existing export style (one line, alphabetical position): `export * from './partnerLoginBranding';`

- [ ] **Step 4: Verify migration applies + drift check**

```bash
docker compose -f docker-compose.test.yml up -d
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"  # use your local dev DB
pnpm db:check-drift
```
Expected: drift check passes (schema matches migrations). Also re-apply the migration a second time against the same DB (idempotency): re-running `autoMigrate` (or `psql -f` of the file) must be a no-op with no errors.

- [ ] **Step 5: Run the autoMigrate ordering regression test**

```bash
pnpm test --filter=@breeze/api -- autoMigrate
```
Expected: PASS (filename sorts correctly after existing 2026-07 migrations).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-07-03-sso-partner-axis-login-branding.sql apps/api/src/db/schema/sso.ts apps/api/src/db/schema/partnerLoginBranding.ts apps/api/src/db/schema/index.ts
git commit -m "feat(sso): dual-axis sso_providers + partner_login_branding schema (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: RLS registrations + partner-axis forge integration tests

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES` at :204, `PARTNER_TENANT_TABLES` at :122)
- Create: `apps/api/src/__tests__/integration/ssoProvidersPartnerRls.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/partnerLoginBrandingRls.integration.test.ts`
- Possibly modify: `apps/api/src/services/tenantCascade.ts` (only if the cascade contract test fails — see Step 4)

**Interfaces:**
- Consumes: Task 1's schema. No exports; contract/forge coverage only.

- [ ] **Step 1: Register both tables in the coverage contract**

In `DUAL_AXIS_TENANT_TABLES` (rls-coverage.integration.test.ts:204), add with the same comment style as `configuration_policies`:

```ts
  // sso_providers (#2183): org-axis (org_id set — customer-org SSO, the
  // original shape) OR partner-axis (partner_id set, org_id NULL — MSP
  // technician login). Converted in 2026-07-03-sso-partner-axis-login-branding.
  // Org auto-discovery asserts the org branch; this entry asserts the
  // breeze_has_partner_access branch. CHECK sso_providers_one_owner_chk
  // enforces exactly one axis. Functional forge proof:
  // ssoProvidersPartnerRls.integration.test.ts.
  'sso_providers',
```

In `PARTNER_TENANT_TABLES` (:122), add in list position: `['partner_login_branding', 'partner_id'],`

- [ ] **Step 2: Write `ssoProvidersPartnerRls.integration.test.ts`**

Copy the setup/teardown skeleton from `apps/api/src/__tests__/integration/configurationPoliciesPartnerRls.integration.test.ts` (two partners + a partner-scope access context helper), then assert, as `breeze_app` with partner-A context:

```ts
// 1. Functional second-axis insert: partner A inserts a partner-axis provider — succeeds.
//    (values: partnerId: partnerA.id, orgId: null, name: 'Partner IdP', type: 'oidc', status: 'inactive')
// 2. Cross-partner forge: partner A inserts a row with partnerId: partnerB.id — expect
//    error.code === '42501' (new row violates row-level security policy).
// 3. XOR: insert with BOTH orgId and partnerId set — expect error.code === '23514'
//    (sso_providers_one_owner_chk). Insert with NEITHER — also '23514'.
// 4. Visibility isolation: partner B context SELECTs — partner A's provider row absent.
// 5. Org context (org under partner A) SELECTs — the partner-axis row is NOT
//    visible (org tokens never pass breeze_has_partner_access; RLS stricter than app layer).
```

Write these as real inserts/selects through the test file's `breeze_app` client helper, matching the sibling file's helper names exactly (do not memoize fixtures across assertions — memoized-fixture forge tests go vacuous).

- [ ] **Step 3: Write `partnerLoginBrandingRls.integration.test.ts`**

Same skeleton: partner A upserts its row (succeeds), forges partner B's `partner_id` (42501), partner B sees nothing, `DELETE FROM partners` cascade removes the row (ON DELETE CASCADE).

- [ ] **Step 4: Run coverage + cascade + forge suites**

```bash
docker compose -f docker-compose.test.yml up -d
ls -la apps/api/.env.test   # MUST exist (symlink) — otherwise forge tests are vacuous
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/ssoProvidersPartnerRls.integration.test.ts src/__tests__/integration/partnerLoginBrandingRls.integration.test.ts
pnpm test --filter=@breeze/api -- tenantCascade
```
Expected: all PASS. If a tenant-cascade contract test fails naming `partner_login_branding` or `sso_providers`, register the table exactly where the failure message directs (org cascade at `tenantCascade.ts:63` deletes by `org_id`, so partner-axis rows with `org_id NULL` are naturally out of its scope; `partner_login_branding` cascades via FK `ON DELETE CASCADE`). Keep any list insertion in `localeCompare` order.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/
git commit -m "test(sso): partner-axis RLS forge + coverage registration (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Provider CRUD — `ownerScope`, partner gates, write-time role validation, `ssoConfig` removal

**Files:**
- Modify: `apps/api/src/routes/sso.ts` (schemas :125-151, list :376, get :402, create :427, update :512, delete :573, status :624)
- Modify: `apps/api/src/routes/orgs.ts` (:60 `createPartnerSchema`, :120-ish `createOrganizationSchema` — remove `ssoConfig`)
- Test: `apps/api/src/routes/sso.test.ts` (extend existing; create if absent)

**Interfaces:**
- Consumes: `canManagePartnerWidePolicies(auth)`, `PARTNER_WIDE_WRITE_DENIED_MESSAGE` from `../services/partnerWideAccess`; `ssoProviders.partnerId` from Task 1.
- Produces: `createProviderSchema` gains `ownerScope: z.enum(['organization','partner']).default('organization')`; helpers `canAccessProviderRow(auth, row): boolean` and `canWriteProviderRow(auth, row): boolean` (also consumed by Tasks 5-7); partner-axis rows created with `orgId: null, partnerId: auth.partnerId`.

- [ ] **Step 1: Write failing route tests**

Extend `sso.test.ts` (Drizzle mock pattern per the `breeze-testing` skill; mirror the file's existing mocks) with:

```ts
describe('partner-axis provider CRUD (#2183)', () => {
  it('creates a partner-axis provider for ownerScope=partner with orgAccess=all', async () => {
    // auth mock: scope 'partner', partnerId 'p-1', partnerOrgAccess 'all'
    // POST /providers { ownerScope: 'partner', name, type: 'oidc', ... }
    // expect 201; inserted values orgId: null, partnerId: 'p-1'
  });
  it('403s ownerScope=partner when partnerOrgAccess is not all', async () => {
    // partnerOrgAccess 'selected' → 403 with PARTNER_WIDE_WRITE_DENIED_MESSAGE
  });
  it('400s a partner-axis defaultRoleId that is not a partner-scoped role of the caller partner', async () => {});
  it('rejects ownerScope on update (schema omits it)', async () => {
    // PATCH body { ownerScope: 'partner' } → zod strips/rejects; axis unchanged
  });
  it('does not accept partnerId from the request body', async () => {
    // POST { ownerScope:'partner', partnerId:'p-EVIL' } → row still created with token partnerId 'p-1'
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test --filter=@breeze/api -- routes/sso
```
Expected: FAIL (ownerScope unknown key / handlers missing partner branch).

- [ ] **Step 3: Implement schema + create-route changes in `routes/sso.ts`**

Schema edits (at :125):

```ts
const createProviderSchema = z.object({
  ownerScope: z.enum(['organization', 'partner']).default('organization'),
  orgId: z.string().guid().optional(),
  // ...existing fields unchanged...
});

const updateProviderSchema = createProviderSchema.omit({ orgId: true, ownerScope: true }).partial();
```

Add imports:

```ts
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
```

Add row-access helpers next to `resolveOrgIdForProviderRoute` (:308):

```ts
type ProviderOwnerRow = { orgId: string | null; partnerId: string | null };

// Read access: org rows by org access; partner rows only for the same partner's
// partner/system-scope callers (org tokens never see partner-axis providers).
function canAccessProviderRow(auth: AuthContext, row: ProviderOwnerRow): boolean {
  if (row.orgId) return auth.canAccessOrg(row.orgId);
  return (auth.scope === 'system' || auth.scope === 'partner') && auth.partnerId === row.partnerId;
}

// Write access: partner-axis rows additionally require full partner org access.
function canWriteProviderRow(auth: AuthContext, row: ProviderOwnerRow): boolean {
  if (row.orgId) return auth.canAccessOrg(row.orgId);
  return auth.partnerId === row.partnerId && canManagePartnerWidePolicies(auth);
}
```

In the create handler (:434), branch before the org resolution:

```ts
  const auth = c.get('auth') as AuthContext;
  const body = c.req.valid('json');

  let ownerColumns: { orgId: string | null; partnerId: string | null };
  if (body.ownerScope === 'partner') {
    if (auth.scope !== 'partner' || !auth.partnerId) {
      return c.json({ error: 'Partner scope required for a partner-axis SSO provider' }, 400);
    }
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }
    if (body.defaultRoleId) {
      const [role] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(
          eq(roles.id, body.defaultRoleId),
          eq(roles.scope, 'partner'),
          eq(roles.partnerId, auth.partnerId)
        ))
        .limit(1);
      if (!role) {
        return c.json({ error: 'defaultRoleId must be a partner-scoped role belonging to your partner' }, 400);
      }
    }
    ownerColumns = { orgId: null, partnerId: auth.partnerId };
  } else {
    const orgResult = resolveOrgIdForProviderRoute(auth, body.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    ownerColumns = { orgId: orgResult.orgId, partnerId: null };
  }
```

…and in the `.values({...})` replace `orgId: orgResult.orgId,` with `...ownerColumns,`. The `writeRouteAudit` call keeps `orgId: provider.orgId` (nullable is fine for audit) and adds `partnerId: provider.partnerId` to `details`.

- [ ] **Step 4: Update list/get/update/delete/status handlers**

- List (:376): add a partner branch before org resolution — when `c.req.query('scope') === 'partner'`: require `auth.scope === 'partner' || auth.scope === 'system'` and `auth.partnerId`, return providers `where(eq(ssoProviders.partnerId, auth.partnerId))` with the same column projection + `partnerId`.
- Get (:416): replace `if (!auth.canAccessOrg(provider.orgId))` with `if (!canAccessProviderRow(auth, provider))`.
- Update (:525-551): select `{ id, orgId, partnerId }`; replace access check with `canWriteProviderRow`; when the body has `defaultRoleId` and the row is partner-axis, run the same partner-scoped role validation as create (against `existing.partnerId`); change the update `.where(...)` to `eq(ssoProviders.id, providerId)` only (RLS + the access check already scope it; the old `and(orgId)` clause would never match a partner row).
- Delete (:584-605) and status (:637+): same `canWriteProviderRow` swap and same `.where(eq(id))` change.
- All audit calls: `orgId: row.orgId` stays (may be null), add `partnerId` to `details`.

- [ ] **Step 5: Remove `ssoConfig` from orgs schemas**

In `apps/api/src/routes/orgs.ts` delete the `ssoConfig: z.any().optional(),` line from BOTH `createPartnerSchema` (:60) and `createOrganizationSchema` (:120 block). Grep the file for any handler line that forwards `body.ssoConfig` into an insert/update (`orgs.ts:285, :1106, :1229` per the audit) and delete those property lines too. Do NOT touch the DB columns.

- [ ] **Step 6: Run tests + typecheck**

```bash
pnpm test --filter=@breeze/api -- routes/sso
pnpm test --filter=@breeze/api -- routes/orgs
pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: PASS (orgs tests may need their `ssoConfig` fixtures deleted — update them, they were asserting a write-only field).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(sso): ownerScope on provider CRUD, partner-wide gate, drop dormant ssoConfig (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Partner login entry — `GET /sso/login/partner/:partnerId`

**Files:**
- Modify: `apps/api/src/routes/sso.ts` (insert the new route ABOVE the `/login/:orgId` handler at :904)
- Test: `apps/api/src/routes/sso.test.ts`

**Interfaces:**
- Consumes: existing `generateState/generateNonce/generatePKCEChallenge/buildAuthorizationUrl/getOIDCConfig/buildSsoStateCookie/normalizeRedirectPath` helpers, `withSystemDbAccessContext`.
- Produces: public URL shape `/api/v1/sso/login/partner/:partnerId?redirect=<path>` consumed by Task 8's `login-context` and Task 10's button.

- [ ] **Step 1: Write failing tests**

```ts
describe('GET /sso/login/partner/:partnerId', () => {
  it('404s when the partner has no active partner-axis provider', async () => {});
  it('redirects to the IdP authorization URL and sets the state cookie for an active provider', async () => {
    // mock provider row { partnerId: 'p-1', orgId: null, status: 'active', type: 'oidc', ... }
    // expect 302, Location startsWith mocked authorization URL, Set-Cookie contains breeze_sso_state
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter=@breeze/api -- routes/sso
```
Expected: FAIL (404 route not found).

- [ ] **Step 3: Implement**

Insert ABOVE the `/login/:orgId` route (:904) — Hono matches the 3-segment path first, but keeping it above documents the intent:

```ts
const partnerIdParamSchema = z.object({ partnerId: z.string().guid() });

// Initiate partner-axis SSO login (#2183) — the MSP's own technician login.
// Public route: all DB access MUST run under system context (no request scope
// exists yet; bare `db` silently returns 0 rows under RLS).
ssoRoutes.get('/login/partner/:partnerId', zValidator('param', partnerIdParamSchema), async (c) => {
  const { partnerId } = c.req.valid('param');
  const redirectUrl = normalizeRedirectPath(c.req.query('redirect'));

  const [provider] = await withSystemDbAccessContext(async () =>
    db
      .select()
      .from(ssoProviders)
      .where(and(
        eq(ssoProviders.partnerId, partnerId),
        eq(ssoProviders.status, 'active')
      ))
      .limit(1)
  );

  if (!provider) {
    return c.json({ error: 'No active SSO provider for this partner' }, 404);
  }

  if (provider.type !== 'oidc') {
    return c.json({ error: 'Only OIDC login is currently supported' }, 400);
  }

  const config = getOIDCConfig(provider);
  const pkce = generatePKCEChallenge();
  const state = generateState();
  const nonce = generateNonce();

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await withSystemDbAccessContext(async () =>
    db.insert(ssoSessions).values({
      providerId: provider.id,
      state,
      nonce,
      codeVerifier: pkce.codeVerifier,
      redirectUrl,
      expiresAt
    })
  );

  const authUrl = buildAuthorizationUrl({
    config,
    state,
    nonce,
    redirectUri: buildSsoCallbackUri(),
    pkce
  });

  const stateCookie = buildSsoStateCookie(state);
  if (!stateCookie) {
    return c.json({ error: 'SSO login binding secret is not configured on this instance' }, 500);
  }
  c.header('Set-Cookie', stateCookie, { append: true });

  return c.redirect(authUrl);
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter=@breeze/api -- routes/sso
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts
git commit -m "feat(sso): partner-axis login initiation route (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Callback partner-axis branch — identity-first resolution, `scope:'partner'` tokens

**Files:**
- Modify: `apps/api/src/routes/sso.ts` (`GET /callback`, :971-1402)
- Test: `apps/api/src/routes/sso.test.ts`

**Interfaces:**
- Consumes: `partnerUsers` from `../db/schema` (add to the schema import at :8-17), `isNull` from `drizzle-orm` (add to import at :4), `auditLogin` from `./auth/helpers` (add import).
- Produces: partner-axis token payload `{ sub, email, roleId, orgId: null, partnerId, scope: 'partner', mfa }`; error reason codes `invite_required`, `no_partner_access` (+ existing `sso_link_required`, `invalid_role_scope`, `invalid_provider_configuration`).

**Safety rationale:** email auto-link keeps the org flow's safe-link conditions — auto-link only when the matched user has NO password and NO link to a different provider; otherwise redirect `sso_link_required`. Unconditional email-linking is the account-takeover surface the org flow deliberately closed (a partner admin repointing the IdP could assert another tech's email and capture their account). Password-holding users connect their identity through the authenticated self-service **Connect SSO** flow (Task 6); the `sso_link_required` error copy on the login page points them there (Task 6 Step 6).

- [ ] **Step 1: Write failing callback tests**

Model mocks on the file's existing callback tests (state cookie + session + provider + IdP token mocks). New cases:

```ts
describe('SSO callback — partner axis (#2183)', () => {
  it('logs in linked partner staff with scope partner and null orgId', async () => {
    // provider { partnerId: 'p-1', orgId: null }, user_sso_identities link exists,
    // partner_users membership role scope 'partner'
    // expect redirect #ssoCode=..., createTokenPair called with
    // { orgId: null, partnerId: 'p-1', scope: 'partner' }
  });
  it('auto-links by email ONLY for passwordless unlinked partner staff', async () => {
    // users row: partnerId p-1, orgId null, passwordHash null, no other link → linked + logged in
  });
  it('redirects sso_link_required for a password-holding email match', async () => {});
  it('never resolves an org-bound user through a partner provider', async () => {
    // users row with same email but orgId set → redirect invite_required
  });
  it('redirects invite_required for unknown identities (no JIT)', async () => {});
  it('redirects no_partner_access when the user has no partner_users membership', async () => {});
  it('rejects a partner provider whose defaultRoleId is not partner-scoped', async () => {
    // → redirect invalid_provider_configuration
  });
  it('sets mfa true only with trustsIdpMfa AND amr mfa', async () => {});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter=@breeze/api -- routes/sso
```
Expected: FAIL.

- [ ] **Step 3: Implement the axis branch**

3a. Default-role validation (:1034-1054) becomes axis-aware:

```ts
  let validatedDefaultRoleId: string | null = null;
  if (provider.defaultRoleId) {
    const roleCondition = provider.partnerId
      ? and(
          eq(roles.id, provider.defaultRoleId),
          eq(roles.scope, 'partner'),
          eq(roles.partnerId, provider.partnerId)
        )
      : and(
          eq(roles.id, provider.defaultRoleId),
          eq(roles.scope, 'organization'),
          eq(roles.orgId, provider.orgId!)
        );
    const [defaultRole] = await withSystemDbAccessContext(async () =>
      db.select({ id: roles.id }).from(roles).where(roleCondition).limit(1)
    );
    if (!defaultRole) {
      clearStateCookie();
      return c.redirect('/login?error=invalid_provider_configuration');
    }
    validatedDefaultRoleId = defaultRole.id;
  }
```

(Note: v1 never APPLIES `validatedDefaultRoleId` on the partner axis — it is config validation only; the org JIT branch still uses it.)

3b. Domain-verification gate (:1162-1174): org-axis only — wrap the existing block in `if (!user && provider.orgId) { ... }` (it gates JIT/link-by-email for orgs; partner axis has no JIT and its email-match is restricted to the partner's own staff pool below).

3c. Email-match branch (:1176-1206): make the lookup axis-aware, keep the safety conditions verbatim:

```ts
      const emailCondition = provider.partnerId
        ? and(
            eq(users.email, attrs.email.toLowerCase()),
            eq(users.partnerId, provider.partnerId),
            isNull(users.orgId)
          )
        : eq(users.email, attrs.email.toLowerCase());
      const [byEmail] = await withSystemDbAccessContext(async () =>
        db.select().from(users).where(emailCondition).limit(1)
      );
```

3d. JIT block (:1208-1265): partner axis never provisions — insert at the top:

```ts
    if (!user && provider.partnerId) {
      clearStateCookie();
      return c.redirect('/login?error=invite_required');
    }
```

3e. Membership + token (:1267-1292 and :1362-1370): branch on axis:

```ts
    let tokenPayload: Parameters<typeof createTokenPair>[0];
    if (provider.partnerId) {
      const providerPartnerId = provider.partnerId;
      const [partnerMembership] = await withSystemDbAccessContext(async () =>
        db
          .select({ roleId: partnerUsers.roleId, roleScope: roles.scope })
          .from(partnerUsers)
          .innerJoin(roles, eq(roles.id, partnerUsers.roleId))
          .where(and(
            eq(partnerUsers.userId, user.id),
            eq(partnerUsers.partnerId, providerPartnerId)
          ))
          .limit(1)
      );
      if (!partnerMembership) {
        clearStateCookie();
        return c.redirect('/login?error=no_partner_access');
      }
      if (partnerMembership.roleScope !== 'partner') {
        clearStateCookie();
        return c.redirect('/login?error=invalid_role_scope');
      }
      tokenPayload = {
        sub: user.id,
        email: user.email,
        roleId: partnerMembership.roleId,
        orgId: null,
        partnerId: providerPartnerId,
        scope: 'partner' as const,
        mfa: ssoMfa
      };
    } else {
      // existing org branch: orgUser lookup + roleScope check + existing payload, unchanged
    }
```

(The `ssoMfa` computation at :1360 is axis-independent — leave it where it is, above this branch.)

3f. Audit: after the successful token mint (near :1389), add for the partner axis:

```ts
    if (provider.partnerId) {
      auditLogin(c, user, { method: 'sso-partner', mfa: ssoMfa, scope: 'partner' });
    }
```

(Match `auditLogin`'s exact signature at `routes/auth/helpers.ts:704` — adjust argument shape to it, keeping `method: 'sso-partner'`.)

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm test --filter=@breeze/api -- routes/sso
pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: PASS, including all pre-existing org callback tests (the org path behavior must be byte-for-byte unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts
git commit -m "feat(sso): partner-axis callback — identity-first login, scope:partner tokens (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Self-service "Connect SSO" link flow (authenticated identity linking)

**Files:**
- Modify: `apps/api/src/routes/sso.ts` (new authenticated routes + link-mode branch at the top of `GET /callback`)
- Modify: `apps/web/src/components/settings/ProfileSecurityPage.tsx` — or whichever component renders the user's own security settings; locate it via `grep -rn "mfa" apps/web/src/pages/settings/profile.astro` and follow the import; add `ConnectSsoCard` there
- Create: `apps/web/src/components/settings/ConnectSsoCard.tsx` + `ConnectSsoCard.test.tsx`
- Test: `apps/api/src/routes/sso.test.ts`

**Interfaces:**
- Consumes: Task 1's `ssoSessions.linkUserId`; Task 5's callback structure; existing `buildSsoStateCookie`/`generateState`/`generateNonce`/`generatePKCEChallenge`/`buildAuthorizationUrl`/`getOIDCConfig`; `authMiddleware`, `requireMfa` from `../middleware/auth`; `writeRouteAudit`; web `runAction`.
- Produces: `GET /sso/link/options` → `{ data: Array<{ id, name, type, linked: boolean }> }`; `POST /sso/link/start/:providerId` → `{ authUrl: string }` (+ sets the state cookie); callback link-mode redirect `→ /settings/profile?ssoLinked=1` on success, `?ssoLinkError=<reason>` on failure. Login-page error copy for `sso_link_required` points at Profile → Security → Connect SSO.

**Why:** password-holding users are never auto-linked (Task 5 safety conditions), so without this flow existing technicians could never adopt SSO. Settled with Todd 2026-07-03. Works for BOTH axes: an org user links an org-axis provider; a partner-staff user links a partner-axis provider.

- [ ] **Step 1: Write failing API tests**

Extend `sso.test.ts`:

```ts
describe('Connect SSO link flow (#2183)', () => {
  it('GET /sso/link/options lists providers the user can link with linked flags', async () => {
    // org user (orgId o-1) → org-axis providers of o-1 (status active|testing);
    // partner-staff user (orgId null, partnerId p-1) → partner-axis providers of p-1.
    // linked: true when a user_sso_identities row exists for (user, provider).
  });
  it('POST /sso/link/start/:providerId returns authUrl and sets the state cookie', async () => {
    // expect res.json().authUrl startsWith mocked authorization URL,
    // Set-Cookie contains breeze_sso_state, and the inserted sso_sessions row
    // has linkUserId === auth.user.id
  });
  it('link/start 401s unauthenticated and 428/403s without MFA (requireMfa)', async () => {});
  it('link/start 403s a provider outside the user axis pool', async () => {
    // org user + partner-axis provider → 403; partner user + other partner → 403
  });
  it('callback in link mode creates the identity for the SESSION user after verification', async () => {
    // session row { linkUserId: 'u-1' }, verified id_token email === u-1.email
    // → user_sso_identities insert { userId: 'u-1', providerId, externalId: sub },
    //   NO createTokenPair call, redirect /settings/profile?ssoLinked=1
  });
  it('callback link mode rejects an email mismatch', async () => {
    // asserted email !== linking user's email → redirect ?ssoLinkError=email_mismatch, no insert
  });
  it('callback link mode rejects a (provider, sub) already linked to another user', async () => {
    // → redirect ?ssoLinkError=identity_in_use, no insert
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter=@breeze/api -- routes/sso
```
Expected: FAIL (routes missing; callback has no link branch).

- [ ] **Step 3: Implement the authenticated link routes in `routes/sso.ts`**

Place with the other authenticated routes (below the provider CRUD, above the public login flow):

```ts
// ============================================
// Self-service Connect SSO (authenticated identity linking, #2183)
// ============================================

// Providers the current user may link, with linked status.
ssoRoutes.get('/link/options', authMiddleware, async (c) => {
  const auth = c.get('auth') as AuthContext;

  const axisCondition = auth.user.orgId
    ? eq(ssoProviders.orgId, auth.user.orgId)
    : auth.partnerId
      ? eq(ssoProviders.partnerId, auth.partnerId)
      : null;
  if (!axisCondition) {
    return c.json({ data: [] });
  }

  const providers = await db
    .select({
      id: ssoProviders.id,
      name: ssoProviders.name,
      type: ssoProviders.type,
      linkedId: userSsoIdentities.id
    })
    .from(ssoProviders)
    .leftJoin(userSsoIdentities, and(
      eq(userSsoIdentities.providerId, ssoProviders.id),
      eq(userSsoIdentities.userId, auth.user.id)
    ))
    .where(and(axisCondition, ne(ssoProviders.status, 'inactive')));

  return c.json({
    data: providers.map((p) => ({ id: p.id, name: p.name, type: p.type, linked: !!p.linkedId }))
  });
});

// Start a link-mode IdP round-trip. requireMfa(): linking an SSO identity is a
// security-sensitive account change (it adds a login credential).
ssoRoutes.post(
  '/link/start/:providerId',
  authMiddleware,
  requireMfa(),
  zValidator('param', z.object({ providerId: z.string().guid() })),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { providerId } = c.req.valid('param');

    const [provider] = await db
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.id, providerId))
      .limit(1);

    if (!provider || provider.status === 'inactive') {
      return c.json({ error: 'Provider not found' }, 404);
    }

    // Axis pool check: the user must belong to the provider's owner tenant.
    const inPool = provider.orgId
      ? auth.user.orgId === provider.orgId
      : auth.user.orgId === null && auth.partnerId === provider.partnerId;
    if (!inPool) {
      return c.json({ error: 'You cannot link this SSO provider' }, 403);
    }

    if (provider.type !== 'oidc') {
      return c.json({ error: 'Only OIDC linking is currently supported' }, 400);
    }

    const config = getOIDCConfig(provider);
    const pkce = generatePKCEChallenge();
    const state = generateState();
    const nonce = generateNonce();

    await db.insert(ssoSessions).values({
      providerId: provider.id,
      state,
      nonce,
      codeVerifier: pkce.codeVerifier,
      redirectUrl: '/settings/profile',
      linkUserId: auth.user.id,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });

    const authUrl = buildAuthorizationUrl({
      config,
      state,
      nonce,
      redirectUri: buildSsoCallbackUri(),
      pkce
    });

    const stateCookie = buildSsoStateCookie(state);
    if (!stateCookie) {
      return c.json({ error: 'SSO login binding secret is not configured on this instance' }, 500);
    }
    c.header('Set-Cookie', stateCookie, { append: true });

    writeRouteAudit(c, {
      orgId: provider.orgId,
      action: 'sso.identity.link_started',
      resourceType: 'sso_provider',
      resourceId: provider.id,
      resourceName: provider.name,
      details: { partnerId: provider.partnerId }
    });

    return c.json({ authUrl });
  }
);
```

(This route runs authenticated, so bare `db` is fine here — RLS scopes it to the caller's tenant; the axis-pool check is defense-in-depth on top.)

- [ ] **Step 4: Implement the callback link-mode branch**

In `GET /callback`, immediately after the provider row is loaded and the id_token is fully verified (after the `sub`/`attrs.email` extraction, BEFORE the login-path identity resolution — i.e. right before the `let user = await withSystemDbAccessContext(...)` block), insert:

```ts
    // ── Link mode (#2183 Connect SSO): this round-trip belongs to an
    // already-authenticated user connecting their identity — never a login.
    if (session.linkUserId) {
      const outcome = await withSystemDbAccessContext(async () => {
        const [linkingUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, session.linkUserId!))
          .limit(1);
        if (!linkingUser) return { error: 'user_gone' as const };

        // The verified assertion must be for the SAME person: asserted email
        // must equal the linking user's email. Without this, a user could bind
        // an arbitrary IdP account (or a phished consent) to their session.
        if (attrs.email.toLowerCase() !== linkingUser.email.toLowerCase()) {
          return { error: 'email_mismatch' as const };
        }

        // (provider, sub) must not already belong to someone else.
        const [existing] = await db
          .select({ id: userSsoIdentities.id, userId: userSsoIdentities.userId })
          .from(userSsoIdentities)
          .where(and(
            eq(userSsoIdentities.providerId, provider.id),
            eq(userSsoIdentities.externalId, externalSub)
          ))
          .limit(1);
        if (existing && existing.userId !== linkingUser.id) {
          return { error: 'identity_in_use' as const };
        }

        if (!existing) {
          await db.insert(userSsoIdentities).values({
            userId: linkingUser.id,
            providerId: provider.id,
            externalId: externalSub,
            email: attrs.email,
            profile: userInfo,
            accessToken: encryptSecret(tokens.access_token),
            refreshToken: encryptSecret(tokens.refresh_token),
            tokenExpiresAt: tokens.expires_in
              ? new Date(Date.now() + tokens.expires_in * 1000)
              : null,
            lastLoginAt: null
          });
        }
        return { ok: true as const };
      });

      clearStateCookie();
      if ('error' in outcome) {
        return c.redirect(`/settings/profile?ssoLinkError=${outcome.error}`);
      }
      writeRouteAudit(c, {
        orgId: provider.orgId,
        action: 'sso.identity.linked',
        resourceType: 'sso_provider',
        resourceId: provider.id,
        resourceName: provider.name,
        details: { partnerId: provider.partnerId, userId: session.linkUserId }
      });
      return c.redirect('/settings/profile?ssoLinked=1');
    }
```

Ordering constraints this placement guarantees: the state cookie + atomic session claim + full id_token signature/nonce verification + userinfo `sub` binding + allowedDomains check all run BEFORE link mode is considered; link mode never mints tokens and never touches the login path's user resolution. Note `attrs`/`externalSub`/`userInfo`/`tokens` are already in scope at this point in the handler.

- [ ] **Step 5: Run API tests**

```bash
pnpm test --filter=@breeze/api -- routes/sso
pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: PASS, org login-path tests unchanged.

- [ ] **Step 6: Web — `ConnectSsoCard` + login error copy**

Write the failing test first (`ConnectSsoCard.test.tsx`, jsdom):

```tsx
// - renders one row per provider from GET /sso/link/options with a
//   "Connect" button (or a "Connected" badge when linked)
// - clicking Connect triggers runAction wrapping POST /sso/link/start/:id and
//   on success navigates to the returned authUrl (assert window.location.assign
//   spy called with authUrl)
// - shows a success toast/banner when the page loads with ?ssoLinked=1 and an
//   error state for ?ssoLinkError=email_mismatch
```

Run `pnpm test --filter=@breeze/web -- ConnectSsoCard` → FAIL, then implement:

```tsx
import { useEffect, useState } from 'react';
import { runAction } from '../../lib/runAction';

type LinkOption = { id: string; name: string; type: string; linked: boolean };

export default function ConnectSsoCard() {
  const [options, setOptions] = useState<LinkOption[]>([]);
  const apiHost = import.meta.env.PUBLIC_API_URL || '';

  useEffect(() => {
    fetch(`${apiHost}/api/v1/sso/link/options`, { credentials: 'include', headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((body) => setOptions(body.data ?? []))
      .catch(() => setOptions([]));
  }, []);

  async function connect(providerId: string) {
    await runAction({
      request: () =>
        fetch(`${apiHost}/api/v1/sso/link/start/${providerId}`, {
          method: 'POST',
          credentials: 'include',
          headers: authHeaders()
        }),
      successMessage: 'Redirecting to your identity provider…',
      errorMessage: 'Could not start SSO linking',
      onSuccess: (body: { authUrl: string }) => window.location.assign(body.authUrl)
    });
  }

  if (options.length === 0) return null;
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Single sign-on</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Connect your identity provider account to sign in with SSO.
      </p>
      <ul className="mt-3 space-y-2">
        {options.map((o) => (
          <li key={o.id} className="flex items-center justify-between text-sm">
            <span>{o.name}</span>
            {o.linked
              ? <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Connected</span>
              : <button type="button" onClick={() => connect(o.id)} className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted" data-testid={`connect-sso-${o.id}`}>Connect</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

(Match `runAction`'s actual option names and the security page's existing `authHeaders`/fetch conventions.) Mount it in the user's own security/profile settings component (found via the grep in **Files**), and add `?ssoLinked=1` / `?ssoLinkError=` banner handling there.

Login error copy: in `LoginPage.tsx`'s error-message mapping (grep `sso_link_required` — added to the map if absent), set the copy to: `"This account already has a password. Sign in with your password, then connect SSO under Profile → Security."`

- [ ] **Step 7: Run web tests**

```bash
pnpm test --filter=@breeze/web -- ConnectSsoCard
pnpm test --filter=@breeze/web -- no-silent-mutations
```
Expected: PASS (runAction usage; no allowlist entry).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts apps/web/src/components/settings/ConnectSsoCard.tsx apps/web/src/components/settings/ConnectSsoCard.test.tsx apps/web/src/components/settings/ apps/web/src/components/auth/LoginPage.tsx
git commit -m "feat(sso): self-service Connect SSO identity linking (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `enforceSSO` for partner staff (ssoPolicy partner branch)

**Files:**
- Modify: `apps/api/src/routes/auth/ssoPolicy.ts`
- Test: `apps/api/src/routes/auth/ssoPolicy.test.ts` (create alongside if absent)

**Interfaces:**
- Consumes: `ssoProviders.partnerId` (Task 1).
- Produces: `isPasswordAuthDisabledBySso(context)` now accepts `Pick<UserTokenContext, 'scope' | 'orgId' | 'partnerId'>`. Callers (grep `assertPasswordAuthAllowedBySso` / `isPasswordAuthDisabledBySso` across `routes/auth/`) must pass `partnerId` — update every call site found.

- [ ] **Step 1: Write failing tests**

```ts
describe('isPasswordAuthDisabledBySso — partner scope (#2183)', () => {
  it('true for partner-scope context when an active enforceSSO partner provider exists', async () => {});
  it('false when the partner provider is testing (break-glass preserved)', async () => {});
  it('false for partner scope with no partner provider', async () => {});
  it('org behavior unchanged', async () => {});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter=@breeze/api -- ssoPolicy
```
Expected: FAIL (partnerId not accepted / branch missing).

- [ ] **Step 3: Implement**

```ts
export async function isPasswordAuthDisabledBySso(
  context: Pick<UserTokenContext, 'scope' | 'orgId' | 'partnerId'>
): Promise<boolean> {
  if (context.scope === 'organization' && context.orgId) {
    const orgId = context.orgId;
    const [provider] = await withSystemDbAccessContext(async () =>
      db
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(and(
          eq(ssoProviders.orgId, orgId),
          eq(ssoProviders.status, 'active'),
          eq(ssoProviders.enforceSSO, true)
        ))
        .limit(1)
    );
    return Boolean(provider);
  }

  if (context.scope === 'partner' && context.partnerId) {
    const partnerId = context.partnerId;
    const [provider] = await withSystemDbAccessContext(async () =>
      db
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(and(
          eq(ssoProviders.partnerId, partnerId),
          eq(ssoProviders.status, 'active'),
          eq(ssoProviders.enforceSSO, true)
        ))
        .limit(1)
    );
    return Boolean(provider);
  }

  return false;
}
```

Update `assertPasswordAuthAllowedBySso`'s `Pick<>` the same way, and every caller to include `partnerId` in the context object it passes.

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter=@breeze/api -- ssoPolicy
pnpm test --filter=@breeze/api -- routes/auth
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/
git commit -m "feat(auth): enforceSSO suppresses password login for partner staff (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Public `GET /auth/login-context`

**Files:**
- Create: `apps/api/src/routes/auth/loginContext.ts`
- Modify: `apps/api/src/routes/auth/index.ts` (import + `authRoutes.route('/', loginContextRoutes);`)
- Test: `apps/api/src/routes/auth/loginContext.test.ts`

**Interfaces:**
- Consumes: `partners`, `ssoProviders`, `partnerLoginBranding` schema; `rateLimiter(redis, key, limit, windowSeconds)` + `getRedis` (same import path as `routes/auth/login.ts`); `getTrustedClientIp` from `../../services/clientIp`.
- Produces: response shape consumed verbatim by Task 10's web lib:
  `{ branding: { logoUrl: string|null, accentColor: string|null, headline: string|null } | null, partnerSso: { available: true, providerName: string, loginUrl: string } | null }`

- [ ] **Step 1: Write failing tests**

```ts
describe('GET /auth/login-context (#2183)', () => {
  it('returns branding + partnerSso on a single-partner instance with both configured', async () => {});
  it('returns branding null / partnerSso null when neither is configured (single partner)', async () => {});
  it('returns all-null on a multi-partner instance (no tenant leakage)', async () => {});
  it('omits provider config beyond name + loginUrl', async () => {});
  it('429s past the rate limit', async () => {});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter=@breeze/api -- loginContext
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `loginContext.ts`**

```ts
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, ssoProviders, partnerLoginBranding } from '../../db/schema';
import { getTrustedClientIp } from '../../services/clientIp';
// rateLimiter + getRedis: import from the same modules routes/auth/login.ts uses.
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';

export const loginContextRoutes = new Hono();

// Public, unauthenticated. Single-partner (self-hosted) fast-path only: on a
// multi-partner instance this endpoint deliberately reveals NOTHING (#2183
// tenant-leakage constraint). The future /login/:partnerSlug variant returns
// the same shape resolved by slug.
loginContextRoutes.get('/login-context', async (c) => {
  const redis = getRedis();
  if (redis) {
    const check = await rateLimiter(redis, `login-context:${getTrustedClientIp(c)}`, 30, 60);
    if (!check.allowed) {
      return c.json({ error: 'Too many requests' }, 429);
    }
  }

  const context = await withSystemDbAccessContext(async () => {
    const partnerRows = await db.select({ id: partners.id }).from(partners).limit(2);
    if (partnerRows.length !== 1 || !partnerRows[0]) {
      return { branding: null, partnerSso: null };
    }
    const partnerId = partnerRows[0].id;

    const [brandingRow] = await db
      .select({
        logoUrl: partnerLoginBranding.logoUrl,
        accentColor: partnerLoginBranding.accentColor,
        headline: partnerLoginBranding.headline
      })
      .from(partnerLoginBranding)
      .where(eq(partnerLoginBranding.partnerId, partnerId))
      .limit(1);

    const [provider] = await db
      .select({ name: ssoProviders.name })
      .from(ssoProviders)
      .where(and(
        eq(ssoProviders.partnerId, partnerId),
        eq(ssoProviders.status, 'active')
      ))
      .limit(1);

    return {
      branding: brandingRow ?? null,
      partnerSso: provider
        ? {
            available: true as const,
            providerName: provider.name,
            loginUrl: `/api/v1/sso/login/partner/${partnerId}`
          }
        : null
    };
  });

  c.header('Cache-Control', 'public, max-age=60');
  return c.json(context);
});
```

(If `getRedis`/`rateLimiter` live at different paths than shown, match the imports in `routes/auth/login.ts` exactly.)

Mount in `routes/auth/index.ts`: `import { loginContextRoutes } from './loginContext';` + `authRoutes.route('/', loginContextRoutes);`

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter=@breeze/api -- loginContext
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/loginContext.ts apps/api/src/routes/auth/loginContext.test.ts apps/api/src/routes/auth/index.ts
git commit -m "feat(auth): public login-context endpoint with single-partner fast-path (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Partner login-branding API — `GET/PUT /partners/me/login-branding`

**Files:**
- Create: `apps/api/src/routes/partnerLoginBranding.ts`
- Modify: `apps/api/src/routes/index.ts` (mount next to the other partner-scoped routes; grep for where `ssoRoutes` is mounted at :825 and follow the same style)
- Test: `apps/api/src/routes/partnerLoginBranding.test.ts`

**Interfaces:**
- Consumes: `partnerLoginBranding` schema, `canManagePartnerWidePolicies` + `PARTNER_WIDE_WRITE_DENIED_MESSAGE`, `authMiddleware`/`requireScope`, `writeRouteAudit`.
- Produces: `GET /partners/me/login-branding` → `{ data: { logoUrl, accentColor, headline } | null }`; `PUT` upserts and returns `{ data: {...} }`. Consumed by Task 11's settings card.

- [ ] **Step 1: Write failing tests**

```ts
describe('partner login branding routes (#2183)', () => {
  it('GET returns null data when unset', async () => {});
  it('PUT upserts for a partner admin with orgAccess=all', async () => {});
  it('PUT 403s without canManagePartnerWidePolicies', async () => {});
  it('PUT 400s a non-hex accentColor', async () => {});
  it('PUT 400s a logoUrl that is neither https:// nor data:image/', async () => {});
  it('PUT 400s a headline over 120 chars', async () => {});
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test --filter=@breeze/api -- partnerLoginBranding
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partnerLoginBranding } from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { writeRouteAudit } from '../services/auditEvents';

export const partnerLoginBrandingRoutes = new Hono();

const brandingSchema = z.object({
  logoUrl: z.string().max(400_000)
    .refine((v) => v.startsWith('https://') || v.startsWith('data:image/'), {
      message: 'logoUrl must be an https:// URL or a data:image/ URI'
    })
    .nullable().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accentColor must be a #rrggbb hex color')
    .nullable().optional(),
  headline: z.string().max(120).nullable().optional()
});

partnerLoginBrandingRoutes.get('/me/login-branding', authMiddleware, requireScope('partner'), async (c) => {
  const auth = c.get('auth') as AuthContext;
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);

  const [row] = await db
    .select({
      logoUrl: partnerLoginBranding.logoUrl,
      accentColor: partnerLoginBranding.accentColor,
      headline: partnerLoginBranding.headline
    })
    .from(partnerLoginBranding)
    .where(eq(partnerLoginBranding.partnerId, auth.partnerId))
    .limit(1);

  return c.json({ data: row ?? null });
});

partnerLoginBrandingRoutes.put(
  '/me/login-branding',
  authMiddleware,
  requireScope('partner'),
  zValidator('json', brandingSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const body = c.req.valid('json');
    const [row] = await db
      .insert(partnerLoginBranding)
      .values({
        partnerId: auth.partnerId,
        logoUrl: body.logoUrl ?? null,
        accentColor: body.accentColor ?? null,
        headline: body.headline ?? null
      })
      .onConflictDoUpdate({
        target: partnerLoginBranding.partnerId,
        set: {
          logoUrl: body.logoUrl ?? null,
          accentColor: body.accentColor ?? null,
          headline: body.headline ?? null,
          updatedAt: new Date()
        }
      })
      .returning({
        logoUrl: partnerLoginBranding.logoUrl,
        accentColor: partnerLoginBranding.accentColor,
        headline: partnerLoginBranding.headline
      });

    writeRouteAudit(c, {
      orgId: null,
      action: 'partner.login_branding.update',
      resourceType: 'partner_login_branding',
      resourceId: auth.partnerId,
      details: { partnerId: auth.partnerId, changedFields: Object.keys(body) }
    });

    return c.json({ data: row });
  }
);
```

Mount in `apps/api/src/routes/index.ts` under the same base path the existing `/partners` routes use (grep `'/partners'`) so the final URLs are `GET/PUT /api/v1/partners/me/login-branding`. If `writeRouteAudit`'s type requires a non-null `orgId`, follow whatever pattern existing partner-level audits use (grep `writeRouteAudit` for a null-orgId caller) rather than inventing one.

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter=@breeze/api -- partnerLoginBranding
pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/partnerLoginBranding.ts apps/api/src/routes/partnerLoginBranding.test.ts apps/api/src/routes/index.ts
git commit -m "feat(api): partner login-branding CRUD (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Web — login-context client, branded shell island, partner SSO button

**Files:**
- Create: `apps/web/src/lib/loginContext.ts`
- Create: `apps/web/src/components/auth/AuthPanelBranding.tsx`
- Modify: `apps/web/src/layouts/AuthShellBranded.astro` (replace the static left panel :37-100 with the island)
- Modify: `apps/web/src/components/auth/LoginPage.tsx` (SSO button)
- Test: `apps/web/src/components/auth/AuthPanelBranding.test.tsx`, extend `apps/web/src/components/auth/LoginPage.test.tsx` if present

**Interfaces:**
- Consumes: Task 8's response shape.
- Produces: `getLoginContext(): Promise<LoginContext>` (module-memoized — one fetch shared by the panel island and LoginPage).

- [ ] **Step 1: Write `lib/loginContext.ts`**

```ts
export type LoginContextBranding = {
  logoUrl: string | null;
  accentColor: string | null;
  headline: string | null;
};

export type LoginContext = {
  branding: LoginContextBranding | null;
  partnerSso: { available: boolean; providerName: string; loginUrl: string } | null;
};

const EMPTY: LoginContext = { branding: null, partnerSso: null };

let cached: Promise<LoginContext> | null = null;

/** Memoized: the branded panel island and LoginPage share one request. */
export function getLoginContext(): Promise<LoginContext> {
  if (!cached) cached = fetchLoginContext();
  return cached;
}

async function fetchLoginContext(): Promise<LoginContext> {
  try {
    const apiHost = import.meta.env.PUBLIC_API_URL || '';
    // Same timeout rationale as the CF Access check (LoginPage.tsx:38-58):
    // a hung request must not stall the login page.
    const res = await fetch(`${apiHost}/api/v1/auth/login-context`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return EMPTY;
    const body = (await res.json()) as Partial<LoginContext>;
    return { branding: body.branding ?? null, partnerSso: body.partnerSso ?? null };
  } catch {
    return EMPTY; // fail open to stock Breeze branding
  }
}
```

- [ ] **Step 2: Write failing component test**

```tsx
// AuthPanelBranding.test.tsx (jsdom): mock ../../lib/loginContext getLoginContext.
// Case 1: resolves { branding: null } → stock content: "Breeze" wordmark,
//   "Effortless endpoint" heading, "10,000+ endpoints" marketing block present.
// Case 2: resolves { branding: { logoUrl: 'https://x/logo.png', accentColor: '#112233',
//   headline: 'Acme IT' } } → await screen.findByText('Acme IT'); marketing copy
//   ("10,000+ endpoints") ABSENT; img[data-testid="partner-logo"] present;
//   panel style backgroundColor reflects #112233.
```

Run: `pnpm test --filter=@breeze/web -- AuthPanelBranding` — expected FAIL (component missing).

- [ ] **Step 3: Implement `AuthPanelBranding.tsx`**

React island rendering the ENTIRE left-panel content. Initial render = current stock markup (copy the JSX structure from `AuthShellBranded.astro:38-99`, converted to TSX: `class` → `className`, keep the inline SVG logo + three marketing blocks). On mount, `getLoginContext()`; when `branding` is non-null:

```tsx
import { useEffect, useState } from 'react';
import { getLoginContext, type LoginContextBranding } from '../../lib/loginContext';
import { sanitizeImageSrc } from '../../lib/safeImageSrc';

export default function AuthPanelBranding({ tagline }: { tagline: string }) {
  const [branding, setBranding] = useState<LoginContextBranding | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLoginContext().then((ctx) => {
      if (!cancelled && ctx.branding) setBranding(ctx.branding);
    });
    return () => { cancelled = true; };
  }, []);

  const panelStyle = branding?.accentColor ? { backgroundColor: branding.accentColor } : undefined;
  const safeLogo = branding?.logoUrl ? sanitizeImageSrc(branding.logoUrl) : null;

  return (
    <div className="hidden u-w-pct-42 flex-col justify-between bg-[hsl(225,62%,48%)] p-10 text-white md:flex lg:p-14" style={panelStyle}>
      <div className="flex items-center gap-3">
        {safeLogo
          ? <img src={safeLogo} alt="" data-testid="partner-logo" className="h-8 max-w-[180px] object-contain" />
          : (/* stock inline Breeze SVG + wordmark, copied from AuthShellBranded.astro:41-46 */)}
      </div>
      <div className="space-y-10">
        <div>
          <h2 className="text-2xl font-bold leading-snug tracking-tight lg:text-3xl">
            {branding?.headline ?? <>Effortless endpoint<br />management</>}
          </h2>
          {!branding && <p className="mt-3 text-sm leading-relaxed text-white/70">{tagline}</p>}
        </div>
        {!branding && (/* the three stock marketing feature blocks, copied verbatim */)}
      </div>
      <p className="text-xs text-white/40">&copy; {new Date().getFullYear()} {branding ? '' : 'Breeze RMM'}</p>
    </div>
  );
}
```

(The two "copied" comment spots are literal copies of the existing Astro markup — no redesign. `new Date()` is fine here; this is app code, not a workflow script.)

In `AuthShellBranded.astro`, replace lines 37-100 (the whole left `<div>`) with:

```astro
<AuthPanelBranding tagline={tagline} client:load />
```

plus the frontmatter import: `import AuthPanelBranding from '../components/auth/AuthPanelBranding';`

- [ ] **Step 4: Add the partner SSO button to `LoginPage.tsx`**

State + effect (alongside the CF Access check, :38-58 pattern):

```tsx
const [partnerSso, setPartnerSso] = useState<{ providerName: string; loginUrl: string } | null>(null);

useEffect(() => {
  getLoginContext().then((ctx) => {
    if (ctx.partnerSso?.available) {
      setPartnerSso({ providerName: ctx.partnerSso.providerName, loginUrl: ctx.partnerSso.loginUrl });
    }
  });
}, []);
```

Render above the password form:

```tsx
{partnerSso && (
  <a
    href={`${partnerSso.loginUrl}${safeNext ? `?redirect=${encodeURIComponent(safeNext)}` : ''}`}
    data-testid="partner-sso-button"
    className="mb-4 flex w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
  >
    Sign in with {partnerSso.providerName}
  </a>
)}
```

- [ ] **Step 5: Run web tests + typecheck**

```bash
pnpm test --filter=@breeze/web -- AuthPanelBranding
pnpm test --filter=@breeze/web -- LoginPage
pnpm --filter @breeze/web exec astro check
```
Expected: PASS. (`astro check` covers the .astro edit; plain tsc skips .astro files.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/loginContext.ts apps/web/src/components/auth/ apps/web/src/layouts/AuthShellBranded.astro
git commit -m "feat(web): partner-branded login shell + partner SSO button (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Web admin — SSO ownership selector + Login Branding settings card

**Files:**
- Modify: `apps/web/src/components/settings/SsoProviderForm.tsx` (+ its zod schema :6-27), `apps/web/src/components/settings/SsoProviderList.tsx`, `apps/web/src/components/settings/SsoProvidersPage.tsx`
- Create: `apps/web/src/components/settings/LoginBrandingCard.tsx` + `LoginBrandingCard.test.tsx`
- Modify: `apps/web/src/pages/settings/partner.astro` (or the tab component it renders — add the card where `PartnerCompanyTab`/`PartnerAiBudgetsTab` are registered)

**Interfaces:**
- Consumes: Task 3's `ownerScope` create field + `scope=partner` list query; Task 9's `GET/PUT /partners/me/login-branding`; `runAction` from `apps/web/src/lib/runAction.ts`.

- [ ] **Step 1: Ownership selector on `SsoProviderForm`**

Add to the form's zod schema: `ownerScope: z.enum(['organization', 'partner']).optional(),` and render a create-only radio group copied from the `PolicyForm.tsx:96-105` pattern:

```tsx
{mode === 'create' && (
  <fieldset className="space-y-2">
    <legend className="text-sm font-medium">Applies to</legend>
    <label className="flex items-center gap-2 text-sm">
      <input type="radio" value="organization" {...register('ownerScope')} defaultChecked />
      This organization
    </label>
    <label className="flex items-center gap-2 text-sm">
      <input type="radio" value="partner" {...register('ownerScope')} />
      Partner (technician login) <span className="text-muted-foreground">(your own team signs in with this)</span>
    </label>
  </fieldset>
)}
```

When `ownerScope === 'partner'`, the `defaultRoleId` dropdown must load PARTNER-scoped roles instead of org roles (reuse however the form currently fetches its `Role[]` prop/list, filtered by `scope === 'partner'`). Follow the existing form's mode/props conventions — this form was only skimmed; match what's there rather than restructuring it.

- [ ] **Step 2: Badge + list wiring**

`SsoProviderList.tsx`: render a "Partner" badge on rows where `partnerId` is set (same badge classes the "All orgs" badge uses in the software policy list). `SsoProvidersPage.tsx`: when the viewer has partner scope, also fetch `GET /sso/providers?scope=partner` and merge into the list.

- [ ] **Step 3: Write failing `LoginBrandingCard` test**

```tsx
// jsdom: mock fetch/runAction. Renders three inputs (logo URL, accent color,
// headline with a 120-char maxLength), loads current values from
// GET /partners/me/login-branding, saves via runAction PUT, shows a live
// preview div whose backgroundColor is the entered accent color.
// Assert save button triggers runAction (no silent mutation).
```

Run: `pnpm test --filter=@breeze/web -- LoginBrandingCard` — expected FAIL.

- [ ] **Step 4: Implement `LoginBrandingCard.tsx`**

Form card following the settings-card conventions in `PartnerCompanyTab.tsx`: three controlled inputs (logo URL text input, `<input type="color">` + hex text for accent, headline input `maxLength={120}`), a preview block (`<div style={{ backgroundColor: accent }}>` with the headline + logo via `sanitizeImageSrc`), and:

```tsx
import { runAction } from '../../lib/runAction';

async function save() {
  await runAction({
    request: () =>
      fetch(`${apiHost}/api/v1/partners/me/login-branding`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        credentials: 'include',
        body: JSON.stringify({ logoUrl: logoUrl || null, accentColor: accentColor || null, headline: headline || null })
      }),
    successMessage: 'Login branding saved',
    errorMessage: 'Failed to save login branding'
  });
}
```

(Match `runAction`'s actual option names from `apps/web/src/lib/runAction.ts` — the shape above is representative; the requirement is that ALL mutations go through `runAction`.)

Register the card in the partner settings page next to the existing partner tabs (follow how `PartnerAiBudgetsTab` is wired into `pages/settings/partner.astro`'s tab container). Label: "Login Branding".

- [ ] **Step 5: Run tests + the silent-mutation guard**

```bash
pnpm test --filter=@breeze/web -- LoginBrandingCard
pnpm test --filter=@breeze/web -- no-silent-mutations
pnpm --filter @breeze/web exec astro check
```
Expected: PASS (runAction usage keeps the guard green; do NOT add an allowlist entry).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/ apps/web/src/pages/settings/
git commit -m "feat(web): SSO ownership selector + partner login-branding card (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Real-DB end-to-end partner login + link-flow integration test + final sweeps

**Files:**
- Create: `apps/api/src/__tests__/integration/ssoPartnerLogin.integration.test.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the integration test**

Against real Postgres (integration config), no IdP mocking of the full browser flow — test the callback's resolution + token mint by exercising the route handlers with a stubbed IdP layer, the way existing SSO integration/route tests stub `exchangeCodeForTokens`/`verifyIdTokenSignature`/`getUserInfo` (grep for existing stubs of these in the integration suite; if none exist, stub via `vi.mock('../../services/sso', ...)` keeping non-network helpers real):

```ts
// Setup (real DB): partner P with partner-scoped role R, user U
//   { partnerId: P, orgId: null, passwordHash: null } + partner_users membership
//   { partnerId: P, userId: U, roleId: R, orgAccess: 'all' },
//   active partner-axis provider (partnerId: P, trustsIdpMfa: false).
// 1. GET /sso/login/partner/:P → 302 to IdP, sso_sessions row created, state cookie set.
// 2. GET /sso/callback with matching state/cookie and stubbed IdP responses
//    asserting email = U's email → 302 redirect containing #ssoCode=.
// 3. POST /sso/exchange { code } → accessToken. Decode (jose decodeJwt):
//    payload.scope === 'partner', payload.partnerId === P, payload.orgId === null,
//    payload.roleId === R, payload.mfa === false.
// 4. Negative: second user with same email but orgId set on another partner org
//    never resolves (callback with their email-only assertion → /login?error=invite_required).
// 5. Connect SSO flow (password-holding user, real DB): user V { partnerId: P,
//    orgId: null, passwordHash: <bcrypt of anything> } + partner_users membership.
//    a. Login-path callback asserting V's email → /login?error=sso_link_required
//       (password holder is never auto-linked).
//    b. Authenticated POST /sso/link/start/:providerId as V (mfa claim true in
//       the test token) → { authUrl }, sso_sessions row has linkUserId = V.id.
//    c. Callback with that state + stubbed IdP asserting V's email →
//       redirect /settings/profile?ssoLinked=1, user_sso_identities row exists
//       for (V, provider, sub-V).
//    d. Login-path round-trip again for sub-V → NOW succeeds; decoded token
//       scope === 'partner', sub === V.id.
```

- [ ] **Step 2: Run it**

```bash
docker compose -f docker-compose.test.yml up -d
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ssoPartnerLogin.integration.test.ts
```
Expected: PASS.

- [ ] **Step 3: Full-suite sweep + drift check**

```bash
pnpm test --filter=@breeze/api
pnpm test --filter=@breeze/web
pnpm --filter @breeze/api exec tsc --noEmit
pnpm db:check-drift
```
Expected: all green. Then repo-wide call-site sweep (playbook step 7): `grep -rn "ssoProviders.orgId" apps/ packages/ --include='*.ts'` — every hit must be axis-aware or provably org-only (the org login route :904, org domain routes, and `/sso/check/:orgId` are legitimately org-only; anything else needs the Task 3/5 helpers).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/ssoPartnerLogin.integration.test.ts
git commit -m "test(sso): end-to-end partner-axis login mints scope:partner tokens (#2183)

Refs #2183

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec-coverage self-review (done during authoring)

- Spec §1 data model → Tasks 1-2 (naming deviation: `partner_login_branding`, rationale in Task 1; `sso_sessions.link_user_id` added for the Connect SSO flow). ssoConfig deprecation → Task 3 Step 5.
- Spec §2 auth flow → Tasks 4-7 (entry, callback branch, Connect SSO link flow, enforceSSO). Safe-link conditions + self-service linking settled with Todd 2026-07-03 (Task 5 rationale, Task 6).
- Spec §3 login page → Tasks 8 + 10.
- Spec §4 admin API/UI → Tasks 3, 9, 11.
- Spec §5 security → axis checks (Tasks 3/5/6), leakage (Task 8 multi-partner nulls test), escalation (write-time role validation + membership-authoritative login), linking hardening (Task 6: requireMfa initiate, email match, identity-in-use check, full verification before link), lockout (Task 7 testing-status test), audit (Tasks 3/5/6/9), rate limits (the entry route relies on the same global limits as the org route; login-context has its own limiter).
- Spec §6 testing → Tasks 2, 3, 5, 6, 7, 8, 10, 11, 12.
- Out-of-scope items untouched: no JIT, no slug route, no SCIM, no custom CSS, columns not dropped.
