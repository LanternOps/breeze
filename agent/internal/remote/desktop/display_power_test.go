package desktop

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// No build tag, on purpose: the IOKit/CoreGraphics side is `darwin && cgo` and
// the Test Agent CI job runs on ubuntu-latest, so the decision logic and the
// assertion lifecycle are tested here against a fake displayPowerOps (#10874).

// fakeDisplayPower scripts the display counts each read returns and records
// every IOKit-shaped call. Once the script runs out, the last entry repeats.
type fakeDisplayPower struct {
	mu          sync.Mutex
	script      []displayCounts
	unknown     bool
	reads       int
	declares    int
	declareErr  error
	prevents    int
	preventErr  error
	releases    int
	releaseErr  error
	onDeclare   func(f *fakeDisplayPower)
	openRelease int // assertions created and not yet released
}

func (f *fakeDisplayPower) counts() (displayCounts, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.unknown {
		return displayCounts{}, false
	}
	i := f.reads
	if i >= len(f.script) {
		i = len(f.script) - 1
	}
	f.reads++
	return f.script[i], true
}

func (f *fakeDisplayPower) declareUserActivity() error {
	f.mu.Lock()
	f.declares++
	hook := f.onDeclare
	err := f.declareErr
	f.mu.Unlock()
	if hook != nil {
		hook(f)
	}
	return err
}

func (f *fakeDisplayPower) preventDisplaySleep() (func() error, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prevents++
	if f.preventErr != nil {
		return nil, f.preventErr
	}
	f.openRelease++
	return func() error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.releases++
		f.openRelease--
		return f.releaseErr
	}, nil
}

var (
	countsAbsent = displayCounts{online: 0, active: 0, asleep: 0}
	countsAsleep = displayCounts{online: 1, active: 0, asleep: 1}
	countsAwake  = displayCounts{online: 1, active: 1, asleep: 0}
)

// testWaker returns a waker over ops whose sleeps are recorded instead of
// slept, so a 3 s wake budget costs nothing.
func testWaker(ops displayPowerOps) (displayWaker, *time.Duration) {
	slept := new(time.Duration)
	return displayWaker{
		ops:     ops,
		sleep:   func(d time.Duration) { *slept += d },
		timeout: 3 * time.Second,
		poll:    250 * time.Millisecond,
	}, slept
}

func TestClassifyDisplays(t *testing.T) {
	cases := []struct {
		name string
		c    displayCounts
		want displayState
	}{
		{"nothing online is absent", countsAbsent, displayStateAbsent},
		{"online but none active is asleep", displayCounts{online: 1, active: 0, asleep: 0}, displayStateAsleep},
		{"online and reported asleep", countsAsleep, displayStateAsleep},
		{"one of two asleep still needs a wake", displayCounts{online: 2, active: 1, asleep: 1}, displayStateAsleep},
		{"online and active is awake", countsAwake, displayStateAwake},
		{"two awake displays", displayCounts{online: 2, active: 2, asleep: 0}, displayStateAwake},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyDisplays(tc.c); got != tc.want {
				t.Fatalf("classifyDisplays(%+v) = %v, want %v", tc.c, got, tc.want)
			}
		})
	}
}

func TestReadDisplayState_UnknownWhenPlatformCannotTell(t *testing.T) {
	state, _ := readDisplayState(&fakeDisplayPower{unknown: true})
	if state != displayStateUnknown {
		t.Fatalf("state = %v, want unknown", state)
	}
	state, _ = readDisplayState(nil)
	if state != displayStateUnknown {
		t.Fatalf("nil ops: state = %v, want unknown", state)
	}
}

// A display that is attached and awake: no wake, no wait, one open.
func TestOpenWithDisplayWake_AwakeOpensOnce(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake}}
	w, slept := testWaker(ops)
	opens := 0
	capturer, err := w.open(func() (ScreenCapturer, error) { opens++; return &stubCapturer{}, nil })
	if err != nil || capturer == nil {
		t.Fatalf("open: capturer=%v err=%v", capturer, err)
	}
	if opens != 1 || ops.declares != 0 || *slept != 0 {
		t.Fatalf("opens=%d declares=%d slept=%v, want 1/0/0", opens, ops.declares, *slept)
	}
}

