//go:build !windows

package hyperv

// ManageCheckpoint is a stub for non-Windows platforms.
func ManageCheckpoint(vmName, action, checkpointName string) (*CheckpointResult, error) {
	return nil, ErrHyperVNotSupported
}
