//go:build !windows

package wakeconfig

import "context"

// CollectWindows is the Windows collector; on other platforms it is
// unsupported.
func CollectWindows(ctx context.Context) (*WindowsReadings, error) {
	return nil, ErrUnsupported
}
