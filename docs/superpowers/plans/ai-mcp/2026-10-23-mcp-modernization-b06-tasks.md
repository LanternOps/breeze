---
tracking_issue: LanternOps/breeze#6154
wave_issue: LanternOps/breeze#6160
branch: feature/6154-mcp-modernization/wave-6160
---
# MCP server modernization B-W06: Tasks extension over action intents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Some Tier-3 `tools/call` requests wait for human approval. For those, a `2026-07-28` client that declares the Tasks extension (`io.modelcontextprotocol/tasks`) gets a standard task handle instead of Breeze's own `pending_approval` result. The client's host polls `tasks/get` until the task completes, and can stop it with `tasks/cancel`. The model no longer has to remember to poll `get_action_status`. Every other client is unchanged.

**Architecture:** A task is a read-only view of an existing `mcp_api` action intent.
- The task id is the intent id, and its status comes from B-W04's `toMcpActionStatus`.
- `tasks/get` and `tasks/cancel` run the same ownership load and the same cancel compare-and-swap as `get_action_status` and `cancel_action`.
- There is no second lifecycle and no handle store. The only schema change is one timestamp column, `action_intents.status_changed_at`. A trigger stamps it, so `lastUpdatedAt` is true for every status transition, including ones written by code that does not know about Tasks.
- URL-capable clients still get the approval prompt through B-W04's MRTR exchange on the original `tools/call`. That exchange finishes before the task exists.
- Status is polled, never pushed. The stateless era has no server push channel, and Breeze has no cross-instance event bus for MCP.

**Tech Stack:** TypeScript, Hono, PostgreSQL (one column + one trigger), Drizzle (schema declaration only), Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md`, Feature B → B-W06: "Script runs, patch installs, DR executions, exports return task handles when the client declares the extension; existing polling tools stay". The B-W04 row adds "Tasks handle for clients that declare Tasks" on the same intent row.

Source issue #6145 §2: "Handles must be authorized per call (a handle is a name, not a capability). Client support is still thin — ship behind capability detection, keep the polling tools."

Hand-off seam: B-W04 plan D-B36.

Wire contract checked 2026-10-23 against the Tasks extension, SEP-2663 (`modelcontextprotocol/ext-tasks` `specification/2026-07-28/tasks.md`):
- **Declaring.** The client declares the extension on each request, at `params._meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"] = {}`. The server declares it in `server/discover` `capabilities.extensions`.
- **`CreateTaskResult`.** `{ resultType: "task", taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs? }`.
- **Statuses.** `working | input_required | completed | cancelled | failed`.
  - `completed` carries `result`, which is the `CallToolResult`.
  - `failed` carries `error`, which is a JSON-RPC error. It MUST NOT be used for anything else.
- **`tasks/get {taskId}`.** Returns a **flat** `Result & DetailedTask`, with `resultType: "complete"`.
- **`tasks/update {taskId, inputResponses}` and `tasks/cancel {taskId}`.** Both return an empty ack. Cancellation is cooperative.
- **Streamable HTTP headers.** For `tasks/get`, `tasks/update` and `tasks/cancel`, the client MUST set `Mcp-Name` to `params.taskId`.
- **Errors.**
  - An unknown `taskId` → `-32602`.
  - A request that did not declare the extension MUST NOT receive a `CreateTaskResult`. Its `tasks/*` calls get `-32021` with `data.requiredCapabilities.extensions["io.modelcontextprotocol/tasks"] = {}`.
- **Server obligations.**
  - It MUST authorize every task request.
  - It SHOULD finish MRTR before returning `CreateTaskResult`.
  - It MUST NOT return `CreateTaskResult` before `tasks/get` would resolve.
  - It MAY discard a task after `ttlMs`.
  - There is no `tasks/list`.

**Tracking:** `get_feature_status LanternOps/breeze#6154`, then `start_wave` on #6160. One PR on the wave branch, body `Closes #6160`, `Refs #6145`.

## Lands after B-W05 (sequential, not parallel)

