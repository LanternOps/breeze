---
status: draft — awaiting Todd's decisions (§7). Quorum: Codex gpt-6-astra xhigh, read-only, 2026-10-21. It agreed on D2 and D3 and disagreed on D1 (both positions in §7).
date: 2026-10-21
tracking_issue: LanternOps/breeze#9427
related: "#9428 (Try again, plan-only), #9429 (browser notification, plan-only), #7002 (device pin on tier-3 intents), #6474 (keep-alive events), #7772 (in-turn failover replay), #8139 W4 (in-process state across API instances)"
---

# AI chat: move conversations between the side panel and the AI Assistant

**Scope:** web chat surfaces (`apps/web/src/stores/aiStore.ts`, `apps/web/src/stores/workspaceStore.ts`, `apps/web/src/components/ai/AiChatSidebar.tsx`, `apps/web/src/components/workspace/*`) plus one new read-only API route. This document records intent and decisions. It contains no plan and no code.

**Evidence:** "verified" means the author or the verification pass re-read the code on `origin/main` at `30e8ee7c44`. "Inferred" means it follows from the code but was not exercised.

## 1. Problem

There are two chat surfaces, and both run on `/ai/sessions`:

- The **side panel**: `AiChatSidebar`, mounted in `DashboardLayout.astro:72` with `transition:persist`. It shows one session at a time, held in `aiStore`.
- The **AI Assistant**: `/workspace`, `WorkspacePage`. It shows up to five tabs, each a session, held in `workspaceStore`.

A conversation cannot move between them:

- A side-panel chat that outgrows 400 px cannot be opened in the AI Assistant.
- A workspace conversation cannot be continued in the side panel while the user works on another page.
- The workspace can only start empty tabs. `createTab` (`workspaceStore.ts:142`) never opens an existing session, so the workspace has no way to reopen a past conversation at all.

Verified facts that shape the design:

1. **Only one live stream exists, and it is the send.** `POST /ai/sessions/:id/messages` (`routes/ai.ts:778`) is the only route that streams a staff chat. It subscribes to the in-memory `SessionEventBus` (`services/streamingSessionManager.ts:319`). That bus supports several subscribers and keeps a 100-event ring buffer (`:72`) with `getReplayEvents()` (`:357`), but nothing outside tests calls `getReplayEvents()`. No route lets a second client attach to a turn that is running. A second send while a turn runs gets a 409 (`routes/ai.ts:890-895`, `:989` `turn_in_progress`, `:1046`). The one exception is a turn blocked only on approvals: `settleBlockedTurnForNewMessage` concludes that turn so the new message can go through.
2. **Pending cards exist only in the stream.** `mapMessagesFromApi` (`processStreamEvent.ts:543`) restores persisted messages only. `pendingApproval` and `pendingPlan` are set only from SSE events (`:267`, `:309`). `activePlan` is created on the client when a plan is approved (`aiStore.ts:713`, `workspaceStore.ts:472`) and is then updated from SSE events (`:320-344`). Nothing restores any of the three on reload. A reload, or a second surface, loses the approval card while the server still waits on it.
3. **The workspace drops its streams on navigation.** `WorkspacePage` unmount calls `cleanupAllStreams` (`WorkspacePage.tsx:38`). Leaving `/workspace` mid-turn cancels the reader. The turn keeps running on the server (inferred), but the tab never sees its end.
4. **The device pin lives on the server.** `ai_sessions.device_id` and the `context_snapshot.orgAnchor` written by `buildSessionContextSnapshot` drive `buildChatSessionToolAuth` (`streamingSessionManager.ts:745`, `aiSessionOrgAnchor.ts:41`). Passing the session id to the other surface keeps both the device-bound pin and the device-page write default. Nothing about the pin travels in client state.
5. **Sessions are owner-only and ignore the org switcher.** `getSession` and `listSessions` (`services/aiAgent.ts:279`, `:304`) filter on `user_id = auth.user.id` plus the caller's accessible orgs. No middleware on `/ai/*` narrows by the `?orgId=` that `fetchWithAuth` injects, and `aiSessionQuerySchema` strips that parameter. A partner user therefore sees their sessions from every org they can access.
6. **The history list leaks non-chat sessions.** `listSessions` has no `type` filter. Script-builder sessions (`type = 'script_builder'`, `scriptBuilderService.ts:51`) and MCP-ledger sessions (`type = 'mcp'`, `mcpToolExecutionLedger.ts:124`, when the actor is a staff UUID) already appear in the side-panel history today.
7. **The two stores have drifted apart.** `aiStore` owns things `workspaceStore` lacks:
   - the model picker (`aiModelPickerStore`, a singleton)
   - the M365 customer binding
   - topology investigation filtering (`TOPOLOGY_TURN_EVENTS`, `:236`)
   - the device-page org-mismatch drop (`pageContextOrgMismatch`, `:143`)
   - stream and session ownership tokens (`:215`, `:225`)
   - coded 409 handling (`continuation_required`, `turn_in_progress`, recoverable model codes)

   The workspace creates sessions with only `{pageContext, title}`, and it handles every 409 the same way (`workspaceStore.ts:253`, `:313`).
