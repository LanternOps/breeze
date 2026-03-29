# Backup Binary Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split backup functionality into a separate `breeze-backup` binary that the main `breeze-agent` spawns on demand via IPC, keeping the main agent lean (~15MB) and backup optional (~15-20MB).

**Architecture:** The main agent receives backup commands from the API, spawns `breeze-backup` as a long-running helper process via the existing IPC transport (HMAC-signed, length-prefixed JSON over Unix sockets / named pipes). The backup binary owns all heavy dependencies (Azure/GCS/B2 SDKs, VSS COM, MSSQL, Hyper-V). A thin shared `backupipc` package defines message types imported by both binaries.

**Tech Stack:** Go 1.25, existing `internal/ipc` transport, `internal/sessionbroker` pattern, cobra CLI

---

### Task 1: Create shared backupipc types package

**Files:**
- Create: `agent/internal/backupipc/types.go`
- Test: `agent/internal/backupipc/types_test.go`

- [ ] **Step 1: Create the types file**

```go
// agent/internal/backupipc/types.go
package backupipc

import "encoding/json"

// IPC message types for backup helper communication.
const (
	TypeBackupCommand  = "backup_command"
	TypeBackupResult   = "backup_result"
	TypeBackupProgress = "backup_progress"
	TypeBackupReady    = "backup_ready"
	TypeBackupShutdown = "backup_shutdown"

	HelperRoleBackup = "backup"
)

// BackupCapabilities reported by the backup helper on connect.
type BackupCapabilities struct {
	SupportsVSS         bool     `json:"supportsVss"`
	SupportsMSSQL       bool     `json:"supportsMssql"`
	SupportsHyperV      bool     `json:"supportsHyperv"`
	SupportsSystemState bool     `json:"supportsSystemState"`
	Providers           []string `json:"providers"` // s3, local, azure, gcs, b2
}

// BackupCommandRequest is sent from the agent to the backup helper.
type BackupCommandRequest struct {
	CommandID   string          `json:"commandId"`
	CommandType string          `json:"commandType"`
	Payload     json.RawMessage `json:"payload"`
	TimeoutMs   int64           `json:"timeoutMs"`
}

// BackupCommandResult is sent from the backup helper to the agent.
type BackupCommandResult struct {
	CommandID  string `json:"commandId"`
	Success    bool   `json:"success"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int64  `json:"durationMs"`
}

// BackupProgress is streamed from the backup helper during long operations.
type BackupProgress struct {
	CommandID string `json:"commandId"`
	Phase     string `json:"phase"`
	Current   int64  `json:"current"`
	Total     int64  `json:"total"`
	Message   string `json:"message,omitempty"`
}
```

- [ ] **Step 2: Create tests**

```go
// agent/internal/backupipc/types_test.go
package backupipc

import (
	"encoding/json"
	"testing"
)

