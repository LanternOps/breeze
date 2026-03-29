//go:build windows

package hyperv

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"time"
)

// ImportVM imports a previously exported Hyper-V VM.
//
// exportPath should be the path to the exported VM directory (e.g. D:\Exports\MyVM).
// generateNewID controls whether the imported VM gets a new GUID.
func ImportVM(exportPath, vmName string, generateNewID bool) (*RestoreResult, error) {
	start := time.Now()

	if exportPath == "" {
		return nil, fmt.Errorf("%w: exportPath is required", ErrImportFailed)
	}

	// Find the .vmcx or .xml VM configuration file.
	vmConfigPath, err := findVMConfig(exportPath)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrImportFailed, err)
	}

	slog.Info("hyperv: importing VM", "config", vmConfigPath, "vmName", vmName, "generateNewId", generateNewID)

	// Build Import-VM command.
	importCmd := fmt.Sprintf(`Import-VM -Path '%s' -Copy`, escapePSString(vmConfigPath))
	if generateNewID {
		importCmd += " -GenerateNewId"
	}

	_, err = runPS(importCmd)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrImportFailed, err)
	}

	// If a custom name was requested, rename the imported VM.
	// We identify the VM via its config path which was just imported.
	if vmName != "" {
		// Get the newest VM and rename it.
		renameCmd := fmt.Sprintf(
			`Get-VM | Sort-Object CreationTime -Descending | Select-Object -First 1 | Rename-VM -NewName '%s'`,
			escapePSString(vmName),
		)
		if _, err := runPS(renameCmd); err != nil {
			slog.Warn("hyperv: failed to rename imported VM", "vmName", vmName, "error", err.Error())
		}
	}

	// Get the new VM ID.
	newVMID := ""
	if vmName != "" {
		newVMID = getVMID(vmName)
	}

	duration := time.Since(start).Milliseconds()
	slog.Info("hyperv: import completed", "vmName", vmName, "durationMs", duration)

	return &RestoreResult{
		VMName:     vmName,
		NewVMID:    newVMID,
		Status:     "completed",
		DurationMs: duration,
	}, nil
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

// findVMConfig and escapePSString are defined in discovery.go (same package).