8. **Logout leaves the workspace behind.** Logout removes `breeze-ai-chat` but not `breeze-workspace` (`stores/auth.ts:1857-1859`). Workspace tab titles and page contexts survive a sign-out on a shared browser.

## 2. Users and scope

- **Who:** any staff user with `ai_sessions:use`. Partner-scope and org-scope users are treated the same. Both surfaces and every `/ai/sessions` route already require this permission (`AiChatSidebar.tsx:85`, `WorkspacePage.tsx:26`).
- **Which sessions:** only the caller's own (fact 5). Moving never shares a conversation with another user and never widens what a user can reach.
- **Partner vs org:** neither surface narrows by the org switcher, and this spec keeps that. A partner user may hold conversations in several customer orgs at once. Each one is labelled with its org, and opening one never changes the switcher.
- **Not in scope:** portal or client-AI sessions (`clientAi`), helper and Office sessions, AI agent runs, and mobile. Mobile keeps its own reconcile poll (`apps/mobile/src/screens/chat/HomeScreen.tsx:167-215`). It could adopt the attach route later.

## 3. Proposed design

### 3.1 Vocabulary

- **Surface:** the side panel, or one workspace tab.
- **Move:** hand a session from one surface to another within the same browser document. The origin **releases** the session (D3). Release is local only. It never calls `DELETE /ai/sessions/:id`, the way `aiStore.closeSession` (`:771`) does.
- **Open:** bind a surface to an existing session that is not shown anywhere else in this document. Open is the same operation as Move, without an origin to release.
- **Attach:** subscribe a surface to a session's live events and its current-turn snapshot (§3.5), without sending anything.

### 3.2 Store ownership (D1)

Keep `aiStore` (side panel) and `workspaceStore` (tabs) as separate stores, as recommended in D1. They are joined by three new shared modules under `apps/web/src/stores/` (names are indicative):

| Module | Owns | Used by |
|---|---|---|
| `aiSessionOpen` | One `GET /ai/sessions/:id` call mapped to a typed view of the session: id, title, status, `orgId`, `type`, `deviceId`, flag, `lastTurnModel`, M365 binding id, and the page context rebuilt from `context_snapshot` with the server-only `orgAnchor` key dropped. Also the messages, from `mapMessagesFromApi`. | `aiStore.loadSession`, `aiStore.switchSession`, `workspaceStore.restoreWorkspace`, the new `workspaceStore.openSession` |
| `aiSessionAttach` | The fetch-SSE reader for `GET /ai/sessions/:id/stream` (§3.5). It applies `attach_state`, drops events at or below the snapshot sequence, and stops when its owner is superseded. | both stores |
| `aiConversationHandoff` | `moveToAssistant(sessionId)` and `continueInSidePanel(tabId)`. Each prepares the destination first and releases the origin only after the destination succeeds. | the side-panel header, the workspace tab actions, both history lists |

Two parity rules move into the shared code. They apply to any session the workspace may now open:

- Coded 409s get the same treatment in both stores. A 409 caused by another turn (`turn_in_progress`, which W1 adds to every such 409, §3.5) attaches instead of showing an error. `continuation_required` and the recoverable model codes tell the user to "Continue in side panel to choose a model". The model picker stays in the side panel only (§5).
- Topology sessions never open in the workspace (D4). That keeps the workspace off the topology event filter, which exists only in `aiStore`.

### 3.3 Side panel → AI Assistant

