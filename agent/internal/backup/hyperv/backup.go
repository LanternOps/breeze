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

// ExportVM performs a full export of a Hyper-V VM.
//
// consistencyType controls how the export handles a running VM:
//   - "application": Uses Hyper-V VSS integration for application-consistent backup.
//     This is the default Export-VM behavior for running VMs.
//   - "crash": Saves the VM state before exporting, ensuring a crash-consistent point.
func ExportVM(vmName, exportPath, consistencyType string) (*BackupResult, error) {
	start := time.Now()

	if vmName == "" {
		return nil, fmt.Errorf("%w: vmName is required", ErrExportFailed)
	}
	if exportPath == "" {
		return nil, fmt.Errorf("%w: exportPath is required", ErrExportFailed)
	}

	// Ensure export directory exists.
	if err := os.MkdirAll(exportPath, 0750); err != nil {
		return nil, fmt.Errorf("%w: failed to create export path: %v", ErrExportFailed, err)
	}

	vmNameEsc := escapePSString(vmName)

	// For crash-consistent, save VM state first.
	if consistencyType == "crash" {
		slog.Info("hyperv: saving VM state for crash-consistent backup", "vm", vmName)
		saveCmd := fmt.Sprintf(`Save-VM -Name '%s'`, vmNameEsc)
		if _, err := runPS(saveCmd); err != nil {
			return nil, fmt.Errorf("%w: failed to save VM state: %v", ErrExportFailed, err)
		}
	}

	// Export the VM.
	slog.Info("hyperv: exporting VM", "vm", vmName, "path", exportPath, "consistency", consistencyType)
	exportCmd := fmt.Sprintf(`Export-VM -Name '%s' -Path '%s'`, vmNameEsc, escapePSString(exportPath))
	if _, err := runPS(exportCmd); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrExportFailed, err)
	}

	// If we saved state for crash consistency, start the VM again.
	if consistencyType == "crash" {
		slog.Info("hyperv: restarting VM after crash-consistent export", "vm", vmName)
		startCmd := fmt.Sprintf(`Start-VM -Name '%s'`, vmNameEsc)
		if _, err := runPS(startCmd); err != nil {
			slog.Warn("hyperv: failed to restart VM after export", "vm", vmName, "error", err.Error())
		}
	}

	// Calculate export size.
	vmExportDir := filepath.Join(exportPath, vmName)
	sizeBytes, vhdCount := calcDirSize(vmExportDir)

	// Retrieve VM ID.
	vmID := getVMID(vmName)

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
	}, nil
}

// getVMID retrieves the VM GUID from Hyper-V.
func getVMID(vmName string) string {
	cmd := fmt.Sprintf(`(Get-VM -Name '%s').Id.Guid`, escapePSString(vmName))
	out, err := runPS(cmd)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
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
