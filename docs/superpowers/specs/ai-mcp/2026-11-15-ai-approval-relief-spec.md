---
title: AI approval relief — scoped session allowances and a per-tool trust list for Tier 2 tools
status: draft, awaiting product-owner decisions (Open Decisions §9)
date: 2026-11-15
anchor: LanternOps/breeze#11990
depends_on: LanternOps/breeze#11989 (per-call approval attribution in the audit event)
related: "#3088, #3093, #11974, #11674, #11979, #11817"
---

# AI approval relief: scoped session allowances and a per-tool trust list

This spec designs fewer approval cards for repeated, low-variance Tier 2 work in AI chat and Wisp chat. It does not change Tier 3. Every server-side check that runs today still runs, and every call that runs without a card can be traced in the audit log to the decision that allowed it.

**Terms.** *Tier 2* is a mid-risk tool call that shows a lightweight approval card under the default `per_step` approval mode. *Tier 3* is a high-risk call that goes through a durable approval intent. A *card* is the in-chat approval prompt for one Tier 2 call. *Relief* is any path that lets a Tier 2 call run without a card. The issue calls the per-session relief a "scoped session grant". This spec calls it a **session allowance**, because "grant" already names the Wisp delegation grant (`wisp_grants`) and the step-up window. Three meanings of one word in the same gate would confuse readers and code. The name is a reversible default.

**Evidence labels.** **Verified** means read on `origin/main` at `ce8d1e5551` (the cited path and symbol). **Inferred** means it follows from what was read but was not confirmed. **Not checked** means it was not looked at. **Reviewer-verified** means the independent reviewer (§10) read it and I spot-checked it. Line numbers are left out on purpose because they drift.

**Where code and the issue differ.** The issue says the session's own `approvalMode` "is stored". It is not: `ai_sessions` has no approval-mode column (verified, `apps/api/src/db/schema/ai.ts`, `aiSessions`). Session create accepts an optional `approvalMode` and passes it into the insert values (`createSession`, `apps/api/src/services/aiAgent.ts`), but the only `approval_mode` column is on `ai_budgets`. §5.8 is designed against the code.

---

## 1. Problem

Under the default `per_step` mode, each Tier 2 call that is not on a read-only allowlist waits on a card. The only relief an org has is the `auto_approve` mode, which removes every Tier 2 card at once. There is nothing in between:

