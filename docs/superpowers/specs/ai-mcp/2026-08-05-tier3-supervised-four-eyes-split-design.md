# Tier-3 Supervised / Four-Eyes Split + Web Approvals Inbox — Design

**Date:** 2026-08-05
**Status:** Approved (Todd), Codex xhigh advisor review incorporated
**Supersedes/extends:** `2026-07-18-action-intents-approval-layer-design.md` (which assumed a web approvals queue that was never built), `2026-07-27-tier3-plan-mode-approval-parity-design.md`

## 1. Problem

Tier-3 AI tool calls create durable action intents fanned out to every holder of
`approvals:decide` **excluding the requester** whenever any other approver
exists (four-eyes). In practice:

- The only proactive notification is an Expo push to the mobile app, which is
  not publicly distributable yet. Self-hosted shops have no way to receive it.
- There is **no web approvals surface at all** — `/approvals` 404s. The i18n
  copy points at an "Approvals area" that does not exist.
- `CHAT_EXPIRY_MS` (5 min) equals the SDK approval wait budget, so a chat
  intent approved after the turn times out is already expired — durable late
  release effectively never fires for chat.
- Consequence: for any org with ≥2 admins and no mobile app, **every Tier-3
  action is undecidable and expires**. Reported by a self-hosted customer
  2026-08-05.

Deeper model error: the current design treats the requesting human as the
actor, demanding a *different* human approve. The correct model: **the AI is
the actor; the requesting human is the approver.** A technician doing regular
work on a PC must not need a second person; a second person is only warranted
for a small set of high-stakes actions.

## 2. Approval model

Two approval scopes within tier 3 (the numeric tier stays 3; **tier 4 keeps
its existing meaning: blocked** — `aiGuardrails.ts` blocklist. No renumbering):

| Scope | Who decides | Ceremony | Fan-out |
|---|---|---|---|
| `supervised` (default for tier 3) | The requester | Plain Approve/Deny click in chat | Single approval row, owned by the requester |
| `four_eyes` (explicit list) | Any `approvals:decide` holder **other than** the requester | Existing WebAuthn-capable decide flow (web inbox / mobile) | Rows for all eligible approvers, requester excluded |

- `supervised` is gated on nothing new: the requester already passed the
  tool's RBAC check (`TOOL_PERMISSIONS`) — if your role lets you do it by
  hand, you can approve the AI doing it. Durable intent + `ai_tool_executions`
  audit row are retained; audit records `approvalMethod: 'supervised_self'`.
- WebAuthn is **not intrinsically required** for supervised, but the design
  must not forbid it: a later partner assurance policy may escalate supervised
  approvals to step-up (forward-compatible hook, out of scope for v1).
- **Sole-operator fallback stays** for `four_eyes`: when no *other* eligible
  approver exists, the requester's row is fanned to them and requires WebAuthn
  L3 (unchanged current behavior).
- Session `approvalMode` (per_step / auto_approve / plans) is orthogonal and
  unchanged; supervised approval replaces only the four-eyes fan-out, not the
  Tier-2 machinery.
- **MCP: unchanged.** Both scopes fail closed over MCP
  (`MCP_APPROVAL_REQUIRED`), preserving the 2026-08-02 ruling.

## 3. Classification

### 3.1 Mechanism

- New guardrails tables: `TIER3_FOUR_EYES_ACTIONS: Record<tool, action[]>`
  and `TIER3_FOUR_EYES_TOOLS: Set<tool>` (whole-tool rule — required because
  `s1_isolate_device` discriminates on a boolean `isolate`, not a string
  `action`; whole-tool entries also cover single-purpose tools).
- `checkGuardrails` returns `approvalScope: 'supervised' | 'four_eyes'`
  alongside `tier`. Unclassified tier-3 surfaces default to **`four_eyes`**
  (fail-safe), but:
- **Exhaustiveness contract test**: iterate the tool registry; every tool or
  per-action pair whose effective tier is 3 MUST appear in exactly one of
  `TIER3_SUPERVISED_*` / `TIER3_FOUR_EYES_*` explicit classifications. CI
  fails on any unclassified surface, so the fail-safe default can never be
  silently relied on. (Pattern: `aiGuardrails.readonly.contract.test.ts`.)

### 3.2 Starting four-eyes set

Everything currently tier 3 becomes `supervised` **except**:

- **Financial / externally binding:** `manage_invoices` issue, record_payment,
  void_payment; `manage_contracts` activate, cancel; `manage_quotes` send.
