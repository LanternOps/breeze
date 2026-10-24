---
spec: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
orchestrator: docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md
wave: W02
tracking_issue: LanternOps/breeze#9906
---

# Wisp W02 — Grants and the Delegation Ceiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the durable delegation-ceiling object (`wisp_grants` + immutable `wisp_grant_revisions`), the human-authority evaluator (`grantAuthority.ts`), and the enforcement hooks in run admission, the run loop, intent release and Operator tasks — API only, dark behind `BREEZE_WISP_ENABLED` — plus the `ai_workspace:execute` permission fix (spec §4.6).

**Architecture:** A grant is created only by its grantor, in an interactive partner-scoped `user_session` with a consumed `wisp_grant` step-up grant, and pins a `ceiling_snapshot` revision. Every consumer resolves `ceiling = pinned revision ∩ grantor's LIVE concrete permissions / org / site reach ∩ agent policy`, with `AGENT_HUMAN_ONLY_TOOLS ∪ AGENT_DENIED_READ_TOOLS` always denied, via one pure function `assertWithinCeiling`. The evaluator runs under the system DB context (agent contexts carry `userId: null` and cannot satisfy a partner-axis policy); the grant it reads is always the one pinned on the run/task, never chosen by the model. Tightening is pushed through the existing per-user permission-cache invalidation choke point plus a 5-minute BullMQ reconciler.

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migrations with forced RLS, BullMQ, Vitest (unit + real-Postgres integration), Zod validators.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md` §3, §4 (all), §9, §13, §14, §15; names/signatures/tables/flags from `docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md` ("Grants (W02)" block) win over anything here.

## Global Constraints

- **Dark by default.** `wispEnabled()` = `isHosted() && envFlag('BREEZE_AI_AGENTS_ENABLED') && envFlag('BREEZE_WISP_ENABLED', false)`, same shape as `aiWorkspaceEnabled()` (`apps/api/src/config/env.ts:324`). With the flag unset nothing in this wave changes runtime behaviour except: the `workspace_*` permission remap (spec §4.6, wanted regardless of the flag) and two nullable columns.
- **Authority is structural.** The `ai_agent` principal stays; no synthetic user, no impersonation, no prompt text widens anything. Every check goes through `assertWithinCeiling`.
- **No new profile, tier or bypass.** W02 must not add to `AI_AGENT_RUN_PROFILES`; the `assessment` profile is W05's.
- **Tenancy ceremony.** RLS enable + force + policies in the creating migration; composite FK to `organizations(id, partner_id)` is `DEFERRABLE INITIALLY IMMEDIATE`; `wisp_grants` (has an `org_id` column) is registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`, `PARTNER_TENANT_TABLES` and `ORG_AXIS_POLICY_EXCLUDED_TABLES`; `wisp_grant_revisions` in `PARTNER_TENANT_TABLES`; every `jsonb` column on an org-cascade table is `excludedOpen`. Org-cascade + export-policy suites run under **Integration Tests** before the PR.
- **Migrations** are `2027-01-04-100100-wisp-grants.sql` and `2027-01-04-100110-ai-workspace-execute-permission.sql` (newest shipped at plan time: `2027-01-03-140000-report-type-client-profitability.sql`; re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing). Idempotent, no inner `BEGIN`/`COMMIT`; a file that writes rows elects `SELECT set_config('breeze.scope', 'system', true);` first. Status/kind columns are `text` + CHECK, never `pgEnum`.
- **Step-up, not `requireMfa()`.** Grant create/refresh consume a `wisp_grant` step-up grant (TTL 600 s; resource digest `sha256:` of `${grantorUserId}:${partnerId}:${orgId ?? '*'}:${requestedCeilingHash}`), the primitive `routes/partnerAiScriptPolicy.ts:140-167` uses.
- **Grants are self-only.** INSERT only by the grantor; UPDATE by the grantor, or by a partner admin restricted to tighten/revoke **plus the two operational settings `budget_cents_per_day` / `floor_tick_minutes` (w00 A6 — budget and tick are not authority)**; nobody substitutes the grantor or widens a revision. Refresh = new revision, never a mutated old one; existing work stays pinned to the revision it was admitted under.
- **Defaults** (spec §4.2, §9, §16; w00 A6): `expires_at` = now + 90 days; `budget_cents_per_day` 200; `floor_tick_minutes` **30** (bounds 15–240); `grantee` `'wisp'`. Plan-driven values arrive with W01/W05.
- **Tests** sit beside source; run one file with `cd apps/api && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`. Red first.
- **No internal hosts/IPs/tokens** in code or examples. Identifiers `wisp_*` / `wisp*`; copy says "Wisp".

## Review Focus

1. **A partner admin with `*:*` is a grantor too.** `permissionKeys` then contains the literal `*:*`; `assertWithinCeiling` must match with the wildcard-aware `permissionGrantMatches`, not set membership, or an admin's own grant denies every tool. Test pinned in Task 6.
2. **A grantor whose live reach shrinks to zero orgs must pause, not merely narrow.** Partial narrowing shrinks the ceiling silently; an empty intersection, a lost partner membership or a lost `ai_sessions:use` is `grantor_access_lost`. Test pinned in Task 8.
3. **Two concurrent `POST /wisp/grants` for the same (grantor, scope).** The partial unique index must make the second a 409, never a second active grant. Test pinned in Task 13.
4. **A run under a revoked grant with an already-approved Tier-3 intent.** Release must refuse with `grant_inactive` and leave the intent `approved` (pausable), not `failed`; a ceiling *violation* is terminal. Tests pinned in Task 11.
5. **An org moved out of the ceiling after admission** (org merge / move). Release re-checks `orgId ∈ ceiling.orgIds` against the LIVE ceiling, so the run's own org can fall out between admission and release. Test pinned in Task 11.

---

## File structure

**Create**
- `apps/api/migrations/2027-01-04-100100-wisp-grants.sql` — tables, RLS, triggers, column adds, `users (id, partner_id)` unique.
- `apps/api/migrations/2027-01-04-100110-ai-workspace-execute-permission.sql` — permission catalog row.
- `apps/api/src/db/schema/wisp.ts` — `wispGrants`, `wispGrantRevisions`, row types, `WispCeilingSnapshot` type.
- `apps/api/src/db/wispGrantsMigration.test.ts`, `apps/api/src/db/aiWorkspaceExecutePermissionMigration.test.ts` — static migration contracts.
- `apps/api/src/services/wisp/grantAuthority.ts` (+ `.test.ts`) — `GrantCeiling`, `resolveGrantCeiling`, `assertWithinCeiling`, errors, `computeLiveHumanTerm`, `ceilingSnapshotHash`.
- `apps/api/src/services/wisp/grants.ts` (+ `.test.ts`) — create/refresh/pause/resume/revoke/getActiveGrantForUser/previewGrantCeiling/listGrants.
- `apps/api/src/services/wisp/grantLifecycle.ts` (+ `.test.ts`) — standing evaluation, `reconcileGrantsForUser`, `reconcileActiveGrants`, `installWispGrantHooks`.
- `apps/api/src/jobs/wispGrantReconciler.ts` — 5-minute repeatable.
- `apps/api/src/routes/wisp.ts` (+ `.test.ts`) — `wispRoutes`.
- `apps/api/src/config/env.wisp.test.ts`.
- `apps/api/src/services/aiAgents/runService.grantAdmission.test.ts`, `apps/api/src/services/aiAgents/runLoop.grantCeiling.test.ts`.
- `apps/api/src/__tests__/integration/wispGrantsRls.integration.test.ts`.

**Modify** (exact sites in each task): `config/env.ts`, `config/validate.ts` (+ `.test.ts`), `.env.example`, `deploy/.env.example`, `services/mfaStepUpGrant.ts` (+ `.test.ts`), `routes/auth/schemas.ts`, `routes/auth/mfa.ts`, `packages/shared/src/constants/permissions.ts` (+ `.test.ts`), `db/seed.ts`, `services/aiGuardrails.ts`, `services/aiGuardrails.workspaceToolSurface.contract.test.ts`, `services/aiGuardrails.workspace.contract.test.ts`, `db/schema/aiAgents.ts`, `db/schema/aiOperatorTasks.ts`, `db/schema/index.ts`, `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `__tests__/integration/rls-coverage.integration.test.ts`, `__tests__/partner-wide-write-coverage.test.ts`, `services/permissions.ts` (+ `.test.ts`), `services/workerRegistry.ts`, `index.ts`, `services/aiAgents/runService.ts`, `services/aiAgents/runLoop.ts`, `services/actionIntents/agentReleaseAuthority.ts` (+ `.test.ts`), `jobs/intentReleaseWorker.ts` (+ `.test.ts`), `services/aiOperator/requesterAccessGate.ts` (+ `.test.ts`), `services/aiOperator/taskService.ts`, `services/aiOperator/taskCoordinator.ts`.

---

### Task 1: `BREEZE_WISP_ENABLED` flag, `wispEnabled()`, boot validation, env docs

**Files:**
- Modify: `apps/api/src/config/env.ts` (after `aiWorkspaceEnabled()`, line 324-330)
- Modify: `apps/api/src/config/validate.ts` (schema block near line 728; production `superRefine` near lines 1544-1573; boolean-format check near lines 2216-2223)
- Modify: `.env.example` (next to `BREEZE_AI_WORKSPACE_ENABLED`, line 1453 block), `deploy/.env.example` (line 529 block)
- Test: `apps/api/src/config/env.wisp.test.ts` (new), `apps/api/src/config/validate.test.ts` (extend the `workspaceProdEnv` describe near line 2929)

**Interfaces:**
- Produces: `export function wispEnabled(): boolean` in `apps/api/src/config/env.ts`.

- [ ] **Step 1: Write the failing env test** (`apps/api/src/config/env.wisp.test.ts`, mirror `env.aiWorkspace.test.ts`)

```ts
import { AI_AGENTS_ENABLED, wispEnabled } from './env';
it('is false by default', () => { delete process.env.BREEZE_WISP_ENABLED; process.env.IS_HOSTED = 'true'; expect(wispEnabled()).toBe(false); });
it('is false self-hosted even when on', () => { process.env.BREEZE_WISP_ENABLED = 'true'; process.env.IS_HOSTED = 'false'; expect(wispEnabled()).toBe(false); });
it('is true only hosted AND flag AND parent', () => { process.env.BREEZE_WISP_ENABLED = 'true'; process.env.IS_HOSTED = 'true'; expect(wispEnabled()).toBe(AI_AGENTS_ENABLED); });
```

- [ ] **Step 2: Run it** — `cd apps/api && npx vitest run src/config/env.wisp.test.ts` → FAIL: `wispEnabled` is not exported.

- [ ] **Step 3: Implement `wispEnabled()`** directly below `aiWorkspaceEnabled()` with the same three-term conjunction and a doc comment citing spec §10 ("deployment switch; the entitlement is the commercial switch").

- [ ] **Step 4: Write the failing validate tests** in `validate.test.ts` inside the production block that owns `workspaceProdEnv`:

```ts
it('refuses BREEZE_WISP_ENABLED=true in production without IS_HOSTED=true', () => {
  withEnv({ ...workspaceProdEnv, IS_HOSTED: 'false', BREEZE_WISP_ENABLED: 'true' }, () => {
    expect(() => validateConfig()).toThrow(/BREEZE_WISP_ENABLED=true requires IS_HOSTED=true/);
  });
});
it('accepts BREEZE_WISP_ENABLED=true in production when hosted', () => {
  withEnv({ ...workspaceProdEnv, BREEZE_WISP_ENABLED: 'true' }, () => { expect(() => validateConfig()).not.toThrow(); });
});
it('rejects a non-boolean BREEZE_WISP_ENABLED', () => {
  withEnv({ ...validEnv, BREEZE_WISP_ENABLED: 'maybe' }, () => { expect(() => validateConfig()).toThrow(/BREEZE_WISP_ENABLED must be a boolean/); });
});
```

- [ ] **Step 5: Run** `npx vitest run src/config/validate.test.ts` → the three new cases FAIL.

- [ ] **Step 6: Implement in `validate.ts`**: add `BREEZE_WISP_ENABLED: z.string().optional()` beside `BREEZE_AI_WORKSPACE_ENABLED` (line 728); in the production `superRefine` add the `IS_HOSTED` coupling with path `['IS_HOSTED']` and message `'BREEZE_WISP_ENABLED=true requires IS_HOSTED=true — Wisp is hosted-only (Wisp design §10).'`; in the boolean-format block (line 2216) add the same check for `BREEZE_WISP_ENABLED` with message `'BREEZE_WISP_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to false (Wisp is dark).'`.

- [ ] **Step 7: Document the flag** in `.env.example` (the hosted block at line 1511 and the AI block at line 1453 — one commented `# BREEZE_WISP_ENABLED=false` line each with a two-line explanation: hosted-only sub-flag of `BREEZE_AI_AGENTS_ENABLED`, production refuses it without `IS_HOSTED=true`) and `deploy/.env.example` (line 529 block).

