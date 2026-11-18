package sessionbroker

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// maxBackupRunRedispatches bounds how many times one queued run is re-sent to
// a fresh helper after its helper session ended. A device whose helper
// sessions keep ending (the #11044 suspend pattern) must not bounce a run
// between helpers forever; past the bound it is failed as never started.
const maxBackupRunRedispatches = 2

// backupRunNeverStartedError leads the terminal error of a queued run that was
// lost with its helper session and could not be re-sent. It must not contain
// backupHelperDiedError or backupHelperSessionClosedError: the run was never
// executing, and packages/shared backupFailureCategory.ts classifies this
// prefix as agent / never_started, not helper_stopped.
const backupRunNeverStartedError = "backup run never started"

// backupProgressPhaseQueued is the progress phase the helper sends while a
// workload waits in its execution queue (cmd/breeze-backup/main.go). Any
// other phase means the workload left the queue.
const backupProgressPhaseQueued = "queued"

func backupRunNeverStarted(detail string) string {
	return backupRunNeverStartedError + ": " + detail
}

// noteBackupRunProgress records that a tracked run left the helper's execution
// queue. Only the transition matters, so frames for untracked commands and
// queue heartbeats change nothing.
func (b *Broker) noteBackupRunProgress(env *ipc.Envelope) {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil || env == nil {
		return
	}
	var progress struct {
		CommandID string `json:"commandId"`
		Phase     string `json:"phase"`
	}
	if json.Unmarshal(env.Payload, &progress) != nil || progress.CommandID == "" ||
		progress.Phase == backupProgressPhaseQueued {
		return
	}
	bh.mu.Lock()
	defer bh.mu.Unlock()
	run := bh.activeRuns[progress.CommandID]
	if run == nil || run.started {
		return
	}
	run.started = true
	if run.state == backupRunQueued {
		run.state = backupRunExecuting
	}
}

