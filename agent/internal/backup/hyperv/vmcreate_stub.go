//go:build !windows

package hyperv

import "context"

// CreateVMFromVHDX is a stub for non-Windows platforms.
func CreateVMFromVHDX(_ context.Context, _ CreateVMRequest) error {
	return ErrHyperVNotSupported
}
