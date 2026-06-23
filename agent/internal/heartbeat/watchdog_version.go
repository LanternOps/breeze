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
// Returns "" when the version can't be determined; the server treats an absent
// value as "unknown" and leaves the stored value untouched. A read is cached
// only when its result is STABLE (unsupported platform, or watchdog not
// installed): a *transient* read failure (e.g. the exec timed out under load) is
// NOT cached, so it retries on the next heartbeat rather than silently
// suppressing telemetry for the whole process lifetime — which would re-create
// the exact #1802 staleness through a narrower door.
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
	v, stable := read()

	// Cache only STABLE results; a transient failure retries next tick. The
	// ship-to-server WARN for an unreadable watchdog is throttled to once per
	// failure streak (re-armed on the next stable read) so a wedged/old watchdog
	// doesn't emit ~1 warn/heartbeat — per-tick detail stays at Debug in the
	// reader. Compute under the lock, emit after releasing it.
	h.watchdogUpgradeMu.Lock()
	var warnUnreadable bool
	if stable {
		h.watchdogVersionDisk = v
		h.watchdogVersionRead = true
		h.watchdogVersionReadWarned = false
	} else if !h.watchdogVersionReadWarned {
		h.watchdogVersionReadWarned = true
		warnUnreadable = true
	}
	h.watchdogUpgradeMu.Unlock()

	if warnUnreadable {
		log.Warn("installed watchdog version unreadable; heartbeat will omit it and retry (suppressing repeat logs until it recovers) — #1802")
	}
	return v
}

// readInstalledWatchdogVersion execs the on-disk watchdog binary's `status`
// subcommand and parses the version it prints. It returns (version, stable):
//   - ("", true)  — unsupported platform or watchdog not installed. A STABLE
//     state worth caching; a bootstrap install + swap will set the in-memory
//     version (which takes priority) once one happens.
//   - ("", false) — the binary exists but couldn't be read (exec error, timeout,
//     or an old watchdog without `status`). TRANSIENT: not cached so it retries.
//     The detail is logged at Debug here (per tick, local-only); the caller
//     emits a throttled, ship-to-server WARN once per failure streak. Telemetry
//     is best-effort and never fails or stalls the heartbeat regardless.
//   - (version, true) — read succeeded.
func readInstalledWatchdogVersion() (string, bool) {
	path, err := watchdogBinaryPath()
	if err != nil || path == "" {
		return "", true // unsupported platform — stable
	}
	if _, statErr := os.Stat(path); statErr != nil {
		return "", true // not installed — stable; bootstrap+swap will set it
	}

	ctx, cancel := context.WithTimeout(context.Background(), watchdogVersionReadTimeout)
	defer cancel()

	out, err := exec.CommandContext(ctx, path, "status").Output()
	if err != nil {
		// Installed but unreadable. Per-tick detail at Debug (local-only); the
		// caller emits the throttled WARN that actually ships. Don't cache so a
		// transient failure retries.
		log.Debug("could not read installed watchdog version",
			"path", path, "error", err.Error())
		return "", false
	}
	return parseWatchdogStatusVersion(string(out)), true
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