- [ ] **Step 8: Run both test files** → PASS. Run `npx vitest run src/config/env.aiWorkspace.test.ts` to confirm nothing regressed.

- [ ] **Step 9: Commit** — `feat(wisp): BREEZE_WISP_ENABLED flag, wispEnabled() and boot validation`

---

### Task 2: Migration `2027-01-04-100100-wisp-grants.sql` + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2027-01-04-100100-wisp-grants.sql`
- Create: `apps/api/src/db/schema/wisp.ts`
- Modify: `apps/api/src/db/schema/aiAgents.ts` (`aiAgentRuns`, after `taskAttemptOrdinal` line 197), `apps/api/src/db/schema/aiOperatorTasks.ts` (after `requesterUserId` line 150), `apps/api/src/db/schema/index.ts` (add `export * from './wisp';` after line 85)
- Test: `apps/api/src/db/wispGrantsMigration.test.ts` (new, static), `pnpm db:migrate && pnpm db:check-drift`

**Interfaces:**
- Produces: `wispGrants`, `wispGrantRevisions` (Drizzle tables), `WispGrantRow`, `WispGrantRevisionRow`, and
  ```ts
  export type WispCeilingSnapshot = {
    version: 1;
    permissionKeys: string[];        // concrete `${resource}:${action}` keys incl. a literal '*:*' for admins
    orgIds: string[];                // explicit org list at snapshot time (partner-wide grants list every reachable live org)
    siteIds: string[] | null;        // null = unrestricted
    toolAllowlist: string[] | null;  // null = agent policy default
    deniedTools: string[];
  };
  ```
- Produces: `aiAgentRuns.grantId`, `aiAgentRuns.grantRevisionId`, `aiOperatorTasks.grantId`, `aiOperatorTasks.grantRevisionId` (plain `uuid`, nullable; FKs SQL-only like `task_id`, see `aiAgents.ts:190-195`).

Precedents to copy: shape-3 RLS block from `apps/api/migrations/2026-09-25-time-entry-source-and-suggestion-decisions.sql`; SQL-only composite FK + both-or-none CHECK from `apps/api/migrations/2026-10-14-100000-ai-operator-thin-slice.sql:513-542`; trigger idiom from `ai_agent_runs_immutable_guard` (`2026-09-02-ai-agents.sql`).

- [ ] **Step 1: Write the failing static migration test** (`apps/api/src/db/wispGrantsMigration.test.ts`, pattern `aiModelsPremiumPermissionMigration.test.ts`):

```ts
const FILE = path.resolve(__dirname, '../../migrations/2027-01-04-100100-wisp-grants.sql');
it('exists and has no inner transaction', () => { expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im); });
it('enables + forces RLS on both tables in the creating file', () => {
  for (const t of ['wisp_grants', 'wisp_grant_revisions']) {
    expect(sql).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    expect(sql).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
  }
});
it('makes the org composite FK deferrable', () => {
  expect(sql).toMatch(/wisp_grants_org_partner_fk[\s\S]*?REFERENCES organizations \(id, partner_id\)[\s\S]*?DEFERRABLE INITIALLY IMMEDIATE/);
});
it('uses text + CHECK for status, never an enum', () => { expect(sql).not.toMatch(/CREATE TYPE/i); expect(sql).toMatch(/status IN \('active','paused','revoked','expired'\)/); });
it('adds grant columns to runs and tasks with both-or-none checks', () => {
  for (const t of ['ai_agent_runs', 'ai_operator_tasks']) {
    expect(sql).toContain(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS grant_id uuid`);
    expect(sql).toContain(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS grant_revision_id uuid`);
    expect(sql).toContain(`${t}_grant_link_chk`);
  }
});
it('writes no rows, so it needs no system-scope election', () => { expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b(?![^\n]*--)/); });
```
(The last assertion means: keep DML out of this file; the permission row lives in Task 5's file.)

- [ ] **Step 2: Run it** → FAIL (ENOENT).

- [ ] **Step 3: Write the migration.** Required content, in order:

1. `users (id, partner_id)` unique, idempotent (`DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_id_partner_id_key') THEN ALTER TABLE users ADD CONSTRAINT users_id_partner_id_key UNIQUE (id, partner_id); END IF; END $$;`). `users.partner_id` is NOT NULL (`schema/users.ts:27`) so this always succeeds.
2. `wisp_grants`:
   ```sql
   CREATE TABLE IF NOT EXISTS wisp_grants (
     id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     partner_id           uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
     org_id               uuid NULL,
     grantor_user_id      uuid NOT NULL,
     grantee              text NOT NULL DEFAULT 'wisp',
     current_revision_id  uuid NULL,
     status               text NOT NULL DEFAULT 'active',
     paused_reason        text NULL,
     paused_at            timestamptz NULL,
     revoked_at           timestamptz NULL,
     revoked_by_user_id   uuid NULL REFERENCES users(id) ON DELETE SET NULL,
     expires_at           timestamptz NOT NULL,
     budget_cents_per_day integer NOT NULL DEFAULT 200,
     floor_tick_minutes   integer NOT NULL DEFAULT 30,
     created_at           timestamptz NOT NULL DEFAULT now(),
     updated_at           timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT wisp_grants_status_chk CHECK (status IN ('active','paused','revoked','expired')),
     CONSTRAINT wisp_grants_grantee_chk CHECK (grantee IN ('wisp')),
     CONSTRAINT wisp_grants_paused_reason_chk CHECK (paused_reason IS NULL OR paused_reason IN ('grantor_access_lost','grantor_suspended','factor_expired','entitlement_lost','budget_exhausted','user_paused','partner_disabled')),
     CONSTRAINT wisp_grants_paused_shape_chk CHECK ((status = 'paused') = (paused_reason IS NOT NULL)),
     CONSTRAINT wisp_grants_budget_chk CHECK (budget_cents_per_day >= 0 AND floor_tick_minutes BETWEEN 15 AND 240)
   );
   ```
   Then (each `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`): `wisp_grants_org_partner_fk FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`; `wisp_grants_grantor_partner_fk FOREIGN KEY (grantor_user_id, partner_id) REFERENCES users (id, partner_id) ON DELETE CASCADE`. Indexes: `wisp_grants_partner_idx (partner_id)`, `wisp_grants_grantor_idx (grantor_user_id)`, `wisp_grants_org_idx (org_id) WHERE org_id IS NOT NULL`, and the one-active-per-scope rule `CREATE UNIQUE INDEX IF NOT EXISTS wisp_grants_one_live_per_scope_uq ON wisp_grants (grantor_user_id, partner_id, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status IN ('active','paused')`.
3. `wisp_grant_revisions`:
   ```sql
   CREATE TABLE IF NOT EXISTS wisp_grant_revisions (
     id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     grant_id         uuid NOT NULL REFERENCES wisp_grants(id) ON DELETE CASCADE,
     partner_id       uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
     revision         integer NOT NULL,
     ceiling_snapshot jsonb NOT NULL,
     factor_proof     jsonb NOT NULL,
     created_at       timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT wisp_grant_revisions_id_grant_uq UNIQUE (id, grant_id),
     CONSTRAINT wisp_grant_revisions_grant_rev_uq UNIQUE (grant_id, revision)
   );
   ```
   Then `wisp_grants_current_revision_fk FOREIGN KEY (current_revision_id, id) REFERENCES wisp_grant_revisions (id, grant_id) DEFERRABLE INITIALLY DEFERRED` (the grant row is inserted before its first revision inside one transaction).
4. RLS, both tables `ENABLE` + `FORCE`, policies guarded by `pg_policies` existence checks:
   - `wisp_grants_select`: `FOR SELECT TO breeze_app USING (breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id))`.
   - `wisp_grants_insert`: `FOR INSERT TO breeze_app WITH CHECK (breeze_current_scope() = 'system' OR (breeze_has_partner_access(partner_id) AND grantor_user_id = breeze_current_user_id()))`.
   - `wisp_grants_update`: `FOR UPDATE TO breeze_app USING (system OR breeze_has_partner_access(partner_id)) WITH CHECK (same)` — tighten/revoke restriction lives in the trigger below because RLS cannot compare OLD and NEW.
   - `wisp_grants_delete`: `FOR DELETE TO breeze_app USING (breeze_current_scope() = 'system')` (grants are revoked, never deleted by users; org/partner erasure runs in system scope).
   - `wisp_grant_revisions_select`: system OR partner access. `wisp_grant_revisions_insert`: `system OR (breeze_has_partner_access(partner_id) AND EXISTS (SELECT 1 FROM wisp_grants g WHERE g.id = grant_id AND g.partner_id = wisp_grant_revisions.partner_id AND g.grantor_user_id = breeze_current_user_id()))`. No UPDATE/DELETE policy for revisions (append-only; cascade deletes run as system, and `FORCE` + no policy denies breeze_app).
5. Trigger `wisp_grants_update_guard()` BEFORE UPDATE ON `wisp_grants`:
   - Always: `partner_id`, `org_id`, `grantor_user_id`, `grantee`, `created_at` immutable → `RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'wisp_grants: ownership columns are immutable'`.
   - Terminal: `OLD.status IN ('revoked','expired')` and `NEW.status <> OLD.status` → same ERRCODE, message `'wisp_grants: a revoked or expired grant cannot change status'`.
   - When `breeze_current_scope() <> 'system' AND breeze_current_user_id() IS DISTINCT FROM OLD.grantor_user_id` (a partner admin): allowed changes are exactly `status` → `'paused'` or `'revoked'` with the matching `paused_reason/paused_at` or `revoked_at/revoked_by_user_id`, the two operational settings `budget_cents_per_day` and `floor_tick_minutes` (w00 A6; bounds enforced by `wisp_grants_budget_chk` and the plan limits in the service), plus `updated_at`; any change to `current_revision_id`, `expires_at`, or `status` → `'active'` raises ERRCODE `42501`, message `'wisp_grants: a partner admin may only pause, revoke, or change budget/tick'`.
   - `NEW.updated_at := now()`.
   Create the trigger with `DROP TRIGGER IF EXISTS … ; CREATE TRIGGER wisp_grants_update_guard BEFORE UPDATE ON wisp_grants FOR EACH ROW EXECUTE FUNCTION wisp_grants_update_guard();`.
6. Trigger `wisp_grant_revisions_immutable_guard()` BEFORE UPDATE OR DELETE: raise ERRCODE `42501` unless `breeze_current_scope() = 'system' AND TG_OP = 'DELETE'`.
7. Column adds:
   ```sql
   ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS grant_id uuid;
   ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS grant_revision_id uuid;
   ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_grant_link_chk;
   ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_grant_link_chk CHECK ((grant_id IS NULL) = (grant_revision_id IS NULL));
   ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_grant_revision_fk;
   ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_grant_revision_fk
     FOREIGN KEY (grant_revision_id, grant_id) REFERENCES wisp_grant_revisions (id, grant_id) ON DELETE RESTRICT;
   CREATE INDEX IF NOT EXISTS ai_agent_runs_grant_id_idx ON ai_agent_runs (grant_id) WHERE grant_id IS NOT NULL;
   ```
   and the identical four statements for `ai_operator_tasks` (`ai_operator_tasks_grant_link_chk`, `ai_operator_tasks_grant_revision_fk`, `ai_operator_tasks_grant_id_idx`). `RESTRICT` for the reason `ai_agent_runs_task_org_fk` gives (a column-scoped SET NULL would trip the both-or-none CHECK); erasure order is safe because `cascadeDeletePartner` (`tenantCascade.ts:2597`) deletes child orgs — and so runs/tasks — before the partner-axis sweep, and the org cascade order lists `ai_agent_runs`/`ai_operator_tasks` before `wisp_grants`.
8. `GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_grants TO breeze_app; GRANT SELECT, INSERT ON wisp_grant_revisions TO breeze_app;` and `COMMENT ON TABLE` lines carrying the shape-3-plus-ownership rationale (spec §4.2).

- [ ] **Step 4: Write `apps/api/src/db/schema/wisp.ts`** mirroring the SQL: `pgTable('wisp_grants', …)` with `orgId: uuid('org_id')`, `status: text('status').$type<WispGrantStatus>()`, `pausedReason: text('paused_reason').$type<WispGrantPauseReason>()`, the composite org FK declared via `foreignKey({ columns: [t.orgId, t.partnerId], foreignColumns: [organizations.id, organizations.partnerId], name: 'wisp_grants_org_partner_fk' })`; `pgTable('wisp_grant_revisions', …)` with `ceilingSnapshot: jsonb('ceiling_snapshot').$type<WispCeilingSnapshot>()`, `factorProof: jsonb('factor_proof').$type<{ method: string; verifiedAt: string }>()`. Import only `./orgs`, `./users` and the partners table module — never `./aiAgents` or `./aiOperatorTasks` (they gain plain `uuid('grant_id')` / `uuid('grant_revision_id')` columns with a comment pointing at the SQL-only FK, exactly like `taskId`). Export `WispGrantStatus = 'active' | 'paused' | 'revoked' | 'expired'` and `WispGrantPauseReason`.

- [ ] **Step 5: Apply + drift check** — `export DATABASE_URL=…; pnpm db:migrate && pnpm db:check-drift` → clean. Re-apply once to prove idempotency (second `db:migrate` is a no-op).

- [ ] **Step 6: Run** `npx vitest run src/db/wispGrantsMigration.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts` → PASS.

- [ ] **Step 7: Commit** — `feat(wisp): wisp_grants + wisp_grant_revisions migration and schema (shape 3 + ownership constraints)`

---

### Task 3: Tenancy registrations for `wisp_grants` / `wisp_grant_revisions` and the two new run/task columns

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`ORG_AXIS_POLICY_EXCLUDED_TABLES` near line 137; `PARTNER_TENANT_TABLES` line 235)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, insert between `'webhooks'` line 1112 and the `yara_rule_sets` comment)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (next to `ai_agent_schedules` line 338)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`ai_agent_runs` line 114, `ai_operator_tasks` line 178, new `wisp_grants` entry)

