//go:build !windows

package clipboard

// SequenceNumber is unavailable off Windows; only the Windows system helper
// uses it (see NewUserClipboardFallback).
func SequenceNumber() (uint64, bool) {
	return 0, false
}
