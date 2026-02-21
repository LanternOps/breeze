//go:build windows

package tools

import (
	"fmt"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procGetLogicalDrives = kernel32.NewProc("GetLogicalDrives")
	procGetDriveTypeW    = kernel32.NewProc("GetDriveTypeW")
	procGetVolumeInfo    = kernel32.NewProc("GetVolumeInformationW")
	procGetDiskFreeSpace = kernel32.NewProc("GetDiskFreeSpaceExW")
)

const (
	driveUnknown   = 0
	driveNoRootDir = 1
	driveRemovable = 2
	driveFixed     = 3
	driveRemote    = 4
	driveCDROM     = 5
	driveRAMDisk   = 6
)

func driveTypeString(t uint32) string {
	switch t {
	case driveRemovable:
		return "removable"
	case driveFixed:
		return "fixed"
	case driveRemote:
		return "network"
	case driveCDROM:
		return "cdrom"
	case driveRAMDisk:
		return "ramdisk"
	default:
		return "unknown"
	}
}

func listDrivesOS(startTime time.Time) CommandResult {
	mask, _, _ := procGetLogicalDrives.Call()
	if mask == 0 {
		return NewErrorResult(fmt.Errorf("GetLogicalDrives returned 0"), time.Since(startTime).Milliseconds())
	}

	var drives []DriveInfo
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		letter := string(rune('A'+i)) + ":"
		rootPath := letter + "\\"
		rootPathUTF16, _ := syscall.UTF16PtrFromString(rootPath)

		dt, _, _ := procGetDriveTypeW.Call(uintptr(unsafe.Pointer(rootPathUTF16)))

		// Skip drives with no root directory
		if uint32(dt) == driveNoRootDir {
			continue
		}

		info := DriveInfo{
			Letter:     letter,
			MountPoint: rootPath,
			DriveType:  driveTypeString(uint32(dt)),
		}

		// Get volume label and filesystem
		var volumeName [256]uint16
		var fsName [256]uint16
		ret, _, _ := procGetVolumeInfo.Call(
			uintptr(unsafe.Pointer(rootPathUTF16)),
			uintptr(unsafe.Pointer(&volumeName[0])),
			uintptr(len(volumeName)),
			0, 0, 0,
			uintptr(unsafe.Pointer(&fsName[0])),
			uintptr(len(fsName)),
		)
		if ret != 0 {
			info.Label = strings.TrimRight(syscall.UTF16ToString(volumeName[:]), "\x00")
			info.FileSystem = strings.TrimRight(syscall.UTF16ToString(fsName[:]), "\x00")
		}

		// Get disk space
		var freeBytesAvailable, totalBytes, totalFreeBytes uint64
		ret, _, _ = procGetDiskFreeSpace.Call(
			uintptr(unsafe.Pointer(rootPathUTF16)),
			uintptr(unsafe.Pointer(&freeBytesAvailable)),
			uintptr(unsafe.Pointer(&totalBytes)),
			uintptr(unsafe.Pointer(&totalFreeBytes)),
		)
		if ret != 0 {
			info.TotalBytes = int64(totalBytes)
			info.FreeBytes = int64(totalFreeBytes)
		}

		drives = append(drives, info)
	}

	return NewSuccessResult(DriveListResponse{Drives: drives}, time.Since(startTime).Milliseconds())
}
