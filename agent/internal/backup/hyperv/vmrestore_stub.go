//go:build !windows

package hyperv

import (
	"context"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VMRestoreFromBackupConfig configures a VM restore from a backup snapshot.
type VMRestoreFromBackupConfig struct {
	SnapshotID string `json:"snapshotId"`
	VMName     string `json:"vmName"`
	MemoryMB   int64  `json:"memoryMb,omitempty"`
	CPUCount   int    `json:"cpuCount,omitempty"`
	DiskSizeGB int64  `json:"diskSizeGb,omitempty"`
	SwitchName string `json:"switchName,omitempty"`
}

// VMRestoreFromBackupResult holds the outcome of a VM restore from backup.
type VMRestoreFromBackupResult struct {
	VMName     string   `json:"vmName"`
	NewVMID    string   `json:"newVmId"`
	VHDXPath   string   `json:"vhdxPath"`
	Status     string   `json:"status"`
	DurationMs int64    `json:"durationMs"`
	Warnings   []string `json:"warnings,omitempty"`
	Error      string   `json:"error,omitempty"`
}

// RestoreAsVM is a stub for non-Windows platforms.
func RestoreAsVM(
	_ context.Context,
	_ VMRestoreFromBackupConfig,
	_ providers.BackupProvider,
	_ func(string, int64, int64),
) (*VMRestoreFromBackupResult, error) {
	return nil, ErrHyperVNotSupported
}
