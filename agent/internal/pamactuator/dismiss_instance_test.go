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

	// dialog is the prompt dialog itself (FindInstanceDialog); 0 = not found,
	// e.g. only the secure-desktop backdrop belongs to the instance.
	dialog uintptr
	// closeOnRequest closes the whole prompt when the dialog is asked to close;
	// dialogOnlyOnRequest destroys the dialog but leaves the instance's other
	// window (the backdrop) up.
	closeOnRequest      bool
	dialogOnlyOnRequest bool
	closeErr            error
	closeRequests       []uintptr
	dialogClosed        bool
	// cancelOnRequest cancels the dismissal's context right after the request.
	cancelOnRequest func()
	// glitchFindAt makes that one FindInstanceWindow call (1-based) miss;
	// vanishAtFind makes every call from that one on miss.
	glitchFindAt int
	vanishAtFind int
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
	if f.findCalls <= f.windowAfter || f.windowClosed {
		return 0
	}
	if f.findCalls == f.glitchFindAt || (f.vanishAtFind > 0 && f.findCalls >= f.vanishAtFind) {
		return 0
	}
	return f.window
}

func (f *fakeInstanceOps) FindInstanceDialog(uint32) uintptr {
	if f.windowClosed || f.dialogClosed {
		return 0
	}
	return f.dialog
}

func (f *fakeInstanceOps) RequestClose(hwnd uintptr) error {
	f.closeRequests = append(f.closeRequests, hwnd)
	if f.cancelOnRequest != nil {
		f.cancelOnRequest()
	}
	if f.closeErr != nil {
		return f.closeErr
	}
	switch {
	case f.closeOnRequest:
		f.windowClosed = true
	case f.dialogOnlyOnRequest:
		f.dialogClosed = true
	}
	return nil
}

func (f *fakeInstanceOps) WindowClass(hwnd uintptr) string {
	if hwnd == f.dialog && hwnd != 0 {
		return "Credential Dialog Xaml Host"
	}
	return "$$$Secure UAP Background Window$$$"
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

func (f *fakeInstanceOps) WindowAlive(hwnd uintptr) bool {
	if f.windowClosed {
		return false
	}
	return hwnd != f.dialog || !f.dialogClosed
}

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

// #10177: a standard user's Windows 11 credential prompt stayed open after the
// approved launch. The elevated program had just opened, so the prompt was not
// the foreground window, a SYSTEM service cannot take the foreground, and the
// Escape-only dismissal refused to press anything. Closing the prompt's own
// dialog window does not depend on keyboard focus.
func TestDismissConsentInstanceClosesDialogWithoutForeground(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, foreground: false, raiseWorks: false, closeOnRequest: true}
	res := runTargeted(t, ops, testInstance)
	if !res.Success || res.Reason != "ok" {
		t.Fatalf("result = %+v, want ok from the close request", res)
	}
	if len(ops.closeRequests) != 1 || ops.closeRequests[0] != 0xD1 {
		t.Fatalf("close requests = %#x, want exactly one, to the dialog 0xd1 (never the backdrop)", ops.closeRequests)
	}
	if ops.escapes != 0 || ops.raiseCalls != 0 {
		t.Fatalf("escapes=%d raises=%d, want neither once the close request worked", ops.escapes, ops.raiseCalls)
	}
}

func TestDismissConsentInstanceCloseRequestIgnoredFallsBackToEscape(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, foreground: true, closeOnEsc: true}
	res := runTargeted(t, ops, testInstance)
	if !res.Success || len(ops.closeRequests) != 1 || ops.escapes != 1 {
		t.Fatalf("result = %+v closeRequests=%d escapes=%d, want ok via one close request then one Escape",
			res, len(ops.closeRequests), ops.escapes)
	}
}

func TestDismissConsentInstanceCloseRequestErrorFallsBackToEscape(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, closeErr: errors.New("PostMessage: access denied"), foreground: true, closeOnEsc: true}
	res := runTargeted(t, ops, testInstance)
	if !res.Success || ops.escapes != 1 {
		t.Fatalf("result = %+v escapes=%d, want ok via the Escape fallback", res, ops.escapes)
	}
}

func TestDismissConsentInstanceCloseIgnoredAndNotForegroundDidNotClose(t *testing.T) {
	// The close request was delivered, so this is not "nothing was pressed":
	// it reports consent_did_not_close, names the window class, and still sends
	// no Escape into a window that is not the target's.
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, foreground: false, raiseWorks: false}
	res := runTargeted(t, ops, testInstance)
	if res.Success || res.Reason != "consent_did_not_close" {
		t.Fatalf("result = %+v, want consent_did_not_close", res)
	}
	if ops.escapes != 0 {
		t.Fatalf("escapes = %d, want 0", ops.escapes)
	}
	if !strings.Contains(res.DetailMessage, "Credential Dialog Xaml Host") {
		t.Fatalf("detail %q should name the prompt's window class", res.DetailMessage)
	}
}

func TestDismissConsentInstanceDialogGoneButBackdropLeftIsNotClosed(t *testing.T) {
	// Secure desktop: the dialog went away but consent.exe and its backdrop
	// did not. The user is still looking at the dimmed prompt desktop.
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, dialogOnlyOnRequest: true, foreground: false}
	res := runTargeted(t, ops, testInstance)
	if res.Success || res.Reason != "consent_did_not_close" || ops.escapes != 0 {
		t.Fatalf("result = %+v escapes=%d, want consent_did_not_close and no Escape while the instance still owns a prompt window", res, ops.escapes)
	}
}

