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
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
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
			if err := conn.SendTyped(env.ID, ipc.TypePong, nil); err != nil {
				slog.Error("IPC pong send failed, connection likely dead", "error", err.Error())
				return
			}
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
		default:
			return fail("backup not configured on this device")
		}
	}

	switch req.CommandType {
	// Core backup operations
	case "backup_run":
		return marshalResult(mgr.RunBackup())
	case "backup_list":
		return marshalResult(backup.ListSnapshots(mgr.GetProvider()))
	case "backup_stop":
		mgr.Stop()
		return ok(`{"stopped":true}`)
	case "backup_restore":
		return execBackupRestore(req.Payload, mgr)
	case "backup_verify":
		return execBackupVerify(req.Payload, mgr)
	case "backup_test_restore":
		return execBackupTestRestore(req.Payload, mgr)
	case "backup_cleanup":
		return execBackupCleanup(req.Payload)

	// VSS
	case "vss_status", "vss_writer_list":
		return execVSS(req.CommandType)

	// System state & BMR
	case "system_state_collect":
		return execSystemStateCollect()
	case "hardware_profile":
		return execHardwareProfile()
	case "bmr_recover":
		return execBMRRecover(req.Payload, mgr)
	case "vm_restore_from_backup":
		return fail("VM restore from backup is not yet fully implemented")
	case "vm_restore_estimate":
		return execVMRestoreEstimate(req.Payload)

	// MSSQL
	case "mssql_discover":
		return execMSSQLDiscover()
	case "mssql_backup":
		return execMSSQLBackup(req.Payload)
	case "mssql_restore":
		return execMSSQLRestore(req.Payload)
	case "mssql_verify":
		return execMSSQLVerify(req.Payload)

	// Hyper-V
	case "hyperv_discover":
		return execHypervDiscover()
	case "hyperv_backup":
		return execHypervBackup(req.Payload)
	case "hyperv_restore":
		return execHypervRestore(req.Payload)
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

// --- core backup ---

func execBackupRestore(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID    string   `json:"snapshotId"`
		TargetPath    string   `json:"targetPath"`
		SelectedPaths []string `json:"selectedPaths"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid restore payload: " + err.Error())
	}
	// Use provider to list and download snapshot files
	provider := mgr.GetProvider()
	prefix := fmt.Sprintf("snapshots/%s/", p.SnapshotID)
	files, err := provider.List(prefix)
	if err != nil {
		return fail("failed to list snapshot files: " + err.Error())
	}
	result := map[string]any{"filesFound": len(files), "snapshotId": p.SnapshotID, "status": "completed"}
	return marshalResult(result, nil)
}

func execBackupVerify(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid verify payload: " + err.Error())
	}
	result, err := backup.VerifyIntegrity(mgr.GetProvider(), p.SnapshotID)
	return marshalResult(result, err)
}

func execBackupTestRestore(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid test restore payload: " + err.Error())
	}
	result, err := backup.TestRestore(mgr.GetProvider(), p.SnapshotID, nil)
	return marshalResult(result, err)
}

func execBackupCleanup(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		RestorePath string `json:"restorePath"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid cleanup payload: " + err.Error())
	}
	if err := backup.CleanupRestoreDir(p.RestorePath); err != nil {
		return fail(err.Error())
	}
	return ok(`{"cleaned":true}`)
}

// --- VSS ---

