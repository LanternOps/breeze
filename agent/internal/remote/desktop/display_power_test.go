package desktop

import (
	"errors"
	"fmt"
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
		// A lid-closed MacBook: panel online and asleep, external display
		// awake. Not asleep — no wake can light the panel, and every open
		// would otherwise burn the wake budget.
		{"one of two asleep beside an awake one", displayCounts{online: 2, active: 1, asleep: 1}, displayStateAwake},
		{"every attached display asleep", displayCounts{online: 2, active: 2, asleep: 2}, displayStateAsleep},
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
	// The prefix is the case found; the wrapped base text lists both causes.
	if !strings.HasPrefix(msg, "no display is attached") {
		t.Errorf("absent error should lead with the absent case, got %q", msg)
	}
	if strings.HasPrefix(msg, "a display is attached but asleep") {
		t.Errorf("absent error must not lead with asleep, got %q", msg)
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

// The annotation is for zero-displays failures only. A permission denial on a
// Mac whose display is asleep or absent must not be told "not a permissions
// failure" or sent to a dummy plug.
func TestOpenWithDisplayWake_OnlyZeroDisplayErrorsAreLabelled(t *testing.T) {
	for _, counts := range []displayCounts{countsAsleep, countsAbsent} {
		ops := &fakeDisplayPower{script: []displayCounts{counts}}
		w, _ := testWaker(ops)
		base := translateCaptureError(captureErrPermissionDenied)
		_, err := w.open(func() (ScreenCapturer, error) { return nil, base })
		if err != base {
			t.Fatalf("counts %+v: err = %v, want the permission error unchanged", counts, err)
		}
	}
	// A zero-displays error buried in the SCK-then-CG fallback chain is
	// still recognised (capture_probe.go wraps both with %w).
	chained := fmt.Errorf("ScreenCaptureKit failed (%w); CoreGraphics fallback also failed: %w",
		translateCaptureError(captureErrNoDisplayAttached), translateCaptureError(captureErrNoDisplayAttached))
	got := describeDisplayStateError(chained, displayStateAbsent, countsAbsent, nil)
	if !strings.Contains(got.Error(), "no display is attached") {
		t.Fatalf("chained zero-displays error should be labelled, got %q", got)
	}
}

// Awake at the check, asleep after the failed open, and it never wakes: one
// open, one bounded wait, the asleep error.
func TestOpenWithDisplayWake_FellAsleepAndNeverWokeIsBounded(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake, countsAsleep}}
	w, slept := testWaker(ops)
	opens := 0
	_, err := w.open(func() (ScreenCapturer, error) {
		opens++
		return nil, translateCaptureError(captureErrNoDisplayAttached)
	})
	if opens != 1 || *slept != 3*time.Second {
		t.Fatalf("opens=%d slept=%v, want 1 open and the 3s budget", opens, *slept)
	}
	if err == nil || !strings.Contains(err.Error(), "asleep") {
		t.Fatalf("want the asleep error, got %v", err)
	}
}

// The display woke for the retry, but the retry failed for another reason:
// the retry's error is returned, judged against a fresh reading.
func TestOpenWithDisplayWake_RetryFailureReportsTheRetryError(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake, countsAsleep, countsAwake}}
	w, _ := testWaker(ops)
	retryErr := errors.New("SCK refused the stream")
	opens := 0
	_, err := w.open(func() (ScreenCapturer, error) {
		opens++
		if opens == 1 {
			return nil, translateCaptureError(captureErrNoDisplayAttached)
		}
		return nil, retryErr
	})
	if opens != 2 || err != retryErr {
		t.Fatalf("opens=%d err=%v, want 2 opens and the retry error unchanged", opens, err)
	}
}

// When the wake declaration itself failed, the error must not claim the
// display ignored it.
func TestOpenWithDisplayWake_FailedDeclarationIsNamed(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAsleep}, declareErr: errors.New("IOReturn 0xe00002c1")}
	w, _ := testWaker(ops)
	_, err := w.open(func() (ScreenCapturer, error) {
		return nil, translateCaptureError(captureErrNoDisplayAttached)
	})
	msg := err.Error()
	if !strings.Contains(msg, "could not be woken") || !strings.Contains(msg, "0xe00002c1") {
		t.Fatalf("want the failed declaration named, got %q", msg)
	}
	if strings.Contains(msg, "did not wake when Breeze declared") {
		t.Fatalf("must not claim a declaration that failed, got %q", msg)
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
	err := translateCaptureError(captureErrNoDisplayAttached)
	msg := err.Error()
	if strings.Contains(msg, "dummy plug") {
		t.Fatalf("the bare zero-displays error must not assume a headless Mac — a sleeping display reports zero too (#10874); got %q", msg)
	}
	if !strings.Contains(msg, "asleep") || !strings.Contains(msg, "nothing attached") {
		t.Fatalf("the bare zero-displays error should name both causes, got %q", msg)
	}
	if !errors.Is(err, errZeroDisplays) || !errors.Is(err, ErrDisplayNotFound) {
		t.Fatalf("code 11 must wrap errZeroDisplays and ErrDisplayNotFound, got %v", err)
	}
	if errors.Is(translateCaptureError(captureErrContentUnavailable), errZeroDisplays) {
		t.Fatal("content-unavailable must not read as a zero-displays failure")
	}
}

