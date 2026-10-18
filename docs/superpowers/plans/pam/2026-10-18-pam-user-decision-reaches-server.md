---
issue: 8971
related: 8928
status: draft
---

# PAM: the end user's Deny / timeout reaches the server — Implementation Plan (wave 1, safety fix)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the person at the keyboard declines (Deny, dialog timeout, dialog error) a Windows elevation that is `pending` technician approval, no later approval can launch that app, and the server learns the request is `withdrawn`.

**Architecture:** Two independent guards. (1) **Agent, authoritative:** before it dismisses consent.exe, the agent writes a durable local *decline record* for the request ID; `pam_apply_v2` and legacy `actuate_elevation` refuse any recorded ID with failure code `user_declined`. This closes the race even when the server never hears about it. (2) **Server, informative:** a new agent route moves the row `pending → withdrawn` under a row lock, expires linked mobile approvals, writes audit, and publishes `elevation.withdrawn`; the decline record doubles as the outbox that retries the route until the server answers definitively.

**Tech Stack:** Go agent (`agent/internal/{heartbeat,pamlifetime,pamdecline}`), Hono + Drizzle + hand-written SQL migrations (`apps/api`), Astro/React web (`apps/web/src/components/pam`).

**Spec:** GitHub issue #8971 (problem + fix list) and the review requirements in the two owner comments on #8928. No separate spec doc; the decisions section below is the design record.

## Global Constraints

- Statuses: exactly one new `elevation_status` value, `withdrawn`. One new `elevation_audit_event_type` value, `withdrawn`.
- Withdraw reasons (wire, DB CHECK, agent constants — byte-identical): `user_denied`, `user_timeout`, `dialog_error`.
- Agent failure codes for a refused apply (both `pam_apply_v2` `failureCode` and `actuate_elevation` `reason`):
  - `user_declined`: the user answered Deny, timed out or the dialog errored.
  - `user_decision_pending`: the dialog was still open when the bounded wait ran out.
  - `user_decline_record_untrusted`: the decline store failed to load.
- Route: `POST /api/v1/agents/:id/elevation-requests/:requestId/withdraw`. `:id` is the agent ID, the same as the submit route.
- Agent decline store limits:
  - Un-acked `declined` entries never age out.
  - Acked entries are pruned **7 days** after the ack.
  - Cap: **4096** entries.
  - Untrusted-load fence: **24 h**.
  - Apply wait on an `awaiting` entry: **100 s** (`pamDialogTimeout` + `pamDismissTimeout`).
