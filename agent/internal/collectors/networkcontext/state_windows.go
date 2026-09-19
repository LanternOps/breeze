//go:build windows

package networkcontext

import "golang.org/x/sys/windows"

func replaceStateFile(from, to string) error {
	source, e := windows.UTF16PtrFromString(from)
	if e != nil {
		return e
	}
	target, e := windows.UTF16PtrFromString(to)
	if e != nil {
		return e
	}
	return windows.MoveFileEx(source, target, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