**Interfaces:** none produced; registrations consumed by the contract suites.

- [ ] **Step 1: Run the contract suites red first** (needs `pnpm test-stack up`): `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts` and `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Expected: cascade "every org_id table present" fails on `wisp_grants`; export policy fails on `ai_agent_runs.grant_id` (unclassified column) and `wisp_grants`; merge registry fails `no merge policy registered for 'wisp_grants'`; rls-coverage auto-discovers `wisp_grants` as shape 1 and demands `breeze_has_org_access`.

- [ ] **Step 2: Register**
  - `PARTNER_TENANT_TABLES`: `['wisp_grants', 'partner_id']`, `['wisp_grant_revisions', 'partner_id']`.
  - `ORG_AXIS_POLICY_EXCLUDED_TABLES`: `'wisp_grants'` with the comment: partner-axis (shape 3); `org_id` is the grant's SCOPE (NULL = partner-wide), bound to the partner by the composite FK, not the tenancy axis; functional forge proof in `wispGrantsRls.integration.test.ts`.
  - `CORE_ORG_CASCADE_DELETE_ORDER`: `'wisp_grants'` after `'webhooks'` (alphabetical; children `ai_agent_runs` / `ai_operator_tasks` already precede it).
  - `orgMergeRegistry.ts`: `wisp_grants: { kind: 'leave-for-erasure', note: 'an org-scoped grant borrowed the grantor\'s authority for the LOSER org and its pinned revision names that org; it never follows a merge — the grantor turns Wisp on for the survivor again. Partner-wide grants have org_id NULL and are not merge participants.' }`.
  - `CORE_TENANT_EXPORT_POLICY`: append `"grant_id","grant_revision_id"` to the `included` arrays of `ai_agent_runs` and `ai_operator_tasks`; add `"wisp_grants": tablePolicy("org_id", { included: ["id","partner_id","org_id","grantor_user_id","grantee","current_revision_id","status","paused_reason","paused_at","revoked_at","revoked_by_user_id","expires_at","budget_cents_per_day","floor_tick_minutes","created_at","updated_at"], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })`. (`wisp_grant_revisions` has no `org_id`, so no export entry; its two `jsonb` columns never enter an org export.)

- [ ] **Step 3: Re-run Step 1's suites** → PASS. Also `npx vitest run src/services/orgMerge.test.ts` (the merge engine walk) → PASS.

- [ ] **Step 4: Commit** — `feat(wisp): tenancy registrations for wisp_grants (cascade, merge, export, RLS coverage)`

---

### Task 4: Step-up operation `wisp_grant`

**Files:**
- Modify: `apps/api/src/services/mfaStepUpGrant.ts` (`StepUpOperation` union lines 34-145; `OPERATION_TTL_SECONDS` line 188; digest helpers after line 528)
- Modify: `apps/api/src/routes/auth/schemas.ts` (`STEP_UP_OPERATIONS` lines 162-186; resource schemas + `stepUpResource` union lines 190-326)
- Modify: `apps/api/src/routes/auth/mfa.ts` (`RESOURCE_BOUND_OPERATIONS` lines 1251-1268; digest chain lines 1409-1457)
- Test: `apps/api/src/services/mfaStepUpGrant.test.ts`

**Interfaces:**
- Produces: `'wisp_grant'` in `StepUpOperation`; `stepUpGrantTtlSeconds('wisp_grant') === 600`;
  ```ts
  export function wispGrantResourceDigest(input: { grantorUserId: string; partnerId: string; orgId: string | null; requestedCeilingHash: string }): `sha256:${string}`;
  // canonical = `${grantorUserId}:${partnerId}:${orgId ?? '*'}:${requestedCeilingHash}`
  ```
  `export const wispGrantStepUpResource = z.object({ partnerId: z.string().uuid(), orgId: z.string().uuid().nullable(), requestedCeilingHash: z.string().regex(/^[a-f0-9]{64}$/) })` in `routes/auth/schemas.ts`.

- [ ] **Step 1: Write failing tests** in `mfaStepUpGrant.test.ts`:

```ts
it('wisp_grant grants live 10 minutes', () => { expect(stepUpGrantTtlSeconds('wisp_grant')).toBe(600); });
it('wisp_grant digest binds grantor, partner, scope and the requested ceiling', () => {
  const base = { grantorUserId: 'u1', partnerId: 'p1', orgId: null, requestedCeilingHash: 'a'.repeat(64) };
  expect(wispGrantResourceDigest(base)).toBe(`sha256:${createHash('sha256').update(`u1:p1:*:${'a'.repeat(64)}`).digest('hex')}`);
  expect(wispGrantResourceDigest({ ...base, orgId: 'o1' })).not.toBe(wispGrantResourceDigest(base));
  expect(wispGrantResourceDigest({ ...base, requestedCeilingHash: 'b'.repeat(64) })).not.toBe(wispGrantResourceDigest(base));
});
```

- [ ] **Step 2: Run** `npx vitest run src/services/mfaStepUpGrant.test.ts` → FAIL (type error / undefined export).

- [ ] **Step 3: Implement**: add `| 'wisp_grant'` to the union with a comment (spec §4.2: bound to grantor + scope + requested ceiling; also consumed by refresh); `OPERATION_TTL_SECONDS` gains `wisp_grant: 600`; add `wispGrantResourceDigest`. In `schemas.ts` add `'wisp_grant'` to `STEP_UP_OPERATIONS`, export `wispGrantStepUpResource`, add it to the `stepUpResource` union. In `mfa.ts` add `wisp_grant: wispGrantStepUpResource` to `RESOURCE_BOUND_OPERATIONS` and a branch `body.operation === 'wisp_grant' ? wispGrantResourceDigest({ grantorUserId: auth.user.id, ...(boundResource as z.infer<typeof wispGrantStepUpResource>) })` in the digest chain — the grantor is always the caller, never a body field.

- [ ] **Step 4: Run** the step-up tests and `npx vitest run src/routes/auth/mfa` (substring match — check the reported file count) → PASS.

- [ ] **Step 5: Commit** — `feat(wisp): wisp_grant step-up operation (10 min TTL, grantor+scope+ceiling digest)`

---

### Task 5: `ai_workspace:execute` permission and the `workspace_*` remap (spec §4.6)

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts` (after `AI_MODELS_PREMIUM`, line 229), `packages/shared/src/constants/permissions.test.ts`
- Modify: `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS`, line 122 block)
- Create: `apps/api/migrations/2027-01-04-100110-ai-workspace-execute-permission.sql`, `apps/api/src/db/aiWorkspaceExecutePermissionMigration.test.ts`
- Modify: `apps/api/src/services/aiGuardrails.ts` lines 1353-1356 (+ the LANDMINE comment above them)
- Modify: `apps/api/src/services/aiGuardrails.workspaceToolSurface.contract.test.ts:76-83`, `apps/api/src/services/aiGuardrails.workspace.contract.test.ts:105`

**Interfaces:**
- Produces: `PERMISSION_GRANTS.AI_WORKSPACE_EXECUTE = { resource: 'ai_workspace', action: 'execute' }`; description string (seed and migration must agree): `'Stage, run and collect code in AI sandbox workspaces'`.

- [ ] **Step 1: Flip the two contract tests red first**: in `workspaceToolSurface.contract.test.ts` rename the `it` at line 76 to `'their TOOL_PERMISSIONS mapping is the execute-class ai_workspace:execute (spec §4.6)'` and assert `toEqual({ resource: 'ai_workspace', action: 'execute' })`; same change at `aiGuardrails.workspace.contract.test.ts:105`. Add to `packages/shared/src/constants/permissions.test.ts`: `expect(PERMISSION_GRANTS.AI_WORKSPACE_EXECUTE).toEqual({ resource: 'ai_workspace', action: 'execute' })`. Write `aiWorkspaceExecutePermissionMigration.test.ts` as a copy of `aiModelsPremiumPermissionMigration.test.ts` pointed at the new file, with the same four assertions (system scope before the first write; description matches `DEFAULT_PERMISSIONS`; explicit existence check, no `ON CONFLICT`; no `role_permissions`, no inner `BEGIN`).

- [ ] **Step 2: Run** `npx vitest run src/services/aiGuardrails.workspaceToolSurface.contract.test.ts src/services/aiGuardrails.workspace.contract.test.ts src/db/aiWorkspaceExecutePermissionMigration.test.ts` and `cd packages/shared && npx vitest run src/constants/permissions.test.ts` → FAIL.

- [ ] **Step 3: Implement**: add the grant to `PERMISSION_GRANTS` with a comment (execute-class; Partner Admin holds it through `*:*`; seeded on no other role); add the row to `DEFAULT_PERMISSIONS`; write the migration (copy `2026-11-19-100100-ai-models-premium-permission.sql`: `set_config` first, `INSERT … SELECT 'ai_workspace','execute','<description>' WHERE NOT EXISTS (…)`, no role grant); change the four `TOOL_PERMISSIONS` entries to `{ resource: 'ai_workspace', action: 'execute' }` and rewrite the LANDMINE comment to a closed note ("raised to execute-class by Wisp W02; `resolveWorkspace` still answers non-agent principals with `workspace_requires_run`").

- [ ] **Step 4: Run** Step 2's files plus `npx vitest run src/services/aiToolPermissionsCatalogParity.contract.test.ts src/services/aiGuardrails.routeBinding.contract.test.ts src/db/seed.test.ts` → PASS. `pnpm db:migrate && pnpm db:check-drift` → clean.

- [ ] **Step 5: Commit** — `feat(ai): ai_workspace:execute permission; workspace_* tools require it (Wisp §4.6)`

---

### Task 6: `services/wisp/grantAuthority.ts` — the human-authority evaluator