- **Tenant shape:** `manage_organizations` create_org; update_org **status
  changes only** (rename/plain field edits stay supervised — handler splits
  the action); `manage_tickets` move_org.
- **Identity / account control (M365 + Google):** password and 2SV resets,
  mail forwarding/delegates, mailbox permissions, user offboarding/disable,
  device wipe. (Absent from the original proposal; adopted from advisor
  review — these act on human identities, not devices.)
- **Destroys or rewinds state:** `manage_hyperv_checkpoints` delete, apply;
  `restore_as_vm` and DR-plan executions; `manage_patches` rollback;
  snapshot/database restore tools.
- **Surveillance-grade access:** computer control and unattended remote
  session creation.
- **Containment release:** S1 unisolate and threat rollback. (Isolate and
  quarantine stay **supervised** — urgent protective containment must not
  wait on a colleague; they also carry S1-side MFA.)

Explicitly supervised (the customer's "regular work on a PC"):
`execute_command`, `run_script`, `file_operations` read/write/delete/mkdir/
rename, `registry_operations`, `manage_services` start/stop/restart,
`manage_processes` kill, `manage_patches` install, scheduled tasks, startup
items, disk cleanup, agent upgrades, backup triggers, policy/deployment
mutations, monitor/group/automation management.

Deferred (v2, recorded as follow-ups): dynamic escalation to four_eyes by
target count / fleet percentage / protected registry paths or services;
partner-configurable escalation list (additive on the same enforcement
point); partner policy requiring step-up on supervised.

## 4. Intent layer changes

### 4.1 Fan-out (`intentService.ts`, `intentApprovers.ts`)

- `createIntent` receives `approvalScope` from guardrails and persists it on
  the intent (new immutable columns: `approval_scope`,
  `classification_version`). Live pre-migration intents backfill as
  `four_eyes` / version 0.
- `supervised`: single approval row for the requester. No push fan-out.
- `four_eyes`: current fan-out, **now filtered by `users.status = 'active'`**
  — today disabled/invited users count as eligible approvers, inflating
  four-eyes and suppressing the sole-operator fallback (confirmed bug; fix
  ships with this work and gets its own test).
- Expiry split (advisor-confirmed trap: single `expires_at` reaps intents
  approved at 59:59 before the worker claims them):
  - `approval_expires_at`: supervised chat 5 min (unchanged UX);
    four_eyes chat **60 min**; MCP 24 h (unchanged).
  - Execution lease (`release_by`): stamped atomically when an approval wins;
    bounded (minutes). Reaper expires on `approval_expires_at` for pending
    and `release_by` for approved.
- **Content pinning for four_eyes** (TOCTOU, advisor-confirmed): arguments
  bind mutable references (script body, quote/invoice contents, org state
  resolve at execution). Four-eyes intents pin an effect digest at creation —
  script content hash, quote/invoice revision, target state/version — and the
  release worker revalidates; any drift fails the release with
  `content_changed`. Supervised intents skip pinning (requester approves
  within the same 5-minute window they asked in).
- **Durable-executable contract**: some tools are `session_required` in the
  release worker. Contract test: every four_eyes-classified tool MUST be
  durably executable (or explicitly carved out with a session-window-only
  expiry).

### 4.2 Decide path (`routes/approvals.ts`)

- Supervised, requester-owned row: approve/deny with **no assertion**; the
  handler verifies `approval_scope = 'supervised'` AND
  `intent.requestedByUserId = userId` AND live RBAC for the underlying tool
  action. Everything else keeps the existing assurance gates (four_eyes
  approver L1+; sole-operator self-approve L3).
- **Atomic decide** (advisor-confirmed defect): approval-row CAS, intent
  transition, sibling expiry, outbox insert, and audit projection move into
  one transaction; the endpoint returns success only if the intent transition
  committed. The existing integration test asserting HTTP 200 with a
  still-pending intent after fault injection is updated to assert rollback.
  `report-suspicious` gets the same treatment.
- Live authorization on reads (advisor-confirmed): `GET /pending` joins the
  intent, returns only rows whose intent is still `pending_approval`, and
  re-checks current org access + `approvals:decide` (four_eyes) or requester
  identity (supervised). Add pagination and a count-only endpoint for the
  badge. A demoted approver must stop seeing request arguments immediately.
- Mount path: expose the same router at a transport-neutral path
  (`/api/v1/approvals`), keeping `/api/v1/mobile/approvals` as an alias for
  shipped mobile clients.

## 5. Web approvals inbox

- New page `apps/web/src/pages/approvals/index.astro` + `ApprovalsPage`
  island: pending list (grouped requester/tool/target/org, countdown), decide
  buttons, report-suspicious, decided-history tab (requester sees own intents
  + outcomes, covering late results).
- Four-eyes decide reuses `lib/intentApprovals.ts` (WebAuthn ceremony +
  fallback). Supervised rows normally never appear here (decided in chat),
  but if opened, render with plain confirm.
- Sidebar entry + badge: `badgeKind` pattern from Deletion Requests
  (`Sidebar.tsx`), count from the new count endpoint, `99+` clamp.
  Visible to users holding `approvals:decide` **or** having ≥1 pending row
  (supervised requesters must be able to reach their own history — do not
  hide behind `approvals:decide` alone).
- Register in `lib/routeScope.ts`; add locale keys to every locale (parity
  suites `localeParity.test.ts` fail otherwise).
- In-chat four-eyes card: passive waiting state with the real
  `approval_expires_at` countdown; on late execution, the session shows the
  result when reopened (worker already persists it; the history tab is the
  guaranteed surface).

## 6. Notifications

- **Web:** new event published on intent lifecycle (created / decided /
  expired) as an **IDs-only invalidation hint** — `{intentId, status}`;
  never arguments or summaries. Advisor-confirmed constraints:
  - Event name must satisfy the eventWs subscription regex (first namespace
    segment cannot contain `_`): use `approval.intent.updated`.
  - New first-class `audienceUserId` on the publish path: dispatcher filters
    by `ClientEntry.userId` (today informational only), the event is
    **excluded from webhook and plugin `*` fan-out and the global channel**
    (a WS-only filter is not a privacy boundary), and it bypasses the
    site-filter drop (no `siteId`).
  - Client treats events as refetch triggers: fetch count/list after
    subscribe-ack, on reconnect, on focus, and on every lifecycle event.
- **Mobile:** existing Expo push unchanged (now correctly scoped to
  four_eyes intents only — supervised intents no longer push).
- **No email in v1** (revisit if wait-time data shows approvers miss
  requests).

## 7. Copy

- `ai.json` `pendingApproverDescription` → "This action needs approval by
  another administrator — they can approve it from the Approvals page or the
  Breeze mobile app." (and the page now exists).
- Supervised card copy: plain confirm language ("Approve this action"), no
  mobile-app mention.
- Sweep `settings.json` / `common.json` approver-device strings for
  mobile-app-only framing where the web inbox is now the primary surface.

## 8. Testing contracts

- Guardrails: exhaustive classification contract test (§3.1); scope
  regression tests for the starting set; `s1_isolate_device` whole-tool rule.
- Intent service: users.status filter; supervised single-row fan-out;
  sole-operator preserved under four_eyes; expiry/lease split (approval at
  deadline-minus-ε executes; lease overrun fails); content-pin drift fails
  release; idempotent replay within the 1-h window returns the existing
  intent.
- Decide route: atomicity fault-injection (rollback, not 200+pending);
  supervised requester plain decide; four_eyes requester 403; demoted
  approver loses read access; duplicate clicks; digest mismatch.
- eventWs: audience filtering (other users in org receive nothing), regex
  acceptance, webhook/plugin exclusion.
- Web: inbox page tests, badge count degrade-to-hidden, locale parity, route
  scope; `AiApprovalDialog` supervised/four_eyes/sole-operator variants.
- Integration: end-to-end four_eyes chat intent approved at +30 min executes
  via release worker and surfaces in history.

## 9. Rollout

1. Migration: `approval_scope`, `classification_version`,
   `approval_expires_at`, `release_by`, effect-digest column; backfill live
   intents as `four_eyes`/v0. Idempotent, same-day `-a-`/`-b-` ordering if
   split.
2. API + guardrails + worker changes behind the classification (no flag —
   supervised is strictly less restrictive than today only for the requester,
   and strictly more deliverable for four_eyes).
3. Web inbox + events + copy.
4. Release notes: self-hosters get working approvals without the mobile app;
   document the new four-eyes action list and the `approvals:decide` meaning
   change ("second pair of eyes").

## 10. Out of scope

Dynamic/bulk escalation; partner-configurable four-eyes list; partner
step-up policy on supervised; email notifications; MCP-initiated durable
intents; renumbering blocked tier 4.
