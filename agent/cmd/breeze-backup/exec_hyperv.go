package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
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

	// Try to read hardware profile from snapshot manifest if provider is available.
	if mgr != nil && p.SnapshotID != "" {
		provider := mgr.GetProvider()
		items, listErr := provider.List(fmt.Sprintf("snapshots/%s/", p.SnapshotID))
		if listErr == nil && len(items) > 0 {
			// Compute estimate from snapshot size.
			var totalSize int64
			for _, item := range items {
				tmpFile, err := os.CreateTemp("", "vmestimate-*.tmp")
				if err != nil {
					continue
				}
				tmpPath := tmpFile.Name()
				_ = tmpFile.Close()
				if dlErr := provider.Download(item, tmpPath); dlErr == nil {
					if info, statErr := os.Stat(tmpPath); statErr == nil {
						totalSize += info.Size()
					}
				}
				os.Remove(tmpPath)
			}

			sizeGB := totalSize / (1024 * 1024 * 1024)
			if sizeGB < 20 {
				sizeGB = 20
			}

			return marshalResult(bmr.VMEstimate{
				RecommendedMemoryMB: 4096,
				RecommendedCPU:      2,
				RequiredDiskGB:      sizeGB * 2, // 2x snapshot size for headroom
			}, nil)
		}
	}

	// Fallback estimates.
	return marshalResult(bmr.VMEstimate{
		RecommendedMemoryMB: 4096,
		RecommendedCPU:      2,
		RequiredDiskGB:      50,
	}, nil)
}
