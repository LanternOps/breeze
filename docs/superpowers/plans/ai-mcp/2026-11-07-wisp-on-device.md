---
tracking_issue: LanternOps/breeze#11314
---

# Wisp on Device Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Wisp in Breeze Assist so it can:
- run a model-free care loop: check-ins, schedule-a-night maintenance, escalation;
- be the end user's first line of support, under one MSP security dial;
- prove who the user is with an agent-attested OS principal plus an optional Entra sign-in;
- bill against its own on-device AI allowance.

**Architecture:**
- **Two doors.** The device door is a new authority. It comes from the helper configuration policy, never from a technician `wisp_grant`. It is authenticated by server-minted, per-(device, principal) helper tokens, which the agent requests for kernel-verified Assist sessions.
- **Care loop.** A deterministic worker owns care items and proposes slots. Asks and outcomes travel as new prompt-host kinds. The user's choice comes back as a new agent→API relay message, `device_door_prompt_action`. Fix consent (`fix.confirm`) and ticket confirmation (`ticket.confirm`) reuse that relay, and fix consent adds a single-use challenge.
- **Chat.** The existing helper chat route gains a Wisp persona, a device thread, a `device` budget namespace with an independent allowance, recipe and knowledge tools, and an AI-door path through the existing remote-session dialogs.

**Tech Stack:**
- API: Hono/TypeScript, PostgreSQL with hand-written migrations, Drizzle (queries only), BullMQ, Vitest (unit and real-DB integration).
- Agent: Go.
- Assist: Tauri, Rust and React (`apps/helper`).
- Web: Astro + React.
- Shared: zod validators and the prompt catalog JSON.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-29-wisp-on-device-design.md` (approved 2026-11-07, PR #11309). Every section reference (§) below points into it.

**Entry condition:**
- Do not start W01 until #10425 (Wisp self-knowledge and closed loops) and #10223 (dialogs W09) are closed (Todd's 10-25 rule).
- At each wave start, `git fetch` and re-check every `file:line` this plan cites. They were taken from main at `6c2e80589c` (2026-11-07).

## Global Constraints

- **Rigor:** high for every wave. They touch auth, RLS, migrations, billing and agent-shipped code (global CLAUDE.md). Red test first, one independent review round per wave.
- **Device-door authority** = helper policy tier ∩ device pin ∩ PAM ∩ enabled (§4.1). It never reads `wisp_grants`.
- **Enablement:** `wispEnabled()` (`config/env.ts:372`) ∧ `hasEntitlement(partnerId, 'wisp')` (`services/entitlements.ts:317`) ∧ `getPartnerSettings(partnerId).enabled` (`services/wisp/partnerSettings.ts:61`) ∧ policy `assistantMode = 'wisp'`. Otherwise today's classic Assist chat is byte-for-byte unchanged.
- **`send_endpoint_message`** stays in `AGENT_HUMAN_ONLY_TOOLS` (`services/aiToolExposure.ts:52,64`). Do not touch it.
- **Untrusted text.** Device-door text that technician-side AI reads goes through `wrapUntrustedData` (`services/aiInputSanitizer.ts:289`). Device-door text can never widen a grant, publish memory or satisfy a PAM approval.
- **Prompt kinds:** Breeze copy class, catalog strings only, typed params only, all 8 locales. Locales: `en, de-DE, es-419, fr-FR, fr-CA, it-IT, pt-BR, tr-TR` (`packages/shared/src/promptCatalog/negotiate.ts:9`). Each new kind ships **off** in `DEFAULT_ENABLED_PROMPT_KINDS` (`services/promptHostConfig.ts:34`).
- **New kinds:** `care.checkin`, `care.schedule`, `care.reminder`, `fix.confirm`, `ticket.confirm`. Register a kind in 5 places:
  - `agent/internal/promptkinds/registry.go` `Specs()` (append-only);
  - `agent/internal/ipc/prompt_kinds.go:29` `promptKindClasses`;
  - `packages/shared/src/promptHost/kinds.ts:104` `PROMPT_KINDS`;
  - `apps/helper/src-tauri/src/ipc/prompt.rs:52` `ADVERTISED_PROMPT_KINDS`;
  - `apps/helper/src/prompt/kinds/registry.ts` `CARDS`.

  Catalog JSON lives in `packages/shared/src/promptCatalog/catalog/` and the agent embeds a copy in `agent/internal/promptcatalog/catalog/`. Keep the two copies byte-identical.
- **Assistant display name:** `"{partner name} Assistant"` from the server-resolved prompt identity. An org-level policy writer cannot rename it.
- **Enum values (exact):**

  | Concept | Values |
  |---|---|
  | `assistantMode` | `classic` \| `wisp` (default `classic`) |
  | `permissionLevel` | `advice` \| `basic` \| `standard` \| `extended` |
  | `checkinCadence` | `off` \| `monthly` \| `every_two_weeks` \| `weekly` (default `monthly`) |
  | `escalationThreshold` | integer 1–10 (default `3`) |
  | Care statuses | `open` \| `asked` \| `scheduled` \| `resolved` \| `escalated` \| `suppressed` |
  | Live care statuses | `open`, `asked`, `scheduled`, `escalated` |
  | Recipe risk classes | `low` \| `elevated` |
  | Legit verdicts | `looks_suspicious` \| `no_red_flags_found` \| `cant_tell` |
  | Reboot source (new) | `user_scheduled` |
  | Budget namespace (new) | `device` |
- **Migrations:**
  - Name after the newest committed migration. Today that is `2027-01-22-210000-*`; re-check `origin/main` before every push.
  - `YYYY-MM-DD-HHMMSS-<slug>.sql`, idempotent, no `BEGIN`/`COMMIT`.
  - Row writes only after `SELECT set_config('breeze.scope', 'system', true);`.
  - Forced RLS and policies in the migration that creates each table.
  - Composite org FKs are `DEFERRABLE INITIALLY IMMEDIATE`.
  - Then run `pnpm db:check-drift`.
  - Parallel wave PRs rename their unshipped migrations before merge.
- **New org tables** are registered in `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:258`), `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:51`), and the device lists in `routes/devices/core.ts` (`:321`, `:460`, `:484`, `:679`). A `jsonb` column is `excludedOpen`.
- **Device move** (§5.1): care items, principal tokens, consent challenges and usage profiles are **deleted** on move (`CORE_DEVICE_ORG_MOVE_DELETE_TABLES`). Device threads, device-door ticket links and `device_ai_usage` are **not restamped**. They stay with the source org, the `fix_outcomes` precedent: no FK on `device_id` for usage, and threads are closed.
- **New agent command** registration:
  - API: `services/commandTypes.ts`, `services/commandOfflinePolicy.ts` (explicit TTL class), `services/partnerTrust.ts`.
  - Agent: `handlerRegistry` `init()` entry; `agent/internal/privilege/check.go` if it needs privilege.
- **Locales:** a new web or Assist locale key goes into all 8 locales.
- **Commands:**
  - API unit: `cd apps/api && npx vitest run <file>`.
  - API integration: `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts <file>`.
  - Agent: `cd agent && go test -race ./internal/<pkg>/...`.
  - Assist: `pnpm --filter @breeze/helper test --run <path>` and `cd apps/helper/src-tauri && cargo test <name>`.
  - API typecheck: `NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --build tsconfig.tests.json`. Check the exit code; never pipe it to `tail`.
- **Settings Rule 9:** every PR that adds a policy field carries the §8 table row in its description.

## Review Focus

1. **Shared computer, second person signs in.** Expected: principal B's token lists none of principal A's chat sessions, messages, screenshots, threads, per-person care items or tickets. Pinned by Task 5, test `principal B sees none of principal A's helper chat data`.
2. **A day of accidental dismissals.** Expected: Esc or close on one check-in's card counts as unanswered at most once, and three dismissals inside one check-in cycle never escalate. Pinned by Task 14, test `dismissals inside one check-in count once and never escalate`.
3. **The chosen night fails** (lid closed, unplugged, offline). Expected: the item goes back to `open`, `declines_count` and `unanswered_count` are unchanged, and no deferral is consumed. Pinned by Task 15, test `failed night reopens the item without moving counters or deferrals`.
4. **The on-device cap is exhausted mid-day.** Expected: technicians' AI is still admitted, and the user can still file a ticket through the deterministic form with no model call. Pinned by Task 7, test `technician admission ignores device spend at the device cap`, and Task 18, test `create_ticket form works with no model admission`.
5. **A stale, replayed or altered fix consent.** Expected: a `fix.confirm` action after expiry, a second use of the same challenge, a different principal, or a recipe-parameter digest mismatch is denied and nothing runs. Pinned by Task 24, test `consent challenge rejects expired, replayed, wrong-principal and digest-mismatch actions`.

