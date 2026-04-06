//go:build !windows

package mssql

// DiscoverInstances is a no-op on non-Windows platforms.
func DiscoverInstances() ([]SQLInstance, error) {
	return nil, ErrMSSQLNotSupported
}