1. **Control.** The side-panel header gets an "Open in AI Assistant" icon button, next to History and New. It shows when a session is bound, History is closed, and the session is not a topology investigation.
2. **Steps** (`moveToAssistant`):
   1. If `/workspace` already has a tab for this session, it is used. Otherwise the tab cap (`MAX_TABS = 5`) is checked first. When the cap is reached, the move stops, the user sees "Close a tab in the AI Assistant to open this conversation", and the side panel keeps the session.
   2. Navigate with Astro `navigate('/workspace#session=<id>')`, or set the hash if the user is already on `/workspace`.
   3. When the workspace reports the tab is open, the side panel releases the session. The signal is explicit: `moveToAssistant` records a pending hand-off `{sessionId, origin: 'panel'}` in `aiConversationHandoff`, a module-level store that survives the navigation because the panel stays mounted. When `WorkspacePage`'s hash handler (§3.6) finishes `openSession` it calls `handoff.complete(sessionId)`, and only that call releases the origin. A failure calls `handoff.abort(sessionId)`, and the panel keeps the session. Release supersedes `activeStreamToken`, clears `sessionId` and `sessionOrgId` without a DELETE (which also clears the persisted `breeze-ai-chat` reference), resets the model picker the way `CLEARED_SESSION` does, and closes the panel.
3. **A turn already running** in the side panel is handed over, not finished first (D2):
   - The panel's reader is cancelled when it releases. The turn itself is not interrupted: the `finally` block at `routes/ai.ts:1148` only unsubscribes. The server unsubscribes the cancelled reader immediately only once W1 adds the `onAbort` handler to `POST /messages` (§3.5). Today it stays subscribed until `done`.
   - The new tab attaches (§3.5). It renders the partial assistant text and any pending approval or plan from the snapshot, then follows the live tail.
4. **What carries over:**
   - **Full history:** the tab hydrates from the server.
   - **Device pin and page-context org anchor:** server-side (fact 4). The tab shows a device chip built from the context snapshot.
   - **Model:** the session's stored offering is server-side, so the next turn runs on it.
   - **M365 binding:** server-side. The tab shows a read-only customer chip.
   - **Pending approval or plan:** from the attach snapshot, with the original deadlines.
   - **Draft text:** a non-empty composer draft goes with the move, carried as an optional `draft` field on the pending hand-off. The destination puts it into its composer, and it is never persisted. Otherwise the panel would drop it silently.

### 3.4 AI Assistant → side panel

1. **Control.** "Continue in side panel" goes on each tab: in the tab's menu (`WorkspaceTab.tsx`) and as a button in the chat panel header (`WorkspaceChatPanel.tsx`).
2. **Steps** (`continueInSidePanel`):
   1. If the side panel already holds a *different* session with a non-empty draft or a running turn, the user confirms first: "Replace the conversation in the side panel? It stays in your history." It is never replaced silently.
   2. `aiStore.switchSession(id)` binds the panel. This is an explicit pick, so it is not dropped on an org mismatch (`aiStore.ts:848`). The panel opens, and `aiSessionAttach` attaches (unconditionally, §3.5). The tab's draft rides on the hand-off as in §3.3.
   3. On success, the workspace closes the tab. `closeTab` already makes no API call. It cancels that tab's reader, and the panel is now the subscriber. The `#session=` hash then follows the newly active tab (§3.6).
