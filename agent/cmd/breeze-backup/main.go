// Package main is the entry point for the breeze-backup helper binary.
// It is spawned on demand by the main breeze-agent when backup commands
// arrive, connects to the agent over IPC, and owns all heavy backup
// dependencies (cloud SDKs, VSS COM, MSSQL, Hyper-V).
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
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

type activeCommandCanceller struct {
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
}

func newActiveCommandCanceller() *activeCommandCanceller {
	return &activeCommandCanceller{
		cancels: make(map[string]context.CancelFunc),
	}
}

func (c *activeCommandCanceller) track(commandID string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())

	c.mu.Lock()
	c.cancels[commandID] = cancel
	c.mu.Unlock()

	return ctx, func() {
		c.mu.Lock()
		delete(c.cancels, commandID)
		c.mu.Unlock()
		cancel()
	}
}

func (c *activeCommandCanceller) cancelAll() bool {
	c.mu.Lock()
	if len(c.cancels) == 0 {
		c.mu.Unlock()
		return false
	}

	cancels := make([]context.CancelFunc, 0, len(c.cancels))
	for _, cancel := range c.cancels {
		cancels = append(cancels, cancel)
	}
	c.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}
	return true
}

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

	cfg, err := config.Load("")
	if err != nil {
		slog.Warn("failed to load config, using defaults", "error", err.Error())
		cfg = config.Default()
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

	// Initialize vault if configured
	vaultMgr := initVaultManager(cfg, mgr)
	vaultState := &vaultManagerRef{}
	vaultState.Set(vaultMgr)

	// Report capabilities
	caps := detectCapabilities()
	if vaultMgr != nil {
		caps.SupportsVault = true
	}
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
	commandLoop(ctx, conn, mgr, vaultState, idleTimeout)

	if mgr != nil {
		mgr.Stop()
	}
	slog.Info("breeze-backup exiting")
}

func dialAgent(path string) (*ipc.Conn, error) {
	netConn, err := dialIPC(path)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", path, err)
	}
	return ipc.NewConn(netConn), nil
}

func authenticate(conn *ipc.Conn) error {
	pid := os.Getpid()
	sessionID := fmt.Sprintf("backup-%d", pid)

	selfHash, _ := computeSelfHash()

	req := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		SessionID:       sessionID,
		PID:             pid,
		BinaryHash:      selfHash,
		HelperRole:      backupipc.HelperRoleBackup,
	}

	// Fill UID/SID based on platform
	fillPlatformIdentity(&req)

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

	// Decode hex session key and set it on the connection
	key, err := hex.DecodeString(resp.SessionKey)
	if err != nil {
		return fmt.Errorf("decode session key: %w", err)
	}
	conn.SetSessionKey(key)

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

	retention := cfg.BackupRetention
	if retention <= 0 {
		retention = 7
	}

	// Ensure the configured staging directory exists before use.
	stagingDir := cfg.BackupStagingDir
	if stagingDir != "" {
		if err := os.MkdirAll(stagingDir, 0700); err != nil {
			slog.Error("configured backup staging dir cannot be created, falling back to OS temp dir", "dir", stagingDir, "error", err.Error())
			stagingDir = ""
		}
	}

	mgr := backup.NewBackupManager(backup.BackupConfig{
		Provider:           backupProvider,
		Paths:              cfg.BackupPaths,
		Retention:          retention,
		VSSEnabled:         cfg.BackupVSSEnabled,
		SystemStateEnabled: cfg.BackupSystemStateEnabled,
		StagingDir:         stagingDir,
	})

	return mgr
}

type vaultManagerRef struct {
	mu  sync.RWMutex
	mgr *backup.VaultManager
}

func (r *vaultManagerRef) Get() *backup.VaultManager {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.mgr
}

func (r *vaultManagerRef) Set(mgr *backup.VaultManager) {
	r.mu.Lock()
	r.mgr = mgr
	r.mu.Unlock()
}

