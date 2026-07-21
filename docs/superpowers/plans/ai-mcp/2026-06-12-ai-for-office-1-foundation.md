# Breeze AI for Office — Plan 1: Foundation (schema, Entra auth, tenancy, policy)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the control-plane foundation for the Excel add-in: client tenancy tables with RLS, Entra ID token exchange with auto-provisioned portal users, Redis-backed client sessions, per-org policy storage + enforcement, and partner-facing admin routes for tenant mapping and policy.

**Architecture:** A new `/client-ai` route namespace (separate from technician `/ai` and `/portal`) authenticates Excel add-in users by verifying Entra ID tokens against Microsoft's common JWKS, mapping `tid` → Breeze org via `client_ai_tenant_mappings`, and upserting the user into the existing `portal_users` table. Sessions are Redis-backed bearer tokens mirroring the portal session pattern; a dedicated middleware attaches `{clientUserId, orgId}` and wraps handlers in an org-scoped `withDbAccessContext`. All new tables ship with RLS policies in the same migration (shape 1 for the three org-scoped tables, dual-axis for `client_ai_prompt_templates`).

**Tech Stack:** Hono, Drizzle, PostgreSQL RLS, jose (JWT/JWKS), Redis, Vitest

**Spec:** docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md

---

## Deviations from spec (decided during planning — already validated against the real schema)

1. **`ai_sessions` CHECK is "at most one principal", not "exactly one".** The spec (§4, §12) asks for a CHECK that exactly one of (`user_id`, `client_user_id`) is set. But `user_id` is **already nullable** (`apps/api/src/db/schema/ai.ts:27`) and rows with `user_id IS NULL` legitimately exist today: helper device sessions insert `userId: null` (`apps/api/src/routes/helper/index.ts:309-314`) and MCP ledger sessions insert a nullable userId (`apps/api/src/services/mcpToolExecutionLedger.ts:96-100`). An "exactly one" CHECK would corrupt those write paths and fail on existing rows. Instead we add two constraints: `CHECK (user_id IS NULL OR client_user_id IS NULL)` (never both) and `CHECK (type <> 'excel_client' OR client_user_id IS NOT NULL)` (client sessions always carry a client principal).
2. **`client_ai_tenant_mappings` is also unique on `org_id`** (one tenant per org in v1), because the admin route is the singular `/orgs/:orgId/tenant-mapping`. The spec only requires uniqueness on `entra_tenant_id`; the extra org uniqueness keeps GET/PUT semantics unambiguous and can be relaxed later without breaking anything.
3. **`selected_user_ids` holds `portal_users` UUIDs** and is enforced *after* upsert (the user row must exist before the MSP can select it; a denied user's row exists but cannot mint a session). Spec §3 left the key unspecified.
4. **Redis is required for client-AI sessions** (503 when unavailable) — no in-memory dev fallback like the portal's. This is a brand-new surface; every compose mode ships Redis, and skipping the fallback removes ~80 lines of sweep/cap bookkeeping.
5. **`ai_sessions.type = 'excel_client'` needs no migration** — `type` is a plain `text` column with default `'general'` (`ai.ts:30`), not an enum.

## Verification notes for workers

- Node pin: prefix every pnpm/vitest/tsc command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- The full `vitest run` suite is known-flaky in parallel on a pristine tree — verify with the **affected files only**; trust CI for the full sweep.
- `npx tsc --noEmit` has pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts` — those two are not yours.
- Integration/RLS tests need the docker test stack: `pnpm test:docker:up` (postgres on 5433, redis on 6380). The integration setup (`src/__tests__/integration/setup.ts`) runs `autoMigrate` itself, so new migration files are picked up automatically on the next test run.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/superpowers/plans/notes/2026-06-12-m365-reuse-audit.md` | Create | Output of the M365-connection reuse audit (Task 1) |
| `apps/api/migrations/2026-06-12-b-client-ai-foundation.sql` | Create | All schema: 4 new tables + RLS, `portal_users` Entra columns, `ai_sessions` client principal |
| `apps/api/src/db/schema/clientAi.ts` | Create | Drizzle definitions for the 4 `client_ai_*` tables |
| `apps/api/src/db/schema/portal.ts` | Modify (~line 34-46) | `portalUsers`: add `entraOid`, `entraTenantId`, `authMethod` |
| `apps/api/src/db/schema/ai.ts` | Modify (~line 24-53) | `aiSessions`: add `clientUserId` |
| `apps/api/src/db/schema/index.ts` | Modify (end of file) | `export * from './clientAi'` |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | Modify (~line 114) | Add `client_ai_prompt_templates` to `DUAL_AXIS_TENANT_TABLES` |
| `apps/api/src/__tests__/integration/client-ai-templates-rls.integration.test.ts` | Create | Functional `breeze_app` dual-axis insert tests (the custom_field_definitions lesson) |
| `apps/api/src/config/env.ts` | Modify (near `M365_ENABLED`, ~line 18) | `CLIENT_AI_ENTRA_CLIENT_ID` |
| `.env.example` | Modify (after AI Brain block, ~line 174) | `CLIENT_AI_ENTRA_CLIENT_ID=` placeholder |
| `apps/api/src/services/clientAiEntraJwt.ts` (+ `.test.ts`) | Create | Entra ID token verification (jose, common JWKS, tid-bound issuer) |
| `apps/api/src/services/clientAiPolicy.ts` (+ `.test.ts`) | Create | `getOrgPolicy` with defaults, `isClientUserPermitted`, `requireClientAiEnabled` |
| `apps/api/src/routes/clientAi/schemas.ts` | Create | Constants (TTLs, Redis keys), Zod schemas, Hono context types |
| `apps/api/src/routes/clientAi/auth.ts` (+ `auth.test.ts`) | Create | `POST /client-ai/auth/exchange` |
| `apps/api/src/middleware/clientAiAuth.ts` (+ `.test.ts`) | Create | Bearer→Redis session middleware + policy-enforcement middleware |
| `apps/api/src/routes/clientAi/admin.ts` (+ `admin.test.ts`) | Create | Partner-scope tenant-mapping + policy CRUD |
| `apps/api/src/routes/clientAi/index.ts` | Create | Route hub for the namespace |
| `apps/api/src/index.ts` | Modify (import ~line 72, mount ~line 780) | Mount `/client-ai` |

---

### Task 1: M365-connection reuse audit (read-only investigation)

The spec (§3 "Reuse check") requires auditing the existing per-org M365 connection machinery before Plan 4 builds the onboarding wizard, to decide whether tenant IDs and admin-consent flows can be reused instead of building a parallel consent system.

**Files:**
- Create: docs/superpowers/plans/notes/2026-06-12-m365-reuse-audit.md
- Read-only inputs (do NOT modify): apps/api/src/db/schema/m365.ts, apps/api/src/db/schema/delegant.ts, apps/api/src/db/schema/c2c.ts, apps/api/src/services/c2cM365.ts, apps/api/src/routes/m365.ts

- [ ] **Step 1: Investigate the three existing M365 tenant-ID sources**

Read each of these and record findings (file:line citations) in your notes:

1. `apps/api/src/db/schema/m365.ts` — `m365_connections`: one per org (`m365_connections_org_uniq`), stores `tenantId` (varchar 64), `clientId`, encrypted `clientSecret`. Created/validated by `apps/api/src/routes/m365.ts` (POST validates with a live Graph call, GUID-checked by `isM365TenantId`).
2. `apps/api/src/db/schema/delegant.ts` — `delegant_m365_connections`: per-org, **multiple per org** (`delegant_m365_org_customer_uniq` on (org_id, customer_label)), stores `m365TenantId` but no secret. This is the table `ai_sessions.delegant_m365_connection_id` references.
3. `apps/api/src/db/schema/c2c.ts` — `c2c_connections.tenant_id` (line ~29) plus the platform-app admin-consent flow in `apps/api/src/services/c2cM365.ts`: `getPlatformConfig()` (C2C_M365_CLIENT_ID/SECRET env), `buildAdminConsentUrl()` (builds `https://login.microsoftonline.com/common/adminconsent?...`), `getCallbackUri()` (`/api/v1/c2c/m365/callback`).

Questions the note must answer:
- Which table is the best tenant-ID pre-fill source for the Plan-4 onboarding wizard, and what's the lookup (org → tenant GUID)? (Expected answer: `m365_connections.tenant_id` when present, falling back to `delegant_m365_connections.m365_tenant_id`; note multiplicity caveat for delegant rows.)
- Can `buildAdminConsentUrl` from `services/c2cM365.ts` be reused verbatim for the add-in app registration (different `clientId` = `CLIENT_AI_ENTRA_CLIENT_ID`, different redirect)? It takes `{clientId, state, redirectUri}` params, so: yes/no + what a `/client-ai` consent callback route would need.
- Does any existing code verify *user* tokens from customer tenants (vs. client-credentials app tokens)? (Expected: no — `c2cM365.ts` is client-credentials only; `cfAccessJwt.ts` is the only remote-JWKS user-token verifier, hence the new `clientAiEntraJwt.ts` in Task 7 mirrors it.)
- Tenant-GUID validation precedent: `isM365TenantId` / `M365_TENANT_ID_REGEX` in `services/c2cM365.ts` and the CHECK in `apps/api/migrations/2026-05-31-c2c-tenant-id-guid-check.sql` — confirm the regex shape so Task 2's CHECK matches.

- [ ] **Step 2: Write the note**

Create `docs/superpowers/plans/notes/2026-06-12-m365-reuse-audit.md` (create the `notes/` dir if missing) with sections: **Tenant-ID sources** (table per source: table, column, cardinality per org, populated-by), **Consent-flow reuse** (verdict + what Plan 4 reuses vs. builds), **Token-verification reuse** (verdict), **Recommendation for Plan 4 wizard** (concrete: pre-fill query + consent URL construction). Keep it under ~80 lines, every claim cited file:line.

- [ ] **Step 3: Verify the note exists and cites real paths**

Run: `ls docs/superpowers/plans/notes/2026-06-12-m365-reuse-audit.md && grep -c 'apps/api' docs/superpowers/plans/notes/2026-06-12-m365-reuse-audit.md`
Expected: file listed, grep count ≥ 6.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/notes/2026-06-12-m365-reuse-audit.md
git commit -m "docs(client-ai): M365-connection reuse audit note (Plan 1 Task 1)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Migration — tables, RLS, portal_users + ai_sessions alters

No TDD for hand-written SQL; verification is: apply against local docker postgres twice (idempotency), forge a cross-tenant insert as `breeze_app` (must fail with an RLS violation), then the contract test in Task 4.

Naming: two `2026-06-12-a-*` files already exist (`-a-huntress-partner-mapping`, `-a-ticketing-time-parts`) and a future-dated `2026-06-13-a-ticketing-configuration.sql` is already committed. `2026-06-12-b-` sorts after both `-a-` files and before `2026-06-13-a-` — correct.

**Files:**
- Create: apps/api/migrations/2026-06-12-b-client-ai-foundation.sql

- [ ] **Step 1: Write the migration**

```sql
-- 2026-06-12-b-client-ai-foundation.sql
-- Breeze AI for Office, Plan 1 (Foundation).
-- Spec: docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md §3, §7, §8, §10, §12.
--
-- 1. portal_users: Entra identity columns + partial unique identity index.
-- 2. client_ai_tenant_mappings  — Entra tenant GUID -> org (RLS shape 1).
-- 3. client_ai_org_policies     — per-org product policy (RLS shape 1).
-- 4. client_ai_usage            — per-org/per-user metering buckets (RLS shape 1).
-- 5. client_ai_prompt_templates — org-scoped OR partner-wide rows (dual-axis RLS,
--    the custom_field_definitions shape — see 2026-06-11-i and spec §10 warning).
-- 6. ai_sessions: client_user_id principal + principal CHECKs.
--
-- Idempotent throughout. autoMigrate wraps the file in a transaction — no inner
-- BEGIN/COMMIT.

-- ── 1. portal_users: Entra identity ─────────────────────────────────────────
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS entra_oid TEXT;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS entra_tenant_id TEXT;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'password';

-- password_hash is already nullable in the current schema (schema/portal.ts:39
-- declares text with no notNull). Guarded DROP NOT NULL for any DB whose
-- baseline predates that — re-runs are no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'portal_users'
      AND column_name = 'password_hash' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE portal_users ALTER COLUMN password_hash DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'portal_users_auth_method_check'
      AND conrelid = 'portal_users'::regclass
  ) THEN
    ALTER TABLE portal_users
      ADD CONSTRAINT portal_users_auth_method_check
      CHECK (auth_method IN ('password', 'entra'));
  END IF;
END $$;

-- One portal user per (tenant, oid); password-only rows (entra_oid NULL) exempt.
CREATE UNIQUE INDEX IF NOT EXISTS portal_users_entra_identity_uniq
  ON portal_users (entra_tenant_id, entra_oid)
  WHERE entra_oid IS NOT NULL;

-- ── 2. client_ai_tenant_mappings (RLS shape 1) ───────────────────────────────
-- The tenant-isolation linchpin: an Entra tenant maps to exactly ONE org
-- (unique on entra_tenant_id), and in v1 an org carries at most one mapping
-- (unique on org_id; the admin route is the singular /tenant-mapping).
-- GUID CHECK mirrors 2026-05-31-c2c-tenant-id-guid-check.sql.
CREATE TABLE IF NOT EXISTS client_ai_tenant_mappings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entra_tenant_id  TEXT NOT NULL,
  created_by       UUID,
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT client_ai_tenant_mappings_tenant_guid_check
    CHECK (entra_tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS client_ai_tenant_mappings_tenant_uniq
  ON client_ai_tenant_mappings (entra_tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS client_ai_tenant_mappings_org_uniq
  ON client_ai_tenant_mappings (org_id);

DROP POLICY IF EXISTS breeze_org_isolation_select ON client_ai_tenant_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON client_ai_tenant_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON client_ai_tenant_mappings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON client_ai_tenant_mappings;

ALTER TABLE client_ai_tenant_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ai_tenant_mappings FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON client_ai_tenant_mappings
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON client_ai_tenant_mappings
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON client_ai_tenant_mappings
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON client_ai_tenant_mappings
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ── 3. client_ai_org_policies (RLS shape 1) ──────────────────────────────────
-- One row per org; absence == product disabled with defaults (the service layer
-- materialises defaults — see services/clientAiPolicy.ts). Separate from the
-- technician ai budgets table by design (spec §7).
CREATE TABLE IF NOT EXISTS client_ai_org_policies (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enabled                       BOOLEAN NOT NULL DEFAULT false,
  user_access                   TEXT NOT NULL DEFAULT 'all',
  selected_user_ids             JSONB NOT NULL DEFAULT '[]',
  allowed_providers             JSONB NOT NULL DEFAULT '["anthropic"]',
  allowed_models                JSONB NOT NULL DEFAULT '[]',
  write_mode                    TEXT NOT NULL DEFAULT 'readwrite',
  dlp_config                    JSONB NOT NULL DEFAULT '{}',
  daily_budget_cents            INTEGER,
  monthly_budget_cents          INTEGER,
  per_user_messages_per_minute  INTEGER NOT NULL DEFAULT 10,
  org_messages_per_hour         INTEGER NOT NULL DEFAULT 500,
  retention_days                INTEGER,
  branding                      JSONB NOT NULL DEFAULT '{}',
  created_at                    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT client_ai_org_policies_user_access_check
    CHECK (user_access IN ('all', 'selected')),
  CONSTRAINT client_ai_org_policies_write_mode_check
    CHECK (write_mode IN ('readwrite', 'readonly'))
);

CREATE UNIQUE INDEX IF NOT EXISTS client_ai_org_policies_org_uniq
  ON client_ai_org_policies (org_id);

DROP POLICY IF EXISTS breeze_org_isolation_select ON client_ai_org_policies;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON client_ai_org_policies;
DROP POLICY IF EXISTS breeze_org_isolation_update ON client_ai_org_policies;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON client_ai_org_policies;

ALTER TABLE client_ai_org_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ai_org_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON client_ai_org_policies
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON client_ai_org_policies
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON client_ai_org_policies
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON client_ai_org_policies
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ── 4. client_ai_usage (RLS shape 1) ─────────────────────────────────────────
-- ai_cost_usage bucket pattern + a per-user dimension (spec §8). Written by the
-- Plan-2 session loop under org scope.
CREATE TABLE IF NOT EXISTS client_ai_usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_user_id    UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  period            TEXT NOT NULL,
  period_key        VARCHAR(10) NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  total_cost_cents  REAL NOT NULL DEFAULT 0,
  session_count     INTEGER NOT NULL DEFAULT 0,
  message_count     INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT client_ai_usage_period_check CHECK (period IN ('daily', 'monthly'))
);

CREATE UNIQUE INDEX IF NOT EXISTS client_ai_usage_bucket_uniq
  ON client_ai_usage (org_id, client_user_id, period, period_key);

DROP POLICY IF EXISTS breeze_org_isolation_select ON client_ai_usage;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON client_ai_usage;
DROP POLICY IF EXISTS breeze_org_isolation_update ON client_ai_usage;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON client_ai_usage;

ALTER TABLE client_ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ai_usage FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON client_ai_usage
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON client_ai_usage
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON client_ai_usage
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON client_ai_usage
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ── 5. client_ai_prompt_templates (dual-axis RLS) ────────────────────────────
-- Partner-wide rows: org_id NULL, partner_id set. Org rows: org_id set,
-- partner_id NULL. EXACTLY the custom_field_definitions failure mode fixed in
-- 2026-06-11-i — created dual-axis from day one. breeze_has_org_access(NULL) is
-- FALSE, so the partner branch is load-bearing, not decorative. A functional
-- breeze_app insert test for the partner axis is REQUIRED in the same PR
-- (spec §10 warning; client-ai-templates-rls.integration.test.ts).
CREATE TABLE IF NOT EXISTS client_ai_prompt_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id   UUID REFERENCES partners(id) ON DELETE CASCADE,
  name         VARCHAR(200) NOT NULL,
  description  TEXT,
  prompt_body  TEXT NOT NULL,
  category     VARCHAR(100),
  created_by   UUID,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT client_ai_prompt_templates_scope_check
    CHECK (num_nonnulls(org_id, partner_id) = 1)
);

CREATE INDEX IF NOT EXISTS client_ai_prompt_templates_org_idx
  ON client_ai_prompt_templates (org_id);
CREATE INDEX IF NOT EXISTS client_ai_prompt_templates_partner_idx
  ON client_ai_prompt_templates (partner_id);

DROP POLICY IF EXISTS breeze_dual_axis_select ON client_ai_prompt_templates;
DROP POLICY IF EXISTS breeze_dual_axis_insert ON client_ai_prompt_templates;
DROP POLICY IF EXISTS breeze_dual_axis_update ON client_ai_prompt_templates;
DROP POLICY IF EXISTS breeze_dual_axis_delete ON client_ai_prompt_templates;

ALTER TABLE client_ai_prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_ai_prompt_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_dual_axis_select ON client_ai_prompt_templates FOR SELECT
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_insert ON client_ai_prompt_templates FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_update ON client_ai_prompt_templates FOR UPDATE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_dual_axis_delete ON client_ai_prompt_templates FOR DELETE
  USING (public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));

-- ── 6. ai_sessions: client principal ─────────────────────────────────────────
ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS client_user_id UUID REFERENCES portal_users(id);

CREATE INDEX IF NOT EXISTS ai_sessions_client_user_id_idx
  ON ai_sessions (client_user_id) WHERE client_user_id IS NOT NULL;

-- user_id is ALREADY nullable and rows with user_id IS NULL legitimately exist
-- (helper device sessions: routes/helper/index.ts inserts userId: null; MCP
-- ledger sessions: services/mcpToolExecutionLedger.ts). The spec's "exactly one
-- of (user_id, client_user_id)" is therefore relaxed to:
--   (a) never BOTH set;
--   (b) excel_client sessions always carry a client principal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_single_principal_check'
      AND conrelid = 'ai_sessions'::regclass
  ) THEN
    ALTER TABLE ai_sessions
      ADD CONSTRAINT ai_sessions_single_principal_check
      CHECK (user_id IS NULL OR client_user_id IS NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_excel_client_principal_check'
      AND conrelid = 'ai_sessions'::regclass
  ) THEN
    ALTER TABLE ai_sessions
      ADD CONSTRAINT ai_sessions_excel_client_principal_check
      CHECK (type <> 'excel_client' OR client_user_id IS NOT NULL);
  END IF;
END $$;
```

- [ ] **Step 2: Apply against local docker postgres — twice (idempotency proof)**

```bash
cd /Users/toddhebebrand/breeze
docker exec -i breeze-postgres psql -U breeze -d breeze -v ON_ERROR_STOP=1 < apps/api/migrations/2026-06-12-b-client-ai-foundation.sql
# Re-run: a clean no-op (CREATE ... IF NOT EXISTS skips, DO-blocks skip, policies recreate)
docker exec -i breeze-postgres psql -U breeze -d breeze -v ON_ERROR_STOP=1 < apps/api/migrations/2026-06-12-b-client-ai-foundation.sql
```

Expected: both runs exit 0, no ERROR lines. (Manual psql application does not register in `breeze_migrations` — that is fine; the file is idempotent, so `autoMigrate` re-applying it on next API boot is a no-op.)

- [ ] **Step 3: Verify RLS as breeze_app (forge a cross-tenant insert — must fail)**

```bash
docker exec -i breeze-postgres psql -U breeze_app -d breeze <<'SQL'
-- No breeze.scope GUC set => breeze_current_scope() = 'none' => both access
-- helpers return FALSE. Use a literal random org UUID (an org subselect would
-- itself be RLS-filtered to zero rows). RLS WITH CHECK fires before the FK is
-- validated, so the expected failure is the RLS violation, not an FK error.
INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id)
VALUES (gen_random_uuid(), '11111111-2222-3333-4444-555555555555');
SQL
docker exec -i breeze-postgres psql -U breeze_app -d breeze <<'SQL'
INSERT INTO client_ai_prompt_templates (partner_id, name, prompt_body)
VALUES (gen_random_uuid(), 'forged', 'x');
SQL
```

Expected: BOTH inserts fail with `new row violates row-level security policy`.

- [ ] **Step 4: Verify the constraints behave**

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze <<'SQL'
-- As the table owner RLS is forced too, but owner bypasses policies via
-- superuser breeze? The dev superuser bypasses RLS, which is exactly what we
-- want here: test CONSTRAINTS, not policies.
DO $$ BEGIN
  BEGIN
    INSERT INTO client_ai_prompt_templates (org_id, partner_id, name, prompt_body)
    VALUES (NULL, NULL, 'bad', 'x');
    RAISE EXCEPTION 'scope_check failed to fire';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'scope_check OK'; END;
  BEGIN
    INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id)
    VALUES (gen_random_uuid(), 'not-a-guid');
    RAISE EXCEPTION 'tenant_guid_check failed to fire';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'tenant_guid_check OK';
           WHEN foreign_key_violation THEN RAISE EXCEPTION 'guid check did not fire first'; END;
