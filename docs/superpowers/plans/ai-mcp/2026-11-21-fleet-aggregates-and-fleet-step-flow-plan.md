---
tracking_issue: LanternOps/breeze#12418
wave_issues: W01 LanternOps/breeze#12419, W02 LanternOps/breeze#12420
spec: docs/superpowers/specs/ai-mcp/2026-11-08-programmatic-tool-calling-decision.md
covers: "OD1(b) and OD3(b) of the programmatic-tool-calling decision (APPROVED 2026-11-21): richer `get_fleet_device_stats` dimensions over one shared typed filter, and the fleet-step flow bound to the existing AI ceiling"
waves: W01 shared typed fleet filter + `get_fleet_device_stats` filter / group-by / paged sample (read-only, tier 1) · W02 `run_script_on_targets` takes the same filter, AI-initiated runs freeze at most `RUN_SCRIPT_AI_MAX_DEVICES`, the approver sees count + sample + ids hash, the E4 fields land
depends_on: "W01 → W02 (W02 consumes `fleetFilterSchema`, `fleetFilterExecutionRefusedFields`, `fleetConditions`). Each wave is one PR off `main`, never stacked."
branch_pattern: feature/12418-fleet-aggregates/wave-<subissue#>
---
# Fleet aggregate dimensions and a fleet-step flow for AI (no sandbox) — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the model answers "which of our devices have X" with one exact SQL count (filtered, grouped, with a paged sample) instead of paging `query_devices`, and acts on that set through the existing fleet-step flow, where an AI-initiated run freezes at most `RUN_SCRIPT_AI_MAX_DEVICES` (10) devices under one approval that shows the count, a sample and the ids hash.

**Architecture:** one typed filter facade (`fleetFilterSchema`, shared package) compiles to the filter engine's `FilterConditionGroup` and is rendered by the engine's own SQL builder, so the count the model reads and the set a flow freezes come from the same WHERE clause. `get_fleet_device_stats` grows `filter`, `groupBy` and a paged device sample on all three schema surfaces. `run_script_on_targets` gains a `fleetFilter` selector; `executeFleetStep` applies a ceiling by run provenance; the parked intent carries the approver summary. No new table, migration, AI tool, tier or intent column; tool-index bytes unchanged.

