---
issue: 8928
related: 8971
depends_on: docs/superpowers/plans/pam/2026-10-18-pam-user-decision-reaches-server.md (PR 2 only)
status: draft
---

# PAM Approval End-User Experience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standard user who asks for admin elevation on Windows always knows what is happening:
- Approving a request that needs IT closes the UAC prompt and says the request was sent.
- They get a toast when IT approves, denies (with the reason) or lets the request expire.
- They can choose to use local admin credentials instead.
- When the server can't be reached, they're told so.

**Architecture:**
- **Agent tracker:** an in-memory tracker of the requests the user handed to IT. The agent shows the waiting, approved, approved-but-couldn't-start and offline toasts itself.
- **New command:** the API queues a fire-and-forget device command, `pam_request_notify`, when a tracked request is denied or expires. Only agents that report `pamUserNotifyProtocolVersion: 1` can claim it.
- **"Use admin credentials":** a third dialog button. It records a decline in #8971's durable decline store and calls #8971's withdraw route with the new reason `local_credentials`. It does not dismiss UAC.

**Tech Stack:** Go agent (Win32 dialog, sessionbroker IPC), Hono + Drizzle API, Astro/React web, Expo mobile, Vitest, `go test -race`.

**Spec:**
- Issue #8928, plus the owner's review comments on it (2026-10-16, 2026-10-17 and 2026-10-18).
- The design was approved section by section in brainstorming on 2026-10-16.
- This revision (2026-10-20) applies the review. See "Review responses".
- The decisions the review opened (T1–T4, plus the one-plan shape) were settled in brainstorming on 2026-10-20. See "Decisions".
- The Design section below is the spec. There is no separate spec doc, at the requester's request.

---

## Relationship to #8971 (read first)

**This plan covers only what #8971 does not.** #8971's plan (`2026-10-18-pam-user-decision-reaches-server.md`, merged as a doc in #9185, not yet implemented) owns all of these, and this plan neither builds nor re-tests them:
- the withdraw route and its guards;
- the `withdrawn` status, columns and audit event;
- the agent's decline store and its refusal to launch a declined request;
- the withdraw outbox drain;
- the Deny / timeout / dialog-error reasons;
- the "Withdrawn" badge and filters.

The scope here is exactly #8971's D7 list of items that "stay in #8928":

| #8971 D7 item | Here |
|---|---|
| Outcome toasts | Tasks 1.5, 1.7 |
| `pam_request_notify` + `pamUserNotifyProtocolVersion` | Tasks 1.1–1.3, 1.7 |
| `supportName` in the submit response, and its caching | Tasks 1.4, 1.6 |
| Deny-reason labelling and truncation | Tasks 1.3, 1.9 |
| The third "Use admin credentials" button, as a new `withdrawn_reason` with the CHECK widened | Tasks 2.1–2.3 |
| MessageBox fallback for three choices | Task 2.2 |
| Approve-time consent dismiss outside `denyConsent` | Task 2.3 |
| Mobile withdraw copy (needs a `finalStatus` API contract change and an app release) | **Out of scope.** It is not in issue #8928, so it moves to its own follow-up issue. See "Mobile withdraw copy". |

There is one extra item outside D7: the offline toast (Task 1.8). It comes from issue #8928 itself and touches nothing #8971 owns.

**Ordering:** PR 1 does not depend on #8971. PR 2 needs #8971 PR A (API) and PR B (agent) merged first.

**Mobile withdraw copy (decided 2026-10-20: separate issue).** #8971 D4 hands "withdraw-specific mobile copy" to #8928. The requester decided it gets its own follow-up issue instead, because it needs a `finalStatus` API contract change and a mobile app release. Until that issue lands, the phone shows #8971's existing "expired" / "Already decided elsewhere" states. Neither PR here touches it.

---

## Review responses (owner comments on #8928)

| Review point | Resolution | Where |
|---|---|---|
| Do the Approve-time dismiss outside `denyConsent`: an unproven dismissal engages the fail-closed gate, and its recovery probes can cancel unrelated UAC prompts. | New `dismissConsentForRemote` calls `DismissPamConsent` directly. **It never sets `pamDismissalUncertain` and never starts recovery probes.** An unproven result is a Warn log. It holds `pamActuateMu` only for the call, and skips the dismiss if the gate is already engaged, because the helper may still be acting. | D1, Task 2.3 |
| Only dismiss when `pam_apply_v2` is available; legacy `actuate_elevation` types into that prompt. | The dismiss runs only when `pamLifetimeProtocolVersion() == 2`. That is the same condition the server uses to dispatch `pam_apply_v2` (worker `pamActuationWorker.ts:91-97`, claim gate `commandDispatch.ts:360-361`). `pam_apply_v2` never touches consent.exe. `actuate_elevation` is now issued only by the manual MFA admin route `routes/devices/actuateElevation.ts`, and nothing in `apps/web` calls it. If an admin uses that route after a dismiss, it fails `no_consent_window` (sendinput) and nothing launches. That is fail-closed, and the PR says so. | D1, Task 2.3 |
| `supportName` arrives with a successful submit, but the offline toast fires on a failed one. Cache it. | The agent keeps the last non-empty `supportName` in memory **and** persists it in a sidecar `pam-support-name.json` next to `pam-lifetime-ledger.json`. The file is 0600 and written as a temp file plus `atomicrename.Replace`, the `reliability_state.json` pattern. It is loaded in `SetStatePath`. The offline toast says "IT" only on a device that has never completed a submit. It is not stored in `agent.state`, because `agentapp/main.go` rewrites that struct on start and stop. | Task 1.6 |
| The MessageBox fallback is Yes/No only; how does the third choice appear there? | With `AllowLocalCredentials`, the fallback uses `MB_YESNOCANCEL` and ends the body with a legend: Yes = send to {s}, No = deny, Cancel = enter admin credentials in the Windows prompt. `IDCANCEL` (and so Esc) maps to `LocalCredentials`. That is the safe failure: nothing is dismissed, and the request is declined locally, so no remote approval can launch it. Without the flag the box stays `MB_YESNO`, unchanged. The fallback only appears when the custom window can't be created (`pam_dialog_window_windows.go:319-328, 411-422, 477-479`). | D4, Task 2.2 |
| `withdrawn` status (enum migration, filters, audit enum); withdraw route guards (own device only, pending only, mobile-approval expiry). | Not in this plan; #8971 owns all of it (A1–A3, C1). PR 2 only adds the `local_credentials` reason value and its label. | Task 2.1 |
| Deny reasons allow 2000 chars. Truncate and sanitize them for the toast, and mark every deny-reason field (web modals, mobile `DenyReasonSheet`) as shown to the end user. | The server sanitizes the **payload copy** only. It strips C0 controls except `\n`, collapses three or more newlines to two, trims, and caps at 500 runes with a trailing `…`. The stored `denial_reason` is untouched, and the agent refuses anything over the caps. The "shown to the user" label and hint go on three fields: `PamRespondModal`; the PAM-linked cards in `ApprovalsInbox` (per-card deny; group deny is never PAM, `batchDecide.ts:158-175`); and mobile `DenyReasonSheet` for `uac_intercept` approvals. The sheet also gets `maxLength={500}`: it has none today, and the server caps at 500 (`routes/approvals.ts:615-617`). | Tasks 1.3, 1.9 |
| The new command type needs entries in the command registries (claim eligibility, result acceptance, offline policy). | Done; Task 1.2 has the full list. On **result acceptance**: there is no per-type result allowlist. Acceptance is decided by row status (`commandResultAcceptance.ts:54`), and the result of an unregistered type is stored generically. So `pam_request_notify` deliberately has no `commandResultHandlers` entry, and a test pins that its result is accepted and stored. | Task 1.2 |
| The plan didn't come through as an attachment. | Committed as this file, in its own docs PR. | — |
| Two PRs: outcome toasts + capability first, then dismiss, withdraw and the third button. Expect a rebase over #8677 in `PamRequestsTab.tsx`. | PR 1 and PR 2 below. PR 2 touches no `PamRequestsTab.tsx` code beyond #8971's; the `local_credentials` label lives in `types.ts` and the locale files. | PR split |

