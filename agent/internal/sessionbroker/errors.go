package sessionbroker

import "errors"

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

// PamDismissUncertainError means a dismiss command may still be executing in
// the target helper session. Quiesced closes only after the authenticated,
// correlated helper response proves the command has finished. Callers that
// serialize PAM input must remain fail-closed while it is open.
type PamDismissUncertainError struct {
	Cause    error
	Quiesced <-chan struct{}
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
