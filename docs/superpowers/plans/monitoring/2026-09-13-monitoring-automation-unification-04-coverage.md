---
tracking_issue: LanternOps/breeze#5287
wave_issue: LanternOps/breeze#5291
branch: feature/5287-monitoring-automation-unification/wave-5291
---

# Monitoring & Automation Unification — W04 Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the coverage gap left by W02. Ship the three handler-only kinds (`antivirus`, `software_presence`, `backup_continuity`), the first-class `script` monitor, the `network_check` adapter over partner-wide `network_monitors`, and — the risky one — make the heartbeat's `monitoring_settings` block come from `resolveMonitorsForDevice` first and the config-policy Monitoring tab second, without changing one byte of the agent wire shape.

**Architecture:** Everything new is additive against the W02 seams that already exist on `origin/main`. Four of the five new kinds are pure registry work: a zod condition schema in `packages/shared/src/validators/monitors.ts`, a `ConditionHandler` in `apps/api/src/services/alertConditions/handlers/`, and a `MonitorKindSpec` in `apps/api/src/services/monitors/kinds/` — the compiler, sweep, dispatcher and automation worker learn nothing new. The `script` kind adds a scheduler that dispatches a diagnostic script through the existing `dispatchScriptToDevice` and a handler that reads the verdict back off the newest `script_executions` row stamped with `monitor_id`. The `network_check` kind is an adapter: the compiler upserts a managed `network_monitors` row alongside the three managed rows, `network_monitors` gains org-XOR-partner ownership, and `monitorWorker`'s scheduler fans a partner-wide row out one job per org under the partner. Service/process delivery inverts the source of truth in `buildMonitoringConfigUpdate`: monitor-derived watches are computed from the effective monitor set and unioned over the policy tab's watches, emitting the identical `MonitoringConfigUpdate` shape.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16 (enum extension, dual-axis RLS, partner-wide SELECT branch), zod in `packages/shared`, BullMQ, Vitest (unit with Drizzle mocks; integration against real Postgres via `apps/api/src/__tests__/integration/setup`), Go `testing` for the agent wire contract.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md` (§Waves W4 row, §Monitor types (D5), §Delivery, §Responses, §Risks — "Service/process shim", "Partner-wide monitors fan out")

**Tracking:** feature LanternOps/breeze#5287, wave #5291. Branch `feature/5287-monitoring-automation-unification/wave-5291`.

## Ordering assumptions (read first)

- **W04 is independent of W03 (#5290, episodes).** Nothing here reads or writes `monitor_episodes` / `monitor_device_state`, and nothing here needs the latch, the reset API or the Activity tab. The two waves touch disjoint files with one exception: W03 also edits `apps/api/src/services/alertService.ts` (episode hook at the breach point) while Task 7 of this plan does not — Task 7 changes only `routes/agents/helpers.ts`. **W03 and W04 can be implemented and merged in either order**; if both are in flight, whichever merges second must rebase and re-run the Integration Tests shard, because both add rows to `CORE_TENANT_EXPORT_POLICY` and a merge union of two additions to the same object is a classic silent-conflict shape (memory: `merge_union_hides_duplicate_counter_bump`).
- **W02 (#5289) is a hard prerequisite and has already landed on `origin/main`** — verified: `apps/api/src/services/monitors/{kinds,monitorCompiler.ts,monitorResolver.ts}`, `monitor_definitions` + `config_policy_monitors` (migration `2026-10-16-160300-monitor-definitions.sql`), the `'monitor'` target branch in `getApplicableRules` (`services/alertService.ts:825`), and the web hub at `/alerts/monitors` all exist.
- **#5241 is CLOSED** (verified `gh issue view 5241` → `CLOSED`: "Network-monitor alerts are inserted without publishing alert.triggered"). The `network_check` adapter is therefore **not gated**. It is still sequenced **last** (Tasks 9–10) because it is the only task group that reshapes an existing shipped table's tenancy, and because it is the only group that can safely be split into a follow-up PR if it grows.
- **Spec erratum, apply the Waves row.** §Monitor types (D5) labels `antivirus` / `software_presence` / `backup_continuity` / `script` as "wave 3"; the §Waves table puts them in **W4** and episodes in W3. The Waves table is authoritative and is what the wave issues (#5290 episodes, #5291 coverage) were cut against. This plan ships them in W04.

## Global Constraints

- **Migration filename `2026-10-16-180900-monitor-coverage-kinds.sql`.** Before pushing, `ls apps/api/migrations | sort | tail -1` on `origin/main` must sort **before** it (newest at planning time: `2026-10-16-180200-monitor-definitions-builtin-key.sql`; `180300`, `180500` and `180700` are claimed by in-flight PRs). Bump the `HHMMSS` if a later file has landed. Never rename it for today's real date — shipped migration names run more than two weeks ahead of the calendar and a today-named file would replay *before* the W02 migration it depends on.
- Migration is idempotent (`IF NOT EXISTS`, `DO $$ … $$` guards, `pg_policies` existence checks), has **no inner `BEGIN`/`COMMIT`**, and **any DML must be preceded by `SELECT set_config('breeze.scope', 'system', true);`** — `migrationRlsScope.test.ts` carries a frozen baseline of 122 pre-existing offenders and this file must never join it. This migration *does* contain DML (the `network_monitors.org_id` backfill guard in Task 1 Step 4), so the elevation is mandatory, and every `UPDATE`/`DELETE` reports its row count via `GET DIAGNOSTICS` + `RAISE WARNING`.
- `ALTER TYPE monitor_kind ADD VALUE` and `ALTER TYPE trigger_type ADD VALUE` are safe inside the runner's per-file transaction **only because nothing in the same file consumes the new values**. Do not add a DML statement that writes `kind = 'script'` or `trigger_type = 'monitor'` to this file.
- **The agent wire shape is frozen.** `monitoring_settings` on the wire stays exactly `{ check_interval_seconds: int, watches: [{ watch_type, name, alert_on_stop, alert_after_consecutive_failures, auto_restart, max_restart_attempts, restart_cooldown_seconds, cpu_threshold_percent?, memory_threshold_mb?, threshold_duration_seconds? }] }` — the `MonitoringConfigUpdate` / `MonitoringWatchConfig` interfaces in `apps/api/src/routes/agents/helpers.ts:2019-2036` and the Go `MonitorConfig` / `WatchConfig` in `agent/internal/monitoring/types.go`. **No new keys, no renames, no type changes.** Task 7 changes only where the values come from.
- **Local auto-restart must keep working.** `auto_restart` is what drives the agent's offline-capable restart (`agent/internal/monitoring/monitor.go`, covered by `monitor_autorestart_test.go` / `monitor_lifecycle_test.go`). Per spec §Responses, a `service` monitor whose responses include an `execute_command` of kind `restart_service` compiles to `auto_restart: true` on the delivered watch. A monitor-derived watch never silently *lowers* `auto_restart` on a name the policy tab already delivers with `auto_restart: true` — the union in Task 7 ORs the flag.
- Registration lists are part of the migration task, not an afterthought. This wave touches four of them (Task 1 Step 6): `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` (**new columns on already-registered tables count** — `script_executions.monitor_id`, `network_monitors.partner_id`/`managed_by_monitor_id`, `network_monitor_results.org_id`/`device_id`), `DUAL_AXIS_TENANT_TABLES` + `PARENT_FK_JOIN_POLICY_TABLES` in `rls-coverage.integration.test.ts`, and `orgMergeRegistry`. `network_monitor_results.details` is `jsonb` and is already `excludedOpen`; any new jsonb column is `excludedOpen` too.
- SQL guards are two-valued: `COALESCE(…, false)` inside boolean guard functions, `IS NOT TRUE` at call sites. A lookup miss in an ownership decision is a deny.
- Partner-wide reads follow the playbook: an additive **`FOR SELECT`-only** policy `USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())`. Never append the branch to an existing `FOR ALL` policy. Partner-wide writes gate on `canManagePartnerWidePolicies(auth)`.
- Worker-created child rows take the **DEVICE's** org, never the definition's. Compiled rows take the **definition's** owner.
- New i18n keys need **real translations in all 8 locales** (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`) — the coverage test fails on a missing or English-echoed key.
- Every task: **red test first**, then `pnpm --filter @breeze/api exec tsc --noEmit`, then the task's targeted tests, then commit. Use `cd apps/api && npx vitest run <path>` — never `pnpm --filter … test -- --run <path>` (the `--` is swallowed and the whole 1,470-file suite runs in watch mode), and never a trailing-slash path filter (substring match, silently skips dotted siblings).
- `pnpm test` does **not** run the RLS / integration / export-policy suites. Task 11 runs them explicitly against a live stack (`pnpm test-stack up` … `pnpm test-stack down` — nothing reaps it for you).
- The PR targets `main`, so `ci.yml` runs the blocking `integration-test` job on it automatically. Do **not** hand-dispatch CI. Do **not** stack this branch on a sibling branch — a PR based on anything but `main` runs no CI at all and `gh pr checks` reads green.

