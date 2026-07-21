# PR 3 — SSO / OIDC Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close SR2-10 … SR2-14. Make the SSO default role obey the same permission-subset ceiling as ordinary user administration; give SSO providers a monotonic config version and make pending SSO sessions bound to it *and* (for link sessions) to the initiating user's live security generation; require a positively-verified email before an assertion may drive account resolution; and route every provider-controlled outbound fetch — **including jose's internal JWKS refresh** — through the existing SSRF-safe transport, with discovery-derived endpoints validated before persistence and re-validated at runtime.

**Architecture:** The SSO stack is *already* substantially hardened (PKCE S256, nonce, HMAC browser-binding cookie, atomic single-use state consume, mandatory id_token signature verification with an asymmetric-only alg allowlist, userinfo↔id_token `sub` binding, passwordless-only auto-link, DNS-TXT verified-domain machinery, and an SSRF-safe `safeFetch`). **Do not rebuild any of those.** PR 3 adds five surgical layers on top:

1. `services/roleAssignment.ts` — the canonical assignable-role validator, extracted verbatim out of `routes/users.ts` (where it is module-private) so `routes/sso.ts` can consume the *same* code instead of forking a weaker copy.
2. `sso_providers.config_version` — bumped on every config change *and* every status change. Pending `sso_sessions` snapshot it; the callback rejects a version drift or a non-active provider.
3. `sso_sessions` link-binding columns (`initiating_auth_epoch`, `initiating_mfa_epoch`, `initiating_session_id`) + **RLS (ENABLE + FORCE, system-scope-only policy)**. The link callback re-checks the binding against live state, so logout / password reset / suspension / global revocation invalidate a pending link.
4. A single verified-email decision point that reads `email_verified` from *whichever* claim source supplied the final email (id_token **or** userinfo — userinfo's copy is never read today) and requires org-domain ownership when the claim is absent.
5. `safeFetch` injected into jose via the `customFetch` symbol, plus `assertSafeOidcEndpoint` applied to discovery output before persistence and to persisted endpoints at runtime.

**Tech Stack:** Hono (TypeScript), Drizzle ORM, PostgreSQL (RLS via `breeze_app`), `jose` 6.2.3, Vitest.

**Stacks on:** `core-auth-2-mfa-policy` (PR #2385) → `core-auth-1-lifecycle-foundation` (PR #2378). Branch: **`core-auth-3-sso-oidc`**. PR 1 + PR 2 primitives are already on this branch — **do not re-implement them**:
- `getUserEpochs(userId, executor?) : Promise<{ authEpoch: number; mfaEpoch: number } | null>` — `services/authEpochs.ts:15`, re-exported from `services/index.ts:20`.
- `getRefreshFamily(familyId) : Promise<{ revokedAt: Date | null; absoluteExpiresAt: Date } | null>` — `services/refreshTokenFamily.ts:72`, re-exported from `services/index.ts:21` (system-scoped internally).
- `auth.token.sid` — `TokenPayload.sid?` (`services/jwt.ts:210`), reachable as `auth.token` on `AuthContext` (`middleware/auth.ts:25`). Never read in `sso.ts` today.
- `enforceExistingFactorStepUp` (`routes/auth/helpers.ts:252-281`) — **the canonical bind-and-recheck shape.** Task 5 mirrors it (capture `{authEpoch, mfaEpoch, sid}` at mint; re-check against the live row at consume; 503 when `!epochs || !auth.token.sid`).

---

## Global Constraints

- **Node 22.20.0.** Prefix every `pnpm`/`node` command with `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"` (no version manager is installed; the pinned binary lives there).
- **Migration IS required in this PR** (unlike PR 2). Hand-written idempotent SQL in `apps/api/migrations/`, filename `YYYY-MM-DD-<slug>.sql` that sorts **after** `2026-07-15-auth-epochs-and-family-expiry.sql` (PR 1's migration — currently the last file). **No inner `BEGIN;`/`COMMIT;`** (`autoMigrate` wraps each file in `client.begin(...)`). `IF NOT EXISTS` / `DO $$ … END $$` everywhere; re-applying must be a pure no-op. Never edit a shipped migration.
- **New/changed RLS ships in the same migration and registers in `rls-coverage.integration.test.ts` in the same PR.** `sso_sessions` gains ENABLE + FORCE RLS with a **system-scope-only** policy. Adding a *column* to `sso_providers` needs **no** policy change — the existing dual-axis `sso_providers_org_isolation` policy (`migrations/2026-07-03-sso-partner-axis-login-branding.sql:67-92`) already covers all columns.
- **Reuse, do not rebuild.** `safeFetch` / `SsrfBlockedError` / `isPrivateIp` / `isAlwaysBlockedIp` (`services/urlSafety.ts:208`, `:23`, `:118`) and `checkSsrfSafe` (`services/ssrfGuard.ts:111`) already exist. **Do not author a third SSRF utility.** `validateAssignableRole` is extracted, not copied.
- **Public auth errors are generic; server-side audit reasons are specific.** Callback rejections redirect to the existing `/login?error=<code>` (login mode) or `/settings/profile?ssoLinkError=<code>` (link mode) convention. **Audit `details` NEVER contain `state`, `code_verifier`, `code`, an `id_token`/`access_token`/`refresh_token`, or a decrypted `client_secret`** — only ids, reason codes, and version integers.
- **Fail closed.** A missing binding column, an unresolvable epoch, an unresolvable refresh family, or an unvalidatable endpoint rejects the transaction. Security-state DB failure fails the mutation with no success audit.
- **DB context.** `/sso/callback` and `/sso/login/*` are unauthenticated — every DB touch there runs inside `withSystemDbAccessContext`. **There are TWO authenticated bare-`db` writes to `sso_sessions` today, and both only work because the table has no RLS:**
  1. `POST /sso/link/start` — the session INSERT (`routes/sso.ts:1098-1106`).
  2. `DELETE /providers/:id` — `await db.delete(ssoSessions).where(eq(ssoSessions.providerId, providerId))` (`routes/sso.ts:690`), followed by `db.delete(userSsoIdentities)` (`:691`).

  Task 1 enables FORCE RLS with a system-only policy, so **Task 1 must wrap BOTH** or it ships two regressions. The second is the nastier one: the FK `sso_sessions_provider_id_sso_providers_id_fk` (`0001-baseline.sql:14888`) has **no `ON DELETE CASCADE`**, so a silently-0-rowing session delete makes the subsequent `db.delete(ssoProviders)` raise FK violation **23503 → 500** whenever a pending session exists — i.e. any provider deletion within 10 minutes of a login attempt. The bare pool is forbidden in request code.
- **Sequencing.** Task 1 adds `provider_version` (and purges unbound rows); **Task 4** adds the writers that populate it. Between those two commits every newly created session has `provider_version = NULL`, and once Task 4's gate lands those sessions are dead on arrival. Harmless inside a single PR — but **do NOT cherry-pick Task 1 alone onto a droplet.**
- **Test-harness landmines in `routes/sso.test.ts` (2446 lines) — read before touching `sso.ts`:**
  - `vi.mock('../services')` (`:49-67`) is a **full factory with no `importOriginal`**. **Any new import from `'../services'` into `sso.ts` must be added to that factory or the ENTIRE suite fails at import.** Task 5 adds `getRefreshFamily`.
  - `vi.mock('../services/sso')` (`:22-47`) is likewise a **full factory** (`idpAssertedMfa` is the one real impl). Task 6 adds `readEmailVerifiedClaim` → **must be added to that factory** (use the real one-liner, not a stub, so the tests exercise it).
  - `services/roleAssignment.ts` (Task 2) is a **new module path** — `vi.mock('../services')` does NOT cover it. Task 3 must add a dedicated `vi.mock('../services/roleAssignment', …)`.
  - `vi.mock('../db/schema')` (`:100-156`) has **`ssoSessions: {}` — empty**. Any test asserting on a new `ssoSessions` column must add the key.
  - `vi.mock('../middleware/auth')` (`:174-208`) sets a fake `auth` with `user: { id, email }` and **no `token` key**. Task 5 reads `auth.token.sid` → **every link test throws** unless the mock gains `token: { sid: '…' }`.
  - `beforeEach` (`:255-308`) hard-`mockReset()`s each db verb; per-test priming uses `mockReturnValueOnce` **queues in the exact order the route issues selects**. **Adding a select to the callback shifts every downstream queue in every primed test.** Tasks 4, 5, 6 add selects — expect to re-order `primeLinkCallback` (`:2391-2398`) and the login-callback primers, and budget for it.
- **API suite is parallel-flaky** → run focused, named files. `tsc` is OOM-prone project-wide.
- **Commit after each green task.** TDD: write the failing test, observe the reviewed failure, then implement.
- **Do NOT open the PR.** Task 8 ends at a green verification gate; the controller opens the PR after a whole-branch review.

## File Structure

- **Create** `apps/api/migrations/2026-07-16-sso-session-binding-and-provider-version.sql` (Task 1)
- **Create** `apps/api/src/services/roleAssignment.ts` + `roleAssignment.test.ts` (Task 2)
- **Create** `apps/api/src/__tests__/integration/ssoHardening.integration.test.ts` (Task 8)
- **Create** `apps/api/src/__tests__/integration/ssoSessionsRls.integration.test.ts` (Task 8)
- **Modify** `apps/api/src/db/schema/sso.ts` — `ssoProviders.configVersion`; `ssoSessions.providerVersion` / `.initiatingAuthEpoch` / `.initiatingMfaEpoch` / `.initiatingSessionId` (Task 1)
- **Modify** `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — register `sso_sessions` (Task 1)
- **Modify** `apps/api/src/routes/users.ts` — delete the private helpers, import from `services/roleAssignment` (Task 2)
- **Modify** `apps/api/src/routes/sso.ts` — role validation both axes + JIT re-validation (Task 3); version bump + status/version gate (Task 4); link binding capture + re-check (Task 5); verified-email gate + org clamp (Task 6); endpoint re-validation in `getOIDCConfig` (Task 7)
- **Modify** `apps/api/src/services/sso.ts` — `readEmailVerifiedClaim` (Task 6); `customFetch` injection, `assertSafeOidcEndpoint`, `validateDiscoveredEndpoints`, `timeoutMs`/`maxBytes`, `OIDCConfig.allowPrivateNetwork` (Task 7)
- **Modify** `apps/api/src/services/urlSafety.ts` + `urlSafety.test.ts` — `SafeFetchInit.maxBytes` + `ResponseTooLargeError` bounded body read (Task 7)
- **Modify** `apps/web/src/components/settings/ConnectSsoCard.tsx` + `ConnectSsoCard.test.tsx` + `connectSsoCard.*` i18n keys — web arm for the new `ssoLinkError` codes (Task 6)
- **Modify** `apps/api/src/routes/sso.test.ts` — mock-factory extensions + new tests (Tasks 3-7)
- **Modify** `apps/api/src/services/sso.test.ts` — `readEmailVerifiedClaim`, endpoint validation, JWKS `customFetch` (Tasks 6, 7)
- **Modify** `apps/api/src/routes/users.test.ts` — unchanged assertions must stay green (Task 2)

---

### Task 1: Migration + schema + `sso_sessions` RLS

**Files:**
- Create: `apps/api/migrations/2026-07-16-sso-session-binding-and-provider-version.sql`
- Modify: `apps/api/src/db/schema/sso.ts:11-62` (`ssoProviders`), `:92-110` (`ssoSessions`)
- Modify: `apps/api/src/routes/sso.ts:1098-1106` (link-start insert → system context) **and `:690-691`** (`DELETE /providers/:id` cleanup deletes → system context)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:68-80` (`INTENTIONAL_UNSCOPED`) + a new bespoke `it(...)`
- Test: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (real DB), `apps/api/src/routes/sso.test.ts` (link-start still 200; **provider delete still 200 with a pending session present**)

**Interfaces:**
- Produces (Drizzle, consumed by Tasks 3 + 4 + 5):
  ```ts
  // ssoProviders
  configVersion: integer('config_version').notNull().default(1)          // number
  defaultRoleConfiguredBy: uuid('default_role_configured_by'),           // string | null — the admin who last SET defaultRoleId (Task 3's JIT principal)
  // ssoSessions
  providerVersion:     integer('provider_version'),                   // number | null
  initiatingAuthEpoch: integer('initiating_auth_epoch'),              // number | null
  initiatingMfaEpoch:  integer('initiating_mfa_epoch'),               // number | null
  initiatingSessionId: uuid('initiating_session_id'),                 // string | null (= refresh_token_families.family_id, the JWT `sid`)
  ```

**Decisions (documented here, not deferred):**
- **Filename:** `2026-07-16-sso-session-binding-and-provider-version.sql`. The last shipped migration is `2026-07-15-auth-epochs-and-family-expiry.sql` (PR 1); `2026-07-16-*` sorts after it under `localeCompare`. No `-a-`/`-b-` infix is needed (single file, no same-day sibling).
- **`config_version` is `NOT NULL DEFAULT 1`.** Every existing provider starts at generation 1. Monotonic `+1` on any config or status change (Task 4).
- **`default_role_configured_by UUID NULL` is added here, used by Task 3.** The JIT permission ceiling needs a *principal* to compare the delegated role against. `created_by` is the wrong one: it names the **original creator**, while config-time validation checks the **current caller** — so Admin B (broad permissions) could save a `defaultRoleId` that Admin A (the narrow creator) cannot support, and the provider would save cleanly but fail JIT forever, silently. Worse, **no API route rewrites `created_by`**, so once the creator offboards the provider is unrepairable — and it cannot simply be recreated, because `(provider_id, external_id)` is the identity key for every `user_sso_identities` row. A dedicated column stamped by **every write that sets `defaultRoleId`** (POST and PATCH alike) collapses the principal mismatch AND gives admins a first-class repair: re-save the default role as a current admin.
- **The four `sso_sessions` columns are NULLABLE.** Login sessions never set the three `initiating_*` columns (there is no initiating user), so `NOT NULL` is impossible. `provider_version` is nullable **only** so the migration doesn't have to backfill in-flight rows.
- **How the callback distinguishes login from link mode:** unchanged — `session.linkUserId != null` ⇒ link mode (`routes/sso.ts:1561`). The three `initiating_*` columns are read **only** in that branch.
- **Fail-closed on NULL, not default-to-1.** A session row whose `provider_version` is NULL (i.e. created by the pre-deploy code, still inside its ≤10-min TTL) is **rejected** by the callback (Task 4), and a link session missing any `initiating_*` column is **rejected** (Task 5). Backfilling them to `1` would silently bless exactly the un-bound sessions this PR exists to invalidate. The blast radius is bounded: at most one 10-minute window of in-flight SSO round-trips at deploy time, and PR 1 already forces a global sign-out on this branch.
- **RLS classification for `sso_sessions`: system-scope-only.** It has no `org_id`/`partner_id` and never will — it is a short-lived pre-auth CSRF/PKCE transaction store written and consumed exclusively by unauthenticated (`/sso/login/*`, `/sso/callback`) or system-context (`/sso/link/start`, after this task) code paths. There is no tenant reader. That is exactly the `partner_abuse_signals` / `software_product_resolutions` shape: `ENABLE` + `FORCE ROW LEVEL SECURITY` with one ALL-command policy `USING/WITH CHECK (current_setting('breeze.scope', true) = 'system')`. It therefore registers in **`INTENTIONAL_UNSCOPED`** (the documentation list for system-scoped tables), **not** in any of the six tenant-shape allowlists — none of which it satisfies. It does **not** go in `EXEMPT_TABLES`: that set only exists to silence the `org_id`-column auto-discovery query, and `sso_sessions` has no `org_id`, so auto-discovery never surfaces it. Because neither list actually *asserts* anything about it, this task also adds a **bespoke `it(...)`** to the contract file that asserts `relrowsecurity`, `relforcerowsecurity`, and the system-only predicate — so the classification is enforced, not merely annotated.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, add this test inside the top-level `describe('RLS coverage contract', …)` block (place it next to the other bespoke policy tests, e.g. after the `'OAuth token-row policies do not grant generic org-axis access'` test at `:528`):

```ts
  it('sso_sessions is forced-RLS and reachable only from system scope', async () => {
    const [cls] = (await db.execute(sql`
      SELECT c.relrowsecurity AS rls_on, c.relforcerowsecurity AS force_on
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'sso_sessions';
    `)) as unknown as Array<{ rls_on: boolean; force_on: boolean }>;

    expect(cls?.rls_on).toBe(true);
    expect(cls?.force_on).toBe(true);

    const policies = (await db.execute(sql`
      SELECT policyname, cmd, COALESCE(qual, '') AS qual, COALESCE(with_check, '') AS with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'sso_sessions'
      ORDER BY policyname;
    `)) as unknown as Array<{ policyname: string; cmd: string; qual: string; with_check: string }>;

    // Exactly one ALL-command system-only policy. sso_sessions is a pre-auth
    // CSRF/PKCE transaction store with no tenant column — no tenant axis may
    // read or write it, only withSystemDbAccessContext.
    expect(policies).toHaveLength(1);
    expect(policies[0]?.policyname).toBe('sso_sessions_system_only');
    expect(policies[0]?.cmd).toBe('ALL');
    const predicate = `${policies[0]?.qual}\n${policies[0]?.with_check}`;
    expect(predicate).toContain("current_setting('breeze.scope'");
    expect(predicate).not.toContain('breeze_has_org_access');
    expect(predicate).not.toContain('breeze_has_partner_access');
  });

  it('sso_sessions carries the provider-version and link-binding columns', async () => {
    const cols = (await db.execute(sql`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sso_sessions'
        AND column_name IN ('provider_version', 'initiating_auth_epoch', 'initiating_mfa_epoch', 'initiating_session_id')
      ORDER BY column_name;
    `)) as unknown as Array<{ column_name: string; is_nullable: string; data_type: string }>;

    expect(cols.map((c) => c.column_name)).toEqual([
      'initiating_auth_epoch', 'initiating_mfa_epoch', 'initiating_session_id', 'provider_version',
    ]);
    // All nullable: login sessions have no initiating user; provider_version is
    // NULL only for pre-deploy in-flight rows (which the callback rejects).
    for (const c of cols) expect(c.is_nullable).toBe('YES');

    const [pv] = (await db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sso_providers' AND column_name = 'config_version';
    `)) as unknown as Array<{ is_nullable: string; column_default: string }>;
    expect(pv?.is_nullable).toBe('NO');
    expect(pv?.column_default).toContain('1');

    const [drcb] = (await db.execute(sql`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sso_providers' AND column_name = 'default_role_configured_by';
    `)) as unknown as Array<{ is_nullable: string; data_type: string }>;
    expect(drcb?.is_nullable).toBe('YES');
    expect(drcb?.data_type).toBe('uuid');
  });
```

Also add `sso_sessions` to `INTENTIONAL_UNSCOPED` (`:68-80`), after the `partner_abuse_signals` entry:

```ts
  'sso_sessions', // Pre-auth SSO CSRF/PKCE transaction store (state/nonce/code_verifier + link binding). No tenant column; written/consumed only by unauthenticated callback + system-context routes. Forced RLS, system-only policy → only system context.
```

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts -t 'sso_sessions'
```
Expected: **FAIL** — `rls_on` is `false` (the table has zero policies and RLS was never enabled), and the four columns do not exist.

- [ ] **Step 3: Implement — the migration**

Create `apps/api/migrations/2026-07-16-sso-session-binding-and-provider-version.sql`:

```sql
-- PR 3 (SR2-11): SSO provider config generations + pending-session binding.
--
-- 1. sso_providers.config_version — monotonic generation, bumped by every
--    config change AND every status change. A pending SSO session snapshots it;
--    the callback rejects a drift, so a provider reconfigured or disabled during
--    the <=10-minute state TTL cannot complete a login or an account link.
--    No RLS change needed: sso_providers already carries the dual-axis ALL
--    policy sso_providers_org_isolation (2026-07-03), which covers all columns.
--
-- 1b. sso_providers.default_role_configured_by (SR2-10) -- the admin who LAST SET
--    default_role_id. This is the principal the callback re-validates the
--    delegated role against just before JIT provisioning. created_by is the wrong
--    principal: it names the ORIGINAL creator while config-time validation checks
--    the CURRENT caller, and no route ever rewrites it -- so an offboarded creator
--    would make JIT fail permanently with no repair path (the provider cannot be
--    recreated without orphaning every user_sso_identities row, since
--    (provider_id, external_id) is the identity key).
--
-- 2. sso_sessions binding columns. NULLABLE by construction: a LOGIN session has
--    no initiating user, so the three initiating_* columns are only ever set by
--    POST /sso/link/start. provider_version is nullable only so this migration
--    needs no backfill; the callback treats NULL as a REJECT (fail closed) --
--    defaulting pre-deploy rows to 1 would bless exactly the unbound sessions
--    this change exists to invalidate. Worst case is one <=10-minute window of
--    in-flight SSO round-trips at deploy time.
--
-- 3. sso_sessions RLS. The table had NONE (created in 0001-baseline.sql:5828,
--    never given a policy). It is a pre-auth CSRF/PKCE transaction store with no
--    tenant column, written and consumed only by unauthenticated (/sso/callback,
--    /sso/login/*) or system-context (/sso/link/start) code. Classification:
--    system-scope-only -- ENABLE + FORCE RLS with one ALL-command policy keyed on
--    breeze.scope = 'system'. Same shape as partner_abuse_signals (2026-07-13)
--    and software_product_resolutions. Registered in INTENTIONAL_UNSCOPED in
--    rls-coverage.integration.test.ts.

ALTER TABLE sso_providers
  ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE sso_providers
  ADD COLUMN IF NOT EXISTS default_role_configured_by UUID REFERENCES users(id);

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS provider_version INTEGER;

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS initiating_auth_epoch INTEGER;

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS initiating_mfa_epoch INTEGER;

ALTER TABLE sso_sessions
  ADD COLUMN IF NOT EXISTS initiating_session_id UUID;

COMMENT ON COLUMN sso_providers.config_version IS
  'Monotonic config generation. Bumped on every provider config change and status change. Pending sso_sessions snapshot it; the callback rejects a mismatch (SR2-11).';
COMMENT ON COLUMN sso_providers.default_role_configured_by IS
  'The admin who last SET default_role_id. The SSO callback re-validates the delegated role against THIS user''s live permission ceiling before JIT provisioning (SR2-10). Re-saving the default role as a current admin is the repair path when the previous configurer is offboarded.';
COMMENT ON COLUMN sso_sessions.provider_version IS
  'sso_providers.config_version snapshot at session creation. NULL = pre-deploy row; the callback rejects it (fail closed).';
COMMENT ON COLUMN sso_sessions.initiating_session_id IS
  'Link mode only: refresh_token_families.family_id (the initiating access token''s `sid`). The link callback requires that family to still be live.';

-- Purge any session rows that predate the binding columns. They are all <=10
-- minutes from expiry and cannot satisfy the new callback checks anyway; purging
-- them makes the invalidation explicit (and auditable) instead of surfacing as a
-- burst of session_expired redirects. Report the count -- silently discarding
-- rows destroys the forensic trail.
DO $$
DECLARE
  n INTEGER;
BEGIN
  DELETE FROM sso_sessions WHERE provider_version IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'purged % in-flight sso_sessions rows with no provider_version binding (SR2-11 rollout)', n;
  END IF;
END $$;

ALTER TABLE sso_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_sessions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'sso_sessions'
      AND policyname = 'sso_sessions_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY sso_sessions_system_only
        ON sso_sessions
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END $$;
```