**B-W06 starts from a `main` that contains B-W05 (#6159).** The two waves have no functional dependency. Apps is a presentation for a tier-1 read tool. Tasks is a presentation for a Tier-3 intent. What ties them is shared parsing and dispatch code. They are not file-disjoint. Both edit:
- `McpDispatchContext` and `handleJsonRpc`'s method switch, in `routes/mcpServer.ts`;
- `buildDiscoverResult`'s `capabilities`, in `services/mcpModernResult.ts`;
- `services/mcpClientExtensions.ts`, where B-W05 creates `parseMcpClientExtensions` and B-W06 adds `tasks`.

Running them in parallel would mean two branches reshaping the same three seams. B-W05 is the smaller wave, and #6145's suggested order puts it first.

Before Task 1, check `main`:
- run `git log origin/main --oneline | grep -i "B-W05"`;
- confirm `parseMcpClientExtensions`, `McpDispatchContext.resolveClientExtensions` and B-W05's `extensions` slot in `buildDiscoverResult` exist.

If B-W05 has not merged, **stop** and do not re-implement it here. If Todd wants Tasks first, swap the order. Then B-W06 Task 2 creates `mcpClientExtensions.ts` with `tasks` only, and B-W05 adds `ui` to it.

Verified on `origin/main` `afcb08c2d4` (2026-10-23), pre-B-W05. Re-grep every symbol before editing.

| Seam (as built) | Where | What B-W06 does with it |
|---|---|---|
| `fileMcpActionIntent(...)` → `createMcpActionIntent` → `buildPendingApprovalResult`. URL-capable modern clients get MRTR via `buildApprovalInputRequiredResult`, and a sealing failure falls back to pending | `routes/mcpServer.ts:~2230-2285` | A tasks-declaring request gets `CreateTaskResult` in place of the pending result |
| `handleToolsCallContinuation`. Not terminal after the wait → `buildPendingApprovalResult(current)`. Terminal → inline `{content, structuredContent: status, isError?}` | `routes/mcpServer.ts:~2296-2416`, terminal render `:2399-2412` | Not terminal → `CreateTaskResult` when declared. The terminal renderer is extracted (Task 2) and shared |
| `toMcpActionStatus`, `mapIntentStatus`, `isIntentOutcomeUncertain`, `buildPendingApprovalResult` | `services/mcpActionStatus.ts:71-154` | The only status mapping the task projection uses |
| `loadOwnedMcpIntent(auth, actionId)`. `cancelOwnedMcpIntent(auth, actionId, appBaseUrl)` → `not_found \| cancelled \| not_cancellable` | `services/mcpIntentCreation.ts:202`, `:231` | `tasks/get` / `tasks/cancel` ownership + cancel |
| `canOwnMcpIntents(auth, apiKey)` (`:1353`). `handleActionStatusCall` / `handleCancelActionCall` (`ai:read`; cancel `ai:write` or `ai:execute`; `-32602 'Action not found' {reason:'not_found'}`) | `routes/mcpServer.ts:~1350`, `:2418`, `:2437` | The gate template for `tasks/*` |
| `decorateModernResult` keeps only `input_required` on `tools/call`, otherwise forces `resultType: 'complete'` | `services/mcpModernResult.ts:48-66` | Must also keep `'task'` |
| SEP-2243 name-bearing methods (`tools/call`, `prompts/get`, `resources/read`) | `services/mcpModernEnvelope.ts:130-137` | Adds `tasks/get|update|cancel` → `params.taskId`, only when Tasks are effective |
| `action_intents` times: `createdAt`, `decidedAt`, `executionStartedAt`, `executedAt`, `expiresAt` (24 h for `mcp_api`). No `updated_at`. Cancel (`intentService.ts:3332`) and the stale-executing reaper (`jobs/intentExpiryReaper.ts:319`) change only `status`/`error_code` | `db/schema/actionIntents.ts:376-422` | Why D-B50 adds `status_changed_at` |
| `action_intents_block_content_update` trigger: a deny-list of immutable content columns | `migrations/2026-10-16-193700-action-intents-external-tool.sql:47` | The new column is not on it (mutable lifecycle data). The new trigger is separate |
| Tool-output retention nulls `action_intents.result` of terminal intents past the org window | `jobs/aiToolOutputRetention.ts:232-250` | A completed task may later report its status without a result (D-B49) |
| Per-message limiter `mcp:msg:<principal>`, `MCP_MESSAGE_RATE_LIMIT_PER_MINUTE` (120), production only | `routes/mcpServer.ts:594-604` | Budget-aware `pollIntervalMs` (D-B52) |
| Per-call MCP knobs kept out of `config/env.ts` | `services/mcpIntentConfig.ts` | New readers |
| *(B-W05)* `parseMcpClientExtensions`, `resolveClientExtensions`, `extensions` in `buildDiscoverResult` | `services/mcpClientExtensions.ts`, `mcpServer.ts`, `mcpModernResult.ts` | `tasks` added beside `ui` |

**Migration:** one, slot `apps/api/migrations/2027-01-03-110000-action-intents-status-changed-at.sql` (Task 1). `origin/main`'s newest on 2026-10-23 is `2027-01-03-100000-ai-credit-debits.sql` (#9491), which already sorts after the `2027-01-02-19xxxx`–`21xxxx` slots in flight. Re-check `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail` before committing and move the slot past anything newer.

---

## Advisor quorum, 2026-10-23

**Procedure.** I wrote a position first: S1–S11 for this wave, P1–P11 for B-W05, and nine questions, all against `afcb08c2d4`. Codex `gpt-6-astra` at `xhigh`, read-only, critiqued it in the same run as B-W05.

**Verdicts (B-W06).** S1 and S11: **agree**. S2, S3, S4, S5, S7, S8, S9 and S10: **agree-with-changes**. S6: **disagree**.

**Two blocking findings, adopted and verified by reading the code and the spec:**
1. **S6 — a derived `lastUpdatedAt` is false.** Cancellation changes only `status` (`intentService.ts:3332`), and the stale-executing reaper changes only `status`/`error_code` (`intentExpiryReaper.ts:319`). So a timestamp derived from `decidedAt`/`executionStartedAt`/`executedAt` misses real transitions. `executedAt` must not be repurposed, because it decides `outcomeUncertain`. → D-B50 adds a nullable `status_changed_at` column. A `BEFORE UPDATE` trigger stamps it on every status change, which covers every writer by construction. Approval expiry and task retention are kept as separate contracts (D-B49).
2. **S5 — the transport rule was missing.** Streamable `tasks/get|update|cancel` require `Mcp-Name = params.taskId`, and today's SEP-2243 validator does not know task methods (`mcpModernEnvelope.ts:130`). → D-B51 adds them to the validator only while Tasks are effective, so the flag-off behaviour (`-32601`/404) is unchanged.

**Other adopted changes:**
- **S1:** say explicitly that unattended Tier-3 principals never get tasks.
- **S2:** add a "handler finished; the device operation may still be running" message for tools whose result is a job handle.
- **S3:** one extracted terminal renderer.
- **S4:**
  - Specify the dismiss/absent and sealing-failure paths.
  - An approved or executing replay never re-prompts.
  - The task is built from the committed row, after a reload.
- **S5:**
  - Keep cancellation available to `ai:execute`, as `cancel_action` does today.
  - Validate the request shape before ignoring `inputResponses`.
  - Never swallow an unknown id or an infrastructure failure into the ack.
- **S7 — budget-aware poll intervals.** With 20 live tasks polled every 5 s, one credential would send 240 requests/min against a 120/min limiter.
- **S8:** audit action names are `mcp.tasks.get` and so on, with the task id bounded.
- **S9:** `tasks/get` is flat too, so the task's own `ttlMs` sits at the result's top level and must survive decoration.
- **S10:** task reads and cancellation keep working when only Tier-3 intent creation is switched off. That matches B-W04's drain behaviour.

**Q6 ("too thin?").** Both reviewers think it is worth shipping. Handing the approval wait and handler completion to the host is the long part over MCP. The narrower scope versus the spec's "script runs, patch installs, DR, exports" is stated in D-B56 and tracked as a follow-up.

**Q9.** A column on the existing `action_intents` needs a migration and an export-policy classification. It needs no new tenancy registration.

**Disagreements left open:** none.

## Decisions

Numbering continues B-W05's D-B38…D-B46.

- **D-B47 — What becomes a task: intent-backed Tier-3 calls only, modern era only.**
  - A `tools/call` returns a task only when all of these hold:
    - `mcpTasksEffective()` (D-B55) and `mcpTier3IntentsEnabled()`;
    - the modern era;
    - this request declares `io.modelcontextprotocol/tasks`;
    - the call reached B-W04's intent branch, and `createMcpActionIntent` returned a created or replayed **live** intent (`pending_approval | approved | executing`).
  - Everything else is unchanged:
    - Tier 1/2 tools stay synchronous. `export_dataset` is synchronous already, and `generate_report generate` (tier 2) returns a `runId` at once.
    - **Unattended principals** (`MCP_UNATTENDED_TIER3_PRINCIPALS`) bypass intents and still execute directly. They never get a task.
    - Ineligible calls still get `MCP_APPROVAL_REQUIRED`.
    - Terminal replays still return their status.
  - **Why this scope:** over MCP, the long wait is the human approval (minutes to 24 h) plus the release. Intent rows already persist that wait, with ownership, cancel and expiry.
  - The `2025-11-25` experimental core Tasks (`params.task`, `tasks/result`, `tasks/list`) are **not** implemented. Legacy-era clients keep `pending_approval` + `get_action_status` (Gate B 2).
- **D-B48 — The task id is the intent id.**
  - It is a server-generated UUID v4 (122 random bits). It is never a bearer token. Every `tasks/*` call re-runs auth and `loadOwnedMcpIntent`, which binds the id to the origin credential (`source = 'mcp_api'` plus `origin_principal_kind/id`). A leaked task id is useless to any other credential, including the same human's other key (#6145: "a handle is a name, not a capability").
  - `get_action_status({ actionId: taskId })` keeps working on the same id. A client that loses Tasks support, or a model that is handed the id, can still poll.
- **D-B49 — One projection: `toMcpTask(intent, appBaseUrl, knobs)` over `toMcpActionStatus`.**

  | Intent (via `toMcpActionStatus`) | Task `status` | Fields |
  |---|---|---|
  | `pending_approval` | `working` | `statusMessage` `Waiting for approval in the Breeze mobile or web app: <approvalUrl>`; `pollIntervalMs` budgeted from 30 000 |
  | `in_progress` (approved / executing) | `working` | `statusMessage` `Approved — running.`; `pollIntervalMs` budgeted from 5 000 |
  | `completed` | `completed` | `result` = `buildTerminalActionResult(status)`; for tools in `MCP_TASK_FOLLOW_UP_TOOLS`, `statusMessage` = `Started. The device operation may still be running — check it with <pollTool>.` |
  | `failed`, `rejected`, `expired` | `completed` | `result` = `buildTerminalActionResult(status)` (`isError: true`) |
  | `cancelled` | `cancelled` | — |

  - **One terminal renderer.** `buildTerminalActionResult` is extracted verbatim from the continuation's inline terminal rendering (`mcpServer.ts:2399-2412`):
    - `completed` → `content: [{ type: 'text', text: status.result ?? JSON.stringify(status) }]`, `structuredContent: status`;
    - otherwise → `content: [{ type: 'text', text: JSON.stringify(status) }]`, `structuredContent: status`, `isError: true`.

    `structuredContent` is the `McpActionStatus` wrapper, not parsed tool data, exactly as today. The URL-accept path and Tasks render a terminal outcome with the same bytes. Secrets stay withheld by `toMcpActionStatus`.
  - **`MCP_TASK_FOLLOW_UP_TOOLS`** (`services/mcpTasks.ts`) is a closed map from a tool whose handler returns a job handle to its polling tool:
    - `execute_dr_plan` → `get_dr_execution_status`
    - `trigger_backup` → `get_backup_status`
    - `manage_patches` → `manage_patches (action "device_history")`
    - `run_script` → `get_script_execution`, only when the result contains `"status":"timeout"`
  - **Tasks `failed` is never used.** A failed, rejected or expired action is a tool-level outcome (`completed` + `isError`). The spec reserves `failed` for JSON-RPC errors. The `isError` result carries `errorCode` and `outcomeUncertain`.
  - **Tasks `input_required` is never used.** For URL-capable clients, the approval prompt is B-W04's pre-task MRTR exchange, which the spec recommends. The decision itself happens in the Breeze app, not in the client. Re-presenting it inside a task would need per-task "already answered" state, because request keys can never be reused, and it would add nothing. This narrows B-W04 D-B36's "`pending_approval` ↔ Tasks `input_required`" note on purpose (Gate B 3).
  - **Times.**
    - `createdAt` = `intent.createdAt`.
    - `lastUpdatedAt` = `intent.statusChangedAt ?? max(createdAt, decidedAt, executionStartedAt, executedAt)`. The fallback is only for rows older than the migration.
    - `ttlMs` = `(intent.expiresAt − intent.createdAt) + mcpTaskTtlGraceMs()` (default 1 h): the approval window plus one hour for release and execution. That is the client's backstop.
  - **Retention is a separate contract.** `tasks/get` resolves as long as the intent row exists and the caller owns it, which is longer than `ttlMs` (the spec allows that). After the org's tool-output retention window, `aiToolOutputRetention` nulls `result` on terminal intents. A completed task then reports `completed` with the status-only text, and no result is invented.
- **D-B50 — One column: `action_intents.status_changed_at`, stamped by a trigger.** (Quorum blocking fix.)
  - The migration (Task 1) does four things:
    - `ADD COLUMN IF NOT EXISTS status_changed_at timestamptz` (nullable, no default in the ADD, so existing rows stay NULL and nothing is backfilled or rewritten);
    - `ALTER COLUMN status_changed_at SET DEFAULT now()` (new rows);
    - `CREATE OR REPLACE FUNCTION action_intents_stamp_status_changed_at()`: on `UPDATE`, `NEW.status_changed_at := CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN clock_timestamp() ELSE OLD.status_changed_at END`. So no application write can forge or clear it. `clock_timestamp()`, not `now()`: `now()` is the transaction start, and a long release-worker transaction could otherwise stamp a time earlier than a transition a client already observed;
    - `DROP TRIGGER IF EXISTS … ; CREATE TRIGGER action_intents_stamp_status_changed_at BEFORE UPDATE ON action_intents FOR EACH ROW EXECUTE FUNCTION action_intents_stamp_status_changed_at()`.
  - There are no row writes, so the migration has no `breeze.scope` line. It is idempotent and has no inner transaction.
  - A trigger rather than an application sweep, because there are many status writers: `transitionIntent`, `cancelActionIntent`'s inlined compare-and-swap, the expiry and stale-executing reapers, the decide path, and the release worker. A sweep would miss the next one.
  - Drizzle: `statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).defaultNow()` in `db/schema/actionIntents.ts`, beside `dispatchStartedAt`. The trigger is declared in SQL only, the precedent being `action_intents_block_content_update`. Then `pnpm db:check-drift`.
  - Tenancy:
    - `action_intents` is already in `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:260`) and `orgMergeRegistry.ts:271`, and a column changes neither.
    - `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:76`) gains `status_changed_at` under `included`, a non-sensitive lifecycle timestamp like `decided_at`.
    - It is not `json`, `jsonb` or `bytea`, so it is not `excludedOpen`.
  - Trade-off (Gate B 7): the alternative is a derived `lastUpdatedAt` with documented staleness on cancel and reap. Both reviewers rejected it.
