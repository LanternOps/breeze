package bmr

import "fmt"

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
