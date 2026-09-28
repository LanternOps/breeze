package helper

import (
	"errors"
	"fmt"
	"os"
	"time"
)

// Rollback of a failed helper update (#6869).
//
// os.Rename on Windows is MoveFileEx(MOVEFILE_REPLACE_EXISTING), which fails
// with ERROR_ACCESS_DENIED while the target exe is mapped by a running
// process. applyPendingUpdate stops every helper before the install (#7113),
// but one relaunched by msiexec's Restart Manager, or one whose chat started
// after the pre-update gate, can still hold breeze-helper.exe when the
// rollback runs.

var (
	// renameFunc and rollbackSleepFunc are seams for the rollback tests.
	renameFunc        = os.Rename
	rollbackSleepFunc = time.Sleep
)

// rollbackRetryDelays is the backoff between restore attempts after the first
// one fails. The caller holds Manager.mu on the heartbeat goroutine, so the
// total stays at a few seconds: long enough for a terminated process to finish
// unmapping its image or an AV scan of the fresh exe to finish, short enough
// not to stall the heartbeat.
var rollbackRetryDelays = []time.Duration{
	250 * time.Millisecond,
	500 * time.Millisecond,
	1 * time.Second,
	2 * time.Second,
}

// rollbackBinaryLocked restores the pre-update backup over the helper binary
// after a failed update. preVersion is the binary's version read before the
// install ("" when unknown). Every tracked session must already be stopped.
//
// The backup is restored only when it still matches the copy recorded when it
// was written (#7113): a truncated or replaced file is never put back as the
// helper. A damaged backup is removed; one that cannot be read is kept.
//
// Outcomes:
//   - restored: the backup is consumed by the rename, nothing is left behind;
//   - the rename keeps failing but the exe is still the pre-update build:
//     there is nothing to restore, so the duplicate backup is removed;
//   - the rename keeps failing and the exe changed: the backup is the only
//     good copy and is kept, and the failure is logged as an error.
//
// Must be called with m.mu held.
func (m *Manager) rollbackBinaryLocked(backup helperBackup, preVersion string) {
	if err := backup.verify(); err != nil {
		switch {
		case errors.Is(err, os.ErrNotExist):
			log.Warn("no helper backup to roll back to", "backup", backup.path, "error", err.Error())
		case errors.Is(err, errBackupMismatch):
			log.Error("refusing to roll back to a damaged helper backup, discarded it",
				"backup", backup.path, "path", m.binaryPath, "error", err.Error())
			if rmErr := os.Remove(backup.path); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
				log.Warn("failed to remove damaged helper backup", "backup", backup.path, "error", rmErr.Error())
			}
		default:
			log.Error("cannot verify helper backup, not rolling back, backup kept",
				"backup", backup.path, "path", m.binaryPath, "error", err.Error())
		}
		return
	}
	backupPath := backup.path

	err := renameFunc(backupPath, m.binaryPath)
	if err == nil {
		log.Info("rolled back helper binary", "path", m.binaryPath)
		return
	}
	firstErr := err

	// Something still has the exe open. The likeliest holder is a helper
	// process running from it; stop every one, in any session, then retry.
	stoppedPIDs := m.stopAllHelperInstancesLocked()
	attempts := 1
	for _, delay := range rollbackRetryDelays {
		rollbackSleepFunc(delay)
		attempts++
		if err = renameFunc(backupPath, m.binaryPath); err == nil {
			log.Warn("rolled back helper binary after retrying",
				"path", m.binaryPath, "attempts", attempts,
				"firstError", firstErr.Error(), "stoppedPids", stoppedPIDs)
			return
		}
	}

	if preVersion != "" {
		onDisk, verr := m.readBinaryVersion()
		if verr == nil && helperVersionsMatch(onDisk, preVersion) {
			if rmErr := os.Remove(backupPath); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
				log.Warn("failed to remove helper backup", "backup", backupPath, "error", rmErr.Error())
			}
			log.Warn("helper rollback not needed: binary is still the pre-update build, discarded the backup",
				"path", m.binaryPath, "version", onDisk, "attempts", attempts,
				"error", err.Error(), "stoppedPids", stoppedPIDs)
			return
		}
	}
	log.Error("failed to rollback helper, backup kept",
		"path", m.binaryPath, "backup", backupPath, "attempts", attempts,
		"error", err.Error(), "stoppedPids", stoppedPIDs)
}

