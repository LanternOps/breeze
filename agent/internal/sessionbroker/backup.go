package sessionbroker

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

const (
	backupHelperSpawnTimeout = 15 * time.Second
	backupHelperIdleTimeout  = 30 * time.Minute
)

// backupHelperDiedError is the terminal error reported for a backup run whose
// helper process disappeared mid-run (#2998). It is a fixed string so support
// and the server can separate "the helper died" from a genuinely stalled
// upload — the stale-backup reaper's "no progress reported for 15 minutes"
// (apps/api/src/jobs/staleCommandReaper.ts) is what a run used to get instead,
// 15 minutes late and describing the wrong failure.
const backupHelperDiedError = "backup helper exited unexpectedly"

// backupRunCommandType is the wire value of the backup command that runs a
// backup, duplicated here as a literal because internal/remote/tools (which
// declares CmdBackupRun) imports this package — taking the constant from there
// would be an import cycle. It must stay in step with tools.CmdBackupRun and
// with the helper's own literal in cmd/breeze-backup/main.go.
const backupRunCommandType = "backup_run"

// backupLog carries component=backup rather than component=sessionbroker so
// helper-death warnings land in the same shipped bucket as the rest of the
// backup subsystem (default log_shipping_level is warn).
var backupLog = logging.L("backup")

// backupHelperScopes defines allowed IPC scopes for the backup helper.
var backupHelperScopes = []string{"backup"}

// backupBinaryName returns the on-disk filename of the breeze-backup helper as
// installed alongside the agent. Unlike the Windows-only breeze-user-helper,
// the backup helper is built for every supported OS (see agent/Makefile), so
// the executable suffix must be applied conditionally: breeze-backup.exe on
// Windows, breeze-backup elsewhere. Taking goos as a parameter keeps this
// testable on every platform the agent builds on.
func backupBinaryName(goos string) string {
	if goos == "windows" {
		return "breeze-backup.exe"
	}
	return "breeze-backup"
}

// backupHelper tracks the backup helper process and session.
type backupHelper struct {
	mu         sync.Mutex
	session    *Session
	process    *os.Process
	binaryPath string
	spawning   bool

	// activeRuns holds every async backup_run this helper is executing, keyed
	// by command id. It is the gate on synthesizing a failure when the helper
	// dies (#2998), and it is a MAP rather than a single slot because
	// concurrent runs on one device are a normal shape, not a corner case: a
	// profile fan-out dispatches one job per selection and both `file` and
	// `system_image` resolve to commandType backup_run
	// (apps/api/src/jobs/backupWorker.ts), the agent dispatches commands from a
	// worker pool, and the helper runs each in its own goroutine
	// (cmd/breeze-backup/main.go). A single slot would let the second run
	// overwrite the first and leave the first stranded for the 15-minute
	// reaper — the very bug #2998 fixes.
	//
	// Only the async flow is tracked. On the legacy synchronous path the
	// forwarder is still blocked in Session.SendCommand, which errors out when
	// the session closes and reports the failure itself — tracking it here too
	// would double-report the same command.
	activeRuns map[string]backupRunState
}

// backupRunState distinguishes a run whose forwarder is still blocked waiting
// for the helper's ack from one the helper has confirmed it is executing.
//
// The distinction is what makes helper-death reporting exactly-once. A run
// still awaiting its ack must NOT be reported by the death path, because its
// forwarder is about to return an error (Session.SendCommand fails when the
// session closes) and the heartbeat reports that failure itself. Only a
// confirmed-running command has nobody else left to report it.
type backupRunState int

const (
	// backupRunPendingAck: recorded before the request was sent, ack not yet seen.
	backupRunPendingAck backupRunState = iota
	// backupRunExecuting: the helper acked; the terminal result is still owed.
	backupRunExecuting
	// backupRunDoomed: the helper died while this run was still pending-ack.
	// The death path leaves this tombstone instead of reporting, because the
	// forwarder is the one that must fail the command; the forwarder consumes
	// the tombstone when it resumes.
	//
	// The doom signal has to be per-command, not per-session: "my entry is
	// gone" is ambiguous on its own — it also happens when the genuine
	// terminal result was delivered and the helper then exited normally, and
	// failing the command in THAT case would contradict a success the server
	// already recorded.
	backupRunDoomed
)

