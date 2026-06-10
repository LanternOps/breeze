# Helper Privileged-Action Governance (PAM-backed)

**Date:** 2026-06-10
**Status:** Design — approved, pending spec review
**Security finding:** A (HIGH) from the 2026-06-10 defensive security review
**Depends on (Phase 1 only):** PR #1183 — PAM control plane (`pam_rules`, `pamRuleEngine`, `/pam` admin API)

## Problem

The Breeze Helper (tray AI assistant) authenticates to `/api/v1/helper/*` with a
`helper_auth_token` that is **deliberately** stored in the world-readable `agent.yaml`
(mode `0644`) so the Helper, running as the logged-in user, can read it. That token
today grants two things it must not:

1. **Org-wide reach.** `helperAuth` (`apps/api/src/routes/helper/index.ts:135-159`) builds a
   synthetic `AuthContext` scoped to the whole organization (`orgCondition` matches every
   row with `org_id = device.orgId`; no `canAccessSite`), even though the device's own
   `siteId` is in scope at line 126. Tool authorization (`verifyDeviceAccess` in the
   `aiTools*` layer) then authorizes **any** device in the org, not just the local one. The
   bound device id is only a prompt hint (`helperAiAgent.ts`), never enforced server-side.

2. **Self-approval of the human-in-the-loop gate.** Tier-2/3 tools block on
   `waitForApproval` polling `ai_tool_executions.status` (`services/aiAgent.ts:181-262`).
   The Helper's own approve endpoint (`helper/index.ts:642-688`) accepts the **same** helper
   bearer, requires only that the execution belongs to the device, and flips the row to
   `approved` (`approvedBy: null`). The credential that requests the action also authorizes
   it.

**Threat model: untrusted end-user.** The person (or any local process / malware) at a
managed endpoint is untrusted. Any local-unprivileged user can read `agent.yaml`, then drive
mutating RMM actions (`run_script`, `execute_command`, `file_operations` write/delete,
`manage_services`, and at `extended` level `s1_isolate_device` etc.) against **every device
in the organization**, bypassing approval. Verified end-to-end; confidence 9/10.

## Goals

- A stolen/locally-read helper token can never (a) act on a device other than the one it
  belongs to, or (b) cause a privileged/mutating effect without a **separate authenticated
  identity** approving it.
- Privileged Helper actions become **policy-governed** (per org/site/device) and **approved
  through PAM**, with full audit — the durable end-state the product wants.