// stopAllHelperInstancesLocked terminates every running process whose image
// is the helper binary, in any session, and returns the PIDs it stopped. The
// rollback uses it: the helpers it kills would otherwise keep a failed or
// half-installed exe mapped. An instance with an active chat is left running:
// a chat can start after the pre-update gate, and dropping it to free the exe
// is worse than keeping the backup and retrying on a later heartbeat. Must be
// called with m.mu held.
func (m *Manager) stopAllHelperInstancesLocked() []int {
	stopped, _, _ := m.stopHelperInstancesLocked(nil)
	return stopped
}

// stopHelperInstancesLocked terminates every running helper process whose
// session is not in skip. It returns the PIDs it stopped, the PIDs it left
// running because their chat is active, and the stop failures joined. An
// enumeration failure is logged and treated as "none found", which degrades
// the caller to stopping tracked sessions only. Must be called with m.mu held.
func (m *Manager) stopHelperInstancesLocked(skip map[string]bool) (stopped, busy []int, err error) {
	all, listErr := listHelperInstancesFunc(m.binaryPath)
	if listErr != nil {
		log.Warn("failed to enumerate breeze assist processes", "error", listErr.Error())
		return nil, nil, nil
	}
	var errs []error
	for _, inst := range all {
		if inst.PID <= 0 || skip[inst.SessionKey] {
			continue
		}
		if m.instanceChatActiveLocked(inst) {
			log.Warn("not stopping breeze assist holding the helper binary: chat active",
				"pid", inst.PID, "session", inst.SessionKey)
			busy = append(busy, inst.PID)
			continue
		}
		killed, stopErr := m.stopIfOursFunc(inst.PID, m.binaryPath)
		if stopErr != nil {
			log.Warn("failed to stop breeze assist holding the helper binary",
				"pid", inst.PID, "session", inst.SessionKey, "error", stopErr.Error())
			errs = append(errs, fmt.Errorf("pid %d (session %s): %w", inst.PID, inst.SessionKey, stopErr))
			continue
		}
		if killed {
			stopped = append(stopped, inst.PID)
		}
	}
	return stopped, busy, errors.Join(errs...)
}

// instanceChatActiveLocked reports whether a running helper, tracked or not,
// is mid-chat. A helper spawned with --config writes its per-session status; a
// helper started without it (by hand, or by an old autostart entry) writes the
// legacy root status instead, which counts when it names this PID or names
// none. Must be called with m.mu held.
func (m *Manager) instanceChatActiveLocked(inst helperInstance) bool {
	if inst.SessionKey != "" && !IsIdle(newSessionState(inst.SessionKey, m.baseDir).configPath) {
		return true
	}
	// The PID match stands in for IsIdle's liveness check: inst was just found
	// running.
	status, err := ReadStatus(m.legacyConfigPath())
	if err != nil || (status.PID > 0 && status.PID != inst.PID) {
		return false
	}
	return status.ChatActive && time.Since(status.LastActivity) <= idleTimeout
}

// untrackedChatActiveLocked reports whether any running helper outside the
// tracked sessions is mid-chat. allSessionsIdle reads only tracked sessions,
// and the console-only enumerator never tracks an RDP session (#7113). An
// enumeration failure is logged and reported as "no chat": the update then
// proceeds as it did before this check existed. Must be called with m.mu held.
func (m *Manager) untrackedChatActiveLocked() bool {
	all, err := listHelperInstancesFunc(m.binaryPath)
	if err != nil {
		log.Warn("failed to enumerate breeze assist processes before update", "error", err.Error())
		return false
	}
	for _, inst := range all {
		if inst.PID <= 0 {
			continue
		}
		if _, tracked := m.sessions[inst.SessionKey]; tracked {
			continue
		}
		if m.instanceChatActiveLocked(inst) {
			log.Debug("helper update deferred, chat active in an untracked session",
				"pid", inst.PID, "session", inst.SessionKey, "targetVersion", m.pendingHelperVersion)
			return true
		}
	}
	return false
}

// restartSessionsLocked restarts the helper in each session after a rolled-back
// update. A session that fails to start gets no watcher; the next Apply retries
// it. Must be called with m.mu held.
func (m *Manager) restartSessionsLocked(sessions []*sessionState) {
	for _, state := range sessions {
		state.watcherGaveUp = false // intentional stop, not a crash
		if err := m.ensureRunningSession(state); err != nil {
			log.Error("failed to restart helper after rollback", "session", state.key, "error", err.Error())
			continue
		}
		m.startSessionWatcher(state)
	}
}
