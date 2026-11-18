---
spec: docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md
wave_map: docs/superpowers/plans/ai-mcp/2026-11-13-wisp-analysis-sessions-w00-wave-map-and-contracts.md
---

# Wisp Analysis Sessions W06: Surfaces, Guidance, Docs, Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician can see an analysis chain: the chat run card says which step a run is and lists its findings and output files, the run page lists every step of the chain and the run's device scope, Wisp is told how to scope and continue an analysis, the docs explain chains and the budget that usually stops them, and one Wisp eval scenario runs a three-step org-scope chain.

**Architecture:** The run-detail DTO (`GET /ai/agents/runs/:runId`) gains the lineage columns, the analysis goal, the frozen scope and the chain list, all additive. The chain is read in the same route, under the request's DB context, pinned to the run's org. The chat card and the run page already poll that DTO, so neither gets a new endpoint. Wisp guidance goes into the `launch_specialist` parameter text (keys) and into the message an admitted analysis launch returns (how to continue), because the tool description is at its length cap.

**Tech Stack:** Hono + Drizzle (API), Vitest, React islands in Astro (web) with react-i18next, Starlight MDX (docs), the Node/Playwright Wisp eval harness in `e2e-tests/wisp-eval/`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md` §4.5, plus the docs and eval items in §6 (W05 row) and §7 ("Eval"). Wave numbering per the W00 map: this is plan wave **W06** (spec wave W05).

## Global Constraints

- No new flag. Everything sits behind `aiWorkspaceEnabled()` and `wispEnabled()` (`apps/api/src/config/env.ts:353`). With either off nothing changes.
- **Consumes, as already merged (W00 contracts, not in the code at plan time):**
  - C4 (W03): `ai_agent_runs.continued_from_run_id uuid null`, `chain_root_run_id uuid null`, `chain_depth smallint not null default 0`; Drizzle `continuedFromRunId`, `chainRootRunId`, `chainDepth`; partial index `ai_agent_runs_chain_root_idx` on `(org_id, chain_root_run_id) WHERE chain_root_run_id IS NOT NULL`. `chain_root_run_id` is null on a run that continues nothing (including the root itself).
  - C2 (W02): `AiAgentRunStagedInputs.scope?: { kind: 'devices' | 'site' | 'org'; siteId: string | null; deviceCount: number }` (`apps/api/src/db/schema/aiAgents.ts`). Optional: a run admitted before W02 lacks it.
  - C1 (W02, W03): `analysisParamsSchema` has `scope: z.enum(['devices','site','org']).optional()` and `continueFromRunId: z.uuid().optional()` (`apps/api/src/services/wisp/specialistLaunchers.ts`).
  - W01: a settled analysis run's result reaches the next chat turn in the `[breeze:analysis-results]` block with its run id and its `output` files by handle; `trigger_ref.goal` holds the goal (`analysisAdmission.ts:198`).
  - C3 (W03): `analysisMaxChainDepth` default 8, `analysisMaxChainRuns` default 12, `analysisMaxChainBudgetCents` default 600.
- `AI_AGENT_RUN_DTO_SCHEMA_VERSION` stays `1`. Every new DTO field is always present and nullable (or a number defaulting to 0), which `packages/shared/src/types/aiAgentRuns.ts:71-83` says does not bump the version. Its only readers are the DTO builders and the web; nothing branches on its value.
- Run DTO reads stay on the request's DB context (`db` inside the route; RLS applies). Every new read carries `eq(<table>.orgId, run.orgId)` **and** `auth.orgCondition(...)`, as the route's existing subsidiary reads do (`apps/api/src/routes/aiAgents.ts:1529-1538`).
- Goal text is the model's restatement of the person's ask. It is rendered as a React text child only (never `dangerouslySetInnerHTML`) and capped on the wire at `AI_AGENT_RUN_GOAL_MAX_CHARS = 300` characters including a trailing `…`.
- No new `apps/api/src/services` file (avoids the parked-fanout/area-gating classification); projections go in `services/aiAgents/runTrace.ts`, reads in the route.
- Tool text caps (`aiTools.descriptionBudget.contract.test.ts:17-18`): tool description ≤ 300 chars, every parameter description ≤ 160 chars, and no `step \d` / `first call` / `then call` / `after that` / `workflow:` in a tool description (`WORKFLOW_PROSE`, line 19).
- Web: a new `en` key goes into all 8 locales: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` (`apps/web/src/locales/`). Translated values must differ from English or the namespace baseline in `src/lib/i18n/translationCoverage.test.ts` fails; plural suffixes follow the sibling keys in the same file. Everything a Playwright test could target gets a `data-testid`. This wave adds no mutation and no transient UI state, so no `runAction` and no hash state.
- No internal hosts, IPs or tokens in code, tests, docs or scenario files.
- Tests: `cd apps/api && npx vitest run <path>`, `cd apps/web && npx vitest run <path>`, `cd packages/shared && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`. Red first.

## Review Focus

1. **A root run that was continued later.** The root has `chain_root_run_id = null` and `chain_depth = 0`, but its card and run page must still show the chain. The chain read keys on `run.chainRootRunId ?? run.id`; Task 2 has the test.
2. **Branching.** Two continuations of the same prior run are both "Step 2". The list must be deterministic (depth, then queued time, then id) and show both rows. Task 1 has the test.
3. **Missing data.** A run admitted before W02 has no `staged_inputs.scope`; a run before W03 has null lineage; during a rolling deploy the web can be ahead of the API and every new field is `undefined`. None of these may blank the card or the run page. Tasks 1, 3 and 4 test it.
4. **Tenant pin on the chain read.** A partner-scoped caller's `auth.orgCondition` spans sibling orgs, so the chain read must also bind `run.orgId`. Task 2 asserts the bound parameter.
5. **Expired output files on the card.** Artifacts expire after 30 days. The card must not offer a download that will 404: an expired `output` file is left off the card (the run page already shows "expired"). Task 3 has the test.

---

### Task 1: Shared DTO fields and pure projections

**Files:**
- Modify: `packages/shared/src/types/aiAgentRuns.ts:94` (constants), `:652-821` (`AiAgentRunDetailDto`)
- Modify: `apps/api/src/services/aiAgents/runTrace.ts:54-134` (`RunTraceRunInput`), `:519-681` (`buildRunTrace`)
- Test: `apps/api/src/services/aiAgents/runTrace.test.ts`

**Interfaces:**
- Produces (shared, exported from `@breeze/shared`):
  ```ts
  export const AI_AGENT_RUN_GOAL_MAX_CHARS = 300;
  export const AI_AGENT_RUN_CHAIN_MAX_STEPS = 50;
  export interface AiAgentRunAnalysisScopeDto {
    kind: 'devices' | 'site' | 'org';
    siteId: string | null;
    siteName: string | null;
    deviceCount: number;
  }
  export interface AiAgentRunChainStepDto {
    id: string;
    step: number;                      // chain_depth + 1
    continuedFromRunId: string | null;
    goal: string | null;               // capped at AI_AGENT_RUN_GOAL_MAX_CHARS
    status: AiAgentRunStatus;
    costCents: number;                 // cost_cents + compute_cents
    queuedAt: string;
  }
  // added to AiAgentRunDetailDto, each with a docstring saying "Additive — does NOT bump":
  continuedFromRunId: string | null;
  chainRootRunId: string | null;
  chainDepth: number;
  analysisGoal: string | null;
  analysisScope: AiAgentRunAnalysisScopeDto | null;
  chain: AiAgentRunChainStepDto[] | null;   // null unless the chain has >= 2 runs
  ```
- Produces (`runTrace.ts`):
  ```ts
  export interface RunTraceChainRowInput {
    id: string; continuedFromRunId: string | null; chainDepth: number;
    status: AiAgentRunStatus; costCents: number; computeCents: number | null;
    goal: string | null; queuedAt: Date;
  }
  export interface RunTraceAnalysisInput { chainRows: RunTraceChainRowInput[]; siteName: string | null }
  export function capRunGoal(goal: unknown): string | null;
  export function projectAnalysisScope(
    stagedInputs: AiAgentRunStagedInputs | null | undefined, siteName: string | null,
  ): AiAgentRunAnalysisScopeDto | null;
  export function projectRunChain(rows: RunTraceChainRowInput[]): AiAgentRunChainStepDto[] | null;
  ```
  `RunTraceRunInput` gains optional `continuedFromRunId?: string | null`, `chainRootRunId?: string | null`, `chainDepth?: number | null`, `stagedInputs?: AiAgentRunStagedInputs | null`. `buildRunTrace` gains a final parameter `analysisInput: RunTraceAnalysisInput | null = null`, after `workspace`.

