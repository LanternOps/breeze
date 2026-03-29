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
