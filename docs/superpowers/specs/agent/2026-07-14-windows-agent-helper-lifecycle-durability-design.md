# Windows agent and helper lifecycle durability

**Date:** 2026-07-14
**Status:** Approved
**Scope:** Windows session helpers, RDS support, main-agent exclusivity, watchdog recovery, and diagnostics
**Branch:** `ToddHebebrand/helper-sessions-in-remote-desktop`

## Problem

Windows terminal servers can accumulate far more `breeze-user-helper.exe`
processes than there are eligible sessions. The reported example showed dozens
of SYSTEM-owned helpers on a server with no more than 20 users. Separate Windows
11 reports describe a Breeze service that stops while a Breeze process remains,
multiple Breeze processes running at once, and the device remaining offline.

These reports expose several related lifecycle gaps.

### RDS helper accumulation

The lifecycle manager intentionally targets one SYSTEM helper per active or
connected Windows session and one user helper per active session. However,
Windows IPC admission is keyed only by SID and permits five connections per
identity. Every SYSTEM helper has SID `S-1-5-18`, so a terminal server exhausts
that shared bucket after five SYSTEM helpers authenticate.

Additional helpers receive a transient pre-auth rejection and remain alive in
their reconnect loop. Because they never authenticated, reconciliation cannot
see them and launches replacements every 30 seconds, up to ten attempts per
session. Pre-auth-rejected helpers are also absent from registered-session PID
cleanup. The result is a growing process population without a corresponding
increase in usable helper sessions.

### RDP user helpers are rejected

The broker currently binds the user helper role to the physical active console
session. A correctly tokenized user helper in an RDP session therefore fails
authorization even when the OS-derived peer session matches the claimed
session. This prevents PAM, run-as-user, notifications, and related per-user
operations from working reliably in RDP sessions.

### Multiple `breeze-agent.exe` processes are ambiguous

When `breeze-user-helper.exe` is missing, quarantined, or absent during a
partial upgrade, the broker deliberately falls back to launching
`breeze-agent.exe user-helper --role ...`. Task Manager can consequently show
several `breeze-agent.exe` processes even though only one is the SCM-managed
main service.

There is also no process-wide guard on the full `breeze-agent.exe run` path. An
elevated manual or scheduled invocation can initialize a second full agent next
to the service. The SCM normally serializes its own service instance, but it
does not prevent a console-mode invocation of the same command.

### Watchdog recovery can race normal shutdown

The watchdog's first recovery attempt requests a service stop, waits up to 15
seconds, and then calls `Start` even if the service never reached `Stopped`.
Normal bounded shutdown can legitimately consume approximately 21 seconds
across subsystem cancellation, command drain, WebSocket stop, and heartbeat
stop stages. The watchdog can therefore call `Start` while the service is still
`StopPending`. Windows should reject that start instead of creating a second
SCM instance, but the failed recovery extends the offline window and can look
like a stuck service.

The watchdog's forced attempt also uses the PID most recently read from the
agent state file. A duplicate console agent or stale state file can make that
PID different from the process currently owned by the BreezeAgent service.

## Goals

- Support the intended number of SYSTEM and user helpers on multi-session RDS
  hosts without weakening helper authentication.
- Enforce exactly one live helper for each `(Windows session, helper role)`.
- Make helper ownership explicit and terminate helpers on logoff, service
  shutdown, agent crash, and replacement.
- Authorize RDP user helpers using OS-derived identity and session evidence.
- Prevent more than one full Windows agent from initializing.
- Make watchdog recovery wait for verified service and process transitions.
- Make every Breeze process's role evident in local diagnostics and support
  collection.
- Preserve compatibility with partially upgraded installations that must use
  the main binary as a temporary helper fallback.

## Non-goals

- Replacing the Windows service/watchdog architecture with a new supervisor.
- Removing the companion helper fallback in this change.
- Changing Linux or macOS helper admission semantics.
- Using executable names alone to kill processes.
- Treating every Breeze process shown in Task Manager as a full-agent duplicate.
- Adding customer-facing configuration or requiring guide changes.
- Diagnosing a specific reported stuck process without its command line, SCM
  state, logs, and process dump. This design prevents known lifecycle gaps but
  does not invent an unsupported root cause for a particular endpoint.

