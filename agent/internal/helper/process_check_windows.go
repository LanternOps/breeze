//go:build windows

package helper

import (
	"fmt"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func processExists(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var exitCode uint32
	if err := windows.GetExitCodeProcess(handle, &exitCode); err != nil {
		return false
	}
	return exitCode == 259 // STILL_ACTIVE
}

func processExePath(pid int) (string, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)

	buf := make([]uint16, windows.MAX_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(handle, 0, &buf[0], &size); err != nil {
		return "", err
	}
	return windows.UTF16ToString(buf[:size]), nil
}

func isOurProcess(pid int, binaryPath string) bool {
	if pid <= 0 {
		return false
	}
	exePath, err := processExePath(pid)
	if err != nil {
		log.Debug("processExePath failed", "pid", pid, "error", err.Error())
		return false
	}
	return strings.EqualFold(filepath.Clean(exePath), filepath.Clean(binaryPath))
}

// isHelperRunningInSession checks whether a breeze-helper.exe process is
// running in the given Windows session by scanning the process table.
// This is the reliable fallback — PID tracking can fail when the helper
// re-execs, the status file isn't written, or the spawn wrapper returns
// the wrong PID. Session "0" or "" matches any session.
func isHelperRunningInSession(sessionKey string, binaryPath string) bool {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snapshot)

	targetExe := strings.ToLower(filepath.Base(binaryPath))

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snapshot, &pe); err != nil {
		return false
	}

	for {
		name := strings.ToLower(windows.UTF16ToString(pe.ExeFile[:]))
		if name == targetExe {
			// If no specific session requested, any match counts.
			if sessionKey == "" || sessionKey == "0" {
				return true
			}
			// Check if this process is in the target session.
			var procSessionID uint32
			if err := windows.ProcessIdToSessionId(pe.ProcessID, &procSessionID); err == nil {
				if sessionKey == fmt.Sprintf("%d", procSessionID) {
					return true
				}
			}
		}
		if err := windows.Process32Next(snapshot, &pe); err != nil {
			break
		}
	}
	return false
}