**Tech Stack:** TypeScript, Hono, Drizzle (SQL only), Zod 4, Vitest (unit + real-Postgres integration), prom-client.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-11-08-programmatic-tool-calling-decision.md` (§2, §3 O3, §3.1, §6 E4, §8 OD1(b)/OD3(b)/OD4/OD6).

**Verified against** `origin/main` `aabccd8a6d` (2026-11-21). Paths are under `apps/api/src/` unless stated. Line numbers drift: re-grep before editing.

## Global Constraints

- **OD1(b):** only `get_fleet_device_stats` dimensions and a fleet-step flow at the **existing** ceiling. No generic `bulk_action`, no new ceiling, no sandbox, no `summarize_results`.
- **OD2 / OD6:** nothing here is provider-specific; no fleet data leaves Breeze.
- **OD3(b):** one typed filter/group-by schema shared by the stats tool and the fleet step. No tool is added or renamed, so the always-on index stays exactly **2,551 B** (`aiToolIndex.w16-budget.test.ts:25`), per-domain blocks < 2,048 B, page turns < 7,040 B, hard cap 7,680 B; the domain index renders names and action enums only, so parameters cost it nothing; `services/__snapshots__/aiAgent.fullPrompt.devicePage.txt` stays byte-identical.
- **OD4:** the ceiling is `RUN_SCRIPT_AI_MAX_DEVICES = 10` (`services/actionIntents/runScriptGroupTarget.ts:36`). Imported, never re-declared. Over the ceiling is **refused naming the count, never truncated**.
- **§3.1:** membership frozen at intent creation (`executeFleetStep` parks `frozenInputOf(input, ids)`, unchanged); approval scope follows the script (unchanged); a fleet step resolves only in the run org (`fleetTargets.ts` `inRunOrg`), so partner-wide sets cannot arise; site/device scope on the read side is the handler's (`siteScopeCondition`/`deviceScopeCondition`, `aiToolsDevice.ts:420-425`), on the flow side the flow principal model's (a site-limited triggerer is refused at `startManualRun`).
- **Tiers:** `get_fleet_device_stats` stays tier 1 (`aiAgentSdkTools.ts:380`, `aiGuardrails.ts:2319` `devices:read`, `wisp/toolSubjects.ts:111` non-focal). `run_script_on_targets` stays tier 3; `run_flow` stays tier 3 supervised. No `TOOL_TIERS` or `WISP_TOOL_SUBJECTS` entry changes.
- **Three schema surfaces:** registry `definition.input_schema` (`aiToolsDevice.ts:405`), `aiToolSchemas.ts:1739`, the SDK `tool()` Zod shape (`aiAgentSdkTools.ts:3156-3161`). `z.undefined()` is banned in any tool schema. Tool description ≤ 300 chars, every parameter description (nested included: `walkParamDescriptions`) ≤ 160 (`aiTools.descriptionBudget.contract.test.ts:17-18`).
- **Profiles:** `get_fleet_device_stats` is in neither `CHAT_MINIMAL_TOOLS` nor `CHAT_STANDARD_TOOLS` and stays out (chat `minimal` is pinned at 3,344 tokens against a 3,500 cap). Only chat `full` (128,300 ± 10 %) moves, by well under 1 %; no pin edit (`toolProfiles.prefix.contract.test.ts`).
- **Filter-field provenance (`filterEngine.ts:230-305`):** `isExecutionRefusedFilterField` names fields a device reports about itself with targeting value. Of the facade's fields, **`hostnameContains`, `tags`, `agentVersion`, `softwareInstalled`, `softwareMissing`, `softwareVersionBelow` are execution-refused**; the other nine may select targets. The read side labels them; the action side refuses them at save and again at resolve.
- **Contract suites that bite, run in each wave:** `__tests__/parkedFanout.contract.test.ts` (a new `services/*` file that reads `devices` must be classified), `services/flows/referenceFields.contract.test.ts` (new uuid-typed inputs on a flow-eligible core tool), `aiToolSchemas.constraintVisibility.test.ts`, `aiTools.descriptionBudget.contract.test.ts`, `toolSubjects.contract.test.ts`, the Lint job's area gating.
- **Paging:** offset mode (`pageParamSchema(10, 100)` / `pageZodShape(10, 100)` / `readPageArgs` / `pageEnvelope`, `aiToolPagination.ts`), bounded by `MAX_OFFSET = 10_000`, which the handler passes to `pageEnvelope` as `maxOffset` so the envelope says where paging stops; a deliberate deviation from the decision's "keyset" wording (Review round, declined item 1).
- **Public repo:** no infra details, no gap tables; current behaviour described neutrally.
- **Testing:** red first; a test that cannot fail is not written. Integration tests (`src/__tests__/integration/**`, `it.runIf(!!process.env.DATABASE_URL)`) skip silently without a database: each verify step runs them on `pnpm test-stack up` and reads the **executed** count, then `pnpm test-stack down`.

## Review Focus

1. **A filter on an agent-reported field reaches an action** (a device fabricates its software list or hostname to opt into a script run, directly or through a dynamic group). → W02 T2 `save refuses each execution-refused facade field` and the dynamic-group case, W02 T3 `an execution-refused field is targets_unresolvable without a query` and the integration `an execution-refused field resolves to a problem, not a set`; W01 T3 `a software filter is labelled execution-refused in the result`.
2. **An AI-initiated run freezes more than 10 devices**, via any selector or under a fleet pre-approval binding. → W02 T3 `it.each` over the five selectors at `maxTargets` 10, W02 T4 `it.each([11, 501])` for an ai run, plus `a bound ai run resolving 11 is refused before the pre-approval branch`.
3. **The count the model read and the set the flow froze differ** (decommissioned, ephemeral, parked or other-org device on one side only). → W02 T3 integration `the stats total equals the fleet step's resolved set`.
4. **A site-restricted or device-bound caller sees fleet-wide counts.** → W01 T3 integration `a site-restricted caller counts only its site`, `an empty site allowlist counts zero`, `a device-bound run counts only its frozen set`.
5. **The approver cannot tell what one approval covers.** → W02 T4 `an ai run resolving exactly 10 parks with the summary`, W02 T5 `a parked fleet step passes the target note as reason and approverNote` and the `riskSummary` case.

## Decisions surfaced while planning

1. **One filter, two consumers.** Both the count (W01) and the fleet step (W02) evaluate `and(...techFacingDeviceConditions(), scope, buildGroupSQL(compileFleetFilter(filter)))` through `deviceStats.ts`. The fleet step does **not** route `fleetFilter` through `resolveDeploymentTargets` (that path keeps decommissioned devices and skips the parked exclusion, so the frozen set would differ from the count); its provenance gate is re-applied in W02 T2/T3.
2. **The typed filter lives in `packages/shared`** (`validators/fleetFilter.ts`) because `FLOW_BUILTIN_STEPS` must reference it; the API keeps the compiler and the JSON-schema mirror.
3. **The AI ceiling is by run provenance, for every selector kind.** `isAiInitiatedRun(run) = run.triggerKind === 'tool' || run.triggeredVia === 'ai_tool'` (`runService.ts:250-268`: `manual` runs via `ui`/`api`/`ai_tool`; `tool` runs via `ai_tool`/`mcp`/`ai_agent`). Today every run's fleet step is bounded by `FLEET_MAX_TARGETS` (500, `packages/shared/src/validators/flowConversions.ts:120`); after W02 an AI-initiated run's fleet step is additionally bounded by `RUN_SCRIPT_AI_MAX_DEVICES`, UI/API/schedule/event/webhook runs unchanged. The W02 PR body states this.
4. **Provenance on the action side is enforced twice**: at save (`validateBuiltins.fleetIssues`, `input_invalid`) and at resolve (`targets_unresolvable`), so a document that predates the rule or a rendered template cannot slip through.
5. **No pre-approval lane for `fleetFilter` in this plan.** `fleetSelectorOf` returns `null` for it, so `fleetPreApprovalEligibility` already answers `selector_not_literal`: a `fleetFilter` step always parks for approval. `fleetBindingSchema` is untouched. Opening the lane (a schedule running a dynamic filter unattended) is a separate decision.
6. **E4 fields, no new column**: `action_intents.reason` (count, selector, ids hash, sample), `jsonb_array_length(arguments->'deviceIds')`, `source = 'flow'` joined to `flow_runs.triggered_via`; a refusal that never becomes an intent lands on the failed step row's `output` (`{ resolvedCount, ceiling, selectorKind }`) and on a counter. "Approver edited the set" is not measurable (approvals are approve/reject only) and the plan says so.
7. **Selector vocabularies.** The step input key names the selector (`fleetFilter` | `target` | `conditions` | `deviceIds` | `fromStep`); that is what the summary, the counter label and the step `output` carry. The pre-approval binding's `selector.kind` vocabulary is not extended (Decision 5).
8. **`groupBy` is one device-scalar column**, top 50 rows plus `otherCount`; NULL key renders as `"unknown"`; `siteId` rows also carry the site name as `label`. One-to-many dimensions (software, patches, alerts) filter but never group.
9. **`RUN_SCRIPT_AI_MAX_DEVICES` moves to a leaf** `services/actionIntents/runScriptLimits.ts` and is re-exported from `runScriptGroupTarget.ts` (which imports `db`, `middleware/auth`, `scriptRunTargets`), so `fleetStep.ts` and `aiToolsDevice.ts` import the constant without a cycle.
10. **A dynamic group named by `fleetFilter.groupId` is gated like every other execution target.** `deploymentTargetResolver.ts:185-204` refuses a group whose `filterFieldsUsed` contains an execution-refused field (`partitionGroupsByExecutionFieldProvenance`, `executionTargetGating.ts:39`); the fleet step applies the same partition at save (W02 T2) and again at resolve (W02 T3), so a group whose rules changed after save is still refused. The read side counts it (a count is not a target).
11. **The fleet step resolves count and ids in one statement.** `listFleetFilterDeviceIds` selects the ordered ids with `count(*) OVER ()` and `LIMIT limit + 1`, so the exact count and the (possibly over-cap) set come from one snapshot; no second query, no isolation-level change.
12. **The ceiling is applied inside `resolveFleetSelection`, parameterised by the run.** `executeFleetStep` passes `{ maxTargets: fleetActionCeiling(i.run) }`; every selector branch compares against it and an over-cap outcome carries `output: { resolvedCount, ceiling, selectorKind }` whatever the count (11 or 501), so no refusal escapes with the generic 500 message.

---

# Wave W01 — shared typed fleet filter + `get_fleet_device_stats` dimensions

**Outcome:** `get_fleet_device_stats({ orgId?, filter?, groupBy?, limit?, offset?, cursor? })` returns exact counts for the filtered set, one grouped breakdown, a paged device sample and the provenance of the fields used. Without `filter`/`groupBy` the result is byte-identical to today's. Tier 1, no new tool, index budget green, one golden prompt.

### Task 1: the shared typed filter and its compiler

**Files:**
- Create: `packages/shared/src/validators/fleetFilter.ts`; Modify: `packages/shared/src/validators/index.ts` (export)
- Create: `services/fleetFilter.ts` (pure: imports `@breeze/shared`, `./filterEngine`; issues no query)
- Modify: `services/filterEngine.ts:870` (`function buildGroupSQL` → `export function buildGroupSQL`)
- Test: `packages/shared/src/validators/fleetFilter.test.ts`, `services/fleetFilter.test.ts`

**Interfaces:**
- Consumes: `isAgentReportedFilterField`, `isExecutionRefusedFilterField`, `getFieldDefinition`, `buildGroupSQL` (`filterEngine.ts`).
- Produces (shared):
  ```ts
  export const FLEET_FILTER_GROUP_BY = ['status', 'osType', 'osVersion', 'siteId', 'agentVersion', 'deviceRole', 'architecture'] as const;
  export type FleetFilterGroupBy = (typeof FLEET_FILTER_GROUP_BY)[number];
  export const fleetFilterSchema: z.ZodObject<...>;   // .strict(); every field optional; every .describe() ≤ 160 chars
  export type FleetFilter = z.infer<typeof fleetFilterSchema>;
  ```
  Fields (facade → engine key, operator): `status` enum `['online','offline','maintenance','quarantined','updating','pending']` → `status equals` (no `decommissioned`: the count excludes it); `osType` enum `['windows','macos','linux']` → `osType equals`; `osVersionContains` string 1..100 → `osVersion contains`; `hostnameContains` string 1..200 → `hostname contains`; `siteId` / `groupId` `z.string().guid()` → `siteId equals` / `groupId equals`; `tags` string[] (each ≤ 100, max 20) → `tags hasAll`; `agentVersion` string 1..50 → `agentVersion equals`; `softwareInstalled` string 1..200 → `software.installed contains`; `softwareMissing` string 1..200 → `software.notInstalled contains`; `softwareVersionBelow` `{ name: string 1..200, version: string 1..100 matching `/^\d/` }` → `software.version below` with value `{ name, version }` (the engine throws on a version without a numeric prefix, `filterEngine.ts:527`; the JSON mirror carries `pattern: '^\\d'`); `pendingPatches` / `criticalAlerts` / `rebootRequired` boolean → `patches.pending` / `alerts.critical` / `system.rebootRequired` `equals`; `lastSeenDaysOver` integer 1..3650 → `daysSinceLastSeen greaterThan`.
- Produces (API):
  ```ts
  export function compileFleetFilter(filter: FleetFilter): FilterConditionGroup;     // { operator: 'AND', conditions }, one per present field, in the order above
  export function fleetFilterFieldsUsed(filter: FleetFilter): string[];               // engine keys, sorted, unique
  export function fleetFilterExecutionRefusedFields(filter: FleetFilter): string[];  // subset of fieldsUsed
  export function fleetFilterParamSchema(): Record<string, unknown>;                  // JSON-schema entry for `filter`: type object, additionalProperties false, 15 properties, same descriptions
  export function fleetFilterZodShape(): { filter: z.ZodOptional<typeof fleetFilterSchema>; groupBy: z.ZodOptional<z.ZodEnum<...>> };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/validators/fleetFilter.test.ts
it('accepts every documented field at once', ...);                                    // all 15 → success
it('is strict: an unknown key is refused', () => expect(fleetFilterSchema.safeParse({ hostname: 'x' }).success).toBe(false));
it('refuses decommissioned as a status', ...);
it('bounds tags to 20 entries of 100 chars', ...);                                    // 21 tags → false; one 101-char tag → false
it('requires both name and version for softwareVersionBelow, and the version starts with a digit', ...);   // { name: '7-Zip' } → false; version 'latest' → false; '23.01' → true
it('FLEET_FILTER_GROUP_BY names only device-scalar columns', () => expect(FLEET_FILTER_GROUP_BY).toEqual(['status','osType','osVersion','siteId','agentVersion','deviceRole','architecture']));
// services/fleetFilter.test.ts
it('compiles each field to the documented engine key, operator and value', () => {
  expect(compileFleetFilter({ osType: 'windows', tags: ['pci'], softwareVersionBelow: { name: '7-Zip', version: '23' }, pendingPatches: true, lastSeenDaysOver: 30 })).toEqual({ operator: 'AND', conditions: [
    { field: 'osType', operator: 'equals', value: 'windows' }, { field: 'tags', operator: 'hasAll', value: ['pci'] },
    { field: 'software.version', operator: 'below', value: { name: '7-Zip', version: '23' } },
    { field: 'patches.pending', operator: 'equals', value: true }, { field: 'daysSinceLastSeen', operator: 'greaterThan', value: 30 } ] });
});
it('an empty filter compiles to an empty AND group', ...);
it('exactly hostnameContains, tags, agentVersion and the three software fields are execution-refused', () => {
  expect(fleetFilterExecutionRefusedFields(ALL_FIELDS)).toEqual(['agentVersion', 'hostname', 'software.installed', 'software.notInstalled', 'software.version', 'tags']);
});
it('every compiled field is a key the engine defines', () => { for (const f of fleetFilterFieldsUsed(ALL_FIELDS)) expect(getFieldDefinition(f), f).toBeDefined(); });
it('the JSON mirror and the Zod shape declare the same property names and descriptions, all ≤ 160 chars', ...);
it('buildGroupSQL on a compiled software filter renders an EXISTS with the LIKE wildcard escaped', () => {
  const q = new PgDialect().sqlToQuery(buildGroupSQL(compileFleetFilter({ softwareInstalled: '100%' })));
  expect(q.sql).toMatch(/EXISTS/i); expect(q.params.join(' ')).toContain('100\\%');
});
```

- [ ] **Step 2: Run to verify they fail** — `cd packages/shared && npx vitest run src/validators/fleetFilter.test.ts`; `cd apps/api && npx vitest run src/services/fleetFilter.test.ts` → FAIL (module not found; `buildGroupSQL` not exported).
- [ ] **Step 3: Implement** the schema and constant in the shared file; the five functions and the export change in the API.
- [ ] **Step 4: Run to verify they pass** — both commands plus `npx vitest run src/services/filterEngine src/__tests__/parkedFanout.contract.test.ts` (the new file reads no `devices` table; if the contract still flags it, add it to EXEMPT with reason `pure compiler: no query, no device read`).
- [ ] **Step 5: Commit** — `feat(ai): typed fleet filter schema, compiler and provenance for AI fleet tools`.

### Task 2: counts, group-by and the device page in `deviceStats.ts`

**Files:**
- Modify: `services/deviceStats.ts`; Test: `services/deviceStats.test.ts` (extend; it mocks `../db` with a chain)

**Interfaces:**
- Consumes: `compileFleetFilter`, `buildGroupSQL` (Task 1); `techFacingDeviceConditions` (`deviceStats.ts:38-44`); `sites` (`../db/schema`).
- Produces:
  ```ts
  export function fleetFilterWhere(filter: FleetFilter | undefined): SQL | undefined;
  export function fleetConditions(scope: SQL | undefined, filter: FleetFilter | undefined): SQL[];   // [...techFacingDeviceConditions(), scope, fleetFilterWhere(filter)], undefineds dropped
  export interface FleetGroupRow { key: string; label?: string; count: number }          // label: site name when groupBy === 'siteId'
  export interface FleetDeviceStats extends DeviceStats { groups?: { by: FleetFilterGroupBy; rows: FleetGroupRow[]; otherCount: number } }
  export async function queryFleetDeviceStats(p: { scope: SQL | undefined; filter?: FleetFilter; groupBy?: FleetFilterGroupBy }): Promise<FleetDeviceStats>;
  export interface FleetDevicePageRow { id: string; hostname: string; displayName: string | null; status: string; osType: string; siteId: string; lastSeenAt: Date | null }
  export async function pageFleetDevices(p: { scope: SQL | undefined; filter?: FleetFilter; limit: number; offset: number }): Promise<FleetDevicePageRow[]>;   // ORDER BY hostname, id
  ```
  Both queries use `fleetConditions` (exported: W02 T3 builds the fleet step's id list on it, in its own classified module, so `deviceStats.ts` stays a VISIBILITY read model). `GROUP_BY_COLUMN: Record<FleetFilterGroupBy, PgColumn>`; rows ordered `count DESC, key ASC`, first 50 kept, the rest summed into `otherCount`.

- [ ] **Step 1: Write the failing tests**

```ts
it('queryFleetDeviceStats with no filter sends the same WHERE as queryDeviceStats', ...);            // render both; equal sql + params
it('a filter adds the compiled condition after the tech-facing exclusions and the scope', ...);     // sql contains "is_ephemeral"; params contain ORG and 'linux'
it('groupBy osType runs a grouped query, keeps 50 rows, sums the rest into otherCount, renders NULL as unknown', ...);   // fixture of 52 rows incl. one null key
it('groupBy siteId joins sites and fills label with the site name', ...);
it('pageFleetDevices orders by hostname then id and applies limit/offset', ...);
it('fleetConditions drops an undefined scope and an undefined filter', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/deviceStats.test.ts` → FAIL (`queryFleetDeviceStats is not a function`).
- [ ] **Step 3: Implement** the exports; `queryFleetDeviceStats` reuses `queryDeviceStats`'s per-status query over `fleetConditions`.
- [ ] **Step 4: Run to verify they pass** — plus `src/__tests__/parkedFanout.contract.test.ts`; `deviceStats.ts` keeps its VISIBILITY entry (`:136`), reason text extended to mention the filtered count and the shared condition list.
- [ ] **Step 5: Commit** — `feat(ai): filtered, grouped and paged fleet device stats`.

### Task 3: `get_fleet_device_stats` on all three schema surfaces, with the real-Postgres proof

**Files:**
- Modify: `services/aiToolsDevice.ts:399-431`, `services/aiToolSchemas.ts:1739`, `services/aiAgentSdkTools.ts:3156-3161`
- Test: `services/aiToolsDevice.fleetStats.test.ts` (extend; mocks `./deviceStats`), `services/aiToolSchemas.constraintVisibility.test.ts` (one case). `referenceFields.contract.test.ts` scans top-level uuid inputs only (`:62`), so `filter.siteId`/`filter.groupId` are not its concern; their authorization is the handler's scope (the integration cases below) and, on the action side, W02 T2.
- Create: `src/__tests__/integration/aiToolsFleetDeviceStatsFilter.integration.test.ts` (pattern: `aiToolsDeviceSoftwareScope.integration.test.ts`: `./setup`, `db-utils`, `makeAuth`, entered through `executeTool`)

**Interfaces:**
- Consumes: Task 1 (`fleetFilterParamSchema`, `fleetFilterZodShape`, `fleetFilterFieldsUsed`, `fleetFilterExecutionRefusedFields`, `FLEET_FILTER_GROUP_BY`), Task 2 (`queryFleetDeviceStats`, `pageFleetDevices`), `pageParamSchema(10, 100)`, `pageZodShape(10, 100)`, `readPageArgs`, `pageEnvelope` (`aiToolPagination.ts`).
- Produces the tool contract. Input `{ orgId?, filter?, groupBy?, limit?, offset?, cursor? }`. Output without `filter`/`groupBy`: today's `DeviceStats`, byte-identical. Otherwise today's keys plus `groups?` (when `groupBy`), `filter: { fieldsUsed: string[]; executionRefusedFields: string[] }` (when `filter`), and, when `filter` is given, the device page under `devices` in the offset envelope (`pageEnvelope({ key: 'devices', ..., total: stats.total, totalMode: 'exact' })`). Description (exact, 299 chars):
  `Exact live fleet device counts (total, online, offline, byStatus, migration and log-shipping counts), optionally narrowed by a typed filter, grouped by one dimension, with a paged device sample. Use instead of paging query_devices to count. Excludes decommissioned, parked and Quick Support devices.`

- [ ] **Step 1: Write the failing tests**

```ts
// aiToolsDevice.fleetStats.test.ts
it('without filter or groupBy the result equals today\'s counts exactly and the page query never runs', ...);
it('passes filter and groupBy through and composes the scope with the org narrowing', ...);      // m.fleet called with { filter, groupBy }; rendered scope params contain ORG
it('with a filter returns the device page in the offset envelope, default limit 10, total exact', () => {
  expect(out).toMatchObject({ showing: expect.any(Number), hasMore: expect.any(Boolean), total: counts.total, totalMode: 'exact' });
  expect(out.filter).toEqual({ fieldsUsed: ['patches.pending'], executionRefusedFields: [] });
});
it('a software filter is labelled execution-refused in the result', ...);                           // executionRefusedFields: ['software.installed']
it('a cursor minted for a different filter is refused with CURSOR_MISMATCH, not reset to page 1', ...);
it('an offset above MAX_OFFSET is clamped and the envelope carries maxOffset', ...);   // readPageArgs clamps; pageEnvelope({ ..., maxOffset: MAX_OFFSET })
it('a groupId or siteId from another org counts zero under the caller\'s scope', ...);
it('the registry schema refuses an unknown filter key and an unknown groupBy, accepts a full call', () => {
  const s = toolInputSchemas['get_fleet_device_stats']!;
  expect(s.safeParse({ filter: { hostname: 'x' } }).success).toBe(false);
  expect(s.safeParse({ groupBy: 'software' }).success).toBe(false);
  expect(s.safeParse({ filter: { osType: 'linux' }, groupBy: 'osVersion', limit: 100 }).success).toBe(true);
});
// aiToolSchemas.constraintVisibility.test.ts
it('the emitted SDK schema for get_fleet_device_stats lists filter.properties equal to fleetFilterSchema.shape keys', ...);
```
Integration (seed: partner P; org A with sites S1, S2; org B. In A: `w1` windows online S1 with `software_inventory` rows `7-Zip 23.01` and `7-Zip 22.01`; `w2` windows offline S2 with a `device_patches` row `pending`; `l1` linux online S1; `d1` windows `decommissioned` S1; `e1` windows `is_ephemeral` S1. In B: `b1` windows online with `7-Zip`):
```ts
runDb('counts the filtered set once per device and excludes decommissioned, ephemeral and other-org devices', () => { /* softwareInstalled '7-Zip' → total 1, devices [w1], executionRefusedFields ['software.installed'] */ });
runDb('groups windows devices by site with exact counts and site names', ...);     // rows [{S1,'Site 1',1},{S2,'Site 2',1}], otherCount 0, total 2
runDb('a site-restricted caller counts only its site', ...);                      // allowedSiteIds [S1], osType windows → total 1
runDb('an empty site allowlist counts zero', ...);                                // total 0, devices []
runDb('a device-bound run counts only its frozen set', ...);                      // allowedDeviceIds [w2], groupBy status → total 1
runDb('pending-patch filter matches w2 only', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/aiToolsDevice.fleetStats.test.ts src/services/aiToolSchemas.constraintVisibility.test.ts` → FAIL (handler ignores `filter`; registry strips it). `pnpm test-stack up && DATABASE_URL=<stack> npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiToolsFleetDeviceStatsFilter.integration.test.ts` → FAIL with **6 executed** (`total` is 5, no `devices` key).
- [ ] **Step 3: Implement on all three surfaces.** Registry: `properties = { orgId, filter: fleetFilterParamSchema(), groupBy: { type: 'string', enum: FLEET_FILTER_GROUP_BY, description }, ...pageParamSchema(10, 100) }` and the description above. `aiToolSchemas.ts`: `z.object({ orgId: uuid.optional(), ...fleetFilterZodShape(), ...pageZodShape(10, 100) })`; the same shape in the `tool()` call. Handler: scope composition at `:420-425` unchanged; without `filter`/`groupBy` the existing `queryDeviceStats` path returns as today; otherwise `readPageArgs` (its error object on `ok: false`), `queryFleetDeviceStats`, `pageFleetDevices` only when `filter` is present, `pageEnvelope`, plus `filter: { fieldsUsed, executionRefusedFields }`.
- [ ] **Step 4: Run to verify they pass, plus budget and contract suites** — `npx vitest run src/services/aiToolsDevice.fleetStats.test.ts src/services/aiToolSchemas.constraintVisibility.test.ts src/services/aiToolSchemas.validateToolInput.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiToolIndex.w16-budget.test.ts src/services/aiToolIndex.test.ts src/services/aiAgent.toolIndexPrompt.test.ts src/services/aiModels/toolProfiles.prefix.contract.test.ts src/services/flows/referenceFields.contract.test.ts src/services/wisp/toolSubjects.contract.test.ts` → PASS, `B1` 2551, `git status` shows no diff under `services/__snapshots__/`. Integration command again → PASS, 6 executed; `pnpm test-stack down`.
- [ ] **Step 5: Commit** — `feat(ai): get_fleet_device_stats takes a typed filter, groupBy and a paged sample on all three schema surfaces`.

### Task 4: golden prompt and wave verification

**Files:** `services/llm/toolEval/goldenPrompts.ts` (append), `services/llm/toolEval/goldenPrompts.test.ts:48-49` (pins 142 → 143)

- [ ] **Step 1: Make the length pin fail first** — change both `142` to `143`, add `// g143 (#12418 W01): filtered fleet count with a breakdown.` to the comment block; `npx vitest run src/services/llm/toolEval/goldenPrompts.test.ts` → FAIL.
- [ ] **Step 2: Add the case** `{ id: 'g143', prompt: 'How many Windows devices at Contoso still have pending patches, broken down by site?', expect: [{ tool: 'get_fleet_device_stats' }] }` → PASS.
- [ ] **Step 3: Wave verification** — `cd apps/api && npx vitest run src/services/aiTools src/services/aiToolSchemas src/services/aiToolIndex src/services/aiAgent.toolIndexPrompt.test.ts src/services/aiAgentSdkTools src/services/deviceStats src/services/fleetFilter src/services/flows/referenceFields.contract.test.ts src/__tests__/parkedFanout.contract.test.ts src/services/wisp/toolSubjects.contract.test.ts src/services/aiModels src/services/llm/toolEval`; `pnpm --filter @breeze/shared test --run`; `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo exit=$?` (read the exit code; never pipe to `tail`). PR body carries the `B1` line, the chat `full` prefix value, and the executed integration count (6).
- [ ] **Step 4: Commit** — `test(ai): golden prompt for a filtered fleet count`.

---

# Wave W02 — the fleet-step flow at the AI ceiling

**Outcome:** `run_script_on_targets` accepts the same `fleetFilter`; a fleet step of an AI-initiated run freezes at most `RUN_SCRIPT_AI_MAX_DEVICES` devices or refuses naming the count; the approver's card reads count, sample and ids hash; the E4 fields are durable. Tiers, approval scopes and the org floor unchanged.

### Task 1: `fleetFilter` selector on the shared step schema

**Files:** `packages/shared/src/flows/builtins.ts:181-200`; test `packages/shared/src/flows/builtins.test.ts` (extend)

**Interfaces:** `run_script_on_targets.inputSchema` gains `fleetFilter: fleetFilterSchema.optional()`; `exactlyOne(['target', 'conditions', 'deviceIds', 'fromStep', 'fleetFilter'])`; `RunScriptOnTargetsInput` (`services/flows/builtins/runScriptOnTargets.ts:44`) gains `fleetFilter?: FleetFilter`. The step `description` string is unchanged.

- [ ] **Step 1: Write the failing tests** — `it('run_script_on_targets accepts a fleetFilter selector alone')`, `it('fleetFilter beside target is refused (exactly one selector)')`, `it('an unknown key inside fleetFilter is refused')`.
- [ ] **Step 2: Run to verify they fail** — `cd packages/shared && npx vitest run src/flows/builtins.test.ts` → FAIL (unknown key `fleetFilter`).
- [ ] **Step 3: Implement.** **Step 4: Run to verify they pass.** **Step 5: Commit** — `feat(flows): run_script_on_targets takes the typed fleetFilter selector`.

### Task 2: owned references and the save-time provenance rule

**Files:** `services/flows/validateBuiltins.ts:255-300` (`fleetBuiltinReferences`, `fleetIssues`); tests `services/flows/validateBuiltins.test.ts`, `services/flows/fleetPreApproval.test.ts` (one pin each)

**Interfaces:**
- Consumes: `fleetFilterExecutionRefusedFields` (W01 T1); `partitionGroupsByExecutionFieldProvenance(rows: { id; filterFieldsUsed }[])` (`executionTargetGating.ts:39`); a new sibling of `findOwnedDeviceGroupIds` (`validateBuiltins.ts:~320`): `findOwnedDeviceGroups(orgId, ids): Promise<Map<string, { filterFieldsUsed: string[] | null }>>`; the existing function is unchanged.
- Produces: `fleetBuiltinReferences('run_script_on_targets', { fleetFilter: { groupId } })` yields `{ kind: 'group', value, path: '/fleetFilter/groupId' }`; `fleetIssues` pushes `issue('input_invalid', \`fleetFilter matches on field(s) a device reports about itself (${keys.join(', ')}); a script cannot be targeted by them.\`, at('/fleetFilter'))` when `fleetFilterExecutionRefusedFields` is non-empty, and `issue('input_invalid', 'This device group is defined by field(s) a device reports about itself; a script cannot be targeted by it.', at('/fleetFilter/groupId'))` when the owned group is in the partition's `refusedGroups` (Decision 10).

- [ ] **Step 1: Write the failing tests**

```ts
// validateBuiltins.test.ts
it.each(['hostnameContains', 'tags', 'agentVersion', 'softwareInstalled', 'softwareMissing', 'softwareVersionBelow'])('save refuses fleetFilter.%s with input_invalid at /fleetFilter naming the engine key', ...);
it('save refuses fleetFilter.groupId naming a group the owner does not hold (reference_not_owned at /fleetFilter/groupId)', ...);
it('save refuses fleetFilter.groupId naming a dynamic group whose rules use hostname or software.* (input_invalid at /fleetFilter/groupId)', ...);
it('save accepts fleetFilter { osType, pendingPatches, siteId, lastSeenDaysOver } and a static group with no issue', ...);
// fleetPreApproval.test.ts
it('a fleetFilter step is ineligible for the fleet pre-approval lane (selector_not_literal): it always parks', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/flows/validateBuiltins.test.ts src/services/flows/fleetPreApproval.test.ts` → the `validateBuiltins` cases FAIL; the eligibility pin passes already (it guards Decision 5).
- [ ] **Step 3: Implement** the two edits. **Step 4: Run to verify they pass** plus `src/services/flowValidator`. **Step 5: Commit** — `feat(flows): fleetFilter references are owned and agent-reported fields are refused at save`.

### Task 3: resolving `fleetFilter` once in the run org, with the parity proof

**Files:**
- Modify: `services/flows/builtins/fleetTargets.ts` (add `resolveFleetFilterOnce`; `inRunOrg` stays private), `services/flows/builtins/runScriptOnTargets.ts:73-96` (`resolveFleetSelection` branch)
- Test: `services/flows/builtins/runScriptOnTargets.test.ts` (extend with a `resolveFleetSelection` describe; mock `./fleetTargets`)
- Create: `src/__tests__/integration/flowFleetFilterParity.integration.test.ts`

**Interfaces:**
- Consumes: `fleetConditions` (W01 T2), `fleetFilterExecutionRefusedFields` (W01 T1), `partitionGroupsByExecutionFieldProvenance`, `FLEET_MAX_TARGETS`, `overCapMessage` (`resolveTargets.ts:45`).
- Produces (`fleetTargets.ts`):
  ```ts
  export async function listFleetFilterDeviceIds(p: { orgId: string; filter: FleetFilter; limit: number }): Promise<{ total: number; ids: string[] }>;   // ONE statement: ids ORDER BY id with count(*) OVER () AS total, LIMIT limit + 1 (Decision 11); ids sliced to limit
  export async function resolveFleetFilterOnce(run: FleetRunOrg, filter: FleetFilter, limit: number): Promise<{ count: number; deviceIds: string[]; problems: string[] }>;
  ```
  `resolveFleetFilterOnce` runs inside `inRunOrg`: execution-refused facade fields → one `problems` entry, no query; `filter.groupId` naming a group in `refusedGroups` of the partition (loaded in the run org with `filterFieldsUsed`) → one `problems` entry (Decision 10); else `listFleetFilterDeviceIds`, `count = total`, `deviceIds = count <= limit ? ids : []`.
  `resolveFleetSelection(input, ctx, verified?, opts: { maxTargets?: number } = {})` (`runScriptOnTargets.ts:73`): `const cap = opts.maxTargets ?? FLEET_MAX_TARGETS`; every branch compares against `cap` (the `deviceIds`/`fromStep` branch at `:91`, the `target`/`conditions` branch on `resolved.deviceIds.length`, and the new `fleetFilter` branch placed before `target`/`conditions`); an over-cap outcome is `{ kind: 'failed', code: 'targets_over_cap', policy: true, message: cap < FLEET_MAX_TARGETS ? aiCeilingMessage(count) : overCapMessage(count), output: { resolvedCount: count, ceiling: cap, selectorKind: fleetSelectorName(input) } }`; problems → `policy('targets_unresolvable', …)`; else `{ kind: 'set', requested: deviceIds, found: deviceIds, warnings: [] }`. `aiCeilingMessage(n)` and `fleetSelectorName(input)` (and `FleetSelectorName`) are defined **here, in `runScriptOnTargets.ts`** (`fleetStep.ts` imports from it already; the reverse import would be a cycle); T4 consumes them. Callers that pass no `opts` are unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it('a fleetFilter selector resolves inside the run-org DB context, never system scope', ...);
it('an execution-refused field is targets_unresolvable without a query', ...);
it('a dynamic group whose rules changed to a refused field after save is targets_unresolvable at resolve', ...);
it('a fleetFilter above FLEET_MAX_TARGETS is targets_over_cap naming the count, with output { resolvedCount, ceiling: 500, selectorKind: "fleetFilter" }', ...);
it.each(['fleetFilter', 'deviceIds', 'fromStep', 'target', 'conditions'])('maxTargets 10 refuses 11 via %s with ceiling 10 in output; 10 resolves', ...);
it('requested equals found for a fleetFilter set', ...);
it('listFleetFilterDeviceIds returns total and at most limit ids from one statement', ...);   // the db chain mock sees exactly one select
```
Integration (seed as W01 T3; filter `{ osType: 'windows' }`):
```ts
runDb('the stats total equals the fleet step\'s resolved set for the same filter in the same org', () => {
  /* executeTool stats with orgId A → total 2; resolveFleetFilterOnce({ orgId: A, partnerId: P }, filter, FLEET_MAX_TARGETS) → count 2, deviceIds == stats.devices ids sorted; none of d1, e1, b1 */
});
runDb('a partner-wide count is wider than any one run org\'s set (a flow never crosses orgs)', ...);   // partner auth, no orgId → total 3; run org A → 2
runDb('an execution-refused field resolves to a problem, not a set', ...);                              // softwareInstalled → problems.length 1, deviceIds []
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/flows/builtins/runScriptOnTargets.test.ts` → FAIL; the integration file on the test stack → FAIL with **3 executed** (`resolveFleetFilterOnce` absent).
- [ ] **Step 3: Implement.** **Step 4: Run to verify they pass** plus `src/__tests__/parkedFanout.contract.test.ts`: `fleetTargets.ts` is a VISIBILITY entry today (`:162`, "its own query only re-reads those ids"), which the new selecting query falsifies — move it to `FANOUT_MODULES` in `__tests__/parkedFanoutModules.ts` with the guard count the contract reports and a reason naming `fleetConditions`/`notParkedDeviceCondition` as the parked guard; and the integration file (3 executed); `pnpm test-stack down`.
- [ ] **Step 5: Commit** — `feat(flows): resolve the fleetFilter selector once in the run org`.

### Task 4: the AI ceiling by run provenance, with the E4 refusal record

**Files:**
- Create: `services/actionIntents/runScriptLimits.ts` (Decision 9; a constant-only file: `parkedFanout.contract.test.ts` must pass without an entry, else EXEMPT with reason `constants only`); Modify: `services/actionIntents/runScriptGroupTarget.ts:36` (import + `export { RUN_SCRIPT_AI_MAX_DEVICES } from './runScriptLimits'`)
- Modify: `services/flows/fleetStep.ts:38-103`, `services/flows/flowTriggerMetrics.ts`
- Test: `services/flows/fleetStep.test.ts` (extend; `input(run)` fixture at `:57` takes `triggerKind`/`triggeredVia`), Create `services/flows/flowTriggerMetrics.test.ts`

**Interfaces:**
- Consumes: `RUN_SCRIPT_AI_MAX_DEVICES`, `groupTargetIdsHash(sortedIds)` (`runScriptGroupTarget.ts:70`), `FLEET_MAX_TARGETS`, `resolveDeviceIdsInRunOrg` (`fleetTargets.ts:86`, for the sample hostnames).
- Produces (`fleetStep.ts`):
  ```ts
  export function isAiInitiatedRun(run: Pick<FlowRunRow, 'triggerKind' | 'triggeredVia'>): boolean;   // Decision 3
  export function fleetActionCeiling(run: Pick<FlowRunRow, 'triggerKind' | 'triggeredVia'>): number;  // RUN_SCRIPT_AI_MAX_DEVICES | FLEET_MAX_TARGETS
  export type FleetSelectorName = 'fleetFilter' | 'target' | 'conditions' | 'deviceIds' | 'fromStep';
  export function fleetSelectorName(input: RunScriptOnTargetsInput): FleetSelectorName;
  export interface FleetTargetSummary { count: number; idsHash: string; selector: FleetSelectorName; sampleHostnames: string[] }   // ≤ 5, sorted by hostname
  ```
  `export function aiCeilingMessage(n: number): string` = (exact copy) `` `The selection resolved to ${n} devices; a run started by the AI assistant may target at most ${RUN_SCRIPT_AI_MAX_DEVICES}. Narrow the filter or name the devices. Nothing was run.` ``.
  `FleetStepDeps.park` becomes `(frozenInput, summary: FleetTargetSummary) => Promise<StepOutcome>`. `executeFleetStep` calls `resolveFleetSelection(input, ctx, undefined, { maxTargets: fleetActionCeiling(i.run) })` (Decision 12); when the outcome is `targets_over_cap` and `isAiInitiatedRun(i.run)` it calls `recordFleetStepAiCeilingRefused({ selector })` before returning it. The check therefore precedes the pre-approval branch for every run.
  `flowTriggerMetrics.ts`: Counter `flow_fleet_step_ai_ceiling_refused_total`, label `selector`, `registers: [metricsRegistry]`; `export function recordFleetStepAiCeilingRefused(labels: { selector: FleetSelectorName }): void`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('AI ceiling (#12418 W02, decision OD4)', () => {
  it('passes maxTargets = RUN_SCRIPT_AI_MAX_DEVICES to resolveFleetSelection for an ai run and FLEET_MAX_TARGETS for a ui run', ...);   // m.select call args
  it.each([11, 501])('an ai_tool run whose selection is refused at %i devices returns the AI message naming the count and 10, output { resolvedCount, ceiling: 10, selectorKind }, counter incremented, park never called', ...);
  it('a ui run refused at 501 keeps overCapMessage and does not touch the counter', ...);
  it('a bound ai run resolving 11 is refused before the pre-approval branch', ...);           // binding lane 'fleet', triggerKind 'tool' → refused, snapshot never built
  it('a tool run (ai_agent / mcp) is AI-initiated; a ui, api, schedule, event or webhook run is not', ...);   // table over isAiInitiatedRun
  it('an ai run resolving exactly 10 parks with exactly those 10 frozen and a summary', () => {
    expect(deps.park).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: ids(10) }), { count: 10, idsHash: groupTargetIdsHash(ids(10)), selector: 'fleetFilter', sampleHostnames: expect.any(Array) });
    const sample = deps.park.mock.calls[0][1].sampleHostnames; expect(sample.length).toBeLessThanOrEqual(5); expect(sample).toEqual([...sample].sort());
  });
  it('a ui run resolving 11 devices still parks (FLEET_MAX_TARGETS governs it)', ...);
  it('a schedule run with a binding and 11 devices is unchanged (binding_drift above maxTargets, as before)', ...);
});
// flowTriggerMetrics.test.ts
it('recordFleetStepAiCeilingRefused increments flow_fleet_step_ai_ceiling_refused_total with the selector label', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/flows/fleetStep.test.ts src/services/flows/flowTriggerMetrics.test.ts` → FAIL (`resolveFleetSelection` called without `opts`; `park` called with one argument).
- [ ] **Step 3: Implement.** `frozenInputOf` unchanged (the intent's `deviceIds` shape is what the release worker and the digest read).
- [ ] **Step 4: Run to verify they pass** — same files; `stepExecutor.test.ts` may not compile until Task 5 (finish Task 5 before the wave run).
- [ ] **Step 5: Commit** — `feat(flows): AI-initiated runs freeze at most RUN_SCRIPT_AI_MAX_DEVICES devices in a fleet step; refusals are recorded`.

### Task 5: the approver's summary on the parked intent

**Files:** `services/actionIntents/intentService.ts:208-232` (`CreateActionIntentInput` gains `approverNote?: string`), `:2272` (`impactSummary` = base summary + `' ' + approverNote` when present: this is "what the approver READS" and becomes the approval row's `riskSummary`, `:1117`); `services/flows/stepExecutor.ts:427-440` (`parkForApproval` opts gain `note?: string`, passed as both `reason` and `approverNote`), `:597` (`park: (frozen, summary) => parkForApproval(i, frozen, { builtin: true, note: fleetTargetNote(summary) })`); `services/flows/fleetStep.ts` (`fleetTargetNote`); tests `services/flows/stepExecutor.test.ts` (extend the fleet park case), `services/actionIntents/intentService.invokedFlow.test.ts` (one case)

**Interfaces:** `export function fleetTargetNote(s: FleetTargetSummary): string` = `` `Fleet step resolved ${count} device${count === 1 ? '' : 's'} via ${selector} (ids sha256 ${idsHash}); later membership changes do not change this run.${sampleHostnames.length ? ` Sample: ${sampleHostnames.join(', ')}.` : ''}` ``. `reason` is the durable E4 field (`action_intents.reason`, `text`, already `included` in the export policy, `tenantExportPolicyRegistry.ts:76`); `approverNote` is what the card shows (`impact_summary` is `text`, feeds no digest: `argument_digest` and `effect_digest` are computed from arguments). The note is bounded by construction (five hostnames ≤ 255 chars each plus fixed copy); `fleetTargetNote` caps it at 600 chars with `cutReason`-style slicing (`resolveTargets.ts:41`). The flow `actionLabel` (`Step <id>: <tool>`, `:2291`) is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// stepExecutor.test.ts
it('a parked fleet step passes the target note as reason and approverNote', () => {
  const note = expect.stringMatching(/resolved 3 devices via fleetFilter \(ids sha256 [0-9a-f]{12}\)/);
  expect(createActionIntent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: 'flow', toolName: 'run_script_on_targets', reason: note, approverNote: note }));
});
// intentService.invokedFlow.test.ts
it('a flow-source intent stores reason and its approval rows\' riskSummary ends with the approverNote', ...);
```

- [ ] **Step 2: Run to verify they fail.** **Step 3: Implement.** **Step 4: Run to verify they pass** plus `src/services/flows/fleetStep.test.ts src/services/actionIntents/intentService`. **Step 5: Commit** — `feat(flows): the parked fleet-step intent tells the approver the count, a sample and the ids hash`.

### Task 6: the model learns the ceiling; golden prompt; wave verification

**Files:** `services/aiToolsDevice.ts` (filtered result gains `aiActionLimit`), `services/aiToolsDevice.fleetStats.test.ts`, `services/llm/toolEval/goldenPrompts.ts`, `.test.ts` (pins 143 → 144)

- [ ] **Step 1: Write the failing tests** — `it('with a filter the result carries aiActionLimit = RUN_SCRIPT_AI_MAX_DEVICES')` (`expect(out.aiActionLimit).toBe(10)`), `it('without a filter the result stays byte-identical to today\'s counts')`; golden pins to 144 with `// g144 (#12418 W02): count first, then a fleet-step flow draft.` and the case `{ id: 'g144', prompt: 'Set up a flow that runs the "Clear Teams cache" script on every Contoso laptop with pending patches, and tell me how many that is first.', expect: [{ tool: 'get_fleet_device_stats' }, { tool: 'draft_flow' }, { tool: 'list_scripts' }] }`.
- [ ] **Step 2: Run to verify they fail.** **Step 3: Implement** (`aiActionLimit` on the filtered path only, imported from `actionIntents/runScriptLimits.ts`). **Step 4: Run to verify they pass.**
- [ ] **Step 5: Wave verification** — `cd apps/api && npx vitest run src/services/flows src/services/actionIntents src/services/aiToolsDevice src/services/aiToolSchemas src/services/aiToolIndex src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiModels/toolProfiles.prefix.contract.test.ts src/services/wisp/toolSubjects.contract.test.ts src/services/flows/referenceFields.contract.test.ts src/__tests__/parkedFanout.contract.test.ts src/services/llm/toolEval`; `pnpm --filter @breeze/shared test --run`; both integration files on the test stack (6 and 3 executed), then `pnpm test-stack down`; `tsc` with the exit code read. PR body states: (a) Decision 3's provenance ceiling, (b) tiers and approval scopes unchanged, (c) index bytes unchanged, (d) the E4 query recipe: `action_intents` where `source = 'flow' and action_name = 'run_script_on_targets'` joined to `flow_runs.triggered_via`, `jsonb_array_length(arguments->'deviceIds')`, `reason`; refusals from `flow_run_steps` where `error_code = 'targets_over_cap'` with `output->>'resolvedCount'`, and the counter.
- [ ] **Step 6: Commit** — `feat(ai): fleet stats tell the model the AI action limit; golden prompt for a fleet-step flow`.

---

## Out of scope (deliberate)

- A raised ceiling, a generic `bulk_action`, `run_script { filter }` in chat, the decision's `summarize_results` bullet, O3b/O1/O2 (decision §7 triggers).
- `query_devices` or `resolve_targets` adopting the typed filter; keyset paging of the filtered set (Review round, declined item 1).
- A fleet pre-approval lane for `fleetFilter` (Decision 5); new filter-engine fields; profile list changes; docs pages (`update-breeze-docs` after both waves ship); a flow-editor UI for `fleetFilter`.

## Review round

One independent read-only round (Codex `gpt-6-astra`, reasoning `xhigh`, 2026-11-21) against the spec and the tree at `aabccd8a6d`; nine findings: one blocker, four majors, four minors. **Verdict: the reviewer reported no task beyond the approved scope and no spec requirement without a task; the blocker, three majors and all four minors are folded; one major is declined (below).**

Folded: dynamic-group provenance for `fleetFilter.groupId` at save and resolve (Decision 10, W02 T2/T3); the approver's summary now reaches the card (`approverNote` → `impactSummary`/`riskSummary`, W02 T5), not only the audit `reason`; the AI ceiling applies inside `resolveFleetSelection` so a 501-device AI selection gets the AI message, the `output` record and the counter (Decision 12, W02 T3/T4); count and ids come from one statement (Decision 11); the fleet step's id list lives in `fleetTargets.ts`, which moves from VISIBILITY to `FANOUT_MODULES` because it now selects targets itself, while `deviceStats.ts` stays VISIBILITY; `softwareVersionBelow.version` requires a numeric prefix on all three surfaces; the prompt-snapshot test is named explicitly (`aiAgent.toolIndexPrompt.test.ts`); the nested-uuid contract conditional is replaced by explicit scope tests.

Declined: (1) **genuine keyset paging** of the filtered device sample. The decision names keyset for "the full set"; this plan pages a stable `ORDER BY hostname, id` list in offset mode, bounded by `MAX_OFFSET` with the envelope's clamp field tested (W01 T3). The repo's envelope rule reserves keyset for churn tables; the count the model needs is `total`, exact on page 1, and a 10,000-row sample is already beyond what a chat turn can use. If a measured fleet question needs the full id list, `export_dataset` (`device_inventory`) is the path, not a longer page walk. Todd decides whether this deviation stands.
