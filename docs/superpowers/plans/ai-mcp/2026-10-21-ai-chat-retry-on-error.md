# AI Chat "Try again" on Timeout / Error Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an AI chat turn fails with a retryable error (timeout, disconnect, 5xx/provider error), show a "Try again" button on both chat surfaces that resubmits the last user message without a duplicate user bubble or a duplicate persisted user row; say "This response timed out" for timeouts.

**Architecture:** The `error` stream event gains a machine `code` (and optional `detail`) so the client stops guessing from message strings. A small web classifier (`lib/aiErrors.ts`) maps `code` → retryable. Both stores get a `retryLastTurn` action that re-runs `sendMessage` with `{ retry: true }`, which skips the optimistic bubble client-side and sends `retry: true` so the API skips re-inserting an identical trailing user row. One shared `AiErrorBanner` component replaces the two inline banners.

**Tech Stack:** Zod (`packages/shared`), Hono API (`apps/api`), Zustand + React (`apps/web`), Vitest, react-i18next (8 locales).

**Spec:** Issue #9428 (no separate spec; the issue is the spec). Cluster anchor #9427 (move conversations between surfaces) is **out of scope**; this plan only touches the failure path of a single surface's own turn. Related, not blocking: #6474 (keep-alives, prevents some timeouts), #7772 (server-side backup-model replay), #7594 (thinking progress).

**Wave:** single wave (W1). Independently shippable; does not depend on #9429.

> **Deviation from "web-only expected":** this needs a small API change (event `code` + `retry` flag). Reason, with citations, is in "Findings" below. A web-only fallback is Decision 1.

## Findings (verified on main @ 30e8ee7c44)

- `processStreamEvent` `case 'error'` is `set(() => ({ error: event.message, isStreaming: false }))` (`apps/web/src/stores/processStreamEvent.ts:305`). Shared by `aiStore` (SSE loop `aiStore.ts:630-655`) and `workspaceStore` (`workspaceStore.ts:343-405`).
- The shared event is `{ type: 'error'; message: string }` only (`packages/shared/src/types/ai.ts:314`). **There is no error code today**; the only way to classify is regex on message text.
- Client-originated failures: `aiStore.sendMessage` catch → `error: err.message, isStreaming:false` (`aiStore.ts:656-663`); `workspaceStore.sendMessage` catch (`workspaceStore.ts:413-418`). HTTP failure thrown as plain `Error` with no status (`aiStore.ts:608`, `workspaceStore.ts:324`).
- `aiStore` already has `errorCode: string | null` for HTTP refusal codes (`aiStore.ts:60`); `TabState` in `workspaceStore.ts:20-49` has none.
- **The API persists the user message before streaming** (`apps/api/src/routes/ai.ts` `db.insert(aiMessages)…role:'user'`, ~:1058-1062), after the turn slot is won (`tryTransitionToProcessing`, :1045). So after a stream failure the user row already exists server-side.
- **A timeout does NOT stop the turn**: the non-topology timeout path publishes `error`+`done` and sets `state='idle'` but leaves the SDK query running (`streamingSessionManager.ts:1474-1484`, comment ~:1460). `tryTransitionToProcessing` only checks `state` (:837), so a retry POST wins the slot and its prompt queues **behind the still-live turn**; the old turn's late events/`done` (:1958-1966) would reach the retry's SSE subscriber. Model context comes from the SDK session (`sdkSessionId`, :1031/:1307), not `ai_messages`, so the DB dedupe below protects only the persisted transcript, not what the model sees. The topology timeout already tears the session down (`this.remove`, :1466-1473). **Retry therefore must start from a torn-down query** (Task 3).
- **A client disconnect does not stop the turn either**: the server keeps running and saves `assistant`/`tool_use` rows (`routes/ai.ts` inserts ~:1766/:1806). Blindly resending after `disconnect` can re-run a finished turn (tool calls included, e.g. in auto-approve mode). `retryLastTurn` for `disconnect`/`stream_error` must reload the session first (Task 5).
- **No resubmit idempotency**: each POST reserves budget under `chat:${sessionId}:${crypto.randomUUID()}` (`routes/ai.ts:981`), and `sendAiMessageSchema` has no key (`packages/shared/src/validators/ai.ts:71`). A plain resend would insert a second identical user row and double the message in model context.
- Concurrent turn guard: 409 `turn_in_progress` (`routes/ai.ts:989`) and bare 409 "A message is already being processed" (`routes/ai.ts:~1049`). Both clients already drop the optimistic bubble on 409 (`aiStore.ts:580-605`, `workspaceStore.ts:313-320`) — **a retry must not run that filter against the original bubble** (Task 5/6 tests).
- Server `error` publish sites (all in `apps/api/src/services/streamingSessionManager.ts`; this is the table the codes are added to):