---

## Wave W01: Identity and foundations

### Task 1: Device-door policy fields, validator and resolver

**Files:**
- Create: `packages/shared/src/types/wispOnDevice.ts`, `packages/shared/src/validators/helperPolicySettings.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/index.ts` (exports), `apps/api/src/services/helperToolFilter.ts:10`, `apps/api/src/services/helperPermissions.ts:14-108`, `apps/api/src/routes/helper/index.ts:66`, `apps/api/src/routes/configurationPolicies/featureLinks.ts:265,669` (validation branch modelled on the pam branch at `:381`)
- Test: `apps/api/src/services/helperPermissions.test.ts`, `apps/api/src/routes/configurationPolicies/featureLinks.test.ts`

**Interfaces:**
- Produces:
  - `ASSISTANT_MODES`, `HELPER_PERMISSION_LEVELS`, `CHECKIN_CADENCES`, `CARE_KINDS`, `CARE_STATUSES`, `CARE_LIVE_STATUSES`, `RECIPE_RISK_CLASSES`, `LEGIT_VERDICTS` (`as const` arrays) plus their union types.
  - `helperInlineSettingsSchema` (zod; passthrough for today's fields; new optional `permissionLevel`, `assistantMode`, `checkinCadence`, `escalationThreshold`).
  - `type HelperPermissionLevel = 'advice' | 'basic' | 'standard' | 'extended'`.
  - `interface DeviceDoorPolicy { permissionLevel; assistantMode; checkinCadence; escalationThreshold }`.
  - `resolveDeviceDoorPolicy(deviceId: string): Promise<DeviceDoorPolicy>`.

- [ ] **Red:** in `helperPermissions.test.ts`, add:
  - `resolveDeviceDoorPolicy returns defaults with no policy`: expects `{permissionLevel:'basic', assistantMode:'classic', checkinCadence:'monthly', escalationThreshold:3}`.
  - `resolveDeviceDoorPolicy takes the highest-priority assignment per field`.
  - `resolveDeviceDoorPolicy ignores agent-reported group membership`: reuses the `resolveExecutionSafeGroupIds` guard at `:63-73`.
  - `normalizeHelperPermissionLevel accepts advice`.

  In `featureLinks.test.ts`, add `rejects helper inline settings with checkinCadence 'daily'` → 400.
- [ ] **Run:** `cd apps/api && npx vitest run src/services/helperPermissions.test.ts src/routes/configurationPolicies/featureLinks.test.ts` → FAIL.
- [ ] **Green:**
  - Reconcile the two defaults to one `DEFAULT_HELPER_PERMISSION_LEVEL = 'basic'`, the value the live route uses. Delete the route-local `DEFAULT_PERMISSION_LEVEL`.
  - `resolveDeviceDoorPolicy` reuses the existing effective-feature-link query; do not write a second query.
  - `LEVEL_PRIORITY` gains `advice` as the lowest priority.
- [ ] **Run:** same command → PASS; typecheck → exit 0.
- [ ] **Commit:** `feat(helper): device-door policy fields and resolver (W01)`.

### Task 2: "Wisp on this device" section in HelperTab

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx:9-20,87,104`, web locale files (8)
- Test: `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.test.tsx`

**Interfaces:**
- Consumes: `helperInlineSettingsSchema` and the enums (Task 1).

- [ ] **Red:** add these tests:
  - `shows Wisp on this device with mode, support tier (incl. Advice), check-in frequency and escalation threshold`.
  - `saves the four fields into inline settings`.
  - `shows inherited value and its source when blank` (settings Rule 4).
  - `warns that Fixes needs a PAM rule when the org's unmatched verdict is auto_deny`.
- [ ] **Run:** `pnpm --filter @breeze/web test --run src/components/configurationPolicies/featureTabs/HelperTab.test.tsx` → FAIL.
- [ ] **Green:**
  - The section label is exactly "Wisp on this device".
  - Hide the mode, cadence and threshold fields when the partner lacks the `wisp` entitlement. The tier dial always shows.
  - Same page Save as the rest of the tab (Rule 7).
- [ ] **Run** → PASS.
- [ ] **Commit:** `feat(web): Wisp on this device policy section (W01)`.

### Task 3: Per-principal helper token table and service

**Files:**
- Create:
  - `apps/api/migrations/<next>-helper-principal-tokens.sql`
  - `apps/api/src/db/schema/helperPrincipalTokens.ts`
  - `apps/api/src/services/helperPrincipalTokens.ts` (+ `.test.ts`, `.integration.test.ts`)
- Modify: the schema barrel, `tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`, `routes/devices/core.ts` (move-delete + device cascade)

**Interfaces:**
- **Table `helper_principal_tokens`** (shape 5), columns:
  - `id`, `org_id`, `device_id`
  - `principal_key varchar(200)`, `principal_kind varchar(20)` with CHECK `windows_sid|unix_uid`
  - `win_session_id int null`, `display_username varchar(256) null`
  - `token_hash char(64) unique`, `generation int`
  - `issued_at`, `expires_at`, `revoked_at null`, `revoke_reason varchar(40) null`
  - `portal_user_id uuid null`, `portal_auth_epoch int null`

  Partial unique index: one live row per `(device_id, principal_key)` WHERE `revoked_at IS NULL`.
- **Principal key format:**
  - Windows: `sid:<SID>|ws:<WinSessionID>`.
  - Unix: `uid:<uid>`.

  The logon id is not observable by the broker (`prompthost/registry.go:73` comment), so the kernel session id stands in for it on Windows. Record this in the PR as a deviation from §4.2's wording.
- **Produces:**
  - `PRINCIPAL_TOKEN_TTL_MS = 60 * 60 * 1000`
  - `mintPrincipalToken(input: { deviceId; orgId; principalKey; principalKind; winSessionId: number | null; displayUsername: string | null }): Promise<{ id: string; token: string; expiresAt: Date }>`. Revokes the previous live row for the same key in the same transaction. Token prefix `brz_p_`.
  - `revokePrincipalTokens(deviceId: string, opts: { principalKey?: string; reason: 'session_ended' | 'principal_changed' | 'device_moved' | 'reenrolled' | 'rotated' }): Promise<number>`
  - `lookupLivePrincipalToken(tokenHash: string): Promise<HelperPrincipalRow | null>` (null when revoked or expired)

- [ ] **Red:**
  - Unit: `mint returns brz_p_ token and stores only its sha256`; `mint revokes the previous live token for the same principal`; `lookup returns null after expiry or revoke`.
  - Integration: `one live token per device and principal (unique index)`; `RLS hides another org's principal tokens`; `device move deletes principal tokens`.
- [ ] **Run:** unit + integration commands → FAIL.
- [ ] **Green:** migration, schema, service and the five registrations.
- [ ] **Run** → PASS; the org-cascade, merge and export integration suites → PASS; `pnpm db:check-drift` → clean.
- [ ] **Commit:** `feat(helper): per-principal helper tokens (W01)`.

### Task 4: Agent requests principal tokens for verified Assist sessions

**Files:**
- Modify:
  - `agent/internal/ipc/message.go` (new types)
  - `agent/internal/heartbeat/heartbeat.go:7366-7408` (beside `pushHelperToken`)
  - `agent/internal/sessionbroker/broker.go` (session-closed hook)
  - `apps/api/src/routes/agentWs.ts` (WS handlers)
  - `apps/helper/src-tauri/src/ipc/client.rs:170,508` (store the principal token separately from the device token)
- Create: `agent/internal/heartbeat/principal_tokens.go` (+ `_test.go`), `apps/api/src/routes/agentWs/helperPrincipalTokens.ts` (+ `.test.ts`)

**Interfaces:**
- **WS agent→API:**
  - `helper_principal_token_request { principalKey; principalKind; winSessionId?; username }`
  - `helper_principal_token_revoke { principalKey; reason }`
- **WS API→agent:** `helper_principal_token_issue { principalKey; token; expiresAt }`.
- **IPC agent→Assist:** `ipc.TypeHelperPrincipalToken = "helper_principal_token"`, payload `HelperPrincipalToken { Token string; ExpiresAt string }`. Sent only to the session whose principal it belongs to.
- **Go:** `func principalKeyForSession(s *sessionbroker.Session) (key, kind string, winSession *uint32, ok bool)`:
  - Returns `ok=false` unless `s.WinSessionVerified` on Windows.
  - Builds the key from `IdentityKey` + `WinSessionID`.
  - `username` comes from the agent's own SID→account or uid→name lookup, never from `AuthRequest.Username`.

- [ ] **Red:**
  - Go: `TestPrincipalKeyForSession_RejectsUnverifiedWindowsSession`; `TestPrincipalKeyForSession_UsesKernelSIDNotClientUsername`; `TestPrincipalTokens_RevokeOnSessionClose`; `TestPrincipalTokens_RefreshAt80PercentTTL`; `TestPrincipalTokens_NonConsoleSessionNeverRequests`. The last one mirrors `SessionInConsoleSession`.
  - API: `issues a token only for a device whose agent socket made the request`; `revoke message revokes only that principal`.
- [ ] **Run:** `cd agent && go test -race ./internal/heartbeat/... -run PrincipalToken`; API unit → FAIL.
- [ ] **Green:**
  - The request is sent from `handleHelperSessionAuthenticated` when the session has the assist scope.
  - Rust stores the principal token in memory only and sends it as `Authorization: Bearer` on device-door routes.
- [ ] **Run** → PASS; `cargo test principal_token` → PASS.
- [ ] **Commit:** `feat(agent): attested per-principal helper tokens (W01)`.

### Task 5: Principal auth and binding on every helper chat endpoint

**Files:**
- Create: `apps/api/src/middleware/helperPrincipalAuth.ts` (+ `.test.ts`)
- Modify: `apps/api/src/middleware/helperAuth.ts:59-221`, `apps/api/src/routes/helper/index.ts:104,135-147,271,360,580,752,827,871,906,936`
- Test: `apps/api/src/routes/helper/principalBinding.test.ts`

**Interfaces:**
- Consumes: `lookupLivePrincipalToken` (Task 3), `resolveDeviceDoorPolicy` (Task 1).
- Produces:
  - Context var `helperPrincipal: { id: string; principalKey: string; displayUsername: string | null; portalUserId: string | null } | null`.
  - `helperAuth` accepts `brz_p_` tokens: it resolves the device from the row, then runs the same lifecycle, parked and enabled gates.
  - `requireHelperPrincipalWhenWisp`: 401 `principal_required` on any chat route when `assistantMode='wisp'` and no principal token was presented.
  - Wisp-mode sessions store `contextSnapshot.principalKey`, and `helperOwnedSessionConditions` adds `principalKey` equality for them.
  - `revalidateDeviceDoorAuthority(sessionId): Promise<{ ok: true } | { ok: false; reason }>`. It is called before a deferred tool executes: `tool-results` at `:580` and PAM-resumed executions. It re-checks token liveness, tier and entitlement.

- [ ] **Red:**
  - `principal B sees none of principal A's helper chat data`: covers `GET /chat/sessions`, `GET /chat/sessions/:id/messages`, `POST /chat/sessions/:id/messages`, `POST /chat/sessions/:id/tool-results`, `POST /screenshots`, `DELETE /chat/sessions/:id`, `POST /chat/sessions/:id/flag`. Each returns 404 or an empty list.
  - `classic mode keeps accepting the device token unchanged`.
  - `revoked principal token is refused at tool-results even mid-session`.
  - `typed helperUser never affects ownership`.
- [ ] **Run:** `cd apps/api && npx vitest run src/routes/helper/principalBinding.test.ts src/middleware/helperPrincipalAuth.test.ts` → FAIL.
- [ ] **Green** → **Run** → PASS; the existing `src/routes/helper` suites stay green.
- [ ] **Commit:** `feat(helper): bind helper chat to the attested principal (W01)`.

### Task 6: PAM subject is the attested principal

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts:1742`, `apps/api/src/services/pamToolActionGovernance.ts:35-46,145`
- Test: `apps/api/src/services/pamToolActionGovernance.test.ts`

**Interfaces:**
- `ToolActionParams` gains `subjectPrincipalKey?: string`. It is stored in the elevation request's audit details.
- `subjectUsername` = the attested `displayUsername` when there is a principal, otherwise the hostname, as today.

- [ ] **Red:** `matchUser rule matches the attested OS user for a device-door tool action`; `audit line names device and principal`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(pam): attested OS principal as the tool-action subject (W01)`.

### Task 7: `device` budget namespace with an independent allowance

**Files:**
- Create:
  - `apps/api/migrations/<next>-device-ai-budget.sql`
  - `apps/api/src/db/schema/deviceAiUsage.ts`
  - `apps/api/src/services/aiBudgetReservations.device.test.ts`
  - `apps/api/src/services/aiBudgetReservations.device.integration.test.ts`
- Modify:
  - `apps/api/src/db/schema/ai.ts:236,279` (columns + namespace)
  - `apps/api/src/services/aiBudgetReservations.ts:45,114,398-403,644-840`
  - `apps/api/src/services/effectiveSettings.ts:57,82` (`AI_BUDGET_FIELDS`)
  - the settle path that writes `ai_cost_usage` for a reservation (also write the device bucket in the same transaction)
  - `apps/api/src/routes/ai.ts:1533` + `services/aiCostTracker.ts:1006` (per-device breakdown)
  - `apps/web/src/components/settings/AiUsagePage.tsx`
  - the registrations

**Interfaces:**
- **Migration:**
  - The `ai_budget_reservations_namespace_chk` CHECK gains `'device'`.
  - `ai_budgets` gains `device_daily_budget_cents int null`, `device_monthly_budget_cents int null`, `per_device_daily_budget_cents int null`.
  - New table **`device_ai_usage`** (shape 5, no FK on `device_id`): `org_id, device_id, period ('daily'|'monthly'), period_key, total_cost_cents, input_tokens, output_tokens, message_count`, unique `(org_id, device_id, period, period_key)`.
- **`ReserveAiBudgetInput`** gains `deviceBudget?: { deviceId: string }`, required when `namespace === 'device'`.
- **Admission rules:**
  - Technician and client org-cap checks subtract settled device spend (from `device_ai_usage`) and held `device` reservations.
  - Device admission checks only `device_daily/monthly` against settled + held device spend, plus `per_device_daily` against that one device.
  - The same org row lock covers all of these checks.
- **Precedence** is unchanged: a present partner value wins (`effectiveSettings.ts:269-297`).

- [ ] **Red:**
  - Unit: `technician admission ignores device spend at the device cap`; `device admission refuses at per-device daily cap while another device is admitted`; `device namespace requires deviceBudget`.
  - Integration: `concurrent device reservations at the cap admit exactly one` (two parallel `reserveAiBudget`); `settle writes ai_cost_usage and device_ai_usage in one transaction`; `RLS hides another org's device usage`.
- [ ] **Run** → FAIL. **Green.** **Run** → PASS, plus the export and cascade suites; `pnpm db:check-drift`.
- [ ] **Commit:** `feat(ai): device budget namespace with independent allowance (W01)`.

### Task 8: Device thread table and retention

**Files:**
- Create: `apps/api/migrations/<next>-device-assistant-threads.sql`, `apps/api/src/db/schema/deviceAssistantThreads.ts`, `apps/api/src/services/deviceDoor/threads.ts` (+ tests)
- Modify: registrations (`CORE_DEVICE_ORG_DENORMALIZED_TABLES` must **not** list it; add a comment beside the `fix_outcomes` exclusion at `routes/devices/core.ts:~270-320`), `services/deviceOrgMove/moveDeviceOrgInTransaction.ts:167` (close live threads on move)

**Interfaces:**
- **Table `device_assistant_threads`** (shape 5): `id, org_id, device_id, principal_key, summary text, summary_updated_at, closed_at null, close_reason varchar(30) null, created_at`. Unique live `(device_id, principal_key)` WHERE `closed_at IS NULL`.
- **Produces:**
  - `getOrOpenDeviceThread({ orgId; deviceId; principalKey }): Promise<DeviceThreadRow>`
  - `appendThreadEvent(threadId, event: DeviceThreadEvent): Promise<void>`. Event kinds `checkin | ask | outcome | ticket_link`, stored as rows in `device_assistant_thread_events` (shape 5, `payload jsonb` = `excludedOpen`).
  - `closeDeviceThreads(deviceId, reason)`
- **Retention:** thread summaries live until the device or principal is removed. Device-door screenshots are deleted after 90 days by a daily job `device-door-retention`, registered in `scheduleRegistry` + `WORKER_REGISTRY` + `workerReadinessManifest`.

- [ ] **Red:** `one live thread per device and principal`; `device move closes the thread and leaves it with the source org`; `retention deletes device-door screenshots older than 90 days and keeps newer ones`; RLS integration.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): device threads and retention (W01)`.

### Task 9: Wisp persona, Advice tier, and the device namespace in the chat route

**Files:**
- Modify: `apps/api/src/services/helperAiAgent.ts:13-30`, `apps/api/src/services/helperToolFilter.ts:35-80`, `apps/api/src/routes/helper/index.ts:229-250,304,321,438`
- Create: `apps/api/src/services/deviceDoor/enablement.ts` (+ `.test.ts`)

**Interfaces:**
- **Produces:**
  - `isDeviceDoorWispEnabled(device: HelperDevice, policy: DeviceDoorPolicy): Promise<boolean>`. It implements the Global Constraints enablement.
  - `HelperContext` gains `assistant?: { displayName: string; threadSummary: string | null; careSummary: string | null; openTicketsSummary: string | null }`.
  - `ADVICE_TOOLS` contains only the device-facts read that Assist's own `/device-info` route returns (`:642`).
- **When enabled:**
  - persona and system prompt under the display name;
  - `reserveAiBudget({ namespace: 'device', deviceBudget: { deviceId } })`;
  - the session links `contextSnapshot.deviceThreadId`.
- **Otherwise** every existing code path is untouched.

- [ ] **Red:**
  - `classic sessions are unchanged (prompt, tools, namespace) when Wisp is disabled at any of the four gates`: one case per gate.
  - `wisp mode reserves against the device namespace`.
  - `advice tier exposes only the device-facts tool`.
  - `wisp mode keeps every tool basic/standard/extended grant today`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): Wisp persona and Advice tier in Assist chat (W01)`.