- [ ] **Step 1: Write the failing tests** in `runTrace.test.ts`, a new `describe('analysis chain and scope (W06)', …)`:

```ts
const base = { /* reuse the file's existing minimal RunTraceRunInput fixture */ };
const row = (o: Partial<RunTraceChainRowInput>): RunTraceChainRowInput => ({
  id: 'r0', continuedFromRunId: null, chainDepth: 0, status: 'completed',
  costCents: 40, computeCents: 9, goal: 'g', queuedAt: new Date('2026-11-13T10:00:00Z'), ...o,
});

it('projectRunChain is null for an unchained run (fewer than two rows)', () => {
  expect(projectRunChain([])).toBeNull();
  expect(projectRunChain([row({})])).toBeNull();
});

it('projectRunChain orders by depth, then queued time, then id, and numbers steps from depth', () => {
  const steps = projectRunChain([
    row({ id: 'b2', chainDepth: 1, continuedFromRunId: 'r0', queuedAt: new Date('2026-11-13T10:05:00Z') }),
    row({ id: 'r0' }),
    row({ id: 'a2', chainDepth: 1, continuedFromRunId: 'r0', queuedAt: new Date('2026-11-13T10:05:00Z') }),
    row({ id: 'c3', chainDepth: 2, continuedFromRunId: 'a2', costCents: 70, computeCents: null }),
  ])!;
  expect(steps.map((s) => [s.id, s.step])).toEqual([['r0', 1], ['a2', 2], ['b2', 2], ['c3', 3]]);
  expect(steps[0]!.costCents).toBe(49);          // cost + compute
  expect(steps[3]!.costCents).toBe(70);          // null compute reads 0
  expect(steps[3]!.queuedAt).toBe('2026-11-13T10:00:00.000Z');
});

it('capRunGoal trims, nulls blank and non-string goals, and caps at 300 chars with an ellipsis', () => {
  expect(capRunGoal('  x  ')).toBe('x');
  expect(capRunGoal('   ')).toBeNull();
  expect(capRunGoal(42)).toBeNull();
  const capped = capRunGoal('a'.repeat(400))!;
  expect(capped).toHaveLength(AI_AGENT_RUN_GOAL_MAX_CHARS);
  expect(capped.endsWith('…')).toBe(true);
});

it('projectAnalysisScope uses the frozen scope, names the site, and falls back for a pre-W02 run', () => {
  expect(projectAnalysisScope({ handles: [], deviceIds: ['d1','d2'], region: 'us',
    scope: { kind: 'org', siteId: null, deviceCount: 412 } }, null))
    .toEqual({ kind: 'org', siteId: null, siteName: null, deviceCount: 412 });
  expect(projectAnalysisScope({ handles: [], deviceIds: ['d1'], region: 'us',
    scope: { kind: 'site', siteId: 's1', deviceCount: 1 } }, 'Main office'))
    .toEqual({ kind: 'site', siteId: 's1', siteName: 'Main office', deviceCount: 1 });
  // pre-W02: no scope key, explicit device list
  expect(projectAnalysisScope({ handles: [], deviceIds: ['d1','d2','d3'], region: 'eu' }, null))
    .toEqual({ kind: 'devices', siteId: null, siteName: null, deviceCount: 3 });
  expect(projectAnalysisScope({ handles: [], deviceIds: [], region: 'eu' }, null)).toBeNull();
  expect(projectAnalysisScope(null, null)).toBeNull();
  expect(projectAnalysisScope(undefined, null)).toBeNull();
});

it('buildRunTrace carries lineage, goal, scope and chain for an analysis run', () => {
  const dto = buildRunTrace(
    { ...base, profile: 'analysis', continuedFromRunId: 'r0', chainRootRunId: 'r0', chainDepth: 1,
      triggerRef: { source: 'chat_analysis', goal: 'correlate BSODs' },
      stagedInputs: { handles: [], deviceIds: ['d1'], region: 'us', scope: { kind: 'org', siteId: null, deviceCount: 412 } } },
    null, null, [], [], new Map(), null, [], null, null, [], null,
    { chainRows: [row({ id: 'r0' }), row({ id: base.id, chainDepth: 1, continuedFromRunId: 'r0' })], siteName: null },
  );
  expect(dto).toMatchObject({ continuedFromRunId: 'r0', chainRootRunId: 'r0', chainDepth: 1,
    analysisGoal: 'correlate BSODs', analysisScope: { kind: 'org', deviceCount: 412 } });
  expect(dto.chain).toHaveLength(2);
});

it('buildRunTrace defaults every new field for a non-analysis or pre-W03 run', () => {
  const dto = buildRunTrace({ ...base, triggerRef: { goal: 'not analysis' } }, null, null, [], []);
  expect(dto).toMatchObject({ continuedFromRunId: null, chainRootRunId: null, chainDepth: 0,
    analysisGoal: null, analysisScope: null, chain: null });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiAgents/runTrace.test.ts`
Expected: FAIL — `projectRunChain` / `capRunGoal` / `projectAnalysisScope` are not exported.

- [ ] **Step 3: Add the shared types and constants** in `aiAgentRuns.ts` (beside `AI_AGENT_RUN_SUMMARY_EXCERPT_MAX_CHARS`, line 94) and the six fields at the end of `AiAgentRunDetailDto`. `chainDepth` is a plain number for the same reason `computeCents` is (line 785): "no chain" and "depth 0" are the same answer.

