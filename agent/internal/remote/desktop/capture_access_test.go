package desktop

import "testing"

// #8390: permission checks must not capture. checkCaptureAccess combines only
// non-capturing signals; these tests pin the precedence between them.

type accessSignalsFake struct {
	preflight   bool
	namedWindow bool
	lastSession bool
	unreliable  bool
	namesCalls  int
}

func (f *accessSignalsFake) signals() captureAccessSignals {
	return captureAccessSignals{
		preflight: func() bool { return f.preflight },
		namedWindowVisible: func() bool {
			f.namesCalls++
			return f.namedWindow
		},
		lastSessionCaptured: func() bool { return f.lastSession },
		preflightUnreliable: f.unreliable,
	}
}

func TestCheckCaptureAccess_PreflightGrantIsFinal(t *testing.T) {
	f := &accessSignalsFake{preflight: true}
	got := checkCaptureAccess(f.signals())
	if got.State != CaptureAccessGranted || got.Reason != "preflight" {
		t.Fatalf("got %+v, want granted by preflight", got)
	}
	if f.namesCalls != 0 {
		t.Fatalf("window names queried %d times after preflight reported the grant", f.namesCalls)
	}
}

// macOS <= 15: preflight is authoritative, so a false answer is a denial even
// when a stale session record or an optimistic signal would say otherwise.
func TestCheckCaptureAccess_ReliablePreflightFalseIsDenied(t *testing.T) {
	for _, tc := range []struct {
		name string
		f    *accessSignalsFake
	}{
		{"nothing else", &accessSignalsFake{}},
		{"stale session record", &accessSignalsFake{lastSession: true}},
		{"named windows", &accessSignalsFake{namedWindow: true}},
	} {
		got := checkCaptureAccess(tc.f.signals())
		if got.State != CaptureAccessDenied || got.Reason != "preflight" {
			t.Fatalf("%s: got %+v, want denied by preflight", tc.name, got)
		}
	}
}

// macOS 26+: preflight can report false while the grant is present, so the
// other non-capturing signals decide.
func TestCheckCaptureAccess_UnreliablePreflightUsesOtherSignals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		f      *accessSignalsFake
		state  CaptureAccessState
		reason string
	}{
		{"titled window grants", &accessSignalsFake{unreliable: true, namedWindow: true}, CaptureAccessGranted, "window_names"},
		{"no titled window, session record", &accessSignalsFake{unreliable: true, lastSession: true}, CaptureAccessGranted, "last_session"},
		{"no titled window, no record: unknown, never denied", &accessSignalsFake{unreliable: true}, CaptureAccessUnknown, "unverified"},
	} {
		got := checkCaptureAccess(tc.f.signals())
		if got.State != tc.state || got.Reason != tc.reason {
			t.Fatalf("%s: got %+v, want %v/%s", tc.name, got, tc.state, tc.reason)
		}
	}
}

// Consumers: CanCapture lets a session try unless access is known to be
// denied (the session's own capture is the precise check); the TCC status and
// the consent-dialog gate only trust a known grant.
func TestCaptureAccessReport_Consumers(t *testing.T) {
	for _, tc := range []struct {
		state      CaptureAccessState
		canCapture bool
		granted    bool
	}{
		{CaptureAccessGranted, true, true},
		{CaptureAccessUnknown, true, false},
		{CaptureAccessDenied, false, false},
	} {
		r := CaptureAccessReport{State: tc.state}
		if r.CanCapture() != tc.canCapture || r.Granted() != tc.granted {
			t.Fatalf("%v: CanCapture=%t Granted=%t, want %t/%t", tc.state, r.CanCapture(), r.Granted(), tc.canCapture, tc.granted)
		}
	}
}

func TestCheckCaptureAccess_NilSignalsAreAbsent(t *testing.T) {
	got := checkCaptureAccess(captureAccessSignals{preflight: func() bool { return false }, preflightUnreliable: true})
	if got.State != CaptureAccessUnknown || got.Reason != "unverified" {
		t.Fatalf("got %+v, want unknown/unverified with no optional signals", got)
	}
}
