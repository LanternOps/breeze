package helper

import (
	"errors"
	"os"
	"time"
)

// Rollback of a failed helper update (#6869).
//
// os.Rename on Windows is MoveFileEx(MOVEFILE_REPLACE_EXISTING), which fails
// with ERROR_ACCESS_DENIED while the target exe is mapped by a running
// process. applyPendingUpdate stops only the helpers in sessions it tracks,
// and the console-only session enumerator never tracks an RDP session, so a
// helper running there (or one relaunched by msiexec's Restart Manager) can
// still hold breeze-helper.exe when the rollback runs.

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

// rollbackBinaryLocked restores backupPath over the helper binary after a
// failed update. preVersion is the binary's version read before the install
// ("" when unknown). Every tracked session must already be stopped.
//
// Outcomes:
//   - restored: the backup is consumed by the rename, nothing is left behind;
//   - the rename keeps failing but the exe is still the pre-update build:
//     there is nothing to restore, so the duplicate backup is removed;
//   - the rename keeps failing and the exe changed: the backup is the only
//     good copy and is kept, and the failure is logged as an error.
//
// Must be called with m.mu held.
func (m *Manager) rollbackBinaryLocked(backupPath, preVersion string) {
	if _, err := os.Stat(backupPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			log.Warn("no helper backup to roll back to", "backup", backupPath)
			return
		}
		// Not "missing": something else is wrong with the backup. Try the
		// restore anyway; the rename reports what it hits.
		log.Error("cannot stat helper backup before rollback", "backup", backupPath, "error", err.Error())
	}

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
// is the helper binary, in any session, and returns the PIDs it stopped. Only
// the rollback uses it: the helpers it kills would otherwise keep a failed or
// half-installed exe mapped.
//
// An instance whose session status shows an active chat is left running. The
// pre-update idle gate (allSessionsIdle) sees only tracked sessions, so an
// untracked session can be mid-conversation; dropping it to free the exe is
// worse than keeping the backup and retrying on a later heartbeat. Must be
// called with m.mu held.
func (m *Manager) stopAllHelperInstancesLocked() []int {
	all, err := listHelperInstancesFunc(m.binaryPath)
	if err != nil {
		log.Warn("failed to enumerate breeze assist processes before rollback", "error", err.Error())
		return nil
	}
	var stopped []int
	for _, inst := range all {
		if inst.PID <= 0 {
			continue
		}
		if inst.SessionKey != "" && !IsIdle(newSessionState(inst.SessionKey, m.baseDir).configPath) {
			log.Warn("not stopping breeze assist holding the helper binary: chat active",
				"pid", inst.PID, "session", inst.SessionKey)
			continue
		}
		killed, err := m.stopIfOursFunc(inst.PID, m.binaryPath)
		if err != nil {
			log.Warn("failed to stop breeze assist holding the helper binary",
				"pid", inst.PID, "session", inst.SessionKey, "error", err.Error())
			continue
		}
		if killed {
			stopped = append(stopped, inst.PID)
		}
	}
	return stopped
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