// GetOrSpawnBackupHelper returns the existing backup helper session or spawns a new one.
func (b *Broker) GetOrSpawnBackupHelper(binaryPath string) (*Session, error) {
	b.mu.RLock()
	if b.backup != nil && b.backup.session != nil {
		s := b.backup.session
		b.mu.RUnlock()
		return s, nil
	}
	b.mu.RUnlock()

	return b.spawnBackupHelper(binaryPath)
}

func (b *Broker) spawnBackupHelper(binaryPath string) (*Session, error) {
	b.mu.Lock()
	if b.backup == nil {
		b.backup = &backupHelper{binaryPath: binaryPath}
	}
	bh := b.backup
	b.mu.Unlock()

	bh.mu.Lock()
	if bh.session != nil {
		s := bh.session
		bh.mu.Unlock()
		return s, nil
	}
	if bh.spawning {
		bh.mu.Unlock()
		return nil, fmt.Errorf("backup helper is already being spawned")
	}
	bh.spawning = true
	bh.mu.Unlock()

	defer func() {
		bh.mu.Lock()
		bh.spawning = false
		bh.mu.Unlock()
	}()

	// Resolve binary path
	path := binaryPath
	if path == "" {
		self, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("failed to find self path: %w", err)
		}
		dir := filepath.Dir(self)
		path = filepath.Join(dir, backupBinaryName(runtime.GOOS))
	}

	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("backup binary not found at %s: %w", path, err)
	}

	log.Info("spawning backup helper", "path", path, "socket", b.socketPath)
	cmd := exec.Command(path, "--socket", b.socketPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to spawn backup helper: %w", err)
	}

	bh.mu.Lock()
	bh.process = cmd.Process
	bh.mu.Unlock()

	// Wait for the helper to connect via IPC
	deadline := time.Now().Add(backupHelperSpawnTimeout)
	for time.Now().Before(deadline) {
		b.mu.RLock()
		if b.backup != nil && b.backup.session != nil {
			s := b.backup.session
			b.mu.RUnlock()
			log.Info("backup helper connected", "pid", cmd.Process.Pid)
			return s, nil
		}
		b.mu.RUnlock()
		time.Sleep(200 * time.Millisecond)
	}

	_ = cmd.Process.Kill()
	return nil, fmt.Errorf("backup helper failed to connect within %v", backupHelperSpawnTimeout)
}

// SetBackupSession is called by the broker's connection handler when a backup helper authenticates.
func (b *Broker) SetBackupSession(s *Session) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.backup == nil {
		b.backup = &backupHelper{}
	}
	b.backup.session = s
}

// ClearBackupSession removes the backup session (called on disconnect).
func (b *Broker) ClearBackupSession() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.backup != nil {
		b.backup.session = nil
	}
}

// StopBackupHelper kills the backup helper process.
func (b *Broker) StopBackupHelper() {
	b.mu.Lock()
	bh := b.backup
	b.mu.Unlock()
	if bh == nil {
		return
	}
	bh.mu.Lock()
	defer bh.mu.Unlock()
	if bh.process != nil {
		log.Info("stopping backup helper", "pid", bh.process.Pid)
		_ = bh.process.Kill()
		bh.process = nil
	}
	bh.session = nil
}

// StopBackupHelperIfIdle stops any resident backup helper process IF no
// backup run is currently in flight, reporting whether it did so (true) or
// deferred because a run is active (false). Used by the agent's backup-binary
// delivery paths (upgrade swap, reconcile) before replacing the on-disk
// breeze-backup binary: swapping the file out from under a job that's
// mid-upload would corrupt or kill it. The check-and-stop happens atomically
// under bh.mu, so a run cannot start in the gap between "no active runs" and
// "kill the process".
//
// A nil/never-spawned helper (nothing to stop) also returns true — there is
// nothing in the way of the swap.
func (b *Broker) StopBackupHelperIfIdle() bool {
	b.mu.Lock()
	bh := b.backup
	b.mu.Unlock()
	if bh == nil {
		return true
	}

	bh.mu.Lock()
	defer bh.mu.Unlock()
	if len(bh.activeRuns) > 0 {
		return false
	}
	if bh.process != nil {
		log.Info("stopping idle backup helper for binary swap", "pid", bh.process.Pid)
		_ = bh.process.Kill()
		bh.process = nil
	}
	bh.session = nil
	return true
}