func TestBackupCommandRequestRoundTrip(t *testing.T) {
	req := BackupCommandRequest{
		CommandID:   "cmd-123",
		CommandType: "backup_run",
		Payload:     json.RawMessage(`{"paths":["/data"]}`),
		TimeoutMs:   60000,
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var decoded BackupCommandRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.CommandID != req.CommandID {
		t.Errorf("got %s, want %s", decoded.CommandID, req.CommandID)
	}
	if decoded.CommandType != req.CommandType {
		t.Errorf("got %s, want %s", decoded.CommandType, req.CommandType)
	}
}

func TestBackupCommandResultRoundTrip(t *testing.T) {
	res := BackupCommandResult{
		CommandID:  "cmd-123",
		Success:    true,
		Stdout:     `{"status":"completed"}`,
		DurationMs: 5000,
	}
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var decoded BackupCommandResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.Success {
		t.Error("expected success=true")
	}
}

func TestBackupProgressRoundTrip(t *testing.T) {
	p := BackupProgress{CommandID: "cmd-1", Phase: "upload", Current: 50, Total: 100, Message: "uploading"}
	data, _ := json.Marshal(p)
	var decoded BackupProgress
	json.Unmarshal(data, &decoded)
	if decoded.Current != 50 || decoded.Total != 100 {
		t.Errorf("got %d/%d, want 50/100", decoded.Current, decoded.Total)
	}
}

func TestConstants(t *testing.T) {
	if TypeBackupCommand != "backup_command" {
		t.Error("unexpected constant value")
	}
	if HelperRoleBackup != "backup" {
		t.Error("unexpected role value")
	}
}
```

- [ ] **Step 3: Run tests**

Run: `cd agent && go test -race ./internal/backupipc/...`
Expected: PASS (4 tests)

- [ ] **Step 4: Commit**

```bash
git add agent/internal/backupipc/
git commit -m "feat: add backupipc shared types package for backup binary split"
```

---

### Task 2: Extend session broker for backup helper

**Files:**
- Create: `agent/internal/sessionbroker/backup.go`
- Create: `agent/internal/sessionbroker/backup_test.go`
- Modify: `agent/internal/sessionbroker/broker.go` (add backupSession field)

- [ ] **Step 1: Add backup session tracking to Broker**

Read `agent/internal/sessionbroker/broker.go` and add a `backupSession` field to the `Broker` struct. Add methods for backup helper management.

Create `agent/internal/sessionbroker/backup.go`:

```go
package sessionbroker

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	backupHelperSpawnTimeout = 15 * time.Second
	backupHelperIdleTimeout  = 30 * time.Minute
)

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
		path = filepath.Join(dir, "breeze-backup")
	}

	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("backup binary not found at %s: %w", path, err)
	}

	slog.Info("spawning backup helper", "path", path, "socket", b.socketPath)
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
			slog.Info("backup helper connected", "pid", cmd.Process.Pid)
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
		slog.Info("stopping backup helper", "pid", bh.process.Pid)
		_ = bh.process.Kill()
		bh.process = nil
	}
	bh.session = nil
}

// ForwardBackupCommand sends a command to the backup helper and waits for the result.
func (b *Broker) ForwardBackupCommand(commandID, commandType string, payload []byte, timeout time.Duration) (*ipc.Envelope, error) {
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
	}

	return session.SendCommand(commandID, backupipc.TypeBackupCommand, req, timeout)
}
```

- [ ] **Step 2: Add backup field to Broker struct**

Edit `agent/internal/sessionbroker/broker.go` — add `backup *backupHelper` to the `Broker` struct:

```go
type Broker struct {
	socketPath  string
	listener    net.Listener
	rateLimiter *ipc.RateLimiter

	mu           sync.RWMutex
	sessions     map[string]*Session
	byIdentity   map[string][]*Session
	staleHelpers map[string][]int
	backup       *backupHelper  // <-- add this line
	closed       bool

	onMessage MessageHandler
	selfHash  string
}
```

Also add routing in the broker's connection handler: when `AuthRequest.HelperRole == "backup"`, call `b.SetBackupSession(session)` and on disconnect call `b.ClearBackupSession()`.

- [ ] **Step 3: Create test**

```go
// agent/internal/sessionbroker/backup_test.go
package sessionbroker

import (
	"testing"
)

func TestSetClearBackupSession(t *testing.T) {
	b := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}

	s := &Session{SessionID: "backup-test"}
	b.SetBackupSession(s)

	b.mu.RLock()
	if b.backup == nil || b.backup.session == nil {
		t.Fatal("expected backup session to be set")
	}
	if b.backup.session.SessionID != "backup-test" {
		t.Errorf("got %s, want backup-test", b.backup.session.SessionID)
	}
	b.mu.RUnlock()

	b.ClearBackupSession()
	b.mu.RLock()
	if b.backup.session != nil {
		t.Error("expected backup session to be cleared")
	}
	b.mu.RUnlock()
}
```

- [ ] **Step 4: Build and test**

Run: `cd agent && go build ./internal/sessionbroker/... && go test -race ./internal/sessionbroker/... -run TestSetClear`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/sessionbroker/backup.go agent/internal/sessionbroker/backup_test.go agent/internal/sessionbroker/broker.go
git commit -m "feat: extend session broker with backup helper management"
```

