//go:build linux

package userhelper

import "os/exec"

// consentUISupported reports whether this platform can natively render the
// remote-session consent dialog. On Linux the dialog uses zenity; without it
// (headless servers, minimal desktops) we do not advertise support so the
// agent's consent gate keeps helper_absent semantics instead of failing
// closed on a broken dialog.
func consentUISupported() bool {
	_, err := exec.LookPath("zenity")
	return err == nil
}
