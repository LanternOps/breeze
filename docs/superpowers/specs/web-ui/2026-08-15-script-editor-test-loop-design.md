# Script Editor Test Loop — Design

**Date:** 2026-08-15
**Status:** Draft v2 — post advisor quorum (Codex xhigh reviewed; both contentious decisions revised). Pending user review.
**Related fix (shipped alongside, commit `fe1211974`):** script-level executions page never showed stdout/stderr — `GET /scripts/:id/executions` omits the output columns and the page handed the stripped list row to the details modal. Fixed by fetching `GET /scripts/executions/:id` on open and adding `scriptName` to the list response.

## Problem

Iterating on a script today means: edit in `/scripts/:id` → navigate to the scripts list or a device page → run via `ScriptExecutionModal` → navigate to executions/device history → open the result → go back to the editor. The AI sidecar (`script_builder` session) can edit the buffer (`apply_script_code`) and can run *saved* scripts (`execute_script_on_device`, tier 3), but it does not know which script it is editing, cannot run unsaved edits, and every run hits an approval modal — so "AI tests and iterates" doesn't actually work end-to-end.

## What already exists (leverage, don't rebuild)

- `execute_script_on_device` (script-builder MCP, `scriptBuilderTools.ts:289`) → proxies the main `run_script` handler (`aiToolsScripts.ts:170`), which blocks up to 60s via `waitForCommandResult` and returns stdout/stderr/exitCode inline. The synchronous result loop the feature needs is already built.
- Editor AI sidecar with SSE streaming, approval events, and a form bridge (`ScriptAiPanel`, `scriptAiStore`, `ScriptFormBridge`). Sessions are rows in `ai_sessions` with `type='script_builder'`.
- Each user message ships the current `editorSnapshot` to the server, and the `apply_script_code` handler knows the content it instructed the client to apply — so the server can maintain an authoritative draft without new sync machinery.
- `dispatchScriptToDevice` (`scriptDispatch.ts:87`) takes resolved content and records a `script_executions` row; results flow back via agent WS → `handleScriptResult` (`commandResultHandlers.ts:320`).
- Tier-3 tool calls flow through the durable action-intent approval path (`aiAgentSdk.ts:879`, `aiAgent.ts` `handleApproval` with session-owner enforcement). Any grant mechanism must integrate here, not bolt a checkbox onto the client dialog.

## Phasing (quorum-driven)

**v1 — human-runs, AI-reads (ships the core ask with minimal new attack surface):**
editor test-device picker, Save & Test Run button + results strip, `scriptId`/`targetDeviceId` in the AI context, `get_script_execution` tier-1 tool. The user runs from the editor; the AI immediately reads the result and iterates on the code. AI-initiated runs still work today via `execute_script_on_device` with per-run approval.

**v2 — AI-runs with scoped auto-approval:**
`test_script` (server-draft execution) + session tool grants. Needs the server-side draft, execution-content audit, and the grant table below.

## Design

### A. Pinned test device (editor state + AI context) — v1

- **"Test device"** picker in `ScriptForm`'s toolbar (compact combobox; devices filtered to the script's `osTypes`, online first). Persist per-script in `localStorage` (`breeze:script-test-device:<scriptId>`). No schema change.
- Extend `ScriptFormBridge` with `getTestDeviceId()`; send the already-declared-but-never-populated `ScriptBuilderContext.scriptId` plus new `targetDeviceId` on session create and each message; feed both into `buildScriptBuilderSystemPrompt`.
- Plumbing note (quorum): `ScriptForm` has no `scriptId` prop today — `ScriptEditPage` owns the id and must pass it down.

### B. Run from the editor (human path) — v1

