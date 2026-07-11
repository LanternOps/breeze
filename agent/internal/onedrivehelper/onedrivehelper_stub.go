//go:build !windows

package onedrivehelper

// Apply is a no-op on non-Windows platforms: OneDrive provisioning has no
// meaning on macOS/Linux, so the agent reports nothing (nil state → the
// heartbeat omits onedriveDeviceState entirely).
func Apply(cfg Config) (*DeviceState, error) {
	return nil, nil
}