---

## Design

- **D1 — Approve on a pending request (PR 2).**
  - #8971's `Consent(requestID)` runs first and removes the awaiting entry.
  - Then, if `pamLifetimeProtocolVersion() == 2` and the gate is clear, the agent calls `dismissConsentForRemote`.
  - Either way, it tracks the request and shows the waiting toast.
  - If the dismiss is skipped or fails, the UAC prompt stays up. The user can cancel it, and the approval still launches via `pam_apply_v2`.
- **D2 — Outcome toasts (PR 1).**
  - **Approved:** `pam_apply_v2` reaches `verified_active`.
  - **Approved but couldn't start:** `pam_apply_v2` ends `failed`. #8971's failure codes (`user_declined`, `user_decision_pending`, `user_decline_record_untrusted`) never toast, because the user already chose.
  - **Denied / expired:** delivered by `pam_request_notify`.
  - **Tracker required:** every outcome toast needs a tracker entry, which is created when the user approves a `pending` request. Auto-approve and policy-deny never toast.
  - **PR 1 vs PR 2:** in PR 1, Approve creates the tracker entry with no dismiss and no waiting toast. PR 2 adds both.
- **D3 — Offline toast (PR 1).** Shown when the live submit fails. It is rate-limited to one per program and user per 5 minutes, and never fires from queue drain.
- **D4 — "Use admin credentials" (PR 2).**
  - Shown for `pending` requests only, with no setting.
  - The agent calls `pamdecline.Decline(id, ReasonLocalCredentials)`, and does **not** call `denyConsent`, so UAC stays up.
  - It then kicks the withdraw drain, and the server row becomes `withdrawn` with reason `local_credentials`.
  - No toast.
- **D5 — Support name.**
  - **Source:** `resolveMessageBranding(orgId)?.branding.companyName`, the same source as endpoint messages. It falls back to `IT`, and there is no new setting.
  - **Where it runs:** outside the request's org transaction, as `runOutsideDbContext(() => withSystemDbAccessContext(...))`. The precedent is `elevationRequests.ts:201`. This avoids taking a second pooled connection while a transaction is held.
  - **Failure:** best-effort; it never fails the submit.
- **D6 — Windows only.**

**Deliberate choices, called out in the PR:**
- **(a) No username fallback.** After an agent restart, toasts for requests that were already pending are skipped. ETW `SubjectUsername` (`DOMAIN\user`) does not reliably match `Session.Username`.
- **(b) Device-move expiry does not notify.** `pamDeviceMoveGuard.expireUnactuatedElevationRequests` moves the device to another org. It runs from both the move transaction and the org-merge executor (bare `db`), and a toast sent from the old tenant's context is wrong. The tracker TTL clears the entry.
- **(c) A hash-unverified refusal toasts as "denied".** `createPamDecisionIntent` turns an approval into `denied` (`pamActuationLifecycle.ts:154-170`), which is approved → denied, not pending → denied. The user is still waiting, so they get `Request denied` with the reason `The program could not be verified.` The internal constant is never sent.

## Global Constraints

- **Copy.** `{p}` is the base name of the target path, taken from the agent's own tracker and never from the payload. `{s}` is the support name.

  | Event | PR | Title | Body |
  |---|---|---|---|
  | waiting | 2 | `Request sent to {s}` | `{p} needs approval from {s}. You'll get a notification when they respond.` |
  | approved | 1 | `Request approved` | `{p} was approved by {s} and is starting.` |
  | approved, launch failed | 1 | `Request approved` | `{p} was approved but couldn't start. Contact {s}.` |
  | denied | 1 | `Request denied` | `{p} was denied by {s}.` plus `\nReason: {reason}` when the reason is non-empty |
  | expired | 1 | `Request expired` | `Your request for {p} expired before {s} responded. Try again or contact {s}.` |
  | offline | 1 | `Couldn't reach {s}` | `Breeze couldn't send the request for {p}. If you have administrator credentials, enter them in the Windows prompt.` |

- **Caps:**
  - Program name ≤ 260 runes, reason ≤ 500 runes, support name ≤ 120 runes (`NAME_MAX`, `brandingSnapshot.ts:27`).
  - The server truncates. The agent refuses an oversized reason and truncates an oversized support name.
- **`pam_request_notify` payload:** `{ requestId: string (uuid), outcome: 'denied' | 'expired', reason?: string }`.
  - There is no `programName`, because the agent uses its tracker.
  - `reason` is present only for `denied`.
- **Delivery window:** `deliverBy = now + 60 min`, which equals the agent's tracker TTL (`pamTrackedRequestTTL = 60 * time.Minute`). A toast about an older request is noise.
- **Capability:** `securityCapabilities.pamUserNotifyProtocolVersion`.
  - The agent reports `1` on Windows builds only.
  - The devices column is `pam_user_notify_protocol_version integer NOT NULL DEFAULT 0`.
  - The server normalizes any value other than `1` to `0`.
- **Withdraw reason (PR 2):** `local_credentials`. It is byte-identical in the DB CHECK, in `PAM_WITHDRAW_REASONS` and in `pamdecline.ReasonLocalCredentials`.
- **Migrations:**
  - Names must sort after the newest committed file **and** after #8971's pair. Check with the `localeCompare` one-liner in `apps/api/migrations/README.md`, not shell `sort`.
  - At plan time the newest file was `2027-01-02-110200-unifi-wifi-current-state.sql`. That means the #8971 names in its own plan are already stale.
  - PR 1 adds one file (the capability column) and PR 2 adds one file (the reason CHECK).
  - Neither file writes rows, so neither needs `breeze.scope`.
