package main

import (
	"strconv"
	"strings"
)

// currentUnitVersion is the breeze-unit-version this binary ships. Bump it
// whenever linuxUnit changes in a way the deployed fleet must pick up; the
// startup reconcile rewrites any on-disk unit older than this.
// Version 1 is the legacy unversioned/hardened unit (any unit without a marker
// is treated as pre-v2).
const currentUnitVersion = 2

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
# breeze-unit-version: 2
Type=simple
ExecStart=/usr/local/bin/breeze-agent start
WorkingDirectory=/etc/breeze
Restart=on-failure
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
#   - package managers drop privileges to unprivileged users (needs CAP_SETUID/SETGID)
#   - admins write under /home, /usr, /etc, and expect a shared /tmp
# systemd sandbox restrictions are INHERITED by those children and silently break
# these operations. Do not re-add them.
# See docs/superpowers/specs/2026-06-09-agent-systemd-sandbox-remote-terminal-design.md

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
