# Action Intents MCP Cutover (Plan 2 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the external MCP Tier-3 bypass: API-key callers can request T3 work (durable intent) but never auto-execute it; add `get_action_status` / `cancel_action`; delete the auto-execute path.

**Architecture:** `routes/mcpServer.ts`'s T3 branch is rewired from direct `runTier3ToolLifecycle` execution to `createActionIntent(source: 'mcp_api')` returning a structured `pending_approval` result; two new built-in MCP tools expose the intent lifecycle; approval/execution happen entirely through Plan 1's machinery.

**Tech Stack:** Hono, Plan 1's `intentService`, Vitest.

**Prerequisite:** Plan 1 (`2026-07-18-action-intents-core.md`) fully merged. **This is a BREAKING CHANGE release** for API-key integrations using `ai:execute` on Tier-3 tools — hard cutover, no compatibility flag (locked decision).

## Global Constraints

- `ai:execute` scope = may CREATE T3 intents; `ai:execute_admin` + `isExecuteToolAllowedInProd` continue to gate WHICH tools may be requested. T1/T2 behavior, RBAC checks, and rate limits unchanged.
- T4 remains blocked outright — never intent-eligible.
- The deleted comment/behavior "MCP server auto-executes Tier 3 tools without approval" (`mcpServer.ts:996-997` area) must not survive anywhere, including docs.
- MCP intents: source `mcp_api`, 24h expiry, caller-supplied `idempotencyKey` honored (same key → same intent, no duplicate side effect).
- Status mapping (spec §10.4, exact): intent `pending_approval`→`pending_approval`; `approved|executing`→`in_progress`; `completed`→`completed` (+sanitized result); `failed`→`failed` (+errorCode); `rejected`→`rejected`; `expired`→`expired`; `cancelled`→`cancelled`.
- `cancel_action`: requester (same API key or user) or an eligible approver only; CAS from `pending_approval|approved` only.
- Worktree may contain unrelated concurrent WIP — stage explicitly, never `git add -A`.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/routes/mcpServer.ts` | Modify | T3 rewiring; register 2 built-in tools |
| `apps/api/src/routes/mcpServer.test.ts` (or sibling test files) | Modify | Cutover + new-tool tests |
| `docs/…` release/API docs + `apps/docs` MCP page | Modify | Breaking-change documentation |
| `apps/api/src/__tests__/integration/actionIntentsMcp.integration.test.ts` | Create | End-to-end round-trip |

---

### Task 1: Rewire `tools/call` Tier-3 to intents

**Files:** Modify `apps/api/src/routes/mcpServer.ts` (`handleToolsCall` T3 branch, currently gating at lines ~954-970 then executing via `runTier3ToolLifecycle` at ~1061; the lifecycle helper at ~1170 keeps serving T1/T2 ledger duties if it does so today — READ the function first and preserve non-T3 behavior exactly). Tests alongside.

**Behavior (binding):**
- After the existing scope/RBAC/allowlist/rate-limit gates pass for a T3 tool: call `createActionIntent(auth, { toolName, input: args, source: 'mcp_api', requestingClientLabel: <api key label/client name already available in ctx>, idempotencyKey: <optional 'idempotencyKey' member of tools/call arguments, stripped before arg canonicalization>, reason: <optional 'reason' member, same stripping> })`.
- Success → JSON-RPC result with structured content:

```json
{
  "state": "pending_approval",
  "intentId": "<uuid>",
  "approvalRequestIds": ["<uuid>"],
  "expiresAt": "<iso>",
  "note": "Tier-3 actions require human approval. Poll get_action_status or cancel with cancel_action."
}
```

- Idempotent replay (existing intent returned): map the CURRENT status through the Global Constraints table (a replay of a completed intent returns `completed` + result — no re-execution).
- `no_eligible_approvers` → JSON-RPC error with that code and a human sentence.
- Delete the auto-execute branch and its comment. `ai:execute` scope checks stay where they are (they now gate intent creation).

- [ ] **Step 1: Write failing tests** (extend the existing mcpServer test fixtures): T3 call returns pending_approval envelope + creates an intent row (mock `intentService`); T3 call NEVER reaches the tool handler; idempotent replay returns mapped current status; T4 still blocked; T1/T2 paths byte-identical behavior (regression: existing tests pass unmodified); scope errors unchanged.
- [ ] **Step 2: Run** the mcpServer test files → FAIL. **Step 3: Implement.** **Step 4: Green + tsc + eslint.**
- [ ] **Step 5: Commit** — `feat(mcp)!: tier-3 tools create durable intents instead of auto-executing`

---

### Task 2: `get_action_status` + `cancel_action` MCP tools

**Files:** Modify `apps/api/src/routes/mcpServer.ts` (register in `handleToolsList` + `handleToolsCall` as built-in tools, visible at `ai:read` scope); tests.

**Contracts (binding):**
- `get_action_status({ intentId })` → `{ state, result?, errorCode?, expiresAt, actionName }` per the status mapping; unknown/foreign-org intent → JSON-RPC error `not_found` (RLS + explicit org check via `getActionIntent(auth, id)` — no existence oracle across orgs).
- `cancel_action({ intentId })` → `{ state: 'cancelled' }` on success; authorization: the intent's requesting API key / user, or a user holding `approvals:decide` for the org; otherwise `not_found` (same non-oracle rule); CAS failure (already terminal/executing) → error `not_cancellable` with current state.

- [ ] TDD: list exposure at ai:read; status mapping table-driven across all 8 intent statuses; cross-org returns not_found; cancel authz matrix; cancel race with release worker (CAS loses → not_cancellable) → implement → green → commit `feat(mcp): add get_action_status and cancel_action tools`.

---

### Task 3: End-to-end integration test

**Files:** Create `apps/api/src/__tests__/integration/actionIntentsMcp.integration.test.ts` (real-Postgres placement per repo convention; runs under the Integration Tests job).

**Scenario (binding):** seed org + admin approver + API key with `ai:execute`; T3 `tools/call` → assert `pending_approval` + intent row + approval fan-out rows; decide via the approvals route as the admin → intent `approved` + outbox row; run the release worker inline (invoke its processor function directly rather than a live BullMQ worker) → intent `completed`; `get_action_status` returns `completed` with sanitized result; duplicate `tools/call` with the same idempotencyKey returns `completed` without a second ledger row; a second scenario covers deny → `rejected`, and cancel-before-decision → `cancelled`.

- [ ] TDD steps → green locally against the :5433 integration DB (or document CI-only if unavailable) → commit `test(mcp): prove intent round-trip end to end`.

---

### Task 4: Breaking-change documentation + verification gate

**Files:** Update the MCP/API docs page under `apps/docs/` that documents `ai:execute` semantics (grep for `ai:execute` in apps/docs); add a release-notes stub `docs/` entry or the location the `release` skill consumes, stating: Tier-3 via API key now returns `pending_approval`; poll `get_action_status`; approvals happen in the Breeze UI/mobile; `ai:execute` no longer auto-executes.

- [ ] Steps: docs edits → docs build green → full gate (`pnpm --filter @breeze/api test`, tsc, eslint, `git diff --check`) → commit `docs(mcp)!: document tier-3 approval requirement for API keys` → `/code-review` (one round).

---

## Self-Review Notes

- Task 1 must NOT touch T1/T2 dispatch or the scope model — regression suites are the guard.
- The `idempotencyKey`/`reason` members are stripped from `args` BEFORE canonicalization so they never affect the digest (and never reach the tool handler).
- The non-oracle rule (`not_found` for both nonexistent and unauthorized) applies to both new tools — matches the repo's LIST/RLS defense-in-depth conventions.
- Release timing: merge Plan 1 → at least one production deploy cycle → merge Plan 2 (intents must exist before callers are pointed at them). Both plans can land in the same release for self-hosters; the ordering constraint is within-deploy migration-before-API, which autoMigrate already guarantees.