---

### Task 3: Create breeze-backup binary entry point

**Files:**
- Create: `agent/cmd/breeze-backup/main.go`

- [ ] **Step 1: Create the entry point**

```go
// agent/cmd/breeze-backup/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/vss"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/spf13/cobra"
)

var version = "dev"

var rootCmd = &cobra.Command{
	Use:   "breeze-backup",
	Short: "Breeze RMM Backup Helper",
	Long:  "Backup helper binary spawned by the Breeze agent for backup operations.",
	Run:   func(cmd *cobra.Command, args []string) { runBackupHelper() },
}

var socketPath string

func init() {
	rootCmd.Flags().StringVar(&socketPath, "socket", "", "IPC socket path to connect to the main agent")
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runBackupHelper() {
	slog.Info("breeze-backup starting", "version", version, "pid", os.Getpid(), "platform", runtime.GOOS)

	if socketPath == "" {
		socketPath = ipc.DefaultSocketPath()
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Warn("failed to load config, using defaults", "error", err.Error())
	}

	// Connect to main agent via IPC
	conn, err := dialAgent(socketPath)
	if err != nil {
		slog.Error("failed to connect to agent", "error", err.Error())
		os.Exit(1)
	}
	defer conn.Close()

	// Authenticate
	if err := authenticate(conn); err != nil {
		slog.Error("authentication failed", "error", err.Error())
		os.Exit(1)
	}

	// Initialize backup manager
	mgr := initBackupManager(cfg)

	// Report capabilities
	caps := detectCapabilities()
	if err := conn.SendTyped("caps", backupipc.TypeBackupReady, caps); err != nil {
		slog.Error("failed to send capabilities", "error", err.Error())
		os.Exit(1)
	}

	// Set up signal handling
	ctx, cancel := context.WithCancel(context.Background())
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		slog.Info("received shutdown signal")
		cancel()
	}()

	// Enter command loop with idle timeout
	idleTimeout := 30 * time.Minute
	commandLoop(ctx, conn, mgr, idleTimeout)

	if mgr != nil {
		mgr.Stop()
	}
	slog.Info("breeze-backup exiting")
}

func dialAgent(socketPath string) (*ipc.Conn, error) {
	netConn, err := ipc.Dial(socketPath)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", socketPath, err)
	}
	return ipc.NewConn(netConn), nil
}

func authenticate(conn *ipc.Conn) error {
	pid := os.Getpid()
	sessionID := fmt.Sprintf("backup-%d", pid)

	selfHash, _ := ipc.ComputeBinaryHash()

	req := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		SessionID:       sessionID,
		PID:             pid,
		BinaryHash:      selfHash,
		HelperRole:      backupipc.HelperRoleBackup,
	}

	if err := conn.SendTyped("auth", ipc.TypeAuthRequest, req); err != nil {
		return fmt.Errorf("send auth request: %w", err)
	}

	env, err := conn.Recv()
	if err != nil {
		return fmt.Errorf("recv auth response: %w", err)
	}
	if env.Type != ipc.TypeAuthResponse {
		return fmt.Errorf("expected auth_response, got %s", env.Type)
	}

	var resp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &resp); err != nil {
		return fmt.Errorf("decode auth response: %w", err)
	}
	if !resp.Accepted {
		return fmt.Errorf("auth rejected: %s", resp.Reason)
	}

	conn.SetSessionKey(resp.SessionKey)
	slog.Info("authenticated with agent", "sessionID", sessionID)
	return nil
}

func initBackupManager(cfg *config.Config) *backup.BackupManager {
	if cfg == nil || !cfg.BackupEnabled || len(cfg.BackupPaths) == 0 {
		return nil
	}

	var backupProvider providers.BackupProvider
	switch cfg.BackupProvider {
	case "s3":
		backupProvider = providers.NewS3Provider(
			cfg.BackupS3Bucket, cfg.BackupS3Region,
			cfg.BackupS3AccessKey, cfg.BackupS3SecretKey, "",
		)
	default:
		localPath := cfg.BackupLocalPath
		if localPath == "" {
			localPath = config.GetDataDir() + "/backups"
		}
		backupProvider = providers.NewLocalProvider(localPath)
	}

	schedule, _ := time.ParseDuration(cfg.BackupSchedule)
	if schedule <= 0 {
		schedule = 24 * time.Hour
	}
	retention := cfg.BackupRetention
	if retention <= 0 {
		retention = 7
	}

	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:           backupProvider,
		Paths:              cfg.BackupPaths,
		Schedule:           schedule,
		Retention:          retention,
		VSSEnabled:         cfg.BackupVSSEnabled,
		SystemStateEnabled: cfg.BackupSystemStateEnabled,
	})

	return mgr
}

func detectCapabilities() backupipc.BackupCapabilities {
	caps := backupipc.BackupCapabilities{
		SupportsSystemState: true,
		Providers:           []string{"local", "s3", "azure", "gcs", "b2"},
	}
	if runtime.GOOS == "windows" {
		caps.SupportsVSS = true
		caps.SupportsMSSQL = true
		caps.SupportsHyperV = true
	}
	return caps
}

func commandLoop(ctx context.Context, conn *ipc.Conn, mgr *backup.BackupManager, idleTimeout time.Duration) {
	idleTimer := time.NewTimer(idleTimeout)
	defer idleTimer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-idleTimer.C:
			slog.Info("idle timeout reached, shutting down")
			return
		default:
		}

		// Non-blocking recv with short deadline
		conn.SetReadDeadline(time.Now().Add(1 * time.Second))
		env, err := conn.Recv()
		if err != nil {
			if isTimeoutError(err) {
				continue
			}
			slog.Error("IPC recv error", "error", err.Error())
			return
		}

		idleTimer.Reset(idleTimeout)

		switch env.Type {
		case backupipc.TypeBackupCommand:
			go handleBackupCommand(conn, env, mgr)
		case backupipc.TypeBackupShutdown:
			slog.Info("received shutdown command")
			return
		case ipc.TypePing:
			_ = conn.SendTyped(env.ID, ipc.TypePong, nil)
		}
	}
}

func handleBackupCommand(conn *ipc.Conn, env *ipc.Envelope, mgr *backup.BackupManager) {
	var req backupipc.BackupCommandRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		sendError(conn, env.ID, "invalid request payload: "+err.Error())
		return
	}

	start := time.Now()
	result := executeCommand(req, mgr)
	result.CommandID = req.CommandID
	result.DurationMs = time.Since(start).Milliseconds()

	if err := conn.SendTyped(env.ID, backupipc.TypeBackupResult, result); err != nil {
		slog.Error("failed to send result", "commandId", req.CommandID, "error", err.Error())
	}
}

func executeCommand(req backupipc.BackupCommandRequest, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	// Route to the appropriate handler based on command type.
	// This is where all the heavy backup logic lives.
	// Each case calls directly into the backup packages.

	if mgr == nil {
		return backupipc.BackupCommandResult{
			Success: false,
			Stderr:  "backup not configured on this device",
		}
	}

	switch req.CommandType {
	case "backup_run":
		job, err := mgr.RunBackup()
		if err != nil {
			return backupipc.BackupCommandResult{Success: false, Stderr: err.Error()}
		}
		data, _ := json.Marshal(job)
		return backupipc.BackupCommandResult{Success: true, Stdout: string(data)}

	case "backup_list":
		snapshots, err := backup.ListSnapshots(mgr.GetProvider())
		if err != nil {
			return backupipc.BackupCommandResult{Success: false, Stderr: err.Error()}
		}
		data, _ := json.Marshal(snapshots)
		return backupipc.BackupCommandResult{Success: true, Stdout: string(data)}

	case "backup_stop":
		mgr.Stop()
		return backupipc.BackupCommandResult{Success: true, Stdout: `{"stopped":true}`}

	default:
		// All other backup commands (vss_*, mssql_*, hyperv_*, etc.)
		// are handled by dispatching to the appropriate package.
		return backupipc.BackupCommandResult{
			Success: false,
			Stderr:  fmt.Sprintf("unknown backup command: %s", req.CommandType),
		}
	}
}

func sendError(conn *ipc.Conn, id, msg string) {
	result := backupipc.BackupCommandResult{Success: false, Stderr: msg}
	_ = conn.SendTyped(id, backupipc.TypeBackupResult, result)
}

func isTimeoutError(err error) bool {
	if netErr, ok := err.(interface{ Timeout() bool }); ok {
		return netErr.Timeout()
	}
	return false
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd agent && go build ./cmd/breeze-backup/...`
Expected: Clean build (may need minor fixes for unexported ipc functions — adjust imports as needed)