// reportBackupHelperDeath synthesizes a terminal backup_result when the backup
// helper disconnects with a run in flight (#2998).
//
// Before this, the disconnect only cleared local state: the server never
// learned the run had ended, so the job sat "running" until the 15-minute
// stale-backup reaper failed it with "no progress reported for 15 minutes" —
// a misleading cause for a process that died in ~2 seconds.
//
// The synthetic result is pushed through the same onMessage sink a genuine
// unsolicited result uses, so it inherits the heartbeat's delivery path
// including the outbox that survives a WS gap.
//
// Only runs the helper was executing are failed. A run still waiting in the
// helper's execution queue never started, so its command id is returned for
// re-dispatch to a fresh helper (#12193); the caller starts that once the
// session pointer is cleared. A queued run is failed as never started instead
// when the agent is shutting down or the run was already re-sent
// maxBackupRunRedispatches times.
func (b *Broker) reportBackupHelperDeath(session *Session) (redispatch []string) {
	if session == nil {
		return nil
	}

	// b.mu only protects the b.backup pointer itself; bh.session and
	// bh.activeRuns are protected by bh.mu (SetBackupSession,
	// ClearBackupSession, registerNonLifecycleSession, spawnBackupHelper all
	// write/read them under bh.mu). This value decides whether a customer's
	// run gets failed, and an unsynchronized read of it would be a genuine
	// data race, so fetch bh under b.mu, release b.mu, then do everything
	// else under bh.mu alone — the pointer in b.backup is never reset once
	// created, so releasing b.mu here is safe.
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil {
		return nil
	}
	bh.mu.Lock()
	// A different live session means the runs belong to the helper that
	// replaced this one; failing them here would kill backups that are still
	// executing. A nil current session is this session's own teardown (the
	// shutdown path clears it before the disconnect lands), and the runs are
	// dead either way, so that case still reports.
	//
	// The map is deliberately left untouched on the superseded branch. Any
	// residue from the superseded session is then attributed to the next
	// session's death — accepted, because reaching this branch at all requires
	// a replacement helper to register in the window between RecvLoop
	// returning and this report, and mis-attributing is strictly better than
	// failing the live helper's runs.
	superseded := bh.session != nil && bh.session != session
	var executing, neverStarted []string
	var queued []*backupRun
	stillTracked := len(bh.activeRuns)
	if !superseded {
		for id, run := range bh.activeRuns {
			switch run.state {
			case backupRunExecuting:
				executing = append(executing, id)
				delete(bh.activeRuns, id)
			case backupRunQueued:
				if bh.stopping || run.redispatches >= maxBackupRunRedispatches {
					neverStarted = append(neverStarted, id)
					delete(bh.activeRuns, id)
					continue
				}
				run.state = backupRunRedispatching
				queued = append(queued, run)
			case backupRunPendingAck:
				// Still awaiting its ack, so the forwarder's to fail — it is
				// either blocked in SendCommand (which errors when the session
				// closes) or about to resume and find this tombstone.
				// Reporting it too would double-fail the command.
				run.state = backupRunDoomed
			}
			// backupRunDoomed already has its owner (the forwarder), and so
			// does backupRunRedispatching (redispatchQueuedBackupRuns, whose
			// forward to a replacement helper that dies fails on its own).
		}
	}
	stopping := bh.stopping
	bh.mu.Unlock()

	if superseded {
		if stillTracked > 0 {
			backupLog.Warn("backup helper session disconnected while another session owns the in-flight runs",
				"sessionId", session.SessionID, "runs", stillTracked)
		}
		return nil
	}

	// Deterministic order so a multi-run fan-out reports predictably; queued
	// runs keep the order the helper's queue had them in.
	sort.Strings(executing)
	sort.Strings(neverStarted)
	sort.Slice(queued, func(i, j int) bool { return queued[i].admitted < queued[j].admitted })

	failure := backupSessionEndedError(session)
	for _, commandID := range executing {
		backupLog.Warn("backup helper session ended with a run in flight, failing the job",
			"sessionId", session.SessionID,
			"commandId", commandID,
			"error", failure,
		)
		b.reportSyntheticBackupFailure(session, commandID, failure, "-helper-death")
	}

	if len(neverStarted) > 0 {
		detail := "the backup helper session ended while the run was queued"
		if reason := session.CloseReason(); reason != "" {
			detail += " (" + reason + ")"
		}
		if stopping {
			detail = "the agent stopped the backup helper while the run was queued"
		} else {
			detail += fmt.Sprintf("; it had already been re-sent to a new helper %d times", maxBackupRunRedispatches)
		}
		failure := backupRunNeverStarted(detail)
		for _, commandID := range neverStarted {
			backupLog.Warn("backup helper session ended with a queued run, failing the job",
				"sessionId", session.SessionID, "commandId", commandID, "error", failure)
			b.reportSyntheticBackupFailure(session, commandID, failure, "-never-started")
		}
	}

	for _, run := range queued {
		redispatch = append(redispatch, run.req.CommandID)
	}
	return redispatch
}

