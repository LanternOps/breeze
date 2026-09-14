---
tracking_issue: LanternOps/breeze#5711
---

# Execution Plane W03 — `export_dataset` and Run Progress Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `export_dataset` — a Tier-1 AI tool that pages any of seven existing server-side datasets to completion straight into an `input_capture` artifact — plus `ai.agent.run.progress` events surfaced on the run detail page.

**Architecture:** `aiToolsExport.ts` holds one dataset registry; each entry is a thin adapter over the EXISTING query builder behind the corresponding tool (`searchFleetLogs`, `readDeviceFindings`, `generateDeviceInventoryReport`, …) — no new SQL is written for any dataset that already has one. A streaming writer (`exportWriter.ts`) turns pages into JSONL or CSV bytes, enforces row/byte/wall caps, and feeds a `Readable` into W01's `createArtifact`. Progress is published through the existing event bus by `runProgress.ts` and mirrored into a capped Redis ring so the run-detail page — which **polls**, it is not SSE — can render a step list from the polled DTO.

**Tech Stack:** Hono, Drizzle ORM, Vitest, `node:stream` (`Readable`), ioredis (existing `getRedis()`), React + jsdom for the web test.

**Spec:** docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md (§5.3 registration mechanics, §5.4 "Where inputs come from", §5.7, §5.8 progress half, §8 data minimisation, §9 error table, §12 `exportDataset.test.ts`)

**Feature tracking:** parent issue and wave sub-issue assigned by `register_feature` after all wave plans exist; branch `feature/<parent#>-execution-plane/wave-<subissue#>`.

## Global Constraints

- Hosted-only lane: the `workspace` capability (and therefore `export_dataset`) is reachable only when `IS_HOSTED` and `BREEZE_AI_WORKSPACE_ENABLED` are both true. W04 owns the flag gate; W03 must not introduce a second one.
- No new tables and no migration in this wave. If a step seems to need one, stop — it belongs to W01/W02/W04.
- Every dataset adapter MUST call an existing exported query builder. Writing a fresh `db.select()` for a dataset that already has a builder is a review-blocking defect.
- RLS is the tenant boundary: adapters run under the caller's ambient `withDbAccessContext` (opened by `makeHandler` in `aiAgentSdkTools.ts`). Never `withSystemDbAccessContext`, never the bare pool.
- The site axis is app-layer only. Every adapter must preserve the site narrowing its source tool performs (`resolveSiteAllowedDeviceIds` / `ReportExecutionAuthority`).
- `deviceArgs: ['deviceIds']` so the central `enforceDeviceArgs` gate in `executeTool` runs `verifyDeviceAccess` on every supplied id BEFORE the handler is entered. That gate is necessary but not sufficient — inside a run, `deviceIds` must additionally be a subset of the run's frozen targets.
- Caps are hard: `EXPORT_DEFAULT_MAX_ROWS = 200_000`, `EXPORT_HARD_MAX_ROWS = 1_000_000`, `EXPORT_WALL_MS = 120_000`, byte cap from the run's staged-bytes budget (default `EXPORT_DEFAULT_MAX_BYTES = 256 MiB`). Row/wall caps end the export cleanly with `truncated: true`; the BYTE cap is a hard failure (`artifact_bytes_exceeded`), never a silent truncation — a half-written artifact would be indistinguishable from a complete one.
- Pacing: at most `EXPORT_DEVICE_CONCURRENCY = 4` concurrent device-scoped page fetches. `p-limit` is **not** a dependency of `apps/api`; do not add it — copy the module-private `runWithConcurrency` shape from `services/automationRuntime.ts:2137`.
- `captureExempt: true` — `export_dataset` already returns a handle; W01's capture wrapper must not re-capture it.
- Tool registration is **six** places in this repo, not four (the two extra are enforced by `aiToolsRegistryParity.test.ts`): `aiTools.ts` register call, `TOOL_TIERS`, `TOOL_CAPABILITY` (+`AGENT_CAPABILITIES`), `tool()` in `createBreezeMcpServer`, `toolInputSchemas` (`aiToolSchemas.ts`), `TOOL_PERMISSIONS` (`aiGuardrails.ts`).
- Run one test file with `cd apps/api && npx vitest run src/path/file.test.ts`. Never `pnpm --filter … test -- --run` (the `--` is forwarded literally and vitest falls back to the whole suite in watch mode).
- Test files live beside their source (`foo.ts` → `foo.test.ts`).
- The existing run-completed event is **`ai.agent.run.completed`**, not the spec's prose `ai.run.completed`. Use the `ai.agent.*` namespace: the new event is `ai.agent.run.progress`.
- **Sequencing: depends on W01 landing first (`breezeRegion`, `createArtifact`).** `breezeRegion()` (`apps/api/src/config/env.ts`) and `createArtifact` (`services/artifacts/artifactService.ts`) do not exist on `main` today — they arrive with W01. Do not start Task 7 before W01 is merged into this branch's base, and do not re-create either symbol locally (see reconciliation R1).

---

## Cross-wave reconciliation — orchestrator, 2026-09-13 (overrides task bodies where they conflict)

- **R1 Region.** Do NOT create a region-resolver module or an `ARTIFACT_REGION` env var under `services/artifacts/`. Use W01's `breezeRegion()` from `apps/api/src/config/env.ts` (env `BREEZE_REGION`) as the region on every `createArtifact` call. The task that introduced a local resolver and its test has been deleted from this plan; do not reinstate it.
- **R2 Capability mapping.** W03 owns adding `export_dataset` to `TOOL_CAPABILITY` under `workspace` and adding `workspace` to `AgentCapabilityId`/`AGENT_CAPABILITIES` if absent. W04 guards both with a grep and will not double-add.
- **R3 Progress emitter signature is canonical here:** `emitRunProgress(ctx: RunProgressContext, step: string, label: string)`. W05 assumed `emitRunProgress(orgId, {…})` — W05 adapts to this one.
- **R4 Context fields — narrowed, 2026-09-13.** `ToolExecutionContext` gains **exactly two** fields from this wave: `runTargets?: readonly string[]` and `stagedBytesRemaining?: number`. Both are release-path *constraints*, which is what that type is for (`toolExecutionContext.ts:39-65` documents it as deliberately narrow). Do **not** add `runId?`, `sessionId?`, `orgId?` or `chatSessionId?` — no wave adds them now. `export_dataset` reads identity from the principal instead: `auth.principal.kind === 'ai_agent' ? auth.principal.runId : null` (`aiAgents/agentAuthContext.ts:78`) and the org from `auth.orgId` (`:89`); with no `ai_agent` principal (direct chat/MCP) the tool returns the typed error `export_requires_run`. W04 overwrites `runTargets`/`stagedBytesRemaining` at admission.

---

### Task 1: Carry the frozen targets and the staged-bytes budget to tool handlers

No per-run *constraint* reaches a tool handler today. `ToolExecutionContext` (`services/toolExecutionContext.ts`) carries only `verifiedRunScript` and `actionIntentId`, both set by release paths, and its own docs (`:39-65`) say it stays deliberately narrow. `export_dataset` needs two things from the run frame: the frozen device targets (spec §8 data minimisation) and the remaining staged-bytes budget (the byte cap). Both are release-path constraints, so both belong here — and nothing else does. **Run IDENTITY does not go on this type** (reconciliation R4): the run id already rides on the auth principal (`auth.principal.runId` when `kind === 'ai_agent'`, `aiAgents/agentAuthContext.ts:78`) and the org on `auth.orgId` (`:89`), so adding `runId`/`sessionId` here would be a second, drift-prone copy of identity the tool layer can already read.

**Files:**
- Modify `apps/api/src/services/toolExecutionContext.ts` (type `ToolExecutionContext`, lines ~70–92)
- Modify `apps/api/src/services/aiAgents/runLoop.ts` (`createAgentRunPreToolUse` args ~476–519; its two `{ allowed: true }` returns at ~675–676 and ~760; the call site ~1495–1499)
- Create `apps/api/src/services/aiAgents/runLoop.runContext.test.ts`

**Interfaces:**

Produces (two new optional fields, flat siblings — every other wave consumes these names verbatim):
```ts
export type ToolExecutionContext = {
  verifiedRunScript?: VerifiedRunScript;
  actionIntentId?: string;
  /** Device ids frozen at admission. Present ⇒ device-scoped tool args must be a SUBSET. */
  runTargets?: readonly string[];
  /** Bytes this run may still stage into artifacts. */
  stagedBytesRemaining?: number;
};
```

Consumes: `createAgentRunPreToolUse(args)` gains
```ts
runTargets: readonly string[];
stagedBytesRemaining: number;
```

Steps:

- [ ] Write the failing test `apps/api/src/services/aiAgents/runLoop.runContext.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { ToolExecutionContext } from '../toolExecutionContext';

describe('ToolExecutionContext run fields', () => {
  it('accepts runTargets and stagedBytesRemaining', () => {
    const ctx: ToolExecutionContext = {
      runTargets: ['22222222-2222-4222-8222-222222222222'],
      stagedBytesRemaining: 1024,
    };
    expect(ctx.runTargets).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(ctx.stagedBytesRemaining).toBe(1024);
  });

  it('stays a constraint type — run identity is NOT copied onto it', () => {
    // Identity lives on the auth principal (agentAuthContext.ts:78/:89).
    // @ts-expect-error runId is deliberately absent from ToolExecutionContext (R4)
    const ctx: ToolExecutionContext = { runId: 'run-1' };
    expect(ctx).toBeTruthy();
  });
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiAgents/runLoop.runContext.test.ts` — expect a TypeScript failure: `Object literal may only specify known properties, and 'runTargets' does not exist in type 'ToolExecutionContext'`.
- [ ] Add the two fields to `ToolExecutionContext` with the docstrings above, placed after `actionIntentId` — and **only** those two. Add this comment block above `runTargets`:
```ts
  /**
   * Device ids frozen at admission for this run (spec §8 data minimisation).
   * A device-scoped tool that can span MANY devices — `export_dataset` today —
   * must refuse any id outside this set. The central `enforceDeviceArgs` gate
   * answers "may this CALLER reach this device"; this answers the different
   * question "is this device in the set a human admitted THIS run for", and
   * one does not imply the other: an agent principal can reach the whole org.
   *
   * ABSENT means "no run frame", not "no restriction" — a direct chat/MCP call
   * has no frozen set, and is bounded by the caller gate alone.
   *
   * Only the CONSTRAINT lives here. The run id and org are read from the auth
   * principal (`auth.principal.runId`, `auth.orgId`) — see reconciliation R4.
   */
```
- [ ] Re-run the test — expect PASS.
- [ ] Extend `createAgentRunPreToolUse`'s `args` type in `runLoop.ts` with `runTargets: readonly string[];` and `stagedBytesRemaining: number;`, destructure both alongside `deadlineMs`, and build one shared object right after the destructure:
```ts
  /** Per-invocation run CONSTRAINTS handed to every ALLOWED tool call (W03).
   *  Built once: identical for every call in the run. No run id or session id
   *  here — a tool reads those from the auth principal (R4). */
  const runFrame: ToolExecutionContext = {
    runTargets,
    stagedBytesRemaining,
  };
```
- [ ] Merge `runFrame` into both allow returns. At ~675–676 replace
```ts
      ? { allowed: true, context: actPin.toolExecutionContext }
      : { allowed: true };
```
with
```ts
      ? { allowed: true, context: { ...runFrame, ...actPin.toolExecutionContext } }
      : { allowed: true, context: runFrame };
```
and at ~760 replace `return { allowed: true };` with `return { allowed: true, context: runFrame };`.
- [ ] At the `createAgentRunPreToolUse({ … })` call site (~1495) pass a **literal** byte budget — `aiToolsExport.ts` does not exist until Task 7, and importing it here would break every `runLoop` test from this task until then:
```ts
    runTargets: run.deviceId ? [run.deviceId] : [],
    // Literal on purpose until Task 7 exists. Task 7 replaces this line with
    // the real `EXPORT_DEFAULT_MAX_BYTES` import — do not import it now.
    stagedBytesRemaining: 256 * 1024 * 1024, // EXPORT_DEFAULT_MAX_BYTES — replaced by the real import in Task 7
```
and this comment:
```ts
    // W03 seeds the run frame from the single-device runs that exist today.
    // W04's `analysis` profile replaces both values with the admission-frozen
    // target set and the profile's `analysisMaxStagedBytesPerRun`. An empty
    // array is "no frame" (see ToolExecutionContext.runTargets) — a full-profile
    // run with no device keeps today's behaviour exactly.
```
- [ ] Add an assertion to the same test file that the wiring compiles against `runLoop`:
```ts
import { createAgentRunPreToolUse } from './runLoop';

it('createAgentRunPreToolUse accepts runTargets and stagedBytesRemaining', () => {
  expect(typeof createAgentRunPreToolUse).toBe('function');
  expect(createAgentRunPreToolUse.length).toBe(1);
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiAgents/runLoop.runContext.test.ts src/services/aiAgents/runLoop.test.ts` — expect PASS on both (the second is the regression guard that the existing allow paths still behave).
- [ ] Commit: `git add apps/api/src/services/toolExecutionContext.ts apps/api/src/services/aiAgents/runLoop.ts apps/api/src/services/aiAgents/runLoop.runContext.test.ts && git commit -m "feat(ai): carry frozen targets and staged-byte budget on ToolExecutionContext"`

---

### Task 2: `ai.agent.run.progress` event type

**Files:**
- Modify `apps/api/src/services/eventBus.ts` (`EventType` union ~173–189; `EVENT_TYPES` const ~673–683)
- Create `apps/api/src/services/aiAgents/runProgress.test.ts`

**Interfaces:**

Produces:
```ts
// eventBus.ts
export type EventType = … | 'ai.agent.run.progress' | …;
export const EVENT_TYPES = { …, AI_AGENT_RUN_PROGRESS: 'ai.agent.run.progress' as const, … };
```

Steps:

