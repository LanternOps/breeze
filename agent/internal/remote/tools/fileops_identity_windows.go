//go:build windows

package tools

import (
	"encoding/binary"
	"errors"
	"io/fs"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// fileIdentity names a file independently of its path: device and inode on
// Unix, volume serial and file ID on Windows. Every hard link to a file
// shares it.
type fileIdentity struct {
	volume uint64
	idHigh uint64
	idLow  uint64
}

// fileIDInfo is FILE_ID_INFO; fileStandardInfo is FILE_STANDARD_INFO.
type fileIDInfo struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

type fileStandardInfo struct {
	AllocationSize int64
	EndOfFile      int64
	NumberOfLinks  uint32
	DeletePending  byte
	Directory      byte
}

// identityOfHandle reads the identity and link count of h. The two
// information classes used here are read from the handle without needing
// data access, so a handle opened for writing works too.
func identityOfHandle(h windows.Handle) (fileIdentity, uint32, error) {
	var std fileStandardInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileStandardInfo, (*byte)(unsafe.Pointer(&std)), uint32(unsafe.Sizeof(std))); err != nil {
		return fileIdentity{}, 0, err
	}
	links := std.NumberOfLinks
	if std.Directory != 0 {
		links = 1 // only a regular file's link count says anything about other names
	}
	var id fileIDInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileIdInfo, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id))); err == nil {
		return fileIdentity{
			volume: id.VolumeSerialNumber,
			idHigh: binary.LittleEndian.Uint64(id.FileID[8:]),
			idLow:  binary.LittleEndian.Uint64(id.FileID[:8]),
		}, links, nil
	}
	// Volumes without 128-bit file IDs: fall back to the 64-bit index.
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return fileIdentity{}, 0, err
	}
	return fileIdentity{
		volume: uint64(info.VolumeSerialNumber),
		idLow:  uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow),
	}, links, nil
}

// linkCountOfOpenFile returns how many names a regular file has (1 for
// anything else), with one query on the handle.
func linkCountOfOpenFile(f *os.File, _ os.FileInfo) (uint32, error) {
	var std fileStandardInfo
	if err := windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileStandardInfo, (*byte)(unsafe.Pointer(&std)), uint32(unsafe.Sizeof(std))); err != nil {
		return 0, err
	}
	if std.Directory != 0 {
		return 1, nil
	}
	return std.NumberOfLinks, nil
}

// identityOfOpenFile returns the identity and link count of an open file
// (the link count is 1 for anything but a regular file).
func identityOfOpenFile(f *os.File) (fileIdentity, uint32, error) {
	return identityOfHandle(windows.Handle(f.Fd()))
}

// identityOfPath returns the identity of the regular file p names,
// following links. It opens for attribute access only, which a file held
// open exclusively (such as a loaded registry hive) still allows. ok is
// false when p does not exist or is a folder; err reports any other failure.
func identityOfPath(p string) (id fileIdentity, ok bool, err error) {
	h, err := openFollowing(p, windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return fileIdentity{}, false, nil
		}
		return fileIdentity{}, false, err
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var std fileStandardInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileStandardInfo, (*byte)(unsafe.Pointer(&std)), uint32(unsafe.Sizeof(std))); err == nil && std.Directory != 0 {
		return fileIdentity{}, false, nil
	}
	id, _, err = identityOfHandle(h)
	return id, err == nil, err
}

// deviceOfInfo: Windows volumes are anchored by drive letter instead.
func deviceOfInfo(string, fs.FileInfo) (uint64, bool) { return 0, false }

// runsPrivileged: the agent runs as LocalSystem on Windows.
func runsPrivileged() bool { return true }