---

### Task 1: Migration — five new kinds, script-execution provenance, partner-wide `network_monitors`, registration lists

**Files:**
- Create: `apps/api/migrations/2026-10-16-180900-monitor-coverage-kinds.sql`
- Modify: `apps/api/src/db/schema/scripts.ts`, `apps/api/src/db/schema/monitors.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/orgMergeRegistry.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing, auto-discovers), `apps/api/src/db/migrationRlsScope.test.ts` (existing)

**Interfaces produced:** `monitor_kind` += `antivirus | software_presence | backup_continuity | script | network_check`; `trigger_type` += `monitor`; `script_executions.monitor_id uuid NULL`; `network_monitors.org_id` nullable + `partner_id` + `network_monitors_one_owner_chk` + `managed_by_monitor_id`; `network_monitor_results.org_id` + `device_id`.

- [ ] **Step 1 (RED): pin the enum contract before the migration exists.**
  In `apps/api/src/services/monitors/kinds/index.test.ts`, extend the `SAMPLES` map and let the existing "has a spec for every kind" test drive the whole wave. Add the five new keys with a valid sample each (see Tasks 3–6, 9 for the exact shapes). Run:
  ```bash
  cd apps/api && npx vitest run src/services/monitors/kinds/index.test.ts
  ```
  Expect red: `MONITOR_KINDS` (from `@breeze/shared`) does not contain them yet, so the loop never sees them — **this control is vacuous until Task 2 widens `MONITOR_KINDS`.** Prove the red is real by asserting the count first:
  ```ts
  it('ships eighteen kinds after W04', () => { expect(MONITOR_KINDS).toHaveLength(18); });
  ```
  That assertion fails at 13 today. Keep it — it is the one assertion in this wave that cannot pass by accident.

- [ ] **Step 2: extend the two enums (idempotent, no consumer in this file).**
  ```sql
  -- Monitoring & Automation unification, W04 (#5287 / #5291).
  -- Coverage: handler-only kinds, the script monitor, and partner-wide network checks.

  -- 1. Five new monitor kinds. ADD VALUE is transaction-safe here ONLY because
  --    nothing below writes a row using one of these labels.
  DO $$
  DECLARE k text;
  BEGIN
    FOREACH k IN ARRAY ARRAY['antivirus','software_presence','backup_continuity','script','network_check'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = k AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'monitor_kind')
      ) THEN
        EXECUTE format('ALTER TYPE monitor_kind ADD VALUE %L', k);
      END IF;
    END LOOP;
  END $$;

  -- 2. A diagnostic run dispatched BY a monitor is its own trigger type. Reusing
  --    'policy' would make the script handler unable to tell a monitor's own probe
  --    from any other policy-driven run on the same script.
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum
      WHERE enumlabel = 'monitor' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'trigger_type')
    ) THEN
      ALTER TYPE trigger_type ADD VALUE 'monitor';
    END IF;
  END $$;
  ```

- [ ] **Step 3: script-execution provenance.**
  ```sql
  -- 3. Which monitor's probe this execution is. NULL for every other execution.
  --    ON DELETE SET NULL: deleting a monitor must not delete run history.
  ALTER TABLE script_executions
    ADD COLUMN IF NOT EXISTS monitor_id uuid REFERENCES monitor_definitions(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS script_executions_monitor_device_idx
    ON script_executions (monitor_id, device_id, completed_at DESC)
    WHERE monitor_id IS NOT NULL;
  ```
  `script_executions` is Shape 1 (`org_id NOT NULL`) and already carries RLS — no policy change. It is **already** in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:295`), `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts:521`) and `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:487`) — the **column** addition is what fires the export policy (Step 6).

- [ ] **Step 4: partner-wide ownership for `network_monitors` (the only tenancy reshape in this wave).**
  ```sql
  -- 4. network_monitors becomes a config table: org_id XOR partner_id.
  --    A partner authors ONE "is the gateway up" check and it runs for every org.
  ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id);
  ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS managed_by_monitor_id uuid
    REFERENCES monitor_definitions(id) ON DELETE CASCADE;
  ALTER TABLE network_monitors ALTER COLUMN org_id DROP NOT NULL;

  -- Every existing row is org-owned; the CHECK below would abort on a stray NULL.
  -- Report the count either way — a 0 here is the forensic record that there was
  -- nothing to clean, not an absence of evidence.
  SELECT set_config('breeze.scope', 'system', true);
  DO $$
  DECLARE n integer;
  BEGIN
    PERFORM set_config('breeze.scope', 'system', true);
    SELECT count(*) INTO n FROM network_monitors WHERE org_id IS NULL AND partner_id IS NULL;
    IF n > 0 THEN RAISE WARNING 'network_monitors: % ownerless rows before one_owner_chk', n; END IF;
  END $$;

  ALTER TABLE network_monitors DROP CONSTRAINT IF EXISTS network_monitors_one_owner_chk;
  ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_one_owner_chk
    CHECK ((org_id IS NULL) <> (partner_id IS NULL));

  CREATE INDEX IF NOT EXISTS network_monitors_partner_id_idx ON network_monitors (partner_id);
  CREATE UNIQUE INDEX IF NOT EXISTS network_monitors_managed_by_monitor_uniq
    ON network_monitors (managed_by_monitor_id) WHERE managed_by_monitor_id IS NOT NULL;
  ```
  Then **replace** the org-only policy with one dual-axis policy plus the additive SELECT-only partner-wide branch — mirroring `monitor_definitions_isolation` / `monitor_definitions_partner_wide_select` in `2026-10-16-160300-monitor-definitions.sql:121-144` verbatim in shape:
  ```sql
  ALTER TABLE network_monitors ENABLE ROW LEVEL SECURITY;
  ALTER TABLE network_monitors FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS network_monitors_isolation ON network_monitors;
  CREATE POLICY network_monitors_isolation ON network_monitors
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

  -- Additive, SELECT-only. LOAD-BEARING on the agent path: agentAuth sets
  -- breeze.current_partner_id, and without this branch a partner-wide network
  -- check is invisible to the poller's own context with no error at all.
  DROP POLICY IF EXISTS network_monitors_partner_wide_select ON network_monitors;
  CREATE POLICY network_monitors_partner_wide_select ON network_monitors
    FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
  ```
  Sweep every pre-existing `network_monitors` policy name before writing this — `\dp network_monitors` locally, and `grep -rn "POLICY.*network_monitors" apps/api/migrations` — and `DROP POLICY IF EXISTS` each one. Leaving an old org-only `FOR ALL` policy in place is harmless for reads (policies OR together) but means a partner-wide row can never be written.

