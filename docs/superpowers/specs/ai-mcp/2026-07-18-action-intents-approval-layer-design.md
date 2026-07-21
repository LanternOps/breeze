# Action Intents & Durable Approval Layer — Design

**Date:** 2026-07-18
**Status:** Approved design, pre-implementation
**Parent:** `2026-07-13-breeze-m365-control-plane-design.md` §9–§10, §17 stage 3
**Relation to existing code:** extends `approval_requests` (`db/schema/approvals.ts`) and the PAM
elevation patterns (`db/schema/elevations.ts`); rewires `aiAgentSdk.ts` T3 flow and
`routes/mcpServer.ts` T3 gating.

## 1. Purpose

Give Breeze a durable, digest-bound intent + approval capability for every Tier-3 tool
action, and close the external MCP bypass in which `ai:execute` API-key scope
auto-executes Tier-3 work with no human gate (`mcpServer.ts` — "Approval flow is for
interactive UI only"). v1 consumers are **all existing Tier-3 tools** (scripts,
commands, registry deletes, and current T3 M365/Google tools). Future M365 mutation
executors (`customer-graph-actions`, Exchange PowerShell) plug in as additional action
sources with no new approval machinery.

Decisions locked during brainstorming:
- **Generic layer**, all current T3 tools as first consumers — not M365-scoped.
- **Hard cutover** for the MCP bypass: the auto-execute path is deleted in one release;
  no legacy flag, no per-key grandfathering. Release-notes callout for self-hosters.
- **Org approver pool**: any user with the new `approvals:decide` permission and access
  to the intent's org may decide; first decision wins. The requester may not approve
  their own intent…
- …except **sole-operator step-up self-approval**: when the eligible approver set is
  exactly the requester, self-approval is allowed at assurance level ≥ 3
  (`webauthn_platform` or `mobile_hw_key`), audited as `self_approved_sole_operator`.

## 2. Scope and non-goals

**In scope:** `action_intents` + `intent_outbox` tables (+ migration, RLS, cascade
registration); intent creation service with canonicalization + digest; approver
fan-out through `approval_requests` (new nullable `intent_id` FK); intent state
machine with CAS transitions and expiry reaping; transactional outbox + BullMQ
publisher; durable release worker with pre-execution revalidation; chat SDK
integration; MCP `pending_approval` response contract + `get_action_status` /
`cancel_action` tools; approval-detail UI additions; audit + metrics.

**Non-goals:** new approval UI subsystems (web queue, push, WebAuthn step-up are
reused as-is); M365 mutation actions themselves (stage 5); per-org configurable
approval policies (a PAM-rules-style auto-decision engine for intents is future work —
v1 is "every T3 intent requires a human decision"); Tier-2 policy gating changes; T4
stays blocked outright; webhooks for status delivery (poll/tool only in v1).

## 3. Data model

### 3.1 `action_intents` (new; tenancy shape 1, org axis)

Identity / attribution:
- `id` uuid PK; `org_id` NOT NULL FK; `partner_id` denormalized (PAM elevations
  pattern); `requested_by_user_id` nullable FK; `requesting_api_key_id` nullable FK —
  CHECK exactly one of the two is set; `source` enum `chat | mcp_api`;
  `requesting_client_label` (MCP client name / session label).

Immutable action content (UPDATE-blocked by trigger, §3.4):
- `action_name`, `action_version` int; `arguments` jsonb (canonicalized: sorted keys,
  no undefined, stable number formatting); `argument_digest` char(64) — SHA-256 hex of
  the canonical JSON; `target_summary` text; `impact_summary` text; `reason` text
  nullable; `risk_tier` smallint (3 only in v1; column exists for future T2-policy
  use); `connection_id` / `tenant_id` nullable (M365 mutation forward-compat);
  `idempotency_key` text — UNIQUE `(org_id, idempotency_key)`; `correlation_id` uuid.

Lifecycle (mutable):
- `status` enum `pending_approval | approved | executing | completed | failed |
  rejected | expired | cancelled`; `created_at`; `expires_at`; `decided_at`;
  `decided_assurance_level` / `decided_via` / `decided_by_user_id` (mirrored from the
  winning approval); `executed_at`; `result` jsonb (sanitized, size-capped); 
  `error_code` text.

RLS: `breeze_has_org_access(org_id)` + system, forced. Registered in
`CORE_ORG_CASCADE_DELETE_ORDER` and the RLS coverage test in the same PR.

### 3.2 `intent_outbox` (new; same migration)

`id` bigserial PK; `intent_id` FK NOT NULL; `event_type` enum `intent_created |
intent_approved`; `payload` jsonb (ids only, no argument
content); `created_at`; `published_at` nullable; `publish_attempts` int default 0.
Written in the **same transaction** as the intent row / status transition it
announces. System-scoped (no org RLS; workers only), like `device_commands` —
documented as INTENTIONAL_UNSCOPED with the same justification pattern. Cascade: FK
`ON DELETE CASCADE` from `action_intents`.

### 3.3 `approval_requests` extension