- **Offline-toast rate limit:** `ipc.NewRateLimiter(1, 5*time.Minute)`, keyed by the lower-cased target path + `|` + the subject username.
- **Notices** use the existing `TypeNotify` with `FallbackDialog: true`, `Urgency: "normal"`, and the title from the copy table (not `Breeze Agent`).
- **Public repo:** no customer names, hostnames or IPs in code, tests or PR text.

## Review Focus

1. **The `pam_request_notify` enqueue must never roll back the deny or expiry that queued it.** `insertQueuedCommandInTransaction` throws `ParkedDeviceCommandRefusedError` for parked devices (`unassignedPool/deliveryEligibility.ts:97-105`). Test: Task 1.3 `parked device: deny commits, no command`.
2. **`pam_apply_v2` redelivered** (on reconnect or a generation bump) must produce exactly one approved toast. Test: Task 1.7 `TestPamApplyV2ApprovedToastOnce`.
3. **A notify for an untracked request** (after a restart, or for a request the user declined locally) shows no toast, and the command still succeeds. Test: Task 1.7 `TestPamRequestNotifyUntrackedNoToast`.
4. **An unproven Approve-time dismiss does not engage the fail-closed gate**, and the dismiss is skipped when the gate is already engaged. Tests: Task 2.3 `TestDismissForRemoteUncertainLeavesGateClear` and `TestDismissForRemoteSkippedWhileGateEngaged`.
5. **"Use admin credentials" must never dismiss UAC, and must record exactly `local_credentials`.** Refusing a later approval is #8971's job (its B3 tests) and is not re-tested here. Tests: the Task 2.3 `pending + LocalCredentials` row, and Task 2.2 `TestPamMessageBoxResult` for Esc / Cancel in the fallback.
6. **A reason with control characters, `\r\n` runs or 2000 characters** is sanitized and capped in the toast copy. The stored reason is unchanged. Test: Task 1.3 `sanitizes and caps reason`.

---

## PR split

| PR | Owns | Safe alone because |
|---|---|---|
| **PR 1: outcome toasts + capability** | **API:** the capability column and plumbing; `pam_request_notify` registration, enqueue and call sites; `supportName` on submit. **Agent:** the tracker, titled notices, the support-name cache, the notify handler, the apply toasts, the offline toast and the capability flag. **Web and mobile:** deny-reason labelling. | Old agents never claim the command; the rows expire at `deliverBy`. A new agent on an old server gets no `supportName` (toasts say IT) and never receives the command. |
| **PR 2: dismiss + local credentials** | The `local_credentials` reason (migration, `PAM_WITHDRAW_REASONS`, web label); the dialog's third button and the MessageBox `YESNOCANCEL`; the `ComposePamDecision` `withdraw_local` action; the Approve-time dismiss and the waiting toast. | Needs #8971 PR A and PR B. If the server lacks the widened CHECK, the withdraw returns 400, #8971's drain acks it as terminal, and the local refusal still protects. |

Both PRs are agent-shipped. They reach endpoints only through a release and a fleet promote, gated on the Windows lab runs in Tasks 1.10 and 2.5. Open both against `main`, because a stacked PR gets no CI.

**Conflicts:**
- #8677 edits `PamRequestsTab.tsx`.
- #8673 edits `routes/pam.ts` (the respond route) and `decideApprovalRequest.ts`. PR 1 touches both of those at the deny call sites, so rebase onto whichever lands first.

---

## PR 1 — Outcome toasts and capability

### Task 1.1: Capability column and plumbing

**Files:**
- Create: `apps/api/migrations/<after-newest>-pam-user-notify-capability.sql`, named under the Global Constraints rule. It runs `ALTER TABLE devices ADD COLUMN IF NOT EXISTS pam_user_notify_protocol_version integer NOT NULL DEFAULT 0;` and mirrors `2026-12-28-130000-pam-reconciliation-reset-capability.sql`.
- Modify:
  - `apps/api/src/db/schema/devices.ts:251`: add the column after `pamReconciliationResetProtocolVersion`.
  - `apps/api/src/services/tenantExportPolicyRegistry.ts:451`: add it to `devices.included`.
  - `apps/api/src/routes/agents/schemas.ts:407`: `pamUserNotifyProtocolVersion: z.number().int().optional().catch(undefined)`.
  - `apps/api/src/routes/agents/heartbeat.ts`: add `export function normalizePamUserNotifyProtocolVersion(v: unknown): 0 | 1`. Write it next to `:1110` (both heartbeat write sites), and pass it into `claimPendingCommandsForDevice` next to `:1925`.
  - `apps/api/src/services/commandDispatch.ts:307-312, 353-367`: add `pamUserNotifyProtocolVersion?: number` to the capabilities. When it is `!== 1`, push `'pam_request_notify'` onto `unsupportedProtocolTypes`. Those rows stay pending and expire at `deliverBy`.
- Tests:
  - `apps/api/src/routes/agents/heartbeat.test.ts`, next to `:3944-3960`.
  - `schemas.test.ts`.
  - `apps/api/src/services/commandDispatch.test.ts`, next to `:326`.
  - `tenantExportPolicyRegistry.pamReconciliation.test.ts`, or a sibling test that pins the column.

`git show 66c29f462 -- apps/api` is the template. `devices/helpers.ts` `PUBLIC_DEVICE_FIELDS` is **not** changed, because the UI doesn't need the field.

- [ ] **Step 1: Write the failing tests.**
  - The normalizer maps `1` to `1`, and maps `0`, `2`, `'1'` and `undefined` to `0`.
  - The heartbeat persists the value.
  - The claim treats `pam_request_notify` as unsupported at `0` and claims it at `1`.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api exec vitest run src/routes/agents/heartbeat.test.ts src/routes/agents/schemas.test.ts src/services/commandDispatch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then run `pnpm db:migrate && pnpm db:check-drift`. Expected: no drift.
