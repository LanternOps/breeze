---
tracking_issue: LanternOps/breeze#9786
spec_issue: LanternOps/breeze#9170
waves: [W1, W2, W3, W4]
status: approved (Gate B) — waves tracked on LanternOps/breeze#9786
---

# Partner settings: one save model and inheritance visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/settings/partner` one save model (one header Save that runs a save adapter for each persistence unit, plus autosave switches and list rows), a heading on every panel with a regrouped rail, and a per-field inheritance view: a badge, a one-line summary of what the org fleet resolves to, and an org drill-down. Together these replace the per-tab "enforced" banner.

**Architecture:** Four waves.

- **W1** restructures the page shell. The tab registry moves into its own module. Every panel gets a heading. Caller verification and Known guests become tabs, and Ticketing becomes a rail link.
- **W2** replaces the three persistence models with a save-unit registry. Unit state lives above the panels: the partners/me unit in a shell hook, the five self-contained units in one zustand store. The header becomes a status region.
- **W3** adds a shared field catalog (`packages/shared`), API bindings, and two partner-scope read routes. Counts come from set-based SQL aggregates (`COUNT(*) FILTER`), one query per org-source kind per tab, with no per-org loop. Only the ≤50 drill-down rows of a page are classified in memory. A real-RLS contract test runs the actual runtime resolvers and proves the SQL predicates agree with them.
- **W4** renders the badges, inline lines and drill-down from the W3 read model, removes `enforced`, and adds the ≥1920 px side panel.

**Tech Stack:** Astro + React islands, zustand, react-i18next (8 locales), Vitest + RTL, Playwright (`e2e-tests/`), Hono + Zod, Drizzle on PostgreSQL with forced RLS.

**Spec:** `docs/superpowers/specs/web-ui/2026-10-18-partner-settings-save-model-and-inheritance-spec.md`. Approved at Gate A on 2026-10-22, and all seven decisions are final:

1. One header Save that runs a save adapter per unit.
2. Counts and drill-down require `canManagePartnerWidePolicies`. Selected-access users see badges only.
3. `locked[]` stays as it is (follow-up filed).
4. The drill-down shows an allowlisted, non-secret value.
5. Known guests becomes its own tab under "Devices & agents".
6. The side panel appears at 1920 px.
7. The new rail group is named "Devices & agents".

Read the spec before any task. This plan cites its sections as §N.

## Wave map and order

| Wave | Branch (feature-lifecycle) | Content | Depends on | Rigor |
|---|---|---|---|---|
| W1 | `feature/9170-partner-settings/wave-<sub#>` | Tasks 1–7: tab registry, rail link kind, panel anatomy, new tabs, blurbs | — | medium |
| W3 | same pattern | Tasks 8–15: shared catalog, resolver cores, bindings, population, aggregation, routes, RLS/contract tests | — (runs in parallel with W1) | **full** (a new partner-scope read of org data) |
| W2 | same pattern | Tasks 16–26: save units, draft store, status line, adapters, control kinds, form/guard, Known guests `runAction`, fetch de-dup, Playwright | W1 | medium-high |
| W4 | same pattern | Tasks 27–32: inheritance fetch, badges, lines, drill-down and side panel, `enforced` removal | W1, W2, W3 (W3 **deployed**) | medium |

The dispatch brief lists these topics: "adapters/header Save → inheritance read API → drill-down UI → Known Guests tab → rail/registry". Each one maps onto the spec's order rather than being re-sequenced:

| Topic | Where it lands |
|---|---|
| rail/registry | W1 Tasks 1–2 |
| Known Guests tab | W1 Task 5 (the move) and W2 Task 24 (`runAction`) |
| adapters/header Save | W2 |
| read API | W3 |
| drill-down UI | W4 |

The spec fixes W1 before W2 so that W1 cannot add panel-local state that W2 would then have to lift (§8). See Gate B 1.

