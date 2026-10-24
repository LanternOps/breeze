# AI Chat Browser Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in browser notifications (Notification API) when an AI chat response is ready, fails, or needs the user's input (tool approval, plan approval, model continuation) while the user is not looking at the chat, on both the side panel and the AI Assistant workspace; clicking focuses the right surface.

**Architecture:** One framework-free module `lib/aiNotifications.ts` owns opt-in storage, permission, the visibility rule, notification construction (generic text only) and click routing. The two stores call `notifyAi(...)` from their existing SSE loops. A small `AiNotifyToggle` bell button in each surface's header is the only place permission is requested. 100% web, no API, no server preference.

**Tech Stack:** Browser Notification API, Zustand stores, React, Vitest (jsdom), react-i18next (8 locales).

**Spec:** Issue #9429 (the issue is the spec). Cluster anchor #9427 (move conversations between side panel and AI Assistant, `#session=<id>` hash on `/workspace`) is being specced separately and is **out of scope**; the single plug-in point for its deep link is the store-side `onOpen` passed to `notifyAi` (Task 2).

**Wave:** single wave (W1). Independently shippable; does not depend on #9428.

## Findings (verified on main @ 30e8ee7c44)

- No notification code exists in `apps/web/src` (grep for `Notification`/`visibilityState` finds nothing relevant).
- Workspace background tracking exists but is a stub: in `workspaceStore.sendMessage` the SSE loop bumps `unreadCount` on `message_start` and sets `hasApprovalPending` on `approval_required`/`plan_approval_required` when `activeTabId !== tabId` (`workspaceStore.ts:371-385`); `tabSet` has an empty "We'll handle notification tracking" branch (`:345-352`). `markTabRead` (`:637`) and `switchTab` (`:186-189`) clear both.
- `aiStore` has no unread concept; its SSE loop is `aiStore.ts:630-655`; `isOpen` / `open()` (`:33`, `:308`) is the surface-visibility signal.
- "Response ready" = the stream `done` event (`processStreamEvent.ts:438`), **not** `message_end` (fires once per assistant message, many per multi-tool turn). On failure the server emits `error` then `done` (`streamingSessionManager.ts:1993-1996`), so a per-turn `failed` flag must suppress the "ready" notification. The route-level stream catch (`routes/ai.ts:1143`) emits `error` with **no** `done`, so `failed` fires from the error event alone.
- Needs-input signals: `approval_required` (`processStreamEvent.ts:267`), `plan_approval_required` (`:309`), model continuation (`useAiModelPickerStore.requireContinuation`, called from `aiStore.ts:~577`, rendered by `AiContinuationPrompt.tsx`). Approvals carry a real timeout (`approvalWindowMs`, `approvalExpiresAt`), which is why this notification matters most.
- Header controls live in `AiChatSidebar.tsx:~222-250` (flag + close buttons; there is no dropdown "chat menu" today, so the toggle is a header icon button). Workspace has `WorkspaceChatPanel.tsx` / `WorkspaceTabBar.tsx`.
- Per-user localStorage precedent: `recentsStore.ts` keys by user id and wraps reads/writes in try/catch (`recentsStore.ts:70-100`). User id from `useAuthStore.getState().user?.id` (`stores/auth.ts:107`).
- Strings: `apps/web/src/locales/<locale>/ai.json`; `lib/i18n/localeParity.test.ts` enforces 8 locales (en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR).
- `no-silent-mutations.test.ts` is unaffected (no `fetchWithAuth` mutation added); it is still run as a gate.
- `docs/agents/settings.md` rule 9: a *server-side* opt-in would be a new setting and would need its home, level, resolver and a before/after count. **Recommendation: per-browser `localStorage`, no server setting.** Reasons: (1) browser notification permission is itself per-browser/per-origin, so a roaming server flag would be "on" on devices where the browser never granted permission and could never be honoured there; (2) no migration/RLS/API surface; (3) the user-id key still gives "per user" on shared machines. Cost: not synced across devices (acceptable; each device asks once). If Decision 2 flips to server-side, that decision gets a `codex exec` xhigh read-only quorum before implementation.

## Global Constraints

- Never request permission on page load or automatically; only from a user click on the toggle.
- Notification text is generic and translated; no device names, no response content, no session titles. Title `Breeze AI`; bodies: `Response ready`, `Needs your approval`, `Needs your input`, `Response failed`.
- Notify only when `document.visibilityState !== 'visible'` **or `!document.hasFocus()`** (a visible window behind another app still reports `'visible'`), or (needs-input kinds only) when the page is visible but the owning surface is not (side panel closed / workspace tab not active). Never notify for a visible, active surface.
- Opt-in stored in `localStorage` key `breeze-ai-notify:<userId>`; every access in try/catch; the feature degrades to "off" when storage or the API is unavailable.
- New en keys go to all 8 locales in the same commit.

