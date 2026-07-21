package agentapp

import (
	"fmt"
	"strconv"
	"strings"
)

// currentUnitVersion is the breeze-unit-version this binary ships. Bump it
// whenever linuxUnit changes in a way the deployed fleet must pick up; the
// startup reconcile rewrites any on-disk unit older than this.
// Version 1 is the legacy unversioned/hardened unit (any unit without a marker
// is treated as pre-v2).
// Version 3 adds RuntimeDirectory=breeze so systemd recreates /run/breeze on
// every boot, independent of the tmpfiles.d snippet (issue #1297). Hosts still
// on v2 pick this up on the next agent start via reconcileServiceUnitIfNeeded.
// Version 4 adds RuntimeDirectoryPreserve=yes so an agent restart on a
// partially-upgraded host does NOT remove /run/breeze out from under a still-
// hardened breeze-watchdog (which would re-wedge it at 226/NAMESPACE), and
// corrects a comment that wrongly claimed the agent re-chowns the directory to
// root:breeze at runtime (it relaxes it to 0755 instead).
const currentUnitVersion = 4

const unitVersionPrefix = "# breeze-unit-version:"

// linuxUnit is the canonical systemd unit, embedded so the agent can rewrite
// the installed copy. agent/service/systemd/breeze-agent.service must stay
// byte-identical (enforced by TestStaticUnitMatchesEmbedded).
const linuxUnit = `[Unit]
Description=Breeze RMM Agent
Documentation=https://github.com/breeze-rmm/breeze
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
# breeze-unit-version: 4
Type=simple
ExecStart=/usr/local/bin/breeze-agent start
WorkingDirectory=/etc/breeze
Restart=on-failure

# RuntimeDirectory makes systemd create /run/breeze (root:root 0770) before
# every ExecStart. /run is tmpfs and wiped on reboot; this guarantees the IPC
# socket directory exists at boot WITHOUT depending on the tmpfiles.d snippet
# being present (issue #1297 / regression of #502). The running agent's broker
# relaxes the directory to 0755 (world-traversable) at runtime so the per-user
# helper can traverse it to the socket; the socket itself is 0660 and gated by
# peer-credential + binary-path verification.
# RuntimeDirectoryPreserve=yes keeps /run/breeze across a single unit's
# stop/restart so a restart of this unit does NOT remove the directory out from
# under a still-running, still-hardened breeze-watchdog (which binds it via
# ReadWritePaths and would otherwise wedge at 226/NAMESPACE).
# NOTE: RuntimeDirectory is NOT a sandbox directive — it does not restrict
# child processes — so it does not violate the unsandboxed invariant below.
RuntimeDirectory=breeze
RuntimeDirectoryMode=0770
RuntimeDirectoryPreserve=yes
# 30s cooldown spreads respawn across a fleet that crashes simultaneously
# (e.g. correlated network blip). Combined with StartLimitBurst=5 over
# StartLimitIntervalSec=60, a misbehaving host backs off entirely instead
# of stampeding the API.
RestartSec=30

# Cap total stop time so a hung HTTP flush during OS shutdown (network
# going down) doesn't block system power-off for the 90s systemd default.
# KillMode=mixed sends SIGTERM to the main process, then SIGKILL to the
# whole cgroup after TimeoutStopSec.
TimeoutStopSec=15
KillMode=mixed

# INTENTIONALLY UNSANDBOXED. The remote terminal and remote script execution
# features spawn child processes that must behave like a root SSH session:
#   - package managers drop privileges to unprivileged users (needs CAP_SETUID/SETGID/CHOWN)
#   - admins write under /home, /usr, /etc, and expect a shared /tmp
# systemd sandbox restrictions are INHERITED by those children and silently break
# these operations. Do not re-add them.
# See docs/superpowers/specs/agent/2026-06-09-agent-systemd-sandbox-remote-terminal-design.md

StandardOutput=journal
StandardError=journal
SyslogIdentifier=breeze-agent
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
`

// parseUnitVersion extracts the breeze-unit-version marker from a unit file.
// Returns (version, true) when a well-formed marker is present, else (0, false).
func parseUnitVersion(existing string) (int, bool) {
	for _, line := range strings.Split(existing, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, unitVersionPrefix) {
			continue
		}
		v, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, unitVersionPrefix)))
		if err != nil {
			return 0, false
		}
		return v, true
	}
	return 0, false
}

// unitNeedsReconcile reports whether the on-disk unit is older than what this
// binary ships. Missing/garbage marker or a lower version => reconcile. Equal
// or higher (a newer binary wrote it) => leave it alone, never downgrade.
func unitNeedsReconcile(existing string, want int) bool {
	v, ok := parseUnitVersion(existing)
	if !ok {
		return true
	}
	return v < want
}

// reconcileTransientArgs builds the systemd-run argv for the sandbox-escape that
// rewrites the unit. The invariants below are safety-critical and guarded by
// TestReconcileTransientArgs:
//   - --collect: a failed transient unit is garbage-collected so a later retry
//     is never blocked by a leftover dead unit.
//   - NEVER --scope: a scope child is forked from the (sandboxed) agent and
//     inherits its mount namespace + capability bounding set, so it would fail
//     to write /etc/systemd/system exactly like the agent — defeating the escape.
//   - PID-suffixed unit name: if the restart the child triggers races a freshly
//     started agent into reconcile again, the two transient units can't collide
//     (--collect only reaps dead units, not a still-running one).
func reconcileTransientArgs(pid int, binPath string) []string {
	return []string{
		"--quiet", "--collect",
		fmt.Sprintf("--unit=breeze-unit-reconcile-%d", pid),
		binPath, "service", "reconcile-unit",
	}
}
