# W04 — Unattended Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reviewer-gated unattended lane — a `decided_via = 'script_reviewer'` autonomy decision inside `createActionIntent` that releases an AI-authored, model-reviewed script without a human card, bounded by fourteen deterministic invariants, a partner ceiling plus an explicit org grant, an hourly reservation, a Windows restore checkpoint, and a per-org circuit that opens after two failed verifications — all off by default.

**Architecture:** Two new tables (`ai_script_policies`, dual-owner org XOR partner; `ai_script_lane_state`, shape 1 PK `org_id`) and one new immutable `action_intents` column (`script_reviewer_evidence`). A pure resolver (`resolveEffectiveScriptPolicy`) folds the partner ceiling and the org grant into one `EffectiveScriptPolicy`. `evaluateScriptReviewerAutonomy` sits beside `evaluateTicketAutonomy` in the intent-creation transaction, takes a per-org advisory xact lock, evaluates invariants 1–14 in order, and either returns typed evidence or a typed refusal that falls through to the ordinary human path. `revalidateScriptReviewerEvidence` re-runs the revocable subset at release. After execution a verification-outcome handler drives the lane circuit, the audit trail, and notifications.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL (RLS + advisory locks), BullMQ, Vitest, Astro + React islands, react-i18next.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md` (§4.1, §4.6, §5, §6, §7, §8 W04, §10)

**Roadmap (cross-wave contracts):** `docs/superpowers/plans/ai-mcp/2026-09-11-ai-script-authoring-roadmap.md` — this wave **consumes** §3.1–§3.5 (assume they exist exactly as written) and **produces** §3.6.

**Tracking:** feature `LanternOps/breeze#5612`. Branch `feature/5612-ai-script-authoring/wave-<W04 sub-issue#>`; run `get_feature_status` for the sub-issue number, then `start_wave`. PR body carries `Closes #<W04 sub-issue>`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Depends on W01a, W01b, W02, W03 being merged.** This wave imports, and never re-implements: `scanScriptContent` / `ScriptScanResult` / `TouchClass` / `LANE_HARD_DENIED_CLASSES` / `SCANNER_VERSION` (`packages/shared/src/utils/scriptSecurityPatterns.ts`), `RiskTier` / `riskTierRank` (`packages/shared/src/validators/scriptProposals.ts`), `consumeProposalForIntent` / `assertProposalRunnable` / `ScriptProposalRow` (`apps/api/src/services/scriptProposals/`), `ScriptProposalReviewRow`, and `onUnattendedVerificationOutcome`'s call seam in `apps/api/src/services/scriptProposals/verify.ts`.
- **Feature flag `BREEZE_AI_SCRIPT_AUTHORING_ENABLED`** (env, default `true` as of W03) gates the whole feature. **The lane itself has NO env flag** — it is off because `ai_script_policies.unattended_allowed` defaults `false` on the partner row and there is no org row (spec §4.6 invariant 1, D10).
- **Migration slots are fixed:** `2026-10-16-110000-ai-script-policies.sql` and `2026-10-16-110100-action-intents-script-reviewer.sql`. Both idempotent (`IF NOT EXISTS`, `DO $$ … END $$`, `DROP POLICY IF EXISTS` then `CREATE`), **no inner `BEGIN;`/`COMMIT;`** (`autoMigrate` wraps each file). Neither writes rows, so neither needs `SELECT set_config('breeze.scope', 'system', true);` — do not add one; `migrationRlsScope.test.ts` keys on DML. Re-verify sort order at push with `scripts/check-migration-naming.sh --against-ref origin/main`; if `origin/main` gained a later file, rename **and** sweep every `readFileSync('../../../migrations/<file>.sql')` reference.
- **Never edit a shipped migration.** These two are unshipped until merge, so they remain editable within this branch (clear the `breeze_migrations` ledger row locally if you re-apply after an edit).
- **Tenancy (CLAUDE.md → Partner-Wide First, 7 steps).** `ai_script_policies` is dual-owner: `org_id` XOR `partner_id`, `ai_script_policies_one_owner_chk`, **ONE** `FOR ALL` dual-axis policy **plus a SEPARATE `FOR SELECT`-only** `ai_script_policies_partner_wide_select` policy in the same migration (`PARTNER_WIDE_SELECT_BRANCH_EXEMPT_CEILING` is `0` at `rls-coverage.integration.test.ts:655` — an exemption is not available). Never append the partner-wide branch to the `FOR ALL` policy's `USING`. `ai_script_lane_state` is shape 1 with `org_id NOT NULL` and the four per-command `breeze_has_org_access(org_id)` policies (no separate system branch — `breeze_has_org_access` already returns true for system scope).
- **Registration is a mechanical grep, not a judgement call.** Both tables → `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`, alphabetical, between `'ai_screenshots'` at `:308` and `'ai_sessions'` at `:309`) **and** `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`, between `"ai_screenshots"` at `:99` and `"ai_sessions"` at `:100`) **and** exactly one of `orgMergeRegistry`'s `SPECIAL` / `REPOINT_TABLES`. `ai_script_policies` additionally → `DUAL_AXIS_TENANT_TABLES` (`rls-coverage.integration.test.ts:316`) and `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`:588`). `ai_script_lane_state` needs **no** rls-coverage allowlist entry (shape 1 with an `org_id` column is auto-discovered; `ORG_ID_KEYED_TENANT_TABLES` at `:178` is for tables with no `org_id` column at all — precedent `ai_agent_circuit_state`).
- **The export-policy row also fires on a new COLUMN**: `action_intents.script_reviewer_evidence` must be classified in `CORE_TENANT_EXPORT_POLICY` as `excludedOpen` (it is jsonb; CLAUDE.md: *any* json/jsonb/bytea column is `excludedOpen`, no exceptions). So must `ai_script_policies.protected_resources`.
- **Neither new table is append-only**, so neither goes in `AUDIT_ADMIN_REQUIRED_TABLES` (`tenantCascade.ts:973`).
- **The `action_intents` immutability trigger enumerates columns** (`action_intents_block_content_update()`, current effective definition `apps/api/migrations/2026-10-14-100200-ai-operator-intent-identity.sql:114-152`). A new column is mutable by default. Copy that definition **verbatim** and add one line; the `RAISE EXCEPTION 'action_intents content is immutable'` text must stay byte-identical (`apps/api/src/testUtils/actionIntentsTriggerDenyList.ts` anchors on it), and `apps/api/src/db/migration-action-intents.test.ts:73`'s `IMMUTABLE_CONTENT_COLUMNS` must gain the same column.
- **`aiGuardrails.ts` must not import the tool registry or DB schema** (`aiGuardrails.imports.contract.test.ts`). The protected-resource matcher extracted in Task 8 is a pure function; keep it that way.
- **No new agent-facing payload fields; the Go agent is unchanged.** The restore checkpoint rides the existing `script` device-command primitive (`agent/internal/remote/tools/types.go:98` `CmdScript = "script"`, handler `agent/internal/heartbeat/handlers_script.go:21-24`, payload contract `:119-132`).
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`); every new i18n key needs a **real translation in all 9 locales** (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` — `apps/web/src/lib/i18n/localeParity.test.ts` compares flattened key sets, `translationCoverage.test.ts` caps exact-English duplicates). AI settings strings live in the `settings` namespace, **not** `ai`.
- **Tests sit beside source.** Run one file with `cd apps/api && npx vitest run <path>` — never `pnpm --filter <pkg> test -- --run <path>` (the `--` makes vitest run the whole 1,470-file suite in watch mode). Integration suites need `pnpm test-stack up` and are run explicitly before PR; tear down with `pnpm test-stack down`.
- **Contract suites that must go green before PR:** `rls-coverage.integration.test.ts`, `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `orgLifecycleFoundations.integration.test.ts`, `actionIntentsImmutabilityTrigger.integration.test.ts`, `migrationRlsScope.test.ts`, `autoMigrate.test.ts`, `migration-action-intents.test.ts`.
- **Every task ends with a commit.** Checkpoint commits are cheap; context loss is not.

---

## File structure

**Created**

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-16-110000-ai-script-policies.sql` | `ai_script_policies` + `ai_script_lane_state`: tables, CHECKs, indexes, RLS, partner-wide SELECT branch, grants |
| `apps/api/migrations/2026-10-16-110100-action-intents-script-reviewer.sql` | `action_intents.script_reviewer_evidence` + extended immutability trigger |
| `apps/api/src/db/schema/aiScriptPolicies.ts` | Drizzle table + row types for `ai_script_policies` |
| `apps/api/src/db/schema/aiScriptLaneState.ts` | Drizzle table + row types for `ai_script_lane_state` |
| `apps/api/src/services/scriptProposals/policy.ts` | `EffectiveScriptPolicy`, `resolveEffectiveScriptPolicy` (ceiling ∧ grant) |
| `apps/api/src/services/scriptProposals/policy.test.ts` | merge unit tests |
| `apps/api/src/services/deviceRecovery/restoreCheckpoint.ts` | `ensureRestoreCheckpoint(deviceId)` — Windows System Restore via the raw-script primitive |
| `apps/api/src/services/deviceRecovery/restoreCheckpoint.test.ts` | checkpoint unit tests |
| `apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts` | invariants 1–14, evidence, refusals, release revalidation |
| `apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts` | table-driven: one negative per invariant + positive control |
| `apps/api/src/services/actionIntents/scriptReviewerRevalidate.test.ts` | one negative per revocation |
| `apps/api/src/services/scriptProposals/laneOutcome.ts` | `onUnattendedVerificationOutcome` — lane circuit, audit, agent circuit, notify |
| `apps/api/src/services/scriptProposals/laneOutcome.test.ts` | circuit/open/reset unit tests |
| `apps/api/src/routes/ai/scriptPolicy.ts` | `GET`/`PUT /api/v1/ai/script-policy`, `POST /api/v1/ai/script-lane/reset` |
| `apps/api/src/routes/ai/scriptPolicy.test.ts` | route tests (authz, validation, MFA, isolation) |
| `apps/api/src/routes/partnerAiScriptPolicy.ts` | `GET`/`PUT /api/v1/partner/ai/script-policy` |
| `apps/api/src/routes/partnerAiScriptPolicy.test.ts` | route tests |
| `apps/api/src/__tests__/integration/aiScriptPoliciesPartnerRls.integration.test.ts` | live-DB RLS/XOR/partner-wide/cascade/export/merge |
| `apps/api/src/services/actionIntents/scriptLaneHourlyCap.integration.test.ts` | live-DB `Promise.all` race against the hourly cap |
| `apps/web/src/components/settings/ScriptAuthoringPage.tsx` | Settings → AI → Script authoring island |
| `apps/web/src/components/settings/ScriptAuthoringPage.test.tsx` | web tests |
| `apps/web/src/pages/settings/ai-script-authoring.astro` | page route |
| `e2e-tests/tests/ai-script-unattended-lane.spec.ts` | end-to-end lane run |

**Modified**

`apps/api/src/db/schema/actionIntents.ts` · `apps/api/src/db/schema/index.ts` · `apps/api/src/db/migration-action-intents.test.ts` · `apps/api/src/services/tenantCascade.ts` · `apps/api/src/services/tenantExportPolicyRegistry.ts` · `apps/api/src/services/orgMergeRegistry.ts` · `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` · `apps/api/src/services/aiGuardrails.ts` · `apps/api/src/services/scriptProposals/reviewer.ts` · `apps/api/src/services/scriptProposals/verify.ts` · `apps/api/src/services/actionIntents/intentService.ts` · `apps/api/src/services/actionIntents/intentService.ticketAutonomy.test.ts` (sibling new file instead) · `apps/api/src/services/actionIntents/revalidateRelease.ts` · `apps/api/src/services/actionIntents/revalidateRelease.test.ts` · `apps/api/src/jobs/intentReleaseWorker.ts` · `apps/api/src/services/aiAgentSdk.ts` · `apps/api/src/routes/index.ts` · `apps/api/src/services/mfaStepUpGrant.ts` · `apps/web/src/components/layout/Sidebar.tsx` · `apps/web/src/components/layout/Sidebar.nav.test.tsx` · `apps/web/src/locales/*/settings.json` (9) · `apps/web/src/locales/*/common.json` (9) · `packages/shared/src/types/scriptProposals.ts` · `docs/release-notes/next-release-draft.md`

---

### Task 1: Migration — `ai_script_policies` + `ai_script_lane_state`