END $$;
SQL
```

Expected: two `NOTICE: ... OK` lines, no exceptions. (The first insert violates `client_ai_prompt_templates_scope_check`; the second violates the GUID CHECK before the FK is evaluated at statement end.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-12-b-client-ai-foundation.sql
git commit -m "feat(client-ai): foundation migration — tenant mappings, org policies, usage, templates + RLS" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Drizzle schema — clientAi.ts + portal.ts/ai.ts edits

Schema files don't need TDD; verification is type-check + drift check.

**Files:**
- Create: apps/api/src/db/schema/clientAi.ts
- Modify: apps/api/src/db/schema/portal.ts (portalUsers, ~lines 34-46)
- Modify: apps/api/src/db/schema/ai.ts (aiSessions, ~lines 24-53)
- Modify: apps/api/src/db/schema/index.ts (append export)

- [ ] **Step 1: Create `apps/api/src/db/schema/clientAi.ts`**

```ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { portalUsers } from './portal';

/**
 * Breeze AI for Office — client-AI control-plane tables.
 * Spec: docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md §3, §7, §8, §10, §12.
 *
 * RLS lives in apps/api/migrations/2026-06-12-b-client-ai-foundation.sql:
 *  - client_ai_tenant_mappings / client_ai_org_policies / client_ai_usage: shape 1
 *    (breeze_org_isolation_* on breeze_has_org_access(org_id)).
 *  - client_ai_prompt_templates: DUAL-AXIS (org OR partner) — partner-wide rows
 *    have org_id NULL. See the custom_field_definitions lesson (2026-06-11-i).
 */

/** Entra tenant GUID → Breeze org. The tenant-isolation linchpin (spec §3). */
export const clientAiTenantMappings = pgTable('client_ai_tenant_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  // GUID-shape CHECK lives in SQL (client_ai_tenant_mappings_tenant_guid_check).
  entraTenantId: text('entra_tenant_id').notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  tenantUniq: uniqueIndex('client_ai_tenant_mappings_tenant_uniq').on(t.entraTenantId),
  orgUniq: uniqueIndex('client_ai_tenant_mappings_org_uniq').on(t.orgId),
}));

/** Per-org product policy (spec §7). Absence == disabled-with-defaults. */
export const clientAiOrgPolicies = pgTable('client_ai_org_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  userAccess: text('user_access').notNull().default('all'), // 'all' | 'selected' (SQL CHECK)
  selectedUserIds: jsonb('selected_user_ids').notNull().default([]), // portal_users UUIDs
  allowedProviders: jsonb('allowed_providers').notNull().default(['anthropic']),
  allowedModels: jsonb('allowed_models').notNull().default([]), // [] = provider defaults
  writeMode: text('write_mode').notNull().default('readwrite'), // 'readwrite' | 'readonly' (SQL CHECK)
  dlpConfig: jsonb('dlp_config').notNull().default({}),
  dailyBudgetCents: integer('daily_budget_cents'), // NULL = unlimited
  monthlyBudgetCents: integer('monthly_budget_cents'), // NULL = unlimited
  perUserMessagesPerMinute: integer('per_user_messages_per_minute').notNull().default(10),
  orgMessagesPerHour: integer('org_messages_per_hour').notNull().default(500),
  retentionDays: integer('retention_days'), // NULL = keep forever
  branding: jsonb('branding').notNull().default({}),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgUniq: uniqueIndex('client_ai_org_policies_org_uniq').on(t.orgId),
}));

