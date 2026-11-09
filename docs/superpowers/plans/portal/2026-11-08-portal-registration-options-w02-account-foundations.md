---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W2: Account Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate portal account lifecycle, browser access and external identity in the database. Route every writer of `status`/`browser_access` through one transition module. Make invite/reset tokens purpose-bound and atomically consumed. Make password-login failure uniform. Ship identities release A: table, backfill and add-in dual-write, with reads still on `portal_users.entra_*`.

**Architecture:** One migration adds a `status` CHECK, `browser_access` (backfilled, with a fill trigger for writers on the old binary), `UNIQUE (id, org_id)` and the shape-1 `portal_user_identities` table, backfilled from `entra_*`. `services/portalUserIdentities.ts` owns identity writes and the drift report. `services/portalAccountState.ts` owns the transition table, and a source-scan contract test makes every `portal_users` writer either use it or declare that it writes no state. `routes/portal/capabilityTokens.ts` replaces the bare-user-id invite/reset tokens with versioned, purpose-bound payloads consumed by a Lua GET+DEL.

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migrations, PostgreSQL forced RLS, ioredis 5 / Redis 8, Vitest (unit + `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md` (§2, §5.1, §5.2, §6 invariants 4, 7, 8, 9, 10, §7 W2 row).

**Rigor: high.** Auth, migration, multi-tenant RLS, the AI for Office exchange. Full TDD, one independent review round per PR, contract suites before each PR.

## PR split

| PR | Tasks | Ships | Depends on |
|---|---|---|---|
| **PR-A** `feature/11377-portal-registration/wave-11379`, body says `Part of #11379` | 1–4 | Migration, Drizzle, registration lists, identities service + drift report, `clientAiExchange` dual-write | — |
| **PR-B** `feature/11377-portal-registration/wave-11379-b`, body carries `Closes #11379` | 5–9 | State module + writer census, `orgPortalUsers` writers, capability tokens, accept-invite/reset/session gates, uniform login | PR-A **merged to main** (branch B from main after A lands. Do not stack. A stacked PR runs no CI) |

PR-A changes no behaviour visible to users or MSPs. PR-B has no migration. Only PR-B closes the wave sub-issue: a `Closes #11379` in PR-A would close W2 when only half of it has landed. If W2 ships as one PR instead, use the `wave-11379` branch with `Closes #11379`.

## Decisions taken in this plan (flag in each PR body)

- **D1 — `browser_access` has no column default. A BEFORE INSERT trigger fills it from `auth_method` when it is omitted** (`password` → `granted`, otherwise `none`). Reason: during a rolling deploy an old API binary inserts rows without the column. A plain `DEFAULT 'granted'` would grant browser access to add-in JIT rows. A plain `DEFAULT 'none'` would break invites created by the old binary. The trigger is dropped together with the `entra_*` columns in identities release C.
- **D2 — Bulk invite targets `auth_method='password' AND password_hash IS NULL AND entra_oid IS NULL AND status IN ('invited','active')`, not the spec's literal `status='invited'`.** Reason: pre-#3258 inbound email created `status='active'` password-method rows with no password (`git show 01d588ae7d^:apps/api/src/services/inboundEmail/resolveOrg.ts:70-72`). The MSP UI counts them as "pending setup" (`services/portalUserDirectory.ts:30-34`). The spec's goal, "can no longer touch identity-only or add-in accounts", is met by `entra_oid IS NULL` plus `auth_method='password'`. To follow the spec literally, drop `'active'` from `isBulkInviteEligible` (one line, Task 5).
- **D3 — Legacy (pre-deploy) tokens:** **invite** tokens in the old `{portalUserId}` shape are accepted **once**, only when the row is `status='invited'`, password-eligible, `browser_access='granted'` and its org is active. The 7-day TTL makes losing them costly for MSPs. **Reset** tokens in the old `{userId}` shape are **rejected** with the existing generic 400. The TTL is 1 h, so the user simply asks again. The legacy-invite branch is deleted in W3, at least 7 days after PR-B deploys (put this in the W3 plan).
- **D4 — Reactivating a disabled account that has no credential** (no password hash, no identity) lands on `invited`, not `active`. The MSP then resends the invite.
- **D5 — Login verifies every candidate (cap 10, fetched as 11).** It runs one dummy argon2 verify when no candidate has a hash. More than 10 candidates without `orgId` is a generic failure.

Design-quality review of D1–D5 belongs to the advisor quorum (`codex exec`, xhigh, read-only) before PR-A opens, not to Todd.

## Global Constraints

- `portal_users.status ∈ {'invited','active','disabled'}` (CHECK `portal_users_status_chk`). DB default stays `'active'`.
- `portal_users.browser_access ∈ {'granted','none'}` (CHECK `portal_users_browser_access_chk`), NOT NULL. Backfill: `auth_method='password'` → `granted`, `auth_method='entra'` → `none`. "Nothing changes for anyone on deploy."
- `portal_user_identities` matches spec §5.2 exactly: `provider ∈ {'entra','google'}`. `linked_via ∈ {'jit','invite','self_link','scim','migrated','msp'}`. Entra issuer = `https://login.microsoftonline.com/{tid}/v2.0`. Google issuer = `https://accounts.google.com`. Unique `(issuer, subject)` and `(portal_user_id, provider)`. Composite FK `(portal_user_id, org_id) → portal_users(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`.
- **Reads stay on `portal_users.entra_tenant_id/entra_oid` in W2.** No code reads `portal_user_identities` for authorization. Only `reconcilePortalUserIdentities` and the tests read it.
- **Neither product grants the other** (inv. 9): add-in JIT writes `browser_access='none'`. `middleware/clientAiAuth.ts` must not read `browser_access`.
- Invite TTL stays `INVITE_TTL_MS` (7 d), reset stays `RESET_TTL_MS` (1 h) (`routes/portal/schemas.ts:78-89`). Redis keys stay `PORTAL_REDIS_KEYS.inviteToken/resetToken` (`schemas.ts:105-106`), so legacy tokens are still found.
- New API error codes are UPPER_SNAKE strings next to `PORTAL_ACCOUNT_INACTIVE_CODE` (`routes/portal/auth.ts:63`): `PORTAL_USER_IDENTITY_MANAGED`, `PORTAL_ACCOUNT_TRANSITION_REFUSED`.
- **Migration:** name it to sort after the newest file on `origin/main`. Final slot after main moved (#11409 shipped `2027-01-22-211200`): `2027-01-22-230200-portal-account-foundations.sql`. Re-run the `localeCompare` check from `apps/api/migrations/README.md` right before every push, and rename if overtaken. Rename integration-test path references too. Never rename a shipped migration. The file must be idempotent, with no inner `BEGIN;/COMMIT;`, and its first statement is `SELECT set_config('breeze.scope', 'system', true);`. Every cleanup reports a count via `RAISE WARNING/NOTICE`. `portal_users` carries no partner-export triggers, so no pre-locks are needed (`migrationPartnerExportLocks.test.ts` verifies this).
- **Traps:**
  - A catch around a query needs `withDbTransaction` with the catch outside it. Never start one beside `Promise.all` siblings (`docs/agents/tenancy-rls.md:21-28`). Prefer `ON CONFLICT DO NOTHING` (no target, so it covers both unique keys) where a conflict is the only expected failure.
  - Never call `withSystemDbAccessContext` inside an open request transaction. Public portal auth routes hold no context. `clientAiExchange` already runs inside one system context, so do not nest another.
  - New `apps/api/src/services/*.ts` files: `parkedFanout.contract.test.ts` only discovers files that read `devices` or carry exclusion markers (header lines 12-20). None of ours do, but run it to prove they stay undiscovered.
  - API typecheck = `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"`. Check the exit code and never pipe it to `tail`.
  - Never `pnpm --filter <pkg> test -- --run <path>`. Use `cd apps/api && npx vitest run <file>`. Vitest path filters are substring matches.
  - Cascade, merge and export contract suites fail **only under Integration Tests**, never Test API. `orgMerge.test.ts` "no merge policy registered" fails only in the **full** unit suite.
  - A stacked PR runs no CI: `gh workflow run CI --ref <branch>`.
- Local DB: `pnpm test-stack up` … `pnpm test-stack down` (tear down and say so). Integration run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/<file>`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Old binary inserts during the deploy window.** A pre-W2 API instance inserts an invite row or an add-in JIT row without `browser_access`. The invite row must come out `granted` and the JIT row `none`, and no NOT NULL error may surface. *(Task 1: `fills browser_access from auth_method when an insert omits it`.)*
2. **Invite email sent the day before deploy, clicked after.** The user must still be able to set a password once. A reset link from before deploy gives the ordinary "Invalid or expired reset token" and the user asks again. *(Task 7: `accepts a legacy invite token once for an invited row`, `rejects a legacy reset token with the generic 400`.)*
3. **One person, two orgs, same email.** Same password in both: the generic 401, byte-identical to a wrong password, never a session in an arbitrary org. Different passwords: signs in to the org whose password matched. *(Task 9.)*
4. **The invite link is double-clicked or opened in two tabs.** Exactly one activation and one session. The second gets the invalid-invite 400. *(Task 7 real-Redis race + Task 8 route test.)*
5. **An MSP reactivates someone who was disabled before accepting.** The account becomes `invited` (D4) and resend works. It never becomes `active` with no credential. *(Task 6: `reactivating a credential-less disabled user lands on invited`.)*

---

## File structure

| File | Responsibility | PR |
|---|---|---|
| Create `apps/api/migrations/2027-01-22-230200-portal-account-foundations.sql` | All DDL + backfills (spec of record, Task 1) | A |
| Modify `apps/api/src/db/schema/portal.ts:114-155` | `browserAccess` column, `portalUserIdentities` table, status/browser-access type exports | A |
| Create `apps/api/src/services/portalUserIdentities.ts` (+ `.test.ts`) | `entraIssuer`, identity writes for the exchange, drift report | A |
| Create `apps/api/scripts/portal-identity-reconcile.ts` | Run-once CLI that prints the drift report | A |
| Modify `apps/api/src/services/clientAiExchange.ts:323-413` | Dual-write on JIT insert. Self-heal on the existing-user path | A |
| Modify `services/tenantCascade.ts:908`, `services/orgMergeRegistry.ts:~1223`, `services/tenantExportPolicyRegistry.ts:780` | Registration + column classification | A |
| Create `apps/api/src/services/tenantExportPolicyRegistry.portalUserIdentities.test.ts` | Moves the export-classification failure into Test API | A |
| Create `apps/api/src/__tests__/integration/portalAccountFoundationsMigration.integration.test.ts` | Backfill, idempotency, CHECKs, trigger, unique index | A |
| Create `apps/api/src/__tests__/integration/portalUserIdentities.integration.test.ts` | RLS forge, composite FK, cascade, merge, dual-write, drift report | A |
| Create `apps/api/src/services/portalAccountState.ts` (+ `.test.ts`) | Transition table, the one place state targets are computed | B |
| Create `apps/api/src/__tests__/portalAccountWriters.contract.test.ts` | Census: every `portal_users` writer is classified | B |
| Modify `apps/api/src/routes/orgPortalUsers.ts:42-286` | invite / patch / resend / bulk-invite via the state module | B |
| Create `apps/api/src/routes/portal/capabilityTokens.ts` (+ `.test.ts`) | Issue / consume / validate purpose-bound tokens | B |
| Modify `apps/api/src/routes/portal/helpers.ts:44-45,323-337,526-554` | Remove the old invite-token functions. Retype the in-memory maps | B |
| Create `apps/api/src/routes/portal/loginCandidates.ts` (+ `.test.ts`) | Exactly-one-verifies resolution | B |
| Modify `apps/api/src/routes/portal/auth.ts:156-432,438-583,585-684,686-800,802-914` | Session gate, login, forgot/reset, accept-invite | B |
| Modify `apps/api/src/services/password.ts`, `apps/api/src/routes/auth/login.ts:92-104` | Move `getDummyPasswordHash` into the shared module | B |
| Modify `apps/docs/src/content/docs/features/portal.mdx:584-586`, regenerate `apps/api/src/data/docsIndex.json` | Remove the "Multiple portal accounts found" troubleshooting entry | B |

---

## PR-A — Release A

### Task 1: Migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2027-01-22-230200-portal-account-foundations.sql`
- Modify: `apps/api/src/db/schema/portal.ts` (`portalUsers` at :114-155. Add `portalUserIdentities` right after it)
- Test: `apps/api/src/__tests__/integration/portalAccountFoundationsMigration.integration.test.ts`

**Interfaces:**
- Produces (Drizzle, `db/schema/portal.ts`):
  - `portalUsers.browserAccess: text('browser_access').$type<PortalBrowserAccess>().notNull().default('none')`, with the comment *"DB has no column default. The BEFORE INSERT trigger `portal_users_browser_access_fill` derives it from auth_method when omitted. `.default` only makes it optional in Drizzle insert types (Drizzle emits DEFAULT). Production writers pass it explicitly via portalAccountState."*
  - `export type PortalAccountStatus = 'invited' | 'active' | 'disabled'` and `export type PortalBrowserAccess = 'granted' | 'none'`. The `status` column type is left as `varchar` to avoid churn in 38 fixture files.
  - `export const portalUserIdentities = pgTable('portal_user_identities', { id, orgId, portalUserId, provider: text().$type<'entra'|'google'>(), issuer, subject, entraTenantId, linkedVia: text().$type<PortalIdentityLinkedVia>(), lastUsedAt, createdAt }, t => ({ issuerSubjectUq: uniqueIndex('portal_user_identities_issuer_subject_uq').on(t.issuer, t.subject), userProviderUq: uniqueIndex('portal_user_identities_user_provider_uq').on(t.portalUserId, t.provider), orgIdx: index('portal_user_identities_org_id_idx').on(t.orgId) }))`. The composite FK is SQL-only, with a comment pointing at the migration (same convention as `portal_users_contact_org_fk`, `portal.ts:137-145`).
  - `export type PortalIdentityLinkedVia = 'jit' | 'invite' | 'self_link' | 'scim' | 'migrated' | 'msp'`.

**Writer audit, done for this plan.** Values any code path can write to `status`:
- `orgPortalUsers.ts:204,212,277` → `'invited'`
- `orgPortalUsers.ts:235` → `'active'|'disabled'` (`updatePortalUserSchema`, `packages/shared/src/validators/portal.ts:241-245`)
- `auth.ts:874` → `'active'`
- `clientAiExchange.ts:352` → DB default `'active'`
- historical inbound email (pre-#3258) → `'active'`
- `e2e-tests/seed-fixtures.sql:78-99` → `'active'`

No path writes anything else. The migration still normalizes defensively: a trimmed/lower-cased known value is mapped back, and anything else becomes `'disabled'` with a WARNING per value. `'disabled'` is behaviour-preserving for login and session (both refuse any status ≠ `active`, `auth.ts:316,508`). It is stricter only for accept-invite, which today refuses only `disabled` (`auth.ts:860`), so fail-closed is the right side.

- [ ] **Step 1: Write the failing integration test** (template: `portalEntraPasswordHashCleanup.integration.test.ts` for notice capture. `aiModelRegistryLegacyDrop.integration.test.ts` for drop-and-replay). Each "replay" case runs inside one superuser transaction that is **rolled back**. The transaction drops `portal_user_identities`, `portal_users_id_org_uq`, the trigger and its function, both CHECKs and `browser_access`, seeds rows, replays the file through `replayMigration`, asserts, then `ROLLBACK`.

```ts
describe('2027-01-22-230200-portal-account-foundations.sql', () => {
  it('backfills browser_access: password → granted, entra → none', /* seed 2 password + 1 entra; replay; expect per-row values */);
  it('normalizes unknown statuses: " Active " → active, "pending" → disabled (epoch bumped), and WARNs once per value', /* drop status CHECK first */);
  it('rejects status outside invited|active|disabled with 23514 portal_users_status_chk');
  it('rejects browser_access outside granted|none with 23514 portal_users_browser_access_chk');
  it('fills browser_access from auth_method when an insert omits it', /* raw INSERT without the column: password→granted, entra→none */);
  it('keeps an explicit browser_access on insert', /* entra row with browser_access='granted' stays granted */);
  it('backfills one entra identity per (entra_tenant_id, entra_oid) row with the v2.0 issuer and linked_via=migrated', /* issuer === `https://login.microsoftonline.com/${tid}/v2.0`, subject === oid, last_used_at === last_login_at */);
  it('skips half-populated rows (oid without tid) and WARNs their count');
  it('is idempotent: a second replay changes no row and does not reset a browser_access changed after the first', /* UPDATE one password row to none, replay, still none */);
  it('creates portal_users_id_org_uq on (id, org_id)', /* pg_index lookup */);
  it('starts with the system-scope line', () => expect(firstStatement(file)).toBe("SELECT set_config('breeze.scope', 'system', true);"));
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm test-stack up && cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalAccountFoundationsMigration.integration.test.ts`
Expected: FAIL with ENOENT on the migration file.

- [ ] **Step 3: Write the migration** (spec of record)

```sql
-- Portal registration W2 (account foundations). Spec:
-- docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md §5.1, §5.2.
-- WRITES ROWS → system scope first (forced RLS binds the migration role).
-- autoMigrate wraps this file in a transaction: no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

-- 1. status: normalize, then CHECK. Every known writer writes invited|active|disabled.
DO $$
DECLARE n integer; r record;
BEGIN
  UPDATE public.portal_users SET status = lower(btrim(status))
   WHERE status NOT IN ('invited','active','disabled')
     AND lower(btrim(status)) IN ('invited','active','disabled');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'portal_users: re-cased/trimmed status on % row(s)', n; END IF;

  FOR r IN SELECT status, count(*) AS c FROM public.portal_users
            WHERE status NOT IN ('invited','active','disabled') GROUP BY status LOOP
    RAISE WARNING 'portal_users: unknown status % on % row(s) -> disabled', quote_literal(r.status), r.c;
  END LOOP;
  UPDATE public.portal_users
     SET status = 'disabled', auth_epoch = auth_epoch + 1, updated_at = now()
   WHERE status NOT IN ('invited','active','disabled');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'portal_users: disabled % row(s) with an unknown status', n;
  ELSE RAISE NOTICE 'portal_users: disabled 0 row(s) with an unknown status'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_users'::regclass AND conname = 'portal_users_status_chk') THEN
    ALTER TABLE public.portal_users
      ADD CONSTRAINT portal_users_status_chk CHECK (status IN ('invited','active','disabled'));
  END IF;
END $$;

-- 2. browser_access: add nullable, backfill only NULLs (a replay never resets a later grant/revoke),
--    fill trigger for omitted inserts (old binaries during rolling deploy — plan D1), then NOT NULL + CHECK.
ALTER TABLE public.portal_users ADD COLUMN IF NOT EXISTS browser_access text;

DO $$
DECLARE g integer; nn integer;
BEGIN
  UPDATE public.portal_users SET browser_access = 'granted'
   WHERE browser_access IS NULL AND auth_method = 'password';
  GET DIAGNOSTICS g = ROW_COUNT;
  UPDATE public.portal_users SET browser_access = 'none'
   WHERE browser_access IS NULL AND auth_method <> 'password';
  GET DIAGNOSTICS nn = ROW_COUNT;
  RAISE NOTICE 'portal_users: browser_access backfilled granted=% none=%', g, nn;
END $$;

CREATE OR REPLACE FUNCTION public.breeze_portal_users_fill_browser_access()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.browser_access IS NULL THEN
    NEW.browser_access := CASE WHEN NEW.auth_method = 'password' THEN 'granted' ELSE 'none' END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS portal_users_browser_access_fill ON public.portal_users;
CREATE TRIGGER portal_users_browser_access_fill
  BEFORE INSERT ON public.portal_users
  FOR EACH ROW EXECUTE FUNCTION public.breeze_portal_users_fill_browser_access();

ALTER TABLE public.portal_users ALTER COLUMN browser_access SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_users'::regclass AND conname = 'portal_users_browser_access_chk') THEN
    ALTER TABLE public.portal_users
      ADD CONSTRAINT portal_users_browser_access_chk CHECK (browser_access IN ('granted','none'));
  END IF;
END $$;

-- 3. Composite-FK target.
CREATE UNIQUE INDEX IF NOT EXISTS portal_users_id_org_uq ON public.portal_users (id, org_id);

-- 4. portal_user_identities — tenancy shape 1, RLS in this same migration.
CREATE TABLE IF NOT EXISTS public.portal_user_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  portal_user_id  uuid NOT NULL,
  provider        text NOT NULL,
  issuer          text NOT NULL,
  subject         text NOT NULL,
  entra_tenant_id text,
  linked_via      text NOT NULL,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_user_identities_user_org_fk
    FOREIGN KEY (portal_user_id, org_id) REFERENCES public.portal_users (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_user_identities_provider_chk CHECK (provider IN ('entra','google')),
  CONSTRAINT portal_user_identities_linked_via_chk
    CHECK (linked_via IN ('jit','invite','self_link','scim','migrated','msp')),
  CONSTRAINT portal_user_identities_entra_tenant_chk
    CHECK ((provider = 'entra') = (entra_tenant_id IS NOT NULL)),
  CONSTRAINT portal_user_identities_issuer_chk CHECK (
    (provider = 'entra'  AND issuer = 'https://login.microsoftonline.com/' || entra_tenant_id || '/v2.0')
 OR (provider = 'google' AND issuer = 'https://accounts.google.com'))
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_user_identities_issuer_subject_uq ON public.portal_user_identities (issuer, subject);
CREATE UNIQUE INDEX IF NOT EXISTS portal_user_identities_user_provider_uq ON public.portal_user_identities (portal_user_id, provider);
CREATE INDEX IF NOT EXISTS portal_user_identities_org_id_idx ON public.portal_user_identities (org_id);

ALTER TABLE public.portal_user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_user_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.portal_user_identities;
CREATE POLICY breeze_org_isolation_select ON public.portal_user_identities
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.portal_user_identities;
CREATE POLICY breeze_org_isolation_insert ON public.portal_user_identities
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.portal_user_identities;
CREATE POLICY breeze_org_isolation_update ON public.portal_user_identities
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.portal_user_identities;
CREATE POLICY breeze_org_isolation_delete ON public.portal_user_identities
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.portal_user_identities TO breeze_app;

-- 5. Backfill from portal_users.entra_* (release A). ON CONFLICT with no target covers both unique keys.
DO $$
DECLARE n integer; half integer;
BEGIN
  INSERT INTO public.portal_user_identities
    (org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via, last_used_at, created_at)
  SELECT pu.org_id, pu.id, 'entra',
         'https://login.microsoftonline.com/' || pu.entra_tenant_id || '/v2.0',
         pu.entra_oid, pu.entra_tenant_id, 'migrated', pu.last_login_at, pu.created_at
    FROM public.portal_users pu
   WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'portal_user_identities: backfilled % entra identit(ies)', n;

  SELECT count(*) INTO half FROM public.portal_users
   WHERE (entra_oid IS NULL) <> (entra_tenant_id IS NULL);
  IF half > 0 THEN
    RAISE WARNING 'portal_users: % row(s) have only one of entra_oid/entra_tenant_id — not backfilled', half;
  END IF;
END $$;
```

- [ ] **Step 4: Update Drizzle `db/schema/portal.ts`** per the Interfaces block. `export *` in `schema/index.ts:39` already re-exports it.

- [ ] **Step 5: Run the test, the migration unit guards and the drift check**

Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalAccountFoundationsMigration.integration.test.ts` → PASS
Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts` → PASS
Run: `DATABASE_URL=<test-stack url> pnpm db:check-drift` → exit 0

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2027-01-22-230200-portal-account-foundations.sql apps/api/src/db/schema/portal.ts apps/api/src/__tests__/integration/portalAccountFoundationsMigration.integration.test.ts
git commit -m "feat(portal): account foundations migration — status CHECK, browser_access, portal_user_identities (W2)"
```

### Task 2: Registration (cascade, merge, export) + RLS/FK proof

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:908-909`. Insert `'portal_user_identities',` between `'portal_branding'` and `'portal_users'`. `'portal_user_'` sorts before `'portal_users'` because `_` < `s`, which also satisfies child-before-parent. Verify with the suite, don't assume.
- Modify: `apps/api/src/services/orgMergeRegistry.ts`. Add `"portal_user_identities"` to `REPOINT_TABLES` (`:843`) just before `"portal_users"` (`:1224`). Rule: a repoint can never collide, because both unique keys are org-free and the composite FK is deferred by the merge.
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:780`. Add `"browser_access"` to `portal_users.included`. Add `"portal_user_identities": tablePolicy("org_id", {"included":["id","org_id","portal_user_id","provider","issuer","subject","entra_tenant_id","linked_via","last_used_at","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]})`. No name matches `SUSPICIOUS_NAME_PARTS` (`services/tenantExportPolicy.ts:42-62`), and the table has no json/bytea column. **Code fact:** the spec calls the `:780` handling "dynamic". It is a static `tablePolicy` entry.
- Create: `apps/api/src/services/tenantExportPolicyRegistry.portalUserIdentities.test.ts`
- Create: `apps/api/src/__tests__/integration/portalUserIdentities.integration.test.ts` (RLS/FK/cascade/merge part. Task 4 adds the dual-write part). Template: `portalUserContactCompositeFk.integration.test.ts` (`orgCtx`, constraint-name assertions, merge re-tenant).
- `rls-coverage.integration.test.ts`: **no allowlist entry**. Shape 1 is auto-discovered. Run it to prove that.

**Interfaces:** Consumes `portalUserIdentities` and `PortalIdentityLinkedVia` from Task 1.

- [ ] **Step 1: Write the failing tests**

```ts
// tenantExportPolicyRegistry.portalUserIdentities.test.ts (Test API)
it('classifies every portal_user_identities column', () => {
  const reg = getTenantExportPolicyRegistry()['portal_user_identities'];
  for (const col of Object.values(getTableColumns(portalUserIdentities)).map(c => c.name))
    expect(reg?.columns[col]?.decision).toBe('include');
});
it('classifies portal_users.browser_access as include', () =>
  expect(getTenantExportPolicyRegistry()['portal_users']?.columns['browser_access']?.decision).toBe('include'));

// portalUserIdentities.integration.test.ts
it('refuses an identity whose org_id differs from its portal user (23503 portal_user_identities_user_org_fk)');
it('refuses a cross-tenant INSERT as breeze_app under org A context naming org B (42501)', /* withDbAccessContext(orgCtx(A)) insert {orgId: B,...} → rejects with code 42501 */);
it('hides org B identities from an org A context (SELECT returns 0)');
it('portal_user_identities_user_org_fk is DEFERRABLE INITIALLY IMMEDIATE', /* pg_constraint condeferrable && !condeferred */);
it('deletes identities when the portal user is deleted (ON DELETE CASCADE)');
it('org merge re-tenants the login AND its identity to the survivor, link intact');
it('refuses a second entra identity for the same user (23505 portal_user_identities_user_provider_uq)');
it('refuses the same (issuer, subject) on two users (23505 portal_user_identities_issuer_subject_uq)');
it('refuses an entra issuer that does not embed entra_tenant_id (23514 portal_user_identities_issuer_chk)');
```

- [ ] **Step 2: Run them and verify they fail.** The unit test fails on the missing registry entry. The merge test fails with `no merge policy registered`.

- [ ] **Step 3: Make the three registry edits** listed under Files.

- [ ] **Step 4: Run the unit test plus every contract suite.** All of these are integration-only except the first.

```bash
cd apps/api && npx vitest run src/services/tenantExportPolicyRegistry.portalUserIdentities.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts \
  src/__tests__/integration/portalUserIdentities.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenantCascadeFkChildren.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter @breeze/api test:integration-suite-coverage
```
Expected: all PASS. Check the reported file count.

- [ ] **Step 5: Commit**: `feat(portal): register portal_user_identities in cascade, merge and export policy (W2)`

### Task 3: Identities service + drift report

**Files:**
- Create: `apps/api/src/services/portalUserIdentities.ts`, `apps/api/src/services/portalUserIdentities.test.ts`
- Create: `apps/api/scripts/portal-identity-reconcile.ts` (bootstrap like `apps/api/scripts/wisp-gap-finder.ts`)
- Test (real DB): append to `portalUserIdentities.integration.test.ts`

**Interfaces:**
- Produces:
  - `export type IdentityExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];` (same shape as `ContactExecutor`, `services/contacts/compat.ts:55`)
  - `export function entraIssuer(tid: string): string` → `` `https://login.microsoftonline.com/${tid}/v2.0` ``
  - `export async function insertEntraIdentity(exec: IdentityExecutor, input: { orgId: string; portalUserId: string; tid: string; oid: string; linkedVia: 'jit'; usedAt: Date }): Promise<void>`. Plain insert that **throws** on conflict. For use inside the JIT savepoint only.
  - `export async function ensureEntraIdentity(exec: IdentityExecutor, input: { orgId: string; portalUserId: string; tid: string; oid: string; usedAt: Date }): Promise<'inserted' | 'present' | 'conflict'>`. `INSERT … linked_via='jit' ON CONFLICT DO NOTHING` (no target, so it never raises 23505 and needs no savepoint). Then `UPDATE … SET last_used_at = usedAt WHERE issuer=$ AND subject=$ AND portal_user_id=$`. Returns `'conflict'` when the `(issuer, subject)` row belongs to another user or the user already holds a different entra subject.
  - `export interface PortalIdentityDriftReport { checkedAt: string; counts: { missingIdentity: number; orphanIdentity: number; mismatched: number; halfPopulated: number }; samples: { missingIdentity: Array<{ portalUserId: string; orgId: string }>; orphanIdentity: Array<{ identityId: string; portalUserId: string }>; mismatched: Array<{ portalUserId: string; identityId: string; field: 'subject' | 'entra_tenant_id' | 'org_id' }>; halfPopulated: Array<{ portalUserId: string }> } }`
  - `export async function reconcilePortalUserIdentities(opts?: { orgId?: string; sampleLimit?: number /* default 100 */ }): Promise<PortalIdentityDriftReport>`. Report only, never writes. Opens its own `withSystemDbAccessContext` and **throws** if called with a context already held (`hasDbAccessContext()`), so it is never nested. Definitions:
    - *missingIdentity* = `portal_users` row with both `entra_*` set and no `provider='entra'` identity
    - *orphanIdentity* = entra identity whose user has `entra_oid IS NULL`
    - *mismatched* = user's `entra_oid ≠ subject`, `entra_tenant_id ≠ identity.entra_tenant_id`, or `org_id` differs
    - *halfPopulated* = exactly one `entra_*` set
- CLI: `pnpm --filter @breeze/api exec tsx scripts/portal-identity-reconcile.ts [--org <uuid>]` prints the JSON report. It exits 1 when any count > 0 and 0 when clean. Run it after each deploy of PR-A. It is never scheduled in W2.

- [ ] **Step 1: Write the failing tests.** Unit tests use Drizzle mocks for argument shapes. Integration tests cover semantics.

```ts
// unit
it('entraIssuer builds the v2.0 issuer', () => expect(entraIssuer('11111111-1111-1111-1111-111111111111')).toBe('https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0'));
it('reconcilePortalUserIdentities refuses to run inside a held DB context', /* mock hasDbAccessContext → true; expect rejects /held/ */);
// integration
it('ensureEntraIdentity inserts once, then reports present and bumps last_used_at');
it('ensureEntraIdentity reports conflict (no throw, transaction still usable) when the subject belongs to another user', /* follow with a SELECT 1 in the same context to prove no 25P02 */);
it('drift report is clean right after the migration backfill');
it('drift report counts a missing identity, an orphan identity, a mismatched subject and a half-populated row', /* seed each shape via superuser */);
it('drift report scoped by orgId ignores other orgs');
```

- [ ] **Step 2: Run them and verify they fail** (module not found).
- [ ] **Step 3: Implement** `services/portalUserIdentities.ts` per the Interfaces block, plus the CLI. The drift report is one `FULL OUTER JOIN` query per bucket with `count(*) OVER ()` and `LIMIT sampleLimit`. All buckets read sequentially (no `Promise.all` with savepoints).
- [ ] **Step 4: Run the unit and integration tests, plus the parkedFanout contract**

Run: `cd apps/api && npx vitest run src/services/portalUserIdentities.test.ts src/__tests__/parkedFanout.contract.test.ts` → PASS
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalUserIdentities.integration.test.ts` → PASS

- [ ] **Step 5: Commit**: `feat(portal): identity writes and drift report for portal_user_identities (W2)`

### Task 4: `clientAiExchange` dual-write (release A)

**Files:**
- Modify: `apps/api/src/services/clientAiExchange.ts:337-413`
- Test: `apps/api/src/services/clientAiExchange.test.ts` (unit). Append to `portalUserIdentities.integration.test.ts` (real DB through `resolveAndMintClientSession`; harness from `loginContactLinking.integration.test.ts`)

**Interfaces:**
- Consumes: `insertEntraIdentity`, `ensureEntraIdentity` (Task 3).
- Produces: no new exports. `resolveAndMintClientSession(claims, redis)` keeps its signature and outcomes.

Changes, all inside the existing single `withSystemDbAccessContext` (no nested context):
1. JIT insert (`:351-365`): inside the **same** `db.transaction((tx) => …)` savepoint, on `tx`, after `tx.insert(portalUsers)…returning`, call `insertEntraIdentity(tx, { orgId: mapping.orgId, portalUserId: inserted[0].id, tid: claims.tid, oid: claims.oid, linkedVia: 'jit', usedAt: now })`. Return the user row. Add `browserAccess: 'none'` to the `portalUsers` values. Task 5 replaces that literal with `initialPortalAccountState('addin_jit')`. A 23505 from either insert rolls back both and lands in the existing catch (`:366-381`). If the re-select by columns finds nothing (the identity collided with a different user = drift), the existing `provisioning_failed` 403 fires, failing closed.
2. Existing-user path (`if (!provisioned)`, `:409-413`): after the `lastLoginAt` update, call `const r = await ensureEntraIdentity(db, { orgId: user.orgId, portalUserId: user.id, tid: claims.tid, oid: claims.oid, usedAt: now })`. On `'conflict'`, `console.error` + `captureException(..., { eventCode: 'client_ai_identity_drift' })`. **Do not deny**, because reads are still on the columns. This closes the fence gap for rows inserted by an old binary during the deploy window.
3. Reads unchanged: lookup by `portalUsers.entraTenantId/entraOid` (`:325-331`, `:373-378`).

- [ ] **Step 1: Write the failing tests**

```ts
// unit (clientAiExchange.test.ts) — extend the existing harness
it('writes the entra identity inside the same SAVEPOINT as the JIT login insert', /* expect tx.insert called with portalUserIdentities values {provider:'entra', issuer: entraIssuer(tid), subject: oid, linkedVia:'jit'} on the tx object, not db */);
it('JIT inserts browser_access none', /* values include browserAccess: 'none' */);
it('ensures the identity on a later exchange and still mints a session on conflict', /* ensureEntraIdentity → 'conflict'; outcome.kind === 'minted'; captureException called with eventCode client_ai_identity_drift */);
it('still resolves the login by portal_users entra columns, not identities', /* select where uses portalUsers.entraTenantId/entraOid */);
// integration (real Postgres, breeze_app)
it('first exchange creates login (browser_access none) + identity atomically; drift report stays clean');
it('a forced identity-insert failure rolls back the login insert too (no half-provisioned row)', /* pre-seed an identity with the same (issuer,subject) on another user in the same org; expect 403 provisioning_failed and zero new portal_users rows */);
it('a login created without an identity (old-binary shape) gains one on its next exchange');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement** the three changes.
- [ ] **Step 4: Run them, plus the existing suites they touch**

Run: `cd apps/api && npx vitest run src/services/clientAiExchange.test.ts src/routes/officeAddin/auth.test.ts` → PASS
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalUserIdentities.integration.test.ts src/__tests__/integration/loginContactLinking.integration.test.ts` → PASS
Run: `cd apps/api && npx vitest run src/__tests__/dbTransactionPromiseAll.contract.test.ts` → PASS

- [ ] **Step 5: Commit**: `feat(client-ai): dual-write portal_user_identities on Entra JIT and self-heal on later exchanges (W2 release A)`

- [ ] **Step 6: PR-A gate**

```bash
NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"   # exit=0
pnpm --filter @breeze/api test --run          # FULL unit suite (orgMerge "no merge policy" only reds here)
# re-check migration ordering against origin/main; rename if overtaken (and update the test's path constant)
git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | sed 's#.*/##' | grep -E '^[0-9]{4}-.*\.sql$' \
  | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'
pnpm test-stack down
```
One independent review round (`superpowers:requesting-code-review`). The PR body carries `Part of #11379` (not `Closes`), states D1, the post-deploy step `tsx scripts/portal-identity-reconcile.ts` and that nothing user-visible changes.

---

## PR-B — State machine, tokens, login

### Task 5: `portalAccountState` module + writer census

**Files:**
- Create: `apps/api/src/services/portalAccountState.ts`, `apps/api/src/services/portalAccountState.test.ts`
- Create: `apps/api/src/__tests__/portalAccountWriters.contract.test.ts`
- Modify: `apps/api/src/services/clientAiExchange.ts` (JIT values use `initialPortalAccountState('addin_jit')`)

**Interfaces:**
- Produces:

```ts
export const PORTAL_ACCOUNT_TRANSITION_REFUSED = 'PORTAL_ACCOUNT_TRANSITION_REFUSED';
export const PORTAL_USER_IDENTITY_MANAGED = 'PORTAL_USER_IDENTITY_MANAGED';
export type PortalAccountWriter =
  | 'msp_invite' | 'msp_bulk_invite' | 'msp_resend_invite'
  | 'msp_disable' | 'msp_reactivate' | 'accept_invite';
export interface PortalAccountFacts {
  status: string; browserAccess: string; authMethod: string;
  hasPasswordHash: boolean;
  hasExternalIdentity: boolean; // W2: portal_users.entra_oid IS NOT NULL (reads stay on columns); W3 switches
}
export interface PortalAccountTarget { status: PortalAccountStatus; browserAccess: PortalBrowserAccess; bumpEpoch: boolean }
export class PortalAccountTransitionError extends Error {
  readonly code: typeof PORTAL_ACCOUNT_TRANSITION_REFUSED | typeof PORTAL_USER_IDENTITY_MANAGED;
  readonly httpStatus: 409 | 400 | 403;
  constructor(code, httpStatus, readonly writer: PortalAccountWriter, readonly rule: string, message: string);
}
export function isPasswordEligible(f: Pick<PortalAccountFacts, 'authMethod'>): boolean; // authMethod === 'password'
export function initialPortalAccountState(writer: 'msp_invite' | 'addin_jit'): { status: PortalAccountStatus; browserAccess: PortalBrowserAccess };
export function planPortalAccountTransition(facts: PortalAccountFacts, writer: PortalAccountWriter): PortalAccountTarget; // throws PortalAccountTransitionError
export function isBulkInviteEligible(facts: PortalAccountFacts): boolean;
```

**The transition table** (the only place it lives). Unknown `status`/`browserAccess` input always throws.

| Writer | From | Precondition | → status | → browser_access | epoch | Refusal (code / HTTP / message reused from today) |
|---|---|---|---|---|---|---|
| initial `msp_invite` | (new row) | — | invited | granted | — | — |
| initial `addin_jit` | (new row) | — | active | **none** | — | — |
| `msp_invite`, `msp_bulk_invite` | invited | password-eligible, no identity | invited | granted | +1 | not eligible → `PORTAL_USER_IDENTITY_MANAGED`/409 "This identity is managed by an external sign-in provider." |
| ″ | active | password-eligible, no identity, **no password hash** (legacy credential-less) | invited | granted | +1 | has hash → `PORTAL_ACCOUNT_TRANSITION_REFUSED`/409 "This email already has an active portal account." |
| ″ | disabled | — | — | — | — | `PORTAL_ACCOUNT_TRANSITION_REFUSED`/409 "This user is disabled. Reactivate them before inviting." |
| `msp_resend_invite` | invited | password-eligible, no identity | invited | unchanged | 0 | as `msp_invite` |
| ″ | active credential-less | as `msp_invite` | invited | granted | +1 | so the token is redeemable |
| `msp_disable` | invited / active / disabled | — | disabled | unchanged | +1 | — |
| `msp_reactivate` | disabled | hash or identity | active | unchanged | +1 | — |
| ″ | disabled | credential-less (D4) | invited | unchanged | +1 | — |
| ″ | active | — | active (no-op) | unchanged | 0 | — |
| ″ | invited | — | — | — | — | `PORTAL_ACCOUNT_TRANSITION_REFUSED`/409 "This user has not accepted their invite yet. Resend the invite instead." |
| `accept_invite` | invited | password-eligible, `browser_access='granted'` | active | unchanged | +1 | → caller maps to the generic invite 400 |

No W2 writer moves `browser_access` `none → granted` for a `none` row. Invites refuse non-password-eligible rows, which are the only `none` rows. `granted → none` has no writer in W2.

**Census contract.** It scans non-test `.ts` under `apps/api/src` and `ee/` (comments stripped) for `.insert(portalUsers)`, `.update(portalUsers)`, `/INSERT\s+INTO\s+(public\.)?portal_users/i` and `/UPDATE\s+(public\.)?portal_users/i`. Each hit file must be a key of:

```ts
const PORTAL_USER_WRITERS: Record<string, 'state-module' | 'no-state'> = {
  'routes/orgPortalUsers.ts': 'state-module',
  'routes/portal/auth.ts': 'state-module',
  'services/clientAiExchange.ts': 'state-module',
  'routes/portal/profile.ts': 'no-state', // name/receiveNotifications/passwordHash only (:73, :167)
};
```

`'state-module'` files must import from `services/portalAccountState`. `'no-state'` files must not match `/\b(status|browserAccess)\s*:\s*['"\`]/`. A stale or unlisted entry fails.

- [ ] **Step 1: Write the failing tests.** Make `portalAccountState.test.ts` table-driven: one `it.each` row per table line above, asserting the `{status, browserAccess, bumpEpoch}` target or the exact `code` + `httpStatus`. Add:

```ts
it('throws on an unknown stored status rather than guessing', () => expect(() => planPortalAccountTransition({ ...f, status: 'pending' }, 'msp_disable')).toThrow(PortalAccountTransitionError));
it('add-in JIT never starts with browser access', () => expect(initialPortalAccountState('addin_jit')).toEqual({ status: 'active', browserAccess: 'none' }));
it('bulk invite excludes identity, entra, disabled and passworded rows', /* isBulkInviteEligible false for each; true for invited and active credential-less */);
// contract
it('every portal_users writer is classified and state writers use portalAccountState');
it('the classification map has no stale entries');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement** the module (a `switch` on writer over the parsed status). Switch the JIT insert to `...initialPortalAccountState('addin_jit')`. The census test stays red until Tasks 6 and 8 land. Mark it `it.todo` here and flip it to `it` in Task 8 Step 3.
- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/portalAccountState.test.ts src/services/clientAiExchange.test.ts` → PASS
- [ ] **Step 5: Commit**: `feat(portal): portal account state machine module (W2)`

### Task 6: MSP writers in `orgPortalUsers.ts`

**Files:**
- Modify: `apps/api/src/routes/orgPortalUsers.ts`:
  - `getOrgScopedPortalUser` `:42-46`: add `authEpoch`, `browserAccess`, `entraOid`
  - `issueAndSendInvite` `:57`: signature change
  - invite `:159-226`, patch `:228-247`, resend `:249-262`, bulk `:264-286`
- Test: `apps/api/src/routes/orgPortalUsers.test.ts` (unit). Modify `apps/api/src/__tests__/integration/portalUserInvite.integration.test.ts` (real DB).

**Interfaces:**
- Consumes: `planPortalAccountTransition`, `initialPortalAccountState`, `isBulkInviteEligible`, `PortalAccountTransitionError` (Task 5). `issuePortalCapabilityToken` (Task 7). Implement Task 7 first, or stub that import to Task 7's signature.
- Produces: `issueAndSendInvite(c, orgId: string, user: { id: string; email: string; authEpoch: number }, orgName, inviterName, message?) → Promise<boolean>`. It calls `issuePortalCapabilityToken({ purpose: 'invite', portalUserId: user.id, orgId, email: user.email, authEpoch: user.authEpoch })`.

Rules:
- **Invite.** A new row is inserted with `...initialPortalAccountState('msp_invite')` and `.returning({ id, authEpoch })`. An existing row runs `planPortalAccountTransition(facts, 'msp_invite')` → `.set({ status, browserAccess, authEpoch: +1 when bumpEpoch, … })` `.returning({ id, authEpoch })`. Keep today's three 409 messages, now with a `code`. An identity-only account (`auth_method != 'password'` or `entra_oid` set) gets `409 { error: 'This identity is managed by an external sign-in provider.', code: 'PORTAL_USER_IDENTITY_MANAGED' }`. SSO linking arrives in W4.
- **PATCH.** `body.status === 'disabled'` → `msp_disable`. `'active'` → `msp_reactivate`. The response returns the resulting status (it may be `invited`, per D4). Non-status fields still bypass the module. A refusal maps to `{ error, code }` with `httpStatus`.
- **Resend.** `planPortalAccountTransition(facts, 'msp_resend_invite')`. When the target differs from the current state (active credential-less), write it before issuing the token.
- **Bulk.** Narrow the SQL to the D2 predicate: `eq(authMethod,'password')`, `isNull(passwordHash)`, `isNull(entraOid)`, `inArray(status,['invited','active'])`. Filter again with `isBulkInviteEligible`. Each update uses `planPortalAccountTransition(…,'msp_bulk_invite')` and `.returning({ authEpoch })`.

- [ ] **Step 1: Write the failing tests**

```ts
// unit
it('invite of an identity-only (entra) account → 409 PORTAL_USER_IDENTITY_MANAGED');
it('new invite inserts status invited + browser_access granted and issues an invite token bound to the returned epoch');
it('re-invite of a legacy active credential-less row moves it to invited and bumps the epoch');
it('PATCH status active on an invited user → 409 PORTAL_ACCOUNT_TRANSITION_REFUSED, no update');
it('reactivating a credential-less disabled user lands on invited'); // Review Focus 5
it('reactivating a disabled user with a password lands on active');
it('bulk invite never selects entra/identity, disabled, or passworded rows', /* inspect where args + update calls */);
// integration (portalUserInvite.integration.test.ts)
it('bulk invite in an org with an add-in (entra) login leaves that login untouched (status, epoch, browser_access)');
it('invite → accept-invite → login still works end to end under purpose-bound tokens');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/routes/orgPortalUsers.test.ts` and `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalUserInvite.integration.test.ts` → PASS
- [ ] **Step 5: Commit**: `feat(portal): route MSP portal-user writers through the account state machine (W2)`

### Task 7: Purpose-bound capability tokens

**Files:**
- Create: `apps/api/src/routes/portal/capabilityTokens.ts`, `apps/api/src/routes/portal/capabilityTokens.test.ts`
- Modify: `apps/api/src/routes/portal/helpers.ts`:
  - delete `storePortalInviteToken`/`consumePortalInviteToken` `:526-554`
  - retype `portalResetTokens`/`portalInviteTokens` `:44-45` to `Map<string, { raw: string; expiresAt: Date; createdAt: Date }>` holding the serialized payload
  - keep the sweep `:323-337`
- Modify importers: `routes/orgPortalUsers.ts:14`, `routes/portal/acceptInvite.test.ts:41`, `__tests__/integration/portalUserInvite.integration.test.ts:47`, `routes/orgPortalUsers.test.ts:76`
- Test (real Redis): `apps/api/src/__tests__/integration/portalCapabilityTokens.integration.test.ts` (`const RUN = !!process.env.REDIS_URL`, as in `accountingRateLimit.integration.test.ts:15`)

**Interfaces:**

```ts
export type PortalCapabilityPurpose = 'invite' | 'reset';
export interface PortalCapabilityPayload { v: 2; purpose: PortalCapabilityPurpose; portalUserId: string; orgId: string; email: string; authEpoch: number }
export type ConsumedCapability =
  | { format: 'v2'; payload: PortalCapabilityPayload }
  | { format: 'legacy'; portalUserId: string };            // {portalUserId} (invite) or {userId} (reset)
export async function issuePortalCapabilityToken(p: Omit<PortalCapabilityPayload, 'v'>): Promise<string | null>; // null when Redis is required but unavailable
export async function consumePortalCapabilityToken(purpose: PortalCapabilityPurpose, rawToken: string): Promise<ConsumedCapability | null>;
export type CapabilityCheck =
  | { ok: true; user: CapabilityUserRow }
  | { ok: false; reason: 'invalid' | 'org_unavailable' };
export async function validatePortalCapability(purpose: PortalCapabilityPurpose, consumed: ConsumedCapability): Promise<CapabilityCheck>;
export const __testOnly: { consumeFromRedis(redis: Redis, key: string): Promise<string | null> };
```

- Key = `PORTAL_REDIS_KEYS.inviteToken|resetToken(sha256(raw))`, unchanged. TTL = `INVITE_TTL_SECONDS` / `RESET_TTL_SECONDS`. Backend = Redis when `PORTAL_USE_REDIS`, else the in-memory map. This is the same switch as today; the two are mutually exclusive (`auth.ts:59`).
- **Atomic consume.** The Redis path runs `redis.eval("local v=redis.call('GET',KEYS[1]) if v then redis.call('DEL',KEYS[1]) end return v", 1, key)`, which works on every Redis version. The memory path does get+delete in one synchronous tick. Parse after consuming: an object with `v===2` is v2, `{portalUserId}`/`{userId}` is legacy, anything else is `null`. A payload whose `purpose` differs from the requested purpose → `null`.
- **`validatePortalCapability`** reads the row in its own `withSystemDbAccessContext` (public routes hold no context), then calls `getActiveOrgTenant(row.orgId)`. Org inactive → `org_unavailable`. Any other failure → `invalid`.
  - **v2 invite:** row exists with `id = portalUserId AND org_id = orgId`, `lower(email) = payload.email`, `auth_epoch = authEpoch`, `status='invited'`, password-eligible, `browser_access='granted'`.
  - **v2 reset:** row matches id/org/email/epoch, password-eligible, `status IN ('active','invited')`. A disabled account can no longer reset; today it can (`auth.ts:741-756`).
  - **Legacy invite (D3):** row by id, `status='invited'`, password-eligible, `browser_access='granted'`. Emit `console.warn('[portal] legacy invite token accepted', { portalUserId })`.
  - **Legacy reset (D3):** always `invalid`.

- [ ] **Step 1: Write the failing tests**

```ts
// unit (in-memory backend)
it('round-trips a v2 invite payload once; second consume returns null');
it('consume with the wrong purpose returns null and still burns the token', /* issue invite, consume as reset → null; consume as invite → null */);
it('validate: invite refuses epoch drift, org mismatch, email mismatch, non-invited status, entra row, browser_access none');
it('validate: reports org_unavailable when getActiveOrgTenant returns null');
it('accepts a legacy invite token once for an invited row');            // Review Focus 2
it('rejects a legacy invite token for an active row');
it('rejects a legacy reset token with the generic invalid');           // Review Focus 2
it('validate: reset refuses a disabled account');
// integration (real Redis)
it('two concurrent consumes of one token: exactly one wins', async () => {
  const key = `portal:invite:${randomUUID()}`; await redis.set(key, '{"v":2}', 'EX', 60);
  const [a, b] = await Promise.all([__testOnly.consumeFromRedis(redis, key), __testOnly.consumeFromRedis(redis, key)]);
  expect([a, b].filter(Boolean)).toHaveLength(1);                       // Review Focus 4
});
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement** the module. Delete the old helpers and update the four importers. Tests that captured raw tokens via `storePortalInviteToken(id)` now call `issuePortalCapabilityToken({ purpose: 'invite', portalUserId, orgId, email, authEpoch })`.
- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/routes/portal/capabilityTokens.test.ts src/routes/portal/helpers.test.ts` and the Redis integration file → PASS
- [ ] **Step 5: Commit**: `feat(portal): purpose-bound, atomically consumed invite and reset tokens (W2)`

### Task 8: Consume-time gates — forgot/reset, accept-invite, session middleware

**Files:**
- Modify: `apps/api/src/routes/portal/auth.ts`:
  - forgot-password `:585-684`: select `authEpoch`, then `issuePortalCapabilityToken({ purpose: 'reset', … })`. Remove the inline `setex`/map writes at `:645-660`.
  - reset-password `:686-800`: replace `:707-743` with consume + validate. The update keeps `eq(authMethod,'password')` and adds `eq(authEpoch, user.authEpoch)`.
  - accept-invite `:802-914`
  - middleware `:221-276`
- Test: `apps/api/src/routes/portal/acceptInvite.test.ts`, `apps/api/src/routes/portal/auth.test.ts`, `apps/api/src/routes/portal/authOrgStatusGate.test.ts`. Real DB: `portalUserInvite.integration.test.ts`, `portalAuthEpoch.integration.test.ts`.

**Interfaces:** Consumes Tasks 5 and 7. Response bodies and statuses for every existing failure stay as they are today (`'Invalid or expired invite'` 400, `'Invalid or expired reset token'` 400). `org_unavailable` returns `403 { error: PORTAL_ORG_UNAVAILABLE_MESSAGE, code: PORTAL_ORG_UNAVAILABLE_CODE }`, the same body login uses (`auth.ts:503-506`). This is safe to reveal to a token holder.

- **Accept-invite:** keep the existing rate limit, password strength check and Redis check, in that order (a weak password never burns a token). Then `consumePortalCapabilityToken('invite')` → `validatePortalCapability` → `planPortalAccountTransition(facts, 'accept_invite')`. Any `PortalAccountTransitionError` → the generic 400. The update `.set({ passwordHash, name, status: target.status, authEpoch: +1, … })` keeps the `eq(authEpoch, user.authEpoch)` guard (`:879`).
- **Session middleware:** add `browserAccess: portalUsers.browserAccess` to the hydration select (`:225-247`). Extend the refusal at `:255` to `!user || user.authMethod !== 'password' || user.browserAccess !== 'granted'`. That refusal has the same cleanup, the same 401 `'Portal user not found'`, and **no** logout exemption. No behaviour change: every `auth_method='password'` row is `granted` after the Task 1 backfill and trigger, and the existing `authMethod` clause already refuses every `none` row.
- Flip the Task 5 census `it.todo` to `it`.

- [ ] **Step 1: Write the failing tests**

```ts
it('accept-invite: a v2 token whose epoch moved (re-invite/disable since issue) → 400 Invalid or expired invite, no update');
it('accept-invite: second use of the same token → 400 and only one session minted'); // Review Focus 4
it('accept-invite: org suspended between invite and accept → 403 PORTAL_ORG_UNAVAILABLE, no activation');
it('accept-invite: weak password does not consume the token');
it('reset-password: token issued, then password changed via profile (epoch +1) → 400, hash unchanged');
it('reset-password: legacy {userId} token → 400 Invalid or expired reset token');
it('session middleware: password row with browser_access none → 401 and session purged');
it('session middleware: password row with browser_access granted → unchanged 200 path');
// integration (portalUserInvite / portalAuthEpoch)
it('every migrated password login keeps its browser session: fixture-inserted password row (trigger → granted) logs in and GET /portal/profile is 200');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, plus all existing portal auth suites**

Run: `cd apps/api && npx vitest run src/routes/portal/acceptInvite.test.ts src/routes/portal/auth.test.ts src/routes/portal/auth.logout.test.ts src/routes/portal/authOrgStatusGate.test.ts src/__tests__/portalAccountWriters.contract.test.ts` → PASS
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalUserInvite.integration.test.ts src/__tests__/integration/portalAuthEpoch.integration.test.ts src/__tests__/integration/portalPasswordResetPartnerLane.integration.test.ts src/__tests__/integration/portalAuthAudit.integration.test.ts src/__tests__/integration/portalLogoutRevocation.integration.test.ts` → PASS

- [ ] **Step 5: Commit**: `feat(portal): re-validate capability tokens at consume and require browser_access on browser sessions (W2)`

### Task 9: Uniform login failure

**Files:**
- Create: `apps/api/src/routes/portal/loginCandidates.ts`, `apps/api/src/routes/portal/loginCandidates.test.ts`
- Modify: `apps/api/src/routes/portal/auth.ts:455-498`, `apps/api/src/services/password.ts` (add `getDummyPasswordHash()`, moved from `routes/auth/login.ts:92-104`), `apps/api/src/routes/auth/login.ts` (import it)
- Modify: `apps/docs/src/content/docs/features/portal.mdx:584-586` (replace the entry with: "Portal login with an email that exists in several organizations succeeds only when exactly one of those accounts has the entered password; otherwise it returns the ordinary invalid-credentials error"). Regenerate with `npx tsx scripts/build-docs-index.ts`.
- Test: `apps/api/src/routes/portal/auth.test.ts`. Real DB: `portalAuthAudit.integration.test.ts` or a new `portalLoginUniformFailure.integration.test.ts`.

**Interfaces:**

```ts
export const PORTAL_LOGIN_CANDIDATE_CAP = 10;
export type LoginCandidate = { id: string; passwordHash: string | null } & Record<string, unknown>;
export async function resolveLoginCandidate<T extends LoginCandidate>(
  candidates: T[], password: string,
  verify: (hash: string, pw: string) => Promise<boolean>,
  dummyHash: () => Promise<string>,
): Promise<T | null>;
```

Behaviour:
- Query: `eq(email)`, `eq(authMethod,'password')`, `eq(browserAccess,'granted')`, plus `eq(orgId)` when `orgId` is sent. The `orgId` param keeps narrowing to that org. `.limit(PORTAL_LOGIN_CANDIDATE_CAP + 1)`.
- `resolveLoginCandidate`: more than the cap → run the dummy verify, return `null`. Verify **every** candidate that has a hash with no short-circuit, sequentially. If none has a hash, run one dummy verify. Return the single verifying candidate only if exactly one verified, else `null`.
- `null` → `401 { error: 'Invalid email or password' }`, with **no other branch**: the `400 'Multiple portal accounts…'` at `:479-483` is deleted.
- `setPortalAuthAuditIdentity` is called only when exactly one candidate exists, or for the resolved candidate. Several candidates with no winner audit like an unknown address.
- The org-active 403 and `status !== 'active'` 403 stay after the password check (`:503-510`). Rate-limit calls (`:446-452`) and `clearRateLimitKeys` on success (`:570`) are unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// loginCandidates.test.ts
it('returns the only candidate whose password verifies among several');
it('returns null when two candidates verify (same password in two orgs)');
it('verifies every hashed candidate even after a match (no short-circuit)', /* verify spy called candidates.length times */);
it('runs one dummy verify when no candidate has a hash');
it('returns null above the candidate cap after a dummy verify');
// auth.test.ts
it('duplicate-email login is indistinguishable from a bad password', async () => {
  const dup = await login({ email: 'shared@x.test', password: 'SamePass1!' });   // two rows, same password
  const bad = await login({ email: 'solo@x.test', password: 'wrong' });
  expect(dup.status).toBe(401); expect(bad.status).toBe(401);
  expect(await dup.json()).toEqual(await bad.json());                            // { error: 'Invalid email or password' }
  expect(checkRateLimitSpy.mock.calls.map(c => c[0].split(':').slice(0, 3).join(':')))
    .toEqual(['portal:login:ip', expect.stringMatching(/^portal:/)]);           // same two buckets per attempt
  expect(clearRateLimitKeysSpy).not.toHaveBeenCalled();
});
it('duplicate email with different passwords signs in to the org whose password verified');
it('orgId narrows candidates to that org');
it('a password row with browser_access none cannot log in (generic 401)');
```

- [ ] **Step 2: Run them and verify they fail.** The duplicate case currently returns 400.
- [ ] **Step 3: Implement.** Move `getDummyPasswordHash` into `services/password.ts` and import it in both logins.
- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/routes/portal/loginCandidates.test.ts src/routes/portal/auth.test.ts src/routes/auth/login.test.ts` → PASS. Run the integration file → PASS.
- [ ] **Step 5: Commit**: `fix(portal): uniform login failure for emails with several accounts (W2)`

- [ ] **Step 6: PR-B gate.** Same as the Task 4 Step 6 commands: typecheck exit=0, full unit suite, every integration file touched in Tasks 5–9, `test:rls-coverage`, `test:integration-suite-coverage`, then `pnpm test-stack down`. One independent review round. The PR body carries `Closes #11379` and lists D2–D5, the new 409 codes, the removed 400 and the W3 follow-up (delete the legacy-invite branch after 7 days).

---

## Self-review

1. **Spec coverage (W2 row + §5.1/§5.2 + invariants):**
   - `status` CHECK → T1
   - `browser_access` + backfill → T1
   - `UNIQUE (id, org_id)` + identities table, RLS, composite FK, backfill → T1/T2
   - Registration → T2
   - Dual-write + drift report (run, not scheduled) → T3/T4
   - State machine across every writer, bulk narrowing, identity-only 409 → T5/T6/T8
   - Invites grant browser access → T5 initial state
   - Add-in JIT `none` → T4/T5
   - Session requires `granted` → T8 (inv. 9)
   - Purpose-bound atomic tokens with re-validation → T7/T8 (inv. 7). The issued-epoch binding is in W2; policy-version re-check arrives with the W3 resolver.
   - Uniform login → T9 (inv. 8)
   - Inv. 4 (identity org = account org) → composite FK test in T2. The "token from tenant A never uses an account in org B" half is the existing `orgMismatchDenial`, untouched.
2. **Step scan:** every code step names its file and signature. The SQL is given in full because it is the spec of record. No route bodies are transcribed.
3. **Type consistency:** these names are used identically across T1–T9: `PortalAccountStatus`, `PortalBrowserAccess`, `PortalIdentityLinkedVia`, `PortalAccountFacts.hasExternalIdentity`, `planPortalAccountTransition`, `initialPortalAccountState`, `issuePortalCapabilityToken`/`consumePortalCapabilityToken`/`validatePortalCapability`, `insertEntraIdentity`/`ensureEntraIdentity`/`reconcilePortalUserIdentities`.
4. **Review Focus:** all five lines have a named test in their owning task.
5. **Proportion:** the plan describes interfaces, tables and tests. Bodies are left to the implementer, except the migration and the 3-line Lua script.
