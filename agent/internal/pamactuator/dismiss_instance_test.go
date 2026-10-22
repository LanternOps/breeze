package pamactuator

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeInstanceOps scripts the Win32 primitives the targeted dismissal uses.
type fakeInstanceOps struct {
	// liveSeq is returned by successive InstanceLive calls; the last value
	// repeats once exhausted.
	liveSeq []bool
	liveErr error
	// liveErrAfterEscape makes InstanceLive fail once Escape has been sent.
	liveErrAfterEscape error
	liveCall           int

	window       uintptr
	windowAfter  int // FindInstanceWindow returns 0 for this many calls first
	findCalls    int
	foreground   bool
	raiseWorks   bool
	raiseCalls   int
	escapeErr    error
	escapes      int
	closeOnEsc   bool
	windowClosed bool
}

func (f *fakeInstanceOps) InstanceLive(ConsentInstance) (bool, error) {
	if f.liveErr != nil {
		return false, f.liveErr
	}
	if f.liveErrAfterEscape != nil && f.escapes > 0 {
		return false, f.liveErrAfterEscape
	}
	i := f.liveCall
	f.liveCall++
	if len(f.liveSeq) == 0 {
		return true, nil
	}
	if i >= len(f.liveSeq) {
		i = len(f.liveSeq) - 1
	}
	return f.liveSeq[i], nil
}

func (f *fakeInstanceOps) FindInstanceWindow(uint32) uintptr {
	f.findCalls++
	if f.findCalls <= f.windowAfter {
		return 0
	}
	return f.window
}

func (f *fakeInstanceOps) ForegroundOwnedBy(uint32) bool { return f.foreground }

func (f *fakeInstanceOps) BringToForeground(uintptr) {
	f.raiseCalls++
	if f.raiseWorks {
		f.foreground = true
	}
}

func (f *fakeInstanceOps) PressEscape() error {
	f.escapes++
	if f.escapeErr != nil {
		return f.escapeErr
	}
	if f.closeOnEsc {
		f.windowClosed = true
	}
	return nil
}

func (f *fakeInstanceOps) WindowAlive(uintptr) bool { return !f.windowClosed }

var testInstance = ConsentInstance{PID: 4242, CreatedAt: time.Date(2026, 10, 17, 3, 3, 17, 123456700, time.UTC)}

func runTargeted(t *testing.T, ops *fakeInstanceOps, inst ConsentInstance) Result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return dismissConsentInstance(ctx, ops, inst, time.Now().Add(300*time.Millisecond), time.Millisecond)
}

func TestDismissConsentInstanceDismissesOnlyTheForegroundTarget(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xBEEF, foreground: true, closeOnEsc: true}
	res := runTargeted(t, ops, testInstance)
	if !res.Success || res.Reason != "ok" {
		t.Fatalf("result = %+v, want ok", res)
	}
	if ops.escapes != 1 {
		t.Fatalf("escapes = %d, want exactly 1", ops.escapes)
	}
}

func TestDismissConsentInstanceGoneIsNoConsentWindowWithoutInput(t *testing.T) {
	// Exited, or the PID now belongs to a different process (creation time
	// mismatch) — both surface as "not live". Nothing may be pressed.
	ops := &fakeInstanceOps{liveSeq: []bool{false}, window: 0xBEEF, foreground: true}
	res := runTargeted(t, ops, testInstance)
	if res.Success || res.Reason != ReasonNoConsentWindow {
		t.Fatalf("result = %+v, want %s", res, ReasonNoConsentWindow)
	}
	if ops.escapes != 0 || ops.findCalls != 0 {
		t.Fatalf("touched the desktop for a gone instance: escapes=%d finds=%d", ops.escapes, ops.findCalls)
	}
}

func TestDismissConsentInstanceUnverifiableIdentityNeverPresses(t *testing.T) {
	ops := &fakeInstanceOps{liveErr: errors.New("access denied"), window: 0xBEEF, foreground: true}
	res := runTargeted(t, ops, testInstance)
	if res.Success || res.Reason != ReasonConsentIdentityUnverified {
		t.Fatalf("result = %+v, want %s", res, ReasonConsentIdentityUnverified)
	}
	if ops.escapes != 0 {
		t.Fatalf("escapes = %d, want 0", ops.escapes)
	}
}

func TestDismissConsentInstanceRefusesWhenTargetCannotBeForeground(t *testing.T) {
	// Another prompt (or anything else) holds the foreground and the target
	// cannot be raised: Escape would land on the wrong window, so press nothing.
	ops := &fakeInstanceOps{window: 0xBEEF, foreground: false, raiseWorks: false}
	res := runTargeted(t, ops, testInstance)
	if res.Success || res.Reason != ReasonConsentNotForeground {
		t.Fatalf("result = %+v, want %s", res, ReasonConsentNotForeground)
	}
	if ops.escapes != 0 {
		t.Fatalf("escapes = %d, want 0 — Escape would have hit a non-target window", ops.escapes)
	}
	if ops.raiseCalls != 1 {
		t.Fatalf("raise attempts = %d, want 1", ops.raiseCalls)
	}
}

func TestDismissConsentInstanceRaisesTargetThenDismisses(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xBEEF, foreground: false, raiseWorks: true, closeOnEsc: true}
	res := runTargeted(t, ops, testInstance)
	if !res.Success {
		t.Fatalf("result = %+v, want ok after raising the target", res)
	}
	if ops.escapes != 1 {
		t.Fatalf("escapes = %d, want 1", ops.escapes)
	}
}