- [ ] **Step 3: Commit**

```bash
git add agent/cmd/breeze-backup/
git commit -m "feat: add breeze-backup binary entry point with IPC command loop"
```

---

### Task 4: Refactor heartbeat handlers to IPC forwarders

**Files:**
- Modify: `agent/internal/heartbeat/handlers_patch.go` (backup handlers become forwarders)
- Create: `agent/internal/heartbeat/backup_forwarder.go` (shared forwarding logic)
- Modify: `agent/internal/heartbeat/handlers_vss.go` and `handlers_vss_other.go` (VSS → forward)
- Modify: `agent/internal/heartbeat/handlers_mssql.go` and `handlers_mssql_other.go`
- Modify: `agent/internal/heartbeat/handlers_hyperv.go` and `handlers_hyperv_other.go`
- Modify: `agent/internal/heartbeat/handlers_systemstate.go`
- Modify: `agent/internal/heartbeat/handlers_bmr.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` (remove direct backupMgr creation)

- [ ] **Step 1: Create the forwarding helper**

```go
// agent/internal/heartbeat/backup_forwarder.go
package heartbeat

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// forwardToBackupHelper sends a command to the backup binary via IPC and returns the result.
func forwardToBackupHelper(h *Heartbeat, cmd Command, timeout time.Duration) tools.CommandResult {
	start := time.Now()

	if h.sessionBroker == nil {
		return tools.NewErrorResult(fmt.Errorf("session broker not available"), time.Since(start).Milliseconds())
	}

	session, err := h.sessionBroker.GetOrSpawnBackupHelper(h.backupBinaryPath)
	if err != nil {
		slog.Error("failed to get backup helper", "error", err.Error())
		return tools.NewErrorResult(fmt.Errorf("backup helper unavailable: %w", err), time.Since(start).Milliseconds())
	}

	payload, _ := json.Marshal(cmd.Payload)
	env, err := h.sessionBroker.ForwardBackupCommand(cmd.ID, cmd.Type, payload, timeout)
	if err != nil {
		return tools.NewErrorResult(fmt.Errorf("backup command failed: %w", err), time.Since(start).Milliseconds())
	}

	var result backupipc.BackupCommandResult
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		return tools.NewErrorResult(fmt.Errorf("invalid backup result: %w", err), time.Since(start).Milliseconds())
	}

	if !result.Success {
		return tools.NewErrorResult(fmt.Errorf("%s", result.Stderr), result.DurationMs)
	}
	return tools.NewSuccessResult(result.Stdout, result.DurationMs)
}
```

