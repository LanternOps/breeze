---
spec: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
orchestrator: docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md
wave: W08
tracking_issue: LanternOps/breeze#9906
---

# Wisp W08 — The Wisp Home (product surface, entity linking, partner switch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One page, `/wisp`, where a technician meets Wisp the way they meet Dots, Muse or Duet: the morning brief on top, "needs you" with approvals inline, the live activity feed, the persistent thread, the spend meter and pause control, memory one click away — and, unlike those products, every Breeze object a person works on (ticket, quote, invoice, contract, device, organization, site, alert, run, task, user) is a first-class link on the thread that Wisp can see and the user can add from the page or from the object itself.

**Architecture:** Nothing new runs a model. The home is a read-only composition of what W04–W07 already produce (`GET /wisp/home` is one aggregate query, grantor-only), plus one new table, `wisp_thread_links`, in the partner-anchored/org-optional shape with a soft entity reference and a cached label. Every read of a link re-derives tenancy from the entity (not from the row) and re-checks read permission, live ceiling and the caller's token scope, so a revoked org or a narrowed grant drops the link rather than leaking its cached label. The chat tools `link_entity` (T2 auto-approvable, like W05's `raise_concern`) and `list_links` (T1) share the same resolver, and links reach the model by handle through W04's session seed. The old multi-tab "AI Assistant" moves to `/wisp/chat` unchanged (store, persisted tabs and shortcuts intact); `/workspace` redirects. The `ee/workspace` connector is re-labelled "Wisp" in every user-visible string and nowhere else (quorum 2: `manifest.name`, `routeNamespace`, directory and `workspace_*` tables keep the `workspace` identity).

**Tech Stack:** Hono + Drizzle + hand-written SQL (API), Astro + React + Zustand + react-i18next (web), React Native + Expo (mobile, Vitest `.ts`-only), Zod in `@breeze/shared`, Lit custom elements in `ee/workspace/src/web` (connector pages).

**Spec:** §17 (product surface; quorum 2 verdicts), §5 (surfaces), §6.1 (4)–(5), §7.4, §8.2, §10, §14. Contracts come from w00 A28–A35 and "Routes (2026-10-23)"; where this plan and w00 disagree on a name, w00 wins.

## Execution split and parallelism (orchestrator, 2026-10-23)

