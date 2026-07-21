# Breeze AI for Office — Plan 2: Session Loop (routes, SDK wiring, tool round-trip)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the client AI loop: `/client-ai/sessions/*` routes behind Plan 1's auth + policy middleware, Claude Agent SDK wiring on the existing `streamingSessionManager` with a hard-allowlisted 9-tool workbook registry, the SSE tool round-trip protocol (tools execute in the Excel add-in, the server awaits the result), per-message cost/budget/rate-limit enforcement incl. per-user `client_ai_usage` buckets, the DLP seam stub at every payload chokepoint, and `ai.client_session.*` audit events.

**Architecture:** Client sessions are `ai_sessions` rows (`type='excel_client'`, `client_user_id` set — Plan 1 migration) driven by the existing `streamingSessionManager` singleton (`apps/api/src/services/streamingSessionManager.ts`), exactly like helper chat (`routes/helper/index.ts:359`) and the script builder (`routes/scriptAi.ts:195`): a synthetic org-scoped `AuthContext` + a custom `mcpServerFactory`. The custom MCP server registers ONLY the `CLIENT_TOOL_REGISTRY` workbook tools; their handlers do not execute anything server-side — they publish a `tool_request` event on the session's `SessionEventBus` and await `POST /client-ai/sessions/:id/tool-results` (the `waitForPlanApproval` in-memory-resolver shape from `services/aiAgent.ts:323`, not the DB-polling `waitForApproval` shape — no DB row needs polling because the resolver and the SDK subprocess live in the same process). The add-in consumes one persistent `GET /sessions/:id/events` SSE stream; internal `AiStreamEvent`s are translated to five pinned client-facing event names.

**Single-instance affinity (verified):** the SDK session is a child subprocess of the API process; `streamingSessionManager`'s session map, each session's `SessionEventBus`, and this plan's pending-tool-request map are all in-process memory. This is safe because (a) production runs exactly one `api` container per droplet (`docker-compose.yml` `api` service, no replicas), and (b) the technician `/ai` surface already depends on the same affinity (`streamingSessionManager` singleton + the separate `/sessions/:id/approve/:executionId` endpoint resolving in-memory state, `routes/ai.ts:589-622`). An in-memory pending map is therefore fine; no Redis indirection needed.

**Tech Stack:** Hono (+ `hono/streaming` `streamSSE`), `@anthropic-ai/claude-agent-sdk` (`tool`/`createSdkMcpServer`), Drizzle, Redis `rateLimiter`, Vitest.

**Spec:** docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md
**Depends on:** Plan 1 (2026-06-12-ai-for-office-1-foundation.md)
---

## Pinned cross-plan contracts this plan creates (Plans 3/4/5 depend on these — do not rename)

