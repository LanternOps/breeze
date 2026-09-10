//go:build !windows

package mssql

// ResolveRestoreTargetDir is a no-op on non-Windows platforms.
func ResolveRestoreTargetDir(_ string) (string, error) {
	return "", ErrMSSQLNotSupported
}

// RunRestore is a no-op on non-Windows platforms.
func RunRestore(_, _, _ string, _ bool) (*RestoreResult, error) {
	return nil, ErrMSSQLNotSupported
}

// VerifyBackup is a no-op on non-Windows platforms.
func VerifyBackup(_, _ string) (*VerifyResult, error) {
	return nil, ErrMSSQLNotSupported
}