New nullable `intent_id` uuid FK → `action_intents(id)` ON DELETE CASCADE, sitting
beside the existing `execution_id` and `elevation_request_id` links. One intent fans
out to N approver rows (one per eligible approver). Enforce "at most one of
`execution_id` / `elevation_request_id` / `intent_id` is set" — extend the existing
CHECK if one exists, else add it (verify against the shipped schema at
implementation time). Intent-linked approval rows never carry `execution_id`: the
execution-ledger linkage lives on the intent side (§6.1), not the approval row. The digest is carried in `action_arguments`' sibling — a new
`bound_argument_digest` char(64) nullable column — so the decision row itself records
what content was approved.

### 3.4 State machine and integrity

```
pending_approval ──approve──▶ approved ──release──▶ executing ──▶ completed
      │  │  │                    │                      └───────▶ failed
      │  │  └──deny────────────▶ rejected (terminal)
      │  └─────expire──────────▶ expired  (terminal)
      └────────cancel──────────▶ cancelled (terminal; also legal from approved)
```

- Every transition is `UPDATE … WHERE id = $1 AND status = $expected` (CAS); zero rows
  = lost race, caller re-reads. `approved → executing` is the single-use release guard
  (PAM `actuating` pattern) — a job retry that finds `executing`/terminal does nothing.
- A BEFORE UPDATE trigger rejects changes to the §3.1 immutable columns
  (`RAISE EXCEPTION 'action_intents content is immutable'`). Material edits = new
  intent + new approvals, per parent spec §10.2.
- Expiry defaults: `chat` → 5 minutes (current UX); `mcp_api` → 24 hours. Constants,
  not env vars. The existing reaper pattern (30s BullMQ sweep, `FOR UPDATE SKIP
  LOCKED`, cap 500) gets an intent sweep: `pending_approval`/`approved` past
  `expires_at` → `expired`, linked approval rows expired, one audit event each.
  `approved` intents expire too — approval does not stop the clock; execution must
  begin before `expires_at`.

## 4. Intent creation

`services/actionIntents/intentService.ts` — `createActionIntent(auth, {toolName,
input, reason?, source})`:

1. Resolve tier via `getToolTier` + `checkGuardrails` (existing). Tier ≤ 2 → not an
   intent path; T4 → refused outright.
2. Resolve org (session org / `resolveWritableToolOrgId`); canonicalize args; compute
   digest; build target/impact summaries from the tool's definition (v1: tool
   description + a per-tool optional summarizer hook; default = tool name + top-level
   arg keys with values truncated).
3. Idempotency: caller-supplied key (MCP `idempotencyKey` param) or derived
   `sha256(actor + action + digest)` for chat. Insert conflict on
   `(org_id, idempotency_key)` returns the EXISTING intent (status included) instead
   of creating a duplicate — retries converge, per parent spec §13.
