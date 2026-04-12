package desktop

import "strings"

// isSecureDesktop returns true when the caller should fall back to GDI.
// Empty name means Win32 couldn't read it — this is a transient failure
// (common during desktop transitions), not a secure desktop. Callers
// should retry DXGI; if DXGI truly can't attach, initDXGI will fail on
// its own merits and the caller can fall to GDI then.
// "Default" (case-insensitive) is the normal user desktop; DXGI is safe.
// Anything else (Winlogon, Screen-saver, etc.) is a secure desktop.
func isSecureDesktop(desktopName string) bool {
	if desktopName == "" {
		return false
	}
	return !strings.EqualFold(desktopName, "Default")
}