**Files:**
- Create: `apps/api/src/services/wisp/grantAuthority.ts`
- Modify: `apps/api/src/services/aiGuardrails.ts` — export a thin wrapper around the private `resolveToolPermissionRequirements` (line 2808)
- Test: `apps/api/src/services/wisp/grantAuthority.test.ts`

**Interfaces:**
- Consumes: `getUserPermissions(userId, { partnerId, scope: 'partner' }, { bypassCache: true })` (`services/permissions.ts:195`), `computeAccessibleOrgIds('partner', partnerId, null, userId)` (`middleware/auth.ts:406`), `permissionGrantMatches` (`services/permissionMatching.ts:14`), `AGENT_HUMAN_ONLY_TOOLS`, `AGENT_DENIED_READ_TOOLS` (`services/aiToolExposure.ts`), `wispGrants`, `wispGrantRevisions` (Task 2), `users.status` (`'active' | 'invited' | 'disabled'`).
- Produces (exactly the w00 block):
  ```ts
  export type GrantCeiling = { grantId; revisionId; partnerId; grantorUserId: string /* w00 A3 — W03's broker and W05's watches read it; no second lookup */; orgIds: ReadonlySet<string>; siteIds: ReadonlySet<string> | null; permissionKeys: ReadonlySet<string>; toolAllowlist: ReadonlySet<string> | null; deniedTools: ReadonlySet<string>; status: WispGrantStatus };
  export async function resolveGrantCeiling(grantId: string, revisionId: string): Promise<GrantCeiling>; // throws GrantInactiveError when status !== 'active'
  export type CeilingCheck = { toolName?: string; permission?: string; orgId?: string | null; siteId?: string | null };
  export function assertWithinCeiling(ceiling: GrantCeiling, check: CeilingCheck): void;
  export class GrantInactiveError extends Error { constructor(public readonly grantId: string, public readonly status: WispGrantStatus) }
  export class CeilingViolationError extends Error { code: 'org' | 'site' | 'permission' | 'tool' | 'inactive' }
  ```
  plus W02-internal helpers used by Tasks 7/8:
  ```ts
  export type LiveHumanTerm = { ok: true; permissionKeys: string[]; orgIds: string[]; siteIds: string[] | null; partnerOrgAccess: 'all' | 'selected' | 'none' } | { ok: false; reason: 'grantor_suspended' | 'grantor_access_lost' };
  export async function computeLiveHumanTerm(userId: string, partnerId: string): Promise<LiveHumanTerm>; // system ctx; `ok:false` when user missing/not 'active' (suspended), no partner membership, lacks ai_sessions:use, or zero reachable orgs (access_lost)
  export function ceilingSnapshotHash(snapshot: WispCeilingSnapshot): string; // sha256 hex of canonical JSON (sorted keys, sorted arrays)
  export function intersectSnapshotWithLive(snapshot: WispCeilingSnapshot, live: Extract<LiveHumanTerm, { ok: true }>): Pick<GrantCeiling, 'orgIds' | 'siteIds' | 'permissionKeys'>;
  ```
  and in `aiGuardrails.ts`: `export function toolPermissionRequirements(toolName: string, input: Record<string, unknown>): { resource: string; action: string }[] | null` (null = no mapping / unresolvable action).

- [ ] **Step 1: Write failing tests** for the pure parts (`grantAuthority.test.ts`, no db needed):

```ts
const ceiling = (o: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: 'g', revisionId: 'r', partnerId: 'p', grantorUserId: 'u1', status: 'active',
  orgIds: new Set(['org-a']), siteIds: null, permissionKeys: new Set(['devices:read', 'tickets:write']),
  toolAllowlist: null, deniedTools: new Set([...AGENT_HUMAN_ONLY_TOOLS, ...AGENT_DENIED_READ_TOOLS.keys()]), ...o });
it('passes a check inside every term', () => { expect(() => assertWithinCeiling(ceiling(), { toolName: 'get_device', permission: 'devices:read', orgId: 'org-a' })).not.toThrow(); });
it('throws code org for an org outside the ceiling', () => { expect(() => assertWithinCeiling(ceiling(), { orgId: 'org-b' })).toThrow(expect.objectContaining({ code: 'org' })); });
it('throws code site when siteIds is set and the site is outside', () => { expect(() => assertWithinCeiling(ceiling({ siteIds: new Set(['s1']) }), { orgId: 'org-a', siteId: 's2' })).toThrow(expect.objectContaining({ code: 'site' })); });
it('siteId null with a site-restricted ceiling is a violation (unknown site never widens)', () => { expect(() => assertWithinCeiling(ceiling({ siteIds: new Set(['s1']) }), { orgId: 'org-a', siteId: null })).toThrow(expect.objectContaining({ code: 'site' })); });
it('throws code permission for a key the grantor does not hold', () => { expect(() => assertWithinCeiling(ceiling(), { permission: 'scripts:execute' })).toThrow(expect.objectContaining({ code: 'permission' })); });
it('a wildcard grantor (*:*) satisfies any permission', () => { expect(() => assertWithinCeiling(ceiling({ permissionKeys: new Set(['*:*']) }), { permission: 'scripts:execute' })).not.toThrow(); });
it('throws code tool for AGENT_HUMAN_ONLY_TOOLS even with a null allowlist', () => { expect(() => assertWithinCeiling(ceiling(), { toolName: 'manage_ai_agents' })).toThrow(expect.objectContaining({ code: 'tool' })); });
it('throws code tool for AGENT_DENIED_READ_TOOLS (Tier-1 reads are inside the ceiling)', () => { expect(() => assertWithinCeiling(ceiling(), { toolName: 'get_user_risk_scores' })).toThrow(expect.objectContaining({ code: 'tool' })); });
it('throws code tool when an allowlist is set and the tool is absent', () => { expect(() => assertWithinCeiling(ceiling({ toolAllowlist: new Set(['get_device']) }), { toolName: 'list_alerts' })).toThrow(expect.objectContaining({ code: 'tool' })); });
it('throws code inactive before any other term', () => { expect(() => assertWithinCeiling(ceiling({ status: 'paused' }), { orgId: 'org-b' })).toThrow(expect.objectContaining({ code: 'inactive' })); });
it('ceilingSnapshotHash is order-independent and 64 hex chars', () => {
  const a = { version: 1 as const, permissionKeys: ['a:b', 'c:d'], orgIds: ['o2', 'o1'], siteIds: null, toolAllowlist: null, deniedTools: [] };
  const b = { ...a, permissionKeys: ['c:d', 'a:b'], orgIds: ['o1', 'o2'] };
  expect(ceilingSnapshotHash(a)).toBe(ceilingSnapshotHash(b)); expect(ceilingSnapshotHash(a)).toMatch(/^[a-f0-9]{64}$/);
});
it('intersectSnapshotWithLive never widens any term', () => {
  const out = intersectSnapshotWithLive({ version: 1, permissionKeys: ['devices:read', 'tickets:write'], orgIds: ['o1', 'o2'], siteIds: null, toolAllowlist: null, deniedTools: [] },
    { ok: true, permissionKeys: ['devices:read'], orgIds: ['o2', 'o3'], siteIds: ['s1'], partnerOrgAccess: 'selected' });
  expect([...out.orgIds]).toEqual(['o2']); expect([...out.permissionKeys]).toEqual(['devices:read']); expect([...out.siteIds!]).toEqual(['s1']);
});
```
And for `resolveGrantCeiling` / `computeLiveHumanTerm` with `../../db`, `../permissions`, `../../middleware/auth` mocked (pattern: `requesterAccessGate.test.ts`):
```ts
it('computeLiveHumanTerm → grantor_suspended when users.status is disabled', …);
it('computeLiveHumanTerm → grantor_access_lost when getUserPermissions returns null (no partner membership)', …);
it('computeLiveHumanTerm → grantor_access_lost when ai_sessions:use is not held', …);
it('computeLiveHumanTerm → grantor_access_lost when computeAccessibleOrgIds yields []', …);
it('resolveGrantCeiling throws GrantInactiveError for status paused without computing the live term', …);
it('resolveGrantCeiling intersects snapshot ∩ live and unions deniedTools with both agent deny registries', …);
it('resolveGrantCeiling refuses a revision that belongs to another grant (GrantInactiveError)', …);
it('resolveGrantCeiling returns status active but live term ok:false ⇒ throws GrantInactiveError (fail closed; the reconciler pauses the row)', …);
```

