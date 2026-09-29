//go:build !windows

package hosttool

func init() {
	// No Windows directory off Windows; SystemTool's C:\Windows fallback
	// applies (tests only — every caller runs on Windows).
	windowsDir = func() string { return "" }
}