// The stream restart path in capture_darwin.go (darwin+cgo, never built in
// CI) delegates to these two helpers; they are tested here, and the wiring is
// pinned by TestDisplayWakeWiring.
func TestStreamRestartHelpers(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAsleep}}
	declareForStreamRestart(ops)
	if ops.declares != 1 {
		t.Fatalf("declareForStreamRestart: declares=%d, want 1", ops.declares)
	}
	declareForStreamRestart(nil)

	zero := translateCaptureError(captureErrNoDisplayAttached)
	if got := describeCurrentDisplayState(ops, zero); !strings.Contains(got.Error(), "asleep") {
		t.Fatalf("restart zero-displays error should be labelled asleep, got %q", got)
	}
	other := translateCaptureError(captureErrSCStreamFailed)
	if got := describeCurrentDisplayState(ops, other); got != other {
		t.Fatalf("a non-zero-displays restart error must pass through, got %v", got)
	}
	if describeCurrentDisplayState(ops, nil) != nil {
		t.Fatal("nil in, nil out")
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
	if got := h.stopReason(&fakeDisplayPower{script: []displayCounts{countsAwake}}); got != "" {
		t.Fatalf("nil hold, awake display: stopReason = %q, want empty", got)
	}
	nilOps := acquireDisplayWakeHold(nil, "s")
	nilOps.nudge()
	nilOps.release()
}

// A failed declaration still takes the assertion; a failed release is not
// retried.
func TestDisplayWakeHold_PartialFailures(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake}, declareErr: errors.New("declare failed")}
	h := acquireDisplayWakeHold(ops, "s1")
	if ops.prevents != 1 || ops.openRelease != 1 {
		t.Fatalf("assertion must be taken even when the declaration fails, prevents=%d open=%d", ops.prevents, ops.openRelease)
	}
	ops.releaseErr = errors.New("release failed")
	h.release()
	h.release()
	if ops.releases != 1 {
		t.Fatalf("a failed release must not be retried, releases=%d", ops.releases)
	}

	unsupported := acquireDisplayWakeHold(noDisplayPowerForTest{}, "s2")
	unsupported.nudge()
	unsupported.release()
}

// noDisplayPowerForTest mirrors the non-darwin no-op (display_power_other.go
// is not built on a Mac, so the test cannot name it there).
type noDisplayPowerForTest struct{}

func (noDisplayPowerForTest) counts() (displayCounts, bool) { return displayCounts{}, false }
func (noDisplayPowerForTest) declareUserActivity() error    { return errDisplayPowerUnsupported }
func (noDisplayPowerForTest) preventDisplaySleep() (func() error, error) {
	return nil, errDisplayPowerUnsupported
}

// nudge runs on the capture goroutine while doCleanup releases on another.
func TestDisplayWakeHold_ConcurrentNudgeAndRelease(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake}}
	h := acquireDisplayWakeHold(ops, "s1")
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(2)
		go func() { defer wg.Done(); h.nudge() }()
		go func() { defer wg.Done(); h.release() }()
	}
	wg.Wait()
	if ops.releases != 1 {
		t.Fatalf("releases=%d, want exactly 1", ops.releases)
	}
}

// doCleanup releases the hold exactly once, after the capturer is closed.
func TestDoCleanupReleasesTheDisplayWakeHoldAfterTheCapturer(t *testing.T) {
	var order []string
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake}}
	s := newTestSession("s1")
	s.capturer = &closeRecordingCapturer{onClose: func() { order = append(order, "capturer") }}
	s.displayWake = acquireDisplayWakeHold(ops, "s1")
	origRelease := s.displayWake.releaseFn
	s.displayWake.releaseFn = func() error { order = append(order, "assertion"); return origRelease() }
	s.doCleanup()
	s.doCleanup()
	if ops.releases != 1 || ops.openRelease != 0 {
		t.Fatalf("releases=%d open=%d, want the assertion released exactly once", ops.releases, ops.openRelease)
	}
	if strings.Join(order, ",") != "capturer,assertion" {
		t.Fatalf("teardown order = %v, want capturer then assertion", order)
	}
}

