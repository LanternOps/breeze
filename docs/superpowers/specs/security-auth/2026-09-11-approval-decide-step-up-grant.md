---
issue: LanternOps/breeze#5601
status: implemented
date: 2026-09-11
related:
  - docs/superpowers/specs/security-auth/2026-06-14-breeze-authenticator-step-up-approvals-design.md
  - docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
  - LanternOps/breeze#5600
---

# Reusable "recent ceremony" step-up grant for consecutive approval decides

## Problem

Approving several Tier-3 AI chat tool calls in a row costs one full passkey
ceremony per approval row (three in 20 seconds, observed on US prod
2026-09-11). #5600 removes the ceremony for *supervised* rows under a
*non-enforcing* partner, at the cost of dropping those rows to L1 /
`session_tap`. This spec covers the one supervised case #5600 deliberately
does not: **supervised** rows under an **enforcing** partner policy, where
the step-up floor must not be bypassed.

There, the ceremony stays *required* — but a ceremony the operator already
completed seconds ago, for the same conversation, the same org and the same
risk tier, should be reusable inside a bounded window instead of re-prompted
per row.

## Decision (Todd, 2026-09-11)

The first draft also covered **four_eyes** sole-operator self-approve. Todd
chose to narrow it (options "C with B" from the hand-off):

- **Supervised rows only.** four_eyes is the high-trust path — restores and
  DR, remote control, tenant deletion, identity actions, billing, rollbacks
  — and keeps its per-approval passkey. A four_eyes row never mints a grant
  and never redeems one; a grant presented there is refused with
  `403 step_up_required`, so the client falls back to a real ceremony. This
  is enforced twice: in the decide core (`resolveGrantScope` returns null for
  any scope but `supervised`, before the grant module is consulted) and in
  the grant module (`isApprovalDecideGrantEligible`, plus `approvalScope` in
  the digest).
- **120 s window**, not the 300 s every single-use step-up operation keeps.
  A per-operation TTL in `services/mfaStepUpGrant.ts`; the approvals module
  derives its age bound from it so the two numbers cannot drift.

Why: the one accepted cost of this credential is that a live stolen access
token plus a leaked grant id can repeat a decide inside the window. Confining
the grant to supervised rows confines that exposure to approvals which, under
a non-enforcing partner, #5600 already lets through with no ceremony at all —
so the grant never adds capability that the supervised scope does not already
concede, and four_eyes is untouched. Shortening the window halves what is
left.