- [ ] **Step 4: Implement — the Drizzle schema**

In `apps/api/src/db/schema/sso.ts`, add `integer` to the `drizzle-orm/pg-core` import on line 1:

```ts
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, uniqueIndex, integer } from 'drizzle-orm/pg-core';
```

In `ssoProviders` (`:11-62`), add immediately after `trustsIdpMfa` (`:56`), before the `// Metadata` block:

```ts
  // Monotonic config generation (SR2-11). Bumped by PATCH /providers/:id and by
  // POST /providers/:id/status. Pending sso_sessions snapshot this value; the
  // callback rejects a session whose snapshot no longer matches, so a provider
  // reconfigured or disabled mid-flow cannot complete a login or a link.
  configVersion: integer('config_version').notNull().default(1),

  // SR2-10: the admin who LAST SET defaultRoleId — the principal whose LIVE
  // permission ceiling the callback re-checks the delegated role against just
  // before JIT provisioning. Stamped by POST /providers and by every PATCH that
  // sets defaultRoleId, so "re-save the default role" is a first-class repair
  // when the previous configurer is offboarded. NOT createdBy: that names the
  // original creator (who may never have touched defaultRoleId), and no route
  // ever rewrites it.
  defaultRoleConfiguredBy: uuid('default_role_configured_by').references(() => users.id),
```

In `ssoSessions` (`:92-110`), add immediately after `linkUserId` (`:106`), before `expiresAt`:

```ts
  // SR2-11 pending-transaction binding.
  //
  // providerVersion: sso_providers.config_version at creation. NULL only for
  // rows written before this column existed — the callback REJECTS those.
  providerVersion: integer('provider_version'),

  // The three initiating_* columns are LINK-MODE ONLY (set by
  // POST /sso/link/start alongside linkUserId). A login session has no
  // initiating user, so they stay NULL there — which is why they are nullable.
  // The link callback requires all three to be present AND to still match live
  // state, which is what makes logout / password reset / MFA reset / suspension
  // / global revocation invalidate a pending link.
  initiatingAuthEpoch: integer('initiating_auth_epoch'),
  initiatingMfaEpoch: integer('initiating_mfa_epoch'),
  // = refresh_token_families.family_id == the initiating access token's `sid`.
  initiatingSessionId: uuid('initiating_session_id'),
```

- [ ] **Step 5: Implement — BOTH authenticated bare-`db` writes to `sso_sessions` must use system context**

`sso_sessions` now has FORCED RLS with a system-only policy. There are **two** authenticated routes writing it on the bare pool today, and both break.

**5a — `POST /sso/link/start` (INSERT).** The bare-`db` insert at `routes/sso.ts:1098-1106` would raise `new row violates row-level security policy` from the caller's org/partner-scoped request context. Wrap it. Replace:

```ts
    await db.insert(ssoSessions).values({
      providerId: provider.id,
      state,
      nonce,
      codeVerifier: pkce.codeVerifier,
      redirectUrl: '/settings/profile',
      linkUserId: auth.user.id,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });
```

with:

```ts
    // sso_sessions is system-scope-only under RLS (2026-07-16 migration): this
    // insert ran on the bare pool and only worked because the table had no
    // policies. The row is a pre-auth transaction record, not tenant data — it
    // is consumed by the unauthenticated callback, which also runs in system
    // context. runOutsideDbContext first: we are inside the authenticated
    // request's org/partner-scoped context here.
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () =>
        db.insert(ssoSessions).values({
          providerId: provider.id,
          state,
          nonce,
          codeVerifier: pkce.codeVerifier,
          redirectUrl: '/settings/profile',
          linkUserId: auth.user.id,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000)
        })
      )
    );
```

**5b — `DELETE /providers/:id` (the cleanup DELETEs).** This is the sharper regression. `routes/sso.ts:690-691`:

```ts
  // Delete related records first
  await db.delete(ssoSessions).where(eq(ssoSessions.providerId, providerId));
  await db.delete(userSsoIdentities).where(eq(userSsoIdentities.providerId, providerId));
```

Under the new policy the first DELETE matches **0 rows silently** from the admin's tenant-scoped context. The FK `sso_sessions_provider_id_sso_providers_id_fk` (`0001-baseline.sql:14888`) has **no `ON DELETE CASCADE`**, so the `db.delete(ssoProviders)` three lines later then raises FK violation **23503 → 500** — meaning *provider deletion fails outright whenever a pending session exists*, i.e. within 10 minutes of any login attempt.

`user_sso_identities` is `USER_ID_SCOPED` under RLS (`breeze_current_user_id()`, registered at `rls-coverage.integration.test.ts:420`), so the second DELETE plausibly already 0-rows for **other users'** identities today — same FK-violation hazard, pre-existing. **Do not assume either way**: Task 8 adds a real-DB assertion that proves provider deletion succeeds with (a) a pending session and (b) another user's linked identity present. Wrap both now; the Task 8 assertion is what confirms it.

Replace those two lines with:

```ts
  // sso_sessions is system-scope-only and user_sso_identities is user-id-scoped
  // (breeze_current_user_id()) under RLS. On the bare pool, from an admin's
  // tenant-scoped context, BOTH of these silently delete 0 rows — and neither FK
  // cascades, so the sso_providers delete below then dies with FK violation
  // 23503. Provider cleanup is a legitimate system operation: run it as one.
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await db.delete(ssoSessions).where(eq(ssoSessions.providerId, providerId));
      await db.delete(userSsoIdentities).where(eq(userSsoIdentities.providerId, providerId));
    })
  );
```

(Authorization is unchanged: `canWriteProviderRow(auth, existing)` at `:685-687` already gated this route. The system context is scoped to the cleanup writes only — it does not widen who may call the route.)

Extend the `../db` import on `routes/sso.ts:7`:

```ts
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
```

(`vi.mock('../db')` in `routes/sso.test.ts:69-98` already stubs `runOutsideDbContext` as a pass-through, so no test-mock change is needed here.)

**Unit test (add to `routes/sso.test.ts`):** `DELETE /providers/:id` returns 200 and issues all three deletes (`ssoSessions`, `userSsoIdentities`, `ssoProviders`) — prime the mocked `db.delete()` chains and assert `db.delete` was called three times and the final `.returning()` resolved a row. This is the regression guard for the FK-violation path.

- [ ] **Step 6: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:check-drift
cd apps/api && pnpm vitest run src/routes/sso.test.ts
```
Expected: RLS contract PASS (incl. the two new tests); **no drift**; `sso.test.ts` still green (link-start unchanged externally).

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-07-16-sso-session-binding-and-provider-version.sql apps/api/src/db/schema/sso.ts apps/api/src/routes/sso.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(sso): provider config_version + session binding columns + sso_sessions RLS (SR2-11)"
```

---

### Task 2: Extract the canonical assignable-role validator (pure refactor)

**Files:**
- Create: `apps/api/src/services/roleAssignment.ts`
- Create: `apps/api/src/services/roleAssignment.test.ts`
- Modify: `apps/api/src/routes/users.ts:125-259` (delete the private helpers) + `:1123-1130` + `:1658-1665` (call sites) + imports (`:1-30`)
- Test: `apps/api/src/routes/users.test.ts` (**must stay green with zero edits** — that is this task's acceptance criterion)

**Interfaces:**
- Consumes: `db` (`../db`); `roles`, `permissions`, `rolePermissions` (`../db/schema`); `getUserPermissions`, `hasPermission`, `isAssignablePermission`, `type UserPermissions` (`./permissions`); `HTTPException` (`hono/http-exception`).
- Produces:
  ```ts
  export type ScopeContext =
    | { scope: 'partner'; partnerId: string }
    | { scope: 'organization'; orgId: string };

  export interface AuthLike {
    user: { id: string };
    scope: string;   // REQUIRED — validateProviderDefaultRole (Task 3) branches on `auth.scope === 'system'`; an optional field would silently read `undefined` on a malformed auth object and fall through to the ceiling path.
    partnerId: string | null;
    orgId: string | null;
  }

  export interface AssignableRoleRow {
    id: string;
    scope: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    parentRoleId: string | null;
    partnerId: string | null;
    orgId: string | null;
  }

  export function getScopeContext(auth: { scope: string; partnerId: string | null; orgId: string | null }): ScopeContext; // throws HTTPException(403)
  export function getScopedRole(roleId: string, scopeContext: ScopeContext): Promise<AssignableRoleRow | null>;
  export function getEffectiveRolePermissions(roleId: string, visited?: Set<string>): Promise<Array<{ resource: string; action: string }>>;
  export function getCallerPermissions(c: any, auth: AuthLike): Promise<UserPermissions | null>;

  /** Structural-only checks: custom roles may not carry wildcard perms; every perm must be known. Caller-independent. */
  export function checkRoleStructure(role: Pick<AssignableRoleRow, 'id' | 'isSystem'>): Promise<string | null>;

  /** Full ceiling check against an already-resolved permission set. Returns an error message, or null when assignable. */
  export function checkRolePermissionCeiling(
    callerPermissions: UserPermissions | null,
    role: Pick<AssignableRoleRow, 'id' | 'isSystem'>,
  ): Promise<string | null>;

  /** The behavior-preserving façade `routes/users.ts` keeps calling. */
  export function validateAssignableRole(
    c: any,
    auth: AuthLike,
    role: Pick<AssignableRoleRow, 'id' | 'isSystem'>,
  ): Promise<string | null>;
  ```

**Decisions:**
- **Zero behavior change — including side-effect ORDER.** Every returned message string is byte-identical to today's (`routes/users.test.ts` asserts on them). The split exists only so the SSO callback (Task 3), which has no HTTP caller, can reach the ceiling logic with a permission set it resolved itself. **Critically, the original (`routes/users.ts:228-236`) resolves the ROLE's effective permissions first and early-returns `null` on an empty set, and only THEN calls `getCallerPermissions`.** A naive façade (`getCallerPermissions(…)` then `checkRolePermissionCeiling(…)`) would invert that: a permission-less role would now trigger a `getUserPermissions` resolution that previously never ran — and on the SSO/system-scope path that can open a *fresh system transaction* (`services/permissions.ts:135`, `runOutsideDbContext(() => withSystemDbAccessContext(…))`). So `validateAssignableRole` **must short-circuit on the empty effective-permission set BEFORE resolving the caller** (see the implementation below).
- **`checkRoleStructure` is new but not new logic** — it is the subset of `checkRolePermissionCeiling` that does not consult the caller (wildcard-on-custom-role, unknown-permission). Task 3's JIT re-validation falls back to it when the provider's configuring admin is unknowable.
- **Bare `db`, no context wrapper.** Identical to today: `users.ts` calls run inside the authenticated request's RLS context. Callers that are *not* in a request context (the SSO callback) must wrap the call themselves in `withSystemDbAccessContext` — Task 3 does.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/roleAssignment.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Row queues consumed in the exact order the service issues its selects.
const roleRowQueue: unknown[][] = [];
const permRowQueue: Array<Array<{ resource: string; action: string }>> = [];

vi.mock('../db', () => {
  const selectChain = (queue: unknown[][]) => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }),
      innerJoin: () => ({ where: () => Promise.resolve(queue.shift() ?? []) }),
    }),
  });
  return {
    db: {
      select: (fields?: Record<string, unknown>) => {
        // The permissions join selects { resource, action }; everything else is a role row.
        const isPermSelect = !!fields && 'resource' in fields && 'action' in fields;
        return selectChain(isPermSelect ? (permRowQueue as unknown[][]) : roleRowQueue);
      },
    },
  };
});

const callerPerms = { permissions: [] as Array<{ resource: string; action: string }> };
vi.mock('./permissions', () => ({
  getUserPermissions: vi.fn(async () => callerPerms),
  hasPermission: vi.fn((perms: typeof callerPerms, resource: string, action: string) =>
    perms.permissions.some(
      (p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
    ),
  ),
  isAssignablePermission: vi.fn((p: { resource: string }) => p.resource !== 'unknown'),
  PERMISSIONS: {},
}));

import {
  getScopeContext,
  checkRoleStructure,
  checkRolePermissionCeiling,
  validateAssignableRole,
} from './roleAssignment';

beforeEach(() => {
  roleRowQueue.length = 0;
  permRowQueue.length = 0;
  callerPerms.permissions = [];
});

describe('getScopeContext', () => {
  it('returns partner context for a partner-scope auth', () => {
    expect(getScopeContext({ scope: 'partner', partnerId: 'p1', orgId: null })).toEqual({ scope: 'partner', partnerId: 'p1' });
  });
  it('returns organization context for an org-scope auth', () => {
    expect(getScopeContext({ scope: 'organization', partnerId: null, orgId: 'o1' })).toEqual({ scope: 'organization', orgId: 'o1' });
  });
  it('throws 403 for system scope (no tenant axis)', () => {
    expect(() => getScopeContext({ scope: 'system', partnerId: null, orgId: null })).toThrow();
  });
});

describe('checkRolePermissionCeiling', () => {
  it('allows a role whose permissions are a subset of the caller permissions', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'devices', action: 'read' }]);
    callerPerms.permissions = [{ resource: 'devices', action: 'read' }];
    expect(await checkRolePermissionCeiling(callerPerms as never, { id: 'r1', isSystem: false })).toBeNull();
  });

  it('rejects a role with a permission the caller does not hold', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'users', action: 'write' }]);
    callerPerms.permissions = [{ resource: 'devices', action: 'read' }];
    expect(await checkRolePermissionCeiling(callerPerms as never, { id: 'r1', isSystem: false }))
      .toBe('Cannot assign a role with permission not held by caller: users:write');
  });

  it('rejects a CUSTOM role carrying a wildcard permission', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: '*', action: '*' }]);
    callerPerms.permissions = [{ resource: '*', action: '*' }];
    expect(await checkRolePermissionCeiling(callerPerms as never, { id: 'r1', isSystem: false }))
      .toBe('Custom roles with wildcard permissions cannot be assigned');
  });

  it('rejects an unknown permission', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'unknown', action: 'read' }]);
    callerPerms.permissions = [{ resource: 'unknown', action: 'read' }];
    expect(await checkRolePermissionCeiling(callerPerms as never, { id: 'r1', isSystem: false }))
      .toBe('Role contains unknown permission: unknown:read');
  });

  it('returns "No permissions found" when the caller has none', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'devices', action: 'read' }]);
    expect(await checkRolePermissionCeiling(null, { id: 'r1', isSystem: false })).toBe('No permissions found');
  });

  it('allows a role with zero effective permissions regardless of caller', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([]);
    expect(await checkRolePermissionCeiling(null, { id: 'r1', isSystem: false })).toBeNull();
  });
});

describe('checkRoleStructure', () => {
  it('rejects wildcard on a custom role without consulting any caller', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: '*', action: '*' }]);
    expect(await checkRoleStructure({ id: 'r1', isSystem: false }))
      .toBe('Custom roles with wildcard permissions cannot be assigned');
  });

  it('allows a wildcard on a SYSTEM role', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: '*', action: '*' }]);
    expect(await checkRoleStructure({ id: 'r1', isSystem: true })).toBeNull();
  });

  it('rejects an unknown permission', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'unknown', action: 'read' }]);
    expect(await checkRoleStructure({ id: 'r1', isSystem: false }))
      .toBe('Role contains unknown permission: unknown:read');
  });
});

describe('validateAssignableRole', () => {
  it('resolves the caller permissions from the Hono context when present', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([{ resource: 'devices', action: 'read' }]);
    const ctxPerms = { permissions: [{ resource: 'devices', action: 'read' }] };
    const c = { get: (k: string) => (k === 'permissions' ? ctxPerms : undefined) };
    expect(await validateAssignableRole(c, { user: { id: 'u1' }, scope: 'partner', partnerId: 'p1', orgId: null }, { id: 'r1', isSystem: false }))
      .toBeNull();
  });

  // I7: order is load-bearing — a permission-less role must NOT trigger a
  // getUserPermissions resolution (which on the system-scope path opens a fresh
  // system transaction, permissions.ts:135). The original short-circuited first.
  it('does NOT resolve caller permissions for a role with zero effective permissions', async () => {
    roleRowQueue.push([{ parentRoleId: null }]);
    permRowQueue.push([]); // no effective permissions
    const c = { get: () => undefined };
    expect(await validateAssignableRole(c, { user: { id: 'u1' }, scope: 'partner', partnerId: 'p1', orgId: null }, { id: 'r1', isSystem: false }))
      .toBeNull();
    expect(getUserPermissions).not.toHaveBeenCalled();
  });
});
```

(Import `getUserPermissions` in the test file — `import { getUserPermissions } from './permissions';` — so the `not.toHaveBeenCalled()` assertion binds to the mocked fn.)

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/roleAssignment.test.ts
```
Expected: **FAIL** — cannot find module `./roleAssignment`.

- [ ] **Step 3: Implement — create the service**

Create `apps/api/src/services/roleAssignment.ts`:

```ts
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { roles, permissions, rolePermissions } from '../db/schema';
import {
  getUserPermissions,
  hasPermission,
  isAssignablePermission,
  type UserPermissions,
} from './permissions';

/**
 * Canonical assignable-role validation. Lifted VERBATIM out of routes/users.ts
 * (where it was module-private) so SSO default-role configuration and JIT
 * provisioning enforce the SAME permission-subset ceiling as ordinary user
 * administration (SR2-10). Do not fork a second copy: routes/users.ts and
 * routes/sso.ts both consume this module.
 *
 * Every returned message string is byte-identical to the pre-extraction
 * behavior — routes/users.test.ts asserts on them.
 *
 * DB CONTEXT: these functions use the ambient `db`. routes/users.ts calls them
 * inside the authenticated request's RLS context (correct). A caller with NO
 * request context — the unauthenticated /sso/callback — must wrap the call in
 * withSystemDbAccessContext itself.
 */

export type ScopeContext =
  | { scope: 'partner'; partnerId: string }
  | { scope: 'organization'; orgId: string };

export interface AuthLike {
  user: { id: string };
  scope?: string;
  partnerId: string | null;
  orgId: string | null;
}

export interface AssignableRoleRow {
  id: string;
  scope: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  parentRoleId: string | null;
  partnerId: string | null;
  orgId: string | null;
}

export function getScopeContext(auth: { scope: string; partnerId: string | null; orgId: string | null }): ScopeContext {
  if (auth.scope === 'partner' && auth.partnerId) {
    return { scope: 'partner', partnerId: auth.partnerId };
  }

  if (auth.scope === 'organization' && auth.orgId) {
    return { scope: 'organization', orgId: auth.orgId };
  }

  throw new HTTPException(403, { message: 'Partner or organization context required' });
}

export async function getScopedRole(roleId: string, scopeContext: ScopeContext): Promise<AssignableRoleRow | null> {
  const [role] = await db
    .select({
      id: roles.id,
      scope: roles.scope,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
      parentRoleId: roles.parentRoleId,
      partnerId: roles.partnerId,
      orgId: roles.orgId
    })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);

  if (!role || role.scope !== scopeContext.scope) {
    return null;
  }

  if (role.isSystem) {
    return role as AssignableRoleRow;
  }

  if (scopeContext.scope === 'partner' && role.partnerId === scopeContext.partnerId) {
    return role as AssignableRoleRow;
  }

  if (scopeContext.scope === 'organization' && role.orgId === scopeContext.orgId) {
    return role as AssignableRoleRow;
  }

  return null;
}

export async function getEffectiveRolePermissions(
  roleId: string,
  visited: Set<string> = new Set()
): Promise<Array<{ resource: string; action: string }>> {
  if (visited.has(roleId)) return [];
  visited.add(roleId);

  const [role] = await db
    .select({ parentRoleId: roles.parentRoleId })
    .from(roles)
    .where(eq(roles.id, roleId))
    .limit(1);

  const directPermissions = await db
    .select({
      resource: permissions.resource,
      action: permissions.action
    })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));

  if (!role?.parentRoleId) {
    return directPermissions;
  }

  const inheritedPermissions = await getEffectiveRolePermissions(role.parentRoleId, visited);
  const result = new Map<string, { resource: string; action: string }>();
  for (const permission of [...directPermissions, ...inheritedPermissions]) {
    result.set(`${permission.resource}:${permission.action}`, permission);
  }
  return [...result.values()];
}

export async function getCallerPermissions(
  c: any,
  auth: AuthLike
): Promise<UserPermissions | null> {
  const existing = c?.get?.('permissions') as UserPermissions | undefined;
  if (existing) return existing;

  return getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined
  });
}

/**
 * Caller-INDEPENDENT structural checks: a custom role may not carry wildcard
 * permissions, and every permission must be a known one. This is the subset of
 * the ceiling check that can still be applied when no caller identity is
 * available (SSO JIT against a provider with no resolvable configurer).
 */
export async function checkRoleStructure(
  role: Pick<AssignableRoleRow, 'id' | 'isSystem'>
): Promise<string | null> {
  const rolePermissionsForAssignment = await getEffectiveRolePermissions(role.id);
  if (rolePermissionsForAssignment.length === 0) {
    return null;
  }

  for (const permission of rolePermissionsForAssignment) {
    if (permission.resource === '*' || permission.action === '*') {
      if (!role.isSystem) {
        return 'Custom roles with wildcard permissions cannot be assigned';
      }
      continue;
    }
    if (!isAssignablePermission(permission)) {
      return `Role contains unknown permission: ${permission.resource}:${permission.action}`;
    }
  }

  return null;
}

/**
 * Full ceiling check against an ALREADY-RESOLVED caller permission set. Returns
 * an error message string, or null when the role is assignable.
 */
export async function checkRolePermissionCeiling(
  callerPermissions: UserPermissions | null,
  role: Pick<AssignableRoleRow, 'id' | 'isSystem'>
): Promise<string | null> {
  const rolePermissionsForAssignment = await getEffectiveRolePermissions(role.id);
  if (rolePermissionsForAssignment.length === 0) {
    return null;
  }

  if (!callerPermissions) {
    return 'No permissions found';
  }

  for (const permission of rolePermissionsForAssignment) {
    if (permission.resource === '*' || permission.action === '*') {
      if (!role.isSystem) {
        return 'Custom roles with wildcard permissions cannot be assigned';
      }
      if (!hasPermission(callerPermissions, permission.resource, permission.action)) {
        return 'Cannot assign a role broader than caller permissions';
      }
      continue;
    }

    if (!isAssignablePermission(permission)) {
      return `Role contains unknown permission: ${permission.resource}:${permission.action}`;
    }

    if (!hasPermission(callerPermissions, permission.resource, permission.action)) {
      return `Cannot assign a role with permission not held by caller: ${permission.resource}:${permission.action}`;
    }
  }

  return null;
}

/**
 * Behavior-preserving façade retained for routes/users.ts.
 *
 * ORDER IS LOAD-BEARING. The original resolved the ROLE's effective permissions
 * first and early-returned null on an empty set, only THEN touching
 * getCallerPermissions. Calling getCallerPermissions unconditionally would make
 * a permission-less role trigger a getUserPermissions resolution that never ran
 * before — which on the system-scope path opens a fresh system transaction
 * (services/permissions.ts:135). So: short-circuit FIRST, resolve the caller
 * SECOND.
 */
export async function validateAssignableRole(
  c: any,
  auth: AuthLike,
  role: Pick<AssignableRoleRow, 'id' | 'isSystem'>
): Promise<string | null> {
  const rolePermissionsForAssignment = await getEffectiveRolePermissions(role.id);
  if (rolePermissionsForAssignment.length === 0) {
    return null; // no caller resolution — matches the original's side effects exactly
  }
  const callerPermissions = await getCallerPermissions(c, auth);
  return checkRolePermissionCeiling(callerPermissions, role);
}
```