- [ ] **Step 4: Implement the three projections and wire them into `buildRunTrace`.** `analysisGoal`, `analysisScope` and `chain` are filled only when `run.profile === 'analysis'`; otherwise null. `analysisGoal = capRunGoal(run.triggerRef.goal)`. `projectAnalysisScope` returns the frozen scope with `siteName` when `stagedInputs.scope` exists; otherwise `{ kind: 'devices', siteId: null, siteName: null, deviceCount: deviceIds.length }` when the list is non-empty; otherwise null. `projectRunChain` sorts a copy (do not trust the caller's order) and returns null below two rows. `capRunGoal` mirrors `summaryExcerpt`'s cap rule (`runFindings.ts`): slice to 299 and append `…` only when it actually cut.

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/aiAgents/runTrace.test.ts && cd ../../packages/shared && npx vitest run src/types/aiAgentRuns.test.ts`
Expected: PASS, both files.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/aiAgentRuns.ts apps/api/src/services/aiAgents/runTrace.ts apps/api/src/services/aiAgents/runTrace.test.ts
git commit -m "feat(ai-agents): chain, goal and scope on the run-detail DTO projection (W06)"
```

---

### Task 2: Read the chain and scope in `GET /ai/agents/runs/:runId`

**Files:**
- Modify: `apps/api/src/routes/aiAgents.ts:1392-1442` (run select), `:1691-1752` (analysis reads, `buildRunTrace` call)
- Test: `apps/api/src/routes/aiAgents.test.ts` (`runDetailResponseSchema` at `:1123`, the analysis test at `:2395`, a new `describe`)

**Interfaces:**
- Consumes: Task 1's `RunTraceChainRowInput`, `RunTraceAnalysisInput`, `AI_AGENT_RUN_CHAIN_MAX_STEPS`; C4 columns; `runSiteScopeCondition(auth)` (`services/aiAgentRunSiteScope.ts:19`).
- Produces: the six DTO fields on the wire. No new route: the run page and the chat card already poll this one.

- [ ] **Step 1: Write the failing tests.** First extend `runDetailResponseSchema` (strict) with the six fields:

```ts
continuedFromRunId: z.string().nullable(),
chainRootRunId: z.string().nullable(),
chainDepth: z.number().int().min(0),
analysisGoal: z.string().nullable(),
analysisScope: z.object({
  kind: z.enum(['devices', 'site', 'org']), siteId: z.string().nullable(),
  siteName: z.string().nullable(), deviceCount: z.number(),
}).strict().nullable(),
chain: z.array(z.object({
  id: z.string(), step: z.number(), continuedFromRunId: z.string().nullable(),
  goal: z.string().nullable(), status: z.string(), costCents: z.number(), queuedAt: z.string(),
}).strict()).nullable(),
```

The existing analysis test (`:2395`) gains one more `selectMock.mockReturnValueOnce(selectChain([]))` after the workspace row (the chain read). Then add `describe('GET /ai-agents/runs/:runId — analysis chain (W06)', …)`:

```ts
const ROOT = '99999999-9999-4999-8999-999999999999';
const chainRow = (o: Record<string, unknown>) => ({ id: ROOT, continuedFromRunId: null, chainDepth: 0,
  status: 'completed', costCents: 30, computeCents: 5, goal: 'export inventory',
  queuedAt: new Date('2026-11-13T10:00:00Z'), ...o });

function mockAnalysisReads(run: Record<string, unknown>, chainRows: unknown[], onChainWhere?: (p: unknown) => void, onChainLimit?: (n: number) => void) {
  selectMock.mockReturnValueOnce(selectChain([runRow({ profile: 'analysis', sessionId: null, intentIds: [], ...run })]));
  selectMock.mockReturnValueOnce(selectChain([]));   // intents
  selectMock.mockReturnValueOnce(selectChain([]));   // artifacts
  selectMock.mockReturnValueOnce(selectChain([]));   // workspace
  selectMock.mockReturnValueOnce(selectChain(chainRows, onChainWhere, onChainLimit)); // chain
}

it('keys the chain read on the root for a continuation and pins it to the run org', async () => {
  let where: unknown; let limit: number | undefined;
  mockAnalysisReads(
    { continuedFromRunId: ROOT, chainRootRunId: ROOT, chainDepth: 1, triggerRef: { goal: 'count by OS' } },
    [chainRow({}), chainRow({ id: RUN_ID, continuedFromRunId: ROOT, chainDepth: 1 })],
    (p) => { where = p; }, (n) => { limit = n; },
  );
  const res = await buildApp().request(`/ai-agents/runs/${RUN_ID}`);
  const body = runDetailResponseSchema.parse(await res.json());
  expect(sqlParams(where)).toEqual(expect.arrayContaining([ORG_ID, ROOT]));
  expect(limit).toBe(AI_AGENT_RUN_CHAIN_MAX_STEPS);
  expect(body.data.chain!.map((s) => s.step)).toEqual([1, 2]);
  expect(body.data).toMatchObject({ chainDepth: 1, chainRootRunId: ROOT, analysisGoal: 'count by OS' });
});

it('discovers the chain of a root run (no lineage of its own) by its own id', async () => {
  let where: unknown;
  mockAnalysisReads({ chainRootRunId: null, chainDepth: 0 },
    [chainRow({ id: RUN_ID }), chainRow({ id: ROOT, continuedFromRunId: RUN_ID, chainDepth: 1 })],
    (p) => { where = p; });
  const body = runDetailResponseSchema.parse(await (await buildApp().request(`/ai-agents/runs/${RUN_ID}`)).json());
  expect(sqlParams(where)).toContain(RUN_ID);
  expect(body.data.chain).toHaveLength(2);
});

it('names the site for a site-scope run through an org-pinned sites read', async () => {
  let siteWhere: unknown;
  mockAnalysisReads({ stagedInputs: { handles: [], deviceIds: ['d1'], region: 'us',
    scope: { kind: 'site', siteId: SITE_ID, deviceCount: 1 } } }, []);
  selectMock.mockReturnValueOnce(selectChain([{ name: 'Main office' }], (p) => { siteWhere = p; }));
  const body = runDetailResponseSchema.parse(await (await buildApp().request(`/ai-agents/runs/${RUN_ID}`)).json());
  expect(sqlParams(siteWhere)).toEqual(expect.arrayContaining([SITE_ID, ORG_ID]));
  expect(body.data.analysisScope).toEqual({ kind: 'site', siteId: SITE_ID, siteName: 'Main office', deviceCount: 1 });
});

```

The existing test `'skips both execution-plane reads entirely for a non-analysis run'` (`:2470`) keeps its `selectMock` call-count assertion unchanged: the chain and site reads are gated on the `analysis` profile, so a non-analysis run makes no extra query.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/aiAgents.test.ts`
Expected: FAIL — strict schema rejects the response (missing `chain` …), and the new tests find no chain read.

- [ ] **Step 3: Implement in the route.**
  - Add to the run select: `continuedFromRunId: aiAgentRuns.continuedFromRunId`, `chainRootRunId: aiAgentRuns.chainRootRunId`, `chainDepth: aiAgentRuns.chainDepth`, `stagedInputs: aiAgentRuns.stagedInputs`.
  - After the workspace read, gated on `isAnalysisRun`, the chain read:
    ```ts
    const chainRootId = run.chainRootRunId ?? run.id;
    // select { id, continuedFromRunId, chainDepth, status, costCents, computeCents,
    //          goal: sql<string | null>`${aiAgentRuns.triggerRef}->>'goal'`, queuedAt }
    // where and(eq(aiAgentRuns.orgId, run.orgId), auth.orgCondition(aiAgentRuns.orgId),
    //           runSiteScopeCondition(auth), eq(aiAgentRuns.profile, 'analysis'),
    //           or(eq(aiAgentRuns.id, chainRootId), eq(aiAgentRuns.chainRootRunId, chainRootId)))
    // orderBy chainDepth, queuedAt, id (asc); limit AI_AGENT_RUN_CHAIN_MAX_STEPS
    ```
    Project `goal` in SQL, not the whole `trigger_ref`: W03 stores a seed of up to 4 KB there per run.
  - Then, only when `run.stagedInputs?.scope?.kind === 'site' && run.stagedInputs.scope.siteId`, read `sites.name` with `eq(sites.id, siteId)`, `eq(sites.orgId, run.orgId)`, `auth.orgCondition(sites.orgId)`, `limit(1)`.
  - Pass `{ chainRows, siteName }` as `buildRunTrace`'s new last argument (null for a non-analysis run).
  - Comment the chain read the way the neighbouring reads are commented: why two org predicates, why the root id fallback (Review Focus 1).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/aiAgents.test.ts src/routes/aiAgents.runProgress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgents.test.ts
git commit -m "feat(ai-agents): run detail lists the analysis chain and the frozen scope (W06)"
```

---

### Task 3: Chat run card shows step, goal, findings, cost and output files

**Files:**
- Modify: `apps/web/src/components/ai/AiRunCard.tsx:15-37` (`PolledArtifact`, `PolledRun`), `:274-415` (render)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/ai.json` (`aiRunCard` block, en at `:595-624`)
- Test: `apps/web/src/components/ai/AiRunCard.test.tsx`

**Interfaces:**
- Consumes: Task 2's DTO fields over the existing poll of `GET /ai/agents/runs/:runId`; `AnalysisOutcomeDto.findings[].severity` (`'info' | 'low' | 'medium' | 'high'`); `formatCurrency` from `@/lib/i18n/format`; `downloadArtifact` (`@/lib/downloadArtifact`).
- Produces: test ids `ai-run-card-step`, `ai-run-card-cost`, `ai-run-card-goal`, `ai-run-card-findings`, `ai-run-card-files` (existing `ai-run-card-artifact-<id>` and `ai-run-card-open` stay).

Layout follows the spec §4.5 sketch using the card's existing elements: header `Analysis run · Step 3 of this investigation · finished · $0.84`, then goal, findings and file lines, then the existing "Open the full run" link. The sketch's "[Download files]" is the per-file download chips the card already renders. There is no bulk download: browsers block several downloads from one click, and each file is its own attachment.

- [ ] **Step 1: Write the failing tests** (the file's `t` mock echoes `key` or `key:count`; extend `detail()` overrides):

```ts
describe('analysis chain surface (W06)', () => {
  const chain = [{ id: 'r0', step: 1 }, { id: 'r1', step: 2 }, { id: RUN, step: 3 }];

  it('shows the step only when the run is in a chain', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', chainDepth: 2, chain }));
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect((await findByTestId('ai-run-card-step')).textContent).toContain('aiRunCard.chainStep');
  });

  it('omits the step for an unchained run and for an API that predates the field', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', chainDepth: 0, chain: null }));
    const a = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    await a.findByTestId('ai-run-card-summary');
    expect(a.queryByTestId('ai-run-card-step')).toBeNull();
    a.unmount();
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis' })); // no chain keys at all
    const b = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    await b.findByTestId('ai-run-card-summary');
    expect(b.queryByTestId('ai-run-card-step')).toBeNull();
  });

  it('shows the goal, the findings count with the high count, and the settled cost', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', analysisGoal: 'correlate BSODs',
      analysis: { summary: 's', artifactHandles: [], proposedActions: [],
        findings: [{ severity: 'high' }, { severity: 'low' }, { severity: 'info' }] } }));
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect((await findByTestId('ai-run-card-goal')).textContent).toContain('aiRunCard.goal');
    const findings = (await findByTestId('ai-run-card-findings')).textContent!;
    expect(findings).toContain('aiRunCard.findings:3');
    expect(findings).toContain('aiRunCard.findingsHigh:1');
    expect((await findByTestId('ai-run-card-cost')).textContent).toMatch(/0\.19/); // (12 + 7) cents
  });

  it('omits the high count when no finding is high', async () => {
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis',
      analysis: { summary: 's', artifactHandles: [], proposedActions: [], findings: [{ severity: 'low' }] } }));
    const { findByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect((await findByTestId('ai-run-card-findings')).textContent).not.toContain('findingsHigh');
  });

  it('lists only unexpired output files for an analysis run', async () => {
    const future = '2099-01-01T00:00:00.000Z'; const past = '2020-01-01T00:00:00.000Z';
    fetchWithAuth.mockResolvedValue(detail({ profile: 'analysis', artifacts: [
      { id: 'o1', name: 'bsod_by_driver.csv', bytes: 14336, contentType: 'text/csv', kind: 'output', expiresAt: future, downloadPath: '/api/v1/ai/artifacts/o1' },
      { id: 'o2', name: 'old.csv', bytes: 10, contentType: 'text/csv', kind: 'output', expiresAt: past, downloadPath: '/api/v1/ai/artifacts/o2' },
      { id: 'x1', name: 'export.jsonl', bytes: 10, contentType: 'application/jsonl', kind: 'input_capture', expiresAt: future, downloadPath: '/api/v1/ai/artifacts/x1' },
      { id: 's1', name: 'step-1.py', bytes: 10, contentType: 'text/x-python', kind: 'step_script', expiresAt: future, downloadPath: '/api/v1/ai/artifacts/s1' },
    ] }));
    const { findByTestId, queryByTestId } = render(<AiRunCard runId={RUN} initialStatus="queued" run={undefined} />);
    expect((await findByTestId('ai-run-card-artifact-o1')).getAttribute('href')).toBe('/api/v1/ai/artifacts/o1');
    for (const id of ['o2', 'x1', 's1']) expect(queryByTestId(`ai-run-card-artifact-${id}`)).toBeNull();
    expect(queryByTestId('ai-run-card-files')).not.toBeNull();
  });
});
```

The existing test at `:63` (profile absent, one `output` artifact without `expiresAt`) must keep passing: a missing `expiresAt` is treated as not expired, and a non-analysis run keeps today's unfiltered list.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ai/AiRunCard.test.tsx`
Expected: FAIL — no element with test id `ai-run-card-step` / `-goal` / `-findings` / `-cost`; `o2`, `x1`, `s1` chips render.