// ForwardBackupCommand sends a command to the backup helper and waits for the
// result. async, when true, tells the helper this is a backup_run request
// that should be acked immediately ({"started":true}) with the real result
// following later as an unsolicited backup_result envelope — callers must
// only set it when the connected server has advertised the backup_run_async
// capability (see websocket.Client.HasServerCapability), since an old server
// would otherwise parse the ack as a malformed terminal result.
func (b *Broker) ForwardBackupCommand(commandID, commandType string, payload []byte, timeout time.Duration, async bool, queueAsync ...bool) (*ipc.Envelope, error) {
	b.mu.RLock()
	var session *Session
	var bh *backupHelper
	if b.backup != nil {
		bh = b.backup
		session = b.backup.session
	}
	b.mu.RUnlock()

	if session == nil {
		return nil, fmt.Errorf("backup helper not connected")
	}

	req := backupipc.BackupCommandRequest{
		CommandID:   commandID,
		CommandType: commandType,
		Payload:     payload,
		TimeoutMs:   timeout.Milliseconds(),
		Async:       async,
		QueueAsync:  len(queueAsync) > 0 && queueAsync[0],
	}

	tracked := async && (commandType == backupRunCommandType || req.QueueAsync) && bh != nil
	if !tracked {
		return session.SendCommand(commandID, backupipc.TypeBackupCommand, req, timeout)
	}

	// Record BEFORE sending, not after. The helper's terminal result is
	// delivered by the RecvLoop goroutine and can land before this goroutine
	// resumes from SendCommand — recording afterwards would re-add a command
	// that already finished, and the next disconnect would then fail an
	// already-completed job (#2998 review). Recording first means every
	// dispatch of this command id is ordered after the entry exists.
	bh.mu.Lock()
	if bh.activeRuns == nil {
		bh.activeRuns = make(map[string]backupRunState)
	}
	bh.activeRuns[commandID] = backupRunPendingAck
	bh.mu.Unlock()

	env, err := session.SendCommand(commandID, backupipc.TypeBackupCommand, req, timeout)

	// Nothing started: drop the entry. The forwarder's own error/failed-ack
	// return is what reports this command's failure, so the death path must
	// not report it a second time.
	if err != nil || !ackStartedRun(env) {
		bh.mu.Lock()
		delete(bh.activeRuns, commandID)
		bh.mu.Unlock()
		return env, err
	}

	// The helper confirmed the run. What happened to the entry in the meantime
	// decides who owns this command's outcome:
	//
	//   - gone: the terminal result already arrived (a run that finished or
	//     failed in microseconds) and the server has been told. Re-adding the
	//     id would strand a false failure for the next disconnect, and
	//     returning an error here would contradict a result already recorded.
	//     Stay silent.
	//   - doomed: the helper died while this run was still pending-ack. The
	//     death path deliberately did not report it, so this call must fail it.
	//   - otherwise: promote to executing; the death path owns it from here.
	//
	// Those three answers are what make helper-death reporting exactly-once in
	// every interleaving of this goroutine and the RecvLoop goroutine.
	bh.mu.Lock()
	state, stillTracked := bh.activeRuns[commandID]
	switch {
	case !stillTracked:
		bh.mu.Unlock()
		return env, nil
	case state == backupRunDoomed:
		delete(bh.activeRuns, commandID)
		bh.mu.Unlock()
		return env, fmt.Errorf("%s", backupHelperDiedError)
	default:
		bh.activeRuns[commandID] = backupRunExecuting
		bh.mu.Unlock()
		return env, nil
	}
}

// ackStartedRun reports whether an async backup_run ack means the run is now
// executing in the helper. It mirrors what the heartbeat forwarder does with
// the same envelope (forwardToBackupHelper): an ack it cannot parse, or one
// carrying Success=false, becomes the command's failure result there.
func ackStartedRun(env *ipc.Envelope) bool {
	if env == nil {
		return false
	}
	var ack backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &ack); err != nil {
		return false
	}
	if !ack.Success {
		return false
	}
	var admission struct {
		Started bool `json:"started"`
		Queued  bool `json:"queued"`
	}
	// Older helpers may ignore Async/QueueAsync and return the synchronous
	// terminal result here. Only explicit admission has an unsolicited finish.
	return json.Unmarshal([]byte(ack.Stdout), &admission) == nil && (admission.Started || admission.Queued)
}

