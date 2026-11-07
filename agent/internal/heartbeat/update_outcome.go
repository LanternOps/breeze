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
// on Windows, the service manager elsewhere), and removes it again if the
// update fails before that hand-off. The next agent start reads it. If the
// running version is the target, the update took. If it is not, the process
// came back on its previous binary, and on Windows nothing above Info was
// logged on the way (log shipping defaults to warn). This file turns that
// silent outcome into one error-level log with the helper's captured reason
// and a persisted per-version latch (updater.FailureLatch) that doUpgrade
// consults before every attempt.

const (
	updateLatchName = "update-failure-latch.json"
	// The Windows helper (updater.buildRestartScript) appends its catch-block
	// diagnostics to ${env:TEMP}\<prefix><stamp>.log. It runs with the
	// agent's environment, so that is os.TempDir() here.
	updateHelperFailureLogGlob = updater.UpdateHelperFailureLogPrefix + "*.log"
	// A helper log written up to this long before the marker still belongs
	// to the attempt (filesystem timestamp granularity, clock adjustments).
	updateHelperLogSlack = time.Minute
	// Read at most this much of a helper log; the useful lines are first.
	updateHelperLogReadMax = 16 << 10
	// Each extracted field is cut to this many bytes.
	updateHelperFieldMax = 240

	updateHelperNoLogReason       = "no update-helper failure log was found; the swap did not run, or the agent came back on its previous binary"
	updateHelperUnparseableReason = "an update-helper failure log was found but held no exception or operation line"
)

// updateMarker is the consumed .update-restart marker.
type updateMarker struct {
	Version   string
	WrittenAt time.Time
}

// consumeUpdateMarkerAt reads and removes the marker at path. found is true
// whenever a marker existed, even an empty one written by an older agent.
func consumeUpdateMarkerAt(path string) (updateMarker, bool) {
	fi, err := os.Lstat(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("failed to check update marker; cannot tell whether the last update took effect",
				"path", path, "error", err.Error())
		}
		return updateMarker{}, false
	}
	m := updateMarker{WrittenAt: fi.ModTime()}
	switch {
	case !fi.Mode().IsRegular() || fi.Size() > 256:
		log.Warn("update marker is not a small regular file; ignoring its contents",
			"path", path, "size", fi.Size())
	default:
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			log.Warn("failed to read update marker; cannot tell whether the last update took effect",
				"path", path, "error", readErr.Error())
		} else {
			m.Version = strings.TrimSpace(string(data))
		}
	}
	if removeErr := os.Remove(path); removeErr != nil {
		log.Warn("failed to remove update marker", "path", path, "error", removeErr.Error())
	}
	return m, true
}

// startupUpdateReconcile consumes the marker at markerPath and records the
// outcome of the update it names. Start() calls it before the first
// heartbeat, because that heartbeat re-offers the target and a version whose
// swap did not take must already be latched by then. Returns whether a marker
// existed (the process restarted for an update, so jitter is skipped).
func (h *Heartbeat) startupUpdateReconcile(markerPath string) (updateMarker, bool) {
	marker, found := consumeUpdateMarkerAt(markerPath)
	h.reconcileUpdateOutcome(marker)
	return marker, found
}

