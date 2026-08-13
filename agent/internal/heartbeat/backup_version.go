package heartbeat

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// backupVersionPrefix is the line prefix `nu-backup --version` prints the
// installed backup helper version under (see cmd/nu-backup rootCmd.Version
// / SetVersionTemplate).
const backupVersionPrefix = "Breeze Backup Version:"

// backupVersionReadTimeout bounds the exec of the on-disk backup binary so a
// hung/wedged nu-backup can never stall a heartbeat.
const backupVersionReadTimeout = 5 * time.Second

// backupVersionProbeCooldown bounds how often a FAILING `--version` probe is
// retried. Without this, a binary that predates --version (or is otherwise
// permanently broken) gets re-exec'd on every heartbeat forever — up to
// backupVersionReadTimeout (5s) of synchronous stall on a 60s tick. A
// successful probe, or a fresh install via invalidateBackupVersionCache,
// clears the cooldown immediately so reconcile's replacement is picked up
// right away rather than waiting out a stale cooldown window.
const backupVersionProbeCooldown = 30 * time.Minute

// backupProbeOutcome distinguishes WHY installedBackupVersion returned "" so
// callers — specifically reconcileBackupHelper — can react differently:
//
//   - backupProbeNotInstalled: no binary on disk. Reconcile's own stat check
//     already handles this case independently; the outcome exists mainly so
//     it is cached differently from a probe failure (see below).
//   - backupProbeFailed: a binary IS present but the --version probe did not
//     produce a trustworthy version — non-zero exit, timeout, or output that
//     doesn't parse (most commonly a pre-#1802 binary that predates the
//     --version flag entirely). This is a legacy/broken install: exactly what
//     reconcileBackupHelper exists to replace. Treating it the same as
//     "healthy" — the previous `installed != ""` guard — strands every such
//     binary in the fleet unpatched forever, since the version-mismatch check
//     never fires. Cached for backupVersionProbeCooldown so a permanently
//     broken binary doesn't re-pay the exec cost every tick.
//   - backupProbeUnresolved: the binary's own path could not even be
//     determined (resolveBackupBinaryPath/os.Executable failed). Rare and
//     transient — never cached, retried on the very next call.
//   - backupProbeOK: the probe produced a version string worth trusting.
type backupProbeOutcome int

const (
	backupProbeOK backupProbeOutcome = iota
	backupProbeNotInstalled
	backupProbeFailed
	backupProbeUnresolved
)

// installedBackupVersion returns the version of the nu-backup helper
// currently installed on this device, for reporting in the normal heartbeat so
// the server can keep devices.backup_version fresh and drive auto-update for
// the component (mirrors installedWatchdogVersion / #1802). Callers that need
// to distinguish WHY an empty result was returned (reconcileBackupHelper) use
// installedBackupVersionOutcome instead.
func (h *Heartbeat) installedBackupVersion() string {
	v, _ := h.installedBackupVersionOutcome()
	return v
}

// installedBackupVersionOutcome is installedBackupVersion plus the outcome
// that produced its result. Caching differs by outcome:
//
//   - backupProbeOK / backupProbeNotInstalled: durably cached for the
//     process lifetime (until invalidateBackupVersionCache runs after a
//     fresh install).
//   - backupProbeFailed: cached for backupVersionProbeCooldown so a
//     persistently-failing exec doesn't stall every heartbeat.
//   - backupProbeUnresolved: never cached — retried on the very next call
//     (Finding: a transient os.Executable failure must not be mistaken for a
//     stable "not installed" and suppress telemetry for the process
//     lifetime).
func (h *Heartbeat) installedBackupVersionOutcome() (string, backupProbeOutcome) {
	h.backupVersionMu.Lock()
	if h.backupVersionRead {
		v, outcome := h.backupVersionDisk, h.backupVersionOutcome
		h.backupVersionMu.Unlock()
		return v, outcome
	}
	if h.backupVersionOutcome == backupProbeFailed && time.Since(h.backupVersionProbeFailedAt) < backupVersionProbeCooldown {
		h.backupVersionMu.Unlock()
		return "", backupProbeFailed
	}
	h.backupVersionMu.Unlock()

	read := h.backupVersionReader
	if read == nil {
		read = h.readInstalledBackupVersion
	}
	v, outcome := read()

	// Compute cache disposition under the lock, emit the (throttled) WARN
	// after releasing it. The ship-to-server WARN for an unreadable backup
	// helper is throttled to once per failure streak (re-armed on the next
	// OK/notInstalled read) so a wedged/old binary doesn't emit ~1
	// warn/heartbeat; per-tick detail stays at Debug in the reader.
	h.backupVersionMu.Lock()
	var warnUnreadable bool
	switch outcome {
	case backupProbeOK, backupProbeNotInstalled:
		h.backupVersionDisk = v
		h.backupVersionOutcome = outcome
		h.backupVersionRead = true
		h.backupVersionReadWarned = false
	case backupProbeFailed:
		h.backupVersionDisk = ""
		h.backupVersionOutcome = backupProbeFailed
		h.backupVersionProbeFailedAt = time.Now()
		// backupVersionRead intentionally stays false: this is a
		// time-bounded cooldown (checked above), not a durable cache.
		if !h.backupVersionReadWarned {
			h.backupVersionReadWarned = true
			warnUnreadable = true
		}
	default: // backupProbeUnresolved
		h.backupVersionDisk = ""
		h.backupVersionOutcome = backupProbeUnresolved
		if !h.backupVersionReadWarned {
			h.backupVersionReadWarned = true
			warnUnreadable = true
		}
	}
	h.backupVersionMu.Unlock()

	if warnUnreadable {
		log.Warn("installed backup helper version unreadable; heartbeat will omit it and retry (suppressing repeat logs until it recovers)")
	}
	return v, outcome
}

