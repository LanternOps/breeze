// Package pamactuator carries out approved UAC elevations on Windows by
// typing the dormant-admin credentials into the consent.exe prompt that
// triggered the elevation request.
//
// Background: PAM Track 5 — UAC elevation actuator.
//
// On Windows, when a non-elevated process invokes an admin operation, the
// OS raises consent.exe on the secure desktop. Without a logged-in admin
// account, the only ways to satisfy that prompt are to (a) silently inject
// SYSTEM-side approval via a kernel hook or (b) type real credentials into
// the consent UI as if a user did. Discussion #858 (Todd-Q4, 2026-05-23)
// settled on (b) — Flavor A — because it leaves the existing audit trail
// (event log 4624, consent.exe pid) intact and does not require kernel
// drivers we cannot ship through stock MSI installers.
//
// File layout:
//
//	actuator.go            — cross-platform interface + types
//	actuator_windows.go    — Flavor A: SetThreadDesktop(Winlogon) +
//	                         FindWindow(consent.exe) + SendInput
//	actuator_other.go      — no-op stub for !windows builds
//	wininput.go            — local KEYEVENTF_UNICODE typeString primitive
//	                         (intentionally duplicated from
//	                         remote/desktop/input_windows.go per Q5;
//	                         actuator must work without pulling in the
//	                         whole WebRTC capture stack)
//
// Threat model: the actuator runs as SYSTEM (the agent service identity),
// types the secret on the input desktop, and never persists it. The
// caller (the agent-side elevation-account manager) is responsible for
// generating the credential just-in-time and revoking it after use.
//
// Server contract: the actuator is triggered by a `actuate_elevation`
// device_command whose payload carries only a go signal. The heartbeat
// handler mints the credential locally before calling this package. See
// heartbeat/handlers_actuate.go.
package pamactuator

import "context"

const dismissCancelledReason = "dismiss_cancelled"

// Request is the input to Actuator.Trigger. Carries everything needed to
// drive a single consent.exe prompt to completion. Username + password are
// the cleartext dormant-admin credentials to type — they live in process
// memory only for the duration of Trigger and are not logged.
type Request struct {
	// ElevationRequestID is the server-side elevation_requests.id this
	// actuation is fulfilling. Used solely for log correlation.
	ElevationRequestID string

	// Username is the dormant-admin account name to type into the
	// consent.exe username field.
	Username string

	// Password is the cleartext credential to type into the password
	// field. Cleared by the actuator after use.
	Password string

	// TimeoutMs bounds how long the actuator will wait for consent.exe
	// to appear on the secure desktop. Server defaults to 8000.
	TimeoutMs int

	// TargetPath is the absolute path of the executable to launch elevated.
	// Used only by the token_launch strategy (Path B); the sendinput strategy
	// ignores it (it injects into an already-pending consent.exe).
	TargetPath string

	// CommandLine is the full command line for the elevated launch (Path B).
	// Ignored by the sendinput strategy.
	CommandLine string

	// SubjectSessionID is the interactive session id that raised the elevation,
	// when known. Reserved seam for a future ETW change that surfaces the
	// requesting session directly — currently always 0 (unset), because the ETW
	// 15028 event's writing process is the session-0 AppInfo service, so its
	// header session id is not the interactive one. When 0 the resolver falls
	// back to SubjectUsername. token_launch only.
	SubjectSessionID uint32

	// SubjectUsername is the account that requested the elevation — from the
	// server-echoed elevation_requests.subject_username (remote path) or from
	// ETW discovery (local path). The token_launch resolver maps it to that
	// user's live interactive session so the elevated process lands in front of
	// the requester (not the physical console) on RDP/multi-session hosts. NOT a
	// credential; used only to choose a local session. Ignored by sendinput.
	SubjectUsername string
}

// ReasonNoConsentWindow is returned when the helper looked at the consent
// desktop and found no UAC prompt at all.
//
// This string is load-bearing beyond logging: the PAM fail-closed gate treats
// it as PROOF that no denied prompt can still be on screen (see
// sessionbroker.PamDismissOutcome.Cleared). Renaming the literal without
// updating that check fails closed into a permanent PAM lockout, so producers
// and consumers both reference this constant rather than repeating the string.
const ReasonNoConsentWindow = "no_consent_window"