/** Daily/monthly metering buckets with a per-user dimension (spec §8). */
export const clientAiUsage = pgTable('client_ai_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  clientUserId: uuid('client_user_id').notNull().references(() => portalUsers.id, { onDelete: 'cascade' }),
  period: text('period').notNull(), // 'daily' | 'monthly' (SQL CHECK)
  periodKey: varchar('period_key', { length: 10 }).notNull(), // '2026-06-12' | '2026-06'
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  totalCostCents: real('total_cost_cents').notNull().default(0),
  sessionCount: integer('session_count').notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  bucketUniq: uniqueIndex('client_ai_usage_bucket_uniq').on(t.orgId, t.clientUserId, t.period, t.periodKey),
}));

/**
 * Prompt templates (spec §10). Partner-wide rows: org_id NULL + partner_id set.
 * Org rows: org_id set + partner_id NULL. SQL CHECK enforces exactly one axis
 * (client_ai_prompt_templates_scope_check).
 */
export const clientAiPromptTemplates = pgTable('client_ai_prompt_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  promptBody: text('prompt_body').notNull(),
  category: varchar('category', { length: 100 }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgIdx: index('client_ai_prompt_templates_org_idx').on(t.orgId),
  partnerIdx: index('client_ai_prompt_templates_partner_idx').on(t.partnerId),
}));

