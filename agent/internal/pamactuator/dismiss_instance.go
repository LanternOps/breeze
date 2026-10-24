package pamactuator

import (
	"context"
	"errors"
	"strings"
	"time"
)

// Reason codes specific to the targeted dismissal (#8995). Each one means
// "nothing was pressed" except consent_did_not_close / send_input_failed,
// which DismissInstance shares with Dismiss.
const (
	// ReasonInvalidConsentInstance: the request did not carry both a PID and a
	// creation time, so there is nothing to target.
	ReasonInvalidConsentInstance = "invalid_consent_instance"
	// ReasonConsentIdentityUnverified: the PID could not be opened or checked
	// (access denied, wrong session, ...). The instance may still be live.
	ReasonConsentIdentityUnverified = "consent_identity_unverified"
	// ReasonConsentWindowNotFound: the consent.exe instance is alive but none of
	// its prompt windows were found on the input desktop before the deadline.
	// NOT proof the prompt is gone.
	ReasonConsentWindowNotFound = "consent_window_not_found"
	// ReasonConsentNotForeground: the target prompt is not the foreground
	// window and could not be raised, so Escape would reach some other window.
	ReasonConsentNotForeground = "consent_not_foreground"
)

// ConsentInstance identifies one consent.exe process: PID plus creation time,
// so a PID that Windows has since reused never matches.
type ConsentInstance struct {
	PID       uint32
	CreatedAt time.Time
}

func (c ConsentInstance) valid() bool { return c.PID != 0 && !c.CreatedAt.IsZero() }

// InstanceDismisser cancels one specific consent.exe prompt and leaves every
// other UAC prompt alone. It is a separate interface from Actuator so existing
// Actuator fakes stay valid; every platform actuator implements it.
//
// Result codes: "ok" on a confirmed close; ReasonNoConsentWindow when the
// instance has already exited (or its PID now belongs to another process);
// otherwise one of the Reason* codes above or Dismiss's desktop/input failure
// codes. Only "ok" and ReasonNoConsentWindow mean the target is gone.
type InstanceDismisser interface {
	DismissInstance(ctx context.Context, inst ConsentInstance) Result
}

// stillActiveExitCode is Windows' STILL_ACTIVE (259) from GetExitCodeProcess.
const stillActiveExitCode = uint32(259)

var (
	errConsentInstanceWrongSession = errors.New("consent.exe instance is in a different Windows session than this helper")
	errConsentInstanceWrongImage   = errors.New("process is not consent.exe")
)

// consentProcessFacts is what the platform layer read about the process that
// currently holds the target PID.
type consentProcessFacts struct {
	CreatedAt     time.Time
	ExitCode      uint32
	ImagePath     string
	Session       uint32
	HelperSession uint32
}

// consentProcessMatches decides whether the process now holding inst.PID is
// still the recorded consent.exe. (false, nil) = positively gone (exited, or
// the PID was reused by a process created at another instant); an error = it
// is something we must not touch and cannot call gone (wrong image, another
// user's session).
func consentProcessMatches(inst ConsentInstance, facts consentProcessFacts) (bool, error) {
	if !facts.CreatedAt.Equal(inst.CreatedAt) {
		return false, nil
	}
	if facts.ExitCode != stillActiveExitCode {
		return false, nil
	}
	base := facts.ImagePath
	if i := strings.LastIndexAny(base, `\/`); i >= 0 {
		base = base[i+1:]
	}
	if !strings.EqualFold(base, "consent.exe") {
		return false, errConsentInstanceWrongImage
	}
	if facts.Session != facts.HelperSession {
		return false, errConsentInstanceWrongSession
	}
	return true, nil
}

// consentInstanceOps are the Win32 primitives the targeted dismissal needs.
// Abstracted so the guard ordering — verify identity, find the target's own
// window, require it to be foreground, only then press — is unit-testable on
// every platform.
type consentInstanceOps interface {
	// InstanceLive reports whether the exact process (PID + creation time) is
	// still a running consent.exe in this helper's session. (false, nil) means
	// positively gone; an error means it could not be determined.
	InstanceLive(ConsentInstance) (bool, error)
	// FindInstanceWindow returns a top-level consent prompt window owned by pid
	// on the calling thread's desktop, or 0.
	FindInstanceWindow(pid uint32) uintptr
	// ForegroundOwnedBy reports whether the current foreground window belongs
	// to pid.
	ForegroundOwnedBy(pid uint32) bool
	// BringToForeground asks Windows to make hwnd the foreground window. It may
	// be refused; callers re-check ForegroundOwnedBy.
	BringToForeground(hwnd uintptr)
	PressEscape() error
	WindowAlive(hwnd uintptr) bool
}