### Task 10: Portable flag and macOS pending restart

**Files:**
- Modify:
  - `agent/internal/patching/reboot_detect_other.go` (split out `reboot_detect_darwin.go`)
  - `agent/internal/collectors/classify_chassis.go:12`, `classify_darwin.go`
  - the hardware inventory ingest that receives `HardwareInfo` (`collectors/hardware.go:31,260` → API inventory route)
  - `apps/api/src/db/schema/devices.ts`, `tenantExportPolicyRegistry.ts:480` (`included`)
- Create: `apps/api/migrations/<next>-devices-is-portable.sql`

**Interfaces:**
- Go `func IsPortable(chassisType, model string) *bool`:
  - SMBIOS chassis `8, 9, 10, 14, 30, 31, 32` → true;
  - desktop chassis → false;
  - a macOS model containing `MacBook` → true;
  - other Macs → false;
  - unknown → nil.
- Darwin `DetectPendingReboot() (bool, []string)`: true when `softwareupdate --list` reports an item with `Action: restart` that has been downloaded, or when `/Library/Updates/index.plist` lists a staged restart-required product.
- `devices.is_portable boolean null`, written from inventory.

- [ ] **Red:** `TestIsPortable_TableDriven` (chassis 9 → true, 3 → false, "MacBookAir10,1" → true, "Macmini9,1" → false, "" → nil); `TestDetectPendingReboot_Darwin_ParsesRestartAction` (parser over fixture output); API `inventory ingest stores is_portable`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(agent): portable flag and macOS pending-restart detection (W01)`.

---

## Wave W02: Care engine

### Task 11: Care items table, kind registry and pure evaluator

**Files:**
- Create:
  - `apps/api/migrations/<next>-device-care-items.sql`
  - `apps/api/src/db/schema/deviceCareItems.ts`
  - `apps/api/src/services/deviceCare/registry.ts`, `evaluate.ts` (+ tests)
- Modify: registrations (move-delete)

**Interfaces:**
- **Table `device_care_items`:**
  - Columns per §5.1, plus `principal_key varchar(200) null`.
  - Live unique index on `(device_id, kind, coalesce(principal_key,''))` WHERE `status IN ('open','asked','scheduled','escalated')`.
  - `evidence jsonb` is `excludedOpen`.
- **`CareKindSpec`:** `{ kind; perPrincipal: boolean; schedulable: boolean; escalationHardLimitDays: number | null; detect(facts: CareFacts): CareDetection | null; copyKeys: { ask: string; firmer: string; resolved: string } }`.
- **First three kinds, with exact thresholds:**

  | Kind | Detected when | Schedulable | Hard limit |
  |---|---|---|---|
  | `pending_restart` | `pendingReboot` for ≥ 72 h | yes | none |
  | `updates_stalled` | approved, uninstalled patches exist and the last successful install is > 14 days old | yes | 45 days |
  | `disk_nearly_full` | system volume free < 10 % or < 10 GB | no | none |
- **Produces:** `evaluateCareKinds(facts: CareFacts): CareDetection[]` (pure); `loadCareFacts(deviceId): Promise<CareFacts>`.

- [ ] **Red:** table-driven `evaluateCareKinds` cases for each threshold edge (71 h vs 72 h; 14 vs 15 days; 10.1 % vs 9.9 %); integration `one live row per device+kind including scheduled and escalated`; RLS.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(care): care items and evaluator (W02)`.

