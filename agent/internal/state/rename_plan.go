package state

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// fileRenameInfoExMinBuild is the first Windows build that implements
// FileRenameInfoEx (Windows 10 1607 / Server 2016). Windows 10 2015 LTSB is
// build 10240 and SetFileInformationByHandle(class 22) there returns
// ERROR_INVALID_PARAMETER (#8858).
const fileRenameInfoExMinBuild = 14393

// Win32 codes a pre-1607 kernel uses to refuse FileRenameInfoEx.
// SetFileInformationByHandle maps STATUS_INVALID_INFO_CLASS to
// ERROR_INVALID_PARAMETER. The other two show up from older wrappers.
const (
	winErrInvalidFunction  = syscall.Errno(1)
	winErrNotSupported     = syscall.Errno(50)
	winErrInvalidParameter = syscall.Errno(87)
)

// renameReplacePlanned picks the rename primitive for this OS build.
//
// Builds that predate FileRenameInfoEx go straight to legacy (MoveFileEx on
// Windows). Newer builds try the POSIX rename first. A result that means
// "this kernel does not implement the class" falls back once; a sharing
// failure does not, because that is the case POSIX rename exists to survive
// and MoveFileEx fails it the same way.
func renameReplacePlanned(build uint32, oldpath, newpath string, infoEx, legacy func(oldpath, newpath string) error) error {
	if build < fileRenameInfoExMinBuild {
		return legacy(oldpath, newpath)
	}
	err := infoEx(oldpath, newpath)
	if !isUnsupportedRenameClass(err) {
		return err
	}
	if ferr := legacy(oldpath, newpath); ferr != nil {
		return fmt.Errorf("%w; legacy rename: %w", err, ferr)
	}
	return nil
}

func isUnsupportedRenameClass(err error) bool {
	if err == nil {
		return false
	}
	var pe *os.PathError
	if errors.As(err, &pe) {
		err = pe.Err
	}
	errno, ok := err.(syscall.Errno)
	if !ok {
		return false
	}
	switch errno {
	case winErrInvalidParameter, winErrNotSupported, winErrInvalidFunction:
		return true
	default:
		return false
	}
}