func buildVaultManager(cfg *config.Config, mgr *backup.BackupManager) (*backup.VaultManager, error) {
	if cfg == nil || !cfg.VaultEnabled {
		return nil, nil
	}
	if cfg.VaultPath == "" {
		return nil, fmt.Errorf("vault path is required when vault is enabled")
	}

	var primary providers.BackupProvider
	if mgr != nil {
		primary = mgr.GetProvider()
	} else {
		// Vault can still be initialized with a local provider for standalone use
		localPath := cfg.BackupLocalPath
		if localPath == "" {
			localPath = config.GetDataDir() + "/backups"
		}
		primary = providers.NewLocalProvider(localPath)
	}

	retention := cfg.VaultRetentionCount
	if retention <= 0 {
		retention = 3
	}

	return backup.NewVaultManager(backup.VaultConfig{
		VaultPath:      cfg.VaultPath,
		RetentionCount: retention,
		Enabled:        cfg.VaultEnabled,
	}, primary)
}

func initVaultManager(cfg *config.Config, mgr *backup.BackupManager) *backup.VaultManager {
	vm, err := buildVaultManager(cfg, mgr)
	if err != nil {
		slog.Warn("failed to init vault manager", "error", err.Error())
		return nil
	}
	if vm == nil {
		return nil
	}

	slog.Info("vault manager initialized", "path", cfg.VaultPath, "retention", cfg.VaultRetentionCount)
	return vm
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

func commandLoop(ctx context.Context, conn *ipc.Conn, mgr *backup.BackupManager, vaultState *vaultManagerRef, idleTimeout time.Duration) {
	idleTimer := time.NewTimer(idleTimeout)
	defer idleTimer.Stop()
	var activeCommands atomic.Int64
	commandCanceller := newActiveCommandCanceller()

	for {
		select {
		case <-ctx.Done():
			return
		case <-idleTimer.C:
			if activeCommands.Load() > 0 {
				idleTimer.Reset(idleTimeout)
				continue
			}
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
			activeCommands.Add(1)
			go func() {
				defer activeCommands.Add(-1)
				handleBackupCommand(conn, env, mgr, vaultState, commandCanceller)
			}()
		case backupipc.TypeBackupShutdown:
			slog.Info("received shutdown command")
			return
		case ipc.TypePing:
			if err := conn.SendTyped(env.ID, ipc.TypePong, nil); err != nil {
				slog.Error("IPC pong send failed, connection likely dead", "error", err.Error())
				return
			}
		}
	}
}

func handleBackupCommand(conn *ipc.Conn, env *ipc.Envelope, mgr *backup.BackupManager, vaultState *vaultManagerRef, commandCanceller *activeCommandCanceller) {
	var req backupipc.BackupCommandRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		sendError(conn, env.ID, "invalid request payload: "+err.Error())
		return
	}

	start := time.Now()

	// Async backup_run: ack the request envelope immediately with
	// {"started":true} so the agent's forward wait (session.SendCommand)
	// returns in seconds instead of blocking on the full run, then keep
	// running the real backup and deliver the terminal result later as an
	// unsolicited envelope. Only ever set by the agent when the connected
	// server has advertised the backup_run_async capability — an old server
	// would otherwise parse this ack as a malformed terminal result, so this
	// branch must never fire unless req.Async was explicitly set upstream.
	if req.CommandType == "backup_run" && req.Async {
		ack := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true, Stdout: `{"started":true}`}
		if err := conn.SendTyped(env.ID, backupipc.TypeBackupResult, ack); err != nil {
			slog.Error("failed to send backup ack", "commandId", req.CommandID, "error", err.Error())
		}
		result := executeCommand(req, mgr, vaultState, conn, commandCanceller)
		result.CommandID = req.CommandID
		result.DurationMs = time.Since(start).Milliseconds()
		if err := sendUnsolicitedResult(conn, result); err != nil {
			slog.Error("failed to send final backup result", "commandId", req.CommandID, "error", err.Error())
		}
		return
	}

	var result backupipc.BackupCommandResult
	if req.CommandType == "backup_restore" {
		ctx, cleanup := commandCanceller.track(req.CommandID)
		defer cleanup()
		result = execBackupRestoreWithProgress(ctx, req.CommandID, req.Payload, mgr, vaultState, conn)
	} else {
		result = executeCommand(req, mgr, vaultState, conn, commandCanceller)
	}
	result.CommandID = req.CommandID
	result.DurationMs = time.Since(start).Milliseconds()

	if err := conn.SendTyped(env.ID, backupipc.TypeBackupResult, result); err != nil {
		slog.Error("failed to send result", "commandId", req.CommandID, "error", err.Error())
	}
}