### Task 12: Care sweep worker and heartbeat re-evaluation

**Files:**
- Create: `apps/api/src/jobs/deviceCareJobs.ts` (+ tests), modelled on `jobs/auditBaselineJobs.ts`
- Modify: `jobs/scheduleRegistry.ts` (hourly slot `device-care-evaluator`), `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`, `routes/agents/heartbeat.ts:1810-1830` (fire-and-forget `requestDeviceCareReevaluation({ deviceId })`, like `requestDeviceGroupReevaluation`)

**Interfaces:**
- Produces: `requestDeviceCareReevaluation(input: { deviceId: string }): Promise<void>`. It never rejects and does no inline DB work in the heartbeat transaction. Also `runDeviceCareSweep(): Promise<{ evaluated: number }>`.
- The sweep:
  - skips ephemeral and parked devices and orgs whose enablement is false;
  - opens and updates live items;
  - marks `resolved` when detection clears;
  - also records the usage-profile observation (Task 13).

- [ ] **Red:** `opens an item on first detection and resolves it when the fact clears`; `skips devices whose org lacks Wisp enablement`; `heartbeat enqueue does not await DB work`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(care): hourly care sweep and heartbeat re-evaluation (W02)`.

### Task 13: Usage profile

**Files:**
- Create: `apps/api/migrations/<next>-device-usage-profiles.sql`, `apps/api/src/db/schema/deviceUsageProfiles.ts`, `apps/api/src/services/deviceCare/usageProfile.ts` (+ tests)

**Interfaces:**
- **Table `device_usage_profiles`** (shape 5, PK `device_id`): `org_id, observations jsonb (excludedOpen), sample_days int, updated_at`.
- **Produces:**
  - `recordActivityObservation(deviceId, at: Date, tz: string)`. When the device is online with a console user, set today's last-active to `at`.
  - `typicalStopTime(profile, weekday): { hour: number; minute: number }`. Median of the last 4 same-weekday observations.
  - Cold start: weekdays 08:00–18:00 local, stop time 18:00, until `sample_days >= 14`.

- [ ] **Red:** `cold start returns 18:00 until 14 sample days`; `median of last four Tuesdays`; `weekend with no observations falls back to cold start`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(care): deterministic usage profile (W02)`.

### Task 14: Check-ins, asks, `care.*` kinds and the prompt-action relay