- [ ] **Step 4: Re-run** the tests and the export-registry test. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(pam): plumb pamUserNotifyProtocolVersion capability (#8928)`

### Task 1.2: Register `pam_request_notify` everywhere it must be

**Files** (citations are from main @ e3fd76cad):
- `apps/api/src/services/commandTypes.ts`: add `PAM_REQUEST_NOTIFY: 'pam_request_notify'` next to `NOTIFY_USER` (`:171`).
- `apps/api/src/services/partnerTrust.ts`: add it to **`GATED_COMMAND_TYPES`** (`:63-206`), next to `notify_user`. It carries technician free text to the endpoint, so it is operator content, not lifecycle (precedent: `commandTypes.ts:168-171`). See decision T2.
- `apps/api/src/services/commandOfflinePolicy.ts`: classify it as `short` and add it to `EXPLICITLY_CLASSIFIED_COMMAND_TYPES`. The 60-minute `deliverBy` set at insert is the real limit, because `insertQueuedCommandInTransaction` does not consult this policy.
- `apps/api/src/services/commandTimeouts.ts`: add an explicit 2-minute entry. That is enough for a toast, and it avoids the "Unknown command type" warning.
- `apps/api/src/services/sensitiveCommandPayload.ts:173-180`: add a `TYPE_SCOPED_TERMINAL_STRIP_KEYS` entry so the `reason` key is erased at terminal state, the way `notify_user` strips `title` and `body`.
- `agent/internal/remote/tools/types.go:287-289`: add `CmdPamRequestNotify = "pam_request_notify"`.
- **Deliberately not added.** The PR gives each one a sentence:
  - `commandResultHandlers` / `REGISTRY_DISPATCHED_COMMAND_TYPES`: there is nothing to update on the result. Acceptance is by row status (`commandResultAcceptance.ts:54`), and the generic path stores it.
  - `PAM_COMMAND_TYPES`: that list is for PAM v2 actuation types.
  - `TEARDOWN_CLAIM_EXEMPT_TYPES`: this command does not reduce capability.
  - `RESULT_PROCESSING_FAILED_REOPEN_EXCLUDED_COMMAND_TYPES`: PAM v2 actuation only.
  - `COMMAND_MIN_AGENT_VERSION`: the capability does the gating instead.
  - `mcpCoverage.ts`: it is keyed by route file, and there is no new route.
- Tests:
  - `services/partnerTrust.test.ts:615-640`, which parses the Go `Cmd*` constants and the handler registry.
  - `services/commandOfflinePolicy.test.ts:21, 82-93`.
  - `services/aiToolsScripts.commandTypes.test.ts:53`.
  - The `services/sensitiveCommandPayload` tests.
  - **New** `commands.pamRequestNotify.test.ts`, or a case in the existing result-route test. The agent posts a result for a `pam_request_notify` row in `sent`; expect 200, a terminal row and no handler invoked.

- [ ] **Step 1: Add the Go constant only.** Run `pnpm --filter @breeze/api exec vitest run src/services/partnerTrust.test.ts`. Expected: FAIL, because the type is unclassified.
- [ ] **Step 2: Classify it in every list above, and write the result-acceptance test.**
- [ ] **Step 3: Run** the test files listed. Expected: PASS.
- [ ] **Step 4: Commit.** `feat(pam): register pam_request_notify command type (#8928)`

### Task 1.3: `enqueuePamRequestNotify` and its four call sites

**Files:**
- Create: `apps/api/src/services/pamRequestNotify.ts` and `apps/api/src/services/pamRequestNotify.test.ts`.
- Modify each site inside the existing `tx`, after its CAS succeeds:
  1. **Respond deny branch:** `apps/api/src/routes/pam.ts:653-669` (tx at `:580`). Pass `body.reason`.
  2. **Approvals denied branch:** `apps/api/src/services/approvals/decideApprovalRequest.ts:1507-1541` (tx at `:1399`). Pass the decision reason.
  3. **Hash-unverified refusal:** `apps/api/src/services/pamActuationLifecycle.ts:154-170`, in `createPamDecisionIntent`.
     - Pass `'The program could not be verified.'`.
     - Notify only when the caller's prior status was `pending`. That skips the insert-time auto_approved → denied at `elevationRequests.ts:656`, whose user is not tracked as waiting.
  4. **Expiry job:** `apps/api/src/jobs/pamJobs.ts:201` `expireStaleRequests`.
     - Add `e.device_id` to `RETURNING` if it is absent.
     - Enqueue `expired` per row on the same `tx`.
     - Do **not** touch `enforceElevationExpiry`, which ends active elevations, or `pamDeviceMoveGuard` (design choice b).
- Tests: `apps/api/src/routes/pam.test.ts`, `decideApprovalRequest.test.ts`, `pamActuationLifecycle.test.ts` and `apps/api/src/jobs/pamJobs.test.ts`.

**Interfaces:**
```ts
export type PamRequestNotifyOutcome = 'denied' | 'expired';
export const PAM_USER_REASON_MAX = 500;
export const PAM_REQUEST_NOTIFY_DELIVER_MS = 60 * 60 * 1000;
export function sanitizePamUserReason(reason: string | null | undefined): string | undefined;
// strip C0 except \n (\r\n → \n), collapse \n{3,} → \n\n, trim; > 500 runes → first 499 + '…'; '' → undefined
export async function enqueuePamRequestNotify(
  tx: CommandQueueTx,
  req: { id: string; deviceId: string },
  outcome: PamRequestNotifyOutcome,
  reason?: string | null,
): Promise<'queued' | 'unsupported' | 'skipped'>;
```
- **Capability check:** select `pam_user_notify_protocol_version` from `devices` by id. If it is not `1`, return `'unsupported'`.
- **Insert inside a savepoint:** in `tx.transaction(async (sp) => …)`, call `insertQueuedCommandInTransaction(sp, { deviceId, type: CommandTypes.PAM_REQUEST_NOTIFY, payload, createdBy: null, deliverBy: new Date(Date.now() + PAM_REQUEST_NOTIFY_DELIVER_MS), … })`.
- **On any error:** for `ParkedDeviceCommandRefusedError` or anything else, log at Warn and return `'skipped'`. The savepoint matters because a failed SQL statement would otherwise poison the caller's transaction. The deny or expiry must always commit.

- [ ] **Step 1: Write the failing unit tests.**
  - `sanitizes and caps reason`:
    - `'a\u0007b\r\nc'` becomes `'ab\nc'`.
    - `'a\n\n\n\nb'` becomes `'a\n\nb'`.
    - 2000 × `x` becomes 500 runes ending in `…`.
    - `'  '` becomes `undefined`.
    - 600 emoji are cut by runes, not UTF-16 units.
  - Capability `0` returns `'unsupported'` and does no insert.
  - Capability `1` with `denied` produces a payload of exactly `{ requestId, outcome: 'denied', reason }`, with `deliverBy` about 60 minutes out.
  - `expired` produces no `reason` key.
  - `parked device: deny commits, no command`: the insert helper throws `ParkedDeviceCommandRefusedError`, the call returns `'skipped'`, and the outer tx is still usable (the next query succeeds).
- [ ] **Step 2: Run** `pnpm --filter @breeze/api exec vitest run src/services/pamRequestNotify.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Write the call-site tests**, one per site, in the four test files.
  - On deny or expire, `enqueuePamRequestNotify` (mocked) is called once with the right outcome and reason.
  - It is **not** called on approve, when the CAS updated 0 rows, or (site 3) on an insert-time auto-approve.
- [ ] **Step 5: Wire the four sites.** Re-run the four test files and `pamRequestNotify.test.ts`. Expected: PASS.
- [ ] **Step 6: Write the integration test** `apps/api/src/__tests__/integration/pamRequestNotify.integration.test.ts` (real PG, `breeze_app`).
  - A technician's deny on a capable device commits with exactly one `pam_request_notify` row.
  - A deny on a parked device commits with zero rows.
  - The expiry job queues one row per expired request, on capable devices only.
- [ ] **Step 7: Commit.** `feat(pam): notify the requesting user when an elevation is denied or expires (#8928)`

### Task 1.4: `supportName` on the submit response

- **File:** `apps/api/src/routes/agents/elevationRequests.ts`. The submit handler is at `:273` and the response at `:744-748`.
- **Lookup:** after the org-scoped transaction's work and before building the 201 body, compute the support name:
  ```ts
  const supportName = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => resolveMessageBranding(device.orgId)),
  ).then((b) => b?.branding.companyName ?? null)
   .catch((err) => { console.debug(...); return null; });
  ```
  The system scope stops `readWithPartnerAxisVisibility` from opening a second pooled connection while the request's transaction is held.
- **Response:** add `...(supportName ? { supportName } : {})` to the 201 body. The two `200 { status: 'ignored' }` paths are unchanged.
- **Interfaces:**
  - Produces: the 201 body becomes `{ id, status, enforcementStatus?, supportName? }`, where `supportName` is a string of at most 120 characters. Task 1.6 consumes it.
- **Tests** in `elevationRequests.test.ts`:
  - `returns supportName from partner branding`
  - `omits supportName when branding is null`
  - `submit succeeds when branding throws`
  - `branding resolves outside the org transaction`: assert that `runOutsideDbContext` wraps the call.
- [ ] Write the tests and confirm they FAIL. Implement, then confirm they PASS. Commit `feat(pam): return the MSP support name with elevation ingest (#8928)`.

### Task 1.5: Request tracker and titled session notices (agent)

**Files:**
- Create: `agent/internal/heartbeat/pam_user_notify.go` and `pam_user_notify_test.go`.
- Modify `agent/internal/heartbeat/consent_gate.go`:
  - At `:618`, add `func (h *Heartbeat) sendSessionNotifyTitled(title, body, targetWinSession string)`. `sendSessionNotify(body, tws)` becomes a one-line call to it with `"Breeze Agent"`.
  - At `:823`, `sessionNoticeRequest` takes a `title`.
- Modify `agent/internal/heartbeat/heartbeat.go`. Add two fields:
  - `pamRequests *pamRequestTracker`, created lazily via `h.pamTracker()`.
  - `pamNotifySink func(title, body, tws string)`, a test seam. When nil, `sendSessionNotifyTitled` is used.

**Interfaces:**
```go
const pamTrackedRequestTTL = 60 * time.Minute
type pamTrackedRequest struct { WinSession, Program, SupportName string; Notified bool; expires time.Time }
func newPamRequestTracker(now func() time.Time) *pamRequestTracker
func (t *pamRequestTracker) MarkAwaiting(requestID, winSession, program, supportName string)
func (t *pamRequestTracker) Get(requestID string) (pamTrackedRequest, bool)         // expired → absent
func (t *pamRequestTracker) ClaimNotify(requestID string) (pamTrackedRequest, bool) // true once, then Notified=true
func (t *pamRequestTracker) Remove(requestID string)
func pamProgramName(path string) string // base name across / and \, ≤260 runes, "" → "the program"
func pamSupportName(s string) string    // trim, ≤120 runes, "" → "IT"
func pamCopyWaiting(p, s string) (title, body string) // + Approved, LaunchFailed, Denied(p,s,reason), Expired, Offline
func (h *Heartbeat) notifyPamUser(title, body, winSession string)
```
Entries are keyed by the server request ID, never by the program. So a second request for the same program inside the 30-second ETW dedupe window is a separate entry. The tracker is a mutex-guarded map, pruned on every write.

- [ ] **Step 1: Write the failing tests.**
  - `TestTrackerKeysByRequestID`.
  - `TestTrackerExpires`, with a fake clock.
  - `TestClaimNotifyOnce`.
  - `TestPamCopy`: exact strings for all six notices, with `s = "Contoso IT"` and with `s = ""` (which renders `IT`). Cover the denied text both with and without a reason.
  - `TestPamProgramName`.
  - `TestSessionNoticeRequestTitle`: update the existing test at `consent_gate_test.go:190`.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/heartbeat/ -run 'TestTracker|TestClaimNotify|TestPamCopy|TestPamProgramName|TestSessionNoticeRequest'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(agent/pam): track requests handed to IT and add titled session notices (#8928)`

### Task 1.6: Support name — parse, cache, persist (agent)

**Files:**
- Modify `agent/internal/etwlua/etwlua.go:156`: `ElevationOutcome` gains `SupportName string`.
- Modify `agent/internal/heartbeat/handlers_elevation.go:29-72`: `SendElevationRequest` parses the optional `supportName`. On a successful submit with a non-empty value, it calls `h.rememberSupportName`.
- Create `agent/internal/heartbeat/pam_support_name.go` and its test:
  - **In memory:** the value is held behind a mutex.
  - **On disk:** `rememberSupportName` persists it only when it changes, to `filepath.Join(filepath.Dir(h.statePath), "pam-support-name.json")`. The write is 0600, a temp file then `atomicrename.Replace`, following `reliability_state.go`.
  - **On load:** read it in `SetStatePath` (`heartbeat.go:1644`). A corrupt or missing file counts as empty and is logged at Warn.
- `lastSupportName()` returns the cached value or `""`. The copy helpers apply the `IT` fallback.

**Interfaces:**
- Consumes: Task 1.4's optional `supportName` in the response, and Task 1.5's `pamSupportName`.
- Produces:
  ```go
  // etwlua.ElevationOutcome.SupportName string  — used by Tasks 1.7, 2.3
  func (h *Heartbeat) rememberSupportName(s string) // no-op on ""; persists on change
  func (h *Heartbeat) lastSupportName() string      // used by Task 1.8
  const pamSupportNameFile = "pam-support-name.json"
  ```

- [ ] **Step 1: Write the failing tests.**
  - `TestSendElevationRequestParsesSupportName`: when present, it is set on the outcome and in the cache; when absent, the cache is unchanged.
  - `TestRememberSupportNameIgnoresEmpty`.
  - `TestSupportNameSurvivesReload`: write, build a new Heartbeat on the same state path, then call `lastSupportName()`.
  - `TestSupportNameCorruptFileIsEmpty`.
  - `TestSupportNameTruncatedTo120`.
  - The file mode is 0600 on POSIX.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(agent/pam): cache the MSP support name across restarts (#8928)`

### Task 1.7: Track on Approve; apply toasts; `pam_request_notify` handler; capability flag (agent)

**Files:**
- Modify `agent/internal/heartbeat/pam_flow.go:160-161`:
  - In the `PamActionAwaitRemote` branch, call `pamTracker().MarkAwaiting(id, tws, pamProgramName(ev.TargetExecutablePath), outcome.SupportName)`.
  - Fix the stale log text: the server issues `pam_apply_v2`, not `actuate_elevation`.
  - No dismiss and no toast yet; both come in PR 2.
- Modify `agent/internal/heartbeat/handlers_actuate.go:67-103`. After `ApplyWithReceivedObservation` (`:97`):
  - `result.State == pamlifetime.ResultVerifiedActive` and `ClaimNotify` returns ok → show `pamCopyApproved`.
  - `ResultFailed`, `ClaimNotify` returns ok, and the failure code is not one of #8971's user-decision codes (`user_declined`, `user_decision_pending`, `user_decline_record_untrusted`) → show `pamCopyLaunchFailed`. If #8971 hasn't landed yet, compare against string literals with a `// #8971` note, or rebase.
  - Any other state → no toast.
- Create `agent/internal/heartbeat/handlers_pam_notify.go`, with `handlerRegistry[tools.CmdPamRequestNotify] = handlePamRequestNotify` in `init()`:
  - **Refuse** with `NewErrorResult` when `requestId` is not a canonical UUID, `outcome ∉ {denied, expired}`, or `reason` is over 500 runes.
  - **Untracked request:** return `NewSuccessResult` with no toast.
  - **Tracked request:** show the denied or expired toast to `entry.WinSession`, using `entry.Program` and `entry.SupportName`. Then call `Remove(requestId)` and return success.
- Modify `agent/internal/heartbeat/heartbeat.go:266`:
  - `SecurityCapabilities` gains ``PamUserNotifyProtocolVersion int `json:"pamUserNotifyProtocolVersion,omitempty"` ``.
  - `compiledSecurityCapabilities` (`:8612`) sets it to `1` when `runtime.GOOS == "windows"`.
- Tests: `pam_flow_test.go`, `handlers_actuate_test.go` (reuse the fake manager near `:219`), `handlers_pam_notify_test.go` and `consent_prompt_capability_test.go`.

- [ ] **Step 1: Write the failing tests.**
  - `TestRunPamFlow`:
    - `pending + Approve` → tracked.
    - `auto_approved + Approve` → not tracked.
    - `pending + Deny` → not tracked.
  - `TestPamApplyV2ApprovedToastOnce`: two applies that both reach `verified_active` produce one sink call, titled `Request approved`.
  - `TestPamApplyV2LaunchFailedToast`, `TestPamApplyV2UserDeclinedNoToast`, `TestPamApplyV2UntrackedNoToast`.
  - `TestPamRequestNotify` cases: `DeniedWithReason`, `DeniedNoReason`, `Expired`, `UntrackedNoToast`, `RejectsOversizedReason`, `RejectsUnknownOutcome`, `RejectsNonUUID`.
  - `TestHeartbeatDeclaresPamUserNotifyCapability`.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/heartbeat/ -run 'TestRunPamFlow|TestPamApplyV2|TestPamRequestNotify|TestHeartbeatDeclaresPamUserNotify'`. Expected: FAIL for the new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run, plus two more suites.** Run `TestPamLifetimeV2CanonicalDispatchFixture`, and `pnpm --filter @breeze/api exec vitest run src/services/partnerTrust.test.ts`, because the Go registry now references the type. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(agent/pam): show approved/denied/expired notices for requests handed to IT (#8928)`

### Task 1.8: Offline toast (agent)

**Files:**
- Modify `agent/internal/etwlua/etwlua.go:199`:
  - Add `NotifyElevationSubmitFailed(ev Event)` to `PamRunner`.
  - Call it only on the **live** submit-error branch in `handleEvent` (`:319-331`). Never call it from `Queue.Drain` (`queue.go:101-121`).
- Modify `agent/internal/heartbeat/pam_flow.go` to implement `NotifyElevationSubmitFailed`:
  - Use a lazy `pamOfflineLimiter`, keyed as in Global Constraints.
  - Target `strconv.FormatUint(uint64(ev.SubjectSessionID), 10)`. Skip the toast when that is 0 or `0xFFFFFFFF`.
  - Show `pamCopyOffline(pamProgramName(path), h.lastSupportName())`.
- Update every `PamRunner` fake in `agent/internal/etwlua/*_test.go`.

- [ ] **Step 1: Write the failing tests.**
  - etwlua: a live submit error calls it once; a successful submit doesn't; a drained event doesn't.
  - heartbeat: `TestOfflineToastRateLimited`, `TestOfflineToastUnknownSessionSkipped`, and `TestOfflineToastUsesPersistedSupportName` (load the sidecar, then trigger).
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/etwlua/ ./internal/heartbeat/ -run 'Offline|SubmitFailed'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run, then run the wider suites.** Run `go test -race ./internal/etwlua/ ./internal/heartbeat/` and `GOOS=windows go build ./...`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(agent/pam): tell the user when an elevation request can't reach IT (#8928)`

### Task 1.9: Deny-reason fields say "shown to the user" (web + mobile)

**Files:**
- `apps/web/src/components/pam/PamRespondModal.tsx:494-512`. When `decision === 'deny'`:
  - Label key `pamPamRespondModal.form.reasonShownToUser`, default `'Reason (shown to the user)'`.
  - Hint key `…reasonShownToUserHint`, default `'The end user sees this in their notification (first 500 characters).'`, linked by `aria-describedby`.
  - Approve keeps `reasonOptional`. `maxLength={2000}` stays, because it is the stored audit reason.
- `apps/web/src/components/approvals/ApprovalsInbox.tsx:1178-1188` (per-card deny): add the same hint when the card has an `elevationRequestId`. Group deny (`:1601-1608`) is unchanged; it is never PAM (`batchDecide.ts:158-175`).
- `apps/mobile/src/screens/approvals/components/DenyReasonSheet.tsx`:
  - Add `maxLength={500}` unconditionally, to match the server cap.
  - Add a `showsToEndUser` prop that renders the hint. `ApprovalButtons.tsx:235` passes it for `uac_intercept` approvals (`approvalFlow.ts:8,26`).
  - This ships with the next mobile release; the PR says so.
- Locale keys go in all 8 web locale files (`apps/web/src/locales/*/security.json`), translated. Mobile copy follows the mobile app's existing string pattern.
- Tests:
  - `PamRespondModal.test.tsx`: deny shows the label and hint; approve doesn't.
  - The `ApprovalsInbox` test: a PAM card versus a non-PAM card.
  - The mobile `DenyReasonSheet` test, if the app has component tests. Otherwise, note a snapshot or prop test in the PR.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** `pnpm --filter @breeze/web exec vitest run src/components/pam/PamRespondModal.test.tsx src/components/approvals`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the wider web tests and the mobile tests.** Web: `src/components/pam/`, `src/lib/i18n/localeParity.test.ts` and `src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(web,mobile/pam): tell technicians the deny reason is shown to the user (#8928)`

### Task 1.10: PR 1 verification

- [ ] **Unit suites.** Run `pnpm --filter @breeze/api test`, `pnpm --filter @breeze/web test`, and `cd agent && go test -race ./...` plus `GOOS=windows go build ./...`.
- [ ] **Integration suites,** locally on a per-worktree test stack per `docs/agents/testing.md`: tenant-export (for the new devices column), the new `pamRequestNotify.integration.test.ts`, and command-dispatch.
- [ ] **Windows lab run** with a dev-pushed agent, a standard user, and a policy that requires approval. Record each result in the PR:
  1. Approve, then the technician approves → `Request approved`, and the app runs.
  2. Approve, then the technician denies with a reason that has line breaks → `Request denied`, with the reason.
  3. Approve, then wait 15 minutes or more → `Request expired`.
  4. Restart the agent between Approve and the technician's deny → no toast, and the command succeeds.
  5. Disconnect the network and trigger UAC → `Couldn't reach <partner name>`, using the name persisted earlier. A second attempt within 5 minutes shows no toast.
  6. Approve on an agent built without the capability → the deny commits, and the `pam_request_notify` row expires unclaimed.
- [ ] **PR body.** Include:
  - Design choices (a)–(c).
  - "No setting added" (CLAUDE.md Rule 9).
  - The registry list from Task 1.2, including the deliberate omissions.
  - The Claude Code attribution line.

---

## PR 2 — Approve-time dismiss and "Use admin credentials"

**Precondition:** #8971 PR A and PR B are merged. Rebase onto them, and re-verify these names before starting: `pamdecline.Store`, `Decline`, `Consent`, `PAM_WITHDRAW_REASONS`, `kickPamWithdrawDrain`.

### Task 2.1: `local_credentials` withdraw reason (API + web)

**Files:**
- Create: `apps/api/migrations/<after-newest>-pam-withdraw-reason-local-credentials.sql`. It runs `DROP CONSTRAINT IF EXISTS`, then re-adds `elevation_requests_withdrawn_reason_chk` with `('user_denied','user_timeout','dialog_error','local_credentials')`. It is idempotent and writes no rows.
- Modify: `apps/api/src/db/schema/elevations.ts`. Add `'local_credentials'` to `PAM_WITHDRAW_REASONS`. The route's zod `z.enum(PAM_WITHDRAW_REASONS)` then accepts it with no route change.
- Modify the web label:
  - Edit `apps/web/src/components/pam/types.ts` / `ui.tsx` wherever #8971 C1 maps `withdrawnReason`.
  - Add the key `pamWithdrawReason.local_credentials` = "User chose to enter admin credentials" to all 8 locale files.
- Tests:
  - #8971's `pamElevationWithdrawnSchema.integration.test.ts`: add a `local_credentials accepted` case.
  - The withdraw route unit test: `reason: 'local_credentials'` → 200.
  - The web reason-line test.

- [ ] Write the failing tests. Add the migration and the schema and web changes. Run `pnpm db:check-drift`, the integration test and the web tests. Expected: PASS. Commit `feat(pam): accept local_credentials as a withdraw reason (#8928)`.

### Task 2.2: Third button and three-choice MessageBox (agent userhelper)

**Files:**
- `agent/internal/ipc/message.go`:
  - `PamRequestDialog` (`:366`) gains `AllowLocalCredentials bool` and `SupportName string`.
  - `PamDialogResult` (`:378`) gains `LocalCredentials bool`.
  - All three fields are `omitempty`.
- `agent/internal/userhelper/pam_dialog_content.go`:
  - `pamLocalCredsLabel = "Use &admin credentials"`.
  - `func pamDialogShowsLocalCreds(req) bool`.
  - `func pamMessageBoxLegend(req) string` returns `"\n\nYes — send the request to {s}\nNo — deny\nCancel — enter administrator credentials in the Windows prompt instead"`, with `{s}` from `pamSupportName`.
  - `func pamMessageBoxResult(ret uintptr, allowLocal bool) ipc.PamDialogResult`.
- `agent/internal/userhelper/pam_dialog_window_windows.go`:
  - Add `pamIDLocalCreds = 102` (`:91-93`) and `hwndLocalCreds`.
  - In `pamCreateButtons` (`:449-486`), when the flag is set, add the button left-aligned at `x = margin`, width `scale(168)`, on the same `y`.
  - In `WM_COMMAND` (`:495-502`), 102 sets `{LocalCredentials: true}`, then calls `DestroyWindow`.
  - Deny stays the default button and keeps the initial focus. The countdown expiry is unchanged (`{Approved:false, DismissedByUser:false}`).
- `agent/internal/userhelper/pam_dialog_windows.go:58-67`:
  - With the flag, use `MB_YESNOCANCEL|…` (the same other flags) and append the legend.
  - Mapping: `IDYES` → Approved, `IDNO` → `{DismissedByUser:true}`, `IDCANCEL` → `{LocalCredentials:true}`.
  - Without the flag, behaviour is byte-for-byte unchanged.
- **Interfaces:**
  - Produces, for Task 2.3:
    - `ipc.PamRequestDialog.AllowLocalCredentials` (bool) and `ipc.PamRequestDialog.SupportName` (string).
    - `ipc.PamDialogResult.LocalCredentials` (bool). It is set only by button 102 or by `IDCANCEL` in the fallback, and only when `AllowLocalCredentials` was true.
- Tests, in `pam_dialog_content_test.go`:
  - `TestPamDialogShowsLocalCreds`.
  - `TestPamMessageBoxLegend`: the exact text, with a support name and with an empty one.
  - `TestPamMessageBoxResult`: a table over `IDYES`, `IDNO` and `IDCANCEL`, with the flag and without it. Without the flag, `IDCANCEL` → deny.
- [ ] Write the failing tests, then implement. Run `cd agent && go test -race ./internal/userhelper/ ./internal/ipc/` and `GOOS=windows go vet ./internal/userhelper/`. Expected: PASS, with vet clean. Commit `feat(agent/pam): add "Use admin credentials" to the elevation dialog and its fallback (#8928)`.

### Task 2.3: Decision mapping, Approve-time dismiss, waiting toast (agent heartbeat)

**Interfaces:**
- Consumes:
  - Task 2.2's IPC fields.
  - Task 1.5's `pamTracker().MarkAwaiting`, `notifyPamUser` and `pamCopyWaiting`.
  - Task 1.6's `outcome.SupportName`.
  - From #8971: `h.pamDeclines` (`*pamdecline.Store`), with `Decline(id, Reason) error` and `Consent(id) error`, and `h.kickPamWithdrawDrain()`.
- Produces:
  - `sessionbroker.PamActionWithdrawLocal`.
  - `pamdecline.ReasonLocalCredentials`.
  - `func (h *Heartbeat) dismissConsentForRemote(session *sessionbroker.Session, requestID, targetWinSession string)`.

**Files:**
- `agent/internal/sessionbroker/pam_decision.go`:
  - Add `PamActionWithdrawLocal PamAction = "withdraw_local"`.
  - Add a **first** rule in `ComposePamDecision`, ahead of the existing `!dialog.Approved || DismissedByUser → Deny`: `policyVerdict == require-approval && dialog.LocalCredentials` → `WithdrawLocal`.
  - `LocalCredentials` under any other verdict → Deny.
- `agent/internal/pamdecline`: add `ReasonLocalCredentials Reason = "local_credentials"`. `Due()` already includes declined `pending` entries, so the drain delivers it with no change.
- `agent/internal/heartbeat/pam_flow.go`:
  - `buildPamRequestDialog(ev, outcome)` sets `AllowLocalCredentials: outcome.Status == etwlua.ElevationPending` and `SupportName: outcome.SupportName`. It has one caller, at `:118`.
  - **`PamActionWithdrawLocal`:** call `h.pamDeclines.Decline(id, pamdecline.ReasonLocalCredentials)`, then `h.kickPamWithdrawDrain()`. There is **no** `denyConsent` and no toast. Log "user chose local admin credentials; UAC left open".
  - **`PamActionAwaitRemote` (pending):** after #8971's `Consent(id)`:
    1. If `h.pamLifetimeProtocolVersion() == 2`, call `h.dismissConsentForRemote(session, id, tws)`.
    2. Call `MarkAwaiting` (already done in PR 1).
    3. Call `notifyPamUser(pamCopyWaiting(p, outcome.SupportName))`.

    If the dismiss is skipped or fails, steps 2 and 3 still run.
- Create `agent/internal/heartbeat/pam_dismiss_remote.go` with `dismissConsentForRemote`:
  - It takes `pamActuateMu`. If `pamDismissalUncertain` is set, it logs at Info and returns without dismissing.
  - Otherwise it calls the same dismiss seam `denyConsent` uses (`h.pamDismissConsent` / `sessionBroker.DismissPamConsent`), with `pamDismissTimeout` and the request ID suffixed `-remote`.
  - A `*PamDismissUncertainError` is a Warn: "remote-approval dismiss unproven; fail-closed gate NOT engaged (pam_apply_v2 does not use the prompt)". It sets **no** gate flag and starts **no** `awaitPamDismissalQuiescence` or recovery.
  - Success and `no_consent_window` log at Info; anything else at Warn.
  - `denyConsent` itself is unchanged.
- Tests:
  - `sessionbroker/pam_decision_test.go`, new `TestComposePamDecision` rows:
    - require-approval + `LocalCredentials` → `withdraw_local`, even when `Approved` is false.
    - end-user-allowed + `LocalCredentials` → `deny`.
  - `heartbeat/pam_flow_test.go`, new `TestRunPamFlow` rows:
    - pending + Approve, v2 = 2, `SupportName "Contoso IT"` → dismissed once with an ID ending `-remote`, `Request sent to Contoso IT`, tracked, no decline.
    - pending + Approve, v2 = 0 → **not** dismissed, but still toasted and tracked.
    - pending + Approve, and the dismiss returns an error → still toasted and tracked.
    - pending + LocalCredentials → **not** dismissed, no toast, `Decline` called once with `local_credentials`, drain kicked. The apply refusal that follows is #8971 B3's; it is not repeated here.
    - auto_approved + Approve → no dismiss from this path, no toast.
  - `heartbeat/pam_dismiss_remote_test.go`:
    - `TestDismissForRemoteUncertainLeavesGateClear`: the fake returns `PamDismissUncertainError`. Then `pamDismissalUncertain == false`, and the recovery seam is never called.
    - `TestDismissForRemoteSkippedWhileGateEngaged`: with the gate preset, the dismiss fake is never called.
    - `TestDismissForRemoteSerialisesWithActuate`: the test holds `pamActuateMu`, and the dismiss blocks until it is released.
- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/sessionbroker/ ./internal/heartbeat/ ./internal/pamdecline/ -run 'TestComposePamDecision|TestRunPamFlow|TestDismissForRemote'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run, then run the wider suites:**
  - `TestActuateAndDenyMutuallyExclusive` and `TestDenyConsentTimeoutKeepsGateUntilHelperQuiescent`.
  - The full #8971 suites: `go test -race ./internal/heartbeat/... ./internal/pamlifetime/... ./internal/pamdecline/...`.
  - `GOOS=windows go build ./...`.

  Expected: PASS.
- [ ] **Step 5: Commit.** `feat(agent/pam): close UAC and tell the user when a request goes to IT; local-credentials choice (#8928)`

### Task 2.4: PR 2 verification

- [ ] Run the API, web and agent suites as in Task 1.10, plus the integration test from Task 2.1.

### Task 2.5: Windows lab gate (before fleet promote)

Record each result in the PR. These cases cover only this plan's behaviour. The withdraw race, restart and corruption cases are #8971's B5 lab gate.
1. **Approve on a v2-capable agent.** UAC closes, and `Request sent to <partner name>` appears. Then the technician approves: `Request approved` appears, and the app runs once.
2. **Approve on an agent where `pamLifetimeProtocolVersion` is 0** (simulate one non-v2 condition). UAC stays up, and the waiting toast still appears.
3. **"Use admin credentials".** UAC stays up, and local admin credentials work. The PAM tab shows **Withdrawn · User chose to enter admin credentials**.
4. **Force the MessageBox fallback,** with a test build flag or by breaking window-class registration in a debug build. The box shows three buttons and the legend. Cancel behaves like case 3, and so does Esc.
5. **While the fail-closed gate is engaged** (induce an unproven deny first), Approve a new pending request. No dismiss attempt is logged, and the waiting toast still appears.

---

## Decisions (approved by the requester in brainstorming, 2026-10-20)

This plan implements each **Default** below. The requester chose the default every time. The maintainer may still override any of them in review.

CLAUDE.md's advisor quorum (`codex exec` at `xhigh`) could not run, because the Codex CLI wasn't available in the authoring environment. These are the calls a second opinion would have checked.

- **T0: Document shape.** One plan covers both PRs. PR 2 is written against #8971's merged plan, and its precondition step re-verifies the names against #8971's code once that code lands. The alternative was planning PR 1 only, which was rejected.

- **T1: Approve-time dismiss whose proof is uncertain.**
  - **Default:** a Warn log only, with no gate. This is safe because neither `pam_apply_v2` nor #8971's apply refusal uses the prompt. The helper's own deadline bounds a late Escape.
  - **Alternative:** skip the dismiss unless it is proven, so UAC is never closed. That is a worse experience for no safety gain.
- **T2: Partner-trust class for `pam_request_notify`.**
  - **Default:** GATED, like `notify_user`, because it carries technician free text. If partner trust denies the claim, the user gets no deny toast.
  - **Alternative:** LIFECYCLE. The toast always arrives, but technician text bypasses the trust check.
- **T3: Mapping `IDCANCEL` and Esc to "use admin credentials" in the fallback.**
  - **Default:** yes. Its failure mode is that UAC stays up and remote launch is refused.
  - **Alternative:** no third choice in the fallback, with a legend telling the user to press No and retry. That is simpler, but No dismisses UAC, which defeats the purpose.
- **T4: Toast delivery window.**
  - **Default:** 60 minutes, equal to the tracker TTL.
  - **Alternative:** 15 minutes (`live_only`), which tracks the pending TTL more tightly.
