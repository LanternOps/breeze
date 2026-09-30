package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
)

// backupVersionPrefix is the line prefix `breeze-backup --version` prints the
// installed backup helper version under (see cmd/breeze-backup rootCmd.Version
// / SetVersionTemplate).
const backupVersionPrefix = "Breeze Backup Version:"

// backupVersionReadTimeout bounds the exec of the on-disk backup binary so a
// hung/wedged breeze-backup can never stall a heartbeat.
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

// installedBackupVersion returns the version of the breeze-backup helper
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

// readInstalledBackupVersion execs the on-disk breeze-backup binary with
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

// resolveBackupBinaryPath resolves the on-disk path of the breeze-backup
// helper: an explicit config override (backup_binary_path) when set,
// otherwise a sibling of the running agent executable with symlinks resolved.
// This is the SINGLE resolution used by the version probe, reconcile, and the
// upgrade prefetch (see backup_delivery.go) — prior to this they each
// resolved independently: reconcile/prefetch derived the target as a sibling
// of the agent binary and ignored this override entirely (the override
// devices got reinstalled to a path breeze-backup never actually spawns from,
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

// backupBinaryName returns the on-disk filename of the breeze-backup helper
// for the given OS: breeze-backup.exe on Windows, breeze-backup elsewhere.
// Mirrors sessionbroker's unexported backupBinaryName — duplicated here
// rather than exported across a package boundary for one string.
func backupBinaryName(goos string) string {
	if goos == "windows" {
		return "breeze-backup.exe"
	}
	return "breeze-backup"
}

// invalidateBackupVersionCache clears the installedBackupVersion cache
// (including the probe-failure cooldown) so the next heartbeat re-execs
// breeze-backup --version and reports the freshly-installed version, instead
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
	h.backupProtocolRead = false
	h.backupProtocolValue = backupipc.ProtocolInfo{}
	h.backupProtocolRetryAt = time.Time{}
	h.backupProtocolFailures = 0
}

// parseBackupVersion extracts the version from `breeze-backup --version`
// output, which is a single `Breeze Backup Version: <v>` line (see
// cmd/breeze-backup rootCmd.SetVersionTemplate).
func parseBackupVersion(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, backupVersionPrefix); ok {
			return strings.TrimSpace(rest)
		}
	}
	return ""
}

// backupProtocolRetryBase and backupProtocolRetryMax bound how soon a probe
// that ran but got no answer (timeout, crash, unreadable output) is retried:
// 1, 2, 4, 8, then every 10 minutes. The first retries land well inside the
// server's wait for a device's first report, and even the cap stays far
// below the version probe's 30-minute cooldown. Each failed attempt costs at
// most one probe timeout of heartbeat time.
const (
	backupProtocolRetryBase = time.Minute
	backupProtocolRetryMax  = 10 * time.Minute
)

// backupProtocols returns the storage protocol versions the INSTALLED
// breeze-backup helper implements (brokered reads, snapshot integrity,
// brokered writes), all from ONE `breeze-backup --protocol-info` probe, and
// whether the helper answered at all (known).
//
//   - known: the helper answered. Its versions may be 0 (a helper that
//     predates the flag answers 0 for everything; one that predates a single
//     field answers 0 for it). Cached until invalidateBackupVersionCache runs
//     after a helper install.
//   - unknown (probe failed, helper not installed yet, path unresolved): the
//     versions are zero-valued and must not be reported as 0. A failed exec
//     is retried with a short backoff (backupProtocolRetryBase up to
//     backupProtocolRetryMax); a missing or unresolved helper costs no exec
//     and is looked at again on every call.
//
// State changes (known, or unknown with its reason) are logged once each.
func (h *Heartbeat) backupProtocols() (backupipc.ProtocolInfo, bool) {
	h.backupVersionMu.Lock()
	if h.backupProtocolRead {
		v := h.backupProtocolValue
		h.backupVersionMu.Unlock()
		return v, true
	}
	if !h.backupProtocolRetryAt.IsZero() && time.Now().Before(h.backupProtocolRetryAt) {
		h.backupVersionMu.Unlock()
		return backupipc.ProtocolInfo{}, false
	}
	h.backupVersionMu.Unlock()

	read := h.backupProtocolReader
	if read == nil {
		read = h.readInstalledBackupProtocols
	}
	v, outcome := read()
	v = nonNegativeProtocols(v)

	h.backupVersionMu.Lock()
	known := outcome == backupProbeOK
	var state string
	switch outcome {
	case backupProbeOK:
		h.backupProtocolValue = v
		h.backupProtocolRead = true
		h.backupProtocolRetryAt = time.Time{}
		h.backupProtocolFailures = 0
		state = "known"
	case backupProbeFailed:
		h.backupProtocolFailures++
		h.backupProtocolRetryAt = time.Now().Add(backupProtocolRetryDelay(h.backupProtocolFailures))
		v = backupipc.ProtocolInfo{}
		state = "unknown:probe_failed"
	case backupProbeNotInstalled:
		v = backupipc.ProtocolInfo{}
		state = "unknown:not_installed"
	default: // backupProbeUnresolved
		v = backupipc.ProtocolInfo{}
		state = "unknown:path_unresolved"
	}
	changed := state != h.backupProtocolLogState
	h.backupProtocolLogState = state
	logState := h.backupProtocolStateLogger
	h.backupVersionMu.Unlock()

	if changed {
		if logState != nil {
			logState(state)
		} else if known {
			log.Info("backup helper reported its storage protocols",
				"read", v.BackupReadProtocolVersion,
				"integrity", v.BackupIntegrityProtocolVersion,
				"write", v.BackupWriteProtocolVersion)
		} else {
			log.Warn("backup helper protocols unknown; heartbeat reports them as unknown and retries",
				"reason", strings.TrimPrefix(state, "unknown:"))
		}
	}
	return v, known
}

