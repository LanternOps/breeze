//go:build windows

package hyperv

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// validateBackupPath ensures a path is absolute and does not contain traversal sequences.
func validateBackupPath(path string) error {
	cleaned := filepath.Clean(path)
	if strings.Contains(cleaned, "..") {
		return fmt.Errorf("path traversal not allowed: %s", path)
	}
	if !filepath.IsAbs(cleaned) {
		return fmt.Errorf("backup path must be absolute: %s", path)
	}
	return nil
}

// ExportVM performs a full export of a Hyper-V VM.
//
// consistencyType controls how the export handles a running VM:
//   - "application": Uses Hyper-V VSS integration for application-consistent backup.
//     This is the default Export-VM behavior for running VMs.
//   - "crash": Saves a Running VM before exporting (and restarts it after),
//     ensuring a crash-consistent point. An Off or Saved VM is already
//     consistent and is exported as-is; a Paused VM is saved and left Saved.
//     See planCrashExport.
func ExportVM(vmName, exportPath, consistencyType string) (*BackupResult, error) {
	start := time.Now()

	if vmName == "" {
		return nil, fmt.Errorf("%w: vmName is required", ErrExportFailed)
	}
	if exportPath == "" {
		return nil, fmt.Errorf("%w: exportPath is required", ErrExportFailed)
	}
	if err := validateBackupPath(exportPath); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrExportFailed, err)
	}

	// Ensure export directory exists.
	if err := os.MkdirAll(exportPath, 0750); err != nil {
		return nil, fmt.Errorf("%w: failed to create export path: %v", ErrExportFailed, err)
	}

	// Resolve the VM by exact name once (refusing ambiguous names) and run
	// every step against that VM's ID.
	slog.Info("hyperv: exporting VM", "vm", vmName, "path", exportPath, "consistency", consistencyType)
	vmID, warnings, err := exportVMWith(runPS, vmName, exportPath, consistencyType)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrExportFailed, err)
	}
	for _, w := range warnings {
		slog.Warn("hyperv: " + w)
	}

	// Calculate export size.
	vmExportDir := filepath.Join(exportPath, vmName)
	sizeBytes, vhdCount := calcDirSize(vmExportDir)

	duration := time.Since(start).Milliseconds()
	slog.Info("hyperv: export completed", "vm", vmName, "sizeBytes", sizeBytes, "durationMs", duration)

	return &BackupResult{
		VMName:          vmName,
		VMID:            vmID,
		BackupType:      "full",
		ConsistencyType: consistencyType,
		ExportPath:      vmExportDir,
		SizeBytes:       sizeBytes,
		VHDCount:        vhdCount,
		DurationMs:      duration,
		Warnings:        warnings,
	}, nil
}

// calcDirSize walks a directory and returns total size and VHD file count.
func calcDirSize(dir string) (int64, int) {
	var totalSize int64
	var vhdCount int

	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip inaccessible files
		}
		if info.IsDir() {
			return nil
		}
		totalSize += info.Size()
		ext := strings.ToLower(filepath.Ext(path))
		if ext == ".vhd" || ext == ".vhdx" || ext == ".avhd" || ext == ".avhdx" {
			vhdCount++
		}
		return nil
	})

	return totalSize, vhdCount
}
