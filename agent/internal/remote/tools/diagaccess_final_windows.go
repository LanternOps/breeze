//go:build windows

package tools

import (
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

// finalPathOfFile asks Windows where an OPEN handle really is: junctions,
// symlinks, mount points and 8.3 short names are all resolved, and the answer
// cannot change underneath us because it describes this handle.
func finalPathOfFile(f *os.File) (string, error) {
	return finalPathOfHandle(windows.Handle(f.Fd()))
}

// finalPathOfHandle is finalPathOfFile for a raw handle.
func finalPathOfHandle(h windows.Handle) (string, error) {
	return finalPathOfHandleFlags(h, 0 /* VOLUME_NAME_DOS */)
}

// finalPathOfHandleFlags is finalPathOfHandle with explicit
// GetFinalPathNameByHandle flags (VOLUME_NAME_DOS = 0, VOLUME_NAME_GUID, ...).
func finalPathOfHandleFlags(h windows.Handle, flags uint32) (string, error) {
	buf := make([]uint16, 1024)
	for {
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), flags)
		if err != nil {
			return "", err
		}
		if int(n) < len(buf) {
			p := windows.UTF16ToString(buf[:n])
			switch {
			case strings.HasPrefix(p, `\\?\UNC\`):
				// A handle that landed on a network share is out of any
				// local grant's reach; name it so the out-of-scope check
				// cannot match a local root.
				return `\\UNC\` + p[len(`\\?\UNC\`):], nil
			case strings.HasPrefix(p, `\\?\`):
				return p[len(`\\?\`):], nil
			}
			return p, nil
		}
		buf = make([]uint16, n+1)
	}
}

// linkCountOfFile returns the number of hard links to the open file.
func linkCountOfFile(f *os.File, _ os.FileInfo) (uint32, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &info); err != nil {
		return 0, err
	}
	return info.NumberOfLinks, nil
}

// mountIdentityOfFile names the volume an open handle lives on, so a volume
// mounted into a folder of the approved tree is not treated as part of it.
func mountIdentityOfFile(f *os.File) (string, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &info); err != nil {
		return "", err
	}
	return fmt.Sprintf("vol:%08x", info.VolumeSerialNumber), nil
}

// diagOpenFlags is OR'd into the read-only open (see the unix variants).
// Windows volumes carry no FIFOs; named pipes live under \\.\pipe, which
// the path form check refuses.
const diagOpenFlags = 0
