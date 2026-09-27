//go:build !windows

package rebuild

// NewWinSystem is unavailable off Windows — mirrors NewSystem's !linux stub
// (system_other.go). The real implementation is winsystem_windows.go.
func NewWinSystem() WinSystem { return nil }

func init() {
	// hostWindowsDir (win_boot.go): no real host Windows directory off
	// Windows; hostSystemTool's C:\Windows fallback applies.
	hostWindowsDir = func() string { return "" }
}
