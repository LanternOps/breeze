//go:build !windows

package winupdate

// Apply is a no-op on non-Windows platforms. Windows Update source enforcement
// has no meaning on macOS/Linux, so the agent simply reports it unsupported.
func Apply(enforce bool) (Result, error) {
	return Result{
		Supported: false,
		Reason:    "Windows Update source enforcement is only supported on Windows",
	}, nil
}