**Files:**
- Create: `apps/api/migrations/2026-10-16-110000-ai-script-policies.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing; must stay green), `apps/api/src/db/migrationRlsScope.test.ts` (existing; must stay green)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: SQL tables `public.ai_script_policies` (columns `id, org_id, partner_id, proposing_enabled, unattended_allowed, unattended_enabled, max_unattended_risk_tier, unattended_allowed_classes, max_unattended_per_hour, protected_resources, reviewer_model, unattended_enabled_by, unattended_enabled_at, created_by, created_at, updated_at`) and `public.ai_script_lane_state` (columns `org_id, consecutive_failed_verifications, state, opened_at, opened_reason, reset_by_user_id, reset_at, updated_at`); policies `ai_script_policies_isolation`, `ai_script_policies_partner_wide_select`, `ai_script_lane_state_{select,insert,update,delete}`.

- [ ] **Step 1: Confirm the slot still sorts last**

```bash
ls apps/api/migrations | grep -E '^\d{4}-' | sort | tail -3
# Expected: the newest COMMITTED file sorts BEFORE 2026-10-16-110000.
# 2026-10-15-170200-organization-key-dates.sql was newest on 2026-09-11.
# If origin/main gained a later one, rename BOTH W04 files and sweep references.
git fetch origin main --quiet && bash scripts/check-migration-naming.sh --against-ref origin/main
```

- [ ] **Step 2: Write the migration**

```sql
-- apps/api/migrations/2026-10-16-110000-ai-script-policies.sql
-- AI script authoring W04 (#5612): the unattended lane's policy ceiling/grant
-- and its per-org circuit state.
--
-- ai_script_policies is dual-owner (#2135 Partner-Wide First): the PARTNER row
-- is a CEILING (may any org under this partner use the lane, and how far), the
-- ORG row is an explicit GRANT. A missing org row means the lane is OFF for
-- that org regardless of the partner row (spec D10) — which is why
-- unattended_enabled has no partner-row meaning and unattended_allowed has no
-- org-row meaning, each pinned to false on the wrong side by a CHECK.
--
-- ai_script_lane_state is shape 1 with PK org_id. It is per ORG, not per
-- (org, agent), because a chat session has no agent key to close a circuit on
-- (spec §4.1); agents remain subject to ai_agent_circuit_state as well.
--
-- Idempotent (IF NOT EXISTS / guarded CHECK / DROP POLICY IF EXISTS).
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction.
-- Writes NO rows, so no breeze.scope elevation is needed or wanted.
--
-- Rollback: a new migration DROPping both tables. No app code depends on them
-- until the W04 service layer lands in the same PR.

CREATE TABLE IF NOT EXISTS ai_script_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  proposing_enabled boolean NOT NULL DEFAULT true,
  unattended_allowed boolean NOT NULL DEFAULT false,
  unattended_enabled boolean NOT NULL DEFAULT false,
  max_unattended_risk_tier text NOT NULL DEFAULT 'low',
  unattended_allowed_classes text[] NOT NULL
    DEFAULT ARRAY['services','processes','temp_files','dns_cache','printing']::text[],
  max_unattended_per_hour integer NOT NULL DEFAULT 10,
  protected_resources jsonb NOT NULL DEFAULT '{"services":[],"paths":[],"registryKeys":[],"deviceTags":[]}'::jsonb,
  reviewer_model text,
  unattended_enabled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  unattended_enabled_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_one_owner_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  -- unattended_enabled is an ORG grant; a partner row must never carry one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_org_grant_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_org_grant_chk
      CHECK (org_id IS NOT NULL OR unattended_enabled = false);
  END IF;
  -- unattended_allowed is a PARTNER ceiling; an org row must never carry one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_partner_ceiling_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_partner_ceiling_chk
      CHECK (partner_id IS NOT NULL OR unattended_allowed = false);
  END IF;
  -- high/critical are NEVER lane-eligible (spec §4.6 invariant 3).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_tier_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_tier_chk
      CHECK (max_unattended_risk_tier IN ('low', 'medium'));
  END IF;
  -- Closed set: the classifier's TOUCH_CLASSES (roadmap §3.1). A class the
  -- classifier cannot emit must not be storable in an allowlist.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_classes_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_classes_chk
      CHECK (unattended_allowed_classes <@ ARRAY[
        'registry','services','processes','files_system','files_user','temp_files',
        'network_egress','firewall','credentials','users_groups','packages',
        'scheduled_tasks','disk','boot','security_tooling','dns_cache','printing',
        'browser','shell_eval'
      ]::text[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_policies_per_hour_chk') THEN
    ALTER TABLE ai_script_policies
      ADD CONSTRAINT ai_script_policies_per_hour_chk
      CHECK (max_unattended_per_hour BETWEEN 0 AND 100);
  END IF;
END $$;

-- One row per owner.
CREATE UNIQUE INDEX IF NOT EXISTS ai_script_policies_org_uq
  ON ai_script_policies (org_id) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_script_policies_partner_uq
  ON ai_script_policies (partner_id) WHERE partner_id IS NOT NULL;

ALTER TABLE ai_script_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_script_policies FORCE ROW LEVEL SECURITY;

-- ONE dual-axis FOR ALL policy. org_id is NULLABLE here, so the explicit
-- system branch IS required (unlike a shape-1 table).
DROP POLICY IF EXISTS ai_script_policies_isolation ON ai_script_policies;
CREATE POLICY ai_script_policies_isolation ON ai_script_policies
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

-- SEPARATE, additive, SELECT-ONLY partner-wide read branch
-- (template: 2026-10-05-110000-config-policy-partner-wide-select.sql; ai twin:
-- 2026-10-11-150000-ai-partner-wide-select.sql:87-91). NEVER appended to the
-- FOR ALL policy's USING: Postgres consults FOR SELECT policies only for
-- reads, so this ORs into reads and nothing else — appending it would also
-- widen UPDATE/DELETE row targeting and let an org admin delete their MSP's
-- ceiling. LOAD-BEARING on the agent path: middleware/agentAuth.ts sets
-- currentPartnerId = device.partnerId (#4673 W02), so an agent-scoped read of
-- the partner ceiling resolves through exactly this branch. `=` not
-- `IS NOT DISTINCT FROM`, so a NULL partner never matches.
DROP POLICY IF EXISTS ai_script_policies_partner_wide_select ON ai_script_policies;
CREATE POLICY ai_script_policies_partner_wide_select
  ON ai_script_policies
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_script_policies TO breeze_app;

CREATE TABLE IF NOT EXISTS ai_script_lane_state (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  consecutive_failed_verifications integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'closed',
  opened_at timestamptz,
  opened_reason text,
  reset_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reset_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_script_lane_state_state_chk') THEN
    ALTER TABLE ai_script_lane_state
      ADD CONSTRAINT ai_script_lane_state_state_chk
      CHECK (state IN ('closed', 'open'));
  END IF;
END $$;

ALTER TABLE ai_script_lane_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_script_lane_state FORCE ROW LEVEL SECURITY;

-- Shape 1, org_id NOT NULL: the canonical idiom is the bare
-- breeze_has_org_access(org_id) check with NO separate system branch — that
-- helper already returns TRUE for system scope internally
-- (2026-09-25-ai-agents-ticket-triage.sql:163-190).
DROP POLICY IF EXISTS ai_script_lane_state_select ON ai_script_lane_state;
CREATE POLICY ai_script_lane_state_select ON ai_script_lane_state
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS ai_script_lane_state_insert ON ai_script_lane_state;
CREATE POLICY ai_script_lane_state_insert ON ai_script_lane_state
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS ai_script_lane_state_update ON ai_script_lane_state;
CREATE POLICY ai_script_lane_state_update ON ai_script_lane_state
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS ai_script_lane_state_delete ON ai_script_lane_state;
CREATE POLICY ai_script_lane_state_delete ON ai_script_lane_state
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_script_lane_state TO breeze_app;
```

- [ ] **Step 3: Apply it against a live database and prove isolation as `breeze_app`**

```bash
pnpm test-stack up
export DATABASE_URL="$(grep '^DATABASE_URL=' apps/api/.env.test | cut -d= -f2-)"
pnpm db:migrate
psql "$DATABASE_URL" -c "\d+ ai_script_policies" -c "\d+ ai_script_lane_state"
# Re-run to prove idempotence — must be a clean no-op:
psql "$DATABASE_URL" -f apps/api/migrations/2026-10-16-110000-ai-script-policies.sql
```

- [ ] **Step 4: Run the migration guards**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS (naming sorts correctly; no DML, so no scope-elevation finding — and **do not** add this file to `migrationRlsScope.test.ts`'s frozen baseline).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-16-110000-ai-script-policies.sql
git commit -m "feat(ai): ai_script_policies + ai_script_lane_state tables with dual-axis RLS

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Migration — `action_intents.script_reviewer_evidence`

**Files:**
- Create: `apps/api/migrations/2026-10-16-110100-action-intents-script-reviewer.sql`
- Modify: `apps/api/src/db/migration-action-intents.test.ts:73` (`IMMUTABLE_CONTENT_COLUMNS`)

**Interfaces:**
- Consumes: Task 1's migration slot ordering only.
- Produces: column `action_intents.script_reviewer_evidence jsonb`, covered by `action_intents_block_content_update()`.

- [ ] **Step 1: Write the failing test first — add the column to the deny-list expectation**

```ts
// apps/api/src/db/migration-action-intents.test.ts — inside IMMUTABLE_CONTENT_COLUMNS (:73)
    'operation_key',
    // AI script authoring W04 (#5612): the unattended lane's typed decision
    // evidence. Written once at INSERT alongside status/decided_via; a release
    // that could rewrite it could relax the very invariants it records.
    'script_reviewer_evidence',
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/migration-action-intents.test.ts`
Expected: FAIL — `expect(DENY_LISTED_COLUMNS).toEqual([...IMMUTABLE_CONTENT_COLUMNS].sort())` reports `script_reviewer_evidence` present in the expectation but absent from the parsed migration.

- [ ] **Step 3: Write the migration**

Copy the **current effective** definition verbatim from `apps/api/migrations/2026-10-14-100200-ai-operator-intent-identity.sql:114-152` and add exactly one `OR` line. Do not re-derive it from the 2026-07-18 original.

```sql
-- apps/api/migrations/2026-10-16-110100-action-intents-script-reviewer.sql
-- AI script authoring W04 (#5612): typed evidence for a decided_via =
-- 'script_reviewer' intent (spec §4.6 "Decision record").
--
-- The column is IMMUTABLE. action_intents_block_content_update() is a
-- DENY-LIST, not a wholesale block, so a new column is mutable unless named —
-- which is exactly how origin_principal_kind/_id once shipped with zero
-- immutability coverage. The definition below is 2026-10-14-100200's verbatim,
-- plus one line. The RAISE text is byte-identical on purpose:
-- src/testUtils/actionIntentsTriggerDenyList.ts anchors its parser on it.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION).
-- No inner BEGIN/COMMIT. Writes no rows.

ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS script_reviewer_evidence jsonb;

CREATE OR REPLACE FUNCTION action_intents_block_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.requesting_agent_run_id IS DISTINCT FROM OLD.requesting_agent_run_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_principal_kind IS DISTINCT FROM OLD.origin_principal_kind
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.target_summary IS DISTINCT FROM OLD.target_summary
     OR NEW.impact_summary IS DISTINCT FROM OLD.impact_summary
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.approval_scope IS DISTINCT FROM OLD.approval_scope
     OR NEW.classification_version IS DISTINCT FROM OLD.classification_version
     OR NEW.effect_digest IS DISTINCT FROM OLD.effect_digest
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.task_step_key IS DISTINCT FROM OLD.task_step_key
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.script_reviewer_evidence IS DISTINCT FROM OLD.script_reviewer_evidence
     OR (NEW.scope_device_id IS DISTINCT FROM OLD.scope_device_id AND NEW.scope_device_id IS NOT NULL)
     OR (NEW.scope_ticket_id IS DISTINCT FROM OLD.scope_ticket_id AND NEW.scope_ticket_id IS NOT NULL) THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/db/migration-action-intents.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the trigger is live**

```bash
pnpm db:migrate
cd apps/api && npx vitest run src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts
# Expected: PASS, with a rejecting-UPDATE case for script_reviewer_evidence.
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-16-110100-action-intents-script-reviewer.sql apps/api/src/db/migration-action-intents.test.ts
git commit -m "feat(ai): immutable script_reviewer_evidence column on action_intents

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Drizzle schemas and shared types

**Files:**
- Create: `apps/api/src/db/schema/aiScriptPolicies.ts`, `apps/api/src/db/schema/aiScriptLaneState.ts`
- Modify: `apps/api/src/db/schema/actionIntents.ts` (one column), `apps/api/src/db/schema/index.ts` (two re-exports), `packages/shared/src/types/scriptProposals.ts` (DTO shapes)
- Test: `apps/api/src/db/schema/aiScriptPolicies.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2's SQL.
- Produces: `aiScriptPolicies`, `AiScriptPolicyRow`, `NewAiScriptPolicyRow`, `aiScriptLaneState`, `AiScriptLaneStateRow`, `actionIntents.scriptReviewerEvidence`, and shared DTOs `ScriptPolicyDto`, `ScriptLaneStateDto`, `EffectiveScriptPolicyDto`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/db/schema/aiScriptPolicies.test.ts
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { aiScriptPolicies } from './aiScriptPolicies';
import { aiScriptLaneState } from './aiScriptLaneState';
import { actionIntents } from './actionIntents';

describe('ai script lane schema', () => {
  it('ai_script_policies is dual-owner: both axes nullable', () => {
    const cols = Object.fromEntries(getTableConfig(aiScriptPolicies).columns.map((c) => [c.name, c]));
    expect(cols.org_id!.notNull).toBe(false);
    expect(cols.partner_id!.notNull).toBe(false);
    expect(cols.unattended_allowed!.notNull).toBe(true);
    expect(cols.unattended_enabled!.notNull).toBe(true);
  });

  it('ai_script_lane_state is keyed on org_id alone', () => {
    const cfg = getTableConfig(aiScriptLaneState);
    expect(cfg.columns.find((c) => c.name === 'org_id')!.primary).toBe(true);
    expect(cfg.columns.map((c) => c.name)).not.toContain('id');
  });

  it('action_intents carries the script reviewer evidence column', () => {
    expect(getTableConfig(actionIntents).columns.map((c) => c.name)).toContain('script_reviewer_evidence');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/aiScriptPolicies.test.ts`
Expected: FAIL — `Cannot find module './aiScriptPolicies'`.

- [ ] **Step 3: Write the schemas**

```ts
// apps/api/src/db/schema/aiScriptPolicies.ts
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AiAgentProtectedResources } from '@breeze/shared';
import type { RiskTier, TouchClass } from '@breeze/shared';
import { organizations, partners } from './orgs';
import { users } from './users';

/**
 * Dual-ownership (#2135): the PARTNER row is a CEILING, the ORG row is a
 * GRANT. A missing org row means the lane is off for that org regardless of
 * the partner row (spec D10). CHECK constraints
 * (ai_script_policies_one_owner_chk / _org_grant_chk / _partner_ceiling_chk /
 * _tier_chk / _classes_chk / _per_hour_chk) live in
 * migrations/2026-10-16-110000-ai-script-policies.sql — Drizzle is for typed
 * queries, never the constraint source of truth.
 */
export const aiScriptPolicies = pgTable('ai_script_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  proposingEnabled: boolean('proposing_enabled').notNull().default(true),
  /** PARTNER ceiling only: may any org under this partner use the lane. */
  unattendedAllowed: boolean('unattended_allowed').notNull().default(false),
  /** ORG grant only: this org has opted in. */
  unattendedEnabled: boolean('unattended_enabled').notNull().default(false),
  maxUnattendedRiskTier: text('max_unattended_risk_tier').$type<RiskTier>().notNull().default('low'),
  unattendedAllowedClasses: text('unattended_allowed_classes').array().$type<TouchClass[]>().notNull()
    .default(sql`ARRAY['services','processes','temp_files','dns_cache','printing']::text[]`),
  maxUnattendedPerHour: integer('max_unattended_per_hour').notNull().default(10),
  protectedResources: jsonb('protected_resources').$type<AiAgentProtectedResources>().notNull()
    .default(sql`'{"services":[],"paths":[],"registryKeys":[],"deviceTags":[]}'::jsonb`),
  reviewerModel: text('reviewer_model'),
  unattendedEnabledBy: uuid('unattended_enabled_by').references(() => users.id, { onDelete: 'set null' }),
  unattendedEnabledAt: timestamp('unattended_enabled_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgUq: uniqueIndex('ai_script_policies_org_uq').on(t.orgId).where(sql`${t.orgId} IS NOT NULL`),
  partnerUq: uniqueIndex('ai_script_policies_partner_uq').on(t.partnerId).where(sql`${t.partnerId} IS NOT NULL`),
}));

export type AiScriptPolicyRow = typeof aiScriptPolicies.$inferSelect;
export type NewAiScriptPolicyRow = typeof aiScriptPolicies.$inferInsert;
```

```ts
// apps/api/src/db/schema/aiScriptLaneState.ts
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';

export type AiScriptLaneStateValue = 'closed' | 'open';

/**
 * Per-ORG circuit for the unattended script lane. Deliberately NOT a reuse of
 * ai_agent_circuit_state, which is keyed (org_id, agent_id): a chat session
 * has no agent key (spec §4.1). Agents remain subject to their own circuit as
 * well — this one is additional, never a replacement.
 */
export const aiScriptLaneState = pgTable('ai_script_lane_state', {
  orgId: uuid('org_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  consecutiveFailedVerifications: integer('consecutive_failed_verifications').notNull().default(0),
  state: text('state').$type<AiScriptLaneStateValue>().notNull().default('closed'),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  openedReason: text('opened_reason'),
  resetByUserId: uuid('reset_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  resetAt: timestamp('reset_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AiScriptLaneStateRow = typeof aiScriptLaneState.$inferSelect;
export type NewAiScriptLaneStateRow = typeof aiScriptLaneState.$inferInsert;
```

```ts
// apps/api/src/db/schema/actionIntents.ts — beside decidedVia (:359)
  /**
   * AI script authoring W04 (#5612): typed evidence for a
   * decided_via = 'script_reviewer' intent (ScriptReviewerEvidence). Written
   * once at INSERT and IMMUTABLE thereafter — named in
   * action_intents_block_content_update()'s deny-list by
   * migrations/2026-10-16-110100-action-intents-script-reviewer.sql.
   */
  scriptReviewerEvidence: jsonb('script_reviewer_evidence').$type<ScriptReviewerEvidence>(),
```

```ts
// apps/api/src/db/schema/index.ts
export * from './aiScriptPolicies';
export * from './aiScriptLaneState';
```

```ts
// packages/shared/src/types/scriptProposals.ts — append
export interface ScriptPolicyDto {
  ownerScope: 'organization' | 'partner';
  proposingEnabled: boolean;
  /** Partner rows only. */
  unattendedAllowed?: boolean;
  /** Org rows only. */
  unattendedEnabled?: boolean;
  maxUnattendedRiskTier: RiskTier;
  unattendedAllowedClasses: TouchClass[];
  maxUnattendedPerHour: number;
  protectedResources: { services: string[]; paths: string[]; registryKeys: string[]; deviceTags: string[] };
  reviewerModel: string | null;
  unattendedEnabledAt: string | null;
}

export interface ScriptLaneStateDto {
  state: 'closed' | 'open';
  consecutiveFailedVerifications: number;
  openedAt: string | null;
  openedReason: string | null;
  resetAt: string | null;
}

/** What GET /ai/script-policy returns alongside the org row, so the UI can
 *  grey out anything the partner ceiling already forbids. */
export interface EffectiveScriptPolicyDto {
  proposingEnabled: boolean;
  unattendedEnabled: boolean;
  maxUnattendedRiskTier: RiskTier;
  unattendedAllowedClasses: TouchClass[];
  maxUnattendedPerHour: number;
}
```

The `ScriptReviewerEvidence` import in `actionIntents.ts` comes from `@breeze/shared` — add the interface to `packages/shared/src/types/scriptProposals.ts` now, verbatim from roadmap §3.6:

```ts
export interface ScriptReviewerEvidence {
  proposalId: string;
  reviewId: string;
  contentDigest: string;
  scannerVersion: string;
  reviewerModel: string;
  reviewerPromptVersion: string;
  touchClasses: TouchClass[];
  policySnapshot: { ceiling: RiskTier; allowedClasses: TouchClass[]; perHour: number };
  laneReservationAt: string;
  checkpointRequired: boolean;
  agent?: { agentId: string; policyEpoch: number; killEpoch: number };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/db/schema/aiScriptPolicies.test.ts && pnpm --filter @breeze/shared test --run src/types`
Expected: PASS.

- [ ] **Step 5: Prove the schema matches the migrations**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
# Expected: no drift.
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema packages/shared/src/types/scriptProposals.ts
git commit -m "feat(ai): drizzle schema + shared DTOs for the unattended script lane

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Registration — cascade, export policy, merge, RLS coverage

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:308`, `apps/api/src/services/tenantExportPolicyRegistry.ts:99`, `apps/api/src/services/orgMergeRegistry.ts` (`SPECIAL` ~`:308`, `REPOINT_TABLES` ~`:551`), `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:316` and `:588`

**Interfaces:**
- Consumes: Task 3's table names.
- Produces: nothing importable — this task exists so the five contract suites pass. **RLS coverage does not imply cascade coverage; they are separate contracts and this is the step that gets missed (five prior incidents, code review caught 0/5).**

- [ ] **Step 1: Write the failing check — grep the contract, do not eyeball it**

```bash
for t in ai_script_policies ai_script_lane_state; do
  echo "== $t"
  grep -c "'$t'" apps/api/src/services/tenantCascade.ts
  grep -c "\"$t\"" apps/api/src/services/tenantExportPolicyRegistry.ts
  grep -c "$t" apps/api/src/services/orgMergeRegistry.ts
done
# Expected right now: 0 0 0 for both. Each must become >= 1.
```

- [ ] **Step 2: Register in the org cascade order**

Alphabetical by `localeCompare` with `organizations` last: `ai_screenshots` < `ai_script_lane_state` < `ai_script_policies` < `ai_sessions` (compare `ai_scre` vs `ai_scri`). Both tables' only FK children are none, and their FK parents (`organizations`, `partners`, `users`) all sort later or are handled by the runtime topological sort, so alphabetical position is also FK-correct here — but the runtime `pg_constraint` read is what actually orders the DELETE (`tenantCascade.ts:1004-1046`).

```ts
// apps/api/src/services/tenantCascade.ts — between :308 'ai_screenshots' and :309 'ai_sessions'
  'ai_screenshots',
  // AI script authoring W04 (#5612). ai_script_lane_state is per-org circuit
  // state (PK org_id); ai_script_policies is dual-owner config whose PARTNER
  // rows have org_id NULL and are therefore never cascade participants —
  // only the org GRANT row is deleted here.
  'ai_script_lane_state',
  'ai_script_policies',
  'ai_sessions',
```

- [ ] **Step 3: Classify every column in the export policy**

```ts
// apps/api/src/services/tenantExportPolicyRegistry.ts — between :99 and :100
  // AI script authoring W04 (#5612). protected_resources is jsonb, so it is
  // excludedOpen per CLAUDE.md — an open container may embed capabilities,
  // and a protected-resource list IS a capability list. reviewer_model is a
  // model id, not a credential.
  "ai_script_lane_state": tablePolicy("org_id", {"included":["org_id","consecutive_failed_verifications","state","opened_at","opened_reason","reset_by_user_id","reset_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "ai_script_policies": tablePolicy("org_id", {"included":["id","org_id","partner_id","proposing_enabled","unattended_allowed","unattended_enabled","max_unattended_risk_tier","unattended_allowed_classes","max_unattended_per_hour","reviewer_model","unattended_enabled_by","unattended_enabled_at","created_by","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["protected_resources"]}),
```

And the new `action_intents` **column** — this is the row of the registration table that fires on a column, not just a table:

```ts
// apps/api/src/services/tenantExportPolicyRegistry.ts — the existing
// "action_intents" entry: add "script_reviewer_evidence" to excludedOpen
// (jsonb), NOT to included.
```

- [ ] **Step 4: Register the merge policy**

The org **grant** row is ordinary org config that should travel with a merged org, exactly like `ai_screenshots`/`ai_sessions`; the lane state is per-org failure-streak state that must die with the loser shell, exactly like `ai_agent_circuit_state` (`orgMergeRegistry.ts:308`). A table must appear in **exactly one** of `SPECIAL` / `REPOINT_TABLES` or the builder throws.

```ts
// apps/api/src/services/orgMergeRegistry.ts — SPECIAL, beside ai_agent_circuit_state (:308)
  // AI script authoring W04 (#5612): per-org lane circuit, not carried config
  // — a survivor org must not inherit a loser's failure streak (or its open
  // circuit). Rows die with the loser shell.
  ai_script_lane_state: { kind: 'leave-for-erasure', note: 'per-org unattended-lane failure streak and circuit state, not carried config; the survivor keeps its own lane state' },
```

```ts
// apps/api/src/services/orgMergeRegistry.ts — REPOINT_TABLES, between :551 "ai_screenshots" and :552 "ai_sessions"
  "ai_screenshots",
  // AI script authoring W04 (#5612): the ORG GRANT row is ordinary org
  // config and repoints. Partner CEILING rows have org_id NULL and are not
  // merge participants at all. The partial unique ai_script_policies_org_uq
  // means a survivor that already has its own grant row would collide, so
  // this must be verified against the merge contract test (Task 26) — if it
  // collides, convert to { kind: 'repoint-dedupe', key: ['org_id'] }.
  "ai_script_policies",
  "ai_sessions",
```

- [ ] **Step 5: Register in the RLS-coverage dual-axis lists**

```ts
// apps/api/src/__tests__/integration/rls-coverage.integration.test.ts — DUAL_AXIS_TENANT_TABLES (:316)
  // ai_script_policies (AI script authoring W04, #5612): a policy row is
  // org-scoped (org_id set — the GRANT) or partner-wide (partner_id set,
  // org_id NULL — the CEILING). Created dual-axis from day one in
  // 2026-10-16-110000-ai-script-policies. The org_id column means org-tenant
  // auto-discovery already asserts the breeze_has_org_access branch, so this
  // entry is what asserts the breeze_has_partner_access (partner-wide)
  // branch. CHECK ai_script_policies_one_owner_chk enforces exactly one axis.
  // Functional cross-partner forge proof:
  // aiScriptPoliciesPartnerRls.integration.test.ts.
  'ai_script_policies',
```

```ts
// apps/api/src/__tests__/integration/rls-coverage.integration.test.ts — XOR_OWNERSHIP_DUAL_AXIS_TABLES (:588)
  'ai_script_policies',
```

Do **not** add an entry to `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` (`:644`): its ceiling is `0`, and Task 1 already ships the branch.

Do **not** add `ai_script_lane_state` anywhere in this file — shape 1 with an `org_id` column is auto-discovered.

- [ ] **Step 6: Run the unit-visible half, then the live-DB half**

```bash
cd apps/api && npx vitest run src/services/tenantCascade
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```

Expected: PASS. `tenantCascade.integration.test.ts` asserts all five properties (alphabetised by `localeCompare` with `organizations` last; every `org_id` table present; no entry naming a non-existent table; every cascade table exactly once; FK children before parents). **These four suites only run under Integration Tests — a unit-green PR can still redden main here.**

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(ai): register the script lane tables in every cascade, export and merge list

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `resolveEffectiveScriptPolicy` — partner ceiling ∧ org grant

**Files:**
- Create: `apps/api/src/services/scriptProposals/policy.ts`, `apps/api/src/services/scriptProposals/policy.test.ts`
- Modify: `apps/api/src/services/scriptProposals/index.ts` (re-export)

**Interfaces:**
- Consumes: `aiScriptPolicies` (Task 3); `RiskTier`, `riskTierRank`, `TouchClass` from `@breeze/shared` (W01b).
- Produces:
```ts
export interface EffectiveScriptPolicy {
  proposingEnabled: boolean;
  unattendedEnabled: boolean;
  maxUnattendedRiskTier: RiskTier;
  unattendedAllowedClasses: TouchClass[];
  maxUnattendedPerHour: number;
  protectedResources: AiAgentProtectedResources;
  reviewerModel: string | null;
  source: { partnerRowId: string | null; orgRowId: string | null };
}
export function resolveEffectiveScriptPolicy(orgId: string): Promise<EffectiveScriptPolicy>;
export const SCRIPT_POLICY_DEFAULTS: Readonly<{ maxUnattendedRiskTier: RiskTier; unattendedAllowedClasses: TouchClass[]; maxUnattendedPerHour: number }>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/scriptProposals/policy.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: Array<Record<string, unknown>> = [];
vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  },
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  runOutsideDbContext: async (fn: () => unknown) => fn(),
}));
vi.mock('./partnerLookup', () => ({ orgPartnerId: async () => 'partner-1' }));

import { resolveEffectiveScriptPolicy } from './policy';

function partnerRow(over: Record<string, unknown> = {}) {
  return { id: 'p-row', orgId: null, partnerId: 'partner-1', proposingEnabled: true, unattendedAllowed: true,
    unattendedEnabled: false, maxUnattendedRiskTier: 'medium',
    unattendedAllowedClasses: ['services', 'processes', 'temp_files'], maxUnattendedPerHour: 10,
    protectedResources: { services: ['Spooler'], paths: [], registryKeys: [], deviceTags: [] },
    reviewerModel: null, ...over };
}
function orgRow(over: Record<string, unknown> = {}) {
  return { id: 'o-row', orgId: 'org-1', partnerId: null, proposingEnabled: true, unattendedAllowed: false,
    unattendedEnabled: true, maxUnattendedRiskTier: 'medium',
    unattendedAllowedClasses: ['services', 'printing'], maxUnattendedPerHour: 4,
    protectedResources: { services: [], paths: ['C:\\Windows'], registryKeys: [], deviceTags: [] },
    reviewerModel: 'claude-sonnet-x', ...over };
}

beforeEach(() => { rows.length = 0; });

describe('resolveEffectiveScriptPolicy', () => {
  it('a missing org row means the lane is OFF even with a permissive partner ceiling', async () => {
    rows.push(partnerRow());
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(false);
    expect(eff.source.orgRowId).toBeNull();
  });

  it('a missing partner row means the lane is OFF even with an org grant', async () => {
    rows.push(orgRow());
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(false);
  });

  it('booleans AND, tiers min, classes intersect, per-hour min, protected resources union', async () => {
    rows.push(partnerRow(), orgRow());
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(true);
    expect(eff.maxUnattendedRiskTier).toBe('medium');
    expect(eff.unattendedAllowedClasses).toEqual(['services']); // intersection, sorted
    expect(eff.maxUnattendedPerHour).toBe(4);
    expect(eff.protectedResources.services).toEqual(['Spooler']);
    expect(eff.protectedResources.paths).toEqual(['C:\\Windows']);
  });

  it('the org can only TIGHTEN the tier, never raise it', async () => {
    rows.push(partnerRow({ maxUnattendedRiskTier: 'low' }), orgRow({ maxUnattendedRiskTier: 'medium' }));
    expect((await resolveEffectiveScriptPolicy('org-1')).maxUnattendedRiskTier).toBe('low');
  });

  it('proposingEnabled is an AND of both rows', async () => {
    rows.push(partnerRow({ proposingEnabled: false }), orgRow({ proposingEnabled: true }));
    expect((await resolveEffectiveScriptPolicy('org-1')).proposingEnabled).toBe(false);
  });

  it('an org reviewerModel overrides the partner default; null falls back', async () => {
    rows.push(partnerRow({ reviewerModel: 'partner-model' }), orgRow({ reviewerModel: null }));
    expect((await resolveEffectiveScriptPolicy('org-1')).reviewerModel).toBe('partner-model');
  });

  it('with neither row present everything is off and proposing still defaults on', async () => {
    const eff = await resolveEffectiveScriptPolicy('org-1');
    expect(eff.unattendedEnabled).toBe(false);
    expect(eff.proposingEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/policy.test.ts`
Expected: FAIL — `Cannot find module './policy'`.

- [ ] **Step 3: Implement the resolver**

The merge mirrors `mergeAgentPolicies` (`services/aiAgents/effectivePolicy.ts:141-239`): booleans AND, ladders take the stricter end via a rank table exactly like `minAgentMode` (`packages/shared/src/types/aiAgents.ts:10-12`), narrowing lists intersect, and **protected resources union** (more protected is tighter — `effectivePolicy.ts:233-238`). Those helpers are module-private there, so mirror the style rather than importing them.

```ts
// apps/api/src/services/scriptProposals/policy.ts
import { and, eq, isNull, or } from 'drizzle-orm';
import { riskTierRank, type RiskTier, type TouchClass, type AiAgentProtectedResources } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiScriptPolicies, type AiScriptPolicyRow } from '../../db/schema/aiScriptPolicies';
import { organizations } from '../../db/schema/orgs';

export const SCRIPT_POLICY_DEFAULTS = Object.freeze({
  maxUnattendedRiskTier: 'low' as RiskTier,
  unattendedAllowedClasses: ['services', 'processes', 'temp_files', 'dns_cache', 'printing'] as TouchClass[],
  maxUnattendedPerHour: 10,
});

const EMPTY_PROTECTED: AiAgentProtectedResources =
  { services: [], paths: [], registryKeys: [], deviceTags: [] };

/** Lower rank = stricter, exactly like AI_AGENT_MODE_RANK. */
const minTier = (a: RiskTier, b: RiskTier): RiskTier => (riskTierRank(a) <= riskTierRank(b) ? a : b);
const intersect = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((v) => b.includes(v)).sort();
const union = (a: readonly string[], b: readonly string[]): string[] =>
  Array.from(new Set([...a, ...b])).sort();

export interface EffectiveScriptPolicy {
  proposingEnabled: boolean;
  unattendedEnabled: boolean;
  maxUnattendedRiskTier: RiskTier;
  unattendedAllowedClasses: TouchClass[];
  maxUnattendedPerHour: number;
  protectedResources: AiAgentProtectedResources;
  reviewerModel: string | null;
  source: { partnerRowId: string | null; orgRowId: string | null };
}

/**
 * Effective lane policy for one org: the PARTNER ceiling ANDed with the ORG
 * grant (spec §4.1's table, D10).
 *
 * The two rows are fetched in ONE query with an OR predicate, not two: the
 * partner-wide row is reachable from an org-scoped RLS context only through
 * the `ai_script_policies_partner_wide_select` branch, and a second query
 * would be a second round trip for no gain. NEVER escalate to
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))` to read this —
 * for a plain org-XOR-partner config table that pattern double-holds a pooled
 * connection under the request's own transaction (a hang at concurrency >=
 * pool size) and bypasses RLS entirely (#2417 shipped a cross-tenant hole
 * through exactly that path). The SELECT-only partner branch exists so this
 * read needs no escalation at all.
 *
 * `unattendedEnabled` is FALSE whenever either row is missing: a blanket
 * partner enablement must never enable an org that never opted in, and an org
 * grant must never outrun its MSP's ceiling.
 */
export async function resolveEffectiveScriptPolicy(orgId: string): Promise<EffectiveScriptPolicy> {
  const [{ partnerId } = { partnerId: null as string | null }] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const rows: AiScriptPolicyRow[] = await db
    .select()
    .from(aiScriptPolicies)
    .where(
      partnerId
        ? or(
          eq(aiScriptPolicies.orgId, orgId),
          and(isNull(aiScriptPolicies.orgId), eq(aiScriptPolicies.partnerId, partnerId)),
        )
        : eq(aiScriptPolicies.orgId, orgId),
    )
    .limit(2);

  const partner = rows.find((r) => r.orgId === null) ?? null;
  const org = rows.find((r) => r.orgId !== null) ?? null;

  // Both rows required. A one-sided configuration is not a lane.
  const unattendedEnabled = !!partner?.unattendedAllowed && !!org?.unattendedEnabled;

  return {
    proposingEnabled: (partner?.proposingEnabled ?? true) && (org?.proposingEnabled ?? true),
    unattendedEnabled,
    maxUnattendedRiskTier: minTier(
      partner?.maxUnattendedRiskTier ?? SCRIPT_POLICY_DEFAULTS.maxUnattendedRiskTier,
      org?.maxUnattendedRiskTier ?? SCRIPT_POLICY_DEFAULTS.maxUnattendedRiskTier,
    ),
    unattendedAllowedClasses: intersect(
      partner?.unattendedAllowedClasses ?? SCRIPT_POLICY_DEFAULTS.unattendedAllowedClasses,
      org?.unattendedAllowedClasses ?? SCRIPT_POLICY_DEFAULTS.unattendedAllowedClasses,
    ) as TouchClass[],
    maxUnattendedPerHour: Math.min(
      partner?.maxUnattendedPerHour ?? SCRIPT_POLICY_DEFAULTS.maxUnattendedPerHour,
      org?.maxUnattendedPerHour ?? SCRIPT_POLICY_DEFAULTS.maxUnattendedPerHour,
    ),
    // UNION, not intersection: more protected is tighter
    // (effectivePolicy.ts:233-238 makes the same call for agents).
    protectedResources: {
      services: union(partner?.protectedResources.services ?? [], org?.protectedResources.services ?? []),
      paths: union(partner?.protectedResources.paths ?? [], org?.protectedResources.paths ?? []),
      registryKeys: union(partner?.protectedResources.registryKeys ?? [], org?.protectedResources.registryKeys ?? []),
      deviceTags: union(partner?.protectedResources.deviceTags ?? [], org?.protectedResources.deviceTags ?? []),
    },
    reviewerModel: org?.reviewerModel ?? partner?.reviewerModel ?? null,
    source: { partnerRowId: partner?.id ?? null, orgRowId: org?.id ?? null },
  };
}

export { EMPTY_PROTECTED as EMPTY_PROTECTED_RESOURCES };
```

Add the re-export:

```ts
// apps/api/src/services/scriptProposals/index.ts
export { resolveEffectiveScriptPolicy, SCRIPT_POLICY_DEFAULTS, type EffectiveScriptPolicy } from './policy';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/policy.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptProposals/policy.ts apps/api/src/services/scriptProposals/policy.test.ts apps/api/src/services/scriptProposals/index.ts
git commit -m "feat(ai): resolveEffectiveScriptPolicy — partner ceiling AND org grant

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire `reviewer_model` into W02's `resolveReviewerModel` seam

**Files:**
- Modify: `apps/api/src/services/scriptProposals/reviewer.ts` (`resolveReviewerModel`)
- Test: `apps/api/src/services/scriptProposals/reviewer.test.ts` (existing, extend)

**Interfaces:**
- Consumes: `resolveEffectiveScriptPolicy` (Task 5).
- Produces: `resolveReviewerModel(orgId)` now returns the effective `reviewerModel` when a policy row supplies one.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/scriptProposals/reviewer.test.ts — append
  it('prefers the effective policy reviewer_model over the platform default', async () => {
    mockEffectivePolicy.mockResolvedValue({ ...baseEffectivePolicy, reviewerModel: 'org-chosen-model' });
    await expect(resolveReviewerModel('org-1')).resolves.toBe('org-chosen-model');
  });

  it('falls back to the platform default when no policy row names a model', async () => {
    mockEffectivePolicy.mockResolvedValue({ ...baseEffectivePolicy, reviewerModel: null });
    await expect(resolveReviewerModel('org-1')).resolves.toBe(config.ai.scriptReviewerModel);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/reviewer.test.ts`
Expected: FAIL — W02's stub returns the platform default unconditionally.

- [ ] **Step 3: Replace the stub**

```ts
// apps/api/src/services/scriptProposals/reviewer.ts
import { resolveEffectiveScriptPolicy } from './policy';

/**
 * W02 shipped this as "platform default until W04's policy table exists"
 * (roadmap §3.4). It exists now. The org may only choose a model the
 * partner's BYOK provider already serves — that constraint is enforced by
 * the PUT route's validation (Task 22), not here, so this stays a plain read.
 */
export async function resolveReviewerModel(orgId: string): Promise<string> {
  const effective = await resolveEffectiveScriptPolicy(orgId);
  return effective.reviewerModel ?? config.ai.scriptReviewerModel;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/reviewer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptProposals/reviewer.ts apps/api/src/services/scriptProposals/reviewer.test.ts
git commit -m "feat(ai): resolveReviewerModel reads the effective script policy

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `ensureRestoreCheckpoint` — the invariant-11 recovery prerequisite

**Files:**
- Create: `apps/api/src/services/deviceRecovery/restoreCheckpoint.ts`, `apps/api/src/services/deviceRecovery/restoreCheckpoint.test.ts`

**Interfaces:**
- Consumes: `dispatchScriptToDevice` (`services/scriptDispatch.ts:234`), `deviceCommands` (`db/schema/devices.ts:553`).
- Produces:
```ts
export type RestoreCheckpointResult =
  | { ok: true; checkpointRef: string }
  | { ok: false; reason: 'unsupported_platform' | 'device_unavailable' | 'dispatch_failed' | 'timeout' | 'checkpoint_failed' };
export function ensureRestoreCheckpoint(deviceId: string): Promise<RestoreCheckpointResult>;
export const RESTORE_CHECKPOINT_CLASSES: ReadonlySet<TouchClass>; // registry, services, files_system
export const RESTORE_CHECKPOINT_SCRIPT: string; // the fixed PowerShell body, documented and immutable
```

**Investigation finding (spec §10, open item — resolved here).** There is **no** System Restore primitive anywhere in the repo: greps for `restore point`, `RestorePoint`, `Checkpoint-Computer`, `systemRestore`, `SRSetRestorePoint`, `srclient` across `agent/`, `apps/api/src` and `packages/` return zero hits, and the string `#4609` appears nowhere in the tree. The only `Checkpoint` symbol is Hyper-V **guest VM** checkpointing (`agent/internal/remote/tools/types.go:226` `CmdHypervCheckpoint`), which is not host System Restore. Patch install does **not** take one either: `apps/api/src/jobs/patchJobExecutor.ts:1191-1198` dispatches `install_patches` with `{ patchJobId, patchIds, patches }` and no checkpoint field, and `agent/internal/heartbeat/handlers_patch.go:136-153` runs only `patching.RunPreflight` (service health / disk / AC power / maintenance window) before installing. "Rollback" in patching is KB uninstall (`handlers_patch.go:156`), not an OS checkpoint. **So #4609 is unimplemented, not patch-only.** This task therefore implements the server side on the existing `script` primitive — no new agent command type, no agent change (Global Constraints).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/deviceRecovery/restoreCheckpoint.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const device: Record<string, unknown> = { id: 'dev-1', orgId: 'org-1', osType: 'windows', status: 'online', agentId: 'agent-1', hostname: 'WIN-A', siteId: null, customFields: {} };
const mockDispatch = vi.fn();
const commandRows: Array<Record<string, unknown>> = [];

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (commandRows.length ? commandRows : [device]) }) }) }),
  },
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  runOutsideDbContext: async (fn: () => unknown) => fn(),
}));
vi.mock('../scriptDispatch', () => ({ dispatchScriptToDevice: (...a: unknown[]) => mockDispatch(...a) }));

import { ensureRestoreCheckpoint, RESTORE_CHECKPOINT_SCRIPT } from './restoreCheckpoint';

beforeEach(() => { mockDispatch.mockReset(); commandRows.length = 0; device.osType = 'windows'; });

describe('ensureRestoreCheckpoint', () => {
  it('refuses on a non-Windows device without dispatching anything', async () => {
    device.osType = 'linux';
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'unsupported_platform' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('dispatches the FIXED system script, never caller-supplied content', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ id: 'cmd-1', status: 'completed', result: { exitCode: 0, stdout: 'BREEZE_CHECKPOINT_OK seq=42' } });
    const res = await ensureRestoreCheckpoint('dev-1');
    const arg = mockDispatch.mock.calls[0]![0] as { source: { kind: string; content: string }; runAs: string };
    expect(arg.source.kind).toBe('raw');
    expect(arg.source.content).toBe(RESTORE_CHECKPOINT_SCRIPT);
    expect(arg.runAs).toBe('system');
    expect(res).toEqual({ ok: true, checkpointRef: '42' });
  });

  it('bypasses the maintenance window — the checkpoint protects a run the lane already admitted', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ id: 'cmd-1', status: 'completed', result: { exitCode: 0, stdout: 'BREEZE_CHECKPOINT_OK seq=1' } });
    await ensureRestoreCheckpoint('dev-1');
    expect((mockDispatch.mock.calls[0]![0] as { bypassMaintenanceWindow: boolean }).bypassMaintenanceWindow).toBe(true);
  });

  it('fails closed when dispatch is refused', async () => {
    mockDispatch.mockResolvedValue({ ok: false, code: 'device_offline', error: 'offline' });
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'device_unavailable' });
  });

  it('fails closed on a non-zero exit code', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ id: 'cmd-1', status: 'completed', result: { exitCode: 1, stdout: '', stderr: 'SR disabled' } });
    await expect(ensureRestoreCheckpoint('dev-1')).resolves.toEqual({ ok: false, reason: 'checkpoint_failed' });
  });

  it('fails closed when the command never reports', async () => {
    mockDispatch.mockResolvedValue({ ok: true, commandId: 'cmd-1', executionId: null, delivered: true });
    commandRows.push({ id: 'cmd-1', status: 'pending', result: null });
    await expect(ensureRestoreCheckpoint('dev-1', { timeoutMs: 30, pollMs: 10 }))
      .resolves.toEqual({ ok: false, reason: 'timeout' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/deviceRecovery/restoreCheckpoint.test.ts`
Expected: FAIL — `Cannot find module './restoreCheckpoint'`.

- [ ] **Step 3: Implement it**

```ts
// apps/api/src/services/deviceRecovery/restoreCheckpoint.ts
import { eq } from 'drizzle-orm';
import type { TouchClass } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, deviceCommands } from '../../db/schema/devices';
import { dispatchScriptToDevice } from '../scriptDispatch';
import { captureException } from '../sentry';

/**
 * Windows System Restore checkpoint, taken before an UNATTENDED script run
 * whose classifier output touches something a restore point can undo
 * (spec §4.6 invariant 11).
 *
 * WHY A FIXED SCRIPT AND NOT A NEW DEVICE COMMAND. The agent has no System
 * Restore handler (verified: no `Cmd*` constant and no handler_registry entry
 * for one; `agent/internal/heartbeat/handlers.go:17`), and adding one would
 * mean a new constant in `agent/internal/remote/tools/types.go`, a handler
 * init(), a `commandTypes.ts` entry, a `commandOfflinePolicy.ts` registration
 * and a `commandResultHandlers.ts` handler — i.e. an agent change, which this
 * wave's Global Constraints forbid. The existing `script` primitive already
 * carries exactly the payload this needs. Filing the first-class command is a
 * W05 follow-up.
 *
 * The script body is a CONSTANT. It is never composed from caller input, so
 * this function cannot become a general-purpose remote-execution hole.
 *
 * NON-WINDOWS RETURNS `unsupported_platform`. That is not a soft failure: it
 * makes the `registry`, `services` and `files_system` classes lane-INELIGIBLE
 * on Linux and macOS in v1 (spec §4.6 invariant 11, §10), because the lane
 * refuses when the checkpoint is unavailable. An operator who wants
 * `services` unattended on Linux must approve by hand.
 */
export const RESTORE_CHECKPOINT_CLASSES: ReadonlySet<TouchClass> =
  new Set<TouchClass>(['registry', 'services', 'files_system']);

/**
 * Enables System Restore on the system drive if it is off, clears the 1440-
 * minute throttle for this one call, creates the checkpoint, and prints the
 * new sequence number. `-ErrorAction Stop` + the explicit exit codes mean a
 * silently-skipped checkpoint reports failure instead of success.
 */
export const RESTORE_CHECKPOINT_SCRIPT = [
  '$ErrorAction = "Stop"',
  'try {',
  '  Enable-ComputerRestore -Drive "$env:SystemDrive\\"',
  '  New-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore" ' +
    '-Name "SystemRestorePointCreationFrequency" -Value 0 -PropertyType DWord -Force | Out-Null',
  '  $before = (Get-ComputerRestorePoint | Measure-Object -Property SequenceNumber -Maximum).Maximum',
  '  Checkpoint-Computer -Description "Breeze AI script lane" -RestorePointType "APPLICATION_INSTALL"',
  '  $after = (Get-ComputerRestorePoint | Measure-Object -Property SequenceNumber -Maximum).Maximum',
  '  if ($null -eq $after -or $after -eq $before) { Write-Error "no restore point was created"; exit 1 }',
  '  Write-Output "BREEZE_CHECKPOINT_OK seq=$after"',
  '  exit 0',
  '} catch { Write-Error $_.Exception.Message; exit 1 }',
].join('\n');

const CHECKPOINT_TIMEOUT_MS = 180_000;
const CHECKPOINT_POLL_MS = 3_000;

export type RestoreCheckpointResult =
  | { ok: true; checkpointRef: string }
  | { ok: false; reason: 'unsupported_platform' | 'device_unavailable' | 'dispatch_failed' | 'timeout' | 'checkpoint_failed' };

export async function ensureRestoreCheckpoint(
  deviceId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<RestoreCheckpointResult> {
  const timeoutMs = opts.timeoutMs ?? CHECKPOINT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? CHECKPOINT_POLL_MS;
  try {
    const [device] = await db
      .select({
        id: devices.id, orgId: devices.orgId, osType: devices.osType, status: devices.status,
        agentId: devices.agentId, hostname: devices.hostname, siteId: devices.siteId,
        customFields: devices.customFields,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device) return { ok: false, reason: 'device_unavailable' };
    if (device.osType !== 'windows') return { ok: false, reason: 'unsupported_platform' };

    const dispatch = await dispatchScriptToDevice({
      device,
      source: { kind: 'raw', content: RESTORE_CHECKPOINT_SCRIPT, language: 'powershell', provenance: 'ai_script_lane_checkpoint' },
      runAs: 'system',
      timeoutSeconds: 150,
      triggerType: 'system',
      // The lane already decided this run happens; a maintenance window must
      // not strip the run of its rollback point while letting the run itself
      // proceed. The RUN's own window check is unchanged (invariant 14).
      bypassMaintenanceWindow: true,
      offlinePolicy: { kind: 'reject' },
    });
    if (!dispatch.ok) {
      return { ok: false, reason: dispatch.code === 'device_offline' || dispatch.code === 'device_decommissioned' ? 'device_unavailable' : 'dispatch_failed' };
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = await db
        .select({ status: deviceCommands.status, result: deviceCommands.result })
        .from(deviceCommands)
        .where(eq(deviceCommands.id, dispatch.commandId))
        .limit(1);
      const result = row?.result as { exitCode?: number; stdout?: string } | null | undefined;
      if (row && result && typeof result.exitCode === 'number') {
        if (result.exitCode !== 0) return { ok: false, reason: 'checkpoint_failed' };
        const seq = /BREEZE_CHECKPOINT_OK seq=(\d+)/.exec(result.stdout ?? '')?.[1];
        return seq ? { ok: true, checkpointRef: seq } : { ok: false, reason: 'checkpoint_failed' };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { ok: false, reason: 'timeout' };
  } catch (err) {
    console.error('[restoreCheckpoint] failed — denying the lane (fail-closed):', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { ok: false, reason: 'dispatch_failed' };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/deviceRecovery/restoreCheckpoint.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/deviceRecovery/restoreCheckpoint.ts apps/api/src/services/deviceRecovery/restoreCheckpoint.test.ts
git commit -m "feat(ai): ensureRestoreCheckpoint — Windows System Restore prerequisite for the lane

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Extract the protected-resource matcher for classifier names

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts:1649-1690`
- Test: `apps/api/src/services/aiGuardrails.protectedNames.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export function touchesProtectedNames(
  names: { services?: readonly string[]; paths?: readonly string[]; registryKeys?: readonly string[]; deviceTags?: readonly string[] },
  protectedResources: AiAgentProtectedResources,
): string | null;
```
`touchesProtected` (module-private, `:1649`) is refactored to build the name lists from its input keys and delegate. **Do not write a second matcher** — the path/registry hierarchy comparison (`pathIsProtected` `:1631`, `registryKeyIsProtected` `:1641`) is subtle and must have exactly one implementation.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiGuardrails.protectedNames.test.ts
import { describe, it, expect } from 'vitest';
import { touchesProtectedNames } from './aiGuardrails';

const PROTECTED = { services: ['Spooler'], paths: ['C:\\Windows'], registryKeys: ['HKLM\\SOFTWARE\\Breeze'], deviceTags: ['production'] };

describe('touchesProtectedNames', () => {
  it('matches a service case-insensitively', () => {
    expect(touchesProtectedNames({ services: ['spooler'] }, PROTECTED)).toBe('service "spooler" is protected');
  });
  it('matches a descendant path, not just an exact one', () => {
    expect(touchesProtectedNames({ paths: ['C:\\Windows\\System32\\drivers'] }, PROTECTED)).toContain('is protected');
  });
  it('matches a descendant registry key', () => {
    expect(touchesProtectedNames({ registryKeys: ['HKLM\\SOFTWARE\\Breeze\\Agent'] }, PROTECTED)).toContain('is protected');
  });
  it('returns null when nothing matches', () => {
    expect(touchesProtectedNames({ services: ['Themes'], paths: ['D:\\temp'] }, PROTECTED)).toBeNull();
  });
  it('an empty name set never matches', () => {
    expect(touchesProtectedNames({}, PROTECTED)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiGuardrails.protectedNames.test.ts`
Expected: FAIL — `touchesProtectedNames is not a function`.

- [ ] **Step 3: Extract and delegate**

```ts
// apps/api/src/services/aiGuardrails.ts — replacing :1649-1690

/**
 * Protected-resource matcher over EXPLICIT name lists.
 *
 * Split out of `touchesProtected` for the AI script lane (#5612 W04): the
 * agent path derives names from NAMED INPUT FIELDS (`serviceName`, path keys,
 * registry keys — `aiGuardrails.ts` has never inspected script content), while
 * the lane derives them from the shared scanner's `ScriptScanResult.
 * touchedNames`. Same comparison semantics, one implementation — the
 * path/registry hierarchy normalisation below is exactly the part that must
 * not be duplicated.
 *
 * Stays a pure function with no DB or registry import
 * (`aiGuardrails.imports.contract.test.ts`).
 */
export function touchesProtectedNames(
  names: {
    services?: readonly string[];
    paths?: readonly string[];
    registryKeys?: readonly string[];
    deviceTags?: readonly string[];
  },
  protectedResources: AiAgentProtectedResources,
): string | null {
  for (const serviceName of names.services ?? []) {
    if (protectedResources.services.some(
      (protectedService) => protectedService.toLowerCase() === serviceName.toLowerCase(),
    )) {
      return `service "${serviceName}" is protected`;
    }
  }

  for (const path of names.paths ?? []) {
    if (protectedResources.paths.some((protectedPath) => pathIsProtected(path, protectedPath))) {
      return `path "${path}" is protected`;
    }
  }

  for (const registryKey of names.registryKeys ?? []) {
    if (protectedResources.registryKeys.some(
      (protectedKey) => registryKeyIsProtected(registryKey, protectedKey),
    )) {
      return `registry key "${registryKey}" is protected`;
    }
  }

  for (const deviceTag of names.deviceTags ?? []) {
    // Case-insensitive, matching services/paths/registry. 'Production' vs
    // 'production' passed before.
    if (protectedResources.deviceTags.some(
      (protectedTag) => protectedTag.toLowerCase() === deviceTag.toLowerCase(),
    )) {
      return `device tag "${deviceTag}" is protected`;
    }
  }

  return null;
}

function touchesProtected(
  input: Record<string, unknown>,
  protectedResources: AiAgentProtectedResources,
): string | null {
  return touchesProtectedNames(
    {
      services: leafValuesFor(input, SERVICE_INPUT_KEYS),
      paths: leafValuesFor(input, PATH_INPUT_KEYS),
      registryKeys: leafValuesFor(input, REGISTRY_INPUT_KEYS),
      deviceTags: [
        ...leafValuesFor(input, DEVICE_TAG_INPUT_KEYS),
        ...leafValuesFor(input, DEVICE_TAG_ARRAY_INPUT_KEYS),
      ],
    },
    protectedResources,
  );
}
```

The single call site (`:1827-1828`, inside `checkAgentGuardrails`) is unchanged.

- [ ] **Step 4: Run the new test plus the guardrail suites to prove the refactor is inert**

Run: `cd apps/api && npx vitest run src/services/aiGuardrails.protectedNames.test.ts src/services/aiGuardrails`
Expected: PASS, including `aiGuardrails.imports.contract.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiGuardrails.protectedNames.test.ts
git commit -m "refactor(ai): extract touchesProtectedNames so the script lane reuses one matcher

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `evaluateScriptReviewerAutonomy` — module surface and invariants 1–6

**Files:**
- Create: `apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts`, `apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts`

**Interfaces:**
- Consumes: `resolveEffectiveScriptPolicy` (Task 5); `riskTierRank`, `LANE_HARD_DENIED_CLASSES`, `TouchClass`, `RiskTier`, `ScriptReviewerEvidence` from `@breeze/shared`; `ScriptProposalRow`, `ScriptProposalReviewRow` (W01b/W02).
- Produces (roadmap §3.6, exact names):
```ts
export type ScriptReviewerRefusal =
  | 'lane_disabled' | 'proposal_not_runnable' | 'review_missing' | 'risk_above_ceiling'
  | 'verdict_not_approve' | 'strict_hits' | 'class_not_allowed' | 'class_hard_denied'
  | 'protected_resource' | 'timeout_too_long' | 'scope_not_supervised' | 'multi_device'
  | 'checkpoint_unavailable' | 'lane_open' | 'hourly_cap' | 'requester_unauthorized'
  | 'device_unavailable';
export interface ScriptReviewerAutonomyArgs {
  tx: Database;
  auth: AuthContext;
  intentDraft: {
    orgId: string;
    approvalScope: 'supervised' | 'four_eyes';
    agentRun: { id: string; agentId: string; policySnapshot: AiAgentPolicySnapshot } | null;
    arguments: Record<string, unknown>;
  };
  proposal: ScriptProposalRow;
  review: ScriptProposalReviewRow | null;
}
export type ScriptReviewerDecision =
  | { granted: true; evidence: ScriptReviewerEvidence }
  | { granted: false; reason: ScriptReviewerRefusal };
export function evaluateScriptReviewerAutonomy(args: ScriptReviewerAutonomyArgs): Promise<ScriptReviewerDecision>;
```

**Ordering contract.** Invariants are evaluated **in the order 1…14** and the **first** failure is the recorded reason (spec §4.6). Do not reorder for performance: the refusal reason is user-visible on the card and in audit, and a reordering silently changes what operators are told.

- [ ] **Step 1: Write the failing table-driven test with the first six negatives and the positive control**

```ts
// apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPolicy = vi.fn();
const mockCheckpoint = vi.fn();
const mockCount = vi.fn();
const mockLane = vi.fn();
const mockDevice = vi.fn();
const mockToolPermission = vi.fn();

vi.mock('../scriptProposals/policy', () => ({ resolveEffectiveScriptPolicy: (...a: unknown[]) => mockPolicy(...a) }));
vi.mock('../deviceRecovery/restoreCheckpoint', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureRestoreCheckpoint: (...a: unknown[]) => mockCheckpoint(...a),
}));
vi.mock('../aiGuardrails', () => ({
  checkToolPermission: (...a: unknown[]) => mockToolPermission(...a),
  checkAgentGuardrails: () => ({ allowed: true, disposition: 'allow' }),
  touchesProtectedNames: () => null,
}));
vi.mock('./laneQueries', () => ({
  lockScriptLane: async () => undefined,
  readLaneState: (...a: unknown[]) => mockLane(...a),
  countRecentLaneIntents: (...a: unknown[]) => mockCount(...a),
  readLaneDevice: (...a: unknown[]) => mockDevice(...a),
}));

import { evaluateScriptReviewerAutonomy } from './scriptReviewerAutonomy';

const PROPOSAL = {
  id: 'prop-1', orgId: 'org-1', status: 'reviewed', contentDigest: 'd'.repeat(64),
  scannerVersion: '2026-09-11.1', basicHits: [], strictHits: [],
  touchClasses: ['services'], touchedNames: { services: ['Spooler'], paths: [], registryKeys: [] },
  timeoutSeconds: 120, targetDeviceIds: ['dev-1'], intentId: null,
  expiresAt: new Date(Date.now() + 3_600_000), supersedesId: null,
};
const REVIEW = {
  id: 'rev-1', proposalId: 'prop-1', reviewerKind: 'model', status: 'completed',
  riskTier: 'low', goalMatch: 'yes', reversible: true, verificationAdequate: true,
  recommendedAction: 'approve', model: 'sonnet-x', reviewerPromptVersion: 'v1',
};
const EFFECTIVE = {
  proposingEnabled: true, unattendedEnabled: true, maxUnattendedRiskTier: 'low',
  unattendedAllowedClasses: ['services', 'processes', 'temp_files', 'dns_cache', 'printing'],
  maxUnattendedPerHour: 10,
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  reviewerModel: null, source: { partnerRowId: 'p', orgRowId: 'o' },
};

function args(over: Record<string, unknown> = {}) {
  return {
    tx: {} as never,
    auth: { scope: 'organization', principal: { kind: 'user' }, user: { id: 'u-1' } } as never,
    intentDraft: { orgId: 'org-1', approvalScope: 'supervised', agentRun: null, arguments: { proposalId: 'prop-1', deviceIds: ['dev-1'] } },
    proposal: { ...PROPOSAL },
    review: { ...REVIEW },
    ...over,
  } as never;
}

beforeEach(() => {
  mockPolicy.mockResolvedValue({ ...EFFECTIVE });
  mockCheckpoint.mockResolvedValue({ ok: true, checkpointRef: '42' });
  mockCount.mockResolvedValue(0);
  mockLane.mockResolvedValue({ state: 'closed' });
  mockDevice.mockResolvedValue({ id: 'dev-1', status: 'online', osType: 'windows', maintenanceSuppressed: false });
  mockToolPermission.mockResolvedValue(null);
});

describe('evaluateScriptReviewerAutonomy — invariants 1-6', () => {
  it('POSITIVE CONTROL: grants and returns typed evidence', async () => {
    const res = await evaluateScriptReviewerAutonomy(args());
    expect(res).toMatchObject({ granted: true });
    if (!res.granted) throw new Error('unreachable');
    expect(res.evidence).toMatchObject({
      proposalId: 'prop-1', reviewId: 'rev-1', contentDigest: 'd'.repeat(64),
      scannerVersion: '2026-09-11.1', reviewerModel: 'sonnet-x', reviewerPromptVersion: 'v1',
      touchClasses: ['services'], checkpointRequired: false,
      policySnapshot: { ceiling: 'low', allowedClasses: EFFECTIVE.unattendedAllowedClasses, perHour: 10 },
    });
    expect(typeof res.evidence.laneReservationAt).toBe('string');
  });

  it('1 — lane disabled', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedEnabled: false });
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'lane_disabled' });
  });

  it.each([
    ['status not reviewed', { status: 'changes_requested' }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['superseded', { status: 'superseded' }],
    ['already consumed', { intentId: 'other-intent' }],
    ['basic hits present', { basicHits: ['curl | bash'] }],
  ])('2 — proposal not runnable (%s)', async (_label, patch) => {
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, ...patch } })))
      .toEqual({ granted: false, reason: 'proposal_not_runnable' });
  });

  it.each([
    ['no review at all', null],
    ['review failed', { ...REVIEW, status: 'failed' }],
    ['static scan is not a model review', { ...REVIEW, reviewerKind: 'static_scan' }],
  ])('3 — review missing (%s)', async (_label, review) => {
    expect(await evaluateScriptReviewerAutonomy(args({ review })))
      .toEqual({ granted: false, reason: 'review_missing' });
  });

  it('3 — risk above the effective ceiling', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ review: { ...REVIEW, riskTier: 'medium' } })))
      .toEqual({ granted: false, reason: 'risk_above_ceiling' });
  });

  it.each([
    ['goalMatch partial', { goalMatch: 'partial' }],
    ['not reversible', { reversible: false }],
    ['verification inadequate', { verificationAdequate: false }],
    ['recommends changes', { recommendedAction: 'changes' }],
  ])('4 — verdict not approve (%s)', async (_label, patch) => {
    expect(await evaluateScriptReviewerAutonomy(args({ review: { ...REVIEW, ...patch } })))
      .toEqual({ granted: false, reason: 'verdict_not_approve' });
  });

  it('5 — any STRICT hit refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, strictHits: ['Invoke-Expression'] } })))
      .toEqual({ granted: false, reason: 'strict_hits' });
  });

  it('6 — an empty class set refuses (a script the classifier cannot place gets a human)', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: [] } })))
      .toEqual({ granted: false, reason: 'class_not_allowed' });
  });

  it('6 — a class outside the effective allowlist refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: ['services', 'packages'] } })))
      .toEqual({ granted: false, reason: 'class_not_allowed' });
  });

  it('6 — a hard-denied class refuses even if an operator put it in the allowlist', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedAllowedClasses: ['services', 'credentials'] });
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: ['credentials'] } })))
      .toEqual({ granted: false, reason: 'class_hard_denied' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: FAIL — `Cannot find module './scriptReviewerAutonomy'`.

- [ ] **Step 3: Write the module with invariants 1–6 and stubs that always pass for 7–14**

Write the file with the full ordered skeleton; Tasks 10–13 fill the stubs. Mirror `ticketAutonomy.ts`'s shape exactly: a `deny()` helper, cheap synchronous gates before any DB work, and **one wrapping `try/catch` that denies rather than letting an exception escape into `createActionIntent`'s transaction**.

```ts
// apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts
import {
  LANE_HARD_DENIED_CLASSES, riskTierRank,
  type RiskTier, type ScriptReviewerEvidence, type TouchClass,
} from '@breeze/shared';
import type { Database } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { captureException } from '../sentry';
import { resolveEffectiveScriptPolicy } from '../scriptProposals/policy';
import type { ScriptProposalRow, ScriptProposalReviewRow } from '../scriptProposals/types';

/**
 * The unattended script lane's creation-transaction autonomy decision
 * (spec §4.6, D8/D9). Sits beside `evaluateTicketAutonomy`
 * (`ticketAutonomy.ts`) at `intentService.ts:1572` and shares its contract:
 * evaluated INSIDE the intent's transaction on the ambient `db`, never throws,
 * and a refusal is a breadcrumb on a row that still proceeds down the ordinary
 * human path — never an error to the caller.
 *
 * WHAT THE REVIEWER IS ALLOWED TO DECIDE. Invariants 3 and 4, and nothing
 * else. Every other gate reads the deterministic classifier, the policy rows,
 * RBAC, or live device state. A model label is not an enforcement boundary
 * (Codex quorum, critical finding → D9).
 *
 * ORDER IS PART OF THE CONTRACT. The FIRST failure is the reason recorded and
 * shown. Do not reorder.
 */
export type ScriptReviewerRefusal =
  | 'lane_disabled'
  | 'proposal_not_runnable'
  | 'review_missing'
  | 'risk_above_ceiling'
  | 'verdict_not_approve'
  | 'strict_hits'
  | 'class_not_allowed'
  | 'class_hard_denied'
  | 'protected_resource'
  | 'timeout_too_long'
  | 'scope_not_supervised'
  | 'multi_device'
  | 'checkpoint_unavailable'
  | 'lane_open'
  | 'hourly_cap'
  | 'requester_unauthorized'
  | 'device_unavailable';

export type ScriptReviewerDecision =
  | { granted: true; evidence: ScriptReviewerEvidence }
  | { granted: false; reason: ScriptReviewerRefusal };

export interface ScriptReviewerAutonomyArgs {
  /** The ambient transaction handle from `createActionIntent`. */
  tx: Database;
  auth: AuthContext;
  intentDraft: {
    orgId: string;
    approvalScope: 'supervised' | 'four_eyes';
    agentRun: { id: string; agentId: string; policySnapshot: unknown } | null;
    arguments: Record<string, unknown>;
  };
  proposal: ScriptProposalRow;
  /** The proposal's LATEST review, loaded by the caller in the same tx. */
  review: ScriptProposalReviewRow | null;
}

const UNATTENDED_MAX_TIMEOUT_SECONDS = 300;

export async function evaluateScriptReviewerAutonomy(
  args: ScriptReviewerAutonomyArgs,
): Promise<ScriptReviewerDecision> {
  const deny = (reason: ScriptReviewerRefusal): ScriptReviewerDecision => ({ granted: false, reason });
  const { proposal, review, intentDraft } = args;

  try {
    const effective = await resolveEffectiveScriptPolicy(intentDraft.orgId);

    // 1 — partner ceiling AND org grant. This IS the policy.
    if (!effective.unattendedEnabled) return deny('lane_disabled');

    // 2 — the proposal itself is runnable and clean.
    if (
      proposal.status !== 'reviewed'
      || proposal.intentId !== null
      || proposal.expiresAt.getTime() <= Date.now()
      || proposal.basicHits.length > 0
    ) {
      return deny('proposal_not_runnable');
    }

    // 3 — a COMPLETED MODEL review, at or below the effective ceiling.
    if (!review || review.status !== 'completed' || review.reviewerKind !== 'model') {
      return deny('review_missing');
    }
    if (riskTierRank(review.riskTier as RiskTier) > riskTierRank(effective.maxUnattendedRiskTier)) {
      return deny('risk_above_ceiling');
    }

    // 4 — an unqualified approve. The reviewer's authority stops here.
    if (
      review.goalMatch !== 'yes'
      || review.reversible !== true
      || review.verificationAdequate !== true
      || review.recommendedAction !== 'approve'
    ) {
      return deny('verdict_not_approve');
    }

    // 5 — no STRICT hits. A STRICT acknowledgement requires scripts:write +
    // MFA from a human (spec §4.5); there is no human here to give it.
    if (proposal.strictHits.length > 0) return deny('strict_hits');

    // 6 — classes non-empty, inside the effective allowlist, and never
    // hard-denied. EMPTY refuses: a script the classifier cannot place is a
    // script whose blast radius is unbounded, so it gets a human.
    const classes = proposal.touchClasses as TouchClass[];
    if (classes.length === 0) return deny('class_not_allowed');
    if (classes.some((c) => LANE_HARD_DENIED_CLASSES.has(c))) return deny('class_hard_denied');
    if (classes.some((c) => !effective.unattendedAllowedClasses.includes(c))) return deny('class_not_allowed');

    // 7-14 land in Tasks 10-13. Until then every one of them is a REFUSAL,
    // not a pass — the lane must never be reachable with half its gates.
    return deny('device_unavailable');
  } catch (err) {
    console.error('[scriptReviewerAutonomy] gate evaluation threw — denying (fail-closed to the human path):', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return deny('lane_disabled');
  }
}
```

Because the stub refuses, the positive-control test fails at this step. That is deliberate: mark the positive control `it.todo` here and restore it in Task 13, so no intermediate commit can claim a working lane.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: PASS for all invariant-1–6 negatives; the positive control is `it.todo`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts
git commit -m "feat(ai): script reviewer autonomy invariants 1-6 (policy, proposal, review, verdict, strict, classes)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Invariants 7–10 — protected resources, timeout, scope, single device

**Files:**
- Modify: `apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts`, `apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts`

**Interfaces:**
- Consumes: `touchesProtectedNames` (Task 8), `EffectiveScriptPolicy.protectedResources` (Task 5), the agent's own `protectedResources` via its policy snapshot.
- Produces: refusals `protected_resource`, `timeout_too_long`, `scope_not_supervised`, `multi_device`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts — append a new describe
describe('evaluateScriptReviewerAutonomy — invariants 7-10', () => {
  it('7 — a policy-protected service named by the classifier refuses', async () => {
    mockPolicy.mockResolvedValue({
      ...EFFECTIVE,
      protectedResources: { services: ['Spooler'], paths: [], registryKeys: [], deviceTags: [] },
    });
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'protected_resource' });
  });

  it("7 — the AGENT's own protected resources also apply; the lane never widens an agent envelope", async () => {
    expect(await evaluateScriptReviewerAutonomy(args({
      intentDraft: {
        orgId: 'org-1', approvalScope: 'supervised',
        agentRun: {
          id: 'run-1', agentId: 'agent-1',
          policySnapshot: { effective: { mode: 'act', protectedResources: { services: ['Spooler'], paths: [], registryKeys: [], deviceTags: [] } } },
        },
        arguments: { proposalId: 'prop-1', deviceIds: ['dev-1'] },
      },
    }))).toEqual({ granted: false, reason: 'protected_resource' });
  });

  it('8 — a timeout above 300s refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, timeoutSeconds: 301 } })))
      .toEqual({ granted: false, reason: 'timeout_too_long' });
  });

  it('9 — a four_eyes-resolved scope refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({
      intentDraft: { orgId: 'org-1', approvalScope: 'four_eyes', agentRun: null, arguments: { proposalId: 'prop-1', deviceIds: ['dev-1'] } },
    }))).toEqual({ granted: false, reason: 'scope_not_supervised' });
  });

  it('10 — more than one target device refuses (D6: canary by construction)', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({
      proposal: { ...PROPOSAL, targetDeviceIds: ['dev-1', 'dev-2'] },
      intentDraft: { orgId: 'org-1', approvalScope: 'supervised', agentRun: null, arguments: { proposalId: 'prop-1', deviceIds: ['dev-1', 'dev-2'] } },
    }))).toEqual({ granted: false, reason: 'multi_device' });
  });

  it('10 — one target but two requested devices also refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({
      intentDraft: { orgId: 'org-1', approvalScope: 'supervised', agentRun: null, arguments: { proposalId: 'prop-1', deviceIds: ['dev-1', 'dev-2'] } },
    }))).toEqual({ granted: false, reason: 'multi_device' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: FAIL — every case returns `device_unavailable` (the Task 9 stub) instead of its own reason.

- [ ] **Step 3: Implement invariants 7–10**

Replace the `// 7-14 land in Tasks 10-13` stub with:

```ts
    // 7 — protected resources, checked against the CLASSIFIER's extracted
    // names, not against named input fields: `aiGuardrails.touchesProtected`
    // has never inspected script content (`aiGuardrails.ts:1649`), which is
    // exactly why the lane needs a content-derived check. Same matcher, one
    // implementation (`touchesProtectedNames`, Task 8).
    //
    // The agent's OWN protectedResources are unioned in: the lane may tighten
    // an agent's envelope, never widen it (spec §4.1).
    const agentProtected = readAgentProtectedResources(intentDraft.agentRun);
    const protectedHit =
      touchesProtectedNames(proposal.touchedNames, effective.protectedResources)
      ?? (agentProtected ? touchesProtectedNames(proposal.touchedNames, agentProtected) : null);
    if (protectedHit) return deny('protected_resource');

    // 8 — the unattended timeout cap. Shorter than the 3600s proposal cap on
    // purpose: an unattended run nobody is watching must not hold a device
    // for an hour.
    if (proposal.timeoutSeconds > UNATTENDED_MAX_TIMEOUT_SECONDS) return deny('timeout_too_long');

    // 9 — the guardrail's own resolved scope. A proposal that would have
    // needed a second human is never released without the first.
    if (intentDraft.approvalScope !== 'supervised') return deny('scope_not_supervised');

    // 10 — single device (D6). Both the proposal's targets AND the call's
    // requested devices must be exactly one, and the same one: the digest
    // pins deviceIds, so a mismatch here would pin a set the lane never
    // evaluated.
    const requestedDeviceIds = Array.isArray(intentDraft.arguments.deviceIds)
      ? (intentDraft.arguments.deviceIds as string[])
      : [];
    if (proposal.targetDeviceIds.length !== 1 || requestedDeviceIds.length !== 1) return deny('multi_device');
    const deviceId = requestedDeviceIds[0]!;
    if (deviceId !== proposal.targetDeviceIds[0]) return deny('multi_device');

    // 11-14 land in Tasks 11-13.
    return deny('device_unavailable');
```

And the helper, above `evaluateScriptReviewerAutonomy`:

```ts
/**
 * The agent's own protected resources, off the run's IMMUTABLE policy
 * snapshot. Read from the snapshot rather than re-resolved live because the
 * snapshot is what the run was admitted under; the LIVE policy is re-read at
 * release (`revalidateScriptReviewerEvidence`, Task 14) where a tightening
 * since creation must revoke.
 */
function readAgentProtectedResources(
  agentRun: ScriptReviewerAutonomyArgs['intentDraft']['agentRun'],
): AiAgentProtectedResources | null {
  const effective = (agentRun?.policySnapshot as { effective?: { protectedResources?: AiAgentProtectedResources } } | null)?.effective;
  return effective?.protectedResources ?? null;
}
```

Add the imports: `touchesProtectedNames` from `../aiGuardrails`, `type AiAgentProtectedResources` from `@breeze/shared`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: PASS for invariants 1–10; the positive control is still `it.todo`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts
git commit -m "feat(ai): script lane invariants 7-10 (protected names, timeout, scope, single device)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Invariants 11–12 — checkpoint, lane state, hourly cap under the advisory lock

**Files:**
- Create: `apps/api/src/services/actionIntents/laneQueries.ts`, `apps/api/src/services/actionIntents/laneQueries.test.ts`
- Modify: `apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts`, `apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts`

**Interfaces:**
- Consumes: `ensureRestoreCheckpoint`, `RESTORE_CHECKPOINT_CLASSES` (Task 7); `aiScriptLaneState`, `actionIntents` (Task 3).
- Produces:
```ts
export function lockScriptLane(tx: Database, orgId: string): Promise<void>;
export function readLaneState(tx: Database, orgId: string): Promise<{ state: 'closed' | 'open'; openedReason: string | null } | null>;
export function countRecentLaneIntents(tx: Database, orgId: string): Promise<number>;
export function readLaneDevice(tx: Database, deviceId: string, orgId: string): Promise<{ id: string; status: string; osType: string } | null>;
```

- [ ] **Step 1: Write the failing tests for the query helpers**

```ts
// apps/api/src/services/actionIntents/laneQueries.test.ts
import { describe, it, expect, vi } from 'vitest';

const executed: unknown[] = [];
const selected: unknown[] = [];
const tx = {
  execute: (q: unknown) => { executed.push(q); return Promise.resolve([]); },
  select: () => ({ from: () => ({ where: () => ({ limit: async () => selected }) }) }),
} as never;

import { lockScriptLane, countRecentLaneIntents } from './laneQueries';
import { renderSql } from '../../__tests__/helpers/renderSql';

describe('laneQueries', () => {
  it('takes a per-ORG advisory xact lock keyed ai-script-lane:<orgId>', async () => {
    await lockScriptLane(tx, 'org-1');
    const rendered = renderSql(executed[0]);
    expect(rendered).toMatch(/pg_advisory_xact_lock\(hashtextextended\(/);
    // The key is bound as a PARAMETER, never interpolated.
    expect(rendered).not.toContain('org-1');
    expect((executed[0] as { queryChunks?: unknown[] })).toBeTruthy();
  });

  it('counts script_reviewer intents in the last hour INCLUDING pending ones', async () => {
    selected.push({ n: 3 });
    await expect(countRecentLaneIntents(tx, 'org-1')).resolves.toBe(3);
  });
});
```

- [ ] **Step 2: Write the failing tests for invariants 11–12**

```ts
// apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts — append
describe('evaluateScriptReviewerAutonomy — invariants 11-12', () => {
  it('11 — a class needing a checkpoint on a NON-Windows device refuses', async () => {
    mockDevice.mockResolvedValue({ id: 'dev-1', status: 'online', osType: 'linux', maintenanceSuppressed: false });
    mockCheckpoint.mockResolvedValue({ ok: false, reason: 'unsupported_platform' });
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'checkpoint_unavailable' });
  });

  it('11 — a failed checkpoint on Windows refuses', async () => {
    mockCheckpoint.mockResolvedValue({ ok: false, reason: 'checkpoint_failed' });
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'checkpoint_unavailable' });
  });

  it('11 — a class that needs NO checkpoint never dispatches one, and records checkpointRequired false', async () => {
    const res = await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: ['temp_files'] } }));
    expect(mockCheckpoint).not.toHaveBeenCalled();
    if (!res.granted) throw new Error('expected a grant');
    expect(res.evidence.checkpointRequired).toBe(false);
  });

  it('11 — a checkpoint class records checkpointRequired true', async () => {
    const res = await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: ['registry'] } }));
    if (!res.granted) throw new Error('expected a grant');
    expect(res.evidence.checkpointRequired).toBe(true);
  });

  it('12 — an OPEN lane refuses', async () => {
    mockLane.mockResolvedValue({ state: 'open', openedReason: '2 consecutive failed verifications' });
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'lane_open' });
  });

  it('12 — the hourly cap refuses at the cap, not above it', async () => {
    mockCount.mockResolvedValue(10);
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'hourly_cap' });
  });

  it('12 — the advisory lock is taken BEFORE the count', async () => {
    const order: string[] = [];
    mockLane.mockImplementation(async () => { order.push('lane'); return { state: 'closed' }; });
    mockCount.mockImplementation(async () => { order.push('count'); return 0; });
    await evaluateScriptReviewerAutonomy(args());
    // lockScriptLane is asserted in laneQueries.test.ts; here we prove the
    // lane read and the count both happen after it by checking the module
    // calls lockScriptLane first.
    expect(order).toEqual(['lane', 'count']);
  });
});
```

Note: `registry` is not in the default allowlist, so the `checkpointRequired: true` case must also widen the mocked policy — add `mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedAllowedClasses: [...EFFECTIVE.unattendedAllowedClasses, 'registry'] })` inside that test.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/laneQueries.test.ts src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: FAIL — `Cannot find module './laneQueries'`; the invariant cases still return `device_unavailable`.

- [ ] **Step 4: Write `laneQueries.ts`**

```ts
// apps/api/src/services/actionIntents/laneQueries.ts
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiScriptLaneState } from '../../db/schema/aiScriptLaneState';
import { devices } from '../../db/schema/devices';

/**
 * Per-ORG advisory xact lock, serializing concurrent lane admissions for the
 * same org so the hourly cap below cannot overshoot under a race. Released
 * automatically on commit/rollback of the caller's transaction — no unlock
 * call. Same idiom as the exposure cap (`policyDecide.ts:298`); the key is
 * BOUND as a parameter, never interpolated.
 */
export async function lockScriptLane(tx: Database, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-script-lane:${orgId}`}, 0))`);
}

export async function readLaneState(
  tx: Database,
  orgId: string,
): Promise<{ state: 'closed' | 'open'; openedReason: string | null } | null> {
  const [row] = await tx
    .select({ state: aiScriptLaneState.state, openedReason: aiScriptLaneState.openedReason })
    .from(aiScriptLaneState)
    .where(eq(aiScriptLaneState.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/**
 * `script_reviewer` intents created for this org in the last hour, **including
 * pending and undispatched ones** (spec §4.6 invariant 12). Counting only
 * executed runs would let N concurrent admissions all see zero and blow the
 * cap — the reservation must cover the window between admission and effect.
 */
export async function countRecentLaneIntents(tx: Database, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(actionIntents)
    .where(and(
      eq(actionIntents.orgId, orgId),
      eq(actionIntents.decidedVia, 'script_reviewer'),
      gt(actionIntents.createdAt, sql`now() - interval '1 hour'`),
    ))
    .limit(1);
  return row?.n ?? 0;
}

export async function readLaneDevice(
  tx: Database,
  deviceId: string,
  orgId: string,
): Promise<{ id: string; status: string; osType: string } | null> {
  const [row] = await tx
    .select({ id: devices.id, status: devices.status, osType: devices.osType })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return row ?? null;
}
```