4. Resolve eligible approvers: users with org access and `approvals:decide` (new RBAC
   permission; seeded to org-admin and partner-admin roles by migration). Exclude the
   requester. If non-empty → create one `approval_requests` row per approver (digest
   bound, `expiresAt` = intent's), push via `dispatchApprovalPushToTokens`, web queue
   picks them up as today. If empty and requester is eligible → sole-operator row for
   the requester flagged `requires_assurance_level: 3`. If empty and requester is not
   eligible → intent created then immediately `cancelled` with
   `error_code = 'no_eligible_approvers'` (fail closed, visible in audit).
5. Intent row + `intent_created` outbox row in one transaction.

Decision handling extends `routes/approvals.ts`'s existing decide handler: when the
approval row has `intent_id`, the first-wins CAS also (same txn) transitions the
intent `pending_approval → approved|rejected`, stamps decider/assurance, expires
sibling rows, writes an `intent_approved` outbox row on approval. Sole-operator rows
enforce assurance ≥ 3 before the CAS (reusing the step-up machinery in
`approverWebAuthn.ts`); decisions below the bar are refused with the existing
StepUpRequiredError flow.

## 5. Outbox publisher and release worker

- `jobs/intentOutboxPublisher.ts`: 5s repeatable BullMQ job; claims unpublished rows
  (`FOR UPDATE SKIP LOCKED`, cap 200), enqueues the corresponding queue job (jobId =
  `intent-<eventType>-<intentId>` — no colons), marks `published_at`. Re-publishing is
  harmless: consumers are CAS-idempotent. Stuck rows (attempts > 5) alarm via the
  existing job-failure logging.
- `jobs/intentReleaseWorker.ts` consumes `intent_approved`:
  1. CAS `approved → executing`; zero rows → done (raced with expiry/cancel/retry).
  2. **Revalidate** (all fail-closed, intent → `failed` with a categorized
     `error_code`, never silent):
     - winning approval still `approved` and its `bound_argument_digest` equals the
       intent's `argument_digest`;
     - tool exists and `getToolTier(tool)` has not **increased** since creation
       (increase → `failed: tier_escalated`);
     - actor still valid: user active with required RBAC, or API key unrevoked with
       required scopes — rebuild the `AuthContext` via a new
       `services/actionIntents/actorContext.ts` (`buildAuthContextForIntent`), which
       reuses the same permission/site resolution the auth middlewares use;
     - org active; for intents carrying `connection_id`: connection status still
       executable and manifest version unchanged (dormant until M365 mutations).
  3. Execute through the existing `executeTool` path (guardrails, execution ledger,
     device gates, audit) with the rebuilt context.
  4. CAS `executing → completed|failed`; store sanitized result (cap 64 KiB; oversize
     → result replaced by `{truncated: true}` + `error_code: result_too_large` is NOT
     set — completion stands, result is just capped).

## 6. Caller surfaces

### 6.1 Chat SDK (`aiAgentSdk.ts`)

T3 flow becomes intent-backed: create intent (source `chat`) instead of a bare
approval row; `waitForApproval` polls **intent** status. Fast path: when approval
lands while the session is alive, the session executes inline exactly as today —
inline execution performs the same CAS `approved → executing`, so the release worker
and the session can never double-execute. If the session is gone when approval lands,
the release worker finishes and the result is in the intent for later retrieval.
`ai_tool_executions` keeps its role as the execution ledger; the intent references it
via the winning approval row's existing `execution_id` when inline, or the worker
creates the ledger row when durable.

### 6.2 External MCP (`routes/mcpServer.ts`) — the hard cutover

- The T3 auto-execute branch (`runTier3ToolLifecycle` direct call) is **deleted**.
- `tools/call` on a T3 tool → `createActionIntent(source: 'mcp_api')` → structured
  response: `{ state: 'pending_approval', intentId, approvalIds, expiresAt }`.
- New MCP tools: `get_action_status({intentId})` → `{state, result?, errorCode?,
  expiresAt}` mapped 1:1 from intent status (parent spec §10.4 states); 
  `cancel_action({intentId})` → CAS to `cancelled` from `pending_approval|approved`,
  requester-or-approver only.
- `ai:execute` scope now authorizes *requesting* T3 work only. `ai:execute_admin` and
  the prod allowlist continue to gate which tools may be requested at all.
- Scope model, T1/T2 behavior, rate limits: unchanged.

### 6.3 Approval UI

The web approval detail and mobile push payloads gain: org (and MS tenant when
present), requester + client label + source, action name/version, target/impact
summaries, blast-radius arg summary, reason, expiry. No new screens.

## 7. Audit and metrics

Audit events (existing `writeAuditEvent`, org-scoped): `action_intent.created`,
`.approved`, `.rejected`, `.expired`, `.cancelled`, `.executed` (result:
success/failure), `.self_approved_sole_operator`. Details carry ids, action name,
digest, decider, assurance — never argument contents beyond the summaries.
Prometheus: `breeze_action_intents_total{source,action,outcome}` and
`breeze_intent_outbox_lag_seconds` (age of oldest unpublished row, gauge).

## 8. Failure modes

| Condition | Behavior |
|---|---|
| No eligible approvers and requester ineligible | Intent `cancelled`, `no_eligible_approvers`, audited |
| Approval after expiry | Decide CAS fails (row expired); caller sees "Already expired" |
| Concurrent approve+deny | First CAS wins; loser gets "Already decided" |
| Worker crash mid-execution | Intent stuck `executing`; stale-executing sweep (reaper) flips to `failed: execution_lost` after 2× tool timeout; idempotency key lets the caller safely re-request |
| Digest mismatch at release | `failed: digest_mismatch` (should be impossible; defense-in-depth) |
| Tool tier raised after intent creation | `failed: tier_escalated` |
| Actor disabled / key revoked before release | `failed: actor_invalid` |
| Duplicate MCP request (same idempotency key) | Same intent returned; no second side effect |
| Redis/BullMQ down at approval time | Outbox row persists; publisher drains on recovery |

## 9. Testing

- CAS races: concurrent approve/deny, approve/expire, double release (property: at
  most one `executing` transition ever succeeds).
- Immutability trigger: UPDATE on content columns raises.
- Outbox: crash between intent-insert and publish → publisher delivers later,
  exactly-once effect via CAS consumers.
- Revalidation matrix: digest tamper, tier bump, disabled user, revoked key, expired
  approval.
- Sole-operator: assurance < 3 refused; multi-approver orgs never offer requester a row.
- RLS + cascade contract tests for `action_intents` (org forge 42501; cascade order).
- MCP integration: T3 call → pending_approval → approve via API → status poll returns
  completed with sanitized result; cancel path; idempotent re-request.
- Chat regression: fast-path approval still executes inline; session-death path
  completes via worker.

## 10. Delivery split

- **Plan 1 (additive, no behavior change):** schema + migration, intent service,
  fan-out, decide-handler extension, outbox + publisher + reapers, release worker,
  chat SDK integration behind the intent path, audit/metrics, UI field additions.
- **Plan 2 (the cutover):** MCP T3 rewiring, `get_action_status` / `cancel_action`
  tools, deletion of the auto-execute branch, release-notes/breaking-change docs,
  end-to-end MCP integration tests.
