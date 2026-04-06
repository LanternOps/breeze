package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/backup/vss"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// --- core backup ---

func resolveRestoreProvider(mgr *backup.BackupManager, vaultState *vaultManagerRef) providers.BackupProvider {
	if mgr == nil {
		return nil
	}
	primary := mgr.GetProvider()
	if primary == nil {
		return nil
	}
	if vaultState == nil {
		return primary
	}
	vaultMgr := vaultState.Get()
	if vaultMgr == nil {
		return primary
	}
	vaultProvider := vaultMgr.GetProvider()
	if vaultProvider == nil {
		return primary
	}
	return providers.NewFallbackProvider(vaultProvider, primary)
}

func execBackupRestore(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	return execBackupRestoreWithProgress(context.Background(), "", payload, mgr, vaultState, nil)
}

func execBackupRestoreWithProgress(ctx context.Context, commandID string, payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef, conn *ipc.Conn) backupipc.BackupCommandResult {
	restoreProvider := resolveRestoreProvider(mgr, vaultState)
	if restoreProvider == nil {
		return fail("backup not configured on this device")
	}

	var p struct {
		CommandID     string   `json:"commandId"`
		SnapshotID    string   `json:"snapshotId"`
		TargetPath    string   `json:"targetPath"`
		SelectedPaths []string `json:"selectedPaths"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid restore payload: " + err.Error())
	}

	cfg := backup.RestoreConfig{
		SnapshotID:    p.SnapshotID,
		TargetPath:    p.TargetPath,
		SelectedPaths: p.SelectedPaths,
	}

	var progressFn backup.ProgressFunc
	if conn != nil {
		cmdID := commandID
		if cmdID == "" {
			cmdID = p.CommandID
		}
		progressFn = func(phase string, current, total int64, message string) {
			progress := backupipc.BackupProgress{
				CommandID: cmdID,
				Phase:     phase,
				Current:   current,
				Total:     total,
				Message:   message,
			}
			if err := conn.SendTyped("", backupipc.TypeBackupProgress, progress); err != nil {
				slog.Warn("failed to send restore progress", "error", err.Error())
			}
		}
	}

	result, err := backup.RestoreFromSnapshotContext(ctx, restoreProvider, cfg, progressFn)
	return marshalRestoreResult(result, err)
}

func execBackupVerify(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	restoreProvider := resolveRestoreProvider(mgr, vaultState)
	if restoreProvider == nil {
		return fail("backup not configured on this device")
	}
	var p struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid verify payload: " + err.Error())
	}
	result, err := backup.VerifyIntegrity(restoreProvider, p.SnapshotID)
	return marshalResult(result, err)
}

func execBackupTestRestore(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	restoreProvider := resolveRestoreProvider(mgr, vaultState)
	if restoreProvider == nil {
		return fail("backup not configured on this device")
	}
	var p struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid test restore payload: " + err.Error())
	}
	result, err := backup.TestRestore(restoreProvider, p.SnapshotID, nil)
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

func marshalRestoreResult(result *backup.RestoreResult, err error) backupipc.BackupCommandResult {
	if err != nil {
		return marshalResult(result, err)
	}
	if result == nil || result.Status == "completed" {
		return marshalResult(result, nil)
	}

	data, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		return fail(fmt.Sprintf("failed to marshal restore result: %v", marshalErr))
	}

	msg := "restore failed"
	if result.Status == "partial" {
		msg = "restore completed partially"
	}
	return backupipc.BackupCommandResult{
		Success: false,
		Stdout:  string(data),
		Stderr:  msg,
	}
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

func execBMRRecover(ctx context.Context, payload json.RawMessage, _ *backup.BackupManager) backupipc.BackupCommandResult {
	var cfg bmr.RecoveryConfig
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return fail("invalid BMR config: " + err.Error())
	}
	if cfg.RecoveryToken == "" || cfg.ServerURL == "" {
		return fail("bmr recovery requires recoveryToken and serverUrl")
	}
	result, err := runBMRRecovery(ctx, cfg)
	return marshalResult(result, err)
}
