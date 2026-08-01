package sessionbroker

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

	// activeRunCommandID is the command id of an async backup_run that the
	// helper acked but has not yet delivered a terminal result for. It is the
	// only signal that a run is still in flight, and therefore the gate on
	// synthesizing a failure when the helper dies (#2998).
	//
	// Only the async flow is tracked. On the legacy synchronous path the
	// forwarder is still blocked in Session.SendCommand, which errors out when
	// the session closes and reports the failure itself — tracking it here too
	// would double-report the same command.
	activeRunCommandID string
}

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

// ForwardBackupCommand sends a command to the backup helper and waits for the
// result. async, when true, tells the helper this is a backup_run request
// that should be acked immediately ({"started":true}) with the real result
// following later as an unsolicited backup_result envelope — callers must
// only set it when the connected server has advertised the backup_run_async
// capability (see websocket.Client.HasServerCapability), since an old server
// would otherwise parse the ack as a malformed terminal result.
func (b *Broker) ForwardBackupCommand(commandID, commandType string, payload []byte, timeout time.Duration, async bool) (*ipc.Envelope, error) {
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
	}

	env, err := session.SendCommand(commandID, backupipc.TypeBackupCommand, req, timeout)

	// An async backup_run leaves the run executing inside the helper after the
	// ack returns, with the terminal result promised as a later unsolicited
	// envelope. Record it so a helper death before that result can be reported
	// (#2998). Anything the caller already turns into a command failure — a
	// send/timeout error, an unparseable ack, or an ack that says the run did
	// not start — is deliberately NOT tracked: the failure is reported by the
	// forwarder's return value instead.
	if async && commandType == backupRunCommandType && bh != nil && err == nil && ackStartedRun(env) {
		bh.mu.Lock()
		bh.activeRunCommandID = commandID
		bh.mu.Unlock()
	}

	return env, err
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
	return ack.Success
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
	if bh.activeRunCommandID == result.CommandID {
		bh.activeRunCommandID = ""
	}
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
	b.mu.RLock()
	bh := b.backup
	b.mu.RUnlock()
	if bh == nil || session == nil {
		return
	}

	bh.mu.Lock()
	current := bh.session
	commandID := bh.activeRunCommandID
	// A different live session means the run belongs to the helper that
	// replaced this one; failing it here would kill a backup that is still
	// executing. A nil current session is this session's own teardown (the
	// shutdown path clears it before the disconnect lands), and the run is
	// dead either way, so that case still reports.
	superseded := current != nil && current != session
	if !superseded && commandID != "" {
		bh.activeRunCommandID = ""
	}
	bh.mu.Unlock()

	if commandID == "" {
		return
	}
	if superseded {
		backupLog.Warn("backup helper session disconnected while another session owns the in-flight run",
			"sessionId", session.SessionID, "commandId", commandID)
		return
	}

	backupLog.Warn("backup helper exited with a run in flight, failing the job",
		"sessionId", session.SessionID,
		"commandId", commandID,
		"error", backupHelperDiedError,
	)

	if b.onMessage == nil {
		backupLog.Error("no message handler wired, cannot report backup helper death",
			"commandId", commandID)
		return
	}

	payload, err := json.Marshal(backupipc.BackupCommandResult{
		CommandID: commandID,
		Success:   false,
		Stderr:    backupHelperDiedError,
	})
	if err != nil {
		backupLog.Error("failed to encode backup helper death result",
			"commandId", commandID, "error", err.Error())
		return
	}

	b.onMessage(session, &ipc.Envelope{
		ID:      commandID + "-helper-death",
		Type:    backupipc.TypeBackupResult,
		Payload: payload,
	})
}
