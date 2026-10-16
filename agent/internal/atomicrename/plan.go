package atomicrename

import (
	"errors"
	"fmt"
	"os"
	"sync"
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

type renameFunc func(oldpath, newpath string) error

// planner picks the rename primitive for an OS build. infoEx is the POSIX
// rename (FileRenameInfoEx on Windows); legacy is MoveFileEx.
//
// Each hook fires at most once per planner, so a process that renames on every
// heartbeat leaves one line, not one per write:
//   - warn: the first time a 1607+ build has to fall back. The fallback itself
//     is decided per call; only the log line is once per process.
//   - noteLegacyBuild: the first rename on a build that predates
//     FileRenameInfoEx and so never has POSIX rename semantics.
type planner struct {
	infoEx          renameFunc
	legacy          renameFunc
	warn            func(build uint32, newpath string, err error)
	warnOnce        sync.Once
	noteLegacyBuild func(build uint32)
	legacyNoteOnce  sync.Once
}

// replace renames oldpath over newpath.
//
// The warning fires before the legacy attempt, so it records the downgrade
// even when MoveFileEx then fails too.
//
// Builds that predate FileRenameInfoEx go straight to legacy. Newer builds try
// the POSIX rename first. A result that means "this kernel does not implement
// the class" falls back once; a sharing failure does not, because that is the
// case POSIX rename exists to survive and MoveFileEx fails it the same way.
func (p *planner) replace(build uint32, oldpath, newpath string) error {
	if build < fileRenameInfoExMinBuild {
		if p.noteLegacyBuild != nil {
			p.legacyNoteOnce.Do(func() { p.noteLegacyBuild(build) })
		}
		return p.legacy(oldpath, newpath)
	}
	err := p.infoEx(oldpath, newpath)
	if !isUnsupportedRenameClass(err) {
		return err
	}
	if p.warn != nil {
		p.warnOnce.Do(func() { p.warn(build, newpath, err) })
	}
	if ferr := p.legacy(oldpath, newpath); ferr != nil {
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
