---
tracking_issue: LanternOps/breeze#9840
spec_issue: LanternOps/breeze#9427
spec: docs/superpowers/specs/ai-mcp/2026-10-21-ai-chat-move-conversations-spec.md
status: approved (Gate B) — waves tracked on LanternOps/breeze#9840
date: 2026-10-23
---

# AI chat: move conversations between the side panel and the AI Assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A conversation can move from the side panel to an AI Assistant tab and back, a past conversation can be opened in the workspace, and `/workspace#session=<id>` deep-links one — with a running turn (and its pending approval/plan card) carried across by attaching to it, never by re-sending.

**Architecture:** One new read-only API route, `GET /ai/sessions/:id/stream`, attaches a client to the **current turn** of a session: first frame `attach_state` (snapshot: replay, pending cards, active plan), then the live tail de-duplicated by a per-turn `seq`. `aiStore` and `workspaceStore` stay separate (D1) and share three web modules — `aiSessionOpen` (hydrate), `aiSessionAttach` (attach reader) and `aiConversationHandoff` (prepare destination, then release origin). The list/search API gains a session-type filter and an `orgId`/`type`/`deviceId` projection.

**Tech Stack:** Hono + `streamSSE` (API), Drizzle (reads only, no migration), Zod/TS types in `packages/shared`, Zustand + React islands + Astro `navigate` (web), react-i18next (8 locales), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-21-ai-chat-move-conversations-spec.md` (approved 2026-10-22, D1–D7 decided — not re-opened here). Read it with this plan; § references below are to the spec.

## Findings (re-verified on `origin/main` @ `8d20504960`; the spec cited `30e8ee7c44`)

The premise holds. Line numbers moved; current anchors:

- `POST /ai/sessions/:id/messages` is `routes/ai.ts:779`. It **always** tears down the prior in-memory session before a turn (`:901-903` → `streamingSessionManager.remove()` → `eventBus.closeAll()` at `streamingSessionManager.ts:1387`), so one `ActiveSession`/`SessionEventBus` lives for exactly one turn (§3.5 holds).
- Uncoded second-send 409s: `routes/ai.ts:893-898` (settle failed — two messages) and `:1049` (lost the processing slot). Coded: `:992` (`turn_in_progress`, reservation busy).
- The `/messages` stream has no `onAbort`: `routes/ai.ts:1126-1155`; `finally` only unsubscribes. The user row insert is `:1061-1065` (no `.returning`).
- `SessionEventBus` is `streamingSessionManager.ts:320-373`: 100-event ring buffer, `getReplayEvents()` has no non-test caller, no `seq`, no closed flag (a `subscribe()` after `closeAll()` yields a queue nothing ever closes).
- `ActiveSession` (`:423`) holds `activePlanId`, `currentPlanStepIndex`, `planApprovalResolver` (`:636-642`). Durable plan rows: `ai_action_plans` (`schema/ai.ts:364`, `status`, `steps`, `currentStepIndex`).
- `getSession` (`services/aiAgent.ts:279`) is owner + org + topology-site filtered, **no type filter**. `listSessions` (`:304`) projects `id,title,status,model,turnCount,totalCostCents,lastActivityAt,createdAt` — no `orgId/type/deviceId`, no type filter. `searchSessions` (`:797`) returns `{id,title,matchedContent,createdAt}`. `ai_sessions.type` is free `text` (`schema/ai.ts:38`).
- Pattern to copy for attach: `routes/clientAi/sessions.ts:909-975` (eager `ping`, `setInterval` ping, `stream.onAbort` unsubscribe). `CLIENT_AI_SSE_PING_INTERVAL_MS = 25_000` (`routes/clientAi/sse.ts:21`).
- `selfManagedDbContextRoutes.ts:566` lists the `/messages` POST; the new GET goes beside it, and `selfManagedDbContextRoutes.test.ts` enumerates paths.
- Web: `aiStore.loadSession` (`:440`), `switchSession` (`:846`, explicit pick, no org-mismatch drop), `closeSession` (`:784`, DELETEs), `sendMessage` 409 branches (`:573-618`), SSE loop (`:624-668`), `activeStreamToken`/`claimSessionOwnership` (`:215-228`), `TOPOLOGY_TURN_EVENTS` (`:236`), persist key `breeze-ai-chat` (`:941`). `workspaceStore`: `MAX_TABS = 5` (`:18`), `createTab` (`:142`, never takes a session), `closeTab` (`:160`, no API call), every 409 identical (`:312-321`), `restoreWorkspace` (`:641`, no attach), `cleanupAllStreams` (`:674`), persist key `breeze-workspace` (`:684`). `processStreamEvent` exhaustive `default: never` at `:514`.
- `WorkspacePage.tsx:35-39` calls `cleanupAllStreams` on unmount (fact 3). `WorkspaceTab.tsx` has **no menu today** — the tab root is a `<button>` with a nested `span role="button"` close control. `AiChatInput` keeps its draft in local `useState` (`:21`), invisible to the stores.
- Logout: `evictLocalAuthState()` `stores/auth.ts:1858-1867` removes `breeze-ai-chat` but not `breeze-workspace` (fact 8).
- Hash: `useHashState` (`lib/useHashState.ts:86`) reads post-mount and on `hashchange`; `history.replaceState` fires no `hashchange`. Astro's `ClientRouter` keeps its own data in `history.state` (see `components/shared/HashLink.tsx:25-60`), so any `replaceState` must pass the existing `history.state`.
- Sibling plans `2026-10-21-ai-chat-retry-on-error.md` (#9428) and `2026-10-21-ai-chat-browser-notifications.md` (#9429) are merged as docs; **neither is implemented on main** (no `lib/aiErrors.ts`, `lib/aiNotifications.ts`, `retryLastTurn`). See "Seam with #9428 and #9429".

## Global Constraints

- Owner-only, always: every new read goes through `getSession(sessionId, auth)` / `listSessions` / `searchSessions` (user + accessible orgs + topology site). Nothing widens what a user can reach; nothing narrows by the org switcher (§2, D5).
- Session types reachable by attach and by `openSession`: `general`, `topology` only. Anything else is a 404 / "isn't available", indistinguishable from not-found.
- The attach route **never creates** an in-memory session, **never sends**, holds **no DB context** inside the stream callback, unsubscribes on abort, and covers **one turn** (§3.5).
- Release is local: never `DELETE /ai/sessions/:id` on a move. Destination prepared first; origin released only after the destination is ready — on `handoff.complete` for panel → workspace, and by call ordering for workspace → panel (T13) (D3).
- Full tab bar → toast, never eviction (D5). Topology sessions never open in the workspace (D4).
- `#session=<uuid>` only; the hash follows the active tab via `history.replaceState(history.state, '', url)` (D6).
- No migration, no new column, no feature flag, no new setting (§4, §8).
- Exact copy (en): "Open in AI Assistant", "Continue in side panel", "Open a past conversation", "Close a tab in the AI Assistant to open this conversation", "Close a tab to open this conversation", "This conversation isn't available", "This conversation was closed", "Investigations open from the topology map", "Open in side panel", "Replace the conversation in the side panel? It stays in your history.", "Joined mid-response. The full reply appears when it finishes.", "Continue in side panel to choose a model", plus "Tab options", "Another organization", "Device", and "New chat" (T16, only if no existing key already says it); the tab menu's "Rename" reuses the existing rename string in `workspaceTab` if there is one, else `aiConversationMove.rename`. All under one new top-level key `aiConversationMove` in `apps/web/src/locales/<locale>/ai.json`, ×8 locales (en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR), inserted **directly after the `aiChatSidebar` block** rather than at the end of the file, to stay out of the region the #9428/#9429 key blocks are most likely to touch. No template-literal keys (`keyUsage.test.ts`).
- Web reads use `fetchWithAuth` GETs; this feature adds **no** new mutating fetch. `no-silent-mutations.test.ts` must pass with zero allowlist edits.

## Review Focus

1. **Two browser tabs on one session.** Tab 2 is attached; tab 1 sends → `remove()` closes tab 2's bus, so its attach stream ends **without `done`**. Expected: tab 2 re-attaches (to the new turn) once, not a stuck spinner and not an error. Test: T7 `ends without done → outcome 'closed'`, T9 `closed outcome re-attaches once`.
2. **Hand-off never completes** (user navigates away from `/workspace` before it opens, or the workspace island throws). Expected: after the hand-off timeout the side panel still holds the session, unchanged. Test: T8 `pending hand-off aborts after timeout`, T13 sidebar test.
3. **Org switcher changes while an other-org tab is open.** Expected: the tab keeps its session and keeps sending to it; no rebind, no drop. Test: T11 `other-org tab survives currentOrgId change`.
4. **Logout during a live attach.** Expected: reader aborted, no store write after logout, `breeze-workspace` gone. Test: T14.
5. **Hostile or malformed hash** (`#session=../x`, `#session=<uuid>&x=1`, upper-case UUID, two `session=`). Expected: anything that is not exactly one canonical UUID is ignored with no fetch; upper-case is normalised. Test: T12 `parseSessionHash` table.

---

## Waves

| Wave | Deliverable | Tasks | Depends on |
|---|---|---|---|
| **W1** | Shared contract + attach route + list filter + the three shared web modules (no UI change) | T1–T8 (incl. T2b) | — |
| **W2** | Side panel attaches: restore after reload, `turn_in_progress` → attach, `releaseSession`/`adoptSession`, composer draft in the store | T9–T10 | W1 |
| **W3** | Workspace opens sessions, restores by attaching, `#session=` deep link, both move controls, chips, logout | T11–T14 | W2 |
| **W4** | Shared conversation list: side-panel History + workspace "Open a past conversation" picker, org/device chips, "open elsewhere" rows | T15–T16 | W3 |
| **W5** | Placement/copy polish, E2E, docs, live checks | T17 | W4 |