## Design principles

1. The operating system is the authority for SID, token session, service PID,
   and process lifetime. Helper-supplied metadata cannot override it.
2. Lifecycle ownership and IPC authentication are separate controls. Admission
   must remain safe even when reconciliation is wrong, and reconciliation must
   remain bounded even when admission rejects a process.
3. Every replacement must follow `observe -> stop -> verify -> start -> verify`.
4. Destructive cleanup must prove process ownership and role. It must never kill
   an arbitrary process based only on a PID or image name.
5. Existing fallback paths remain observable and bounded during version skew.

## Architecture

The change is additive and stays within the current service, session broker,
helper client, and watchdog components.

### 1. Session-aware IPC admission

On Windows, the pre-auth identity key becomes a composite of the OS-derived
peer SID and peer Windows session ID:

```text
windows:<sid>:session:<peer-session-id>
```

This key is used for pre-auth connection counts and rate limiting. It prevents
all SYSTEM helpers across an RDS host from competing for the same five-slot
bucket while retaining a bounded quota within each Windows session.

After the helper hello is authenticated, the broker applies a stricter logical
key:

```text
<peer-sid, peer-session-id, helper-role>
```

Only one registered helper is allowed for a given Windows session and role.
When a replacement authenticates, the broker either rejects it as a duplicate
or replaces a provably stale registered session; it never keeps two active
sessions for the same key.

Unix identity behavior remains unchanged.

### 2. RDP-safe user-role authorization

The physical-console-only gate is replaced on Windows with the following user
helper requirements:

- The peer token is not LocalSystem.
- The OS-derived peer Windows session ID is nonzero and equals the session ID
  claimed in the authenticated helper hello.
- The broker's session detector recognizes that session as eligible for the
  requested role.
- Existing binary identity, token, protocol, and helper-role checks still pass.

The helper's username or claimed session is not trusted independently. The
kernel token session is the binding evidence. This admits a legitimate user
helper in an RDP session without allowing a helper in one session to impersonate
another.

SYSTEM-role authorization continues to require LocalSystem and matching
OS-derived/claimed session IDs.

### 3. Lifecycle-owned helper registry

The Windows lifecycle manager maintains a registry keyed by:

```go
type HelperKey struct {
    WindowsSessionID uint32
    Role             string
}
```

Each entry records the PID, process handle, launch time, executable path,
command mode, and current state (`starting`, `connected`, `stopping`, or
`exited`). The spawner returns a process reference instead of only reporting
whether launch succeeded.

Reconciliation follows these rules:

- If the desired key has a connected broker session, do nothing.
- If it has a tracked process that is still alive or still within the startup
  grace period, do not spawn another.
- If the tracked process exited, record the exit classification and apply the
  existing retry/cooldown policy before replacing it.
- If the session is no longer eligible, terminate and reap the tracked process,
  close any broker session, and remove retry state.
- A broker connect/disconnect callback updates the corresponding tracked entry
  rather than relying only on polling.

This closes the current gap where pre-auth-rejected helpers are alive but
invisible to reconciliation.

### 4. Windows Job Object ownership

All proactively spawned Windows helpers are created suspended, assigned to an
agent-owned Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
and resumed only after assignment succeeds. This prevents a fast-starting
helper from escaping ownership between process creation and job assignment.

Consequences:

- Graceful agent shutdown explicitly terminates/reaps helpers and then closes
  the job.
- An agent crash or forced termination closes its job handle and Windows kills
  remaining child helpers.
- A restarted agent starts with no surviving children from the previous
  owner under normal Job Object semantics.

If assigning a newly created helper to the job fails, the spawner terminates
the still-suspended helper, closes its handles, and reports launch failure. It
must not leave an unowned process.

