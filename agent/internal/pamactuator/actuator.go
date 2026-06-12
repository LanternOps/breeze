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
}

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
	// "unsupported_platform".
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
}

// New returns the platform-default Actuator. On non-Windows this returns
// a no-op that always reports Reason="unsupported_platform".
func New() Actuator {
	return newActuator()
}
