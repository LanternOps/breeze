//go:build windows

package agentapp

import (
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func currentPlatformProcessMetadata() platformProcessMetadata {
	pid := uint32(os.Getpid())
	metadata := platformProcessMetadata{}

	_ = windows.ProcessIdToSessionId(pid, &metadata.WindowsSessionID)
	metadata.ParentPID = currentWindowsParentPID(pid)

	var creationTime, exitTime, kernelTime, userTime windows.Filetime
	if err := windows.GetProcessTimes(
		windows.CurrentProcess(),
		&creationTime,
		&exitTime,
		&kernelTime,
		&userTime,
	); err == nil {
		metadata.CreatedAt = time.Unix(0, creationTime.Nanoseconds())
	}

	return metadata
}

func currentWindowsParentPID(pid uint32) int {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0
	}
	defer windows.CloseHandle(snapshot)

	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return 0
	}
	for {
		if entry.ProcessID == pid {
			return int(entry.ParentProcessID)
		}
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			return 0
		}
	}
}
