package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// --- Vault operations ---

func execVaultSync(payload json.RawMessage, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	vaultMgr := vaultState.Get()
	if vaultMgr == nil {
		return fail("vault is not configured on this device")
	}
	var p struct {
		VaultID    string `json:"vaultId"`
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid vault sync payload: " + err.Error())
	}
	if p.SnapshotID == "" {
		return fail("snapshotId is required for vault sync")
	}
	syncResult, err := vaultMgr.SyncAfterBackup(p.SnapshotID)
	if err != nil {
		return fail("vault sync failed: " + err.Error())
	}
	return marshalResult(map[string]any{
		"synced":           true,
		"vaultId":          p.VaultID,
		"snapshotId":       p.SnapshotID,
		"fileCount":        syncResult.FileCount,
		"totalBytes":       syncResult.TotalBytes,
		"manifestVerified": syncResult.ManifestVerified,
		"vaultPath":        syncResult.VaultPath,
	}, nil)
}

func execVaultStatus(vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	vaultMgr := vaultState.Get()
	if vaultMgr == nil {
		return fail("vault is not configured on this device")
	}
	status, err := vaultMgr.GetStatus()
	return marshalResult(status, err)
}

func execVaultConfigure(payload json.RawMessage, mgr *backup.BackupManager, vaultState *vaultManagerRef) backupipc.BackupCommandResult {
	var p struct {
		VaultPath      *string `json:"vaultPath"`
		RetentionCount *int    `json:"retentionCount"`
		Enabled        *bool   `json:"enabled"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid vault configure payload: " + err.Error())
	}

	// Persist vault settings — collect errors and fail if any persist operation fails.
	var errs []string
	if p.VaultPath != nil {
		if err := config.SetAndPersist("vault_path", *p.VaultPath); err != nil {
			errs = append(errs, fmt.Sprintf("vault_path: %v", err))
		}
	}
	if p.RetentionCount != nil {
		if err := config.SetAndPersist("vault_retention_count", *p.RetentionCount); err != nil {
			errs = append(errs, fmt.Sprintf("vault_retention_count: %v", err))
		}
	}
	if p.Enabled != nil {
		if err := config.SetAndPersist("vault_enabled", *p.Enabled); err != nil {
			errs = append(errs, fmt.Sprintf("vault_enabled: %v", err))
		}
	}
	if len(errs) > 0 {
		return fail(fmt.Sprintf("failed to persist vault config: %s", strings.Join(errs, "; ")))
	}

	cfg, err := config.Reload()
	if err != nil {
		return fail("failed to reload vault config: " + err.Error())
	}

	newVaultMgr, err := buildVaultManager(cfg, mgr)
	if err != nil {
		return fail("failed to initialize vault manager: " + err.Error())
	}
	vaultState.Set(newVaultMgr)

	return marshalResult(map[string]any{
		"configured": true,
		"enabled":    newVaultMgr != nil,
	}, nil)
}

func emitVaultAutoSyncResult(conn *ipc.Conn, snapshotID string, syncResult *backup.VaultSyncResult, syncErr error) {
	if conn == nil || snapshotID == "" {
		return
	}

	resultPayload := map[string]any{
		"auto":       true,
		"snapshotId": snapshotID,
	}
	if syncResult != nil {
		resultPayload["fileCount"] = syncResult.FileCount
		resultPayload["totalBytes"] = syncResult.TotalBytes
		resultPayload["manifestVerified"] = syncResult.ManifestVerified
		resultPayload["vaultPath"] = syncResult.VaultPath
	}

	result := backupipc.BackupCommandResult{
		CommandID: fmt.Sprintf("vault-auto-sync-%s", snapshotID),
		Success:   syncErr == nil,
	}
	if syncErr != nil {
		result.Stderr = syncErr.Error()
	} else if payload, err := json.Marshal(resultPayload); err == nil {
		result.Stdout = string(payload)
	} else {
		result.Success = false
		result.Stderr = fmt.Sprintf("failed to marshal vault sync result: %v", err)
	}

	if err := conn.SendTyped(result.CommandID, backupipc.TypeBackupResult, result); err != nil {
		slog.Warn("failed to emit vault auto-sync result", "snapshotId", snapshotID, "error", err.Error())
	}
}

// autoSyncToVault parses the backup_run result to extract the snapshot ID and
// syncs to vault in the background.
func autoSyncToVault(backupResult string, vaultState *vaultManagerRef, conn *ipc.Conn) {
	if vaultState == nil {
		return
	}
	var result struct {
		Snapshot struct {
			ID string `json:"id"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(backupResult), &result); err != nil {
		slog.Warn("vault auto-sync: failed to parse backup result", "error", err.Error())
		return
	}
	if result.Snapshot.ID == "" {
		slog.Debug("vault auto-sync: no snapshot ID in backup result")
		return
	}
	vaultMgr := vaultState.Get()
	if vaultMgr == nil {
		return
	}
	slog.Info("vault auto-sync starting", "snapshotId", result.Snapshot.ID)
	syncResult, err := vaultMgr.SyncAfterBackup(result.Snapshot.ID)
	if err != nil {
		slog.Warn("vault auto-sync failed", "snapshotId", result.Snapshot.ID, "error", err.Error())
		emitVaultAutoSyncResult(conn, result.Snapshot.ID, syncResult, err)
	} else {
		slog.Info("vault auto-sync completed", "snapshotId", result.Snapshot.ID)
		emitVaultAutoSyncResult(conn, result.Snapshot.ID, syncResult, nil)
	}
}
