//go:build !darwin

package tunnel

// EnableScreenSharing is a no-op on non-macOS platforms.
// VNC tunnels can still work if a VNC server is running.
func EnableScreenSharing() error {
	return nil
}