| Line | Situation | `code` | Retryable |
|---|---|---|---|
| 961 | provider/model config changed, "please resend" (published on the old bus before the new request subscribes, so the client effectively never receives it; coded for completeness) | `config_changed` | no (dead path) |
| 1470 | topology turn timeout | `timeout` | no (topology surface owns its flow; hidden when `topologySiteId !== null`) |
| 1480 | turn timeout (`detail` = gateway note, #7794) | `timeout` | yes |
| 1502 | topology investigation limit | `topology_limit` | no |
| 1516, 1993 (topology branch) | topology could not complete | `topology_failed` | no |
| 1919 | per-query budget limit | `budget_exceeded` | no |
| 1921 | max conversation turns | `max_turns` | no |
| 1924, 1946, 1993 (non-topology) | provider/gateway error; map `providerFailure.cause` (`aiModels/providerFailureMessage.ts:12-18`): `overloaded`/`server_error`/null -> `provider_error` (retryable); `rate_limited` -> `rate_limited` (no); `auth_failed` -> `provider_auth` (no); `quota_exhausted` -> `provider_quota` (no) | per cause | per cause |
| `routes/ai.ts:1143` | route `streamSSE` catch writes `{type:'error'}` with no code and **no `done`** | `stream_error` | yes (reload-first) |
| 2482 | session expired (24h) | `session_expired` | no |
| 2546 | evicted for capacity | `session_evicted` | no |

- Client-originated codes (no server event): thrown fetch/reader error → `disconnect` (yes); HTTP ≥ 500 → `http_5xx` (yes); 429 → `rate_limited` (no, see Decision 4); other non-OK incl. 403 permission / 400 validation → `rejected` (no). Model refusal is **not** an `error` event (`model_refusal`, `processStreamEvent.ts:501`) so it never shows the button. Unknown or absent code → not retryable (safe default).
- Surfaces: side panel banner `AiChatSidebar.tsx:365-375`; workspace banner `WorkspaceChatPanel.tsx:104-113`. Strings live in `apps/web/src/locales/<locale>/ai.json` (`aiChatSidebar`, `workspaceChatPanel`); `localeParity.test.ts` in `apps/web/src/lib/i18n` enforces 8 locales (en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR).
- `no-silent-mutations.test.ts`: retry reuses the existing store POST (no new `fetchWithAuth` call site, no new component calling a mutating fetch), so nothing is added to `TARGET_GLOBS` or the backlog; the test is run to prove it. Failures from retry surface through the same `error` state (this *is* the outcome surface), so no `runAction` wrapper is introduced.

## Global Constraints

- Retry resends the **last user message of the same session**; never creates a new session.
- No duplicate user bubble client-side; no duplicate persisted user row server-side.
- Hidden for: permission denied, budget/quota exceeded, content refused, session expired/evicted, topology turns.
- Timeout copy is exactly: `This response timed out` (en). New en keys → all 8 locales in the same commit.
- No new `fetchWithAuth` mutation outside the existing `sendMessage` POST.

## Review Focus

- Retry while a turn is still streaming or loading: button must not render and `retryLastTurn` must no-op (double-click must not send twice).
- Retry after a mid-stream failure leaves a half-streamed assistant bubble (`isStreaming: true` stuck): retry must finalize it, not leave a spinner.
- Retry that gets 409 (`turn_in_progress`) must keep the original user bubble (the existing 409 handlers delete the optimistic bubble by id).
- Org switch / session rebind between failure and click: retry must act only on the session that failed (`sessionId` captured in the error; no-op if it changed).
- A server older than the web build (no `code` on `error`): banner falls back to the plain message with no button, never throws.

---

## File Structure

- Modify `packages/shared/src/types/ai.ts` (error event), `packages/shared/src/validators/ai.ts` (`retry`).
- Modify `apps/api/src/services/streamingSessionManager.ts` (codes), `apps/api/src/routes/ai.ts` (retry dedupe).
- Create `apps/web/src/lib/aiErrors.ts` — `AiErrorCode`, `isRetryableAiError`, `classifyHttpFailure`.
- Modify `apps/web/src/stores/processStreamEvent.ts`, `aiStore.ts`, `workspaceStore.ts`.
- Create `apps/web/src/components/ai/AiErrorBanner.tsx`; modify `AiChatSidebar.tsx`, `workspace/WorkspaceChatPanel.tsx`.
- Modify `apps/web/src/locales/*/ai.json` (×8).
- Tests: alongside each file (`*.test.ts[x]`).

---

### Task 1: Shared contract (event code + retry flag)

**Files:**
- Modify: `packages/shared/src/types/ai.ts:314`, `packages/shared/src/validators/ai.ts:71`
- Test: `packages/shared/src/validators/ai_messages.test.ts` (existing `sendAiMessageSchema` suite, ~:228). Red is real today: `z.object` strips an unknown `retry`, so `retry:'yes'` does not throw.

**Interfaces:**
- Produces: `AiStreamEvent` error member `{ type: 'error'; message: string; code?: string; detail?: string }`; `sendAiMessageSchema` accepts `retry?: boolean`.
- `code` is typed `string` on the wire (forward compatible); the closed union lives web-side in Task 4.

- [ ] **Step 1: Failing test** — `sendAiMessageSchema.parse({ content: 'x', retry: true })` returns `retry: true`; `parse({ content: 'x', retry: 'yes' })` throws.
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/validators/ai_messages.test.ts` → FAIL (`retry` stripped / not rejected).
- [ ] **Step 3:** Add `retry: z.boolean().optional()` to `sendAiMessageSchema`; widen the `error` union member as above.
- [ ] **Step 4:** Re-run → PASS. `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` in `packages/shared` → `exit=0`.
- [ ] **Step 5: Commit** `feat(shared): AI error event code/detail + message retry flag (#9428)`.

### Task 2: API publishes `code` on every error site

**Files:**
- Modify: `apps/api/src/services/streamingSessionManager.ts` at the lines in the Findings table
- Test: extend the closest existing suite (e.g. `streamingSessionManager.*.test.ts` that already drives the turn timeout and result-error paths; mirror its harness)

**Interfaces:**
- Produces: every `eventBus.publish({ type: 'error', … })` carries `code` per the table, including the route catch at `routes/ai.ts:1143`. `detail` carries `gatewayNote` at **every** site that has one (:1480, :1924, :1946, :1993) and `message` is always the stock text at those sites (older web builds keep working; one rule everywhere).
- Existing tests that must be updated in this task: `streamingSessionManager.gatewayFailure.test.ts` (~:149, expects the note inside `message`) and `streamingSessionManager.topologyOutput.test.ts` (~:356, exact-equality `toContainEqual({type:'error', message})`).

- [ ] **Step 1: Failing tests** — one per code: timeout → `{code:'timeout'}`; timeout with gateway note → `detail` set, `message` stock; `error_max_budget_usd` → `budget_exceeded`; `error_max_turns` → `max_turns`; generic result error → `provider_error`; catch path → `provider_error`; topology branches → `topology_failed`; expiry → `session_expired`; eviction → `session_evicted`; config change → `config_changed`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/streamingSessionManager` → FAIL (`code` undefined).
- [ ] **Step 3:** Add `code` (and `detail`) at each site; for provider failures derive the code from `providerFailure.cause` via a small `providerErrorCode(cause)` helper. A tiny exported const object `AI_ERROR_CODES` in the same file keeps the strings greppable; do not change any `message` text.
- [ ] **Step 4:** Re-run → PASS; `tsc` exit 0 in `apps/api`.
- [ ] **Step 5: Commit** `feat(api): machine codes on AI stream error events (#9428)`.

### Task 3: API skips duplicate user row on `retry`

**Files:**
- Modify: `apps/api/src/routes/ai.ts` at the user-row insert (~:1058-1062)
- Test: next to the existing messages-route tests (e.g. `routes/ai.modelSwitch.test.ts` harness)

**Interfaces:**
- Consumes: `body.retry` from Task 1.
- Behaviour (a): when `body.retry === true`, tear down any live query for the session **before** slot acquisition (`streamingSessionManager.remove(sessionId)`, as the topology timeout does at :1466-1473; executor confirms `remove` closes the SDK query and that the next dispatch rebuilds from the stored `sdkSessionId`), so the retry's SSE never receives a prior turn's events and settlement bills only the retry. Behaviour (b): when `body.retry === true` **and** the session's most recent `ai_messages` row is `role:'user'` with content equal to `sanitizedContent`, skip the insert; otherwise insert as today. The turn is still dispatched (content still pushed to the input controller). RLS: the lookup runs inside the same request DB context as the insert — no new context helper.

- [ ] **Step 1: Failing tests** — (0) timeout, then a late SDK `result` from the old turn, then retry: the retry's SSE receives only the new turn's events and its own `done`; (a) retry + identical trailing user row → insert not called, stream dispatched; (b) retry but trailing row is `assistant` → inserted; (c) retry with different content → inserted; (d) no `retry` + identical trailing row → inserted (normal repeated message stays legal).
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/ai.retry` (new file) → FAIL.
- [ ] **Step 3:** Implement `shouldSkipRetryInsert(sessionId, sanitizedContent): Promise<boolean>` (latest-row query, `orderBy(desc(createdAt)).limit(1)`).
- [ ] **Step 4:** PASS; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(api): retry flag dedupes the trailing user message (#9428)`.

### Task 4: Web classifier + `error` event handling

**Files:**
- Create: `apps/web/src/lib/aiErrors.ts`, `apps/web/src/lib/aiErrors.test.ts`
- Modify: `apps/web/src/stores/processStreamEvent.ts:305` (+ `StreamableState` gains optional `errorCode?: string | null`, `errorDetail?: string | null`), `processStreamEvent.test.ts`

**Interfaces:**
- Produces: `type AiErrorCode = 'timeout'|'disconnect'|'http_5xx'|'provider_error'|'provider_auth'|'provider_quota'|'stream_error'|'config_changed'|'rate_limited'|'rejected'|'budget_exceeded'|'max_turns'|'session_expired'|'session_evicted'|'topology_limit'|'topology_failed'`; `isRetryableAiError(code: string | null | undefined): boolean` (true only for `timeout, disconnect, http_5xx, provider_error, stream_error`); `classifyHttpFailure(status: number): AiErrorCode`.

- [ ] **Step 1: Failing tests** — table-driven `isRetryableAiError` (every code above; `undefined`, `''`, `'something_new'` → false); `classifyHttpFailure(503)=http_5xx`, `(429)=rate_limited`, `(403)=rejected`, `(400)=rejected`; `processStreamEvent({type:'error',message:'m',code:'timeout',detail:'d'})` sets `error, errorCode:'timeout', errorDetail:'d', isStreaming:false`; event without code sets `errorCode:null`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/lib/aiErrors.test.ts src/stores/processStreamEvent.test.ts` → FAIL.
- [ ] **Step 3:** Implement as specified.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): AI error classifier and error-event code handling (#9428)`.

### Task 5: `aiStore.retryLastTurn`

**Files:**
- Modify: `apps/web/src/stores/aiStore.ts` — `sendMessage(content, opts?: { retry?: boolean })` (:516), catch/HTTP paths (:566-663), new `retryLastTurn`, `errorDetail`
- Test: `apps/web/src/stores/aiStore.retry.test.ts` (new; copy the fetch/SSE mocking from `aiStore.test.ts`)

**Interfaces:**
- Produces: `retryLastTurn: () => Promise<void>`; state `errorDetail: string | null`; `errorCode` now also carries Task 4 codes **only when the response body gave none** (refusal codes keep precedence). `sendMessage` with `retry: true` appends **no** user bubble, sends `retry: true` in the POST body, and its 409 handlers do not filter any message.

- [ ] **Step 1: Failing tests** — (1) stream `error` with `code:'timeout'` → `errorCode==='timeout'`; (2) `fetch` rejects with TypeError → `errorCode==='disconnect'`; (3) HTTP 503 → `http_5xx`; HTTP 403 → `rejected`; (4) `retryLastTurn` after a timeout: message count unchanged (no second user bubble), POST body contains the original content and `retry:true`, `error` cleared, a stuck `isStreaming:true` assistant bubble is finalized; (5) retry returning 409 `turn_in_progress` keeps the original user bubble; (6) `retryLastTurn` while `isStreaming` → no fetch; (7) no-op when `sessionId` changed since the failure; (8) no user message in transcript → no-op; (9) retry returning 409 `continuation_required` removes the original bubble by id (the continuation prompt re-sends it, which would otherwise duplicate it); (10) a response-body `code` always wins over `classifyHttpFailure` — 403 with `{code:'topology_ai_disabled'}` keeps that code (`TopologyExplanationPanel.tsx:38` switches on it); (11) `retryLastTurn` no-ops when `topologySiteId !== null`; (12) for `disconnect`/`stream_error`, `retryLastTurn` first reloads the session and resends only if the transcript still ends with that user row, otherwise it shows the server's answer; (13) `clearError`, new session and `loadSession` clear `errorDetail`/`failedSessionId`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/stores/aiStore.retry.test.ts` → FAIL.
- [ ] **Step 3:** Implement; capture `failedSessionId` when setting a retryable error so (7) can compare. Reuse `sendMessage` body — do not fork the SSE loop.
- [ ] **Step 4:** PASS; `npx vitest run src/stores/aiStore` (all siblings) green.
- [ ] **Step 5: Commit** `feat(web): aiStore retryLastTurn (#9428)`.

### Task 6: `workspaceStore.retryLastTurn(tabId)`

**Files:**
- Modify: `apps/web/src/stores/workspaceStore.ts` — `TabState` (+`errorCode`, `errorDetail`), `createEmptyTab`, `sendMessage` (:232) opts, catch (:413), `clearError` (:633), new `retryLastTurn(tabId)`
- Test: `apps/web/src/stores/workspaceStore.retry.test.ts` (new; harness from `workspaceStore.test.ts`)

**Interfaces:**
- Produces: `retryLastTurn: (tabId: string) => Promise<void>`; `TabState.errorCode: string | null`, `TabState.errorDetail: string | null`. Same behaviour contract as Task 5, per tab. `errorCode`/`errorDetail` are not persisted (both stores' `partialize` are explicit allowlists, `workspaceStore.ts:~685`, `aiStore.ts:929`).

- [ ] **Step 1: Failing tests** — mirror Task 5 cases 1-13 per tab, plus: retrying tab A does not touch tab B's state; `clearError(tabId)` clears code/detail.
- [ ] **Step 2:** `npx vitest run src/stores/workspaceStore.retry.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `npx vitest run src/stores/workspaceStore` green.
- [ ] **Step 5: Commit** `feat(web): workspaceStore retryLastTurn (#9428)`.

### Task 7: `AiErrorBanner`, wiring, i18n

**Files:**
- Create: `apps/web/src/components/ai/AiErrorBanner.tsx`, `AiErrorBanner.test.tsx`
- Modify: `AiChatSidebar.tsx:365-375`, `workspace/WorkspaceChatPanel.tsx:104-113`, `apps/web/src/locales/*/ai.json` (×8)

**Interfaces:**
- `AiErrorBanner({ error, errorCode, errorDetail, busy, onRetry, onDismiss, className })`. Headline: `timeout` → `aiErrorBanner.timedOut` ("This response timed out"), `disconnect` → `aiErrorBanner.disconnected`, otherwise `error` text; `errorDetail` rendered as secondary line. "Try again" button (`data-testid="ai-error-retry"`) renders only if `isRetryableAiError(errorCode) && !busy`; Dismiss unchanged. Each surface passes its own colour `className` (current classes are kept verbatim) and hides retry when `topologySiteId !== null` (sidebar).
- Keys (en, then translate in all 7 other locales): `aiErrorBanner.timedOut`, `aiErrorBanner.disconnected`, `aiErrorBanner.tryAgain`, `aiErrorBanner.dismiss`.

- [ ] **Step 1: Failing tests** — component: timeout code shows "This response timed out" + button; clicking calls `onRetry` once; `budget_exceeded` / `rejected` / no code → no button and message text shown; `busy` hides button; detail line rendered. Sidebar test: store in timeout state → click button → `retryLastTurn` called. Workspace panel test: same with `tab.id`.
- [ ] **Step 2:** `npx vitest run src/components/ai/AiErrorBanner.test.tsx src/components/ai/AiChatSidebar.test.tsx src/components/workspace/WorkspaceChatPanel.test.tsx` → FAIL.
- [ ] **Step 3:** Implement and swap both inline banners; add keys to all 8 locale files.
- [ ] **Step 4:** PASS, then gates: `npx vitest run src/lib/i18n/localeParity.test.ts`, `npx vitest run src/lib/__tests__/no-silent-mutations.test.ts` (must pass with zero allowlist/ratchet edits), `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` in `apps/web` → `exit=0`.
- [ ] **Step 5: Commit** `feat(web): Try again banner on AI chat failures (#9428)`.

## Out of scope / follow-ups

- Automatic retry or backup-model replay (#7772); keep-alive (#6474).
- Retry for failed approvals/plan approvals (they set `error` via other paths with no `code`, so the button is correctly absent).
- Deep-link / cross-surface continuation of a failed turn — plugs into #9427, not here.

## Decisions for Gate B (plan default in brackets)

0. Retry starts from a torn-down server query (Task 3) [**yes**; without it a retry after a timeout races the still-running turn]
1. API change vs web-only: add `code`/`detail` to the `error` event and a `retry` flag [**API change**; web-only means regexing message text and accepting a duplicate persisted user row]
2. Duplicate handling: server dedupes a trailing identical user row on `retry: true` (protects the persisted transcript only; model context is handled by decision 0) [**yes**; alternative is client-only resend and tolerating a duplicate row]
3. Retryable set: `timeout, disconnect, http_5xx, provider_error, stream_error` [**as listed**; `config_changed` dropped, it never reaches the client]
4. 429 rate limit: show retry? [**no** (hidden; a countdown retry is a follow-up)]
5. Model `max_turns` (conversation turn cap): [**no retry**; user needs a new chat]
6. Timeout headline copy "This response timed out" and a single shared `AiErrorBanner` for both surfaces [**yes**]
7. Gateway note on timeouts (#7794) moves to a separate `detail` field, `message` stays stock [**yes**]
8. Topology investigation turns never show Try again [**yes**]