- [ ] Write the failing test `apps/api/src/services/aiAgents/runProgress.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EVENT_TYPES } from '../eventBus';

describe('run progress event type', () => {
  it('is registered on the event bus under the ai.agent namespace', () => {
    expect(EVENT_TYPES.AI_AGENT_RUN_PROGRESS).toBe('ai.agent.run.progress');
  });

  it('keeps the existing completed event name unchanged', () => {
    expect(EVENT_TYPES.AI_AGENT_RUN_COMPLETED).toBe('ai.agent.run.completed');
  });
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiAgents/runProgress.test.ts` — expect failure: `Property 'AI_AGENT_RUN_PROGRESS' does not exist`.
- [ ] In `eventBus.ts` add `| 'ai.agent.run.progress'` to the `EventType` union immediately after `'ai.agent.run.started'`, and `AI_AGENT_RUN_PROGRESS: 'ai.agent.run.progress' as const,` to `EVENT_TYPES` immediately after `AI_AGENT_RUN_STARTED`.
- [ ] Re-run the test — expect PASS.
- [ ] Commit: `git add apps/api/src/services/eventBus.ts apps/api/src/services/aiAgents/runProgress.test.ts && git commit -m "feat(ai): register ai.agent.run.progress on the event bus"`

---

### Task 3: `emitRunProgress` — publish and mirror into a Redis ring