func defaultUpdateMarkerPath() string {
	return filepath.Join(config.ConfigDir(), updater.UpdateMarkerName)
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
//
// The hold and the retry after it are each logged at warn once per latch state
// (version + failure time) per process, so they are visible without repeating
// on every heartbeat.
func (h *Heartbeat) upgradeDeferredByFailureLatch(targetVersion string) bool {
	st, left, blocked := h.updateFailureLatch().Remaining(targetVersion)
	if st.Version != targetVersion || st.Failures < 1 {
		return false
	}
	if blocked {
		if h.firstLatchNotice("hold", st) {
			log.Warn("agent update held back: an earlier attempt at this version did not take effect",
				"targetVersion", targetVersion, "consecutiveFailures", st.Failures,
				"retryIn", left.Round(time.Second).String(), "lastReason", st.Reason)
		} else {
			log.Debug("upgrade skipped: update failure latch still active",
				"targetVersion", targetVersion, "retryIn", left.Round(time.Second).String())
		}
		return true
	}
	if h.firstLatchNotice("retry", st) {
		log.Warn("retrying an agent update that previously did not take effect",
			"targetVersion", targetVersion, "previousFailures", st.Failures, "lastReason", st.Reason)
	}
	return false
}

// firstLatchNotice reports whether this is the first time this process sees
// the given kind of notice for this latch state.
func (h *Heartbeat) firstLatchNotice(kind string, st updater.FailureLatchState) bool {
	key := kind + "|" + st.Version + "|" + st.LastFailureAt.UTC().Format(time.RFC3339Nano)
	h.updateLatchNoticeMu.Lock()
	defer h.updateLatchNoticeMu.Unlock()
	if h.updateLatchNoticeKey == key {
		return false
	}
	h.updateLatchNoticeKey = key
	return true
}

// Backup-busy deferral visibility (#9751). doUpgrade stamps update_status and
// then, when a backup job is running, defers the swap to the next heartbeat.
// That is routine for a short job, but a job that runs for hours or days keeps
// the agent off the offered version with the attempt count climbing and, before
// this, nothing above Info. Warn once per episode, escalate to Error once it
// has lasted backupDeferralEscalateAfter, then repeat daily. A gap longer than
// backupDeferralEpisodeGap since the last deferral starts a new episode, so a
// deferral days after an unrelated one is not reported as one long episode.
const (
	backupDeferralEscalateAfter = time.Hour
	backupDeferralRelogEvery    = 24 * time.Hour
	backupDeferralEpisodeGap    = 15 * time.Minute
)

type backupDeferralState struct {
	mu        sync.Mutex
	version   string
	since     time.Time
	lastSeen  time.Time
	lastError time.Time // zero until the episode has been escalated
}

// backupDeferralGap is the silence that ends an episode: backupDeferralEpisodeGap,
// or two heartbeats when the configured interval is slower than that allows.
func (h *Heartbeat) backupDeferralGap() time.Duration {
	gap := backupDeferralEpisodeGap
	if h.config != nil {
		if twoBeats := 2 * time.Duration(h.config.HeartbeatIntervalSeconds) * time.Second; twoBeats > gap {
			gap = twoBeats
		}
	}
	return gap
}

// noteUpgradeDeferredByBackup logs one backup-busy deferral of targetVersion
// at the level its episode has reached, and returns that level ("warn",
// "debug" or "error").
func (h *Heartbeat) noteUpgradeDeferredByBackup(targetVersion string, now time.Time) string {
	s := &h.upgradeBackupDeferral
	s.mu.Lock()
	defer s.mu.Unlock()
	level := "debug"
	switch {
	case s.version != targetVersion || s.since.IsZero() || now.Before(s.lastSeen) ||
		now.Sub(s.lastSeen) > h.backupDeferralGap():
		s.version, s.since, s.lastError = targetVersion, now, time.Time{}
		level = "warn"
	case now.Sub(s.since) >= backupDeferralEscalateAfter &&
		(s.lastError.IsZero() || now.Sub(s.lastError) >= backupDeferralRelogEvery):
		s.lastError = now
		level = "error"
	}
	s.lastSeen = now
	deferredFor := now.Sub(s.since).Round(time.Minute).String()
	switch level {
	case "warn":
		log.Warn("agent update deferred: a backup job is in progress; retrying each heartbeat until it finishes",
			"targetVersion", targetVersion)
	case "error":
		log.Error("agent update still deferred by an in-progress backup job; the device stays on its current version until the job finishes",
			"targetVersion", targetVersion, "deferredFor", deferredFor)
	default:
		log.Debug("agent update deferred: backup job still in progress",
			"targetVersion", targetVersion, "deferredFor", deferredFor)
	}
	return level
}

// clearUpgradeBackupDeferral ends the deferral episode once an upgrade gets
// past the backup-busy check.
func (h *Heartbeat) clearUpgradeBackupDeferral() {
	s := &h.upgradeBackupDeferral
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.since.IsZero() {
		log.Info("agent update no longer deferred by a backup job",
			"targetVersion", s.version, "deferredFor", s.lastSeen.Sub(s.since).Round(time.Second).String())
	}
	// Field by field: assigning a zero struct would also zero the held mutex.
	s.version, s.since, s.lastSeen, s.lastError = "", time.Time{}, time.Time{}, time.Time{}
}

// readUpdateHelperFailure returns a one-line summary of the newest helper
// failure log in dir modified at or after since, and removes every such log it
// considered so the same failure is not reported twice. Returns "" when none
// is found, and updateHelperUnparseableReason when one was found but yielded
// nothing. Older logs are left alone: they predate this attempt.
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
	if summary == "" {
		summary = updateHelperUnparseableReason
	}
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
		log.Warn("failed to open update helper failure log", "path", path, "error", err.Error())
		return ""
	}
	defer func() { _ = f.Close() }() // read-only handle; close errors carry no information here
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
	if scanErr := sc.Err(); scanErr != nil {
		// Keep whatever was parsed before the bad line.
		log.Warn("update helper failure log only partly readable", "path", path, "error", scanErr.Error())
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