- [ ] **Step 2: Run** `npx vitest run src/services/wisp/grantAuthority.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `grantAuthority.ts`.** `assertWithinCeiling` evaluation order: `status !== 'active'` → `inactive`; `toolName` in `deniedTools` → `tool`; `toolAllowlist !== null && !toolAllowlist.has(toolName)` → `tool`; `orgId` given and `!orgIds.has(orgId)` → `org`; `siteIds !== null` and (`siteId == null || !siteIds.has(siteId)`) → `site` (only when `orgId` or `siteId` was supplied); `permission` given and no key in `permissionKeys` for which `permissionGrantMatches({resource, action}, reqResource, reqAction)` holds → `permission`. `resolveGrantCeiling` runs `runOutsideDbContext(() => withSystemDbAccessContext(…))`, loads grant + revision (asserting `revision.grantId === grantId`), throws `GrantInactiveError` unless `status === 'active'` and `expiresAt > now`, then `computeLiveHumanTerm(grant.grantorUserId, grant.partnerId)`; `ok:false` → `GrantInactiveError` (the reconciler, Task 8, persists the pause); `grantorUserId` = `grant.grantorUserId`; `toolAllowlist` = snapshot's list as a Set or null; `deniedTools` = snapshot denies ∪ `AGENT_HUMAN_ONLY_TOOLS` ∪ `AGENT_DENIED_READ_TOOLS.keys()`. `computeLiveHumanTerm`: user row (`status`, `partnerId`), `getUserPermissions(userId, { partnerId, scope: 'partner' }, { bypassCache: true })`, require `hasPermission(perms, 'ai_sessions', 'use')`, `computeAccessibleOrgIds('partner', partnerId, null, userId)`; `permissionKeys = perms.permissions.map(permissionKey)`; `siteIds = perms.allowedSiteIds ?? null`. In `aiGuardrails.ts` add the exported `toolPermissionRequirements` wrapper returning `resolution.ok ? resolution.requirements : null`.

- [ ] **Step 4: Run the test file** → PASS. `npx vitest run src/services/aiGuardrails.workspaceToolSurface.contract.test.ts` still PASS (export is additive).

- [ ] **Step 5: Commit** — `feat(wisp): grantAuthority evaluator — resolveGrantCeiling + assertWithinCeiling`

---

### Task 7: `services/wisp/grants.ts` — create / refresh / pause / resume / revoke / lookup

**Files:**
- Create: `apps/api/src/services/wisp/grants.ts`
- Test: `apps/api/src/services/wisp/grants.test.ts` (guards only; DB behaviour is Task 13)

**Interfaces:**
- Consumes: Task 4's `consumeStepUpGrant`, `wispGrantResourceDigest`; `getUserEpochs` (`services/authEpochs.ts`); `hasSatisfiedMfa` (`middleware/auth.ts`); `canManagePartnerWidePolicies` (`services/partnerWideAccess.ts:25`); Task 6's `computeLiveHumanTerm`, `ceilingSnapshotHash`; `createAuditLogAsync` (`services/auditService.ts:126`); W01's `getEntitlementLimits(partnerId, 'wisp'): Promise<unknown | null>` (`services/entitlements.ts`, W01 Task 4) parsed with `wispLimitsSchema` (`@breeze/shared`, W01 Task 2) — imported lazily (`await import('../entitlements')`) and treated as `null` limits when the module or the row is absent, so W02 merges and runs before W01 without a cap.
- Produces (w00 block verbatim, plus two W02 helpers the routes need):
  ```ts
  export type WispGrantScope = { partnerId: string; orgId: string | null };
  export type WispGrantStatus = 'active' | 'paused' | 'revoked' | 'expired';
  export type WispGrant = { id; partnerId; orgId: string | null; grantorUserId; grantee: 'wisp'; currentRevisionId; status: WispGrantStatus; pausedReason: string | null; expiresAt: Date; budgetCentsPerDay: number; floorTickMinutes: number };
  export async function createGrant(input: { auth: AuthContext; scope: WispGrantScope; stepUpGrantId: string }): Promise<WispGrant>;
  export async function refreshGrant(input: { auth: AuthContext; grantId: string; stepUpGrantId: string }): Promise<WispGrant>;
  export async function pauseGrant(grantId: string, reason: 'grantor_access_lost' | 'grantor_suspended' | 'factor_expired' | 'entitlement_lost' | 'budget_exhausted' | 'user_paused' | 'partner_disabled'): Promise<void>; // 'user_paused' / 'partner_disabled' added 2026-10-23 (w00 A29, A35)
  export async function resumeGrant(grantId: string): Promise<void>;
  export async function revokeGrant(input: { auth: AuthContext; grantId: string }): Promise<void>;
  export async function getActiveGrantForUser(userId: string, scope: WispGrantScope): Promise<WispGrant | null>;
  // W02 helpers
  export async function previewGrantCeiling(input: { auth: AuthContext; scope: WispGrantScope }): Promise<{ scope: WispGrantScope; ceilingSnapshot: WispCeilingSnapshot; ceilingHash: string }>; // w00 A4 shape; ceilingHash = ceilingSnapshotHash(ceilingSnapshot) is the step-up resource the client mints against
  export async function listGrants(input: { auth: AuthContext; view: 'mine' | 'partner' }): Promise<WispGrant[]>;
  export type GrantSettingsBounds = { budgetCentsPerDayMax: number; minFloorTickMinutes: number }; // W05 derives plan bounds from W01 entitlements; W02 alone uses the static { 5000, 15 }
  export async function updateGrantSettings(input: { auth: AuthContext; grantId: string; patch: { budgetCentsPerDay?: number; floorTickMinutes?: number }; bounds?: GrantSettingsBounds }): Promise<WispGrant>; // w00 A6: grantor or canManagePartnerWidePolicies; ≥1 key; floorTickMinutes ∈ [bounds.minFloorTickMinutes, 240]; budgetCentsPerDay ∈ [0, bounds.budgetCentsPerDayMax]; never touches the revision
  export async function wideningAvailable(grantId: string): Promise<boolean>; // spec §4.4: true when computeLiveHumanTerm has an org id or permission key the current revision's snapshot lacks (live ⊋ snapshot); false when equal, narrower, or the live term is ok:false
  export class WispGrantError extends Error { constructor(public readonly code: 'not_user_session' | 'partner_mismatch' | 'org_out_of_reach' | 'mfa_required' | 'step_up_required' | 'grantor_access_lost' | 'grantor_suspended' | 'not_found' | 'forbidden' | 'already_active' | 'not_active' | 'settings_out_of_bounds', message: string) }
  export class GrantLimitReachedError extends Error { readonly code = 'grant_limit_reached'; constructor(public readonly partnerId: string, public readonly maxGrants: number, public readonly active: number) } // W01 WispLimits.maxGrants; route → 409
  export async function resolveMaxGrants(partnerId: string): Promise<number | null>; // wispLimitsSchema.safeParse(await getEntitlementLimits(partnerId, 'wisp')) → limits.maxGrants; null when the entitlements module is absent, the limits are null, or parsing fails (⇒ no cap)
  ```
  `createGrant`/`refreshGrant` run in the caller's request DB context (RLS INSERT-by-grantor is part of the contract); `pauseGrant`/`resumeGrant` run in system context (`runOutsideDbContext(withSystemDbAccessContext)`) because their callers are workers.

- [ ] **Step 1: Write failing guard tests** (`grants.test.ts`, `../../db` + `../mfaStepUpGrant` + `./grantAuthority` mocked):

```ts
it('createGrant refuses a non-user_session principal with not_user_session before touching step-up', …);
it('createGrant refuses auth.partnerId !== scope.partnerId with partner_mismatch', …);
it('createGrant refuses an orgId the caller cannot reach (auth.canAccessOrg false) with org_out_of_reach', …);
it('createGrant refuses when hasSatisfiedMfa(auth) is false with mfa_required', …);
it('createGrant binds the consumed step-up to { userId: auth.user.id, operation: "wisp_grant", authEpoch, mfaEpoch, sid, resourceDigest: wispGrantResourceDigest({ grantorUserId, partnerId, orgId, requestedCeilingHash: ceilingSnapshotHash(liveSnapshot) }) } and maps a false consume to step_up_required', …);
it('createGrant writes factor_proof as { method, verifiedAt } only — never the step-up grant id', …);
it('createGrant sets expiresAt = now + 90 days, budgetCentsPerDay 200, floorTickMinutes 30, grantee wisp', …);
it('createGrant throws GrantLimitReachedError (code grant_limit_reached) when the partner\'s count of status=active grants ≥ limits.maxGrants, before consuming the step-up and before any insert', …); // getEntitlementLimits mocked → { maxGrants: 2, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 }; count mocked 2
it('createGrant admits when active count < maxGrants (count 1 of 2); paused/revoked/expired rows are not counted', …);
it('createGrant applies no cap when getEntitlementLimits resolves null or the entitlements module cannot be imported (W01 not merged)', …); // vi.doMock('../entitlements', () => { throw … }) and a null-resolving variant
it('refreshGrant inserts revision n+1 and never updates the previous revision row', …);
it('updateGrantSettings: grantor may change budget/tick; a partner admin (canManagePartnerWidePolicies) may too; another tech → forbidden', …);
it('updateGrantSettings rejects floorTickMinutes 14 and 241, budget above bounds.budgetCentsPerDayMax, and an empty patch (settings_out_of_bounds); currentRevisionId is untouched', …);
it('wideningAvailable is true when live orgIds or permissionKeys exceed the current snapshot, false when equal or narrower, false when the live term is ok:false', …);
it('revokeGrant by a non-grantor who is not canManagePartnerWidePolicies → forbidden', …);
it('revokeGrant by a partner admin succeeds and stamps revoked_by_user_id = admin', …);
it('pauseGrant is a no-op on a revoked grant (never resurrects a terminal row)', …);
it('resumeGrant only moves paused → active', …);
```

- [ ] **Step 2: Run** `npx vitest run src/services/wisp/grants.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Order inside `createGrant`: principal/scope/org/mfa guards → **grant cap**: `max = await resolveMaxGrants(scope.partnerId)`; when `max !== null`, `active = SELECT count(*) FROM wisp_grants WHERE partner_id = $1 AND status = 'active'` (request context; the partner SELECT branch sees every grant of the partner); `active >= max` → `throw new GrantLimitReachedError(partnerId, max, active)` (spec §10 `limits.maxGrants`; checked before the step-up is consumed so a refused attempt does not burn the proof) → `computeLiveHumanTerm(auth.user.id, scope.partnerId)` (`ok:false` → its reason as a `WispGrantError`) → build `snapshot` (`orgIds` = live orgIds ∩ (`scope.orgId ? [scope.orgId] : all`), `permissionKeys`, `siteIds`, `toolAllowlist: null`, `deniedTools: [...AGENT_HUMAN_ONLY_TOOLS, ...AGENT_DENIED_READ_TOOLS.keys()]`) → `consumeStepUpGrant` with the digest built from `ceilingSnapshotHash(snapshot)` → one transaction: insert grant (`currentRevisionId: null`), insert revision 1 (`factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() }`), update `currentRevisionId`; a 23505 on `wisp_grants_one_live_per_scope_uq` → `already_active`. `refreshGrant`: same guards; the grant must be `active` or `paused` and `grantorUserId === auth.user.id`; new revision `max(revision)+1`; update `currentRevisionId`; a paused grant stays paused. `revokeGrant`: grantor or `canManagePartnerWidePolicies(auth)`; sets `status 'revoked'`, `revokedAt`, `revokedByUserId`. Every mutation calls `createAuditLogAsync({ partnerId, orgId: scope.orgId, actorType: 'user', actorId, action: 'wisp.grant.<created|refreshed|revoked|paused|resumed>', resourceType: 'wisp_grant', resourceId, details: { revisionId, reason? } })`. `previewGrantCeiling` returns the snapshot the create path would compute and its hash (the client mints the step-up against this hash; a reach change between preview and create fails the binding → `step_up_required`). `updateGrantSettings` runs in the request context (RLS + the update trigger allow the grantor and a partner admin), audits `wisp.grant.settings_changed` with `{ from, to }`, and defaults `bounds` to `{ budgetCentsPerDayMax: 5000, minFloorTickMinutes: 15 }` (W05 passes plan bounds). `wideningAvailable` compares the live term against `current_revision_id`'s `ceiling_snapshot` set-wise and runs in system context.

