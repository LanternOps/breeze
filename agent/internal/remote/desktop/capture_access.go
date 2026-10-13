package desktop

import "log/slog"

// Non-capturing Screen Recording access check (#8390).
//
// On macOS 15 every screen capture, ScreenCaptureKit or CoreGraphics, goes
// through replayd, and the first capture in each 30-day window puts macOS's
// screen-capture acknowledgement alert in front of the console user. The
// helper's permission checks (the TCC check loop, the connect-time capability
// probe, the background re-probe) used to take a real CoreGraphics frame, so
// that alert fired from a helper restart with nobody at the other end. These
// checks now combine only signals that never capture; the one real capture
// happens when a session opens its capturer and a technician is waiting.
//
// This file carries a `unix` build tag so the Linux CI job tests the policy
// with fakes; capture_darwin.go wires the real signals.

// CaptureAccessState is what the non-capturing signals could establish.
type CaptureAccessState int

const (
	// CaptureAccessDenied: this process does not hold the grant.
	CaptureAccessDenied CaptureAccessState = iota
	// CaptureAccessGranted: this process holds the grant.
	CaptureAccessGranted
	// CaptureAccessUnknown: no signal could decide. Only possible where
	// preflight is unreliable (macOS 26+), with no titled other-app window
	// on screen and no recorded session.
	CaptureAccessUnknown
)

func (s CaptureAccessState) String() string {
	switch s {
	case CaptureAccessDenied:
		return "denied"
	case CaptureAccessGranted:
		return "granted"
	default:
		return "unknown"
	}
}

// The window-name check: the window server exposes other processes' window
// titles (kCGWindowName) only to a process that holds the Screen Recording
// grant. It is a metadata query (CGWindowListCopyWindowInfo), not a capture.
// It is positive evidence only: Apple documents the title as optional and
// few apps set it, so unnamed windows prove nothing.

// captureAccessSignals are the non-capturing inputs to checkCaptureAccess.
// A nil optional signal counts as absent.
type captureAccessSignals struct {
	// preflight is CGPreflightScreenCaptureAccess: authoritative up to macOS
	// 15; on macOS 26+ it can report false while the grant is present.
	preflight func() bool
	// preflightUnreliable is true on macOS 26+.
	preflightUnreliable bool
	// namedWindowVisible reports whether another process's window on screen
	// carries a title; optional.
	namedWindowVisible func() bool
	// lastSessionCaptured reports whether a real session captured through
	// ScreenCaptureKit on this host under the current fingerprint; optional.
	lastSessionCaptured func() bool
}

// CaptureAccessReport is the outcome of a non-capturing access check.
type CaptureAccessReport struct {
	State CaptureAccessState
	// Reason names the signal that decided: "preflight", "window_names",
	// "last_session", or "unverified" when none could.
	Reason string
}

// CaptureAccessStatus is the report in a form the CLI probe and logs carry.
type CaptureAccessStatus struct {
	State      string `json:"state"`
	Reason     string `json:"reason"`
	CanCapture bool   `json:"canCapture"`
}

// Status renders the report.
func (r CaptureAccessReport) Status() CaptureAccessStatus {
	return CaptureAccessStatus{State: r.State.String(), Reason: r.Reason, CanCapture: r.CanCapture()}
}

// CanCapture is the value for Capabilities.CanCapture: a session may try
// unless access is known to be denied. The session's own capture is the
// precise check, and refusing to try would leave a macOS 26 host whose
// preflight misreports with no way to ever prove the grant.
func (r CaptureAccessReport) CanCapture() bool { return r.State != CaptureAccessDenied }

// Granted is the value for the TCC status and the consent-dialog gate: only a
// known grant. An unknown state keeps the "missing permission" guidance and
// the rate-limited consent request in place.
func (r CaptureAccessReport) Granted() bool { return r.State == CaptureAccessGranted }

// Denied reports a known denial: the only state in which asking macOS for the
// grant can help.
func (r CaptureAccessReport) Denied() bool { return r.State == CaptureAccessDenied }

// checkCaptureAccess decides from the signals in order: preflight (final
// where reliable), a titled window, the recorded session, else unknown.
func checkCaptureAccess(s captureAccessSignals) CaptureAccessReport {
	if s.preflight() {
		return CaptureAccessReport{State: CaptureAccessGranted, Reason: "preflight"}
	}
	if !s.preflightUnreliable {
		return CaptureAccessReport{State: CaptureAccessDenied, Reason: "preflight"}
	}
	if s.namedWindowVisible != nil && s.namedWindowVisible() {
		return CaptureAccessReport{State: CaptureAccessGranted, Reason: "window_names"}
	}
	if s.lastSessionCaptured != nil && s.lastSessionCaptured() {
		return CaptureAccessReport{State: CaptureAccessGranted, Reason: "last_session"}
	}
	return CaptureAccessReport{State: CaptureAccessUnknown, Reason: "unverified"}
}

// logCaptureAccessOnce keeps the unverified-state explanation to one line per
// process: the TCC loop checks every few minutes.
func logCaptureAccessOnce(r CaptureAccessReport, warned *bool) {
	if r.State == CaptureAccessUnknown && !*warned {
		*warned = true
		slog.Warn("Screen Recording access could not be verified without capturing: preflight reports no grant " +
			"(macOS 26 can report false while the grant is present), no other app's titled window is on screen, " +
			"and no session has captured yet; a session will be allowed and its own capture decides")
	}
}
