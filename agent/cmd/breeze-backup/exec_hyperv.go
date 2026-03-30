package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// --- MSSQL ---

func execMSSQLDiscover() backupipc.BackupCommandResult {
	instances, err := mssql.DiscoverInstances()
	return marshalResult(instances, err)
}

func execMSSQLBackup(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		Instance   string `json:"instance"`
		Database   string `json:"database"`
		BackupType string `json:"backupType"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid MSSQL backup payload: " + err.Error())
	}
	if mgr == nil {
		return fail("backup not configured")
	}

	stagingDir, err := os.MkdirTemp(mgr.GetStagingDir(), "breeze-mssql-*")
	if err != nil {
		return fail("failed to create staging dir: " + err.Error())
	}
	defer func() {
		if err := os.RemoveAll(stagingDir); err != nil {
			slog.Warn("failed to clean up staging dir", "dir", stagingDir, "error", err.Error())
		}
	}()

	result, err := mssql.RunBackup(p.Instance, p.Database, p.BackupType, stagingDir)
	if err != nil {
		return fail(err.Error())
	}

	provider := mgr.GetProvider()
	snapshotID := fmt.Sprintf("mssql-%s-%s-%d", p.Instance, p.Database, time.Now().Unix())
	prefix := fmt.Sprintf("snapshots/%s/files", snapshotID)

	var fileCount int
	var totalSize int64
	err = filepath.WalkDir(stagingDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return walkErr
		}
		relPath, relErr := filepath.Rel(stagingDir, path)
		if relErr != nil {
			return fmt.Errorf("cannot compute relative path for %s: %w", path, relErr)
		}
		remotePath := filepath.ToSlash(filepath.Join(prefix, relPath))
		info, infoErr := d.Info()
		if infoErr != nil {
			slog.Warn("failed to stat file during backup upload, size will be approximate",
				"path", path, "error", infoErr.Error())
		} else {
			totalSize += info.Size()
			fileCount++
		}
		return provider.Upload(path, remotePath)
	})
	if err != nil {
		return fail("failed to upload MSSQL backup: " + err.Error())
	}

	return marshalResult(map[string]any{
		"snapshotId": snapshotID,
		"result":     result,
		"fileCount":  fileCount,
		"totalSize":  totalSize,
	}, nil)
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

func execHypervBackup(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		VMName          string `json:"vmName"`
		ConsistencyType string `json:"consistencyType"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid Hyper-V backup payload: " + err.Error())
	}
	if mgr == nil {
		return fail("backup not configured")
	}

	stagingDir, err := os.MkdirTemp(mgr.GetStagingDir(), "breeze-hyperv-*")
	if err != nil {
		return fail("failed to create staging dir: " + err.Error())
	}
	defer func() {
		if err := os.RemoveAll(stagingDir); err != nil {
			slog.Warn("failed to clean up staging dir", "dir", stagingDir, "error", err.Error())
		}
	}()

	result, err := hyperv.ExportVM(p.VMName, stagingDir, p.ConsistencyType)
	if err != nil {
		return fail(err.Error())
	}

	provider := mgr.GetProvider()
	snapshotID := fmt.Sprintf("hyperv-%s-%d", p.VMName, time.Now().Unix())
	prefix := fmt.Sprintf("snapshots/%s/files", snapshotID)

	var fileCount int
	var totalSize int64
	err = filepath.WalkDir(stagingDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return walkErr
		}
		relPath, relErr := filepath.Rel(stagingDir, path)
		if relErr != nil {
			return fmt.Errorf("cannot compute relative path for %s: %w", path, relErr)
		}
		remotePath := filepath.ToSlash(filepath.Join(prefix, relPath))
		info, infoErr := d.Info()
		if infoErr != nil {
			slog.Warn("failed to stat file during backup upload, size will be approximate",
				"path", path, "error", infoErr.Error())
		} else {
			totalSize += info.Size()
			fileCount++
		}
		return provider.Upload(path, remotePath)
	})
	if err != nil {
		return fail("failed to upload Hyper-V export: " + err.Error())
	}

	return marshalResult(map[string]any{
		"snapshotId": snapshotID,
		"result":     result,
		"fileCount":  fileCount,
		"totalSize":  totalSize,
	}, nil)
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

// --- VM restore from backup + instant boot ---

func execVMRestoreFromBackup(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID string `json:"snapshotId"`
		VMName     string `json:"vmName"`
		MemoryMB   int64  `json:"memoryMb"`
		CPUCount   int    `json:"cpuCount"`
		DiskSizeGB int64  `json:"diskSizeGb"`
		SwitchName string `json:"switchName"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid VM restore payload: " + err.Error())
	}

	cfg := hyperv.VMRestoreFromBackupConfig{
		SnapshotID: p.SnapshotID,
		VMName:     p.VMName,
		MemoryMB:   p.MemoryMB,
		CPUCount:   p.CPUCount,
		DiskSizeGB: p.DiskSizeGB,
		SwitchName: p.SwitchName,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()

	result, err := hyperv.RestoreAsVM(ctx, cfg, mgr.GetProvider(), nil)
	return marshalResult(result, err)
}

func execInstantBoot(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID string `json:"snapshotId"`
		VMName     string `json:"vmName"`
		MemoryMB   int64  `json:"memoryMb"`
		CPUCount   int    `json:"cpuCount"`
		DiskSizeGB int64  `json:"diskSizeGb"`
		WorkDir    string `json:"workDir"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid instant boot payload: " + err.Error())
	}

	cfg := hyperv.InstantBootConfig{
		SnapshotID: p.SnapshotID,
		VMName:     p.VMName,
		MemoryMB:   p.MemoryMB,
		CPUCount:   p.CPUCount,
		DiskSizeGB: p.DiskSizeGB,
		WorkDir:    p.WorkDir,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	result, err := hyperv.InstantBoot(ctx, cfg, mgr.GetProvider(), nil)
	return marshalResult(result, err)
}

func execVMRestoreEstimate(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
	var p struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return fail("invalid VM estimate payload: " + err.Error())
	}
	if mgr == nil {
		return fail("backup not configured")
	}

	// Download just the manifest (lightweight) instead of all snapshot files.
	provider := mgr.GetProvider()
	manifestPath := fmt.Sprintf("snapshots/%s/manifest.json", p.SnapshotID)
	tmpFile, err := os.CreateTemp("", "manifest-*.json")
	if err != nil {
		return fail("failed to create temp file: " + err.Error())
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.Close()

	if err := provider.Download(manifestPath, tmpFile.Name()); err != nil {
		return fail("failed to download manifest: " + err.Error())
	}

	data, err := os.ReadFile(tmpFile.Name())
	if err != nil {
		return fail("failed to read manifest: " + err.Error())
	}

	var snapshot backup.Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return fail("failed to parse manifest: " + err.Error())
	}

	totalBytes := snapshot.Size
	diskGB := (totalBytes / (1024 * 1024 * 1024)) * 2 // 2x snapshot size for headroom
	if diskGB < 50 {
		diskGB = 50
	}

	estimate := bmr.VMEstimate{
		RecommendedMemoryMB: 4096,
		RecommendedCPU:      2,
		RequiredDiskGB:      diskGB,
		Platform:            runtime.GOOS,
	}

	return marshalResult(estimate, nil)
}
