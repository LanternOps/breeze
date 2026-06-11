# Linux Agent systemd Sandbox Relaxation for Remote Terminal & Script Execution

**Status:** Design / approved direction
**Date:** 2026-06-09
**Author:** Todd Hebebrand (with Claude)
**Area:** Go agent — `agent/cmd/breeze-agent`, `agent/service/systemd`

---

## 1. Problem

A user on a fresh agent install (Ubuntu 24.04 server) ran `apt update` through the
agent's **remote terminal** and got a wall of privilege-drop failures:

```
E: setgroups 65534 failed - setgroups (1: Operation not permitted)
E: setegid 65534 failed - setegid (1: Operation not permitted)
E: seteuid 42 failed - seteuid (1: Operation not permitted)
W: chown to _apt:root of directory /var/lib/apt/lists/partial failed - SetupAPTPartialDirectory (1: Operation not permitted)
E: The repository '... noble-security Release' no longer has a Release file.
```

The identical commands succeed over plain SSH, so the server itself is healthy.

## 2. Root cause

The agent runs as a systemd service whose unit deliberately hardens the **agent
process** with an inherited sandbox (`agent/service/systemd/breeze-agent.service:27-34`,
mirrored in the embedded template at `agent/cmd/breeze-agent/service_cmd_linux.go:32`):

```ini
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/etc/breeze /var/lib/breeze /var/log/breeze /var/run/breeze /var/cache/apt /var/lib/apt /var/lib/dpkg /var/log/apt /usr/local/bin -/run/ufw.lock
PrivateTmp=true
NoNewPrivileges=false
CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN CAP_SYS_PTRACE CAP_DAC_READ_SEARCH CAP_FOWNER
AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN CAP_FOWNER
```

The remote terminal spawns its shell as a **child** of the agent process
(`agent/internal/terminal/pty_unix.go:74` — only `Setsid`/`Setctty`, no credential
manipulation). A child can never hold capabilities outside its parent's
`CapabilityBoundingSet`, and it inherits the parent's mount namespace
(`ProtectSystem`/`ProtectHome`/`PrivateTmp`). So the `bash → apt` chain is sandboxed.

`apt` needs to drop privileges to the `_apt` user (uid 42, gid 65534) for its download
sandbox, and to chown its partial dir. That requires three capabilities the unit removes:

| apt failure | Missing capability |
|---|---|
| `setgroups`/`setegid 65534`, `seteuid 42 failed` | `CAP_SETUID`, `CAP_SETGID` |
| `chown to _apt:root … failed` | `CAP_CHOWN` |

Over SSH, `sshd` spawns the shell with the full capability set and an unrestricted
filesystem view — hence the asymmetry. The agent's **remote script execution** path
runs through the same agent process and inherits the same sandbox, so the bug is not
limited to the interactive terminal.

## 3. Goals / Non-goals

**Goals**
- Remote terminal and remote script execution behave like a root SSH session: full
  capabilities, writable filesystem, shared `/tmp`.
- The fix reaches the **already-deployed fleet**, not just new installs.
- No regression to the agent's own features that currently rely on elevated caps
  (discovery `CAP_NET_RAW`/`CAP_NET_ADMIN`, process monitoring `CAP_SYS_PTRACE`,
  cross-user file reads `CAP_DAC_READ_SEARCH`).

**Non-goals**
- Hardening the watchdog differently — `breeze-watchdog.service` stays as-is (it is a
  pure supervisor, never spawns admin shells).
- Per-command privilege sandboxing of terminal/script output (out of scope; the product
  contract is "run admin commands as root").
- Windows/macOS — unaffected (different service models, no inherited Linux cap sandbox).

## 4. Decision

Two decisions were settled during brainstorming:

