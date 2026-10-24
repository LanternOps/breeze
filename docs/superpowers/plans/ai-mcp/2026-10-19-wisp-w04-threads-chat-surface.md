---
spec: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
orchestrator: docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md
wave: W04
tracking_issue: LanternOps/breeze#9906
---

# Wisp W04 — Threads and the Chat Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web AI chat panel a "Wisp" mode: turning Wisp on creates a grant with step-up proof, opens the durable thread for that grant, and every chat turn under it runs with the delegation ceiling asserted before every tool call (Tier 1 included), seeded with the thread summary and ceiling-filtered memory.

**Architecture:** Two new partner-axis tables (`wisp_threads`, one per grant; `wisp_thread_sessions`, the join to bounded `ai_sessions`) plus two nullable grant columns on `ai_sessions`. `POST /ai/sessions` accepts `wispGrantId`; a Wisp session carries `{ grantId, revisionId, threadId }` onto the live `ActiveSession`, and the single pre-tool choke point `createSessionPreToolUse` (which both `makeHandler` and `makeSessionAwareHandler` call) runs `resolveGrantCeiling` + `assertWithinCeiling` and narrows `toolAuth` before guardrails. The thread summary is updated deterministically when a session closes or expires. The web adds `WispToggle` (step-up modal → `createGrant` → thread opens), `WispThreadHeader`, and a locked state through `FeatureLock`.

**Tech Stack:** Hono + Zod routes, Drizzle (queries only; hand-written SQL migration), Vitest (API unit + integration under a test stack), React islands + Zustand + react-i18next, Playwright not used in this wave.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md` (§4.3 chat bullet, §5, §6, §10, §14). Names and signatures come from the orchestrator doc `2026-10-19-wisp-w00-wave-map-and-contracts.md` ("Threads (W04)" block, consumed W01/W02/W03 contracts); where this plan and w00 disagree on a name, w00 wins.

## Execution split and parallelism (orchestrator, 2026-10-23)

W04 is split into two sub-issues that run **in parallel**:
- **W04a — Threads API** (sub-issue #9910, branch `feature/9906-wisp/wave-9910`): Tasks 1, 2, 3, 4, 5, 6, 6b and the API half of Task 9. Owns `packages/shared` additions, `apps/api/**`, the `RESERVED_ROUTE_NAMESPACES` entry (`wisp`).
- **W04b — Chat surface (web)** (sub-issue #9916, branch `feature/9906-wisp/wave-9916`): Tasks 7, 8 and the web half of Task 9. Owns `apps/web/**` only. Builds against the w00 "Threads (W04)" route contracts with mocked `fetchWithAuth`.

PARALLEL GROUPS (W04a): G1 = Task 1. G2 = Task 2 ∥ Task 3 ∥ Task 6b-store (threads.ts, sessionGrant.ts + createSession, threadAttachments.ts). G3 = Task 4 ∥ Task 5 (SDK gate vs summary finalize — different files). G4 = Task 6 ∥ Task 6b-routes. Task 9-API last.
PARALLEL GROUPS (W04b): G1 = Task 7-store (`aiStore.ts` slice) ; G2 = Task 7-components ∥ Task 8 (`WispToggle`/`WispGrantStepUpModal` vs `WispThreadHeader`/sidebar). Task 9-web last.
**Sonnet:** Task 7 locale fan-out (8 dirs), `WispThreadAttachments.tsx` list rendering; W04a Task 9 PR body.
**Rules for every sub-issue and parallel group**
- Every part bases on `origin/main` and targets `main` (never a stacked PR). The w00 contracts are the oracle, so parts can be built against each other's interfaces before they merge; web/mobile tests mock the API.
- **Shared-package ownership:** the API part owns `packages/shared` additions. A web/mobile part that needs a type not yet on main copies the file **verbatim** from the API part's branch (`git show origin/feature/9906-wisp/wave-<api#>:<path>`) into the same path; whichever PR lands second rebases, and byte-identical files resolve cleanly. Never re-type a contract.
- **In-wave fan-out:** tasks inside one PARALLEL GROUP are file-disjoint and may run as concurrent subagents in the same worktree. Concurrent subagents never run `git commit`; the fixer commits once per group after all members pass. Groups run in the listed order.
- **Model routing:** the session and every tenancy/auth/permission/migration task are Opus. Tasks marked **Sonnet** are mechanical (locale fan-out, page scaffolds, pure helpers, docs, DTO plumbing) and run on Sonnet subagents with an Opus reviewer.
- The part that lands last owns the whole-wave verification task and the PR-body statement that covers both parts.

## Global Constraints

- **Dark by default.** Every new server path returns 404 when `wispEnabled()` (`apps/api/src/config/env.ts`, added by W02) is false; `createSession` refuses `wispGrantId` with `wisp_disabled` when off. Nothing changes for a session created without `wispGrantId`.
- **Entitlement is the commercial switch, never a kill-switch override.** `requireEntitlement('wisp')` (W01) on every `/api/v1/wisp/*` route; `hasEntitlement(partnerId, 'wisp')` inside `createSession` when `wispGrantId` is present. Entitled + flag off = 404.
- **Authority is structural.** Under a grant, every tool call — Tier 1 included — passes `resolveGrantCeiling(grantId, revisionId)` + `assertWithinCeiling(ceiling, check)` (W02) **before** `checkGuardrails`; the session's `toolAuth.accessibleOrgIds` is intersected with `ceiling.orgIds` for the call. No prompt text widens anything; the `user_session` principal stays (no synthetic user).
- **Tenancy ceremony.** RLS enable + force + policy in the creating migration; `wisp_threads` and `wisp_thread_sessions` are shape 3 (`breeze_has_partner_access(partner_id)`) in `PARTNER_TENANT_TABLES`; `wisp_thread_sessions` also carries `org_id`, so it is registered in `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical), `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY` (precedent: `migration_window_orgs`, migration `2026-12-25-120000-migration-windows.sql`). **`wisp_thread_attachments` (w00 A24) is shape 1** (`org_id NOT NULL`, `breeze_has_org_access(org_id)`, auto-discovered by rls-coverage — no `PARTNER_TENANT_TABLES` entry) with `partner_id` denormalised, and is registered in all three org registries. `wisp_threads.focus_org_id` is a nullable org pointer on a partner-axis table: composite deferrable FK, `ON DELETE SET NULL (focus_org_id)` (PG 15+ column-list form; the stack runs `pgvector/pgvector:pg16`). The two new `ai_sessions` columns get an export-policy classification. Composite FKs to `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`. Run org-cascade, export-policy and rls-coverage suites under a test stack before the PR.
- **Migration** `apps/api/migrations/2027-01-04-100300-wisp-threads.sql` (w00 slot). Re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing and bump if anything newer than `2027-01-04-100200-*` landed. Idempotent; no inner `BEGIN;`; it writes no rows, so no `set_config` is needed (say so in its header comment).
- **Status columns are `text` + CHECK**, never `pgEnum`.
- **No new AI tools in this wave** (the model-written summary tool is not W04), so the six tool registries are untouched.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`); every new file with a mutating `fetchWithAuth` is added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (a literal file list). Every new `en` key is added to all eight locale files (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/ai.json`); `localeParity.test.ts` enforces it.
- **Copy:** product name **Wisp**; identifiers `wisp_*` / `wisp*`. Locked copy: "Wisp is available on Pro and higher plans."
- **Tests:** Vitest beside source; run one file with `cd apps/api && npx vitest run <path>` / `cd apps/web && npx vitest run <path>`; never `pnpm --filter <pkg> test -- --run <path>`. Red first.
- **Session limits unchanged** (`SESSION_MAX_AGE_MS` 24 h, `SESSION_IDLE_TIMEOUT_MS` 2 h, `apps/api/src/services/aiAgentSessionLimits.ts`).
- **Attachments (w00 A24)** reuse the execution plane's artifact store as-is: bytes go through `createArtifact` (`apps/api/src/services/artifacts/artifactService.ts:156`) after `redactForCapture` (`services/artifacts/captureRedaction.ts:44`); caps **20 per thread / 5 MiB each** (`maxBytes: 5 * 1024 * 1024`); text-only (`text/plain`, `text/csv`, `text/tab-separated-values`, `message/rfc822`, `application/json`, decided from the decoded bytes, never the client's `Content-Type` — same posture as `routes/tickets/attachments.ts:109`). No new artifact kind: adding an `ai_artifact_kind` enum value needs `ALTER TYPE … ADD VALUE` outside the migration transaction, so attachments are `kind: 'input_capture'` named `<base>.redacted.<ext>` (the marker `read_artifact` already requires, `REDACTED_CAPTURE_NAME_INFIX`, `artifactService.ts:351`) with `createdByTool: 'wisp_thread_attachment'`. Retention is the store's default 30 days (`ARTIFACT_DEFAULT_TTL_DAYS`); the sweeper's artifact delete cascades the attachment row.
- **Out of scope:** assessments, concerns, nudges, mobile, the model-written `update_thread_summary` tool, partner-admin thread listing, attachment deletion (an attachment expires with its artifact; a `DELETE` route is a follow-up).

## Review Focus

1. **A turn that carries `pageContext` rebuilds the system prompt from scratch** (`aiAgentSdk.ts:567`: `sanitizedPageContext ? buildSystemPrompt(auth, ctx) : session.systemPrompt`), which would silently drop the thread seed appended at create time. A user who opens Wisp from a device page must still get the thread summary and memory. Pinned by Task 4's `re-seeds the system prompt when a Wisp turn carries pageContext` test.
2. **A revoked, paused or expired grant mid-conversation** must refuse the very next tool call with a typed, user-visible reason (not a generic "Guardrails check failed") and must not take the ungated path. Pinned by Task 4's `GrantInactiveError → wisp_grant_inactive` tests.
3. **A continuation (#7603) of a Wisp session** (`routes/aiSessionContinue.ts` → `insertContinuationSession`) would create a new session without the grant columns and therefore without the ceiling. Pinned by Task 3's `refuses continuation of a Wisp session` test (v1 refuses with `continuation_unsupported`; carrying the grant is a follow-up).
4. **A partner-wide thread opened from an org-scoped token** (grant `org_id NULL`, `auth.scope === 'organization'`) must not widen the session's reach to the partner: the session org is the token's org and `toolAuth` is already narrower than the ceiling. Pinned by Task 3's `partner-wide grant with an org token anchors to the token org` test and Task 4's intersection test.
5. **The summary writer reading another tenant's transcript**: `finalizeWispSessionSummary` runs in the eviction sweep (system-ish background path) and must read only the session's own messages and write only its own thread. Pinned by Task 5's integration assertion that two sessions in different partners finalize into their own threads only.

---

## File map

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2027-01-04-100300-wisp-threads.sql` | Create `wisp_threads` (incl. `focus_org_id`), `wisp_thread_sessions`, `wisp_thread_attachments`; add `ai_sessions.wisp_grant_id`, `ai_sessions.wisp_grant_revision_id`; RLS; grants |
| `apps/api/src/db/schema/wispThreads.ts` (new) | Drizzle tables `wispThreads`, `wispThreadSessions`, `wispThreadAttachments`; exported from `schema/index.ts` |
| `apps/api/src/db/schema/ai.ts` | Two new nullable columns on `aiSessions` |
| `apps/api/src/services/wisp/threads.ts` (new) | The four w00 exports + `setThreadFocus` (w00 A24) + `WispThread` type |
| `apps/api/src/services/wisp/threadAttachments.ts` (new) | `addThreadAttachment`, `listThreadAttachments`, `attachmentSeedLines` (w00 A24) |
| `apps/api/src/services/artifacts/artifactService.ts`, `services/artifacts/toolResultCapture.ts`, `services/toolExecutionContext.ts`, `services/aiAgentSdkTools.ts` | `read_artifact` reach: the caller anchor gains `wispThreadId`, the ownership predicate gains the thread-attachment arm |
| `apps/api/src/services/wisp/threadSummary.ts` (new) | `summaryFromMessages`, `finalizeWispSessionSummary` |
| `apps/api/src/services/wisp/sessionGrant.ts` (new) | `validateWispGrantForSession`, `WispSessionError` |
| `apps/api/src/services/wisp/chatCeiling.ts` (new) | `enforceWispCeiling`, `narrowAuthToCeiling`, `wispSeedForSession` |
| `apps/api/src/services/aiAgent.ts` | `createSession` accepts `wispGrantId`; `closeSession` finalizes the summary |
| `apps/api/src/services/aiAgentSdk.ts` | `createSessionPreToolUse` ceiling gate; preflight re-seed; expiry finalize |
| `apps/api/src/services/streamingSessionManager.ts` | `ActiveSession.wispGrant`; `getOrCreate` dbSession field; eviction finalize |
| `apps/api/src/services/aiGuardrails.ts` | export `resolveToolPermissionRequirements` |
| `apps/api/src/routes/ai.ts` | `wispGrantId` in `createAiSessionSchema`; error mapping; pass grant into `getOrCreate` |
| `apps/api/src/routes/aiSessionContinue.ts` | refuse Wisp sessions |
| `apps/api/src/routes/wispThreads.ts` (new) | `GET /thread`, `GET /thread/:id/sessions`, `PATCH /thread/:id/focus`, `GET|POST /thread/:id/attachments`, mounted under W02's `wispRoutes` |
| `apps/api/src/routes/wisp.ts` (W02) | add `requireEntitlement('wisp')`; mount `wispThreadRoutes` |
| `apps/api/src/services/tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`, `__tests__/integration/rls-coverage.integration.test.ts` | registrations |
| `apps/web/src/stores/aiStore.ts` | `wisp` slice; `createSession({ wispGrantId })` |
| `apps/web/src/components/ai/WispToggle.tsx`, `WispGrantStepUpModal.tsx`, `WispThreadHeader.tsx`, `WispThreadAttachments.tsx` (new) | the chat-surface UI (header carries the focus switcher; attachments is the drop zone + list) |
| `apps/web/src/components/ai/AiChatSidebar.tsx` | Wisp mode wiring |
| `apps/web/src/locales/*/ai.json` | `wisp.*` keys |

---

### Task 1: Migration, Drizzle schema and tenancy registrations

**Files:**
- Create: `apps/api/migrations/2027-01-04-100300-wisp-threads.sql`
- Create: `apps/api/src/db/schema/wispThreads.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './wispThreads';` after line 73 `export * from './aiAgents';`)
- Modify: `apps/api/src/db/schema/ai.ts` (`aiSessions`, after `continuedFromSessionId` ~line 118)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:343-344` (`PARTNER_TENANT_TABLES`)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, alphabetical slot after the last `w*` entry)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (next to `migration_window_orgs`, line 585)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (next to `migration_window_orgs`, line 640; and the `ai_sessions` entry)
- Test: `apps/api/src/__tests__/integration/wispThreadsRls.integration.test.ts`

