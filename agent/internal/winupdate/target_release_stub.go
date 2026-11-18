//go:build !windows

package winupdate

// ApplyTargetRelease is a no-op on non-Windows platforms.
func ApplyTargetRelease(pin *TargetRelease) (Result, error) {
	return Result{
		Supported: false,
		Reason:    "Windows Update target-release policy is only supported on Windows",
	}, nil
}