## Review Focus

- Storage throws (private window / blocked) or `Notification` undefined (insecure context, old browser): no throw anywhere in the stores' SSE loops; toggle hidden.
- `error` followed by `done` must produce exactly one "failed" notification and no "ready".
- Permission revoked in browser settings after opt-in: `notifyAi` sees `permission !== 'granted'` and silently does nothing; toggle shows disabled state.
- Several Breeze tabs open: same `tag` per session so the OS replaces rather than stacks; a notification for a turn the user then reads (`markTabRead` / `switchTab` / sidebar `open()`) is closed.
- Lock-screen privacy: assertion that options contain no message text, device, or title.

---

## File Structure

- Create `apps/web/src/lib/aiNotifications.ts` (+ `aiNotifications.test.ts`) — all logic.
- Create `apps/web/src/components/ai/AiNotifyToggle.tsx` (+ test) — header bell button, shared by both surfaces.
- Modify `apps/web/src/stores/aiStore.ts`, `apps/web/src/stores/workspaceStore.ts` — emit calls.
- Modify `AiChatSidebar.tsx`, `workspace/WorkspaceChatPanel.tsx` — mount toggle.
- Modify `apps/web/src/locales/*/ai.json` (×8).

---

### Task 1: `aiNotifications` core (opt-in, permission, visibility rule)

**Files:**
- Create: `apps/web/src/lib/aiNotifications.ts`, `apps/web/src/lib/aiNotifications.test.ts`

**Interfaces (all exported):**
- `type AiNotifyKind = 'response_ready' | 'needs_approval' | 'needs_input' | 'failed'`
- `type AiNotifySurface = { kind: 'sidebar' } | { kind: 'workspace'; tabId: string }`
- `isNotificationSupported(): boolean`
- `getNotifyPermission(): 'granted' | 'denied' | 'default' | 'unsupported'`
- `isNotifyOptedIn(userId: string | undefined): boolean` — false when no user id, storage throws, or value absent.
- `setNotifyOptIn(userId: string, on: boolean): void` — swallows storage errors.
- `requestNotifyOptIn(userId: string): Promise<boolean>` — calls `Notification.requestPermission()` only when permission is `'default'`; stores opt-in only on `'granted'`; returns the resulting opt-in.
- `shouldNotify(kind: AiNotifyKind, surfaceVisible: boolean): boolean` — pure: hidden or unfocused document → true; visible+focused document → `surfaceVisible === false && (kind === 'needs_approval' || kind === 'needs_input')`.

