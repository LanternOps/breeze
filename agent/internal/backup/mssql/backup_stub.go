//go:build !windows

package mssql

// RunBackup is a no-op on non-Windows platforms.
func RunBackup(_, _, _, _ string) (*BackupResult, error) {
	return nil, ErrMSSQLNotSupported
}

// ListBackups is a no-op on non-Windows platforms.
func ListBackups(_, _ string, _ int) ([]BackupResult, error) {
	return nil, ErrMSSQLNotSupported
}
