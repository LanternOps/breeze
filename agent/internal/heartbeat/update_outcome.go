package heartbeat

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/updater"
)

// Detecting and latching a self-update that did not take effect (#9751).
//
// The updater writes the .update-restart marker, holding the target version,
// just before it hands off to the restart path (the detached PowerShell helper
// on Windows, the service manager elsewhere). The next agent start reads it.
// If the running version is the target, the update took. If it is not, the
// process restarted on its previous binary, and on Windows nothing above Info
// was logged on the way (log shipping defaults to warn). This file turns that
// silent outcome into one error-level log with the helper's captured reason
// and a persisted per-version latch (updater.FailureLatch) that doUpgrade
// consults before every attempt.

const (
	updateMarkerName = ".update-restart"
	updateLatchName  = "update-failure-latch.json"
	// The helper script (updater.buildRestartScript) appends its catch-block
	// diagnostics to ${env:TEMP}\breeze-update-failure-<stamp>.log. It runs
	// with the agent's environment, so that is os.TempDir() here.
	updateHelperFailureLogGlob = "breeze-update-failure-*.log"
	// A helper log written up to this long before the marker still belongs
	// to the attempt (filesystem timestamp granularity, clock adjustments).
	updateHelperLogSlack = time.Minute
	// Read at most this much of a helper log; the useful lines are first.
	updateHelperLogReadMax = 16 << 10
	// Each extracted field is cut to this many bytes.
	updateHelperFieldMax = 240

	updateHelperNoLogReason = "the update helper left no failure log: the swap did not run, or the service came back on the previous binary"
)

// updateMarker is the consumed .update-restart marker.
type updateMarker struct {
	Version   string
	WrittenAt time.Time
}

// consumeUpdateMarker reads and removes the marker in the agent config dir.
func consumeUpdateMarker() (updateMarker, bool) {
	return consumeUpdateMarkerAt(filepath.Join(config.ConfigDir(), updateMarkerName))
}

// consumeUpdateMarkerAt reads and removes the marker at path. found is true
// whenever a marker existed, even an empty one written by an older agent.
func consumeUpdateMarkerAt(path string) (updateMarker, bool) {
	fi, err := os.Stat(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("failed to check update marker", "path", path, "error", err.Error())
		}
		return updateMarker{}, false
	}
	m := updateMarker{WrittenAt: fi.ModTime()}
	if fi.Mode().IsRegular() && fi.Size() <= 256 {
		if data, readErr := os.ReadFile(path); readErr == nil {
			m.Version = strings.TrimSpace(string(data))
		}
	}
	if removeErr := os.Remove(path); removeErr != nil {
		log.Warn("failed to remove update marker", "path", path, "error", removeErr.Error())
	}
	return m, true
}

// updateFailureLatch returns the latch, defaulting to the agent config dir.
func (h *Heartbeat) updateFailureLatch() *updater.FailureLatch {
	h.updateLatchOnce.Do(func() {
		if h.updateLatch == nil {
			h.updateLatch = &updater.FailureLatch{Path: filepath.Join(config.ConfigDir(), updateLatchName)}
		}
	})
	return h.updateLatch
}

// reconcileUpdateOutcome records the outcome of the update the marker names.
// Called once at startup, before the first heartbeat can re-offer the version.
func (h *Heartbeat) reconcileUpdateOutcome(m updateMarker) {
	if m.Version == "" {
		return
	}
	latch := h.updateFailureLatch()
	if m.Version == h.agentVersion {
		if prev, ok := latch.Load(); ok {
			log.Info("agent update took effect; clearing the update failure latch",
				"version", h.agentVersion, "latchedVersion", prev.Version, "previousFailures", prev.Failures)
		}
		if err := latch.Clear(); err != nil {
			log.Warn("failed to clear the update failure latch", "error", err.Error())
		}
		return
	}

	logDir := h.updateHelperLogDir
	if logDir == "" {
		logDir = os.TempDir()
	}
	reason := readUpdateHelperFailure(logDir, m.WrittenAt.Add(-updateHelperLogSlack))
	if reason == "" {
		reason = updateHelperNoLogReason
	}
	st, err := latch.NoteFailure(m.Version, reason)
	log.Error("auto-update did not take effect: the agent restarted on its previous version; holding off this version",
		"targetVersion", m.Version,
		"runningVersion", h.agentVersion,
		"consecutiveFailures", st.Failures,
		"retryAfter", st.RetryAt.Sub(st.LastFailureAt).String(),
		"reason", reason)
	if err != nil {
		// Without a persisted latch the next heartbeat retries at once, which
		// is the pre-#9751 loop. Say so at error level so it is visible.
		log.Error("failed to persist the update failure latch; this version will be retried on the next heartbeat",
			"targetVersion", m.Version, "error", err.Error())
	}
}

// upgradeDeferredByFailureLatch reports whether doUpgrade should skip this
// heartbeat's offer of targetVersion because an earlier attempt at the same
// version did not take effect and its wait has not elapsed.
func (h *Heartbeat) upgradeDeferredByFailureLatch(targetVersion string) bool {
	latch := h.updateFailureLatch()
	st, left, blocked := latch.Remaining(targetVersion)
	if blocked {
		log.Debug("upgrade skipped: an earlier attempt at this version did not take effect; backing off",
			"targetVersion", targetVersion, "consecutiveFailures", st.Failures,
			"retryIn", left.Round(time.Second).String())
		return true
	}
	if st.Version == targetVersion && st.Failures > 0 {
		log.Warn("retrying an agent update that previously did not take effect",
			"targetVersion", targetVersion, "previousFailures", st.Failures, "lastReason", st.Reason)
	}
	return false
}