- [ ] **Step 5: Implement invariants 11–12 in the evaluator**

Replace the `// 11-14 land in Tasks 11-13` stub with:

```ts
    // The LOCK comes first, and everything reservation-shaped happens under
    // it: lane state, the hourly count, and (in intentService) the insert.
    await lockScriptLane(args.tx, intentDraft.orgId);

    // 12a — the circuit. Checked at approval AND again at release.
    const lane = await readLaneState(args.tx, intentDraft.orgId);
    if (lane?.state === 'open') return deny('lane_open');

    // 12b — the hourly reservation. `>=` not `>`: the cap is the number of
    // admissions allowed, so the 11th of a cap-10 hour is refused.
    if (await countRecentLaneIntents(args.tx, intentDraft.orgId) >= effective.maxUnattendedPerHour) {
      return deny('hourly_cap');
    }

    // 13-14 land in Tasks 12-13.
    return deny('device_unavailable');
```

and, immediately after invariant 10's device resolution (so the checkpoint is attempted only for a device the lane has actually settled on):

```ts
    // 11 — recovery prerequisite. Only for classes a System Restore point can
    // actually undo; anything else would be a pointless 3-minute dispatch.
    // A refusal here is why `registry` / `services` / `files_system` are
    // lane-ineligible on Linux and macOS in v1 (spec §10):
    // ensureRestoreCheckpoint returns `unsupported_platform` there, and this
    // gate denies rather than shrugging.
    const checkpointRequired = classes.some((c) => RESTORE_CHECKPOINT_CLASSES.has(c));
    if (checkpointRequired) {
      const checkpoint = await ensureRestoreCheckpoint(deviceId);
      if (!checkpoint.ok) return deny('checkpoint_unavailable');
    }
```

