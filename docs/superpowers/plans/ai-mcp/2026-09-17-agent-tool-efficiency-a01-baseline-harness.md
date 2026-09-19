---
tracking_issue: LanternOps/breeze#6147
wave_issue: LanternOps/breeze#6148
branch: feature/6147-agent-tool-efficiency/wave-6148
---
# Agent tool efficiency A-W01: baseline and harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before any tool-loading change lands, Breeze can measure — per in-product surface — how many tool schemas reach the model, the input/cache token split, time-to-first-token, and whether Agent SDK tool search is active; a golden tool-selection eval scores first-call accuracy on ~60 real MSP prompts and runs non-blocking in CI; and a hot/cold report over `ai_tool_executions` says which of the ~206 tools are used. The numbers land in a baseline doc next to the spec, which A-W04 reads to pick the `alwaysLoad` set and the per-surface load policy.

**Architecture:** Three independent pieces, all read-only against product behaviour. (1) A **capture harness** that runs the Agent SDK `query()` in-process with each surface's exact `allowedTools` / `onlyTools` / server factory (derived from the same exported constants the surfaces use, never re-typed), in *deny mode* (`canUseTool` refuses every call, so no tool executes and no seeded actor is needed), and folds the SDK message stream into a `StreamObservation` (usage split per API call, TTFT, tool_use names, `ToolSearch` sightings). An optional local **capture proxy** set as `ANTHROPIC_BASE_URL` records the exact `tools[]` array, `defer_loading` flags and `system` bytes per request — the one thing the stream cannot show. (2) A **golden eval** with 60 cases, a pure scorer, a runner that writes JSON + markdown, and a `workflow_dispatch`/weekly workflow that never gates a PR. (3) A **hot/cold report**: one SQL statement exported both as a platform-admin endpoint (`GET /api/v1/admin/ai/tool-usage`) and as a file Todd runs on both regions, plus the `created_at` index it needs.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.181 (CLI 2.1.181), Node `http`, Vitest, Hono, Drizzle (`db.execute(sql)`), GitHub Actions.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md` — "Feature A → A-W01", Principle 1, "Success measures", open decisions 2 and 3. Plan index: `docs/superpowers/plans/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization.md` (decisions D5, D6).

**Tracking:** `get_feature_status LanternOps/breeze#6147`; `start_wave` on #6148; PR body `Closes #6148`. Independent of A-W02.

**Verified against `origin/main` `5f20013cb`** (2026-09-17).

---

## Global Constraints

- **Commands.** API unit: `cd apps/api && npx vitest run <path>`. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`. Lint `pnpm lint`. Scripts: `pnpm --filter @breeze/api exec tsx <path>` (env on the command line — API scripts do not load dotenv; `apps/api/scripts/m365-sync-benchmark.ts:31-33` is the usage-block precedent). **Before the PR: `cd apps/api && npx vitest run`.**
- **Never** `pnpm --filter <pkg> test -- --run <path>`. `vitest run <path>` is a substring match.
- **Measurement changes nothing.** No product code path changes behaviour in this wave except: one new read-only admin route, one index. `SDK_CHILD_ENV_ALLOWLIST` (`streamingSessionManager.ts:132-159`) is **not** extended — the harness builds its own child env; A-W04 owns the product-side `ENABLE_TOOL_SEARCH` policy.
- **Facts the harness must encode, verified from the installed CLI binary** (`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.181/…/claude`): `ENABLE_TOOL_SEARCH` unset ⇒ tool search **on** for first-party hosts and supported models, **silently off** when `ANTHROPIC_BASE_URL` is not a first-party Anthropic host or is Vertex (log line `[ToolSearch:optimistic] disabled: ANTHROPIC_BASE_URL=… is not a first-party Anthropic host`); `true` ⇒ on; `false` ⇒ off; `auto[:N]` ⇒ threshold mode. Unsupported models: `claude-3-5-haiku`, `claude-3-haiku` (GrowthBook-overridable). The `tool()` extras `searchHint`/`alwaysLoad` land in `_meta['anthropic/searchHint']` / `_meta['anthropic/alwaysLoad']`. **A capture proxy is itself a non-first-party host** — measuring "default" behaviour through the proxy is invalid; the harness forces `ENABLE_TOOL_SEARCH` explicitly whenever `--proxy` is used and records that it did.
- **Nothing in the SDK's TypeScript API says whether tool search is active.** Detection = a `tool_use` block named `ToolSearch`, `tool_search_tool_result`/`server_tool_use` content blocks, `tool_reference` blocks, and stderr lines matching `/ToolSearch/`. Breeze discards those stderr lines today (`streamingSessionManager.ts:1149-1153`), the harness keeps them.
- **The three input-token components are never persisted separately** (`aiCostTracker.ts:594-599`, `db/schema/ai.ts:44-49`); the harness captures the split from `assistant`-message `usage` itself.
- **`ai_tool_executions` has no org/partner column, no `created_at` index, and both web chat and Helper write `ai_sessions.type = 'general'`** (`aiAgent.ts:186-195`, `routes/helper/index.ts:225-234`). The report joins `ai_sessions`, derives `surface` with `CASE WHEN type='general' AND device_id IS NOT NULL THEN 'helper' …`, and runs under `runOutsideDbContext(() => withSystemDbAccessContext(...))` because the table is FORCE RLS via its parent (`migrations/2026-05-30-fk-child-tables-rls.sql:99-118`).
- **Migration:** one file, `apps/api/migrations/2026-10-20-110000-ai-tool-executions-created-at-idx.sql`, `-- @no-transaction`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, DDL only (no `breeze.scope` election needed). `main`'s newest today is `2026-10-20-100000-partner-sending-domains.sql`; re-check `ls apps/api/migrations/*.sql | sort | tail -1` before every commit and rename upward if `main` moved. Never edit a shipped migration.
- **CI workflow rules** (`pnpm test:workflow-security`, `.github/scripts/check-workflow-security.mjs`): every external `uses:` SHA-pinned (`owner/repo@<40-hex>`), `persist-credentials: false` on checkout, least-privilege `permissions:`, and **a `pull_request`-triggered workflow may not use secrets** (`pr-workflow-must-be-secret-free`). The eval needs an API key, so it runs on `workflow_dispatch` + `schedule` only — never on `pull_request`.
- **Loading `services/aiTools` outside vitest** pulls `../db` (postgres.js pool — created, not connected, at `db/index.ts:42`) and ~48 domain modules; a script that imports it must `await closeDb()` and `process.exit()` at the end or the event loop keeps it alive (this is what looked like a hang in the 2026-09-17 survey). `DATABASE_URL` must be set even though deny mode never queries.
- **Commit after every task.** Trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/llm/toolCapture/surfaces.ts` (+ `.test.ts`) | `CAPTURE_SURFACES`: per-surface `allowedTools`/`onlyTools`/server factory derived from the surfaces' own exports (Task 1). |
| `apps/api/src/services/llm/toolCapture/streamObserver.ts` (+ `.test.ts`) | Fold SDK messages into `StreamObservation` (Task 2). |
| `apps/api/src/services/llm/toolCapture/captureProxy.ts` (+ `.test.ts`) | Local forwarding proxy recording `tools[]`, `defer_loading`, system bytes, usage, TTFB (Task 3). |
| `apps/api/src/services/llm/toolCapture/runSurface.ts` | `runSurfaceCapture(opts)`: builds the server + `query()` options for one surface in deny mode (Task 4). |
| `apps/api/src/services/llm/__scripts__/tool-capture.ts` | CLI: `ai:tool-capture` (Task 4). |
| `apps/api/src/services/llm/toolEval/goldenPrompts.ts`, `score.ts` (+ `.test.ts`), `report.ts` | 60 cases, pure scorer, markdown/JSON report (Task 5). |
| `apps/api/src/services/llm/__scripts__/tool-eval.ts` | CLI: `ai:tool-eval` (Task 6). |
| `.github/workflows/ai-tool-eval.yml` | Non-blocking scheduled/dispatch eval (Task 7). |
| `apps/api/migrations/2026-10-20-110000-ai-tool-executions-created-at-idx.sql`, `apps/api/src/db/schema/ai.ts` | Index (Task 8). |
| `apps/api/src/services/aiToolUsageReport.ts` (+ `.test.ts`), `apps/api/src/routes/admin/aiToolUsage.ts` (+ `.test.ts`), `routes/admin/index.ts` | Report SQL + platform-admin endpoint (Task 8). |
| `docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql` | The same SQL for Todd to run on EU/US (Task 8). |
| `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md` | The baseline doc (Task 9). |
| `apps/api/package.json` | `ai:tool-capture`, `ai:tool-eval` scripts (Tasks 4, 6). |

---

### Task 1: Surface table

**Files:**
- Create: `apps/api/src/services/llm/toolCapture/surfaces.ts`, `apps/api/src/services/llm/toolCapture/surfaces.test.ts`

**Interfaces produced:**

```ts
export type CaptureSurfaceId = 'chat' | 'helper-basic' | 'helper-standard' | 'helper-extended' | 'agent-full' | 'script-builder';
export interface CaptureSurface {
  id: CaptureSurfaceId;
  /** Exactly what the surface passes as query() allowedTools. */
  allowedTools: readonly string[];
  /** Exactly what the surface passes as createBreezeMcpServer options.onlyTools; undefined = whole registry. */
  onlyTools?: ReadonlySet<string>;
  server: 'breeze' | 'script_builder';
  mcpServerName: string;               // key used in query() mcpServers
  includePartialMessages: boolean;     // true for the streamingSessionManager surfaces, false for agent runs
  source: string;                      // file:line the values were taken from — printed in the report
}
export const CAPTURE_SURFACES: Readonly<Record<CaptureSurfaceId, CaptureSurface>>;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { BREEZE_MCP_TOOL_NAMES } from '../../aiAgentSdkTools';
import { getHelperAllowedMcpToolNames } from '../../helperToolFilter';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';
import { CAPTURE_SURFACES } from './surfaces';