- [ ] **Step 3b: Route step for the cap** (lands in `routes/wisp.ts`, created in Task 9 — add it to Task 9's error map when that file is written): `GrantLimitReachedError` → 409 `c.json({ error: \`This partner already has ${active} active Wisp grants (plan limit ${maxGrants}).\`, code: 'GRANT_LIMIT_REACHED' }, 409)`, and the Task 9 test `it('POST /grants maps GrantLimitReachedError to 409 GRANT_LIMIT_REACHED', …)`. (Concurrency note: two simultaneous creates at `max − 1` can both pass the count; the cap is a commercial limit, not an authority term, so a transient +1 is accepted and the next create refuses.)

- [ ] **Step 4: Run the test file** → PASS.

- [ ] **Step 5: Commit** — `feat(wisp): grants service — create/refresh/revoke with step-up, maxGrants cap, pause/resume for workers`

---

### Task 8: Pause/resume hooks — permission-change listener, lifecycle, 5-minute reconciler

**Files:**
- Modify: `apps/api/src/services/permissions.ts` (`clearPermissionCache`, line 389), `apps/api/src/services/permissions.test.ts`
- Create: `apps/api/src/services/wisp/grantLifecycle.ts` (+ `.test.ts`), `apps/api/src/jobs/wispGrantReconciler.ts`
- Modify: `apps/api/src/services/workerRegistry.ts` (`WORKER_REGISTRY`, line 88; add next to `quickSupportReaper` ~line 760), `apps/api/src/index.ts` (boot: directly after `await clearPermissionCache();` at line 1781)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (`ALLOWED_WITHOUT_CAPABILITY_CHECK`, line 64)

**Interfaces:**
- Produces in `permissions.ts`:
  ```ts
  export type PermissionChangeListener = (userId: string) => Promise<void>;
  export function onPermissionAuthorityChanged(listener: PermissionChangeListener): () => void; // returns unsubscribe
  ```
  `clearPermissionCache(userId)` awaits every listener for a per-user clear (each in its own try/catch; a listener error is logged and never propagates); the no-arg global clear calls none. This is the choke point every status change (`routes/users.ts:2023` → `authLifecycle.runPostCommitCleanup` → `clearPermissionCache`), role assignment (`routes/users.ts:2469/2490`), org-access change (`routes/users.ts:2583`) and role-permission edit (`routes/roles.ts:337`) already passes through.
- Produces in `grantLifecycle.ts`:
  ```ts
  export type GrantStanding = { kind: 'ok' } | { kind: 'pause'; reason: 'grantor_access_lost' | 'grantor_suspended' } | { kind: 'expired' };
  export async function evaluateGrantStanding(grant: Pick<WispGrantRow, 'id' | 'grantorUserId' | 'partnerId' | 'expiresAt' | 'currentRevisionId'>): Promise<GrantStanding>;
  export async function reconcileGrantsForUser(userId: string): Promise<{ paused: number; resumed: number; expired: number }>;
  export async function reconcileActiveGrants(now?: Date): Promise<{ scanned: number; paused: number; resumed: number; expired: number }>;
  export function installWispGrantHooks(): () => void; // registers reconcileGrantsForUser via onPermissionAuthorityChanged; no-op (returns noop) when !wispEnabled()
  ```
  Semantics: `active` + standing `pause` → `pauseGrant(id, reason)`; `active`/`paused` + past `expiresAt` → status `'expired'` (system-context update); `paused` with `pausedReason ∈ {grantor_access_lost, grantor_suspended}` + standing `ok` → `resumeGrant(id)`; other pause reasons are left alone (their owners — W01 entitlements, W05 budget — resume them).
- Produces in `jobs/wispGrantReconciler.ts`: `initializeWispGrantReconciler()`, `shutdownWispGrantReconciler()`; queue `'wisp-grant-reconciler'`, job `'reconcile'`, `repeat: { every: 5 * 60 * 1000 }` (sub-hourly → `every:` per `scheduleRegistry.ts`), remove-then-add idiom from `jobs/quickSupportReaper.ts:221-237`; the processor returns `{ skipped: true }` without touching the DB when `!wispEnabled()` so the flag can flip without a restart.

- [ ] **Step 1: Write failing tests**
  - `permissions.test.ts`: `it('clearPermissionCache(userId) awaits registered listeners and isolates a throwing one')`, `it('clearPermissionCache() with no userId calls no listener')`, `it('the unsubscribe handle removes the listener')`.
  - `grantLifecycle.test.ts` (`./grants`, `./grantAuthority`, `../../db` mocked): `evaluateGrantStanding` → `expired` when `expiresAt < now`; `pause:grantor_suspended` when `computeLiveHumanTerm` is `ok:false/grantor_suspended`; `pause:grantor_access_lost` when live orgIds ∩ snapshot orgIds is empty even though the live term is `ok`; `ok` otherwise. `reconcileActiveGrants`: pauses active rows with bad standing, resumes `paused/grantor_access_lost` rows with good standing, never touches `paused/entitlement_lost`, expires both. `installWispGrantHooks` returns a noop and registers nothing when `wispEnabled()` is false.
  - `workerRegistry.test.ts`: its "losslessness" block pins the exact known-names list in order (line 131) and the entry count (line 135) — add `'wispGrantReconciler'` to the list directly after `'quickSupportReaper'` and bump the count, then assert `placement: 'global'` the way the m365 retention case does (line 146). Run `workerEntrypointClosure.contract.test.ts`; if it flips the entry to `'socket-owner'`, accept the tool's answer — do not reason about it.

- [ ] **Step 2: Run** the three files → FAIL.

- [ ] **Step 3: Implement** the listener registry, `grantLifecycle.ts`, the job module, the registry entry (`load: async () => { const m = await import('../jobs/wispGrantReconciler'); return { init: m.initializeWispGrantReconciler, shutdown: m.shutdownWispGrantReconciler }; }`), and in `index.ts` after line 1781: `if (wispEnabled()) installWispGrantHooks();`. Add to `ALLOWED_WITHOUT_CAPABILITY_CHECK`: `'services/wisp/grantLifecycle.ts': 'worker/system path: only ever TIGHTENS a grant (pause/expire) or restores a pause it caused itself; the caller-facing create/refresh/revoke gates live in services/wisp/grants.ts'` and `'services/wisp/grants.ts'` needs no entry (it references `canManagePartnerWidePolicies`).

- [ ] **Step 4: Run** Step 1's files plus `npx vitest run src/__tests__/partner-wide-write-coverage.test.ts src/services/workerRegistry` (check file count) → PASS.

- [ ] **Step 5: Commit** — `feat(wisp): grant lifecycle — permission-change listener, standing reconciler (5 min)`

---

### Task 9: Routes `POST/GET /api/v1/wisp/grants…` behind `wispEnabled()`

**Files:**
- Create: `apps/api/src/routes/wisp.ts`, `apps/api/src/routes/wisp.test.ts`
- Modify: `apps/api/src/index.ts` (import near line 202; mount `api.route('/wisp', wispRoutes);` beside the `/ai/operator` mount at line 1109)

**Interfaces:**
- Consumes: Task 7 service; `authMiddleware`, `requirePermission`, `requireScope`, `requireMfa` (`middleware/auth.ts`); `zValidator` (`lib/validation`); `writeRouteAudit` (`services/auditEvents.ts:225`).
- Produces: `export const wispRoutes = new Hono()` with
  - `GET  /grants/preview?orgId=` → `{ scope, ceilingSnapshot, ceilingHash }` (w00 A4; the client mints the `wisp_grant` step-up with resource `{ partnerId, orgId, requestedCeilingHash: ceilingHash }`)
  - `POST /grants` body `{ orgId: uuid | null, stepUpGrantId: string }` → 201 `WispGrantDto`
  - `POST /grants/:id/refresh` body `{ stepUpGrantId }` → 200
  - `POST /grants/:id/revoke` → 200 `{ success: true }`
  - `PATCH /grants/:id/settings` body `z.strictObject({ budgetCentsPerDay: z.number().int().min(0).optional(), floorTickMinutes: z.number().int().min(15).max(240).optional() })` (≥ 1 key) → 200 `WispGrantDto` (w00 A6; calls `updateGrantSettings`; `settings_out_of_bounds` → 400 `{ error, code: 'SETTINGS_OUT_OF_BOUNDS' }`; `forbidden` → 403; no step-up — budget/tick are not authority)
  - `GET  /grants?view=mine|partner` → `{ grants: WispGrantDto[] }` (`partner` requires `canManagePartnerWidePolicies`, else 403)
  - Middleware order: `authMiddleware` → a first `use('*')` that returns `c.json({ error: 'Not found' }, 404)` when `!wispEnabled()` (evaluated per request) → `requireScope('partner')` → `requirePermission('ai_sessions', 'use')`; mutations additionally `requireMfa()`. `WispGrantError` codes map: `step_up_required`/`mfa_required` → 403 `{ error, code: 'STEP_UP_REQUIRED' | 'MFA_REQUIRED' }`; `forbidden` → 403; `not_found` → 404; `already_active` → 409; `org_out_of_reach`/`partner_mismatch` → 404 (non-enumerating); `grantor_*` → 409 with the code. `WispGrantDto` is field-by-field (never `{...row}`), no `factor_proof`, no snapshot.
  - Routes do NOT add `requireEntitlement('wisp')` (W01/W04); leave a one-line TODO naming W04.

- [ ] **Step 1: Write failing route tests** (`routes/wisp.test.ts`; mock `../config/env` `wispEnabled`, `../services/wisp/grants`, auth via the pattern in `routes/aiOperatorTasks.test.ts:44-52`):

```ts
it('every route is 404 when wispEnabled() is false (list, preview, create, refresh, revoke)', …);
it('POST /grants is 403 for an organization-scoped token', …);
it('POST /grants is 403 without ai_sessions:use', …);
it('POST /grants maps step_up_required to 403 STEP_UP_REQUIRED', …);
it('POST /grants returns 201 with a DTO that has no factorProof/ceilingSnapshot keys', …);
it('GET /grants?view=partner is 403 when canManagePartnerWidePolicies is false', …);
it('POST /grants/:id/revoke with a non-uuid id is 404, not a 22P02', …);
it('PATCH /grants/:id/settings { floorTickMinutes: 60 } → 200 for the grantor and for a partner admin; { } → 400; { floorTickMinutes: 10 } → 400; another tech → 403', …);
it('POST /grants maps GrantLimitReachedError to 409 GRANT_LIMIT_REACHED', …);   // Task 7 Step 3b
it('GET /grants/preview returns { scope, ceilingSnapshot, ceilingHash } with a 64-hex ceilingHash', …);
```

- [ ] **Step 2: Run** `npx vitest run src/routes/wisp.test.ts` → FAIL.

- [ ] **Step 3: Implement** `routes/wisp.ts` and the mount; `writeRouteAudit(c, { orgId, partnerId, action: 'wisp.grant.created' | 'wisp.grant.refreshed' | 'wisp.grant.revoked' | 'wisp.grant.settings_changed', resourceType: 'wisp_grant', resourceId })` on each mutation.

- [ ] **Step 4: Run the test file** → PASS; `npx vitest run src/index.agentAdmission.test.ts` unaffected.

- [ ] **Step 5: Commit** — `feat(wisp): grant routes (preview/create/refresh/revoke/list) behind wispEnabled()`

---

### Task 10: Run admission step 1d, depth guard, and the per-tool ceiling in the run loop

**Files:**
- Modify: `apps/api/src/services/aiAgents/runService.ts` — `CreateAgentRunInput` (line 235 block), `AgentRunSkipReason` (line 396), `PUBLISHED_SKIP_REASONS` (line 765), `createAndEnqueueAgentRun` (step 1c ends line 1240; step 2 begins line 1242), the insert `values` (line 1788 block)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` — `loadRunContext` select (line 321 block), the `guardrailPolicy` construction, the pre-tool hook immediately before `checkAgentGuardrails` (line 1127)
- Test: `apps/api/src/services/aiAgents/runService.grantAdmission.test.ts` (new; copy the mock harness of `analysisProfile.admission.test.ts`), `apps/api/src/services/aiAgents/runLoop.grantCeiling.test.ts` (new; copy the harness of `runLoop.taskFence.test.ts`)

**Interfaces:**
- Consumes: Task 6 `resolveGrantCeiling`, `assertWithinCeiling`, `toolPermissionRequirements`, `GrantInactiveError`, `CeilingViolationError`.
- Produces: `CreateAgentRunInput.grant?: { grantId: string; grantRevisionId: string; requestedByRunId?: string | null }` (TRUSTED INTERNAL INPUT like `task`; `requestedByRunId` is the depth guard's input and is what W07's `requestSpecialist.requestedByRunId` forwards); skip reasons `'grant_inactive' | 'grant_org_out_of_ceiling'` (both in `PUBLISHED_SKIP_REASONS` — policy events); `export class GrantDepthExceededError extends Error { readonly code = 'grant_depth_exceeded' }` (w00 A11: the depth guard **throws**, it is not a skip reason — a caller that reaches it is a bug, because W07's coordinator checks depth before admission); run row columns `grantId`, `grantRevisionId`.

- [ ] **Step 1: Write failing admission tests** (`runService.grantAdmission.test.ts`; mock `../wisp/grantAuthority`):

```ts
const GRANT = { grantId: 'g1', grantRevisionId: 'r1' };
it('1d runs after 1c and before the policy read: an inactive grant skips grant_inactive with zero resolveEffectiveAgentSystem calls', …);
it('1d skips grant_org_out_of_ceiling when run.orgId ∉ ceiling.orgIds', …);
it('1d intersects the allowlist: the inserted policySnapshot.effective.toolAllowlist = effective ∩ ceiling.toolAllowlist \ ceiling.deniedTools', …);
it('with ceiling.toolAllowlist null the inserted allowlist is effective \ deniedTools', …);
it('stamps grantId + grantRevisionId on the inserted row', …);
it('without `grant` the inserted row has grantId null and resolveGrantCeiling is never called', …);
it('depth guard: grant.requestedByRunId naming a run whose grant_id is null or ≠ grant.grantId throws GrantDepthExceededError (caller bug), no skip, no insert', …);
it('depth guard: requestedByRunId naming a run under the same grant (Wisp\'s own assessment) is admitted — that run is depth 0; W07 tightens the predicate with the lineage columns', …);
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement step 1d** directly after the 1c `workspace_unavailable` check:
  - If `input.grant`: when `requestedByRunId` is set, read that run's `grantId` and `orgId` (system context); `grantId` null or ≠ `grant.grantId`, or `orgId` ≠ `input.orgId` → `throw new GrantDepthExceededError('createAndEnqueueAgentRun: grant-bearing work may only be requested by Wisp\'s own run under the same grant and org (depth 1)')`. (W07 adds `depth === 0 && profile === 'assessment'` to this predicate once the lineage columns exist; the spec §4.5 rule is "no run created by Wisp may create further runs", and the assessment run IS Wisp.) Then `resolveGrantCeiling(grantId, grantRevisionId)`; `GrantInactiveError` → `skip('grant_inactive')`; `!ceiling.orgIds.has(orgId)` → `skip('grant_org_out_of_ceiling')`. Keep `ceiling` for the insert.
  - At insert: `grantId`, `grantRevisionId`, and `policySnapshot: ceiling ? { ...resolved, effective: { ...resolved.effective, toolAllowlist: intersectAllowlist(resolved.effective.toolAllowlist, ceiling) } } : resolved` where `intersectAllowlist` keeps entries `t` whose tool name (the part before `:`) is not in `deniedTools` and, when `ceiling.toolAllowlist !== null`, is in it. Later gates that read `effective.toolAllowlist` (e.g. the workspace capability check, line 1512) must read the intersected list, so compute it once right after step 2 and use it for both.

- [ ] **Step 4: Write failing run-loop tests** (`runLoop.grantCeiling.test.ts`):

```ts
it('a grant run checks assertWithinCeiling for a Tier-1 read before checkAgentGuardrails (deny reason names the ceiling term)', …);
it('a grant run passes orgId = run.orgId, siteId = device site, and every TOOL_PERMISSIONS requirement for the tool', …);
it('GrantInactiveError at tool time denies the call with reason "delegation grant is no longer active" and the error text ends "Stop and do not retry." (same shape as the task fence)', …);
it('a run with grantId null never calls resolveGrantCeiling', …);
it('the ceiling is memoised for 15 s inside one run frame (two tool calls → one resolve)', …);
```

- [ ] **Step 5: Run** → FAIL.

- [ ] **Step 6: Implement**: `loadRunContext` selects `grantId`, `grantRevisionId`; the run frame holds `grantCeilingMemo: { ceiling: GrantCeiling; at: number } | null`; in the pre-tool hook, before `loadProposalGuardrailContext`, when `run.grantId`: resolve (memo 15 000 ms), then for each requirement from `toolPermissionRequirements(toolName, input)` (null → one check with `toolName` only) call `assertWithinCeiling(ceiling, { toolName, permission: \`${r.resource}:${r.action}\`, orgId: run.orgId, siteId: guardrailPolicy.deviceSiteId })`; `CeilingViolationError` → push `{ tool: toolName, reason: \`outside the delegation ceiling (${code})\` }` to `outcome.deniedActions` and return `{ allowed: false, error: reason }`; `GrantInactiveError` → same shape with reason `'delegation grant is no longer active'` and `error: \`${reason}. Stop and do not retry.\`` — the task fence's exact deny shape at `runLoop.ts:1046-1052` (there is no stop flag; the model is told to stop and the reconciler/release gates make any further effect impossible).

- [ ] **Step 7: Run** both new files + `npx vitest run src/services/aiAgents/analysisProfile.admission.test.ts src/services/aiAgents/runLoop.taskFence.test.ts src/services/aiAgents/runLoop.runContext.test.ts` → PASS.

- [ ] **Step 8: Commit** — `feat(wisp): run admission step 1d (grant ceiling, depth guard) and per-tool ceiling in the run loop`

---

### Task 11: Release authority loads the pinned revision; `grant_inactive` is pausable

**Files:**
- Modify: `apps/api/src/services/actionIntents/agentReleaseAuthority.ts` (run select lines 63-76; insert the grant check after the `agent_identity_changed` return and before `readAiKillState()`)
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts` (`pauseIntentForKillSwitch` lines 243-258; the branch at 1156-1161)
- Test: `apps/api/src/services/actionIntents/agentReleaseAuthority.test.ts`, `apps/api/src/jobs/intentReleaseWorker.test.ts`

**Interfaces:**
- Consumes: Task 6.
- Produces: new `AgentReleaseAuthority` error codes `'grant_inactive'` (NON-terminal, pausable like `kill_switch_engaged`) and `'grant_ceiling_violation'` (terminal) with `details: { grantId, grantRevisionId, code }`. In `intentReleaseWorker.ts`: `const PAUSABLE_RELEASE_CODES = new Set(['kill_switch_engaged', 'grant_inactive'])`; `pauseIntentForKillSwitch` renamed `pauseIntentForRecoverableDenial(intent, code, details)` (the task-linked branch passes `code` through to `revertTaskLinkedDispatchClaim`).

- [ ] **Step 1: Write failing tests**
  - `agentReleaseAuthority.test.ts` (mock `../wisp/grantAuthority`; queue a run row with `grantId: 'g1', grantRevisionId: 'r1'`):
    ```ts
    it('a run with no grant never calls resolveGrantCeiling', …);
    it('grant_inactive when resolveGrantCeiling throws GrantInactiveError', …);
    it('grant_ceiling_violation {code:"org"} when the intent org left the live ceiling', …);
    it('checks tool = intent.actionName, permission from TOOL_PERMISSIONS, orgId = intent.orgId, siteId = the resolved target device site', …);
    it('grant check runs BEFORE the policy candidates loop (a ceiling violation wins over a snapshot deny)', …);
    ```
  - `intentReleaseWorker.test.ts`: `it('grant_inactive CASes executing -> approved (pausable) like kill_switch_engaged')`, `it('grant_ceiling_violation CASes executing -> failed')`.

- [ ] **Step 2: Run** both files → FAIL.

- [ ] **Step 3: Implement** per the Interfaces block. For `permission`, use `toolPermissionRequirements(intent.actionName, intent.arguments)`; one `assertWithinCeiling` per requirement.

- [ ] **Step 4: Run** both files + `npx vitest run src/jobs/intentReleaseWorker.durable.contract.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(wisp): release authority re-checks the pinned grant ceiling; grant_inactive pauses, violation fails`

---

### Task 12: Operator tasks carry a grant; requester gate checks permission within the ceiling

**Files:**
- Modify: `apps/api/src/services/aiOperator/taskService.ts` (`AdmitServiceRecoveryTaskInput` line 87; insert `values` line 290 block)
- Modify: `apps/api/src/services/aiOperator/requesterAccessGate.ts` (`requesterAccessLost`, line 52)
- Modify: `apps/api/src/services/aiOperator/taskCoordinator.ts` (recheck call line 799; run creation lines 554-572)
- Test: `apps/api/src/services/aiOperator/requesterAccessGate.test.ts`, `apps/api/src/services/aiOperator/taskService.recipeAdmission.test.ts` (existing file; add two cases)

**Interfaces:**
- Produces: `AdmitServiceRecoveryTaskInput.grant?: { grantId: string; grantRevisionId: string }` (trusted internal; W07's coordinator is the producer; `routes/aiOperatorTasks.ts` does not expose it); rows stamp `grantId`/`grantRevisionId`.
  ```ts
  export async function requesterAccessLost(
    task: { orgId: string; requesterUserId: string | null; grantId?: string | null; grantRevisionId?: string | null },
    deviceId: string,
    effect?: { permission: string; toolName?: string },
  ): Promise<RequesterAccessCheck>;
  ```
  When `task.grantId` is set: after the existing access checks, `resolveGrantCeiling` + `assertWithinCeiling(ceiling, { orgId: task.orgId, siteId: device.siteId, permission: effect?.permission, toolName: effect?.toolName })`; `GrantInactiveError`/`CeilingViolationError` → `{ lost: true, detail }`. The coordinator passes `{ permission: 'devices:execute' }` at the effect-step recheck (`taskCoordinator.ts:799`) and forwards `grant: { grantId, grantRevisionId }` into `createAndEnqueueAgentRun` for task-linked investigate runs when `task.grantId` is set (spec §4.3: runs the coordinator creates inherit the task's pinned ceiling).

- [ ] **Step 1: Write failing tests**
  - `requesterAccessGate.test.ts`: `it('a task without a grant never resolves a ceiling (unchanged behaviour)')`, `it('a task with a grant whose ceiling lacks devices:execute is lost with a ceiling detail')`, `it('GrantInactiveError reads as lost: "the delegation grant is no longer active"')`, `it('the ceiling check receives the device site, not null')`.
  - `taskService.recipeAdmission.test.ts`: `it('admit stamps grantId/grantRevisionId when provided')`, `it('admit leaves both null when absent')`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the two files + `npx vitest run src/services/aiOperator/taskCoordinator` (check count) → PASS.

- [ ] **Step 5: Commit** — `feat(wisp): operator tasks pin a grant revision; requester gate enforces the ceiling with permission`

---

### Task 13: Real-Postgres integration test — forge, admin limits, grantor lifecycle

**Files:**
- Create: `apps/api/src/__tests__/integration/wispGrantsRls.integration.test.ts` (pattern: `timeSuggestionDecisionsRls.integration.test.ts` for contexts/`expectSqlState`; fixtures from `db-utils.ts`: `createPartner`, `createOrganization`, `createUser`, `createRole`, `grantRolePermissions`, `assignUserToPartner`)

**Interfaces:** consumes Tasks 2, 6, 7, 8.

- [ ] **Step 1: Write the suite** (it is red until run against the migrated test stack; keep each case independent):

```ts
describe('wisp_grants RLS + ownership (2027-01-04-100100)', () => {
  it('cross-partner forge: partner B context inserting a grant with partner_id = A → 42501', …);
  it('non-grantor insert: partner A context with userId = u2 inserting grantor_user_id = u1 → 42501', …);
  it('org of another partner: composite (org_id, partner_id) FK rejects → 23503', …);
  it('second live grant for the same (grantor, scope) → 23505 on wisp_grants_one_live_per_scope_uq; a revoked one does not block', …);
  it('partner admin (userId ≠ grantor) may UPDATE status → revoked', …);
  it('partner admin cannot widen: UPDATE expires_at / current_revision_id → 42501 from wisp_grants_update_guard', …);
  it('partner admin MAY update budget_cents_per_day and floor_tick_minutes (w00 A6); floor_tick_minutes 10 or 241 → 23514 from wisp_grants_budget_chk', …);
  it('partner admin cannot substitute the grantor: UPDATE grantor_user_id → 42501', …);
  it('partner admin cannot resume: UPDATE status paused → active → 42501', …);
  it('revisions are append-only: UPDATE ceiling_snapshot → 42501; DELETE as partner → 42501; system DELETE of the grant cascades the revisions', …);
  it('an org-scoped token cannot SELECT a grant of its own partner (partner-axis, no org branch)', …);
});
describe('grant lifecycle through the service (real step-up in test Redis)', () => {
  it('grantor creates (revision 1), refreshes (revision 2, revision 1 row byte-identical), revokes', …);
  it('createGrant with a step-up minted for a different requestedCeilingHash → step_up_required and no row', …);
  it('resolveGrantCeiling after the grantor role loses tickets:write drops the key from permissionKeys without pausing', …);
  it('reconcileGrantsForUser pauses with grantor_suspended after users.status = disabled, and resumes after re-activation', …);
  it('reconcileActiveGrants expires a grant whose expires_at passed', …);
  it('a run admitted under the grant (createAndEnqueueAgentRun with grant) carries grant_id/grant_revision_id; admitting a child with requestedByRunId = that run (same grant, same org) is admitted; naming a run under another grant throws GrantDepthExceededError', …);
});
```
Mint the step-up with `mintStepUpGrant({ userId, operation: 'wisp_grant', authEpoch, mfaEpoch, sid, resourceDigest: wispGrantResourceDigest(...) })` (epochs from `db-utils.userEpochs`); build the `AuthContext` fixture with `principal: { kind: 'user_session' }`, `scope: 'partner'`, `partnerOrgAccess: 'all'`, `token: { sid, mfaVerified: true, … }` matching what `hasSatisfiedMfa` reads.

- [ ] **Step 2: Run** `pnpm test-stack up` then `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispGrantsRls.integration.test.ts` → all green; fix the implementation (never the assertions) where a case is red.

- [ ] **Step 3: Run the tenancy contract suites again** (Task 3 Step 1's commands) plus `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` → PASS.

- [ ] **Step 4: Commit** — `test(wisp): real-Postgres grant RLS, admin tighten-only, grantor lifecycle`

---

### Task 14: Final verification and PR body

**Files:** none new.

- [ ] **Step 1: Typecheck** — `pnpm --filter @breeze/api exec tsc --noEmit` (check the exit code, never `| tail`) and `pnpm --filter @breeze/shared exec tsc --noEmit`.
- [ ] **Step 2: Unit suites** — `cd apps/api && npx vitest run src/services/wisp src/routes/wisp.test.ts src/services/aiAgents/runService.grantAdmission.test.ts src/services/aiAgents/runLoop.grantCeiling.test.ts src/services/actionIntents/agentReleaseAuthority.test.ts src/jobs/intentReleaseWorker.test.ts src/services/aiOperator src/services/permissions.test.ts src/config src/db` then the full `pnpm --filter @breeze/api test --run` (merge-registry walk only reds in the full run).
- [ ] **Step 3: Contract suites** — `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; `pnpm --filter=@breeze/api test:rls`; the integration files named in Tasks 3 and 13.
- [ ] **Step 4: Flag-off proof** — with `BREEZE_WISP_ENABLED` unset: `GET /api/v1/wisp/grants` → 404; `createAndEnqueueAgentRun` without `grant` inserts `grant_id NULL` (Task 10 test); `workspace_*` now require `ai_workspace:execute` (the one deliberate flag-independent change).
- [ ] **Step 5: Tear down** — `pnpm test-stack down`; state what was left running.
- [ ] **Step 6: PR body** states (orchestrator rule 7): flag off = no behaviour change except the §4.6 permission remap; tenancy registrations added (`PARTNER_TENANT_TABLES` ×2, `ORG_AXIS_POLICY_EXCLUDED_TABLES`, `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry`, `CORE_TENANT_EXPORT_POLICY` ×3 entries); contracts introduced: `wispEnabled`, `'wisp_grant'`, `ai_workspace:execute`, `grants.ts`/`grantAuthority.ts` exports (incl. `GrantCeiling.grantorUserId`, `updateGrantSettings`, `wideningAvailable`), `PATCH /wisp/grants/:id/settings`, `CreateAgentRunInput.grant`, skip reasons + `GrantDepthExceededError`, release error codes, `requesterAccessLost(…, effect)`; settings Rule 9: two operational settings added — budget/tick per grant: home = the grant (API `PATCH /wisp/grants/:id/settings`; web control lands in W04's thread header), level = grant inside partner, resolver = column value (plan bounds via W05), places configured before 0 → after 1. Commit: `chore(wisp): W02 verification notes` only if a doc changed.

---

## Self-review notes

- **Spec coverage:** §4.1 four-term intersection → Task 6 (`resolveGrantCeiling` = revision ∩ live; agent policy term applied at admission Task 10 and release Task 11; parent ceiling is W07's). §4.2 table shapes, self-only, step-up, 90-day expiry, one-active-per-scope, admin tighten/revoke only → Tasks 2, 4, 7, 13. §4.3 enforcement at run admission + release + Operator task + (chat W04, watches W05, memory W03) → Tasks 10, 11, 12. §4.4 tightening immediate / widening via refresh → Tasks 7, 8. §4.5 depth one → Task 10. §4.6 → Task 5. §9 budget columns only (enforcement W05). §10 flag → Task 1 (entitlement W01/W04). §13 constraints honoured: `userId: null` agent context → evaluator in system context.
- **Type consistency:** `GrantCeiling`, `CeilingCheck`, `WispGrant*`, `LiveHumanTerm`, `requesterAccessLost(task, deviceId, effect?)`, `CreateAgentRunInput.grant` are spelled identically across Tasks 6–12.
- **Proportion:** the only code bodies are SQL DDL the spec pins and test assertions.

## Calls made by the planner

1. **`ai_agents:use` does not exist** (`packages/shared/src/constants/permissions.ts` has `ai_agents:read|write`, `ai_sessions:use`). Grant creation and the live human term gate on `ai_sessions:use` (the existing "may use in-product AI" capability, seeded on Partner Technician / Org Admin). If Todd wants a dedicated key, add `ai_agents:use` the way Task 5 adds `ai_workspace:execute`.
2. **`users.status` has no `suspended`** (`active | invited | disabled`): `disabled` or a missing user maps to `grantor_suspended`; `grantor_access_lost` = no partner membership, no `ai_sessions:use`, or live ∩ snapshot orgs empty. Partial narrowing shrinks the ceiling silently (spec §4.4).
3. **Second migration file** `2027-01-04-100110-ai-workspace-execute-permission.sql` for the permission row (keeps the W02 DDL file DML-free and mirrors the `ai_models:premium` precedent). Sorts between W02's and W03's slots.
4. **`GET /api/v1/wisp/grants/preview`** added: the mint route (`routes/auth/mfa.ts`) only hashes client-supplied resources, so the client must learn `requestedCeilingHash` from the server first. The mint route never trusts a body `grantorUserId` — it uses `auth.user.id`.
5. **Depth guard** is `grant.requestedByRunId` (optional, additive to the w00 `grant` shape) and a thrown `GrantDepthExceededError` (code `grant_depth_exceeded`, w00 A11), not a skip reason; W07's `requestSpecialist.requestedByRunId` is the producer.
6. **Admin tighten-only is a trigger** (`wisp_grants_update_guard`, ERRCODE 42501); RLS cannot compare OLD/NEW. w00 A6 resolved the §9 vs §4.2 reading: budget and tick are operational settings a partner admin may change (within bounds); the **ceiling** stays tighten/revoke-only. The trigger and `PATCH /grants/:id/settings` implement that split in W02.
7. **`grant_inactive` at release is pausable** (generalising `pauseIntentForKillSwitch`); a ceiling violation is terminal.
8. **Allowlist intersection is written into the run's `policySnapshot.effective.toolAllowlist`** (the snapshot records what authorised the run; narrower ⇒ release denies more ⇒ fail-closed).
9. **Per-tool ceiling check inside the run loop** (Tier 1 included) with a 15 s memo — spec §4.3 "the read surface" cannot be enforced by allowlist alone because Tier-1 reads bypass it.
10. **Merge policy `leave-for-erasure`** for `wisp_grants`; `users (id, partner_id)` UNIQUE added so the spec's composite grantor FK is possible.
11. **Auto-resume** only for `grantor_access_lost` / `grantor_suspended`; `factor_expired` / `entitlement_lost` / `budget_exhausted` are left for their owning waves. Grants past `expires_at` go `expired` (terminal).
12. **User-change hook** = a listener registry on `clearPermissionCache(userId)` (the choke point status, role, org-access and role-permission changes already pass through), installed at boot only when `wispEnabled()`.
13. **Agent principal cannot pass `breeze_has_partner_access`** (org-scoped context, `userId: null`), so "the agent reads only the grant it is executing" is enforced by the code path (the grant id is pinned on the run/task; the evaluator runs in system context), not by a policy branch.
14. Defaults `expires_at` +90 d, budget 200 ¢, floor 30 min (w00 A6) as column defaults; partner-configurable expiry and plan-driven budgets are W01/W05.
15. Worker placement `'global'` for the reconciler pending the closure tool's verdict.
16. `GET /grants?view=partner`, admin revoke and admin settings changes use `canManagePartnerWidePolicies` (partner scope with `org_access='all'`) as "partner admin".

### Reconciliation edits (reviewer)

- `floor_tick_minutes` default 15 → **30**, CHECK widened to `BETWEEN 15 AND 240` (w00 A6, check b).
- `GrantCeiling` gains `grantorUserId: string` (w00 A3); W03/W05 consume it instead of a second lookup.
- Trigger `wisp_grants_update_guard` lets a partner admin change `budget_cents_per_day` / `floor_tick_minutes` (w00 A6); Task 13 tests split accordingly.
- Added `updateGrantSettings`, `GrantSettingsBounds`, `wideningAvailable` (spec §4.4 widening offer — W04's `GET /wisp/thread` consumes it) to Task 7, plus tests.
- Added `PATCH /grants/:id/settings` to Task 9 (w00 final route list, A6) and the `wisp.grant.settings_changed` audit action.
- `previewGrantCeiling` / `GET /grants/preview` return `{ scope, ceilingSnapshot, ceilingHash }` (w00 A4 spelling; W04's modal consumes it).
- Depth guard: throws `GrantDepthExceededError` (code `grant_depth_exceeded`, w00 A11); predicate corrected — the requesting run must be under the **same grant and org** (an assessment run is grant-bearing and is the legitimate requester), not "any grant-bearing run throws". W07 tightens with `depth`/`profile`.
- Task 7: added the `WispLimits.maxGrants` cap — `createGrant` throws `GrantLimitReachedError` (code `grant_limit_reached`, route 409 `GRANT_LIMIT_REACHED`) when active grants ≥ `maxGrants` from W01's `getEntitlementLimits(partnerId, 'wisp')`; null limits / absent module ⇒ no cap (W02 can merge before W01).

## 2026-10-23 amendments (w00 A29, A33, A35) — tasks added by the orchestrator

### Task 15: User pause / resume, `partner_disabled`, and the `wisp.grant.*` bus events

**Files:**
- Modify: `apps/api/migrations/2027-01-04-100100-wisp-grants.sql` (the `paused_reason` CHECK now lists `'user_paused'` and `'partner_disabled'` — edited in Task 2 above), `apps/api/src/db/schema/wisp.ts` (`WispGrantPauseReason`)
- Modify: `apps/api/src/services/wisp/grants.ts` (+ `grants.test.ts`), `apps/api/src/services/wisp/grantLifecycle.ts` or wherever Task 8's reconcilers live (+ tests), `apps/api/src/routes/wisp.ts` (+ `wisp.test.ts`)
- Modify: `apps/api/src/services/eventBus.ts` (`EventType` union + `EVENT_TYPES`: `WISP_GRANT_CREATED: 'wisp.grant.created'`, `WISP_GRANT_RESUMED: 'wisp.grant.resumed'`), `apps/api/src/services/eventBus.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function userPauseGrant(input: { auth: AuthContext; grantId: string }): Promise<WispGrant>;   // grantor only (WispGrantError 'forbidden' otherwise); active → paused with reason 'user_paused'; audit 'wisp.grant.paused' { reason: 'user_paused' }
  export async function userResumeGrant(input: { auth: AuthContext; grantId: string }): Promise<WispGrant>;  // grantor only; refuses unless paused_reason === 'user_paused' (WispGrantError 'not_user_paused' → 409 NOT_USER_PAUSED); keeps current_revision_id; audit 'wisp.grant.resumed'
  ```
  Bus payloads: `wisp.grant.created` / `wisp.grant.resumed` `{ grantId, partnerId, orgId: string | null, grantorUserId }`, published from the route **after** the commit and outside the DB context (`void publishEvent(...).catch(log)`, the #1105 rule), source `'wisp'`.
- Routes: `POST /wisp/grants/:id/pause` → 200 `WispGrantDto`; `POST /wisp/grants/:id/resume` → 200 `WispGrantDto` / 409 `NOT_USER_PAUSED`. Both inherit the hub gates; no step-up (pausing never widens; resume keeps the revision).
- **Reconciler rule (Task 8):** every automatic resume path (`grantor_access_lost` recovered, `factor_expired` renewed, and W05's `entitlement_lost` / `partner_disabled` reconcilers) is guarded by `paused_reason <> 'user_paused'`; a user-paused grant resumes only through `userResumeGrant`. `pauseGrant` on an already-paused grant keeps the **earlier** reason unless the new reason is a system reason and the old one is `'user_paused'` — then the system reason wins (`paused_reason` is overwritten; on `userResumeGrant` the grant is refused with `not_user_paused`, which tells the user why).
- Watches: `stopWatchesForInactiveGrants` (W05) already stops them with `stopped_reason = 'paused'`; `userResumeGrant` runs `UPDATE wisp_watches SET status='active', stopped_reason=NULL, next_due_at=now() WHERE grant_id=$1 AND stopped_reason='paused'` (W05 adds the column; W02 writes it only when the table exists — guard with a `to_regclass('wisp_watches')` check in SQL or a lazy import, so W02 merges before W05).

- [ ] **Step 1: Failing tests** — `grants.test.ts`: `userPauseGrant` by a non-grantor → `forbidden`; active → paused/`user_paused`; `userResumeGrant` on `paused_reason: 'entitlement_lost'` → `not_user_paused`; on `'user_paused'` → active with the same `currentRevisionId`; reconciler test: a `user_paused` grant is never resumed by the access-recovered path. `wisp.test.ts`: both routes 404 when the flag is off; `409 NOT_USER_PAUSED`; the create route publishes `wisp.grant.created` once with `{ grantId, partnerId, orgId, grantorUserId }` and does not publish on a refused create.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/wisp/grants.test.ts src/routes/wisp.test.ts` — FAIL.
- [ ] **Step 3: Implement**, then re-run with Task 8's reconciler suite and `src/services/eventBus.test.ts` — PASS.
- [ ] **Step 4: Commit** — `feat(wisp): user pause/resume, partner_disabled reason, wisp.grant.created/resumed events (W02 T15, w00 A29/A33/A35)`.

### Contract change for W05 (A30): `GrantCeiling.scopeOrgId`

`resolveGrantCeiling` returns `scopeOrgId: string | null` (= `wisp_grants.org_id`). W05's partner-level concerns (`org_id NULL`) are served only to ceilings with `scopeOrgId === null`. Add the field to `GrantCeiling` in Task 6 and to the `assertWithinCeiling` tests (a `check.orgId === null` passes only when `ceiling.scopeOrgId === null`; otherwise `CeilingViolationError('org')`).