3. The user stays on `/workspace` (the panel is mounted there too), or keeps working on any other page.
4. **Known existing behaviour, kept on purpose:** if the user later opens a device page in another org, `setPageContext` → `pageContextOrgMismatch` unbinds the panel, as it does today (#5684). The session is not lost. It stays in history.

### 3.5 Attaching to a session: `GET /ai/sessions/:id/stream` (D2)

This is a new owner-only, read-only route on `aiRoutes`.

**One turn, not one session (verified, PR review).** Every `POST /messages` replaces the session's in-memory state before the new turn starts. `routes/ai.ts:898-900` calls `streamingSessionManager.remove()`, which runs `eventBus.closeAll()` (`streamingSessionManager.ts:1386`), and the turn then runs on a new `ActiveSession` with a new `SessionEventBus`. An event bus therefore lives for one turn. The attach stream is designed around that:

- An attach covers **at most one turn**. On an idle session it sends one frame and closes. On a running turn it streams until that turn's `done`, or until the bus closes, and then it ends.
- A surface does not hold a stream open between turns. A surface that sends gets its turn's events from its own `POST /messages`, as today.

Making the attach per turn also settles three review findings:

- Access is re-checked by `getSession` at the start of every attach, so a stream can never outlive a revoked permission, org access or topology site by more than the one turn it covers. That turn is bounded by the turn timeout.
- Persistent streams are not possible, so six tabs cannot fill the browser's per-host connection limit between turns.
- Nothing is subscribed while a session is idle.

**Access and guards**

- Middleware: `requireScope('organization','partner','system')`, then `requireAiUse`. No `requireMfa`, the same as `GET /sessions/:id`, because the route reads only.
- The route authorizes through `getSession(sessionId, auth)` before it subscribes. A 404 means not the owner, no org access, a revoked topology site, or a session `type` other than `general` and `topology` (`script_builder`, `mcp`). The response does not say which. `openSession` applies the same type rule.
- It is registered in `selfManagedDbContextRoutes`, so no request transaction stays open for the life of the SSE stream. This copies the `/messages` route and is what #3127 was about.
- It **never creates** an in-memory session. The client-AI `/events` route does create one (`routes/clientAi/sessions.ts:909`), but for staff chat that would start an SDK subprocess just because someone looked.
- It **never sends**. Reconnecting must never go through `POST /messages`, because that path can settle an approval-blocked turn.
- It **must tear down on abort.** Hono's stream `write` swallows write errors, so without a handler a closed client stays subscribed until `done`. The route registers `stream.onAbort(() => { clearInterval(ping); eventBus.unsubscribe(id) })`, as `routes/clientAi/sessions.ts:958-961` does. W1 adds the same `onAbort` unsubscribe to `POST /messages`, which has none today (`routes/ai.ts:1123-1149`). That is what makes "the origin's cancelled reader stops receiving" true.
- Each `SessionEventBus` gets a small cap on subscribers. The plan sets the value. Past the cap the route answers 429.

**First frame.** The first frame is always a new `attach_state` event, added to the shared `AiStreamEvent` union. The exhaustive switch in `processStreamEvent` (`:514`) then forces both stores to handle it. Its fields:

| Field | Meaning |
|---|---|
| `turn` | `idle`, `running`, or `unavailable`. `unavailable` means the session is not in memory on this instance. |
| `turnId`, `lastSeq` | identity of the current turn (one per `ActiveSession`), and the highest sequence the snapshot covers |
| `replay` | the current turn's events from its `message_start`, when the buffer still holds them all. Otherwise `partial: true`, and the client shows "Joined mid-response. The full reply appears when it finishes." It reloads persisted messages on `done`. |
| `pendingCards` | the **verbatim** `approval_required` and `plan_approval_required` events that are still unresolved. Being verbatim, they keep the server's sanitisation, `intentBacked`, `approvalExpiresAt` and `intentExpiresAt`. The original deadline is never extended. |
| `activePlan` | the executing plan's id, steps and current index. Durable status comes from `ai_action_plans` (`schema/ai.ts:364`), live step state from the in-memory session. |
| `turnModel` | what is running the turn |

**Server additions**

- Each `SessionEventBus.publish` stamps a monotonic `seq`. The bus is per turn, so `seq` restarts with each turn, and `(turnId, seq)` identifies an event.
- The `ActiveSession` keeps the unresolved card events, keyed by execution id or plan id. Each entry is removed when its `tool_result`, `unattended_release` or plan decision arrives, or when the turn ends.
- **Known limit: tier-3 intents.** A tier-3 intent stays pending after its turn concludes, for example after `settleBlockedTurnForNewMessage` (`routes/ai.ts:877-884`). Once the turn is gone, its card is not in any snapshot. Those intents remain decidable from the existing approvals surfaces. Carrying them into an idle attach is out of scope (§5).
- The replay buffer holds the whole current turn, capped by **bytes**, not by event count. `plan_screenshot` events carry `imageBase64` (`packages/shared/src/types/ai.ts:309`), and up to `MAX_ACTIVE_SESSIONS = 200` sessions (`streamingSessionManager.ts:68`) may be in memory, so screenshots are replaced by a placeholder in replay. A turn that overflows the cap replays as `partial: true`.

**Ordering.** The route subscribes first, then builds the snapshot, then streams live events with `seq > lastSeq`. That makes the boundary atomic, and the client de-duplicates by `(turnId, seq)` as well. A sequence gap makes the client re-attach for a fresh snapshot.

**Pings.** The route sends a `ping` at once, as the subscriber-registered beacon, and then on an interval while the turn runs. The interval keeps idle proxies open during long tool calls, which is compatible with #6474.

**Topology.** The provider text of a topology turn never reaches the bus; the output gate handles that. `aiStore` still applies `TOPOLOGY_TURN_EVENTS` to replayed and live events. The workspace never attaches to a topology session.

**More than one API instance.** The route reads in-process state. Under #8139 W4, AI streaming sessions are routed by owner slot (`horizontal-api-scaling-design.md:245`), and that routing must cover this route as well as `/messages`. The plan adds this route to that spec's in-process-state table. Until then:

- `turn: 'unavailable'` is an honest answer, and the client falls back to `GET /sessions/:id`.
- An instance can hold a stale idle copy while the turn runs on another instance. The client therefore treats `idle` followed by a 409 on its next send as `unavailable`.
- Re-attach after a 409 uses capped backoff with jitter, so a wrong-instance answer cannot become a retry loop.

**When clients attach.** `GET /sessions/:id` reports no turn state (`routes/ai.ts:325-345`), so clients attach unconditionally. Attaching to an idle session costs one frame.

- On every move or open, right after hydration.
- On `restoreWorkspace`, and on side-panel restore after a reload.
- On a 409 caused by another turn. W1 adds `code: 'turn_in_progress'` to the two ordinary second-send 409s, which carry no code today (`routes/ai.ts:890-895` failed settle, `:1046` lost the processing slot). Only the reservation path (`:989`) carries the code now.

This also fixes fact 3: returning to `/workspace` re-attaches the tabs whose readers were cancelled.

**Logout.** Logout aborts every open attach reader, in both stores, before it clears storage (§3.8).

### 3.6 Deep link and URL state

- **Shape:** `/workspace#session=<uuid>`. The value is read with `useHashState` (`lib/useHashState.ts:86`). `no-hash-in-usestate.test.ts` guards that pattern. The hash is ignored unless it is a UUID.
- **On load and on `hashchange`**, the steps run in this order:
  1. An existing tab for the session → `switchTab`.
  2. Otherwise, the tab cap is reached → toast "Close a tab to open this conversation". Nothing is evicted.
  3. Otherwise, `openSession(id)` → `aiSessionOpen`, then a new tab.

  The requested session wins over the persisted `activeTabId`.
- **After that, the hash follows the active tab's session** through `history.replaceState`, so it adds no history entry. Switching tabs updates it. A tab with no session yet clears it. Reloading or copying the URL reopens the same conversation. The URL never carries anything except the session id.
- **Failures:**
  - 404 → "This conversation isn't available", and the hash is cleared. The wording never says whether the session exists.
  - Status `closed` or `expired` → "This conversation was closed", in v1 (D4).
  - Topology session → "Investigations open from the topology map", plus a link to open it in the side panel.
- **Permission:** without `ai_sessions:use`, the page renders `AccessDenied` as it does today and never reads the hash.
- **Other org:** fact 5 means the session opens whatever org the switcher shows. The tab carries an org chip, and the switcher is not changed (D5).

### 3.7 History lists (D4)

The side-panel History view and a new workspace "Open a past conversation" picker read one shared list:

- **Source:** `GET /ai/sessions?status=active`. The listing gains a server-side `type IN ('general','topology')` filter, which fixes fact 6. Its projection gains `orgId`, `type` and `deviceId`. Both changes are additive and add no new columns.
- **Order:** most recent activity first, as today.
- **Org label:** shown when the user can reach more than one org. The name comes from `orgStore`.
- **Device chip:** shown on device-bound rows.
- **Where a session is already open:**
  - If it is open in the *other* surface of this document, the row says so ("Open in side panel" or "Open in AI Assistant"). Picking it **moves** the session; it is never duplicated.
  - In the workspace picker, topology rows are hidden (D4).
- **Search:** `searchSessions` (owner-only, any status) gains the same `type` filter, and its results gain `status` and `type`, which they lack today (`services/aiAgent.ts:800`). Both lists use one shared search box. The side panel keeps opening closed hits as it does today. The workspace picker lists only `active` hits, so it never offers a conversation it would refuse to open (§3.6, D4).
- **Mobile:** mobile reads the same `GET /ai/sessions` (`apps/mobile/src/services/aiChat.ts:148`), so it also stops listing script-builder and MCP sessions. That is the intended fix and the only mobile-visible change.

### 3.8 Logout

Logout aborts every attach reader in both stores, then also removes `breeze-workspace` (fact 8). With this feature the workspace can hold sessions from several orgs, so leaving its titles and page contexts behind after a sign-out is no longer acceptable.

## 4. Tenancy and data model impact

- **No new table, no new column, no migration.** `ai_sessions` is already in `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:197`): `context_snapshot` is `excludedOpen`, and `user_id`, `device_id` and `type` are `included`. None of that changes.
- **No per-user preference.** Where a conversation is open is browser-local state, persisted in the two existing localStorage keys. It is not a setting, so `docs/agents/settings.md` does not apply.
- **New API surface:**
  - The attach route. It is owner-only through `getSession`, so it reaches exactly the rows `GET /sessions/:id` already returns.
  - The list projection change (`orgId`, `type`, `deviceId`). It exposes nothing the caller cannot already read from `GET /sessions/:id`.
  - The list `type` filter. It narrows results.
