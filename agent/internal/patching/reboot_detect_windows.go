//go:build windows

package patching

import (
	"golang.org/x/sys/windows/registry"
)

// DetectPendingReboot checks multiple sources to determine if a reboot is pending.
// Returns true if any source indicates a pending reboot, along with the reasons.
func DetectPendingReboot() (bool, []string) {
	var reasons []string

	// 1. Windows Update RebootRequired key
	if keyExists(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`) {
		reasons = append(reasons, "Windows Update requires reboot")
	}

	// 2. Component Based Servicing RebootPending key
	if keyExists(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`) {
		reasons = append(reasons, "Component servicing reboot pending")
	}

	// 3. Pending file rename operations (indicates files locked during update)
	if hasPendingFileRenames() {
		reasons = append(reasons, "Pending file rename operations")
	}

	// 4. Session Manager PendingFileRenameOperations2
	if keyExists(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager\PendingFileRenameOperations2`) {
		reasons = append(reasons, "Pending file rename operations (v2)")
	}

	return len(reasons) > 0, reasons
}

// keyExists checks if a registry key exists.
func keyExists(root registry.Key, path string) bool {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	k.Close()
	return true
}

// hasPendingFileRenames checks if PendingFileRenameOperations has entries.
func hasPendingFileRenames() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Session Manager`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()

	val, _, err := k.GetStringsValue("PendingFileRenameOperations")
	if err != nil {
		return false
	}
	return len(val) > 0
}