// sendUnsolicitedResult sends a terminal backup_result envelope that is not
// a reply to any pending request — used for the async backup_run flow's real
// result, delivered after the immediate ack. It mirrors how the ack/sync
// reply is sent but always with a fresh envelope ID (never env.ID / the
// request's CommandID), so it cannot match a still-pending entry in the
// broker's session.pending map and instead falls through
// dispatchHelperMessage to the heartbeat's unsolicited-result handler (see
// heartbeat.go, case backupipc.TypeBackupResult).
func sendUnsolicitedResult(conn *ipc.Conn, result backupipc.BackupCommandResult) error {
	id := fmt.Sprintf("%s-final-%d", result.CommandID, time.Now().UnixNano())
	return conn.SendTyped(id, backupipc.TypeBackupResult, result)
}

func executeCommand(req backupipc.BackupCommandRequest, mgr *backup.BackupManager, vaultState *vaultManagerRef, conn *ipc.Conn, commandCanceller *activeCommandCanceller) backupipc.BackupCommandResult {
	if req.CommandType == "backup_run" {
		payloadMgr, err := managerFromBackupRunPayload(req.Payload)
		if err != nil {
			return fail(err.Error())
		}
		if payloadMgr != nil {
			mgr = payloadMgr
		}
	}

	if mgr == nil {
		// Some commands don't need the manager (e.g., discovery, hardware profile)
		switch req.CommandType {
		case "hardware_profile":
			return execHardwareProfile()
		case "system_state_collect":
			return execSystemStateCollect()
		case "mssql_discover":
			return execMSSQLDiscover()
		case "hyperv_discover":
			return execHypervDiscover()
		case "vault_status":
			return execVaultStatus(vaultState)
		case "bmr_recover":
			ctx, cleanup := commandCanceller.track(req.CommandID)
			defer cleanup()
			return execBMRRecover(ctx, req.Payload, nil)
		case "backup_verify":
			// Verify/test-restore build their read provider from the command
			// payload's providerConfig (restoreProviderForCommand), so they work
			// even with no agent.yaml manager. Route them here instead of falling
			// through to "backup not configured".
			return execBackupVerify(req.Payload, mgr, vaultState)
		case "backup_test_restore":
			return execBackupTestRestore(req.Payload, mgr, vaultState)
		case "backup_stop":
			// Server-dispatched backup_runs build ephemeral payload managers
			// tracked only by the canceller — a device with no agent.yaml
			// backup config still has runs to stop. Falling through to
			// "backup not configured" made Stop a silent no-op for every
			// policy-managed device.
			return ok(fmt.Sprintf(`{"stopped":%t}`, commandCanceller.cancelAll()))
		default:
			return fail("backup not configured on this device")
		}
	}

	switch req.CommandType {
	// Core backup operations
	case "backup_run":
		if err := applyCommandStorageEncryption(mgr.GetProvider(), req.Payload); err != nil {
			return fail(err.Error())
		}
		excludes, err := parseBackupRunExcludes(req.Payload)
		if err != nil {
			return fail(err.Error())
		}
		// Track this command with the canceller so backup_stop's cancelAll()
		// can abort the run even though mgr may be an ephemeral
		// payload-built manager that never goes through Stop() (see
		// managerFromBackupRunPayload above).
		ctx, cleanup := commandCanceller.track(req.CommandID)
		defer cleanup()
		// mgr here may be the ephemeral payload-built manager resolved above
		// (not the long-lived agent.yaml manager), so the progress fn is set
		// on it directly, right before the run that actually uses it.
		mgr.SetProgressFn(func(filesDone, filesTotal int, bytesDone, bytesTotal int64) {
			sendBackupRunProgress(conn, req.CommandID, backupipc.BackupProgress{
				CommandID: req.CommandID, Phase: "uploading",
				Current: bytesDone, Total: bytesTotal,
				FilesDone: filesDone, FilesTotal: filesTotal,
			})
		})
		result := marshalResult(mgr.RunBackupContext(ctx, excludes))
		// Auto-sync to vault after successful backup (async — don't block command response)
		if result.Success {
			go autoSyncToVault(result.Stdout, vaultState, conn)
		}
		return result
	case "backup_list":
		return marshalResult(backup.ListSnapshots(mgr.GetProvider()))
	case "backup_stop":
		stopped := mgr.Stop()
		cancelled := commandCanceller.cancelAll()
		return ok(fmt.Sprintf(`{"stopped":%t}`, stopped || cancelled))
	case "backup_restore":
		return execBackupRestore(req.Payload, mgr, vaultState)
	case "backup_verify":
		return execBackupVerify(req.Payload, mgr, vaultState)
	case "backup_test_restore":
		return execBackupTestRestore(req.Payload, mgr, vaultState)
	case "backup_cleanup":
		return execBackupCleanup(req.Payload)

	// Vault operations
	case "vault_sync":
		return execVaultSync(req.Payload, vaultState)
	case "vault_status":
		return execVaultStatus(vaultState)
	case "vault_configure":
		return execVaultConfigure(req.Payload, mgr, vaultState)

	// VSS
	case "vss_status", "vss_writer_list":
		return execVSS(req.CommandType)

	// System state & BMR
	case "system_state_collect":
		return execSystemStateCollect()
	case "hardware_profile":
		return execHardwareProfile()
	case "bmr_recover":
		ctx, cleanup := commandCanceller.track(req.CommandID)
		defer cleanup()
		return execBMRRecover(ctx, req.Payload, mgr)
	case "vm_restore_from_backup":
		ctx, cleanup := commandCanceller.track(req.CommandID)
		defer cleanup()
		return execVMRestoreFromBackup(ctx, req.Payload, mgr)
	case "vm_instant_boot":
		ctx, cleanup := commandCanceller.track(req.CommandID)
		defer cleanup()
		return execInstantBoot(ctx, req.Payload, mgr)
	case "vm_restore_estimate":
		return execVMRestoreEstimate(req.Payload, mgr)

	// MSSQL
	case "mssql_discover":
		return execMSSQLDiscover()
	case "mssql_backup":
		return execMSSQLBackup(req.Payload, mgr)
	case "mssql_restore":
		return execMSSQLRestore(req.Payload, mgr)
	case "mssql_verify":
		return execMSSQLVerify(req.Payload, mgr)

	// Hyper-V
	case "hyperv_discover":
		return execHypervDiscover()
	case "hyperv_backup":
		return execHypervBackup(req.Payload, mgr)
	case "hyperv_restore":
		return execHypervRestore(req.Payload, mgr)
	case "hyperv_checkpoint":
		return execHypervCheckpoint(req.Payload)
	case "hyperv_vm_state":
		return execHypervVMState(req.Payload)

	default:
		return fail(fmt.Sprintf("unknown backup command: %s", req.CommandType))
	}
}