- Close the live HIGH finding **without** blocking on the in-flight PAM PR (#1183).

## Non-goals (explicit)

- **Short-lived / IPC-attested helper token.** Binding the credential to the live
  broker-attested helper process instead of a long-lived bearer in the `0644` file is the
  deepest theft mitigation but a larger agent+API change. Out of scope here; with
  device-scoping + read-only-default + PAM-gated mutations, a stolen token is reduced to
  *device-scoped read only*. Tracked as follow-up.
- **Changing the `agent.yaml` `0644` readability invariant.** Intentional — the Helper runs
  as the logged-in user and must read it (`secretKeyAllowedInAgentYAML`). Not touched. The
  locked secret store (`secrets.yaml`, `0600`) is unchanged.
- General AI-chat (dashboard) approval flow is not changed except where Phase 1 reuses its
  `ai_tool_executions.status` gate.

## Approach: phased

Phase 0 ships independently and **closes the HIGH**. Phase 1 folds the governance into PAM
once #1183 is merged. Device-scoping (Phase 0 #1) is permanent and underlies both phases.

---

## Phase 0 — security hardening (no #1183 dependency)

### 0.1 Device-scope the Helper auth context
- Add `helperDeviceId: device.id` to the synthetic `AuthContext` produced by `helperAuth`
  (`helper/index.ts`). (New optional field on `AuthContext` in `middleware/auth.ts`.)
- Enforce it at the existing tool-authorization chokepoint: `verifyDeviceAccess` /
  `enforceDeviceArgs` (the same gate hardened in the AI-tools site-scope fix). When
  `auth.helperDeviceId` is set, the resolved target device id **must equal** it; otherwise
  deny. This is independent of, and stricter than, org/site scoping.
- Helper-exposed tools that take **no** device-id argument must be auto-scoped to
  `helperDeviceId` (single-device) or excluded by the tool filter (see 0.3). An org-wide
  enumeration tool must never run unscoped under a helper context.

### 0.2 Remove the self-approve endpoint
- Delete `POST /chat/sessions/:id/approve/:executionId` (`helper/index.ts:642-688`). The
  helper token can no longer approve anything.

### 0.3 Read-only Helper by default (chosen posture)
- Drop mutating tools from the Helper's default permission level in
  `services/helperToolFilter.ts` so the `standard` (and the unattended default) Helper
  exposes **read-only/diagnostic** tools only, all device-scoped per 0.1.
- Consequence: until Phase 1 governs them, there are **no self-serviceable privileged
  Helper actions**, so there is nothing for a stolen token to approve. A stolen token →
  device-scoped read + (rate-limited) chat only.
- Mutating tools return in Phase 1, gated by PAM policy/approval.

### 0.4 Interim approval path (for any approval-gated tool that remains)
- Any tool that still requires approval is approved **only** via the existing authenticated
  endpoint `POST /api/v1/sessions/:id/approve/:executionId` (`routes/ai.ts:467`): real JWT
  user, `getSession(sessionId, auth)` org-scoped, audited (`ai.tool_approval.update`). The
  untrusted local user cannot reach it. `waitForApproval` already polls
  `ai_tool_executions.status`, so no plumbing change.
- (With 0.3 read-only-default, this path is dormant for the Helper until Phase 1; retained
  so the mechanism is correct if an org opts a tool back on before Phase 1.)

### Phase 0 acceptance
- A helper-token request whose tool targets a device other than the token's device → denied
  (403/authorization error), with a test proving it.
- `POST /chat/sessions/.../approve/...` returns 404 (endpoint gone).
- Default Helper tool set contains no mutating tools (filter test).
- HIGH finding closed: stolen token = device-scoped read only.

---

## Phase 1 — fold into PAM (depends on #1183 merged)

PAM (#1183) provides the decisioning pipeline (`elevationRequests.ts` ingest → `pamBridge`
software-policy → `pamRuleEngine` → verdict, **fails safe to pending**), a separate-identity
human approval endpoint (`POST /api/v1/pam/elevation-requests/:id/respond`, behind
`authMiddleware` + `requireScope` + `pam:execute`, records `approvedByUserId`, audited, emits
`elevation.approved`), and org/site-scoped policy (`pam_rules` + `/pam/rules` admin CRUD).

### 1.1 Model Helper actions as elevations
- New migration (do **not** edit #1183's): add `flow_type='ai_tool_action'` to the
  `elevation_flow_type` enum, and to `elevation_requests`:
  - `execution_id uuid` → `ai_tool_executions(id)` — the link PAM currently lacks; bridges
    decision back to the gate.
  - `tool_name varchar`, `action_digest text` (sanitized summary/args hash), `risk_tier`
    (smallint or reuse the tool tier).
  - `org_id`/`site_id`/`device_id` already present (Shape 1, RLS already org-scoped); the
    request is created with the Helper's device/org/site.
- Idempotent migration; allowlist entry already covered for `elevation_requests` RLS.

### 1.2 Decisioning for tool actions
- When the Helper invokes a **governed** tool (preToolUse gate in `services/aiAgentSdk.ts` /
  `aiAgent.ts`), create an `elevation_request(ai_tool_action, execution_id=...)` and run the
  PAM decision:
  - Skip `pamBridge` (executable-specific; no binding for a tool action).
  - Extend `pamRuleEngine` with tool-action criteria: `matchToolName`, `matchRiskTier`
    (reuse existing `matchUser`/`timeWindow`). Add the corresponding nullable columns to
    `pam_rules` (new migration) and the `PamRuleCandidate`/`ruleMatches` logic. Criteria-less
    rules remain rejected (no tenant-wide `auto_approve`).
  - Verdict → `auto_approve` | `auto_deny` | `require_approval` | `ignore`; **fail safe to
    pending** on any error (mirrors ingest).

### 1.3 Approval via PAM (separate identity)
- `require_approval` → the elevation row sits `pending`; an authenticated admin approves/denies
  via the existing `POST /pam/elevation-requests/:id/respond` (separate identity,
  `pam:execute`, site-narrowed, audited, emits event). No new approval surface.

### 1.4 Bridge PAM decision → the tool gate
- On `auto_approve`/approved → set the linked `ai_tool_executions.status='approved'`;
  on `auto_deny`/denied → `'rejected'`. Implemented in a shared service called by both the
  ingest auto-decision path and the `/respond` handler, keyed by `execution_id`. This unblocks
  `waitForApproval` with no change to its polling contract.
- The tool then executes — still constrained to the session's device by Phase 0 §0.1.

### 1.5 Policy + admin UI
- `pam_rules` tool-action criteria let admins set per org/site policy: which Helper tools
  auto-approve, which require approval, which are denied.
- The `/pam` admin UI Rules/Requests/Audit tabs surface Helper `ai_tool_action` requests
  alongside UAC/JIT elevations (column reuse; filter by `flow_type`).

### 1.6 Re-enable mutating Helper tools (governed)
- Mutating tools removed in Phase 0 §0.3 return to the Helper tool filter, now mediated by
  the PAM decision in §1.2-1.4. Default policy posture: `require_approval` for mutating tiers
  unless an org rule says otherwise.

### Phase 1 acceptance
- Unit: `pamRuleEngine` matches/decides tool-action candidates (tool name, risk tier, user,
  time window; criteria-less rule never matches).
- Ingest routes `auto_approve`/`auto_deny`/`require_approval`/`ignore` correctly; errors →
  pending.
- `/respond` by an authenticated admin flips the linked `ai_tool_executions.status`;
  `waitForApproval` unblocks; tool runs on the session device only.
- A helper-token attempt to act as the approver has no path (no self-approve endpoint;
  `/respond` requires a real user with `pam:execute`).
- RLS + site-scope enforced for `ai_tool_action` rows; audit rows written for request,
  decision, and approval.

---

## Data flow (Phase 1)

```
Helper chat → tool call → preToolUse gate
  → create elevation_request(ai_tool_action, execution_id, device/org/site, tool, tier)
  → pamRuleEngine verdict
       auto_approve  → mirror ai_tool_executions.status = approved
       auto_deny     → mirror status = rejected
       require_approval → row stays pending
                        → admin POST /pam/elevation-requests/:id/respond (separate identity)
                        → mirror status = approved | rejected
  → waitForApproval unblocks on status
  → tool executes, constrained to the session's device (Phase 0 §0.1)
```

## Components & boundaries

- `helper/index.ts` (`helperAuth`) — emits a device-scoped synthetic auth; no approve route.
- `middleware/auth.ts` — `AuthContext.helperDeviceId?` field.
- `aiTools*` `verifyDeviceAccess`/`enforceDeviceArgs` — honors `helperDeviceId` lock.
- `services/helperToolFilter.ts` — read-only default (Phase 0), governed mutations (Phase 1).
- `db/schema/elevations.ts` + migration — `ai_tool_action` flow_type, `execution_id`, action cols.
- `db/schema/pam.ts` + migration — tool-action match criteria on `pam_rules`.
- `services/pamRuleEngine.ts` — extended candidate/criteria.
- `routes/agents/elevationRequests.ts` *(or a new internal creator)* — create + decide the
  Helper elevation. (Note: today this route is agent-bearer only; the Helper-side creation is
  API-internal at the tool gate, not a new agent endpoint.)
- `routes/pam.ts` — unchanged approval/`respond` reused; list filter gains `ai_tool_action`.
- A small **status-bridge service** — maps elevation decision → `ai_tool_executions.status`
  by `execution_id` (used by ingest auto-decision and `/respond`).

## Risks / open questions

- **Schema coordination with #1183.** Both new columns (elevations flow_type/cols, pam_rules
  criteria) land as *new* migrations after #1183's, never editing shipped ones (per CLAUDE.md).
- **`pamRuleEngine` candidate is executable-centric.** Adding tool-action fields must not
  regress UAC matching; criteria-less-rule guard stays.
- **Helper request creation point.** Cleanest at the API tool gate (preToolUse), not a new
  agent endpoint — confirm during planning that the gate has org/site/device + execution_id
  in scope to build the row.
- **UX during Phase 0.** Read-only-default means end-users lose self-serve mutations until
  Phase 1 ships; acceptable for the untrusted model and avoids "stuck pending" friction.

## Testing strategy

- Phase 0 and Phase 1 acceptance criteria above are each backed by TDD (RED before GREEN).
- API: Vitest + Drizzle mocks for auth-context device lock, tool-filter default, rule engine,
  ingest routing, status bridge, `/respond` integration.
- RLS/site-scope contract coverage for the new `ai_tool_action` rows.
- No change to `waitForApproval`'s polling contract — verified by reuse.