> `checkRolePermissionCeiling` re-resolves the effective permissions itself (it is also called directly by Task 3 with a pre-resolved permission set). That is one extra recursive role walk on the `users.ts` path versus today — acceptable, and strictly cheaper than the alternative (an inverted side-effect order that opens a system transaction). If a reviewer objects to the double walk, thread the resolved array in as an optional 3rd arg; do **not** "fix" it by reordering.
>
> Also preserve the order *inside* `checkRolePermissionCeiling`: empty-set short-circuit BEFORE the `!callerPermissions` → `'No permissions found'` check. Inverting that changes the return value for permission-less roles and will red `users.test.ts`.

- [ ] **Step 4: Implement — rewire `routes/users.ts`**

In `apps/api/src/routes/users.ts`:

1. **Delete** `type ScopeContext` (`:125-127`), `getScopeContext` (`:129-139`), `getScopedRole` (`:141-174`), `getEffectiveRolePermissions` (`:176-208`), `getCallerPermissions` (`:210-221`), and `validateAssignableRole` (`:223-259`).
2. Add the import next to the other `../services/*` imports:
   ```ts
   import {
     getScopeContext,
     getScopedRole,
     validateAssignableRole,
     type ScopeContext,
   } from '../services/roleAssignment';
   ```
3. Leave both call sites (`:1123-1130` user invite, `:1658-1665` role assignment) **completely untouched** — the imported names and signatures are identical.
4. Run `grep -n "permissions\|rolePermissions\|isAssignablePermission\|hasPermission\|HTTPException" apps/api/src/routes/users.ts` and prune any import that is now unused (`isAssignablePermission` and the `permissions`/`rolePermissions` schema tables are the likely orphans; `hasPermission`, `HTTPException` and `getUserPermissions` may still be used elsewhere in the file — **check, do not assume**). `pnpm typecheck` (Step 5) is the authority: `noUnusedLocals` will flag them if they are dead.

- [ ] **Step 5: Run to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/roleAssignment.test.ts src/routes/users.test.ts && pnpm typecheck
```
Expected: **PASS**, with `users.test.ts` green **without a single edit to it**. If `users.test.ts` needed edits, the refactor was not behavior-preserving — revert and re-do.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/roleAssignment.ts apps/api/src/services/roleAssignment.test.ts apps/api/src/routes/users.ts
git commit -m "refactor(auth): extract canonical assignable-role validator into services/roleAssignment (SR2-10 prep)"
```

---

### Task 3: SR2-10 — SSO role delegation on both axes + JIT re-validation

**Files:**
- Modify: `apps/api/src/routes/sso.ts` — POST `/providers` (`:471-585`, partner branch `:484-512`, org branch `:505-511`), PATCH `/providers/:id` (`:586-660`, role block `:615-628`), callback default-role block (`:1440-1469`), JIT block (`:1716-1778`)
- Test: `apps/api/src/routes/sso.test.ts`

**Interfaces:**
- Consumes (Task 2): `getScopedRole`, `validateAssignableRole`, `checkRoleStructure`, `checkRolePermissionCeiling`, `type ScopeContext`, `type AssignableRoleRow` from `'../services/roleAssignment'`; `getUserPermissions` from `'../services/permissions'` (already imported? — `sso.ts:41` imports `PERMISSIONS` from there; extend that import).
- Produces (used only inside `sso.ts`):
  ```ts
  /** Resolve the ScopeContext for a provider's OWN axis (never the caller's). */
  function providerScopeContext(p: { orgId: string | null; partnerId: string | null }): ScopeContext | null;

  /**
   * Re-validate a provider's defaultRoleId immediately before JIT provisioning.
   * Runs inside withSystemDbAccessContext (the callback has no request context).
   */
  async function revalidateSsoDefaultRole(params: {
    roleId: string;
    scopeContext: ScopeContext;
    configuredByUserId: string | null;
  }): Promise<{ ok: true; roleId: string } | { ok: false; reason: string }>;
  ```