- [ ] **Step 3: Implement.** Extend `PolledArtifact` with `kind?: string; expiresAt?: string` and `PolledRun` with `chainDepth?: number; chain?: Array<{ id: string; step: number }> | null; analysisGoal?: string | null; analysis?: { findings: Array<{ severity: string }> } | null`. Rules:
  - In a chain: `(polled?.chain?.length ?? 0) > 1`; step = `(polled?.chainDepth ?? 0) + 1`. Rendered after the title as `· {t('aiRunCard.chainStep', { step })}`.
  - Cost: only when `runIsTerminal`, `formatCurrency(((polled?.costCents ?? 0) + (polled?.computeCents ?? 0)) / 100)`.
  - Goal and findings lines only when the field is non-null. Findings: `t('aiRunCard.findings', { count })`, then `t('aiRunCard.findingsHigh', { count: high })` only when `high > 0`.
  - Files: when `polled?.profile === 'analysis'`, keep `kind === 'output'` and (`!expiresAt` or `Date.parse(expiresAt) > Date.now()`); wrap the existing chips in a container with test id `ai-run-card-files` and a `t('aiRunCard.files')` label. Live SSE artifacts (`run.artifacts`, before the first poll) render as today.

- [ ] **Step 4: Add the locale keys** to `aiRunCard` in all 8 `ai.json` files. `en`:

```json
"chainStep": "Step {{step}} of this investigation",
"goal": "Goal: {{goal}}",
"findings": "Findings: {{count}}",
"findingsHigh": "({{count}} high)",
"files": "Files:"
```