- [ ] **Step 1: Failing tests** — fake `Notification` global (class with static `permission`, `requestPermission` spy). Cases: unsupported (`delete globalThis.Notification`) → `isNotificationSupported()` false, `getNotifyPermission()==='unsupported'`; `isNotifyOptedIn(undefined)` false; `localStorage.getItem` throwing → false, `setNotifyOptIn` does not throw; `requestNotifyOptIn` with `'default'`→granted stores key `breeze-ai-notify:u1`=`'1'` and returns true; `'denied'` → false, key absent, `requestPermission` not called; `shouldNotify` truth table over {hidden, visible+unfocused, visible+focused} × {surfaceVisible} × four kinds (set via `Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>…})`).
- [ ] **Step 2:** `cd apps/web && npx vitest run src/lib/aiNotifications.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement per the signatures above.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `feat(web): AI notification opt-in, permission and visibility rule (#9429)`.

### Task 2: `notifyAi` (construct, tag, click routing, close-on-read)

**Files:**
- Modify: `apps/web/src/lib/aiNotifications.ts`, `aiNotifications.test.ts`

**Interfaces:**
- Produces: `notifyAi(kind: AiNotifyKind, surface: AiNotifySurface, opts: { sessionId: string | null; surfaceVisible: boolean; onOpen: () => void }): void` — no-ops unless supported && permission granted && opted in (user id from `useAuthStore.getState().user?.id`) && `shouldNotify`. Constructs `new Notification('Breeze AI', { body, tag, silent: true })` with `tag = 'breeze-ai:' + (sessionId ?? surfaceKey)` and **no other fields** (no `data`, no `icon` text). Keeps the instance in a module `Map<tag, Notification>` and removes it on `close`/`click`.
- `closeAiNotification(surface: AiNotifySurface, sessionId: string | null): void` — closes the matching tag (called when the user reads).
- The lib imports **no store** (avoids a circular import with both stores and keeps the persisted workspace store out of sidebar-only bundles). `notifyAi` takes `opts.onOpen`; each store passes its own: sidebar → `get().open()`; workspace → `switchTab(tabId)` only if the tab still exists. Click handler: `window.focus(); opts.onOpen(); n.close()`. **#9427 plug-in point:** the store-side `onOpen` builder (becomes a `/workspace#session=<id>` navigation for cross-surface cases); nothing else changes.
- Body strings come from a static map `kind → key` (`response_ready→aiNotifications.responseReady`, …; no template-literal keys, which `keyUsage.test.ts` would flag). Tags: `breeze-ai:<id>` for ready/failed, `breeze-ai:<id>:input` for approval, so a later approval is not silently replaced.
- `isNotificationSupported()` also returns false where `new Notification()` throws (Android Chrome needs a service worker): probe once in try/catch and hide the toggle if it throws.

- [ ] **Step 1: Failing tests** — granted + opted-in + hidden: constructor called once with `('Breeze AI', {body:'Response ready', tag:'breeze-ai:s1', silent:true})` and `Object.keys(options)` equals exactly `['body','tag','silent']` (privacy); not opted in → not constructed; permission `'denied'` → not constructed; visible+active surface → not constructed; visible + sidebar closed + `needs_approval` → constructed; second call same session → same tag; `onclick` calls `window.focus`, opens the sidebar store (`isOpen===true`) / switches workspace tab, and closes; `closeAiNotification` closes the stored instance; constructor throwing → `notifyAi` swallows.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): notifyAi with generic text and click routing (#9429)`.

### Task 3: Emit from `aiStore`

**Files:**
- Modify: `apps/web/src/stores/aiStore.ts` (`sendMessage` SSE loop :630-655, catch :656, continuation branch :~577, `open` :308)
- Test: `apps/web/src/stores/aiStore.notify.test.ts` (new; harness from `aiStore.test.ts`, `vi.mock('@/lib/aiNotifications')` to assert calls)

**Interfaces:**
- Consumes: `notifyAi`, `closeAiNotification` (Task 2). `surfaceVisible = get().isOpen`; **no notifications when `topologySiteId !== null`** (the Explain panel also runs on `aiStore`; test it).
- Behaviour: per-turn local `let turnFailed = false`. After `processStreamEvent`: `approval_required`/`plan_approval_required` → `needs_approval`; `error` → `failed` + `turnFailed = true`; `done` → `response_ready` only if `!turnFailed`. catch path (non-superseded) → `failed`. (No continuation notification: it fires right after the user's own click; Decision 3.) `open()`, `toggle()` (Cmd+Shift+A) and `loadSession` call `closeAiNotification`. A superseded stream (`!ownsStream()`) never notifies.

- [ ] **Step 1: Failing tests** — `done` → one `response_ready`; `error` then `done` → exactly one `failed`, zero `response_ready`; `approval_required` → `needs_approval` with `surfaceVisible=false` when `isOpen:false`; superseded stream → no calls; `open()` → `closeAiNotification` called; a throwing `notifyAi` does not break the stream (turn still ends, `isStreaming` false).
- [ ] **Step 2:** `npx vitest run src/stores/aiStore.notify.test.ts` → FAIL.
- [ ] **Step 3:** Implement; wrap each call so an exception can never escape the SSE loop.
- [ ] **Step 4:** PASS; `npx vitest run src/stores/aiStore` (siblings) green.
- [ ] **Step 5: Commit** `feat(web): aiStore notifies on ready/failed/approval (#9429)`.

### Task 4: Emit from `workspaceStore` (replace the stub)

**Files:**
- Modify: `apps/web/src/stores/workspaceStore.ts` (SSE loop :343-405, catch :413, `markTabRead` :637, `switchTab` :186)
- Test: `apps/web/src/stores/workspaceStore.notify.test.ts` (new)

**Interfaces:**
- `surfaceVisible = (get().activeTabId === tabId)`. Same event mapping and `turnFailed` rule as Task 3, surface `{ kind: 'workspace', tabId }`. `markTabRead`, `switchTab` and `closeTab` call `closeAiNotification`. Delete the dead empty `if (activeTabId !== tabId)` block in `tabSet` (`:345-352`).

- [ ] **Step 1: Failing tests** — background tab `done` → `response_ready` with `surfaceVisible=false`; active tab `done` → called with `surfaceVisible=true` (and the lib's rule suppresses it; assert the lib mock receives the flag); `approval_required` on background tab → `needs_approval` and `hasApprovalPending` still true (regression for existing behaviour); error→done → one `failed`; `markTabRead('t1')` → `closeAiNotification` with that tab; two tabs keep independent tags.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `npx vitest run src/stores/workspaceStore` green.
- [ ] **Step 5: Commit** `feat(web): workspaceStore notifies per tab, closes on read (#9429)`.

### Task 5: `AiNotifyToggle` + mount + i18n

**Files:**
- Create: `apps/web/src/components/ai/AiNotifyToggle.tsx`, `AiNotifyToggle.test.tsx`
- Modify: `AiChatSidebar.tsx` (header, beside the flag button ~:222-250), `workspace/WorkspaceChatPanel.tsx` (header area), `apps/web/src/locales/*/ai.json` (×8)

**Interfaces:**
- `AiNotifyToggle()` — no props. Reads user id from `useAuthStore`; renders `null` when `!isNotificationSupported()`. States: `denied` → disabled bell-off with title explaining browser settings; opted-in → bell on (`aria-pressed=true`); otherwise bell off. Click: if currently on → `setNotifyOptIn(id,false)`; if off → `await requestNotifyOptIn(id)` (permission prompt happens here, inside the click gesture). `data-testid="ai-notify-toggle"`. State is local `useState` initialised from `isNotifyOptedIn` (per-viewer convenience; wrap as the lib already does).
- New en keys (translate into all 7 other locales): `aiNotifications.responseReady`, `.needsApproval`, `.needsInput`, `.failed`, `.title` ("Breeze AI"), `.toggleOn`, `.toggleOff`, `.blocked`.

- [ ] **Step 1: Failing tests** — renders nothing without `Notification`; off → click calls `requestNotifyOptIn` once and flips to pressed on grant, stays off on deny; on → click calls `setNotifyOptIn(id,false)` and **never** calls `Notification.requestPermission`; `denied` → button disabled; mounted in sidebar header and in workspace panel (existing component tests assert `ai-notify-toggle` present); **mount does not call `requestPermission`** (guards "never on page load").
- [ ] **Step 2:** `npx vitest run src/components/ai/AiNotifyToggle.test.tsx src/components/ai/AiChatSidebar.test.tsx src/components/workspace/WorkspaceChatPanel.test.tsx` → FAIL.
- [ ] **Step 3:** Implement; add keys to all 8 locale files.
- [ ] **Step 4:** PASS, then gates: `npx vitest run src/lib/i18n/localeParity.test.ts`; `npx vitest run src/lib/__tests__/no-silent-mutations.test.ts` (no allowlist edits); `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` in `apps/web` → `exit=0`.
- [ ] **Step 5: Commit** `feat(web): AI notification toggle in chat headers (#9429)`.

## Out of scope / follow-ups

- Cross-surface "open in the other surface" (#9427) — plugs into the store-side `onOpen`.
- Push/service-worker notifications when no Breeze tab is open (needs Web Push + server component; separate feature).
- Sound, badge counts in the tab title, per-kind granularity.

## Decisions for Gate B (plan default in brackets)

1. Permission trigger: explicit bell toggle in each chat header [**toggle**; alternatives: auto-prompt on the first long turn — rejected, prompts mid-task and burns the one-shot browser prompt]
2. Opt-in storage: per-browser `localStorage`, key `breeze-ai-notify:<userId>` [**localStorage**; server preference rejected because browser permission is per-browser and it would be a new setting under `docs/agents/settings.md` rule 9]
3. Events that notify: response ready, failed/timed out, needs approval (tool + plan), needs input (model continuation) [**first three; continuation dropped**, it fires right after the user's own click]
4. Visibility rule: hidden tab always; visible-but-surface-closed only for needs-approval/needs-input [**as stated**; stricter alternative is hidden-only]
5. Text: title `Breeze AI`, bodies `Response ready` / `Needs your approval` / `Needs your input` / `Response failed`, silent, tag per session [**as stated**]
6. Click behaviour now: focus window and open sidebar / switch workspace tab; #9427 deep link plugs into the store-side `onOpen` later [**yes**]
7. Notifications for a turn are closed when the user reads it (`open`, `switchTab`, `markTabRead`) [**yes**]
8. Toggle placement: header icon button on both surfaces (no dropdown exists today) [**icon button**]
