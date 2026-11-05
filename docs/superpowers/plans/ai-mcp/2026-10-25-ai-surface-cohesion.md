---
spec: docs/superpowers/specs/ai-mcp/2026-10-25-ai-surface-cohesion-assessment.md
tracking_issue: LanternOps/breeze#10131
baseline_commit: 26f77884e8
---

# AI Surface Cohesion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Breeze's AI read as one product in the app, the mobile app, the public docs and the website: the vocabulary of `docs/glossary.md` (website, adopted 2026-10-24) applied in-product, a sidebar that follows "Operators run Breeze. The workers do the work. Wisp runs your day.", and one chat door whose voice is decided by the Wisp grant, not a toggle.

**Architecture:** Copy and navigation only. No database table, route namespace, locale namespace, extension manifest name, `data-testid` or API contract changes except one additive web page (`/ai/chat`) with redirects from the two old addresses and one additive settings hub page (`/settings/ai`). The decisions are in the spec §11; this plan does not reopen them. Every vocabulary wave lands with a guard test (`apps/web/src/lib/__tests__/aiVocabulary.*.test.ts`) that scans the English locale catalogue for the retired phrases, so the next feature wave cannot reintroduce them.

**Tech Stack:** Astro + React + react-i18next (web, 8 locale dirs), React Native (mobile, inline strings), Starlight (`apps/docs`), Lit (`ee/workspace/src/web`), Astro (website repo `LanternOps/breezermm-website`), Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-25-ai-surface-cohesion-assessment.md` — §4 (model), §5 (navigation), §6 (vocabulary table), §7 (chat door), §8 (docs), §11 (decisions: AI Tasks, Breeze AI, Workers heading, grant-driven voice, agents stay "agents"), §12 (website corrections).

## Execution split and parallelism (orchestrator, 2026-10-25)

Eight waves in three batches. Every wave bases on `origin/main` and targets `main` (never stacked).

| Batch | Waves (run in parallel) | Model | Why this batch |
|---|---|---|---|
| 1 | **W01** chat vocabulary + guard ∥ **W02** Operator → AI task ∥ **W03** decisions, spend, tiers ∥ **W06** knowledge connector relabel ∥ **W07** public docs ∥ **W08** website | W01 W02 W06 W07 W08 **Sonnet**; W03 **Sonnet** with an Opus reviewer (it has three small code changes) | File-disjoint except the shared locale catalogues (different keys) and `humanizedKeyBaseline.json` (see rules). Six fixers is under the ~8 heavy-fixer host cap; drop to five by holding W08 if other orchestrators are running. |
| 2 | **W04** navigation collapse + settings hub | **Opus** (permission-gated nav, settings registry) | Owns `Sidebar.tsx`, `settingsCatalog.ts`, `CommandPalette.tsx`, `common:nav.*`; re-keys labels W01–W03 set. |
| 3 | **W05** one chat door | **Opus** (entitlement and lock logic, route move) | Changes the `Breeze AI` href W04 set and the Wisp entry's locked state; owns `components/ai/*`, `components/wisp/WispHomePage.tsx`, `pages/wisp/*`, `pages/ai/*`, `pages/workspace.astro`. |

**File ownership (batch 1).** W01: `ai.json` (chat, script, AI-for-Office keys), `common.json` (`layout.header.*`, `aiInitiator.*`, `account.apps.*`, `longTail.onboarding.*`), `scripts.json`, `flows.json`, `patches.json`, `devices.json` (`devicePlaybookHistory.*`), `settings.json` (`scriptAuthoringPage.*`, `partnerAiApprovals.*`), `toolSources.json` (`subtitle`), `billing.json` (`rates.ai.*`), `callerVerificationTech.json`, `integrations.json` (connected-apps keys), `approvals.json` (`diagnosticAccess.principalUser` only), `apps/mobile/src/screens/chat/HomeScreen.tsx`, `apps/mobile/src/screens/onboarding/OnboardingScreen.tsx`, the guard helper and the chat guard test. W02: `aiOperator.json`, `checklists.json`, `tickets.json` (`ticketWorkbench.merge.counts.*`), `devices.json` (`deviceDetails.operatorTasks*`), `ai.json` (`wisp.picker.kinds.task` only), `approvals.json` (`operatorPlan.title` only), `pages.json` (`titles.aiTasks`, `titles.aiTask`), `apps/web/src/pages/operator/**`, `apps/web/src/components/aiOperator/OperatorTaskActivityFeed.tsx` + its test (label and docs href), `e2e-tests/pages/OperatorTaskPage.ts` comments, the tasks guard test. W03: `ai.json` (`aiApprovalDialog.*`, `aiPlanReviewCard.*`, `wisp.spend.*`, `wisp.activity.cost`, `wisp.settings.budget`), `approvals.json` (everything except `operatorPlan` and `diagnosticAccess.principalUser`), `aiOperator.json` (`taskPanels.plan.state.*`, `operatorTaskDetail.nextAction.*` only — W02 does not touch these two sub-trees), `common.json` (`longTail.remediation.*`), `settings.json` (`aiAgentsPage.graduation.*`, `aiAgentsPage.summary.*`, `aiAgentsRuns.*`), `admin.json` (`admin.wisp.*`), `security.json` (`aiRisk*`), `toolSources.json` (tier keys), `apps/web/src/components/ai-risk/tierConfig.ts`, `TierOverviewMatrix.tsx`, `components/ai/AiCostIndicator.tsx`, `components/wisp/*Spend*`/budget input, `components/aiOperator/*` next-action link, the decisions guard test. W06: `ee/workspace/**`, `apps/helper/src/lib/workspaceChatTools.ts`, `settings.json` (`aiModels.workspaceNote` only). W07: `apps/docs/**` only. W08: the website repo only.

**Merge order inside batch 1:** W07 (creates `features/ai-tasks.mdx`) merges before W02 (points the in-app "Learn about AI tasks" link at it). Everything else in any order.

**PARALLEL GROUPS inside a wave** are listed per wave. Tasks in one group are file-disjoint and may run as concurrent subagents in the same worktree; concurrent subagents never run `git commit`; the fixer commits once per group after all members pass. Groups run in the listed order.

**Rules for every wave**
- **Locale JSON merges:** when a sibling wave lands first, resolve conflicts with a three-way JSON merge (both sides' keys, honour main's deletions), then run `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts` (254 tests) as the check. Never resolve a locale conflict by taking one side whole.
- **Shared guard helper:** W01 creates `apps/web/src/lib/__tests__/aiVocabularyGuard.ts`. W02 and W03 need it before W01 merges: copy it **verbatim** from W01's branch (`git show origin/feature/<parent#>-ai-surface-cohesion/wave-<W01#>:apps/web/src/lib/__tests__/aiVocabularyGuard.ts`) into the same path. Byte-identical files resolve cleanly on rebase. Never re-type it.
- **`humanizedKeyBaseline.json`:** every removed `en` key is also removed from `apps/web/src/locales/humanizedKeyBaseline.json` in the same commit, or CI fails on the stale entry. Added keys need no baseline entry.
- **Model routing:** tasks marked **Sonnet** are copy fan-out, docs and pure helpers. Everything that touches permission gating, entitlement, routes or `Sidebar.tsx` is Opus.
- The wave that lands last in a batch owns the PR-body statement that the vocabulary guard suites all pass together on `main`.

## Global Constraints

- **Vocabulary is the spec §6 table.** Write it as: **Breeze AI** (the chat door, speaking as **Wisp** under a grant); **the workers** (collective; nav heading **Workers**); **agent** (always under the Workers heading or as "AI agent"); **AI task** (always qualified, never bare "task" for Operator work); **recipe** (never "workflow"); **run**; **check** (never "assessment" in user copy); **Approve / Deny**, status **Denied**, the place is **Approvals** (never "inbox" alone); **usage / budget / credits** in dollars; tiers as **Tier 1 reads · Tier 2 acts and logs · Tier 3 asks first · Tier 4 blocked**; **knowledge sources** (never "Workspace" for the ee connector); **Breeze Assist** (Helper chat); **Breeze AI for Office**. Retired in visible copy: "AI Assistant", "Breeze AI Assistant", "AI assistant" (except inside Breeze AI for Office copy that names the product), "the assistant", "AI chat", "Breeze AI chat", "Wisp chats", "Operator"/"AI Operator" meaning software, "workflow" in AI-task copy, "Reject"/"Decline" for AI approvals, "inbox" for Approvals, "¢", "Assessments", "Auto-Execute + Audit", "Workspace" for the connector.
- **Person-sense "operator" stays.** `alerts:alertRuleForm.operator`, `alerts:alertRuleForm.invalidOperator`, `alerts:notificationChannelForm.*`, `devices:filterValueEditor.operator`, `policies:*` (comparison operators, remote-access operator, retention hold), docs "Breeze operators" / "your operator" (the person running the deployment) are allowlisted in the guard, not rewritten.
- **Locales:** every changed or added `en` key lands in all 8 dirs (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`), machine-drafted for the seven non-English locales. Run `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts` in every web task. Mobile copy is inline strings.
- **Identifiers do not change:** `aiOperator` locale namespace and `aiOperator:*` key paths, `ai_operator_*` tables, `/operator` and `/api/v1/ai/operator` routes, `workspace_*` tables, `ee/workspace` `manifest.name`/`routeNamespace`, `wisp*` identifiers, every `data-testid` (`delegate-to-operator`, `delegate-to-operator-confirm`, `wisp-toggle-locked`, …). Copy-only is how W08 of Wisp relabelled the connector; follow it.
- **No new setting** is introduced (settings rule 9 is not triggered). W04 adds a settings **hub** page, not a setting; it states this in the PR body.
- **URL state** stays in `window.location.hash`. Redirects carry the hash (`/workspace#session=<id>`, `/wisp/chat#session=<id>` → `/ai/chat#session=<id>`), as `pages/workspace.astro` does today.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`); the only mutation this plan touches is the Wisp budget input (W03), which already does.
- **Tests:** `cd apps/web && npx vitest run <path>`; `cd apps/mobile && npx vitest run <path>`; `cd ee/workspace && npx vitest run`; `cd apps/docs && pnpm build` (Starlight fails the build on a dead sidebar slug); website `cd "<website clone>" && npx vitest run src/lib/claimsGuard.test.ts`. Never `pnpm --filter <pkg> test -- --run`.
- **Sibling features in flight** (verified 2026-10-25): Operator Recipe Library #6165 W07 (PR #10128 open) adds `identity_onboarding` web copy under `aiOperator:recipeLibrary.*`; In-product AI full control #6754 W04 (PR #10130 open) touches chat tools, not copy. If #10128 lands before W02, W02 sweeps its new strings too; the guard catches a miss.

## Review Focus

1. **A self-hosted Community user with `ai_sessions:use`** opens the sidebar: the Wisp entry is present and locked with "Wisp runs on Breeze Cloud. It is not available on this server.", and `/wisp` shows the same lock. They never land on a page called Wisp that is plain chat. Pinned in W04 Task 3 (sidebar) and W05 Task 2 (home).
2. **A person whose grant is paused or ended** opens the side panel: the header says Breeze AI, no Wisp thread is seeded, no request to `/wisp/thread` fails loudly. Pinned in W05 Task 1.
3. **A user without `ai_agents:read`** sees no empty **Workers** heading. Pinned in W04 Task 1.
4. **Deep links** `/workspace#session=<id>` and `/wisp/chat#session=<id>` open the tab on `/ai/chat`, and five persisted `breeze-workspace` tabs survive the move. Pinned in W05 Task 3.
5. **The AI task "Approve in Approvals" link** opens the actual card (`/approvals#intent-<id>`), not the page top. Pinned in W03 Task 2.
6. **Breeze AI for Office copy** keeps the word "assistant" only where "Breeze AI for Office" (or "for Office") appears in the same string; the guard allowlist is key-exact, not namespace-wide. Pinned in W01 Task 1.

## File structure

| Path | Responsibility |
|---|---|
| `apps/web/src/lib/__tests__/aiVocabularyGuard.ts` | `scanEnglishCatalogue(rules, allow)` — walks `src/locales/en/*.json`, returns `{ key, value, rule }[]` violations |
| `apps/web/src/lib/__tests__/aiVocabulary.chat.test.ts`, `.tasks.test.ts`, `.decisions.test.ts` | one suite per vocabulary family (W01, W02, W03) |
| `apps/web/src/components/layout/Sidebar.tsx` | AI section rebuilt per spec §5; `kind: 'heading'` nav items; Wisp locked entry |
| `apps/web/src/lib/settingsCatalog.ts`, `apps/web/src/pages/settings/ai.astro`, `components/settings/SettingsCatalog.tsx` | Settings → AI hub (`group` filter) |
| `apps/web/src/pages/ai/chat.astro`, `pages/wisp/chat.astro` (redirect), `pages/workspace.astro` (redirect) | the full-page Breeze AI chat at its new address |
| `apps/web/src/components/ai/AiChatSidebar.tsx`, `WispToggle.tsx` (deleted), `stores/aiStore.ts` | grant-driven voice |
| `apps/web/src/components/wisp/WispHomePage.tsx` | lock instead of forward when Wisp is off |
| `apps/web/src/components/ai-risk/tierConfig.ts`, `TierOverviewMatrix.tsx` | tier labels from locale |
| `apps/web/src/components/aiOperator/OperatorTaskActivityFeed.tsx` | "Learn about AI tasks" → `features/ai-tasks/` (W02) |
| `ee/workspace/manifest.json`, `ee/workspace/src/web/{deviceIndex,sourcesPage,filingCard}.ts` | "Knowledge" labels |
| `apps/docs/astro.config.mjs`, `apps/docs/src/content/docs/features/{ai,ai-tasks,wisp,ai-agents}.mdx`, `index.mdx`, `reference/api.mdx`, `features/mobile.mdx` | docs IA |
| website `docs/glossary.md`, `src/content/features/ai-brain.md`, `src/lib/claimsGuard.test.ts` | glossary corrections |

---

## W01 — Chat vocabulary and the guard (Sonnet)

PARALLEL GROUPS: G1 = Task 1 (helper + guard, red). G2 = Task 2 (web copy) ∥ Task 3 (mobile copy). Task 4 last.

### Task 1: Vocabulary guard helper and the chat-family suite

**Files:**
- Create: `apps/web/src/lib/__tests__/aiVocabularyGuard.ts`, `apps/web/src/lib/__tests__/aiVocabulary.chat.test.ts`

**Interfaces:**
- Produces: `export interface VocabularyRule { name: string; pattern: RegExp; namespaces?: string[] }`; `export function scanEnglishCatalogue(rules: VocabularyRule[], allow: ReadonlySet<string>): Array<{ key: string; value: string; rule: string }>` where `key` is `namespace:dotted.path` and `allow` holds exact keys. The scan reads every `apps/web/src/locales/en/*.json` with `readFileSync` (no i18n runtime), walking nested objects and arrays the way `localeParity.test.ts:379-387` does.

- [ ] **Step 1: Write the failing test**

```ts
// aiVocabulary.chat.test.ts
const CHAT_RULES: VocabularyRule[] = [
  { name: 'AI Assistant', pattern: /\bAI Assistant\b/ },
  { name: 'Breeze AI Assistant', pattern: /\bBreeze AI Assistant\b/ },
  { name: 'AI assistant (lowercase)', pattern: /\bAI assistant\b/ },
  { name: 'the assistant', pattern: /\bthe assistant\b/i },
  { name: 'AI chat', pattern: /\bAI chat\b/ },
  { name: 'Breeze AI chat', pattern: /\bBreeze AI chat\b/ },
  { name: 'Wisp chats', pattern: /\bWisp chats\b/ },
];
const ALLOW = new Set<string>([
  // Breeze AI for Office names the product in the same string or heading (spec §6):
  'ai:aiForOfficePage.description', 'ai:policyEditor.assistant', 'ai:policyEditor.whoCanUse',
]);
it('retired chat nouns do not appear in the English catalogue', () => {
  expect(scanEnglishCatalogue(CHAT_RULES, ALLOW)).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/__tests__/aiVocabulary.chat.test.ts`
Expected: FAIL listing at least `common:layout.header.ai`, `ai:aiChatMessages.title`, `ai:workspaceEmptyState.title`, `common:aiInitiator.assistant`.

- [ ] **Step 3: Implement `scanEnglishCatalogue` in `aiVocabularyGuard.ts`** (synchronous, no globals; a rule with `namespaces` only scans those files).

- [ ] **Step 4: Commit the red test and the helper**

```bash
git add apps/web/src/lib/__tests__/aiVocabularyGuard.ts apps/web/src/lib/__tests__/aiVocabulary.chat.test.ts
git commit -m "test(web): AI vocabulary guard — chat family (red)"
```

### Task 2: Web copy — one name for the chat door (Sonnet)

**Files:**
- Modify (en + 7 locales): `apps/web/src/locales/*/common.json`, `ai.json`, `scripts.json`, `flows.json`, `patches.json`, `devices.json`, `settings.json`, `toolSources.json`, `billing.json`, `callerVerificationTech.json`, `integrations.json`, `pages.json`
- Modify: `apps/web/src/locales/humanizedKeyBaseline.json` (removed keys only)

- [ ] **Step 1: Rewrite these keys (values are the spec's copy; keys do not change)**

| Key | New value |
|---|---|
| `common:layout.header.ai` | Breeze AI |
| `common:layout.header.aiTitle` | Breeze AI (⌘⇧A) |
| `ai:aiChatMessages.title` | Breeze AI |
| `ai:aiChatSidebar.title` | Breeze AI (unchanged) |
| `common:aiInitiator.assistant` | Breeze AI |
| `ai:workspaceEmptyState.title` | Breeze AI |
| `ai:workspaceEmptyState.description` | Run several conversations at once. Investigate a device in one tab while you set up a policy in another. |
| `pages:titles.wispChat` | Breeze AI |
| every "Open in Wisp chats" / "Close a tab in Wisp chats…" / "Continue in side panel" family key in `ai:aiChatSidebar.*` and `ai:workspace*` | "Open in Breeze AI", "Close a tab in Breeze AI to open this conversation" (side-panel verb unchanged) |
| `scripts:*` script-editor button, panel title, empty state ("AI Assistant", "AI Script Assistant", "Script AI Assistant") | Breeze AI / Breeze AI / Ask Breeze AI to write or review this script. |
| `settings:scriptAuthoringPage.*` "Let the assistant and your agents…" | Let Breeze AI and your agents write, review and, when you allow it, run scripts without a card. |
| `toolSources:subtitle` "…available to AI chat…" | …available to Breeze AI… |
| `flows:*` "Draft them in AI chat" / "Created in AI chat" | Draft them in Breeze AI / Created in Breeze AI |
| `patches:*` empty state mentioning the AI assistant | …ask Breeze AI… |
| `devices:devicePlaybookHistory.emptyHelp` "…via the AI assistant…" | …via Breeze AI… |
| `settings:partnerAiApprovals.*` "How long AI chat waits…" | How long Breeze AI waits for a gated action to be approved |
| `approvals`/`ai` diagnostic-access requester "Breeze AI chat" | Breeze AI |
| `billing:rates.ai.sectionHelp` "AI assistant usage" | Breeze AI usage |
| `ai:aiApprovalDialog.runContextChosenByAssistant`, `.runContextOverrides` | chosen by Breeze AI (…) |
| `callerVerificationTech:refusal.verifiedRetry` | Caller verified. Ask Breeze AI to try again. |
| `common:account.apps.onlyAppDescription` and the `integrations:*` connected-apps keys that say "AI assistants and MCP clients" | "AI clients" (an outside AI tool connected over MCP; glossary "AI client") |
| `common:longTail.onboarding.OnboardingTour.steps.aiHelp` | Breeze AI — ask about your fleet in plain language. Press ⌘⇧A anywhere. |
| `common:nav.aiForOffice`, `pages:titles.aiForOffice`, `ai:aiForOfficePage.title` | Breeze AI for Office |
| `ai:orgsTab.*`, `ai:policyEditor.*` strings saying "the Excel assistant" / "Excel AI assistant" | Breeze AI for Office (keep "assistant" only in the three allowlisted keys) |

Grep for stragglers: `rg -n "AI Assistant|AI assistant|the assistant|AI chat|Wisp chats" apps/web/src/locales/en` must return only allowlisted keys.

- [ ] **Step 2: Run the guard and parity**

Run: `cd apps/web && npx vitest run src/lib/__tests__/aiVocabulary.chat.test.ts src/lib/i18n/localeParity.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the component suites whose assertions quote the old strings**

