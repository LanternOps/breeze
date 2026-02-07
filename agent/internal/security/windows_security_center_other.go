//go:build !windows

package security

// GetWindowsSecurityCenterProducts returns unsupported on non-Windows hosts.
func GetWindowsSecurityCenterProducts() ([]AVProduct, error) {
	return nil, ErrNotSupported
}