- **Approach A — relax the agent unit** (chosen over Approach B, per-child sandbox escape
  via `systemd-run` on every terminal/script spawn). The agent runs as root; a restrictive
  bounding set on a root daemon whose *entire purpose* is running arbitrary root commands
  provides marginal defense-in-depth while reliably breaking legitimate admin work. Approach
  A is simple, dependency-free on the hot path, and works on every host.
- **Rollout Option 2 — auto-heal** (chosen over Option 1 ship-and-document-manual and
  Option 3 detect-and-warn). The deployed fleet is repaired automatically; the weaker
  options remain as the graceful-degradation fallback.

## 5. Design

### 5.1 Relaxed unit (both definitions, kept byte-identical)

Remove every directive that is inherited by child processes and breaks admin work:
`CapabilityBoundingSet`, `AmbientCapabilities`, `ProtectSystem`, `ProtectHome`,
`PrivateTmp`, and the now-meaningless `ReadWritePaths` (only had effect under
`ProtectSystem`). Keep all operational directives. Add a version marker and an
explanatory comment so nobody silently re-hardens it.

```ini
[Unit]
Description=Breeze RMM Agent
Documentation=https://github.com/breeze-rmm/breeze
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
# breeze-unit-version: 2
Type=simple
ExecStart=/usr/local/bin/breeze-agent start
WorkingDirectory=/etc/breeze
Restart=on-failure
RestartSec=30
TimeoutStopSec=15
KillMode=mixed

# INTENTIONALLY UNSANDBOXED. The remote terminal and remote script execution
# features spawn child processes that must behave like a root SSH session:
#   - `apt` drops privileges to the _apt user (needs CAP_SETUID/SETGID/CHOWN)
#   - admins write under /home, /usr, /etc, and expect a shared /tmp
# systemd sandbox directives (CapabilityBoundingSet, ProtectSystem, ProtectHome,
# PrivateTmp) are INHERITED by those children and silently break these operations.
# Do not re-add them. See docs/superpowers/specs/2026-06-09-agent-systemd-sandbox-remote-terminal-design.md

StandardOutput=journal
StandardError=journal
SyslogIdentifier=breeze-agent
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
```

Since the agent runs as root, removing `CapabilityBoundingSet` *restores* the full
capability set — the agent's own elevated-cap features keep working because
unrestricted-root is strictly more permissive than the previous allowlist.

The two definitions to update (and keep identical):
- `agent/service/systemd/breeze-agent.service` (static, shipped in repo)
- `linuxUnit` constant — `agent/cmd/breeze-agent/service_cmd_linux.go:32`

### 5.2 Versioned unit + reconcile decision

Embed `# breeze-unit-version: N` in the unit. Bump to `2` for this change (the existing
hardened unit is treated as implicit/unmarked v1). The binary knows the version it
expects (`currentUnitVersion = 2`).

A pure, unit-testable decision function:

```go
// unitNeedsReconcile reports whether the on-disk unit is older than what this
// binary ships. Missing marker or lower version => reconcile. Equal or higher
// (a newer binary wrote it, or we're mid-rollout) => leave it alone (no downgrade).
func unitNeedsReconcile(existing string, want int) bool
```

The agent can always **read** `/etc/systemd/system/breeze-agent.service` (world-readable;
`ProtectSystem` does not block reads), so detection works even under the old sandbox.

### 5.3 Auto-heal via sandbox escape

The running (old-sandbox) agent **cannot write** `/etc/systemd/system` — it's read-only
under `ProtectSystem=strict`, and it is not in `ReadWritePaths`. The agent's self-update
path (`agent/internal/updater/updater.go`) only swaps the binary and `systemctl restart`s;
it never rewrites the unit. So healing must escape the sandbox.

**Mechanism:** on startup, if `unitNeedsReconcile`, the agent runs:

```
systemd-run --quiet --collect --unit=breeze-unit-reconcile \
    /usr/local/bin/breeze-agent service reconcile-unit
```

