//go:build windows

package tools

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// requireDiskHandle refuses a handle that is not a file or folder on disk (a
// device, a pipe, a console) before anything is read from or written to it.
// Names that reach devices are refused earlier too; this checks what the
// handle actually is.
func requireDiskHandle(f *os.File) error {
	t, err := windows.GetFileType(windows.Handle(f.Fd()))
	if err != nil {
		return fmt.Errorf("cannot determine what %s is: %w", f.Name(), err)
	}
	if t != windows.FILE_TYPE_DISK {
		return containmentDeniedf("%s is not a file on disk", f.Name())
	}
	return nil
}