export type ClientAiTenantMappingRow = typeof clientAiTenantMappings.$inferSelect;
export type ClientAiOrgPolicyRow = typeof clientAiOrgPolicies.$inferSelect;
export type ClientAiUsageRow = typeof clientAiUsage.$inferSelect;
export type ClientAiPromptTemplateRow = typeof clientAiPromptTemplates.$inferSelect;
```

- [ ] **Step 2: Edit `apps/api/src/db/schema/portal.ts` — portalUsers Entra columns**

In the `portalUsers` table (currently lines 34-46), add three columns after `passwordHash`:

```ts
export const portalUsers = pgTable('portal_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  passwordHash: text('password_hash'),
  // Entra ID (AI for Office) identity. Partial unique index
  // portal_users_entra_identity_uniq on (entra_tenant_id, entra_oid)
  // WHERE entra_oid IS NOT NULL is created via SQL migration
  // (2026-06-12-b-client-ai-foundation.sql), mirroring the ai_sessions
  // partial-index convention.
  entraOid: text('entra_oid'),
  entraTenantId: text('entra_tenant_id'),
  authMethod: text('auth_method').notNull().default('password'), // 'password' | 'entra' (SQL CHECK)
  linkedUserId: uuid('linked_user_id').references(() => users.id),
  receiveNotifications: boolean('receive_notifications').notNull().default(true),
  lastLoginAt: timestamp('last_login_at'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
```

- [ ] **Step 3: Edit `apps/api/src/db/schema/ai.ts` — aiSessions client principal**

Add the import at the top (after the existing `./devices` import):

```ts
import { portalUsers } from './portal';
```

In `aiSessions` (lines 24-53), add after `delegantM365ConnectionId`:

```ts
  // AI for Office client principal (FK → portal_users). CHECKs in SQL:
  // ai_sessions_single_principal_check (never both user_id and client_user_id),
  // ai_sessions_excel_client_principal_check (type='excel_client' ⇒ set).
  // Partial index ai_sessions_client_user_id_idx created via SQL migration.
  clientUserId: uuid('client_user_id').references(() => portalUsers.id),
```

(No import cycle: `portal.ts` imports only `orgs`/`devices`/`users`, none of which import `ai.ts`.)

- [ ] **Step 4: Edit `apps/api/src/db/schema/index.ts` — export the new module**

Append alongside the existing `export * from` lines:

```ts
export * from './clientAi';
```

- [ ] **Step 5: Verify — type-check and drift check**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd /Users/toddhebebrand/breeze
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```

Expected: tsc shows only the pre-existing `agents.test.ts` / `apiKeyAuth.test.ts` errors; drift check reports no drift (Task 2's migration must already be applied to the local DB — it was in Task 2 Step 2).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/clientAi.ts apps/api/src/db/schema/portal.ts apps/api/src/db/schema/ai.ts apps/api/src/db/schema/index.ts
git commit -m "feat(client-ai): Drizzle schema for client AI tables + portal_users/ai_sessions extensions" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: rls-coverage contract-test allowlist update

**Exactly one allowlist changes.** The three shape-1 tables (`client_ai_tenant_mappings`, `client_ai_org_policies`, `client_ai_usage`) are **auto-discovered** by the org-axis check via their `org_id` column (the `org_id_tables` CTE at rls-coverage.integration.test.ts:479-491) — no list entry needed. `client_ai_prompt_templates` also has an `org_id` column, so it is auto-checked on the org axis too — its dual-axis policies pass that check because they contain `breeze_has_org_access` — but it must ALSO be added to `DUAL_AXIS_TENANT_TABLES` so the dual-axis assertion (both helpers present, all four DML commands) covers it.

**Files:**
- Modify: apps/api/src/__tests__/integration/rls-coverage.integration.test.ts (`DUAL_AXIS_TENANT_TABLES`, ~line 114-122)

- [ ] **Step 1: Add the table to `DUAL_AXIS_TENANT_TABLES`**

```ts
const DUAL_AXIS_TENANT_TABLES: ReadonlySet<string> = new Set<string>([
  'users',
  'deployment_invites',
  'access_reviews',
  // custom_field_definitions: a field is org-scoped (org_id set) OR
  // partner-wide (partner_id set, org_id NULL). Shipped org-only in the
  // baseline; converted to dual-axis in 2026-06-11-i-custom-fields-dual-axis-rls.
  'custom_field_definitions',
  // client_ai_prompt_templates: org-scoped rows OR partner-wide rows
  // (partner_id set, org_id NULL) — spec §10 dual-axis warning. Created
  // dual-axis from day one (2026-06-12-b-client-ai-foundation.sql); the
  // functional partner-axis insert test lives in
  // client-ai-templates-rls.integration.test.ts.
  'client_ai_prompt_templates',
]);
```

- [ ] **Step 2: Run the contract test against the docker test stack**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test:docker:up
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test:rls-coverage
```

Expected: PASS. If a `client_ai_*` table shows up as an offender, the migration's policy block for it is wrong — fix the migration (it has not shipped yet), `pnpm test:docker:down && pnpm test:docker:up`, re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(client-ai): register client_ai_prompt_templates as dual-axis in rls-coverage contract" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Functional dual-axis RLS test for client_ai_prompt_templates

The rls-coverage contract test provably does NOT catch a missing second axis (it accepts org OR partner coverage — the custom_field_definitions lesson, memory note `rls_dual_axis_contract_test_blindspot`). Spec §10 requires a functional `breeze_app` insert test for the partner-axis write path. Modeled exactly on `custom-fields-rls.integration.test.ts`.

**Files:**
- Create: apps/api/src/__tests__/integration/client-ai-templates-rls.integration.test.ts

- [ ] **Step 1: Write the test**

```ts
/**
 * client_ai_prompt_templates RLS — dual-axis (org OR partner) enforcement.
 *
 * Migration under test: 2026-06-12-b-client-ai-foundation.sql (§5).
 *
 * Partner-wide template rows carry org_id NULL + partner_id set — exactly the
 * custom_field_definitions failure mode (fixed 2026-06-11-i), where org-only
 * Shape-1 policies made every partner-wide row structurally uncreatable
 * (breeze_has_org_access(NULL) = FALSE → 42501 on INSERT). The rls-coverage
 * contract test does NOT catch a missing second axis, so this functional test
 * through the REAL postgres.js driver (breeze_app role) is the required guard
 * (spec §10).
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { clientAiPromptTemplates } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(
    { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
    async () => {
      for (const id of created) {
        await db.delete(clientAiPromptTemplates).where(eq(clientAiPromptTemplates.id, id));
      }
    },
  );
  created.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function seedPartnerTemplate(partnerId: string, track = true): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(clientAiPromptTemplates)
      .values({
        orgId: null,
        partnerId,
        name: 'Seed template',
        promptBody: 'Summarize the selected range.',
        category: 'finance',
      })
      .returning(),
  );
  const id = rows[0]!.id;
  if (track) created.push(id);
  return id;
}

describe('client_ai_prompt_templates RLS — dual-axis (2026-06-12-b migration)', () => {
  it('partner scope can INSERT a partner-wide template (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(clientAiPromptTemplates)
        .values({
          orgId: null,
          partnerId: partner.id,
          name: 'Quarterly variance walkthrough',
          promptBody: 'Explain the variance between the selected columns.',
        })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) created.push(rows[0].id);
  });

  it('partner scope can SELECT back its own partner-wide template', async () => {
    const partner = await createPartner();
    const id = await seedPartnerTemplate(partner.id);

    const visible = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .select({ id: clientAiPromptTemplates.id })
        .from(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.partnerId, partner.id)),
    );

    expect(visible.map((r) => r.id)).toContain(id);
  });

  it('a different partner can neither see nor forge a template attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerTemplate(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .select({ id: clientAiPromptTemplates.id })
        .from(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.id, id)),
    );
    expect(visibleToB).toEqual([]);

    // WITH CHECK denies the forge. Drizzle wraps the driver error, so the RLS
    // signal is Postgres code 42501 on the cause (custom-fields-rls precedent).
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(clientAiPromptTemplates)
          .values({ orgId: null, partnerId: partnerA.id, name: 'Forged', promptBody: 'x' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org scope can INSERT and SELECT an org-scoped template', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(clientAiPromptTemplates)
        .values({ orgId: org.id, partnerId: null, name: 'Org template', promptBody: 'y' })
        .returning(),
    );
    if (inserted[0]) created.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: clientAiPromptTemplates.id })
        .from(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('partner scope can UPDATE and DELETE its own partner-wide template', async () => {
    const partner = await createPartner();
    const id = await seedPartnerTemplate(partner.id, false);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(clientAiPromptTemplates)
        .set({ name: 'Renamed' })
        .where(eq(clientAiPromptTemplates.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe('Renamed');

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .delete(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.id, id))
        .returning(),
    );
    expect(deleted).toHaveLength(1);
  });

  it('a different partner UPDATE/DELETE silently match zero rows', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerTemplate(partnerA.id);

    const updatedByB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .update(clientAiPromptTemplates)
        .set({ name: 'Hijacked' })
        .where(eq(clientAiPromptTemplates.id, id))
        .returning(),
    );
    expect(updatedByB).toEqual([]);

    const deletedByB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .delete(clientAiPromptTemplates)
        .where(eq(clientAiPromptTemplates.id, id))
        .returning(),
    );
    expect(deletedByB).toEqual([]);
  });

  it('stays fail-closed without a DB access context (scope "none")', async () => {
    const partner = await createPartner();
    const id = await seedPartnerTemplate(partner.id);

    const rows = await db
      .select({ id: clientAiPromptTemplates.id })
      .from(clientAiPromptTemplates)
      .where(eq(clientAiPromptTemplates.id, id));

    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it (test stack must be up from Task 4)**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/client-ai-templates-rls.integration.test.ts
```

Expected: 7 tests PASS. (If the test DB predates the migration: `pnpm test:docker:down && pnpm test:docker:up` — setup re-runs autoMigrate.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/client-ai-templates-rls.integration.test.ts
git commit -m "test(client-ai): functional breeze_app dual-axis RLS test for prompt templates" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Env plumbing — CLIENT_AI_ENTRA_CLIENT_ID

**Files:**
- Modify: apps/api/src/config/env.ts (near `M365_ENABLED`, ~line 18)
- Modify: .env.example (after the "AI Brain (BYOK)" block, ~line 174)

- [ ] **Step 1: Add the export to `apps/api/src/config/env.ts`**

Insert after the `M365_ENABLED` block:

```ts
// Breeze AI for Office (Excel add-in / client AI). The Entra application
// (client) ID of the multi-tenant add-in app registration. Empty = the whole
// /client-ai surface is dark (exchange and admin routes return 404), mirroring
// the M365_ENABLED gating style.
export const CLIENT_AI_ENTRA_CLIENT_ID = process.env.CLIENT_AI_ENTRA_CLIENT_ID?.trim() ?? '';
```

- [ ] **Step 2: Add the placeholder to `.env.example`**

Insert after the `ANTHROPIC_API_KEY=` line (keep the generic placeholder — NEVER a real value):

```bash
# --------------------------------------------
# Breeze AI for Office (Excel add-in)
# --------------------------------------------
# Entra application (client) ID of the multi-tenant add-in app registration.
# Leave empty to disable the /client-ai surface entirely.
CLIENT_AI_ENTRA_CLIENT_ID=
```

- [ ] **Step 3: Verify**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
grep -n "CLIENT_AI_ENTRA_CLIENT_ID" /Users/toddhebebrand/breeze/.env.example
```

Expected: tsc clean (modulo pre-existing), grep hits the new placeholder line.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/config/env.ts .env.example
git commit -m "feat(client-ai): CLIENT_AI_ENTRA_CLIENT_ID env plumbing" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Entra ID token verification service (TDD)

Mirrors `services/cfAccessJwt.ts` (the repo's only remote-JWKS user-token verifier) including its error taxonomy and JWKS caching, with one Entra-specific twist: the v2.0 issuer is **per-tenant** (`https://login.microsoftonline.com/{tid}/v2.0`), so we verify signature+audience first against Microsoft's common JWKS, then bind `iss` to the token's own `tid` claim.

**Files:**
- Create: apps/api/src/services/clientAiEntraJwt.ts
- Test: apps/api/src/services/clientAiEntraJwt.test.ts

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/clientAiEntraJwt.test.ts` (JWKS mocking idiom copied from `cfAccessJwt.test.ts`):

```ts
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const jwksState = vi.hoisted(() => ({
  importedPublicKey: undefined as unknown,
}));

vi.mock('jose', async () => {
  const actual = await vi.importActual<typeof import('jose')>('jose');
  return {
    ...actual,
    jwtVerify: vi.fn(actual.jwtVerify),
    createRemoteJWKSet: vi.fn(
      () => async () => jwksState.importedPublicKey as Awaited<ReturnType<typeof actual.importJWK>>
    ),
  };
});

import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
} from 'jose';
import {
  ClientAiEntraInvalidTokenError,
  ClientAiEntraJwksUnavailableError,
  _resetClientAiEntraJwksCacheForTests,
  verifyEntraIdToken,
} from './clientAiEntraJwt';

interface RsaKeypair {
  privateJwk: JWK;
  publicJwk: JWK;
  kid: string;
}

async function generateRsaKeypair(): Promise<RsaKeypair> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });
  const kid = randomUUID();
  return {
    privateJwk: { ...(await exportJWK(privateKey)), kid, alg: 'RS256', use: 'sig' },
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
    kid,
  };
}

const audience = '00000000-aaaa-bbbb-cccc-000000000001';
const tid = '6f4f4f4f-1111-4222-8333-444455556666';
const oid = '7a7a7a7a-2222-4333-8444-555566667777';
const issuer = `https://login.microsoftonline.com/${tid}/v2.0`;

let keypair: RsaKeypair;

async function mintEntraToken(
  claims: Record<string, unknown>,
  opts: {
    issuer?: string;
    audience?: string;
    ttlSeconds?: number;
    signerKey?: JWK;
    signerKid?: string;
  } = {}
): Promise<string> {
  const signerJwk = opts.signerKey ?? keypair.privateJwk;
  const signerKid = opts.signerKid ?? keypair.kid;
  const key = await importJWK(signerJwk, 'RS256');

  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: signerKid })
    .setIssuer(opts.issuer ?? issuer)
    .setAudience(opts.audience ?? audience)
    .setIssuedAt();

  if (opts.ttlSeconds !== 0) {
    builder.setExpirationTime(`${opts.ttlSeconds ?? 600}s`);
  }

  return builder.sign(key);
}

describe('verifyEntraIdToken', () => {
  beforeAll(async () => {
    keypair = await generateRsaKeypair();
    jwksState.importedPublicKey = await importJWK(keypair.publicJwk, 'RS256');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    _resetClientAiEntraJwksCacheForTests();
  });

  it('accepts a valid token and returns normalized claims', async () => {
    const token = await mintEntraToken({
      tid,
      oid,
      preferred_username: 'Finance.User@Contoso.com',
      name: 'Finance User',
    });

    const claims = await verifyEntraIdToken(token, { audience });

    expect(claims.tid).toBe(tid);
    expect(claims.oid).toBe(oid);
    expect(claims.email).toBe('finance.user@contoso.com');
    expect(claims.name).toBe('Finance User');
    expect(claims.iss).toBe(issuer);
    expect(typeof claims.exp).toBe('number');
  });

  it('falls back to the email claim when preferred_username is not an address', async () => {
    const token = await mintEntraToken({
      tid,
      oid,
      preferred_username: 'CONTOSO\\finance.user',
      email: 'Finance.User@Contoso.com',
    });

    const claims = await verifyEntraIdToken(token, { audience });
    expect(claims.email).toBe('finance.user@contoso.com');
  });

  it('returns null email when no usable address claim exists', async () => {
    const token = await mintEntraToken({ tid, oid });
    const claims = await verifyEntraIdToken(token, { audience });
    expect(claims.email).toBeNull();
  });

  it('rejects a token signed by a different key (forged signature)', async () => {
    const attacker = await generateRsaKeypair();
    const token = await mintEntraToken(
      { tid, oid },
      { signerKey: attacker.privateJwk, signerKid: attacker.kid }
    );

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await mintEntraToken({ tid, oid }, { audience: 'some-other-app' });

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects an expired token', async () => {
    const token = await mintEntraToken({ tid, oid }, { ttlSeconds: -60 });

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects a token whose issuer does not match its own tid (tenant spoof)', async () => {
    const otherTid = '9b9b9b9b-3333-4444-8555-666677778888';
    const token = await mintEntraToken(
      { tid, oid },
      { issuer: `https://login.microsoftonline.com/${otherTid}/v2.0` }
    );

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects a token missing the tid claim', async () => {
    const token = await mintEntraToken({ oid });

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('rejects a token with a malformed oid claim', async () => {
    const token = await mintEntraToken({ tid, oid: 'not-a-guid' });

    await expect(verifyEntraIdToken(token, { audience })).rejects.toBeInstanceOf(
      ClientAiEntraInvalidTokenError
    );
  });

  it('surfaces ClientAiEntraJwksUnavailableError when the JWKS fetch fails', async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(verifyEntraIdToken('any-token', { audience })).rejects.toBeInstanceOf(
      ClientAiEntraJwksUnavailableError
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiEntraJwt.test.ts`
Expected: FAIL with `Cannot find module './clientAiEntraJwt'` (or equivalent resolution error).

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/services/clientAiEntraJwt.ts`:

```ts
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose';

/**
 * Entra ID (Azure AD) access-token verification for Breeze AI for Office.
 *
 * The Excel add-in acquires a token via Office SSO / NAA in the END CUSTOMER's
 * tenant and posts it to POST /client-ai/auth/exchange (spec §3). This service
 * verifies it:
 *
 *   - signature against Microsoft's COMMON JWKS (multi-tenant app — keys are
 *     shared across tenants, the issuer is not),
 *   - audience pinned to our app registration (CLIENT_AI_ENTRA_CLIENT_ID),
 *   - expiry / algorithm via jose,
 *   - issuer bound to the token's OWN tid claim
 *     (https://login.microsoftonline.com/{tid}/v2.0) — prevents a token from
 *     tenant A presenting itself as tenant B, which would be a cross-org
 *     mapping bypass.
 *
 * Modeled on services/cfAccessJwt.ts (error taxonomy, JWKS caching, test
 * seams). Distinct from services/c2cM365.ts, which is client-credentials
 * APP-token acquisition, not user-token verification.
 */

export interface ClientAiEntraClaims {
  /** Entra tenant id (GUID, lowercased). */
  tid: string;
  /** Entra object id of the user within the tenant (GUID, lowercased). */
  oid: string;
  /** Best-effort email (preferred_username when address-shaped, else email claim), lowercased. */
  email: string | null;
  /** Display name when present. */
  name: string | null;
  aud: string | string[];
  iss: string;
  exp: number;
  iat: number;
}

export class ClientAiEntraJwksUnavailableError extends Error {
  override readonly name = 'ClientAiEntraJwksUnavailableError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export class ClientAiEntraInvalidTokenError extends Error {
  override readonly name = 'ClientAiEntraInvalidTokenError';
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

const ENTRA_COMMON_JWKS_URL = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
const ENTRA_GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ALGS = ['RS256'] as const;

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks === null) {
    cachedJwks = createRemoteJWKSet(new URL(ENTRA_COMMON_JWKS_URL), {
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes; jose refreshes on `kid` miss
      cooldownDuration: 30 * 1000,
    });
  }
  return cachedJwks;
}

/** Test-only: reset the JWKS cache so a subsequent call rebuilds it. */
export function _resetClientAiEntraJwksCacheForTests(): void {
  cachedJwks = null;
}

function invalid(message: string, code = 'ERR_JWT_CLAIM_VALIDATION_FAILED'): never {
  throw new ClientAiEntraInvalidTokenError(message, code);
}

export async function verifyEntraIdToken(
  token: string,
  config: { audience: string },
): Promise<ClientAiEntraClaims> {
  let result: JWTVerifyResult;
  try {
    result = await jwtVerify(token, getJwks(), {
      audience: config.audience,
      algorithms: [...ALLOWED_ALGS],
      // No `issuer` option: the v2.0 issuer is per-tenant and we don't know the
      // tenant until we read the (signature-verified) tid claim below.
      requiredClaims: ['exp', 'iat', 'aud', 'iss', 'tid', 'oid'],
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    const isJoseError = typeof code === 'string' && code.startsWith('ERR_');
    if (!isJoseError) {
      // No jose ERR_* code => network/IO problem reaching the JWKS endpoint.
      // Distinct type so the exchange route can 503 instead of 401.
      throw new ClientAiEntraJwksUnavailableError(
        `Failed to verify Entra ID token: ${(err as Error).message ?? 'unknown error'}`,
        err,
      );
    }
    throw new ClientAiEntraInvalidTokenError(`Entra ID token rejected: ${code}`, code);
  }

  const payload = result.payload as JWTPayload & {
    tid?: unknown;
    oid?: unknown;
    preferred_username?: unknown;
    email?: unknown;
    name?: unknown;
  };

  const tid = typeof payload.tid === 'string' ? payload.tid.toLowerCase() : '';
  const oid = typeof payload.oid === 'string' ? payload.oid.toLowerCase() : '';
  if (!ENTRA_GUID_REGEX.test(tid)) invalid('Entra ID token missing a valid tid claim');
  if (!ENTRA_GUID_REGEX.test(oid)) invalid('Entra ID token missing a valid oid claim');

  // Signature is already proven against Microsoft's common JWKS; binding iss to
  // the token's own tid closes the cross-tenant spoof.
  const expectedIssuer = `https://login.microsoftonline.com/${tid}/v2.0`;
  if (payload.iss !== expectedIssuer) {
    invalid(`Entra ID token issuer mismatch (expected ${expectedIssuer})`);
  }

  const preferred =
    typeof payload.preferred_username === 'string' && payload.preferred_username.includes('@')
      ? payload.preferred_username.toLowerCase()
      : null;
  const emailClaim =
    typeof payload.email === 'string' && payload.email.includes('@')
      ? payload.email.toLowerCase()
      : null;

  return {
    tid,
    oid,
    email: preferred ?? emailClaim,
    name: typeof payload.name === 'string' ? payload.name : null,
    aud: payload.aud as string | string[],
    iss: payload.iss as string,
    exp: payload.exp as number,
    iat: payload.iat as number,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiEntraJwt.test.ts`
Expected: 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiEntraJwt.ts apps/api/src/services/clientAiEntraJwt.test.ts
git commit -m "feat(client-ai): Entra ID token verification service (common JWKS, tid-bound issuer)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Policy service — clientAiPolicy.ts (TDD)

**Files:**
- Create: apps/api/src/services/clientAiPolicy.ts
- Test: apps/api/src/services/clientAiPolicy.test.ts

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/clientAiPolicy.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbSelectMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: dbSelectMock },
}));

import {
  defaultClientAiPolicy,
  getOrgPolicy,
  isClientUserPermitted,
  requireClientAiEnabled,
} from './clientAiPolicy';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const USER_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const USER_B = 'bbbbbbbb-1111-4222-8333-444455556666';

function mockPolicyRow(row: object | undefined) {
  dbSelectMock.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(row ? [row] : [])),
      })),
    })),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('defaultClientAiPolicy', () => {
  it('is disabled with anthropic-only providers and sane limits', () => {
    const policy = defaultClientAiPolicy(ORG_ID);
    expect(policy).toMatchObject({
      orgId: ORG_ID,
      enabled: false,
      userAccess: 'all',
      selectedUserIds: [],
      allowedProviders: ['anthropic'],
      allowedModels: [],
      writeMode: 'readwrite',
      dlpConfig: {},
      dailyBudgetCents: null,
      monthlyBudgetCents: null,
      perUserMessagesPerMinute: 10,
      orgMessagesPerHour: 500,
      retentionDays: null,
      branding: {},
    });
  });
});

describe('getOrgPolicy', () => {
  it('returns the disabled default when no row exists', async () => {
    mockPolicyRow(undefined);
    const policy = await getOrgPolicy(ORG_ID);
    expect(policy.enabled).toBe(false);
    expect(policy.orgId).toBe(ORG_ID);
  });

  it('normalizes a stored row (jsonb columns coerced defensively)', async () => {
    mockPolicyRow({
      orgId: ORG_ID,
      enabled: true,
      userAccess: 'selected',
      selectedUserIds: [USER_A],
      allowedProviders: ['anthropic'],
      allowedModels: ['claude-sonnet-4-5-20250929'],
      writeMode: 'readonly',
      dlpConfig: { creditCards: 'redact' },
      dailyBudgetCents: 500,
      monthlyBudgetCents: 10000,
      perUserMessagesPerMinute: 5,
      orgMessagesPerHour: 100,
      retentionDays: 90,
      branding: { displayName: 'Acme IT' },
    });

    const policy = await getOrgPolicy(ORG_ID);
    expect(policy.enabled).toBe(true);
    expect(policy.userAccess).toBe('selected');
    expect(policy.selectedUserIds).toEqual([USER_A]);
    expect(policy.writeMode).toBe('readonly');
    expect(policy.dailyBudgetCents).toBe(500);
    expect(policy.retentionDays).toBe(90);
    expect(policy.branding).toEqual({ displayName: 'Acme IT' });
  });

  it('falls back to safe values when jsonb columns hold non-array garbage', async () => {
    mockPolicyRow({
      orgId: ORG_ID,
      enabled: true,
      userAccess: 'all',
      selectedUserIds: 'not-an-array',
      allowedProviders: null,
      allowedModels: 42,
      writeMode: 'readwrite',
      dlpConfig: null,
      dailyBudgetCents: null,
      monthlyBudgetCents: null,
      perUserMessagesPerMinute: 10,
      orgMessagesPerHour: 500,
      retentionDays: null,
      branding: null,
    });

    const policy = await getOrgPolicy(ORG_ID);
    expect(policy.selectedUserIds).toEqual([]);
    expect(policy.allowedProviders).toEqual(['anthropic']);
    expect(policy.allowedModels).toEqual([]);
    expect(policy.dlpConfig).toEqual({});
    expect(policy.branding).toEqual({});
  });
});

describe('isClientUserPermitted', () => {
  it('permits everyone under userAccess=all', () => {
    const policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true };
    expect(isClientUserPermitted(policy, USER_A)).toBe(true);
  });

  it('enforces the selected list under userAccess=selected', () => {
    const policy = {
      ...defaultClientAiPolicy(ORG_ID),
      enabled: true,
      userAccess: 'selected' as const,
      selectedUserIds: [USER_A],
    };
    expect(isClientUserPermitted(policy, USER_A)).toBe(true);
    expect(isClientUserPermitted(policy, USER_B)).toBe(false);
  });
});

describe('requireClientAiEnabled', () => {
  it('returns the policy when enabled', async () => {
    mockPolicyRow({ ...defaultClientAiPolicy(ORG_ID), enabled: true });
    const policy = await requireClientAiEnabled(ORG_ID);
    expect(policy?.enabled).toBe(true);
  });

  it('returns null when disabled or absent', async () => {
    mockPolicyRow(undefined);
    expect(await requireClientAiEnabled(ORG_ID)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiPolicy.test.ts`
Expected: FAIL with module-not-found for `./clientAiPolicy`.

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/services/clientAiPolicy.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { clientAiOrgPolicies } from '../db/schema/clientAi';

/**
 * Per-org policy for Breeze AI for Office (spec §7).
 *
 * One row per org in client_ai_org_policies; ABSENCE of a row means
 * "disabled, defaults" — defaultClientAiPolicy() materialises that so callers
 * never branch on null. Deliberately separate from the technician AI budget
 * knobs so the two products never interfere.
 *
 * Callers must already be inside a DB access context that can see the org's
 * row (request path: clientAiAuthMiddleware / authMiddleware; pre-auth
 * exchange path: withSystemDbAccessContext).
 */

export interface ClientAiOrgPolicy {
  orgId: string;
  enabled: boolean;
  userAccess: 'all' | 'selected';
  /** portal_users UUIDs permitted when userAccess === 'selected'. */
  selectedUserIds: string[];
  allowedProviders: string[];
  /** Empty = all models of the allowed providers (provider defaults). */
  allowedModels: string[];
  writeMode: 'readwrite' | 'readonly';
  dlpConfig: Record<string, unknown>;
  dailyBudgetCents: number | null;
  monthlyBudgetCents: number | null;
  perUserMessagesPerMinute: number;
  orgMessagesPerHour: number;
  retentionDays: number | null;
  branding: Record<string, unknown>;
}

export function defaultClientAiPolicy(orgId: string): ClientAiOrgPolicy {
  return {
    orgId,
    enabled: false,
    userAccess: 'all',
    selectedUserIds: [],
    allowedProviders: ['anthropic'],
    allowedModels: [],
    writeMode: 'readwrite',
    dlpConfig: {},
    dailyBudgetCents: null,
    monthlyBudgetCents: null,
    perUserMessagesPerMinute: 10,
    orgMessagesPerHour: 500,
    retentionDays: null,
    branding: {},
  };
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function getOrgPolicy(orgId: string): Promise<ClientAiOrgPolicy> {
  const [row] = await db
    .select()
    .from(clientAiOrgPolicies)
    .where(eq(clientAiOrgPolicies.orgId, orgId))
    .limit(1);

  if (!row) return defaultClientAiPolicy(orgId);

  const defaults = defaultClientAiPolicy(orgId);
  return {
    orgId,
    enabled: row.enabled === true,
    userAccess: row.userAccess === 'selected' ? 'selected' : 'all',
    selectedUserIds: asStringArray(row.selectedUserIds, defaults.selectedUserIds),
    allowedProviders: asStringArray(row.allowedProviders, defaults.allowedProviders),
    allowedModels: asStringArray(row.allowedModels, defaults.allowedModels),
    writeMode: row.writeMode === 'readonly' ? 'readonly' : 'readwrite',
    dlpConfig: asRecord(row.dlpConfig),
    dailyBudgetCents: row.dailyBudgetCents ?? null,
    monthlyBudgetCents: row.monthlyBudgetCents ?? null,
    perUserMessagesPerMinute: row.perUserMessagesPerMinute ?? defaults.perUserMessagesPerMinute,
    orgMessagesPerHour: row.orgMessagesPerHour ?? defaults.orgMessagesPerHour,
    retentionDays: row.retentionDays ?? null,
    branding: asRecord(row.branding),
  };
}

export function isClientUserPermitted(policy: ClientAiOrgPolicy, clientUserId: string): boolean {
  if (policy.userAccess === 'all') return true;
  return policy.selectedUserIds.includes(clientUserId);
}

/** Returns the policy when the product is enabled for the org, else null. */
export async function requireClientAiEnabled(orgId: string): Promise<ClientAiOrgPolicy | null> {
  const policy = await getOrgPolicy(orgId);
  return policy.enabled ? policy : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiPolicy.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiPolicy.ts apps/api/src/services/clientAiPolicy.test.ts
git commit -m "feat(client-ai): per-org policy service with disabled-by-default semantics" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: POST /client-ai/auth/exchange (TDD)

The token-exchange endpoint (spec §3): Entra token in → tenant mapping → policy gate → portal-user upsert → Redis-backed bearer session out. Pre-auth route (no auth middleware), so all DB work runs under `withSystemDbAccessContext` — in ONE block of fast queries, with Redis work OUTSIDE it (#1105 pool-poison lesson).

**Files:**
- Create: apps/api/src/routes/clientAi/schemas.ts
- Create: apps/api/src/routes/clientAi/auth.ts
- Test: apps/api/src/routes/clientAi/auth.test.ts

- [ ] **Step 1: Create `apps/api/src/routes/clientAi/schemas.ts`** (shared constants/types — needed by the test's imports)

```ts
import { z } from 'zod';
import type { ClientAiOrgPolicy } from '../../services/clientAiPolicy';

// ============================================
// Constants (mirrors routes/portal/schemas.ts)
// ============================================

/** Add-in sessions are 24h Redis-backed bearer tokens, org-bound (spec §3). */
export const CLIENT_AI_SESSION_TTL_MS = 1000 * 60 * 60 * 24;
export const CLIENT_AI_SESSION_TTL_SECONDS = Math.floor(CLIENT_AI_SESSION_TTL_MS / 1000);

export const CLIENT_AI_REDIS_KEYS = {
  session: (token: string) => `clientai:session:${token}`,
  userSessions: (portalUserId: string) => `clientai:user-sessions:${portalUserId}`,
};

/** Per-IP exchange rate limit (rateLimiter sliding window). */
export const EXCHANGE_RATE_LIMIT = { limit: 20, windowSeconds: 300 } as const;

/** Same shape as services/c2cM365.ts M365_TENANT_ID_REGEX / the SQL CHECK. */
export const ENTRA_TENANT_GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================
// Zod schemas
// ============================================

export const exchangeSchema = z.object({
  /** Entra ID access token from Office SSO / NAA. */
  accessToken: z.string().min(1).max(8192),
});

export const putTenantMappingSchema = z.object({
  entraTenantId: z
    .string()
    .regex(ENTRA_TENANT_GUID_REGEX, 'must be an Entra tenant GUID (Directory ID)'),
});

export const putPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    userAccess: z.enum(['all', 'selected']).optional(),
    selectedUserIds: z.array(z.string().uuid()).max(1000).optional(),
    allowedProviders: z.array(z.string().min(1).max(50)).min(1).max(10).optional(),
    allowedModels: z.array(z.string().min(1).max(100)).max(50).optional(),
    writeMode: z.enum(['readwrite', 'readonly']).optional(),
    dlpConfig: z.record(z.unknown()).optional(),
    dailyBudgetCents: z.number().int().min(0).nullable().optional(),
    monthlyBudgetCents: z.number().int().min(0).nullable().optional(),
    perUserMessagesPerMinute: z.number().int().min(1).max(600).optional(),
    orgMessagesPerHour: z.number().int().min(1).max(100000).optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
    branding: z.record(z.unknown()).optional(),
  })
  .strict();

// ============================================
// Types
// ============================================

export type ClientAiSessionPayload = {
  portalUserId: string;
  orgId: string;
  createdAt: string;
};

export type ClientAiAuthContext = {
  clientUserId: string;
  orgId: string;
  email: string;
  name: string | null;
  token: string;
};

declare module 'hono' {
  interface ContextVariableMap {
    clientAiAuth: ClientAiAuthContext;
    clientAiPolicy: ClientAiOrgPolicy;
  }
}
```

- [ ] **Step 2: Write the failing test**

`apps/api/src/routes/clientAi/auth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Mocks (vi.mock factories are hoisted — literals only) ────────────────────

const {
  verifyMock,
  dbSelectMock,
  dbInsertMock,
  dbUpdateMock,
  redisMock,
  getRedisMock,
  rateLimiterMock,
  writeAuditEventMock,
  getOrgPolicyMock,
} = vi.hoisted(() => {
  const redis = {
    setex: vi.fn(() => Promise.resolve('OK')),
    sadd: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  return {
    verifyMock: vi.fn(),
    dbSelectMock: vi.fn(),
    dbInsertMock: vi.fn(),
    dbUpdateMock: vi.fn(),
    redisMock: redis,
    getRedisMock: vi.fn(() => redis),
    rateLimiterMock: vi.fn(() =>
      Promise.resolve({ allowed: true, remaining: 19, resetAt: new Date() })
    ),
    writeAuditEventMock: vi.fn(),
    getOrgPolicyMock: vi.fn(),
  };
});

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../services/clientAiEntraJwt', () => {
  class ClientAiEntraInvalidTokenError extends Error {}
  class ClientAiEntraJwksUnavailableError extends Error {}
  return {
    verifyEntraIdToken: verifyMock,
    ClientAiEntraInvalidTokenError,
    ClientAiEntraJwksUnavailableError,
  };
});

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, update: dbUpdateMock },
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../services/redis', () => ({ getRedis: getRedisMock }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIp: vi.fn(() => '203.0.113.7') }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock('../../services/clientAiPolicy', () => ({
  getOrgPolicy: getOrgPolicyMock,
  isClientUserPermitted: (
    policy: { userAccess: string; selectedUserIds: string[] },
    id: string
  ) => policy.userAccess === 'all' || policy.selectedUserIds.includes(id),
}));

import { clientAiAuthRoutes } from './auth';
import {
  ClientAiEntraInvalidTokenError,
  ClientAiEntraJwksUnavailableError,
} from '../../services/clientAiEntraJwt';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PORTAL_USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const TID = '6f4f4f4f-1111-4222-8333-444455556666';
const OID = '7a7a7a7a-2222-4333-8444-555566667777';

const CLAIMS = {
  tid: TID,
  oid: OID,
  email: 'finance.user@contoso.com',
  name: 'Finance User',
  aud: '00000000-aaaa-bbbb-cccc-000000000001',
  iss: `https://login.microsoftonline.com/${TID}/v2.0`,
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
};

const MAPPING_ROW = { id: 'a1a1a1a1-1111-4222-8333-444455556666', orgId: ORG_ID, entraTenantId: TID };
const USER_ROW = {
  id: PORTAL_USER_ID,
  orgId: ORG_ID,
  email: 'finance.user@contoso.com',
  name: 'Finance User',
  status: 'active',
};

const ENABLED_POLICY = {
  orgId: ORG_ID,
  enabled: true,
  userAccess: 'all',
  selectedUserIds: [] as string[],
};

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(rows)) })),
    })),
  };
}

