//go:build !windows

package hyperv

// ExportVM is a stub for non-Windows platforms.
func ExportVM(vmName, exportPath, consistencyType string) (*BackupResult, error) {
	return nil, ErrHyperVNotSupported
}