**Files:**
- Create:
  - `apps/api/src/services/deviceCare/checkins.ts`, `slots.ts` (+ tests)
  - `apps/api/src/routes/agentWs/deviceDoorPromptAction.ts` (+ test)
  - `agent/internal/promptkinds/care.go` (+ `_test.go`)
  - `agent/internal/heartbeat/care_prompts.go`
  - `apps/helper/src/prompt/kinds/care.tsx` (+ test)
  - `packages/shared/src/promptCatalog/catalog/care.json` (+ agent copy)
- Modify: the five kind-registration sites (Global Constraints), `services/commandTypes.ts` etc. (new command)

**Interfaces:**
- **Agent command `show_care_prompt`:** `{ checkinId: string; kind: 'care.checkin' | 'care.schedule' | 'care.reminder'; items: { kind: CareKind; params: Record<string, string | number> }[]; slots?: { slotId: string; start: string; end: string }[]; firmer: boolean }`.
- **WS agent→API `device_door_prompt_action`:** `{ promptId; kind; actionId; principalKey; leaseEpoch; visibleEligibleAt?: string; challengeId?: string }`. `principalKey` comes from the prompt `Owner` the host lease-checked (`prompthost/host.go:869`), never from Assist. The same message serves `fix.confirm` (Task 24) and `ticket.confirm` (Task 18).
- **`care.schedule` actions:** `slot:<slotId>` (up to three), `not_this_week` (safe default), `talk_to_assistant`.
- **Produces:**
  - `proposeSlots(input: { profile; now: Date; deadline: Date | null; tz: string; patchWindow: { start: string; end: string } | null }): Slot[]`. At most three slots. Each starts at `typicalStopTime + 60 min`, lasts 4 h, and is never later than `deadline`.
  - `nextCheckinAt(cadence, lastCheckinAt): Date | null`.
  - `recordCareAction(input): Promise<void>`. Applies the counting rules exactly as §5.3 states:
    - only `not_this_week` increments `declines_count`;
    - an ask counts unanswered only if `visibleEligibleAt` was set and the next check-in arrived with no action;
    - Esc or close counts at most once per check-in.
- **Ask timing:**
  - Below `weekly`, a check-in with no open items is skipped.
  - An item whose deadline falls before the next check-in is asked once early.
  - Never in the first 15 min after sign-in or outside the profile's working hours. A locked session gets a list entry only, enforced by the existing `ShowWhileLocked=false`.
  - One restart asker at a time: an active `restart.prompt` campaign suppresses a `pending_restart` ask.
- **Agent-side quiet rules** (`care_prompts.go`). The agent defers any `care.*` show, and never steals focus:
  - while presenting or full screen: Windows `SHQueryUserNotificationState` (the dialogs spec signal);
  - while the camera or microphone is in use, where the OS exposes it.

  With no Assist in the session, only `care.schedule` falls back to the native renderer; the other kinds wait in the list.
- Each check-in, ask and outcome is also written to the device thread with `appendThreadEvent` (Task 8), so the chat can answer "why do you keep asking?".

- [ ] **Red:**
  - API: `dismissals inside one check-in count once and never escalate`; `not_this_week is the only decline`; `slots never pass the deadline`; `monthly cadence skips a check-in with nothing to ask`; `principalKey in the relay must match a live principal token for that device`; `active restart.prompt suppresses the care ask`.
  - Go: `TestCareScheduleKind_TransitionsAndSafeDefault`; `TestCarePrompts_DeferDuringPresentation`; `TestCarePrompts_OnlyScheduleFallsBackToNative`.
  - Assist: `renders catalog copy only and never a free server string`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS (all three test commands).
- [ ] **Commit:** `feat(care): check-ins, schedule asks and device-door prompt relay (W02)`.

### Task 15: The chosen night

**Files:**
- Create:
  - `apps/api/src/services/deviceCare/night.ts` (+ tests)
  - `agent/internal/heartbeat/handlers_care.go` (+ `_test.go`)
  - `agent/internal/power/keepawake_{windows,darwin,linux}.go`
- Modify:
  - `apps/api/src/services/patchJobService.ts:63-113` (`scheduledAt` parameter)
  - `apps/api/src/services/patchRebootHandler.ts:450` (`source` union gains `'user_scheduled'`)
  - `agent/internal/patching/reboot_surface.go:164-254` (suppress rungs until a time)
  - `apps/api/src/services/wakeOnLan.ts:362` (system-actor call)

**Interfaces:**
- **Agent command `care_night_schedule`:** `{ slotStart: string; slotEnd: string; suppressRungsUntil: string }`.
  - Keeps the device awake on AC only, until `slotEnd`: Windows `SetThreadExecutionState`; macOS `caffeinate` + `pmset schedule wake slotStart`; Linux `systemd-inhibit`.
  - Suppresses restart rungs until `suppressRungsUntil`.
  - It never overrides lid-close sleep.
- **Produces:** `acceptSlot({ careItemId; slotId; principalKey }): Promise<void>`. It does all of the following:
  - creates a one-off patch job for the device with `scheduledAt = slot.start` (`createPatchJobForDeviceFromPolicy(deviceId, orgId, { scheduledAt, origin: 'care' })`);
  - queues `care_night_schedule`;
  - enqueues a delayed job at `slot.start` that calls `executeReboot(deviceId, reason, { source: 'user_scheduled' })` if the device still has `pendingReboot` once patching finishes. This avoids `schedule_reboot`'s 1440-minute cap (`patchRebootHandler.ts:33`);
  - calls `dispatchWake` at `slot.start - 5 min` when the device is offline and a site relay exists;
  - sends a `care.reminder` at the typical stop time;
  - sets the item to `scheduled`.

  It never touches `devices.rebootDeferralsUsed`.
- **Outcome:**
  - Success → an outcome list entry ("Updated and restarted overnight · 03:12") and the item `resolved`.
  - Failure (still pending after `slotEnd`) → `open`, counters unchanged, and the next check-in uses the "that's on us" copy key.

- [ ] **Red:** `accepting a night creates a scheduled patch job and does not consume a deferral`; `failed night reopens the item without moving counters or deferrals`; `reboot after patching uses source user_scheduled`; Go `TestCareNight_KeepAwakeOnlyOnAC`, `TestCareNight_SuppressesRungsUntilSlot`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(care): schedule-a-night maintenance (W02)`.

### Task 16: Escalation, concern and compliance column

**Files:**
- Create: `apps/api/src/services/deviceCare/escalation.ts` (+ tests)
- Modify:
  - `apps/api/src/services/ticketService.ts:1167` (call only)
  - `apps/api/src/services/wisp/concerns.ts:151` (call only)
  - `apps/api/src/routes/patches/compliance.ts:154,390`
  - the compliance UI component that renders that route

**Interfaces:**
- **Produces:** `escalateCareItem(careItemId): Promise<{ ticketId: string; created: boolean }>`. Triggered when `declines_count + unanswered_count >= escalationThreshold` or the kind's hard limit passes.
  - **First time:** `createTicket({ source: 'ai', orgId, deviceId, subject, description }, { kind: 'system' })` and store `escalation_ticket_id`.
  - **Later:** if that ticket is open, add an internal comment instead of a new ticket.
  - **Concern:** `upsertConcern({ subjectKind: 'device', subjectId: deviceId, … })` when the org has technician Wisp.
  - **User:** one catalog notice to the user.
  - The ticket description wraps any user-supplied text with `wrapUntrustedData` before technician AI reads it. Pin this with a test on the ticket AI read path.
- The compliance response gains `care: { open: number; escalated: number }` per device.

- [ ] **Red:** `third decline across three check-ins escalates once`; `second escalation of the same item comments on the open ticket instead of duplicating`; `hard limit escalates regardless of counters`; `technician ticket read wraps device-door text as untrusted`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(care): escalation ticket, concern and compliance care column (W02)`.

---

## Wave W03: SSO and tickets in Assist

### Task 17: Entra sign-in bound to the attested principal

**Files:**
- Create: `apps/api/src/routes/helper/sso.ts` (+ test), `apps/helper/src-tauri/src/sso/{mod.rs,wam_windows.rs,pkce.rs}`, `apps/helper/src/sso/SignIn.tsx` (+ test)
- Modify: `apps/api/src/services/clientAiExchange.ts:270-360` (extract the resolver), `apps/api/src/config/env.ts` (`HELPER_ENTRA_CLIENT_ID`), `.env.example`

