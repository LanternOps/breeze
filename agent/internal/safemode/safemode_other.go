//go:build !windows

package safemode

import "fmt"

// IsSafeMode always returns false on non-Windows platforms.
func IsSafeMode() bool {
	return false
}

// SetSafeBootNetwork is not supported on non-Windows platforms.
func SetSafeBootNetwork() error {
	return fmt.Errorf("safe mode boot is only supported on Windows")
}

// ClearSafeBootFlag is a no-op on non-Windows platforms.
func ClearSafeBootFlag() error {
	return nil
}
