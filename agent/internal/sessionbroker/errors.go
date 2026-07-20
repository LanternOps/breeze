package sessionbroker

import (
	"errors"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamactuator"
)

var (
	ErrCommandTimeout     = errors.New("sessionbroker: command timed out")
	ErrNoHelperForUser    = errors.New("sessionbroker: no user helper connected for user")
	ErrBrokerClosed       = errors.New("sessionbroker: broker is closed")
	ErrMaxConnections     = errors.New("sessionbroker: max connections per UID exceeded")
	ErrRateLimited        = errors.New("sessionbroker: connection rate limited")
	ErrAuthFailed         = errors.New("sessionbroker: authentication failed")
	ErrHandshakeTimeout   = errors.New("sessionbroker: handshake timeout")
	ErrInvalidBinary      = errors.New("sessionbroker: binary path verification failed")
	ErrBinaryHashMismatch = errors.New("sessionbroker: binary hash mismatch")
)

// PamDismissOutcome reports how an uncertain PAM consent dismissal ended.
//
// Proven is true only when the authenticated, correlated helper response
// arrived, which proves the helper's dismissal work has finished. It does NOT
// mean the consent prompt actually closed — read Result for that. Proven is
// false when the helper session died first: the helper goroutine may still be
// live, so the caller must stay fail-closed and re-establish proof rather than
// assume the prompt is gone (issue #2610).
type PamDismissOutcome struct {
	Proven bool
	Result ipc.PamDismissConsentResult
	// Err is set when a correlated response arrived but could not be
	// interpreted (helper-reported error or an undecodable payload). Proven is
	// still true — the helper finished — but the prompt's fate is unknown, so
	// this must be treated exactly as harshly as a reported failure.
	Err error
}

// Cleared reports whether the outcome proves no denied consent prompt can still
// be on screen. This is the ONLY condition that may reopen PAM actuation.
//
// ReasonNoConsentWindow counts: the helper looked and found no prompt at all,
// so there is nothing for a later actuation to type credentials into.
func (o PamDismissOutcome) Cleared() bool {
	if !o.Proven || o.Err != nil {
		return false
	}
	return o.Result.Success || o.Result.Reason == pamactuator.ReasonNoConsentWindow
}

// PamDismissUncertainError means a dismiss command may still be executing in
// the target helper session.
//
// Quiesced yields at most one outcome and is then closed. Gate on
// outcome.Cleared() — NOT on the mere fact that the channel produced something.
// A proven-failed dismissal and a dead helper both deliver an outcome here, and
// neither is safe to actuate after.
//
// IMPORTANT: "at most one". The outcome is produced when a correlated response
// arrives or the session tears down, so a helper that hangs while its session
// stays CONNECTED — precisely what raises the ErrCommandTimeout that creates
// this error — may never produce one at all. Readers MUST bound the receive
// (and must not assume a nil channel is impossible); blocking on it forever is
// how the fail-closed gate turns into a permanent lockout.
type PamDismissUncertainError struct {
	Cause    error
	Quiesced <-chan PamDismissOutcome
}

func (e *PamDismissUncertainError) Error() string {
	if e == nil || e.Cause == nil {
		return "sessionbroker: PAM consent dismissal completion uncertain"
	}
	return "sessionbroker: PAM consent dismissal completion uncertain: " + e.Cause.Error()
}

func (e *PamDismissUncertainError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}
