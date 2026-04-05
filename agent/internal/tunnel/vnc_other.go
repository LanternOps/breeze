//go:build !darwin

package tunnel

// EnableScreenSharing is a no-op on non-macOS platforms.
// VNC tunnels can still work if a VNC server is running.
func EnableScreenSharing(_ string) error {
	return nil
}

// DisableScreenSharing is a no-op on non-macOS platforms.
func DisableScreenSharing() error {
	return nil
}

// IsScreenSharingRunning always returns false on non-macOS.
func IsScreenSharingRunning() bool {
	return false
}