- **RLS:** unchanged. The attach route's only DB read is `getSession` plus the plan-status read, each in its own short caller-scoped context.
- **#7002 interaction:** none. A move keeps the session row, so it keeps whatever device pin the session has. #7002's gap is the tier-3 intent release, and that is the same whichever surface proposed the intent.

## 5. Out of scope

- **#9428 "Try again"** and **#9429 browser notifications** are separate plan-only items. This spec only makes room for them. The attach route gives #9429's notification click a target (`/workspace#session=<id>`, or the side panel). `aiSessionAttach` is where #9428's retry would re-attach after a disconnect.
- **#6474 keep-alive** is not delivered here. The attach stream's `ping` is compatible with it, but the `/messages` stream is untouched.
- **#7772** (in-turn failover replay) is not touched.
- **A model picker, M365 picker or topology investigations in the workspace.** A moved session keeps its server-side model and binding. Choosing another model happens in the side panel.
- **Opening closed or expired sessions** (read-only view, continue-from-closed). See D4.
- **Locking a session to one browser tab.** Release applies within one document only. Two browser tabs can still show the same session, as they can today. The server serialises turns, and the second tab now attaches instead of erroring.
- **Tier-3 intents that outlive their turn** in attach snapshots (§3.5). They stay decidable from the existing approvals surfaces.
- **Merging the two stores** (if D1 goes as recommended). It is tracked as its own spec.
- **Mobile**, apart from the list filter it shares (§3.7).

