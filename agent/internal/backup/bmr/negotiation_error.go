package bmr

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// RecoveryNegotiationError is the typed form of a 409 returned by
// /bmr/recover/authenticate or /bmr/recover/exchange for the capability
// negotiation codes in Part 0 §1 (client_capability_required,
// capability_downgrade, snapshot_storage_identity_unknown,
// storage_identity_drift, snapshot_index_pending, snapshot_index_failed).
// The recovery console (agent/internal/recoveryconsole) errors.As against
// this type to classify a 409 rather than matching error text.
type RecoveryNegotiationError struct {
	Code              string
	Message           string
	RetryAfterSeconds int
}

func (e *RecoveryNegotiationError) Error() string {
	return fmt.Sprintf("bmr: %s: %s", e.Code, e.Message)
}

// maxNegotiationErrorMessageLen bounds the fallback message built from a
// raw, non-JSON 409 body (review finding #4) — an upstream proxy error
// page could otherwise be arbitrarily large.
const maxNegotiationErrorMessageLen = 500

// parseRecoveryNegotiationError decodes a 409 response body from
// /bmr/recover/authenticate or /bmr/recover/exchange into a
// *RecoveryNegotiationError. Both routes previously degraded to a generic,
// untyped error whenever the body was not JSON or was JSON but carried no
// non-empty "error" field (e.g. an intermediary proxy's own error page) —
// a caller classifying the failure via errors.As(&RecoveryNegotiationError)
// (the recovery console, download_session.go's terminal-refusal switch)
// never recognized it as a negotiation refusal, so a genuinely-terminal
// 409 still burned retry attempts. This always returns a
// *RecoveryNegotiationError for a 409, falling back to Code "unknown" with
// the raw body (or the status text, if the body is empty) as the message
// rather than guessing at a more specific code.
func parseRecoveryNegotiationError(status int, data []byte) *RecoveryNegotiationError {
	var body struct {
		Error             string `json:"error"`
		Message           string `json:"message"`
		RetryAfterSeconds int    `json:"retryAfterSeconds"`
	}
	if json.Unmarshal(data, &body) == nil && body.Error != "" {
		return &RecoveryNegotiationError{Code: body.Error, Message: body.Message, RetryAfterSeconds: body.RetryAfterSeconds}
	}
	msg := strings.TrimSpace(string(data))
	if msg == "" {
		msg = http.StatusText(status)
	}
	if len(msg) > maxNegotiationErrorMessageLen {
		msg = msg[:maxNegotiationErrorMessageLen]
	}
	return &RecoveryNegotiationError{Code: "unknown", Message: msg}
}