describe('CAPTURE_SURFACES derive from the surfaces\' own exports', () => {
  it('chat and agent-full expose the whole TOOL_TIERS surface with no registration subset', () => {
    expect(CAPTURE_SURFACES.chat.allowedTools).toEqual(BREEZE_MCP_TOOL_NAMES);
    expect(CAPTURE_SURFACES.chat.onlyTools).toBeUndefined();
    expect(CAPTURE_SURFACES['agent-full'].allowedTools).toEqual(BREEZE_MCP_TOOL_NAMES);
    expect(CAPTURE_SURFACES['agent-full'].onlyTools).toBeUndefined();
    expect(CAPTURE_SURFACES['agent-full'].includePartialMessages).toBe(false);
  });

  it('helper levels are permission allowlists over the full server (8/14/20 tools)', () => {
    expect(CAPTURE_SURFACES['helper-basic'].allowedTools).toEqual(getHelperAllowedMcpToolNames('basic'));
    expect(CAPTURE_SURFACES['helper-standard'].allowedTools).toEqual(getHelperAllowedMcpToolNames('standard'));
    expect(CAPTURE_SURFACES['helper-extended'].allowedTools).toEqual(getHelperAllowedMcpToolNames('extended'));
    expect(CAPTURE_SURFACES['helper-basic'].allowedTools).toHaveLength(8);
    expect(CAPTURE_SURFACES['helper-extended'].onlyTools).toBeUndefined();
  });

  it('script builder uses its own server', () => {
    expect(CAPTURE_SURFACES['script-builder'].server).toBe('script_builder');
    expect(CAPTURE_SURFACES['script-builder'].allowedTools).toEqual(SCRIPT_BUILDER_MCP_TOOL_NAMES);
  });

  it('every surface records where its values came from', () => {
    for (const s of Object.values(CAPTURE_SURFACES)) expect(s.source).toMatch(/\.ts:\d+/);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/llm/toolCapture/surfaces.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement**

```ts
import { BREEZE_MCP_TOOL_NAMES } from '../../aiAgentSdkTools';
import { getHelperAllowedMcpToolNames } from '../../helperToolFilter';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';

export type CaptureSurfaceId = 'chat' | 'helper-basic' | 'helper-standard' | 'helper-extended' | 'agent-full' | 'script-builder';

export interface CaptureSurface { /* as above */ }

/**
 * One row per in-product surface the spec names. Values are taken from the
 * SAME exports the surfaces pass to query()/createBreezeMcpServer — never
 * re-typed here — so a surface change moves the harness with it
 * (surfaces.test.ts asserts equality).
 *
 * `onlyTools` is undefined on every row on purpose: today only the headless
 * agent profiles (verdict/sweep/…) pass a registration subset
 * (aiAgents/runLoop.ts:1877-1892); chat, Helper and the `full` profile
 * register the whole server and gate by allowedTools only. Measuring that
 * gap is the point of this wave.
 */
export const CAPTURE_SURFACES: Readonly<Record<CaptureSurfaceId, CaptureSurface>> = {
  chat: {
    id: 'chat', allowedTools: BREEZE_MCP_TOOL_NAMES, server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: true, source: 'services/streamingSessionManager.ts:1128-1155 (routes/ai.ts:833)',
  },
  'helper-basic': {
    id: 'helper-basic', allowedTools: getHelperAllowedMcpToolNames('basic'), server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: true, source: 'routes/helper/index.ts:164-166,349; services/helperToolFilter.ts:22',
  },
  'helper-standard': {
    id: 'helper-standard', allowedTools: getHelperAllowedMcpToolNames('standard'), server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: true, source: 'routes/helper/index.ts:164-166,349; services/helperToolFilter.ts:34',
  },
  'helper-extended': {
    id: 'helper-extended', allowedTools: getHelperAllowedMcpToolNames('extended'), server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: true, source: 'routes/helper/index.ts:164-166,349; services/helperToolFilter.ts:48',
  },
  'agent-full': {
    id: 'agent-full', allowedTools: BREEZE_MCP_TOOL_NAMES, server: 'breeze', mcpServerName: 'breeze',
    includePartialMessages: false, source: 'services/aiAgents/runLoop.ts:1866-1968 (profileAllowlist null on full)',
  },
  'script-builder': {
    id: 'script-builder', allowedTools: SCRIPT_BUILDER_MCP_TOOL_NAMES, server: 'script_builder', mcpServerName: 'script_builder',
    includePartialMessages: true, source: 'routes/scriptAi.ts:268-287; services/scriptBuilderTools.ts:63,396',
  },
};
```

The `mcpServerName` for the chat surface must equal the key `streamingSessionManager.ts:1141` uses (`mcpServerName` variable — read it; `'breeze'` unless the code says otherwise).

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/llm/toolCapture/surfaces.test.ts
git add apps/api/src/services/llm/toolCapture && git commit -m "feat(ai): tool-capture surface table derived from surface exports (A-W01)"
```

---

### Task 2: Stream observer

**Files:**
- Create: `apps/api/src/services/llm/toolCapture/streamObserver.ts`, `streamObserver.test.ts`

**Interfaces produced:**

```ts
export interface ApiCallUsage { inputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; outputTokens: number }
export interface StreamObservation {
  ttftMs: number | null;                 // SDK `ttft_ms` on the first stream_event when present, else first content_block_delta − start
  apiCalls: ApiCallUsage[];              // one per `assistant` message
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;  // excludes ToolSearch
  toolSearchUses: number;                // tool_use blocks named 'ToolSearch'
  toolSearchResultBlocks: number;        // content blocks typed 'tool_search_tool_result' or 'server_tool_use'
  toolReferenceNames: string[];          // tool_reference blocks seen anywhere in content
  stderrToolSearchLines: string[];       // stderr lines matching /ToolSearch/
  sessionId: string | null;              // from the result message (for --turns resume)
  result: { subtype: string; numTurns: number | null; durationMs: number | null; totalCostUsd: number | null } | null;
}
export function createStreamObserver(startedAtMs?: number): {
  onMessage(message: unknown): void;
  onStderr(chunk: string): void;
  finish(): StreamObservation;
};
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { createStreamObserver } from './streamObserver';

const usage = { input_tokens: 1200, cache_creation_input_tokens: 30000, cache_read_input_tokens: 0, output_tokens: 80 };

describe('createStreamObserver', () => {
  it('folds usage per assistant message, first tool_use, and ToolSearch sightings', () => {
    const o = createStreamObserver(1_000);
    o.onMessage({ type: 'stream_event', event: { type: 'message_start' }, ttft_ms: 412, session_id: 's1' });
    o.onMessage({ type: 'assistant', session_id: 's1', message: { usage, content: [
      { type: 'tool_use', id: 't0', name: 'ToolSearch', input: { query: 'offline devices' } },
    ] } });
    o.onMessage({ type: 'user', message: { content: [
      { type: 'tool_search_tool_result', content: [{ type: 'tool_reference', tool_name: 'mcp__breeze__query_devices' }] },
    ] } });
    o.onMessage({ type: 'assistant', session_id: 's1', message: { usage: { ...usage, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0 }, content: [
      { type: 'text', text: 'Checking…' },
      { type: 'tool_use', id: 't1', name: 'mcp__breeze__query_devices', input: { status: 'offline' } },
    ] } });
    o.onStderr('[ToolSearch:optimistic] mode=tst result=enabled\nother line\n');
    o.onMessage({ type: 'result', subtype: 'success', session_id: 's1', num_turns: 2, duration_ms: 2100, total_cost_usd: 0.012 });

    const obs = o.finish();
    expect(obs.ttftMs).toBe(412);
    expect(obs.apiCalls).toHaveLength(2);
    expect(obs.apiCalls[1]!.cacheReadInputTokens).toBe(30000);
    expect(obs.toolUses).toEqual([{ name: 'mcp__breeze__query_devices', input: { status: 'offline' } }]);
    expect(obs.toolSearchUses).toBe(1);
    expect(obs.toolSearchResultBlocks).toBe(1);
    expect(obs.toolReferenceNames).toEqual(['mcp__breeze__query_devices']);
    expect(obs.stderrToolSearchLines).toEqual(['[ToolSearch:optimistic] mode=tst result=enabled']);
    expect(obs.sessionId).toBe('s1');
    expect(obs.result).toEqual({ subtype: 'success', numTurns: 2, durationMs: 2100, totalCostUsd: 0.012 });
  });

  it('derives ttft from the first content_block_delta when the SDK gives no ttft_ms', () => {
    const o = createStreamObserver(1_000);
    const realNow = Date.now; Date.now = () => 1_350;
    try { o.onMessage({ type: 'stream_event', event: { type: 'content_block_delta' } }); } finally { Date.now = realNow; }
    expect(o.finish().ttftMs).toBe(350);
  });

  it('is null-safe on a session that produced nothing', () => {
    expect(createStreamObserver().finish()).toMatchObject({ ttftMs: null, apiCalls: [], toolUses: [], result: null, sessionId: null });
  });
});
```

Run → FAIL (module missing).

- [ ] **Step 2: Implement** — a small reducer over `message.type`: `stream_event` (ttft), `assistant` (usage + content walk), `user` (content walk for `tool_search_tool_result`/`tool_reference`), `result`. Walk content recursively for `tool_reference` blocks (`{ type: 'tool_reference', tool_name }`). `onStderr` splits on newlines and keeps lines matching `/ToolSearch/`. Numbers default to 0 when a usage field is absent. Keep it dependency-free (no SDK type imports beyond `import type`).

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/llm/toolCapture/streamObserver.test.ts
git add apps/api/src/services/llm/toolCapture && git commit -m "feat(ai): SDK stream observer for tool-capture (A-W01)"
```

---

### Task 3: Capture proxy

**Files:**
- Create: `apps/api/src/services/llm/toolCapture/captureProxy.ts`, `captureProxy.test.ts`

**Interfaces produced:**

```ts
export interface CapturedRequest {
  label: string;
  at: string;                                   // ISO
  path: string;                                 // e.g. /v1/messages
  model: string | null;
  betaHeader: string | null;                    // anthropic-beta
  systemBytes: number;                          // JSON.stringify(body.system).length
  tools: Array<{ name: string; deferLoading: boolean }>;
  toolReferenceCount: number;                   // tool_reference blocks in body.messages
  status: number;
  ttfbMs: number;                               // first upstream response byte
  usage: { inputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; outputTokens: number } | null;
}
export interface CaptureProxy { url: string; setLabel(label: string): void; records(): CapturedRequest[]; close(): Promise<void> }
export function startCaptureProxy(upstream: string): Promise<CaptureProxy>;   // upstream e.g. https://api.anthropic.com
```

Behaviour: listens on `127.0.0.1:0`; forwards method, path, query and all headers except `host`; streams the upstream response through unchanged while teeing it into a buffer; when the response ends, parses usage from JSON (`usage`) or from SSE (`message_start` → `message.usage`, `message_delta` → `usage.output_tokens`). Never logs bodies to stdout; never persists headers (the auth header stays in memory only for the forward).

- [ ] **Step 1: Write the failing test** — spin up a fake upstream with Node `http.createServer` that returns an SSE body:

```ts
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCaptureProxy, type CaptureProxy } from './captureProxy';

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":900,"cache_creation_input_tokens":41000,"cache_read_input_tokens":0,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

let upstream: ReturnType<typeof createServer>; let upstreamUrl: string; let proxy: CaptureProxy;
let seenAuth: string | undefined;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seenAuth = req.headers['x-api-key'] as string | undefined;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(SSE);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  proxy = await startCaptureProxy(upstreamUrl);
});
afterAll(async () => { await proxy.close(); upstream.close(); });

describe('startCaptureProxy', () => {
  it('forwards the request, streams the response back, and records tools/system/usage', async () => {
    proxy.setLabel('chat/on');
    const body = {
      model: 'claude-sonnet-5', system: [{ type: 'text', text: 'x'.repeat(100) }],
      tools: [{ name: 'a' }, { name: 'b', defer_loading: true }],
      messages: [{ role: 'user', content: [{ type: 'tool_reference', tool_name: 'b' }] }],
    };
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-beta': 'tool-search-2026-01-01' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SSE);
    expect(seenAuth).toBe('k');
    const [rec] = proxy.records();
    expect(rec).toMatchObject({
      label: 'chat/on', path: '/v1/messages', model: 'claude-sonnet-5', betaHeader: 'tool-search-2026-01-01', status: 200,
      tools: [{ name: 'a', deferLoading: false }, { name: 'b', deferLoading: true }], toolReferenceCount: 1,
      usage: { inputTokens: 900, cacheCreationInputTokens: 41000, cacheReadInputTokens: 0, outputTokens: 42 },
    });
    expect(rec!.systemBytes).toBeGreaterThan(100);
    expect(rec!.ttfbMs).toBeGreaterThanOrEqual(0);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement** with `node:http`/`node:https` (`request` chosen by `new URL(upstream).protocol`), `http.createServer` listening on `127.0.0.1:0`. Collect the request body fully (it is JSON, small enough), parse defensively (`try/catch` → `tools: []`), forward with `headers: { ...req.headers, host: upstreamHost }`, `res.writeHead(up.statusCode, up.headers)`, `up.on('data', chunk => { res.write(chunk); buf.push(chunk) })`, on `end` compute usage and push the record. Close = `server.close()` wrapped in a promise.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/llm/toolCapture/captureProxy.test.ts
git add apps/api/src/services/llm/toolCapture && git commit -m "feat(ai): local capture proxy for Anthropic requests (A-W01)"
```

---

### Task 4: Surface runner and the `ai:tool-capture` CLI

**Files:**
- Create: `apps/api/src/services/llm/toolCapture/runSurface.ts`, `apps/api/src/services/llm/__scripts__/tool-capture.ts`
- Modify: `apps/api/package.json` (`"ai:tool-capture": "tsx src/services/llm/__scripts__/tool-capture.ts"`)

**Interfaces produced:**

```ts
export interface RunSurfaceOptions {
  surface: CaptureSurface;
  prompt: string;
  model: string;
  env: Record<string, string>;         // the child env, already including ENABLE_TOOL_SEARCH / ANTHROPIC_BASE_URL overrides
  resume?: string;                     // session id for turn 2+
  maxTurns?: number;                   // default 2 — lets the model answer after the deny
  timeoutMs?: number;                  // default 90_000
}
export interface SurfaceCaptureResult {
  surface: CaptureSurfaceId;
  registeredToolCount: number;         // tools the MCP server registered (schemas the model can receive)
  allowedToolCount: number;
  observation: StreamObservation;
}
export async function runSurfaceCapture(opts: RunSurfaceOptions): Promise<SurfaceCaptureResult>;
```

- [ ] **Step 1: Implement `runSurface.ts`** (no unit test — it is the seam to the real SDK; `providerFidelityHarness.ts:451-500` is the pattern):

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AI_SYSTEM_PROMPT_BASE } from '../../aiAgentSystemPrompt';
import { createBreezeMcpServer, TOOL_TIERS } from '../../aiAgentSdkTools';
import { createScriptBuilderMcpServer, SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';
import { StreamObservation } from './streamObserver';
import { createStreamObserver } from './streamObserver';
import type { CaptureSurface, CaptureSurfaceId } from './surfaces';

const denyAuth = () => { throw new Error('tool-capture: handlers never execute (deny mode)'); };

export async function runSurfaceCapture(opts: RunSurfaceOptions): Promise<SurfaceCaptureResult> {
  const { surface } = opts;
  const mcpServer = surface.server === 'breeze'
    ? createBreezeMcpServer(denyAuth, undefined, undefined, undefined, [], surface.onlyTools ? { onlyTools: surface.onlyTools } : undefined)
    : createScriptBuilderMcpServer(denyAuth);
  const registeredToolCount = surface.server === 'breeze'
    ? (surface.onlyTools ? surface.onlyTools.size : Object.keys(TOOL_TIERS).length)
    : SCRIPT_BUILDER_MCP_TOOL_NAMES.length;

  const observer = createStreamObserver();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 90_000); timer.unref?.();
  try {
    const session = query({
      prompt: opts.prompt,
      options: {
        systemPrompt: AI_SYSTEM_PROMPT_BASE,        // see note below
        model: opts.model,
        maxTurns: opts.maxTurns ?? 2,
        tools: [],
        allowedTools: [...surface.allowedTools],
        mcpServers: { [surface.mcpServerName]: mcpServer },
        includePartialMessages: surface.includePartialMessages,
        canUseTool: async () => ({ behavior: 'deny', message: 'tool-capture harness: execution disabled' }),
        env: opts.env,
        resume: opts.resume,
        persistSession: true,
        settingSources: [],
        thinking: { type: 'disabled' },
        abortController: abort,
        stderr: (data: string) => observer.onStderr(data),
      },
    });
    for await (const message of session) observer.onMessage(message);
  } finally { clearTimeout(timer); }
  return { surface: surface.id, registeredToolCount, allowedToolCount: surface.allowedTools.length, observation: observer.finish() };
}
```

Note on the system prompt: production composes `AI_SYSTEM_PROMPT_BASE` + per-user/page sections (`aiAgent.ts:626-690`, needs an `AuthContext`); Helper uses `buildHelperSystemPrompt` (`routes/helper/index.ts:153`); agent runs use `buildAgentRunSystemPrompt`. The harness sends the shared base only: the quantity under measurement is the **tools** block and tool-search behaviour, and the base is the constant term. The baseline doc records `Buffer.byteLength(AI_SYSTEM_PROMPT_BASE)` beside the measured input tokens so the delta is explicit. (After A-W02 lands, switch to `AI_SYSTEM_PROMPT_BASE + renderToolIndexByDomain(listChatSurfaceToolNames()) + AI_SYSTEM_PROMPT_TAIL`; that is a one-line follow-up, note it in the file header.)

`createBreezeMcpServer` calls `getAuth` only inside tool handlers (`makeToolHandler`, `aiAgentSdkTools.ts:474`); if construction ever calls it eagerly, `denyAuth` throws immediately and the harness stops with a clear message — correct behaviour, not something to work around.

- [ ] **Step 2: Implement the CLI**

`apps/api/src/services/llm/__scripts__/tool-capture.ts`, with a usage docblock in the `m365-sync-benchmark.ts` style:

```
Usage:
  DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=… \
  pnpm --filter @breeze/api ai:tool-capture -- \
    --surface chat|helper-basic|helper-standard|helper-extended|agent-full|script-builder|all \
    [--tool-search default|on|off]   (default: default; forced to on|off when --proxy is set)
    [--proxy]                          record exact tools[]/defer_loading/system bytes via a local forwarding proxy
    [--turns 1|2]                      2 = resume the session with a second message to measure cache-read share
    [--prompt "…"]                     default: "Which Windows devices in the fleet are offline right now?"
    [--model <id>]                     default: resolveDefaultModel()
    [--base-url URL --auth-token T | --api-key K]   BYO endpoint (labels rows byo:<host>); implies non-first-party host
    [--out apps/api/tool-capture.jsonl]
```

Flow: parse args (hand-rolled `process.argv` loop; no new dependency) → `const resolved = await resolveLlmConfig(null)` (`services/llm/llmConfigResolver.ts:299`; exit 2 with a message if `source === 'unavailable'`) → `let env = buildClaudeSdkChildEnv(resolved)` (`streamingSessionManager.ts:192`, exported) → BYO overrides (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`) → `--tool-search on|off` sets `ENABLE_TOOL_SEARCH='true'|'false'`, `default` leaves it unset (and refuses to combine with `--proxy`: print why, exit 2) → if `--proxy`: `startCaptureProxy(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com')`, set `env.ANTHROPIC_BASE_URL = proxy.url` → for each selected surface: `proxy?.setLabel(surface.id)`, `runSurfaceCapture(...)`, if `--turns 2` run again with `resume: observation.sessionId` and `prompt: 'Thanks. And how many of those are servers?'` → append one JSON line per run `{ at, surface, turn, toolSearch, proxy, model, host: new URL(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').host, systemPromptBytes, registeredToolCount, allowedToolCount, observation, proxyRequests }` → print a table (surface | turn | tools sent | deferred | input | cache_create | cache_read | ttft ms | ToolSearch seen | first tool) → `await proxy?.close(); await closeDb(); process.exit(0)`.

`package.json`: add `"ai:tool-capture": "tsx src/services/llm/__scripts__/tool-capture.ts"`.

- [ ] **Step 3: Smoke it (needs a key) and commit**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && pnpm lint
# with a key available:
DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=$KEY pnpm --filter @breeze/api ai:tool-capture -- --surface chat --turns 2 --out /tmp/cap.jsonl
DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=$KEY pnpm --filter @breeze/api ai:tool-capture -- --surface chat --proxy --tool-search on --out /tmp/cap.jsonl
```
Expected: the first run prints a row with a ToolSearch sighting (or not — that is the measurement); the proxy run prints `tools sent` ≈ registered count and `deferred` > 0 when search is on. If no key is available in the executor's environment, say so in the commit body and leave the smoke to Task 9.

```bash
git add apps/api/src/services/llm apps/api/package.json && git commit -m "feat(ai): ai:tool-capture harness — per-surface SDK capture in deny mode (A-W01)"
```

---

### Task 5: Golden prompt set and scorer

**Files:**
- Create: `apps/api/src/services/llm/toolEval/goldenPrompts.ts`, `score.ts`, `score.test.ts`, `report.ts`, `goldenPrompts.test.ts`

**Interfaces produced:**

```ts
export interface GoldenExpectation { tool: string; action?: string }          // bare tool name (no mcp__breeze__ prefix)
export interface GoldenCase { id: string; prompt: string; expect: GoldenExpectation[]; surfaces?: CaptureSurfaceId[] }  // default ['chat']
export const GOLDEN_CASES: readonly GoldenCase[];                             // 60 entries
export interface CaseScore { id: string; hit: boolean; observedTool: string | null; observedAction: string | null; answeredWithoutTool: boolean }
export function scoreFirstCall(c: GoldenCase, observation: Pick<StreamObservation, 'toolUses'>): CaseScore;
export function summarize(scores: CaseScore[]): { total: number; hits: number; accuracy: number; misses: CaseScore[] };
export function renderMarkdownReport(input: EvalReport): string;
```

- [ ] **Step 1: Write the failing tests**

`score.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scoreFirstCall, summarize } from './score';

const c = { id: 'x', prompt: 'p', expect: [{ tool: 'manage_alerts', action: 'list' }, { tool: 'query_monitors' }] };

describe('scoreFirstCall', () => {
  it('hits on the first non-ToolSearch tool_use matching any expectation (name + action)', () => {
    expect(scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__manage_alerts', input: { action: 'list' } }] }).hit).toBe(true);
    expect(scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__query_monitors', input: {} }] }).hit).toBe(true);
  });
  it('misses on the wrong action or wrong tool, and only the FIRST call counts', () => {
    expect(scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__manage_alerts', input: { action: 'resolve' } }] }).hit).toBe(false);
    expect(scoreFirstCall(c, { toolUses: [{ name: 'mcp__breeze__query_devices', input: {} }, { name: 'mcp__breeze__manage_alerts', input: { action: 'list' } }] }))
      .toMatchObject({ hit: false, observedTool: 'query_devices' });
  });
  it('records an answer with no tool call as a miss', () => {
    expect(scoreFirstCall(c, { toolUses: [] })).toMatchObject({ hit: false, answeredWithoutTool: true, observedTool: null });
  });
  it('summarizes', () => {
    const s = summarize([{ id: 'a', hit: true, observedTool: 'x', observedAction: null, answeredWithoutTool: false }, { id: 'b', hit: false, observedTool: null, observedAction: null, answeredWithoutTool: true }]);
    expect(s).toMatchObject({ total: 2, hits: 1, accuracy: 0.5 });
    expect(s.misses.map((m) => m.id)).toEqual(['b']);
  });
});
```

`goldenPrompts.test.ts` (keeps the set honest against the registry):

```ts
import { describe, expect, it } from 'vitest';
import { TOOL_TIERS } from '../../aiAgentSdkTools';
import { aiTools } from '../../aiToolNames';
import '../../aiTools';
import { GOLDEN_CASES } from './goldenPrompts';

describe('GOLDEN_CASES', () => {
  it('has 60 unique ids', () => {
    expect(GOLDEN_CASES).toHaveLength(60);
    expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(60);
  });
  it('expects only tools the chat surface can call, and only actions those tools declare', () => {
    for (const c of GOLDEN_CASES) for (const e of c.expect) {
      expect(e.tool in TOOL_TIERS, `${c.id}: ${e.tool} not in TOOL_TIERS`).toBe(true);
      if (e.action) {
        const schema = aiTools.get(e.tool)?.definition.input_schema as { properties?: { action?: { enum?: string[] } } };
        expect(schema?.properties?.action?.enum ?? [], `${c.id}: ${e.tool}.${e.action}`).toContain(e.action);
      }
    }
  });
  it('covers at least 10 distinct domains worth of tools (no single-tool eval)', () => {
    expect(new Set(GOLDEN_CASES.flatMap((c) => c.expect.map((e) => e.tool))).size).toBeGreaterThanOrEqual(35);
  });
});
```

Run both → FAIL.

- [ ] **Step 2: Write the 60 cases**

`goldenPrompts.ts` — real MSP phrasing, no tool names in prompts, alternates where two tools are both correct. Use exactly these (ids `g01`–`g60`); where an `action` is given it is one the tool's `input_schema.properties.action.enum` declares on `main` (the test enforces it — if an action name differs, fix the case, not the tool):

```ts
export const GOLDEN_CASES: readonly GoldenCase[] = [
  { id: 'g01', prompt: 'Which Windows devices are offline right now?', expect: [{ tool: 'query_devices' }] },
  { id: 'g02', prompt: 'Show me everything about the device named LAB-WS-042.', expect: [{ tool: 'resolve_device_context' }, { tool: 'query_devices' }, { tool: 'get_device_details' }] },
  { id: 'g03', prompt: 'Is CPU on FS-01 pegged? Show the last hour.', expect: [{ tool: 'analyze_metrics' }, { tool: 'resolve_device_context' }] },
  { id: 'g04', prompt: 'How many critical alerts are open across all customers?', expect: [{ tool: 'manage_alerts', action: 'list' }] },
  { id: 'g05', prompt: 'Acknowledge the disk-space alert on ACME-DC1, I am on it.', expect: [{ tool: 'manage_alerts', action: 'acknowledge' }, { tool: 'resolve_device_context' }] },
  { id: 'g06', prompt: 'What alert rules fire for high memory?', expect: [{ tool: 'manage_alert_rules' }] },
  { id: 'g07', prompt: 'Which machines are still missing the September cumulative update?', expect: [{ tool: 'manage_patches', action: 'list' }] },
  { id: 'g08', prompt: 'Approve KB5065431 for the pilot ring.', expect: [{ tool: 'manage_patches', action: 'approve' }, { tool: 'manage_update_rings' }] },
  { id: 'g09', prompt: 'Does anything in the fleet have a known-exploited CVE?', expect: [{ tool: 'get_vulnerability_report' }] },
  { id: 'g10', prompt: 'List the CVEs on WEB-03.', expect: [{ tool: 'get_device_vulnerabilities' }, { tool: 'resolve_device_context' }] },
  { id: 'g11', prompt: 'How are our security controls scoring — AV, firewall, disk encryption?', expect: [{ tool: 'get_security_posture' }] },
  { id: 'g12', prompt: 'Run a CIS benchmark check on the finance server.', expect: [{ tool: 'get_cis_compliance' }, { tool: 'get_cis_device_report' }, { tool: 'resolve_device_context' }] },
  { id: 'g13', prompt: 'Search the logs on PRINT-SRV for spooler crashes today.', expect: [{ tool: 'search_logs' }, { tool: 'resolve_device_context' }] },
  { id: 'g14', prompt: 'Restart the Print Spooler service on PRINT-SRV.', expect: [{ tool: 'manage_services', action: 'restart' }, { tool: 'resolve_device_context' }] },
  { id: 'g15', prompt: 'Run "ipconfig /all" on LAB-WS-042.', expect: [{ tool: 'execute_command' }, { tool: 'resolve_device_context' }] },
  { id: 'g16', prompt: 'Do we have a script that clears the Teams cache?', expect: [{ tool: 'list_scripts' }, { tool: 'search_script_library' }] },
  { id: 'g17', prompt: 'Run the "Clear Teams cache" script on every machine at Northwind.', expect: [{ tool: 'run_script' }, { tool: 'list_scripts' }, { tool: 'query_devices' }] },
  { id: 'g18', prompt: 'What automations are enabled?', expect: [{ tool: 'manage_automations', action: 'list' }] },
  { id: 'g19', prompt: 'What is eating the disk on ACME-DC1?', expect: [{ tool: 'analyze_disk_usage' }, { tool: 'resolve_device_context' }] },
  { id: 'g20', prompt: 'Free up space on ACME-DC1 — temp files, update leftovers, the usual.', expect: [{ tool: 'disk_cleanup' }, { tool: 'analyze_disk_usage' }, { tool: 'resolve_device_context' }] },
  { id: 'g21', prompt: 'Who is logged on to RDS-02 right now?', expect: [{ tool: 'get_active_users' }, { tool: 'resolve_device_context' }] },
  { id: 'g22', prompt: 'Take a screenshot of what the user on KIOSK-1 sees.', expect: [{ tool: 'take_screenshot' }, { tool: 'resolve_device_context' }] },
  { id: 'g23', prompt: 'Did last night\'s backups succeed for Contoso?', expect: [{ tool: 'get_backup_status' }, { tool: 'query_backups' }] },
  { id: 'g24', prompt: 'Restore yesterday\'s copy of the Finance share on FS-01.', expect: [{ tool: 'browse_snapshots' }, { tool: 'restore_snapshot' }, { tool: 'resolve_device_context' }] },
  { id: 'g25', prompt: 'Kick off a backup of SQL-01 now.', expect: [{ tool: 'trigger_backup' }, { tool: 'trigger_mssql_backup' }, { tool: 'resolve_device_context' }] },
  { id: 'g26', prompt: 'Which customers are breaching their backup SLA?', expect: [{ tool: 'get_sla_breaches' }, { tool: 'get_sla_compliance_report' }] },
  { id: 'g27', prompt: 'What new devices showed up on the Contoso network this week?', expect: [{ tool: 'get_network_changes' }, { tool: 'network_discovery' }] },
  { id: 'g28', prompt: 'Scan the 10.20.0.0/24 subnet at Northwind.', expect: [{ tool: 'network_discovery' }] },
  { id: 'g29', prompt: 'What IPs has LAB-WS-042 had this month?', expect: [{ tool: 'get_ip_history' }, { tool: 'resolve_device_context' }] },
  { id: 'g30', prompt: 'Is DNS filtering on for Contoso?', expect: [{ tool: 'get_dns_security' }, { tool: 'manage_dns_policy' }] },
  { id: 'g31', prompt: 'Add the three new laptops to the "Sales" device group.', expect: [{ tool: 'manage_groups', action: 'add_devices' }, { tool: 'manage_groups', action: 'list' }, { tool: 'query_devices' }] },
  { id: 'g32', prompt: 'Tag WEB-03 as "pci".', expect: [{ tool: 'manage_tags' }, { tool: 'resolve_device_context' }] },
  { id: 'g33', prompt: 'Which organizations do we manage?', expect: [{ tool: 'list_organizations' }] },
  { id: 'g34', prompt: 'Open a ticket: Northwind reports slow email since Monday.', expect: [{ tool: 'manage_tickets' }] },
  { id: 'g35', prompt: 'Log 45 minutes on ticket 1042 for the printer fix.', expect: [{ tool: 'manage_tickets', action: 'log_time_entry' }] },
  { id: 'g36', prompt: 'Start my timer on ticket 1042.', expect: [{ tool: 'manage_tickets', action: 'start_timer' }] },
  { id: 'g37', prompt: 'Draft a quote for 25 M365 Business Premium seats for Contoso.', expect: [{ tool: 'manage_quotes' }, { tool: 'search_catalog' }] },
  { id: 'g38', prompt: 'Which invoices are overdue?', expect: [{ tool: 'list_invoices' }, { tool: 'manage_invoices' }] },
  { id: 'g39', prompt: 'When does the Contoso managed-services contract renew?', expect: [{ tool: 'list_contracts' }, { tool: 'get_contract' }, { tool: 'manage_contracts' }] },
  { id: 'g40', prompt: 'What does a Lenovo ThinkPad T14 cost from our distributor?', expect: [{ tool: 'lookup_distributor_product' }] },
  { id: 'g41', prompt: 'Show me the Microsoft 365 users at Contoso without MFA.', expect: [{ tool: 'm365_query_users' }] },
  { id: 'g42', prompt: 'Any risky sign-ins at Contoso in the last 24 hours?', expect: [{ tool: 'm365_query_signins' }] },
  { id: 'g43', prompt: 'Which Contoso devices are non-compliant in Intune?', expect: [{ tool: 'm365_query_intune_devices' }] },
  { id: 'g44', prompt: 'Any open Huntress incidents?', expect: [{ tool: 'get_huntress_incidents' }] },
  { id: 'g45', prompt: 'Isolate WEB-03 in SentinelOne.', expect: [{ tool: 's1_isolate_device' }, { tool: 'resolve_device_context' }] },
  { id: 'g46', prompt: 'What threats has SentinelOne flagged this week?', expect: [{ tool: 'get_s1_threats' }] },
  { id: 'g47', prompt: 'Which configuration policies apply to the Contoso servers?', expect: [{ tool: 'list_configuration_policies' }, { tool: 'get_effective_configuration' }] },
  { id: 'g48', prompt: 'What settings does the "Standard Workstation" policy actually push?', expect: [{ tool: 'get_configuration_policy' }, { tool: 'list_configuration_policies' }] },
  { id: 'g49', prompt: 'Which software is banned by policy but still installed somewhere?', expect: [{ tool: 'get_software_compliance' }, { tool: 'get_compliance_status' }] },
  { id: 'g50', prompt: 'When is the next maintenance window for Northwind?', expect: [{ tool: 'manage_maintenance_windows' }] },
  { id: 'g51', prompt: 'Is the website monitor for the Contoso public site green?', expect: [{ tool: 'query_monitors' }, { tool: 'get_service_monitoring_status' }, { tool: 'list_monitors' }] },
  { id: 'g52', prompt: 'Who changed the firewall policy last week?', expect: [{ tool: 'query_audit_log' }, { tool: 'query_change_log' }] },
  { id: 'g53', prompt: 'Generate a monthly health report for Contoso.', expect: [{ tool: 'generate_report' }, { tool: 'get_executive_summary' }] },
  { id: 'g54', prompt: 'How is the fleet doing overall today?', expect: [{ tool: 'get_fleet_health' }, { tool: 'get_executive_summary' }] },
  { id: 'g55', prompt: 'Which agents are running an old version?', expect: [{ tool: 'query_agent_versions' }] },
  { id: 'g56', prompt: 'Pull the agent logs from LAB-WS-042, it keeps disconnecting.', expect: [{ tool: 'search_agent_logs' }, { tool: 'resolve_device_context' }] },
  { id: 'g57', prompt: 'How do I set up a maintenance window in Breeze?', expect: [{ tool: 'search_documentation' }] },
  { id: 'g58', prompt: 'Run the onboarding playbook for the new Northwind laptops.', expect: [{ tool: 'list_playbooks' }, { tool: 'execute_playbook' }] },
  { id: 'g59', prompt: 'Any USB storage plugged in at Contoso this week?', expect: [{ tool: 'get_peripheral_activity' }] },
  { id: 'g60', prompt: 'Where is Contoso keeping credit-card numbers in files?', expect: [{ tool: 'get_sensitive_data_overview' }] },
];
```

`g57` will fail the "in TOOL_TIERS" assertion until A-W02 Task 5 declares `search_documentation`; keep it — it is the one case that documents the mute-tool bug — and add `'search_documentation'` to a `PENDING_DECLARATION` set in the test that the assertion skips, with a comment pointing at A-W02. Remove the set in A-W02.

`score.ts`: strip `mcp__breeze__` (and `mcp__script_builder__`) prefixes before comparing; `observedAction = typeof input.action === 'string' ? input.action : null`.

`report.ts`: `EvalReport = { generatedAt, model, toolSearch, surface, systemPromptBytes, cases: Array<CaseScore & { expected: GoldenExpectation[]; inputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; ttftMs: number | null; toolSearchUsed: boolean }>, summary: ReturnType<typeof summarize>, meanFirstCallInputTokens: number }` and `renderMarkdownReport` → a header line (`accuracy X/60 = NN.N%`), a misses table (`id | prompt | expected | observed`), and a token line.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/llm/toolEval
git add apps/api/src/services/llm/toolEval && git commit -m "feat(ai): golden tool-selection cases + first-call scorer (A-W01)"
```

---

### Task 6: Eval runner CLI

**Files:**
- Create: `apps/api/src/services/llm/__scripts__/tool-eval.ts`
- Modify: `apps/api/package.json` (`"ai:tool-eval": "tsx src/services/llm/__scripts__/tool-eval.ts"`)

- [ ] **Step 1: Implement**

Usage block:

```
  DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=… \
  pnpm --filter @breeze/api ai:tool-eval -- [--surface chat|helper-standard|…] [--model <id>] [--tool-search default|on|off]
      [--cases g01,g02] [--concurrency 3] [--out tool-eval-report.json] [--summary-md tool-eval-summary.md]
```

Per case: `runSurfaceCapture({ surface: CAPTURE_SURFACES[surface], prompt: c.prompt, model, env, maxTurns: 1 })` (one turn is enough for the first call), `scoreFirstCall`, collect token fields from `observation.apiCalls[0]`. Concurrency via a tiny promise pool (no dependency). Retry a case once on a thrown SDK error, then record it as `observedTool: null` with `error`. Write JSON + markdown; print the markdown; exit 0 always (the report is the product, never a gate) — exit 2 only for usage errors or a missing key. End with `await closeDb(); process.exit(0)`.

- [ ] **Step 2: Smoke and commit**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && pnpm lint
# with a key: 3 cases, then the full set
DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=$KEY pnpm --filter @breeze/api ai:tool-eval -- --cases g01,g04,g57 --out /tmp/eval.json --summary-md /tmp/eval.md
git add apps/api/src/services/llm apps/api/package.json && git commit -m "feat(ai): ai:tool-eval runner with JSON + markdown report (A-W01)"
```

---

### Task 7: Non-blocking CI workflow

**Files:**
- Create: `.github/workflows/ai-tool-eval.yml`

- [ ] **Step 1: Write it** (copy the checkout/pnpm/node steps and their SHAs from `.github/workflows/security.yml:25-45`):

```yaml
name: AI Tool Eval

# Non-blocking by construction: runs on a schedule and on demand, never on
# pull_request (it needs a secret, and pr-workflow-must-be-secret-free forbids
# that), and reports only as an artifact + job summary.
on:
  workflow_dispatch:
    inputs:
      model: { description: 'Model id (default: resolveDefaultModel())', required: false, default: '' }
      tool_search: { description: 'default | on | off', required: false, default: 'default' }
      surface: { description: 'chat | helper-standard | …', required: false, default: 'chat' }
  schedule:
    - cron: '15 5 * * 1'   # Mondays 05:15 UTC

permissions:
  contents: read

env:
  PNPM_VERSION: '10.34.5'

jobs:
  tool-eval:
    name: Golden tool-selection eval (report only)
    runs-on: ubuntu-latest
    continue-on-error: true
    timeout-minutes: 30
    env:
      HAS_KEY: ${{ secrets.AI_TOOL_EVAL_ANTHROPIC_API_KEY != '' }}
    steps:
      - name: Checkout
        uses: actions/checkout@<same SHA as security.yml> # v7
        with:
          persist-credentials: false
      - name: Setup pnpm
        uses: pnpm/action-setup@<same SHA as security.yml> # v6.1.0
        with:
          version: ${{ env.PNPM_VERSION }}
      - name: Setup Node.js
        uses: actions/setup-node@<same SHA as security.yml> # v7
        with:
          node-version-file: .node-version
          cache: 'pnpm'
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Run eval
        if: env.HAS_KEY == 'true'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.AI_TOOL_EVAL_ANTHROPIC_API_KEY }}
          DATABASE_URL: postgresql://unused:unused@127.0.0.1:5432/unused
        run: |
          pnpm --filter @breeze/api ai:tool-eval -- \
            --surface "${{ github.event.inputs.surface || 'chat' }}" \
            --tool-search "${{ github.event.inputs.tool_search || 'default' }}" \
            ${{ github.event.inputs.model && format('--model {0}', github.event.inputs.model) || '' }} \
            --out tool-eval-report.json --summary-md tool-eval-summary.md
          cat tool-eval-summary.md >> "$GITHUB_STEP_SUMMARY"
      - name: Explain skip
        if: env.HAS_KEY != 'true'
        run: echo "AI_TOOL_EVAL_ANTHROPIC_API_KEY is not set; eval skipped." >> "$GITHUB_STEP_SUMMARY"
      - name: Upload report
        if: always()
        uses: actions/upload-artifact@<same SHA as security.yml> # v7
        with:
          name: ai-tool-eval-${{ github.run_id }}
          path: |
            tool-eval-report.json
            tool-eval-summary.md
          if-no-files-found: ignore
          retention-days: 90
```

Replace each `<same SHA …>` with the literal 40-hex SHA from `security.yml` (the security contract rejects anything else).

- [ ] **Step 2: Verify the workflow contract and commit**

```bash
pnpm test:workflow-security
git add .github/workflows/ai-tool-eval.yml && git commit -m "ci: scheduled, non-blocking AI tool-selection eval (A-W01)"
```

Todd creates the `AI_TOOL_EVAL_ANTHROPIC_API_KEY` repository secret (a low-limit key on the platform account); the PR body says so.

---

### Task 8: Hot/cold tool usage report

**Files:**
- Create: `apps/api/migrations/2026-10-20-110000-ai-tool-executions-created-at-idx.sql`
- Modify: `apps/api/src/db/schema/ai.ts` (`aiToolExecutions` indexes, `:137-139`)
- Create: `apps/api/src/services/aiToolUsageReport.ts`, `aiToolUsageReport.test.ts`
- Create: `apps/api/src/routes/admin/aiToolUsage.ts`, `aiToolUsage.test.ts`; Modify: `apps/api/src/routes/admin/index.ts`
- Create: `docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql`

**Interfaces produced:**

```ts
export interface ToolUsageRow { surface: string; toolName: string; executions: number; completed: number; failed: number; rejected: number; distinctSessions: number; avgDurationMs: number | null; lastUsedAt: string | null }
export interface ToolUsageReport { days: number; generatedAt: string; rows: ToolUsageRow[]; coldTools: string[]; registeredToolCount: number }
export function toolUsageReportSql(days: number): SQL;                       // the one statement
export async function buildToolUsageReport(days: number): Promise<ToolUsageReport>;   // caller supplies the DB context
```

- [ ] **Step 1: Write the failing tests**

`aiToolUsageReport.test.ts` — mock `../db` so `db.execute` returns canned rows; assert `coldTools` = registered names with no row, and that the SQL text contains the surface CASE and the `>= now() - make_interval(days => 90)` window:

```ts
import { describe, expect, it, vi } from 'vitest';

const executeMock = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ db: { execute: executeMock } }));
vi.mock('./aiTools', () => ({ getAllRegisteredToolNames: () => ['query_devices', 'manage_alerts', 'never_used_tool'] }));