## 6. Advisor quorum

The author formed positions on D1–D3, then put them to `codex exec` (gpt-6-astra, `xhigh`, read-only) with the facts in §1. Outcome:

- **D1: disagreement.** Codex recommends merging into one session-keyed runtime. The author recommends keeping the stores separate. Both positions are in §7.D1. Todd decides.
- **D2: agreed, with a change adopted.** Both recommend attach and resume. Codex argued against shipping an idle-only move first: local `isStreaming === false` does not prove the server is idle, and "open any conversation" would fail on any session running elsewhere. The author adopted that, so the move ships with attach (§8).
- **D3: agreed.** Release the origin, never mirror. Prepare the destination first. A failed open leaves the origin intact.
- **Further points from Codex, all folded in:**
  - attach in `selfManagedDbContextRoutes` (§3.5)
  - never POST to reconnect (§3.5)
  - monotonic sequences, an atomic snapshot boundary, and fresh snapshots after gaps (§3.5)
  - keep approval deadlines and the intent-backed approval path (§3.5)
  - the logout gap (§3.8)
  - no silent replacement of an occupied side panel, and the tab cap checked after reusing an existing tab (§3.4, §3.6)
- **One correction from Codex:** plans have durable status in `ai_action_plans` (`schema/ai.ts:364`), while the executable resolver is in memory. §3.5 uses both.

**PR review round (pr-review-toolkit, one round).** The review found that every send replaces the session's event bus (`routes/ai.ts:898-900` → `remove()` → `closeAll()`). §3.5 was rewritten so that an attach covers exactly one turn. That rewrite also answers three further findings: the stream outlived the access check, it lacked an `onAbort` teardown, and persistent streams per tab could exhaust the browser's connection limit. The review also led to:

