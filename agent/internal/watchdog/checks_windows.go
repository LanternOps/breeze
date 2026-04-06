//go:build windows

package watchdog

import (
	"golang.org/x/sys/windows"
)

// isAliveWindows checks if a process is alive on Windows by opening it and
// querying its exit code. STILL_ACTIVE (259) means the process is running.
func isAliveWindows(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)

	var exitCode uint32
	if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
		return false
	}
	const stillActive = 259
	return exitCode == stillActive
}

// IsAlive reports whether the process is running on Windows.
func (c *OSProcessChecker) IsAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return isAliveWindows(pid)
}

// IsZombie always returns false on Windows; the concept does not apply.
func (c *OSProcessChecker) IsZombie(_ int) bool { return false }
