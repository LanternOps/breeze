//go:build windows

package hyperv

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
)

// ImportVM restores a previously exported Hyper-V VM as a new VM named vmName.
//
// exportPath is the staged export directory (e.g. D:\Staging\MyVM). The VM
// is always imported as a copy with a new ID into a fresh directory under the
// host's default virtual machine path, so it never shares files with the
// staged export (which the caller deletes) and never collides with the ID of
// the VM it was exported from. The restore is refused if a VM named vmName
// already exists. Every follow-up step addresses the imported VM by the ID
// Import-VM returned.
func ImportVM(exportPath, vmName string) (*RestoreResult, error) {
	if exportPath == "" {
		return nil, fmt.Errorf("%w: exportPath is required", ErrImportFailed)
	}
	if strings.TrimSpace(vmName) == "" {
		return nil, fmt.Errorf("%w: vmName is required", ErrImportFailed)
	}

	vmConfigPath, err := findVMConfig(exportPath)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrImportFailed, err)
	}

	dirName, err := newRestoreDirName(vmName)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrImportFailed, err)
	}
	params := importVMParams{
		ConfigPath: vmConfigPath,
		VMName:     vmName,
		DirName:    dirName,
	}

	slog.Info("hyperv: importing VM", "config", vmConfigPath, "vmName", vmName, "restoreDir", params.DirName)
	result, err := importVMWith(runPS, params)
	if err != nil {
		return nil, err
	}
	slog.Info("hyperv: import completed",
		"vmName", result.VMName, "vmId", result.NewVMID, "path", result.RestorePath, "durationMs", result.DurationMs)
	return result, nil
}

// findVMConfig locates the .vmcx (Gen 2) or .xml (Gen 1) config file in an export directory.
func findVMConfig(exportPath string) (string, error) {
	// Look for .vmcx files first (Generation 2).
	vmcxPattern := filepath.Join(exportPath, "Virtual Machines", "*.vmcx")
	matches, err := filepath.Glob(vmcxPattern)
	if err == nil && len(matches) > 0 {
		return matches[0], nil
	}

	// Fall back to .xml (Generation 1).
	xmlPattern := filepath.Join(exportPath, "Virtual Machines", "*.xml")
	matches, err = filepath.Glob(xmlPattern)
	if err == nil && len(matches) > 0 {
		return matches[0], nil
	}

	// Try nested directory structure.
	vmcxDeepPattern := filepath.Join(exportPath, "*", "Virtual Machines", "*.vmcx")
	matches, err = filepath.Glob(vmcxDeepPattern)
	if err == nil && len(matches) > 0 {
		return matches[0], nil
	}

	xmlDeepPattern := filepath.Join(exportPath, "*", "Virtual Machines", "*.xml")
	matches, err = filepath.Glob(xmlDeepPattern)
	if err == nil && len(matches) > 0 {
		return matches[0], nil
	}

	return "", fmt.Errorf("no VM configuration file found in %s", exportPath)
}
