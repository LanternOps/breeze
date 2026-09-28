//go:build windows

package backup

import (
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// platformSkippedReparsePoint reports whether an entry the collector is
// skipping is an NTFS reparse point and, if so, which kind (#7051). Named
// pipes and character devices carry no FILE_ATTRIBUTE_REPARSE_POINT and are
// not recorded. A reparse point whose data cannot be read is still recorded,
// as reparseKindOther with the error in detail: the point of recording is
// that the skip is visible, and it is skipped either way.
func platformSkippedReparsePoint(path string, info os.FileInfo) (skippedReparsePoint, bool) {
	if info == nil {
		return skippedReparsePoint{}, false
	}
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok || data == nil || data.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		return skippedReparsePoint{}, false
	}
	sp := skippedReparsePoint{path: path, kind: reparseKindOther}
	buf, err := readReparseData(path)
	if err != nil {
		sp.detail = "reparse data unreadable: " + err.Error()
		return sp, true
	}
	tag, kind, target, perr := parseReparseBuffer(buf)
	sp.tag = tag
	if perr != nil {
		sp.detail = "reparse data malformed: " + perr.Error()
		return sp, true
	}
	sp.kind, sp.target = kind, target
	return sp, true
}

// readReparseData returns the raw REPARSE_DATA_BUFFER for path without
// following the reparse point. Zero desired access plus
// FILE_FLAG_OPEN_REPARSE_POINT is what os.Readlink uses too; it needs no read
// access to the target and works under a VSS shadow-copy path.
func readReparseData(path string) ([]byte, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, 0,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(h)
	buf := make([]byte, windows.MAXIMUM_REPARSE_DATA_BUFFER_SIZE)
	var n uint32
	if err := windows.DeviceIoControl(h, windows.FSCTL_GET_REPARSE_POINT, nil, 0, &buf[0], uint32(len(buf)), &n, nil); err != nil {
		return nil, err
	}
	return buf[:n], nil
}