The existing scheduled user-helper path is not necessarily a child of the
agent and therefore cannot rely on this job. Broker-side one-per-key admission
and role/session validation remain authoritative for it.

### 5. Logoff, disconnect, and shutdown behavior

- `logoff`: terminate both SYSTEM and user role processes for the session and
  remove their retry state.
- `disconnect`: keep or stop the SYSTEM role according to the existing desired
  state for connected sessions; stop the user role when the session is no
  longer active.
- `reconnect`/`logon`: reconcile immediately, still protected by tracked-process
  deduplication.
- agent service shutdown: stop accepting new helper connections, request helper
  shutdown, wait for a short bounded grace period, terminate remaining tracked
  processes, and close the Job Object.

Startup cleanup is conservative. The agent may remove stale broker records and
tracked metadata, but it does not enumerate and kill processes merely because
their filename begins with `breeze`. Any orphan cleanup outside Job Object
ownership requires verified executable path, command mode, Windows session,
and a process creation time predating the current agent owner.

### 6. Main-agent single-instance guard

Only the full Windows `run` path acquires an exclusive, no-sharing file handle
before config, IPC, heartbeat, or collector initialization. The lock file lives
in a private SYSTEM/Administrators-owned `run` child of Breeze's hardened
machine-wide ProgramData directory. Directory and file ownership are verified
in addition to the protected DACL. Helper,
service-management, enrollment, and diagnostic subcommands do not acquire it.

The protected parent directory is the security boundary: an unprivileged local
process cannot pre-create or replace the file to block service startup. A plain
global named mutex is not authoritative because its name can be squatted before
the service creates and applies its intended ACL. The lock file contains
diagnostic metadata (PID, Windows session, launch mode, executable path, and
creation time), but the held file handle—not the metadata—is the lock.

If exclusive open fails because another full agent owns the file:

- Log and print a clear `main agent already running` diagnostic.
- Include the current process PID, session, and launch mode.
- Exit with a dedicated nonzero code before initializing agent components.

The handle is held for the lifetime of the full agent and released by process
termination. Helper fallback invocations such as
`breeze-agent.exe user-helper --role user` are unaffected.

### 7. Verified watchdog recovery

The Windows service controller exposes explicit operations for querying service
state/PID, requesting stop, waiting for a state, validating process identity,
terminating the service process, and starting the service.

Graceful attempt:

1. Query the service.
2. If already stopped, proceed to start.
3. Otherwise request stop and wait for `Stopped` using a timeout greater than
   the documented maximum normal shutdown budget, with margin.
4. If the timeout expires, return a typed stop-timeout error. Do not call
   `Start`.
5. Start and verify that the service reaches `Running` with a nonzero PID.

Forced attempt:

1. Query the current PID from SCM immediately before termination; do not trust
   the agent state-file PID for destructive action.
2. Verify that the PID is the SCM-owned BreezeAgent process and that its image
   path matches the configured service binary.
3. Terminate it, wait for process exit, and observe SCM. If SCM reaches
   `Stopped`, start explicitly. If configured SCM failure recovery has already
   entered `StartPending` or `Running`, do not issue a competing start.
4. In either branch, verify `Running` with a new live PID and matching image.

`RecoveryManager.Attempt` will accept a richer recovery result so journal
entries identify the phase, old/new PID, service states, elapsed time, and
failure class. Existing heartbeat-based post-restart verification remains the
definition of application-level recovery.

### 8. Recovery authority coordination

SCM recovery actions remain enabled for immediate process crashes. The watchdog
remains responsible for a live-but-unhealthy agent and for verified escalation.
They coordinate through SCM state:

- The watchdog does nothing while the service is `StartPending`, `StopPending`,
  `ContinuePending`, or `PausePending`, except bounded observation and logging.
- It does not issue a second start for `Running` or transitional states.
- A watchdog attempt that observes an SCM recovery already in progress waits
  for the transition and then enters heartbeat verification.

This avoids expanding the change into installer recovery-policy removal while
preventing competing side effects.

### 9. Process-role diagnostics

