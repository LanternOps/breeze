//go:build !windows

package tools

import (
	"fmt"
	"runtime"
)

// The registry uninstall fallback is Windows-only; these stubs keep the shared
// planning/wait logic buildable (and unit-testable) on every platform.

func listWindowsUninstallEntriesOS() ([]windowsUninstallEntry, error) {
	return nil, fmt.Errorf("Uninstall registry keys are not available on %s", runtime.GOOS)
}

func startRegistryUninstallerOS(registryUninstallPlan) (uninstallerProcess, error) {
	return nil, fmt.Errorf("registry uninstall is not supported on %s", runtime.GOOS)
}

func uninstallEntryPresentOS(windowsUninstallEntry) (bool, error) {
	return false, fmt.Errorf("Uninstall registry keys are not available on %s", runtime.GOOS)
}