type closeRecordingCapturer struct {
	stubCapturer
	onClose func()
}

func (c *closeRecordingCapturer) Close() error { c.onClose(); return nil }

// StartSession, the capture loops and the darwin stream shim need a real
// display and cannot run in CI; this source contract pins their wiring.
func TestDisplayWakeWiring(t *testing.T) {
	read := func(name string) string {
		b, err := desktopSources.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return string(b)
	}
	inOrder := func(file, src string, needles ...string) {
		t.Helper()
		from := 0
		for _, n := range needles {
			i := strings.Index(src[from:], n)
			if i < 0 {
				t.Fatalf("%s: %q missing or out of order (want order %q)", file, n, needles)
			}
			from += i + len(n)
		}
	}
	webrtc := read("session_webrtc.go")
	start := webrtc[strings.Index(webrtc, "func (m *SessionManager) StartSession("):]
	// The hold is taken in the Session literal, before the session is
	// published (a concurrent stop must see it), and before the first open.
	inOrder("session_webrtc.go", start,
		"displayWake: acquireDisplayWakeHold(displayPower, sessionID)",
		"m.sessions[sessionID] = session",
		"openSessionCapturer(capConfig)",
	)
	if strings.Contains(start, "NewScreenCapturer(") {
		t.Error("StartSession must open through openSessionCapturer, not NewScreenCapturer")
	}

	sess := read("session.go")
	inOrder("session.go", sess[strings.Index(sess, "func (s *Session) doCleanup()"):],
		"s.capturer.Close()",
		"s.displayWake.release()",
	)

	capture := read("session_capture.go")
	for _, loop := range []string{"func (s *Session) captureLoopDXGI()", "func (s *Session) captureLoopTicker()"} {
		body := capture[strings.Index(capture, loop):]
		inOrder("session_capture.go "+loop, body,
			"noVideoStopReason(capturer, s.displayWake)",
			"s.displayWake.nudge()",
			"ForceReattach()",
		)
	}

	darwin := read("capture_darwin.go")
	inOrder("capture_darwin.go", darwin[strings.Index(darwin, "func (s sckStreamShim) start("):],
		"if refreshFilter {",
		"declareForStreamRestart(displayPower)",
		"C.sckStartStream(",
		"describeCurrentDisplayState(displayPower, translateDarwinError(code))",
	)

	// CoreGraphics and CGDisplayStream report zero active displays as code
	// 11, so the session open can label them.
	for _, f := range []string{"capture_darwin_cg.go", "capture_darwin_displaystream.go"} {
		inOrder(f, read(f), "if (displayCount == 0) {", "return 11;")
	}
}

func TestDisplayStopReason(t *testing.T) {
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
			var h *displayWakeHold
			got := h.stopReason(tc.ops)
			if !strings.Contains(got, tc.want) || strings.Contains(got, tc.notWant) {
				t.Fatalf("stopReason = %q, want it to contain %q and not %q", got, tc.want, tc.notWant)
			}
			if strings.Contains(got, "permissions") {
				t.Fatalf("the watchdog does not know the capture error; it must not rule out permissions: %q", got)
			}
			if len(got) > maxStopReasonBytes {
				t.Fatalf("reason is %d bytes, over the %d-byte stop-reason bound: %q", len(got), maxStopReasonBytes, got)
			}
		})
	}
	var h *displayWakeHold
	if got := h.stopReason(&fakeDisplayPower{script: []displayCounts{countsAwake}}); got != "" {
		t.Fatalf("awake display: want no display reason, got %q", got)
	}
	if got := h.stopReason(&fakeDisplayPower{unknown: true}); got != "" {
		t.Fatalf("unknown platform: want no display reason, got %q", got)
	}
}

// The watchdog gives up after its own nudges may have lit the display again;
// the state seen at the last restart, before its wake, is what explains the
// outage.
func TestDisplayWakeHold_StopReasonUsesTheStateSeenAtTheLastRestart(t *testing.T) {
	ops := &fakeDisplayPower{script: []displayCounts{countsAwake, countsAsleep, countsAwake}}
	h := acquireDisplayWakeHold(ops, "s1") // read 1: awake
	h.nudge()                              // read 2: asleep, recorded before declaring
	if got := h.stopReason(ops); !strings.Contains(got, "asleep") {
		t.Fatalf("stopReason = %q, want the asleep state seen at the restart", got)
	}
}

// The watchdog's stop reason names the display case when the capturer
// swallowed nothing — the issue's session ended with the generic fallback.
func TestNoVideoStopReason_NamesASleepingDisplay(t *testing.T) {
	withDisplayPower(t, &fakeDisplayPower{script: []displayCounts{countsAsleep}})
	got := noVideoStopReason(&stubCapturer{}, nil)
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