- `turn_in_progress` on the uncoded 409s
- the type rule on attach and open
- a byte-capped replay with screenshots stripped
- an explicit hand-off signal
- search status and type, and the mobile note
- complete wave lists

## 7. Open decisions

**D1. Keep `aiStore` and `workspaceStore` separate, or merge them?**

- **A: Separate stores plus shared modules** (§3.2). Moves hand over by attaching.
  - Pros: smallest blast radius. It keeps `aiStore`'s hard-won invariants untouched: #5684 rebind, #6933 hydration race, #7769 picker tokens, the topology filter. No flag is needed. About 35 test files that import either store keep passing unchanged (§8).
  - Cons: two places still hold messages and approval state. The drift in fact 7 has to be held back by the shared modules and parity rules, not removed.
- **B: One session-keyed store.** The side panel becomes a single slot and tabs reference session ids (Codex).
  - Pros: one authority for each session. A move within the same document keeps the existing reader with no reconnect. Drift cannot recur.
  - Cons: it rewrites both stores, and the model picker must become per-session (`aiModelPickerStore.ts:60` is a singleton store). The ownership tokens have to become per-session. It needs a feature flag, and every listed test needs reworking.
- **Recommend A for this feature, with B filed as a follow-up spec.** Attach (§3.5) is needed anyway for reloads, deep links and other browser tabs, so a merge buys only the same-document reader. That is not worth reopening `aiStore`'s invariants inside a UX feature. *(Codex recommends B.)*

**D2. Attaching to a turn already streaming in the other surface.**

- **(a) Attach and resume.** Uses the attach route and snapshot (§3.5).
- **(b) Block the move until the turn ends.** The control stays disabled, with a reason.
- **(c) Offer the move only when idle.**
- **Recommend (a), shipped together with the move.** Not (c): it hides the control during long turns, which is exactly when users want more room. Not (b) or (c) alone either: local idleness does not prove the server is idle, and fact 3 already loses turns without attach. (b) is the documented fallback if the attach wave slips. **Agreed by the quorum.**

**D3. After a move, close the conversation in the origin, or mirror it in both?**

- **(a) Release the origin.** The side panel unbinds locally with no DELETE. The workspace closes the tab, so `closeTab` makes no API call.
- **(b) Mirror live in both.** This means two composers, two approval cards, and two readers in one document.
- **Recommend (a).** Prepare the destination first and release only on success. "Released" means within this document. **Agreed by the quorum.**

**D4. Which sessions each list shows.**

