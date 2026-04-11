package desktop

import "strings"

// isSecureDesktop returns true when the caller should fall back to GDI.
// Empty name means Win32 couldn't read it — no confidence, so safer fallback.
// "Default" (case-insensitive) is the normal user desktop; DXGI is safe.
// Anything else (Winlogon, Screen-saver, etc.) is a secure desktop.
func isSecureDesktop(desktopName string) bool {
	if desktopName == "" {
		return true
	}
	return !strings.EqualFold(desktopName, "Default")
}