- **D-B51 — Wire flows.**
  - **Declared Tasks, no `elicitation.url`.**
    - `tools/call` → intent filed, then reloaded with `loadOwnedMcpIntent` → `CreateTaskResult` (`working`). The reload means the timestamps are the committed row's and `tasks/get` already resolves.
    - If the reload unexpectedly returns `null`, the client gets B-W04's pending result. A filed intent never becomes an error.
  - **Declared Tasks and `elicitation.url`.**
    - A pending intent → B-W04 `input_required` (unchanged).
    - An approved or executing replay → `CreateTaskResult` directly, with no prompt.
    - A sealing failure → `CreateTaskResult`, where B-W04 would return pending.
    - On the retry:
      - `accept` → the bounded wait (unchanged). If the outcome is terminal, the client gets `buildTerminalActionResult` (unchanged bytes). If it is still live, the client gets `CreateTaskResult`.
      - `decline` → B-W04's cancel outcome (unchanged).
      - `cancel` (dismissed) or an absent `inputResponses` → `CreateTaskResult` if the intent is live, `buildTerminalActionResult` if it is terminal.
  - **Not declared on this request:** byte-identical to B-W04 + B-W05.
  - **Gate order for `tasks/get` / `tasks/update` / `tasks/cancel`.**
    1. The existing preflight (`ai:read`) runs first.
    2. Does this request declare the extension? If not → `-32021` `Tasks extension required`, `data: { requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } } }`. No DB read.
    3. Is `params.taskId` a string of ≤ 64 characters? If not → the not-found body.
    4. `canOwnMcpIntents(auth, apiKey)`, else not-found.
    5. `tasks/cancel` only: `ai:write` or `ai:execute`, with the exact `cancel_action` scope error.
    6. `tasks/update` only: `inputResponses`, if present, must be a plain object, else `-32602 { reason: 'invalid_input_responses' }`. Its keys are then ignored, because no input request is ever outstanding (D-B49).
    7. `loadOwnedMcpIntent`; null → `-32602 'Task not found' { reason: 'not_found' }`. Unknown, foreign and malformed ids all get the same body (no oracle).
    8. Act:
       - `tasks/get` → `toMcpTask(intent)`, flat, decorated with `resultType: 'complete'`.
       - `tasks/cancel` → `cancelOwnedMcpIntent`. `cancelled` and `not_cancellable` → `{}` (cooperative: an executing intent keeps running and later reports its real end). `not_found` → the not-found body.
       - `tasks/update` → `{}`.
    - A DB or infrastructure error anywhere → the same `-32000` body `get_action_status` / `cancel_action` use today (re-grep the exact strings), logged and sent to Sentry. It is never an empty ack.
  - **Streamable HTTP header:** `classifyMcpRequest` treats `tasks/get|update|cancel` as name-bearing, with `Mcp-Name` mirroring `params.taskId`, **only** when `mcpTasksEffective()`. A mismatch → the existing `400 header_mismatch`. When Tasks are not effective the methods are not name-bearing, and today's `-32601` (HTTP 404, B-W03 D-B16) is unchanged.
  - **Tasks not effective** (flag off, or stateless off): `tasks/*` → today's `-32601`, no `CreateTaskResult`, nothing advertised. `get_action_status` keeps working.
