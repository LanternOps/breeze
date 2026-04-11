package desktop

import "strings"

type reattachAction int

const (
	reattachUseDXGI reattachAction = iota
	reattachUseGDI
)

// decideReattach maps a desktop name to the appropriate capture backend.
// "" means Win32 couldn't read the name — safest assumption is secure desktop.
// "Default" (case-insensitive) is the normal user desktop; use DXGI.
// Anything else (Winlogon, Screen-saver, etc.) is a secure desktop; use GDI.
func decideReattach(desktopName string) reattachAction {
	if desktopName == "" {
		return reattachUseGDI
	}
	if strings.EqualFold(desktopName, "Default") {
		return reattachUseDXGI
	}
	return reattachUseGDI
}