import { buildToolUsageReport, toolUsageReportSql } from './aiToolUsageReport';

describe('buildToolUsageReport', () => {
  it('maps rows and lists registered tools with zero executions as cold', async () => {
    executeMock.mockResolvedValueOnce([
      { surface: 'chat', tool_name: 'query_devices', executions: '12', completed: '11', failed: '1', rejected: '0', distinct_sessions: '7', avg_duration_ms: '431.2', last_used_at: '2026-09-16T10:00:00Z' },
      { surface: 'helper', tool_name: 'manage_alerts', executions: '3', completed: '3', failed: '0', rejected: '0', distinct_sessions: '3', avg_duration_ms: null, last_used_at: null },
    ]);
    const r = await buildToolUsageReport(90);
    expect(r.rows[0]).toEqual({ surface: 'chat', toolName: 'query_devices', executions: 12, completed: 11, failed: 1, rejected: 0, distinctSessions: 7, avgDurationMs: 431, lastUsedAt: '2026-09-16T10:00:00Z' });
    expect(r.coldTools).toEqual(['never_used_tool']);
    expect(r.registeredToolCount).toBe(3);
  });
  it('derives the surface from ai_sessions.type + device_id and windows on created_at', () => {
    const text = String((toolUsageReportSql(90) as unknown as { queryChunks?: unknown[] }).queryChunks ?? toolUsageReportSql(90));
    expect(text).toMatch(/device_id IS NOT NULL THEN 'helper'/);
    expect(text).toMatch(/created_at >= now\(\) - make_interval\(days => /);
  });
});
```

(If Drizzle's `SQL` object does not stringify usefully, export the raw template string builder `TOOL_USAGE_REPORT_SQL_TEXT(days): string` and test that instead — it must be the same text `db.execute(sql.raw(...))` runs.)

`routes/admin/aiToolUsage.test.ts` — copy the mock preamble from `routes/admin/aiKillState.test.ts:13-45` (auth middleware stub, audit mocks), mock `../../services/aiToolUsageReport` and `../../db` (`runOutsideDbContext`/`withSystemDbAccessContext` as pass-throughs), mount `adminRoutes` on a Hono app and assert: no auth → 401; non-platform-admin → 403; platform admin `GET /ai/tool-usage?days=30` → 200 with the service's report and `days: 30`; `days=0` and `days=400` → 400.

Run → FAIL.

- [ ] **Step 2: Migration + schema**

```sql
-- @no-transaction
-- ai_tool_executions: created_at index for the AI tool-usage report (A-W01, #6148).
-- The table has only session_id and status indexes; the platform-admin report
-- (GET /api/v1/admin/ai/tool-usage) and the operator SQL in
-- docs/superpowers/specs/ai-mcp/sql/ window on created_at and would seq-scan.
-- CONCURRENTLY so a hot table is never locked; hence @no-transaction.
-- DDL only — no rows written, so no breeze.scope election is needed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_tool_executions_created_at_idx
  ON ai_tool_executions (created_at);
```

`db/schema/ai.ts`: add `createdAtIdx: index('ai_tool_executions_created_at_idx').on(table.createdAt),` beside `statusIdx`. Run `pnpm db:check-drift` if a DB is available (`pnpm test-stack up` gives one); otherwise note it for the PR.

- [ ] **Step 3: Service**

```ts
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { getAllRegisteredToolNames } from './aiTools';

export function toolUsageReportSqlText(days: number): string {
  const d = Math.trunc(days);
  return `
    SELECT
      CASE WHEN s.type = 'general' AND s.device_id IS NOT NULL THEN 'helper'
           WHEN s.type = 'general' THEN 'chat'
           ELSE s.type END                                   AS surface,
      e.tool_name,
      COUNT(*)                                               AS executions,
      COUNT(*) FILTER (WHERE e.status = 'completed')         AS completed,
      COUNT(*) FILTER (WHERE e.status = 'failed')            AS failed,
      COUNT(*) FILTER (WHERE e.status = 'rejected')          AS rejected,
      COUNT(DISTINCT e.session_id)                           AS distinct_sessions,
      AVG(e.duration_ms) FILTER (WHERE e.status = 'completed') AS avg_duration_ms,
      MAX(e.created_at)                                      AS last_used_at
    FROM ai_tool_executions e
    JOIN ai_sessions s ON s.id = e.session_id
    WHERE e.created_at >= now() - make_interval(days => ${d})
    GROUP BY 1, 2
    ORDER BY executions DESC, tool_name`;
}

export async function buildToolUsageReport(days: number): Promise<ToolUsageReport> {
  const rows = (await db.execute(sql.raw(toolUsageReportSqlText(days)))) as unknown as Array<Record<string, unknown>>;
  const mapped: ToolUsageRow[] = rows.map((r) => ({
    surface: String(r.surface),
    toolName: String(r.tool_name),
    executions: Number(r.executions),
    completed: Number(r.completed),
    failed: Number(r.failed),
    rejected: Number(r.rejected),
    distinctSessions: Number(r.distinct_sessions),
    avgDurationMs: r.avg_duration_ms == null ? null : Math.round(Number(r.avg_duration_ms)),
    lastUsedAt: r.last_used_at == null ? null : new Date(String(r.last_used_at)).toISOString(),
  }));
  const seen = new Set(mapped.map((r) => r.toolName));
  const registered = getAllRegisteredToolNames();
  return { days, generatedAt: new Date().toISOString(), rows: mapped, coldTools: registered.filter((n) => !seen.has(n)).sort(), registeredToolCount: registered.length };
}
```

`days` is validated by the route (1..365) and truncated here, so `sql.raw` never sees user text. The same text goes verbatim into `docs/superpowers/specs/ai-mcp/sql/2026-09-17-ai-tool-usage-90d.sql` wrapped as:

```sql
-- Operator copy of apps/api/src/services/aiToolUsageReport.ts (keep identical).
-- Run per region on the managed DB. FORCE RLS binds the table owner, so the
-- scope election is REQUIRED or every count reads 0.
BEGIN;
SELECT set_config('breeze.scope', 'system', true);
<the SELECT with 90>;
ROLLBACK;
```

- [ ] **Step 4: Route**

`routes/admin/aiToolUsage.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { buildToolUsageReport } from '../../services/aiToolUsageReport';

export const aiToolUsageAdminRoutes = new Hono();

// Platform-admin only (adminRoutes mounts platformAdminMiddleware on '*').
// Cross-tenant by design: it aggregates tool names, never tool inputs/outputs.
aiToolUsageAdminRoutes.get(
  '/tool-usage',
  zValidator('query', z.object({ days: z.coerce.number().int().min(1).max(365).default(90) })),
  async (c) => {
    const { days } = c.req.valid('query');
    const report = await runOutsideDbContext(() => withSystemDbAccessContext(() => buildToolUsageReport(days), 'aiToolUsageReport'));
    return c.json(report);
  },
);
```

(`withSystemDbAccessContext`'s second argument is the label string — match `apps/api/scripts/backfill-first-customer-deliverables.ts:71` and `routes/admin/trust.ts:154`.) `routes/admin/index.ts`: `adminRoutes.route('/ai', aiToolUsageAdminRoutes);` after the kill-state mount, with a one-line comment naming this wave.

- [ ] **Step 5: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiToolUsageReport.test.ts src/routes/admin/aiToolUsage.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
ls apps/api/migrations/*.sql | sort | tail -1      # must be this wave's file
git add apps/api docs/superpowers/specs/ai-mcp/sql && git commit -m "feat(ai): platform-admin AI tool-usage report + created_at index + operator SQL (A-W01)"
```

---

### Task 9: Baseline document and measurements

**Files:**
- Create: `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md`

- [ ] **Step 1: Write the doc skeleton with the exact commands that fill it**

Sections, in order:

1. **What was measured and how** — the harness (`ai:tool-capture`), deny mode, why the proxy forces `ENABLE_TOOL_SEARCH`, `AI_SYSTEM_PROMPT_BASE` bytes, SDK/CLI versions, date, model.
2. **Tool search: on or off today?** — one table, rows = `chat`, `helper-basic`, `helper-standard`, `helper-extended`, `agent-full`, `script-builder`, `byo:<host>`; columns = `ENABLE_TOOL_SEARCH` (unset/on/off), ToolSearch seen (tool_use / result block / stderr), tools sent (proxy), deferred (proxy), turn-1 `input_tokens`, `cache_creation`, `cache_read`, turn-2 `cache_read` share, TTFT ms. Fill from `tool-capture.jsonl`:
   ```bash
   for s in chat helper-basic helper-standard helper-extended agent-full script-builder; do
     DATABASE_URL=… ANTHROPIC_API_KEY=… pnpm --filter @breeze/api ai:tool-capture -- --surface $s --turns 2 --out tool-capture.jsonl
     DATABASE_URL=… ANTHROPIC_API_KEY=… pnpm --filter @breeze/api ai:tool-capture -- --surface $s --proxy --tool-search on  --out tool-capture.jsonl
     DATABASE_URL=… ANTHROPIC_API_KEY=… pnpm --filter @breeze/api ai:tool-capture -- --surface $s --proxy --tool-search off --out tool-capture.jsonl
   done
   # BYO: any catalog endpoint Todd has credentials for
   DATABASE_URL=… ANTHROPIC_API_KEY=… pnpm --filter @breeze/api ai:tool-capture -- --surface chat --base-url https://<byo-host>/ --auth-token … --turns 2 --out tool-capture.jsonl
   ```
   Then the answer to the spec's question in one paragraph: where tool search is on, where it silently falls back, whether `tool_reference` was rejected by the BYO endpoint.
3. **Golden eval** — accuracy per surface (`chat`, `helper-standard`) and per tool-search mode (`default`, `on`, `off`), plus the Haiku 4.5 row (`--model claude-haiku-4-5-20251001`) that decides spec open decision 2. Misses table verbatim from `tool-eval-summary.md`.
4. **Hot/cold (90 days, EU + US)** — top 20 by executions per surface, the cold list (registered, never executed), and Helper vs chat split. Filled from the operator SQL run by Todd on both regions (or from `GET /api/v1/admin/ai/tool-usage?days=90` after the next deploy).
5. **Inputs to A-W04** — the proposed `alwaysLoad` set (≤ 15, from the hot list ∩ context tools), the Helper `onlyTools` recommendation, the BYO fallback decision, Haiku decision — each with the number that justifies it.
6. **Success-measure baselines** — the six numbers from the spec's "Success measures" section as measured today (first-turn input tokens; cache-read share turn 2+; eval accuracy; system prompt bytes; external `tools/list` bytes for a single key — `curl` the MCP server on a dev stack with an `ai:read` key; count of route modules without an `MCP_COVERAGE` entry = all of them until A-W06).

- [ ] **Step 2: Run everything you can, fill what you measured, mark the rest**

Every cell is either a measured number with the JSONL line it came from, or the literal `not run: <reason>` (no key / no BYO endpoint / no prod access). A row of `not run` is acceptable in the PR; a row of invented numbers is not. The PR body lists which sections Todd still needs to fill (prod SQL, BYO endpoint).

- [ ] **Step 3: Verification and PR**

```bash
cd apps/api && npx vitest run && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && pnpm lint
pnpm test:workflow-security
```

Branch `feature/6147-agent-tool-efficiency/wave-6148`, `Closes #6148`. PR body: which measurements ran, the secret Todd must create, the index migration name, and the `search_documentation` pending-declaration note (g57). One `/pr-review-toolkit:review-pr` round.

---

## Self-review against the spec

- "(a) Request-capture harness per surface …: tools sent, `input_tokens`, `cache_creation/read_input_tokens`, time-to-first-token, whether `tool_reference`/ToolSearch appears" → Tasks 1–4 (proxy = tools sent/deferred; observer = usage split, TTFT, ToolSearch); BYO endpoint via `--base-url`.
- "Answers 'is tool search already on, and where does it silently fall back or fail?'" → baseline §2, with the CLI-binary facts in Global Constraints.
- "(b) Golden tool-selection eval: ~60 real MSP prompts → expected tool(+action), scored on first-call accuracy and calls-to-answer; runs in CI as non-blocking report" → Tasks 5–7. **Scoped down:** calls-to-answer needs tool execution (a seeded actor + DB); deny mode measures first-call accuracy only. The index records this; A-W04's re-run adds calls-to-answer on a `wt-stack` if the number is needed.
- "(c) Hot/cold tool report from `ai_tool_executions` (90 days, both regions — read-only SQL Todd runs or a platform-admin report endpoint)" → Task 8 ships both (spec open decision 3 → both; the endpoint is what keeps pruning cheap later).
- "Output: a baseline doc committed next to this spec" → Task 9.
- Principle 1 ("measure before and after") → every later wave re-runs `ai:tool-eval` and `ai:tool-capture --surface chat --turns 2` and appends a dated row to the baseline doc.