- [ ] **Step 2: Replace backup handlers in handlers_patch.go**

Replace the direct backup handler implementations with forwarders. The `init()` registrations stay the same, but the handler functions become thin:

```go
func handleBackupRun(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 10*time.Minute)
}

func handleBackupList(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Second)
}

func handleBackupStop(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 10*time.Second)
}

func handleBackupRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Minute)
}
```

Remove the old implementation bodies and the direct `backup` package imports.

- [ ] **Step 3: Replace VSS handlers**

Replace `handlers_vss.go` (Windows) and `handlers_vss_other.go` with a single file (no build tags needed since forwarding is platform-agnostic):

Create `agent/internal/heartbeat/handlers_vss_forward.go`:

```go
package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdVSSStatus]     = handleVSSStatus
	handlerRegistry[tools.CmdVSSWriterList] = handleVSSWriterList
}

func handleVSSStatus(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Second)
}

func handleVSSWriterList(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Second)
}
```

Delete the old `handlers_vss.go`, `handlers_vss_other.go`.

- [ ] **Step 4: Replace MSSQL, Hyper-V, system state, BMR handlers**

Same pattern — each becomes a thin forwarder. Create:

`handlers_mssql_forward.go`:
```go
package heartbeat

import (
	"time"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func init() {
	handlerRegistry[tools.CmdMSSQLDiscover]  = handleMSSQLDiscover
	handlerRegistry[tools.CmdMSSQLBackup]    = handleMSSQLBackup
	handlerRegistry[tools.CmdMSSQLRestore]   = handleMSSQLRestore
	handlerRegistry[tools.CmdMSSQLVerify]    = handleMSSQLVerify
}

func handleMSSQLDiscover(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 2*time.Minute)
}
func handleMSSQLBackup(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 30*time.Minute)
}
func handleMSSQLRestore(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 60*time.Minute)
}
func handleMSSQLVerify(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 10*time.Minute)
}
```

