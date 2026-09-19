# macOS package artifact cleanup (RMM-QA-184, #4060)

## Remaining product gap

The pkg builder installs four binaries and four launchd plists, but the shell and
remote uninstall paths still reference the obsolete agent-user helper label.
Service CLI uninstall removes current helper files without stopping their GUI and
loginwindow jobs. The paths also omit package receipt removal and some binaries.

This bounded change aligns package-owned teardown across public shell downloads,
the service CLI, and detached remote uninstall. Existing device-removal plans
separate delivered commands from verified removal; this change preserves that
boundary. It does not close the full QA finding.

## Implementation

Embed fixed shell functions in a small Go package used by service CLI and detached
teardown. The same functions appear in the agent/public/API scripts, with parity
checks. No endpoint-readable manifest supplies privileged deletion targets.
Tests derive the eight owned file paths from the existing pkg builder.

Stop watchdog before helper jobs and agent. Enumerate loginwindow process UIDs to
cover fast user switching; only numeric human UIDs are used. Stop the current
helper in each GUI domain and the LoginWindow helper through each actual
loginwindow PID domain, including root. Local launchctl(1) documents pid/<pid>
service targets; LoginWindow is a session type, not a literal domain. The
installer currently attempts the latter best-effort; cleanup must not inherit
that assumption. Native candidate verification of loaded session jobs remains
required. Delete
four binaries, four plists and the fixed volatile agent socket; forget only receipt
com.breeze.agent. Keep separate Breeze Assist and the breeze group untouched.

A bootout failure is tolerated only when launchctl print reports service-not-found
(113). Other query failures or a still-loaded job fail cleanup. Failure to enumerate
sessions, remove files, list receipts or forget an existing receipt also fails.
An absent receipt is idempotent success. Failures can leave partial removal and
should be retried; this is not an atomic operation.

The shell and CLI retain configuration and logs. Remote uninstall retains its
existing removeConfig option and delayed detached execution after command
acknowledgement. Its initial watchdog neutralization and agent disable remain.
Socket cleanup removes only volatile agent.sock, not configuration or secrets.
Credentials, revocation, teardown acknowledgements, retained-data policy,
group ownership and separately installed Assist lifecycle are outside this slice.

## Verification and limits

Run actual cleanup scripts with fake launchctl/ps/pkgutil/rm commands. File removal
is redirected to a temporary fixture root; assert all builder-owned files disappear
and config, secrets, logs and unrelated artifacts survive. Cover active/multiple
sessions, absent jobs/receipt, enumeration failure, loaded-job stop failure,
file/receipt failures and command ordering. Execute the generated API script and
remote script through recording commands; CLI wiring propagates runner failures.
Run Go race tests and API tests/typecheck, then independent exact-head review/CI.

No install/uninstall command runs against the developer host. Real signed-package
install/uninstall on a disposable Mac, candidate verification, credential teardown
and formal QA closure remain outstanding. No migration or database change exists.
