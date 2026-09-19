//go:build !linux && !windows

package layout

import "context"

// Collect is unsupported on this platform (macOS bare-metal is out of scope,
// spec §12).
func Collect(_ context.Context) (*Manifest, error) {
	return nil, ErrUnsupportedPlatform
}
