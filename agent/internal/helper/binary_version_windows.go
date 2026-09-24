//go:build windows

package helper

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// readBinaryVersion returns the file version stamped into breeze-helper.exe
// (VS_FIXEDFILEINFO), independent of whether any helper process is running.
func readBinaryVersion(path string) (string, error) {
	var zero windows.Handle
	size, err := windows.GetFileVersionInfoSize(path, &zero)
	if err != nil {
		return "", fmt.Errorf("GetFileVersionInfoSize: %w", err)
	}
	if size == 0 {
		return "", fmt.Errorf("GetFileVersionInfoSize: empty version resource")
	}
	buf := make([]byte, size)
	if err := windows.GetFileVersionInfo(path, 0, size, unsafe.Pointer(&buf[0])); err != nil {
		return "", fmt.Errorf("GetFileVersionInfo: %w", err)
	}
	var fixed *windows.VS_FIXEDFILEINFO
	fixedLen := uint32(unsafe.Sizeof(*fixed))
	if err := windows.VerQueryValue(unsafe.Pointer(&buf[0]), `\`, unsafe.Pointer(&fixed), &fixedLen); err != nil {
		return "", fmt.Errorf("VerQueryValue: %w", err)
	}
	if fixed == nil || fixedLen < uint32(unsafe.Sizeof(*fixed)) {
		return "", fmt.Errorf("VerQueryValue: no fixed file info")
	}
	if fixed.FileVersionMS == 0 && fixed.FileVersionLS == 0 {
		return "", fmt.Errorf("version resource carries a zero file version")
	}
	return formatFixedFileVersion(fixed.FileVersionMS, fixed.FileVersionLS), nil
}
