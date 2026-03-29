package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
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
