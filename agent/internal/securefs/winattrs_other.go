//go:build !windows

package securefs

// PreservedWinAttrs/ApplyWinAttrs are no-ops off Windows: Windows file
// attributes have no Unix equivalent, so a Windows manifest restored onto
// Linux/macOS simply drops them (the same way Owner is dropped in the other
// direction). See winattrs_windows.go for the real implementation.
const PreservedWinAttrs = uint32(0)

func ApplyWinAttrs(_ string, _ uint32) error { return nil }