func TestDismissConsentInstanceExitWhileSearchingIsNoConsentWindow(t *testing.T) {
	ops := &fakeInstanceOps{liveSeq: []bool{true, false}, window: 0xBEEF, windowAfter: 1000, foreground: true}
	res := runTargeted(t, ops, testInstance)
	if res.Reason != ReasonNoConsentWindow || ops.escapes != 0 {
		t.Fatalf("result = %+v escapes=%d, want %s and no input", res, ops.escapes, ReasonNoConsentWindow)
	}
}

func TestDismissConsentInstanceLiveButNoWindowIsNotProofOfClear(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xBEEF, windowAfter: 1 << 30, foreground: true}
	res := runTargeted(t, ops, testInstance)
	if res.Success || res.Reason == ReasonNoConsentWindow {
		t.Fatalf("result = %+v; a live consent.exe without a found window must not report no_consent_window", res)
	}
	if res.Reason != ReasonConsentWindowNotFound || ops.escapes != 0 {
		t.Fatalf("result = %+v escapes=%d, want %s and no input", res, ops.escapes, ReasonConsentWindowNotFound)
	}
}

func TestDismissConsentInstanceDidNotClose(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xBEEF, foreground: true, closeOnEsc: false}
	res := runTargeted(t, ops, testInstance)
	if res.Success || res.Reason != "consent_did_not_close" {
		t.Fatalf("result = %+v, want consent_did_not_close", res)
	}
}

func TestDismissConsentInstanceInvalidInstance(t *testing.T) {
	for _, inst := range []ConsentInstance{{}, {PID: 1}, {CreatedAt: testInstance.CreatedAt}} {
		ops := &fakeInstanceOps{window: 0xBEEF, foreground: true}
		res := runTargeted(t, ops, inst)
		if res.Success || res.Reason != ReasonInvalidConsentInstance || ops.escapes != 0 || ops.liveCall != 0 {
			t.Fatalf("instance %+v: result = %+v escapes=%d", inst, res, ops.escapes)
		}
	}
}

func TestDismissConsentInstanceCancelledBeforeInput(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xBEEF, foreground: true, closeOnEsc: true}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res := dismissConsentInstance(ctx, ops, testInstance, time.Now().Add(time.Second), time.Millisecond)
	if res.Reason != dismissCancelledReason || ops.escapes != 0 {
		t.Fatalf("result = %+v escapes=%d, want %s and no input", res, ops.escapes, dismissCancelledReason)
	}
}

// The identity rules that decide "this PID is still OUR prompt" — previously
// inline in the Windows-only InstanceLive — are pure and table-tested here.
func TestConsentProcessMatches(t *testing.T) {
	good := consentProcessFacts{
		CreatedAt:     testInstance.CreatedAt,
		ExitCode:      stillActiveExitCode,
		ImagePath:     `C:\Windows\System32\consent.exe`,
		Session:       2,
		HelperSession: 2,
	}
	tests := []struct {
		name     string
		mutate   func(*consentProcessFacts)
		wantLive bool
		wantErr  bool
	}{
		{"exact live instance in this session", func(*consentProcessFacts) {}, true, false},
		{"PID reused by a later process", func(f *consentProcessFacts) { f.CreatedAt = f.CreatedAt.Add(100 * time.Nanosecond) }, false, false},
		{"creation time in another zone is the same instant", func(f *consentProcessFacts) { f.CreatedAt = f.CreatedAt.In(time.FixedZone("x", 3600)) }, true, false},
		{"exited", func(f *consentProcessFacts) { f.ExitCode = 0 }, false, false},
		{"image is not consent.exe", func(f *consentProcessFacts) { f.ImagePath = `C:\Windows\System32\notepad.exe` }, false, true},
		{"image check is case-insensitive", func(f *consentProcessFacts) { f.ImagePath = `C:\WINDOWS\system32\CONSENT.EXE` }, true, false},
		{"another user's session", func(f *consentProcessFacts) { f.Session = 3 }, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			facts := good
			tc.mutate(&facts)
			live, err := consentProcessMatches(testInstance, facts)
			if live != tc.wantLive || (err != nil) != tc.wantErr {
				t.Fatalf("consentProcessMatches = (%v, %v), want (%v, err=%v)", live, err, tc.wantLive, tc.wantErr)
			}
		})
	}
}

func TestDismissConsentInstanceDidNotCloseReportsUnverifiableLiveness(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xBEEF, foreground: true, closeOnEsc: false, liveErrAfterEscape: errors.New("access denied")}
	res := runTargeted(t, ops, testInstance)
	if res.Reason != "consent_did_not_close" || !strings.Contains(res.DetailMessage, "access denied") {
		t.Fatalf("result = %+v, want consent_did_not_close mentioning the liveness error", res)
	}
}

func TestNoopActuatorDismissInstanceUnsupported(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no-op stub only compiled on non-Windows")
	}
	d, ok := New().(InstanceDismisser)
	if !ok {
		t.Fatal("platform actuator does not implement InstanceDismisser")
	}
	if res := d.DismissInstance(context.Background(), testInstance); res.Success || res.Reason != "unsupported_platform" {
		t.Fatalf("result = %+v, want unsupported_platform", res)
	}
}