This launches the reconcile as a **transient service**: `systemd-run` asks PID 1 over
D-Bus to spawn the command, and PID 1 forks it in a **fresh execution environment** —
full root capabilities and an unrestricted mount namespace — so it can write the unit.
Because its parent is PID 1 (not the agent), the agent restart it triggers cannot kill
it mid-write. `--collect` garbage-collects the transient unit even if it fails, so a
retry on a later startup is never blocked by a leftover failed unit.

> **Why NOT `systemd-run --scope`:** a scope child is forked by `systemd-run` itself —
> a descendant of the sandboxed agent — and only its *cgroup* moves. The mount namespace
> (`ProtectSystem=strict`) and the capability bounding set are inherited through
> fork/exec regardless of cgroup, so a scope child would hit the same `Permission
> denied` writing `/etc/systemd/system`. The escape MUST be a transient service.

D-Bus from inside the sandbox is proven viable on the deployed fleet: the self-updater
already calls `systemctl restart breeze-agent` from the sandboxed agent
(`agent/internal/updater/restart_unix.go:30`) and that works in production — the same
PID 1 round-trip `systemd-run` needs.

**New subcommand `service reconcile-unit`** (root-gated, idempotent):
1. Write the current `linuxUnit` to `/etc/systemd/system/breeze-agent.service`.
2. `systemctl daemon-reload`.
3. `systemctl restart breeze-agent` (so the relaxed sandbox takes effect on the live process).

### 5.4 Loop prevention

Structural: the restart in step 3 happens **only after** a successful unit write, and the
freshly written unit carries the current marker. The restarted agent reads it, finds it
current, and skips reconcile — no loop. Belt-and-suspenders: a per-boot guard ensures the
escape is attempted at most once per process lifetime (e.g. an in-process `sync.Once` plus
a short-lived breadcrumb file under `/var/lib/breeze` to suppress repeated attempts if a
write somehow fails).

### 5.5 Graceful fallback (absorbs Option 3)

If `systemd-run` is absent (minimal images), or the transient service cannot be started
(no D-Bus, container without a system manager), the agent does **not** loop or crash. It:
- emits a one-time WARNING to stderr → **journald** under `breeze-agent`, instructing the
  operator to run `sudo breeze-agent service install`, and
- continues running on the old sandbox.

Worst case degrades to "documented manual remediation + a local journald warning," never
to breakage.

> **Known limitation (follow-up candidate):** these warnings reach journald only, not the
> fleet/API. `reconcileServiceUnitIfNeeded` runs at startup *before* the remote log shipper
> is initialized, and the `reconcile-unit` subcommand's own failures are emitted under the
> garbage-collected transient unit's journal. So a host whose auto-heal *fails* stays on the
> old sandboxed unit with no fleet-visible signal — the operator only learns of it if a user
> re-reports the symptom (e.g. `apt` failing in the terminal). Surfacing heal-failure as a
> heartbeat/telemetry flag (so affected hosts are visible in the console without an SSH
> session) is a worthwhile follow-up but is out of scope for this change. Tracked in #1201.

### 5.6 Startup wiring

Rename the cross-platform startup hook `healLaunchdPlistsIfNeeded()` →
`reconcileServiceUnitIfNeeded()` (it is currently a no-op on Linux at
`service_cmd_linux.go:101` and the macOS plist-healer on darwin). Give Linux a real
implementation; keep the darwin body unchanged behind the new name. It is already called
once at startup before the heartbeat loop — early enough that the reconcile-triggered
restart happens before any terminal/script child is spawned.

## 6. Immediate user workaround (independent of this change)

Relayed to the reporting user so they're unblocked today:

```bash
sudo apt -o APT::Sandbox::User=root update
# or persist:
echo 'APT::Sandbox::User "root";' | sudo tee /etc/apt/apt.conf.d/10no-sandbox
```

This tells apt to skip the `_apt` privilege-drop, clearing all `setuid`/`setgid`/`chown`
errors without any agent change.

## 7. Code changes