W08 is split into three sub-issues that run **in parallel**:
- **W08a — Home API, links, partner switch** (sub-issue #9914, branch `feature/9906-wisp/wave-9914`): Tasks 1, 2, 3, 4, 5, 6, 7, 13. Owns `packages/shared`, `apps/api/**`.
- **W08b — Home web** (sub-issue #9921, branch `feature/9906-wisp/wave-9921`): Tasks 8, 9, 10, 14 (docs + e2e + PR body for the surface). Owns `apps/web/**`, `apps/docs/**`.
- **W08c — Mobile sections + connector relabel** (sub-issue #9922, branch `feature/9906-wisp/wave-9922`): Tasks 11, 12. Owns `apps/mobile/**`, `ee/workspace/**`, `packages/extension-sdk` reserved-namespace entry, `apps/api/src/extensions/builtinExtensions.ts` alias (the only API file W08c touches; W08a does not touch it).

PARALLEL GROUPS (W08a): G1 = Task 1 ∥ Task 2 ∥ Task 6-migration. G2 = Task 3. G3 = Task 4 ∥ Task 5 ∥ Task 6-service+route. G4 = Task 7. Task 13 last.
PARALLEL GROUPS (W08b): G1 = Task 8 (route move, nav, locales). G2 = Task 9-helpers (`wispHome.ts`, `wispEntityHref.ts`) ∥ Task 9-picker ∥ Task 9-panels (brief, needs-you, links) ∥ Task 10-button. G3 = Task 9-page composition ∥ Task 10-sidebar+detail-headers. Task 14 last.
PARALLEL GROUPS (W08c): Task 11 ∥ Task 12.
**Sonnet:** Task 8 locale fan-out + baseline edits + docsMapping/routeScope lines, Task 9 `wispEntityHref.ts` + brief card rendering, Task 11 (copy-only relabel), Task 12 pure helpers, Task 14 docs.
**Rules for every sub-issue and parallel group**
- Every part bases on `origin/main` and targets `main` (never a stacked PR). The w00 contracts are the oracle, so parts can be built against each other's interfaces before they merge; web/mobile tests mock the API.
- **Shared-package ownership:** the API part owns `packages/shared` additions. A web/mobile part that needs a type not yet on main copies the file **verbatim** from the API part's branch (`git show origin/feature/9906-wisp/wave-<api#>:<path>`) into the same path; whichever PR lands second rebases, and byte-identical files resolve cleanly. Never re-type a contract.
- **In-wave fan-out:** tasks inside one PARALLEL GROUP are file-disjoint and may run as concurrent subagents in the same worktree. Concurrent subagents never run `git commit`; the fixer commits once per group after all members pass. Groups run in the listed order.
- **Model routing:** the session and every tenancy/auth/permission/migration task are Opus. Tasks marked **Sonnet** are mechanical (locale fan-out, page scaffolds, pure helpers, docs, DTO plumbing) and run on Sonnet subagents with an Opus reviewer.
- The part that lands last owns the whole-wave verification task and the PR-body statement that covers both parts.

## Global Constraints

- **Dark by default.** Every new API path returns 404 when `wispEnabled()` (W02, `apps/api/src/config/env.ts`) is false; `/wisp` renders the same `FeatureLock` (W01) the thread page shows when the partner has no entitlement; `/wisp/chat` is the old page and works with the flag off exactly as `/workspace` does today.
- **No model call to render the home** (spec §17.2 anti-goal check). `GET /wisp/home` reads tables only. Brief sections come from the stored `user_notifications.metadata.brief` W06 Task 13 wrote. Nothing on the page widens a ceiling or satisfies an approval outside the existing approval-card components.
- **Tenancy ceremony** (`docs/agents/tenancy-rls.md`): `wisp_thread_links` ships RLS enable + force + policy in the creating migration, in the `connection_health_incidents` dual-axis shape (`2026-12-29-100100-connection-health-incidents.sql`); it is registered in `DUAL_AXIS_TENANT_TABLES`, `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` (`repoint`) and `CORE_TENANT_EXPORT_POLICY` (`label` is text and exported; no json columns). `org_id NULL` rows (partner-level kinds: `organization` with no org, `user`, partner-scoped `run`/`task`) are visible only to partner-scoped sessions.
- **Links are soft references** (`entity_id uuid` with no FK — ten target tables; a deleted entity resolves to `null` and the row is pruned on next read). Nothing in this wave adds a column to a core entity table.
- **Migration slots** `2027-01-04-100700-wisp-thread-links.sql` and `2027-01-04-100800-wisp-partner-settings.sql`. Re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing (newest on main at plan time: `2027-01-03-140000-report-type-client-profitability.sql`; W01–W07 occupy `100000`–`100600`). Idempotent; no inner `BEGIN;`/`COMMIT;`; a file that writes rows elects `SELECT set_config('breeze.scope','system',true);` first.
- **Status/kind columns are `text` + CHECK, never `pgEnum`.**
- **Chat tool tiers** (quorum 2): `link_entity` is a Tier-2 registry entry that auto-executes without a card (same posture as `raise_concern`, W05 Task 11b, and `remember`, W03) because it mutates durable thread context and plain Tier 1 bypasses agent allowlists (`aiGuardrails.ts:262-280`); `list_links` is Tier 1. Neither is ever available to a session without `wispGrant` (W04 Task 4 gate). No `z.undefined()` anywhere in a tool schema.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts:91`); every new web file with a mutating `fetchWithAuth` is added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:35`. URL state (selected concern, selected home section) lives in `window.location.hash`, never query params.
- **Locales**: every new `en` key lands in all 8 dirs (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); `localeParity.test.ts` (`apps/web/src/lib/i18n`) is run in every web task. A removed key (`titles.workspace`, `nav.aiAssistant`) must also leave `humanizedKeyBaseline.json` or CI fails on the stale entry. Mobile copy is inline strings.
- **Settings rule 9** (`docs/agents/settings.md`): this wave adds one setting, **Wisp enabled** — home: the Wisp card under Settings → AI Agents (where W06 Task 6 put the partner nudge settings); level: partner only, no org override, no document snapshot; resolver: `getPartnerSettings(partnerId).enabled` (default `true`); configured in 1 place before and after. The PR body states this.
- **Sibling-wave names (verified against the plans in this tree):** W02 `apps/api/src/routes/wisp.ts` (`wispRoutes`, carries `requireEntitlement('wisp')`, `requireScope('partner')`, `requirePermission(ai_sessions:use)`), `services/wisp/grants.ts` (`createGrant`, `pauseGrant`, `userPauseGrant`), `GrantCeiling.scopeOrgId`; W03 `routes/wisp/memory.ts`, `settings/wisp-memory.astro`; W04 `routes/wispThreads.ts` (`GET /thread`, `/thread/:id`, attachments), `services/wisp/sessionSeed.ts` `seedContextForSession`, `aiStore.ts` `wisp` slice with `enterWispMode`/`exitWispMode`, `components/ai/WispThreadHeader.tsx`, `WispGrantStepUpModal.tsx`; W05 `routes/wispConcerns.ts` (`GET /concerns?grantId&status`, snooze/dismiss/feedback), `services/wisp/concerns.ts` `listConcernsForCeiling`, `spendUnderGrant`, the assessment tick in `jobs/wispWakeScheduler.ts`; W06 `services/wisp/activity.ts` `listActivity`/`currentActivity`, `services/wisp/brief.ts`, `routes/wispNudges.ts` (preferences + `wisp_partner_nudge_settings`), `components/wisp/WispThreadPage.tsx`, `WispActivityPanel.tsx`, `wispThreadHash.ts`, mobile `WispThreadScreen.tsx`; W07 `services/wisp/coordinator.ts`. If a sibling landed under a different name, follow the landed name and note it in the PR body.
- **Tests**: `cd apps/api && npx vitest run <path>`; integration `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`; `cd apps/web && npx vitest run <path>`; `cd apps/mobile && npx vitest run <path>`; `cd packages/shared && npx vitest run <path>`; `cd ee/workspace && npx vitest run`. Never `pnpm --filter <pkg> test -- --run`.
- **Copy**: product name "Wisp"; identifiers `wisp_*` / `wisp*`; the word "workspace" never appears in a user-visible string after this wave.

## Review Focus

1. **A link whose entity the grantor can no longer read** (org removed from the grant revision, ticket moved to another org, user demoted) — `GET /wisp/home`, `GET /thread/:id/links`, the session seed and `list_links` all omit it; the row is deleted on the first read that fails resolution with `not_found`, kept on `forbidden` (the grant may widen again). Pinned in Task 4 (resolver re-check tests) and Task 13 (real-DB proof).
2. **An org-scoped session (`breeze.scope = 'org'`) on a thread that has `org_id IS NULL` links** — those rows are invisible by RLS *and* filtered by `scopeOrgId` in the resolver, so a UI that forgets one layer still shows nothing. Pinned in Task 1 (RLS integration) and Task 4.
3. **`link_entity` from chat with an `orgId` the model made up** — the resolver reads the entity first, takes `orgId` from the entity, then calls `assertWithinCeiling({ orgId })`; the model-supplied `orgId` is only a hint for the lookup and a mismatch is `not_found`. Pinned in Task 5.
4. **Persisted `breeze-workspace` tabs after the route move** — a user with five saved tabs opens `/wisp/chat` and sees all five; nothing in the store changes. Pinned in Task 8 (store test unchanged + page test at the new path).
5. **Partner switch off while a grant is mid-assessment** — the W05 tick pauses the grant with `partner_disabled` at the next floor tick, no run is killed, `createGrant` refuses immediately, re-enable resumes only grants paused with that reason. Pinned in Task 6.
6. **The home never calls a model.** `GET /wisp/home` has no import from `aiAgentSdk`, `aiAgent`, or `streamingSessionManager` (contract test). Pinned in Task 7.

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2027-01-04-100700-wisp-thread-links.sql` | `wisp_thread_links` + RLS |
| `apps/api/migrations/2027-01-04-100800-wisp-partner-settings.sql` | `ALTER TABLE wisp_partner_nudge_settings ADD COLUMN enabled` (one partner settings row; w00 A35 fold) |
| `apps/api/src/db/schema/wispThreadLinks.ts` | Drizzle `wispThreadLinks` |
| `packages/shared/src/types/wisp.ts`, `validators/wisp.ts` | `BreezeEntityRef`, `WISP_ENTITY_KINDS`, `WispThreadLink`, `WispHomePayload`, `linkEntitySchema`, `partnerSettingsSchema` |
| `apps/api/src/services/wisp/entityRefs.ts` | `resolveEntityRef` — per-kind read path, returns `{ orgId, label, status, href }` or a refusal |
| `apps/api/src/services/wisp/threadLinks.ts` | `addLink`, `removeLink`, `listLinks` (re-checking), cap 50 |
| `apps/api/src/services/wisp/partnerSettings.ts` | `getPartnerSettings`, `setPartnerEnabled`, `reconcilePartnerDisabled` |
| `apps/api/src/services/wisp/home.ts` | `buildHome(auth, grantId)` aggregate |
| `apps/api/src/routes/wispThreadLinks.ts`, `wispHome.ts`, `wispPartnerSettings.ts` | mounted under W02's `wispRoutes` |
| `apps/api/src/services/aiToolsWispLinks.ts` | chat tools `link_entity` (T2) and `list_links` (T1) |
| `apps/web/src/pages/wisp/index.astro`, `wisp/chat.astro`, `workspace.astro` (redirect) | pages |
| `apps/web/src/components/wisp/WispHomePage.tsx`, `WispBriefCard.tsx`, `WispNeedsYou.tsx`, `WispLinksPanel.tsx`, `WispEntityPicker.tsx`, `WispHomeThread.tsx`, `wispHome.ts`, `wispEntityHref.ts`, `WispLinkButton.tsx` | home UI and pure helpers |
| `apps/web/src/components/workspace/*` | unchanged; reached from `/wisp/chat` |
| `ee/workspace/manifest.json`, `ee/workspace/src/web/*.ts` | user-visible relabel only |
| `apps/mobile/src/screens/wisp/WispThreadScreen.tsx` + `wispHomeSections.ts` | brief sections, full activity, links list |

---

### Task 1: Migration, Drizzle schema and tenancy registration for `wisp_thread_links`

**Files:**
- Create: `apps/api/migrations/2027-01-04-100700-wisp-thread-links.sql`, `apps/api/src/db/schema/wispThreadLinks.ts`
- Modify: `apps/api/src/db/schema/index.ts` (after W04's `export * from './wispThreads';`), `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, before `wisp_threads`' dependents), `apps/api/src/services/orgMergeRegistry.ts` (`repoint`, beside `connection_health_incidents` at `:902`), `apps/api/src/services/tenantExportPolicy.ts` (`CORE_TENANT_EXPORT_POLICY`), `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES`)
- Test: `apps/api/src/__tests__/integration/wispThreadLinksRls.integration.test.ts`

**Interfaces:**
- Consumes: `wisp_threads(id, partner_id)` composite unique (W04), `organizations(id, partner_id)`, `users(id, partner_id)`, `wisp_grants(id)`.
- Produces: table `wisp_thread_links`; Drizzle `wispThreadLinks`.

| column | type |
|---|---|
| `id` | `uuid PRIMARY KEY DEFAULT gen_random_uuid()` |
| `thread_id` | `uuid NOT NULL REFERENCES wisp_threads(id) ON DELETE CASCADE` |
| `partner_id` | `uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE`; `FOREIGN KEY (thread_id, partner_id) REFERENCES wisp_threads(id, partner_id) ON DELETE CASCADE` |
| `org_id` | `uuid NULL`; `FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` |
| `entity_kind` | `text NOT NULL CHECK (entity_kind IN ('ticket','quote','invoice','contract','device','organization','site','alert','run','task','user'))` — constraint `wisp_thread_links_entity_kind_chk` |
| `entity_id` | `uuid NOT NULL` (soft) |
| `label` | `text NOT NULL CHECK (char_length(label) <= 200)` — a cache, never an authority |
| `added_by_user_id` | `uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE` |
| `added_by_grant_id` | `uuid NULL REFERENCES wisp_grants(id) ON DELETE SET NULL` — set when `link_entity` added it |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |

Indexes: `UNIQUE (thread_id, entity_kind, entity_id)` (`wisp_thread_links_thread_entity_uq`); `(thread_id, created_at DESC)`; `(org_id) WHERE org_id IS NOT NULL`; `(entity_kind, entity_id)` for the per-object "linked in Wisp" badge (Task 10).
Policy `wisp_thread_links_isolation FOR ALL USING/WITH CHECK (breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND breeze_has_org_access(org_id)) OR (org_id IS NULL AND breeze_has_partner_access(partner_id)))`.

- [ ] **Step 1: Write the failing integration test** (pattern: W04's `wispThreadsRls.integration.test.ts`): partner A's org-scoped context sees A's org rows and not A's `org_id IS NULL` rows; partner-scoped context sees both; partner B sees nothing; `INSERT` with a foreign `partner_id` fails `WITH CHECK`; org cascade deletes the org's rows and leaves the thread; org merge repoints `org_id`.
- [ ] **Step 2: Run** → FAIL (relation missing).
- [ ] **Step 3: Write the migration, schema, and the four registrations.** `grep -n wisp_thread_links apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicy.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` returns four hits.
- [ ] **Step 4: Run** the new suite plus `rls-coverage`, `orgCascade*.integration.test.ts`, `tenantExportPolicy*.test.ts`, `migrationRlsScope.test.ts`, then `pnpm db:check-drift` — PASS.
- [ ] **Step 5: Commit** — `feat(wisp): wisp_thread_links table (dual-axis RLS, cascade/merge/export registered) (W08 T1)`.

---

### Task 2: Shared types and validators

**Files:**
- Modify: `packages/shared/src/types/wisp.ts` (W02's file), `packages/shared/src/validators/wisp.ts`; tests beside them.

**Produces:**
```ts
export const WISP_ENTITY_KINDS = ['ticket','quote','invoice','contract','device','organization','site','alert','run','task','user'] as const;
export type WispEntityKind = typeof WISP_ENTITY_KINDS[number];
export type BreezeEntityRef = { kind: WispEntityKind; id: string; orgId: string | null };
export type WispThreadLink = { id: string; ref: BreezeEntityRef; label: string; status: string | null; href: string; addedBy: 'user' | 'wisp'; createdAt: string };
export type WispHomePayload = { thread: WispThread; grant: WispGrantSummary /* W02 + A32 spentTodayCents/budgetResetsAt + A29 pausedReason */; brief: { sentAt: string; sections: BriefSection[] } | null; needsYou: Concern[]; activity: { items: ActivityItem[]; nextCursor: string | null }; current: ActivityItem | null; links: WispThreadLink[]; partner: { enabled: boolean } };
export const linkEntitySchema = z.object({ kind: z.enum(WISP_ENTITY_KINDS), id: z.string().uuid(), orgId: z.string().uuid().nullable().optional(), label: z.string().max(200).optional() });
export const partnerSettingsSchema = z.object({ enabled: z.boolean() });
export const PARTNER_LEVEL_ENTITY_KINDS: ReadonlySet<WispEntityKind> = new Set(['user']);   // organization resolves to orgId = its own id
```
- [ ] **Step 1: Failing tests** — `linkEntitySchema` rejects an unknown kind and a non-uuid id; `label` over 200 fails; `WISP_ENTITY_KINDS` equals the migration CHECK list (a contract test reads the migration file and compares, as W05 does for concern kinds).
- [ ] **Step 2–4:** run → FAIL, implement, run — PASS. Commit `feat(shared): Wisp entity refs, thread link and home payload types (W08 T2)`.

---

### Task 3: `resolveEntityRef` — one read path per kind, tenancy from the entity

**Files:**
- Create: `apps/api/src/services/wisp/entityRefs.ts` (+ `entityRefs.test.ts`)

**Interfaces:**
```ts
export type ResolvedEntity = { ref: BreezeEntityRef; orgId: string | null; label: string; status: string | null; href: string };
export type ResolveFailure = { reason: 'not_found' | 'forbidden' | 'outside_ceiling' | 'outside_token_scope' };
export async function resolveEntityRef(ctx: { auth: AuthContext; ceiling: GrantCeiling }, ref: { kind: WispEntityKind; id: string }): Promise<ResolvedEntity | ResolveFailure>;
```
Behaviour, in order: (1) read the entity through its **existing** read helper inside the caller's DB context so RLS applies — `ticketService` (`getTicketById`-style with access), `quoteService`, `invoiceService`, `contractService`, devices via the aiTools device access helper (`aiTools.deviceGate` path), alerts via `findAlertWithAccess`, `organizations`/`sites` services, `ai_agent_runs` by id under `assertWithinCeiling`, operator tasks, `users` (same partner only); a miss or RLS-empty read is `not_found`. (2) take `orgId` **from the entity** (`organization` ⇒ its own id; `user` ⇒ `null`). (3) `requirePermission`-equivalent check for the kind's read permission on `auth` (`tickets:read`, `quotes:read`, `invoices:read`, `contracts:read`, `devices:read`, `organizations:read`, `alerts:read`, `ai_agents:read`, `users:read`) → `forbidden`. (4) `assertWithinCeiling(ceiling, { orgId })` → `outside_ceiling`; an `orgId === null` entity requires `ceiling.scopeOrgId === null`. (5) `auth.scope === 'org' && orgId !== auth.orgId` → `outside_token_scope`; an org-scoped token never resolves a `null`-org entity. `label` ≤ 200 chars from the entity's natural title (ticket `#1234 Subject`, quote `Q-0042 Org`, device hostname, …); `status` is the entity's own status string or `null`; `href` from `wispEntityHref(kind, id, orgId)` (shared with the web helper in Task 9: `/tickets/<id>`, `/quotes/<id>`, `/invoices/<id>`, `/contracts/<id>`, `/devices/<id>`, `/organizations/<id>`, `/organizations/<orgId>#site=<id>`, `/alerts#<id>`, `/ai-agents/runs/<id>`, `/ai/operator/tasks/<id>`, `/settings/users#<id>`).
- [ ] **Step 1: Failing tests** (mock each read helper): one happy path per kind asserting `orgId` comes from the entity even when the caller passes another; `forbidden` when the permission is missing; `outside_ceiling` for an org not in the ceiling; `outside_token_scope` for an org token on another org and on a `null`-org entity; `not_found` for an RLS-empty read; label truncation at 200.
- [ ] **Step 2–4:** run → FAIL, implement, run — PASS. Commit `feat(wisp): resolveEntityRef — tenancy from the entity, permission + ceiling + token-scope checks (W08 T3)`.

---

### Task 4: Thread links service and routes

**Files:**
- Create: `apps/api/src/services/wisp/threadLinks.ts` (+ test), `apps/api/src/routes/wispThreadLinks.ts` (+ test)
- Modify: W02's `routes/wisp.ts` — `wispRoutes.route('/thread', wispThreadLinksRoutes)` beside W04's thread router; `apps/api/src/services/auditLog.ts` action list (`wisp.thread.link_added`, `wisp.thread.link_removed`)

**Interfaces:**
```ts
export async function addLink(ctx, threadId: string, ref: { kind; id }, opts: { addedByGrantId?: string | null; label?: string }): Promise<WispThreadLink>;   // resolves first (Task 3); refusals map to 404 not_found / 403 forbidden|outside_ceiling|outside_token_scope; 409 link_limit at 50; idempotent on (thread, kind, id) — returns the existing row, refreshes label
export async function removeLink(ctx, threadId: string, linkId: string): Promise<void>;
export async function listLinks(ctx, threadId: string): Promise<WispThreadLink[]>;  // re-resolves every row; drops forbidden/outside_* silently; deletes not_found rows; refreshes stale labels in place
```
Routes (grantor-only via W04's `loadOwnThread` helper, existence-neutral 404): `GET /thread/:id/links` → `{ data: { links } }`; `POST /thread/:id/links { kind, id, orgId?, label? }` → 201 `{ data: { link } }`; `DELETE /thread/:id/links/:linkId` → 204. Audit both mutations with `{ threadId, kind, entityId }`.
- [ ] **Step 1: Failing tests** — service: cap at 50 → 409; idempotent re-add returns the same id; `listLinks` drops a now-forbidden link and deletes a now-missing one; routes: another user's thread → 404; schema failure → 400; mutations audited.
- [ ] **Step 2–4:** run → FAIL, implement, run — PASS. Commit `feat(wisp): thread links service + GET/POST/DELETE /wisp/thread/:id/links (W08 T4)`.

---

### Task 5: Chat tools `link_entity` (T2) and `list_links` (T1), and the session seed

**Files:**
- Create: `apps/api/src/services/aiToolsWispLinks.ts` (+ test) — registered beside W05 Task 11b's concern tools in the hub (`aiTools.ts`) under the same "only with `wispGrant`" gate
- Modify: `apps/api/src/services/aiGuardrails.ts` (`link_entity` in the Tier-2 auto-approvable set with rate limit `{ limit: 20, windowSeconds: 300 }`; `list_links` Tier 1 read allowlist), `apps/web/src/lib/tierConfig.ts` parity, `apps/api/src/services/aiTools.domainMetadata.contract.test.ts` domain entry (`wisp`), W04's `services/wisp/sessionSeed.ts`

**Interfaces:**
- `link_entity({ kind, id, orgId?, label? })` → `{ linked: true, link }` or `{ refused: 'not_found' | 'forbidden' | 'outside_ceiling' | 'link_limit' }` (never throws into the model; `outside_token_scope` cannot occur — Wisp sessions are partner-scoped). Calls `addLink` with `addedByGrantId = session.wispGrant.grantId`.
- `list_links({})` → `{ links: Array<{ kind, id, label, status, href }> }`.
- Seed: `seedContextForSession` appends after attachments: `Linked objects (by handle; call the object's own read tool for detail):` then one line per link `- ticket #1234 "Subject" (status open) id=<uuid> org=<orgId>`; capped at 50 lines / 4 KB; never the record body.
- [ ] **Step 1: Failing tests** — `link_entity` with a fabricated `orgId` links to the entity's real org; refusal shapes; rate limit; tools absent from a session without `wispGrant`; tier tables: `link_entity` ∈ Tier-2 auto set, `list_links` ∈ Tier-1 read allowlist, web parity test green; seed snapshot with two links and with none (section omitted).
- [ ] **Step 2–4:** run → FAIL, implement, run including `aiTools.*.contract.test.ts`, `aiGuardrailsTierParity` — PASS. Commit `feat(wisp): link_entity (T2) / list_links (T1) chat tools, links in the session seed by handle (W08 T5)`.

---

### Task 6: Partner enable switch

**Files:**
- Create: `apps/api/migrations/2027-01-04-100800-wisp-partner-settings.sql` (`ALTER TABLE wisp_partner_nudge_settings ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;`), `apps/api/src/services/wisp/partnerSettings.ts` (+ test), `apps/api/src/routes/wispPartnerSettings.ts` (+ test)
- Modify: W06's Drizzle `wispPartnerNudgeSettings` (+ `enabled`), W02's `services/wisp/grants.ts` `createGrant` (refuse `partner_disabled` 403 when `enabled === false`), W05's floor tick in `jobs/wispWakeScheduler.ts` (call `reconcilePartnerDisabled(partnerId)` before scheduling), W06 Task 6's partner settings card on Settings → AI Agents (the switch UI, `runAction`), W00 export policy classification for the new boolean (`open`)

**Interfaces:**
```ts
export async function getPartnerSettings(partnerId: string): Promise<{ enabled: boolean; /* W06 fields */ }>;   // default row when absent
export async function setPartnerEnabled(auth: AuthContext, enabled: boolean): Promise<void>;                      // canManagePartnerWidePolicies; audit wisp.partner.enabled_changed
export async function reconcilePartnerDisabled(partnerId: string): Promise<{ paused: number; resumed: number }>;   // disabled ⇒ pauseGrant(active, 'partner_disabled'); enabled ⇒ resume only grants with paused_reason = 'partner_disabled' (never user_paused, never entitlement_lost)
```
Routes: `GET /wisp/partner-settings` → `{ data: { enabled, …W06 fields } }` (any `ai_sessions:use` user); `PUT /wisp/partner-settings { enabled }` → 200 (partner admins only). Spec §17.2 (4): entitlement is commercial, this switch is governance, the deployment flag is the kill switch; the three never override each other.
- [ ] **Step 1: Failing tests** — `createGrant` 403 `partner_disabled`; reconcile pauses active grants with the right reason and leaves `user_paused` alone; re-enable resumes only `partner_disabled`; `PUT` 403 for a non-admin; web switch goes through `runAction`.
- [ ] **Step 2–4:** run → FAIL, implement, run (+ `migrationRlsScope.test.ts`, `pnpm db:check-drift`) — PASS. Commit `feat(wisp): partner enable switch — createGrant refusal, partner_disabled pause/resume reconcile, settings route + card (W08 T6, w00 A35)`.

---

### Task 7: `GET /wisp/home` — one read for first paint

**Files:**
- Create: `apps/api/src/services/wisp/home.ts` (+ `home.test.ts`), `apps/api/src/routes/wispHome.ts` (+ test), `apps/api/src/services/wisp/home.noModel.contract.test.ts`
- Modify: W02's `routes/wisp.ts` (mount `GET /home`)

**Interfaces:** `buildHome(auth, grantId): Promise<WispHomePayload>` — thread (W04 `getThreadForGrant`), grant summary with A32/A29 fields (W05 `spendUnderGrant`), brief = newest `user_notifications` row for the grantor with `metadata.grantId = grantId AND metadata.kind = 'brief'` from the last 36 h (`sections` from `metadata.brief`), `needsYou` = W05 `listConcernsForCeiling(status in open,snoozed)` ordered severity desc then `approvalIntentId IS NOT NULL` first, cap 50; `activity` = W06 `listActivity(limit 20)`; `current` = `currentActivity`; `links` = Task 4 `listLinks`; `partner` = Task 6. Route: `GET /wisp/home?grantId=` grantor-only, 404 existence-neutral; without `grantId` the caller's single active grant, 404 `no_grant` when none (the page then shows the start card).
- [ ] **Step 1: Failing tests** — payload shape with every section populated and with every section empty; another user's grant → 404; the contract test asserts `home.ts` and `wispHome.ts` import nothing from `aiAgentSdk`, `aiAgent`, `streamingSessionManager`, `@anthropic-ai/*`.
- [ ] **Step 2–4:** run → FAIL, implement, run — PASS. Commit `feat(wisp): GET /wisp/home aggregate (no model call) (W08 T7)`.

---

### Task 8: Web — routes move: `/wisp` home shell, `/wisp/chat`, `/workspace` redirect, nav and friends

**Files:**
- Create: `apps/web/src/pages/wisp/index.astro` (`titles.wisp`), `apps/web/src/pages/wisp/chat.astro` (renders the unchanged `WorkspacePage`, `titles.wispChat`)
- Modify: `apps/web/src/pages/workspace.astro` → `return Astro.redirect('/wisp', 301)` (keeps old bookmarks and the W06 bell links that predate this wave working); `apps/web/src/components/layout/Sidebar.tsx:294` — replace the `AI Assistant` item with `{ name: 'Wisp', labelKey: 'nav.wisp', href: '/wisp', icon: Sparkles, requiredPermission: { resource: 'ai_sessions', action: 'use' } }`; `Sidebar.nav.test.tsx:133` and `Sidebar.rbac.test.tsx:229` (`/workspace` → `/wisp`); `apps/web/src/lib/routeScope.ts:162` (`/^\/wisp(\/.*)?$/` `org-or-all`, keep the `/workspace` line for the redirect hop); `apps/web/src/layouts/DashboardLayout.astro:40` (`/wisp` accent); `packages/shared/src/utils/docsMapping.ts:246` (`/wisp` → `/features/ai/#wisp`, label `Wisp`; `/wisp/chat` → `/features/ai/`, label `AI chat`); locales ×8 `pages.json` (`titles.wisp` = "Wisp", `titles.wispChat` = "Wisp — chats"; remove `titles.workspace`), `common.json` (`nav.wisp` = "Wisp"; remove `nav.aiAssistant`), `humanizedKeyBaseline.json` (drop the two removed keys); `WorkspacePage.permissions.test.tsx:44` only if it asserts the route
- The `workspaceStore` (`breeze-workspace` persisted name, `workspaceStore.ts:684`) is **not touched**; `WorkspacePage.tsx` shortcuts keep working on `/wisp/chat`.
- [ ] **Step 1: Failing tests** — `Sidebar.nav.test.tsx` expects `/wisp` in the AI group where `/workspace` was; `Sidebar.rbac.test.tsx` gate unchanged; `routeScope.test.ts` classifies `/wisp` and `/wisp/chat` as `org-or-all`; `docsMapping.test.ts` resolves `/wisp`; `localeParity`; a new `pages/wisp.redirect.test.ts` is not possible for Astro — instead the E2E smoke in Task 14 opens `/workspace` and lands on `/wisp`.
- [ ] **Step 2–4:** run → FAIL, implement, run (`src/components/layout`, `src/lib/routeScope`, `src/lib/i18n`, `packages/shared` docsMapping) — PASS. Commit `feat(web): /wisp home shell, /wisp/chat keeps the multi-tab chat, /workspace redirects, nav "Wisp" (W08 T8)`.

---

### Task 9: Web — the home

**Files:**
- Create under `apps/web/src/components/wisp/`: `WispHomePage.tsx` (+ test), `WispBriefCard.tsx`, `WispNeedsYou.tsx` (+ test), `WispHomeThread.tsx`, `WispLinksPanel.tsx` (+ test), `WispEntityPicker.tsx` (+ test), `wispHome.ts` (+ test: `homeSectionFromHash`, `needsYouOrder`, `briefAge`, `emptyStateFor(payload)`), `wispEntityHref.ts` (+ test, mirrors Task 3's table)
- Modify: `no-silent-mutations.test.ts:35` `TARGET_GLOBS` += `WispHomePage.tsx`, `WispLinksPanel.tsx`, `WispNeedsYou.tsx`; locales ×8 `ai.json` `wisp.home.*` keys (brief, needsYou, activity, links, addLink, pickerSearch, openChats, memory, pause, resume, empty states, startWisp)

**Layout (desktop two columns, phone one):** left — `WispThreadHeader` (W04; spend meter + pause/resume from W06 Task 15), `WispBriefCard` (sections from `payload.brief`, "no brief yet" before the first one), `WispNeedsYou` (concern rows reusing W06 `WispThreadPage`'s row component with the approval card inline for `approvalIntentId` via the existing `AiApprovalDialog` intent path, snooze/dismiss/feedback buttons, hash-selected row expanded), `WispActivityPanel` (W06) with the live line; right — `WispHomeThread` (the Wisp session rendered inline: `AiChatMessages` + `AiChatInput` bound to the `aiStore` wisp slice exactly as `AiChatSidebar` binds them; mounting calls `enterWispMode(wispStateFromThreadPayload(payload))` when no wisp session is live, unmount leaves the session so the docked sidebar can continue it), `WispLinksPanel` (chips with `href`, status, remove ×, "Add" opens `WispEntityPicker`). Footer links: "Chats" → `/wisp/chat`, "Memory" → `/settings/wisp-memory` (W03). No grant ⇒ a single start card that opens `WispGrantStepUpModal` (W04); no entitlement ⇒ `FeatureLock` (W01); partner disabled ⇒ an explanatory card, no start button.
**Picker:** a kind tab row (Tickets, Quotes, Invoices, Contracts, Devices, Organizations, Sites, Alerts, Runs, Tasks, Users), a search box, results from each kind's **existing list endpoint** (`/tickets?search=`, `/quotes?search=`, `/invoices?search=`, `/contracts?search=`, `/devices?search=`, `/organizations?search=`, `/sites?search=`, `/alerts?search=`, `/ai-agents/runs?search=`, `/ai/operator/tasks?search=`, `/users?search=`) scoped by the page's org scope; selecting one `POST`s a link through `runAction`. The picker never hits a new search route.
- [ ] **Step 1: Failing tests** — `WispHomePage` renders the four states (no grant, locked, disabled, populated) from a mocked `/wisp/home`; `needsYouOrder` puts approvals first then severity; `WispLinksPanel` remove goes through `runAction` and an `ActionError` 401 is swallowed; `WispEntityPicker` calls the ticket list endpoint with `search` and posts `{ kind: 'ticket', id }`; `wispEntityHref` table; `homeSectionFromHash('#needs-you')`.
- [ ] **Step 2–4:** run → FAIL, implement, run (`src/components/wisp`, `src/lib/__tests__/no-silent-mutations.test.ts`, `localeParity`) — PASS. Commit `feat(web): Wisp home — brief, needs you, activity, inline thread, links + entity picker (W08 T9)`.

---

### Task 10: Web — "open in Wisp" and "Link to Wisp" from the objects

**Files:**
- Modify: `apps/web/src/components/ai/AiChatSidebar.tsx` (W04's Wisp mode header gains an "Open in Wisp" link to `/wisp`; the in-sidebar brief/concern list W04 drew is removed, the plain chat is untouched), `AiChatSidebar.test.tsx`
- Create: `apps/web/src/components/wisp/WispLinkButton.tsx` (+ test) — props `{ kind, id, orgId }`; hidden without an active grant (reads the `aiStore` wisp slice, falls back to `GET /wisp/thread`), posts the link through `runAction`, shows "Linked in Wisp" when `GET /thread/:id/links` already has it
- Modify: the detail headers of tickets (`TicketDetail*`), quotes, invoices, contracts, devices (`DeviceDetails.tsx` header actions) and organizations — one `WispLinkButton` each, `data-testid="wisp-link-button"`; `TARGET_GLOBS` += `WispLinkButton.tsx`
- [ ] **Step 1: Failing tests** — button hidden with no grant; posts the right ref from a ticket header; "Linked" state; sidebar shows the "Open in Wisp" link in Wisp mode and nothing in plain mode.
- [ ] **Step 2–4:** run → FAIL, implement, run — PASS. Commit `feat(web): Link-to-Wisp on tickets/quotes/invoices/contracts/devices/orgs; sidebar defers to the home (W08 T10)`.

---

### Task 11: Connector relabel and the reserved namespace

**Files:**
- Modify: `ee/workspace/manifest.json` (`navigation[].label` → "Wisp Sources" / "Wisp Dashboard"; `slots[].label` → "Wisp"; nothing else — `name`, `routeNamespace`, paths and tables unchanged), `ee/workspace/src/web/sourcesPage.ts`, `dashboard.ts`, `deviceIndex.ts`, `filingCard.ts` (user-visible strings "Workspace …" → "Wisp …"; class and API identifiers unchanged), their tests, `apps/docs` page for the connector
- Modify: `packages/extension-sdk/src/manifest.ts:29` `RESERVED_ROUTE_NAMESPACES` += `'wisp'` (+ the SDK's reserved-namespace test); `apps/api/src/extensions/builtinExtensions.ts:137` — accept an alias list `enableEnvAliases?: string[]` on `BuiltinExtension`, and register `['BREEZE_WISP_CONNECTOR_ENABLED']` for the workspace built-in so either name enables it (`builtinExtensions.test.ts:1039` extended, not replaced)
- **Not done here (w00 A35 refinement, quorum 2):** no directory, package, `manifest.name`, `routeNamespace` or table rename; no single flag for engine + connector — the connector needs the pgvector extension (`builtinExtensions.ts:239`) and the engine does not, so `BREEZE_WISP_ENABLED` must never imply the connector. Spec §17.2 and w00 A35 are corrected in the same commit as this plan.
- [ ] **Step 1: Failing tests** — `grep -rn "Workspace" ee/workspace/src/web/*.ts | grep -v "^.*class\|import\|Api"` returns no user-visible string; manifest schema rejects `routeNamespace: 'wisp'`; `isBuiltinEnabled` true under the alias.
- [ ] **Step 2–4:** run → FAIL, implement, run (`cd ee/workspace && npx vitest run`, `packages/extension-sdk`, `apps/api … builtinExtensions.test.ts`) — PASS. Commit `chore(wisp): connector relabelled "Wisp" (copy only), wisp reserved as a core namespace, connector flag alias (W08 T11)`.

---

### Task 12: Mobile — the thread screen grows the home sections

**Files:**
- Create: `apps/mobile/src/screens/wisp/wispHomeSections.ts` (+ test) — pure: `briefSectionsFromNotification(metadata)`, `linksForDisplay(links)`, `activityGroups(items)`
- Modify: W06's `WispThreadScreen.tsx` (brief card from the newest brief notification already in the in-app list; full activity timeline below the concern list via `GET /thread/:id/activity` with cursor paging; a read-only links list using `href` for deep links through the existing in-app router), W06's mobile `wispService.ts` (`getHome(grantId)` → `GET /wisp/home`, `listLinks`)
- [ ] **Step 1: Failing tests** — `briefSectionsFromNotification` tolerates a missing `brief` key; `activityGroups` buckets by local day; `linksForDisplay` sorts user-added first.
- [ ] **Step 2–4:** run → FAIL, implement, run — PASS. Commit `feat(mobile): Wisp thread screen — brief, full activity, links (W08 T12)`.

---

### Task 13: Integration proof — revocation drops a link everywhere; org token never sees partner-level links

**Files:**
- Create: `apps/api/src/__tests__/integration/wispThreadLinks.integration.test.ts` (real DB, `withDbAccessContext` for the request path, `withSystemDbAccessContext` for setup)
- [ ] **Step 1: Failing test** — seed partner, two orgs, a grant on both, a thread, links to a ticket in each org and a `user` link (`org_id NULL`). (a) Narrow the grant to org A (new revision): `listLinks`, `buildHome`, the session seed and `list_links` all return only org A's link and the user link; the org B row still exists. (b) Delete the org A ticket: next `listLinks` deletes the row. (c) An org-scoped context for org A: `SELECT` sees org A's row only; `resolveEntityRef` for the user link → `outside_token_scope`. (d) Revoke `tickets:read` from the grantor: ticket links disappear from the home, rows remain.
- [ ] **Step 2–4:** run → FAIL, (fix anything the unit tests missed), run — PASS. Commit `test(wisp): thread links — revocation, narrowing, org-token and deletion proofs on a real DB (W08 T13)`.

---

### Task 14: Docs, E2E smoke, PR body

- `apps/docs` → `/features/ai/#wisp` section: the home, links, partner switch, the chat page move; `update-breeze-docs` skill conventions.
- Playwright smoke (`apps/web/e2e/wisp-home.spec.ts`, `data-testid` only): `/workspace` lands on `/wisp`; with the flag on and a seeded grant the four home sections render; the picker links a seeded ticket and the chip appears; `/wisp/chat` shows the persisted tab.
- PR body: flag off = no behaviour change except the `/workspace` → `/wisp` redirect and the nav label; tenancy registrations added (`wisp_thread_links` ×4 registries + `DUAL_AXIS_TENANT_TABLES`); contracts consumed (A28–A35 names); settings rule-9 statement for **Wisp enabled**; the two w00 corrections (no single flag; connector identity unchanged).
- [ ] Commit `docs(wisp): home + links + partner switch; e2e smoke (W08 T14)`.

## Self-review notes

- Every link read path (Task 4 list, Task 5 tool + seed, Task 7 home, Task 12 mobile via Task 7) goes through `listLinks` → `resolveEntityRef`; there is no second code path that returns a cached label. Review Focus 1–3.
- The multi-tab chat moves, it is not rewritten; the store's persisted name and shape are untouched. Review Focus 4.
- `wisp_thread_links.org_id NULL` is the only new partner-level row kind; it reuses the W05 A30 shape so the RLS coverage test has a precedent to assert against.
- The connector keeps its technical identity and its own flag. The user-visible "fold in" is complete: one nav entry, one name, the connector's pages titled "Wisp …", and the engine reading the connector's index through `read_workspace_index` (spec §6.1 (5), W07 scope) once W07 lands.

## Calls made by the planner

1. **`/wisp/chat` keeps the multi-tab chat** instead of deleting it: the persisted-tab recovery quorum 2 flagged costs nothing this way, and plain non-Wisp chat still needs a full page. Reversible later by removing one page.
2. **Partner switch is a column on W06's `wisp_partner_nudge_settings`**, not a new table, honouring w00 A35's "folds into the same row" with the smallest migration; the Drizzle export keeps W06's name.
3. **No single flag for engine + connector** (corrects my 2026-10-23 recommendation Todd accepted): the connector requires pgvector and the engine does not, so one flag would make Wisp un-enableable on stacks without the extension (the wt-stack trap in memory). `BREEZE_WISP_ENABLED` = engine + home; `BREEZE_WORKSPACE_ENABLED` (alias `BREEZE_WISP_CONNECTOR_ENABLED`) = connector. Surfaced to Todd in the report.
4. **The picker uses existing list endpoints** rather than a unified search route: eleven list routes already carry the right permission gates and org scoping; a new cross-entity search route would be a second place to get tenancy wrong.