Translate the other seven (not English copies; see Global Constraints). Keep `{{step}}`, `{{goal}}`, `{{count}}` verbatim.

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/ai/AiRunCard.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS, all four files.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ai/AiRunCard.tsx apps/web/src/components/ai/AiRunCard.test.tsx apps/web/src/locales/*/ai.json
git commit -m "feat(wisp): analysis run card shows chain step, goal, findings, cost and output files (W06)"
```

---

### Task 4: Run page chain section and scope line

**Files:**
- Create: `apps/web/src/components/aiAgents/RunChainSection.tsx`
- Create: `apps/web/src/components/aiAgents/RunChainSection.test.tsx`
- Modify: `apps/web/src/components/aiAgents/RunDetailPage.tsx:1853-1919` (meta `dl`), `:2286` (section placement)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` (`aiAgentsPage.runs.detail`)
- Test: `apps/web/src/components/aiAgents/RunDetailPage.test.tsx`

**Interfaces:**
- Consumes: `AiAgentRunChainStepDto`, `AiAgentRunAnalysisScopeDto` (Task 1); `badgeClass`, `runStatusTone` (`./statusBadge`); `formatCurrency`; status copy `aiAgentsPage.runs.statuses.<status>` (existing keys).
- Produces:
  ```ts
  export default function RunChainSection(props: { steps: AiAgentRunChainStepDto[] | null | undefined; currentRunId: string }): JSX.Element | null;
  export function analysisScopeLabel(t: TFunction, scope: AiAgentRunAnalysisScopeDto): string;
  ```
  Test ids: `run-detail-chain`, `run-detail-chain-step-<id>`, `run-detail-chain-current`, `run-detail-chain-link-<id>`, `run-detail-scope`.

- [ ] **Step 1: Write the failing tests.** `RunChainSection.test.tsx` (mock `react-i18next` as `RunArtifactsSection.test.tsx:4` does, echoing `key` and interpolation values):

```ts
const steps = [
  { id: 'r0', step: 1, continuedFromRunId: null, goal: 'export inventory', status: 'completed', costCents: 35, queuedAt: '2026-11-13T10:00:00.000Z' },
  { id: 'r1', step: 2, continuedFromRunId: 'r0', goal: '<img src=x onerror=alert(1)>', status: 'failed', costCents: 12, queuedAt: '2026-11-13T10:05:00.000Z' },
  { id: 'r2', step: 2, continuedFromRunId: 'r0', goal: null, status: 'running', costCents: 0, queuedAt: '2026-11-13T10:06:00.000Z' },
] as const;

it('renders nothing without a chain, including when the field is absent', () => {
  expect(render(<RunChainSection steps={null} currentRunId="r0" />).container.innerHTML).toBe('');
  expect(render(<RunChainSection steps={undefined} currentRunId="r0" />).container.innerHTML).toBe('');
});

it('lists every step in order with goal, status, cost and a link, and marks the current run instead of linking it', () => {
  const { getByTestId, queryByTestId, getAllByRole } = render(<RunChainSection steps={[...steps]} currentRunId="r1" />);
  expect(getByTestId('run-detail-chain')).toBeTruthy();
  expect(getAllByRole('listitem').map((li) => li.getAttribute('data-testid')))
    .toEqual(['run-detail-chain-step-r0', 'run-detail-chain-step-r1', 'run-detail-chain-step-r2']);
  expect(getByTestId('run-detail-chain-link-r0').getAttribute('href')).toBe('/ai-agents/runs/r0');
  expect(queryByTestId('run-detail-chain-link-r1')).toBeNull();
  expect(getByTestId('run-detail-chain-step-r1').querySelector('[data-testid="run-detail-chain-current"]')).not.toBeNull();
  expect(getByTestId('run-detail-chain-step-r2').textContent).toContain('aiAgentsPage.runs.detail.chain.noGoal');
});

it('renders a goal as text, never as markup', () => {
  const { getByTestId } = render(<RunChainSection steps={[...steps]} currentRunId="r0" />);
  expect(getByTestId('run-detail-chain-step-r1').querySelector('img')).toBeNull();
  expect(getByTestId('run-detail-chain-step-r1').textContent).toContain('<img src=x onerror=alert(1)>');
});

it('analysisScopeLabel picks the key by kind and falls back when the site name is unknown', () => {
  const t = (k: string, o?: Record<string, unknown>) => `${k}|${JSON.stringify(o)}`;
  expect(analysisScopeLabel(t as never, { kind: 'org', siteId: null, siteName: null, deviceCount: 412 }))
    .toBe('aiAgentsPage.runs.detail.scope.org|{"count":412}');
  expect(analysisScopeLabel(t as never, { kind: 'site', siteId: 's', siteName: 'HQ', deviceCount: 3 }))
    .toBe('aiAgentsPage.runs.detail.scope.site|{"count":3,"name":"HQ"}');
  expect(analysisScopeLabel(t as never, { kind: 'site', siteId: 's', siteName: null, deviceCount: 3 }))
    .toBe('aiAgentsPage.runs.detail.scope.siteUnnamed|{"count":3}');
  expect(analysisScopeLabel(t as never, { kind: 'devices', siteId: null, siteName: null, deviceCount: 2 }))
    .toBe('aiAgentsPage.runs.detail.scope.devices|{"count":2}');
});
```

In `RunDetailPage.test.tsx`, one test that an analysis run with `analysisScope` renders `run-detail-scope` and `chain` renders `run-detail-chain`, and one that `RUN_DETAIL` (no new keys) renders neither and does not throw.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/aiAgents/RunChainSection.test.tsx src/components/aiAgents/RunDetailPage.test.tsx`
Expected: FAIL — `./RunChainSection` does not exist; `run-detail-scope` not found.

- [ ] **Step 3: Implement `RunChainSection.tsx`**, styled like `RunArtifactsSection` (`rounded-lg border bg-card p-4`, `text-sm font-semibold` heading, a `ul` of bordered rows). Each row: `t('aiAgentsPage.runs.detail.chain.step', { step })`, the goal (or `chain.noGoal`), a status badge `badgeClass(runStatusTone(status))` with `t(/* i18n-dynamic */ \`aiAgentsPage.runs.statuses.${status}\`)`, `formatCurrency(costCents / 100)`, and an anchor to `/ai-agents/runs/<id>` labelled `chain.open`, or the `chain.current` badge for `currentRunId`. Rows render in the order given (the API orders them). Uses `useTranslation('settings')` like the page.

- [ ] **Step 4: Wire into `RunDetailPage.tsx`.** Render `<RunChainSection steps={run.chain} currentRunId={run.id} />` directly above `<RunWorkspaceSection …/>` (`:2286`). In the meta `dl`, after the cost entries, add a `div` with `dt` `t('aiAgentsPage.runs.detail.labels.scope')` and `dd data-testid="run-detail-scope"` `analysisScopeLabel(t, run.analysisScope)`, only when `run.analysisScope` is truthy (so `undefined` from an older API renders nothing).

- [ ] **Step 5: Add the locale keys** to all 8 `settings.json` files under `aiAgentsPage.runs.detail`. `en`:

```json
"labels": { "scope": "Scope" },
"scope": {
  "org_one": "Whole organization ({{count}} device as of launch)",
  "org_other": "Whole organization ({{count}} devices as of launch)",
  "site_one": "Site {{name}} ({{count}} device as of launch)",
  "site_other": "Site {{name}} ({{count}} devices as of launch)",
  "siteUnnamed_one": "One site ({{count}} device as of launch)",
  "siteUnnamed_other": "One site ({{count}} devices as of launch)",
  "devices_one": "{{count}} selected device",
  "devices_other": "{{count}} selected devices"
},
"chain": {
  "title": "This investigation",
  "description": "Each step continued from an earlier one and could use the files earlier steps produced.",
  "step": "Step {{step}}",
  "current": "This run",
  "open": "Open run",
  "noGoal": "No goal recorded"
}
```

(`labels.scope` merges into the existing `labels` object.) Translate the other seven; use exactly the plural suffixes that locale's file already uses for its other `_one`/`_other` keys.