| # | File | Change |
|---|---|---|
| 1 | `agent/service/systemd/breeze-agent.service` | Relax + version marker + comment |
| 2 | `agent/cmd/breeze-agent/service_cmd_linux.go` | Relax embedded `linuxUnit`; add `currentUnitVersion`, `unitNeedsReconcile`, Linux `reconcileServiceUnitIfNeeded`, the `systemd-run` escape, and the `service reconcile-unit` subcommand |
| 3 | `agent/cmd/breeze-agent/service_cmd_darwin.go` | Rename hook `healLaunchdPlistsIfNeeded` → `reconcileServiceUnitIfNeeded` (no behavior change) |
| 4 | call site (`main.go` / wherever the hook is invoked) | Update to the renamed hook |
| 5 | `agent/cmd/breeze-agent/service_cmd_linux_test.go` (new) | Tests — see §8 |

The watchdog unit (`agent/cmd/breeze-watchdog/service_cmd_linux.go`) is **not** changed.

## 8. Testing (TDD)

Write tests first:

- **`unitNeedsReconcile` table test** — missing marker → true; lower version → true; equal
  → false; higher → false (no downgrade); malformed/garbage marker → true (heal).
- **Drift / anti-re-hardening guard** — assert the static file
  `agent/service/systemd/breeze-agent.service` and the embedded `linuxUnit` are
  byte-identical, both contain `# breeze-unit-version: 2`, and **neither** contains
  `ProtectSystem=strict`, `CapabilityBoundingSet`, `ProtectHome=read-only`, or `PrivateTmp`.
  This is the regression backstop against someone silently re-hardening either copy.

The `systemd-run` escape, the `service reconcile-unit` side effects, and the self-restart
are integration/manual — structured so the decision logic is pure (tested) and the
side-effecting exec is a thin, separately-reviewed wrapper.

## 9. Verification (manual, on a Linux host)

1. Install the **old** hardened unit, start the agent, confirm a terminal `apt update`
   reproduces the `setuid`/`setgid`/`chown` errors and that
   `grep Cap /proc/$(pidof breeze-agent)/status` shows the restricted `CapBnd`.
2. Upgrade to the new binary; on startup observe the reconcile escape rewrite the unit and
   self-restart (journal: unit rewritten, `daemon-reload`, restart).
3. Confirm `CapBnd` of the new agent process is now full (`0x000001ffffffffff`-class) and
   the unit on disk carries `# breeze-unit-version: 2`.
4. Re-run `apt update` in the terminal — succeeds with no privilege errors.
5. Re-run a remote **script** that does `apt update` and writes under `/home` — succeeds.
6. On a host without `systemd-run` (or with D-Bus unavailable), confirm the agent logs the
   one-time WARNING diagnostic and keeps running rather than looping/crashing.

## 10. Security considerations

- The agent already runs as root; relaxing the bounding set does not grant it any privilege
  it could not already obtain via its own terminal/script features. The change widens the
  *agent process'* ambient capability set, but the practical attack surface (root remote
  command execution) is unchanged.
- The `reconcile-unit` subcommand writes a fixed, in-binary unit string to a fixed path and
  is root-gated; it takes no untrusted input.
- `systemd-run` is invoked with a fixed argv (no shell, no interpolation).
- The watchdog remains sandboxed, preserving defense-in-depth for the supervisor that does
  not need elevated behavior.

## 11. Risks / edge cases

- **Non-systemd or container hosts:** `systemd-run` may be missing/unusable → handled by
  §5.5 fallback.
- **Partial write:** restart only follows a successful write (§5.4), so a failed write
  leaves the old (working-but-sandboxed) unit in place and logs the fallback warning.
- **Concurrent fleet restart:** existing `StartLimitBurst`/`RestartSec` backoff is retained;
  the one-time reconcile restart is per-host and not correlated.
- **Drift between the two unit definitions:** prevented by the §8 byte-identical test.
```