/** call 1 = tenant mapping lookup, call 2 = portal user lookup. */
function setupDb({ mapping, user }: { mapping: object | null; user: object | null }) {
  let call = 0;
  dbSelectMock.mockImplementation(() => {
    call++;
    if (call === 1) return selectChain(mapping ? [mapping] : []);
    return selectChain(user ? [user] : []);
  });
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ ...USER_ROW }])),
    })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
}

function buildApp() {
  const app = new Hono();
  app.route('/client-ai', clientAiAuthRoutes);
  return app;
}

function postExchange(app: Hono, accessToken = 'entra-token') {
  return app.request('/client-ai/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock);
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() });
  verifyMock.mockResolvedValue(CLAIMS);
  getOrgPolicyMock.mockResolvedValue({ ...ENABLED_POLICY });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /client-ai/auth/exchange', () => {
  it('401s on an invalid Entra token', async () => {
    verifyMock.mockRejectedValue(new ClientAiEntraInvalidTokenError('bad'));
    const res = await postExchange(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('503s when Microsoft JWKS is unreachable', async () => {
    verifyMock.mockRejectedValue(new ClientAiEntraJwksUnavailableError('down'));
    const res = await postExchange(buildApp());
    expect(res.status).toBe(503);
  });

  it('429s when the per-IP rate limit is exhausted', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(429);
  });

  it('404s with tenant_not_provisioned when no mapping exists, and audits the denial', async () => {
    setupDb({ mapping: null, user: null });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'tenant_not_provisioned' });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.auth.exchange',
        result: 'denied',
        details: expect.objectContaining({ reason: 'tenant_not_provisioned', tid: TID }),
      })
    );
  });

  it('403s with disabled when the org policy is off', async () => {
    setupDb({ mapping: MAPPING_ROW, user: USER_ROW });
    getOrgPolicyMock.mockResolvedValue({ ...ENABLED_POLICY, enabled: false });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'disabled' });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'denied', orgId: ORG_ID })
    );
  });

  it('403s with user_not_permitted under userAccess=selected when the user is not listed', async () => {
    setupDb({ mapping: MAPPING_ROW, user: USER_ROW });
    getOrgPolicyMock.mockResolvedValue({
      ...ENABLED_POLICY,
      userAccess: 'selected',
      selectedUserIds: ['ffffffff-1111-4222-8333-444455556666'],
    });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'user_not_permitted' });
  });

  it('403s when the portal user is not active', async () => {
    setupDb({ mapping: MAPPING_ROW, user: { ...USER_ROW, status: 'disabled' } });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_inactive' });
  });

  it('mints a clientai: Redis session for an existing user and audits success', async () => {
    setupDb({ mapping: MAPPING_ROW, user: USER_ROW });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.length).toBeGreaterThanOrEqual(32);
    expect(body.expiresInSeconds).toBe(86400);
    expect(body.user).toEqual({
      id: PORTAL_USER_ID,
      email: 'finance.user@contoso.com',
      name: 'Finance User',
    });

    expect(redisMock.setex).toHaveBeenCalledWith(
      `clientai:session:${body.accessToken}`,
      86400,
      expect.stringContaining(PORTAL_USER_ID)
    );
    expect(dbInsertMock).not.toHaveBeenCalled();
    expect(dbUpdateMock).toHaveBeenCalled(); // lastLoginAt refresh
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.auth.exchange',
        result: 'success',
        orgId: ORG_ID,
        actorId: PORTAL_USER_ID,
      })
    );
  });

  it('auto-provisions a portal user (authMethod=entra) on first exchange', async () => {
    setupDb({ mapping: MAPPING_ROW, user: null });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(200);

    expect(dbInsertMock).toHaveBeenCalled();
    const valuesFn = dbInsertMock.mock.results[0]!.value.values;
    expect(valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        email: 'finance.user@contoso.com',
        entraOid: OID,
        entraTenantId: TID,
        authMethod: 'entra',
        passwordHash: null,
      })
    );
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'success',
        details: expect.objectContaining({ provisioned: true }),
      })
    );
  });

  it('503s when Redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    const res = await postExchange(buildApp());
    expect(res.status).toBe(503);
  });

  it('400s on a missing accessToken body field', async () => {
    const app = buildApp();
    const res = await app.request('/client-ai/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/auth.test.ts`
Expected: FAIL with module-not-found for `./auth`.

- [ ] **Step 4: Write minimal implementation**

`apps/api/src/routes/clientAi/auth.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, withSystemDbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import { clientAiTenantMappings } from '../../db/schema/clientAi';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { getTrustedClientIp } from '../../services/clientIp';
import { writeAuditEvent, type RequestLike } from '../../services/auditEvents';
import { CLIENT_AI_ENTRA_CLIENT_ID } from '../../config/env';
import {
  verifyEntraIdToken,
  ClientAiEntraInvalidTokenError,
  ClientAiEntraJwksUnavailableError,
} from '../../services/clientAiEntraJwt';
import { getOrgPolicy, isClientUserPermitted } from '../../services/clientAiPolicy';
import {
  exchangeSchema,
  CLIENT_AI_REDIS_KEYS,
  CLIENT_AI_SESSION_TTL_SECONDS,
  EXCHANGE_RATE_LIMIT,
} from './schemas';

/**
 * POST /client-ai/auth/exchange — Entra ID token → Breeze client-AI session.
 * Spec §3. Pre-auth route: tenant context comes FROM the verified token (tid →
 * client_ai_tenant_mappings), so DB work runs under system scope. One fast DB
 * block; Redis work stays outside it (#1105).
 */

export const clientAiAuthRoutes = new Hono();

type ExchangeUser = {
  id: string;
  orgId: string;
  email: string;
  name: string | null;
  status: string;
};

type Denied = {
  denied: {
    status: 403 | 404;
    error: string;
    orgId: string | null;
    details: Record<string, unknown>;
  };
};
type Resolved = { user: ExchangeUser; provisioned: boolean };

const USER_COLUMNS = {
  id: portalUsers.id,
  orgId: portalUsers.orgId,
  email: portalUsers.email,
  name: portalUsers.name,
  status: portalUsers.status,
};

function auditExchange(
  c: RequestLike,
  params: {
    orgId: string | null;
    result: 'success' | 'denied';
    actorId?: string | null;
    actorEmail?: string | null;
    details: Record<string, unknown>;
  }
): void {
  writeAuditEvent(c, {
    orgId: params.orgId,
    action: 'client_ai.auth.exchange',
    resourceType: 'client_ai_session',
    actorType: 'user',
    actorId: params.actorId ?? null,
    actorEmail: params.actorEmail ?? null,
    result: params.result,
    details: { principalType: 'portal_user', ...params.details },
  });
}

clientAiAuthRoutes.post('/auth/exchange', zValidator('json', exchangeSchema), async (c) => {
  if (!CLIENT_AI_ENTRA_CLIENT_ID) {
    return c.json({ error: 'not_enabled' }, 404);
  }

  // Client-AI sessions are Redis-only (no in-memory fallback — new surface,
  // every compose mode ships Redis).
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'service_unavailable' }, 503);
  }

  const ip = getTrustedClientIp(c);
  const rate = await rateLimiter(
    redis,
    `clientai-exchange-${ip}`,
    EXCHANGE_RATE_LIMIT.limit,
    EXCHANGE_RATE_LIMIT.windowSeconds
  );
  if (!rate.allowed) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const { accessToken } = c.req.valid('json');

  let claims;
  try {
    claims = await verifyEntraIdToken(accessToken, { audience: CLIENT_AI_ENTRA_CLIENT_ID });
  } catch (err) {
    if (err instanceof ClientAiEntraJwksUnavailableError) {
      console.error('[client-ai] Entra JWKS unavailable during exchange:', (err as Error).message);
      return c.json({ error: 'service_unavailable' }, 503);
    }
    if (err instanceof ClientAiEntraInvalidTokenError) {
      return c.json({ error: 'invalid_token' }, 401);
    }
    throw err;
  }

  const resolution = await withSystemDbAccessContext(async (): Promise<Denied | Resolved> => {
    const [mapping] = await db
      .select()
      .from(clientAiTenantMappings)
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

    const policy = await getOrgPolicy(mapping.orgId);
    if (!policy.enabled) {
      return {
        denied: {
          status: 403,
          error: 'disabled',
          orgId: mapping.orgId,
          details: { reason: 'disabled', tid: claims.tid, oid: claims.oid },
        },
      };
    }

    const now = new Date();
    let provisioned = false;
    let [user] = await db
      .select(USER_COLUMNS)
      .from(portalUsers)
      .where(
        and(eq(portalUsers.entraTenantId, claims.tid), eq(portalUsers.entraOid, claims.oid))
      )
      .limit(1);

    if (!user) {
      // portal_users.email is NOT NULL; some Entra token shapes carry no usable
      // address — fall back to a synthetic, non-routable one.
      const email = claims.email ?? `${claims.oid}@${claims.tid}.entra.invalid`;
      try {
        const inserted = await db
          .insert(portalUsers)
          .values({
            orgId: mapping.orgId,
            email,
            name: claims.name,
            passwordHash: null,
            entraOid: claims.oid,
            entraTenantId: claims.tid,
            authMethod: 'entra',
            lastLoginAt: now,
          })
          .returning(USER_COLUMNS);
        user = inserted[0];
        provisioned = true;
      } catch (err) {
        // Concurrent first-exchange race: portal_users_entra_identity_uniq
        // makes the loser 23505 — re-select the winner's row.
        if ((err as { cause?: { code?: string } }).cause?.code !== '23505') throw err;
        [user] = await db
          .select(USER_COLUMNS)
          .from(portalUsers)
          .where(
            and(eq(portalUsers.entraTenantId, claims.tid), eq(portalUsers.entraOid, claims.oid))
          )
          .limit(1);
      }
    } else {
      await db
        .update(portalUsers)
        .set({ lastLoginAt: now, updatedAt: now, ...(claims.name ? { name: claims.name } : {}) })
        .where(eq(portalUsers.id, user.id));
    }

    if (!user) {
      return {
        denied: {
          status: 403,
          error: 'provisioning_failed',
          orgId: mapping.orgId,
          details: { reason: 'provisioning_failed', tid: claims.tid, oid: claims.oid },
        },
      };
    }

    if (user.status !== 'active') {
      return {
        denied: {
          status: 403,
          error: 'account_inactive',
          orgId: mapping.orgId,
          details: { reason: 'account_inactive', portalUserId: user.id },
        },
      };
    }

    if (!isClientUserPermitted(policy, user.id)) {
      return {
        denied: {
          status: 403,
          error: 'user_not_permitted',
          orgId: mapping.orgId,
          details: { reason: 'user_not_permitted', portalUserId: user.id },
        },
      };
    }

    return { user, provisioned };
  });

  if ('denied' in resolution) {
    auditExchange(c, {
      orgId: resolution.denied.orgId,
      result: 'denied',
      details: resolution.denied.details,
    });
    return c.json({ error: resolution.denied.error }, resolution.denied.status);
  }

  const { user, provisioned } = resolution;
  const token = nanoid(48);
  await redis.setex(
    CLIENT_AI_REDIS_KEYS.session(token),
    CLIENT_AI_SESSION_TTL_SECONDS,
    JSON.stringify({ portalUserId: user.id, orgId: user.orgId, createdAt: new Date().toISOString() })
  );
  await redis.sadd(CLIENT_AI_REDIS_KEYS.userSessions(user.id), token);
  await redis.expire(CLIENT_AI_REDIS_KEYS.userSessions(user.id), CLIENT_AI_SESSION_TTL_SECONDS * 2);

  auditExchange(c, {
    orgId: user.orgId,
    result: 'success',
    actorId: user.id,
    actorEmail: user.email,
    details: { tid: claims.tid, oid: claims.oid, provisioned },
  });

  return c.json({
    accessToken: token,
    expiresInSeconds: CLIENT_AI_SESSION_TTL_SECONDS,
    user: { id: user.id, email: user.email, name: user.name },
  });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/auth.test.ts`
Expected: 11 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/clientAi/schemas.ts apps/api/src/routes/clientAi/auth.ts apps/api/src/routes/clientAi/auth.test.ts
git commit -m "feat(client-ai): POST /client-ai/auth/exchange — Entra token exchange with auto-provisioning" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Client auth middleware + policy-enforcement middleware (TDD)

Mirrors `portalAuthMiddleware` (`apps/api/src/routes/portal/auth.ts:52-191`): bearer token → Redis lookup → system-scope `portal_users` hydration → sliding TTL → `withDbAccessContext` org scope around `next()`. Differences: bearer-only (no cookies, the add-in is not a browser-cookie surface), Redis-only.

**Files:**
- Create: apps/api/src/middleware/clientAiAuth.ts
- Test: apps/api/src/middleware/clientAiAuth.test.ts

- [ ] **Step 1: Write the failing test**

`apps/api/src/middleware/clientAiAuth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  redisMock,
  getRedisMock,
  dbSelectMock,
  withDbAccessContextMock,
  capturedDbContexts,
  getOrgPolicyMock,
} = vi.hoisted(() => {
  const redis = {
    get: vi.fn(),
    del: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  const captured: unknown[] = [];
  return {
    redisMock: redis,
    getRedisMock: vi.fn(() => redis),
    dbSelectMock: vi.fn(),
    withDbAccessContextMock: vi.fn((ctx: unknown, fn: () => unknown) => {
      captured.push(ctx);
      return fn();
    }),
    capturedDbContexts: captured,
    getOrgPolicyMock: vi.fn(),
  };
});

vi.mock('../db', () => ({
  db: { select: dbSelectMock },
  withDbAccessContext: withDbAccessContextMock,
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../services/redis', () => ({ getRedis: getRedisMock }));

vi.mock('../services/clientAiPolicy', () => ({
  getOrgPolicy: getOrgPolicyMock,
  isClientUserPermitted: (
    policy: { userAccess: string; selectedUserIds: string[] },
    id: string
  ) => policy.userAccess === 'all' || policy.selectedUserIds.includes(id),
}));

import { clientAiAuthMiddleware, requireClientAiEnabledMiddleware } from './clientAiAuth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PORTAL_USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK';

const USER_ROW = {
  id: PORTAL_USER_ID,
  orgId: ORG_ID,
  email: 'finance.user@contoso.com',
  name: 'Finance User',
  status: 'active',
};

function setupUserSelect(row: object | null) {
  dbSelectMock.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(row ? [row] : [])) })),
    })),
  }));
}

function buildApp() {
  const app = new Hono();
  app.use('*', clientAiAuthMiddleware);
  app.get('/me', (c) => {
    const auth = c.get('clientAiAuth');
    return c.json({ clientUserId: auth.clientUserId, orgId: auth.orgId });
  });
  return app;
}

function get(app: Hono, headers: Record<string, string> = {}) {
  return app.request('/me', { method: 'GET', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedDbContexts.length = 0;
  getRedisMock.mockReturnValue(redisMock);
  redisMock.get.mockResolvedValue(
    JSON.stringify({ portalUserId: PORTAL_USER_ID, orgId: ORG_ID, createdAt: new Date().toISOString() })
  );
  setupUserSelect(USER_ROW);
});

describe('clientAiAuthMiddleware', () => {
  it('401s without a bearer token', async () => {
    const res = await get(buildApp());
    expect(res.status).toBe(401);
  });

  it('401s on an unknown/expired token and does not touch the DB', async () => {
    redisMock.get.mockResolvedValue(null);
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('401s and clears the session when the portal user row is gone', async () => {
    setupUserSelect(null);
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(401);
    expect(redisMock.del).toHaveBeenCalledWith(`clientai:session:${TOKEN}`);
  });

  it('403s when the portal user is not active', async () => {
    setupUserSelect({ ...USER_ROW, status: 'disabled' });
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(403);
  });

  it('503s when Redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(503);
  });

  it('attaches clientAiAuth, slides the TTL, and runs the handler inside an org-scoped DB context', async () => {
    const res = await get(buildApp(), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientUserId: PORTAL_USER_ID, orgId: ORG_ID });

    expect(redisMock.expire).toHaveBeenCalledWith(`clientai:session:${TOKEN}`, 86400);
    expect(capturedDbContexts[0]).toMatchObject({
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      accessiblePartnerIds: [],
      userId: null,
    });
  });
});

describe('requireClientAiEnabledMiddleware', () => {
  function buildGuardedApp() {
    const app = new Hono();
    app.use('*', clientAiAuthMiddleware);
    app.use('*', requireClientAiEnabledMiddleware);
    app.get('/guarded', (c) => c.json({ writeMode: c.get('clientAiPolicy').writeMode }));
    return app;
  }

  it('403s with disabled when the org policy is off', async () => {
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID,
      enabled: false,
      userAccess: 'all',
      selectedUserIds: [],
      writeMode: 'readwrite',
    });
    const res = await buildGuardedApp().request('/guarded', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'disabled' });
  });

  it('403s with user_not_permitted when the user falls off the selected list mid-session', async () => {
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID,
      enabled: true,
      userAccess: 'selected',
      selectedUserIds: ['ffffffff-1111-4222-8333-444455556666'],
      writeMode: 'readwrite',
    });
    const res = await buildGuardedApp().request('/guarded', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'user_not_permitted' });
  });

  it('passes the policy through to the handler when enabled', async () => {
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID,
      enabled: true,
      userAccess: 'all',
      selectedUserIds: [],
      writeMode: 'readonly',
    });
    const res = await buildGuardedApp().request('/guarded', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ writeMode: 'readonly' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/middleware/clientAiAuth.test.ts`
Expected: FAIL with module-not-found for `./clientAiAuth`.

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/middleware/clientAiAuth.ts`:

```ts
import type { Context, Next } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { portalUsers } from '../db/schema';
import { getRedis } from '../services/redis';
import { getOrgPolicy, isClientUserPermitted } from '../services/clientAiPolicy';
import {
  CLIENT_AI_REDIS_KEYS,
  CLIENT_AI_SESSION_TTL_SECONDS,
  type ClientAiSessionPayload,
} from '../routes/clientAi/schemas';

/**
 * Auth middleware for the /client-ai surface (Excel add-in end-users).
 *
 * Mirrors portalAuthMiddleware (routes/portal/auth.ts): bearer token →
 * Redis session → system-scope portal_users hydration (the row sits behind
 * org-forced RLS, pre-auth) → sliding TTL → handlers run inside an org-scoped
 * withDbAccessContext so RLS on every table is satisfied AND enforced under
 * the unprivileged breeze_app pool. Differences from the portal: bearer-only
 * (no cookies/CSRF — the add-in task pane is not a cookie surface) and
 * Redis-only (no in-memory dev fallback).
 *
 * Redis/session work happens BEFORE the DB context opens so the wrapping
 * transaction is never held across slow I/O (#1105).
 */
export async function clientAiAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }

  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const raw = await redis.get(CLIENT_AI_REDIS_KEYS.session(token));
  if (!raw) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  let session: ClientAiSessionPayload;
  try {
    session = JSON.parse(raw) as ClientAiSessionPayload;
  } catch {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }
  if (!session?.portalUserId || !session?.orgId) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  const [user] = await withSystemDbAccessContext(() =>
    db
      .select({
        id: portalUsers.id,
        orgId: portalUsers.orgId,
        email: portalUsers.email,
        name: portalUsers.name,
        status: portalUsers.status,
      })
      .from(portalUsers)
      .where(and(eq(portalUsers.id, session.portalUserId), eq(portalUsers.orgId, session.orgId)))
      .limit(1)
  );

  if (!user) {
    await redis.del(CLIENT_AI_REDIS_KEYS.session(token));
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  if (user.status !== 'active') {
    return c.json({ error: 'Account is not active' }, 403);
  }

  // Sliding session timeout: any authenticated activity pushes expiry forward.
  try {
    await redis.expire(CLIENT_AI_REDIS_KEYS.session(token), CLIENT_AI_SESSION_TTL_SECONDS);
  } catch (error) {
    console.error('[client-ai] Failed to extend session TTL:', error);
  }

  c.set('clientAiAuth', {
    clientUserId: user.id,
    orgId: user.orgId,
    email: user.email,
    name: user.name,
    token,
  });

  return withDbAccessContext(
    {
      scope: 'organization',
      orgId: user.orgId,
      accessibleOrgIds: [user.orgId],
      accessiblePartnerIds: [],
      userId: null,
    },
    () => next()
  );
}

/**
 * Policy gate for /client-ai feature routes (everything beyond /auth/exchange).
 * Re-checks enabled + selected-list on EVERY request so disabling the org or
 * de-selecting a user takes effect immediately, not at next token mint.
 * Runs inside the org context opened by clientAiAuthMiddleware; caches the
 * policy on the context for handlers (c.get('clientAiPolicy')).
 */
export async function requireClientAiEnabledMiddleware(c: Context, next: Next) {
  const auth = c.get('clientAiAuth');
  if (!auth) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const policy = await getOrgPolicy(auth.orgId);
  if (!policy.enabled) {
    return c.json({ error: 'disabled' }, 403);
  }
  if (!isClientUserPermitted(policy, auth.clientUserId)) {
    return c.json({ error: 'user_not_permitted' }, 403);
  }

  c.set('clientAiPolicy', policy);
  await next();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/middleware/clientAiAuth.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/clientAiAuth.ts apps/api/src/middleware/clientAiAuth.test.ts
git commit -m "feat(client-ai): bearer session middleware + per-request policy gate" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Admin routes — tenant mapping + policy CRUD (TDD)

Partner-scope routes for the (Plan 4) dashboard. Mirrors `routes/m365.ts` exactly: group-level `authMiddleware`, feature-flag 404 gate, `requirePermission(PERMISSIONS.ORGS_READ/WRITE)`, `requireMfa()` on the isolation-critical mapping mutations, org access resolved via `resolveScopedOrgId` (`routes/c2c/helpers.ts`), audits via `writeRouteAudit`.

Design notes:
- Path-param `:orgId` + `resolveScopedOrgId(auth, orgId)` → `null` means no access → **404** (no cross-tenant existence oracle).
- PUT tenant-mapping upserts on `org_id`; a 23505 on `client_ai_tenant_mappings_tenant_uniq` (tenant already mapped to a DIFFERENT org) → **409 `tenant_already_mapped`** with no hint of which org owns it.
- `requireMfa()` on mapping PUT/DELETE only (the mapping is the tenant-isolation linchpin, like the m365 secret routes); the policy editor is a frequent-touch surface and stays MFA-free.

**Files:**
- Create: apps/api/src/routes/clientAi/admin.ts
- Create: apps/api/src/routes/clientAi/index.ts
- Test: apps/api/src/routes/clientAi/admin.test.ts

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/clientAi/admin.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  dbSelectMock,
  dbInsertMock,
  dbDeleteMock,
  writeRouteAuditMock,
  getOrgPolicyMock,
} = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  dbInsertMock: vi.fn(),
  dbDeleteMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
  getOrgPolicyMock: vi.fn(),
}));