// Result reports what the actuator did. Returned to the server so the
// approval flow can mark the elevation_requests row as satisfied or
// retry/escalate (Q4: log + audit row + return server response).
type Result struct {
	// Success is true if the actuator typed credentials and consent.exe
	// closed within the timeout window. False on any earlier failure.
	Success bool

	// Reason is a short stable code suitable for switch statements on
	// the server side. One of: "ok", "no_consent_window", "desktop_open_failed",
	// "set_thread_desktop_failed", "send_input_failed", "consent_did_not_close",
	// "unsupported_platform", "dismiss_cancelled". Dismiss returns from this
	// same code set (it shares Trigger's desktop-attach / input /
	// close-verification failure reasons).
	//
	// The above codes are the sendinput (Path A) strategy's set. The
	// token_launch (Path B) strategy — tokenLaunchActuator, in
	// tokenlaunch_windows.go — contributes its own additional codes:
	// "empty_target", "session_lookup_failed", "logon_failed",
	// "set_session_failed", "desktop_grant_failed", "create_process_failed".
	// See tokenlaunch_windows.go for the full reason-code contract.
	Reason string

	// DetailMessage is a free-form human-readable string for logs. Never
	// contains the password.
	DetailMessage string
}

// Actuator is the cross-platform interface for triggering UAC elevations.
// On Windows, the concrete impl is *windowsActuator (actuator_windows.go).
// On every other platform it is *noopActuator (actuator_other.go).
type Actuator interface {
	// Trigger executes one actuation. Blocks until consent.exe closes or
	// the timeout expires, whichever comes first. Safe to call from any
	// goroutine; the impl locks an OS thread internally before touching
	// the secure desktop.
	Trigger(ctx context.Context, req Request) Result

	// Dismiss cancels the live consent.exe prompt by sending Escape on the
	// input desktop (deny path). Returns Reason "ok" on a confirmed close,
	// "no_consent_window" if none was found, or one of Trigger's failure
	// reasons for desktop-attach / input / close-verification failures
	// ("desktop_open_failed", "set_thread_desktop_failed", "send_input_failed",
	// "consent_did_not_close", "unsupported_platform", "dismiss_cancelled").
	Dismiss(ctx context.Context) Result
}

// dismissCancellationResult gives every platform implementation the same
// stable result when the caller's input-injection window has closed.
func dismissCancellationResult(ctx context.Context) (Result, bool) {
	if err := ctx.Err(); err != nil {
		return Result{
			Success:       false,
			Reason:        dismissCancelledReason,
			DetailMessage: "PAM consent dismissal cancelled before input: " + err.Error(),
		}, true
	}
	return Result{}, false
}

func dismissPostInputCancellationResult(ctx context.Context) (Result, bool) {
	if err := ctx.Err(); err != nil {
		return Result{
			Success:       false,
			Reason:        dismissCancelledReason,
			DetailMessage: "PAM consent dismissal cancelled after Escape while waiting for consent.exe to close: " + err.Error(),
		}, true
	}
	return Result{}, false
}

// New returns the platform-default Actuator. On non-Windows this returns
// a no-op that always reports Reason="unsupported_platform".
func New() Actuator {
	return newActuator()
}

// Strategy selects the concrete Windows actuator implementation.
type Strategy string

const (
	// StrategySendInput is Path A: inject dormant-admin credentials into the
	// live consent.exe prompt via SendInput on the secure desktop.
	StrategySendInput Strategy = "sendinput"
	// StrategyTokenLaunch is Path B: suppress consent.exe and launch the target
	// elevated via LogonUser(~breeze_elev) → CreateProcessAsUser.
	StrategyTokenLaunch Strategy = "token_launch"
)

// NewWithStrategy returns the Windows actuator for the given strategy. An
// unrecognized strategy falls back to the platform default (sendinput on
// Windows, no-op elsewhere). On non-Windows this always returns the no-op.
func NewWithStrategy(s Strategy) Actuator {
	return newActuatorForStrategy(s)
}