func TestDismissConsentInstanceOneMissedWindowSearchIsNotProofOfClose(t *testing.T) {
	// The dialog is gone and one search of the desktop misses the backdrop
	// (call 1 is the initial search, call 2 the first poll after the close
	// request). A single empty search is not proof; the backdrop is back on
	// the next one.
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, dialogOnlyOnRequest: true, glitchFindAt: 2}
	res := runTargeted(t, ops, testInstance)
	if res.Success {
		t.Fatalf("result = %+v, want failure: one missed search must not count as the prompt closing", res)
	}
}

func TestDismissConsentInstanceCloseErrorAndNotForegroundPressedNothing(t *testing.T) {
	// PostMessage failed, so nothing reached the prompt: the reason must stay
	// the "nothing was pressed" consent_not_foreground, with the error kept.
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, closeErr: errors.New("PostMessage: access denied"), foreground: false}
	res := runTargeted(t, ops, testInstance)
	if res.Reason != ReasonConsentNotForeground || ops.escapes != 0 {
		t.Fatalf("result = %+v escapes=%d, want %s and no Escape", res, ops.escapes, ReasonConsentNotForeground)
	}
	if !strings.Contains(res.DetailMessage, "PostMessage: access denied") {
		t.Fatalf("detail %q should keep the close-request error", res.DetailMessage)
	}
}

func TestDismissConsentInstanceNoWindowLeftButProcessLiveIsNotClosed(t *testing.T) {
	// The close wait timed out with the dialog still alive; by the next search
	// no window of the instance is left, but consent.exe still runs.
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, vanishAtFind: 2, foreground: true}
	res := runTargeted(t, ops, testInstance)
	if res.Success || res.Reason != "consent_did_not_close" || ops.escapes != 0 {
		t.Fatalf("result = %+v escapes=%d, want consent_did_not_close without Escape", res, ops.escapes)
	}
	if !strings.Contains(res.DetailMessage, "still running") {
		t.Fatalf("detail %q should say the process is still running", res.DetailMessage)
	}
}

func TestDismissConsentInstanceEscapeSuccessKeepsCloseNote(t *testing.T) {
	// Field diagnosis for #10177: when Escape had to finish the job, the
	// result must still say the close request did not.
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, foreground: false, raiseWorks: true, closeOnEsc: true}
	res := runTargeted(t, ops, testInstance)
	if !res.Success || ops.raiseCalls != 1 || ops.escapes != 1 {
		t.Fatalf("result = %+v raises=%d escapes=%d, want ok via raise then Escape", res, ops.raiseCalls, ops.escapes)
	}
	if !strings.Contains(res.DetailMessage, "still open after a close request") {
		t.Fatalf("detail %q should record that the close request did not close the prompt", res.DetailMessage)
	}
}

func TestDismissConsentInstanceNoDialogFoundIsRecorded(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xB0, foreground: false}
	res := runTargeted(t, ops, testInstance)
	if res.Reason != ReasonConsentNotForeground || !strings.Contains(res.DetailMessage, "close request skipped") {
		t.Fatalf("result = %+v, want %s noting the skipped close request", res, ReasonConsentNotForeground)
	}
}

func TestDismissConsentInstanceCloseThenProcessExitIsOK(t *testing.T) {
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, dialogOnlyOnRequest: true, liveSeq: []bool{true, false}}
	res := runTargeted(t, ops, testInstance)
	if !res.Success || ops.escapes != 0 {
		t.Fatalf("result = %+v escapes=%d, want ok once consent.exe exited", res, ops.escapes)
	}
}

func TestDismissConsentInstanceCancelledAfterCloseRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ops := &fakeInstanceOps{window: 0xB0, dialog: 0xD1, foreground: true, closeOnEsc: true, cancelOnRequest: cancel}
	res := dismissConsentInstance(ctx, ops, testInstance, time.Now().Add(time.Second), time.Millisecond)
	if res.Reason != dismissCancelledReason || ops.escapes != 0 {
		t.Fatalf("result = %+v escapes=%d, want %s and no Escape", res, ops.escapes, dismissCancelledReason)
	}
	if !strings.Contains(res.DetailMessage, "after a close request") {
		t.Fatalf("detail %q should say the close request was already sent", res.DetailMessage)
	}
}

func TestDismissConsentInstanceGuardsSendNoCloseRequest(t *testing.T) {
	cases := map[string]*fakeInstanceOps{
		"gone":         {liveSeq: []bool{false}, window: 0xB0, dialog: 0xD1},
		"unverifiable": {liveErr: errors.New("access denied"), window: 0xB0, dialog: 0xD1},
		"no window":    {window: 0xB0, dialog: 0xD1, windowAfter: 1 << 30},
	}
	for name, ops := range cases {
		t.Run(name, func(t *testing.T) {
			if res := runTargeted(t, ops, testInstance); res.Success || len(ops.closeRequests) != 0 {
				t.Fatalf("result = %+v closeRequests=%d, want failure with no close request", res, len(ops.closeRequests))
			}
		})
	}
}

func TestDismissConsentInstanceBackdropOnlyUsesEscape(t *testing.T) {
	// No dialog window of the instance was found (only the backdrop): nothing
	// to address, so the July-validated foreground-guarded Escape runs as before.
	ops := &fakeInstanceOps{window: 0xB0, foreground: true, closeOnEsc: true}
	res := runTargeted(t, ops, testInstance)
	if !res.Success || len(ops.closeRequests) != 0 || ops.escapes != 1 {
		t.Fatalf("result = %+v closeRequests=%d escapes=%d", res, len(ops.closeRequests), ops.escapes)
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