// readInstalledBackupVersion execs the on-disk nu-backup binary with
// --version and parses the version it prints. See backupProbeOutcome for what
// each returned outcome means and how it is cached.
func (h *Heartbeat) readInstalledBackupVersion() (string, backupProbeOutcome) {
	path, err := h.resolveBackupBinaryPath()
	if err != nil {
		// Transient: os.Executable() can fail momentarily. Caching this as a
		// stable "not installed" would silently suppress backup-version
		// telemetry (and mask a present-but-unprobed binary from reconcile)
		// for the rest of the process lifetime.
		log.Debug("could not resolve backup helper path; will retry", "error", err.Error())
		return "", backupProbeUnresolved
	}
	if _, statErr := os.Stat(path); statErr != nil {
		return "", backupProbeNotInstalled
	}

	ctx, cancel := context.WithTimeout(context.Background(), backupVersionReadTimeout)
	defer cancel()

	out, err := exec.CommandContext(ctx, path, "--version").Output()
	if err != nil {
		// Installed but unreadable. Per-tick detail at Debug (local-only); the
		// caller emits the throttled WARN that actually ships. Cached for
		// backupVersionProbeCooldown — see backupProbeFailed's doc.
		log.Debug("could not read installed backup helper version",
			"path", path, "error", err.Error())
		return "", backupProbeFailed
	}
	version := parseBackupVersion(string(out))
	if version == "" {
		// Exec succeeded but the output didn't carry the expected "Breeze
		// Backup Version:" line — e.g. a pre-#1802 binary that doesn't
		// understand --version and printed usage/an error to stdout instead.
		// Same bucket as an outright exec failure: present, but not a version
		// we can trust, so reconcile must treat it as needing a replace.
		log.Debug("installed backup helper --version output unparseable", "path", path)
		return "", backupProbeFailed
	}
	return version, backupProbeOK
}

// resolveBackupBinaryPath resolves the on-disk path of the nu-backup
// helper: an explicit config override (backup_binary_path) when set,
// otherwise a sibling of the running agent executable with symlinks resolved.
// This is the SINGLE resolution used by the version probe, reconcile, and the
// upgrade prefetch (see backup_delivery.go) — prior to this they each
// resolved independently: reconcile/prefetch derived the target as a sibling
// of the agent binary and ignored this override entirely (the override
// devices got reinstalled to a path nu-backup never actually spawns from,
// every 30 minutes, forever), while this version probe resolved os.Executable()
// without EvalSymlinks, disagreeing with reconcile's resolution on symlinked
// installs. One resolution, three consumers.
func (h *Heartbeat) resolveBackupBinaryPath() (string, error) {
	if h.backupBinaryPath != "" {
		return h.backupBinaryPath, nil
	}
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, symErr := filepath.EvalSymlinks(self); symErr == nil {
		self = resolved
	}
	return filepath.Join(filepath.Dir(self), backupBinaryName(runtime.GOOS)), nil
}

// backupBinaryName returns the on-disk filename of the nu-backup helper
// for the given OS: nu-backup.exe on Windows, nu-backup elsewhere.
// Mirrors sessionbroker's unexported backupBinaryName — duplicated here
// rather than exported across a package boundary for one string.
func backupBinaryName(goos string) string {
	if goos == "windows" {
		return "nu-backup.exe"
	}
	return "nu-backup"
}

// invalidateBackupVersionCache clears the installedBackupVersion cache
// (including the probe-failure cooldown) so the next heartbeat re-execs
// nu-backup --version and reports the freshly-installed version, instead
// of continuing to report the pre-install cached value — or a stale
// probe-failure cooldown for a binary that was JUST replaced — for the rest
// of the process lifetime. Called after installBackupBinary successfully
// swaps the binary (upgrade prefetch swap or reconcile install) — both of
// which change what's on disk without going through readInstalledBackupVersion
// itself.
func (h *Heartbeat) invalidateBackupVersionCache() {
	h.backupVersionMu.Lock()
	defer h.backupVersionMu.Unlock()
	h.backupVersionRead = false
	h.backupVersionDisk = ""
	h.backupVersionOutcome = backupProbeOK
	h.backupVersionProbeFailedAt = time.Time{}
	h.backupVersionReadWarned = false
}

// parseBackupVersion extracts the version from `nu-backup --version`
// output, which is a single `Breeze Backup Version: <v>` line (see
// cmd/nu-backup rootCmd.SetVersionTemplate).
func parseBackupVersion(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, backupVersionPrefix); ok {
			return strings.TrimSpace(rest)
		}
	}
	return ""
}