**Interfaces:**
- Consumes: W02's `wisp_grants` (`id`, `partner_id`, with `UNIQUE (id, partner_id)` — if W02 did not add that unique, this migration adds `wisp_grants_id_partner_uq` idempotently) and `wisp_grant_revisions(id)`; `ai_sessions(id, org_id)` unique (exists: `2026-10-15-160102-ai-budget-reservation-session-org-fk.sql` references it); `organizations(id, partner_id)`; `ai_run_artifacts(id)` (`2026-10-16-180400-ai-run-artifacts.sql` — no `(id, org_id)` unique exists, so this migration adds `ai_run_artifacts_id_org_uq` idempotently for the composite attachment FK).
- Produces: tables below; Drizzle `wispThreads` (with `focusOrgId`), `wispThreadSessions`, `wispThreadAttachments`; `aiSessions.wispGrantId`, `aiSessions.wispGrantRevisionId`.

Table shapes (the migration's content; column order as written):

```sql
wisp_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  summary text NOT NULL DEFAULT '',
  summary_updated_at timestamptz,
  last_session_id uuid,                    -- typed reference, no FK (a closed session may be erased first)
  focus_org_id uuid,                       -- w00 A24 / spec §6.1 (1): the customer this thread is "working on"; NULL = unfocused
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_threads_grant_uq UNIQUE (grant_id),          -- one thread per grant (spec §6)
  CONSTRAINT wisp_threads_id_partner_uq UNIQUE (id, partner_id),
  CONSTRAINT wisp_threads_grant_fk FOREIGN KEY (grant_id, partner_id)
    REFERENCES wisp_grants(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT wisp_threads_focus_org_fk FOREIGN KEY (focus_org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE SET NULL (focus_org_id) DEFERRABLE INITIALLY IMMEDIATE,
    -- column-list SET NULL (PG 15+): a plain SET NULL would null partner_id too and fail NOT NULL. No repo precedent yet; pg16 in both compose files.
  CONSTRAINT wisp_threads_summary_len_chk CHECK (char_length(summary) <= 4000)
)
wisp_thread_attachments (                  -- w00 A24 / spec §6.1 (2): shape 1, org-axis, partner denormalised
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  org_id uuid NOT NULL,                    -- the artifact's org (= the thread's focus org at upload time, or the grant org)
  artifact_id uuid NOT NULL,               -- the handle the model reads with read_artifact
  added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  label varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_thread_attachments_thread_artifact_uq UNIQUE (thread_id, artifact_id),
  CONSTRAINT wisp_thread_attachments_thread_fk FOREIGN KEY (thread_id, partner_id)
    REFERENCES wisp_threads(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT wisp_thread_attachments_org_fk FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT wisp_thread_attachments_artifact_fk FOREIGN KEY (artifact_id, org_id)
    REFERENCES ai_run_artifacts(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE   -- artifact expiry removes the attachment
)
-- CREATE UNIQUE INDEX IF NOT EXISTS ai_run_artifacts_id_org_uq ON ai_run_artifacts (id, org_id);   -- before the attachment FK
-- indexes: wisp_thread_attachments (org_id), (partner_id), (thread_id, created_at DESC), (artifact_id)
-- RLS on wisp_thread_attachments: ENABLE + FORCE; ONE policy FOR ALL TO breeze_app,
--   USING/WITH CHECK (breeze_current_scope() = 'system' OR breeze_has_org_access(org_id))   (copy from 2026-10-16-180400-ai-run-artifacts.sql)
-- The 20-per-thread cap is enforced in threadAttachments.ts under SELECT … FOR UPDATE on the thread row, not by a CHECK.
wisp_thread_sessions (
  thread_id uuid NOT NULL,
  session_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  org_id uuid NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wisp_thread_sessions_pkey PRIMARY KEY (thread_id, session_id),
  CONSTRAINT wisp_thread_sessions_session_uq UNIQUE (session_id),   -- a session belongs to one thread
  CONSTRAINT wisp_thread_sessions_thread_fk FOREIGN KEY (thread_id, partner_id)
    REFERENCES wisp_threads(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT wisp_thread_sessions_session_fk FOREIGN KEY (session_id, org_id)
    REFERENCES ai_sessions(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT wisp_thread_sessions_org_fk FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
)
-- indexes: wisp_threads (partner_id); wisp_thread_sessions (org_id), (partner_id), (thread_id, attached_at DESC)
-- RLS on both: ENABLE + FORCE; ONE policy each, FOR ALL TO breeze_app,
--   USING/WITH CHECK (breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id))
--   (copy the DO $$ … duplicate_object $$ block from 2026-12-25-120000-migration-windows.sql)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON both TO breeze_app
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS wisp_grant_id uuid;            -- FK in SQL only: → wisp_grants(id) ON DELETE SET NULL
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS wisp_grant_revision_id uuid;   -- FK in SQL only: → wisp_grant_revisions(id) ON DELETE SET NULL
-- CHECK ai_sessions_wisp_grant_pair_chk ((wisp_grant_id IS NULL) = (wisp_grant_revision_id IS NULL)), NOT VALID then VALIDATE
-- partial index ai_sessions_wisp_grant_idx ON ai_sessions (wisp_grant_id) WHERE wisp_grant_id IS NOT NULL
```

- [ ] **Step 1: Write the failing RLS/contract integration test**

`apps/api/src/__tests__/integration/wispThreadsRls.integration.test.ts` (pattern: `aiAgentSchedulesPartnerRls.integration.test.ts` header, `./setup`, `db-utils` `createPartner`/`createOrganization`/`createUser`; grant rows inserted under `SYSTEM_CTX` straight into `wisp_grants` + `wisp_grant_revisions` with the §4.2 columns, because `createGrant` needs a step-up proof):

```ts
describe('wisp_threads / wisp_thread_sessions RLS (shape 3)', () => {
  it('a partner context reads its own thread and not a sibling partner's', ...);        // select count = 1 / 0
  it('cross-partner insert into wisp_threads is refused with 42501', ...);
  it('wisp_threads_grant_uq: second thread for the same grant is refused with 23505', ...);
  it('summary longer than 4000 chars is refused with 23514', ...);
  it('wisp_thread_sessions: a session from an org outside the partner is refused (23503 on org_fk)', ...);
  it('deleting the ai_sessions row cascades the wisp_thread_sessions row', ...);
  it('ai_sessions_wisp_grant_pair_chk refuses a grant id without a revision id (23514)', ...);
  it('focus_org_id: an org from another partner is refused (23503); deleting the focus org sets focus_org_id NULL and keeps partner_id', ...);   // w00 A24
  it('wisp_thread_attachments: an org context reads its own attachment and not a sibling org's; cross-org insert is 42501; artifact_id must match the artifact's org (23503)', ...);   // shape 1
  it('deleting the ai_run_artifacts row cascades the attachment; deleting the thread cascades its attachments', ...);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispThreadsRls.integration.test.ts`
Expected: FAIL — `relation "wisp_threads" does not exist`.

- [ ] **Step 3: Write the migration** `2027-01-04-100300-wisp-threads.sql` per the shape above. Header comment states: partner-axis shape 3 for the two thread tables, shape 1 for `wisp_thread_attachments` (org-cascade/merge/export registered), `wisp_thread_sessions` also org-cascade-registered, `focus_org_id` column-list `SET NULL`, no rows written (no `set_config`), FKs to `wisp_grants`/`wisp_grant_revisions` declared in SQL only to avoid schema import cycles (same rule as `ai_sessions.agent_id`).

- [ ] **Step 4: Write the Drizzle schema** `apps/api/src/db/schema/wispThreads.ts`:

```ts
export const wispThreads = pgTable('wisp_threads', { id, grantId, partnerId, summary, summaryUpdatedAt, lastSessionId, focusOrgId, createdAt, updatedAt }, …unique('wisp_threads_grant_uq'), foreignKey({ name: 'wisp_threads_focus_org_fk', columns: [focusOrgId, partnerId], foreignColumns: [organizations.id, organizations.partnerId] }) …);
export const wispThreadSessions = pgTable('wisp_thread_sessions', { threadId, sessionId, partnerId, orgId, attachedAt }, …primaryKey(threadId, sessionId)…);
export const wispThreadAttachments = pgTable('wisp_thread_attachments', { id, threadId, partnerId, orgId, artifactId, addedByUserId, label, createdAt }, …foreignKey(org_fk), foreignKey(artifact_fk) — declared so moveOrg.coverage.test.ts's FK reader sees them (W05 does the same for wisp_concerns)…);
```

Add to `aiSessions` in `schema/ai.ts`: `wispGrantId: uuid('wisp_grant_id')`, `wispGrantRevisionId: uuid('wisp_grant_revision_id')` with a comment pointing at this migration. Export the new file from `schema/index.ts`.

- [ ] **Step 5: Register tenancy**
  - `rls-coverage.integration.test.ts` `PARTNER_TENANT_TABLES`: `['wisp_threads', 'partner_id']`, `['wisp_thread_sessions', 'partner_id']` (next to lines 343-344, with the same "also carries a non-tenancy org_id" note for the join table).
  - `tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER`: `'wisp_thread_attachments'` and `'wisp_thread_sessions'` in alphabetical position (the alphabetical test is on the static list; FK direction is checked on `topologicalCascadeOrder()`, so the `ON DELETE CASCADE` edges to `ai_sessions` / `ai_run_artifacts` need no exemption; `ai_run_artifacts` is already in the order at `tenantExportPolicyRegistry.ts:387`-neighbourhood and `tenantCascade.ts`, so attachments sort before it topologically). `focus_org_id` needs no cascade step: the FK clears it.
  - `orgMergeRegistry.ts`: `wisp_thread_sessions: { kind: 'repoint-dedupe', key: ['thread_id', 'session_id'] }` — the PK is `(thread_id, session_id)` and `session_id` is unique, so a merge never collides; `repoint-dedupe` matches the `migration_window_orgs` precedent for PK-bearing join rows. `wisp_thread_attachments: { kind: 'repoint', note: 'session-anchored artifacts (run_id NULL) are re-pointed by moveAiRunArtifacts, so the composite (artifact_id, org_id) FK stays consistent under SET CONSTRAINTS ALL DEFERRED; (thread_id, artifact_id) is unique and unaffected' }` (`ai_run_artifacts` entry at `orgMergeRegistry.ts:304` explains the split). `wisp_threads.focus_org_id`: if `orgMergeRegistry.integration.test.ts` / `orgLifecycleFoundations.integration.test.ts:39` flag the new composite FK as an unregistered org reference, add a `custom` entry whose executor runs `UPDATE wisp_threads SET focus_org_id = <survivor> WHERE focus_org_id = <loser>` next to `moveAiRunArtifacts` in `orgMergeCustomExecutors.ts`; otherwise document in the migration header that a merged-away focus org is cleared by the FK and the user re-focuses.
  - `tenantExportPolicyRegistry.ts`: `"wisp_thread_sessions": tablePolicy("org_id", { included: ["thread_id","session_id","partner_id","org_id","attached_at"], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })`; `"wisp_thread_attachments": tablePolicy("org_id", { included: ["id","thread_id","partner_id","org_id","artifact_id","added_by_user_id","label","created_at"], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })` (`label` is bounded varchar; the bytes live in `ai_run_artifacts`, already exported); add `"wisp_grant_id"`, `"wisp_grant_revision_id"` to the `ai_sessions` entry's `included`.

- [ ] **Step 6: Migrate, drift-check, run the test and the static guards**

Run: `export DATABASE_URL=… && pnpm db:migrate && pnpm db:check-drift`
Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts`
Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispThreadsRls.integration.test.ts`
Expected: all PASS.

- [ ] **Step 7: Run the three contract suites that only fail under Integration Tests**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`
Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
Expected: PASS (every `org_id` table present; `wisp_thread_sessions` classified; shape-3 tables covered).

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2027-01-04-100300-wisp-threads.sql apps/api/src/db/schema/wispThreads.ts apps/api/src/db/schema/index.ts apps/api/src/db/schema/ai.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/wispThreadsRls.integration.test.ts
git commit -m "feat(wisp): wisp_threads (+focus_org_id), wisp_thread_sessions, wisp_thread_attachments and ai_sessions grant columns (W04 T1)"
```

---

### Task 2: `services/wisp/threads.ts` and the deterministic summary

**Files:**
- Create: `apps/api/src/services/wisp/threads.ts`
- Create: `apps/api/src/services/wisp/threadSummary.ts`
- Create (stub; real body in Task 6b): `apps/api/src/services/wisp/threadAttachments.ts`
- Test: `apps/api/src/services/wisp/threads.test.ts`, `apps/api/src/services/wisp/threadSummary.test.ts`

**Interfaces:**
- Consumes: `recallForGrant(ceiling, q)`, `renderMemoryForPrompt(blocks)` (W03 `memoryBroker.ts`); `GrantCeiling` (W02 `grantAuthority.ts`); `wrapUntrustedData(label, body, flags)` + `sanitizeUntrustedText` (`services/aiInputSanitizer.ts:286`); `db`, `runOutsideDbContext`, `withSystemDbAccessContext` (`db/index.ts`).
- Produces (exactly w00's "Threads (W04)" block):

```ts
// apps/api/src/services/wisp/threads.ts
export type WispThread = { id: string; grantId: string; partnerId: string; summary: string; summaryUpdatedAt: Date | null; lastSessionId: string | null; focusOrgId: string | null; createdAt: Date; updatedAt: Date }; // focusOrgId: w00 A24
export async function getOrCreateThread(grantId: string): Promise<WispThread>;      // INSERT … ON CONFLICT (grant_id) DO NOTHING, then SELECT; partner_id read from wisp_grants
export async function attachSession(threadId: string, sessionId: string): Promise<void>; // inserts (thread_id, session_id, partner_id, org_id) — org_id from ai_sessions, partner_id from the thread; sets wisp_threads.last_session_id
export async function updateThreadSummary(threadId: string, summary: string): Promise<void>; // truncateSummary(summary) (≤ 4_000), summary_updated_at = now()
export async function seedContextForSession(threadId: string, ceiling: GrantCeiling): Promise<string>;
export async function setThreadFocus(threadId: string, orgId: string | null, ceiling: GrantCeiling): Promise<WispThread>; // w00 A24: orgId !== null ⇒ assertWithinCeiling(ceiling, { orgId }) BEFORE the write (CeilingViolationError propagates); UPDATE … SET focus_org_id, updated_at = now() WHERE id AND partner_id = ceiling.partnerId; returns the row

// apps/api/src/services/wisp/threadAttachments.ts (w00 A24; Task 6b)
export const THREAD_ATTACHMENT_MAX_PER_THREAD = 20;
export const THREAD_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export type ThreadAttachment = { id: string; threadId: string; orgId: string; artifactId: string; label: string; addedByUserId: string | null; contentType: string; bytes: number; expiresAt: Date; createdAt: Date }; // joined with ai_run_artifacts
export class ThreadAttachmentError extends Error { code: 'too_many' | 'too_large' | 'unsupported_type' | 'empty' | 'org_outside_ceiling' | 'store_unavailable' }
export async function addThreadAttachment(input: { thread: WispThread; ceiling: GrantCeiling; orgId: string; label: string; text: string; addedByUserId: string }): Promise<ThreadAttachment>;
export async function listThreadAttachments(threadId: string): Promise<ThreadAttachment[]>; // newest first; expired artifacts excluded (expires_at > now())
export function attachmentSeedLines(items: ThreadAttachment[]): string;                     // '' for none; else one line per item: `- <label> — handle <artifactId> (<bytes> B, <contentType>)`

// apps/api/src/services/wisp/threadSummary.ts
export const THREAD_SUMMARY_MAX_CHARS = 4_000;
export function truncateSummary(text: string): string;                       // deterministic: trim; if > 4000, cut at the last whitespace ≥ 3_500 else hard-cut at 3_999, append '…'
export function summaryFromMessages(messages: Array<{ role: string; content: string | null }>): string | null; // last 'assistant' message with non-empty content → its last paragraph (split on /\n\s*\n/), trimmed; null when none
export async function finalizeWispSessionSummary(sessionId: string): Promise<{ updated: boolean }>; // no-op when the session is not attached to a thread; idempotent (writes only when the computed summary differs)
```

`seedContextForSession` output (exact structure; an empty string when both parts are empty):

```
## Wisp thread
Focus: <org name>                                                                                 -- only when focusOrgId is set (w00 A24); name read under system ctx from organizations
<wrapUntrustedData('wisp_thread_summary', sanitizeUntrustedText(summary, 4_000, flags))>        -- only when summary !== ''
<wrapUntrustedData('wisp_thread_attachments', attachmentSeedLines(await listThreadAttachments(threadId)))>  -- only when there are live attachments; labels are user text, hence the fence; the model reads bytes with read_artifact by handle (Task 6b)
<memory>                                                                                          -- see the recall order below; only when blocks.length > 0
```

Recall order (w00 A24): when `focusOrgId` is set, `recallForGrant(ceiling, { owners: ['user','org'], orgId: focusOrgId, limit: 40 })` **first**, then `recallForGrant(ceiling, { owners: ['partner'], limit: 20 })`, rendered as two `renderMemoryForPrompt` calls in that order (org-private blocks never appear in a partner-level answer, spec §8.3 — the focus is what makes the org blocks relevant). When unfocused, the single call stays `recallForGrant(ceiling, { limit: 40, orgId: <grant org or undefined> })`.

All reads/writes in `threads.ts` run under `runOutsideDbContext(() => withSystemDbAccessContext(...))`: callers are the request path (`createSession`), the SDK background processor and the eviction sweep, and the thread's partner axis is not visible to an org-scoped request context. Each function takes ids that were already authorised by the caller (`validateWispGrantForSession`, Task 3).

- [ ] **Step 1: Write the failing unit tests**

`threadSummary.test.ts`:

```ts
it('summaryFromMessages returns the last paragraph of the last assistant message', () => {
  expect(summaryFromMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Para one.\n\nPara two.' }, { role: 'tool_result', content: 'x' }])).toBe('Para two.');
});
it('returns null when no assistant message has content', () => { expect(summaryFromMessages([{ role: 'assistant', content: null }])).toBeNull(); });
it('truncateSummary keeps ≤ 4000 chars, ends with …, and is deterministic', () => {
  const long = 'word '.repeat(1200);
  const a = truncateSummary(long); expect(a.length).toBeLessThanOrEqual(4000); expect(a.endsWith('…')).toBe(true); expect(truncateSummary(long)).toBe(a);
});
it('truncateSummary leaves short text unchanged', () => { expect(truncateSummary('  ok  ')).toBe('ok'); });
```

`threads.test.ts` (Drizzle mocked per the `breeze-testing` skill; `memoryBroker` mocked):

```ts
it('getOrCreateThread inserts once per grant and returns the existing row on the second call', ...);
it('attachSession writes partner_id from the thread and org_id from the session, and bumps last_session_id', ...);
it('updateThreadSummary stores truncateSummary(input) and sets summary_updated_at', ...);
it('seedContextForSession returns "" when summary is empty and recall returns no blocks', ...);
it('seedContextForSession wraps the summary as untrusted and appends renderMemoryForPrompt output', async () => {
  const out = await seedContextForSession('t1', ceiling);
  expect(out).toMatch(/^## Wisp thread\n/); expect(out).toContain('wisp_thread_summary'); expect(recallForGrant).toHaveBeenCalledWith(ceiling, expect.objectContaining({ limit: 40 }));
});
it('seedContextForSession under a focused thread recalls { owners: [user, org], orgId: focus } before { owners: [partner] } and prints the Focus line', async () => {   // w00 A24
  threadRow.focusOrgId = 'orgA';
  const out = await seedContextForSession('t1', ceiling);
  expect(recallForGrant.mock.calls.map((c) => c[1])).toEqual([expect.objectContaining({ owners: ['user', 'org'], orgId: 'orgA' }), expect.objectContaining({ owners: ['partner'] })]);
  expect(out).toContain('Focus: ');
});
it('seedContextForSession lists live attachments inside a wisp_thread_attachments fence, by handle, and omits the fence when there are none', ...);   // listThreadAttachments mocked
it('setThreadFocus asserts the org is inside the ceiling before writing and rethrows CeilingViolationError without an UPDATE; null clears the focus with no ceiling check', ...);   // w00 A24
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/wisp/threads.test.ts src/services/wisp/threadSummary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `threadSummary.ts` then `threads.ts`** with the signatures above. `finalizeWispSessionSummary` reads `wisp_thread_sessions` by `session_id`, then the session's `ai_messages` ordered by `created_at`, computes `summaryFromMessages`, and calls `updateThreadSummary` only when non-null and different from the stored summary. `seedContextForSession` imports `listThreadAttachments`/`attachmentSeedLines` from `./threadAttachments` (created in Task 6b — stub the module with the two exports now so this task compiles; Task 6b fills it in).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/wisp/threads.test.ts src/services/wisp/threadSummary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/threads.ts apps/api/src/services/wisp/threadSummary.ts apps/api/src/services/wisp/threadAttachments.ts apps/api/src/services/wisp/threads.test.ts apps/api/src/services/wisp/threadSummary.test.ts
git commit -m "feat(wisp): thread service (focus, seed order), deterministic summary and session seed (W04 T2)"
```

---

### Task 3: Session create accepts `wispGrantId`

**Files:**
- Create: `apps/api/src/services/wisp/sessionGrant.ts`
- Modify: `apps/api/src/services/aiAgent.ts:85-261` (`createSession`)
- Modify: `apps/api/src/routes/ai.ts:156-165` (`createAiSessionSchema`), `:233-269` (error mapping)
- Modify: `apps/api/src/routes/aiSessionContinue.ts:79-81`
- Test: `apps/api/src/services/wisp/sessionGrant.test.ts`, `apps/api/src/routes/ai_sessions_wisp.test.ts`, extend `apps/api/src/routes/ai.continue.test.ts`

**Interfaces:**
- Consumes: `wispEnabled()` (W02, `config/env.ts`); `hasEntitlement(partnerId, 'wisp')` (W01 `services/entitlements.ts`); W02 Drizzle table `wispGrants` (`id, partnerId, orgId, grantorUserId, grantee, currentRevisionId, status`); `getOrCreateThread`, `attachSession`, `seedContextForSession` (Task 2); `resolveGrantCeiling` (W02).
- Produces:

```ts
// apps/api/src/services/wisp/sessionGrant.ts
export type WispSessionErrorCode = 'wisp_disabled' | 'grant_not_found' | 'grant_not_yours' | 'grant_inactive' | 'entitlement_required' | 'grant_scope_mismatch' | 'focus_mismatch'; // focus_mismatch (409): explicit orgId ≠ the thread's focus org (w00 A24)
export class WispSessionError extends Error { constructor(public code: WispSessionErrorCode, public status: 400 | 403 | 404 | 409) }
export type ValidatedWispGrant = { grantId: string; revisionId: string; partnerId: string; orgId: string | null };
export async function validateWispGrantForSession(auth: AuthContext, wispGrantId: string, sessionOrgId: string): Promise<ValidatedWispGrant>;
```

Validation order and codes: `wispEnabled()` false → `wisp_disabled` 404; grant row not readable under the request context, or `grantee !== 'wisp'` → `grant_not_found` 404; `grantorUserId !== auth.user.id` → `grant_not_yours` 403; `status !== 'active'` → `grant_inactive` 409; `!(await hasEntitlement(grant.partnerId, 'wisp'))` → `entitlement_required` 403; `grant.orgId !== null && grant.orgId !== sessionOrgId` → `grant_scope_mismatch` 400. Route mapping: `c.json({ error: <message>, code }, status)`.

`createSession` changes (behaviour, in order): `options.wispGrantId?: string` added to the signature. After the org chain resolves `orgId` (line 166-170) and before the insert: `validated = await validateWispGrantForSession(auth, wispGrantId, orgId)`. The insert adds `wispGrantId: validated.grantId, wispGrantRevisionId: validated.revisionId`. `systemPrompt` becomes `[await buildSystemPrompt(auth, sanitizedPageContext), seed].filter(Boolean).join('\n')` where `seed = await seedContextForSession(thread.id, await resolveGrantCeiling(validated.grantId, validated.revisionId))` and `thread = await getOrCreateThread(validated.grantId)`. After the insert returns: `await attachSession(thread.id, session.id)`. The return type gains `wispThreadId: string | null` and `wispFocusOrgId: string | null`. A Wisp session keeps `type = 'general'` and the existing `requireMfa()` on the route.

**Focus anchoring (w00 A24; spec §6.1 "effects default to that org").** Between `validateWispGrantForSession` and the insert: `thread = await getOrCreateThread(validated.grantId)`; when `thread.focusOrgId` is set, re-check it against the live ceiling — `assertWithinCeiling(ceiling, { orgId: thread.focusOrgId })` — and (a) on success, if `options.orgId` is absent the session's `orgId` **becomes** `thread.focusOrgId` (it overrides the page anchor / `auth.orgId` / first-accessible defaults; `validated.orgId === null || validated.orgId === thread.focusOrgId` holds because the focus is inside the ceiling), and if `options.orgId` is present and differs → `WispSessionError('focus_mismatch', 409)` (the web always sends the focus org while focused; a stale tab gets a typed 409, never a silently re-anchored session); (b) on `CeilingViolationError` (the grant was tightened since the focus was set) → `await setThreadFocus(thread.id, null, ceiling)` and continue with the ordinary chain, returning `wispFocusOrgId: null` so the header drops the focus and toasts `wisp.toast.focusCleared`. `attachSession` therefore records the focus org on the join row, and every write under the session defaults to it through the unchanged `resolveWritableToolOrgId` path. The anchor-org convention is unchanged: a partner-wide grant's session org is whatever the existing chain picks (explicit `orgId`, page anchor, `auth.orgId`, first accessible), reads stay partner-wide through `toolAuth`, and writes default through `resolveWritableToolOrgId` (`services/aiToolWriteOrg.ts:34`) exactly as today — cite this in the code comment.

- [ ] **Step 1: Write the failing tests**

`sessionGrant.test.ts` (mock `config/env`, `services/entitlements`, Drizzle):

```ts
it.each([
  ['flag off', { enabled: false }, 'wisp_disabled', 404],
  ['row missing', { row: null }, 'grant_not_found', 404],
  ['other grantor', { row: { grantorUserId: 'u2' } }, 'grant_not_yours', 403],
  ['paused', { row: { status: 'paused' } }, 'grant_inactive', 409],
  ['no entitlement', { entitled: false }, 'entitlement_required', 403],
  ['org grant, other org', { row: { orgId: 'orgB' } }, 'grant_scope_mismatch', 400],
])('%s → %s', async (_n, fx, code, status) => { await expect(validateWispGrantForSession(auth, 'g1', 'orgA')).rejects.toMatchObject({ code, status }); });
it('returns { grantId, revisionId, partnerId, orgId } for an active own grant', ...);
it('a partner-wide grant (orgId null) accepts any session org inside the partner', ...);
```

`ai_sessions_wisp.test.ts` (pattern: `ai_sessions_crud.test.ts`; mock `services/wisp/sessionGrant`, `services/wisp/threads`, `services/wisp/grantAuthority`):

```ts
it('POST /ai/sessions without wispGrantId is byte-identical to today (no wisp calls)', ...);   // validate/getOrCreateThread/attachSession not called; insert has no wisp columns
it('POST /ai/sessions with wispGrantId stores both grant columns, appends the seed to systemPrompt and attaches the session', ...);
it('maps WispSessionError codes to HTTP status', ...);                                       // each of the seven
it('partner-wide grant with an org token anchors to the token org', ...);                    // auth.scope 'organization', orgId = auth.orgId, validate called with that org
it('a focused thread anchors the session to focusOrgId when no orgId is sent, and returns wispFocusOrgId', ...);   // w00 A24: insert.orgId === focus; attachSession org === focus
it('an explicit orgId that differs from the focus is refused 409 focus_mismatch', ...);
it('a focus outside the live ceiling is cleared (setThreadFocus null) and the ordinary chain anchors the session; response wispFocusOrgId is null', ...);
```

`ai.continue.test.ts` addition:

```ts
it('refuses continuation of a Wisp session with continuation_unsupported', async () => { /* session.wispGrantId set → 400 { code: 'continuation_unsupported' } */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/wisp/sessionGrant.test.ts src/routes/ai_sessions_wisp.test.ts src/routes/ai.continue.test.ts`
Expected: FAIL — `validateWispGrantForSession` not defined; unknown body key stripped; continuation succeeds.

- [ ] **Step 3: Implement** `sessionGrant.ts`; extend `createAiSessionSchema` with `wispGrantId: z.string().guid().optional()`; thread `wispGrantId` through `createSession`; add `if (err instanceof WispSessionError) return c.json({ error: err.message, code: err.code }, err.status);` before the generic branches at `ai.ts:254`; in `aiSessionContinue.ts` extend the `session.type !== 'general'` refusal to `|| session.wispGrantId` with the same `continuation_unsupported` body. `getSession`/`getSessionMessages` must select the two new columns (they are on the Drizzle table, so `select()` without a column list already includes them; a column-listed select must add them).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/wisp/sessionGrant.test.ts src/routes/ai_sessions_wisp.test.ts src/routes/ai.continue.test.ts src/routes/ai_sessions_crud.test.ts`
Expected: PASS, including the untouched CRUD suite.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/sessionGrant.ts apps/api/src/services/wisp/sessionGrant.test.ts apps/api/src/services/aiAgent.ts apps/api/src/routes/ai.ts apps/api/src/routes/aiSessionContinue.ts apps/api/src/routes/ai_sessions_wisp.test.ts apps/api/src/routes/ai.continue.test.ts
git commit -m "feat(wisp): POST /ai/sessions accepts wispGrantId — validated, seeded, attached to the thread (W04 T3)"
```

---

### Task 4: The per-tool-call ceiling gate (Tier 1 included)

**Files:**
- Create: `apps/api/src/services/wisp/chatCeiling.ts`
- Modify: `apps/api/src/services/streamingSessionManager.ts:422` (`ActiveSession`), `:875-897` (`getOrCreate` `dbSession`), `:1120` (session literal)
- Modify: `apps/api/src/services/aiAgentSdk.ts:809-895` (`createSessionPreToolUse`), `:560-569` (preflight system prompt)
- Modify: `apps/api/src/services/aiGuardrails.ts:2808` (export `resolveToolPermissionRequirements`)
- Modify: `apps/api/src/routes/ai.ts:1009-1023` (pass `wispGrant` into `getOrCreate`)
- Test: `apps/api/src/services/wisp/chatCeiling.test.ts`, `apps/api/src/services/aiAgentSdk.wispCeiling.test.ts`, `apps/api/src/__tests__/integration/wispChatCeiling.integration.test.ts`

**Interfaces:**
- Consumes: `resolveGrantCeiling`, `assertWithinCeiling`, `GrantInactiveError`, `CeilingViolationError`, `GrantCeiling` (W02 `services/wisp/grantAuthority.ts`); `buildOrgAccessClosures` (`middleware/auth.ts`, as used in `aiSessionLiveAuthority.ts:41`); `TOOL_PERMISSIONS` + `resolveToolPermissionRequirements` (`aiGuardrails.ts`); `writeAuditEvent` + `requestLikeFromSnapshot` (as at `aiAgentSdk.ts:946`); `seedContextForSession` (Task 2).
- Produces:

```ts
// apps/api/src/services/wisp/chatCeiling.ts
export type WispSessionGrant = { grantId: string; revisionId: string; threadId: string };
export type WispCeilingRefusal = { code: 'wisp_grant_inactive' | 'wisp_outside_ceiling'; detail: 'org' | 'site' | 'permission' | 'tool' | 'inactive'; message: string };
export const WISP_REFUSAL_MESSAGES: Record<WispCeilingRefusal['detail'], string>; // user-visible copy, e.g. org: "Wisp can't act on that organization under your current grant."
export function requiredPermissionKeys(toolName: string, input: Record<string, unknown>): string[];   // `${resource}:${action}` from resolveToolPermissionRequirements; [] when the tool has no mapping (the RBAC step still denies it later)
export function targetOrgIdFor(input: Record<string, unknown>, sessionOrgId: string): string;       // typeof input.orgId === 'string' ? input.orgId : sessionOrgId
export function narrowAuthToCeiling(auth: AuthContext, ceiling: GrantCeiling, sessionId?: string): AuthContext;       // accessibleOrgIds ∩ ceiling.orgIds (null → ceiling.orgIds), rebuilt closures via buildOrgAccessClosures; allowedSiteIds ∩ ceiling.siteIds when both set; ALSO sets wispGrant = { grantId: ceiling.grantId, grantRevisionId: ceiling.revisionId, sessionId: sessionId ?? null } (w00 A2 — this is how W03's recall/remember and W07's launch_specialist learn the grant on a chat turn; w00 A23 — `sessionId` is what W03's `remember` writes as `source_session_id`)
export async function enforceWispCeiling(args: { grant: WispSessionGrant; toolName: string; input: Record<string, unknown>; sessionOrgId: string; sessionId: string; toolAuth: AuthContext }): Promise<{ ok: true; toolAuth: AuthContext; ceiling: GrantCeiling } | { ok: false; refusal: WispCeilingRefusal }>; // sessionId = session.breezeSessionId, forwarded to narrowAuthToCeiling
export async function wispSeedForSession(sessionId: string, grant: WispSessionGrant): Promise<string>; // seedContextForSession(grant.threadId, await resolveGrantCeiling(...)); '' on GrantInactiveError
```

`enforceWispCeiling` order: `resolveGrantCeiling` (GrantInactiveError → `wisp_grant_inactive`/`inactive`); `assertWithinCeiling(ceiling, { toolName, orgId: targetOrgIdFor(input, sessionOrgId) })`; then for each key of `requiredPermissionKeys` `assertWithinCeiling(ceiling, { permission: key })`; a `CeilingViolationError` → `wisp_outside_ceiling` with `detail = err.code`; success returns `narrowAuthToCeiling(toolAuth, ceiling, sessionId)` (`createSessionPreToolUse` passes `session.breezeSessionId`).

**Placement (the one place).** w00 names `makeSessionAwareHandler`, but that wrapper only covers the M365/Google tools (`aiAgentSdkTools.ts:1250-1392`); every registry tool runs through `makeHandler` (`:745`). Both call the same `onPreToolUse`, which is `createSessionPreToolUse(session)` (`aiAgentSdk.ts:809`, bound at `streamingSessionManager.ts:1152`). The gate therefore goes into `createSessionPreToolUse`, immediately after the session-allowlist check (`:859-878`) and **before** `checkGuardrails` (`:885`), so Tier 1 is covered and a refusal never reaches the tier-2 live-authority branch. On `ok`, `session.toolAuth = result.toolAuth` for this call (the tier-2 branch may later replace it with `live.toolAuth`; re-narrow there too: after `session.toolAuth = live.toolAuth` at `:962` apply `narrowAuthToCeiling(live.toolAuth, ceiling)` when `session.wispGrant` is set). On refusal: `writeAuditEvent(..., { action: 'wisp.ceiling_refused', resourceType: 'ai_session', resourceId: session.breezeSessionId, result: 'failure', errorMessage: refusal.message, details: { toolName, code: refusal.code, detail: refusal.detail, grantId } })` when `session.auditSnapshot` exists, and `return { allowed: false, error: refusal.message }` — the existing `preToolUseDenialResult` path streams it to the chat as the tool's result, which is the user-visible reason.

`ActiveSession` gains `wispGrant: WispSessionGrant | null` (readonly); `getOrCreate`'s `dbSession` gains `wispGrant?: WispSessionGrant | null`; `routes/ai.ts` passes `await lookupWispGrant(dbSession)` — a `chatCeiling.ts` export that returns `null` when `wisp_grant_id` is null and otherwise `{ grantId, revisionId, threadId }` by joining `wisp_thread_sessions` on the session id (`threads.ts` stays at the four w00 exports). Preflight re-seed: at `aiAgentSdk.ts:567`, when `sanitizedPageContext` is set and `session.wispGrantId` is set, `systemPrompt = [await buildSystemPrompt(auth, ctx), await wispSeedForSession(sessionId, grant)].filter(Boolean).join('\n')`.

- [ ] **Step 1: Write the failing unit tests**

`chatCeiling.test.ts` (mock `grantAuthority`):

```ts
it('refuses with wisp_grant_inactive when resolveGrantCeiling throws GrantInactiveError', ...);
it('refuses a Tier-1 tool whose orgId input is outside ceiling.orgIds with detail "org"', ...);       // toolName 'get_device_details', input { orgId: 'orgB' }
it('refuses when a required permission key is missing with detail "permission"', ...);              // requiredPermissionKeys → ['devices:read'], ceiling.permissionKeys = ∅
it('narrows toolAuth.accessibleOrgIds to the ceiling, rebuilds closures, and stamps wispGrant', () => {
  const out = narrowAuthToCeiling({ ...auth, accessibleOrgIds: ['a', 'b', 'c'] }, { ...ceiling, orgIds: new Set(['b']) });
  expect(out.accessibleOrgIds).toEqual(['b']); expect(out.canAccessOrg('c')).toBe(false);
  expect(out.wispGrant).toEqual({ grantId: ceiling.grantId, grantRevisionId: ceiling.revisionId, sessionId: null });
});
it('narrowAuthToCeiling stamps wispGrant.sessionId when a session id is passed (w00 A23)', () => {
  expect(narrowAuthToCeiling(auth, ceiling, 's-1').wispGrant?.sessionId).toBe('s-1');
});
it('a null accessibleOrgIds (unrestricted) becomes exactly the ceiling orgs', ...);
it('requiredPermissionKeys maps an action-dependent tool by input.action', ...);                    // e.g. manage_alerts { action: 'resolve' }
it('wispSeedForSession returns "" when the grant is inactive', ...);
```

`aiAgentSdk.wispCeiling.test.ts` (pattern: `aiAgentSdk.enforcementArmingGate.test.ts`; mock `services/wisp/chatCeiling`, guardrails, permissions, rate limit):

```ts
it('runs enforceWispCeiling BEFORE checkGuardrails for a Tier-1 tool when session.wispGrant is set', ...);  // call order via mock.invocationCallOrder
it('does not call enforceWispCeiling when session.wispGrant is null (ungated path unchanged)', ...);
it('a refusal returns { allowed: false, error: <refusal.message> } and writes wisp.ceiling_refused', ...);
it('on ok, session.toolAuth is the narrowed auth for the call', ...);
it('re-seeds the system prompt when a Wisp turn carries pageContext', ...);                          // runPreFlightChecks with pageContext → systemPrompt contains the seed
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/wisp/chatCeiling.test.ts src/services/aiAgentSdk.wispCeiling.test.ts`
Expected: FAIL — module/fields missing; call-order assertion fails.

- [ ] **Step 3: Implement** `chatCeiling.ts`; add `export` to `resolveToolPermissionRequirements` (no body change); add `wispGrant` to `ActiveSession`, `getOrCreate` and the session literal; wire the gate and the audit event into `createSessionPreToolUse`; the preflight re-seed; pass `wispGrant` from `routes/ai.ts`.

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/wisp/chatCeiling.test.ts src/services/aiAgentSdk.wispCeiling.test.ts src/services/aiAgentSdk.test.ts src/services/aiAgentSdk.enforcementArmingGate.test.ts src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts`
Expected: PASS (existing suites unchanged: fixtures without `wispGrant` take the ungated path).

- [ ] **Step 5: Write the failing integration test** `wispChatCeiling.integration.test.ts` (real Postgres; partner P with orgs A and B; user U = partner technician with access to both; grant G scoped to org A inserted under `SYSTEM_CTX` with a revision whose `ceiling_snapshot` lists A and U's permission keys; `toolAuth` built like `aiSessionLiveAuthority` does for a partner session):

```ts
it('under grant G, a Tier-1 read targeting org B is refused with wisp_outside_ceiling/org', async () => {
  const r = await enforceWispCeiling({ grant: { grantId: G, revisionId: R, threadId: T }, toolName: 'get_device_details', input: { orgId: orgB }, sessionOrgId: orgA, toolAuth });
  expect(r).toMatchObject({ ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'org' } });
});
it('the same user without a grant keeps the ungated path: createSessionPreToolUse never consults the ceiling and allows the read', async () => {
  const pre = createSessionPreToolUse({ ...session, wispGrant: null });   // rate limiter module mocked to allow
  await expect(pre('get_device_details', { orgId: orgB })).resolves.toMatchObject({ allowed: true });
});
it('under grant G, a Tier-1 read inside the ceiling is allowed and toolAuth.accessibleOrgIds === [orgA]', ...);
it('revoking G (status revoked) makes the next call refuse with wisp_grant_inactive', ...);
```

- [ ] **Step 6: Run it to verify it fails, implement any gap, run again**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispChatCeiling.integration.test.ts`
Expected: first FAIL (fixture wiring), then PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/wisp/chatCeiling.ts apps/api/src/services/wisp/chatCeiling.test.ts apps/api/src/services/aiAgentSdk.ts apps/api/src/services/aiAgentSdk.wispCeiling.test.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/streamingSessionManager.ts apps/api/src/routes/ai.ts apps/api/src/__tests__/integration/wispChatCeiling.integration.test.ts
git commit -m "feat(wisp): assert the delegation ceiling before every chat tool call, Tier 1 included (W04 T4)"
```

---

### Task 5: Thread summary at session end

**Files:**
- Modify: `apps/api/src/services/aiAgent.ts:363-373` (`closeSession`)
- Modify: `apps/api/src/services/streamingSessionManager.ts:2405-2435` (the eviction `expired` write)
- Modify: `apps/api/src/services/aiAgentSdk.ts:509-520` (preflight 24 h / 2 h `expired` stamp)
- Test: `apps/api/src/services/wisp/threadSummary.finalize.test.ts`, extend `apps/api/src/__tests__/integration/wispThreadsRls.integration.test.ts`

**Interfaces:**
- Consumes: `finalizeWispSessionSummary(sessionId)` (Task 2).
- Produces: nothing new; every path that moves an `ai_sessions` row to `closed`/`expired` calls `void finalizeWispSessionSummary(sessionId).catch(captureException)` **after** the status write commits (best effort, never fails the close).

- [ ] **Step 1: Write the failing tests**

`threadSummary.finalize.test.ts` (Drizzle mocked):

```ts
it('finalizeWispSessionSummary is a no-op for a session with no wisp_thread_sessions row', ...);     // { updated: false }, no update issued
it('writes the last assistant paragraph to the thread when it differs', ...);                         // { updated: true }
it('does not write when the computed summary equals the stored one (idempotent)', ...);
it('closeSession calls finalizeWispSessionSummary after the status update', ...);                     // in aiAgent tests: mock threadSummary, assert order
```

Integration (append to `wispThreadsRls.integration.test.ts`):

```ts
it('finalize updates only the session's own thread: two partners, two sessions → each thread holds its own paragraph', ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/wisp/threadSummary.finalize.test.ts`
Expected: FAIL — `closeSession` never calls it.

- [ ] **Step 3: Implement** the three call sites. In the eviction sweep, call it per session id inside the existing per-org loop after the `dbWriteExpectingRows` returns, using the returned ids only (a row the user already closed was finalized by `closeSession`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/wisp/threadSummary.finalize.test.ts src/routes/ai_sessions_actions.test.ts && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispThreadsRls.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgent.ts apps/api/src/services/streamingSessionManager.ts apps/api/src/services/aiAgentSdk.ts apps/api/src/services/wisp/threadSummary.finalize.test.ts apps/api/src/__tests__/integration/wispThreadsRls.integration.test.ts
git commit -m "feat(wisp): deterministic thread summary on session close/expiry (W04 T5)"
```

---

### Task 6: Thread routes and the first `requireEntitlement('wisp')` consumer

**Files:**
- Create: `apps/api/src/routes/wispThreads.ts`
- Modify: `apps/api/src/routes/wisp.ts` (W02: `wispRoutes`)
- Test: `apps/api/src/routes/wispThreads.test.ts`, extend W02's `apps/api/src/routes/wisp.test.ts`

**Interfaces:**
- Consumes: `requireEntitlement(key)` (W01 **`middleware/entitlement.ts`**, denial `403 { code: 'entitlement_required', featureKey }`, resolver failure `503 { code: 'entitlement_check_failed' }`); `getActiveGrantForUser(userId, scope)` and `wideningAvailable(grantId)` (W02 `services/wisp/grants.ts`); `wispEnabled()`; `getOrCreateThread` (Task 2); `wispThreads`, `wispThreadSessions`, `aiSessions` tables; `readOwnPartnerAxisRows(partnerId, fn)` (`db/partnerAxisRead.ts:101`) for the thread reads from a partner-scope token; W03's `routes/wisp/memory.ts` (`wispMemoryRoutes`, mounted separately at `/wisp/memory` in `index.ts` because org-scoped tokens may read their own org's memory).
- Produces:

```ts
export const wispThreadRoutes = new Hono();
// GET /api/v1/wisp/thread?orgId=<uuid|omitted>  (mine)
//   200 { data: { thread: WispThread /* incl. focusOrgId */; focusOrgName: string | null; grant: { id, status, orgId, expiresAt, currentRevisionId, budgetCentsPerDay, floorTickMinutes }; wideningAvailable: boolean } }   -- wideningAvailable = await wideningAvailable(grant.id) (W02; spec §4.4); focusOrgName read with readOwnPartnerAxisRows (w00 A24)
//   404 { code: 'no_active_grant' } when getActiveGrantForUser returns null
// GET /api/v1/wisp/thread/:id/sessions?limit=20&cursor=
//   200 { data: Array<{ sessionId, orgId, attachedAt, title: string | null, status }>, nextCursor }   -- only the caller's own grant's thread (403 otherwise, existence-neutral 404)
// PATCH /api/v1/wisp/thread/:id/focus  body { orgId: uuid | null }                                   -- w00 A24
//   200 { data: { focusOrgId: string | null; focusOrgName: string | null } }; 403 { code: 'wisp_outside_ceiling', detail: 'org' } on CeilingViolationError; 409 { code: 'grant_inactive' } on GrantInactiveError; 404 for another user's thread
//   ceiling = await resolveGrantCeiling(grant.id, grant.currentRevisionId); then setThreadFocus(thread.id, orgId, ceiling); writeRouteAudit action 'wisp.thread.focus_changed', resourceType 'wisp_thread', details { from, to }
```

Both routes: `requireScope('partner')` (grants are partner-staff only, spec §4.2), `requirePermission(PERMISSIONS.AI_SESSIONS_USE.resource, PERMISSIONS.AI_SESSIONS_USE.action)` (`ai_sessions:use`, w00 A1 — the `requireAiUse` const in `routes/ai.ts:215` is module-private, so re-declare, do not import), `requireEntitlement('wisp')`. Both are inherited from W02's hub chain; declare them again only if the sub-router is ever mounted elsewhere. Mount in `routes/wisp.ts`: `wispRoutes.use('*', requireEntitlement('wisp'))` after W02's `wispEnabled()` 404 gate and before its grant routes, then `wispRoutes.route('/thread', wispThreadRoutes)`. Also in this task: `wispMemoryRoutes.use('*', requireEntitlement('wisp'))` in W03's `routes/wisp/memory.ts`, directly after its own `wispEnabled()` 404 gate (spec §10: every `/api/v1/wisp/*` route is entitlement-gated; the memory routes are mounted outside the hub).

- [ ] **Step 1: Write the failing route tests** (pattern: `routes/ai_sessions_use_permission.test.ts`; mock `config/env`, `services/entitlements`, `services/wisp/grants`, `services/wisp/threads`, Drizzle):

```ts
it('GET /wisp/thread is 404 when wispEnabled() is false (entitled or not)', ...);
it('GET /wisp/thread is 403 entitlement_required when the partner lacks wisp', ...);
it('GET /wisp/thread is 404 no_active_grant when the user has no grant for the scope', ...);
it('GET /wisp/thread returns the thread for the caller's own active grant (getOrCreateThread called with grant.id) and wideningAvailable from W02', ...);   // wideningAvailable mocked true → payload true; mocked false → false
it('GET /wisp/thread/:id/sessions lists attached sessions newest first and refuses another user's thread', ...);
it('GET /wisp/thread returns thread.focusOrgId and focusOrgName (null when unfocused)', ...);                                                    // w00 A24
it('PATCH /wisp/thread/:id/focus calls setThreadFocus(thread.id, orgId, ceiling) and audits wisp.thread.focus_changed; CeilingViolationError → 403 wisp_outside_ceiling; null clears', ...);
it('PATCH /wisp/thread/:id/focus on another user's thread is 404', ...);
it('org-scoped tokens get 403 from requireScope', ...);
it('every /wisp/* route (W02 grants + W04 thread + W03 memory) runs requireEntitlement — contract: wispRoutes.routes and wispMemoryRoutes.routes all carry the middleware', ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/wispThreads.test.ts src/routes/wisp.test.ts`
Expected: FAIL — module not found / middleware absent.

- [ ] **Step 3: Implement** `wispThreads.ts` (incl. the focus route; `zValidator('json', z.object({ orgId: z.string().guid().nullable() }))`), the two-line mount + middleware in `wisp.ts`, and the one-line `requireEntitlement('wisp')` in `routes/wisp/memory.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/wispThreads.test.ts src/routes/wisp.test.ts src/routes/wisp/memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/wispThreads.ts apps/api/src/routes/wispThreads.test.ts apps/api/src/routes/wisp.ts apps/api/src/routes/wisp.test.ts
git commit -m "feat(wisp): thread routes incl. focus; requireEntitlement('wisp') on every /wisp route (W04 T6)"
```

---

### Task 6b: Thread attachments — store, routes, and `read_artifact` reach (w00 A24; spec §6.1 (2))

**Files:**
- Modify: `apps/api/src/services/wisp/threadAttachments.ts` (stubbed in Task 2; real body here)
- Modify: `apps/api/src/routes/wispThreads.ts` (two routes)
- Modify: `apps/api/src/services/artifacts/artifactService.ts:360-375` (`ArtifactCallerAnchor.wispThreadId?`, `findArtifactForCallerQuery` ownership arm), `apps/api/src/services/artifacts/toolResultCapture.ts:52` (`CaptureScope.wispThreadId?`), `apps/api/src/services/aiTools.ts:729` (anchor built for `read_artifact` carries it), `apps/api/src/services/aiAgentSdkTools.ts:832-834` (`capture` from `captureSession.wispGrant?.threadId`)
- Test: `apps/api/src/services/wisp/threadAttachments.test.ts`, `apps/api/src/routes/wispThreads.test.ts` (extend), `apps/api/src/services/artifacts/artifactService.callerScope.sql.test.ts` (extend — the compiled-SQL suite, so the new arm is proven, not mocked), `apps/api/src/__tests__/integration/wispThreadsRls.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `createArtifact(input: CreateArtifactInput)` (`artifactService.ts:67,156` — `{ orgId, runId: null, sessionId: null, kind: 'input_capture', name, contentType, body: Buffer, maxBytes, createdByTool: 'wisp_thread_attachment', region: breezeRegion() }`; `BlobTooLargeError` / `BlobStorageUnavailableError` from `services/artifacts/blobStorage.ts:86,96`); `redactForCapture(raw)` (`captureRedaction.ts:44`); `sanitizeArtifactName` (`artifactService.ts:108`); `breezeRegion()` (`config/env.ts:254`); `aiArtifactCaptureEnabled()` (as `aiToolsArtifacts.ts` uses it — when false, `POST` answers `503 { code: 'store_unavailable' }`); `c.req.parseBody({ all: true })` + 413 pattern (`routes/tickets/attachments.ts:93,106`); `userRateLimit` (same file, `:227`); `assertWithinCeiling`, `resolveGrantCeiling` (W02); `WispThread`, `setThreadFocus` (Task 2).
- Produces: the `threadAttachments.ts` block in Task 2's contract; routes:

```ts
// POST /api/v1/wisp/thread/:id/attachments        multipart { file, label? } OR json { text, label }   -- userRateLimit('wisp-thread-attachment', 30, 60)
//   orgId = thread.focusOrgId ?? grant.orgId; a partner-wide, unfocused thread → 409 { code: 'focus_required' } (an artifact row needs one org; spec §6 "all organizations is an overview, not a target")
//   decode bytes as UTF-8; NUL byte or invalid UTF-8 → 415 unsupported_type; > 5 MiB → 413 too_large; empty → 400 empty; 21st → 409 too_many
//   text = redactForCapture(decoded); createArtifact({ …, name: `${sanitizeArtifactName(label || file.name)}.redacted.${ext}`, body: Buffer.from(text), maxBytes: THREAD_ATTACHMENT_MAX_BYTES })
//   insert wisp_thread_attachments (thread_id, partner_id, org_id, artifact_id, added_by_user_id = auth.user.id, label) under system ctx after assertWithinCeiling(ceiling, { orgId })
//   201 { data: ThreadAttachment }; writeRouteAudit action 'wisp.thread.attachment_added', resourceType 'wisp_thread_attachment', resourceId <id>, details { artifactId, bytes, contentType }
// GET  /api/v1/wisp/thread/:id/attachments        200 { data: ThreadAttachment[] }  (live only)
```

**Reach (the `read_artifact` path).** `findArtifactForCaller` matches an artifact to the caller's *exact* run or session (`artifactService.ts:417`, Q4: "any session of this user" is deliberately not a match). An attachment is stored with `session_id NULL` and must be readable from every later session on the same thread, so the anchor gains one more exact pointer: `ArtifactCallerAnchor.wispThreadId?: string | null`, and `findArtifactForCallerQuery`'s `ownership` becomes `or(<existing session/run arm>, exists(select 1 from wisp_thread_attachments ta where ta.artifact_id = ai_run_artifacts.id and ta.thread_id = anchor.wispThreadId))` **only when `wispThreadId` is set**; the org, expiry, `export_dataset` and redacted-marker predicates stay. `CaptureScope` gains `wispThreadId?: string | null`; `makeHandler` builds it from `captureSession.wispGrant?.threadId ?? null` (`aiAgentSdkTools.ts:833`; W04 Task 4 put `wispGrant` on `ActiveSession`); `captureContextFrom` ignores it on the **write** side (captures still anchor on the session) and `aiTools.ts:729` copies it onto `context.captureAnchor` for `read_artifact` only. Agent runs never set it (no thread), so W05 assessments are unaffected.

- [ ] **Step 1: Write the failing tests**

```ts
// threadAttachments.test.ts (mock ../artifacts/artifactService, ../artifacts/captureRedaction, ./grantAuthority, Drizzle)
it('addThreadAttachment redacts before createArtifact, names the artifact *.redacted.<ext>, passes maxBytes 5 MiB and createdByTool wisp_thread_attachment', …);
it('refuses the 21st attachment with too_many without calling createArtifact', …);
it('refuses an org outside the ceiling (org_outside_ceiling) before any write', …);
it('maps BlobTooLargeError → too_large and BlobStorageUnavailableError → store_unavailable', …);
it('attachmentSeedLines renders one line per item with the handle and "" for none', …);
// wispThreads.test.ts additions
it('POST /wisp/thread/:id/attachments (multipart) → 201 with the artifact id; binary bytes → 415; > 5 MiB → 413; unfocused partner-wide thread → 409 focus_required', …);
it('POST /wisp/thread/:id/attachments (json text) → 201; GET lists it newest first; another user's thread → 404', …);
// artifactService.callerScope.sql.test.ts additions
it('with wispThreadId the ownership predicate ORs an EXISTS on wisp_thread_attachments keyed by thread_id; org, expiry, export_dataset and redacted-marker predicates remain', …);
it('without wispThreadId the compiled SQL is byte-identical to before (no wisp_thread_attachments reference)', …);
// wispThreadsRls.integration.test.ts additions
it('an attachment uploaded in session 1 is found by findArtifactForCaller from session 2 of the same thread, and NOT from a session on another thread in the same org', …);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/wisp/threadAttachments.test.ts src/routes/wispThreads.test.ts src/services/artifacts/artifactService.callerScope.sql.test.ts`
Expected: FAIL — stub exports throw / routes 404 / no `wisp_thread_attachments` in the SQL.

- [ ] **Step 3: Implement** the service body, the two routes, the anchor plumbing (four files), then run `cd apps/api && npx vitest run src/services/artifacts src/services/aiToolsArtifacts.test.ts src/services/aiAgentSdkTools.verifiedContext.test.ts` to prove the existing capture/anchor suites are unchanged (`verifiedContext.test.ts` pins the options-bag arity — an absent `wispThreadId` must add no key).

- [ ] **Step 4: Run green, including the integration case**

Run: the Step 2 command, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispThreadsRls.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/threadAttachments.ts apps/api/src/services/wisp/threadAttachments.test.ts apps/api/src/routes/wispThreads.ts apps/api/src/routes/wispThreads.test.ts apps/api/src/services/artifacts/artifactService.ts apps/api/src/services/artifacts/artifactService.callerScope.sql.test.ts apps/api/src/services/artifacts/toolResultCapture.ts apps/api/src/services/toolExecutionContext.ts apps/api/src/services/aiTools.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/__tests__/integration/wispThreadsRls.integration.test.ts
git commit -m "feat(wisp): thread attachments as redacted artifacts, readable by handle from later sessions on the thread (W04 T6b)"
```

---

### Task 7: Web — store slice, `WispToggle`, step-up modal, locked state, locales

**Files:**
- Modify: `apps/web/src/stores/aiStore.ts:107` (`createSession` opts), `:322-425` (create body), state shape
- Create: `apps/web/src/components/ai/WispToggle.tsx`, `apps/web/src/components/ai/WispGrantStepUpModal.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/ai.json` (new `wisp` block)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:35` (`TARGET_GLOBS` += the two new files + `WispThreadHeader.tsx` and `WispThreadAttachments.tsx` from Task 8)
- Test: `apps/web/src/components/ai/WispToggle.test.tsx`, `apps/web/src/components/ai/WispGrantStepUpModal.test.tsx`, `apps/web/src/stores/aiStore.wisp.test.ts`

**Interfaces:**
- Consumes: `useEntitlement('wisp')` → `{ state: 'loading' | 'enabled' | 'locked'; limits; source; why; reload }` and `FeatureLock` with props `{ locked, why, upgradeHref?, testId?, children }` (W01, `apps/web/src/hooks/useEntitlement.ts`, `apps/web/src/components/shared/FeatureLock.tsx` — the CTA label is W01's `common:featureLock.upgrade`, not a prop); `mintStepUpGrant({ operation: 'wisp_grant', resource, reauth })` (`apps/web/src/lib/mfaStepUp.ts:64`); `pickReauthTier` (`components/settings/StepUpPrompt.tsx`) and the `discoverTier()` shape from `components/topology/TopologyArmStepUp.tsx`; `runAction` / `ActionError` / `handleActionError`; `useJwtClaims()` (`lib/authScope.ts:92`) for `partnerId`/`scope`; W02 routes `GET /wisp/grants/preview?orgId=` → `{ scope, ceilingSnapshot, ceilingHash }` (w00 A4) and `POST /wisp/grants { orgId: uuid | null, stepUpGrantId }` (W02 Task 9 body — the step-up is minted **before** the first submit; W02 answers `403 { code: 'STEP_UP_REQUIRED' }` when the grant id is missing/stale, which the modal treats as "re-mint and retry once"); step-up resource `{ partnerId, orgId, requestedCeilingHash: ceilingHash }` (W02 `wispGrantStepUpResource`); Task 6 `GET /wisp/thread?orgId=`.
- Produces:

```ts
// aiStore additions
type WispState = { grantId: string; threadId: string; scopeOrgId: string | null; focusOrgId: string | null; focusOrgName: string | null; status: 'active' | 'paused' | 'revoked' | 'expired'; expiresAt: string; summary: string } | null;   // focus*: w00 A24
wisp: WispState;
enterWispMode: (w: NonNullable<WispState>) => Promise<void>;   // sets wisp, then createSession({ wispGrantId: w.grantId, orgId: w.focusOrgId ?? w.scopeOrgId ?? undefined }); a wispFocusOrgId: null in the create response while w.focusOrgId was set ⇒ focus cleared server-side → set focusOrgId null + toast wisp.toast.focusCleared
setWispFocus: (orgId: string | null, orgName: string | null) => Promise<void>;   // runAction PATCH /wisp/thread/:id/focus → on success update wisp.focusOrgId/focusOrgName, then createSession({ wispGrantId, orgId: orgId ?? scopeOrgId ?? undefined }) so the next turn is anchored to the new focus (spec §6.1 "switching focus is a chat action, not a new thread")
exitWispMode: () => Promise<void>;                               // closes the current session, wisp = null
createSession: (opts?: { deviceId?: string; pageContext?: AiPageContext; model?: AiModelChoice; wispGrantId?: string; orgId?: string }) => Promise<void>;

// WispToggle.tsx — default export; props { className?: string }
//   state loading → disabled button; locked → <FeatureLock locked why={t('wisp.locked.why')} upgradeHref="/settings/plan" testId="wisp-toggle-locked">…</FeatureLock> around a disabled toggle (W01 props; CTA copy comes from FeatureLock itself)
//   enabled → button data-testid="wisp-toggle" → opens WispGrantStepUpModal
// WispGrantStepUpModal.tsx — props { open: boolean; defaultOrgId: string | null; onClose(): void; onGranted(w: NonNullable<WispState>): void }
//   scope radio: 'org' (current org) | 'partner' ("All organizations", only when claims.scope === 'partner'); data-testid="wisp-scope-org" / "wisp-scope-partner"
//   submit flow (w00 A4): GET /wisp/grants/preview?orgId= → { ceilingHash } → discoverTier → StepUpPrompt → mintStepUpGrant({ operation: 'wisp_grant', resource: { partnerId, orgId, requestedCeilingHash: ceilingHash }, reauth }) → POST /wisp/grants { orgId, stepUpGrantId } via runAction → GET /wisp/thread?orgId= → onGranted; a 403 STEP_UP_REQUIRED on the POST (reach changed between preview and create) re-runs preview + mint once, then surfaces wisp.modal.stepUpUnavailable
```

Locale keys (en; every other locale gets a translation of the same keys): `wisp.title` "Wisp", `wisp.toggle.turnOn` "Turn on Wisp", `wisp.toggle.turningOn` "Turning on Wisp…", `wisp.locked.why` "Wisp is available on Pro and higher plans.", `wisp.modal.title` "Turn on Wisp", `wisp.modal.scopeOrg` "This organization", `wisp.modal.scopePartner` "All organizations", `wisp.modal.explain` "Wisp works within what you are allowed to do. Confirm it is you to continue.", `wisp.modal.confirm` "Confirm", `wisp.modal.cancel` "Cancel", `wisp.modal.stepUpUnavailable` "Could not verify your factor. Try again.", `wisp.toast.on` "Wisp is on", `wisp.toast.onFailed` "Could not turn on Wisp", `wisp.header.scopeAll` "All organizations", `wisp.header.status.active` "Active", `wisp.header.status.paused` "Paused", `wisp.header.status.revoked` "Revoked", `wisp.header.status.expired` "Expired", `wisp.header.refresh` "Refresh grant", `wisp.header.revoke` "Turn off Wisp", `wisp.header.revokeConfirm` "Turn off Wisp for this scope? Open threads stay readable.", `wisp.toast.off` "Wisp is off", `wisp.toast.offFailed` "Could not turn off Wisp", `wisp.toast.refreshed` "Grant refreshed", `wisp.toast.refreshFailed` "Could not refresh the grant", `wisp.header.widening` "You can do more than this grant allows — refresh it to let Wisp keep up.", `wisp.settings.title` "Budget and check-in", `wisp.settings.budget` "Daily budget (¢)", `wisp.settings.tick` "Check-in every (minutes)", `wisp.settings.save` "Save", `wisp.toast.settingsSaved` "Wisp settings saved", `wisp.toast.settingsFailed` "Could not save Wisp settings". Consulting mode (w00 A24): `wisp.focus.label` "Working on", `wisp.focus.none` "No customer focus", `wisp.focus.pick` "Focus on a customer…", `wisp.focus.clear` "Clear focus", `wisp.toast.focusSet` "Wisp is now working on {{org}}", `wisp.toast.focusCleared` "Customer focus cleared", `wisp.toast.focusFailed` "Could not change focus", `wisp.attachments.title` "Attached to this thread", `wisp.attachments.drop` "Drop an email thread, .eml or CSV here, or paste text", `wisp.attachments.paste` "Paste text", `wisp.attachments.label` "Label", `wisp.attachments.add` "Attach", `wisp.attachments.empty` "Nothing attached yet", `wisp.attachments.expires` "Expires {{date}}", `wisp.attachments.limits` "Up to 20 files, 5 MB each, text only", `wisp.attachments.focusRequired` "Pick a customer focus before attaching", `wisp.toast.attached` "Attached to the thread", `wisp.toast.attachFailed` "Could not attach", `wisp.toast.attachTooLarge` "That file is over 5 MB", `wisp.toast.attachUnsupported` "Only text files can be attached".

- [ ] **Step 1: Write the failing tests**

`aiStore.wisp.test.ts`:

```ts
it('createSession sends wispGrantId and orgId when given', ...);                     // fetchWithAuth body contains both
it('createSession without wisp options sends a body without wispGrantId (unchanged)', ...);
it('enterWispMode sets wisp then creates a session with the grant', ...);
it('exitWispMode closes the session and clears wisp', ...);
it('enterWispMode under a focused thread sends orgId = focusOrgId; a create response with wispFocusOrgId null clears wisp.focusOrgId', ...);   // w00 A24
it('setWispFocus PATCHes /wisp/thread/:id/focus through runAction, updates focusOrgId/focusOrgName and creates a session anchored to the new org', ...);
```

`WispToggle.test.tsx` (mock `@/hooks/useEntitlement`, `@/stores/aiStore`, `./WispGrantStepUpModal`):

```ts
it('renders the locked state with the plan copy and CTA when state is "locked"', () => { … expect(screen.getByTestId('wisp-toggle-locked')).toBeInTheDocument(); expect(screen.getByText('Wisp is available on Pro and higher plans.')).toBeInTheDocument(); });
it('renders a disabled control while loading (never enabled on fetch failure — D10 polarity)', ...);
it('opens the step-up modal when enabled and clicked', ...);
```

`WispGrantStepUpModal.test.tsx` (mock `@/lib/mfaStepUp`, `@/stores/auth` fetchWithAuth, `@/lib/runAction`):

```ts
it('submit fetches /wisp/grants/preview?orgId= first, then mints a wisp_grant step-up with resource { partnerId, orgId, requestedCeilingHash: ceilingHash }, then posts /wisp/grants { orgId, stepUpGrantId }', ...);
it('a 403 STEP_UP_REQUIRED on the POST re-runs preview + mint once, then shows wisp.modal.stepUpUnavailable', ...);
it('then fetches /wisp/thread?orgId= and calls onGranted with grant + thread', ...);
it('hides the "All organizations" option for an org-scoped token', ...);
it('a non-step-up failure toasts through runAction and keeps the modal open', ...);
```

Also add the four new component files to `TARGET_GLOBS` so `no-silent-mutations.test.ts` guards them.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/ai/WispToggle.test.tsx src/components/ai/WispGrantStepUpModal.test.tsx src/stores/aiStore.wisp.test.ts src/lib/__tests__/no-silent-mutations.test.ts`
Expected: FAIL — modules missing; `no-silent-mutations` fails on the listed-but-absent files.

- [ ] **Step 3: Implement** the store slice, the two components and the `wisp` locale block in all eight files.

- [ ] **Step 4: Run to verify they pass, plus locale parity**

Run: `cd apps/web && npx vitest run src/components/ai/WispToggle.test.tsx src/components/ai/WispGrantStepUpModal.test.tsx src/stores/aiStore.wisp.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/stores/aiStore.ts apps/web/src/stores/aiStore.wisp.test.ts apps/web/src/components/ai/WispToggle.tsx apps/web/src/components/ai/WispToggle.test.tsx apps/web/src/components/ai/WispGrantStepUpModal.tsx apps/web/src/components/ai/WispGrantStepUpModal.test.tsx apps/web/src/locales/*/ai.json apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web/wisp): Wisp toggle with step-up grant modal, locked state, locales (W04 T7)"
```

---

### Task 8: Web — `WispThreadHeader` and the sidebar's Wisp mode

**Files:**
- Create: `apps/web/src/components/ai/WispThreadHeader.tsx`, `apps/web/src/components/ai/WispThreadAttachments.tsx` (w00 A24; added to `TARGET_GLOBS` in Task 7's edit of `no-silent-mutations.test.ts`)
- Modify: `apps/web/src/components/ai/AiChatSidebar.tsx:183-245` (header), `:356-361` (above the context badge)
- Test: `apps/web/src/components/ai/WispThreadHeader.test.tsx`, `apps/web/src/components/ai/WispThreadAttachments.test.tsx`, extend `apps/web/src/components/ai/AiChatSidebar.test.tsx`

**Interfaces:**
- Consumes: store `wisp`, `exitWispMode`, `enterWispMode` (Task 7); W02 `POST /wisp/grants/:id/revoke`, `POST /wisp/grants/:id/refresh { stepUpGrantId }` (same preview → mint → submit handshake as the create), `PATCH /wisp/grants/:id/settings { budgetCentsPerDay?, floorTickMinutes? }` (w00 A6); `useEntitlement('wisp').limits` as `{ budgetCentsPerDayCeiling, minFloorTickMinutes }` (W01); `ConfirmDialog` (`components/shared/ConfirmDialog.tsx`).
- Produces:

```ts
// WispThreadHeader.tsx — default export; props { wisp: NonNullable<WispState>; orgName: string | null; wideningAvailable: boolean }
//   WispState gains budgetCentsPerDay: number; floorTickMinutes: number (from GET /wisp/thread's grant)
//   renders: scope label (orgName, or t('wisp.header.scopeAll')), status badge data-testid="wisp-grant-status" (text from wisp.header.status.*),
//   "Refresh grant" button data-testid="wisp-refresh-grant" — always rendered; primary + the wisp.header.widening line (data-testid="wisp-widening") when wideningAvailable (spec §4.4 "one-tap refresh my grant"), secondary otherwise;
//   "Turn off Wisp" button data-testid="wisp-revoke" → ConfirmDialog → runAction POST /wisp/grants/:id/revoke → exitWispMode()
//   refresh: preview → mint → runAction POST /wisp/grants/:id/refresh { stepUpGrantId } → updates wisp.status/expiresAt
//   settings popover data-testid="wisp-settings" (spec §9 "one-tap raise within plan ceiling"): budget number input bounded [0, limits.budgetCentsPerDayCeiling], tick input bounded [max(15, limits.minFloorTickMinutes), 240]; Save → runAction PATCH /wisp/grants/:id/settings → updates wisp.budgetCentsPerDay/floorTickMinutes; the server is the authority on the 5× plan-default bound (a 400 SETTINGS_OUT_OF_BOUNDS toasts through runAction)
//   focus switcher (w00 A24) data-testid="wisp-focus": a <select> labelled t('wisp.focus.label') listing the orgs the token can reach (load them the way `useReportTargetOrg` does, `components/reports/OrgPickerField.tsx:51`; for an org-scoped grant the list is that one org) plus t('wisp.focus.none'); onChange → store.setWispFocus(orgId, orgName); shows t('wisp.focus.none') when wisp.focusOrgId is null
// WispThreadAttachments.tsx — default export; props { wisp: NonNullable<WispState> }   (w00 A24)
//   loads GET /wisp/thread/:id/attachments on mount and after each add; renders the list (label, size, t('wisp.attachments.expires')) or t('wisp.attachments.empty')
//   drop zone data-testid="wisp-attachment-drop" (onDragOver/onDrop pattern: components/organizations/BulkContactImport.tsx) + a "Paste text" textarea with a label input;
//   add → runAction({ request: () => fetchWithAuth(`/wisp/thread/${threadId}/attachments`, { method: 'POST', body: FormData | JSON }), successMessage: t('wisp.toast.attached'), errorFallback: t('wisp.toast.attachFailed') });
//   413 → t('wisp.toast.attachTooLarge'), 415 → t('wisp.toast.attachUnsupported'), 409 focus_required → t('wisp.attachments.focusRequired') (map by ActionError.status/code before the fallback);
//   the whole component is disabled with t('wisp.attachments.focusRequired') when wisp.scopeOrgId === null && wisp.focusOrgId === null; client-side pre-check: file.size > 5 MiB → toast without a request
// AiChatSidebar.tsx: when `wisp` is set the header title reads t('wisp.title') and the panel shows <WispThreadHeader> under the header and <WispThreadAttachments> collapsed beneath it (disclosure data-testid="wisp-attachments-toggle"); when unset and not showHistory, <WispToggle> sits in the header's right-hand control group before the History button. Mode is hidden for helper/client surfaces (the sidebar already gates on ai_sessions:use).
```

- [ ] **Step 1: Write the failing tests**

`WispThreadHeader.test.tsx`:

```ts
it('shows "All organizations" for a partner-wide grant and the org name for an org grant', ...);
it('shows the status badge text for each status', ...);
it('revoke asks for confirmation, posts /wisp/grants/:id/revoke through runAction and exits Wisp mode', ...);
it('refresh button is primary with the widening line when wideningAvailable and secondary without it otherwise', ...);
it('settings popover PATCHes /wisp/grants/:id/settings through runAction with only the changed keys and clamps inputs to the entitlement limits', ...);
it('focus switcher shows "No customer focus" when focusOrgId is null, the org name when set, and calls setWispFocus(orgId, name) on change', ...);   // w00 A24
```

`WispThreadAttachments.test.tsx` (mock `@/stores/auth` fetchWithAuth, `@/lib/runAction`):

```ts
it('lists attachments from GET /wisp/thread/:id/attachments and shows the empty state when none', ...);
it('dropping a text file POSTs multipart through runAction and reloads the list', ...);
it('pasted text POSTs JSON { text, label } through runAction', ...);
it('a 6 MB file is refused client-side with wisp.toast.attachTooLarge and no request', ...);
it('is disabled with the focus-required copy for a partner-wide thread with no focus', ...);
```

`AiChatSidebar.test.tsx` additions (extend `baseState` with `wisp: null, enterWispMode: noop, exitWispMode: noop`; mock `./WispToggle`, `./WispThreadHeader`):

```ts
it('renders WispToggle in the header when wisp is null', ...);
it('renders WispThreadHeader and the Wisp title when wisp is set', ...);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/ai/WispThreadHeader.test.tsx src/components/ai/WispThreadAttachments.test.tsx src/components/ai/AiChatSidebar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the header component (with the focus switcher), the attachments component and the sidebar wiring.

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/web && npx vitest run src/components/ai/WispThreadHeader.test.tsx src/components/ai/WispThreadAttachments.test.tsx src/components/ai/AiChatSidebar.test.tsx src/components/ai/AiChatSidebar.firstMessage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ai/WispThreadHeader.tsx apps/web/src/components/ai/WispThreadHeader.test.tsx apps/web/src/components/ai/WispThreadAttachments.tsx apps/web/src/components/ai/WispThreadAttachments.test.tsx apps/web/src/components/ai/AiChatSidebar.tsx apps/web/src/components/ai/AiChatSidebar.test.tsx
git commit -m "feat(web/wisp): thread header (scope, focus, grant status, refresh, revoke), attachments drop zone, chat panel Wisp mode (W04 T8)"
```

---

### Task 9: Full verification and PR body

**Files:** none new.

- [ ] **Step 1: Typecheck both apps** (12 GB heap; check the exit code, never pipe to `tail`)

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo exit=$?` and the same in `apps/web`.
Expected: `exit=0`.

- [ ] **Step 2: Run the full unit suites**

Run: `pnpm --filter @breeze/api test --run` and `pnpm --filter @breeze/web test --run`
Expected: PASS (the `orgMerge.test.ts` "no merge policy registered" guard only reds in the FULL run).

- [ ] **Step 3: Run the contract suites under the test stack** (Task 1 Step 7 again, plus the two integration files from Tasks 1/4/5)

Expected: PASS. Then `pnpm test-stack down`.

- [ ] **Step 4: Flag-off smoke** — with `BREEZE_WISP_ENABLED` unset: `POST /ai/sessions` without `wispGrantId` behaves exactly as before; `GET /api/v1/wisp/thread` is 404; the web toggle is hidden when `GET /partner/me/entitlements` lacks `wisp` enabled (locked) and the chat is otherwise unchanged.

- [ ] **Step 5: PR body** states: flag off = no behaviour change; tenancy registrations added (`PARTNER_TENANT_TABLES` ×2, `CORE_ORG_CASCADE_DELETE_ORDER` ×2, `orgMergeRegistry` ×2 (+ the `focus_org_id` disposition), `CORE_TENANT_EXPORT_POLICY` ×2 incl. the two `ai_sessions` columns); contract names consumed (`requireEntitlement`, `useEntitlement`, `FeatureLock`, `createGrant`/`refreshGrant`/`getActiveGrantForUser`/`resolveGrantCeiling`/`assertWithinCeiling`, `recallForGrant`/`renderMemoryForPrompt`, `createArtifact`/`redactForCapture`/`findArtifactForCaller`) and introduced (`getOrCreateThread`, `attachSession`, `updateThreadSummary`, `seedContextForSession`, `setThreadFocus`, `addThreadAttachment`/`listThreadAttachments`, `wispGrantId` on session create, `ArtifactCallerAnchor.wispThreadId`); the settings-rule-9 line is "no setting added" (no `pages/settings/**` touched). `Closes #<W04 sub-issue>`.

- [ ] **Step 6: Commit** any verification-driven fixes with their own messages; no empty commit.

---

## Self-review notes

- **Spec coverage.** §4.3 chat bullet → Task 4; §5 web door + locked affordances → Tasks 7–8; §6 threads, join table, seed-not-transcript, overview-vs-effect → Tasks 1–3; §10 entitlement first consumer + `useEntitlement`/`FeatureLock` → Tasks 6–7; §14 core placement `services/wisp/` → all; w00 "Threads (W04)" exports → Task 2 verbatim; session limits unchanged → Global Constraints; mobile reuse of the `wispGrantId` contract (w00 reconciliation 5) → Task 3 adds no web-only field.
- **Type consistency.** `WispSessionGrant` (Task 4) is what `getOrCreate` carries; `ValidatedWispGrant` (Task 3) is the create-time shape; `WispState` (Task 7) is the web mirror. `WispThread` matches w00 field-for-field.
- **Proportion.** Spec sections consumed ≈ 60 lines; w00 block ≈ 10; this plan carries the schema, the error vocabulary, the hook placement argument, the test names and the copy — the parts an implementer cannot derive.

## Conflicts found (w00 / spec / code)

1. **Where the per-tool hook goes.** w00 says `makeSessionAwareHandler consults resolveGrantCeiling…`; in code that wrapper covers only M365/Google tools. The single choke point both wrappers share is `createSessionPreToolUse` (`aiAgentSdk.ts:809`). Behaviour-level, so the spec ("before every tool call, Tier 1 included") wins; the gate lives in `createSessionPreToolUse` before `checkGuardrails`. w00 should be corrected to name it.
2. **Seed is dropped on turns with `pageContext`.** w00 says the seed is "appended to the system prompt"; `aiAgentSdk.ts:567` rebuilds the prompt and ignores the stored one whenever a message carries `pageContext`. Task 4 re-seeds in that branch.
3. **`wisp_thread_sessions` column list.** w00 names `(thread_id, session_id, org_id, attached_at)`; shape 3 needs `partner_id` on the row for `breeze_has_partner_access`. Added, nothing renamed.
4. **Continuations (#7603)** have no grant carry; refused for Wisp sessions in W04.
5. **`wisp_grants` `UNIQUE (id, partner_id)`** is assumed from W02 (needed for the composite thread FK); Task 1 adds it idempotently if absent.
6. **Step-up resource shape** for `wisp_grant` is W02's (`routes/auth/schemas.ts`): `{ partnerId, orgId, requestedCeilingHash }`, with the hash obtained from `GET /wisp/grants/preview` (w00 A4). Resolved by the reviewer: Task 7's modal follows W02 (preview → mint → submit); there is no "submit without a step-up first" handshake.

## Calls made by the planner

1. Hook placement: `createSessionPreToolUse`, not `makeSessionAwareHandler` (conflict 1).
2. Ceiling org check uses `input.orgId` when present, else the session org, **and** structurally narrows `toolAuth.accessibleOrgIds` to `ceiling.orgIds` for the call, so device-targeted reads resolved inside tools are bounded by RLS/org conditions rather than by input parsing.
3. Permission term: `requiredPermissionKeys` derived from `TOOL_PERMISSIONS` via the (newly exported) `resolveToolPermissionRequirements`; no mapping → no permission check here (the existing RBAC step still denies).
4. Refusal surfaces as the tool's result text (`preToolUseDenialResult`) with fixed copy per `detail`, plus an audit event `wisp.ceiling_refused`; no new SSE event type.
5. Grant columns live on `ai_sessions` (`wisp_grant_id`, `wisp_grant_revision_id`, FKs in SQL only) rather than in `context_snapshot`; thread linkage stays in the join table (spec §14 left this open; w00 chose the join table).
6. Deterministic summary = last paragraph of the last assistant message, replaced (not appended) on each close/expiry, ≤ 4 000 chars; stored summary unchanged when the session produced no assistant text.
7. `wideningAvailable` in `GET /wisp/thread` is W02's `wideningAvailable(grantId)` (live reach ⊋ current snapshot); the "Refresh grant" CTA is always present and becomes the primary action with an explanatory line when it is true (spec §4.4).
8. Threads/thread-sessions service functions run under `withSystemDbAccessContext` after caller authorisation (partner-axis rows are invisible to org-scoped request contexts); route reads use `readOwnPartnerAxisRows`.
9. Thread routes are `requireScope('partner')` + `ai_sessions:use` + `requireEntitlement('wisp')`; no partner-admin "all threads" listing in this wave.
10. Session finalize is best-effort and idempotent on all three end paths (close, eviction, preflight expiry); it never fails the close.
11. Locale block lives in `ai.json` under `wisp.*` (no new namespace); eight locale files.
12. Web scope choice lives in the step-up modal (org vs all organizations); partner-wide sessions anchor to the current org through the unchanged `createSession` chain.

### Reconciliation edits (reviewer)

- `narrowAuthToCeiling` now stamps `AuthContext.wispGrant = { grantId, grantRevisionId }` (w00 A2): W04 is the chat-side populator that W03's tools and W07's `launch_specialist` rely on; test added.
- Task 6 consumes `requireEntitlement` from W01's `middleware/entitlement.ts` (not `auth.ts`); `requireAiUse` is module-private in `routes/ai.ts` → use `requirePermission(ai_sessions:use)` (w00 A1).
- Task 6 also attaches `requireEntitlement('wisp')` to W03's `routes/wisp/memory.ts` and extends the route contract test to it (spec §10: every `/wisp/*` route).
- `wideningAvailable` is W02's real detector (spec §4.4), no longer a literal `false`; header shows the widening line; `GET /wisp/thread` grant payload gains `budgetCentsPerDay`/`floorTickMinutes`.
- Task 7: `FeatureLock` call uses W01's actual props (`locked`, `why`, `upgradeHref`, `testId`); `wisp.locked.cta` key dropped (CTA copy is W01's). Modal follows W02's handshake: `GET /wisp/grants/preview` → mint with `requestedCeilingHash: ceilingHash` → `POST /wisp/grants { orgId, stepUpGrantId }` (w00 A4; W02 body shape). Tests rewritten to match.
- Task 8: refresh uses the same handshake; added the budget/tick settings popover calling `PATCH /wisp/grants/:id/settings` with bounds from `useEntitlement('wisp').limits` (spec §9 one-tap raise; w00 A6), plus locale keys and a test.
- Removed the "threadIdForSession? — No" aside in Task 4; `lookupWispGrant(dbSession)` in `chatCeiling.ts` is the decision.
- w00 A24 (consulting mode, spec §6.1 (1)–(2)) — **focus:** `wisp_threads.focus_org_id` in the same migration (composite deferrable FK with column-list `ON DELETE SET NULL (focus_org_id)`, PG 15+; RLS-suite case) (Task 1); `WispThread.focusOrgId`, `setThreadFocus(threadId, orgId | null, ceiling)` ceiling-checked before the write, `seedContextForSession` recalls `{ owners: ['user','org'], orgId: focus }` then `{ owners: ['partner'] }` and prints a Focus line (Task 2); session create anchors to the focus org, `focus_mismatch` 409 for a conflicting explicit `orgId`, a focus outside the live ceiling is cleared and reported as `wispFocusOrgId: null` (Task 3); `GET /wisp/thread` returns `focusOrgId`/`focusOrgName`, `PATCH /wisp/thread/:id/focus` audited (Task 6); `WispState.focusOrgId/focusOrgName`, `setWispFocus`, header `<select>` switcher + locale keys (Tasks 7–8). **Attachments:** new table `wisp_thread_attachments` (shape 1, partner denorm, composite FKs to `wisp_threads`, `organizations`, `ai_run_artifacts(id, org_id)` — the latter unique index added idempotently; full cascade/merge/export ceremony) (Task 1); new **Task 6b** — `threadAttachments.ts` (`createArtifact` after `redactForCapture`, `kind: 'input_capture'` with the `.redacted.` marker, `createdByTool: 'wisp_thread_attachment'`, 20 / 5 MiB caps, text-only), `POST|GET /wisp/thread/:id/attachments`, and the `read_artifact` reach via `ArtifactCallerAnchor.wispThreadId` + an `EXISTS wisp_thread_attachments` arm in `findArtifactForCallerQuery` proven in the compiled-SQL suite; attachments are listed by handle in the session seed (Task 2); `WispThreadAttachments.tsx` drop zone + paste through `runAction`, locale keys, `TARGET_GLOBS` (Tasks 7–8). Planner calls: an unfocused partner-wide thread cannot take attachments (`focus_required`) because an artifact row needs one org; retention is the store's 30-day default; attachment deletion is a follow-up.
- w00 A23 (populator side): `narrowAuthToCeiling(auth, ceiling, sessionId?)` stamps `wispGrant.sessionId` from `session.breezeSessionId` so W03's `remember` can write `source_session_id` (Task 4; test added).


## 2026-10-23 note (w00 A32, A35)

- W05 adds `spentTodayCents` and `budgetResetsAt` to this wave's `GET /wisp/thread` grant block (A32); W04 ships without them and must not reject unknown fields client-side.
- W08 rebuilds the full-page `/workspace` AI Assistant as the Wisp home (A35, spec §17.2). This wave's docked-sidebar Wisp mode stays the web door until W08 lands and is then demoted to an "open in Wisp" affordance; nothing in this plan changes.