// backupProtocolRetryDelay is the wait after the n-th consecutive failed
// probe (n >= 1): backupProtocolRetryBase doubled per failure, capped at
// backupProtocolRetryMax.
func backupProtocolRetryDelay(n int) time.Duration {
	d := backupProtocolRetryBase
	for i := 1; i < n && d < backupProtocolRetryMax; i++ {
		d *= 2
	}
	if d > backupProtocolRetryMax {
		d = backupProtocolRetryMax
	}
	return d
}

// setBackupProtocols fills the heartbeat's helper-protocol fields: numbers
// when the helper answered (0 included), JSON null for all three when it did
// not (see HeartbeatPayload.BackupReadProtocolVersion).
func (p *HeartbeatPayload) setBackupProtocols(v backupipc.ProtocolInfo, known bool) {
	if !known {
		p.BackupReadProtocolVersion = nil
		p.BackupIntegrityProtocolVersion = nil
		p.BackupWriteProtocolVersion = nil
		return
	}
	read, integrity, write := v.BackupReadProtocolVersion, v.BackupIntegrityProtocolVersion, v.BackupWriteProtocolVersion
	p.BackupReadProtocolVersion = &read
	p.BackupIntegrityProtocolVersion = &integrity
	p.BackupWriteProtocolVersion = &write
}

// nonNegativeProtocols reads any negative version as 0.
func nonNegativeProtocols(v backupipc.ProtocolInfo) backupipc.ProtocolInfo {
	if v.BackupReadProtocolVersion < 0 {
		v.BackupReadProtocolVersion = 0
	}
	if v.BackupIntegrityProtocolVersion < 0 {
		v.BackupIntegrityProtocolVersion = 0
	}
	if v.BackupWriteProtocolVersion < 0 {
		v.BackupWriteProtocolVersion = 0
	}
	return v
}

// unknownFlagMarker is what cobra prints to stderr when a helper is run with a
// flag it does not define — the answer of a helper that predates
// --protocol-info.
const unknownFlagMarker = "unknown flag: --" + backupipc.ProtocolInfoFlag

// readInstalledBackupProtocols execs the on-disk helper with
// --protocol-info. Outcomes:
//   - backupProbeOK: the helper printed its versions, or it predates the flag
//     and rejected it as an unknown flag (a real answer: every version 0).
//   - backupProbeFailed: any other failure — the probe timed out, the helper
//     crashed or exited non-zero for another reason, or its output does not
//     parse. No answer; reported as unknown.
//   - backupProbeNotInstalled / backupProbeUnresolved: no helper to ask yet.
func (h *Heartbeat) readInstalledBackupProtocols() (backupipc.ProtocolInfo, backupProbeOutcome) {
	path, err := h.resolveBackupBinaryPath()
	if err != nil {
		return backupipc.ProtocolInfo{}, backupProbeUnresolved
	}
	if _, statErr := os.Stat(path); statErr != nil {
		return backupipc.ProtocolInfo{}, backupProbeNotInstalled
	}
	timeout := h.backupProtocolTimeout
	if timeout <= 0 {
		timeout = backupVersionReadTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--"+backupipc.ProtocolInfoFlag).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if ctx.Err() == nil && errors.As(err, &exitErr) && strings.Contains(string(exitErr.Stderr), unknownFlagMarker) {
			log.Debug("backup helper predates --protocol-info; reporting every protocol as 0", "path", path)
			return backupipc.ProtocolInfo{}, backupProbeOK
		}
		log.Debug("backup helper did not report protocol info", "path", path, "error", err.Error())
		return backupipc.ProtocolInfo{}, backupProbeFailed
	}
	v, ok := parseBackupProtocols(string(out))
	if !ok {
		log.Debug("backup helper protocol info unparseable", "path", path)
		return backupipc.ProtocolInfo{}, backupProbeFailed
	}
	return v, backupProbeOK
}

// parseBackupProtocols decodes --protocol-info output. ok is false for
// anything that is not a JSON object with integer versions, or whose read
// version is negative (the field every helper with the flag reports). A
// negative integrity or write version reads as 0; an absent one is 0.
func parseBackupProtocols(out string) (backupipc.ProtocolInfo, bool) {
	var info backupipc.ProtocolInfo
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &info); err != nil {
		return backupipc.ProtocolInfo{}, false
	}
	if info.BackupReadProtocolVersion < 0 {
		return backupipc.ProtocolInfo{}, false
	}
	return nonNegativeProtocols(info), true
}