F1 (#9171, part 1) already merged as #9206: the rail is scrollable and sticky, and the banner aligns to the page container. F2 (the independent items of #9172) stays fast-track and is not part of this plan.

## Global Constraints

- **i18n:** every new or changed `en` key goes into all 8 dirs under `apps/web/src/locales/`: `de-DE en es-419 fr-CA fr-FR it-IT pt-BR tr-TR`. This is enforced by `apps/web/src/lib/i18n/localeParity.test.ts`. Translate the keys rather than copying English, because `translationCoverage.test.ts` caps exact-English duplicates per namespace. Remove a deleted key from all 8 locales in the same commit.
- **Mutations:** every POST/PUT/PATCH/DELETE goes through `runAction` (`apps/web/src/lib/runAction.ts`).
  - Add nothing to `runActionAllowlist.ts`.
  - Every new or newly guarded file that mutates joins `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`. Bump the pinned count at `:955` (247 on `520d3dade2`) by the number of files added, and append a comment line to the bump chain above it.
  - Caller catch pattern: `if (err instanceof ActionError && err.status === 401) return; if (!(err instanceof ActionError)) showToast(...)`.
- **Hash state:** use `window.location.hash` only. Canonical kebab-case hashes stay valid, and so do the legacy camelCase aliases and `#ai-models`. The new hashes are `#caller-verification` and `#known-guests`.
  - Never put a hash in `useState` initialisers: the `no-hash-in-usestate.test.ts` guard rejects it. The page keeps its SSR-safe `'company'` default plus the `hashchange` effect, which the guard accepts.
  - `#ticketing` keeps rendering a static panel and **never auto-redirects**. Browsers that cached the old 301 would loop (#7985).
- **Test ids:** every new control, badge, status line, drill-down row and rail link carries `data-testid` with the `partner-settings-` prefix:
  - `partner-settings-status`
  - `partner-settings-save`
  - `partner-settings-panel-heading`
  - `partner-settings-badge-<fieldId>`
  - `partner-settings-line-<fieldId>`
  - `partner-settings-drilldown`
  - `partner-settings-drilldown-row-<orgId>`
  - `partner-settings-tab-<key>` (already emitted)
- **Copy:** fixed meanings come from §5.4: *has its own value*, *overrides*, *shadowed*, *in effect*. Badge labels are "Locks orgs", "Locks orgs when enabled", "Org can override", "Org can override, up to {{limit}}" and "Partner-wide".
- **Public repo:** no customer names, hostnames, IPs or internal infra. A field without a verified runtime consumer defaults to `unclassified` (§5.2). Code, tests, commits and PR text never give a reason for any individual field's classification.
- **Tenancy (W3):**
  - Reads run in the request DB context (`withDbAccessContext`, set by `authMiddleware`). Never use a bare pool or `withSystemDbAccessContext` in the routes.
  - There is no migration, no new table and no persisted state (§11). If a task appears to need one, stop and return to the spec.
- **Rule 9:** each wave's PR body carries the Rule 9 table from "Rule 9 counts" below, restricted to the settings that PR touches.
- **File size:** `PartnerSettingsPage.tsx` is 849 lines. It must shrink in W1 and W2, never grow. New logic goes under `apps/web/src/components/settings/partnerSettings/`.
- **Commands:**
  - One web test: `cd apps/web && npx vitest run <path>`. The same form works for `apps/api` and `packages/shared`.
  - Integration test: `cd apps/api && npx vitest run --config vitest.integration.config.ts <file>`, run on a per-worktree stack.
  - Typecheck: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` in each touched package. Read the exit code, and never pipe the output to `tail`.
  - Never run `pnpm --filter … test -- --run`.

## Review Focus

1. **A selected-access partner user opens the page.** Badges render. Every count is replaced by "Org breakdown requires full partner access". The inheritance fetch 403 never shows an error toast, and the Save button reads as unavailable rather than failing on click. Tests: Task 27 `restricted state renders badges without counts` and Task 18 `save disabled without partner-wide access`.
2. **An unsaved draft on tab A while the user saves from tab B.** This is the #9170 comment: the PATCH carried an unsaved Company city while the user saved Security. Before the user clicks, the status line names every tab the Save will write, and each name links to its tab. Test: Task 18 `status lists every dirty tab before save`.
3. **An org with two Pushover channels, one of them with its own value.** It counts as one org in "has its own value". The drill-down lists both channels under that org. Test: Task 14 integration fixture `two-channel org counted once`.
4. **A secret field inside a drill-down.** The org's value never leaves the server. The row says "Set" or "Not set", and the response passes an `isSecretJsonPath` sweep. Test: Task 13 `no secret value in any response`.
5. **Trust Center revision conflict during a multi-unit Save.** The other units still save. The Trust Center tab keeps its dirty dot and its draft, and the panel offers "Reload theirs" / "Keep editing". Test: Task 21 `conflict keeps draft and offers reload`.

## Verified facts (re-checked on `main` `520d3dade2`, 2026-10-22)

| Fact | Where |
|---|---|
| Three save models are still mixed. Header Save is hidden on `selfSaving` tabs and replaced by `partnerSettingsPage.selfSaving`. Save gates only on `aiBudgetsValid`. | `PartnerSettingsPage.tsx:639-649` |
| `TabDef.enforced` and the blue banner (`partnerSettingsPage.enforcedDescription`) | `:115-116`, `:675-679` |
| Caller verification renders under Security | `:742-746`. Component `callerVerification/CallerVerificationPolicyForm.tsx:49` returns null when the flag is off (`:50`). `<form>` at `:121` (`cv-policy-form`), Save at `:199`. Flag hook `lib/useCallerVerificationEnabled.ts:9` |
| Known guests is rendered at the bottom of Regional and mutates with bare `fetchWithAuth` (POST `:55`, DELETE `:75`) | `PartnerRegionalTab.tsx:177`; `KnownGuestsSettings.tsx:32,55,75`; own `<h2>` at `:88` |
| The ML autosave no longer refetches the page. #9205 already fixed the §1.1 draft-wiping bug: `onSaved` patches `partner.settings.ml` | `PartnerSettingsPage.tsx:803` |
| The Save **gate** checks only `aiBudgetsValid`. The website is validated only inside `handleSave`. The maintenance window already shows an inline error (`PartnerDefaultsTab.tsx:28,85`) but does not gate Save. The lockout `confirm` runs in `handleSave` | `PartnerSettingsPage.tsx:452-468`, `:528-546`, `:644` |
| Only `beforeunload` guards navigation. The precedent for `astro:before-preparation` is `ScriptForm` | `:304-310`; `components/scripts/ScriptForm.tsx:370-387` |
| The rail is already sticky and scrollable (F1). Items are hash anchors only, with no `href` kind | `SettingsSectionNav.tsx:6-37,50-55,83` |
| In-card saves: Login page PUT `/partners/me/login-branding` (`LoginBrandingCard.tsx:78-87`); Trust Center `updateTrustPageTemplate` with `REVISION_MISMATCH` → `load()` discards the draft (`TrustTemplateSettings.tsx:99-124`); AI feature defaults PUT `/ai/models/assignments` (`aiModels/FeatureDefaultsCard.tsx:255`); AI data policy PUT `/partner/ai/data-policy`, autosaved on radio change and on blur (`PartnerAiDataPolicyCard.tsx:57,123,129-135`) | — |
| The dedicated-origin control is `role="switch"`, `data-testid="partner-network-proxy-dedicated-origin"`, and E2E asserts on `aria-checked` | `PartnerRemoteAccessTab.tsx:282-300`; `e2e-tests/tests/network-proxy-tunnel-origin.spec.ts:136-142` |
| The ML features card uses checkboxes. The autosave switch classes live in Modules | `PartnerMlFeaturesCard.tsx:82`; `PartnerModulesCard.tsx:289-308` |
| `AiBudgetThresholdsInput` reports valid on unmount | `AiBudgetThresholdsInput.tsx:50-52` |
| `PATCH /orgs/partners/me` gates on `canManagePartnerWidePolicies` → 403. GET needs only `requireOrgRead`. All `/partners/me*` routes sit above `/partners/:id` | `apps/api/src/routes/orgs.ts:1040,1095-1110,697,1433` |
| A sub-router mounted after `authMiddleware` | `orgs.ts:495-498` (`siteLocationRoutes`) |
| `canManagePartnerWidePolicies(auth)` returns `scope==='system' \|\| (partner && partnerOrgAccess==='all')`. System scope passes it, so `requireScope('partner')` is what excludes system | `services/partnerWideAccess.ts:25` |
| The web counterpart is `useAuthStore(s => s.user?.canManagePartnerWide) !== false` | `components/reports/ReportOwnerScopeField.tsx:39` |
| `getEffectiveOrgSettings` returns `{effective, locked}`, with categories `security, notifications, eventLogs, defaults, branding` plus `aiBudgets.*`. The pin and enrollment exemptions carry the comment "Do NOT 'fix' this back to a lock without a per-field enforcement flag" | `services/effectiveSettings.ts:16-30,138,234`; `routes/orgs.ts:2644-2660` |
| Pure resolvers: `resolveEnrollmentDefaults` (`packages/shared/src/validators/enrollmentDefaults.ts:165`), `resolveAiApprovalTimeout` (`validators/aiApprovalSettings.ts:63`), `resolveInheritedAgentVersionPins` (`validators/agentVersionPins.ts:132`), `applyPartnerPushoverDefaults` + `readPartnerPushoverDefaults` (`services/partnerPushoverDefaults.ts:32,54`), `resolveDocumentBrand` (`services/partnerDocumentBrand.ts:53`) | — |
| DB-bound resolvers: `getOrgForwardingConfig` (partner destination only when `enabled && elasticsearchUrl`; `services/logForwarding.ts:48,71`), `getEffectiveAiBudget` (`effectiveSettings.ts:332`; `AI_BUDGET_DEFAULTS` is a non-exported const at `:55`), `getOrgAgentUpdateConfig` (`routes/agents/helpers.ts:3076`) | — |
| Org list for a partner user: `inArray(accessibleOrgIds)` + `notQuickSupport` + `isNull(deletedAt)`, with no status filter. Suspended orgs are already outside `accessibleOrgIds` (#2879) | `orgs.ts:1744`, partner branch ≈`:1800-1850`; `middleware/auth.ts:406` |
| Secrets: `maskSettingsSecrets` (`services/settingsSecretMasking.ts:102`); `isSecretJsonPath(path, secretPaths?)` (`services/encryptedColumnTransform.ts:127`) | — |
| Org sources: `ai_budgets` (`db/schema/ai.ts:225`, one row per org); `portal_branding` (`db/schema/portal.ts:18`); `notification_channel_configs.config` jsonb (`db/schema/alerts.ts:307`, parent `notification_channels :257`) | — |
| MCP coverage map keyed by route filename. An exemption looks like `{ exempt: 'tool_in_later_wave', note: '… (#NNNN).' }` and the note must carry an issue reference | `services/mcpCoverage.ts:7-213,406`; `__tests__/mcp-coverage.test.ts` |
| `packages/shared` has no `settings/` dir. The barrel is `src/index.ts`, guarded by `browserSafeBarrel.test.ts`. Settings types live in `src/types/index.ts:646-830` | — |
| Org settings tabs are hash-addressed at `/settings/organizations/<id>#<hash>` (`security`, `ai`, `remote-access`, `event-logs`, `notifications`, `branding`, `general`, …) | `components/settings/OrgSettingsPage.tsx:60-112` |
| The a11y test covers 6 tabs. `settingsPageRegistry.test.ts` checks reachability of `pages/settings/**/*.astro` and does **not** cover partner tabs. Neither W1 nor W4 adds a page, so it needs no change, but run it in every wave | `PartnerSettingsTabs.a11y.test.tsx`; `lib/__tests__/settingsPageRegistry.test.ts` |
| A generic drawer exists. There is no generic badge or tooltip component | `components/shared/Drawer.tsx:30,53`; `components/shared/HelpTooltip.tsx` |

## Rule 9 counts (settings rule 9; copy the touched rows into each PR)

"Places configured" counts the editing surfaces per level, as partner places + org places.

| Setting | Home after | Level | Resolver | Places before → after | Wave |
|---|---|---|---|---|---|
| Caller verification policy | Partner settings › Security › **Caller verification** tab | partner default → org override | `callerVerification` policy resolver (unchanged) | 1 + 1 → 1 + 1 (moved, not duplicated) | W1 (move), W2 (adapter) |
| Known guests (MAC list) | Partner settings › Devices & agents › **Known guests** | partner-wide | none (list) | 1 → 1 (moved off Regional) | W1, W2 |
| Ticketing settings | `/settings/ticketing` (unchanged). The partner rail now shows a link, not a tab | partner → org | unchanged | 1 + 1 → 1 + 1 (the partner tab was never a config place) | W1 |
| Dedicated tunnel origin | Remote access (unchanged), switch → checkbox | partner-wide | `TUNNEL_ORIGIN_PARTNER_DEFAULT` path (unchanged) | 1 → 1 | W2 |
| AI data policy default | AI features (unchanged), autosave → header Save | partner default → org | AI data-policy resolver (unchanged) | 1 + 1 → 1 + 1 | W2 |
| AI feature model defaults | AI providers & models (unchanged), in-card → header Save | partner → org | model registry (unchanged) | 1 + 1 → 1 + 1 | W2 |
| Login page, Trust center template | Branding group (unchanged), in-card → header Save | partner (login); partner → org (trust) | unchanged | 1 → 1; 1 + 1 → 1 + 1 | W2 |
| ML feature defaults | AI features (unchanged), checkbox → switch | partner default → org | unchanged | 1 + 1 → 1 + 1 | W2 |
| Every badged partners/me field (Defaults, Event logs, Security, Notifications, AI budgets, AI approvals, Branding, Remote access, Regional) | unchanged | per catalog | the runtime resolver named in its catalog entry | unchanged. The drill-down is read-only and links to the org's own tab (§5.7) | W4 |

---

## W1: structure (web only)

### Task 1: Tab registry module with the new rail map

**Files:**
- Create: `apps/web/src/components/settings/partnerSettings/tabRegistry.ts`
- Test: `apps/web/src/components/settings/partnerSettings/tabRegistry.test.ts`
- Modify: `PartnerSettingsPage.tsx:83-187` (delete the moved code, import from the registry)

**Interfaces:**
- Produces:
  ```ts
  export type TabKey = 'company'|'regional'|'modules'|'defaults'|'eventLogs'|'remoteAccess'|'knownGuests'|'security'|'callerVerification'|'notifications'|'emailTemplates'|'sendingDomains'|'ticketing'|'aiProvider'|'aiFeatures'|'aiBudgets'|'aiApprovals'|'branding'|'loginBranding'|'trustCenter';
  export type TabDef = { key: TabKey; hash: string; label: string; description: string; icon: LucideIcon; kind: 'panel'|'link'; href?: string; selfSaving?: boolean; enforced?: boolean };
  export const TAB_GROUPS: readonly { id: 'company'|'devices'|'security'|'communications'|'ai'|'branding'; label: string; tabs: readonly TabDef[] }[];
  export const ALL_TABS: readonly TabDef[];
  export const TAB_BY_KEY: Record<TabKey, TabDef>;
  export function tabFromHash(hash: string): TabKey | null;   // strips a leading '#'
  export function visibleTabGroups(v: { sendingDomains: boolean; callerVerification: boolean }): typeof TAB_GROUPS;
  ```
  `selfSaving` and `enforced` stay until W2 and W4 delete them.

- [ ] **Step 1: Write the failing tests**
  - `groups and order match spec §4.3`: the group ids are `['company','devices','security','communications','ai','branding']`, and the tab keys per group are exactly:
    - company: `company, regional, modules`
    - devices: `defaults, eventLogs, remoteAccess, knownGuests`
    - security: `security, callerVerification`
    - communications: `notifications, emailTemplates, sendingDomains, ticketing`
    - ai: `aiProvider, aiFeatures, aiBudgets, aiApprovals`
    - branding: `branding, loginBranding, trustCenter`
    - That is 20 entries.
  - `hash aliases`: `tabFromHash('#eventLogs')==='eventLogs'`, `tabFromHash('event-logs')==='eventLogs'`, `tabFromHash('ai-models')==='aiProvider'`, `tabFromHash('caller-verification')==='callerVerification'`, `tabFromHash('known-guests')==='knownGuests'`, `tabFromHash('ticketing')==='ticketing'`, and `tabFromHash('nope')===null`.
  - `ticketing is a link`: `TAB_BY_KEY.ticketing.kind==='link' && TAB_BY_KEY.ticketing.href==='/settings/ticketing'`. Every other tab has `kind==='panel'`.
  - `visibility`: `visibleTabGroups({sendingDomains:false, callerVerification:false})` omits `sendingDomains` and `callerVerification`. `tabFromHash` still resolves both.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/settings/partnerSettings/tabRegistry.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement the registry.**
  - Use the new group label keys `partnerSettingsPage.groups.devices` and `partnerSettingsPage.groups.ai`, added in Task 6.
  - Tab label keys are `partnerSettingsPage.tabs.<key>.label|description`.
  - Icons: `Building2`, `Globe`, `Blocks`, `SlidersHorizontal`, `ScrollText`, `MonitorSmartphone`, `Wifi` (Known guests), `Shield`, `PhoneCall` (Caller verification), `Bell`, `Mail`, `AtSign`, `Ticket`, `KeyRound`, `Activity`, `Wallet`, `Hourglass`, `Palette`, `LogIn`, `ShieldCheck`.
  - In the page, replace `getTabFromHash()` with `tabFromHash(window.location.hash)`.
- [ ] **Step 4: Run** the test again, then all `PartnerSettingsPage.*.test.tsx` files. Expected: PASS. Existing tests that assert old group membership are updated in this step, and the PR says which.
- [ ] **Step 5: Commit** `refactor(web): partner settings tab registry and Devices & agents / AI groups (#9170)`

### Task 2: `SettingsSectionNav` link items

**Files:** Modify `apps/web/src/components/settings/SettingsSectionNav.tsx`. Test `SettingsSectionNav.test.tsx`.

**Interfaces:**
- Produces: the item type gains `href?: string`.
  - When `href` is set, the desktop item renders `<a href={href} data-testid="${prefix}-tab-${key}">` with an `ExternalLink` icon (`aria-hidden`) and **no** `preventDefault`, so a normal navigation goes through the Astro router.
  - The mobile `<select>` option for that item navigates with `window.location.assign(href)` when chosen, and leaves the current selection unchanged.
  - A link item is never `aria-current` and never dirty.

- [ ] **Step 1: Write failing tests**
  - `link item renders a real href`: the item has `getAttribute('href')==='/settings/ticketing'`, clicking it does not call `onNavigate`, and an `ExternalLink` svg is present.
  - `select option for a link item assigns location`: spy on `window.location.assign` and expect it to be called with `/settings/ticketing`, and `onNavigate` not to be called.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/settings/SettingsSectionNav.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the item kind. Keep the existing sticky and `scrollIntoView` behaviour.
- [ ] **Step 4: Run** the test again, then `OrgSettingsPage` tests (the nav's other consumer). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): settings section nav link items (#9170)`

### Task 3: Panel anatomy, heading ladder and the a11y test across every tab

**Files:**
- Modify: `PartnerSettingsPage.tsx` (header, panel wrapper)
- Test: extend `PartnerSettingsTabs.a11y.test.tsx`

**Interfaces:**
- Produces: the shell renders the following for every `kind:'panel'` tab:
  ```
  <section aria-labelledby="partner-settings-panel-heading">
    <h2 id="partner-settings-panel-heading" data-testid="partner-settings-panel-heading" class="text-lg font-semibold">{label}</h2>
    <p class="text-sm text-muted-foreground max-w-prose">{description}</p>
    …
  </section>
  ```
  - The page `h1` becomes `text-2xl`.

- [ ] **Step 1: Write failing tests** in `PartnerSettingsTabs.a11y.test.tsx`. Mount the page with the existing fetch mocks and loop over every `ALL_TABS` key whose `kind==='panel'`. Mock `useCallerVerificationEnabled` → true and the sending-domains capability → supported. For each tab:
  - `heading order h1 → h2 → h3 for <tab>`: collect `h1..h6` in document order. Expect exactly one `h1`, then the first heading is an `h2` whose text equals the tab label, and no heading level is greater than the previous one + 1.
  - `every control has an accessible name on <tab>`: keep the existing helper.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/settings/PartnerSettingsTabs.a11y.test.tsx`. Expected: FAIL on the tabs without a heading (Security, Notifications, Event logs, Defaults, Branding, AI budgets, AI approvals) and on the tabs whose own `h2` duplicates the label.
- [ ] **Step 3: Implement** the shell heading. Task 4 fixes the child components. Keep this task's diff to the shell.
- [ ] **Step 4: Run** the test. Expected: it still FAILs, but only for the tabs Task 4 owns. Do **not** commit while it is red. Tasks 3 and 4 land as one commit, made at the end of Task 4.

### Task 4: Child panels: drop their own `h2`, flatten nested cards, cap helper width

**Files (modify):**
- `PartnerCompanyTab.tsx`
- `PartnerRegionalTab.tsx`
- `PartnerRemoteAccessTab.tsx`
- `PartnerModulesCard.tsx`
- `LoginBrandingCard.tsx`
- `aiModels/PartnerAiModelsTab.tsx`
- `KnownGuestsSettings.tsx`
- `PartnerNotificationsTab.tsx` (3 nested blocks)
- `PartnerDefaultsTab.tsx` (2)
- `PartnerBrandingTab.tsx` (1)
- `PartnerRemoteAccessTab.tsx` (3)
- `PartnerSecurityTab.tsx` (helper width)
- their co-located tests

**Rules (§4.1):**
- A top-level `<h2>` becomes `<h3 class="text-sm font-semibold">`, or is deleted if it repeats the panel label.
- A nested `rounded-lg border bg-muted/40` block becomes an `<h3>` section separated by `border-t pt-6`.
- `<p className="text-sm font-medium">` subsection titles become `h3`.
- Helper text gets `max-w-prose`.
- Radio option rows in Modules are exempt.

- [ ] **Step 1: Write a failing test** in the same a11y file: `no card inside a card on <tab>`. Query `section .rounded-lg.border .rounded-lg.border` and expect 0 matches. Exclude `[role="radiogroup"] *` and list rows (`[data-list-row]`).
- [ ] **Step 2: Run** the a11y test. Expected: FAIL on Notifications, Defaults, Branding, Remote access, and on the heading-order cases left over from Task 3.
- [ ] **Step 3: Implement** the per-file changes. Update any co-located test that queried `getByRole('heading', { level: 2 })` to level 3.
- [ ] **Step 4: Run** the a11y test plus every co-located test of the touched files. Expected: PASS.
- [ ] **Step 5: Commit** Tasks 3 and 4 together: `feat(web): partner settings panel headings, one heading ladder, no nested cards (#9170)`

### Task 5: Caller verification and Known guests tabs; Ticketing as a rail link

**Files:**
- Modify: `PartnerSettingsPage.tsx`, `PartnerRegionalTab.tsx` (remove `<KnownGuestsSettings />` and its import)
- Test: create `PartnerSettingsPage.tabs.test.tsx`; update `PartnerSettingsPage.ticketingLink.test.tsx`

**Interfaces:**
- Consumes: `visibleTabGroups`, `tabFromHash` (Task 1), the link item (Task 2), `useCallerVerificationEnabled()` (`lib/useCallerVerificationEnabled.ts:9`).
- Save mechanics are **unchanged** in W1. Caller verification keeps its in-card Save, and Known guests keeps its bare fetch until W2 Task 24. W1 adds no new panel state (§8).

- [ ] **Step 1: Write failing tests**
  - `#known-guests renders Known guests and Regional no longer does`.
  - `#caller-verification renders the policy form when the flag is on`.
  - `#caller-verification falls back to Security when the flag is off, after the flag settles`. Mirror the Sender addresses settle pattern at `PartnerSettingsPage.tsx:444-450`, and assert no fallback while the flag is still unresolved.
  - `Security no longer renders the caller verification form`.
  - `rail shows Ticketing as a link to /settings/ticketing`.
  - `#ticketing still renders the static link-out panel and does not navigate`: assert that `window.location.assign` and `navigateTo` are not called.
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `callerVerification: useCallerVerificationEnabled()` into `visibleTabGroups`. Render `PartnerCallerVerificationPolicy` for `activeTab==='callerVerification'` and `KnownGuestsSettings` for `'knownGuests'`. The `#ticketing` panel keeps `data-testid="partner-settings-ticketing-panel"`.
- [ ] **Step 4: Run** both files and `PartnerSettingsPage.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Caller verification and Known guests get their own partner tabs (#9170)`

### Task 6: Blurbs and locale keys

**Files:** `apps/web/src/locales/*/settings.json` (all 8). The `partnerSettingsPage` block starts at `en:1030`.

**Keys:**
- Add `groups.devices` = "Devices & agents".
- Add `groups.ai` = "AI".
- Add `tabs.callerVerification.label` = "Caller verification", with a description from the component's existing intro copy.
- Add `tabs.knownGuests.label` = "Known guests", with a description from `knownGuestsSettings`' existing intro.
- Change `tabs.eventLogs.description` → "Forward device event logs to Elasticsearch".
- Change `tabs.notifications.description` → "Sender address, SMTP, Slack and Pushover defaults".
- Re-check every other `tabs.*.description` against its tab's fields (§4.4).

- [ ] **Step 1: Write a failing test.** Add `blurbs match fields (§4.4)` to `tabRegistry.test.ts`. It loads `en/settings.json` and asserts that the eventLogs and notifications descriptions do not contain "retention" or "webhook", and that every `TabDef.label`/`description` key resolves to a non-empty string.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Add or translate** the keys in all 8 locales.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/lib/i18n src/components/settings/partnerSettings`. Expected: PASS, including `localeParity` and `translationCoverage`.
- [ ] **Step 5: Commit** `fix(web): partner settings rail blurbs match their fields (#9170)`

### Task 7: W1 verification and PR

- [ ] Run `cd apps/web && npx vitest run src/components/settings src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n`. Expected: all PASS.
- [ ] Typecheck `apps/web`. Expected: `exit=0`.
- [ ] Confirm `wc -l PartnerSettingsPage.tsx` is below 849.
- [ ] Open the PR with `Closes #<W1 sub-issue>`, `Refs #9170 #9169`. Include the Rule 9 rows (Caller verification, Known guests, Ticketing), a table of old → new blurb strings (§4.4), and the list of tests updated for the regroup.

---

## W3: inheritance read model (full rigor; runs in parallel with W1)

### Task 8: Shared catalog

**Files:**
- Create: `packages/shared/src/settings/partnerSettingsCatalog.ts`, `packages/shared/src/settings/index.ts`
- Modify: `packages/shared/src/index.ts` (`export * from './settings'`)
- Test: `packages/shared/src/settings/partnerSettingsCatalog.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CatalogTabKey = 'regional'|'defaults'|'eventLogs'|'remoteAccess'|'security'|'notifications'|'aiBudgets'|'aiApprovals'|'branding';
  export type FieldKind = 'locks'|'overridable'|'partnerOnly'|'unclassified';
  export type FieldQualifier = 'cap'|'conditional';
  export type ValueProjection = { kind: 'presence' } | { kind: 'number'; unit?: 'minutes'|'days'|'cents'|'percent' } | { kind: 'boolean' } | { kind: 'enum' } | { kind: 'color' } | { kind: 'version' };
  export interface CatalogEntry {
    id: string;                       // stable, e.g. 'defaults.enrollmentTtl'; never renamed once shipped
    tab: CatalogTabKey;
    paths: readonly string[];         // dot paths in partners.settings
    kind: FieldKind;
    qualifier?: FieldQualifier;
    capFieldId?: string;              // with qualifier 'cap'
    consumers?: readonly { id: string; labelKey: string }[];
    platformDefault?: unknown;        // re-exported from the owner, never copied
    secret: boolean;
    projection: ValueProjection;      // 'presence' whenever secret
    orgSettingsHash: string | null;   // OrgSettingsPage hash for the drill-down link
  }
  export const PARTNER_SETTINGS_CATALOG: readonly CatalogEntry[];
  export const CATALOG_BY_ID: Readonly<Record<string, CatalogEntry>>;
  export function catalogForTab(tab: CatalogTabKey): readonly CatalogEntry[];
  export const COUNT_TERMS: { ownValue: string; overrides: string; shadowed: string; inEffect: string }; // §5.4 definitions, doc strings
  export interface InheritanceCounts { ownValue: number; overrides: number | null; shadowed: number; clamped?: number }  // overrides null when the field is secret (see below)
  export interface InheritanceFieldDto { id: string; kind: FieldKind; qualifier?: FieldQualifier; partnerSet: boolean; inForce: boolean; platformDefault: unknown; counts: InheritanceCounts; byConsumer?: { consumerId: string; counts: InheritanceCounts }[] }
  export interface InheritanceTabDto { tab: CatalogTabKey; orgCount: number; fields: InheritanceFieldDto[] }
  export interface InheritanceOrgRowDto { orgId: string; orgName: string; ownValue: { set: boolean; value?: unknown }; inEffect: boolean; channels?: { channelId: string; name: string; ownValue: { set: boolean; value?: unknown } }[] }
  export interface InheritanceOrgPageDto { field: string; rows: InheritanceOrgRowDto[]; nextCursor: string | null }
  ```

**Classification inputs:**
- The spec's verified rows (§1.3, §4.3):
  - `security.requireMfa`, `security.sessionTimeout`, `defaults.agentUpdatePolicy`, `defaults.maintenanceWindow` and `aiBudgets.*` → `locks`.
  - `defaults.agentVersionPins`, `defaults.defaultEnrollmentTtlMinutes` (`qualifier:'cap'`, `capFieldId` → max TTL), `defaults.defaultEnrollmentDeviceCount` and `aiApprovals.interactiveTimeoutMinutes` → `overridable`.
  - `notifications.pushover*` → `overridable` (fill-blank).
  - `eventLogs` is **one group entry** with `kind:'locks'`, `qualifier:'conditional'`.
  - `remoteAccessProviders.*`, `networkProxy.dedicatedTunnelOrigin` and `defaults.maxEnrollmentLinkTtlMinutes` → `partnerOnly`.
  - `regional.timezone` and `regional.language` → `overridable`. The other Regional fields → `partnerOnly`.
- Branding fields whose consumers disagree (§5.2, reports vs documents) carry two `consumers` entries, or are `unclassified`.
- **Any field the W3 inventory cannot tie to a verified runtime consumer is `unclassified`.** The maintainer supplies that inventory before this step (Gate B 9). Do not record the reason for any field in code.
- **Secret fields never report `overrides`.** Encryption uses random IVs (`services/secretCrypto.ts:292`), so equal plaintexts do not compare equal as ciphertexts. A secret field's `counts.overrides` is therefore `null`, and its line says "N set their own" rather than "N override". `ownValue` and `shadowed` need no equality test, so they stay.
- **Completeness boundaries:**
  - Open-ended dictionaries (`preferences`, `types/index.ts:686`; `policyDefaults`, `:705`) are **one** entry each, covering the whole sub-object, not one entry per key.
  - Optional nested objects recurse.
  - Arrays (for example `alertThresholdPercents`) are leaves.
  - Regional `timezone`/`language`/`dateFormat`/`timeFormat`/`businessHours` sit on `PartnerSettings` itself (`:802`) and are covered explicitly.

- [ ] **Step 1: Write failing tests**
  - `every leaf of the settings types has an entry`: a typed map `const LEAVES = { security: {…}, notifications: {…}, eventLogs: {…}, defaults: {…}, branding: {…}, aiBudgets: {…}, aiApprovals: {…}, remoteAccessProviders: {…}, networkProxy: {…}, regional: {…} } satisfies { [K in keyof …]: Record<keyof Inheritable…Settings, true> }`. The test asserts that each leaf path appears in exactly one entry's `paths`. A new type field fails typecheck through `satisfies`.
  - `ids are unique and stable`: snapshot `PARTNER_SETTINGS_CATALOG.map(e => e.id)` with an inline snapshot. Renaming an id is a reviewed change.
  - `secret ⇒ presence`: `e.secret` implies `e.projection.kind==='presence'`.
  - `cap has a cap field`: `qualifier==='cap'` implies `CATALOG_BY_ID[e.capFieldId!]` exists.
  - `unclassified has no qualifier and no consumers`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/settings`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the entries. Import `platformDefault` values from their owners.
  - `AI_BUDGET_DEFAULTS` is a private const in a module that imports Node and DB code (`apps/api/src/services/effectiveSettings.ts:1,55`).
  - Move it to a browser-safe owner, `packages/shared/src/constants/aiBudgetDefaults.ts`. Import it back in `effectiveSettings.ts`, and delete the web copy at `apps/web/src/lib/aiBudget.ts:45`. Never copy it.
- [ ] **Step 4: Run** the tests, then `cd packages/shared && npx vitest run src/browserSafeBarrel.test.ts`, then typecheck shared, api and web. Expected: PASS, `exit=0` ×3.
- [ ] **Step 5: Commit** `feat(shared): partner settings field catalog (#9170)`

### Task 9: Pure resolver cores for the DB-bound resolvers

**Files:**
- Modify: `apps/api/src/services/logForwarding.ts`, `apps/api/src/services/effectiveSettings.ts`, `apps/api/src/routes/agents/helpers.ts`
- Tests: their existing co-located tests plus a new case each

**Interfaces:**
- Produces three functions. The existing async functions become thin loaders that call them, and their behaviour is unchanged:
  - `export function resolveForwardingDestination(partnerEventLogs: unknown, orgLogForwarding: unknown): { source: 'partner'|'org'|'none'; config: LogForwardingConfig|null }` in `logForwarding.ts`
  - `export function resolveEffectiveAiBudgetFromRows(partnerAiBudgets: unknown, orgRow: AiBudgetRow|null): EffectiveAiBudget` in `effectiveSettings.ts`
  - `export function resolveAgentUpdateConfig(partnerDefaults: unknown, orgDefaults: unknown): AgentUpdateConfig` in `helpers.ts`. If `helpers.ts` is a poor home, put it in a new `services/agentUpdateConfig.ts`. New services files need no `parkedFanout` classification, because they read no `devices`.

- [ ] **Step 1: Write failing tests**, one per core, over 4 fixtures each. For log forwarding the fixtures are: partner enabled with a URL; partner enabled without a URL (partial); partner disabled; neither.
  - Assert on the core's output directly. Then assert that the async wrapper, with its DB reads mocked to the same rows, returns the same result. Do not compare the core with itself.
  - Pin the distinctions the resolvers make:
    - A Pushover credential that is blank behaves differently from an undefined sound or priority (`partnerPushoverDefaults.ts:59`).
    - A partner AI-budget property that is present as `null` differs from an absent one (`effectiveSettings.ts:391`).
- [ ] **Step 2: Run** each file. Expected: FAIL (export missing).
- [ ] **Step 3: Extract** the cores. The async functions keep their signatures and **call** the cores, so the runtime and the read model share one implementation.
- [ ] **Step 4: Run** the existing resolver suites (`logForwarding*.test.ts`, `effectiveSettings.test.ts`, `routes/agents/*helpers*.test.ts`). Expected: PASS with no edits to existing assertions.
- [ ] **Step 5: Commit** `refactor(api): pure cores for log-forwarding, AI budget and agent-update resolvers (#9170)`

### Task 10: API bindings and classifier

**Files:**
- Create: `apps/api/src/services/partnerSettingsInheritance/bindings.ts`, `.../classify.ts`
- Tests: `bindings.test.ts`, `classify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type OrgSource =
    | { kind: 'orgSettings'; path: readonly string[] }            // organizations.settings #> path
    | { kind: 'aiBudgets'; column: keyof AiBudgetRow }
    | { kind: 'portalBranding'; column: keyof typeof portalBranding.$inferSelect }   // rendered via the Drizzle column object, never a string
    | { kind: 'pushoverChannels'; key: PushoverConfigKey }        // a literal union from partnerPushoverDefaults.ts; config ->> key per channel
    | null;
  export type Bucket = 'ownValue'|'overrides'|'shadowed'|'clamped';
  export interface FieldBinding {
    id: string; orgSource: OrgSource;
    project(raw: unknown): unknown;                                   // non-secret projection; undefined for presence-only
    hasOwnValue(raw: unknown): boolean;                               // TS mirror of the SQL own-value predicate
    bucketSql(bucket: Bucket, partnerValue: unknown): SQL | null;     // FILTER predicate for one count; null = not computable (secret overrides)
  }
  export const BINDINGS: Readonly<Record<string, FieldBinding>>;
  export interface OrgClassification { ownValue: boolean; overrides: boolean | null; shadowed: boolean; inEffect: boolean; clamped?: boolean }
  export function classifyOrg(entry: CatalogEntry, partnerSettings: unknown, orgRaw: unknown): OrgClassification;  // drill-down rows only
  export function fieldInForce(entry: CatalogEntry, partnerSettings: unknown): boolean;
  ```
- `bucketSql` is the **only** place a count predicate is defined. The aggregate uses it inside `COUNT(*) FILTER (WHERE …)`, and the drill-down applies it before keyset `LIMIT`.
  - The partner value is a bound parameter. Paths are literal arrays from the binding constants, never request input.
  - "Not set" means exactly what the resolver treats as unset, which can be the empty string, `null` or `[]`.
- `classifyOrg` labels the rows of one drill-down page (≤50). It calls the **runtime resolvers**: the shared pure resolvers plus the Task 9 cores, and never reimplements their precedence. Task 14 proves `bucketSql` and `classifyOrg` agree.

- [ ] **Step 1: Write failing tests**
  - `every catalog entry has a binding` and `no binding without a catalog entry`.
  - `secret fields project presence only`: for every `entry.secret`, `BINDINGS[id].project('s3cr3t')` is `undefined`.
  - `projection never returns a secret path`: walk every non-presence projection's output keys and expect `isSecretJsonPath([...entry.paths[0].split('.'), key])===false`.
  - `secret overrides is not computable`: `bucketSql('overrides', …)===null` for every secret entry.
  - `bucketSql compiles with bound parameters only`: `.toSQL().params` holds the partner value, and the SQL text contains no fixture string.
  - `every binding path segment and catalog id is a safe identifier`:
    - Every `orgSettings.path` segment, and every `pushoverChannels.key`, matches `/^[A-Za-z0-9_]+$/`.
    - Every catalog id matches `/^[A-Za-z0-9_.]+$/`.
    - JSON paths reach SQL only as a bound `text[]` (`settings #> $n::text[]`).
  - `classify` table tests, one row per §5.4 kind:
    - locks set + org has own value → `shadowed`
    - overridable set + org differs → `overrides`
    - overridable blank + org set → `ownValue && inEffect`
    - cap: org above the ceiling → `clamped`
    - conditional event logs, partner enabled without URL → `fieldInForce===false` and the org's destination `inEffect`
    - a blank org value counts as not set
- [ ] **Step 2: Run** both. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): partner settings inheritance bindings and classifier (#9170)`

### Task 11: Shared org-population predicate

**Files:**
- Create: `apps/api/src/services/partnerVisibleOrgs.ts`
- Modify: `routes/orgs.ts` partner branch of `GET /organizations` (≈`:1800-1850`) to call it
- Test: `services/partnerVisibleOrgs.test.ts`; existing `routes/orgs.test.ts` and `orgs.listQuery.test.ts` stay green

**Interfaces:**
- Produces: `export function partnerVisibleOrgConditions(accessibleOrgIds: readonly string[]): SQL[]`, returning `[inArray(organizations.id, ids), notQuickSupport, isNull(organizations.deletedAt)]`.
  - These are the **population** predicates of the list route's default partner branch (`orgs.ts:1811`). They exclude its search, archived opt-in and pagination.
  - `computeAccessibleOrgIds` already limits ids to active/trial, non-deleted orgs (`middleware/auth.ts:493`). That is the spec's "active or trial".
  - An empty `ids` returns a predicate that matches nothing (`sql\`false\``), never an unscoped query. The list route already fails closed this way, and the helper keeps it.

- [ ] **Step 1: Write failing tests**
  - `empty ids match nothing`: compile with Drizzle's `.toSQL()` and assert `false` is present.
  - `same predicates as the list route`: snapshot the SQL.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, and switch the list route to the helper.
- [ ] **Step 4: Run** the new test, `routes/orgs.test.ts` and `routes/orgs.listQuery.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(api): one partner-visible org predicate for the org list and inheritance reads (#9170)`

### Task 12: Aggregation and drill-down service

**Files:**
- Create: `apps/api/src/services/partnerSettingsInheritance/aggregate.ts`, `.../drilldown.ts`
- Tests: `aggregate.test.ts`, `drilldown.test.ts` (with a mocked `db`)

**Interfaces:**
- Produces:
  - `export async function aggregateTab(tab: CatalogTabKey, ctx: { partnerId: string; accessibleOrgIds: readonly string[] }): Promise<InheritanceTabDto>`
  - `export async function listFieldOrgs(fieldId: string, ctx: …, page: { bucket: Bucket; cursor: string|null; limit: number }): Promise<InheritanceOrgPageDto>`
- **Query budget:** one read of `partners.settings`, plus **one aggregate query per `OrgSource.kind` that the tab uses**:
  - `orgSettings`: `SELECT count(*) AS org_count, count(*) FILTER (WHERE <bucketSql>) AS c0, … FROM organizations WHERE <partnerVisibleOrgConditions>`.
    - Aliases are positional (`c0…cN`), mapped back to `(fieldId, bucket)` in TS, so no id ever reaches SQL text.
    - `ctx.accessibleOrgIds` is `string[]` here. `requireScope('partner')` guarantees it is non-null, and a `null` throws, which the route turns into a 500. It never means "all orgs".
  - `aiBudgets` / `portalBranding`: the same, over `organizations LEFT JOIN <table> USING org_id`, which has one row per org.
  - `pushoverChannels`: a CTE pre-aggregates `bool_or(<predicate>)` per org over `notification_channels ⋈ notification_channel_configs`, then counts orgs. A two-channel org counts once.
- There is no per-org loop, no per-org query and no `getEffectiveOrgSettings` call (§5.6). No query selects `organizations.settings` whole.
- **Drill-down:**
  - Population = visible orgs ∧ `bucketSql(bucket)` (default `ownValue`), applied **before** keyset `LIMIT`.
  - Keyset pagination is `(lower(name), id) > ($1,$2)` with `ORDER BY lower(name), id LIMIT limit+1`.
  - The rows project only the binding's columns and paths. `classifyOrg` labels them in memory, and `project()` shapes each value. Secret fields return `{ set }` only.
  - The cursor is an opaque base64url of `[name,id]`, Zod-validated on decode.
- **Field and tab ids are looked up in `CATALOG_BY_ID` / `catalogForTab` and never interpolated.** Paths come only from bindings, as literal path arrays that the binding constants define.

- [ ] **Step 1: Write failing tests**
  - `issues ≤ 1 + distinct orgSource kinds queries for <tab>`: count `db.select`/`execute` calls on the mock, for each `CatalogTabKey`. The count must not grow with the number of orgs: run the mock with 1 org and with 500.
  - `never selects organizations.settings whole`: assert that no generated SQL string contains `"settings"` without `#>`.
  - `drilldown applies the bucket before LIMIT`.
  - `drilldown pages with a stable cursor and limit+1 lookahead`.
  - `unknown field throws InheritanceNotFound`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): partner settings inheritance aggregation (#9170)`

### Task 13: Routes, gate and MCP coverage entry

**Files:**
- Create: `apps/api/src/routes/partnerSettingsInheritance.ts`, `apps/api/src/routes/partnerSettingsInheritance.test.ts`
- Modify:
  - `routes/orgs.ts`: add `orgRoutes.route('/', partnerSettingsInheritanceRoutes)` immediately after `:498`, so it is mounted after `authMiddleware` and before `/partners/:id`.
  - `services/mcpCoverage.ts`: add `'partnerSettingsInheritance.ts': { exempt: 'tool_in_later_wave', note: 'Partner-settings inheritance read model (#9170 W3); read tool tracked in #9763.' }`.

**Interfaces:**
- Produces:
  - `GET /orgs/partners/me/settings-inheritance?tab=<CatalogTabKey>` → `{ data: InheritanceTabDto }`
  - `GET /orgs/partners/me/settings-inheritance/orgs?field=<id>&bucket=ownValue|overrides|shadowed|clamped&cursor=&limit=1..50` (defaults: bucket `ownValue`, limit 50) → `{ data: InheritanceOrgPageDto }`
- Middleware is attached **to each of the two endpoints**, never with `.use('*')`. The router is mounted at `/` inside `orgRoutes`, so a wildcard `use` would gate unrelated org and system routes. The `siteLocation.ts:31` precedent uses per-endpoint middleware. The chain:
  1. `requireScope('partner')`. This excludes system scope, which `canManagePartnerWidePolicies` alone would admit.
  2. `requirePartner`, then a local `requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action)`. The one in `orgs.ts:194` is file-local and not exported. `siteLocation.ts` follows the same pattern.
  3. An inline gate: `if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_READ_DENIED_MESSAGE, code: 'PARTNER_WIDE_REQUIRED' }, 403)`.
     - Add `PARTNER_WIDE_READ_DENIED_MESSAGE` to `services/partnerWideAccess.ts` next to the write message, which describes a write.
     - The code string matches what Trust Center already maps (`TrustTemplateSettings.tsx:112`).
  4. `zValidator('query', …)`, where `tab` is a `z.enum` built from `CatalogTabKey` and `field` is refined against `CATALOG_BY_ID`.
- `accessibleOrgIds` comes from the auth context (`computeAccessibleOrgIds` has already run in `authMiddleware`). Do not call it again.

- [ ] **Step 1: Write failing route tests**, using the `routes/ai_admin.test.ts:18` mock pattern:
  - `org token → 403`, `system scope → 403`, `selected-access partner → 403 PARTNER_WIDE_REQUIRED`, `full-access partner → 200 with InheritanceTabDto shape`.
  - `unknown tab → 400`, `unknown field → 400`, `limit 51 → 400`, `malformed cursor → 400`.
  - `no secret value in any response`: seed the mocked rows with **canaries** at every `secret` entry's org source: a plaintext string `CANARY-PLAIN-<id>` and a ciphertext-shaped string `enc:v1:CANARY-CT-<id>`.
    - Assert that neither substring appears anywhere in `JSON.stringify(response)`, for both routes and every bucket.
    - Also assert that every serialized key path satisfies `!isSecretJsonPath(path)`. `isSecretJsonPath` matches names only, and a value renamed to `value` would evade it; that is why the canaries come first.
  - `unrelated org routes are not gated`: `GET /orgs/organizations` as a selected-access partner still returns 200.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/partnerSettingsInheritance.test.ts src/__tests__/mcp-coverage.test.ts src/__tests__/routerAuthGate.contract.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `routes/orgs.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): partner settings inheritance read routes (#9170)`

### Task 14: Real-RLS integration and resolver contract

**Files:** Create `apps/api/src/__tests__/integration/partnerSettingsInheritance.integration.test.ts`. Model it on `aiPartnerWideSelect.integration.test.ts`.

**Fixtures:**
- Two partners, A and B. A has 5 orgs: active, trial, suspended, soft-deleted, and quick-support hidden. B has 2.
- Partner A settings set every verified catalog field.
- Org rows exercise:
  - a blank value
  - a partial Event Logs destination (enabled, no URL)
  - an enrollment TTL above the cap
  - one org with two Pushover channels, only one of which sets its own value
  - an `ai_budgets` row overriding one locked field
  - a `portal_branding` logo for the documents consumer

- [ ] **Step 1: Write failing tests**
  - `orgCount equals GET /orgs/organizations total for a full-access user of A`. Use the list's total, or walk every page. Call both routes through the app under the caller's real context.
  - `partner A never counts partner B's orgs`. Also run with a B token and assert disjoint `orgId`s in the drill-down.
  - `selected-access user → 403` under real auth.
  - `resolver contract`: for every visible org and every catalog field with a non-null `orgSource`, run the **actual** runtime resolver (`getOrgForwardingConfig`, `getEffectiveAiBudget`, `getOrgAgentUpdateConfig`, `resolveEnrollmentDefaults`, `resolveAiApprovalTimeout`, `applyPartnerPushoverDefaults`, `resolveDocumentBrand`). Assert that its in-effect source (partner vs org) equals the drill-down row's `inEffect`, and that the aggregate counts equal the per-org tallies.
  - `bucketSql agrees with classifyOrg`: for every field and bucket, the set of org ids from the aggregate's SQL predicate equals the set `classifyOrg` labels with that bucket, over all fixture rows.
  - `two-channel org counted once`.
- [ ] **Step 2: Run** on a per-worktree stack (`pnpm wt-stack up`; copy the root `.env` with the AI keys blanked; set `BREEZE_WORKSPACE_ENABLED=false` and a free `BREEZE_DOCKER_SUBNET`/`BREEZE_CADDY_IP`), then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerSettingsInheritance.integration.test.ts`. Expected: FAIL. Write this file **before** implementing Tasks 12–13. If they already exist, prove the red with a temporary WIP commit that reverts `aggregate.ts`, then drop it. Never use `git stash`: the stack is shared across worktrees.
- [ ] **Step 3: Fix** any classification the contract exposes **in `classify.ts` or the catalog, never in the resolvers** (§10: no runtime semantics change).
- [ ] **Step 4: Run.** Expected: PASS. Then run `pnpm wt-stack down`.
- [ ] **Step 5: Commit** `test(api): partner settings inheritance under real RLS + resolver contract (#9170)`

### Task 15: W3 verification and PR

- [ ] `cd apps/api && npx vitest run src/services/partnerSettingsInheritance src/routes/partnerSettingsInheritance.test.ts src/routes/orgs.test.ts src/routes/orgs.listQuery.test.ts src/services/effectiveSettings.test.ts src/__tests__/mcp-coverage.test.ts src/__tests__/routerAuthGate.contract.test.ts`
- [ ] `cd packages/shared && npx vitest run src/settings src/browserSafeBarrel.test.ts`
- [ ] Typecheck shared, api and web. Expected: `exit=0` ×3.
- [ ] Integration (Task 14) green on the stack, with the run output pasted into the PR.
- [ ] PR: `Closes #<W3 sub-issue>`, `Refs #9170 #9169`. Mark it **full rigor** (a new partner-scope read of org data). Include a query budget per tab, a gate table (org / system / selected / full), the secret-handling approach, and the MCP exemption with its issue.

---

## W2: save model (after W1)

### Task 16: Save-unit contract and sequential runner

**Files:** Create `apps/web/src/components/settings/partnerSettings/saveUnits.ts` with `saveUnits.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type SaveUnitId = 'partnersMe'|'callerVerification'|'loginBranding'|'trustCenter'|'aiFeatureDefaults'|'aiDataPolicy';
  export type SaveOutcome = { status: 'saved'; savedAt: number } | { status: 'failed' } | { status: 'conflict' } | { status: 'cancelled' };
  export type TabValidity = { isValid: boolean; invalidCount: number; firstInvalidFieldId: string|null };
  export interface SaveUnit { id: SaveUnitId; tabs: readonly TabKey[]; isDirty(): boolean; validity(): Partial<Record<TabKey, TabValidity>>; save(): Promise<SaveOutcome> }   // valid ⇔ every entry isValid
  export const UNIT_TABS: Record<SaveUnitId, readonly TabKey[]>;   // partnersMe → company, regional, defaults, eventLogs, remoteAccess, security, notifications, aiBudgets, aiApprovals, branding
  export function unitOrder(units: readonly SaveUnit[]): SaveUnit[];  // rail order: the earliest tab of each unit in ALL_TABS
  export async function runSaveUnits(units: readonly SaveUnit[]): Promise<Partial<Record<SaveUnitId, SaveOutcome>>>;
  ```
- `runSaveUnits` runs only units that are dirty **and** valid. It runs them sequentially and awaits each one. A failure does not stop or roll back later units. `cancelled` is used when the partners/me preflight confirm is declined.

- [ ] **Step 1: Write failing tests**
  - `runs dirty valid units sequentially in rail order`: record start and end order with deferred promises, and assert no overlap.
  - `skips clean and invalid units`.
  - `a failure does not stop later units`.
  - `retry re-runs only failed units`: the second call, after the saved units re-baseline, runs only the failed one.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/settings/partnerSettings/saveUnits.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): partner settings save-unit runner (#9170)`

### Task 17: Draft store for the self-contained units

**Files:** Create `partnerSettings/partnerSettingsDraftStore.ts` with `partnerSettingsDraftStore.test.ts`.

**Interfaces:**
- Produces a zustand store with one slice per non-partnersMe `SaveUnitId`:
  ```ts
  type Slice<T> = { status: 'idle'|'loading'|'ready'|'error'; baseline: T|null; draft: T|null; revision?: number; validity: { isValid: boolean; firstInvalidFieldId: string|null }; lastOutcome: SaveOutcome|null; savedAt: number|null };
  usePartnerSettingsDraftStore: { slices: Record<Exclude<SaveUnitId,'partnersMe'>, Slice<unknown>>;
    ensureLoaded<T>(id, loader: () => Promise<{ value: T; revision?: number }>): Promise<void>;  // once per page session
    setDraft<T>(id, next: T | ((prev: T) => T)): void;
    setValidity(id, v): void;
    rebaseline<T>(id, value: T, revision?: number): void;          // baseline = draft = value
    markOutcome(id, o: SaveOutcome): void;
    reloadFromServer(id): Promise<void>;                            // the conflict "Reload theirs"
    invalidate(id): void;                                           // next ensureLoaded refetches
    reset(): void }                                                 // on page unmount
  export function isSliceDirty(s: Slice<unknown>): boolean;          // stable JSON compare of draft vs baseline
  ```
- **Page-scoped and not persisted:** no `persist` middleware. `reset()` runs when `PartnerSettingsPage` unmounts and when `currentPartnerId` changes. A panel mounts and unmounts freely without losing its draft.
- "Load once" means de-duplicated initialisation: concurrent callers share one in-flight promise. A failure leaves `status:'error'`, so the panel's Retry calls `ensureLoaded` again. `reloadFromServer` and `invalidate(id)` force a fresh load. `aiFeatureDefaults` is invalidated after a model or connection mutation on the same tab, replacing the `onSaved={reload}` at `PartnerAiModelsTab.tsx:75`. `ConnectionsCard` and `ModelsCard` at `:73-74` keep `onChanged={reload}`, which now also calls `invalidate('aiFeatureDefaults')`.
- **Stale responses are dropped.** Each load and save captures `partnerId` plus a per-slice generation counter. A response for an older generation, or another partner, is ignored.
- **Edits during a save stay dirty.** `save()` snapshots the draft it sends, and on success `rebaseline` sets `baseline` to **that snapshot**, not the current draft.
- **Revision metadata is per unit.** Trust Center uses `revision: number`. AI feature defaults carries its per-row stamps (`FeatureDefaultsCard.tsx:160`) inside the slice value, and that unit maps a stamp conflict to `conflict` the same way Task 21 handles Trust Center.

- [ ] **Step 1: Write failing tests**
  - `ensureLoaded runs the loader once across remounts`.
  - `draft survives a consumer unmount`: render a consumer, `setDraft`, unmount, render again, and expect the draft to be preserved.
  - `rebaseline clears dirty`.
  - `an edit made while saving stays dirty after success`.
  - `a stale load for a previous partner is ignored`.
  - `ensureLoaded retries after an error`.
  - `reset clears all slices`, and `partner switch resets`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): partner settings draft store (#9170)`

### Task 18: partners/me unit, validity map and the header status region

**Files:**
- Create:
  - `partnerSettings/usePartnersMeUnit.ts`. It takes the form state, snapshot, baseline, the pure `buildPartnersMePayload` and `preflight` out of `PartnerSettingsPage.tsx:219-301,452-567`.
  - `partnerSettings/PartnerSettingsStatus.tsx`
- Modify: `PartnerSettingsPage.tsx`, `PartnerCompanyTab.tsx` (inline website error), `PartnerDefaultsTab.tsx` (already inline; the shell gate now reads from it), `AiBudgetThresholdsInput.tsx` + `PartnerAiBudgetsTab.tsx` (raw text lifted)
- Delete: the `selfSaving` field from `TabDef`, and `partnerSettingsPage.selfSaving` in all 8 locales
- Tests: `usePartnersMeUnit.test.ts`, `PartnerSettingsStatus.test.tsx`; update `PartnerSettingsPage.test.tsx`; keep the existing `runPartnerSave` test

**Interfaces:**
- Produces:
  - `export function buildPartnersMePayload(state: PartnersMeState): Record<string, unknown>`. The payload is byte-identical to today's `handleSave`, including `CLEARABLE_SECURITY_KEYS` nulls, the explicit-boolean-only `networkProxy`, the trimmed website and the `emailSignature` null.
  - `export function partnersMeValidity(state): Partial<Record<TabKey, TabValidity>>`. Website (`isHttpUrl`), id `partner-company-website`. Maintenance window (`isValidMaintenanceWindow`), id `partner-defaults-maintenance-window`. AI budget thresholds: raw text parses, id `partner-ai-budgets-thresholds`.
  - `usePartnersMeUnit(): { state; setters; unit: SaveUnit; dirtyTabs: Partial<Record<TabKey, boolean>>; load(): Promise<void> }`. `unit.save()` runs `preflight`, which holds the existing allowlist lockout confirm unchanged (decline → `cancelled`). It then calls `runPartnerSave`. On success it dispatches `PARTNER_SETTINGS_SAVED_EVENT` and re-baselines.
  - `<PartnerSettingsStatus state={…} onOpenTab={(key, fieldId?) => void} />`. It renders `role="status" aria-live="polite" data-testid="partner-settings-status"` with these states (copy keys under `partnerSettingsPage.status.*`):
    - `clean` — "All changes saved · {{time}}", or "All changes saved" when nothing has saved this session
    - `dirty` — "Unsaved changes in {{tabs}}.", each tab a link button
    - `invalid` — "Fix {{count}} field in {{tab}} to save." (plural keys)
    - `saving` — "Saving…"
    - `partial` — "Couldn't save {{tabs}}. Other changes saved."
    - `autosaved` — "Saved · {{time}}"
    - `autosaveFailed` — "Couldn't save — try again"
    - `readOnly` — "Saving needs full partner access"
- The header always shows the status line and `data-testid="partner-settings-save"`. Save is enabled iff some unit is dirty, every dirty unit is valid, the user can manage partner-wide (`useAuthStore(s => s.user?.canManagePartnerWide) !== false`), and nothing is saving.
- `AiBudgetThresholdsInput` loses its unmount-valid effect (`:50-52`). Its raw text becomes a controlled prop owned by the partners/me state (`aiBudgetsThresholdsRaw: string|null`), so an invalid draft survives a tab switch.
  - Validity is **derived** from the raw text on every render, using the same parser. Today the input clears invalidity while typing, and it consumes Enter (`AiBudgetThresholdsInput.tsx:123`).
  - Enter now submits the card's form (Task 23) instead of being swallowed.
- The partners/me unit follows Task 17's rules for edits during a save: it re-baselines to the snapshot it sent, and it drops a response that arrives after a partner switch.

- [ ] **Step 1: Write failing tests**
  - `payload unchanged`: build from a fixture state and deep-equal the payload the current `handleSave` sends. Capture it before refactoring by running the old code once and pasting the result as the fixture.
  - `invalid draft on one tab disables Save after switching tabs`: AI budgets thresholds `"50,abc"` → switch to `#company` → Save disabled, and the status reads `invalid` with an AI budgets link. Switching back shows `"50,abc"` with its inline error.
  - `invalid website shows inline error with aria-invalid/aria-describedby and blocks Save`.
  - `invalid maintenance window blocks Save`: the inline error already exists, and the gate is new.
- `usePartnersMeUnit.ts` issues the PATCH (through `runPartnerSave`), so it joins `no-silent-mutations` `TARGET_GLOBS` (+1).
  - `status lists every dirty tab before save` (#9170 comment): edit Company city and Security max sessions → the status text names both tabs, and clicking "Company" opens `#company`.
  - `invalid link focuses the first invalid field`.
  - `save disabled without partner-wide access`: `canManagePartnerWide:false` → disabled, with the `readOnly` line.
  - `status line is a polite live region`.
  - `selfSaving copy is gone on every tab`.
- [ ] **Step 2: Run** the new files plus `PartnerSettingsPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Delete `aiBudgetsValid`.
- [ ] **Step 4: Run** the same set plus `PartnerSettingsPage.mfaBanner.test.tsx` (the saved event) and `src/lib/i18n`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): partner settings header status region and validity map (#9170, #9172)`

### Task 19: Wire the header Save to the unit runner (partial failure)

**Files:**
- Modify: `PartnerSettingsPage.tsx`
- Create: `partnerSettings/usePartnerSettingsSave.ts`
- Test: `PartnerSettingsPage.saveUnits.test.tsx`

**Interfaces:**
- Produces: `usePartnerSettingsSave(units: SaveUnit[]): { save(): Promise<void>; saving: boolean; lastOutcomes; failedTabs: TabKey[] }`.
- It runs `runSaveUnits`. On `saved` it re-baselines **only** that unit. It shows one aggregate success toast when every run unit saved: `partnerSettingsPage.saved`, via `showToast`, because each request already went through `runAction` with `successMessage` suppressed. Error toasts stay per unit through `runAction`.
- Each adapter's `runAction` call passes the option that suppresses its success toast. If `runAction` has no such option, add `silentSuccess?: boolean` to `runAction` in this task, with a unit test in `lib/runAction.test.ts`.

- [ ] **Step 1: Write failing tests**
  - `partial success re-baselines only saved units`: partnersMe 200, loginBranding 500 → partners/me tabs clean, Login page still dirty, status `partial` names Login page.
  - `units run sequentially in rail order`: assert fetch call order with deferred responses.
  - `one aggregate success toast`.
  - `retry sends only the failed unit`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** this file plus `lib/runAction.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): one header Save runs every dirty save unit (#9170)`

### Task 20: Adapters for Caller verification and Login page

**Files:**
- Modify: `callerVerification/CallerVerificationPolicyForm.tsx` (partner variant only; the org variant keeps its own Save), `LoginBrandingCard.tsx`
- Create: `partnerSettings/units/callerVerificationUnit.ts`, `partnerSettings/units/loginBrandingUnit.ts`
- Tests: co-located unit tests; update `ContactsCard.callerVerification.test.tsx` only if it covers the partner variant

**Interfaces:**
- Each unit file exports `use<Name>Unit(): SaveUnit`. It reads and writes its slice in `partnerSettingsDraftStore`, and its loader uses the component's existing GET (`lib/api/callerVerification`; GET `/partners/me/login-branding`).
- The panel components take `{ draft, onChange, validity }` from the slice and render **no Save button**.
- `CallerVerificationPolicyForm`'s partner `<form>` becomes the card's form element, owned by Task 23. Do not nest it.
- `save()` calls the existing request through `runAction` (`putPolicy` already wraps it). Each new unit file joins `no-silent-mutations` `TARGET_GLOBS`.

- [ ] **Step 1: Write failing tests**
  - `no in-card Save on the partner caller verification tab` (`queryByTestId('cv-policy-save')` is null in partner mode).
  - `no in-card Save on Login page`.
  - `draft survives a tab switch`.
  - `header Save sends the existing request body`: snapshot the body.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the co-located tests plus `no-silent-mutations.test.ts` (count bumped by 2). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): caller verification and login page save through the header (#9170)`

### Task 21: Trust Center adapter with conflict handling

**Files:**
- Modify: `trustCenter/TrustTemplateSettings.tsx`
- Create: `partnerSettings/units/trustCenterUnit.ts`
- Test: `PartnerSettingsPage.trustCenter.test.tsx`, `TrustTemplateSettings` tests

**Interfaces:**
- The unit's `save()` sends `{ ...draft, introHtml, expectedRevision: slice.revision }`.
- On `ActionError` with `code==='REVISION_MISMATCH'` it returns `conflict`, keeps the draft, and **does not call `load()`**. This removes the draft discard at `:124`.
- The panel shows an inline notice, `data-testid="partner-settings-trust-conflict"`, with the buttons `Reload theirs` (`reloadFromServer`) and `Keep editing` (dismiss; the next Save resends with the stale revision, and the user is told it will conflict again until reloaded).
- `introTooLong` feeds `validity`.

- [ ] **Step 1: Write failing tests**
  - `conflict keeps draft and offers reload`: mock a 409 `REVISION_MISMATCH` → the draft field still holds the edit, the tab still has its dirty dot, and the notice is visible.
  - `Reload theirs replaces the draft with the server copy and clears dirty`.
  - `other units still save during a trust conflict`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `trustCenterUnit.ts` joins `no-silent-mutations` `TARGET_GLOBS` (+1).
- [ ] **Step 4: Run** plus `no-silent-mutations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): trust center template saves through the header and keeps drafts on conflict (#9170)`

### Task 22: AI feature-defaults and AI data-policy units

**Files:**
- Modify: `aiModels/FeatureDefaultsCard.tsx` (partner mount in `PartnerAiModelsTab.tsx:75`; any org mount keeps its Save), `PartnerAiDataPolicyCard.tsx`
- Create: `partnerSettings/units/aiFeatureDefaultsUnit.ts`, `partnerSettings/units/aiDataPolicyUnit.ts`
- Tests: `FeatureDefaultsCard.test.tsx`, `PartnerAiDataPolicyCard.test.tsx`

**Interfaces:**
- The data-policy card stops autosaving. Radio changes and the retention-days input edit the draft, and the days input is validated inline (§3.4). The `reloadKey` reset on an invalid value (`:129-135`) is replaced by `validity`.
- Feature defaults loses its batch Save in partner mode. `onSaved={reload}` goes away there.

- [ ] **Step 1: Write failing tests**
  - `data policy radio change does not PUT`.
  - `retention days invalid blocks header Save with inline error`.
  - `feature defaults partner mode has no Save button`.
  - `header Save sends the existing PUT bodies`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both tests, `PartnerAiModelsTab.test.tsx` and `no-silent-mutations.test.ts` (+2). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): AI feature defaults and data policy save through the header (#9170)`

### Task 23: Control kinds, per-card `<form>` and the navigation guard

**Files:**
- Create: `partnerSettings/AutosaveSwitch.tsx`, extracted from `PartnerModulesCard.tsx:289-308` and reused there; `partnerSettings/FormCard.tsx`
- Modify: `PartnerRemoteAccessTab.tsx:282-300` (switch → `<input type="checkbox">`, same test id, label and help), `PartnerMlFeaturesCard.tsx:82` (checkbox → `AutosaveSwitch`), `PartnerSettingsPage.tsx` (guard), `e2e-tests/tests/network-proxy-tunnel-origin.spec.ts:136-142` (`aria-checked` → `toBeChecked()`)
- Tests: `PartnerRemoteAccessTab.networkProxy.test.tsx`, `PartnerMlFeaturesCard.test.tsx`; create `partnerSettings/FormCard.test.tsx` and `PartnerSettingsPage.navGuard.test.tsx`

**Interfaces:**
- `<AutosaveSwitch checked onChange disabled label describedBy testId />` renders `role="switch"`. The toggle-switch look is now reserved for autosave controls.
- **Autosave outcome channel (§3.1–3.2).**
  - The page exposes `reportAutosave(tab: TabKey, outcome: SaveOutcome)` through a small context. `PartnerMlFeaturesCard` and `PartnerModulesCard` call it after their `runAction` settles.
  - The status line shows `autosaved` or `autosaveFailed` for that tab when nothing else is dirty.
  - Both cards are optimistic: on failure they revert their own slice to the pre-toggle value.
- `<FormCard onSubmit>` renders `<form noValidate onSubmit={e => { e.preventDefault(); onSubmit(); }} class="rounded-lg border bg-card p-6">`. The shell wraps each form-kind panel body in it with `onSubmit={save}`. List and autosave cards are not wrapped, and drawers keep their own forms.
- The guard adds `document.addEventListener('astro:before-preparation', …)` next to `beforeunload` while any unit is dirty. It follows `ScriptForm.tsx:370-387`, and its confirm copy is `partnerSettingsPage.unsavedConfirm`.

- [ ] **Step 1: Write failing tests**
  - `dedicated origin is a checkbox and saves only on header Save`.
  - `ML features render as switches and autosave without touching other drafts`: edit Security first, toggle an ML switch, and assert the Security draft remains dirty and unchanged. This is the §11 acceptance test, kept even though #9205 fixed the refetch.
  - `autosave failure reverts and shows "Couldn't save — try again"`: the ML switch request returns 500 → the switch is back to its prior state and `partner-settings-status` holds the failure text.
  - `autosave success shows "Saved · <time>"`.
  - `Enter in a form card runs the header Save`.
  - `every <button> inside a FormCard has an explicit type`: render every form tab and query `form button:not([type])` → 0.
  - `astro:before-preparation is cancelled while dirty and confirm declined`.
  - `legacy and canonical hashes still resolve after W2`, for every alias in Task 1.
- [ ] **Step 2: Run** the files above. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `partnerSettingsPage.unsavedConfirm` in all 8 locales.
- [ ] **Step 4: Run** the files plus `src/lib/i18n`. Expected: PASS. The E2E edit is exercised in Task 26.
- [ ] **Step 5: Commit** `feat(web): partner settings control kinds, form submit and soft-navigation guard (#9170, #9172)`

### Task 24: Known guests via `runAction`

**Files:** Modify `KnownGuestsSettings.tsx:55,75`, `lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS` + count). Test: create `KnownGuestsSettings.test.tsx`.

- [ ] **Step 1: Write failing tests**
  - `add guest goes through runAction and toasts on failure`: mock a 500 and expect the toast to be called and no inline-only error.
  - `delete guest goes through runAction`.
  - The guard test, once the file is added to `TARGET_GLOBS` with the count +1.
- [ ] **Step 2: Run** both. Expected: FAIL. The guard flags bare `fetchWithAuth` mutations.
- [ ] **Step 3: Implement** with the CLAUDE.md caller catch pattern.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(web): known guests mutations go through runAction (#9170)`

### Task 25: Initial-load fetch de-duplication (measure first)

**Files:** decided by the measurement. Candidates are `PartnerSettingsPage.tsx`, `components/layout/Sidebar.tsx`, `components/auth/MfaPolicyOffBanner.tsx`, `AdminSessionManager`, `lib/api/callerVerification.ts`, and the `ai/models` reader.

- [ ] **Step 1: Measure.** In a **production build** (`pnpm --filter web build && pnpm --filter web preview`, or the wt-stack web container), load `/settings/partner#company` and record the request counts for `orgs/partners/me`, `partner/caller-verification-policy` and `ai/models` in the PR. Dev StrictMode doubles effects, so dev numbers do not count.
- [ ] **Step 2:** If a path is still fetched more than once, write a failing test: `partner settings mounts fetch partners/me once`. It renders the page with the layout islands it shares a document with and counts `fetchWithAuth` calls per URL. Otherwise record "no duplicate in prod build" and skip to Step 5.
- [ ] **Step 3: Implement** a shared in-flight promise cache in `lib/api/partnersMe.ts` (`getPartnersMe(): Promise<Partner>`, de-duplicating concurrent callers and invalidated by `PARTNER_SETTINGS_SAVED_EVENT`). Adopt it in the measured duplicate callers only.
- [ ] **Step 4: Run** the test plus the callers' tests. Expected: PASS.
- [ ] **Step 5: Commit** `perf(web): de-duplicate partner settings initial reads (#9172)`, or record the measurement-only result in the PR.

### Task 26: Playwright flows and the W2 PR

**Files:** Create `e2e-tests/tests/partner-settings-save-model.spec.ts`, using `data-testid` only.

- [ ] **Step 1: Write the flows**
  - `form via header Save`: edit Security max sessions, check the status names Security, click `partner-settings-save`, assert one PATCH `/api/v1/orgs/partners/me` with 200 and the status `clean`.
  - `autosave switch`: toggle an ML switch, assert a PATCH carrying only `settings.ml` and the status "Saved · …", and an unrelated Company draft still dirty.
  - `list row`: add and remove a Known guest, with toasts.
  - `status across tabs`: edit Company and Login page, check both are named, save, assert two requests in rail order.
- [ ] **Step 2: Run** against a wt-stack: `cd e2e-tests && npx playwright test tests/partner-settings-save-model.spec.ts tests/network-proxy-tunnel-origin.spec.ts`. Expected: FAIL on a pre-W2 build, PASS on this branch. Paste both outputs.
- [ ] **Step 3: Verification:** `cd apps/web && npx vitest run src/components/settings src/components/trustCenter src/components/callerVerification src/lib`, then typecheck web (`exit=0`).
- [ ] **Step 4: PR:** `Closes #<W2 sub-issue>`, `Refs #9170 #9169 #9172`. Include the Rule 9 rows, the `no-silent-mutations` count before → after, the Task 25 measurement, and the list of removed in-card Saves.

---

## W4: inheritance UI (after W1, W2 and a **deployed** W3)

### Task 27: Inheritance fetcher and per-tab cache

**Files:** Create `apps/web/src/lib/api/partnerSettingsInheritance.ts` and `partnerSettings/useTabInheritance.ts`, with tests. Modify `partnerSettings/usePartnerSettingsSave.ts` (Task 19) so it calls `invalidateInheritance` after each saved unit.

**Interfaces:**
- Produces:
  - `fetchTabInheritance(tab: CatalogTabKey): Promise<{ status: 'ok'; data: InheritanceTabDto } | { status: 'restricted' } | { status: 'unavailable' }>`. 403 `PARTNER_WIDE_REQUIRED` → `restricted`. Any other failure → `unavailable`, logged with `console.warn` and never toasted, because this is a read.
  - `fetchFieldOrgs(field: string, cursor: string|null): Promise<InheritanceOrgPageDto>`.
  - `useTabInheritance(tab: CatalogTabKey | null)` caches per tab for the page session. The shell passes `isCatalogTab(activeTab) ? activeTab : null`.
  - `invalidateInheritance(tabs: readonly TabKey[])` is called by `usePartnerSettingsSave` (Task 19) after a successful unit save, for that unit's tabs. It drops the cache entries for `tabs.filter(isCatalogTab)`.
  - Add `export function isCatalogTab(k: string): k is CatalogTabKey` to the shared catalog (Task 8).
  - The fetchers use `skipOrgIdInjection: true` (the `lib/api/sendingDomains.ts` `NO_ORG` pattern).
- When `canManagePartnerWide === false`, the hook short-circuits to `restricted` and does not fetch.

- [ ] **Step 1: Write failing tests**
  - `restricted state renders badges without counts`: tested again in Task 29.
  - `caches per tab`, `invalidate refetches`.
  - `unavailable does not toast`.
  - `selected-access user never fetches`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): partner settings inheritance fetcher (#9169)`

### Task 28: Badge and legend

**Files:**
- Create: `partnerSettings/SettingBadge.tsx`, `partnerSettings/BadgeLegend.tsx`
- Modify: every badged field in `PartnerDefaultsTab`, `PartnerEventLogsTab` (one group badge), `PartnerSecurityTab`, `PartnerNotificationsTab`, `PartnerAiBudgetsTab`, `PartnerAiApprovalsTab`, `PartnerBrandingTab`, `PartnerRemoteAccessTab`, `PartnerRegionalTab`
- Delete the hint copy the badge replaces, in all locales:
  - `partnerDefaults.enrollment.ttlHint` / `deviceCountHint`: keep the first sentence, drop "Organizations can pick a different default for themselves."
  - `agentVersionPins.partnerDescription`: drop the override clause
  - the remote-access `networkProxy.help` override clause (`en/settings.json:1027`)
  - `partnerAiBudgets.overridesOrgTab`
  - `partnerAiApprovals.orgOverrideNote`
  - The ML card hints (`en:1040,1051`) stay, because autosave tabs carry no badge (§5.3).

**Interfaces:**
- `<SettingBadge fieldId={id} />` reads `CATALOG_BY_ID[id]`. It renders nothing for `unclassified`. Otherwise it renders a pill with `data-testid="partner-settings-badge-<id>"`, visible text, and a `HelpTooltip` explanation. The qualifier copy is `cap` → "Org can override, up to {{limit}}", with the limit taken from the cap field's saved value, and `conditional` → "Locks orgs when enabled".
- `<BadgeLegend tab>` renders only when the tab has at least one badged field.

- [ ] **Step 1: Write failing tests**
  - `badge text per kind and qualifier`, one row per §5.3 table row.
  - `unclassified renders no badge`.
  - `badge has a text equivalent`, added to the a11y file.
  - `deleted hints are gone`: the strings are absent from the rendered Defaults, Remote access, AI budgets and AI approvals tabs.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, including the locale deletions in all 8 locales.
- [ ] **Step 4: Run** plus `src/lib/i18n`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): per-field inheritance badges replace override hints (#9169)`

### Task 29: Inline effective-value line

**Files:**
- Create: `partnerSettings/inheritanceLineCopy.ts` (pure), `partnerSettings/InheritanceLine.tsx`
- Test: `inheritanceLineCopy.test.ts`, `InheritanceLine.test.tsx`

**Interfaces:**
- `inheritanceLineCopy(field: InheritanceFieldDto, orgCount: number, opts: { draftDirty: boolean; platformDefaultLabel: string|null }): { key: string; params: Record<string, string|number>; drill: 'ownValue'|'overrides'|'shadowed'|null }`.
- Keys live under `partnerSettingsPage.inheritance.*`. Their plural forms are `_one`/`_other` in every locale.
- `<InheritanceLine fieldId state>`:
  - Renders `data-testid="partner-settings-line-<id>"`.
  - The count is a button that opens the drill-down (Task 30).
  - In `restricted` state the line reads "Org breakdown requires full partner access".
  - In `unavailable` state it renders nothing (badge only, §11).
  - While `draftDirty`, it prefixes "Saved value: …".

- [ ] **Step 1: Write failing tests**, one per §5.4 table row, with the spec's example numbers:
  - locks set, 3 shadowed → "Applies to all 42 orgs · 3 had their own value"
  - locks blank → "Not set. 5 of 42 orgs set their own; the rest use the platform default (480 min)."
  - overridable set → "Default for 42 orgs · 4 override"
  - overridable blank → "Not set. Orgs use the platform default (7 days) · 4 set their own"
  - conditional not in force → "Not in force (destination disabled). Orgs use their own destination · 6 have one"
  - cap → "Default for 42 orgs · 4 override · 2 are clamped to your ceiling"
  - partnerOnly set and blank
  - Plus `draft shows Saved value prefix`, `restricted line`, `secret overridable field says "set their own", never "override"` (`counts.overrides===null`), and `byConsumer renders one clause per consumer` ("Reports: applies to all orgs · Documents: 3 orgs use their own logo").
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, adding the keys in all 8 locales.
- [ ] **Step 4: Run** plus `src/lib/i18n`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): inline effective-value line under each partner setting (#9169)`

### Task 30: Drill-down drawer, ≥1920 side panel and tab summary

**Files:**
- Create: `partnerSettings/InheritanceDrilldown.tsx`, `partnerSettings/InheritanceSidePanel.tsx`
- Modify: `PartnerSettingsPage.tsx` (the third column)
- Tests: `InheritanceDrilldown.test.tsx`, `PartnerSettingsPage.layout.test.tsx`

**Interfaces:**
- `<InheritanceDrilldown fieldId onClose>` lists `fetchFieldOrgs` pages with "Load more".
  - Each row is `data-testid="partner-settings-drilldown-row-<orgId>"` and shows:
    - the org name, as a link to `/settings/organizations/<orgId>#<entry.orgSettingsHash>`, or with no hash when the hash is `null`
    - its own value: the projection, or "Set"/"Not set" for presence
    - "In effect" / "Not in effect"
  - Pushover rows nest their channels.
  - There is no edit affordance (§5.7).
- Layout:
  - Below `min-[1920px]` the drill-down is the shared `Drawer`, which becomes a full-height sheet below `lg`.
  - At `min-[1920px]` the page grid becomes `grid-cols-[240px_minmax(0,840px)_360px]`. The container widens from `max-w-6xl` to `min-[1920px]:max-w-[1500px]` and stays centred.
  - `<InheritanceSidePanel>` is sticky with its own scroll. It shows the selected field's drill-down, or with nothing selected the tab summary ("{{locks}} settings lock orgs · {{overridable}} can be overridden · {{differ}} orgs differ from your defaults"), with links that select the field.
  - The selected field is held in component state, not the hash: it is transient within a tab, and the tab hash stays canonical.
- The MFA banner placement from F1 stays aligned to the container at every width.

- [ ] **Step 1: Write failing tests**
  - `drill-down rows link to the org tab`.
  - `secret field shows Set/Not set only`.
  - `load more uses nextCursor`.
  - `below 1920 the count opens a drawer`; `at 1920 the side panel renders and the drawer does not`: mock `matchMedia('(min-width: 1920px)')`.
  - `no third column on tabs without catalog fields` (Company, Modules, list tabs).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add a `useMediaQuery('(min-width: 1920px)')` helper only if `lib/` lacks one (grep first).
- [ ] **Step 4: Run** plus the a11y file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): inheritance drill-down and wide-screen side panel (#9169, #9171)`

### Task 31: Remove the per-tab `enforced` flag

**Files:** `partnerSettings/tabRegistry.ts` (drop `enforced`), `PartnerSettingsPage.tsx` (banner), `partnerSettingsPage.enforcedDescription` in all 8 locales, and the tests that asserted the banner.

- [ ] **Step 1: Write a failing test** `no enforced banner on any tab`: for every tab, `queryByText` of the old English string is null, and `TabDef` has no `enforced` key (a type-level `@ts-expect-error` on `TAB_BY_KEY.defaults.enforced`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Remove** the flag, the banner and the key.
- [ ] **Step 4: Run** `src/components/settings` and `src/lib/i18n`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(web): drop the per-tab enforced banner for per-field badges (#9169)`

### Task 32: W4 verification and PR

- [ ] `cd apps/web && npx vitest run src/components/settings src/lib`, then typecheck web (`exit=0`).
- [ ] Playwright: extend `partner-settings-save-model.spec.ts` with `badge and line on Defaults` and `drill-down opens and links to an org`. Run it against a wt-stack that has W3 merged.
- [ ] PR: `Closes #<W4 sub-issue>`, `Refs #9169 #9171 #9170`. Include the Rule 9 row (badged fields: count unchanged), the deleted hint keys, and a before/after screenshot at 1440 and 2560 px. Merge only after W3 is deployed (§11).

---

## CI traps

- **`network-proxy-tunnel-origin.spec.ts` asserts `aria-checked`** on the dedicated-origin control. Task 23 must change it to `toBeChecked()` in the same PR, or the E2E job goes red.
- **The `no-silent-mutations` pinned count** changes in W2. Expected bumps: Task 18 +1, Task 20 +2, Task 21 +1, Task 22 +2 and Task 24 +1, which is +7. Task 26 states the final number. Each PR sets its own count from `main` at rebase time. Two W2 PRs in flight will conflict on `:955`, so rebase the second.
- **The integration suite runs only under Integration Tests, not Test API.** W3's Task 14 file is invisible to `pnpm test`, so run it on a wt-stack before the PR and paste the output. A stacked W3 PR (base ≠ main) gets no CI: `gh workflow run CI --ref <branch>`.
- **`mcp-coverage.test.ts`** fails on a new route file without an entry, and on an exemption note without an issue reference.
- **`routerAuthGate.contract.test.ts`** exercises `index.ts` mounts. The new router is mounted inside `orgRoutes` after `authMiddleware`, so it inherits the gate. Run the contract anyway.
- **`translationCoverage.test.ts`** fails on English copied into other locales. Translate every key.
- **`browserSafeBarrel.test.ts`** fails if the shared catalog imports a Node-only module. The catalog must stay pure.
- **`tsc | tail` hides a heap OOM.** Read `exit=`.
- **Route order:** never mount the inheritance router below `orgs.ts:1433`'s `/partners/:id` handlers.
- **Hash trap:** a `#caller-verification` deep link must not fall back before `useCallerVerificationEnabled` resolves, or the bookmark bounces to Security on every cold load.

## Gate B decisions (Todd; default in brackets)

1. **Wave order:** W1 ∥ W3 → W2 → W4, mapping the dispatch topic list onto it. *[Spec order.]*
2. **W2 draft lifetime:** the partners/me state moves to a shell hook, and the five self-contained units share one page-scoped, non-persisted zustand store. The alternative was to keep visited panels mounted with `hidden`. *[Store.]* It satisfies §3.3's "state lives above the panel" literally. The store resets on page unmount and on a partner switch, and it drops stale responses.
3. **W3 aggregation:** SQL `COUNT(*) FILTER` per field and bucket, one query per org-source kind. Only the ≤50 rows of a drill-down page are classified in memory. *[SQL aggregates.]* This is the spec's §5.6 shape. The draft plan had proposed classifying every org in memory; the quorum disagreed (see "Design quorum") and the plan follows the spec. Drift between the SQL and the resolvers is caught by Task 14's resolver-parity and bucket-agreement tests.
4. **Population:** reuse the `GET /orgs/organizations` partner-branch predicate through a shared helper. The spec's "active or trial" is how `accessibleOrgIds` already behaves, since suspended orgs are excluded upstream. *[Shared helper.]*
5. **MCP:** a `tool_in_later_wave` exemption pointing at #9763. *[Exemption.]*
6. **Route home:** a new `routes/partnerSettingsInheritance.ts` sub-router mounted inside `orgRoutes`. *[New file.]* `orgs.ts` is 3446 lines.
7. **`runAction` success-toast suppression** for multi-unit saves: add `silentSuccess` if no equivalent exists. *[Add.]*
8. **Fetch de-dup (Task 25):** measure in a production build first, and ship code only for duplicates that survive there. *[Measure-first.]*
9. **Unclassified inventory:** before Task 8 the maintainer gives the W3 executor the list of fields that cannot claim a verified consumer. Every field not in the spec's verified rows defaults to `unclassified` until it is classified. *[Default unclassified.]*
10. **Drill-down link target:** add `orgSettingsHash` per catalog entry and link to `/settings/organizations/<id>#<hash>`. *[Per-entry hash.]*
11. **Trust Center "Keep editing":** it keeps the stale revision, so the next Save conflicts again until the user reloads. The alternative is to auto-merge. *[Keep stale + explain.]* Merging the template is out of scope.
12. **`AI_BUDGET_DEFAULTS`:** move it to `packages/shared` and delete the web copy. *[Move.]* Rule 5 forbids copies.

## Design quorum (CLAUDE.md; `codex exec`, read-only, `xhigh`, 2026-10-22)

The author's positions on six choices went to an independent review. Results:

- **D-A draft store: agree with changes.** Folded into Tasks 17–18: page-scoped and non-persisted, de-duplicated load with retry, stale-response guard, re-baseline to the sent snapshot, per-unit revision metadata, and derived threshold validity with Enter.
- **D-B aggregation: disagree.** The draft classified every org in memory. That contradicts §5.6's "no per-org loop", and secret equality is not computable from ciphertext. **Resolved for the spec:** SQL `FILTER` aggregates with a single `bucketSql` source, in-memory classification for drill-down rows only, and `overrides: null` for secret fields (Tasks 8, 10, 12, 14).
- **D-C route and population: agree with changes.** Middleware is per endpoint, not `.use('*')`. The population predicate excludes search, archive and pagination, and `orgCount` is compared with the list total (Tasks 11, 13, 14).
- **D-D wave order: agree.**
- **D-E catalog: agree with changes.** Folded into Task 8: dictionary and array boundaries, Regional fields on `PartnerSettings`, a browser-safe owner for `AI_BUDGET_DEFAULTS`, and `byConsumer` and `clamped` defined before the DTO is frozen.
- **D-F traps.** Canary-based secret leak tests (Task 13) and wrapper-vs-core resolver tests (Task 9) are folded in.

No disagreement is left open.

## Follow-ups (not part of these waves)

- **#9762**, `locked[]` over-reporting (Decision 3): derive `getEffectiveOrgSettings().locked[]` from the catalog. This changes which org editor fields are disabled, and `OrgSettingsPage`'s pin signal. It needs its own review.
- **#9763**, MCP read tool for partner settings inheritance ("which orgs override this partner setting?"). Task 13's exemption note references it.
- **F2** (the independent items of #9172) stays on #9172 as fast-track.
- **Regional business-hours time-input labels** and **IP allowlist address-format handling** remain separate, per spec §10.