**Interfaces:**
- **Produces:**
  - `resolvePortalUserForEntra(claims: ClientAiEntraClaims, opts: { orgId: string }): Promise<{ portalUserId; contactId: string | null; authEpoch } | { error: 'no_user' | 'inactive' | 'wrong_org' }>`. Matches on `(entra_tenant_id, entra_oid)` only, never email; requires `status = active`. `clientAiExchange` now calls it, with no behaviour change.
  - `POST /helper/sso/bind { idToken }` (principal auth): verifies with `verifyEntraIdToken(idToken, { audience: HELPER_ENTRA_CLIENT_ID })` (`services/clientAiEntraJwt.ts:114`), then stores `portal_user_id` and `portal_auth_epoch` on the principal token row.
  - `POST /helper/sso/unbind`.
  - `helperPrincipalAuth` re-checks portal user `status` and `authEpoch` on every request and clears `portalUserId` when either changed.
- **Binding lifetime.** The binding lives on the principal token row. It dies with that token (session end, principal change). *Plan call: the server holds the binding, so the agent's per-principal store never holds the Entra token. This is a narrower surface than §4.2's wording.*
- **Assist sign-in:**
  - Windows tries WAM silent (`WebAuthenticationCoreManager`) first, then falls back to system-browser PKCE on a loopback redirect.
  - macOS uses system-browser PKCE, which Platform SSO makes silent where it is deployed.

- [ ] **Red:**
  - API: `binds only an active portal user in the device's org`; `email match without oid is refused`; `epoch bump drops the binding on the next request`; `binding dies when the principal token is revoked`; `clientAiExchange behaviour unchanged` (existing suite).
  - Rust: `pkce_builds_s256_challenge`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): Entra sign-in bound to the attested principal (W03)`.

### Task 18: `create_ticket` and `ticket.confirm`

**Files:**
- Create:
  - `apps/api/migrations/<next>-device-door-tickets.sql`
  - `apps/api/src/db/schema/deviceDoorTickets.ts`
  - `apps/api/src/services/deviceDoor/tickets.ts` (+ tests)
  - kind files for `ticket.confirm` (Go, Assist, catalog)
- Modify: helper tool registration (device-door tools), the five kind sites

**Interfaces:**
- **Table `device_door_tickets`** (shape 1 on `org_id`):
  - Columns: `ticket_id unique, device_id, principal_key, created_at`.
  - Not restamped on device move.
  - This link replaces a `tickets.origin` column. `origin: device_door` = a link row exists.
- **Tool `create_ticket { subject; description; categoryId? }`.** It shows a `ticket.confirm` card with actions `send` / `edit` / `cancel` (safe default). On `send` via the relay:
  - `createTicket({ source: 'ai', orgId, deviceId, requesterContactId: boundPortalUser?.contactId ?? mappedContactId ?? null, subject, description }, { kind: 'ai_agent' })`;
  - insert the link row;
  - attach the conversation summary and consented screenshots on an initial public comment.
- **Deterministic fallback.** `POST /helper/tickets/form { subject; details }` files a ticket with no model call, for when the cap is exhausted or the model fails.

- [ ] **Red:** `create_ticket form works with no model admission`; `send creates one ticket with the link row and requester from the bound portal user`; `cancel and timeout create nothing`; `filing works without sign-in (requester null)`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): file tickets from Assist (W03)`.

### Task 19: Tickets tab, status entries and replies

**Files:**
- Create: `apps/api/src/routes/helper/tickets.ts` (+ test), `apps/helper/src/tickets/TicketsTab.tsx` (+ test)
- Modify: `apps/api/src/routes/portal/ticketOwnership.ts:31`, `ticketReadAccess.ts:27` (reuse only)

**Interfaces:**
- `GET /helper/tickets` returns the union of:
  - link rows for this device and principal;
  - when signed in or mapped, `portalTicketOwnership({ id: portalUserId, contactId })`.
- `GET /helper/tickets/:id` returns public comments only (`isPublic = true`), and only attachments on public comments.
- `POST /helper/tickets/:id/comments { body }` adds a public comment. Signed in → as that portal user. Unsigned → `origin_principal_kind = 'device_door'`, with the author display set to the principal's display username.
- Status changes and technician public replies produce a `notice` list entry, through the existing notice kind.

- [ ] **Red:** `unsigned principal sees only tickets it filed from this device`; `signed-in user also sees requester tickets across devices`; `internal comments and their attachments never return`; `another principal on the same device cannot read or comment`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): Tickets tab in Assist (W03)`.

### Task 20: Manual principal → contact mapping, and portal attachment upload

**Files:**
- Create: `apps/api/migrations/<next>-device-principal-contacts.sql`, `apps/api/src/db/schema/devicePrincipalContacts.ts`, `apps/api/src/routes/devices/principalContacts.ts` (+ test), a device-page UI component (+ test)
- Modify: `apps/api/src/routes/portal/tickets.ts:461-520` (upload on comment), the portal comment form

**Interfaces:**
- **Table `device_principal_contacts`** (shape 5, move-delete): `device_id, principal_key, contact_id, mapped_by, mapped_at`, unique `(device_id, principal_key)`. A mapped principal counts as signed in for requester and knowledge (§6.5), but not for cross-device "my tickets".
- **Portal:** `POST /portal/tickets/:id/comments` accepts up to 5 files of ≤ 10 MB each, stored as `ticketAttachments` on that public comment.

- [ ] **Red:** `technician maps a principal to a contact in the device's org only`; `mapped principal becomes the ticket requester`; `portal comment uploads an attachment visible on the public comment`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): principal-to-contact mapping and portal attachments (W03)`.

---

## Wave W04: Support depth

### Task 21: Fix recipe catalog and `run_fix_recipe`

**Files:**
- Create: `apps/api/src/services/deviceDoor/fixRecipes.ts` (+ test)
- Modify: `helperToolFilter.ts` (standard tier gains `run_fix_recipe`; `HELPER_TOOL_SCOPING` entry `deviceId`)

**Interfaces:**
- `interface FixRecipe { id: string; version: number; os: ('windows' | 'macos' | 'linux')[]; riskClass: 'low' | 'elevated'; params: z.ZodTypeAny; effectCopyKey: string; toCommand(params, device): { type: string; payload: object } }`.
- **Initial catalog:**

  | Recipe | Risk class |
  |---|---|
  | `restart_print_spooler` | low |
  | `flush_dns` | low |
  | `clear_temp` | low |
  | `restart_onedrive` | low |
  | `reset_network_adapter` | elevated |
  | `repair_office` | elevated |
- Produces: `paramsDigest(recipe, params): string`, a sha256 of canonical JSON.

- [ ] **Red:** `model cannot pass a free command through a recipe (unknown keys rejected)`; `paramsDigest is stable across key order`; `recipe unavailable on the wrong OS`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): fix recipe catalog (W04)`.

### Task 22: PAM `user_consent` verdict for recipes

**Files:**
- Create: `apps/api/migrations/<next>-pam-user-consent.sql` (`ALTER TYPE pam_rule_verdict ADD VALUE IF NOT EXISTS 'user_consent'`), `apps/api/src/services/deviceDoor/recipeDecision.ts` (+ test)
- Modify: `apps/api/src/db/schema/pam.ts:31`, the PAM rule validator (allow `user_consent` only when `matchToolName = 'run_fix_recipe'`), the web PAM rule editor

**Interfaces:**
- `decideRecipeAction(input: { orgId; recipe: FixRecipe; subjectUsername; deviceId }): Promise<'auto_approved' | 'denied' | 'pending' | 'user_consent'>`. Precedence (§6.3):
  1. a matching org rule wins;
  2. otherwise `pam_org_config.default_unmatched_verdict = 'auto_deny'` → `denied`. This is new behaviour for this path only, because the tool-action path ignores that setting today (`pamToolActionGovernance.ts:126-128`);
  3. otherwise `riskClass === 'low'` → `user_consent`;
  4. otherwise → `pending`.

- [ ] **Red:** `org rule beats recipe default`; `auto_deny org denies an unmatched low recipe`; `elevated recipe defaults to pending`; `validator rejects user_consent on a non-recipe rule`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(pam): user_consent verdict for low-risk fix recipes (W04)`.