`handlers_hyperv_forward.go`, `handlers_systemstate_forward.go`, `handlers_bmr_forward.go` — same pattern. Delete the old platform-specific files and their stubs.

- [ ] **Step 5: Add backupBinaryPath to Heartbeat struct**

Edit `agent/internal/heartbeat/heartbeat.go`:
- Add `backupBinaryPath string` field to the `Heartbeat` struct
- Set it from config during initialization: `h.backupBinaryPath = cfg.BackupBinaryPath`
- Remove the `backupMgr` field and all direct backup manager creation code (it moves to breeze-backup)
- Remove `backup` package imports

- [ ] **Step 6: Update config**

Edit `agent/internal/config/config.go` — add:
```go
BackupBinaryPath string `mapstructure:"backup_binary_path"`
```

- [ ] **Step 7: Build and verify no backup package imports in agent**

Run: `cd agent && go build ./cmd/breeze-agent/...`
Expected: Clean build. Verify with: `go list -m all ./cmd/breeze-agent/ | grep -E 'azure|google.cloud|blazer'`
Should return nothing — heavy deps only in breeze-backup.

- [ ] **Step 8: Commit**

```bash
git add agent/internal/heartbeat/ agent/internal/config/config.go
git commit -m "refactor: replace direct backup handlers with IPC forwarders to breeze-backup"
```

---

### Task 5: Update Makefile and verify binary sizes

**Files:**
- Modify: `agent/Makefile`

- [ ] **Step 1: Add breeze-backup build targets**

Add to the Makefile after the existing `build` target:

