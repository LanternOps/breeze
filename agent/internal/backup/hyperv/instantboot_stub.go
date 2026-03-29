//go:build !windows

package hyperv

import (
	"context"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// InstantBootConfig configures an instant boot VM from a backup snapshot.
type InstantBootConfig struct {
	SnapshotID string `json:"snapshotId"`
	VMName     string `json:"vmName"`
	MemoryMB   int64  `json:"memoryMb,omitempty"`
	CPUCount   int    `json:"cpuCount,omitempty"`
	DiskSizeGB int64  `json:"diskSizeGb,omitempty"`
	WorkDir    string `json:"workDir,omitempty"`
}

// InstantBootResult holds the outcome of an instant boot operation.
type InstantBootResult struct {
	VMName               string `json:"vmName"`
	NewVMID              string `json:"newVmId"`
	Status               string `json:"status"`
	BootTimeMs           int64  `json:"bootTimeMs"`
	BackgroundSyncActive bool   `json:"backgroundSyncActive"`
	Error                string `json:"error,omitempty"`
}

// InstantBoot is a stub for non-Windows platforms.
func InstantBoot(
	_ context.Context,
	_ InstantBootConfig,
	_ providers.BackupProvider,
	_ func(string, int64, int64),
) (*InstantBootResult, error) {
	return nil, ErrHyperVNotSupported
}