Each wave is one PR off fresh `main` (`feature/9427-ai-chat-move-conversations/wave-<sub-issue#>`), `Closes #<sub-issue>`, `Refs #9427`. W1 can merge alone — nothing calls the route yet. The move controls ship only in W3, together with attach (D2). Release W2–W5 in one release if possible; each is internally consistent if a release cuts between them.

## File Structure

**API / shared**
- Create `apps/api/src/services/sessionEventBus.ts` (+ `.test.ts`) — `SessionEventBus` moved out of the 2,585-line manager, re-exported from `streamingSessionManager.ts` so imports keep working. Owns `seq`, closed flag, byte-capped turn buffer, live plan state, `snapshot()`. Pending cards live on `ActiveSession` (T2b, `aiAgentSdk.ts`/`aiAgentSdkTools.ts`).
- Create `apps/api/src/routes/aiAttach.ts` (+ `aiAttach.test.ts`) — the attach route, mounted on `aiRoutes`.
- Create `apps/api/src/services/sessionPendingCards.ts` (+ test) — `publishPendingCard`/`resolvePendingCard` (T2b).
- Modify `apps/api/src/routes/ai.ts` (409 codes, `onAbort`, user row `.returning`, mount), `services/streamingSessionManager.ts` (`ActiveSession.turnId`, `turnUserMessageId`, `pendingCards`), `services/aiAgentSdk.ts` + `services/aiAgentSdkTools.ts` (card publish/resolve sites), `services/aiAgent.ts` (filter + projections), `middleware/selfManagedDbContextRoutes.ts` (+ test).
- Modify `packages/shared/src/types/ai.ts` — `attach_state` member, `AiAttachState`, `isAttachStateEvent`.
- Modify `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md:245` (in-process-state row).

**Web**
- Create `apps/web/src/stores/aiSessionOpen.ts`, `aiSessionAttach.ts`, `aiConversationHandoff.ts`, `aiSendRefusal.ts` (+ tests).
- Modify `stores/processStreamEvent.ts` (`attach_state` case, `joinedMidResponse`), `stores/aiStore.ts`, `stores/workspaceStore.ts`, `stores/auth.ts`.
- Create `components/ai/AiConversationList.tsx`, `components/ai/useAiConversationSource.ts`, `components/workspace/WorkspaceConversationPicker.tsx`, `components/workspace/WorkspaceSessionChips.tsx`, `components/workspace/sessionHash.ts` (+ tests).
- Modify `components/ai/AiChatSidebar.tsx`, `AiChatInput.tsx`, `components/workspace/WorkspacePage.tsx`, `WorkspaceTab.tsx`, `WorkspaceTabBar.tsx`, `WorkspaceChatPanel.tsx`, `WorkspaceEmptyState.tsx`, `locales/*/ai.json` ×8.

---

## W1 — contract, attach route, shared modules

### Task 1: `attach_state` contract and its client application

**Files:**
- Modify: `packages/shared/src/types/ai.ts` (union at `:213`), `apps/web/src/stores/processStreamEvent.ts` (`StreamableState` `:136`, switch `:164-516`)
- Test: `packages/shared/src/types/aiAttachState.test.ts` (new), `apps/web/src/stores/processStreamEvent.attachState.test.ts` (new)

**Interfaces:**
- Produces (shared):
  ```ts
  export type AiPendingCardEvent = Extract<AiStreamEvent, { type: 'approval_required' | 'plan_approval_required' }>;
  export interface AiAttachState {
    turn: 'idle' | 'running' | 'unavailable';
    turnId: string | null;          // one per ActiveSession (= one per turn)
    lastSeq: number;                // highest seq the snapshot covers; 0 when none
    turnUserMessageId: string | null; // ai_messages.id of this turn's user row
    replay: AiStreamEvent[];        // whole turn from bus creation; [] when partial
    partial: boolean;
    pendingCards: AiPendingCardEvent[]; // verbatim, original deadlines
    activePlan: { planId: string; steps: ActionPlanStep[]; currentStepIndex: number; status: 'executing' | 'completed' | 'aborted' } | null;
    turnModel: AiTurnModel | null;
  }
  // union member:
  | ({ type: 'attach_state' } & AiAttachState)
  export function isAttachStateEvent(e: unknown): e is { type: 'attach_state' } & AiAttachState;
  ```