// The display is asleep when the session starts (the "display already off"
// connect in #10874): declare user activity, poll until it wakes, then open.
func TestOpenWithDisplayWake_AsleepIsWokenBeforeTheFirstOpen(t *testing.T) {
	// Reads: the pre-open check, the wake's first read, then one per poll.
	ops := &fakeDisplayPower{script: []displayCounts{countsAsleep, countsAsleep, countsAsleep, countsAwake}}
	w, slept := testWaker(ops)
	opens := 0
	var declaresAtOpen int
	capturer, err := w.open(func() (ScreenCapturer, error) {
		opens++
		declaresAtOpen = ops.declares
		return &stubCapturer{}, nil
	})
	if err != nil || capturer == nil {
		t.Fatalf("open: capturer=%v err=%v", capturer, err)
	}
	if declaresAtOpen != 1 {
		t.Fatalf("user activity declared %d times before the first open, want 1", declaresAtOpen)
	}
	if opens != 1 {
		t.Fatalf("opens = %d, want 1", opens)
	}
	if *slept != 2*250*time.Millisecond {
		t.Fatalf("slept %v, want two polls (500ms)", *slept)
	}
}

// The wake wait is bounded: a display that never wakes costs the budget once,
// and the error says it was asleep — not headless.
func TestOpenWithDisplayWake_AsleepThatNeverWakesIsBoundedAndNamed(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAsleep}}
	w, slept := testWaker(ops)
	opens := 0
	base := translateCaptureError(captureErrNoDisplayAttached)
	_, err := w.open(func() (ScreenCapturer, error) { opens++; return nil, base })
	if err == nil {
		t.Fatal("expected an error")
	}
	if opens != 1 {
		t.Fatalf("opens = %d, want 1 (the wait already ran before the first open)", opens)
	}
	if *slept != 3*time.Second {
		t.Fatalf("slept %v, want exactly the 3s budget", *slept)
	}
	msg := err.Error()
	if !strings.Contains(msg, "asleep") {
		t.Errorf("error should say the display was asleep, got %q", msg)
	}
	for _, banned := range []string{"dummy plug", "headless Mac this is normal"} {
		if strings.Contains(msg, banned) {
			t.Errorf("asleep error must not carry the headless advice (%q), got %q", banned, msg)
		}
	}
	if !errors.Is(err, ErrDisplayNotFound) {
		t.Errorf("annotated error must still wrap the capture error, got %v", err)
	}
}

// The display was awake at the pre-check but went off before the capturer
// opened: wake it and retry once.
func TestOpenWithDisplayWake_FellAsleepDuringOpenIsWokenAndRetried(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake, countsAsleep, countsAsleep, countsAwake}}
	w, _ := testWaker(ops)
	opens := 0
	capturer, err := w.open(func() (ScreenCapturer, error) {
		opens++
		if opens == 1 {
			return nil, translateCaptureError(captureErrNoDisplayAttached)
		}
		return &stubCapturer{}, nil
	})
	if err != nil || capturer == nil {
		t.Fatalf("open: capturer=%v err=%v", capturer, err)
	}
	if opens != 2 || ops.declares != 1 {
		t.Fatalf("opens=%d declares=%d, want 2/1", opens, ops.declares)
	}
}

// Nothing online: the headless advice stands, no wake is attempted.
func TestOpenWithDisplayWake_AbsentKeepsHeadlessAdvice(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAbsent}}
	w, slept := testWaker(ops)
	opens := 0
	_, err := w.open(func() (ScreenCapturer, error) {
		opens++
		return nil, translateCaptureError(captureErrNoDisplayAttached)
	})
	if err == nil {
		t.Fatal("expected an error")
	}
	if opens != 1 || ops.declares != 0 || *slept != 0 {
		t.Fatalf("opens=%d declares=%d slept=%v, want 1/0/0", opens, ops.declares, *slept)
	}
	msg := err.Error()
	if !strings.Contains(msg, "no display is attached") || !strings.Contains(msg, "dummy plug") {
		t.Errorf("absent error should say no display is attached and keep the dummy-plug advice, got %q", msg)
	}
	if strings.Contains(msg, "asleep") {
		t.Errorf("absent error must not say asleep, got %q", msg)
	}
}

// A failure with the display awake is not a display problem: the error passes
// through untouched (permissions, SCK refusal, ...).
func TestOpenWithDisplayWake_AwakeFailurePassesThrough(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake}}
	w, _ := testWaker(ops)
	base := errors.New("Screen Recording declined")
	_, err := w.open(func() (ScreenCapturer, error) { return nil, base })
	if err != base {
		t.Fatalf("err = %v, want the original error unchanged", err)
	}
}