// Accessible org for the partner-scoped test auth context. Literal because
// vi.mock factories are hoisted.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('auth', {
      scope: 'partner',
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666',
      orgId: null,
      accessibleOrgIds: ['0c0c0c0c-1111-4222-8333-444455556666'],
      user: { id: 'ce11ce11-1111-4222-8333-444455556666', email: 'msp@example.com' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, delete: dbDeleteMock },
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../../services/clientAiPolicy', () => ({ getOrgPolicy: getOrgPolicyMock }));

import { clientAiAdminRoutes } from './admin';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const OTHER_ORG_ID = '9d9d9d9d-1111-4222-8333-444455556666'; // not accessible
const TID = '6f4f4f4f-1111-4222-8333-444455556666';

const MAPPING_ROW = {
  id: 'a1a1a1a1-1111-4222-8333-444455556666',
  orgId: ORG_ID,
  entraTenantId: TID,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(rows)) })),
    })),
  };
}

function buildApp() {
  const app = new Hono();
  app.route('/client-ai/admin', clientAiAdminRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
  dbSelectMock.mockImplementation(() => selectChain([MAPPING_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([MAPPING_ROW])),
      })),
    })),
  }));
  dbDeleteMock.mockImplementation(() => ({
    where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([MAPPING_ROW])) })),
  }));
});