- **Recommend:**
  - Both lists show the caller's **active** sessions of type `general` and `topology`, from every org they can access. This adds a server-side type filter, which removes the script-builder and MCP leak (fact 6).
  - Device-bound sessions (#7002) are listed with a device chip. They move freely, because the pin is server-side.
  - Other-org sessions are listed with an org chip.
  - Topology sessions are listed in the side panel only.
  - Closed and expired sessions are not listed. They stay reachable through side-panel search, which opens them as today.
- **Alternatives:**
  - Filter by the switcher's org. This would change the existing side-panel behaviour, and the API ignores `?orgId` anyway.
  - Open closed sessions read-only with a "Continue" action. Codex suggested this. It needs a continue-from-closed path, so it is deferred.

**D5. Deep link and permissions when the session's org is not the current org.**

- **Recommend:**
  - Open the session regardless of the switcher. The session is the caller's own, and the API does not narrow by the switcher.
  - Label the tab with its org, and never change the switcher.
  - 404 gets a uniform "isn't available" message.
  - Closed sessions get "was closed".
  - Without `ai_sessions:use`, show `AccessDenied` and ignore the hash.
  - A full tab bar gets a toast, never an eviction.
- **Alternatives:**
  - Switch the org switcher to the session's org. This surprises the user and is a stateful side effect of a link.
  - Refuse sessions outside the current org. This blocks the main use for partner technicians.

**D6. Hash lifecycle.**

- **(a) The hash follows the active tab** (`replaceState`).
- **(b) The hash is consumed once and then cleared.**
- **Recommend (a).** Reload and copy-link then keep their meaning, and it matches how `DeviceDetails` keeps its tab in the hash.

**D7. Control placement and copy (product call).**

- **Recommend:**
  - Side panel: an "Open in AI Assistant" icon in the header.
  - Workspace: "Continue in side panel" in the tab menu and in the chat header, and an "Open a past conversation" item behind the tab bar's "+".
- Every new string goes into all locales (`localeParity`).

## 8. Test and rollout notes

- **No feature flag** under D1 option A. If Todd picks B, the store merge ships behind a web flag, and its rollout gets its own section in the follow-up spec.
- **Two waves, released together.** W1 can merge first because nothing calls it.
  - **W1 (API):**
    - the attach route (one turn per attach, `onAbort` teardown, a subscriber cap, the type rule, pings)
    - `onAbort` unsubscribe on `POST /messages`
    - `code: 'turn_in_progress'` on the two uncoded second-send 409s
    - `seq` and pending-card tracking on `SessionEventBus` and `ActiveSession`
    - the replay buffer for the whole turn: capped by bytes, screenshots replaced by a placeholder
    - the `activePlan` read from `ai_action_plans`
    - the `attach_state` event in `packages/shared`
    - the list and search `type` filter and projections (`orgId`, `type`, `deviceId`; search also `status`)
    - registration in `selfManagedDbContextRoutes`
    - the attach route added to #8139's in-process-state table
  - **W2 (web):**
    - the shared modules, including the hand-off store and its `complete` and `abort` signal
    - `openSession` and the hash
    - the controls
    - the shared history list and search, and the workspace "Open a past conversation" picker, with org and device chips
    - draft carry-over
    - the parity rules
    - attach on open, on restore and on a 409, with backoff
    - logout: abort the readers and remove the key
- **Existing tests that pin the stores** (must stay green, and are extended where behaviour changes):
  - `apps/web/src/stores/`:
    - `aiStore.test.ts`
    - `aiStore.modelPicker.test.ts`
    - `aiStore.topology.test.ts`
    - `aiStore.pageContextOrg.test.ts`
    - `workspaceStore.test.ts`
    - `helpStore.test.ts`
  - `components/ai/`:
    - `AiChatSidebar.test.tsx`
    - `AiChatSidebar.firstMessage.test.tsx`
    - `AiContinuationPrompt.test.tsx`
  - `components/workspace/`:
    - `WorkspacePage.permissions.test.tsx`
    - `WorkspaceChatPanel.test.tsx`
  - `components/topology/`:
    - `useTopologyInvestigation.test.ts`
    - `TopologyExplanationPanel.test.tsx`
  - The device-page, dashboard, header and help tests that import `aiStore`. The plan lists them, so a change to `aiStore`'s public shape is caught.
- **New tests the plan must include (red first):**
  - **API:**
    - The attach route returns 404 for another user's session and for a session in an org the caller cannot access.
    - `attach_state` on an idle session, and `unavailable` when the session is not in memory.
    - A running turn replays from `message_start`, with no duplicate events at the snapshot boundary.
    - A pending approval card is replayed verbatim with its original `approvalExpiresAt`.
    - Disconnecting an attach subscriber, or a `/messages` reader, drops `subscriberCount` at once and does not interrupt the turn.
    - An attach on an idle session closes after one frame.
    - An attach on a running turn ends at that turn's `done`. A new `POST /messages` closes it through `remove()`.
    - Attach returns 404 for `script_builder` and `mcp` sessions.
    - Both uncoded second-send 409s now carry `turn_in_progress`.
    - A replay containing `plan_screenshot` carries the placeholder, and a turn over the byte cap replays as `partial`.
    - The list excludes `script_builder` and `mcp` sessions and includes `orgId`, `type` and `deviceId`.
  - **Web:**
    - A move keeps the session id and makes no DELETE.
    - The origin keeps its session when the destination fails (404, tab cap).
    - `#session=` on load or `hashchange` focuses an existing tab.
    - A topology session never opens in the workspace.
    - A `turn_in_progress` 409 attaches instead of erroring.
    - Logout removes `breeze-workspace`.
    - `no-silent-mutations` and `no-hash-in-usestate` stay green.
- **Live checks owed before release:**
  - Move a device-bound chat mid-turn while it waits on a tier-2 approval, then approve it from the destination.
  - A partner user opens an other-org session through a deep link.
  - Navigate away from `/workspace` mid-turn and come back. The tab must re-attach.
