//go:build !windows

package sessionbroker

// IsSessionDisconnected always returns false on non-Windows platforms.
// Windows session disconnect detection is only applicable to Windows services.
func IsSessionDisconnected(_ string) bool {
	return false
}

// GetConsoleSessionID returns "1" on non-Windows platforms (no concept of
// multiple interactive sessions).
func GetConsoleSessionID() string {
	return "1"
}