`checkpointRequired` is carried into the evidence built in Task 13. Import `ensureRestoreCheckpoint`, `RESTORE_CHECKPOINT_CLASSES` from `../deviceRecovery/restoreCheckpoint` and the four helpers from `./laneQueries`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/actionIntents/laneQueries.test.ts src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: PASS for invariants 1–12; the positive control is still `it.todo`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/actionIntents/laneQueries.ts apps/api/src/services/actionIntents/laneQueries.test.ts apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts
git commit -m "feat(ai): script lane invariants 11-12 (checkpoint, circuit, hourly cap under advisory lock)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Invariant 13 — requester authority (chat RBAC, agent structural)

**Files:**
- Modify: `apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts`, `apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts`

**Interfaces:**
- Consumes: `checkToolPermission` (`services/aiGuardrails.ts:2013`), `checkAgentGuardrails` (`:1739`), `readAiKillState` (`services/aiKillState.ts`), `resolveEffectiveAgentSystem` (`services/aiAgents/effectivePolicy.ts:447`), `ActReservationState` / `maxActionsPerRun` (`services/aiAgents/actRevalidation.ts:81`, `:483`).
- Produces: refusal `requester_unauthorized`.

**Why two branches.** `checkToolPermission` **denies the `ai_agent` principal as its first statement** (`aiGuardrails.ts:2023-2024`: *"AI agent principals are never granted user permissions"*), so running it for an agent would refuse every agent-origin lane request. The agent branch mirrors what release already does for agent intents (`revalidateRelease.ts:255-272` → `checkAgentReleaseAuthority`): mode `act`, allowlist, kill switch, structural guardrails, per-run action cap.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts — append
describe('evaluateScriptReviewerAutonomy — invariant 13 (requester authority)', () => {
  it('chat — the session user must still hold live run_script permission', async () => {
    mockToolPermission.mockResolvedValue('Missing permission scripts:execute');
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('chat — checkToolPermission is called with the TOOL name and the intent arguments', async () => {
    await evaluateScriptReviewerAutonomy(args());
    expect(mockToolPermission).toHaveBeenCalledWith('run_script', { proposalId: 'prop-1', deviceIds: ['dev-1'] }, expect.anything());
  });

  const agentDraft = (over: Record<string, unknown> = {}) => ({
    orgId: 'org-1', approvalScope: 'supervised',
    agentRun: {
      id: 'run-1', agentId: 'agent-1',
      policySnapshot: { kind: 'patch', effective: { mode: 'act', toolAllowlist: ['run_script'], protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] }, limits: { maxActionsPerRun: 3 } } },
      reservation: { count: 0 },
    },
    arguments: { proposalId: 'prop-1', deviceIds: ['dev-1'] },
    ...over,
  });

  it('agent — checkToolPermission is NEVER called (it denies ai_agent principals outright)', async () => {
    mockAgentPolicy.mockResolvedValue({ agentId: 'agent-1', effective: { mode: 'act', toolAllowlist: ['run_script'], limits: { maxActionsPerRun: 3 } } });
    await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() }));
    expect(mockToolPermission).not.toHaveBeenCalled();
  });

  it('agent — a shadow-mode LIVE policy refuses even when the snapshot said act', async () => {
    mockAgentPolicy.mockResolvedValue({ agentId: 'agent-1', effective: { mode: 'shadow', toolAllowlist: ['run_script'], limits: { maxActionsPerRun: 3 } } });
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — run_script absent from the live allowlist refuses', async () => {
    mockAgentPolicy.mockResolvedValue({ agentId: 'agent-1', effective: { mode: 'act', toolAllowlist: ['restart_service'], limits: { maxActionsPerRun: 3 } } });
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — an engaged kill switch refuses', async () => {
    mockAgentPolicy.mockResolvedValue({ agentId: 'agent-1', effective: { mode: 'act', toolAllowlist: ['run_script'], limits: { maxActionsPerRun: 3 } } });
    mockKillState.mockResolvedValue({ killed: true, epoch: 7 });
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — a structural guardrail denial refuses', async () => {
    mockAgentPolicy.mockResolvedValue({ agentId: 'agent-1', effective: { mode: 'act', toolAllowlist: ['run_script'], limits: { maxActionsPerRun: 3 } } });
    mockAgentGuardrails.mockReturnValue({ allowed: false, disposition: 'deny', reason: 'Denied: site out of scope' });
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — an exhausted per-run action cap refuses', async () => {
    mockAgentPolicy.mockResolvedValue({ agentId: 'agent-1', effective: { mode: 'act', toolAllowlist: ['run_script'], limits: { maxActionsPerRun: 3 } } });
    expect(await evaluateScriptReviewerAutonomy(args({
      intentDraft: agentDraft({ agentRun: { ...agentDraft().agentRun, reservation: { count: 3 } } }),
    }))).toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — a grant stamps the agent block into the evidence', async () => {
    mockAgentPolicy.mockResolvedValue({ agentId: 'agent-1', policyEpoch: 12, effective: { mode: 'act', toolAllowlist: ['run_script'], limits: { maxActionsPerRun: 3 } } });
    mockKillState.mockResolvedValue({ killed: false, epoch: 4 });
    const res = await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() }));
    if (!res.granted) throw new Error('expected a grant');
    expect(res.evidence.agent).toEqual({ agentId: 'agent-1', policyEpoch: 12, killEpoch: 4 });
  });
});
```

Add the three new mocks at the top of the file:

```ts
const mockAgentPolicy = vi.fn();
const mockKillState = vi.fn();
const mockAgentGuardrails = vi.fn();
vi.mock('../aiAgents/effectivePolicy', () => ({ resolveEffectiveAgentSystem: (...a: unknown[]) => mockAgentPolicy(...a) }));
vi.mock('../aiKillState', () => ({ readAiKillState: (...a: unknown[]) => mockKillState(...a) }));
// and extend the '../aiGuardrails' mock's checkAgentGuardrails to delegate to mockAgentGuardrails
```
with `beforeEach` defaults `mockKillState.mockResolvedValue({ killed: false, epoch: 0 })` and `mockAgentGuardrails.mockReturnValue({ allowed: true, disposition: 'allow' })`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: FAIL — every case returns `device_unavailable`.

- [ ] **Step 3: Implement invariant 13**

Extend `ScriptReviewerAutonomyArgs['intentDraft']['agentRun']` with `reservation: { count: number }` (the `ActReservationState` the run loop already threads at `runLoop.ts:1497`), then replace the `// 13-14 land in Tasks 12-13` stub with:

```ts
    // 13 — requester authority. Two disjoint branches, because the two
    // principals have disjoint authorities: a chat user has RBAC, an agent
    // has a policy. There is no shared path.
    if (intentDraft.agentRun) {
      const run = intentDraft.agentRun;

      // The run's frozen snapshot must ALREADY have been act-mode. A shadow
      // run cannot acquire act authority by proposing a script.
      const snapshot = (run.policySnapshot as { kind?: string; effective?: { mode?: string; toolAllowlist?: string[] } } | null);
      if (snapshot?.effective?.mode !== 'act') return deny('requester_unauthorized');

      // …AND the LIVE policy must still say so. A demotion between run start
      // and this call revokes (same rule `evaluateTicketAutonomy` applies at
      // `ticketAutonomy.ts:135-143`).
      const resolved = await resolveEffectiveAgentSystem(intentDraft.orgId, snapshot.kind as never);
      if (
        !resolved
        || resolved.agentId !== run.agentId
        || resolved.effective.mode !== 'act'
        || !resolved.effective.toolAllowlist.includes('run_script')
      ) {
        return deny('requester_unauthorized');
      }

      const killState = await readAiKillState();
      if (killState.killed) return deny('requester_unauthorized');

      // Structural guardrails (site scope, device binding, protected inputs).
      // Synchronous and RBAC-free by design (`aiGuardrails.ts:1736-1738`).
      const structural = checkAgentGuardrails('run_script', intentDraft.arguments, {
        enabled: true,
        mode: resolved.effective.mode,
        toolAllowlist: resolved.effective.toolAllowlist,
        protectedResources: resolved.effective.protectedResources,
        deviceId,
        deviceSiteId: null,
      } as never);
      if (!structural.allowed) return deny('requester_unauthorized');

      // Per-run action cap, the same counter act-mode execution reserves
      // against (`actRevalidation.ts:483-489`). `>=`, matching that code.
      if (run.reservation.count >= resolved.effective.limits.maxActionsPerRun) {
        return deny('requester_unauthorized');
      }

      agentEvidence = {
        agentId: run.agentId,
        policyEpoch: resolved.policyEpoch ?? 0,
        killEpoch: killState.epoch,
      };
    } else {
      // Chat. The SAME live re-check `decideApprovalRequest.ts:557` runs
      // before a supervised human self-approve — the lane replaces the click,
      // never the permission behind it.
      const denial = await checkToolPermission('run_script', intentDraft.arguments, args.auth);
      if (denial) return deny('requester_unauthorized');
    }

    // 14 lands in Task 13.
    return deny('device_unavailable');
```

Declare `let agentEvidence: ScriptReviewerEvidence['agent'];` near the top of the `try` block.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: PASS for invariants 1–13; the agent-evidence case and the positive control still fail because nothing returns a grant yet — keep both `it.todo` until Task 13.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts
git commit -m "feat(ai): script lane invariant 13 (chat RBAC vs agent structural authority)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Invariant 14 and the grant — device state and typed evidence

**Files:**
- Modify: `apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts`, `apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts`

**Interfaces:**
- Consumes: `readLaneDevice` (Task 11), `checkScriptMaintenanceSuppression` (`services/scriptMaintenanceGate.ts:44`).
- Produces: refusal `device_unavailable`; the `{ granted: true; evidence }` return. **This is the task that makes the lane reachable at all** — every earlier task's module refuses unconditionally.

- [ ] **Step 1: Restore the positive control and add the invariant-14 negatives**

```ts
// apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts
// Change the Task-9 `it.todo('POSITIVE CONTROL: …')` back to `it(...)`,
// the Task-12 `it.todo('agent — a grant stamps …')` back to `it(...)`,
// and append:

describe('evaluateScriptReviewerAutonomy — invariant 14 (device)', () => {
  it('an offline device refuses', async () => {
    mockDevice.mockResolvedValue({ id: 'dev-1', status: 'offline', osType: 'windows' });
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'device_unavailable' });
  });

  it('a device in another org refuses', async () => {
    mockDevice.mockResolvedValue(null);
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'device_unavailable' });
  });

  it('an OPEN maintenance window refuses — the operator already said "not now"', async () => {
    mockMaintenance.mockResolvedValue({ suppressed: true, reason: 'window_active', message: 'x', windowEndsAt: null });
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'device_unavailable' });
  });

  it('an UNREADABLE maintenance window refuses too (fail-closed, matching scriptDispatch)', async () => {
    mockMaintenance.mockResolvedValue({ suppressed: true, reason: 'check_failed', message: 'x', windowEndsAt: null });
    expect(await evaluateScriptReviewerAutonomy(args()))
      .toEqual({ granted: false, reason: 'device_unavailable' });
  });
});

describe('evaluateScriptReviewerAutonomy — fail-closed', () => {
  it('an exception anywhere in the gate chain denies instead of escaping', async () => {
    mockPolicy.mockRejectedValue(new Error('db is on fire'));
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'lane_disabled' });
  });
});
```

Add `const mockMaintenance = vi.fn();` with `vi.mock('../scriptMaintenanceGate', () => ({ checkScriptMaintenanceSuppression: (...a: unknown[]) => mockMaintenance(...a) }))` and the `beforeEach` default `mockMaintenance.mockResolvedValue({ suppressed: false })`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: FAIL — the positive control gets `{ granted: false, reason: 'device_unavailable' }`.

- [ ] **Step 3: Implement invariant 14 and build the evidence**

Replace the `// 14 lands in Task 13` stub with:

```ts
    // 14 — the device must be online, in this org, and not inside a
    // maintenance window. Fail-closed on an unreadable window, exactly as
    // `scriptDispatch.ts:246-258` does: an unverifiable window must not
    // become an open door.
    const device = await readLaneDevice(args.tx, deviceId, intentDraft.orgId);
    if (!device || device.status !== 'online') return deny('device_unavailable');
    const maintenance = await checkScriptMaintenanceSuppression(deviceId);
    if (maintenance.suppressed) return deny('device_unavailable');

    // Every invariant held. The evidence pins EXACTLY what was evaluated —
    // the specific review id (not "the latest", which can change), the
    // content digest, the scanner version, and the policy snapshot — so
    // release can re-prove the same decision against current state rather
    // than re-deriving a new one (spec §4.6 "Decision record").
    //
    // Lifecycle state is deliberately NOT evidence material: it is re-read
    // live at release, and freezing it would make a revoked grant look valid.
    return {
      granted: true,
      evidence: {
        proposalId: proposal.id,
        reviewId: review.id,
        contentDigest: proposal.contentDigest,
        scannerVersion: proposal.scannerVersion,
        reviewerModel: review.model ?? '',
        reviewerPromptVersion: review.reviewerPromptVersion ?? '',
        touchClasses: classes,
        policySnapshot: {
          ceiling: effective.maxUnattendedRiskTier,
          allowedClasses: effective.unattendedAllowedClasses,
          perHour: effective.maxUnattendedPerHour,
        },
        laneReservationAt: new Date().toISOString(),
        checkpointRequired,
        ...(agentEvidence ? { agent: agentEvidence } : {}),
      },
    };
```