### Task 23: `fix.confirm` kind

**Files:**
- Create: `agent/internal/promptkinds/fix.go` (+ test), `apps/helper/src/prompt/kinds/fix.tsx` (+ test), `packages/shared/src/promptCatalog/catalog/fix.json` (+ agent copy)
- Modify: the five kind sites, plus the new agent command `show_fix_confirm { challengeId; recipeId; effectCopyKey; params }`

- [ ] **Red:** `TestFixConfirmKind_CancelIsSafeDefaultAndTimeoutIsNotConsent`; Assist `renders the recipe's effect copy key with typed params only`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): fix.confirm prompt kind (W04)`.

### Task 24: Single-use consent challenge

**Files:**
- Create: `apps/api/migrations/<next>-device-consent-challenges.sql`, `apps/api/src/db/schema/deviceConsentChallenges.ts`, `apps/api/src/services/deviceDoor/consent.ts` (+ unit and integration tests)
- Modify: `apps/api/src/routes/agentWs/deviceDoorPromptAction.ts` (Task 14) for `kind = 'fix.confirm'`

**Interfaces:**
- **Table `device_consent_challenges`** (shape 5, move-delete): `id, org_id, device_id, execution_id, recipe_id, recipe_version, params_digest char(64), principal_key, token_generation, expires_at, consumed_at null, outcome varchar(20) null`.
- **Produces:**
  - `CONSENT_TTL_MS = 120_000`
  - `CONSENT_DEVICE_DAILY_LIMIT = 5`
  - `issueConsentChallenge(input): Promise<{ challengeId }>`
  - `consumeConsentChallenge(input: { challengeId; deviceId; principalKey; actionId: 'run_fix' | 'cancel' }): Promise<{ ok: true } | { ok: false; reason: 'expired' | 'consumed' | 'principal_mismatch' | 'digest_mismatch' | 'rate_limited' | 'generation_mismatch' }>`. One atomic `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING`, then a digest re-check against the execution's current params.
- On `ok` with `run_fix`, `mirrorElevationDecisionToExecution(…, approved = true, approvedByUserId = null)` runs it. Everything else denies.

- [ ] **Red:** `consent challenge rejects expired, replayed, wrong-principal and digest-mismatch actions`; `sixth consent-approved recipe in 24 h is rate_limited`; integration `two concurrent consumes of one challenge succeed exactly once`; `nothing sent with the helper HTTP token can consume a challenge` (no HTTP route reaches `consumeConsentChallenge`).
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): single-use consent challenge for fix recipes (W04)`.

### Task 25: Published memory for end users

**Files:**
- Create: `apps/api/migrations/<next>-ai-memory-audience.sql`, `apps/api/src/services/wisp/memoryDeviceDoor.ts` (+ unit and integration tests)
- Modify:
  - `apps/api/src/db/schema/aiMemoryBlocks.ts:22`
  - `apps/api/src/services/wisp/memoryService.ts:115-140` (publish and unpublish)
  - `apps/api/src/services/wisp/memoryTools.ts:149` (`remember` gains `proposeEndUsers?: boolean`)
  - the memory UI (share control + summary field), the export classification for the new columns

**Interfaces:**
- **Columns:**
  - `audience varchar(20) not null default 'technicians'` with CHECK `technicians|end_users`;
  - `end_users_proposed boolean not null default false`;
  - `published_content_sha256 char(64) null`, `published_by uuid null`, `published_at null`.
- **Produces:**
  - `publishBlockToEndUsers(auth, id): Promise<AiMemoryBlockRow>`. Human only; the block must be `confirmed` and `content.userSummary` must be a non-empty string. It sets the audience and stores the sha256 of the canonical content.
  - `unpublishBlock(auth, id)`.
  - `recallForDeviceDoor(input: { partnerId; orgId; query: string; limit: number }): Promise<{ id; userSummary: string }[]>`. Strict predicate:
    - same tenant;
    - owner `org` (this org) or `partner`;
    - `status = 'confirmed'`;
    - `audience = 'end_users'`;
    - `superseded_by_id IS NULL`;
    - `published_content_sha256 = sha256(content)`.

    It projects only `userSummary`.

- [ ] **Red:** `unconfirmed, retracted, superseded, technician-audience and user-owned blocks never return`; `editing a published block hides it until republished`; `AI cannot publish (no tool path)`; `proposeEndUsers alone does not publish`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(wisp): publish memory to end users (W04)`.

### Task 26: Portal-visible documents as knowledge

**Files:**
- Create:
  - `apps/api/migrations/<next>-org-document-texts.sql`
  - `apps/api/src/db/schema/orgDocumentTexts.ts`
  - `apps/api/src/jobs/orgDocumentTextJobs.ts`
  - `apps/api/src/services/deviceDoor/knowledge.ts` (+ tests)
- Modify: `apps/api/package.json` (`unpdf` and `mammoth`, exact pinned versions at least two weeks old; run `scripts/security/check-supply-chain-hardening.sh`), the org document upload/hide/delete paths (enqueue or invalidate), registrations

**Interfaces:**
- **Table `org_document_texts`** (shape 1): `org_id, document_id unique, sha256, text, tsv tsvector generated, extracted_at`. The text is `reviewedIncluded`.
- **Extraction** runs on upload or supersede. The row is deleted on hide, delete or supersede.
- **Device tool `search_org_knowledge { query }`:**
  - Requires a bound portal user or a mapped contact (§6.5). Otherwise it returns `{ error: 'sign_in_required' }`.
  - Unions `recallForDeviceDoor` with document hits.
  - Each document hit is re-checked with `portalVisibleDocument(orgId, id)` (`services/portal/documentsReadModel.ts:109`) at query time.

- [ ] **Red:** `hidden or superseded document never returns even if text row lingers`; `unsigned principal gets sign_in_required`; `extracts text from a fixture PDF and DOCX`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): org documents and published memory as Assist knowledge (W04)`.

### Task 27: Article allowlist and merged tool sources

**Files:**
- Create: `apps/api/src/services/deviceDoor/articles.ts` (+ test)
- Modify: `apps/api/src/routes/helper/index.ts:248-250`

**Interfaces:**
- **Allowlisted domains:** `support.microsoft.com`, `learn.microsoft.com`, `support.apple.com`, `support.google.com`, plus the partner's own domains from helper branding `portalUrl`.
- **Tool `lookup_support_article { url }`:**
  - fetches only allowlisted hosts over HTTPS;
  - follows no redirect off the list;
  - returns `{ host, title, excerpt }` wrapped as untrusted.
- In Wisp mode, client-declared tools are **added to** the device tools instead of replacing them.

- [ ] **Red:** `refuses a non-allowlisted host and an off-list redirect`; `wisp mode merges client and device tools; classic mode unchanged`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): support article allowlist and merged tool sources (W04)`.

---

## Wave W05: Full control (AI door)

*Split out of the spec's W04 under §12's "may split" allowance.*

### Task 28: `remote_sessions` can record an AI session

**Files:**
- Create: `apps/api/migrations/<next>-remote-sessions-ai-control.sql`
- Modify: `apps/api/src/db/schema/remote.ts:7,28`, then every consumer `tsc` flags once `userId` is nullable

**Interfaces:**
- `remote_session_type` gains `'ai_control'`.
- `user_id` becomes nullable, with CHECK `(type = 'ai_control') = (user_id IS NULL)`.
- New column `device_thread_id uuid null`.
- Occupancy and history count `ai_control` rows.

- [ ] **Red:** integration `CHECK rejects a technician session without user and an AI session with one`; `session history lists ai_control rows with the assistant label`.
- [ ] **Run** → FAIL. **Green:** migration plus the tsc-driven sweep, each fix guarded explicitly. **Run** → PASS; typecheck exit 0.
- [ ] **Commit:** `feat(remote): ai_control remote sessions (W05)`.

### Task 29: AI-door consent, stop and teardown

**Files:**
- Modify:
  - `agent/internal/promptkinds/remote.go:165-184,274-276`
  - `agent/internal/heartbeat/consent_gate.go:181-268`
  - `agent/internal/heartbeat/remote_prompts.go`
  - `apps/api/src/services/deviceDoor/fullControl.ts` (create)
  - `helperToolFilter.ts` (extended tier under consent)

**Interfaces:**
- `ipc.DesktopPrompt` gains `Actor string`, with values `technician` (default) or `ai`. When `Actor == "ai"`:
  - timeout and unavailability deny, whatever `ConsentUnavailableBehavior` says;
  - `AllowUserEndSession` is forced true;
  - the identity line names the assistant.
- The agent ends an AI session on screen lock, OS session change, principal change, or control-channel loss.
- API: `startAiControl({ sessionId, deviceId, principalKey }): Promise<…>`. The first `computer_control` or `execute_command` in a chat session is gated by PAM:
  - `execute_command` → `require_approval`;
  - `computer_control` → `require_approval` while `AI_DOOR_ACTUATOR_READY[os]` is false (all false in this task), then `user_consent`.

  The user always sees `remote.consent`. `end_session` removes control tools for the rest of the chat session.

- [ ] **Red:** `TestRemoteConsent_AIActorTimeoutDenies`; `TestRemoteSession_AIActorForcesStopControl`; `TestAISession_EndsOnLockAndSessionChange`; API `computer_control requires technician approval while actuator not ready`; `end_session strips control tools for the session`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): AI-door full control under remote-session consent (W05)`.