- [ ] **Step 5: `network_monitor_results` gets the fan-out axes.**
  A partner-wide `network_monitors` row produces one result *per org under the partner*, so the child row must say which. Today `network_monitor_results` reaches its tenant only by joining `network_monitors` (registered in `PARENT_FK_JOIN_POLICY_TABLES`, `rls-coverage.integration.test.ts:755`) — that join is blind for a partner-wide parent. Convert it to Shape 1.
  ```sql
  -- 5. Results carry the org the check ran FOR and the device it ran FROM.
  ALTER TABLE network_monitor_results ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);
  ALTER TABLE network_monitor_results ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices(id) ON DELETE SET NULL;

  SELECT set_config('breeze.scope', 'system', true);
  DO $$
  DECLARE n integer;
  BEGIN
    PERFORM set_config('breeze.scope', 'system', true);
    UPDATE network_monitor_results r
       SET org_id = m.org_id
      FROM network_monitors m
     WHERE r.monitor_id = m.id AND r.org_id IS NULL AND m.org_id IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE WARNING 'network_monitor_results: backfilled org_id on % rows', n; END IF;
  END $$;

  CREATE INDEX IF NOT EXISTS network_monitor_results_org_id_idx ON network_monitor_results (org_id);

  DROP POLICY IF EXISTS network_monitor_results_isolation ON network_monitor_results;
  CREATE POLICY network_monitor_results_isolation ON network_monitor_results
    USING (public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)))
    WITH CHECK (public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)));
  ```
  **Do not `SET NOT NULL` on `org_id` in this migration.** `network_monitor_results` is an append-only telemetry table that can exceed 1M rows; the backfill above is a single statement and is fine for a dev DB but a production instance needs the batched `UPDATE … WHERE ctid IN (… LIMIT N)` loop before any `NOT NULL`. File the `SET NOT NULL` as a follow-up issue and say so in the PR body. Every writer added in Task 10 sets `org_id` unconditionally.

