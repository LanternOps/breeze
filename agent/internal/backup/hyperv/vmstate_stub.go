//go:build !windows

package hyperv

// ChangeVMState is a stub for non-Windows platforms.
func ChangeVMState(vmName, targetState string) (*VMStateResult, error) {
	return nil, ErrHyperVNotSupported
}
