package desktop

import (
	"errors"
	"fmt"
	"strings"
	"syscall"
	"testing"
	"time"
)

// No build tag: the SetThreadDesktop failure path only happens on a live
// secure desktop, so the error text is the diagnostic channel (#8434, #9558).
// Its construction is pure Go and asserted here on every platform.

func TestSetThreadDesktopErrorCarriesCodeAndDesktops(t *testing.T) {
	err := setThreadDesktopError("Default", "Winlogon", syscall.Errno(170))
	msg := err.Error()
	for _, want := range []string{"SetThreadDesktop", `"Default"`, `"Winlogon"`, "170", "0xAA", "windows or hooks"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q does not contain %q", msg, want)
		}
	}
	if code, ok := win32ErrorCode(err); !ok || code != 170 {
		t.Errorf("win32ErrorCode = %d, %v; want 170, true", code, ok)
	}
	if !errors.Is(err, syscall.Errno(170)) {
		t.Errorf("errors.Is must reach the errno, got %v", err)
	}
}

func TestSetThreadDesktopErrorHints(t *testing.T) {
	for _, tc := range []struct {
		code uint32
		hint string
	}{
		{170, "windows or hooks"},
		{5, "access denied"},
		{6, "invalid desktop handle"},
		{87, "invalid parameter"},
	} {
		msg := setThreadDesktopError("A", "B", syscall.Errno(tc.code)).Error()
		if !strings.Contains(msg, tc.hint) {
			t.Errorf("code %d: message %q lacks hint %q", tc.code, msg, tc.hint)
		}
	}
	// An unrecognised code still reports the number and adds no guessed cause.
	msg := setThreadDesktopError("A", "B", syscall.Errno(1234)).Error()
	if !strings.Contains(msg, "1234") || strings.Contains(msg, "[") {
		t.Errorf("unknown code message = %q, want the code and no hint", msg)
	}
}

func TestSetThreadDesktopErrorZeroAndUnknownNames(t *testing.T) {
	msg := setThreadDesktopError("", "", syscall.Errno(0)).Error()
	if !strings.Contains(msg, "Win32 recorded no error code") {
		t.Errorf("zero errno must be reported as no code, got %q", msg)
	}
	if strings.Contains(msg, `""`) {
		t.Errorf("an unreadable desktop name must not render as an empty string, got %q", msg)
	}
	if !strings.Contains(msg, "unknown") {
		t.Errorf("an unreadable desktop name must say so, got %q", msg)
	}
}

// Only ERROR_BUSY (the thread already owns windows or hooks) is cured by moving
// to a different OS thread; recycling on access denied would just spin threads.
func TestShouldRecycleCaptureThread(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"busy", setThreadDesktopError("Default", "Winlogon", syscall.Errno(170)), true},
		{"access denied", setThreadDesktopError("Default", "Winlogon", syscall.Errno(5)), false},
		{"no code", setThreadDesktopError("Default", "Winlogon", syscall.Errno(0)), false},
		{"nil", nil, false},
		{"plain", errors.New("x"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldRecycleCaptureThread(tc.err); got != tc.want {
				t.Fatalf("shouldRecycleCaptureThread = %v, want %v", got, tc.want)
			}
		})
	}
}

