//go:build !windows

package hyperv

// ImportVM is a stub for non-Windows platforms.
func ImportVM(exportPath, vmName string, generateNewID bool) (*RestoreResult, error) {
	return nil, ErrHyperVNotSupported
}