- **"Save & Test Run" button** in the editor header, enabled when a test device is pinned: save (create draft on first save), then `POST /scripts/:id/execute` with `deviceIds: [testDeviceId]`, `triggerType: 'manual'`. Inherits the route's `requireMfa()`.
- Refactor required (quorum): the current save handler navigates back to `/scripts` and discards the created id (`ScriptEditPage.tsx:90`). Save must become save-in-place returning the script id, with navigation only on explicit "Save & Close".
- **Results strip** at the bottom of the editor (collapsible): status chip while pending/running, then exit code + stdout/stderr via the existing `OutputSection`. Poll `GET /scripts/executions/:id` every 2s until terminal status (cap at the script's `timeoutSeconds`, ceiling 1h). No websocket work.
- After a run completes, the result lands in the AI context two ways: the system prompt names the latest execution id, and the model can call `get_script_execution` — so "user runs, AI fixes" needs no further plumbing.

### C. `get_script_execution` (tier 1, both tool surfaces) — v1

New read-only tool: `{ executionId: uuid }` → status, exitCode, stdout, stderr, errorMessage, timing; same access checks as `GET /scripts/executions/:id`. Register in `aiToolsScripts.ts` (tier 1) and the script-builder allowlist.

> **Correction (2026-08-16, PR #3605).** This section originally claimed the tool
> "closes the *run outlived the 60s tool window and there is no recovery* gap".
> **It does not, and cannot as built.** When `run_script`'s 60s wait expires, the
> command row is terminalized and the agent's late result is then dropped before
> `handleScriptResult` ever runs — so `stdout`/`stderr`/`exitCode` are never
> written to `script_executions` and there is nothing for this tool to read back.
> #3605 rewrote the four AI-facing descriptions that acted on the false premise.
> The tool's real use is reading a run started *outside* the current tool call
> (the editor's Test Run button, or an id from `get_script_execution_history`).
> The underlying loss is tracked in #3607.

### D. `test_script` — AI-initiated run of the working draft — v2

Replaces `execute_script_on_device` in the script-builder allowlist (the global-agent `run_script` is untouched).

- Input: `{ deviceId?: uuid, parameters?, runAs? }` — defaults to the session's pinned test device; structured error if none.
- **Content source: a server-side session draft, not the message-carried snapshot.** Quorum finding: `apply_script_code` mutates the client form, and the server only receives the new buffer on the *next* user message — "run the latest snapshot" would execute stale code within the same turn. Instead the server keeps an authoritative draft per session (revision counter + content), updated by (a) the `editorSnapshot` on each incoming message and (b) every `apply_script_code` call at the moment the server emits it. `test_script` resolves exactly one revision at invocation and dispatches that content.
- **Audit:** the resolved content's SHA-256, revision, effective `runAs`, and canonical parameters are stamped into the `ai_tool_executions` record for the call (which already stores tool input), alongside `executionId`. Full content is recoverable from the chat transcript + revision; we do not add a content column to `script_executions` (avoids a new export-policy classification for v1-adjacent work). If ops experience shows hash+transcript is insufficient for reproduction, add an encrypted snapshot store as a follow-up.
- Requires the script to have been saved at least once (`script_executions.script_id` is NOT NULL). New scripts: the v1 Save & Test Run flow creates the draft.
- Executes through the same guarded pipeline as `run_script`: `verifyDeviceAccess`, script↔device org/partner equality, dispatch, redaction. Wire via `makeExistingHandler` so `onPreToolUse` runs (never `makeApplyHandler`).
- **Timeout handling (corrected per quorum; mechanism re-corrected 2026-08-16):** `waitForCommandResult` *terminalizes* the command at its deadline (marks it failed/timeout), after which the late agent result is dropped. The original text attributed the drop to a lost CAS in `agentWs.ts`; verification in #3605 found it happens one step earlier — the row **lookup** filters on `status IN ('pending','sent')` (`agentWs.ts:87`, `:1598-1610`), so no row is found at all and the code branches into `processOrphanedCommandResult` before the CAS at `:1739` is ever reached. This matters for anyone fixing it: patching only the CAS would not work. `test_script` must still use a non-mutating poll capped at ~50s (inside the 60s MCP tool timeout) and, if still running, return `{ status: 'running', executionId }` without touching the command row. Note it can only direct the model to `get_script_execution` once #3607 makes the late result actually land.
- **Default resolution before approval:** the guardrail/approval hook currently sees raw tool arguments; `test_script` must resolve the effective device, `runAs`, and parameters *before* the approval/grant check so the user approves (and the grant matches) what actually executes.

### E. Approval model — scoped session tool grants — v2

`test_script` stays tier 3, flowing through the existing action-intent approval path. To remove per-iteration friction, the approval UI offers **"Auto-approve test runs like this for the rest of this session"**, which creates a server-side grant. Quorum pushback accepted: device-only matching over-scopes an RCE capability, and mutable session JSON (`contextSnapshot` is client-derived and replaced every message) is the wrong storage.

- **New table `ai_session_tool_grants`** (RLS shape 1, direct `org_id`; register in `CORE_ORG_CASCADE_DELETE_ORDER` + `CORE_TENANT_EXPORT_POLICY` in the same PR): `id, org_id, session_id, granted_by_user_id, tool ('test_script'), script_id, device_id, allowed_run_as, timeout_ceiling_secs, granting_execution_id, created_at, expires_at, revoked_at, last_used_at`.
- **Match key on use:** session + owner (caller must equal `granted_by_user_id` — note `getScriptBuilderSession` is org-scoped, not user-scoped, so this check is explicit) + tool + `script_id` + `device_id` + effective `runAs` ⊆ `allowed_run_as` + not expired/revoked. Content is *intended* to vary (that's the feature) and the consent copy says so explicitly: "any code currently in this editor session". Anything outside the key → normal tier-3 approval.
- Auto-approved calls are logged tier-2-style (`auto_approved_by_grant: <grantId>`) with the content hash from §D. Grants default-expire after 4h or session end; revocation sets `revoked_at` (rows retained for audit, never deleted outside org erasure). Revocable via a chip in the panel header.
- Grant creation happens server-side inside the approval decision handler (which already enforces session ownership), never from a bare session lookup.
- MFA note (corrected per quorum): the script-builder routes — session create, messages, approve — already `requireMfa()`, so there is no human-vs-AI MFA asymmetry on this surface. Grant lifetime (4h) deliberately sits inside typical MFA freshness.

### F. Explicitly out of scope

Websocket/live-tail of output; multi-device test matrices; encrypted per-execution content store (follow-up trigger in §D); `approvalMode` for the global agent sidebar; running never-saved scripts; agent-side changes (none needed).

## Quorum record (2026-08-15, Codex gpt-5.6-sol xhigh, read-only)

Codex DISAGREED with both v1-draft decisions; verdicts accepted in part:

1. *Run-what-you-see from message-carried snapshot* — *accepted*: the same-turn staleness race is real; moved to a server-side revisioned draft with per-run content hash in the audit record. *Rejected as v2-overkill*: full encrypted immutable artifact store with client revision acknowledgement (hash + transcript + revision covers audit; artifact store is the named follow-up).
2. *Device-only session grant in session JSON* — *accepted*: dedicated RLS'd grant table, grant key widened to owner + script + device + runAs + expiry, integration with the action-intent approval path, retention over deletion. *Rejected*: binding the grant to a language/OS "profile" (the script row already fixes language, and osType is implied by the pinned device).

Codex also surfaced three factual corrections folded in above: `waitForCommandResult` terminalizes on timeout (no naive "return running"); scriptAi routes already require MFA; the editor save path navigates away and must be refactored for save-in-place.

## Implementation order

**v1:** (1) `get_script_execution` tool + allowlists; (2) save-in-place refactor in `ScriptEditPage`/`ScriptForm`; (3) test-device picker + bridge/context/system-prompt plumbing; (4) Save & Test Run + results strip. Tests: tool-handler unit (access checks), web tests for picker/save-in-place/results polling.

**v2:** (5) server-side session draft revisions; (6) `test_script` (non-mutating wait + pre-approval default resolution); (7) `ai_session_tool_grants` migration + RLS + cascade/export registration + grant path in the approval handler; (8) approval-UI checkbox + revocation chip. Tests: draft-revision race (apply→run same turn), grant match/mismatch matrix (device, runAs, expiry, non-owner), integration test proving a granted session auto-executes on the granted device and still blocks on any other device, RLS forge test for the grants table.