// Off macOS (or without cgo) the platform cannot tell: behaviour is exactly
// the old single open.
func TestOpenWithDisplayWake_UnknownPlatformIsUnchanged(t *testing.T) {
	ops := &fakeDisplayPower{unknown: true}
	w, slept := testWaker(ops)
	base := errors.New("boom")
	opens := 0
	_, err := w.open(func() (ScreenCapturer, error) { opens++; return nil, base })
	if err != base || opens != 1 || ops.declares != 0 || *slept != 0 {
		t.Fatalf("err=%v opens=%d declares=%d slept=%v, want passthrough/1/0/0", err, opens, ops.declares, *slept)
	}
}

func TestZeroDisplayErrorNoLongerAssumesHeadless(t *testing.T) {
	msg := translateCaptureError(captureErrNoDisplayAttached).Error()
	if strings.Contains(msg, "dummy plug") {
		t.Fatalf("the bare zero-displays error must not assume a headless Mac — a sleeping display reports zero too (#10874); got %q", msg)
	}
}

func TestDisplayWakeHold_Lifecycle(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake}}
	h := acquireDisplayWakeHold(ops, "s1")
	if ops.declares != 1 {
		t.Fatalf("acquire should declare user activity once before the first capture, got %d", ops.declares)
	}
	if ops.prevents != 1 || ops.openRelease != 1 {
		t.Fatalf("acquire should hold one display-sleep assertion, prevents=%d open=%d", ops.prevents, ops.openRelease)
	}
	h.nudge()
	if ops.declares != 2 {
		t.Fatalf("nudge should declare user activity, declares=%d", ops.declares)
	}
	h.release()
	h.release()
	if ops.releases != 1 || ops.openRelease != 0 {
		t.Fatalf("release must release the assertion exactly once, releases=%d open=%d", ops.releases, ops.openRelease)
	}
	h.nudge()
	if ops.declares != 2 {
		t.Fatalf("nudge after release must not declare activity, declares=%d", ops.declares)
	}
}

func TestDisplayWakeHold_AssertionFailureDoesNotFailTheSession(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake}, preventErr: errors.New("kIOReturnNotPrivileged")}
	h := acquireDisplayWakeHold(ops, "s1")
	if h == nil {
		t.Fatal("acquire must return a usable hold even when the assertion fails")
	}
	h.nudge()
	h.release()
	if ops.releases != 0 {
		t.Fatalf("nothing to release, releases=%d", ops.releases)
	}
}

func TestDisplayWakeHold_NilSafe(t *testing.T) {
	var h *displayWakeHold
	h.nudge()
	h.release()
}

func TestDisplayStateStopReason(t *testing.T) {
	cases := []struct {
		name    string
		ops     *fakeDisplayPower
		want    string
		notWant string
	}{
		{"asleep", &fakeDisplayPower{script: []displayCounts{countsAsleep}}, "asleep", "dummy plug"},
		{"absent", &fakeDisplayPower{script: []displayCounts{countsAbsent}}, "no display is attached", "asleep"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := displayStateStopReason(tc.ops)
			if !strings.Contains(got, tc.want) || strings.Contains(got, tc.notWant) {
				t.Fatalf("displayStateStopReason = %q, want it to contain %q and not %q", got, tc.want, tc.notWant)
			}
			if len(got) > maxStopReasonBytes {
				t.Fatalf("reason is %d bytes, over the %d-byte stop-reason bound: %q", len(got), maxStopReasonBytes, got)
			}
		})
	}
	if got := displayStateStopReason(&fakeDisplayPower{script: []displayCounts{countsAwake}}); got != "" {
		t.Fatalf("awake display: want no display reason, got %q", got)
	}
	if got := displayStateStopReason(&fakeDisplayPower{unknown: true}); got != "" {
		t.Fatalf("unknown platform: want no display reason, got %q", got)
	}
}

// The watchdog's stop reason names the display case when the capturer
// swallowed nothing — the issue's session ended with the generic fallback.
func TestNoVideoStopReason_NamesASleepingDisplay(t *testing.T) {
	withDisplayPower(t, &fakeDisplayPower{script: []displayCounts{countsAsleep}})
	got := noVideoStopReason(&stubCapturer{})
	if got == noVideoStopReasonFallback || !strings.Contains(got, "asleep") {
		t.Fatalf("noVideoStopReason = %q, want the asleep-display reason", got)
	}
}

func withDisplayPower(t *testing.T, ops displayPowerOps) {
	t.Helper()
	prev := displayPower
	displayPower = ops
	t.Cleanup(func() { displayPower = prev })
}
