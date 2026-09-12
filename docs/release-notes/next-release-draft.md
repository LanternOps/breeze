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
- The unattended lane is **not** part of this release. Nothing runs without a human
  approval yet.
