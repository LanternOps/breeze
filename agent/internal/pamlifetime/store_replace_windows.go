//go:build windows

package pamlifetime

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	fileRenameReplaceIfExists = 0x1
	fileRenamePosixSemantics  = 0x2
	fileRenameInfoExClass     = 22
)

func replaceFile(oldPath, newPath string) error {
	source, err := windows.UTF16PtrFromString(oldPath)
	if err != nil {
		return &os.PathError{Op: "rename", Path: oldPath, Err: err}
	}
	handle, err := windows.CreateFile(source, windows.DELETE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return &os.PathError{Op: "rename", Path: oldPath, Err: err}
	}
	defer func() { _ = windows.CloseHandle(handle) }()

	name := windows.StringToUTF16(newPath)
	nameLengthBytes := (len(name) - 1) * 2
	nameLengthOffset := 8 + int(unsafe.Sizeof(uintptr(0)))
	nameOffset := nameLengthOffset + 4
	buffer := make([]byte, nameOffset+nameLengthBytes+2)
	*(*uint32)(unsafe.Pointer(&buffer[0])) = fileRenameReplaceIfExists | fileRenamePosixSemantics
	*(*uint32)(unsafe.Pointer(&buffer[nameLengthOffset])) = uint32(nameLengthBytes)
	for i, word := range name {
		*(*uint16)(unsafe.Pointer(&buffer[nameOffset+i*2])) = word
	}
	if err := windows.SetFileInformationByHandle(handle, fileRenameInfoExClass, &buffer[0], uint32(len(buffer))); err != nil {
		return &os.PathError{Op: "rename", Path: newPath, Err: err}
	}
	return nil
}
