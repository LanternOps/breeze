package heartbeat

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// watchdogStatusVersionPrefix is the line prefix `breeze-watchdog status` prints
// the installed watchdog version under (see cmd/breeze-watchdog printStatus).
const watchdogStatusVersionPrefix = "Watchdog Version:"

// watchdogVersionReadTimeout bounds the exec of the on-disk watchdog binary so a
// hung/wedged watchdog can never stall a heartbeat.
const watchdogVersionReadTimeout = 5 * time.Second

// installedWatchdogVersion returns the version of the watchdog currently
// installed on this device, for reporting in the normal heartbeat so the server
// can keep devices.watchdog_version fresh (it was previously only written from
// watchdog FAILOVER heartbeats, so a recovered, healthy watchdog left the
// dashboard showing the OLD version and the server re-sending watchdogUpgradeTo
// forever — #1802).
//
// Resolution order:
//  1. watchdogInstalledVersion — authoritative after a successful swap THIS run.
//  2. a cached on-disk read — the binary is exec'd at most once per process run.
//
// Returns "" when the version can't be determined (no watchdog installed, an
// older watchdog without a parseable `status`, or a read error); the server
// treats an absent value as "unknown" and leaves the stored value untouched.
func (h *Heartbeat) installedWatchdogVersion() string {
	h.watchdogUpgradeMu.Lock()
	if h.watchdogInstalledVersion != "" {
		v := h.watchdogInstalledVersion
		h.watchdogUpgradeMu.Unlock()
		return v
	}
	if h.watchdogVersionRead {
		v := h.watchdogVersionDisk
		h.watchdogUpgradeMu.Unlock()
		return v
	}
	h.watchdogUpgradeMu.Unlock()

	read := h.watchdogVersionReader
	if read == nil {
		read = readInstalledWatchdogVersion
	}
	v := read()

	h.watchdogUpgradeMu.Lock()
	h.watchdogVersionDisk = v
	h.watchdogVersionRead = true
	h.watchdogUpgradeMu.Unlock()
	return v
}

// readInstalledWatchdogVersion execs the on-disk watchdog binary's `status`
// subcommand and parses the version it prints. Returns "" on any failure (binary
// absent, exec error, timeout, or no version line) — telemetry is best-effort
// and must never fail or stall the heartbeat.
func readInstalledWatchdogVersion() string {
	path, err := watchdogBinaryPath()
	if err != nil || path == "" {
		return ""
	}
	if _, statErr := os.Stat(path); statErr != nil {
		return ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), watchdogVersionReadTimeout)
	defer cancel()

	out, err := exec.CommandContext(ctx, path, "status").Output()
	if err != nil {
		return ""
	}
	return parseWatchdogStatusVersion(string(out))
}

// parseWatchdogStatusVersion extracts the version from `breeze-watchdog status`
// output, which leads with a `Watchdog Version: <v>` line.
func parseWatchdogStatusVersion(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, watchdogStatusVersionPrefix); ok {
			return strings.TrimSpace(rest)
		}
	}
	return ""
}
