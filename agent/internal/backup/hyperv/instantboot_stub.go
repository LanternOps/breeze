//go:build !windows

package hyperv

import (
	"context"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
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
	// Integrity is the command's integrity expectation (nil when the
	// payload carried none). Not part of the JSON form.
	Integrity *integrity.Expectation `json:"-"`
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