Run: `cd apps/web && npx vitest run src/components/ai src/components/layout src/components/scripts src/components/workspace`
Expected: PASS after updating string assertions (`AiChatMessages.test.tsx`, `AiChatSidebar.*.test.tsx`, `WorkspacePage.test.tsx`, header tests). `data-testid` selectors are untouched.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/locales
git commit -m "feat(web): the chat door is Breeze AI everywhere (spec §6)"
```

### Task 3: Mobile copy (Sonnet)

**Files:**
- Modify: `apps/mobile/src/screens/chat/HomeScreen.tsx:784` (placeholder "Ask Breeze" → "Ask Breeze AI"), `apps/mobile/src/screens/onboarding/OnboardingScreen.tsx` (the "Ask Breeze about your devices… The AI runs the queries…" step → "Ask Breeze AI about your devices…"), `apps/mobile/src/navigation/MainNavigator.tsx:322` (`tabBarLabel: 'Home'` unchanged)
- Test: the existing screen tests that quote the placeholder (`rg -n "Ask Breeze" apps/mobile/src --glob '*.test.*'`)

- [ ] **Step 1: Update the quoted strings in the tests first, run them red, then change the screens**

Run: `cd apps/mobile && npx vitest run src/screens/chat src/screens/onboarding`
Expected: FAIL on the placeholder assertion, then PASS.

- [ ] **Step 2: Commit** `git commit -m "feat(mobile): Ask Breeze AI"`

### Task 4: Docs line, PR body

- [ ] Add one line to `docs/release-notes/next-release-draft.md` under a new heading `### AI surface cohesion` (append; this file is a merge-queue hot spot, so append only and enqueue behind any queued PR that touches it).
- [ ] PR body: `Closes #<W01 sub-issue>`; list the allowlisted keys and why each keeps "assistant".