// dismissConsentInstance cancels exactly the given consent.exe prompt.
//
// SendInput delivers Escape to whatever window has keyboard focus, so a
// targeted dismissal is only safe when the foreground window belongs to the
// target process. With several stacked prompts (Windows Server with
// PromptOnSecureDesktop off draws them on the normal desktop) the foreground
// may be another request's prompt: in that case we try once to raise the
// target and, if that is refused, press nothing.
func dismissConsentInstance(ctx context.Context, ops consentInstanceOps, inst ConsentInstance, deadline time.Time, poll time.Duration) Result {
	if result, cancelled := dismissCancellationResult(ctx); cancelled {
		return result
	}
	if !inst.valid() {
		return Result{Success: false, Reason: ReasonInvalidConsentInstance,
			DetailMessage: "targeted consent dismissal needs a PID and a creation time"}
	}

	instanceGone := func() (Result, bool) {
		live, err := ops.InstanceLive(inst)
		if err != nil {
			return Result{Success: false, Reason: ReasonConsentIdentityUnverified,
				DetailMessage: "could not verify the consent.exe instance: " + err.Error()}, true
		}
		if !live {
			return Result{Success: false, Reason: ReasonNoConsentWindow,
				DetailMessage: "the targeted consent.exe instance has already exited"}, true
		}
		return Result{}, false
	}

	if res, stop := instanceGone(); stop {
		return res
	}

	var hwnd uintptr
	for {
		if hwnd = ops.FindInstanceWindow(inst.PID); hwnd != 0 {
			break
		}
		if res, stop := instanceGone(); stop {
			return res
		}
		if time.Now().After(deadline) {
			return Result{Success: false, Reason: ReasonConsentWindowNotFound,
				DetailMessage: "the targeted consent.exe is running but its prompt window was not found on the input desktop"}
		}
		select {
		case <-ctx.Done():
			result, _ := dismissCancellationResult(ctx)
			return result
		case <-time.After(poll):
		}
	}

	if !ops.ForegroundOwnedBy(inst.PID) {
		ops.BringToForeground(hwnd)
		if !ops.ForegroundOwnedBy(inst.PID) {
			return Result{Success: false, Reason: ReasonConsentNotForeground,
				DetailMessage: "the targeted consent prompt is not the foreground window; Escape not sent"}
		}
	}

	// Keep the cancellation check immediately next to the keystroke, as Dismiss
	// does: the broker's input window may have closed while we searched.
	if result, cancelled := dismissCancellationResult(ctx); cancelled {
		return result
	}
	if err := ops.PressEscape(); err != nil {
		return Result{Success: false, Reason: "send_input_failed", DetailMessage: "Escape: " + err.Error()}
	}

	var lastLiveErr error
	for {
		if !ops.WindowAlive(hwnd) {
			return Result{Success: true, Reason: "ok", DetailMessage: "targeted consent.exe prompt closed after Escape"}
		}
		// Process exit is a second way to see the prompt close. A liveness
		// error is not fatal here (Escape is already sent and the window
		// check still bounds the loop), but it is kept for the diagnosis.
		live, err := ops.InstanceLive(inst)
		if err == nil && !live {
			return Result{Success: true, Reason: "ok", DetailMessage: "targeted consent.exe exited after Escape"}
		}
		if err != nil {
			lastLiveErr = err
		}
		if time.Now().After(deadline) {
			detail := "targeted consent.exe still present after Escape"
			if lastLiveErr != nil {
				detail += " (process liveness could not be verified: " + lastLiveErr.Error() + ")"
			}
			return Result{Success: false, Reason: "consent_did_not_close", DetailMessage: detail}
		}
		select {
		case <-ctx.Done():
			result, _ := dismissPostInputCancellationResult(ctx)
			return result
		case <-time.After(poll):
		}
	}
}
