---
spec: docs/superpowers/specs/ai-mcp/2026-10-25-wisp-home-companion.md
wave: W01
tracking_issue: LanternOps/breeze#10210
---

# Wisp companion W01 — The surface (shared chat kit + Wisp home layout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Wisp home becomes a conversation at reading width with an identity rail and one composer, and the shared chat kit (used by the docked panel, Breeze AI at `/ai/chat`, the run detail transcript) gets ChatGPT/Claude-style rows, time dividers, folded tool activity, specialist run cards and an Enter-to-send composer.

**Architecture:** Client only. A pure grouping module turns the store's message array into render units (dividers, user, assistant, folded tool groups, cards); `AiChatMessages` renders units and gains `layout`, `assistantLabel`, `showTimeDividers`, `leading`, `emptyState` props; `AiChatInput` becomes the rounded composer. The Wisp home composes existing panels into a column plus a rail (and a strip plus `Drawer` below `lg`); the brief renders as the first post of the thread from the `GET /wisp/home` payload it already receives. No API change, no migration.

**Tech Stack:** Astro + React 18 + Zustand + react-i18next + Tailwind 4 (web), Vitest + Testing Library, Playwright e2e. Icons: lucide-react. Markdown: react-markdown + remark-gfm (unchanged).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-25-wisp-home-companion.md` §4 (surface), §4.2 (thread anatomy), §4.3 (states), §4.4 (anti-goals), §7 (untouched).

## Execution split and parallelism

One sub-issue, one branch, one PR. Base on `origin/main`, target `main`.

PARALLEL GROUPS: G1 = Task 1 ∥ Task 4 ∥ Task 6 ∥ Task 7 ∥ Task 8 ∥ Task 9. G2 = Task 2 ∥ Task 10. G3 = Task 3. G4 = Task 11 ∥ Task 12 ∥ Task 13. Then Task 14, Task 15, Task 16 in order.
**Sonnet:** Task 6, Task 7, Task 8, Task 9, Task 14 (locale fan-out + baseline), the docs half of Task 16. Everything else Opus.
- Tasks inside one group are file-disjoint and may run as concurrent subagents in one worktree. Concurrent subagents never run `git commit`; commit once per group after every member passes.
- A task that adds copy adds it to `apps/web/src/locales/en/ai.json` only; Task 14 fans out to the other seven locales and updates the baseline. Until Task 14, run tests scoped to the task's files, never the locale parity suites.
- Scoped test runs: `cd apps/web && pnpm exec vitest run <path>` (never `pnpm --filter <pkg> test -- --run <path>`; vitest path filters are substring matches).
- Typecheck the way CI does: `cd apps/web && pnpm exec tsc --build tsconfig.tests.json` (if the web package has no such file, `pnpm exec astro check`); the API's local tsc OOMs at 12 GB, never pipe tsc through `tail`.

## Global Constraints

- No API, shared-package or migration changes in this wave. `apps/api/**`, `apps/api/migrations/**`, `packages/shared/**` are not touched.
- Every new locale key exists in all eight locales (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`); every removed key is removed from `apps/web/src/locales/humanizedKeyBaseline.json` if listed there. Parity: `apps/web/src/lib/i18n/localeParity.test.ts`; baseline: `apps/web/src/locales/humanizedKeyRegression.test.ts`.
- Copy rules: no em dashes, no apologies, no gerund chains, sentence case, Wisp is "Wisp", the generic assistant is "Breeze AI".
- Test ids that survive unchanged (e2e `e2e-tests/tests/wisp-home.spec.ts`): `wisp-home`, `wisp-home-thread`, `wisp-needs-you`, `wisp-links-panel`, `wisp-links-add`, `wisp-link-chip`, `wisp-entity-picker`, `wisp-picker-search`, `wisp-thread-header`, `wisp-live-line`, `wisp-spend-meter`, `wisp-home-chats`, `wisp-home-memory`, `ai-chat-input`, `ai-chat-send`, `ai-chat-stop`.
- Visual tokens: the web's existing Tailwind theme (`bg-card`, `bg-muted`, `text-muted-foreground`, `border`, `bg-primary`, `text-primary`, `prose`). No new colors, no `box-shadow` for elevation, no `backdrop-filter`, no gradient text, no `border-left` accent stripes.
- Hash deep links `#needs-you`, `#links`, `#activity`, `#thread`, `#concern=<id>` keep working (`homeSectionFromHash` in `apps/web/src/components/wisp/wispHome.ts` is unchanged; the ids move onto the rail sections and the thread column).
- Mutations: none are added. If one appears, it goes through `runAction` (`apps/web/src/lib/runAction.ts`), guarded by `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`.

## Review Focus

1. **IME composition.** A Japanese or Chinese user pressing Enter to confirm a candidate must not send. Pinned in Task 4 (`isComposing` test).
2. **A group that ends in an error mid-stream.** When a tool fails while more text streams after it, the group must render expanded with the red count and the following assistant text must still render below it in order. Pinned in Task 3.
3. **History replay with id-less tool rows.** Rows from older sessions carry no `toolUseId`; adjacency pairing (`pairToolResults`) must still fold them into one group, and an unpaired `tool_result` must render inside a group, never disappear. Pinned in Task 1.
4. **Blank assistant rows.** An assistant message whose content is only whitespace or newlines (the model's text before a tool call) must not render; a streaming assistant message with empty content must still show the caret. Pinned in Task 1 and Task 3.
5. **The 400 px docked panel.** `layout="panel"` must not apply the page max-width or dividers; a user bubble at 75% must wrap a long URL without horizontal scroll. Pinned in Task 3 (panel test) and Task 15.

---

### Task 1: Pure grouping of chat rows into render units

**Files:**
- Create: `apps/web/src/components/ai/aiChatGrouping.ts`
- Test: `apps/web/src/components/ai/aiChatGrouping.test.ts`

**Interfaces:**
- Consumes: `AiMessage` (type-only, `@/stores/processStreamEvent`), `pairToolResults` (export of `./AiChatMessages`; move it into this file and re-export it from `AiChatMessages.tsx` so its existing tests keep importing from there).
- Produces:
```ts
export type ToolCall = { key: string; toolName: string; input?: Record<string, unknown>; use: AiMessage | null; result: AiMessage | null };
export type ChatUnit =
  | { kind: 'divider'; at: Date }
  | { kind: 'user'; msg: AiMessage }
  | { kind: 'assistant'; msg: AiMessage; firstOfRun: boolean }
  | { kind: 'tools'; id: string; calls: ToolCall[]; executing: boolean; failed: number; startedAt: Date; finishedAt: Date | null }
  | { kind: 'card'; call: ToolCall }
  | { kind: 'specialists'; id: string; runs: Array<{ key: string; runId: string }> };
export const DIVIDER_GAP_MS = 20 * 60_000;
export function isBlankAssistant(msg: AiMessage): boolean;
export function specialistRunIdOf(toolName: string | undefined, output: unknown): string | null;
export function groupChatUnits(messages: readonly AiMessage[], opts: { dividers: boolean; isCard: (call: ToolCall) => boolean; now?: Date }): ChatUnit[];
export function dividerParts(at: Date, now: Date, locale: string): { day: 'today' | 'yesterday' | 'other'; time: string; date: string };
```

Rules the tests pin:
- `isBlankAssistant`: role `assistant`, `isStreaming` falsy, `content.trim() === ''`. Such rows are dropped.
- `specialistRunIdOf('launch_specialist', output)`: `output` is a JSON string or object; returns `runId` only when `admitted === true` and `runId` is a UUID string; `needsApproval`, `refused`, other tools → `null`.
- Tool rows: a `tool_use` row plus its paired result (by `toolUseId`, else adjacency, exactly as `pairToolResults`) is one `ToolCall` whose `key` is the `tool_use` row's `id`; an unpaired `tool_result` is a `ToolCall` with `use: null`, `key` = its own id. Consecutive calls with no `user` or non-blank `assistant` between them form one `tools` unit (`id` = `tools-${first call key}`), unless `isCard(call)` is true or `specialistRunIdOf` returns a run id: such a call closes the open group and becomes a `card` unit (or joins a `specialists` unit with adjacent specialist cards, `id` = `specialists-${first key}`). `executing` = any call with `use` and no `result`; `failed` = calls whose `result.isError` is true; `startedAt` = first call's `use.createdAt` (or result's), `finishedAt` = last result's `createdAt` when none is executing, else `null`.
- `firstOfRun` on an assistant unit is true when the previous non-divider unit is absent, `user`, or a divider was just inserted; `tools`, `card`, `specialists` units do not reset the run.
- Dividers (only when `opts.dividers`): before the first message-bearing unit, and before any unit whose timestamp (`msg.createdAt`, or `startedAt`) is more than `DIVIDER_GAP_MS` after the previous unit's, or on a different local calendar day.
- `dividerParts`: `time` via `Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })`; `date` via `{ month: 'short', day: 'numeric' }` plus `year: 'numeric'` when the year differs from `now`'s; `day` by local calendar comparison.

- [ ] **Step 1: Write the failing tests** in `aiChatGrouping.test.ts`: `drops blank assistant rows but keeps a streaming empty one`, `folds three consecutive tool calls into one group with failed=1`, `pairs id-less history rows by adjacency and keeps an orphan result inside the group`, `a flow card splits the group`, `admitted launch_specialist becomes a specialists unit; needsApproval stays in the group`, `inserts a divider on a 21-minute gap and on a day change, none on a 19-minute gap`, `firstOfRun is reset by a user message, not by a tool group`, `dividerParts today/yesterday/other`.
- [ ] **Step 2: Run** `cd apps/web && pnpm exec vitest run src/components/ai/aiChatGrouping.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `aiChatGrouping.ts` with the signatures above; move `pairToolResults` here verbatim and re-export it from `AiChatMessages.tsx` (`export { pairToolResults } from './aiChatGrouping'`).
- [ ] **Step 4: Run** the new test and `AiChatMessages.test.tsx` → PASS.
- [ ] **Step 5: Commit** `feat(web): pure grouping of chat rows into render units (dividers, folded tools, cards)`.

### Task 2: The folded tool-activity row

**Files:**
- Create: `apps/web/src/components/ai/AiToolActivityGroup.tsx`
- Test: `apps/web/src/components/ai/AiToolActivityGroup.test.tsx`

**Interfaces:**
- Consumes: `ChatUnit` (`kind: 'tools'`), `ToolCall` from Task 1; `aiToolLabel` from `@breeze/shared` (the same call `AiToolCallCard` uses for its collapsed row).
- Produces: `export default function AiToolActivityGroup(props: { group: Extract<ChatUnit, { kind: 'tools' }>; renderCall: (call: ToolCall) => ReactNode; defaultExpanded?: boolean }): JSX.Element`.

Behavior: root `data-testid="ai-tool-group"` with `data-state="executing|done|failed"`. Collapsed row: a chevron button (`aria-expanded`), then the labels of all calls joined by " · " (`text-xs text-muted-foreground`), then, when finished, the elapsed time `t('aiChatMessages.toolGroup.elapsed', { seconds })`; when executing, the current (last unfinished) call's label with a `Loader2` spinner and `t('aiChatMessages.toolGroup.done', { count })` for the finished count; when `failed > 0`, a red count `t('aiChatMessages.toolGroup.failed', { count })` and the group starts expanded. `defaultExpanded` also forces expanded. Expanded: `renderCall(call)` for each call in order in a `mt-2 space-y-2` stack. Expanded state is local `useState` keyed by the group id (the parent passes `key={group.id}` so it survives re-renders of the same group).

- [ ] **Step 1: Write the failing tests**: `collapsed row lists every label and the elapsed time`, `executing shows the current label and the done count`, `a failed call starts expanded and shows the red count`, `toggle expands to the rendered calls`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/components/ai/AiToolActivityGroup.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the component; add `en` keys `aiChatMessages.toolGroup.{elapsed,done,failed_one,failed_other,expand,collapse}` ("{{seconds}} s", "{{count}} done", "{{count}} failed", "{{count}} failed", "Show details", "Hide details").
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(web): folded tool-activity row for the chat kit`.

### Task 3: `AiChatMessages` renders units

**Files:**
- Modify: `apps/web/src/components/ai/AiChatMessages.tsx`
- Test: `apps/web/src/components/ai/AiChatMessages.test.tsx` (extend), keep `AiChatMessages.callerVerification.test.tsx` and `AiChatMessages.imageRendering.test.tsx` green.

**Interfaces:**
- Consumes: Task 1 (`groupChatUnits`, `dividerParts`, `specialistRunIdOf`), Task 2, existing `AiToolCallCard`, `AiRunCard`, `FlowDraftCard`/`parseFlowToolResult`, `CallerVerificationRefusal`, `scriptProposalHref`.
- Produces: new optional props on `AiChatMessagesProps`: `layout?: 'panel' | 'page'` (default `'panel'`), `assistantLabel?: string` (default `t('aiChatMessages.title')`), `showTimeDividers?: boolean` (default `false`), `leading?: ReactNode`, `emptyState?: ReactNode`. Every existing prop and the scroll behavior (`shouldAutoScroll`, rAF pin) are unchanged.

Rendering rules:
- `isCard(call)` = `call.toolName` is `workspace_launch_analysis` or `unattended_release`, or `parseFlowToolResult(call.toolName, output)` is non-null, where `output` = `call.result?.toolOutput ?? call.result?.content`. Card units render through the existing `renderToolResult` branches (run card, note, flow card) and pending `AiToolCallCard` when `result` is null. `specialists` units render a heading `t('aiChatMessages.specialists.heading', { count })` (only when `runs.length > 1`) and one `AiRunCard` per run (`runId`, `initialStatus: 'queued'`, `run: chatRuns[runId]`).
- `tools` units → `<AiToolActivityGroup key={unit.id} group={unit} renderCall={…} />` where `renderCall` returns the existing per-call markup: `renderToolResult(result, key, input)` when a result exists, else the executing `AiToolCallCard`.
- `user` → `<div data-testid="ai-msg-user" className="ml-auto max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/10 px-4 py-2.5 text-sm dark:bg-primary/20">`.
- `assistant` → `<div data-testid="ai-msg-assistant">` with, when `firstOfRun`, `<p data-testid="ai-msg-label" className="mb-1 text-xs font-medium text-muted-foreground">{assistantLabel}</p>`, then the existing `prose` markdown block (links, images, caret unchanged). No avatar, no `Bot`/`User` icons anywhere in the list (remove the imports).
- `divider` → `<div role="separator" data-testid="ai-chat-divider" className="py-1 text-center text-[11px] text-muted-foreground">` with `t('aiChatMessages.divider.today'|'yesterday'|'date', parts)` from `dividerParts(at, now, i18n.language)`.
- Container: `layout="page"` wraps the list in `<div className="mx-auto w-full max-w-3xl">` and uses `px-4 py-6 space-y-5`; `panel` keeps `p-3 space-y-3`. `leading` renders inside the scroll container before the units. `emptyState`, when provided, replaces the built-in quick-actions empty state; otherwise the built-in one renders as today.
- Approval dialog, plan review, plan progress and the sticky Pause button render after the units exactly as today.
- `en` keys: `aiChatMessages.divider.{today,yesterday,date}` ("Today {{time}}", "Yesterday {{time}}", "{{date}}, {{time}}"), `aiChatMessages.specialists.heading_one/_other` ("Handed to {{count}} specialist", "Handed to {{count}} specialists").

- [ ] **Step 1: Write the failing tests** (extend `AiChatMessages.test.tsx`): `renders no avatar and labels the first assistant message of a run`, `blank assistant rows are not rendered; a streaming one shows the caret`, `three tool rows render one ai-tool-group; a failed one is expanded and the assistant text after it still renders in order`, `launch_specialist admitted result renders AiRunCard with its runId`, `showTimeDividers inserts ai-chat-divider on a day change`, `layout=panel has no max-w-3xl wrapper and no dividers`, `emptyState replaces the quick actions`, `leading renders inside the scroll container before the first message`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/components/ai/AiChatMessages` → the new cases FAIL, the old ones PASS.
- [ ] **Step 3: Implement** per the rules above.
- [ ] **Step 4: Run** `pnpm exec vitest run src/components/ai/` → PASS (every kit test, including `AiChatSidebar*.test.tsx`).
- [ ] **Step 5: Commit** `feat(web): chat kit renders grouped units — no avatars, folded tools, dividers, specialist run cards`.

### Task 4: The composer

**Files:**
- Modify: `apps/web/src/components/ai/AiChatInput.tsx`
- Test: `apps/web/src/components/ai/AiChatInput.test.tsx`

**Interfaces:**
- Produces: new optional props `placeholder?: string` (default `t('aiChatInput.placeholder')`), `leftSlot?: ReactNode`. Existing props unchanged; test ids `ai-chat-input`, `ai-chat-send`, `ai-chat-stop` unchanged.

Behavior: Enter sends (unless `e.shiftKey` or `e.nativeEvent.isComposing`); Shift+Enter inserts a newline; Cmd/Ctrl+Enter still sends. The hint paragraph (`aiChatInput.sendShortcut` / `aiChatInput.thinking`) is removed; while streaming the placeholder is `t('aiChatInput.waiting')` as today. Markup: `<div className="border-t bg-background p-3">` → `<div className="flex items-end gap-2 rounded-2xl border bg-background px-3 py-2 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">` containing `leftSlot`, the borderless auto-growing textarea (max 200 px), and the round 32 px send button (`rounded-full bg-primary text-primary-foreground`) or the stop button. `aria-label` on both buttons.

- [ ] **Step 1: Write the failing tests**: `Enter sends and clears`, `Shift+Enter does not send`, `Enter during IME composition does not send`, `Cmd+Enter still sends`, `placeholder prop wins`, `leftSlot renders before the textarea`, `no shortcut hint text is rendered`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/components/ai/AiChatInput.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; remove the `aiChatInput.sendShortcut` and `aiChatInput.thinking` keys from `en/ai.json` (Task 14 removes them from the other locales and the baseline).
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(web): rounded composer, Enter sends, Shift+Enter newline`.

### Task 5: (merged into Task 14)

### Task 6: The brief as a post (Sonnet)

**Files:**
- Create: `apps/web/src/components/wisp/WispBriefPost.tsx`
- Delete: `apps/web/src/components/wisp/WispBriefCard.tsx`, `apps/web/src/components/wisp/WispBriefCard.test.tsx`
- Test: `apps/web/src/components/wisp/WispBriefPost.test.tsx`

**Interfaces:**
- Consumes: `briefAge` (`./wispHome`), `formatRelativeTime` (`@/lib/utils`), `BriefSection` (`@breeze/shared`).
- Produces: `export default function WispBriefPost(props: { brief: { sentAt: string; sections: BriefSection[] }; now?: number }): JSX.Element`.

Markup: root `<article data-testid="wisp-brief-card" className="space-y-3">` with `<p className="text-xs font-medium text-muted-foreground"><span className="uppercase tracking-wide">{t('wisp.post.brief')}</span> · <span data-testid="wisp-brief-sent">{t('wisp.home.briefSentAt', { time })}</span>{stale badge data-testid="wisp-brief-stale"}</p>` then the sections exactly as the card rendered them (`data-testid="wisp-brief-section"`, `h3` headings, `ul` lines). No border, no card background. `en` keys: `wisp.post.{brief,nudge,digest,summary}` ("Morning brief", "Nudge", "Digest", "Summary"). Remove `wisp.home.briefTitle` and `wisp.home.briefEmpty` from `en/ai.json`.

- [ ] **Step 1: Write the failing tests** (port the card's: sections render, stale badge after 20 h, sent time) plus `renders the Morning brief eyebrow and no card border`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, delete the card and its test. **Step 4: Run** `pnpm exec vitest run src/components/wisp/WispBriefPost.test.tsx` → PASS. **Step 5: Commit** `feat(web): the morning brief renders as a Wisp post`.

### Task 7: Welcome post and suggestion chips (Sonnet)

**Files:**
- Create: `apps/web/src/components/wisp/WispWelcome.tsx`, `apps/web/src/components/wisp/WispWelcome.test.tsx`

**Interfaces:**
- Produces: `export default function WispWelcome(props: { scopeLabel: string; onSuggest: (prompt: string) => void }): JSX.Element`.

Markup: `data-testid="wisp-welcome"`; a Wisp-labelled prose block: `t('wisp.welcome.title', { scope })` ("I'm looking around {{scope}}.") and `t('wisp.welcome.body')` ("Your first brief arrives each morning once I have had a look. Ask me anything in the meantime."); then four chips (`data-testid="wisp-suggestion"`, `rounded-full border px-3 py-1 text-xs hover:bg-muted`) whose labels and prompts are `wisp.welcome.suggestions.{needsMe,offline,sweep,overnight}.{label,prompt}` ("What needs me today?" / "What needs my attention today? Keep it short."; "Which devices are offline?" / "Which of my devices are offline right now?"; "Run a health sweep" / "Run a health sweep on {{scope}} now."; "What happened overnight?" / "What happened across my customers overnight?"). Clicking a chip calls `onSuggest(prompt)`.

- [ ] **Step 1: Tests**: `renders the welcome copy with the scope`, `each chip sends its prompt`. **Step 2:** FAIL. **Step 3:** Implement + `en` keys. **Step 4:** PASS. **Step 5: Commit** `feat(web): Wisp welcome post with suggestion chips`.

### Task 8: Identity card and Workers panel (Sonnet)

**Files:**
- Create: `apps/web/src/components/wisp/WispIdentityCard.tsx`, `WispIdentityCard.test.tsx`, `apps/web/src/components/wisp/WispWorkersPanel.tsx`, `WispWorkersPanel.test.tsx`

**Interfaces:**
- Consumes: `WispState` (`@/stores/aiStore`), `CurrentActivity`, `ActivityItem` (`@breeze/shared`), `fetchWispActivity(threadId, cursor, limit?)` (`./wispActivity`), `formatRelativeTime`.
- Produces:
  - `export default function WispIdentityCard(props: { wisp: NonNullable<WispState>; orgName: string | null; currentActivity: CurrentActivity; children?: ReactNode }): JSX.Element` — root `data-testid="wisp-identity"`: a 40 px circle `bg-primary/10 text-primary` with `Sparkles`, the name `t('wisp.name')` ("Wisp") as `h2`, a state line `data-testid="wisp-state-line"` (`aria-live="polite"`): when `currentActivity` → the existing `wisp.live.checking` copy with a pulsing primary dot; else a dot (`bg-emerald-500` active, `bg-amber-500` paused, `bg-muted-foreground` revoked/expired) and `t('wisp.header.status.<status>')`, then ` · ` and the scope label (`t('wisp.header.scopeAll')` or `orgName`). `children` renders below (the grant controls).
  - `export default function WispWorkersPanel(props: { threadId: string; refreshKey?: number }): JSX.Element` — `data-testid="wisp-workers"`; loads `fetchWispActivity(threadId, null, 50)` on mount and when `refreshKey` changes, keeps items with `kind === 'specialist'`, shows the first five as rows `data-testid="wisp-worker-row"` (title linked to `safeActivityHref(item.href)`, `detail` muted, relative time), an empty line `t('wisp.rail.workersEmpty')` ("No specialists running."), a load error line `t('wisp.activity.loadFailed')`, and a footer link `t('wisp.rail.allRuns')` ("All runs") to `/ai-agents/runs`. Header `t('wisp.rail.workersTitle')` ("Workers").

- [ ] **Step 1: Tests**: identity: `shows the live line when checking`, `shows status dot, label and scope otherwise`; workers: `lists only specialist items, five at most`, `empty and error lines`. **Step 2:** FAIL. **Step 3:** Implement + `en` keys `wisp.name`, `wisp.rail.{workersTitle,workersEmpty,allRuns}`. **Step 4:** PASS. **Step 5: Commit** `feat(web): Wisp identity card and Workers panel`.

### Task 9: Activity panel collapsible (Sonnet)

**Files:**
- Modify: `apps/web/src/components/wisp/WispActivityPanel.tsx`
- Test: `apps/web/src/components/wisp/WispActivityPanel.test.tsx` (extend)

**Interfaces:**
- Produces: new prop `collapsible?: boolean` (default `false`). When true the header becomes a button `data-testid="wisp-activity-toggle"` (`aria-expanded`) with the title and `t('wisp.activity.show')`/`t('wisp.activity.hide')` ("Show"/"Hide"); the list, error and load-more render only while open; the fetch still runs on mount so the count line `t('wisp.activity.count', { count })` ("{{count}} recent") shows beside the title. Default collapsed.

- [ ] **Step 1: Tests**: `collapsible starts closed with the count and opens on toggle`, `non-collapsible renders as before`. **Step 2:** FAIL. **Step 3:** Implement + `en` keys. **Step 4:** PASS. **Step 5: Commit** `feat(web): collapsible Wisp activity panel`.

### Task 10: The rail and the strip

**Files:**
- Create: `apps/web/src/components/wisp/WispRail.tsx`, `WispRail.test.tsx`, `apps/web/src/components/wisp/WispRailStrip.tsx`, `WispRailStrip.test.tsx`

**Interfaces:**
- Consumes: Task 8, Task 9, existing `WispThreadHeader` (`../ai/WispThreadHeader`), `WispNeedsYou`, `WispLinksPanel`, `WispActivityPanel`, `Drawer` (`@/components/shared/Drawer`, props `open`, `onClose`, `title`, `width`, `dataTestId`, `children`).
- Produces:
```ts
export type WispRailProps = {
  wisp: NonNullable<WispState>; orgName: string | null; current: CurrentActivity;
  needsYou: Concern[] | null;             // null hides the section (thread page without the home payload)
  links: WispThreadLink[] | null;         // null hides the section
  onLinksChange: (links: WispThreadLink[]) => void;
  onWispChange: (patch: Partial<NonNullable<WispState>>) => void;
  onRevoked: () => void | Promise<void>;
  activityKey: number;
};
export default function WispRail(props: WispRailProps): JSX.Element;
export default function WispRailStrip(props: { wisp: NonNullable<WispState>; current: CurrentActivity; needsYouCount: number; rail: ReactNode }): JSX.Element;
```
`WispRail`: `<div className="space-y-4" data-testid="wisp-rail">` with sections in this order, each `rounded-lg border bg-card overflow-hidden`: identity (`WispIdentityCard` wrapping `<WispThreadHeader wisp orgName wideningAvailable={wisp.wideningAvailable} showFocus={false} currentActivity={null} onWispChange onRevoked />`; the live line is on the identity card, so the header gets `currentActivity={null}`); `WispNeedsYou` (section `id="needs-you"`, body `max-h-[22rem] overflow-y-auto`); `WispWorkersPanel`; `WispLinksPanel` (`id="links"`, `canAdd={wisp.status === 'active'}`); `WispActivityPanel collapsible` (`id="activity"`); a footer `<nav>` with the two links (`data-testid="wisp-home-chats"` → `/ai/chat`, `data-testid="wisp-home-memory"` → `/settings/wisp-memory`, copy `wisp.home.openChats` / `wisp.home.memory`).
`WispRailStrip`: `<div className="lg:hidden" data-testid="wisp-rail-strip">` a one-row bar (state dot + status or live line, `needsYouCount` badge when > 0, a `Details` button `data-testid="wisp-rail-details"`) that opens `<Drawer title={t('wisp.name')} dataTestId="wisp-rail-drawer">{rail}</Drawer>`. `en` key `wisp.rail.details` ("Details").

- [ ] **Step 1: Tests**: rail: `renders sections in order with their ids and the footer links`, `needsYou null hides the section`; strip: `opens the drawer with the rail inside`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `feat(web): Wisp rail and the narrow-viewport strip`.

### Task 11: The thread column

**Files:**
- Modify: `apps/web/src/components/wisp/WispHomeThread.tsx`
- Test: `apps/web/src/components/wisp/WispHomeThread.test.tsx` (extend; every existing binding case stays)

**Interfaces:**
- Consumes: Task 3 props, Task 4 props, Task 6, Task 7, `WispEntityPicker` (`./WispEntityPicker`: `open`, `threadId`, `linkedKeys`, `onClose`, `onLinked`), `linkKey` (`./wispEntitySources`).
- Produces: new props `leading?: ReactNode`, `scopeLabel: string`, `links: WispThreadLink[]`, `onLinksChange: (links: WispThreadLink[]) => void`.

Changes: the root becomes `<section id="thread" data-testid="wisp-home-thread" className="flex min-h-0 flex-1 flex-col">` with no border, background or `h2` (remove `wisp.home.threadTitle` from `en/ai.json`). `AiChatMessages` gets `layout="page"`, `assistantLabel={t('wisp.name')}`, `showTimeDividers`, `leading={leading}`, `emptyState={<WispWelcome scopeLabel onSuggest={sendMessage} />}`. `AiChatInput` gets `placeholder={t('wisp.composer.placeholder')}` ("Message Wisp") and `leftSlot` = a round `Plus` icon button `data-testid="wisp-composer-link"` (`aria-label={t('wisp.composer.link')}`, "Link an item") that opens `WispEntityPicker`; `onLinked` calls `onLinksChange` the way `WispLinksPanel.onLinked` does. The inactive, binding and failed states render as today (same test ids), the inactive notice standing where the composer would be.

- [ ] **Step 1: Tests**: `renders no heading and passes the brief post as leading`, `empty thread shows the welcome and a chip sends its prompt`, `the composer link button opens the entity picker`, `paused grant shows the inactive notice and no composer` (exists; keep). **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm exec vitest run src/components/wisp/WispHomeThread.test.tsx` → PASS. **Step 5: Commit** `feat(web): Wisp thread column — page layout, welcome, composer link button`.

### Task 12: The home layout

**Files:**
- Modify: `apps/web/src/components/wisp/WispHomeContent.tsx`
- Test: `apps/web/src/components/wisp/WispHomeContent.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 6, Task 10, Task 11. Keeps `fetchWispHome`, polling, stale handling, hash scrolling, `onWispChange`, `onRevoked` unchanged.

Ready state renders:
```tsx
<div data-testid="wisp-home" className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-[88rem] gap-6 px-4 lg:px-6">
  <div className="flex min-w-0 flex-1 flex-col">
    {stale banner, DisabledCard when !payload.partner.enabled, as today}
    <WispRailStrip … rail={<WispRail …/>} />
    <WispHomeThread wisp lastSessionId scopeLabel links onLinksChange leading={payload.brief ? <WispBriefPost brief={payload.brief} /> : null} />
  </div>
  <aside className="hidden w-80 shrink-0 overflow-y-auto py-4 lg:block xl:w-[22rem]"><WispRail …/></aside>
</div>
```
`4rem` is the shell header (`h-16`, `apps/web/src/components/layout/Header.tsx`); confirm the dashboard main area does not add its own padding that breaks the height, the way `WorkspacePage.layout.test.tsx` pins it for `/ai/chat`. `needsYou={payload.needsYou}`, `links={links}`. Non-ready states (`locked`, `start`, `error`, `loading`) keep `HomeFrame` (the `h1` and the two nav links) exactly as today; the ready state does not render `HomeFrame`. `scopeLabel` = `wisp.scopeOrgId === null ? t('wisp.header.scopeAll') : orgName ?? ''`.

- [ ] **Step 1: Tests**: `ready state renders the column, the rail and no h1`, `brief present renders wisp-brief-card inside wisp-home-thread`, `no brief renders no brief post`, `start and locked states still render the framed heading` (adapt the existing cases). **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm exec vitest run src/components/wisp/WispHomeContent` → PASS. **Step 5: Commit** `feat(web): Wisp home — the conversation is the page`.

### Task 13: The thread page on the same layout

**Files:**
- Modify: `apps/web/src/components/wisp/WispThreadPage.tsx`
- Test: `apps/web/src/components/wisp/WispThreadPage.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 10, Task 11, Task 6 eyebrow key `wisp.post.summary`.

Changes: the page keeps its loading, not-found, error, stale and `onWispChange`/`onRevoked` logic. The ready state renders the Task 12 shell (same classes) with the column = `WispHomeThread` (`wisp`, `lastSessionId` from the thread DTO's `lastSessionId` field, `links={[]}`, `onLinksChange` no-op, `leading` = the summary as a post when `wisp.summary` is non-empty: eyebrow `t('wisp.post.summary')`, body `whitespace-pre-wrap`, `data-testid="wisp-thread-summary"`) and the rail with `needsYou={null}` (the rail then shows the concerns through `WispNeedsYou`? No: `needsYou` null hides that section; the thread page passes the concerns it already loads via `WispConcernsPanel` → keep `WispNeedsYou` sourced from a `[]` initial so the panel loads its own rows) and `links={null}`. The "Open in chat" button is removed (the thread is inline now; copy `wisp.thread.openChat*` is removed from `en/ai.json`). The page `h1` is removed; `wisp.thread.title` stays for the `<title>`.

- [ ] **Step 1: Tests**: `ready state renders the thread column and the rail without links`, `summary renders as a post`, `not found / error unchanged`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `feat(web): Wisp thread page adopts the companion layout`.

### Task 14: Locale fan-out and baseline (Sonnet)

**Files:**
- Modify: `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/ai.json`, `apps/web/src/locales/humanizedKeyBaseline.json`

- [ ] **Step 1: Run** `cd apps/web && pnpm exec vitest run src/lib/i18n/localeParity.test.ts src/locales/humanizedKeyRegression.test.ts` → FAIL listing every key added or removed by Tasks 2, 3, 4, 6, 7, 8, 9, 10, 11, 13.
- [ ] **Step 2:** Add every new key to the seven locales (translated, keys identical), remove every removed key, and drop removed keys from the baseline.
- [ ] **Step 3: Run** the two suites → PASS. **Step 4: Commit** `chore(web): locale fan-out for the Wisp companion surface`.

### Task 15: Kit consumers

**Files:**
- Verify (modify only if a test says so): `apps/web/src/components/ai/AiChatSidebar.tsx`, `apps/web/src/components/workspace/WorkspaceChatPanel.tsx`, `apps/web/src/components/aiAgents/RunDetailPage.tsx`.

- [ ] **Step 1:** `WorkspaceChatPanel` passes `layout="page"` and `showTimeDividers` (Breeze AI page); `AiChatSidebar` passes `assistantLabel={wisp ? t('wisp.name') : undefined}` and nothing else (panel layout, no dividers); `RunDetailPage` unchanged.
- [ ] **Step 2: Run** `pnpm exec vitest run src/components/ai/ src/components/workspace/ src/components/aiAgents/ src/components/wisp/` → PASS.
- [ ] **Step 3: Typecheck** the web package the way CI does → exit 0.
- [ ] **Step 4: Commit** `feat(web): Breeze AI page and docked panel on the new chat kit`.

### Task 16: Docs, e2e, detector, visual pass, PR

**Files:**
- Modify: `apps/docs/src/content/docs/features/wisp.mdx` ("The Wisp home" section and its table), `e2e-tests/tests/wisp-home.spec.ts`.

- [ ] **Step 1 (Sonnet):** Rewrite the home section: the conversation at the center with the brief and nudges as Wisp posts, the rail (identity and controls, Needs your attention, Workers, Linked items, Activity), the composer (Enter sends), the strip below large widths; keep the switches, grants and nudges sections untouched.
- [ ] **Step 2:** e2e: replace the `wisp-brief-card` visibility assertion (no brief exists on a fresh stack) with `wisp-welcome`; keep `wisp-needs-you`, `wisp-home-thread`, `wisp-links-panel` and the picker flow. Run it against a `worktree-stack` (`pnpm wt-stack up`, Playwright `baseUrl` from its descriptor; tear down after).
- [ ] **Step 3:** Run the mechanical design detector once over the changed UI: `/Users/toddhebebrand/.claude/skills/impeccable/scripts/impeccable detect --json apps/web/src/components/ai apps/web/src/components/wisp` and fix what it reports in one batch.
- [ ] **Step 4:** Visual pass on the stack at 1440 and 390 px (Playwright screenshots of `/wisp` with a seeded grant and a chat with tool calls, `/ai/chat`, and the docked panel): one batched round, fix everything it shows, one confirmation round, stop.
- [ ] **Step 5:** Full web suite `cd apps/web && pnpm test` → PASS; `pnpm lint` → PASS.
- [ ] **Step 6:** PR to `main` with `Closes #<wave sub-issue>`, the spec link, the before/after screenshots, the list of removed locale keys, and the Settings rule-9 line "no setting added".
