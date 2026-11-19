//go:build windows

package oemupdates

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// peFileVersion reads VS_FIXEDFILEINFO as major.minor.build. A read, not a
// spawn, so the availability gate stays cheap.
func peFileVersion(path string) (string, error) {
	var zero windows.Handle
	size, err := windows.GetFileVersionInfoSize(path, &zero)
	if err != nil {
		return "", fmt.Errorf("GetFileVersionInfoSize: %w", err)
	}
	if size == 0 {
		return "", errors.New("empty version resource")
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
		return "", errors.New("no fixed file info")
	}
	if fixed.FileVersionMS == 0 && fixed.FileVersionLS == 0 {
		return "", errors.New("zero file version")
	}
	return fmt.Sprintf("%d.%d.%d", fixed.FileVersionMS>>16, fixed.FileVersionMS&0xffff, fixed.FileVersionLS>>16), nil
}