- Produces (web): `StreamableState.joinedMidResponse?: boolean`; `export function attachAnchorMissing(state: AiAttachState, messages: AiMessage[]): boolean` (running, not partial, `turnUserMessageId` **non-null** and absent from `messages` — the caller re-hydrates once and re-attaches; if it is still absent the second time, the caller applies it as if the anchor were null); `processStreamEvent` `case 'attach_state'` applies the snapshot:
  1. `turn === 'running'` and `!partial`: keep everything up to and including the message whose `id === turnUserMessageId`; after it, drop only rows with `role ∈ {assistant, tool_use, tool_result}` (the turn's own output, which the replay re-creates) and **keep** any other persisted row (e.g. script-proposal system notes, whose live event is ignored at `processStreamEvent.ts:477`); then fold `replay` and return its `currentAssistantId`. No guessed anchor. `turnUserMessageId === null` (the attach landed between `tryTransitionToProcessing`, `routes/ai.ts:1049`, and the user-row insert at `:1061`, so no turn output is persisted yet) → drop nothing, fold `replay`, and re-hydrate on `done` like a partial join.
  2. `turn === 'running'` and `partial`: keep hydrated rows, append a streaming assistant placeholder and return its id, so live `content_delta` (which needs `currentAssistantId`, `:183`) renders.
  3. Pending state is **replaced**, not merged: `pendingApproval` = last `approval_required` in `pendingCards` or `null`; `pendingPlan` = the `plan_approval_required` in `pendingCards` or `null`.
  4. `activePlan` = snapshot value (it is computed at `lastSeq`, so it already reflects every replayed step outcome; install it after the replay fold).
  5. `isStreaming = turn === 'running'`, `joinedMidResponse = turn === 'running' && partial`; `turnModel` when non-null. `done` clears `joinedMidResponse`.
- `mapMessagesFromApi` keeps the DB row `id` (`processStreamEvent.ts:545`, verified), which is the join key for step 1.

- [ ] **Step 1: Failing tests.** Shared: `isAttachStateEvent({type:'attach_state', turn:'idle', …})` true; `{type:'done'}` false; missing `turn` false. Web: idle snapshot → `isStreaming:false`, messages unchanged; running full snapshot whose replay is `[message_start, content_delta 'Hi']` over hydrated `[user u1, assistant a-persisted, system note s1]` with `turnUserMessageId:'u1'` → messages = `[u1, s1, <streaming assistant 'Hi'>]` (persisted turn output dropped, note kept, no duplicate); `attachAnchorMissing` true when `u1` is not hydrated, false when `turnUserMessageId` is null; null anchor → hydrated rows kept, replay appended; running + `partial:true` → hydrated kept plus one streaming placeholder, a following `content_delta 'x'` appends to it, `joinedMidResponse:true`; `pendingCards:[approval_required{approvalExpiresAt:'2026-10-23T10:00:00Z'}]` → `pendingApproval.approvalExpiresAt === '2026-10-23T10:00:00Z'`; a stale `pendingApproval` from a previous session + `pendingCards:[]` → `pendingApproval:null`, `pendingPlan:null`; `activePlan` with step 0 `completed` survives a replay that contains `plan_step_complete` for it; later `done` → `joinedMidResponse:false`.
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/types/aiAttachState.test.ts` and `cd apps/web && npx vitest run src/stores/processStreamEvent.attachState.test.ts` → FAIL (missing export / unhandled case).
- [ ] **Step 3:** Implement. Typecheck **both** packages (`NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`) — the `never` default forces the web case.
- [ ] **Step 4:** Re-run both → PASS; also `npx vitest run src/stores/processStreamEvent` (all siblings) green.
- [ ] **Step 5: Commit** `feat(shared,web): attach_state event and its snapshot application (#9427)`.

### Task 2: `SessionEventBus` — seq, closed flag, turn buffer, live plan state

**Files:**
- Create: `apps/api/src/services/sessionEventBus.ts`, `sessionEventBus.test.ts`
- Modify: `apps/api/src/services/streamingSessionManager.ts:312-373` (delete the class, `export { SessionEventBus } from './sessionEventBus'`)

**Interfaces:**
- Produces:
  ```ts
  export interface SequencedEvent { seq: number; event: AiStreamEvent }
  export const ATTACH_REPLAY_MAX_BYTES = 256 * 1024;   // Gate B #3
  export const SCREENSHOT_REPLAY_PLACEHOLDER = '';      // imageBase64 in replay
  class SessionEventBus {
    subscribe(id: string): AsyncIterable<AiStreamEvent>;          // unchanged contract
    subscribeSequenced(id: string): AsyncIterable<SequencedEvent>;
    unsubscribe(id: string): void;
    publish(event: AiStreamEvent): void;   // stamps ++seq
    closeAll(): void;                      // also sets closed = true
    get closed(): boolean;
    get subscriberCount(): number;
    get lastSeq(): number;
    snapshot(): { lastSeq: number; replay: AiStreamEvent[]; partial: boolean; sawDone: boolean; activePlan: AiAttachState['activePlan']; turnModel: AiTurnModel | null }; // turnModel = last `turn_model` event, else null
    getReplayEvents(fromIndex?: number): AiStreamEvent[]; // kept for existing tests, reads the new buffer
  }
  ```
- Rules: `seq` starts at 1 per bus. The buffer keeps **every** event of the bus (the turn) until `ATTACH_REPLAY_MAX_BYTES` (measured as UTF-8 bytes, `Buffer.byteLength(JSON.stringify(event), 'utf8')`, after the screenshot substitution) would be exceeded; from then on `partial = true`, the buffer is emptied and stops recording. `plan_screenshot` is buffered with `imageBase64: SCREENSHOT_REPLAY_PLACEHOLDER`; live subscribers still get the original. `ping` is never published on the bus. `subscribe*` on a closed bus returns an already-closed iterable. `sawDone` is set by publishing `done` and kept even after overflow: `done` is published **before** `state` leaves `processing`, across awaits on the processor-exit path (`streamingSessionManager.ts:2017` then the `finally`), so `state` alone cannot say the turn is over.
- Live plan state (kept even after overflow, so it is right at any `lastSeq`): `plan_approval_required` records `{planId, steps}`; the first `plan_step_start` for it makes `activePlan = {planId, steps, currentStepIndex, status:'executing'}`; `plan_step_complete` marks that step `completed`/`failed` and advances the index; `plan_complete` sets `status`. This replaces any `ai_action_plans` read — the attach route does no DB read beyond `getSession`.

- [ ] **Step 1: Failing tests** (`sessionEventBus.test.ts`): seq 1..n in publish order on both subscribers; `snapshot()` after 3 events → `lastSeq 3`, replay of 3; overflow (publish one 300 KiB `content_delta`, and separately 100 K multibyte characters that are under 256 K UTF-16 units but over 256 KiB of UTF-8) → `partial:true`, `replay:[]`, later events still get seq; `plan_screenshot` live subscriber sees original base64, replay sees `''`; `done` → `snapshot().sawDone === true`, also after an overflow; plan state: approval → start 0 → complete 0 → start 1 gives step 0 `completed`, index 1, `executing`, also after an overflow; `subscribe` after `closeAll` → `for await` ends immediately; `subscriberCount` drops on `unsubscribe`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/sessionEventBus.test.ts` → FAIL.
- [ ] **Step 3:** Implement; keep `subscribe()` behaviour identical for its callers (`routes/ai.ts:1103`, `routes/clientAi/sessions.ts:933`).
- [ ] **Step 4:** PASS; then `npx vitest run src/services/streamingSessionManager src/routes/clientAi` green (existing bus users); `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(api): per-turn sequenced event bus with byte-capped replay and live plan state (#9427)`.

### Task 2b: Authoritative pending-card registry on `ActiveSession`

The bus cannot tell when a card is decided: a plan rejection or timeout clears the plan with no event (`aiAgentSdkTools.ts:4243-4247`), and tool results carry no `executionId`. So cards are tracked where the wait lives, keyed by id.

**Files:**
- Create: `apps/api/src/services/sessionPendingCards.ts` (leaf module, type-only import of `ActiveSession`; avoids a cycle — `aiAgentSdk.ts:37` already imports `aiAgentSdkTools`, so the tools file must not import `aiAgentSdk`)
- Modify: `apps/api/src/services/streamingSessionManager.ts` (`ActiveSession` + creation default), `apps/api/src/services/aiAgentSdk.ts` (the three `approval_required` publish sites `:1036`, `:1686`, `:2327` and the waits that follow them), `apps/api/src/services/aiAgentSdkTools.ts:4236-4247` (plan publish and the `waitForPlanApproval` call site; the function itself is `aiAgent.ts:629`)
- Test: `apps/api/src/services/sessionPendingCards.test.ts` (new)

**Interfaces:**
- Produces: `ActiveSession.pendingCards: Map<string, AiPendingCardEvent>` (default empty); in `sessionPendingCards.ts` `export function publishPendingCard(session: ActiveSession, key: string, event: AiPendingCardEvent): void` (records, then publishes — same tick) and `export function resolvePendingCard(session: ActiveSession, key: string): void`. Keys: `approval:<executionId>`, `plan:<planId>`. Each approval wait is wrapped `try { … } finally { resolvePendingCard(session, 'approval:' + id) }` so approve, reject, timeout and `settleApprovalWaits` all remove it; the `waitForPlanApproval` call in the tools file likewise in a `finally`. `done` is published from eight sites, so the map is **not** cleared there; instead the attach route sends `pendingCards: []` whenever `snapshot().sawDone` (T4), and each card still leaves the map when its wait ends.

- [ ] **Step 1: Failing tests:** card present while its wait is pending; removed on approve, on reject, on timeout and after `settleApprovalWaits`; two parallel approvals for the **same tool name** are tracked and removed independently by `executionId`; plan card removed on approve, reject and timeout.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/sessionPendingCards.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `npx vitest run src/services/aiAgentSdk src/services/streamingSessionManager` green; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(api): track unresolved approval and plan cards by id on the session (#9427)`.

### Task 3: `/messages` — turn identity, coded 409s, abort teardown

**Files:**
- Modify: `apps/api/src/services/streamingSessionManager.ts` (`ActiveSession` `:423`, creation site where `activePlanId: null` is set `:1145`), `apps/api/src/routes/ai.ts:893-898`, `:1049`, `:1061-1065`, `:1126-1155`
- Test: `apps/api/src/routes/ai.messagesStream.test.ts` (new; harness from `ai.modelSwitch.test.ts`)

**Interfaces:**
- Produces: `ActiveSession.turnId: string` (`crypto.randomUUID()` at creation), `ActiveSession.turnUserMessageId: string | null` (set from the user insert's `.returning({ id })`). Both refusal 409s carry `code: 'turn_in_progress'` with their existing `error` text unchanged. The `/messages` `streamSSE` callback registers `stream.onAbort(() => activeSession.eventBus.unsubscribe(subscriptionId))` before its first write.

- [ ] **Step 1: Failing tests:** settle returns `not_blocked_on_approvals` → 409 body `{ error: 'A message is already being processed for this session', code: 'turn_in_progress' }`; settle timeout → same code, the "wrapping up" text; `tryTransitionToProcessing` false → 409 with code; successful dispatch sets `activeSession.turnUserMessageId` to the inserted id; aborting the client mid-stream drops `eventBus.subscriberCount` to 0 **before** `done` and the turn keeps publishing (bus not closed, state still `processing`).
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/ai.messagesStream.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `npx vitest run src/routes/ai.` (substring: all `ai.*.test.ts` route files — check the count) green; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(api): coded turn_in_progress 409s, turn identity, abort teardown on /messages (#9427)`.

### Task 4: `GET /ai/sessions/:id/stream` (attach)

**Files:**
- Create: `apps/api/src/routes/aiAttach.ts`, `apps/api/src/routes/aiAttach.test.ts`
- Modify: `apps/api/src/routes/ai.ts` (mount, after `GET /sessions/:id`), `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (add `{ method: 'GET', pattern: /^\/api\/v1\/ai\/sessions\/[^/]+\/stream\/?$/ }` beside `:566`) + `selfManagedDbContextRoutes.test.ts`, `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md:245`

**Interfaces:**
- Consumes: T2 bus API, T2b `pendingCards`, T3 `turnId`/`turnUserMessageId`, `getSession` (`services/aiAgent.ts:279`).
- Produces: `registerAiAttachRoute(aiRoutes: Hono)`; constants `ATTACH_MAX_SUBSCRIBERS = 8` (Gate B #2), ping interval `CLIENT_AI_SSE_PING_INTERVAL_MS`. Middleware `requireScope('organization','partner','system')`, `requireAiUse`; no `requireMfa`.
- Wire format: the first frame is `event: ping` (beacon), then `event: attach_state`, `data: {type:'attach_state', …}`. Each live frame is `event: <type>`, `id: <seq>`, `data: JSON.stringify({ ...event, seq })`.
- Order of operations (each step is a decision the tests pin):
  1. Pre-stream, in one short `withAuthDbAccessContext(auth, …)`: `getSession`; null or `type ∉ {general, topology}` → `404 {error:'Session not found'}`. That is the route's only DB read.
  2. `active = streamingSessionManager.get(id)`; absent or `state ∈ {closing, closed}` → stream `ping`, then `attach_state{turn:'unavailable', …empty}`, close.
  3. `active.eventBus.subscriberCount >= ATTACH_MAX_SUBSCRIBERS` → `429 {error:'Too many viewers', code:'attach_limit'}`. The count includes the sending surface's own `/messages` subscriber, so a running turn admits 7 attaches.
  4. Inside `streamSSE`, **synchronously, before any await**: re-read `streamingSessionManager.get(id)`; if it is not the same object, send `unavailable` and close; else `subscribeSequenced`, `bus.snapshot()`, copy `[...active.pendingCards.values()]`, read `turnId`/`turnUserMessageId`, register `onAbort` (clear ping, unsubscribe). `turn = state === 'processing' && !sawDone ? 'running' : 'idle'`; `pendingCards = sawDone ? [] : [...]`.
  5. Write `ping`, then `attach_state` built from that same-tick capture.
  6. `idle` → close after that frame. `running` → forward events with `seq > lastSeq`; stop after `done` or when the bus closes; ping every interval meanwhile. No DB work in the callback.

- [ ] **Step 1: Failing tests:** other user's session → 404; session in an org outside `accessibleOrgIds` (getSession mock returns null for the cross-org row) → 404; `script_builder` and `mcp` → 404 with the same body; not in memory → `ping`, `attach_state{turn:'unavailable'}`, end, and `streamingSessionManager` has **no** new session (never creates); idle → exactly two frames then end; running with 3 buffered events and 2 published after subscribe → `attach_state.lastSeq 3`, then exactly seq 4, 5 (no duplicate at the boundary), ends at `done`; `remove()` mid-attach (a new `POST /messages`) ends the stream; the in-memory session replaced between pre-stream and callback → `unavailable`; `done` already published while `state` is still `processing` → `turn:'idle'`, two frames, end (with and without an overflowed buffer); attach between `tryTransitionToProcessing` and the user-row insert → `running` with `turnUserMessageId:null`; 9th subscriber (sender + 7 attaches + 1) → 429; pending approval in `pendingCards` verbatim with original `approvalExpiresAt` and `intentBacked`; a decided card is absent; no DB call after `getSession` (spy on the context helper); overflowed turn → `partial:true`, `replay:[]`; client abort → `subscriberCount` decremented at once; the turn is never interrupted by attach (no `interrupt`/`pushMessage` calls); `isSelfManagedDbContextRoute('GET','/api/v1/ai/sessions/abc/stream')` true.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/aiAttach.test.ts src/middleware/selfManagedDbContextRoutes.test.ts` → FAIL.
- [ ] **Step 3:** Implement; add the attach route to the scaling spec's AI-streaming row: "`GET /ai/sessions/:id/stream` reads the same in-process session; route by owner slot together with `/messages`; until then `unavailable` is the honest answer."
- [ ] **Step 4:** PASS; `npx vitest run src/services/aiGuardrails.routeBinding.contract.test.ts src/services/aiGuardrails.routeParity.contract.test.ts src/__tests__/writeRoutePermissionGate.contract.test.ts` green; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(api): GET /ai/sessions/:id/stream attaches to the current turn (#9427)`.

### Task 5: List and search — type filter and projections

**Files:**
- Modify: `apps/api/src/services/aiAgent.ts:304-340` (`listSessions`), `:797-860` (`searchSessions`)
- Test: `apps/api/src/services/aiAgent.sessionList.test.ts` (new), `apps/api/src/__tests__/integration/aiSessionList.integration.test.ts` (new)

**Interfaces:**
- Produces: `export const CHAT_SESSION_TYPES = ['general', 'topology'] as const;` both queries add `inArray(aiSessions.type, CHAT_SESSION_TYPES)` (both search sub-queries). `listSessions` rows gain `orgId`, `type`, `deviceId`. `searchSessions` rows gain `status`, `type`, `orgId`, `deviceId`. Return types updated; mobile (`apps/mobile/src/services/aiChat.ts:148`) needs no code change.

- [ ] **Step 1: Failing tests:** unit (Drizzle mock) — the where clause contains the type condition; projection keys include `orgId,type,deviceId`; search result includes `status,type`. Integration (real Postgres, RLS on, as `breeze_app`): a partner user with sessions in two accessible orgs + one `script_builder` + one `mcp` + one other user's session → list returns exactly the two `general`/`topology` rows across both orgs with correct `orgId`; search for a word in all five → same two.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/aiAgent.sessionList.test.ts` → FAIL. Integration red on a per-worktree stack (see "Running integration tests").
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Both PASS; `npx vitest run src/services/aiAgent.` and `src/routes/ai.` green; `tsc` exit 0.
- [ ] **Step 5: Commit** `fix(api): AI session list/search return only chat sessions, with org/type/device (#9427)`.

### Task 6: web `aiSessionOpen`

**Files:**
- Create: `apps/web/src/stores/aiSessionOpen.ts`, `aiSessionOpen.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AiSessionView {
    id: string; title: string | null; status: 'active' | 'closed' | 'expired';
    orgId: string; type: 'general' | 'topology'; deviceId: string | null;
    isFlagged: boolean; flagReason: string | null; lastTurnModel: AiTurnModel | null;
    m365ConnectionId: string | null; pageContext: AiPageContext | null; topologySiteId: string | null;
    raw: Record<string, unknown>; // the session object, for aiStore's topologyFieldsOf
  }
  export type OpenAiSessionResult =
    | { kind: 'ok'; view: AiSessionView; messages: AiMessage[] }
    | { kind: 'not_found' } | { kind: 'closed' } | { kind: 'error'; message: string };
  export function openAiSession(sessionId: string): Promise<OpenAiSessionResult>;
  export function pageContextFromSnapshot(snapshot: unknown): AiPageContext | null; // drops 'orgAnchor'
  export function isChatSessionType(t: unknown): t is 'general' | 'topology';
  ```
- One `GET /ai/sessions/:id`. 404 or a non-chat `type` → `not_found`. `status !== 'active'` → `closed`.

- [ ] **Step 1: Failing tests:** 200 general → `ok` with `orgId`, `deviceId`, `m365ConnectionId` (from `delegantM365ConnectionId`), `pageContext` without `orgAnchor`; `type:'script_builder'` → `not_found`; 404 → `not_found`; `status:'expired'` → `closed`; network throw → `error`; `pageContextFromSnapshot(null)` → null, `{type:'device', hostname:'h', orgAnchor:'page_context'}` → `{type:'device', hostname:'h'}`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/stores/aiSessionOpen.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): shared aiSessionOpen hydration (#9427)`.

### Task 7: web `aiSessionAttach` and `aiSendRefusal`

**Files:**
- Create: `apps/web/src/stores/aiSessionAttach.ts`, `aiSessionAttach.test.ts`, `apps/web/src/stores/aiSendRefusal.ts`, `aiSendRefusal.test.ts`

**Interfaces:**
- Produces (`aiSessionAttach.ts`):
  ```ts
  export type AttachOutcome =
    | { kind: 'done' } | { kind: 'idle' } | { kind: 'unavailable' }
    | { kind: 'closed' }        // stream ended without done (bus replaced)
    | { kind: 'gap' }           // seq jumped; caller re-attaches for a fresh snapshot
    | { kind: 'not_found' } | { kind: 'busy' } | { kind: 'aborted' } | { kind: 'error'; message: string };
  export interface AttachOptions {
    signal: AbortSignal;
    onEvent: (event: AiStreamEvent) => void;          // attach_state first, then live events (seq stripped)
    filter?: (event: AiStreamEvent) => boolean;       // aiStore passes TOPOLOGY_TURN_EVENTS.has for topology
  }
  export type AttachReady =
    | { kind: 'ready'; turn: 'idle' | 'running' | 'unavailable'; state: AiAttachState } // attach_state received and passed to onEvent
    | Extract<AttachOutcome, { kind: 'not_found' | 'busy' | 'aborted' | 'error' | 'closed' }>;
  export function attachAiSession(sessionId: string, opts: AttachOptions): { ready: Promise<AttachReady>; finished: Promise<AttachOutcome> };
  export function attachBackoffMs(attempt: number, random?: () => number): number; // 500·2^n, cap 8000, full jitter
  export const ATTACH_MAX_ATTEMPTS = 4;
  export function trackAttach(controller: AbortController): () => void; // registry; returns untrack
  export function abortAllAttaches(): void;                           // logout
  ```
  `filter` applies to live events **and** inside `attach_state` (to `replay` and `pendingCards`) before `onEvent`. `ping` frames and frames whose data has no `type` are ignored. Live events with `seq <= lastSeq` are dropped; `seq > lastSeq + 1` (after the previous) → `gap`. `ready` settles as soon as `attach_state` has been handed to `onEvent` (or on a pre-snapshot failure); `finished` settles at stream end. Hand-off waits on `ready`, never on `finished` (which can last a whole turn).
- Re-attach policy (both stores use `export function shouldReattach(outcome: AttachOutcome, cycle: { attempt: number; afterClosedOr409: boolean }): boolean`): `closed`, `gap`, `busy` → yes; `unavailable` → yes **only** inside a cycle started by `closed` or a `turn_in_progress` 409 (the gap between `remove()` at `routes/ai.ts:902` and the new session's creation), no on a first open; always no past `ATTACH_MAX_ATTEMPTS`. The caller owns `cycle` as a local in its attach loop (one loop per `attachCurrent()` call / per tab attach). Terminal state when the loop stops without `done` (any outcome): re-hydrate messages once, `isStreaming:false`, `joinedMidResponse:false`, no error banner — the next send or a reload re-attaches. `not_found` is the exception: the store unbinds the session exactly as its 404 path does today.
- Produces (`aiSendRefusal.ts`): `classifySendRefusal(status: number, code: string | null): 'attach' | 'continuation' | 'choose_model' | 'credits' | 'error'` — `409 turn_in_progress` → `attach`; `409 continuation_required` → `continuation`; `409` recoverable model codes (`RECOVERABLE_MODEL_CODES`, `topology_model_changed`) → `choose_model`; `402` with code → `credits`; everything else → `error`. Uncoded 409 (older API) → `attach` as well (it can only mean another turn).

- [ ] **Step 1: Failing tests:** stream fixture `ping, attach_state{lastSeq:2}, seq2, seq3, done(seq4)` → `onEvent` receives `attach_state, seq3, done`, `ready` resolves `{kind:'ready', turn:'running'}` **before** `seq3` is delivered, `finished` resolves `done`; `shouldReattach` table (`unavailable` first open → false, inside a closed-cycle → true, attempt 4 → false); idle → `idle`; `unavailable` frame → `unavailable`; seq 3 then 5 → `gap`; body ends without `done` → `closed`; 404 → `not_found`; 429 → `busy`; aborting the signal → `aborted` and reader cancelled; topology filter drops a `content_delta` in replay and live; `abortAllAttaches()` aborts every tracked controller; backoff table (attempt 0..5 with `random=()=>1` → 500,1000,2000,4000,8000,8000; with `()=>0` → 0). `classifySendRefusal` table incl. uncoded 409 → `attach`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/stores/aiSessionAttach.test.ts src/stores/aiSendRefusal.test.ts` → FAIL.
- [ ] **Step 3:** Implement (reuse the line-splitting SSE parse used by both stores; no new dependency).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): shared attach reader and send-refusal classifier (#9427)`.

### Task 8: web `aiConversationHandoff` (coordination only)

**Files:**
- Create: `apps/web/src/stores/aiConversationHandoff.ts`, `aiConversationHandoff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PendingHandoff { sessionId: string; origin: 'panel' | 'workspace'; originTabId?: string; draft?: string; startedAt: number }
  export const HANDOFF_TIMEOUT_MS = 15_000; // Gate B #5
  export const useHandoffStore: UseBoundStore<{ pending: PendingHandoff | null }>; // not persisted
  export function beginHandoff(p: Omit<PendingHandoff, 'startedAt'>, onRelease: () => void): Promise<'completed' | 'aborted'>;
  export function completeHandoff(sessionId: string): void;  // destination succeeded → onRelease() runs, resolves 'completed'
  export function abortHandoff(sessionId: string): void;     // resolves 'aborted', onRelease never runs
  export function takeHandoff(sessionId: string): { draft?: string; signal: AbortSignal } | undefined; // destination side; draft read once
  ```
  A second `beginHandoff` aborts the first. Mismatched `sessionId` in complete/abort is a no-op. Timeout or abort fires the pending hand-off's `AbortSignal`; the destination passes it into its open call and must **not** commit a tab or bind the panel once it is aborted (otherwise a late destination plus a kept origin would mirror the session, D3). W3 adds the UI-level `moveToAssistant`/`continueInSidePanel` to this module (T13).

- [ ] **Step 1: Failing tests (fake timers):** complete → `onRelease` once, `'completed'`, `pending` null; abort → no `onRelease`, `'aborted'`; no signal for `HANDOFF_TIMEOUT_MS` → `'aborted'`; complete for another id → ignored; second begin aborts the first; `takeHandoff` returns the draft once then `draft: undefined`; its `signal` is aborted after the timeout.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/stores/aiConversationHandoff.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. W1 gate: `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` → `exit=0`.
- [ ] **Step 5: Commit** `feat(web): conversation hand-off coordinator (#9427)`.

---

## W2 — side panel attaches

### Task 9: `aiStore` attach on restore, on switch and on `turn_in_progress`

**Files:**
- Modify: `apps/web/src/stores/aiStore.ts` (`loadSession` `:440`, `switchSession` `:846`, `sendMessage` refusal branches `:567-622`, new private `attachCurrent`)
- Test: `apps/web/src/stores/aiStore.attach.test.ts` (new; harness from `aiStore.test.ts`)

**Interfaces:**
- Consumes: T6 `openAiSession`, T7 `attachAiSession`, `classifySendRefusal`, `trackAttach`.
- Produces: `aiStore.attachCurrent(): Promise<void>` (internal action; exported on the state for tests) — attaches the bound session, applies events through `processStreamEvent` with the topology filter when `topologySiteId !== null`, guarded by a **new** stream token (`++activeStreamToken`) so a later send/rebind supersedes it exactly as it supersedes a send. Re-attach via `shouldReattach` (T7) with `attachBackoffMs`; an `idle` answer followed by a send 409 starts a 409 cycle (§3.5).
- Reconciliation (owner-guarded by `claimSessionOwnership` + the attach token, one GET each): `attachAnchorMissing` → re-hydrate, then re-attach once; `idle` snapshot with `turnId !== null` (a turn ran on this instance, possibly finishing between hydrate and attach) → re-hydrate messages once; `done` after a `partial` join → re-hydrate messages (§3.5).
- `loadSession`/`switchSession` keep their current shape (and every #5684/#6933/#7769 guard), gain the type rule (`!isChatSessionType(data.session.type)` → treated exactly like their 404 path) and call `attachCurrent()` after a successful hydrate. They do **not** move onto `openAiSession` in this wave (blast radius) — Gate B #11.
- `sendMessage` 409/402 handling routes through `classifySendRefusal`; `attach` → drop the optimistic bubble, put the refused text back in the composer (`composerDraft`, T10), no error banner, `attachCurrent()`. Other outcomes behave exactly as today.

- [ ] **Step 1: Failing tests:** reload restore (`sessionId` persisted, `loadSession`) → one `GET …/stream` after the `GET /ai/sessions/:id`; running snapshot with a pending approval → `pendingApproval` set, `isStreaming:true`; a device-page org mismatch drop (`aiStore.pageContextOrg` scenario) → **no** attach request; `sendMessage` gets `409 {code:'turn_in_progress'}` → no `error`, bubble removed, `composerDraft === 'the text'`, attach started; uncoded 409 → same; attach outcome `closed` → re-attach, and an `unavailable` answer inside that cycle → one more attempt after backoff; a newer `sendMessage` while attached → attach reader cancelled and its later events ignored; topology session → replayed `content_delta` dropped; persisted `script_builder` session id on reload → unbound like a 404, no attach; idle snapshot with `turnId` → one extra `GET /ai/sessions/:id`, idle with `turnId:null` → none; anchor missing → re-hydrate then attach again.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/stores/aiStore.attach.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; then every `aiStore` importer: `rg -l "stores/aiStore" apps/web/src -g '*.test.*'` (29 files on main, incl. `aiStore.*.test.ts`, `AiChatSidebar*.test.tsx`, `AiContinuationPrompt.test.tsx`, the `DeviceDetailPage.*` and dashboard/header/help/topology tests) — run in batches of ~8; all green.
- [ ] **Step 5: Commit** `feat(web): side panel attaches to a running turn on restore and on turn_in_progress (#9427)`.

### Task 10: `releaseSession`, `adoptSession`, composer draft in the store

**Files:**
- Modify: `apps/web/src/stores/aiStore.ts`, `apps/web/src/components/ai/AiChatInput.tsx`, `apps/web/src/components/ai/AiChatSidebar.tsx` (wire the draft)
- Test: `apps/web/src/stores/aiStore.handoff.test.ts` (new), `apps/web/src/components/ai/AiChatInput.test.tsx` (extend or create)

**Interfaces:**
- Produces on `AiState`:
  - `composerDraft: string` (not persisted) and `setComposerDraft(text: string): void`.
  - `releaseSession(sessionId: string): void` — no-op unless `sessionId` is bound; `claimSessionOwnership()` (so an in-flight load/switch cannot rebind), bump `activeStreamToken`, **explicitly cancel** the held send reader and abort the attach controller (module refs kept for this; the token alone is only noticed after the next `read()` returns, `aiStore.ts:631-643`), `set({ ...CLEARED_SESSION, composerDraft: '' })`, `resetModelPicker()`, `close()`. **No fetch.**
  - `adoptSession(sessionId: string, opts?: { draft?: string; signal?: AbortSignal }): Promise<'ok' | 'not_found' | 'closed' | 'error' | 'aborted'>` — `switchSession` semantics (explicit pick: no org-mismatch drop, type rule applied), then `attachCurrent()`; resolves after the attach's `ready` (T7), not after the turn. If `signal` aborts before the bind is committed → `'aborted'`, nothing changes. On `'ok'`: `open()`, `composerDraft = opts.draft ?? ''`.
- `AiChatInput` gains optional controlled props `value?: string; onValueChange?: (v: string) => void`; uncontrolled when absent (workspace keeps working until T11).

- [ ] **Step 1: Failing tests:** `releaseSession(id)` → no `fetchWithAuth` call at all, `sessionId:null`, persisted `breeze-ai-chat` holds `sessionId:null`, `isOpen:false`, a running attach is cancelled and the held send reader's `cancel()` is called synchronously; a `loadSession` in flight when `releaseSession` runs does not rebind when it resolves; `releaseSession('other')` → no change; `adoptSession` with an already-aborted signal → `'aborted'`, nothing bound; `adoptSession` 404 → `'not_found'`, previous session still bound; `adoptSession` ok → `isOpen:true`, attach started, `composerDraft` = draft; `AiChatInput` controlled: typing calls `onValueChange`, external `value` change renders.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/stores/aiStore.handoff.test.ts src/components/ai/AiChatInput.test.tsx` → FAIL.
- [ ] **Step 3:** Implement; sidebar passes `value={composerDraft}` / `onValueChange={setComposerDraft}`.
- [ ] **Step 4:** PASS; re-run the `aiStore` importer batch from T9; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(web): side panel release/adopt primitives and store-held composer draft (#9427)`.

---

## W3 — workspace opens, deep links, both moves

### Task 11: `workspaceStore.openSession`, restore by attach, 409 parity

**Files:**
- Modify: `apps/web/src/stores/workspaceStore.ts` (`TabState` `:20`, `createEmptyTab` `:51`, new `openSession`, `sendMessage` `:311-323`, `restoreWorkspace` `:641`, `cleanupAllStreams` `:674`, `closeTab` `:160`)
- Test: `apps/web/src/stores/workspaceStore.openSession.test.ts`, `workspaceStore.attach.test.ts` (new)

**Interfaces:**
- `TabState` gains (none persisted beyond `sessionId` as today): `orgId: string | null`, `deviceId: string | null`, `deviceLabel: string | null` (hostname from the rebuilt page context), `m365ConnectionId: string | null`, `composerDraft: string`, `joinedMidResponse: boolean`, `errorAction: 'continue_in_panel' | null`.
- Produces:
  ```ts
  export type OpenSessionResult = 'focused' | 'opened' | 'tab_cap' | 'not_found' | 'closed' | 'topology' | 'error';
  openSession: (sessionId: string, opts?: { draft?: string; signal?: AbortSignal }) => Promise<OpenSessionResult | 'aborted'>;
  setComposerDraft: (tabId: string, text: string) => void;
  resetForLogout: () => void; // T14
  ```
  Order (§3.6): existing tab → `switchTab` → `'focused'`; `tabs.length >= MAX_TABS` → `'tab_cap'` (no fetch); `openAiSession` → `not_found`/`closed`/`error` pass through; `type === 'topology'` → `'topology'` (no tab); `signal.aborted` → `'aborted'` (no tab); else append a tab (title, `pageContext` from the view, chips fields), activate it, start the attach and resolve `'opened'` when its `ready` settles (T7) — not when the turn ends. The attach reconciliation rules of T9 apply per tab.
- A module-level `workspaceGeneration` counter is captured by every async action (send, restore, open, attach); `resetForLogout` bumps it, and any continuation whose captured generation is stale writes nothing (this covers the send `finally` at `workspaceStore.ts:418`). A `_attachControllers: Map<tabId, AbortController>` sits beside `_readers`; `closeTab` and `cleanupAllStreams` abort them.
- `restoreWorkspace` uses `openAiSession` per tab and attaches each (fixes fact 3: returning to `/workspace` re-attaches). A non-chat type on restore clears the tab's session like a 404.
- `sendMessage` refusals via `classifySendRefusal`: `attach` → drop bubble, draft back, attach (no error); `continuation`/`choose_model` → `error` "Continue in side panel to choose a model", `errorAction:'continue_in_panel'`; others as today.

- [ ] **Step 1: Failing tests:** open a new id → one GET, tab appended and active, attach started, `openSession` resolves only after `attach_state`; aborted signal → `'aborted'`, no tab; open an id already in a tab → `'focused'`, no fetch; 5 tabs → `'tab_cap'`, no fetch, no tab closed; topology → `'topology'`, no tab; 404 → `'not_found'`; restore with 2 session tabs → 2 hydrates + 2 attaches; `cleanupAllStreams` aborts attaches; `closeTab` makes **no** fetch and aborts that tab's attach; send gets `409 turn_in_progress` → no error, draft restored, attach; `409 continuation_required` → `errorAction:'continue_in_panel'`; **other-org tab survives `useOrgStore.setState({currentOrgId: other})`** and its next send POSTs to the same session id.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/stores/workspaceStore.openSession.test.ts src/stores/workspaceStore.attach.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `npx vitest run src/stores/workspaceStore src/components/workspace` green.
- [ ] **Step 5: Commit** `feat(web): workspace opens existing sessions and re-attaches on restore (#9427)`.

### Task 12: `WorkspacePage` deep link and hash-follows-tab

**Files:**
- Modify: `apps/web/src/components/workspace/WorkspacePage.tsx`
- Create: `apps/web/src/components/workspace/sessionHash.ts` (+ `.test.ts`)
- Test: `apps/web/src/components/workspace/WorkspacePage.deepLink.test.tsx` (new)

**Interfaces:**
- Produces (`sessionHash.ts`): `parseSessionHash(raw: string): string | undefined` (exactly `session=<uuid>`, case-normalised to lower; anything else `undefined`); `writeSessionHash(sessionId: string | null): void` → `history.replaceState(history.state, '', sessionId ? `${pathname}${search}#session=${id}` : `${pathname}${search}`)`.
- `WorkspacePage`: `const [linked, setLinked] = useHashState<string | null>(null, parseSessionHash)` acted on **only after** `canUseAi` is true (permission gate: no fetch, `AccessDenied` as today). Effect on `linked` → `const h = takeHandoff(linked); openSession(linked, { draft: h?.draft, signal: h?.signal })`, then **`setLinked(null)`** once handled (so a later `hashchange` back to an id that was previously linked re-triggers — `replaceState` never updates the hook, `useHashState.ts:98-106`) → then: `'opened'|'focused'` → `completeHandoff(linked)`; `'tab_cap'` → toast "Close a tab to open this conversation" + `abortHandoff`; `'not_found'` → toast "This conversation isn't available", clear hash, abort; `'closed'` → "This conversation was closed"; `'topology'` → toast "Investigations open from the topology map" with an "Open in side panel" action calling `useAiStore.getState().adoptSession(id)`; `'error'` → abort, error toast. Every result other than `'opened'`/`'focused'` calls `abortHandoff(linked)` at once (the origin must not wait out the 15 s timeout). Ordering: `restoreWorkspace` (mount effect, `WorkspacePage.tsx:37`) only re-hydrates existing tabs and never sets `activeTabId` (`workspaceStore.ts:641-672`), so the two effects are independent, and `openSession` sets `activeTabId` when it opens or focuses — the requested session wins over the persisted one. The hash writer (`activeTab?.sessionId` → `writeSessionHash`) runs **only while `linked === null`**, so it cannot wipe a link that has not been handled yet.

- [ ] **Step 1: Failing tests:** `parseSessionHash` table (Review Focus 5) incl. `'session=AAAAAAAA-…'` → lower-case id; page mounted with `#session=<id>` of an existing tab → `switchTab`, no fetch; with a new id → `openSession` called once; mount with a persisted active tab **and** a link → the hash still reads `#session=<linked>` until handled, then the linked tab is active; `hashchange` to another id → opens it; 404 → toast text "This conversation isn't available", `location.hash === ''`, and a pending panel hand-off is aborted at once (panel keeps its session); 5 tabs → toast "Close a tab to open this conversation", tab count still 5; without `ai_sessions:use` → `AccessDenied`, `openSession` never called; switching tabs → `history.replaceState` called with the existing `history.state` and the new hash, and no `hashchange` handler re-entry; link to A, switch to tab B (hash rewritten to B), then `hashchange` to A again → A is focused (re-trigger works); a pending hand-off for that id gets `completeHandoff`; an aborted hand-off signal → no tab, no `completeHandoff`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/workspace/sessionHash.test.ts src/components/workspace/WorkspacePage.deepLink.test.tsx` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `npx vitest run src/lib/__tests__/no-hash-in-usestate.test.ts src/components/workspace` green.
- [ ] **Step 5: Commit** `feat(web): /workspace#session= deep link; hash follows the active tab (#9427)`.

### Task 13: Move controls, chips and copy

**Files:**
- Modify: `apps/web/src/stores/aiConversationHandoff.ts` (add the two flows), `components/ai/AiChatSidebar.tsx` (header `:204-250`), `components/workspace/WorkspaceTab.tsx`, `WorkspaceTabBar.tsx`, `WorkspaceChatPanel.tsx` (header `:83-92`), `locales/*/ai.json` ×8
- Create: `components/workspace/WorkspaceSessionChips.tsx`
- Test: `aiConversationHandoff.flows.test.ts` (new), `AiChatSidebar.move.test.tsx` (new), `WorkspaceTab.test.tsx` (extend), `WorkspaceChatPanel.test.tsx` (extend), `WorkspaceSessionChips.test.tsx` (new)

**Interfaces:**
- Produces (handoff module):
  - `moveToAssistant(sessionId: string, opts: { draft?: string }): Promise<'moved' | 'tab_cap' | 'aborted'>` — lazily `import('./workspaceStore')` (keeps it out of the sidebar bundle); if no tab holds the id and `tabs.length >= MAX_TABS` → `showToast` "Close a tab in the AI Assistant to open this conversation", return `'tab_cap'`, panel untouched. Else start `const result = beginHandoff({sessionId, origin:'panel', draft}, () => useAiStore.getState().releaseSession(sessionId))` **without awaiting it**, then navigate: on `/workspace` → `window.location.hash = 'session=' + id` (real `hashchange`); elsewhere → `navigate('/workspace#session=' + id)` from `astro:transitions/client`; then `await result` and map `'completed'` → `'moved'`, `'aborted'` → `'aborted'`.
  - `continueInSidePanel(tabId: string, opts: { confirm: () => Promise<boolean> }): Promise<'moved' | 'cancelled' | 'failed'>` — if the panel holds a *different* session with a non-empty `composerDraft` or `isStreaming`, await `confirm()` (copy "Replace the conversation in the side panel? It stays in your history."); `adoptSession(id, { draft: tab.composerDraft })`; on `'ok'` → `closeTab(tabId)`; else leave the tab and return `'failed'` with a toast. This direction does not use `beginHandoff`: origin and destination run in one call in the same document, so "release only after the destination succeeded" (D3) is met by ordering — `closeTab` runs only after `adoptSession` resolved `'ok'` on its attach `ready`.
- Controls: sidebar header icon button `data-testid="ai-open-in-assistant"` (`ExternalLink`/`PanelRight` icon, `title` "Open in AI Assistant") rendered when `sessionId && !showHistory && topologySiteId === null`. Workspace: `WorkspaceTab` gets a menu (`data-testid="workspace-tab-menu"`) with "Rename" (existing double-click path) and "Continue in side panel" (`data-testid="workspace-tab-continue-in-panel"`); the tab root becomes a `div role="tab"` with sibling buttons (select, menu, close) so no interactive element nests in a `<button>` — Gate B #8. `WorkspaceChatPanel` header gets a "Continue in side panel" button (`data-testid="workspace-continue-in-panel"`) and the error banner shows it when `tab.errorAction === 'continue_in_panel'`.
- `WorkspaceSessionChips({ orgId, deviceLabel, m365ConnectionId })`: reactive selectors (`useOrgStore((s) => s.organizations)`, `useOrgStore((s) => s.currentOrgId)` — the list starts empty, `orgStore.ts:163`). Org chip when the user has more than one org **or** `orgId !== currentOrgId`; label = the org's name, or "Another organization" while the name is not (yet) known. Device chip with `deviceLabel`; read-only customer chip (name from `useAiStore` `m365Connections` when loaded, else omitted).
- Keys: the 12 strings in Global Constraints under `aiConversationMove.*` (`openInAssistant`, `continueInSidePanel`, `openPastConversation`, `closeTabInAssistant`, `closeTabToOpen`, `notAvailable`, `wasClosed`, `topologyFromMap`, `openInSidePanel`, `replaceConfirm`, `joinedMidResponse`, `chooseModelInPanel`), plus `tabMenu` ("Tab options"), `anotherOrg` ("Another organization"), `device` ("Device"). Translate in all 7 other locales.
- Also render `joinedMidResponse` copy in both surfaces' message area.

- [ ] **Step 1: Failing tests:** `moveToAssistant` with 5 other tabs → `'tab_cap'`, toast, `aiStore.sessionId` unchanged, no navigation; from `/devices` → `navigate('/workspace#session=<id>')`; on `/workspace` → `location.hash === '#session=<id>'`; `completeHandoff` → panel released, **no DELETE**; no completion within `HANDOFF_TIMEOUT_MS` (fake timers; the workspace never mounts) → panel still bound to the same session, still open, draft intact (Review Focus 2); `continueInSidePanel` with an idle empty panel → no confirm, tab closed after adopt; with a streaming different session → confirm shown, cancel → nothing changes; adopt 404 → tab kept; sidebar: button hidden for topology sessions and while History is open; workspace tab menu item and header button call `continueInSidePanel`; chips render org name only for multi-org users; `joinedMidResponse` copy visible.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/stores/aiConversationHandoff.flows.test.ts src/components/ai/AiChatSidebar.move.test.tsx src/components/workspace` → FAIL.
- [ ] **Step 3:** Implement; add keys to all 8 locale files.
- [ ] **Step 4:** PASS; gates: `npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts`; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(web): Open in AI Assistant / Continue in side panel (#9427)`.

### Task 14: Logout clears the workspace and aborts attaches

**Files:**
- Modify: `apps/web/src/stores/auth.ts:1858-1867` (`evictLocalAuthState`)
- Test: `apps/web/src/stores/auth.logoutAiState.test.ts` (new)

**Interfaces:**
- `evictLocalAuthState()` is synchronous (`auth.ts:1858`, called at `:1939`, `:1973`) and both stores statically import `./auth` (`aiStore.ts:4`, `workspaceStore.ts:4`), so `auth.ts` must not import them (cycle) and a dynamic import would run too late. Instead `auth.ts` exports `registerLogoutHook(fn: () => void): () => void`. `aiSessionAttach` registers `abortAllAttaches` and `workspaceStore` registers `resetForLogout` (T11: bump `workspaceGeneration`, cancel readers and attaches, `set({ tabs: [], activeTabId: null })`) at module init. `evictLocalAuthState` runs every hook (each in try/catch) **before** the `removeItem` calls, then also removes `breeze-workspace` — clearing runtime state first stops the persist middleware from writing the old tabs back.

- [ ] **Step 1: Failing test:** hooks run before `removeItem` (order spy); with `breeze-workspace` set, two tabs in memory and one tracked attach controller → after logout the key is gone, `tabs` is empty, the controller is aborted; a send whose `fetch` resolves **after** logout writes nothing and `breeze-workspace` stays absent (the next user logging in); logout with `workspaceStore` never imported (no hook registered) does not throw; a throwing hook or `localStorage.removeItem` does not throw out of logout.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/stores/auth.logoutAiState.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `npx vitest run src/stores/auth` green.
- [ ] **Step 5: Commit** `fix(web): logout removes breeze-workspace and aborts AI attach readers (#9427)`.

---

## W4 — one conversation list, two surfaces

### Task 15: Shared list source and `AiConversationList`; side-panel History uses it

**Files:**
- Create: `apps/web/src/components/ai/useAiConversationSource.ts`, `AiConversationList.tsx` (+ tests)
- Modify: `apps/web/src/components/ai/AiChatSidebar.tsx:253-320` (History view), `apps/web/src/stores/aiStore.ts` (drop `searchResults`/`isSearching`/`searchConversations` **only if** `rg` finds no other caller)

**Interfaces:**
- `useAiConversationSource({ surface }: { surface: 'panel' | 'workspace' })` → `{ items: ConversationRow[]; query: string; setQuery; isLoading; isSearching; error }`. Lists `GET /ai/sessions?status=active`; search `GET /ai/sessions/search?q=` (debounced 300 ms, ≥2 chars). `surface:'workspace'` drops `type === 'topology'` rows and search hits with `status !== 'active'`.
- `ConversationRow = { id; title; orgId; type; deviceId; status; lastActivityAt | createdAt; matchedContent?; openIn: 'panel' | 'workspace' | null }` — `openIn` computed from `useAiStore.sessionId` and `useWorkspaceStore.tabs` (lazy import on the panel side).
- `AiConversationList({ rows, currentSessionId, onPick, surface })`: org chip (multi-org users), device chip (generic "Device", Gate B #9), "Open in side panel"/"Open in AI Assistant" label when `openIn` is the other surface. `data-testid="ai-conversation-row"`.
- Picking in the panel: `openIn === 'workspace'` → close that tab after `adoptSession` (a move, never a duplicate); otherwise `switchSession` as today (closed search hits still open, as today).

- [ ] **Step 1: Failing tests:** hook lists active rows; workspace surface hides topology rows and closed search hits; panel surface keeps both; a row open in the workspace is labelled "Open in AI Assistant" in the panel list and picking it moves (tab closed, panel bound, no DELETE); org chip only with ≥2 orgs; device chip on `deviceId` rows.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/ai/useAiConversationSource.test.ts src/components/ai/AiConversationList.test.tsx src/components/ai/AiChatSidebar.test.tsx` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `aiStore` importer batch green; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(web): shared AI conversation list with org/device chips (#9427)`.

### Task 16: Workspace "Open a past conversation"

**Files:**
- Create: `apps/web/src/components/workspace/WorkspaceConversationPicker.tsx` (+ test)
- Modify: `WorkspaceTabBar.tsx` ("+" becomes a two-item menu: "New chat", "Open a past conversation"), `WorkspaceEmptyState.tsx` (same second action), `WorkspacePage.tsx`

**Interfaces:**
- Picker is a popover over `AiConversationList` with `surface:'workspace'`. Pick → if `openIn === 'panel'`: `openSession(id, { draft: useAiStore.getState().composerDraft })` then `useAiStore.getState().releaseSession(id)` on `'opened'` (a move, D3); else `openSession(id)`. Results reuse T12's toast mapping (extract it to `sessionHash.ts` as `toastForOpenResult(result)` so both paths share copy). At 5 tabs the "+" menu shows "Open a past conversation" disabled with the "Close a tab to open this conversation" hint.

- [ ] **Step 1: Failing tests:** "+" opens a menu with both items; picking a row opens a tab; picking a panel-held row moves it (panel released, no DELETE); at 5 tabs the item is disabled; topology rows absent.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/workspace` → FAIL.
- [ ] **Step 3:** Implement; keys `aiConversationMove.newChat` ("New chat") if `workspaceTabBar.new` does not already read that way — reuse before adding.
- [ ] **Step 4:** PASS; i18n + silent-mutation gates as T13; `tsc` exit 0.
- [ ] **Step 5: Commit** `feat(web): open a past conversation in the AI Assistant (#9427)`.

---

## W5 — polish, E2E, docs, live checks

### Task 17: Placement/copy pass, E2E, docs

**Files:**
- Create: `e2e-tests/tests/ai-move-conversation.spec.ts` (+ page-object additions under `e2e-tests/pages/`)
- Modify: user docs for the AI Assistant under `apps/docs/` (use the `update-breeze-docs` skill), any copy fixes from review in `locales/*/ai.json`

**Interfaces:**
- E2E (`data-testid` only, AI provider stubbed the way existing AI E2E specs do; if none stub the provider, cover only idle moves and the deep link): start a side-panel chat → `ai-open-in-assistant` → workspace tab shows the same title and history → `workspace-continue-in-panel` → panel shows it, tab gone → reload `/workspace#session=<id>` reopens it.

- [ ] **Step 1: Failing spec** against a wt-stack (`pnpm wt-stack up`, see "Running integration tests"), run `cd e2e-tests && npx playwright test tests/ai-move-conversation.spec.ts` → FAIL on a pre-W5 build only if a control is missing; otherwise record it as a regression guard that passed on first run and say so in the PR.
- [ ] **Step 2:** Docs + copy pass; full gates: `cd apps/web && npx vitest run src/lib/i18n src/lib/__tests__` and `tsc` exit 0 in `apps/web`, `apps/api`, `packages/shared`.
- [ ] **Step 3:** Live checks (§8), recorded in the PR body with what was seen: (a) move a device-bound chat mid-turn while it waits on a tier-2 approval, approve from the destination; (b) partner user opens an other-org session through a deep link — org chip shown, switcher unchanged; (c) leave `/workspace` mid-turn and return — the tab re-attaches.
- [ ] **Step 4:** `pnpm wt-stack down`; state what was left running (nothing).
- [ ] **Step 5: Commit** `test(e2e),docs: move conversations between side panel and AI Assistant (#9427)`.

---

## Seam with #9428 (Try again) and #9429 (notifications)

All three plans edit the same few files. Whichever PR lands second rebases and keeps both behaviours; the owner below decides a conflict.

| File / region | #9427 (this) | #9428 | #9429 | Owner on conflict |
|---|---|---|---|---|
| `packages/shared/src/types/ai.ts` `AiStreamEvent` | adds `attach_state` | widens `error` (`code`, `detail`) | — | each owns its member |
| `routes/ai.ts` `/messages` 409s | adds `code:'turn_in_progress'` (`:893-898`, `:1049`) | relies on 409 `turn_in_progress` in retry | — | **#9427** |
| `routes/ai.ts` user-row insert `:1061` | `.returning({id})` → `turnUserMessageId` | skips the insert on `retry` | — | **#9428** owns the branch; when it skips, it must set `turnUserMessageId` to the existing trailing row's id (add to #9428 Task 3 tests) |
| `routes/ai.ts` stream callback `:1126-1155` | adds `onAbort` | adds `code:'stream_error'` in `catch` | — | shared; trivial merge |
| `streamingSessionManager.ts` | bus → `sessionEventBus.ts`, `turnId` | `code` at `error` publish sites | — | none overlap; #9428 edits publish **calls**, not the bus |
| `processStreamEvent.ts` | `attach_state` case, `joinedMidResponse` | `error` case, `errorCode`/`errorDetail` | — | each owns its case |
| `aiStore.sendMessage` refusals `:567-622` | `classifySendRefusal` (`stores/aiSendRefusal.ts`) | `retry` opts, `classifyHttpFailure` (`lib/aiErrors.ts`) | notify calls in the SSE loop | **#9427** owns the refusal branch. `classifySendRefusal` runs first; only its `'error'` result falls through to #9428's `classifyHttpFailure`. On a retry that gets `turn_in_progress`: keep the original bubble (#9428 rule), skip the composer restore (a retry has no fresh text), and attach (this plan) |
| `workspaceStore` SSE loop / `switchTab` / `markTabRead` / `closeTab` | attach controllers, `openSession` | `retryLastTurn(tabId)` | `notifyAi`, `closeAiNotification` | #9429 owns the SSE-loop emit points; attach events also go through `notifyAi` once both land (follow-up below) |
| `AiChatSidebar` header `:204-250` | "Open in AI Assistant" icon | — | bell toggle | order: History · Open in AI Assistant · New · Flag · Bell · Close |
| Banners (`AiChatSidebar:366`, `WorkspaceChatPanel:104`) | `errorAction` button, `joinedMidResponse` line | `AiErrorBanner` replaces both | — | **#9428** owns the banner; this plan passes its extra action as a prop if `AiErrorBanner` exists by then |
| `locales/*/ai.json` | `aiConversationMove.*` after `aiChatSidebar` | `aiErrorBanner.*` | `aiNotifications.*` | distinct keys; this plan inserts after `aiChatSidebar`, not at EOF |
| `stores/auth.ts` logout | `registerLogoutHook`, `breeze-workspace` | — | — | #9427 |

Follow-ups created by the seam (not in this plan): #9428 `retryLastTurn` for `disconnect`/`stream_error` should re-attach through `attachAiSession` instead of a plain reload once both are on main; #9429's workspace `onOpen` can deep-link `/workspace#session=<id>`, and attach-delivered `done`/`approval_required` should notify like send-delivered ones.

## CI and execution traps

- `tsc` heap: always `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`; never pipe to `tail` (OOM reads green).
- Scoped vitest is a substring match: `src/routes/ai.` matches every `ai.*.test.ts`; check the file count printed. Never `pnpm --filter … test -- --run`.
- `selfManagedDbContextRoutes.test.ts` enumerates paths — add the GET row there in T4 or the Lint/Test API job fails.
- `localeParity.test.ts` (8 locales) and `keyUsage.test.ts` (no template-literal keys) live in `apps/web/src/lib/i18n`.
- `no-hash-in-usestate.test.ts`: use `useHashState`; never `useState(() => location.hash…)`.
- `no-silent-mutations.test.ts`: this feature adds GETs only; zero allowlist/ratchet edits expected. If a reviewer asks for a mutation, wrap it in `runAction`.
- The integration test (T5) runs only in the 16-shard **Integration Tests** job, never in Test API; run it locally first.
- `astro:transitions/client` is a virtual module; vitest maps it to `apps/web/src/__mocks__/astro-transitions-client.ts` — spy on `navigate` there.
- New `apps/api/src/services/sessionEventBus.ts` does not read `devices`, so `parkedFanout.contract.test.ts` needs no entry; re-check if that changes.
- Each wave PR targets `main`. A stacked PR (base ≠ main) gets no CI: `gh workflow run CI --ref <branch>`.

### Running integration tests

Per-worktree stack: copy root `.env` with AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false`, a free `BREEZE_DOCKER_SUBNET=172.31.N.0/24` + `BREEZE_CADDY_IP`, `pnpm wt-stack up`; then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiSessionList.integration.test.ts`; then `pnpm wt-stack down`.

## Advisor quorum (Codex `gpt-6-astra`, `xhigh`, read-only, 2026-10-23)

Codex read the spec, this plan and the code. It **agreed** with one-turn attaches, synchronous subscribe→snapshot, abort teardown, reuse of `getSession` for authz (no server authorization bypass found) and server-held device/org bindings. It raised ten findings; all were adopted:

| # | Finding | Change in this plan |
|---|---|---|
| 1 | Logout leaves runtime tabs; a late send re-persists them | T11 `workspaceGeneration` + `resetForLogout`; T14 clears runtime state before storage |
| 2 | Fallback truncation anchor deletes valid history and system notes | T1: exact anchor only, delete only turn-output rows; missing anchor → re-hydrate (T9) |
| 3 | Hand-off had no readiness milestone; late destination could mirror | T7 `ready`/`finished`; T8 hand-off `AbortSignal`; T10/T11 resolve on `ready`, honour the signal; T10 release claims ownership and cancels readers explicitly |
| 4 | Turn finishing between hydrate and attach loses the reply; partial join drops deltas | T1 placeholder on partial; T9 idle/`done` reconciliation (Gate B #15) |
| 5 | Pending cards inferred from events miss plan reject/timeout; merged, not replaced | T2b registry by id; T1 replaces pending state |
| 6 | DB plan steps overwrite replayed step outcomes | T2 bus-derived live plan at `lastSeq`; no DB read |
| 7 | `unavailable` during the `remove()`→recreate gap stops retries | T7 `shouldReattach` |
| 8 | `replaceState` leaves `useHashState` stale; repeat links stall | T12 `setLinked(null)` after handling |
| 9 | Panel load/switch still bind non-chat sessions | T9/T10 type rule |
| 10 | Org chip non-reactive; byte cap measured UTF-16 units | T13 reactive selectors + fallback; T2 UTF-8 bytes |

## Follow-ups (out of this plan)

- **Store merge (D1 option B)** — one session-keyed runtime for side panel and tabs; its own spec.
- Device hostname in list rows (needs a join; Gate B #9).
- Tier-3 intents that outlive their turn in idle attach snapshots (§5).
- Mobile adopting the attach route instead of its reconcile poll.
- Owner-slot routing of `/messages` + attach under #8139 W4.

## Decisions for Gate B (plan default in brackets)

1. Five waves as tabled; move controls ship only with attach in W3 [**yes**]
2. Attach subscribers per turn bus [**8**; the 9th gets `429 attach_limit`]
3. Replay byte cap per turn [**256 KiB**, measured on serialized events; screenshots replaced by `imageBase64: ''`; over the cap → `partial`]
4. Attach ping interval [**25 s**, reuse `CLIENT_AI_SSE_PING_INTERVAL_MS`]
5. Hand-off timeout before the origin keeps the session [**15 s**]
6. Re-attach backoff [**500 ms × 2ⁿ, cap 8 s, full jitter, 4 attempts**; on exhaustion re-hydrate once, stop streaming, no banner]
7. A send refused with `turn_in_progress` (or an uncoded 409): attach and put the refused text back in the composer, no error banner [**yes**]
8. `WorkspaceTab` root changes from `<button>` to `div role="tab"` with sibling select/menu/close buttons, so the new menu does not nest interactive content [**yes**]
9. List device chip is a generic "Device" chip (no hostname; avoids a `devices` join) [**yes**]
10. Running-turn replay replaces only the turn's own persisted output rows (`assistant`/`tool_use`/`tool_result`) after the exact `turnUserMessageId`; a missing anchor re-hydrates instead of guessing [**yes**]
11. `aiStore.loadSession`/`switchSession` keep their code, add the chat-type rule and attach; they move onto `aiSessionOpen` with the store merge, not now [**yes**]
12. Extract `SessionEventBus` into `services/sessionEventBus.ts` (re-exported) [**yes**]
13. Org chip when the user has >1 org or the session's org is not the current one; "Another organization" while the name is unknown [**yes**]
14. Feature registration (`register_feature`, wave sub-issues) by the orchestrator after this gate [**yes**]
15. An `idle` attach on a session that ran a turn on this instance re-reads messages once (closes the hydrate→attach race at the cost of one GET) [**yes**]
16. Pending cards tracked by id where the wait lives (`ActiveSession.pendingCards`, T2b), not inferred from the event stream; active-plan state derived on the bus — so the attach route reads nothing from `ai_action_plans` [**yes**]
