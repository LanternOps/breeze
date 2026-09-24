//go:build windows

package rebuild

// NewWinSystem returns nil until Task 12 lands the real WinSystem; Run then
// answers ErrUnsupportedHost for a Windows snapshot, exactly as before W06.
func NewWinSystem() WinSystem { return nil }