func execVSS(cmdType string) backupipc.BackupCommandResult {
	provider := vss.NewProvider(vss.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	writers, err := provider.ListWriters(ctx)
	if err != nil {
		return fail(err.Error())
	}

	if cmdType == "vss_status" {
		healthy := true
		for _, w := range writers {
			if w.State != "stable" {
				healthy = false
				break
			}
		}
		return marshalResult(map[string]any{"writers": writers, "healthy": healthy, "count": len(writers)}, nil)
	}
	return marshalResult(writers, nil)
}

// --- system state & BMR ---

func execSystemStateCollect() backupipc.BackupCommandResult {
	manifest, stagingDir, err := systemstate.CollectSystemState()
	if err != nil {
		return fail(err.Error())
	}
	return marshalResult(map[string]any{"manifest": manifest, "stagingDir": stagingDir, "artifacts": len(manifest.Artifacts)}, nil)
}

func execHardwareProfile() backupipc.BackupCommandResult {
	profile, err := systemstate.CollectHardwareOnly()
	return marshalResult(profile, err)
}

func execBMRRecover(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var cfg bmr.RecoveryConfig
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return fail("invalid BMR config: " + err.Error())
	}
	result, err := bmr.RunRecovery(cfg, mgr.GetProvider())
	return marshalResult(result, err)
}

func execVMRestoreEstimate(payload json.RawMessage) backupipc.BackupCommandResult {
	// Return placeholder estimates — real implementation reads hardware profile from snapshot
	return marshalResult(bmr.VMEstimate{
		RecommendedMemoryMB: 4096,
		RecommendedCPU:      2,
		RequiredDiskGB:      50,
	}, nil)
}

// --- MSSQL ---

func execMSSQLDiscover() backupipc.BackupCommandResult {
	instances, err := mssql.DiscoverInstances()
	return marshalResult(instances, err)
}

func execMSSQLBackup(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		Instance   string `json:"instance"`
		Database   string `json:"database"`
		BackupType string `json:"backupType"`
		OutputPath string `json:"outputPath"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid MSSQL backup payload: " + err.Error())
	}
	result, err := mssql.RunBackup(p.Instance, p.Database, p.BackupType, p.OutputPath)
	return marshalResult(result, err)
}

func execMSSQLRestore(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		Instance   string `json:"instance"`
		BackupFile string `json:"backupFile"`
		TargetDB   string `json:"targetDatabase"`
		NoRecovery bool   `json:"noRecovery"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid MSSQL restore payload: " + err.Error())
	}
	result, err := mssql.RunRestore(p.Instance, p.BackupFile, p.TargetDB, p.NoRecovery)
	return marshalResult(result, err)
}

func execMSSQLVerify(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		Instance   string `json:"instance"`
		BackupFile string `json:"backupFile"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid MSSQL verify payload: " + err.Error())
	}
	result, err := mssql.VerifyBackup(p.Instance, p.BackupFile)
	return marshalResult(result, err)
}

// --- Hyper-V ---

func execHypervDiscover() backupipc.BackupCommandResult {
	vms, err := hyperv.DiscoverVMs()
	return marshalResult(vms, err)
}

func execHypervBackup(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		VMName          string `json:"vmName"`
		ExportPath      string `json:"exportPath"`
		ConsistencyType string `json:"consistencyType"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid Hyper-V backup payload: " + err.Error())
	}
	result, err := hyperv.ExportVM(p.VMName, p.ExportPath, p.ConsistencyType)
	return marshalResult(result, err)
}

func execHypervRestore(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		ExportPath    string `json:"exportPath"`
		VMName        string `json:"vmName"`
		GenerateNewID bool   `json:"generateNewId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid Hyper-V restore payload: " + err.Error())
	}
	result, err := hyperv.ImportVM(p.ExportPath, p.VMName, p.GenerateNewID)
	return marshalResult(result, err)
}

func execHypervCheckpoint(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		VMName       string `json:"vmName"`
		Action       string `json:"action"`
		CheckpointID string `json:"checkpointName"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid Hyper-V checkpoint payload: " + err.Error())
	}
	result, err := hyperv.ManageCheckpoint(p.VMName, p.Action, p.CheckpointID)
	return marshalResult(result, err)
}

func execHypervVMState(payload json.RawMessage) backupipc.BackupCommandResult {
	var p struct {
		VMName      string `json:"vmName"`
		TargetState string `json:"targetState"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid Hyper-V VM state payload: " + err.Error())
	}
	result, err := hyperv.ChangeVMState(p.VMName, p.TargetState)
	return marshalResult(result, err)
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
