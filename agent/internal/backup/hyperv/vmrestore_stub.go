//go:build !windows

package hyperv

import (
	"context"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
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
	// Integrity is the command's integrity expectation (nil when the
	// payload carried none). Not part of the JSON form.
	Integrity *integrity.Expectation `json:"-"`
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