// Backup-busy deferral visibility (#9751). doUpgrade stamps update_status and
// then, when a backup job is running, defers the swap to the next heartbeat.
// That is routine for a short job, but a job that runs for hours or days keeps
// the agent off the offered version with the attempt count climbing and, before
// this, nothing above Info. Warn once per episode, escalate to Error once it
// has lasted backupDeferralEscalateAfter, then repeat daily.
const (
	backupDeferralEscalateAfter = time.Hour
	backupDeferralRelogEvery    = 24 * time.Hour
)

type backupDeferralState struct {
	mu        sync.Mutex
	version   string
	since     time.Time
	lastError time.Time // zero until the episode has been escalated
}

// noteUpgradeDeferredByBackup logs one backup-busy deferral of targetVersion
// at the level its episode has reached, and returns that level ("warn",
// "debug" or "error") for tests.
func (h *Heartbeat) noteUpgradeDeferredByBackup(targetVersion string, now time.Time) string {
	s := &h.upgradeBackupDeferral
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.version != targetVersion || s.since.IsZero() || now.Before(s.since) {
		s.version, s.since, s.lastError = targetVersion, now, time.Time{}
		log.Warn("agent update deferred: a backup job is in progress; retrying each heartbeat until it finishes",
			"targetVersion", targetVersion)
		return "warn"
	}
	deferredFor := now.Sub(s.since)
	if deferredFor >= backupDeferralEscalateAfter &&
		(s.lastError.IsZero() || now.Sub(s.lastError) >= backupDeferralRelogEvery) {
		s.lastError = now
		log.Error("agent update still deferred by an in-progress backup job; the device stays on its current version until the job finishes",
			"targetVersion", targetVersion, "deferredFor", deferredFor.Round(time.Minute).String())
		return "error"
	}
	log.Debug("agent update deferred: backup job still in progress",
		"targetVersion", targetVersion, "deferredFor", deferredFor.Round(time.Second).String())
	return "debug"
}

// clearUpgradeBackupDeferral ends the deferral episode once an upgrade gets
// past the backup-busy check.
func (h *Heartbeat) clearUpgradeBackupDeferral() {
	s := &h.upgradeBackupDeferral
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.since.IsZero() {
		log.Info("agent update no longer deferred by a backup job",
			"targetVersion", s.version, "deferredFor", time.Since(s.since).Round(time.Second).String())
	}
	s.version, s.since, s.lastError = "", time.Time{}, time.Time{}
}

// readUpdateHelperFailure returns a one-line summary of the newest helper
// failure log in dir modified at or after since, and removes every such log it
// considered so the same failure is not reported twice. Returns "" when none
// is found. Older logs are left alone: they predate this attempt.
//
// The file is bounded and only its "exception:" and "operation:" lines are
// used, sanitized to printable text, because %TEMP% may be shared with other
// local accounts and the content ends up in agent_logs.
func readUpdateHelperFailure(dir string, since time.Time) string {
	matches, err := filepath.Glob(filepath.Join(dir, updateHelperFailureLogGlob))
	if err != nil || len(matches) == 0 {
		return ""
	}
	type candidate struct {
		path string
		mod  time.Time
	}
	var fresh []candidate
	for _, p := range matches {
		fi, statErr := os.Lstat(p)
		if statErr != nil || !fi.Mode().IsRegular() || fi.ModTime().Before(since) {
			continue
		}
		fresh = append(fresh, candidate{p, fi.ModTime()})
	}
	if len(fresh) == 0 {
		return ""
	}
	sort.Slice(fresh, func(i, j int) bool { return fresh[i].mod.After(fresh[j].mod) })
	summary := summarizeUpdateHelperLog(fresh[0].path)
	for _, c := range fresh {
		if rmErr := os.Remove(c.path); rmErr != nil && !os.IsNotExist(rmErr) {
			log.Warn("failed to remove update helper failure log", "path", c.path, "error", rmErr.Error())
		}
	}
	return summary
}

func summarizeUpdateHelperLog(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	var exception, operation string
	sc := bufio.NewScanner(io.LimitReader(f, updateHelperLogReadMax))
	sc.Buffer(make([]byte, 0, 4096), updateHelperLogReadMax)
	for sc.Scan() {
		line := strings.TrimPrefix(sc.Text(), "\ufeff")
		// The script appends, so a later block in the same file wins.
		if v, ok := strings.CutPrefix(line, "exception:"); ok {
			exception = sanitizeHelperField(v)
		} else if v, ok := strings.CutPrefix(line, "operation:"); ok {
			operation = sanitizeHelperField(v)
		}
	}
	switch {
	case exception != "" && operation != "":
		return "update helper failed: " + exception + " (operation: " + operation + ")"
	case exception != "":
		return "update helper failed: " + exception
	case operation != "":
		return "update helper failed during: " + operation
	}
	return ""
}

// sanitizeHelperField collapses whitespace, drops control and invalid
// characters, and bounds the length.
func sanitizeHelperField(s string) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return ' '
		}
		if !unicode.IsPrint(r) {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > updateHelperFieldMax {
		s = strings.ToValidUTF8(s[:updateHelperFieldMax], "") + "…"
	}
	return s
}