describe('client-ai admin — tenant mapping', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`);
    expect(res.status).toBe(401);
  });

  it('404s for an org outside the caller scope (no existence oracle)', async () => {
    const res = await buildApp().request(
      `/client-ai/admin/orgs/${OTHER_ORG_ID}/tenant-mapping`,
      { headers: AUTHED }
    );
    expect(res.status).toBe(404);
  });

  it('GET returns the mapping when present', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mapping).toMatchObject({ orgId: ORG_ID, entraTenantId: TID });
  });

  it('GET returns mapping: null when absent', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mapping).toBeNull();
  });

  it('PUT rejects a non-GUID tenant id with 400', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ entraTenantId: 'contoso.onmicrosoft.com' }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT upserts the mapping and audits', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ entraTenantId: TID }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mapping).toMatchObject({ entraTenantId: TID });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'client_ai.tenant_mapping.upsert',
        resourceType: 'client_ai_tenant_mapping',
      })
    );
  });

  it('PUT maps a tenant-uniqueness violation to 409 tenant_already_mapped', async () => {
    dbInsertMock.mockImplementation(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.reject(Object.assign(new Error('duplicate'), { cause: { code: '23505' } }))
          ),
        })),
      })),
    }));
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ entraTenantId: TID }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'tenant_already_mapped' });
  });

  it('DELETE removes the mapping and audits', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/tenant-mapping`, {
      method: 'DELETE',
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mapping).toBeNull();
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'client_ai.tenant_mapping.delete' })
    );
  });
});

