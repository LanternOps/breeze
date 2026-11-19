//go:build !windows

package biosconfig

import "context"

// RunReadOnlyPowerShell is Windows-only; elsewhere nothing runs.
func RunReadOnlyPowerShell(context.Context, string, []byte) ([]byte, error) {
	return nil, ErrUnsupported
}

// NativeArch is only read on Windows.
func NativeArch() string { return "unknown" }
