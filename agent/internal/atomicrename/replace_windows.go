//go:build windows

package atomicrename

import (
	"os"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/logging"
	"golang.org/x/sys/windows"
)

// FILE_RENAME_INFO flags for the FileRenameInfoEx info class (Windows 10 1607+
// / Server 2016+). See the package comment for why POSIX semantics matter.
const (
	fileRenameReplaceIfExists = 0x1
	fileRenamePosixSemantics  = 0x2
	// FILE_INFO_BY_HANDLE_CLASS.FileRenameInfoEx
	fileRenameInfoExClass = 22
)

var log = logging.L("atomicrename")

var defaultPlanner = &planner{
	infoEx:          renameWithInfoEx,
	legacy:          renameWithMoveFile,
	warn:            warnFallback,
	noteLegacyBuild: noteLegacyBuild,
}

// Replace atomically replaces newpath with oldpath. Builds that support
// FileRenameInfoEx use POSIX semantics so a concurrent reader never blocks the
// swap. Older builds, and a kernel that refuses the class, use MoveFileEx.
func Replace(oldpath, newpath string) error {
	return defaultPlanner.replace(windows.RtlGetVersion().BuildNumber, oldpath, newpath)
}

// warnFallback records that a 1607+ build refused FileRenameInfoEx, so that
// rename lost POSIX semantics: MoveFileEx still replaces the file, but a
// concurrent reader can make it fail with ERROR_ACCESS_DENIED. Later renames
// try FileRenameInfoEx again; only this log line is once per process. The
// path is logged because the refusal can depend on the volume (FAT, SMB).
func warnFallback(build uint32, newpath string, err error) {
	log.Warn("FileRenameInfoEx rename refused on a build that should support it; fell back to MoveFileEx without POSIX rename semantics (logged once per process)",
		"build", build, "path", newpath, "error", err.Error())
}

// noteLegacyBuild records once that this OS build predates FileRenameInfoEx, so
// every rename uses MoveFileEx. A rename that later fails with
// ERROR_ACCESS_DENIED because a reader held the target open then has a cause
// in the log.
func noteLegacyBuild(build uint32) {
	log.Info("Windows build predates FileRenameInfoEx; file replacement uses MoveFileEx without POSIX rename semantics",
		"build", build, "minBuild", fileRenameInfoExMinBuild)
}

func renameWithMoveFile(oldpath, newpath string) error {
	from, err := windows.UTF16PtrFromString(oldpath)
	if err != nil {
		return &os.PathError{Op: "rename", Path: oldpath, Err: err}
	}
	to, err := windows.UTF16PtrFromString(newpath)
	if err != nil {
		return &os.PathError{Op: "rename", Path: newpath, Err: err}
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING); err != nil {
		return &os.PathError{Op: "rename", Path: newpath, Err: err}
	}
	return nil
}

func renameWithInfoEx(oldpath, newpath string) error {
	src, err := windows.UTF16PtrFromString(oldpath)
	if err != nil {
		return &os.PathError{Op: "rename", Path: oldpath, Err: err}
	}
	// DELETE access is what a rename needs; share everything so a reader opened
	// with FILE_SHARE_DELETE can hold the file while we swap it.
	h, err := windows.CreateFile(
		src,
		windows.DELETE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return &os.PathError{Op: "rename", Path: oldpath, Err: err}
	}
	defer func() { _ = windows.CloseHandle(h) }()

	name := windows.StringToUTF16(newpath) // includes trailing NUL
	nameLenBytes := (len(name) - 1) * 2    // FileNameLength excludes the NUL
	// FILE_RENAME_INFO layout on 64-bit:
	//   DWORD Flags @0, (4 pad), HANDLE RootDirectory @8, DWORD FileNameLength
	//   @8+ptr, WCHAR FileName[] @8+ptr+4.
	fnLenOff := 8 + int(unsafe.Sizeof(uintptr(0)))
	nameOff := fnLenOff + 4
	buf := make([]byte, nameOff+nameLenBytes+2)
	*(*uint32)(unsafe.Pointer(&buf[0])) = fileRenameReplaceIfExists | fileRenamePosixSemantics
	*(*uint32)(unsafe.Pointer(&buf[fnLenOff])) = uint32(nameLenBytes)
	for i, w := range name {
		*(*uint16)(unsafe.Pointer(&buf[nameOff+i*2])) = w
	}
	if err := windows.SetFileInformationByHandle(h, fileRenameInfoExClass, &buf[0], uint32(len(buf))); err != nil {
		return &os.PathError{Op: "rename", Path: newpath, Err: err}
	}
	return nil
}
