//go:build !linux

package patching

import "time"

// DesktopPrompt reports that nothing was shown on every platform but Linux.
//
// Windows and macOS deliver the prompt through the desktop helper over the
// session broker (W3); the daemon-drawn dialog is the Linux-only substitute for
// a helper that does not ship there. ("", false) is the same answer a headless
// Linux box gives, and the manager already handles it: it falls back to the
// ordinary notification and the reboot proceeds on schedule.
func DesktopPrompt(_, _, _ string, _ []string, _ time.Duration) (string, bool) {
	return "", false
}

// DesktopNotify is a no-op off Linux; the session broker owns notification
// delivery on the platforms that have a helper.
func DesktopNotify(_, _, _ string) {}