// --- helpers ---

func ok(stdout string) backupipc.BackupCommandResult {
	return backupipc.BackupCommandResult{Success: true, Stdout: stdout}
}

func fail(msg string) backupipc.BackupCommandResult {
	return backupipc.BackupCommandResult{Success: false, Stderr: msg}
}

func marshalResult(v any, err error) backupipc.BackupCommandResult {
	if err != nil {
		return fail(err.Error())
	}
	data, merr := json.Marshal(v)
	if merr != nil {
		return fail(fmt.Sprintf("failed to marshal result: %v", merr))
	}
	return ok(string(data))
}

// --- infra helpers ---

func sendError(conn *ipc.Conn, id, msg string) {
	result := backupipc.BackupCommandResult{Success: false, Stderr: msg}
	_ = conn.SendTyped(id, backupipc.TypeBackupResult, result)
}

// sendBackupRunProgress sends a backup_run progress envelope to the agent
// over conn, mirroring how execBackupRestoreWithProgress sends restore
// progress. Send failures are log-only: progress is best-effort telemetry,
// never a reason to fail or abort the backup run itself.
func sendBackupRunProgress(conn *ipc.Conn, id string, progress backupipc.BackupProgress) {
	if conn == nil {
		return
	}
	if err := conn.SendTyped("", backupipc.TypeBackupProgress, progress); err != nil {
		slog.Warn("failed to send backup_run progress", "commandId", id, "error", err.Error())
	}
}

func isTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	// The IPC layer wraps read errors (`ipc: read header: %w`), so a plain type
	// assertion misses the net-timeout / deadline-exceeded error underneath and
	// the command loop treats a routine 1s idle read-deadline as fatal, exiting
	// the helper ~1s after connecting. Unwrap the chain instead.
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var netErr interface{ Timeout() bool }
	if errors.As(err, &netErr) {
		return netErr.Timeout()
	}
	return false
}

func computeSelfHash() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(exePath)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
