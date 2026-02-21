//go:build !windows

package tools

import (
	"os"
	"strings"
	"syscall"
	"time"
)

func listDrivesOS(startTime time.Time) CommandResult {
	// On Unix-like systems, list common mount points from /proc/mounts or fallback to stat.
	var drives []DriveInfo

	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		// Fallback: just report root filesystem
		var stat syscall.Statfs_t
		if err := syscall.Statfs("/", &stat); err == nil {
			drives = append(drives, DriveInfo{
				MountPoint: "/",
				TotalBytes: int64(stat.Blocks) * int64(stat.Bsize),
				FreeBytes:  int64(stat.Bavail) * int64(stat.Bsize),
			})
		}
		return NewSuccessResult(DriveListResponse{Drives: drives}, time.Since(startTime).Milliseconds())
	}

	seen := make(map[string]bool)
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		device := fields[0]
		mountPoint := fields[1]
		fsType := fields[2]

		// Skip virtual/pseudo filesystems
		if !strings.HasPrefix(device, "/dev/") {
			continue
		}
		// Skip duplicates
		if seen[mountPoint] {
			continue
		}
		seen[mountPoint] = true

		info := DriveInfo{
			MountPoint: mountPoint,
			FileSystem: fsType,
			DriveType:  "fixed",
		}

		var stat syscall.Statfs_t
		if err := syscall.Statfs(mountPoint, &stat); err == nil {
			info.TotalBytes = int64(stat.Blocks) * int64(stat.Bsize)
			info.FreeBytes = int64(stat.Bavail) * int64(stat.Bsize)
		}

		drives = append(drives, info)
	}

	if len(drives) == 0 {
		drives = append(drives, DriveInfo{MountPoint: "/", DriveType: "fixed"})
	}

	return NewSuccessResult(DriveListResponse{Drives: drives}, time.Since(startTime).Milliseconds())
}
