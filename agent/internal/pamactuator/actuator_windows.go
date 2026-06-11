//go:build windows

package pamactuator

import (
	"context"
	"log/slog"
	"runtime"
	"time"
)

// windowsActuator is the Flavor A Track 5 implementation. It opens the
// active input desktop (Winlogon during a UAC prompt), pins the calling
// OS thread to it, then synthesizes keystrokes into consent.exe via
// SendInput. The sequence is: wait for consent.exe to appear → type
// username → Tab → type password → Enter → wait for the window to close.
//
// Why thread-pin: SetThreadDesktop only affects the calling thread, and
// SendInput delivers to the desktop the calling thread is attached to.
// Without LockOSThread the Go scheduler could move us between OS threads
// and the keystrokes would land on whatever desktop the new thread had —
// usually the default winsta0\Default, NOT Winlogon — silently dropping
// them. The same pattern is used by WindowsInputHandler.ensureInputDesktop.
type windowsActuator struct{}

func newActuator() Actuator { return &windowsActuator{} }

// Local copies of the desktop API procs. Duplicated from
// remote/desktop/dxgi_windows.go to keep this package self-contained.
var (
	winProcOpenInputDesktop = winUser32.NewProc("OpenInputDesktop")
	winProcSetThreadDesktop = winUser32.NewProc("SetThreadDesktop")
	winProcCloseDesktop     = winUser32.NewProc("CloseDesktop")
)

const (
	winDesktopGenericAll = 0x10000000
)

// pollInterval is the loop cadence between consent.exe presence checks.
// Short enough that we attach to the prompt within ~100ms of it appearing.
const pollInterval = 100 * time.Millisecond

// settleDelay is how long we wait between SendInput calls so consent.exe
// has time to process each keystroke. Empirically anything below 15ms
// causes occasional dropped characters on slower VMs.
const settleDelay = 25 * time.Millisecond

func (a *windowsActuator) Trigger(ctx context.Context, req Request) Result {
	// SetThreadDesktop is per-thread; the rest of the actuator must stay on
	// the same OS thread or the desktop binding goes with the original
	// goroutine when the scheduler reparks it.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hDesk, _, openErr := winProcOpenInputDesktop.Call(0, 0, uintptr(winDesktopGenericAll))
	if hDesk == 0 {
		slog.Warn("pamactuator: OpenInputDesktop failed",
			"elevationRequestId", req.ElevationRequestID,
			"error", openErr.Error(),
		)
		return Result{
			Success:       false,
			Reason:        "desktop_open_failed",
			DetailMessage: "OpenInputDesktop returned 0: " + openErr.Error(),
		}
	}
	defer winProcCloseDesktop.Call(hDesk)

	if ret, _, setErr := winProcSetThreadDesktop.Call(hDesk); ret == 0 {
		slog.Warn("pamactuator: SetThreadDesktop failed",
			"elevationRequestId", req.ElevationRequestID,
			"error", setErr.Error(),
		)
		return Result{
			Success:       false,
			Reason:        "set_thread_desktop_failed",
			DetailMessage: "SetThreadDesktop returned 0: " + setErr.Error(),
		}
	}

	timeoutMs := req.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = 8000
	}
	deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)

	hwnd := waitForConsent(ctx, deadline)
	if hwnd == 0 {
		return Result{
			Success:       false,
			Reason:        "no_consent_window",
			DetailMessage: "consent.exe did not appear within the timeout window",
		}
	}

	if err := typeString(req.Username); err != nil {
		return Result{
			Success:       false,
			Reason:        "send_input_failed",
			DetailMessage: "typing username: " + err.Error(),
		}
	}
	time.Sleep(settleDelay)

	if err := pressVK(vkTab); err != nil {
		return Result{
			Success:       false,
			Reason:        "send_input_failed",
			DetailMessage: "Tab: " + err.Error(),
		}
	}
	time.Sleep(settleDelay)

	if err := typeString(req.Password); err != nil {
		return Result{
			Success:       false,
			Reason:        "send_input_failed",
			DetailMessage: "typing password: " + err.Error(),
		}
	}
	time.Sleep(settleDelay)

	if err := pressVK(vkReturn); err != nil {
		return Result{
			Success:       false,
			Reason:        "send_input_failed",
			DetailMessage: "Enter: " + err.Error(),
		}
	}

	if !waitForConsentClose(ctx, hwnd, deadline) {
		return Result{
			Success:       false,
			Reason:        "consent_did_not_close",
			DetailMessage: "consent.exe still present after credential submit",
		}
	}

	return Result{
		Success:       true,
		Reason:        "ok",
		DetailMessage: "consent.exe closed after credential submission",
	}
}

// waitForConsent polls for the consent.exe window until it appears, the
// context cancels, or the deadline passes. Returns 0 on timeout/cancel.
func waitForConsent(ctx context.Context, deadline time.Time) uintptr {
	for {
		if hwnd := findConsentWindow(); hwnd != 0 {
			return hwnd
		}
		if time.Now().After(deadline) {
			return 0
		}
		select {
		case <-ctx.Done():
			return 0
		case <-time.After(pollInterval):
		}
	}
}

// waitForConsentClose polls until the originally-seen consent.exe HWND is
// gone (the window destroyed) or the deadline passes. True = closed.
func waitForConsentClose(ctx context.Context, hwnd uintptr, deadline time.Time) bool {
	for {
		if !isWindowAlive(hwnd) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(pollInterval):
		}
	}
}

// typeString iterates the rune sequence and types each via
// KEYEVENTF_UNICODE. Returns the first error encountered.
func typeString(s string) error {
	for _, r := range s {
		if err := typeRune(r); err != nil {
			return err
		}
	}
	return nil
}

