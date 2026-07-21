# Rollout: Windows helper lifecycle durability

Operational notes for shipping the helper lifecycle work described in
`docs/superpowers/specs/agent/2026-07-14-windows-agent-helper-lifecycle-durability-design.md`
(slice 7: "Cross-component integration tests, Windows validation, and rollout notes").

## What changes on the endpoint

Windows terminal servers accumulated `breeze-user-helper.exe` processes because IPC
admission was keyed on SID alone with a 5-connection cap. Every SYSTEM helper shares
`S-1-5-18`, so the sixth session onward was rejected, and rejected helpers stayed alive
in reconnect loops — invisible to reconciliation, which spawned replacements every 30s.

After this change, admission is keyed by (SID, OS session), helpers are tracked in a
lifecycle registry, and proactively spawned helpers are owned by a Job Object so they
die with the agent. Net effect on an RDS host: helper count converges to the desired
role/session count instead of growing without bound.

No data migration. No customer configuration change.

## Rollout mechanism — read this before promoting

**Registration is decoupled from promotion.** In production `AGENT_AUTO_PROMOTE=false`,
so a binary sync registers new binaries *without* touching `agent_versions.isLatest`.
The fleet upgrade target only moves on an explicit `POST /agent-versions/promote`
(`apps/api/src/routes/agentVersions.ts:79`). Omitting `component` promotes **all**
components — pass it explicitly unless you mean that.

**There is no cohort or ring control.** `agent_versions.isLatest` is one global boolean
per (version, platform, architecture, component) — see
`apps/api/src/db/schema/agentVersions.ts:15`. The design spec's "beginning with RDS hosts
and a Windows workstation cohort" (spec line 362) describes a capability the platform
**does not have today**. Promotion is all-or-nothing for a given platform/arch.

To stage this in practice:

1. Leave `isLatest` on the current version. Do not promote.
2. Install the new MSI by hand on a small set of RDS hosts (the highest-value cohort —
   they carry the bug being fixed) and a couple of Windows workstations.
3. Observe (below) across at least one full logon/logoff cycle — ideally a business day,
   so you see morning logon storms and evening logoff.
4. Only then `POST /agent-versions/promote` for `windows`/`amd64`.

## What to observe before promoting

From the spec's acceptance criteria (lines 438-455):

- **Helper process count** converges to desired role/session count, plus only a short
  bounded replacement overlap. This is the primary signal — it is the reported bug.
- **Rejection rates** — pre-auth rejection must not increase process count on subsequent
  reconciles.
- **A 20-session RDS host** registers its intended helpers with no SID-wide quota
  rejection. This is the specific case that was broken.
- **Watchdog stop time and recovery success** — the watchdog must never call `Start`
  until SCM reports `Stopped`, and forced termination must only ever target a freshly
  verified SCM service PID.
- **Offline duration** — recovery must not lengthen the window where a device looks down.
- **No orphaned helpers** after an agent crash or stop.
- **Single-instance**: a second full Windows agent must fail to initialize.

Watch for the log line warning that a helper never reached IPC within the startup
timeout. `helperStartupTimeout` is 90s and is an **unmeasured conservative guess**
(`agent/internal/sessionbroker/lifecycle_core.go`). If that warning fires for helpers
that were merely slow to start on a loaded host, raise it — do not lower it. Killing a
healthy slow-starting helper reintroduces a respawn loop.

## Mixed-version tolerance

The helper and main agent ship together, but the fleet will be mixed during rollout
(spec lines 349-360):

| Combination | Behavior |
|---|---|
| New agent + old helper | Protocol/auth version checks retain existing behavior; lifecycle tracking still prevents spawn multiplication. |
| Old agent + new helper | Helper retains compatible hello/rejection parsing. |
| Missing companion helper | Main-binary fallback remains available, tracked under the same role/session key. |
| Existing scheduled tasks | Admitted through the same broker rules; not assumed to be Job Object children. |

## Rollback

Binary rollback restores previous lifecycle behavior. Job Object ownership ends with
process termination, so it leaves no persistent OS object. The lock file may remain
after exit but carries no ownership without an exclusive live handle, and is safely
reused. Service configuration, scheduled tasks, and helper binaries stay compatible.

To roll back: promote the previous version, then restart `BreezeAgent` on affected hosts
and verify expected helper processes reconnect. If helper *admission* is the reason for
rollback, capture broker rejection logs before restarting — a restart destroys the
evidence of why admission failed.

## Known gaps at ship time

- **No cohort rollout control** exists; staging is manual (above). Worth building if this
  pattern recurs.
- **Six pre-existing Windows test failures** in `internal/agentapp`, `internal/config`,
  and `internal/heartbeat` are unrelated to this work and also fail on `main`. The CI
  Windows job therefore covers `sessionbroker`, `eventlog`, `watchdog`, and
  `cmd/breeze-watchdog` only. Tracked in #2523; the narrowed job is still required.
