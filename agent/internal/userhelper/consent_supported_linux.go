//go:build linux

package userhelper

import (
	"os"
	"os/exec"
)

// consentUISupported reports whether this platform can natively render the
// remote-session consent dialog. On Linux the dialog uses zenity, which
// requires both the binary to be present AND a usable display (X11 or
// Wayland) to actually show anything. Without either (headless servers,
// minimal desktops, SSH-only boxes) we do not advertise support so the
// agent's consent gate keeps helper_absent semantics instead of falling
// through to zenity's failure path and recording a fake user-deny.
func consentUISupported() bool {
	if _, err := exec.LookPath("zenity"); err != nil {
		return false
	}
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}