```makefile
build-backup:
	go build $(LDFLAGS) -o bin/breeze-backup ./cmd/breeze-backup

build: build-agent build-backup

build-agent:
	go build $(LDFLAGS) -o bin/breeze-agent ./cmd/breeze-agent

build-all: build-all-agent build-all-backup

build-all-agent:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-agent-linux-amd64 ./cmd/breeze-agent
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-agent-linux-arm64 ./cmd/breeze-agent
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-agent-darwin-arm64 ./cmd/breeze-agent
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-agent-darwin-amd64 ./cmd/breeze-agent
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-agent-windows-amd64.exe ./cmd/breeze-agent

build-all-backup:
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-backup-linux-amd64 ./cmd/breeze-backup
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-backup-linux-arm64 ./cmd/breeze-backup
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/breeze-backup-darwin-arm64 ./cmd/breeze-backup
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-backup-darwin-amd64 ./cmd/breeze-backup
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o bin/breeze-backup-windows-amd64.exe ./cmd/breeze-backup
```

- [ ] **Step 2: Build both binaries and check sizes**

Run:
```bash
cd agent && make build
ls -lh bin/breeze-agent bin/breeze-backup
```

Expected: `breeze-agent` should be significantly smaller than before. `breeze-backup` contains the heavy deps.

- [ ] **Step 3: Run all tests**

```bash
cd agent && go test -race ./internal/backupipc/... ./internal/backup/... ./internal/sessionbroker/...
```

- [ ] **Step 4: Commit**

```bash
git add agent/Makefile
git commit -m "build: add breeze-backup build targets to Makefile"
```

---

### Task 6: Integration test — IPC round-trip

**Files:**
- Create: `agent/internal/backupipc/integration_test.go`

- [ ] **Step 1: Write integration test**

```go
// agent/internal/backupipc/integration_test.go
package backupipc

import (
	"encoding/json"
	"testing"
)

func TestFullCommandRoundTrip(t *testing.T) {
	// Simulate what the agent sends and backup binary receives
	req := BackupCommandRequest{
		CommandID:   "test-cmd-1",
		CommandType: "backup_run",
		Payload:     json.RawMessage(`{"paths":["/tmp/test"]}`),
		TimeoutMs:   60000,
	}

	// Serialize (agent side)
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	// Deserialize (backup binary side)
	var received BackupCommandRequest
	if err := json.Unmarshal(data, &received); err != nil {
		t.Fatal(err)
	}

	if received.CommandType != "backup_run" {
		t.Errorf("got %s, want backup_run", received.CommandType)
	}

	// Simulate backup binary response
	result := BackupCommandResult{
		CommandID:  received.CommandID,
		Success:    true,
		Stdout:     `{"jobId":"job-1","status":"completed","filesBackedUp":42}`,
		DurationMs: 1500,
	}

	// Serialize (backup side)
	resultData, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	// Deserialize (agent side)
	var agentResult BackupCommandResult
	if err := json.Unmarshal(resultData, &agentResult); err != nil {
		t.Fatal(err)
	}

	if !agentResult.Success {
		t.Error("expected success")
	}
	if agentResult.CommandID != "test-cmd-1" {
		t.Errorf("got %s, want test-cmd-1", agentResult.CommandID)
	}
}

func TestProgressStreaming(t *testing.T) {
	updates := []BackupProgress{
		{CommandID: "cmd-1", Phase: "scan", Current: 0, Total: 100},
		{CommandID: "cmd-1", Phase: "upload", Current: 50, Total: 100, Message: "uploading chunk 5/10"},
		{CommandID: "cmd-1", Phase: "complete", Current: 100, Total: 100},
	}

	for _, p := range updates {
		data, _ := json.Marshal(p)
		var decoded BackupProgress
		json.Unmarshal(data, &decoded)
		if decoded.CommandID != "cmd-1" {
			t.Errorf("got %s, want cmd-1", decoded.CommandID)
		}
	}
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test -race ./internal/backupipc/...`
Expected: PASS (all tests including new integration tests)

- [ ] **Step 3: Final commit**

```bash
git add agent/internal/backupipc/integration_test.go
git commit -m "test: add IPC round-trip integration tests for backup binary split"
```