// The recycle rule must key on the attach failure itself, not on the Win32
// code alone: BitBlt, CreateDC and GdiFlush wrap a syscall.Errno too, and a
// GDI call failing with 170 says nothing about the thread's desktop (#8434
// review).
func TestShouldRecycleCaptureThreadOnlyForTheAttachFailure(t *testing.T) {
	attachBusy := setThreadDesktopError("Default", "Winlogon", syscall.Errno(errBusy))
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"wrapped attach failure", fmt.Errorf("frame: %w", attachBusy), true},
		{"BitBlt with errno 170", gdiCallError("BitBlt", syscall.Errno(errBusy)), false},
		{"GdiFlush with errno 170, wrapped", fmt.Errorf("frame: %w", gdiCallError("GdiFlush", syscall.Errno(errBusy))), false},
		{"bare errno 170", syscall.Errno(errBusy), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldRecycleCaptureThread(tc.err); got != tc.want {
				t.Fatalf("shouldRecycleCaptureThread(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// A persistent ERROR_BUSY must not create and kill an OS thread every 150ms
// for the life of the session, nor log a Warn each time: the delay between
// recycles doubles up to a ceiling, and the Warn is throttled.
func TestCaptureThreadRecyclerBacksOff(t *testing.T) {
	var r captureThreadRecycler
	t0 := time.Unix(1_000_000, 0)

	recycle, logIt := r.decide(t0)
	if !recycle || !logIt {
		t.Fatalf("first recycle = (%v, %v), want (true, true)", recycle, logIt)
	}
	// Inside the first interval: no recycle.
	if recycle, _ := r.decide(t0.Add(captureThreadRecycleMinInterval / 2)); recycle {
		t.Fatal("recycled inside the minimum interval")
	}

	// Drive a persistent failure: try every 10ms for 5 minutes.
	now := t0
	recycles, logs := 1, 1
	for now.Before(t0.Add(5 * time.Minute)) {
		now = now.Add(10 * time.Millisecond)
		if recycle, logIt := r.decide(now); recycle {
			recycles++
			if logIt {
				logs++
			}
		}
	}
	// 150ms doubling to a 30s ceiling: 9 recycles reach the ceiling in ~38s,
	// then one per 30s. A fixed 150ms throttle would have recycled ~2000 times.
	if recycles > 20 {
		t.Fatalf("%d recycles in 5 minutes of persistent ERROR_BUSY; the delay is not backing off", recycles)
	}
	if recycles < 9 {
		t.Fatalf("%d recycles in 5 minutes; the recycler stopped retrying altogether", recycles)
	}
	if logs > 12 {
		t.Fatalf("%d recycle Warns in 5 minutes; the log is not throttled", logs)
	}
	if got := captureThreadRecycleDelay(r.streak); got != captureThreadRecycleMaxInterval {
		t.Fatalf("delay after a long streak = %v, want the %v ceiling", got, captureThreadRecycleMaxInterval)
	}

	// A delivered frame ends the streak: the next failure recycles at once.
	r.reset()
	if recycle, logIt := r.decide(now.Add(time.Millisecond)); !recycle || !logIt {
		t.Fatalf("first recycle after reset = (%v, %v), want (true, true)", recycle, logIt)
	}
}

func TestCaptureThreadRecycleDelay(t *testing.T) {
	for _, tc := range []struct {
		streak int
		want   time.Duration
	}{
		{0, 0},
		{1, captureThreadRecycleMinInterval},
		{2, 2 * captureThreadRecycleMinInterval},
		{3, 4 * captureThreadRecycleMinInterval},
		{100, captureThreadRecycleMaxInterval},
		{1 << 30, captureThreadRecycleMaxInterval},
	} {
		if got := captureThreadRecycleDelay(tc.streak); got != tc.want {
			t.Errorf("captureThreadRecycleDelay(%d) = %v, want %v", tc.streak, got, tc.want)
		}
	}
	// The startup probe retries every 200ms; the first recycle must be ready
	// for its next attempt.
	if captureThreadRecycleMinInterval >= 200*time.Millisecond {
		t.Fatalf("minimum recycle interval %v must be shorter than the probe's 200ms retry", captureThreadRecycleMinInterval)
	}
}

// A frame taken when the capture thread could not confirm it was on the input
// desktop is delivered (capture carries on), but it may be black or show the
// wrong desktop. That must reach CaptureWarning and the log even though the
// frame itself succeeded (#8434 review).
func TestUnverifiedDesktopFramesSurfaceOnSuccess(t *testing.T) {
	var u unverifiedDesktopFrames
	t0 := time.Unix(1_000_000, 0)
	cause := gdiCallError("OpenInputDesktop", syscall.Errno(errAccessDenied))

	if kind, _ := u.frameDelivered(nil, t0); kind != unverifiedFrameNoLog {
		t.Fatalf("a confirmed frame logged %v", kind)
	}
	if err := u.err(); err != nil {
		t.Fatalf("err() after a confirmed frame = %v, want nil", err)
	}

	kind, frames := u.frameDelivered(cause, t0)
	if kind != unverifiedFrameLogWarn || frames != 1 {
		t.Fatalf("first unverified frame = (%v, %d), want (warn, 1)", kind, frames)
	}
	err := u.err()
	if err == nil {
		t.Fatal("err() is nil after an unverified frame; the cause is invisible on success")
	}
	if code, ok := win32ErrorCode(err); !ok || code != errAccessDenied {
		t.Errorf("win32ErrorCode(err()) = %d, %v; want %d", code, ok, errAccessDenied)
	}
	for _, want := range []string{"1 frame", "input desktop", "OpenInputDesktop", "Win32 error 5"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err() = %q, missing %q", err.Error(), want)
		}
	}
	if shouldRecycleCaptureThread(err) {
		t.Error("an unverified-desktop report must never recycle the thread")
	}

	// The same cause within the throttle window is counted, not logged.
	for i := 0; i < 50; i++ {
		if kind, _ := u.frameDelivered(cause, t0.Add(time.Duration(i+1)*100*time.Millisecond)); kind != unverifiedFrameNoLog {
			t.Fatalf("frame %d of the same cause logged %v inside the throttle window", i+2, kind)
		}
	}
	if !strings.Contains(u.err().Error(), "51 frames") {
		t.Errorf("err() = %q, want the running count of 51 frames", u.err())
	}
	// A different cause is always logged.
	other := errors.New("input desktop name is unreadable (GetUserObjectInformationW)")
	if kind, _ := u.frameDelivered(other, t0.Add(6*time.Second)); kind != unverifiedFrameLogWarn {
		t.Fatalf("a changed cause logged %v, want warn", kind)
	}
	// The periodic reminder fires after the throttle window.
	if kind, _ := u.frameDelivered(other, t0.Add(6*time.Second+unverifiedDesktopLogInterval)); kind != unverifiedFrameLogWarn {
		t.Fatalf("no periodic reminder after %v", unverifiedDesktopLogInterval)
	}

	// A confirmed frame ends the streak, reports how long it was, and clears err().
	kind, frames = u.frameDelivered(nil, t0.Add(time.Hour))
	if kind != unverifiedFrameLogRecovered || frames != 53 {
		t.Fatalf("recovery = (%v, %d), want (recovered, 53)", kind, frames)
	}
	if err := u.err(); err != nil {
		t.Fatalf("err() after recovery = %v, want nil", err)
	}
	if kind, _ := u.frameDelivered(nil, t0.Add(time.Hour+time.Second)); kind != unverifiedFrameNoLog {
		t.Fatalf("a second confirmed frame logged %v", kind)
	}
}