// noteBackupRunResult clears the in-flight run once its terminal result has
// been forwarded to the server, so a subsequent helper disconnect stays a
// no-op instead of reporting a second, contradictory result (#2998).
//
// Only the unsolicited terminal result reaches this: the async ack is a reply
// to the request envelope and is consumed by Session.HandleResponse, never
// reaching dispatchHelperMessage.
func (b *Broker) noteBackupRunResult(env *ipc.Envelope) {
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil || env == nil {
		return
	}

	var result backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		// Unparseable here means unparseable in the heartbeat handler too, so
		// the server learns nothing from it — keep the run tracked so the
		// disconnect still reports a terminal failure.
		backupLog.Warn("unparseable terminal backup result, keeping run tracked",
			"error", err.Error())
		return
	}
	if result.CommandID == "" {
		return
	}

	bh.mu.Lock()
	delete(bh.activeRuns, result.CommandID)
	bh.mu.Unlock()
}

// reportBackupHelperDeath synthesizes a terminal backup_result when the backup
// helper disconnects with a run still in flight (#2998).
//
// Before this, the disconnect only cleared local state: the server never
// learned the run had ended, so the job sat "running" until the 15-minute
// stale-backup reaper failed it with "no progress reported for 15 minutes" —
// a misleading cause for a process that died in ~2 seconds.
//
// The synthetic result is pushed through the same onMessage sink a genuine
// unsolicited result uses, so it inherits the heartbeat's delivery path
// including the outbox that survives a WS gap.
func (b *Broker) reportBackupHelperDeath(session *Session) {
	if session == nil {
		return
	}

	// bh.session is written under b.mu (SetBackupSession, ClearBackupSession,
	// registerNonLifecycleSession), so it must be read under b.mu too — this
	// value decides whether a customer's run gets failed, and an unsynchronized
	// read of it would be a genuine data race. b.mu -> bh.mu is the lock order
	// used everywhere else in this file, so nesting them here is safe.
	b.mu.RLock()
	bh := b.backup
	if bh == nil {
		b.mu.RUnlock()
		return
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
	var commandIDs []string
	stillTracked := len(bh.activeRuns)
	if !superseded {
		// Report only the runs the helper confirmed it was executing. A run
		// still awaiting its ack is the forwarder's to fail — it is either
		// blocked in SendCommand (which errors when the session closes) or
		// about to resume and find the tombstone left here. Reporting those
		// too would double-fail the command.
		for id, state := range bh.activeRuns {
			if state == backupRunExecuting {
				commandIDs = append(commandIDs, id)
				delete(bh.activeRuns, id)
				continue
			}
			bh.activeRuns[id] = backupRunDoomed
		}
	}
	bh.mu.Unlock()
	b.mu.RUnlock()

	if superseded {
		if stillTracked > 0 {
			backupLog.Warn("backup helper session disconnected while another session owns the in-flight runs",
				"sessionId", session.SessionID, "runs", stillTracked)
		}
		return
	}
	if len(commandIDs) == 0 {
		return
	}
	// Deterministic order so a multi-run fan-out reports predictably.
	sort.Strings(commandIDs)

	if b.onMessage == nil {
		backupLog.Error("no message handler wired, cannot report backup helper death",
			"sessionId", session.SessionID, "commandIds", strings.Join(commandIDs, ","))
		return
	}

	for _, commandID := range commandIDs {
		backupLog.Warn("backup helper exited with a run in flight, failing the job",
			"sessionId", session.SessionID,
			"commandId", commandID,
			"error", backupHelperDiedError,
		)

		payload, err := json.Marshal(backupipc.BackupCommandResult{
			CommandID: commandID,
			Success:   false,
			Stderr:    backupHelperDiedError,
		})
		if err != nil {
			backupLog.Error("failed to encode backup helper death result",
				"commandId", commandID, "error", err.Error())
			continue
		}

		b.onMessage(session, &ipc.Envelope{
			ID:      commandID + "-helper-death",
			Type:    backupipc.TypeBackupResult,
			Payload: payload,
		})
	}
}