- [ ] **Step 4: Run the full evaluator suite**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerAutonomy.test.ts`
Expected: PASS — one negative per invariant 1–14 plus the positive control, the agent-evidence case, and the fail-closed case.

- [ ] **Step 5: Verify the coverage claim mechanically, not by eye**

```bash
# Every refusal literal in the union must appear in at least one assertion.
node -e "
const fs=require('fs');
const src=fs.readFileSync('apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts','utf8');
const tst=fs.readFileSync('apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts','utf8');
const union=src.slice(src.indexOf('export type ScriptReviewerRefusal'),src.indexOf(';',src.indexOf('export type ScriptReviewerRefusal')));
const reasons=[...union.matchAll(/'([a-z_]+)'/g)].map(m=>m[1]);
const missing=reasons.filter(r=>!tst.includes(\"'\"+r+\"'\"));
if(missing.length){console.error('UNCOVERED refusals:',missing);process.exit(1);}
console.log('all',reasons.length,'refusals covered');
"
```
Expected: `all 17 refusals covered`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts apps/api/src/services/actionIntents/scriptReviewerAutonomy.test.ts
git commit -m "feat(ai): script lane invariant 14 and the typed grant evidence

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: `revalidateScriptReviewerEvidence` — re-prove the grant at release

**Files:**
- Create: `apps/api/src/services/actionIntents/scriptReviewerRevalidate.test.ts`
- Modify: `apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts`

**Interfaces:**
- Consumes: everything Task 9–13 built.
- Produces:
```ts
export function revalidateScriptReviewerEvidence(
  intent: ActionIntent,
  db: Database,
): Promise<{ ok: true } | { ok: false; reason: ScriptReviewerRefusal }>;
```

**Which invariants re-run.** 1, 2, 3, 5, 6, 7, 8, 12, 13 and 14 — every one whose truth can change between creation and release — **plus** the check that the evidence's `reviewId` is still the proposal's latest completed review (spec §4.6 "Release"). 4 (the verdict) and 9/10/11 are frozen facts of an immutable proposal and a decision already taken; re-running 11 would take a **second** checkpoint on every release, which is why the checkpoint result is instead read back at dispatch (Task 18).

- [ ] **Step 1: Write the failing tests — one per revocation**

```ts
// apps/api/src/services/actionIntents/scriptReviewerRevalidate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// (same module mocks as scriptReviewerAutonomy.test.ts, plus:)
const mockLoadProposal = vi.fn();
const mockLatestReview = vi.fn();
vi.mock('../scriptProposals/proposals', () => ({
  loadProposalForRelease: (...a: unknown[]) => mockLoadProposal(...a),
  latestCompletedReview: (...a: unknown[]) => mockLatestReview(...a),
}));

import { revalidateScriptReviewerEvidence } from './scriptReviewerAutonomy';

const EVIDENCE = {
  proposalId: 'prop-1', reviewId: 'rev-1', contentDigest: 'd'.repeat(64),
  scannerVersion: '2026-09-11.1', reviewerModel: 'sonnet-x', reviewerPromptVersion: 'v1',
  touchClasses: ['services'],
  policySnapshot: { ceiling: 'low', allowedClasses: ['services', 'processes', 'temp_files', 'dns_cache', 'printing'], perHour: 10 },
  laneReservationAt: new Date().toISOString(), checkpointRequired: false,
};
const INTENT = {
  id: 'int-1', orgId: 'org-1', decidedVia: 'script_reviewer', scriptReviewerEvidence: EVIDENCE,
  arguments: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, requestingAgentRunId: null,
  approvalScope: 'supervised',
} as never;

describe('revalidateScriptReviewerEvidence', () => {
  it('POSITIVE CONTROL: unchanged state revalidates', async () => {
    await expect(revalidateScriptReviewerEvidence(INTENT, {} as never)).resolves.toEqual({ ok: true });
  });

  it('the ORG GRANT was revoked', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedEnabled: false });
    await expect(revalidateScriptReviewerEvidence(INTENT, {} as never))
      .resolves.toEqual({ ok: false, reason: 'lane_disabled' });
  });

  it('the PARTNER CEILING was lowered below the review tier', async () => {
    mockLatestReview.mockResolvedValue({ ...REVIEW, riskTier: 'medium' });
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, maxUnattendedRiskTier: 'low' });
    await expect(revalidateScriptReviewerEvidence(INTENT, {} as never))
      .resolves.toEqual({ ok: false, reason: 'risk_above_ceiling' });
  });

  it('a class was removed from the allowlist', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedAllowedClasses: ['printing'] });
    await expect(revalidateScriptReviewerEvidence(INTENT, {} as never))
      .resolves.toEqual({ ok: false, reason: 'class_not_allowed' });
  });

  it('a protected resource was added that the script touches', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, protectedResources: { services: ['Spooler'], paths: [], registryKeys: [], deviceTags: [] } });
    await expect(revalidateScriptReviewerEvidence(INTENT, {} as never))
      .resolves.toEqual({ ok: false, reason: 'protected_resource' });
  });

  it('the agent was demoted act -> shadow', async () => {
    mockAgentPolicy.mockResolvedValue({ agentId: 'agent-1', effective: { mode: 'shadow', toolAllowlist: ['run_script'], limits: { maxActionsPerRun: 3 } } });
    await expect(revalidateScriptReviewerEvidence(
      { ...INTENT, requestingAgentRunId: 'run-1', scriptReviewerEvidence: { ...EVIDENCE, agent: { agentId: 'agent-1', policyEpoch: 1, killEpoch: 0 } } } as never,
      {} as never,
    )).resolves.toEqual({ ok: false, reason: 'requester_unauthorized' });
  });

  it('the kill switch was engaged', async () => {
    mockKillState.mockResolvedValue({ killed: true, epoch: 9 });
    await expect(revalidateScriptReviewerEvidence(
      { ...INTENT, requestingAgentRunId: 'run-1', scriptReviewerEvidence: { ...EVIDENCE, agent: { agentId: 'agent-1', policyEpoch: 1, killEpoch: 0 } } } as never,
      {} as never,
    )).resolves.toEqual({ ok: false, reason: 'requester_unauthorized' });
  });

  it('the lane circuit opened after approval', async () => {
    mockLane.mockResolvedValue({ state: 'open', openedReason: 'two failed verifications' });
    await expect(revalidateScriptReviewerEvidence(INTENT, {} as never))
      .resolves.toEqual({ ok: false, reason: 'lane_open' });
  });

  it('the review was SUPERSEDED — a newer completed review exists', async () => {
    mockLatestReview.mockResolvedValue({ ...REVIEW, id: 'rev-2' });
    await expect(revalidateScriptReviewerEvidence(INTENT, {} as never))
      .resolves.toEqual({ ok: false, reason: 'review_missing' });
  });

  it('the proposal is no longer runnable (expired, superseded, or re-consumed)', async () => {
    mockLoadProposal.mockResolvedValue({ ...PROPOSAL, status: 'superseded' });
    await expect(revalidateScriptReviewerEvidence(INTENT, {} as never))
      .resolves.toEqual({ ok: false, reason: 'proposal_not_runnable' });
  });

  it('the device went offline', async () => {
    mockDevice.mockResolvedValue({ id: 'dev-1', status: 'offline', osType: 'windows' });
    await expect(revalidateScriptReviewerEvidence(INTENT, {} as never))
      .resolves.toEqual({ ok: false, reason: 'device_unavailable' });
  });

  it('a missing or malformed evidence blob revalidates as FALSE, never as absent-therefore-fine', async () => {
    await expect(revalidateScriptReviewerEvidence({ ...INTENT, scriptReviewerEvidence: null } as never, {} as never))
      .resolves.toEqual({ ok: false, reason: 'lane_disabled' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerRevalidate.test.ts`
Expected: FAIL — `revalidateScriptReviewerEvidence is not a function`.

- [ ] **Step 3: Implement it**

```ts
// apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts — append

/**
 * Re-prove a `script_reviewer` grant against CURRENT state, at release
 * (spec §4.6 "Release").
 *
 * Re-runs invariants 1, 2, 3, 5, 6, 7, 8, 12, 13, 14 — every one whose truth
 * can change while the intent sits in its release lease — and additionally
 * requires the evidence's `reviewId` to still be the proposal's LATEST
 * completed review. Pinning the exact review id is the point: "the latest
 * review still approves" is a different, weaker claim than "the review this
 * decision was made from is still the operative one".
 *
 * Invariant 4 is a frozen property of an immutable review row. 9 and 10 are
 * frozen properties of an immutable proposal. 11 is not re-run because that
 * would take a SECOND restore checkpoint on every release; the first one's
 * result is read back at dispatch instead (`intentReleaseWorker.ts`).
 *
 * Never throws: a fault denies, like everywhere else on this path.
 */
export async function revalidateScriptReviewerEvidence(
  intent: ActionIntent,
  database: Database,
): Promise<{ ok: true } | { ok: false; reason: ScriptReviewerRefusal }> {
  const fail = (reason: ScriptReviewerRefusal) => ({ ok: false as const, reason });
  try {
    const evidence = intent.scriptReviewerEvidence as ScriptReviewerEvidence | null;
    if (!evidence?.proposalId || !evidence.reviewId) return fail('lane_disabled');

    const effective = await resolveEffectiveScriptPolicy(intent.orgId);
    if (!effective.unattendedEnabled) return fail('lane_disabled');            // 1

    const proposal = await loadProposalForRelease(database, evidence.proposalId, intent.orgId);
    if (
      !proposal
      || proposal.contentDigest !== evidence.contentDigest
      || proposal.intentId !== intent.id
      || proposal.expiresAt.getTime() <= Date.now()
      || proposal.basicHits.length > 0
      || !['reviewed', 'approved'].includes(proposal.status)
    ) {
      return fail('proposal_not_runnable');                                    // 2
    }

    const review = await latestCompletedReview(database, proposal.id);
    if (!review || review.id !== evidence.reviewId) return fail('review_missing');  // 3 + pin
    if (riskTierRank(review.riskTier as RiskTier) > riskTierRank(effective.maxUnattendedRiskTier)) {
      return fail('risk_above_ceiling');                                       // 3
    }

    if (proposal.strictHits.length > 0) return fail('strict_hits');            // 5

    const classes = proposal.touchClasses as TouchClass[];
    if (classes.length === 0) return fail('class_not_allowed');                // 6
    if (classes.some((c) => LANE_HARD_DENIED_CLASSES.has(c))) return fail('class_hard_denied');
    if (classes.some((c) => !effective.unattendedAllowedClasses.includes(c))) return fail('class_not_allowed');

    if (touchesProtectedNames(proposal.touchedNames, effective.protectedResources)) {
      return fail('protected_resource');                                       // 7
    }

    if (proposal.timeoutSeconds > UNATTENDED_MAX_TIMEOUT_SECONDS) return fail('timeout_too_long'); // 8

    const lane = await readLaneState(database, intent.orgId);
    if (lane?.state === 'open') return fail('lane_open');                      // 12

    // 13 — authority. The hourly cap is NOT re-run: it was RESERVED at
    // creation under the advisory lock, and re-counting at release would
    // refuse an intent that legitimately holds one of the hour's slots.
    const deviceId = (intent.arguments as { deviceIds?: string[] }).deviceIds?.[0];
    if (!deviceId) return fail('device_unavailable');

    if (intent.requestingAgentRunId && evidence.agent) {
      const resolved = await resolveEffectiveAgentSystem(intent.orgId, undefined as never);
      const killState = await readAiKillState();
      if (
        !resolved
        || resolved.agentId !== evidence.agent.agentId
        || resolved.effective.mode !== 'act'
        || !resolved.effective.toolAllowlist.includes('run_script')
        || killState.killed
      ) {
        return fail('requester_unauthorized');
      }
    }
    // A CHAT-origin intent's user RBAC is re-checked by
    // `revalidateApprovedIntentForRelease`'s own `checkToolPermission` call
    // (`revalidateRelease.ts:278`), which runs for every non-agent intent —
    // duplicating it here would just cost a second round trip.

    const device = await readLaneDevice(database, deviceId, intent.orgId);     // 14
    if (!device || device.status !== 'online') return fail('device_unavailable');
    if ((await checkScriptMaintenanceSuppression(deviceId)).suppressed) return fail('device_unavailable');

    return { ok: true };
  } catch (err) {
    console.error('[scriptReviewerAutonomy] release revalidation threw — revoking (fail-closed):', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return fail('lane_disabled');
  }
}
```

`loadProposalForRelease(db, proposalId, orgId)` and `latestCompletedReview(db, proposalId)` are thin org-scoped reads; add them to `services/scriptProposals/proposals.ts` beside W01b's existing readers if they are not already there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/actionIntents/scriptReviewerRevalidate.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts apps/api/src/services/actionIntents/scriptReviewerRevalidate.test.ts apps/api/src/services/scriptProposals/proposals.ts
git commit -m "feat(ai): revalidateScriptReviewerEvidence re-proves the lane grant at release

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Wire the decision into `createActionIntent`

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (`:1572` region, the insert at `:1657-1666`, the fan-out skip at `:1824`, the outbox at `:1871`)

**Interfaces:**
- Consumes: `evaluateScriptReviewerAutonomy` (Task 13), `consumeProposalForIntent` (W01b, roadmap §3.3), `loadProposalForRelease` / `latestCompletedReview` (Task 14).
- Produces: intents with `status: 'approved'`, `decidedVia: 'script_reviewer'`, `decidedByUserId: null`, a `releaseBy` lease, `scriptReviewerEvidence`, **no** `approval_requests` rows, and an `intent_approved` outbox row.

**Design note — the refusal breadcrumb.** The brief allowed adding an `autonomy_refusal` column. **Do not.** `action_intents.result` already carries exactly this breadcrumb for the ticket-autonomy twin (`intentService.ts:1585-1590` writes `{ autonomyDenied: reason }` at creation), and a new column on `action_intents` would drag in another `CORE_TENANT_EXPORT_POLICY` classification for no gain. Write `{ scriptLaneRefusal: reason }` instead.

**Do not touch the operation reservation.** `reserveOperation` (`:1802`) runs unconditionally for a task-linked intent and is orthogonal to autonomy; leave that block byte-identical.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/actionIntents/intentService.scriptReviewer.test.ts (create,
// copying the module-mock harness from intentService.ticketAutonomy.test.ts verbatim)
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEvaluate = vi.fn();
const mockConsume = vi.fn();
vi.mock('./scriptReviewerAutonomy', () => ({ evaluateScriptReviewerAutonomy: (...a: unknown[]) => mockEvaluate(...a) }));
vi.mock('../scriptProposals', () => ({ consumeProposalForIntent: (...a: unknown[]) => mockConsume(...a) }));

// … the ticketAutonomy harness's db/insert capture …

describe('createActionIntent — script_reviewer autonomy', () => {
  beforeEach(() => {
    mockEvaluate.mockResolvedValue({ granted: true, evidence: { proposalId: 'prop-1', reviewId: 'rev-1' } });
    mockConsume.mockResolvedValue(true);
  });

  it('is not consulted for run_script WITHOUT a proposalId', async () => {
    await createActionIntent(auth, { toolName: 'run_script', input: { scriptId: 's-1', deviceIds: ['dev-1'] }, source: 'chat', orgId: ORG });
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('is not consulted for another tool that happens to carry a proposalId', async () => {
    await createActionIntent(auth, { toolName: 'restart_service', input: { proposalId: 'prop-1' }, source: 'chat', orgId: ORG });
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('a grant inserts an APPROVED intent with the lane decision stamped', async () => {
    await createActionIntent(auth, { toolName: 'run_script', input: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, source: 'chat', orgId: ORG });
    expect(insertedValues).toMatchObject({
      status: 'approved',
      decidedVia: 'script_reviewer',
      decidedByUserId: null,
      scriptReviewerEvidence: { proposalId: 'prop-1', reviewId: 'rev-1' },
    });
    expect(insertedValues.releaseBy).toBeInstanceOf(Date);
  });

  it('a grant writes NO approval_requests rows and an intent_approved outbox row', async () => {
    await createActionIntent(auth, { toolName: 'run_script', input: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, source: 'chat', orgId: ORG });
    expect(approvalRequestInserts).toHaveLength(0);
    expect(outboxInserts.map((o) => o.eventType)).toEqual(['intent_created', 'intent_approved']);
  });

  it('a grant CONSUMES the proposal for exactly this intent', async () => {
    const snap = await createActionIntent(auth, { toolName: 'run_script', input: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, source: 'chat', orgId: ORG });
    expect(mockConsume).toHaveBeenCalledWith(expect.anything(), 'prop-1', snap.id);
  });

  it('a LOST consumption race ABORTS the whole transaction — no half-consumed intent', async () => {
    mockConsume.mockResolvedValue(false);
    await expect(createActionIntent(auth, { toolName: 'run_script', input: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, source: 'chat', orgId: ORG }))
      .rejects.toThrow(/proposal_already_consumed/);
  });

  it('a refusal falls through to the human path unchanged, with the reason as a breadcrumb', async () => {
    mockEvaluate.mockResolvedValue({ granted: false, reason: 'hourly_cap' });
    await createActionIntent(auth, { toolName: 'run_script', input: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, source: 'chat', orgId: ORG });
    expect(insertedValues).toMatchObject({ status: undefined, result: { scriptLaneRefusal: 'hourly_cap' } });
    expect(approvalRequestInserts.length).toBeGreaterThan(0);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('ticket autonomy still wins when it granted — the two are never both stamped', async () => {
    mockTicketAutonomy.mockResolvedValue({ granted: true });
    await createActionIntent(agentAuth, { toolName: 'run_script', input: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, source: 'ai_agent', orgId: ORG, autonomy: { kind: 'ticket_autonomy' }, scope: { ticketId: TICKET } });
    expect(insertedValues.decidedVia).toBe('ticket_autonomy');
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService.scriptReviewer.test.ts`
Expected: FAIL — no lane branch exists; every assertion on `decidedVia: 'script_reviewer'` fails.

- [ ] **Step 3: Add the evaluation immediately after `evaluateTicketAutonomy`**

```ts
// apps/api/src/services/actionIntents/intentService.ts — after :1579 `const autonomyGranted = …`

      // AI script authoring W04 (#5612), spec §4.6 — the THIRD autonomy type
      // at this seam, evaluated in the SAME transaction on the SAME ambient
      // `db` as the ticket one above and the insert below, for the same
      // reason: a concurrent policy flip must not land between "decide" and
      // "insert", and the hourly reservation must be held under the advisory
      // lock across both.
      //
      // Short-circuited to nothing for every intent that is not `run_script`
      // with a `proposalId` — the overwhelming majority — so this module
      // costs nothing on the ordinary path.
      //
      // Ticket autonomy wins when it granted: an intent carries exactly one
      // `decided_via`, and re-deciding an already-decided row would make the
      // evidence describe a decision that did not release it.
      const proposalIdArg = input.toolName === 'run_script'
        ? (input.input as { proposalId?: unknown }).proposalId
        : undefined;
      let scriptLaneDecision: ScriptReviewerDecision | null = null;
      if (!autonomyGranted && typeof proposalIdArg === 'string') {
        const proposal = await loadProposalForRelease(db, proposalIdArg, orgId);
        const review = proposal ? await latestCompletedReview(db, proposal.id) : null;
        scriptLaneDecision = proposal
          ? await evaluateScriptReviewerAutonomy({
            tx: db,
            auth,
            intentDraft: {
              orgId,
              approvalScope,
              agentRun: agentRun
                ? { id: agentRun.id, agentId: agentRun.agentId, policySnapshot: agentRun.policySnapshot, reservation: input.actReservation ?? { count: 0 } }
                : null,
              arguments: input.input,
            },
            proposal,
            review,
          })
          : { granted: false, reason: 'proposal_not_runnable' };
      }
      const scriptLaneGranted = scriptLaneDecision?.granted === true;
```

- [ ] **Step 4: Stamp the insert, skip the fan-out, publish the outbox**

```ts
// :1657 — beside the ticket-autonomy spread, never nested inside it
          ...(autonomyGranted
            ? {
              status: 'approved' as const,
              decidedVia: 'ticket_autonomy',
              decidedAt: new Date(),
              decidedByUserId: null,
              releaseBy: new Date(Date.now() + RELEASE_LEASE_MS),
            }
            : {}),
          // W04 (#5612): the SAME approved-at-creation shape, with the lane's
          // typed evidence. `decidedByUserId: null` because no human decided
          // this; `releaseBy` the same fixed lease every approved intent gets.
          ...(scriptLaneGranted && scriptLaneDecision?.granted
            ? {
              status: 'approved' as const,
              decidedVia: 'script_reviewer',
              decidedAt: new Date(),
              decidedByUserId: null,
              releaseBy: new Date(Date.now() + RELEASE_LEASE_MS),
              scriptReviewerEvidence: scriptLaneDecision.evidence,
            }
            : {}),
          result: autonomyResult ?? scriptLaneRefusalResult,
```

with, beside `autonomyResult` at `:1585`:

```ts
      // A refusal is a breadcrumb on a row that still proceeds down the
      // ordinary human path — never an error, exactly like `autonomyDenied`.
      const scriptLaneRefusalResult: Record<string, unknown> | null =
        scriptLaneDecision && !scriptLaneDecision.granted
          ? { scriptLaneRefusal: scriptLaneDecision.reason }
          : null;
```

```ts
// :1824 — widen the fan-out skip
      if (!autonomyGranted && !scriptLaneGranted && decisionState === 'human_required') {
```

```ts
// :1871 — widen the intent_approved publish
      if (autonomyGranted || scriptLaneGranted) {
        await db.insert(intentOutbox).values({
          intentId: inserted.id,
          eventType: 'intent_approved',
          payload: { intentId: inserted.id, orgId },
        });
      }
```

- [ ] **Step 5: Consume the proposal inside the same transaction**

Place this immediately after the `reserveOperation` block (`:1802-1817`) so a task-linked lane intent still reserves its operation first:

```ts
      // W04 (#5612): claim the proposal for THIS intent by CAS
      // (`consumeProposalForIntent`, roadmap §3.3). It MUST succeed — a lost
      // race means another intent already owns this proposal, and releasing
      // both would run the same script twice. Throwing rolls the whole
      // transaction back, which is the only safe outcome: there is no
      // "approved intent with no proposal" state worth committing.
      if (scriptLaneGranted) {
        const claimed = await consumeProposalForIntent(db, proposalIdArg as string, inserted.id);
        if (!claimed) {
          throw new ActionIntentError(
            `Script proposal ${String(proposalIdArg)} was already consumed by another intent`,
            'proposal_already_consumed',
          );
        }
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService`
Expected: PASS — the new suite plus every existing `intentService*.test.ts` (the ticket-autonomy, scope, tier2Agent and main suites must be untouched; if any of them changed behaviour, the branch leaked).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/actionIntents/intentService.scriptReviewer.test.ts
git commit -m "feat(ai): decide the unattended script lane inside createActionIntent

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: `revalidateRelease` — recognise `script_reviewer` on both origins

**Files:**
- Modify: `apps/api/src/services/actionIntents/revalidateRelease.ts:130-132`, `:169-190`
- Modify: `apps/api/src/services/actionIntents/revalidateRelease.test.ts`

**Interfaces:**
- Consumes: `revalidateScriptReviewerEvidence` (Task 14).
- Produces: `errorCode: 'lane_revoked'` with `details: { reason: ScriptReviewerRefusal }`.

**SPEC/CODE CONTRADICTION — read this before editing.** Spec §4.6 requires the no-approval-row exception to cover **both** chat-origin and agent-origin intents. The existing predicate requires `!!intent.requestingAgentRunId` (`revalidateRelease.ts:170`, `:178`) — a clause added deliberately as tamper defence for policy-decide, which only ever authorises agent proposals. A **chat**-origin `script_reviewer` intent has `requestingAgentRunId === null`, so the exception would not apply and release would fail `digest_mismatch` against a `winningApproval` that does not exist. The fix is to make the run-id requirement a property of the *policy* branch rather than of the exception as a whole, and to substitute a stronger, lane-specific proof for it: a validated evidence blob. **Do not simply delete the run-id clause** — that would also widen the policy branch.

**Naming note.** The spec writes the failure as `failed:lane_revoked:<reason>`. That notation only ever appears in prose comments in this repo; the mechanism is a two-argument `failIntent(intent, errorCode, { details })` (`intentReleaseWorker.ts:934`). Use `errorCode: 'lane_revoked'` + `details.reason`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/actionIntents/revalidateRelease.test.ts — append
const mockLaneRevalidate = vi.fn();
vi.mock('./scriptReviewerAutonomy', () => ({ revalidateScriptReviewerEvidence: (...a: unknown[]) => mockLaneRevalidate(...a) }));

describe('script_reviewer release', () => {
  beforeEach(() => mockLaneRevalidate.mockResolvedValue({ ok: true }));

  it('a CHAT-origin lane intent releases with NO approval row', async () => {
    const intent = baseIntent({ decidedVia: 'script_reviewer', requestingAgentRunId: null, requestedByUserId: USER });
    await expect(revalidateApprovedIntentForRelease(intent, null)).resolves.toMatchObject({ ok: true });
  });

  it('an AGENT-origin lane intent releases with NO approval row', async () => {
    const intent = baseIntent({ decidedVia: 'script_reviewer', requestingAgentRunId: RUN });
    await expect(revalidateApprovedIntentForRelease(intent, null)).resolves.toMatchObject({ ok: true });
  });

  it('a revoked lane fails with lane_revoked and the specific reason', async () => {
    mockLaneRevalidate.mockResolvedValue({ ok: false, reason: 'lane_open' });
    const intent = baseIntent({ decidedVia: 'script_reviewer', requestingAgentRunId: null, requestedByUserId: USER });
    await expect(revalidateApprovedIntentForRelease(intent, null))
      .resolves.toEqual({ ok: false, errorCode: 'lane_revoked', details: { reason: 'lane_open' } });
  });

  it('a ticket_autonomy intent with NO run id is still refused — the widening is lane-only', async () => {
    const intent = baseIntent({ decidedVia: 'ticket_autonomy', requestingAgentRunId: null });
    await expect(revalidateApprovedIntentForRelease(intent, null))
      .resolves.toEqual({ ok: false, errorCode: 'digest_mismatch' });
  });

  it('a policy intent with NO run id is still refused', async () => {
    const intent = baseIntent({ decidedVia: 'policy', policyDecisionState: 'authorized', requestingAgentRunId: null });
    await expect(revalidateApprovedIntentForRelease(intent, null))
      .resolves.toEqual({ ok: false, errorCode: 'digest_mismatch' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/revalidateRelease.test.ts`
Expected: FAIL — the chat-origin case returns `digest_mismatch`.

- [ ] **Step 3: Edit `isSystemDecided` and the exception**

```ts
// :130-132
function isSystemDecided(intent: ActionIntent): boolean {
  return intent.decidedVia === 'policy'
    || intent.decidedVia === 'ticket_autonomy'
    // W04 (#5612): the unattended script lane. Same defining shape — no
    // approval_requests row by construction, no human ever reviewed it —
    // decided at creation like ticket_autonomy, not by a post-commit attempt.
    || intent.decidedVia === 'script_reviewer';
}
```

```ts
// :177-190, replacing the noApprovalRowRequired block
  // W04 (#5612): `requestingAgentRunId` is required for the POLICY and
  // TICKET branches (policy-decide only ever authorizes agent proposals, and
  // a row carrying those columns without a run is the tamper shape the
  // clause exists to catch). The SCRIPT LANE covers chat sessions too
  // (spec D1/§4.6 "Release"), so a chat-origin lane intent has no run id by
  // design — and would fail `digest_mismatch` here against an approval row
  // that never existed.
  //
  // The run-id clause is therefore scoped to the two branches that need it,
  // and the lane substitutes a STRONGER proof: a typed evidence blob that
  // revalidates against current policy, proposal, review, circuit, authority
  // and device state. A forged row with `decided_via = 'script_reviewer'`
  // and no valid evidence fails `evidenceValid` and never reaches here.
  const laneEvidenceValid = intent.decidedVia === 'script_reviewer'
    ? await revalidateScriptReviewerEvidence(intent, db)
    : null;
  if (laneEvidenceValid && !laneEvidenceValid.ok) {
    return { ok: false, errorCode: 'lane_revoked', details: { reason: laneEvidenceValid.reason } };
  }

  const noApprovalRowRequired = !winningApproval
    && isSystemDecided(intent)
    && (intent.decidedVia === 'script_reviewer'
      ? laneEvidenceValid?.ok === true
      : !!intent.requestingAgentRunId
        && (intent.decidedVia !== 'policy' || intent.policyDecisionState === 'authorized'));
```

`isPolicyDecided` (`:169-172`) is unchanged — it already pins `decidedVia === 'policy'`.

Import `revalidateScriptReviewerEvidence` from `./scriptReviewerAutonomy` and `db` from `../../db`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/actionIntents/revalidateRelease.test.ts src/services/actionIntents/agentReleaseAuthority.test.ts`
Expected: PASS, including every pre-existing case (the two "still refused" tests are the proof the widening did not leak).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents/revalidateRelease.ts apps/api/src/services/actionIntents/revalidateRelease.test.ts
git commit -m "feat(ai): release script_reviewer intents on both chat and agent origins

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Read the checkpoint back before dispatch

**Files:**
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts` (between the effect-digest recompute ending `:1032` and the session-required gate `:1045`)
- Test: `apps/api/src/jobs/intentReleaseWorker.scriptLane.test.ts` (create)

**Interfaces:**
- Consumes: `ensureRestoreCheckpoint` (Task 7), `ScriptReviewerEvidence.checkpointRequired` (Task 13).
- Produces: a `failIntent(intent, 'checkpoint_unavailable', …)` stop before any effect.

**Why here and not in `revalidateScriptReviewerEvidence`.** Spec §4.6 makes the checkpoint "a release precondition" read back **before dispatch**. Putting it inside the evidence revalidation would take a second three-minute checkpoint on every release path (including the inline chat one, which already took one at creation). This gate re-takes it only when the release is happening on a different pass than the admission, and it is the last thing before the effect — which is exactly where a rollback point belongs.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/jobs/intentReleaseWorker.scriptLane.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const mockCheckpoint = vi.fn();
vi.mock('../services/deviceRecovery/restoreCheckpoint', () => ({
  ensureRestoreCheckpoint: (...a: unknown[]) => mockCheckpoint(...a),
  RESTORE_CHECKPOINT_CLASSES: new Set(['registry', 'services', 'files_system']),
}));
// … the worker's existing harness …

describe('intentReleaseWorker — script lane checkpoint precondition', () => {
  beforeEach(() => mockCheckpoint.mockResolvedValue({ ok: true, checkpointRef: '42' }));

  it('takes no checkpoint for an intent that never needed one', async () => {
    await releaseIntent(laneIntent({ checkpointRequired: false }));
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(executedTool).toBe(true);
  });

  it('takes one, before the tool runs, when the evidence says it was required', async () => {
    await releaseIntent(laneIntent({ checkpointRequired: true }));
    expect(mockCheckpoint).toHaveBeenCalledWith('dev-1');
    expect(callOrder).toEqual(['checkpoint', 'executeTool']);
  });

  it('fails the intent WITHOUT executing when the checkpoint cannot be taken', async () => {
    mockCheckpoint.mockResolvedValue({ ok: false, reason: 'checkpoint_failed' });
    await releaseIntent(laneIntent({ checkpointRequired: true }));
    expect(executedTool).toBe(false);
    expect(failedWith).toMatchObject({ errorCode: 'checkpoint_unavailable', details: { reason: 'checkpoint_failed' } });
  });

  it('never runs for a non-lane intent', async () => {
    await releaseIntent(humanApprovedIntent());
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/intentReleaseWorker.scriptLane.test.ts`
Expected: FAIL — no checkpoint call happens and the tool executes.

- [ ] **Step 3: Add the gate**

```ts
// apps/api/src/jobs/intentReleaseWorker.ts — after `verifiedContext = recomputed.context;`
  // AI script authoring W04 (#5612), spec §4.6 invariant 11: the recovery
  // prerequisite is a RELEASE precondition, read back immediately before the
  // effect. Placed after the digest recompute (so a drifted proposal never
  // costs a checkpoint) and before the session-required gate and the dispatch
  // (so nothing mutates the device without a rollback point).
  const laneEvidence = intent.scriptReviewerEvidence as ScriptReviewerEvidence | null;
  if (intent.decidedVia === 'script_reviewer' && laneEvidence?.checkpointRequired) {
    const deviceId = (intent.arguments as { deviceIds?: string[] }).deviceIds?.[0];
    const checkpoint = deviceId
      ? await ensureRestoreCheckpoint(deviceId)
      : { ok: false as const, reason: 'device_unavailable' as const };
    if (!checkpoint.ok) {
      await failIntent(intent, 'checkpoint_unavailable', {
        details: { actionName: intent.actionName, reason: checkpoint.reason },
      });
      return;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/jobs/intentReleaseWorker`
Expected: PASS, with the pre-existing worker suites unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.scriptLane.test.ts
git commit -m "feat(ai): restore checkpoint is a release precondition for lane intents

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Suppress the chat approval card for an approved-at-creation intent

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts:1227-1266`
- Test: `apps/api/src/services/aiAgentSdk.scriptLane.test.ts` (create)

**Verified seam status (the brief asked for this check).** The chat **release** path already handles an intent that is `approved` at creation, and needs no change: `waitForIntentDecision` (`intentService.ts:2545-2578`) returns the row's status on its first poll and only loops while `pending_approval`, so it returns `'approved'` immediately (`aiAgentSdk.ts:1278`); the `approved -> executing` CAS at `:1372` is status-driven; and `revalidateApprovedIntentForRelease(intentRow, winningApproval)` at `:1448` is called with `winningApproval === null` (the select at `:1194-1199` finds no approved `approval_requests` row), which is precisely the no-approval-row exception Task 16 extends. **What is missing is only the UI side**: `session.eventBus.publish({ type: 'approval_required', … })` at `:1227` fires unconditionally, so an unattended run flashes an approval card that nobody needs to act on and that resolves itself a second later.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiAgentSdk.scriptLane.test.ts
describe('chat inline release of an approved-at-creation intent', () => {
  it('publishes NO approval_required event when the intent is already approved', async () => {
    mockCreateActionIntent.mockResolvedValue({ id: 'int-1', status: 'approved', approvalRequestIds: [], requesterApprovalRequestId: null, expiresAt: new Date(Date.now() + 600_000) });
    await runToolCall('run_script', { proposalId: 'prop-1', deviceIds: ['dev-1'] });
    expect(published.map((e) => e.type)).not.toContain('approval_required');
  });

  it('publishes an informational unattended_release event instead', async () => {
    mockCreateActionIntent.mockResolvedValue({ id: 'int-1', status: 'approved', approvalRequestIds: [], requesterApprovalRequestId: null, expiresAt: new Date(Date.now() + 600_000) });
    await runToolCall('run_script', { proposalId: 'prop-1', deviceIds: ['dev-1'] });
    expect(published.find((e) => e.type === 'unattended_release')).toMatchObject({ intentId: 'int-1' });
  });

  it('still publishes approval_required for an ordinary pending intent', async () => {
    mockCreateActionIntent.mockResolvedValue({ id: 'int-2', status: 'pending_approval', approvalRequestIds: ['ar-1'], requesterApprovalRequestId: 'ar-1', expiresAt: new Date(Date.now() + 300_000) });
    await runToolCall('run_script', { scriptId: 's-1', deviceIds: ['dev-1'] });
    expect(published.map((e) => e.type)).toContain('approval_required');
  });

  it('still reaches the release CAS and revalidation for the approved-at-creation intent', async () => {
    mockCreateActionIntent.mockResolvedValue({ id: 'int-1', status: 'approved', approvalRequestIds: [], requesterApprovalRequestId: null, expiresAt: new Date(Date.now() + 600_000) });
    await runToolCall('run_script', { proposalId: 'prop-1', deviceIds: ['dev-1'] });
    expect(mockRevalidate).toHaveBeenCalled();
    expect(mockTransitionIntent).toHaveBeenCalledWith('int-1', 'approved', 'executing', expect.anything(), expect.anything());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiAgentSdk.scriptLane.test.ts`
Expected: FAIL — `approval_required` is published.

- [ ] **Step 3: Branch the publish**

Keyed on `intent.status`, not on `decidedVia` — `ActionIntentSnapshot` (`intentService.ts:218-246`) exposes `status` but not `decidedVia`, and "already decided, nothing to approve" is the honest condition. It also covers the ticket-autonomy twin, which has the same latent flash today.

```ts
// apps/api/src/services/aiAgentSdk.ts — replacing the publish at :1227
          // W04 (#5612): an intent that is ALREADY `approved` at creation was
          // decided by an autonomy path (script_reviewer here; ticket_autonomy
          // too) and has NO approval_requests row for anyone to act on. Showing
          // an approval card for it is a lie that resolves itself a second
          // later. Publish an informational event instead, and fall through to
          // the same wait/CAS/revalidate path — `waitForIntentDecision` returns
          // `approved` on its first poll (intentService.ts:2568), so the
          // release below is unchanged.
          if (intent.status === 'approved') {
            session.eventBus.publish({
              type: 'unattended_release',
              executionId: approvalExec.id,
              intentId: intent.id,
              toolName,
              description,
              deviceContext,
              scriptRunContext,
            });
          } else {
            session.eventBus.publish({
              type: 'approval_required',
              executionId: approvalExec.id,
              approvalRequestId: intent.approvalRequestIds[0],
              selfApprovalRequestId: intent.requesterApprovalRequestId ?? undefined,
              approvalScope: guardrailCheck.approvalScope,
              scriptRunContext,
              intentExpiresAt: intent.expiresAt.toISOString(),
              toolName,
              input,
              description,
              deviceContext,
              intentBacked: true,
            });
          }
```

Add `unattended_release` to the session event-bus union and to the web SSE handler's ignore/render list so an unknown event type is not dropped silently.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiAgentSdk`
Expected: PASS, with the existing approval-wait and plan-match suites unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgentSdk.ts apps/api/src/services/aiAgentSdk.scriptLane.test.ts
git commit -m "fix(ai): no approval card for an intent already approved at creation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: `onUnattendedVerificationOutcome` — circuit, audit, agent circuit, notify

**Files:**
- Create: `apps/api/src/services/scriptProposals/laneOutcome.ts`, `apps/api/src/services/scriptProposals/laneOutcome.test.ts`
- Modify: `apps/api/src/services/scriptProposals/verify.ts` (the W03 hook call site)

**Interfaces:**
- Consumes: `aiScriptLaneState` (Task 3), `createAuditLogAsync` (`services/auditService.ts:101`), `recordRunTerminal` / `classifyTerminal` (`services/aiAgents/agentCircuit.ts:377`, `:190`), `createNotification` (`services/userNotifications.ts`).
- Produces:
```ts
export interface UnattendedVerificationOutcome {
  orgId: string;
  proposalId: string;
  intentId: string;
  executionId: string;
  outcome: 'verified' | 'verification_failed' | 'unknown';
  origin: { kind: 'chat'; sessionId: string; userId: string | null } | { kind: 'agent'; runId: string; agentId: string };
}
export function onUnattendedVerificationOutcome(o: UnattendedVerificationOutcome): Promise<void>;
export const LANE_OPEN_THRESHOLD = 2;
```

**Seam check.** W03's `verify.ts` is specified to *expose* this hook (roadmap §3.5). Before writing the module, `grep -n "onUnattendedVerificationOutcome" apps/api/src/services/scriptProposals/verify.ts`. If the call site exists, implement the module it imports. If W03 left no seam, add the call in `verify.ts` at the point where the proposal transitions `executed → verified | verification_failed`, gated on `intent.decidedVia === 'script_reviewer'` — the lane circuit must never be moved by a human-approved run.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/scriptProposals/laneOutcome.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const updates: Array<Record<string, unknown>> = [];
const audits: Array<Record<string, unknown>> = [];
const notifications: Array<Record<string, unknown>> = [];
const mockRecordRunTerminal = vi.fn();
// … db mock capturing the upsert `set` payload into `updates` …
vi.mock('../auditService', () => ({ createAuditLogAsync: async (p: unknown) => { audits.push(p as never); } }));
vi.mock('../userNotifications', () => ({ createNotification: async (p: unknown) => { notifications.push(p as never); } }));
vi.mock('../aiAgents/agentCircuit', () => ({ recordRunTerminal: (...a: unknown[]) => mockRecordRunTerminal(...a) }));

import { onUnattendedVerificationOutcome, LANE_OPEN_THRESHOLD } from './laneOutcome';

const CHAT = { kind: 'chat', sessionId: 'sess-1', userId: 'u-1' } as const;
const AGENT = { kind: 'agent', runId: 'run-1', agentId: 'agent-1' } as const;
const base = { orgId: 'org-1', proposalId: 'prop-1', intentId: 'int-1', executionId: 'exec-1' };

describe('onUnattendedVerificationOutcome', () => {
  beforeEach(() => { updates.length = 0; audits.length = 0; notifications.length = 0; mockRecordRunTerminal.mockReset(); currentStreak = 0; });

  it('a verified run RESETS the counter and audits ai.script.unattended_verified', async () => {
    currentStreak = 1;
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verified', origin: CHAT });
    expect(updates[0]).toMatchObject({ consecutiveFailedVerifications: 0, state: 'closed' });
    expect(audits[0]).toMatchObject({ action: 'ai.script.unattended_verified', result: 'success' });
  });

  it('a FAILED verification increments and audits ai.script.unattended_failed', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(audits[0]).toMatchObject({ action: 'ai.script.unattended_failed', result: 'failure' });
  });

  it('an UNKNOWN outcome counts as a failure — an unverifiable run is not a success', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'unknown', origin: CHAT });
    expect(audits[0]).toMatchObject({ action: 'ai.script.unattended_failed' });
  });

  it('the lane OPENS at the second consecutive failure, not the first', async () => {
    currentStreak = 0;
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(updates.at(-1)).not.toMatchObject({ state: 'open' });
    currentStreak = 1;
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(updates.at(-1)).toMatchObject({ state: 'open', openedReason: expect.stringContaining(String(LANE_OPEN_THRESHOLD)) });
    expect(audits.some((a) => a.action === 'ai.script_lane.opened')).toBe(true);
  });

  it('an AGENT-origin failure ALSO feeds the agent circuit', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: AGENT });
    expect(mockRecordRunTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1', orgId: 'org-1', agentId: 'agent-1' }),
      'completed', null, 'needs_attention',
    );
  });

  it('a CHAT-origin failure does NOT touch the agent circuit (there is no agent key)', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(mockRecordRunTerminal).not.toHaveBeenCalled();
  });

  it('notifies the session owner on a chat-origin failure', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verification_failed', origin: CHAT });
    expect(notifications[0]).toMatchObject({ userId: 'u-1' });
  });

  it('a verified run notifies nobody — success is not an interruption', async () => {
    await onUnattendedVerificationOutcome({ ...base, outcome: 'verified', origin: CHAT });
    expect(notifications).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/laneOutcome.test.ts`
Expected: FAIL — `Cannot find module './laneOutcome'`.

- [ ] **Step 3: Implement it**

```ts
// apps/api/src/services/scriptProposals/laneOutcome.ts
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiScriptLaneState } from '../../db/schema/aiScriptLaneState';
import { createAuditLogAsync } from '../auditService';
import { createNotification } from '../userNotifications';
import { recordRunTerminal } from '../aiAgents/agentCircuit';
import { captureException } from '../sentry';

/** Spec §9: "Lane state opens after 2 consecutive failed or unknown verifications." */
export const LANE_OPEN_THRESHOLD = 2;

export interface UnattendedVerificationOutcome {
  orgId: string;
  proposalId: string;
  intentId: string;
  executionId: string;
  outcome: 'verified' | 'verification_failed' | 'unknown';
  origin:
    | { kind: 'chat'; sessionId: string; userId: string | null }
    | { kind: 'agent'; runId: string; agentId: string };
}

/**
 * The lane's circuit, driven by the verification job (W03 §4.9).
 *
 * `unknown` counts as a FAILURE. An unattended run whose effect could not be
 * independently confirmed is not a success — the operator rule is that a
 * dispatch result is never evidence of recovery
 * (`services/aiOperator/verification.ts:5-11`), and a lane that treats
 * "couldn't check" as "fine" would never open at all on a fleet that keeps
 * going offline.
 *
 * The agent circuit is fed IN ADDITION for agent-origin runs, never instead:
 * `ai_agent_circuit_state` is keyed (org_id, agent_id) and a chat session has
 * no agent key, which is why the lane needs its own per-org state at all.
 */
export async function onUnattendedVerificationOutcome(o: UnattendedVerificationOutcome): Promise<void> {
  const failed = o.outcome !== 'verified';
  try {
    const laneRow = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(aiScriptLaneState)
        .values({
          orgId: o.orgId,
          consecutiveFailedVerifications: failed ? 1 : 0,
          state: 'closed',
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: aiScriptLaneState.orgId,
          set: failed
            ? {
              consecutiveFailedVerifications: sql`${aiScriptLaneState.consecutiveFailedVerifications} + 1`,
              updatedAt: new Date(),
            }
            : {
              consecutiveFailedVerifications: 0,
              state: 'closed',
              openedAt: null,
              openedReason: null,
              updatedAt: new Date(),
            },
        })
        .returning();
      if (!row) return null;

      // Open by CAS on state='closed', so two concurrent failures cannot
      // both claim the open (same shape as agentCircuit.ts:461-476).
      if (failed && row.consecutiveFailedVerifications >= LANE_OPEN_THRESHOLD && row.state === 'closed') {
        const reason = `${row.consecutiveFailedVerifications} consecutive failed or unknown verifications (threshold ${LANE_OPEN_THRESHOLD})`;
        const [opened] = await db
          .update(aiScriptLaneState)
          .set({ state: 'open', openedAt: new Date(), openedReason: reason, updatedAt: new Date() })
          .where(and(eq(aiScriptLaneState.orgId, o.orgId), eq(aiScriptLaneState.state, 'closed')))
          .returning();
        return opened ?? row;
      }
      return row;
    }));

    await createAuditLogAsync({
      orgId: o.orgId,
      actorType: 'system',
      actorId: 'ai-script-lane',
      action: failed ? 'ai.script.unattended_failed' : 'ai.script.unattended_verified',
      resourceType: 'script_proposal',
      resourceId: o.proposalId,
      details: { intentId: o.intentId, executionId: o.executionId, outcome: o.outcome, origin: o.origin.kind },
      result: failed ? 'failure' : 'success',
      initiatedBy: 'ai',
    });

    if (laneRow?.state === 'open' && laneRow.openedReason) {
      await createAuditLogAsync({
        orgId: o.orgId,
        actorType: 'system',
        actorId: 'ai-script-lane',
        action: 'ai.script_lane.opened',
        resourceType: 'ai_script_lane_state',
        resourceId: o.orgId,
        details: { reason: laneRow.openedReason, proposalId: o.proposalId },
        result: 'success',
        initiatedBy: 'ai',
      });
    }

    if (failed && o.origin.kind === 'agent') {
      // Feed the EXISTING agent classifier so an agent whose unattended
      // scripts keep failing trips its own circuit too. `needs_attention` is
      // the verdict classifyTerminal (agentCircuit.ts:196-199) increments on.
      await recordRunTerminal(
        { id: o.origin.runId, orgId: o.orgId, agentId: o.origin.agentId, profile: 'full' },
        'completed',
        null,
        'needs_attention',
      );
    }

    if (failed) {
      const userId = o.origin.kind === 'chat' ? o.origin.userId : null;
      if (userId) {
        await createNotification({
          userId,
          orgId: o.orgId,
          type: 'ai_script_unattended_failed',
          title: 'An unattended AI script run could not be verified',
          body: `Proposal ${o.proposalId} ran unattended and its verification came back ${o.outcome}.`,
          link: `/scripts/proposals/${o.proposalId}`,
        });
      }
      // Agent recipients go through the agent's own notification fan-out,
      // which recordRunTerminal already triggers on a circuit open.
    }
  } catch (err) {
    // Never let the circuit bookkeeping fail the verification job itself.
    console.error('[laneOutcome] failed to record an unattended verification outcome:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
```

- [ ] **Step 4: Wire (or verify) the `verify.ts` call site**

```ts
// apps/api/src/services/scriptProposals/verify.ts — where executed -> verified|verification_failed lands
  // W04 (#5612): only a LANE run moves the lane circuit. A human-approved run
  // that fails verification is the human's problem, not evidence that the
  // unattended lane is unsafe.
  if (intent?.decidedVia === 'script_reviewer') {
    await onUnattendedVerificationOutcome({
      orgId: proposal.orgId,
      proposalId: proposal.id,
      intentId: intent.id,
      executionId: execution.id,
      outcome,
      origin: intent.requestingAgentRunId
        ? { kind: 'agent', runId: intent.requestingAgentRunId, agentId: (intent.scriptReviewerEvidence as ScriptReviewerEvidence).agent!.agentId }
        : { kind: 'chat', sessionId: proposal.sessionId!, userId: intent.requestedByUserId },
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/laneOutcome.test.ts src/services/scriptProposals/verify.test.ts`
Expected: PASS (8 + the existing verify cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/scriptProposals/laneOutcome.ts apps/api/src/services/scriptProposals/laneOutcome.test.ts apps/api/src/services/scriptProposals/verify.ts
git commit -m "feat(ai): unattended verification outcomes drive the lane circuit and audit

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: Audit `ai.script.unattended_run` at approval, and register the step-up operation

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (after the creation transaction commits), `apps/api/src/services/mfaStepUpGrant.ts:34-45` (`StepUpOperation`), `apps/api/src/services/mfaStepUpGrant.ts` (a new resource-digest helper)
- Test: `apps/api/src/services/actionIntents/intentService.scriptReviewer.test.ts` (extend), `apps/api/src/services/mfaStepUpGrant.test.ts` (extend)

**Interfaces:**
- Consumes: `createAuditLogAsync`, `scriptLaneGranted` (Task 15).
- Produces: audit action `ai.script.unattended_run`; `StepUpOperation` gains `'ai_script_lane_grant'`; `export function scriptLanePolicyResourceDigest(input: { orgId: string; unattendedEnabled: boolean }): \`sha256:${string}\``.

- [ ] **Step 1: Write the failing tests**

```ts
// intentService.scriptReviewer.test.ts — append
  it('audits ai.script.unattended_run once the intent commits', async () => {
    await createActionIntent(auth, { toolName: 'run_script', input: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, source: 'chat', orgId: ORG });
    expect(audits).toContainEqual(expect.objectContaining({
      action: 'ai.script.unattended_run', resourceType: 'action_intent', result: 'success', initiatedBy: 'ai',
    }));
  });

  it('does NOT audit an unattended run when the lane refused', async () => {
    mockEvaluate.mockResolvedValue({ granted: false, reason: 'lane_open' });
    await createActionIntent(auth, { toolName: 'run_script', input: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, source: 'chat', orgId: ORG });
    expect(audits.map((a) => a.action)).not.toContain('ai.script.unattended_run');
  });
```

```ts
// mfaStepUpGrant.test.ts — append
  it('ai_script_lane_grant is a valid step-up operation', () => {
    expect(STEP_UP_OPERATIONS).toContain('ai_script_lane_grant');
  });
  it('the lane-policy resource digest binds the org AND the requested value', () => {
    const a = scriptLanePolicyResourceDigest({ orgId: 'org-1', unattendedEnabled: true });
    expect(a).not.toBe(scriptLanePolicyResourceDigest({ orgId: 'org-1', unattendedEnabled: false }));
    expect(a).not.toBe(scriptLanePolicyResourceDigest({ orgId: 'org-2', unattendedEnabled: true }));
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService.scriptReviewer.test.ts src/services/mfaStepUpGrant.test.ts`
Expected: FAIL on both files.

- [ ] **Step 3: Emit the audit after commit**

Audit writes must run **outside** the caller's request transaction (`auditService.ts`'s `persistAuditLog` header), so this goes after `withSystemDbAccessContext(...)` returns, beside the other post-commit work:

```ts
// apps/api/src/services/actionIntents/intentService.ts — after the creation transaction resolves
  if (creation.isNew && creation.intent.decidedVia === 'script_reviewer') {
    const evidence = creation.intent.scriptReviewerEvidence as ScriptReviewerEvidence | null;
    // Fire-and-forget with an in-process retry queue (createAuditLogAsync) —
    // the intent already committed; a transient audit fault must not undo an
    // approved run, and the retry drain covers the gap.
    void createAuditLogAsync({
      orgId,
      actorType: agentRun ? 'ai_agent' : 'system',
      actorId: agentRun?.agentId ?? requesterId ?? 'ai-script-lane',
      action: 'ai.script.unattended_run',
      resourceType: 'action_intent',
      resourceId: creation.intent.id,
      details: {
        proposalId: evidence?.proposalId,
        reviewId: evidence?.reviewId,
        touchClasses: evidence?.touchClasses,
        policySnapshot: evidence?.policySnapshot,
        checkpointRequired: evidence?.checkpointRequired,
        origin: agentRun ? 'agent' : 'chat',
      },
      result: 'success',
      initiatedBy: 'ai',
    });
  }
```

- [ ] **Step 4: Register the step-up operation and its digest**

```ts
// apps/api/src/services/mfaStepUpGrant.ts:34-45
export type StepUpOperation =
  | 'add_factor' | 'rotate_recovery_codes' | 'delete_passkey'
  | 'register_approver_device' | 'agent_rollback' | 'enroll_first_factor'
  | 'device_maintenance'
  // AI script authoring W04 (#5612): enabling the unattended lane on an org
  // is the same class of action as enabling agent act mode — a fresh MFA
  // proof, bound to the org AND to the value being set, so a grant minted to
  // turn the lane ON cannot be replayed to widen something else.
  | 'ai_script_lane_grant';

export function scriptLanePolicyResourceDigest(input: {
  orgId: string;
  unattendedEnabled: boolean;
}): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ orgId: input.orgId, unattendedEnabled: input.unattendedEnabled }))
    .digest('hex')}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService.scriptReviewer.test.ts src/services/mfaStepUpGrant.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/mfaStepUpGrant.ts apps/api/src/services/mfaStepUpGrant.test.ts apps/api/src/services/actionIntents/intentService.scriptReviewer.test.ts
git commit -m "feat(ai): audit ai.script.unattended_run and register the lane step-up operation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: Org routes — `GET`/`PUT /ai/script-policy` and `POST /ai/script-lane/reset`

**Files:**
- Create: `apps/api/src/routes/ai/scriptPolicy.ts`, `apps/api/src/routes/ai/scriptPolicy.test.ts`
- Modify: `apps/api/src/routes/index.ts` (mount)

**Interfaces:**
- Consumes: `aiScriptPolicies`, `aiScriptLaneState` (Task 3), `resolveEffectiveScriptPolicy` (Task 5), `validateStepUpGrant` / `consumeStepUpGrant` / `scriptLanePolicyResourceDigest` (Task 20), `PERMISSIONS` (`services/permissions.ts`).
- Produces: `export const aiScriptPolicyRoutes` mounted at `/api/v1/ai`.

**Authorisation.** Reading needs `ai_agents:read` (the same surface as the rest of Settings → AI). Writing anything needs `ai_agents:write`. Flipping `unattended_enabled` **to true** additionally needs `approvals:decide` **and** a fresh step-up grant bound to `{ orgId, unattendedEnabled: true }`. Turning it **off** needs no step-up: reducing authority is never gated behind a second factor.

- [ ] **Step 1: Write the failing route tests**

```ts
// apps/api/src/routes/ai/scriptPolicy.test.ts
describe('GET /ai/script-policy', () => {
  it('401 unauthenticated', async () => expect((await app.request('/ai/script-policy')).status).toBe(401));
  it('403 without ai_agents:read', async () => expect((await asUser(noPerms).get('/ai/script-policy')).status).toBe(403));
  it('returns the org row, the resolved effective policy, and the lane state', async () => {
    const res = await asUser(reader).get('/ai/script-policy');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      policy: { ownerScope: 'organization' },
      effective: { unattendedEnabled: false, maxUnattendedRiskTier: 'low' },
      laneState: { state: 'closed' },
    });
  });
  it('never returns another org\'s row', async () => {
    const body = await (await asUser(readerOrgB).get('/ai/script-policy')).json();
    expect(body.policy?.orgId).not.toBe(ORG_A);
  });
});

describe('PUT /ai/script-policy', () => {
  it('403 without ai_agents:write', async () => expect((await asUser(reader).put('/ai/script-policy', { maxUnattendedPerHour: 2 })).status).toBe(403));
  it('422 on an out-of-range per-hour value', async () => expect((await asUser(writer).put('/ai/script-policy', { maxUnattendedPerHour: 9999 })).status).toBe(422));
  it('422 on an unknown touch class', async () => expect((await asUser(writer).put('/ai/script-policy', { unattendedAllowedClasses: ['not_a_class'] })).status).toBe(422));
  it('422 when a class exceeds the partner ceiling', async () => {
    // partner ceiling allows {services}; the org asks for {services, registry}
    expect((await asUser(writer).put('/ai/script-policy', { unattendedAllowedClasses: ['services', 'registry'] })).status).toBe(422);
  });
  it('422 when the tier exceeds the partner ceiling', async () => expect((await asUser(writer).put('/ai/script-policy', { maxUnattendedRiskTier: 'medium' })).status).toBe(422));
  it('403 STEP_UP_REQUIRED when enabling without a grant', async () => {
    const res = await asUser(decider).put('/ai/script-policy', { unattendedEnabled: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
  });
  it('403 when enabling without approvals:decide, even WITH a grant', async () => {
    expect((await asUser(writer).put('/ai/script-policy', { unattendedEnabled: true, stepUpGrant: GRANT })).status).toBe(403);
  });
  it('enables with approvals:decide + a valid grant, stamps who and when, and audits', async () => {
    const res = await asUser(decider).put('/ai/script-policy', { unattendedEnabled: true, stepUpGrant: GRANT });
    expect(res.status).toBe(200);
    expect(upserted).toMatchObject({ unattendedEnabled: true, unattendedEnabledBy: decider.id });
    expect(upserted.unattendedEnabledAt).toBeInstanceOf(Date);
    expect(audits.at(-1)).toMatchObject({ action: 'ai.script_policy.updated' });
  });
  it('DISABLING needs no step-up — reducing authority is never second-factored', async () => {
    expect((await asUser(writer).put('/ai/script-policy', { unattendedEnabled: false })).status).toBe(200);
  });
  it('consumes the grant exactly once (a replay fails)', async () => {
    await asUser(decider).put('/ai/script-policy', { unattendedEnabled: true, stepUpGrant: GRANT });
    expect((await asUser(decider).put('/ai/script-policy', { unattendedEnabled: true, stepUpGrant: GRANT })).status).toBe(403);
  });
});

describe('POST /ai/script-lane/reset', () => {
  it('403 without approvals:decide', async () => expect((await asUser(writer).post('/ai/script-lane/reset', { stepUpGrant: GRANT })).status).toBe(403));
  it('403 STEP_UP_REQUIRED without a grant', async () => expect((await asUser(decider).post('/ai/script-lane/reset', {})).status).toBe(403));
  it('closes the lane, zeroes the streak, stamps the resetter, and audits ai.script_lane.reset', async () => {
    const res = await asUser(decider).post('/ai/script-lane/reset', { stepUpGrant: GRANT });
    expect(res.status).toBe(200);
    expect(updated).toMatchObject({ state: 'closed', consecutiveFailedVerifications: 0, resetByUserId: decider.id });
    expect(audits.at(-1)).toMatchObject({ action: 'ai.script_lane.reset', result: 'success' });
  });
  it('is idempotent on an already-closed lane', async () => {
    expect((await asUser(decider).post('/ai/script-lane/reset', { stepUpGrant: GRANT2 })).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/ai/scriptPolicy.test.ts`
Expected: FAIL — `Cannot find module './scriptPolicy'`.

- [ ] **Step 3: Implement the routes**

```ts
// apps/api/src/routes/ai/scriptPolicy.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { TOUCH_CLASSES, RISK_TIERS, riskTierRank } from '@breeze/shared';
import { db, withDbAccessContext } from '../../db';
import { aiScriptPolicies } from '../../db/schema/aiScriptPolicies';
import { aiScriptLaneState } from '../../db/schema/aiScriptLaneState';
import { requireAuth, type AuthContext } from '../../middleware/auth';
import { requirePermission, PERMISSIONS } from '../../services/permissions';
import { resolveEffectiveScriptPolicy } from '../../services/scriptProposals/policy';
import { consumeStepUpGrant, scriptLanePolicyResourceDigest } from '../../services/mfaStepUpGrant';
import { createAuditLogAsync } from '../../services/auditService';

const updateSchema = z.object({
  proposingEnabled: z.boolean().optional(),
  unattendedEnabled: z.boolean().optional(),
  maxUnattendedRiskTier: z.enum(RISK_TIERS).optional(),
  unattendedAllowedClasses: z.array(z.enum(TOUCH_CLASSES)).optional(),
  maxUnattendedPerHour: z.number().int().min(0).max(100).optional(),
  protectedResources: z.object({
    services: z.array(z.string()), paths: z.array(z.string()),
    registryKeys: z.array(z.string()), deviceTags: z.array(z.string()),
  }).optional(),
  reviewerModel: z.string().nullable().optional(),
  stepUpGrant: z.string().optional(),
}).strict();

export const aiScriptPolicyRoutes = new Hono();

aiScriptPolicyRoutes.get('/script-policy', requireAuth, requirePermission(PERMISSIONS.AI_AGENTS_READ), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const orgId = auth.orgId!;
  return withDbAccessContext(auth, async () => {
    const [policy] = await db.select().from(aiScriptPolicies).where(eq(aiScriptPolicies.orgId, orgId)).limit(1);
    const [laneState] = await db.select().from(aiScriptLaneState).where(eq(aiScriptLaneState.orgId, orgId)).limit(1);
    const effective = await resolveEffectiveScriptPolicy(orgId);
    return c.json({
      policy: policy ? { ...policy, ownerScope: 'organization' as const } : null,
      // The ceiling is surfaced so the UI can DISABLE what the partner
      // forbids rather than letting a tech save a value the API then 422s.
      effective,
      laneState: laneState ?? { state: 'closed', consecutiveFailedVerifications: 0, openedAt: null, openedReason: null, resetAt: null },
    });
  });
});

aiScriptPolicyRoutes.put('/script-policy', requireAuth, requirePermission(PERMISSIONS.AI_AGENTS_WRITE), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const orgId = auth.orgId!;
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: parsed.error.issues }, 422);
  const body = parsed.data;

  const effective = await resolveEffectiveScriptPolicy(orgId);

  // Tighten-only, enforced server-side. The resolver would clamp anyway, but
  // silently storing a value wider than the ceiling makes the saved row lie
  // about what is in force — and it would silently take effect if the
  // partner later widened.
  if (body.maxUnattendedRiskTier
    && riskTierRank(body.maxUnattendedRiskTier) > riskTierRank(effective.maxUnattendedRiskTier)) {
    return c.json({ error: 'above_partner_ceiling', field: 'maxUnattendedRiskTier' }, 422);
  }
  if (body.unattendedAllowedClasses?.some((cl) => !effective.unattendedAllowedClasses.includes(cl))) {
    return c.json({ error: 'above_partner_ceiling', field: 'unattendedAllowedClasses' }, 422);
  }
  if (body.maxUnattendedPerHour !== undefined && body.maxUnattendedPerHour > effective.maxUnattendedPerHour) {
    return c.json({ error: 'above_partner_ceiling', field: 'maxUnattendedPerHour' }, 422);
  }

  // Enabling is the privileged transition. Disabling is not: a second factor
  // on "turn the dangerous thing off" only delays a safety action.
  if (body.unattendedEnabled === true) {
    if (!auth.permissions?.includes(PERMISSIONS.APPROVALS_DECIDE)) {
      return c.json({ error: 'forbidden', reason: 'approvals:decide is required to enable the unattended lane' }, 403);
    }
    if (!body.stepUpGrant) return c.json({ error: 'forbidden', code: 'STEP_UP_REQUIRED' }, 403);
    const bound = {
      userId: auth.user!.id, operation: 'ai_script_lane_grant' as const,
      authEpoch: auth.authEpoch!, mfaEpoch: auth.mfaEpoch!, sid: auth.sid!,
      resourceDigest: scriptLanePolicyResourceDigest({ orgId, unattendedEnabled: true }),
    };
    if (!(await consumeStepUpGrant(body.stepUpGrant, bound))) {
      return c.json({ error: 'forbidden', code: 'STEP_UP_REQUIRED' }, 403);
    }
  }

  const { stepUpGrant: _drop, ...columns } = body;
  const row = await withDbAccessContext(auth, async () => {
    const [saved] = await db
      .insert(aiScriptPolicies)
      .values({
        orgId, createdBy: auth.user!.id, ...columns,
        ...(body.unattendedEnabled === true
          ? { unattendedEnabledBy: auth.user!.id, unattendedEnabledAt: new Date() }
          : {}),
      })
      .onConflictDoUpdate({
        target: aiScriptPolicies.orgId,
        set: {
          ...columns, updatedAt: new Date(),
          ...(body.unattendedEnabled === true
            ? { unattendedEnabledBy: auth.user!.id, unattendedEnabledAt: new Date() }
            : {}),
        },
      })
      .returning();
    return saved;
  });

  await createAuditLogAsync({
    orgId, actorType: 'user', actorId: auth.user!.id, actorEmail: auth.user!.email,
    action: 'ai.script_policy.updated', resourceType: 'ai_script_policies', resourceId: row!.id,
    details: { ...columns }, result: 'success', initiatedBy: 'manual',
  });
  return c.json({ policy: { ...row, ownerScope: 'organization' as const } });
});

aiScriptPolicyRoutes.post('/script-lane/reset', requireAuth, requirePermission(PERMISSIONS.APPROVALS_DECIDE), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const orgId = auth.orgId!;
  const { stepUpGrant } = z.object({ stepUpGrant: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
  if (!stepUpGrant) return c.json({ error: 'forbidden', code: 'STEP_UP_REQUIRED' }, 403);
  const bound = {
    userId: auth.user!.id, operation: 'ai_script_lane_grant' as const,
    authEpoch: auth.authEpoch!, mfaEpoch: auth.mfaEpoch!, sid: auth.sid!,
    resourceDigest: scriptLanePolicyResourceDigest({ orgId, unattendedEnabled: true }),
  };
  if (!(await consumeStepUpGrant(stepUpGrant, bound))) {
    return c.json({ error: 'forbidden', code: 'STEP_UP_REQUIRED' }, 403);
  }

  const row = await withDbAccessContext(auth, async () => {
    const [saved] = await db
      .insert(aiScriptLaneState)
      .values({ orgId, state: 'closed', consecutiveFailedVerifications: 0, resetByUserId: auth.user!.id, resetAt: new Date() })
      .onConflictDoUpdate({
        target: aiScriptLaneState.orgId,
        set: { state: 'closed', consecutiveFailedVerifications: 0, openedAt: null, openedReason: null, resetByUserId: auth.user!.id, resetAt: new Date(), updatedAt: new Date() },
      })
      .returning();
    return saved;
  });

  await createAuditLogAsync({
    orgId, actorType: 'user', actorId: auth.user!.id, actorEmail: auth.user!.email,
    action: 'ai.script_lane.reset', resourceType: 'ai_script_lane_state', resourceId: orgId,
    details: {}, result: 'success', initiatedBy: 'manual',
  });
  return c.json({ laneState: row });
});
```

Mount it beside the other `/ai` routers in `apps/api/src/routes/index.ts`, **before** any `/ai/:id` sibling so the literal paths are not swallowed by a param route.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/ai/scriptPolicy.test.ts`
Expected: PASS (all 19 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/ai/scriptPolicy.ts apps/api/src/routes/ai/scriptPolicy.test.ts apps/api/src/routes/index.ts
git commit -m "feat(ai): org script-policy routes and the MFA-gated lane reset endpoint

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: Partner route — `GET`/`PUT /partner/ai/script-policy`

**Files:**
- Create: `apps/api/src/routes/partnerAiScriptPolicy.ts`, `apps/api/src/routes/partnerAiScriptPolicy.test.ts`
- Modify: `apps/api/src/routes/index.ts`

**Interfaces:**
- Consumes: `canManagePartnerWidePolicies` (`services/partnerWideAccess.ts:25`), `PARTNER_WIDE_WRITE_DENIED_MESSAGE` (`:31`).
- Produces: `export const partnerAiScriptPolicyRoutes`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/routes/partnerAiScriptPolicy.test.ts
describe('partner ai script policy', () => {
  it('403 for an ORG-scoped token — a partner ceiling is not org-writable', async () => {
    expect((await asOrgUser(admin).put('/partner/ai/script-policy', { unattendedAllowed: true })).status).toBe(403);
  });
  it('403 for a partner token WITHOUT full org access (orgAccess !== "all")', async () => {
    const res = await asPartnerUser(scopedPartnerUser).put('/partner/ai/script-policy', { unattendedAllowed: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('full partner org access');
  });
  it('a partner admin may raise the ceiling', async () => {
    const res = await asPartnerUser(partnerAdmin).put('/partner/ai/script-policy', { unattendedAllowed: true, maxUnattendedRiskTier: 'medium' });
    expect(res.status).toBe(200);
    expect(upserted).toMatchObject({ partnerId: PARTNER, orgId: null, unattendedAllowed: true });
  });
  it('422 refuses to set unattendedEnabled on a PARTNER row (that is an org grant)', async () => {
    expect((await asPartnerUser(partnerAdmin).put('/partner/ai/script-policy', { unattendedEnabled: true })).status).toBe(422);
  });
  it('422 on a tier above the hard ceiling of medium', async () => {
    expect((await asPartnerUser(partnerAdmin).put('/partner/ai/script-policy', { maxUnattendedRiskTier: 'high' })).status).toBe(422);
  });
  it('GET returns the partner row with ownerScope partner', async () => {
    expect(await (await asPartnerUser(partnerAdmin).get('/partner/ai/script-policy')).json())
      .toMatchObject({ policy: { ownerScope: 'partner' } });
  });
  it('GET from another partner never sees this row', async () => {
    expect((await (await asPartnerUser(otherPartnerAdmin).get('/partner/ai/script-policy')).json()).policy).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/partnerAiScriptPolicy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

```ts
// apps/api/src/routes/partnerAiScriptPolicy.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { TOUCH_CLASSES } from '@breeze/shared';
import { db, withDbAccessContext } from '../db';
import { aiScriptPolicies } from '../db/schema/aiScriptPolicies';
import { requireAuth, type AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { createAuditLogAsync } from '../services/auditService';

/**
 * The partner CEILING. `unattended_allowed` lives only here, and
 * `unattended_enabled` deliberately does NOT: a partner enabling the lane for
 * every org under it in one write is precisely the blanket-enablement hazard
 * D10 splits the ceiling from the grant to prevent.
 *
 * `max_unattended_risk_tier` is capped at `medium` by the table's CHECK — a
 * high/critical script is never lane-eligible at any level (spec §4.6
 * invariant 3, "high/critical never").
 */
const partnerUpdateSchema = z.object({
  proposingEnabled: z.boolean().optional(),
  unattendedAllowed: z.boolean().optional(),
  maxUnattendedRiskTier: z.enum(['low', 'medium']).optional(),
  unattendedAllowedClasses: z.array(z.enum(TOUCH_CLASSES)).optional(),
  maxUnattendedPerHour: z.number().int().min(0).max(100).optional(),
  protectedResources: z.object({
    services: z.array(z.string()), paths: z.array(z.string()),
    registryKeys: z.array(z.string()), deviceTags: z.array(z.string()),
  }).optional(),
  reviewerModel: z.string().nullable().optional(),
}).strict();

export const partnerAiScriptPolicyRoutes = new Hono();

partnerAiScriptPolicyRoutes.get('/ai/script-policy', requireAuth, async (c) => {
  const auth = c.get('auth') as AuthContext;
  if (auth.scope !== 'partner' && auth.scope !== 'system') return c.json({ error: 'forbidden' }, 403);
  return withDbAccessContext(auth, async () => {
    const [policy] = await db.select().from(aiScriptPolicies)
      .where(and(isNull(aiScriptPolicies.orgId), eq(aiScriptPolicies.partnerId, auth.partnerId!)))
      .limit(1);
    return c.json({ policy: policy ? { ...policy, ownerScope: 'partner' as const } : null });
  });
});

partnerAiScriptPolicyRoutes.put('/ai/script-policy', requireAuth, async (c) => {
  const auth = c.get('auth') as AuthContext;
  // The SINGLE source of truth for partner-wide write authority.
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  const parsed = partnerUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'validation_failed', issues: parsed.error.issues }, 422);

  const row = await withDbAccessContext(auth, async () => {
    const [saved] = await db
      .insert(aiScriptPolicies)
      .values({ partnerId: auth.partnerId!, orgId: null, createdBy: auth.user!.id, ...parsed.data })
      .onConflictDoUpdate({
        target: aiScriptPolicies.partnerId,
        set: { ...parsed.data, updatedAt: new Date() },
      })
      .returning();
    return saved;
  });

  await createAuditLogAsync({
    orgId: null, actorType: 'user', actorId: auth.user!.id, actorEmail: auth.user!.email,
    action: 'ai.script_policy.partner_updated', resourceType: 'ai_script_policies', resourceId: row!.id,
    details: { ...parsed.data }, result: 'success', initiatedBy: 'manual',
  });
  return c.json({ policy: { ...row, ownerScope: 'partner' as const } });
});
```

The `.strict()` schema is what produces the 422 for `unattendedEnabled` — it is not a listed key, so the partner cannot set an org grant.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/partnerAiScriptPolicy.test.ts`
Expected: PASS (7 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/partnerAiScriptPolicy.ts apps/api/src/routes/partnerAiScriptPolicy.test.ts apps/api/src/routes/index.ts
git commit -m "feat(ai): partner ceiling route for the unattended script lane

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: Web — i18n keys, nav entry, page route

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` and `.../common.json`, `apps/web/src/components/layout/Sidebar.tsx:222-244`, `apps/web/src/components/layout/Sidebar.nav.test.tsx`
- Create: `apps/web/src/pages/settings/ai-script-authoring.astro`

**Interfaces:**
- Consumes: nothing.
- Produces: the `settings:scriptAuthoringPage.*` key tree, `common:nav.scriptAuthoring`, and the route `/settings/ai-script-authoring`.

**Translations must be REAL.** `localeParity.test.ts` compares flattened key sets across all locales and `translationCoverage.test.ts` caps how many values may be byte-identical to English. Copy-pasting the English strings into eight files will go red. Also: no template/dynamic keys — use a literal key map like `AiUsagePage.tsx:11-18`'s `PERIOD_LABEL_KEYS` for the per-class and per-tier labels.

- [ ] **Step 1: Write the failing nav test**

```tsx
// apps/web/src/components/layout/Sidebar.nav.test.tsx — append
  it('exposes Script authoring under the AI section, gated on ai_agents:read', () => {
    const ai = navSections.find((s) => s.id === 'ai')!;
    const item = ai.items.find((i) => i.href === '/settings/ai-script-authoring');
    expect(item).toMatchObject({
      labelKey: 'nav.scriptAuthoring',
      requiredPermission: { resource: 'ai_agents', action: 'read' },
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/layout/Sidebar.nav.test.tsx`
Expected: FAIL — `item` is `undefined`.

- [ ] **Step 3: Add the nav item**

```tsx
// apps/web/src/components/layout/Sidebar.tsx — inside the 'ai' section's items, after 'AI Usage & Budget'
      { name: 'Script authoring', labelKey: 'nav.scriptAuthoring', href: '/settings/ai-script-authoring', icon: FileCode, requiredPermission: { resource: 'ai_agents', action: 'read' } },
```

Import `FileCode` from `lucide-react`.

- [ ] **Step 4: Add the page route**

```astro
---
// apps/web/src/pages/settings/ai-script-authoring.astro
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import ScriptAuthoringPage from '../../components/settings/ScriptAuthoringPage';
---

<DashboardLayout title="Script authoring">
  <ScriptAuthoringPage client:load />
</DashboardLayout>
```

- [ ] **Step 5: Add the English keys, then translate them into the other eight locales**

```jsonc
// apps/web/src/locales/en/settings.json — new top-level object
"scriptAuthoringPage": {
  "title": "Script authoring",
  "subtitle": "Let the assistant and your agents write, review and — when you allow it — run scripts without a card.",
  "partnerCard": { "title": "Partner ceiling", "description": "The widest setting any organization under this partner may use. Individual organizations can only narrow it.", "readOnly": "Only a partner administrator with full organization access can change the ceiling." },
  "orgCard": { "title": "This organization", "description": "An explicit grant. The unattended lane stays off until both the partner ceiling and this switch allow it." },
  "fields": {
    "proposingEnabled": "Allow the AI to propose scripts",
    "unattendedAllowed": "Allow organizations to use the unattended lane",
    "unattendedEnabled": "Run approved low-risk scripts without an approval card",
    "maxRiskTier": "Highest risk tier allowed unattended",
    "allowedClasses": "What an unattended script may touch",
    "perHour": "Maximum unattended runs per hour",
    "reviewerModel": "Reviewer model",
    "protectedResources": "Never touch these"
  },
  "tier": { "low": "Low", "medium": "Medium" },
  "class": {
    "registry": "Registry", "services": "Services", "processes": "Processes",
    "files_system": "System files", "files_user": "User files", "temp_files": "Temporary files",
    "network_egress": "Outbound network", "firewall": "Firewall", "credentials": "Credentials",
    "users_groups": "Users and groups", "packages": "Packages", "scheduled_tasks": "Scheduled tasks",
    "disk": "Disk", "boot": "Boot configuration", "security_tooling": "Security tooling",
    "dns_cache": "DNS cache", "printing": "Printing", "browser": "Browsers", "shell_eval": "Dynamic code"
  },
  "hardDenied": "Never available unattended, whatever the ceiling says.",
  "aboveCeiling": "Your partner does not allow this.",
  "lane": {
    "closedTitle": "Unattended lane is running normally",
    "openTitle": "Unattended lane is paused",
    "openBody": "{{reason}} Unattended runs are refused until an approver resets the lane. Approvals still work normally.",
    "reset": "Reset the lane",
    "resetSuccess": "The unattended lane is running again.",
    "resetFailed": "The lane could not be reset."
  },
  "stepUp": { "title": "Confirm it is you", "body": "Enabling unattended runs needs a fresh security check." },
  "saved": "Script authoring settings saved.",
  "saveFailed": "Those settings could not be saved."
}
```

```jsonc
// apps/web/src/locales/en/common.json — under "nav"
"scriptAuthoring": "Script authoring",
```

Translate every one of these into `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` — real translations, and keep the `{{reason}}` interpolation token byte-identical in all of them (`localeParity.test.ts` compares tokens too). Consult `apps/web/src/locales/TERMINOLOGY.md` for the established renderings of "organization", "partner", "approval" and "agent".

- [ ] **Step 6: Run the i18n guards**

Run: `cd apps/web && npx vitest run src/lib/i18n src/components/layout/Sidebar.nav.test.tsx`
Expected: PASS — `localeParity`, `keyUsage`, `translationCoverage`, `terminologyQuality`, `extractionQuality`, and the nav test.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/locales apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.nav.test.tsx apps/web/src/pages/settings/ai-script-authoring.astro
git commit -m "feat(web): Script authoring settings route, nav entry and translations

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 24: Web — the Script authoring settings island

**Files:**
- Create: `apps/web/src/components/settings/ScriptAuthoringPage.tsx`, `apps/web/src/components/settings/ScriptAuthoringPage.test.tsx`

**Interfaces:**
- Consumes: `GET`/`PUT /ai/script-policy`, `GET`/`PUT /partner/ai/script-policy`, `POST /ai/script-lane/reset` (Tasks 21–22); `runAction` / `ActionError` (`apps/web/src/lib/runAction.ts`); `mintStepUpGrant` / `StepUpMintError` (`apps/web/src/lib/mfaStepUp.ts:64`), `StepUpPrompt` / `pickReauthTier` (`apps/web/src/components/settings/StepUpPrompt.tsx:8`, `:27`); `listField` / `numberField` (`apps/web/src/components/settings/aiAgents/agentFields.tsx:20`, `:53`).
- Produces: the page island.

**Reuse, don't invent.** The ceiling-aware multi-select already exists: `apps/web/src/components/settings/aiAgents/ScriptAuthorizationPicker.tsx` (238 lines) is a partner-ceiling-aware picker with `ceiling`, `ceilingResolved` and `ceilingUnavailable` props — mirror its disabled-with-reason treatment for the class allowlist. There is **no** standalone protected-resources editor component; the three-textarea fieldset at `SafetyStep.tsx:147-160` built from `listField` is the pattern, and `agentDraft.ts:150-152` / `:231` is the newline-split/join marshalling.

**All four mutations go through `runAction`** — the page's saves are in scope for `no-silent-mutations.test.ts`; do not copy `AiUsagePage.tsx:165-200`'s raw `fetchWithAuth` PUT, which predates the rule and is recorded as a legacy exception.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/settings/ScriptAuthoringPage.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, within, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const mintStepUpGrant = vi.fn();
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: (...a: unknown[]) => mintStepUpGrant(...a),
  StepUpMintError: class extends Error {},
}));
import ScriptAuthoringPage from './ScriptAuthoringPage';

// Scope every query to THIS render's container (#4601).
function renderPage() {
  const { container, ...u } = render(<ScriptAuthoringPage />);
  return { container, ...u, ...within(container) };
}
function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const ORG_POLICY = { policy: { ownerScope: 'organization', proposingEnabled: true, unattendedEnabled: false, maxUnattendedRiskTier: 'low', unattendedAllowedClasses: ['services'], maxUnattendedPerHour: 4, protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] }, reviewerModel: null },
  effective: { unattendedEnabled: false, maxUnattendedRiskTier: 'low', unattendedAllowedClasses: ['services', 'processes', 'temp_files', 'dns_cache', 'printing'], maxUnattendedPerHour: 10 },
  laneState: { state: 'closed', consecutiveFailedVerifications: 0, openedAt: null, openedReason: null, resetAt: null } };
const PARTNER_POLICY = { policy: { ownerScope: 'partner', unattendedAllowed: true, maxUnattendedRiskTier: 'medium', unattendedAllowedClasses: ['services', 'processes', 'temp_files', 'dns_cache', 'printing'], maxUnattendedPerHour: 10 } };

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation((url: string) =>
    Promise.resolve(jsonRes(url.startsWith('/partner') ? PARTNER_POLICY : ORG_POLICY)));
  mintStepUpGrant.mockResolvedValue('grant-1');
});
afterEach(() => vi.clearAllMocks());

describe('ScriptAuthoringPage', () => {
  it('renders the partner ceiling card and the org grant card', async () => {
    const p = renderPage();
    await waitFor(() => expect(p.getByTestId('script-authoring-partner-card')).toBeTruthy());
    expect(p.getByTestId('script-authoring-org-card')).toBeTruthy();
  });

  it('disables a class the partner ceiling does not allow, and says why', async () => {
    fetchWithAuth.mockImplementation((url: string) => Promise.resolve(jsonRes(
      url.startsWith('/partner')
        ? { policy: { ...PARTNER_POLICY.policy, unattendedAllowedClasses: ['services'] } }
        : { ...ORG_POLICY, effective: { ...ORG_POLICY.effective, unattendedAllowedClasses: ['services'] } })));
    const p = renderPage();
    await waitFor(() => expect(p.getByTestId('script-class-printing')).toBeTruthy());
    expect((p.getByTestId('script-class-printing') as HTMLInputElement).disabled).toBe(true);
    expect(p.getByTestId('script-class-printing-reason').textContent).toContain('partner');
  });

  it('never offers a hard-denied class as selectable', async () => {
    const p = renderPage();
    await waitFor(() => expect(p.getByTestId('script-authoring-org-card')).toBeTruthy());
    expect((p.getByTestId('script-class-credentials') as HTMLInputElement).disabled).toBe(true);
  });

  it('mints a step-up grant before enabling, and sends it with the PUT', async () => {
    const p = renderPage();
    await waitFor(() => expect(p.getByTestId('script-unattended-enabled')).toBeTruthy());
    fireEvent.click(p.getByTestId('script-unattended-enabled'));
    fireEvent.click(p.getByTestId('script-authoring-save'));
    await waitFor(() => expect(mintStepUpGrant).toHaveBeenCalledWith(expect.objectContaining({ operation: 'ai_script_lane_grant' })));
    const put = fetchWithAuth.mock.calls.find(([u, o]) => u === '/ai/script-policy' && (o as RequestInit)?.method === 'PUT')!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toMatchObject({ unattendedEnabled: true, stepUpGrant: 'grant-1' });
  });

  it('does NOT mint a grant when turning the lane off', async () => {
    fetchWithAuth.mockImplementation((url: string) => Promise.resolve(jsonRes(
      url.startsWith('/partner') ? PARTNER_POLICY : { ...ORG_POLICY, policy: { ...ORG_POLICY.policy, unattendedEnabled: true } })));
    const p = renderPage();
    await waitFor(() => expect(p.getByTestId('script-unattended-enabled')).toBeTruthy());
    fireEvent.click(p.getByTestId('script-unattended-enabled'));
    fireEvent.click(p.getByTestId('script-authoring-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/script-policy', expect.objectContaining({ method: 'PUT' })));
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('shows the paused banner with the reason and a reset button when the lane is open', async () => {
    fetchWithAuth.mockImplementation((url: string) => Promise.resolve(jsonRes(
      url.startsWith('/partner') ? PARTNER_POLICY
        : { ...ORG_POLICY, laneState: { state: 'open', consecutiveFailedVerifications: 2, openedAt: new Date().toISOString(), openedReason: '2 consecutive failed or unknown verifications (threshold 2)', resetAt: null } })));
    const p = renderPage();
    await waitFor(() => expect(p.getByTestId('script-lane-banner')).toBeTruthy());
    expect(p.getByTestId('script-lane-banner').textContent).toContain('threshold 2');
    expect(p.getByTestId('script-lane-reset')).toBeTruthy();
  });

  it('hides the reset button when the lane is closed', async () => {
    const p = renderPage();
    await waitFor(() => expect(p.getByTestId('script-authoring-org-card')).toBeTruthy());
    expect(p.queryByTestId('script-lane-reset')).toBeNull();
  });

  it('surfaces a save failure instead of failing silently', async () => {
    fetchWithAuth.mockImplementation((url: string, o?: RequestInit) =>
      o?.method === 'PUT'
        ? Promise.resolve(jsonRes({ error: 'above_partner_ceiling', field: 'maxUnattendedPerHour' }, 422))
        : Promise.resolve(jsonRes(url.startsWith('/partner') ? PARTNER_POLICY : ORG_POLICY)));
    const p = renderPage();
    await waitFor(() => expect(p.getByTestId('script-authoring-save')).toBeTruthy());
    fireEvent.click(p.getByTestId('script-authoring-save'));
    await waitFor(() => expect(p.getByTestId('script-authoring-error')).toBeTruthy());
  });

  it('renders the partner card read-only for an org-scoped user', async () => {
    const p = renderPage();
    await waitFor(() => expect(p.getByTestId('script-authoring-partner-card')).toBeTruthy());
    expect(p.queryByTestId('script-partner-save')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run src/components/settings/ScriptAuthoringPage.test.tsx`
Expected: FAIL — `Cannot find module './ScriptAuthoringPage'`.

- [ ] **Step 3: Build the island**

Structure (mirroring `AiUsagePage.tsx`'s island shape: `import '@/lib/i18n'`, `useTranslation('settings')`, local `useState` + `useEffect` load, no react-query):

```tsx
// apps/web/src/components/settings/ScriptAuthoringPage.tsx — shape
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useState } from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { mintStepUpGrant, StepUpMintError } from '../../lib/mfaStepUp';
import StepUpPrompt, { pickReauthTier } from './StepUpPrompt';
import { listField, numberField } from './aiAgents/agentFields';

/** Literal keys so the i18n key scanner can see them — a t(`class.${c}`)
 *  template is a dynamic key it cannot check (AiUsagePage.tsx:11-18). */
const CLASS_LABEL_KEYS = {
  registry: 'scriptAuthoringPage.class.registry',
  services: 'scriptAuthoringPage.class.services',
  // … one literal per TOUCH_CLASS …
} as const;

/** Mirrors LANE_HARD_DENIED_CLASSES server-side. Rendered disabled with a
 *  reason rather than hidden: an operator who expects to find `credentials`
 *  here should be told it is never available, not left hunting. */
const HARD_DENIED = new Set(['credentials', 'security_tooling', 'boot', 'disk', 'shell_eval', 'users_groups', 'firewall']);
```

Behaviour the tests pin:
- Load `GET /ai/script-policy` and `GET /partner/ai/script-policy` in one `Promise.all`; a 403 on the partner call is expected for an org-scoped user and renders the ceiling **read-only** from the org response's `effective` block rather than erroring.
- A class checkbox is `disabled` when it is hard-denied **or** absent from `effective.unattendedAllowedClasses`, with a `-reason` element naming which.
- Save wraps the PUT in `runAction({ request, errorFallback: t('scriptAuthoringPage.saveFailed'), successMessage: t('scriptAuthoringPage.saved') })`; the catch follows the repo pattern:
  ```ts
  catch (err) {
    if (err instanceof ActionError && err.status === 401) return; // let auth redirect handle it
    if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('scriptAuthoringPage.saveFailed') });
    setError(err instanceof Error ? err.message : String(err));
  }
  ```
- Enabling mints the grant **first** (`operation: 'ai_script_lane_grant'`, `resource: { orgId, unattendedEnabled: true }`) and only then PUTs; disabling skips it entirely.
- The lane banner renders only when `laneState.state === 'open'`, carries `openedReason` through the `{{reason}}` interpolation, and its reset button POSTs `/ai/script-lane/reset` through `runAction` with its own freshly minted grant.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/settings/ScriptAuthoringPage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS (9 + the mutation guard).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/ScriptAuthoringPage.tsx apps/web/src/components/settings/ScriptAuthoringPage.test.tsx
git commit -m "feat(web): Script authoring settings page with ceiling-aware controls and lane banner

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 25: Live-DB — RLS forge, XOR, partner-wide visibility, cascade, export, merge

**Files:**
- Create: `apps/api/src/__tests__/integration/aiScriptPoliciesPartnerRls.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: the functional proof CLAUDE.md's step 6 demands — *"forge a cross-tenant insert — must fail with `new row violates row-level security policy`"* — as an automated suite rather than a one-off psql session.

**These assertions cannot pass in the unit job.** The suite needs real Postgres and the real `breeze_app` (NOBYPASSRLS) driver; it belongs in `vitest.integration.config.ts`'s `include` and `vitest.config.ts`'s `exclude`. **Miss either edit and it silently never runs in CI, or reds the no-DB unit job on ECONNREFUSED.**

- [ ] **Step 1: Write the suite**

```ts
// apps/api/src/__tests__/integration/aiScriptPoliciesPartnerRls.integration.test.ts
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getAppDb, getTestDb } from './setup';
import { createOrganization, createPartner, createUser, assignUserToOrganization } from './helpers';

describe('ai_script_policies / ai_script_lane_state — live RLS', () => {
  let partnerA: string, partnerB: string, orgA: string, orgB: string;
  beforeEach(async () => {
    partnerA = await createPartner(); partnerB = await createPartner();
    orgA = await createOrganization(partnerA); orgB = await createOrganization(partnerB);
  });

  const asOrg = (orgId: string, partnerId: string) => async (fn: (db: ReturnType<typeof getAppDb>) => Promise<unknown>) => {
    const db = getAppDb();
    await db.execute(sql`select set_config('breeze.scope','organization',true),
                                set_config('breeze.accessible_org_ids', ${orgId}, true),
                                set_config('breeze.current_partner_id', ${partnerId}, true)`);
    return fn(db);
  };

  it('FORGE: org B cannot insert a policy row for org A (42501)', async () => {
    await expect(asOrg(orgB, partnerB)((db) =>
      db.execute(sql`insert into ai_script_policies (org_id) values (${orgA})`),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('FORGE: org A cannot insert a PARTNER-wide row for its own partner (writes need partner scope)', async () => {
    await expect(asOrg(orgA, partnerA)((db) =>
      db.execute(sql`insert into ai_script_policies (partner_id) values (${partnerA})`),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('XOR: both axes set is 23514', async () => {
    await expect(getTestDb().execute(
      sql`insert into ai_script_policies (org_id, partner_id) values (${orgA}, ${partnerA})`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('XOR: neither axis set is 23514', async () => {
    await expect(getTestDb().execute(sql`insert into ai_script_policies default values`))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('CHECK: an org row cannot carry unattended_allowed (that is a partner ceiling)', async () => {
    await expect(getTestDb().execute(
      sql`insert into ai_script_policies (org_id, unattended_allowed) values (${orgA}, true)`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('CHECK: a partner row cannot carry unattended_enabled (that is an org grant)', async () => {
    await expect(getTestDb().execute(
      sql`insert into ai_script_policies (partner_id, unattended_enabled) values (${partnerA}, true)`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('CHECK: high/critical is not a storable ceiling', async () => {
    await expect(getTestDb().execute(
      sql`insert into ai_script_policies (partner_id, max_unattended_risk_tier) values (${partnerA}, 'high')`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('CHECK: an unknown touch class is not storable', async () => {
    await expect(getTestDb().execute(
      sql`insert into ai_script_policies (partner_id, unattended_allowed_classes) values (${partnerA}, ARRAY['not_a_class']::text[])`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('PARTNER-WIDE SELECT: an ORG token sees its own partner\'s ceiling row', async () => {
    await getTestDb().execute(sql`insert into ai_script_policies (partner_id, unattended_allowed) values (${partnerA}, true)`);
    const rows = await asOrg(orgA, partnerA)((db) =>
      db.execute(sql`select id from ai_script_policies where org_id is null`)) as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('PARTNER-WIDE SELECT: an org under a DIFFERENT partner sees nothing', async () => {
    await getTestDb().execute(sql`insert into ai_script_policies (partner_id, unattended_allowed) values (${partnerA}, true)`);
    const rows = await asOrg(orgB, partnerB)((db) =>
      db.execute(sql`select id from ai_script_policies where org_id is null`)) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('PARTNER-WIDE SELECT is READ ONLY: an org token cannot UPDATE the ceiling row', async () => {
    await getTestDb().execute(sql`insert into ai_script_policies (partner_id, unattended_allowed) values (${partnerA}, true)`);
    const res = await asOrg(orgA, partnerA)((db) =>
      db.execute(sql`update ai_script_policies set unattended_allowed = false where org_id is null returning id`)) as unknown[];
    // Postgres never consults FOR SELECT policies when computing UPDATE
    // targets, so this matches ZERO rows rather than raising. Either outcome
    // is acceptable; silently succeeding is not.
    expect(res).toHaveLength(0);
  });

  it('PARTNER-WIDE SELECT is READ ONLY: an org token cannot DELETE the ceiling row', async () => {
    await getTestDb().execute(sql`insert into ai_script_policies (partner_id, unattended_allowed) values (${partnerA}, true)`);
    const res = await asOrg(orgA, partnerA)((db) =>
      db.execute(sql`delete from ai_script_policies where org_id is null returning id`)) as unknown[];
    expect(res).toHaveLength(0);
  });

  it('FORGE: org B cannot read or write org A\'s lane state', async () => {
    await getTestDb().execute(sql`insert into ai_script_lane_state (org_id, state) values (${orgA}, 'open')`);
    const rows = await asOrg(orgB, partnerB)((db) =>
      db.execute(sql`select org_id from ai_script_lane_state`)) as unknown[];
    expect(rows).toHaveLength(0);
    await expect(asOrg(orgB, partnerB)((db) =>
      db.execute(sql`insert into ai_script_lane_state (org_id) values (${orgA})`),
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('CASCADE: deleting the org removes its grant row and its lane state, and leaves the partner ceiling', async () => {
    await getTestDb().execute(sql`insert into ai_script_policies (partner_id, unattended_allowed) values (${partnerA}, true)`);
    await getTestDb().execute(sql`insert into ai_script_policies (org_id, unattended_enabled) values (${orgA}, true)`);
    await getTestDb().execute(sql`insert into ai_script_lane_state (org_id) values (${orgA})`);
    await eraseOrganization(orgA);
    expect(await countRows('ai_script_policies', sql`org_id = ${orgA}`)).toBe(0);
    expect(await countRows('ai_script_lane_state', sql`org_id = ${orgA}`)).toBe(0);
    expect(await countRows('ai_script_policies', sql`partner_id = ${partnerA}`)).toBe(1);
  });

  it('EXPORT: the org export carries the grant row and the lane state, and never the jsonb columns', async () => {
    await getTestDb().execute(sql`insert into ai_script_policies (org_id, unattended_enabled) values (${orgA}, true)`);
    const bundle = await exportOrganization(orgA);
    expect(bundle.tables.ai_script_policies?.[0]).toHaveProperty('unattended_enabled', true);
    expect(bundle.tables.ai_script_policies?.[0]).not.toHaveProperty('protected_resources');
    expect(bundle.tables).toHaveProperty('ai_script_lane_state');
  });

  it('MERGE: the loser org\'s grant row repoints and its lane state is left for erasure', async () => {
    const survivor = await createOrganization(partnerA);
    await getTestDb().execute(sql`insert into ai_script_policies (org_id, unattended_enabled) values (${orgA}, true)`);
    await getTestDb().execute(sql`insert into ai_script_lane_state (org_id, consecutive_failed_verifications) values (${orgA}, 1)`);
    await mergeOrganizations({ loser: orgA, survivor });
    expect(await countRows('ai_script_policies', sql`org_id = ${survivor}`)).toBe(1);
    expect(await countRows('ai_script_lane_state', sql`org_id = ${survivor}`)).toBe(0);
  });
});
```

- [ ] **Step 2: Register the file in BOTH vitest configs**

```ts
// apps/api/vitest.integration.config.ts — include
  'src/__tests__/integration/aiScriptPoliciesPartnerRls.integration.test.ts',
// apps/api/vitest.config.ts — exclude
  'src/__tests__/integration/aiScriptPoliciesPartnerRls.integration.test.ts',
```

- [ ] **Step 3: Run it against a real database**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiScriptPoliciesPartnerRls.integration.test.ts
```
Expected: PASS (16 cases). **Confirm the file actually RAN** — read the reported file count, not just the green tick; an integration test in the wrong place reports zero jobs and looks green.

- [ ] **Step 4: If the merge test fails on the partial unique index**

`ai_script_policies_org_uq` means a survivor that already owns a grant row collides on the repoint. If that happens, change the `orgMergeRegistry` entry from `REPOINT_TABLES` to:

```ts
  ai_script_policies: { kind: 'repoint-dedupe', key: ['org_id'], keyWhere: 'org_id IS NOT NULL' },
```

and add the covering case:

```ts
  it('MERGE: a survivor that ALREADY has a grant row keeps its own, and the loser\'s is dropped', async () => {
    const survivor = await createOrganization(partnerA);
    await getTestDb().execute(sql`insert into ai_script_policies (org_id, max_unattended_per_hour) values (${survivor}, 2)`);
    await getTestDb().execute(sql`insert into ai_script_policies (org_id, max_unattended_per_hour) values (${orgA}, 9)`);
    await mergeOrganizations({ loser: orgA, survivor });
    const rows = await selectRows('ai_script_policies', sql`org_id = ${survivor}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.max_unattended_per_hour).toBe(2);
  });
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/aiScriptPoliciesPartnerRls.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "test(ai): live-DB RLS, XOR, partner-wide, cascade, export and merge proofs for the lane tables

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 26: Live-DB — the hourly cap holds under a concurrent race

**Files:**
- Create: `apps/api/src/services/actionIntents/scriptLaneHourlyCap.integration.test.ts`

**Interfaces:**
- Consumes: `createActionIntent` (Task 15), `lockScriptLane` / `countRecentLaneIntents` (Task 11).
- Produces: the proof that spec §4.6 invariant 12's reservation is a reservation and not a count-then-write.

**Why a mocked test cannot do this.** The whole point of `pg_advisory_xact_lock` is behaviour across *concurrent transactions*; a Drizzle mock has one. Harness to copy: `apps/api/src/services/actionIntents/createIntentAtomicity.integration.test.ts` — same `import '../../__tests__/integration/setup'`, same `getAppDb`/`getTestDb` split, same org/partner/user fixture helpers, and the same dual hand-listing in both vitest configs.

- [ ] **Step 1: Write the race test**

```ts
// apps/api/src/services/actionIntents/scriptLaneHourlyCap.integration.test.ts
import '../../__tests__/integration/setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { actionIntents } from '../../db/schema';
import { createActionIntent } from './intentService';
// … fixtures: partner + org + user with run_script permission, a partner
// ceiling row (unattended_allowed, per hour 3) and an org grant row …

const CAP = 3;
const N = 8;

describe('unattended lane hourly cap under concurrency', () => {
  it('exactly CAP of N concurrent lane requests are approved; the rest fall to the human path', async () => {
    // N DISTINCT proposals, all reviewed and lane-eligible, so the only thing
    // that can refuse them is the cap itself.
    const proposals = await seedReviewedProposals(N, { orgId, deviceId, touchClasses: ['temp_files'] });

    const results = await Promise.all(proposals.map((p) =>
      createActionIntent(auth, {
        toolName: 'run_script',
        input: { proposalId: p.id, deviceIds: [deviceId] },
        source: 'chat',
        orgId,
      }).catch((e) => ({ error: String(e) }))));

    const approved = results.filter((r) => 'status' in r && r.status === 'approved');
    const pending = results.filter((r) => 'status' in r && r.status === 'pending_approval');
    expect(approved).toHaveLength(CAP);
    expect(pending).toHaveLength(N - CAP);

    // And the database agrees — no over-admission survived the commit.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(actionIntents)
      .where(and(eq(actionIntents.orgId, orgId), eq(actionIntents.decidedVia, 'script_reviewer')));
    expect(n).toBe(CAP);
  });

  it('every refused request records hourly_cap as its reason, not a generic denial', async () => {
    const refused = await db
      .select({ result: actionIntents.result })
      .from(actionIntents)
      .where(and(eq(actionIntents.orgId, orgId), eq(actionIntents.status, 'pending_approval')));
    expect(refused.every((r) => (r.result as { scriptLaneRefusal?: string } | null)?.scriptLaneRefusal === 'hourly_cap')).toBe(true);
  });

  it('a proposal consumed by one intent cannot be consumed by a second (one live run per proposal)', async () => {
    const p = (await seedReviewedProposals(1, { orgId, deviceId, touchClasses: ['temp_files'] }))[0]!;
    const [a, b] = await Promise.allSettled([
      createActionIntent(auth, { toolName: 'run_script', input: { proposalId: p.id, deviceIds: [deviceId] }, source: 'chat', orgId }),
      createActionIntent(auth, { toolName: 'run_script', input: { proposalId: p.id, deviceIds: [deviceId] }, source: 'chat', orgId }),
    ]);
    const approvals = [a, b].filter((r) => r.status === 'fulfilled' && (r.value as { status: string }).status === 'approved');
    expect(approvals).toHaveLength(1);
  });

  it('the cap counts PENDING lane intents too — an undispatched admission still holds a slot', async () => {
    // Insert CAP lane intents that are approved but not yet executed, then
    // prove the next request is refused even though nothing has run.
    const extra = (await seedReviewedProposals(1, { orgId, deviceId, touchClasses: ['temp_files'] }))[0]!;
    const res = await createActionIntent(auth, { toolName: 'run_script', input: { proposalId: extra.id, deviceIds: [deviceId] }, source: 'chat', orgId });
    expect(res.status).toBe('pending_approval');
  });

  it('an intent created 61 minutes ago no longer holds a slot', async () => {
    await db.execute(sql`update action_intents set created_at = now() - interval '61 minutes'
                         where org_id = ${orgId} and decided_via = 'script_reviewer'`);
    const p = (await seedReviewedProposals(1, { orgId, deviceId, touchClasses: ['temp_files'] }))[0]!;
    const res = await createActionIntent(auth, { toolName: 'run_script', input: { proposalId: p.id, deviceIds: [deviceId] }, source: 'chat', orgId });
    expect(res.status).toBe('approved');
  });
});
```

- [ ] **Step 2: Register it in BOTH vitest configs**

```ts
// apps/api/vitest.integration.config.ts — include
  'src/services/actionIntents/scriptLaneHourlyCap.integration.test.ts',
// apps/api/vitest.config.ts — exclude
  'src/services/actionIntents/scriptLaneHourlyCap.integration.test.ts',
```

- [ ] **Step 3: Prove the test can FAIL before trusting it passes**

```bash
pnpm test-stack up
# Temporarily comment out the `await lockScriptLane(...)` line in
# scriptReviewerAutonomy.ts and run the suite. It MUST go red (more than CAP
# approved). A race test that passes with the lock removed is testing nothing.
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/actionIntents/scriptLaneHourlyCap.integration.test.ts
# Restore the line and run again.
```
Expected: RED without the lock, GREEN with it. Record both outcomes in the PR body.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/actionIntents/scriptLaneHourlyCap.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts
git commit -m "test(ai): live-DB race proving the lane hourly cap reserves under the advisory lock

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 27: E2E — a whole unattended run, end to end

**Files:**
- Create: `e2e-tests/tests/ai-script-unattended-lane.spec.ts`, `e2e-tests/pages/ScriptAuthoringPage.ts`

**Interfaces:**
- Consumes: the full W01–W04 stack running under `pnpm wt-stack up`.
- Produces: the acceptance proof that the lane runs a script with no card and leaves the circuit closed.

**Conventions.** Specs query the DOM through `data-testid` **only** — never text, role or CSS (`e2e-tests/README.md`). Page Objects live under `e2e-tests/pages/`. Run from outside the pnpm workspace: `cd e2e-tests && pnpm test --ignore-workspace`.

- [ ] **Step 1: Write the page object**

```ts
// e2e-tests/pages/ScriptAuthoringPage.ts
import type { Page } from '@playwright/test';

export class ScriptAuthoringPage {
  constructor(private readonly page: Page) {}
  async goto() {
    await this.page.goto('/settings/ai-script-authoring');
    // Astro islands hydrate AFTER navigation resolves; filling before that
    // silently drops the input and the form never submits.
    await this.page.waitForSelector('[data-testid="script-authoring-org-card"]');
  }
  classCheckbox(cls: string) { return this.page.getByTestId(`script-class-${cls}`); }
  get enableToggle() { return this.page.getByTestId('script-unattended-enabled'); }
  get save() { return this.page.getByTestId('script-authoring-save'); }
  get laneBanner() { return this.page.getByTestId('script-lane-banner'); }
}
```

- [ ] **Step 2: Write the spec**

```ts
// e2e-tests/tests/ai-script-unattended-lane.spec.ts
import { test, expect } from '@playwright/test';
import { ScriptAuthoringPage } from '../pages/ScriptAuthoringPage';

test.describe('AI script authoring — unattended lane', () => {
  test('a granted org runs a low-risk single-device proposal with no approval card', async ({ page, request }) => {
    // 1. Partner raises the ceiling, org accepts the grant (MFA step-up).
    await seedPartnerCeiling(request, { unattendedAllowed: true, maxUnattendedRiskTier: 'low', unattendedAllowedClasses: ['services', 'temp_files'] });
    const settings = new ScriptAuthoringPage(page);
    await settings.goto();
    await settings.enableToggle.click();
    await completeStepUp(page);
    await settings.save.click();
    await expect(page.getByTestId('script-authoring-saved')).toBeVisible();

    // 2. Ask the assistant for a script it has to write.
    await page.goto('/workspace');
    await page.getByTestId('ai-chat-input').fill('Clear the temp files on WIN-E2E-01 and confirm they are gone.');
    await page.getByTestId('ai-chat-send').click();

    // 3. NO approval card. This is the assertion the whole wave exists for.
    await expect(page.getByTestId('ai-approval-dialog')).toHaveCount(0);
    await expect(page.getByTestId('ai-unattended-release')).toBeVisible({ timeout: 90_000 });

    // 4. The run executes and verifies.
    await expect(page.getByTestId('ai-script-execution-result')).toContainText('exit');
    await expect(page.getByTestId('ai-script-verification')).toHaveAttribute('data-outcome', 'verified', { timeout: 120_000 });

    // 5. The lane is still closed and the counter is still zero.
    await settings.goto();
    await expect(settings.laneBanner).toHaveCount(0);
  });

  test('with the grant OFF the same request produces an approval card', async ({ page, request }) => {
    await seedPartnerCeiling(request, { unattendedAllowed: true });
    await setOrgGrant(request, { unattendedEnabled: false });
    await page.goto('/workspace');
    await page.getByTestId('ai-chat-input').fill('Clear the temp files on WIN-E2E-01 and confirm they are gone.');
    await page.getByTestId('ai-chat-send').click();
    await expect(page.getByTestId('ai-approval-dialog')).toBeVisible({ timeout: 90_000 });
  });

  test('an open lane refuses and shows the reset control', async ({ page, request }) => {
    await forceLaneOpen(request);
    const settings = new ScriptAuthoringPage(page);
    await settings.goto();
    await expect(settings.laneBanner).toBeVisible();
    await expect(page.getByTestId('script-lane-reset')).toBeVisible();
  });
});
```

- [ ] **Step 3: Run it**

```bash
pnpm wt-stack up          # a private seeded stack for this worktree
cd e2e-tests && pnpm test --ignore-workspace tests/ai-script-unattended-lane.spec.ts
pnpm wt-stack down        # nothing reaps it for you
```
Expected: PASS. If the first test times out at `waitForURL`, it is the Astro hydration race — wait on the testid, not a bigger timeout.

- [ ] **Step 4: Commit**

```bash
git add e2e-tests/tests/ai-script-unattended-lane.spec.ts e2e-tests/pages/ScriptAuthoringPage.ts
git commit -m "test(e2e): unattended script lane runs without an approval card

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 28: Release notes, full-suite sweep, PR

**Files:**
- Modify: `docs/release-notes/next-release-draft.md`

**Interfaces:**
- Consumes: every earlier task.
- Produces: a merged wave.

- [ ] **Step 1: Append the release-notes entry**

W04 is the wave that makes the behaviour user-visible, so the entry lands here (roadmap §4).

```markdown
## AI script authoring — unattended lane (#5612)

The AI assistant and background agents can now run a script they wrote **without
an approval card**, but only when an MSP partner opens the ceiling *and* the
individual organization opts in. Both are off by default and there is **no env
flag** — nothing changes for an existing deployment until someone turns it on in
**Settings → AI → Script authoring**.

When enabled, a proposal is released unattended only if it clears all fourteen
gates: a completed independent model review at or below the allowed risk tier,
an unqualified approve verdict, no strict-pattern hits, a deterministic touch
classification inside the allowed class list (never credentials, security
tooling, boot, disk, dynamic code, users/groups or firewall), no protected
resource, a timeout of 300s or less, supervised scope, exactly one online device
outside a maintenance window, an hourly quota, a live permission or agent-policy
check, and — on Windows, for registry/service/system-file changes — a System
Restore checkpoint taken before dispatch. **On Linux and macOS those three
classes are not lane-eligible in v1**, because no restore checkpoint can be
taken; those runs still go to a human.

Two consecutive unverified unattended runs pause the lane for the whole
organization until an approver with `approvals:decide` resets it.

**New audit actions:** `ai.script.unattended_run`, `ai.script.unattended_verified`,
`ai.script.unattended_failed`, `ai.script_lane.opened`, `ai.script_lane.reset`,
`ai.script_policy.updated`, `ai.script_policy.partner_updated`.

**New tables:** `ai_script_policies`, `ai_script_lane_state`. **New column:**
`action_intents.script_reviewer_evidence`. **Migrations:**
`2026-10-16-110000-ai-script-policies.sql`,
`2026-10-16-110100-action-intents-script-reviewer.sql`.
```

- [ ] **Step 2: Run every suite this wave touched**

```bash
pnpm --filter @breeze/api test --run \
  src/services/actionIntents src/services/scriptProposals src/services/aiGuardrails \
  src/services/deviceRecovery src/routes/ai src/routes/partnerAiScriptPolicy \
  src/db/schema src/db/migration-action-intents.test.ts src/db/autoMigrate.test.ts \
  src/db/migrationRlsScope.test.ts src/jobs/intentReleaseWorker
pnpm --filter @breeze/web test --run src/components/settings src/components/layout src/lib
pnpm --filter @breeze/shared test --run
pnpm lint
```

- [ ] **Step 3: Run the contract suites against a real database**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts \
  src/__tests__/integration/aiScriptPoliciesPartnerRls.integration.test.ts \
  src/services/actionIntents/scriptLaneHourlyCap.integration.test.ts
pnpm test-stack down
```
Expected: all green. **Local unit-green is not CI-green** — four of these only ever fail under Integration Tests.

- [ ] **Step 4: Re-verify the migration names against the remote**

```bash
git fetch origin main --quiet
bash scripts/check-migration-naming.sh --against-ref origin/main
# If main gained a migration that sorts after 2026-10-16-110100, rename BOTH
# files, sweep every readFileSync reference, and re-run autoMigrate.test.ts.
```

- [ ] **Step 5: One review round**

Per CLAUDE.md's model routing, this wave touches tenancy **and** an authorization boundary, so the review is Sonnet (precision) plus Codex `medium` in parallel, orchestrator arbitrates. Act only on confirmed, consequential findings; re-review a fix only if the fix itself touched tenancy, auth, or the release path. Record the round in the PR body.

- [ ] **Step 6: Merge main, push, open the PR**

```bash
git fetch origin main && git merge origin/main   # PR CI tests the MERGE commit
pnpm --filter @breeze/api test --run src/services/actionIntents   # re-verify post-merge
git add docs/release-notes/next-release-draft.md && git commit -m "docs: release note for the unattended AI script lane

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --base main --title "feat(ai): W04 — reviewer-gated unattended script lane" --body "…Closes #<W04 sub-issue>…"
```

PR body must record: the review round, the RED-without-the-lock result from Task 26 Step 3, the four Integration-Tests-only suites run locally, and the two open questions below.

- [ ] **Step 7: Enqueue (never `--admin`)**

```bash
gh pr merge <N>          # the merge queue owns the strategy and rebuilds on top of main
```

Then `complete_wave` for the W04 sub-issue.

---

## Self-review

Run against the spec with fresh eyes.

**1. Spec coverage.**

| Spec section | Task |
|---|---|
| §4.1 `ai_script_policies` (ceiling vs grant columns) | 1, 3, 5, 21, 22 |
| §4.1 `ai_script_lane_state` (shape 1, PK org_id, opens at 2) | 1, 3, 19 |
| §4.6 seam inside `createActionIntent` under the advisory lock | 11, 15 |
| §4.6 invariants 1–14, in order, first failure wins | 9, 10, 11, 12, 13 |
| §4.6 decision record (`decided_via`, lease, no approval rows, outbox, CAS consume) | 15 |
| §4.6 release (`isSystemDecided`, no-approval-row exception both origins, `lane_revoked`) | 14, 16 |
| §4.6 checkpoint read back before dispatch | 17 |
| §4.6 after execution (circuit, audit, agent circuit, notify) | 19 |
| §4.6 audit `ai.script.unattended_run` | 20 |
| §5 registration (cascade, export incl. the new column, dual-axis lists, merge) | 4, 25 |
| §6 failure modes (TOCTOU, authority change, concurrent cap, runaway) | 14, 16, 17, 26 |
| §7 contract + live-DB tests for the lane | 9–14, 25, 26 |
| §8 W04 scope (policy tables, resolver, settings UI, evidence column, evaluator, release branch, hourly reservation, checkpoint, audit) | all |
| §10 checkpoint primitive open item | 7 (resolved: implemented server-side on the `script` primitive) |
| Roadmap §3.6 exact names | 5, 9, 14 |

No spec requirement is unassigned.

**2. Placeholder scan.** No "TBD", no "add error handling", no "write tests for the above", no "similar to Task N". Every code step carries real code; the two places that describe behaviour rather than showing it (Task 24 Step 3's island body, Task 26's fixture helpers) both pin the exact behaviour through the failing tests written first, and name the file:line of the pattern to copy.

**3. Type consistency.** `EffectiveScriptPolicy` / `resolveEffectiveScriptPolicy` (Task 5) are consumed under those exact names in Tasks 6, 9, 14, 21. `ScriptReviewerRefusal` / `ScriptReviewerEvidence` / `evaluateScriptReviewerAutonomy` / `revalidateScriptReviewerEvidence` match roadmap §3.6 character for character. `ensureRestoreCheckpoint` returns `{ ok, checkpointRef }` in Task 7 and is destructured that way in Tasks 11 and 17. `laneQueries`' four exports are mocked under the same names in Tasks 9–13's tests. `onUnattendedVerificationOutcome` matches roadmap §3.5's name. `touchesProtectedNames` (Task 8) is called with the same `{ services, paths, registryKeys }` shape `ScriptScanResult.touchedNames` provides (roadmap §3.1).

**Two deliberate deviations from the brief, both argued in place:**
- **No `autonomy_refusal` column.** `action_intents.result` already carries the twin breadcrumb (`intentService.ts:1585`); a new column would add a `CORE_TENANT_EXPORT_POLICY` classification for nothing (Task 15).
- **`errorCode: 'lane_revoked'` + `details.reason`**, not a `failed:lane_revoked:<reason>` string. That notation exists only in prose comments in this repo; the mechanism is `failIntent(intent, errorCode, { details })` (Task 16).

---

## Open questions (batched, none blocking)

1. **The restore checkpoint has no first-class device command.** Task 7 implements it on the existing `script` primitive with a fixed PowerShell body, which needs no agent change and lands inside W04. A first-class `create_restore_point` command (agent constant + handler + `commandTypes.ts` + `commandOfflinePolicy.ts` + result handler) would be cleaner, is an agent-binary change, and is proposed as a W05 follow-up. **#4609 does not exist in the repo** — the spec's "extends #4609 from patch-only to script runs" describes work that was never done; patch install takes no checkpoint either (`handlers_patch.go:136-153`). Worth filing that as its own issue.
2. **Linux/macOS lose three classes.** `services` is in the DEFAULT allowlist, so on a non-Windows fleet an otherwise-eligible service restart is refused `checkpoint_unavailable` with no obvious explanation in the UI. Task 24's class list should badge affected classes "Windows only" — confirm the wording with Todd, or accept the refusal reason surfacing on the proposal card instead.
3. **`ai_script_policies` merge policy.** Registered as `repoint`; if the survivor already owns a grant row the partial unique index will collide and it must become `repoint-dedupe` (Task 25 Step 4 carries both the detection and the fix). This resolves itself under the merge contract test — it is flagged so the executor is not surprised by it.

## Amendments after cross-wave reconciliation (2026-09-11)

- Every `createActionIntent` call on the lane paths must pass `guardrailContext` (W01b contract, `CreateActionIntentInput.guardrailContext`), because `createActionIntent` itself runs `checkGuardrails` and rejects tier ≥ 4 without it.
- `script_proposals.decided_by` stays `NULL` for lane decisions (W05's disagreement metric depends on it).
- Refusal reason lives in `action_intents.result.scriptLaneRefusal` (this plan's decision; spec §4.6 updated).
- File the follow-up issue for a first-class `create_restore_point` agent command as part of this wave's PR description.

