package heartbeat

import "runtime"

// DesktopStartRefusalLoginWindow is the reason code a start_desktop refusal
// carries, in parentheses, when the macOS console is at the login window. The
// web UI matches "(login_window)" in the session's errorMessage to render a
// specific "use VNC Relay" message (#7047); keep the two in step.
const DesktopStartRefusalLoginWindow = "login_window"

// desktopStartHostOS is the OS the login-window gate applies to. A variable
// only so tests can exercise the darwin branch on every CI platform.
var desktopStartHostOS = runtime.GOOS

// loginWindowDesktopStartRefusal returns the error a start_desktop must fail
// with when the Mac is at the login window, or nil to let the start proceed.
//
// Apple drops synthetic keyboard and mouse input at the login window for
// third-party agents without a private entitlement, through IOHIDPostEvent and
// CGEventPost alike, and both calls still report success. Capture keeps
// working, so a WebRTC session started there streams a login screen that looks
// usable while every click and keystroke is silently discarded (#7047). VNC
// Relay drives the login window through native macOS Screen Sharing instead.
//
// This is the authoritative gate: the web UI decides from the heartbeat's
// desktopAccess state, which can be stale across a reboot or a logout, and the
// viewer re-sends start_desktop on its own after a logout handoff.
//
// An unknown console user (the darwin console watcher has not reported yet)
// is allowed through: refusing then would block every connect on a detection
// gap rather than on a known login window.
func (h *Heartbeat) loginWindowDesktopStartRefusal() error {
	if desktopStartHostOS != "darwin" || h.sessionBroker == nil {
		return nil
	}
	if !h.sessionBroker.ConsoleAtLoginWindow() {
		return nil
	}
	return errLoginWindowDesktopStart{}
}

// errLoginWindowDesktopStart is the login-window refusal. Its text reaches the
// technician verbatim — the API stores it as the session's errorMessage and
// the viewer shows it as the reason the session did not start — so it is
// written as a sentence, which is why it is a type and not an errors.New.
type errLoginWindowDesktopStart struct{}

func (errLoginWindowDesktopStart) Error() string {
	return "Remote Desktop is not available at the macOS login window (" + DesktopStartRefusalLoginWindow + "): " +
		"macOS blocks remote keyboard and mouse input until a user signs in. " +
		"Use VNC Relay to sign in at the login window, then connect again."
}