- [ ] **Step 6: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/aiAgents/RunChainSection.test.tsx src/components/aiAgents/RunDetailPage.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/aiAgents/RunChainSection.tsx apps/web/src/components/aiAgents/RunChainSection.test.tsx apps/web/src/components/aiAgents/RunDetailPage.tsx apps/web/src/components/aiAgents/RunDetailPage.test.tsx apps/web/src/locales/*/settings.json
git commit -m "feat(ai-agents): run page shows the analysis chain and the device scope (W06)"
```

---

### Task 5: Wisp guidance — parameter keys and the launch message

The spec puts this guidance in the `launch_specialist` description, but the caps leave no room: the description is at 275 of 300 characters, the params text at 159 of 160 once W02 lands (157 today) and the kind text at 132 of 160 (`aiTools.descriptionBudget.contract.test.ts:17-18`). So the keys go in the params text, "org = whole customer" goes in the kind text, and the continue / start fresh / limits rules go in the message an admitted analysis launch returns. The model reads that message at the moment it holds the run id it would continue from. The precedent is `assessmentLaunchMessage` (`services/wisp/specialists/assessmentLaunch.ts:55`). The chat tool index (`aiToolIndex.ts:95-130`) renders names, actions and domain notes but no descriptions, so its byte bounds are unaffected (B1 always-on < 2,560 B, B2 domain block < 2,048 B, B3 worst page turn < 7,040 B; `aiToolIndex.test.ts:385-449`).

**Files:**
- Modify: `apps/api/src/services/aiToolSchemas.ts:509-529` (`launchSpecialistKindDescribe`, `params` describe)
- Modify: `apps/api/src/services/wisp/specialistLaunchers.ts` (`launchAnalysis`, currently `:461-483`; add `analysisLaunchMessage`)
- Test: `apps/api/src/services/aiToolsWisp.description.test.ts`, `apps/api/src/services/wisp/specialistLaunchers.test.ts` (`describe('launchAnalysis')` at `:259`)

**Interfaces:**
- Consumes: W02's frozen frame scope and W03's computed chain depth inside `launchAnalysis` (whatever local names those waves gave them: the `scope` object `resolveAnalysisFrame` returned, and `prior ? prior.chainDepth + 1 : 0`).
- Produces:
  ```ts
  export function analysisLaunchMessage(input: {
    runId: string;
    chainDepth: number | null;
    scope: { kind: 'devices' | 'site' | 'org'; deviceCount: number } | null;
  }): string;
  ```
  `launchAnalysis` returns `{ admitted: true, runId, message: analysisLaunchMessage(...) }` on admission and on both replay paths (replay passes `chainDepth: null, scope: null`).

Exact strings. W02 Task 6 sets the params text to `'Keys: sweep {sweepKinds?}; analysis {goal, scope: org|site|devices, siteId|deviceIds}; patch_plan {}; remediation_research {deviceId, alertId?}; rest: see tool'` (159 chars) and W03 does not advertise `continueFromRunId`, so this task replaces W02's string and rewrites W02's `'W02: the params description names the analysis scope keys within 160 chars'` test into the one below:

```ts
// params describe — 158 chars
'analysis {goal, scope: org|site|devices, siteId|deviceIds, continueFromRunId?}; sweep {sweepKinds?}; remediation_research {deviceId, alertId?}; rest: see tool'
// kind describe, workspace on — 154 chars
'After one card: assessment {scope?: org|orgs_with_open_alerts}, device_troubleshooting, analysis (org: whole customer), sweep if scheduled. Rest ask first'
// kind describe, workspace off — unchanged
```

`patch_plan {}` leaves the params text: `params` is optional and an omitted `params` is `{}` (`aiToolsWisp.ts:122`). The tool description (`launchSpecialistDescription`) is unchanged.

Launch message copy:

```
Analysis run <runId> started[ as step <depth+1> of this investigation][ over <scope>]. Its result arrives on a later turn. To build on it, launch analysis again with continueFromRunId <runId>; its files carry forward. When the question changes, start a fresh analysis without continueFromRunId. A chain has a step limit and a spend limit.
```

where `<scope>` is `the whole organization (<n> devices)`, `one site (<n> devices)` or `<n> selected devices` (`device` when n is 1). The step clause appears only when `chainDepth > 0`.

- [ ] **Step 1: Write the failing tests.** In `aiToolsWisp.description.test.ts`:

```ts
describe('analysis guidance (W06)', () => {
  const params = () => launchSpecialistShapeFor(true).params.description!;
  it('the params text names every analysis key and stays within 160 chars', () => {
    expect(params().length).toBeLessThanOrEqual(160);
    for (const k of ['analysis {goal, scope: org|site|devices, siteId|deviceIds, continueFromRunId?}', 'sweep {sweepKinds?}', 'remediation_research {deviceId, alertId?}', 'rest: see tool']) {
      expect(params()).toContain(k);
    }
    expect(launchSpecialistShapeFor(false).params.description).toBe(params());
  });
  it('workspace on: the kind text says org scope means the whole customer', () => {
    expect(launchSpecialistKindDescribe(true)).toContain('analysis (org: whole customer)');
    expect(launchSpecialistKindDescribe(true).length).toBeLessThanOrEqual(160);
  });
});
```

In `specialistLaunchers.test.ts`, inside `describe('launchAnalysis')`:

```ts
it('an admitted launch tells the model how to continue, when to start fresh, and that chains are capped', async () => {
  // arrange admission as the existing admitted test does; frame scope org with 412 devices; no continuation
  const res = await launchAnalysis(ctx({ params: { goal: 'why', scope: 'org' } }));
  expect(res).toMatchObject({ admitted: true, runId: 'new' });
  const msg = (res as { message: string }).message;
  expect(msg).toContain('over the whole organization (412 devices)');
  expect(msg).toContain('continueFromRunId new');
  expect(msg).toContain('start a fresh analysis without continueFromRunId');
  expect(msg).toContain('A chain has a step limit and a spend limit.');
  expect(msg).not.toContain('as step');
});

it('a continuation names its step', () => {
  expect(analysisLaunchMessage({ runId: 'r', chainDepth: 2, scope: { kind: 'devices', deviceCount: 1 } }))
    .toMatch(/^Analysis run r started as step 3 of this investigation over 1 selected device\. /);
});

it('a replayed launch still carries the guidance without scope or step', () => {
  expect(analysisLaunchMessage({ runId: 'old', chainDepth: null, scope: null }))
    .toMatch(/^Analysis run old started\. Its result arrives on a later turn\. /);
});
```

The existing exact `toEqual({ admitted: true, runId: 'old' })` / `'raced'` assertions (`:275`, `:288`) become `toMatchObject` plus a `message` check.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiToolsWisp.description.test.ts src/services/wisp/specialistLaunchers.test.ts`
Expected: FAIL — params text lacks `continueFromRunId?`, kind text lacks `(org: whole customer)`, `analysisLaunchMessage` is not exported.

- [ ] **Step 3: Implement** the two strings, `analysisLaunchMessage`, and the three `launchAnalysis` return sites. Update the comment above `launchSpecialistShapeFor` (`aiToolSchemas.ts:518-523`) to say the analysis guidance lives in the launch message, and why.

- [ ] **Step 4: Run to verify it passes, plus the contract tests that read these texts**

Run: `cd apps/api && npx vitest run src/services/aiToolsWisp.description.test.ts src/services/wisp/specialistLaunchers.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiToolIndex.test.ts src/services/aiAgent.toolIndexPrompt.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts`
Expected: PASS. (`aiTools.userOwnedRelease.contract.test.ts` keys `SAFE_WRITE_SITES` by line number; it must stay green after any `aiTools*.ts` edit.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolSchemas.ts apps/api/src/services/wisp/specialistLaunchers.ts apps/api/src/services/aiToolsWisp.description.test.ts apps/api/src/services/wisp/specialistLaunchers.test.ts
git commit -m "feat(wisp): analysis scope keys and continuation guidance for the model (W06)"
```

---

### Task 6: Docs — analysis runs from Wisp, chains, limits and the grant budget

**Files:**
- Modify: `apps/docs/src/content/docs/features/ai-analysis-runs.mdx` (the stale caution at `:10-12`; new section after "Reading the run")
- Modify: `apps/docs/src/content/docs/features/wisp.mdx` (`analysis` row at `:252`; a paragraph after `:262`)
- Modify: `apps/api/src/data/docsIndex.json` (regenerated)

**Interfaces:** none (prose). Facts it must state, each from the spec or code:
- Wisp starts an analysis from chat through `launch_specialist` with kind `analysis` and a scope: `org` (whole customer), `site`, or `devices`. A site or org scope is expanded to the devices you can see when the run starts and frozen ("Whole organization (412 devices as of launch)"); default cap 1,000 devices. (`workspace_launch_analysis` stays off; #6086.)
- The result comes back to the conversation on the next turn; its output files are listed and readable from that conversation.
- **Continuing:** each step can continue from an earlier one (`continueFromRunId`) and use every file the chain exported or produced so far, without exporting again. Files are re-checked at each step. Files expire 30 days after they were created and a continuation does not extend that. Only the conversation that started a chain (or one continued from it) can continue it.
- **Limits:** a chain stops at 8 steps deep, 12 runs, or $6.00 total spend, whichever comes first (`analysisMaxChainDepth`, `analysisMaxChainRuns`, `analysisMaxChainBudgetCents`). A run still in progress counts at its full per-run allowance. A refused launch names the limit that stopped it; start a fresh analysis to go on.
- **The grant's daily budget usually binds first.** A grant's default daily budget is 200 ¢ on Pro, and each analysis launch is checked against an estimate of 100 ¢, so a default grant admits about two analysis launches a day. Long investigations need a raised budget: a partner admin raises it under **Budget and check-in settings** in the Wisp header, up to 5x the plan default.
- The run page shows the chain (each step's goal, status, cost and a link) and the scope.

- [ ] **Step 1: Red check.** Run `grep -n "Chat cannot start background analysis runs" apps/docs/src/content/docs/features/ai-analysis-runs.mdx`. Expected: one match (the stale statement this task removes).

- [ ] **Step 2: Edit `ai-analysis-runs.mdx`.** Replace the caution `Aside` with a `note` Aside: analysis runs can be started from Wisp chat (link `/features/wisp/#specialists`); the direct `workspace_launch_analysis` tool stays off. Add `## Investigations from Wisp chat` with subsections `### Continuing an analysis` and `### Limits and budget`, carrying the facts above. Scope is already documented by W02's `## What a run covers` section: link to it (`#what-a-run-covers`) instead of repeating it, and add only the "as of launch" wording the run page now shows. Keep the existing sections unchanged.

- [ ] **Step 3: Edit `wisp.mdx`.** In the specialists table, the `analysis` row: "Runs sandboxed analysis over a whole customer, one site, or chosen devices (see [AI Analysis Runs](/features/ai-analysis-runs/#investigations-from-wisp-chat)). Can continue from an earlier analysis in the same conversation…". After the `launch_specialist` paragraph, add a short paragraph on analysis chains and the grant budget, pointing to the Budgets section above (`#budgets`).

- [ ] **Step 4: Regenerate the docs search index and build the docs**

Run: `npx tsx scripts/build-docs-index.ts && cd apps/docs && pnpm exec astro check`
Expected: `apps/api/src/data/docsIndex.json` changes only for the two pages; `astro check` reports 0 errors. Then rerun the Step 1 grep. Expected: no match.

- [ ] **Step 5: Run the docs search tests**

Run: `cd apps/api && npx vitest run src/services/aiToolsDocs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/docs/src/content/docs/features/ai-analysis-runs.mdx apps/docs/src/content/docs/features/wisp.mdx apps/api/src/data/docsIndex.json
git commit -m "docs(wisp): analysis investigations from chat, chains, limits and the grant budget (W06)"
```

---

### Task 7: Eval scenario — a three-step org-scope chain on the fake backend

**Files:**
- Modify: `e2e-tests/wisp-eval/sh/make-env.sh:96-112` (`SET`)
- Modify: `e2e-tests/wisp-eval/make-env.test.cjs:139` (assertions)
- Modify: `e2e-tests/wisp-eval/sh/setup.sh` (new `step_analysis`, `:19` default step list, `:132` dispatch)
- Create: `e2e-tests/wisp-eval/sh/analysis-ready.sh`
- Create: `e2e-tests/wisp-eval/scenarios/m-analysis-chain-cites-first-file.json`
- Modify: `e2e-tests/wisp-eval/README.md` (test-world and cost sections)

**Interfaces:**
- Consumes: everything above plus W01–W03 behaviour; `AI_WORKSPACE_BACKEND=fake` (`services/workspace/fakeSandboxBackend.ts`, which runs step scripts as child processes of the API, so `python3` must exist in the API container: `workspaceService.ts:131`); the `device_inventory` dataset (one of the original seven, so the scenario needs neither W04 nor W05); harness helpers `q`, `qsys`, `api`, `org_id` (`sh/common.sh:30-79`).
- Produces: scenario id `analysis-chain-cites-first-file`.

What the scenario asserts:
1. *(precondition)* the grant's daily budget is at least 1000 ¢. The default 200 ¢ admits about two launches and the chain needs three; the harness default is 500 ¢ (`setup.sh:18`).
2. *(precondition)* the analysis environment is ready: `analysis-ready.sh` exits 0.
3. *(precondition)* `launch_specialist` was called with `"kind":"analysis"` and `"scope":"org"` in the first step.
4. Each of the two follow-up steps called `launch_specialist` with `continueFromRunId`.
5. Three analysis runs since the scenario started form one chain: max depth 2, one distinct root.
6. The root run's frozen scope is `org`.
7. The root run exported `device_inventory` through `export_dataset` (C4 `ai_run_artifacts.dataset`).
8. The root run produced an `output` file named `nw_inventory_summary.csv`.
9. The depth-2 run's frozen `staged_inputs.handles` include that file's id, so handles accumulate down the chain.
10. The final chat answer names `nw_inventory_summary.csv`.
11. No error banner on any step.

- [ ] **Step 1: Write the failing tests.** In `make-env.test.cjs`, after `:139`:

```js
assert.equal(values.BREEZE_AI_WORKSPACE_ENABLED, 'true');
assert.equal(values.AI_WORKSPACE_BACKEND, 'fake');
```

Run: `node --test e2e-tests/wisp-eval/make-env.test.cjs`. Expected: FAIL (`undefined !== 'true'`).
Run: `node e2e-tests/wisp-eval/run.cjs --only analysis-chain-cites-first-file`. Expected: exit 2 (`--only` matches nothing).

- [ ] **Step 2: Turn the workspace on in the harness env.** Add `BREEZE_AI_WORKSPACE_ENABLED=true` and `AI_WORKSPACE_BACKEND=fake` to `SET`. Production config validation refuses `fake` (`config/validate.ts:1742-1760`), but this stack runs `NODE_ENV=development`. This turns analysis on for every scenario, and `aiWorkspaceEnabled()` also turns on artifact capture (`env.ts:407`). Step 7 re-checks the other scenarios.

- [ ] **Step 3: Add `step_analysis` to `setup.sh`** (idempotent; in the default step list after `triage`):
  - `api PATCH "/orgs/organizations/$(org_id 'Northwind Dental')" '{"aiExternalProcessing":true}'` (`routes/orgs.ts:368`, mounted at `/orgs`, `index.ts:916`).
  - Add `workspace_stage`, `workspace_run`, `workspace_collect`, `workspace_cancel` and `export_dataset` to the partner-wide Triage agent's `toolAllowlist` (union with what it has) with `api PATCH "/ai/agents/<id>"` (`routes/aiAgents.ts:2227`). Analysis admission runs as the triage agent (`analysisAdmission.ts:189`) and refuses `workspace_capability_missing` unless all four workspace tools are allowlisted (`runService.ts:1707-1714`).
  - If `docker exec <api container> python3 --version` fails, `docker exec <api container> apk add --no-cache python3` (the dev image `docker/Dockerfile.api.dev` is `node:24-alpine` without Python). Take the container name from the stack descriptor the way `sh/sim.sh` does.

- [ ] **Step 4: Create `sh/analysis-ready.sh`.** It sources `common.sh`, prints one line per failed check to stderr, and exits 1 if any fails:
  - `docker exec <api> printenv BREEZE_AI_WORKSPACE_ENABLED` is `true`, `AI_WORKSPACE_BACKEND` is `fake`;
  - `docker exec <api> python3 --version` succeeds;
  - `q "select ai_external_processing from organizations where id = '$(org_id 'Northwind Dental')'"` is `t`;
  - the Triage agent's `tool_allowlist` contains the four workspace tools and `export_dataset`.
  The script name matches `run.cjs`'s `^[a-z0-9-]+\.sh$` rule (`run.cjs:80`); a non-zero exit fails the scenario as a harness error, never as "still red".

- [ ] **Step 5: Create the scenario file** `scenarios/m-analysis-chain-cites-first-file.json` (letter `m` sorts after `l-…`):

```json
{
  "id": "analysis-chain-cites-first-file",
  "title": "A three-step org-scope analysis chain builds on the first step's file",
  "issue": null,
  "expect": "pass",
  "door": "wisp",
  "note": "Needs a raised grant budget (WISP_EVAL_BUDGET_CENTS=1000 bash sh/setup.sh grant) and setup step 'analysis'. Fake sandbox backend.",
  "steps": [
    { "name": "budget", "type": "wait_sql", "timeoutSec": 2, "required": true, "equals": "true",
      "sql": "select (budget_cents_per_day >= 1000)::text from wisp_grants where org_id is null and status = 'active' order by created_at desc limit 1" },
    { "name": "ready", "type": "shell", "argv": ["analysis-ready.sh"] },
    { "name": "launch", "type": "say", "approve": "approve", "maxSec": 150,
      "text": "Start an analysis across the whole Northwind Dental organization. Export the device inventory and write a file named nw_inventory_summary.csv with one row per device: hostname, operating system and last seen time." },
    { "name": "root-settled", "type": "wait_sql", "timeoutSec": 420, "required": true, "equals": "true",
      "sql": "select (count(*) > 0)::text from ai_agent_runs where profile = 'analysis' and chain_depth = 0 and queued_at > {{since}} and status in ('completed','failed','cancelled')" },
    { "type": "sleep", "sec": 5 },
    { "name": "continue1", "type": "say", "approve": "approve", "maxSec": 150,
      "text": "Build on that analysis: from nw_inventory_summary.csv, count the devices per operating system." },
    { "name": "step2-settled", "type": "wait_sql", "timeoutSec": 420, "required": true, "equals": "true",
      "sql": "select (count(*) > 0)::text from ai_agent_runs where profile = 'analysis' and chain_depth = 1 and queued_at > {{since}} and status in ('completed','failed','cancelled')" },
    { "type": "sleep", "sec": 5 },
    { "name": "continue2", "type": "say", "approve": "approve", "maxSec": 150,
      "text": "Take that one step further: which of those devices have not checked in during the last 24 hours?" },
    { "name": "step3-settled", "type": "wait_sql", "timeoutSec": 420, "required": true, "equals": "true",
      "sql": "select (count(*) > 0)::text from ai_agent_runs where profile = 'analysis' and chain_depth = 2 and queued_at > {{since}} and status in ('completed','failed','cancelled')" },
    { "type": "sleep", "sec": 5 },
    { "name": "final", "type": "say", "approve": "none", "maxSec": 120,
      "text": "Sum up this investigation in three sentences, and name the file the first step produced." }
  ],
  "checks": [
    { "kind": "tool_called", "tool": "launch_specialist", "step": "launch", "origin": "chat", "precondition": true,
      "inputMatches": "\"kind\":\"analysis\".*\"scope\":\"org\"|\"scope\":\"org\".*\"kind\":\"analysis\"" },
    { "kind": "tool_called", "tool": "launch_specialist", "step": "continue1", "origin": "chat", "inputMatches": "\"continueFromRunId\"" },
    { "kind": "tool_called", "tool": "launch_specialist", "step": "continue2", "origin": "chat", "inputMatches": "\"continueFromRunId\"" },
    { "kind": "sql_equals", "equals": "true",
      "sql": "select (count(*) = 3 and max(chain_depth) = 2 and count(distinct coalesce(chain_root_run_id, id)) = 1)::text from ai_agent_runs where profile = 'analysis' and queued_at > {{since}}" },
    { "kind": "sql_equals", "equals": "org",
      "sql": "select staged_inputs->'scope'->>'kind' from ai_agent_runs where profile = 'analysis' and chain_depth = 0 and queued_at > {{since}} order by queued_at limit 1" },
    { "kind": "sql_equals", "equals": "true",
      "sql": "select (count(*) > 0)::text from ai_run_artifacts a join ai_agent_runs r on r.id = a.run_id where r.profile = 'analysis' and r.chain_depth = 0 and r.queued_at > {{since}} and a.kind = 'input_capture' and a.created_by_tool = 'export_dataset' and a.dataset = 'device_inventory'" },
    { "kind": "sql_equals", "equals": "true",
      "sql": "select (count(*) > 0)::text from ai_run_artifacts a join ai_agent_runs r on r.id = a.run_id where r.profile = 'analysis' and r.chain_depth = 0 and r.queued_at > {{since}} and a.kind = 'output' and a.name = 'nw_inventory_summary.csv'" },
    { "kind": "sql_equals", "equals": "true",
      "sql": "select (count(*) > 0)::text from ai_agent_runs r3 join ai_run_artifacts a on a.run_id = r3.chain_root_run_id where r3.profile = 'analysis' and r3.chain_depth = 2 and r3.queued_at > {{since}} and a.kind = 'output' and a.name = 'nw_inventory_summary.csv' and r3.staged_inputs->'handles' ? a.id::text" },
    { "kind": "reply_matches", "step": "final", "pattern": "nw_inventory_summary\\.csv" },
    { "kind": "no_error_banner", "step": "launch" },
    { "kind": "no_error_banner", "step": "continue1" },
    { "kind": "no_error_banner", "step": "continue2" },
    { "kind": "no_error_banner", "step": "final" }
  ]
}
```

If `run.cjs --list` rejects `"issue": null`, drop the key (other scenarios carry a number). Confirm `sql_equals` and `wait_sql` pass the `?` operator to `psql` unaltered (`run.cjs` `psql()`); if not, use `jsonb_exists(r3.staged_inputs->'handles', a.id::text)`.

- [ ] **Step 6: Validate, then prove the guard can fail**

Run: `node --test "e2e-tests/wisp-eval/*.test.cjs" && node e2e-tests/wisp-eval/run.cjs --list`
Expected: PASS; the list includes `analysis-chain-cites-first-file` with no validation error.

On a live-key stack (README "From a clean checkout"), with `WISP_EVAL_BUDGET_CENTS=1000 bash e2e-tests/wisp-eval/sh/setup.sh grant analysis`: run `node e2e-tests/wisp-eval/run.cjs --only analysis-chain-cites-first-file` twice. Expected: **pass** both times. Then doctor the `reply_matches` pattern to `nw_inventory_summary_x\\.csv` and re-score the saved report: `node e2e-tests/wisp-eval/rescore.cjs .state/reports/<run>.json --only analysis-chain-cites-first-file`. Expected: UNEXPECTED FAIL. Restore the pattern.

- [ ] **Step 7: Re-baseline the other scenarios with the workspace on**

Run: `node e2e-tests/wisp-eval/run.cjs` (whole benchmark).
Expected: every other scenario lands in the same bucket it did before Step 2. A scenario that moves is a finding to report in the PR, not something to fix here.

- [ ] **Step 8: Update the README.** In "The test world", note that Northwind Dental has sandboxed analysis on (fake backend), the Triage agent carries the workspace tools, and this scenario needs `WISP_EVAL_BUDGET_CENTS=1000`. In "Cost", record the measured cost of this scenario from Step 6 (four chat turns plus three runs; compute is free on `fake`).

- [ ] **Step 9: Commit**

```bash
git add e2e-tests/wisp-eval/sh/make-env.sh e2e-tests/wisp-eval/make-env.test.cjs e2e-tests/wisp-eval/sh/setup.sh e2e-tests/wisp-eval/sh/analysis-ready.sh e2e-tests/wisp-eval/scenarios/m-analysis-chain-cites-first-file.json e2e-tests/wisp-eval/README.md
git commit -m "test(wisp): eval scenario for a three-step org-scope analysis chain (W06)"
```

Tear down what Step 6 brought up (README "Teardown"), and say in the PR what was left running.

---

### Task 8: Release note (last) and wave verification

**Files:**
- Modify: `docs/release-notes/next-release-draft.md` ("Features / API" section)

`next-release-draft.md` is a merge-queue conflict hot spot. Add this line as the **last commit before opening the PR**, rebased on fresh `origin/main`.

- [ ] **Step 1: Add the entry** under `## Features / API`:

```markdown
- **Analysis investigations from Wisp chat** (spec 2026-11-13 wisp-analysis-sessions). Wisp can run a sandboxed analysis across a whole customer, a site or chosen devices, bring the result and its files back to the conversation, and continue from an earlier step with that step's files. Chains stop at 8 steps, 12 runs or $6.00 by default; the grant's daily budget (200 ¢ on Pro) usually stops first, so a partner admin raises it for long investigations. The run card shows the step, findings and files; the run page lists the chain and the device scope. Hosted only, behind the existing AI workspace and Wisp switches; no new env var.
```

- [ ] **Step 2: Typecheck** (check each exit code; never pipe to `tail`)

```bash
NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "api tsc exit $?"
pnpm --filter @breeze/shared typecheck; echo "shared exit $?"
(cd apps/web && pnpm exec astro check); echo "web exit $?"
```

Expected: three `exit 0`.

- [ ] **Step 3: Targeted suites**

```bash
cd apps/api && npx vitest run src/services/aiAgents/runTrace.test.ts src/routes/aiAgents.test.ts src/routes/aiAgents.runProgress.test.ts src/services/aiToolsWisp.description.test.ts src/services/wisp/specialistLaunchers.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiToolIndex.test.ts src/services/aiAgent.toolIndexPrompt.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts src/services/aiToolsDocs.test.ts
cd ../web && npx vitest run src/components/ai/AiRunCard.test.tsx src/components/aiAgents/RunChainSection.test.tsx src/components/aiAgents/RunDetailPage.test.tsx src/lib/i18n
cd ../../packages/shared && npx vitest run src/types/aiAgentRuns.test.ts
node --test "e2e-tests/wisp-eval/*.test.cjs"
```

Expected: all PASS. (`src/lib/i18n` is a substring filter; check the reported file count includes `localeParity`, `translationCoverage` and `keyUsage`.)

- [ ] **Step 4: Full API and web unit suites**

Run: `pnpm --filter @breeze/api test --run` and `pnpm --filter @breeze/web test --run`
Expected: PASS.

- [ ] **Step 5: Contract suites.** This wave adds no table, column, migration, RLS policy or cascade entry, so the org-cascade, export-policy and RLS-coverage contracts (Integration Tests job only; `docs/agents/testing.md`) are not affected by it. They still run on the PR. If the branch is stacked (base ≠ `main`), dispatch CI by hand: `gh workflow run CI --ref <branch>`.

- [ ] **Step 6: Commit**

```bash
git add docs/release-notes/next-release-draft.md
git commit -m "docs(release-notes): Wisp analysis investigations (W06)"
```