Every Breeze process writes a startup record containing:

- binary name and resolved executable path;
- process and parent PID;
- Windows session ID;
- launch mode (`service-run`, `console-run`, `user-helper`, `system-helper`, or
  other command);
- helper lifecycle key when applicable;
- whether the companion helper or main-binary fallback is in use;
- agent/helper version and creation timestamp.

The main agent state remains reserved for the main agent. Helper processes must
not overwrite its PID. Watchdog journal entries include SCM state/PID separately
from the state-file PID so support can identify disagreement.

The existing missing-helper warning is elevated into structured diagnostics and
rate-limited. Support collection can then distinguish:

- one SCM service process in Session 0;
- fallback `breeze-agent.exe user-helper` processes in interactive sessions;
- true duplicate full `run` processes;
- companion `breeze-user-helper.exe` processes by role/session.

## Failure handling

- Admission quota rejection cannot cause process multiplication because the
  lifecycle registry still owns and observes the rejected process.
- Duplicate logical helper registration causes the surplus helper to exit; it
  does not reconnect forever.
- Failed Job Object assignment kills the just-created process.
- Failed helper termination is logged with PID, key, and error and retried only
  within a bounded cleanup policy.
- Lock creation/security failure fails closed for the full agent and produces
  a startup marker; it does not continue without exclusivity.
- Watchdog stop timeout leaves the service untouched in its observed state and
  advances to the separately verified forced attempt after cooldown.
- PID validation failure blocks forced termination, returns a terminal recovery
  disposition, and enters failover rather than retrying attempt 2 or risking
  termination of an unrelated process.

## Compatibility and rollout

The companion helper and main agent ship together, but rollout must tolerate
old/new mixtures:

- New agent + old helper: protocol/auth version checks retain existing behavior;
  lifecycle tracking prevents spawn multiplication.
- Old agent + new helper: the helper retains compatible hello/rejection parsing.
- Missing companion helper: main-binary fallback remains available and is
  tracked using the same role/session key.
- Existing scheduled tasks: accepted through the same broker admission rules;
  they are not assumed to be Job Object children.

Rollout should use the normal agent fleet rollout controls, beginning with RDS
hosts and a Windows workstation cohort. Observe helper counts, rejection rates,
watchdog stop time, recovery success, and offline duration before broad release.

No migration or customer configuration change is required.

## Testing strategy

Implementation follows test-driven development.

### Session broker and lifecycle unit tests

- Windows identity keys differ for the same SID in different OS sessions.
- Existing Unix identity keys remain unchanged.
- Five SYSTEM helpers in distinct RDS sessions do not share one quota bucket.
- Same-session connection/rate limits still apply.
- Only one authenticated helper is retained per session/role key.
- An alive pre-auth helper suppresses reconciliation respawn.
- An exited helper is replaced only according to cooldown rules.
- Logoff terminates and removes both role entries.
- Disconnect preserves/removes roles according to desired session state.
- Broker callbacks transition tracked process state safely under concurrency.
- Lifecycle stop is idempotent and reaps all tracked helpers.

### Authorization tests

- User helper with a non-SYSTEM token and matching RDP session is accepted.
- User helper claiming a different Windows session is rejected permanently.
- SYSTEM identity claiming user role is rejected.
- Non-SYSTEM identity claiming system role is rejected.
- SYSTEM role with matching OS-derived session is accepted.
- Physical console behavior remains supported.

### Windows process ownership tests

- Spawned helpers are assigned to the Job Object.
- Assignment failure terminates the process.
- Closing the job terminates remaining helper test processes.
- A tracked live process prevents duplicate launch under concurrent reconciles.
- Main-binary helper fallback does not acquire the main-agent lock.

### Main-agent exclusivity tests

- First full-agent instance acquires the guard.
- Second full-agent instance exits before component initialization.
- Guard is released after owner exit.
- Helper and administrative subcommands are not blocked.
- Lock ACL/open error paths fail closed and produce diagnostics.

### Watchdog tests