- [ ] **Step 6: the four registration lists — mechanical grep, not judgement.**
  Per CLAUDE.md this is the step that gets missed (5 shipped incidents, code review caught 0/5).
  - `apps/api/src/services/tenantExportPolicyRegistry.ts` — **three edits, all column-level on already-registered tables**:
    - `script_executions`: add `"monitor_id"` to `included`.
    - `network_monitors`: add `"partner_id"` and `"managed_by_monitor_id"` to `included`. (`config` stays `excludedOpen`.)
    - `network_monitor_results`: add `"org_id"` and `"device_id"` to `included`; confirm `details` is already `excludedOpen`.
  - `apps/api/src/services/tenantCascade.ts` — `network_monitor_results` now has an `org_id` column, so it **must** join `CORE_ORG_CASCADE_DELETE_ORDER`, alphabetically, and **before** `network_monitors` (child-before-parent: `network_monitor_results.monitor_id` has no explicit `ON DELETE`, so it defaults to `NO ACTION` and the parent delete raises 23503 if the child survives). `network_monitor_results` < `network_monitors` under `localeCompare` (`_` sorts before `s`) — **verify this locally, do not assume**:
    ```bash
    cd apps/api && node -e "console.log(['network_monitor_results','network_monitors'].sort((a,b)=>a.localeCompare(b)))"
    ```
  - `apps/api/src/routes/devices/core.ts` — `network_monitor_results` now has a `device_id` **and** a denormalized `org_id`, so it goes in **both** `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES`.
  - `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — add `'network_monitors'` to `DUAL_AXIS_TENANT_TABLES` (it now has the org-XOR-partner shape **and** the partner-wide SELECT branch, so it must **not** go in `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`); **remove** `['network_monitor_results', ['network_monitors']]` from `PARENT_FK_JOIN_POLICY_TABLES` (it is Shape 1 now and will be auto-discovered); leave `['network_monitor_alert_rules', ['network_monitors']]` alone.
  - `apps/api/src/services/orgMergeRegistry.ts` — `network_monitors` is already a repoint table; confirm the repoint tolerates `org_id IS NULL` (a partner-wide row is not the losing org's and must not be repointed) and add `network_monitor_results` as a device-org restamp.

- [ ] **Step 7: mirror everything in the Drizzle schema.**
  `apps/api/src/db/schema/scripts.ts`: `monitorId: uuid('monitor_id')` on `scriptExecutions`, and `'monitor'` in `triggerTypeEnum`. `apps/api/src/db/schema/monitors.ts`: `orgId` loses `.notNull()`, add `partnerId` + `managedByMonitorId` on `networkMonitors`, add `orgId` + `deviceId` on `networkMonitorResults`.

- [ ] **Step 8: verify.**
  ```bash
  cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
  pnpm --filter @breeze/api exec tsc --noEmit
  bash scripts/check-migration-naming.sh --against-ref origin/main
  ```
  `db:check-drift` needs a live DB and runs in Task 11.

- [ ] **Step 9: commit.** `feat(monitors): W04 migration — coverage kinds, script provenance, partner-wide network monitors`

---

### Task 2: Shared validators — condition schemas for the five new kinds

**Files:**
- Modify: `packages/shared/src/validators/monitors.ts`
- Test: `packages/shared/src/validators/monitors.test.ts` (create if absent)

**Interfaces produced:** `MONITOR_KINDS` widened to 18; `monitorConditionSchemas.{antivirus,software_presence,backup_continuity,script,network_check}`.

- [ ] **Step 1 (RED):** in `monitors.test.ts`, assert each new schema accepts its canonical sample and rejects one specific malformation (not "rejects `{}`" — that passes for any `.strict()` object and discriminates nothing). E.g. `software_presence` must reject `{ presence: 'version_below' }` with no `version`. Run `cd packages/shared && npx vitest run src/validators/monitors.test.ts` — red.

- [ ] **Step 2: add the five entries.** `monitorConditionSchemas` is `satisfies Record<MonitorKind, z.ZodTypeAny>`, so widening `MONITOR_KINDS` without adding all five is a compile error — that is the guard rail, use it.
  ```ts
  antivirus: z.object({
    check: z.enum(['not_protected', 'definitions_stale', 'realtime_disabled', 'threats_present']),
    staleAfterDays: z.number().int().min(1).max(365).optional(),   // 'definitions_stale' only
    minThreatCount: z.number().int().min(1).max(1000).optional(),  // 'threats_present' only
  }).strict()
    .refine(v => v.check !== 'definitions_stale' || v.staleAfterDays != null,
      { message: 'staleAfterDays required for definitions_stale', path: ['staleAfterDays'] }),

  software_presence: z.object({
    name: z.string().min(1).max(500),
    vendor: z.string().max(200).optional(),
    presence: z.enum(['installed', 'not_installed', 'version_below']),
    version: z.string().max(100).optional(),                        // 'version_below' only
  }).strict()
    .refine(v => v.presence !== 'version_below' || !!v.version,
      { message: 'version required for version_below', path: ['version'] }),

  backup_continuity: z.object({
    check: z.enum(['no_successful_backup', 'consecutive_failures']),
    maxAgeHours: z.number().int().min(1).max(8760).optional(),      // 'no_successful_backup' only
    failureCount: z.number().int().min(1).max(50).optional(),       // 'consecutive_failures' only
  }).strict()
    .refine(v => v.check !== 'no_successful_backup' || v.maxAgeHours != null,
      { message: 'maxAgeHours required for no_successful_backup', path: ['maxAgeHours'] })
    .refine(v => v.check !== 'consecutive_failures' || v.failureCount != null,
      { message: 'failureCount required for consecutive_failures', path: ['failureCount'] }),

  script: z.object({
    scriptId: z.string().uuid(),
    intervalMinutes: z.number().int().min(5).max(1440).default(60),
    timeoutSeconds: z.number().int().min(10).max(3600).default(300),
    parameters: z.record(z.string(), z.unknown()).optional(),
    // Exit-code verdict is the default. The marker (see Task 6) can override it
    // with a richer detail string; a script that emits neither and exits 0 passes.
    breachOnNonZeroExit: z.boolean().default(true),
  }).strict(),

  network_check: z.object({
    checkType: z.enum(['icmp_ping', 'tcp_port', 'http_check', 'dns_check']),
    target: z.string().min(1).max(500),
    port: z.number().int().min(1).max(65535).optional(),            // tcp_port
    expectStatus: z.number().int().min(100).max(599).optional(),    // http_check
    pollingIntervalSeconds: z.number().int().min(30).max(3600).default(60),
    timeoutSeconds: z.number().int().min(1).max(120).default(5),
    consecutiveFailures: z.number().int().min(1).max(20).default(2),
  }).strict()
    .refine(v => v.checkType !== 'tcp_port' || v.port != null,
      { message: 'port required for tcp_port', path: ['port'] }),
  ```
  Note the `checkType` labels are the **existing** `monitor_type` pgEnum values (`apps/api/src/db/schema/monitors.ts:6`) — reusing them verbatim means the Task 9 adapter never maps a vocabulary.
  Also confirm `refineDefinition`'s `monitorConditionSchemas[v.kind].safeParse` still typechecks now that some entries are `ZodEffects` rather than `ZodObject` — `safeParse` is on `ZodTypeAny`, so it does, but `tsc` is the arbiter.

- [ ] **Step 3:** `cd packages/shared && npx vitest run src/validators/monitors.test.ts` — green. `pnpm --filter @breeze/shared exec tsc --noEmit`. Then `cd apps/api && npx vitest run src/services/monitors/kinds/index.test.ts` — the Task 1 Step 1 length assertion goes green; the per-kind loop is now **red** because `MONITOR_KIND_SPECS` has no entry. That red is the driver for Tasks 3–6 and 9.

- [ ] **Step 4: commit.** `feat(shared): monitor condition schemas for the five W04 kinds`

---

### Task 3: `antivirus` handler + kind spec

**Files:**
- Create: `apps/api/src/services/alertConditions/handlers/antivirus.ts`, `apps/api/src/services/alertConditions/handlers/antivirus.test.ts`
- Create: `apps/api/src/services/monitors/kinds/antivirus.ts`
- Modify: `apps/api/src/services/alertConditions/index.ts`, `apps/api/src/services/alertConditions/types.ts`, `apps/api/src/services/monitors/kinds/index.ts`

**Data source (verified):** `security_status` (`apps/api/src/db/schema/security.ts:54`) — one row per device (`security_status_device_id_unique`), columns `real_time_protection boolean`, `definitions_date timestamp`, `threat_count integer NOT NULL DEFAULT 0`, `av_products jsonb`, `provider`.

- [ ] **Step 1 (RED):** `antivirus.test.ts`, Drizzle-mocked in the `handlers/threshold.test.ts` style. Four cases that each fail for a *different* reason if the handler is wrong:
  1. `realtime_disabled` + `real_time_protection = false` → `passed: true`.
  2. `realtime_disabled` + `real_time_protection = null` (agent never reported) → `passed: false`, description says "no data". **This is the important one**: `null` must not read as "disabled". A three-valued column compared with `=== false` is the failure mode.
  3. `definitions_stale` `staleAfterDays: 7` + `definitions_date` 8 days old → `passed: true`; 6 days old → `passed: false`.
  4. `threats_present` `minThreatCount: 1` + `threat_count = 0` → `passed: false`.
  Also a `validate()` case rejecting `check: 'bogus'`.
  ```bash
  cd apps/api && npx vitest run src/services/alertConditions/handlers/antivirus.test.ts
  ```

- [ ] **Step 2: implement `antivirusHandler`** with `type: 'antivirus'`, following `handlers/patchCompliance.ts` exactly (single `db.select()` on the latest row, `{ passed, description, actualValue? }`, no throw). No row for the device → `{ passed: false, description: 'No antivirus status reported' }`. Register it in `alertConditions/index.ts` and add `AntivirusCondition` to the `AlertCondition` union in `types.ts` (`validateConditions` walks the registry, so an unregistered type would make the Task 1 kind-registry test's `validateConditions(compiled)` assertion fail — that is the cross-check).

- [ ] **Step 3: `kinds/antivirus.ts`** — `agentDelivered: false`, `defaultSeverity: 'high'`, `overridableKeys: ['staleAfterDays', 'minThreatCount']`, `toAlertCondition` passing the fields through under `type: 'antivirus'`. Register in `kinds/index.ts`.

- [ ] **Step 4:**
  ```bash
  cd apps/api && npx vitest run src/services/alertConditions src/services/monitors/kinds
  pnpm --filter @breeze/api exec tsc --noEmit
  ```
- [ ] **Step 5: commit.** `feat(monitors): antivirus monitor kind and condition handler`

---

### Task 4: `software_presence` handler + kind spec

**Files:** same shape as Task 3, `handlers/softwarePresence.ts` + `kinds/softwarePresence.ts`.

**Data source (verified):** `software_inventory` (`apps/api/src/db/schema/software.ts:190`) — `device_id`, `org_id`, `name varchar(500)`, `vendor varchar(200)`, `version varchar(100)`, `last_seen`.

- [ ] **Step 1 (RED):** cases that discriminate:
  1. `presence: 'not_installed'`, no matching row → `passed: true`.
  2. `presence: 'installed'`, matching row → `passed: false` (a monitor breaches on the *bad* state; "installed" as the condition means "alert me that this is installed" — assert the polarity explicitly in the test name, this is the field most likely to be inverted).
  3. `version_below` with `version: '10.2'` and an installed `'9.8'` → `passed: true`; installed `'10.10'` → `passed: false` (**dotted numeric comparison, not lexicographic** — `'10.10' < '10.2'` as strings; this case is the whole point of the test).
  4. `vendor` supplied narrows the match: same `name`, different vendor → no match.
  Name matching is case-insensitive equality on `name`, not `LIKE` — a substring match would make "Chrome" breach on "Google Chrome Helper".

- [ ] **Step 2: implement.** Version compare: split on `.`, compare numeric segments left to right, non-numeric segment → treat the whole comparison as `unknown` and return `{ passed: false, description: 'Version <x> not comparable' }`. Never guess.
- [ ] **Step 3: `kinds/softwarePresence.ts`** — `overridableKeys: ['version']`, `defaultSeverity: 'medium'`, `agentDelivered: false`.
- [ ] **Step 4:** same commands as Task 3 Step 4. **Step 5: commit.** `feat(monitors): software_presence monitor kind and condition handler`

---

### Task 5: `backup_continuity` handler + kind spec

**Files:** same shape, `handlers/backupContinuity.ts` + `kinds/backupContinuity.ts`.

**Data source (verified):** `backup_jobs` (`apps/api/src/db/schema/backup.ts:216`) — `device_id`, `org_id`, `status` (`backupStatusEnum`), `completed_at`, `started_at`. Cross-check the enum's success label before writing the query (`grep -n "backupStatusEnum" -A3 apps/api/src/db/schema/backup.ts`) — do not assume `'completed'`.

- [ ] **Step 1 (RED):** cases:
  1. `no_successful_backup` `maxAgeHours: 26`, newest success 30h old → `passed: true`; 20h old → `passed: false`.
  2. **A device that has never had a backup job at all → `passed: false`, description "no backup configured".** A never-backed-up device must not page someone at 3 a.m. through a monitor attached fleet-wide; that is what the `backup_configs` presence check is for. Assert this explicitly.
  3. `consecutive_failures` `failureCount: 3` with the newest three jobs failed → `passed: true`; with a success in position 2 → `passed: false`.
  4. A `running` job newer than the last success does **not** reset the age clock (only a terminal success does).

- [ ] **Step 2: implement.** Query the newest N jobs for the device ordered by `COALESCE(completed_at, started_at) DESC`. Do **not** read `backupSlaWorker` state — the spec mentions it as context, but `apps/api/src/jobs/backupSlaWorker.ts` writes SLA breach records on its own cadence and reading them would make monitor evaluation depend on another worker's schedule. `backup_jobs` is the primary evidence.
- [ ] **Step 3: `kinds/backupContinuity.ts`** — `overridableKeys: ['maxAgeHours', 'failureCount']`, `defaultSeverity: 'high'`, `agentDelivered: false`.
- [ ] **Step 4/5:** as above. Commit `feat(monitors): backup_continuity monitor kind and condition handler`

---

### Task 6: the `script` monitor — dispatcher, verdict handler, and the partner-wide script binding guard

**Files:**
- Create: `apps/api/src/services/alertConditions/handlers/scriptMonitor.ts` (+ test)
- Create: `apps/api/src/services/monitors/kinds/script.ts`
- Create: `apps/api/src/jobs/monitorScriptWorker.ts` (+ `monitorScriptWorker.test.ts`)
- Modify: `apps/api/src/services/monitors/monitorService.ts` (binding validation at save), `apps/api/src/services/monitors/monitorCompiler.ts` (bind the diagnostic script), `apps/api/src/jobs/index.ts` (or wherever workers are registered — grep `registerWorker`/`workerReadinessManifest.ts`), `apps/api/src/services/alertConditions/{index,types}.ts`, `apps/api/src/services/monitors/kinds/index.ts`

**Design (this is the one novel mechanism in the wave, state it in the PR body):**

A script monitor has two halves that are deliberately decoupled through `script_executions`:

1. **Dispatch.** `monitorScriptWorker` runs on a repeatable BullMQ job. Each tick it loads enabled `script` monitors, resolves each one's devices via `resolveMonitorsForDevice` (inverted: iterate candidate devices from the compiled rule's attachment set), skips any device whose newest execution for that monitor is younger than `intervalMinutes`, and calls the **existing** `dispatchScriptToDevice` (`apps/api/src/services/scriptDispatch.ts:262`) with `triggerType: 'monitor'`, `monitorId`, `timeoutSeconds` and `parameters` from the condition. It writes nothing else. Offline devices, maintenance windows and decommissioning are all already handled inside `dispatchScriptToDevice` — do not re-implement any of those gates.
2. **Verdict.** `scriptMonitorHandler` (`type: 'script_monitor'`) reads the newest `script_executions` row for `(monitor_id, device_id)` and maps it:
   - `status = 'completed'` and marker present → the marker's `state` (`breach` → `passed: true`, `ok` → `passed: false`), `description` from `detail`.
   - `status = 'completed'`, no marker, `breachOnNonZeroExit` → `passed: exit_code !== 0`.
   - `status IN ('timeout','failed')` → **unknown**: `{ passed: false, description: '…' }`. Per spec, a timeout is not a breach.
   - no row, or the newest row is older than `3 × intervalMinutes` → `{ passed: false, description: 'No recent probe result' }`. A stale probe must never latch a breach.
   The marker format is the spec's: a line in `stdout` of the form `::breeze:monitor:: {"state":"breach","detail":"…"}`. Parse the **last** such line, `JSON.parse` inside a try/catch, and on a parse failure fall back to the exit-code rule rather than throwing — a malformed marker is a script bug, not an outage.

**The partner-wide drift guard.** `monitorCompiler.compileMonitorInTx` already calls `resolveAutomationReferencesForOwner(tx, owner, automation.actions)` and `replaceAutomationResourceBindings` (`monitorCompiler.ts:236-247`) for the *response* actions. The **diagnostic** script is a second reference and today is bound by nothing. Add it: for a `script` kind, synthesise a `run_script` action descriptor for `condition.scriptId` and include it in the array passed to `resolveAutomationReferencesForOwner`, so a partner-wide monitor referencing an org-owned script fails at authoring with `AutomationReferenceAuthorizationError` (surfaced as 400 by the route) rather than at 3 a.m. in the worker. This is exactly the mitigation the spec's §Risks bullet names.

- [ ] **Step 1 (RED) — the binding guard first, it is the highest-blast-radius half.** In `apps/api/src/services/monitors/monitorCompiler.test.ts`, add: compiling a `partner_id`-owned `script` monitor whose `condition.scriptId` names an **org-owned** script throws. Run `cd apps/api && npx vitest run src/services/monitors/monitorCompiler.test.ts` — red (today the diagnostic script is not in the resolved reference set at all, so it compiles happily). Confirm the red is the *assertion* failing and not a mock wiring error before writing the fix.

- [ ] **Step 2:** implement the compiler change and re-run. Also assert the negative: a partner-wide monitor referencing a **partner-owned or system** script still compiles.

- [ ] **Step 3 (RED) — the verdict handler.** `scriptMonitor.test.ts` with one case per branch above, plus the stale-probe case and a malformed-marker case. Run it; red.

- [ ] **Step 4:** implement `scriptMonitorHandler`, register in `alertConditions/index.ts`, add `ScriptMonitorCondition` to `types.ts`. `kinds/script.ts`: `agentDelivered: false` (the *server* dispatches; the agent merely executes a script, which is not the agent-delivered watch path), `defaultSeverity: 'medium'`, `overridableKeys: ['intervalMinutes', 'timeoutSeconds']` — **`scriptId` is deliberately not overridable**: a policy attachment that could swap the script would be a cross-tenant code-execution vector past the binding guard. Assert that in the kind test.

- [ ] **Step 5 (RED) — the dispatcher.** `monitorScriptWorker.test.ts`: (a) a device whose newest execution is 10 minutes old under a 60-minute interval is **not** re-dispatched; (b) one 70 minutes old is; (c) a disabled attachment yields no dispatch; (d) `dispatchScriptToDevice` is called with `triggerType: 'monitor'` and the monitor's id. Mock `dispatchScriptToDevice` the way `agentEditionAutoMigrate.test.ts:8` does.

- [ ] **Step 6:** implement the worker. Wrap DB work in `withSystemDbAccessContext` following the `runWithSystemDbAccess` helper at the top of `apps/api/src/jobs/monitorWorker.ts:30` — it is a background worker, so system scope is correct here (this is *not* the request-path escalation CLAUDE.md forbids). Register it in `workerReadinessManifest.ts` alongside the other workers.

- [ ] **Step 7:**
  ```bash
  cd apps/api && npx vitest run src/services/monitors src/services/alertConditions src/jobs/monitorScriptWorker.test.ts
  pnpm --filter @breeze/api exec tsc --noEmit
  ```
- [ ] **Step 8: commit.** `feat(monitors): first-class script monitor with dispatch worker and diagnostic-script binding guard`

---

### Task 7: service/process watch delivery from `resolveMonitorsForDevice` — wire shape frozen

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (`resolveDeviceMonitoringSettings`, `buildMonitoringConfigUpdate`)
- Create: `apps/api/src/routes/agents/helpers.monitorWatchDelivery.test.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts` (existing coverage at lines 3259-3401 must stay green untouched)
- Create: `agent/internal/monitoring/monitor_w04_wire_test.go`

**This is the "must not break" task.** Two invariants, both testable:

- **Wire shape unchanged.** The function's return type stays `MonitoringConfigUpdate` exactly as declared at `helpers.ts:2033`. No field added, removed or renamed.
- **Local auto-restart preserved.** `auto_restart` is ORed across sources, never lowered.

**Merge contract (monitors first, policy tab second):**

1. Compute `monitorWatches` — for every enabled effective monitor of kind `service` or `process`, after `applyOverrides`, one `MonitoringWatchConfig`:
   `watch_type` from the kind, `name` from `serviceName`/`processName`, `alert_on_stop: true`, `alert_after_consecutive_failures` from `consecutiveFailures ?? 2`, `auto_restart: true` **iff** the definition's `responses` contain an `execute_command` whose command kind is `restart_service` (spec §Responses), `max_restart_attempts: 3`, `restart_cooldown_seconds: 300` (the same defaults `config_policy_monitoring_watches` carries — `configurationPolicies.ts:425-427`).
2. Compute `policyWatches` — the existing resolution, unchanged.
3. Union keyed on `(watch_type, lower(name))`. On collision the **monitor** row wins for every field **except** `auto_restart`, which is `monitorRow.auto_restart || policyRow.auto_restart`, and the process thresholds, which fall back to the policy row when the monitor row has none (a `service`/`process` monitor authors no CPU/memory threshold — that is the `process_resource` kind).
4. `check_interval_seconds`: the policy tab's value when a policy resolved, else `60`.
5. **Null semantics.** Return `null` (→ heartbeat omits the block) **only when both sources are empty and no policy resolved**. If monitors resolve to zero watches but a policy resolved with zero enabled watches, still return `{ check_interval_seconds, watches: [] }` — that is the #2949 "stop watching" signal and regressing it silently strands watches on agents forever.
6. **Cache.** `buildMonitoringConfigUpdate` caches on `monitoring:settings:device:${deviceId}` for 120s (`helpers.ts:2158-2189`). Verified: **nothing invalidates that key today** — the only writer is the setter and the only reader is this function. Monitor attach/detach/edit therefore takes up to 2 minutes to reach an agent. That is acceptable and matches today's policy-tab behaviour; do **not** add invalidation in this task. Note it in the PR body as known behaviour so the next reader does not mistake it for a bug introduced here.

- [ ] **Step 1 (RED): freeze the wire shape before touching the builder.** In the new `helpers.monitorWatchDelivery.test.ts`, snapshot the exact key set:
  ```ts
  it('emits exactly the frozen monitoring_settings key set', async () => {
    const out = await buildMonitoringConfigUpdate(DEVICE_ID);
    expect(Object.keys(out!).sort()).toEqual(['check_interval_seconds', 'watches']);
    expect(Object.keys(out!.watches[0]!).sort()).toEqual([
      'alert_after_consecutive_failures', 'alert_on_stop', 'auto_restart',
      'max_restart_attempts', 'name', 'restart_cooldown_seconds', 'watch_type',
    ]);
  });
  ```
  With a monitor-only fixture this is red today (no watches at all). Run:
  ```bash
  cd apps/api && npx vitest run src/routes/agents/helpers.monitorWatchDelivery.test.ts
  ```

- [ ] **Step 2 (RED): the behavioural cases.** Six, each discriminating:
  1. Monitor-only (no policy monitoring link) → one watch, correct name and type.
  2. Policy-only → byte-identical to today's output (regression fence).
  3. Both, **different** names → both watches present.
  4. Both, **same** name, monitor `consecutiveFailures: 5`, policy `2` → merged row has `5`.
  5. Both, same name, monitor has **no** `restart_service` response but policy has `auto_restart: true` → merged `auto_restart` is **`true`**. *(This is the auto-restart regression test. If it is not present, the union is a downgrade vector.)*
  6. Neither source → `null`.
  Plus: a monitor whose effective attachment is `enabled: false` contributes nothing.

- [ ] **Step 3: implement.** Add a `resolveMonitorDerivedWatches(deviceId, executor)` helper. It needs the monitor **definitions**, which `resolveMonitorsForDevice` does not return (it returns `{ monitorId, enabled, overrides, sourcePolicyId, sourceLevel, inheritedFromParent }` — verified `monitorResolver.ts:60-68`). Add one batched `inArray(monitorDefinitions.id, enabledIds)` read filtered to `kind IN ('service','process')`, then `applyOverrides(spec, def.condition, effective.overrides)`. Do **not** widen `resolveMonitorsForDevice`'s return type — `getApplicableRules` (`alertService.ts:829`) and W03 both consume it.
  **RLS note:** this read runs in the agent's own DB context. `monitor_definitions_partner_wide_select` (shipped in W02, `2026-10-16-160300-monitor-definitions.sql:141`) is what lets a partner-wide monitor's definition be read on the agent path, because `middleware/agentAuth.ts` sets `currentPartnerId`. Do **not** wrap this in `withSystemDbAccessContext` — that is the forbidden request-path escalation (#2417), and it would double-hold a pooled connection.

- [ ] **Step 4: the Go side proves the wire shape did not move.** `agent/internal/monitoring/monitor_w04_wire_test.go`: a table-driven test that unmarshals a literal JSON payload — copied verbatim from the API test's expected output in Step 1 — into `MonitorConfig` and asserts every field lands, plus that a payload containing an *unexpected* key still parses (forward compatibility). Also re-run the existing suite untouched:
  ```bash
  cd agent && go test -race ./internal/monitoring/... ./internal/heartbeat/...
  ```

- [ ] **Step 5:**
  ```bash
  cd apps/api && npx vitest run src/routes/agents/helpers.monitorWatchDelivery.test.ts src/routes/agents/heartbeat.test.ts src/routes/agents/helpers.partnerWidePolicies.test.ts
  pnpm --filter @breeze/api exec tsc --noEmit
  ```
  All three must be green — `heartbeat.test.ts:3301-3344` and `helpers.partnerWidePolicies.test.ts:457` are the pre-existing contracts on this exact path and must pass **unmodified**. If either needs editing to go green, the change broke a contract; stop and re-read rather than editing the test.

- [ ] **Step 6: commit.** `feat(monitors): deliver service/process watches from resolved monitors, policy tab second`

---

### Task 8: web — the five new kinds in the editor, 8 locales

**Files:**
- Modify: `apps/web/src/components/monitoring/monitorKindFields.ts` (+ `.test.ts`), `apps/web/src/components/monitoring/MonitorConditionFields.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json`

`MONITOR_KIND_FIELDS` is `Record<MonitorKind, readonly KindField[]>` (`monitorKindFields.ts:37`), so widening `MonitorKind` in Task 2 makes this file a **compile error** until all five are added — that is the red, and `monitorKindFields.test.ts` already asserts every key here is a key of the corresponding zod shape.

- [ ] **Step 1 (RED):** `pnpm --filter @breeze/web exec tsc --noEmit` fails with five missing keys. Do not add them yet — first extend `monitorKindFields.test.ts` with a case per new kind asserting `defaultConditionFor(kind)` parses against `monitorConditionSchemas[kind]`. `cd apps/web && npx vitest run src/components/monitoring/monitorKindFields.test.ts` — red.

- [ ] **Step 2:** add the five field lists. `script` needs a `scriptId` picker, not a text input — reuse the existing script picker component (`grep -rn "ScriptPicker" apps/web/src/components | head`); if `FieldKind` has no `'script'` variant, add one and render it in `MonitorConditionFields.tsx`. Conditional fields (`staleAfterDays` only for `definitions_stale`, `port` only for `tcp_port`) render via a `showWhen?: { key: string; equals: string }` addition to `KindField` — do not hand-code five bespoke forms.

- [ ] **Step 3:** add every new label key to **all 8** locale files with a real translation. `en` alone reds the coverage test. Run:
  ```bash
  cd apps/web && npx vitest run src/locales
  cd apps/web && npx vitest run src/components/monitoring
  pnpm --filter @breeze/web exec tsc --noEmit
  ```
  The hub route is `/alerts/monitors` (tabs Alerts | Correlations | Monitors | Rules | Channels — verified in `apps/web/src/components/alerts/AlertsTabStrip.tsx`); **no route or tab-strip change in this wave.**

- [ ] **Step 4: commit.** `feat(web): monitor editor fields for the five W04 kinds`

---

### Task 9: `network_check` — the compiler adapter

**Files:**
- Create: `apps/api/src/services/monitors/kinds/networkCheck.ts`
- Modify: `apps/api/src/services/monitors/monitorCompiler.ts` (+ `monitorCompiler.test.ts`)
- Create: `apps/api/src/services/alertConditions/handlers/networkCheck.ts` (+ test)

**Design.** A `network_check` monitor compiles to the usual three managed rows **plus** a fourth: a managed `network_monitors` row (`managed_by_monitor_id`, unique partial index from Task 1), inheriting the definition's `org_id`/`partner_id`, with `monitor_type = condition.checkType`, `target`, `polling_interval`, `timeout`, `is_active = enabled`, and `config` holding `{ port?, expectStatus? }`. The existing `monitorWorker` polls it (Task 10). The compiled **alert rule** exists so the monitor shows up in the inbox and Activity views like any other; its condition is `{ type: 'network_check', monitorId }` and `networkCheckHandler` reads the newest `network_monitor_results` row for `(monitor_id, org_id)` — status `offline` for ≥ `consecutiveFailures` consecutive results → breach.

- [ ] **Step 1 (RED):** in `monitorCompiler.test.ts`, assert that compiling a `network_check` definition upserts a `network_monitors` row with `managed_by_monitor_id` set and the definition's ownership axes, and that **recompiling keeps the same row id** (idempotence — the same property `upsertManaged` already guarantees for the other three). Also: `verifyCompiled` reports drift when the managed `network_monitors` row's `target` is edited behind the compiler's back. Red.

- [ ] **Step 2:** generalise `upsertManaged` to take `networkMonitors` (it is already typed loosely via the `anyTable` cast at `monitorCompiler.ts:184`), add `buildCompiledNetworkMonitor(def)` as a **pure** function next to the other three builders, call it from `compileMonitorInTx` only when `def.kind === 'network_check'`, and extend `verifyCompiled` with the same key-by-key canonical comparison. Delete of the definition already cascades (`ON DELETE CASCADE` on `managed_by_monitor_id`, Task 1 Step 4).

- [ ] **Step 3:** `networkCheckHandler` + `kinds/networkCheck.ts` (`agentDelivered: true` — the check runs from an agent; `overridableKeys: ['pollingIntervalSeconds','consecutiveFailures']`; `target` and `checkType` are **not** overridable, same cross-tenant reasoning as `scriptId`).

- [ ] **Step 4:**
  ```bash
  cd apps/api && npx vitest run src/services/monitors src/services/alertConditions/handlers/networkCheck.test.ts
  pnpm --filter @breeze/api exec tsc --noEmit
  ```
- [ ] **Step 5: commit.** `feat(monitors): network_check kind compiles to a managed network monitor`

---

### Task 10: `monitorWorker` — partner-wide fan-out by the device org's partner

**Files:**
- Modify: `apps/api/src/jobs/monitorWorker.ts` (+ `monitorWorker.test.ts`)
- Modify: `apps/api/src/jobs/queueSchemas.ts` if `monitorQueueJobDataSchema` needs no change (it already carries `{ type, monitorId, orgId }` — verified `monitorWorker.ts:600-617`; confirm and leave alone)

**The bug this prevents.** `checkMonitor` reads `monitor.orgId` in **eight** places (probe-device selection at `monitorWorker.ts:245/259/277/301/316/331`, dedupe at `:399`, alert creation at `:438`) and `scheduleAllMonitors` enqueues one job per monitor with `monitor.orgId` (`:564-583`). With `org_id` now nullable, a partner-wide row enqueues `orgId: null` and every one of those eight reads silently matches nothing — the check just stops running, with no error. This is precisely the `eq(table.orgId, device.orgId)` no-op CLAUDE.md warns about.

- [ ] **Step 1 (RED):** `monitorWorker.test.ts` — a partner-wide `network_monitors` row with three orgs under the partner enqueues **three** jobs, one per org, each with that org's id; an org-owned row still enqueues exactly one. Red today (one job, `orgId: null`).

- [ ] **Step 2:** in `scheduleAllMonitors`, when `monitor.orgId IS NULL`, look up `organizations WHERE partner_id = monitor.partnerId` and enqueue one job per org. Cap the fan-out (e.g. skip and log if a partner has > 500 orgs) so one misconfigured partner-wide check cannot flood the queue.

- [ ] **Step 3 (RED):** a second test — inside `checkMonitor`, every read uses **`data.orgId`** (the job's), never `monitor.orgId`. Assert the created alert's `orgId` equals the job's org and its `deviceId` is a device in that org. Then replace all eight reads. Add a guard at the top of `checkMonitor`: the job's `orgId` must be either `monitor.orgId` or an org whose `partner_id = monitor.partnerId`; otherwise log and drop the job. A forged/stale queue payload must not be able to run one tenant's check against another's device.

- [ ] **Step 4:** every `network_monitor_results` insert sets `org_id: data.orgId` and `device_id` = the probe device (the columns added in Task 1 Step 5). Worker-created child rows take the **device's** org — which, by the guard above, is the job's org.

- [ ] **Step 5:**
  ```bash
  cd apps/api && npx vitest run src/jobs/monitorWorker.test.ts src/jobs/monitorWorker.dbcontext.test.ts src/jobs/monitorQueue.test.ts
  pnpm --filter @breeze/api exec tsc --noEmit
  ```
- [ ] **Step 6: commit.** `fix(monitors): fan partner-wide network checks out per org and scope results to the running org`

---

### Task 11: integration + contract suites, live DB, before the PR

**Files:**
- Create: `apps/api/src/__tests__/integration/networkMonitorPartnerRls.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/monitorWatchDelivery.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (list edits from Task 1 Step 6 — verify, don't re-edit)

Per CLAUDE.md step 6 of the partner-wide playbook, a new dual-axis table needs its own `<table>PartnerRls.integration.test.ts` proving four things against real Postgres.

- [ ] **Step 1: stand up the stack.** `pnpm test-stack up` (private pg+redis for this worktree). Remember `pnpm test-stack down` at the end — nothing reaps it.

- [ ] **Step 2: `networkMonitorPartnerRls.integration.test.ts`** — four cases:
  1. **Cross-partner forge → `42501`**: as partner A's context, insert a `network_monitors` row with `partner_id` = partner B. Must fail `new row violates row-level security policy`.
  2. **XOR → `23514`**: insert with both `org_id` and `partner_id`, and with neither. Both must fail `network_monitors_one_owner_chk`.
  3. **Org isolation**: an org-token context sees its own org's rows and its partner's partner-wide rows (via `network_monitors_partner_wide_select`), and **not** a sibling org's rows.
  4. **Fan-out**: a partner-wide row + two orgs under the partner → `scheduleAllMonitors` enqueues two jobs; results land with distinct `org_id`s. *(The spec requires one integration test proving the fan-out fires against real Postgres — this is it.)*

- [ ] **Step 3: `monitorWatchDelivery.integration.test.ts`** — a partner-wide `service` monitor attached through a partner-level policy reaches a device's `buildMonitoringConfigUpdate` **in the agent's own DB context** (set the agent GUCs the way `agentPolicyResolversPartnerWide.integration.test.ts` does — it already exercises the `monitoring:settings:device:` cache key at line 305). This is the test that catches a dropped partner-wide SELECT branch, which fails silently and only at runtime.

- [ ] **Step 4: run every contract suite that this wave can redden.** These do **not** run under `pnpm test`:
  ```bash
  cd apps/api && npx vitest run -c vitest.integration.config.ts \
    src/__tests__/integration/rls-coverage.integration.test.ts \
    src/__tests__/integration/tenantCascade.integration.test.ts \
    src/__tests__/integration/tenant-export-policy.integration.test.ts \
    src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
    src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
    src/__tests__/integration/networkMonitorPartnerRls.integration.test.ts \
    src/__tests__/integration/monitorWatchDelivery.integration.test.ts \
    src/__tests__/integration/configPolicyPartnerWideSelect.integration.test.ts
  ```
  Do **not** write `test:integration -- <paths>` — the `--` runs the whole suite.

- [ ] **Step 5: forge a cross-tenant insert by hand**, as CLAUDE.md step 6 requires:
  ```bash
  docker exec -it <worktree-pg> psql -U breeze_app -d breeze
  -- set an org context, then attempt a partner-wide insert; expect
  -- "new row violates row-level security policy for table network_monitors"
  ```

- [ ] **Step 6: drift + full targeted sweep.**
  ```bash
  export DATABASE_URL=<test-stack url> && pnpm db:migrate && pnpm db:check-drift
  cd apps/api && npx vitest run src/services/monitors src/services/alertConditions src/routes/agents src/jobs/monitorWorker.test.ts src/jobs/monitorScriptWorker.test.ts
  cd apps/web && npx vitest run src/components/monitoring src/locales
  cd agent && go test -race ./internal/monitoring/... ./internal/heartbeat/...
  cd packages/shared && npx vitest run src/validators/monitors.test.ts
  ```

- [ ] **Step 7:** `pnpm test-stack down`. Say in the PR body what, if anything, is still running.

- [ ] **Step 8: commit + PR.** `test(monitors): partner-wide network monitor RLS and monitor watch delivery integration suites`
  PR body: `Closes #5291`, the frozen-wire-shape statement, the deferred `network_monitor_results.org_id SET NOT NULL` follow-up, and the known 120s monitoring-settings cache staleness. Base the branch on `main` — never on a sibling branch. Do not hand-dispatch CI.

---

## Verification checklist (all must be true before the PR is marked ready)

- [ ] `MONITOR_KINDS.length === 18` and `MONITOR_KIND_SPECS` has an entry for each; `validateConditions(spec.toAlertCondition(sample))` returns `[]` for all 18.
- [ ] `monitoring_settings` key sets on the wire are byte-identical to `origin/main` — asserted in TS (Task 7 Step 1) **and** parsed in Go (Task 7 Step 4).
- [ ] `heartbeat.test.ts` and `helpers.partnerWidePolicies.test.ts` pass **unmodified**.
- [ ] `auto_restart` is never lowered by the monitor/policy union (Task 7 Step 2 case 5).
- [ ] Four registration lists updated for the new tables **and** the four new columns on already-registered tables; `tenantCascade.integration.test.ts` and both export-policy suites green against a live DB.
- [ ] `network_monitors` is in `DUAL_AXIS_TENANT_TABLES` and **not** in `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`.
- [ ] A partner-wide network check enqueues one job per org and every result row carries an `org_id`.
- [ ] A partner-wide `script` monitor referencing an org-owned script is refused **at save time**.
- [ ] `scriptId`, `target` and `checkType` are absent from every `overridableKeys` list.
- [ ] Every new i18n key exists with a real translation in all 8 locales.
- [ ] Migration sorts after `origin/main`'s newest; `check-migration-naming.sh --against-ref origin/main` passes; `migrationRlsScope.test.ts` baseline unchanged.