---

## W02 — Operator → AI task (Sonnet)

PARALLEL GROUPS: G1 = Task 1 (guard, red). G2 = Task 2 (locale copy) ∥ Task 3 (page titles + e2e comments). Task 4 last.

### Task 1: Tasks-family guard suite

**Files:**
- Create: `apps/web/src/lib/__tests__/aiVocabulary.tasks.test.ts` (uses `aiVocabularyGuard.ts`; copy it verbatim from W01's branch if W01 has not merged)

- [ ] **Step 1: Write the failing test**

```ts
const TASK_RULES: VocabularyRule[] = [
  { name: 'Operator as software', pattern: /\b(AI )?[Oo]perator\b(?! targets)/, namespaces: ['aiOperator', 'checklists', 'devices', 'tickets', 'ai', 'approvals', 'alerts'] },
  { name: 'bare "Operator step"', pattern: /\bOperator step/ },
  { name: 'workflow in AI-task copy', pattern: /\bworkflow\b/i, namespaces: ['aiOperator'] },
  { name: 'delegate to', pattern: /\b[Dd]elegate to the Operator\b/ },
];
const ALLOW = new Set<string>([
  'alerts:alertRuleForm.operator', 'alerts:alertRuleForm.invalidOperator',
  'alerts:notificationChannelForm.alertValueValueIsValueThresholdValue',
  'devices:filterValueEditor.operator',
]);
it('the Operator is never software in the English catalogue', () => {
  expect(scanEnglishCatalogue(TASK_RULES, ALLOW)).toEqual([]);
});
```

- [ ] **Step 2: Run red** — `cd apps/web && npx vitest run src/lib/__tests__/aiVocabulary.tasks.test.ts` → FAIL listing the 13 `aiOperator:*` keys, 5 `checklists:*`, 2 `devices:deviceDetails.*`, `tickets:ticketWorkbench.merge.counts.ai_operator_task_targets`, `ai:wisp.picker.kinds.task`, `approvals:operatorPlan.title`.
- [ ] **Step 3: Commit the red test.**

### Task 2: Locale copy — the noun is "AI task" (Sonnet)

**Files:**
- Modify (en + 7 locales): `aiOperator.json`, `checklists.json`, `tickets.json`, `devices.json`, `ai.json` (one key), `approvals.json` (one key), `pages.json` (two new keys)

- [ ] **Step 1: Rewrite**

| Key | New value |
|---|---|
| `aiOperator:nav.operator` | AI Tasks (W04 later moves this label to `common:nav.aiTasks`) |
| `aiOperator:delegate.button`, `.dialogTitle` | Start an AI task |
| `aiOperator:delegate.dialogMessage` | The workers will investigate and try to resolve this with the recipe below. |
| `aiOperator:delegate.workflowLabel` | Recipe |
| `aiOperator:delegate.queued` | AI task started. |
| `aiOperator:delegate.failed` | Could not start the AI task. |
| `aiOperator:operatorTaskFeed.loading` / `.loadFailed` / `.empty` | Loading AI tasks… / AI tasks failed to load. / No AI tasks for this device. |
| `aiOperator:operatorTaskFeed.emptyHint` | The workers investigate and resolve issues on a device when you start an AI task from an alert. AI tasks for this device appear here. |
| `aiOperator:operatorTaskFeed.learnMore` | Learn about AI tasks — and `AI_OPERATOR_DOCS_URL` in `apps/web/src/components/aiOperator/OperatorTaskActivityFeed.tsx:18` becomes `https://docs.breezermm.com/features/ai-tasks/` (the page W07 creates); `OperatorTaskActivityFeed.test.tsx:71` asserts the new name and href |
| `aiOperator:workspace.tabs.label` | AI task sections |
| `aiOperator:taskList.empty` | No AI tasks yet. |
| every other `aiOperator:*` value matching the rule (task detail headings, start-recipe form, library copy: "Operator task" → "AI task", "the Operator" → "the workers") | — |
| `devices:deviceDetails.operatorTasks` / `.operatorTasksForThisDevice` | AI Tasks / AI tasks for this device |
| `checklists:source.operator_task` | AI task step |
| `checklists:operator.badgeTitle` | Created by an AI task. Tick it when the work is done and the task continues. |
| `checklists:errors.operatorStepWaiting`, `checklists:templates.errors.operatorStepWaiting` | An AI task is still waiting on this step… (rest unchanged) |
| `checklists:templates.saveAs.skipped` | Left out: {{operator}} AI task step(s) and {{duplicates}} repeated step(s). |
| `tickets:ticketWorkbench.merge.counts.ai_operator_task_targets` | AI task targets: {{count}} |
| `ai:wisp.picker.kinds.task` | AI tasks |
| `approvals:operatorPlan.title` | Plan for AI task |
| `pages:titles.aiTasks` (new) / `pages:titles.aiTask` (new) | AI Tasks / AI task |

`aiOperator:operatorTaskDetail.handledBy` ("Handled by {{agent}}") and `.wispFor` ("Wisp for {{name}}") are unchanged.

- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/__tests__/aiVocabulary.tasks.test.ts src/lib/i18n/localeParity.test.ts src/components/aiOperator src/components/alerts src/components/devices src/components/tickets` → PASS after updating string assertions (`DelegateToOperatorButton.test.tsx`, `AlertDetailPage.delegateToOperator.test.tsx`, `TicketChecklistCard.test.tsx`). Test ids unchanged.
- [ ] **Step 3: Commit** `git commit -m "feat(web): Operator work is an AI task (spec §11.1)"`

### Task 3: Page titles out of the hard-coded strings (Sonnet)

**Files:**
- Modify: `apps/web/src/pages/operator/index.astro:6` (`title="Operator"` → the `titles.aiTasks` key the way sibling pages pass a translated title; follow `apps/web/src/pages/wisp/index.astro`), `apps/web/src/pages/operator/tasks/[taskId].astro:8` (`titles.aiTask`), `e2e-tests/pages/OperatorTaskPage.ts:9,13` (comments say "Start an AI task"; selectors unchanged)
- Test: `apps/web/src/lib/__tests__/aiVocabulary.tasks.test.ts` gains a second `it` that reads both `.astro` files and asserts `title="Operator` is absent.

- [ ] **Step 1: Add the assertion, run red, fix, run green.**
- [ ] **Step 2: Commit.**

### Task 4: PR

- [ ] `docs/release-notes/next-release-draft.md`: one line under `### AI surface cohesion` (append). PR body `Closes #<W02 sub-issue>`; state that no `data-testid`, route or `aiOperator` key path changed.

---

## W03 — Decisions, spend, tiers (Sonnet, Opus reviewer)

PARALLEL GROUPS: G1 = Task 1 (guard, red). G2 = Task 2 (Approvals link + verbs) ∥ Task 3 (spend in dollars) ∥ Task 4 (tier labels). Task 5 last.

### Task 1: Decisions-family guard suite

**Files:**
- Create: `apps/web/src/lib/__tests__/aiVocabulary.decisions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
const DECISION_RULES: VocabularyRule[] = [
  { name: 'Reject/Decline for AI approvals', pattern: /\b(Reject(ed)?|Decline(d)?)\b/, namespaces: ['ai', 'approvals', 'aiOperator'] },
  { name: 'remediation reject', pattern: /\bReject\b/, namespaces: ['common'] },   // common:longTail.remediation.*
  { name: 'inbox for Approvals', pattern: /\binbox\b/i, namespaces: ['aiOperator', 'settings'] },
  { name: 'cents', pattern: /¢/ },
  { name: 'Assessments', pattern: /\bAssessments?\b/, namespaces: ['admin', 'ai'] },
  { name: 'Auto-Execute tier wording', pattern: /Auto-Execute/ },
];
const ALLOW = new Set<string>([
  // Gmail mailbox settings describe a mail inbox, not Approvals:
  'settings:gmailMailbox.handling.off', 'settings:gmailMailbox.handling.onArchive', 'settings:gmailMailbox.handling.onLabelOnly',
  'settings:gmailMailbox.handling.archiveField', 'settings:gmailMailbox.handling.error.not_queued', 'settings:gmailMailbox.handling.error.failed',
  'ai:aiApprovalDialog.progressLabel',   // "auto-rejection" is the timer semantics, rewritten in Task 2 anyway
]);
it('AI decisions are Approve / Deny, in Approvals, in dollars, with the four tier names', () => {
  expect(scanEnglishCatalogue(DECISION_RULES, ALLOW)).toEqual([]);
});
it('tier labels live in the locale catalogue, not in tierConfig.ts', () => {
  const src = readFileSync('src/components/ai-risk/tierConfig.ts', 'utf8');
  expect(src).not.toMatch(/label: '(Auto-Execute|Requires Approval|Blocked)/);
});
```

- [ ] **Step 2: Run red**, commit.

### Task 2: Approve / Deny, and "Approve in Approvals" is a link (Sonnet; Opus reviews the link)

**Files:**
- Modify (en + 7 locales): `ai.json` (`aiApprovalDialog.reject` → Deny; `aiApprovalDialog.progressLabel` → "Time left before this is denied automatically"; `aiPlanReviewCard.reject` → Deny), `approvals.json` (`batch.declineAll` → "Deny all ({{count}})"; `intentStatus.status.rejected` → Denied), `aiOperator.json` (`taskPanels.plan.state.rejected` → Denied; `operatorTaskDetail.nextAction.approveInInbox` → "Approve in Approvals"), `common.json` (`longTail.remediation.RemediationSuggestionsPanel.reject` → Deny), `settings.json` (`aiAgentsPage.graduation.approvalsLink` → "Track this request in Approvals"; `aiAgentsPage.summary.approvers_one/_other` → "{{roles}} is/are asked in Approvals, in chat and by mobile push. First decision wins.")
- Modify: the component under `apps/web/src/components/aiOperator/` that renders `operatorTaskDetail.nextAction.approveInInbox` (find with `rg -n "approveInInbox" apps/web/src/components/aiOperator`): render it as `<a href={`/approvals#intent-${intentId}`}>` when the task payload carries the pending intent id, else `/approvals`.
- Test: that component's `.test.tsx` — `it('links the next action to the approval card', …)` asserting `href="/approvals#intent-<id>"`.

- [ ] **Step 1: Write the link assertion, run red.** Expected: the text renders with no anchor.
- [ ] **Step 2: Implement; keys do not change (only values).** Patch approvals, PAM, quotes, account-deletion "Reject/Decline" are out of scope (different concepts).
- [ ] **Step 3: Run** `cd apps/web && npx vitest run src/components/aiOperator src/components/ai src/components/approvals src/lib/__tests__/aiVocabulary.decisions.test.ts` → the decisions suite still fails on `¢`, `Assessments` and `Auto-Execute` until Tasks 3–4 land; everything else PASS.
- [ ] **Step 4: Commit.**

### Task 3: Spend in dollars (Sonnet)

**Files:**
- Modify (en + 7 locales): `ai.json` `wisp.spend.meter` → "{{spent}} of {{budget}} today", `wisp.activity.cost` → "{{amount}}", `wisp.settings.budget` → "Daily budget"; `admin.json` `admin.wisp.table.assessmentsToday`, `admin.wisp.grants.assessmentsToday` → "Checks today"; `settings.json` `aiAgentsPage.runs.detail.budget.title` "Exposure budget" → "Action budget"; new `ai:aiCostIndicator.thisMonth` = "{{amount}} this month", `ai:aiCostIndicator.credits_one/_other` = "{{count}} credit(s)"
- Modify: the Wisp spend-meter and activity components (`rg -n "wisp.spend.meter|wisp.activity.cost" apps/web/src/components`) to pass `formatCurrency(cents / 100)`; the budget input to display dollars with two decimals and submit `Math.round(dollars * 100)` (API stays in cents); `apps/web/src/components/ai/AiCostIndicator.tsx:124-125` to use the two new keys.
- Test: the spend-meter component test — `it('shows the meter in dollars', …)` expecting "$0.42 of $2.00 today" for 42/200; the budget input test — `it('submits cents', …)` expecting `{ dailyBudgetCents: 250 }` for "2.50".

- [ ] **Step 1: Tests red.** - [ ] **Step 2: Implement.** - [ ] **Step 3: Run the wisp + ai component suites and parity → PASS.** - [ ] **Step 4: Commit.**

### Task 4: One tier vocabulary (Sonnet)

**Files:**
- Modify: `apps/web/src/components/ai-risk/tierConfig.ts:57,238,335,446` (the `label` field stays a `string` and becomes the locale key `aiRisk.tiers.<id>.label`; `apps/api/src/services/aiGuardrailsTierParity.shared.ts:104` reads `entry.label` only for its failure message and `aiGuardrails.ts:77` documents the parity guard (#2686), so the tool lists are untouched and the parity test `apps/api/src/services/aiToolsAiAgentGovernance.test.ts` must still pass), `apps/web/src/components/ai-risk/TierOverviewMatrix.tsx:100` (`t(tier.label)`)
- Modify (en + 7 locales): `security.json` new `aiRisk.tiers.{tier1,tier2,tier3,tier4}.label` = "Tier 1 — Reads" / "Tier 2 — Acts and logs" / "Tier 3 — Asks first" / "Tier 4 — Blocked"; `toolSources.json` tier options "1 — Read only / 2 — Writes, approval by policy / 3 — Approval required" → "Tier 1 — Reads" / "Tier 2 — Acts and logs (approval by policy)" / "Tier 3 — Asks first"
- Test: `TierOverviewMatrix.test.tsx` — `it('renders the four tier names from the catalogue', …)`.

- [ ] **Step 1: Red.** - [ ] **Step 2: Implement.** - [ ] **Step 3: Run** `cd apps/web && npx vitest run src/components/ai-risk src/components/toolSources src/lib/__tests__/aiVocabulary.decisions.test.ts` and `cd apps/api && npx vitest run src/services/aiToolsAiAgentGovernance.test.ts` → PASS. - [ ] **Step 4: Commit.**

### Task 5: PR

- [ ] Release-notes line (append under `### AI surface cohesion`). PR body `Closes #<W03 sub-issue>`; name the three code changes (link, dollars, tier keys) for the Opus reviewer.

---

## W04 — Navigation collapse and the Settings → AI hub (Opus)

Runs after batch 1 merges. PARALLEL GROUPS: G1 = Task 1 (heading item kind + AI section) ∥ Task 2 (settings hub). G2 = Task 3 (Wisp locked entry) ∥ Task 4 (palette + inbound links). Task 5 last.

### Task 1: `kind: 'heading'` and the new AI section

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx:293-322` (the AI section), the `NavItem` type, the render function (`renderCollapsibleSection`), the active-path matcher (`:847-874`)
- Modify (en + 7 locales): `common.json` `nav.*`: add `nav.breezeAi` = "Breeze AI", `nav.workersHeading` = "Workers", `nav.agents` = "Agents", `nav.runs` = "Runs", `nav.aiTasks` = "AI Tasks", `nav.findings` = "Findings", `nav.impact` = "Impact"; remove `nav.aiAgentRuns`, `nav.fixMemory`, `nav.fleetDesign`, `nav.fleet` (and `aiOperator:nav.operator`) — and their `humanizedKeyBaseline.json` entries; `pages.json` `titles.fleet` → "Findings"; `common.json` `longTail.fleet.FleetOrchestrationPage.title` → "Findings", `.description` → "Cross-device patterns the workers found, worth one action instead of many"
- Test: `apps/web/src/components/layout/Sidebar.test.tsx` (extend)

**Interfaces:**
- Produces: `NavItem.kind?: 'link' | 'heading'` (default `'link'`); a heading has `labelKey` only. Rendering rule: a heading is omitted when every following item up to the next heading or the section end is hidden by permission/flag gates.

The AI section, in order:

| name | labelKey | href | icon | gate |
|---|---|---|---|---|
| Wisp | `nav.wisp` | `/wisp` | Sparkles | `ai_sessions:use` (locked state: Task 3) |
| Breeze AI | `nav.breezeAi` | `/wisp/chat` (W05 moves it to `/ai/chat`) | MessageSquare | `ai_sessions:use` |
| heading | `nav.workersHeading` | — | — | derived |
| Agents | `nav.agents` | `/settings/ai-agents` | Bot | `ai_agents:read` |
| Runs | `nav.runs` | `/ai-agents/runs` | History | `ai_agents:read` |
| AI Tasks | `nav.aiTasks` | `/operator` | ListChecks | `requiresAiOperatorTasks` + `ai_agents:read` |
| Findings | `nav.findings` | `/fleet` | Sparkles | `ai_agents:read` |
| Impact | `nav.impact` | `/ai-agents/impact` | TrendingUp | `ai_agents:read` |
| Breeze AI for Office | `nav.aiForOffice` | `/ai-for-office` | FileSpreadsheet | partner scope + `requiresAiForOffice` |

Removed from the section (not from the app): AI Usage, Script authoring, Tool Sources (→ Settings → AI, Task 2), Fix memory and Fleet Design (→ reached from Agents and Runs, Task 4).

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the Workers heading only when a worker item is visible', () => { /* render with ai_sessions:use only → no "Workers"; with ai_agents:read → "Workers" before "Agents" */ });
it('the AI section has exactly these entries in this order', () => { /* ['Wisp','Breeze AI','Workers','Agents','Runs','AI Tasks','Findings','Impact','Breeze AI for Office'] with all gates on */ });
it('never lists AI Usage, Script authoring, Tool Sources, Fix memory or Fleet Design in the AI section', () => {});
```

- [ ] **Step 2: Run red** — `cd apps/web && npx vitest run src/components/layout/Sidebar.test.tsx`.
- [ ] **Step 3: Implement.** - [ ] **Step 4: Run green + `localeParity` + `humanizedKeyBaseline` check (`npx vitest run src/lib/i18n`).** - [ ] **Step 5: Commit.**

### Task 2: Settings → AI hub

**Files:**
- Create: `apps/web/src/pages/settings/ai.astro` (renders `<SettingsCatalog group="ai" />` under the `titles.settingsAi` = "AI settings" title)
- Modify: `apps/web/src/components/settings/SettingsCatalog.tsx` (optional `group` prop filters to one group and hides the group heading), `apps/web/src/lib/settingsCatalog.ts:105-122` (add entry `{ id: 'ai', name: 'AI', labelKey: 'nav.sectionAi', href: '/settings/ai', icon: BrainCircuit, group: 'ai', sidebarOnly: true, requiredPermission: { resource: 'ai_sessions', action: 'use' } }`; add `'ai'` to `SIDEBAR_SETTINGS_IDS` after `'integrations'`; add `{ id: 'knowledge-sources', name: 'Knowledge sources', labelKey: 'nav.knowledgeSources', href: '/extensions/workspace/sources', icon: BookOpen, group: 'ai', requiresExtension: 'workspace' }` — gate reads the loaded extension navigation (`useExtensionNavigation`) the way `requiresWisp` reads the server flag), `apps/web/src/lib/settingsCatalog.test.ts`, `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts` (register the hub page; a `sidebarOnly` entry is excluded from the `/settings` index render)
- Locales: `common.json` `nav.knowledgeSources` = "Knowledge sources"; `pages.json` `titles.settingsAi` = "AI settings"

- [ ] **Step 1: Red** (`settingsPageRegistry.test.ts`: "Settings → AI is one hash-free hub at /settings/ai listing the AI group"; `settingsCatalog.test.ts`: `sidebarOnly` entries never render on the index; `knowledge-sources` hidden when the extension is not loaded).
- [ ] **Step 2: Implement.** - [ ] **Step 3: Green.** - [ ] **Step 4: Commit.** PR body states: "adds a settings hub, no new setting; rule 9 not triggered".

### Task 3: The Wisp entry is locked, never a plain chat

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (the Wisp item: when the sidebar's own `wispEnabled` read (`:712-780`) is `false`, render the item with a lock icon and `title={t('nav.wispLockedServer')}`; the link still goes to `/wisp`), `common.json` `nav.wispLockedServer` = "Wisp runs on Breeze Cloud. It is not available on this server."
- Test: `Sidebar.test.tsx` — `it('locks Wisp when the server has Wisp off', …)` (`data-testid="nav-wisp-locked"`).

- [ ] **Step 1: Red.** - [ ] **Step 2: Implement.** - [ ] **Step 3: Green.** - [ ] **Step 4: Commit.** (W05 Task 2 makes `/wisp` itself show the matching lock instead of forwarding.)

### Task 4: Palette gates and the inbound links for the folded pages

**Files:**
- Modify: `apps/web/src/components/layout/CommandPalette.tsx:423,426` (replace the hard-coded `aiForOfficeEnabled: false`, `wispEnabled: false` with `useWispEnabled()` from `@/lib/wispVisibility` and the `aiForOfficeEnabled` field of the same `/orgs/partners/me` read; add two palette commands "Ask Breeze AI" (opens the side panel, same handler as the header button) and "Open Wisp"), `apps/web/src/components/settings/AiAgentsPage.tsx` (the kind list rendered from `settings:aiAgentsPage.kindHints.*`: the `fix_research` row links to `/ai-agents/fix-memory`, the `designer` row to `/ai-agents/fleet-design`), `apps/web/src/components/aiAgents/RunsListPage.tsx` (header links "Fix memory" and "Fleet design" when the partner has an agent of that kind; `RunDetailPage.tsx:2252` already links fleet design per run)
- Locales: `settings.json` `aiAgentsPage.kindHints.fixResearchLink` = "Open fix memory", `.designerLink` = "Open fleet design"
- Test: `CommandPalette.test.tsx` — `it('lists Wisp memory when the server has Wisp on', …)`; `AiAgentsPage.test.tsx` — the two links.

- [ ] **Step 1: Red.** - [ ] **Step 2: Implement.** - [ ] **Step 3: Green.** - [ ] **Step 4: Commit.**

### Task 5: Docs mapping, e2e, PR

- [ ] `rg -n "/fleet|fix-memory|fleet-design|ai-agents/runs" apps/web/src/lib/docsMapping* e2e-tests` — update the docs-mapping entries and any e2e nav walk (`e2e-tests/tests/*nav*.spec.ts`) to the new labels.
- [ ] Release-notes line. PR body `Closes #<W04 sub-issue>`: before/after entry counts (12 → 9 including the heading), the heading rule, "no new setting".

---

## W05 — One chat door (Opus)

Runs after W04 merges. PARALLEL GROUPS: G1 = Task 1 (panel voice) ∥ Task 3 (route move). G2 = Task 2 (home lock) ∥ Task 4 (sidebar href + links). Task 5 last.

### Task 1: The panel speaks as Wisp when a grant exists, and only then

**Files:**
- Delete: `apps/web/src/components/ai/WispToggle.tsx`, `WispToggle.test.tsx`
- Modify: `apps/web/src/components/ai/AiChatSidebar.tsx:30,200-207` (drop the toggle; on mount, when `useWispEnabled()` is true, the token is partner-scoped and `useEntitlement('wisp').state === 'enabled'`, call `fetchWispThread` from `@/lib/wispGrant`; if it returns an active grant (`status === 'active'`, not paused/ended) call `enterWispMode(state)`; otherwise stay as Breeze AI. Add a footer link `t('wisp.sidebar.meetWisp')` → `/wisp` when Wisp is on but no active grant exists), `apps/web/src/stores/aiStore.ts` (export the grant-status predicate `isActiveGrant(w: WispState): boolean` used here and by `rehydrateWispForSession`)
- Locales: `ai.json` remove `wisp.toggle.*` (+ baseline entries); add `wisp.sidebar.meetWisp` = "Meet Wisp"
- Test: `AiChatSidebar.wispHome.test.tsx` (extend) — `it('enters Wisp mode on open when an active grant exists', …)`, `it('stays Breeze AI when the grant is paused', …)`, `it('stays Breeze AI and offers Meet Wisp when there is no grant', …)`, `it('never calls /wisp/thread when the server has Wisp off', …)`

- [ ] **Step 1: Red.** - [ ] **Step 2: Implement.** - [ ] **Step 3: Run** `cd apps/web && npx vitest run src/components/ai src/stores` → PASS. - [ ] **Step 4: Commit.**

Reversibility note for the PR body: `exitWispMode` stays in the store; pausing the grant on the Wisp home is the user control for "not now" (spec §7).

### Task 2: `/wisp` locks instead of forwarding

**Files:**
- Modify: `apps/web/src/components/wisp/WispHomePage.tsx:25-30` (when `server === 'off'`, render `FeatureLock` with `why={t('wisp.locked.server')}` and no upgrade link instead of `window.location.replace(WISP_CHAT_PATH)`; `error` keeps today's behaviour), `ai.json` `wisp.locked.server` = "Wisp runs on Breeze Cloud. It is not available on this server."
- Test: `WispHomePage.test.tsx` — `it('shows the server lock when Wisp is off, and never navigates away', …)`.

- [ ] **Step 1: Red.** - [ ] **Step 2: Implement.** - [ ] **Step 3: Green.** - [ ] **Step 4: Commit.**

### Task 3: The full-page chat lives at `/ai/chat`

**Files:**
- Create: `apps/web/src/pages/ai/chat.astro` (the page `pages/wisp/chat.astro` is today, title `titles.wispChat` — already "Breeze AI" after W01)
- Modify: `apps/web/src/pages/wisp/chat.astro` → `return Astro.redirect('/ai/chat', 301)` with the same fragment-carrying comment as `pages/workspace.astro:3-5`; `pages/workspace.astro:5` → `/ai/chat`; `apps/web/src/components/wisp/WispHomePage.tsx:8` `WISP_CHAT_PATH = '/ai/chat'` and every `'/wisp/chat'` literal in `apps/web/src` (`rg -n "/wisp/chat" apps/web/src e2e-tests`), including the side panel's "Open in Breeze AI" target and the Wisp home "All chats" link
- Test: `WorkspacePage.test.tsx` (unchanged store assertions, page test at the new path); `e2e-tests/pages/AiWorkspacePage.ts`, `e2e-tests/tests/wisp-home.spec.ts:17`, `ai-move-conversation.spec.ts` (paths and the "Open in Breeze AI" label)

- [ ] **Step 1: Red** (page test at `/ai/chat`; a redirect test for `/wisp/chat#session=x` → `/ai/chat` keeping the hash, in the style of the existing `workspace.astro` test if one exists, else a Playwright assertion in `wisp-home.spec.ts`). - [ ] **Step 2: Implement.** - [ ] **Step 3: Green.** - [ ] **Step 4: Commit.**

### Task 4: Sidebar href and the keyboard shortcut

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (Breeze AI item href `/ai/chat`), `common.json` `layout.shortcuts.aiSidebar` "Toggle the AI sidebar" → "Toggle Breeze AI" and the sibling `layout.shortcuts.*` key for the ⌘⇧N new-tab shortcut → "New Breeze AI tab" (rendered by `src/components/layout/KeyboardShortcutsHelp.tsx`), the e2e nav walk
- Test: `Sidebar.test.tsx` href assertion.

- [ ] **Step 1: Red.** - [ ] **Step 2: Implement.** - [ ] **Step 3: Green.** - [ ] **Step 4: Commit.**

### Task 5: Docs + PR

- [ ] `apps/docs/src/content/docs/features/ai.mdx` "Chat surfaces" and `wisp.mdx` "Wisp chats": the page is **Breeze AI** at `/ai/chat`; `/workspace` and `/wisp/chat` redirect there; the side panel speaks as Wisp when a grant is active, with no toggle. (W07 regroups the sidebar; this task edits only these two sections, so the two waves do not conflict — W07 runs in batch 1 and lands first.)
- [ ] Release-notes line. PR body `Closes #<W05 sub-issue>`; the reversibility note from Task 1; the three guard suites green on the merged tree.

---

## W06 — Knowledge connector relabel (Sonnet)

PARALLEL GROUPS: Task 1 ∥ Task 2.

### Task 1: ee labels

**Files:**
- Modify: `ee/workspace/manifest.json:16-17` (`"label": "Wisp Sources"` → "Knowledge sources"; `"Wisp Dashboard"` → "Knowledge dashboard"; slot `"label": "Wisp"` → "Knowledge"), `ee/workspace/src/web/deviceIndex.ts:14,23,24`, `sourcesPage.ts:34,35`, `filingCard.ts:108` ("Workspace" → "Knowledge" / "Knowledge sources" as the sentence needs), their `.test.ts` files
- Test: `ee/workspace/src/web/*.test.ts` string assertions; add to `sourcesPage.test.ts`: `it('never says Workspace or Wisp Sources', …)` reading the three source files.

- [ ] **Step 1: Red.** - [ ] **Step 2: Implement (`manifest.name`, `routeNamespace`, table names, directory unchanged).** - [ ] **Step 3: `cd ee/workspace && npx vitest run` → PASS.** - [ ] **Step 4: Commit.**

### Task 2: Helper and settings note

**Files:**
- Modify: `apps/helper/src/lib/workspaceChatTools.ts:112` (`'Workspace is not connected.'` → `'Knowledge sources are not connected.'`; closes #10114), `apps/web/src/locales/*/settings.json` `aiModels.workspaceNote` → "Knowledge indexing uses your configured AI provider and appears in your AI usage."
- Test: the helper's `workspaceChatTools.test.ts` string; `localeParity`.

- [ ] Red → implement → green → commit. PR body `Closes #<W06 sub-issue>`, `Closes #10114`.

---

## W07 — Public docs information architecture (Sonnet)

PARALLEL GROUPS: G1 = Task 1 (new/renamed pages). G2 = Task 2 (sidebar). (The in-app "Learn about AI tasks" href is W02's; this wave only has to merge first.)

### Task 1: Pages

**Files:**
- Create: `apps/docs/src/content/docs/features/ai-tasks.mdx` (title "AI tasks"; body = the "AI Operator (preview)" sections lifted from `ai-agents.mdx` and `ai-computer-control.mdx`, rewritten with the §6 nouns: AI task, recipe, Library, "Start an AI task", "Handled by"; link to `wisp.mdx#specialists`), `features/breeze-ai.mdx` (title "Breeze AI"; body = the chat sections of `ai.mdx` lines 21–87 plus "Suggested fixes" and "Device context memory")
- Modify: `ai.mdx` → title "AI in Breeze" with the §4 one-sentence model and diagram, a short section per layer linking out; remove "Fleet Orchestration Brain" (fold the findings paragraph into `ai-agents.mdx` as "Findings"); `ai-agents.mdx` (remove the Operator section, link to `ai-tasks.mdx`); `index.mdx:93` card → title "AI in Breeze", description "Operators run Breeze. The workers do the work. Wisp runs your day."; `reference/api.mdx:1362` heading "AI Assistant" → "Breeze AI"; `features/mobile.mdx` (a Wisp paragraph: nudges, the thread screen, Hold to approve)
- Test: `cd apps/docs && pnpm build` (dead links fail the build).

- [ ] Build red on the new slugs → write → build green → commit.

### Task 2: Sidebar

**Files:**
- Modify: `apps/docs/astro.config.mjs:59-74,154-166` — remove `script-ai`, `ai-agents`, `ai-analysis-runs`, `wisp`, `ai-impact` from "Remote Management"; replace the "AI & Intelligence" group with one **AI** group in this order: `features/ai` (overview), `features/breeze-ai`, `features/wisp`, a sub-group **The workers** (`ai-agents`, `ai-analysis-runs`, `ai-tasks`, `ai-impact`, `fleet-hygiene`), a sub-group **Governance** (`approval-security` moved here from Security & Compliance, `bring-your-own-llm-key`, `tool-sources`, `ai-script-authoring`, `diagnostic-file-access`, `ai-usage-chargeback`), a sub-group **For other people** (`ai-for-office`, `mcp-server`, the Helper page), **Reference** (`ai-tools`, `script-ai`, `ml-insights`, `ai-computer-control`).
- Test: `pnpm build`; `rg -n "ai-tools|ai-usage-chargeback" apps/docs/astro.config.mjs` returns the two new lines.

- [ ] Red → implement → green → commit.

### Task 3: PR

- [ ] PR body `Closes #<W07 sub-issue>`; add `Closes #10115` only if the Wisp W00 migration-slot table is also corrected here (one line in `docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md`).

---

## W08 — Website glossary corrections (Sonnet; separate repo `LanternOps/breezermm-website`)

Branch `chore/glossary-product-corrections` in the website repo; PR there. The sub-issue in `breeze` is closed by that PR's merge (note the cross-repo PR link in the sub-issue).

### Task 1: Glossary and feature page

**Files:**
- Modify: `docs/glossary.md` — (a) **Workspace** row → "**Knowledge sources** — Wisp's knowledge connector in ee/: indexes files and email so Wisp can cite them. In-product label: Knowledge sources (Settings → AI). Not a working surface." and Rulings §1 reworded to match; (b) **The workers** row "In-product today" → "In the product: the **Workers** heading of the AI section of the sidebar (Agents, Runs, AI Tasks, Findings, Impact). There is no 'AI Brain' label."; (c) add a row **Breeze AI** — "The chat door to the workers, in the app and on mobile. Speaks as Wisp when the person has a Wisp grant. Write it as 'Breeze AI'; never 'the assistant'."; (d) **Specialist agents** row → "In the product they are **agents** (the roster under Workers); 'specialist agents' is the marketing gloss."; (e) add **AI task** — "A long-running, multi-step job the workers run from a recipe (restore a stopped service, offboard a person). Never 'Operator'."
- Modify: `src/content/features/ai-brain.md` body sentence "In the product, the workers live under Settings → AI Brain." → "In the product, the workers are the **Workers** heading of the AI section: Agents, Runs, AI Tasks, Findings and Impact."; stats row `Dashboard views` → drop or correct (verify against the app before publishing; if unverifiable, drop the row)
- Modify: `src/lib/claimsGuard.test.ts` — add forbidden `['AI Brain as a product label', /Settings → AI Brain/]` and confirm "Breeze AI" is not matched by any existing rule.
- Test: `npx vitest run src/lib/claimsGuard.test.ts`.

- [ ] Red (new rule) → edit → green → commit → PR in the website repo. Todd merges there (it is his site); the fixer stops at the open PR.

---

## Self-review (done at plan time, 2026-10-25)

- **Spec coverage.** §5 navigation → W04 (+W05 href). §6 vocabulary rows → W01 (chat, assistant, AI for Office, AI client), W02 (AI task, recipe), W03 (decide, spend, tiers, check), W06 (knowledge sources), W01 Task 3 (mobile). §7 chat door → W05. §8 docs → W07 (+W05 Task 5 for the two sections it owns). §12 website → W08. §10 "what not to do" → Global Constraints (identifiers unchanged, lock not hide, no umbrella brand). Fleet Orchestration fold (§5) is realised as the **Findings** entry under Workers, not a tab on Runs: the findings feed is a queue, not a ledger, and the spec's goal was removing "orchestration/Brain" and the stray top slot. Fix memory / Fleet Design are reached from Agents and Runs (W04 Task 4).
- **Gaps accepted:** `settings:partnerAiBudgets` / `orgAiBudgetSettings` labels already say "budget"; `Budget and reach` stays (spec §6 says explain, not rename). `AiInitiatorChip` "AI agent" is a qualified agent and stays. Patch/PAM/quote Reject/Decline are different concepts and stay.
- **Type consistency:** `scanEnglishCatalogue(rules, allow)` and `VocabularyRule` are the same in W01–W03; `NavItem.kind` only in W04; `WISP_CHAT_PATH` is changed in W05 Task 3 and read by Task 4.
- **Proportion:** the copy tables are the deliverable, not transcripts; code steps give signatures and the one behaviour rule each.
