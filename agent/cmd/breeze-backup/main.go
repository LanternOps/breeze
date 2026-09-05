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
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/secmem"
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
	mu       sync.Mutex
	cancels  map[string]context.CancelFunc
	contexts map[string]context.Context
}

func newActiveCommandCanceller() *activeCommandCanceller {
	return &activeCommandCanceller{
		cancels:  make(map[string]context.CancelFunc),
		contexts: make(map[string]context.Context),
	}
}

func (c *activeCommandCanceller) track(commandID string) (context.Context, func()) {
	c.mu.Lock()
	if ctx, exists := c.contexts[commandID]; exists {
		c.mu.Unlock()
		return ctx, func() {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.contexts[commandID] = ctx
	c.cancels[commandID] = cancel
	c.mu.Unlock()

	return ctx, func() {
		c.mu.Lock()
		delete(c.cancels, commandID)
		delete(c.contexts, commandID)
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

	// Stable, parseable `breeze-backup --version` output, mirroring the
	// watchdog's "Watchdog Version:" line (cmd/breeze-watchdog). The heartbeat's
	// installedBackupVersion() execs this binary and parses the same prefix.
	rootCmd.Version = version
	rootCmd.SetVersionTemplate("Breeze Backup Version: {{.Version}}\n")
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

// initLogging wires this process into the agent's logging stack: a rotating
// file at <logdir>/backup.log plus the shared log shipper.
//
// Until this existed, breeze-backup relied on the package-level slog default
// (stdout) and the backup packages used stdlib log.Printf (stderr). The agent
// spawns us with inherited stdio (sessionbroker/backup.go), which under a
// Windows service or a launchd daemon is NUL — so every line a backup run
// produced was discarded, on disk and over the wire alike. A multi-hour hung
// backup left three lines in agent.log and nothing else (#2790).
//
// Returns a close func the caller must run before exiting, including on the
// os.Exit paths below: the shipper batches on a 60s ticker and only drains on
// an explicit Stop, so skipping it loses whatever is buffered.
func initLogging(cfg *config.Config) func() {
	logDir := filepath.Dir(cfg.LogFile)
	_ = os.MkdirAll(logDir, 0700)

	var output io.Writer = os.Stdout
	if rw, err := logging.NewRotatingWriter(
		filepath.Join(logDir, "backup.log"),
		cfg.LogMaxSizeMB,
		cfg.LogMaxBackups,
	); err == nil {
		// Spawned from the service with no console, stdout is invalid — a
		// TeeWriter would abort the whole write on the stdout leg, so go
		// file-only unless we actually have a console.
		if hasConsole() {
			output = logging.TeeWriter(os.Stdout, rw)
		} else {
			output = rw
		}
	}
	logging.Init(cfg.LogFormat, cfg.LogLevel, output)

	// Go runtime panics write to fd 2, which bypasses slog entirely and would
	// otherwise go to NUL under the service. Point stderr at its own plain
	// file rather than the rotating writer: rotation renames the file out from
	// under any handle we hand off, and a panic trace split across a rotation
	// boundary is worse than useless. Panics are rare, so this stays tiny.
	if pf, err := os.OpenFile(
		filepath.Join(logDir, "backup-panic.log"),
		os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600,
	); err == nil {
		redirectStderr(pf)
	}

	// We are spawned by the agent service and run as SYSTEM/root, so the full
	// config.Load already gave us the real agent credentials. Unlike the user
	// helper we don't need the helper-scoped token.
	if cfg.AgentID == "" || cfg.ServerURL == "" || cfg.AuthToken == "" {
		return func() {}
	}
	token := secmem.NewSecureString(cfg.AuthToken)
	cfg.AuthToken = ""
	logging.InitShipper(logging.ShipperConfig{
		ServerURL:    config.NewPersistedServerURLProvider("", cfg.ServerURL, 0),
		AgentID:      cfg.AgentID,
		AuthToken:    token,
		AgentVersion: version + "-backup",
		MinLevel:     cfg.LogShippingLevel,
		AuthMonitor:  authstate.NewMonitor(3),
	})
	return logging.StopShipper
}

func runBackupHelper() {
	if socketPath == "" {
		socketPath = ipc.DefaultSocketPath()
	}

	// Config first: it carries the log file path, level and shipping
	// credentials, so there is nowhere useful to send a load failure until
	// after logging is up. Stash it and log once we can.
	cfg, cfgErr := config.Load("")
	if cfgErr != nil {
		cfg = config.Default()
	}

	stopLogging := initLogging(cfg)
	log := logging.L("backup-helper")
	if cfgErr != nil {
		log.Warn("failed to load config, using defaults", "error", cfgErr.Error())
	}
	log.Info("breeze-backup starting",
		"version", version,
		"pid", os.Getpid(),
		"platform", runtime.GOOS,
		"logFile", filepath.Join(filepath.Dir(cfg.LogFile), "backup.log"),
		"logLevel", cfg.LogLevel,
	)

	// Connect to main agent via IPC
	conn, err := dialAgent(socketPath)
	if err != nil {
		log.Error("failed to connect to agent", "error", err.Error())
		stopLogging()
		os.Exit(1)
	}
	defer conn.Close()

	// Authenticate
	if err := authenticate(conn); err != nil {
		log.Error("authentication failed", "error", err.Error())
		stopLogging()
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
		log.Error("failed to send capabilities", "error", err.Error())
		stopLogging()
		os.Exit(1)
	}

	// Set up signal handling
	ctx, cancel := context.WithCancel(context.Background())
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Info("received shutdown signal")
		cancel()
	}()

	// Enter command loop with idle timeout
	idleTimeout := 30 * time.Minute
	commandLoop(ctx, conn, mgr, vaultState, idleTimeout)

	if mgr != nil {
		mgr.Stop()
	}
	log.Info("breeze-backup exiting")
	stopLogging()
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
	queue := newBackupExecutionQueue()
	defer commandCanceller.cancelAll()

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
			var req backupipc.BackupCommandRequest
			var ticket *backupExecutionTicket
			if json.Unmarshal(env.Payload, &req) == nil && isBackupWorkload(req.CommandType) {
				ticket = queue.enqueue(req.CommandID, commandCanceller)
				if ticket == nil {
					// A retried envelope acknowledges the existing admission; it
					// must not execute or settle that command a second time.
					if req.Async {
						stdout := `{"started":true}`
						if req.QueueAsync {
							stdout = `{"queued":true}`
						}
						_ = conn.SendTyped(env.ID, backupipc.TypeBackupResult, backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true, Stdout: stdout})
					}
					continue
				}
			}
			activeCommands.Add(1)
			go func() {
				defer activeCommands.Add(-1)
				handleBackupCommand(conn, env, mgr, vaultState, commandCanceller, ticket)
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

func handleBackupCommand(conn *ipc.Conn, env *ipc.Envelope, mgr *backup.BackupManager, vaultState *vaultManagerRef, commandCanceller *activeCommandCanceller, tickets ...*backupExecutionTicket) {
	var req backupipc.BackupCommandRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		sendError(conn, env.ID, "invalid request payload: "+err.Error())
		return
	}

	start := time.Now()
	var ticket *backupExecutionTicket
	if len(tickets) > 0 {
		ticket = tickets[0]
	}
	if ticket != nil {
		defer ticket.release()
	}
	run := func() backupipc.BackupCommandResult {
		if req.QueueAsync {
			sendBackupRunProgress(conn, req.CommandID, backupipc.BackupProgress{CommandID: req.CommandID, Phase: "queued"})
		}
		if ticket != nil {
			if err := ticket.wait(func() {
				if req.QueueAsync {
					sendBackupRunProgress(conn, req.CommandID, backupipc.BackupProgress{CommandID: req.CommandID, Phase: "queued"})
				}
			}); err != nil {
				return fail(err.Error())
			}
		}
		if isBackupWorkload(req.CommandType) {
			ctx, cleanup := commandCanceller.track(req.CommandID)
			defer cleanup()
			ctx, release, err := backup.AcquireExecutionWithProgress(ctx, func() {
				if req.QueueAsync {
					sendBackupRunProgress(conn, req.CommandID, backupipc.BackupProgress{CommandID: req.CommandID, Phase: "queued"})
				}
			})
			if err != nil {
				return fail(err.Error())
			}
			defer release()
			start = time.Now()
			commandCanceller.mu.Lock()
			commandCanceller.contexts[req.CommandID] = ctx
			commandCanceller.mu.Unlock()
		}
		if req.QueueAsync {
			sendBackupRunProgress(conn, req.CommandID, backupipc.BackupProgress{CommandID: req.CommandID, Phase: "starting"})
		}
		if req.QueueAsync && (req.CommandType == "mssql_backup" || req.CommandType == "hyperv_backup") {
			// Native exports have no progress callback while their subprocess is
			// running. Keep their liveness/expectation alive until actual return.
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()
			stop := startBackupHeartbeat(ticker.C, func() {
				sendBackupRunProgress(conn, req.CommandID, backupipc.BackupProgress{CommandID: req.CommandID, Phase: "executing"})
			})
			defer stop()
		}
		return executeCommand(req, mgr, vaultState, conn, commandCanceller)
	}

	// Async backup_run: ack the request envelope immediately with
	// {"started":true} so the agent's forward wait (session.SendCommand)
	// returns in seconds instead of blocking on the full run, then keep
	// running the real backup and deliver the terminal result later as an
	// unsolicited envelope. Only ever set by the agent when the connected
	// server has advertised the backup_run_async capability — an old server
	// would otherwise parse this ack as a malformed terminal result, so this
	// branch must never fire unless req.Async was explicitly set upstream.
	if isBackupWorkload(req.CommandType) && req.Async {
		ack := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true, Stdout: `{"started":true}`}
		if req.QueueAsync {
			ack.Stdout = `{"queued":true}`
		}
		if err := conn.SendTyped(env.ID, backupipc.TypeBackupResult, ack); err != nil {
			slog.Error("failed to send backup ack", "commandId", req.CommandID, "error", err.Error())
			return
		}
		result := run()
		result.CommandID = req.CommandID
		result.DurationMs = time.Since(start).Milliseconds()
		// sendUnsolicitedResult bounds the payload before sending: an oversize
		// terminal result used to be dropped outright, leaving a SUCCEEDED
		// backup stuck `running` until the stale-backup reaper failed it
		// (#3001). Send failures are logged inside sendBackupResult under
		// component=backup so they ship server-side.
		_ = sendUnsolicitedResult(conn, result)
		return
	}

	var result backupipc.BackupCommandResult
	if req.CommandType == "backup_restore" {
		ctx, cleanup := commandCanceller.track(req.CommandID)
		defer cleanup()
		result = execBackupRestoreWithProgress(ctx, req.CommandID, req.Payload, mgr, vaultState, conn)
	} else {
		result = run()
	}
	result.CommandID = req.CommandID
	result.DurationMs = time.Since(start).Milliseconds()

	// Same oversize guard as the async path above: the synchronous reply is
	// what resolves the agent's pending request, so dropping it strands the
	// command until its forward wait times out (#3001).
	_ = sendBackupResult(conn, env.ID, result)
}

// sendUnsolicitedResult sends a terminal backup_result envelope that is not
// a reply to any pending request — used for the async backup_run flow's real
// result, delivered after the immediate ack. It mirrors how the ack/sync
// reply is sent but always with a fresh envelope ID (never env.ID / the
// request's CommandID), so it cannot match a still-pending entry in the
// broker's session.pending map and instead falls through
// dispatchHelperMessage to the heartbeat's unsolicited-result handler (see
// heartbeat.go, case backupipc.TypeBackupResult).
//
// It goes through sendBackupResult so the payload is bounded to the IPC frame
// first — see result_bounds.go and #3001.
func sendUnsolicitedResult(conn *ipc.Conn, result backupipc.BackupCommandResult) error {
	id := fmt.Sprintf("%s-final-%d", result.CommandID, time.Now().UnixNano())
	return sendBackupResult(conn, id, result)
}

func executeCommand(req backupipc.BackupCommandRequest, mgr *backup.BackupManager, vaultState *vaultManagerRef, conn *ipc.Conn, commandCanceller *activeCommandCanceller) backupipc.BackupCommandResult {
	if req.CommandType == "backup_stop" {
		var payload struct {
			JobID string `json:"jobId"`
		}
		if err := json.Unmarshal(req.Payload, &payload); err != nil && len(req.Payload) > 0 {
			return fail("invalid backup_stop payload")
		}
		if payload.JobID != "" {
			commandCanceller.mu.Lock()
			cancel := commandCanceller.cancels[payload.JobID]
			if cancel != nil {
				cancel()
			}
			commandCanceller.mu.Unlock()
			return ok(fmt.Sprintf(`{"stopped":%t}`, cancel != nil))
		}
	}
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
		mgr.SetProgressFn(func(filesDone, filesTotal int, bytesDone, bytesTotal int64, snapshotID string) {
			sendBackupRunProgress(conn, req.CommandID, backupipc.BackupProgress{
				CommandID: req.CommandID, Phase: "uploading",
				Current: bytesDone, Total: bytesTotal,
				FilesDone: filesDone, FilesTotal: filesTotal,
				// Forwarded so the server records backup_jobs.snapshot_id
				// mid-run (#3006). Empty on pre-snapshot keepalives.
				SnapshotID: snapshotID,
			})
		})
		result := marshalBackupRunResult(mgr.RunBackupContext(ctx, excludes))
		// Auto-sync to vault after successful backup (async — don't block command response)
		if result.Success {
			go autoSyncToVault(result.Stdout, vaultState, conn)
		}
		return result
	case "backup_list":
		return marshalResult(backup.ListSnapshots(mgr.GetProvider()))
	case "backup_stop":
		cancelled := commandCanceller.cancelAll()
		stopped := mgr.Stop()
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

// marshalBackupRunResult is marshalResult for backup_run specifically, differing
// on ONE point: a failed run still carries its job body.
//
// The generic marshalResult throws `v` away when err != nil, so on every hard
// failure the server received Stderr and nothing else. That silently defeated
// #3027 on the branch where the diagnostics matter most: job.VSSMetadata and
// job.Warning were both built by then — recording, say, that no shadow copy
// could be created and which writers were wedged — and both were discarded one
// frame before the wire. The counters (filesBackedUp, errorCount) went with
// them.
//
// Success stays false and Stderr still carries the failure reason, so the server
// still records the job `failed` (routes/agentWs.ts gates on
// `result.status === 'completed'`). The body only adds detail to a failure that
// was going to be a failure regardless. A body that cannot be marshalled is
// simply omitted — a marshalling problem must never escalate into losing the
// failure reason itself.
func marshalBackupRunResult(job *backup.BackupJob, err error) backupipc.BackupCommandResult {
	if err == nil {
		return marshalResult(job, nil)
	}
	result := fail(err.Error())
	if job == nil {
		return result
	}
	if data, merr := json.Marshal(job); merr == nil {
		result.Stdout = string(data)
	}
	return result
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