The run detail page polls `GET /ai/agents/runs/:runId` every 5 s (`DETAIL_POLL_INTERVAL_MS`, `RunDetailPage.tsx:42`); it is NOT an SSE consumer. The event bus is a Redis stream consumed by the WS layer, which the run page does not subscribe to. So progress is also written to a short-lived capped Redis list the API route reads back. No column, no migration — progress is live-run telemetry with a 1-hour horizon, not durable run state (the durable step transcript is W04's `ai_run_workspaces.steps`).

**Files:**
- Create `apps/api/src/services/aiAgents/runProgress.ts`
- Modify `apps/api/src/services/aiAgents/runProgress.test.ts` (from Task 2)

**Interfaces:**

Consumes: `publishEvent` (`services/eventBus.ts:553`)
```ts
export async function publishEvent<T = Record<string, unknown>>(
  type: EventType, orgId: string, payload: T, source: string, options?: PublishOptions
): Promise<string>;
```
Consumes: `getRedis(): Redis | null` (`services/redis.ts:110`).

Produces:
```ts
export interface RunProgressContext { orgId: string; runId: string }
export interface RunProgressEntry { step: string; label: string; ordinal: number; at: string }
export const RUN_PROGRESS_MAX_ENTRIES = 50;
export const RUN_PROGRESS_TTL_SECONDS = 3600;
export function runProgressKey(runId: string): string;
export async function emitRunProgress(ctx: RunProgressContext, step: string, label: string): Promise<void>;
export async function readRunProgress(runId: string): Promise<RunProgressEntry[]>;
export function __resetRunProgressOrdinals(): void; // tests only
```

Steps:

- [ ] Append the failing tests to `apps/api/src/services/aiAgents/runProgress.test.ts`:
```ts
import { beforeEach, vi } from 'vitest';
import { emitRunProgress, readRunProgress, runProgressKey, __resetRunProgressOrdinals, RUN_PROGRESS_MAX_ENTRIES } from './runProgress';

const published: Array<{ type: string; orgId: string; payload: Record<string, unknown> }> = [];
vi.mock('../eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../eventBus')>();
  return {
    ...actual,
    publishEvent: vi.fn(async (type: string, orgId: string, payload: Record<string, unknown>) => {
      published.push({ type, orgId, payload });
      return 'evt-1';
    }),
  };
});

const store = new Map<string, string[]>();
vi.mock('../redis', () => ({
  getRedis: () => ({
    async rpush(key: string, value: string) { const l = store.get(key) ?? []; l.push(value); store.set(key, l); return l.length; },
    async ltrim(key: string, start: number, stop: number) { const l = store.get(key) ?? []; store.set(key, l.slice(start, stop === -1 ? undefined : stop + 1)); return 'OK'; },
    async expire() { return 1; },
    async lrange(key: string) { return store.get(key) ?? []; },
  }),
}));

describe('emitRunProgress', () => {
  beforeEach(() => { published.length = 0; store.clear(); __resetRunProgressOrdinals(); });

  it('publishes ai.agent.run.progress with a monotonic per-run ordinal', async () => {
    const ctx = { orgId: 'org-1', runId: 'run-1' };
    await emitRunProgress(ctx, 'export', 'Exported event_logs');
    await emitRunProgress(ctx, 'export', 'Exported metrics');
    expect(published.map((p) => p.type)).toEqual(['ai.agent.run.progress', 'ai.agent.run.progress']);
    expect(published.map((p) => p.payload.ordinal)).toEqual([1, 2]);
    expect(published[0]!.payload).toMatchObject({ runId: 'run-1', step: 'export', label: 'Exported event_logs' });
  });

  it('mirrors entries into the run progress ring, readable back in order', async () => {
    await emitRunProgress({ orgId: 'org-1', runId: 'run-2' }, 'admitted', 'Run admitted');
    await emitRunProgress({ orgId: 'org-1', runId: 'run-2' }, 'export', 'Exported agent_logs');
    const entries = await readRunProgress('run-2');
    expect(entries.map((e) => e.label)).toEqual(['Run admitted', 'Exported agent_logs']);
    expect(entries.map((e) => e.ordinal)).toEqual([1, 2]);
    expect(store.has(runProgressKey('run-2'))).toBe(true);
  });

  it('caps the ring at RUN_PROGRESS_MAX_ENTRIES', async () => {
    for (let i = 0; i < RUN_PROGRESS_MAX_ENTRIES + 5; i += 1) {
      await emitRunProgress({ orgId: 'org-1', runId: 'run-3' }, 'export', `step ${i}`);
    }
    const entries = await readRunProgress('run-3');
    expect(entries.length).toBe(RUN_PROGRESS_MAX_ENTRIES);
    expect(entries[entries.length - 1]!.label).toBe(`step ${RUN_PROGRESS_MAX_ENTRIES + 4}`);
  });

  it('never throws when the event bus fails — telemetry must not fail a run', async () => {
    const { publishEvent } = await import('../eventBus');
    (publishEvent as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis down'));
    await expect(emitRunProgress({ orgId: 'org-1', runId: 'run-4' }, 'export', 'x')).resolves.toBeUndefined();
  });
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiAgents/runProgress.test.ts` — expect failure: `Failed to resolve import "./runProgress"`.
- [ ] Create `apps/api/src/services/aiAgents/runProgress.ts`:
```ts
/**
 * Run progress telemetry (spec §5.8, W03).
 *
 * TWO SINKS, ON PURPOSE. `publishEvent` reaches the events WebSocket (chat run
 * cards, dashboards); the Redis ring is what the RUN DETAIL PAGE can actually
 * read, because that page POLLS `GET /ai/agents/runs/:runId` every 5s
 * (DETAIL_POLL_INTERVAL_MS) and subscribes to no stream. Neither is durable
 * run state: the durable per-step transcript is `ai_run_workspaces.steps`
 * (W04). This is a one-hour, fifty-entry window on a live run — losing it
 * costs a spinner, never a record.
 */
import { publishEvent } from '../eventBus';
import { getRedis } from '../redis';

export interface RunProgressContext {
  orgId: string;
  runId: string;
}

export interface RunProgressEntry {
  step: string;
  label: string;
  ordinal: number;
  at: string;
}

export const RUN_PROGRESS_MAX_ENTRIES = 50;
export const RUN_PROGRESS_TTL_SECONDS = 3600;

/** Ring key. Carries the run id only — no org id, matching the artifact-key rule. */
export function runProgressKey(runId: string): string {
  return `breeze:ai:run-progress:${runId}`;
}

/**
 * Per-run ordinal counter. Process-local: a run executes inside ONE worker
 * process for its whole life (the run lease), so a single counter is correct.
 * Bounded by the same cap as the ring so a long-lived worker cannot grow it.
 */
const ordinals = new Map<string, number>();

function nextOrdinal(runId: string): number {
  const next = (ordinals.get(runId) ?? 0) + 1;
  ordinals.set(runId, next);
  if (ordinals.size > 10_000) {
    const oldest = ordinals.keys().next();
    if (!oldest.done) ordinals.delete(oldest.value);
  }
  return next;
}

/** Tests only — resets the module-level ordinal table. */
export function __resetRunProgressOrdinals(): void {
  ordinals.clear();
}

/**
 * Record one progress beat. NEVER throws: an observability write must not be
 * able to turn a finished run into a failed one (same rule as runLoop's
 * `safePublish`).
 */
export async function emitRunProgress(
  ctx: RunProgressContext,
  step: string,
  label: string,
): Promise<void> {
  const entry: RunProgressEntry = {
    step,
    label,
    ordinal: nextOrdinal(ctx.runId),
    at: new Date().toISOString(),
  };

  try {
    await publishEvent(
      'ai.agent.run.progress',
      ctx.orgId,
      { runId: ctx.runId, step: entry.step, label: entry.label, ordinal: entry.ordinal },
      'ai-agent-runner',
    );
  } catch (error) {
    console.error('[aiRunProgress] failed to publish progress event', { runId: ctx.runId, error });
  }

  try {
    const redis = getRedis();
    if (!redis) return;
    const key = runProgressKey(ctx.runId);
    await redis.rpush(key, JSON.stringify(entry));
    await redis.ltrim(key, -RUN_PROGRESS_MAX_ENTRIES, -1);
    await redis.expire(key, RUN_PROGRESS_TTL_SECONDS);
  } catch (error) {
    console.error('[aiRunProgress] failed to mirror progress entry', { runId: ctx.runId, error });
  }
}

/**
 * Read back the ring for the run detail DTO. Returns `[]` when Redis is
 * unavailable or the window has expired — an empty step list, never an error:
 * the page's other sections must still render.
 */
export async function readRunProgress(runId: string): Promise<RunProgressEntry[]> {
  try {
    const redis = getRedis();
    if (!redis) return [];
    const raw = await redis.lrange(runProgressKey(runId), 0, -1);
    const entries: RunProgressEntry[] = [];
    for (const item of raw) {
      try {
        const parsed = JSON.parse(item) as RunProgressEntry;
        if (typeof parsed.step === 'string' && typeof parsed.label === 'string' && typeof parsed.ordinal === 'number') {
          entries.push(parsed);
        }
      } catch {
        // A malformed ring entry is skipped, not fatal.
      }
    }
    return entries;
  } catch (error) {
    console.error('[aiRunProgress] failed to read progress ring', { runId, error });
    return [];
  }
}
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiAgents/runProgress.test.ts` — expect all five tests PASS.
- [ ] Commit: `git add apps/api/src/services/aiAgents/runProgress.ts apps/api/src/services/aiAgents/runProgress.test.ts && git commit -m "feat(ai): emitRunProgress publishes and mirrors run progress beats"`

---

### Task 4: Expose the builders the adapters reuse

Four builders the adapters need are module-private today: `readDeviceFindings` / `readCatalog` (`aiToolsVulnerability.ts`), the inline agent-log predicate list in `search_agent_logs`, `aiLiveReportAuthority` (`aiToolsFleet.ts:157`) and the custom-field-definition query inlined in `query_custom_fields` (`aiToolsDevice.ts:497-502`). Export or extract each — **never** re-type its body in the adapter file. Each of these carries authz the adapter cannot see: the site axis (`resolveSiteAllowedDeviceIds`), the report execution authority, and the partner-wide `org_id IS NULL` / `partner_id IS NULL` branches of the custom-field definitions. A second copy is a second place to forget them.

**Files:**
- Modify `apps/api/src/services/aiToolsVulnerability.ts` (lines 92–155: `readCatalog`, `readDeviceFindings`)
- Modify `apps/api/src/services/aiToolsAgentLogs.ts` (lines 26–145: `search_agent_logs` handler)
- Modify `apps/api/src/services/aiToolsFleet.ts` (line 157: `aiLiveReportAuthority`)
- Modify `apps/api/src/services/aiToolsDevice.ts` (lines ~491–556: both `query_custom_fields` branches)
- Modify `apps/api/src/services/aiToolsAgentLogs.test.ts`
- Modify `apps/api/src/services/aiToolsVulnerability.test.ts`
- Modify `apps/api/src/services/aiToolsFleet.test.ts`
- Create `apps/api/src/services/aiToolsDevice.customFields.test.ts` (there is no `aiToolsDevice.test.ts` in the repo — only `aiToolsDevice.siteScope.test.ts`)

**Interfaces:**

Produces (`aiToolsVulnerability.ts`) — same bodies, `export` added:
```ts
export interface DeviceRow { id: string; deviceId: string; vulnerabilityId: string; status: string; riskScore: string | null }
export interface CatalogRow { id: string; cveId: string; severity: string | null; cvssScore: string | null; knownExploited: boolean | null; epssScore: string | null; patchAvailable: boolean | null }
export async function readCatalog(vulnerabilityIds: string[], severity?: string): Promise<CatalogRow[]>;
export async function readDeviceFindings(orgId: string, opts: { status: string; deviceId?: string }): Promise<DeviceRow[]>;
export function normStatus(value: unknown): string;
```

Produces (`aiToolsAgentLogs.ts`):
```ts
export interface AgentLogQueryFilters {
  deviceIds?: string[];
  level?: string;
  component?: string;
  startTime?: string;
  endTime?: string;
  message?: string;
}
/** The exact predicate list `search_agent_logs` uses, including the site-axis
 *  narrowing. `null` ⇒ the caller has zero in-scope devices (empty result). */
export async function buildAgentLogConditions(
  orgId: string, auth: AuthContext, filters: AgentLogQueryFilters,
): Promise<SQL[] | null>;
```

Produces (`aiToolsFleet.ts`) — same body, `export` added:
```ts
export async function aiLiveReportAuthority(
  auth: AuthContext, orgId: string, action: ReportAction,
): Promise<(Omit<UserReportExecutionAuthority, 'scope'> & { scope: LiveSiteScopeV1 }) | null>;
```

Produces (`aiToolsDevice.ts`) — the partner-wide-aware definition query, lifted out of both `query_custom_fields` branches:
```ts
/** The dual-axis predicate list for custom-field definitions: org-owned rows
 *  PLUS partner-wide rows (`org_id IS NULL` / `partner_id IS NULL`). */
export function customFieldDefinitionConditions(auth: AuthContext): SQL[];
export async function readCustomFieldDefinitions(auth: AuthContext): Promise<Array<{
  id: string; name: string; fieldKey: string; type: string;
  required: boolean | null; options: unknown; deviceTypes: unknown; defaultValue: string | null;
}>>;
```

Steps:

- [ ] Add a failing test to `apps/api/src/services/aiToolsVulnerability.test.ts`:
```ts
it('exports the finding and catalog readers for reuse by export_dataset', async () => {
  const mod = await import('./aiToolsVulnerability');
  expect(typeof mod.readDeviceFindings).toBe('function');
  expect(typeof mod.readCatalog).toBe('function');
  expect(typeof mod.normStatus).toBe('function');
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsVulnerability.test.ts` — expect failure on `typeof mod.readDeviceFindings` being `'undefined'`.
- [ ] In `aiToolsVulnerability.ts` add `export` to `interface DeviceRow`, `interface CatalogRow`, `function normStatus`, `async function readCatalog` and `async function readDeviceFindings`. Change nothing else — same bodies, same DB contexts.
- [ ] Re-run — expect PASS.
- [ ] Add a failing test to `apps/api/src/services/aiToolsAgentLogs.test.ts`:
```ts
it('exports the shared agent-log predicate builder', async () => {
  const mod = await import('./aiToolsAgentLogs');
  expect(typeof mod.buildAgentLogConditions).toBe('function');
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsAgentLogs.test.ts` — expect failure.
- [ ] In `aiToolsAgentLogs.ts`, lift the predicate construction out of the handler into a module-level exported function placed directly above `registerAgentLogTools`:
```ts
export interface AgentLogQueryFilters {
  deviceIds?: string[];
  level?: string;
  component?: string;
  startTime?: string;
  endTime?: string;
  message?: string;
}

/**
 * The one predicate list for `agent_logs`, shared by `search_agent_logs` and
 * `export_dataset`. Extracted rather than duplicated: the site-axis narrowing
 * below is app-layer authz that RLS does NOT enforce, so a second copy would be
 * a second place to forget it.
 *
 * Returns `null` when a site-restricted caller has zero in-scope devices —
 * distinct from `[]` (an unrestricted caller with no filters).
 */
export async function buildAgentLogConditions(
  orgId: string,
  auth: AuthContext,
  filters: AgentLogQueryFilters,
): Promise<SQL[] | null> {
  const conditions: SQL[] = [eq(agentLogs.orgId, orgId)];

  if (filters.deviceIds && filters.deviceIds.length > 0) {
    conditions.push(inArray(agentLogs.deviceId, filters.deviceIds));
  }

  if (auth.allowedSiteIds) {
    const allowed = await resolveSiteAllowedDeviceIds(orgId, auth);
    if (!allowed || allowed.length === 0) return null;
    conditions.push(inArray(agentLogs.deviceId, allowed));
  }

  if (filters.level) conditions.push(eq(agentLogs.level, filters.level as any));
  if (filters.component) conditions.push(eq(agentLogs.component, filters.component));
  if (filters.startTime) conditions.push(gte(agentLogs.timestamp, new Date(filters.startTime)));
  if (filters.endTime) conditions.push(lte(agentLogs.timestamp, new Date(filters.endTime)));
  if (filters.message) conditions.push(ilike(agentLogs.message, `%${escapeLike(filters.message)}%`));

  return conditions;
}
```
Add `import { type SQL } from 'drizzle-orm';` to the existing drizzle import line.
- [ ] Replace the handler's inline predicate block (the `const filters = [eq(agentLogs.orgId, orgId)];` … `ilike` run) with:
```ts
        const conditions = await buildAgentLogConditions(orgId, auth, {
          deviceIds: Array.isArray(input.deviceIds) ? input.deviceIds as string[] : undefined,
          level: typeof input.level === 'string' ? input.level : undefined,
          component: typeof input.component === 'string' ? input.component : undefined,
          startTime: typeof input.startTime === 'string' ? input.startTime : undefined,
          endTime: typeof input.endTime === 'string' ? input.endTime : undefined,
          message: typeof input.message === 'string' ? input.message : undefined,
        });
        if (conditions === null) {
          return JSON.stringify({ logs: [], count: 0 });
        }
```
and change the query's `.where(and(...filters))` to `.where(and(...conditions))`.
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsAgentLogs.test.ts src/services/aiToolsAgentLogs.siteScope.test.ts` — expect PASS on both (the siteScope suite is the regression guard that the extraction preserved the narrowing).
- [ ] Add a failing test to `apps/api/src/services/aiToolsFleet.test.ts`:
```ts
it('exports the live report authority resolver for reuse by export_dataset', async () => {
  const mod = await import('./aiToolsFleet');
  expect(typeof mod.aiLiveReportAuthority).toBe('function');
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsFleet.test.ts` — expect failure on `typeof mod.aiLiveReportAuthority` being `'undefined'`.
- [ ] In `aiToolsFleet.ts` add `export` to `async function aiLiveReportAuthority` (line 157). Change nothing else — same body, same callers. It lives in `aiToolsFleet.ts`, **not** `siteScope.ts`; the adapters import it from `./aiToolsFleet`.
- [ ] Re-run `cd apps/api && npx vitest run src/services/aiToolsFleet.test.ts src/services/aiToolsFleet.siteScope.test.ts` — expect PASS on both.
- [ ] Write the failing test `apps/api/src/services/aiToolsDevice.customFields.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('custom field definition query extraction', () => {
  it('exports the dual-axis definition reader and its predicate builder', async () => {
    const mod = await import('./aiToolsDevice');
    expect(typeof mod.readCustomFieldDefinitions).toBe('function');
    expect(typeof mod.customFieldDefinitionConditions).toBe('function');
  });

  it('builds one predicate per axis so partner-wide definitions survive', async () => {
    // org axis + partner axis = two OR-ed predicates; an org-only `eq` would be one.
    const { customFieldDefinitionConditions } = await import('./aiToolsDevice');
    expect(customFieldDefinitionConditions({ orgId: 'org-1', partnerId: 'p-1' } as never)).toHaveLength(2);
    expect(customFieldDefinitionConditions({ orgId: 'org-1' } as never)).toHaveLength(1);
  });
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsDevice.customFields.test.ts` — expect failure: `typeof mod.readCustomFieldDefinitions` is `'undefined'`.
- [ ] In `aiToolsDevice.ts`, lift the definition query out of BOTH `query_custom_fields` branches into module-level exported functions placed directly above `registerDeviceTools`:
```ts
/**
 * Custom-field definitions are a DUAL-AXIS (org XOR partner) config table: a
 * partner-wide definition has `org_id IS NULL`, and an org-owned one has
 * `partner_id IS NULL`. An `eq(orgId, auth.orgId)` filter silently drops every
 * partner-wide field — which for an MSP is most of them. Exported so
 * `export_dataset`'s `custom_fields` adapter runs this exact predicate list
 * instead of a second, narrower one.
 */
export function customFieldDefinitionConditions(auth: AuthContext): SQL[] {
  const conditions: SQL[] = [];
  if (auth.orgId) {
    conditions.push(
      sql`(${customFieldDefinitions.orgId} = ${auth.orgId} OR ${customFieldDefinitions.orgId} IS NULL)`
    );
  }
  if (auth.partnerId) {
    conditions.push(
      sql`(${customFieldDefinitions.partnerId} = ${auth.partnerId} OR ${customFieldDefinitions.partnerId} IS NULL)`
    );
  }
  return conditions;
}

export async function readCustomFieldDefinitions(auth: AuthContext) {
  const conditions = customFieldDefinitionConditions(auth);
  return db
    .select({
      id: customFieldDefinitions.id,
      name: customFieldDefinitions.name,
      fieldKey: customFieldDefinitions.fieldKey,
      type: customFieldDefinitions.type,
      required: customFieldDefinitions.required,
      options: customFieldDefinitions.options,
      deviceTypes: customFieldDefinitions.deviceTypes,
      defaultValue: customFieldDefinitions.defaultValue,
    })
    .from(customFieldDefinitions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(customFieldDefinitions.name);
}
```
- [ ] Replace the `list_definitions` branch body with `const definitions = await readCustomFieldDefinitions(auth);` (its projection is identical). In the `get_device_values` branch, replace only the inline `const conditions: SQL[] = [];` … block with `const conditions = customFieldDefinitionConditions(auth);` and leave that branch's narrower `.select({...})` projection exactly as it is — it deliberately omits `deviceTypes`, and widening it would change a shipped tool response shape.
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsDevice.customFields.test.ts src/services/aiToolsDevice.siteScope.test.ts` — expect PASS on both.
- [ ] Commit: `git add apps/api/src/services/aiToolsVulnerability.ts apps/api/src/services/aiToolsVulnerability.test.ts apps/api/src/services/aiToolsAgentLogs.ts apps/api/src/services/aiToolsAgentLogs.test.ts apps/api/src/services/aiToolsFleet.ts apps/api/src/services/aiToolsFleet.test.ts apps/api/src/services/aiToolsDevice.ts apps/api/src/services/aiToolsDevice.customFields.test.ts && git commit -m "refactor(ai): export the query builders export_dataset reuses (vulnerability, agent logs, report authority, custom fields)"`

---

### Task 5: The streaming export writer (JSONL / CSV, caps, pacing)

**Files:**
- Create `apps/api/src/services/aiToolsExportWriter.ts`
- Create `apps/api/src/services/aiToolsExportWriter.test.ts`

**Interfaces:**

Consumes: `csvRow(values: readonly unknown[]): string` and `escapeCsvCell(value: unknown): string` from `apps/api/src/services/spreadsheetExport.ts` (already handles `"` doubling, formula neutralisation and embedded newlines — do not write a second escaper).

Produces:
```ts
export type ExportFormat = 'jsonl' | 'csv';
export const EXPORT_DEFAULT_MAX_ROWS = 200_000;
export const EXPORT_HARD_MAX_ROWS = 1_000_000;
export const EXPORT_WALL_MS = 120_000;
export const EXPORT_DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
export const EXPORT_DEVICE_CONCURRENCY = 4;
export const EXPORT_PREVIEW_BYTES = 2048;

export class ExportCapError extends Error {
  readonly code: 'artifact_bytes_exceeded';
  constructor(bytes: number, maxBytes: number);
}

/** One page of already-projected rows plus the cursor for the next page. */
export interface ExportPage { rows: Array<Record<string, unknown>>; nextCursor: string | null }
export type ExportPager = (cursor: string | null) => Promise<ExportPage>;

export interface ExportResult {
  body: NodeJS.ReadableStream;
  /** Resolves once the stream has been fully consumed. */
  stats: Promise<{ rows: number; bytes: number; truncated: boolean; head: string; tail: string }>;
}

export function buildExportStream(
  pager: ExportPager,
  opts: { format: ExportFormat; maxRows: number; maxBytes: number; wallMs: number; now?: () => number },
): ExportResult;

export async function runWithConcurrency<T>(
  items: readonly T[], concurrency: number, handler: (item: T, index: number) => Promise<void>,
): Promise<void>;
```

Steps:

- [ ] Write the failing test `apps/api/src/services/aiToolsExportWriter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  buildExportStream, runWithConcurrency, ExportCapError,
  EXPORT_DEFAULT_MAX_ROWS, EXPORT_HARD_MAX_ROWS, EXPORT_WALL_MS,
  type ExportPage,
} from './aiToolsExportWriter';

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function pagerOf(pages: ExportPage[]) {
  const calls: Array<string | null> = [];
  return {
    calls,
    pager: async (cursor: string | null) => {
      calls.push(cursor);
      return pages[calls.length - 1] ?? { rows: [], nextCursor: null };
    },
  };
}

describe('buildExportStream', () => {
  it('pages a three-page source to completion as JSONL, one object per line', async () => {
    const { pager, calls } = pagerOf([
      { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' },
      { rows: [{ id: 3 }], nextCursor: 'c2' },
      { rows: [{ id: 4 }], nextCursor: null },
    ]);
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 100, maxBytes: 1e6, wallMs: 60_000 });
    const text = await drain(out.body);
    const stats = await out.stats;

    expect(calls).toEqual([null, 'c1', 'c2']);
    const lines = text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([1, 2, 3, 4]);
    expect(stats.rows).toBe(4);
    expect(stats.truncated).toBe(false);
    expect(stats.bytes).toBe(Buffer.byteLength(text));
  });

  it('stops early at the row cap and reports truncated: true', async () => {
    const { pager } = pagerOf([
      { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' },
      { rows: [{ id: 3 }, { id: 4 }], nextCursor: 'c2' },
      { rows: [{ id: 5 }], nextCursor: null },
    ]);
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 3, maxBytes: 1e6, wallMs: 60_000 });
    const text = await drain(out.body);
    const stats = await out.stats;
    expect(text.split('\n').filter(Boolean)).toHaveLength(3);
    expect(stats.rows).toBe(3);
    expect(stats.truncated).toBe(true);
  });

  it('stops at the wall clock and reports truncated: true', async () => {
    let clock = 0;
    const pager = async (): Promise<ExportPage> => { clock += 40_000; return { rows: [{ id: clock }], nextCursor: 'more' }; };
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 1e6, maxBytes: 1e6, wallMs: 60_000, now: () => clock });
    await drain(out.body);
    const stats = await out.stats;
    expect(stats.truncated).toBe(true);
    expect(stats.rows).toBeLessThan(10);
  });

  it('aborts with a typed ExportCapError when the byte cap is crossed', async () => {
    const big = 'x'.repeat(4096);
    const pager = async (): Promise<ExportPage> => ({ rows: [{ blob: big }], nextCursor: 'more' });
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 1e6, maxBytes: 8192, wallMs: 60_000 });
    await expect(drain(out.body)).rejects.toBeInstanceOf(ExportCapError);
    await expect(out.stats).rejects.toMatchObject({ code: 'artifact_bytes_exceeded' });
  });

  it('writes a CSV header from the first row and escapes quotes and newlines', async () => {
    const { pager } = pagerOf([
      { rows: [{ name: 'say "hi"', note: 'line1\nline2' }, { name: 'plain', note: 'ok' }], nextCursor: null },
    ]);
    const out = buildExportStream(pager, { format: 'csv', maxRows: 100, maxBytes: 1e6, wallMs: 60_000 });
    const text = await drain(out.body);
    const lines = text.split('\n');
    expect(lines[0]).toBe('"name","note"');
    expect(lines[1]).toBe('"say ""hi""","line1');
    expect(lines[2]).toBe('line2"');
    expect(text).toContain('"plain","ok"');
  });

  it('emits head and tail previews of the RAW bytes, capped', async () => {
    const { pager } = pagerOf([{ rows: Array.from({ length: 500 }, (_, i) => ({ i })), nextCursor: null }]);
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 1000, maxBytes: 1e6, wallMs: 60_000 });
    const text = await drain(out.body);
    const stats = await out.stats;
    expect(text.startsWith(stats.head)).toBe(true);
    expect(text.endsWith(stats.tail)).toBe(true);
    expect(Buffer.byteLength(stats.head)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(stats.tail)).toBeLessThanOrEqual(2048);
  });

  it('exposes the spec caps', () => {
    expect(EXPORT_DEFAULT_MAX_ROWS).toBe(200_000);
    expect(EXPORT_HARD_MAX_ROWS).toBe(1_000_000);
    expect(EXPORT_WALL_MS).toBe(120_000);
  });
});

describe('runWithConcurrency', () => {
  it('never exceeds the requested concurrency', async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsExportWriter.test.ts` — expect failure: `Failed to resolve import "./aiToolsExportWriter"`.
- [ ] Create `apps/api/src/services/aiToolsExportWriter.ts`:
```ts
/**
 * Streaming writer behind `export_dataset` (spec §5.7).
 *
 * The whole point of this file is that a full-fidelity export NEVER
 * materialises in memory: a pager yields one page, the page is serialised and
 * pushed downstream, the page is dropped. `createArtifact` consumes the
 * `Readable` and counts bytes as they pass.
 *
 * CAPS ARE NOT ALL THE SAME KIND. Row and wall caps end the export CLEANLY and
 * set `truncated: true` — the model is told it has a prefix and can decide what
 * to do. The BYTE cap destroys the stream with a typed error, because a
 * truncated artifact that claims to be complete is worse than no artifact: the
 * sandbox would compute a confident answer over silently missing data.
 */
import { Readable } from 'node:stream';
import { csvRow } from './spreadsheetExport';

export type ExportFormat = 'jsonl' | 'csv';

export const EXPORT_DEFAULT_MAX_ROWS = 200_000;
export const EXPORT_HARD_MAX_ROWS = 1_000_000;
export const EXPORT_WALL_MS = 120_000;
/** Spec §5.4 `analysisMaxStagedBytesPerRun` default. W04's profile limit
 *  overrides this per run via `ToolExecutionContext.stagedBytesRemaining`. */
export const EXPORT_DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
export const EXPORT_DEVICE_CONCURRENCY = 4;
export const EXPORT_PREVIEW_BYTES = 2048;

export class ExportCapError extends Error {
  readonly code = 'artifact_bytes_exceeded' as const;

  constructor(bytes: number, maxBytes: number) {
    super(`Export exceeded the artifact byte cap (${bytes} > ${maxBytes} bytes)`);
    this.name = 'ExportCapError';
  }
}

export interface ExportPage {
  rows: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

export type ExportPager = (cursor: string | null) => Promise<ExportPage>;

export interface ExportStats {
  rows: number;
  bytes: number;
  truncated: boolean;
  head: string;
  tail: string;
}

export interface ExportResult {
  body: NodeJS.ReadableStream;
  stats: Promise<ExportStats>;
}

/** Bounded-parallelism map. Duplicated locally rather than imported from
 *  `automationRuntime.ts` (a 2 700-line automation module) — `p-limit` is not a
 *  dependency of apps/api and this wave must not add one. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let current = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (current < items.length) {
      const index = current;
      current += 1;
      const item = items[index];
      if (item !== undefined) await handler(item, index);
    }
  });
  await Promise.all(workers);
}

export function buildExportStream(
  pager: ExportPager,
  opts: {
    format: ExportFormat;
    maxRows: number;
    maxBytes: number;
    wallMs: number;
    now?: () => number;
  },
): ExportResult {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();

  let rows = 0;
  let bytes = 0;
  let truncated = false;
  let head = '';
  let tail = '';
  let headerWritten = false;

  let resolveStats: (stats: ExportStats) => void;
  let rejectStats: (error: unknown) => void;
  const stats = new Promise<ExportStats>((resolve, reject) => {
    resolveStats = resolve;
    rejectStats = reject;
  });

  function accountPreview(chunk: string): void {
    if (Buffer.byteLength(head) < EXPORT_PREVIEW_BYTES) {
      head = Buffer.from(head + chunk).subarray(0, EXPORT_PREVIEW_BYTES).toString('utf8');
    }
    const merged = tail + chunk;
    tail = Buffer.from(merged)
      .subarray(Math.max(0, Buffer.byteLength(merged) - EXPORT_PREVIEW_BYTES))
      .toString('utf8');
  }

  function serialise(row: Record<string, unknown>): string {
    if (opts.format === 'jsonl') return `${JSON.stringify(row)}\n`;
    const keys = Object.keys(row);
    const line = `${csvRow(keys.map((k) => row[k]))}\n`;
    if (headerWritten) return line;
    headerWritten = true;
    return `${csvRow(keys)}\n${line}`;
  }

  async function* generate(): AsyncGenerator<Buffer> {
    let cursor: string | null = null;
    for (;;) {
      const page: ExportPage = await pager(cursor);

      for (const row of page.rows) {
        if (rows >= opts.maxRows) {
          truncated = true;
          return;
        }
        const chunk = serialise(row);
        const chunkBytes = Buffer.byteLength(chunk);
        if (bytes + chunkBytes > opts.maxBytes) {
          throw new ExportCapError(bytes + chunkBytes, opts.maxBytes);
        }
        bytes += chunkBytes;
        rows += 1;
        accountPreview(chunk);
        yield Buffer.from(chunk);
      }

      if (!page.nextCursor) return;
      if (rows >= opts.maxRows) {
        truncated = true;
        return;
      }
      if (now() - startedAt >= opts.wallMs) {
        truncated = true;
        return;
      }
      cursor = page.nextCursor;
    }
  }

  const body = Readable.from(generate());
  body.on('end', () => resolveStats({ rows, bytes, truncated, head, tail }));
  body.on('error', (error) => rejectStats(error));

  return { body, stats };
}
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsExportWriter.test.ts` — expect all eight tests PASS.
- [ ] Commit: `git add apps/api/src/services/aiToolsExportWriter.ts apps/api/src/services/aiToolsExportWriter.test.ts && git commit -m "feat(ai): streaming JSONL/CSV export writer with row, byte and wall caps"`

---

### Task 6: Dataset adapters — one per dataset, each over an existing builder

**Files:**
- Create `apps/api/src/services/aiToolsExportDatasets.ts`
- Create `apps/api/src/services/aiToolsExportDatasets.test.ts`

**Interfaces:**

Consumes (signatures read from the source files, quoted verbatim):
```ts
// services/logSearch.ts:491
export async function searchFleetLogs(auth: AuthContext, filters: LogSearchInput): Promise<{
  results: Array<{ log: typeof deviceEventLogs.$inferSelect;
                   device: { id: string; hostname: string; displayName: string | null; siteId: string } | null;
                   site: { id: string; name: string } | null }>;
  total: number | null; totalMode: 'exact' | 'estimated' | 'none';
  limit: number; offset: number; hasMore: boolean; nextCursor: string | null;
}>;
// LogSearchInput (logSearch.ts:37) carries `cursor?: string`, `limit?: number`,
// `allowedDeviceIds?: string[] | null`, `deviceIds?`, `siteIds?`, `timeRange?`,
// `level?`, `category?`, `source?`, `sortBy?`, `sortOrder?`, `countMode?`.

// services/aiToolsAgentLogs.ts (Task 4)
export async function buildAgentLogConditions(orgId: string, auth: AuthContext, filters: AgentLogQueryFilters): Promise<SQL[] | null>;

// services/reportGenerationService.ts:284 / :395
export async function generateDeviceInventoryReport(orgId: string, config: Record<string, unknown>, authority: ReportExecutionAuthority): Promise<{ rows: unknown[]; rowCount: number }>;
export async function generateSoftwareInventoryReport(orgId: string, config: Record<string, unknown>, authority: ReportExecutionAuthority): Promise<{ rows: unknown[]; rowCount: number }>;
// `aiLiveReportAuthority(auth, orgId, 'read')` lives in services/aiToolsFleet.ts
// (line 157, module-private until Task 4 exports it — it is NOT in siteScope.ts)
// and yields the ReportExecutionAuthority both generators take.
// NOTE: `generateDeviceInventoryReport` honours `filters.siteIds`/`osTypes` ONLY
// — it has no `deviceIds` branch (unlike generateSoftwareInventoryReport:~404),
// so the device_inventory adapter post-filters its rows itself.

// services/aiToolsSiteScope.ts
export async function resolveSiteAllowedDeviceIds(orgId: string, auth: AuthContext): Promise<string[] | null>;
// services/aiToolsDevice.ts (Task 4)
export async function readCustomFieldDefinitions(auth: AuthContext): Promise<Array<{ id: string; name: string; fieldKey: string; type: string }>>;

// services/aiToolsVulnerability.ts (Task 4)
export async function readDeviceFindings(orgId: string, opts: { status: string; deviceId?: string }): Promise<DeviceRow[]>;
export async function readCatalog(vulnerabilityIds: string[], severity?: string): Promise<CatalogRow[]>;

// services/aiTools.ts:140
export async function verifyDeviceAccess(deviceId: string, auth: AuthContext): Promise<{ device: typeof devices.$inferSelect } | { error: string }>;
```

Produces:
```ts
export const EXPORT_DATASETS = [
  'event_logs', 'agent_logs', 'device_inventory', 'software_inventory',
  'metrics', 'vulnerabilities', 'custom_fields',
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export interface DatasetRequest {
  auth: AuthContext;
  orgId: string;
  filters: Record<string, unknown>;
  deviceIds: string[] | null;
  /** The run's frozen target set, or null outside a run frame. Only the
   *  inventory adapters read it — their generator has no deviceIds filter. */
  runTargets: string[] | null;
  siteId: string | null;
  pageSize: number;
}
export interface DatasetAdapter {
  /** Tier of the SOURCE tool — export never widens it (spec §5.7). */
  tier: 1 | 2;
  /** True when this dataset fans out per device and must be paced. */
  deviceScoped: boolean;
  createPager(req: DatasetRequest): Promise<ExportPager>;
}
export const DATASET_ADAPTERS: Readonly<Record<ExportDataset, DatasetAdapter>>;
```

Steps:

- [ ] Write the failing test `apps/api/src/services/aiToolsExportDatasets.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DATASET_ADAPTERS, EXPORT_DATASETS } from './aiToolsExportDatasets';

const searchFleetLogs = vi.fn();
vi.mock('./logSearch', () => ({ searchFleetLogs: (...a: unknown[]) => searchFleetLogs(...a) }));

const resolveSiteAllowedDeviceIds = vi.fn(async () => null as string[] | null);
vi.mock('./aiToolsSiteScope', () => ({
  resolveSiteAllowedDeviceIds: (...a: unknown[]) => resolveSiteAllowedDeviceIds(...(a as [])),
  SITE_SCOPE_EMPTY_NOTE: '',
}));

const generateDeviceInventoryReport = vi.fn();
vi.mock('./reportGenerationService', () => ({
  generateDeviceInventoryReport: (...a: unknown[]) => generateDeviceInventoryReport(...a),
  generateSoftwareInventoryReport: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));
vi.mock('./aiToolsFleet', () => ({ aiLiveReportAuthority: async () => ({ scope: { kind: 'live_v1' } }) }));

const readCustomFieldDefinitions = vi.fn(async () => [] as Array<Record<string, unknown>>);
vi.mock('./aiToolsDevice', () => ({
  readCustomFieldDefinitions: () => readCustomFieldDefinitions(),
  customFieldDefinitionConditions: () => [],
}));

const verifyDeviceAccess = vi.fn(async (deviceId: string) => ({ device: { id: deviceId, hostname: `host-${deviceId}`, customFields: { tier: 'gold' } } }));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: (id: string) => verifyDeviceAccess(id) }));

const auth = { orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: null, canAccessSite: undefined } as never;
const siteAuth = { orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: ['site-1'], canAccessSite: () => true } as never;

describe('dataset adapters', () => {
  beforeEach(() => {
    searchFleetLogs.mockReset();
    resolveSiteAllowedDeviceIds.mockReset();
    resolveSiteAllowedDeviceIds.mockResolvedValue(null);
    generateDeviceInventoryReport.mockReset();
    readCustomFieldDefinitions.mockReset();
    readCustomFieldDefinitions.mockResolvedValue([]);
  });

  it('covers every dataset named in the spec', () => {
    expect(Object.keys(DATASET_ADAPTERS).sort()).toEqual([...EXPORT_DATASETS].sort());
    expect(EXPORT_DATASETS).toContain('event_logs');
    expect(EXPORT_DATASETS).toContain('custom_fields');
  });

  it('every adapter declares the tier of its source tool and never above 2', () => {
    for (const adapter of Object.values(DATASET_ADAPTERS)) {
      expect([1, 2]).toContain(adapter.tier);
    }
  });

  it('event_logs pages with the keyset cursor searchFleetLogs returns', async () => {
    searchFleetLogs
      .mockResolvedValueOnce({ results: [{ log: { id: 'a', timestamp: new Date(0), level: 'info', category: 'system', source: 's', eventId: '1', message: 'm', deviceId: 'd1' }, device: null, site: null }], nextCursor: 'cur-1', hasMore: true })
      .mockResolvedValueOnce({ results: [{ log: { id: 'b', timestamp: new Date(0), level: 'info', category: 'system', source: 's', eventId: '2', message: 'm2', deviceId: 'd1' }, device: null, site: null }], nextCursor: null, hasMore: false });

    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500,
    });

    const first = await pager(null);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ id: 'a', message: 'm' });
    expect(first.nextCursor).toBe('cur-1');

    const second = await pager('cur-1');
    expect(second.nextCursor).toBeNull();
    expect(searchFleetLogs.mock.calls[1]![1]).toMatchObject({ cursor: 'cur-1', limit: 500 });
  });

  it('event_logs passes the requested device set through to the builder', async () => {
    searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth, orgId: 'org-1', filters: { level: ['error'] }, deviceIds: ['d1', 'd2'], runTargets: null, siteId: null, pageSize: 500,
    });
    await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ deviceIds: ['d1', 'd2'], level: ['error'] });
  });

  // --- site axis: the narrowing `search_logs` performs at aiToolsEventLogs.ts:84 ---

  it('event_logs narrows a site-restricted caller to its in-scope devices', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue(['d-in-scope']);
    searchFleetLogs.mockResolvedValue({
      results: [{ log: { id: 'a', timestamp: new Date(0), level: 'info', category: 'system', source: 's', eventId: '1', message: 'm', deviceId: 'd-in-scope' }, device: null, site: null }],
      nextCursor: null, hasMore: false,
    });
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d-in-scope'] });
    expect(page.rows.map((r) => r.deviceId)).toEqual(['d-in-scope']);
  });

  it('event_logs yields an empty artifact when a site-restricted caller has zero in-scope devices', async () => {
    resolveSiteAllowedDeviceIds.mockResolvedValue([]);
    const pager = await DATASET_ADAPTERS.event_logs.createPager({
      auth: siteAuth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(page).toEqual({ rows: [], nextCursor: null });
    expect(searchFleetLogs).not.toHaveBeenCalled();
  });

  it('device_inventory restricts rows to the requested devices even though the generator ignores deviceIds', async () => {
    generateDeviceInventoryReport.mockResolvedValue({
      rows: [
        { hostname: 'host-d1', osType: 'windows' },
        { hostname: 'host-d2', osType: 'windows' },
        { hostname: 'host-d3', osType: 'windows' },
      ],
      rowCount: 3,
    });
    const pager = await DATASET_ADAPTERS.device_inventory.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(page.rows.map((r) => r.hostname)).toEqual(['host-d1']);
  });

  it('device_inventory falls back to the run target set when no deviceIds were supplied', async () => {
    generateDeviceInventoryReport.mockResolvedValue({
      rows: [{ hostname: 'host-d1' }, { hostname: 'host-d9' }],
      rowCount: 2,
    });
    const pager = await DATASET_ADAPTERS.device_inventory.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: ['d1'], siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(page.rows.map((r) => r.hostname)).toEqual(['host-d1']);
  });

  it('custom_fields includes partner-wide definitions via the shared reader', async () => {
    readCustomFieldDefinitions.mockResolvedValue([
      { id: 'def-partner', name: 'Contract tier', fieldKey: 'tier', type: 'text' },
    ]);
    const pager = await DATASET_ADAPTERS.custom_fields.createPager({
      auth, orgId: 'org-1', filters: {}, deviceIds: ['d1'], runTargets: null, siteId: null, pageSize: 500,
    });
    const page = await pager(null);
    expect(readCustomFieldDefinitions).toHaveBeenCalledTimes(1);
    expect(page.rows).toEqual([
      expect.objectContaining({ deviceId: 'd1', fieldKey: 'tier', fieldName: 'Contract tier', value: 'gold' }),
    ]);
  });
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsExportDatasets.test.ts` — expect failure: module not found.
- [ ] Create `apps/api/src/services/aiToolsExportDatasets.ts`. Header and shared types:
```ts
/**
 * Dataset adapters for `export_dataset` (spec §5.7).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: every adapter delegates to the query
 * builder that already backs the corresponding tool. Not "a query that looks
 * like it"; the same function. Each of those builders carries tenant narrowing
 * that RLS does NOT enforce — the site axis — and a second hand-written query
 * is a second place to forget it. If a dataset here ever needs a shape the
 * source builder cannot produce, widen the builder and let BOTH callers get it.
 *
 * Row projections below are the tool's own response projection, one object per
 * row, flattened: the sandbox reads these with pandas/jq, so nested objects and
 * a `logs: [...]` envelope would both be hostile.
 */
import { and, desc, gt, lt, or, eq } from 'drizzle-orm';
import { db } from '../db';
import { agentLogs, deviceMetrics } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { searchFleetLogs } from './logSearch';
import { buildAgentLogConditions } from './aiToolsAgentLogs';
import { redactAgentLogRow } from './logRedaction';
import { readCatalog, readDeviceFindings, normStatus } from './aiToolsVulnerability';
import {
  generateDeviceInventoryReport,
  generateSoftwareInventoryReport,
} from './reportGenerationService';
// `aiLiveReportAuthority` lives in aiToolsFleet.ts (exported by Task 4), NOT in
// siteScope.ts — importing it from the latter is a module-not-found at runtime.
import { aiLiveReportAuthority } from './aiToolsFleet';
import { resolveSiteAllowedDeviceIds } from './aiToolsSiteScope';
import { readCustomFieldDefinitions } from './aiToolsDevice';
import { verifyDeviceAccess } from './aiTools';
import { runWithConcurrency, EXPORT_DEVICE_CONCURRENCY, type ExportPager } from './aiToolsExportWriter';

export const EXPORT_DATASETS = [
  'event_logs', 'agent_logs', 'device_inventory', 'software_inventory',
  'metrics', 'vulnerabilities', 'custom_fields',
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export interface DatasetRequest {
  auth: AuthContext;
  orgId: string;
  filters: Record<string, unknown>;
  deviceIds: string[] | null;
  /** Devices frozen at admission, or null outside a run frame. Only the
   *  inventory adapters read it (their generator has no deviceIds filter);
   *  every other adapter is already narrowed by `deviceIds` + its builder. */
  runTargets: string[] | null;
  siteId: string | null;
  pageSize: number;
}

export interface DatasetAdapter {
  tier: 1 | 2;
  deviceScoped: boolean;
  createPager(req: DatasetRequest): Promise<ExportPager>;
}

/** The site-axis narrowing `search_logs` does at `aiToolsEventLogs.ts:84`,
 *  reproduced because that call site is module-private. `null` = unrestricted
 *  caller; `[]` = restricted caller with ZERO in-scope devices, which must
 *  yield an empty export rather than an org-wide one. */
async function siteScopedDeviceIds(req: DatasetRequest): Promise<string[] | null> {
  if (!req.auth.allowedSiteIds || !req.auth.canAccessSite) return null;
  return resolveSiteAllowedDeviceIds(req.orgId, req.auth);
}

/** A pager that yields nothing — the shape a zero-in-scope caller gets. */
const emptyPager: ExportPager = async () => ({ rows: [], nextCursor: null });

/** A source that produces its whole result in one builder call. Wrapped as a
 *  one-page pager so the writer's cap/preview machinery is identical for all
 *  seven datasets. */
function singlePagePager(load: () => Promise<Array<Record<string, unknown>>>): ExportPager {
  let done = false;
  return async () => {
    if (done) return { rows: [], nextCursor: null };
    done = true;
    return { rows: await load(), nextCursor: null };
  };
}
```
- [ ] Add the `event_logs` adapter (keyset cursor, `search_logs`'s builder):
```ts
const eventLogsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  async createPager(req) {
    const f = req.filters;
    // Same two lines `search_logs` runs before it queries (aiToolsEventLogs.ts:84).
    // `allowedDeviceIds` is the site axis, which RLS does NOT enforce; dropping
    // it would let a site-restricted tech export the whole org's logs.
    const allowedDeviceIds = await siteScopedDeviceIds(req);
    if (allowedDeviceIds != null && allowedDeviceIds.length === 0) return emptyPager;

    return async (cursor) => {
      const result = await searchFleetLogs(req.auth, {
        allowedDeviceIds,
        query: typeof f.query === 'string' ? f.query : undefined,
        timeRange: typeof f.timeRange === 'object' && f.timeRange !== null
          ? f.timeRange as { start?: string; end?: string }
          : undefined,
        level: Array.isArray(f.level) ? f.level as Array<'info' | 'warning' | 'error' | 'critical'> : undefined,
        category: Array.isArray(f.category) ? f.category as Array<'security' | 'hardware' | 'application' | 'system'> : undefined,
        source: typeof f.source === 'string' ? f.source : undefined,
        deviceIds: req.deviceIds ?? undefined,
        siteIds: req.siteId ? [req.siteId] : undefined,
        limit: req.pageSize,
        cursor: cursor ?? undefined,
        // `none`: a COUNT(*) per page over a multi-hundred-thousand-row range
        // is the export's whole cost again, and nothing consumes the total.
        countMode: 'none',
        sortBy: 'timestamp',
        sortOrder: 'desc',
      });
      return {
        rows: result.results.map((row) => ({
          id: row.log.id,
          timestamp: row.log.timestamp.toISOString(),
          level: row.log.level,
          category: row.log.category,
          source: row.log.source,
          eventId: row.log.eventId,
          message: row.log.message,
          deviceId: row.log.deviceId,
          hostname: row.device?.hostname ?? null,
          siteId: row.device?.siteId ?? null,
          siteName: row.site?.name ?? null,
        })),
        nextCursor: result.nextCursor,
      };
    };
  },
};
```
- [ ] Add the `agent_logs` adapter (keyset over `(timestamp, id)` built on Task 4's shared predicate list):
```ts
const agentLogsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  async createPager(req) {
    const f = req.filters;
    const conditions = await buildAgentLogConditions(req.orgId, req.auth, {
      deviceIds: req.deviceIds ?? undefined,
      level: typeof f.level === 'string' ? f.level : undefined,
      component: typeof f.component === 'string' ? f.component : undefined,
      startTime: typeof f.startTime === 'string' ? f.startTime : undefined,
      endTime: typeof f.endTime === 'string' ? f.endTime : undefined,
      message: typeof f.message === 'string' ? f.message : undefined,
    });
    // `null` = a site-restricted caller with zero in-scope devices.
    if (conditions === null) return async () => ({ rows: [], nextCursor: null });

    return async (cursor) => {
      // `search_agent_logs` orders by timestamp desc and has no cursor of its
      // own (it is a single capped page). Paging needs a tiebreaker, so the
      // keyset is (timestamp, id) desc — the same order, made total.
      const decoded = cursor
        ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t: string; id: string }
        : null;
      const keyset = decoded
        ? or(
            lt(agentLogs.timestamp, new Date(decoded.t)),
            and(eq(agentLogs.timestamp, new Date(decoded.t)), lt(agentLogs.id, decoded.id)),
          )!
        : undefined;

      const rows = await db
        .select()
        .from(agentLogs)
        .where(keyset ? and(...conditions, keyset) : and(...conditions))
        .orderBy(desc(agentLogs.timestamp), desc(agentLogs.id))
        .limit(req.pageSize);

      const last = rows[rows.length - 1];
      return {
        rows: rows.map((r) => {
          const redacted = redactAgentLogRow(r);
          return {
            id: r.id,
            deviceId: r.deviceId,
            timestamp: r.timestamp.toISOString(),
            level: r.level,
            component: r.component,
            message: redacted.message,
            fields: redacted.fields,
            agentVersion: r.agentVersion,
          };
        }),
        nextCursor: rows.length === req.pageSize && last
          ? Buffer.from(JSON.stringify({ t: last.timestamp.toISOString(), id: last.id })).toString('base64url')
          : null,
      };
    };
  },
};
```
- [ ] Add the two inventory adapters over the report generators:
```ts
/** `generate_report` action `data` has no `software_inventory` branch and caps
 *  `device_inventory` at 100 rows — the REPORT GENERATORS are the complete
 *  builders behind both, and the ones `generate_report action: 'generate'`
 *  itself calls. Each returns its full result in one call, so one page. The
 *  writer's row/byte caps still apply to what that page yields.
 *
 *  ASYMMETRY TO KNOW: `generateSoftwareInventoryReport` honours
 *  `filters.deviceIds` (reportGenerationService.ts:~404); `generateDeviceInventoryReport`
 *  (:284-330) does NOT — it reads `siteIds` and `osTypes` only. Passing
 *  `deviceIds` to it is silently ignored, so a device-restricted export would
 *  return the whole org. The device adapter therefore post-filters what comes
 *  back. Its rows carry `hostname`, not a device id, so the restriction is
 *  resolved to hostnames through `verifyDeviceAccess` — the same gate the other
 *  adapters use. FOLLOW-UP (file an issue): give
 *  `generateDeviceInventoryReport` a real `filters.deviceIds` branch and a
 *  `deviceId` column, then delete this post-filter. */
async function restrictionHostnames(req: DatasetRequest): Promise<Set<string> | null> {
  // `deviceIds` when the caller named devices; otherwise the run's frozen set
  // (spec §8 data minimisation). Null = no restriction, i.e. a direct call with
  // no run frame and no device argument.
  const ids = req.deviceIds ?? req.runTargets;
  if (!ids || ids.length === 0) return null;
  const hostnames = new Set<string>();
  await runWithConcurrency(ids, EXPORT_DEVICE_CONCURRENCY, async (deviceId) => {
    const access = await verifyDeviceAccess(deviceId, req.auth);
    if ('error' in access) return;
    if (access.device.hostname) hostnames.add(access.device.hostname);
  });
  return hostnames;
}

const deviceInventoryAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  async createPager(req) {
    const authority = await aiLiveReportAuthority(req.auth, req.orgId, 'read');
    if (!authority) return emptyPager;
    const allowedHostnames = await restrictionHostnames(req);
    return singlePagePager(async () => {
      const result = await generateDeviceInventoryReport(req.orgId, {
        filters: {
          ...(req.siteId ? { siteIds: [req.siteId] } : {}),
          ...(Array.isArray(req.filters.osTypes) ? { osTypes: req.filters.osTypes } : {}),
        },
      }, authority);
      const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
      if (!allowedHostnames) return rows;
      return rows.filter((row) => typeof row.hostname === 'string' && allowedHostnames.has(row.hostname));
    });
  },
};

const softwareInventoryAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  async createPager(req) {
    const authority = await aiLiveReportAuthority(req.auth, req.orgId, 'read');
    if (!authority) return emptyPager;
    // This generator DOES honour filters.deviceIds, so the restriction goes
    // into the query rather than a post-filter.
    const restrictTo = req.deviceIds ?? req.runTargets;
    return singlePagePager(async () => {
      const result = await generateSoftwareInventoryReport(req.orgId, {
        filters: {
          ...(restrictTo && restrictTo.length > 0 ? { deviceIds: restrictTo } : {}),
          ...(req.siteId ? { siteIds: [req.siteId] } : {}),
        },
      }, authority);
      return (result.rows ?? []) as Array<Record<string, unknown>>;
    });
  },
};
```
- [ ] **Caveat to record in the PR body, not to fix here:** `device_inventory` and `software_inventory` each run ONE unbounded `db.select()` inside their generator and return the whole result array. The writer's row and byte caps are applied AFTER that array exists, so on a very large org (hundreds of thousands of devices or millions of installed-software rows) the API process can exhaust memory before a single cap is consulted — the caps bound the ARTIFACT, not the query. Accepted for v1 because both generators are the shipped report path and already carry this shape; **file a follow-up issue** ("give the inventory report generators a keyset cursor so export_dataset can page them") and link it from the PR. Do not paper over it with a `LIMIT` here: a silently-capped inventory export is exactly the "complete-looking prefix" the byte cap exists to prevent.
- [ ] Add the `metrics` adapter — per device, paced, reusing `analyze_metrics`'s raw-sample read shape:
```ts
/** `analyze_metrics` is single-device by construction (`deviceArgs:
 *  ['deviceId']`). The export fans out across the requested devices and PACES
 *  the fan-out at EXPORT_DEVICE_CONCURRENCY so one analysis cannot saturate
 *  the API (spec §5.4). One page per device. */
const metricsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: true,
  async createPager(req) {
    const hoursBack = Math.min(Math.max(1, Number(req.filters.hoursBack) || 24), 168);
    const since = new Date(Date.now() - hoursBack * 3_600_000);
    const deviceIds = req.deviceIds ?? [];
    let index = 0;

    return async () => {
      if (index >= deviceIds.length) return { rows: [], nextCursor: null };
      const batch = deviceIds.slice(index, index + EXPORT_DEVICE_CONCURRENCY);
      index += batch.length;

      const collected: Array<Record<string, unknown>> = [];
      await runWithConcurrency(batch, EXPORT_DEVICE_CONCURRENCY, async (deviceId) => {
        // The same per-device gate `analyze_metrics` performs. The central
        // `enforceDeviceArgs` gate already ran over `deviceIds`; this is the
        // builder's own check and is kept so the two paths stay identical.
        const access = await verifyDeviceAccess(deviceId, req.auth);
        if ('error' in access) return;
        const samples = await db
          .select()
          .from(deviceMetrics)
          .where(and(eq(deviceMetrics.deviceId, deviceId), gt(deviceMetrics.timestamp, since)))
          .orderBy(desc(deviceMetrics.timestamp))
          .limit(req.pageSize);
        for (const sample of samples) {
          collected.push({
            deviceId,
            hostname: access.device.hostname,
            timestamp: sample.timestamp instanceof Date ? sample.timestamp.toISOString() : String(sample.timestamp),
            cpuPercent: sample.cpuPercent,
            ramPercent: sample.ramPercent,
            ramUsedMb: sample.ramUsedMb,
            diskPercent: sample.diskPercent,
            diskUsedGb: sample.diskUsedGb,
          });
        }
      });

      return { rows: collected, nextCursor: index < deviceIds.length ? String(index) : null };
    };
  },
};
```
- [ ] Add the `vulnerabilities` and `custom_fields` adapters:
```ts
const vulnerabilitiesAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: true,
  async createPager(req) {
    const status = normStatus(req.filters.status);
    const deviceIds = req.deviceIds ?? [];
    let index = 0;

    return async () => {
      if (index >= deviceIds.length) return { rows: [], nextCursor: null };
      const batch = deviceIds.slice(index, index + EXPORT_DEVICE_CONCURRENCY);
      index += batch.length;

      const collected: Array<Record<string, unknown>> = [];
      await runWithConcurrency(batch, EXPORT_DEVICE_CONCURRENCY, async (deviceId) => {
        // Same per-device gate the metrics and custom_fields adapters make. It
        // is arguably redundant — `enforceDeviceArgs` already ran over every id
        // and `readDeviceFindings` is org-scoped — but "arguably redundant" is
        // not a reason for one of three device-scoped adapters to be the odd
        // one out; symmetry is what makes a missing gate visible in review.
        const access = await verifyDeviceAccess(deviceId, req.auth);
        if ('error' in access) return;
        const findings = await readDeviceFindings(req.orgId, { status, deviceId });
        const catalog = await readCatalog([...new Set(findings.map((f) => f.vulnerabilityId))]);
        const byId = new Map(catalog.map((c) => [c.id, c]));
        for (const finding of findings) {
          const cve = byId.get(finding.vulnerabilityId);
          if (!cve) continue;
          collected.push({
            id: finding.id,
            deviceId,
            cveId: cve.cveId,
            severity: cve.severity,
            cvssScore: cve.cvssScore,
            epssScore: cve.epssScore,
            riskScore: finding.riskScore,
            status: finding.status,
            knownExploited: cve.knownExploited ?? false,
            patchAvailable: cve.patchAvailable ?? false,
          });
        }
      });

      return { rows: collected, nextCursor: index < deviceIds.length ? String(index) : null };
    };
  },
};

/** `query_custom_fields` has two actions; the export produces the JOINED view
 *  (one row per device x definition) because that is the shape an analysis
 *  script wants, and the tool's own two shapes are not joinable downstream. */
const customFieldsAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: true,
  async createPager(req) {
    // Task 4's shared reader, NOT a fresh `eq(orgId, req.orgId)` select: custom
    // field definitions are org XOR partner: a partner-wide definition has
    // `org_id IS NULL` and an org filter drops every one of them — which for an
    // MSP that defines its fields once is most of the fields on the device.
    const definitions = await readCustomFieldDefinitions(req.auth);

    const deviceIds = req.deviceIds ?? [];
    let index = 0;

    return async () => {
      if (index >= deviceIds.length) return { rows: [], nextCursor: null };
      const batch = deviceIds.slice(index, index + EXPORT_DEVICE_CONCURRENCY);
      index += batch.length;

      const collected: Array<Record<string, unknown>> = [];
      await runWithConcurrency(batch, EXPORT_DEVICE_CONCURRENCY, async (deviceId) => {
        const access = await verifyDeviceAccess(deviceId, req.auth);
        if ('error' in access) return;
        const values = (access.device.customFields ?? {}) as Record<string, unknown>;
        for (const definition of definitions) {
          collected.push({
            deviceId,
            hostname: access.device.hostname,
            fieldKey: definition.fieldKey,
            fieldName: definition.name,
            fieldType: definition.type,
            value: values[definition.fieldKey] ?? null,
          });
        }
      });

      return { rows: collected, nextCursor: index < deviceIds.length ? String(index) : null };
    };
  },
};

export const DATASET_ADAPTERS: Readonly<Record<ExportDataset, DatasetAdapter>> = {
  event_logs: eventLogsAdapter,
  agent_logs: agentLogsAdapter,
  device_inventory: deviceInventoryAdapter,
  software_inventory: softwareInventoryAdapter,
  metrics: metricsAdapter,
  vulnerabilities: vulnerabilitiesAdapter,
  custom_fields: customFieldsAdapter,
};
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsExportDatasets.test.ts` — expect all nine tests PASS.
- [ ] Verify no adapter introduced SQL for a dataset that already had a builder: `cd apps/api && grep -n '\.select(' src/services/aiToolsExportDatasets.ts`. Expect **exactly two** hits, and check each line number against this list:
  1. the `agent_logs` keyset page — `db.select().from(agentLogs)` inside `agentLogsAdapter`;
  2. the `metrics` raw-sample read — `db.select().from(deviceMetrics)` inside `metricsAdapter`.

  Any other hit is a defect. In particular there must be NO `.select(` for `event_logs` (uses `searchFleetLogs`), `device_inventory` / `software_inventory` (report generators), `vulnerabilities` (`readDeviceFindings` + `readCatalog`) or `custom_fields` (`readCustomFieldDefinitions` — a local select there would drop partner-wide definitions). Confirm the same by eye: `grep -n 'from(' src/services/aiToolsExportDatasets.ts` should name only `agentLogs` and `deviceMetrics`.
- [ ] Commit: `git add apps/api/src/services/aiToolsExportDatasets.ts apps/api/src/services/aiToolsExportDatasets.test.ts && git commit -m "feat(ai): dataset adapters over the existing query builders for export_dataset"`

---

### Task 7: The `export_dataset` tool

**Files:**
- Create `apps/api/src/services/aiToolsExport.ts`
- Create `apps/api/src/services/aiToolsExport.test.ts`

**Interfaces:**

Consumes (W01 contract, verbatim):
```ts
export interface CreateArtifactInput { orgId: string; runId: string; sessionId?: string | null; kind: AiArtifactKind; name: string; contentType: string; body: Buffer | NodeJS.ReadableStream; maxBytes: number; sourceDeviceId?: string | null; createdByTool: string; region: BlobRegion }
export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord>;
```
Consumes: `AiTool` (`services/aiTools.ts:97`) with the new optional `captureExempt?: boolean` W01 adds.

Consumes: `breezeRegion(): BlobRegion` from `apps/api/src/config/env.ts` (W01, env `BREEZE_REGION`). This is the ONLY region source; this wave writes no local region resolver — reconciliation R1. Both this and `createArtifact` arrive with W01, so this task cannot start before W01 is in the base.

Consumes: `auth.principal` (`middleware/auth.ts`), narrowed with `auth.principal?.kind === 'ai_agent'` to read `runId` — built by `buildAgentAuthContext` (`services/aiAgents/agentAuthContext.ts:78`).

Produces:
```ts
export function registerExportTools(aiTools: Map<string, AiTool>): void;
export { EXPORT_DEFAULT_MAX_ROWS, EXPORT_HARD_MAX_ROWS, EXPORT_WALL_MS, EXPORT_DEFAULT_MAX_BYTES } from './aiToolsExportWriter';
```

Steps:

- [ ] Write the failing test `apps/api/src/services/aiToolsExport.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiTool } from './aiTools';

const createArtifact = vi.fn();
vi.mock('./artifacts/artifactService', () => ({ createArtifact: (i: unknown) => createArtifact(i) }));
// W01's region accessor — the only region source (reconciliation R1).
vi.mock('../config/env', () => ({ breezeRegion: () => 'eu' as const }));
vi.mock('./aiAgents/runProgress', () => ({ emitRunProgress: vi.fn(async () => undefined) }));

const createPager = vi.fn();
vi.mock('./aiToolsExportDatasets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiToolsExportDatasets')>();
  return {
    ...actual,
    DATASET_ADAPTERS: new Proxy({}, {
      get: () => ({ tier: 1, deviceScoped: false, createPager: (r: unknown) => createPager(r) }),
      has: () => true,
      ownKeys: () => [...actual.EXPORT_DATASETS],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }),
  };
});

const { registerExportTools } = await import('./aiToolsExport');

/** A run's auth context: the run id rides on the principal (agentAuthContext.ts:78). */
const auth = {
  orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: null,
  principal: { kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' },
  user: { id: 'agent-1' },
} as never;
/** A direct chat/MCP caller: a human principal, so no run to own the artifact. */
const chatAuth = {
  orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: null,
  principal: { kind: 'user', userId: 'u1' },
  user: { id: 'u1' },
} as never;

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerExportTools(map);
  const tool = map.get('export_dataset');
  if (!tool) throw new Error('export_dataset not registered');
  return tool;
}

function pagesOf(pages: Array<{ rows: Array<Record<string, unknown>>; nextCursor: string | null }>) {
  let i = 0;
  return async () => pages[i++] ?? { rows: [], nextCursor: null };
}

describe('export_dataset', () => {
  beforeEach(() => {
    createArtifact.mockReset();
    createPager.mockReset();
    createArtifact.mockImplementation(async (input: { body: NodeJS.ReadableStream }) => {
      const chunks: Buffer[] = [];
      for await (const c of input.body) chunks.push(Buffer.from(c as Buffer));
      const bytes = Buffer.concat(chunks);
      return { id: 'art-1', bytes: bytes.length, sha256: 'sha', headPreview: '', tailPreview: '' };
    });
  });

  it('is Tier 1, capture-exempt and device-gated on deviceIds', () => {
    const tool = getTool();
    expect(tool.tier).toBe(1);
    expect(tool.captureExempt).toBe(true);
    expect(tool.deviceArgs).toEqual(['deviceIds']);
    expect(tool.definition.name).toBe('export_dataset');
  });

  it('pages a three-page source to completion and returns one artifact handle', async () => {
    createPager.mockResolvedValue(pagesOf([
      { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' },
      { rows: [{ id: 3 }], nextCursor: 'c2' },
      { rows: [{ id: 4 }], nextCursor: null },
    ]));
    const tool = getTool();
    const raw = await tool.handler({ dataset: 'event_logs', format: 'jsonl' }, auth, { runTargets: [], stagedBytesRemaining: 1_000_000 });
    const parsed = JSON.parse(raw);
    expect(parsed.artifact.handle).toBe('art-1');
    expect(parsed.artifact.rows).toBe(4);
    expect(parsed.truncated).toBe(false);
    expect(createArtifact).toHaveBeenCalledTimes(1);
    expect(createArtifact.mock.calls[0]![0]).toMatchObject({
      orgId: 'org-1', runId: 'run-1', kind: 'input_capture',
      createdByTool: 'export_dataset', contentType: 'application/x-ndjson', region: 'eu',
    });
  });

  it('stops at the row cap and reports truncated: true', async () => {
    createPager.mockResolvedValue(pagesOf([
      { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' },
      { rows: [{ id: 3 }, { id: 4 }], nextCursor: 'c2' },
    ]));
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs', format: 'jsonl', maxRows: 3 }, auth,
      { runTargets: [], stagedBytesRemaining: 1_000_000 },
    ));
    expect(parsed.artifact.rows).toBe(3);
    expect(parsed.truncated).toBe(true);
  });

  it('returns a typed artifact_bytes_exceeded error when the byte cap is crossed', async () => {
    createPager.mockResolvedValue(pagesOf([
      { rows: [{ blob: 'x'.repeat(4096) }], nextCursor: 'more' },
      { rows: [{ blob: 'x'.repeat(4096) }], nextCursor: 'more' },
    ]));
    createArtifact.mockImplementation(async (input: { body: NodeJS.ReadableStream }) => {
      for await (const _ of input.body) { /* drain until the writer throws */ }
      return { id: 'never', bytes: 0 };
    });
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs', format: 'jsonl' }, auth,
      { runTargets: [], stagedBytesRemaining: 4096 },
    ));
    expect(parsed.error).toBe('artifact_bytes_exceeded');
  });

  it('refuses deviceIds outside the run targets', async () => {
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs', deviceIds: ['d1', 'd-outside'] }, auth,
      { runTargets: ['d1'], stagedBytesRemaining: 1_000_000 },
    ));
    expect(parsed.error).toBe('device_outside_run_targets');
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it('allows any caller-reachable deviceIds when the run froze no target set', async () => {
    createPager.mockResolvedValue(pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]));
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs', deviceIds: ['d-any'] }, auth,
      { runTargets: [], stagedBytesRemaining: 1_000_000 },
    ));
    expect(parsed.error).toBeUndefined();
  });

  it('takes the run id from the ai_agent principal, not from the context', async () => {
    createPager.mockResolvedValue(pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]));
    const tool = getTool();
    await tool.handler({ dataset: 'event_logs' }, auth, { runTargets: [], stagedBytesRemaining: 1_000_000 });
    expect(createArtifact.mock.calls[0]![0]).toMatchObject({ runId: 'run-1', orgId: 'org-1' });
  });

  it('refuses a direct chat/MCP call with export_requires_run — an artifact needs an owning run', async () => {
    createPager.mockResolvedValue(pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]));
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler({ dataset: 'event_logs' }, chatAuth));
    expect(parsed.error).toBe('export_requires_run');
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it('escapes quotes and newlines in CSV output', async () => {
    createPager.mockResolvedValue(pagesOf([
      { rows: [{ name: 'say "hi"', note: 'a\nb' }], nextCursor: null },
    ]));
    let captured = '';
    createArtifact.mockImplementation(async (input: { body: NodeJS.ReadableStream }) => {
      const chunks: Buffer[] = [];
      for await (const c of input.body) chunks.push(Buffer.from(c as Buffer));
      captured = Buffer.concat(chunks).toString('utf8');
      return { id: 'art-csv', bytes: captured.length };
    });
    const tool = getTool();
    await tool.handler({ dataset: 'event_logs', format: 'csv' }, auth, { runTargets: [], stagedBytesRemaining: 1e6 });
    expect(captured.split('\n')[0]).toBe('"name","note"');
    expect(captured).toContain('"say ""hi"""');
    expect(captured).toContain('a\nb"');
  });

  it('rejects an unknown dataset', async () => {
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler({ dataset: 'passwords' }, auth));
    expect(parsed.error).toBe('unknown_dataset');
  });
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsExport.test.ts` — expect failure: module not found.
- [ ] Create `apps/api/src/services/aiToolsExport.ts`:
```ts
/**
 * `export_dataset` (spec §5.7) — the bridge between "we have this data" and
 * "the sandbox can compute on it".
 *
 * Every other read tool hands the model a view compacted to 8 000 characters.
 * This one hands it a HANDLE to the complete result, in a shape a script can
 * read. It is what makes an unattended `analysis` run possible at all.
 *
 * captureExempt: the result already IS a handle. Running W01's capture wrapper
 * over it would store a copy of a pointer.
 */
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import type { ToolExecutionContext } from './toolExecutionContext';
import { sanitizeThrownToolError } from './aiToolErrors';
import { createArtifact } from './artifacts/artifactService';
// W01's region accessor (env BREEZE_REGION). The only region source; this
// wave writes no local region resolver of its own — reconciliation R1.
import { breezeRegion } from '../config/env';
import { emitRunProgress } from './aiAgents/runProgress';
import { DATASET_ADAPTERS, EXPORT_DATASETS, type ExportDataset } from './aiToolsExportDatasets';
import {
  buildExportStream, ExportCapError,
  EXPORT_DEFAULT_MAX_ROWS, EXPORT_HARD_MAX_ROWS, EXPORT_WALL_MS, EXPORT_DEFAULT_MAX_BYTES,
  type ExportFormat,
} from './aiToolsExportWriter';

export {
  EXPORT_DEFAULT_MAX_ROWS, EXPORT_HARD_MAX_ROWS, EXPORT_WALL_MS, EXPORT_DEFAULT_MAX_BYTES,
} from './aiToolsExportWriter';

/** Page size handed to each adapter. 500 is `search_logs`'s own page cap. */
const EXPORT_PAGE_SIZE = 500;

const CONTENT_TYPES: Record<ExportFormat, string> = {
  jsonl: 'application/x-ndjson',
  csv: 'text/csv',
};

function isExportDataset(value: unknown): value is ExportDataset {
  return typeof value === 'string' && (EXPORT_DATASETS as readonly string[]).includes(value);
}

export function registerExportTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('export_dataset', {
    tier: 1,
    captureExempt: true,
    // The central gate runs org+site verifyDeviceAccess on every id here
    // BEFORE this handler is entered. The run-target check below is a second,
    // different question — see ToolExecutionContext.runTargets.
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'export_dataset',
      description:
        'Export a full dataset to a file artifact for analysis. Unlike the ordinary read tools, this pages the query to completion with no 8000-character compaction and returns a handle you can stage into a workspace with workspace_stage. Datasets: event_logs, agent_logs, device_inventory, software_inventory, metrics, vulnerabilities, custom_fields.',
      input_schema: {
        type: 'object' as const,
        properties: {
          dataset: { type: 'string', enum: [...EXPORT_DATASETS], description: 'Which dataset to export' },
          format: { type: 'string', enum: ['jsonl', 'csv'], description: 'Output format (default jsonl)' },
          filters: { type: 'object', description: 'Dataset-specific filters, same shape as the corresponding read tool' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Restrict to these device UUIDs' },
          siteId: { type: 'string', description: 'Restrict to one site UUID' },
          maxRows: { type: 'number', description: `Row cap (default ${EXPORT_DEFAULT_MAX_ROWS}, max ${EXPORT_HARD_MAX_ROWS})` },
        },
        required: ['dataset'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext, context?: ToolExecutionContext) => {
      try {
        if (!isExportDataset(input.dataset)) {
          return JSON.stringify({ error: 'unknown_dataset', dataset: input.dataset });
        }
        const dataset = input.dataset;
        const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
        if (!orgId) return JSON.stringify({ error: 'No organization context available' });

        // Run IDENTITY comes from the PRINCIPAL, not from ToolExecutionContext
        // (reconciliation R4): `buildAgentAuthContext` puts the run id on
        // `principal` (agentAuthContext.ts:78) and the run org on `auth.orgId`
        // (:89), so there is nothing to copy and nothing to drift.
        const runId = auth.principal?.kind === 'ai_agent' ? auth.principal.runId : null;

        // Every artifact is OWNED by a run: that ownership is what scopes it,
        // expires it and bills it. A direct chat/MCP call has no run to own one,
        // so it is refused with a typed error instead of being handed an orphan.
        if (!runId) {
          return JSON.stringify({
            error: 'export_requires_run',
            message: 'export_dataset writes a run-owned artifact and can only be called inside an agent run.',
          });
        }

        const deviceIds = Array.isArray(input.deviceIds) ? input.deviceIds as string[] : null;

        // Spec §8 data minimisation. A run's target set is frozen at admission;
        // an export that spans a device outside it is refused even though the
        // agent principal could reach that device org-wide. An ABSENT/EMPTY
        // target list means "no run frame" (direct chat/MCP), not "no devices".
        const runTargets = context?.runTargets;
        if (deviceIds && runTargets && runTargets.length > 0) {
          const allowed = new Set(runTargets);
          const outside = deviceIds.filter((id) => !allowed.has(id));
          if (outside.length > 0) {
            return JSON.stringify({
              error: 'device_outside_run_targets',
              message: 'Those devices are not in this run\'s admitted target set.',
              count: outside.length,
            });
          }
        }

        const format: ExportFormat = input.format === 'csv' ? 'csv' : 'jsonl';
        const maxRows = Math.min(
          Math.max(1, Number(input.maxRows) || EXPORT_DEFAULT_MAX_ROWS),
          EXPORT_HARD_MAX_ROWS,
        );
        const maxBytes = context?.stagedBytesRemaining && context.stagedBytesRemaining > 0
          ? context.stagedBytesRemaining
          : EXPORT_DEFAULT_MAX_BYTES;

        const adapter = DATASET_ADAPTERS[dataset];
        const pager = await adapter.createPager({
          auth,
          orgId,
          filters: (input.filters as Record<string, unknown>) ?? {},
          deviceIds,
          // Read by the inventory adapters only (their generator has no
          // deviceIds filter). Empty ⇒ no frozen set, i.e. no restriction.
          runTargets: runTargets && runTargets.length > 0 ? [...runTargets] : null,
          siteId: typeof input.siteId === 'string' ? input.siteId : null,
          pageSize: EXPORT_PAGE_SIZE,
        });

        const stream = buildExportStream(pager, { format, maxRows, maxBytes, wallMs: EXPORT_WALL_MS });

        const record = await createArtifact({
          orgId,
          runId,
          kind: 'input_capture',
          name: `${dataset}.${format === 'csv' ? 'csv' : 'jsonl'}`,
          contentType: CONTENT_TYPES[format],
          body: stream.body,
          maxBytes,
          createdByTool: 'export_dataset',
          region: breezeRegion(),
        });

        const stats = await stream.stats;

        await emitRunProgress(
          { orgId, runId },
          'export',
          `Exported ${stats.rows} ${dataset} rows${stats.truncated ? ' (truncated)' : ''}`,
        );

        return JSON.stringify({
          dataset,
          format,
          truncated: stats.truncated,
          artifact: {
            handle: record.id,
            bytes: stats.bytes,
            rows: stats.rows,
            head: stats.head,
            tail: stats.tail,
          },
        });
      } catch (error) {
        if (error instanceof ExportCapError) {
          return JSON.stringify({
            error: error.code,
            message: 'The export exceeded this run\'s artifact byte budget. Narrow the filters or the device set and try again.',
          });
        }
        const message = sanitizeThrownToolError('export-dataset', error);
        console.error('[ai:export_dataset]', message, error);
        return JSON.stringify({ error: 'export_failed', message });
      }
    },
  });
}
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsExport.test.ts` — expect all ten tests PASS.
- [ ] **Swap Task 1's placeholder for the real constant now that this module exists.** In `apps/api/src/services/aiAgents/runLoop.ts` replace
```ts
    // Literal on purpose until Task 7 exists. Task 7 replaces this line with
    // the real `EXPORT_DEFAULT_MAX_BYTES` import — do not import it now.
    stagedBytesRemaining: 256 * 1024 * 1024, // EXPORT_DEFAULT_MAX_BYTES — replaced by the real import in Task 7
```
with
```ts
    stagedBytesRemaining: EXPORT_DEFAULT_MAX_BYTES,
```
and add `import { EXPORT_DEFAULT_MAX_BYTES } from '../aiToolsExport';` to the imports at the top of `runLoop.ts`.
- [ ] Prove the placeholder is gone: `cd apps/api && grep -n '256 \* 1024 \* 1024' src/services/aiAgents/runLoop.ts` — expect **no output** (exit 1) — and `grep -n 'EXPORT_DEFAULT_MAX_BYTES' src/services/aiAgents/runLoop.ts` — expect two hits (the import and the call-site value).
- [ ] Run `cd apps/api && npx vitest run src/services/aiAgents/runLoop.runContext.test.ts src/services/aiAgents/runLoop.test.ts src/services/aiToolsExport.test.ts` — expect PASS on all three (this is the step that would catch a circular import between `runLoop` and `aiToolsExport`; if one appears, move `EXPORT_DEFAULT_MAX_BYTES`'s import to `./aiToolsExportWriter`, which has no tool-layer dependencies).
- [ ] Commit: `git add apps/api/src/services/aiToolsExport.ts apps/api/src/services/aiToolsExport.test.ts apps/api/src/services/aiAgents/runLoop.ts && git commit -m "feat(ai): export_dataset tool streams full datasets into an artifact"`

---

### Task 8: Register `export_dataset` in all six places

**Files:**
- Modify `apps/api/src/services/aiTools.ts` (import block ~31–83; register calls ~262–300)
- Modify `apps/api/src/services/aiAgentSdkTools.ts` (`TOOL_TIERS` ~159; `createBreezeMcpServer` `tool()` declarations ~1222+)
- Modify `apps/api/src/services/aiAgents/agentToolCatalog.ts` (`AgentCapabilityId` ~28; `AGENT_CAPABILITIES` ~33; `TOOL_CAPABILITY` ~62)
- Modify `apps/api/src/services/aiToolSchemas.ts` (`toolInputSchemas`, near `search_logs` ~1168)
- Modify `apps/api/src/services/aiGuardrails.ts` (`TOOL_PERMISSIONS` ~862; the rate-limit table ~1218)
- Create `apps/api/src/services/aiToolsExport.registration.test.ts`

**Interfaces:**

Produces: `AgentCapabilityId` gains `'workspace'`; `AGENT_CAPABILITIES` gains `{ id: 'workspace', tone: 'standard' }`.

Steps:

- [ ] Write the failing test `apps/api/src/services/aiToolsExport.registration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { aiTools } from './aiTools';
import { TOOL_TIERS, BREEZE_MCP_TOOL_NAMES } from './aiAgentSdkTools';
import { AGENT_CAPABILITIES, TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS } from './aiGuardrails';

describe('export_dataset registration', () => {
  it('1. is in the aiTools registry', () => {
    expect(aiTools.has('export_dataset')).toBe(true);
  });

  it('2. is in TOOL_TIERS at tier 1', () => {
    expect(TOOL_TIERS.export_dataset).toBe(1);
  });

  it('3. is mapped to the workspace capability, which exists', () => {
    expect(TOOL_CAPABILITY.export_dataset).toBe('workspace');
    expect(AGENT_CAPABILITIES.map((c) => c.id)).toContain('workspace');
    expect(AGENT_CAPABILITIES.find((c) => c.id === 'workspace')?.tone).toBe('standard');
  });

  it('4a. is advertised under the SDK-prefixed MCP name', () => {
    // BREEZE_MCP_TOOL_NAMES is `Object.keys(TOOL_TIERS).map(n => 'mcp__breeze__' + n)`
    // (aiAgentSdkTools.ts:335), so the bare name never appears — and this
    // assertion alone only re-tests TOOL_TIERS, which is why 4b exists.
    expect(BREEZE_MCP_TOOL_NAMES).toContain('mcp__breeze__export_dataset');
  });

  it('4b. has a real tool() declaration inside createBreezeMcpServer', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8'));
    const server = source.slice(source.indexOf('export function createBreezeMcpServer'));
    expect(server).toContain("'export_dataset'");
    expect(server).toContain("makeHandler('export_dataset'");
  });

  it('5. has a Zod input schema', () => {
    expect('export_dataset' in toolInputSchemas).toBe(true);
    const parsed = toolInputSchemas.export_dataset.safeParse({ dataset: 'event_logs', format: 'csv' });
    expect(parsed.success).toBe(true);
    expect(toolInputSchemas.export_dataset.safeParse({ dataset: 'nope' }).success).toBe(false);
  });

  it('6. has an RBAC permission entry', () => {
    expect(TOOL_PERMISSIONS.export_dataset).toEqual({ resource: 'devices', action: 'read' });
  });
});
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsExport.registration.test.ts` — expect all seven to fail (the six registration places, with Place 4 split into 4a/4b).
- [ ] Place 1: in `aiTools.ts` add `import { registerExportTools } from './aiToolsExport';` beside the other register imports, and `registerExportTools(aiTools);` beside the other register calls.
- [ ] Place 2: in `aiAgentSdkTools.ts` add to `TOOL_TIERS`, grouped with a comment:
```ts
  // Execution plane (spec §5.7) — reads nothing the caller cannot already read;
  // it just refuses to throw the result away. Tier 1 like its source tools.
  export_dataset: 1,
```
- [ ] Place 3: in `agentToolCatalog.ts` add `| 'workspace'` to `AgentCapabilityId`, append `{ id: 'workspace', tone: 'standard' },` to `AGENT_CAPABILITIES` (note in the commit message that W04 adds the `workspace_*` tools under the same capability — whichever wave lands first adds the capability, the second finds it present), and add to `TOOL_CAPABILITY`:
```ts
  // ---- workspace ----
  export_dataset: 'workspace',
```
- [ ] Place 4: in `createBreezeMcpServer` add a `tool()` declaration beside the other Tier-1 read tools:
```ts
    tool(
      'export_dataset',
      registryDescription('export_dataset'),
      {
        dataset: z.enum(['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields']),
        format: z.enum(['jsonl', 'csv']).optional(),
        filters: z.record(z.unknown()).optional(),
        deviceIds: z.array(z.string()).optional(),
        siteId: z.string().optional(),
        maxRows: z.number().optional(),
      },
      makeHandler('export_dataset', getAuth, onPreToolUse, onPostToolUse),
    ),
```
(match the exact call shape of the neighbouring declarations — read the `search_logs` declaration in the same function and mirror it).
- [ ] Place 5: in `aiToolSchemas.ts` add beside `search_logs`:
```ts
  export_dataset: z.object({
    dataset: z.enum(['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields']),
    format: z.enum(['jsonl', 'csv']).optional(),
    filters: z.record(z.unknown()).optional(),
    deviceIds: z.array(uuid).max(200).optional(),
    siteId: uuid.optional(),
    maxRows: z.number().int().min(1).max(1_000_000).optional(),
  }),
```
- [ ] Place 6: in `aiGuardrails.ts` add `export_dataset: { resource: 'devices', action: 'read' },` to `TOOL_PERMISSIONS` beside `search_logs`, and to the rate-limit table:
```ts
  // One export is a full table scan's worth of work — far below search_logs'
  // 30/5min on purpose.
  export_dataset: { limit: 5, windowSeconds: 300 },
```
- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsExport.registration.test.ts` — expect all seven PASS.
- [ ] Run the contract suites that guard these maps: `cd apps/api && npx vitest run src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiAgents/agentToolCatalog.categoryParity.test.ts src/services/aiToolsRegistryParity.test.ts src/services/aiTools.deviceArgsCoverage.contract.test.ts` — expect PASS. If `categoryParity` fails on the new capability, add `workspace` to whatever category table it names (read the failure message; it prints the missing key).
- [ ] Commit: `git add apps/api/src/services/aiTools.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiToolsExport.registration.test.ts && git commit -m "feat(ai): register export_dataset in all six registries under a new workspace capability"`

---

### Task 9: Surface progress on the run detail DTO and route

**Files:**
- Modify `packages/shared/src/types/aiAgentRuns.ts` (`AiAgentRunDetailDto` ~494–585)
- Modify `apps/api/src/routes/aiAgents.ts` (`GET /runs/:runId` ~1198–1300 and its response assembly)
- Create `apps/api/src/routes/aiAgents.runProgress.test.ts`

**Interfaces:**

Produces:
```ts
export interface AiAgentRunProgressEntryDto {
  step: string;
  label: string;
  ordinal: number;
  at: string;
}
// on AiAgentRunDetailDto:
  /** Live progress beats (spec §5.8). Always an array — `[]` for a finished
   *  run whose one-hour window has expired, and for every run from before this
   *  field existed. Additive: does NOT bump AI_AGENT_RUN_DTO_SCHEMA_VERSION. */
  progress: AiAgentRunProgressEntryDto[];
```

Consumes: `readRunProgress(runId: string): Promise<RunProgressEntry[]>` (Task 3).

Steps:

- [ ] Write the failing test `apps/api/src/routes/aiAgents.runProgress.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { AiAgentRunDetailDto, AiAgentRunProgressEntryDto } from '@breeze/shared';

describe('run detail progress DTO', () => {
  it('carries a progress array of typed entries', () => {
    const entry: AiAgentRunProgressEntryDto = { step: 'export', label: 'Exported 12 rows', ordinal: 1, at: '2026-09-13T00:00:00.000Z' };
    const detail: Pick<AiAgentRunDetailDto, 'progress'> = { progress: [entry] };
    expect(detail.progress[0]!.ordinal).toBe(1);
  });

  it('models an empty window as [] rather than null', () => {
    const detail: Pick<AiAgentRunDetailDto, 'progress'> = { progress: [] };
    expect(detail.progress).toEqual([]);
  });
});
```
- [ ] Run `cd apps/api && npx vitest run src/routes/aiAgents.runProgress.test.ts` — expect a type failure on `AiAgentRunProgressEntryDto`.
- [ ] In `packages/shared/src/types/aiAgentRuns.ts` add the `AiAgentRunProgressEntryDto` interface directly above `AiAgentRunDetailDto`, and the `progress` field (with the docstring above) after `reportRunId`. Export it from the same barrel the other run DTOs use (check `packages/shared/src/types/index.ts` re-exports `./aiAgentRuns`; if the file uses an explicit export list, add the name).
- [ ] Run `cd apps/api && npx vitest run src/routes/aiAgents.runProgress.test.ts` — expect PASS.
- [ ] In `apps/api/src/routes/aiAgents.ts` add `import { readRunProgress } from '../services/aiAgents/runProgress';`, and in the `GET /runs/:runId` handler, after the run row is loaded and before the response is assembled:
```ts
  // Live progress (spec §5.8). Read from the short-lived ring, never the DB:
  // this page polls every 5s and a per-poll table read for telemetry would be
  // a query per viewer per five seconds for a value that is worth a spinner.
  const progress = await readRunProgress(run.id);
```
and add `progress,` to the response object alongside `reportRunId`.
- [ ] Add a route-level assertion to the same test file:
```ts
it('the run detail route exposes progress from the ring', async () => {
  const mod = await import('./aiAgents');
  expect(mod).toBeTruthy();
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./aiAgents.ts', import.meta.url), 'utf8'));
  expect(source).toContain('readRunProgress(run.id)');
  expect(source).toMatch(/\n\s+progress,/);
});
```
- [ ] Run `cd apps/api && npx vitest run src/routes/aiAgents.runProgress.test.ts` — expect PASS.
- [ ] Run the existing run-detail route suite to confirm nothing regressed: `cd apps/api && npx vitest run src/routes/aiAgents` — read the reported file count and confirm it covers `aiAgents.test.ts` and siblings; expect PASS.
- [ ] Commit: `git add packages/shared/src/types/aiAgentRuns.ts apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgents.runProgress.test.ts && git commit -m "feat(ai): expose live run progress on the run detail DTO"`

---

### Task 10: Render the progress step list on the run detail page

**Files:**
- Modify `apps/web/src/components/aiAgents/RunDetailPage.tsx` (helpers ~38–60; the detail body render, beside the existing ledger/trace sections)
- Modify `apps/web/src/components/aiAgents/RunDetailPage.test.tsx`
- Modify `apps/web/src/locales/en.json` (or whichever file `aiAgentsPage.runs.detail.*` keys live in — find it with `grep -rl 'aiAgentsPage' apps/web/src/locales`)

**Interfaces:**

Consumes: `AiAgentRunDetailDto['progress']` (Task 9). The page already fetches the whole DTO via `fetchWithAuth('/ai/agents/runs/${runId}')` and re-polls every `DETAIL_POLL_INTERVAL_MS` while `isLiveRunStatus(run.status)`, so **no new fetch, no SSE, and no new polling loop is needed** — the field arrives on the existing poll.

Produces: a `RunProgressList` component, `data-testid="run-detail-progress"` with per-row `run-detail-progress-<ordinal>`.

Steps:

- [ ] Add the failing test to `apps/web/src/components/aiAgents/RunDetailPage.test.tsx` (mirror the file's existing render helper and DTO fixture — read the top of the file and reuse `renderRunDetail`/the fixture factory it already defines rather than inventing one):
```tsx
it('renders the live progress step list in ordinal order', async () => {
  renderRunDetail({
    ...runFixture,
    status: 'running',
    progress: [
      { step: 'admitted', label: 'Run admitted', ordinal: 1, at: '2026-09-13T10:00:00.000Z' },
      { step: 'export', label: 'Exported 1 200 event_logs rows', ordinal: 2, at: '2026-09-13T10:00:06.000Z' },
    ],
  });
  const list = await screen.findByTestId('run-detail-progress');
  expect(list).toBeInTheDocument();
  expect(screen.getByTestId('run-detail-progress-1')).toHaveTextContent('Run admitted');
  expect(screen.getByTestId('run-detail-progress-2')).toHaveTextContent('Exported 1 200 event_logs rows');
});

it('omits the progress section entirely when there are no beats', async () => {
  renderRunDetail({ ...runFixture, status: 'completed', progress: [] });
  await screen.findByTestId('run-detail-ledger-table-wrapper');
  expect(screen.queryByTestId('run-detail-progress')).toBeNull();
});
```
- [ ] Run `cd apps/web && npx vitest run src/components/aiAgents/RunDetailPage.test.tsx` — expect failure: `Unable to find an element by: [data-testid="run-detail-progress"]`.
- [ ] Add the component to `RunDetailPage.tsx`, beside the other small presentational helpers:
```tsx
function RunProgressList({
  progress,
  t,
}: {
  progress: AiAgentRunDetailDto['progress'];
  t: (key: string) => string;
}) {
  if (!progress || progress.length === 0) return null;
  return (
    <section className="mt-4" data-testid="run-detail-progress">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('aiAgentsPage.runs.detail.progress.title')}
      </h2>
      <ol className="mt-2 space-y-1 text-sm">
        {progress.map((entry) => (
          <li
            key={entry.ordinal}
            className="flex flex-wrap items-baseline gap-2"
            data-testid={`run-detail-progress-${entry.ordinal}`}
          >
            <span className="text-xs tabular-nums text-muted-foreground">
              {new Date(entry.at).toLocaleTimeString()}
            </span>
            <span>{entry.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
```
- [ ] Render it above the ledger section in the detail body: `<RunProgressList progress={run.progress} t={t} />`. Add this comment beside it:
```tsx
      {/* Fed by the SAME 5s poll as everything else on this page
          (DETAIL_POLL_INTERVAL_MS) — `progress` rides on the run detail DTO.
          Deliberately not an SSE subscription: the page has no stream, and
          adding one for telemetry would be a second liveness mechanism to keep
          in sync with the first. */}
```
- [ ] Add the locale key `aiAgentsPage.runs.detail.progress.title` = `"Progress"` to the locale file found above.
- [ ] Run `cd apps/web && npx vitest run src/components/aiAgents/RunDetailPage.test.tsx` — expect PASS on the whole file.
- [ ] Commit: `git add apps/web/src/components/aiAgents/RunDetailPage.tsx apps/web/src/components/aiAgents/RunDetailPage.test.tsx apps/web/src/locales && git commit -m "feat(web): show the live progress step list on the AI run detail page"`

---

### Task 11: Full verification

**Files:** none modified.

Steps:

- [ ] Typecheck the whole API package: `cd apps/api && npx tsc --noEmit -p tsconfig.json` — expect no errors. (There is no root `typecheck` script; turbo/CI runs this.)
- [ ] Typecheck shared and web: `cd packages/shared && npx tsc --noEmit -p tsconfig.json` and `cd apps/web && npx tsc --noEmit -p tsconfig.json` — expect no errors.
- [ ] Run the FULL API unit suite, not just touched files — the registry/catalog contracts live in files this wave never opened and a per-file sweep will miss them: `cd apps/api && npx vitest run` — expect PASS. If a `TOOL_TIERS`/catalog/registry contract reds, the fix is a missing entry from Task 8, not a test edit.
- [ ] Run the full web suite: `cd apps/web && npx vitest run` — expect PASS.
- [ ] Run the full shared suite: `cd packages/shared && npx vitest run` — expect PASS.
- [ ] Confirm no migration was added by this wave: `git diff --name-only main...HEAD -- apps/api/migrations` — expect empty output.
- [ ] Confirm no tenancy registry was touched (this wave adds no table): `git diff --name-only main...HEAD -- apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts` — expect empty output.
- [ ] Commit nothing; if any step failed, fix forward in a new commit on this branch.