- Graceful recovery never starts before `Stopped`.
- A 15-second `StopPending` interval does not trigger premature start.
- Stop timeout returns a typed error without calling `Start`.
- Forced recovery uses the fresh SCM PID rather than the state-file PID.
- Mismatched executable/service ownership prevents termination.
- Forced recovery waits for process exit and `Stopped` before start.
- Start verification requires `Running` and a live nonzero PID.
- Existing heartbeat verification and flap accounting remain intact.
- Transitional SCM states do not cause competing recovery actions.

### Integration and manual verification

- Simulate more than five Windows sessions and confirm one SYSTEM helper per
  eligible session without accumulation across several reconcile intervals.
- Exercise two active RDP users and verify user-role PAM/run-as-user routing is
  session-correct.
- Kill the agent and verify Job Object cleanup followed by bounded repopulation.
- Launch a second elevated `breeze-agent.exe run` and verify immediate refusal.
- Hold a fake service in `StopPending` longer than 15 seconds and verify the
  watchdog does not start it prematurely.
- Remove the companion helper in a test install and confirm fallback processes
  are labeled, bounded, and self-healed on heartbeat.
- Run relevant Go packages with `go test -race` and run Windows-specific tests
  in the Windows CI environment.

## Observability and acceptance criteria

The change is accepted when:

- Helper process count converges to the desired role/session count plus only a
  short, bounded replacement overlap.
- A 20-session RDS host can register its intended helpers without SID-wide
  quota rejection.
- No session/role key has more than one registered helper.
- Pre-auth rejection does not increase process count on subsequent reconciles.
- RDP user helpers authenticate only into their own OS session.
- Agent crash or stop leaves no proactively spawned helper children behind.
- A second full Windows agent cannot initialize.
- Watchdog never calls `Start` until SCM reports `Stopped`.
- Forced termination only targets the freshly verified SCM service PID.
- Logs distinguish full agents from helper fallback processes without requiring
  a process dump.
- Existing single-session Windows, Linux, and macOS behavior remains green.

## Risks and mitigations

- **Job Object compatibility:** a process may already belong to a non-breakaway
  job. Create helpers with appropriate flags, test under common RDS policies,
  and fail closed if ownership cannot be established.
- **Lock-file denial of service:** rely on the already hardened ProgramData
  parent ACL, refuse reparse-point/path substitution, and acquire only in the
  full-agent path. Do not treat editable file contents as ownership evidence.
- **Session-ID trust regression:** use the peer token's OS-derived session and
  require equality with authenticated hello metadata.
- **PID reuse:** pair PID with current SCM service state, image path, creation
  time where available, and a live process handle before termination.
- **Upgrade skew:** keep fallback compatibility and make new rejection reasons
  intelligible to old clients.
- **Cleanup races:** serialize registry transitions by helper key and make stop,
  disconnect, and exit callbacks idempotent.
- **Overlong recovery windows:** log phase timing and retain heartbeat-based
  recovery verification so a successfully restarted but unhealthy agent still
  escalates.

## Rollback

The feature requires no data migration. A binary rollback restores the previous
lifecycle behavior. Because Job Object ownership ends with process termination,
it leaves no persistent OS object. The empty lock file may remain after exit,
but it carries no ownership without an exclusive live handle and is safely
reused. Existing service configuration, scheduled tasks, and helper binaries
remain compatible.

Operational rollback should restart BreezeAgent and verify that expected helper
processes reconnect. If helper admission is the reason for rollback, capture the
new structured process and rejection diagnostics first.

## Implementation sequencing

The implementation plan should split the work into independently reviewable,
test-first slices:

1. Structured process-role diagnostics and test seams.
2. Session-aware admission and RDP-safe role authorization.
3. Lifecycle process registry, deduplication, and event cleanup.
4. Windows Job Object ownership.
5. Main-agent single-instance guard.
6. Verified watchdog service controller and recovery sequencing.
7. Cross-component integration tests, Windows validation, and rollout notes.

This ordering establishes observability and authorization invariants before
introducing process termination or recovery changes.