// redispatchQueuedBackupRuns sends runs that were queued in a helper whose
// session ended to a fresh helper, one at a time and in their original queue
// order, so the new helper's queue keeps that order (#12193). ended is the
// session that ended; it labels any failure reported here.
//
// Each run is in backupRunRedispatching, which nothing else reports, so every
// path below ends with the run either admitted by the new helper (tracked as
// usual from there) or failed exactly once as never started.
func (b *Broker) redispatchQueuedBackupRuns(ended *Session, commandIDs []string) {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil {
		return
	}
	for _, commandID := range commandIDs {
		bh.mu.Lock()
		run := bh.activeRuns[commandID]
		if run == nil || run.state != backupRunRedispatching {
			bh.mu.Unlock()
			continue
		}
		stopping := bh.stopping
		req, timeout, redispatches := run.req, run.timeout, run.redispatches
		bh.mu.Unlock()

		if stopping {
			b.failRedispatch(bh, ended, run, "the agent stopped the backup helper while the run was queued")
			continue
		}
		session, err := b.respawnBackupHelperSession(bh)
		if err != nil {
			b.failRedispatch(bh, ended, run,
				"the backup helper session ended while the run was queued, and a new helper could not be started: "+err.Error())
			continue
		}

		backupLog.Info("re-sending queued backup run to a new helper session",
			"commandId", commandID, "endedSessionId", ended.SessionID, "sessionId", session.SessionID,
			"redispatch", redispatches+1)
		// forwardTrackedBackupRun replaces this run's entry, so from here the
		// new entry decides who reports it: the new helper's own result or
		// death once admitted, or the failure handled below.
		env, err := b.forwardTrackedBackupRun(bh, session, req, timeout, redispatches+1)
		if err != nil {
			b.reportSyntheticBackupFailure(ended, commandID, backupRunNeverStarted(
				"the backup helper session ended while the run was queued, and re-sending it to a new helper failed: "+err.Error()),
				"-never-started")
			continue
		}
		if admitted, _ := backupRunAdmission(env); admitted {
			continue
		}
		// The new helper answered with a terminal result instead of an
		// admission: a refusal, or (from a helper that ignores Async) the
		// synchronous result itself. The heartbeat would have turned either
		// into the command's result; nobody else will now.
		var result backupipc.BackupCommandResult
		if env == nil || json.Unmarshal(env.Payload, &result) != nil {
			b.reportSyntheticBackupFailure(ended, commandID, backupRunNeverStarted(
				"the backup helper session ended while the run was queued, and a new helper sent an unreadable reply"),
				"-never-started")
			continue
		}
		if !result.Success {
			b.reportSyntheticBackupFailure(ended, commandID, backupRunNeverStarted(
				"the backup helper session ended while the run was queued, and a new helper refused it: "+strings.TrimSpace(result.Stderr)),
				"-never-started")
			continue
		}
		result.CommandID = commandID
		b.reportBackupResult(ended, commandID+"-redispatch-result", result)
	}
}

// failRedispatch fails a run that redispatchQueuedBackupRuns could not hand to
// a new helper, provided it still owns the run.
func (b *Broker) failRedispatch(bh *backupHelper, ended *Session, run *backupRun, detail string) {
	commandID := run.req.CommandID
	bh.mu.Lock()
	owned := bh.activeRuns[commandID] == run && run.state == backupRunRedispatching
	if owned {
		delete(bh.activeRuns, commandID)
	}
	bh.mu.Unlock()
	if !owned {
		return
	}
	failure := backupRunNeverStarted(detail)
	backupLog.Warn("queued backup run could not be re-sent to a new helper, failing the job",
		"commandId", commandID, "endedSessionId", ended.SessionID, "error", failure)
	b.reportSyntheticBackupFailure(ended, commandID, failure, "-never-started")
}

// respawnBackupHelperSession returns a live backup helper session for a
// re-dispatch: the one already connected, or a freshly spawned one.
func (b *Broker) respawnBackupHelperSession(bh *backupHelper) (*Session, error) {
	if b.respawnBackupHelper != nil {
		return b.respawnBackupHelper()
	}
	bh.mu.Lock()
	binaryPath := bh.binaryPath
	bh.mu.Unlock()
	return b.GetOrSpawnBackupHelper(binaryPath)
}

// reportSyntheticBackupFailure delivers a terminal failure for commandID that
// no helper will ever report.
func (b *Broker) reportSyntheticBackupFailure(session *Session, commandID, failure, idSuffix string) {
	b.reportBackupResult(session, commandID+idSuffix, backupipc.BackupCommandResult{
		CommandID: commandID,
		Success:   false,
		Stderr:    failure,
	})
}

// reportBackupResult delivers a terminal backup_result through the same
// onMessage sink a genuine unsolicited result uses.
func (b *Broker) reportBackupResult(session *Session, envelopeID string, result backupipc.BackupCommandResult) {
	if b.onMessage == nil {
		backupLog.Error("no message handler wired, cannot report backup run result",
			"sessionId", session.SessionID, "commandId", result.CommandID, "error", result.Stderr)
		return
	}
	payload, err := json.Marshal(result)
	if err != nil {
		backupLog.Error("failed to encode backup run result",
			"commandId", result.CommandID, "error", err.Error())
		return
	}
	b.onMessage(session, &ipc.Envelope{
		ID:      envelopeID,
		Type:    backupipc.TypeBackupResult,
		Payload: payload,
	})
}