- Migrations: `apps/api/migrations/2026-12-31-190000-pam-elevation-withdrawn-enum.sql` then `apps/api/migrations/2026-12-31-190100-pam-elevation-withdrawn-columns.sql`. Re-verify both sort after the newest committed migration on fresh `origin/main` at implementation time (`ls apps/api/migrations/*.sql | sort | tail -1`; newest at plan time: `2026-12-31-110000-restore-point-skipped-no-mutation.sql`). If bumped, keep the pair adjacent and in this order.
- Wave 1 adds **no** server→agent command, **no** capability column, **no** `MIN_AGENT_VERSION_*` constant, **no** mobile app change, **no** new locale keys unless a task below names one (then all 8 locale files: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` under `apps/web/src/locales/`, guarded by `apps/web/src/lib/i18n/localeParity.test.ts`).
- Public repo: no customer names, hostnames or IPs in code, tests, PR text.

## Review Focus

1. **Approval wins the server race, user still said no.** Tech approves 200 ms after Deny, before the withdraw lands → `pam_apply_v2` must come back `failed/user_declined` and nothing launches. Pinned by B3 `TestApplyRefusesDeclinedRequest` and A2 integration `approve-then-withdraw returns 409 approved`.
2. **Approval lands while the dialog is still open, then the user clicks Deny.** The apply must wait and then refuse. It must not launch first. Pinned by B3 `TestApplyWaitsForOpenDialogThenRefusesOnDeny` and `…ProceedsOnApprove`.
3. **The agent restarts between Deny and approval, or while the dialog is open.** The record must survive the restart (fsync + atomic replace). An `awaiting` entry found at load becomes `declined/user_timeout`. Pinned by B1 `TestStoreSurvivesReload`, `TestAwaitingAtLoadBecomesDeclinedTimeout`, and B3 `TestApplyRefusesDeclinedAfterRestart`.
4. **The decline file is corrupt or unwritable.** A corrupt file is moved aside and every remote apply is refused for 24 h (`user_decline_record_untrusted`). On a persist failure the record stays in memory and still refuses until restart. Pinned by B1 `TestCorruptStoreFencesAllApplies` and `TestPersistFailureStillRefusesInProcess`.
5. **The enum value exists but the row CHECK rejects it.** `elevation_requests_status_timestamps_chk` lists the allowed statuses. The `actuating` value shipped without widening it, which broke the transition (fixed later in `2026-09-16-pam-actuation-lifecycle.sql:15-25`). Pinned by the A1 integration test `withdrawn row requires withdrawn_at and a valid reason`.

Also covered: a new agent talking to an old self-hosted server. The route returns a generic 404, the agent acks it as `not_found`, and the local refusal still holds (B4 `TestWithdrawDrain404IsTerminal`).

---

## Decisions (quorum: Claude position first, then `codex exec` read-only `xhigh`)

**Quorum outcome (2026-10-18).** Claude's position was recorded before the Codex run; Codex (`gpt-6-astra`, `xhigh`, read-only) answered independently.

| Topic | Claude | Codex | Resolution |
|---|---|---|---|
| Wire | dedicated agent route | same | **Agree.** |
| Local record | separate durable store beside the lifetime ledger, written before dismissal | same; also "a negative record alone is insufficient: approval can arrive while the dialog is still open" | **Adopted Codex's point**: an `awaiting` entry is persisted before the dialog shows, and an apply that arrives while it is open waits (bounded) for the answer (D2). |
| Retention | 24 h from decline | keep tombstones for the enrollment lifetime; legacy `actuate_elevation` payloads carry no expiry | **Partly adopted**: un-acked entries never age out, and acked entries are kept 7 days after the ack (D2). Keeping them for the enrollment lifetime would grow without bound and buys nothing once the server has answered. |
| Store load failure | 1 h fence | latch closed | **Moved to 24 h fence** (D2). A permanent latch turns a corrupt file into a PAM outage that needs an operator. |
| `auto_approved` | not recorded | record it: the submit route also creates a `pam_apply_v2` actuation for `auto_approved` (`elevationRequests.ts:655-667`) | **Adopted**: a user Deny on an `auto_approved` dialog is recorded and refused locally. The withdraw is not delivered for it (the row is not `pending`). |
| Status | one `withdrawn` | one `withdrawn`; also accept withdraw from `approved`/`auto_approved`/`actuating` and request cleanup | **Disagree, kept pending-only.** The agent's refusal is authoritative; rewriting an approved row loses the approval's history. Once a refused actuation is `failed` there is nothing left to clean up. The technician sees **Approved · Declined on the device** (C1). → Todd decision T2. |
| Respond conflict | existing 409 | re-read status after a lost CAS; `row.status` is a pre-CAS snapshot (`routes/pam.ts:674-676`) | **Adopted** in A3. |
| Version gating | none | new `pamConsentProtocolVersion` capability that gates UAC approval and apply creation | **Disagree.** Gating approvals would cut off PAM approvals for every agent that has not upgraded until the fleet is promoted. No server decision needs the flag. → Todd decision T1. |
| Idempotency key | status-based replay | client `decisionId` | Kept status-based. A replay finds `withdrawn` and writes no second audit row, so a `decisionId` adds nothing. |
| Epoch binding | `org_id` + `device_id` | add ownership epoch | Not needed. `pamDeviceMoveGuard.ts:164` expires pending requests when a device moves, so a pending row on the caller's `(org_id, device_id)` is always in the current epoch. A2's integration test covers moved-then-withdraw → 409 `expired`. |

**Found during the quorum, out of scope:** an `auto_approved` request appears to have two launch paths: the server's `pam_apply_v2` and the local `actuateElevation` after the dialog's Approve (`pam_flow.go:142-155`). This needs checking on hardware. Proposed as a follow-up issue, not fixed here (T3).

### D1 — Wire shape: dedicated agent route

`POST /api/v1/agents/:id/elevation-requests/:requestId/withdraw`, body `{ reason: 'user_denied'|'user_timeout'|'dialog_error', declinedAt?: ISO-8601 }`.

- **Why not a heartbeat field:** heartbeat cadence adds up to a full interval of latency to a race whose loss is "launches the app"; and it couples a per-request state change into the hottest, most-versioned payload. **Why not a command result:** no command exists for a pending request — the agent is answering the server's *ingest* response, not a command. **Why not reuse submit:** the submit route creates rows; overloading it with a state transition muddies its rate limit and audit.
- **Auth:** `requireAgentRole`; `agent.agentId === :id` else 403; `agent.claimTypeAllowlist` set → 403 `drain_restricted` (same guards as `routes/agents/pamReconciliation.ts:107-117`, #8206). Ownership is enforced in SQL: the row must match `id = :requestId AND org_id = agent.orgId AND device_id = agent.deviceId AND flow_type = 'uac_intercept'`; otherwise 404 (no existence oracle across devices).
- **Idempotency:** a row already `withdrawn` returns 200 with the stored `withdrawnAt` (agent retries after a lost response are safe). Any other non-pending status → 409 `{ error: 'not_pending', status }`.
- **DB context:** the path has three segments after `:id`, so it does **not** match `SELF_MANAGED_DB_CONTEXT_ACTIONS` / `SELF_MANAGED_DB_CONTEXT_TWO_SEGMENT_ACTIONS` (`apps/api/src/middleware/agentAuth.ts:371-405`) and runs inside the middleware's request-long org-scoped wrap. That is correct here: the handler does one short transaction and no Redis/network work before it. Mobile-approval expiry and event publish run via `runAfterDbContextExit` exactly as respond does (`routes/pam.ts:820-822`). No rate limiter (each call is one indexed row lock on the caller's own device; the agent backs off).
- **Retry/ack, offline, restart:** the agent's decline record is the outbox (D2). Immediate attempt after Deny; then a drain loop retries with backoff until a *definitive* answer (200, 409, 404, 400); no give-up timer, max backoff 5 min. Offline at Deny → record persisted, drained on reconnect. Restart → record reloaded, drained.

### D2 — Agent-side safety: durable decline record (the part that closes the race)

- **Home:** new package `agent/internal/pamdecline` (store only, no heartbeat imports), file `pam-declined-requests.json` next to `pam-lifetime-ledger.json` (`filepath.Dir(statePath)`, wired in `Heartbeat.SetStatePath`, `heartbeat.go:1624-1632`). Not the lifetime ledger: the ledger is keyed by actuation ID and its contract (`job_contract_test.go`, `store_test.go`) is about grants that exist; a decline is about one that must never exist. Atomic write pattern copied from `agent/internal/desktopfence/store.go` (temp file, fsync, `atomicrename.Replace`, `0600`, corrupt file moved to `<path>.corrupt`).
- **Entry states:** `awaiting` → `declined` | removed (on Approve). `RunPamFlow` persists `awaiting` right **before** the dialog is shown, for `pending` and `auto_approved`. On the dialog's answer:
  - Approve: the entry is removed. Approve is the only outcome that permits an apply.
  - Deny, timeout or error: the entry is flipped to `declined` **before** `denyConsent`, then delivery is kicked. Recording before the dismissal (up to 10 s) closes the window where an approval arrives mid-dismiss.
- **Approval while the dialog is open (Codex):** an apply that finds an `awaiting` entry blocks on an in-process wait until that entry resolves. The wait is bounded by `pamDialogTimeout + pamDismissTimeout` (100 s) and is outside the manager's operation lock.
  - Resolved to removed: the apply proceeds.
  - Resolved to `declined`: the apply is refused with `user_declined`.
  - Wait expires: the apply is refused with `user_decision_pending`.
  - Persistence: an `awaiting` entry found at **load** time belongs to a dialog that died with the previous process. It is converted to `declined/user_timeout` and queued for delivery if it was `pending`.
- **Scope:** `pending` and `auto_approved` are recorded, because both can receive a remote apply. The submit route creates a `pam_apply_v2` actuation for `auto_approved` (`apps/api/src/routes/agents/elevationRequests.ts:655-667`). The withdraw is **delivered** only for `pending`. For `auto_approved`, the server row is not withdrawable, and the local refusal is the whole fix. `policy_denied` and `unexpected_status` show no dialog and write nothing.
- **Residual:** a request with no dialog at all writes no entry and behaves exactly as today. That covers no helper session (`pam_flow.go:101-106`) and an offline-replayed event (`etwlua.go:339-345`). Requiring affirmative consent for those would change what a technician approval means, so it is out of scope.
- **Reason mapping** (no helper change needed): `err` from the dialog round trip and `errors.Is(err, sessionbroker.ErrCommandTimeout)` → `user_timeout`; any other `err` → `dialog_error`; helper result `Approved=false, DismissedByUser=false` (the helper's countdown expiry, `userhelper/pam_dialog_window_windows.go:517-520`) → `user_timeout`; otherwise → `user_denied`.
- **Refusal points:** `lifecycleManager.apply` (`pamlifetime/manager.go:158`) right after `currentBootID` and **before** admission, `PinTarget`, `PrepareApply` and the `received` handoff — so a declined request leaves no ledger entry and no received observation, only a `failed` result (the server already accepts a `failed` result with a non-empty `failureCode` without a prior `received`: `services/pamActuationResult.ts:145`; `pam_disabled` is the precedent). Both handlers (`handlePamApplyV2` `:67`, legacy `handleActuateElevation` `:304`) first run the bounded `Await` on the request ID (outside any lock), then the manager re-checks non-blockingly inside its operation. The legacy handler refuses right after `parseActuatePayload`, before admission, and returns a success-shaped `actuateResult{Success:false, Reason:"user_declined"}` plus `writePAMActuationRefused`.
- **Failure handling:**
  - Corrupt or unreadable file at load: the file is moved aside, an Error is logged, and `Check()` answers *refuse* for **every** request ID for 24 h (`user_decline_record_untrusted`). That covers the default 15-minute pending TTL plus the 5-minute sweep many times over, and a long approval window. The cost is one day without remote PAM on a device whose state file was damaged, and it is logged loudly.
  - Persist failure on any transition: the entry is kept in memory and still refuses until restart. An Error is logged and delivery is still attempted.
  - Missing file: empty store, normal operation.
- **Fail-closed gate interaction:** none. The record is written whether or not the dismissal is proven. `denyConsent`, `pamDismissalUncertain`, the recovery probes and `actuateElevation`'s gate are untouched. Recovery probes use derived IPC IDs (`pam_flow.go:486`) and never create entries. The decline check runs before the gate check in both apply paths, so a declined request is reported as `user_declined`, not `dismissal_uncertain`.
- **Retention:** an un-acked `declined` entry never ages out, so an offline device still refuses a queued approval when it reconnects days later. An acked entry is pruned 7 days after its ack. `Prune()` runs on every drain pass. Above 4096 entries, the oldest acked entries are evicted first, then the oldest overall, with an Error log.
- **Permissions:** `0600`, in the same directory as `pam-lifetime-ledger.json`, so it inherits that directory's SYSTEM-only ACL on Windows.

### D3 — Server state machine

- **One value, `withdrawn`**, with the cause in a new column. Two values (`user_declined`/`user_timed_out`) would double every status list, filter, badge and CHECK clause for a distinction only the audit trail needs, and #8928's "Use admin credentials" would need a third. New columns on `elevation_requests`: `withdrawn_at timestamptz NULL`, `withdrawn_reason varchar(32) NULL` with `CHECK (withdrawn_reason IS NULL OR withdrawn_reason IN ('user_denied','user_timeout','dialog_error'))`. Status CHECK gains `OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL)`.
- **Transition:** take `SELECT … FOR UPDATE` on the owned row. Then run `UPDATE … SET status='withdrawn', withdrawn_at=now(), withdrawn_reason=$reason, updated_at=now() WHERE id=$id AND status='pending' RETURNING id`. Respond's UPDATE (`routes/pam.ts:647-671`) does not bump `revision`, and neither does this one. `FOR UPDATE` conflicts with respond's CAS and with `decideApprovalRequest`'s `FOR NO KEY UPDATE` (`services/approvals/decideApprovalRequest.ts:1434-1455`), so exactly one of approve/deny/withdraw/TTL-expire wins.
- **Linked mobile approvals:** `expireSupersededMobileApprovals(requestId)` (`services/pamMobileApprovals.ts:21`) after commit, via `runAfterDbContextExit`. Its guard is `status <> 'pending'`, so `withdrawn` is covered with no change.
- **Others meeting a withdrawn row (all fail closed already, verified):** respond → 409 at `routes/pam.ts:769-775` (this wave adds `currentStatus` to that body, additive); `decideApprovalRequest` → `lostRace` → 409 `finalStatus:'expired'` (`:1802-1804`); `pamActuationWorker` never sees it (no `pam_actuations` row exists for a never-approved request); legacy `routes/devices/actuateElevation.ts` CAS requires `approved`; `expireStaleRequests` filters `status='pending'`; `enforce-elevation-expiry` filters active statuses.
- **Approval racing a withdraw:** the server CAS decides the *server row*, and the agent's record decides *the endpoint*.
  - Approve first: the row goes `approved` and an actuation is dispatched. The agent returns `failed/user_declined`, so `pam_actuations.failure_code='user_declined'`. The late withdraw gets 409 `approved` and is acked. The technician sees **Approved · Declined on the device** (C1). No automatic re-dispatch of a failed actuation exists (`pamActuationWorker.ts` marks failed and stops), so this is terminal.
  - Withdraw first: the approve gets 409, and the respond modal says the user withdrew the request (C1).
  - `auto_approved` + Deny follows the same path, shown as **Auto-approved · Declined on the device**.
- **Enum mechanics:** `autoMigrate` wraps each file in its own transaction (`apps/api/src/db/autoMigrate.ts:~831-838`); Postgres forbids *using* a value added in the same transaction. So file 1 only `ADD VALUE IF NOT EXISTS` (both enums, guarded `DO $$` like `2026-05-27-a-elevation-status-add-actuating.sql`); file 2 (sorted after) adds columns and re-creates the CHECK that names `'withdrawn'`. Neither file writes rows, so neither needs `set_config('breeze.scope','system',true)`.

### D4 — Technician UX (minimal)

- Web: `withdrawn` in the `ElevationStatus` union, `STATUS_LABELS` (`'Withdrawn'`), `statusBadgeClass` (neutral grey, same family as `expired`), the requests and audit filter lists, `PamPage` live-refresh event list. A one-line reason under the badge from `withdrawnReason`: `user_denied` → "Declined by the user", `user_timeout` → "No answer on the device", `dialog_error` → "Prompt failed on the device". When `enforcementReason` is `user_declined` on an `approved` or `auto_approved` row: "Declined on the device" (and distinct strings for `user_decision_pending` / `user_decline_record_untrusted`). `STATUS_LABELS` are hard-coded English today (`types.ts:227-235`); the reason strings follow the surrounding `t('security:…', { defaultValue })` pattern → new keys in all 8 locale files.
- Respond modal: on 409 with `currentStatus === 'withdrawn'`, show "The user withdrew this request on the device." instead of the generic not-pending text.
- Mobile: **no change in wave 1.** The withdraw expires the linked approval rows, so the phone shows the existing "expired"/"Already decided elsewhere" states (`ApprovalScreen.tsx:271-272`). Withdraw-specific mobile copy needs an app release and an API contract change (`finalStatus`) — deferred to #8928.

### D5 — Audit + evidence

- `elevation_audit` row: `eventType 'withdrawn'`, `actor 'end_user'`, `details { cause: <reason>, agent_declined_at: <ISO or null> }`. General audit log action `pam.elevation_request.withdrawn` via `writeAuditEvent` (same call shape as respond, `routes/pam.ts:~786`).
- `PAM_AUDIT_WRITER_DETAIL_KEYS` (`services/pamAuditExport.ts:60`) gets an entry for the new writer file with `['cause', 'agent_declined_at']`; the freeze test then passes.
- Export: `tenantExportPolicyRegistry.ts:481` `elevation_requests` → add `withdrawn_at`, `withdrawn_reason` to `included` (scalar, non-sensitive). Enum values need no registration (per-column policy). No new table → no cascade/merge registration.
- Ownership-epoch evidence (`docs/superpowers/plans/pam/2026-10-06-pam-ownership-epoch.md`): unaffected. Epoch writers (`pamActuationLifecycle.ts`, `pamActuationResult.ts`, `2026-12-23-150000-pam-chain-epoch-anchor.sql`) act on actuations; a withdrawn row never has one. `pamDeviceMoveGuard.ts:164` lists non-terminal statuses; `withdrawn` is terminal and correctly absent. `pamEvidenceRetention.ts` is timestamp-driven, no status switch.

### D6 — Version gating: none (Todd decision T1)

- No server→agent command is added, so nothing must be withheld from old agents; the server never needs to know whether an agent refuses declined IDs. A capability column would cost a migration, an export classification and a heartbeat field for no server decision. Any authenticated agent may withdraw its own device's pending `uac_intercept` row — it only ever *reduces* privilege.
- **Old agents (residual risk, accepted, documented in the PR and release notes):** they never call the route; the 15–20 min TTL window from #8971 remains until the device runs an agent with PR B. No server-side mitigation is sound: the server cannot distinguish "user still deciding" from "user declined" without the agent telling it. (Shortening `PAM_PENDING_REQUEST_TTL_MINUTES` is an operator option, not a code change.)
- **New agent, old server:** route 404 → acked `not_found`, local refusal still protects. Lab gate (B5) is required before fleet promote because PR B ships to endpoints.

### D7 — Scope split with #8928

Rides this wave (shared surface, built once): the withdraw route, `withdrawn` status + columns + CHECK, `withdrawn` audit event, `elevation.withdrawn` event, the web badge/filter, and the agent's decline store + apply refusal. #8928's "agent refuses `pam_apply_v2` for a request it withdrew" **is** D2.

Stays in #8928, unplanned here: outcome toasts, `pam_request_notify` + `pamUserNotifyProtocolVersion`, `supportName` in the submit response (and its caching), the third "Use admin credentials" button (will call this route with a new reason value → widen the reason CHECK then), Approve-time consent dismiss outside `denyConsent`, MessageBox fallback for three choices, deny-reason labelling/truncation, mobile withdraw copy.

Proposed comment for the orchestrator to post on #8928:

> #8971's plan (`docs/superpowers/plans/pam/2026-10-18-pam-user-decision-reaches-server.md`) now owns the shared base: the `POST /agents/:id/elevation-requests/:requestId/withdraw` route, the `withdrawn` status (with `withdrawn_at` / `withdrawn_reason`), the `withdrawn` audit event, the "Withdrawn" badge, and the agent-side refusal of declined requests. Please build #8928 on that: "Use admin credentials" becomes one more `withdrawn_reason` value calling the same route, and the toasts / `pam_request_notify` / `supportName` / Approve-time dismiss stay as planned in your two PRs.


### Decisions for Todd (defaults are what this plan implements)

- **T1: Should the server gate on a new agent capability?** Codex recommends a `pamConsentProtocolVersion` capability that gates UAC approvals and apply creation.
  - **Default: no gate.** Old agents keep today's behaviour until they upgrade: the 15–20 minute window stays open for them, and the release notes say so.
  - The alternative: technicians cannot approve UAC requests on any device whose agent has not upgraded, until the fleet promote. That is safer, and a fleet-wide feature outage.
- **T2: Can a withdraw override an approval that already happened?**
  - **Default: no, pending only.** The agent refuses the launch, and the row reads **Approved · Declined on the device**.
  - The alternative (Codex): accept a withdraw on `approved`/`auto_approved`/`actuating` rows, move them to `withdrawn`, and request cleanup. The status list is cleaner, but it costs a second state machine edge and cleanup semantics in wave 1.
- **T3: `auto_approved` may launch twice.** The server's `pam_apply_v2` runs, and so does the local consent actuation after the dialog's Approve. It is unverified. **Default:** B5 case 7 records what actually happens, and the orchestrator files a follow-up issue if both paths fire.
- **T4: Store-corruption fence length. Default: 24 h** of refusing all remote applies on that device. The alternatives are 1 h (my first position) or latched until restart (Codex).

---

## PR split, file ownership, merge order

| PR | Owns | Safe alone because |
|---|---|---|
| **A — API** | migrations, `db/schema/elevations.ts`, `services/pamWithdraw.ts` (new), `routes/agents/elevationWithdraw.ts` (new), `routes/agents/index.ts`, `services/mcpCoverage.ts`, `services/pamAuditExport.ts`, `services/tenantExportPolicyRegistry.ts`, `services/eventBus.ts`, `routes/pam.ts` (list enum, `statusBreakdown`, 409 `currentStatus`, `withdrawnAt/withdrawnReason` in list projection), `services/aiToolSchemas.ts` | Nobody calls the route yet; the new status is unreachable. |
| **B — Agent** | `agent/internal/pamdecline/**` (new), `pamlifetime/{types,manager,manager_windows,manager_stub}.go`, `heartbeat/{pam_flow,handlers_actuate,heartbeat,pam_withdraw}.go` + tests | Against a pre-A server the route 404s → acked; the local refusal alone closes #8971. Can merge before or after A. |
| **C — Web** | `apps/web/src/components/pam/{types.ts,ui.tsx,PamRequestsTab.tsx,PamAuditTab.tsx,PamPage.tsx,PamRespondModal.tsx}` + 8 `security.json` locale files | Display only; needs A's API fields, so merge **after A**. |

Merge order: **A → B → C** (B may precede A). No intermediate state is less safe than main today. PR B is agent-shipped: it does not reach endpoints until a release + fleet promote, gated on B5.

**Conflict notice:** open PR #8673 edits `routes/pam.ts` (respond route) and `decideApprovalRequest.ts`; open PR #8677 edits `PamRequestsTab.tsx`. Rebase A/C onto whichever merges first; do not touch `decideApprovalRequest.ts` in this wave.

---

## PR A — API

### Task A1: Enum + columns migrations and schema

**Files:**
- Create: `apps/api/migrations/2026-12-31-190000-pam-elevation-withdrawn-enum.sql`
- Create: `apps/api/migrations/2026-12-31-190100-pam-elevation-withdrawn-columns.sql`
- Modify: `apps/api/src/db/schema/elevations.ts:48-73` (both enums), `:~128` (columns)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:481`
- Test: `apps/api/src/__tests__/integration/pamElevationWithdrawnSchema.integration.test.ts` (new)

**Interfaces:**
- Produces: `elevationStatusEnum` includes `'withdrawn'`; `elevationAuditEventTypeEnum` includes `'withdrawn'`; `elevationRequests.withdrawnAt: Date | null`, `elevationRequests.withdrawnReason: string | null`; exported `PAM_WITHDRAW_REASONS = ['user_denied','user_timeout','dialog_error'] as const` and `type PamWithdrawReason` from `apps/api/src/db/schema/elevations.ts`.

- [ ] **Step 1: Write the failing integration test** (real Postgres, system scope for fixture setup, following `pamActuationTransitions.integration.test.ts` fixtures):
  - `it('withdrawn row requires withdrawn_at and a valid reason')`: UPDATE a pending fixture to `status='withdrawn'` with `withdrawn_at` NULL → rejects with constraint `elevation_requests_status_timestamps_chk`; with `withdrawn_reason='nope'` → rejects with `elevation_requests_withdrawn_reason_chk`; with `withdrawn_at=now(), withdrawn_reason='user_denied'` → succeeds.
  - `it('accepts a withdrawn audit event')`: insert `elevation_audit` `event_type='withdrawn', actor='end_user'` → succeeds.
- [ ] **Step 2: Run, verify FAIL** — `invalid input value for enum elevation_status: "withdrawn"`. Command per `docs/agents/testing.md` integration recipe on a per-worktree test stack.
- [ ] **Step 3: Write file 1** — only `ALTER TYPE elevation_status ADD VALUE IF NOT EXISTS 'withdrawn';` and `ALTER TYPE elevation_audit_event_type ADD VALUE IF NOT EXISTS 'withdrawn';`, each inside the `DO $$ … IF EXISTS (pg_type) … $$` guard of `2026-05-27-a-elevation-status-add-actuating.sql`. Header comment: why the value is unused in this file.
- [ ] **Step 4: Write file 2** — `ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz`, `ADD COLUMN IF NOT EXISTS withdrawn_reason varchar(32)`; `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT elevation_requests_withdrawn_reason_chk CHECK (withdrawn_reason IS NULL OR withdrawn_reason IN ('user_denied','user_timeout','dialog_error'))`; `DROP CONSTRAINT IF EXISTS` + re-`ADD` `elevation_requests_status_timestamps_chk` with the five existing clauses copied verbatim from `2026-09-16-pam-actuation-lifecycle.sql:20-25` plus `OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL)`. Header: cite the `actuating` CHECK miss as the reason this file exists.
- [ ] **Step 5: Schema** — add the enum values, the two columns, and `PAM_WITHDRAW_REASONS`. Add `withdrawn_at`, `withdrawn_reason` to `elevation_requests.included` in the export registry.
- [ ] **Step 6: Run** the new integration test → PASS; `pnpm db:check-drift` → clean; tenant-export contract suite (`docs/agents/testing.md`) → PASS.
- [ ] **Step 7: Commit** `feat(api): elevation status 'withdrawn' + withdrawn_at/withdrawn_reason (#8971)`.

### Task A2: Withdraw service + agent route

**Files:**
- Create: `apps/api/src/services/pamWithdraw.ts`
- Create: `apps/api/src/routes/agents/elevationWithdraw.ts` (keeps `elevationRequests.ts`, 759 lines, from growing)
- Modify: `apps/api/src/routes/agents/index.ts` (mount next to `elevationRequestsRoutes`, `:99`)
- Modify: `apps/api/src/services/mcpCoverage.ts` (`'agents/elevationWithdraw.ts': { exempt: 'agent_transport' }`, next to `:235`)
- Modify: `apps/api/src/services/pamAuditExport.ts:60` (`'services/pamWithdraw.ts': ['cause', 'agent_declined_at']`)
- Modify: `apps/api/src/services/eventBus.ts:195-201` and `:712-718` (`'elevation.withdrawn'`, `ELEVATION_WITHDRAWN`)
- Test: `apps/api/src/routes/agents/elevationWithdraw.test.ts` (new, mocked DB), `apps/api/src/__tests__/integration/pamElevationWithdraw.integration.test.ts` (new)

**Interfaces:**
- Consumes: A1's enum values, columns, `PAM_WITHDRAW_REASONS`.
- Produces:
  ```ts
  export type WithdrawOutcome =
    | { kind: 'withdrawn'; withdrawnAt: Date; replay: boolean }
    | { kind: 'not_pending'; status: string }
    | { kind: 'not_found' };
  export async function withdrawElevationRequest(input: {
    orgId: string; deviceId: string; requestId: string;
    reason: PamWithdrawReason; agentDeclinedAt: Date | null;
  }): Promise<WithdrawOutcome>;
  ```
  Route responses: 200 `{ id, status: 'withdrawn', withdrawnAt }`; 409 `{ error: 'not_pending', status }`; 404 `{ error: 'not_found' }`; 400 invalid body/uuid; 403 `Forbidden` / `drain_restricted`.

- [ ] **Step 1: Write failing integration tests** (`pamElevationWithdraw.integration.test.ts`, real PG, `breeze_app` role for the call):
  - `pending → withdrawn`: status, `withdrawn_at` set, `withdrawn_reason='user_denied'`, one audit row `withdrawn/end_user` with `details.cause='user_denied'`.
  - `replay is idempotent`: second call → `{kind:'withdrawn', replay:true}`, still one audit row.
  - `approve-then-withdraw returns not_pending approved` (respond's CAS first) and `withdraw-then-approve`: respond's CAS updates 0 rows.
  - `concurrent approve and withdraw: exactly one wins` (two connections, `Promise.all`, assert final status ∈ {approved, withdrawn} and the loser saw 0 rows / not_pending).
  - `linked pending mobile approvals become expired` after the route (exercise via the route handler so `runAfterDbContextExit` runs; reuse fixtures from `pam-mobile-bridge-sibling-expiry.integration.test.ts`).
  - `other device's request → not_found`; `other org → not_found`; `flow_type tech_jit_admin → not_found`; `expired row → not_pending expired`.
  - `device moved (pamDeviceMoveGuard expiry) then withdraw → not_pending expired`.
- [ ] **Step 2: Write failing route unit tests** (`elevationWithdraw.test.ts`, pattern of `pamReconciliation.test.ts`): 403 when `agent.agentId !== :id`; 403 `drain_restricted`; 400 on `reason: 'other'` and non-uuid `requestId`; 200/409/404 mapping from mocked `withdrawElevationRequest`; `expireSupersededMobileApprovals` and `publishEvent('elevation.withdrawn', …)` called only on `kind:'withdrawn' && !replay`.
- [ ] **Step 3: Run both, verify FAIL** (module not found).
- [ ] **Step 4: Implement** `withdrawElevationRequest` (D3 transaction; audit via the `elevationAudit` insert + `writeAuditEvent('pam.elevation_request.withdrawn')`) and the route (D1 guards; zod `{ reason: z.enum(PAM_WITHDRAW_REASONS), declinedAt: z.string().datetime().optional() }`; body cap 4 KB). Register mcp-coverage exemption, audit writer keys, event type.
- [ ] **Step 5: Run** both test files → PASS; `apps/api/src/__tests__/mcp-coverage.test.ts` and `services/pamAuditExport.test.ts` → PASS.
- [ ] **Step 6: Commit** `feat(api): agent withdraw route for a pending elevation (#8971)`.

### Task A3: Status surfaces in existing API routes

**Files:**
- Modify: `apps/api/src/routes/pam.ts:279-281` (list `status` zod enum), `:1380-1388` (`statusBreakdown` seed), `:769-775` (409 body adds `currentStatus`), list projection (add `withdrawnAt`, `withdrawnReason`)
- Modify: `apps/api/src/services/aiToolSchemas.ts:294`
- Test: `apps/api/src/routes/pam.test.ts`, `apps/api/src/services/aiToolSchemas.test.ts` (or the existing schema test for the PAM list tool)

**Interfaces:** Produces list rows with `withdrawnAt: string|null`, `withdrawnReason: PamWithdrawReason|null`; respond 409 body `{ success:false, error, currentStatus }`.

- [ ] **Step 1: Failing tests:**
  - `GET /pam/requests?status=withdrawn` → 200 (it is 400 today).
  - The stats `statusBreakdown.withdrawn` key is present and `=== 0`.
  - Respond on a withdrawn row → 409 with `currentStatus: 'withdrawn'`.
  - **Respond loses the CAS to a concurrent withdraw** (the mocked UPDATE returns 0 rows after a pending SELECT) → `currentStatus` comes from a re-read, not from the stale `row.status` (Codex finding, `routes/pam.ts:674-676`).
  - The AI list tool schema accepts `status: 'withdrawn'`.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** the edits. On a lost CAS, re-select `status` inside the same tx before returning `conflict`. Leave the `ACTIVE_STATUSES` lists alone, because `withdrawn` is terminal.
- [ ] **Step 4: Run** → PASS. Full API typecheck: `NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --noEmit; echo "exit=$?"` → `exit=0` (read the exit code; never pipe to tail).
- [ ] **Step 5: Commit** `feat(api): list/filter/stats/AI schema know 'withdrawn' (#8971)`.

**PR A exit:** Test API, Integration Tests (org-cascade + tenant-export + the two new suites), mcp-coverage, `db:check-drift` green. Run the integration suites on a per-worktree test stack locally before pushing (`pnpm test` skips them).

---

## PR B — Agent

### Task B1: `pamdecline` durable store

**Files:**
- Create: `agent/internal/pamdecline/store.go`, `agent/internal/pamdecline/store_test.go`

**Interfaces:**
- Produces:
  ```go
  type Reason string
  const (
      ReasonUserDenied  Reason = "user_denied"
      ReasonUserTimeout Reason = "user_timeout"
      ReasonDialogError Reason = "dialog_error"
  )
  type State string
  const (StateAwaiting State = "awaiting"; StateDeclined State = "declined")
  const (
      CodeUserDeclined          = "user_declined"
      CodeUserDecisionPending   = "user_decision_pending"
      CodeDeclineRecordUntrusted = "user_decline_record_untrusted"
      AckedRetention     = 7 * 24 * time.Hour
      MaxEntries         = 4096
      UntrustedLoadFence = 24 * time.Hour
  )
  var ErrCorrupt, ErrPersist error
  type Entry struct {
      RequestID     string    `json:"requestId"`
      State         State     `json:"state"`
      ServerStatus  string    `json:"serverStatus"` // "pending" | "auto_approved" (ingest answer)
      Reason        Reason    `json:"reason,omitempty"`
      CreatedAt     time.Time `json:"createdAt"`
      DeclinedAt    time.Time `json:"declinedAt,omitempty"`
      AckedAt       time.Time `json:"ackedAt,omitempty"`
      AckOutcome    string    `json:"ackOutcome,omitempty"`
      Attempts      int       `json:"attempts"`
      NextAttemptAt time.Time `json:"nextAttemptAt,omitempty"`
  }
  func NewStore(path string, now func() time.Time) *Store // path "" = memory-only
  func (s *Store) Load() error // nil | ErrCorrupt (moved to <path>.corrupt, fence armed); converts awaiting → declined/user_timeout
  func (s *Store) BeginAwaiting(requestID, serverStatus string) error
  func (s *Store) Consent(requestID string) error                // removes the entry, wakes waiters
  func (s *Store) Decline(requestID string, reason Reason) error // awaiting|absent → declined (first DeclinedAt wins), wakes waiters
  // code is one of the Code* constants when refuse is true. Store satisfies pamlifetime.DeclineChecker.
  func (s *Store) Check(requestID string) (refuse bool, code string) // non-blocking: awaiting → (true, CodeUserDecisionPending)
  func (s *Store) Await(ctx context.Context, requestID string) (refuse bool, code string) // blocks while awaiting; ctx done → (true, CodeUserDecisionPending)
  func (s *Store) Due() []Entry // declined && ServerStatus=="pending" && un-acked && NextAttemptAt <= now
  func (s *Store) MarkAttempt(requestID string, next time.Time) error
  func (s *Store) MarkAcked(requestID, outcome string) error // never clears the refusal
  func (s *Store) Prune() error
  ```
  Every mutating method mutates memory first, then persists. On a persist error it returns `ErrPersist` with the in-memory change kept. Request IDs must be canonical lowercase UUIDs; others are rejected with an error and no entry.

- [ ] **Step 1: Failing tests:**
  - `TestDeclineThenCheckRefuses`
  - `TestConsentRemovesAndAllows`
  - `TestStoreSurvivesReload`: a new `Store` on the same path → `Check` refuses.
  - `TestAwaitingAtLoadBecomesDeclinedTimeout`
  - `TestAwaitBlocksUntilDecline` and `TestAwaitBlocksUntilConsent` (goroutine + channel; neither returns before the transition)
  - `TestAwaitTimesOutAsDecisionPending`
  - `TestCorruptStoreFencesAllApplies`: a garbage file → `Load` returns `ErrCorrupt`, `<path>.corrupt` exists, `Check(randomUUID)` returns `(true, CodeDeclineRecordUntrusted)`, and returns no refusal once the injected clock passes 24 h.
  - `TestPersistFailureStillRefusesInProcess` (read-only dir)
  - `TestUnackedNeverPruned` (clock +30 days)
  - `TestAckedPrunedAfterSevenDays`
  - `TestMaxEntriesEvictsAckedFirst`
  - `TestDueOnlyPendingDeclinedUnacked`, which also checks `auto_approved` is excluded.
  - `TestRejectsNonCanonicalUUID`
  - File mode is `0600` on POSIX.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/pamdecline/...` → FAIL (package missing).
- [ ] **Step 3: Implement** using the `desktopfence/store.go` write path: temp file + fsync + `atomicrename.Replace`, `schemaVersion`, a mutex-guarded map, and one `chan struct{}` per awaiting entry, closed on resolve.
- [ ] **Step 4: Run** → PASS (`-race`).
- [ ] **Step 5: Commit** `feat(agent): durable PAM decline record (#8971)`.

### Task B2: Record awaiting/declined in `RunPamFlow`

**Files:**
- Modify: `agent/internal/heartbeat/pam_flow.go:108-162`
- Modify: `agent/internal/heartbeat/heartbeat.go`:
  - Add `Heartbeat` fields `pamDeclines *pamdecline.Store` and `pamWithdrawKick chan struct{}`.
  - Construct a memory-only store in the constructor.
  - In `SetStatePath` (`:1624-1632`), replace it with a file-backed store at `filepath.Join(filepath.Dir(path), "pam-declined-requests.json")` and call `Load()`, logging an Error on `ErrCorrupt`.
- Test: `agent/internal/heartbeat/pam_flow_test.go`

**Interfaces:**
- Consumes: B1 `Store`.
- Produces:
  - `func pamWithdrawReason(dialog ipc.PamDialogResult, dialogErr error) pamdecline.Reason`
  - `func (h *Heartbeat) kickPamWithdrawDrain()`: a non-blocking send on `pamWithdrawKick`.

- [ ] **Step 1: Failing tests.** Extend the `TestRunPamFlow` table and add new tests using the existing `pamRequestDialog` / `pamDismissConsent` fakes:
  - `pending + Deny`:
    - An `awaiting` entry exists **when the dialog fake is invoked** (assert inside the fake).
    - A `declined/user_denied` entry exists **when the dismiss fake is invoked**.
    - The kick channel receives.
  - `pending + round-trip ErrCommandTimeout` → `user_timeout`.
  - `pending + other error` → `dialog_error`.
  - `pending + {Approved:false, DismissedByUser:false}` (helper countdown) → `user_timeout`.
  - `pending + Approve` → the entry is removed (`Check` allows).
  - `auto_approved + Deny` → `declined`, but `Due()` is empty.
  - `auto_approved + Approve` → removed.
  - `policy denied` → no entry, and the dialog fake is never called.
  - `TestPamWithdrawReasonTable` covers the mapping function.
  - A persist failure (inject a store on a read-only path) must not block `denyConsent`.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/heartbeat/ -run 'TestRunPamFlow|TestPamWithdrawReason'` → FAIL.
- [ ] **Step 3: Implement**:
  - Call `BeginAwaiting(outcome.RequestID, string(outcome.Status))` immediately before `ask(...)`.
  - Keep the original `err` from `ask(...)` in its own variable. Today line `:121` overwrites the dialog with a synthetic result and drops the error.
  - `PamActionDeny` branch: `Decline(...)`, then `denyConsent` (unchanged), then `kickPamWithdrawDrain()`.
  - `PamActionAwaitRemote` and `PamActionActuate` branches: `Consent(...)`.
  - The `unexpected_status` branch: `Decline(..., ReasonDialogError)`.
- [ ] **Step 4: Run** → PASS, together with the whole existing `pam_flow_test.go` (the gate tests are unchanged).
- [ ] **Step 5: Commit** `feat(agent): record the user's answer to a PAM dialog durably (#8971)`.

### Task B3: Refuse in both apply paths; wait on an open dialog

**Files:**
- Modify: `agent/internal/pamlifetime/types.go`: add `type DeclineChecker interface { Check(requestID string) (refuse bool, code string) }`.
- Modify: `agent/internal/pamlifetime/manager.go:158-176`: the non-blocking check goes right after `currentBootID`, before admission, `PinTarget`, `PrepareApply` and the received handoff.
- Modify: `manager_windows.go` and `manager_stub.go`: add `SetDeclineChecker(DeclineChecker)` (nil = no-op).
- Modify: `agent/internal/heartbeat/handlers_actuate.go`:
  - `handlePamApplyV2` `:67-104`: after identity validation, `h.pamDeclines.Await(waitCtx, payload.RequestID)` with a 100 s `waitCtx` derived from `context.Background()`. Create the 2-minute operation ctx **after** the wait.
  - `handleActuateElevation` `:304-312`: the same wait, then `actuateResult{Success:false, Reason:<code>}` + `writePAMActuationRefused` on refusal.
- Modify: `heartbeat.go` `SetStatePath`: call `SetDeclineChecker(h.pamDeclines)` through a type assertion on `h.pamLifetimeManager`.
- Test: a new `agent/internal/pamlifetime/manager_decline_test.go` (cross-platform, using the existing fake Windows deps from `manager_stub_test.go` / `manager_failure_code_test.go`), and `agent/internal/heartbeat/handlers_actuate_decline_test.go` (new).

**Interfaces:** Consumes B1. Produces `Result{State: ResultFailed, FailureCode: <code>}` with the real boot ID and the command's own actuation ID and generation (via the existing `m.failed`).

- [ ] **Step 1: Failing tests:**
  - `TestApplyRefusesDeclinedRequest`:
    - The checker refuses → `State == failed` and `FailureCode == "user_declined"`.
    - The fake `PinTarget`, promote and received-handoff are **never called**.
    - The ledger has no entry.
  - `TestApplyRefusesWhenDeclineRecordUntrusted` → `user_decline_record_untrusted`.
  - `TestApplyUnaffectedForOtherRequest`
  - `TestApplyRefusesDeclinedAfterRestart`: `Decline` on a temp-path store, then a new store with `Load`, then a new manager with that checker → refused.
  - `TestApplyWaitsForOpenDialogThenRefusesOnDeny`: `BeginAwaiting`, then call `handlePamApplyV2` in a goroutine, then `Decline` after 50 ms → `failed/user_declined`, and the manager fake is never entered.
  - `TestApplyWaitsForOpenDialogThenProceedsOnApprove`: same setup with `Consent` → the manager fake is entered once.
  - `TestApplyWaitTimesOut` (inject a 100 ms wait bound) → `user_decision_pending`.
  - `TestActuateElevationRefusesDeclined`:
    - The result is `actuateResult{Success:false, Reason:"user_declined"}`.
    - The `writePAMActuationRefused` stub is called.
    - `newElevationAccountManager` is never constructed.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/pamlifetime/... ./internal/heartbeat/ -run 'Declin|OpenDialog|WaitTimesOut'` → FAIL.
- [ ] **Step 3: Implement** using the D2 placement. Make the wait bound a `Heartbeat` field (default `pamDialogTimeout + pamDismissTimeout`) so tests can shorten it.
- [ ] **Step 4: Verify the server tolerates the wait.** Check that `apps/api/src/jobs/staleCommandReaper.ts` does not reap a `pam_apply_v2` in `sent`/`running` sooner than 100 s + the 2-minute operation. Quote the constant in the PR. If it is shorter, lower the wait bound to fit and say so.
- [ ] **Step 5: Run** → PASS. Also run `GOOS=windows go vet ./internal/pamlifetime/... ./internal/heartbeat/...` and `GOOS=windows go build ./...`, because of the Windows build tags.
- [ ] **Step 6: Commit** `fix(agent): never apply an elevation the user declined or has not answered (#8971)`.

### Task B4: Withdraw delivery (outbox drain)

**Files:**
- Create: `agent/internal/heartbeat/pam_withdraw.go`, `agent/internal/heartbeat/pam_withdraw_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` `Start()` (`:2099`): launch `go h.runPamWithdrawDrain()`.

**Interfaces:**
- Consumes: B1 `Due`, `MarkAttempt`, `MarkAcked`, `Prune`; the A2 response contract.
- Produces:
  ```go
  type pamWithdrawOutcome string // "withdrawn" | "not_pending:<status>" | "not_found" | "rejected" | "retry"
  func (h *Heartbeat) postPamWithdraw(ctx context.Context, e pamdecline.Entry) pamWithdrawOutcome
  func (h *Heartbeat) drainPamWithdrawals(ctx context.Context)
  func (h *Heartbeat) runPamWithdrawDrain()      // kick channel + 60 s ticker + stopChan
  func pamWithdrawBackoff(attempts int) time.Duration // 5s * 2^attempts, max 5m, no give-up
  ```
- [ ] **Step 1: Failing tests** (`httptest.Server`, memory store, injected clock):
  - `TestWithdrawDrainAcksOn200`, and `…On409`, which acks `not_pending:approved`.
  - `TestWithdrawDrain404IsTerminal`.
  - `…400IsTerminalAndLoggedError`.
  - `TestWithdrawDrainRetriesOn5xxNetwork401And429`: `Attempts` increments, `NextAttemptAt` follows the backoff, and the entry stays un-acked.
  - `TestWithdrawDrainOfflineThenOnline`: the server is down for two passes and up on the third → acked. `Check` still refuses afterwards.
  - `TestWithdrawBodyAndPath`:
    - `POST /api/v1/agents/<agentId>/elevation-requests/<id>/withdraw`.
    - The `Authorization` header comes from `h.authHeader()`.
    - JSON body `{"reason":"user_denied","declinedAt":"<RFC3339>"}`.
  - `TestWithdrawSkipsAutoApproved`
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/heartbeat/ -run 'Withdraw'` → FAIL.
- [ ] **Step 3: Implement**:
  - One HTTP attempt per due entry per pass: `httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, httputil.RetryConfig{MaxRetries: 0})` with a 15 s per-request timeout.
  - Classify the response per D1.
  - Call `Prune()` on each pass.
  - The drain is single-flight (one goroutine).
- [ ] **Step 4: Run** → PASS. Then run the full suites for the touched packages: `cd agent && go test -race ./internal/heartbeat/... ./internal/pamlifetime/... ./internal/pamdecline/...`, plus `GOOS=windows go build ./...`, plus the repo's Go lint target if it covers these packages.
- [ ] **Step 5: Commit** `feat(agent): deliver the user's withdraw to the server with retry (#8971)`.

### Task B5: Windows lab gate (before fleet promote — not a merge gate)

Run on the Windows lab VM against a stack with PR A, recording results in the PR:
1. Pending request → Deny → web shows **Withdrawn · Declined by the user** within seconds; approving from web → 409 "withdrew" message.
2. Pending → let the dialog time out → **Withdrawn · No answer on the device**.
3. Race: block the API from the VM (firewall rule) → Deny → approve in web (row `approved`) → unblock → agent refuses `pam_apply_v2`; nothing launches; row shows **Approved · Declined on the device**; agent log + Windows Event Log carry the refusal.
4. Restart between Deny and approval: block API → Deny → `Restart-Service` the agent → approve → unblock → refused.
5. Corrupt `pam-declined-requests.json`, then restart. Any approval in the next 24 h is refused with `user_decline_record_untrusted`, and the `.corrupt` file is present.
6. Approve in web **while the dialog is still open**, then click Deny. Nothing launches, and the row shows **Approved · Declined on the device**. Repeat with Approve on the dialog: the app launches once, after the click.
7. An `auto_approved` rule, then Deny on the dialog. Nothing launches, and the row shows **Auto-approved · Declined on the device**. Also record whether the Approve case launches the target once or twice (T3).

---

## PR C — Web

### Task C1: Withdrawn badge, reasons, filters, respond-modal copy

**Files:**
- Modify: `apps/web/src/components/pam/types.ts` (`ElevationStatus` `:5-12`, `STATUS_LABELS` `:227-235`, `statusBadgeClass` `:264-279`, `decidedByLabel` `:298-310`, request type gains `withdrawnAt`, `withdrawnReason`, `enforcementReason`), `ui.tsx:114-120`, `PamRequestsTab.tsx:46-55`, `PamAuditTab.tsx:~40-50` (status + event-type lists), `PamPage.tsx:16-24` (`'elevation.withdrawn'`), `PamRespondModal.tsx` (409 `currentStatus`)
- Modify: all 8 `apps/web/src/locales/*/security.json` (keys below)
- Test: `apps/web/src/components/pam/*.test.tsx` next to each file touched (`PamRespondModal.test.tsx` exists)

**Interfaces:** Consumes A3 list fields and 409 body. New locale keys (namespace `security`): `pamWithdrawReason.user_denied` = "Declined by the user", `pamWithdrawReason.user_timeout` = "No answer on the device", `pamWithdrawReason.dialog_error` = "Prompt failed on the device", `pamEnforcement.userDeclined` = "Declined on the device", `pamEnforcement.userDecisionPending` = "No answer on the device", `pamEnforcement.declineRecordUntrusted` = "Refused: device decision record unavailable", `pamRespond.withdrawnConflict` = "The user withdrew this request on the device."

- [ ] **Step 1: Failing tests:** `StatusBadge` renders "Withdrawn" for `withdrawn`; row renders the reason line from `withdrawnReason`; an approved row with `enforcementReason:'user_declined'` renders "Declined on the device", and so does an `auto_approved` row; `user_decision_pending` and `user_decline_record_untrusted` render their own strings; filter list offers `withdrawn`; respond modal on 409 `currentStatus:'withdrawn'` shows the withdrew copy and keeps submit disabled.
- [ ] **Step 2: Run** `pnpm --filter @breeze/web exec vitest run src/components/pam` → FAIL.
- [ ] **Step 3: Implement**; add the five keys to `en` and the other 7 locales (translated, not English copies, per existing locale practice).
- [ ] **Step 4: Run** → PASS; `src/lib/i18n/localeParity.test.ts`, `src/lib/__tests__/no-silent-mutations.test.ts` (no new mutation added — confirm it still passes), web typecheck with 12 GB heap, exit code read.
- [ ] **Step 5: Commit** `feat(web): show withdrawn PAM requests and user declines (#8971)`.

---

## Contract tests that fire

| Suite | Why | PR |
|---|---|---|
| `mcp-coverage.test.ts` | new route file under `routes/` | A |
| tenant-export / org-cascade (Integration Tests job only) | new columns on `elevation_requests` | A |
| `pamAuditExport` writer-key freeze | new `elevation_audit` writer file | A |
| `migrationRlsScope.test.ts` | new migrations (no row writes → no scope line needed; suite must still pass) | A |
| `rls-coverage` | no new table — should be untouched; run anyway | A |
| `partner-wide-write-coverage` | not relevant (no config/policy table) | — |
| `localeParity`, `no-silent-mutations` | new keys; no new mutation | C |
| Go `-race`, `GOOS=windows` build | agent-shipped | B |

CI traps: `pnpm test` skips the RLS/integration suites; run them on a per-worktree test stack. A stacked PR (base ≠ main) gets no CI — open A, B, C each against `main`.

## Exit checklist

- [ ] The five #8971 cases have a named passing test: deny (B2, A2), timeout (B2), approval racing a withdraw (A2 concurrency + B3), agent offline at deny (B4), agent restart between deny and approval (B1 + B3).
- [ ] `elevation_requests_status_timestamps_chk` accepts `withdrawn` (A1 integration test, real PG).
- [ ] Export registry classifies both new columns; `db:check-drift` clean.
- [ ] Agent: `go test -race` green on touched packages; Windows build green.
- [ ] Approval while the dialog is open waits, then honours the answer (B3).
- [ ] B5 lab run recorded before fleet promote, including cases 6 and 7.
- [ ] Release note: old agents keep the pending-TTL window until upgraded.
- [ ] #8928 comment (D7) posted by the orchestrator.