### Task 30: User-privilege actuator (flips the default per OS)

**Files:**
- Create: `agent/internal/remote/input/ai_confine_{windows,darwin}.go` (+ tests)
- Modify: `apps/api/src/services/deviceDoor/fullControl.ts` (`AI_DOOR_ACTUATOR_READY`)

**Interfaces:**
- `func AIInputAllowed() (bool, string)`:
  - **Windows:** the input desktop is `Default`, not `Winlogon` or the secure desktop. The session is unlocked. Injection runs in the user's session at the user's token.
  - **macOS:** the frontmost app is not `loginwindow` or `SecurityAgent`.

  Every AI input event checks it and drops the event when false.

- [ ] **Red:** `TestAIInputAllowed_RefusesSecureDesktop`; `TestAIInputAllowed_RefusesLocked` (both behind an interface fake).
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Lab leg per OS** (Windows first): a UAC prompt and the lock screen receive no AI input. Only then set `AI_DOOR_ACTUATOR_READY.<os> = true` in its own commit.
- [ ] **Commit:** `feat(agent): confine AI input to the user's desktop (W05)`.

---

## Wave W06: Awareness and requests

### Task 31: Known issues and the outage lookup

**Files:**
- Create: `apps/api/migrations/<next>-ticket-known-issues.sql`, `apps/api/src/db/schema/ticketKnownIssues.ts`, `apps/api/src/services/deviceDoor/knownIssues.ts` (+ tests), a ticket-page "Known issue" control (+ test)
- Modify: `helperToolFilter.ts:112-148` (an explicit scoping exception, with a comment and its own test)

**Interfaces:**
- **Tables:**
  - `ticket_known_issues` (shape 1): `ticket_id unique, site_id null, user_note varchar(200), set_by, set_at, cleared_at null`.
  - `known_issue_subscribers` (shape 1): `known_issue_id, device_id, principal_key`.
- **Tool `check_known_issues {}`** returns `{ note, siteName | null, status }[]` for this device's org, where the issue is org-wide or the device's site matches. The projection is strict.
- **Tool `notify_me_when_fixed { knownIssueId }`** creates a subscription. When the issue is cleared, subscribers get a `notice`. A subscription never grants ticket access.
- *Plan call: v1 sources only technician-marked known issues. `connection_health_incidents` cover integrations, not sites, and anomaly episodes are per device; neither is a site outage.*

- [ ] **Red:** `returns only the note, site and status`; `subscriber cannot read the ticket or its comments`; `other org's known issues never return`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): known issues and outage lookup (W06)`.

### Task 32: Requests

**Files:**
- Create: `apps/api/src/services/deviceDoor/requests.ts` (+ test)

**Interfaces:**
- **Tool `request_software_or_admin { kind: 'software' | 'admin_install'; detail }`:**
  - Requires sign-in or a mapping.
  - `admin_install` → an elevation request through the existing PAM route; a technician decides.
  - `software` → `createTicket({ ticketType: 'service_request', source: 'ai', … })` plus a link row.
  - Nothing runs.

- [ ] **Red:** `unsigned principal is asked to sign in`; `software request files a service_request ticket`; `admin request creates a pending elevation and executes nothing`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): software and admin requests (W06)`.

### Task 33: "Is this legit?"

**Files:**
- Create: `apps/api/src/services/deviceDoor/legitCheck.ts` (+ test with `.eml` fixtures)

**Interfaces:**
- `analyzeArtifact(input: { kind: 'eml' | 'text' | 'image'; bytes: Buffer }, ctx: { orgDomains: string[] }): LegitFacts`. It reports:
  - `auth: { spf; dkim; dmarc }`, from `Authentication-Results`;
  - `fromReplyToMismatch`;
  - `links: { host; lookalikeOf: string | null }[]`, using edit distance ≤ 2 or confusables against the org's domains plus a fixed brand list;
  - `attachmentTypes`.

  It never fetches a link.
- **Tool `check_if_legit`:** the model receives the content wrapped as untrusted plus the facts. It must return `{ verdict: LegitVerdict; reasons: string[] }` (zod-enforced). The user-facing copy never says "safe". `looks_suspicious` offers a security ticket with the artifact attached.

- [ ] **Red:** `DMARC fail plus a lookalike link yields looks_suspicious facts`; `instructions inside the email body do not change tool calls` (injection fixture); `verdict outside the enum is rejected`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(helper): is-this-legit check (W06)`.

### Task 34: More care kinds, integration-gated

**Files:**
- Modify: `apps/api/src/services/deviceCare/registry.ts` (+ tests)

**Interfaces:**
- **Device-level kinds:**
  - `backup_stale`: last successful backup > 3 days, from the backup integration's per-device status.
  - `battery_worn`: `batteryStatus` health < 60 % on a portable device.
- **Per-principal kinds:** `onedrive_sync_broken`, `mfa_not_enrolled`, `password_expiring` (within 7 days). Each is shown only to its principal. Each is registered only when the integration that provides its fact is connected for the org.

- [ ] **Red:** `per-principal kinds never surface to another principal`; `kinds without their integration are never evaluated`.
- [ ] **Run** → FAIL. **Green** → **Run** → PASS.
- [ ] **Commit:** `feat(care): backup, battery, OneDrive, MFA and password care kinds (W06)`.

---

## Wave W07: Docs and rollout

### Task 35: Docs, lab legs and default enablement

**Files:**
- Modify: `apps/docs/` (end-user "Your IT assistant" page; MSP pages for policy, PAM recipes, memory publishing, known issues, budgets), `docs/release-notes/next-release-draft.md` (append under its own heading), `services/promptHostConfig.ts:34` (default-on per kind only after lab legs)

- [ ] **Lab legs**, each recorded in a dated doc. Windows first, then macOS:
  - care ask → night → restart;
  - failed night;
  - escalation;
  - SSO bind on an Entra-joined PC;
  - fix consent;
  - AI full control with technician approval;
  - shared-computer second user.
- [ ] Turn on one kind per commit, in this order: `care.checkin`, `care.schedule`, `care.reminder`, `ticket.confirm`, `fix.confirm`.
- [ ] **Commit:** `docs(helper): Wisp on device docs and rollout (W07)`.

---

## Wave order and dependencies

| Wave | Depends on | Notes |
|---|---|---|
| W01 | #10425, #10223 closed | Tasks 1–2 and 10 are independent of 3–9 and can go in parallel. 3 → 4 → 5 → 6; 7 and 8 before 9. |
| W02 | W01 (5, 8, 9) | 11 → 12 → 13 → 14 → 15 → 16 |
| W03 | W01, W02 Task 14 (relay) | 17 → 18 → 19; 20 is independent |
| W04 | W03 (Task 18 relay use, Task 20 mapping) | 21 → 22 → 23 → 24; 25 → 26; 27 is independent |
| W05 | W04 Task 24 | 28 → 29 → 30 (30 waits for lab legs) |
| W06 | W03, W04 | all independent |
| W07 | all | — |
