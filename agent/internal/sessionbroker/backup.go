package sessionbroker

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	backupHelperSpawnTimeout = 15 * time.Second
	backupHelperIdleTimeout  = 30 * time.Minute
)

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
	if b.backup != nil {
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

	return session.SendCommand(commandID, backupipc.TypeBackupCommand, req, timeout)
}
