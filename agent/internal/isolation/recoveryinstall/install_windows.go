//go:build windows

package recoveryinstall

import "golang.org/x/sys/windows"

// MoveFileEx without REPLACE_EXISTING atomically publishes or refuses a collision.
func publishExclusive(source, target string) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_WRITE_THROUGH)
}
