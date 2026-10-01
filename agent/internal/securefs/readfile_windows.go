//go:build windows

package securefs

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func openFileRead(base, relative string) (*os.File, error) {
	parent := base
	if dir := filepath.Dir(relative); dir != "." {
		parent = filepath.Join(base, dir)
	}
	chain, err := openVerifiedDir(parent, false, nil, 0)
	if err != nil {
		return nil, err
	}
	defer chain.close()

	name := filepath.Base(relative)
	handle, err := openRelativeComponent(chain.leaf(), name, windows.GENERIC_READ,
		shareFile, windows.FILE_OPEN, ntFileOptions, nil)
	if err != nil {
		return nil, err
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
