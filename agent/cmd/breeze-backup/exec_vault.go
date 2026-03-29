package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/config"
)

// --- Vault operations ---

func execVaultSync(payload json.RawMessage, vaultMgr *backup.VaultManager) backupipc.BackupCommandResult {
	if vaultMgr == nil {
		return fail("vault is not configured on this device")
	}
	var p struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid vault sync payload: " + err.Error())
	}
	if p.SnapshotID == "" {
		return fail("snapshotId is required for vault sync")
	}
	if err := vaultMgr.SyncAfterBackup(p.SnapshotID); err != nil {
		return fail("vault sync failed: " + err.Error())
	}
	return marshalResult(map[string]any{"synced": true, "snapshotId": p.SnapshotID}, nil)
}

func execVaultStatus(vaultMgr *backup.VaultManager) backupipc.BackupCommandResult {
	if vaultMgr == nil {
		return fail("vault is not configured on this device")
	}
	status, err := vaultMgr.GetStatus()
	return marshalResult(status, err)
}

func execVaultConfigure(payload json.RawMessage, vaultMgr *backup.VaultManager) backupipc.BackupCommandResult {
	if vaultMgr == nil {
		return fail("vault is not configured on this device")
	}
	var p struct {
		VaultPath      string `json:"vaultPath"`
		RetentionCount int    `json:"retentionCount"`
		Enabled        bool   `json:"enabled"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid vault configure payload: " + err.Error())
	}

	// Persist vault settings — collect errors and fail if any persist operation fails.
	var errs []string
	if p.VaultPath != "" {
		if err := config.SetAndPersist("vault_path", p.VaultPath); err != nil {
			errs = append(errs, fmt.Sprintf("vault_path: %v", err))
		}
	}
	if p.RetentionCount > 0 {
		if err := config.SetAndPersist("vault_retention_count", p.RetentionCount); err != nil {
			errs = append(errs, fmt.Sprintf("vault_retention_count: %v", err))
		}
	}
	if err := config.SetAndPersist("vault_enabled", p.Enabled); err != nil {
		errs = append(errs, fmt.Sprintf("vault_enabled: %v", err))
	}
	if len(errs) > 0 {
		return fail(fmt.Sprintf("failed to persist vault config: %s", strings.Join(errs, "; ")))
	}

	return ok(`{"configured":true}`)
}

// autoSyncToVault parses the backup_run result to extract the snapshot ID and
// syncs to vault in the background.
func autoSyncToVault(backupResult string, vaultMgr *backup.VaultManager) {
	if vaultMgr == nil {
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
	slog.Info("vault auto-sync starting", "snapshotId", result.Snapshot.ID)
	if err := vaultMgr.SyncAfterBackup(result.Snapshot.ID); err != nil {
		slog.Warn("vault auto-sync failed", "snapshotId", result.Snapshot.ID, "error", err.Error())
	} else {
		slog.Info("vault auto-sync completed", "snapshotId", result.Snapshot.ID)
	}
}