1. No way to say "allow this exact request again for the rest of this conversation", or "allow this action on this record".
2. No way for a partner or org to mark specific Tier 2 tools as not needing a card.
3. A retry of a call that was just approved shows a new card (#3093 is the reported instance; §5.7 explains what reuse can and cannot cover).
4. When the shared approval wait budget of an assistant message is spent, later Tier 2 calls in that message are refused before a card is shown, and the user is not told which ones.
5. Session create accepts an approval mode that nothing stores or reads, and Pause lives in process memory only.

Earlier reports of the same friction: #3088 (25 prompts in 35 minutes; the read-only part was fixed by #3130's read-only allowlists) and #11974 (a passkey step-up on read-only Security-log queries). #11974 is a Tier 3 path and is **not** addressed here (§8). Card clarity is tracked in #11674 and #11979. This spec depends on cards naming their target clearly, because an allowance is only as clear as the card that offers it.

**Goal.** Fewer cards for repeated, low-variance Tier 2 work, with every existing check still enforced on the server, and every card-free call attributable in the audit log.

**Non-goals.** Making any refusal into an allow. Relief only ever replaces a card that would otherwise have been shown. Relief is not a defence against prompt injection: it must be safe *assuming* the model is steered (§4, principle 6).

## 2. Users and scope (partner vs org)

| Who | What they do here |
|---|---|
| **Technician in chat** (the session owner, a `user_session` principal) | Approves a card once and chooses "allow again"; sees and revokes active allowances; pauses the session to stop all relief. |
| **Org admin** | Sets the org's trust list, tighten-only against the partner's (§5.6). Can list and revoke active allowances in the org. |
| **Partner admin** (full partner org access) | Sets the partner default trust list for all orgs. Sets the partner approval mode (it locks orgs today). |
| **MSP vs internal IT** | An MSP partner admin and a customer org admin are different people with different trust. For an internal IT team the partner and the org are usually the same people, and tighten-only costs them nothing. |

- **Allowances are per session, per user, per org.** They are runtime consent, not configuration. Only the session owner creates one.
- **The trust list is configuration**: partner default with org override, partner-wide first (`docs/agents/tenancy-rls.md`, "Partner-Wide First").
- **Dark by default** behind one flag with `off | shadow | on` (§11).

## 3. Current behaviour

Short and neutral. This is what the design builds on.

### 3.1 The gate order (verified, `apps/api/src/services/aiAgentSdk.ts`, `createGatedSessionPreToolUse`)

For a chat tool call the gate runs these steps in order and returns a refusal at the first one that fails:

1. work-turn-limit stop; live resolution of a flow tool; unknown-tool refusal; the topology investigation gate;
2. the session allowlist (`isAllowedForSession`);
3. the Wisp ceiling (`runWispCeilingGate`), on every call of a session under a Wisp grant;
4. full input-schema validation (`preApprovalInputRefusal`);
5. target org resolution for intent filing (`resolveIntentTarget` / `decideIntentOrg`, `apps/api/src/services/actionIntents/intentTargetOrg.ts`). It is built for Tier 3 coverage: `intentOrgId` starts as the session org, and an out-of-reach refusal is enforced only for Tier 3. The proposal context for `run_script` is loaded here too;
6. tier resolution: `checkGuardrails` (`apps/api/src/services/aiGuardrails.ts`) with the chat guardrail context, then the `run_flow` live-tier lowering;
7. RBAC (`checkToolPermission`, or the tenant and flow equivalents);
8. the per-tool rate limit (`checkToolRateLimit`);
9. the tool's own deterministic refusal (`preFilingToolRefusal` → `AiTool.validateBeforeFiling`) and the `launch_specialist` precheck;
10. for a Wisp call at Tier 2+, the standing-instruction check (`standingInstructionCheck`): a confirmed deny refuses, and any other match forces a card with a conflict banner;
11. Tier 2+ only:
    - **helper session** → PAM decides (`decideHelperToolAction`), before any relief path;
    - the effective mode is `per_step` if `session.isPaused`, else `session.approvalMode`;
    - **existing card-free Tier 2 paths**, each followed by the live re-check of authority (`refreshTier2Authority` → `resolveLiveSessionToolAuthority`, `apps/api/src/services/aiSessionLiveAuthority.ts`, which re-reads user status, org status, membership and permissions, and re-runs the Wisp ceiling): `auto_approve` mode; read-only Tier 2 (`TIER2_READONLY_ACTIONS` / `TIER2_READONLY_TOOLS`); Wisp self-state writes (`wisp/selfStateTools.ts`); Wisp unattended reads. None of the last three runs on a paused session or during an in-flight plan, and none of the four runs with a standing-instruction conflict;
    - **plan step**: under `action_plan` / `hybrid_plan` with an active plan, a call that matches the approved step on its full canonical input (`matchPlanStep`) runs card-free below Tier 3;
    - **Tier 3** → a durable action intent (`createActionIntent`, `apps/api/src/services/actionIntents/intentService.ts`);
    - **Tier 2 card** (the "legacy lightweight bridge"): begins an approval wait from the shared budget, writes an `approval_requests` row for mobile, publishes `approval_required`, blocks on `waitForApproval`, then re-checks live authority and, for Wisp, the standing instruction again before running.

### 3.2 Approving a card (verified)

- `POST /ai/sessions/:id/approve/:executionId` (`apps/api/src/routes/ai.ts`) requires `requireMfa()`, which checks that the login session satisfied MFA (`hasSatisfiedMfa`, `apps/api/src/middleware/auth.ts`). It is not a per-call step-up. `handleApproval` (`apps/api/src/services/aiAgent.ts`) accepts only the **session owner** as approver, only for an execution of the same session, and only from `pending` (a compare-and-set). A stale decision gets a 409. Intent-backed (Tier 3) executions are refused here.
- When `waitForApproval` times out, it writes `rejected` to the execution row by id (`waitForApproval`, `aiAgent.ts`).
- The mobile app decides a Tier 2 card through its `approval_requests` row (`routes/approvals.ts`, not read in detail).
- The card UI is `apps/web/src/components/ai/AiApprovalDialog.tsx`: Approve and Reject, with a WebAuthn ceremony only for intent-backed cards.

### 3.3 Approval mode and Pause (verified)

- Org effective mode: `loadApprovalMode` (`apps/api/src/services/streamingSessionManager.ts`) resolves through `getEffectiveAiBudget`: the partner `aiBudgets` JSONB, then `ai_budgets.approval_mode`, then `per_step`. Any failure gives `per_step`. It is re-read when a new message starts on a reused session, never during a turn.
- The partner settings catalog marks `aiBudgets.approvalMode` as kind `locks` (`packages/shared/src/settings/partnerSettingsCatalog.ts`), so a partner-set mode is enforced over the org's.
- Session mode: see the note at the top. There is no session-level mode in storage or on the gate path.
- Pause: `POST /ai/sessions/:id/pause` needs the session in the local process's memory, sets `activeSession.isPaused`, aborts an active plan, publishes `approval_mode_changed` with `per_step`, and audits `ai.session.pause`. A session rebuilt in memory starts with `isPaused: false`. Pause is stricter than `per_step`: it also stops the read-only, self-state and unattended-read card-free paths.

### 3.4 The approval wait budget (verified)

`beginApprovalWait` draws every approval wait in one assistant message from one shared deadline (`session.approvalWaitBudgetMs`, the org's interactive approval timeout, 5–60 min, `apps/api/src/services/aiApprovalTimeout.ts`). `startTurnTimeout` resets the deadline at each assistant `message_start`. The budget exists so the waits of one assistant message always end before the turn timeout. `settleApprovalWaits` (on a new user message or an interrupt) and the work-turn limit spend the remaining budget on purpose. When the budget is already spent, the Tier 2 bridge closes the ledger row as `rejected` and returns this to the model: "This action needs approval, but the approval window for this turn has ended; it was not requested. The user can ask again in a new message." No event tells the user which calls were skipped.

Because the budget resets at each assistant message, it bounds how long a turn can block, not what the user consents to. The model can re-issue a call in its next message and get a fresh card. It can never skip one.

### 3.5 Audit of the approval path (verified)

`ApprovalMethod` in `aiAgentSdk.ts` has `per_step_user`, `action_intent`, `supervised_self`, `pam`, `plan_step`, `auto_approve_mode`, `read_only_auto`, `wisp_self_state_auto` and `wisp_unattended_read`. The first five are in `DECIDED_APPROVAL_METHODS` and set `approved: true` on the `ai.tool.<name>` audit event. The rest record `approved: false` with the method. The method is carried per session in `lastApprovalBySession` today. #11989 moves it to a per-call channel, and this feature depends on that.

### 3.6 Other surfaces (verified unless marked)

- **External MCP** (`apps/api/src/routes/mcpServer.ts`): a Tier 2 call has no per-call approval. It needs `ai:write`, which `ai:execute` also satisfies. Its effective tier is floored by `mcpTierFloor` (`MCP_APPROVAL_REQUIRED_EXTRA_TOOLS`), and MCP domain grants (`isMcpToolGranted`) narrow which tools a key may call. Tier 3 goes through MCP action intents when that flag is on, with named unattended-principal exceptions (`isUnattendedTier3PrincipalOverMcp`), and is refused otherwise.
- **Helper sessions**: PAM decides every Tier 2+ call.
- **Headless agent runs**: their own allowlist and policy (`checkAgentGuardrails`), with no cards.
- **Excel client AI** (`apps/api/src/services/clientAiSessions.ts`): a synthetic portal-user context with workbook tools that the user previews and applies client-side. **Not checked:** the Outlook ticket surface.
- **Mobile**: an approver for Tier 2 cards via `approval_requests`. **Not checked:** whether a mobile chat surface reaches the same gate.
- **Settings writes** (reviewer-verified, `apps/api/src/routes/orgs.ts`): the org settings write replaces the settings object wholesale; the partner settings write shallow-merges top-level keys, so an included `aiApprovals` block replaces the stored one. The settings audits record which fields changed, not old and new values.

## 4. Design principles

1. **Tier 2 only.** Nothing here changes Tier 3, helper and PAM sessions, headless agent manifests, the Wisp grant ceiling, standing-instruction forced cards, cross-org refusals, plan matching, or a paused session. An input that escalates a call to Tier 3 (`isInputAwareTier3`, `TIER3_ACTIONS`, `resolveApprovalScope`) always wins, because tier resolution runs before relief is consulted.
2. **Relief only replaces the card.** It is consulted at the exact point the gate would show a Tier 2 card, after every earlier check in §3.1. It cannot turn a refusal into an allow, and it is followed by the same live re-check of authority that every other card-free path uses.
3. **Fail closed.** A pair with no reviewed effect contract cannot be relieved. A lookup that fails shows the card. A target that cannot be resolved authoritatively shows the card. A malformed policy is read as the most restrictive value, never as a fallback to a broader inherited one.
4. **The server computes what an allowance covers.** The client never sends the scope; it can only accept the offer the server attached to the card.
5. **Consent has a generation.** Pause, revoke-all, session close and mode changes advance a per-session counter. An offer or allowance from an older generation is dead.
6. **Assume the model is steered.** Ticket text, alert messages and device output can push the model to choose arguments or repeat calls. Hiding allowances from the model is not a boundary: an attacker can ask for eligible actions blindly. A pair is eligible for relief only if every call relief would admit is acceptable when the arguments are chosen by an adversary, and when it is repeated up to the cap.
7. **Every card-free call says why** in its audit event: the method, plus the allowance id or the trust source and its revision.

## 5. Proposed design

### 5.1 Effect contracts (replaces a single grantability ladder)

The first draft used one ordered ladder (`none < exact_call < target < trustable`). The review (§10, finding 6) showed that a ladder folds together properties that vary independently. A closed enum argument can still select very different effects, and an identical input can do something different once defaults or referenced records change. Each Tier 2 (tool, action) pair that may receive relief therefore gets an explicit **effect contract** in a leaf module with no imports (in the style of `wisp/selfStateTools.ts`):

```ts
// apps/api/src/services/aiApprovalRelief/effectContracts.ts (leaf, no imports)
type EffectContract = {
  contractVersion: number;              // bump on any handler change that alters effects
  target: {                             // how the ONE affected record is resolved
    kind: 'device' | 'ticket' | 'alert' | string;
    inputKey: string;                   // single id; arrays and missing keys are ineligible
    resolver: string;                   // name of an authoritative resolver (§5.2) that
                                        // returns the record's org, or fails
  };
  argumentPolicy:
    | { kind: 'exact' }                 // every other argument must match byte-for-byte (canonical)
    | { kind: 'enum_keys'; keys: readonly string[] }; // only these closed-enum keys may vary
  repeatSafe: boolean;                  // running it again on the same target is harmless
  downstream: 'none';                   // the only accepted value: no external system writes,
                                        // no notifications to people, no budget spend,
                                        // no automation armed, directly or via event subscribers
  standingEligible: boolean;            // may appear on the trust list (§5.6)
  reviewedIn: string;                   // the PR or issue that reviewed it
};
```

Rules:

- **No contract = no relief.** The map is an allowlist. Unlisted pairs always show the card.
- **Downstream effects count.** Classification follows the full effect, including event subscribers, not just the handler's own SQL. Both examples in the first draft failed this test when reviewed. `manage_alerts:acknowledge` publishes `alert.acknowledged`, and the PSA alert-ticketing subscriber can add a note to an external ticket when `noteOnAcknowledge` is on (reviewer-verified; `services/psaAlertTicketing/stateMachine.ts`). `manage_tickets:start_timer` accepts model-chosen description text that can reach customer invoices, and it stops the user's running timer, possibly on another ticket (reviewer-verified; `timeEntryService.ts`). Neither gets a contract.
- **The first review may find very few eligible pairs, or none, for the trust list.** That is an acceptable outcome. It is evidence for D8 (§9), not a reason to loosen the rules.
- **Not for read-only pairs.** `TIER2_READONLY_*` pairs already skip the card and get no contract. The contract test keeps the two sets disjoint.
- **Never for dynamic tools.** Tenant BYO MCP tools (`guardrailCheckForTenantTool`) and flow tools (`flow__*`, and `run_flow` at a lowered tier) cannot have static contracts.
- **Action identity** is resolved with `resolveActionForTool` (`aiGuardrails.ts`), so discriminators other than `action` (for example `execute_command`'s `commandType`) are honoured.
- **Versioning.** Allowances and trust-list entries store the `contractVersion` they were created under. A version bump or a removed contract stops them matching, and they are not revived if a contract later returns.

### 5.2 Authoritative target resolution

`resolveIntentTarget` covers Tier 3 and may fall back to the session org (verified, §3.1 step 5), so it cannot prove the org of a Tier 2 call. Each contract names a dedicated resolver. Each resolver reads the one affected record under the call's own reach and returns `{ kind, id, orgId, displayName }`, or fails. Rules:

- A resolver that fails, returns no row, returns a different kind, or resolves to an org other than the session org makes the call ineligible: it shows the card. A fallback to the session org never counts as a resolution.
- The resolver runs when the offer is created, when the allowance is created, and on every use. Each use compares the target's current org with the allowance's org.
- v1 offers relief only when the resolved org equals the session org. A partner session that acts in another org always gets the card. Allowance rows then always belong to the org whose record they name (§6.1).

### 5.3 Where relief is consulted, and the commit point

Relief is consulted in the Tier 2 branch of `createGatedSessionPreToolUse`, **after** the helper/PAM branch, the existing card-free branch and the plan branch, and **before** the card's ledger row is inserted. All of these must hold, or the card is shown as today:

- `guardrailCheck.tier === 2` after escalation and after `run_flow` lowering, and the call is not read-only (read-only calls already skip the card);
- the principal is `user_session` and the session is not a helper session (the same predicate as `chatGuardrailContext`);
- the session is not paused (read from persistent state, §5.8), no plan is in flight, and there is no standing-instruction conflict;
- the call is not a tenant tool or a flow tool;
- the pair has a contract and its target resolves to the session org (§5.2);
- the login that created the allowance is still valid (§5.5.3);
- the flag is `on`. In `shadow` the consult runs and records, but the card is still shown.

**Commit point.** Authorization is committed in one database transaction, in the session org's context, that:

1. re-reads the session's persistent pause state and consent generation;
2. for an allowance, claims one use with a single conditional update (`ended_at IS NULL AND expires_at > now() AND use_count < max_uses AND consent_generation = <current> AND contract_version = <current>`);
3. inserts the call's `executing` ledger row carrying the allowance id or trust revision (one claim per execution);
4. commits.

The live re-check (`refreshTier2Authority`) runs immediately before this transaction, as it does for the existing card-free paths. A pause, revoke or policy change that commits before step 1 wins. One that commits after the commit point does not recall a call that is already dispatched; the UI says so ("actions already started will finish"). A dispatch that fails, or whose outcome is unknown, still counts as a use.

**Ordering.** Trust list first, then allowance. A call covered by both is recorded as `trusted_tool`. §5.5.5 makes the revoke semantics explicit, so the order is visible to users.

### 5.4 The card: "Approve and allow again"

When the call is eligible (§5.3), the gate attaches an **allowance offer** to the card's `approval_required` event:

```ts
// packages/shared/src/types/ai.ts — new optional field on approval_required
allowanceOffer?: {
  scope: 'exact_call' | 'target';
  orgName: string;
  target: { kind: string; id: string; name: string };  // stable id shown, not just the name
  varies?: string[];          // 'target' scope: the only argument keys that may differ
  durationMinutes: number;    // §5.5.2
  maxUses: number;            // §5.5.2
}
```

- The server keeps the full offer in memory, keyed by `executionId` next to the pending card: tool, action, contract version, resolved target and org, args digest, session, user, consent generation and login binding. The digest is computed at gate time from the raw input, not from the redacted `ai_tool_executions.tool_input`.
- `exact_call` is offered for any contract. `target` is offered only for an `enum_keys` contract, and only if D8 enables it.
- A missing authoritative target name or org suppresses the offer. The card then shows Approve and Reject only.

The card shows a third button, **"Approve and allow again"**. It states the scope in words: the action, the org, the target by name **and** short id (#11674's naming), what may differ ("only the status may change" or "this exact request"), the duration and the use cap. Instead of the first draft's "everything else still asks", the text reads: "Other requests follow your organization's approval settings."

`POST /ai/sessions/:id/approve/:executionId` accepts `{ approved: true, allowance: true }`, with the same middleware (`requireScope`, `requireAiUse`, `requireMfa()`) and the same owner check. In one transaction, the route:

1. CAS-transitions the execution `pending → approved`. If the CAS loses (already decided, timed out, ended), nothing else happens and the route returns 409 as today;
2. checks the offer: it exists, its consent generation is current, the session is not paused, the login binding is valid, and the target re-resolves to the same org;
3. inserts the allowance, ending any active allowance with the same (session, tool, action, target), so overlapping allowances cannot multiply the cap.

If step 2 fails, the single call stays approved and the response says `allowanceCreated: false` with a reason, so the card can show it. A request that is not pending never falls back to a single-call approval. `allowance: true` together with `approved: false` is a validation error.

**Required change on the same path:** `waitForApproval`'s timeout close-out becomes a CAS from `pending`, and the wait checks the row after its last poll, so a decision and a timeout cannot both appear to win. An allowance is only ever created by the transaction that won `pending → approved`. If the source call later fails, the allowance still stands, because the user approved the scope and not the outcome; the audit event links the two.

The mobile approval screen gets no third button in v1.

### 5.5 Session allowances

#### 5.5.1 Bound to

The approving user (always the session owner), the session, the session org, the tool, the action, the contract version, the scope (`exact_call` | `target`), the resolved target kind and id, the args digest (`exact_call`) or the varying keys (`target`), the consent generation, the login binding, the approval mode at creation, the source execution, a creation time, an expiry, a use cap and a use count.

#### 5.5.2 Lifetime and bounds

- Default **30 minutes**, never past the session's end, never extended by use.
- Use cap default **20** later calls. The approving call does not count. When the cap is reached, the next call shows a card that can offer a new allowance. Renewal is always an explicit card decision.
- The per-tool rate limits still apply to every call. They are a load limit, not a consent limit.
- The values are an Open Decision (§9 D4).

#### 5.5.3 Ended by

| Event | Effect |
|---|---|
| Session closed or expired | every allowance of the session ends (`session_ended`) |
| Pause, or "Revoke all" | the session's consent generation advances, which ends every allowance and kills every pending offer (`paused` / `revoked`). Un-pausing does not revive anything. |
| A change to the org's effective approval mode | every allowance in the org ends (`approval_mode_changed`), written by the settings route in the same request. The generation check covers a mode that changes A→B→A. |
| A contract version bump or removal | stops matching at once (§5.1) |
| Loss of the user's permission, org or membership | the live re-check refuses the use; the allowance is ended (`authority_changed`) |
| The target moves to another org, or is deleted | the per-use resolver fails; the allowance is ended (`target_changed`) and is not revived if the target moves back |
| Sign-out, or a change to the user's auth or MFA epoch | the allowance stores the login family and the `authEpoch` / `mfaEpoch` (`users.authEpoch` / `users.mfaEpoch`, checked by ordinary auth in `middleware/auth.ts`, reviewer-verified). Each use re-reads them; a revoked family or a changed epoch ends the allowance (`login_ended`). The plan confirms the login-family id is reachable from a chat session. |
| Org merge | the merge ends and deletes the loser's allowance rows before sessions are repointed (§6.1) |
| Explicit revoke by the user or an org admin | ends (`revoked`) |
| Expiry or use cap | ends (`expired` / `exhausted`) |

#### 5.5.4 What the model sees

Nothing new. No tool reads or writes allowances, and the system prompt does not list them. This is not a security boundary (principle 6). Its purpose is only to avoid inviting the model to plan around relief.

#### 5.5.5 Visibility and revoke

- In chat: a header chip ("2 allowances active") opens a list with each scope, its time left and uses left, a Revoke button per row and **Revoke all**. Live updates come through new SSE events `allowance_created` / `allowance_ended`.
- **Pause is the one control that stops all relief** in a session: trust list, allowances and the existing card-free paths. Revoking an allowance ends only that allowance; a call it covered may still run without a card if the trust list covers it, and the revoke dialog says so when that applies.
- Routes: `GET /ai/sessions/:id/allowances`, `DELETE /ai/sessions/:id/allowances/:allowanceId` and `DELETE /ai/sessions/:id/allowances` (revoke all, which advances the generation). All require `requireMfa()` and the session owner. The web client wraps the mutations in `runAction`.
- Revocation is written to the database, so it holds whichever API process owns the session. A cross-process notification can make it faster but is not what makes it correct.
- An org admin with AI admin rights can list and revoke active allowances in the org. The plan decides where this lives; it is not a setting.

### 5.6 Per-tool trust list (configuration)

#### 5.6.1 Shape and home

The trust list is a set of explicit `tool:action@contractVersion` entries whose contract has `standingEligible: true`. There is no wildcard (finding 13): a software update never becomes a consent change. It is stored as `aiApprovals.trustedTools` with a revision number `aiApprovals.trustedToolsRevision`, in the existing settings blocks: `partners.settings.aiApprovals` (partner default) and `organizations.settings.aiApprovals` (org override). This is the block that already holds `interactiveTimeoutMinutes` (#6475), and it is edited on the same cards as the approval mode.

- **Home:** Partner settings → AI Approvals tab (`PartnerAiApprovalsTab.tsx`) and Org settings → AI tab, approvals section (`OrgSettingsPage.tsx`, next to `OrgAiApprovalTimeoutCard`).
- **Level:** partner default, org override.
- **Resolver:** one shared resolver, `resolveAiTrustedTools(partnerSettings, orgSettings, contracts)` in `@breeze/shared`, beside `resolveAiApprovalTimeout`, with one API loader shared with `getAiApprovalTimeout`. The gate, the settings UI and the effective-settings endpoint all use it.
- **Count of places the concept is configured:** AI approval behaviour is configured in 2 places today (the partner AI Approvals tab and the org AI approvals cards). After this feature it is still 2. The allowance list in chat is runtime state, not a setting, and is not counted.
- **Partner settings catalog:** a new entry `aiApprovals.trustedTools` (tab `aiApprovals`), so the inheritance badges and `InheritanceLine` work.

#### 5.6.2 Org may tighten, not loosen (recommended, §9 D2)

- Org field absent → inherit the partner list.
- Org field present (including `[]`) → effective = partner list ∩ org list.
- Org field malformed → effective = `[]`, logged, never the partner list.
- Always ∩ entries whose contract still exists at the stored version with `standingEligible: true`.

This is a stated exception to settings rule 3 ("org always wins"), and the UI says so where the field is edited: "Your provider allows these tools to run without a card. You can remove tools; you cannot add them." Precedents for a partner ceiling in the same area: `aiBudgets.approvalMode` locks the org; flow limits let the org only lower the partner value; the org model-defaults card is tighten-only.

#### 5.6.3 Write path

- **A dedicated endpoint**, `PUT /ai/approvals/trusted-tools` with `level: 'partner' | 'org'`, the new list, and the `trustedToolsRevision` the editor last read (409 on a stale revision). The org and partner wholesale settings writers strip and preserve `aiApprovals.trustedTools*` from their payloads, so an old editor or a stale tab cannot drop or restore the list (finding 16). Every writer of `settings.aiApprovals`, including the system-scope partner write, goes through one helper that enforces this.
- **Partner level** also requires `canManagePartnerWidePolicies(auth)` (`apps/api/src/services/partnerWideAccess.ts`), because the list relaxes approval for every org of the partner. **Org level** requires the org settings write permission. Both require `requireMfa()`.
- Validation refuses unknown tools, entries without an eligible contract, and wrong versions, and caps the list length.
- **Audit:** a structured `ai.approvals.trusted_tools.updated` event with level, old list, new list and revision. The existing settings audits record changed field names only, so they are not enough.
- Any write that narrows the list takes effect on the next consult: the gate reads the current revision on every consult and does not cache it.

#### 5.6.4 Aggregate bound

Trust is per tool, but harm can add up across many targets. Each session has a cap of trusted executions per pair (default 50 per session, the same idea as an allowance's use cap). Past it, the card returns for that pair in that session. This is a consent bound and is separate from the rate limits.

#### 5.6.5 Config-policy linkage: not adopted

Following the configuration-policy skill's decision guide: configuration policies resolve per **device** through assignments (device → group → site → org → partner). The trust list resolves per **session and org**. It has no compliance or remediation lifecycle and no standalone page; it is a set of knobs beside the approval mode. It is therefore an inline partner/org setting and not a config-policy feature link. Trust per site or per device group ("trust on lab devices only") would need configuration policies and is out of scope (§8).

### 5.7 Retry reuse (#3093)

**What #3093 actually was.** The re-issued calls in #3093 were narrower calls with *different* inputs: output was truncated, so the model drilled down. Reusing an approval for the same input would not have removed those cards; a `target` allowance might. Reuse is a small, separate kind of relief.

**Candidate rule.** One approval covers one re-execution of the same tool with the same canonical input digest (the `canonicalStringify` that `matchPlanStep` uses), within **2 minutes** of the approved attempt, **at most once**, and only when the earlier attempt is **known not to have taken effect**.

**What "known not to have taken effect" can honestly mean:**

| Kind of Tier 2 tool | Can "no effect" be known? | Reuse |
|---|---|---|
| A device command the dispatch seam refused before any command row existed (`CommandResult` / `refusal` / `delivery`, `apps/api/src/services/commandQueue.ts`, verified) | **Yes**, from a typed field the server sets, never from device output | possible |
| A device command delivered, `indeterminate`, or timed out after send | **No**: the agent may have run it | none |
| A call the gate refused after approval (authority changed, standing instruction) | Yes, but a retry hits the same refusal | none (no value) |
| A handler that writes only to the database in one transaction and threw | Only for a handler known to be single-transaction that threw before commit; not knowable in general | none |
| A handler that calls an external system (PSA, M365, vendor APIs) | **No** | none |

The "no effect" signal must come through a trusted channel that our dispatch code sets, for the same reason as the `handoff` field in `aiAgentSdkTools.ts`: a tool controls its own output, so output text can never be the signal. Reuse must also not become a third independent way to authorize: it runs through the same commit point and records its own method. Recommendation (§9 D6): measure it in shadow and ship nothing yet.

### 5.8 Session approval mode and Pause

1. **Remove the dead session-mode input.** The create-session schema in `routes/ai.ts` accepts `approvalMode`, and `createSession` spreads it into an insert on a table that has no such column. Keep accepting and ignoring it for one release so old clients do not get a 400, then drop it from the schema and from `apps/web/src/stores/aiStore.ts`. No migration is needed.
2. **Persist Pause** as `ai_sessions.paused_at timestamptz NULL` together with `ai_sessions.consent_generation integer NOT NULL DEFAULT 0`. Do not express Pause as a stored mode: Pause is stricter than `per_step` (§3.3).
   - The pause route writes both in one statement (setting `paused_at` and advancing the generation, which also ends every allowance) and no longer needs the session in local memory. The in-memory flag is updated when the session is local.
   - The gate reads `paused_at` and `consent_generation` at the relief commit point (§5.3) and when rebuilding a session. The existing card-free paths keep using the in-memory flag in v1; wave 2 moves them to the persisted value too, so a pause applied through another process also stops them.
   - Un-pause clears `paused_at` and does not restore anything.
   - Both are new columns on an org-cascade table, so each needs an export-policy classification (`included`).

### 5.9 Wait-budget exhaustion

1. When the Tier 2 bridge finds the budget spent, it publishes a new event, `approval_not_requested { executionId, toolName, label, reason }`. `reason` is `budget_spent`, `settled` (a new user message or an interrupt spent it on purpose) or `turn_limit`. The chat lists the skipped calls compactly under the turn ("Not asked: 2 actions — this turn's approval time ran out"). Only `budget_spent` shows an action.
2. The action is **"Continue"**. It sends a fixed, user-authored message through the normal message route, asking the assistant to continue. This is **not** a replay of the skipped calls: the model decides again what to call, and each call gets a fresh card or relief.
3. Nothing extends the budget inside an assistant message; that would break the invariant in §3.4. The budget resets at the next assistant `message_start`, whether that message follows the user's Continue or the model's own next step. The model can re-ask, as today. It can never skip a card.
4. The model-facing refusal text changes to say the call was not shown to the user and that the user can see it was skipped.

### 5.10 Relationship to `auto_approve`

Today `auto_approve` removes every Tier 2 card, whatever the effect. After review, this spec recommends **leaving it unchanged in this feature** (§9 D1). The shadow phase measures, for each `auto_approve` org, the calls that have no eligible contract (the calls that would get a card again under any consolidation). A later decision can migrate those orgs to explicit, versioned trust entries that preserve each org's effective policy. The first draft's live `"*"` wildcard is withdrawn.

### 5.11 Surfaces

| Surface | Allowances | Trust list |
|---|---|---|
| Web AI chat (sidebar, device task chat) | yes | yes |
| Wisp chat (under a Wisp grant; the ceiling runs first, and standing-instruction conflicts force a card) | yes | yes |
| Script builder chat (same gate, `user_session`) | yes | yes |
| Mobile approval screen | no third button in v1; it approves one call | n/a (no chat gate) |
| Excel client AI (synthetic portal-user context) | never | never |
| Helper (end-user) sessions | never (PAM governs) | never |
| Headless agent runs and Wisp specialists | never (they have their own allowlist model) | never |
| External MCP clients | never (there is no card to allow from) | not in this feature (§9 D3) |

## 6. Tenancy and data model impact

### 6.1 New table `ai_session_allowances`

Runtime consent for one chat session in one org. Shape 1 (a direct `org_id` column).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid NOT NULL → `organizations(id)` | the session org, which is also the resolved target's org (§5.2) |
| `session_id` | uuid NOT NULL | composite FK `(session_id, org_id) → ai_sessions(id, org_id)`, **`DEFERRABLE INITIALLY IMMEDIATE`**, `ON DELETE CASCADE` (`ai_sessions_id_org_uidx` exists, verified) |
| `user_id` | uuid NOT NULL → `users(id)` `ON DELETE CASCADE` | the approver; must equal `ai_sessions.user_id` (enforced in the creating transaction, and by a trigger if the plan finds no cheaper constraint) |
| `tool_name`, `action` | text NOT NULL, text NULL | |
| `contract_version` | integer NOT NULL | |
| `scope` | text NOT NULL CHECK in (`exact_call`, `target`) | |
| `target_kind`, `target_ref` | text NOT NULL, text NOT NULL | the resolved record; **no FK**, because there are several kinds |
| `args_digest` | text NULL | CHECK `(scope = 'exact_call') = (args_digest IS NOT NULL)` |
| `varying_keys` | text[] NULL | CHECK `(scope = 'target') = (varying_keys IS NOT NULL)` |
| `consent_generation` | integer NOT NULL | must equal the session's at creation |
| `login_family_id` | text NOT NULL; `auth_epoch`, `mfa_epoch` integer NOT NULL | §5.5.3 |
| `approval_mode_at_create` | `ai_approval_mode` NOT NULL | |
| `source_execution_id` | uuid NOT NULL → `ai_tool_executions(id)` `ON DELETE CASCADE` | must belong to `session_id` and must be the execution whose `pending → approved` CAS created it (same transaction) |
| `max_uses`, `use_count` | integer NOT NULL, CHECK `0 <= use_count AND use_count <= max_uses` | |
| `created_at`, `expires_at` | timestamptz NOT NULL, CHECK `expires_at > created_at` | |
| `ended_at`, `ended_reason`, `ended_by` | timestamptz NULL, text NULL CHECK in (the reasons of §5.5.3), uuid NULL → `users` `ON DELETE SET NULL` | |

Indexes: unique `(session_id, tool_name, coalesce(action,''), target_kind, target_ref) WHERE ended_at IS NULL` (at most one active allowance per scope); `(org_id, expires_at) WHERE ended_at IS NULL`. No `json`, `jsonb` or `bytea` columns, by design.

**Redemption.** Each relieved call's ledger row records the allowance id (or the trust revision) in the same transaction as the use claim (§5.3). The plan adds a nullable `relief_allowance_id` to `ai_tool_executions` (FK `ON DELETE SET NULL`), or records it only in the per-call audit channel from #11989 if that is enough. Either way, it checks how `ai_tool_executions` (which has no `org_id`; verified) is covered by the cascade and export registries.

**Why `org_id NOT NULL` and not org XOR partner.** This is runtime consent for one chat session, and a session belongs to exactly one org (`ai_sessions.org_id NOT NULL`, verified). It is not configuration, and a partner-wide row would have no meaning. The partner-wide-first rule applies to the trust list, which is configuration and stays partner default plus org override.

**Why `target_ref` has no FK and there is no `device_id` column.** Targets come in several kinds, and a `device_id` column would also bring the table into the device cascade and org-move disposition lists. Lifecycle is handled by the per-use resolver instead: a target that moves or is deleted ends the allowance (§5.5.3). It does not merely stop matching, so moving the target back revives nothing. The plan re-checks this choice against `moveOrg.coverage.test.ts` and `cascadeDelete.test.ts`, which key on `device_id`.

**Retention.** Ended rows are deleted 30 days after `ended_at` by an org-scoped retention job. The audit events (§7) are the durable history.

**Registrations (grep, do not judge):**

| List | Entry |
|---|---|
| RLS | enabled + forced + `breeze_has_org_access(org_id)` policy in the creating migration; shape 1 is discovered automatically by `rls-coverage.integration.test.ts`. Owner-only reads and writes are enforced in the app layer on top. |
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | `ai_session_allowances`, alphabetically before `ai_sessions` (child before parent) |
| `orgMergeRegistry.ts` | **`custom`**: the executor writes `ended` audit events and deletes the loser org's allowance rows before `ai_sessions` is repointed. Consent given in one org does not carry into another (finding 15). Not `repoint`, which the first draft proposed. |
| `CORE_TENANT_EXPORT_POLICY` | `included` for all columns except `args_digest` and `login_family_id` → `excludedSensitive` (`args_digest` hashes arguments that may include secrets; `login_family_id` is session-binding material) |
| `ai_sessions.paused_at`, `ai_sessions.consent_generation` (new columns, §5.8) | export policy `included` |

The migration follows `apps/api/migrations/README.md`: hand-written, idempotent, no inner `BEGIN`/`COMMIT`, named to sort after the newest committed migration (checked when it is written, not assumed), then `pnpm db:check-drift`. Background writes (expiry close-out, retention) use org-scoped system contexts. Any query that is caught and degraded to "show the card" runs inside `withDbTransaction` with the catch outside it (`docs/agents/tenancy-rls.md`).

### 6.2 Alternatives considered for allowance storage

| Option | For | Against |
|---|---|---|
| **Dedicated table (recommended)** | Revocable from any process and by an admin; atomic use claim with the ledger insert; joins with audit; ends with the session through the FK | about 6 registrations, a migration, and one indexed read plus one update on the card path |
| JSONB on `ai_sessions` | no new table | an `excludedOpen` blob; read-modify-write races on use counts; admin listing needs JSON queries |
| In memory on `ActiveSession` | no schema; a restart drops every allowance (fail closed) | invisible to admins and to audit joins; a revoke must reach the owning process; lost on eviction |

### 6.3 Trust-list storage

No table. The list is a key in the existing `partners.settings` / `organizations.settings` blocks, with the partner-axis read going through `readWithPartnerAxisVisibility` as `getAiApprovalTimeout` does. Those columns are already classified in the export policy, and the new key adds no column. The write rules in §5.6.3 make up for the shared wholesale writers.

## 7. Audit

This depends on #11989 (per-call approval attribution). Without it, two overlapping card-free calls could swap their recorded methods.

- **New `ApprovalMethod` values:** `session_allowance` and `trusted_tool`. Neither is in `DECIDED_APPROVAL_METHODS`, so `approved` stays `false`. It is `true` only when a person decided that specific call, which is unchanged.
- **Details on the `ai.tool.<name>` event:** `approvalMethod`, plus `allowanceId`, `allowanceScope` and `contractVersion` for an allowance, or `trustSource: 'partner' | 'org'`, the matched entry and `trustedToolsRevision` for the trust list.
- **Ledger row:** the `ai_tool_executions` row is inserted as `executing` at the commit point, as on the existing card-free paths.
- **Allowance lifecycle** (audit log, `resourceType: 'ai_session'`): `ai.approval_allowance.created` (source execution, scope, target id and org, contract version, expiry, cap) and `ai.approval_allowance.ended` (`ended_reason`, actor). Expiry and exhaustion are recorded when the gate first finds them, and at session close for any still open. No sweeper job is needed for correctness.
- **Approve route:** `ai.tool_approval.update` gains `allowance: true|false` and the allowance id.
- **Pause:** `ai.session.pause` gains the new consent generation and the number of allowances it ended.
- **Trust list:** `ai.approvals.trusted_tools.updated` with old and new lists (§5.6.3).
- **Wait-budget skips:** the ledger row keeps its `rejected` close-out. The new event is for the UI only.
- **Shadow mode:** a metric per Tier 2 card, not an audit event (§11).

## 8. Out of scope

- **Tier 3 and its step-up**, including #11974's Security-log reads, which resolve to Tier 3 or to Wisp unattended reads.
- Helper and PAM sessions, headless agent manifests and their allowlists, the Wisp grant ceiling, standing instructions.
- Re-tiering any tool. A wrong tier is fixed in `aiGuardrails.ts`, not relieved here.
- Trust per site or per device group (would need configuration policies).
- "Allow again" from the mobile app.
- Batching several different cards into one decision. Plan approval already covers multi-step work.
- Binding the **existing** card-free paths (`auto_approve`, read-only, Wisp self-state) to login revocation. This feature binds its own new paths only (§5.5.3, §9 D7).
- **The Agent SDK's classifier-based `auto` permission mode and its `canUseTool` layer.** Its built-in rules target coding and infrastructure risks. It is gated by model and provider and is not available on gateway connections. It cannot see our RBAC, tenancy or two-person rules, and the vendor documents it as not a safety guarantee. Our gate stays in the tool handlers, and #11817 pins an explicit `permissionMode` so the SDK never picks one for us. A classifier may be revisited later only as an extra signal to refuse or ask, never as an approver.

## 9. Open Decisions

Each has options, pros and cons, and one recommendation. Where the independent reviewer (§10) disagreed with the brief or with my first draft, both positions are stated.

### D1. What happens to `auto_approve`?

- **A. Leave it unchanged in this feature.** Allowances and the trust list matter only under `per_step` and the plan modes. *Pro:* no behaviour change and no migration while relief is new. *Con:* two overlapping relief ideas for a while, and `auto_approve` keeps relieving pairs that have no contract.
- **B. Redefine it as "trust every eligible pair".** *Pro:* relief means one thing. *Con:* stricter for `auto_approve` orgs, which get more cards on upgrade.
- **C. Deprecate it in favour of the list**, migrating each org to explicit, versioned trust entries that preserve its effective policy. *Pro:* one concept, one home. *Con:* the tightening of B, plus a data migration that must respect D2's partner ceiling without widening sibling orgs.

*Brief and first draft:* C, staged after shadow, through a live `"*"` entry. *Reviewer:* disagrees with C as specified. The wildcard turns software updates into consent changes, and inserting org entries conflicts with the partner intersection. The reviewer recommends deferring.
**Recommend A now, and C as a separate later decision** using explicit, versioned entries and no wildcard, informed by the shadow count of calls with no contract per `auto_approve` org.

### D2. Can an org loosen the partner's trust list?

- **A. Org wins** (settings rule 3). *Pro:* consistent with most settings. *Con:* an org admin can relax approval beyond what the MSP chose.
- **B. Tighten-only** (partner ∩ org; absent = inherit; `[]` = none; malformed = none). *Pro:* the MSP keeps the ceiling, matching the approval-mode lock and flow-limit precedents. *Con:* an org cannot trust a tool its partner has not trusted, and this is a stated exception to rule 3.

**Recommend B** (the reviewer agrees), with the exception stated in the UI.

### D3. Does the trust list govern Tier 2 calls from external MCP clients?

MCP Tier 2 calls already have no per-call approval (key scopes and domain grants decide). Applying the trust list there would be a **tightening**: untrusted Tier 2 tools refused or filed as intents. That is a behaviour change for existing integrations.

- **A. No.** MCP stays governed by key scopes and domain grants. *Pro:* nothing breaks, and the list stays a chat-card concept. *Con:* two models for the same tool.
- **B. Yes, as a ceiling.** *Pro:* one org-level statement of what runs without a person. *Con:* breaks integrations, and MCP has no card to fall back to.

**Recommend A** (the reviewer agrees), and file a follow-up to evaluate a per-key Tier 2 allowlist if MCP Tier 2 volume warrants it.

### D4. Allowance duration and use cap

- **A. Fixed: 30 minutes, 20 later uses, one active allowance per scope.** *Pro:* simple and predictable card text. *Con:* one size for everyone.
- **B. The user picks on the card (15 / 30 / 60 min).** *Pro:* flexible. *Con:* more card UI and more to read at decision time.
- **C. The partner sets a maximum.** *Pro:* MSP control. *Con:* another setting.

**Recommend A** (the reviewer agrees, noting that the values bound consent and not effect; §5.5.2 now says the approving call does not count, overlapping allowances cannot multiply the cap, and renewal is an explicit card decision). Revisit with usage data.

### D5. Session approval mode and Pause

- **A. Wire a session-level mode as tighten-only and persist Pause as that mode.** *Con:* there is no session column to wire (verified, §3.3), and Pause is stricter than `per_step`, so it would lose its meaning.
- **B. Remove the dead input; persist Pause as `paused_at` plus a consent generation**, read at the relief commit point (and, from wave 2, by every card-free path). *Pro:* no unused field; Pause survives eviction and restarts and works across processes. *Con:* the existing card-free paths need a persisted read too.

*Brief:* wire as tighten-only and persist Pause as the stored mode, or remove the field. *Reviewer:* agrees with B's direction, corrected the first draft's claim that a session column existed, and added the generation counter and cross-process enforcement.
**Recommend B.**

### D6. Retry reuse

- **A. Ship the narrow case:** a device dispatch refused before any command row existed; within 2 minutes; once.
- **B. Defer:** measure same-digest retries after a known-no-effect outcome in shadow, and decide then.
- **C. Drop it:** allowances cover repeats.

**Recommend B** (the reviewer agrees). #3093's own repeats had different inputs, so same-digest reuse would not have helped there.

### D7. Login binding

- **A. Bind allowances and trust-list executions to the login** (family plus auth and MFA epochs), checked on every use. *Pro:* signing out stops new relief. *Con:* the plan must make the login family reachable from a chat session.
- **B. Bind allowances only.** Trust-list executions follow the existing card-free paths, which are not login-bound today. *Pro:* consistent with `auto_approve` and read-only behaviour. *Con:* the trust list would be another way for a running chat to keep acting after sign-out.

*Reviewer (finding 10):* a running chat should not keep using relief after sign-out. It raised the trust-list question as open.
**Recommend A** for both new relief paths. File a follow-up for the existing card-free paths (out of scope here).

### D8. First-release scope

- **A. Brief and first draft:** allowances with both `exact_call` and `target` scopes, plus the trust list, in the first release.
- **B. Reviewer's cut list:** first ship persistent Pause and skipped-approval visibility. Then ship `exact_call` allowances only, for a small set of pairs shown to be useful and safe to repeat. Ship `target` scope (arguments that vary) and the trust list later, once each pair passes the effect-contract review and shadow shows demand.
- **C. Middle:** like B, but `target` scope ships with the allowances for any pair whose contract is `enum_keys` and passes review.

*Pro of A:* the most card relief soonest. *Con of A:* it adds org-wide authority, inheritance, migration and revocation semantics before session consent has been proven. *Pro of B:* the smallest new authority, and each step is measured. *Con of B:* the trust list, which the issue asks for, lands last.
**Recommend B.** The wave list in §12 follows B. The trust list stays fully specified here so that its later wave is a scheduling decision and not a design one.

## 10. Advisor quorum

**Reviewer:** Codex CLI (`gpt-6-astra`, `model_reasoning_effort=xhigh`, sandbox `read-only`), run in the foreground with stdin closed against this spec's first draft on `ce8d1e5551`. It was asked to attack the design: unintended authorization, confused deputies and prompt injection, tenancy, races and lifecycle, the classification abstraction, D1–D6, and what to cut. Its verdict was "revise before implementation". I spot-checked its factual claims: the missing `ai_sessions.approval_mode` column, the PSA note on acknowledge, the auth and MFA epochs, the `waitForApproval` timeout close-out, and the timer auto-stop.

**Where it agreed:**

- the placement of relief after every existing check and the dependency on #11989 (finding 1);
- the tenancy shape: direct `org_id`, forced RLS, a deferrable composite FK to the session, cascade and export registration (finding 14, first half);
- D2 (tighten-only), D3 (no MCP), D4 (fixed values), D6 (defer reuse) and the direction of D5.

**Where it disagreed, and what changed (folded in):**

| # | Reviewer finding | Change in this spec |
|---|---|---|
| 2 | `resolveIntentTarget` covers Tier 3 and may fall back to the session org, so it cannot prove a Tier 2 call is in the same org | dedicated authoritative resolvers per contract; a fallback never counts (§5.2) |
| 3, 4 | both example pairs have effects the draft missed (timer: invoice text, auto-stop of another ticket's timer; alert acknowledge: PSA note) | the examples are withdrawn; downstream effects are part of every contract (§5.1) |
| 5 | prompt injection can steer allowed calls without failing any check; hiding allowances is not a boundary | principle 6; relief must be safe under adversarial arguments and repetition; aggregate cap for trust (§4, §5.6.4) |
| 6 | one ladder folds together independent properties; a pinned snapshot misses handler changes | effect contracts with versions (§5.1) |
| 7 | the offer needs a stable id, the org and revalidation | offer shows org, target id and varying keys; revalidated at offer, create and use (§5.4) |
| 8 | counting uses is not authorizing them; the column name was inconsistent; overlapping allowances multiply the cap | commit point; one active allowance per scope; failed dispatches count (§5.3, §6.1) |
| 9 | Pause needs a consent generation | `consent_generation` (§5.8, principle 5) |
| 10 | sign-out must end relief | login binding (§5.5.3, D7) |
| 11 | approve-and-allow against timeout | CAS-only transitions; the allowance only comes from the winning transition (§5.4) |
| 12 | revocation semantics are ambiguous across sources; a 30 s cache delays removal | Pause stops all relief; revoke text states its scope; no cache (§5.5.5, §5.6.3) |
| 13 | a `"*"` wildcard turns software updates into consent changes | wildcard withdrawn; explicit versioned entries (§5.6.1, D1) |
| 14 | relational integrity: owner, source execution, redemption | constraints and a same-transaction claim (§6.1) |
| 15 | repointing allowances on merge carries consent across tenants | `custom` merge policy that ends and deletes them (§6.1) |
| 16 | the wholesale settings writers can drop or restore the list; settings audits lack old and new values | dedicated revision-checked endpoint; writers preserve the key; structured audit (§5.6.3) |
| 17 | the session approval-mode column does not exist | D5 and §5.8 rewritten against the code |
| 18 | the tests need adversarial and concurrency cases; the "Ask again" wording implied a replay; the budget resets at every assistant message | tests extended (§11.4); §5.9 rewritten |
| D1 | disagrees with C as drafted | recommendation changed to A now, C later (D1) |
| cut list | ship Pause and skip visibility first, then `exact_call` only; trust list later; no wildcard; no reuse | D8, recommended; waves follow it (§12) |

**Disagreements left open for the product owner** (both positions recorded): D1 (the brief's fold-in vs the reviewer's deferral), D5 (the brief's "persist Pause as the stored mode" vs a separate column plus generation), D7 (whether trust-list executions are bound to the login), D8 (the brief's full first release vs the reviewer's staged cut).

## 11. Test and rollout notes

### 11.1 Flag

`AI_APPROVAL_RELIEF` = `off | shadow | on`, env-level, default `off`. In `shadow` the trust-list setting can be edited and is labelled "Recorded only — not yet applied".

### 11.2 Shadow phase

For every Tier 2 card that §5.3's preconditions would allow, record a metric. There is no audit row and no database write on the hot path. Each record has the tool, action, contract (if any), whether the effective trust list would have matched, and whether an `exact_call` or `target` allowance made at an earlier **approved** card in the same session within 30 minutes would have matched. That second answer can be computed from the session's own approved cards. Also record, for `auto_approve` orgs, the calls with no eligible contract (input for D1), and same-digest re-executions after a known-no-effect outcome (input for D6).

### 11.3 Measures

- Cards per session (p50, p90) and per tool.
- Approval wait time per card (p50, p90) and cards that expired unanswered.
- Cards that would have been replaced (shadow) vs cards replaced (on), by method.
- Allowances created, uses per allowance, and the share ending `exhausted`, `expired`, `revoked`, `authority_changed`, `target_changed` and `login_ended`.
- Revokes within 5 minutes of creation (a sign the card text misled the user).
- Live re-check refusals on relieved calls.
- `approval_not_requested` events by reason.

### 11.4 New contract, unit and integration tests

1. **`aiApprovalRelief.effectContracts.contract.test.ts`** (no mocks, real tables, in the style of `aiGuardrails.readonly.contract.test.ts` and `wisp/selfStateTools.contract.test.ts`):
   - every key is a real Tier 2 (tool, action) pair: base Tier 2 in `TOOL_TIERS`, or listed in `TIER2_ACTIONS`;
   - no key is in `TIER2_READONLY_*`, `TIER3_ACTIONS`, `TIER3_INPUT_AWARE_ACTIONS` or a human-only set;
   - an unlisted Tier 2 pair has no contract, and the gate shows the card for it;
   - each `target.inputKey` exists in the tool's input schema as a single id, and a device target appears in `AiTool.deviceArgs`;
   - each `enum_keys` key is a closed enum in the schema, and none of them is in `TIER_DECIDING_INPUT_KEYS` for the tool;
   - the map, including the versions, equals a pinned snapshot. A handler change that alters effects must bump `contractVersion`, and the PR template asks for it (a snapshot alone cannot detect a new side effect; finding 6).
2. **Gate-order tests** on `createGatedSessionPreToolUse`: with a matching allowance or trust entry present, the call still refuses for each earlier refusal (allowlist, Wisp ceiling, schema, Tier 3 escalation, RBAC, rate limit, `validateBeforeFiling`, standing-instruction deny). Relief is never consulted for a helper session, a paused session, an in-flight plan, a standing-instruction warning, a tenant or flow tool, a non-`user_session` principal, or a target that resolves to another org or fails to resolve. A failed live re-check refuses.
3. **Adversarial tests** (finding 18): an argument outside `varying_keys` changes and gets a card; an `exact_call` with one changed argument gets a card; a target moved during the approval wait gets no allowance; a target moved after creation ends it and does not come back after moving back; a cross-org target in a partner session gets a card.
4. **Concurrency and lifecycle tests** (real Postgres): parallel siblings cannot exceed the cap; Pause or Revoke all against a concurrent claim (the pause wins if it commits first, and no new allowance is created from an old offer); approve-and-allow against a timeout (exactly one outcome); duplicate approve requests; a mode change A→B→A; sign-out and epoch changes; contract version bumps; a stale-revision trust-list write gets 409; a wholesale settings write keeps the list; a malformed org list resolves to `[]`.
5. **Tenancy (Integration Tests job):** an RLS forge for `ai_session_allowances` (42501); the cascade order, merge registry (the custom executor ends and deletes) and export policy suites; export classification for `ai_sessions.paused_at` and `consent_generation`.
6. **Audit:** the new methods record `approved: false` with the right details; lifecycle and trust-list events are written with old and new values.
7. **`aiApprovalRelief.imports.contract.test.ts`:** `routes/mcpServer.ts`, the headless agent runtime and the helper paths never import the allowance or trust modules.

Existing contracts that must stay green without change: `aiGuardrails.readonly.contract`, `approvalScope.contract`, `tierDecidingKeys.contract`, `routeParity.contract`, `wisp/selfStateTools.contract`.

### 11.5 Rollout

off → shadow (2 weeks; read the measures) → on for internal orgs → on. Each later wave (target scope, trust list, D1, D6) starts only after its shadow numbers have been read.

## 12. Suggested waves (rough; the wave plan is a later stage)

Following D8's recommendation (B). If D8 is decided otherwise, waves 4 and 5 merge into 3.

0. Prerequisite: #11989 (per-call approval attribution).
1. Persistent Pause and consent generation (`paused_at`, `consent_generation`; the pause route works across processes); remove the dead session-mode input; `approval_not_requested` event and Continue; CAS-only timeout close-out in `waitForApproval`.
2. Effect-contract module and contract test (it may start with few entries); `ApprovalMethod` values; the flag; shadow metrics; every card-free path reads the persisted pause.
3. `exact_call` allowances: migration and registrations, authoritative resolvers for the first pairs, gate consult and commit point, approve-route extension, revoke routes, login binding, audit lifecycle, and the web card button with the active-allowance chip and list (i18n in all 8 locales).
4. `target` scope for reviewed `enum_keys` pairs, once shadow shows demand.
5. Trust list: shared resolver, catalog entry, dedicated revision-checked endpoint, partner and org cards, aggregate cap, gate consult.
6. D1 (`auto_approve` consolidation) and D6 (retry reuse), as separate decisions after shadow.