- **D-B52 — Polling with a request budget; no streaming.**
  - The modern era is request/response only (`mcpServer.ts:1170-1204`), and nothing sends server-initiated notifications.
  - `SessionEventBus` (`services/sessionEventBus.ts`, AI chat W1 #9852) cannot carry intent transitions across API instances: it is in-process, per chat session and typed `AiStreamEvent`.
  - `subscriptions/listen` / `notifications/tasks` are not implemented or advertised. Push over a Redis fan-out from `intent_outbox` is a follow-up if polling proves too chatty (Gate B 4).
  - **Budget.**
    - `pollIntervalMs = max(base, ceil(liveCount × 60 000 / floor(perMinuteLimit / 2)))`.
    - `base` is 30 000 while pending and 5 000 while running.
    - `liveCount` is the caller origin's live `mcp_api` intents, counted on B-W04's `action_intents_live_origin_idx`.
    - `perMinuteLimit` is `mcpMessageRateLimitPerMinute()` (`MCP_MESSAGE_RATE_LIMIT_PER_MINUTE`, 120). The limiter is enforced only in production (`mcpServer.ts:594`); the interval is budgeted identically everywhere, so lab numbers match production.
    - So polling uses at most half the credential's message budget. With 20 live tasks, each polls every 20 s.
  - `tasks/*` never charge the per-tool rate limit or the B-W04 creation quotas.
- **D-B53 — Audit.**
  - There is no new audit family. `dispatchAndAudit` already writes one row per request, with actions `mcp.tasks.get`, `mcp.tasks.update` and `mcp.tasks.cancel` (`buildMcpAuditAction` turns `/` into `.`, `mcpServer.ts:373`).
  - `details` gain `taskId` on `tasks/*` (only when it passed the ≤ 64-char shape check) and `taskResult: true` on a `tools/call` that returned a `CreateTaskResult`.
  - The intent's own audit trail is unchanged.
  - A winning `tasks/cancel` is recorded by `cancelActionIntent`'s existing audit.
- **D-B54 — Result decoration.**
  - `decorateModernResult` keeps `resultType: 'task'` on `tools/call`, the same way it keeps `input_required`.
  - `tasks/*` are not cacheable. The task's own top-level `ttlMs` is the task lifetime, and it is never overwritten. `cacheScope` is never added.
  - `resolveMcpHttpStatus` returns 200 for a `CreateTaskResult`.
- **D-B55 — Flags and knobs.** All of these are in `services/mcpIntentConfig.ts` and read per call. Each is validated in `config/validate.ts` and documented in root `.env.example`.
  - `MCP_TASKS_ENABLED` (default **off**).
  - `mcpTasksEffective()` = `MCP_TASKS_ENABLED` ∧ `MCP_STATELESS_ENABLED`. It gates advertisement, `tasks/*` and the header rule.
  - Creating a task additionally needs `MCP_TIER3_INTENTS_ENABLED`. When intents are off, existing tasks stay readable and cancellable, which matches B-W04's drain behaviour.
  - `MCP_TASK_PENDING_POLL_INTERVAL_MS` (30 000; 1 000–600 000).
  - `MCP_TASK_POLL_INTERVAL_MS` (5 000; 1 000–60 000).
  - `MCP_TASK_TTL_GRACE_MS` (3 600 000; 60 000–86 400 000).
- **D-B56 — Device follow-through is out of scope.** An intent is `completed` when the tool handler returns (`jobs/intentReleaseWorker.ts:1650`).
  - `run_script` and `execute_command` wait for the device inside the handler, up to 60 s per device (`aiToolsScripts.ts:734`). Their task completes with the device result, or with `status: 'timeout'` plus `executionId`.
  - `execute_dr_plan`, `trigger_backup` and `manage_patches install` complete once the work is queued. Their ids are in the task result, and the D-B49 follow-up message names the polling tool. The existing polling tools stay.
  - Holding the task `working` until the device or job finishes would be a second projection over four more tables (`script_executions`, DR executions, backup jobs, `patch_jobs`), each with its own tenancy and cancel semantics. It is a follow-up issue, filed when this wave lands (Gate B 1).

## Open Decisions (Gate B — for Todd)

The plan's default is in brackets and is what the tasks implement.

1. **Device follow-through.** [No: a task ends when the intent ends, and its result and `statusMessage` point at the existing polling tool. File a follow-up.] Alternative: hold the task `working` until the referenced DR execution, backup job, patch job or timed-out script execution is terminal.
2. **Legacy `2025-11-25` experimental Tasks.** [Not implemented.] Alternative: map `params.task` / `tasks/result` / `tasks/list` onto the same projection for legacy sessions.
3. **`input_required` inside a task.** [Never: the approval prompt is the pre-task MRTR exchange, and a pending task is `working` with the approval URL in `statusMessage`.] Alternative: present the URL elicitation as the task's `inputRequests`, with a per-task "answered" marker in Redis.
4. **Push.** [Polling only, budget-aware.] Alternative: `subscriptions/listen` + `notifications/tasks` over a Redis fan-out from `intent_outbox`.
5. **Poll intervals and TTL grace.** [30 s pending, 5 s running, each raised by the budget; +1 h grace.]
6. **Rollout.** [Off in the release that ships it. Turned on together with `MCP_TIER3_INTENTS_ENABLED` and `MCP_STATELESS_ENABLED` in EU after the lab run, then in US.]
7. **`status_changed_at` column.** [Add it, stamped by a trigger (quorum blocking fix).] Alternative: no migration, with `lastUpdatedAt` derived from existing stamps. That is stale for cancelled and reaped intents.

---

## Global Constraints

- **Commands.**
  - Unit tests: `cd apps/api && npx vitest run <path>`. It is a substring match, so check the file count. Never use `pnpm --filter <pkg> test -- --run <path>`.
  - Integration tests: `cd apps/api && npx vitest run --config vitest.integration.config.ts <file>`, on a per-worktree stack.
  - Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` and `npx tsc --build tsconfig.tests.json; echo "exit=$?"`.
- **One lifecycle.** Only `cancelActionIntent` (via `cancelOwnedMcpIntent`) changes an intent on a Tasks path. The trigger stamps; it never decides. The task projection is a pure function of an intent row.
- **One mapping.** Task status is derived only from `toMcpActionStatus` output, never from raw `intent.status`.
- **A handle is a name.** Every `tasks/*` call runs the D-B51 gate order. Unknown and foreign ids get identical answers.
- **Never weaker than `get_action_status` / `cancel_action`.** Same scopes, same domain, same principal exclusions.
- **Byte-identity when off or undeclared.** When Tasks are not effective, in the legacy era, or on a request that does not declare the extension, every response equals B-W04 + B-W05 output, SEP-2243 header handling included.
- **Migration.** Keep `2027-01-03-110000` unless `main` has moved past it. `scripts/check-migration-naming.sh` runs pre-commit; if it rejects, take the next free `HHMMSS` and say so in the PR. The migration writes no rows, so no `breeze.scope` line. Then run `pnpm db:check-drift`.
- **Public repo.** Test URLs `https://app.example.com`. No customer names.
- **New services file trap.** Classify `services/mcpTasks.ts` in `parkedFanout.contract.test.ts` (Lint job).
- **Commits.** Commit after every task. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage explicitly.

## Tenancy (read `docs/agents/tenancy-rls.md` first)

| Change | Table | Registration impact |
|---|---|---|
| Column `status_changed_at timestamptz` (nullable, default `now()` for new rows) | `action_intents` (RLS forced; cascade/merge/export registered) | `CORE_TENANT_EXPORT_POLICY` `action_intents.included` += `status_changed_at`. Cascade and merge: none (column, not table) |
| Trigger `action_intents_stamp_status_changed_at` | `action_intents` | None |
| Reads via `loadOwnedMcpIntent` | `action_intents` | None |

Run `tenant-export-policy`, `tenantCascade*` and `rls-coverage` on the wave stack (Task 6). The export-policy suite fails only under **Integration Tests**.

## Review Focus

1. **The same human calls `tasks/get` with a task id from another of their API keys**, or from their OAuth grant. → `-32602 not_found`, identical to a random UUID. Test: `taskId from another credential is not found` (Task 4).
2. **A request declared Tasks on `tools/call` but not on the later `tasks/get`.** → `-32021` with `requiredCapabilities`, no status leak, no DB read. Test: `undeclared tasks/get → -32021` (Task 4).
3. **`tasks/cancel` while the intent is `executing`.** → ack `{}`. The intent keeps executing. The next `tasks/get` reports the real end, with `lastUpdatedAt` moving when it does. Test: `cancel during execution acks and does not lie` (Task 4).
4. **An intent is cancelled in the web app, or reaped as stale, while a client polls.** → `tasks/get` shows `cancelled`, or `completed` + `isError`, and `lastUpdatedAt` equals the transition time. Test: `status_changed_at stamps every status writer` (Task 1, integration).
5. **20 live tasks on one credential.** → each `pollIntervalMs` ≥ 20 000, so polling stays within half of the 120/min message budget. Test: `poll interval honours the message budget` (Task 2).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2027-01-03-110000-action-intents-status-changed-at.sql` (new) | Column, default, stamping trigger. |
| `apps/api/src/db/schema/actionIntents.ts` (modify) | `statusChangedAt`. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` (modify) | `status_changed_at` → `included`. |
| `apps/api/src/services/mcpTasks.ts` (new) | `MCP_TASKS_EXTENSION_ID`, `McpTask`, `toMcpTask`, `budgetedPollIntervalMs`, `MCP_TASK_FOLLOW_UP_TOOLS`, `buildCreateTaskResult`, `MCP_TASK_NOT_FOUND`, `buildTasksExtensionRequiredData`. Pure. |
| `apps/api/src/services/mcpActionStatus.ts` (modify) | `buildTerminalActionResult(status)` extracted from the continuation. |
| `apps/api/src/services/mcpIntentCreation.ts` (modify) | `countLiveMcpIntentsForOrigin(auth)` (reads `action_intents_live_origin_idx`). |
| `apps/api/src/services/mcpClientExtensions.ts` (modify, B-W05) | `McpClientExtensions.tasks`. |
| `apps/api/src/services/mcpIntentConfig.ts` (modify) | Flag + knobs. |
| `apps/api/src/services/mcpModernResult.ts` (modify) | Keep `resultType: 'task'`; advertise in `buildDiscoverResult`. |
| `apps/api/src/services/mcpModernEnvelope.ts` (modify) | `tasks/*` name-bearing when effective. |
| `apps/api/src/routes/mcpServer.ts` (modify) | Task branches in intent filing + continuation; `tasks/get|update|cancel`; audit details. |
| `apps/api/src/config/validate.ts`, root `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`, `apps/api/src/system/connections/internalEnvVars.ts` (modify) | The four env vars: validated (with the stateless-off warning), documented, passed into the container. |
| `apps/docs/src/content/docs/features/mcp-server.mdx` (modify) | "Tasks (2026-07-28 clients)". |

---

### Task 1: `status_changed_at` — migration, schema, export policy

**Files:** Create the migration and `apps/api/src/__tests__/integration/actionIntentsStatusChangedAt.integration.test.ts`. Modify `db/schema/actionIntents.ts`, `services/tenantExportPolicyRegistry.ts`.

**Interfaces — Produces:** `ActionIntent.statusChangedAt: Date | null`. The DB stamps it on every status change. No application code writes it.

- [ ] **Step 1: Write the failing integration test** (real Postgres; seed one org and intents through the existing intent-service helpers):
  - `status_changed_at stamps every status writer`: one `it.each` over `cancelActionIntent`, the approve decide path, `transitionIntent` executing→completed, the expiry reaper and the stale-executing reaper. Before each transition, read the row and set `status_changed_at` to `now() - interval '1 hour'` through `withSystemDbAccessContext`. After it, `status_changed_at > before`.
  - `an UPDATE that does not change status keeps status_changed_at` (e.g. `result = NULL` as retention does).
  - `an application write cannot forge it`: `UPDATE … SET status_changed_at = '2000-01-01'` without a status change leaves it unchanged.
  - `a newly created intent has status_changed_at set (column default)`. (That pre-migration rows stay NULL is a property of the `ADD COLUMN` without a default; it is reviewed in the SQL, not tested.)
- [ ] **Step 2:** On the wave stack (`pnpm wt-stack up`, see Task 6 Step 3 for the env), run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/actionIntentsStatusChangedAt.integration.test.ts`. Expect FAIL: the column does not exist.
- [ ] **Step 3: Implement** the migration (D-B50 text), the Drizzle column and the export-policy entry.
- [ ] **Step 4:** Migrate the stack. Then run the test above, `pnpm db:check-drift`, and `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`. All should PASS.
- [ ] **Step 5:** Commit `feat(action-intents): status_changed_at stamped on every status change (B-W06 #6160)`.

### Task 2: Pure layer — `mcpTasks.ts`, `buildTerminalActionResult`, knobs, decoration, envelope

**Files:** Create `services/mcpTasks.ts` + `mcpTasks.test.ts`. Modify these, each with its test:
- `services/mcpActionStatus.ts`;
- `services/mcpClientExtensions.ts`: `tasks` is true iff `extensions['io.modelcontextprotocol/tasks']` is a plain object, `{}` included;
- `services/mcpIntentConfig.ts` (its `mcpIntentConfig.test.ts` does not exist yet — create it);
- `services/mcpModernResult.ts`;
- `services/mcpModernEnvelope.ts`;
- `services/mcpIntentCreation.ts`;
- `config/validate.ts` (validate the four vars; **warn at boot** when `MCP_TASKS_ENABLED` is on but `MCP_STATELESS_ENABLED` is off, a silent no-op otherwise), `.env.example`, `parkedFanout.contract.test.ts`;
- **container passthrough** — without it none of the four vars reach a deployed stack or the lab: `docker-compose.yml` (beside `MCP_TIER3_INTENTS_ENABLED`, `:626`) and `deploy/docker-compose.prod.yml` (beside `:595`) get `MCP_TASKS_ENABLED`, `MCP_TASK_PENDING_POLL_INTERVAL_MS`, `MCP_TASK_POLL_INTERVAL_MS`, `MCP_TASK_TTL_GRACE_MS` as `${VAR:-}`; `apps/api/src/system/connections/internalEnvVars.ts` (`:319-322`) labels them (`'MCP rollout flag'` / `'rate limit knob'`). Guards: `src/config/envReadComposeCoverage.test.ts`, `src/system/connections/envInventory.test.ts`;
- widening `McpClientExtensions` to `{ ui, tasks }` touches B-W05 code and tests deliberately, in this task: `NO_MCP_CLIENT_EXTENSIONS` gains `tasks: false`; `readLegacySessionExtensions` returns `{ ui, tasks: false }` (legacy never has Tasks); the legacy side-key payload stays `'{"ui":true}'` and is parsed for `ui` only; every B-W05 `toEqual({ ui: … })` assertion gains `tasks: false`.

**Interfaces — Produces:**
```ts
// mcpTasks.ts
export const MCP_TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';
export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'cancelled' | 'failed'; // full spec union; only working|completed|cancelled produced
export type McpTask = { taskId: string; status: McpTaskStatus; statusMessage?: string; createdAt: string; lastUpdatedAt: string;
  ttlMs: number; pollIntervalMs?: number; result?: Record<string, unknown> };
export type McpTaskKnobs = { pendingPollMs: number; runningPollMs: number; ttlGraceMs: number; liveCount: number; perMinuteLimit: number };
export const MCP_TASK_FOLLOW_UP_TOOLS: Readonly<Record<string, { pollTool: string; when?: (resultText: string) => boolean }>>;
export function budgetedPollIntervalMs(base: number, liveCount: number, perMinuteLimit: number): number;
export function toMcpTask(intent: Pick<ActionIntent, 'id'|'status'|'actionName'|'approvalScope'|'createdAt'|'expiresAt'|'decidedAt'
  |'executionStartedAt'|'executedAt'|'statusChangedAt'|'result'|'errorCode'>, appBaseUrl: string, knobs: McpTaskKnobs): McpTask;
export function buildCreateTaskResult(task: McpTask): Record<string, unknown>;   // { resultType: 'task', ...task } minus result
export const MCP_TASK_NOT_FOUND: { reason: 'not_found' };
export const MCP_TASK_ID_MAX_CHARS = 64;
export function buildTasksExtensionRequiredData(): { requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': Record<string, never> } } };
// mcpActionStatus.ts
export function buildTerminalActionResult(status: McpActionStatus): { content: [{ type: 'text'; text: string }]; structuredContent: McpActionStatus; isError?: true };
// mcpIntentConfig.ts
export function mcpTasksEnabled(): boolean;                        // MCP_TASKS_ENABLED, default false
export function mcpTasksEffective(): boolean;                      // mcpTasksEnabled() && mcpStatelessEnabled()
export function mcpTaskPendingPollIntervalMs(): number;            // 30_000, [1_000, 600_000]
export function mcpTaskPollIntervalMs(): number;                   // 5_000, [1_000, 60_000]
export function mcpTaskTtlGraceMs(): number;                       // 3_600_000, [60_000, 86_400_000]
export function mcpMessageRateLimitPerMinute(): number;            // MCP_MESSAGE_RATE_LIMIT_PER_MINUTE, 120 — the same value mcpServer.ts:600 reads (switch that call site to this reader)
// mcpIntentCreation.ts
export function countLiveMcpIntentsForOrigin(auth: AuthContext): Promise<number>;   // origin from mcpOriginRef; 0 when none
// mcpClientExtensions.ts
export type McpClientExtensions = { readonly ui: boolean; readonly tasks: boolean };
```
- [ ] **Step 1: Write the failing tests.**
  ```ts
  it.each([
    ['pending_approval', 'working', 30_000], ['approved', 'working', 5_000], ['executing', 'working', 5_000],
    ['completed', 'completed', undefined], ['failed', 'completed', undefined], ['rejected', 'completed', undefined],
    ['expired', 'completed', undefined], ['cancelled', 'cancelled', undefined],
  ])('intent %s → task %s (poll %s)', (s, t, poll) => { const task = toMcpTask(intent({ status: s }), BASE, KNOBS_1_LIVE);
    expect(task.status).toBe(t); expect(task.pollIntervalMs).toBe(poll); expect(task.taskId).toBe(intent().id); });
  it('never produces failed or input_required', ...);            // every ActionIntentStatus
  it('pending statusMessage carries the approval URL', () => expect(toMcpTask(intent({ status: 'pending_approval' }), BASE, KNOBS_1_LIVE).statusMessage).toContain(`${BASE}/approvals#intent-${ID}`));
  it('completed/failed result equals buildTerminalActionResult(toMcpActionStatus(...))', ...);
  it('failed with executedAt → isError result carrying outcomeUncertain true', ...);
  it('secret-bearing task result is withheld', ...);              // m365_reset_password → resultWithheld 'secret_bearing', no sealed marker in the JSON
  it('completed with result nulled by retention reports status text only', ...);
  it.each([['execute_dr_plan', 'get_dr_execution_status'], ['trigger_backup', 'get_backup_status']])('%s completion names %s', ...);
  it('run_script names get_script_execution only on timeout', ...);
  it('lastUpdatedAt prefers statusChangedAt; falls back to the latest stamp when null', ...);
  it('ttlMs = expiresAt - createdAt + grace', ...);
  it('poll interval honours the message budget', () => { expect(budgetedPollIntervalMs(5_000, 20, 120)).toBe(20_000); expect(budgetedPollIntervalMs(30_000, 1, 120)).toBe(30_000); });
  it('buildCreateTaskResult has resultType task and no result', ...);
  it('buildTerminalActionResult reproduces the continuation bytes', ...);   // fixtures copied from mcpServer.urlElicitation.test.ts expectations
  // mcpModernResult.test.ts
  it('decoration keeps the task envelope', () => { const out = decorateModernResult('tools/call', buildCreateTaskResult(task));
    expect(out.resultType).toBe('task'); expect(out.ttlMs).toBe(task.ttlMs); expect(out).not.toHaveProperty('cacheScope'); });
  it('tasks/get results are complete, flat and keep the task ttlMs', ...);
  it('discover advertises tasks only when mcpTasksEffective, beside B-W05 ui; no extensions key when neither', ...);
  // mcpModernEnvelope.test.ts
  it('tasks/* are name-bearing (Mcp-Name = params.taskId) only when Tasks are effective', ...);   // mismatch → 400 header_mismatch when on; when off, the same request classifies exactly as today
  // mcpClientExtensions.test.ts
  it.each([[{ extensions: { [MCP_TASKS_EXTENSION_ID]: {} } }, true], [{ extensions: { [MCP_TASKS_EXTENSION_ID]: true } }, false], [{}, false]])('tasks declared: %j → %s', ...);
  ```
  ```ts
  // config/validate.test.ts
  it('warns at boot when MCP_TASKS_ENABLED is on without MCP_STATELESS_ENABLED', ...);
  ```
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/mcpTasks.test.ts src/services/mcpActionStatus.test.ts src/services/mcpClientExtensions.test.ts src/services/mcpIntentConfig.test.ts src/services/mcpModernResult.test.ts src/services/mcpModernEnvelope.test.ts src/services/mcpIntentCreation.test.ts src/config/validate.test.ts` → FAIL. (Step 4 adds `src/config/envReadComposeCoverage.test.ts src/system/connections/envInventory.test.ts`.)
- [ ] **Step 3: Implement.** `classifyMcpRequest` gets the effectiveness as an input (the same way it gets `statelessEnabled`), so it stays pure.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(mcp): task projection over action intents, Tasks knobs and header rule (B-W06 #6160)`.

### Task 3: `tools/call` returns a task to declaring clients

**Files:**
- Modify `routes/mcpServer.ts`:
  - **`fileMcpActionIntent`.** After a created or replayed live outcome, return a task when D-B47 holds, using the D-B51 sub-cases:
    - URL elicitation does not apply → task;
    - an approved or executing replay → task;
    - a seal failure → task.

    Build it with `loadOwnedMcpIntent`, then `buildCreateTaskResult(toMcpTask(row, base, knobs))`. A `null` reload falls back to `buildPendingApprovalResult`.
  - **`handleToolsCallContinuation`.** A live outcome after `accept`, `cancel` or absent `inputResponses` → task under the same condition. Replace the inline terminal rendering with `buildTerminalActionResult(current)`; this refactor changes no behaviour.
  - **Audit.** Add `details.taskResult: true`.
- Create `routes/mcpServer.tasks.test.ts`. Copy the harness from `mcpServer.urlElicitation.test.ts` and set `MCP_STATELESS_ENABLED`, `MCP_TIER3_INTENTS_ENABLED` and `MCP_TASKS_ENABLED` to `true`.

**Interfaces:** Consumes Task 2 and B-W04 `createMcpActionIntent`, `loadOwnedMcpIntent`, `toMcpActionStatus`.

- [ ] **Step 1: Write the failing tests.**
  - `declared tasks, no elicitation.url: Tier-3 call returns resultType task, taskId = the intent id, status working, statusMessage has the approval URL, createdAt = the committed row's created_at`.
  - `replayed live call returns a task with the same taskId and charges no creation quota`; `approved/executing replay → task without any prompt, even for elicitation.url clients`.
  - `declared tasks + elicitation.url: pending → input_required (unchanged); accept + still live after the wait → task; accept + terminal within the wait → buildTerminalActionResult bytes; dismissed/absent → task; decline → B-W04 cancel outcome; seal failure → task`.
  - `not declared on this request, legacy era, MCP_TASKS_ENABLED off, or MCP_STATELESS_ENABLED off → today's results byte-identical` (`it.each`).
  - `terminal replay, ineligible call and unattended principal never return a task`.
  - `audit details carry taskResult: true only on task results`; `HTTP 200 for a task result`.
  - `reload returns null → B-W04 pending_approval result, never an error` (mock `loadOwnedMcpIntent` → `null` after a successful filing).
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/mcpServer.tasks.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Green, plus `src/routes/mcpServer.urlElicitation.test.ts src/routes/mcpServer.approvalGate.test.ts src/routes/mcpServer.actionStatus.test.ts src/routes/mcpServer.modern.test.ts` unchanged and green.
- [ ] **Step 5:** Typecheck; commit `feat(mcp): Tier-3 calls return a task handle to Tasks-capable clients (B-W06 #6160)`.

### Task 4: `tasks/get`, `tasks/update`, `tasks/cancel`

**Files:**
- Modify `routes/mcpServer.ts`. In the `handleJsonRpc` switch, add three cases. They apply only in the modern era when `mcpTasksEffective()`; otherwise they fall through to the existing `default`.
- Add `handleTasksGet`, `handleTasksUpdate` and `handleTasksCancel` beside `handleActionStatusCall` (`:2418`), each following the D-B51 gate order.
- **Domain gate — decided, not conditional:** `tasks/*` behave exactly like `get_action_status`/`cancel_action`, whose domain is `core` (`mcpDomains.ts:66`), and `isDomainGranted` is always true for `core` (`:55`). So no domain grant can lock a credential out of reading or cancelling its own task, and no grant widens anything (ownership is the gate). `handleJsonRpc` has no method-level domain gate today (only the `ai:read` preflight, `:624`), so nothing is added to `mcpDomains.ts`; the test below pins the parity unconditionally.
- Audit: add `details.taskId` **only when it matches the UUID regex** `loadOwnedMcpIntent` uses; any other value is omitted (it is caller-controlled text).
- Extend `routes/mcpServer.tasks.test.ts`.

**Interfaces:** Consumes Task 2, `loadOwnedMcpIntent`, `cancelOwnedMcpIntent`, `countLiveMcpIntentsForOrigin`.

- [ ] **Step 1: Write the failing tests.**
  - `tasks/get maps every intent status`: table-driven, real handler, mocked rows. Assert the flat shape and `resultType: 'complete'`.
  - `taskId from another credential is not found`: `it.each` over an unknown UUID, a 65-character string, a number, another key's intent, the same user's OAuth-grant intent, a chat-source intent and another org's intent. Every case must deep-equal `-32602 'Task not found' {reason:'not_found'}`.
  - `undeclared tasks/get → -32021 with requiredCapabilities` for all three methods. The check must run before ownership, so the DB spy is never called.
  - `partner service principal and org service key → not found` (`canOwnMcpIntents`).
  - `tasks/get and tasks/update need ai:read`. `tasks/cancel needs ai:write or ai:execute`: an `ai:execute`-only key may cancel, an `ai:read`-only key may not.
  - `tasks/cancel on pending → {}`, the intent is cancelled, and the next `tasks/get` → `cancelled`.
  - `cancel during execution acks and does not lie`: for an `executing` intent → `{}`, intent unchanged. Once it later completes, `tasks/get` reports `completed`.
  - `tasks/update acks {} and ignores well-formed inputResponses`, with no write (spies on `cancelActionIntent`/`transitionIntent`). A non-object `inputResponses` → `-32602 invalid_input_responses`.
  - `a DB failure in tasks/get or tasks/cancel → the get_action_status -32000 body, never {}`.
  - `MCP_TIER3_INTENTS_ENABLED off: existing tasks remain readable and cancellable; no new task is created`.
  - `Tasks not effective or legacy era: tasks/* are -32601 exactly as today (modern HTTP 404)`.
  - `tasks/* never charge checkToolRateLimit or the intent creation limiter`.
  - `tasks/get pollIntervalMs reflects the caller's live count` (mocks `countLiveMcpIntentsForOrigin` → 20 → ≥ 20 000).
  - `get_action_status({actionId: taskId}) and tasks/get agree on status for every intent status`.
  - `an immediate tasks/get after a task result resolves`.
  - `a key with mcp_domains=['devices'] can tasks/get and tasks/cancel its own task` (unconditional domain parity with `get_action_status`).
  - `audit: mcp.tasks.get carries taskId only when it is a UUID` — a valid id → present; a 64-char junk string with newline/markup bytes → `details.taskId` absent.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/mcpServer.tasks.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Green, plus `src/routes/mcpServer.domains.test.ts src/routes/mcpServer.test.ts src/__tests__/mcp-coverage.test.ts`.
- [ ] **Step 5:** Typecheck; commit `feat(mcp): tasks/get, tasks/update and tasks/cancel over owned intents (B-W06 #6160)`.

### Task 5: Conformance and parity contracts

**Files:** Modify `routes/mcpServer.conformance.contract.test.ts` (stateless block), and `routes/mcpServer.statelessParity.contract.test.ts` (a new documented-exception describe beside the B-W04 one at `:371`).

- [ ] **Step 1: Add the cases.** Prove each one discriminates: temporarily drop the `clientExtensions.tasks` condition, watch it go red, then restore it.
  - **Conformance, modern, Tasks effective.**
    - `server/discover` lists `extensions['io.modelcontextprotocol/tasks']`.
    - A declaring Tier-3 call → `CreateTaskResult` → `tasks/get` with a matching `Mcp-Name` → `working`.
    - A mismatched `Mcp-Name` → 400.
    - When not effective: no tasks key in discover, and `tasks/get` → `-32601`/404.
  - **Parity, documented exception.** `Tier-3 call by a Tasks-capable modern client → task vs legacy/capability-less → pending_approval`. Every other parity fixture declares no tasks extension; assert that.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/mcpServer.conformance.contract.test.ts src/routes/mcpServer.statelessParity.contract.test.ts` → PASS. Record the discrimination red in the commit message.
- [ ] **Step 3:** Commit `test(mcp): Tasks conformance and parity contracts (B-W06 #6160)`.

### Task 6: Round trip, docs, gates, lab, PR

**Files:** Extend `apps/api/src/__tests__/integration/mcpIntentRoundTrip.integration.test.ts` (B-W04). Modify `apps/docs/src/content/docs/features/mcp-server.mdx` and the plan index row.

- [ ] **Step 1: Integration round trip.** Real Postgres, all three flags on, a modern request declaring tasks. Each scenario below must pass.
  - **Approve and release.** The Tier-3 `tools/call` → `CreateTaskResult`. `tasks/get` → `working` (pending). Decide as approver, run `processIntentReleaseJob`, and `tasks/get` → `completed`. Its result must equal `get_action_status`'s, and `lastUpdatedAt` must equal the row's `status_changed_at`.
  - **Cancel while pending.** `tasks/cancel` → `cancelled`.
  - **Cancel in the web app.** The intent is cancelled via `cancelActionIntent` as the web app would. `tasks/get` → `cancelled`, with `lastUpdatedAt` advanced.
  - **Second credential.** Another API key of the same user calls `tasks/get` → not found.
  - **Prove the high-blast-radius scenarios discriminate** (the code they exercise already exists from Tasks 1–4, so red is shown by mutation): temporarily (a) make `handleTasksGet` load the intent by id without `loadOwnedMcpIntent`'s origin match and watch **Second credential** go red; (b) make `toMcpTask` ignore `statusChangedAt` and watch **Cancel in the web app** go red. Restore both; record the two reds in the commit message.
- [ ] **Step 2: Docs.** Add a "Tasks (2026-07-28 clients)" subsection. It covers:
  - which calls become tasks;
  - the D-B49 status table;
  - that `get_action_status` works on the same id;
  - polling only, with a budget;
  - the four env vars.
- [ ] **Step 3: Gates.**
  - Run the API unit suite in small batches and record the counts from the real output.
  - Run both typechecks and record their exit codes.
  - Bring up a per-worktree stack with `pnpm wt-stack up`. Copy the root `.env` with the AI keys blanked, set `BREEZE_WORKSPACE_ENABLED=false`, and pick a free `BREEZE_DOCKER_SUBNET=172.31.N.0/24` plus `BREEZE_CADDY_IP`.
  - On that stack, run with `--config vitest.integration.config.ts`: `actionIntentsStatusChangedAt`, `mcpIntentRoundTrip`, `tenant-export-policy`, `tenantCascade.integration.test.ts` and its `tenantCascade*` siblings, and `intentFanout`.
  - Run `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  - Run `pnpm db:check-drift`.
  - Then `pnpm wt-stack down`, and say what was left running.
- [ ] **Step 4: Lab.** Use the same stack with all three flags on.
  - **Tasks only.** Send a raw `curl` with SEP-2243 headers (including `Mcp-Name` on `tasks/*`) and `_meta` declaring `io.modelcontextprotocol/tasks`. Expect a task. Approve it in the web inbox, then `tasks/get` → completed.
  - **Tasks plus `elicitation: { url: {} }`.** Expect `input_required`. Open the URL but do **not** approve, then retry with `accept`. After the 20 s wait you should get a task.
  - If a public client ships the Tasks extension by then, run it as well (claude-code #102347 tracks Claude Code).
  - Record the outcomes in the PR.
- [ ] **Step 5: PR.** Title `feat(mcp): B-W06 Tasks extension over action intents (#6154)`. The body has:
  - `Closes #6160`, `Refs #6145`;
  - the migration name;
  - a D-B47…D-B56 summary;
  - the Gate B decisions, with the defaults taken;
  - the D-B56 follow-up issue (the orchestrator files it; link it in the body).

  A base that is not `main` → `gh workflow run CI --ref <branch>`.
- [ ] **Step 6:** Run one `/pr-review-toolkit:review-pr` round. Update the plan index row.

---

## Exit checklist

- [ ] The B-W05 seams were confirmed on `main` before Task 1.
- [ ] The migration name was accepted, `pnpm db:check-drift` is clean, and the export-policy suite is green on the stack.
- [ ] On every Tasks path, the only intent write is `cancelOwnedMcpIntent`. Task status comes only from `toMcpActionStatus`.
- [ ] Not effective, legacy or undeclared: every response is byte-identical to B-W04 + B-W05, including SEP-2243 header handling.
- [ ] `tasks/*`: undeclared → `-32021`. Unknown and foreign → identical `-32602`. Infrastructure errors → the `get_action_status` `-32000` body, never `{}`.
- [ ] `decorateModernResult` keeps `resultType: 'task'` and never touches the task's `ttlMs`.
- [ ] Green: conformance, parity, `mcp-coverage`, `mcpServer.urlElicitation`, `mcpServer.actionStatus` and `parkedFanout.contract`. Green on the stack: the round trip, `status_changed_at`, cascade and `rls-coverage`.
- [ ] Lab recorded; stack torn down.

## CI traps

- `pnpm test` runs none of the integration suites. The `status_changed_at`, round-trip and export-policy suites fail only under **Integration Tests**.
- A new `services/` file needs its `parkedFanout.contract.test.ts` classification. It fails the Lint job.
- `tsc | tail` masks an OOM, so always `echo "exit=$?"`. CI's `tsc --build tsconfig.tests.json` catches strict-index errors in tests.
- In the modern era `-32601` is HTTP 404 (B-W03 D-B16). A test asserting 200 for a disabled `tasks/get` is wrong.
- `aiTools.userOwnedRelease.contract.test.ts` keys `SAFE_WRITE_SITES` by line number in `jobs/intentReleaseWorker.ts`. This wave does not edit the worker; if a rebase does, re-pin those lines.
- A stacked PR (base ≠ `main`) gets no CI until `gh workflow run CI --ref <branch>`.