**Decisions (documented here — reviewer should challenge the third):**
- **Config-time validation runs on BOTH axes.** Today the partner axis checks existence + scope + tenant (`sso.ts:484-512`, `:615-628`) and **the org axis — the only axis that does JIT — checks nothing at all**; `defaultRoleId` flows straight into the INSERT (`:560`) and the `...body` UPDATE (`:630-643`). Both axes now go through `getScopedRole` (existence + scope + tenant, same guarantees as before on the partner axis) **plus** `validateAssignableRole` (permission-subset vs the configuring admin, wildcard-on-custom rejection, unknown-permission rejection).
- **The ScopeContext comes from the PROVIDER's axis, never `getScopeContext(auth)`.** These routes admit `requireScope('organization', 'partner', 'system')`, and `getScopeContext` throws 403 for `system`. Using the provider's own axis is also simply more correct: the role must belong to the tenant the provider provisions into.
- **System-scope callers skip the permission-subset ceiling, but still get `checkRoleStructure`.** A platform admin has no `orgId`/`partnerId`, so `getUserPermissions(userId, {})` cannot resolve a meaningful tenant permission set — running the ceiling check would spuriously reject with `'No permissions found'`. A platform admin is by definition above every tenant ceiling. They still cannot attach a custom wildcard role or a role with unknown permissions.
- **JIT re-validation ceiling = `sso_providers.default_role_configured_by` (Task 1's new column), resolved LIVE, falling back to `created_by`, then to structural-only.** The design says validation runs "again immediately before JIT provisioning", but the callback has no caller — so the ceiling that must still hold is the *configurer's*: an SSO default role may not outlive the authority of the admin who configured it (the same principle SR2-15 applies to API keys). **`created_by` alone is the wrong principal** — see Task 1's decisions: it names the original creator while config-time validates the current caller (so Admin B could save a role Admin A cannot support → the provider saves but fails JIT forever, silently), and no route rewrites it (so an offboarded creator bricks the provider, which cannot be recreated without orphaning every `user_sso_identities` row). `default_role_configured_by` is stamped by **every write that sets `defaultRoleId`** (POST + PATCH, Step 3 below), which both collapses the principal mismatch and makes "re-save the default role as a current admin" the repair.
- **Resolve the configurer's permissions on BOTH axes, not one.** `getUserPermissions(userId, { orgId })` runs only `resolveOrgAxis` (`services/permissions.ts:187-193`), which requires an `organization_users` row. **An MSP partner admin configuring SSO for a customer org has no such row** — they act through `partner_users` + `orgAccess`, and `POST /providers` explicitly admits partner scope. Passing only `{ orgId }` would return `null` → ceiling check → `default_role_exceeds_configurer_permissions` → **every JIT sign-in on that provider fails, forever**, on the most normal MSP topology there is. (This is invisible at config time, which uses `getCallerPermissions` → `c.get('permissions')` — the already-resolved partner set.) So the JIT path passes **`{ orgId: provider.orgId, partnerId: <organizations.partnerId for that org> }`** — one extra select in system context — and lets `getUserPermissions`'s own org→partner fall-through (`permissions.ts:187-193`) do the work. Task 8 carries the integration proof (a provider created by a partner admin with **no** org membership must JIT successfully).
- **Both `default_role_configured_by` AND `created_by` NULL (legacy/seeded rows) → structural-only re-validation, not a hard fail.** Hard-failing would break JIT for every pre-API provider row on upgrade, for zero attacker-relevant gain (the role still must be scope-correct, tenant-correct, non-wildcard, and known-permission). **This is the one path where the permission ceiling is NOT applied, so it is LOUDLY AUDITED** — a real `writeRouteAudit` event (`action: 'sso.callback.jit_ceiling_skipped'`), not a `console.warn`. The repair is a one-click re-save of the default role, which stamps `default_role_configured_by`. Reviewer: challenge this if you prefer the hard fail.
- **Rejection surface:** config time → `400 { error: <the validator's message> }` (identical style to today's `defaultRoleId must be a partner-scoped role…`). JIT time → the existing `/login?error=invalid_provider_configuration` redirect, plus a specific audit reason.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/routes/sso.test.ts`, first extend the mock surface (this is a prerequisite for the tests to even import):

```ts
// NEW — services/roleAssignment.ts is a distinct module path; vi.mock('../services')
// does NOT cover it.
const { roleAssignmentGate } = vi.hoisted(() => ({
  roleAssignmentGate: {
    scopedRole: null as { id: string; isSystem: boolean; scope: string; orgId: string | null; partnerId: string | null } | null,
    assignError: null as string | null,
    structureError: null as string | null,
    ceilingError: null as string | null,
  },
}));

vi.mock('../services/roleAssignment', () => ({
  getScopedRole: vi.fn(async () => roleAssignmentGate.scopedRole),
  validateAssignableRole: vi.fn(async () => roleAssignmentGate.assignError),
  checkRoleStructure: vi.fn(async () => roleAssignmentGate.structureError),
  checkRolePermissionCeiling: vi.fn(async () => roleAssignmentGate.ceilingError),
}));
```

Reset it in `beforeEach` (`:255-308`):

```ts
  roleAssignmentGate.scopedRole = { id: 'role-1', isSystem: false, scope: 'organization', orgId: '00000000-0000-4000-8000-000000000010', partnerId: null };
  roleAssignmentGate.assignError = null;
  roleAssignmentGate.structureError = null;
  roleAssignmentGate.ceilingError = null;
```

Then add a `describe('SSO default-role delegation (SR2-10)', …)` with:

1. **`POST /providers` (org axis) rejects a defaultRoleId above the caller's ceiling** — set `roleAssignmentGate.assignError = 'Cannot assign a role with permission not held by caller: users:write'`; POST a provider with `ownerScope:'organization'` + `defaultRoleId`; expect **400** with that exact message (400, not 403 — it matches the existing `defaultRoleId must be a partner-scoped role…` rejection style on this route and Step 3's implementation), and assert `db.insert` was **never** called.
2. **`POST /providers` (org axis) rejects an unknown `defaultRoleId`** — `roleAssignmentGate.scopedRole = null` → expect 400 `defaultRoleId must be an organization-scoped role belonging to this organization`.
3. **`POST /providers` (org axis) accepts an in-ceiling role** — gate returns a role and `assignError = null` → 201.
4. **`PATCH /providers/:id` (org axis) rejects an out-of-ceiling defaultRoleId** — same shape; assert `db.update` never called.
5. **Callback JIT re-validates** — prime a callback for a new (unlinked, unknown-email) org-axis user with `autoProvision:true` and a `defaultRoleId`; set `roleAssignmentGate.ceilingError = 'Cannot assign a role broader than caller permissions'` → expect a redirect to `/login?error=invalid_provider_configuration` and assert **no `users` insert** happened.
6. **`POST` / `PATCH` stamp `defaultRoleConfiguredBy`** — capture the `db.insert().values()` payload from a `POST /providers` carrying a `defaultRoleId` and assert `defaultRoleConfiguredBy === auth.user.id`; capture the `db.update().set()` payload from a `PATCH` carrying a `defaultRoleId` and assert the same. Also assert a `PATCH` **without** `defaultRoleId` does **not** include the key (it must not be clobbered to null by an unrelated edit).
7. **Unknown configurer → JIT proceeds but emits the ceiling-skipped audit** — provider row with `defaultRoleConfiguredBy: null` and `createdBy: null`, `structureError = null` → the user IS provisioned, and `writeRouteAudit` was called with `action: 'sso.callback.jit_ceiling_skipped'`. (Mock/spy `writeRouteAudit` via `vi.mock('../services/auditEvents')` if the suite does not already; check first — `sso.ts:36` imports it.)

**Two more mock prerequisites:**
- `revalidateSsoDefaultRole` calls `getUserPermissions` (`../services/permissions`), which `sso.ts` does not currently import. Extend the existing `import { PERMISSIONS } from '../services/permissions'` (`sso.ts:41`) rather than adding a second import line, and **mock the module in the test while KEEPING `PERMISSIONS` real** (the route's `requirePermission(PERMISSIONS.SSO_ADMIN.resource, …)` guard reads it at module scope):
  ```ts
  vi.mock('../services/permissions', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/permissions')>()),
    getUserPermissions: vi.fn(async () => ({ permissions: [{ resource: '*', action: '*' }] })),
  }));
  ```
- **`db.select()` QUEUE SHIFT (org-axis JIT only):** `revalidateSsoDefaultRole` issues **one extra `db.select`** (the `organizations.partnerId` lookup) — but *only* when a configurer resolves, and it lives inside the function, which the tests above mock wholesale. So with `vi.mock('../services/roleAssignment')` in place, the callback queues are **unchanged**. The moment an implementer un-mocks it (don't), the queues shift. POST/PATCH queues are likewise unchanged because the mocked `getScopedRole` never touches `db`. **Verify by running the whole file, not just `-t`.**

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/sso.test.ts -t 'SR2-10'
```
Expected: **FAIL** — the org axis validates nothing (the provider is created with an arbitrary `defaultRoleId`), and the callback's JIT applies `validatedDefaultRoleId` with no permission check.

- [ ] **Step 3: Implement — config-time validation on both axes**

In `apps/api/src/routes/sso.ts`, add the import (next to the `partnerWideAccess` import at `:38`):

```ts
import {
  getScopedRole,
  validateAssignableRole,
  checkRoleStructure,
  checkRolePermissionCeiling,
  type ScopeContext,
} from '../services/roleAssignment';
import { getUserPermissions } from '../services/permissions'; // extend the existing `PERMISSIONS` import on :41 instead of adding a second line
```

Add these two helpers near `getOIDCConfig` (after `buildSsoCallbackUri`, ~`:288`):

```ts
/**
 * The ScopeContext a provider's defaultRoleId must satisfy — the PROVIDER's own
 * axis, never the caller's. These routes admit system scope, for which
 * getScopeContext(auth) throws; and the role must belong to the tenant the
 * provider provisions into, which is the provider's axis by definition.
 */
function providerScopeContext(p: { orgId: string | null; partnerId: string | null }): ScopeContext | null {
  if (p.partnerId) return { scope: 'partner', partnerId: p.partnerId };
  if (p.orgId) return { scope: 'organization', orgId: p.orgId };
  return null;
}

/**
 * SR2-10 config-time gate, shared by POST /providers and PATCH /providers/:id.
 * Returns an error message (caller returns 400) or null.
 *
 * Both axes go through the SAME canonical validator routes/users.ts uses. The
 * org axis validated NOTHING before this change — and it is the only axis that
 * JIT-provisions, so an org admin could delegate a role broader than their own
 * authority to every future SSO sign-in.
 *
 * A system-scope (platform-admin) caller skips the permission-subset ceiling:
 * they have no orgId/partnerId, so getUserPermissions cannot resolve a tenant
 * permission set, and a platform admin is above every tenant ceiling anyway.
 * They still cannot attach a custom wildcard role or an unknown permission.
 */
async function validateProviderDefaultRole(
  c: any,
  auth: AuthContext,
  defaultRoleId: string,
  scopeContext: ScopeContext,
): Promise<string | null> {
  const role = await getScopedRole(defaultRoleId, scopeContext);
  if (!role) {
    return scopeContext.scope === 'partner'
      ? 'defaultRoleId must be a partner-scoped role belonging to your partner'
      : 'defaultRoleId must be an organization-scoped role belonging to this organization';
  }
  if (auth.scope === 'system') {
    return checkRoleStructure(role);
  }
  return validateAssignableRole(c, auth, role);
}
```

**POST `/providers`** — in the partner branch (`:484-512`), **replace** the ad-hoc role select with:

```ts
    if (body.defaultRoleId) {
      const roleError = await validateProviderDefaultRole(
        c, auth, body.defaultRoleId, { scope: 'partner', partnerId: auth.partnerId },
      );
      if (roleError) {
        return c.json({ error: roleError }, 400);
      }
    }
```

In the org branch, immediately after `ownerColumns = { orgId: orgResult.orgId, partnerId: null };` (`:511`), **add** (this validation does not exist today):

```ts
    if (body.defaultRoleId) {
      const roleError = await validateProviderDefaultRole(
        c, auth, body.defaultRoleId, { scope: 'organization', orgId: orgResult.orgId },
      );
      if (roleError) {
        return c.json({ error: roleError }, 400);
      }
    }
```

**PATCH `/providers/:id`** — replace the partner-only role block (`:615-628`) with an axis-aware one. Note `existing` is selected with `{ id, orgId, partnerId }` (`:601-605`), which is everything `providerScopeContext` needs:

```ts
  if (body.defaultRoleId) {
    const scopeContext = providerScopeContext(existing);
    if (!scopeContext) {
      return c.json({ error: 'Provider has no owning organization or partner' }, 400);
    }
    const roleError = await validateProviderDefaultRole(c, auth, body.defaultRoleId, scopeContext);
    if (roleError) {
      return c.json({ error: roleError }, 400);
    }
  }
```

**Stamp the JIT principal on every write that sets `defaultRoleId`** (SR2-10, Task 1's `default_role_configured_by`). In **POST `/providers`**, add to the `.values({ … })` (`:552-568`):

```ts
      defaultRoleId: body.defaultRoleId,
      // The admin whose LIVE permission ceiling the callback re-checks this role
      // against before JIT. Stamped only when a role is actually delegated.
      defaultRoleConfiguredBy: body.defaultRoleId ? auth.user.id : null,
```

In **PATCH `/providers/:id`**, fold it into `updates` (which also gains `configVersion` in Task 4):

```ts
  const updates: Partial<typeof ssoProviders.$inferInsert> = {
    ...body,
    updatedAt: new Date(),
    // Re-stamp the JIT principal whenever the delegated role is (re-)set. This is
    // the repair path when the previous configurer offboards: re-saving the
    // default role as a current admin re-points the ceiling at a live account.
    ...(body.defaultRoleId ? { defaultRoleConfiguredBy: auth.user.id } : {}),
  };
```

> `updateProviderSchema` is `createProviderSchema.omit({ orgId: true, ownerScope: true }).partial()`, so `defaultRoleId` is already an accepted PATCH field — no schema change. `defaultRoleConfiguredBy` is **not** in either schema and must never be client-settable.

- [ ] **Step 4: Implement — JIT re-validation in the callback**

Add `revalidateSsoDefaultRole` next to the helpers above:

```ts
/**
 * SR2-10 JIT gate. Runs immediately before an SSO callback provisions a NEW
 * user with the provider's defaultRoleId. Re-checks (a) the role still exists on
 * the provider's axis, and (b) the role's effective permissions are still within
 * the LIVE permission ceiling of the admin who configured the delegation — an
 * SSO default role must not outlive its configurer's authority.
 *
 * PRINCIPAL: default_role_configured_by (stamped by every write that SETS
 * defaultRoleId), falling back to created_by for rows that predate that column,
 * then to STRUCTURAL-only re-validation when neither resolves.
 *
 * BOTH AXES are passed to getUserPermissions. Passing only { orgId } for an
 * org-axis provider would run only resolveOrgAxis (permissions.ts:187-193),
 * which needs an organization_users row — and an MSP PARTNER ADMIN configuring
 * SSO for a customer org has none (they act via partner_users + orgAccess). That
 * would return null -> ceiling failure -> every JIT sign-in on that provider
 * fails forever, on the most normal MSP topology. Supplying both lets
 * getUserPermissions' own org->partner fall-through resolve them correctly.
 *
 * `skippedCeiling` is returned (not swallowed) so the caller can emit a LOUD
 * audit: this is the one path where the permission ceiling is not applied.
 *
 * MUST be called inside withSystemDbAccessContext — /sso/callback has no request
 * context, so a bare read here silently returns 0 rows under RLS.
 */
async function revalidateSsoDefaultRole(params: {
  roleId: string;
  scopeContext: ScopeContext;
  configuredByUserId: string | null;
}): Promise<
  | { ok: true; roleId: string; skippedCeiling: boolean }
  | { ok: false; reason: string }
> {
  const role = await getScopedRole(params.roleId, params.scopeContext);
  if (!role) {
    return { ok: false, reason: 'default_role_not_on_provider_axis' };
  }

  if (!params.configuredByUserId) {
    const structureError = await checkRoleStructure(role);
    return structureError
      ? { ok: false, reason: 'default_role_structure_invalid' }
      : { ok: true, roleId: role.id, skippedCeiling: true };
  }

  // Resolve the tenant axes to hand getUserPermissions. For an ORG-axis provider
  // we also supply the org's owning partner, so a partner admin with no
  // organization_users row still resolves through the partner axis.
  let orgId: string | undefined;
  let partnerId: string | undefined;
  if (params.scopeContext.scope === 'organization') {
    orgId = params.scopeContext.orgId;
    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    partnerId = org?.partnerId ?? undefined;
  } else {
    partnerId = params.scopeContext.partnerId;
  }

  const configurerPermissions = await getUserPermissions(params.configuredByUserId, { orgId, partnerId });
  const ceilingError = await checkRolePermissionCeiling(configurerPermissions, role);
  return ceilingError
    ? { ok: false, reason: 'default_role_exceeds_configurer_permissions' }
    : { ok: true, roleId: role.id, skippedCeiling: false };
}
```

(`organizations` is already imported into `routes/sso.ts` at `:8-18`.)

In the callback's JIT block (`:1716-1778`), **immediately after** the `if (!validatedDefaultRoleId) { … default_role_required }` guard and **before** `const provisionOrgId = provider.orgId!;`, insert:

```ts
      // SR2-10: re-validate the delegated role against LIVE state at the moment
      // of provisioning — the config-time check ran when the provider was saved,
      // possibly months ago and by an admin who has since been demoted.
      const jitScope = providerScopeContext(provider);
      const jitRole = jitScope
        ? await withSystemDbAccessContext(() =>
            revalidateSsoDefaultRole({
              roleId: validatedDefaultRoleId!,
              scopeContext: jitScope,
              // The admin who last SET the delegated role; fall back to the
              // original creator for rows predating that column.
              configuredByUserId: provider.defaultRoleConfiguredBy ?? provider.createdBy ?? null,
            }),
          )
        : ({ ok: false, reason: 'provider_axis_missing' } as const);

      if (!jitRole.ok) {
        writeRouteAudit(c, {
          orgId: provider.orgId,
          action: 'sso.callback.rejected',
          resourceType: 'sso_provider',
          resourceId: provider.id,
          resourceName: provider.name,
          result: 'denied',
          details: { mode: 'login', phase: 'jit_default_role', reason: jitRole.reason, partnerId: provider.partnerId },
        });
        clearStateCookie();
        return c.redirect('/login?error=invalid_provider_configuration');
      }

      if (jitRole.skippedCeiling) {
        // The ONE path where the permission ceiling is not applied (no resolvable
        // configurer — a legacy row). It must be loudly auditable, not a
        // console.warn: this is a real, if bounded, delegation gap, and the
        // repair (re-save the default role as a current admin, which stamps
        // default_role_configured_by) is only discoverable if it is visible.
        writeRouteAudit(c, {
          orgId: provider.orgId,
          action: 'sso.callback.jit_ceiling_skipped',
          resourceType: 'sso_provider',
          resourceId: provider.id,
          resourceName: provider.name,
          result: 'success',
          details: {
            reason: 'default_role_configurer_unknown',
            providerId: provider.id,
            roleId: validatedDefaultRoleId,
            partnerId: provider.partnerId,
            remediation: 're-save defaultRoleId as a current admin',
          },
        });
      }
```

(The existing `validatedDefaultRoleId` from `:1440-1469` remains the value inserted into `organization_users` — `jitRole.roleId` is the same id; keep using `validatedDefaultRoleId` so the downstream insert is untouched.)

- [ ] **Step 5: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/sso.test.ts src/routes/users.test.ts
```
Expected: **PASS** (full file, not just `-t` — the mock-queue ordering must still hold for every pre-existing test).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts
git commit -m "feat(sso): permission-subset ceiling on defaultRoleId at config time (both axes) and at JIT (SR2-10)"
```

---

### Task 4: SR2-11a — provider config version + status/version gate in the callback

**Files:**
- Modify: `apps/api/src/routes/sso.ts` — PATCH `/providers/:id` (`:630-643`), POST `/providers/:id/status` (`:742-747`), the three session-create sites (`:1098-1106` link, `:1224-1233` partner login, `:1319-1328` org login), callback provider re-read (`:1416-1427`)
- Test: `apps/api/src/routes/sso.test.ts`

**Interfaces:**
- Consumes (Task 1): `ssoProviders.configVersion` (`number`), `ssoSessions.providerVersion` (`number | null`), `session.linkUserId` (`string | null`).
- Produces (used by Task 5 + Task 8):
  ```ts
  type SsoCallbackMode = 'login' | 'link';
  /** Provider must be usable for THIS mode, and the session's snapshot must still match. */
  function checkProviderGeneration(
    provider: typeof ssoProviders.$inferSelect,
    session: typeof ssoSessions.$inferSelect,
    mode: SsoCallbackMode,
  ): { ok: true } | { ok: false; reason: 'provider_inactive' | 'provider_not_usable' | 'provider_version_missing' | 'provider_version_mismatch' };
  ```

**Decisions:**
- **What bumps the version:** `PATCH /providers/:id` (any field) and `POST /providers/:id/status` (any status transition). Both bump by exactly `+1` in the same `UPDATE` that writes the change — so a config write and its generation bump can never diverge. `POST /providers` starts at the column default `1`. `DELETE` needs no bump (the provider row is gone; the callback's `provider_not_found` redirect already covers it). `POST /providers/:id/test` performs no write → no bump.
- **Status required at the callback, per mode.** Login-init requires `status='active'` (`:1294-1297`, `:1202-1205`); link-start requires `status !== 'inactive'` (`:1071`, so a `testing` provider may start a link). The callback mirrors **each mode's own init gate**: login mode requires `status === 'active'`; link mode requires `status !== 'inactive'`. Anything stricter would make a `testing` provider's link round-trip impossible to complete — a bug, not a hardening. Today **neither** is checked, so a provider disabled during the ≤10-min window still completes a full login or link.
- **Version mismatch is a hard reject in BOTH modes**, including `provider_version IS NULL` (pre-deploy rows — see Task 1). This is what makes "provider disablement/configuration changes … invalidate outstanding sessions" true rather than aspirational: even if an admin flips `inactive → active` again inside the window, the two status writes have bumped the version twice and every session minted before them is dead.
- **Public error codes** (login mode, `/login?error=…`): `sso_provider_inactive`, `sso_config_changed`. Link mode (`/settings/profile?ssoLinkError=…`): `provider_inactive`, `config_changed`. Distinguishable but stateless — no ids, no versions in the URL.
- **Audit:** `action: 'sso.callback.rejected'`, `result: 'denied'`, `details: { mode, phase: 'provider_generation', reason, providerId, expectedVersion, sessionVersion }`. Version integers are safe to record (they are not secrets). **No `state`, no `code`, no token material.**

- [ ] **Step 1: Write the failing tests**

In `routes/sso.test.ts`, extend the `vi.mock('../db/schema')` `ssoSessions` stub (`:100-156`, currently `ssoSessions: {}`):

```ts
  ssoSessions: {
    id: 'id',
    providerId: 'providerId',
    state: 'state',
    nonce: 'nonce',
    codeVerifier: 'codeVerifier',
    redirectUrl: 'redirectUrl',
    linkUserId: 'linkUserId',
    providerVersion: 'providerVersion',
    initiatingAuthEpoch: 'initiatingAuthEpoch',
    initiatingMfaEpoch: 'initiatingMfaEpoch',
    initiatingSessionId: 'initiatingSessionId',
    expiresAt: 'expiresAt',
    createdAt: 'createdAt',
  },
```

and add `configVersion: 'configVersion'`, `createdBy: 'createdBy'`, `defaultRoleId: 'defaultRoleId'`, and `defaultRoleConfiguredBy: 'defaultRoleConfiguredBy'` to the `ssoProviders` stub.

Add `describe('SSO provider generation gate (SR2-11)', …)`:

1. **Callback rejects a provider disabled mid-flow (login mode)** — prime the session claim to return `{ …, linkUserId: null, providerVersion: 3 }` and the provider re-read to return `{ …, status: 'inactive', configVersion: 3 }` → expect `302` to `/login?error=sso_provider_inactive`, and assert `createTokenPair` was **not** called.
2. **Callback rejects a config change mid-flow (login mode)** — session `providerVersion: 3`, provider `status: 'active', configVersion: 4` → `302` to `/login?error=sso_config_changed`; no token mint.
3. **Callback rejects a NULL `providerVersion` (pre-deploy row)** — session `providerVersion: null`, provider `configVersion: 1` → `302` to `/login?error=sso_config_changed`.
4. **Callback rejects an inactive provider in LINK mode** — session `{ linkUserId: '…', providerVersion: 2 }`, provider `{ status: 'inactive', configVersion: 2 }` → `302` to `/settings/profile?ssoLinkError=provider_inactive`; assert no `userSsoIdentities` insert.
5. **Callback ACCEPTS a `testing` provider in LINK mode** (mirrors link-start's own gate) — provider `{ status: 'testing', configVersion: 2 }`, session `providerVersion: 2` → proceeds to the link branch.
6. **`PATCH /providers/:id` bumps `config_version`** — capture the object passed to the mocked `db.update().set()` and assert it carries a `configVersion` key whose value is an SQL expression (not a literal). Simplest robust assertion: `expect(Object.keys(setPayload)).toContain('configVersion')`.
7. **`POST /providers/:id/status` bumps `config_version`** — same assertion on the status route's `set()` payload.
8. **Login init stores the snapshot** — capture the `db.insert(ssoSessions).values()` payload from `GET /login/:orgId` and assert `providerVersion === provider.configVersion`.

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/sso.test.ts -t 'SR2-11'
```
Expected: **FAIL** — the callback never reads `provider.status` or any version; the writers set no `configVersion`; the session inserts carry no `providerVersion`.

- [ ] **Step 3: Implement — bump the version on every config/status write**

In `routes/sso.ts`, extend the `drizzle-orm` import (`:4`):

```ts
import { eq, and, gt, ne, isNull, inArray, sql } from 'drizzle-orm';
```
(`inArray` is used by Task 6; add it now to avoid two edits to the same line.)

**PATCH `/providers/:id`** — in the `updates` object (`:630-633`, which Task 3 already extended with the `defaultRoleConfiguredBy` stamp):

```ts
  const updates: Partial<typeof ssoProviders.$inferInsert> = {
    ...body,
    updatedAt: new Date(),
    ...(body.defaultRoleId ? { defaultRoleConfiguredBy: auth.user.id } : {}),   // Task 3
    // SR2-11: any config change starts a new generation. Every pending
    // sso_session snapshotted the OLD version and is now dead at the callback.
    // Bumped in the same UPDATE as the change, so the two can never diverge.
    configVersion: sql`${ssoProviders.configVersion} + 1` as unknown as number,
  };
```

> Tasks 3, 4 and 7 each add a key to this ONE object. The final form (after Task 7 adds `...rediscovered`) is the canonical one — see Task 7 Step 4.

**POST `/providers/:id/status`** — in the `.set(...)` (`:745`):

```ts
    .set({
      status,
      updatedAt: new Date(),
      // SR2-11: a status change is a config change. Disabling a provider must
      // kill its outstanding sessions, and re-enabling must not resurrect them
      // (two writes, two bumps).
      configVersion: sql`${ssoProviders.configVersion} + 1` as unknown as number,
    })
```

- [ ] **Step 4: Implement — snapshot the version at session creation**

All three `db.insert(ssoSessions).values({ … })` sites gain `providerVersion: provider.configVersion`:
- link start (`:1098-1106`, now wrapped by Task 1),
- partner login init (`:1224-1233`),
- org login init (`:1319-1328`).

```ts
      providerVersion: provider.configVersion,
```

(All three already have the full `provider` row in scope from a `select()` with no field list.)

- [ ] **Step 5: Implement — the callback gate**

Add the checker next to `revalidateSsoDefaultRole`:

```ts
type SsoCallbackMode = 'login' | 'link';

/**
 * SR2-11: a pending SSO transaction is valid only against the provider
 * GENERATION it was created under, and only while the provider is still usable
 * for its own mode.
 *
 * Status per mode mirrors each mode's INIT gate: /login/* requires
 * status='active', /link/start requires status!=='inactive' (a `testing`
 * provider may be linked). Neither was checked at the callback before this
 * change — a provider disabled inside the <=10-minute state TTL still completed
 * a full login or link.
 *
 * A NULL providerVersion (a row written before the column existed) is a REJECT,
 * not a pass: those are exactly the unbound sessions this change invalidates.
 */
function checkProviderGeneration(
  provider: typeof ssoProviders.$inferSelect,
  session: typeof ssoSessions.$inferSelect,
  mode: SsoCallbackMode,
):
  | { ok: true }
  | { ok: false; reason: 'provider_inactive' | 'provider_not_usable' | 'provider_version_missing' | 'provider_version_mismatch' } {
  if (provider.status === 'inactive') {
    return { ok: false, reason: 'provider_inactive' };
  }
  if (mode === 'login' && provider.status !== 'active') {
    return { ok: false, reason: 'provider_not_usable' };
  }
  if (session.providerVersion == null) {
    return { ok: false, reason: 'provider_version_missing' };
  }
  if (session.providerVersion !== provider.configVersion) {
    return { ok: false, reason: 'provider_version_mismatch' };
  }
  return { ok: true };
}
```

In the callback, **immediately after** the org-XOR-partner guard (`:1436-1440`, the `if (!providerOrgId && !provider.partnerId)` block) and **before** the default-role block (`:1447`), insert:

```ts
  const callbackMode: SsoCallbackMode = session.linkUserId ? 'link' : 'login';

  const generation = checkProviderGeneration(provider, session, callbackMode);
  if (!generation.ok) {
    writeRouteAudit(c, {
      orgId: provider.orgId,
      action: 'sso.callback.rejected',
      resourceType: 'sso_provider',
      resourceId: provider.id,
      resourceName: provider.name,
      result: 'denied',
      details: {
        mode: callbackMode,
        phase: 'provider_generation',
        reason: generation.reason,
        partnerId: provider.partnerId,
        sessionVersion: session.providerVersion,
        providerVersion: provider.configVersion,
      },
    });
    clearStateCookie();
    if (callbackMode === 'link') {
      return c.redirect(
        generation.reason === 'provider_inactive' || generation.reason === 'provider_not_usable'
          ? '/settings/profile?ssoLinkError=provider_inactive'
          : '/settings/profile?ssoLinkError=config_changed',
      );
    }
    return c.redirect(
      generation.reason === 'provider_inactive' || generation.reason === 'provider_not_usable'
        ? '/login?error=sso_provider_inactive'
        : '/login?error=sso_config_changed',
    );
  }
```

- [ ] **Step 6: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/sso.test.ts
```
Expected: **PASS** (whole file — the new callback block adds **no** `db.select`, so the existing `mockReturnValueOnce` queues are unaffected; if a pre-existing test reds, it is because its primed provider row lacks `configVersion`/its session row lacks `providerVersion` — add them to the fixture, do not weaken the gate).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts
git commit -m "feat(sso): bump provider config_version on every config/status change; callback rejects inactive provider or stale generation (SR2-11)"
```

---

### Task 5: SR2-11b — link sessions bound to the initiating session

**Files:**
- Modify: `apps/api/src/routes/sso.ts` — `POST /sso/link/start` (`:1056-1133`), link-callback branch (`:1555-1622`)
- Test: `apps/api/src/routes/sso.test.ts` (`describe('Connect SSO link flow (#2183)')` `:2281-2445`, `primeLinkCallback` `:2391-2398`)

**Interfaces:**
- Consumes: `getUserEpochs` (already imported from `'../services'` at `sso.ts:35`); **`getRefreshFamily`** — NEW import from `'../services'` (**must be added to `vi.mock('../services')` at `sso.test.ts:49-67`**); `auth.token.sid` (**`vi.mock('../middleware/auth')` at `:174-208` must gain a `token` key**); `organizationUsers`, `partnerUsers` (already imported at `sso.ts:8-18`).
- Produces (used only inside `sso.ts`):
  ```ts
  type LinkRejectReason =
    | 'link_binding_missing'
    | 'link_user_gone'
    | 'link_user_inactive'
    | 'link_epochs_unavailable'
    | 'link_auth_epoch_mismatch'
    | 'link_mfa_epoch_mismatch'
    | 'link_family_missing'
    | 'link_family_revoked'
    | 'link_family_expired'
    | 'link_axis_membership_lost';

  /** Re-check a pending link session against LIVE state. Call inside withSystemDbAccessContext. */
  async function validateLinkBinding(
    session: typeof ssoSessions.$inferSelect,
    provider: typeof ssoProviders.$inferSelect,
  ): Promise<{ ok: true; user: typeof users.$inferSelect } | { ok: false; reason: LinkRejectReason }>;
  ```

**Decisions:**
- **Capture shape mirrors PR 2's `enforceExistingFactorStepUp`** (`routes/auth/helpers.ts:252-281`): `{ authEpoch, mfaEpoch, sid }`, resolved from `getUserEpochs(auth.user.id)` + `auth.token.sid`. If **either** is unavailable → **503** `{ error: 'Service temporarily unavailable' }` and **no session row is written**. Same fail-closed contract, same 503, so the two bind-and-recheck surfaces cannot drift.
- **`mfaEpoch` is captured and re-checked** even though the design text names only auth epoch. `/sso/link/start` is already behind `requireMfa()`; an MFA-factor change (which PR 2 makes bump `mfa_epoch` and revoke every family) must therefore invalidate a pending link. Cheap, strictly stronger, and it makes the check symmetric with the pending-MFA record. (Note the family-revocation check would *also* catch this — `mfa_epoch` re-check is defense in depth.)
- **The refresh family is the logout hook.** `getRefreshFamily(sid)` returns `{ revokedAt, absoluteExpiresAt }`; a logout durably revokes exactly that family (PR 1). So checking `revokedAt == null && absoluteExpiresAt > now` is precisely what makes "logout invalidates link transactions through their bound refresh family" true. A **missing** family row (`null`) is a reject, not a pass.
- **Axis membership is re-asserted**, not assumed from the session: org-axis provider → a live `organization_users(userId, provider.orgId)` row; partner-axis provider → a live `partner_users(userId, provider.partnerId)` row **and** `users.orgId IS NULL` (the same staff invariant the mint gate asserts). A user removed from the org between start and callback cannot complete the link.
- **One generic public error for all of these: `/settings/profile?ssoLinkError=session_invalid`.** The specific `LinkRejectReason` goes only to the audit. Rationale: these codes are rendered in the UI, and distinguishing "your account was suspended" from "your session was revoked" from "you lost org membership" leaks account state to whoever holds the browser. The pre-existing `user_gone` / `email_mismatch` / `identity_in_use` codes are unchanged.
- **Audit:** `action: 'sso.identity.link_rejected'`, `result: 'denied'`, `details: { reason, providerId, partnerId, userId }`. No `state`, no tokens.

- [ ] **Step 1: Write the failing tests**

First, the mock prerequisites in `routes/sso.test.ts` — **without these the whole suite throws**:

```ts
// vi.mock('../services') factory (:49-67) — ADD:
  getRefreshFamily: vi.fn().mockResolvedValue({
    revokedAt: null,
    absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }),

// vi.mock('../middleware/auth') factory (:174-208) — the fake auth context ADDS `token`:
    c.set('auth', {
      scope: 'organization',
      orgId: '00000000-0000-4000-8000-000000000010',
      partnerId: null,
      accessibleOrgIds: ['00000000-0000-4000-8000-000000000010'],
      canAccessOrg: () => true,
      user: { id: '00000000-0000-4000-8000-000000000020', email: 'test@example.com' },
      // SR2-11b: /sso/link/start binds the pending session to the initiating
      // refresh family. Without this key every link test throws on auth.token.sid.
      token: { sid: '00000000-0000-4000-8000-0000000000fa' },
    });
```

Then, in `describe('Connect SSO link flow (#2183)')`, add tests:

1. **`/link/start` stores the binding** — capture the `db.insert(ssoSessions).values()` payload and assert `initiatingAuthEpoch === 1`, `initiatingMfaEpoch === 1` (the `getUserEpochs` mock returns `{authEpoch:1,mfaEpoch:1}`), `initiatingSessionId === '00000000-0000-4000-8000-0000000000fa'`, `providerVersion === provider.configVersion`.
2. **`/link/start` returns 503 when epochs are unavailable** — `vi.mocked(getUserEpochs).mockResolvedValueOnce(null)` → 503 and `db.insert` **never** called.
3. **`/link/start` returns 503 when the token has no `sid`** — override the auth mock's `token` to `{}` for one test → 503, no insert.
4. **Link callback rejects a revoked initiating family** — `vi.mocked(getRefreshFamily).mockResolvedValueOnce({ revokedAt: new Date(), absoluteExpiresAt: new Date(Date.now()+1e9) })` → `302` to `/settings/profile?ssoLinkError=session_invalid`; assert no `userSsoIdentities` insert.
5. **Link callback rejects an auth-epoch bump** — session `initiatingAuthEpoch: 1`, `getUserEpochs` → `{ authEpoch: 2, mfaEpoch: 1 }` → `session_invalid`, no insert.
6. **Link callback rejects a suspended user** — the primed `users` row has `status: 'suspended'` → `session_invalid`, no insert.
7. **Link callback rejects a NULL binding (pre-deploy row)** — session has `linkUserId` set but `initiatingSessionId: null` → `session_invalid`, no insert.
8. **Link callback rejects lost org membership** — prime the `organization_users` membership select to return `[]` → `session_invalid`, no insert.
9. **Happy path still links** — all live checks pass → `302` to `/settings/profile?ssoLinked=1` and the `userSsoIdentities` insert fires.

> **`primeLinkCallback` (`:2391-2398`) must be rewritten.** `validateLinkBinding` adds **one new select** (the axis-membership row) *after* the existing `users` select and *before* the `userSsoIdentities` select. Every `mockReturnValueOnce` queue in the link tests shifts by one. Update the helper once and let all the link tests consume it.

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/sso.test.ts -t 'link'
```
Expected: **FAIL** — `/link/start` writes no binding columns; the link callback checks none of them.

- [ ] **Step 3: Implement — capture the binding at `/link/start`**

Extend the `'../services'` import (`sso.ts:35`):

```ts
import { createTokenPair, createSession, mintRefreshTokenFamily, bindRefreshJtiToFamily, getUserEpochs, getRefreshFamily, rateLimiter, getRedis } from '../services';
```

In `POST /sso/link/start/:providerId`, **immediately before** the session insert (the block Task 1 wrapped), add:

```ts
    // SR2-11b: bind the pending link to the CURRENT security generation of the
    // initiating session. Mirrors PR 2's enforceExistingFactorStepUp
    // (routes/auth/helpers.ts:252-281): capture {authEpoch, mfaEpoch, sid} at
    // mint, re-check against the LIVE row at consume. This is what makes a
    // logout / password reset / MFA reset / suspension / global revocation
    // between start and callback invalidate the pending link.
    //
    // Fail closed: without epochs or a sid there is nothing to bind to, so we
    // refuse to create the session rather than create an unbindable one.
    const initiatorEpochs = await getUserEpochs(auth.user.id);
    const initiatingSid = auth.token?.sid;
    if (!initiatorEpochs || !initiatingSid) {
      return c.json({ error: 'Service temporarily unavailable' }, 503);
    }
```

and extend the insert's `.values({ … })` with:

```ts
          providerVersion: provider.configVersion,          // Task 4
          initiatingAuthEpoch: initiatorEpochs.authEpoch,
          initiatingMfaEpoch: initiatorEpochs.mfaEpoch,
          initiatingSessionId: initiatingSid,
```

- [ ] **Step 4: Implement — re-check the binding at the link callback**

Add the validator next to `checkProviderGeneration`:

```ts
type LinkRejectReason =
  | 'link_binding_missing'
  | 'link_user_gone'
  | 'link_user_inactive'
  | 'link_epochs_unavailable'
  | 'link_auth_epoch_mismatch'
  | 'link_mfa_epoch_mismatch'
  | 'link_family_missing'
  | 'link_family_revoked'
  | 'link_family_expired'
  | 'link_axis_membership_lost';

/**
 * SR2-11b: re-check a pending LINK session against LIVE state before it is
 * allowed to bind an external identity to a Breeze account.
 *
 * The session snapshotted {authEpoch, mfaEpoch, sid} at /link/start. Any of the
 * following since then must kill it:
 *   - the user was suspended/deleted            -> status / user_gone
 *   - password reset, email change, membership
 *     change, platform-privilege change         -> auth_epoch bump
 *   - any MFA factor change                     -> mfa_epoch bump
 *   - logout, or a global session revocation    -> the bound refresh family is
 *                                                  revoked (or gone/expired)
 *   - removal from the provider's org/partner   -> axis membership lost
 *
 * A pre-deploy row (any binding column NULL) is a REJECT, not a pass.
 *
 * MUST be called inside withSystemDbAccessContext (/sso/callback is
 * unauthenticated; getRefreshFamily establishes its own system context).
 */
async function validateLinkBinding(
  session: typeof ssoSessions.$inferSelect,
  provider: typeof ssoProviders.$inferSelect,
): Promise<{ ok: true; user: typeof users.$inferSelect } | { ok: false; reason: LinkRejectReason }> {
  if (
    session.initiatingAuthEpoch == null ||
    session.initiatingMfaEpoch == null ||
    session.initiatingSessionId == null
  ) {
    return { ok: false, reason: 'link_binding_missing' };
  }

  const [linkingUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.linkUserId!))
    .limit(1);
  if (!linkingUser) return { ok: false, reason: 'link_user_gone' };
  if (linkingUser.status !== 'active') return { ok: false, reason: 'link_user_inactive' };

  const liveEpochs = await getUserEpochs(linkingUser.id);
  if (!liveEpochs) return { ok: false, reason: 'link_epochs_unavailable' };
  if (liveEpochs.authEpoch !== session.initiatingAuthEpoch) {
    return { ok: false, reason: 'link_auth_epoch_mismatch' };
  }
  if (liveEpochs.mfaEpoch !== session.initiatingMfaEpoch) {
    return { ok: false, reason: 'link_mfa_epoch_mismatch' };
  }

  const family = await getRefreshFamily(session.initiatingSessionId);
  if (!family) return { ok: false, reason: 'link_family_missing' };
  if (family.revokedAt) return { ok: false, reason: 'link_family_revoked' };
  if (family.absoluteExpiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'link_family_expired' };
  }

  // Axis membership must STILL be held (the /link/start pool check is a
  // snapshot, not a guarantee).
  if (provider.orgId) {
    const [membership] = await db
      .select({ userId: organizationUsers.userId })
      .from(organizationUsers)
      .where(and(
        eq(organizationUsers.userId, linkingUser.id),
        eq(organizationUsers.orgId, provider.orgId),
      ))
      .limit(1);
    if (!membership) return { ok: false, reason: 'link_axis_membership_lost' };
  } else if (provider.partnerId) {
    if (linkingUser.orgId != null) return { ok: false, reason: 'link_axis_membership_lost' };
    const [membership] = await db
      .select({ userId: partnerUsers.userId })
      .from(partnerUsers)
      .where(and(
        eq(partnerUsers.userId, linkingUser.id),
        eq(partnerUsers.partnerId, provider.partnerId),
      ))
      .limit(1);
    if (!membership) return { ok: false, reason: 'link_axis_membership_lost' };
  } else {
    return { ok: false, reason: 'link_axis_membership_lost' };
  }

  return { ok: true, user: linkingUser };
}
```

Rewrite the head of the link branch (`sso.ts:1561-1573`). **Replace**:

```ts
    if (session.linkUserId) {
      const outcome = await withSystemDbAccessContext(async () => {
        const [linkingUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, session.linkUserId!))
          .limit(1);
        if (!linkingUser) return { error: 'user_gone' as const };
```

**with**:

```ts
    if (session.linkUserId) {
      const outcome = await withSystemDbAccessContext(async () => {
        // SR2-11b: live re-check of the binding captured at /link/start.
        const binding = await validateLinkBinding(session, provider);
        if (!binding.ok) {
          return { error: 'session_invalid' as const, auditReason: binding.reason };
        }
        const linkingUser = binding.user;
```

and change the failure handler (`:1608-1611`) from:

```ts
      clearStateCookie();
      if ('error' in outcome) {
        return c.redirect(`/settings/profile?ssoLinkError=${outcome.error}`);
      }
```

to:

```ts
      clearStateCookie();
      if ('error' in outcome) {
        writeRouteAudit(c, {
          orgId: provider.orgId,
          action: 'sso.identity.link_rejected',
          resourceType: 'sso_provider',
          resourceId: provider.id,
          resourceName: provider.name,
          result: 'denied',
          details: {
            // The PUBLIC code is deliberately coarse (session_invalid). The
            // precise reason lives here only — distinguishing "suspended" from
            // "session revoked" from "removed from org" in the URL would leak
            // account state to whoever holds the browser.
            reason: (outcome as { auditReason?: string }).auditReason ?? outcome.error,
            publicCode: outcome.error,
            partnerId: provider.partnerId,
            userId: session.linkUserId,
          },
        });
        return c.redirect(`/settings/profile?ssoLinkError=${outcome.error}`);
      }
```

The rest of the link branch (email match → `email_mismatch`; `(provider, sub)` conflict → `identity_in_use`; the `userSsoIdentities` insert) is unchanged and continues to use `linkingUser`.

> **The `user_gone` public code disappears from the link surface** (folded into `session_invalid`). That is intentional — it was an account-state oracle. The web UI **does** switch on `ssoLinkError` (`apps/web/src/components/settings/ConnectSsoCard.tsx:11-15`, tests at `ConnectSsoCard.test.tsx:91-110`), so an unmapped code renders a useless generic banner. **Task 6 Step 5 carries the web arm for every new code introduced by Tasks 4, 5 and 6** — do not ship this task expecting the UI to cope.

- [ ] **Step 5: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/sso.test.ts
```
Expected: **PASS** (whole file).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts
git commit -m "feat(sso): bind pending link sessions to the initiating session; re-check epochs/family/status/membership at callback (SR2-11)"
```

---

### Task 6: SR2-12 — verified identity claims (+ org clamp on auto-link)

**Files:**
- Modify: `apps/api/src/services/sso.ts:331-347` (`assertEmailVerified` neighborhood) — add `readEmailVerifiedClaim`
- Modify: `apps/api/src/routes/sso.ts:1497-1535` (email-verification + attribute mapping), `:1650-1662` (domain gate), `:1664-1705` (auto-link + `emailCondition`)
- Modify: `apps/web/src/components/settings/ConnectSsoCard.tsx:11-15` (`LINK_ERROR_KEYS`) + the `connectSsoCard.*` i18n locale files (incl. `pt-BR`) — **the web arm for ALL new link-error codes from Tasks 4, 5 and 6** (Step 5)
- Test: `apps/api/src/services/sso.test.ts`, `apps/api/src/routes/sso.test.ts`, `apps/web/src/components/settings/ConnectSsoCard.test.tsx`

**Interfaces:**
- Produces (`services/sso.ts`, consumed by `routes/sso.ts` **and by the `vi.mock('../services/sso')` factory**):
  ```ts
  export type EmailVerifiedClaim = 'true' | 'false' | 'absent';
  /**
   * Read `email_verified` from an id_token claim set OR a userinfo body.
   * true/'true' -> 'true'; false/'false' -> 'false'; anything else (missing,
   * null, non-boolean junk) -> 'absent'.
   */
  export function readEmailVerifiedClaim(source: Record<string, unknown> | null | undefined): EmailVerifiedClaim;
  ```
- Consumes: `isDomainVerifiedForOrg(orgId, rawDomain): Promise<boolean>` (`services/ssoDomainVerification.ts:99`) — **add to the `routes/sso.ts` import from `'../services/ssoDomainVerification'` at `:19`**; `isSsoProvisioningBlocked` (already imported); `inArray` (drizzle — added in Task 4); `organizationUsers` (already imported).

> ⚠️ **READ FIRST — `db.select()` QUEUE SHIFT.** Step 4(d) builds `emailCondition` with an `inArray(users.id, db.select({…})…)` subquery. `db.select()` is **invoked at condition-construction time**, and `routes/sso.test.ts`'s hand-rolled mock hands out a queued chain **per `db.select()` call**. So **every existing org-axis callback test that reaches the by-email branch shifts by one queue slot.** Before writing any new test, re-prime the affected `mockReturnValueOnce` queues in the existing login-callback primers (insert one extra chain returning `[]` or the member row, positioned where the subquery is constructed — i.e. *before* the by-email `users` select resolves). Do not chase this as a phantom failure in "unrelated" tests; it is this change.

**Decisions (Overseer Decisions 1-4, implemented exactly):**
- **The claim is read from whichever source supplied the FINAL email.** Today `assertEmailVerified` is called only `if (idClaims.email)` (`routes/sso.ts:1502-1504`), and **userinfo's `email_verified` is never read anywhere** (`OIDCUserInfo.email_verified` is declared at `services/sso.ts:32` with zero readers). So when the id_token omits `email`, the callback silently falls through to an *unverified* userinfo email that then drives the domain check, the auto-link, and JIT. Fixed: pick the claim source at the same moment the email is picked.
- **The attestation must be bound to the MAPPED email — the last laundering path.** On the userinfo path the final address is `attrs.email = mapUserAttributes(userInfo, mapping)` (`services/sso.ts:482-521`), and `mapping.email` is **admin-set jsonb** that may name `upn`, `preferred_username`, or any other key. But `email_verified` in a userinfo body attests userinfo.**`email`** — a *different* address. So `attributeMapping.email = 'preferred_username'` + `email_verified: true` would launder a completely unattested address behind a true verification claim. **Fix:** on the userinfo path, treat the claim as **`'absent'`** unless the mapping key is literally `'email'` **or** the mapped value equals `userInfo.email`. Absent then falls into the domain-ownership gate, which is exactly the right outcome. (The id_token path is unaffected: `attrs.email` is overwritten from `idClaims.email` there, so the claim and the address come from the same object.)
- **`false` → ALWAYS reject** (both axes, all paths, including already-linked users). Unchanged in spirit from today, but now it also fires on the userinfo path.
- **`true` → allow.**
- **`absent` → allow ONLY if the asserted email's domain is a VERIFIED domain for the provider's org** (`isDomainVerifiedForOrg`), else reject. This is the design's "documented and enforced equivalent guarantee" — Breeze itself proves the domain via DNS TXT instead of trusting an IdP that declines to say.
- **ORG AXIS ONLY, and this is a known gap.** `sso_verified_domains.org_id` is `NOT NULL` — **there is no partner-axis domain machinery at all**, so applying the absent-claim gate to the partner axis would reject *every* partner-axis Entra login (Entra omits `email_verified`). The partner axis keeps today's absent-claim tolerance. It is materially lower-risk: it has **no JIT** (`routes/sso.ts:1707-1714` → `invite_required`), and its auto-link already clamps hard to `(users.partnerId = provider.partnerId AND users.orgId IS NULL AND passwordless AND no conflicting provider link)` — i.e. an already-provisioned staff member of the very partner that configured the IdP. **Documented follow-up (NOT PR 3 scope):** extend `sso_verified_domains` to dual-axis per the PARTNER-WIDE FIRST principle, then apply the same gate on the partner axis. State this in the PR body as a known gap.
- **Placement of the absent-claim gate:** inside the `!user && provider.orgId` block, alongside the existing `isSsoProvisioningBlocked` call — i.e. exactly where email (rather than the `(provider, sub)` link) drives resolution. Already-linked identities stay exempt, which preserves today's guarantee that turning domain enforcement on never locks out an existing SSO user. The **explicit-`false`** gate, by contrast, sits at the top (before identity resolution) and applies to everyone.
- **Auto-link is gated on domain ownership** (Overseer Decision 2). Note this is *already* structurally true — `isSsoProvisioningBlocked` runs at `:1650` **before** the by-email branch, so it covers auto-link and JIT alike — but it is **opt-in** (it no-ops unless the org already has ≥1 verified domain or `SSO_DOMAIN_VERIFICATION_STRICT=true`). The new absent-claim gate is **not** opt-in: an absent claim requires a verified domain, full stop. Together, an org-axis auto-link now requires *either* a positively verified email *or* a Breeze-proven domain.
- **Org clamp on the auto-link email match** (Overseer Decision 4). `emailCondition`'s org branch is `eq(users.email, …)` — matching **any** user globally. Cross-tenant login is already blocked one gate deeper (the org-axis mint requires an `organization_users` row for `provider.orgId`, else `no_org_access`), so **this was not exploitable** — it is defense-in-depth debt. The clamp is **membership-bounded**, not `eq(users.orgId, provider.orgId)`: a legitimate multi-org user's `users.orgId` may point at a different org while they hold a valid membership in the provider's org, and a naive column clamp would break them. Use `inArray(users.id, <org members subquery>)` — exactly the population the mint gate would accept.
- **Public error code:** `/login?error=sso_email_unverified` for both the explicit-`false` and the absent-without-verified-domain cases (indistinguishable publicly). The audit reason distinguishes `email_verified_false` from `email_verified_absent_domain_unverified`. The existing `sso_domain_unverified` code stays for the `isSsoProvisioningBlocked` path.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/sso.test.ts` — add:

```ts
describe('readEmailVerifiedClaim (SR2-12)', () => {
  it.each([
    [{ email_verified: true }, 'true'],
    [{ email_verified: 'true' }, 'true'],
    [{ email_verified: false }, 'false'],
    [{ email_verified: 'false' }, 'false'],
    [{}, 'absent'],
    [{ email_verified: null }, 'absent'],
    [{ email_verified: 'maybe' }, 'absent'],
    [{ email_verified: 1 }, 'absent'],
  ])('%o -> %s', (source, expected) => {
    expect(readEmailVerifiedClaim(source as Record<string, unknown>)).toBe(expected);
  });

  it('returns absent for null/undefined', () => {
    expect(readEmailVerifiedClaim(null)).toBe('absent');
    expect(readEmailVerifiedClaim(undefined)).toBe('absent');
  });
});
```

`apps/api/src/routes/sso.test.ts` — add `describe('SSO verified identity claims (SR2-12)', …)`:

1. **id_token `email_verified: false` → reject** — `302` to `/login?error=sso_email_unverified`; no token mint, no user insert.
2. **id_token omits `email`; userinfo carries `email_verified: false` → reject** (this is the never-read path) — same redirect. Prime `verifyIdTokenSignature` → `{ sub: 's1', nonce: 'nonce' }` (no `email`) and `getUserInfo` → `{ sub: 's1', email: 'x@corp.example', email_verified: false }`.
3. **Absent claim + org axis + domain NOT verified + no existing link → reject** — mock `isDomainVerifiedForOrg` → `false` → `/login?error=sso_email_unverified`; assert **no** `users` insert.
4. **Absent claim + org axis + domain VERIFIED → proceeds** — `isDomainVerifiedForOrg` → `true` → reaches the auto-link/JIT path.
5. **Absent claim + PARTNER axis → tolerated** (documented gap) — a partner-axis callback with an absent claim reaches the partner identity resolution (and, with no user, the `invite_required` redirect) rather than `sso_email_unverified`.
6. **Absent claim + already-linked user (org axis) → allowed** — the `(provider, sub)` link resolves the user, so the email-driven gates never run.
7. **Org clamp on auto-link** — prime the by-email select and assert the WHERE it receives is membership-bounded. Cheapest robust assertion given the hand-rolled Drizzle mock: assert that when the by-email select returns a user who is **not** in the provider's org, the callback does not mint (`createTokenPair` not called). Prime the `organizationUsers` membership subquery mock to return `[]`.

8. **Mapped-email laundering is blocked (I3)** — `attributeMapping: { email: 'preferred_username', name: 'name' }`; userinfo `{ sub:'s1', email:'real@corp.example', email_verified: true, preferred_username: 'spoof@corp.example' }`; id_token omits `email`; the org has **no** verified domain → **reject** `/login?error=sso_email_unverified`. The `email_verified: true` attests `real@…`, not the mapped `spoof@…`, so it must not count. Add the mirror case: same setup but the org **has** `corp.example` verified → proceeds (the domain gate is what carries it, which is correct).

**`services/ssoDomainVerification` is ALREADY MOCKED — `routes/sso.test.ts:158`.** Do **not** add a second `vi.mock` for that path: a duplicate clobbers the first and reds the existing domain-gate tests, which use `vi.mocked(isSsoProvisioningBlocked)` (`:1297`, `:1314`). **Extend the existing factory** with the one new export:

```ts
vi.mock('../services/ssoDomainVerification', () => ({
  createPendingDomain: vi.fn(),
  verifyDomain: vi.fn(),
  recordNameFor: vi.fn((domain: string) => `_breeze-verify.${domain}`),
  recordValueFor: vi.fn((token: string) => `breeze-domain-verify=${token}`),
  isSsoProvisioningBlocked: vi.fn().mockResolvedValue(false),
  // NEW (SR2-12): the hard absent-claim gate. Default true so existing tests,
  // which assert on isSsoProvisioningBlocked, are unaffected.
  isDomainVerifiedForOrg: vi.fn().mockResolvedValue(true),
}));
```
Per-test overrides use `vi.mocked(isDomainVerifiedForOrg).mockResolvedValueOnce(false)` — matching how the file already drives `isSsoProvisioningBlocked`.

And add `readEmailVerifiedClaim` to the `vi.mock('../services/sso')` factory (`:22-47`) — **use the real implementation, not a stub**, so these tests actually exercise the claim reader:

```ts
  readEmailVerifiedClaim: (source: Record<string, unknown> | null | undefined) => {
    const ev = source?.email_verified;
    if (ev === true || ev === 'true') return 'true';
    if (ev === false || ev === 'false') return 'false';
    return 'absent';
  },
```

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/sso.test.ts src/routes/sso.test.ts -t 'SR2-12'
```
Expected: **FAIL** — `readEmailVerifiedClaim` does not exist; the userinfo `email_verified: false` case sails through; an absent claim is unconditionally tolerated; the org auto-link matches globally.

- [ ] **Step 3: Implement — the claim reader**

In `apps/api/src/services/sso.ts`, **replace** the `assertEmailVerified` block (`:331-347`) with:

```ts
/**
 * The three possible states of an OIDC `email_verified` claim, read from EITHER
 * an id_token claim set OR a userinfo body. `email_verified` may legitimately
 * arrive as a boolean or as a string (SR2-12).
 *
 * 'absent' covers missing, null, and any non-boolean junk value — an IdP that
 * says something we cannot interpret has not asserted verification.
 */
export type EmailVerifiedClaim = 'true' | 'false' | 'absent';

export function readEmailVerifiedClaim(
  source: Record<string, unknown> | null | undefined,
): EmailVerifiedClaim {
  const ev = source?.email_verified;
  if (ev === true || ev === 'true') return 'true';
  if (ev === false || ev === 'false') return 'false';
  return 'absent';
}

/**
 * @deprecated Superseded by readEmailVerifiedClaim + the callback's axis-aware
 * gate (SR2-12). Kept because it is the documented "explicit false only"
 * behavior and is still unit-tested; the SSO callback no longer calls it.
 */
export function assertEmailVerified(claims: Pick<IDTokenClaims, 'email_verified'>): void {
  if (readEmailVerifiedClaim(claims as Record<string, unknown>) === 'false') {
    throw new Error('ID token email is explicitly not verified (email_verified === false)');
  }
}
```

- [ ] **Step 4: Implement — the callback gates**

In `apps/api/src/routes/sso.ts`:

Update the `'../services/sso'` import (`:20-34`): drop `assertEmailVerified`, add `readEmailVerifiedClaim` **and `type EmailVerifiedClaim`**. Update the `'../services/ssoDomainVerification'` import (`:19`) to add `isDomainVerifiedForOrg`. (`mapping` is already in scope at `:1523`: `const mapping = (provider.attributeMapping as any) || { email: 'email', name: 'name' };`.)

**(a) Delete** the current gate (`:1502-1504`):
```ts
    const idClaims = await verifyIdTokenSignature(tokens.id_token, config, session.nonce);
    if (idClaims.email) {
      assertEmailVerified(idClaims);
    }
```
→ becomes just:
```ts
    const idClaims = await verifyIdTokenSignature(tokens.id_token, config, session.nonce);
```

**(b)** After the `attrs.email` finalization block (`:1528-1535`, the `if (idClaims.email) { attrs.email = …lowerCase(); }`), insert the source-aware gate:

```ts
    // ── SR2-12: verified identity claims ─────────────────────────────────────
    // The `email_verified` decision must ride the SAME source that supplied the
    // final email. Previously it was read ONLY from the id_token and ONLY when
    // the id_token carried an email — so an IdP that omits `email` from the
    // id_token had its userinfo email accepted with the userinfo
    // `email_verified` NEVER read (OIDCUserInfo.email_verified had zero
    // readers). That unverified email then drove the domain check, the
    // auto-link, and JIT.
    // …and it must be bound to the address we ACTUALLY use. On the userinfo path
    // `attrs.email` comes from mapUserAttributes(userInfo, mapping) with an
    // ADMIN-SET mapping key — which may be `upn` / `preferred_username` / … —
    // while userinfo's `email_verified` attests userinfo.`email`. Trusting the
    // claim across that gap would let attributeMapping.email='preferred_username'
    // launder an unattested address behind email_verified:true. So on the
    // userinfo path the claim only counts when it demonstrably describes the same
    // address; otherwise it is 'absent' and falls into the domain-ownership gate.
    const usingIdTokenEmail = Boolean(idClaims.email);
    const userInfoRecord = userInfo as unknown as Record<string, unknown>;
    const userInfoEmail =
      typeof userInfoRecord.email === 'string' ? userInfoRecord.email.toLowerCase() : null;
    const mappedKeyIsEmail = (mapping?.email ?? 'email') === 'email';
    const claimDescribesMappedEmail =
      mappedKeyIsEmail || (userInfoEmail !== null && userInfoEmail === attrs.email.toLowerCase());

    const emailVerifiedClaim: EmailVerifiedClaim = usingIdTokenEmail
      ? readEmailVerifiedClaim(idClaims as unknown as Record<string, unknown>)
      : claimDescribesMappedEmail
        ? readEmailVerifiedClaim(userInfoRecord)
        : 'absent';

    // Explicit false is ALWAYS fatal, on both axes, on every path (including an
    // already-linked identity): the IdP is affirmatively telling us the mailbox
    // is not proven.
    if (emailVerifiedClaim === 'false') {
      writeRouteAudit(c, {
        orgId: provider.orgId,
        action: 'sso.callback.rejected',
        resourceType: 'sso_provider',
        resourceId: provider.id,
        resourceName: provider.name,
        result: 'denied',
        details: {
          mode: callbackMode,
          phase: 'email_verification',
          reason: 'email_verified_false',
          claimSource: idClaims.email ? 'id_token' : 'userinfo',
          partnerId: provider.partnerId,
        },
      });
      clearStateCookie();
      return callbackMode === 'link'
        ? c.redirect('/settings/profile?ssoLinkError=email_unverified')
        : c.redirect('/login?error=sso_email_unverified');
    }
```

**(c)** In the `if (!user && provider.orgId)` domain block (`:1650-1662`), **prepend** the absent-claim gate (keep the existing `isSsoProvisioningBlocked` check that follows it):

```ts
    if (!user && provider.orgId) {
      const assertedEmailDomain = attrs.email.split('@')[1]?.toLowerCase() ?? null;

      // SR2-12: an ABSENT `email_verified` claim is acceptable ONLY when Breeze
      // itself has proven the domain (DNS TXT, sso_verified_domains). This is
      // the "documented and enforced equivalent guarantee" the design requires:
      // we stop taking the IdP's silence on faith and substitute our own proof.
      //
      // Reached only when the identity is being resolved BY EMAIL (auto-link) or
      // provisioned fresh (JIT) — an already-linked (provider, sub) identity is
      // deliberately exempt, so enabling this never locks out an existing user.
      //
      // ORG AXIS ONLY. sso_verified_domains.org_id is NOT NULL: there is no
      // partner-axis domain machinery, so applying this to the partner axis
      // would reject EVERY partner-axis Entra login (Entra omits the claim). The
      // partner axis is materially lower-risk — no JIT at all, and its email
      // match already clamps to (same partner, orgId IS NULL, passwordless, no
      // conflicting provider link). KNOWN GAP; follow-up is to make
      // sso_verified_domains dual-axis (PARTNER-WIDE FIRST) and then gate here.
      if (emailVerifiedClaim === 'absent') {
        const domainProven = assertedEmailDomain
          ? await withSystemDbAccessContext(() =>
              isDomainVerifiedForOrg(provider.orgId!, assertedEmailDomain),
            )
          : false;
        if (!domainProven) {
          writeRouteAudit(c, {
            orgId: provider.orgId,
            action: 'sso.callback.rejected',
            resourceType: 'sso_provider',
            resourceId: provider.id,
            resourceName: provider.name,
            result: 'denied',
            details: {
              mode: callbackMode,
              phase: 'email_verification',
              reason: 'email_verified_absent_domain_unverified',
              claimSource: idClaims.email ? 'id_token' : 'userinfo',
              emailDomain: assertedEmailDomain,
              partnerId: provider.partnerId,
            },
          });
          clearStateCookie();
          return c.redirect('/login?error=sso_email_unverified');
        }
      }

      const domainBlocked = await withSystemDbAccessContext(() =>
        isSsoProvisioningBlocked(provider.orgId!, assertedEmailDomain)
      );
      if (domainBlocked) {
        console.warn(
          `[sso/callback] domain verification blocked link/provision: org=${provider.orgId} provider=${provider.id} emailDomain=${assertedEmailDomain ?? 'none'}`
        );
        clearStateCookie();
        return c.redirect('/login?error=sso_domain_unverified');
      }
    }
```

**(d)** The org clamp on `emailCondition` (`:1677-1684`). Replace:

```ts
      const emailCondition = provider.partnerId
        ? and(
            eq(users.email, attrs.email.toLowerCase()),
            eq(users.partnerId, provider.partnerId),
            isNull(users.orgId)
          )
        : eq(users.email, attrs.email.toLowerCase());
```

with:

```ts
      // Org-axis clamp (SR2-12 / defense in depth). The org branch previously
      // matched `eq(users.email, …)` GLOBALLY — any user in any tenant. Login
      // was still blocked one gate deeper (the org-axis mint requires an
      // organization_users row for provider.orgId, else no_org_access), so this
      // was NOT exploitable — it is debt, and it is closed here.
      //
      // Clamp on MEMBERSHIP, not on users.org_id: a legitimate multi-org user's
      // users.org_id may name a different org while they hold a valid membership
      // in the provider's org, and a naive column clamp would lock them out.
      // This subquery is exactly the population the mint gate would accept.
      const emailCondition = provider.partnerId
        ? and(
            eq(users.email, attrs.email.toLowerCase()),
            eq(users.partnerId, provider.partnerId),
            isNull(users.orgId)
          )
        : and(
            eq(users.email, attrs.email.toLowerCase()),
            inArray(
              users.id,
              db
                .select({ userId: organizationUsers.userId })
                .from(organizationUsers)
                .where(eq(organizationUsers.orgId, provider.orgId!))
            )
          );
```

- [ ] **Step 5: Implement — the WEB arm for the new link-error codes (I6)**

Tasks 4, 5 and 6 introduce four new `ssoLinkError` codes and retire one. The web card that renders them is **`apps/web/src/components/settings/ConnectSsoCard.tsx:11-15`**:

```ts
const LINK_ERROR_KEYS: Record<string, string> = {
  email_mismatch: 'connectSsoCard.emailMismatch',
  identity_in_use: 'connectSsoCard.identityInUse',
  user_gone: 'connectSsoCard.userGone'
};
```

Anything not in that map falls back to the generic `connectSsoCard.couldNotConnectSingleSignOn`, so the new codes would render as an unhelpful catch-all. Replace the map with:

```ts
const LINK_ERROR_KEYS: Record<string, string> = {
  email_mismatch: 'connectSsoCard.emailMismatch',
  identity_in_use: 'connectSsoCard.identityInUse',
  // SR2-11: the pending link was invalidated by a live security-state change
  // (sign-out, password reset, MFA change, suspension, lost membership). The
  // server deliberately does NOT say which — that would be an account-state
  // oracle — so the copy asks the user to sign in and retry.
  session_invalid: 'connectSsoCard.sessionInvalid',
  provider_inactive: 'connectSsoCard.providerInactive',
  config_changed: 'connectSsoCard.configChanged',
  // SR2-12: the IdP did not positively verify the asserted address.
  email_unverified: 'connectSsoCard.emailUnverified'
};
```

**Remove the `user_gone` arm** — Task 5 folds that code into `session_invalid` (it was an account-state oracle), so it can no longer be emitted. Delete the now-dead `connectSsoCard.userGone` i18n key **only if** nothing else references it (`grep -rn "connectSsoCard.userGone" apps/web/src`), and add the four new keys to every locale file that carries `connectSsoCard.*` (**including `pt-BR`** — the console is internationalized).

Update `apps/web/src/components/settings/ConnectSsoCard.test.tsx`: the existing `?ssoLinkError=user_gone` test (`:109-110`) must be **repointed to `session_invalid`**, and add cases for `provider_inactive`, `config_changed`, and `email_unverified` (mirroring the `email_mismatch` test at `:91-99`).

- [ ] **Step 6: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/sso.test.ts src/routes/sso.test.ts
cd ../.. && pnpm test --filter=@breeze/web -- ConnectSsoCard
```
Expected: **PASS** (whole files, API and web).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/sso.ts apps/api/src/services/sso.test.ts apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts apps/web/src/components/settings/ConnectSsoCard.tsx apps/web/src/components/settings/ConnectSsoCard.test.tsx apps/web/src/i18n
git commit -m "feat(sso): require a positively verified email (id_token OR userinfo, bound to the mapped address); org-domain proof when the claim is absent; clamp org auto-link to members; surface new link-error codes in the web card (SR2-12)"
```

---

### Task 7: SR2-13 / SR2-14 — SSRF-safe JWKS + endpoint validation

**Files:**
- Modify: `apps/api/src/services/urlSafety.ts` — `SafeFetchInit.maxBytes` + a bounded body read (`:355-381`)
- Modify: `apps/api/src/services/urlSafety.test.ts` — `maxBytes` overrun test
- Modify: `apps/api/src/services/sso.ts:1-3` (imports), `:9-18` (`OIDCConfig`), `:117-146` (`exchangeCodeForTokens`), `:152-168` (`getUserInfo`), `:174-196` (`refreshAccessToken`), `:266-330` (JWKS cache + `verifyIdTokenSignature`), `:424-460` (`discoverOIDCConfig`)
- Modify: `apps/api/src/routes/sso.ts:290-307` (`getOIDCConfig`) + the five `getOIDCConfig` call sites + POST `/providers` discovery (`:527-542`) + PATCH `/providers/:id` issuer change
- Test: `apps/api/src/services/sso.test.ts`, `apps/api/src/routes/sso.test.ts`

**Interfaces:**
- Consumes: `safeFetch(urlStr, init)` where `init: { timeoutMs?, signal?, allowPrivateNetwork?, …RequestInit }` (`services/urlSafety.ts:208`) — **already imported** into `services/sso.ts:3`; `isInternalUrl` (`services/sso.ts:385`); `customFetch` (jose 6.2.3 — `export declare const customFetch: unique symbol`, `dist/types/jwks/remote.d.ts:100`; `RemoteJWKSetOptions[customFetch]?: FetchImplementation` at `:189`, where `FetchImplementation = (url: string, options: {…}) => Promise<Response>`); `selfHostAllowsPrivateNetwork()` (`config/env.ts`, already imported into `routes/sso.ts:42`).
- Produces (`services/urlSafety.ts`) — **new, shared with every existing caller**:
  ```ts
  export interface SafeFetchInit extends Omit<RequestInit, 'signal'> {
    timeoutMs?: number;
    signal?: AbortSignal;
    allowPrivateNetwork?: boolean;
    /** Hard ceiling on the response body. Overrun destroys the socket and throws. Unset = unbounded (legacy). */
    maxBytes?: number;
  }
  export class ResponseTooLargeError extends Error {}   // NEW
  ```
- Produces (`services/sso.ts`):
  ```ts
  export const OIDC_FETCH_TIMEOUT_MS: number;      // 10_000
  export const OIDC_JWKS_TIMEOUT_MS: number;       // 5_000
  export const OIDC_MAX_RESPONSE_BYTES: number;    // 1 * 1024 * 1024

  export interface OIDCConfig {
    // …existing fields…
    /** Self-host escape hatch, resolved ONCE by getOIDCConfig from selfHostAllowsPrivateNetwork(). Never request-supplied. */
    allowPrivateNetwork?: boolean;
  }

  /** Throws when `urlStr` is absent, non-HTTPS (unless self-host http), or points at a blocked address. */
  export function assertSafeOidcEndpoint(label: string, urlStr: string | null | undefined, allowPrivateNetwork?: boolean): void;

  /** Validates every endpoint a discovery document would cause us to persist. Throws on the first bad one. */
  export function validateDiscoveredEndpoints(doc: OIDCDiscoveryDocument, allowPrivateNetwork?: boolean): void;

  /** Test-only: clear the JWKS cache. (already exists as _resetIdTokenJwksCacheForTests) */
  export function _resetIdTokenJwksCacheForTests(): void;
  ```

**Decisions:**
- **A construct-time URL check on `jwksUrl` is NOT sufficient — say it out loud.** `createRemoteJWKSet` is built once per URL and cached in a module-level `Map` (`services/sso.ts:269`); jose then **re-fetches on its own** whenever a `kid` misses or `cacheMaxAge` (10 min) expires, using jose's **global `fetch`** (undici). Validating only inside `getIdTokenJwks` would leave every one of those refetches unguarded: no scheme check, no private-IP check, no DNS pinning. The design's "JWKS caching must not bypass transport validation on refresh" can only be satisfied by **injecting the transport**. jose 6.2.3 exposes exactly that hook (`customFetch`), and `safeFetch(urlStr, init)` is signature-compatible with `FetchImplementation`.
- **`allowPrivateNetwork` rides on `OIDCConfig`.** `getOIDCConfig` (which already builds the config from the provider row) resolves it **once** from `selfHostAllowsPrivateNetwork()` — never from anything request-supplied — and `exchangeCodeForTokens` / `getUserInfo` / `verifyIdTokenSignature` read `config.allowPrivateNetwork ?? false`. This keeps one policy value threaded through every provider-controlled fetch without adding a parameter to five signatures.
- **The JWKS cache key includes the policy flag** (`${allowPrivateNetwork ? 'priv' : 'pub'}|${jwksUri}`) so a self-host-permissive entry can never be served to a strict caller. The cache is also **bounded** (500 entries, oldest evicted) — it was an unbounded `Map` keyed by a tenant-influenced URL.
- **Discovery output is validated BEFORE it is persisted.** `discoverOIDCConfig` now calls `validateDiscoveredEndpoints` on the parsed document and throws if any of `authorization_endpoint` / `token_endpoint` / `userinfo_endpoint` / `jwks_uri` is missing, non-HTTPS, or SSRF-unsafe. POST `/providers` already catches discovery failure and creates the provider with NULL endpoints (`:538-541`) — that behavior is retained, so the failure mode is "provider is unusable until fixed", never "provider persists an attacker-controlled endpoint".
- **`tokenUrl` HTTPS is enforced** (SR2-14's sharpest edge: a malicious discovery document could make Breeze POST the **decrypted `client_secret`** in cleartext to a public HTTP host). `assertSafeOidcEndpoint` requires HTTPS via `isInternalUrl`, which only permits `http:` when `allowPrivateNetwork` is on (self-host, internal IdP).
- **Persisted endpoints are re-validated at RUNTIME** in `getOIDCConfig` — they are trusted blindly today, and `PATCH /providers/:id` can change `issuer` without re-running discovery, leaving `tokenUrl`/`jwksUrl` pointed at the old (or an attacker's) IdP. `getOIDCConfig` throws on a bad endpoint; the callback's existing `try/catch` turns that into a redirect, and the four non-callback call sites get an explicit `try/catch` → `400`.
- **`PATCH /providers/:id` re-runs discovery when `issuer` changes**, and on discovery failure **clears** the four endpoint columns rather than leaving stale ones pointing at the previous IdP. Fail closed: an admin who repoints the issuer gets a provider that must be re-discovered, not one that silently keeps talking to the old IdP.
- **Timeouts.** None of the four SSO `safeFetch` calls passes `timeoutMs` today. Discovery / token / userinfo get `OIDC_FETCH_TIMEOUT_MS = 10_000`; JWKS gets `OIDC_JWKS_TIMEOUT_MS = 5_000` (matching jose's own default so behavior is unchanged for a healthy IdP).
- **`safeFetch` gets a `maxBytes` bounded read — it has NO size cap today.** Verified: `services/urlSafety.ts:355-381` buffers the entire body (`res.on('data', c => chunks.push(c))` → `Buffer.concat(chunks)`) with no content-length check and no byte ceiling. `/sso/callback` is **unauthenticated**, so the moment JWKS routes through `safeFetch` (this task), a malicious or compromised IdP returning a multi-GB JWKS body becomes an **unauthenticated memory-exhaustion vector**. Adding `maxBytes?: number` to `SafeFetchInit` — accumulate, `req.destroy()` and throw on overrun — is ~10 lines in the one shared utility and immediately benefits **every** existing caller (webhooks, Pax8, SentinelOne, TD SYNNEX, DNS…). All four OIDC documents are small; give them `OIDC_MAX_RESPONSE_BYTES = 1 MiB`.
- **A port allowlist is explicitly OUT OF SCOPE.** There is none anywhere in the codebase today. Adding one would risk breaking legitimate IdPs served on nonstandard ports (self-hosted Keycloak/Authentik routinely are), and it is not the sharp risk here — the sharp risks are scheme (cleartext secret), destination IP (SSRF), and body size (memory exhaustion), all of which *are* closed. Say so plainly in the PR body rather than implying full coverage.
- **Do NOT build a third SSRF utility.** Everything here composes `safeFetch` (`urlSafety.ts`) and `isInternalUrl` (which already delegates its IP predicates to `urlSafety`). The `maxBytes` option **extends** `safeFetch`; it does not fork it.
- **The `#1105` tripwire is now load-bearing for SSO.** `safeFetch` calls `assertOutsideHeldDbContext('safeFetch')` (`urlSafety.ts:218`), which **throws** in CI/strict. Today's JWKS fetch uses jose's global fetch and is exempt from that guard; **after this task it is not.** `verifyIdTokenSignature` is called at `routes/sso.ts:1501`, outside any held DB context — so it is safe *today*, but that is now an invariant, not an accident. Step 1 adds a test that pins it (M4), so nobody later moves the call inside a `withSystemDbAccessContext` block and turns every SSO login into a 500.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/sso.test.ts` — add `describe('SSRF-safe OIDC transport (SR2-13/14)', …)`:

1. **`assertSafeOidcEndpoint` rejects `http://` in strict mode** and **accepts it when `allowPrivateNetwork`**; rejects `http://169.254.169.254/…`, `https://127.0.0.1/jwks`, `https://localhost/jwks`, and a missing URL; accepts `https://idp.example.com/jwks`.
2. **`validateDiscoveredEndpoints` throws when `token_endpoint` is `http://`** (the client-secret-in-cleartext case) and when `jwks_uri` points at a private IP; passes a fully-HTTPS public document.
3. **`discoverOIDCConfig` rejects a discovery document with an internal `jwks_uri`** — mock `safeFetch` (via `vi.mock('./urlSafety')`, spreading `importOriginal` so `SsrfBlockedError`/`isPrivateIp`/`isAlwaysBlockedIp` stay real) to return a JSON body whose `jwks_uri` is `http://10.0.0.5/jwks` → expect a throw, and expect the function **not** to return the document.
4. **`getIdTokenJwks` injects `safeFetch` into jose** — the load-bearing test. Assert on the options object passed to `createRemoteJWKSet` by mocking `jose`:
   ```ts
   vi.mock('jose', async (importOriginal) => {
     const actual = await importOriginal<typeof import('jose')>();
     return { ...actual, createRemoteJWKSet: vi.fn(() => async () => ({})) };
   });
   ```
   Then call `verifyIdTokenSignature` with a config carrying `jwksUrl` and assert:
   ```ts
   const opts = vi.mocked(createRemoteJWKSet).mock.calls[0]![1] as Record<PropertyKey, unknown>;
   expect(typeof opts[customFetch]).toBe('function');
   ```
   and — the real point — **invoke that function** with a private-IP URL and assert it rejects with `SsrfBlockedError`, proving jose's internal refresh path is guarded:
   ```ts
   const fetchImpl = opts[customFetch] as (u: string, o: Record<string, unknown>) => Promise<Response>;
   await expect(fetchImpl('http://169.254.169.254/jwks', {})).rejects.toThrow(SsrfBlockedError);
   ```
   Call `_resetIdTokenJwksCacheForTests()` in `beforeEach`.
5. **`verifyIdTokenSignature` rejects an internal `jwksUrl` before any fetch** — config with `jwksUrl: 'http://127.0.0.1/jwks'` → throws; `createRemoteJWKSet` **not** called.
6. **`exchangeCodeForTokens` refuses a plain-`http` `tokenUrl`** in strict mode → throws, and the mocked `safeFetch` is **never** called (the secret never leaves the process).
7. **Timeouts are passed** — assert the mocked `safeFetch` received `timeoutMs: 10_000` for discovery/token/userinfo.

`apps/api/src/routes/sso.test.ts` — add:

8. **`getOIDCConfig` re-validates persisted endpoints at runtime** — prime the callback's provider re-read with `tokenUrl: 'http://evil.example.com/token'` → the callback redirects to `/login?error=sso_failed` (the existing catch-all in the outer `try/catch`) and `exchangeCodeForTokens` is **never** called.
9. **`GET /login/:orgId` returns 400 for a provider with an unsafe persisted endpoint** (not an unhandled 500).
10. **M4 — the `#1105` tripwire is pinned.** `verifyIdTokenSignature` now runs inside `safeFetch`, which calls `assertOutsideHeldDbContext('safeFetch')` (throws in strict/CI). Assert that calling `verifyIdTokenSignature` **inside a held DB context** trips the tripwire, so nobody later moves the callback's call site (`routes/sso.ts:1501`, currently outside any context — safe) into a `withSystemDbAccessContext` block and turns every SSO login into a 500. In `services/sso.test.ts`, wrap the call in whatever the codebase's held-context test harness is (grep `assertOutsideHeldDbContext` for the existing pattern) and `await expect(...).rejects.toThrow(/safeFetch/)`.

`apps/api/src/services/urlSafety.test.ts` — add:

11. **`maxBytes` overrun destroys the socket and throws** — serve a body larger than `maxBytes` from the test HTTP server the suite already uses → `await expect(safeFetch(url, { maxBytes: 1024 })).rejects.toThrow(ResponseTooLargeError)`.
12. **A body under `maxBytes` still resolves normally**, and **`maxBytes` unset is unbounded** (no behavior change for existing callers).

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/sso.test.ts src/services/urlSafety.test.ts src/routes/sso.test.ts -t 'SR2-1'
cd apps/api && pnpm vitest run src/services/urlSafety.test.ts -t 'maxBytes'
```
Expected: **FAIL** — `maxBytes`/`ResponseTooLargeError` do not exist (the body read is unbounded); `assertSafeOidcEndpoint`/`validateDiscoveredEndpoints` do not exist; `createRemoteJWKSet` is called with **no** `customFetch`; `exchangeCodeForTokens` happily POSTs to `http://`.

- [ ] **Step 3: Implement — bounded body read in `services/urlSafety.ts`**

Add the error class next to `SsrfBlockedError` (`:23`):

```ts
/** The response body exceeded the caller's `maxBytes` ceiling. The socket is destroyed. */
export class ResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`response body exceeded maxBytes (${maxBytes})`);
    this.name = 'ResponseTooLargeError';
  }
}
```

Add the option to `SafeFetchInit` (`:190-197`):

```ts
  /**
   * Hard ceiling on the response body in bytes. On overrun the socket is
   * destroyed and ResponseTooLargeError is thrown — the partial body is never
   * buffered further. Unset = unbounded (legacy behavior for existing callers).
   *
   * safeFetch previously had NO size cap: it buffered whatever the remote sent.
   * That is an unauthenticated memory-exhaustion vector wherever a remote host
   * is attacker-influenced and the calling route is public — e.g. the SSO
   * callback's JWKS fetch.
   */
  maxBytes?: number;
```

Replace the body accumulation (`:360-363`):

```ts
      const chunks: Buffer[] = [];
      let received = 0;
      const maxBytes = init.maxBytes;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (maxBytes !== undefined && received > maxBytes) {
          req.destroy();
          reject(new ResponseTooLargeError(maxBytes));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const bodyBytes = Buffer.concat(chunks);
        // …unchanged Response construction below…
```

(`req` is the `http(s).request` handle already in scope at that point — confirm the identifier name before writing; the surrounding block already calls `res.on('error', reject)`.)

- [ ] **Step 3b: Implement — `services/sso.ts`**

Imports (`:1-3`):

```ts
import { randomBytes, createHash } from 'crypto';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { safeFetch, SsrfBlockedError, isPrivateIp, isAlwaysBlockedIp } from './urlSafety';
```

Add to `OIDCConfig` (`:9-18`):

```ts
export interface OIDCConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  jwksUrl?: string;
  scopes: string;
  /**
   * Self-host escape hatch for an internal IdP on an RFC1918 address / plain
   * HTTP. Resolved ONCE by getOIDCConfig from selfHostAllowsPrivateNetwork() —
   * never from a request-supplied value. Loopback/link-local/metadata stay
   * blocked either way (safeFetch's isAlwaysBlockedIp).
   */
  allowPrivateNetwork?: boolean;
}
```

Add the shared endpoint policy (place it directly after `isInternalUrl`, ~`:411`):

```ts
/** Wall-clock cap for provider-controlled OIDC fetches. None was set before (SR2-14). */
export const OIDC_FETCH_TIMEOUT_MS = 10_000;
/** JWKS cap — matches jose's own default so a healthy IdP sees no change. */
export const OIDC_JWKS_TIMEOUT_MS = 5_000;
/**
 * Body ceiling for every OIDC document (discovery, token, userinfo, JWKS). All
 * four are small; 1 MiB is orders of magnitude of headroom. safeFetch had NO size
 * cap, and /sso/callback is UNAUTHENTICATED — so a compromised IdP returning a
 * multi-GB JWKS would have been an unauthenticated memory-exhaustion vector the
 * moment JWKS started flowing through safeFetch (SR2-13).
 */
export const OIDC_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

/**
 * One policy gate for every endpoint we will either PERSIST from a discovery
 * document or USE at runtime (SR2-14). Enforces HTTPS (http only in self-host
 * mode) and rejects loopback/link-local/private/metadata targets, delegating the
 * IP predicates to urlSafety. This is the check that stops a malicious discovery
 * document from making Breeze POST the DECRYPTED client_secret in cleartext.
 */
export function assertSafeOidcEndpoint(
  label: string,
  urlStr: string | null | undefined,
  allowPrivateNetwork = false,
): void {
  if (!urlStr) {
    throw new Error(`OIDC endpoint missing: ${label}`);
  }
  if (isInternalUrl(urlStr, allowPrivateNetwork)) {
    throw new Error(`OIDC endpoint rejected (must be HTTPS and publicly routable): ${label}`);
  }
}

/**
 * Validate every endpoint a discovery document would cause us to persist,
 * BEFORE it is persisted. Discovery output was written verbatim with zero
 * validation (routes/sso.ts:527-542) — no scheme check, no private-IP check.
 */
export function validateDiscoveredEndpoints(
  doc: OIDCDiscoveryDocument,
  allowPrivateNetwork = false,
): void {
  assertSafeOidcEndpoint('authorization_endpoint', doc.authorization_endpoint, allowPrivateNetwork);
  assertSafeOidcEndpoint('token_endpoint', doc.token_endpoint, allowPrivateNetwork);
  assertSafeOidcEndpoint('userinfo_endpoint', doc.userinfo_endpoint, allowPrivateNetwork);
  assertSafeOidcEndpoint('jwks_uri', doc.jwks_uri, allowPrivateNetwork);
}
```

Replace the JWKS cache + `getIdTokenJwks` (`:266-281`):

```ts
// Cache one remote JWKS set per (policy, jwks_uri). jose refreshes on `kid` miss
// and on cacheMaxAge expiry, so this avoids re-fetching on every login.
//
// BOUNDED (SR2-13): the key is tenant-influenced (an admin picks the issuer), so
// an unbounded Map was a slow memory-growth vector. 500 entries is far beyond any
// realistic provider count; the oldest is evicted first (Map preserves insertion
// order).
const MAX_JWKS_CACHE_ENTRIES = 500;
const idTokenJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getIdTokenJwks(
  jwksUri: string,
  allowPrivateNetwork: boolean,
): ReturnType<typeof createRemoteJWKSet> {
  // The policy flag is part of the key: a self-host-permissive JWKS set must
  // never be served to a strict caller.
  const cacheKey = `${allowPrivateNetwork ? 'priv' : 'pub'}|${jwksUri}`;
  let jwks = idTokenJwksCache.get(cacheKey);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri), {
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes
      cooldownDuration: 30 * 1000,
      // SR2-13: inject the SSRF-safe transport into jose itself. A URL check at
      // construct time would NOT be enough — jose re-fetches the JWKS on its own
      // whenever a `kid` misses or cacheMaxAge expires, using its GLOBAL fetch
      // (undici): no scheme check, no private-IP check, no DNS pinning. Routing
      // those refreshes through safeFetch is the only way to satisfy the design's
      // "caching must not bypass transport validation on refresh".
      //
      // safeFetch(urlStr, init) is signature-compatible with jose's
      // FetchImplementation: (url: string, options) => Promise<Response>.
      [customFetch]: (url: string, options: Record<string, unknown>) =>
        safeFetch(url, {
          ...(options as object),
          timeoutMs: OIDC_JWKS_TIMEOUT_MS,
          maxBytes: OIDC_MAX_RESPONSE_BYTES, // unauthenticated route: cap the body
          allowPrivateNetwork,
        }),
    });

    if (idTokenJwksCache.size >= MAX_JWKS_CACHE_ENTRIES) {
      const oldest = idTokenJwksCache.keys().next().value;
      if (oldest !== undefined) idTokenJwksCache.delete(oldest);
    }
    idTokenJwksCache.set(cacheKey, jwks);
  }
  return jwks;
}
```

In `verifyIdTokenSignature` (`:298-329`), replace the head:

```ts
export async function verifyIdTokenSignature(
  idToken: string,
  config: OIDCConfig,
  nonce: string
): Promise<IDTokenClaims> {
  if (!config.jwksUrl) {
    throw new Error('Cannot verify ID token signature: provider has no JWKS URL configured');
  }

  const allowPrivateNetwork = config.allowPrivateNetwork ?? false;
  // Reject the URL before jose ever constructs a key set for it (SR2-13). The
  // customFetch injection below covers every actual request, including jose's
  // internal refreshes; this is the cheap up-front rejection.
  assertSafeOidcEndpoint('jwks_uri', config.jwksUrl, allowPrivateNetwork);

  const jwks = getIdTokenJwks(config.jwksUrl, allowPrivateNetwork);
  // …unchanged jwtVerify + nonce check below…
```

In `exchangeCodeForTokens` (`:117-146`), before building the body:

```ts
export async function exchangeCodeForTokens(params: TokenExchangeParams): Promise<OIDCTokenResponse> {
  const { config, code, redirectUri, codeVerifier } = params;

  // SR2-14: this request carries the DECRYPTED client_secret. A malicious or
  // compromised discovery document could point token_endpoint at a plain-HTTP
  // public host and exfiltrate it in cleartext. Refuse before the body is built.
  const allowPrivateNetwork = config.allowPrivateNetwork ?? false;
  assertSafeOidcEndpoint('token_endpoint', config.tokenUrl, allowPrivateNetwork);
  // …existing body construction…
```
and the fetch:
```ts
  const response = await safeFetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString(),
    timeoutMs: OIDC_FETCH_TIMEOUT_MS,
    maxBytes: OIDC_MAX_RESPONSE_BYTES,
    allowPrivateNetwork,
  });
```

Apply the same additions (`assertSafeOidcEndpoint` + `timeoutMs` + `maxBytes` + `allowPrivateNetwork`) to `getUserInfo` (`:152-168`, label `'userinfo_endpoint'`, `config.userInfoUrl`) and `refreshAccessToken` (`:174-196`, label `'token_endpoint'`, `config.tokenUrl` — dead code today but must not become a live hole later).

In `discoverOIDCConfig` (`:424-460`), replace the return:

```ts
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status}`);
  }

  const doc = (await response.json()) as OIDCDiscoveryDocument;
  // SR2-14: validate BEFORE the caller persists these. Discovery output was
  // written to sso_providers verbatim with zero validation.
  validateDiscoveredEndpoints(doc, allowPrivateNetwork);
  return doc;
```
and add `timeoutMs: OIDC_FETCH_TIMEOUT_MS, maxBytes: OIDC_MAX_RESPONSE_BYTES` to its `safeFetch` init.

- [ ] **Step 4: Implement — `routes/sso.ts`**

Extend the `'../services/sso'` import to add `assertSafeOidcEndpoint`.

Replace `getOIDCConfig` (`:290-307`):

```ts
function getOIDCConfig(provider: typeof ssoProviders.$inferSelect): OIDCConfig {
  const decryptedClientSecret = decryptForColumn('sso_providers', 'client_secret', provider.clientSecret);

  if (!provider.clientId || !decryptedClientSecret || !provider.issuer) {
    throw new Error('Provider is not fully configured');
  }

  // Resolved ONCE here, from deployment config — never from a request value.
  const allowPrivateNetwork = selfHostAllowsPrivateNetwork();

  const config: OIDCConfig = {
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: decryptedClientSecret,
    authorizationUrl: provider.authorizationUrl || `${provider.issuer}/authorize`,
    tokenUrl: provider.tokenUrl || `${provider.issuer}/oauth/token`,
    userInfoUrl: provider.userInfoUrl || `${provider.issuer}/userinfo`,
    jwksUrl: provider.jwksUrl || undefined,
    scopes: provider.scopes || 'openid profile email',
    allowPrivateNetwork
  };

  // SR2-14: RE-VALIDATE persisted endpoints at runtime. They were trusted
  // blindly: discovery wrote them verbatim, and PATCH can change `issuer`
  // WITHOUT re-running discovery, so tokenUrl/jwksUrl could still point at the
  // previous (or an attacker's) IdP. The `${issuer}/…` string-concat fallbacks
  // above are validated by the same gate.
  assertSafeOidcEndpoint('authorization_endpoint', config.authorizationUrl, allowPrivateNetwork);
  assertSafeOidcEndpoint('token_endpoint', config.tokenUrl, allowPrivateNetwork);
  assertSafeOidcEndpoint('userinfo_endpoint', config.userInfoUrl, allowPrivateNetwork);
  if (config.jwksUrl) {
    assertSafeOidcEndpoint('jwks_uri', config.jwksUrl, allowPrivateNetwork);
  }

  return config;
}
```

`getOIDCConfig` now throws for an unsafe persisted endpoint. The **callback** call site (`~:1470`) is already inside the big `try { … } catch` → it becomes the existing `sso_failed` redirect. The other four call sites are **not** in a try block and would surface as an unhandled 500. Wrap each:

- `POST /sso/link/start/:providerId` (`~:1090`)
- `GET /sso/login/partner/:partnerId` (`~:1219`)
- `GET /sso/login/:orgId` (`~:1317`)
- `POST /providers/:id/test` (`~:2105` — confirm the exact line with `grep -n "getOIDCConfig(" apps/api/src/routes/sso.ts`)

```ts
  let config: OIDCConfig;
  try {
    config = getOIDCConfig(provider);
  } catch (err) {
    console.warn(`[sso] provider ${provider.id} has an invalid configuration:`, err);
    return c.json({ error: 'SSO provider configuration is invalid' }, 400);
  }
```
(The `/test` route already relays a message to the UI — return its message verbatim there, matching its existing shape.)

**POST `/providers`** — the discovery block (`:527-542`) needs no change *in shape*: `discoverOIDCConfig` now throws on an unsafe document, the existing `catch` logs and leaves the endpoint columns NULL, and the provider is created unusable-until-fixed. Upgrade the log so the failure is observable:

```ts
    } catch (error) {
      // Discovery failed OR returned endpoints that failed SSRF/HTTPS validation
      // (SR2-14). Either way we persist NO endpoints — an unusable provider is
      // strictly better than one pointing at an attacker-controlled endpoint.
      console.warn('OIDC discovery failed or was rejected:', error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
```
(`captureException` is already imported at `sso.ts:39`.)

**PATCH `/providers/:id`** — re-run discovery when `issuer` changes. Insert immediately before the `updates` object is built (`:630`). This requires selecting `issuer` and `type` on the `existing` read (`:601-605`) — extend that select's field list:

```ts
  // SR2-14: repointing the issuer WITHOUT re-discovery leaves tokenUrl/jwksUrl
  // aimed at the OLD IdP (or, with a crafted discovery doc, an attacker's).
  // Re-discover; if that fails or is rejected, CLEAR the endpoints (fail closed)
  // rather than keep stale ones. The provider is unusable until it is fixed —
  // which is the correct outcome for a half-repointed IdP.
  const issuerChanged = body.issuer !== undefined && body.issuer !== existing.issuer;
  const rediscovered: Partial<typeof ssoProviders.$inferInsert> = {};
  if (issuerChanged && (body.type ?? existing.type) === 'oidc') {
    try {
      const discovery = await discoverOIDCConfig(body.issuer!, {
        allowPrivateNetwork: selfHostAllowsPrivateNetwork()
      });
      rediscovered.authorizationUrl = discovery.authorization_endpoint;
      rediscovered.tokenUrl = discovery.token_endpoint;
      rediscovered.userInfoUrl = discovery.userinfo_endpoint;
      rediscovered.jwksUrl = discovery.jwks_uri;
    } catch (error) {
      console.warn(`[sso] re-discovery failed for provider ${providerId} after issuer change:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)));
      rediscovered.authorizationUrl = null;
      rediscovered.tokenUrl = null;
      rediscovered.userInfoUrl = null;
      rediscovered.jwksUrl = null;
    }
  }
```
and fold it into `updates`. **This is the CANONICAL final form of that object** (Task 3 added the stamp, Task 4 the version bump, Task 7 the re-discovery):

```ts
  const updates: Partial<typeof ssoProviders.$inferInsert> = {
    ...body,
    ...rediscovered,                                                            // Task 7 (must come AFTER ...body so it overrides stale endpoints)
    updatedAt: new Date(),
    ...(body.defaultRoleId ? { defaultRoleConfiguredBy: auth.user.id } : {}),   // Task 3
    configVersion: sql`${ssoProviders.configVersion} + 1` as unknown as number, // Task 4
  };
```

- [ ] **Step 5: Run to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/urlSafety.test.ts src/services/sso.test.ts src/routes/sso.test.ts
```
Expected: **PASS** (whole files). `urlSafety.test.ts` must be fully green — `maxBytes` is unset for every existing caller, so their behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/urlSafety.ts apps/api/src/services/urlSafety.test.ts apps/api/src/services/sso.ts apps/api/src/services/sso.test.ts apps/api/src/routes/sso.ts apps/api/src/routes/sso.test.ts
git commit -m "feat(sso): SSRF-safe JWKS via jose customFetch; bounded safeFetch body reads; validate discovery output before persisting and persisted endpoints at runtime; enforce HTTPS on tokenUrl; add timeouts (SR2-13, SR2-14)"
```

---

### Task 8: Integration tests + verification gate

**Files:**
- Create: `apps/api/src/__tests__/integration/ssoHardening.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/ssoSessionsRls.integration.test.ts`

**Interfaces:**
- Consumes: everything above; the integration harness (`__tests__/integration/db-utils.ts`) and real Postgres on **:5433**. Model the app bootstrap + provider/user seeding on **`apps/api/src/__tests__/integration/ssoPartnerLogin.integration.test.ts`** (850+ lines): it mounts the REAL `ssoRoutes` against the RLS-enforced pool and mocks **only** `exchangeCodeForTokens` / `getUserInfo` / `verifyIdTokenSignature` via `vi.mock('../../services/sso', async (importOriginal) => ({ ...(await importOriginal()), … }))`, and sets `APP_ENCRYPTION_KEY` at module top (required by the state-cookie HMAC). **Reuse that spread-importOriginal shape** — a full factory would strip `readEmailVerifiedClaim` / `assertSafeOidcEndpoint`.
- Model the RLS forge on `ssoProvidersPartnerRls` / `ssoVerifiedDomainsRls`. **Beware the memoized-fixture trap:** if the forge helper is memoized across tests it can vacuously pass — assert the *specific* Postgres error code, not merely "it threw".

- [ ] **Step 1: Write `ssoSessionsRls.integration.test.ts`**

Prove the Task-1 policy is real, not decorative:

1. **Cross-scope SELECT is denied.** Insert an `sso_sessions` row under `withSystemDbAccessContext`. Then, under an **org-scoped** DB context (`withDbAccessContext` for a seeded org), `SELECT * FROM sso_sessions WHERE state = …` → **0 rows** (FORCE RLS + system-only policy ⇒ the row is invisible, not an error).
2. **Cross-scope INSERT is denied with `42501`.** Under an org-scoped context, forge `INSERT INTO sso_sessions (provider_id, state, nonce, expires_at) VALUES (…)` → must fail with **`new row violates row-level security policy`** (SQLSTATE `42501`). Assert on the code/message, not just `.rejects.toThrow()`.
3. **Cross-scope DELETE is a no-op.** Under an org-scoped context, `DELETE FROM sso_sessions WHERE state = …` → 0 rows affected, and the row still exists when re-read under system context (this is the property that stops a tenant from burning another tenant's pending state).
4. **System context can do all three.**
5. **C1 — `DELETE /providers/:id` fully succeeds with both blockers present.** This is the proof that Task 1's RLS did not brick provider deletion. Seed an org-axis provider; then create **(a)** a pending `sso_sessions` row for it (unexpired) and **(b)** a `user_sso_identities` row belonging to a **different** user than the deleting admin. Call the real `DELETE /providers/:id` route as an authorized org admin → **200**, and assert in system context that the provider row, the session row, **and the other user's identity row** are all gone. If this fails with FK violation **23503** or leaves rows behind, the corresponding delete is still 0-rowing under RLS — wrap it in system context (Task 1 Step 5b already wraps both; this test is what confirms it, since `user_sso_identities` is `USER_ID_SCOPED` (`breeze_current_user_id()`) and may have been silently 0-rowing for other users' rows **even before this PR**).

- [ ] **Step 2: Write `ssoHardening.integration.test.ts`**

Five real-Postgres proofs, one per hardening layer:

1. **Provider disabled mid-flow → callback rejects.** Seed an active org-axis OIDC provider + a user linked by `(provider, sub)`. Drive `GET /sso/login/:orgId` to create a real `sso_sessions` row (capture `state` + the `Set-Cookie`). Then `UPDATE sso_providers SET status='inactive', config_version = config_version + 1`. Then `GET /sso/callback?code=…&state=…` with the cookie → **302 to `/login?error=sso_provider_inactive`**, and assert **no** new `refresh_token_families` row was minted for the user.
2. **Config change → version bump invalidates a pending session.** Same setup, but instead `PATCH /providers/:id` (through the real route, as an authorized admin — or `UPDATE sso_providers SET config_version = config_version + 1` if the route auth fixture is heavy) leaving `status='active'`. Callback → **302 to `/login?error=sso_config_changed`**. Also assert the `sso_sessions` row is **gone** (the atomic claim burned it) — a rejected session must not be retryable.
3. **Logout invalidates a pending link.** Seed a user with a live `refresh_token_families` row (`family_id = F`, `revoked_at IS NULL`). Insert a link `sso_sessions` row bound to `{ linkUserId: u, initiatingAuthEpoch: e.auth, initiatingMfaEpoch: e.mfa, initiatingSessionId: F, providerVersion: p.config_version }`. Then `UPDATE refresh_token_families SET revoked_at = now() WHERE family_id = F` (what logout does durably). Drive the callback → **302 to `/settings/profile?ssoLinkError=session_invalid`**, and assert **no `user_sso_identities` row** was created. Repeat the same assertion for an `auth_epoch` bump (`UPDATE users SET auth_epoch = auth_epoch + 1`) — this is the password-reset / suspension / global-revocation path.
4. **Domain-ownership gate on auto-link.** Seed an org-axis provider, a **passwordless** user in the org with email `alice@corp.example` and **no** `(provider, sub)` link, and **no** verified domain for the org. Drive a callback whose id_token omits `email_verified` and whose email is `alice@corp.example` → **302 to `/login?error=sso_email_unverified`**, and assert **no `user_sso_identities` row**. Then insert a verified `sso_verified_domains` row for `corp.example` and re-drive → the auto-link **succeeds** (a `user_sso_identities` row appears) — proving the gate is the domain, not a blanket refusal.
5. **JIT default-role ceiling (SR2-10) fires against real permission rows.** Seed an org-axis provider with `auto_provision=true`, `default_role_configured_by = adminUser`, and a `default_role_id` pointing at an org role that holds a permission the admin does **not** hold. Drive a callback for a brand-new email (with a verified domain so Test 4's gate passes) → **302 to `/login?error=invalid_provider_configuration`** and **no new `users` row**. Then grant the admin that permission and re-drive → the user **is** provisioned.
6. **C2 — a PARTNER ADMIN with NO org membership can configure a working org-axis provider.** This is the case Test 5 cannot catch (it seeds an org member) and that the Task-3 unit tests cannot catch (they mock `roleAssignment` wholesale). Seed a partner, an org under it, and a **partner admin** who has a `partner_users` row (with `orgAccess`) and **NO `organization_users` row**. Create an org-axis provider with `default_role_configured_by = thatPartnerAdmin` and a `default_role_id` whose permissions are **within** their ceiling. Drive a JIT callback for a brand-new email → **the user IS provisioned** (302 to the success path, a new `users` + `organization_users` row). If this reds with `/login?error=invalid_provider_configuration`, `getUserPermissions` was called with only `{ orgId }` and returned `null` — the single-axis bug. This is the **normal MSP topology**, so this test is the regression guard for "every JIT sign-in fails forever".
7. **`default_role_configured_by` repair path (SR2-10 / C3).** Seed a provider whose `default_role_configured_by` names a user who has since been **suspended / stripped of the permission**. Drive a JIT callback → rejected. Then `PATCH /providers/:id` re-setting the same `defaultRoleId` as a **current, adequately-permissioned admin** → assert the column is re-stamped, and re-drive the callback → the user **is** provisioned. (This proves the offboarded-configurer deadlock is repairable without recreating the provider, which would orphan every `user_sso_identities` row.)
8. **Unknown configurer → JIT proceeds, ceiling-skipped audit is written (I1).** Seed a provider with `default_role_configured_by = NULL` **and** `created_by = NULL` (the legacy shape) and a structurally-valid `default_role_id`. Drive a JIT callback → the user **is** provisioned, **and** an `audit_logs` row exists with `action = 'sso.callback.jit_ceiling_skipped'`. This is the one path where the permission ceiling is not applied; if it is not auditable, it is not acceptable.

- [ ] **Step 2b: Update `ssoPartnerLogin.integration.test.ts` fixtures (M2)**

This pre-existing real-DB SSO suite is the most likely casualty of Tasks 4-7 and **this plan explicitly authorizes editing it**:
- Its seeded `sso_providers` rows need `config_version` (the column default handles it — confirm the seed helper doesn't `INSERT` an explicit column list that omits it in a way that breaks).
- Its seeded/driven `sso_sessions` rows need **`provider_version` matching the provider's `config_version`**, or Task 4's gate rejects every one of its callbacks with `sso_config_changed`.
- If any of its providers are seeded with a `status` other than `'active'`, the login-mode gate now rejects them.
- Its `vi.mock('../../services/sso', …)` must keep the `importOriginal` spread (a full factory would strip `readEmailVerifiedClaim` / `assertSafeOidcEndpoint`).

Make these edits **as part of this task** and run the suite; do not treat its failures as flakes.

- [ ] **Step 3: Run the integration suites**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ssoSessionsRls.integration.test.ts \
  src/__tests__/integration/ssoHardening.integration.test.ts \
  src/__tests__/integration/ssoPartnerLogin.integration.test.ts
```
Expected: **PASS**. Requires the integration Postgres on **:5433** (single-fork; the harness runs `autoMigrate` on it, which applies the new `2026-07-16-*` migration). `ssoPartnerLogin.integration.test.ts` is included deliberately — it is the pre-existing real-DB SSO suite and is the most likely thing Tasks 4-7 broke (its seeded providers now need `config_version`, and its sessions need `provider_version`).

**TDD discipline:** briefly revert one production line (e.g. the `checkProviderGeneration` call) and observe the corresponding test fail for the reviewed reason before restoring it.

- [ ] **Step 4: Commit the integration tests**

```bash
git add apps/api/src/__tests__/integration/ssoSessionsRls.integration.test.ts apps/api/src/__tests__/integration/ssoHardening.integration.test.ts apps/api/src/__tests__/integration/ssoPartnerLogin.integration.test.ts
git commit -m "test(sso): real-DB coverage for provider generation, link binding, domain gate, JIT ceiling, sso_sessions RLS"
```

- [ ] **Step 5: Full verification gate**

Typecheck + build (Type Check includes test files):
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm typecheck && pnpm build
```
Expected: no type errors; build succeeds. (`tsc` is OOM-prone project-wide — if it dies, re-run; do not "fix" it by loosening types.)

Focused serial unit/route suites — **every file this PR touched, named explicitly** (the API suite is parallel-flaky):
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run \
  src/services/roleAssignment.test.ts \
  src/services/urlSafety.test.ts \
  src/services/sso.test.ts \
  src/routes/sso.test.ts \
  src/routes/users.test.ts \
  src/routes/auth/ssoPolicy.test.ts \
  src/services/ssoDomainVerification.test.ts
```
Expected: **PASS**.

Web (Task 6 Step 5 touched `ConnectSsoCard`):
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
pnpm test --filter=@breeze/web -- ConnectSsoCard
```
Expected: **PASS** — including the repointed `session_invalid` case and the three new arms.

Migration drift (a migration **was** added — this must still be clean):
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && pnpm db:check-drift
```
Expected: **no drift** (the Drizzle schema in `db/schema/sso.ts` matches `2026-07-16-sso-session-binding-and-provider-version.sql` exactly). Drift here almost always means a column type or nullability mismatch — fix the *schema*, never by editing the shipped migration.

Migration ordering regression test + RLS suite + integration:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/db/autoMigrate.test.ts && \
  pnpm vitest run --config vitest.config.rls.ts && \
  pnpm vitest run --config vitest.integration.config.ts \
    src/__tests__/integration/rls-coverage.integration.test.ts \
    src/__tests__/integration/ssoSessionsRls.integration.test.ts \
    src/__tests__/integration/ssoHardening.integration.test.ts \
    src/__tests__/integration/ssoPartnerLogin.integration.test.ts \
    src/__tests__/integration/ssoProvidersPartnerRls.integration.test.ts \
    src/__tests__/integration/tenantCascadeSso.integration.test.ts
```
Expected: **PASS**. `tenantCascadeSso` is included because Task 1 adds a FK-free `initiating_session_id` column — confirm the cascade sweep is unaffected.

Idempotency check (re-applying the migration must be a no-op):
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
docker exec -i breeze-postgres psql -U breeze -d breeze -f - < apps/api/migrations/2026-07-16-sso-session-binding-and-provider-version.sql
```
Expected: no errors, no duplicate-object failures (the DELETE reports 0 rows the second time).

- [ ] **Step 6: STOP — do not open the PR**

The controller opens the PR after a whole-branch review. Push the branch and report:

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
git push -u origin core-auth-3-sso-oidc
```

Report to the controller: the gate output, plus these items, **all of which must appear in the PR body**:

**Known gaps (deliberate, documented):**
1. **Partner-axis domain verification does not exist** — `sso_verified_domains.org_id` is `NOT NULL`, so SR2-12's absent-claim gate is **org-axis only**; the partner axis keeps today's absent-claim tolerance. Follow-up: make `sso_verified_domains` dual-axis (PARTNER-WIDE FIRST).
2. **No resolvable configurer ⇒ structural-only JIT re-validation** (legacy rows with both `default_role_configured_by` and `created_by` NULL). Loudly audited (`sso.callback.jit_ceiling_skipped`); repair = re-save the default role as a current admin.
3. **No port allowlist** (SR2-14). Explicitly out of scope — it would risk breaking legitimate self-hosted IdPs on nonstandard ports, and the sharp risks (scheme, destination IP, body size) are all closed. **Do not let the PR body imply full SR2-14 coverage.**

**Operational notes:**
4. The migration **purges in-flight `sso_sessions`** — a ≤10-minute window of interrupted SSO round-trips at deploy (and PR 1 already forces a global sign-out on this branch).
5. **`DELETE /providers/:id` was silently broken-in-waiting**: enabling RLS on `sso_sessions` would have made its cleanup delete 0-row and the FK-uncascaded provider delete then 500. Fixed here and proved with a real-DB test — call it out so reviewers know why that route changed.
6. **`safeFetch` gained a `maxBytes` bounded read** — a shared-utility change that touches every outbound-fetch caller in the repo (opt-in; unset = unchanged). Flag it for a wider look than the SSO diff.

---

## Self-Review

**Spec coverage (PR 3 scope, SR2-10 … SR2-14):**

| Finding | Design-doc requirement | Task |
|---|---|---|
| **SR2-10** | "SSO provider default-role configuration uses the same assignable-role and permission-subset validation as normal user administration." | Task 2 (extract the canonical validator) + Task 3 (apply at config time on **both** axes — the org axis validated nothing) |
| **SR2-10** | "Validation runs when configuration is saved **and again immediately before JIT provisioning**." | Task 3 (`revalidateSsoDefaultRole` against the configurer's live ceiling) |
| **SR2-10** | "JIT remains limited to the provider's own partner/organization axis." | Already true (`provisionOrgId = provider.orgId!`) — asserted, not rebuilt |
| **SR2-11** | "SSO providers gain a monotonic configuration version. Pending SSO sessions store provider ID/version." | Task 1 (schema) + Task 4 (bump + snapshot) |
| **SR2-11** | "Callback … rejects **inactive providers**, version mismatch…" | Task 4 (`checkProviderGeneration`; status was **never** checked before) |
| **SR2-11** | "Account-link sessions additionally store initiating user ID, auth epoch, and `session_id`." | Task 1 (schema) + Task 5 (capture at `/link/start`) |
| **SR2-11** | "Callback … rejects … auth-epoch mismatch, a revoked/expired initiating refresh family, tenant mismatch, or expired/consumed state." | Task 5 (`validateLinkBinding`) |
| **SR2-11** | "Logout invalidates link transactions through their bound refresh family; password reset, email change, status change, and global session revocation invalidate them through auth-epoch or family mismatch." | Task 5 + Task 8 proof #3 |
| **SR2-12** | "Explicit `email_verified=false` is always rejected." | Task 6 (now also on the **userinfo** path, which had zero readers) |
| **SR2-12** | "Missing verification is rejected unless an explicit provider adapter documents and enforces an equivalent guarantee." | Task 6 (absent ⇒ org-domain ownership proof via `isDomainVerifiedForOrg`) — **org axis only; partner axis is a documented gap** |
| **SR2-12** | "Auto-linking remains passwordless-only and subject to verified-domain ownership." | Task 6 (passwordless-only already true; domain gate now covers auto-link, plus the missing org clamp) |
| **SR2-13** | "Discovery and JWKS retrieval share one SSRF-safe transport… JWKS caching must not bypass transport validation on refresh." | Task 7 (`safeFetch` injected into jose via `customFetch` — construct-time-only would miss jose's refresh-on-`kid`-miss) |
| **SR2-14** | "Persisted endpoints are revalidated at runtime." | Task 7 (`getOIDCConfig` gate) |
| **SR2-14** | DNS + connection-time IP validation; loopback/link-local/private/metadata denial; redirect limits | **Already provided by `safeFetch`** (resolves once and *pins* the validated IP; follows **no** redirects; blocks every non-public range incl. IPv4-mapped IPv6). Asserted, not rebuilt. |
| **SR2-14** | HTTPS enforcement | **NEW (Task 7)** — `assertSafeOidcEndpoint` on `tokenUrl` / `userInfoUrl` / `jwksUrl` / `authorizationUrl`, applied pre-persist, at runtime, and pre-fetch |
| **SR2-14** | Time limits | **NEW (Task 7)** — none of the four SSO `safeFetch` calls passed `timeoutMs` before |
| **SR2-14** | **Response-size limits** | **NEW (Task 7) — `safeFetch` had NO size cap.** It buffered the whole body (`urlSafety.ts:355-381`). Task 7 adds `maxBytes` to `SafeFetchInit` (bounded read → `req.destroy()` + `ResponseTooLargeError`) and gives the OIDC calls 1 MiB. Without this, routing JWKS through `safeFetch` would have turned the **unauthenticated** `/sso/callback` into a memory-exhaustion vector. |
| **SR2-14** | **Allowed ports** | ❌ **NOT IMPLEMENTED — explicitly out of scope.** No port allowlist exists anywhere in the codebase, and adding one risks breaking legitimate self-hosted IdPs on nonstandard ports. The sharp risks (scheme → cleartext secret; destination IP → SSRF; body size → OOM) are all closed. **Must be stated plainly in the PR body — do not imply full coverage.** |
| Contract | "Any new Postgres table/column … declares an RLS tenancy shape and registers in the rls-coverage allowlists in the same PR." | Task 1 (`sso_sessions` → ENABLE + FORCE + system-only policy, `INTENTIONAL_UNSCOPED` + a bespoke enforcing test) |
| Regression | Enabling RLS on `sso_sessions` must not break the two authenticated bare-`db` writers | Task 1 Step 5a/5b (link-start INSERT + `DELETE /providers/:id` cleanup DELETEs) + Task 8 real-DB proof #5 |
| Regression | New public link-error codes must render in the UI | Task 6 Step 5 (`ConnectSsoCard` `LINK_ERROR_KEYS` + i18n + tests) |
| Verification | Node 22 build/typecheck, focused serial Vitest (API **and web**), migration drift, real-DB RLS/integration | Task 8 |

**Decisions documented inline (nothing deferred to the reader):**
- **Migration filename** `2026-07-16-sso-session-binding-and-provider-version.sql` — sorts after `2026-07-15-auth-epochs-and-family-expiry.sql`; no `-a-`/`-b-` infix needed (Task 1).
- **Column names/types/nullability:** `sso_providers.config_version INTEGER NOT NULL DEFAULT 1`; `sso_sessions.provider_version / initiating_auth_epoch / initiating_mfa_epoch INTEGER NULL`, `initiating_session_id UUID NULL` (= `refresh_token_families.family_id` = the JWT `sid`). All four nullable **because login sessions have no initiating user** (Task 1).
- **Login vs link mode** is `session.linkUserId != null` (unchanged); the `initiating_*` columns are read only in the link branch (Task 1/5).
- **NULL ⇒ reject, not default-to-1** — backfilling would bless exactly the unbound sessions this PR invalidates. The migration purges them and reports the count (Task 1).
- **`sso_sessions` RLS list:** `INTENTIONAL_UNSCOPED` (system-scope-only shape, alongside `partner_abuse_signals` / `software_product_resolutions`), **not** `EXEMPT_TABLES` (which only silences `org_id` auto-discovery, and `sso_sessions` has no `org_id`) and not any of the six tenant shapes (it satisfies none). Because neither list *asserts* anything, a bespoke enforcing `it(...)` is added to the contract file (Task 1).
- **BOTH authenticated bare-`db` writers to `sso_sessions` move to `withSystemDbAccessContext`** — `/sso/link/start`'s INSERT **and `DELETE /providers/:id`'s cleanup DELETEs (`sso.ts:690-691`)**. The second is the dangerous one: the FK has no cascade, so a silently-0-rowing session delete makes provider deletion die with FK violation 23503. `user_sso_identities` (USER_ID_SCOPED) is wrapped alongside it, with a real-DB assertion in Task 8 rather than an assumption (Task 1 Step 5, Task 8 proof #5).
- **`sso_providers.default_role_configured_by` is the JIT principal**, not `created_by` — `created_by` names the original creator (≠ the config-time caller) and is never rewritten, so an offboarded creator would brick JIT with no repair short of recreating the provider (which orphans every `user_sso_identities` row, since `(provider_id, external_id)` is the identity key). Stamped by every write that sets `defaultRoleId`; falls back to `created_by`, then to structural-only (Tasks 1, 3).
- **The JIT configurer's permissions are resolved on BOTH axes** (`{ orgId, partnerId: <org's owning partner> }`). Single-axis `{ orgId }` runs only `resolveOrgAxis` (`permissions.ts:187-193`), which needs an `organization_users` row — which an **MSP partner admin has not got**. That would fail JIT forever on the normal MSP topology (Task 3; integration proof = Task 8 #6).
- **The unknown-configurer fallback is LOUDLY AUDITED** (`sso.callback.jit_ceiling_skipped`, a real `writeRouteAudit`, not a `console.warn`) — it is the one path where the permission ceiling is not applied (Task 3; proof = Task 8 #8).
- **The email_verified attestation is bound to the MAPPED address.** On the userinfo path, `attributeMapping.email` is admin-set jsonb and may name `upn`/`preferred_username`, while userinfo's `email_verified` attests userinfo.`email` — a different address. The claim counts only when the mapping key is literally `email` or the mapped value equals `userInfo.email`; otherwise it is `'absent'` and falls into the domain-ownership gate (Task 6).
- **`safeFetch` gains a `maxBytes` bounded read** (shared utility, benefits every caller); a **port allowlist is explicitly out of scope** (Task 7).
- **`validateAssignableRole`'s side-effect ORDER is preserved** — empty effective-permission set short-circuits BEFORE the caller is resolved, or a permission-less role would newly open a system transaction (`permissions.ts:135`) it never used to (Task 2).
- **`AuthLike.scope` is REQUIRED**, not optional — `validateProviderDefaultRole` branches on `auth.scope === 'system'` and must not silently read `undefined` (Task 2).
- **Web arm shipped in-PR** for the four new / one retired `ssoLinkError` codes; `user_gone` is removed as an account-state oracle (Task 6 Step 5).
- **Do NOT cherry-pick Task 1 alone to a droplet** — Task 4 supplies the `provider_version` writers (Global Constraints).
- **Callback status policy per mode:** login requires `active`; link requires `!== 'inactive'` — each mirrors its own init gate, so a `testing` provider can still complete a link it was allowed to start (Task 4).
- **JIT ceiling = the provider's configuring admin (`created_by`), live.** `created_by IS NULL` ⇒ structural-only re-validation + warning, not a hard fail (would break every legacy provider). **Reviewer: challenge this.** (Task 3)
- **System-scope callers skip the ceiling, keep the structural check** — a platform admin has no tenant permission set to compare against (Task 3).
- **Org clamp is membership-bounded (`inArray` over `organization_users`), not `eq(users.orgId, …)`** — a column clamp would break legitimate multi-org users (Task 6).
- **Absent-claim domain gate is ORG AXIS ONLY.** `sso_verified_domains.org_id` is `NOT NULL`; there is no partner-axis domain machinery, and gating the partner axis would reject every partner-axis Entra login. Partner axis has no JIT and already clamps hard. **Known gap; follow-up = make `sso_verified_domains` dual-axis (PARTNER-WIDE FIRST).** Must appear in the PR body (Task 6).
- **A construct-time JWKS URL check is insufficient** — jose refetches internally on `kid` miss / cache expiry through its global fetch. `customFetch` injection is the only sufficient fix (Task 7).
- **Audit `action`/`result` strings:** `sso.callback.rejected` (`result: 'denied'`, `details: { mode, phase, reason, partnerId, sessionVersion, providerVersion, claimSource, emailDomain }`) and `sso.identity.link_rejected` (`result: 'denied'`, `details: { reason, publicCode, partnerId, userId }`). Existing `sso.identity.link_started` / `sso.identity.linked` / `sso.provider.create` / `.update` / `.status.update` are unchanged. **Reason codes:** `provider_inactive`, `provider_not_usable`, `provider_version_missing`, `provider_version_mismatch`, `link_binding_missing`, `link_user_gone`, `link_user_inactive`, `link_epochs_unavailable`, `link_auth_epoch_mismatch`, `link_mfa_epoch_mismatch`, `link_family_missing`, `link_family_revoked`, `link_family_expired`, `link_axis_membership_lost`, `email_verified_false`, `email_verified_absent_domain_unverified`, `default_role_not_on_provider_axis`, `default_role_structure_invalid`, `default_role_exceeds_configurer_permissions`, `provider_axis_missing`. **None contains `state`, `code`, `code_verifier`, an id/access/refresh token, or a client secret** — only ids, reason strings, email *domains*, and version integers (Tasks 3-6).
- **Public redirect codes** (generic but distinguishable, following the existing convention): login → `sso_provider_inactive`, `sso_config_changed`, `sso_email_unverified`, plus the existing `invalid_provider_configuration`, `sso_domain_unverified`, `sso_link_required`, `invite_required`, `session_expired`, `sso_failed`. Link → `provider_inactive`, `config_changed`, `session_invalid`, `email_unverified`, plus the existing `email_mismatch`, `identity_in_use`. **`user_gone` is retired from the link surface** (folded into `session_invalid`) because it was an account-state oracle (Tasks 4-6).

**Placeholder scan:** every implementation step contains real, complete code. **No open choices remain** — Task 3's config-time rejection is pinned to **400** (matching the route's existing `defaultRoleId must be a…` style); the earlier "403 (or 400 — pick one)" is gone. The test steps that say "model on `<file>`" (Task 8's integration bootstrap; the `sso.test.ts` mock-queue re-ordering in Tasks 3/5/6) name the exact file, the exact helper (`primeLinkCallback`, `ssoStateCookieHeader`), and the exact assertions required — mandatory, because the hand-rolled Drizzle `mockReturnValueOnce` queues mirror the specific order of selects the route issues and cannot be authored blind. Two steps say "confirm the identifier before writing" (`req` in `urlSafety.ts`'s response handler; the `/providers/:id/test` `getOIDCConfig` line number) — these are deliberate one-line greps against real code, not deferred decisions. No TBD, no TODO, no "add error handling", no "similar to Task N".

**Mock-queue shift inventory (the #1 source of phantom failures in `routes/sso.test.ts`):**
| Task | Adds a `db.select()`? | Effect on existing queues |
|---|---|---|
| 3 | Yes — inside `revalidateSsoDefaultRole` (`organizations.partnerId`) | **None**, because the tests mock `../services/roleAssignment` wholesale |
| 4 | No | None |
| 5 | Yes — axis-membership row in `validateLinkBinding` | **Shifts every link test by one.** `primeLinkCallback` (`:2391-2398`) must be rewritten once |
| 6 | Yes — the `inArray` subquery is a `db.select()` **at condition-construction time** | **Shifts every org-axis callback test that reaches the by-email branch by one.** Re-prime before writing new tests |
| 7 | No | None |

**Cross-task type consistency:**
- `ScopeContext` / `AssignableRoleRow` / `AuthLike` (Task 2) are consumed identically by `routes/users.ts` (Task 2), `validateProviderDefaultRole` + `revalidateSsoDefaultRole` (Task 3). `validateAssignableRole(c, auth, role) : Promise<string | null>` keeps its exact pre-extraction signature and message strings, which is why `users.test.ts` must pass **unedited**.
- `checkRoleStructure` / `checkRolePermissionCeiling` (Task 2) are the caller-independent halves used by Task 3's JIT path and by the system-scope config path. `AuthLike.scope` is **required** (`string`), so Task 3's `auth.scope === 'system'` branch is type-checked, not accidentally `undefined`.
- `revalidateSsoDefaultRole` (Task 3) returns `{ ok: true; roleId: string; skippedCeiling: boolean } | { ok: false; reason: string }` — the `skippedCeiling` flag is what drives the `sso.callback.jit_ceiling_skipped` audit at the single call site. It reads `provider.defaultRoleConfiguredBy ?? provider.createdBy ?? null` (Task 1's column, then the legacy fallback) and passes **both** `{ orgId, partnerId }` to `getUserPermissions`.
- `ssoProviders.configVersion: number` (Task 1) is read by `checkProviderGeneration` (Task 4) and written by the two bump sites (Task 4); `ssoSessions.providerVersion: number | null` is written at all three session-create sites (Task 4) and read by `checkProviderGeneration`. `ssoProviders.defaultRoleConfiguredBy: string | null` (Task 1) is written by POST + PATCH (Task 3) and read by the JIT gate (Task 3). **Tasks 3, 4 and 7 each add a key to the SAME PATCH `updates` object — Task 7 Step 4 shows its canonical final form; do not let three partial snippets drift into three different objects.**
- `ssoSessions.initiatingAuthEpoch / initiatingMfaEpoch: number | null` and `initiatingSessionId: string | null` (Task 1) are written **only** by `/sso/link/start` (Task 5) and read **only** by `validateLinkBinding` (Task 5). `getUserEpochs` returns `{ authEpoch: number; mfaEpoch: number } | null`; `getRefreshFamily` returns `{ revokedAt: Date | null; absoluteExpiresAt: Date } | null` — both consumed exactly as PR 1 declares them, both fail-closed on `null`.
- `SsoCallbackMode` (Task 4) is computed once (`session.linkUserId ? 'link' : 'login'`) and consumed by Task 4's generation gate **and** Task 6's email-verification gate — one variable, no divergent re-derivation.
- `EmailVerifiedClaim = 'true' | 'false' | 'absent'` + `readEmailVerifiedClaim` (Task 6) are produced in `services/sso.ts`, consumed in `routes/sso.ts` (as an explicitly-typed `const emailVerifiedClaim: EmailVerifiedClaim`), **and re-declared in the `vi.mock('../services/sso')` factory** — keep the three in sync or the route tests silently test a stub. `isDomainVerifiedForOrg` is added to the **existing** `vi.mock('../services/ssoDomainVerification')` factory (`routes/sso.test.ts:158`), never a second `vi.mock` for the same path (a duplicate clobbers the first and reds the existing domain-gate tests at `:1297`/`:1314`).
- `SafeFetchInit.maxBytes?: number` + `ResponseTooLargeError` (Task 7, `services/urlSafety.ts`) are additive: unset ⇒ unbounded ⇒ **zero behavior change for every existing caller** (webhooks, Pax8, SentinelOne, TD SYNNEX, DNS). Only the four OIDC calls opt in, at `OIDC_MAX_RESPONSE_BYTES`.
- `OIDCConfig.allowPrivateNetwork?: boolean` (Task 7) is set **once** by `getOIDCConfig` from `selfHostAllowsPrivateNetwork()` and read by `exchangeCodeForTokens`, `getUserInfo`, `refreshAccessToken`, and `verifyIdTokenSignature` → `getIdTokenJwks` (where it is also part of the cache key). It is never request-supplied. `assertSafeOidcEndpoint(label, url, allowPrivateNetwork)` is the single policy gate used by `validateDiscoveredEndpoints` (pre-persist), `getOIDCConfig` (runtime), and each transport function (pre-fetch) — one predicate, three call layers, no forked SSRF logic.
- **`#1105` invariant (M4):** `verifyIdTokenSignature` now transitively calls `safeFetch` → `assertOutsideHeldDbContext('safeFetch')`, which **throws**. Its call site (`routes/sso.ts:1501`) is outside any held DB context today; Task 7's test pins that so a future refactor cannot move it inside `withSystemDbAccessContext` and 500 every SSO login.