The house position rejects a bare wall-clock grace window
(`plans/security-auth/2026-09-02-mobile-platform-attestation-l4.md`: "A dated
grace window is rejected outright"). This design is therefore not a grace
window: it is a **credential** — minted only by a real ceremony, bound to
identity, session, factor epochs and a resource digest, stored server-side,
and recorded distinctly in audit.

## Non-goals

- No grant for **four_eyes** rows, in either direction (see the decision
  above). four_eyes keeps its per-approval passkey ceremony.
- No new wall-clock leniency for **L4 / critical**. See "L4 is excluded".
- No TTL cache inside `decideApprovalRequest` (issue's explicit constraint) —
  everything goes through the grant service.
- No new DB column and no migration. The reuse signal rides the existing
  `action_intent` audit event `details`, which is the surface #5600 measured
  on production.

## Design

### Grant minting point

A new `StepUpOperation`, **`approval_decide`**, is minted inside
`decideApprovalRequest` after the whole decide transaction has resolved and
after the `lostRace` early return — i.e. after
`decideApprovalRequest.ts:1117`, not at the approval-row `UPDATE ...
RETURNING` (which is still inside the surrounding system-context transaction
and can roll back). A decide that lost the race, 403'd, or rolled back must
never leave a reusable credential behind. Mint conditions, all required:

1. `status === 'approved'` (a deny never runs the ladder and never mints).
2. The row has a **linked action intent** (`linkedIntent`) — the grant's
   digest is derived from intent fields, so an unlinked PAM / dev-seed row is
   out of scope.
3. The ladder actually ran and produced a **genuine ceremony** —
   `assurance.decidedVia !== 'session_tap'` and `decidedAssuranceLevel >= 3`.
   An L1 session tap, an L2-only proof, a `skipAssuranceLadder` supervised
   decide, and a decide that itself redeemed a grant all mint nothing. (The
   last of those is what keeps the window from ratcheting forward
   indefinitely — see "TTL and non-extension".)
4. `riskTier !== 'critical'` (see "L4 is excluded").
5. The intent is **grant-eligible**: `approvalScope === 'supervised'` AND at
   least one of `agentRunId` / `aiSessionId` is non-null (see the digest
   section). A four_eyes row is refused in the core before the conversation
   lookup even runs.
6. The linked-intent CAS was **won** (`wonIntent`). The approval-row CAS and
   the intent CAS are separate outcomes and the core deliberately returns
   success when the row commits but the intent CAS loses to another approver
   (`decideApprovalRequest.ts:1031`). Requiring `wonIntent` is what actually
   makes the spec's "a decide that lost a race never mints" promise true;
   Codex review, finding 5. The cost of the stricter rule is one extra
   ceremony in a rare race.

The mint is best-effort: `mintStepUpGrant` already fails closed to `null` on
a Redis fault, and a missing grant only costs the operator another ceremony.
A mint failure must never fail an approval that already committed.

The grant id is returned to the client in the decide response body as
`stepUpGrantId`.

The **batch** decide path (`preverifiedAssurance`) neither mints nor redeems.
It already amortises one ceremony across N rows by a different mechanism;
layering a second one on it would widen blast radius for no user-visible
gain.

### Acceptance (redeem) path

`DecideApprovalInput` gains `stepUpGrantId?: string`. When present, and the
request carries **no `proof`**, `decideApprovalRequest` redeems it *in place
of* running the assertion ladder:

- A request carrying **both** a `proof` and a `stepUpGrantId` runs the real
  ladder and ignores the grant. A presented proof is always verified (this is
  the #5600 fix-round-2 invariant: a presented-but-invalid proof is a 401,
  never a silent downgrade).
- A grant presented on a **four_eyes** row is refused outright — the core
  never consults the grant module for a non-supervised scope — and answers
  the same `403 step_up_required`, so the client runs the ceremony four_eyes
  always required.
- A **failed** redeem (expired, wrong binding, wrong digest, revoked
  approver device, ineligible intent, critical tier, Redis down) does **not**
  fall through to an L1 session tap. It answers
  `403 { error: 'step_up_required', requiredLevel }` — the same token the
  client already handles — so the client re-runs a fresh ceremony. Failing
  open here would convert an expired credential into a silent assurance
  downgrade, which is exactly what this design exists to prevent.
- A presented `stepUpGrantId` **disables `skipAssuranceLadder`**, exactly as a
  presented `proof` already does. Without this, a supervised row under a
  non-enforcing partner that presented a *bad* grant would take the
  `skipAssuranceLadder` shortcut (`decideApprovalRequest.ts:739`) and succeed
  at L1 — silently ignoring precisely the bad credential the rule above
  promises to reject. Codex review, finding 4.
- Redeem re-reads the grant's `authenticatorDeviceId` and requires the device
  row to still be present, owned by the redeeming user, and un-disabled.
- The redeem path and the fresh-proof path converge **before** the
  sole-operator gate, so the gate is shared rather than duplicated. Adding
  redemption as a sibling `else if` would route around the gate, which lives
  inside the ladder's `else` block today (`decideApprovalRequest.ts:787`).
  Codex review, finding 8.

### Multi-use within the TTL

Unlike every other step-up operation, `approval_decide` is redeemed with the
**non-consuming** `validateStepUpGrant` (`GET`), not `consumeStepUpGrant`
(`GETDEL`). That is the whole point: N approval rows, one ceremony.

This is a deliberate deviation from the single-use rule, and it is safe only
because the other bounds are tight: the grant exists for supervised rows
only, is worthless outside its `{userId, authEpoch, mfaEpoch, sid}` binding,
worthless outside its `resourceDigest` (one conversation + one org + one
risk tier + the supervised scope), and worthless after 120 s. It authorises *repetition of a decision the operator is already
authorised to make*, never a widening of what they may decide — every other
gate in `decideApprovalRequest` (human-principal assertion, row
pending/expiry, live authorization, digest binding,
`isAgentIntentDecideAuthorized`, sole-operator re-derivation, CAS) still runs
per row, unchanged.

### `resourceDigest` binding

```
sha256(JSON.stringify({
  agentRunId:    linkedIntent.requestingAgentRunId ?? null,
  aiSessionId:   <ai_tool_executions.session_id for this intent> ?? null,
  approvalScope: linkedIntent.approvalScope,   // always 'supervised' — see below
  orgId:         linkedIntent.orgId,
  riskTier:      existing.riskTier,
}))
```

**Eligibility preconditions:** `approvalScope` MUST be `'supervised'`, and at
least one of `agentRunId` / `aiSessionId` MUST be non-null, or the row is not
grant-eligible at all (no mint, and a presented grant is refused). The scope
is pinned in the digest as well as checked, so a grant could not cross scopes
even if the eligibility check were ever loosened. See the Codex review, finding 1 — without this
precondition the digest has a catch-all "neither" bucket that every
conversation in an org would share.

Keys are emitted alphabetically for the same reason
`maintenanceResourceDigest` does it: `JSON.stringify` preserves insertion
order, so two equivalent objects could otherwise hash differently. Both the
mint and the redeem call the one exported helper, so mint and redeem cannot
drift.

**Blast-radius argument.** Each component removes a distinct escalation:

- **`aiSessionId` + `agentRunId` (the conversation scope)** — the operator's
  "I am supervising *this* conversation" judgement. Without it, a ceremony
  performed for a chat the operator is actively watching would cover a Tier-3
  request raised 4 minutes later by a *different* conversation — including a
  scheduled or background run the operator never looked at. This is the single
  most important component: the human's attention is scoped to a conversation,
  so the credential must be too.

  **Both fields are needed, and this is the correction Codex forced.** An
  agent-originated intent carries `requestingAgentRunId`
  (`intentService.ts:1598`, populated only when the principal is `ai_agent`).
  But the flow that motivates this whole issue — web AI chat — calls
  `createActionIntent(session.auth, { source: 'chat', ... })`
  (`aiAgentSdk.ts:1193`) with the *human's* auth, so `agentRun` stays null and
  `requestingAgentRunId` is null. Scoping on `agentRunId` alone would have put
  every chat approval in one org into a single shared bucket — the conversation
  binding would have been decorative for exactly the case it exists to bound.
  `aiSessionId` is read from the `ai_tool_executions` row stamped with this
  intent (`aiAgentSdk.ts` stamps `intentId` onto the execution; the execution
  carries `session_id`), which is the authoritative conversation identifier for
  a chat-originated intent.
- **`orgId`** — the tenancy boundary. An MSP technician approving for Org A
  must never have that ceremony silently cover Org B's Tier-3 action. This is
  also the one the issue called out explicitly.
- **`riskTier`** — the severity boundary. `requiredAssurance` is a function
  of the tier, so a grant minted at the level a `high` row demanded must not
  be presentable against a `critical` row (which demands more) nor be
  conflated with a `low` row (whose ceremony proves less). Including the tier
  makes the achieved-vs-required comparison an identity rather than an
  inequality that could drift.

An intent with **neither** identifier (a non-AI, non-chat intent raised
through some other surface) is simply not grant-eligible. That is the
eligibility precondition above, and it is the whole answer to the "catch-all
null bucket" objection: rather than reasoning about how wide the neither-bucket
is, there is no neither-bucket.

Notably **not** in the digest: the approval id and the argument digest.
Including either would make the grant single-row by construction and defeat
the feature. The per-row `boundArgumentDigest` check in the decide core is
what keeps *content* binding intact; the grant binds *authority to decide*,
not *what was decided*.

### Identity / session binding and invalidation

The existing `{userId, operation, authEpoch, mfaEpoch, sid}` bind is kept
verbatim, so the grant dies on:

- **`authEpoch`** bump — password change, forced logout, session-family
  revocation.
- **`mfaEpoch`** bump — any factor add/remove/rotate. Losing or re-enrolling
  the passkey that minted the grant invalidates it.
- **`sid`** change — a different refresh family (another browser, another tab
  that re-authenticated) cannot present it.

**Honest limits of the `sid` bind (Codex review, finding 2).** `sid` is a
refresh-family identifier carried in the access token (`jwt.ts:226`), not a
device or browser binding. An attacker who has stolen a live access token
presents the same `sid`, so within the window such a token plus a leaked grant
id can clear the enforcing-partner L3 floor on a supervised row without the
passkey. This is the real cost of the feature and is accepted because: the
grant is confined to supervised rows, which under a non-enforcing partner
#5600 already approves with no ceremony at all, and four_eyes — where a
stolen token is today stopped cold by the L3 requirement — never mints or
redeems one; the grant id is never logged and is returned only to the session
that earned it; the window is 120 s and does not slide; the digest confines
it to one conversation, org and tier; the approver device must still be live
(below); and L4 is excluded entirely. An earlier draft of this spec claimed a
stolen token could not present the grant — that claim was false and has been
removed rather than softened.

**Approver-device revocation (Codex review, finding 3).** Disabling an
approver device sets `disabled_at` without bumping `authEpoch` or `mfaEpoch`
(`routes/authenticator.ts:758`), so the epoch binds alone do NOT invalidate a
grant minted by a device that has since been revoked — while a *fresh*
assertion would be refused (`authenticatorAssurance.ts:399` requires
`isNull(disabledAt)`). Redeeming therefore re-reads the grant's recorded
`authenticatorDeviceId` and requires the row to still exist, still belong to
the redeeming user, and still be un-disabled. Without this, revoking a lost
laptop's passkey would leave up to 120 s of continued L3 approvals.
- **TTL** — 120 s, Redis key expiry.

Redis being unreachable fails closed in both directions (`mintStepUpGrant`
returns `null`; `validateStepUpGrant` returns `false`).

### TTL and non-extension

TTL is **120 s** for this operation (Todd, 2026-09-11), set as a
per-operation override in `services/mfaStepUpGrant.ts`
(`OPERATION_TTL_SECONDS`, read through `stepUpGrantTtlSeconds`); every
single-use operation keeps the 300 s default. `APPROVAL_DECIDE_GRANT_TTL_MS`
in the approvals module is *derived* from that function rather than
re-declared, so the Redis expiry and the explicit age bound cannot drift.
Deliberately **not** a partner policy knob in this change — a knob is only
worth its configuration surface once someone asks for a different number,
and shipping it now would mean shipping an untested policy path on an auth
surface.

The recorded `ceremonyAt` (not the Redis `SETEX` moment) is the clock. Redis
starts its TTL when it receives the write, which is after the ceremony and
after the decide transaction, so TTL alone would measure "120 s since mint"
rather than "120 s since the human touched the sensor". The grant context
therefore records `ceremonyAt` and the redeem re-asserts the absolute age
bound explicitly — the same belt-and-braces shape
`escalateAchievedLevel` already uses for `APPROVAL_CHALLENGE_TTL_MS`
(`authenticatorAssurance.ts:340`). Redis expiry remains the backstop. Codex
review, finding 6.

The window does **not** slide. Because mint condition 3 requires a genuine
ceremony, a decide that redeemed a grant mints nothing, so a burst of
approvals cannot ratchet the credential forward. 120 s after the one real
ceremony, the operator does another one. This is what keeps the mechanism a
bounded credential rather than a renewable session.

### Partner policy still enforced on redeem

Redeeming does not skip the partner floor. On the redeem path the core still
loads the partner policy and computes
`requiredAssurance(riskTier, policy.floorOverrides)`. If the grant's recorded
level is below that floor and the policy is enforcing, the redeem answers
`403 step_up_required` with the required level. A partner that raises its
floor mid-window therefore invalidates outstanding grants in effect, without
needing to reach into Redis. Under a non-enforcing policy an under-assured
redeem sets `graceDowngrade` exactly as the ladder would.

This is the whole use case: a supervised row under an **enforcing** partner.
The enforcing policy is what forces the ceremony in the first place
(`isPartnerEnforcingForSupervised` disables `skipAssuranceLadder`), and the
grant satisfies that same floor on subsequent rows instead of re-prompting.
Under a non-enforcing partner a supervised row never runs the ladder, so no
grant is ever minted there — and none is needed, #5600 already approves it
on a plain click.

### L4 is excluded

`approval_decide` grants are never minted for, nor redeemed against, a
`critical` (L4) row. L4 requires a *fresh account re-authentication* at the
decide surface (`ReauthRequiredError`) on top of a platform-bound key; its
entire meaning is "the human proved themselves again, just now, for this
one". A reusable credential is incompatible with that claim, and asserting L4
from a 4-minute-old grant would be exactly the audit dishonesty this spec
forbids. Enforced twice: the tier is in the digest (so a `high` grant cannot
match a `critical` row) *and* both the mint and the redeem refuse
`riskTier === 'critical'` outright.

### Audit honesty

A row decided on an inherited grant keeps the honest achieved level, factor
and device id from the ceremony that minted it — those are facts about a
ceremony that really happened. What must never be implied is that a *second*
ceremony happened. So:

- `AssuranceDecisionShared` gains `stepUpGrantReuse?: boolean`, set only on
  the redeem path (alongside the existing post-build-mutable
  `graceDowngrade`).
- **`approval_requests.decided_via_step_up_grant`** (new boolean column,
  `NOT NULL DEFAULT false`) is written in the SAME transaction as
  `decided_assurance_level` / `decided_via`. This is the durable record.
- The `action_intent` decide event `details` also gains
  `assuranceSource: 'step_up_grant'` on a redeemed row. A fresh ceremony
  emits no such key, so existing rows and dashboards are unchanged and
  "reused" is never the default reading of a missing field.

The column exists because of Codex review finding 7: the audit *event* is
emitted after the transaction, only when `wonIntent` is true, through a
fire-and-forget writer with an in-memory retry queue that can drop entries
(`auditEvents.ts:111`). A committed reused-L3 decision could therefore survive
with no distinguishing marker at all — which is precisely the "claims a
ceremony that did not happen" failure this section forbids. The event detail
is a convenience for dashboards; the column is the guarantee.

`approval_requests` has **no `org_id`** and appears in neither
`CORE_ORG_CASCADE_DELETE_ORDER` nor `CORE_TENANT_EXPORT_POLICY` (verified by
grep), so this `ADD COLUMN` carries no cascade or export-policy registration
obligation. Migration is idempotent (`ADD COLUMN IF NOT EXISTS`) and writes no
rows, so it needs no `breeze.scope` elevation.

Concretely: the prod query that found "three `webauthn_platform` L3 rows in
20 seconds" will now find one row with no `assuranceSource` and two with
`assuranceSource: 'step_up_grant'` — the same assurance claim, with the
number of real ceremonies recoverable.

To carry level / factor / device id across the window, the grant record
stores them in a `context` field written at mint and read at redeem. `context`
is deliberately **excluded from `bindsMatch`** — it is payload the server
wrote to itself, not part of what the caller must match — and is only ever
populated by the server.

### four_eyes sole-operator gate

Untouched, and four_eyes never reaches the redeem branch at all: a
four_eyes decide that presents a grant is refused in the core before the
grant module is consulted, and a four_eyes ceremony mints nothing. four_eyes
therefore still requires a fresh proof on every approval, exactly as on
`main`.

The same sole-operator gate (`linkedIntent && status === 'approved' &&
requestedByUserId === userId && (!isSupervisedSelfDecide ||
isPartnerEnforcingForSupervised)` → require level ≥ 3) also applies to a
supervised self-decide under an enforcing partner, and it runs on the redeem
path too, reading the grant's recorded level. Since a grant is only minted at
level ≥ 3, a valid redeem passes it and an invalid redeem never reaches it
(it 403s earlier). An enforcing-partner supervised row therefore still
requires "a grant or a proof", and never falls below L3.

### `approval_decide` is not client-requestable

`POST /auth/mfa/step-up` mints a grant for a client-chosen operation, narrowed
by `STEP_UP_OPERATIONS` in `routes/auth/schemas.ts:148`. `approval_decide`
MUST be excluded there, and excluded *by the compiler*: the allowlist's
`satisfies readonly Exclude<StepUpOperation, 'enroll_first_factor'>[]` is
widened to `Exclude<StepUpOperation, 'enroll_first_factor' | 'approval_decide'>`
so appending it later is a type error rather than a convention. Without this,
anyone who can satisfy an ordinary TOTP step-up could mint the credential that
clears an enforcing partner's L3 passkey floor — the exact escalation the
`enroll_first_factor` exclusion exists to prevent, restated for this
operation. Codex review, finding 10.

### Client (web)

Minimal and rebase-friendly against #5600, which is editing the same file:

- `apps/web/src/lib/intentApprovals.ts` keeps a module-level
  `{ id, expiresAt }` for the last `stepUpGrantId` a **supervised** decide
  returned. The cache is filled by, and spent on, supervised approves only.
- On a **supervised** approve, if a live grant is held, the optimistic
  attempt (#5600's machinery) POSTs `stepUpGrantId` **instead of** going
  proofless; with no grant it goes proofless as before.
- On `403 step_up_required`, drop the cached grant and retry **once** with a
  fresh ceremony. This is the same retry shape #5600 uses, so the two changes
  compose rather than conflict, and the function stays bounded at two POSTs.
- A **four_eyes** approve never consults the cache and never sends a grant:
  it runs the ceremony up front, as on `main`. A `stepUpGrantId` on a
  four_eyes response (the server sends none) is not cached either.
- The decide response's `stepUpGrantId`, when present on a supervised
  approve, replaces the cache.
- The cache is per page load and is cleared on any 401/403 — it is a latency
  optimisation, never an authority. The server is the only thing that decides
  whether a grant is good.

## Known, unchanged limits

- **Check/write gap.** Policy, eligibility and grant validity are evaluated
  before the write transaction, so a concurrent revocation, policy change or
  newly-eligible second approver between check and CAS is possible. This is a
  pre-existing property of the fresh-proof path, not something redemption
  introduces, and closing it is a separate change to the decide core. Noted
  rather than silently inherited (Codex review).
- **Family-only revocation.** `revokeFamily` does not bump `authEpoch` and the
  access middleware does not consult family revocation
  (`tokenRevocation.ts:430`, `middleware/auth.ts:531`), so family revocation
  alone leaves both an already-issued access token and a matching grant
  usable. Again pre-existing and broader than this feature; the grant is no
  more durable than the access token that presents it.
- **Raised floors are not retro-satisfiable.** A `high` proof yields L3
  regardless of a partner floor raised to L4 (`authenticatorAssurance.ts:344`),
  so a retry with a fresh ceremony cannot clear it. The client must not
  promise that retrying resolves a `step_up_required`; it retries once and
  then surfaces the existing CTA.

## Alternatives rejected

- **Grant for four_eyes rows as well (the first draft).** Rejected by Todd
  2026-09-11: four_eyes is the high-trust path, and extending the grant there
  would let a live stolen access token plus a leaked grant id clear the
  four_eyes L3 gate inside the window — a capability a stolen token does not
  have today. Confining the grant to supervised rows keeps that gate exactly
  as it is.
- **300 s window (the shared single-use default).** Shortened to 120 s on the
  same decision; the burst this exists for is measured in seconds, not
  minutes.
- **Wall-clock "recent ceremony" timestamp on the session.** Rejected by the
  house position, and unbindable to a resource: it would cover any org and
  any tier.
- **Extending `APPROVAL_CHALLENGE_TTL_MS`.** Lengthens the replay window for
  a *single-use signature*, which is strictly worse: it weakens the L3
  recency proof rather than reusing a proof that was fresh when made.
- **A TTL cache in `decideApprovalRequest`.** Explicitly rejected in the
  issue. It would be process-local (wrong across API replicas), invisible to
  `authEpoch`/`mfaEpoch` invalidation, and unauditable.
- **Making the grant single-use and minting a fresh one per redeem.** This is
  the sliding-window design; it turns a 120 s credential into an indefinitely
  renewable one for as long as the operator keeps clicking.

## Advisor quorum

Independent review requested from Codex (`gpt-6-astra`, read-only,
reasoning `xhigh`) on the security points above. Verdict and any resolution
are recorded in "Codex review" below.

### Codex review

Run: `codex exec -m gpt-6-astra -c model_reasoning_effort="xhigh" -s read-only`,
2026-09-11, against this checkout.

**Verdict: DISAGREE with shipping the spec as first drafted.** Codex agreed
with points 3 (L4 exclusion), 4 (non-extension), 5 (fail closed), 6 (partner
floor on redeem) and 8 (four_eyes gate preserved, conditionally), and
disagreed with points 1 (bounding sufficiency), 2 (digest composition) and 7
(audit honesty). Every disagreement was checked against the code and **every
one was upheld**; all ten findings are adopted above. The disagreements, in
severity order:

1. **`agentRunId` is null for the motivating flow — the blocker.** Codex
   claimed web AI chat produces intents with no `requestingAgentRunId`, which
   would put every chat approval in an org into one shared digest bucket.
   Verified: `aiAgentSdk.ts:1193` calls `createActionIntent(session.auth, …)`
   with the human's auth, and `intentService.ts:1598` sets
   `requestingAgentRunId: agentRun?.id ?? null` where `agentRun` is populated
   only in the `ai_agent` principal branch. The claim is correct and the
   original digest was decorative for exactly the case it was meant to bound.
   **Resolution:** digest gains `aiSessionId` (from the `ai_tool_executions`
   row stamped with this intent) and grant eligibility now *requires* at least
   one conversation identifier, so the catch-all bucket does not exist.
2. **Approver-device revocation did not invalidate the grant.** Verified:
   `routes/authenticator.ts:758` sets `disabled_at` without bumping either
   epoch, while the fresh-assertion path filters on
   `isNull(disabledAt)` (`authenticatorAssurance.ts:399`). **Resolution:**
   redeem re-checks the device row is live and owned.
3. **The `sid` claim was false.** `sid` is a refresh-family id (`jwt.ts:226`),
   not device binding, so a stolen access token presents the same `sid`.
   **Resolution:** the claim is removed and the residual exposure stated
   explicitly as an accepted cost.
4. **A bad grant could be swallowed by `skipAssuranceLadder`.** Verified at
   `decideApprovalRequest.ts:739`. **Resolution:** a presented grant disables
   the shortcut, as a presented proof already does.
5. **Mint ordering was imprecise** (two CAS outcomes; the row can commit while
   the intent CAS loses). **Resolution:** mint after the transaction resolves,
   after the `lostRace` return, and only when `wonIntent`.
6. **The TTL clock started at `SETEX`, not at the ceremony.** **Resolution:**
   `ceremonyAt` recorded in grant context; redeem asserts the absolute age.
7. **The audit marker was not durable.** Verified: the `action_intent` event
   is post-transaction, gated on `wonIntent`, through a fire-and-forget writer
   with a droppable in-memory retry queue (`auditEvents.ts:111`). A committed
   reused-L3 row could have carried no marker at all. **Resolution — adopted
   more strongly than Codex proposed:** a new
   `approval_requests.decided_via_step_up_grant` column written inside the
   decision transaction, with the event detail kept as a dashboard
   convenience.
8. **The sole-operator gate lives inside the ladder's `else` block**, so a
   sibling redemption branch would route around it
   (`decideApprovalRequest.ts:787`). **Resolution:** the two paths converge
   before the gate.
9. **`validateStepUpGrant` returns only a boolean**, so there was no validated
   way to retrieve the assurance context. **Resolution:** a
   `readStepUpGrant` retrieval API that validates the bind and returns the
   context, rejecting malformed level/factor/device combinations.
10. **`approval_decide` must stay out of the client-requestable step-up
    allowlist** (`routes/auth/schemas.ts:148`). **Resolution:** excluded via
    the existing compiler-enforced `Exclude<>` narrowing.

Three further observations were accepted as **pre-existing and out of scope**,
and are recorded under "Known, unchanged limits" rather than being silently
inherited: the check/write gap between authorization and CAS, family-only
revocation not bumping `authEpoch`, and a raised partner floor not being
satisfiable by any number of `high`-tier retries.