1. **Tool registry** — `apps/api/src/services/clientAiTools.ts` exports `CLIENT_TOOL_REGISTRY` with exactly 9 tools: `get_workbook_overview`, `read_selection`, `read_range`, `write_range`, `insert_formula`, `create_sheet`, `format_range`, `create_table`, `search_workbook`. The 5 write tools (`write_range`, `insert_formula`, `create_sheet`, `format_range`, `create_table`) are `mutating: true`. Reads auto-execute; mutating-tool approval happens **client-side in the add-in** (preview card). Policy `writeMode: 'readonly'` strips mutating tools from the model's toolset at session start AND the handler rejects them server-side if invoked anyway.
2. **Tool bridge** — `apps/api/src/services/clientAiToolBridge.ts`: handler publishes SSE event `tool_request` with payload `{ toolUseId, toolName, input, mutating }`, awaits `POST /client-ai/sessions/:id/tool-results` body `{ toolUseId, status: 'success'|'error'|'rejected', output }`. Timeouts: 60s non-mutating, 300s mutating → resolves with a timeout-error tool_result so the model can react (well inside the manager's 6-min `SDK_TURN_TIMEOUT_MS`, `streamingSessionManager.ts:37`).
3. **DLP seam stub** — `apps/api/src/services/clientAiDlp.ts` with the EXACT pinned signature (Plan 3 replaces internals, keeps the interface):
   ```ts
   export interface DlpRedactionEvent { rule: string; count: number; location: string }
   export interface DlpResult { action: 'allow' | 'block'; text?: string; cells?: unknown[][]; redactions: DlpRedactionEvent[]; blockReason?: string }
   export async function applyDlp(input: { text?: string; cells?: unknown[][]; dlpConfig: unknown; orgId: string }): Promise<DlpResult>
   ```
   Called at the chokepoints: (a) user message text before entering the SDK loop, (b) every tool_result payload (incl. `workbookContext.cells`) before returning to the model, (c) template bodies arrive inside the user message text in v1 (the add-in's template picker, Plan 5, inserts the template into the chat input), so chokepoint (a) covers them. Persistence stores `result.text` / `result.redactions` ONLY — never the raw input (Plan 3 Task 6 contract; the integration assertion lives in Task 11 here). Redactions are persisted in `ai_messages.content_blocks` as a `{ type: 'dlp_redactions', redactions }` block (`ai_messages` has no metadata column — `content_blocks` jsonb at `db/schema/ai.ts:64` is the structured-content slot).
4. **Routes** — under `/client-ai/sessions` behind Plan 1's `clientAiAuthMiddleware` + `requireClientAiEnabledMiddleware` (`apps/api/src/middleware/clientAiAuth.ts`): `POST /`, `POST /:id/messages`, `GET /:id/events` (SSE; bearer header AND `?token=` fallback), `POST /:id/tool-results`, `POST /:id/close`, `GET /:id`. Every session route checks `session.clientUserId === auth.clientUserId AND session.orgId === auth.orgId`.
5. **SSE event names** (Plan 5 mirrors this table; exported as `CLIENT_AI_SSE_EVENTS` in `apps/api/src/routes/clientAi/sse.ts`):

   | Client event | Source (internal bus event) | Payload |
   |---|---|---|
   | `message_delta` | `content_delta` | `{ text: string }` |
   | `tool_request` | `tool_request` (bridge) | `{ toolUseId, toolName, input, mutating }` |
   | `tool_completed` | `tool_completed` (handler) | `{ toolUseId, toolName, status: 'success'\|'error'\|'rejected'\|'timeout', redactions, blockReason }` |
   | `turn_complete` | `done` | `{ usage: { inputTokens, outputTokens, costCents } \| null }` |
   | `session_error` | `error` | `{ message: string }` |
   | `ping` | server keepalive timer | `{}` every 25s |

   Internal-only events (`message_start`, `message_end`, `tool_use_start`, `title_updated`, plan/approval events) are dropped by the translator — the add-in never sees technician concepts.
6. **Usage helper** — `recordClientUsage(orgId, clientUserId, delta)` in `apps/api/src/services/clientAiUsage.ts` upserting `(org_id, client_user_id, period, period_key)` daily+monthly buckets (mirrors `recordUsageFromSdkResult`'s upsert idiom, `aiCostTracker.ts:297-325`).
7. **Audit actions** — `ai.client_session.create` / `ai.client_session.message` / `ai.client_session.tool_execute` / `ai.client_session.tool_reject` / `ai.client_session.close`, written via `writeAuditEvent` with `actorType: 'user'`, `actorId: <portal_users.id>`, `actorEmail`, `details.principalType: 'portal_user'` — the exact convention Plan 1 established for `client_ai.auth.exchange` (there is no portal-specific actor type in `auditEvents.ts:8`; portal/client principals are `'user'` actors disambiguated by `principalType`).

## Design decisions (read before implementing)

- **Reuse `streamingSessionManager`, not a parallel manager** (spec §4 locked decision). Client sessions enter via `getOrCreate` with a custom `mcpServerFactory` (the `scriptAi.ts:211-215` pattern) and a synthetic org-scoped `AuthContext` (the helper pattern, `routes/helper/index.ts:133-160`). Consequences accepted and documented:
  - The shared `MAX_ACTIVE_SESSIONS = 200` LRU cap (`streamingSessionManager.ts:35`) now covers technician + helper + script-builder + client sessions together. Acceptable for v1; revisit if add-in concurrency approaches that.
  - `recordUsageFromSdkResult` (called by the background processor) also writes the **org-level** `ai_cost_usage` buckets and deducts partner billing credits — exactly what spec §8 wants for partner billing. Side effect: technician `aiBudgets` daily/monthly caps now also "see" client spend in `ai_cost_usage`. Accepted: it is real provider spend; the client product has its own budget knobs in `client_ai_org_policies`.
- **The technician `createSessionPreToolUse`/`createSessionPostToolUse` callbacks are deliberately NOT wired** into the client tool handlers: `createSessionPreToolUse` rejects any tool absent from `TOOL_TIERS` (`aiAgentSdk.ts:222-225`) — every workbook tool would be rejected as "Unknown tool" — and `createSessionPostToolUse` encodes technician persistence/guardrail semantics. The client handlers own their persistence, audit, and `tool_completed` events end-to-end (Task 6).
- **toolUseId correlation**: the background processor pushes the model's real `tool_use` block ids into `session.toolUseIdQueue` on `content_block_start` (`streamingSessionManager.ts:611`); the technician path drains it in `createSessionPostToolUse` (`aiAgentSdk.ts:640`). Since client handlers bypass that callback, the client handler shifts the queue itself at handler start (else the queue would grow for the session's lifetime), falling back to a minted UUID when empty. Same FIFO-ordering caveat as the existing technician path.
- **`getOrCreate` gets one new optional `options` param** (`{ injectApprovalModeInstructions?: boolean }`): client sessions must not get the technician "## Approval Mode" prompt suffix that `getOrCreate` appends when the org's `aiBudgets.approvalMode` ≠ `per_step` (`streamingSessionManager.ts:406-414`) — it talks about Tier-2 tools and `propose_action_plan`, pure RMM leakage. Default `true` preserves existing technician/helper/script-builder behavior.
- **`done` events now carry turn usage** so `turn_complete` can include it (pinned contract): `AiStreamEvent`'s `done` member gains an optional `usage` field, populated in the manager's `result` case. Additive; the technician web UI ignores unknown fields.
- **Per-user usage hook**: `ActiveSession` gains optional `recordExtraUsage` invoked once per turn in the `result` case, alongside (not instead of) `recordUsageFromSdkResult`. The route wires it to `recordClientUsage` for client sessions; technician sessions never set it.
- **POST /messages returns `202 { accepted: true }`** (JSON, not SSE) — the add-in consumes the persistent `GET /events` channel instead. This differs from the technician/helper routes (which stream the turn from the POST) because the tool round-trip requires a channel that outlives any single POST.
- **`GET /events` creates the active session if absent** (via the same `ensureActiveClientSession` helper as `/messages`), so the add-in can connect the stream right after session create with no race against the first message. Cost: an idle SDK subprocess per connected pane (evicted after 2h idle, `SESSION_IDLE_TIMEOUT_MS`).
- **`?token=` fallback is GET-only** in `clientAiAuthMiddleware` (EventSource cannot set headers). Documented caveat: query tokens can land in proxy access logs — the add-in (Plan 5) should prefer fetch-based SSE with the `Authorization` header; `?token=` exists as the EventSource fallback only.
- **DLP-stub test stability**: Task 1's stub test asserts only behavior that remains true after Plan 3 replaces the internals (clean payloads pass through unchanged, input matrix never mutated, empty-input shape) — fixtures chosen to match Plan 3's own Task 4 expectations, so merge order between Plans 2 and 3 doesn't matter.

## Verification notes for workers

- Node pin: prefix every pnpm/vitest/tsc command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- The full api `vitest run` is known-flaky in parallel — verify with the affected files only; trust CI for the full sweep.
- `npx tsc --noEmit` has pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts` — not yours.
- No new migrations in this plan (Plan 1 shipped all schema, including `client_ai_usage` and the `ai_sessions.client_user_id` constraints). No RLS allowlist changes.
- Plan 1 must be merged (or its branch checked out underneath) — this plan imports `clientAiAuthMiddleware`, `requireClientAiEnabledMiddleware`, `ClientAiOrgPolicy`, `getOrgPolicy`, `clientAiUsage` (Drizzle), and edits `routes/clientAi/index.ts` + `middleware/clientAiAuth.ts` + `routes/clientAi/schemas.ts`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/services/clientAiDlp.ts` (+ `clientAiDlp.stub.test.ts`) | Create | Pinned `applyDlp` seam — v1 passthrough stub (Plan 3 replaces internals) |
| `packages/shared/src/types/ai.ts` | Modify (~line 103-119) | `AiStreamEvent`: add `tool_request`/`tool_completed` members; `done` gains optional `usage` |
| `apps/api/src/services/streamingSessionManager.ts` | Modify | `ActiveSession` client fields (`clientWriteMode`, `clientDlpConfig`, `recordExtraUsage`), `getOrCreate` `options` param, usage-bearing `done` |
| `apps/api/src/services/streamingSessionManager.clientLoop.test.ts` | Create | Tests for the three manager changes (mocked SDK) |
| `apps/api/src/services/clientAiUsage.ts` (+ `.test.ts`) | Create | `recordClientUsage` upserts, period keys, `checkClientBudget`, `getRemainingClientBudgetUsd` |
| `apps/api/src/services/aiCostTracker.ts` | Modify (line 23) | `export` the existing `checkBillingCredits` |
| `apps/api/src/services/clientAiToolBridge.ts` (+ `.test.ts`) | Create | In-memory pending map, `requestClientToolExecution`, `resolveClientToolResult`, `failPendingForSession`, timeouts |
| `apps/api/src/services/clientAiTools.ts` | Create | `CLIENT_TOOL_REGISTRY` (9 tools), MCP server factory, handler (write-mode gate, DLP chokepoint b, persistence, audit, `tool_completed`) |
| `apps/api/src/services/clientAiTools.registry.test.ts` | Create | Hard-isolation test vs technician registry |
| `apps/api/src/services/clientAiTools.handler.test.ts` | Create | Handler behavior tests |
| `apps/api/src/services/clientAiSessions.ts` (+ `.test.ts`) | Create | Excel system prompt, synthetic `AuthContext`, client rate limits, title helper |
| `apps/api/src/middleware/clientAiAuth.ts` | Modify | GET-only `?token=` query fallback for SSE |
| `apps/api/src/middleware/clientAiAuth.queryToken.test.ts` | Create | Query-token fallback tests |
| `apps/api/src/routes/clientAi/sse.ts` (+ `sse.test.ts`) | Create | `CLIENT_AI_SSE_EVENTS`, `toClientSseEvent` bus→client translation |
| `apps/api/src/routes/clientAi/schemas.ts` | Modify (append) | `sendClientMessageSchema`, `workbookContextSchema`, `clientToolResultSchema` |
| `apps/api/src/routes/clientAi/sessions.ts` | Create | All six session routes + `ensureActiveClientSession` + audit helper |
| `apps/api/src/routes/clientAi/sessions.lifecycle.test.ts` | Create | create / get / close route tests |
| `apps/api/src/routes/clientAi/sessions.messages.test.ts` | Create | messages route tests incl. the redact-before-log contract assertion (Plan 3 Task 6 note) |
| `apps/api/src/routes/clientAi/sessions.events-toolresults.test.ts` | Create | SSE events + tool-results route tests |
| `apps/api/src/routes/clientAi/index.ts` | Modify | Mount `/sessions` |

---

### Task 1: DLP seam — passthrough stub (pinned interface)

Plan 3 owns the real engine and pins this exact interface (its plan doc, "Pinned cross-plan contract" section). If Plan 3 has somehow already landed, **skip this task entirely** — the file and interface will already exist.

**Files:**
- Create: apps/api/src/services/clientAiDlp.ts
- Create: apps/api/src/services/clientAiDlp.stub.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/clientAiDlp.stub.test.ts`

Only Plan-3-stable assertions (clean payloads, no-mutation, empty-input shape) so this file keeps passing after Plan 3 replaces the internals:

```ts
import { describe, it, expect } from 'vitest';
import { applyDlp } from './clientAiDlp';

const ORG = '0a1b2c3d-1111-4222-8333-444455556666';

describe('applyDlp seam (Plan-2 stub — assertions stay valid against the Plan-3 engine)', () => {
  it('passes clean text through unchanged', async () => {
    const r = await applyDlp({ text: 'sum column B please', dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({ action: 'allow', text: 'sum column B please', redactions: [] });
  });

  it('passes clean cells through with equal values and does not mutate the input', async () => {
    const cells = [['Name', 'Qty'], ['Widget', 12]];
    const r = await applyDlp({ cells, dlpConfig: {}, orgId: ORG });
    expect(r.action).toBe('allow');
    expect(r.cells).toEqual(cells);
    expect(r.redactions).toEqual([]);
    expect(cells).toEqual([['Name', 'Qty'], ['Widget', 12]]); // never mutated
  });

  it('handles empty input (no text, no cells)', async () => {
    const r = await applyDlp({ dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({ action: 'allow', redactions: [] });
  });

  it('scans text and cells in the same call', async () => {
    const r = await applyDlp({ text: 'hello', cells: [['x']], dlpConfig: {}, orgId: ORG });
    expect(r.text).toBe('hello');
    expect(r.cells).toEqual([['x']]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiDlp.stub.test.ts
```

- [ ] **Step 3: Create `apps/api/src/services/clientAiDlp.ts`**

```ts
/**
 * Client AI DLP / redaction seam (spec §6) — v1 PASSTHROUGH STUB.
 *
 * Plan 3 (docs/superpowers/plans/ai-mcp/2026-06-12-ai-for-office-3-dlp.md) replaces
 * the internals with the real detector/redaction engine. The interface below
 * is PINNED across plans — do not change it here.
 *
 * Call sites (owned by Plan 2 — the chokepoints; spec §6 "nothing reaches the
 * model un-scanned"):
 *  (a) user message text — routes/clientAi/sessions.ts POST /:id/messages
 *  (b) every tool_result payload + workbookContext cells —
 *      services/clientAiTools.ts (applyDlpToToolOutput) and the messages route
 *  (c) template bodies — arrive inside (a) in v1 (the add-in inserts templates
 *      into the chat input).
 *
 * Persistence contract: callers store result.text / result.redactions, never
 * the raw input (Plan 3 Task 6 ships the unit-level proof; Plan 2's
 * sessions.messages.test.ts carries the integration assertion).
 *
 * `input.orgId` and `input.dlpConfig` are unused by the stub but pinned in the
 * signature (Plan 3's engine parses dlpConfig itself; orgId is reserved for
 * per-org compiled-rule caching/telemetry).
 */

export interface DlpRedactionEvent {
  rule: string;
  count: number;
  location: string;
}

export interface DlpResult {
  action: 'allow' | 'block';
  text?: string;
  cells?: unknown[][];
  redactions: DlpRedactionEvent[];
  blockReason?: string;
}

export async function applyDlp(input: {
  text?: string;
  cells?: unknown[][];
  dlpConfig: unknown;
  orgId: string;
}): Promise<DlpResult> {
  const result: DlpResult = { action: 'allow', redactions: [] };
  if (typeof input.text === 'string') result.text = input.text;
  if (input.cells !== undefined) {
    // Row-copied like the Plan-3 engine — callers may rely on a fresh matrix.
    result.cells = input.cells.map((row) => [...(row ?? [])]);
  }
  return result;
}
```

- [ ] **Step 4: Run, expect PASS** (4 tests; same command as Step 2)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiDlp.ts apps/api/src/services/clientAiDlp.stub.test.ts
git commit -m "feat(client-ai): applyDlp passthrough seam (pinned interface for Plan 3)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Stream-event types + streamingSessionManager client hooks (TDD)

Three additive changes to the shared loop, verified with a mocked SDK:
1. `AiStreamEvent` gains `tool_request` / `tool_completed` members; `done` gains optional `usage`.
2. `ActiveSession` gains `clientWriteMode` / `clientDlpConfig` / `recordExtraUsage` optional fields.
3. `getOrCreate` gains `options?: { injectApprovalModeInstructions?: boolean }`; the `result` case publishes usage on `done` and invokes `recordExtraUsage`.

**Files:**
- Modify: packages/shared/src/types/ai.ts (~lines 103-119)
- Modify: apps/api/src/services/streamingSessionManager.ts
- Create: apps/api/src/services/streamingSessionManager.clientLoop.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/streamingSessionManager.clientLoop.test.ts`

```ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { queryMock, recordUsageMock, capturedQueryArgs } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  recordUsageMock: vi.fn(() => Promise.resolve()),
  capturedQueryArgs: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

vi.mock('../db', () => ({
  db: {
    // Only DB read on this path: the aiBudgets approvalMode lookup
    // (streamingSessionManager.getOrCreate). Return auto_approve so the
    // approval-mode prompt injection is observable.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ approvalMode: 'auto_approve' }])),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./aiCostTracker', () => ({ recordUsageFromSdkResult: recordUsageMock }));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
}));
vi.mock('./aiToolOutput', () => ({ redactAiToolOutputText: (s: string) => s }));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

import { StreamingSessionManager } from './streamingSessionManager';
import type { AuthContext } from '../middleware/auth';
import type { AiStreamEvent } from '@breeze/shared/types/ai';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';

const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null,
  model: 'claude-sonnet-4-5-20250929',
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};

const AUTH = {
  orgId: ORG,
  scope: 'organization',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'finance.user@contoso.com' },
} as unknown as AuthContext;

const RESULT_MSG = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.03,
  usage: { input_tokens: 100, output_tokens: 50 },
  num_turns: 1,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** queryMock returns an async-iterable Query stub gated on `gate`. */
function mockSdkQuery(messages: unknown[], gate: Promise<void>) {
  queryMock.mockImplementation((args: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedQueryArgs.push(args);
    return {
      async *[Symbol.asyncIterator]() {
        await gate;
        yield* messages as never[];
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    };
  });
}

let manager: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  capturedQueryArgs.length = 0;
  manager = new StreamingSessionManager();
});

afterEach(() => {
  manager.shutdown();
});

describe('getOrCreate — approval-mode prompt injection option', () => {
  it('injects the technician approval-mode suffix by default (existing behavior)', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate('sess-default', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined);
    await session.processorPromise;

    expect(capturedQueryArgs[0]!.options.systemPrompt).toContain('BASE PROMPT');
    expect(capturedQueryArgs[0]!.options.systemPrompt).toContain('## Approval Mode');
  });

  it('suppresses the suffix when injectApprovalModeInstructions is false (client sessions)', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-client', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      undefined, undefined, { injectApprovalModeInstructions: false },
    );
    await session.processorPromise;

    expect(capturedQueryArgs[0]!.options.systemPrompt).toBe('BASE PROMPT');
  });
});

describe('result handling — usage-bearing done + recordExtraUsage', () => {
  it('publishes done with usage and invokes recordExtraUsage with the turn cost', async () => {
    const gate = deferred();
    mockSdkQuery([RESULT_MSG], gate.promise);

    const session = await manager.getOrCreate(
      'sess-usage', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      undefined, undefined, { injectApprovalModeInstructions: false },
    );

    const recordExtraUsage = vi.fn(() => Promise.resolve());
    session.recordExtraUsage = recordExtraUsage;
    session.clientWriteMode = 'readwrite'; // type-level: field exists on ActiveSession

    const events: AiStreamEvent[] = [];
    const sub = session.eventBus.subscribe('test-sub');
    const consumer = (async () => {
      for await (const e of sub) events.push(e);
    })();

    gate.resolve();
    await session.processorPromise;
    await consumer;

    // 0.03 USD → 3 cents (recordUsageFromSdkResult rounding, aiCostTracker.ts:272)
    expect(recordExtraUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 50, costCents: 3 });
    expect(recordUsageMock).toHaveBeenCalled(); // org-level recording still happens
    expect(events).toContainEqual({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 50, costCents: 3 },
    });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/streamingSessionManager.clientLoop.test.ts
```

Expected: type/compile failure on the `options` 9th argument and `recordExtraUsage`/`clientWriteMode` fields, and the default-injection test passing while the other two fail.

- [ ] **Step 3: Edit `packages/shared/src/types/ai.ts`** — in the `AiStreamEvent` union (lines 103-119), replace the final member `| { type: 'done' };` with:

```ts
  // ── AI for Office (client sessions) — published by the client tool bridge/handlers ──
  | { type: 'tool_request'; toolUseId: string; toolName: string; input: Record<string, unknown>; mutating: boolean }
  | {
      type: 'tool_completed';
      toolUseId: string;
      toolName: string;
      status: 'success' | 'error' | 'rejected' | 'timeout';
      redactions?: Array<{ rule: string; count: number; location: string }>;
      blockReason?: string;
    }
  // `usage` is set by the streaming manager's result case so client surfaces
  // can render turn cost (turn_complete). Technician UI ignores it.
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number; costCents: number } };
```

- [ ] **Step 4: Edit `apps/api/src/services/streamingSessionManager.ts`** — four edits:

**(a)** In `interface ActiveSession`, after the `planApprovalResolver` field (line ~259), add:

```ts
  // ── AI for Office (client sessions) — set by routes/clientAi/sessions.ts ──
  /** Client org policy writeMode, refreshed on every client message; the
   *  client tool handler rejects mutating tools when 'readonly'. */
  clientWriteMode?: 'readonly' | 'readwrite';
  /** client_ai_org_policies.dlp_config (jsonb, unknown — the DLP engine parses
   *  it itself), refreshed on every client message. */
  clientDlpConfig?: unknown;
  /** Extra per-turn usage recorder invoked in the result case alongside
   *  recordUsageFromSdkResult (client sessions: per-user client_ai_usage buckets). */
  recordExtraUsage?: (usage: { inputTokens: number; outputTokens: number; costCents: number }) => Promise<void>;
```

**(b)** In `getOrCreate`, add a final optional parameter after `mcpServerFactory` (line ~313):

```ts
    options?: { injectApprovalModeInstructions?: boolean },
```

**(c)** Gate the approval-mode prompt injection (line ~407). Replace:

```ts
    if (approvalMode !== 'per_step') {
```

with:

```ts
    if (options?.injectApprovalModeInstructions !== false && approvalMode !== 'per_step') {
```

**(d)** In the `case 'result':` block, replace the final two statements of the non-early-return path (currently, after the success/else usage-recording branches):

```ts
            // Signal this turn is done, but DON'T close the event bus —
            // session stays alive for follow-up messages
            session.eventBus.publish({ type: 'done' });
            session.state = 'idle';
            break;
```

with:

```ts
            // Per-user usage hook (AI for Office): runs alongside the org-level
            // recordUsageFromSdkResult above, never instead of it.
            const turnCostCents = Math.round(usageData.total_cost_usd * 100 * 100) / 100;
            if (session.recordExtraUsage) {
              try {
                await session.recordExtraUsage({
                  inputTokens: usageData.usage.input_tokens,
                  outputTokens: usageData.usage.output_tokens,
                  costCents: turnCostCents,
                });
              } catch (err) {
                captureException(err);
                console.error('[StreamingSessionManager] recordExtraUsage failed:', err);
              }
            }

            // Signal this turn is done, but DON'T close the event bus —
            // session stays alive for follow-up messages. Carries usage so
            // client surfaces can render turn cost (turn_complete).
            session.eventBus.publish({
              type: 'done',
              usage: {
                inputTokens: usageData.usage.input_tokens,
                outputTokens: usageData.usage.output_tokens,
                costCents: turnCostCents,
              },
            });
            session.state = 'idle';
            break;
```

(The early `!orgId` branch at the top of the case keeps its plain `{ type: 'done' }` — `usage` is optional.)

- [ ] **Step 5: Run, expect PASS** (3 tests; same command as Step 2). Then typecheck both packages:

```bash
cd /Users/toddhebebrand/breeze/packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm typecheck
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

Expected: clean (modulo the two pre-existing test-file errors). Also run the existing manager security suite to confirm no regression:

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/streamingSessionManager.security.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/ai.ts apps/api/src/services/streamingSessionManager.ts apps/api/src/services/streamingSessionManager.clientLoop.test.ts
git commit -m "feat(client-ai): client hooks in streaming session loop — usage-bearing done, recordExtraUsage, prompt-injection opt-out" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: clientAiUsage service + export checkBillingCredits (TDD)

Per-user metering buckets (spec §8) keyed `(org_id, client_user_id, period, period_key)` on Plan 1's `client_ai_usage` table, mirroring `recordUsageFromSdkResult`'s onConflictDoUpdate idiom (`aiCostTracker.ts:297-325`). Budget checks SUM across the org's users. Also makes `checkBillingCredits` importable (it is currently module-private at `aiCostTracker.ts:23`; `checkBudget` calls it internally, but the client preflight needs the credits check WITHOUT the technician `aiBudgets` gating that `checkBudget` adds).

**Files:**
- Create: apps/api/src/services/clientAiUsage.ts
- Create: apps/api/src/services/clientAiUsage.test.ts
- Modify: apps/api/src/services/aiCostTracker.ts (line 23: add `export`)

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/clientAiUsage.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbInsertMock, dbSelectMock } = vi.hoisted(() => ({
  dbInsertMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { insert: dbInsertMock, select: dbSelectMock },
}));

import {
  clientUsageDailyKey,
  clientUsageMonthlyKey,
  recordClientUsage,
  getOrgPeriodCostCents,
  checkClientBudget,
  getRemainingClientBudgetUsd,
} from './clientAiUsage';
import { defaultClientAiPolicy } from './clientAiPolicy';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const USER = 'beefbeef-1111-4222-8333-444455556666';

function setupInsert() {
  const onConflict = vi.fn(() => Promise.resolve());
  const values = vi.fn(() => ({ onConflictDoUpdate: onConflict }));
  dbInsertMock.mockImplementation(() => ({ values }));
  return { values, onConflict };
}

function setupSumSelect(totalCents: number) {
  dbSelectMock.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([{ total: totalCents }])),
    })),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('period keys (UTC, mirrors aiCostTracker)', () => {
  it('formats daily and monthly keys', () => {
    const d = new Date(Date.UTC(2026, 5, 12, 23, 59));
    expect(clientUsageDailyKey(d)).toBe('2026-06-12');
    expect(clientUsageMonthlyKey(d)).toBe('2026-06');
  });
});

describe('recordClientUsage', () => {
  it('upserts a daily AND a monthly bucket keyed by (org, user, period, periodKey)', async () => {
    const { values, onConflict } = setupInsert();
    await recordClientUsage(ORG, USER, { inputTokens: 100, outputTokens: 50, costCents: 3, messageCount: 1 });

    expect(dbInsertMock).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orgId: ORG,
      clientUserId: USER,
      period: 'daily',
      periodKey: clientUsageDailyKey(),
      inputTokens: 100,
      outputTokens: 50,
      totalCostCents: 3,
      messageCount: 1,
      sessionCount: 0,
    }));
    expect(values).toHaveBeenNthCalledWith(2, expect.objectContaining({
      period: 'monthly',
      periodKey: clientUsageMonthlyKey(),
    }));
    expect(onConflict).toHaveBeenCalledTimes(2);
  });

  it('defaults absent delta fields to 0 (sessionCount-only bump on create)', async () => {
    const { values } = setupInsert();
    await recordClientUsage(ORG, USER, { sessionCount: 1 });
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionCount: 1, messageCount: 0, inputTokens: 0, outputTokens: 0, totalCostCents: 0,
    }));
  });

  it('a failed daily upsert does not prevent the monthly upsert (additive counters)', async () => {
    const onConflict = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    dbInsertMock.mockImplementation(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: onConflict })) }));
    await expect(recordClientUsage(ORG, USER, { messageCount: 1 })).resolves.toBeUndefined();
    expect(dbInsertMock).toHaveBeenCalledTimes(2);
  });
});

describe('getOrgPeriodCostCents', () => {
  it('returns the SUM across the org users for the bucket', async () => {
    setupSumSelect(642.5);
    await expect(getOrgPeriodCostCents(ORG, 'daily', '2026-06-12')).resolves.toBe(642.5);
  });

  it('returns 0 when the bucket has no rows', async () => {
    dbSelectMock.mockImplementation(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
    }));
    await expect(getOrgPeriodCostCents(ORG, 'daily', '2026-06-12')).resolves.toBe(0);
  });
});

describe('checkClientBudget', () => {
  it('returns null when no budgets configured (no DB reads)', async () => {
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true };
    await expect(checkClientBudget(policy)).resolves.toBeNull();
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('rejects when daily spend reaches the cap', async () => {
    setupSumSelect(500);
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true, dailyBudgetCents: 500 };
    const msg = await checkClientBudget(policy);
    expect(msg).toContain('Daily AI budget');
  });

  it('rejects when monthly spend reaches the cap', async () => {
    setupSumSelect(10_000);
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true, monthlyBudgetCents: 10_000 };
    const msg = await checkClientBudget(policy);
    expect(msg).toContain('Monthly AI budget');
  });

  it('allows when under both caps', async () => {
    setupSumSelect(10);
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true, dailyBudgetCents: 500, monthlyBudgetCents: 10_000 };
    await expect(checkClientBudget(policy)).resolves.toBeNull();
  });
});

describe('getRemainingClientBudgetUsd', () => {
  it('returns undefined when unlimited', async () => {
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true };
    await expect(getRemainingClientBudgetUsd(policy)).resolves.toBeUndefined();
  });

  it('returns the tighter of daily/monthly remaining, in USD', async () => {
    setupSumSelect(400); // both buckets report 400c spent
    const policy = {
      ...defaultClientAiPolicy(ORG), enabled: true,
      dailyBudgetCents: 500,    // 100c remaining
      monthlyBudgetCents: 10_000, // 9600c remaining
    };
    await expect(getRemainingClientBudgetUsd(policy)).resolves.toBe(1); // $1.00
  });

  it('clamps at 0 when overspent', async () => {
    setupSumSelect(900);
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true, dailyBudgetCents: 500 };
    await expect(getRemainingClientBudgetUsd(policy)).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiUsage.test.ts
```

- [ ] **Step 3: Create `apps/api/src/services/clientAiUsage.ts`**

```ts
/**
 * AI for Office — per-user metering buckets (spec §8).
 *
 * client_ai_usage (Plan 1 migration; RLS shape 1) mirrors the ai_cost_usage
 * daily/monthly bucket pattern PLUS a client_user_id dimension so the MSP can
 * invoice per end-user. recordClientUsage runs ALONGSIDE the org-level
 * recordUsageFromSdkResult (which keeps partner billing-credit deduction and
 * ai_cost_usage flowing unchanged) — wired via ActiveSession.recordExtraUsage.
 *
 * Budget semantics (spec §4/§7): org daily/monthly caps live in
 * client_ai_org_policies; spend is the SUM of this table's org buckets across
 * users. Upserts mirror aiCostTracker.ts:297-325 (no transaction — additive
 * counters, partial failure acceptable).
 *
 * Callers must be inside a DB access context that can see the org's rows
 * (request path: clientAiAuthMiddleware org scope; background path: the
 * recordExtraUsage closure opens its own org-scoped context).
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { clientAiUsage } from '../db/schema/clientAi';
import type { ClientAiOrgPolicy } from './clientAiPolicy';

export function clientUsageDailyKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

export function clientUsageMonthlyKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface ClientUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  costCents?: number;
  messageCount?: number;
  sessionCount?: number;
}

export async function recordClientUsage(
  orgId: string,
  clientUserId: string,
  delta: ClientUsageDelta,
): Promise<void> {
  const now = new Date();
  const inputTokens = delta.inputTokens ?? 0;
  const outputTokens = delta.outputTokens ?? 0;
  const costCents = delta.costCents ?? 0;
  const messageCount = delta.messageCount ?? 0;
  const sessionCount = delta.sessionCount ?? 0;

  for (const [period, periodKey] of [
    ['daily', clientUsageDailyKey(now)],
    ['monthly', clientUsageMonthlyKey(now)],
  ] as const) {
    try {
      await db
        .insert(clientAiUsage)
        .values({
          orgId,
          clientUserId,
          period,
          periodKey,
          inputTokens,
          outputTokens,
          totalCostCents: costCents,
          sessionCount,
          messageCount,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            clientAiUsage.orgId,
            clientAiUsage.clientUserId,
            clientAiUsage.period,
            clientAiUsage.periodKey,
          ],
          set: {
            inputTokens: sql`${clientAiUsage.inputTokens} + ${inputTokens}`,
            outputTokens: sql`${clientAiUsage.outputTokens} + ${outputTokens}`,
            totalCostCents: sql`${clientAiUsage.totalCostCents} + ${costCents}`,
            sessionCount: sql`${clientAiUsage.sessionCount} + ${sessionCount}`,
            messageCount: sql`${clientAiUsage.messageCount} + ${messageCount}`,
            updatedAt: now,
          },
        });
    } catch (err) {
      console.error(
        `[client-ai] Failed to update ${period} usage bucket for org=${orgId}, user=${clientUserId}:`,
        err,
      );
      // Continue to attempt the other period (aiCostTracker convention).
    }
  }
}

/** Org-wide spend for a bucket: SUM across all the org's client users. */
export async function getOrgPeriodCostCents(
  orgId: string,
  period: 'daily' | 'monthly',
  periodKey: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${clientAiUsage.totalCostCents}), 0)` })
    .from(clientAiUsage)
    .where(
      and(
        eq(clientAiUsage.orgId, orgId),
        eq(clientAiUsage.period, period),
        eq(clientAiUsage.periodKey, periodKey),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Pre-flight org budget gate (spec §4). Returns a user-readable rejection
 * reason or null. NULL budget = unlimited (no DB read for that period).
 */
export async function checkClientBudget(policy: ClientAiOrgPolicy): Promise<string | null> {
  const now = new Date();

  if (policy.dailyBudgetCents != null) {
    const spent = await getOrgPeriodCostCents(policy.orgId, 'daily', clientUsageDailyKey(now));
    if (spent >= policy.dailyBudgetCents) {
      return `Daily AI budget for your organization has been reached ($${(policy.dailyBudgetCents / 100).toFixed(2)}). Try again tomorrow or contact your IT provider.`;
    }
  }

  if (policy.monthlyBudgetCents != null) {
    const spent = await getOrgPeriodCostCents(policy.orgId, 'monthly', clientUsageMonthlyKey(now));
    if (spent >= policy.monthlyBudgetCents) {
      return `Monthly AI budget for your organization has been reached ($${(policy.monthlyBudgetCents / 100).toFixed(2)}). Contact your IT provider to raise it.`;
    }
  }

  return null;
}

/**
 * Remaining budget in USD for the SDK's maxBudgetUsd hard stop — the tighter
 * of the configured daily/monthly remainders. undefined = unlimited.
 */
export async function getRemainingClientBudgetUsd(
  policy: ClientAiOrgPolicy,
): Promise<number | undefined> {
  const now = new Date();
  const remainders: number[] = [];

  if (policy.dailyBudgetCents != null) {
    const spent = await getOrgPeriodCostCents(policy.orgId, 'daily', clientUsageDailyKey(now));
    remainders.push(Math.max(0, policy.dailyBudgetCents - spent));
  }
  if (policy.monthlyBudgetCents != null) {
    const spent = await getOrgPeriodCostCents(policy.orgId, 'monthly', clientUsageMonthlyKey(now));
    remainders.push(Math.max(0, policy.monthlyBudgetCents - spent));
  }

  if (remainders.length === 0) return undefined;
  return Math.min(...remainders) / 100;
}
```

- [ ] **Step 4: Export `checkBillingCredits`** — in `apps/api/src/services/aiCostTracker.ts` line 23, change:

```ts
async function checkBillingCredits(orgId: string): Promise<string | null> {
```

to:

```ts
export async function checkBillingCredits(orgId: string): Promise<string | null> {
```

(No other change. The client preflight calls it directly because `checkBudget` couples it to the technician `aiBudgets`/`ai_cost_usage` gating, which must not apply to client sessions — spec §7 keeps the two products' knobs separate.)

- [ ] **Step 5: Run, expect PASS** (13 tests; same command as Step 2). Then:

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/clientAiUsage.ts apps/api/src/services/clientAiUsage.test.ts apps/api/src/services/aiCostTracker.ts
git commit -m "feat(client-ai): per-user client_ai_usage buckets + client budget checks; export checkBillingCredits" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Client tool bridge — pending map + timeouts (TDD)

The round-trip core: handler publishes `tool_request` on the session bus and awaits an in-memory resolver keyed by `toolUseId` (the `waitForPlanApproval` shape, `aiAgent.ts:323-345`). `POST /tool-results` resolves it; timeouts resolve with a timeout-error result so the model can react.

**Files:**
- Create: apps/api/src/services/clientAiToolBridge.ts
- Create: apps/api/src/services/clientAiToolBridge.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/clientAiToolBridge.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requestClientToolExecution,
  resolveClientToolResult,
  failPendingForSession,
  CLIENT_TOOL_TIMEOUT_MS,
  CLIENT_MUTATING_TOOL_TIMEOUT_MS,
  _pendingCountForTests,
} from './clientAiToolBridge';
import type { ActiveSession } from './streamingSessionManager';

function fakeSession(id: string) {
  const publish = vi.fn();
  return {
    session: { breezeSessionId: id, eventBus: { publish } } as unknown as ActiveSession,
    publish,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain anything a test left pending so timers don't leak across tests.
  failPendingForSession('sess-1');
  failPendingForSession('sess-2');
  vi.useRealTimers();
});

describe('requestClientToolExecution', () => {
  it('publishes the pinned tool_request event payload and resolves on resolveClientToolResult', async () => {
    const { session, publish } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-1', 'read_range', { address: 'A1:B2' }, false);

    expect(publish).toHaveBeenCalledWith({
      type: 'tool_request',
      toolUseId: 'tu-1',
      toolName: 'read_range',
      input: { address: 'A1:B2' },
      mutating: false,
    });

    expect(resolveClientToolResult('sess-1', 'tu-1', { status: 'success', output: { cells: [[1]] } })).toBe(true);
    await expect(p).resolves.toEqual({ status: 'success', output: { cells: [[1]] } });
    expect(_pendingCountForTests()).toBe(0);
  });

  it('rejects resolution from a different session (cross-session guard)', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-2', 'read_selection', {}, false);

    expect(resolveClientToolResult('sess-2', 'tu-2', { status: 'success', output: null })).toBe(false);
    expect(resolveClientToolResult('sess-1', 'tu-2', { status: 'error', output: { error: 'x' } })).toBe(true);
    await expect(p).resolves.toEqual({ status: 'error', output: { error: 'x' } });
  });

  it('returns false for unknown toolUseIds and for double resolution', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-3', 'read_selection', {}, false);
    expect(resolveClientToolResult('sess-1', 'nope', { status: 'success', output: null })).toBe(false);
    expect(resolveClientToolResult('sess-1', 'tu-3', { status: 'success', output: 1 })).toBe(true);
    expect(resolveClientToolResult('sess-1', 'tu-3', { status: 'success', output: 2 })).toBe(false);
    await p;
  });

  it('times out non-mutating tools after 60s with a timeout-error result', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-4', 'read_range', { address: 'A1' }, false);

    vi.advanceTimersByTime(CLIENT_TOOL_TIMEOUT_MS - 1);
    expect(_pendingCountForTests()).toBe(1);
    vi.advanceTimersByTime(1);

    const result = await p;
    expect(result.status).toBe('timeout');
    expect(JSON.stringify(result.output)).toContain('timed out');
    expect(_pendingCountForTests()).toBe(0);
  });

  it('gives mutating tools the 300s window (pending write approval in the task pane)', async () => {
    const { session } = fakeSession('sess-1');
    const p = requestClientToolExecution(session, 'tu-5', 'write_range', { address: 'A1', cells: [[1]] }, true);

    vi.advanceTimersByTime(CLIENT_TOOL_TIMEOUT_MS); // 60s: still pending
    expect(_pendingCountForTests()).toBe(1);
    vi.advanceTimersByTime(CLIENT_MUTATING_TOOL_TIMEOUT_MS - CLIENT_TOOL_TIMEOUT_MS);
    await expect(p).resolves.toMatchObject({ status: 'timeout' });
  });
});

describe('failPendingForSession', () => {
  it('fails every pending request of the session (and only that session)', async () => {
    const a = fakeSession('sess-1');
    const b = fakeSession('sess-2');
    const p1 = requestClientToolExecution(a.session, 'tu-6', 'read_range', {}, false);
    const p2 = requestClientToolExecution(b.session, 'tu-7', 'read_range', {}, false);

    expect(failPendingForSession('sess-1', 'session_closed')).toBe(1);
    await expect(p1).resolves.toEqual({ status: 'error', output: { error: 'session_closed' } });
    expect(_pendingCountForTests()).toBe(1);

    expect(resolveClientToolResult('sess-2', 'tu-7', { status: 'success', output: null })).toBe(true);
    await p2;
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiToolBridge.test.ts
```

- [ ] **Step 3: Create `apps/api/src/services/clientAiToolBridge.ts`**

```ts
/**
 * AI for Office — client-side tool execution bridge (spec §5).
 *
 * Office.js only runs inside Excel, so workbook tools execute IN THE ADD-IN:
 *   1. The MCP tool handler (services/clientAiTools.ts) calls
 *      requestClientToolExecution → publishes a `tool_request` SSE event on
 *      the session's SessionEventBus and parks an in-memory resolver here.
 *   2. The add-in executes via Office.js (write tools behind the user's
 *      Apply/Reject preview card) and posts
 *      POST /client-ai/sessions/:id/tool-results { toolUseId, status, output }.
 *   3. The route calls resolveClientToolResult → the handler resumes and the
 *      SDK loop continues.
 *
 * Timeouts resolve (never reject) with a timeout-shaped result so the model is
 * told and can react (e.g. the user closed Excel). 60s reads / 300s mutating —
 * the mutating window covers the in-pane approval wait and stays inside the
 * manager's 6-min SDK_TURN_TIMEOUT_MS (streamingSessionManager.ts:37).
 *
 * The pending map is in-process memory by design: the SDK session is a child
 * subprocess of this API instance and production runs a single api container
 * per region — the same affinity the technician /ai approval endpoint already
 * relies on. This is the waitForPlanApproval in-memory-resolver shape
 * (services/aiAgent.ts:323), not the DB-polling waitForApproval shape.
 */

import type { ActiveSession } from './streamingSessionManager';

export const CLIENT_TOOL_TIMEOUT_MS = 60_000;
export const CLIENT_MUTATING_TOOL_TIMEOUT_MS = 300_000;

export interface ClientToolResult {
  status: 'success' | 'error' | 'rejected' | 'timeout';
  output: unknown;
}

interface PendingClientToolRequest {
  sessionId: string;
  toolName: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ClientToolResult) => void;
}

const pending = new Map<string, PendingClientToolRequest>();

export function requestClientToolExecution(
  session: ActiveSession,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  mutating: boolean,
): Promise<ClientToolResult> {
  return new Promise<ClientToolResult>((resolve) => {
    const timeoutMs = mutating ? CLIENT_MUTATING_TOOL_TIMEOUT_MS : CLIENT_TOOL_TIMEOUT_MS;
    const timer = setTimeout(() => {
      pending.delete(toolUseId);
      resolve({
        status: 'timeout',
        output: {
          error: `Tool '${toolName}' timed out after ${Math.round(timeoutMs / 1000)}s — the user may have closed Excel or not responded to the approval prompt.`,
        },
      });
    }, timeoutMs);

    pending.set(toolUseId, { sessionId: session.breezeSessionId, toolName, timer, resolve });

    session.eventBus.publish({ type: 'tool_request', toolUseId, toolName, input, mutating });
  });
}

/**
 * Resolve a pending request from POST /tool-results. Returns false when the
 * id is unknown, already resolved/timed out, or belongs to ANOTHER session
 * (cross-session guard — toolUseIds are not secrets).
 */
export function resolveClientToolResult(
  sessionId: string,
  toolUseId: string,
  result: { status: 'success' | 'error' | 'rejected'; output: unknown },
): boolean {
  const entry = pending.get(toolUseId);
  if (!entry || entry.sessionId !== sessionId) return false;
  clearTimeout(entry.timer);
  pending.delete(toolUseId);
  entry.resolve({ status: result.status, output: result.output ?? null });
  return true;
}

/** Fail every pending request of a session (close/teardown). Returns the count failed. */
export function failPendingForSession(sessionId: string, reason = 'session_closed'): number {
  let failed = 0;
  for (const [toolUseId, entry] of [...pending.entries()]) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    pending.delete(toolUseId);
    entry.resolve({ status: 'error', output: { error: reason } });
    failed++;
  }
  return failed;
}

/** Test-only visibility into the pending map. */
export function _pendingCountForTests(): number {
  return pending.size;
}
```

- [ ] **Step 4: Run, expect PASS** (6 tests; same command as Step 2)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiToolBridge.ts apps/api/src/services/clientAiToolBridge.test.ts
git commit -m "feat(client-ai): in-memory tool bridge — tool_request publish + tool-results resolution + timeouts" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CLIENT_TOOL_REGISTRY + hard-isolation test (TDD)

The pinned 9-tool registry and the structural proof that no technician tool is reachable from client sessions — a hard allowlist, not tier filtering (spec §5).

**Files:**
- Create: apps/api/src/services/clientAiTools.ts (registry + names/prefix exports only in this task; handlers come in Task 6)
- Create: apps/api/src/services/clientAiTools.registry.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/clientAiTools.registry.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  CLIENT_TOOL_REGISTRY,
  CLIENT_TOOL_NAMES,
  CLIENT_MCP_SERVER_NAME,
  CLIENT_MCP_TOOL_PREFIX,
  CLIENT_MCP_TOOL_NAMES,
  clientMcpToolNamesForWriteMode,
} from './clientAiTools';
import { TOOL_TIERS, BREEZE_MCP_TOOL_NAMES } from './aiAgentSdkTools';
import { aiTools } from './aiTools';

const PINNED_NAMES = [
  'create_sheet',
  'create_table',
  'format_range',
  'get_workbook_overview',
  'insert_formula',
  'read_range',
  'read_selection',
  'search_workbook',
  'write_range',
];

const PINNED_MUTATING = ['create_sheet', 'create_table', 'format_range', 'insert_formula', 'write_range'];

describe('CLIENT_TOOL_REGISTRY — pinned shape (Plans 3/4/5 depend on these names)', () => {
  it('contains exactly the 9 pinned workbook tools', () => {
    expect(Object.keys(CLIENT_TOOL_REGISTRY).sort()).toEqual(PINNED_NAMES);
    expect(CLIENT_TOOL_NAMES.slice().sort()).toEqual(PINNED_NAMES);
  });

  it('flags exactly the 5 write tools as mutating', () => {
    const mutating = CLIENT_TOOL_NAMES.filter((n) => CLIENT_TOOL_REGISTRY[n].mutating).sort();
    expect(mutating).toEqual(PINNED_MUTATING);
  });

  it('every tool has a non-empty description and an inputSchema object', () => {
    for (const name of CLIENT_TOOL_NAMES) {
      expect(CLIENT_TOOL_REGISTRY[name].description.length).toBeGreaterThan(20);
      expect(typeof CLIENT_TOOL_REGISTRY[name].inputSchema).toBe('object');
    }
  });
});

describe('hard isolation from the technician registry (spec §5: allowlist, not tier filtering)', () => {
  it('shares no tool name with the technician TOOL_TIERS map', () => {
    for (const name of CLIENT_TOOL_NAMES) {
      expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBeUndefined();
    }
  });

  it('shares no tool name with the technician aiTools execution registry', () => {
    for (const name of CLIENT_TOOL_NAMES) {
      expect(aiTools.has(name)).toBe(false);
    }
  });

  it('uses its own MCP namespace — no overlap with BREEZE_MCP_TOOL_NAMES', () => {
    expect(CLIENT_MCP_SERVER_NAME).toBe('excel');
    expect(CLIENT_MCP_TOOL_PREFIX).toBe('mcp__excel__');
    for (const mcpName of CLIENT_MCP_TOOL_NAMES) {
      expect(mcpName.startsWith('mcp__excel__')).toBe(true);
      expect(BREEZE_MCP_TOOL_NAMES).not.toContain(mcpName);
    }
    expect(CLIENT_MCP_TOOL_NAMES).toHaveLength(9);
  });
});

describe('clientMcpToolNamesForWriteMode', () => {
  it('readwrite exposes all 9 tools', () => {
    expect(clientMcpToolNamesForWriteMode('readwrite')).toHaveLength(9);
  });

  it('readonly strips every mutating tool from the toolset', () => {
    const names = clientMcpToolNamesForWriteMode('readonly');
    expect(names.sort()).toEqual([
      'mcp__excel__get_workbook_overview',
      'mcp__excel__read_range',
      'mcp__excel__read_selection',
      'mcp__excel__search_workbook',
    ]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiTools.registry.test.ts
```

- [ ] **Step 3: Create `apps/api/src/services/clientAiTools.ts`** (registry portion; Task 6 appends the handlers to this same file)

```ts
/**
 * AI for Office — client workbook tool registry (spec §5).
 *
 * A SEPARATE registry from the technician aiTools map / TOOL_TIERS — client
 * sessions can only ever see these 9 tools (hard allowlist; proven by
 * clientAiTools.registry.test.ts). Tools do NOT execute on the server:
 * Office.js only runs inside Excel, so the handler (Task 6) round-trips
 * through services/clientAiToolBridge.ts to the add-in.
 *
 * inputSchema entries are zod RAW SHAPES consumed by the Agent SDK's tool()
 * helper (the aiAgentSdkTools.ts:766+ convention). They describe/validate the
 * model's arguments; actual workbook semantics live in the add-in's Office.js
 * executor (Plan 5).
 */

import { z } from 'zod';

const addressSchema = z
  .string()
  .min(1)
  .max(100)
  .describe('A1-style address or range, e.g. "B2" or "B2:F40"');
const sheetNameSchema = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe('Sheet name; defaults to the active sheet when omitted');
const cellValueSchema = z.union([z.string().max(32767), z.number(), z.boolean(), z.null()]);
const cellMatrixSchema = z
  .array(z.array(cellValueSchema).min(1).max(500))
  .min(1)
  .max(5000)
  .describe('Row-major matrix of cell values matching the target range shape');

export interface ClientWorkbookTool {
  description: string;
  /** Mutating tools are approval-gated CLIENT-SIDE (preview card in the task
   *  pane) and stripped/rejected under policy writeMode 'readonly'. */
  mutating: boolean;
  inputSchema: Record<string, z.ZodTypeAny>;
}

export const CLIENT_TOOL_REGISTRY = {
  get_workbook_overview: {
    description:
      'List the sheets in the open workbook with their used ranges and first-row headers. Call this first to orient yourself before reading or writing data.',
    mutating: false,
    inputSchema: {},
  },
  read_selection: {
    description:
      "Read the user's current selection: its address, sheet, and cell values. Use when the user refers to 'this', 'the selected cells', or similar.",
    mutating: false,
    inputSchema: {},
  },
  read_range: {
    description:
      'Read the cell values of a specific range. Returns a row-major matrix. Read data before answering questions about it — never guess values.',
    mutating: false,
    inputSchema: { address: addressSchema, sheetName: sheetNameSchema },
  },
  write_range: {
    description:
      'Write a matrix of values into a range. The user sees a before/after preview in the task pane and must click Apply before anything changes.',
    mutating: true,
    inputSchema: { address: addressSchema, sheetName: sheetNameSchema, cells: cellMatrixSchema },
  },
  insert_formula: {
    description:
      'Insert an Excel formula (starting with "=") into a cell or fill it across a range. Approval-gated like all writes.',
    mutating: true,
    inputSchema: {
      address: addressSchema,
      sheetName: sheetNameSchema,
      formula: z.string().min(2).max(8192).startsWith('=').describe('Excel formula, e.g. "=SUM(B2:B40)"'),
    },
  },
  create_sheet: {
    description:
      'Create a new worksheet in the workbook. Sheet names are limited to 31 characters (Excel limit). Approval-gated.',
    mutating: true,
    inputSchema: { name: z.string().min(1).max(31).describe('New sheet name (max 31 chars)') },
  },
  format_range: {
    description:
      'Apply formatting to a range: bold/italic, font and fill colors (hex), number format string, font size. Approval-gated.',
    mutating: true,
    inputSchema: {
      address: addressSchema,
      sheetName: sheetNameSchema,
      format: z
        .object({
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          fontColor: z.string().max(20).optional().describe('Hex color, e.g. "#1F4E79"'),
          fillColor: z.string().max(20).optional().describe('Hex color, e.g. "#FFF2CC"'),
          numberFormat: z.string().max(100).optional().describe('Excel number format, e.g. "$#,##0.00"'),
          fontSize: z.number().min(6).max(72).optional(),
        })
        .strict(),
    },
  },
  create_table: {
    description:
      'Convert a range into an Excel table (sortable, filterable, banded rows). Approval-gated.',
    mutating: true,
    inputSchema: {
      address: addressSchema,
      sheetName: sheetNameSchema,
      hasHeaders: z.boolean().optional().describe('Whether the first row of the range is a header row'),
      tableName: z.string().min(1).max(255).optional(),
    },
  },
  search_workbook: {
    description:
      'Search the workbook (or one sheet) for a text value. Returns matching cell addresses and their values.',
    mutating: false,
    inputSchema: {
      query: z.string().min(1).max(255),
      sheetName: sheetNameSchema,
      matchCase: z.boolean().optional(),
    },
  },
} as const satisfies Record<string, ClientWorkbookTool>;

export type ClientToolName = keyof typeof CLIENT_TOOL_REGISTRY;

export const CLIENT_TOOL_NAMES = Object.keys(CLIENT_TOOL_REGISTRY) as ClientToolName[];

export const CLIENT_MUTATING_TOOL_NAMES = CLIENT_TOOL_NAMES.filter(
  (name) => CLIENT_TOOL_REGISTRY[name].mutating,
);

/** MCP server name → SDK tool prefix mcp__excel__<tool> (own namespace,
 *  disjoint from mcp__breeze__ — see registry.test.ts). */
export const CLIENT_MCP_SERVER_NAME = 'excel';
export const CLIENT_MCP_TOOL_PREFIX = `mcp__${CLIENT_MCP_SERVER_NAME}__`;

export const CLIENT_MCP_TOOL_NAMES = CLIENT_TOOL_NAMES.map(
  (name) => `${CLIENT_MCP_TOOL_PREFIX}${name}`,
);

/**
 * The SDK-level allowlist for a session: policy writeMode 'readonly' strips
 * mutating tools from the model's toolset at session start (pinned contract).
 * The handler additionally rejects mutating calls server-side (Task 6) in
 * case a resumed/stale SDK process still advertises them.
 */
export function clientMcpToolNamesForWriteMode(writeMode: 'readwrite' | 'readonly'): string[] {
  return CLIENT_TOOL_NAMES.filter(
    (name) => writeMode === 'readwrite' || !CLIENT_TOOL_REGISTRY[name].mutating,
  ).map((name) => `${CLIENT_MCP_TOOL_PREFIX}${name}`);
}
```

- [ ] **Step 4: Run, expect PASS** (8 tests; same command as Step 2)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiTools.ts apps/api/src/services/clientAiTools.registry.test.ts
git commit -m "feat(client-ai): CLIENT_TOOL_REGISTRY — 9 workbook tools, hard-isolated from technician registry" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Client tool MCP handlers — bridge, DLP chokepoint (b), persistence, audit (TDD)

The handler is the server side of the round-trip. It deliberately does NOT use the technician `createSessionPreToolUse`/`createSessionPostToolUse` callbacks (they reject unknown tools at `aiAgentSdk.ts:222-225` and encode technician persistence). It owns, per call:
1. toolUseId correlation (FIFO shift from `session.toolUseIdQueue`, the `aiAgentSdk.ts:640` mechanism),
2. server-side `readonly` rejection of mutating tools,
3. the bridge round-trip,
4. DLP chokepoint (b) on the returned payload (cell-matrix scan + JSON-text scan),
5. persistence (`ai_messages` tool_result row with redactions in `content_blocks`, `ai_tool_executions` row),
6. `ai.client_session.tool_execute` / `.tool_reject` audit events (actor = the portal user),
7. the `tool_completed` bus event.

**Files:**
- Modify: apps/api/src/services/clientAiTools.ts (append handlers + server factory)
- Create: apps/api/src/services/clientAiTools.handler.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/clientAiTools.handler.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  requestToolMock,
  applyDlpMock,
  writeAuditEventMock,
  messagesValuesMock,
  executionsValuesMock,
  dbInsertMock,
} = vi.hoisted(() => {
  const messagesValues = vi.fn(() => Promise.resolve());
  const executionsValues = vi.fn(() => Promise.resolve());
  return {
    requestToolMock: vi.fn(),
    applyDlpMock: vi.fn(),
    writeAuditEventMock: vi.fn(),
    messagesValuesMock: messagesValues,
    executionsValuesMock: executionsValues,
    // First insert per handler call = ai_messages, second = ai_tool_executions
    dbInsertMock: vi.fn(),
  };
});

vi.mock('./clientAiToolBridge', () => ({
  requestClientToolExecution: requestToolMock,
}));
vi.mock('./clientAiDlp', () => ({ applyDlp: applyDlpMock }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: (s: { ip?: string; userAgent?: string }) => ({
    req: { header: () => s.userAgent },
  }),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('../db', () => ({
  db: { insert: dbInsertMock },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { makeClientToolHandler } from './clientAiTools';
import type { ActiveSession } from './streamingSessionManager';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const CLIENT_USER = 'beefbeef-1111-4222-8333-444455556666';
const SESSION_ID = 'a1a1a1a1-1111-4222-8333-444455556666';

function makeSession(overrides: Partial<{ clientWriteMode: 'readonly' | 'readwrite'; queue: string[] }> = {}) {
  const publish = vi.fn();
  const session = {
    breezeSessionId: SESSION_ID,
    orgId: ORG,
    eventBus: { publish },
    toolUseIdQueue: overrides.queue ?? ['toolu_abc123'],
    auditSnapshot: { ip: '203.0.113.7', userAgent: 'office-addin' },
    auth: { user: { id: CLIENT_USER, email: 'finance.user@contoso.com' } },
    clientWriteMode: overrides.clientWriteMode ?? 'readwrite',
    clientDlpConfig: {},
  } as unknown as ActiveSession;
  return { session, publish };
}

function passthroughDlp() {
  applyDlpMock.mockImplementation(
    async (input: { text?: string; cells?: unknown[][] }) => ({
      action: 'allow',
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.cells !== undefined ? { cells: input.cells.map((r) => [...r]) } : {}),
      redactions: [],
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  let call = 0;
  dbInsertMock.mockImplementation(() => {
    call++;
    return { values: call % 2 === 1 ? messagesValuesMock : executionsValuesMock };
  });
  passthroughDlp();
});

describe('makeClientToolHandler — readonly write-mode gate', () => {
  it('rejects mutating tools server-side without calling the bridge, audits tool_reject', async () => {
    const { session, publish } = makeSession({ clientWriteMode: 'readonly' });
    const handler = makeClientToolHandler('write_range', () => session);

    const result = await handler({ address: 'A1', cells: [[1]] });

    expect(result.isError).toBe(true);
    expect(requestToolMock).not.toHaveBeenCalled();
    expect(executionsValuesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.tool_reject',
        result: 'denied',
        actorType: 'user',
        actorId: CLIENT_USER,
        orgId: ORG,
        details: expect.objectContaining({ principalType: 'portal_user', reason: 'readonly_policy' }),
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_completed', status: 'rejected', toolName: 'write_range' }),
    );
  });

  it('still allows read tools under readonly', async () => {
    const { session } = makeSession({ clientWriteMode: 'readonly' });
    requestToolMock.mockResolvedValue({ status: 'success', output: { cells: [['x']] } });
    const handler = makeClientToolHandler('read_range', () => session);
    const result = await handler({ address: 'A1' });
    expect(result.isError).toBeFalsy();
    expect(requestToolMock).toHaveBeenCalled();
  });
});

describe('makeClientToolHandler — success path', () => {
  it('round-trips through the bridge with the FIFO toolUseId, persists redacted output, audits, publishes tool_completed', async () => {
    const { session, publish } = makeSession({ queue: ['toolu_real'] });
    requestToolMock.mockResolvedValue({ status: 'success', output: { address: 'A1:B1', cells: [['v1', 'v2']] } });
    applyDlpMock.mockImplementation(async (input: { text?: string; cells?: unknown[][] }) => {
      if (input.cells) {
        return {
          action: 'allow',
          cells: [['[REDACTED:creditCard]', 'v2']],
          redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }],
        };
      }
      return { action: 'allow', text: input.text, redactions: [] };
    });

    const handler = makeClientToolHandler('read_range', () => session);
    const result = await handler({ address: 'A1:B1' });

    expect(requestToolMock).toHaveBeenCalledWith(session, 'toolu_real', 'read_range', { address: 'A1:B1' }, false);

    // Persisted form is the REDACTED form, with redactions in content_blocks
    expect(messagesValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION_ID,
      role: 'tool_result',
      toolUseId: 'toolu_real',
      toolName: 'read_range',
      toolOutput: expect.objectContaining({ cells: [['[REDACTED:creditCard]', 'v2']] }),
      contentBlocks: [
        { type: 'dlp_redactions', redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }] },
      ],
    }));
    expect(executionsValuesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ai.client_session.tool_execute', result: 'success' }),
    );
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_completed', status: 'success' }));

    // The model sees the redacted form
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('[REDACTED:creditCard]');
    expect(result.content[0]!.text).not.toContain('v1');
  });

  it('mints a toolUseId when the FIFO queue is empty', async () => {
    const { session } = makeSession({ queue: [] });
    requestToolMock.mockResolvedValue({ status: 'success', output: { ok: true } });
    const handler = makeClientToolHandler('read_selection', () => session);
    await handler({});
    const usedId = requestToolMock.mock.calls[0]![1] as string;
    expect(usedId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('makeClientToolHandler — DLP block on tool output', () => {
  it('returns a block-reason error tool_result and never persists the raw payload', async () => {
    const { session, publish } = makeSession();
    requestToolMock.mockResolvedValue({ status: 'success', output: { cells: [['4111111111111111']] } });
    applyDlpMock.mockResolvedValue({
      action: 'block',
      blockReason: 'dlp_blocked:creditCard',
      redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }],
    });

    const handler = makeClientToolHandler('read_range', () => session);
    const result = await handler({ address: 'A1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('dlp_blocked:creditCard');
    expect(JSON.stringify(messagesValuesMock.mock.calls)).not.toContain('4111111111111111');
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_completed', status: 'error', blockReason: 'dlp_blocked:creditCard' }),
    );
  });
});

describe('makeClientToolHandler — rejection and timeout results', () => {
  it('user rejection → rejected execution + tool_reject audit + isError result', async () => {
    const { session, publish } = makeSession();
    requestToolMock.mockResolvedValue({ status: 'rejected', output: null });
    const handler = makeClientToolHandler('write_range', () => session);

    const result = await handler({ address: 'A1', cells: [[1]] });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('rejected');
    expect(executionsValuesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.tool_reject',
        details: expect.objectContaining({ reason: 'user_rejected' }),
      }),
    );
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_completed', status: 'rejected' }));
  });

  it('timeout → failed execution + failure audit + timeout tool_completed', async () => {
    const { session, publish } = makeSession();
    requestToolMock.mockResolvedValue({
      status: 'timeout',
      output: { error: "Tool 'read_range' timed out after 60s — the user may have closed Excel or not responded to the approval prompt." },
    });
    const handler = makeClientToolHandler('read_range', () => session);

    const result = await handler({ address: 'A1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('timed out');
    expect(executionsValuesMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ai.client_session.tool_execute', result: 'failure' }),
    );
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_completed', status: 'timeout' }));
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`makeClientToolHandler` not exported)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiTools.handler.test.ts
```

- [ ] **Step 3: Append the handlers to `apps/api/src/services/clientAiTools.ts`**

Add these imports at the top of the file (after the existing `import { z } from 'zod';`):

```ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { db, withDbAccessContext, runOutsideDbContext } from '../db';
import { aiMessages, aiToolExecutions } from '../db/schema';
import type { ActiveSession } from './streamingSessionManager';
import { requestClientToolExecution } from './clientAiToolBridge';
import { applyDlp, type DlpRedactionEvent } from './clientAiDlp';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';
import { captureException } from './sentry';
```

Then append at the end of the file:

```ts
// ============================================
// Handlers — the server side of the tool round-trip (spec §5)
// ============================================

export type ClientToolHandlerResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function textResult(text: string, isError = false): ClientToolHandlerResult {
  return { content: [{ type: 'text' as const, text }], isError };
}

function extractErrorText(output: unknown): string {
  if (output && typeof output === 'object' && typeof (output as { error?: unknown }).error === 'string') {
    return (output as { error: string }).error;
  }
  if (typeof output === 'string' && output.length > 0) return output;
  return 'Tool execution failed in the add-in.';
}

/**
 * DLP chokepoint (b): every tool_result payload is scanned before the model
 * sees it (spec §6). Two passes:
 *  1. If the output carries a `cells` matrix (read_range/read_selection/
 *     search_workbook shapes), scan it cell-by-cell for cell-level redaction.
 *  2. The whole (post-pass-1) output is scanned as JSON text — catches
 *     addresses, found-value strings, error text etc. If a redaction breaks
 *     JSON syntax (e.g. a bare numeric value replaced by a token), the result
 *     degrades to { redacted: <text> } rather than leaking the original.
 * Pass 2 re-sees pass-1 tokens, which is safe: [REDACTED:*] re-scans to zero
 * findings (Plan 3 idempotency contract).
 */
export async function applyDlpToToolOutput(
  output: unknown,
  orgId: string,
  dlpConfig: unknown,
): Promise<{ blocked: string | null; output: unknown; redactions: DlpRedactionEvent[] }> {
  const redactions: DlpRedactionEvent[] = [];
  let working: unknown = output ?? null;

  if (working && typeof working === 'object' && Array.isArray((working as { cells?: unknown }).cells)) {
    const cells = (working as { cells: unknown[][] }).cells;
    const cellResult = await applyDlp({ cells, dlpConfig, orgId });
    if (cellResult.action === 'block') {
      return { blocked: cellResult.blockReason ?? 'dlp_blocked', output: null, redactions: cellResult.redactions };
    }
    redactions.push(...cellResult.redactions);
    working = { ...(working as Record<string, unknown>), cells: cellResult.cells };
  }

  const asText = JSON.stringify(working ?? null);
  const textResultDlp = await applyDlp({ text: asText, dlpConfig, orgId });
  if (textResultDlp.action === 'block') {
    return {
      blocked: textResultDlp.blockReason ?? 'dlp_blocked',
      output: null,
      redactions: [...redactions, ...textResultDlp.redactions],
    };
  }
  redactions.push(...textResultDlp.redactions);

  let finalOutput: unknown = working;
  if (textResultDlp.text !== undefined && textResultDlp.text !== asText) {
    try {
      finalOutput = JSON.parse(textResultDlp.text);
    } catch {
      finalOutput = { redacted: textResultDlp.text };
    }
  }

  return { blocked: null, output: finalOutput, redactions };
}

interface PersistParams {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  status: 'completed' | 'failed' | 'rejected';
  durationMs: number;
  errorMessage: string | null;
  redactions: DlpRedactionEvent[];
}

/** Persist the REDACTED tool result (spec §6 redact-before-log) + execution audit row. */
async function persistClientToolResult(session: ActiveSession, params: PersistParams): Promise<void> {
  try {
    await withDbAccessContext(
      { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
      async () => {
        await db.insert(aiMessages).values({
          sessionId: session.breezeSessionId,
          role: 'tool_result',
          toolName: params.toolName,
          toolUseId: params.toolUseId,
          toolOutput: (params.output ?? null) as Record<string, unknown>,
          contentBlocks:
            params.redactions.length > 0
              ? ([{ type: 'dlp_redactions', redactions: params.redactions }] as unknown as Record<string, unknown>[])
              : null,
        });
        await db.insert(aiToolExecutions).values({
          sessionId: session.breezeSessionId,
          toolName: params.toolName,
          toolInput: params.input,
          toolOutput: (params.output ?? null) as Record<string, unknown>,
          status: params.status,
          durationMs: params.durationMs,
          errorMessage: params.errorMessage,
          completedAt: new Date(),
        });
      },
    );
  } catch (err) {
    captureException(err);
    console.error(`[client-ai] Failed to persist tool result for ${params.toolName}:`, err);
  }
}

function auditClientTool(
  session: ActiveSession,
  action: 'ai.client_session.tool_execute' | 'ai.client_session.tool_reject',
  params: {
    toolUseId: string;
    toolName: string;
    result: 'success' | 'failure' | 'denied';
    details?: Record<string, unknown>;
  },
): void {
  // No Hono context in the SDK callback chain — rebuild a RequestLike from the
  // session's audit snapshot (streamingSessionManager AuditSnapshot +
  // requestLikeFromSnapshot, auditEvents.ts:18). Actor convention matches
  // Plan 1's exchange route: actorType 'user' + principalType 'portal_user'.
  writeAuditEvent(requestLikeFromSnapshot(session.auditSnapshot), {
    orgId: session.orgId,
    action,
    resourceType: 'ai_tool_execution',
    resourceId: params.toolUseId,
    actorType: 'user',
    actorId: session.auth.user.id,
    actorEmail: session.auth.user.email,
    result: params.result,
    details: {
      principalType: 'portal_user',
      sessionId: session.breezeSessionId,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      ...(params.details ?? {}),
    },
  });
}

export function makeClientToolHandler(toolName: ClientToolName, getSession: () => ActiveSession) {
  const entry: ClientWorkbookTool = CLIENT_TOOL_REGISTRY[toolName];

  return async (args: Record<string, unknown>): Promise<ClientToolHandlerResult> => {
    // Escape any inherited AsyncLocalStorage DB context from the SDK callback
    // chain (the makeHandler precedent, aiAgentSdkTools.ts — stale-transaction hangs).
    return runOutsideDbContext(async () => {
      const session = getSession();
      // Correlate with the model's tool_use block id: the background processor
      // pushes ids on content_block_start (streamingSessionManager.ts:611) and
      // the technician path drains them in createSessionPostToolUse
      // (aiAgentSdk.ts:640). Client handlers bypass that callback, so drain here.
      const toolUseId = session.toolUseIdQueue.shift() ?? crypto.randomUUID();
      const startTime = Date.now();

      // Server-side write-mode enforcement (pinned contract): 'readonly'
      // strips mutating tools from the toolset at session start AND rejects
      // them here if invoked anyway (e.g. resumed SDK process).
      if (entry.mutating && session.clientWriteMode === 'readonly') {
        const error =
          'Workbook writes are disabled for this organization (read-only policy). Offer the change as formula text or step-by-step instructions instead.';
        await persistClientToolResult(session, {
          toolUseId, toolName, input: args, output: { error },
          status: 'rejected', durationMs: 0, errorMessage: error, redactions: [],
        });
        auditClientTool(session, 'ai.client_session.tool_reject', {
          toolUseId, toolName, result: 'denied', details: { reason: 'readonly_policy' },
        });
        session.eventBus.publish({ type: 'tool_completed', toolUseId, toolName, status: 'rejected' });
        return textResult(JSON.stringify({ error }), true);
      }

      const result = await requestClientToolExecution(session, toolUseId, toolName, args, entry.mutating);
      const durationMs = Date.now() - startTime;

      if (result.status === 'rejected') {
        const error =
          'The user rejected this action in the task pane. Do not retry the same change — adjust your approach or ask what they would prefer.';
        await persistClientToolResult(session, {
          toolUseId, toolName, input: args, output: { error },
          status: 'rejected', durationMs, errorMessage: error, redactions: [],
        });
        auditClientTool(session, 'ai.client_session.tool_reject', {
          toolUseId, toolName, result: 'denied', details: { reason: 'user_rejected' },
        });
        session.eventBus.publish({ type: 'tool_completed', toolUseId, toolName, status: 'rejected' });
        return textResult(JSON.stringify({ error }), true);
      }

      if (result.status !== 'success') {
        // 'error' (add-in reported failure) or 'timeout' (bridge timer fired)
        const error = extractErrorText(result.output);
        await persistClientToolResult(session, {
          toolUseId, toolName, input: args, output: { error },
          status: 'failed', durationMs, errorMessage: error, redactions: [],
        });
        auditClientTool(session, 'ai.client_session.tool_execute', {
          toolUseId, toolName, result: 'failure', details: { reason: result.status, durationMs },
        });
        session.eventBus.publish({ type: 'tool_completed', toolUseId, toolName, status: result.status });
        return textResult(JSON.stringify({ error }), true);
      }

      // DLP chokepoint (b): scan before the model sees the payload (spec §6).
      const dlp = await applyDlpToToolOutput(result.output, session.orgId, session.clientDlpConfig ?? {});
      if (dlp.blocked) {
        const error = `Result blocked by your organization's data protection policy (${dlp.blocked}).`;
        await persistClientToolResult(session, {
          toolUseId, toolName, input: args, output: { error },
          status: 'failed', durationMs, errorMessage: error, redactions: dlp.redactions,
        });
        auditClientTool(session, 'ai.client_session.tool_execute', {
          toolUseId, toolName, result: 'denied', details: { reason: 'dlp_blocked', blockReason: dlp.blocked },
        });
        session.eventBus.publish({
          type: 'tool_completed', toolUseId, toolName, status: 'error',
          blockReason: dlp.blocked, redactions: dlp.redactions,
        });
        return textResult(JSON.stringify({ error }), true);
      }

      await persistClientToolResult(session, {
        toolUseId, toolName, input: args, output: dlp.output,
        status: 'completed', durationMs, errorMessage: null, redactions: dlp.redactions,
      });
      auditClientTool(session, 'ai.client_session.tool_execute', {
        toolUseId, toolName, result: 'success',
        details: { durationMs, redactionCount: dlp.redactions.length },
      });
      session.eventBus.publish({
        type: 'tool_completed', toolUseId, toolName, status: 'success', redactions: dlp.redactions,
      });
      return textResult(typeof dlp.output === 'string' ? dlp.output : JSON.stringify(dlp.output ?? null));
    });
  };
}

/**
 * SDK MCP server for a client session — constructed ONLY from
 * CLIENT_TOOL_REGISTRY (hard isolation; registry.test.ts). Plugged into
 * streamingSessionManager.getOrCreate via the mcpServerFactory parameter
 * (the scriptAi.ts:211-215 precedent).
 */
export function createClientWorkbookMcpServer(getSession: () => ActiveSession) {
  return createSdkMcpServer({
    name: CLIENT_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: CLIENT_TOOL_NAMES.map((name) =>
      tool(
        name,
        CLIENT_TOOL_REGISTRY[name].description,
        CLIENT_TOOL_REGISTRY[name].inputSchema,
        makeClientToolHandler(name, getSession),
      ),
    ),
  });
}
```

- [ ] **Step 4: Run, expect PASS** (8 tests), plus the registry suite stays green:

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiTools.handler.test.ts src/services/clientAiTools.registry.test.ts
```

(If the SDK's `tool()` typing fights the heterogeneous `inputSchema` map, type the `tools:` array as `ReturnType<typeof tool>[]` — the aiAgentSdkTools.ts file builds its array the same way without that cast, so this should not be needed.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiTools.ts apps/api/src/services/clientAiTools.handler.test.ts
git commit -m "feat(client-ai): workbook tool handlers — bridge round-trip, DLP chokepoint, persistence, audit" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: clientAiSessions service — system prompt, synthetic AuthContext, rate limits (TDD)

**Files:**
- Create: apps/api/src/services/clientAiSessions.ts
- Create: apps/api/src/services/clientAiSessions.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/clientAiSessions.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rateLimiterMock, getRedisMock } = vi.hoisted(() => ({
  rateLimiterMock: vi.fn(),
  getRedisMock: vi.fn(() => ({}) as never),
}));

vi.mock('./redis', () => ({ getRedis: getRedisMock }));
vi.mock('./rate-limit', () => ({ rateLimiter: rateLimiterMock }));

import {
  DEFAULT_CLIENT_AI_MODEL,
  EXCEL_CLIENT_SYSTEM_PROMPT,
  buildExcelClientSystemPrompt,
  buildClientAuthContext,
  checkClientRateLimits,
  generateClientSessionTitle,
} from './clientAiSessions';
import { defaultClientAiPolicy } from './clientAiPolicy';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const USER = 'beefbeef-1111-4222-8333-444455556666';

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
});

describe('system prompt', () => {
  it('pins the workbook-only scope and the no-RMM-claims rule', () => {
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('ONLY work with the open workbook');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('never claim or imply such capabilities');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('Never fabricate cell values');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('click Apply');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('[REDACTED:');
    expect(EXCEL_CLIENT_SYSTEM_PROMPT).toContain('Be concise');
  });

  it('readwrite mode returns the base prompt; readonly appends the read-only addendum', () => {
    expect(buildExcelClientSystemPrompt('readwrite')).toBe(EXCEL_CLIENT_SYSTEM_PROMPT);
    const ro = buildExcelClientSystemPrompt('readonly');
    expect(ro).toContain(EXCEL_CLIENT_SYSTEM_PROMPT);
    expect(ro).toContain('READ-ONLY');
  });
});

describe('buildClientAuthContext', () => {
  it('builds an org-pinned synthetic AuthContext (the helper-chat shape)', () => {
    const auth = buildClientAuthContext({
      clientUserId: USER, orgId: ORG, email: 'finance.user@contoso.com', name: 'Finance User',
    });
    expect(auth.user.id).toBe(USER);
    expect(auth.user.isPlatformAdmin).toBe(false);
    expect(auth.scope).toBe('organization');
    expect(auth.orgId).toBe(ORG);
    expect(auth.accessibleOrgIds).toEqual([ORG]);
    expect(auth.canAccessOrg(ORG)).toBe(true);
    expect(auth.canAccessOrg('9d9d9d9d-1111-4222-8333-444455556666')).toBe(false);
    expect(auth.partnerId).toBeNull();
    expect(auth.token.mfa).toBe(false);
  });

  it('falls back to the email when the user has no display name', () => {
    const auth = buildClientAuthContext({ clientUserId: USER, orgId: ORG, email: 'a@b.com', name: null });
    expect(auth.user.name).toBe('a@b.com');
  });
});

describe('checkClientRateLimits', () => {
  it('passes when both limiters allow, using policy-driven limits and clientai keys', async () => {
    const policy = { ...defaultClientAiPolicy(ORG), perUserMessagesPerMinute: 7, orgMessagesPerHour: 123 };
    await expect(checkClientRateLimits(USER, ORG, policy)).resolves.toBeNull();
    expect(rateLimiterMock).toHaveBeenNthCalledWith(1, expect.anything(), `clientai:msg:user:${USER}`, 7, 60);
    expect(rateLimiterMock).toHaveBeenNthCalledWith(2, expect.anything(), `clientai:msg:org:${ORG}`, 123, 3600);
  });

  it('rejects on the per-user limit without consulting the org limiter', async () => {
    rateLimiterMock.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date('2026-06-12T10:00:00Z') });
    const msg = await checkClientRateLimits(USER, ORG, defaultClientAiPolicy(ORG));
    expect(msg).toContain('too quickly');
    expect(rateLimiterMock).toHaveBeenCalledTimes(1);
  });

  it('rejects on the org limit', async () => {
    rateLimiterMock
      .mockResolvedValueOnce({ allowed: true, remaining: 1, resetAt: new Date() })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date('2026-06-12T10:00:00Z') });
    const msg = await checkClientRateLimits(USER, ORG, defaultClientAiPolicy(ORG));
    expect(msg).toContain("organization's AI message limit");
  });
});

describe('generateClientSessionTitle', () => {
  it('collapses whitespace and passes short content through', () => {
    expect(generateClientSessionTitle('  sum   column B ')).toBe('sum column B');
  });
  it('truncates at a word boundary with ellipsis', () => {
    const title = generateClientSessionTitle('word '.repeat(40));
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('DEFAULT_CLIENT_AI_MODEL', () => {
  it('matches the platform default model', () => {
    expect(DEFAULT_CLIENT_AI_MODEL).toBe('claude-sonnet-4-5-20250929');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiSessions.test.ts
```

- [ ] **Step 3: Create `apps/api/src/services/clientAiSessions.ts`**

```ts
/**
 * AI for Office — session-loop helpers shared by routes/clientAi/sessions.ts.
 *
 * The synthetic AuthContext mirrors the helper-chat shape
 * (routes/helper/index.ts:133-160): an org-pinned 'organization'-scope context
 * whose "user" is the portal user, so streamingSessionManager's background
 * callbacks (recordUsageFromSdkResult via session.auth.orgId, audit actor ids)
 * and RLS DB contexts all resolve to the client org. No helperDeviceId — the
 * client surface has no device axis.
 */

import { eq } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { getRedis } from './redis';
import { rateLimiter } from './rate-limit';
import type { ClientAiOrgPolicy } from './clientAiPolicy';

export const DEFAULT_CLIENT_AI_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * The Excel-assistant system prompt (spec §5/§11; pinned in the plan).
 * Stored on the ai_sessions row at create time, passed to getOrCreate with
 * injectApprovalModeInstructions: false so no technician approval-mode text
 * is appended.
 */
export const EXCEL_CLIENT_SYSTEM_PROMPT = `You are a spreadsheet assistant embedded in Microsoft Excel, provided to this user by their IT provider.
You help business users understand, analyze, build, and edit the workbook that is currently open in Excel.

Rules:
- You can ONLY work with the open workbook, through the workbook tools provided. You have no access to devices, other files, email, the internet, or any IT systems — never claim or imply such capabilities.
- Never fabricate cell values, ranges, sheet names, or statistics. If you have not read the relevant data in this conversation, call get_workbook_overview, read_selection, or read_range first, and answer only from what the tools actually returned.
- Workbook changes (write_range, insert_formula, create_sheet, format_range, create_table) are shown to the user as a preview card in the task pane and only take effect when they click Apply. If the user rejects a change, do not retry the same change — adjust your approach or ask what they would prefer.
- Propose the smallest change that satisfies the request, and tell the user what you are about to change before calling a write tool.
- Some values may appear as [REDACTED:...]. That is the organization's data-protection policy at work — never try to guess or reconstruct redacted values.
- Use A1-style addresses, and include the sheet name when the workbook has more than one sheet.
- Be concise. Business users want answers, working formulas, and clean tables — not essays.
- If a request is unrelated to this workbook or spreadsheets, politely explain that you can only help with the workbook.`;

const READONLY_ADDENDUM = `

This session is READ-ONLY: write tools are not available and you cannot modify the workbook. Offer analysis, explanations, and formula text the user can apply manually instead.`;

export function buildExcelClientSystemPrompt(writeMode: 'readwrite' | 'readonly'): string {
  return writeMode === 'readonly' ? EXCEL_CLIENT_SYSTEM_PROMPT + READONLY_ADDENDUM : EXCEL_CLIENT_SYSTEM_PROMPT;
}

export function buildClientAuthContext(params: {
  clientUserId: string;
  orgId: string;
  email: string;
  name: string | null;
}): AuthContext {
  const { clientUserId, orgId, email, name } = params;
  return {
    user: {
      id: clientUserId,
      email,
      name: name ?? email,
      isPlatformAdmin: false,
    },
    token: {
      sub: clientUserId,
      email,
      roleId: null,
      type: 'access' as const,
      scope: 'organization' as const,
      orgId,
      partnerId: null,
      iat: Math.floor(Date.now() / 1000),
      mfa: false,
    },
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (orgIdColumn) => eq(orgIdColumn, orgId),
    canAccessOrg: (id) => id === orgId,
  };
}

/**
 * Pre-flight rate limits (spec §4): per-user msgs/min then org msgs/hour,
 * limits from client_ai_org_policies. rateLimiter fails closed when Redis is
 * down (services/rate-limit.ts:29-33).
 */
export async function checkClientRateLimits(
  clientUserId: string,
  orgId: string,
  policy: ClientAiOrgPolicy,
): Promise<string | null> {
  const redis = getRedis();

  const userResult = await rateLimiter(
    redis,
    `clientai:msg:user:${clientUserId}`,
    policy.perUserMessagesPerMinute,
    60,
  );
  if (!userResult.allowed) {
    return `You are sending messages too quickly. Try again at ${userResult.resetAt.toISOString()}.`;
  }

  const orgResult = await rateLimiter(
    redis,
    `clientai:msg:org:${orgId}`,
    policy.orgMessagesPerHour,
    3600,
  );
  if (!orgResult.allowed) {
    return `Your organization's AI message limit was reached. Try again at ${orgResult.resetAt.toISOString()}.`;
  }

  return null;
}

/** Short title from the first user message (duplicated tiny helper — same as routes/ai.ts:104-113). */
export function generateClientSessionTitle(content: string): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 80) return cleaned;
  const truncated = cleaned.slice(0, 80);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '…';
}
```

- [ ] **Step 4: Run, expect PASS** (11 tests; same command as Step 2)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiSessions.ts apps/api/src/services/clientAiSessions.test.ts
git commit -m "feat(client-ai): session helpers — Excel system prompt, synthetic auth context, client rate limits" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `?token=` fallback for SSE in clientAiAuthMiddleware (TDD)

EventSource cannot set request headers, so the SSE GET accepts `?token=` when no `Authorization` header is present — **GET-only**, header always wins. Documented preference: fetch-based SSE with the bearer header (Plan 5's client); `?token=` is the EventSource fallback and can land in proxy access logs.

**Files:**
- Modify: apps/api/src/middleware/clientAiAuth.ts (Plan 1 file — small additive edit)
- Create: apps/api/src/middleware/clientAiAuth.queryToken.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/middleware/clientAiAuth.queryToken.test.ts` (mock skeleton copied from Plan 1's `clientAiAuth.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { redisMock, getRedisMock, dbSelectMock } = vi.hoisted(() => {
  const redis = {
    get: vi.fn(),
    del: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  return { redisMock: redis, getRedisMock: vi.fn(() => redis), dbSelectMock: vi.fn() };
});

vi.mock('../db', () => ({
  db: { select: dbSelectMock },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../services/redis', () => ({ getRedis: getRedisMock }));
vi.mock('../services/clientAiPolicy', () => ({
  getOrgPolicy: vi.fn(),
  isClientUserPermitted: vi.fn(() => true),
}));

import { clientAiAuthMiddleware } from './clientAiAuth';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PORTAL_USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK';

const USER_ROW = {
  id: PORTAL_USER_ID, orgId: ORG_ID, email: 'finance.user@contoso.com',
  name: 'Finance User', status: 'active',
};

function buildApp() {
  const app = new Hono();
  app.use('*', clientAiAuthMiddleware);
  app.get('/events', (c) => c.json({ clientUserId: c.get('clientAiAuth').clientUserId }));
  app.post('/messages', (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock);
  redisMock.get.mockResolvedValue(
    JSON.stringify({ portalUserId: PORTAL_USER_ID, orgId: ORG_ID, createdAt: new Date().toISOString() }),
  );
  dbSelectMock.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([USER_ROW])) })),
    })),
  }));
});

describe('clientAiAuthMiddleware — ?token= query fallback (SSE/EventSource)', () => {
  it('authenticates a GET via ?token= when no Authorization header is present', async () => {
    const res = await buildApp().request(`/events?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clientUserId: PORTAL_USER_ID });
    expect(redisMock.get).toHaveBeenCalledWith(`clientai:session:${TOKEN}`);
  });

  it('the Authorization header wins over a conflicting ?token=', async () => {
    await buildApp().request(`/events?token=query-token`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(redisMock.get).toHaveBeenCalledWith(`clientai:session:${TOKEN}`);
  });

  it('does NOT accept ?token= on non-GET requests', async () => {
    const res = await buildApp().request(`/messages?token=${TOKEN}`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('still 401s a GET with neither header nor query token', async () => {
    const res = await buildApp().request('/events');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (query-token GET returns 401 today)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/middleware/clientAiAuth.queryToken.test.ts
```

- [ ] **Step 3: Edit `apps/api/src/middleware/clientAiAuth.ts`** — in `clientAiAuthMiddleware`, replace:

```ts
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }
```

with:

```ts
  const authHeader = c.req.header('Authorization');
  let token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token && c.req.method === 'GET') {
    // EventSource cannot set request headers, so GET endpoints (the SSE
    // stream) accept ?token= as a fallback. Header always wins; non-GET
    // requests are header-only. Prefer fetch-based SSE with the Authorization
    // header (Plan 5's client) — query tokens can land in proxy access logs.
    token = c.req.query('token') || null;
  }
  if (!token) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }
```

- [ ] **Step 4: Run, expect PASS** (4 tests), and re-run Plan 1's middleware suite to prove no regression:

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/middleware/clientAiAuth.queryToken.test.ts src/middleware/clientAiAuth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/clientAiAuth.ts apps/api/src/middleware/clientAiAuth.queryToken.test.ts
git commit -m "feat(client-ai): GET-only ?token= auth fallback for the SSE stream" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: SSE translation layer — sse.ts (TDD)

The bus→client translator: internal `AiStreamEvent`s become the five pinned client-facing events; everything else (technician/internal events) is dropped so the add-in never sees RMM concepts. Plan 5 mirrors `CLIENT_AI_SSE_EVENTS` exactly.

**Files:**
- Create: apps/api/src/routes/clientAi/sse.ts
- Create: apps/api/src/routes/clientAi/sse.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/routes/clientAi/sse.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { CLIENT_AI_SSE_EVENTS, toClientSseEvent } from './sse';
import type { AiStreamEvent } from '@breeze/shared/types/ai';

describe('CLIENT_AI_SSE_EVENTS — pinned names (Plan 5 mirrors this list)', () => {
  it('exposes exactly the pinned event names', () => {
    expect(CLIENT_AI_SSE_EVENTS).toEqual([
      'message_delta', 'tool_request', 'tool_completed', 'turn_complete', 'session_error', 'ping',
    ]);
  });
});

describe('toClientSseEvent', () => {
  it('content_delta → message_delta { text }', () => {
    expect(toClientSseEvent({ type: 'content_delta', delta: 'Hello' })).toEqual({
      event: 'message_delta',
      data: JSON.stringify({ text: 'Hello' }),
    });
  });

  it('tool_request passes through with the pinned payload', () => {
    const out = toClientSseEvent({
      type: 'tool_request', toolUseId: 'tu-1', toolName: 'read_range',
      input: { address: 'A1' }, mutating: false,
    });
    expect(out!.event).toBe('tool_request');
    expect(JSON.parse(out!.data)).toEqual({
      toolUseId: 'tu-1', toolName: 'read_range', input: { address: 'A1' }, mutating: false,
    });
  });

  it('tool_completed carries status, redactions, blockReason', () => {
    const out = toClientSseEvent({
      type: 'tool_completed', toolUseId: 'tu-1', toolName: 'read_range', status: 'success',
      redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }],
    });
    expect(out!.event).toBe('tool_completed');
    expect(JSON.parse(out!.data)).toEqual({
      toolUseId: 'tu-1', toolName: 'read_range', status: 'success',
      redactions: [{ rule: 'creditCard', count: 1, location: 'cell[0][0]' }],
      blockReason: null,
    });
  });

  it('done → turn_complete with usage (null when absent)', () => {
    expect(toClientSseEvent({ type: 'done', usage: { inputTokens: 100, outputTokens: 50, costCents: 3 } })).toEqual({
      event: 'turn_complete',
      data: JSON.stringify({ usage: { inputTokens: 100, outputTokens: 50, costCents: 3 } }),
    });
    expect(toClientSseEvent({ type: 'done' })).toEqual({
      event: 'turn_complete',
      data: JSON.stringify({ usage: null }),
    });
  });

  it('error → session_error { message }', () => {
    expect(toClientSseEvent({ type: 'error', message: 'boom' })).toEqual({
      event: 'session_error',
      data: JSON.stringify({ message: 'boom' }),
    });
  });

  it('drops internal/technician events (no RMM leakage to the add-in)', () => {
    const internal: AiStreamEvent[] = [
      { type: 'message_start', messageId: 'm1' },
      { type: 'message_end', inputTokens: 0, outputTokens: 5 },
      { type: 'tool_use_start', toolName: 'read_range', toolUseId: 'tu-1', input: {} },
      { type: 'title_updated', title: 'T' },
      { type: 'approval_mode_changed', mode: 'per_step' },
    ];
    for (const event of internal) {
      expect(toClientSseEvent(event)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/sse.test.ts
```

- [ ] **Step 3: Create `apps/api/src/routes/clientAi/sse.ts`**

```ts
/**
 * AI for Office — SSE protocol for GET /client-ai/sessions/:id/events.
 *
 * Translates internal AiStreamEvents (SessionEventBus) into the PINNED
 * client-facing event names the add-in consumes (Plan 5 mirrors this table):
 *
 *   message_delta   ← content_delta          { text }
 *   tool_request    ← tool_request (bridge)  { toolUseId, toolName, input, mutating }
 *   tool_completed  ← tool_completed         { toolUseId, toolName, status, redactions, blockReason }
 *   turn_complete   ← done                   { usage: { inputTokens, outputTokens, costCents } | null }
 *   session_error   ← error                  { message }
 *   ping            ← server keepalive timer { } every CLIENT_AI_SSE_PING_INTERVAL_MS
 *
 * Everything else (message_start/message_end/tool_use_start/title_updated/
 * plan + approval events) is INTERNAL and dropped — the add-in must never see
 * technician/RMM concepts (spec §1).
 */

import type { AiStreamEvent } from '@breeze/shared/types/ai';

export const CLIENT_AI_SSE_PING_INTERVAL_MS = 25_000;

export const CLIENT_AI_SSE_EVENTS = [
  'message_delta',
  'tool_request',
  'tool_completed',
  'turn_complete',
  'session_error',
  'ping',
] as const;

export type ClientAiSseEventName = (typeof CLIENT_AI_SSE_EVENTS)[number];

export function toClientSseEvent(
  event: AiStreamEvent,
): { event: ClientAiSseEventName; data: string } | null {
  switch (event.type) {
    case 'content_delta':
      return { event: 'message_delta', data: JSON.stringify({ text: event.delta }) };
    case 'tool_request':
      return {
        event: 'tool_request',
        data: JSON.stringify({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          mutating: event.mutating,
        }),
      };
    case 'tool_completed':
      return {
        event: 'tool_completed',
        data: JSON.stringify({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          status: event.status,
          redactions: event.redactions ?? [],
          blockReason: event.blockReason ?? null,
        }),
      };
    case 'done':
      return { event: 'turn_complete', data: JSON.stringify({ usage: event.usage ?? null }) };
    case 'error':
      return { event: 'session_error', data: JSON.stringify({ message: event.message }) };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run, expect PASS** (6 tests; same command as Step 2)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clientAi/sse.ts apps/api/src/routes/clientAi/sse.test.ts
git commit -m "feat(client-ai): SSE event translation — pinned client-facing event names" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Session routes — schemas, create / get / close, mount (TDD)

Creates `routes/clientAi/sessions.ts` with the shared helpers (`loadClientSession`, `auditClient`, `ensureActiveClientSession`) and three of the six routes; Tasks 11/12 append the rest to the same file. Mounts the router in the namespace hub.

**Files:**
- Modify: apps/api/src/routes/clientAi/schemas.ts (append message/tool-result schemas)
- Create: apps/api/src/routes/clientAi/sessions.ts
- Create: apps/api/src/routes/clientAi/sessions.lifecycle.test.ts
- Modify: apps/api/src/routes/clientAi/index.ts (mount)

- [ ] **Step 1: Append to `apps/api/src/routes/clientAi/schemas.ts`** (after `putPolicySchema`, before the Types section):

```ts
// ============================================
// Session-loop schemas (Plan 2)
// ============================================

/** Per-message workbook context chip (spec §11): the user controls data egress. */
export const workbookContextSchema = z.object({
  kind: z.enum(['selection', 'sheet', 'none']),
  address: z.string().max(100).optional(),
  sheetName: z.string().max(255).optional(),
  /** Row-major cell values. Caps mirror the DLP engine's fail-closed limits
   *  (Plan 3: 50k cells / 32,767 chars per cell). */
  cells: z
    .array(z.array(z.union([z.string().max(32767), z.number(), z.boolean(), z.null()])).max(500))
    .max(5000)
    .optional(),
});

export const sendClientMessageSchema = z.object({
  content: z.string().min(1).max(20000),
  workbookContext: workbookContextSchema.optional(),
});

/** Body of POST /sessions/:id/tool-results (pinned bridge contract). */
export const clientToolResultSchema = z.object({
  toolUseId: z.string().min(1).max(100),
  status: z.enum(['success', 'error', 'rejected']),
  output: z.unknown().optional(),
});
```

- [ ] **Step 2: Write the failing test** — `apps/api/src/routes/clientAi/sessions.lifecycle.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  CLIENT_USER_ID, ORG_ID, SESSION_ID,
  policyState,
  dbSelectMock, dbInsertMock, dbUpdateMock,
  managerMock,
  writeAuditEventMock,
  recordClientUsageMock, checkClientBudgetMock, getRemainingBudgetMock,
  checkBillingCreditsMock, rateLimiterMock,
  resolveToolResultMock, failPendingMock,
  applyDlpMock,
} = vi.hoisted(() => ({
  CLIENT_USER_ID: 'beefbeef-1111-4222-8333-444455556666',
  ORG_ID: '0c0c0c0c-1111-4222-8333-444455556666',
  SESSION_ID: 'a1a1a1a1-1111-4222-8333-444455556666',
  policyState: { policy: {} as Record<string, unknown> },
  dbSelectMock: vi.fn(),
  dbInsertMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  managerMock: {
    getOrCreate: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    tryTransitionToProcessing: vi.fn(() => true),
    startTurnTimeout: vi.fn(),
  },
  writeAuditEventMock: vi.fn(),
  recordClientUsageMock: vi.fn(() => Promise.resolve()),
  checkClientBudgetMock: vi.fn(() => Promise.resolve(null)),
  getRemainingBudgetMock: vi.fn(() => Promise.resolve(undefined)),
  checkBillingCreditsMock: vi.fn(() => Promise.resolve(null)),
  rateLimiterMock: vi.fn(() => Promise.resolve({ allowed: true, remaining: 9, resetAt: new Date() })),
  resolveToolResultMock: vi.fn(() => true),
  failPendingMock: vi.fn(() => 0),
  applyDlpMock: vi.fn(),
}));

vi.mock('../../middleware/clientAiAuth', () => ({
  clientAiAuthMiddleware: (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('clientAiAuth', {
      clientUserId: CLIENT_USER_ID, orgId: ORG_ID,
      email: 'finance.user@contoso.com', name: 'Finance User', token: 'tok',
    });
    return next();
  },
  requireClientAiEnabledMiddleware: (c: any, next: any) => {
    c.set('clientAiPolicy', policyState.policy);
    return next();
  },
}));

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, update: dbUpdateMock },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));
vi.mock('../../services/streamingSessionManager', () => ({ streamingSessionManager: managerMock }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock('../../services/clientAiUsage', () => ({
  recordClientUsage: recordClientUsageMock,
  checkClientBudget: checkClientBudgetMock,
  getRemainingClientBudgetUsd: getRemainingBudgetMock,
}));
vi.mock('../../services/aiCostTracker', () => ({ checkBillingCredits: checkBillingCreditsMock }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => ({}) as never) }));
vi.mock('../../services/clientAiToolBridge', () => ({
  resolveClientToolResult: resolveToolResultMock,
  failPendingForSession: failPendingMock,
}));
vi.mock('../../services/clientAiDlp', () => ({ applyDlp: applyDlpMock }));

import { clientAiSessionRoutes } from './sessions';
import { defaultClientAiPolicy } from '../../services/clientAiPolicy';

const SESSION_ROW = {
  id: SESSION_ID, orgId: ORG_ID, clientUserId: CLIENT_USER_ID, type: 'excel_client',
  status: 'active', title: 'Budget review', model: 'claude-sonnet-4-5-20250929',
  systemPrompt: 'P', sdkSessionId: null, maxTurns: 50, turnCount: 0,
  totalInputTokens: 10, totalOutputTokens: 20, totalCostCents: 1.5,
  createdAt: new Date(), lastActivityAt: new Date(),
};

function selectChain(rows: unknown[]) {
  const limit = vi.fn(() => Promise.resolve(rows));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  return { from: vi.fn(() => ({ where })) };
}

function buildApp() {
  const app = new Hono();
  app.route('/client-ai/sessions', clientAiSessionRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
  managerMock.tryTransitionToProcessing.mockReturnValue(true);
  checkClientBudgetMock.mockResolvedValue(null);
  checkBillingCreditsMock.mockResolvedValue(null);
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
  policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true };
  dbSelectMock.mockImplementation(() => selectChain([SESSION_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  }));
});

describe('POST /client-ai/sessions (create)', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await buildApp().request('/client-ai/sessions', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('creates an excel_client session with the client principal, bumps sessionCount, audits', async () => {
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sessionId: SESSION_ID });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      userId: null,
      clientUserId: CLIENT_USER_ID,
      type: 'excel_client',
      model: 'claude-sonnet-4-5-20250929',
      systemPrompt: expect.stringContaining('spreadsheet assistant'),
    }));
    expect(recordClientUsageMock).toHaveBeenCalledWith(ORG_ID, CLIENT_USER_ID, { sessionCount: 1 });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.create',
        actorType: 'user',
        actorId: CLIENT_USER_ID,
        orgId: ORG_ID,
        details: expect.objectContaining({ principalType: 'portal_user' }),
      }),
    );
  });

  it('uses the policy allowedModels[0] when configured', async () => {
    policyState.policy = {
      ...defaultClientAiPolicy(ORG_ID), enabled: true,
      allowedModels: ['claude-haiku-4-5-20251001'],
    };
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));
    await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }));
  });

  it('appends the read-only addendum to the stored system prompt under writeMode readonly', async () => {
    policyState.policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true, writeMode: 'readonly' };
    const valuesSpy = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: SESSION_ID }])) }));
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));
    await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('READ-ONLY'),
    }));
  });

  it('402s when the org budget is exhausted', async () => {
    checkClientBudgetMock.mockResolvedValue('Daily AI budget for your organization has been reached ($5.00).');
    const res = await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(res.status).toBe(402);
  });

  it('402s when partner AI credits are exhausted', async () => {
    checkBillingCreditsMock.mockResolvedValue('You are out of AI credits. Purchase more credits to continue.');
    const res = await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(res.status).toBe(402);
  });

  it('429s when rate limited', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await buildApp().request('/client-ai/sessions', { method: 'POST', headers: AUTHED });
    expect(res.status).toBe(429);
  });
});

describe('GET /client-ai/sessions/:id', () => {
  it('404s when the session belongs to another client user (access check)', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}`, { headers: AUTHED });
    expect(res.status).toBe(404);
  });

  it('returns the session plus its (already-redacted) message history', async () => {
    const MESSAGES = [
      { id: 'm1', role: 'user', content: 'card [REDACTED:creditCard]', contentBlocks: null, toolName: null, toolInput: null, toolOutput: null, toolUseId: null, createdAt: new Date() },
    ];
    let call = 0;
    dbSelectMock.mockImplementation(() => {
      call++;
      return selectChain(call === 1 ? [SESSION_ROW] : MESSAGES);
    });

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}`, { headers: AUTHED });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toMatchObject({ id: SESSION_ID, status: 'active', title: 'Budget review' });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toContain('[REDACTED:creditCard]');
  });
});

describe('POST /client-ai/sessions/:id/close', () => {
  it('closes the session, fails pending tool requests, evicts the active session, audits', async () => {
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/close`, {
      method: 'POST', headers: AUTHED,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(failPendingMock).toHaveBeenCalledWith(SESSION_ID, 'session_closed');
    expect(managerMock.remove).toHaveBeenCalledWith(SESSION_ID);
    expect(dbUpdateMock).toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ai.client_session.close', resourceId: SESSION_ID }),
    );
  });

  it('404s for an inaccessible session', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/close`, {
      method: 'POST', headers: AUTHED,
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run, expect FAIL** (module not found)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/sessions.lifecycle.test.ts
```

- [ ] **Step 4: Create `apps/api/src/routes/clientAi/sessions.ts`** (helpers + three routes; Tasks 11/12 append the rest)

```ts
/**
 * AI for Office — /client-ai/sessions/* (spec §4, §5, §8).
 *
 * All routes run behind Plan 1's clientAiAuthMiddleware (bearer session →
 * org-scoped DB context) + requireClientAiEnabledMiddleware (per-request
 * enabled/selected-user policy gate, policy on c.get('clientAiPolicy')).
 *
 * Access rule on every session route: the ai_sessions row must match BOTH
 * auth.clientUserId and auth.orgId (and type='excel_client') — enforced by
 * loadClientSession's WHERE in addition to RLS.
 *
 * Audit actor convention (Plan 1's exchange route): actorType 'user',
 * actorId = portal_users.id, details.principalType 'portal_user'.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { streamSSE } from 'hono/streaming';
import { and, asc, eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { aiMessages, aiSessions } from '../../db/schema';
import {
  clientAiAuthMiddleware,
  requireClientAiEnabledMiddleware,
} from '../../middleware/clientAiAuth';
import {
  streamingSessionManager,
  type ActiveSession,
} from '../../services/streamingSessionManager';
import { writeAuditEvent } from '../../services/auditEvents';
import { applyDlp, type DlpRedactionEvent } from '../../services/clientAiDlp';
import { checkBillingCredits } from '../../services/aiCostTracker';
import {
  checkClientBudget,
  getRemainingClientBudgetUsd,
  recordClientUsage,
} from '../../services/clientAiUsage';
import {
  DEFAULT_CLIENT_AI_MODEL,
  buildClientAuthContext,
  buildExcelClientSystemPrompt,
  checkClientRateLimits,
  generateClientSessionTitle,
} from '../../services/clientAiSessions';
import {
  CLIENT_MCP_SERVER_NAME,
  clientMcpToolNamesForWriteMode,
  createClientWorkbookMcpServer,
} from '../../services/clientAiTools';
import {
  failPendingForSession,
  resolveClientToolResult,
} from '../../services/clientAiToolBridge';
import type { ClientAiOrgPolicy } from '../../services/clientAiPolicy';
import { toClientSseEvent, CLIENT_AI_SSE_PING_INTERVAL_MS } from './sse';
import {
  clientToolResultSchema,
  sendClientMessageSchema,
  type ClientAiAuthContext,
} from './schemas';

export const clientAiSessionRoutes = new Hono();

clientAiSessionRoutes.use('*', clientAiAuthMiddleware);
clientAiSessionRoutes.use('*', requireClientAiEnabledMiddleware);

type ClientSessionRow = typeof aiSessions.$inferSelect;

/** The per-route access check: id + type + client principal + org, all in the WHERE. */
async function loadClientSession(
  sessionId: string,
  auth: ClientAiAuthContext,
): Promise<ClientSessionRow | null> {
  const [row] = await db
    .select()
    .from(aiSessions)
    .where(
      and(
        eq(aiSessions.id, sessionId),
        eq(aiSessions.type, 'excel_client'),
        eq(aiSessions.clientUserId, auth.clientUserId),
        eq(aiSessions.orgId, auth.orgId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function auditClient(
  c: Context,
  auth: ClientAiAuthContext,
  event: {
    action: string;
    resourceId?: string | null;
    result?: 'success' | 'denied';
    details?: Record<string, unknown>;
  },
): void {
  writeAuditEvent(c, {
    orgId: auth.orgId,
    action: event.action,
    resourceType: 'ai_session',
    resourceId: event.resourceId ?? null,
    actorType: 'user',
    actorId: auth.clientUserId,
    actorEmail: auth.email,
    result: event.result ?? 'success',
    details: { principalType: 'portal_user', ...(event.details ?? {}) },
  });
}

/** Shared preflight (spec §4 order): rate limits → org budget → partner credits. */
async function runClientPreflight(
  c: Context,
  auth: ClientAiAuthContext,
  policy: ClientAiOrgPolicy,
): Promise<Response | null> {
  const rateError = await checkClientRateLimits(auth.clientUserId, auth.orgId, policy);
  if (rateError) return c.json({ error: rateError }, 429);

  const budgetError = await checkClientBudget(policy);
  if (budgetError) return c.json({ error: budgetError }, 402);

  const creditError = await checkBillingCredits(auth.orgId);
  if (creditError) return c.json({ error: creditError }, 402);

  return null;
}

/**
 * Get-or-create the in-memory SDK session for a client DB session: synthetic
 * org-pinned auth, the workbook-only MCP server (scriptAi.ts:211-215 factory
 * pattern), write-mode-filtered SDK toolset, remaining-budget hard stop, no
 * technician approval-mode prompt injection — then refresh the per-message
 * client fields the tool handlers read.
 */
async function ensureActiveClientSession(
  c: Context,
  sessionRow: ClientSessionRow,
  auth: ClientAiAuthContext,
  policy: ClientAiOrgPolicy,
): Promise<ActiveSession> {
  const maxBudgetUsd = await getRemainingClientBudgetUsd(policy);

  const active = await streamingSessionManager.getOrCreate(
    sessionRow.id,
    {
      orgId: sessionRow.orgId,
      sdkSessionId: sessionRow.sdkSessionId,
      model: sessionRow.model,
      maxTurns: sessionRow.maxTurns,
      turnCount: sessionRow.turnCount,
      systemPrompt: sessionRow.systemPrompt,
    },
    buildClientAuthContext({
      clientUserId: auth.clientUserId,
      orgId: auth.orgId,
      email: auth.email,
      name: auth.name,
    }),
    c,
    sessionRow.systemPrompt ?? buildExcelClientSystemPrompt(policy.writeMode),
    maxBudgetUsd,
    clientMcpToolNamesForWriteMode(policy.writeMode),
    (_getAuth, _onPreToolUse, _onPostToolUse, getSession) => ({
      // The technician pre/post callbacks are deliberately unused: they reject
      // tools absent from TOOL_TIERS (aiAgentSdk.ts:222-225) and encode
      // technician persistence. Client handlers own their pipeline.
      server: createClientWorkbookMcpServer(getSession),
      name: CLIENT_MCP_SERVER_NAME,
    }),
    { injectApprovalModeInstructions: false },
  );

  // Refresh per-message client state read by the tool handlers and the result hook.
  active.clientWriteMode = policy.writeMode;
  active.clientDlpConfig = policy.dlpConfig;
  const { orgId, clientUserId } = auth;
  active.recordExtraUsage = (usage) =>
    withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
      () =>
        recordClientUsage(orgId, clientUserId, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costCents: usage.costCents,
          messageCount: 1,
        }),
    );

  return active;
}

// ============================================
// POST / — create a session (spec §4 pre-flight at create)
// ============================================

clientAiSessionRoutes.post('/', async (c) => {
  const auth = c.get('clientAiAuth');
  const policy = c.get('clientAiPolicy');

  const rejection = await runClientPreflight(c, auth, policy);
  if (rejection) return rejection;

  const model = policy.allowedModels[0] ?? DEFAULT_CLIENT_AI_MODEL;
  const systemPrompt = buildExcelClientSystemPrompt(policy.writeMode);

  const [session] = await db
    .insert(aiSessions)
    .values({
      orgId: auth.orgId,
      userId: null,
      clientUserId: auth.clientUserId,
      type: 'excel_client',
      model,
      systemPrompt,
    })
    .returning({ id: aiSessions.id });

  if (!session) {
    return c.json({ error: 'Failed to create session' }, 500);
  }

  await recordClientUsage(auth.orgId, auth.clientUserId, { sessionCount: 1 });

  auditClient(c, auth, {
    action: 'ai.client_session.create',
    resourceId: session.id,
    details: { model, writeMode: policy.writeMode },
  });

  return c.json({ sessionId: session.id }, 201);
});

// ============================================
// GET /:id — session + (already-redacted) message history
// ============================================

clientAiSessionRoutes.get('/:id', async (c) => {
  const auth = c.get('clientAiAuth');
  const sessionId = c.req.param('id')!;

  const session = await loadClientSession(sessionId, auth);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  // Messages were persisted in redacted form (spec §6) — return them as-is.
  const messages = await db
    .select({
      id: aiMessages.id,
      role: aiMessages.role,
      content: aiMessages.content,
      contentBlocks: aiMessages.contentBlocks,
      toolName: aiMessages.toolName,
      toolInput: aiMessages.toolInput,
      toolOutput: aiMessages.toolOutput,
      toolUseId: aiMessages.toolUseId,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .where(eq(aiMessages.sessionId, sessionId))
    .orderBy(asc(aiMessages.createdAt))
    .limit(500);

  return c.json({
    session: {
      id: session.id,
      status: session.status,
      title: session.title,
      model: session.model,
      turnCount: session.turnCount,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCostCents: session.totalCostCents,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    },
    messages,
  });
});

// ============================================
// POST /:id/close
// ============================================

clientAiSessionRoutes.post('/:id/close', async (c) => {
  const auth = c.get('clientAiAuth');
  const sessionId = c.req.param('id')!;

  const session = await loadClientSession(sessionId, auth);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  // Resolve any parked tool requests first so the SDK loop unblocks, then
  // tear down the in-memory session, then mark the row closed.
  failPendingForSession(sessionId, 'session_closed');
  streamingSessionManager.remove(sessionId);

  await db
    .update(aiSessions)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(aiSessions.id, sessionId));

  auditClient(c, auth, { action: 'ai.client_session.close', resourceId: sessionId });

  return c.json({ success: true });
});
```

- [ ] **Step 5: Mount the router** — in `apps/api/src/routes/clientAi/index.ts`, add the import and route:

```ts
import { clientAiSessionRoutes } from './sessions';
```

and after `clientAiRoutes.route('/admin', clientAiAdminRoutes);`:

```ts
clientAiRoutes.route('/sessions', clientAiSessionRoutes);
```

- [ ] **Step 6: Run, expect PASS** (12 tests)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/sessions.lifecycle.test.ts
```

(`sendClientMessageSchema`/`clientToolResultSchema`/`toClientSseEvent` etc. are imported but the message/events/tool-results routes land in Tasks 11/12 — unused imports would fail lint/tsc `noUnusedLocals`; if so, add the imports in the task that uses them instead. The plan lists them here for the final file shape.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/clientAi/schemas.ts apps/api/src/routes/clientAi/sessions.ts apps/api/src/routes/clientAi/sessions.lifecycle.test.ts apps/api/src/routes/clientAi/index.ts
git commit -m "feat(client-ai): session routes — create/get/close with preflight, metering, audit" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: POST /:id/messages — preflight, DLP chokepoint (a), redact-before-log contract (TDD)

The message ingress. Returns `202 { accepted: true }`; the turn streams over `GET /events`. **This task carries the Plan-3 contract assertion** (Plan 3 Task 6 integration note): the `ai_messages` insert must receive `applyDlp(...).text` and `result.redactions` — never the raw input.

**Files:**
- Modify: apps/api/src/routes/clientAi/sessions.ts (append the route)
- Create: apps/api/src/routes/clientAi/sessions.messages.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/routes/clientAi/sessions.messages.test.ts`

Uses the exact mock preamble from `sessions.lifecycle.test.ts` (Task 10 Step 2 — copy the entire `vi.hoisted` block, the `vi.mock` calls, the imports, `SESSION_ROW`, `selectChain`, `buildApp`, `AUTHED`, and the `beforeEach`). Then add (replacing the lifecycle describes):

```ts
function passthroughDlp() {
  applyDlpMock.mockImplementation(async (input: { text?: string; cells?: unknown[][] }) => ({
    action: 'allow',
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.cells !== undefined ? { cells: input.cells.map((r: unknown[]) => [...r]) } : {}),
    redactions: [],
  }));
}

function makeActiveSession() {
  return {
    state: 'idle',
    orgId: ORG_ID,
    breezeSessionId: SESSION_ID,
    inputController: { pushMessage: vi.fn() },
    eventBus: { publish: vi.fn() },
    toolUseIdQueue: [],
  } as Record<string, unknown>;
}

function postMessage(body: Record<string, unknown>) {
  return buildApp().request(`/client-ai/sessions/${SESSION_ID}/messages`, {
    method: 'POST',
    headers: AUTHED,
    body: JSON.stringify(body),
  });
}

describe('POST /client-ai/sessions/:id/messages', () => {
  let activeSession: ReturnType<typeof makeActiveSession>;

  beforeEach(() => {
    passthroughDlp();
    activeSession = makeActiveSession();
    managerMock.getOrCreate.mockResolvedValue(activeSession);
    managerMock.get.mockReturnValue(undefined);
  });

  it('404s for an inaccessible session', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    expect((await postMessage({ content: 'hi' })).status).toBe(404);
  });

  it('410s when the session is closed', async () => {
    dbSelectMock.mockImplementation(() => selectChain([{ ...SESSION_ROW, status: 'closed' }]));
    expect((await postMessage({ content: 'hi' })).status).toBe(410);
  });

  it('402s on budget exhaustion, 429s on rate limit (preflight per message)', async () => {
    checkClientBudgetMock.mockResolvedValueOnce('Daily AI budget for your organization has been reached ($5.00).');
    expect((await postMessage({ content: 'hi' })).status).toBe(402);

    rateLimiterMock.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
    expect((await postMessage({ content: 'hi' })).status).toBe(429);
  });

  it('accepts a message: persists the user row, pushes to the SDK, starts the turn timeout, audits, 202', async () => {
    const valuesSpy = vi.fn(() => Promise.resolve());
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await postMessage({ content: 'sum column B please' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION_ID, role: 'user', content: 'sum column B please',
    }));
    expect(activeSession.inputController).toMatchObject({});
    expect((activeSession.inputController as { pushMessage: ReturnType<typeof vi.fn> }).pushMessage)
      .toHaveBeenCalledWith('sum column B please');
    expect(managerMock.startTurnTimeout).toHaveBeenCalledWith(activeSession);
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'ai.client_session.message',
        actorId: CLIENT_USER_ID,
        details: expect.objectContaining({ principalType: 'portal_user', workbookContextKind: 'none' }),
      }),
    );
  });

  it('REDACT-BEFORE-LOG CONTRACT (Plan 3 Task 6): persists applyDlp().text + redactions, never the raw input', async () => {
    const RAW = 'card 4111111111111111 please check';
    applyDlpMock.mockResolvedValueOnce({
      action: 'allow',
      text: 'card [REDACTED:creditCard] please check',
      redactions: [{ rule: 'creditCard', count: 1, location: 'text' }],
    });
    const valuesSpy = vi.fn(() => Promise.resolve());
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await postMessage({ content: RAW });
    expect(res.status).toBe(202);

    // applyDlp received the raw text with the policy's dlpConfig + orgId
    expect(applyDlpMock).toHaveBeenCalledWith({ text: RAW, dlpConfig: policyState.policy.dlpConfig, orgId: ORG_ID });

    // Persisted form: result.text + result.redactions (in content_blocks), never the raw value
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      content: 'card [REDACTED:creditCard] please check',
      contentBlocks: expect.arrayContaining([
        { type: 'dlp_redactions', redactions: [{ rule: 'creditCard', count: 1, location: 'text' }] },
      ]),
    }));
    expect(JSON.stringify(valuesSpy.mock.calls)).not.toContain('4111111111111111');

    // The model sees the redacted form too
    const pushed = (activeSession.inputController as { pushMessage: ReturnType<typeof vi.fn> }).pushMessage.mock.calls[0]![0] as string;
    expect(pushed).toContain('[REDACTED:creditCard]');
    expect(pushed).not.toContain('4111111111111111');
  });

  it('DLP block → 400 with the reason, session_error published, audit denied, nothing persisted or pushed', async () => {
    applyDlpMock.mockResolvedValueOnce({
      action: 'block',
      blockReason: 'dlp_blocked:iban',
      redactions: [{ rule: 'iban', count: 1, location: 'text' }],
    });
    managerMock.get.mockReturnValue(activeSession);

    const res = await postMessage({ content: 'acct DE89370400440532013000' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('dlp_blocked');
    expect(body.reason).toBe('dlp_blocked:iban');

    expect((activeSession.eventBus as { publish: ReturnType<typeof vi.fn> }).publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('dlp_blocked:iban') }),
    );
    expect(dbInsertMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ai.client_session.message', result: 'denied' }),
    );
  });

  it('workbookContext cells go through applyDlp and the redacted matrix is persisted + sent', async () => {
    const cells = [['Card'], ['4111111111111111']];
    applyDlpMock
      .mockResolvedValueOnce({ action: 'allow', text: 'summarize this', redactions: [] }) // text pass
      .mockResolvedValueOnce({
        action: 'allow',
        cells: [['Card'], ['[REDACTED:creditCard]']],
        redactions: [{ rule: 'creditCard', count: 1, location: 'cell[1][0]' }],
      }); // cells pass
    const valuesSpy = vi.fn(() => Promise.resolve());
    dbInsertMock.mockImplementation(() => ({ values: valuesSpy }));

    const res = await postMessage({
      content: 'summarize this',
      workbookContext: { kind: 'selection', address: 'A1:A2', cells },
    });
    expect(res.status).toBe(202);

    expect(applyDlpMock).toHaveBeenNthCalledWith(2, { cells, dlpConfig: policyState.policy.dlpConfig, orgId: ORG_ID });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({
      contentBlocks: expect.arrayContaining([
        expect.objectContaining({ type: 'workbook_context', kind: 'selection', address: 'A1:A2', cells: [['Card'], ['[REDACTED:creditCard]']] }),
        expect.objectContaining({ type: 'dlp_redactions' }),
      ]),
    }));

    const pushed = (activeSession.inputController as { pushMessage: ReturnType<typeof vi.fn> }).pushMessage.mock.calls[0]![0] as string;
    expect(pushed).toContain('[Workbook context — Current selection (A1:A2)]');
    expect(pushed).toContain('[REDACTED:creditCard]');
    expect(pushed).not.toContain('4111111111111111');
  });

  it('409s when a message is already processing', async () => {
    managerMock.tryTransitionToProcessing.mockReturnValue(false);
    expect((await postMessage({ content: 'hi' })).status).toBe(409);
  });

  it('auto-titles the session from the first (redacted) message', async () => {
    dbSelectMock.mockImplementation(() => selectChain([{ ...SESSION_ROW, title: null }]));
    const setSpy = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));
    dbUpdateMock.mockImplementation(() => ({ set: setSpy }));

    await postMessage({ content: 'sum column B please' });
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'sum column B please' }));
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (route does not exist → 404s where 202/400 expected)

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/sessions.messages.test.ts
```

- [ ] **Step 3: Append the route to `apps/api/src/routes/clientAi/sessions.ts`**

```ts
// ============================================
// POST /:id/messages — message ingress (spec §4 pre-flight per message;
// DLP chokepoint (a) + workbookContext cells; redact-before-log)
// ============================================

function dlpBlockedResponse(
  c: Context,
  auth: ClientAiAuthContext,
  sessionId: string,
  blockReason: string | undefined,
): Response {
  const reason = blockReason ?? 'dlp_blocked';
  const message = `Your message was blocked by your organization's data protection policy (${reason}).`;
  // Surface on the SSE channel too (pinned contract) when the session is live.
  const active = streamingSessionManager.get(sessionId);
  if (active) {
    active.eventBus.publish({ type: 'error', message });
  }
  auditClient(c, auth, {
    action: 'ai.client_session.message',
    resourceId: sessionId,
    result: 'denied',
    details: { reason },
  });
  return c.json({ error: 'dlp_blocked', reason, message }, 400);
}

clientAiSessionRoutes.post(
  '/:id/messages',
  zValidator('json', sendClientMessageSchema),
  async (c) => {
    const auth = c.get('clientAiAuth');
    const policy = c.get('clientAiPolicy');
    const sessionId = c.req.param('id')!;
    const body = c.req.valid('json');

    const session = await loadClientSession(sessionId, auth);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    if (session.status !== 'active') {
      return c.json({ error: 'Session is no longer active' }, 410);
    }

    const rejection = await runClientPreflight(c, auth, policy);
    if (rejection) return rejection;

    // ── DLP chokepoint (a): the user prompt (templates ride inside it in v1) ──
    const textResult = await applyDlp({
      text: body.content,
      dlpConfig: policy.dlpConfig,
      orgId: auth.orgId,
    });
    if (textResult.action === 'block') {
      return dlpBlockedResponse(c, auth, sessionId, textResult.blockReason);
    }

    // ── workbookContext cells leave Breeze for the provider too — same chokepoint ──
    const redactions: DlpRedactionEvent[] = [...textResult.redactions];
    const wb = body.workbookContext;
    let contextCells: unknown[][] | undefined;
    if (wb && wb.kind !== 'none' && wb.cells) {
      const cellsResult = await applyDlp({
        cells: wb.cells,
        dlpConfig: policy.dlpConfig,
        orgId: auth.orgId,
      });
      if (cellsResult.action === 'block') {
        return dlpBlockedResponse(c, auth, sessionId, cellsResult.blockReason);
      }
      redactions.push(...cellsResult.redactions);
      contextCells = cellsResult.cells;
    }

    const redactedContent = textResult.text ?? body.content;
    let modelContent = redactedContent;
    if (wb && wb.kind !== 'none') {
      const label =
        wb.kind === 'selection'
          ? `Current selection${wb.address ? ` (${wb.address})` : ''}`
          : `Sheet "${wb.sheetName ?? 'unknown'}"`;
      modelContent += `\n\n[Workbook context — ${label}]\n${
        contextCells ? JSON.stringify(contextCells) : '(no cell data provided)'
      }`;
    }

    const activeSession = await ensureActiveClientSession(c, session, auth, policy);

    // Concurrent message guard — atomic check-and-set (ai.ts:467 convention).
    if (!streamingSessionManager.tryTransitionToProcessing(activeSession)) {
      return c.json({ error: 'A message is already being processed for this session' }, 409);
    }

    // Persist the REDACTED form only: result.text + result.redactions
    // (spec §6; Plan 3 Task 6 contract — the raw input is never stored).
    const contentBlocks: Record<string, unknown>[] = [];
    if (redactions.length > 0) {
      contentBlocks.push({ type: 'dlp_redactions', redactions });
    }
    if (wb && wb.kind !== 'none') {
      contentBlocks.push({
        type: 'workbook_context',
        kind: wb.kind,
        address: wb.address ?? null,
        sheetName: wb.sheetName ?? null,
        cells: contextCells ?? null,
      });
    }

    try {
      await db.insert(aiMessages).values({
        sessionId,
        role: 'user',
        content: redactedContent,
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : null,
      });
    } catch (err) {
      console.error('[client-ai] Failed to save user message:', err);
      activeSession.state = 'idle';
      return c.json({ error: 'Failed to save message' }, 500);
    }

    if (!session.title) {
      const title = generateClientSessionTitle(redactedContent);
      try {
        await db.update(aiSessions).set({ title }).where(eq(aiSessions.id, sessionId));
      } catch (err) {
        console.error('[client-ai] Failed to auto-set session title:', err);
      }
    }

    activeSession.inputController.pushMessage(modelContent);
    streamingSessionManager.startTurnTimeout(activeSession);

    auditClient(c, auth, {
      action: 'ai.client_session.message',
      resourceId: sessionId,
      details: {
        contentLength: body.content.length,
        workbookContextKind: wb?.kind ?? 'none',
        redactionCount: redactions.length,
      },
    });

    // The turn streams over GET /:id/events — see sse.ts for the event names.
    return c.json({ accepted: true }, 202);
  },
);
```

- [ ] **Step 4: Run, expect PASS** (9 tests), plus the lifecycle suite stays green:

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/sessions.messages.test.ts src/routes/clientAi/sessions.lifecycle.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clientAi/sessions.ts apps/api/src/routes/clientAi/sessions.messages.test.ts
git commit -m "feat(client-ai): message ingress — per-message preflight, DLP chokepoint, redact-before-log persistence" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: GET /:id/events (SSE) + POST /:id/tool-results (TDD)

The persistent stream and the bridge resolution endpoint. The events route creates the in-memory session when absent (so the add-in can connect right after create — see Design decisions) and never breaks on `turn_complete`: the channel persists across turns until the client disconnects or the session is torn down.

**Files:**
- Modify: apps/api/src/routes/clientAi/sessions.ts (append the two routes)
- Create: apps/api/src/routes/clientAi/sessions.events-toolresults.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/routes/clientAi/sessions.events-toolresults.test.ts`

Same mock preamble as Task 10 Step 2 (copy the `vi.hoisted` block, `vi.mock` calls, imports, `SESSION_ROW`, `selectChain`, `buildApp`, `AUTHED`, `beforeEach`). Then add:

```ts
import { AsyncEventQueue } from '../../utils/asyncQueue';

/** Minimal real-semantics bus for SSE tests (single subscriber). */
class TestEventBus {
  queue = new AsyncEventQueue<unknown>();
  published: unknown[] = [];
  subscribe(_id: string) { return this.queue; }
  unsubscribe(_id: string) { this.queue.close(); }
  publish(e: unknown) { this.published.push(e); this.queue.push(e); }
  closeAll() { this.queue.close(); }
}

function makeStreamingSession() {
  return {
    state: 'idle',
    orgId: ORG_ID,
    breezeSessionId: SESSION_ID,
    inputController: { pushMessage: vi.fn() },
    eventBus: new TestEventBus(),
    toolUseIdQueue: [],
  } as Record<string, unknown>;
}

describe('GET /client-ai/sessions/:id/events', () => {
  it('404s for an inaccessible session', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/events`, { headers: AUTHED });
    expect(res.status).toBe(404);
  });

  it('410s when the session is closed', async () => {
    dbSelectMock.mockImplementation(() => selectChain([{ ...SESSION_ROW, status: 'closed' }]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/events`, { headers: AUTHED });
    expect(res.status).toBe(410);
  });

  it('streams translated client events and persists across turn_complete', async () => {
    const active = makeStreamingSession();
    managerMock.get.mockReturnValue(active);

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/events`, { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // Give the streaming callback a tick to subscribe, then publish a full turn.
    await new Promise((r) => setTimeout(r, 20));
    const bus = active.eventBus as TestEventBus;
    bus.publish({ type: 'content_delta', delta: 'Sure — ' });
    bus.publish({ type: 'tool_request', toolUseId: 'tu-1', toolName: 'read_range', input: { address: 'A1' }, mutating: false });
    bus.publish({ type: 'tool_completed', toolUseId: 'tu-1', toolName: 'read_range', status: 'success', redactions: [] });
    bus.publish({ type: 'done', usage: { inputTokens: 10, outputTokens: 5, costCents: 1 } });
    bus.publish({ type: 'content_delta', delta: 'next turn still streams' }); // proves no break on done
    bus.publish({ type: 'message_start', messageId: 'm1' }); // internal — must be dropped
    await new Promise((r) => setTimeout(r, 20));
    bus.closeAll(); // ends the stream so res.text() resolves

    const text = await res.text();
    expect(text).toContain('event: message_delta');
    expect(text).toContain('event: tool_request');
    expect(text).toContain('event: tool_completed');
    expect(text).toContain('event: turn_complete');
    expect(text).toContain('"costCents":1');
    expect(text).toContain('next turn still streams');
    expect(text).not.toContain('message_start');
  });

  it('creates the in-memory session when absent (connect-before-first-message)', async () => {
    const active = makeStreamingSession();
    managerMock.get.mockReturnValue(undefined);
    managerMock.getOrCreate.mockResolvedValue(active);

    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/events`, { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(managerMock.getOrCreate).toHaveBeenCalled();
    // 9th positional arg pins the client loop config
    const args = managerMock.getOrCreate.mock.calls[0]!;
    expect(args[8]).toEqual({ injectApprovalModeInstructions: false });
    // SDK toolset is the write-mode-filtered client allowlist
    expect(args[6]).toEqual(expect.arrayContaining(['mcp__excel__read_range']));
    expect(args[6]).not.toEqual(expect.arrayContaining(['mcp__breeze__query_devices']));

    await new Promise((r) => setTimeout(r, 20));
    (active.eventBus as TestEventBus).closeAll();
    await res.text();
  });
});

describe('POST /client-ai/sessions/:id/tool-results', () => {
  it('resolves a pending bridge request scoped to THIS session', async () => {
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'tu-1', status: 'success', output: { cells: [['v']] } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resolveToolResultMock).toHaveBeenCalledWith(SESSION_ID, 'tu-1', {
      status: 'success',
      output: { cells: [['v']] },
    });
  });

  it('404s for an unknown/expired toolUseId', async () => {
    resolveToolResultMock.mockReturnValue(false);
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'nope', status: 'success', output: null }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_tool_request' });
  });

  it('404s when the session is not accessible (cross-user guard before any resolution)', async () => {
    dbSelectMock.mockImplementation(() => selectChain([]));
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'tu-1', status: 'success', output: null }),
    });
    expect(res.status).toBe(404);
    expect(resolveToolResultMock).not.toHaveBeenCalled();
  });

  it('400s on an invalid status value', async () => {
    const res = await buildApp().request(`/client-ai/sessions/${SESSION_ID}/tool-results`, {
      method: 'POST',
      headers: AUTHED,
      body: JSON.stringify({ toolUseId: 'tu-1', status: 'pending' }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/sessions.events-toolresults.test.ts
```

- [ ] **Step 3: Append the two routes to `apps/api/src/routes/clientAi/sessions.ts`**

```ts
// ============================================
// GET /:id/events — the persistent SSE channel (spec §4)
//
// Preferred client: fetch-based SSE with the Authorization header. EventSource
// fallback: ?token= (GET-only, clientAiAuthMiddleware). The stream does NOT
// end on turn_complete — it persists across turns until the client
// disconnects or the session is evicted/closed (the bus subscription closes).
//
// NOTE on DB access: loadClientSession runs inside the middleware's
// org-scoped request context; the streaming callback itself does NO DB work
// (it runs after the request transaction commits — the #1105 lesson).
// ============================================

clientAiSessionRoutes.get('/:id/events', async (c) => {
  const auth = c.get('clientAiAuth');
  const policy = c.get('clientAiPolicy');
  const sessionId = c.req.param('id')!;

  const session = await loadClientSession(sessionId, auth);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.status !== 'active') {
    return c.json({ error: 'Session is no longer active' }, 410);
  }

  // Create the in-memory session if absent so the add-in can connect the
  // stream immediately after POST /sessions, before the first message.
  const activeSession =
    streamingSessionManager.get(sessionId) ??
    (await ensureActiveClientSession(c, session, auth, policy));

  const subscriptionId = crypto.randomUUID();

  return streamSSE(c, async (stream) => {
    const events = activeSession.eventBus.subscribe(subscriptionId);

    const ping = setInterval(() => {
      stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {
        /* client gone — the abort handler tears down */
      });
    }, CLIENT_AI_SSE_PING_INTERVAL_MS);

    stream.onAbort(() => {
      clearInterval(ping);
      activeSession.eventBus.unsubscribe(subscriptionId);
    });

    try {
      for await (const event of events) {
        const sse = toClientSseEvent(event);
        if (sse) {
          await stream.writeSSE(sse);
        }
        // Deliberately NO break on 'done' — the channel persists across turns.
      }
    } catch (err) {
      console.error('[client-ai] SSE stream error:', err);
      await stream
        .writeSSE({ event: 'session_error', data: JSON.stringify({ message: 'Stream failed' }) })
        .catch(() => {});
    } finally {
      clearInterval(ping);
      activeSession.eventBus.unsubscribe(subscriptionId);
    }
  });
});

// ============================================
// POST /:id/tool-results — the add-in reports a tool outcome (spec §5 step 2)
//
// Execution/rejection audit + persistence + tool_completed publishing happen
// in the MCP handler (services/clientAiTools.ts) once this resolution lands —
// the route only authenticates, access-checks, and resolves the bridge.
// ============================================

clientAiSessionRoutes.post(
  '/:id/tool-results',
  zValidator('json', clientToolResultSchema),
  async (c) => {
    const auth = c.get('clientAiAuth');
    const sessionId = c.req.param('id')!;

    const session = await loadClientSession(sessionId, auth);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const { toolUseId, status, output } = c.req.valid('json');

    const resolved = resolveClientToolResult(sessionId, toolUseId, {
      status,
      output: output ?? null,
    });
    if (!resolved) {
      // Unknown id, already resolved/timed out, or owned by another session.
      return c.json({ error: 'unknown_tool_request' }, 404);
    }

    return c.json({ ok: true });
  },
);
```

- [ ] **Step 4: Run, expect PASS** (8 tests), plus the other two route suites stay green:

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/sessions.events-toolresults.test.ts src/routes/clientAi/sessions.messages.test.ts src/routes/clientAi/sessions.lifecycle.test.ts
```

(If the SSE-stream test flakes on the 20ms subscribe tick, raise the two `setTimeout` waits to 50ms — the stream callback in `hono/streaming` starts when the ReadableStream is constructed, but scheduling is not guaranteed within one tick.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clientAi/sessions.ts apps/api/src/routes/clientAi/sessions.events-toolresults.test.ts
git commit -m "feat(client-ai): persistent SSE events channel + tool-results bridge resolution" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Final verification sweep

**Files:** none new — verification only.

- [ ] **Step 1: Run every test file this plan added or touched (single command, no full-suite flake)**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run \
  src/services/clientAiDlp.stub.test.ts \
  src/services/streamingSessionManager.clientLoop.test.ts \
  src/services/streamingSessionManager.security.test.ts \
  src/services/clientAiUsage.test.ts \
  src/services/clientAiToolBridge.test.ts \
  src/services/clientAiTools.registry.test.ts \
  src/services/clientAiTools.handler.test.ts \
  src/services/clientAiSessions.test.ts \
  src/middleware/clientAiAuth.queryToken.test.ts \
  src/middleware/clientAiAuth.test.ts \
  src/routes/clientAi/sse.test.ts \
  src/routes/clientAi/sessions.lifecycle.test.ts \
  src/routes/clientAi/sessions.messages.test.ts \
  src/routes/clientAi/sessions.events-toolresults.test.ts
```

Expected: all PASS (~90 tests).

- [ ] **Step 2: Run the Plan-1 suites this plan's edits could regress**

```bash
cd /Users/toddhebebrand/breeze/apps/api
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/ src/services/clientAiPolicy.test.ts
```

Expected: PASS (the schemas.ts append and index.ts mount are additive).

- [ ] **Step 3: Type-check both packages**

```bash
cd /Users/toddhebebrand/breeze/packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm typecheck
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

Expected: only the pre-existing `agents.test.ts` / `apiKeyAuth.test.ts` errors.

- [ ] **Step 4: Smoke the mounted routes against the dev stack (optional but cheap)**

With the dev compose stack running:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost/api/v1/client-ai/sessions \
  -H 'Content-Type: application/json' -d '{}'
```

Expected: `401` (no bearer session) — proves the mount + middleware chain. A full live round-trip needs the add-in (Plan 5) or a scripted SSE client; defer to Plan 5's manual checklist.

- [ ] **Step 5: Commit any straggler fixes**

```bash
git status --short   # should be clean; commit fixes with a fix(client-ai): prefix if not
```

---

## Out of scope for this plan (later plans)

- The real DLP engine (detectors, custom rules, ReDoS guards, action precedence) — Plan 3 replaces `clientAiDlp.ts` internals; the chokepoint call sites and the redact-before-log persistence shape ship HERE and must not move.
- Dashboard surfaces (session/audit viewer reading `content_blocks.dlp_redactions` + `workbook_context` blocks, usage report/CSV over `client_ai_usage`, template manager) — Plan 4.
- The Excel add-in (Office.js executor for the 9 tools, write-preview Apply/Reject cards, fetch-SSE client consuming the `CLIENT_AI_SSE_EVENTS` table, template picker) — Plan 5.
- Multi-provider routing (`allowedProviders` beyond `['anthropic']` is stored but not interpreted; the model picker uses `allowedModels[0]` only) — spec §15.
- SSE replay/Last-Event-ID resume after mid-turn reconnects — v1 reconnect starts from live events only (the add-in re-renders history via `GET /:id`).

## Open questions / accepted risks (for the implementer & reviewer)

1. **Shared LRU pressure**: client sessions share `MAX_ACTIVE_SESSIONS = 200` with technician/helper/script-builder sessions, and `GET /events` eagerly spawns the SDK subprocess. If add-in adoption makes eviction of technician sessions plausible, split the cap (or lazily spawn on first message and accept the connect-after-first-message ordering in Plan 5).
2. **`ai_cost_usage` overlap**: client spend lands in the org-level `ai_cost_usage` via `recordUsageFromSdkResult` (keeps partner credit deduction working) — technician budget caps therefore include client spend. Accepted v1; if MSPs complain, add a `source` dimension to `ai_cost_usage` later.
3. **`allowedModels` is trusted as-is**: the policy editor (Plan 1 admin PUT) accepts arbitrary model strings; an invalid model fails at the SDK/provider level mid-session rather than at preflight. Consider validating against a known-model list in Plan 4's policy editor.
4. **Mid-session `writeMode` flip**: the SDK-level toolset (`options.allowedTools`) is fixed at subprocess creation; flipping the policy to `readonly` mid-session is enforced by the handler's server-side rejection (and takes full toolset effect on the next subprocess spawn). Documented in `clientMcpToolNamesForWriteMode`'s comment.
5. **`?token=` in access logs**: GET-only, header-wins; Plan 5 must use fetch-SSE with the header. If Caddy access-log scrubbing is ever audited, add `token` to the query-param redaction list there.






