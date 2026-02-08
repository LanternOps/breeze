package sessionbroker

import "errors"

var (
	ErrCommandTimeout      = errors.New("sessionbroker: command timed out")
	ErrNoHelperForUser     = errors.New("sessionbroker: no user helper connected for user")
	ErrBrokerClosed        = errors.New("sessionbroker: broker is closed")
	ErrMaxConnections      = errors.New("sessionbroker: max connections per UID exceeded")
	ErrRateLimited         = errors.New("sessionbroker: connection rate limited")
	ErrAuthFailed          = errors.New("sessionbroker: authentication failed")
	ErrHandshakeTimeout    = errors.New("sessionbroker: handshake timeout")
	ErrInvalidBinary       = errors.New("sessionbroker: binary path verification failed")
	ErrBinaryHashMismatch  = errors.New("sessionbroker: binary hash mismatch")
)
