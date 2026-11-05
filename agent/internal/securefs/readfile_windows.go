//go:build windows

package securefs

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// absentError marks a not-found status as fs.ErrNotExist while keeping the
// status itself. The walk opens through NtCreateFile, and windows.NTStatus has
// no Is method, so without this a missing file satisfies errors.Is only on the
// Unix walk, where the same miss is an ENOENT.
type absentError struct{ error }

func (e absentError) Unwrap() []error { return []error{e.error, fs.ErrNotExist} }

func reportAbsence(err error) error {
	if isNotFound(err) {
		return absentError{err}
	}
	return err
}

func openFileRead(base, relative string) (*os.File, error) {
	parent := base
	if dir := filepath.Dir(relative); dir != "." {
		parent = filepath.Join(base, dir)
	}
	chain, err := openVerifiedDir(parent, false, nil, 0)
	if err != nil {
		return nil, reportAbsence(err)
	}
	defer chain.close()

	name := filepath.Base(relative)
	handle, err := openRelativeComponent(chain.leaf(), name, windows.GENERIC_READ,
		shareFile, windows.FILE_OPEN, ntFileOptions, nil)
	if err != nil {
		return nil, reportAbsence(err)
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		_ = windows.CloseHandle(handle)
		return nil, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = windows.CloseHandle(handle)
		return nil, fmt.Errorf("target is a link: %q", name)
	}
	return os.NewFile(uintptr(handle), filepath.Join(parent, name)), nil
}
