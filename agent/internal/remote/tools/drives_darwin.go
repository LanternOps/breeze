//go:build darwin

package tools

import (
	"os/exec"
	"strings"
	"syscall"
	"time"
)

func listDrivesOS(startTime time.Time) CommandResult {
	var drives []DriveInfo

	// Use mount(8) to list mounted filesystems — works on all macOS versions.
	out, err := exec.Command("mount").Output()
	if err != nil {
		// Fallback: just report root filesystem
		return fallbackRoot(startTime)
	}

	seen := make(map[string]bool)
	for _, line := range strings.Split(string(out), "\n") {
		// Format: /dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
		onIdx := strings.Index(line, " on ")
		if onIdx < 0 {
			continue
		}
		device := line[:onIdx]
		rest := line[onIdx+4:] // after " on "

		// Extract mount point: everything before " ("
		parenIdx := strings.LastIndex(rest, " (")
		if parenIdx < 0 {
			continue
		}
		mountPoint := rest[:parenIdx]
		fsPart := rest[parenIdx+2:] // after " ("

		// Only include real disk devices
		if !strings.HasPrefix(device, "/dev/") {
			continue
		}
		if seen[mountPoint] {
			continue
		}
		seen[mountPoint] = true

		// Extract filesystem type (first token inside parens)
		fsType := ""
		if comma := strings.Index(fsPart, ","); comma > 0 {
			fsType = fsPart[:comma]
		} else {
			fsType = strings.TrimSuffix(fsPart, ")")
		}

		info := DriveInfo{
			MountPoint: mountPoint,
			FileSystem: fsType,
			DriveType:  "fixed",
		}

		// Classify /Volumes/* as removable if not the Data volume
		if strings.HasPrefix(mountPoint, "/Volumes/") {
			info.DriveType = "removable"
			info.Label = strings.TrimPrefix(mountPoint, "/Volumes/")
		}

		var stat syscall.Statfs_t
		if err := syscall.Statfs(mountPoint, &stat); err == nil {
			info.TotalBytes = int64(stat.Blocks) * int64(stat.Bsize)
			info.FreeBytes = int64(stat.Bavail) * int64(stat.Bsize)
		}

		drives = append(drives, info)
	}

	if len(drives) == 0 {
		return fallbackRoot(startTime)
	}

	return NewSuccessResult(DriveListResponse{Drives: drives}, time.Since(startTime).Milliseconds())
}

func fallbackRoot(startTime time.Time) CommandResult {
	var drives []DriveInfo
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err == nil {
		drives = append(drives, DriveInfo{
			MountPoint: "/",
			TotalBytes: int64(stat.Blocks) * int64(stat.Bsize),
			FreeBytes:  int64(stat.Bavail) * int64(stat.Bsize),
			DriveType:  "fixed",
		})
	}
	return NewSuccessResult(DriveListResponse{Drives: drives}, time.Since(startTime).Milliseconds())
}
