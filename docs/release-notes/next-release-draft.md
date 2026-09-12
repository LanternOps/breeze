# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.112.0** (2026-09-10).

---

## Feature: AI-authored scripts, reviewed and approved on a readable card (#5612)

The assistant and background agents can now author a script as an immutable
**proposal**. Every proposal is scanned, classified, and independently reviewed by
a model that never sees the author's transcript; a human then approves it on a card
that shows the goal, the expected effect, the reviewer's findings and risk tier, the
target devices, and the code itself — not a JSON blob with a script id in it.
"Request changes" sends the findings and the approver's note back to the author
for a fresh revision; nothing is edited in place.

After the run, a `script-verify` job checks the proposal's own verification claim
with an **independent** device read (a service status read, a process list, a
directory listing) rather than trusting the script's exit code, and only a
**verified** proposal can be saved to the library, where its origin, reviewer and
approver stay visible on the script (Origin column, Reviewed / Edited-since-review
badges) and on every version (Provenance panel).

**Self-Hosting / Upgrade Notes**

- `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` now **defaults to `true`** — in the code
  default and in `docker-compose.yml`'s `:-true` interpolation default. Set it to
  `false` to keep the two tools (`propose_script`, `get_script_proposal`)
  unregistered and the `/api/v1/ai/script-proposals` surface dark.
- One new migration, `2026-10-16-120100-script-proposal-acknowledged-patterns.sql`
  — one `text[] NOT NULL DEFAULT '{}'` column on `script_proposals`. No backfill,
  no downtime.
- A new BullMQ queue, `script-verify`, consumed by a `socket-owner` worker (the
  API replica that owns the agent socket). No new service, no new port.
- Approving a proposal that matched a **Strict** danger pattern now requires the
  approver to hold `scripts:write` **in the proposal's org** and to have completed
  MFA — the same bar the script library already applies — and four-eyes requests
  for such proposals are fanned out only to approvers who hold `scripts:write`.
  Grant `scripts:write` to approvers who decide AI script runs before relying on
  this; a decide without it is a typed `422 strict_acknowledgement_not_permitted`.
- New `GET /api/v1/scripts/:id/versions` read for the provenance panel.
- The Helper (desktop) approval popup renders a proposal summary only when the
  legacy Tier-2 `approval_required` event carries one; proposal-backed runs are
  Tier 3 and normally reach humans through the web / mobile approval surfaces.
- The unattended lane ships in the same release (below) but is **off** until an
  MSP partner opens the ceiling and an organization opts in.

## Feature: AI script authoring — the reviewer-gated unattended lane (#5612)

The AI assistant and background agents can now run a script they wrote **without
an approval card**, but only when an MSP partner opens the ceiling *and* the
individual organization opts in. Both are off by default and there is **no env
flag** — nothing changes for an existing deployment until someone turns it on in
**Settings → AI → Script authoring** (partner ceiling for partner admins with
full organization access; organization grant for `ai_agents:write`, with
`approvals:decide` plus a fresh MFA step-up to switch it on).

When enabled, a proposal is released unattended only if it clears all fourteen
gates, in order: the effective grant, a runnable proposal with no basic-pattern
hits, a completed independent model review at or below the allowed risk tier
(never above `medium`), an unqualified approve verdict, no strict-pattern hits, a
deterministic touch classification inside the allowed class list (never
credentials, security tooling, boot, disk, dynamic code, users/groups or
firewall), no protected resource (the classifier's extracted service / path /
registry names against the partner's, the org's and — for agents — the agent's
own protected lists), a timeout of 300 s or less, supervised scope, exactly one
target device, a Windows device when the script touches the registry, services or
system files, a closed lane and a free slot in the hourly quota (reserved under a
per-organization lock, pending runs included), a live permission or agent-policy
check, and an online device outside a maintenance window. **On Linux and macOS
the registry / services / system-file classes are not lane-eligible in v1**,
because no restore checkpoint can be taken there; those runs still go to a human.

Every gate is re-proved at release, and on Windows a **System Restore checkpoint**
is created immediately before dispatch for the three checkpoint classes — the run
fails `checkpoint_unavailable` rather than proceeding without one. Two
consecutive unverified unattended runs pause the lane for the whole organization
until an approver with `approvals:decide` resets it (also MFA-gated).

**New audit actions:** `ai.script.unattended_run`, `ai.script.unattended_verified`,
`ai.script.unattended_failed`, `ai.script_lane.opened`, `ai.script_lane.reset`,
`ai.script_lane.enabled`, `ai.script_policy.updated`,
`ai.script_policy.partner_updated`.

**Self-Hosting / Upgrade Notes**

- Two new migrations, both idempotent, no backfill, no downtime:
  `2026-10-16-120200-ai-script-policies.sql` (tables `ai_script_policies`,
  `ai_script_lane_state` with their RLS policies) and
  `2026-10-16-120300-action-intents-script-reviewer.sql` (an immutable
  `action_intents.script_reviewer_evidence` jsonb column).
- New routes: `GET/PUT /api/v1/ai/script-policy`, `POST /api/v1/ai/script-lane/reset`,
  `GET/PUT /api/v1/partner/ai/script-policy`. A new MFA step-up operation,
  `ai_script_lane_grant`, bound to the organization and the value being set.
- `BREEZE_AI_SCRIPT_REVIEWER_MODEL` is now the platform *default*; an
  organization or partner may name a reviewer model on its policy row.
- The restore checkpoint runs as a fixed, server-owned PowerShell body over the
  existing script command — no agent upgrade is needed. A first-class
  `create_restore_point` agent command is tracked in #4609.
