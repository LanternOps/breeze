//go:build windows

package helper

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// listHelperInstances walks the process table for processes whose image file
// name matches the helper binary, then confirms each one's FULL image path on
// its own handle, so an unrelated program that merely shares the file name is
// never reported (and therefore never terminated by a caller).
func listHelperInstances(binaryPath string) ([]helperInstance, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer windows.CloseHandle(snapshot)

	targetExe := strings.ToLower(filepath.Base(binaryPath))
	cleanTarget := filepath.Clean(binaryPath)

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snapshot, &pe); err != nil {
		return nil, fmt.Errorf("Process32First: %w", err)
	}

	var out []helperInstance
	for {
		if strings.ToLower(windows.UTF16ToString(pe.ExeFile[:])) == targetExe {
			if inst, ok := describeHelperInstance(pe.ProcessID, cleanTarget); ok {
				out = append(out, inst)
			}
		}
		if err := windows.Process32Next(snapshot, &pe); err != nil {
			break
		}
	}
	return out, nil
}

func describeHelperInstance(pid uint32, cleanTarget string) (helperInstance, bool) {
	var sessionID uint32
	if err := windows.ProcessIdToSessionId(pid, &sessionID); err != nil {
		return helperInstance{}, false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return helperInstance{}, false
	}
	defer windows.CloseHandle(handle)

	buf := make([]uint16, windows.MAX_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(handle, 0, &buf[0], &size); err != nil {
		return helperInstance{}, false
	}
	if !strings.EqualFold(filepath.Clean(windows.UTF16ToString(buf[:size])), cleanTarget) {
		return helperInstance{}, false
	}

	var created, exited, kernel, user windows.Filetime
	var createdAt time.Time
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err == nil {
		createdAt = time.Unix(0, created.Nanoseconds())
	}
	return helperInstance{
		PID:        int(pid),
		SessionKey: strconv.FormatUint(uint64(sessionID), 10),
		Created:    createdAt,
	}, true
}