describe('client-ai admin — policy', () => {
  it('GET returns the effective policy (defaults when no row)', async () => {
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID,
      enabled: false,
      userAccess: 'all',
      selectedUserIds: [],
      allowedProviders: ['anthropic'],
      allowedModels: [],
      writeMode: 'readwrite',
      dlpConfig: {},
      dailyBudgetCents: null,
      monthlyBudgetCents: null,
      perUserMessagesPerMinute: 10,
      orgMessagesPerHour: 500,
      retentionDays: null,
      branding: {},
    });
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/policy`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy).toMatchObject({ enabled: false, allowedProviders: ['anthropic'] });
  });

  it('PUT rejects unknown fields (strict schema)', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/policy`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ enabled: true, surprise: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT upserts provided knobs only and audits the changed keys', async () => {
    getOrgPolicyMock.mockResolvedValue({ orgId: ORG_ID, enabled: true });
    const res = await buildApp().request(`/client-ai/admin/orgs/${ORG_ID}/policy`, {
      method: 'PUT',
      headers: AUTHED,
      body: JSON.stringify({ enabled: true, writeMode: 'readonly', dailyBudgetCents: 500 }),
    });
    expect(res.status).toBe(200);
    expect(dbInsertMock).toHaveBeenCalled();
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'client_ai.policy.update',
        details: expect.objectContaining({
          changedKeys: expect.arrayContaining(['enabled', 'writeMode', 'dailyBudgetCents']),
        }),
      })
    );
  });

  it('404s policy routes for an inaccessible org', async () => {
    const res = await buildApp().request(`/client-ai/admin/orgs/${OTHER_ORG_ID}/policy`, {
      headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/admin.test.ts`
Expected: FAIL with module-not-found for `./admin`.

- [ ] **Step 3: Write minimal implementation**

`apps/api/src/routes/clientAi/admin.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { clientAiOrgPolicies, clientAiTenantMappings } from '../../db/schema/clientAi';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { CLIENT_AI_ENTRA_CLIENT_ID } from '../../config/env';
import { resolveScopedOrgId } from '../c2c/helpers';
import { getOrgPolicy } from '../../services/clientAiPolicy';
import { putPolicySchema, putTenantMappingSchema } from './schemas';

/**
 * MSP-facing admin surface for Breeze AI for Office (spec §9, consumed by the
 * Plan-4 dashboard): tenant mapping + per-org policy. Mirrors routes/m365.ts:
 * group authMiddleware, feature 404 gate, ORGS_READ/ORGS_WRITE permissions,
 * MFA on the isolation-critical mapping mutations, writeRouteAudit on writes.
 *
 * Org access: resolveScopedOrgId(auth, :orgId) returns null when the caller
 * cannot access the org → respond 404 (never reveal cross-tenant existence).
 */

export const clientAiAdminRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);
const requireOrgsWrite = requirePermission(
  PERMISSIONS.ORGS_WRITE.resource,
  PERMISSIONS.ORGS_WRITE.action
);

clientAiAdminRoutes.use('*', authMiddleware);

// Whole group is dark unless the add-in app registration is configured.
clientAiAdminRoutes.use('*', async (c, next) => {
  if (!CLIENT_AI_ENTRA_CLIENT_ID) {
    return c.json({ error: 'Breeze AI for Office is not enabled' }, 404);
  }
  await next();
});

function resolveOrgOr404(c: Parameters<typeof writeRouteAudit>[0] & { req: { param: (k: string) => string } }) {
  const auth = (c as { get: (k: 'auth') => Parameters<typeof resolveScopedOrgId>[0] }).get('auth');
  return resolveScopedOrgId(auth, (c as { req: { param: (k: string) => string } }).req.param('orgId'));
}

function toMappingResponse(row: typeof clientAiTenantMappings.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    entraTenantId: row.entraTenantId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Tenant mapping ────────────────────────────────────────────────────────────

clientAiAdminRoutes.get('/orgs/:orgId/tenant-mapping', requireOrgsRead, async (c) => {
  const orgId = resolveOrgOr404(c as never);
  if (!orgId) return c.json({ error: 'Organization not found' }, 404);

  const [row] = await db
    .select()
    .from(clientAiTenantMappings)
    .where(eq(clientAiTenantMappings.orgId, orgId))
    .limit(1);

  return c.json({ mapping: row ? toMappingResponse(row) : null });
});

clientAiAdminRoutes.put(
  '/orgs/:orgId/tenant-mapping',
  requireOrgsWrite,
  requireMfa(),
  zValidator('json', putTenantMappingSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveOrgOr404(c as never);
    if (!orgId) return c.json({ error: 'Organization not found' }, 404);

    const { entraTenantId } = c.req.valid('json');
    const now = new Date();

    let row: typeof clientAiTenantMappings.$inferSelect | undefined;
    try {
      [row] = await db
        .insert(clientAiTenantMappings)
        .values({
          orgId,
          entraTenantId: entraTenantId.toLowerCase(),
          createdBy: auth.user?.id ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: clientAiTenantMappings.orgId,
          set: { entraTenantId: entraTenantId.toLowerCase(), updatedAt: now },
        })
        .returning();
    } catch (err) {
      // client_ai_tenant_mappings_tenant_uniq: the tenant is already mapped to
      // a DIFFERENT org. Deliberately opaque — do not reveal which org.
      if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
        return c.json({ error: 'tenant_already_mapped' }, 409);
      }
      throw err;
    }

    if (!row) return c.json({ error: 'Failed to save tenant mapping' }, 500);

    writeRouteAudit(c, {
      orgId,
      action: 'client_ai.tenant_mapping.upsert',
      resourceType: 'client_ai_tenant_mapping',
      resourceId: row.id,
      resourceName: row.entraTenantId,
      details: { entraTenantId: row.entraTenantId },
    });

    return c.json({ mapping: toMappingResponse(row) });
  }
);

clientAiAdminRoutes.delete(
  '/orgs/:orgId/tenant-mapping',
  requireOrgsWrite,
  requireMfa(),
  async (c) => {
    const orgId = resolveOrgOr404(c as never);
    if (!orgId) return c.json({ error: 'Organization not found' }, 404);

    const [row] = await db
      .delete(clientAiTenantMappings)
      .where(eq(clientAiTenantMappings.orgId, orgId))
      .returning();

    if (row) {
      writeRouteAudit(c, {
        orgId,
        action: 'client_ai.tenant_mapping.delete',
        resourceType: 'client_ai_tenant_mapping',
        resourceId: row.id,
        resourceName: row.entraTenantId,
      });
    }

    return c.json({ mapping: null });
  }
);

// ── Policy ────────────────────────────────────────────────────────────────────

clientAiAdminRoutes.get('/orgs/:orgId/policy', requireOrgsRead, async (c) => {
  const orgId = resolveOrgOr404(c as never);
  if (!orgId) return c.json({ error: 'Organization not found' }, 404);

  const policy = await getOrgPolicy(orgId);
  return c.json({ policy });
});

clientAiAdminRoutes.put(
  '/orgs/:orgId/policy',
  requireOrgsWrite,
  zValidator('json', putPolicySchema),
  async (c) => {
    const orgId = resolveOrgOr404(c as never);
    if (!orgId) return c.json({ error: 'Organization not found' }, 404);

    const body = c.req.valid('json');
    const now = new Date();

    // Only persist the knobs the caller provided; DB defaults fill the rest on
    // first insert, existing values survive on update.
    const set: Partial<typeof clientAiOrgPolicies.$inferInsert> = { updatedAt: now };
    if (body.enabled !== undefined) set.enabled = body.enabled;
    if (body.userAccess !== undefined) set.userAccess = body.userAccess;
    if (body.selectedUserIds !== undefined) set.selectedUserIds = body.selectedUserIds;
    if (body.allowedProviders !== undefined) set.allowedProviders = body.allowedProviders;
    if (body.allowedModels !== undefined) set.allowedModels = body.allowedModels;
    if (body.writeMode !== undefined) set.writeMode = body.writeMode;
    if (body.dlpConfig !== undefined) set.dlpConfig = body.dlpConfig;
    if (body.dailyBudgetCents !== undefined) set.dailyBudgetCents = body.dailyBudgetCents;
    if (body.monthlyBudgetCents !== undefined) set.monthlyBudgetCents = body.monthlyBudgetCents;
    if (body.perUserMessagesPerMinute !== undefined)
      set.perUserMessagesPerMinute = body.perUserMessagesPerMinute;
    if (body.orgMessagesPerHour !== undefined) set.orgMessagesPerHour = body.orgMessagesPerHour;
    if (body.retentionDays !== undefined) set.retentionDays = body.retentionDays;
    if (body.branding !== undefined) set.branding = body.branding;

    await db
      .insert(clientAiOrgPolicies)
      .values({ orgId, ...set })
      .onConflictDoUpdate({ target: clientAiOrgPolicies.orgId, set })
      .returning();

    const changedKeys = Object.keys(set).filter((k) => k !== 'updatedAt');
    writeRouteAudit(c, {
      orgId,
      action: 'client_ai.policy.update',
      resourceType: 'client_ai_org_policy',
      details: { changedKeys },
    });

    const policy = await getOrgPolicy(orgId);
    return c.json({ policy });
  }
);
```

`apps/api/src/routes/clientAi/index.ts`:

```ts
import { Hono } from 'hono';
import { clientAiAuthRoutes } from './auth';
import { clientAiAdminRoutes } from './admin';

/**
 * /client-ai — Breeze AI for Office namespace (spec §2).
 *  - /auth/exchange        pre-auth Entra token exchange (auth.ts)
 *  - /admin/orgs/:orgId/*  MSP admin surface (admin.ts, authMiddleware inside)
 * Plan 2 adds /sessions/* here behind clientAiAuthMiddleware +
 * requireClientAiEnabledMiddleware.
 */
export const clientAiRoutes = new Hono();

clientAiRoutes.route('/', clientAiAuthRoutes);
clientAiRoutes.route('/admin', clientAiAdminRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/admin.test.ts`
Expected: 12 tests PASS.

Note: if the `resolveOrgOr404` helper's casts fight the type-checker, inline the two lines at each call site instead (`const auth = c.get('auth'); const orgId = resolveScopedOrgId(auth, c.req.param('orgId'));`) — that is exactly what routes/m365.ts does and is the preferred fallback.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clientAi/admin.ts apps/api/src/routes/clientAi/admin.test.ts apps/api/src/routes/clientAi/index.ts
git commit -m "feat(client-ai): partner-scope admin routes for tenant mapping + org policy" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Mount the namespace + final verification sweep

**Files:**
- Modify: apps/api/src/index.ts (import near line 72 `import { portalRoutes } from './routes/portal';`; mount near line 779 `api.route('/portal', portalRoutes);`)

- [ ] **Step 1: Mount the routes**

Add the import next to the portalRoutes import (~line 72):

```ts
import { clientAiRoutes } from './routes/clientAi';
```

Add the mount immediately after `api.route('/portal', portalRoutes);` (~line 779):

```ts
api.route('/client-ai', clientAiRoutes);
```

- [ ] **Step 2: Type-check**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit`
Expected: only the pre-existing `agents.test.ts` / `apiKeyAuth.test.ts` errors.

- [ ] **Step 3: Run every test file this plan added or touched (single command, no full-suite flake)**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run \
  src/services/clientAiEntraJwt.test.ts \
  src/services/clientAiPolicy.test.ts \
  src/routes/clientAi/auth.test.ts \
  src/routes/clientAi/admin.test.ts \
  src/middleware/clientAiAuth.test.ts
```

Expected: all PASS (~52 tests).

- [ ] **Step 4: Re-run the DB-backed checks once more against the test stack**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm test:rls-coverage
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/client-ai-templates-rls.integration.test.ts
```

Expected: both PASS.

- [ ] **Step 5: Smoke the mounted route against the dev stack (optional but cheap)**

With the dev compose stack running (`docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up -d`):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost/api/v1/client-ai/auth/exchange \
  -H 'Content-Type: application/json' -d '{"accessToken":"x"}'
```

Expected: `404` when `CLIENT_AI_ENTRA_CLIENT_ID` is unset in the dev env (the dark-gate), `401` once it is set (invalid token). Either proves the mount.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(client-ai): mount /client-ai route namespace" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan (later plans)

- `/client-ai/sessions/*`, SDK wiring, SSE tool protocol, budget pre-flight (`checkBudget`/`checkBillingCredits` integration) — Plan 2. (`requireClientAiEnabledMiddleware` + `clientAiPolicy` from this plan are its entry points.)
- DLP service (`clientAiDlp.ts`) — Plan 3; `client_ai_org_policies.dlp_config` is already in place.
- Dashboard UI (onboarding wizard, policy editor, audit viewer, usage report, template CRUD routes + UI) — Plan 4. The template **table** ships here (all schema in one PR train per spec §12); the template **routes** ship with the manager in Plan 4.
- Excel add-in (`apps/excel-addin/`) — Plan 5.
- Writes to `client_ai_usage` and `ai_sessions.type='excel_client'` rows — Plan 2 (schema + constraints land here so Plan 2 is purely additive code).

## Open questions embedded above (for the implementer/reviewer)

1. **MFA scope on admin mutations** — this plan requires MFA on tenant-mapping PUT/DELETE only (mirroring m365.ts's secret mutations) and not on policy PUT. If review wants MFA on `enabled` flips too, it is a one-line `requireMfa()` insertion.
2. **Synthetic email fallback** (`{oid}@{tid}.entra.invalid`) for tokens without a usable address — alternative is rejecting such tokens with 403; chosen fallback keeps legitimate guest/service identities working. Revisit if the MSP-facing user list looks confusing in Plan 4.
3. **`auth_method` CHECK** is `('password','entra')`; a future SSO method needs a migration to relax it — intentional, mirrors the enum+CHECK convention.
