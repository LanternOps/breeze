//go:build !windows

package hyperv

// EstimateExportBytes is a stub for non-Windows platforms.
func EstimateExportBytes(vmName string) (int64, error) {
	return 0, ErrHyperVNotSupported
}

// DefaultVirtualHardDiskPath is a stub for non-Windows platforms.
func DefaultVirtualHardDiskPath() (string, error) {
	return "", ErrHyperVNotSupported
}
